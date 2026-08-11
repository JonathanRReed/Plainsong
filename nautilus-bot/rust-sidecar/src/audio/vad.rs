//! Voice Activity Detection (VAD) for automatic speech segmentation
//!
//! Uses energy-based detection with adaptive thresholds
//! to identify speech vs silence segments.
/// VAD configuration
#[derive(Debug, Clone)]
pub struct VadConfig {
    /// Frame size in samples (typically 10-30ms)
    pub frame_size: usize,
    /// Sample rate
    pub sample_rate: u32,
    /// Energy threshold for speech (adaptive if None)
    pub threshold_db: Option<f32>,
    /// Minimum speech duration in seconds
    pub min_speech_duration: f32,
    /// Minimum silence duration to split segments
    pub min_silence_duration: f32,
    /// Padding at start/end of segments in seconds
    pub padding_seconds: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            frame_size: 480, // 30ms at 16kHz
            sample_rate: 16000,
            threshold_db: None, // Auto-detect
            min_speech_duration: 0.5,
            min_silence_duration: 0.3,
            padding_seconds: 0.1,
        }
    }
}

/// A detected speech segment
#[derive(Debug, Clone)]
#[expect(
    dead_code,
    reason = "VAD segment metadata is retained for diagnostics and future serialized QA evidence"
)]
pub struct SpeechSegment {
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Average energy in dB
    pub avg_energy_db: f32,
    /// Confidence (0.0-1.0)
    pub confidence: f32,
}

/// Voice Activity Detector
pub struct VoiceActivityDetector {
    config: VadConfig,
    /// Running energy history for adaptive threshold
    energy_history: Vec<f32>,
    /// Current adaptive threshold
    adaptive_threshold: f32,
}

impl VoiceActivityDetector {
    pub fn new(config: VadConfig) -> Self {
        Self {
            config,
            energy_history: Vec::with_capacity(1000),
            adaptive_threshold: -40.0, // Default -40dB
        }
    }

    /// Process audio and detect speech segments
    pub fn detect_speech(&mut self, samples: &[f32]) -> Vec<SpeechSegment> {
        let frame_size = self.config.frame_size;
        let sample_rate = self.config.sample_rate as f32;

        // Calculate frame energies
        let mut frames: Vec<(usize, f32)> = Vec::new();
        for (i, chunk) in samples.chunks(frame_size).enumerate() {
            let energy = calculate_energy_db(chunk);
            frames.push((i, energy));

            // Update adaptive threshold
            self.energy_history.push(energy);
            if self.energy_history.len() > 1000 {
                self.energy_history.remove(0);
            }
        }

        // Update adaptive threshold based on energy history
        if self.config.threshold_db.is_none() && !self.energy_history.is_empty() {
            let noise_floor = percentile(&self.energy_history, 0.1);
            self.adaptive_threshold = noise_floor + 15.0; // 15dB above noise floor
        } else if let Some(threshold) = self.config.threshold_db {
            self.adaptive_threshold = threshold;
        }

        // Find speech segments
        let threshold = self.adaptive_threshold;
        let min_speech_frames =
            (self.config.min_speech_duration * sample_rate / frame_size as f32).ceil() as usize;
        let min_silence_frames =
            (self.config.min_silence_duration * sample_rate / frame_size as f32).ceil() as usize;
        let padding_frames =
            (self.config.padding_seconds * sample_rate / frame_size as f32).ceil() as usize;

        let mut segments = Vec::new();
        let mut in_speech = false;
        let mut speech_start = 0;
        let mut silence_count = 0;
        let mut segment_energies = Vec::new();

        for (i, energy) in frames.iter() {
            if *energy > threshold {
                if !in_speech {
                    // Start of speech
                    in_speech = true;
                    speech_start = i.saturating_sub(padding_frames);
                    segment_energies.clear();
                }
                segment_energies.push(*energy);
                silence_count = 0;
            } else if in_speech {
                silence_count += 1;
                if silence_count >= min_silence_frames {
                    // End of speech
                    let speech_end = (i - silence_count + 1 + padding_frames).min(frames.len() - 1);
                    let speech_duration = speech_end.saturating_sub(speech_start);

                    if speech_duration >= min_speech_frames {
                        let avg_energy = if !segment_energies.is_empty() {
                            segment_energies.iter().sum::<f32>() / segment_energies.len() as f32
                        } else {
                            threshold
                        };

                        segments.push(SpeechSegment {
                            start: speech_start as f64 * frame_size as f64 / sample_rate as f64,
                            end: speech_end as f64 * frame_size as f64 / sample_rate as f64,
                            avg_energy_db: avg_energy,
                            confidence: ((avg_energy - threshold) / 20.0).clamp(0.0, 1.0),
                        });
                    }

                    in_speech = false;
                    segment_energies.clear();
                }
            }
        }

        // Handle trailing speech
        if in_speech {
            let speech_end = frames.len() - 1;
            let speech_duration = speech_end.saturating_sub(speech_start);

            if speech_duration >= min_speech_frames {
                let avg_energy = if !segment_energies.is_empty() {
                    segment_energies.iter().sum::<f32>() / segment_energies.len() as f32
                } else {
                    threshold
                };

                segments.push(SpeechSegment {
                    start: speech_start as f64 * frame_size as f64 / sample_rate as f64,
                    end: speech_end as f64 * frame_size as f64 / sample_rate as f64,
                    avg_energy_db: avg_energy,
                    confidence: ((avg_energy - threshold) / 20.0).clamp(0.0, 1.0),
                });
            }
        }

        segments
    }
}

