pub mod enhance;
pub mod mel;
pub mod preroll;
pub mod silero_vad;
pub mod system_capture;
pub mod utils;
pub mod vad;
pub mod waveform;

use crate::audio::enhance::AudioPreprocessor;
use crate::audio::preroll::{
    PreRollBuffer, PRE_ROLL_MAX_AGE_MS, PRE_ROLL_SECONDS, PRE_ROLL_SPEECH_LEAD_SECONDS,
};
use crate::audio::silero_vad::build_vad_gate;
use crate::audio::system_capture::{
    MixedAudioCapture, MixedAudioChunk, MixedCaptureEvents, SystemAudioCapability,
};
use crate::audio::vad::{VadBackendKind, VadConfig, VadEdge, VadGate};
use crate::models::RecordingOptions;
use crate::recording_audio::{
    create_new_file, sync_file, sync_parent_directory, validate_plaintext_wav, RecordingAudioRole,
    RecordingAudioValidation, RecordingCapturePlan, ValidatedRecordingAudio,
};
use crate::settings;
use crate::sidecar_handle::SidecarHandle;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use crossbeam::channel::{bounded, Receiver, TrySendError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How much longer capture keeps running after the user asks it to stop.
///
/// This is deliberate extra recording, not slack waiting for a device to drain.
/// A speaker's final consonant is still arriving when the key comes up, and
/// cutting at the gesture clips it — the worst failure this path has.
///
/// It is also the single largest component of felt dictation latency. Measured
/// end to end on a packaged build: stop-press to text-delivered ~265ms, of which
/// Whisper was 69ms and this tail was 120ms.
///
/// An attempt to make it adaptive — poll `dictation_callback_count` and return
/// as soon as the input stops delivering — was tried and reverted. It saves
/// ~7ms (133ms -> 126ms) and cannot save more: the capture callback fires
/// continuously until `is_dictating` goes false, which happens *after* this
/// wait, so there is no quiet period to detect. Anything faster here is a real
/// trade against clipping the end of the last word, and needs testing against
/// human speech rather than a `say` fixture.
const DICTATION_STOP_CAPTURE_TAIL_MS: u64 = 120;
const DICTATION_MIN_CAPTURE_SECONDS: f32 = 0.35;
const DICTATION_SHORT_CAPTURE_PEAK_THRESHOLD: f32 = 0.008;
const DICTATION_SHORT_CAPTURE_RMS_THRESHOLD: f32 = 0.002;
/// Frame size (in samples, at the dictation capture's actual sample rate) used to
/// drive the streaming auto-stop VAD gate. Mirrors the batch detector's ~30ms-at-16kHz
/// framing convention (see `VadConfig::default`), scaled to the live sample rate so
/// behavior doesn't depend on the OS/device's cpal callback cadence.
const DICTATION_AUTO_STOP_FRAME_MS: f32 = 30.0;
/// Minimum sustained speech before auto-stop-on-silence is allowed to arm, so a
/// stray cough or click can't immediately end the session once it goes quiet.
const DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS: f32 = 0.5;

fn to_f32_sample<T>(sample: T) -> f32
where
    T: Sample,
    f32: FromSample<T>,
{
    f32::from_sample(sample)
}

fn for_each_mono_sample<T>(data: &[T], num_channels: usize, mut visit: impl FnMut(f32))
where
    T: Sample,
    f32: FromSample<T>,
{
    if num_channels <= 1 {
        for &sample in data {
            visit(to_f32_sample(sample));
        }
        return;
    }

    for frame in data.chunks_exact(num_channels) {
        let mono = frame
            .iter()
            .map(|&sample| to_f32_sample(sample))
            .sum::<f32>()
            / num_channels as f32;
        visit(mono);
    }
}

fn downmix_to_mono<T>(data: &[T], num_channels: usize) -> Vec<f32>
where
    T: Sample,
    f32: FromSample<T>,
{
    let capacity = if num_channels <= 1 {
        data.len()
    } else {
        data.len() / num_channels
    };
    let mut mono = Vec::with_capacity(capacity);
    for_each_mono_sample(data, num_channels, |sample| mono.push(sample));
    mono
}

/// Per-session configuration for "auto-stop dictation after sustained silence",
/// resolved once from settings when a dictation session starts.
#[derive(Debug, Clone)]
pub struct DictationAutoStopConfig {
    pub enabled: bool,
    /// Continuous silence duration (seconds) required to trigger auto-stop,
    /// following at least `DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS` of detected speech.
    pub silence_timeout_seconds: f32,
    /// Which VAD implementation should drive this session's auto-stop gate
    /// (and the hands-free monitor's auto-start gate). Resolved once from the
    /// `dictation_vad_backend` setting by the caller (lib.rs); `build_vad_gate`
    /// handles falling back to `EnergyThreshold` if `Silero` was requested but
    /// isn't actually usable.
    pub vad_backend: VadBackendKind,
    /// Filesystem path to the downloaded Silero VAD ONNX model, if any. Only
    /// consulted when `vad_backend == VadBackendKind::Silero`; `None` (e.g.
    /// the model was never downloaded) is a normal, handled case that
    /// triggers the energy-threshold fallback rather than an error.
    pub silero_model_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub transport_type: Option<String>,
    pub is_default: bool,
    pub is_available: bool,
    pub is_bluetooth_like: bool,
    pub channel_count: Option<u16>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAudioInputDevice {
    pub device_id: String,
    pub device_name: String,
    pub transport_type: Option<String>,
    pub is_default: bool,
    pub is_bluetooth_like: bool,
    pub used_fallback: bool,
    pub advisory: Option<String>,
}

/// Snapshot of the configuration a running hands-free monitor was started
/// with, so `reconcile_hands_free_monitor` (lib.rs) can detect when settings
/// changed out from under a running monitor (VAD backend selected, Silero
/// model downloaded, input device switched) and restart it with the new
/// configuration instead of letting the stale stream run forever.
#[derive(Debug, Clone, PartialEq)]
pub struct HandsFreeMonitorConfig {
    pub vad_backend: VadBackendKind,
    pub silero_model_path: Option<PathBuf>,
    /// Requested device preference (not the resolved device), matching what
    /// reconcile derives from settings so comparisons are settings-vs-settings.
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

pub struct AudioCapture {
    is_dictating: Arc<AtomicBool>,
    dictation_buffer: Arc<crossbeam::queue::SegQueue<f32>>,
    dictation_thread: Option<JoinHandle<()>>,
    dictation_sample_rate: u32,
    dictation_channels: u16,
    recordings_dir: PathBuf,
    host: cpal::Host,
    active_recording: Option<ActiveRecordingSession>,
    /// Audio preprocessor for noise suppression
    preprocessor: Option<AudioPreprocessor>,
    /// Enable noise suppression
    noise_suppression_enabled: bool,
    /// Current audio level (0.0 to 1.0) for visualization
    dictation_audio_level: Arc<std::sync::atomic::AtomicU32>,
    /// Number of callback invocations observed for the active dictation stream
    dictation_callback_count: Arc<AtomicU64>,
    /// Stop flag owned by the *current* dictation capture session's thread and
    /// callbacks. A fresh Arc per `start_dictation` (unlike the long-lived
    /// `is_dictating`, which is shared across sessions): if an old capture
    /// thread outlives its stop (slow stream teardown, detached abort join), a
    /// new session flipping `is_dictating` back to true can no longer re-arm
    /// the old thread's parking loop or its callbacks, so a stale stream can
    /// never push interleaved samples into a new session's buffer.
    dictation_capture_stop: Option<Arc<AtomicBool>>,
    /// UI-only accumulator of mono dictation samples for streaming partials.
    /// Never feeds the final transcription; only read by the partial-decode task.
    dictation_partial_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    /// When true, capture callbacks append mono samples to the partial buffer.
    /// When false, callbacks do no extra work (no allocation, no lock).
    dictation_streaming_active: Arc<AtomicBool>,
    /// Streaming speech/silence gate driving "auto-stop after sustained silence".
    /// `None` when auto-stop is disabled for the active session (no per-frame work).
    /// Scoped to `dictation_vad_session_id` so a stale gate from a previous session
    /// can never fire into a new one (mirrors how `dictation_partial_buffer` is
    /// scoped to `active_session_id` at the lib.rs layer).
    ///
    /// Boxed as `dyn VadGate` so the capture callback can drive either the
    /// energy-threshold heuristic or the Silero-backed detector through the
    /// exact same call sites (see `crate::audio::vad::VadGate`); which
    /// concrete backend is behind the box is decided once, when the gate is
    /// installed in `start_dictation`, by `crate::audio::silero_vad::build_vad_gate`.
    dictation_vad_gate: Arc<std::sync::Mutex<Option<Box<dyn VadGate + Send>>>>,
    /// Monotonic id of the dictation session the VAD gate above belongs to.
    /// Bumped every `start_dictation` call; the callback only acts on the gate
    /// when this still matches the session it captured at spawn time.
    dictation_vad_session_id: Arc<AtomicU64>,
    /// Cheap, lock-free mirror of "is `dictation_vad_gate` actually `Some(_)` for
    /// the current session" (i.e. auto-stop-on-silence is enabled). Checked by
    /// the capture callback *before* deciding whether to build `mono_scratch` or
    /// take the `dictation_vad_gate` mutex, so sessions with auto-stop disabled
    /// (the default) skip that per-callback allocation/lock entirely instead of
    /// paying for a lock just to find `None` inside every callback.
    dictation_vad_gate_active: Arc<AtomicBool>,
    /// Loop-control flag for the hands-free *idle-time* monitor stream (see
    /// `start_hands_free_monitor`). Deliberately a separate flag from
    /// `is_dictating`: the monitor is a distinct, much simpler always-on-when-enabled
    /// capture stream that only runs while no dictation session is active, and must
    /// never be confused with (or accidentally torn down/kept alive by) the real
    /// dictation capture stream's own lifecycle.
    hands_free_monitor_active: Arc<AtomicBool>,
    /// Join handle for the hands-free monitor's capture thread, if currently running.
    hands_free_monitor_thread: Option<JoinHandle<()>>,
    /// Configuration the currently running hands-free monitor was started
    /// with (see [`HandsFreeMonitorConfig`]); `None` when it isn't running.
    hands_free_monitor_config: Option<HandsFreeMonitorConfig>,
    /// Rolling pre-roll of the last couple of seconds the hands-free idle
    /// monitor heard (see [`PreRollBuffer`]). `None` until a monitor has run.
    /// Drained by `start_dictation` so a hands-free session starts with the
    /// words the user already spoke instead of from the moment the fresh
    /// capture stream happened to open.
    dictation_pre_roll: Arc<std::sync::Mutex<Option<PreRollBuffer>>>,
    /// Microseconds from `start_dictation` entry to the first sample the
    /// capture callback delivered, or 0 while none has arrived yet. This is
    /// the number that moves when microphone cold-open cost changes, so it is
    /// measured rather than assumed.
    dictation_first_sample_us: Arc<AtomicU64>,
}

static SYSTEM_AUDIO_TEST_ACTIVE: AtomicBool = AtomicBool::new(false);

pub(crate) struct SystemAudioTestGuard;

impl Drop for SystemAudioTestGuard {
    fn drop(&mut self) {
        SYSTEM_AUDIO_TEST_ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn claim_system_audio_test(recording_active: bool) -> Result<SystemAudioTestGuard> {
    if recording_active {
        return Err(anyhow::anyhow!(
            "Cannot test system audio while a recording is active"
        ));
    }
    SYSTEM_AUDIO_TEST_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| anyhow::anyhow!("A system-audio test is already running"))?;
    Ok(SystemAudioTestGuard)
}

enum RecordingActivation {
    Microphone {
        activation_tx: crossbeam::channel::Sender<()>,
        activated_rx: crossbeam::channel::Receiver<std::result::Result<(), String>>,
    },
    Mixed(crate::audio::system_capture::MixedAudioCaptureStart),
}

struct ActiveRecordingSession {
    id: String,
    audio_path: PathBuf,
    mic_audio_path: Option<PathBuf>,
    system_audio_path: Option<PathBuf>,
    writer_handles: Vec<JoinHandle<Result<()>>>,
    activation: Option<RecordingActivation>,
    capture_stop_flag: Arc<AtomicBool>,
    capture_handle: Option<JoinHandle<()>>,
    mixed_capture: Option<MixedAudioCapture>,
    waveform_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    /// Shared queue for streaming preview: capture threads push chunks here
    pub streaming_queue: Arc<crossbeam::queue::ArrayQueue<Vec<f32>>>,
    /// Sample rate used by this recording
    pub sample_rate: u32,
    /// Dropped chunk counters captured during recording.
    dropped_stream_chunks: Arc<AtomicU64>,
    dropped_writer_chunks: Arc<AtomicU64>,
}

#[expect(
    dead_code,
    reason = "stop result includes launch QA counters returned across command boundaries"
)]
pub struct RecordingStopResult {
    pub audio_path: String,
    pub mic_audio_path: Option<String>,
    pub system_audio_path: Option<String>,
    pub validated_assets: Vec<(RecordingAudioRole, ValidatedRecordingAudio)>,
    pub content_hash: String,
    pub dropped_stream_chunks: u64,
    pub dropped_writer_chunks: u64,
    pub dropped_mic_samples: u64,
    pub dropped_system_samples: u64,
    pub dropped_mixed_chunks: u64,
}

/// Feed this callback's mono samples through the active dictation auto-stop VAD
/// gate (if any) and emit `dictation-vad-signal` when it reports sustained silence
/// after speech.
///
/// Scoped to `session_id`: the gate slot is only touched, and the event only
/// emitted, while `vad_session_id` still equals `session_id`. Combined with how
/// `start_dictation` sets `dictation_vad_session_id` before installing a new gate,
/// this guarantees a gate left running by a stale/just-stopped session can never
/// signal into a session that has since started (the id will have moved on).
///
/// `vad_gate` is a `Box<dyn VadGate>` so this same call site drives either the
/// energy-threshold heuristic or the Silero-backed detector interchangeably --
/// this function (and every other caller of the gate) has no branch on which
/// backend is actually installed; each `VadGate` impl does its own internal
/// framing/chunking of `mono_samples`.
fn drive_dictation_auto_stop_gate(
    mono_samples: &[f32],
    session_id: u64,
    vad_gate: &std::sync::Mutex<Option<Box<dyn VadGate + Send>>>,
    vad_session_id: &AtomicU64,
    event_handle: Option<&SidecarHandle>,
) {
    if mono_samples.is_empty() {
        return;
    }
    let Ok(mut gate_slot) = vad_gate.lock() else {
        return;
    };
    // Re-check under the lock: a newer session may have replaced/cleared the gate
    // between this callback firing and acquiring the lock.
    if vad_session_id.load(Ordering::SeqCst) != session_id {
        return;
    }
    let Some(gate) = gate_slot.as_mut() else {
        return;
    };

    let edge = gate.push_samples(mono_samples);
    let silence_after_speech = edge == VadEdge::SilenceStarted;

    // `SilenceStarted` only fires as an edge out of the speech state, so
    // `is_speaking()` being false here is guaranteed; asserted defensively so a
    // future change to the gate's edge semantics can't silently start emitting
    // spurious auto-stop signals while still (per the gate) mid-speech.
    if silence_after_speech && !gate.is_speaking() {
        let frames_per_second = gate.frames_per_second();
        // Consume this arm so we only signal once per silence period, not once per
        // remaining callback while the mic stays quiet; a new SpeechStarted edge
        // (tracked internally by the gate) re-arms it naturally.
        if let Some(handle) = event_handle {
            handle.emit(
                "dictation-vad-signal",
                serde_json::json!({
                    "signal": "silence_stop",
                    "sessionId": session_id,
                    "framesPerSecond": frames_per_second,
                    "vadBackend": gate.backend_name(),
                }),
            );
        }
    }
}

fn infer_transport_type(device_name: &str) -> String {
    let normalized = device_name.trim().to_ascii_lowercase();
    if normalized.contains("airpods")
        || normalized.contains("bluetooth")
        || normalized.contains("headset")
        || normalized.contains("hands-free")
    {
        "bluetooth".to_string()
    } else if normalized.contains("built-in") || normalized.contains("macbook") {
        "builtin".to_string()
    } else if normalized.contains("usb") {
        "usb".to_string()
    } else if normalized.contains("blackhole")
        || normalized.contains("loopback")
        || normalized.contains("soundflower")
        || normalized.contains("virtual")
    {
        "virtual".to_string()
    } else {
        "unknown".to_string()
    }
}

fn bluetooth_advisory_for_device(
    device_name: &str,
    transport_type: Option<&str>,
) -> Option<String> {
    let normalized = device_name.trim().to_ascii_lowercase();
    let bluetooth_like = transport_type == Some("bluetooth")
        || normalized.contains("airpods")
        || normalized.contains("bluetooth")
        || normalized.contains("headset")
        || normalized.contains("hands-free");
    if bluetooth_like {
        Some(
            "Bluetooth headset microphones can reduce playback quality during capture. Switch to your built-in or USB mic if audio sounds degraded."
                .to_string(),
        )
    } else {
        None
    }
}

fn device_name(device: &cpal::Device) -> Result<String, cpal::Error> {
    Ok(device.description()?.name().to_string())
}

fn build_audio_input_device_info(
    device: &cpal::Device,
    is_default: bool,
    index: usize,
) -> Option<AudioInputDeviceInfo> {
    let device_name = device_name(device).ok()?.trim().to_string();
    if device_name.is_empty() {
        return None;
    }
    let config = device.default_input_config().ok();
    let transport_type = infer_transport_type(&device_name);
    Some(AudioInputDeviceInfo {
        device_id: format!("input-{}-{}", index, device_name.to_ascii_lowercase()),
        device_name: device_name.clone(),
        transport_type: Some(transport_type.clone()),
        is_default,
        is_available: true,
        is_bluetooth_like: transport_type == "bluetooth",
        channel_count: config.as_ref().map(|value| value.channels()),
        sample_rate: config.as_ref().map(|value| value.sample_rate()),
    })
}

fn resolve_device_preference<'a>(
    devices: &'a [(cpal::Device, AudioInputDeviceInfo)],
    preference: Option<&settings::AudioInputDevicePreference>,
) -> Option<(&'a cpal::Device, &'a AudioInputDeviceInfo)> {
    let preference = preference?;
    devices
        .iter()
        .find(|(_, info)| info.device_id == preference.device_id)
        .or_else(|| {
            devices
                .iter()
                .find(|(_, info)| info.device_name == preference.device_name)
        })
        .map(|(device, info)| (device, info))
}

impl AudioCapture {
    pub fn new() -> Self {
        let recordings_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("recordings");

        std::fs::create_dir_all(&recordings_dir).ok();

        let host = cpal::default_host();

        let preprocessor = AudioPreprocessor::new(16000);

        Self {
            is_dictating: Arc::new(AtomicBool::new(false)),
            dictation_buffer: Arc::new(crossbeam::queue::SegQueue::new()),
            dictation_thread: None,
            dictation_sample_rate: 16000,
            dictation_channels: 1,
            recordings_dir,
            host,
            active_recording: None,
            preprocessor: Some(preprocessor),
            noise_suppression_enabled: true,
            dictation_audio_level: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            dictation_callback_count: Arc::new(AtomicU64::new(0)),
            dictation_capture_stop: None,
            dictation_partial_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
            dictation_streaming_active: Arc::new(AtomicBool::new(false)),
            dictation_vad_gate: Arc::new(std::sync::Mutex::new(None)),
            dictation_vad_session_id: Arc::new(AtomicU64::new(0)),
            dictation_vad_gate_active: Arc::new(AtomicBool::new(false)),
            hands_free_monitor_active: Arc::new(AtomicBool::new(false)),
            hands_free_monitor_thread: None,
            hands_free_monitor_config: None,
            dictation_pre_roll: Arc::new(std::sync::Mutex::new(None)),
            dictation_first_sample_us: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn plan_recording(&self, options: &RecordingOptions) -> Result<RecordingCapturePlan> {
        RecordingCapturePlan::new(&self.recordings_dir, options.mic, options.system_audio)
    }

    /// Check if system audio capture is available
    pub fn is_system_audio_available(&self) -> bool {
        let sys_capture = system_capture::SystemAudioCapture::new();
        sys_capture.is_available()
    }

    /// Get the name of the detected loopback device
    pub fn get_loopback_device_name(&self) -> Option<String> {
        let sys_capture = system_capture::SystemAudioCapture::new();
        sys_capture.get_loopback_device_name().ok().flatten()
    }

    pub fn system_audio_capability(&self) -> SystemAudioCapability {
        system_capture::SystemAudioCapture::new().capability()
    }

    pub fn list_input_devices(&self) -> Result<Vec<AudioInputDeviceInfo>> {
        let default_name = self
            .host
            .default_input_device()
            .and_then(|device| device_name(&device).ok());
        let devices = self
            .host
            .input_devices()
            .context("Failed to enumerate input devices")?;
        let mut inventory = Vec::new();
        for (index, device) in devices.enumerate() {
            let is_default = default_name
                .as_deref()
                .map(|name| device_name(&device).ok().as_deref() == Some(name))
                .unwrap_or(false);
            if let Some(info) = build_audio_input_device_info(&device, is_default, index) {
                inventory.push(info);
            }
        }
        Ok(inventory)
    }

    pub fn resolve_input_device(
        &self,
        preference: Option<&settings::AudioInputDevicePreference>,
    ) -> Result<(cpal::Device, ResolvedAudioInputDevice)> {
        let default_name = self
            .host
            .default_input_device()
            .and_then(|device| device_name(&device).ok());
        let default_device_info = self.host.default_input_device().and_then(|device| {
            let name = device_name(&device).ok()?;
            let transport_type = infer_transport_type(&name);
            Some(ResolvedAudioInputDevice {
                device_id: format!("default-{}", name.to_ascii_lowercase()),
                device_name: name.clone(),
                transport_type: Some(transport_type.clone()),
                is_default: true,
                is_bluetooth_like: transport_type == "bluetooth",
                used_fallback: false,
                advisory: bluetooth_advisory_for_device(&name, Some(&transport_type)),
            })
        });

        let devices = self
            .host
            .input_devices()
            .context("Failed to enumerate input devices")?;
        let mut candidates = Vec::new();
        for (index, device) in devices.enumerate() {
            let is_default = default_name
                .as_deref()
                .map(|name| device_name(&device).ok().as_deref() == Some(name))
                .unwrap_or(false);
            if let Some(info) = build_audio_input_device_info(&device, is_default, index) {
                candidates.push((device, info));
            }
        }

        if let Some((device, info)) = resolve_device_preference(&candidates, preference) {
            return Ok((
                device.clone(),
                ResolvedAudioInputDevice {
                    device_id: info.device_id.clone(),
                    device_name: info.device_name.clone(),
                    transport_type: info.transport_type.clone(),
                    is_default: info.is_default,
                    is_bluetooth_like: info.is_bluetooth_like,
                    used_fallback: false,
                    advisory: bluetooth_advisory_for_device(
                        &info.device_name,
                        info.transport_type.as_deref(),
                    ),
                },
            ));
        }

        if let Some(default_device) = self.host.default_input_device() {
            let name = default_device
                .description()
                .map(|description| description.name().to_string())
                .unwrap_or_else(|_| "Default microphone".to_string());
            let transport_type = infer_transport_type(&name);
            let advisory = match preference {
                Some(saved) => Some(format!(
                    "{} is unavailable, so Plainsong fell back to {}.",
                    saved.device_name, name
                )),
                None => bluetooth_advisory_for_device(&name, Some(&transport_type)),
            };
            return Ok((
                default_device,
                ResolvedAudioInputDevice {
                    device_id: default_device_info
                        .as_ref()
                        .map(|value| value.device_id.clone())
                        .unwrap_or_else(|| format!("default-{}", name.to_ascii_lowercase())),
                    device_name: name.clone(),
                    transport_type: Some(transport_type.clone()),
                    is_default: true,
                    is_bluetooth_like: transport_type == "bluetooth",
                    used_fallback: preference.is_some(),
                    advisory,
                },
            ));
        }

        Err(anyhow::anyhow!("No input device available"))
    }

    pub fn resolve_input_device_by_id(
        &self,
        device_id: Option<&str>,
    ) -> Result<(cpal::Device, ResolvedAudioInputDevice)> {
        if let Some(device_id) = device_id {
            let devices = self.list_input_devices()?;
            if let Some(info) = devices
                .iter()
                .find(|candidate| candidate.device_id == device_id)
            {
                let preference = settings::AudioInputDevicePreference {
                    device_id: info.device_id.clone(),
                    device_name: info.device_name.clone(),
                    transport_type: info.transport_type.clone(),
                };
                return self.resolve_input_device(Some(&preference));
            }
        }
        self.resolve_input_device(None)
    }

    /// Start dictation capture.
    ///
    /// `session_id` should be the caller's monotonic dictation session id (the same
    /// one used for `active_session_id` at the lib.rs layer) so the auto-stop VAD
    /// gate can be scoped per-session: it is (re)initialized here, keyed to
    /// `session_id`, and the capture callback only lets it fire an auto-stop event
    /// while `dictation_vad_session_id` still matches — so a gate left over from a
    /// previous, already-stopped session can never signal into a new one.
    ///
    /// `auto_stop` gates and configures "auto-stop after sustained silence"; when
    /// disabled the callback does no extra VAD work. `event_handle`, if provided,
    /// is used to emit a `dictation-vad-signal` event over the existing JSON-RPC
    /// event channel when the gate detects sustained silence after speech.
    ///
    /// `seed_from_pre_roll` must be true ONLY when this start came from the
    /// hands-free monitor's own `hands_free_start` signal. Every other
    /// activation path (hotkey, native helper, the popup's "Start again") means
    /// "begin now", and the caller stops the monitor immediately before calling
    /// in — so the ring is always fresh and the age guard could never reject it.
    /// Draining it unconditionally would splice the seconds *before* the user
    /// pressed the key onto the head of their transcript.
    pub fn start_dictation(
        &mut self,
        preference: Option<&settings::AudioInputDevicePreference>,
        session_id: u64,
        auto_stop: DictationAutoStopConfig,
        event_handle: Option<SidecarHandle>,
        seed_from_pre_roll: bool,
    ) -> Result<ResolvedAudioInputDevice> {
        if self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Dictation already in progress"));
        }

        while self.dictation_buffer.pop().is_some() {}
        if let Ok(mut partial) = self.dictation_partial_buffer.lock() {
            partial.clear();
        }

        let (device, resolved_device) = self.resolve_input_device(preference)?;

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate();
        let channels = config.channels();
        self.dictation_sample_rate = sample_rate;
        self.dictation_channels = channels;

        let pre_roll_samples = self.resolve_dictation_seed_samples(sample_rate, seed_from_pre_roll);
        if !pre_roll_samples.is_empty() {
            tracing::info!(
                "Seeding dictation with {} pre-roll samples ({:.0}ms)",
                pre_roll_samples.len(),
                pre_roll_samples.len() as f32 / sample_rate.max(1) as f32 * 1000.0
            );
            for sample in pre_roll_samples {
                self.dictation_buffer.push(sample);
            }
        }

        tracing::info!(
            "Starting dictation capture on '{}' : {} channels, {} Hz, format: {:?}",
            resolved_device.device_name,
            channels,
            sample_rate,
            config.sample_format()
        );

        // Scope the auto-stop VAD gate to this session *before* the capture callback
        // can observe it: set the session id first, then install (or clear) the
        // gate, so there's no window where a stale gate could be read under the
        // new session id.
        //
        // `dictation_vad_gate_active` is cleared up front so the capture callback's
        // cheap lock-free check can never observe "active" while the gate itself is
        // still being (re)installed under the mutex below; it is only set to `true`
        // once a gate has actually been installed for this session, and it mirrors
        // `auto_stop.enabled` (i.e. it stays `false` for the entire session when
        // auto-stop-on-silence is disabled, which is the default).
        self.dictation_vad_gate_active
            .store(false, Ordering::SeqCst);
        self.dictation_vad_session_id
            .store(session_id, Ordering::SeqCst);
        let gate_installed = auto_stop.enabled && sample_rate > 0;
        {
            let mut gate_slot = match self.dictation_vad_gate.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            *gate_slot = if gate_installed {
                let frame_size = ((sample_rate as f32) * DICTATION_AUTO_STOP_FRAME_MS / 1000.0)
                    .round()
                    .max(1.0) as usize;
                let vad_config = VadConfig {
                    frame_size,
                    sample_rate,
                    threshold_db: None,
                    min_speech_duration: DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS,
                    min_silence_duration: auto_stop.silence_timeout_seconds,
                    padding_seconds: 0.0,
                };
                Some(build_vad_gate(
                    auto_stop.vad_backend,
                    &vad_config,
                    auto_stop.silero_model_path.as_deref(),
                ))
            } else {
                None
            };
        }
        self.dictation_vad_gate_active
            .store(gate_installed, Ordering::SeqCst);

        self.is_dictating.store(true, Ordering::SeqCst);
        self.dictation_callback_count.store(0, Ordering::SeqCst);
        self.dictation_first_sample_us.store(0, Ordering::SeqCst);

        // Per-session stop flag: this session's capture thread and callbacks
        // park/act on this Arc, NOT on the shared `is_dictating`, so a
        // previous session's still-draining thread can never be re-armed by
        // this session setting `is_dictating` back to true.
        let capture_stop = Arc::new(AtomicBool::new(true));
        self.dictation_capture_stop = Some(Arc::clone(&capture_stop));

        let buffer = Arc::clone(&self.dictation_buffer);
        let callback_count = Arc::clone(&self.dictation_callback_count);
        let (startup_tx, startup_rx) = bounded::<Result<(), String>>(1);
        let audio_level = Arc::clone(&self.dictation_audio_level);
        let partial_buffer = Arc::clone(&self.dictation_partial_buffer);
        let streaming_active = Arc::clone(&self.dictation_streaming_active);
        let vad_gate = Arc::clone(&self.dictation_vad_gate);
        let vad_session_id = Arc::clone(&self.dictation_vad_session_id);
        let vad_gate_active = Arc::clone(&self.dictation_vad_gate_active);
        let vad_event_handle = event_handle;
        let first_sample_us = Arc::clone(&self.dictation_first_sample_us);
        let capture_started_at = std::time::Instant::now();

        let capture_handle = std::thread::spawn(move || {
            let capture_flag = Arc::clone(&capture_stop);
            let device = device;
            let config = match device.default_input_config() {
                Ok(config) => config,
                Err(e) => {
                    let _ = startup_tx.send(Err(format!(
                        "Failed to fetch dictation input config: {}",
                        e
                    )));
                    tracing::error!("Failed to fetch dictation input config: {}", e);
                    return;
                }
            };
            let num_channels = config.channels() as usize;
            // Cap the UI-only partial buffer to a sliding window of recent audio
            // so the per-tick clone (taken under a lock the RT callback also holds)
            // and the partial re-decode stay O(window), not O(session length).
            // Trim lazily (only past 2x the window) so the front-drain memmove is
            // amortized to roughly once per window rather than every callback.
            let max_partial_samples = (config.sample_rate() as usize).saturating_mul(30);
            let sample_format = config.sample_format();
            let stream_config = config.config();

            macro_rules! build_dictation_stream {
                ($sample_type:ty) => {{
                    let capture_stop = Arc::clone(&capture_stop);
                    let callback_count = Arc::clone(&callback_count);
                    let buffer = Arc::clone(&buffer);
                    let audio_level = Arc::clone(&audio_level);
                    let partial_buffer = Arc::clone(&partial_buffer);
                    let streaming_active = Arc::clone(&streaming_active);
                    let vad_gate = Arc::clone(&vad_gate);
                    let vad_session_id = Arc::clone(&vad_session_id);
                    let vad_gate_active = Arc::clone(&vad_gate_active);
                    let vad_event_handle = vad_event_handle.clone();
                    let first_sample_us = Arc::clone(&first_sample_us);

                    device.build_input_stream(
                        stream_config.clone(),
                        move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                            if !capture_stop.load(Ordering::SeqCst) {
                                return;
                            }

                            // First sample of this session: record how long the
                            // microphone took to actually deliver audio, so the
                            // cold-open cost is measurable rather than assumed.
                            if first_sample_us.load(Ordering::Relaxed) == 0 {
                                let _ = first_sample_us.compare_exchange(
                                    0,
                                    (capture_started_at.elapsed().as_micros() as u64).max(1),
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                );
                            }

                            callback_count.fetch_add(1, Ordering::Relaxed);
                            let streaming = streaming_active.load(Ordering::Relaxed);
                            let vad_active = vad_gate_active.load(Ordering::Relaxed)
                                && vad_session_id.load(Ordering::SeqCst) == session_id;
                            let need_mono_scratch = streaming || vad_active;
                            let capacity = if num_channels <= 1 {
                                data.len()
                            } else {
                                data.len() / num_channels
                            };
                            let mut mono_scratch = if need_mono_scratch {
                                Vec::with_capacity(capacity)
                            } else {
                                Vec::new()
                            };
                            let mut sum_sq = 0.0_f64;
                            let mut mono_len = 0_usize;

                            for_each_mono_sample(data, num_channels, |sample| {
                                buffer.push(sample);
                                if need_mono_scratch {
                                    mono_scratch.push(sample);
                                }
                                sum_sq += (sample as f64) * (sample as f64);
                                mono_len += 1;
                            });

                            if streaming {
                                if let Ok(mut shared) = partial_buffer.lock() {
                                    shared.extend_from_slice(&mono_scratch);
                                    if shared.len() > max_partial_samples * 2 {
                                        let overflow = shared.len() - max_partial_samples;
                                        shared.drain(0..overflow);
                                    }
                                }
                            }

                            let rms = (sum_sq / mono_len.max(1) as f64).sqrt() as f32;
                            let level = (rms.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
                            audio_level.store(level, Ordering::SeqCst);

                            if vad_active {
                                drive_dictation_auto_stop_gate(
                                    &mono_scratch,
                                    session_id,
                                    &vad_gate,
                                    &vad_session_id,
                                    vad_event_handle.as_ref(),
                                );
                            }
                        },
                        |err| tracing::error!("Dictation stream error: {}", err),
                        None,
                    )
                }};
            }

            let stream_result = match sample_format {
                cpal::SampleFormat::I8 => build_dictation_stream!(i8),
                cpal::SampleFormat::I16 => build_dictation_stream!(i16),
                cpal::SampleFormat::I24 => build_dictation_stream!(cpal::I24),
                cpal::SampleFormat::I32 => build_dictation_stream!(i32),
                cpal::SampleFormat::I64 => build_dictation_stream!(i64),
                cpal::SampleFormat::U8 => build_dictation_stream!(u8),
                cpal::SampleFormat::U16 => build_dictation_stream!(u16),
                cpal::SampleFormat::U24 => build_dictation_stream!(cpal::U24),
                cpal::SampleFormat::U32 => build_dictation_stream!(u32),
                cpal::SampleFormat::U64 => build_dictation_stream!(u64),
                cpal::SampleFormat::F32 => build_dictation_stream!(f32),
                cpal::SampleFormat::F64 => build_dictation_stream!(f64),
                format => {
                    let _ = startup_tx.send(Err(format!(
                        "Unsupported sample format for dictation: {:?}",
                        format
                    )));
                    tracing::error!("Unsupported sample format for dictation: {:?}", format);
                    return;
                }
            };

            let Ok(stream) = stream_result else {
                let _ = startup_tx.send(Err(
                    "Failed to build dictation microphone input stream".to_string()
                ));
                tracing::error!("Failed to build dictation stream");
                return;
            };

            if let Err(e) = stream.play() {
                let _ = startup_tx.send(Err(format!(
                    "Failed to start dictation microphone stream: {}",
                    e
                )));
                tracing::error!("Failed to start dictation stream: {}", e);
                return;
            }

            // Signal that the audio stream is now live
            let _ = startup_tx.send(Ok(()));
            tracing::info!("Dictation audio stream started successfully");

            while capture_flag.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            tracing::info!("Dictation audio stream stopping");
            drop(stream);
        });
        self.dictation_thread = Some(capture_handle);

        // Wait for the audio stream to actually start (up to 500ms)
        match startup_rx.recv_timeout(Duration::from_millis(1500)) {
            Ok(Ok(())) => {
                tracing::info!("Dictation started (stream confirmed live)");
            }
            Ok(Err(error)) => {
                self.is_dictating.store(false, Ordering::SeqCst);
                self.signal_capture_stop();
                if let Some(handle) = self.dictation_thread.take() {
                    let _ = handle.join();
                }
                return Err(anyhow::anyhow!(error));
            }
            Err(_) => {
                self.is_dictating.store(false, Ordering::SeqCst);
                self.signal_capture_stop();
                if let Some(handle) = self.dictation_thread.take() {
                    let _ = handle.join();
                }
                return Err(anyhow::anyhow!(
                    "Timed out waiting for dictation microphone stream to start"
                ));
            }
        }

        Ok(resolved_device)
    }

    /// Tell the current capture session's thread and callbacks to stop, and
    /// drop our handle to its per-session flag (each `start_dictation` mints
    /// a fresh one, so a slow-to-exit old thread can never be re-armed).
    fn signal_capture_stop(&mut self) {
        if let Some(flag) = self.dictation_capture_stop.take() {
            flag.store(false, Ordering::SeqCst);
        }
    }

    /// What a starting session should be seeded with.
    ///
    /// Only a start the hands-free monitor itself triggered (`seed` is
    /// `options.hands_free_trigger`, threaded down from the `hands_free_start`
    /// signal) may inherit the monitor's audio. Every other activation path
    /// means "start now": the seconds before a hotkey press are not part of what
    /// the user asked to dictate, and `take_dictation_pre_roll`'s age guard
    /// cannot catch that on its own because the caller stops the monitor one
    /// statement before starting, leaving the ring fresh by construction. The
    /// ring is dropped rather than left resident when it is not being used.
    fn resolve_dictation_seed_samples(&self, sample_rate: u32, seed: bool) -> Vec<f32> {
        if !seed {
            self.clear_dictation_pre_roll();
            return Vec::new();
        }
        self.take_dictation_pre_roll(sample_rate)
    }

    /// Drain the hands-free monitor's pre-roll if it is usable for a session
    /// opening at `sample_rate`. A ring recorded at a different rate (the input
    /// device changed between the monitor and the session) or captured too long
    /// ago is discarded rather than spliced onto the front of the user's words.
    /// Either way the ring is emptied, so a pre-roll is never handed to two
    /// sessions.
    fn take_dictation_pre_roll(&self, sample_rate: u32) -> Vec<f32> {
        let mut slot = match self.dictation_pre_roll.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(pre_roll) = slot.as_mut() else {
            return Vec::new();
        };

        let usable = pre_roll.sample_rate() == sample_rate
            && pre_roll
                .age_ms()
                .is_some_and(|age| age <= PRE_ROLL_MAX_AGE_MS);
        if !usable && !pre_roll.is_empty() {
            tracing::info!(
                "Discarding {} pre-roll samples ({} Hz, {:?}ms old) for a {} Hz session",
                pre_roll.len(),
                pre_roll.sample_rate(),
                pre_roll.age_ms(),
                sample_rate
            );
        }
        let drained = pre_roll.take();
        if usable {
            drained
        } else {
            Vec::new()
        }
    }

    /// Drop any pre-roll the hands-free monitor accumulated. Called when
    /// hands-free is switched off for good -- as opposed to the monitor being
    /// stopped so a starting session can take over the microphone, where the
    /// pre-roll is exactly what that session needs -- so nothing the monitor
    /// heard outlives the feature the user turned off.
    pub fn clear_dictation_pre_roll(&self) {
        let mut slot = match self.dictation_pre_roll.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *slot = None;
    }

    /// Milliseconds from `start_dictation` entry to the first sample the
    /// capture callback delivered for the most recent session, or `None` when
    /// no sample has arrived yet.
    pub fn dictation_first_sample_latency_ms(&self) -> Option<f64> {
        match self.dictation_first_sample_us.load(Ordering::SeqCst) {
            0 => None,
            micros => Some(micros as f64 / 1000.0),
        }
    }

    /// Clear the auto-stop VAD gate slot so a finished session doesn't retain
    /// its gate (for the Silero backend that keeps a worker thread and its
    /// loaded ort session alive) until the next `start_dictation` replaces it.
    fn clear_dictation_vad_gate(&mut self) {
        self.dictation_vad_gate_active
            .store(false, Ordering::SeqCst);
        let mut gate_slot = match self.dictation_vad_gate.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *gate_slot = None;
    }

    pub fn stop_dictation(&mut self) -> Result<Vec<u8>> {
        if !self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("No dictation in progress"));
        }

        tracing::info!("Stopping dictation capture...");
        std::thread::sleep(Duration::from_millis(DICTATION_STOP_CAPTURE_TAIL_MS));
        self.is_dictating.store(false, Ordering::SeqCst);
        self.signal_capture_stop();
        self.clear_dictation_vad_gate();

        if let Some(handle) = self.dictation_thread.take() {
            let (done_tx, done_rx) = bounded::<()>(1);
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Dictation thread join error: {:?}", e);
                }
                let _ = done_tx.send(());
            });
            if done_rx.recv_timeout(Duration::from_millis(500)).is_err() {
                tracing::warn!(
                    "Timed out waiting for dictation capture thread to join; continuing stop path"
                );
            }
        }

        let mut samples = Vec::new();
        while let Some(sample) = self.dictation_buffer.pop() {
            samples.push(sample);
        }

        // The partial buffer is UI-only and never contributes to `samples`.
        // Stop streaming and release its memory now that capture has ended.
        self.dictation_streaming_active
            .store(false, Ordering::SeqCst);
        if let Ok(mut partial) = self.dictation_partial_buffer.lock() {
            partial.clear();
        }

        tracing::info!(
            "Collected {} samples from dictation buffer (sample rate: {} Hz)",
            samples.len(),
            self.dictation_sample_rate
        );
        if let Some(latency_ms) = self.dictation_first_sample_latency_ms() {
            tracing::info!(
                "Dictation microphone open latency: {:.1}ms from start to first sample",
                latency_ms
            );
        }

        if samples.is_empty() {
            let callback_count = self.dictation_callback_count.load(Ordering::Relaxed);
            tracing::warn!("No audio samples captured during dictation!");
            if callback_count == 0 {
                return Err(anyhow::anyhow!(
                    "No microphone samples were received. Check microphone privacy permissions and the active input device."
                ));
            }
            return Err(anyhow::anyhow!(
                "No audio was captured. Please check microphone permissions."
            ));
        }

        // Log audio statistics for debugging
        let peak = samples.iter().fold(0.0_f32, |p, s| p.max(s.abs()));
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        tracing::info!(
            "Audio stats: peak={}, rms={}, duration={}ms",
            peak,
            rms,
            (samples.len() as f64 / self.dictation_sample_rate as f64 * 1000.0) as i64
        );

        let capture_duration_seconds = if self.dictation_sample_rate == 0 {
            0.0
        } else {
            samples.len() as f32 / self.dictation_sample_rate as f32
        };
        let has_speech_energy = peak >= DICTATION_SHORT_CAPTURE_PEAK_THRESHOLD
            || rms >= DICTATION_SHORT_CAPTURE_RMS_THRESHOLD;
        if capture_duration_seconds < DICTATION_MIN_CAPTURE_SECONDS && !has_speech_energy {
            return Err(anyhow::anyhow!(
                "Dictation capture was too short to transcribe. Hold the hotkey slightly longer and speak before release."
            ));
        }

        // Apply noise suppression before encoding if enabled
        if self.noise_suppression_enabled {
            if let Some(preprocessor) = &mut self.preprocessor {
                preprocessor.auto_calibrate(&samples, self.dictation_sample_rate);
                if let Err(e) = preprocessor.process(&mut samples) {
                    tracing::warn!("Noise suppression failed, using raw audio: {}", e);
                }
            }
        }

        boost_quiet_audio(&mut samples);
        ensure_min_duration(&mut samples, self.dictation_sample_rate, 0.7);

        tracing::info!(
            "Dictation stopped: {} mono samples at {} Hz (after processing)",
            samples.len(),
            self.dictation_sample_rate
        );

        let wav_data = encode_wav(&samples, self.dictation_sample_rate, 1)?;

        tracing::info!("WAV data size: {} bytes", wav_data.len());

        Ok(wav_data)
    }

    pub fn abort_dictation(&mut self) {
        self.is_dictating.store(false, Ordering::SeqCst);
        self.signal_capture_stop();
        self.clear_dictation_vad_gate();
        self.dictation_streaming_active
            .store(false, Ordering::SeqCst);

        if let Some(handle) = self.dictation_thread.take() {
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Dictation thread join error during abort: {:?}", e);
                }
            });
        }

        while self.dictation_buffer.pop().is_some() {}
        if let Ok(mut partial) = self.dictation_partial_buffer.lock() {
            partial.clear();
        }
    }

    /// Get the current audio level for dictation (0.0 to 1.0)
    /// Uses power scaling to make normal speech levels more visible
    pub fn get_dictation_audio_level(&self) -> f32 {
        let level = self.dictation_audio_level.load(Ordering::SeqCst);
        let raw = level as f32 / u32::MAX as f32;
        // Apply power curve: sqrt makes low levels more visible
        // Normal speech RMS ~0.01-0.15, after sqrt: 0.1-0.39
        // Louder speech RMS ~0.1-0.5, after sqrt: 0.32-0.71
        raw.sqrt()
    }

    /// Prepare every enabled writer and capture stream without allowing a
    /// callback to receive a sample. The caller must persist the plan first,
    /// then mark its assets writing before calling [`Self::activate_recording`].
    pub fn start_recording(
        &mut self,
        plan: RecordingCapturePlan,
        options: RecordingOptions,
        event_handle: Option<SidecarHandle>,
    ) -> Result<String> {
        if self.active_recording.is_some() {
            return Err(anyhow::anyhow!("A recording session is already active"));
        }
        if SYSTEM_AUDIO_TEST_ACTIVE.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!(
                "Cannot start a recording while the system-audio test is running"
            ));
        }
        if !options.mic && !options.system_audio {
            return Err(anyhow::anyhow!(
                "Must enable microphone or system audio capture"
            ));
        }
        if plan.mic_path.is_some() != (options.mic && options.system_audio)
            || plan.system_path.is_some() != options.system_audio
        {
            return Err(anyhow::anyhow!(
                "Recording capture plan does not match enabled audio sources"
            ));
        }

        let id = plan.recording_id.clone();
        let audio_path = plan.primary_path.clone();
        let mic_audio_path = plan.mic_path.clone();
        let system_audio_path = plan.system_path.clone();
        let waveform_buffer = Arc::new(std::sync::Mutex::new(Vec::with_capacity(4410)));
        let streaming_queue: Arc<crossbeam::queue::ArrayQueue<Vec<f32>>> =
            Arc::new(crossbeam::queue::ArrayQueue::new(256));
        let preferred_mic_device = if options.mic {
            Some(
                self.resolve_input_device_by_id(options.preferred_input_device_id.as_deref())?
                    .0,
            )
        } else {
            None
        };

        tracing::info!(
            "Preparing recording {} (mic: {}, system: {})",
            id,
            options.mic,
            options.system_audio
        );

        if options.system_audio {
            let mut mixed_capture = MixedAudioCapture::new();
            let capture_start = mixed_capture
                .start(
                    options.mic,
                    options.system_audio,
                    preferred_mic_device,
                    Arc::clone(&waveform_buffer),
                    Some(Arc::clone(&streaming_queue)),
                    event_handle.map(|handle| MixedCaptureEvents {
                        handle,
                        recording_id: id.clone(),
                    }),
                )
                .context("Failed to prepare mixed audio capture")?;
            let sample_rate = capture_start.sample_rate;
            let writer_receiver = capture_start.aligned_receiver.clone();
            let prepared_writers = match prepare_aligned_wav_writers(
                &audio_path,
                mic_audio_path.as_deref(),
                system_audio_path.as_deref(),
                sample_rate,
            ) {
                Ok(writers) => writers,
                Err(error) => {
                    mixed_capture.stop();
                    return Err(error);
                }
            };
            let writer_log_path = audio_path.clone();
            let writer_handle = std::thread::spawn(move || {
                write_aligned_wav_files(prepared_writers, writer_receiver, &writer_log_path)
            });

            self.active_recording = Some(ActiveRecordingSession {
                id: id.clone(),
                audio_path,
                mic_audio_path,
                system_audio_path,
                writer_handles: vec![writer_handle],
                activation: Some(RecordingActivation::Mixed(capture_start)),
                capture_stop_flag: Arc::new(AtomicBool::new(false)),
                capture_handle: None,
                mixed_capture: Some(mixed_capture),
                waveform_buffer,
                streaming_queue,
                sample_rate,
                dropped_stream_chunks: Arc::new(AtomicU64::new(0)),
                dropped_writer_chunks: Arc::new(AtomicU64::new(0)),
            });
        } else {
            let device = preferred_mic_device
                .or_else(|| cpal::default_host().default_input_device())
                .context("No microphone input device available")?;
            let config = device
                .default_input_config()
                .context("Failed to read microphone input configuration")?;
            let sample_rate = config.sample_rate();
            let num_channels = config.channels() as usize;
            let sample_format = config.sample_format();
            let stream_config = config.config();

            let prepared_writer = prepare_mono_wav_writer(&audio_path, sample_rate)?;
            let (samples_sender, samples_receiver) = bounded::<Vec<f32>>(256);
            let writer_log_path = audio_path.clone();
            let writer_handle = std::thread::spawn(move || {
                write_wav_file(prepared_writer, samples_receiver, &writer_log_path)
            });

            let capture_stop_flag = Arc::new(AtomicBool::new(true));
            let capture_flag = Arc::clone(&capture_stop_flag);
            let dropped_stream_chunks = Arc::new(AtomicU64::new(0));
            let dropped_writer_chunks = Arc::new(AtomicU64::new(0));
            let dropped_stream_chunks_for_session = Arc::clone(&dropped_stream_chunks);
            let dropped_writer_chunks_for_session = Arc::clone(&dropped_writer_chunks);
            let wf_buffer = Arc::clone(&waveform_buffer);
            let stream_queue_clone = Arc::clone(&streaming_queue);
            let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);
            let (activation_tx, activation_rx) = bounded::<()>(1);
            let (activated_tx, activated_rx) = bounded::<Result<(), String>>(1);

            let capture_handle = std::thread::spawn(move || {
                macro_rules! build_recording_stream {
                    ($sample_type:ty) => {{
                        let stream_queue = Arc::clone(&stream_queue_clone);
                        let waveform_buffer = Arc::clone(&wf_buffer);
                        let samples_sender = samples_sender.clone();
                        let dropped_stream_chunks = Arc::clone(&dropped_stream_chunks);
                        let dropped_writer_chunks = Arc::clone(&dropped_writer_chunks);

                        device.build_input_stream(
                            stream_config.clone(),
                            move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                let chunk = downmix_to_mono(data, num_channels);

                                if let Ok(mut waveform) = waveform_buffer.lock() {
                                    for &sample in
                                        chunk.iter().step_by(chunk.len() / 100 + 1).take(100)
                                    {
                                        waveform.push(sample);
                                    }
                                    if waveform.len() > 4410 {
                                        let drop_count = waveform.len() - 4410;
                                        waveform.drain(0..drop_count);
                                    }
                                }

                                if stream_queue.push(chunk.clone()).is_err() {
                                    let _ = stream_queue.pop();
                                    let _ = stream_queue.push(chunk.clone());
                                    dropped_stream_chunks.fetch_add(1, Ordering::Relaxed);
                                }

                                match samples_sender.try_send(chunk) {
                                    Ok(()) => {}
                                    Err(TrySendError::Full(_)) => {
                                        dropped_writer_chunks.fetch_add(1, Ordering::Relaxed);
                                    }
                                    Err(TrySendError::Disconnected(_)) => {}
                                }
                            },
                            |error| tracing::error!("Stream error: {}", error),
                            None,
                        )
                    }};
                }

                let stream_result = match sample_format {
                    cpal::SampleFormat::I8 => build_recording_stream!(i8),
                    cpal::SampleFormat::I16 => build_recording_stream!(i16),
                    cpal::SampleFormat::I24 => build_recording_stream!(cpal::I24),
                    cpal::SampleFormat::I32 => build_recording_stream!(i32),
                    cpal::SampleFormat::I64 => build_recording_stream!(i64),
                    cpal::SampleFormat::U8 => build_recording_stream!(u8),
                    cpal::SampleFormat::U16 => build_recording_stream!(u16),
                    cpal::SampleFormat::U24 => build_recording_stream!(cpal::U24),
                    cpal::SampleFormat::U32 => build_recording_stream!(u32),
                    cpal::SampleFormat::U64 => build_recording_stream!(u64),
                    cpal::SampleFormat::F32 => build_recording_stream!(f32),
                    cpal::SampleFormat::F64 => build_recording_stream!(f64),
                    _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
                };
                let Ok(stream) = stream_result else {
                    let _ =
                        ready_tx.send(Err("Failed to build microphone input stream".to_string()));
                    return;
                };
                let _ = ready_tx.send(Ok(()));

                if activation_rx.recv_timeout(Duration::from_secs(5)).is_err() {
                    let _ = activated_tx.send(Err(
                        "Timed out waiting for durable microphone writer".to_string(),
                    ));
                    return;
                }
                if let Err(error) = stream.play() {
                    let _ = activated_tx
                        .send(Err(format!("Failed to start microphone stream: {error}")));
                    return;
                }
                let _ = activated_tx.send(Ok(()));

                while capture_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                }

                let dropped_stream = dropped_stream_chunks.load(Ordering::Relaxed);
                let dropped_writer = dropped_writer_chunks.load(Ordering::Relaxed);
                if dropped_stream > 0 || dropped_writer > 0 {
                    tracing::warn!(
                        "Microphone capture dropped stream/writer chunks (stream={}, writer={})",
                        dropped_stream,
                        dropped_writer
                    );
                }
                drop(stream);
            });

            match ready_rx.recv_timeout(Duration::from_millis(1500)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    capture_stop_flag.store(false, Ordering::SeqCst);
                    let _ = capture_handle.join();
                    let _ = join_writer_with_timeout(
                        writer_handle,
                        Duration::from_secs(5),
                        "wav writer thread",
                    );
                    return Err(anyhow::anyhow!(error));
                }
                Err(_) => {
                    capture_stop_flag.store(false, Ordering::SeqCst);
                    let _ = capture_handle.join();
                    let _ = join_writer_with_timeout(
                        writer_handle,
                        Duration::from_secs(5),
                        "wav writer thread",
                    );
                    return Err(anyhow::anyhow!(
                        "Timed out waiting for microphone stream preparation"
                    ));
                }
            }

            self.active_recording = Some(ActiveRecordingSession {
                id: id.clone(),
                audio_path,
                mic_audio_path: None,
                system_audio_path: None,
                writer_handles: vec![writer_handle],
                activation: Some(RecordingActivation::Microphone {
                    activation_tx,
                    activated_rx,
                }),
                capture_stop_flag,
                capture_handle: Some(capture_handle),
                mixed_capture: None,
                waveform_buffer,
                streaming_queue,
                sample_rate,
                dropped_stream_chunks: dropped_stream_chunks_for_session,
                dropped_writer_chunks: dropped_writer_chunks_for_session,
            });
        }

        tracing::info!("Recording prepared: {}", id);
        Ok(id)
    }

    pub fn activate_recording(&mut self, recording_id: &str) -> Result<()> {
        let activation = {
            let session = self
                .active_recording
                .as_mut()
                .context("No prepared recording session")?;
            if session.id != recording_id {
                anyhow::bail!(
                    "Recording ID mismatch: active={}, requested={}",
                    session.id,
                    recording_id
                );
            }
            session
                .activation
                .take()
                .context("Recording session is already active")?
        };

        let result = match activation {
            RecordingActivation::Microphone {
                activation_tx,
                activated_rx,
            } => {
                activation_tx
                    .send(())
                    .map_err(|_| anyhow::anyhow!("Microphone capture stopped before activation"))?;
                match activated_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(anyhow::anyhow!(error)),
                    Err(_) => Err(anyhow::anyhow!(
                        "Timed out waiting for microphone capture to activate"
                    )),
                }
            }
            RecordingActivation::Mixed(capture_start) => capture_start.activate(),
        };

        if let Err(error) = result {
            self.abort_prepared_recording();
            return Err(error);
        }

        tracing::info!("Recording activated: {}", recording_id);
        Ok(())
    }

    pub(crate) fn abort_prepared_recording(&mut self) {
        let Some(mut session) = self.active_recording.take() else {
            return;
        };
        session.capture_stop_flag.store(false, Ordering::SeqCst);
        drop(session.activation.take());
        if let Some(mut mixed_capture) = session.mixed_capture.take() {
            mixed_capture.stop();
        }
        if let Some(handle) = session.capture_handle.take() {
            let _ = handle.join();
        }
        for handle in session.writer_handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn stop_recording(&mut self, recording_id: &str) -> Result<RecordingStopResult> {
        tracing::info!("Stopping recording: {}", recording_id);
        if self
            .active_recording
            .as_ref()
            .is_some_and(|session| session.activation.is_some())
        {
            anyhow::bail!("Recording session has not been activated");
        }

        let mut session = self
            .active_recording
            .take()
            .ok_or_else(|| anyhow::anyhow!("No active recording session"))?;

        if session.id != recording_id {
            self.active_recording = Some(session);
            return Err(anyhow::anyhow!(
                "Recording ID mismatch: active={}, requested={}",
                self.active_recording
                    .as_ref()
                    .map(|s| s.id.as_str())
                    .unwrap_or("unknown"),
                recording_id
            ));
        }

        session.capture_stop_flag.store(false, Ordering::SeqCst);

        if let Some(handle) = session.capture_handle.take() {
            join_thread_with_timeout(handle, Duration::from_secs(5), "capture thread")?;
        }
        let mut dropped_mic_samples = 0_u64;
        let mut dropped_system_samples = 0_u64;
        let mut dropped_mixed_chunks = 0_u64;
        if let Some(mut mixed_capture) = session.mixed_capture.take() {
            mixed_capture.stop();
            let (mic_samples, system_samples, mixed_chunks) = mixed_capture.drop_counts();
            dropped_mic_samples = mic_samples;
            dropped_system_samples = system_samples;
            dropped_mixed_chunks = mixed_chunks;
        }

        for handle in session.writer_handles.drain(..) {
            join_writer_with_timeout(handle, Duration::from_secs(20), "wav writer thread")?;
        }

        let dropped_stream_chunks = session.dropped_stream_chunks.load(Ordering::Relaxed);
        let dropped_writer_chunks = session.dropped_writer_chunks.load(Ordering::Relaxed);
        if dropped_stream_chunks > 0
            || dropped_writer_chunks > 0
            || dropped_mic_samples > 0
            || dropped_system_samples > 0
            || dropped_mixed_chunks > 0
        {
            tracing::warn!(
                "Recording '{}' experienced dropped audio data (stream_chunks={}, writer_chunks={}, mic_samples={}, system_samples={}, mixed_chunks={})",
                recording_id,
                dropped_stream_chunks,
                dropped_writer_chunks,
                dropped_mic_samples,
                dropped_system_samples,
                dropped_mixed_chunks
            );
        }

        let path = session.audio_path;
        let mic_audio_path = session.mic_audio_path;
        let system_audio_path = session.system_audio_path;
        tracing::info!("Recording saved to: {:?}", path);

        let mut validated_assets = Vec::new();
        for (role, asset_path) in [
            Some((RecordingAudioRole::Primary, path.as_path())),
            mic_audio_path
                .as_deref()
                .map(|path| (RecordingAudioRole::Mic, path)),
            system_audio_path
                .as_deref()
                .map(|path| (RecordingAudioRole::System, path)),
        ]
        .into_iter()
        .flatten()
        {
            sync_file(asset_path)?;
            match validate_plaintext_wav(asset_path) {
                RecordingAudioValidation::Ready(metadata) => {
                    validated_assets.push((role, metadata));
                }
                RecordingAudioValidation::Missing(error)
                | RecordingAudioValidation::Failed(error) => {
                    anyhow::bail!(
                        "Failed to validate '{}' recording audio '{}': {}",
                        role.as_str(),
                        asset_path.display(),
                        error
                    );
                }
            }
        }
        sync_parent_directory(&path)?;
        let hash = validated_assets
            .iter()
            .find(|(role, _)| *role == RecordingAudioRole::Primary)
            .map(|(_, metadata)| metadata.plaintext_sha256.clone())
            .context("Validated recording has no primary audio metadata")?;
        tracing::info!("Recording SHA256: {}", hash);

        Ok(RecordingStopResult {
            audio_path: path.to_string_lossy().to_string(),
            mic_audio_path: mic_audio_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            system_audio_path: system_audio_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            validated_assets,
            content_hash: hash,
            dropped_stream_chunks,
            dropped_writer_chunks,
            dropped_mic_samples,
            dropped_system_samples,
            dropped_mixed_chunks,
        })
    }

    /// Returns the streaming sample queue and sample rate for the active recording.
    /// The caller should drain this queue periodically and feed samples to StreamingTranscriber.
    pub fn get_streaming_queue(
        &self,
        recording_id: &str,
    ) -> Option<(Arc<crossbeam::queue::ArrayQueue<Vec<f32>>>, u32)> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        Some((Arc::clone(&session.streaming_queue), session.sample_rate))
    }

    pub fn get_waveform_data(&self, recording_id: &str) -> Option<Vec<f32>> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        session
            .waveform_buffer
            .lock()
            .ok()
            .map(|buffer| buffer.clone())
    }

    pub fn is_dictating(&self) -> bool {
        self.is_dictating.load(Ordering::SeqCst)
    }

    /// Enable or disable UI-only streaming partial accumulation for the next/active
    /// dictation. When off, capture callbacks do no extra work (no allocation, no lock).
    pub fn set_streaming_partials_enabled(&self, on: bool) {
        self.dictation_streaming_active.store(on, Ordering::SeqCst);
    }

    /// Clone of the UI-only partial sample buffer Arc, for the partial-decode task.
    pub fn dictation_partial_buffer_handle(&self) -> Arc<std::sync::Mutex<Vec<f32>>> {
        Arc::clone(&self.dictation_partial_buffer)
    }

    /// Clone of the `is_dictating` Arc, so the partial-decode task can observe stop.
    pub fn is_dictating_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.is_dictating)
    }

    /// Sample rate of the active dictation capture.
    pub fn dictation_sample_rate(&self) -> u32 {
        self.dictation_sample_rate
    }

    pub fn is_recording(&self) -> bool {
        self.active_recording.is_some()
    }

    pub(crate) fn begin_system_audio_test(&self) -> Result<SystemAudioTestGuard> {
        claim_system_audio_test(self.active_recording.is_some())
    }

    pub fn has_microphone_input(&self) -> bool {
        self.host.default_input_device().is_some()
    }

    /// Whether the hands-free idle-time monitor stream is currently running.
    pub fn is_hands_free_monitor_active(&self) -> bool {
        self.hands_free_monitor_active.load(Ordering::SeqCst)
    }

    /// Start the hands-free *idle-time* monitor: a separate, minimal always-on-when-enabled
    /// capture stream that listens for sustained speech while no dictation session is active,
    /// so the user can start dictating without touching a hotkey at all.
    ///
    /// This is deliberately NOT the same machinery as `start_dictation`'s auto-stop
    /// gate (see `drive_dictation_auto_stop_gate`): that gate only runs once a
    /// dictation session's own capture stream is already open, whereas this monitor is the
    /// thing that runs *instead*, while idle, purely to decide when to call the existing
    /// start-dictation path. It never appends to `dictation_buffer` (it fills a
    /// bounded pre-roll ring that `start_dictation` drains instead), never touches
    /// `is_dictating`/`dictation_thread`, and never itself calls into `start_dictation` — it
    /// only emits a `dictation-vad-signal` event (`signal: "hands_free_start"`) for the caller
    /// (electron/main.ts) to route through the exact same `start_dictation` command every
    /// other activation path (hotkey, native helper) already uses, so it passes through the
    /// same `DictationSessionState::Idle` guard and can't double-start a session.
    ///
    /// `vad_backend`/`silero_model_path` select which [`VadGate`] implementation drives
    /// speech detection here, via `crate::audio::silero_vad::build_vad_gate` -- the same
    /// backend-selection knob `start_dictation`'s auto-stop gate uses, so hands-free
    /// auto-start and auto-stop-on-silence always agree on which detector is active.
    ///
    /// Callers MUST NOT invoke this unless `dictation_hands_free_enabled` is on; the whole
    /// point is that the mic is never opened for this purpose when the setting is off, so
    /// idle CPU/battery behavior for users who don't enable hands-free is unaffected.
    ///
    /// No-op (returns `Ok(())`) if the monitor is already running or a dictation session is
    /// currently active (the monitor and a live dictation capture must never run at once).
    pub fn start_hands_free_monitor(
        &mut self,
        preference: Option<&settings::AudioInputDevicePreference>,
        event_handle: SidecarHandle,
        vad_backend: VadBackendKind,
        silero_model_path: Option<PathBuf>,
    ) -> Result<()> {
        if self.hands_free_monitor_active.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self.is_dictating.load(Ordering::SeqCst) {
            // A real dictation session owns listening duties right now; the monitor
            // stays off until it's stopped and idle again (see `stop_dictation`'s
            // caller in lib.rs, which restarts the monitor once the session ends).
            return Ok(());
        }

        // Recorded on successful start so `reconcile_hands_free_monitor` can
        // detect settings changing under a running monitor and restart it.
        let monitor_config = HandsFreeMonitorConfig {
            vad_backend,
            silero_model_path: silero_model_path.clone(),
            device_id: preference.map(|p| p.device_id.clone()),
            device_name: preference.map(|p| p.device_name.clone()),
        };

        let (device, _resolved_device) = self.resolve_input_device(preference)?;
        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate();
        let num_channels = config.channels() as usize;

        if sample_rate == 0 {
            return Err(anyhow::anyhow!(
                "Hands-free monitor: input device reported an invalid sample rate"
            ));
        }

        let frame_size = ((sample_rate as f32) * DICTATION_AUTO_STOP_FRAME_MS / 1000.0)
            .round()
            .max(1.0) as usize;

        // A fresh pre-roll ring per monitor run, sized for this stream's sample
        // rate. `start_dictation` drains it, so the words spoken while the gate
        // was still deciding "that's speech" survive the hand-off instead of
        // being downmixed and dropped.
        {
            let mut slot = match self.dictation_pre_roll.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            *slot = Some(PreRollBuffer::new(sample_rate, PRE_ROLL_SECONDS));
        }
        let pre_roll = Arc::clone(&self.dictation_pre_roll);

        // How far back the gate's `SpeechStarted` edge actually sits: it only
        // latches after `DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS` of sustained
        // speech, so the ring is trimmed to that much audio plus a lead-in
        // rather than handing over the whole two-second window.
        let speech_onset_lookback = ((sample_rate as f32)
            * (DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS + PRE_ROLL_SPEECH_LEAD_SECONDS))
            .round()
            .max(0.0) as usize;

        self.hands_free_monitor_active.store(true, Ordering::SeqCst);
        let monitor_active = Arc::clone(&self.hands_free_monitor_active);
        let (startup_tx, startup_rx) = bounded::<Result<(), String>>(1);

        let capture_handle = std::thread::spawn(move || {
            let device = device;
            let config = match device.default_input_config() {
                Ok(config) => config,
                Err(e) => {
                    let _ = startup_tx.send(Err(format!(
                        "Failed to fetch hands-free monitor input config: {}",
                        e
                    )));
                    return;
                }
            };

            // Minimal per-frame work: no partial-transcript accumulation and no
            // allocation beyond the VAD gate and a fixed-size pre-roll ring (a
            // couple of seconds of mono samples, written in place). This must
            // stay cheap since (when hands-free is enabled) it can run indefinitely
            // while the app is idle.
            //
            // Backend-agnostic: `build_vad_gate` returns either the energy-threshold
            // heuristic or the Silero-backed detector (with automatic fallback to
            // energy-threshold if Silero isn't available), and this code never
            // branches on which one it got back.
            let vad_config = VadConfig {
                frame_size,
                sample_rate,
                threshold_db: None,
                min_speech_duration: DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS,
                min_silence_duration: 0.3,
                padding_seconds: 0.0,
            };
            let gate: Arc<std::sync::Mutex<Box<dyn VadGate + Send>>> =
                Arc::new(std::sync::Mutex::new(build_vad_gate(
                    vad_backend,
                    &vad_config,
                    silero_model_path.as_deref(),
                )));

            /// Returns the edge the gate reported so the caller can mark the
            /// pre-roll's speech onset; `NoChange` whenever the gate was not
            /// consulted at all.
            fn handle_frame(
                mono: &[f32],
                gate: &std::sync::Mutex<Box<dyn VadGate + Send>>,
                running: &AtomicBool,
                handle: &SidecarHandle,
            ) -> VadEdge {
                if !running.load(Ordering::SeqCst) {
                    return VadEdge::NoChange;
                }
                let Ok(mut gate) = gate.lock() else {
                    return VadEdge::NoChange;
                };
                let edge = gate.push_samples(mono);
                if edge == VadEdge::SpeechStarted {
                    handle.emit(
                        "dictation-vad-signal",
                        serde_json::json!({ "signal": "hands_free_start" }),
                    );
                }
                edge
            }

            let sample_format = config.sample_format();
            let stream_config = config.config();

            macro_rules! build_hands_free_stream {
                ($sample_type:ty) => {{
                    let running = Arc::clone(&monitor_active);
                    let gate = Arc::clone(&gate);
                    let handle = event_handle.clone();
                    let err_active = Arc::clone(&monitor_active);
                    let pre_roll = Arc::clone(&pre_roll);

                    device.build_input_stream(
                        stream_config.clone(),
                        move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                            if !running.load(Ordering::SeqCst) {
                                return;
                            }
                            let mono = downmix_to_mono(data, num_channels);
                            // The frame is already downmixed for the gate; keep
                            // it in the ring instead of dropping it, so the
                            // session this monitor is about to trigger starts
                            // with the user's opening words.
                            if let Ok(mut slot) = pre_roll.lock() {
                                if let Some(buffer) = slot.as_mut() {
                                    buffer.push(&mono);
                                }
                            }
                            // Mark where speech actually began (the gate latches
                            // well after the fact) so the hand-off is the user's
                            // opening words, not the whole ring.
                            if handle_frame(&mono, &gate, &running, &handle)
                                == VadEdge::SpeechStarted
                            {
                                if let Ok(mut slot) = pre_roll.lock() {
                                    if let Some(buffer) = slot.as_mut() {
                                        buffer.mark_speech_onset(speech_onset_lookback);
                                    }
                                }
                            }
                        },
                        move |err| {
                            tracing::error!("Hands-free monitor stream error: {}", err);
                            err_active.store(false, Ordering::SeqCst);
                        },
                        None,
                    )
                }};
            }

            let stream_result = match sample_format {
                cpal::SampleFormat::I8 => build_hands_free_stream!(i8),
                cpal::SampleFormat::I16 => build_hands_free_stream!(i16),
                cpal::SampleFormat::I24 => build_hands_free_stream!(cpal::I24),
                cpal::SampleFormat::I32 => build_hands_free_stream!(i32),
                cpal::SampleFormat::I64 => build_hands_free_stream!(i64),
                cpal::SampleFormat::U8 => build_hands_free_stream!(u8),
                cpal::SampleFormat::U16 => build_hands_free_stream!(u16),
                cpal::SampleFormat::U24 => build_hands_free_stream!(cpal::U24),
                cpal::SampleFormat::U32 => build_hands_free_stream!(u32),
                cpal::SampleFormat::U64 => build_hands_free_stream!(u64),
                cpal::SampleFormat::F32 => build_hands_free_stream!(f32),
                cpal::SampleFormat::F64 => build_hands_free_stream!(f64),
                format => {
                    let _ = startup_tx.send(Err(format!(
                        "Unsupported sample format for hands-free monitor: {:?}",
                        format
                    )));
                    return;
                }
            };

            let Ok(stream) = stream_result else {
                let _ = startup_tx.send(Err(
                    "Failed to build hands-free monitor input stream".to_string()
                ));
                return;
            };

            if let Err(e) = stream.play() {
                let _ = startup_tx.send(Err(format!(
                    "Failed to start hands-free monitor stream: {}",
                    e
                )));
                return;
            }

            let _ = startup_tx.send(Ok(()));
            tracing::info!("Hands-free idle monitor stream started");

            while monitor_active.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }

            tracing::info!("Hands-free idle monitor stream stopping");
            drop(stream);
        });

        self.hands_free_monitor_thread = Some(capture_handle);

        match startup_rx.recv_timeout(Duration::from_millis(1500)) {
            Ok(Ok(())) => {
                self.hands_free_monitor_config = Some(monitor_config);
                Ok(())
            }
            Ok(Err(error)) => {
                self.hands_free_monitor_active
                    .store(false, Ordering::SeqCst);
                if let Some(handle) = self.hands_free_monitor_thread.take() {
                    let _ = handle.join();
                }
                Err(anyhow::anyhow!(error))
            }
            Err(_) => {
                self.hands_free_monitor_active
                    .store(false, Ordering::SeqCst);
                if let Some(handle) = self.hands_free_monitor_thread.take() {
                    let _ = handle.join();
                }
                Err(anyhow::anyhow!(
                    "Timed out waiting for hands-free monitor stream to start"
                ))
            }
        }
    }

    /// Stop the hands-free idle-time monitor stream, if running. Safe to call even if it
    /// isn't running (no-op). Always call this before opening the real dictation capture
    /// stream, and again once a dictation session ends (to resume idle listening).
    pub fn stop_hands_free_monitor(&mut self) {
        self.hands_free_monitor_config = None;
        if !self.hands_free_monitor_active.load(Ordering::SeqCst) {
            return;
        }
        self.hands_free_monitor_active
            .store(false, Ordering::SeqCst);
        if let Some(handle) = self.hands_free_monitor_thread.take() {
            let _ = handle.join();
        }
    }

    /// Configuration the currently running hands-free monitor was started
    /// with, for `reconcile_hands_free_monitor` to compare against the
    /// currently desired configuration. `None` when the monitor isn't running.
    pub fn hands_free_monitor_config(&self) -> Option<&HandsFreeMonitorConfig> {
        self.hands_free_monitor_config.as_ref()
    }
}

fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();

    let num_samples = samples.len();
    let byte_rate = sample_rate * channels as u32 * 2;
    let data_size = num_samples * 2;

    // RIFF header
    buffer.extend_from_slice(b"RIFF");
    buffer.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    buffer.extend_from_slice(b"WAVE");

    // fmt chunk
    buffer.extend_from_slice(b"fmt ");
    buffer.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size
    buffer.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat (PCM)
    buffer.extend_from_slice(&channels.to_le_bytes());
    buffer.extend_from_slice(&sample_rate.to_le_bytes());
    buffer.extend_from_slice(&byte_rate.to_le_bytes());
    buffer.extend_from_slice(&(channels * 2).to_le_bytes()); // BlockAlign
    buffer.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample

    // data chunk
    buffer.extend_from_slice(b"data");
    buffer.extend_from_slice(&(data_size as u32).to_le_bytes());

    // Convert f32 samples to i16
    for sample in samples {
        let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        buffer.extend_from_slice(&int_sample.to_le_bytes());
    }

    Ok(buffer)
}

type MeetingWavWriter = hound::WavWriter<std::io::BufWriter<std::fs::File>>;

struct PreparedAlignedWavWriters {
    mixed: MeetingWavWriter,
    mic: Option<MeetingWavWriter>,
    system: Option<MeetingWavWriter>,
}

