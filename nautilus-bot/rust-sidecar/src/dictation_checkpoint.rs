//! The post-stop dictation checkpoint.
//!
//! At stop, before recognition starts, the audio of the dictation being
//! finished is written to one app-private file. The file is deleted as soon as
//! the session's outcome is recorded, whichever way the stop path ends:
//! inserted, copied, refused, failed or cancelled. Only a process that exits
//! between stop and that point (a crash, a forced quit, a power cut after the
//! write) leaves it behind, and the next launch offers it as "Recover last
//! dictation": the audio is transcribed again and shown with Copy and Discard.
//! Nothing is ever pasted from it automatically.
//!
//! Meeting asides also checkpoint their own mono capture before stop. This
//! includes paused meetings and a dictation microphone different from the
//! meeting microphone. Standalone capture is still memory-only until stop.
//!
//! Layout, under the app's data folder (`Plainsong/dictation-checkpoint`, mode
//! 0700, outside `recordings`, so backups and support bundles never see it):
//!
//! - `in-flight.<stage>.wav`: the dictation this process is finishing. The
//!   stage in the name moves `stopped` -> `recognized` -> `delivering` with a
//!   rename, so a leftover says how far the session got.
//! - `recover.<stage>.wav`: a leftover from an earlier process, renamed at
//!   startup so it can never be confused with the session now running.
//!
//! The in-flight name holds one entry. Recoverable files also carry a unique
//! suffix, so another failure cannot replace unrecovered audio. Files are mode
//! 0600 and any older than 24 hours are deleted.

use crate::recording_audio;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How long an unrecovered checkpoint is kept before it is deleted unseen.
pub(crate) const DICTATION_CHECKPOINT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

const CHECKPOINT_DIRECTORY: &str = "dictation-checkpoint";
const IN_FLIGHT_PREFIX: &str = "in-flight.";
const RECOVER_PREFIX: &str = "recover.";
const CHECKPOINT_EXTENSION: &str = ".wav";
const TEMPORARY_PREFIX: &str = ".checkpoint-";

/// How far the session had got when the checkpoint was last updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DictationCheckpointStage {
    /// Audio captured and stopped; recognition had not finished.
    Stopped,
    /// The words were recognized; nothing had been delivered.
    Recognized,
    /// A delivery (paste, insert or clipboard copy) had been attempted, so the
    /// words may already be in the target app.
    Delivering,
}

impl DictationCheckpointStage {
    const ALL: [Self; 3] = [Self::Stopped, Self::Recognized, Self::Delivering];

    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Recognized => "recognized",
            Self::Delivering => "delivering",
        }
    }

    fn file_name(self, prefix: &str) -> String {
        format!("{prefix}{}{CHECKPOINT_EXTENSION}", self.as_str())
    }

    fn from_file_name(name: &str, prefix: &str) -> Option<Self> {
        let stage = name
            .strip_prefix(prefix)?
            .strip_suffix(CHECKPOINT_EXTENSION)?;
        let stage = if prefix == RECOVER_PREFIX {
            stage.split('.').next()?
        } else {
            stage
        };
        Self::ALL.into_iter().find(|value| value.as_str() == stage)
    }
}

/// The checkpoint directory under the app's data folder.
pub(crate) fn dictation_checkpoint_directory() -> Result<PathBuf, String> {
    crate::paths::data_dir()
        .map(|dir| dir.join("Plainsong").join(CHECKPOINT_DIRECTORY))
        .ok_or_else(|| "Could not find the data directory".to_string())
}

pub(crate) fn ensure_private_directory(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|error| {
                format!("Could not prepare the dictation checkpoint folder: {error}")
            })?;
        let metadata = std::fs::symlink_metadata(dir).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("The dictation checkpoint folder is not a folder.".to_string());
        }
        if metadata.permissions().mode() & 0o777 != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("Could not prepare the dictation checkpoint folder: {error}"))
    }
}

fn remove_quietly(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!("Could not remove a dictation checkpoint file: {}", error),
    }
}

/// Every checkpoint file of one kind (`prefix`) in `dir`, with its stage.
fn checkpoint_files(dir: &Path, prefix: &str) -> Vec<(PathBuf, DictationCheckpointStage)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let stage = DictationCheckpointStage::from_file_name(name.to_str()?, prefix)?;
            Some((entry.path(), stage))
        })
        .collect()
}