/// Calculate energy in dB for a frame
pub(crate) fn calculate_energy_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -100.0;
    }

    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / samples.len() as f32).sqrt();

    if rms < 1e-10 {
        -100.0
    } else {
        20.0 * rms.log10()
    }
}

/// Calculate percentile of a slice
fn percentile(data: &[f32], p: f32) -> f32 {
    if data.is_empty() {
        return -100.0;
    }

    let mut sorted = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let index = ((sorted.len() - 1) as f32 * p) as usize;
    sorted[index.min(sorted.len() - 1)]
}

/// Edge event emitted by [`StreamingVadGate::push_frame`].
///
/// The gate is a simple two-state (speech / silence) machine with hysteresis:
/// it only reports an edge once the *new* state has been sustained for a
/// minimum run of frames, so brief dips or spikes don't cause flapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadEdge {
    /// Sustained energy above the noise floor was just confirmed after a
    /// period of silence (or at startup).
    SpeechStarted,
    /// Sustained quiet was just confirmed after a period of speech.
    SilenceStarted,
    /// No confirmed state transition on this frame.
    NoChange,
}

/// Which speech/silence-gate implementation a dictation session should use.
///
/// Mirrors the `AsrProviderType` pattern used to select swappable ASR
/// backends (`crate::asr::AsrProviderType` + `AsrProviderFactory`): a small,
/// serializable, `Copy` enum that a settings string maps onto, with a
/// factory (`build_vad_gate`, in this module) that turns a `VadBackendKind`
/// into a boxed trait object. Callers (the cpal capture callback in
/// `audio.rs`) only ever hold a `Box<dyn VadGate>` and call `push_samples` /
/// `is_speaking` / `frames_per_second` -- they do not know or care which
/// concrete backend is underneath.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum VadBackendKind {
    /// The original O(1)-per-frame energy/RMS-threshold heuristic
    /// (`StreamingVadGate`). Always available; no model download required.
    #[default]
    EnergyThreshold,
    /// The Silero ONNX speech-probability model (`SileroVadDetector`),
    /// wrapped so it produces the same [`VadEdge`] stream as
    /// `StreamingVadGate`. Falls back to `EnergyThreshold` automatically if
    /// the model isn't downloaded, fails to load, or errors at runtime (see
    /// `crate::audio::silero_vad::SileroBackedVadGate`).
    Silero,
}

impl VadBackendKind {
    /// Parse from the `dictation_vad_backend` settings string. Unknown/empty
    /// values default to `EnergyThreshold` (the pre-existing, always-safe
    /// behavior) rather than erroring, matching how other stringly-typed
    /// settings in this codebase (e.g. `dictation_route_preference`) are
    /// normalized leniently.
    pub fn from_settings_str(value: &str) -> Self {
        match value {
            "silero" => VadBackendKind::Silero,
            _ => VadBackendKind::EnergyThreshold,
        }
    }

    pub fn as_settings_str(&self) -> &'static str {
        match self {
            VadBackendKind::EnergyThreshold => "energy_threshold",
            VadBackendKind::Silero => "silero",
        }
    }
}

