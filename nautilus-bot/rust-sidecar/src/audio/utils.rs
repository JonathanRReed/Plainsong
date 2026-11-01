//! Audio preprocessing utilities for ASR models
//!
//! All ASR models require 16kHz mono f32 audio input.
//! This module handles resampling, format conversion, and normalization.

use anyhow::{Context, Result};
use hound::WavReader;
use std::io::{BufReader, Read};
use std::path::Path;

pub(crate) const ASR_SAMPLE_RATE: u64 = 16_000;
pub(crate) const ASR_WINDOW_SAMPLES: usize = 30 * ASR_SAMPLE_RATE as usize;

enum AudioSource {
    Wav(WavReader<BufReader<std::fs::File>>),
    Raw(BufReader<std::fs::File>),
}

/// Linear-phase low-pass applied before decimating to 16 kHz. Without it,
/// 8-24 kHz room hiss and breath noise fold into the speech band, which hurts
/// quiet speech most. Centered convolution keeps sample timing unchanged.
struct AntiAliasFilter {
    taps: Vec<f32>,
    /// Mirrored ring: every sample is written at `pos` and `pos + len`, so the
    /// current window is always one contiguous slice.
    ring: Vec<f32>,
    pos: usize,
    primed: bool,
}

impl AntiAliasFilter {
    const TAPS: usize = 95;
    /// Cutoff as a fraction of the target rate: 7.8 kHz for 16 kHz output.
    const CUTOFF_FRACTION: f64 = 0.4875;

    fn for_rates(from_rate: u32, to_rate: u32) -> Option<Self> {
        if from_rate <= to_rate {
            return None;
        }
        let cutoff = Self::CUTOFF_FRACTION * f64::from(to_rate) / f64::from(from_rate);
        let middle = (Self::TAPS - 1) as f64 / 2.0;
        let mut taps: Vec<f64> = (0..Self::TAPS)
            .map(|index| {
                let offset = index as f64 - middle;
                let sinc = if offset == 0.0 {
                    2.0 * cutoff
                } else {
                    (2.0 * std::f64::consts::PI * cutoff * offset).sin()
                        / (std::f64::consts::PI * offset)
                };
                let phase = 2.0 * std::f64::consts::PI * index as f64 / (Self::TAPS - 1) as f64;
                let blackman = 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos();
                sinc * blackman
            })
            .collect();
        let gain: f64 = taps.iter().sum();
        taps.iter_mut().for_each(|tap| *tap /= gain);
        Some(Self {
            taps: taps.into_iter().map(|tap| tap as f32).collect(),
            ring: vec![0.0; 2 * Self::TAPS],
            pos: 0,
            primed: false,
        })
    }

    fn push(&mut self, sample: f32) {
        let len = self.taps.len();
        self.ring[self.pos] = sample;
        self.ring[self.pos + len] = sample;
        self.pos = (self.pos + 1) % len;
    }

    fn output(&self) -> f32 {
        let window = &self.ring[self.pos..self.pos + self.taps.len()];
        window
            .iter()
            .zip(&self.taps)
            .map(|(sample, tap)| sample * tap)
            .sum()
    }

    /// The same centered convolution as the streaming reader, in place.
    fn filter_in_place(mut self, samples: &mut [f32]) {
        let lookahead = self.taps.len() / 2;
        for index in 0..=lookahead {
            self.push(samples.get(index).copied().unwrap_or(0.0));
        }
        for index in 0..samples.len() {
            let filtered = self.output();
            self.push(samples.get(index + lookahead + 1).copied().unwrap_or(0.0));
            samples[index] = filtered;
        }
    }
}

/// Reads only one ASR window at a time. Resampling positions are global, so
/// carrying a pause-aligned tail does not repeat or omit samples at a boundary.
pub(crate) struct AudioWindowReader {
    source: AudioSource,
    spec: hound::WavSpec,
    input_frames: u64,
    source_frames_read: u64,
    anti_alias: Option<AntiAliasFilter>,
    output_samples: u64,
    output_position: u64,
    source_position: u64,
    source_pair: Option<(f32, f32)>,
    pending: Vec<f32>,
    asr_storage_interpolation: bool,
}

impl AudioWindowReader {
    /// Opening inspects metadata and allocates only the fixed-size file buffer.
    /// Call `next_window` only after admitting its working memory.
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        let (source, spec, input_frames) = if extension.eq_ignore_ascii_case("wav") {
            let reader = WavReader::open(path).context("Failed to open WAV file")?;
            let spec = reader.spec();
            if spec.channels == 0 || spec.sample_rate == 0 {
                anyhow::bail!("WAV audio requires a nonzero sample rate and channel count");
            }
            if !matches!(
                (spec.sample_format, spec.bits_per_sample),
                (hound::SampleFormat::Int, 16 | 24 | 32) | (hound::SampleFormat::Float, 32)
            ) {
                anyhow::bail!("Unsupported WAV sample format: {:?}", spec);
            }
            let samples = u64::from(reader.len());
            if samples % u64::from(spec.channels) != 0 {
                anyhow::bail!("WAV audio contains an incomplete channel frame");
            }
            let frames = samples / u64::from(spec.channels);
            (AudioSource::Wav(reader), spec, frames)
        } else if extension.eq_ignore_ascii_case("pcm") || extension.eq_ignore_ascii_case("raw") {
            let file = std::fs::File::open(path).context("Failed to open PCM file")?;
            let bytes = file.metadata()?.len();
            if bytes % 2 != 0 {
                anyhow::bail!("PCM audio contains an incomplete 16-bit sample");
            }
            (
                AudioSource::Raw(BufReader::new(file)),
                hound::WavSpec {
                    channels: 1,
                    sample_rate: ASR_SAMPLE_RATE as u32,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
                bytes / 2,
            )
        } else {
            anyhow::bail!("Unsupported audio format: {}", extension);
        };
        let output_samples = input_frames
            .checked_mul(ASR_SAMPLE_RATE)
            .context("Audio sample count is too large")?
            / u64::from(spec.sample_rate);
        Ok(Self {
            source,
            spec,
            input_frames,
            source_frames_read: 0,
            anti_alias: AntiAliasFilter::for_rates(spec.sample_rate, ASR_SAMPLE_RATE as u32),
            output_samples,
            output_position: 0,
            source_position: 0,
            source_pair: None,
            pending: Vec::new(),
            asr_storage_interpolation: false,
        })
    }

