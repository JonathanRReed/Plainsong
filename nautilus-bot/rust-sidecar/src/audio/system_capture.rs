//! System audio capture for macOS and Windows loopback devices.

use super::for_each_mono_sample;
use crate::sidecar_handle::SidecarHandle;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam::channel::TrySendError;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler, WindowFunction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Target input chunk for the capture-path resamplers. Rounded up internally by
/// rubato to a whole number of rate-ratio periods (1029 frames for 44.1 -> 48k),
/// so this is only a hint at the amount of latency the conversion adds.
const RESAMPLE_CHUNK_FRAMES: usize = 1024;

/// How long a source may deliver nothing before the mixer stops waiting for it
/// and pads its track with silence. Comfortably longer than any normal cpal
/// callback interval, so ordinary jitter is absorbed by the pending buffers and
/// only a genuinely stalled device triggers padding.
const SOURCE_STARVATION_TIMEOUT: Duration = Duration::from_millis(400);

/// Window the per-source silence watchdog evaluates its RMS over.
const SOURCE_RMS_WINDOW_SECONDS: f32 = 1.0;

/// RMS below which a window counts as digital silence (about -80 dBFS). A live
/// microphone's noise floor sits well above this; a device that has gone away
/// (or a loopback with nothing playing) sits at or near zero.
const SOURCE_SILENCE_RMS_THRESHOLD: f32 = 1.0e-4;

/// How many consecutive [`SOURCE_RMS_WINDOW_SECONDS`] windows must be mostly
/// padded before starvation counts as corroboration.
///
/// The mixer pads a source the moment it misses [`SOURCE_STARVATION_TIMEOUT`],
/// which a perfectly healthy loopback does on any ordinary scheduling stall —
/// display sleep, a Bluetooth route switch, a call app changing devices. One
/// such hiccup is not evidence of anything, so the padding has to *persist*: a
/// device that has actually gone away never delivers again, and pads every
/// window from then on.
const SOURCE_STARVATION_CORROBORATION_WINDOWS: u64 = 5;

/// Per-source rules for the silence watchdog.
///
/// The two sources fail differently, so they cannot share one rule. A live
/// microphone always carries a noise floor well above
/// [`SOURCE_SILENCE_RMS_THRESHOLD`], so exact zeros from one *are* the fault
/// signal. A loopback device legitimately reads as exact zeros the entire time
/// nobody on the far side is playing audio — which is most of a meeting where
/// you are the one talking — so silence there says nothing on its own.
struct SourceSilenceProfile {
    /// How long a previously-active source must stay digitally silent before
    /// the capture thread warns the UI.
    warn_after_seconds: f32,
    /// Whether silence alone is enough, or whether the source must also have
    /// stopped *delivering*, and stayed stopped, during the quiet span. A
    /// device that has gone away stops driving its cpal callback, which the
    /// mixer sees as starvation and pads for every window from then on; a
    /// device that is merely idle keeps handing over zero-filled buffers on
    /// schedule, pausing at most for the odd scheduling stall. That difference
    /// is the only evidence available that separates a dead loopback from a
    /// quiet one — see [`SOURCE_STARVATION_CORROBORATION_WINDOWS`] for how much
    /// of it is required.
    require_starvation_evidence: bool,
}

/// Digital silence from a microphone is itself the fault signal, so 30s of it
/// is warned about on its own.
const MIC_SILENCE_PROFILE: SourceSilenceProfile = SourceSilenceProfile {
    warn_after_seconds: 30.0,
    require_starvation_evidence: false,
};

/// A loopback needs corroboration and a much longer fuse: three minutes of
/// nothing playing is an ordinary stretch of an ordinary call.
const SYSTEM_SILENCE_PROFILE: SourceSilenceProfile = SourceSilenceProfile {
    warn_after_seconds: 180.0,
    require_starvation_evidence: true,
};

fn device_name(device: &cpal::Device) -> Result<String, cpal::Error> {
    Ok(device.description()?.name().to_string())
}

/// Downmix one cpal callback's interleaved buffer to mono and enqueue it.
///
/// Every other capture path in this crate (dictation, mic-only meetings, the
/// hands-free monitor) funnels through `for_each_mono_sample`; mixed capture has
/// to as well. Enqueueing raw interleaved samples makes a 2-channel loopback
/// device fill its queue at twice the frame rate of a mono mic, which the mixer
/// then reads back as half-speed, permanently drifting far-side audio.
fn push_normalized_samples<T>(
    data: &[T],
    num_channels: usize,
    buffer: &crossbeam::queue::ArrayQueue<f32>,
    dropped_samples: &AtomicU64,
) -> (u64, u64)
where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let mut frames = 0_u64;
    let mut non_silent_frames = 0_u64;
    for_each_mono_sample(data, num_channels, |normalized| {
        frames += 1;
        if normalized.abs() > SYSTEM_AUDIO_TEST_NON_SILENT_THRESHOLD {
            non_silent_frames += 1;
        }
        if buffer.push(normalized).is_err() {
            let _ = buffer.pop();
            let _ = buffer.push(normalized);
            dropped_samples.fetch_add(1, Ordering::Relaxed);
        }
    });
    (frames, non_silent_frames)
}

/// Sample-rate conversion for one capture source, applied on the mixing thread.
///
/// CoreAudio picks a rate per device, and a 44.1 kHz built-in mic against a
/// 48 kHz BlackHole is the normal macOS default rather than a misconfiguration.
/// Whichever source isn't already at the session's target rate is converted
/// here, so the mixer only ever aligns frames that share one clock.
///
/// Deliberately *not* run inside the cpal callbacks: those are macro-generated
/// once per sample format for each source, and keeping the conversion on the
/// mixing thread leaves it lock-free, allocation-free in steady state, and
/// unit-testable on its own.
struct SourceResampler {
    resampler: Fft<f32>,
    /// Source-rate frames received but not yet consumed by a full chunk.
    pending: Vec<f32>,
    /// Reusable target-rate scratch, sized once to the resampler's maximum.
    scratch: Vec<f32>,
    total_input_frames: u64,
    total_output_frames: u64,
}

impl SourceResampler {
    fn new(source_rate: u32, target_rate: u32) -> Result<Self> {
        // `new_custom`, not `new`: rubato 4's `new` derives `sub_chunks` from the
        // chunk size (1024 / 256 = 4), which would shorten the internal FFT block
        // and change this path's conversion latency. One sub-chunk is what this
        // resampler has always used, and it is what rounds the input chunk to the
        // 1029 frames documented on `RESAMPLE_CHUNK_FRAMES`. `BlackmanHarris2` is
        // the window rubato 3 applied unconditionally.
        let resampler = Fft::<f32>::new_custom(
            source_rate as usize,
            target_rate as usize,
            RESAMPLE_CHUNK_FRAMES,
            1,
            1,
            WindowFunction::BlackmanHarris2,
            FixedSync::Input,
        )
        .map_err(|error| {
            anyhow::anyhow!(
                "Failed to build a {} Hz -> {} Hz resampler: {}",
                source_rate,
                target_rate,
                error
            )
        })?;
        let pending = Vec::with_capacity(resampler.input_frames_max() * 2);
        let scratch = vec![0.0; resampler.output_frames_max()];
        Ok(Self {
            resampler,
            pending,
            scratch,
            total_input_frames: 0,
            total_output_frames: 0,
        })
    }

    /// Append `samples` (mono, at the source rate) and drain every full chunk
    /// the resampler can produce onto `out` (mono, at the target rate).
    fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        let Self {
            resampler,
            pending,
            scratch,
            total_input_frames,
            total_output_frames,
        } = self;
        *total_input_frames = total_input_frames.saturating_add(samples.len() as u64);
        pending.extend_from_slice(samples);

        let mut consumed = 0usize;
        loop {
            let needed = resampler.input_frames_next();
            if needed == 0 || pending.len() - consumed < needed {
                break;
            }
            let produced = resampler.output_frames_next();
            if scratch.len() < produced {
                scratch.resize(produced, 0.0);
            }

            let Ok(source) =
                InterleavedSlice::new(&pending[consumed..consumed + needed], 1, needed)
            else {
                break;
            };
            let Ok(mut sink) = InterleavedSlice::new_mut(&mut scratch[..produced], 1, produced)
            else {
                break;
            };

            match resampler.process_into_buffer(&source, &mut sink, None) {
                Ok((read, written)) => {
                    out.extend_from_slice(&scratch[..written]);
                    *total_output_frames = total_output_frames.saturating_add(written as u64);
                    consumed += read;
                    if read == 0 {
                        break;
                    }
                }
                Err(error) => {
                    tracing::warn!("Mixed capture resampler error: {}", error);
                    break;
                }
            }
        }

        pending.drain(0..consumed);
    }

    /// Flush the final partial source-rate chunk at a route boundary.
    ///
    /// Replacing the converter without flushing loses up to one full resampler
    /// chunk from the old route. Process the valid prefix as a partial chunk and
    /// keep only the duration represented by those real input frames, rather
    /// than appending the zero padding used internally by rubato.
    fn finish(&mut self, out: &mut Vec<f32>) {
        let expected_total =
            (self.total_input_frames as f64 * self.resampler.resample_ratio()).ceil() as u64;
        if self.total_output_frames >= expected_total {
            self.pending.clear();
            return;
        }

        let pending_frames = self.pending.len();
        let needed = self.resampler.input_frames_next();
        self.pending.resize(needed, 0.0);
        let mut partial_len = Some(pending_frames);
        let mut flush_attempts = 0_u8;

        while self.total_output_frames < expected_total && flush_attempts < 8 {
            flush_attempts += 1;
            let produced = self.resampler.output_frames_next();
            if self.scratch.len() < produced {
                self.scratch.resize(produced, 0.0);
            }
            let Ok(source) = InterleavedSlice::new(&self.pending, 1, needed) else {
                break;
            };
            let Ok(mut sink) =
                InterleavedSlice::new_mut(&mut self.scratch[..produced], 1, produced)
            else {
                break;
            };
            let indexing = Indexing {
                input_offset: 0,
                output_offset: 0,
                partial_len,
                active_channels_mask: None,
            };
            match self
                .resampler
                .process_into_buffer(&source, &mut sink, Some(&indexing))
            {
                Ok((_read, written)) => {
                    let remaining = (expected_total - self.total_output_frames) as usize;
                    let retained = written.min(remaining);
                    out.extend_from_slice(&self.scratch[..retained]);
                    self.total_output_frames += retained as u64;
                    partial_len = Some(0);
                }
                Err(error) => {
                    tracing::warn!("Mixed capture resampler tail error: {}", error);
                    break;
                }
            }
        }
        self.pending.clear();
    }
}

/// Rolling-RMS silence watchdog for one capture source.
///
/// cpal only reports device failures through the stream error callback, and a
/// mid-meeting AirPods disconnect often doesn't raise one at all: the stream
/// simply keeps handing us zeros. This notices that the source has been
/// digitally silent for a while *after* having carried real audio, which is the
/// signal a user can act on.
///
/// What counts as "a while", and whether silence alone is enough, comes from
/// the source's [`SourceSilenceProfile`] — see there for why a loopback cannot
/// be judged by the same rule as a microphone.
struct SourceSilenceWatchdog {
    sample_rate: f32,
    window_frames: u64,
    warn_after_frames: u64,
    require_starvation_evidence: bool,
    frames_in_window: u64,
    window_sum_squares: f64,
    silent_frames: u64,
    /// Frames the mixer had to pad for this source within the window currently
    /// being filled.
    starved_frames_in_window: u64,
    /// Consecutive silent windows the mixer spent mostly padding this source:
    /// the corroborating evidence that the device stopped delivering rather
    /// than merely having nothing to deliver.
    consecutive_starved_windows: u64,
    was_active: bool,
    warned: bool,
}

impl SourceSilenceWatchdog {
    fn new(sample_rate: u32, profile: &SourceSilenceProfile) -> Self {
        let sample_rate = sample_rate.max(1);
        let window_frames = ((sample_rate as f32) * SOURCE_RMS_WINDOW_SECONDS)
            .round()
            .max(1.0) as u64;
        let warn_after_frames = ((sample_rate as f32) * profile.warn_after_seconds)
            .round()
            .max(1.0) as u64;
        Self {
            sample_rate: sample_rate as f32,
            window_frames,
            warn_after_frames,
            require_starvation_evidence: profile.require_starvation_evidence,
            frames_in_window: 0,
            window_sum_squares: 0.0,
            silent_frames: 0,
            starved_frames_in_window: 0,
            consecutive_starved_windows: 0,
            was_active: false,
            warned: false,
        }
    }

    /// Feed the frames just written for this source, along with how many of
    /// them the mixer had to pad because the device delivered nothing.
    ///
    /// Returns the silent duration, in seconds, the first time the source
    /// crosses its warning threshold after having been active; `None`
    /// otherwise. Re-arms once the source carries audio again, so a second
    /// dropout warns again.
    fn observe(&mut self, samples: &[f32], padded_frames: u64) -> Option<f32> {
        // Drains are far shorter than a window, so attributing a drain's
        // padding to the window it lands in is exact in practice and never off
        // by more than one drain at a boundary.
        self.starved_frames_in_window = self.starved_frames_in_window.saturating_add(padded_frames);

        let mut warning = None;
        for &sample in samples {
            self.window_sum_squares += (sample as f64) * (sample as f64);
            self.frames_in_window += 1;
            if self.frames_in_window < self.window_frames {
                continue;
            }

            let window_frames = self.frames_in_window;
            let rms = (self.window_sum_squares / window_frames as f64).sqrt() as f32;
            let starved_frames = std::mem::take(&mut self.starved_frames_in_window);
            self.window_sum_squares = 0.0;
            self.frames_in_window = 0;

            if rms >= SOURCE_SILENCE_RMS_THRESHOLD {
                self.was_active = true;
                self.silent_frames = 0;
                self.consecutive_starved_windows = 0;
                self.warned = false;
                continue;
            }

            self.silent_frames = self.silent_frames.saturating_add(window_frames);
            // A window the mixer spent mostly inventing is a window the device
            // did not deliver. One that it merely dipped into is jitter, and
            // the run resets — so a single stall cannot arm the warning for the
            // rest of the meeting.
            if starved_frames * 2 >= window_frames {
                self.consecutive_starved_windows += 1;
            } else {
                self.consecutive_starved_windows = 0;
            }

            let corroborated = !self.require_starvation_evidence
                || self.consecutive_starved_windows >= SOURCE_STARVATION_CORROBORATION_WINDOWS;
            if self.was_active
                && !self.warned
                && corroborated
                && self.silent_frames >= self.warn_after_frames
            {
                self.warned = true;
                warning = Some(self.silent_frames as f32 / self.sample_rate);
            }
        }
        warning
    }
}

/// One aligned drain's worth of counters, used by the tests and by the
/// end-of-session drift log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MixerFrameCounts {
    mixed: u64,
    mic: u64,
    system: u64,
    mic_padded: u64,
    system_padded: u64,
}

/// Time-aligned mixer for the microphone and system-audio sources.
///
/// The previous implementation popped one sample per source per iteration and
/// treated whatever came out as simultaneous, so any channel-count or rate
/// difference between the two devices turned into permanent, growing skew. This
/// keeps explicit per-source frame counts instead: a frame is only emitted once
/// every enabled source can cover it, and a source that has gone quiet long
/// enough to count as starved is padded with silence, so the mixed WAV and the
/// companion `_mic`/`_system` WAVs always hold the same number of frames for the
/// same instants.
struct FrameMixer {
    capture_mic: bool,
    capture_system: bool,
    mic_pending: VecDeque<f32>,
    system_pending: VecDeque<f32>,
    counts: MixerFrameCounts,
}

impl FrameMixer {
    fn new(capture_mic: bool, capture_system: bool) -> Self {
        Self {
            capture_mic,
            capture_system,
            mic_pending: VecDeque::new(),
            system_pending: VecDeque::new(),
            counts: MixerFrameCounts {
                mixed: 0,
                mic: 0,
                system: 0,
                mic_padded: 0,
                system_padded: 0,
            },
        }
    }