/// Uniform speech/silence gate interface implemented by both the
/// energy-threshold heuristic ([`StreamingVadGate`], via
/// [`EnergyThresholdVadGate`]) and the Silero ONNX-backed detector
/// (`crate::audio::silero_vad::SileroBackedVadGate`).
///
/// This is the seam that lets `audio.rs`'s capture callback and the
/// hands-free monitor drive either backend identically: both `start_dictation`
/// and `start_hands_free_monitor` build a `Box<dyn VadGate + Send>` once (via
/// `build_vad_gate`) and thereafter only call trait methods, so the auto-stop
/// / auto-start call sites' contracts (feed samples in, get a `VadEdge` out)
/// never change based on which backend is active.
///
/// Implementations consume raw mono `f32` PCM samples (not a single
/// precomputed RMS-dB scalar) because Silero needs the raw waveform for its
/// own internal chunking; `EnergyThresholdVadGate` derives the RMS-dB value
/// itself from each frame internally, so both backends still fit one method.
pub trait VadGate {
    /// Feed a contiguous span of mono `f32` PCM samples (as produced by one
    /// cpal callback tick) into the gate. Implementations frame/chunk
    /// internally in whatever unit their algorithm needs, and return the
    /// most significant edge observed while consuming `mono_samples` (i.e. if
    /// multiple internal frames/chunks were processed, `SilenceStarted` or
    /// `SpeechStarted` -- whichever fired -- takes priority over
    /// `NoChange`; only one edge fires per unbroken state, same as
    /// `StreamingVadGate::push_frame`'s per-frame contract).
    fn push_samples(&mut self, mono_samples: &[f32]) -> VadEdge;

    /// Whether the gate is currently latched into the "speech" state.
    fn is_speaking(&self) -> bool;

    /// Frames (or model chunks) per second this gate was configured with,
    /// forwarded to callers/events exactly as `StreamingVadGate::frames_per_second`
    /// already is.
    fn frames_per_second(&self) -> f32;

    /// Human-readable name of the backend actually driving this gate right
    /// now (e.g. for logging/diagnostics). A gate that has fallen back
    /// internally (see `SileroBackedVadGate`) should report the backend it
    /// fell back *to*, not the one it was originally configured for.
    fn backend_name(&self) -> &'static str;
}

/// Adapts [`StreamingVadGate`] (which consumes one pre-computed RMS-dB value
/// per frame via `push_frame`) to the sample-based [`VadGate`] trait: it
/// chunks incoming samples into `frame_size`-sample frames itself (mirroring
/// `drive_dictation_auto_stop_gate`'s existing chunking loop in `audio.rs`)
/// and computes each frame's energy via [`calculate_energy_db`].
pub struct EnergyThresholdVadGate {
    gate: StreamingVadGate,
    frame_size: usize,
    /// Samples accumulated towards the next full `frame_size` frame.
    /// `StreamingVadGate` converts hysteresis durations to frame counts
    /// assuming every `push_frame` call represents exactly `frame_size`
    /// samples, so partial cpal callback buffers must be carried across
    /// `push_samples` calls rather than each counted as a whole frame
    /// (which would make silence timeouts fire several times too fast).
    /// Mirrors `SileroBackedVadGate::pending_samples`.
    pending_samples: Vec<f32>,
}

impl EnergyThresholdVadGate {
    pub fn new(config: &VadConfig) -> Self {
        let frame_size = config.frame_size.max(1);
        Self {
            gate: StreamingVadGate::new(config),
            frame_size,
            pending_samples: Vec::with_capacity(frame_size),
        }
    }
}

impl VadGate for EnergyThresholdVadGate {
    fn push_samples(&mut self, mono_samples: &[f32]) -> VadEdge {
        let mut most_significant = VadEdge::NoChange;
        self.pending_samples.extend_from_slice(mono_samples);
        let mut frame_start = 0;
        while self.pending_samples.len() - frame_start >= self.frame_size {
            let frame_end = frame_start + self.frame_size;
            let energy_db = calculate_energy_db(&self.pending_samples[frame_start..frame_end]);
            let edge = self.gate.push_frame(energy_db);
            if edge != VadEdge::NoChange {
                most_significant = edge;
            }
            frame_start = frame_end;
        }
        // Keep any leftover partial frame for the next call.
        if frame_start > 0 {
            self.pending_samples.drain(0..frame_start);
        }
        most_significant
    }