fn new_mono_wav_writer(path: &Path, sample_rate: u32) -> Result<MeetingWavWriter> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file = create_new_file(path)?;
    Ok(hound::WavWriter::new(std::io::BufWriter::new(file), spec)?)
}

fn prepare_mono_wav_writer(path: &Path, sample_rate: u32) -> Result<MeetingWavWriter> {
    let mut writer = new_mono_wav_writer(path, sample_rate)?;
    writer.flush()?;
    sync_file(path)?;
    sync_parent_directory(path)?;
    Ok(writer)
}

fn prepare_aligned_wav_writers(
    mixed_path: &Path,
    mic_path: Option<&Path>,
    system_path: Option<&Path>,
    sample_rate: u32,
) -> Result<PreparedAlignedWavWriters> {
    let mut mixed = new_mono_wav_writer(mixed_path, sample_rate)?;
    let mut mic = mic_path
        .map(|path| new_mono_wav_writer(path, sample_rate))
        .transpose()?;
    let mut system = system_path
        .map(|path| new_mono_wav_writer(path, sample_rate))
        .transpose()?;

    mixed.flush()?;
    if let Some(writer) = mic.as_mut() {
        writer.flush()?;
    }
    if let Some(writer) = system.as_mut() {
        writer.flush()?;
    }
    sync_file(mixed_path)?;
    if let Some(path) = mic_path {
        sync_file(path)?;
    }
    if let Some(path) = system_path {
        sync_file(path)?;
    }
    sync_parent_directory(mixed_path)?;

    Ok(PreparedAlignedWavWriters { mixed, mic, system })
}