    fn push_mic(&mut self, samples: &[f32]) {
        self.mic_pending.extend(samples.iter().copied());
    }

    fn push_system(&mut self, samples: &[f32]) {
        self.system_pending.extend(samples.iter().copied());
    }

    fn counts(&self) -> MixerFrameCounts {
        self.counts
    }

    /// Number of frames that can be emitted right now.
    ///
    /// With both sources enabled that is normally the depth both can cover;
    /// jitter between the two callbacks is absorbed by the pending buffers
    /// rather than being written out as skew. `mic_starved`/`system_starved`
    /// release the frames a stalled source would otherwise block forever.
    fn releasable_frames(&self, mic_starved: bool, system_starved: bool) -> usize {
        let mic_depth = self.mic_pending.len();
        let system_depth = self.system_pending.len();
        match (self.capture_mic, self.capture_system) {
            (true, true) => {
                let aligned = mic_depth.min(system_depth);
                if aligned > 0 {
                    aligned
                } else {
                    // At most one buffer is non-empty here; release it only
                    // once the *other* source has been declared starved. Both
                    // checks run so a session teardown (which starves both) can
                    // still flush whichever side still holds frames.
                    let mut releasable = 0;
                    if mic_starved {
                        releasable = releasable.max(system_depth);
                    }
                    if system_starved {
                        releasable = releasable.max(mic_depth);
                    }
                    releasable
                }
            }
            (true, false) => mic_depth,
            (false, true) => system_depth,
            (false, false) => 0,
        }
    }

    /// Emit every releasable frame, appending to the mixed track and to each
    /// enabled source's own track. Returns the number of frames emitted; all
    /// three output buffers grow by exactly that many samples (the per-source
    /// ones only for sources that are enabled).
    fn drain_into(
        &mut self,
        mic_starved: bool,
        system_starved: bool,
        mixed_out: &mut Vec<f32>,
        mic_out: &mut Vec<f32>,
        system_out: &mut Vec<f32>,
    ) -> usize {
        let frames = self.releasable_frames(mic_starved, system_starved);
        if frames == 0 {
            return 0;
        }

        for _ in 0..frames {
            let mic = if self.capture_mic {
                match self.mic_pending.pop_front() {
                    Some(sample) => sample,
                    None => {
                        self.counts.mic_padded += 1;
                        0.0
                    }
                }
            } else {
                0.0
            };
            let system = if self.capture_system {
                match self.system_pending.pop_front() {
                    Some(sample) => sample,
                    None => {
                        self.counts.system_padded += 1;
                        0.0
                    }
                }
            } else {
                0.0
            };

            // Constant gain whenever both sources are enabled, including across
            // a dropout: switching to unity while one side is padded would put a
            // 3 dB step into the middle of the mixed track.
            let mixed = match (self.capture_mic, self.capture_system) {
                (true, true) => ((mic * 0.7) + (system * 0.7)).clamp(-1.0, 1.0),
                (true, false) => mic,
                (false, true) => system,
                (false, false) => 0.0,
            };

            mixed_out.push(mixed);
            if self.capture_mic {
                mic_out.push(mic);
            }
            if self.capture_system {
                system_out.push(system);
            }
        }

        self.counts.mixed += frames as u64;
        if self.capture_mic {
            self.counts.mic += frames as u64;
        }
        if self.capture_system {
            self.counts.system += frames as u64;
        }
        frames
    }
}

/// Hand one frame-aligned chunk to the WAV writer. A full channel drops the
/// mixed/mic/system bundle together so the companion files can never diverge.
/// Returns `false` when the receiver is gone and capture should stop.
fn forward_aligned_chunk(
    sender: &crossbeam::channel::Sender<MixedAudioChunk>,
    chunk: MixedAudioChunk,
    dropped_chunks: &AtomicU64,
) -> bool {
    match sender.try_send(chunk) {
        Ok(()) => true,
        Err(TrySendError::Disconnected(_)) => false,
        Err(TrySendError::Full(_)) => {
            dropped_chunks.fetch_add(1, Ordering::Relaxed);
            true
        }
    }
}

const NATIVE_TAP_API_FLOOR: MacOsVersion = MacOsVersion::new(14, 2, 0);
// CPAL 0.18.1 documents loopback as supported after 14.6. Keep the first
// production gate conservative until signed-app QA covers 14.2, 14.4 and 14.6.
const NATIVE_TAP_RELEASE_FLOOR: MacOsVersion = MacOsVersion::new(14, 7, 0);
const SYSTEM_AUDIO_TEST_TONE_HZ: f32 = 997.0;
const SYSTEM_AUDIO_TEST_TONE_AMPLITUDE: f32 = 0.04;
const SYSTEM_AUDIO_TEST_NON_SILENT_THRESHOLD: f32 = 1.0e-5;
const SYSTEM_ROUTE_STARTUP_GRACE: Duration = Duration::from_secs(5);
const SYSTEM_ROUTE_RETRY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioBackend {
    CoreAudioProcessTap,
    VirtualLoopback,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioReadiness {
    Ready,
    Unverified,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioFailureKind {
    UnsupportedOs,
    PermissionDenied,
    RouteChanged,
    SilentStream,
    NoEligibleRoute,
    StreamConstruction,
    StreamRuntime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioCapability {
    pub backend: SystemAudioBackend,
    pub native_os_supported: bool,
    pub native_os_enabled: bool,
    pub route_device: Option<String>,
    pub route_id: Option<String>,
    pub native_sample_rate: Option<u32>,
    pub native_channels: Option<u16>,
    pub readiness: SystemAudioReadiness,
    pub ready: bool,
    pub reason: Option<SystemAudioFailureKind>,
    pub actionable_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioVerificationMethod {
    KnownTone,
    ExternalAudio,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioTestResult {
    pub capability: SystemAudioCapability,
    pub callbacks: u64,
    pub captured_frames: u64,
    pub non_silent_frames: u64,
    pub peak: f32,
    pub expected_tone_hz: f32,
    pub detected_tone_amplitude: f64,
    pub verification_method: Option<SystemAudioVerificationMethod>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct MacOsVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl MacOsVersion {
    const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    fn parse(value: &str) -> Option<Self> {
        let mut parts = value.trim().split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        Some(Self::new(major, minor, patch))
    }
}

#[derive(Debug, Clone)]
struct NativeTapGate {
    api_supported: bool,
    enabled: bool,
    reason: Option<String>,
}

fn native_tap_gate_for_version(version: Option<MacOsVersion>) -> NativeTapGate {
    let Some(version) = version else {
        return NativeTapGate {
            api_supported: false,
            enabled: false,
            reason: Some(
                "Could not determine the macOS version. Use a virtual loopback device such as BlackHole."
                    .to_string(),
            ),
        };
    };
    if version < NATIVE_TAP_API_FLOOR {
        return NativeTapGate {
            api_supported: false,
            enabled: false,
            reason: Some(
                "Native system capture requires macOS 14.2 or later. On this Mac, install and route a virtual loopback device such as BlackHole."
                    .to_string(),
            ),
        };
    }
    if version < NATIVE_TAP_RELEASE_FLOOR {
        return NativeTapGate {
            api_supported: true,
            enabled: false,
            reason: Some(
                "Native system capture is conservatively disabled on macOS 14.2–14.6 pending signed-app QA. Use a virtual loopback device such as BlackHole."
                    .to_string(),
            ),
        };
    }
    NativeTapGate {
        api_supported: true,
        enabled: true,
        reason: None,
    }
}

#[cfg(target_os = "macos")]
fn current_macos_version() -> Option<MacOsVersion> {
    static VERSION: OnceLock<Option<MacOsVersion>> = OnceLock::new();
    *VERSION.get_or_init(|| {
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).to_string())
            .as_deref()
            .and_then(MacOsVersion::parse)
    })
}

#[cfg(not(target_os = "macos"))]
fn current_macos_version() -> Option<MacOsVersion> {
    None
}

fn native_tap_gate() -> NativeTapGate {
    #[cfg(target_os = "macos")]
    {
        native_tap_gate_for_version(current_macos_version())
    }
    #[cfg(not(target_os = "macos"))]
    {
        NativeTapGate {
            api_supported: false,
            enabled: false,
            reason: None,
        }
    }
}

fn verified_system_audio_route() -> &'static Mutex<Option<String>> {
    static VERIFIED_ROUTE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    VERIFIED_ROUTE.get_or_init(|| Mutex::new(None))
}

fn is_verified_system_audio_route(route_key: &str) -> bool {
    verified_system_audio_route()
        .lock()
        .map(|route| route.as_deref() == Some(route_key))
        .unwrap_or(false)
}

fn system_audio_failures() -> &'static Mutex<HashMap<String, (SystemAudioFailureKind, String)>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, (SystemAudioFailureKind, String)>>> =
        OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn failure_for_system_audio_route(route_key: &str) -> Option<(SystemAudioFailureKind, String)> {
    system_audio_failures()
        .lock()
        .ok()
        .and_then(|failures| failures.get(route_key).cloned())
}

fn mark_system_audio_route_verified(route_key: &str) {
    if let Ok(mut route) = verified_system_audio_route().lock() {
        *route = Some(route_key.to_string());
    }
    if let Ok(mut failures) = system_audio_failures().lock() {
        failures.remove(route_key);
    }
}

fn record_system_audio_route_failure(
    route_key: &str,
    kind: SystemAudioFailureKind,
    actionable: &str,
) {
    if let Ok(mut failures) = system_audio_failures().lock() {
        failures.insert(route_key.to_string(), (kind, actionable.to_string()));
    }
}

fn clear_system_audio_route_verification(route_key: &str) {
    if let Ok(mut route) = verified_system_audio_route().lock() {
        if route.as_deref() == Some(route_key) {
            *route = None;
        }
    }
}

struct LoopbackDeviceSelection {
    device: cpal::Device,
    backend: SystemAudioBackend,
    display_name: String,
    route_key: String,
    stream_config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
}

#[derive(Debug, Clone)]
struct SystemAudioRouteMetadata {
    backend: SystemAudioBackend,
    display_name: String,
    route_key: String,
    sample_rate: u32,
    channels: u16,
}

impl LoopbackDeviceSelection {
    fn metadata(&self) -> SystemAudioRouteMetadata {
        SystemAudioRouteMetadata {
            backend: self.backend,
            display_name: self.display_name.clone(),
            route_key: self.route_key.clone(),
            sample_rate: self.stream_config.sample_rate,
            channels: self.stream_config.channels,
        }
    }
}

const LOOPBACK_KEYWORDS: [&str; 7] = [
    "blackhole",
    "loopback",
    "vb-cable",
    "vb-audio",
    "virtual audio cable",
    "soundflower",
    "stereo mix",
];

fn normalized_audio_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_loopback_identifier(value: &str) -> bool {
    let normalized = normalized_audio_label(value);
    LOOPBACK_KEYWORDS.iter().any(|keyword| {
        let normalized_keyword = normalized_audio_label(keyword);
        normalized.contains(&normalized_keyword)
    })
}

fn device_lookup_label(device: &cpal::Device) -> Option<String> {
    device_name(device).ok()
}

fn device_route_key(device: &cpal::Device, label: &str) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| normalized_audio_label(label))
}

fn native_output_is_eligible(supports_input: bool, supports_output: bool) -> bool {
    !supports_input && supports_output
}

fn capture_candidate_priority(
    backend: SystemAudioBackend,
    verified: bool,
    has_failure: bool,
) -> u8 {
    match (verified, has_failure, backend) {
        (true, false, _) => 0,
        (false, false, SystemAudioBackend::CoreAudioProcessTap) => 1,
        (false, false, SystemAudioBackend::VirtualLoopback) => 2,
        _ => 3,
    }
}

fn backend_allows_internal_verification_tone(backend: SystemAudioBackend) -> bool {
    backend == SystemAudioBackend::CoreAudioProcessTap
}

fn unverified_system_audio_action(backend: SystemAudioBackend) -> String {
    match backend {
        SystemAudioBackend::CoreAudioProcessTap =>
            "A native route is available, but permission and non-silent callbacks have not been verified. Run Test system audio; Plainsong will play a brief known tone through the native output."
                .to_string(),
        SystemAudioBackend::VirtualLoopback =>
            "A virtual loopback route is available, but external audio has not been verified. Play audio through the loopback route, then run Test system audio."
                .to_string(),
        SystemAudioBackend::None =>
            "No system-audio route is available. Start in Mic only mode or configure a route first."
                .to_string(),
    }
}

fn startup_route_is_unhealthy(
    _backend: SystemAudioBackend,
    has_alternative: bool,
    callbacks: u64,
    captured_frames: u64,
    non_silent_frames: u64,
) -> bool {
    callbacks == 0 || captured_frames == 0 || (has_alternative && non_silent_frames == 0)
}

fn system_route_retry_due(rebuild_pending: bool, now: Instant, retry_at: Instant) -> bool {
    rebuild_pending && now >= retry_at
}

/// System audio capture session helper
pub struct SystemAudioCapture {
    host: cpal::Host,
}

/// Mixed audio capture (microphone + system audio)
pub struct MixedAudioCapture {
    is_capturing: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    dropped_mic_samples: Arc<AtomicU64>,
    dropped_system_samples: Arc<AtomicU64>,
    dropped_mixed_chunks: Arc<AtomicU64>,
}

pub struct MixedAudioChunk {
    pub mixed: Vec<f32>,
    pub mic: Option<Vec<f32>>,
    pub system: Option<Vec<f32>>,
}

pub struct MixedAudioCaptureStart {
    pub aligned_receiver: crossbeam::channel::Receiver<MixedAudioChunk>,
    pub sample_rate: u32,
    activation_tx: crossbeam::channel::Sender<()>,
    activated_rx: crossbeam::channel::Receiver<std::result::Result<(), String>>,
}

impl MixedAudioCaptureStart {
    /// Start playback only after the caller has durably prepared every writer.
    pub fn activate(&self) -> Result<()> {
        self.activation_tx
            .send(())
            .map_err(|_| anyhow::anyhow!("Mixed capture stopped before activation"))?;
        match self.activated_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(anyhow::anyhow!(error)),
            Err(_) => Err(anyhow::anyhow!(
                "Timed out waiting for mixed audio streams to activate"
            )),
        }
    }
}