    fn is_speaking(&self) -> bool {
        self.gate.is_speaking()
    }

    fn frames_per_second(&self) -> f32 {
        self.gate.frames_per_second()
    }

    fn backend_name(&self) -> &'static str {
        "energy_threshold"
    }
}

/// Cheap, streaming (per-frame) speech/silence gate.
///
/// This is an *additive* sibling to [`VoiceActivityDetector`]: that type scans
/// a full, already-captured buffer offline (used today for silence-trimming).
/// `StreamingVadGate` instead consumes one frame's RMS-dB value at a time —
/// e.g. from the live cpal input callback — and is O(1) per call with no
/// heap allocation in `push_frame`, so it is safe to drive from a real-time
/// audio thread or a hot polling loop.
///
/// The adaptive noise floor and hysteresis behavior are deliberately derived
/// from the same [`VadConfig`] knobs the batch detector uses
/// (`min_speech_duration`, `min_silence_duration`, the "+15dB above noise
/// floor" adaptive threshold, and the `-40.0` dB default threshold), just
/// re-expressed as running frame counts / an exponential moving average
/// instead of a full-buffer scan + percentile, since a percentile can't be
/// computed in O(1) without buffering.
pub struct StreamingVadGate {
    /// Frames per second, derived from `config.sample_rate / config.frame_size`.
    frames_per_second: f32,
    /// Fixed threshold in dB, if configured (mirrors `VadConfig::threshold_db`).
    fixed_threshold_db: Option<f32>,
    /// Running noise-floor estimate (EMA), seeded at the same -40dB default
    /// the batch detector starts its adaptive threshold at.
    noise_floor_db: f32,
    /// How many frames of confirmed speech are required before emitting
    /// `SpeechStarted` (derived from `min_speech_duration`).
    min_speech_frames: u32,
    /// How many frames of confirmed silence are required before emitting
    /// `SilenceStarted` (derived from `min_silence_duration`).
    min_silence_frames: u32,
    /// Whether the gate is currently latched into the "speech" state.
    in_speech: bool,
    /// Consecutive frames above threshold seen while not yet in speech.
    above_run: u32,
    /// Quiet frames inside a candidate speech onset. Short consonant and
    /// inter-syllable dips preserve the accumulated loud frames; a real pause
    /// clears them so isolated clicks cannot add up to speech.
    onset_gap_run: u32,
    /// Maximum quiet gap tolerated while accumulating the speech onset.
    max_onset_gap_frames: u32,
    /// Consecutive frames at/below threshold seen while in speech.
    below_run: u32,
}

/// How far above the noise floor a frame's energy must be to count as
/// speech. Mirrors the `+ 15.0` adaptive-threshold offset used by
/// [`VoiceActivityDetector::detect_speech`].
const NOISE_FLOOR_MARGIN_DB: f32 = 15.0;

/// Smoothing factor for the running noise-floor EMA. Only frames that look
/// like silence (below the current threshold) are folded in, mirroring how
/// the batch detector's percentile(0.1) is dominated by the quietest frames.
/// Small alpha means the floor adapts over roughly a couple of seconds of
/// audio rather than jumping around frame-to-frame.
const NOISE_FLOOR_EMA_ALPHA: f32 = 0.05;

/// Speech energy naturally dips between syllables. Requiring every frame in
/// the onset window to stay above threshold makes ordinary speech fail to arm
/// hands-free dictation, especially with laptop microphones. A 120 ms gap is
/// short enough to join syllables while still rejecting separated noises.
const MAX_SPEECH_ONSET_GAP_SECONDS: f32 = 0.12;

impl StreamingVadGate {
    /// Build a gate whose adaptive-threshold and hysteresis behavior are
    /// derived from `config`, the same [`VadConfig`] used by the batch
    /// [`VoiceActivityDetector`].
    pub fn new(config: &VadConfig) -> Self {
        let frames_per_second = config.sample_rate as f32 / config.frame_size as f32;
        let min_speech_frames = (config.min_speech_duration * frames_per_second)
            .ceil()
            .max(1.0) as u32;
        let min_silence_frames = (config.min_silence_duration * frames_per_second)
            .ceil()
            .max(1.0) as u32;
        let max_onset_gap_frames = (MAX_SPEECH_ONSET_GAP_SECONDS * frames_per_second)
            .ceil()
            .max(1.0) as u32;

        Self {
            frames_per_second,
            fixed_threshold_db: config.threshold_db,
            noise_floor_db: -40.0, // Same default the batch detector seeds `adaptive_threshold` with.
            min_speech_frames,
            min_silence_frames,
            in_speech: false,
            above_run: 0,
            onset_gap_run: 0,
            max_onset_gap_frames,
            below_run: 0,
        }
    }

