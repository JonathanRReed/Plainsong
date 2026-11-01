//! Canonical ownership and durability helpers for recording audio bundles.
//!
//! Renderer-facing [`crate::models::Recording`] values continue to expose only
//! `audio_path`. Internally, a recording owns at most three assets: `primary`
//! (mixed audio, or the sole microphone track), `mic`, and `system`. Finalized
//! source-track meetings omit `primary`; readers rebuild it from the sources.

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

/// Rebuild a source-track meeting without holding its duration in memory.
/// Estimate speech loudness in 20 ms windows so a long quiet track does not
/// amplify background noise. Bound gain and reserve shared peak headroom.
pub(crate) fn rebuild_meeting_mix(
    mic: &Path,
    system: &Path,
    directory: &Path,
    aside_spans: &[crate::meeting_asides::AsideSpan],
) -> Result<DurableTempFile> {
    // TODO(meeting-asides): keep masking before both level measurement and mixing
    // whenever source decoding or gain calculation changes. The call stays audible.
    fn masked(frame: usize, ranges: &mut &[std::ops::Range<u64>]) -> bool {
        let frame = frame as u64;
        while ranges.first().is_some_and(|range| range.end <= frame) {
            *ranges = &ranges[1..];
        }
        ranges.first().is_some_and(|range| range.contains(&frame))
    }
    fn levels(path: &Path, mut ranges: &[std::ops::Range<u64>]) -> Result<(f64, f64)> {
        let mut reader = hound::WavReader::open(path)?;
        let (mut energy, mut count, mut peak) = (0.0_f64, 0_u64, 0.0_f64);
        let (mut window, mut frames) = (0.0_f64, 0_u32);
        let scale = (1_u64 << (reader.spec().bits_per_sample - 1)) as f64;
        for (frame, sample) in reader.samples::<i32>().enumerate() {
            let sample = sample?;
            let sample = if masked(frame, &mut ranges) {
                0.0
            } else {
                f64::from(sample) / scale
            };
            peak = peak.max(sample.abs());
            window += sample * sample;
            frames += 1;
            if frames == 320 {
                if window / f64::from(frames) >= 0.0001 {
                    energy += window;
                    count += u64::from(frames);
                }
                window = 0.0;
                frames = 0;
            }
        }
        if frames > 0 && window / f64::from(frames) >= 0.0001 {
            energy += window;
            count += u64::from(frames);
        }
        Ok((
            if count == 0 {
                0.0
            } else {
                (energy / count as f64).sqrt()
            },
            peak,
        ))
    }
    let mut a = hound::WavReader::open(mic)?;
    let mut b = hound::WavReader::open(system)?;
    anyhow::ensure!(
        [a.spec(), b.spec()].iter().all(|spec| {
            spec.sample_rate == 16_000
                && spec.channels == 1
                && matches!(spec.bits_per_sample, 16 | 24)
                && spec.sample_format == hound::SampleFormat::Int
        }) && a.duration() == b.duration(),
        "Meeting source tracks are not aligned 16 kHz mono PCM16/PCM24"
    );
    let output_spec = hound::WavSpec {
        bits_per_sample: a.spec().bits_per_sample.max(b.spec().bits_per_sample),
        ..a.spec()
    };
    let needed = u64::from(a.duration())
        .saturating_mul(u64::from(output_spec.bits_per_sample / 8))
        .saturating_add(64 * 1024 * 1024);
    anyhow::ensure!(
        crate::download::available_space_for_path(directory)? >= needed,
        "Not enough free space to rebuild meeting audio"
    );
    let aside_ranges = crate::meeting_asides::aside_frame_ranges(
        aside_spans,
        a.spec().sample_rate,
        u64::from(a.duration()),
    );
    let (al, ap) = levels(mic, &aside_ranges)?;
    let (bl, bp) = levels(system, &[])?;
    let target = al.max(bl).min(0.12);
    let ag = if al > 0.0 {
        (target / al).clamp(0.25, 4.0)
    } else {
        1.0
    };
    let bg = if bl > 0.0 {
        (target / bl).clamp(0.25, 4.0)
    } else {
        1.0
    };
    let headroom = (0.98 / (ap * ag + bp * bg).max(0.98)).min(0.7);
    let path = directory.join(format!(
        ".decode-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let (file, guard) = create_secure_temporary_audio(&path)?;
    let mut writer = hound::WavWriter::new(std::io::BufWriter::new(file), output_spec)?;
    let scale = (1_i64 << (output_spec.bits_per_sample - 1)) as f64;
    let a_scale = scale / (1_i64 << (a.spec().bits_per_sample - 1)) as f64;
    let b_scale = scale / (1_i64 << (b.spec().bits_per_sample - 1)) as f64;
    let mut remaining_asides = aside_ranges.as_slice();
    for (frame, (a, b)) in a.samples::<i32>().zip(b.samples::<i32>()).enumerate() {
        let a = a?;
        let a = if masked(frame, &mut remaining_asides) {
            0
        } else {
            a
        };
        let mixed = (f64::from(a) * ag * a_scale + f64::from(b?) * bg * b_scale) * headroom;
        writer.write_sample(mixed.round().clamp(-scale, scale - 1.0) as i32)?;
    }
    writer.finalize()?;
    Ok(guard)
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
pub(crate) struct ResolvedRecordingAudioBundle {
    pub primary: PathBuf,
    pub mic: Option<PathBuf>,
    pub system: Option<PathBuf>,
    _temporary_files: Vec<DurableTempFile>,
    _runtime_lease: Option<crate::operation_coordinator::OperationLease>,
}

impl std::fmt::Debug for ResolvedRecordingAudioBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedRecordingAudioBundle")
            .field("primary", &self.primary)
            .field("mic", &self.mic)
            .field("system", &self.system)
            .finish_non_exhaustive()
    }
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
            _runtime_lease: None,
        }
    }

    pub(crate) fn with_runtime_lease(
        mut self,
        lease: crate::operation_coordinator::OperationLease,
    ) -> Self {
        self._runtime_lease = Some(lease);
        self
    }

    pub(crate) fn with_source_snapshots(mut self, owners: Vec<DurableTempFile>) -> Self {
        self._temporary_files.extend(owners);
        self
    }

    /// True when runtime audio copies are deleted with this bundle.
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

    pub(crate) fn path(&self) -> &Path {
        &self.path
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

    if crate::audio_compression::is_flac(path) {
        return match crate::audio_compression::validate_flac(path) {
            Ok(metadata) => RecordingAudioValidation::Ready(metadata),
            Err(error) => {
                RecordingAudioValidation::Failed(format!("Invalid compressed audio: {error:#}"))
            }
        };
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
    if let Some(error) = reader.samples::<i32>().find_map(Result::err) {
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

/// Length of a WAV this process just wrote from an authenticated ciphertext,
/// after checking that its header parses and that it carries audio frames.
///
/// Deliberately cheaper than `validate_plaintext_wav`: it does not decode
/// every sample. Playback separately hashes the file to bind authenticated
/// ciphertext to the recording metadata, without paying for a full decode.
/// Every other caller, and every unauthenticated plaintext file, still gets
/// the full validation.
pub(crate) fn measure_plaintext_wav_header(path: &Path) -> Result<u64> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("Could not inspect audio file '{}'", path.display()))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("Decrypted audio path is not a regular file");
    }
    let reader = hound::WavReader::open(path)
        .with_context(|| format!("Decrypted audio '{}' is not a readable WAV", path.display()))?;
    let spec = reader.spec();
    if reader.duration() == 0 || spec.sample_rate == 0 {
        anyhow::bail!("Decrypted audio file contains zero audio frames");
    }
    Ok(metadata.len())
}