/// Incremental aside audio, independent of the meeting track and History.
/// Capture workers write and flush each accepted block; realtime callbacks
/// never touch the filesystem. A process exit leaves a readable WAV even
/// without running destructors. Explicit completion or cancellation removes it.
pub(crate) struct CaptureCheckpoint {
    path: PathBuf,
    session_id: u64,
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
}

impl CaptureCheckpoint {
    pub(crate) fn begin(dir: &Path, session_id: u64, rate: u32) -> Result<Self, String> {
        ensure_private_directory(dir)?;
        let path = dir.join(format!("capture.{}.wav", uuid::Uuid::new_v4()));
        let file = recording_audio::create_new_file(&path).map_err(|e| e.to_string())?;
        let writer = hound::WavWriter::new(
            std::io::BufWriter::new(file),
            hound::WavSpec {
                channels: 1,
                sample_rate: rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            path,
            session_id,
            writer,
        })
    }

    pub(crate) fn append(&mut self, samples: &[f32]) -> Result<(), String> {
        for sample in samples {
            self.writer
                .write_sample(*sample)
                .map_err(|e| e.to_string())?;
        }
        self.writer.flush().map_err(|e| e.to_string())
    }

    pub(crate) fn discard(self, session_id: u64) -> Option<Self> {
        if self.session_id != session_id {
            return Some(self);
        }
        let path = self.path.clone();
        drop(self);
        remove_quietly(&path);
        None
    }
}

/// A finishing session removes its capture file on every recorded outcome,
/// including when writing the post-stop checkpoint failed. A crash or panic
/// leaves it for startup. Explicit cancellation can also remove it sooner.
pub(crate) struct CaptureCheckpointCompletion {
    capture: std::sync::Arc<std::sync::Mutex<Option<CaptureCheckpoint>>>,
    session_id: u64,
}

impl CaptureCheckpointCompletion {
    pub(crate) fn new(
        capture: std::sync::Arc<std::sync::Mutex<Option<CaptureCheckpoint>>>,
        session_id: u64,
    ) -> Self {
        Self {
            capture,
            session_id,
        }
    }
}

impl Drop for CaptureCheckpointCompletion {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let mut slot = self.capture.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(checkpoint) = slot.take() {
            *slot = checkpoint.discard(self.session_id);
        }
    }
}

fn promote_capture_checkpoints(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix("capture."))
            .and_then(|name| name.strip_suffix(".wav"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let path = entry.path();
        let modified = std::fs::symlink_metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok());
        let Some(modified) = modified.filter(|modified| !is_expired(*modified, now)) else {
            remove_quietly(&path);
            continue;
        };
        // A kill can interrupt the header update after complete samples have
        // reached the file. Repair only whole frames and retain its original age.
        let repaired = recording_audio::repair_plaintext_wav_header(&path).and_then(|_| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_times(std::fs::FileTimes::new().set_modified(modified))?;
            Ok(())
        });
        if let Err(error) = repaired {
            tracing::warn!("Could not repair aside capture for recovery: {error}");
            continue;
        }
        let valid = hound::WavReader::open(&path).is_ok_and(|reader| reader.duration() > 0);
        if valid {
            let target = dir.join(format!("recover.stopped.{id}.wav"));
            if let Err(error) = std::fs::rename(&path, target) {
                tracing::warn!("Could not keep aside capture for recovery: {error}");
            }
        } else {
            remove_quietly(&path);
        }
    }
}

/// The audio of the dictation this process is finishing, on disk until its
/// outcome is recorded. Dropping it deletes the file, so every way out of the
/// stop path (done, failed, cancelled, lost ownership) removes it; only a
/// process that dies first leaves it behind.
#[derive(Debug)]
pub(crate) struct DictationCheckpoint {
    dir: PathBuf,
    stage: DictationCheckpointStage,
    resolved: bool,
}