    /// Current effective threshold in dB: either the fixed configured
    /// threshold, or `noise_floor + NOISE_FLOOR_MARGIN_DB` when adaptive.
    fn threshold_db(&self) -> f32 {
        self.fixed_threshold_db
            .unwrap_or(self.noise_floor_db + NOISE_FLOOR_MARGIN_DB)
    }

    /// Feed one frame's RMS energy (in dB, e.g. from `calculate_energy_db`)
    /// into the gate. O(1), no allocation.
    pub fn push_frame(&mut self, rms_db: f32) -> VadEdge {
        let threshold = self.threshold_db();
        let is_above = rms_db > threshold;

        // Only adapt the noise floor from frames that look quiet, so loud
        // speech doesn't drag the floor (and therefore the threshold) upward.
        if self.fixed_threshold_db.is_none() && !is_above {
            self.noise_floor_db += (rms_db - self.noise_floor_db) * NOISE_FLOOR_EMA_ALPHA;
        }

        let mut edge = VadEdge::NoChange;

        if is_above {
            self.below_run = 0;
            if !self.in_speech {
                self.onset_gap_run = 0;
                self.above_run += 1;
                if self.above_run >= self.min_speech_frames {
                    self.in_speech = true;
                    self.above_run = 0;
                    self.onset_gap_run = 0;
                    edge = VadEdge::SpeechStarted;
                }
            }
        } else if self.in_speech {
            self.below_run += 1;
            if self.below_run >= self.min_silence_frames {
                self.in_speech = false;
                self.below_run = 0;
                edge = VadEdge::SilenceStarted;
            }
        } else if self.above_run > 0 {
            self.onset_gap_run += 1;
            if self.onset_gap_run >= self.max_onset_gap_frames {
                self.above_run = 0;
                self.onset_gap_run = 0;
            }
        }

        edge
    }

    /// Whether the gate is currently latched into the "speech" state.
    pub fn is_speaking(&self) -> bool {
        self.in_speech
    }

    /// Frames per second this gate was configured with (useful for callers
    /// converting frame counts back to durations).
    pub fn frames_per_second(&self) -> f32 {
        self.frames_per_second
    }
}

/// Pre-process audio with VAD to trim silence
pub fn trim_silence(samples: &[f32], sample_rate: u32, threshold_db: f32) -> Vec<f32> {
    let mut vad = VoiceActivityDetector::new(VadConfig {
        sample_rate,
        threshold_db: Some(threshold_db),
        min_speech_duration: 0.1, // Very short for trimming
        min_silence_duration: 0.05,
        padding_seconds: 0.05,
        ..Default::default()
    });

    let segments = vad.detect_speech(samples);

    if segments.is_empty() {
        return samples.to_vec();
    }

    let Some(first_segment) = segments.first() else {
        return samples.to_vec();
    };
    let Some(last_segment) = segments.last() else {
        return samples.to_vec();
    };

    let start_sample =
        ((first_segment.start * sample_rate as f64).floor() as usize).min(samples.len());
    let end_sample = ((last_segment.end * sample_rate as f64).ceil() as usize).min(samples.len());

    if end_sample <= start_sample {
        return samples.to_vec();
    }

    let retained_len = end_sample.saturating_sub(start_sample);
    if retained_len == 0 {
        return samples.to_vec();
    }

    let original_len = samples.len().max(1);
    let kept_ratio = retained_len as f32 / original_len as f32;
    let leading_trim_seconds = start_sample as f32 / sample_rate as f32;
    let trailing_trim_seconds =
        (samples.len().saturating_sub(end_sample)) as f32 / sample_rate as f32;

    // If VAD wants to throw away a large chunk from the front, it likely missed a quiet
    // opening speaker. In that case keep the original audio instead of being destructive.
    if leading_trim_seconds > 0.75
        && leading_trim_seconds > (trailing_trim_seconds * 2.0)
        && kept_ratio < 0.8
    {
        return samples.to_vec();
    }

    samples[start_sample..end_sample].to_vec()
}