    /// Bounded form of `load_audio_file` for storage conversion. Keep its
    /// floating-point position calculation, including rounding, while the
    /// existing streaming/diarization reader keeps its rational positions.
    pub(crate) fn open_for_asr_storage(path: &Path) -> Result<Self> {
        let mut reader = Self::open(path)?;
        anyhow::ensure!(
            matches!(reader.spec.channels, 1 | 2),
            "ASR storage conversion requires mono or stereo audio"
        );
        reader.asr_storage_interpolation = true;
        reader.output_samples = (reader.input_frames as f64
            * (ASR_SAMPLE_RATE as f64 / f64::from(reader.spec.sample_rate)))
            as u64;
        Ok(reader)
    }

    /// Full 16 kHz output plus two bounded decode windows and fixed reader
    /// state. Source-rate samples are consumed one frame at a time.
    #[cfg(any(test, feature = "diarization"))]
    pub(crate) fn decoded_buffer_bytes(&self) -> Result<u64> {
        self.output_samples
            .checked_mul(4)
            .and_then(|bytes| bytes.checked_add(Self::decode_scratch_bytes()))
            .context("Decoded audio memory budget is too large")
    }

    #[cfg(any(test, feature = "diarization"))]
    pub(crate) fn decode_scratch_bytes() -> u64 {
        2 * ASR_WINDOW_SAMPLES as u64 * 4 + 8192 + 3 * AntiAliasFilter::TAPS as u64 * 4
    }

    #[cfg(feature = "diarization")]
    pub(crate) fn duration_seconds(&self) -> f64 {
        self.input_frames as f64 / f64::from(self.spec.sample_rate)
    }

    /// Call after admitting `decoded_buffer_bytes`. Capacity is reserved once
    /// from the header, so extending never doubles a long recording's buffer.
    #[cfg(any(test, feature = "diarization"))]
    pub(crate) fn read_all_with(
        &mut self,
        mut between: impl FnMut() -> Result<()>,
    ) -> Result<Vec<f32>> {
        let length = usize::try_from(self.output_samples).context("Decoded audio is too large")?;
        let mut samples = Vec::new();
        samples
            .try_reserve_exact(length)
            .context("Could not allocate admitted decoded audio")?;
        while self.has_more() {
            between()?;
            let window = self.next_window()?;
            anyhow::ensure!(
                samples.len() + window.len() <= length,
                "Audio exceeded its admitted header length"
            );
            samples.extend_from_slice(&window);
        }
        Ok(samples)
    }

    pub(crate) fn max_window_samples(&self) -> usize {
        self.output_samples.min(ASR_WINDOW_SAMPLES as u64) as usize
    }

    pub(crate) fn has_more(&self) -> bool {
        !self.pending.is_empty()
            || self.output_position < self.output_samples
            || self.source_frames_read < self.input_frames
    }

    /// The next source-rate mono frame, low-passed when it will be decimated.
    /// Frames past the end of the file are treated as silence.
    fn read_mono_frame(&mut self) -> Result<f32> {
        let Some(mut filter) = self.anti_alias.take() else {
            return self.read_raw_mono_frame();
        };
        let result = (|| {
            if !filter.primed {
                let lookahead = filter.taps.len() / 2;
                for _ in 0..=lookahead {
                    let sample = self.read_raw_or_silence()?;
                    filter.push(sample);
                }
                filter.primed = true;
            } else {
                let sample = self.read_raw_or_silence()?;
                filter.push(sample);
            }
            Ok(filter.output())
        })();
        self.anti_alias = Some(filter);
        result
    }

    fn read_raw_or_silence(&mut self) -> Result<f32> {
        if self.source_frames_read < self.input_frames {
            self.read_raw_mono_frame()
        } else {
            Ok(0.0)
        }
    }

    fn read_raw_mono_frame(&mut self) -> Result<f32> {
        let mut sum = 0.0f64;
        for _ in 0..self.spec.channels {
            let sample = match &mut self.source {
                AudioSource::Raw(reader) => {
                    let mut bytes = [0u8; 2];
                    reader
                        .read_exact(&mut bytes)
                        .context("Truncated PCM audio")?;
                    f32::from(i16::from_le_bytes(bytes)) / 32768.0
                }
                AudioSource::Wav(reader) => {
                    match (self.spec.sample_format, self.spec.bits_per_sample) {
                        (hound::SampleFormat::Float, _) => reader
                            .samples::<f32>()
                            .next()
                            .context("Truncated WAV audio")??,
                        (hound::SampleFormat::Int, 16) => {
                            f32::from(
                                reader
                                    .samples::<i16>()
                                    .next()
                                    .context("Truncated WAV audio")??,
                            ) / 32768.0
                        }
                        (hound::SampleFormat::Int, bits) => {
                            reader
                                .samples::<i32>()
                                .next()
                                .context("Truncated WAV audio")?? as f32
                                / if bits == 24 { 8388608.0 } else { 2147483648.0 }
                        }
                    }
                }
            };
            if !sample.is_finite() {
                anyhow::bail!("Audio contains a non-finite sample");
            }
            sum += f64::from(sample);
        }
        self.source_frames_read += 1;
        Ok((sum / f64::from(self.spec.channels)) as f32)
    }

    fn next_resampled_sample(&mut self) -> Result<f32> {
        if self.spec.sample_rate == ASR_SAMPLE_RATE as u32 {
            self.output_position += 1;
            return self.read_raw_mono_frame();
        }
        if self.source_pair.is_none() {
            let current = self.read_mono_frame()?;
            let next = if self.input_frames > 1 {
                self.read_mono_frame()?
            } else {
                current
            };
            self.source_pair = Some((current, next));
        }
        let position = self
            .output_position
            .checked_mul(u64::from(self.spec.sample_rate))
            .context("Audio resampling position is too large")?;
        let (source_index, fraction) = if self.asr_storage_interpolation {
            let ratio = ASR_SAMPLE_RATE as f64 / f64::from(self.spec.sample_rate);
            let input_position = self.output_position as f64 / ratio;
            let index = input_position as u64;
            (index, (input_position - index as f64) as f32)
        } else {
            (
                position / ASR_SAMPLE_RATE,
                (position % ASR_SAMPLE_RATE) as f32 / ASR_SAMPLE_RATE as f32,
            )
        };
        while self.source_position < source_index {
            let current = self
                .source_pair
                .context("Audio resampler has no source frame")?
                .1;
            self.source_position += 1;
            let next = if self.source_position + 1 < self.input_frames {
                self.read_mono_frame()?
            } else {
                current
            };
            self.source_pair = Some((current, next));
        }
        let (current, next) = self
            .source_pair
            .context("Audio resampler has no source frame")?;
        self.output_position += 1;
        Ok(current * (1.0 - fraction) + next * fraction)
    }