impl DictationCheckpoint {
    /// Write `audio` as the in-flight checkpoint, replacing any earlier one.
    pub(crate) fn write(dir: &Path, audio: &[u8]) -> Result<Self, String> {
        ensure_private_directory(dir)?;
        let staged = dir.join(format!(
            "{TEMPORARY_PREFIX}{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let guard = recording_audio::write_secure_temporary_audio(&staged, audio)
            .map_err(|error| format!("Could not write the dictation checkpoint: {error:#}"))?;
        for (path, _) in checkpoint_files(dir, IN_FLIGHT_PREFIX) {
            remove_quietly(&path);
        }
        let stage = DictationCheckpointStage::Stopped;
        std::fs::rename(guard.path(), dir.join(stage.file_name(IN_FLIGHT_PREFIX)))
            .map_err(|error| format!("Could not publish the dictation checkpoint: {error}"))?;
        guard.disarm();
        Ok(Self {
            dir: dir.to_path_buf(),
            stage,
            resolved: false,
        })
    }

    fn path(&self) -> PathBuf {
        self.dir.join(self.stage.file_name(IN_FLIGHT_PREFIX))
    }

    /// Record that the session reached `stage`. Best effort: a failed rename
    /// leaves the checkpoint at its earlier stage, which only makes the
    /// recovery wording more cautious than it needs to be.
    pub(crate) fn advance(&mut self, stage: DictationCheckpointStage) {
        if self.resolved || stage == self.stage {
            return;
        }
        let from = self.path();
        let to = self.dir.join(stage.file_name(IN_FLIGHT_PREFIX));
        match std::fs::rename(&from, &to) {
            Ok(()) => self.stage = stage,
            Err(error) => tracing::warn!(
                "Could not mark the dictation checkpoint as {}: {}",
                stage.as_str(),
                error
            ),
        }
    }

    /// Offer a failed dictation now, even when History is off. The private
    /// recovery file expires after 24 hours and is never inserted automatically.
    pub(crate) fn keep_for_retry(mut self) -> Result<(), String> {
        let to = self.dir.join(format!(
            "{RECOVER_PREFIX}{}.{}{CHECKPOINT_EXTENSION}",
            self.stage.as_str(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::rename(self.path(), &to)
            .map_err(|error| format!("Could not keep dictation audio for retry: {error}"))?;
        self.resolved = true;
        Ok(())
    }

    pub(crate) fn keep_after_failure(
        self,
        preview_pending: bool,
        error: &str,
    ) -> Result<bool, String> {
        if preview_pending || crate::llm::local_model_load::is_headroom_refusal(error) {
            self.keep_for_retry().map(|()| true)
        } else {
            Ok(false)
        }
    }

    /// The outcome is recorded: delete the audio.
    pub(crate) fn resolve(mut self) {
        self.remove();
    }

    fn remove(&mut self) {
        if !self.resolved {
            self.resolved = true;
            remove_quietly(&self.path());
        }
    }
}

impl Drop for DictationCheckpoint {
    fn drop(&mut self) {
        // A panic is not a recorded outcome: leave the audio for the next
        // launch to offer.
        if !std::thread::panicking() {
            self.remove();
        }
    }
}

/// Write the checkpoint for a session that just stopped. A failure is logged
/// and the dictation carries on: the checkpoint is a safety net, not a gate.
pub(crate) fn begin_dictation_checkpoint(audio: &[u8]) -> Option<DictationCheckpoint> {
    let result =
        dictation_checkpoint_directory().and_then(|dir| DictationCheckpoint::write(&dir, audio));
    match result {
        Ok(checkpoint) => Some(checkpoint),
        Err(error) => {
            tracing::warn!("Dictation checkpoint was not written: {}", error);
            None
        }
    }
}

/// A dictation left by an earlier process, waiting for the user to recover or
/// discard it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingDictationRecovery {
    #[serde(skip)]
    pub(crate) path: PathBuf,
    pub(crate) stage: DictationCheckpointStage,
    /// When the checkpoint was last written, in milliseconds since the epoch.
    pub(crate) saved_at_ms: i64,
    pub(crate) bytes: u64,
}

fn modified_at(path: &Path) -> Option<SystemTime> {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .and_then(|metadata| metadata.modified().ok())
}

fn is_expired(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age > DICTATION_CHECKPOINT_MAX_AGE)
}

/// Startup: an in-flight checkpoint left by the previous process becomes the
/// recoverable one, preserving earlier failures. Half-written stage
/// files are removed, and anything past 24 hours is deleted.
pub(crate) fn promote_leftover_dictation_checkpoint(dir: &Path, now: SystemTime) {
    promote_capture_checkpoints(dir, now);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(TEMPORARY_PREFIX))
        {
            remove_quietly(&entry.path());
        }
    }
    let mut leftovers = checkpoint_files(dir, IN_FLIGHT_PREFIX);
    leftovers.sort_by_key(|(path, _)| modified_at(path));
    if let Some((newest, stage)) = leftovers.pop() {
        for (path, _) in leftovers {
            remove_quietly(&path);
        }
        if modified_at(&newest).is_some_and(|modified| !is_expired(modified, now)) {
            let target = dir.join(format!(
                "{RECOVER_PREFIX}{}.{}{CHECKPOINT_EXTENSION}",
                stage.as_str(),
                uuid::Uuid::new_v4().simple()
            ));
            if let Err(error) = std::fs::rename(&newest, target) {
                tracing::warn!("Could not keep the last dictation for recovery: {}", error);
                remove_quietly(&newest);
            }
        } else {
            remove_quietly(&newest);
        }
    }
    let _ = pending_dictation_recovery(dir, now);
}

/// The dictation waiting for recovery, if one is younger than 24 hours.
/// Expired entries are deleted on the way. The oldest is offered first so
/// another failed dictation cannot change the file being recovered or copied.
pub(crate) fn pending_dictation_recovery(
    dir: &Path,
    now: SystemTime,
) -> Option<PendingDictationRecovery> {
    let mut found: Vec<(PathBuf, DictationCheckpointStage, SystemTime, u64)> =
        checkpoint_files(dir, RECOVER_PREFIX)
            .into_iter()
            .filter_map(|(path, stage)| {
                let metadata = std::fs::symlink_metadata(&path).ok()?;
                if !metadata.is_file() {
                    return None;
                }
                Some((path, stage, metadata.modified().ok()?, metadata.len()))
            })
            .collect();
    found.retain(|(path, _, modified, bytes)| {
        if is_expired(*modified, now) || *bytes == 0 {
            remove_quietly(path);
            false
        } else {
            true
        }
    });
    found.sort_by_key(|(_, _, modified, _)| std::cmp::Reverse(*modified));
    let (path, stage, modified, bytes) = found.pop()?;
    let saved_at_ms = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    Some(PendingDictationRecovery {
        path,
        stage,
        saved_at_ms,
        bytes,
    })
}

/// Delete the in-flight checkpoint: the session was cancelled or discarded,
/// which is an outcome, even if the process ends before the stop path sees it.
pub(crate) fn discard_in_flight_checkpoint(dir: &Path) {
    for (path, _) in checkpoint_files(dir, IN_FLIGHT_PREFIX) {
        remove_quietly(&path);
    }
}

/// Delete the dictation waiting for recovery (after Copy or Discard).
pub(crate) fn discard_dictation_recovery(dir: &Path) {
    if let Some(pending) = pending_dictation_recovery(dir, SystemTime::now()) {
        remove_quietly(&pending.path);
    }
}

/// The words recovered from a leftover checkpoint. Shown with Copy and
/// Discard; never inserted anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveredDictation {
    pub(crate) text: String,
    pub(crate) stage: DictationCheckpointStage,
    pub(crate) saved_at_ms: i64,
}