/// What [`repair_plaintext_wav_header`] did to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WavHeaderRepair {
    /// The header already described the audio on disk, or the file is not one
    /// this repair may touch.
    Unchanged,
    /// The RIFF and data sizes were rewritten to cover this many audio bytes.
    Repaired { data_bytes: u32 },
}

/// The fields of a PCM WAV header a size repair needs.
struct WavHeaderLayout {
    riff_size: u32,
    block_align: u64,
    data_size_offset: u64,
    data_offset: u64,
    declared_data_bytes: u32,
}

const WAV_HEADER_MAX_CHUNKS: usize = 64;

fn read_wav_chunk_header(file: &mut File, offset: u64) -> Result<Option<([u8; 4], u32)>> {
    use std::io::{Seek, SeekFrom};
    let mut header = [0_u8; 8];
    file.seek(SeekFrom::Start(offset))?;
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut id = [0_u8; 4];
    id.copy_from_slice(&header[..4]);
    Ok(Some((
        id,
        u32::from_le_bytes([header[4], header[5], header[6], header[7]]),
    )))
}

fn read_wav_header_layout(file: &mut File, file_len: u64) -> Result<Option<WavHeaderLayout>> {
    use std::io::{Seek, SeekFrom};
    let mut riff = [0_u8; 12];
    file.seek(SeekFrom::Start(0))?;
    if file_len < 12 || file.read_exact(&mut riff).is_err() {
        return Ok(None);
    }
    if &riff[..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Ok(None);
    }
    let riff_size = u32::from_le_bytes([riff[4], riff[5], riff[6], riff[7]]);
    let mut offset = 12_u64;
    let mut block_align = None;
    for _ in 0..WAV_HEADER_MAX_CHUNKS {
        let Some((id, size)) = read_wav_chunk_header(file, offset)? else {
            return Ok(None);
        };
        if &id == b"data" {
            let Some(block_align) = block_align.filter(|align| *align > 0) else {
                return Ok(None);
            };
            return Ok(Some(WavHeaderLayout {
                riff_size,
                block_align,
                data_size_offset: offset + 4,
                data_offset: offset + 8,
                declared_data_bytes: size,
            }));
        }
        if &id == b"fmt " {
            if size < 16 {
                return Ok(None);
            }
            let mut fmt = [0_u8; 16];
            if file.read_exact(&mut fmt).is_err() {
                return Ok(None);
            }
            block_align = Some(u64::from(u16::from_le_bytes([fmt[12], fmt[13]])));
        }
        offset = offset + 8 + u64::from(size) + u64::from(size & 1);
        if offset >= file_len {
            return Ok(None);
        }
    }
    Ok(None)
}

