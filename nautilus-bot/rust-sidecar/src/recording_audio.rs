//! Canonical ownership and durability helpers for recording audio bundles.
//!
//! Renderer-facing [`crate::models::Recording`] values continue to expose only
//! `audio_path`. Internally, a recording owns at most three assets: `primary`
//! (mixed audio, or the sole microphone track), `mic`, and `system`.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum RecordingAudioRole {
    Primary,
    Mic,
    System,
}

impl RecordingAudioRole {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Mic => "mic",
            Self::System => "system",
        }
    }

    pub(crate) fn from_str(value: &str) -> Result<Self> {
        match value {
            "primary" => Ok(Self::Primary),
            "mic" => Ok(Self::Mic),
            "system" => Ok(Self::System),
            _ => anyhow::bail!("Unknown recording audio role '{value}'"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordingAudioLifecycle {
    Planned,
    Writing,
    Ready,
    Missing,
    Failed,
}

impl RecordingAudioLifecycle {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Writing => "writing",
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn from_str(value: &str) -> Result<Self> {
        match value {
            "planned" => Ok(Self::Planned),
            "writing" => Ok(Self::Writing),
            "ready" => Ok(Self::Ready),
            "missing" => Ok(Self::Missing),
            "failed" => Ok(Self::Failed),
            _ => anyhow::bail!("Unknown recording audio lifecycle '{value}'"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordingAudioProtection {
    Plaintext,
    Encrypted,
}

impl RecordingAudioProtection {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Plaintext => "plaintext",
            Self::Encrypted => "encrypted",
        }
    }

    pub(crate) fn from_str(value: &str) -> Result<Self> {
        match value {
            "plaintext" => Ok(Self::Plaintext),
            "encrypted" => Ok(Self::Encrypted),
            _ => anyhow::bail!("Unknown recording audio protection '{value}'"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingAudioAsset {
    pub recording_id: String,
    pub role: RecordingAudioRole,
    pub path: PathBuf,
    pub lifecycle: RecordingAudioLifecycle,
    pub protection: RecordingAudioProtection,
    pub plaintext_bytes: Option<u64>,
    pub plaintext_sha256: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingAudioBundle {
    pub recording_id: String,
    pub primary: Option<RecordingAudioAsset>,
    pub mic: Option<RecordingAudioAsset>,
    pub system: Option<RecordingAudioAsset>,
}

impl RecordingAudioBundle {
    pub(crate) fn empty(recording_id: impl Into<String>) -> Self {
        Self {
            recording_id: recording_id.into(),
            primary: None,
            mic: None,
            system: None,
        }
    }

    pub(crate) fn insert(&mut self, asset: RecordingAudioAsset) -> Result<()> {
        if asset.recording_id != self.recording_id {
            anyhow::bail!(
                "Audio asset recording '{}' does not match bundle '{}'",
                asset.recording_id,
                self.recording_id
            );
        }
        let slot = match asset.role {
            RecordingAudioRole::Primary => &mut self.primary,
            RecordingAudioRole::Mic => &mut self.mic,
            RecordingAudioRole::System => &mut self.system,
        };
        if slot.is_some() {
            anyhow::bail!(
                "Recording '{}' has duplicate '{}' audio assets",
                self.recording_id,
                asset.role.as_str()
            );
        }
        *slot = Some(asset);
        Ok(())
    }

    pub(crate) fn assets(&self) -> impl Iterator<Item = &RecordingAudioAsset> {
        [
            self.primary.as_ref(),
            self.mic.as_ref(),
            self.system.as_ref(),
        ]
        .into_iter()
        .flatten()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingCapturePlan {
    pub recording_id: String,
    pub primary_path: PathBuf,
    pub mic_path: Option<PathBuf>,
    pub system_path: Option<PathBuf>,
}

impl RecordingCapturePlan {
    pub(crate) fn new(
        recordings_dir: &Path,
        capture_mic: bool,
        capture_system: bool,
    ) -> Result<Self> {
        if !capture_mic && !capture_system {
            anyhow::bail!("Must enable microphone or system audio capture");
        }

        let recording_id = uuid::Uuid::new_v4().to_string();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("System clock is before the Unix epoch")?
            .as_secs();
        let filename = format!("recording_{}_{}.wav", timestamp, &recording_id[..8]);
        let primary_path = recordings_dir.join(filename);
        let stem = primary_path
            .file_stem()
            .and_then(|value| value.to_str())
            .context("Planned recording filename has no UTF-8 stem")?;

        // A mic-only recording stores its sole microphone track as `primary`.
        // Source companion rows exist only for a system-audio bundle.
        let mic_path =
            (capture_system && capture_mic).then(|| recordings_dir.join(format!("{stem}_mic.wav")));
        let system_path = capture_system.then(|| recordings_dir.join(format!("{stem}_system.wav")));

        Ok(Self {
            recording_id,
            primary_path,
            mic_path,
            system_path,
        })
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = (RecordingAudioRole, &Path)> {
        [
            Some((RecordingAudioRole::Primary, self.primary_path.as_path())),
            self.mic_path
                .as_deref()
                .map(|path| (RecordingAudioRole::Mic, path)),
            self.system_path
                .as_deref()
                .map(|path| (RecordingAudioRole::System, path)),
        ]
        .into_iter()
        .flatten()
    }
}

/// Runtime paths plus one aggregate guard for every temporary decrypted file.
#[derive(Debug)]
pub(crate) struct ResolvedRecordingAudioBundle {
    pub primary: PathBuf,
    pub mic: Option<PathBuf>,
    pub system: Option<PathBuf>,
    _temporary_files: Vec<DurableTempFile>,
}

impl ResolvedRecordingAudioBundle {
    pub(crate) fn new(
        primary: PathBuf,
        mic: Option<PathBuf>,
        system: Option<PathBuf>,
        _temporary_files: Vec<DurableTempFile>,
    ) -> Self {
        Self {
            primary,
            mic,
            system,
            _temporary_files,
        }
    }

    /// True when at least one path is an app-owned decrypted copy that is
    /// deleted when this bundle drops.
    pub(crate) fn holds_temporary_files(&self) -> bool {
        !self._temporary_files.is_empty()
    }
}

/// Deletes an unpublished temporary file unless ownership is explicitly released.
#[derive(Debug)]
pub(crate) struct DurableTempFile {
    path: PathBuf,
    armed: bool,
}

impl DurableTempFile {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    pub(crate) fn disarm(mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

impl Drop for DurableTempFile {
    fn drop(&mut self) {
        if self.armed {
            match std::fs::remove_file(&self.path) {
                Ok(()) => {
                    let _ = sync_parent_directory(&self.path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => tracing::warn!(
                    "Failed to remove temporary recording audio '{}': {}",
                    self.path.display(),
                    error
                ),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingAudioOperationItem {
    pub operation_id: String,
    pub recording_id: String,
    pub role: RecordingAudioRole,
    pub source_path: PathBuf,
    pub staged_path: PathBuf,
    pub target_path: PathBuf,
    pub plaintext_bytes: u64,
    pub plaintext_sha256: String,
    pub state: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingAudioOperation {
    pub id: String,
    pub recording_id: String,
    pub state: String,
    pub last_error: Option<String>,
    pub items: Vec<RecordingAudioOperationItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedRecordingAudio {
    pub plaintext_bytes: u64,
    pub plaintext_sha256: String,
    pub duration_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecordingAudioValidation {
    Ready(ValidatedRecordingAudio),
    Missing(String),
    Failed(String),
}

pub(crate) fn validate_plaintext_wav(path: &Path) -> RecordingAudioValidation {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RecordingAudioValidation::Missing("Audio file is absent".to_string())
        }
        Err(error) => {
            return RecordingAudioValidation::Failed(format!(
                "Could not inspect audio file: {error}"
            ))
        }
    };
    if !metadata.file_type().is_file() {
        return RecordingAudioValidation::Failed(
            "Owned audio path is not a regular file".to_string(),
        );
    }

    let mut reader = match hound::WavReader::open(path) {
        Ok(reader) => reader,
        Err(error) if metadata.len() == 0 => {
            return RecordingAudioValidation::Missing(format!("Audio file is empty: {error}"))
        }
        Err(error) => {
            return RecordingAudioValidation::Failed(format!(
                "Nonempty audio file is not a readable WAV: {error}"
            ))
        }
    };
    let spec = reader.spec();
    let duration_samples = u64::from(reader.duration());
    if duration_samples == 0 || spec.sample_rate == 0 {
        return RecordingAudioValidation::Missing(
            "Audio file contains zero audio frames".to_string(),
        );
    }
    // Force the decoder through the sample payload so a truncated data chunk is
    // not promoted merely because its header parses.
    if let Some(error) = reader.samples::<i16>().find_map(Result::err) {
        return RecordingAudioValidation::Failed(format!(
            "Nonempty audio file contains unreadable samples: {error}"
        ));
    }

    let plaintext_sha256 = match compute_file_sha256(path) {
        Ok(hash) => hash,
        Err(error) => {
            return RecordingAudioValidation::Failed(format!("Could not hash audio file: {error}"))
        }
    };
    let duration_seconds =
        ((duration_samples as f64 / f64::from(spec.sample_rate)).round() as i64).max(0);
    RecordingAudioValidation::Ready(ValidatedRecordingAudio {
        plaintext_bytes: metadata.len(),
        plaintext_sha256,
        duration_seconds,
    })
}

pub(crate) fn compute_file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("Failed to open '{}' for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Free bytes on the volume that holds `path`.
///
/// Returns an error rather than a guess when the platform has no
/// implementation or the call fails: every caller fails *open* (it records
/// audio anyway) instead of refusing to capture a meeting because the free
/// space could not be measured. A fabricated number here would either block
/// legitimate meetings or hide a disk that is genuinely about to fill.
#[cfg(unix)]
pub(crate) fn available_space_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .context("Recording directory path contains an interior NUL byte")?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) } != 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("statvfs failed for {}", path.display()));
    }
    // The statvfs field widths differ across unix platforms; keep both casts.
    #[allow(clippy::unnecessary_cast)]
    Ok((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(unix))]
pub(crate) fn available_space_bytes(path: &Path) -> Result<u64> {
    Err(anyhow::anyhow!(
        "Free-space check is not implemented on this platform (path: {})",
        path.display()
    ))
}

pub(crate) fn create_new_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .with_context(|| format!("Failed to create recording audio '{}'", path.display()))
}

pub(crate) fn sync_file(path: &Path) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .with_context(|| format!("Failed to reopen '{}' for sync", path.display()))?
        .sync_all()
        .with_context(|| format!("Failed to sync recording audio '{}'", path.display()))
}

pub(crate) fn sync_parent_directory(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Path '{}' has no parent directory", path.display()))?;
    File::open(parent)
        .with_context(|| format!("Failed to open directory '{}' for sync", parent.display()))?
        .sync_all()
        .with_context(|| format!("Failed to sync directory '{}'", parent.display()))
}

pub(crate) fn is_terminal_encrypted_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("enc"))
}

pub(crate) fn strip_terminal_encrypted_extension(path: &Path) -> PathBuf {
    if is_terminal_encrypted_path(path) {
        path.with_extension("")
    } else {
        path.to_path_buf()
    }
}

pub(crate) fn encrypted_path_for(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".enc");
    PathBuf::from(value)
}

/// Exact historical companion candidates, encrypted first.
pub(crate) fn historical_companion_candidates(
    primary_path: &Path,
    role: RecordingAudioRole,
) -> Vec<PathBuf> {
    let suffix = match role {
        RecordingAudioRole::Mic => "mic",
        RecordingAudioRole::System => "system",
        RecordingAudioRole::Primary => return Vec::new(),
    };
    let plaintext_primary = strip_terminal_encrypted_extension(primary_path);
    let Some(parent) = plaintext_primary.parent() else {
        return Vec::new();
    };
    let Some(stem) = plaintext_primary
        .file_stem()
        .and_then(|value| value.to_str())
    else {
        return Vec::new();
    };
    let plaintext = parent.join(format!("{stem}_{suffix}.wav"));
    vec![encrypted_path_for(&plaintext), plaintext]
}

pub(crate) fn approved_regular_file(path: &Path, approved_roots: &[PathBuf]) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    approved_roots.iter().any(|root| {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        canonical_path.starts_with(canonical_root)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_historical_primary_derives_exact_companions() {
        let primary = Path::new("/tmp/recording_1.wav.enc");
        assert_eq!(
            historical_companion_candidates(primary, RecordingAudioRole::Mic),
            vec![
                PathBuf::from("/tmp/recording_1_mic.wav.enc"),
                PathBuf::from("/tmp/recording_1_mic.wav")
            ]
        );
        assert_eq!(
            historical_companion_candidates(primary, RecordingAudioRole::System),
            vec![
                PathBuf::from("/tmp/recording_1_system.wav.enc"),
                PathBuf::from("/tmp/recording_1_system.wav")
            ]
        );
    }

    #[test]
    fn capture_plan_uses_primary_for_mic_only() {
        let plan = RecordingCapturePlan::new(Path::new("/tmp"), true, false).unwrap();
        assert_eq!(
            plan.primary_path
                .extension()
                .and_then(|value| value.to_str()),
            Some("wav")
        );
        assert!(plan.mic_path.is_none());
        assert!(plan.system_path.is_none());
    }

    #[test]
    fn planned_track_count_matches_the_capture_mode() {
        // The free-space thresholds scale by this count, so a mic-only meeting
        // is not charged the three-track price it never pays.
        assert_eq!(
            RecordingCapturePlan::new(Path::new("/tmp"), true, false)
                .unwrap()
                .paths()
                .count(),
            1
        );
        assert_eq!(
            RecordingCapturePlan::new(Path::new("/tmp"), false, true)
                .unwrap()
                .paths()
                .count(),
            2
        );
        assert_eq!(
            RecordingCapturePlan::new(Path::new("/tmp"), true, true)
                .unwrap()
                .paths()
                .count(),
            3
        );
    }
}