fn write_wav_samples(writer: &mut MeetingWavWriter, mut samples: Vec<f32>) -> Result<()> {
    boost_quiet_audio(&mut samples);
    for sample in samples {
        writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)?;
    }
    Ok(())
}

fn checkpoint_aligned_writers(writers: &mut PreparedAlignedWavWriters) -> Result<()> {
    writers.mixed.flush()?;
    if let Some(writer) = writers.mic.as_mut() {
        writer.flush()?;
    }
    if let Some(writer) = writers.system.as_mut() {
        writer.flush()?;
    }
    Ok(())
}

fn write_aligned_wav_files(
    mut writers: PreparedAlignedWavWriters,
    receiver: Receiver<MixedAudioChunk>,
    log_path: &Path,
) -> Result<()> {
    let mut last_checkpoint = Instant::now();
    while let Ok(chunk) = receiver.recv() {
        let frames = chunk.mixed.len();
        if chunk
            .mic
            .as_ref()
            .is_some_and(|samples| samples.len() != frames)
            || chunk
                .system
                .as_ref()
                .is_some_and(|samples| samples.len() != frames)
            || writers.mic.is_some() != chunk.mic.is_some()
            || writers.system.is_some() != chunk.system.is_some()
        {
            return Err(anyhow::anyhow!(
                "Aligned meeting audio chunk had mismatched track lengths"
            ));
        }

        write_wav_samples(&mut writers.mixed, chunk.mixed)?;
        if let (Some(writer), Some(samples)) = (writers.mic.as_mut(), chunk.mic) {
            write_wav_samples(writer, samples)?;
        }
        if let (Some(writer), Some(samples)) = (writers.system.as_mut(), chunk.system) {
            write_wav_samples(writer, samples)?;
        }
        if last_checkpoint.elapsed() >= Duration::from_secs(5) {
            checkpoint_aligned_writers(&mut writers)?;
            last_checkpoint = Instant::now();
        }
    }

    writers.mixed.finalize()?;
    if let Some(writer) = writers.mic {
        writer.finalize()?;
    }
    if let Some(writer) = writers.system {
        writer.finalize()?;
    }
    tracing::info!("Aligned meeting WAV files written: {:?}", log_path);
    Ok(())
}