#[cfg(test)]
mod energy_gate_framing_tests {
    //! Regression tests for `EnergyThresholdVadGate`'s sample framing: each
    //! `push_frame` must represent exactly `frame_size` samples of audio, no
    //! matter how the incoming samples are sliced across `push_samples`
    //! calls (cpal callback buffers are typically much smaller than the 30ms
    //! VAD frame, and were previously each mis-counted as a full frame).
    use super::{EnergyThresholdVadGate, VadConfig, VadEdge, VadGate};

    fn gate() -> EnergyThresholdVadGate {
        EnergyThresholdVadGate::new(&VadConfig {
            frame_size: 160, // 10ms at 16kHz
            sample_rate: 16_000,
            threshold_db: Some(-40.0),
            min_speech_duration: 0.05,  // 5 frames = 800 samples
            min_silence_duration: 0.05, // 5 frames = 800 samples
            padding_seconds: 0.0,
        })
    }

    /// Push `samples` through `gate` in `buffer_len`-sample slices (like a
    /// cpal callback cadence smaller than the frame size), returning how
    /// many samples had been consumed when `expected` first fired.
    fn samples_until_edge(
        gate: &mut EnergyThresholdVadGate,
        samples: &[f32],
        buffer_len: usize,
        expected: VadEdge,
    ) -> Option<usize> {
        let mut consumed = 0;
        for chunk in samples.chunks(buffer_len) {
            consumed += chunk.len();
            if gate.push_samples(chunk) == expected {
                return Some(consumed);
            }
        }
        None
    }

    #[test]
    fn sub_frame_buffers_are_not_each_counted_as_a_full_frame() {
        let mut gate = gate();

        // 5 frames (800 samples) of sustained loud audio are required before
        // SpeechStarted. Delivered in 50-sample buffers, the edge must not
        // fire until ~800 samples have actually been consumed -- the old
        // chunking counted every 50-sample buffer as a 160-sample frame and
        // would have fired after only 250 samples.
        let loud = vec![0.5_f32; 1600];
        let consumed = samples_until_edge(&mut gate, &loud, 50, VadEdge::SpeechStarted)
            .expect("speech edge must eventually fire");
        assert_eq!(
            consumed, 800,
            "speech must arm after exactly min_speech frames worth of samples"
        );

        // Same for the silence timeout: 5 frames (800 samples) of quiet.
        let quiet = vec![0.0_f32; 1600];
        let consumed = samples_until_edge(&mut gate, &quiet, 50, VadEdge::SilenceStarted)
            .expect("silence edge must eventually fire");
        assert_eq!(
            consumed, 800,
            "silence timeout must take the full configured duration of real samples"
        );
    }

    #[test]
    fn framing_is_independent_of_push_granularity() {
        // The number of samples needed to trip each edge must be identical
        // whether audio arrives in tiny buffers, odd-sized buffers, or one
        // exact-multiple slab.
        for buffer_len in [1_usize, 53, 160, 480, 1600] {
            let mut gate = gate();
            let loud = vec![0.5_f32; 1600];
            let consumed = samples_until_edge(&mut gate, &loud, buffer_len, VadEdge::SpeechStarted)
                .expect("speech edge must fire");
            // The edge is only observable at a push boundary, so allow the
            // edge to surface within the buffer that completes frame 5.
            assert!(
                (800..800 + buffer_len).contains(&consumed),
                "buffer_len {buffer_len}: speech fired after {consumed} samples"
            );
        }
    }

    #[test]
    fn partial_frame_tail_carries_over_between_calls() {
        let mut gate = gate();
        // 4.5 frames of loud audio: not enough to arm speech...
        gate.push_samples(&vec![0.5_f32; 720]);
        assert!(!gate.is_speaking());
        // ...but the 80-sample tail must be remembered, so 80 more samples
        // complete frame 5 and fire the edge.
        assert_eq!(
            gate.push_samples(&vec![0.5_f32; 80]),
            VadEdge::SpeechStarted
        );
        assert!(gate.is_speaking());
    }
}

#[cfg(test)]
mod tests {
    use super::{trim_silence, StreamingVadGate, VadConfig, VadEdge};