    pub(crate) fn next_window(&mut self) -> Result<Vec<f32>> {
        let mut samples = std::mem::take(&mut self.pending);
        let capacity = self.max_window_samples();
        samples
            .try_reserve_exact(capacity.saturating_sub(samples.len()))
            .context("Could not allocate the admitted audio window")?;
        while samples.len() < capacity && self.output_position < self.output_samples {
            samples.push(self.next_resampled_sample()?);
        }
        if self.output_position < self.output_samples {
            let cut = pause_aligned_cut(&samples);
            self.pending = samples.split_off(cut);
        } else {
            // Downsampling may not need the last source frames. They still
            // have to decode successfully before the complete file succeeds.
            while self.source_frames_read < self.input_frames {
                self.read_raw_mono_frame()?;
            }
        }
        Ok(samples)
    }
}

/// Prefer a sustained quiet interval near the window limit. Every sample on
/// either side of the cut is retained, including the silence itself.
///
/// "Quiet" is relative to the noise in the last three seconds, so a pause
/// under steady room noise or background voices still counts; a fixed
/// -40 dB threshold found no pause at all in noisy captures, and even clean
/// 40-70 s dictations hit the hard window edge half the time. Without a
/// sustained pause the cut falls in the quietest 100 ms (a gap between words)
/// when that gap is clearly quieter than the speech around it; only audio
/// with no such contrast is cut at the window edge. On 352 synthetic 40-70 s
/// dictations this lowered Parakeet's word error rate from 8.50% to 8.08%
/// (pink noise 9.2% -> 8.6%, background voices 10.1% -> 9.0%, clean and
/// quiet unchanged).
fn pause_aligned_cut(samples: &[f32]) -> usize {
    const FRAME: usize = 160;
    const SEARCH: usize = 3 * ASR_SAMPLE_RATE as usize;
    const MIN_QUIET: usize = 3 * ASR_SAMPLE_RATE as usize / 10;
    const ABSOLUTE_QUIET_DB: f32 = -40.0;
    /// A frame within this much of the region's quiet floor counts as pause.
    const FLOOR_MARGIN_DB: f32 = 6.0;
    /// The median has to clear the quiet floor by this much for the floor to
    /// mean anything.
    const MIN_FLOOR_CONTRAST_DB: f32 = 3.0;
    /// Ten frames: the narrowest word gap worth cutting in.
    const GAP_FRAMES: usize = 10;
    /// A word gap has to sit this far below the region's median level.
    const MIN_GAP_CONTRAST_DB: f32 = 10.0;

    let start = samples.len().saturating_sub(SEARCH);
    let levels: Vec<f32> = samples[start..]
        .chunks(FRAME)
        .map(crate::audio::vad::calculate_energy_db)
        .collect();
    if levels.is_empty() {
        return samples.len();
    }
    let mut sorted = levels.clone();
    sorted.sort_by(f32::total_cmp);
    let percentile = |fraction: f32| sorted[((sorted.len() - 1) as f32 * fraction) as usize];
    // Within a few dB of the region's quiet floor. A region with no quieter
    // stretch at all (no contrast) keeps the fixed threshold, so it has no
    // pause to find.
    let floor_db = percentile(0.1);
    let quiet_db = if percentile(0.5) - floor_db >= MIN_FLOOR_CONTRAST_DB {
        ABSOLUTE_QUIET_DB.max(floor_db + FLOOR_MARGIN_DB)
    } else {
        ABSOLUTE_QUIET_DB
    };

    let mut quiet_start = None;
    let mut cut = None;
    for (index, (frame, level)) in samples[start..].chunks(FRAME).zip(&levels).enumerate() {
        let frame_start = start + index * FRAME;
        if *level <= quiet_db {
            let run_start = *quiet_start.get_or_insert(frame_start);
            let end = frame_start + frame.len();
            if end - run_start >= MIN_QUIET {
                cut = Some(run_start + (end - run_start) / 2);
            }
        } else {
            quiet_start = None;
        }
    }
    if let Some(cut) = cut {
        return cut;
    }
    if levels.len() < GAP_FRAMES {
        return samples.len();
    }

    // The quietest 100 ms, latest first on ties so the window stays long.
    let mut best: Option<(f32, usize)> = None;
    for first in (0..=levels.len() - GAP_FRAMES).rev() {
        let mean = levels[first..first + GAP_FRAMES].iter().sum::<f32>() / GAP_FRAMES as f32;
        if best.is_none_or(|(quietest, _)| mean < quietest) {
            best = Some((mean, first));
        }
    }
    match best {
        Some((gap_db, first)) if gap_db <= percentile(0.5) - MIN_GAP_CONTRAST_DB => {
            start + (first + GAP_FRAMES / 2) * FRAME
        }
        _ => samples.len(),
    }
}

/// Admission precedes window allocations and lasts through the entire decode,
/// including the carried samples between windows.
/// A late failure cannot be returned as a successful partial transcript.
pub(crate) fn process_audio_windows<Lease>(
    reader: &mut AudioWindowReader,
    admit: impl FnOnce() -> Result<Lease>,
    mut decode: impl FnMut(Vec<f32>) -> Result<String>,
) -> Result<String> {
    let mut text = String::new();
    for decoded in process_timed_audio_windows(reader, admit, |samples, _| decode(samples))? {
        let decoded = decoded.trim();
        if !decoded.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(decoded);
        }
    }
    Ok(text)
}