/// Event channel the capture thread uses for mid-session warnings (currently
/// just the per-source silence watchdog). `None` for callers with no live
/// JSON-RPC event channel, which is the same shape `start_dictation` uses for
/// its `dictation-vad-signal` handle.
pub struct MixedCaptureEvents {
    pub handle: SidecarHandle,
    pub recording_id: String,
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        Self {
            host: cpal::default_host(),
        }
    }

    /// Backward-compatible route availability. This means that a candidate route
    /// exists, not that macOS permission or non-silent callbacks were verified.
    pub fn is_available(&self) -> bool {
        self.find_loopback_device().ok().flatten().is_some()
    }

    pub fn capability(&self) -> SystemAudioCapability {
        let gate = native_tap_gate();
        match self.find_capability_device() {
            Ok(Some(selection)) => {
                let verified = is_verified_system_audio_route(&selection.route_key);
                let last_failure = failure_for_system_audio_route(&selection.route_key);
                SystemAudioCapability {
                    backend: selection.backend,
                    native_os_supported: gate.api_supported,
                    native_os_enabled: gate.enabled,
                    route_device: Some(selection.display_name),
                    route_id: Some(selection.route_key),
                    native_sample_rate: Some(selection.stream_config.sample_rate),
                    native_channels: Some(selection.stream_config.channels),
                    readiness: if verified {
                        SystemAudioReadiness::Ready
                    } else {
                        SystemAudioReadiness::Unverified
                    },
                    ready: verified,
                    reason: last_failure.as_ref().map(|(kind, _)| *kind),
                    actionable_reason: if verified {
                        None
                    } else {
                        Some(
                            last_failure
                                .map(|(_, actionable)| actionable)
                                .unwrap_or_else(|| {
                                    unverified_system_audio_action(selection.backend)
                                }),
                        )
                    },
                }
            }
            Ok(None) => SystemAudioCapability {
                backend: SystemAudioBackend::None,
                native_os_supported: gate.api_supported,
                native_os_enabled: gate.enabled,
                route_device: None,
                route_id: None,
                native_sample_rate: None,
                native_channels: None,
                readiness: SystemAudioReadiness::Unavailable,
                ready: false,
                reason: Some(if gate.api_supported || cfg!(not(target_os = "macos")) {
                    SystemAudioFailureKind::NoEligibleRoute
                } else {
                    SystemAudioFailureKind::UnsupportedOs
                }),
                actionable_reason: gate.reason.or_else(|| {
                    Some(
                        "No eligible output-only default output or virtual loopback route was found. If the default output is duplex, use BlackHole or another virtual loopback device."
                            .to_string(),
                    )
                }),
            },
            Err(error) => SystemAudioCapability {
                backend: SystemAudioBackend::None,
                native_os_supported: gate.api_supported,
                native_os_enabled: gate.enabled,
                route_device: None,
                route_id: None,
                native_sample_rate: None,
                native_channels: None,
                readiness: SystemAudioReadiness::Unavailable,
                ready: false,
                reason: Some(SystemAudioFailureKind::StreamConstruction),
                actionable_reason: Some(format!("Could not inspect system-audio routes: {error}")),
            },
        }
    }

    #[cfg(target_os = "macos")]
    fn native_default_output_candidate(&self) -> Result<Option<LoopbackDeviceSelection>> {
        if !native_tap_gate().enabled {
            return Ok(None);
        }
        let Some(device) = self.host.default_output_device() else {
            return Ok(None);
        };
        // Probe input capability directly and fail closed. Device::description()
        // intentionally erases a failed input-config probe into "no input", so it
        // cannot be the privacy boundary for a duplex output. The vendored CPAL
        // path also forces devices obtained as the default output through the
        // process-tap path during stream construction, eliminating a second-probe
        // race that could otherwise open the physical input.
        let supports_input = device
            .supported_input_configs()
            .context("Could not verify whether the default output has a physical input")?
            .next()
            .is_some();
        let supported_config = device
            .default_output_config()
            .context("Failed to read the default output's native configuration")?;
        if !native_output_is_eligible(supports_input, supported_config.channels() > 0) {
            let label =
                device_lookup_label(&device).unwrap_or_else(|| "default output".to_string());
            tracing::info!(
                "Default output '{}' is duplex or output-ineligible; refusing native system-audio capture",
                label
            );
            return Ok(None);
        }
        let label = device_lookup_label(&device)
            .ok_or_else(|| anyhow::anyhow!("Failed to read the default output device name"))?;
        let route_key = device_route_key(&device, &label);
        Ok(Some(LoopbackDeviceSelection {
            device,
            backend: SystemAudioBackend::CoreAudioProcessTap,
            display_name: label,
            route_key,
            stream_config: supported_config.config(),
            sample_format: supported_config.sample_format(),
        }))
    }

    #[cfg(not(target_os = "macos"))]
    fn native_default_output_candidate(&self) -> Result<Option<LoopbackDeviceSelection>> {
        Ok(None)
    }

    fn virtual_loopback_candidates(&self) -> Result<Vec<LoopbackDeviceSelection>> {
        // CPAL's macOS `input_devices()` filter probes every device's supported
        // input formats. Some CoreAudio devices can block indefinitely during
        // that probe. Enumerate names without filtering, then validate only a
        // matched virtual loopback device with the direct default-config query.
        #[cfg(target_os = "macos")]
        let devices = self
            .host
            .devices()
            .context("Failed to enumerate audio devices")?;

        #[cfg(not(target_os = "macos"))]
        let devices = self
            .host
            .input_devices()
            .context("Failed to enumerate input devices")?;

        let mut candidates = Vec::new();
        for device in devices {
            let Some(label) = device_lookup_label(&device) else {
                continue;
            };
            if !is_loopback_identifier(&label) {
                continue;
            }

            let supported_config = match device.default_input_config() {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!(
                        "Ignoring loopback device without a usable input configuration: {} ({})",
                        label,
                        error
                    );
                    continue;
                }
            };
            let route_key = device_route_key(&device, &label);
            tracing::info!("Found virtual loopback device: {}", label);
            candidates.push(LoopbackDeviceSelection {
                device,
                backend: SystemAudioBackend::VirtualLoopback,
                display_name: label,
                route_key,
                stream_config: supported_config.config(),
                sample_format: supported_config.sample_format(),
            });
        }
        Ok(candidates)
    }

    fn find_loopback_candidates(&self) -> Result<Vec<LoopbackDeviceSelection>> {
        let mut candidates = Vec::new();
        match self.native_default_output_candidate() {
            Ok(Some(native)) => candidates.push(native),
            Ok(None) => {}
            Err(error) => tracing::warn!("Native system-audio route inspection failed: {error}"),
        }
        match self.virtual_loopback_candidates() {
            Ok(mut virtual_candidates) => candidates.append(&mut virtual_candidates),
            Err(error) if candidates.is_empty() => return Err(error),
            Err(error) => tracing::warn!("Virtual loopback route inspection failed: {error}"),
        }
        Ok(candidates)
    }

    fn find_loopback_device(&self) -> Result<Option<LoopbackDeviceSelection>> {
        Ok(self.find_loopback_candidates()?.into_iter().next())
    }

    fn find_capability_device(&self) -> Result<Option<LoopbackDeviceSelection>> {
        let mut candidates = self.find_loopback_candidates()?;
        candidates.sort_by_key(|candidate| {
            capture_candidate_priority(
                candidate.backend,
                is_verified_system_audio_route(&candidate.route_key),
                failure_for_system_audio_route(&candidate.route_key).is_some(),
            )
        });
        Ok(candidates.into_iter().next())
    }

    pub fn get_loopback_device_name(&self) -> Result<Option<String>> {
        match self.find_loopback_device()? {
            Some(selection) => Ok(Some(selection.display_name)),
            None => Ok(None),
        }
    }
}

#[derive(Debug, Clone)]
struct SystemAudioRuntimeFailure {
    kind: SystemAudioFailureKind,
    message: String,
}

type SystemAudioRuntimeFailureSlot = Arc<Mutex<Option<SystemAudioRuntimeFailure>>>;

#[derive(Default)]
struct SystemStreamHealth {
    callbacks: AtomicU64,
    captured_frames: AtomicU64,
    non_silent_frames: AtomicU64,
}

type SystemStreamHealthSlot = Arc<SystemStreamHealth>;

type SystemStreamStart = (
    cpal::Stream,
    SystemAudioRouteMetadata,
    SystemStreamHealthSlot,
    bool,
);

fn classify_system_audio_error(
    error: &cpal::Error,
    backend: SystemAudioBackend,
) -> SystemAudioFailureKind {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => SystemAudioFailureKind::PermissionDenied,
        cpal::ErrorKind::DeviceChanged
        | cpal::ErrorKind::DeviceNotAvailable
        | cpal::ErrorKind::StreamInvalidated => SystemAudioFailureKind::RouteChanged,
        cpal::ErrorKind::UnsupportedOperation
            if backend == SystemAudioBackend::CoreAudioProcessTap =>
        {
            SystemAudioFailureKind::UnsupportedOs
        }
        _ => SystemAudioFailureKind::StreamConstruction,
    }
}

fn actionable_reason_for_failure(
    kind: SystemAudioFailureKind,
    backend: SystemAudioBackend,
    detail: &str,
) -> String {
    match kind {
        SystemAudioFailureKind::UnsupportedOs => {
            "This native Core Audio route is unsupported on this macOS version. Use BlackHole or another virtual loopback device."
                .to_string()
        }
        SystemAudioFailureKind::PermissionDenied => {
            "macOS denied system-audio capture. Enable Plainsong in Privacy & Security → Screen & System Audio Recording, then test again."
                .to_string()
        }
        SystemAudioFailureKind::RouteChanged => {
            "The system output route changed. Plainsong will rebuild the capture route; test again if audio does not resume."
                .to_string()
        }
        SystemAudioFailureKind::SilentStream => {
            "The route opened but delivered no verifiable audio. Check Screen & System Audio Recording permission and the current output route, then test again."
                .to_string()
        }
        SystemAudioFailureKind::NoEligibleRoute => {
            "No eligible system-audio route was found. Duplex outputs are not used because that could capture their physical microphone; use an output-only route or BlackHole."
                .to_string()
        }
        SystemAudioFailureKind::StreamConstruction | SystemAudioFailureKind::StreamRuntime => {
            let route = match backend {
                SystemAudioBackend::CoreAudioProcessTap => "native Core Audio route",
                SystemAudioBackend::VirtualLoopback => "virtual loopback route",
                SystemAudioBackend::None => "system-audio route",
            };
            format!("The {route} could not start: {detail}")
        }
    }
}

fn invalidate_system_audio_route(
    metadata: &SystemAudioRouteMetadata,
    failure: &SystemAudioRuntimeFailure,
) {
    clear_system_audio_route_verification(&metadata.route_key);
    let actionable =
        actionable_reason_for_failure(failure.kind, metadata.backend, &failure.message);
    record_system_audio_route_failure(&metadata.route_key, failure.kind, &actionable);
}

fn build_system_input_stream(
    selection: &LoopbackDeviceSelection,
    system_buffer: Arc<crossbeam::queue::ArrayQueue<f32>>,
    is_capturing: Arc<AtomicBool>,
    dropped_samples: Arc<AtomicU64>,
    runtime_failure: SystemAudioRuntimeFailureSlot,
    health: SystemStreamHealthSlot,
) -> std::result::Result<cpal::Stream, cpal::Error> {
    let config = selection.stream_config;
    let num_channels = config.channels as usize;
    let backend = selection.backend;
    // Latched if this stream's realtime callback ever panics, so system audio
    // goes quiet instead of aborting the process mid-meeting.
    let stream_callback_poisoned = Arc::new(AtomicBool::new(false));

    macro_rules! build_stream {
        ($sample_type:ty) => {{
            let callback_poisoned = Arc::clone(&stream_callback_poisoned);
            let system_buffer = Arc::clone(&system_buffer);
            let is_capturing = Arc::clone(&is_capturing);
            let dropped_samples = Arc::clone(&dropped_samples);
            let runtime_failure = Arc::clone(&runtime_failure);
            let health = Arc::clone(&health);
            selection.device.build_input_stream(
                config,
                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                    crate::audio::guard_audio_callback(&callback_poisoned, "System audio", || {
                        health.callbacks.fetch_add(1, Ordering::Relaxed);
                        if is_capturing.load(Ordering::SeqCst) {
                            let (frames, non_silent_frames) = push_normalized_samples(
                                data,
                                num_channels,
                                &system_buffer,
                                &dropped_samples,
                            );
                            health.captured_frames.fetch_add(frames, Ordering::Relaxed);
                            health
                                .non_silent_frames
                                .fetch_add(non_silent_frames, Ordering::Relaxed);
                        }
                    });
                },
                move |error| {
                    let mut kind = classify_system_audio_error(&error, backend);
                    if kind == SystemAudioFailureKind::StreamConstruction {
                        kind = SystemAudioFailureKind::StreamRuntime;
                    }
                    tracing::error!("System audio stream error ({backend:?}/{kind:?}): {error}");
                    if let Ok(mut failure) = runtime_failure.lock() {
                        *failure = Some(SystemAudioRuntimeFailure {
                            kind,
                            message: error.to_string(),
                        });
                    }
                },
                None,
            )
        }};
    }

    match selection.sample_format {
        cpal::SampleFormat::I8 => build_stream!(i8),
        cpal::SampleFormat::I16 => build_stream!(i16),
        cpal::SampleFormat::I24 => build_stream!(cpal::I24),
        cpal::SampleFormat::I32 => build_stream!(i32),
        cpal::SampleFormat::I64 => build_stream!(i64),
        cpal::SampleFormat::U8 => build_stream!(u8),
        cpal::SampleFormat::U16 => build_stream!(u16),
        cpal::SampleFormat::U24 => build_stream!(cpal::U24),
        cpal::SampleFormat::U32 => build_stream!(u32),
        cpal::SampleFormat::U64 => build_stream!(u64),
        cpal::SampleFormat::F32 => build_stream!(f32),
        cpal::SampleFormat::F64 => build_stream!(f64),
        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
    }
}

fn start_system_stream(
    mut candidates: Vec<LoopbackDeviceSelection>,
    system_buffer: Arc<crossbeam::queue::ArrayQueue<f32>>,
    is_capturing: Arc<AtomicBool>,
    dropped_samples: Arc<AtomicU64>,
    runtime_failure: SystemAudioRuntimeFailureSlot,
    play_immediately: bool,
) -> std::result::Result<SystemStreamStart, SystemAudioRuntimeFailure> {
    // A route that passed the explicit signal test remains first. Otherwise prefer
    // the native process tap so a merely detected virtual device cannot preempt the
    // current output route. Startup health checks retire any silent selection when
    // an alternative is available.
    candidates.sort_by_key(|candidate| {
        capture_candidate_priority(
            candidate.backend,
            is_verified_system_audio_route(&candidate.route_key),
            failure_for_system_audio_route(&candidate.route_key).is_some(),
        )
    });
    let has_alternative = candidates.len() > 1;

    let mut last_failure = None;
    for selection in candidates {
        let metadata = selection.metadata();
        let health = Arc::new(SystemStreamHealth::default());
        let stream = match build_system_input_stream(
            &selection,
            Arc::clone(&system_buffer),
            Arc::clone(&is_capturing),
            Arc::clone(&dropped_samples),
            Arc::clone(&runtime_failure),
            Arc::clone(&health),
        ) {
            Ok(stream) => stream,
            Err(error) => {
                let failure = SystemAudioRuntimeFailure {
                    kind: classify_system_audio_error(&error, metadata.backend),
                    message: error.to_string(),
                };
                invalidate_system_audio_route(&metadata, &failure);
                tracing::warn!(
                    "System audio candidate '{}' ({:?}) failed to build: {}",
                    metadata.display_name,
                    metadata.backend,
                    error
                );
                last_failure = Some(failure);
                continue;
            }
        };
        if play_immediately {
            if let Err(error) = stream.play() {
                let failure = SystemAudioRuntimeFailure {
                    kind: classify_system_audio_error(&error, metadata.backend),
                    message: error.to_string(),
                };
                invalidate_system_audio_route(&metadata, &failure);
                tracing::warn!(
                    "System audio candidate '{}' ({:?}) failed to play: {}",
                    metadata.display_name,
                    metadata.backend,
                    error
                );
                last_failure = Some(failure);
                continue;
            }
            tracing::info!(
                "System audio route started: {} via {:?} ({} Hz, {} ch)",
                metadata.display_name,
                metadata.backend,
                metadata.sample_rate,
                metadata.channels
            );
        } else {
            tracing::info!(
                "System audio route prepared: {} via {:?} ({} Hz, {} ch)",
                metadata.display_name,
                metadata.backend,
                metadata.sample_rate,
                metadata.channels
            );
        }
        return Ok((stream, metadata, health, has_alternative));
    }

    Err(last_failure.unwrap_or_else(|| SystemAudioRuntimeFailure {
        kind: SystemAudioFailureKind::NoEligibleRoute,
        message: "No eligible system-audio route was found".to_string(),
    }))
}

#[derive(Default)]
struct SystemAudioTestStats {
    callbacks: u64,
    captured_frames: u64,
    non_silent_frames: u64,
    peak: f32,
    tone_samples: Vec<f32>,
}

