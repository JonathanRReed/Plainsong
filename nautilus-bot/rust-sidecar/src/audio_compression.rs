//! Lossless storage conversion. Capture and recognizers continue to use PCM WAV.
use crate::recording_audio::{
    self, DurableTempFile, RecordingAudioValidation, ValidatedRecordingAudio,
};
use anyhow::{Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) fn is_flac(path: &Path) -> bool {
    let mut magic = [0; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && &magic == b"fLaC"
}

/// The returned owner must live as long as a reader uses the decoded WAV.
/// Inspect bytes, rather than extensions: vault plaintext staging uses .wav.
pub(crate) fn decode_flac(path: &Path, directory: &Path) -> Result<DurableTempFile> {
    decode_flac_while(path, directory, &|| true)
}

fn decode_flac_while(
    path: &Path,
    directory: &Path,
    idle: &dyn Fn() -> bool,
) -> Result<DurableTempFile> {
    let destination = directory.join(format!(
        ".decode-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    recording_audio::create_new_file(&destination)?;
    let guard = DurableTempFile::new(destination.clone());
    // Preserve integer depth as well as rate and channels. PCM16 decoding
    // would discard the extra precision before recognition sees the samples.
    let depth = flac_depth(path)?;
    anyhow::ensure!(matches!(depth, 16 | 24), "Unsupported stored FLAC depth");
    crate::audio_import_runtime::run_audio_conversion_while(
        vec![
            path.as_os_str().to_owned(),
            destination.as_os_str().to_owned(),
            "-f".into(),
            "WAVE".into(),
            "-d".into(),
            format!("LEI{depth}").into(),
        ],
        Duration::from_secs(900),
        idle,
    )
    .map_err(anyhow::Error::msg)?;
    Ok(guard)
}

pub(crate) fn validate_flac(path: &Path) -> Result<ValidatedRecordingAudio> {
    let decoded = decode_flac(path, path.parent().context("Audio has no parent")?)?;
    let metadata = match recording_audio::validate_plaintext_wav(decoded.path()) {
        RecordingAudioValidation::Ready(metadata) => metadata,
        RecordingAudioValidation::Missing(error) | RecordingAudioValidation::Failed(error) => {
            anyhow::bail!(error)
        }
    };
    Ok(ValidatedRecordingAudio {
        plaintext_bytes: std::fs::metadata(path)?.len(),
        plaintext_sha256: recording_audio::compute_file_sha256(path)?,
        duration_seconds: metadata.duration_seconds,
    })
}

/// Validation can be interrupted between creating and dropping its temporary
/// WAV. Only remove our exact filenames after their writer process has exited.
fn sweep_abandoned_decodes(directory: &Path, roots: &[PathBuf]) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(tail) = name
            .strip_prefix(".decode-")
            .and_then(|s| s.strip_suffix(".wav"))
        else {
            continue;
        };
        let Some((pid, uuid)) = tail.split_once('-') else {
            continue;
        };
        let Ok(pid) = pid.parse::<i32>() else {
            continue;
        };
        if pid <= 0 || pid as u32 == std::process::id() || uuid::Uuid::parse_str(uuid).is_err() {
            continue;
        }
        #[cfg(unix)]
        let exited = unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        #[cfg(not(unix))]
        let exited = false;
        if exited {
            let path =
                crate::ensure_regular_file_in_roots(&entry.path(), "abandoned audio decode", roots)
                    .map_err(anyhow::Error::msg)?;
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn same_pcm(source: &Path, decoded: &Path) -> Result<bool> {
    let mut a = hound::WavReader::open(source)?;
    let mut b = hound::WavReader::open(decoded)?;
    if a.spec() != b.spec() || a.duration() != b.duration() {
        return Ok(false);
    }
    let mut a = a.samples::<i32>();
    let mut b = b.samples::<i32>();
    loop {
        match (a.next(), b.next()) {
            (Some(a), Some(b)) => {
                if a? != b? {
                    return Ok(false);
                }
            }
            (None, None) => return Ok(true),
            _ => return Ok(false),
        }
    }
}

fn flac_depth(path: &Path) -> Result<u16> {
    let mut header = [0_u8; 26];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    anyhow::ensure!(
        &header[..4] == b"fLaC" && header[4] & 0x7f == 0,
        "Invalid FLAC STREAMINFO"
    );
    let bits = u64::from_be_bytes(header[18..26].try_into()?);
    Ok((((bits >> 36) & 31) + 1) as u16)
}

fn flac_meeting_frames(path: &Path) -> Result<Option<u64>> {
    // FLAC requires STREAMINFO first. Rate, channels and depth are packed at
    // bytes 18..22, independent of tags or filename extensions.
    let mut header = [0_u8; 26];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    if &header[..4] != b"fLaC" || header[4] & 0x7f != 0 {
        return Ok(None);
    }
    let bits = u64::from_be_bytes(header[18..26].try_into()?);
    Ok(
        (bits >> 44 == 16_000 && (bits >> 41) & 7 == 0 && matches!((bits >> 36) & 31, 15 | 23))
            .then_some(bits & ((1 << 36) - 1)),
    )
}

// Match the shipping 16 kHz reader's centered 95-tap anti-alias filter and
// rational interpolation. PCM16 cannot represent every resulting f32 exactly;
// compare the storage quantization exactly instead of claiming float identity.
const MEETING_PCM_SCALE: f32 = 32768.0;
fn recognition_pcm16(sample: f32) -> i16 {
    (sample * MEETING_PCM_SCALE)
        .round()
        .clamp(-32768.0, 32767.0) as i16
}

fn verify_resampled(source: &Path, converted: &Path, idle: &dyn Fn() -> bool) -> Result<()> {
    let source_header = hound::WavReader::open(source)?;
    let mut output = hound::WavReader::open(converted)?;
    let expected =
        u64::from(source_header.duration()) * 16_000 / u64::from(source_header.spec().sample_rate);
    anyhow::ensure!(
        output.spec().sample_rate == 16_000
            && output.spec().channels == 1
            && output.spec().bits_per_sample == 16
            && output.spec().sample_format == hound::SampleFormat::Int
            && u64::from(output.duration()) == expected,
        "Resampled audio format or frame count changed"
    );
    let mut reference = crate::audio::utils::AudioWindowReader::open_for_asr_storage(source)?;
    let mut samples = output.samples::<i16>();
    while reference.has_more() {
        anyhow::ensure!(idle(), "Audio verification yielded to foreground work");
        for sample in reference.next_window()? {
            anyhow::ensure!(
                samples.next().transpose()? == Some(recognition_pcm16(sample)),
                "Stored audio differs from the recognition resampler's PCM16 output"
            );
        }
    }
    anyhow::ensure!(samples.next().is_none(), "Unexpected resampling tail");
    Ok(())
}

fn resample_meeting(
    source: &Path,
    directory: &Path,
    idle: &dyn Fn() -> bool,
) -> Result<DurableTempFile> {
    let mut reader = crate::audio::utils::AudioWindowReader::open_for_asr_storage(source)?;
    let target = directory.join(format!(
        ".decode-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let (file, guard) = recording_audio::create_secure_temporary_audio(&target)?;
    let mut writer = hound::WavWriter::new(
        std::io::BufWriter::new(file),
        hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?;
    while reader.has_more() {
        anyhow::ensure!(idle(), "Audio conversion yielded to foreground work");
        for sample in reader.next_window()? {
            writer.write_sample(recognition_pcm16(sample))?;
        }
    }
    writer.finalize()?;
    verify_resampled(source, &target, idle)?;
    Ok(guard)
}

/// Publish only a smaller, fully decoded, sample-identical FLAC. The caller
/// journals its final path before this runs, and owns deletion of the source.
fn encode_verified(
    source: &Path,
    target: &Path,
    idle: &dyn Fn() -> bool,
) -> Result<ValidatedRecordingAudio> {
    let reader = hound::WavReader::open(source)?;
    let spec = reader.spec();
    anyhow::ensure!(
        matches!(spec.channels, 1 | 2)
            && matches!(spec.sample_rate, 16_000 | 44_100 | 48_000)
            && matches!(spec.bits_per_sample, 16 | 24)
            && spec.sample_format == hound::SampleFormat::Int,
        "Only finalized 16, 44.1 or 48 kHz mono or stereo PCM16/PCM24 recordings can be compressed"
    );
    let seconds = u64::from(reader.duration()).div_ceil(u64::from(spec.sample_rate));
    drop(reader);
    recording_audio::create_new_file(target)?;
    let guard = DurableTempFile::new(target.to_owned());
    let args = vec![
        source.as_os_str().to_owned(),
        target.as_os_str().to_owned(),
        "-f".into(),
        "flac".into(),
        "-d".into(),
        "flac".into(),
    ];
    crate::audio_import_runtime::run_audio_conversion_while(
        args,
        Duration::from_secs((seconds * 2).clamp(60, 900)),
        idle,
    )
    .map_err(anyhow::Error::msg)?;
    let decoded = decode_flac_while(
        target,
        target.parent().context("Audio has no parent")?,
        idle,
    )?;
    anyhow::ensure!(
        same_pcm(source, decoded.path())?,
        "Compressed audio changed samples or duration"
    );
    let metadata = match recording_audio::validate_plaintext_wav(source) {
        RecordingAudioValidation::Ready(metadata) => metadata,
        RecordingAudioValidation::Missing(error) | RecordingAudioValidation::Failed(error) => {
            anyhow::bail!(error)
        }
    };
    let bytes = std::fs::metadata(target)?.len();
    anyhow::ensure!(
        bytes < metadata.plaintext_bytes,
        "Compression did not reduce storage"
    );
    std::fs::File::open(target)?.sync_all()?;
    recording_audio::sync_parent_directory(target)?;
    let result = ValidatedRecordingAudio {
        plaintext_bytes: bytes,
        plaintext_sha256: recording_audio::compute_file_sha256(target)?,
        duration_seconds: metadata.duration_seconds,
    };
    guard.disarm();
    Ok(result)
}

#[derive(Debug, Clone)]
pub(crate) struct CompressionJob {
    pub id: i64,
    pub recording_id: String,
    pub role: recording_audio::RecordingAudioRole,
    pub source: PathBuf,
    pub target: PathBuf,
    pub committed: bool,
}

fn prepare_compressed_asset(
    asset: &recording_audio::RecordingAudioAsset,
    job: &CompressionJob,
    key: Option<&[u8; 32]>,
    runtime: &Path,
    roots: &[PathBuf],
    idle: &dyn Fn() -> bool,
    meeting: bool,
) -> Result<ValidatedRecordingAudio> {
    crate::ensure_regular_file_in_roots(&job.source, "compression source", roots)
        .map_err(anyhow::Error::msg)?;
    if job.target.exists() {
        crate::ensure_regular_file_in_roots(&job.target, "unpublished compression output", roots)
            .map_err(anyhow::Error::msg)?;
        std::fs::remove_file(&job.target)?;
    }
    let decrypted;
    let source = if asset.protection == recording_audio::RecordingAudioProtection::Encrypted {
        let path = runtime.join(format!("{}.wav", uuid::Uuid::new_v4()));
        crate::playback::decrypt_vault_file_to_path(
            &job.source,
            &path,
            key.context("Vault is locked")?,
        )
        .map_err(anyhow::Error::msg)?;
        decrypted = DurableTempFile::new(path);
        decrypted.path()
    } else {
        &job.source
    };
    let source_metadata = match recording_audio::validate_plaintext_wav(source) {
        RecordingAudioValidation::Ready(metadata) => metadata,
        RecordingAudioValidation::Missing(error) | RecordingAudioValidation::Failed(error) => {
            anyhow::bail!(error)
        }
    };
    crate::validate_runtime_recording_audio_metadata(asset, &source_metadata)
        .map_err(anyhow::Error::msg)?;
    let decoded;
    let source = if is_flac(source) {
        decoded = decode_flac_while(source, runtime, idle)?;
        decoded.path()
    } else {
        source
    };
    let resampled;
    let source = if meeting {
        resampled = resample_meeting(source, runtime, idle)?;
        resampled.path()
    } else {
        source
    };
    if asset.protection == recording_audio::RecordingAudioProtection::Plaintext {
        return encode_verified(source, &job.target, idle);
    }
    let compressed = DurableTempFile::new(runtime.join(format!("{}.flac", uuid::Uuid::new_v4())));
    let metadata = encode_verified(source, compressed.path(), idle)?;
    let output = recording_audio::create_new_file(&job.target)?;
    let output_guard = DurableTempFile::new(job.target.clone());
    let mut writer = std::io::BufWriter::new(output);
    crate::crypto::ProjectKeyManager::encrypt_stream(
        &mut std::io::BufReader::new(std::fs::File::open(compressed.path())?),
        &mut writer,
        key.context("Vault is locked")?,
        |_| {},
    )?;
    writer.into_inner()?.sync_all()?;
    recording_audio::sync_parent_directory(&job.target)?;
    // Reopen and authenticate the actual ciphertext before publishing its path.
    let verified = DurableTempFile::new(runtime.join(format!("{}.flac", uuid::Uuid::new_v4())));
    crate::playback::decrypt_vault_file_to_path(
        &job.target,
        verified.path(),
        key.context("Vault is locked")?,
    )
    .map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        recording_audio::compute_file_sha256(verified.path())? == metadata.plaintext_sha256,
        "Encrypted compressed audio failed verification"
    );
    output_guard.disarm();
    Ok(metadata)
}

struct CompressionAttempt {
    job: CompressionJob,
    db: std::sync::Arc<tokio::sync::Mutex<crate::db::Database>>,
    roots: Vec<PathBuf>,
}

fn meeting_asset_stored(
    asset: &recording_audio::RecordingAudioAsset,
    key: Option<&[u8; 32]>,
    runtime: &Path,
    verify: bool,
) -> Result<Option<u64>> {
    let decrypted;
    let path = if asset.protection == recording_audio::RecordingAudioProtection::Encrypted {
        let Some(key) = key else {
            return Ok(None);
        };
        let path = runtime.join(format!("{}.flac", uuid::Uuid::new_v4()));
        crate::playback::decrypt_vault_file_to_path(&asset.path, &path, key)
            .map_err(anyhow::Error::msg)?;
        decrypted = DurableTempFile::new(path);
        decrypted.path()
    } else {
        &asset.path
    };
    if !is_flac(path) {
        return Ok(None);
    }
    let frames = flac_meeting_frames(path)?;
    if frames.is_none() {
        return Ok(None);
    }
    if verify {
        crate::validate_runtime_recording_audio_metadata(asset, &validate_flac(path)?)
            .map_err(anyhow::Error::msg)?;
    }
    Ok(frames)
}

fn verified_meeting_sources(
    bundle: &recording_audio::RecordingAudioBundle,
    key: Option<&[u8; 32]>,
    runtime: &Path,
    roots: &[PathBuf],
) -> Result<bool> {
    if bundle.system.is_none() {
        return Ok(false);
    }
    let mut frames = None;
    for asset in bundle
        .assets()
        .filter(|a| a.role != recording_audio::RecordingAudioRole::Primary)
    {
        crate::ensure_regular_file_in_roots(&asset.path, "retained meeting source", roots)
            .map_err(anyhow::Error::msg)?;
        let source_frames = meeting_asset_stored(asset, key, runtime, true)?;
        if asset.lifecycle != recording_audio::RecordingAudioLifecycle::Ready
            || source_frames.is_none()
            || (frames.is_some() && frames != source_frames)
        {
            return Ok(false);
        }
        frames = source_frames;
    }
    Ok(frames.is_some())
}
impl Drop for CompressionAttempt {
    fn drop(&mut self) {
        if let Err(error) = self
            .db
            .blocking_lock()
            .end_compression_attempt(&self.job, &self.roots)
        {
            tracing::warn!("Could not release failed audio compression for cleanup: {error}");
        }
    }
}

/// One track per idle pass. The journal is durable before conversion begins;
/// uncommitted work keeps the WAV, committed work retries only WAV cleanup.
pub(crate) async fn compress_next(state: &crate::AppState) -> Result<(), String> {
    use crate::operation_coordinator::OperationKind;
    if !cfg!(target_os = "macos")
        || !crate::memory_pressure::background_allowed()
        || state
            .operation_coordinator
            .is_active(OperationKind::PostProcess)
        || crate::llm::speech_priority::speech_active()
        || state
            .operation_coordinator
            .is_active(OperationKind::HeavyPostCall)
    {
        return Ok(());
    }
    let lease = state
        .operation_coordinator
        .try_acquire_named(OperationKind::PostProcess, "idle meeting audio conversion")?;
    let storage_gate = state.audio_storage_gate.clone();
    let coordinator = state.operation_coordinator.clone();
    let active_ids = state.active_meeting_audio_postprocessing.clone();
    let db = state.db.clone();
    let key = state.vault_state.lock().await.recording_key;
    let runtime = crate::prepare_decrypted_recording_audio_directory()?;
    let roots = crate::approved_path_roots()?;
    let active = crate::active_meeting_audio_postprocessing_ids(state);
    tokio::task::spawn_blocking(move || {
        crate::qos::run_background(|| -> Result<()> {
            let _lease = lease;
            let idle = || {
                crate::memory_pressure::background_allowed()
                    && !coordinator.is_active(OperationKind::Capture)
                    && !crate::llm::speech_priority::speech_active()
            };
            let recordings = db.blocking_lock().get_recordings(None)?;
            let mut swept = std::collections::HashSet::new();
            for recording in recordings {
                if !matches!(recording.source_type.as_str(), "meeting" | "dictation")
                    || recording.status != "completed"
                    || active.contains(&recording.id)
                {
                    continue;
                }
                let meeting = recording.source_type == "meeting";
                let meeting_16k = meeting && cfg!(feature = "meeting-audio-16k");
                if meeting && !db.blocking_lock().meeting_audio_finalized(&recording.id)? {
                    continue;
                }
                if db
                    .blocking_lock()
                    .load_open_recording_audio_operation(&recording.id)?
                    .is_some()
                {
                    continue;
                }
                let bundle = db
                    .blocking_lock()
                    .load_recording_audio_bundle(&recording.id)?;
                let jobs = db.blocking_lock().compression_jobs_for_bundle(&bundle)?;
                let mut assets: Vec<_> = bundle.assets().cloned().collect();
                // The mix row has already been removed, but its committed
                // cleanup journal still owns the original file.
                if bundle.primary.is_none() {
                    if let Some(job) = jobs
                        .iter()
                        .find(|job| job.role == recording_audio::RecordingAudioRole::Primary)
                    {
                        let mut cleanup = bundle
                            .system
                            .as_ref()
                            .context("Mix cleanup has no call track")?
                            .clone();
                        cleanup.role = job.role;
                        assets.push(cleanup);
                    }
                }
                for asset in &assets {
                    if let Some(directory) = asset.path.parent() {
                        if directory.is_dir() && swept.insert(directory.to_owned()) {
                            sweep_abandoned_decodes(directory, &roots)?;
                        }
                    }
                    if asset.lifecycle != recording_audio::RecordingAudioLifecycle::Ready {
                        continue;
                    }
                    if !db
                        .blocking_lock()
                        .compression_due(&asset.recording_id, asset.role)?
                    {
                        continue;
                    }
                    let pending = db.blocking_lock().compression_job(asset).ok();
                    if pending.is_none()
                        && meeting_16k
                        && ((asset.role == recording_audio::RecordingAudioRole::Primary
                            && bundle.system.is_some())
                            || meeting_asset_stored(asset, key.as_ref(), &runtime, false)?
                                .is_some())
                    {
                        continue;
                    }
                    if pending.is_none()
                        && !meeting_16k
                        && !asset
                            .path
                            .to_string_lossy()
                            .trim_end_matches(".enc")
                            .ends_with(".wav")
                    {
                        continue;
                    }
                    if asset.protection == recording_audio::RecordingAudioProtection::Encrypted
                        && key.is_none()
                    {
                        continue;
                    }
                    let job = {
                        let _gate = storage_gate.blocking_lock();
                        match pending {
                            Some(job) => job,
                            None => db.blocking_lock().begin_audio_compression(asset)?,
                        }
                    };
                    db.blocking_lock().defer_audio_compression(&job)?;
                    let _attempt = CompressionAttempt {
                        job: job.clone(),
                        db: db.clone(),
                        roots: roots.clone(),
                    };
                    if !job.committed {
                        // Keep headroom for the decode and compressed copies, journal and
                        // capture. An unknown free-space reading refuses background work.
                        let required = std::fs::metadata(&job.source)?
                            .len()
                            .saturating_mul(4)
                            .saturating_add(256 * 1024 * 1024);
                        anyhow::ensure!(
                            crate::download::available_space_for_path(
                                job.source.parent().context("No audio directory")?
                            )? >= required,
                            "Audio compression deferred until more disk space is available"
                        );
                        let metadata = prepare_compressed_asset(
                            asset,
                            &job,
                            key.as_ref(),
                            &runtime,
                            &roots,
                            &idle,
                            meeting_16k,
                        )?;
                        anyhow::ensure!(
                            std::fs::metadata(&job.target)?.len()
                                < std::fs::metadata(&job.source)?.len(),
                            "Conversion did not reduce stored bytes"
                        );
                        anyhow::ensure!(
                            db.blocking_lock().compression_source_unchanged(&job)?,
                            "Source changed during compression"
                        );
                        let saved = std::fs::metadata(&job.source)?
                            .len()
                            .saturating_sub(std::fs::metadata(&job.target)?.len());
                        let _gate = storage_gate.blocking_lock();
                        anyhow::ensure!(
                            idle()
                                && !active_ids
                                    .lock()
                                    .map_err(|_| anyhow::anyhow!(
                                        "Audio processing state is unavailable"
                                    ))?
                                    .contains_key(&recording.id),
                            "Audio compression yielded to foreground work"
                        );
                        db.blocking_lock()
                            .commit_audio_compression(&job, &metadata, saved)?;
                    }
                    // Revalidate the published copy even when resuming after a crash.
                    crate::ensure_regular_file_in_roots(
                        &job.target,
                        "compressed recording",
                        &roots,
                    )
                    .map_err(anyhow::Error::msg)?;
                    let current = db
                        .blocking_lock()
                        .load_recording_audio_bundle(&job.recording_id)?;
                    if job.role == recording_audio::RecordingAudioRole::Primary
                        && current.primary.is_none()
                    {
                        anyhow::ensure!(
                            verified_meeting_sources(&current, key.as_ref(), &runtime, &roots)?,
                            "Retained sources failed verification before mix cleanup"
                        );
                    }
                    let current = current
                        .assets()
                        .find(|a| a.path == job.target)
                        .context("Compressed asset is absent")?;
                    if current.protection == recording_audio::RecordingAudioProtection::Plaintext {
                        let metadata = validate_flac(&job.target)?;
                        crate::validate_runtime_recording_audio_metadata(current, &metadata)
                            .map_err(anyhow::Error::msg)?;
                    } else {
                        let verified = DurableTempFile::new(
                            runtime.join(format!("{}.flac", uuid::Uuid::new_v4())),
                        );
                        crate::playback::decrypt_vault_file_to_path(
                            &job.target,
                            verified.path(),
                            key.as_ref().context("Vault is locked")?,
                        )
                        .map_err(anyhow::Error::msg)?;
                        let metadata = validate_flac(verified.path())?;
                        crate::validate_runtime_recording_audio_metadata(current, &metadata)
                            .map_err(anyhow::Error::msg)?;
                    }
                    let _gate = storage_gate.blocking_lock();
                    anyhow::ensure!(
                        idle()
                            && !active_ids
                                .lock()
                                .map_err(|_| anyhow::anyhow!(
                                    "Audio processing state is unavailable"
                                ))?
                                .contains_key(&recording.id),
                        "Audio compression yielded to foreground work"
                    );
                    if job.source.exists() {
                        crate::ensure_regular_file_in_roots(
                            &job.source,
                            "old recording audio",
                            &roots,
                        )
                        .map_err(anyhow::Error::msg)?;
                        anyhow::ensure!(
                            db.blocking_lock().compression_source_unchanged(&job)?,
                            "Old source changed before cleanup"
                        );
                        std::fs::remove_file(&job.source)?;
                        recording_audio::sync_parent_directory(&job.source)?;
                    }
                    db.blocking_lock().finish_audio_compression(&job)?;
                    return Ok(());
                }
                if meeting_16k
                    && bundle.primary.is_some()
                    && bundle.system.is_some()
                    && jobs.is_empty()
                    && verified_meeting_sources(&bundle, key.as_ref(), &runtime, &roots)?
                {
                    let _gate = storage_gate.blocking_lock();
                    let mut database = db.blocking_lock();
                    let active = active_ids
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Audio processing state is unavailable"))?;
                    anyhow::ensure!(
                        idle() && !active.contains_key(&recording.id),
                        "Audio compression yielded to foreground work"
                    );
                    database.retire_meeting_mix(&bundle)?;
                    return Ok(());
                }
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Audio compression will retry: {e:#}"))
}

pub(crate) async fn storage_status(state: &crate::AppState) -> Result<serde_json::Value, String> {
    let (paths, saved, pending) = {
        let db = state.db.lock().await;
        let mut paths = std::collections::HashSet::new();
        let mut pending = 0;
        for recording in db.get_recordings(None).map_err(|e| e.to_string())? {
            let bundle = db
                .load_recording_audio_bundle(&recording.id)
                .map_err(|e| e.to_string())?;
            for asset in bundle.assets() {
                paths.insert(asset.path.clone());
            }
            for job in db
                .compression_jobs_for_bundle(&bundle)
                .map_err(|e| e.to_string())?
            {
                pending += 1;
                paths.insert(job.source);
                paths.insert(job.target);
            }
        }
        (
            paths,
            db.compression_bytes_saved().map_err(|e| e.to_string())?,
            pending,
        )
    };
    let roots = crate::approved_path_roots()?;
    let bytes = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let mut bytes = 0_u64;
        for path in paths {
            if !path.exists() {
                continue;
            }
            let path = crate::ensure_regular_file_in_roots(&path, "meeting audio storage", &roots)?;
            bytes = bytes.saturating_add(std::fs::metadata(path).map_err(|e| e.to_string())?.len());
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({"audioBytes": bytes, "bytesSaved": saved, "pendingTracks": pending}))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::recording_audio::{
        RecordingAudioAsset, RecordingAudioLifecycle, RecordingAudioProtection, RecordingAudioRole,
    };

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("plainsong-compression-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn wav(path: &Path) {
        wav_format(path, 16_000, 1);
    }
    fn wav_format(path: &Path, sample_rate: u32, channels: u16) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for n in 0..sample_rate * 2 + 17 {
            for channel in 0..channels {
                let phase = n as f32 * (0.08 + f32::from(channel) * 0.03);
                writer.write_sample((phase.sin() * 4000.0) as i16).unwrap();
            }
        }
        writer.finalize().unwrap();
    }
    fn asset(source: &Path) -> RecordingAudioAsset {
        let RecordingAudioValidation::Ready(metadata) =
            recording_audio::validate_plaintext_wav(source)
        else {
            panic!("fixture WAV");
        };
        RecordingAudioAsset {
            recording_id: "compression".into(),
            role: RecordingAudioRole::Primary,
            path: source.to_owned(),
            lifecycle: RecordingAudioLifecycle::Ready,
            protection: RecordingAudioProtection::Plaintext,
            plaintext_bytes: Some(metadata.plaintext_bytes),
            plaintext_sha256: Some(metadata.plaintext_sha256),
            last_error: None,
        }
    }

    #[test]
    fn abandoned_decode_cleanup_preserves_active_and_unowned_files() {
        let root = Scratch::new();
        let stale = root
            .0
            .join(format!(".decode-2147483647-{}.wav", uuid::Uuid::new_v4()));
        let active = root.0.join(format!(
            ".decode-{}-{}.wav",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let unowned = root.0.join("meeting.wav");
        for path in [&stale, &active, &unowned] {
            std::fs::write(path, b"fixture").unwrap();
        }
        sweep_abandoned_decodes(&root.0, std::slice::from_ref(&root.0)).unwrap();
        assert!(!stale.exists());
        assert!(active.exists());
        assert!(unowned.exists());
    }

    #[test]
    fn flac_round_trip_is_smaller_sample_identical_and_validates_by_content() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav(&source);
        let target = root.0.join("compressed.wav"); // Vault staging has a WAV extension.
        let metadata = encode_verified(&source, &target, &|| true).unwrap();
        assert!(metadata.plaintext_bytes < std::fs::metadata(&source).unwrap().len());
        let RecordingAudioValidation::Ready(read) =
            recording_audio::validate_plaintext_wav(&target)
        else {
            panic!("compressed content must validate");
        };
        assert_eq!(read, metadata);
        let decoded = decode_flac(&target, &root.0).unwrap();
        assert!(same_pcm(&source, decoded.path()).unwrap());
        let span = crate::meeting_asides::AsideSpan {
            aside_id: "flac-aside".into(),
            dictation_session_id: 1,
            sample_rate: 48000,
            start_frame: 4800,
            end_frame: Some(9600),
            started_at_ms: 0,
            ended_at_ms: Some(1),
            paused_frames: 0,
        };
        let original_masked = root.0.join("original-masked.wav");
        let converted_masked = root.0.join("converted-masked.wav");
        crate::meeting_aside_audio::copy_wav(
            &source,
            &original_masked,
            std::slice::from_ref(&span),
            false,
        )
        .unwrap();
        crate::meeting_aside_audio::copy_wav(decoded.path(), &converted_masked, &[span], false)
            .unwrap();
        assert!(same_pcm(&original_masked, &converted_masked).unwrap());
    }

    #[test]
    fn flac_round_trip_preserves_native_rate_channels_frames_and_samples() {
        let root = Scratch::new();
        for rate in [16_000, 44_100, 48_000] {
            for channels in [1, 2] {
                let source = root.0.join(format!("{rate}-{channels}.wav"));
                wav_format(&source, rate, channels);
                let target = source.with_extension("flac");
                encode_verified(&source, &target, &|| true).unwrap();
                let decoded = decode_flac(&target, &root.0).unwrap();
                let reader = hound::WavReader::open(decoded.path()).unwrap();
                assert_eq!(reader.spec().sample_rate, rate);
                assert_eq!(reader.spec().channels, channels);
                assert_eq!(reader.duration(), rate * 2 + 17);
                assert!(same_pcm(&source, decoded.path()).unwrap());
            }
        }
    }

    #[test]
    fn verification_rejects_changed_format_samples_and_truncated_payloads() {
        let root = Scratch::new();
        let source = root.0.join("source.wav");
        let changed = root.0.join("changed.wav");
        wav_format(&source, 48_000, 2);
        wav_format(&changed, 44_100, 2);
        assert!(!same_pcm(&source, &changed).unwrap());
        let mut bytes = std::fs::read(&source).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(&changed, &bytes).unwrap();
        assert!(!same_pcm(&source, &changed).unwrap());
        bytes.truncate(bytes.len() - 2);
        std::fs::write(&changed, &bytes).unwrap();
        assert!(!matches!(same_pcm(&source, &changed), Ok(true)));
    }

    #[test]
    fn failed_or_preempted_conversion_keeps_source_and_removes_partial_output() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav_format(&source, 48_000, 2);
        let original = std::fs::read(&source).unwrap();
        let target = root.0.join("compressed.flac");
        assert!(encode_verified(&source, &target, &|| false).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(!target.exists());
        std::fs::write(&source, b"not WAV").unwrap();
        assert!(encode_verified(&source, &target, &|| true).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"not WAV");
    }

    #[test]
    fn incompressible_48khz_audio_keeps_wav_and_removes_verified_larger_flac() {
        let root = Scratch::new();
        let source = root.0.join("noise.wav");
        let mut writer = hound::WavWriter::create(
            &source,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        let mut random = 123456789_u32;
        for _ in 0..192_000 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            writer.write_sample(random as i16).unwrap();
        }
        writer.finalize().unwrap();
        let original = std::fs::read(&source).unwrap();
        let target = root.0.join("noise.flac");
        let error = encode_verified(&source, &target, &|| true).unwrap_err();
        assert!(
            error.to_string().contains("did not reduce storage"),
            "{error:#}"
        );
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(!target.exists());
    }

    #[test]
    fn every_runtime_mode_resolves_all_compressed_tracks_to_owned_wavs() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav_format(&source, 48_000, 2);
        let target = root.0.join("compressed.flac");
        let metadata = encode_verified(&source, &target, &|| true).unwrap();
        let mut bundle = recording_audio::RecordingAudioBundle::empty("compression");
        for role in [
            RecordingAudioRole::Primary,
            RecordingAudioRole::Mic,
            RecordingAudioRole::System,
        ] {
            let path = root.0.join(format!("{}.flac", role.as_str()));
            std::fs::copy(&target, &path).unwrap();
            bundle
                .insert(RecordingAudioAsset {
                    role,
                    path,
                    plaintext_bytes: Some(metadata.plaintext_bytes),
                    plaintext_sha256: Some(metadata.plaintext_sha256.clone()),
                    ..asset(&source)
                })
                .unwrap();
        }
        for mode in [
            crate::RuntimeAudioResolveMode::Full,
            crate::RuntimeAudioResolveMode::PlaybackPrimary,
        ] {
            let resolved = crate::resolve_recording_audio_bundle_in_directory(
                &bundle,
                None,
                &root.0,
                std::slice::from_ref(&root.0),
                mode,
                &[],
            )
            .unwrap();
            assert!(same_pcm(&source, &resolved.primary).unwrap());
            let expected = crate::audio::utils::load_audio_file(&source).unwrap();
            // Retry transcription and community-1 speaker labeling use this reader.
            assert_eq!(
                crate::audio::utils::load_audio_file(&resolved.primary).unwrap(),
                expected
            );
            // Chunked meeting transcription uses the streaming reader.
            let mut wav_windows = crate::audio::utils::AudioWindowReader::open(&source).unwrap();
            let mut flac_windows =
                crate::audio::utils::AudioWindowReader::open(&resolved.primary).unwrap();
            while wav_windows.has_more() {
                assert_eq!(
                    wav_windows.next_window().unwrap(),
                    flac_windows.next_window().unwrap()
                );
            }
            assert!(!flac_windows.has_more());
            let waveform = crate::audio::waveform::generate_waveform_from_file(
                resolved.primary.to_str().unwrap(),
                100,
            )
            .unwrap();
            let original_waveform =
                crate::audio::waveform::generate_waveform_from_file(source.to_str().unwrap(), 100)
                    .unwrap();
            assert_eq!(waveform.sample_rate, 48_000);
            assert_eq!(waveform.channels, 2);
            assert_eq!(waveform.samples, original_waveform.samples);
            if mode == crate::RuntimeAudioResolveMode::Full {
                assert!(same_pcm(&source, resolved.mic.as_ref().unwrap()).unwrap());
                assert!(same_pcm(&source, resolved.system.as_ref().unwrap()).unwrap());
            }
            let path = resolved.primary.clone();
            let registry = crate::playback::PlaybackRegistry::default();
            let token = crate::playback::PlaybackRegistry::new_token();
            let (release, _released) = tokio::sync::oneshot::channel();
            registry.register(
                token.clone(),
                "compression".into(),
                std::sync::Arc::new(resolved),
                crate::playback::PlaybackProtection::Decrypted,
                release,
            );
            let playing = registry.live_audio("compression").unwrap();
            assert!(same_pcm(&source, &playing.primary).unwrap());
            drop(playing);
            registry.release(&token).unwrap();
            assert!(!path.exists());
        }
    }

    #[test]
    fn compressed_audio_import_normalizes_to_the_same_capture_samples() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav_format(&source, 48_000, 2);
        let flac = root.0.join("speech.flac");
        encode_verified(&source, &flac, &|| true).unwrap();
        let imported = crate::prepare_audio_import(&flac, &root.0).unwrap();
        let wav_import = crate::prepare_audio_import(&source, &root.0).unwrap();
        let reader = hound::WavReader::open(&imported.plan.primary_path).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().channels, 1);
        assert!(same_pcm(&wav_import.plan.primary_path, &imported.plan.primary_path).unwrap());
    }

    #[test]
    fn pcm16_storage_roundtrips_and_keeps_pcm24_replay_compatible() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav_format(&source, 48_000, 1);
        let converted = resample_meeting(&source, &root.0, &|| true).unwrap();
        let flac = root.0.join("speech.flac");
        encode_verified(converted.path(), &flac, &|| true).unwrap();
        assert_eq!(flac_depth(&flac).unwrap(), 16);
        let decoded = decode_flac(&flac, &root.0).unwrap();
        assert!(same_pcm(converted.path(), decoded.path()).unwrap());
        let reference = crate::audio::utils::load_audio_file(&source).unwrap();
        let replay = crate::audio::utils::load_audio_file(decoded.path()).unwrap();
        assert_eq!(reference.len(), replay.len());
        verify_resampled(&source, decoded.path(), &|| true).unwrap();
        let mut reader = crate::audio::utils::AudioWindowReader::open(decoded.path()).unwrap();
        assert_eq!(reader.read_all_with(|| Ok(())).unwrap(), replay);
        // Keep older PCM24 experiment tracks readable beside shipped PCM16.
        // Both role orders must preserve the higher-depth track.
        let legacy = root.0.join("legacy.wav");
        let mut writer = hound::WavWriter::create(
            &legacy,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 24,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for sample in &replay {
            writer
                .write_sample((sample * 8_388_608.0).round() as i32)
                .unwrap();
        }
        writer.finalize().unwrap();
        for (a, b) in [
            (decoded.path(), legacy.as_path()),
            (legacy.as_path(), decoded.path()),
        ] {
            let mixed = recording_audio::rebuild_meeting_mix(a, b, &root.0, &[]).unwrap();
            let reader = hound::WavReader::open(mixed.path()).unwrap();
            assert_eq!(reader.spec().bits_per_sample, 24);
            assert_eq!(reader.duration() as usize, replay.len());
            let samples = crate::audio::utils::load_audio_file(mixed.path()).unwrap();
            for (sample, original) in samples.iter().zip(&replay) {
                assert!((sample - original * 1.4).abs() < 0.0001);
            }
        }
    }

    #[test]
    fn meeting_resampling_rejects_damage_and_filters_above_nyquist() {
        let root = Scratch::new();
        let source = root.0.join("wideband.wav");
        let mut writer = hound::WavWriter::create(
            &source,
            hound::WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for n in 0..96_017 {
            let t = f64::from(n) / 48_000.0;
            writer
                .write_sample(
                    (4000.0 * (t * 600.0 * std::f64::consts::TAU).sin()
                        + 4000.0 * (t * 12_000.0 * std::f64::consts::TAU).sin())
                        as i16,
                )
                .unwrap();
        }
        writer.finalize().unwrap();
        let resampled = resample_meeting(&source, &root.0, &|| true).unwrap();
        verify_resampled(&source, resampled.path(), &|| true).unwrap();
        let mut reader = hound::WavReader::open(resampled.path()).unwrap();
        assert_eq!(reader.duration(), 32_005);
        let samples: Vec<_> = reader.samples::<i32>().map(Result::unwrap).collect();
        let amplitude = |hz: f64| {
            let (mut re, mut im) = (0.0, 0.0);
            for (n, s) in samples.iter().enumerate().skip(160).take(31_680) {
                let phase = n as f64 * hz * std::f64::consts::TAU / 16_000.0;
                re += f64::from(*s) * phase.cos();
                im += f64::from(*s) * phase.sin();
            }
            (re * re + im * im).sqrt()
        };
        assert!(
            amplitude(4000.0) < amplitude(600.0) * 0.001,
            "12 kHz must not alias to 4 kHz"
        );
        let damaged = root.0.join("damaged.wav");
        let mut writer = hound::WavWriter::create(&damaged, reader.spec()).unwrap();
        for s in &samples {
            writer.write_sample(-*s).unwrap();
        }
        writer.finalize().unwrap();
        assert!(
            verify_resampled(&source, &damaged, &|| true).is_err(),
            "inverted in-band signal must fail"
        );
        let mut writer = hound::WavWriter::create(&damaged, reader.spec()).unwrap();
        for s in &samples[..samples.len() - 2] {
            writer.write_sample(*s).unwrap();
        }
        writer.finalize().unwrap();
        assert!(
            verify_resampled(&source, &damaged, &|| true).is_err(),
            "truncated frames must fail"
        );
    }

    #[test]
    #[ignore = "Requires explicit synthetic QA paths and output directory"]
    fn measure_recognition_resampler_storage_on_qa_inputs() {
        let inputs = std::env::var("PLAINSONG_AUDIO_STORAGE_QA_INPUTS").unwrap();
        let directory = PathBuf::from(std::env::var("PLAINSONG_AUDIO_STORAGE_QA_DIR").unwrap());
        std::fs::create_dir_all(&directory).unwrap();
        let inputs: Vec<PathBuf> = serde_json::from_slice(&std::fs::read(inputs).unwrap()).unwrap();
        let mut rows = Vec::new();
        for source in inputs {
            let name = source.file_stem().unwrap().to_str().unwrap();
            let wav = directory.join(format!("{name}-16k.wav"));
            let flac = directory.join(format!("{name}-16k.flac"));
            let converted = resample_meeting(&source, &directory, &|| true).unwrap();
            std::fs::rename(converted.path(), &wav).unwrap();
            let metadata = encode_verified(&wav, &flac, &|| true).unwrap();
            let decoded = decode_flac(&flac, &directory).unwrap();
            assert!(same_pcm(&wav, decoded.path()).unwrap());
            let decoded_path = directory.join(format!("{name}-decoded.wav"));
            std::fs::rename(decoded.path(), &decoded_path).unwrap();
            let mut reference =
                crate::audio::utils::AudioWindowReader::open_for_asr_storage(&source).unwrap();
            let asr_reference = crate::audio::utils::load_audio_file(&source).unwrap();
            let mut diar_reference = crate::audio::utils::AudioWindowReader::open(&source).unwrap();
            let diar_samples = diar_reference.read_all_with(|| Ok(())).unwrap();
            let asr_diar_differences = asr_reference
                .iter()
                .zip(&diar_samples)
                .filter(|(a, b)| a.to_bits() != b.to_bits())
                .count();
            let mut output = hound::WavReader::open(&wav).unwrap();
            let mut samples = output.samples::<i32>();
            let (mut differing, mut count, mut maximum_error) = (0_u64, 0_u64, 0.0_f32);
            while reference.has_more() {
                for sample in reference.next_window().unwrap() {
                    assert_eq!(
                        sample.to_bits(),
                        asr_reference[count as usize].to_bits(),
                        "bounded storage reader must equal shipping whole-file ASR reader"
                    );
                    let stored = samples.next().unwrap().unwrap() as f32 / MEETING_PCM_SCALE;
                    differing += u64::from(sample.to_bits() != stored.to_bits());
                    count += 1;
                    maximum_error = maximum_error.max((sample - stored).abs());
                }
            }
            let original = hound::WavReader::open(&source).unwrap();
            let seconds = f64::from(original.duration()) / f64::from(original.spec().sample_rate);
            rows.push(serde_json::json!({"name":name,"original":source,"stored":flac,"decoded":decoded_path,
                "seconds":seconds,"frames":count,"storedFlacBytes":metadata.plaintext_bytes,
                "quantizedPcmIdentical":true,"asrDiarizationFloatDifferences":asr_diar_differences,"floatSamplesDiffering":differing,"maximumFloatError":maximum_error}));
        }
        std::fs::write(
            directory.join("storage-results-rust.json"),
            serde_json::to_vec_pretty(&rows).unwrap(),
        )
        .unwrap();
    }

    #[test]
    #[ignore = "Requires explicit synthetic QA paths and output directory"]
    fn measure_first_pass_chunk_resampling_residual() {
        let inputs = std::env::var("PLAINSONG_AUDIO_STORAGE_QA_INPUTS").unwrap();
        let directory = PathBuf::from(std::env::var("PLAINSONG_AUDIO_STORAGE_QA_DIR").unwrap());
        let inputs: Vec<PathBuf> = serde_json::from_slice(&std::fs::read(inputs).unwrap()).unwrap();
        let mut rows = Vec::new();
        for source in inputs {
            let reader = hound::WavReader::open(&source).unwrap();
            let spec = reader.spec();
            let name = source.file_stem().unwrap().to_str().unwrap();
            let stored = crate::audio::utils::load_audio_file(
                &directory.join(format!("{name}-decoded.wav")),
            )
            .unwrap();
            let mut accumulated = Vec::new();
            let mut channels = Vec::new();
            let mut start = 0_usize;
            let mut chunks = Vec::new();
            let mut original = reader.into_samples::<i16>();
            loop {
                let next = original.next().transpose().unwrap();
                if let Some(sample) = next {
                    channels.push(f32::from(sample) / i16::MAX as f32);
                    if channels.len() < usize::from(spec.channels) {
                        continue;
                    }
                    accumulated.push(channels.iter().sum::<f32>() / f32::from(spec.channels));
                    channels.clear();
                }
                if accumulated.len() < spec.sample_rate as usize * 90 && next.is_some() {
                    continue;
                }
                if accumulated.is_empty() {
                    break;
                }
                let chunk = if next.is_some() {
                    crate::streaming_partials::take_vad_aligned_chunk(
                        &mut accumulated,
                        spec.sample_rate,
                    )
                } else {
                    std::mem::take(&mut accumulated)
                };
                let bytes =
                    crate::streaming_partials::mono_samples_to_wav_bytes(&chunk, spec.sample_rate)
                        .unwrap();
                let path = directory.join("chunk-residual.wav");
                std::fs::write(&path, bytes).unwrap();
                let first = crate::audio::utils::load_audio_file(&path).unwrap();
                std::fs::remove_file(&path).unwrap();
                let output_start = start * 16_000 / spec.sample_rate as usize;
                let replay = &stored[output_start..output_start + first.len()];
                let differing = first
                    .iter()
                    .zip(replay)
                    .filter(|(a, b)| a.to_bits() != b.to_bits())
                    .count();
                let over_quantization = first
                    .iter()
                    .zip(replay)
                    .filter(|(a, b)| (*a - *b).abs() > 1.0 / (2.0 * MEETING_PCM_SCALE))
                    .count();
                let max_error = first
                    .iter()
                    .zip(replay)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0_f32, f32::max);
                chunks.push(serde_json::json!({"startSeconds":start as f64 / f64::from(spec.sample_rate),"endSeconds":(start+chunk.len()) as f64/f64::from(spec.sample_rate),"firstPassSamples":first.len(),"differingSamples":differing,"samplesBeyondPcm24Bound":over_quantization,"maximumError":max_error}));
                start += chunk.len();
            }
            rows.push(serde_json::json!({"name":name,"chunks":chunks}));
        }
        std::fs::write(
            directory.join("chunk-residual.json"),
            serde_json::to_vec_pretty(&rows).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn finalized_wav_and_flac_meetings_keep_only_16k_sources_and_owned_runtime_mixes() {
        for native_flac in [false, true] {
            for encrypted in [false, true] {
                let root = Scratch::new();
                let path = root.0.join("meeting.db");
                let plan = recording_audio::RecordingCapturePlan::new(&root.0, true, true).unwrap();
                let now = chrono::Utc::now();
                let recording = serde_json::from_value(serde_json::json!({"id":plan.recording_id,"title":"Storage fixture","projectId":"inbox","duration":2,"createdAt":now,"updatedAt":now,"sourceType":"meeting","audioPath":plan.primary_path,"status":"completed"})).unwrap();
                let mut db = crate::db::Database::open_at_path(&path, None).unwrap();
                db.create_recording_with_audio_plan(&recording, &plan)
                    .unwrap();
                let mut updates = Vec::new();
                let key = [17; 32];
                let mut protected = Vec::new();
                for (role, path) in plan.paths() {
                    // A sine compresses unusually well at the native rate.
                    // Exercise successful migration with reproducible broadband audio.
                    let mut writer = hound::WavWriter::create(
                        path,
                        hound::WavSpec {
                            channels: 1,
                            sample_rate: 48_000,
                            bits_per_sample: 16,
                            sample_format: hound::SampleFormat::Int,
                        },
                    )
                    .unwrap();
                    let mut noise = 17_u32;
                    for _ in 0..96_017 {
                        noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        writer.write_sample((noise >> 16) as i16 / 4).unwrap();
                    }
                    writer.finalize().unwrap();
                    if native_flac {
                        let flac = path.with_extension("flac");
                        encode_verified(path, &flac, &|| true).unwrap();
                        std::fs::rename(flac, path).unwrap();
                    }
                    let RecordingAudioValidation::Ready(metadata) =
                        recording_audio::validate_plaintext_wav(path)
                    else {
                        panic!("fixture");
                    };
                    updates.push((role, RecordingAudioLifecycle::Ready, Some(metadata), None));
                    if encrypted {
                        let target = path.with_extension("wav.enc");
                        let mut output = std::fs::File::create(&target).unwrap();
                        crate::crypto::ProjectKeyManager::encrypt_stream(
                            &mut std::fs::File::open(path).unwrap(),
                            &mut output,
                            &key,
                            |_| {},
                        )
                        .unwrap();
                        protected.push((role, target));
                    }
                }
                db.set_audio_asset_validation_states(&plan.recording_id, &updates, "completed")
                    .unwrap();
                if encrypted {
                    db.switch_recording_audio_protection(
                        &plan.recording_id,
                        &protected
                            .iter()
                            .map(|(r, p)| (*r, p.as_path()))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                    for (_, path) in plan.paths() {
                        std::fs::remove_file(path).unwrap();
                    }
                }
                let transcript = serde_json::from_value(serde_json::json!({"id":"transcript","recordingId":plan.recording_id,"fullText":"Both voices remain.","segments":[],"language":"en","confidence":1.0,"model":"fixture","createdAt":now})).unwrap();
                db.save_transcript(&transcript).unwrap();
                db.complete_recording_with_transcript_state(
                    &plan.recording_id,
                    "completed",
                    true,
                    None,
                )
                .unwrap();
                db.set_meeting_audio_finalized(&plan.recording_id, true)
                    .unwrap();
                let bundle = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
                let mut saved = 0;
                for asset in bundle
                    .assets()
                    .filter(|a| a.role != RecordingAudioRole::Primary)
                {
                    let job = db.begin_audio_compression(asset).unwrap();
                    let metadata = prepare_compressed_asset(
                        asset,
                        &job,
                        encrypted.then_some(&key),
                        &root.0,
                        std::slice::from_ref(&root.0),
                        &|| true,
                        true,
                    )
                    .unwrap();
                    let delta = std::fs::metadata(&job.source).unwrap().len()
                        - std::fs::metadata(&job.target).unwrap().len();
                    saved += delta;
                    db.commit_audio_compression(&job, &metadata, delta).unwrap();
                    drop(db);
                    db = crate::db::Database::open_at_path(&path, None).unwrap();
                    std::fs::remove_file(&job.source).unwrap();
                    db.finish_audio_compression(&job).unwrap();
                }
                let bundle = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
                let old_mix = bundle.primary.as_ref().unwrap().path.clone();
                let mix_bytes = std::fs::metadata(&old_mix).unwrap().len();
                let job = db.retire_meeting_mix(&bundle).unwrap();
                drop(db);
                db = crate::db::Database::open_at_path(&path, None).unwrap();
                assert!(old_mix.exists(), "journal must own mix across restart");
                let bundle = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
                assert!(bundle.primary.is_none());
                assert_eq!(bundle.assets().count(), 2);
                assert!(verified_meeting_sources(
                    &bundle,
                    encrypted.then_some(&key),
                    &root.0,
                    std::slice::from_ref(&root.0)
                )
                .unwrap());
                let mic_path = &bundle.mic.as_ref().unwrap().path;
                let original_mic = std::fs::read(mic_path).unwrap();
                let mut corrupt = original_mic.clone();
                *corrupt.last_mut().unwrap() ^= 1;
                std::fs::write(mic_path, corrupt).unwrap();
                assert!(verified_meeting_sources(
                    &bundle,
                    encrypted.then_some(&key),
                    &root.0,
                    std::slice::from_ref(&root.0)
                )
                .is_err());
                assert!(
                    old_mix.exists(),
                    "A resumed mix cleanup must keep the fallback if either source is corrupt"
                );
                std::fs::write(mic_path, original_mic).unwrap();
                assert_eq!(db.compression_jobs_for_bundle(&bundle).unwrap().len(), 1);
                assert!(db
                    .compression_paths_for_recording(&plan.recording_id)
                    .unwrap()
                    .contains(&old_mix));
                assert_eq!(
                    db.backfill_legacy_recording_audio(std::slice::from_ref(&root.0))
                        .unwrap(),
                    0
                );
                assert!(db.compression_source_unchanged(&job).unwrap());
                for mode in [
                    crate::RuntimeAudioResolveMode::Full,
                    crate::RuntimeAudioResolveMode::PlaybackPrimary,
                ] {
                    let resolved = crate::resolve_recording_audio_bundle_in_directory(
                        &bundle,
                        encrypted.then_some(&key),
                        &root.0,
                        std::slice::from_ref(&root.0),
                        mode,
                        &[],
                    )
                    .unwrap();
                    let reader = hound::WavReader::open(&resolved.primary).unwrap();
                    assert_eq!(reader.spec().sample_rate, 16_000);
                    assert_eq!(reader.duration(), 32_005);
                    assert!(!crate::audio::utils::load_audio_file(&resolved.primary)
                        .unwrap()
                        .is_empty());
                    let mut windows =
                        crate::audio::utils::AudioWindowReader::open(&resolved.primary).unwrap();
                    assert!(!windows.next_window().unwrap().is_empty());
                    assert!(!crate::audio::waveform::generate_waveform_from_file(
                        resolved.primary.to_str().unwrap(),
                        20
                    )
                    .unwrap()
                    .samples
                    .is_empty());
                    let mixed = resolved.primary.clone();
                    drop(resolved);
                    assert!(
                        !mixed.exists(),
                        "runtime mix must be removed with its owner"
                    );
                }
                std::fs::remove_file(&old_mix).unwrap();
                db.finish_audio_compression(&job).unwrap();
                db.finish_audio_compression(&job).unwrap();
                assert_eq!(db.compression_bytes_saved().unwrap(), saved + mix_bytes);
                assert_eq!(
                    db.get_transcript(&plan.recording_id)
                        .unwrap()
                        .unwrap()
                        .full_text,
                    "Both voices remain."
                );
                let deletion = crate::remove_owned_recording_audio_in_roots(
                    &bundle,
                    "16 kHz fixture cleanup",
                    std::slice::from_ref(&root.0),
                );
                assert!(deletion.failures.is_empty());
                db.delete_recording_audio_assets(&plan.recording_id, &deletion.cleared_roles)
                    .unwrap();
                assert!(db
                    .get_recording(&plan.recording_id)
                    .unwrap()
                    .unwrap()
                    .audio_path
                    .is_empty());
            }
        }
    }

    #[test]
    fn existing_48khz_meeting_migrates_through_resumed_journal() {
        let root = Scratch::new();
        let db_path = root.0.join("meeting.db");
        let plan = recording_audio::RecordingCapturePlan::new(&root.0, true, true).unwrap();
        let now = chrono::Utc::now();
        let recording = serde_json::from_value(serde_json::json!({
            "id": plan.recording_id, "title": "48 kHz meeting", "projectId": "inbox",
            "duration": 2, "createdAt": now, "updatedAt": now,
            "sourceType": "meeting", "audioPath": plan.primary_path, "status": "completed"
        }))
        .unwrap();
        let mut db = crate::db::Database::open_at_path(&db_path, None).unwrap();
        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();
        let mut updates = Vec::new();
        for (role, path) in plan.paths() {
            wav_format(path, 48_000, 1);
            let RecordingAudioValidation::Ready(metadata) =
                recording_audio::validate_plaintext_wav(path)
            else {
                panic!("meeting WAV");
            };
            updates.push((role, RecordingAudioLifecycle::Ready, Some(metadata), None));
        }
        db.set_audio_asset_validation_states(&plan.recording_id, &updates, "completed")
            .unwrap();
        db.complete_recording_with_transcript_state(&plan.recording_id, "completed", true, None)
            .unwrap();
        let transcript = serde_json::from_value(serde_json::json!({"id":"early-t","recordingId":plan.recording_id,"fullText":"Fixture","segments":[],"language":"en","confidence":1.0,"model":"fixture","createdAt":now})).unwrap();
        db.save_transcript(&transcript).unwrap();
        db.set_meeting_audio_finalized(&plan.recording_id, true)
            .unwrap();
        let bundle = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
        let mut total_saved = 0;
        for asset in bundle.assets() {
            let job = db.begin_audio_compression(asset).unwrap();
            // A failed old-rate attempt leaves the same retryable journal.
            db.defer_audio_compression(&job).unwrap();
            db.end_compression_attempt(&job, std::slice::from_ref(&root.0))
                .unwrap();
            drop(db);
            db = crate::db::Database::open_at_path(&db_path, None).unwrap();
            let resumed = db.compression_job(asset).unwrap();
            assert_eq!(resumed.id, job.id);
            assert!(!resumed.committed);
            let metadata = prepare_compressed_asset(
                asset,
                &resumed,
                None,
                &root.0,
                std::slice::from_ref(&root.0),
                &|| true,
                false,
            )
            .unwrap();
            let saved = std::fs::metadata(&job.source).unwrap().len() - metadata.plaintext_bytes;
            total_saved += saved;
            assert!(db.compression_source_unchanged(&resumed).unwrap());
            db.commit_audio_compression(&resumed, &metadata, saved)
                .unwrap();
            assert!(job.source.exists());
            drop(db);
            db = crate::db::Database::open_at_path(&db_path, None).unwrap();
            let published = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
            let current = published.assets().find(|a| a.role == asset.role).unwrap();
            let committed = db.compression_job(current).unwrap();
            assert!(committed.committed);
            assert_eq!(validate_flac(&committed.target).unwrap(), metadata);
            let decoded = decode_flac(&committed.target, &root.0).unwrap();
            assert!(same_pcm(&job.source, decoded.path()).unwrap());
            std::fs::remove_file(&committed.source).unwrap();
            db.finish_audio_compression(&committed).unwrap();
            db.finish_audio_compression(&committed).unwrap();
        }
        assert_eq!(db.compression_bytes_saved().unwrap(), total_saved);
        assert!(!db
            .has_pending_audio_compression(&plan.recording_id)
            .unwrap());
        let bundle = db.load_recording_audio_bundle(&plan.recording_id).unwrap();
        assert_eq!(bundle.assets().count(), 3);
        let recording = db.get_recording(&plan.recording_id).unwrap().unwrap();
        assert_eq!(
            recording.audio_path,
            bundle.primary.unwrap().path.to_string_lossy()
        );
        let transcript = serde_json::from_value(serde_json::json!({
            "id": "transcript", "recordingId": plan.recording_id,
            "fullText": "Keep all 48 kHz samples.", "language": "en",
            "confidence": 1.0, "model": "fixture", "createdAt": now,
            "segments": [{"id": "turn", "startTime": 0.0, "endTime": 2.0,
                "text": "Keep all 48 kHz samples.", "confidence": 1.0}]
        }))
        .unwrap();
        use crate::export::{encode_export, export_recording, ExportContext, ExportFormat};
        for format in [
            ExportFormat::Markdown,
            ExportFormat::Text,
            ExportFormat::Json,
            ExportFormat::Srt,
            ExportFormat::Vtt,
            ExportFormat::Docx,
        ] {
            let exported = export_recording(
                &recording,
                Some(&transcript),
                format,
                false,
                &ExportContext::default(),
            )
            .unwrap();
            assert!(exported.contains("Keep all 48 kHz samples."));
            assert!(!encode_export(format, &exported).unwrap().is_empty());
        }
    }

    #[test]
    fn encrypted_compression_authenticates_and_resolves_for_playback_and_processing() {
        let root = Scratch::new();
        let source = root.0.join("speech.wav");
        wav_format(&source, 48_000, 2);
        let mut encrypted = asset(&source);
        let key = [9; 32];
        let encrypted_source = root.0.join("speech.wav.enc");
        crate::crypto::ProjectKeyManager::encrypt_stream(
            &mut std::fs::File::open(&source).unwrap(),
            &mut recording_audio::create_new_file(&encrypted_source).unwrap(),
            &key,
            |_| {},
        )
        .unwrap();
        encrypted.path = encrypted_source.clone();
        encrypted.protection = RecordingAudioProtection::Encrypted;
        let target = root.0.join("speech.flac.enc");
        let job = CompressionJob {
            id: 1,
            recording_id: encrypted.recording_id.clone(),
            role: encrypted.role,
            source: encrypted_source,
            target: target.clone(),
            committed: false,
        };
        let metadata = prepare_compressed_asset(
            &encrypted,
            &job,
            Some(&key),
            &root.0,
            std::slice::from_ref(&root.0),
            &|| true,
            false,
        )
        .unwrap();
        let mut bundle = recording_audio::RecordingAudioBundle::empty("compression");
        bundle
            .insert(RecordingAudioAsset {
                path: target,
                plaintext_bytes: Some(metadata.plaintext_bytes),
                plaintext_sha256: Some(metadata.plaintext_sha256),
                ..encrypted
            })
            .unwrap();
        for mode in [
            crate::RuntimeAudioResolveMode::Full,
            crate::RuntimeAudioResolveMode::PlaybackPrimary,
        ] {
            let resolved = crate::resolve_recording_audio_bundle_in_directory(
                &bundle,
                Some(&key),
                &root.0,
                std::slice::from_ref(&root.0),
                mode,
                &[],
            )
            .unwrap();
            assert!(same_pcm(&source, &resolved.primary).unwrap());
        }
        assert!(crate::resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&[8; 32]),
            &root.0,
            std::slice::from_ref(&root.0),
            crate::RuntimeAudioResolveMode::Full,
            &[]
        )
        .is_err());
    }
}