/// Transcribe the leftover checkpoint again with the current dictation
/// engine. The file stays until the user copies or discards the words, so a
/// failed attempt can be retried.
pub(crate) async fn recover_pending_dictation(
    state: &crate::AppState,
) -> Result<RecoveredDictation, String> {
    let dir = dictation_checkpoint_directory()?;
    let pending = pending_dictation_recovery(&dir, SystemTime::now())
        .ok_or_else(|| "There is no dictation to recover.".to_string())?;
    let audio_bytes = std::fs::read(&pending.path)
        .map_err(|error| format!("Could not read the last dictation's audio: {error}"))?;
    let settings = state.settings_manager.lock().await.settings().clone();
    let (provider_type, model_id) = crate::resolve_transcription_provider_and_model(
        &settings.transcription,
        crate::TranscriptionScope::Dictation,
    );
    crate::enforce_remote_asr_provider_policy(
        provider_type,
        settings.privacy.remote_processing_enabled,
    )?;
    crate::ensure_asr_route_ready(
        state,
        provider_type,
        &model_id,
        "recover the last dictation",
    )
    .await?;
    let dictionary_entries = state
        .db
        .lock()
        .await
        .list_dictation_dictionary_entries()
        .map_err(|error| format!("Failed to read the dictation dictionary: {error}"))?;
    let options = crate::asr::TranscriptionOptions {
        vocabulary_hint: crate::dictation_parity::build_vocabulary_hint(
            &crate::dictation_pipeline::vocabulary_candidates_from_entries(
                &dictionary_entries,
                &[],
            ),
            None,
            crate::text::format::DictationAppCategory::Other,
        ),
        translate_to_english: false,
        apple_speech_required_engine: None,
        request_speaker_labels: false,
        language: settings.transcription.language.clone(),
        acoustic_vocabulary: Vec::new(),
    };
    let _user_waiting = crate::llm::local_model_load::user_waiting_decode();
    let result = state
        .asr_manager
        .transcribe_bytes_for_dictation_with_options(
            provider_type,
            &audio_bytes,
            Some(model_id.as_str()),
            &options,
        )
        .await
        .map_err(|error| {
            format!(
                "Couldn't transcribe the last dictation with {}: {}",
                provider_type.speech_model_name(&model_id),
                error
            )
        })?;
    let text = crate::sanitize_dictation_output(&result.text, &result.text)
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("No speech was found in the last dictation's audio.".to_string());
    }
    Ok(RecoveredDictation {
        text,
        stage: pending.stage,
        saved_at_ms: pending.saved_at_ms,
    })
}