fn build_system_test_input_stream<T>(
    selection: &LoopbackDeviceSelection,
    stats: Arc<Mutex<SystemAudioTestStats>>,
    tone_active: Arc<AtomicBool>,
    runtime_failure: SystemAudioRuntimeFailureSlot,
) -> std::result::Result<cpal::Stream, cpal::Error>
where
    T: cpal::Sample + cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = selection.stream_config.channels as usize;
    let backend = selection.backend;
    let max_samples = selection.stream_config.sample_rate as usize * 4;
    // Latched if this callback ever panics, so the stream goes inert rather
    // than aborting the process at the cpal C boundary.
    let callback_poisoned = std::sync::Arc::new(AtomicBool::new(false));
    selection.device.build_input_stream(
        selection.stream_config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            crate::audio::guard_audio_callback(&callback_poisoned, "System audio test", || {
                if let Ok(mut stats) = stats.lock() {
                    stats.callbacks += 1;
                    for_each_mono_sample(data, channels, |sample| {
                        stats.captured_frames += 1;
                        stats.peak = stats.peak.max(sample.abs());
                        if sample.abs() > SYSTEM_AUDIO_TEST_NON_SILENT_THRESHOLD {
                            stats.non_silent_frames += 1;
                        }
                        if tone_active.load(Ordering::Relaxed)
                            && stats.tone_samples.len() < max_samples
                        {
                            stats.tone_samples.push(sample);
                        }
                    });
                }
            });
        },
        move |error| {
            let kind = classify_system_audio_error(&error, backend);
            if let Ok(mut failure) = runtime_failure.lock() {
                *failure = Some(SystemAudioRuntimeFailure {
                    kind,
                    message: error.to_string(),
                });
            }
        },
        Some(Duration::from_secs(5)),
    )
}

fn build_system_test_output_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    runtime_failure: SystemAudioRuntimeFailureSlot,
) -> std::result::Result<cpal::Stream, cpal::Error>
where
    T: cpal::Sample + cpal::SizedSample + cpal::FromSample<f32>,
{
    let channels = config.channels as usize;
    let phase_step =
        std::f32::consts::TAU * SYSTEM_AUDIO_TEST_TONE_HZ / config.sample_rate.max(1) as f32;
    let mut phase = 0.0f32;
    device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            for frame in data.chunks_mut(channels.max(1)) {
                let value = phase.sin() * SYSTEM_AUDIO_TEST_TONE_AMPLITUDE;
                let value = T::from_sample(value);
                for sample in frame {
                    *sample = value;
                }
                phase += phase_step;
                if phase >= std::f32::consts::TAU {
                    phase -= std::f32::consts::TAU;
                }
            }
        },
        move |error| {
            if let Ok(mut failure) = runtime_failure.lock() {
                *failure = Some(SystemAudioRuntimeFailure {
                    kind: SystemAudioFailureKind::StreamRuntime,
                    message: error.to_string(),
                });
            }
        },
        Some(Duration::from_secs(5)),
    )
}

fn tone_amplitude(samples: &[f32], sample_rate: u32, frequency: f32) -> f64 {
    if samples.is_empty() || sample_rate == 0 {
        return 0.0;
    }
    let skip = (sample_rate as usize / 5).min(samples.len());
    let samples = &samples[skip..];
    if samples.is_empty() {
        return 0.0;
    }
    let omega = std::f64::consts::TAU * frequency as f64 / sample_rate as f64;
    let mut sin_sum = 0.0f64;
    let mut cos_sum = 0.0f64;
    for (index, &sample) in samples.iter().enumerate() {
        let angle = omega * index as f64;
        sin_sum += sample as f64 * angle.sin();
        cos_sum += sample as f64 * angle.cos();
    }
    2.0 * (sin_sum * sin_sum + cos_sum * cos_sum).sqrt() / samples.len() as f64
}

fn verification_signal_passes(
    method: SystemAudioVerificationMethod,
    non_silent_frames: u64,
    minimum_non_silent: u64,
    detected_tone_amplitude: f64,
) -> bool {
    non_silent_frames >= minimum_non_silent
        && (method == SystemAudioVerificationMethod::ExternalAudio
            || detected_tone_amplitude >= 0.005)
}

struct CandidateTestOutcome {
    stats: SystemAudioTestStats,
    tone_amplitude: f64,
    verification_method: SystemAudioVerificationMethod,
}

