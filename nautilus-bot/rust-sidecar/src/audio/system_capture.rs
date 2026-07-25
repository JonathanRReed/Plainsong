//! System audio capture for macOS and Windows loopback devices.

use super::for_each_mono_sample;
use crate::sidecar_handle::SidecarHandle;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam::channel::TrySendError;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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
) where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    for_each_mono_sample(data, num_channels, |normalized| {
        if buffer.push(normalized).is_err() {
            let _ = buffer.pop();
            let _ = buffer.push(normalized);
            dropped_samples.fetch_add(1, Ordering::Relaxed);
        }
    });
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
}

impl SourceResampler {
    fn new(source_rate: u32, target_rate: u32) -> Result<Self> {
        let resampler = Fft::<f32>::new(
            source_rate as usize,
            target_rate as usize,
            RESAMPLE_CHUNK_FRAMES,
            1,
            1,
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
        })
    }

    /// Append `samples` (mono, at the source rate) and drain every full chunk
    /// the resampler can produce onto `out` (mono, at the target rate).
    fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        let Self {
            resampler,
            pending,
            scratch,
        } = self;
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

/// Hand one finished chunk to a writer channel. Returns `false` when the
/// receiver is gone and capture should stop.
fn forward_chunk(
    sender: &crossbeam::channel::Sender<Vec<f32>>,
    chunk: Vec<f32>,
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

struct LoopbackDeviceSelection {
    device: cpal::Device,
    display_name: String,
    stream_config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
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

pub struct MixedAudioCaptureStart {
    pub mixed_receiver: crossbeam::channel::Receiver<Vec<f32>>,
    pub mic_receiver: Option<crossbeam::channel::Receiver<Vec<f32>>>,
    pub system_receiver: Option<crossbeam::channel::Receiver<Vec<f32>>>,
    pub sample_rate: u32,
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

    /// Check if system audio capture is available.
    pub fn is_available(&self) -> bool {
        self.find_loopback_device().ok().flatten().is_some()
    }

    fn find_loopback_device(&self) -> Result<Option<LoopbackDeviceSelection>> {
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
            let sample_format = supported_config.sample_format();
            let stream_config = supported_config.config();

            tracing::info!("Found loopback device: {}", label);
            return Ok(Some(LoopbackDeviceSelection {
                device,
                display_name: label,
                stream_config,
                sample_format,
            }));
        }

        Ok(None)
    }

    pub fn get_loopback_device_name(&self) -> Result<Option<String>> {
        match self.find_loopback_device()? {
            Some(selection) => Ok(Some(selection.display_name)),
            None => Ok(None),
        }
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

        let (mixed_sender, mixed_receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
        let (mic_sender, mic_receiver) = if capture_mic {
            let (sender, receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let (system_sender, system_receiver) = if capture_system {
            let (sender, receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let (ready_tx, ready_rx) =
            crossbeam::channel::bounded::<std::result::Result<u32, String>>(1);
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
                    macro_rules! build_mic_stream {
                        ($sample_type:ty) => {{
                            let mic_buffer = Arc::clone(&mic_buffer);
                            let is_capturing = Arc::clone(&is_capturing);
                            let dropped_samples = Arc::clone(&dropped_mic_samples);

                            device.build_input_stream(
                                stream_config.clone(),
                                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                    if is_capturing.load(Ordering::SeqCst) {
                                        push_normalized_samples(
                                            data,
                                            num_channels,
                                            &mic_buffer,
                                            &dropped_samples,
                                        );
                                    }
                                },
                                |err| tracing::error!("Mic stream error: {}", err),
                                None,
                            )
                        }};
                    }

                    let stream = match sample_format {
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
                    }?;

                    stream.play()?;
                    Ok(stream)
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
                let mut setup = || -> Result<cpal::Stream> {
                    let sys_capture = SystemAudioCapture::new();
                    let loopback = sys_capture
                        .find_loopback_device()?
                        .ok_or_else(|| anyhow::anyhow!("Loopback device not found"))?;

                    let config = loopback.stream_config;
                    let sample_format = loopback.sample_format;
                    system_sample_rate = Some(config.sample_rate);
                    // BlackHole and friends are 2ch by default; without this the
                    // system queue fills at twice the mono frame rate.
                    let num_channels = config.channels as usize;
                    system_channels = num_channels;
                    macro_rules! build_system_stream {
                        ($sample_type:ty) => {{
                            let system_buffer = Arc::clone(&system_buffer);
                            let is_capturing = Arc::clone(&is_capturing);
                            let dropped_samples = Arc::clone(&dropped_system_samples);

                            loopback.device.build_input_stream(
                                config.clone(),
                                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                    if is_capturing.load(Ordering::SeqCst) {
                                        push_normalized_samples(
                                            data,
                                            num_channels,
                                            &system_buffer,
                                            &dropped_samples,
                                        );
                                    }
                                },
                                |err| tracing::error!("System stream error: {}", err),
                                None,
                            )
                        }};
                    }

                    let stream = match sample_format {
                        cpal::SampleFormat::I8 => build_system_stream!(i8),
                        cpal::SampleFormat::I16 => build_system_stream!(i16),
                        cpal::SampleFormat::I24 => build_system_stream!(cpal::I24),
                        cpal::SampleFormat::I32 => build_system_stream!(i32),
                        cpal::SampleFormat::I64 => build_system_stream!(i64),
                        cpal::SampleFormat::U8 => build_system_stream!(u8),
                        cpal::SampleFormat::U16 => build_system_stream!(u16),
                        cpal::SampleFormat::U24 => build_system_stream!(cpal::U24),
                        cpal::SampleFormat::U32 => build_system_stream!(u32),
                        cpal::SampleFormat::U64 => build_system_stream!(u64),
                        cpal::SampleFormat::F32 => build_system_stream!(f32),
                        cpal::SampleFormat::F64 => build_system_stream!(f64),
                        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
                    }?;

                    stream.play()?;
                    Ok(stream)
                };

                match setup() {
                    Ok(stream) => _sys_stream = Some(stream),
                    Err(e) => {
                        let message = format!("Failed to start system stream: {}", e);
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

            while is_capturing.load(Ordering::SeqCst) {
                let now = Instant::now();

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

                if capture_system {
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
                    let chunk = std::mem::take(&mut output);
                    if let Some(queue) = streaming_queue.as_ref() {
                        if queue.push(chunk.clone()).is_err() {
                            let _ = queue.pop();
                            let _ = queue.push(chunk.clone());
                        }
                    }
                    if !forward_chunk(&mixed_sender, chunk, &dropped_mixed_chunks) {
                        is_capturing.store(false, Ordering::SeqCst);
                        break;
                    }

                    if let (Some(sender), false) = (mic_sender.as_ref(), mic_output.is_empty()) {
                        let mic_chunk = std::mem::take(&mut mic_output);
                        if !forward_chunk(sender, mic_chunk, &dropped_mixed_chunks) {
                            is_capturing.store(false, Ordering::SeqCst);
                            break;
                        }
                    }

                    if let (Some(sender), false) =
                        (system_sender.as_ref(), system_output.is_empty())
                    {
                        let system_chunk = std::mem::take(&mut system_output);
                        if !forward_chunk(sender, system_chunk, &dropped_mixed_chunks) {
                            is_capturing.store(false, Ordering::SeqCst);
                            break;
                        }
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
                let _ = forward_chunk(&mixed_sender, output, &dropped_mixed_chunks);
            }

            if let (Some(sender), false) = (mic_sender.as_ref(), mic_output.is_empty()) {
                let _ = sender.try_send(mic_output);
            }

            if let (Some(sender), false) = (system_sender.as_ref(), system_output.is_empty()) {
                let _ = sender.try_send(system_output);
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
                    mixed_receiver,
                    mic_receiver,
                    system_receiver,
                    sample_rate,
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