/// True when the bytes after a declared data chunk are themselves a run of
/// well-formed chunks ending exactly at end of file, such as a `LIST` tag
/// another tool appended. Those are not lost audio and must not be adopted.
fn trailing_bytes_are_wav_chunks(file: &mut File, mut offset: u64, file_len: u64) -> Result<bool> {
    for _ in 0..WAV_HEADER_MAX_CHUNKS {
        if offset == file_len {
            return Ok(true);
        }
        let Some((id, size)) = read_wav_chunk_header(file, offset)? else {
            return Ok(false);
        };
        if !id
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b' ')
        {
            return Ok(false);
        }
        offset = offset + 8 + u64::from(size) + u64::from(size & 1);
        if offset > file_len {
            return Ok(false);
        }
    }
    Ok(false)
}

/// Rewrite a PCM WAV's RIFF and data sizes from the bytes actually on disk.
///
/// A meeting writer stamps the header only at its checkpoints. A crash before
/// the first one leaves a file whose `data` chunk declares zero bytes over
/// audio that did reach the disk, and a crash between checkpoints hides
/// everything written since the last one. Both read as empty or short, so the
/// audio cannot be recovered even though it is there. This adopts every whole
/// frame after the data chunk start, and trims a header that claims more than
/// the file holds.
///
/// Callers must own the file and know no writer is still appending to it:
/// startup reconciliation, an explicit re-check, or a stop whose writer thread
/// has already finished. A file that does not parse as RIFF/WAVE with `fmt `
/// before `data`, or that has well-formed chunks after its declared data, is
/// left alone.
pub(crate) fn repair_plaintext_wav_header(path: &Path) -> Result<WavHeaderRepair> {
    use std::io::{Seek, SeekFrom, Write};
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WavHeaderRepair::Unchanged)
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not inspect audio file '{}'", path.display()))
        }
    };
    if !metadata.file_type().is_file() {
        return Ok(WavHeaderRepair::Unchanged);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("Could not open audio file '{}'", path.display()))?;
    let file_len = file.metadata()?.len();
    let Some(layout) = read_wav_header_layout(&mut file, file_len)? else {
        return Ok(WavHeaderRepair::Unchanged);
    };
    let available = file_len.saturating_sub(layout.data_offset);
    let declared = u64::from(layout.declared_data_bytes);
    if declared < available {
        let declared_end = layout.data_offset + declared + (declared & 1);
        if declared > 0 && trailing_bytes_are_wav_chunks(&mut file, declared_end, file_len)? {
            return Ok(WavHeaderRepair::Unchanged);
        }
    }
    let header_bytes = layout.data_offset - 8;
    let largest = u64::from(u32::MAX).saturating_sub(header_bytes);
    let usable = available.min(largest);
    let usable = usable - usable % layout.block_align;
    let riff_size = header_bytes + usable;
    if usable == declared && riff_size == u64::from(layout.riff_size) {
        return Ok(WavHeaderRepair::Unchanged);
    }
    let data_bytes = u32::try_from(usable).context("Repaired WAV data size overflows")?;
    let riff_size = u32::try_from(riff_size).context("Repaired RIFF size overflows")?;
    file.seek(SeekFrom::Start(4))?;
    file.write_all(&riff_size.to_le_bytes())?;
    file.seek(SeekFrom::Start(layout.data_size_offset))?;
    file.write_all(&data_bytes.to_le_bytes())?;
    file.sync_all()
        .with_context(|| format!("Could not sync repaired audio '{}'", path.display()))?;
    Ok(WavHeaderRepair::Repaired { data_bytes })
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