fn write_wav_file(
    mut writer: MeetingWavWriter,
    receiver: Receiver<Vec<f32>>,
    log_path: &Path,
) -> Result<()> {
    let mut last_checkpoint = Instant::now();
    while let Ok(samples) = receiver.recv() {
        write_wav_samples(&mut writer, samples)?;
        if last_checkpoint.elapsed() >= Duration::from_secs(5) {
            writer.flush()?;
            last_checkpoint = Instant::now();
        }
    }

    writer.finalize()?;
    tracing::info!("WAV file written: {:?}", log_path);
    Ok(())
}

fn join_thread_with_timeout(handle: JoinHandle<()>, timeout: Duration, label: &str) -> Result<()> {
    let (done_tx, done_rx) = bounded::<std::thread::Result<()>>(1);
    std::thread::spawn(move || {
        let _ = done_tx.send(handle.join());
    });

    match done_rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(anyhow::anyhow!("{} panicked", label)),
        Err(_) => Err(anyhow::anyhow!("Timed out waiting for {}", label)),
    }
}

fn join_writer_with_timeout(
    handle: JoinHandle<Result<()>>,
    timeout: Duration,
    label: &str,
) -> Result<()> {
    let (done_tx, done_rx) = bounded::<std::thread::Result<Result<()>>>(1);
    std::thread::spawn(move || {
        let _ = done_tx.send(handle.join());
    });

    match done_rx.recv_timeout(timeout) {
        Ok(Ok(result)) => result.with_context(|| format!("{} failed", label)),
        Ok(Err(_)) => Err(anyhow::anyhow!("{} panicked", label)),
        Err(_) => Err(anyhow::anyhow!("Timed out waiting for {}", label)),
    }
}