fn run_system_audio_candidate_test(
    selection: &LoopbackDeviceSelection,
    first_callback_timeout: Duration,
) -> std::result::Result<CandidateTestOutcome, SystemAudioRuntimeFailure> {
    let stats = Arc::new(Mutex::new(SystemAudioTestStats::default()));
    let tone_active = Arc::new(AtomicBool::new(false));
    let runtime_failure: SystemAudioRuntimeFailureSlot = Arc::new(Mutex::new(None));

    macro_rules! build_input {
        ($sample_type:ty) => {
            build_system_test_input_stream::<$sample_type>(
                selection,
                Arc::clone(&stats),
                Arc::clone(&tone_active),
                Arc::clone(&runtime_failure),
            )
        };
    }
    let input_stream = match selection.sample_format {
        cpal::SampleFormat::I8 => build_input!(i8),
        cpal::SampleFormat::I16 => build_input!(i16),
        cpal::SampleFormat::I24 => build_input!(cpal::I24),
        cpal::SampleFormat::I32 => build_input!(i32),
        cpal::SampleFormat::I64 => build_input!(i64),
        cpal::SampleFormat::U8 => build_input!(u8),
        cpal::SampleFormat::U16 => build_input!(u16),
        cpal::SampleFormat::U24 => build_input!(cpal::U24),
        cpal::SampleFormat::U32 => build_input!(u32),
        cpal::SampleFormat::U64 => build_input!(u64),
        cpal::SampleFormat::F32 => build_input!(f32),
        cpal::SampleFormat::F64 => build_input!(f64),
        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
    }
    .map_err(|error| SystemAudioRuntimeFailure {
        kind: classify_system_audio_error(&error, selection.backend),
        message: error.to_string(),
    })?;
    input_stream
        .play()
        .map_err(|error| SystemAudioRuntimeFailure {
            kind: classify_system_audio_error(&error, selection.backend),
            message: error.to_string(),
        })?;

    // Only the native Core Audio process tap may inject an internal known tone.
    // Virtual loopback routes must prove they are carrying audio produced outside
    // the verifier; writing a tone into the same virtual device would only prove a
    // self-contained loop and could falsely mark an unrouted cable as ready.
    let output_stream = if backend_allows_internal_verification_tone(selection.backend) {
        selection.device.default_output_config().ok().and_then(|output_config| {
            let output_stream_config = output_config.config();
            macro_rules! build_output {
                ($sample_type:ty) => {
                    build_system_test_output_stream::<$sample_type>(
                        &selection.device,
                        output_stream_config,
                        Arc::clone(&runtime_failure),
                    )
                };
            }
            let stream = match output_config.sample_format() {
                cpal::SampleFormat::I8 => build_output!(i8),
                cpal::SampleFormat::I16 => build_output!(i16),
                cpal::SampleFormat::I24 => build_output!(cpal::I24),
                cpal::SampleFormat::I32 => build_output!(i32),
                cpal::SampleFormat::I64 => build_output!(i64),
                cpal::SampleFormat::U8 => build_output!(u8),
                cpal::SampleFormat::U16 => build_output!(u16),
                cpal::SampleFormat::U24 => build_output!(cpal::U24),
                cpal::SampleFormat::U32 => build_output!(u32),
                cpal::SampleFormat::U64 => build_output!(u64),
                cpal::SampleFormat::F32 => build_output!(f32),
                cpal::SampleFormat::F64 => build_output!(f64),
                _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
            };
            match stream.and_then(|stream| {
                stream.play()?;
                Ok(stream)
            }) {
                Ok(stream) => Some(stream),
                Err(error) => {
                    tracing::warn!(
                        "Could not play a native verification tone through '{}'; checking for external route audio instead: {}",
                        selection.display_name,
                        error
                    );
                    None
                }
            }
        })
    } else {
        None
    };
    let verification_method = if output_stream.is_some() {
        SystemAudioVerificationMethod::KnownTone
    } else {
        SystemAudioVerificationMethod::ExternalAudio
    };
    tone_active.store(
        verification_method == SystemAudioVerificationMethod::KnownTone,
        Ordering::Relaxed,
    );

    // Start the known tone (or begin the external-audio observation window)
    // before waiting for the first callback. Some process taps do not drive an
    // input callback until the bound output device is active, so waiting first
    // would manufacture a false silent-stream result.
    let callback_deadline = Instant::now() + first_callback_timeout;
    let mut first_callback_at = None;
    loop {
        let now = Instant::now();
        let callbacks = stats.lock().map(|stats| stats.callbacks).unwrap_or(0);
        if callbacks > 0 {
            let first = first_callback_at.get_or_insert(now);
            if now.duration_since(*first) >= Duration::from_millis(2200) {
                break;
            }
        } else if now >= callback_deadline {
            return Err(SystemAudioRuntimeFailure {
                kind: SystemAudioFailureKind::SilentStream,
                message: "The input stream produced no callbacks while the verification signal was active before the timeout"
                    .to_string(),
            });
        }
        if let Some(failure) = runtime_failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
        {
            return Err(failure);
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    tone_active.store(false, Ordering::Relaxed);
    drop(output_stream);
    std::thread::sleep(Duration::from_millis(150));

    if let Some(failure) = runtime_failure
        .lock()
        .ok()
        .and_then(|failure| failure.clone())
    {
        return Err(failure);
    }

    drop(input_stream);
    let stats = Arc::try_unwrap(stats)
        .ok()
        .and_then(|stats| stats.into_inner().ok())
        .unwrap_or_default();
    let detected = tone_amplitude(
        &stats.tone_samples,
        selection.stream_config.sample_rate,
        SYSTEM_AUDIO_TEST_TONE_HZ,
    );
    let minimum_non_silent = (selection.stream_config.sample_rate / 5) as u64;
    if !verification_signal_passes(
        verification_method,
        stats.non_silent_frames,
        minimum_non_silent,
        detected,
    ) {
        let expected = match verification_method {
            SystemAudioVerificationMethod::KnownTone => format!(
                "the {} Hz verification tone was not detected",
                SYSTEM_AUDIO_TEST_TONE_HZ
            ),
            SystemAudioVerificationMethod::ExternalAudio => {
                "the route did not carry enough external audio".to_string()
            }
        };
        return Err(SystemAudioRuntimeFailure {
            kind: SystemAudioFailureKind::SilentStream,
            message: format!(
                "Callbacks arrived, but {expected} (non-silent frames: {}, amplitude: {:.6})",
                stats.non_silent_frames, detected
            ),
        });
    }

    Ok(CandidateTestOutcome {
        stats,
        tone_amplitude: detected,
        verification_method,
    })
}

impl SystemAudioCapture {
    pub fn test_system_audio(&self, first_callback_timeout: Duration) -> SystemAudioTestResult {
        let gate = native_tap_gate();
        let mut candidates = match self.find_loopback_candidates() {
            Ok(candidates) if !candidates.is_empty() => candidates,
            _ => {
                return SystemAudioTestResult {
                    capability: self.capability(),
                    callbacks: 0,
                    captured_frames: 0,
                    non_silent_frames: 0,
                    peak: 0.0,
                    expected_tone_hz: SYSTEM_AUDIO_TEST_TONE_HZ,
                    detected_tone_amplitude: 0.0,
                    verification_method: None,
                };
            }
        };

        candidates.sort_by_key(|candidate| {
            capture_candidate_priority(
                candidate.backend,
                is_verified_system_audio_route(&candidate.route_key),
                failure_for_system_audio_route(&candidate.route_key).is_some(),
            )
        });

        let mut last_result = None;
        for selection in candidates {
            let metadata = selection.metadata();
            let callback_timeout = if metadata.backend == SystemAudioBackend::CoreAudioProcessTap {
                first_callback_timeout
            } else {
                Duration::from_secs(5)
            };
            match run_system_audio_candidate_test(&selection, callback_timeout) {
                Ok(outcome) => {
                    mark_system_audio_route_verified(&metadata.route_key);
                    return SystemAudioTestResult {
                        capability: SystemAudioCapability {
                            backend: metadata.backend,
                            native_os_supported: gate.api_supported,
                            native_os_enabled: gate.enabled,
                            route_device: Some(metadata.display_name),
                            route_id: Some(metadata.route_key),
                            native_sample_rate: Some(metadata.sample_rate),
                            native_channels: Some(metadata.channels),
                            readiness: SystemAudioReadiness::Ready,
                            ready: true,
                            reason: None,
                            actionable_reason: None,
                        },
                        callbacks: outcome.stats.callbacks,
                        captured_frames: outcome.stats.captured_frames,
                        non_silent_frames: outcome.stats.non_silent_frames,
                        peak: outcome.stats.peak,
                        expected_tone_hz: SYSTEM_AUDIO_TEST_TONE_HZ,
                        detected_tone_amplitude: outcome.tone_amplitude,
                        verification_method: Some(outcome.verification_method),
                    };
                }
                Err(failure) => {
                    clear_system_audio_route_verification(&metadata.route_key);
                    let actionable = actionable_reason_for_failure(
                        failure.kind,
                        metadata.backend,
                        &failure.message,
                    );
                    record_system_audio_route_failure(
                        &metadata.route_key,
                        failure.kind,
                        &actionable,
                    );
                    tracing::warn!(
                        "System audio verification failed for '{}' via {:?}: {:?}: {}",
                        metadata.display_name,
                        metadata.backend,
                        failure.kind,
                        failure.message
                    );
                    last_result = Some(SystemAudioTestResult {
                        capability: SystemAudioCapability {
                            backend: metadata.backend,
                            native_os_supported: gate.api_supported,
                            native_os_enabled: gate.enabled,
                            route_device: Some(metadata.display_name),
                            route_id: Some(metadata.route_key),
                            native_sample_rate: Some(metadata.sample_rate),
                            native_channels: Some(metadata.channels),
                            readiness: SystemAudioReadiness::Unverified,
                            ready: false,
                            reason: Some(failure.kind),
                            actionable_reason: Some(actionable),
                        },
                        callbacks: 0,
                        captured_frames: 0,
                        non_silent_frames: 0,
                        peak: 0.0,
                        expected_tone_hz: SYSTEM_AUDIO_TEST_TONE_HZ,
                        detected_tone_amplitude: 0.0,
                        verification_method: None,
                    });
                }
            }
        }

        last_result.unwrap_or_else(|| SystemAudioTestResult {
            capability: self.capability(),
            callbacks: 0,
            captured_frames: 0,
            non_silent_frames: 0,
            peak: 0.0,
            expected_tone_hz: SYSTEM_AUDIO_TEST_TONE_HZ,
            detected_tone_amplitude: 0.0,
            verification_method: None,
        })
    }

    /// Run the macOS tap verifier outside the long-lived sidecar process.
    ///
    /// Core Audio can block inside `AudioUnitSetProperty` while its first-use
    /// permission request is unresolved. CPAL's stream timeout and our callback
    /// timeout both begin after that call, so neither can recover the backend.
    /// A disposable copy of the signed sidecar gives this boundary real
    /// cancellation semantics: on timeout the operating system tears down the
    /// helper's tap and aggregate device with the process, while the main
    /// sidecar remains responsive and releases its test guard normally.
    pub fn test_system_audio_bounded(&self, worker_timeout: Duration) -> SystemAudioTestResult {
        #[cfg(target_os = "macos")]
        {
            let result = std::env::current_exe()
                .map_err(|error| {
                    format!(
                        "Could not locate Plainsong's system-audio helper: {error}. Open Privacy & Security → Screen & System Audio Recording, then try again."
                    )
                })
                .and_then(|executable| {
                    run_system_audio_test_process(&executable, worker_timeout)
                });

            match result {
                Ok(result) => {
                    reconcile_system_audio_test_result(&result);
                    result
                }
                Err(actionable) => self.failed_test_result(actionable),
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = worker_timeout;
            self.test_system_audio(Duration::from_secs(45))
        }
    }

    fn failed_test_result(&self, actionable: String) -> SystemAudioTestResult {
        let capability = self.capability();
        if capability.backend != SystemAudioBackend::None {
            if let Some(route_key) = capability.route_id.as_deref() {
                clear_system_audio_route_verification(route_key);
                record_system_audio_route_failure(
                    route_key,
                    SystemAudioFailureKind::StreamConstruction,
                    &actionable,
                );
            }
        }
        failed_system_audio_test_result(capability, actionable)
    }
}

fn failed_system_audio_test_result(
    mut capability: SystemAudioCapability,
    actionable: String,
) -> SystemAudioTestResult {
    if capability.backend != SystemAudioBackend::None {
        capability.readiness = SystemAudioReadiness::Unverified;
        capability.ready = false;
        capability.reason = Some(SystemAudioFailureKind::StreamConstruction);
        capability.actionable_reason = Some(actionable);
    }
    SystemAudioTestResult {
        capability,
        callbacks: 0,
        captured_frames: 0,
        non_silent_frames: 0,
        peak: 0.0,
        expected_tone_hz: SYSTEM_AUDIO_TEST_TONE_HZ,
        detected_tone_amplitude: 0.0,
        verification_method: None,
    }
}

pub(crate) fn run_system_audio_test_worker(
    first_callback_timeout: Duration,
) -> SystemAudioTestResult {
    SystemAudioCapture::new().test_system_audio(first_callback_timeout)
}

fn reconcile_system_audio_test_result(result: &SystemAudioTestResult) {
    let Some(route_key) = result.capability.route_id.as_deref() else {
        return;
    };
    if result.capability.ready {
        mark_system_audio_route_verified(route_key);
        return;
    }

    clear_system_audio_route_verification(route_key);
    if let (Some(kind), Some(actionable)) = (
        result.capability.reason,
        result.capability.actionable_reason.as_deref(),
    ) {
        record_system_audio_route_failure(route_key, kind, actionable);
    }
}

#[cfg(target_os = "macos")]
fn run_system_audio_test_process(
    executable: &std::path::Path,
    timeout: Duration,
) -> std::result::Result<SystemAudioTestResult, String> {
    let mut child = Command::new(executable)
        .arg(crate::SYSTEM_AUDIO_TEST_WORKER_ARGUMENT)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Plainsong could not start its system-audio check: {error}. Open Privacy & Security → Screen & System Audio Recording, then try again."
            )
        })?;
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().map_err(|error| {
                    format!(
                        "Plainsong could not read the system-audio check result: {error}. Open Privacy & Security → Screen & System Audio Recording, then try again."
                    )
                })?;
                if output.status.code() == Some(crate::SYSTEM_AUDIO_TEST_WORKER_TIMEOUT_EXIT_CODE) {
                    return Err(
                        "macOS did not finish system-audio setup in time. Open Privacy & Security → Screen & System Audio Recording, allow Plainsong if it is listed, then run the test again."
                            .to_string(),
                    );
                }
                if !output.status.success() {
                    return Err(
                        "The system-audio check stopped unexpectedly. Open Privacy & Security → Screen & System Audio Recording, make sure Plainsong is allowed, then try again."
                            .to_string(),
                    );
                }
                return serde_json::from_slice(&output.stdout).map_err(|_| {
                    "The system-audio check returned an invalid result. Reopen Plainsong and try again."
                        .to_string()
                });
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Plainsong could not monitor the system-audio check: {error}. Reopen Plainsong and try again."
                ));
            }
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "macOS did not finish system-audio setup in time. Open Privacy & Security → Screen & System Audio Recording, allow Plainsong if it is listed, then run the test again."
                    .to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl MixedAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            dropped_mic_samples: Arc::new(AtomicU64::new(0)),
            dropped_system_samples: Arc::new(AtomicU64::new(0)),
            dropped_mixed_chunks: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn start(
        &mut self,
        capture_mic: bool,
        capture_system: bool,
        mic_device: Option<cpal::Device>,
        waveform_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
        streaming_queue: Option<Arc<crossbeam::queue::ArrayQueue<Vec<f32>>>>,
        events: Option<MixedCaptureEvents>,
    ) -> Result<MixedAudioCaptureStart> {
        if !capture_mic && !capture_system {
            return Err(anyhow::anyhow!("Must capture at least one audio source"));
        }

        if self.is_capturing.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Mixed capture already in progress"));
        }

        self.is_capturing.store(true, Ordering::SeqCst);
        self.dropped_mic_samples.store(0, Ordering::SeqCst);
        self.dropped_system_samples.store(0, Ordering::SeqCst);
        self.dropped_mixed_chunks.store(0, Ordering::SeqCst);

        let (aligned_sender, aligned_receiver) =
            crossbeam::channel::bounded::<MixedAudioChunk>(100);
        let (ready_tx, ready_rx) =
            crossbeam::channel::bounded::<std::result::Result<u32, String>>(1);
        let (activation_tx, activation_rx) = crossbeam::channel::bounded::<()>(1);
        let (activated_tx, activated_rx) =
            crossbeam::channel::bounded::<std::result::Result<(), String>>(1);
        let is_capturing = Arc::clone(&self.is_capturing);
        let dropped_mic_samples = Arc::clone(&self.dropped_mic_samples);
        let dropped_system_samples = Arc::clone(&self.dropped_system_samples);
        let dropped_mixed_chunks = Arc::clone(&self.dropped_mixed_chunks);

        self.capture_thread = Some(std::thread::spawn(move || {
            const MIXED_BUFFER_CAPACITY: usize = 65_536;
            let host = cpal::default_host();
            let mic_buffer: Arc<crossbeam::queue::ArrayQueue<f32>> =
                Arc::new(crossbeam::queue::ArrayQueue::new(MIXED_BUFFER_CAPACITY));
            let system_buffer: Arc<crossbeam::queue::ArrayQueue<f32>> =
                Arc::new(crossbeam::queue::ArrayQueue::new(MIXED_BUFFER_CAPACITY));

            let mut _mic_stream = None;
            let mut _sys_stream = None;
            let mut mic_sample_rate = None;
            let mut system_sample_rate = None;
            let mut mic_channels = 1usize;
            let mut system_channels = 1usize;
            let system_runtime_failure: SystemAudioRuntimeFailureSlot = Arc::new(Mutex::new(None));
            let mut system_route: Option<SystemAudioRouteMetadata> = None;
            let mut system_route_health: Option<SystemStreamHealthSlot> = None;
            let mut system_route_has_alternative = false;

            if capture_mic {
                let preferred_mic_device = mic_device.clone();
                let mut setup = || -> Result<cpal::Stream> {
                    let device = preferred_mic_device
                        .clone()
                        .or_else(|| host.default_input_device())
                        .context("No microphone available")?;
                    let config = device.default_input_config()?;
                    mic_sample_rate = Some(config.sample_rate());
                    // The queues, the mixer and the WAV writers all work in mono
                    // frames, so interleaved multi-channel input has to be
                    // downmixed before it is enqueued.
                    let num_channels = config.channels() as usize;
                    mic_channels = num_channels;
                    let sample_format = config.sample_format();
                    let stream_config = config.config();
                    // Latched if this callback ever panics, so the mic half of
                    // a mixed capture goes quiet rather than aborting.
                    let mic_callback_poisoned = Arc::new(AtomicBool::new(false));
                    macro_rules! build_mic_stream {
                        ($sample_type:ty) => {{
                            let mic_buffer = Arc::clone(&mic_buffer);
                            let is_capturing = Arc::clone(&is_capturing);
                            let dropped_samples = Arc::clone(&dropped_mic_samples);
                            let callback_poisoned = Arc::clone(&mic_callback_poisoned);

                            device.build_input_stream(
                                stream_config,
                                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                    crate::audio::guard_audio_callback(
                                        &callback_poisoned,
                                        "Mixed-capture microphone",
                                        || {
                                            if is_capturing.load(Ordering::SeqCst) {
                                                push_normalized_samples(
                                                    data,
                                                    num_channels,
                                                    &mic_buffer,
                                                    &dropped_samples,
                                                );
                                            }
                                        },
                                    );
                                },
                                |err| tracing::error!("Mic stream error: {}", err),
                                None,
                            )
                        }};
                    }

                    match sample_format {
                        cpal::SampleFormat::I8 => build_mic_stream!(i8),
                        cpal::SampleFormat::I16 => build_mic_stream!(i16),
                        cpal::SampleFormat::I24 => build_mic_stream!(cpal::I24),
                        cpal::SampleFormat::I32 => build_mic_stream!(i32),
                        cpal::SampleFormat::I64 => build_mic_stream!(i64),
                        cpal::SampleFormat::U8 => build_mic_stream!(u8),
                        cpal::SampleFormat::U16 => build_mic_stream!(u16),
                        cpal::SampleFormat::U24 => build_mic_stream!(cpal::U24),
                        cpal::SampleFormat::U32 => build_mic_stream!(u32),
                        cpal::SampleFormat::U64 => build_mic_stream!(u64),
                        cpal::SampleFormat::F32 => build_mic_stream!(f32),
                        cpal::SampleFormat::F64 => build_mic_stream!(f64),
                        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
                    }
                    .map_err(Into::into)
                };

                match setup() {
                    Ok(stream) => _mic_stream = Some(stream),
                    Err(e) => {
                        let message = format!("Failed to start microphone stream: {}", e);
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            if capture_system {
                let candidates = SystemAudioCapture::new()
                    .find_loopback_candidates()
                    .unwrap_or_else(|error| {
                        tracing::warn!("Failed to enumerate system-audio candidates: {error}");
                        Vec::new()
                    });
                match start_system_stream(
                    candidates,
                    Arc::clone(&system_buffer),
                    Arc::clone(&is_capturing),
                    Arc::clone(&dropped_system_samples),
                    Arc::clone(&system_runtime_failure),
                    false,
                ) {
                    Ok((stream, metadata, health, has_alternative)) => {
                        system_sample_rate = Some(metadata.sample_rate);
                        system_channels = metadata.channels as usize;
                        system_route = Some(metadata);
                        system_route_health = Some(health);
                        system_route_has_alternative = has_alternative;
                        _sys_stream = Some(stream);
                    }
                    Err(failure) => {
                        let message = format!(
                            "Failed to start system stream ({:?}): {}. {}",
                            failure.kind,
                            failure.message,
                            actionable_reason_for_failure(
                                failure.kind,
                                SystemAudioBackend::None,
                                &failure.message,
                            )
                        );
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            let target_sample_rate =
                match resolve_target_sample_rate(mic_sample_rate, system_sample_rate) {
                    Ok(sample_rate) => sample_rate,
                    Err(message) => {
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                };

            // Whichever source is not already at the session rate is converted
            // up to it here, rather than the recording being refused outright.
            let resamplers =
                source_resampler_for(mic_sample_rate, target_sample_rate).and_then(|mic| {
                    source_resampler_for(system_sample_rate, target_sample_rate)
                        .map(|system| (mic, system))
                });
            let (mut mic_resampler, mut system_resampler) = match resamplers {
                Ok(pair) => pair,
                Err(error) => {
                    let message = format!(
                        "Failed to prepare mixed capture sample-rate conversion: {}",
                        error
                    );
                    tracing::error!("{}", message);
                    let _ = ready_tx.send(Err(message));
                    is_capturing.store(false, Ordering::SeqCst);
                    return;
                }
            };

            tracing::info!(
                "Mixed capture session rate {} Hz (mic: {:?} Hz / {} ch, system: {:?} Hz / {} ch)",
                target_sample_rate,
                mic_sample_rate,
                mic_channels,
                system_sample_rate,
                system_channels
            );

            let _ = ready_tx.send(Ok(target_sample_rate));

            if activation_rx.recv_timeout(Duration::from_secs(5)).is_err() {
                let _ = activated_tx.send(Err(
                    "Timed out waiting for durable recording writers".to_string()
                ));
                is_capturing.store(false, Ordering::SeqCst);
                return;
            }
            if let Some(stream) = _mic_stream.as_ref() {
                if let Err(error) = stream.play() {
                    let message = format!("Failed to activate microphone stream: {error}");
                    let _ = activated_tx.send(Err(message));
                    is_capturing.store(false, Ordering::SeqCst);
                    return;
                }
            }
            if let Some(stream) = _sys_stream.as_ref() {
                if let Err(error) = stream.play() {
                    let message = format!("Failed to activate system audio stream: {error}");
                    let _ = activated_tx.send(Err(message));
                    is_capturing.store(false, Ordering::SeqCst);
                    return;
                }
            }
            let _ = activated_tx.send(Ok(()));

            let mut mixer = FrameMixer::new(capture_mic, capture_system);
            let mut mic_watchdog = capture_mic
                .then(|| SourceSilenceWatchdog::new(target_sample_rate, &MIC_SILENCE_PROFILE));
            let mut system_watchdog = capture_system
                .then(|| SourceSilenceWatchdog::new(target_sample_rate, &SYSTEM_SILENCE_PROFILE));

            let mut output = Vec::with_capacity(512);
            let mut mic_output = Vec::with_capacity(512);
            let mut system_output = Vec::with_capacity(512);
            let mut source_scratch = Vec::with_capacity(RESAMPLE_CHUNK_FRAMES);
            let mut converted_scratch = Vec::with_capacity(RESAMPLE_CHUNK_FRAMES);
            let mut last_mic_data = Instant::now();
            let mut last_system_data = Instant::now();
            let mut system_route_started_at = Instant::now();
            let mut system_startup_health_checked = false;
            let mut next_system_route_retry = Instant::now();
            let mut system_rebuild_pending = false;
            let mut pending_system_failure: Option<SystemAudioRuntimeFailure> = None;
            let mut system_failure_reported = false;
            let mut system_rebuild_receiver: Option<
                crossbeam::channel::Receiver<
                    std::result::Result<SystemStreamStart, SystemAudioRuntimeFailure>,
                >,
            > = None;

            while is_capturing.load(Ordering::SeqCst) {
                let now = Instant::now();

                if capture_system {
                    if let Some(receiver) = system_rebuild_receiver.as_ref() {
                        match receiver.try_recv() {
                            Ok(Ok((stream, metadata, health, has_alternative))) => {
                                system_rebuild_receiver = None;
                                match source_resampler_for(
                                    Some(metadata.sample_rate),
                                    target_sample_rate,
                                ) {
                                    Ok(resampler) => {
                                        system_resampler = resampler;
                                        _sys_stream = Some(stream);
                                        system_route = Some(metadata.clone());
                                        system_route_health = Some(health);
                                        system_route_has_alternative = has_alternative;
                                        system_route_started_at = now;
                                        system_startup_health_checked = false;
                                        last_system_data = now;
                                        system_rebuild_pending = false;
                                        pending_system_failure = None;
                                        system_failure_reported = false;
                                        emit_system_audio_status(
                                            events.as_ref(),
                                            SystemAudioFailureKind::RouteChanged,
                                            true,
                                            Some(&metadata),
                                            "System audio capture rebuilt on the current route",
                                        );
                                    }
                                    Err(error) => {
                                        drop(stream);
                                        while system_buffer.pop().is_some() {}
                                        let failure = SystemAudioRuntimeFailure {
                                            kind: SystemAudioFailureKind::StreamConstruction,
                                            message: format!(
                                                "Failed to prepare replacement route resampler: {error}"
                                            ),
                                        };
                                        invalidate_system_audio_route(&metadata, &failure);
                                        pending_system_failure = Some(failure);
                                        next_system_route_retry = now + SYSTEM_ROUTE_RETRY_INTERVAL;
                                        system_failure_reported = false;
                                    }
                                }
                            }
                            Ok(Err(failure)) => {
                                system_rebuild_receiver = None;
                                pending_system_failure = Some(failure);
                                next_system_route_retry = now + SYSTEM_ROUTE_RETRY_INTERVAL;
                                system_failure_reported = false;
                            }
                            Err(crossbeam::channel::TryRecvError::Disconnected) => {
                                system_rebuild_receiver = None;
                                pending_system_failure = Some(SystemAudioRuntimeFailure {
                                    kind: SystemAudioFailureKind::StreamConstruction,
                                    message:
                                        "Replacement system-audio route worker stopped unexpectedly"
                                            .to_string(),
                                });
                                next_system_route_retry = now + SYSTEM_ROUTE_RETRY_INTERVAL;
                                system_failure_reported = false;
                            }
                            Err(crossbeam::channel::TryRecvError::Empty) => {}
                        }
                    }

                    if let Some(failure) = system_runtime_failure
                        .lock()
                        .ok()
                        .and_then(|mut failure| failure.take())
                    {
                        if let Some(route) = system_route.as_ref() {
                            invalidate_system_audio_route(route, &failure);
                        }
                        pending_system_failure = Some(failure);
                        system_rebuild_pending = true;
                        system_failure_reported = false;
                    }

                    if !system_rebuild_pending
                        && !system_startup_health_checked
                        && now.duration_since(system_route_started_at) >= SYSTEM_ROUTE_STARTUP_GRACE
                    {
                        if let (Some(route), Some(health)) =
                            (system_route.as_ref(), system_route_health.as_ref())
                        {
                            let callbacks = health.callbacks.load(Ordering::Relaxed);
                            let captured_frames = health.captured_frames.load(Ordering::Relaxed);
                            let non_silent_frames =
                                health.non_silent_frames.load(Ordering::Relaxed);
                            if startup_route_is_unhealthy(
                                route.backend,
                                system_route_has_alternative,
                                callbacks,
                                captured_frames,
                                non_silent_frames,
                            ) {
                                let failure = SystemAudioRuntimeFailure {
                                    kind: SystemAudioFailureKind::SilentStream,
                                    message: format!(
                                        "Route '{}' did not prove live after startup (callbacks={}, frames={}, non-silent={})",
                                        route.display_name,
                                        callbacks,
                                        captured_frames,
                                        non_silent_frames
                                    ),
                                };
                                invalidate_system_audio_route(route, &failure);
                                pending_system_failure = Some(failure);
                                system_rebuild_pending = true;
                                system_failure_reported = false;
                            } else {
                                system_startup_health_checked = true;
                            }
                        }
                    }

                    if system_rebuild_receiver.is_none()
                        && system_route_retry_due(
                            system_rebuild_pending,
                            now,
                            next_system_route_retry,
                        )
                    {
                        if !system_failure_reported {
                            if let Some(failure) = pending_system_failure.as_ref() {
                                emit_system_audio_status(
                                    events.as_ref(),
                                    failure.kind,
                                    false,
                                    system_route.as_ref(),
                                    &failure.message,
                                );
                            }
                            system_failure_reported = true;
                        }

                        // Stop the old callback before the replacement can start,
                        // then consume every sample it queued and flush the old
                        // rate converter's partial tail. Old and new routes never
                        // write into the shared queue at the same time.
                        drop(_sys_stream.take());
                        source_scratch.clear();
                        while let Some(sample) = system_buffer.pop() {
                            source_scratch.push(sample);
                        }
                        if !source_scratch.is_empty() {
                            last_system_data = now;
                        }
                        if let Some(resampler) = system_resampler.as_mut() {
                            converted_scratch.clear();
                            resampler.push(&source_scratch, &mut converted_scratch);
                            resampler.finish(&mut converted_scratch);
                            mixer.push_system(&converted_scratch);
                        } else {
                            mixer.push_system(&source_scratch);
                        }
                        system_resampler = None;
                        system_route_health = None;

                        let (result_tx, result_rx) = crossbeam::channel::bounded(1);
                        let system_buffer = Arc::clone(&system_buffer);
                        let is_capturing = Arc::clone(&is_capturing);
                        let dropped_system_samples = Arc::clone(&dropped_system_samples);
                        let system_runtime_failure = Arc::clone(&system_runtime_failure);
                        std::thread::spawn(move || {
                            let result = SystemAudioCapture::new()
                                .find_loopback_candidates()
                                .map_err(|error| SystemAudioRuntimeFailure {
                                    kind: SystemAudioFailureKind::StreamConstruction,
                                    message: format!(
                                        "Failed to enumerate replacement system-audio routes: {error}"
                                    ),
                                })
                                .and_then(|candidates| {
                                    start_system_stream(
                                        candidates,
                                        system_buffer,
                                        is_capturing,
                                        dropped_system_samples,
                                        system_runtime_failure,
                                        true,
                                    )
                                });
                            let _ = result_tx.send(result);
                        });
                        system_rebuild_receiver = Some(result_rx);
                    }
                }

                if capture_mic {
                    source_scratch.clear();
                    while let Some(sample) = mic_buffer.pop() {
                        source_scratch.push(sample);
                    }
                    if !source_scratch.is_empty() {
                        last_mic_data = now;
                    }
                    match mic_resampler.as_mut() {
                        Some(resampler) => {
                            converted_scratch.clear();
                            resampler.push(&source_scratch, &mut converted_scratch);
                            mixer.push_mic(&converted_scratch);
                        }
                        None => mixer.push_mic(&source_scratch),
                    }
                }

                if capture_system && system_rebuild_receiver.is_none() {
                    source_scratch.clear();
                    while let Some(sample) = system_buffer.pop() {
                        source_scratch.push(sample);
                    }
                    if !source_scratch.is_empty() {
                        last_system_data = now;
                    }
                    match system_resampler.as_mut() {
                        Some(resampler) => {
                            converted_scratch.clear();
                            resampler.push(&source_scratch, &mut converted_scratch);
                            mixer.push_system(&converted_scratch);
                        }
                        None => mixer.push_system(&source_scratch),
                    }
                }

                let mic_starved =
                    capture_mic && now.duration_since(last_mic_data) >= SOURCE_STARVATION_TIMEOUT;
                let system_starved = capture_system
                    && now.duration_since(last_system_data) >= SOURCE_STARVATION_TIMEOUT;

                let mixed_before = output.len();
                let mic_before = mic_output.len();
                let system_before = system_output.len();
                let padded_before = mixer.counts();
                let frames = mixer.drain_into(
                    mic_starved,
                    system_starved,
                    &mut output,
                    &mut mic_output,
                    &mut system_output,
                );

                if frames == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                }

                // Frames the mixer had to invent because a source delivered
                // nothing: the evidence that separates a device which has gone
                // away from one that simply has nothing to play.
                let padded_now = mixer.counts();
                if let Some(watchdog) = mic_watchdog.as_mut() {
                    let padded = padded_now.mic_padded - padded_before.mic_padded;
                    if let Some(seconds) = watchdog.observe(&mic_output[mic_before..], padded) {
                        emit_source_silence_warning(events.as_ref(), "mic", seconds);
                    }
                }
                if let Some(watchdog) = system_watchdog.as_mut() {
                    let padded = padded_now.system_padded - padded_before.system_padded;
                    if let Some(seconds) = watchdog.observe(&system_output[system_before..], padded)
                    {
                        emit_source_silence_warning(events.as_ref(), "system", seconds);
                    }
                }

                if let Ok(mut waveform) = waveform_buffer.lock() {
                    waveform.extend_from_slice(&output[mixed_before..]);
                    if waveform.len() > 4410 {
                        let drop_count = waveform.len() - 4410;
                        waveform.drain(0..drop_count);
                    }
                }

                if output.len() >= 512 {
                    let mixed = std::mem::take(&mut output);
                    if let Some(queue) = streaming_queue.as_ref() {
                        if queue.push(mixed.clone()).is_err() {
                            let _ = queue.pop();
                            let _ = queue.push(mixed.clone());
                        }
                    }
                    let chunk = MixedAudioChunk {
                        mixed,
                        mic: capture_mic.then(|| std::mem::take(&mut mic_output)),
                        system: capture_system.then(|| std::mem::take(&mut system_output)),
                    };
                    if !forward_aligned_chunk(&aligned_sender, chunk, &dropped_mixed_chunks) {
                        is_capturing.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }

            // Both devices are gone by now, so release whatever was still held
            // back for alignment and pad the tail rather than truncating one
            // track relative to the others.
            while mixer.drain_into(true, true, &mut output, &mut mic_output, &mut system_output) > 0
            {
            }

            if !output.is_empty() {
                if let Some(queue) = streaming_queue.as_ref() {
                    if queue.push(output.clone()).is_err() {
                        let _ = queue.pop();
                        let _ = queue.push(output.clone());
                    }
                }
                let chunk = MixedAudioChunk {
                    mixed: output,
                    mic: capture_mic.then_some(mic_output),
                    system: capture_system.then_some(system_output),
                };
                let _ = forward_aligned_chunk(&aligned_sender, chunk, &dropped_mixed_chunks);
            }

            let counts = mixer.counts();
            if counts.mic_padded > 0 || counts.system_padded > 0 {
                tracing::warn!(
                    "Mixed audio capture padded starved sources with silence (mic={}, system={}, of {} mixed frames)",
                    counts.mic_padded,
                    counts.system_padded,
                    counts.mixed
                );
            }

            let dropped_mic = dropped_mic_samples.load(Ordering::Relaxed);
            let dropped_system = dropped_system_samples.load(Ordering::Relaxed);
            let dropped_chunks = dropped_mixed_chunks.load(Ordering::Relaxed);
            if dropped_mic > 0 || dropped_system > 0 || dropped_chunks > 0 {
                tracing::warn!(
                    "Mixed audio capture dropped samples/chunks (mic={}, system={}, chunks={})",
                    dropped_mic,
                    dropped_system,
                    dropped_chunks
                );
            }
        }));

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(sample_rate)) => {
                tracing::info!(
                    "Mixed audio capture started (mic: {}, system: {}, sample_rate: {} Hz)",
                    capture_mic,
                    capture_system,
                    sample_rate
                );
                Ok(MixedAudioCaptureStart {
                    aligned_receiver,
                    sample_rate,
                    activation_tx,
                    activated_rx,
                })
            }
            Ok(Err(message)) => {
                self.stop();
                Err(anyhow::anyhow!(message))
            }
            Err(_) => {
                self.stop();
                Err(anyhow::anyhow!(
                    "Timed out waiting for audio capture streams to initialize"
                ))
            }
        }
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let (done_tx, done_rx) = crossbeam::channel::bounded::<()>(1);
            std::thread::spawn(move || {
                let _ = handle.join();
                let _ = done_tx.send(());
            });
            if done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                tracing::warn!("Timed out waiting for mixed capture thread to stop");
            }
        }
        tracing::info!("Mixed audio capture stopped");
    }

    pub fn drop_counts(&self) -> (u64, u64, u64) {
        (
            self.dropped_mic_samples.load(Ordering::Relaxed),
            self.dropped_system_samples.load(Ordering::Relaxed),
            self.dropped_mixed_chunks.load(Ordering::Relaxed),
        )
    }
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for MixedAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// Pick the rate the mixed session runs at.
///
/// Mismatched device rates (a 44.1 kHz built-in mic against a 48 kHz BlackHole
/// is the macOS default, not a misconfiguration) used to be a hard error that
/// sent the user off to Audio MIDI Setup. The higher of the two is used instead
/// and the slower source is converted up to it on the mixing thread, so nothing
/// is thrown away before the far-side transcript is produced. Only a session
/// with no usable rate on either source is unresolvable.
fn resolve_target_sample_rate(
    mic_sample_rate: Option<u32>,
    system_sample_rate: Option<u32>,
) -> std::result::Result<u32, String> {
    let mic_sample_rate = mic_sample_rate.filter(|rate| *rate > 0);
    let system_sample_rate = system_sample_rate.filter(|rate| *rate > 0);
    match (mic_sample_rate, system_sample_rate) {
        (Some(mic_rate), Some(system_rate)) => Ok(mic_rate.max(system_rate)),
        (Some(mic_rate), None) => Ok(mic_rate),
        (None, Some(system_rate)) => Ok(system_rate),
        (None, None) => Err(
            "Unable to determine a sample rate for the requested audio capture sources."
                .to_string(),
        ),
    }
}

/// Build the converter for one source, or `None` when it already runs at the
/// session's target rate.
fn source_resampler_for(
    source_rate: Option<u32>,
    target_rate: u32,
) -> Result<Option<SourceResampler>> {
    match source_rate {
        Some(rate) if rate > 0 && rate != target_rate => {
            SourceResampler::new(rate, target_rate).map(Some)
        }
        _ => Ok(None),
    }
}

fn emit_system_audio_status(
    events: Option<&MixedCaptureEvents>,
    reason: SystemAudioFailureKind,
    recovered: bool,
    route: Option<&SystemAudioRouteMetadata>,
    detail: &str,
) {
    tracing::warn!("System audio status ({reason:?}, recovered={recovered}): {detail}");
    let Some(events) = events else {
        return;
    };
    events.handle.emit(
        "meeting-audio-source-warning",
        serde_json::json!({
            "recordingId": &events.recording_id,
            "source": "system",
            "reason": reason,
            "recovered": recovered,
            "detail": detail,
            "backend": route.map(|route| route.backend),
            "routeDevice": route.map(|route| route.display_name.as_str()),
            "nativeSampleRate": route.map(|route| route.sample_rate),
            "nativeChannels": route.map(|route| route.channels),
        }),
    );
}

/// Emit the per-source dropout warning over the same JSON-RPC event channel the
/// rest of the meeting lifecycle uses. Always logged, so headless/CLI runs still
/// leave a trace when no event channel was supplied.
fn emit_source_silence_warning(
    events: Option<&MixedCaptureEvents>,
    source: &str,
    silent_seconds: f32,
) {
    tracing::warn!(
        "Mixed capture source '{}' has been silent for {:.0}s; the device may have disconnected",
        source,
        silent_seconds
    );
    let Some(events) = events else {
        return;
    };
    events.handle.emit(
        "meeting-audio-source-warning",
        serde_json::json!({
            "recordingId": &events.recording_id,
            "source": source,
            "reason": "silence",
            "silentSeconds": silent_seconds,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_test_failure_stays_recoverable_and_never_claims_audio() {
        let capability = SystemAudioCapability {
            backend: SystemAudioBackend::CoreAudioProcessTap,
            native_os_supported: true,
            native_os_enabled: true,
            route_device: Some("Built-in Output".to_string()),
            route_id: Some("test-route".to_string()),
            native_sample_rate: Some(48_000),
            native_channels: Some(2),
            readiness: SystemAudioReadiness::Ready,
            ready: true,
            reason: None,
            actionable_reason: None,
        };

        let result = failed_system_audio_test_result(
            capability,
            "Open Privacy Settings and try again.".to_string(),
        );

        assert!(!result.capability.ready);
        assert_eq!(
            result.capability.readiness,
            SystemAudioReadiness::Unverified
        );
        assert_eq!(
            result.capability.reason,
            Some(SystemAudioFailureKind::StreamConstruction)
        );
        assert_eq!(
            result.capability.actionable_reason.as_deref(),
            Some("Open Privacy Settings and try again.")
        );
        assert_eq!(result.callbacks, 0);
        assert_eq!(result.captured_frames, 0);
        assert_eq!(result.non_silent_frames, 0);
        assert!(result.verification_method.is_none());
    }

    #[test]
    fn isolated_test_result_survives_worker_json_round_trip() {
        let result = failed_system_audio_test_result(
            SystemAudioCapability {
                backend: SystemAudioBackend::VirtualLoopback,
                native_os_supported: true,
                native_os_enabled: true,
                route_device: Some("BlackHole 2ch".to_string()),
                route_id: Some("blackhole-2ch".to_string()),
                native_sample_rate: Some(48_000),
                native_channels: Some(2),
                readiness: SystemAudioReadiness::Unverified,
                ready: false,
                reason: None,
                actionable_reason: None,
            },
            "Play audio and try again.".to_string(),
        );

        let payload = serde_json::to_vec(&result).expect("serialize worker result");
        let restored: SystemAudioTestResult =
            serde_json::from_slice(&payload).expect("deserialize worker result");

        assert_eq!(
            restored.capability.backend,
            SystemAudioBackend::VirtualLoopback
        );
        assert_eq!(
            restored.capability.route_id.as_deref(),
            Some("blackhole-2ch")
        );
        assert_eq!(
            restored.capability.actionable_reason.as_deref(),
            Some("Play audio and try again.")
        );
        assert_eq!(restored.expected_tone_hz, SYSTEM_AUDIO_TEST_TONE_HZ);
    }

    #[test]
    #[ignore = "requires live CoreAudio device enumeration; covered by the packaged macOS smoke gate"]
    fn live_system_audio_availability_smoke() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let capture = SystemAudioCapture::new();
            let result = capture
                .find_loopback_device()
                .map(|selection| selection.is_some())
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        });

        let available = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("system audio availability must not block setup verification")
            .expect("system audio availability inspection must complete successfully");
        tracing::info!("System audio available: {}", available);
    }

    #[test]
    #[ignore = "plays a brief audible tone and requires live macOS system-audio permission"]
    fn live_system_audio_known_tone_smoke() {
        let result = SystemAudioCapture::new().test_system_audio(Duration::from_secs(15));
        assert!(
            result.capability.ready,
            "system audio was not verified: {:?}",
            result.capability
        );
        assert_eq!(
            result.capability.backend,
            SystemAudioBackend::CoreAudioProcessTap,
            "supported output-only default output should verify natively before fallback"
        );
        assert!(result.callbacks > 0);
        assert!(result.non_silent_frames > 0);
        assert!(result.detected_tone_amplitude >= 0.005);
    }

    #[test]
    fn loopback_identifier_matching_covers_supported_virtual_devices() {
        for identifier in [
            "BlackHole2ch_UID",
            "Rogue Amoeba Loopback",
            "VB-CABLE Input",
            "CABLE Output (VB-Audio Virtual Cable)",
            "Soundflower (2ch)",
            "Stereo Mix",
        ] {
            assert!(is_loopback_identifier(identifier), "{identifier}");
        }
        assert!(!is_loopback_identifier("MacBook Pro Microphone"));
        assert!(!is_loopback_identifier("Virtual Microphone"));
    }

    #[test]
    fn native_tap_version_gate_separates_api_and_release_floors() {
        let macos_13 = native_tap_gate_for_version(MacOsVersion::parse("13.6.9"));
        assert!(!macos_13.api_supported);
        assert!(!macos_13.enabled);
        assert!(macos_13.reason.unwrap().contains("macOS 14.2"));

        let macos_14_2 = native_tap_gate_for_version(MacOsVersion::parse("14.2"));
        assert!(macos_14_2.api_supported);
        assert!(!macos_14_2.enabled);
        assert!(macos_14_2.reason.unwrap().contains("14.2–14.6"));

        let macos_14_6 = native_tap_gate_for_version(MacOsVersion::parse("14.6.1"));
        assert!(macos_14_6.api_supported);
        assert!(!macos_14_6.enabled);

        let macos_14_7 = native_tap_gate_for_version(MacOsVersion::parse("14.7"));
        assert!(macos_14_7.api_supported);
        assert!(macos_14_7.enabled);
        assert!(macos_14_7.reason.is_none());
    }

    #[test]
    fn native_selection_rejects_duplex_outputs() {
        assert!(native_output_is_eligible(false, true));
        assert!(!native_output_is_eligible(true, true));
        assert!(!native_output_is_eligible(false, false));
    }

    #[test]
    fn verified_routes_win_and_unverified_native_taps_precede_virtual_routes() {
        assert!(
            capture_candidate_priority(SystemAudioBackend::VirtualLoopback, true, false)
                < capture_candidate_priority(SystemAudioBackend::CoreAudioProcessTap, false, false)
        );
        assert!(
            capture_candidate_priority(SystemAudioBackend::CoreAudioProcessTap, false, false)
                < capture_candidate_priority(SystemAudioBackend::VirtualLoopback, false, false)
        );
    }

    #[test]
    fn only_native_process_taps_may_inject_a_known_tone() {
        assert!(backend_allows_internal_verification_tone(
            SystemAudioBackend::CoreAudioProcessTap
        ));
        assert!(!backend_allows_internal_verification_tone(
            SystemAudioBackend::VirtualLoopback
        ));
        assert!(
            unverified_system_audio_action(SystemAudioBackend::VirtualLoopback)
                .contains("external audio")
        );
    }

    #[test]
    fn failed_routes_are_deprioritized_behind_healthy_alternatives() {
        assert!(
            capture_candidate_priority(SystemAudioBackend::CoreAudioProcessTap, false, false)
                < capture_candidate_priority(SystemAudioBackend::VirtualLoopback, false, true)
        );
        assert_eq!(
            capture_candidate_priority(SystemAudioBackend::CoreAudioProcessTap, true, true),
            3
        );
    }

    #[test]
    fn startup_health_rejects_dead_or_silent_routes_when_fallback_exists() {
        assert!(startup_route_is_unhealthy(
            SystemAudioBackend::VirtualLoopback,
            false,
            0,
            0,
            0
        ));
        assert!(startup_route_is_unhealthy(
            SystemAudioBackend::CoreAudioProcessTap,
            true,
            10,
            4_800,
            0
        ));
        assert!(!startup_route_is_unhealthy(
            SystemAudioBackend::CoreAudioProcessTap,
            false,
            10,
            4_800,
            0
        ));
        assert!(startup_route_is_unhealthy(
            SystemAudioBackend::VirtualLoopback,
            true,
            10,
            4_800,
            0
        ));
    }

    #[test]
    fn active_route_failure_clears_cached_readiness() {
        let route_key = "test-active-route-invalidation";
        mark_system_audio_route_verified(route_key);
        let metadata = SystemAudioRouteMetadata {
            backend: SystemAudioBackend::CoreAudioProcessTap,
            display_name: "Test Output".to_string(),
            route_key: route_key.to_string(),
            sample_rate: 48_000,
            channels: 2,
        };
        let failure = SystemAudioRuntimeFailure {
            kind: SystemAudioFailureKind::PermissionDenied,
            message: "permission revoked".to_string(),
        };

        invalidate_system_audio_route(&metadata, &failure);

        assert!(!is_verified_system_audio_route(route_key));
        assert_eq!(
            failure_for_system_audio_route(route_key).map(|(kind, _)| kind),
            Some(SystemAudioFailureKind::PermissionDenied)
        );
    }

    #[test]
    fn aligned_writer_backpressure_drops_the_whole_bundle() {
        let (sender, receiver) = crossbeam::channel::bounded(1);
        let dropped = AtomicU64::new(0);
        assert!(forward_aligned_chunk(
            &sender,
            MixedAudioChunk {
                mixed: vec![1.0; 4],
                mic: Some(vec![0.5; 4]),
                system: Some(vec![0.25; 4]),
            },
            &dropped,
        ));
        assert!(forward_aligned_chunk(
            &sender,
            MixedAudioChunk {
                mixed: vec![2.0; 4],
                mic: Some(vec![1.0; 4]),
                system: Some(vec![0.5; 4]),
            },
            &dropped,
        ));

        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        let retained = receiver.try_recv().expect("one aligned bundle");
        assert_eq!(retained.mixed.len(), 4);
        assert_eq!(retained.mic.as_ref().map(Vec::len), Some(4));
        assert_eq!(retained.system.as_ref().map(Vec::len), Some(4));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn route_retry_waits_for_the_backoff_and_stops_after_recovery() {
        let now = Instant::now();
        assert!(!system_route_retry_due(false, now, now));
        assert!(!system_route_retry_due(
            true,
            now,
            now + SYSTEM_ROUTE_RETRY_INTERVAL
        ));
        assert!(system_route_retry_due(true, now, now));
    }

    #[test]
    fn structured_capability_serializes_backend_format_and_unverified_state() {
        let capability = SystemAudioCapability {
            backend: SystemAudioBackend::CoreAudioProcessTap,
            native_os_supported: true,
            native_os_enabled: true,
            route_device: Some("MacBook Pro Speakers".to_string()),
            route_id: Some("coreaudio:BuiltInSpeakerDevice".to_string()),
            native_sample_rate: Some(48_000),
            native_channels: Some(2),
            readiness: SystemAudioReadiness::Unverified,
            ready: false,
            reason: None,
            actionable_reason: Some("Run Test system audio.".to_string()),
        };
        let value = serde_json::to_value(capability).unwrap();
        assert_eq!(value["backend"], "core_audio_process_tap");
        assert_eq!(value["nativeSampleRate"], 48_000);
        assert_eq!(value["nativeChannels"], 2);
        assert_eq!(value["readiness"], "unverified");
        assert_eq!(value["ready"], false);
    }

    #[test]
    fn cpal_errors_keep_permission_route_and_unsupported_kinds_distinct() {
        let permission: cpal::ErrorKind = cpal::ErrorKind::PermissionDenied;
        let permission: cpal::Error = permission.into();
        assert_eq!(
            classify_system_audio_error(&permission, SystemAudioBackend::CoreAudioProcessTap),
            SystemAudioFailureKind::PermissionDenied
        );

        let route: cpal::ErrorKind = cpal::ErrorKind::StreamInvalidated;
        let route: cpal::Error = route.into();
        assert_eq!(
            classify_system_audio_error(&route, SystemAudioBackend::CoreAudioProcessTap),
            SystemAudioFailureKind::RouteChanged
        );

        let unsupported: cpal::ErrorKind = cpal::ErrorKind::UnsupportedOperation;
        let unsupported: cpal::Error = unsupported.into();
        assert_eq!(
            classify_system_audio_error(&unsupported, SystemAudioBackend::CoreAudioProcessTap),
            SystemAudioFailureKind::UnsupportedOs
        );
        assert_eq!(
            classify_system_audio_error(&unsupported, SystemAudioBackend::VirtualLoopback),
            SystemAudioFailureKind::StreamConstruction
        );
    }

    #[test]
    fn known_tone_detector_rejects_silence_and_detects_997_hz() {
        let sample_rate = 48_000;
        let silence = vec![0.0; sample_rate as usize];
        assert_eq!(
            tone_amplitude(&silence, sample_rate, SYSTEM_AUDIO_TEST_TONE_HZ),
            0.0
        );

        let tone = interleaved_tone(
            sample_rate,
            1,
            SYSTEM_AUDIO_TEST_TONE_HZ,
            sample_rate as usize * 2,
        );
        let detected = tone_amplitude(&tone, sample_rate, SYSTEM_AUDIO_TEST_TONE_HZ);
        assert!(detected > 0.45, "detected amplitude {detected}");
    }

    #[test]
    fn external_audio_routes_verify_without_an_injected_tone() {
        assert!(verification_signal_passes(
            SystemAudioVerificationMethod::ExternalAudio,
            9_600,
            9_600,
            0.0,
        ));
        assert!(!verification_signal_passes(
            SystemAudioVerificationMethod::KnownTone,
            9_600,
            9_600,
            0.0,
        ));
        assert!(!verification_signal_passes(
            SystemAudioVerificationMethod::ExternalAudio,
            9_599,
            9_600,
            0.0,
        ));
    }

    #[test]
    fn normalized_queue_path_keeps_latest_sample_and_counts_overflow() {
        let buffer = crossbeam::queue::ArrayQueue::new(1);
        let dropped_samples = AtomicU64::new(0);

        push_normalized_samples(&[i8::MIN, i8::MAX], 1, &buffer, &dropped_samples);

        assert_eq!(dropped_samples.load(Ordering::Relaxed), 1);
        let latest = buffer.pop().expect("latest normalized sample");
        assert!((latest - 127.0 / 128.0).abs() <= 1.0e-6);
    }

    /// The 2ch half of the canonical BlackHole-2ch + mono-mic setup: a stereo
    /// callback must enqueue one mono frame per interleaved frame, not one per
    /// sample. Enqueueing per sample is what made the far side play back at half
    /// speed and drift further out of sync every second.
    #[test]
    fn stereo_capture_enqueues_one_mono_sample_per_frame() {
        let buffer = crossbeam::queue::ArrayQueue::new(16);
        let dropped_samples = AtomicU64::new(0);
        let interleaved: [f32; 8] = [1.0, 0.0, 0.5, -0.5, -1.0, 1.0, 0.25, 0.75];

        push_normalized_samples(&interleaved, 2, &buffer, &dropped_samples);

        assert_eq!(dropped_samples.load(Ordering::Relaxed), 0);
        assert_eq!(buffer.len(), interleaved.len() / 2);
        let expected = [0.5, 0.0, 0.0, 0.5];
        for want in expected {
            let got = buffer.pop().expect("mono frame");
            assert!((got - want).abs() <= 1.0e-6, "got {got}, want {want}");
        }
    }

    #[test]
    fn resolve_target_sample_rate_accepts_matching_sources() {
        assert_eq!(
            resolve_target_sample_rate(Some(48_000), Some(48_000)).unwrap(),
            48_000
        );
        assert_eq!(
            resolve_target_sample_rate(Some(44_100), None).unwrap(),
            44_100
        );
        assert_eq!(
            resolve_target_sample_rate(None, Some(48_000)).unwrap(),
            48_000
        );
    }

    #[test]
    fn output_native_system_rate_is_not_resampled_before_the_stable_mix_rate() {
        let target = resolve_target_sample_rate(Some(16_000), Some(48_000)).unwrap();
        assert_eq!(target, 48_000);
        assert!(source_resampler_for(Some(48_000), target)
            .unwrap()
            .is_none());
        assert!(source_resampler_for(Some(16_000), target)
            .unwrap()
            .is_some());
    }

    /// 44.1 kHz mic + 48 kHz loopback is the default macOS pairing, and it must
    /// resolve to the higher rate instead of refusing the recording.
    #[test]
    fn resolve_target_sample_rate_prefers_the_higher_rate() {
        assert_eq!(
            resolve_target_sample_rate(Some(44_100), Some(48_000)).unwrap(),
            48_000
        );
        assert_eq!(
            resolve_target_sample_rate(Some(48_000), Some(44_100)).unwrap(),
            48_000
        );
    }

    #[test]
    fn resolve_target_sample_rate_rejects_sessions_without_any_usable_rate() {
        let error = resolve_target_sample_rate(None, None).unwrap_err();
        assert!(error.contains("Unable to determine a sample rate"));
        let error = resolve_target_sample_rate(Some(0), Some(0)).unwrap_err();
        assert!(error.contains("Unable to determine a sample rate"));
    }

    /// One second of a sine at `frequency`, laid out interleaved across
    /// `channels` identical channels, exactly as cpal hands it to the callback.
    fn interleaved_tone(
        sample_rate: u32,
        channels: usize,
        frequency: f32,
        frames: usize,
    ) -> Vec<f32> {
        let mut data = Vec::with_capacity(frames * channels);
        for frame in 0..frames {
            let value =
                (std::f32::consts::TAU * frequency * frame as f32 / sample_rate as f32).sin() * 0.5;
            for _ in 0..channels {
                data.push(value);
            }
        }
        data
    }

    /// Run one source's interleaved callback data through the real capture-side
    /// path (downmix + enqueue) and then through the mixing thread's converter,
    /// producing the mono, target-rate stream the mixer actually sees.
    fn capture_source(
        interleaved: &[f32],
        channels: usize,
        source_rate: u32,
        target_rate: u32,
    ) -> Vec<f32> {
        let queue = crossbeam::queue::ArrayQueue::new(interleaved.len().max(1));
        let dropped = AtomicU64::new(0);
        push_normalized_samples(interleaved, channels, &queue, &dropped);
        assert_eq!(
            dropped.load(Ordering::Relaxed),
            0,
            "test queue must be large enough to hold the whole fixture"
        );

        let mut mono = Vec::new();
        while let Some(sample) = queue.pop() {
            mono.push(sample);
        }

        match source_resampler_for(Some(source_rate), target_rate).expect("resampler") {
            Some(mut resampler) => {
                let mut converted = Vec::new();
                resampler.push(&mono, &mut converted);
                converted
            }
            None => mono,
        }
    }

    fn drain_all(
        mixer: &mut FrameMixer,
        mic_starved: bool,
        system_starved: bool,
    ) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let mut mixed = Vec::new();
        let mut mic = Vec::new();
        let mut system = Vec::new();
        while mixer.drain_into(
            mic_starved,
            system_starved,
            &mut mixed,
            &mut mic,
            &mut system,
        ) > 0
        {}
        (mixed, mic, system)
    }

    /// The regression this lane exists for: every mic/system combination of 1ch
    /// vs 2ch and 44.1 kHz vs 48 kHz must produce mixed, `_mic` and `_system`
    /// tracks of identical length, all mono, with no accumulating skew.
    #[test]
    fn mixer_keeps_sources_aligned_across_channel_and_rate_combinations() {
        for mic_channels in [1usize, 2] {
            for system_channels in [1usize, 2] {
                for mic_rate in [44_100u32, 48_000] {
                    for system_rate in [44_100u32, 48_000] {
                        let target = resolve_target_sample_rate(Some(mic_rate), Some(system_rate))
                            .expect("mixed sessions always resolve a rate");
                        assert_eq!(target, mic_rate.max(system_rate));

                        // Two seconds of audio from each device, at that
                        // device's own rate and channel count.
                        let mic_frames = (mic_rate as usize) * 2;
                        let system_frames = (system_rate as usize) * 2;
                        let mic_mono = capture_source(
                            &interleaved_tone(mic_rate, mic_channels, 220.0, mic_frames),
                            mic_channels,
                            mic_rate,
                            target,
                        );
                        let system_mono = capture_source(
                            &interleaved_tone(system_rate, system_channels, 440.0, system_frames),
                            system_channels,
                            system_rate,
                            target,
                        );

                        let label = format!(
                            "mic {mic_channels}ch/{mic_rate}Hz + system {system_channels}ch/{system_rate}Hz"
                        );

                        // Both sources should now describe the same span of
                        // wall-clock time to within one resampler chunk.
                        let skew = mic_mono.len().abs_diff(system_mono.len());
                        assert!(
                            skew <= RESAMPLE_CHUNK_FRAMES * 2,
                            "{label}: sources drifted by {skew} frames \
                             (mic {}, system {})",
                            mic_mono.len(),
                            system_mono.len()
                        );

                        let mut mixer = FrameMixer::new(true, true);
                        mixer.push_mic(&mic_mono);
                        mixer.push_system(&system_mono);
                        let (mixed, mic, system) = drain_all(&mut mixer, true, true);

                        assert_eq!(mixed.len(), mic.len(), "{label}: mic track length");
                        assert_eq!(mixed.len(), system.len(), "{label}: system track length");
                        assert_eq!(
                            mixed.len(),
                            mic_mono.len().max(system_mono.len()),
                            "{label}: mixed length"
                        );

                        let counts = mixer.counts();
                        assert_eq!(counts.mixed, mixed.len() as u64, "{label}: mixed count");
                        assert_eq!(counts.mic, counts.mixed, "{label}: mic frame count");
                        assert_eq!(counts.system, counts.mixed, "{label}: system frame count");

                        // Aligned, not merely equal-length: the leading two
                        // seconds must be the two sources laid on top of each
                        // other frame for frame, not one lagging the other.
                        let aligned = mic_mono.len().min(system_mono.len());
                        for index in (0..aligned).step_by(97) {
                            let want = ((mic_mono[index] * 0.7) + (system_mono[index] * 0.7))
                                .clamp(-1.0, 1.0);
                            assert!(
                                (mixed[index] - want).abs() <= 1.0e-6,
                                "{label}: frame {index} misaligned"
                            );
                            assert!((mic[index] - mic_mono[index]).abs() <= 1.0e-6, "{label}");
                            assert!(
                                (system[index] - system_mono[index]).abs() <= 1.0e-6,
                                "{label}"
                            );
                        }
                    }
                }
            }
        }
    }

    /// Interleaved bursts, as the two cpal callbacks actually arrive: whatever
    /// order and size the chunks land in, the emitted tracks stay frame-aligned.
    #[test]
    fn mixer_absorbs_bursty_arrival_without_skew() {
        let mut mixer = FrameMixer::new(true, true);
        let mut mixed = Vec::new();
        let mut mic = Vec::new();
        let mut system = Vec::new();

        let mic_source: Vec<f32> = (0..4_800).map(|index| index as f32 / 4_800.0).collect();
        let system_source: Vec<f32> = (0..4_800).map(|index| -(index as f32) / 4_800.0).collect();

        let mut mic_cursor = 0usize;
        let mut system_cursor = 0usize;
        // Deliberately mismatched burst sizes so one source is always ahead.
        for round in 0..64 {
            let mic_burst = (mic_cursor + 128).min(mic_source.len());
            mixer.push_mic(&mic_source[mic_cursor..mic_burst]);
            mic_cursor = mic_burst;
            if round % 3 != 2 {
                let system_burst = (system_cursor + 192).min(system_source.len());
                mixer.push_system(&system_source[system_cursor..system_burst]);
                system_cursor = system_burst;
            }
            mixer.drain_into(false, false, &mut mixed, &mut mic, &mut system);
            assert_eq!(mixed.len(), mic.len());
            assert_eq!(mixed.len(), system.len());
        }

        // Nothing was padded: neither source was ever declared starved.
        let counts = mixer.counts();
        assert_eq!(counts.mic_padded, 0);
        assert_eq!(counts.system_padded, 0);
        for index in 0..mixed.len() {
            assert!((mic[index] - mic_source[index]).abs() <= 1.0e-6, "{index}");
            assert!(
                (system[index] - system_source[index]).abs() <= 1.0e-6,
                "{index}"
            );
        }
    }

    /// A mid-meeting device disconnect must not stall the recording or shorten
    /// one track relative to the others: the dead source is padded with silence.
    #[test]
    fn mixer_pads_a_starved_source_with_silence() {
        let mut mixer = FrameMixer::new(true, true);
        mixer.push_mic(&[0.4; 600]);
        mixer.push_system(&[0.2; 200]);

        // While the system source is merely behind, only the frames both can
        // cover are released.
        let (mixed, mic, system) = drain_all(&mut mixer, false, false);
        assert_eq!(mixed.len(), 200);
        assert_eq!(mic.len(), 200);
        assert_eq!(system.len(), 200);
        assert_eq!(mixer.counts().system_padded, 0);

        // Once it is declared starved, the mic's remaining frames are released
        // against silence rather than being held back forever.
        let (mixed, mic, system) = drain_all(&mut mixer, false, true);
        assert_eq!(mixed.len(), 400);
        assert_eq!(mic.len(), 400);
        assert_eq!(system.len(), 400);
        assert!(system.iter().all(|sample| *sample == 0.0));
        assert!(mic.iter().all(|sample| (*sample - 0.4).abs() <= 1.0e-6));

        let counts = mixer.counts();
        assert_eq!(counts.mixed, 600);
        assert_eq!(counts.mic, 600);
        assert_eq!(counts.system, 600);
        assert_eq!(counts.system_padded, 400);
        assert_eq!(counts.mic_padded, 0);
    }

    #[test]
    fn mixer_passes_a_single_enabled_source_through_unchanged() {
        let mut mixer = FrameMixer::new(false, true);
        mixer.push_system(&[0.9; 32]);
        let (mixed, mic, system) = drain_all(&mut mixer, false, false);
        assert_eq!(mixed.len(), 32);
        assert!(mic.is_empty());
        assert_eq!(system.len(), 32);
        assert!(mixed.iter().all(|sample| (*sample - 0.9).abs() <= 1.0e-6));
        assert_eq!(mixer.counts().mic, 0);
    }

    #[test]
    fn resampler_converts_to_the_target_rate_and_preserves_the_tone() {
        let source_rate = 44_100u32;
        let target_rate = 48_000u32;
        let frames = source_rate as usize;
        let mono = capture_source(
            &interleaved_tone(source_rate, 1, 1_000.0, frames),
            1,
            source_rate,
            target_rate,
        );

        let expected = (frames as f64 * target_rate as f64 / source_rate as f64) as usize;
        assert!(
            mono.len().abs_diff(expected) <= RESAMPLE_CHUNK_FRAMES * 2,
            "converted {} frames, expected about {}",
            mono.len(),
            expected
        );

        // Skip the resampler's start-up delay, then check the tone survived.
        let steady = &mono[mono.len() / 4..];
        let peak = steady.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!((peak - 0.5).abs() < 0.05, "peak amplitude {peak}");
    }

    #[test]
    fn resampler_keeps_one_sub_chunk_of_conversion_latency() {
        // Pins the geometry `RESAMPLE_CHUNK_FRAMES` documents. rubato's plain
        // `Fft::new` derives `sub_chunks` from the chunk size, which would split
        // this into four shorter FFT blocks and quietly change how much latency
        // the mic/system conversion adds ahead of the mixer. Both capture sources
        // are aligned against that latency, so it is a correctness property here,
        // not a tuning knob.
        let resampler = SourceResampler::new(44_100, 48_000).expect("resampler");

        // One sub-chunk rounds 1024 up to seven 147-frame rate-ratio periods, so
        // the internal FFT spans 1029 input frames against 1120 output frames and
        // the conversion delay is half of that. Four sub-chunks would instead land
        // on 320 output frames and a 160-frame delay.
        assert_eq!(resampler.resampler.output_delay(), 560);

        // The input side stays fixed at the requested chunk regardless.
        assert_eq!(
            resampler.resampler.input_frames_next(),
            RESAMPLE_CHUNK_FRAMES
        );
    }

    #[test]
    fn resampler_flushes_a_partial_tail_at_route_cutover() {
        let mut resampler = SourceResampler::new(44_100, 48_000).expect("resampler");
        let partial = vec![0.25; 200];
        let mut output = Vec::new();

        resampler.push(&partial, &mut output);
        assert!(output.is_empty(), "partial input should remain pending");
        resampler.finish(&mut output);

        let expected = (partial.len() as f64 * 48_000.0 / 44_100.0).ceil() as usize;
        assert_eq!(output.len(), expected);
        assert!(resampler.pending.is_empty());
    }

    #[test]
    fn silence_watchdog_warns_once_after_a_previously_active_source_goes_quiet() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &MIC_SILENCE_PROFILE);
        let window = sample_rate as usize;
        let warn_after = MIC_SILENCE_PROFILE.warn_after_seconds as usize;

        // Never active: silence alone must not warn.
        for _ in 0..(warn_after + 5) {
            assert!(watchdog.observe(&vec![0.0; window], 0).is_none());
        }

        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());

        let mut warnings = Vec::new();
        for _ in 0..(warn_after + 5) {
            if let Some(seconds) = watchdog.observe(&vec![0.0; window], 0) {
                warnings.push(seconds);
            }
        }
        assert_eq!(warnings.len(), 1, "warned {:?}", warnings);
        assert!((warnings[0] - MIC_SILENCE_PROFILE.warn_after_seconds).abs() < 1.5);

        // Recovering re-arms the watchdog for a second dropout.
        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());
        let mut second = None;
        for _ in 0..(warn_after + 5) {
            if let Some(seconds) = watchdog.observe(&vec![0.0; window], 0) {
                second = Some(seconds);
            }
        }
        assert!(second.is_some(), "watchdog must re-arm after recovery");
    }

    /// The regression: a loopback reads as exact zeros for as long as nobody on
    /// the far side is playing anything, so an ordinary meeting where you do
    /// the talking used to trip a "system audio went silent" warning within
    /// half a minute. Silence from a still-delivering loopback is not a fault.
    #[test]
    fn quiet_but_live_loopback_never_warns() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &SYSTEM_SILENCE_PROFILE);
        let window = sample_rate as usize;

        // Somebody shares audio briefly, then nothing plays for ten minutes
        // while the device keeps delivering its buffers on schedule.
        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());
        for second in 0..600 {
            assert!(
                watchdog.observe(&vec![0.0; window], 0).is_none(),
                "warned at {second}s of an ordinary quiet stretch"
            );
        }
    }

    /// A loopback that has actually gone away stops driving its cpal callback,
    /// so the mixer starts padding its track. That is the corroboration, and
    /// with it the warning must still fire.
    #[test]
    fn loopback_that_stops_delivering_still_warns() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &SYSTEM_SILENCE_PROFILE);
        let window = sample_rate as usize;
        let warn_after = SYSTEM_SILENCE_PROFILE.warn_after_seconds as usize;

        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());

        let mut warnings = Vec::new();
        for _ in 0..(warn_after + 5) {
            // Every frame in this window had to be padded: the device is gone.
            if let Some(seconds) = watchdog.observe(&vec![0.0; window], window as u64) {
                warnings.push(seconds);
            }
        }
        assert_eq!(warnings.len(), 1, "warned {:?}", warnings);
        assert!((warnings[0] - SYSTEM_SILENCE_PROFILE.warn_after_seconds).abs() < 1.5);
    }

    /// The regression the corroboration rule itself had: it latched on the
    /// first padded frame ever seen in a silent run, so one ordinary scheduling
    /// stall — a display sleeping, a Bluetooth route switching — armed the
    /// warning for the rest of the meeting and the false "system audio went
    /// silent" came back minutes later on a perfectly healthy loopback.
    #[test]
    fn one_delivery_hiccup_does_not_arm_the_loopback_warning() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &SYSTEM_SILENCE_PROFILE);
        let window = sample_rate as usize;

        // Somebody shares audio, then nothing plays. One second in, the device
        // misses a single callback and the mixer pads a frame for it; after
        // that it delivers on schedule for ten minutes.
        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());
        assert!(watchdog.observe(&vec![0.0; window], 1).is_none());
        for second in 0..600 {
            assert!(
                watchdog.observe(&vec![0.0; window], 0).is_none(),
                "warned at {second}s after a single 400ms delivery hiccup"
            );
        }
    }

    /// A stall long enough to pad a whole window is still a stall, not a
    /// departure: the device comes back, so the run of starved windows breaks
    /// before it is long enough to corroborate anything.
    #[test]
    fn an_intermittent_stall_never_accumulates_into_corroboration() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &SYSTEM_SILENCE_PROFILE);
        let window = sample_rate as usize;

        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());
        for second in 0..600 {
            // Fully padded every fourth window, delivered the rest of the time.
            let padded = if second % 4 == 0 { window as u64 } else { 0 };
            assert!(
                watchdog.observe(&vec![0.0; window], padded).is_none(),
                "warned at {second}s of an intermittently stalling but live loopback"
            );
        }
    }

    /// A loopback that goes quiet first and dies later must still be reported,
    /// and reported on the silence fuse rather than made to wait out a second
    /// one — the user is owed the warning as soon as both facts are true.
    #[test]
    fn a_loopback_that_dies_partway_through_a_quiet_stretch_still_warns() {
        let sample_rate = 16_000u32;
        let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &SYSTEM_SILENCE_PROFILE);
        let window = sample_rate as usize;
        let warn_after = SYSTEM_SILENCE_PROFILE.warn_after_seconds as usize;
        let died_at = warn_after - 30;

        assert!(watchdog.observe(&vec![0.3; window], 0).is_none());

        let mut warned_at = None;
        for second in 0..(warn_after + 30) {
            let padded = if second >= died_at { window as u64 } else { 0 };
            if watchdog.observe(&vec![0.0; window], padded).is_some() {
                warned_at = Some(second);
                break;
            }
        }

        let warned_at = warned_at.expect("a departed loopback must still be reported");
        assert!(
            warned_at >= warn_after - 1 && warned_at <= warn_after + 2,
            "warned at {warned_at}s; the silence fuse is {warn_after}s"
        );
    }

    /// The distinction stated as a contrast: byte-for-byte identical input —
    /// a burst of audio then unbroken digital silence, with the device still
    /// delivering — is a fault on a microphone and an ordinary quiet stretch on
    /// a loopback. Applying one rule to both is what produced the false
    /// "system audio went silent" warning.
    #[test]
    fn identical_silence_is_a_fault_on_a_mic_and_ordinary_on_a_loopback() {
        let sample_rate = 16_000u32;
        let window = sample_rate as usize;

        let observe_run = |profile: &SourceSilenceProfile| -> Option<f32> {
            let mut watchdog = SourceSilenceWatchdog::new(sample_rate, profile);
            watchdog.observe(&vec![0.3; window], 0);
            let mut warning = None;
            for _ in 0..600 {
                if let Some(seconds) = watchdog.observe(&vec![0.0; window], 0) {
                    warning = Some(seconds);
                }
            }
            warning
        };

        assert!(
            observe_run(&MIC_SILENCE_PROFILE).is_some(),
            "a microphone delivering exact zeros has failed"
        );
        assert!(
            observe_run(&SYSTEM_SILENCE_PROFILE).is_none(),
            "a loopback delivering exact zeros is just nobody sharing audio"
        );
    }
}