pub(crate) fn create_secure_temporary_audio(path: &Path) -> Result<(File, DurableTempFile)> {
    let file = create_new_file(path)?;
    Ok((file, DurableTempFile::new(path.to_path_buf())))
}

pub(crate) fn write_secure_temporary_audio(
    path: &Path,
    audio_data: &[u8],
) -> Result<DurableTempFile> {
    use std::io::Write;

    let (mut file, guard) = create_secure_temporary_audio(path)?;
    file.write_all(audio_data)
        .with_context(|| format!("Failed to write temporary audio '{}'", path.display()))?;
    Ok(guard)
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
    fn rebuilt_mix_balances_both_voices_without_clipping_and_removes_its_temporary() {
        let root = crate::test_fs::TempDir::new("meeting-mix");
        let mic = root.path().join("mic.wav");
        let call = root.path().join("call.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        for (path, amplitude, first) in [(&mic, 2000.0, true), (&call, 8000.0, false)] {
            let mut writer = hound::WavWriter::create(path, spec).unwrap();
            for n in 0..32_000 {
                let sample = if (n < 16_000) == first {
                    ((f64::from(n) * std::f64::consts::TAU * 500.0 / 16_000.0).sin() * amplitude)
                        as i16
                } else {
                    0
                };
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        let mix = rebuild_meeting_mix(&mic, &call, root.path(), &[]).unwrap();
        let mut reader = hound::WavReader::open(mix.path()).unwrap();
        assert_eq!(reader.duration(), 32_000);
        let samples: Vec<_> = reader.samples::<i16>().map(Result::unwrap).collect();
        let energy = |slice: &[i16]| slice.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
        assert!((energy(&samples[..16_000]) / energy(&samples[16_000..]) - 1.0).abs() < 0.01);
        assert!(samples.iter().all(|s| s.unsigned_abs() < 32_000));
        let path = mix.path().to_owned();
        drop(mix);
        assert!(!path.exists());
        let mut short = hound::WavWriter::create(&call, spec).unwrap();
        short.write_sample(12_i16).unwrap();
        short.finalize().unwrap();
        assert!(rebuild_meeting_mix(&mic, &call, root.path(), &[]).is_err());
    }

    #[test]
    fn rebuilt_mix_masks_mic_asides_before_levels_and_keeps_the_call() {
        let root = crate::test_fs::TempDir::new("meeting-mix-asides");
        let mic = root.path().join("mic.wav");
        let masked_mic = root.path().join("masked-mic.wav");
        let call = root.path().join("call.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        for (path, is_mic, masked) in [
            (&mic, true, false),
            (&masked_mic, true, true),
            (&call, false, false),
        ] {
            let mut writer = hound::WavWriter::create(path, spec).unwrap();
            for frame in 0..32_000 {
                let value: i16 = if is_mic && (16_000..24_000).contains(&frame) {
                    if masked {
                        0
                    } else {
                        30_000
                    }
                } else if is_mic {
                    1_000
                } else {
                    2_000
                };
                writer.write_sample(value).unwrap();
            }
            writer.finalize().unwrap();
        }
        // Span timing comes from native 48 kHz capture, not compact storage.
        let spans = [crate::meeting_asides::AsideSpan {
            aside_id: "aside".into(),
            dictation_session_id: 1,
            sample_rate: 48_000,
            start_frame: 48_000,
            end_frame: Some(72_000),
            started_at_ms: 0,
            ended_at_ms: Some(1_000),
            paused_frames: 0,
        }];
        let expected = rebuild_meeting_mix(&masked_mic, &call, root.path(), &[]).unwrap();
        let samples = |path: &Path| {
            hound::WavReader::open(path)
                .unwrap()
                .samples::<i16>()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let mut bundle = RecordingAudioBundle::empty("aside-meeting");
        for (role, path) in [
            (RecordingAudioRole::Mic, &mic),
            (RecordingAudioRole::System, &call),
        ] {
            let metadata = match validate_plaintext_wav(path) {
                RecordingAudioValidation::Ready(metadata) => metadata,
                other => panic!("invalid fixture: {other:?}"),
            };
            bundle
                .insert(RecordingAudioAsset {
                    recording_id: bundle.recording_id.clone(),
                    role,
                    path: path.clone(),
                    lifecycle: RecordingAudioLifecycle::Ready,
                    protection: RecordingAudioProtection::Plaintext,
                    plaintext_bytes: Some(metadata.plaintext_bytes),
                    plaintext_sha256: Some(metadata.plaintext_sha256),
                    last_error: None,
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
                root.path(),
                &[root.path().to_owned()],
                mode,
                &spans,
            )
            .unwrap();
            assert_eq!(
                samples(&resolved.primary),
                samples(expected.path()),
                "aside energy must not affect gains or headroom in either resolution mode"
            );
        }
        let actual = samples(expected.path());
        assert!(
            actual[16_000..24_000].iter().all(|sample| *sample > 0),
            "the call remains audible during the aside"
        );
        assert!(
            samples(&mic)[16_000..24_000]
                .iter()
                .all(|sample| *sample == 30_000),
            "raw mic remains available for separate aside recovery"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secure_temporary_audio_is_owner_only_and_removed_on_drop() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "plainsong-secure-temp-audio-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let (_file, guard) = create_secure_temporary_audio(&path).expect("create secure audio");
        assert_eq!(
            std::fs::metadata(&path)
                .expect("temporary audio metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn secure_temporary_audio_rejects_preexisting_path() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-secure-temp-audio-existing-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"keep").expect("seed existing file");
        assert!(create_secure_temporary_audio(&path).is_err());
        assert_eq!(std::fs::read(&path).expect("read existing file"), b"keep");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn secure_temporary_audio_cleans_up_when_work_fails() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-secure-temp-audio-failure-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let result: Result<()> = (|| {
            let (_file, _guard) = create_secure_temporary_audio(&path)?;
            anyhow::bail!("injected transcription failure")
        })();
        assert!(result.is_err());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn secure_temporary_audio_supports_wav_writer_without_loosening_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "plainsong-secure-temp-writer-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let (file, guard) = create_secure_temporary_audio(&path).expect("create secure audio");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(file, spec).expect("create WAV writer");
        writer.write_sample(0_i16).expect("write WAV sample");
        writer.finalize().expect("finalize WAV");
        assert_eq!(
            std::fs::metadata(&path)
                .expect("temporary WAV metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(guard);
        assert!(!path.exists());
    }

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

    /// A 16 kHz mono WAV of `samples` frames, as a finished meeting writer
    /// leaves it.
    fn finished_wav(path: &Path, samples: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create WAV");
        for index in 0..samples {
            writer
                .write_sample(((index % 200) as i16 - 100) * 50)
                .expect("write sample");
        }
        writer.finalize().expect("finalize WAV");
    }

    /// Overwrite the RIFF and data sizes, as a writer that never reached a
    /// checkpoint (both zero) or reached an earlier one leaves them.
    fn stamp_sizes(path: &Path, riff_size: u32, data_size: u32) {
        let mut bytes = std::fs::read(path).expect("read WAV");
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        bytes[40..44].copy_from_slice(&data_size.to_le_bytes());
        std::fs::write(path, bytes).expect("write WAV");
    }

    #[test]
    fn a_meeting_wav_that_crashed_before_its_first_checkpoint_is_recovered() {
        let dir = crate::test_fs::TempDir::new("wav-repair-zero");
        let path = dir.path().join("meeting.wav");
        finished_wav(&path, 48_000);
        stamp_sizes(&path, 0, 0);
        assert!(
            matches!(
                validate_plaintext_wav(&path),
                RecordingAudioValidation::Missing(_)
            ),
            "the zero-length header hides the audio before repair"
        );

        assert_eq!(
            repair_plaintext_wav_header(&path).unwrap(),
            WavHeaderRepair::Repaired { data_bytes: 96_000 }
        );
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&path) else {
            panic!("repaired audio validates");
        };
        assert_eq!(metadata.duration_seconds, 3);
        assert_eq!(
            hound::WavReader::open(&path).unwrap().duration(),
            48_000,
            "every frame that reached the disk is readable again"
        );
        assert_eq!(
            repair_plaintext_wav_header(&path).unwrap(),
            WavHeaderRepair::Unchanged,
            "a repaired header is left alone the second time"
        );
    }

    #[test]
    fn audio_written_after_the_last_checkpoint_is_adopted_in_whole_frames() {
        let dir = crate::test_fs::TempDir::new("wav-repair-stale");
        let path = dir.path().join("meeting.wav");
        finished_wav(&path, 32_000);
        // The last checkpoint saw one second; a crash then cut a frame in half.
        stamp_sizes(&path, 36 + 32_000, 32_000);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.push(0x7f);
        std::fs::write(&path, bytes).unwrap();

        assert_eq!(
            repair_plaintext_wav_header(&path).unwrap(),
            WavHeaderRepair::Repaired { data_bytes: 64_000 }
        );
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.duration(), 32_000);
    }

    #[test]
    fn a_header_claiming_more_than_the_file_holds_is_trimmed_to_what_is_there() {
        let dir = crate::test_fs::TempDir::new("wav-repair-short");
        let path = dir.path().join("meeting.wav");
        finished_wav(&path, 16_000);
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 1_001]).unwrap();
        assert!(matches!(
            validate_plaintext_wav(&path),
            RecordingAudioValidation::Failed(_)
        ));

        assert_eq!(
            repair_plaintext_wav_header(&path).unwrap(),
            WavHeaderRepair::Repaired { data_bytes: 30_998 }
        );
        assert!(matches!(
            validate_plaintext_wav(&path),
            RecordingAudioValidation::Ready(_)
        ));
    }

    #[test]
    fn header_repair_leaves_finished_tagged_and_foreign_files_alone() {
        let dir = crate::test_fs::TempDir::new("wav-repair-noop");
        let finished = dir.path().join("finished.wav");
        finished_wav(&finished, 8_000);
        let before = std::fs::read(&finished).unwrap();
        assert_eq!(
            repair_plaintext_wav_header(&finished).unwrap(),
            WavHeaderRepair::Unchanged
        );
        assert_eq!(std::fs::read(&finished).unwrap(), before);

        // A tag chunk after the audio is not lost audio.
        let tagged = dir.path().join("tagged.wav");
        let mut bytes = before.clone();
        bytes.extend_from_slice(b"LIST");
        bytes.extend_from_slice(&4_u32.to_le_bytes());
        bytes.extend_from_slice(b"INFO");
        std::fs::write(&tagged, &bytes).unwrap();
        assert_eq!(
            repair_plaintext_wav_header(&tagged).unwrap(),
            WavHeaderRepair::Unchanged
        );
        assert_eq!(std::fs::read(&tagged).unwrap(), bytes);

        let foreign = dir.path().join("notes.wav");
        std::fs::write(&foreign, b"not a wave file at all, just text").unwrap();
        assert_eq!(
            repair_plaintext_wav_header(&foreign).unwrap(),
            WavHeaderRepair::Unchanged
        );
        assert_eq!(
            std::fs::read(&foreign).unwrap(),
            b"not a wave file at all, just text"
        );
    }
}