fn boost_quiet_audio(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }

    let peak = samples.iter().fold(0.0_f32, |current_peak, sample| {
        current_peak.max(sample.abs())
    });

    if peak <= 0.0 || peak >= 0.30 {
        return;
    }

    let gain = (0.45 / peak).clamp(1.0, 2.8);
    for sample in samples.iter_mut() {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
}

fn ensure_min_duration(samples: &mut Vec<f32>, sample_rate: u32, min_seconds: f32) {
    if sample_rate == 0 || min_seconds <= 0.0 {
        return;
    }

    let min_samples = (sample_rate as f32 * min_seconds).ceil() as usize;
    if samples.len() >= min_samples {
        return;
    }

    samples.resize(min_samples, 0.0);
}

#[cfg(test)]
mod sample_conversion_tests {
    use super::{downmix_to_mono, to_f32_sample};

    fn assert_approx_eq(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() <= 1.0e-6,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn normalizes_coreaudio_integer_pcm_formats() {
        assert_approx_eq(to_f32_sample(i8::MIN), -1.0);
        assert_approx_eq(to_f32_sample(i8::MAX), 127.0 / 128.0);

        assert_approx_eq(to_f32_sample(i16::MIN), -1.0);
        assert_approx_eq(to_f32_sample(i16::MAX), 32_767.0 / 32_768.0);

        let i24_min = cpal::I24::new(-8_388_608).expect("valid I24 minimum");
        let i24_max = cpal::I24::new(8_388_607).expect("valid I24 maximum");
        assert_approx_eq(to_f32_sample(i24_min), -1.0);
        assert_approx_eq(to_f32_sample(i24_max), 8_388_607.0 / 8_388_608.0);

        assert_approx_eq(to_f32_sample(i32::MIN), -1.0);
        assert_approx_eq(to_f32_sample(i32::MAX), 2_147_483_647.0 / 2_147_483_648.0);
        assert_approx_eq(to_f32_sample(128_u8), 0.0);
    }

    #[test]
    fn downmixes_interleaved_pcm_frames_after_normalization() {
        let stereo = [i16::MIN, i16::MIN, i16::MAX, i16::MAX];
        let mono = downmix_to_mono(&stereo, 2);

        assert_eq!(mono.len(), 2);
        assert_approx_eq(mono[0], -1.0);
        assert_approx_eq(mono[1], 32_767.0 / 32_768.0);
    }

    #[test]
    fn downmix_ignores_incomplete_trailing_frames() {
        let mono = downmix_to_mono(&[i8::MIN, i8::MAX, 0], 2);
        assert_eq!(mono.len(), 1);
        assert_approx_eq(mono[0], -1.0 / 256.0);
    }
}

#[cfg(test)]
mod dictation_auto_stop_gate_tests {
    use super::drive_dictation_auto_stop_gate;
    use crate::audio::vad::{EnergyThresholdVadGate, VadConfig, VadGate};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    // Fixed threshold, small hysteresis windows expressed in whole "frames" (one
    // `frame_size`-sample chunk each), matching the convention used by
    // `audio::vad::tests::fixed_threshold_gate`.
    fn test_gate() -> Box<dyn VadGate + Send> {
        Box::new(EnergyThresholdVadGate::new(&VadConfig {
            frame_size: 160, // 10ms at 16kHz
            sample_rate: 16_000,
            threshold_db: Some(-40.0),
            min_speech_duration: 0.05,  // 5 frames
            min_silence_duration: 0.05, // 5 frames
            padding_seconds: 0.0,
        }))
    }