/// [`process_audio_windows`] for a decoder that reports its own timings: each
/// window is handed over with the time it starts at, in seconds of 16 kHz
/// output, and every window's result is returned in order.
///
/// Windows tile the audio exactly -- a pause-aligned cut keeps every sample,
/// and the tail it leaves opens the next window -- so a window's start is the
/// total length of the windows before it.
pub(crate) fn process_timed_audio_windows<Lease, T>(
    reader: &mut AudioWindowReader,
    admit: impl FnOnce() -> Result<Lease>,
    mut decode: impl FnMut(Vec<f32>, f64) -> Result<T>,
) -> Result<Vec<T>> {
    let mut decoded = Vec::new();
    if !reader.has_more() {
        return Ok(decoded);
    }
    let _lease = admit()?;
    let mut window_start = 0usize;
    while reader.has_more() {
        let samples = reader.next_window()?;
        if samples.is_empty() {
            continue;
        }
        let start_seconds = window_start as f64 / ASR_SAMPLE_RATE as f64;
        window_start += samples.len();
        decoded.push(decode(samples, start_seconds)?);
    }
    Ok(decoded)
}

/// Counts known sample/frame buffers, not native graph activations or arenas.
pub(crate) fn moonshine_host_bytes(samples: usize) -> Result<u64> {
    (samples as u64)
        .checked_mul(28)
        .and_then(|bytes| bytes.checked_add(64 * 1024))
        .context("Moonshine audio memory budget is too large")
}

pub(crate) fn parakeet_host_bytes(samples: usize) -> Result<u64> {
    let samples = samples as u64;
    let frames = samples
        .checked_add(159)
        .context("Parakeet frame count is too large")?
        / 160;
    // Waveform/carry/VAD/normalization, three 128-bin mel arrays, 257-bin
    // power frames and their Vec headers. Fixed filters/FFT scratch fit in 1MiB.
    let frame_bytes = frames
        .checked_mul((3 * 128 + 257) * 4 + std::mem::size_of::<Vec<f32>>() as u64)
        .context("Parakeet frame memory budget is too large")?;
    samples
        .checked_mul(16)
        .and_then(|bytes| bytes.checked_add(frame_bytes))
        .and_then(|bytes| bytes.checked_add(1024 * 1024))
        .context("Parakeet audio memory budget is too large")
}

/// Load and preprocess audio file for ASR
///
/// Performs:
/// - Read WAV/PCM file
/// - Convert to mono
/// - Resample to 16kHz
/// - Convert to f32 samples
/// - Normalize to [-1.0, 1.0]
pub fn load_audio_file(path: &Path) -> Result<Vec<f32>> {
    tracing::info!("Loading audio file: {:?}", path);

    // Check file extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "wav" => load_wav_file(path),
        "pcm" | "raw" => load_raw_pcm(path),
        _ => Err(anyhow::anyhow!("Unsupported audio format: {}", ext)),
    }
}

/// Load WAV file and preprocess
fn load_wav_file(path: &Path) -> Result<Vec<f32>> {
    let reader = WavReader::open(path).context("Failed to open WAV file")?;

    let spec = reader.spec();
    tracing::info!("WAV spec: {:?}", spec);

    // Read samples based on format
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => match spec.bits_per_sample {
            16 => read_i16_samples(reader),
            24 => read_i24_samples(reader),
            32 => read_i32_samples(reader),
            _ => Err(anyhow::anyhow!(
                "Unsupported bit depth: {}",
                spec.bits_per_sample
            )),
        },
        hound::SampleFormat::Float => read_f32_samples(reader),
    }?;

    // Convert to mono if stereo
    let samples = if spec.channels == 2 {
        stereo_to_mono(&samples)
    } else {
        samples
    };

    // Resample to 16kHz if needed
    let samples = if spec.sample_rate != 16000 {
        resample(samples, spec.sample_rate, 16000).context("Failed to resample audio")?
    } else {
        samples
    };

    tracing::info!("Loaded {} samples at 16kHz", samples.len());

    Ok(samples)
}

/// Load raw PCM file (assumes 16-bit signed, 16kHz, mono)
fn load_raw_pcm(path: &Path) -> Result<Vec<f32>> {
    let data = std::fs::read(path).context("Failed to read PCM file")?;

    // Convert bytes to i16 samples
    let samples: Vec<f32> = data
        .chunks_exact(2)
        .map(|chunk| {
            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            sample as f32 / 32768.0
        })
        .collect();

    Ok(samples)
}

/// Read 16-bit signed integer samples
fn read_i16_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0)
        .collect();
    Ok(samples)
}

/// Read 24-bit signed integer samples
fn read_i24_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i32>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 8388608.0) // 2^23
        .collect();
    Ok(samples)
}

/// Read 32-bit signed integer samples
fn read_i32_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i32>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 2147483648.0) // 2^31
        .collect();
    Ok(samples)
}

/// Read 32-bit float samples
fn read_f32_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<f32>()
        .filter_map(|s| s.ok())
        .collect();
    Ok(samples)
}

/// Convert stereo to mono by averaging channels
fn stereo_to_mono(stereo: &[f32]) -> Vec<f32> {
    stereo
        .chunks_exact(2)
        .map(|chunk| (chunk[0] + chunk[1]) / 2.0)
        .collect()
}

/// Band-limited linear resampling: low-pass first when decimating, so content
/// above the target Nyquist rate cannot fold into the speech band.
fn resample(mut input: Vec<f32>, from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(input);
    }
    if let Some(filter) = AntiAliasFilter::for_rates(from_rate, to_rate) {
        filter.filter_in_place(&mut input);
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let output_len = (input.len() as f64 * ratio) as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let input_pos = i as f64 / ratio;
        let index = input_pos as usize;
        let frac = input_pos - index as f64;

        if index + 1 < input.len() {
            let sample = input[index] * (1.0 - frac as f32) + input[index + 1] * frac as f32;
            output.push(sample);
        } else if index < input.len() {
            output.push(input[index]);
        }
    }

    Ok(output)
}

#[cfg(test)]
fn normalize(samples: &mut [f32], target_db: f32) {
    if samples.is_empty() {
        return;
    }

    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / samples.len() as f32).sqrt();

    if rms > 0.0 {
        let target_linear = 10f32.powf(target_db / 20.0);
        let gain = target_linear / rms;

        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }
}

/// Source-frame spans retained in the compacted WAV, in playback order.
pub(crate) struct RetainedFrameTimeline {
    sample_rate: u32,
    source_frames: u64,
    retained_frames: Vec<std::ops::Range<u64>>,
}