    fn repeated_sample(amplitude: f32, sample_rate: u32, seconds: usize) -> Vec<f32> {
        vec![amplitude; sample_rate as usize * seconds]
    }

    #[test]
    fn trim_silence_keeps_quiet_opening_when_vad_would_trim_too_much() {
        let sample_rate = 16_000;
        let mut samples = repeated_sample(0.003, sample_rate, 6);
        samples.extend(repeated_sample(0.05, sample_rate, 4));

        let trimmed = trim_silence(&samples, sample_rate, -40.0);

        assert_eq!(trimmed.len(), samples.len());
    }

    #[test]
    fn trim_silence_still_removes_clear_leading_and_trailing_dead_air() {
        let sample_rate = 16_000;
        let mut samples = repeated_sample(0.0, sample_rate, 1);
        samples.extend(repeated_sample(0.06, sample_rate, 2));
        samples.extend(repeated_sample(0.0, sample_rate, 1));

        let trimmed = trim_silence(&samples, sample_rate, -40.0);

        assert!(trimmed.len() < samples.len());
        assert!(trimmed.len() > sample_rate as usize);
    }

    /// Test config: fixed threshold (no adaptive noise-floor drift to reason
    /// about), 100ms min speech / 100ms min silence at 100 frames/sec
    /// (10ms "frames" -- we're feeding synthetic dB values directly, one
    /// `push_frame` call standing in for one frame), so both hysteresis
    /// windows are exactly 10 frames.
    fn fixed_threshold_gate() -> StreamingVadGate {
        StreamingVadGate::new(&VadConfig {
            frame_size: 160, // 10ms at 16kHz
            sample_rate: 16_000,
            threshold_db: Some(-40.0),
            min_speech_duration: 0.1,
            min_silence_duration: 0.1,
            padding_seconds: 0.0,
        })
    }

    const LOUD_DB: f32 = -10.0;
    const QUIET_DB: f32 = -60.0;

    #[test]
    fn streaming_gate_detects_speech_start_after_sustained_energy() {
        let mut gate = fixed_threshold_gate();

        // Fewer than min_speech_frames (10) loud frames: no edge yet.
        let mut edges = Vec::new();
        for _ in 0..9 {
            edges.push(gate.push_frame(LOUD_DB));
        }
        assert!(
            edges.iter().all(|e| *e == VadEdge::NoChange),
            "should not fire before sustained run is long enough: {edges:?}"
        );
        assert!(!gate.is_speaking());

        // The 10th consecutive loud frame confirms speech.
        let edge = gate.push_frame(LOUD_DB);
        assert_eq!(edge, VadEdge::SpeechStarted);
        assert!(gate.is_speaking());
    }

    #[test]
    fn streaming_gate_tolerates_short_natural_gaps_during_speech_onset() {
        let mut gate = fixed_threshold_gate();

        // Human speech rarely stays above an RMS threshold for 100 ms with no
        // 10-20 ms consonant or inter-syllable dip. Ten loud frames separated
        // by a short two-frame gap still represent sustained speech.
        for _ in 0..5 {
            assert_eq!(gate.push_frame(LOUD_DB), VadEdge::NoChange);
        }
        for _ in 0..2 {
            assert_eq!(gate.push_frame(QUIET_DB), VadEdge::NoChange);
        }
        for _ in 0..4 {
            assert_eq!(gate.push_frame(LOUD_DB), VadEdge::NoChange);
        }
        assert_eq!(gate.push_frame(LOUD_DB), VadEdge::SpeechStarted);
        assert!(gate.is_speaking());
    }

    #[test]
    fn streaming_gate_still_rejects_isolated_noise_spikes() {
        let mut gate = fixed_threshold_gate();

        for _ in 0..5 {
            assert_eq!(gate.push_frame(LOUD_DB), VadEdge::NoChange);
            for _ in 0..15 {
                assert_eq!(gate.push_frame(QUIET_DB), VadEdge::NoChange);
            }
        }
        assert!(!gate.is_speaking());
    }