/// Run once by the sidecar at startup, before any dictation can begin. Only
/// the app's own sidecar calls this, so a helper binary started alongside a
/// running app never mistakes that app's in-flight checkpoint for a leftover.
pub fn prepare_dictation_checkpoint_at_startup() {
    if let Ok(dir) = dictation_checkpoint_directory() {
        promote_leftover_dictation_checkpoint(&dir, SystemTime::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fs::TempDir;

    const AUDIO: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt checkpoint fixture bytes";

    fn only_file(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_checkpoint_is_private_and_holds_one_entry() {
        let root = TempDir::new("checkpoint-private");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        let first = DictationCheckpoint::write(&dir, b"first").unwrap();
        std::mem::forget(first);
        let second = DictationCheckpoint::write(&dir, AUDIO).unwrap();
        assert_eq!(only_file(&dir), vec!["in-flight.stopped.wav".to_string()]);
        assert_eq!(std::fs::read(second.path()).unwrap(), AUDIO);
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&second.path()), 0o600);
        }
        drop(second);
    }

    #[test]
    fn a_recorded_outcome_deletes_the_audio() {
        let root = TempDir::new("checkpoint-resolve");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        let mut checkpoint = DictationCheckpoint::write(&dir, AUDIO).unwrap();
        checkpoint.advance(DictationCheckpointStage::Recognized);
        checkpoint.advance(DictationCheckpointStage::Delivering);
        assert_eq!(
            only_file(&dir),
            vec!["in-flight.delivering.wav".to_string()]
        );
        checkpoint.resolve();
        assert!(only_file(&dir).is_empty());

        // Any other way out of the stop path drops it, with the same effect.
        let checkpoint = DictationCheckpoint::write(&dir, AUDIO).unwrap();
        drop(checkpoint);
        assert!(only_file(&dir).is_empty());
    }

    #[test]
    fn headroom_refusal_keeps_audio_without_preview_or_history() {
        let root = TempDir::new("checkpoint-headroom");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        for error in [
            "Not enough verified memory headroom for native inference working buffers alongside other applications.",
            "Native memory admission deferred by memory pressure",
            "Could not verify native memory headroom",
        ] {
            DictationCheckpoint::write(&dir, AUDIO).unwrap().keep_after_failure(false, error).unwrap();
            let pending = pending_dictation_recovery(&dir, SystemTime::now()).expect("retry offered immediately");
            assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);
            #[cfg(unix)]
            assert_eq!(mode(&pending.path), 0o600);
            discard_dictation_recovery(&dir);
        }
        DictationCheckpoint::write(&dir, AUDIO)
            .unwrap()
            .keep_after_failure(false, "cancelled")
            .unwrap();
        assert!(pending_dictation_recovery(&dir, SystemTime::now()).is_none());
    }

    #[test]
    fn failed_dictation_can_be_retried_without_restarting_or_history() {
        let root = TempDir::new("checkpoint-failed-preview");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        DictationCheckpoint::write(&dir, AUDIO)
            .unwrap()
            .keep_for_retry()
            .unwrap();
        let pending = pending_dictation_recovery(&dir, SystemTime::now()).unwrap();
        assert_eq!(pending.stage, DictationCheckpointStage::Stopped);
        assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);
        // A subsequent dictation must not remove the failed one's audio.
        drop(DictationCheckpoint::write(&dir, b"next dictation").unwrap());
        assert!(pending_dictation_recovery(&dir, SystemTime::now()).is_some());
        discard_dictation_recovery(&dir);
        assert!(pending_dictation_recovery(&dir, SystemTime::now()).is_none());
    }

    #[test]
    fn consecutive_failures_and_a_later_crash_keep_every_recovery() {
        let root = TempDir::new("checkpoint-recovery-queue");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        for audio in [AUDIO, b"second failed dictation"] {
            DictationCheckpoint::write(&dir, audio)
                .unwrap()
                .keep_for_retry()
                .unwrap();
        }
        let crash = DictationCheckpoint::write(&dir, b"crashed dictation").unwrap();
        std::mem::forget(crash);
        promote_leftover_dictation_checkpoint(&dir, SystemTime::now());
        assert_eq!(checkpoint_files(&dir, RECOVER_PREFIX).len(), 3);
        let mut recovered = Vec::new();
        while let Some(pending) = pending_dictation_recovery(&dir, SystemTime::now()) {
            recovered.push(std::fs::read(pending.path).unwrap());
            discard_dictation_recovery(&dir);
        }
        assert_eq!(recovered.len(), 3);
        assert!(recovered.contains(&AUDIO.to_vec()));
        assert!(recovered.contains(&b"second failed dictation".to_vec()));
        assert!(recovered.contains(&b"crashed dictation".to_vec()));
    }

    #[test]
    fn a_leftover_is_offered_once_and_never_confused_with_a_live_session() {
        let root = TempDir::new("checkpoint-promote");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        let mut leftover = DictationCheckpoint::write(&dir, AUDIO).unwrap();
        leftover.advance(DictationCheckpointStage::Recognized);
        std::mem::forget(leftover);

        let now = SystemTime::now();
        assert!(pending_dictation_recovery(&dir, now).is_none());
        promote_leftover_dictation_checkpoint(&dir, now);
        let pending = pending_dictation_recovery(&dir, now).expect("offered");
        assert_eq!(pending.stage, DictationCheckpointStage::Recognized);
        assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);

        // A dictation in this process neither replaces nor hides it.
        let live = DictationCheckpoint::write(&dir, b"live").unwrap();
        assert_eq!(
            pending_dictation_recovery(&dir, now).map(|value| value.path),
            Some(pending.path.clone())
        );
        drop(live);
        assert!(pending_dictation_recovery(&dir, now).is_some());

        discard_dictation_recovery(&dir);
        assert!(pending_dictation_recovery(&dir, now).is_none());
        assert!(only_file(&dir).is_empty());
    }

    #[test]
    fn a_checkpoint_older_than_a_day_is_deleted_unseen() {
        let root = TempDir::new("checkpoint-expiry");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        std::mem::forget(DictationCheckpoint::write(&dir, AUDIO).unwrap());
        let later = SystemTime::now() + DICTATION_CHECKPOINT_MAX_AGE + Duration::from_secs(60);
        promote_leftover_dictation_checkpoint(&dir, later);
        assert!(pending_dictation_recovery(&dir, later).is_none());
        assert!(only_file(&dir).is_empty());

        // An entry already waiting expires the same way.
        std::mem::forget(DictationCheckpoint::write(&dir, AUDIO).unwrap());
        let now = SystemTime::now();
        promote_leftover_dictation_checkpoint(&dir, now);
        assert!(pending_dictation_recovery(&dir, now).is_some());
        assert!(pending_dictation_recovery(&dir, later).is_none());
        assert!(only_file(&dir).is_empty());
    }

    #[test]
    fn a_cancelled_session_leaves_nothing_even_if_the_process_ends_first() {
        let root = TempDir::new("checkpoint-cancel");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        let checkpoint = DictationCheckpoint::write(&dir, AUDIO).unwrap();
        discard_in_flight_checkpoint(&dir);
        // The process ends before the stop path drops its handle.
        std::mem::forget(checkpoint);
        promote_leftover_dictation_checkpoint(&dir, SystemTime::now());
        assert!(pending_dictation_recovery(&dir, SystemTime::now()).is_none());
    }

    #[test]
    fn startup_removes_half_written_stage_files() {
        let root = TempDir::new("checkpoint-staged");
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        ensure_private_directory(&dir).unwrap();
        std::fs::write(dir.join(format!("{TEMPORARY_PREFIX}abc.tmp")), b"partial").unwrap();
        promote_leftover_dictation_checkpoint(&dir, SystemTime::now());
        assert!(only_file(&dir).is_empty());
    }

    #[test]
    fn the_checkpoint_lives_outside_recordings_and_support_bundles() {
        let dir = PathBuf::from("/data/Plainsong").join(CHECKPOINT_DIRECTORY);
        assert!(!dir
            .components()
            .any(|part| part.as_os_str() == "recordings"));
        // The support bundle is built from settings, readiness, model, audit
        // and log values only; none of its inputs read this folder.
        let bundle_source = include_str!("support_bundle.rs");
        assert!(!bundle_source.contains(CHECKPOINT_DIRECTORY));
        assert!(!bundle_source.contains("dictation_checkpoint"));
    }

    #[test]
    #[ignore = "subprocess fixture, run by capture_checkpoint_survives_a_killed_writer"]
    fn capture_checkpoint_kill_child() {
        let dir = PathBuf::from(std::env::var_os("PLAINSONG_CAPTURE_KILL_DIR").unwrap());
        let mut checkpoint = CaptureCheckpoint::begin(&dir, 7, 24_000).unwrap();
        checkpoint.append(&[0.125, -0.25, 0.5]).unwrap();
        std::fs::write(dir.join("ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn capture_checkpoint_survives_a_killed_writer() {
        let root = TempDir::new("capture-kill");
        crate::test_fs::kill_test_child_at_checkpoint(
            "dictation_checkpoint::tests::capture_checkpoint_kill_child",
            "PLAINSONG_CAPTURE_KILL_DIR",
            root.path(),
        );
        promote_leftover_dictation_checkpoint(root.path(), SystemTime::now());
        let recovery = pending_dictation_recovery(root.path(), SystemTime::now()).unwrap();
        let mut reader = hound::WavReader::open(&recovery.path).unwrap();
        assert_eq!(reader.spec().sample_rate, 24_000);
        assert_eq!(
            reader
                .samples::<f32>()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            [0.125, -0.25, 0.5]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&recovery.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        promote_leftover_dictation_checkpoint(root.path(), SystemTime::now());
        assert_eq!(checkpoint_files(root.path(), RECOVER_PREFIX).len(), 1);
        assert!(pending_dictation_recovery(
            root.path(),
            SystemTime::now() + DICTATION_CHECKPOINT_MAX_AGE + Duration::from_secs(2)
        )
        .is_none());
    }

    #[test]
    fn capture_recovery_repairs_a_partial_header_without_extending_retention() {
        use std::io::Write;
        let root = TempDir::new("capture-header");
        let mut checkpoint = CaptureCheckpoint::begin(root.path(), 7, 16_000).unwrap();
        checkpoint.append(&[0.125]).unwrap();
        let path = checkpoint.path.clone();
        drop(checkpoint);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(&0.25f32.to_le_bytes()).unwrap();
        file.write_all(&[0, 1]).unwrap(); // An interrupted next sample is excluded.
        let modified = SystemTime::now() - Duration::from_secs(3600);
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        drop(file);
        promote_leftover_dictation_checkpoint(root.path(), SystemTime::now());
        let recovered = pending_dictation_recovery(root.path(), SystemTime::now()).unwrap();
        assert_eq!(
            std::fs::metadata(&recovered.path)
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        let samples = hound::WavReader::open(&recovered.path)
            .unwrap()
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, [0.125, 0.25]);
    }

    #[test]
    fn a_completed_outcome_discards_capture_even_without_a_post_stop_checkpoint() {
        let root = TempDir::new("capture-completed");
        let mut checkpoint = CaptureCheckpoint::begin(root.path(), 7, 16_000).unwrap();
        checkpoint.append(&[0.2; 16]).unwrap();
        let capture = std::sync::Arc::new(std::sync::Mutex::new(Some(checkpoint)));
        drop(CaptureCheckpointCompletion::new(
            std::sync::Arc::clone(&capture),
            6,
        ));
        assert!(capture.lock().unwrap().is_some());
        drop(CaptureCheckpointCompletion::new(capture, 7));
        promote_leftover_dictation_checkpoint(root.path(), SystemTime::now());
        assert!(pending_dictation_recovery(root.path(), SystemTime::now()).is_none());
    }

    #[test]
    fn capture_checkpoint_discard_obeys_session_ownership() {
        let root = TempDir::new("capture-discard");
        let mut checkpoint = CaptureCheckpoint::begin(root.path(), 7, 16_000).unwrap();
        checkpoint.append(&[0.2; 16]).unwrap();
        let checkpoint = checkpoint
            .discard(6)
            .expect("stale completion cannot discard capture");
        assert!(checkpoint.path.exists());
        assert!(checkpoint.discard(7).is_none());
        promote_leftover_dictation_checkpoint(root.path(), SystemTime::now());
        assert!(pending_dictation_recovery(root.path(), SystemTime::now()).is_none());
    }

    // ---- Kill tests -----------------------------------------------------
    //
    // The parent re-runs this test binary as a child that follows the stop
    // path's checkpoint calls up to a named point, then waits to be killed
    // with SIGKILL. The parent then starts "the next launch" against the same
    // folder and checks what is offered.

    const KILL_DIR_ENV: &str = "PLAINSONG_CHECKPOINT_KILL_DIR";
    const KILL_POINT_ENV: &str = "PLAINSONG_CHECKPOINT_KILL_POINT";
    const READY_FILE: &str = "child-ready";

    /// The checkpoint calls `stop_dictation_for_sidecar` makes, in order.
    fn run_stop_path_until(dir: &Path, point: &str) -> Option<DictationCheckpoint> {
        // At stop, before recognition.
        let mut checkpoint = DictationCheckpoint::write(dir, AUDIO).expect("write");
        if point == "stop" {
            return Some(checkpoint);
        }
        // Recognition finished.
        checkpoint.advance(DictationCheckpointStage::Recognized);
        if point == "recognized" {
            return Some(checkpoint);
        }
        // Delivery claimed and attempted.
        checkpoint.advance(DictationCheckpointStage::Delivering);
        if point == "delivery_attempted" {
            return Some(checkpoint);
        }
        // Outcome recorded.
        checkpoint.resolve();
        None
    }

    #[test]
    #[ignore = "child process for the checkpoint kill tests"]
    fn kill_test_child() {
        let (Some(dir), Some(point)) = (
            std::env::var_os(KILL_DIR_ENV),
            std::env::var(KILL_POINT_ENV).ok(),
        ) else {
            return;
        };
        let dir = PathBuf::from(dir);
        let checkpoint = run_stop_path_until(&dir.join(CHECKPOINT_DIRECTORY), &point);
        std::fs::write(dir.join(READY_FILE), point.as_bytes()).expect("ready");
        loop {
            std::thread::sleep(Duration::from_millis(50));
            std::hint::black_box(&checkpoint);
        }
    }

    fn kill_child_at(point: &str) -> TempDir {
        let root = TempDir::new(&format!("checkpoint-kill-{point}"));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "dictation_checkpoint::tests::kill_test_child",
                "--exact",
                "--ignored",
                "--test-threads=1",
            ])
            .env(KILL_DIR_ENV, root.path())
            .env(KILL_POINT_ENV, point)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("start the child");
        let ready = root.path().join(READY_FILE);
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        while !ready.exists() {
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the child never reached {point}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SIGKILL: no destructors, no cleanup, exactly like a crash.
        child.kill().expect("kill the child");
        let status = child.wait().expect("reap the child");
        assert!(!status.success(), "the child was killed, not finished");
        root
    }

    fn next_launch(root: &TempDir) -> Option<PendingDictationRecovery> {
        let dir = root.path().join(CHECKPOINT_DIRECTORY);
        let now = SystemTime::now();
        promote_leftover_dictation_checkpoint(&dir, now);
        pending_dictation_recovery(&dir, now)
    }

    #[test]
    fn killed_at_stop_the_next_launch_offers_the_audio() {
        let root = kill_child_at("stop");
        let pending = next_launch(&root).expect("recovery offered");
        assert_eq!(pending.stage, DictationCheckpointStage::Stopped);
        assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);
        #[cfg(unix)]
        assert_eq!(mode(&pending.path), 0o600);
    }

    #[test]
    fn killed_after_recognition_the_next_launch_offers_the_audio() {
        let root = kill_child_at("recognized");
        let pending = next_launch(&root).expect("recovery offered");
        assert_eq!(pending.stage, DictationCheckpointStage::Recognized);
        assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);
    }

    #[test]
    fn killed_after_a_delivery_attempt_the_next_launch_says_it_may_have_landed() {
        let root = kill_child_at("delivery_attempted");
        let pending = next_launch(&root).expect("recovery offered");
        assert_eq!(pending.stage, DictationCheckpointStage::Delivering);
        assert_eq!(std::fs::read(&pending.path).unwrap(), AUDIO);
    }

    #[test]
    fn killed_after_the_outcome_was_recorded_nothing_is_left() {
        let root = kill_child_at("resolved");
        assert!(next_launch(&root).is_none());
        assert!(only_file(&root.path().join(CHECKPOINT_DIRECTORY)).is_empty());
    }
}