impl RetainedFrameTimeline {
    pub(crate) fn is_identity(&self) -> bool {
        if self.source_frames == 0 {
            return self.retained_frames.is_empty();
        }
        self.retained_frames.len() == 1 && self.retained_frames[0] == (0..self.source_frames)
    }

    /// Start boundaries belong to the following span; end boundaries to the
    /// previous span. Invalid provider times remain invalid, never clamped.
    pub(crate) fn map_span(&self, start: f64, end: f64) -> Option<(f64, f64)> {
        let frames: u64 = self
            .retained_frames
            .iter()
            .map(|span| span.end - span.start)
            .sum();
        let rate = f64::from(self.sample_rate);
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end < start
            || end > frames as f64 / rate
        {
            return None;
        }
        if self.is_identity() {
            return Some((start, end));
        }
        let map = |time: f64, following: bool| {
            let mut offset = 0_u64;
            for (index, span) in self.retained_frames.iter().enumerate() {
                let next = offset + span.end - span.start;
                let boundary = next as f64 / rate;
                if time < boundary
                    || (time == boundary && (!following || index + 1 == self.retained_frames.len()))
                {
                    return Some((span.start as f64 + time * rate - offset as f64) / rate);
                }
                offset = next;
            }
            None
        };
        let mapped_start = map(start, true)?;
        let mapped_end = if start == end {
            mapped_start
        } else {
            map(end, false)?
        };
        Some((mapped_start, mapped_end))
    }
}

pub(crate) struct CompactedWav {
    pub(crate) bytes: Vec<u8>,
    pub(crate) timeline: RetainedFrameTimeline,
}