    #[test]
    fn streaming_gate_detects_silence_start_after_sustained_quiet_following_speech() {
        let mut gate = fixed_threshold_gate();

        for _ in 0..10 {
            gate.push_frame(LOUD_DB);
        }
        assert!(gate.is_speaking());

        // Fewer than min_silence_frames (10) quiet frames: still speaking.
        let mut edges = Vec::new();
        for _ in 0..9 {
            edges.push(gate.push_frame(QUIET_DB));
        }
        assert!(
            edges.iter().all(|e| *e == VadEdge::NoChange),
            "should not fire before sustained quiet run is long enough: {edges:?}"
        );
        assert!(gate.is_speaking());

        let edge = gate.push_frame(QUIET_DB);
        assert_eq!(edge, VadEdge::SilenceStarted);
        assert!(!gate.is_speaking());
    }

    #[test]
    fn streaming_gate_does_not_flap_on_brief_dips_or_spikes() {
        let mut gate = fixed_threshold_gate();

        for _ in 0..10 {
            gate.push_frame(LOUD_DB);
        }
        assert!(gate.is_speaking());

        // A brief 3-frame dip below threshold (shorter than the 10-frame
        // min_silence run) should not flip state.
        for _ in 0..3 {
            let edge = gate.push_frame(QUIET_DB);
            assert_eq!(edge, VadEdge::NoChange);
        }
        assert!(gate.is_speaking(), "brief dip should not end speech");

        // Back to loud resets the below-run counter; speech continues.
        let edge = gate.push_frame(LOUD_DB);
        assert_eq!(edge, VadEdge::NoChange);
        assert!(gate.is_speaking());

        // Now confirm silence for real.
        for _ in 0..9 {
            let edge = gate.push_frame(QUIET_DB);
            assert_eq!(edge, VadEdge::NoChange);
        }
        assert_eq!(gate.push_frame(QUIET_DB), VadEdge::SilenceStarted);
        assert!(!gate.is_speaking());

        // A brief 3-frame spike above threshold (shorter than the 10-frame
        // min_speech run) should not flip state back on.
        for _ in 0..3 {
            let edge = gate.push_frame(LOUD_DB);
            assert_eq!(edge, VadEdge::NoChange);
        }
        assert!(!gate.is_speaking(), "brief spike should not start speech");
    }

    #[test]
    fn streaming_gate_produces_correct_edge_sequence_over_loud_quiet_loud() {
        let mut gate = fixed_threshold_gate();
        let mut observed_edges = Vec::new();

        // 15 loud frames (speech confirmed on the 10th).
        for _ in 0..15 {
            let edge = gate.push_frame(LOUD_DB);
            if edge != VadEdge::NoChange {
                observed_edges.push(edge);
            }
        }

        // 20 quiet frames (silence confirmed on the 10th quiet frame).
        for _ in 0..20 {
            let edge = gate.push_frame(QUIET_DB);
            if edge != VadEdge::NoChange {
                observed_edges.push(edge);
            }
        }

        // 15 more loud frames (speech confirmed again on the 10th).
        for _ in 0..15 {
            let edge = gate.push_frame(LOUD_DB);
            if edge != VadEdge::NoChange {
                observed_edges.push(edge);
            }
        }

        assert_eq!(
            observed_edges,
            vec![
                VadEdge::SpeechStarted,
                VadEdge::SilenceStarted,
                VadEdge::SpeechStarted,
            ]
        );
    }

    #[test]
    fn streaming_gate_adaptive_threshold_tracks_noise_floor_like_batch_detector() {
        // No fixed threshold: adaptive mode, same -40dB seed and +15dB
        // margin as `VoiceActivityDetector`.
        let mut gate = StreamingVadGate::new(&VadConfig {
            frame_size: 160,
            sample_rate: 16_000,
            threshold_db: None,
            min_speech_duration: 0.1,
            min_silence_duration: 0.1,
            padding_seconds: 0.0,
        });

        // Quiet room tone well above the -40dB seed but still "silence":
        // should adapt the floor upward over many frames, folding in only
        // quiet (sub-threshold) frames.
        for _ in 0..200 {
            let edge = gate.push_frame(-55.0);
            assert_eq!(edge, VadEdge::NoChange);
        }
        assert!(!gate.is_speaking());

        // A frame at the old (-40 + 15 = -25dB) threshold is now well
        // between the adapted floor and old threshold; sustained energy at
        // -20dB should still register as clear speech.
        let mut fired = false;
        for _ in 0..15 {
            if gate.push_frame(-20.0) == VadEdge::SpeechStarted {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "sustained clearly-above-floor energy should start speech"
        );
    }
}