    fn loud_samples(frames: usize) -> Vec<f32> {
        vec![0.5; frames * 160]
    }

    fn quiet_samples(frames: usize) -> Vec<f32> {
        vec![0.0; frames * 160]
    }

    #[test]
    fn emits_silence_stop_after_speech_then_sustained_silence_for_current_session() {
        let gate = Mutex::new(Some(test_gate()));
        let session_id = AtomicU64::new(7);

        // No SidecarHandle in a unit test; instead verify the gate's own state
        // transitions, which is what actually decides whether an event would fire.
        // (End-to-end emission is covered by the lib.rs/electron integration.)
        {
            let mut slot = gate.lock().unwrap();
            let g = slot.as_mut().unwrap();
            let _ = g.push_samples(&loud_samples(6)); // loud enough to confirm speech
            assert!(g.is_speaking(), "should be in speech state after loud run");
        }

        // Drive through the real helper (with no event_handle) to confirm it
        // doesn't panic and correctly advances gate state for the active session.
        drive_dictation_auto_stop_gate(
            &quiet_samples(6),
            session_id.load(Ordering::SeqCst),
            &gate,
            &session_id,
            None,
        );

        let slot = gate.lock().unwrap();
        let g = slot.as_ref().unwrap();
        assert!(
            !g.is_speaking(),
            "sustained silence after speech should flip the gate out of speech"
        );
    }

    #[test]
    fn stale_session_id_prevents_gate_from_being_touched() {
        let gate = Mutex::new(Some(test_gate()));
        // Gate belongs to session 1, but the callback invoking us is stamped with
        // session 1 too *at spawn time*; simulate a NEW session (2) having since
        // started by advancing the shared session id without replacing this
        // particular gate/mutex (as would happen if a stale in-flight callback
        // closure captured session_id=1 before start_dictation moved on).
        let current_session_id = AtomicU64::new(2);
        let stale_callback_session_id = 1_u64;

        {
            let mut slot = gate.lock().unwrap();
            let g = slot.as_mut().unwrap();
            let _ = g.push_samples(&loud_samples(6));
            assert!(g.is_speaking());
        }

        // A stale callback (still holding session_id=1) tries to push silence in.
        drive_dictation_auto_stop_gate(
            &quiet_samples(6),
            stale_callback_session_id,
            &gate,
            &current_session_id,
            None,
        );

        // Because current_session_id (2) != stale_callback_session_id (1), the
        // helper must bail out before touching the gate at all.
        let slot = gate.lock().unwrap();
        let g = slot.as_ref().unwrap();
        assert!(
            g.is_speaking(),
            "stale-session callback must not be able to mutate a gate it no longer owns"
        );
    }