/// Skip only digital-zero PCM16 frames beyond the first 500 ms of each run.
/// Unsupported formats retain their original bytes and identity timeline.
pub(crate) fn compact_digital_silence(wav_bytes: &[u8]) -> Result<CompactedWav> {
    use std::io::Cursor;
    let mut reader = hound::WavReader::new(Cursor::new(wav_bytes))?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.sample_rate == 0 {
        anyhow::bail!("Silence skip requires nonzero WAV channels and sample rate");
    }
    let channels = usize::from(spec.channels);
    let sample_count = reader.len() as usize;
    if !sample_count.is_multiple_of(channels) {
        anyhow::bail!("Silence skip cannot process an incomplete channel frame");
    }
    let source_frames = (sample_count / channels) as u64;
    let mut timeline = RetainedFrameTimeline {
        sample_rate: spec.sample_rate,
        source_frames,
        retained_frames: Vec::new(),
    };
    if source_frames > 0 {
        timeline.retained_frames.push(0..source_frames);
    }
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Ok(CompactedWav {
            bytes: wav_bytes.to_vec(),
            timeline,
        });
    }
    let samples = reader
        .samples::<i16>()
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if samples.len() != sample_count {
        anyhow::bail!("Silence skip could not decode the complete WAV");
    }
    let allowance = u64::from(spec.sample_rate).div_ceil(2);
    let mut zero_frames = 0_u64;
    let mut retained = Vec::with_capacity(samples.len());
    let mut spans = Vec::new();
    let mut span_start = None;
    for (index, frame) in samples.chunks_exact(channels).enumerate() {
        if frame.iter().all(|sample| *sample == 0) {
            zero_frames += 1;
        } else {
            zero_frames = 0;
        }
        if zero_frames <= allowance {
            span_start.get_or_insert(index as u64);
            retained.extend_from_slice(frame);
        } else if let Some(start) = span_start.take() {
            spans.push(start..index as u64);
        }
    }
    if let Some(start) = span_start {
        spans.push(start..source_frames);
    }
    timeline.retained_frames = spans;
    if timeline.is_identity() {
        return Ok(CompactedWav {
            bytes: wav_bytes.to_vec(),
            timeline,
        });
    }
    let mut bytes = Vec::new();
    let mut writer = hound::WavWriter::new(Cursor::new(&mut bytes), spec)?;
    for sample in retained {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(CompactedWav { bytes, timeline })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm16_fixture(channels: u16, rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut writer = hound::WavWriter::new(
            std::io::Cursor::new(&mut bytes),
            hound::WavSpec {
                channels,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for &sample in samples {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        bytes
    }

    #[test]
    fn silence_skip_preserves_quiet_pcm_and_stereo_frames_exactly() {
        let samples: Vec<i16> = (0..32_000)
            .map(|i| if i % 2 == 0 { 1 } else { -98 })
            .collect();
        let original = pcm16_fixture(2, 16_000, &samples);
        let processed = compact_digital_silence(&original).unwrap();
        assert_eq!(processed.bytes, original);
        assert!(processed.timeline.is_identity());
        let mut reader = hound::WavReader::new(std::io::Cursor::new(&processed.bytes)).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.duration(), 16_000);
        assert_eq!(
            reader
                .samples::<i16>()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap(),
            samples
        );
    }

    #[test]
    fn silence_skip_compacts_zero_frames_and_rebases_multiple_gap_boundaries() {
        let samples = [
            vec![0; 20],
            vec![0, 1],
            vec![0; 20],
            vec![2, 0],
            vec![0; 20],
        ]
        .concat();
        let processed = compact_digital_silence(&pcm16_fixture(2, 10, &samples)).unwrap();
        let mut reader = hound::WavReader::new(std::io::Cursor::new(&processed.bytes)).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().sample_rate, 10);
        assert_eq!(
            reader
                .samples::<i16>()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap(),
            [
                vec![0; 10],
                vec![0, 1],
                vec![0; 10],
                vec![2, 0],
                vec![0; 10]
            ]
            .concat()
        );
        assert_eq!(
            processed.timeline.retained_frames,
            vec![0..5, 10..16, 21..27]
        );
        assert_eq!(processed.timeline.map_span(0.0, 0.5), Some((0.0, 0.5)));
        assert_eq!(processed.timeline.map_span(0.5, 0.6), Some((1.0, 1.1)));
        assert_eq!(processed.timeline.map_span(1.1, 1.2), Some((2.1, 2.2)));
        assert_eq!(processed.timeline.map_span(0.5, 0.5), Some((1.0, 1.0)));
        assert_eq!(processed.timeline.map_span(1.1, 1.1), Some((2.1, 2.1)));
        assert!(processed.timeline.map_span(f64::NAN, 0.5).is_none());
        assert!(processed.timeline.map_span(-0.1, 0.5).is_none());
        assert!(processed.timeline.map_span(0.7, 0.5).is_none());
        assert!(processed.timeline.map_span(0.0, 10.0).is_none());
        let zeros = compact_digital_silence(&pcm16_fixture(1, 10, &[0; 20])).unwrap();
        assert_eq!(
            hound::WavReader::new(std::io::Cursor::new(zeros.bytes))
                .unwrap()
                .duration(),
            5
        );
    }

    #[test]
    fn silence_skip_unsupported_float_is_byte_identity_and_invalid_audio_errors() {
        let mut original = Vec::new();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 10,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::new(std::io::Cursor::new(&mut original), spec).unwrap();
        for _ in 0..20 {
            writer.write_sample(0.001_f32).unwrap();
        }
        writer.finalize().unwrap();
        let processed = compact_digital_silence(&original).unwrap();
        assert_eq!(processed.bytes, original);
        assert!(processed.timeline.is_identity());
        let mut truncated = pcm16_fixture(1, 10, &[1; 20]);
        truncated.pop();
        assert!(compact_digital_silence(&truncated).is_err());
        let mut invalid_rate = pcm16_fixture(1, 10, &[1; 20]);
        invalid_rate[24..28].copy_from_slice(&0_u32.to_le_bytes());
        assert!(compact_digital_silence(&invalid_rate).is_err());
        let mut nonfinite = original;
        let end = nonfinite.len();
        nonfinite[end - 4..].copy_from_slice(&f32::NAN.to_le_bytes());
        let untouched = compact_digital_silence(&nonfinite).unwrap();
        assert_eq!(untouched.bytes, nonfinite);
        assert!(untouched.timeline.is_identity());
    }

    #[test]
    fn test_stereo_to_mono() {
        let stereo = vec![0.5, 0.3, 0.7, 0.2];
        let mono = stereo_to_mono(&stereo);
        assert_eq!(mono, vec![0.4, 0.45]);
    }

    #[test]
    fn test_resample() {
        let input = vec![0.0, 0.5, 1.0, 0.5];
        let output = resample(input, 16000, 8000).unwrap();
        assert_eq!(output.len(), 2);
    }

    #[test]
    fn test_normalize() {
        let mut samples = vec![0.1, 0.2, 0.3];
        normalize(&mut samples, -20.0);
        // Just verify it doesn't panic
        assert!(!samples.is_empty());
    }

    fn tone_rms_after_reading(rate: u32, frequency: f64) -> f32 {
        let frames = rate as usize;
        let fixture = AudioFixture::wav(rate, 1, frames, |frame, _| {
            let phase = 2.0 * std::f64::consts::PI * frequency * frame as f64 / f64::from(rate);
            (phase.sin() * 16_000.0) as i16
        });
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let samples = reader.next_window().unwrap();
        let interior = &samples[1_600..samples.len() - 1_600];
        (interior.iter().map(|value| value * value).sum::<f32>() / interior.len() as f32).sqrt()
    }

    #[test]
    fn decimation_removes_hiss_above_the_speech_band() {
        let input_rms = 16_000.0 / 32_768.0 / std::f32::consts::SQRT_2;
        for rate in [48_000, 44_100] {
            let speech = tone_rms_after_reading(rate, 1_000.0);
            assert!((speech / input_rms - 1.0).abs() < 0.02, "{rate}: {speech}");
            for hiss in [10_000.0, 12_000.0, 15_000.0] {
                let folded = tone_rms_after_reading(rate, hiss);
                assert!(
                    folded / input_rms < 0.01,
                    "{rate} Hz source, {hiss} Hz: {folded}"
                );
            }
        }
    }

    #[test]
    fn anti_alias_filter_keeps_sample_timing() {
        let fixture =
            AudioFixture::wav(
                48_000,
                1,
                48_000,
                |frame, _| {
                    if frame == 24_000 {
                        30_000
                    } else {
                        0
                    }
                },
            );
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let samples = reader.next_window().unwrap();
        let peak = samples
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .map(|(index, _)| index)
            .unwrap();
        assert_eq!(peak, 8_000);
    }

    struct AudioFixture(std::path::PathBuf);

    impl AudioFixture {
        fn wav(
            rate: u32,
            channels: u16,
            frames: usize,
            sample: impl Fn(usize, u16) -> i16,
        ) -> Self {
            let path =
                std::env::temp_dir().join(format!("plainsong-window-{}.wav", uuid::Uuid::new_v4()));
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels,
                    sample_rate: rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for frame in 0..frames {
                for channel in 0..channels {
                    writer.write_sample(sample(frame, channel)).unwrap();
                }
            }
            writer.finalize().unwrap();
            Self(path)
        }
    }

    impl Drop for AudioFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn diarization_header_budget_and_decode_scratch_do_not_grow_with_source_rate() {
        for rate in [16_000, 48_000, 96_000] {
            let fixture =
                AudioFixture::wav(rate, 2, rate as usize / 2, |frame, _| (frame % 100) as i16);
            let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
            let budget = reader.decoded_buffer_bytes().unwrap();
            assert_eq!(
                budget,
                8_000 * 4 + AudioWindowReader::decode_scratch_bytes()
            );
            let samples = reader.read_all_with(|| Ok(())).unwrap();
            assert_eq!(samples.len(), 8_000);
            assert!(samples.capacity() * 4 <= budget as usize);
            assert!(reader.pending.capacity() <= ASR_WINDOW_SAMPLES);
            if let Some(filter) = reader.anti_alias {
                assert_eq!(filter.ring.len(), 2 * AntiAliasFilter::TAPS);
            }
        }
    }

    #[test]
    fn three_hour_wav_headers_admit_only_16khz_output_at_16_48_and_96khz() {
        use std::io::{Seek, SeekFrom, Write};
        for rate in [16_000, 48_000, 96_000] {
            let fixture = AudioFixture::wav(rate, 1, 0, |_, _| 0);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&fixture.0)
                .unwrap();
            let header = file.metadata().unwrap().len();
            let data_bytes = 3 * 60 * 60 * u64::from(rate) * 2;
            file.seek(SeekFrom::Start(4)).unwrap();
            file.write_all(
                &u32::try_from(header + data_bytes - 8)
                    .unwrap()
                    .to_le_bytes(),
            )
            .unwrap();
            file.seek(SeekFrom::Start(header - 4)).unwrap();
            file.write_all(&u32::try_from(data_bytes).unwrap().to_le_bytes())
                .unwrap();
            file.set_len(header + data_bytes).unwrap();
            drop(file);
            let reader = AudioWindowReader::open(&fixture.0).unwrap();
            assert_eq!(
                reader.decoded_buffer_bytes().unwrap(),
                3 * 60 * 60 * 16_000 * 4 + AudioWindowReader::decode_scratch_bytes()
            );
            assert_eq!(
                reader.source_frames_read, 0,
                "header admission must precede decoding"
            );
            assert!(reader.pending.is_empty());
        }
    }

    #[test]
    fn full_decode_yields_between_bounded_chunks_without_repeating_samples() {
        let fixture = AudioFixture::wav(16_000, 1, 65 * 16_000, |frame, _| (frame % 1000) as i16);
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let mut batches = 0;
        let decoded = reader
            .read_all_with(|| {
                batches += 1;
                Ok(())
            })
            .unwrap();
        assert!(batches >= 3);
        assert_eq!(decoded, load_audio_file(&fixture.0).unwrap());
        assert_eq!(decoded.capacity(), decoded.len());
    }

    #[test]
    fn streaming_resampling_covers_every_window_and_nonmultiple_tail() {
        let fixture = AudioFixture::wav(48_000, 2, 65 * 48_000 + 217, |frame, channel| {
            ((frame + usize::from(channel) * 17) % 197) as i16 * 81 - 8000
        });
        let reference = load_audio_file(&fixture.0).unwrap();
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        assert_eq!(reader.max_window_samples(), ASR_WINDOW_SAMPLES);
        let mut actual = Vec::new();
        let mut lengths = Vec::new();
        while reader.has_more() {
            let window = reader.next_window().unwrap();
            assert!(window.len() <= ASR_WINDOW_SAMPLES);
            lengths.push(window.len());
            actual.extend(window);
        }
        assert_eq!(lengths.len(), 3);
        assert_eq!(actual.len(), reference.len());
        assert_eq!(actual.len(), (65 * 48_000 + 217) * 16_000 / 48_000);
        for (actual, expected) in actual.iter().zip(reference) {
            assert!((actual - expected).abs() < 2e-6);
        }
    }

    #[test]
    fn storage_reader_matches_whole_file_asr_samples_without_changing_streaming() {
        for rate in [16_000, 44_100, 48_000, 96_000] {
            for channels in [1, 2] {
                let fixture =
                    AudioFixture::wav(rate, channels, rate as usize * 2 + 17, |frame, channel| {
                        ((frame as f32 * 0.08 + f32::from(channel) * 0.3).sin() * 5000.0) as i16
                    });
                let expected = load_audio_file(&fixture.0).unwrap();
                let mut reader = AudioWindowReader::open_for_asr_storage(&fixture.0).unwrap();
                let actual = reader.read_all_with(|| Ok(())).unwrap();
                assert_eq!(actual, expected, "{rate} Hz / {channels} channels");
            }
        }
    }

    fn tone(frames: usize, level: f32) -> Vec<f32> {
        (0..frames)
            .map(|index| level * (index as f32 * 0.3).sin())
            .collect()
    }

    #[test]
    fn a_pause_under_steady_noise_is_still_a_pause() {
        // Speech at about -15 dBFS, a 0.5 s pause holding only noise at about
        // -33 dBFS: never below the old fixed -40 dB threshold.
        let mut samples = tone(28 * 16_000, 0.25);
        samples.extend(tone(8_000, 0.03));
        samples.extend(tone(2 * 16_000 - 8_000, 0.25));
        let cut = pause_aligned_cut(&samples);
        assert!(
            (28 * 16_000..28 * 16_000 + 8_000).contains(&cut),
            "cut {cut} is outside the pause"
        );
    }

    #[test]
    fn without_a_long_pause_the_cut_falls_in_the_quietest_word_gap() {
        // Words separated by 120 ms gaps, too short for a pause; one gap in the
        // last three seconds is 20 dB quieter than the speech.
        let mut samples = Vec::new();
        while samples.len() < 30 * 16_000 {
            samples.extend(tone(6_000, 0.25));
            let gap = if (28 * 16_000..29 * 16_000).contains(&samples.len()) {
                0.02
            } else {
                0.2
            };
            samples.extend(tone(1_920, gap));
        }
        samples.truncate(30 * 16_000);
        let cut = pause_aligned_cut(&samples);
        let level_at_cut = crate::audio::vad::calculate_energy_db(&samples[cut - 80..cut + 80]);
        assert!(
            cut < samples.len() && level_at_cut < -30.0,
            "cut {cut} at {level_at_cut} dB"
        );
    }

    #[test]
    fn audio_without_any_quieter_stretch_is_cut_at_the_window_edge() {
        let samples = tone(30 * 16_000, 0.25);
        assert_eq!(pause_aligned_cut(&samples), samples.len());
    }

    #[test]
    fn pause_cuts_carry_silence_and_speech_without_dropping_samples() {
        let fixture = AudioFixture::wav(16_000, 1, 35 * 16_000 + 17, |frame, _| {
            if (28 * 16_000..29 * 16_000).contains(&frame) {
                0
            } else {
                8000
            }
        });
        let reference = load_audio_file(&fixture.0).unwrap();
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let first = reader.next_window().unwrap();
        assert_eq!(first.len(), 28 * 16_000 + 8000);
        let second = reader.next_window().unwrap();
        assert!(!reader.has_more());
        assert_eq!(first.len() + second.len(), reference.len());
        assert_eq!([first, second].concat(), reference);
    }

    #[test]
    fn streaming_raw_pcm_keeps_the_final_sample() {
        let path =
            std::env::temp_dir().join(format!("plainsong-window-{}.raw", uuid::Uuid::new_v4()));
        let fixture = AudioFixture(path);
        let frames = ASR_WINDOW_SAMPLES + 19;
        let bytes: Vec<_> = (0..frames)
            .flat_map(|index| (1000 + (index % 113) as i16).to_le_bytes())
            .collect();
        std::fs::write(&fixture.0, bytes).unwrap();
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let first = reader.next_window().unwrap();
        let last = reader.next_window().unwrap();
        assert_eq!(first.len(), ASR_WINDOW_SAMPLES);
        assert_eq!(last.len(), 19);
        assert_eq!(
            last[18],
            (1000 + ((frames - 1) % 113) as i16) as f32 / 32768.0
        );
        assert!(!reader.has_more());
        std::fs::write(&fixture.0, [1u8]).unwrap();
        assert!(AudioWindowReader::open(&fixture.0).is_err());
    }

    #[test]
    fn streaming_downmix_handles_all_channels_and_upsampling() {
        let fixture = AudioFixture::wav(8000, 3, 17, |frame, channel| {
            frame as i16 * 300 + channel as i16 * 300
        });
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let output = reader.next_window().unwrap();
        assert_eq!(output.len(), 34);
        for (index, sample) in output.iter().enumerate() {
            let input_position = (index as f32 / 2.0).min(16.0);
            let expected = (input_position * 300.0 + 300.0) / 32768.0;
            assert!((sample - expected).abs() < 1e-7);
        }
    }

    #[test]
    fn truncated_wav_is_an_error_instead_of_a_short_success() {
        let fixture = AudioFixture::wav(16_000, 1, 100, |_, _| 8000);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&fixture.0)
            .unwrap();
        file.set_len(file.metadata().unwrap().len() - 2).unwrap();
        let result =
            AudioWindowReader::open(&fixture.0).and_then(|mut reader| reader.next_window());
        assert!(result.is_err());
    }

    #[test]
    fn downsampling_validates_a_truncated_unused_source_tail() {
        let fixture = AudioFixture::wav(48_000, 1, 100, |_, _| 8000);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&fixture.0)
            .unwrap();
        file.set_len(file.metadata().unwrap().len() - 2).unwrap();
        let result =
            AudioWindowReader::open(&fixture.0).and_then(|mut reader| reader.next_window());
        assert!(result.is_err());
    }

    #[test]
    fn downsampling_validates_a_nonfinite_unused_source_tail() {
        let fixture = AudioFixture(
            std::env::temp_dir().join(format!("plainsong-window-{}.wav", uuid::Uuid::new_v4())),
        );
        let mut writer = hound::WavWriter::create(
            &fixture.0,
            hound::WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for frame in 0..100 {
            writer
                .write_sample(if frame == 99 { f32::NAN } else { 0.25 })
                .unwrap();
        }
        writer.finalize().unwrap();
        let result =
            AudioWindowReader::open(&fixture.0).and_then(|mut reader| reader.next_window());
        assert!(result.unwrap_err().to_string().contains("non-finite"));
    }

    #[test]
    fn admission_precedes_decode_and_covers_carried_samples_until_late_failure() {
        use std::cell::Cell;
        struct Lease<'a>(&'a Cell<bool>);
        impl Drop for Lease<'_> {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }
        let fixture = AudioFixture::wav(16_000, 1, 35 * 16_000, |frame, _| {
            if (28 * 16_000..29 * 16_000).contains(&frame) {
                0
            } else {
                8000
            }
        });
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let active = Cell::new(false);
        let mut calls = 0;
        let result = process_audio_windows(
            &mut reader,
            || {
                active.set(true);
                Ok(Lease(&active))
            },
            |_| {
                assert!(active.get());
                calls += 1;
                if calls == 2 {
                    anyhow::bail!("late synthetic decode failure");
                }
                Ok("first window".to_string())
            },
        );
        assert!(result.unwrap_err().to_string().contains("late synthetic"));
        assert_eq!(calls, 2);
        assert!(!active.get());

        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        assert!(process_audio_windows(
            &mut reader,
            || -> Result<()> { anyhow::bail!("synthetic admission refusal") },
            |_| panic!("refused audio must not decode")
        )
        .is_err());
        assert_eq!(reader.output_position, 0);
        assert!(reader.source_pair.is_none());
        assert_eq!(reader.pending.capacity(), 0);
    }

    #[test]
    fn successful_window_control_includes_final_text_and_releases_admission() {
        let fixture = AudioFixture::wav(16_000, 1, ASR_WINDOW_SAMPLES + 19, |_, _| 8000);
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let mut sizes = Vec::new();
        let text = process_audio_windows(
            &mut reader,
            || Ok(()),
            |samples| {
                sizes.push(samples.len());
                Ok(format!("window{}", sizes.len()))
            },
        )
        .unwrap();
        assert_eq!(text, "window1 window2");
        assert_eq!(sizes, [ASR_WINDOW_SAMPLES, 19]);
        assert!(!reader.has_more());
    }

    #[test]
    fn timed_windows_start_where_the_previous_window_ended() {
        // A one-second dip at 28 s gives the reader a pause to cut in, so the
        // first window is shorter than the limit and the second starts at the
        // cut, not at 30 s.
        let fixture = AudioFixture::wav(16_000, 1, 65 * 16_000, |frame, _| {
            if (28 * 16_000..29 * 16_000).contains(&frame) {
                0
            } else {
                8000
            }
        });
        let mut reader = AudioWindowReader::open(&fixture.0).unwrap();
        let windows = process_timed_audio_windows(
            &mut reader,
            || Ok(()),
            |samples, start| Ok((start, samples.len())),
        )
        .unwrap();
        assert!(windows.len() >= 3, "{windows:?}");
        assert!(windows[0].1 < ASR_WINDOW_SAMPLES, "{windows:?}");
        let mut expected = 0usize;
        for (start, len) in &windows {
            assert!((start - expected as f64 / 16_000.0).abs() < 1e-9);
            expected += len;
        }
        assert_eq!(expected, 65 * 16_000);
    }

    #[test]
    fn known_host_buffer_counts_are_checked_and_bounded_by_window() {
        assert_eq!(moonshine_host_bytes(480_000).unwrap(), 13_505_536);
        assert_eq!(parakeet_host_bytes(480_000).unwrap(), 16_492_576);
        assert!(moonshine_host_bytes(usize::MAX).is_err());
        assert!(parakeet_host_bytes(usize::MAX).is_err());
    }
}