    #[test]
    fn empty_samples_is_a_no_op() {
        let gate = Mutex::new(Some(test_gate()));
        let session_id = AtomicU64::new(1);

        // Should not panic and should not touch the gate.
        drive_dictation_auto_stop_gate(&[], 1, &gate, &session_id, None);

        let slot = gate.lock().unwrap();
        assert!(
            !slot.as_ref().unwrap().is_speaking(),
            "gate should be untouched when no samples are provided"
        );
    }

    #[test]
    fn no_gate_installed_is_a_no_op() {
        let gate: Mutex<Option<Box<dyn VadGate + Send>>> = Mutex::new(None);
        let session_id = AtomicU64::new(1);

        // Auto-stop disabled for this session: gate slot is None. Must not panic.
        drive_dictation_auto_stop_gate(&loud_samples(6), 1, &gate, &session_id, None);

        assert!(gate.lock().unwrap().is_none());
    }
}

#[cfg(test)]
mod recording_writer_tests {
    use super::prepare_mono_wav_writer;

    #[test]
    fn writer_setup_uses_create_new_without_truncating_an_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "plainsong-writer-create-new-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("recording.wav");
        std::fs::write(&path, b"do not truncate").unwrap();

        assert!(prepare_mono_wav_writer(&path, 16_000).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"do not truncate");

        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod system_audio_test_guard_tests {
    use super::claim_system_audio_test;

    #[test]
    fn active_recording_and_overlapping_tests_are_rejected() {
        let active_error = claim_system_audio_test(true)
            .err()
            .expect("active recording error");
        assert!(active_error.to_string().contains("recording is active"));

        let guard = claim_system_audio_test(false).expect("first test guard");
        let overlap_error = claim_system_audio_test(false)
            .err()
            .expect("overlapping test error");
        assert!(overlap_error.to_string().contains("already running"));
        drop(guard);

        assert!(claim_system_audio_test(false).is_ok());
    }
}

#[cfg(test)]
mod dictation_capture_lifecycle_tests {
    use super::AudioCapture;
    use crate::audio::vad::{EnergyThresholdVadGate, VadConfig, VadGate};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// The per-session capture stop flag must be signalled (and the handle
    /// dropped) by both stop paths, so an old capture thread parked on it can
    /// never be re-armed by a subsequent session setting `is_dictating` back
    /// to true.
    #[test]
    fn abort_dictation_signals_the_sessions_capture_stop_flag() {
        let mut audio = AudioCapture::new();
        let session_flag = Arc::new(AtomicBool::new(true));
        audio.dictation_capture_stop = Some(Arc::clone(&session_flag));
        audio.is_dictating.store(true, Ordering::SeqCst);

        audio.abort_dictation();

        assert!(
            !session_flag.load(Ordering::SeqCst),
            "abort must stop the session's own capture flag, not just is_dictating"
        );
        assert!(
            audio.dictation_capture_stop.is_none(),
            "the handle must be dropped so a new session mints a fresh flag"
        );
        assert!(!audio.is_dictating.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_dictation_signals_the_sessions_capture_stop_flag() {
        let mut audio = AudioCapture::new();
        let session_flag = Arc::new(AtomicBool::new(true));
        audio.dictation_capture_stop = Some(Arc::clone(&session_flag));
        audio.is_dictating.store(true, Ordering::SeqCst);

        // No capture thread ran, so no samples were collected: the stop path
        // errors out ("no audio"), but must still have signalled the flag.
        let _ = audio.stop_dictation();

        assert!(!session_flag.load(Ordering::SeqCst));
        assert!(audio.dictation_capture_stop.is_none());
    }

    /// Both stop paths must clear the auto-stop VAD gate slot so a finished
    /// session doesn't retain its gate (for Silero: a worker thread holding
    /// the loaded ort session) until the next start_dictation replaces it.
    #[test]
    fn stop_and_abort_clear_the_vad_gate_slot() {
        let gate_config = VadConfig::default();

        let mut audio = AudioCapture::new();
        audio.is_dictating.store(true, Ordering::SeqCst);
        *audio.dictation_vad_gate.lock().unwrap() =
            Some(Box::new(EnergyThresholdVadGate::new(&gate_config)) as Box<dyn VadGate + Send>);
        audio
            .dictation_vad_gate_active
            .store(true, Ordering::SeqCst);
        let _ = audio.stop_dictation();
        assert!(audio.dictation_vad_gate.lock().unwrap().is_none());
        assert!(!audio.dictation_vad_gate_active.load(Ordering::SeqCst));

        let mut audio = AudioCapture::new();
        audio.is_dictating.store(true, Ordering::SeqCst);
        *audio.dictation_vad_gate.lock().unwrap() =
            Some(Box::new(EnergyThresholdVadGate::new(&gate_config)) as Box<dyn VadGate + Send>);
        audio
            .dictation_vad_gate_active
            .store(true, Ordering::SeqCst);
        audio.abort_dictation();
        assert!(audio.dictation_vad_gate.lock().unwrap().is_none());
        assert!(!audio.dictation_vad_gate_active.load(Ordering::SeqCst));
    }
}

#[cfg(test)]
mod hands_free_monitor_tests {
    use super::AudioCapture;
    use crate::sidecar_handle::SidecarHandle;
    use std::sync::atomic::Ordering;

    fn test_handle() -> SidecarHandle {
        // Channel is never drained in these tests; emits are fire-and-forget and the
        // sender is dropped along with the handle, which is fine for an unbounded
        // channel with no receiver-side assertions here.
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        SidecarHandle::new(tx)
    }

    /// The hands-free monitor and a live dictation session must never both hold the
    /// microphone: this is the "can't double start" guard at the layer that actually
    /// owns the capture stream (mirrors the `DictationSessionState::Idle` guard the
    /// lib.rs layer enforces before calling `start_dictation` at all).
    #[test]
    fn start_hands_free_monitor_is_a_no_op_while_dictation_is_active() {
        let mut audio = AudioCapture::new();
        // Simulate an active dictation session without needing a real capture stream:
        // `is_dictating` is exactly the flag `start_hands_free_monitor` checks, and it's
        // set `true` before `start_dictation`'s own capture thread spawns, so this
        // reflects the real ordering.
        audio.is_dictating.store(true, Ordering::SeqCst);

        let result = audio.start_hands_free_monitor(
            None,
            test_handle(),
            crate::audio::vad::VadBackendKind::EnergyThreshold,
            None,
        );

        assert!(
            result.is_ok(),
            "must not error, just decline to start: {result:?}"
        );
        assert!(
            !audio.is_hands_free_monitor_active(),
            "monitor must not report itself active while a dictation session is active"
        );
    }

    /// Calling start twice while already active must not spin up a second stream (which
    /// would either double-open the mic device or leak a thread); it's a no-op once the
    /// monitor is already running.
    #[test]
    fn start_hands_free_monitor_is_idempotent_while_already_active() {
        let mut audio = AudioCapture::new();
        // Simulate "already running" directly, without a real audio device: this is
        // exactly the flag `start_hands_free_monitor`'s first guard reads.
        audio
            .hands_free_monitor_active
            .store(true, Ordering::SeqCst);

        let result = audio.start_hands_free_monitor(
            None,
            test_handle(),
            crate::audio::vad::VadBackendKind::EnergyThreshold,
            None,
        );

        assert!(
            result.is_ok(),
            "second start call must not error: {result:?}"
        );
        assert!(
            audio.is_hands_free_monitor_active(),
            "must remain active (unchanged), not toggled off by the redundant call"
        );
        // No monitor thread was actually spawned by either guard path (both guards
        // return before touching `hands_free_monitor_thread`), so there is nothing to
        // join — stop should still be a clean no-op afterward.
        audio.stop_hands_free_monitor();
        assert!(!audio.is_hands_free_monitor_active());
    }

    /// Stopping the monitor when it was never started (e.g. hands-free is disabled, so
    /// `reconcile_hands_free_monitor` only ever calls `stop_hands_free_monitor`) must be
    /// a harmless no-op — this is what guarantees disabling the setting can't panic or
    /// hang trying to join a thread that doesn't exist.
    #[test]
    fn stop_hands_free_monitor_is_a_no_op_when_never_started() {
        let mut audio = AudioCapture::new();
        assert!(!audio.is_hands_free_monitor_active());

        audio.stop_hands_free_monitor();

        assert!(!audio.is_hands_free_monitor_active());
    }

    fn install_pre_roll(audio: &AudioCapture, sample_rate: u32, samples: &[f32]) {
        let mut ring = crate::audio::preroll::PreRollBuffer::new(sample_rate, 2.0);
        ring.push(samples);
        *audio.dictation_pre_roll.lock().unwrap() = Some(ring);
    }

    /// The hand-off the whole pre-roll exists for: the monitor stops, the real
    /// capture stream opens at the same rate, and the samples the monitor
    /// already heard become the head of the session's audio.
    #[test]
    fn a_fresh_pre_roll_at_the_same_sample_rate_seeds_the_session() {
        let audio = AudioCapture::new();
        install_pre_roll(&audio, 48_000, &[0.1, 0.2, 0.3]);

        assert_eq!(audio.take_dictation_pre_roll(48_000), vec![0.1, 0.2, 0.3]);
        // Drained, so a second session can never inherit the first one's audio.
        assert!(audio.take_dictation_pre_roll(48_000).is_empty());
    }

    /// A ring recorded at another rate (the input device changed between the
    /// monitor and the session) would play back as pitch-shifted garbage
    /// spliced onto the front of the transcript, so it is dropped, not resampled.
    #[test]
    fn a_pre_roll_from_a_different_sample_rate_is_discarded() {
        let audio = AudioCapture::new();
        install_pre_roll(&audio, 16_000, &[0.1, 0.2, 0.3]);

        assert!(audio.take_dictation_pre_roll(48_000).is_empty());
        // Still emptied: stale audio must not sit around waiting for a session
        // that happens to open at the matching rate.
        assert!(audio.take_dictation_pre_roll(16_000).is_empty());
    }

    #[test]
    fn taking_a_pre_roll_that_was_never_recorded_is_empty_not_a_panic() {
        let audio = AudioCapture::new();
        assert!(audio.take_dictation_pre_roll(48_000).is_empty());
    }

    /// Turning hands-free off must not leave a couple of seconds of microphone
    /// audio resident from the monitor that just stopped.
    #[test]
    fn clearing_the_pre_roll_drops_what_the_monitor_heard() {
        let audio = AudioCapture::new();
        install_pre_roll(&audio, 48_000, &[0.1, 0.2, 0.3]);

        audio.clear_dictation_pre_roll();

        assert!(audio.dictation_pre_roll.lock().unwrap().is_none());
        assert!(audio.take_dictation_pre_roll(48_000).is_empty());
    }

    /// The activation path decides, not the ring's freshness. `dispatch_command`
    /// stops the monitor one statement before every `start_dictation`, so the
    /// ring is fresh on the hotkey path too and `take_dictation_pre_roll`'s age
    /// guard can never fire there — a hotkey start that drained it would put the
    /// two seconds *before* the press at the user's cursor.
    #[test]
    fn only_a_hands_free_start_inherits_the_monitors_audio() {
        let audio = AudioCapture::new();
        install_pre_roll(&audio, 48_000, &[0.1, 0.2, 0.3]);

        assert!(
            audio
                .resolve_dictation_seed_samples(48_000, false)
                .is_empty(),
            "a hotkey/native-helper start must open the microphone cold"
        );
        // And the unused ring is dropped rather than left resident for the next
        // start to pick up.
        assert!(audio.dictation_pre_roll.lock().unwrap().is_none());

        install_pre_roll(&audio, 48_000, &[0.1, 0.2, 0.3]);
        assert_eq!(
            audio.resolve_dictation_seed_samples(48_000, true),
            vec![0.1, 0.2, 0.3],
            "the hands-free path is the one that keeps the opening words"
        );
    }

    /// Only the `hands_free_start` signal may set the flag, and it has to
    /// survive the JSON round trip from electron/main.ts as camelCase.
    #[test]
    fn the_hands_free_trigger_flag_defaults_off_over_the_wire() {
        let default_options = crate::models::DictationStartOptions::default();
        assert!(!default_options.hands_free_trigger);

        let from_empty: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!from_empty.hands_free_trigger);

        let from_hands_free: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({ "handsFreeTrigger": true })).unwrap();
        assert!(from_hands_free.hands_free_trigger);
    }
}
