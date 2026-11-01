#[cfg(target_os = "macos")]
pub(crate) mod macos_system_tap;
pub mod mel;
pub mod preroll;
mod realtime;
pub mod silero_vad;
pub mod system_capture;
pub mod utils;
pub mod vad;
pub mod waveform;

use crate::audio::preroll::{
    PreRollBuffer, PRE_ROLL_MAX_AGE_MS, PRE_ROLL_SECONDS, PRE_ROLL_SPEECH_LEAD_SECONDS,
};
use crate::audio::silero_vad::build_vad_gate;
use crate::audio::system_capture::{
    MixedAudioCapture, MixedAudioChunk, MixedCaptureEvents, SourceInactivity,
    SourceSilenceWatchdog, SystemAudioCapability, MIC_SILENCE_PROFILE,
};
use crate::audio::vad::{VadBackendKind, VadConfig, VadEdge, VadGate};
use crate::meeting_asides::{AsideSink, AsideSpan, MeetingMicTap, MeetingMicrophone};
use crate::models::RecordingOptions;
use crate::recording_audio::{
    available_space_bytes, create_new_file, repair_plaintext_wav_header, sync_file,
    sync_parent_directory, validate_plaintext_wav, RecordingAudioRole, RecordingAudioValidation,
    RecordingCapturePlan, ValidatedRecordingAudio,
};
use crate::recording_pause::{PauseLedger, PauseSpan};
use crate::settings;
use crate::sidecar_handle::{AppEmitter, SidecarHandle};
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use crossbeam::channel::{bounded, Receiver, RecvTimeoutError, TrySendError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
///
/// The wait itself belongs to the *caller*, not to `stop_dictation`: it used to
/// be a `std::thread::sleep` at the top of the stop body, which ran while the
/// caller held the async `audio_capture` mutex and blocked a tokio worker for
/// its whole duration. `stop_dictation_for_sidecar` now awaits it before
/// acquiring the lock, which keeps the ordering identical (capture is still
/// live, `is_dictating` has not been flipped) without parking a runtime thread
/// or the mutex.
pub(crate) const DICTATION_STOP_CAPTURE_TAIL_MS: u64 = 120;
/// Core Audio can take just over three seconds to construct its first input
/// stream after launch, especially while the audio server is waking. This is
/// only a failure deadline; successful stream starts still return immediately.
/// Keep it bounded because the platform construction call is not cancellable.
#[cfg(target_os = "macos")]
const MICROPHONE_STREAM_PREPARATION_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(target_os = "macos"))]
const MICROPHONE_STREAM_PREPARATION_TIMEOUT: Duration = Duration::from_secs(3);
/// Longest wait for the first capture callback before the start command
/// returns. "Listening" itself waits for the first sample however long it
/// takes (`dictation_session::publish_dictation_listening`); this bound only
/// keeps a slow device from holding the start command.
const FIRST_CAPTURE_CALLBACK_WAIT: Duration = Duration::from_millis(750);
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
/// Hard ceiling on how much audio one dictation session may buffer.
///
/// The capture buffer is an unbounded `SegQueue<f32>` held entirely in RAM until
/// stop, so a session that never ends grows without limit: at a 48kHz device
/// that is 192 KB/s, or roughly 11.5 MB per minute. Nothing bounded it, and a
/// stuck session (a hands-free mis-trigger, a hotkey that never released, a user
/// who walked away) would grow until the process died.
///
/// Ten minutes caps the worst case near 115 MB at 48kHz while sitting far beyond
/// any real dictation: this is a short-form modality where hotkey release and
/// auto-stop-on-silence end typical sessions in seconds. Reaching this ceiling
/// means something went wrong, so the session is ended and the user is told
/// rather than left with silently truncated audio.
const DICTATION_MAX_SESSION_SECONDS: u64 = 10 * 60;

/// Run one realtime audio callback body so a panic inside it cannot take the
/// process down.
///
/// These closures are invoked by cpal from a CoreAudio render thread, through an
/// `extern "C"` trampoline. An escaping panic would hit that boundary and abort
/// -- killing an in-progress meeting and its unflushed audio over what is often
/// a recoverable bug in one callback. Catching here turns that into a single
/// logged error and an inert stream.
///
/// `poisoned` makes the stream inert rather than letting the same panic repeat
/// hundreds of times a second: whatever invariant the callback broke, it will
/// keep breaking it, and the log would bury everything else.
///
/// `AssertUnwindSafe` is honest here precisely *because* of that latch. The
/// concern it waives is observing state a panic left half-updated, and after a
/// panic this callback never runs again, so no later iteration can observe it.
fn guard_audio_callback<F: FnOnce()>(poisoned: &AtomicBool, label: &str, body: F) {
    if poisoned.load(Ordering::Relaxed) {
        return;
    }
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err() {
        poisoned.store(true, Ordering::Relaxed);
        tracing::error!(
            "{} audio callback panicked; this capture stream is now inert",
            label
        );
    }
}

/// How one capture callback's worth of mono samples fares against the session
/// length ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DictationBufferAdmission {
    /// Leading samples that still fit and must be buffered.
    pub accepted: u64,
    /// True exactly when this callback is the one that fills the buffer, so the
    /// caller can stop capture and announce the ceiling a single time.
    pub ceiling_reached: bool,
}

/// Decide how much of an incoming callback fits under the session ceiling.
///
/// Split out of the realtime capture callback so the ceiling arithmetic -- the
/// part that decides whether a user's audio is kept or dropped -- is testable
/// without a live input device.
pub(crate) fn admit_dictation_samples(
    buffered: u64,
    incoming: u64,
    max_session_samples: u64,
) -> DictationBufferAdmission {
    let remaining = max_session_samples.saturating_sub(buffered);
    let accepted = remaining.min(incoming);
    DictationBufferAdmission {
        accepted,
        // Only report the ceiling when this callback actually had audio to
        // place: an empty callback against a full buffer is not the moment the
        // limit was hit, and must not re-announce it.
        ceiling_reached: incoming > 0 && accepted < incoming,
    }
}

/// Bytes a mono 16-bit WAV track consumes per second at 48 kHz, the rate every
/// mixed meeting session lands on.
pub const MEETING_WAV_BYTES_PER_SECOND_PER_TRACK: u64 = 48_000 * 2;
/// Recording time a meeting must have room for before it is allowed to start.
///
/// Refusing here is recoverable and honest; running out mid-meeting is not — the
/// writer thread dies on ENOSPC and, until the writer-failure slot existed, the
/// session kept showing an active recording while every subsequent sample was
/// discarded.
pub const MEETING_START_MIN_HEADROOM_SECONDS: u64 = 30 * 60;
/// Remaining recording time below which a running meeting warns the user:
/// enough to wrap up or free space before capture has to end.
pub const MEETING_LOW_SPACE_WARN_SECONDS: u64 = 10 * 60;
/// Remaining recording time below which a running meeting is stopped on
/// purpose, so the clean stop path (flush, finalize, fsync, hash) can land the
/// audio already captured. Stopping here trades the last minute of a meeting
/// for keeping the rest.
///
pub const MEETING_CRITICAL_SPACE_STOP_SECONDS: u64 = 60;

/// Free bytes one meeting needs to record for `seconds`.
///
/// Every threshold below scales with the number of WAV tracks the session
/// actually writes: a mic-only meeting writes one, "me and them" writes three
/// (mixed, mic, system). Charging every meeting the three-track price refused
/// mic-only meetings on volumes that could comfortably hold ~50 minutes of
/// them, and warned and auto-stopped the ones that did start three times too
/// early.
pub fn meeting_headroom_bytes(track_count: u64, seconds: u64) -> u64 {
    track_count
        .max(1)
        .saturating_mul(MEETING_WAV_BYTES_PER_SECOND_PER_TRACK)
        .saturating_mul(seconds)
}

/// What a running meeting's capture threads have reported about themselves.
///
/// Polled by the meeting lifecycle loop: both failure slots are written by
/// threads that then exit, so nothing else would ever notice they are gone
/// until stop.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordingCaptureHealth {
    /// Set when a WAV writer thread returned an error and stopped consuming
    /// samples. Everything recorded after this point is discarded.
    pub writer_failure: Option<String>,
    /// Set when the OS reported the input stream itself failed.
    pub capture_failure: Option<String>,
    /// How many WAV tracks this session writes, so the polling loop can size the
    /// free-space thresholds to what the meeting actually consumes.
    pub track_count: u64,
    /// Exact bytes needed to stage encrypted copies of the session's current
    /// plaintext WAV files.
    pub vault_staging_bytes: u64,
    /// Whether the user has paused capture. Frames are being dropped on
    /// purpose, so nothing below may be read as a fault or as silence.
    pub paused: bool,
    /// Audio forwarded to the WAV file, excluding paused frames.
    pub recorded_seconds: f64,
    /// How long each captured source has carried nothing audible.
    pub inactivity: SourceInactivity,
    /// Seconds since frames last started flowing on purpose: activation, or
    /// the most recent resume. A silence fuse must never be shorter than this,
    /// or a meeting resumed into a quiet room would end at once.
    pub seconds_since_activity_epoch: f32,
    /// Whether this is a Me + Them session, which rebuilds a failed source and
    /// reports it on its own channel.
    pub mixed: bool,
}

/// Whether a mic-only meeting's microphone has stopped: the OS reported the
/// input stream failed and no new audio reached the file since the last check.
///
/// A mic-only session has nothing else recording and no rebuild, and its
/// silence and length fuses both count captured audio, so without this the
/// meeting kept "recording" nothing until the person pressed Stop.
pub fn microphone_lost(
    health: &RecordingCaptureHealth,
    previous_recorded_seconds: Option<f64>,
) -> bool {
    health.capture_failure.is_some()
        && !health.mixed
        && !health.paused
        && previous_recorded_seconds.is_some_and(|previous| health.recorded_seconds <= previous)
}

/// The pause state of the active meeting, as the renderer needs it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPauseSnapshot {
    pub paused: bool,
    /// Paused time from spans that have ended, so the renderer can freeze its
    /// clock without a round trip per tick.
    pub closed_paused_ms: i64,
    /// When the open pause began, if paused.
    pub pause_started_at_ms: Option<i64>,
    pub spans: Vec<PauseSpan>,
}

/// Whether a running meeting should end because nobody has been audible on
/// any captured source for `silence_minutes`.
///
/// Every captured source must have been inactive for the whole fuse, and the
/// fuse must also have elapsed since frames last started flowing on purpose
/// (activation, or the latest resume) — otherwise a meeting resumed into a
/// quiet room would end on the first poll. A paused meeting never qualifies:
/// its watchdogs are not being fed, and a pause is the user's silence, not
/// the room's. `0` minutes is off. Pure, so the policy is testable without a
/// device.
pub fn silence_auto_stop_due(health: &RecordingCaptureHealth, silence_minutes: u32) -> bool {
    if silence_minutes == 0 || health.paused {
        return false;
    }
    every_source_quiet_for(health, silence_minutes as f32 * 60.0)
}

/// Captured audio, rather than elapsed wall time, governs this optional limit.
pub fn duration_auto_stop_due(health: &RecordingCaptureHealth, minutes: u32) -> bool {
    minutes > 0
        && !health.paused
        && health.recorded_seconds.is_finite()
        && health.recorded_seconds >= f64::from(minutes) * 60.0
}

pub fn duration_auto_stop_warning_due(health: &RecordingCaptureHealth, minutes: u32) -> bool {
    let limit_seconds = f64::from(minutes) * 60.0;
    let warning_seconds = 300.0_f64.min(limit_seconds / 2.0);
    minutes > 0
        && !health.paused
        && health.recorded_seconds.is_finite()
        && health.recorded_seconds >= limit_seconds - warning_seconds
        && health.recorded_seconds < limit_seconds
}

/// Warn once at the current limit, and rearm when the user changes it.
#[derive(Default)]
pub struct MeetingDurationWarning {
    configured_minutes: u32,
    reported: bool,
}

impl MeetingDurationWarning {
    pub fn take_due(&mut self, health: &RecordingCaptureHealth, minutes: u32) -> bool {
        if self.configured_minutes != minutes {
            self.configured_minutes = minutes;
            self.reported = false;
        }
        if !self.reported && duration_auto_stop_warning_due(health, minutes) {
            self.reported = true;
            return true;
        }
        false
    }
}

/// Whether every captured source has been inactive for `seconds`, and frames
/// have been flowing on purpose for at least that long. Shared by the stop and
/// the warning that precedes it so the two can never disagree.
fn every_source_quiet_for(health: &RecordingCaptureHealth, seconds: f32) -> bool {
    if health.seconds_since_activity_epoch < seconds {
        return false;
    }
    let sources = [
        health.inactivity.mic_seconds,
        health.inactivity.system_seconds,
    ];
    let mut any_source = false;
    for inactive_seconds in sources.into_iter().flatten() {
        any_source = true;
        if inactive_seconds < seconds {
            return false;
        }
    }
    any_source
}

/// How long a meeting must have been quiet before it is warned, or `None` when
/// there is no useful warning to give.
///
/// Half the fuse, floored to whole minutes so the sentence can name both
/// numbers exactly: a 15-minute fuse warns at 7 and says 8 remain. A fuse of
/// one minute has no half worth announcing, and `0` is the setting for off.
pub fn silence_auto_stop_warning_minutes(silence_minutes: u32) -> Option<u32> {
    let warn_after = silence_minutes / 2;
    (warn_after > 0).then_some(warn_after)
}

/// Whether a running meeting should be told it is on course to stop itself for
/// silence.
///
/// The threshold that ends a meeting is a heuristic about room tone, and it
/// used to be announced only in the same breath as the stop — by which point a
/// lecture nobody was miked for had already ended. Same conditions as the stop
/// (every source quiet, the fuse's own clock running since the last resume, a
/// paused meeting exempt), at half the distance, so a warning can never appear
/// for a meeting the stop would not reach.
pub fn silence_auto_stop_warning_due(
    health: &RecordingCaptureHealth,
    silence_minutes: u32,
) -> bool {
    let Some(warn_after) = silence_auto_stop_warning_minutes(silence_minutes) else {
        return false;
    };
    if health.paused {
        return false;
    }
    every_source_quiet_for(health, warn_after as f32 * 60.0)
}

/// Decide what a free-space reading means for a running meeting.
///
/// Split out from the polling loop so the thresholds are testable without a
/// filesystem that can be filled on demand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingSpacePressure {
    Ok,
    Low,
    Critical,
}

pub fn meeting_vault_staging_bytes(track_plaintext_bytes: &[u64]) -> u64 {
    track_plaintext_bytes
        .iter()
        .fold(0_u64, |total, plaintext| {
            total.saturating_add(crate::crypto::ProjectKeyManager::streaming_ciphertext_len(
                *plaintext,
            ))
        })
}

pub fn meeting_space_pressure_with_vault_reserve(
    available_bytes: u64,
    track_count: u64,
    vault_staging_bytes: u64,
    vault_enabled: bool,
) -> MeetingSpacePressure {
    let encryption_reserve = if vault_enabled {
        vault_staging_bytes
    } else {
        0
    };
    if available_bytes
        <= encryption_reserve.saturating_add(meeting_headroom_bytes(
            track_count,
            MEETING_CRITICAL_SPACE_STOP_SECONDS,
        ))
    {
        MeetingSpacePressure::Critical
    } else if available_bytes
        <= encryption_reserve.saturating_add(meeting_headroom_bytes(
            track_count,
            MEETING_LOW_SPACE_WARN_SECONDS,
        ))
    {
        MeetingSpacePressure::Low
    } else {
        MeetingSpacePressure::Ok
    }
}

#[cfg(test)]
pub fn meeting_space_pressure(available_bytes: u64, track_count: u64) -> MeetingSpacePressure {
    meeting_space_pressure_with_vault_reserve(available_bytes, track_count, 0, false)
}

/// `Some(needed_bytes)` when a volume with this much free space must not be
/// asked to hold a meeting writing `track_count` tracks.
pub fn meeting_start_space_shortfall_with_vault_reserve(
    available_bytes: u64,
    track_count: u64,
    vault_enabled: bool,
) -> Option<u64> {
    let capture = meeting_headroom_bytes(track_count, MEETING_START_MIN_HEADROOM_SECONDS);
    // Vault finalization stages ciphertext beside the plaintext before deleting
    // the latter, so admission must provide room for both full-size copies.
    let needed = if vault_enabled {
        let per_track_capture = meeting_headroom_bytes(1, MEETING_START_MIN_HEADROOM_SECONDS);
        let track_sizes = vec![per_track_capture; track_count.max(1) as usize];
        capture.saturating_add(meeting_vault_staging_bytes(&track_sizes))
    } else {
        capture
    };
    (available_bytes < needed).then_some(needed)
}

#[cfg(test)]
pub fn meeting_start_space_shortfall(available_bytes: u64, track_count: u64) -> Option<u64> {
    meeting_start_space_shortfall_with_vault_reserve(available_bytes, track_count, false)
}

/// Record the first writer failure for a session.
///
/// First writer to die wins: a three-track bundle shares one writer thread, but
/// keeping the earliest cause is what explains where the audio stops.
fn record_writer_failure(slot: &Arc<std::sync::Mutex<Option<String>>>, reason: String) {
    if let Ok(mut failure) = slot.lock() {
        if failure.is_none() {
            *failure = Some(reason);
        }
    }
}

/// Convert a mixed session's padded-frame counts into seconds of source silence.
///
/// A zero sample rate would be a bug elsewhere, but reporting infinite silence
/// because of it would be worse than reporting none.
pub fn source_degradation_from_outcome(
    outcome: &crate::audio::system_capture::MixedCaptureOutcome,
    sample_rate: u32,
) -> RecordingSourceDegradation {
    if sample_rate == 0 {
        return RecordingSourceDegradation::default();
    }
    let rate = f64::from(sample_rate);
    RecordingSourceDegradation {
        mic_silent_seconds: outcome.mic_padded_frames as f64 / rate,
        system_silent_seconds: outcome.system_padded_frames as f64 / rate,
        captured_seconds: outcome.mixed_frames as f64 / rate,
    }
}

/// Run one WAV writer to completion and publish its failure before exiting.
///
/// The publish has to happen inside the writer thread. Once it returns, its
/// receiver is dropped: the mic-only capture callback's `Disconnected` arm then
/// discards every remaining sample in silence, and the mixed capture thread
/// shuts itself down. This slot is the only evidence that the recording stopped
/// being written, and it has to exist before anything else can notice.
fn run_wav_writer_thread(
    failure_slot: Arc<std::sync::Mutex<Option<String>>>,
    write: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let result = write();
    if let Err(error) = result.as_ref() {
        tracing::error!("Meeting WAV writer stopped: {error:#}");
        record_writer_failure(&failure_slot, format!("{error:#}"));
    }
    result
}

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMicrophoneInput {
    pub requested_name: Option<String>,
    pub resolved_name: String,
    pub used_fallback: bool,
    pub advisory: Option<String>,
}

impl MeetingMicrophoneInput {
    fn from_resolved(resolved: &ResolvedAudioInputDevice, requested_name: Option<&str>) -> Self {
        Self {
            requested_name: requested_name.map(str::to_string),
            resolved_name: resolved.device_name.clone(),
            used_fallback: resolved.used_fallback,
            advisory: resolved.advisory.clone(),
        }
    }
}

pub struct PreparedMeetingRecording {
    pub recording_id: String,
    pub microphone_input: Option<MeetingMicrophoneInput>,
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
    /// A timed-out Core Audio construction call cannot be cancelled safely.
    /// Keep the long-lived sidecar from leaking another blocked worker on every
    /// retry; Electron recycles the sidecar after surfacing the first error.
    microphone_preparation_stalled: bool,
    /// Recent audio level for visualization.
    dictation_audio_level: Arc<DictationLevelMeter>,
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
    /// Session that owns the mutable dictation capture slots above. Cleanup
    /// from an older request must never stop a replacement capture.
    dictation_capture_session_id: Option<u64>,
    /// Mono samples currently held in `dictation_buffer` for the active session.
    /// The queue itself has no cheap length, and the capture callback must decide
    /// whether it is still under the session ceiling without walking it, so the
    /// count is maintained alongside.
    dictation_buffered_samples: Arc<AtomicU64>,
    /// Set once when the active session hits `DICTATION_MAX_SESSION_SECONDS`, so
    /// the ceiling is announced exactly once and `stop_dictation` can explain the
    /// truncation instead of silently returning a clipped recording.
    dictation_max_duration_reached: Arc<AtomicBool>,
    /// Limit requested for the next session. Starting capture consumes and
    /// resets it, so provider-specific limits cannot leak into later sessions.
    dictation_next_max_session_seconds: u64,
    /// Limit used by the active or most recently ended session, for warnings.
    dictation_last_max_session_seconds: u64,
    /// UI-only accumulator of mono dictation samples for streaming partials.
    /// Never feeds the final transcription; only read by the partial-decode task.
    dictation_partial_buffer: Arc<std::sync::Mutex<DictationPartialBuffer>>,
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
    /// What the latest hands-free monitor run feeds (see [`HandsFreeTap`]).
    /// Replaced on every monitor start, so a stream already handed to a
    /// session keeps its own tap.
    hands_free_tap: Arc<std::sync::Mutex<HandsFreeTap>>,
    /// Microseconds from `start_dictation` entry to the first sample the
    /// capture callback delivered, or 0 while none has arrived yet. This is
    /// the number that moves when microphone cold-open cost changes, so it is
    /// measured rather than assumed.
    dictation_first_sample_us: Arc<AtomicU64>,
    /// Microseconds from `start_dictation` entry to the latest capture
    /// callback. A healthy device calls back every few milliseconds, so a
    /// long silence here means the microphone went away mid-session.
    dictation_last_callback_us: Arc<AtomicU64>,
    /// Set by the stream's error callback (disconnect, format change).
    dictation_stream_failed: Arc<AtomicBool>,
    dictation_capture_started_at: Option<std::time::Instant>,
    /// The meeting tap the current dictation takes its frames from, when it
    /// is an aside. Held here rather than looked up through the recording,
    /// so stop and abort can detach it even after the meeting has ended.
    dictation_aside_tap: Option<Arc<MeetingMicTap>>,
    dictation_capture_checkpoint:
        Arc<std::sync::Mutex<Option<crate::dictation_checkpoint::CaptureCheckpoint>>>,
    #[cfg(test)]
    dictation_checkpoint_root: Option<crate::test_fs::TempDir>,
}

/// Bounded UI-only audio plus an absolute sample watermark. The watermark is
/// required because the sample vector becomes a fixed-length sliding window
/// after 30 seconds. Comparing vector lengths at that point made live preview
/// stop forever even though new speech was still arriving.
#[derive(Debug, Default)]
pub(crate) struct DictationPartialBuffer {
    pub(crate) samples: Vec<f32>,
    pub(crate) total_samples: u64,
}

/// Loudest capture-callback RMS over the last one to two windows.
///
/// A callback covers ~10 ms while the UI polls every 90-120 ms, so storing the
/// latest callback made the meter jitter and miss quiet syllables. Readers
/// cannot reset a peak either: the popup and the main window poll on their own
/// timers, and whichever read second would see an empty window. So the capture
/// callback, the only writer, rotates the window instead.
#[derive(Default)]
struct DictationLevelMeter {
    current: AtomicU32,
    previous: AtomicU32,
    window_started_us: AtomicU64,
}

impl DictationLevelMeter {
    const WINDOW_US: u64 = 120_000;

    fn record(&self, rms: f32, now_us: u64) {
        let level = (rms.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
        let rotate = now_us
            .checked_sub(self.window_started_us.load(Ordering::Relaxed))
            .is_none_or(|elapsed| elapsed >= Self::WINDOW_US);
        if rotate {
            let finished = self.current.swap(level, Ordering::Relaxed);
            self.previous.store(finished, Ordering::Relaxed);
            self.window_started_us.store(now_us, Ordering::Relaxed);
        } else {
            self.current.fetch_max(level, Ordering::Relaxed);
        }
    }

    fn read(&self) -> f32 {
        let level = self
            .current
            .load(Ordering::Relaxed)
            .max(self.previous.load(Ordering::Relaxed));
        level as f32 / u32::MAX as f32
    }

    fn reset(&self) {
        self.current.store(0, Ordering::Relaxed);
        self.previous.store(0, Ordering::Relaxed);
        self.window_started_us.store(0, Ordering::Relaxed);
    }
}

/// Where one dictation session's audio goes, shared by whichever stream feeds
/// it: a stream opened for the session, or the hands-free monitor's stream
/// handed over to it.
struct DictationCaptureSink {
    session_id: u64,
    session_max_seconds: u64,
    /// Ceiling for the *transcription* buffer, in mono samples at the session
    /// rate. Unlike the partial buffer this one may not slide: dropping the
    /// oldest audio would silently rewrite what the user said. It stops
    /// instead, and says so.
    max_session_samples: u64,
    /// Sliding window for the UI-only partial buffer, so the per-tick clone
    /// (taken under a lock this callback also holds) and the partial re-decode
    /// stay O(window), not O(session length). Trimmed lazily (only past 2x the
    /// window) so the front-drain memmove happens roughly once per window.
    max_partial_samples: usize,
    capture_started_at: Instant,
    capture_stop: Arc<AtomicBool>,
    callback_count: Arc<AtomicU64>,
    buffer: Arc<crossbeam::queue::SegQueue<f32>>,
    buffered_samples: Arc<AtomicU64>,
    max_duration_reached: Arc<AtomicBool>,
    audio_level: Arc<DictationLevelMeter>,
    partial_buffer: Arc<std::sync::Mutex<DictationPartialBuffer>>,
    streaming_active: Arc<AtomicBool>,
    vad_gate: Arc<std::sync::Mutex<Option<Box<dyn VadGate + Send>>>>,
    vad_session_id: Arc<AtomicU64>,
    vad_gate_active: Arc<AtomicBool>,
    first_sample_us: Arc<AtomicU64>,
    last_callback_us: Arc<AtomicU64>,
    stream_failed: Arc<AtomicBool>,
    realtime: realtime::RealtimeSamples,
    checkpoint: Arc<std::sync::Mutex<Option<crate::dictation_checkpoint::CaptureCheckpoint>>>,
    event_handle: Option<SidecarHandle>,
}

impl DictationCaptureSink {
    /// The realtime body of a dictation capture callback.
    fn ingest<T>(&self, data: &[T], num_channels: usize)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        if !self.capture_stop.load(Ordering::SeqCst) {
            return;
        }

        // First sample of this session: record how long the microphone took
        // to actually deliver audio, so the cold-open cost is measurable
        // rather than assumed.
        if self.first_sample_us.load(Ordering::Relaxed) == 0 {
            let _ = self.first_sample_us.compare_exchange(
                0,
                (self.capture_started_at.elapsed().as_micros() as u64).max(1),
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
        }

        self.callback_count.fetch_add(1, Ordering::Relaxed);
        let now_us = self.capture_started_at.elapsed().as_micros() as u64;
        self.last_callback_us.store(now_us, Ordering::Relaxed);
        if self.realtime.push(data, num_channels) > 0 {
            self.stream_failed.store(true, Ordering::SeqCst);
        }
    }

    fn process_pending(&self) {
        let mut samples = Vec::new();
        self.realtime.drain(&mut samples);
        let dropped = self.realtime.take_dropped();
        if dropped > 0 {
            tracing::warn!(
                dropped_samples = dropped,
                "Dictation capture worker fell behind"
            );
        }
        if !samples.is_empty() {
            self.process_samples(&samples, 1);
        }
    }

    /// Runs on the capture worker, including the final drain after stream stop.
    fn process_samples<T>(&self, data: &[T], num_channels: usize)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        let now_us = self.last_callback_us.load(Ordering::Relaxed);
        let streaming = self.streaming_active.load(Ordering::Relaxed);
        let vad_active = self.vad_gate_active.load(Ordering::Relaxed)
            && self.vad_session_id.load(Ordering::SeqCst) == self.session_id;
        let checkpoint_active = self
            .checkpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        let need_mono_scratch = streaming || vad_active || checkpoint_active;
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

        // Admit one worker drain at a time and commit its sample count once.
        let admission = admit_dictation_samples(
            self.buffered_samples.load(Ordering::Relaxed),
            capacity as u64,
            self.max_session_samples,
        );
        let mut accepted_remaining = admission.accepted;

        for_each_mono_sample(data, num_channels, |sample| {
            if accepted_remaining > 0 {
                self.buffer.push(sample);
                accepted_remaining -= 1;
            }
            if need_mono_scratch {
                mono_scratch.push(sample);
            }
            sum_sq += (sample as f64) * (sample as f64);
            mono_len += 1;
        });

        if checkpoint_active {
            let mut checkpoint = self.checkpoint.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(checkpoint) = checkpoint.as_mut() {
                if let Err(error) = checkpoint.append(&mono_scratch[..admission.accepted as usize])
                {
                    tracing::error!("Could not checkpoint aside capture: {error}");
                    self.stream_failed.store(true, Ordering::SeqCst);
                    self.capture_stop.store(false, Ordering::SeqCst);
                }
            }
        }

        if admission.accepted > 0 {
            self.buffered_samples
                .fetch_add(admission.accepted, Ordering::Relaxed);
        }

        if admission.ceiling_reached && !self.max_duration_reached.swap(true, Ordering::SeqCst) {
            // End capture here rather than letting the mic run on producing
            // audio that can no longer be stored. Announced once;
            // `stop_dictation` also reports it, so the user is never handed a
            // silently truncated transcript.
            tracing::warn!(
                "Dictation session {} reached the {}s maximum length; capture stopped",
                self.session_id,
                self.session_max_seconds
            );
            self.capture_stop.store(false, Ordering::SeqCst);
            if let Some(handle) = self.event_handle.as_ref() {
                handle.emit(
                    "dictation-vad-signal",
                    serde_json::json!({
                        "signal": "max_duration_stop",
                        "sessionId": self.session_id,
                        "maxDurationSeconds": self.session_max_seconds,
                    }),
                );
            }
        }

        if streaming {
            if let Ok(mut shared) = self.partial_buffer.lock() {
                shared.total_samples = shared
                    .total_samples
                    .saturating_add(mono_scratch.len() as u64);
                shared.samples.extend_from_slice(&mono_scratch);
                if shared.samples.len() > self.max_partial_samples * 2 {
                    let overflow = shared.samples.len() - self.max_partial_samples;
                    shared.samples.drain(0..overflow);
                }
            }
        }

        let rms = (sum_sq / mono_len.max(1) as f64).sqrt() as f32;
        self.audio_level.record(rms, now_us);

        if vad_active {
            drive_dictation_auto_stop_gate(
                &mono_scratch,
                self.session_id,
                &self.vad_gate,
                &self.vad_session_id,
                self.event_handle.as_ref(),
            );
        }
    }

    /// Put audio heard before this session owned the stream at the head of
    /// its buffer. Not fed to the live preview or the auto-stop gate, matching
    /// how a freshly opened stream is seeded.
    fn seed(&self, samples: Vec<f32>) {
        if samples.is_empty() {
            return;
        }
        tracing::info!("Seeding dictation with {} pre-roll samples", samples.len());
        let seeded = samples.len() as u64;
        for sample in samples {
            self.buffer.push(sample);
        }
        self.buffered_samples.fetch_add(seeded, Ordering::SeqCst);
    }
}

/// An aside's dictation is fed by the meeting's capture worker, block by
/// block, exactly as the hands-free monitor feeds a session it handed over.
impl AsideSink for DictationCaptureSink {
    fn push_frames(&self, frames: &[f32]) {
        self.ingest(frames, 1);
        self.process_pending();
    }

    fn source_dropped(&self) {
        self.stream_failed.store(true, Ordering::SeqCst);
    }
}

/// What one hands-free monitor run's stream feeds: the pre-roll while it is
/// listening for speech, then the dictation session it was handed to.
#[derive(Default)]
struct HandsFreeTap {
    input_session_id: Arc<AtomicU64>,
    pre_roll: Option<PreRollBuffer>,
    /// Set while a start this monitor signalled is in flight, so a second
    /// burst cannot move the pre-roll's onset mark or signal again.
    held: bool,
    /// Device and format the monitor stream runs on. A session takes the
    /// stream over only when it would have opened exactly this.
    device_id: String,
    sample_rate: u32,
    channels: u16,
    session: Option<Arc<DictationCaptureSink>>,
}

impl HandsFreeTap {
    /// Whether the monitor thread must keep its stream open for a session.
    fn session_running(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.capture_stop.load(Ordering::SeqCst))
    }
}

/// Whether this monitor still owns incoming audio.
fn monitor_accepts_audio(
    monitoring: bool,
    dictating: bool,
    input_session_id: u64,
    active_session_id: u64,
) -> bool {
    if input_session_id == 0 {
        monitoring
    } else {
        dictating && input_session_id == active_session_id
    }
}

/// Process a drained buffer on the monitor worker, preserving pre-roll order
/// when the stream is handed to a dictation session.
fn feed_hands_free_monitor<T>(
    data: &[T],
    num_channels: usize,
    tap: &std::sync::Mutex<HandsFreeTap>,
    running: &AtomicBool,
    gate: &std::sync::Mutex<Box<dyn VadGate + Send>>,
    handle: &SidecarHandle,
    speech_onset_lookback: usize,
) where
    T: Sample,
    f32: FromSample<T>,
{
    let Ok(mut slot) = tap.lock() else {
        return;
    };
    if let Some(session) = slot.session.clone() {
        drop(slot);
        session.ingest(data, num_channels);
        session.process_pending();
        return;
    }
    if !running.load(Ordering::SeqCst) {
        return;
    }
    let mono = downmix_to_mono(data, num_channels);
    if let Some(pre_roll) = slot.pre_roll.as_mut() {
        pre_roll.push(&mono);
    }
    if slot.held {
        return;
    }
    drop(slot);

    let edge = match gate.lock() {
        Ok(mut gate) => gate.push_samples(&mono),
        Err(_) => return,
    };
    if edge != VadEdge::SpeechStarted {
        return;
    }
    handle.emit(
        "dictation-vad-signal",
        serde_json::json!({ "signal": "hands_free_start" }),
    );
    // The gate latches well after speech began; mark where it actually did so
    // the hand-off is the user's opening words, not the whole ring.
    if let Ok(mut slot) = tap.lock() {
        if let Some(pre_roll) = slot.pre_roll.as_mut() {
            pre_roll.mark_speech_onset(speech_onset_lookback);
        }
    }
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

// A block may still be queued when an aside ends during a pause. It must
// remain outside the recording even though the tap is already detached.
fn forward_meeting_microphone(
    tap: &MeetingMicTap,
    frames: &[f32],
    paused: bool,
    asides_enabled: bool,
) -> Option<bool> {
    let written = if asides_enabled {
        !paused
    } else {
        !(paused && tap.is_attached())
    };
    let aside = tap.forward(frames, written, false);
    written.then_some(aside)
}

struct AsideMarker;
impl AsideSink for AsideMarker {
    fn push_frames(&self, _frames: &[f32]) {}
    fn source_dropped(&self) {}
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
    /// Set when the OS reports the capture stream has failed — a device
    /// disconnect, a sample-rate invalidation, or any other CoreAudio error.
    /// This used to be logged and nothing else, so an unplugged microphone left
    /// the timer running and the badge lit while nothing reached the WAV. The
    /// stop path reads this so the recording can be reported honestly.
    capture_failure: Arc<std::sync::Mutex<Option<String>>>,
    /// Set when a WAV writer thread returned an error and exited — a full disk,
    /// an IO error, a mismatched aligned chunk.
    ///
    /// A dead writer is silent by construction: the mic-only callback's
    /// `TrySendError::Disconnected` arm discards samples without a word, and the
    /// mixed path just shuts capture down. The overlay kept showing an active
    /// recording either way and the user learned nothing until stop. The meeting
    /// lifecycle loop polls this so the failure surfaces while there is still a
    /// meeting to salvage.
    writer_failure: Arc<std::sync::Mutex<Option<String>>>,
    /// Tracks of a Me + Them meeting that stopped accepting writes while the
    /// others kept recording. Read at stop to save what each track got and to
    /// say which source failed.
    track_write_failures: TrackWriteFailures,
    /// Set while the user has paused the meeting. Both capture paths read it
    /// on every callback or drain and drop the frames instead of forwarding
    /// them, so the streams stay open and resume is instant.
    paused: Arc<AtomicBool>,
    /// Frames actually handed to the WAV writer (paused frames excluded), so a
    /// pause can be placed at its offset in the saved audio.
    recorded_frames: Arc<AtomicU64>,
    pause_ledger: PauseLedger,
    /// Mic-only sessions run the silence watchdog inside the capture callback
    /// and publish whole seconds of inactivity here; mixed sessions publish
    /// through `MixedAudioCapture` instead.
    mic_inactive_seconds: Option<Arc<AtomicU32>>,
    /// Mic-only sessions' live microphone loudness, published by the capture
    /// callback; mixed sessions publish through `MixedAudioCapture`.
    mic_level: Option<Arc<AtomicU32>>,
    /// When frames last started flowing on purpose: activation or resume.
    activity_epoch: Instant,
    /// Offers the microphone frames to a dictation started during the
    /// meeting, and counts the Me track so that aside's span is exact.
    aside_tap: Arc<MeetingMicTap>,
    /// Whether this meeting writes a Me track at all. A system-audio-only
    /// meeting leaves the microphone to an ordinary dictation.
    captures_microphone: bool,
    microphone_device_id: Option<String>,
}

impl ActiveRecordingSession {
    /// Seconds of audio forwarded to the file so far.
    fn recorded_seconds(&self) -> f64 {
        let frames = self.recorded_frames.load(Ordering::Relaxed) as f64;
        frames / f64::from(self.sample_rate.max(1))
    }

    fn pause_snapshot(&self) -> RecordingPauseSnapshot {
        RecordingPauseSnapshot {
            paused: self.pause_ledger.is_paused(),
            closed_paused_ms: self.pause_ledger.closed_paused_ms(),
            pause_started_at_ms: self.pause_ledger.pause_started_at_ms(),
            spans: self.pause_ledger.spans().to_vec(),
        }
    }

    /// How many WAV tracks this session writes concurrently.
    ///
    /// One for a mic-only meeting; three for "me and them" (mixed, mic,
    /// system). The free-space thresholds scale by this, so a mic-only meeting
    /// is not warned and auto-stopped at three times the space it needs.
    fn track_count(&self) -> u64 {
        1 + u64::from(self.mic_audio_path.is_some()) + u64::from(self.system_audio_path.is_some())
    }
}

/// How much of a finished meeting each source actually contributed.
///
/// A starved source is padded with silence so the mixed and per-source WAVs stay
/// frame-aligned, which means the file itself cannot distinguish "nobody spoke"
/// from "the microphone was gone". These counts are the difference, and they are
/// persisted on the recording so the meeting record carries the caveat rather
/// than presenting half-silence as a complete capture.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RecordingSourceDegradation {
    pub mic_silent_seconds: f64,
    pub system_silent_seconds: f64,
    pub captured_seconds: f64,
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
    /// The OS-reported capture failure, if the input stream died mid-recording.
    /// `Some` means audio stopped arriving before the user pressed stop, so the
    /// saved file is shorter than the elapsed session.
    pub capture_failure: Option<String>,
    /// Per-source silence padding for a mixed session; `None` for a mic-only
    /// meeting, which has nothing to pad against.
    pub source_degradation: Option<RecordingSourceDegradation>,
    /// Every pause of this meeting, the last one closed by the stop if it was
    /// still open.
    pub pause_spans: Vec<PauseSpan>,
    /// Every dictation taken from this meeting's microphone, on its Me track.
    pub aside_spans: Vec<AsideSpan>,
    /// Tracks that stopped accepting writes before Stop. What each of them
    /// saved is in `validated_assets` unless it is also unreadable.
    pub failed_tracks: Vec<RecordingAudioRole>,
    /// Failed separate tracks (never the primary) that saved nothing readable.
    /// The caller removes them so the meeting is processed from what was saved.
    pub unreadable_tracks: Vec<RecordingAudioRole>,
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

/// Core Audio's transport type for an input device (`kAudioDevicePropertyTransportType`),
/// looked up by the device UID cpal reports. `None` when the device cannot be
/// matched or Core Audio does not say.
#[cfg(target_os = "macos")]
fn coreaudio_transport_type(device: &cpal::Device) -> Option<&'static str> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::string::CFStringRef;
    use objc2_core_audio::{
        kAudioDevicePropertyTransportType, kAudioDeviceTransportTypeAggregate,
        kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE,
        kAudioDeviceTransportTypeBuiltIn, kAudioDeviceTransportTypeUSB,
        kAudioDeviceTransportTypeVirtual, kAudioHardwarePropertyTranslateUIDToDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress,
    };
    use std::ptr::NonNull;

    let id = device.id().ok()?;
    let uid = CFString::new(id.id());
    let uid_ref: CFStringRef = uid.as_concrete_TypeRef();
    let translate = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut device_id: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    // SAFETY: the qualifier is a live CFStringRef and the output is an
    // AudioObjectID-sized buffer, as the property requires.
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&translate),
            std::mem::size_of::<CFStringRef>() as u32,
            (&uid_ref as *const CFStringRef).cast(),
            NonNull::from(&mut size),
            NonNull::from(&mut device_id).cast(),
        )
    };
    if status != 0 || device_id == 0 {
        return None;
    }
    let transport_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut transport: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: the transport type is a UInt32 property.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&transport_address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut transport).cast(),
        )
    };
    if status != 0 {
        return None;
    }
    if transport == kAudioDeviceTransportTypeBluetooth
        || transport == kAudioDeviceTransportTypeBluetoothLE
    {
        Some("bluetooth")
    } else if transport == kAudioDeviceTransportTypeBuiltIn {
        Some("builtin")
    } else if transport == kAudioDeviceTransportTypeUSB {
        Some("usb")
    } else if transport == kAudioDeviceTransportTypeVirtual
        || transport == kAudioDeviceTransportTypeAggregate
    {
        Some("virtual")
    } else {
        None
    }
}

/// The input's transport: what Core Audio reports when it can be read, else
/// a guess from the device name.
fn device_transport_type(device: &cpal::Device, device_name: &str) -> String {
    #[cfg(target_os = "macos")]
    if let Some(transport) = coreaudio_transport_type(device) {
        return transport.to_string();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = device;
    infer_transport_type(device_name)
}

/// How long to hold the dictation start sound for this input.
///
/// A Bluetooth headset switches profile when its microphone opens, and the
/// switch swallows audio played in the meantime, so a start sound played at
/// once is often never heard. AirPods switch in about 300 ms; other headsets
/// can take over a second. Wired and built-in inputs play it at once.
pub(crate) fn dictation_start_sound_delay_ms(
    transport_type: Option<&str>,
    device_name: &str,
) -> u64 {
    let transport = match transport_type {
        Some(value) if value != "unknown" => value.to_string(),
        _ => infer_transport_type(device_name),
    };
    if transport != "bluetooth" {
        0
    } else if device_name.to_ascii_lowercase().contains("airpods") {
        300
    } else {
        1200
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
    let transport_type = device_transport_type(device, &device_name);
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

fn default_capture_data_directory() -> Option<PathBuf> {
    #[cfg(test)]
    {
        Some(std::env::temp_dir().join(format!("plainsong-capture-tests-{}", std::process::id())))
    }
    #[cfg(not(test))]
    {
        dirs::data_dir()
    }
}

impl AudioCapture {
    pub fn new() -> Self {
        let recordings_dir = crate::paths::directory_with_override(
            "PLAINSONG_DATA_DIR",
            default_capture_data_directory,
        )
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("recordings");

        std::fs::create_dir_all(&recordings_dir).ok();

        let host = cpal::default_host();

        Self {
            is_dictating: Arc::new(AtomicBool::new(false)),
            dictation_buffer: Arc::new(crossbeam::queue::SegQueue::new()),
            dictation_thread: None,
            dictation_sample_rate: 16000,
            dictation_channels: 1,
            recordings_dir,
            host,
            active_recording: None,
            microphone_preparation_stalled: false,
            dictation_audio_level: Arc::new(DictationLevelMeter::default()),
            dictation_callback_count: Arc::new(AtomicU64::new(0)),
            dictation_capture_stop: None,
            dictation_capture_session_id: None,
            dictation_buffered_samples: Arc::new(AtomicU64::new(0)),
            dictation_max_duration_reached: Arc::new(AtomicBool::new(false)),
            dictation_next_max_session_seconds: DICTATION_MAX_SESSION_SECONDS,
            dictation_last_max_session_seconds: DICTATION_MAX_SESSION_SECONDS,
            dictation_partial_buffer: Arc::new(std::sync::Mutex::new(
                DictationPartialBuffer::default(),
            )),
            dictation_streaming_active: Arc::new(AtomicBool::new(false)),
            dictation_vad_gate: Arc::new(std::sync::Mutex::new(None)),
            dictation_vad_session_id: Arc::new(AtomicU64::new(0)),
            dictation_vad_gate_active: Arc::new(AtomicBool::new(false)),
            hands_free_monitor_active: Arc::new(AtomicBool::new(false)),
            hands_free_monitor_thread: None,
            hands_free_monitor_config: None,
            hands_free_tap: Arc::new(std::sync::Mutex::new(HandsFreeTap::default())),
            dictation_first_sample_us: Arc::new(AtomicU64::new(0)),
            dictation_last_callback_us: Arc::new(AtomicU64::new(0)),
            dictation_stream_failed: Arc::new(AtomicBool::new(false)),
            dictation_capture_started_at: None,
            dictation_aside_tap: None,
            dictation_capture_checkpoint: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            dictation_checkpoint_root: None,
        }
    }

    pub fn plan_recording(&self, options: &RecordingOptions) -> Result<RecordingCapturePlan> {
        RecordingCapturePlan::new(&self.recordings_dir, options.mic, options.system_audio)
    }

    /// Refuse to start a meeting on a volume that cannot hold one.
    ///
    /// Running out of space mid-meeting kills the WAV writer thread, and the
    /// capture side is silent about it by construction. Refusing up front is
    /// the only outcome here the user can actually act on, so it is worth one
    /// `statvfs` before any file exists.
    ///
    /// Fails open: a platform or filesystem that cannot report free space must
    /// not block the meeting. An unmeasurable disk is not a full disk.
    fn ensure_recording_start_has_disk_headroom(
        &self,
        plan: &RecordingCapturePlan,
        vault_enabled: bool,
    ) -> Result<()> {
        let Some(directory) = plan.primary_path.parent() else {
            return Ok(());
        };
        let available = match available_space_bytes(directory) {
            Ok(available) => available,
            Err(error) => {
                tracing::warn!(
                    "Could not measure free space for '{}': {}. Starting the meeting anyway.",
                    directory.display(),
                    error
                );
                return Ok(());
            }
        };
        // The plan already knows whether this is a one-track mic-only meeting or
        // a three-track "me and them" bundle, so the requirement is what this
        // meeting will actually write rather than the worst case.
        let track_count = plan.paths().count() as u64;
        let Some(needed) =
            meeting_start_space_shortfall_with_vault_reserve(available, track_count, vault_enabled)
        else {
            return Ok(());
        };
        anyhow::bail!(
            "Not enough free disk space to record a meeting ({} MB free, {} MB needed). Free some space and start again.",
            available / (1024 * 1024),
            needed / (1024 * 1024)
        )
    }

    /// Free bytes on the volume that holds this session's recordings, or `None`
    /// when the platform cannot report it (callers must fail open).
    pub fn recordings_available_space_bytes(&self) -> Option<u64> {
        available_space_bytes(&self.recordings_dir).ok()
    }

    /// What the active session's capture and writer threads have reported.
    ///
    /// `None` when `recording_id` is not the live session, which is also how the
    /// polling loop learns the meeting ended.
    pub fn recording_capture_health(&self, recording_id: &str) -> Option<RecordingCaptureHealth> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        Some(RecordingCaptureHealth {
            writer_failure: session
                .writer_failure
                .lock()
                .ok()
                .and_then(|slot| slot.clone()),
            capture_failure: session
                .capture_failure
                .lock()
                .ok()
                .and_then(|slot| slot.clone()),
            track_count: session.track_count(),
            vault_staging_bytes: meeting_vault_staging_bytes(
                &std::iter::once(&session.audio_path)
                    .chain(session.mic_audio_path.iter())
                    .chain(session.system_audio_path.iter())
                    .filter_map(|path| std::fs::metadata(path).ok())
                    .map(|metadata| metadata.len())
                    .collect::<Vec<_>>(),
            ),
            paused: session.paused.load(Ordering::Relaxed),
            recorded_seconds: session.recorded_seconds(),
            inactivity: match session.mixed_capture.as_ref() {
                Some(mixed) => mixed.source_inactivity(),
                None => SourceInactivity {
                    mic_seconds: session
                        .mic_inactive_seconds
                        .as_ref()
                        .map(|seconds| seconds.load(Ordering::Relaxed) as f32),
                    system_seconds: None,
                },
            },
            seconds_since_activity_epoch: session.activity_epoch.elapsed().as_secs_f32(),
            mixed: session.mixed_capture.is_some(),
        })
    }

    fn active_session_mut(&mut self, recording_id: &str) -> Result<&mut ActiveRecordingSession> {
        let session = self
            .active_recording
            .as_mut()
            .context("No active recording session")?;
        if session.id != recording_id {
            anyhow::bail!(
                "Recording ID mismatch: active={}, requested={}",
                session.id,
                recording_id
            );
        }
        if session.activation.is_some() {
            anyhow::bail!("Recording session has not been activated");
        }
        Ok(session)
    }

    /// Pause the active meeting. The capture streams stay open; every frame
    /// from now until `resume_recording` is dropped before it reaches the
    /// file, the live preview, or the silence watchdogs.
    pub fn pause_recording(&mut self, recording_id: &str) -> Result<RecordingPauseSnapshot> {
        let session = self.active_session_mut(recording_id)?;
        let at_seconds = session.recorded_seconds();
        session
            .pause_ledger
            .pause(unix_now_ms(), at_seconds)
            .map_err(|error| anyhow::anyhow!(error))?;
        session.paused.store(true, Ordering::SeqCst);
        tracing::info!("Recording paused: {} at {:.1}s", recording_id, at_seconds);
        Ok(session.pause_snapshot())
    }

    /// Resume a paused meeting. Frames flow again from the next callback.
    pub fn resume_recording(&mut self, recording_id: &str) -> Result<RecordingPauseSnapshot> {
        let session = self.active_session_mut(recording_id)?;
        let span = session
            .pause_ledger
            .resume(unix_now_ms())
            .map_err(|error| anyhow::anyhow!(error))?;
        session.paused.store(false, Ordering::SeqCst);
        session.activity_epoch = Instant::now();
        tracing::info!(
            "Recording resumed: {} after {}ms",
            recording_id,
            span.duration_ms(0)
        );
        Ok(session.pause_snapshot())
    }

    fn ensure_microphone_preparation_retry_is_safe(
        &self,
        microphone_requested: bool,
    ) -> Result<()> {
        if microphone_requested && self.microphone_preparation_stalled {
            anyhow::bail!(
                "Microphone capture is recovering from a stalled setup attempt. Wait for Plainsong to restart audio capture, then retry."
            );
        }
        Ok(())
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
            let transport_type = device_transport_type(&device, &name);
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
            let transport_type = device_transport_type(&default_device, &name);
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
    /// hands-free monitor's own `hands_free_start` signal. Such a start takes
    /// over the monitor's running stream when it is on the same device (see
    /// `hand_monitor_stream_to_session`), and otherwise seeds a new stream with
    /// the pre-roll. Every other activation path (hotkey, native helper, the
    /// popup's "Start again") means "begin now", and the caller stops the
    /// monitor immediately before calling in — so the ring is always fresh and
    /// the age guard could never reject it. Draining it unconditionally would
    /// splice the seconds *before* the user pressed the key onto the head of
    /// their transcript.
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
        if self.is_recording()
            && self
                .dictation_aside_tap
                .as_ref()
                .and_then(|tap| tap.attached_session())
                != Some(session_id)
        {
            return Err(anyhow::anyhow!(
                "Cannot start dictation while a meeting recording is active"
            ));
        }

        let session_max_seconds = self.activate_dictation_session_limit();

        self.reset_dictation_sample_storage();

        let (device, resolved_device) = self.resolve_input_device(preference)?;

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate();
        let channels = config.channels();
        self.dictation_sample_rate = sample_rate;
        self.dictation_channels = channels;

        tracing::info!(
            "Starting dictation capture on '{}' : {} channels, {} Hz, format: {:?}",
            resolved_device.device_name,
            channels,
            sample_rate,
            config.sample_format()
        );

        let (capture_stop, sink) = self.begin_dictation_capture_session(
            session_id,
            session_max_seconds,
            sample_rate,
            &auto_stop,
            event_handle,
        );

        if self.dictation_aside_tap.is_some() {
            if let Err(error) = self.begin_aside_capture_checkpoint(session_id, sample_rate) {
                self.abort_dictation();
                return Err(anyhow::anyhow!(error));
            }
        }

        if seed_from_pre_roll
            && self.hand_monitor_stream_to_session(&sink, &resolved_device, sample_rate, channels)
        {
            tracing::info!("Dictation took over the hands-free monitor stream");
            return Ok(resolved_device);
        }
        // The monitor and a session must never both hold the microphone.
        self.stop_hands_free_monitor();
        sink.seed(self.resolve_dictation_seed_samples(sample_rate, seed_from_pre_roll));

        // Latched by `guard_audio_callback` if this session's realtime callback
        // ever panics, so the stream goes quiet instead of aborting the process.
        let callback_poisoned = Arc::new(AtomicBool::new(false));
        let callback_count = Arc::clone(&self.dictation_callback_count);
        let (startup_tx, startup_rx) = bounded::<Result<(), String>>(1);

        let capture_handle = std::thread::spawn(move || {
            let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
            let capture_flag = Arc::clone(&capture_stop);
            let device = device;
            let preparation_started_at = std::time::Instant::now();
            tracing::info!(
                session_id,
                stage = "input_config",
                "Dictation microphone preparation started"
            );
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
            let sample_format = config.sample_format();
            let stream_config = config.config();

            macro_rules! build_dictation_stream {
                ($sample_type:ty) => {{
                    let callback_poisoned = Arc::clone(&callback_poisoned);
                    let sink = Arc::clone(&sink);
                    let stream_failed = Arc::clone(&sink.stream_failed);

                    device.build_input_stream(
                        stream_config.clone(),
                        move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                            guard_audio_callback(&callback_poisoned, "Dictation", || {
                                sink.ingest(data, num_channels)
                            });
                        },
                        move |err| {
                            stream_failed.store(true, Ordering::SeqCst);
                            tracing::error!("Dictation stream error: {}", err);
                        },
                        None,
                    )
                }};
            }

            tracing::info!(
                session_id,
                stage = "stream_build",
                elapsed_ms = preparation_started_at.elapsed().as_millis() as u64,
                "Dictation microphone preparation advanced"
            );
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

            tracing::info!(
                session_id,
                stage = "stream_play",
                elapsed_ms = preparation_started_at.elapsed().as_millis() as u64,
                "Dictation microphone preparation advanced"
            );
            if let Err(e) = stream.play() {
                let _ = startup_tx.send(Err(format!(
                    "Failed to start dictation microphone stream: {}",
                    e
                )));
                tracing::error!("Failed to start dictation stream: {}", e);
                return;
            }

            // "Listening" must mean audio is arriving: Bluetooth and some USB
            // devices deliver their first buffer hundreds of milliseconds
            // after play(), and people start talking when the HUD says so.
            // A device that stays silent past the bound still starts; the
            // session then publishes "Listening" when its first sample lands.
            let first_callback_deadline = std::time::Instant::now() + FIRST_CAPTURE_CALLBACK_WAIT;
            while callback_count.load(Ordering::Relaxed) == 0
                && capture_flag.load(Ordering::SeqCst)
                && std::time::Instant::now() < first_callback_deadline
            {
                sink.process_pending();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let _ = startup_tx.send(Ok(()));
            tracing::info!(
                session_id,
                elapsed_ms = preparation_started_at.elapsed().as_millis() as u64,
                "Dictation audio stream started successfully"
            );

            while capture_flag.load(Ordering::SeqCst) {
                sink.process_pending();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }

            tracing::info!("Dictation audio stream stopping");
            drop(stream);
            sink.process_pending();
        });
        self.dictation_thread = Some(capture_handle);

        // Wait for the audio stream to actually start. Core Audio stream
        // construction can stall inside the platform call, so every failure
        // path must retire the worker with a bounded join. An unbounded join
        // here would prevent the command from ever returning its timeout to
        // Electron, leaving the UI stuck on "Getting ready".
        match startup_rx.recv_timeout(MICROPHONE_STREAM_PREPARATION_TIMEOUT) {
            Ok(Ok(())) => {
                tracing::info!("Dictation started (stream confirmed live)");
            }
            Ok(Err(error)) => {
                self.retire_dictation_preparation_thread();
                return Err(anyhow::anyhow!(error));
            }
            Err(RecvTimeoutError::Timeout) => {
                self.retire_dictation_preparation_thread();
                return Err(anyhow::anyhow!(
                    "Timed out waiting for dictation microphone stream to start. Plainsong is restarting audio capture automatically; retry in a moment."
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.retire_dictation_preparation_thread();
                return Err(anyhow::anyhow!(
                    "Dictation microphone stream preparation stopped unexpectedly"
                ));
            }
        }

        Ok(resolved_device)
    }

    /// The per-session state every dictation capture starts from, whichever
    /// stream feeds it: the auto-stop gate, the counters, the session's own
    /// stop flag and the sink its audio goes to.
    fn begin_dictation_capture_session(
        &mut self,
        session_id: u64,
        session_max_seconds: u64,
        sample_rate: u32,
        auto_stop: &DictationAutoStopConfig,
        event_handle: Option<SidecarHandle>,
    ) -> (Arc<AtomicBool>, Arc<DictationCaptureSink>) {
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
        self.dictation_audio_level.reset();
        self.dictation_first_sample_us.store(0, Ordering::SeqCst);
        self.dictation_last_callback_us.store(0, Ordering::SeqCst);
        self.dictation_stream_failed.store(false, Ordering::SeqCst);

        // Per-session stop flag: this session's capture thread and callbacks
        // park/act on this Arc, NOT on the shared `is_dictating`, so a
        // previous session's still-draining thread can never be re-armed by
        // this session setting `is_dictating` back to true.
        let capture_stop = Arc::new(AtomicBool::new(true));
        self.dictation_capture_stop = Some(Arc::clone(&capture_stop));
        self.dictation_capture_session_id = Some(session_id);

        let capture_started_at = std::time::Instant::now();
        self.dictation_capture_started_at = Some(capture_started_at);
        let sink = self.dictation_capture_sink(
            session_id,
            session_max_seconds,
            sample_rate,
            &capture_stop,
            capture_started_at,
            event_handle,
        );
        (capture_stop, sink)
    }

    /// Whether a recording meeting holds the microphone, for the dictation
    /// start route (`meeting_asides::dictation_audio_route`).
    pub(crate) fn meeting_microphone(&self) -> MeetingMicrophone {
        match self.active_recording.as_ref() {
            None => MeetingMicrophone::Idle,
            Some(session) => MeetingMicrophone::Recording {
                captures_microphone: session.captures_microphone,
                stopping: session.aside_tap.is_closed(),
            },
        }
    }

    /// The meeting has begun to stop: refuse new asides. One already running
    /// keeps the meeting's frames until its dictation stops.
    pub(crate) fn refuse_new_meeting_asides(&self) {
        if let Some(session) = self.active_recording.as_ref() {
            session.aside_tap.refuse_new();
        }
    }

    /// The dictation session taking the recording meeting's microphone
    /// frames right now, if any.
    pub(crate) fn meeting_aside_session(&self) -> Option<u64> {
        self.active_recording
            .as_ref()
            .and_then(|session| session.aside_tap.attached_session())
    }

    /// Start a dictation fed by the recording meeting's microphone frames (an
    /// aside) instead of a stream of its own. The session state, the sink and
    /// everything downstream of it are the ones `start_dictation` sets up;
    /// only the source differs, so delivery and fidelity cannot.
    pub(crate) fn start_dictation_aside(
        &mut self,
        session_id: u64,
        auto_stop: DictationAutoStopConfig,
        event_handle: Option<SidecarHandle>,
        preference: Option<&settings::AudioInputDevicePreference>,
        journal: impl FnOnce(&str, &crate::meeting_asides::AsideTicket, u32) -> Result<(), String>,
    ) -> Result<ResolvedAudioInputDevice> {
        if self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Dictation already in progress"));
        }
        let separate_input = if let Some(preference) = preference {
            let (_, resolved) = self.resolve_input_device(Some(preference))?;
            self.active_recording.as_ref().is_some_and(|meeting| {
                meeting.microphone_device_id.as_deref() != Some(&resolved.device_id)
            })
        } else {
            false
        };
        let (tap, sample_rate, recording_id) = match self.active_recording.as_ref() {
            Some(session) if session.captures_microphone => (
                Arc::clone(&session.aside_tap),
                session.sample_rate,
                session.id.clone(),
            ),
            Some(_) => {
                return Err(anyhow::anyhow!(
                    "This meeting does not record the microphone"
                ))
            }
            None => return Err(anyhow::anyhow!("No meeting is recording")),
        };
        if tap.is_closed() {
            return Err(anyhow::anyhow!("The meeting is stopping"));
        }

        if separate_input {
            // Journal and mask the meeting mic before opening a different device.
            let marker = Arc::new(AsideMarker);
            tap.attach_journaled(session_id, sample_rate, marker, unix_now_ms(), |ticket| {
                journal(&recording_id, ticket, sample_rate)
            })
            .map_err(|e| anyhow::anyhow!("Could not save aside: {e:?}"))?;
            self.dictation_aside_tap = Some(Arc::clone(&tap));
            let result =
                self.start_dictation(preference, session_id, auto_stop, event_handle, false);
            if result.is_err() {
                self.detach_dictation_aside(Some(session_id));
            }
            return result;
        }
        let session_max_seconds = self.activate_dictation_session_limit();
        self.reset_dictation_sample_storage();
        // The meeting's worker hands over mono frames at the track rate.
        self.dictation_sample_rate = sample_rate;
        self.dictation_channels = 1;
        tracing::info!(
            "Starting dictation {} from the meeting's microphone at {} Hz",
            session_id,
            sample_rate
        );
        let (_capture_stop, sink) = self.begin_dictation_capture_session(
            session_id,
            session_max_seconds,
            sample_rate,
            &auto_stop,
            event_handle,
        );
        if let Err(error) = self.begin_aside_capture_checkpoint(session_id, sample_rate) {
            self.abort_dictation();
            return Err(anyhow::anyhow!(error));
        }
        let ticket =
            match tap.attach_journaled(session_id, sample_rate, sink, unix_now_ms(), |ticket| {
                journal(&recording_id, ticket, sample_rate)
            }) {
                Ok(ticket) => ticket,
                Err(error) => {
                    self.abort_dictation();
                    return Err(anyhow::anyhow!(
                        "The meeting's microphone is not available to dictation ({error:?})"
                    ));
                }
            };
        tracing::info!(
            "Aside {} attached at Me-track frame {} ({} ms)",
            ticket.aside_id,
            ticket.attached_at_frame,
            ticket.attached_at_ms
        );
        // The stream is the meeting's and stays its: there is no capture
        // thread of the dictation's own to join at stop.
        self.dictation_thread = None;
        self.dictation_aside_tap = Some(tap);
        Ok(ResolvedAudioInputDevice {
            device_id: "meeting-microphone".to_string(),
            device_name: "the meeting's microphone".to_string(),
            transport_type: None,
            is_default: false,
            is_bluetooth_like: false,
            used_fallback: false,
            advisory: None,
        })
    }

    fn begin_aside_capture_checkpoint(&mut self, session_id: u64, rate: u32) -> Result<(), String> {
        #[cfg(not(test))]
        let directory = crate::dictation_checkpoint::dictation_checkpoint_directory()?;
        #[cfg(test)]
        let directory = self
            .dictation_checkpoint_root
            .get_or_insert_with(|| crate::test_fs::TempDir::new("aside-checkpoint"))
            .path()
            .to_owned();
        let checkpoint =
            crate::dictation_checkpoint::CaptureCheckpoint::begin(&directory, session_id, rate)?;
        *self
            .dictation_capture_checkpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(checkpoint);
        Ok(())
    }

    pub(crate) fn capture_checkpoint_completion(
        &self,
        session_id: u64,
    ) -> crate::dictation_checkpoint::CaptureCheckpointCompletion {
        crate::dictation_checkpoint::CaptureCheckpointCompletion::new(
            Arc::clone(&self.dictation_capture_checkpoint),
            session_id,
        )
    }

    /// Remove capture audio only after a durable post-stop checkpoint exists,
    /// or on explicit cancellation. Session ownership prevents stale cleanup.
    pub(crate) fn discard_capture_checkpoint(&mut self, session_id: u64) {
        let mut slot = self
            .dictation_capture_checkpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(checkpoint) = slot.take() {
            *slot = checkpoint.discard(session_id);
        }
    }

    pub(crate) fn meeting_aside_spans(&self) -> Option<(String, Vec<AsideSpan>)> {
        self.active_recording
            .as_ref()
            .map(|session| (session.id.clone(), session.aside_tap.spans()))
    }

    pub(crate) fn is_meeting_aside(&self) -> bool {
        self.dictation_aside_tap.is_some()
    }

    pub(crate) fn aside_tail_clock(&self) -> Option<(Arc<MeetingMicTap>, u64, u64)> {
        if self.dictation_thread.is_some() {
            return None;
        }
        let tap = self.dictation_aside_tap.as_ref()?;
        let rate = self.active_recording.as_ref()?.sample_rate;
        Some((
            Arc::clone(tap),
            tap.forwarded_frames(),
            u64::from(rate) * DICTATION_STOP_CAPTURE_TAIL_MS / 1000,
        ))
    }

    /// End an aside's claim on the meeting's frames, so nothing more reaches
    /// its buffer. Returns the closed span, if the aside wrote any frame.
    fn detach_dictation_aside(&mut self, session_id: Option<u64>) -> Option<AsideSpan> {
        let tap = self.dictation_aside_tap.take()?;
        let span = tap.detach(session_id?, unix_now_ms());
        if let Some(span) = span.as_ref() {
            tracing::info!(
                "Aside {} ended: Me-track frames {}..{:?} at {} Hz",
                span.aside_id,
                span.start_frame,
                span.end_frame,
                span.sample_rate
            );
        }
        span
    }

    // A retired worker may still drain after the bounded join expires. Give
    // each new session its own storage so that drain cannot enter its audio.
    fn reset_dictation_sample_storage(&mut self) {
        self.dictation_capture_checkpoint = Arc::new(std::sync::Mutex::new(None));
        self.dictation_buffer = Arc::new(crossbeam::queue::SegQueue::new());
        self.dictation_buffered_samples = Arc::new(AtomicU64::new(0));
        self.dictation_max_duration_reached = Arc::new(AtomicBool::new(false));
        self.dictation_partial_buffer =
            Arc::new(std::sync::Mutex::new(DictationPartialBuffer::default()));
        self.dictation_audio_level = Arc::new(DictationLevelMeter::default());
    }

    fn dictation_capture_sink(
        &self,
        session_id: u64,
        session_max_seconds: u64,
        sample_rate: u32,
        capture_stop: &Arc<AtomicBool>,
        capture_started_at: Instant,
        event_handle: Option<SidecarHandle>,
    ) -> Arc<DictationCaptureSink> {
        Arc::new(DictationCaptureSink {
            session_id,
            session_max_seconds,
            max_session_samples: u64::from(sample_rate)
                .saturating_mul(session_max_seconds)
                .max(1),
            max_partial_samples: (sample_rate as usize).saturating_mul(30),
            capture_started_at,
            checkpoint: Arc::clone(&self.dictation_capture_checkpoint),
            capture_stop: Arc::clone(capture_stop),
            callback_count: Arc::clone(&self.dictation_callback_count),
            buffer: Arc::clone(&self.dictation_buffer),
            buffered_samples: Arc::clone(&self.dictation_buffered_samples),
            max_duration_reached: Arc::clone(&self.dictation_max_duration_reached),
            audio_level: Arc::clone(&self.dictation_audio_level),
            partial_buffer: Arc::clone(&self.dictation_partial_buffer),
            streaming_active: Arc::clone(&self.dictation_streaming_active),
            vad_gate: Arc::clone(&self.dictation_vad_gate),
            vad_session_id: Arc::clone(&self.dictation_vad_session_id),
            vad_gate_active: Arc::clone(&self.dictation_vad_gate_active),
            first_sample_us: Arc::clone(&self.dictation_first_sample_us),
            last_callback_us: Arc::clone(&self.dictation_last_callback_us),
            stream_failed: Arc::clone(&self.dictation_stream_failed),
            realtime: realtime::RealtimeSamples::new(sample_rate as usize * 2),
            event_handle,
        })
    }

    fn retire_dictation_preparation_thread(&mut self) {
        self.is_dictating.store(false, Ordering::SeqCst);
        self.signal_capture_stop();
        self.dictation_capture_session_id = None;
        if let Some(handle) = self.dictation_thread.take() {
            if let Err(error) = join_thread_with_timeout(
                handle,
                Duration::from_millis(250),
                "dictation microphone preparation thread",
            ) {
                tracing::warn!("{}", error);
            }
        }
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
        let mut slot = match self.hands_free_tap.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(pre_roll) = slot.pre_roll.as_mut() else {
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
        let mut slot = match self.hands_free_tap.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        slot.pre_roll = None;
    }

    /// Hand the running hands-free monitor stream to a starting session instead
    /// of closing it and opening another: a reopen costs a stream build plus
    /// the device's first-buffer latency while the user is mid-sentence. The
    /// pre-roll is moved into the session buffer and the stream's callbacks
    /// switch to the session under the same lock, so nothing between them is
    /// dropped or duplicated, and no staleness guard is needed.
    ///
    /// Returns false, changing nothing, unless the monitor is live on the
    /// device and format this session would otherwise have opened.
    fn hand_monitor_stream_to_session(
        &mut self,
        sink: &Arc<DictationCaptureSink>,
        device: &ResolvedAudioInputDevice,
        sample_rate: u32,
        channels: u16,
    ) -> bool {
        {
            let mut tap = match self.hands_free_tap.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            // Checked under the tap lock, which the monitor's error callback
            // also takes, so a stream that just died is never handed over.
            if !self.hands_free_monitor_active.load(Ordering::SeqCst)
                || tap.session.is_some()
                || tap.device_id != device.device_id
                || tap.sample_rate != sample_rate
                || tap.channels != channels
            {
                return false;
            }
            sink.seed(
                tap.pre_roll
                    .take()
                    .map(|mut pre_roll| pre_roll.take())
                    .unwrap_or_default(),
            );
            tap.input_session_id
                .store(sink.session_id, Ordering::SeqCst);
            tap.session = Some(Arc::clone(sink));
        }
        // The thread now lives as long as the session's capture, not the monitor.
        self.hands_free_monitor_active
            .store(false, Ordering::SeqCst);
        self.hands_free_monitor_config = None;
        self.dictation_thread = self.hands_free_monitor_thread.take();
        true
    }

    /// Stop (or resume) the monitor's start detection while it keeps filling
    /// the pre-roll. Held while a start it signalled is in flight, so a second
    /// burst of speech cannot move the onset mark past the user's first words.
    pub fn hold_hands_free_monitor(&self, held: bool) {
        if let Ok(mut tap) = self.hands_free_tap.lock() {
            tap.held = held;
        }
    }

    /// The flag behind `dictation_first_sample_latency_ms`: non-zero once the
    /// current session's first sample has arrived. Cloned out so the start
    /// path can wait for it without holding the capture lock.
    pub fn dictation_first_sample_handle(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.dictation_first_sample_us)
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

    /// Ends capture and returns the encoded WAV.
    ///
    /// The caller is responsible for having already waited
    /// `DICTATION_STOP_CAPTURE_TAIL_MS` so the speaker's final consonant is
    /// captured; see that constant for why the wait does not live here.
    pub fn stop_dictation(&mut self) -> Result<Vec<u8>> {
        if !self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("No dictation in progress"));
        }

        tracing::info!("Stopping dictation capture...");
        // An aside stops taking the meeting's frames first, under the tap's
        // lock, so no block can reach the buffer while it is being drained.
        self.detach_dictation_aside(self.dictation_capture_session_id);
        self.is_dictating.store(false, Ordering::SeqCst);
        self.signal_capture_stop();
        self.dictation_capture_session_id = None;
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
                self.dictation_stream_failed.store(true, Ordering::SeqCst);
                tracing::warn!(
                    "Timed out waiting for dictation capture thread to join; continuing stop path"
                );
            }
        }

        let mut samples = Vec::new();
        while let Some(sample) = self.dictation_buffer.pop() {
            samples.push(sample);
        }
        self.dictation_buffered_samples.store(0, Ordering::SeqCst);

        // The partial buffer is UI-only and never contributes to `samples`.
        // Stop streaming and release its memory now that capture has ended.
        self.dictation_streaming_active
            .store(false, Ordering::SeqCst);
        if let Ok(mut partial) = self.dictation_partial_buffer.lock() {
            partial.samples.clear();
            partial.total_samples = 0;
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

        // No noise suppression before recognition. A noise gate here once cut
        // soft consonants and word endings by 70%. On 2026-10-20 a spectral
        // denoiser in front of Parakeet lowered word errors under steady hiss
        // (18.3% -> 12.8%) but raised them with background voices
        // (12.8% -> 15.6%); the recognizer handles mixed noise better alone.
        let wav_data = encode_dictation_recognition_wav(&mut samples, self.dictation_sample_rate)?;

        tracing::info!(
            "Dictation stopped: {} mono samples at {} Hz (after processing)",
            samples.len(),
            self.dictation_sample_rate
        );

        tracing::info!("WAV data size: {} bytes", wav_data.len());

        Ok(wav_data)
    }

    pub fn stop_dictation_for_session(&mut self, expected_session_id: u64) -> Result<Vec<u8>> {
        if self.dictation_capture_session_id != Some(expected_session_id) {
            return Err(anyhow::anyhow!(
                "Dictation audio session {} is no longer active",
                expected_session_id
            ));
        }
        self.stop_dictation()
    }

    pub fn abort_dictation(&mut self) {
        if let Some(session_id) = self.dictation_capture_session_id {
            self.discard_capture_checkpoint(session_id);
        }
        self.detach_dictation_aside(self.dictation_capture_session_id);
        self.dictation_capture_session_id = None;
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
        self.dictation_buffered_samples.store(0, Ordering::SeqCst);
        self.dictation_max_duration_reached
            .store(false, Ordering::SeqCst);
        if let Ok(mut partial) = self.dictation_partial_buffer.lock() {
            partial.samples.clear();
            partial.total_samples = 0;
        }
    }

    /// Abort only when the caller still owns the live capture. Returns false
    /// for stale cleanup so a replacement session remains untouched.
    pub fn abort_dictation_for_session(&mut self, expected_session_id: u64) -> bool {
        self.discard_capture_checkpoint(expected_session_id);
        if self.dictation_capture_session_id != Some(expected_session_id) {
            return false;
        }
        self.abort_dictation();
        true
    }

    /// Whether the session that just ended was cut short by the maximum-length
    /// ceiling. Read after `stop_dictation` so the caller can tell the user the
    /// recording was truncated rather than presenting it as complete.
    pub fn dictation_hit_max_duration(&self) -> bool {
        self.dictation_max_duration_reached.load(Ordering::SeqCst)
    }

    /// Whether the microphone failed or stopped delivering audio before the
    /// session ended. Call before stopping capture, while callbacks still run.
    pub fn dictation_capture_interrupted(&self) -> bool {
        let Some(started_at) = self.dictation_capture_started_at else {
            return false;
        };
        if !self.is_dictating.load(Ordering::SeqCst) {
            return self.dictation_stream_failed.load(Ordering::SeqCst);
        }
        capture_interrupted(
            self.dictation_stream_failed.load(Ordering::SeqCst),
            self.dictation_callback_count.load(Ordering::SeqCst),
            self.dictation_last_callback_us.load(Ordering::SeqCst),
            started_at.elapsed(),
        )
    }

    pub fn set_next_dictation_max_session_seconds(&mut self, seconds: u64) {
        self.dictation_next_max_session_seconds = seconds.max(1);
    }

    fn activate_dictation_session_limit(&mut self) -> u64 {
        let limit = self.dictation_next_max_session_seconds.max(1);
        self.dictation_last_max_session_seconds = limit;
        self.dictation_next_max_session_seconds = DICTATION_MAX_SESSION_SECONDS;
        limit
    }

    pub fn dictation_last_max_session_seconds(&self) -> u64 {
        self.dictation_last_max_session_seconds
    }

    /// Longest single dictation session, in seconds, before capture is stopped.
    pub fn dictation_max_session_seconds() -> u64 {
        DICTATION_MAX_SESSION_SECONDS
    }

    /// Get the current audio level for dictation (0.0 to 1.0)
    /// Uses power scaling to make normal speech levels more visible
    pub fn get_dictation_audio_level(&self) -> f32 {
        let raw = self.dictation_audio_level.read();
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
        preferred_input_device: Option<&settings::AudioInputDevicePreference>,
        event_handle: Option<SidecarHandle>,
        vault_enabled: bool,
    ) -> Result<PreparedMeetingRecording> {
        self.ensure_microphone_preparation_retry_is_safe(options.mic)?;
        if self.active_recording.is_some() {
            return Err(anyhow::anyhow!("A recording session is already active"));
        }
        if self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!(
                "Cannot start recording while dictation is active"
            ));
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

        self.ensure_recording_start_has_disk_headroom(&plan, vault_enabled)?;

        let id = plan.recording_id.clone();
        let audio_path = plan.primary_path.clone();
        let mic_audio_path = plan.mic_path.clone();
        let system_audio_path = plan.system_path.clone();
        let writer_failure: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        let track_write_failures: TrackWriteFailures = Arc::new(std::sync::Mutex::new(Vec::new()));
        // One slot for both capture paths. The mixed path used to build its own
        // and never write it, so only a mic-only meeting could report an input
        // stream that died mid-session.
        let capture_failure: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        let waveform_buffer = Arc::new(std::sync::Mutex::new(Vec::with_capacity(4410)));
        let streaming_queue: Arc<crossbeam::queue::ArrayQueue<Vec<f32>>> =
            Arc::new(crossbeam::queue::ArrayQueue::new(256));
        let paused = Arc::new(AtomicBool::new(false));
        let recorded_frames = Arc::new(AtomicU64::new(0));
        let aside_tap = Arc::new(MeetingMicTap::default());
        let mut microphone_input = None;
        let mut microphone_device_id = None;
        let preferred_mic_device = if options.mic {
            let (device, resolved_input) = match preferred_input_device {
                Some(preference) => self.resolve_input_device(Some(preference))?,
                None => {
                    self.resolve_input_device_by_id(options.preferred_input_device_id.as_deref())?
                }
            };
            if let (Some(handle), Some(advisory)) =
                (event_handle.as_ref(), resolved_input.advisory.as_deref())
            {
                handle.emit_event("audio-input-advisory", advisory.to_string());
            }
            microphone_device_id = Some(resolved_input.device_id.clone());
            microphone_input = Some(MeetingMicrophoneInput::from_resolved(
                &resolved_input,
                preferred_input_device.map(|preference| preference.device_name.as_str()),
            ));
            Some(device)
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
                    Arc::clone(&capture_failure),
                    event_handle.map(|handle| MixedCaptureEvents {
                        handle,
                        recording_id: id.clone(),
                    }),
                    Arc::clone(&paused),
                    Arc::clone(&recorded_frames),
                    Arc::clone(&aside_tap),
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
            let writer_failure_for_thread = Arc::clone(&writer_failure);
            let track_failures_for_thread = Arc::clone(&track_write_failures);
            let writer_handle = std::thread::spawn(move || {
                let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
                run_wav_writer_thread(writer_failure_for_thread, || {
                    write_aligned_wav_files(
                        prepared_writers,
                        writer_receiver,
                        &writer_log_path,
                        &track_failures_for_thread,
                    )
                })
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
                capture_failure,
                writer_failure,
                track_write_failures: Arc::clone(&track_write_failures),
                paused,
                recorded_frames,
                pause_ledger: PauseLedger::default(),
                mic_inactive_seconds: None,
                mic_level: None,
                activity_epoch: Instant::now(),
                aside_tap: Arc::clone(&aside_tap),
                microphone_device_id: microphone_device_id.clone(),
                captures_microphone: options.mic,
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
            let writer_failure_for_thread = Arc::clone(&writer_failure);
            let writer_handle = std::thread::spawn(move || {
                let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
                run_wav_writer_thread(writer_failure_for_thread, || {
                    write_wav_file(prepared_writer, samples_receiver, &writer_log_path)
                })
            });

            let capture_stop_flag = Arc::new(AtomicBool::new(true));
            let capture_flag = Arc::clone(&capture_stop_flag);
            // Latched if this recording's realtime callback ever panics, so the
            // stream goes inert instead of aborting the process mid-meeting.
            let callback_poisoned = Arc::new(AtomicBool::new(false));
            let dropped_stream_chunks = Arc::new(AtomicU64::new(0));
            let dropped_writer_chunks = Arc::new(AtomicU64::new(0));
            let dropped_stream_chunks_for_session = Arc::clone(&dropped_stream_chunks);
            let dropped_writer_chunks_for_session = Arc::clone(&dropped_writer_chunks);
            let capture_failure_for_stream = Arc::clone(&capture_failure);
            let capture_failure_for_session = Arc::clone(&capture_failure);
            let wf_buffer = Arc::clone(&waveform_buffer);
            let stream_queue_clone = Arc::clone(&streaming_queue);
            let paused_for_callback = Arc::clone(&paused);
            let recorded_frames_for_callback = Arc::clone(&recorded_frames);
            let mic_inactive_seconds = Arc::new(AtomicU32::new(0));
            let mic_inactive_for_callback = Arc::clone(&mic_inactive_seconds);
            let mic_level = Arc::new(AtomicU32::new(0));
            let mic_level_for_callback = Arc::clone(&mic_level);
            let aside_tap_for_capture = Arc::clone(&aside_tap);
            let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);
            let (activation_tx, activation_rx) = bounded::<()>(1);
            let (activated_tx, activated_rx) = bounded::<Result<(), String>>(1);

            let capture_handle = std::thread::spawn(move || {
                let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
                let realtime = Arc::new(realtime::RealtimeSamples::new(sample_rate as usize * 2));
                let mut pending = Vec::new();
                let mut watchdog = SourceSilenceWatchdog::new(sample_rate, &MIC_SILENCE_PROFILE);
                let mut level_meter = system_capture::SourceLevelMeter::new(
                    sample_rate,
                    Arc::clone(&mic_level_for_callback),
                );
                let mut process_pending = || {
                    realtime.drain(&mut pending);
                    let dropped = realtime.take_dropped();
                    if dropped > 0 {
                        tracing::warn!(
                            dropped_samples = dropped,
                            "Meeting capture worker fell behind"
                        );
                    }
                    if pending.is_empty() {
                        return;
                    }
                    // Without an aside the callback keeps paused frames out,
                    // so every drained frame is written. An aside keeps the
                    // callback forwarding through a pause, and then only the
                    // aside takes them.
                    let Some(aside) = forward_meeting_microphone(
                        &aside_tap_for_capture,
                        &pending,
                        paused_for_callback.load(Ordering::Relaxed),
                        crate::meeting_asides::MEETING_ASIDES_ENABLED,
                    ) else {
                        return;
                    };
                    let chunk = pending.clone();
                    watchdog.observe(&chunk, 0);
                    level_meter.observe(&chunk);
                    mic_inactive_for_callback
                        .store(watchdog.inactive_seconds() as u32, Ordering::Relaxed);
                    recorded_frames_for_callback.fetch_add(chunk.len() as u64, Ordering::Relaxed);

                    if let Ok(mut waveform) = wf_buffer.lock() {
                        for &sample in chunk.iter().step_by(chunk.len() / 100 + 1).take(100) {
                            waveform.push(sample);
                        }
                        if waveform.len() > 4410 {
                            let drop_count = waveform.len() - 4410;
                            waveform.drain(0..drop_count);
                        }
                    }

                    // The live transcript hears silence where a dictation
                    // took the frames.
                    let live = if aside {
                        vec![0.0; chunk.len()]
                    } else {
                        chunk.clone()
                    };
                    if stream_queue_clone.force_push(live).is_some() {
                        dropped_stream_chunks.fetch_add(1, Ordering::Relaxed);
                    }

                    let chunk_frames = chunk.len() as u64;
                    match samples_sender.try_send(chunk) {
                        Ok(()) => {
                            aside_tap_for_capture.writer_accepted(chunk_frames);
                        }
                        Err(TrySendError::Full(chunk)) => {
                            dropped_writer_chunks.fetch_add(1, Ordering::Relaxed);
                            aside_tap_for_capture.writer_dropped(chunk.len() as u64);
                        }
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                };
                macro_rules! build_recording_stream {
                    ($sample_type:ty) => {{
                        let callback_poisoned = Arc::clone(&callback_poisoned);
                        let realtime = Arc::clone(&realtime);
                        let paused = Arc::clone(&paused_for_callback);
                        let aside_tap = Arc::clone(&aside_tap_for_capture);
                        let dropped = Arc::clone(&dropped_writer_chunks);
                        device.build_input_stream(
                            stream_config.clone(),
                            move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                guard_audio_callback(&callback_poisoned, "Recording", || {
                                    if (!paused.load(Ordering::Relaxed) || aside_tap.is_attached())
                                        && realtime.push(data, num_channels) > 0
                                    {
                                        dropped.fetch_add(1, Ordering::Relaxed);
                                    }
                                });
                            },
                            {
                                let capture_failure = Arc::clone(&capture_failure_for_stream);
                                move |error| {
                                    // Record as well as log: a device
                                    // disconnect or sample-rate invalidation
                                    // stops delivering callbacks, and without
                                    // this the session had no way to know the
                                    // microphone had gone away.
                                    tracing::error!("Stream error: {}", error);
                                    if let Ok(mut slot) = capture_failure.lock() {
                                        if slot.is_none() {
                                            *slot = Some(error.to_string());
                                        }
                                    }
                                }
                            },
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
                    process_pending();
                    std::thread::sleep(Duration::from_millis(5));
                }
                drop(stream);
                process_pending();

                let dropped_stream = dropped_stream_chunks.load(Ordering::Relaxed);
                let dropped_writer = dropped_writer_chunks.load(Ordering::Relaxed);
                if dropped_stream > 0 || dropped_writer > 0 {
                    tracing::warn!(
                        "Microphone capture dropped stream/writer chunks (stream={}, writer={})",
                        dropped_stream,
                        dropped_writer
                    );
                }
            });

            match ready_rx.recv_timeout(MICROPHONE_STREAM_PREPARATION_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    retire_recording_preparation_threads(
                        &capture_stop_flag,
                        capture_handle,
                        writer_handle,
                    );
                    return Err(anyhow::anyhow!(error));
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.microphone_preparation_stalled = true;
                    retire_recording_preparation_threads(
                        &capture_stop_flag,
                        capture_handle,
                        writer_handle,
                    );
                    return Err(anyhow::anyhow!(
                        "Timed out waiting for microphone stream preparation. Plainsong is restarting audio capture automatically; retry in a moment."
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    retire_recording_preparation_threads(
                        &capture_stop_flag,
                        capture_handle,
                        writer_handle,
                    );
                    return Err(anyhow::anyhow!(
                        "Microphone stream preparation stopped unexpectedly"
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
                capture_failure: capture_failure_for_session,
                writer_failure,
                track_write_failures: Arc::clone(&track_write_failures),
                paused,
                recorded_frames,
                pause_ledger: PauseLedger::default(),
                mic_inactive_seconds: Some(mic_inactive_seconds),
                mic_level: Some(mic_level),
                activity_epoch: Instant::now(),
                aside_tap,
                microphone_device_id: microphone_device_id.clone(),
                captures_microphone: true,
            });
        }

        tracing::info!("Recording prepared: {}", id);
        Ok(PreparedMeetingRecording {
            recording_id: id,
            microphone_input,
        })
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

        if let Some(session) = self.active_recording.as_mut() {
            session.activity_epoch = Instant::now();
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
            if let Err(error) = join_thread_with_timeout(
                handle,
                Duration::from_secs(1),
                "prepared microphone capture thread",
            ) {
                tracing::warn!("{}", error);
            }
        }
        session.aside_tap.close(unix_now_ms());
        for handle in session.writer_handles.drain(..) {
            if let Err(error) = join_writer_with_timeout(
                handle,
                Duration::from_secs(1),
                "prepared microphone writer thread",
            ) {
                tracing::warn!("{}", error);
            }
        }
    }

    pub(crate) fn abort_recording_if_matches(&mut self, recording_id: &str) -> bool {
        if self
            .active_recording
            .as_ref()
            .is_none_or(|session| session.id != recording_id)
        {
            return false;
        }
        self.abort_prepared_recording();
        true
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

        // Stopping while paused finalizes normally: the open pause closes at
        // the stop, and `paused` is deliberately left set so the frames that
        // arrive while the streams wind down go the same way as the rest of
        // the pause — nowhere.
        if let Some(span) = session.pause_ledger.close_open(unix_now_ms()) {
            tracing::info!(
                "Recording {} stopped while paused; closing a {}ms pause",
                recording_id,
                span.duration_ms(0)
            );
        }
        let pause_spans = session.pause_ledger.spans().to_vec();
        session.capture_stop_flag.store(false, Ordering::SeqCst);

        if let Some(handle) = session.capture_handle.take() {
            join_thread_with_timeout(handle, Duration::from_secs(5), "capture thread")?;
        }
        let mut dropped_mic_samples = 0_u64;
        let mut dropped_system_samples = 0_u64;
        let mut dropped_mixed_chunks = 0_u64;
        let mut source_degradation = None;
        if let Some(mut mixed_capture) = session.mixed_capture.take() {
            mixed_capture.stop();
            let outcome = mixed_capture.outcome();
            dropped_mic_samples = outcome.dropped_mic_samples;
            dropped_system_samples = outcome.dropped_system_samples;
            dropped_mixed_chunks = outcome.dropped_mixed_chunks;
            source_degradation = Some(source_degradation_from_outcome(
                &outcome,
                session.sample_rate,
            ));
        }
        // Every frame the streams delivered has been forwarded by now, so an
        // aside whose dictation did not finish first ends at the last one.
        if let Some(session_id) = session.aside_tap.close(unix_now_ms()) {
            tracing::warn!(
                "Recording {} stopped before dictation {} finished; its capture ends here",
                recording_id,
                session_id
            );
        }
        let aside_spans = session.aside_tap.spans();

        // A writer that is still running after the timeout may still be
        // appending, so its files cannot be judged; that stays a stop failure.
        // A writer that finished with an error has left whatever it saved on
        // disk, and that is kept below rather than failing the meeting.
        let mut writer_thread_failure = None;
        for handle in session.writer_handles.drain(..) {
            if let Some(error) =
                join_finished_writer(handle, Duration::from_secs(20), "wav writer thread")?
            {
                writer_thread_failure.get_or_insert(error);
            }
        }
        let track_write_failures = session
            .track_write_failures
            .lock()
            .map(|slot| slot.clone())
            .unwrap_or_default();

        let capture_failure = session
            .capture_failure
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(reason) = capture_failure.as_deref() {
            tracing::error!(
                "Recording {} lost its capture stream before stop: {}",
                recording_id,
                reason
            );
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

        let planned_tracks: Vec<(RecordingAudioRole, &Path)> = [
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
        .collect();
        let failed_tracks = failed_track_roles(
            &planned_tracks
                .iter()
                .map(|(role, _)| *role)
                .collect::<Vec<_>>(),
            &track_write_failures,
            writer_thread_failure.is_some(),
        );
        if let Some(error) = writer_thread_failure.as_deref() {
            tracing::error!(
                "Recording '{}' writer stopped before Stop; keeping what it saved: {}",
                recording_id,
                error
            );
        }

        let mut validated_assets = Vec::new();
        let mut unreadable_tracks = Vec::new();
        for (role, asset_path) in planned_tracks {
            sync_file(asset_path)?;
            let failed = failed_tracks.contains(&role);
            if failed {
                // The writer stopped without stamping a final header, so the
                // header may describe less audio than the file holds.
                if let Err(error) = repair_plaintext_wav_header(asset_path) {
                    tracing::warn!(
                        "Could not repair the {} track header of '{}': {:#}",
                        role.as_str(),
                        recording_id,
                        error
                    );
                }
            }
            match validate_plaintext_wav(asset_path) {
                RecordingAudioValidation::Ready(metadata) => {
                    validated_assets.push((role, metadata));
                }
                RecordingAudioValidation::Missing(error)
                | RecordingAudioValidation::Failed(error)
                    if failed && role != RecordingAudioRole::Primary =>
                {
                    // A separate track that failed before saving anything
                    // readable. The combined recording still holds that side.
                    tracing::warn!(
                        "Recording '{}' {} track saved nothing readable: {}",
                        recording_id,
                        role.as_str(),
                        error
                    );
                    unreadable_tracks.push(role);
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
            capture_failure,
            source_degradation,
            pause_spans,
            aside_spans,
            failed_tracks,
            unreadable_tracks,
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

    /// The live loudness of each source of the active meeting, for the
    /// meeting window's "You" and "Meeting audio" meters.
    pub fn get_meeting_source_levels(
        &self,
        recording_id: &str,
    ) -> Option<system_capture::SourceLevels> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        Some(match session.mixed_capture.as_ref() {
            Some(mixed) => mixed.source_levels(),
            None => system_capture::SourceLevels {
                mic: session
                    .mic_level
                    .as_deref()
                    .map(system_capture::read_source_level),
                system: None,
                system_unverified: false,
            },
        })
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
    pub(crate) fn dictation_partial_buffer_handle(
        &self,
    ) -> Arc<std::sync::Mutex<DictationPartialBuffer>> {
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
    /// start-dictation path. While it monitors it never appends to `dictation_buffer` (it
    /// fills a bounded pre-roll ring instead) and never touches `is_dictating`; a
    /// hands-free-triggered `start_dictation` may take its stream over (see
    /// `hand_monitor_stream_to_session`). It never itself calls into `start_dictation` — it
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
    /// No-op (returns `Ok(())`) if the monitor is already running, a dictation session is
    /// currently active, or a meeting owns the capture device.
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
        if self.is_dictating.load(Ordering::SeqCst) || self.is_recording() {
            // A real dictation or meeting session owns listening duties right now;
            // reconciliation restarts the monitor once capture ends.
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

        let (device, resolved_device) = self.resolve_input_device(preference)?;
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

        // A fresh tap and pre-roll ring per monitor run, sized for this
        // stream's sample rate. `start_dictation` drains the ring, so the words
        // spoken while the gate was still deciding "that's speech" survive the
        // hand-off instead of being downmixed and dropped.
        let input_session_id = Arc::new(AtomicU64::new(0));
        let tap = Arc::new(std::sync::Mutex::new(HandsFreeTap {
            input_session_id: Arc::clone(&input_session_id),
            pre_roll: Some(PreRollBuffer::new(sample_rate, PRE_ROLL_SECONDS)),
            device_id: resolved_device.device_id,
            sample_rate,
            channels: config.channels(),
            ..HandsFreeTap::default()
        }));
        self.hands_free_tap = Arc::clone(&tap);

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

        let monitor_failed = Arc::clone(&self.dictation_stream_failed);
        let active_session_id = Arc::clone(&self.dictation_vad_session_id);
        let is_dictating = Arc::clone(&self.is_dictating);
        let capture_handle = std::thread::spawn(move || {
            let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
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

            // Latched if this monitor's realtime callback ever panics, so it
            // goes inert instead of aborting the process.
            let callback_poisoned = Arc::new(AtomicBool::new(false));
            let sample_format = config.sample_format();
            let stream_config = config.config();

            let realtime = Arc::new(realtime::RealtimeSamples::new(sample_rate as usize * 2));
            macro_rules! build_hands_free_stream {
                ($sample_type:ty) => {{
                    let realtime = Arc::clone(&realtime);
                    let monitor_failed = Arc::clone(&monitor_failed);
                    let input_session_id = Arc::clone(&input_session_id);
                    let active_session_id = Arc::clone(&active_session_id);
                    let is_dictating = Arc::clone(&is_dictating);
                    let monitoring = Arc::clone(&monitor_active);
                    let callback_poisoned = Arc::clone(&callback_poisoned);
                    let err_active = Arc::clone(&monitor_active);
                    let err_tap = Arc::clone(&tap);

                    device.build_input_stream(
                        stream_config.clone(),
                        move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                            guard_audio_callback(&callback_poisoned, "Hands-free monitor", || {
                                if !monitor_accepts_audio(
                                    monitoring.load(Ordering::SeqCst),
                                    is_dictating.load(Ordering::SeqCst),
                                    input_session_id.load(Ordering::SeqCst),
                                    active_session_id.load(Ordering::SeqCst),
                                ) {
                                    return;
                                }
                                if realtime.push(data, num_channels) > 0 {
                                    monitor_failed.store(true, Ordering::SeqCst);
                                }
                            });
                        },
                        move |err| {
                            tracing::error!("Hands-free monitor stream error: {}", err);
                            let tap = match err_tap.lock() {
                                Ok(guard) => guard,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                            match tap.session.as_ref() {
                                Some(session) => {
                                    session.stream_failed.store(true, Ordering::SeqCst)
                                }
                                None => err_active.store(false, Ordering::SeqCst),
                            }
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

            // A hand-off installs the session before it clears the monitor
            // flag, so the stream stays open across the switch.
            let mut pending = Vec::new();
            while monitor_active.load(Ordering::SeqCst)
                || tap.lock().is_ok_and(|tap| tap.session_running())
            {
                realtime.drain(&mut pending);
                if !pending.is_empty() {
                    feed_hands_free_monitor(
                        &pending,
                        1,
                        &tap,
                        &monitor_active,
                        &gate,
                        &event_handle,
                        speech_onset_lookback,
                    );
                }
                let dropped = realtime.take_dropped();
                if dropped > 0 {
                    if let Ok(slot) = tap.lock() {
                        if let Some(session) = &slot.session {
                            session.stream_failed.store(true, Ordering::SeqCst);
                        }
                    }
                    tracing::warn!(
                        dropped_samples = dropped,
                        "Hands-free capture worker fell behind"
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }

            tracing::info!("Hands-free idle monitor stream stopping");
            drop(stream);
            realtime.drain(&mut pending);
            if let Ok(slot) = tap.lock() {
                if let Some(session) = &slot.session {
                    session.process_samples(&pending, 1);
                    session.process_pending();
                }
            }
        });

        self.hands_free_monitor_thread = Some(capture_handle);

        match startup_rx.recv_timeout(MICROPHONE_STREAM_PREPARATION_TIMEOUT) {
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

/// The whole transform from captured dictation samples to the WAV the final
/// decode reads. Loudness gain is measured over the entire capture, so every
/// output sample depends on audio that arrives after it.
pub(crate) fn encode_dictation_recognition_wav(
    samples: &mut Vec<f32>,
    sample_rate: u32,
) -> Result<Vec<u8>> {
    normalize_dictation_loudness(samples, sample_rate);
    ensure_min_duration(samples, sample_rate, 0.7);
    encode_wav(samples, sample_rate, 1)
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

#[cfg(test)]
#[path = "audio_meeting_durability_tests.rs"]
mod meeting_durability_tests;

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
    // The mono 16-bit writer uses a 32-bit RIFF size, including 36 header bytes.
    let resulting_samples = u64::from(writer.len()).saturating_add(samples.len() as u64);
    if resulting_samples > u64::from((u32::MAX - 36) / 2) {
        anyhow::bail!("This recording reached the audio file size limit. Earlier audio is kept.");
    }
    boost_quiet_audio(&mut samples);
    for sample in samples {
        writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)?;
    }
    Ok(())
}

/// One track of a Me + Them meeting whose file stopped accepting writes while
/// the other tracks kept recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrackWriteFailure {
    pub role: RecordingAudioRole,
    pub error: String,
}

type TrackWriteFailures = Arc<std::sync::Mutex<Vec<TrackWriteFailure>>>;

/// One aligned meeting track and whether it can still be written.
///
/// A Me + Them meeting writes three files from one thread. Before this, an
/// error on any of them ended the thread, so a failing microphone file also
/// stopped the combined recording and the meeting audio, and Stop then failed
/// the whole meeting. A track that fails is now closed on its own, with its
/// header stamped where it stopped, and the others keep recording.
struct AlignedTrack {
    role: RecordingAudioRole,
    writer: Option<MeetingWavWriter>,
}

impl AlignedTrack {
    fn fail(&mut self, error: anyhow::Error, failures: &TrackWriteFailures) {
        // Dropping the writer stamps the header over what reached the file,
        // best effort; the stop path repairs it from the file length anyway.
        drop(self.writer.take());
        tracing::error!(
            "Meeting {} track stopped saving: {error:#}",
            self.role.as_str()
        );
        if let Ok(mut slot) = failures.lock() {
            slot.push(TrackWriteFailure {
                role: self.role,
                error: format!("{error:#}"),
            });
        }
    }

    fn write(&mut self, samples: Vec<f32>, failures: &TrackWriteFailures) {
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        if let Err(error) = write_wav_samples(writer, samples) {
            self.fail(error, failures);
        }
    }

    fn checkpoint(&mut self, failures: &TrackWriteFailures) {
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        if let Err(error) = writer.flush() {
            self.fail(error.into(), failures);
        }
    }

    fn finish(&mut self, failures: &TrackWriteFailures) {
        let Some(writer) = self.writer.take() else {
            return;
        };
        if let Err(error) = writer.finalize() {
            self.fail(error.into(), failures);
        }
    }
}

fn first_track_failure(failures: &TrackWriteFailures) -> String {
    failures
        .lock()
        .ok()
        .and_then(|slot| slot.first().map(|failure| failure.error.clone()))
        .unwrap_or_else(|| "unknown error".to_string())
}

/// How long a writer waits for the next chunk before checking whether a
/// checkpoint is due anyway. While the meeting is paused no chunk arrives at
/// all, and a writer that only checkpointed on arrival would leave the last
/// seconds before the pause unflushed for the whole of it.
const WAV_WRITER_IDLE_POLL: Duration = Duration::from_secs(1);

/// How often a live WAV's header and buffered samples are pushed to disk.
const WAV_WRITER_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5);

fn write_aligned_wav_files(
    writers: PreparedAlignedWavWriters,
    receiver: Receiver<MixedAudioChunk>,
    log_path: &Path,
    failures: &TrackWriteFailures,
) -> Result<()> {
    let PreparedAlignedWavWriters { mixed, mic, system } = writers;
    let expects_mic = mic.is_some();
    let expects_system = system.is_some();
    let mut mixed = AlignedTrack {
        role: RecordingAudioRole::Primary,
        writer: Some(mixed),
    };
    let mut mic = AlignedTrack {
        role: RecordingAudioRole::Mic,
        writer: mic,
    };
    let mut system = AlignedTrack {
        role: RecordingAudioRole::System,
        writer: system,
    };
    let every_track_failed = |mixed: &AlignedTrack, mic: &AlignedTrack, system: &AlignedTrack| {
        mixed.writer.is_none() && mic.writer.is_none() && system.writer.is_none()
    };
    let mut last_checkpoint = Instant::now();
    loop {
        let chunk = match receiver.recv_timeout(WAV_WRITER_IDLE_POLL) {
            Ok(chunk) => Some(chunk),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if let Some(chunk) = chunk {
            let frames = chunk.mixed.len();
            if chunk
                .mic
                .as_ref()
                .is_some_and(|samples| samples.len() != frames)
                || chunk
                    .system
                    .as_ref()
                    .is_some_and(|samples| samples.len() != frames)
                || expects_mic != chunk.mic.is_some()
                || expects_system != chunk.system.is_some()
            {
                return Err(anyhow::anyhow!(
                    "Aligned meeting audio chunk had mismatched track lengths"
                ));
            }

            mixed.write(chunk.mixed, failures);
            if let Some(samples) = chunk.mic {
                mic.write(samples, failures);
            }
            if let Some(samples) = chunk.system {
                system.write(samples, failures);
            }
        }
        if last_checkpoint.elapsed() >= WAV_WRITER_CHECKPOINT_INTERVAL {
            mixed.checkpoint(failures);
            mic.checkpoint(failures);
            system.checkpoint(failures);
            last_checkpoint = Instant::now();
        }
        if every_track_failed(&mixed, &mic, &system) {
            return Err(anyhow::anyhow!(
                "Every meeting track stopped saving: {}",
                first_track_failure(failures)
            ));
        }
    }

    mixed.finish(failures);
    mic.finish(failures);
    system.finish(failures);
    let failed = failures.lock().map(|slot| slot.len()).unwrap_or_default();
    let planned = 1 + usize::from(expects_mic) + usize::from(expects_system);
    if failed >= planned {
        return Err(anyhow::anyhow!(
            "Every meeting track stopped saving: {}",
            first_track_failure(failures)
        ));
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
    loop {
        let samples = match receiver.recv_timeout(WAV_WRITER_IDLE_POLL) {
            Ok(samples) => samples,
            Err(RecvTimeoutError::Timeout) => {
                if last_checkpoint.elapsed() >= WAV_WRITER_CHECKPOINT_INTERVAL {
                    writer.flush()?;
                    last_checkpoint = Instant::now();
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        write_wav_samples(&mut writer, samples)?;
        if last_checkpoint.elapsed() >= WAV_WRITER_CHECKPOINT_INTERVAL {
            writer.flush()?;
            last_checkpoint = Instant::now();
        }
    }

    writer.finalize()?;
    tracing::info!("WAV file written: {:?}", log_path);
    Ok(())
}

fn unix_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn join_thread_with_timeout(handle: JoinHandle<()>, timeout: Duration, label: &str) -> Result<()> {
    // Poll the owned handle instead of moving it into another waiter thread.
    // If Core Audio never returns, a timeout then detaches only the original
    // worker rather than leaking an additional join waiter for every retry.
    let started_at = Instant::now();
    while !handle.is_finished() {
        if started_at.elapsed() >= timeout {
            return Err(anyhow::anyhow!("Timed out waiting for {}", label));
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    match handle.join() {
        Ok(()) => Ok(()),
        Err(_) => Err(anyhow::anyhow!("{} panicked", label)),
    }
}

fn retire_recording_preparation_threads(
    capture_stop_flag: &Arc<AtomicBool>,
    capture_handle: JoinHandle<()>,
    writer_handle: JoinHandle<Result<()>>,
) {
    capture_stop_flag.store(false, Ordering::SeqCst);
    if let Err(error) = join_thread_with_timeout(
        capture_handle,
        Duration::from_millis(250),
        "microphone preparation thread",
    ) {
        tracing::warn!("{}", error);
    }
    if let Err(error) = join_writer_with_timeout(
        writer_handle,
        Duration::from_millis(250),
        "microphone preparation writer thread",
    ) {
        tracing::warn!("{}", error);
    }
}

/// Which tracks of a stopped meeting did not save to the end: the ones the
/// writer closed on their own, or every track when the writer itself died.
fn failed_track_roles(
    planned: &[RecordingAudioRole],
    track_failures: &[TrackWriteFailure],
    writer_thread_failed: bool,
) -> Vec<RecordingAudioRole> {
    planned
        .iter()
        .copied()
        .filter(|role| {
            writer_thread_failed || track_failures.iter().any(|failure| failure.role == *role)
        })
        .collect()
}

/// Join a writer thread that is expected to finish. `Err` means it is still
/// running after `timeout`; `Ok(Some(error))` means it finished with an error
/// or panicked, so its files are no longer being written.
fn join_finished_writer(
    handle: JoinHandle<Result<()>>,
    timeout: Duration,
    label: &str,
) -> Result<Option<String>> {
    let started_at = Instant::now();
    while !handle.is_finished() {
        if started_at.elapsed() >= timeout {
            return Err(anyhow::anyhow!("Timed out waiting for {}", label));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(match handle.join() {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(format!("{label} failed: {error:#}")),
        Err(_) => Some(format!("{label} panicked")),
    })
}

fn join_writer_with_timeout(
    handle: JoinHandle<Result<()>>,
    timeout: Duration,
    label: &str,
) -> Result<()> {
    // See join_thread_with_timeout: keep timeout paths to one detached worker.
    let started_at = Instant::now();
    while !handle.is_finished() {
        if started_at.elapsed() >= timeout {
            return Err(anyhow::anyhow!("Timed out waiting for {}", label));
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    match handle.join() {
        Ok(result) => result.with_context(|| format!("{} failed", label)),
        Err(_) => Err(anyhow::anyhow!("{} panicked", label)),
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

/// Speech loudness the recognizer sees: about -20 dBFS RMS over speech.
const DICTATION_TARGET_SPEECH_RMS: f32 = 0.1;
/// At most +20 dB. Enough to lift a whisper or a far microphone to normal
/// speech level without turning room hiss into words.
const DICTATION_MAX_LOUDNESS_GAIN: f32 = 10.0;
/// 20 ms analysis frames; a frame counts as speech above -50 dBFS RMS.
const DICTATION_LOUDNESS_FRAME_SECONDS: f32 = 0.02;
const DICTATION_SPEECH_FRAME_RMS: f32 = 0.003;
/// Samples above this are soft-limited rather than clipped.
const DICTATION_LIMITER_KNEE: f32 = 0.9;
/// A capture whose loudest frames stay under -40 dBFS and within 6 dB of its
/// quietest is room tone, not words (speech rises and falls by far more).
const DICTATION_NOISE_ONLY_MAX_RMS: f32 = 0.01;
const DICTATION_NOISE_ONLY_MAX_CONTRAST: f32 = 2.0;

/// Brings quiet dictation up to normal speech loudness (the "whisper mode"
/// every dictation gets). Loudness is measured over speech frames only, so
/// silence before and after the words does not dilute it; the gain only ever
/// raises, never lowers, audio; and a soft limiter above the knee means one
/// key click cannot cap the gain for the whole utterance the way the old
/// peak-based boost did.
fn normalize_dictation_loudness(samples: &mut [f32], sample_rate: u32) {
    if samples.is_empty() || sample_rate == 0 {
        return;
    }
    let frame_len = ((sample_rate as f32 * DICTATION_LOUDNESS_FRAME_SECONDS) as usize).max(1);
    let mut speech_energy = 0.0_f64;
    let mut speech_samples = 0_usize;
    let mut frame_levels = Vec::with_capacity(samples.len() / frame_len + 1);
    for frame in samples.chunks(frame_len) {
        let energy: f64 = frame.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
        let rms = (energy / frame.len() as f64).sqrt() as f32;
        if !rms.is_finite() {
            return;
        }
        frame_levels.push(rms);
        if rms >= DICTATION_SPEECH_FRAME_RMS {
            speech_energy += energy;
            speech_samples += frame.len();
        }
    }
    if speech_samples == 0 {
        return;
    }
    // An accidental press with nobody speaking: lifting it would hand the
    // recognizer amplified hiss, which Whisper-family models turn into
    // invented words.
    frame_levels.sort_by(f32::total_cmp);
    let level_at =
        |fraction: f32| frame_levels[((frame_levels.len() - 1) as f32 * fraction).round() as usize];
    let (quiet, loud) = (level_at(0.1), level_at(0.95));
    if loud < DICTATION_NOISE_ONLY_MAX_RMS && loud < quiet * DICTATION_NOISE_ONLY_MAX_CONTRAST {
        return;
    }
    let speech_rms = (speech_energy / speech_samples as f64).sqrt() as f32;
    let gain = (DICTATION_TARGET_SPEECH_RMS / speech_rms).clamp(1.0, DICTATION_MAX_LOUDNESS_GAIN);
    if gain <= 1.0 {
        return;
    }
    let headroom = 1.0 - DICTATION_LIMITER_KNEE;
    for sample in samples.iter_mut() {
        let boosted = *sample * gain;
        let magnitude = boosted.abs();
        *sample = if magnitude <= DICTATION_LIMITER_KNEE {
            boosted
        } else {
            boosted.signum()
                * (DICTATION_LIMITER_KNEE
                    + headroom * ((magnitude - DICTATION_LIMITER_KNEE) / headroom).tanh())
        };
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

/// A device that called back at least once and then went quiet for longer
/// than this stopped delivering audio; healthy streams call back every ~10 ms.
const CAPTURE_STALL: Duration = Duration::from_millis(1_500);

fn capture_interrupted(
    stream_failed: bool,
    callbacks: u64,
    last_callback_us: u64,
    elapsed: Duration,
) -> bool {
    stream_failed
        || (callbacks > 0
            && elapsed.saturating_sub(Duration::from_micros(last_callback_us)) > CAPTURE_STALL)
}

#[cfg(test)]
mod capture_interruption_tests {
    use super::*;

    #[test]
    fn a_device_that_errors_or_goes_quiet_is_reported() {
        let at = Duration::from_secs;
        assert!(capture_interrupted(true, 500, 9_990_000, at(10)));
        assert!(capture_interrupted(false, 200, 4_000_000, at(10)));
        assert!(!capture_interrupted(false, 900, 9_990_000, at(10)));
        assert!(!capture_interrupted(false, 0, 0, at(10)));
    }
}

#[cfg(test)]
mod start_sound_delay_tests {
    use super::dictation_start_sound_delay_ms;

    #[test]
    fn bluetooth_inputs_hold_the_start_sound_until_the_profile_switch() {
        // Core Audio's transport type decides when it is known.
        assert_eq!(
            dictation_start_sound_delay_ms(Some("bluetooth"), "Jonathan's AirPods Pro"),
            300
        );
        assert_eq!(
            dictation_start_sound_delay_ms(Some("bluetooth"), "WH-1000XM5"),
            1200
        );
        assert_eq!(
            dictation_start_sound_delay_ms(Some("builtin"), "AirPods"),
            0
        );
        assert_eq!(
            dictation_start_sound_delay_ms(Some("usb"), "Yeti Stereo Microphone"),
            0
        );
        // Otherwise the name has to do.
        assert_eq!(dictation_start_sound_delay_ms(None, "AirPods Max"), 300);
        assert_eq!(
            dictation_start_sound_delay_ms(Some("unknown"), "Bose Bluetooth Headset"),
            1200
        );
        assert_eq!(
            dictation_start_sound_delay_ms(None, "MacBook Pro Microphone"),
            0
        );
    }
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
mod recording_capture_health_tests {
    use super::{
        meeting_headroom_bytes, meeting_space_pressure, meeting_space_pressure_with_vault_reserve,
        meeting_start_space_shortfall, meeting_start_space_shortfall_with_vault_reserve,
        meeting_vault_staging_bytes, microphone_lost, run_wav_writer_thread, silence_auto_stop_due,
        silence_auto_stop_warning_due, silence_auto_stop_warning_minutes, write_aligned_wav_files,
        MeetingSpacePressure, RecordingCaptureHealth, SourceInactivity,
        MEETING_CRITICAL_SPACE_STOP_SECONDS, MEETING_LOW_SPACE_WARN_SECONDS,
        MEETING_START_MIN_HEADROOM_SECONDS,
    };
    use std::sync::{Arc, Mutex};

    /// A mic-only meeting writes one WAV; "me and them" writes mixed + mic +
    /// system.
    const MIC_ONLY_TRACKS: u64 = 1;
    const ME_AND_THEM_TRACKS: u64 = 3;

    #[test]
    fn a_dead_writer_publishes_its_reason_before_the_thread_exits() {
        let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let observer = Arc::clone(&slot);
        let handle = std::thread::spawn(move || {
            run_wav_writer_thread(slot, || Err(anyhow::anyhow!("No space left on device")))
        });

        assert!(handle.join().expect("writer thread joins").is_err());
        assert!(
            observer
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|reason| reason.contains("No space left on device")),
            "a writer that dies must leave the reason where the lifecycle loop can find it"
        );
    }

    #[test]
    fn only_the_first_writer_failure_is_kept() {
        let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let _ = run_wav_writer_thread(Arc::clone(&slot), || Err(anyhow::anyhow!("first cause")));
        let _ = run_wav_writer_thread(Arc::clone(&slot), || Err(anyhow::anyhow!("later noise")));

        assert_eq!(slot.lock().unwrap().as_deref(), Some("first cause"));
    }

    #[test]
    fn a_healthy_writer_leaves_the_failure_slot_empty() {
        let root = std::env::temp_dir().join(format!(
            "plainsong-writer-health-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("recording.wav");
        let writers =
            super::prepare_aligned_wav_writers(&path, None, None, 16_000).expect("prepare writers");
        let (sender, receiver) = crossbeam::channel::bounded(1);
        drop(sender);

        let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        run_wav_writer_thread(Arc::clone(&slot), || {
            write_aligned_wav_files(writers, receiver, &path, &Arc::new(Mutex::new(Vec::new())))
        })
        .expect("an empty but well-formed session finalizes cleanly");

        assert!(slot.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn free_space_thresholds_leave_room_to_land_the_audio() {
        const _: () = {
            assert!(
                MEETING_CRITICAL_SPACE_STOP_SECONDS < MEETING_LOW_SPACE_WARN_SECONDS,
                "the stop threshold must trip after the warning, not before it"
            );
            assert!(
                MEETING_LOW_SPACE_WARN_SECONDS < MEETING_START_MIN_HEADROOM_SECONDS,
                "a meeting must not start already inside the warning band"
            );
        };

        for tracks in [MIC_ONLY_TRACKS, ME_AND_THEM_TRACKS] {
            assert_eq!(
                meeting_space_pressure(
                    meeting_headroom_bytes(tracks, MEETING_START_MIN_HEADROOM_SECONDS),
                    tracks
                ),
                MeetingSpacePressure::Ok
            );
            assert_eq!(
                meeting_space_pressure(
                    meeting_headroom_bytes(tracks, MEETING_LOW_SPACE_WARN_SECONDS),
                    tracks
                ),
                MeetingSpacePressure::Low
            );
            assert_eq!(
                meeting_space_pressure(
                    meeting_headroom_bytes(tracks, MEETING_CRITICAL_SPACE_STOP_SECONDS),
                    tracks
                ),
                MeetingSpacePressure::Critical
            );
            assert_eq!(
                meeting_space_pressure(0, tracks),
                MeetingSpacePressure::Critical
            );
        }
    }

    #[test]
    fn thresholds_scale_with_the_tracks_a_meeting_actually_writes() {
        // The regression: every threshold charged the three-track price, so a
        // mic-only meeting with ~50 minutes of room was refused outright, and
        // one that did start was warned and auto-stopped three times too early.
        let room_for_fifty_mic_only_minutes = meeting_headroom_bytes(MIC_ONLY_TRACKS, 50 * 60);
        assert_eq!(
            meeting_start_space_shortfall(room_for_fifty_mic_only_minutes, MIC_ONLY_TRACKS),
            None,
            "a mic-only meeting with 50 minutes of room must be allowed to start"
        );
        assert!(
            meeting_start_space_shortfall(room_for_fifty_mic_only_minutes, ME_AND_THEM_TRACKS)
                .is_some(),
            "the same volume cannot hold a three-track meeting for 30 minutes"
        );

        // 20 mic-only minutes is comfortable for one track and inside the
        // warning band for three.
        let room_for_twenty_mic_only_minutes = meeting_headroom_bytes(MIC_ONLY_TRACKS, 20 * 60);
        assert_eq!(
            meeting_space_pressure(room_for_twenty_mic_only_minutes, MIC_ONLY_TRACKS),
            MeetingSpacePressure::Ok
        );
        assert_eq!(
            meeting_space_pressure(room_for_twenty_mic_only_minutes, ME_AND_THEM_TRACKS),
            MeetingSpacePressure::Low
        );

        // And the auto-stop band: enough for a minute of one track, not three.
        let room_for_two_mic_only_minutes = meeting_headroom_bytes(MIC_ONLY_TRACKS, 2 * 60);
        assert_eq!(
            meeting_space_pressure(room_for_two_mic_only_minutes, MIC_ONLY_TRACKS),
            MeetingSpacePressure::Low
        );
        assert_eq!(
            meeting_space_pressure(room_for_two_mic_only_minutes, ME_AND_THEM_TRACKS),
            MeetingSpacePressure::Critical
        );

        // A zero track count would be a bug elsewhere; charging nothing for it
        // would disable the check entirely, so it is floored at one track.
        assert_eq!(meeting_headroom_bytes(0, 60), meeting_headroom_bytes(1, 60));
    }

    #[test]
    fn vault_thresholds_reserve_space_for_the_encrypted_copy() {
        let capture = meeting_headroom_bytes(MIC_ONLY_TRACKS, MEETING_START_MIN_HEADROOM_SECONDS);
        let vault_start_need = capture + meeting_vault_staging_bytes(&[capture]);
        assert_eq!(
            meeting_start_space_shortfall_with_vault_reserve(
                vault_start_need - 1,
                MIC_ONLY_TRACKS,
                true,
            ),
            Some(vault_start_need)
        );
        assert_eq!(
            meeting_start_space_shortfall_with_vault_reserve(
                vault_start_need,
                MIC_ONLY_TRACKS,
                true,
            ),
            None
        );

        let plaintext = meeting_headroom_bytes(MIC_ONLY_TRACKS, 29 * 60);
        let critical_capture =
            meeting_headroom_bytes(MIC_ONLY_TRACKS, MEETING_CRITICAL_SPACE_STOP_SECONDS);
        assert_eq!(
            meeting_space_pressure_with_vault_reserve(
                meeting_vault_staging_bytes(&[plaintext]) + critical_capture,
                MIC_ONLY_TRACKS,
                meeting_vault_staging_bytes(&[plaintext]),
                true,
            ),
            MeetingSpacePressure::Critical,
            "the meeting must stop while its plaintext and encrypted staging copy still fit"
        );
        assert_eq!(
            meeting_space_pressure(
                meeting_vault_staging_bytes(&[plaintext]) + critical_capture,
                MIC_ONLY_TRACKS,
            ),
            MeetingSpacePressure::Ok,
            "non-vault meetings must retain the capture-only threshold"
        );
    }

    #[test]
    fn vault_staging_reserve_matches_stream_boundaries_exactly() {
        const FRAME: u64 = 1024 * 1024;
        assert_eq!(meeting_vault_staging_bytes(&[0]), 21 + 4 + 16);
        assert_eq!(
            meeting_vault_staging_bytes(&[FRAME - 1]),
            FRAME - 1 + 21 + 20
        );
        assert_eq!(meeting_vault_staging_bytes(&[FRAME]), FRAME + 21 + 40);
        assert_eq!(
            meeting_vault_staging_bytes(&[FRAME + 1]),
            FRAME + 1 + 21 + 40
        );
        assert_eq!(
            meeting_vault_staging_bytes(&[FRAME, 0]),
            FRAME + (2 * 21) + (3 * 20)
        );
    }

    fn quiet_health(
        mic: Option<f32>,
        system: Option<f32>,
        since_epoch: f32,
    ) -> RecordingCaptureHealth {
        RecordingCaptureHealth {
            writer_failure: None,
            capture_failure: None,
            track_count: 1,
            vault_staging_bytes: 0,
            paused: false,
            recorded_seconds: 0.0,
            inactivity: SourceInactivity {
                mic_seconds: mic,
                system_seconds: system,
            },
            seconds_since_activity_epoch: since_epoch,
            mixed: false,
        }
    }

    #[test]
    fn a_mic_only_meeting_whose_stream_failed_and_stopped_is_reported() {
        let mut health = quiet_health(Some(0.0), None, 30.0);
        health.recorded_seconds = 12.0;
        // Healthy: no failure.
        assert!(!microphone_lost(&health, Some(12.0)));
        health.capture_failure = Some("The requested device is no longer available.".to_string());
        // The first look has nothing to compare against.
        assert!(!microphone_lost(&health, None));
        // Still delivering after a transient error report: not lost.
        health.recorded_seconds = 17.0;
        assert!(!microphone_lost(&health, Some(12.0)));
        // No new audio since the last look: lost.
        assert!(microphone_lost(&health, Some(17.0)));
        // A pause stops frames on purpose.
        health.paused = true;
        assert!(!microphone_lost(&health, Some(17.0)));
        health.paused = false;
        // Me + Them rebuilds its own sources and says so itself.
        health.mixed = true;
        assert!(!microphone_lost(&health, Some(17.0)));
    }

    #[test]
    fn recording_duration_limit_uses_finite_captured_audio_and_skips_pauses() {
        let mut health = quiet_health(None, None, 0.0);
        for (seconds, warning, stop) in [
            (0.0, false, false),
            (899.0, false, false),
            (900.0, true, false),
            (1199.0, true, false),
            (1200.0, false, true),
            (1201.0, false, true),
            (-1.0, false, false),
            (f64::NAN, false, false),
            (f64::INFINITY, false, false),
            (f64::NEG_INFINITY, false, false),
        ] {
            health.recorded_seconds = seconds;
            assert_eq!(super::duration_auto_stop_warning_due(&health, 20), warning);
            assert_eq!(super::duration_auto_stop_due(&health, 20), stop);
            assert!(!super::duration_auto_stop_warning_due(&health, 0));
            assert!(!super::duration_auto_stop_due(&health, 0));
            health.paused = true;
            assert!(!super::duration_auto_stop_warning_due(&health, 20));
            assert!(!super::duration_auto_stop_due(&health, 20));
            health.paused = false;
        }
        health.recorded_seconds = 29.0;
        assert!(!super::duration_auto_stop_warning_due(&health, 1));
        health.recorded_seconds = 30.0;
        assert!(super::duration_auto_stop_warning_due(&health, 1));
    }

    #[test]
    fn recording_duration_warning_rearms_only_for_changed_limits() {
        let mut health = quiet_health(None, None, 0.0);
        health.recorded_seconds = 900.0;
        let mut warning = super::MeetingDurationWarning::default();
        assert!(warning.take_due(&health, 20));
        assert!(!warning.take_due(&health, 20));
        health.paused = true;
        assert!(!warning.take_due(&health, 18));
        health.paused = false;
        assert!(warning.take_due(&health, 18));
        assert!(!warning.take_due(&health, 18));
        assert!(!warning.take_due(&health, 0));
        assert!(warning.take_due(&health, 20));
        assert!(!warning.take_due(&health, 40));
        health.recorded_seconds = 2100.0;
        assert!(warning.take_due(&health, 40));
    }

    #[test]
    fn silence_auto_stop_needs_every_source_quiet_for_the_whole_fuse() {
        // Mic-only meeting, 15-minute fuse.
        assert!(silence_auto_stop_due(
            &quiet_health(Some(900.0), None, 2_000.0),
            15
        ));
        assert!(!silence_auto_stop_due(
            &quiet_health(Some(899.0), None, 2_000.0),
            15
        ));
        // Me + Them: both sources must be quiet; one talking side keeps it alive.
        assert!(silence_auto_stop_due(
            &quiet_health(Some(1_000.0), Some(950.0), 2_000.0),
            15
        ));
        assert!(!silence_auto_stop_due(
            &quiet_health(Some(1_000.0), Some(10.0), 2_000.0),
            15
        ));
        assert!(!silence_auto_stop_due(
            &quiet_health(Some(10.0), Some(1_000.0), 2_000.0),
            15
        ));
        // No source at all reports nothing, and cannot end a meeting.
        assert!(!silence_auto_stop_due(
            &quiet_health(None, None, 2_000.0),
            15
        ));
    }

    #[test]
    fn silence_auto_stop_is_off_at_zero_and_while_paused_and_right_after_a_resume() {
        assert!(!silence_auto_stop_due(
            &quiet_health(Some(9_999.0), None, 9_999.0),
            0
        ));

        let mut paused = quiet_health(Some(9_999.0), None, 9_999.0);
        paused.paused = true;
        assert!(!silence_auto_stop_due(&paused, 15));

        // The watchdog's run survives a pause, but the fuse restarts at
        // resume: 20 minutes of quiet before the pause must not end the
        // meeting one poll after it resumes.
        assert!(!silence_auto_stop_due(
            &quiet_health(Some(1_200.0), None, 5.0),
            15
        ));
        assert!(silence_auto_stop_due(
            &quiet_health(Some(1_200.0), None, 900.0),
            15
        ));
    }

    #[test]
    fn a_quiet_meeting_is_warned_at_half_the_fuse_before_it_is_stopped() {
        // 15 minutes: warn at 7, stop at 15, and the sentence can say "8 more".
        assert_eq!(silence_auto_stop_warning_minutes(15), Some(7));
        assert_eq!(silence_auto_stop_warning_minutes(16), Some(8));
        // A one-minute fuse has no half worth announcing; 0 is off.
        assert_eq!(silence_auto_stop_warning_minutes(1), None);
        assert_eq!(silence_auto_stop_warning_minutes(0), None);

        // Quiet for six minutes: nothing said yet.
        assert!(!silence_auto_stop_warning_due(
            &quiet_health(Some(360.0), None, 2_000.0),
            15
        ));
        // Seven: warned, and still nowhere near the stop.
        let warned = quiet_health(Some(420.0), None, 2_000.0);
        assert!(silence_auto_stop_warning_due(&warned, 15));
        assert!(!silence_auto_stop_due(&warned, 15));

        // Me + Them: one side still talking is not a quiet meeting.
        assert!(!silence_auto_stop_warning_due(
            &quiet_health(Some(900.0), Some(10.0), 2_000.0),
            15
        ));
        // A meeting with no measurable source is never warned.
        assert!(!silence_auto_stop_warning_due(
            &quiet_health(None, None, 2_000.0),
            15
        ));

        // The same exemptions the stop has: off, paused, and just resumed.
        assert!(!silence_auto_stop_warning_due(
            &quiet_health(Some(9_999.0), None, 9_999.0),
            0
        ));
        let mut paused = quiet_health(Some(9_999.0), None, 9_999.0);
        paused.paused = true;
        assert!(!silence_auto_stop_warning_due(&paused, 15));
        assert!(!silence_auto_stop_warning_due(
            &quiet_health(Some(1_200.0), None, 5.0),
            15
        ));
    }

    #[test]
    fn padded_source_frames_become_seconds_of_reportable_silence() {
        use crate::audio::system_capture::MixedCaptureOutcome;

        let outcome = MixedCaptureOutcome {
            mic_padded_frames: 48_000 * 320,
            system_padded_frames: 0,
            mixed_frames: 48_000 * 3_600,
            ..MixedCaptureOutcome::default()
        };
        let degradation = super::source_degradation_from_outcome(&outcome, 48_000);

        assert!((degradation.mic_silent_seconds - 320.0).abs() < 0.001);
        assert_eq!(degradation.system_silent_seconds, 0.0);
        assert!((degradation.captured_seconds - 3_600.0).abs() < 0.001);
    }

    #[test]
    fn a_zero_sample_rate_reports_no_silence_rather_than_infinite_silence() {
        use crate::audio::system_capture::MixedCaptureOutcome;

        let outcome = MixedCaptureOutcome {
            mic_padded_frames: 1_000,
            ..MixedCaptureOutcome::default()
        };
        assert_eq!(
            super::source_degradation_from_outcome(&outcome, 0),
            super::RecordingSourceDegradation::default()
        );
    }

    #[test]
    fn start_preflight_refuses_only_a_volume_that_cannot_hold_a_meeting() {
        for tracks in [MIC_ONLY_TRACKS, ME_AND_THEM_TRACKS] {
            let needed = meeting_headroom_bytes(tracks, MEETING_START_MIN_HEADROOM_SECONDS);
            assert_eq!(meeting_start_space_shortfall(needed, tracks), None);
            assert_eq!(
                meeting_start_space_shortfall(needed - 1, tracks),
                Some(needed)
            );
        }
    }
}

#[cfg(test)]
mod recording_preparation_timeout_tests {
    use super::{
        retire_recording_preparation_threads, AudioCapture, MICROPHONE_STREAM_PREPARATION_TIMEOUT,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn cold_core_audio_preparation_has_a_bounded_startup_budget() {
        assert!(
            MICROPHONE_STREAM_PREPARATION_TIMEOUT >= Duration::from_secs(3),
            "cold Core Audio stream construction needs at least three seconds"
        );
        assert!(
            MICROPHONE_STREAM_PREPARATION_TIMEOUT <= Duration::from_secs(5),
            "a genuinely stalled Core Audio call must still fail closed promptly"
        );
    }

    #[test]
    fn stalled_microphone_workers_do_not_undo_the_preparation_timeout() {
        let capture_stop_flag = Arc::new(AtomicBool::new(true));
        let capture_handle = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(2));
        });
        let writer_handle = std::thread::spawn(|| -> anyhow::Result<()> {
            std::thread::sleep(Duration::from_secs(2));
            Ok(())
        });

        let started_at = Instant::now();
        retire_recording_preparation_threads(&capture_stop_flag, capture_handle, writer_handle);

        assert!(!capture_stop_flag.load(Ordering::SeqCst));
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "retiring stalled workers must remain bounded"
        );
    }

    #[test]
    fn a_stalled_microphone_attempt_blocks_only_further_microphone_retries() {
        let mut audio = AudioCapture::new();
        audio.microphone_preparation_stalled = true;

        let error = audio
            .ensure_microphone_preparation_retry_is_safe(true)
            .expect_err("a second microphone attempt must be rejected");
        assert!(error
            .to_string()
            .contains("Wait for Plainsong to restart audio capture"));
        assert!(
            audio
                .ensure_microphone_preparation_retry_is_safe(false)
                .is_ok(),
            "a microphone stall must not block a system-audio-only recording"
        );
    }

    #[test]
    fn stalled_dictation_preparation_returns_without_joining_forever() {
        let mut audio = AudioCapture::new();
        audio.is_dictating.store(true, Ordering::SeqCst);
        let capture_stop_flag = Arc::new(AtomicBool::new(true));
        audio.dictation_capture_stop = Some(Arc::clone(&capture_stop_flag));
        audio.dictation_thread = Some(std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(2));
        }));

        let started_at = Instant::now();
        audio.retire_dictation_preparation_thread();

        assert!(!audio.is_dictating.load(Ordering::SeqCst));
        assert!(!capture_stop_flag.load(Ordering::SeqCst));
        assert!(audio.dictation_thread.is_none());
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "retiring stalled dictation preparation must remain bounded"
        );
    }
}

#[cfg(test)]
mod recording_cancellation_tests {
    use super::*;

    #[test]
    fn scoped_abort_stops_prepared_and_activated_sessions_but_preserves_another_id() {
        for prepared in [true, false] {
            let mut audio = AudioCapture::new();
            let running = Arc::new(AtomicBool::new(true));
            let (activation_tx, _activation_rx) = crossbeam::channel::bounded(1);
            let (_activated_tx, activated_rx) = crossbeam::channel::bounded(1);
            audio.active_recording = Some(ActiveRecordingSession {
                id: "capture-B".to_string(),
                audio_path: PathBuf::new(),
                mic_audio_path: None,
                system_audio_path: None,
                writer_handles: Vec::new(),
                activation: prepared.then_some(RecordingActivation::Microphone {
                    activation_tx,
                    activated_rx,
                }),
                capture_stop_flag: Arc::clone(&running),
                capture_handle: None,
                mixed_capture: None,
                waveform_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
                streaming_queue: Arc::new(crossbeam::queue::ArrayQueue::new(1)),
                sample_rate: 48_000,
                dropped_stream_chunks: Arc::new(AtomicU64::new(0)),
                dropped_writer_chunks: Arc::new(AtomicU64::new(0)),
                capture_failure: Arc::new(std::sync::Mutex::new(None)),
                writer_failure: Arc::new(std::sync::Mutex::new(None)),
                track_write_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
                paused: Arc::new(AtomicBool::new(false)),
                recorded_frames: Arc::new(AtomicU64::new(0)),
                pause_ledger: PauseLedger::default(),
                mic_inactive_seconds: None,
                mic_level: None,
                activity_epoch: Instant::now(),
                aside_tap: Arc::default(),
                microphone_device_id: None,
                captures_microphone: true,
            });
            assert!(!audio.abort_recording_if_matches("capture-A"));
            assert!(audio.is_recording());
            assert!(running.load(Ordering::SeqCst));
            assert!(audio.abort_recording_if_matches("capture-B"));
            assert!(!audio.is_recording());
            assert!(!running.load(Ordering::SeqCst));
            assert!(!audio.abort_recording_if_matches("capture-B"));
        }
    }
}

#[cfg(test)]
mod track_write_failure_tests {
    use super::*;
    use crate::audio::system_capture::MixedAudioChunk;

    const RATE: u32 = 16_000;

    /// A writer whose file accepts no bytes: the header and the first samples
    /// sit in its buffer, and the first time the buffer reaches the file the
    /// write fails, as a file on a failing volume does.
    fn failing_writer(path: &Path) -> MeetingWavWriter {
        std::fs::write(path, b"").unwrap();
        let read_only = std::fs::File::open(path).unwrap();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        hound::WavWriter::new(std::io::BufWriter::new(read_only), spec).unwrap()
    }

    fn chunk(frames: usize) -> MixedAudioChunk {
        let tone: Vec<f32> = (0..frames)
            .map(|index| ((index % 80) as f32 / 80.0 - 0.5) * 0.6)
            .collect();
        MixedAudioChunk {
            mixed: tone.clone(),
            mic: Some(tone.clone()),
            system: Some(tone),
        }
    }

    /// One second of aligned audio, then the channel closes as Stop does.
    fn one_second_of_chunks() -> Receiver<MixedAudioChunk> {
        let (sender, receiver) = bounded(64);
        for _ in 0..10 {
            sender.send(chunk(1_600)).unwrap();
        }
        drop(sender);
        receiver
    }

    #[test]
    fn a_failing_microphone_file_does_not_stop_the_other_tracks() {
        let dir = crate::test_fs::TempDir::new("track-write-failure");
        let mixed = dir.path().join("meeting.wav");
        let mic = dir.path().join("meeting-mic.wav");
        let system = dir.path().join("meeting-system.wav");
        let writers = PreparedAlignedWavWriters {
            mixed: new_mono_wav_writer(&mixed, RATE).unwrap(),
            mic: Some(failing_writer(&mic)),
            system: Some(new_mono_wav_writer(&system, RATE).unwrap()),
        };
        let failures: TrackWriteFailures = Arc::new(std::sync::Mutex::new(Vec::new()));

        write_aligned_wav_files(writers, one_second_of_chunks(), &mixed, &failures)
            .expect("one failed track is not a failed meeting");

        let failures = failures.lock().unwrap().clone();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].role, RecordingAudioRole::Mic);
        for path in [&mixed, &system] {
            assert_eq!(hound::WavReader::open(path).unwrap().duration(), 16_000);
        }
    }

    #[test]
    fn the_writer_fails_only_when_every_track_has_failed() {
        let dir = crate::test_fs::TempDir::new("track-write-failure-all");
        let writers = PreparedAlignedWavWriters {
            mixed: failing_writer(&dir.path().join("meeting.wav")),
            mic: Some(failing_writer(&dir.path().join("meeting-mic.wav"))),
            system: Some(failing_writer(&dir.path().join("meeting-system.wav"))),
        };
        let failures: TrackWriteFailures = Arc::new(std::sync::Mutex::new(Vec::new()));

        let error = write_aligned_wav_files(
            writers,
            one_second_of_chunks(),
            &dir.path().join("meeting.wav"),
            &failures,
        )
        .expect_err("nothing left to save is a writer failure");
        assert!(error
            .to_string()
            .contains("Every meeting track stopped saving"));
        assert_eq!(failures.lock().unwrap().len(), 3);
    }

    #[test]
    fn a_dead_writer_marks_every_track_and_a_track_failure_marks_only_its_own() {
        let planned = [
            RecordingAudioRole::Primary,
            RecordingAudioRole::Mic,
            RecordingAudioRole::System,
        ];
        let system_failed = [TrackWriteFailure {
            role: RecordingAudioRole::System,
            error: "disk error".to_string(),
        }];
        assert_eq!(
            failed_track_roles(&planned, &system_failed, false),
            vec![RecordingAudioRole::System]
        );
        assert_eq!(failed_track_roles(&planned, &[], true), planned.to_vec());
        assert!(failed_track_roles(&planned, &[], false).is_empty());
    }

    #[test]
    fn stop_saves_the_good_tracks_when_one_track_failed() {
        let dir = crate::test_fs::TempDir::new("track-write-failure-stop");
        let mixed = dir.path().join("meeting.wav");
        let mic = dir.path().join("meeting-mic.wav");
        let system = dir.path().join("meeting-system.wav");
        let writers = PreparedAlignedWavWriters {
            mixed: new_mono_wav_writer(&mixed, RATE).unwrap(),
            mic: Some(failing_writer(&mic)),
            system: Some(new_mono_wav_writer(&system, RATE).unwrap()),
        };
        let track_write_failures: TrackWriteFailures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer_failures = Arc::clone(&track_write_failures);
        let receiver = one_second_of_chunks();
        let log_path = mixed.clone();
        let writer_handle = std::thread::spawn(move || {
            let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
            write_aligned_wav_files(writers, receiver, &log_path, &writer_failures)
        });

        let mut audio = AudioCapture::new();
        audio.active_recording = Some(ActiveRecordingSession {
            id: "me-and-them".to_string(),
            audio_path: mixed.clone(),
            mic_audio_path: Some(mic.clone()),
            system_audio_path: Some(system.clone()),
            writer_handles: vec![writer_handle],
            activation: None,
            capture_stop_flag: Arc::new(AtomicBool::new(true)),
            capture_handle: None,
            mixed_capture: None,
            waveform_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
            streaming_queue: Arc::new(crossbeam::queue::ArrayQueue::new(1)),
            sample_rate: RATE,
            dropped_stream_chunks: Arc::new(AtomicU64::new(0)),
            dropped_writer_chunks: Arc::new(AtomicU64::new(0)),
            capture_failure: Arc::new(std::sync::Mutex::new(None)),
            writer_failure: Arc::new(std::sync::Mutex::new(None)),
            track_write_failures,
            paused: Arc::new(AtomicBool::new(false)),
            recorded_frames: Arc::new(AtomicU64::new(0)),
            pause_ledger: PauseLedger::default(),
            mic_inactive_seconds: None,
            mic_level: None,
            activity_epoch: Instant::now(),
            aside_tap: Arc::default(),
            microphone_device_id: None,
            captures_microphone: true,
        });

        let result = audio
            .stop_recording("me-and-them")
            .expect("a meeting with one failed track still saves");

        let saved: Vec<_> = result
            .validated_assets
            .iter()
            .map(|(role, metadata)| (*role, metadata.duration_seconds))
            .collect();
        assert_eq!(
            saved,
            vec![
                (RecordingAudioRole::Primary, 1),
                (RecordingAudioRole::System, 1)
            ]
        );
        assert_eq!(result.failed_tracks, vec![RecordingAudioRole::Mic]);
        assert_eq!(result.unreadable_tracks, vec![RecordingAudioRole::Mic]);
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
    use super::{admit_dictation_samples, AudioCapture};
    use crate::audio::vad::{EnergyThresholdVadGate, VadConfig, VadGate};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier, Mutex};

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
    fn stale_abort_does_not_stop_replacement_capture() {
        let audio = Arc::new(Mutex::new(AudioCapture::new()));
        let replacement_flag = Arc::new(AtomicBool::new(true));
        let replacement_ready = Arc::new(Barrier::new(2));
        let stale_audio = Arc::clone(&audio);
        let stale_ready = Arc::clone(&replacement_ready);
        let stale = std::thread::spawn(move || {
            stale_ready.wait();
            stale_audio
                .lock()
                .expect("audio lock")
                .abort_dictation_for_session(1)
        });

        {
            let mut audio = audio.lock().expect("audio lock");
            audio.dictation_capture_session_id = Some(2);
            audio.dictation_capture_stop = Some(Arc::clone(&replacement_flag));
            audio.is_dictating.store(true, Ordering::SeqCst);
        }
        replacement_ready.wait();

        assert!(!stale.join().expect("stale cleanup task"));
        let audio = audio.lock().expect("audio lock");
        assert_eq!(audio.dictation_capture_session_id, Some(2));
        assert!(replacement_flag.load(Ordering::SeqCst));
        assert!(audio.is_dictating.load(Ordering::SeqCst));
    }

    #[test]
    fn matching_abort_stops_owned_capture() {
        let mut audio = AudioCapture::new();
        let session_flag = Arc::new(AtomicBool::new(true));
        audio.dictation_capture_session_id = Some(7);
        audio.dictation_capture_stop = Some(Arc::clone(&session_flag));
        audio.is_dictating.store(true, Ordering::SeqCst);

        assert!(audio.abort_dictation_for_session(7));
        assert_eq!(audio.dictation_capture_session_id, None);
        assert!(!session_flag.load(Ordering::SeqCst));
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

    #[test]
    fn a_panicking_audio_callback_does_not_escape_to_the_c_boundary() {
        // Escaping here would hit cpal's `extern "C"` trampoline and abort the
        // process, killing an in-progress meeting over one bad callback.
        let poisoned = AtomicBool::new(false);
        super::guard_audio_callback(&poisoned, "test", || panic!("callback exploded"));
        assert!(poisoned.load(Ordering::Relaxed));
    }

    #[test]
    fn a_poisoned_audio_callback_goes_inert_instead_of_repeating() {
        // The same panic would otherwise recur hundreds of times a second and
        // bury every other log line.
        let poisoned = AtomicBool::new(false);
        super::guard_audio_callback(&poisoned, "test", || panic!("first"));

        let mut ran_again = false;
        super::guard_audio_callback(&poisoned, "test", || ran_again = true);
        assert!(!ran_again, "a poisoned callback must not run again");
    }

    #[test]
    fn a_healthy_audio_callback_runs_and_stays_unpoisoned() {
        let poisoned = AtomicBool::new(false);
        let mut ran = false;
        super::guard_audio_callback(&poisoned, "test", || ran = true);

        assert!(ran);
        assert!(!poisoned.load(Ordering::Relaxed));
    }

    #[test]
    fn worker_thread_panics_are_recoverable_rather_than_fatal() {
        // The whole point of `panic = "unwind"`: the sidecar's `handle.join()`
        // recovery arms were dead code under abort, because a worker panic took
        // the process with it. This is the behaviour those arms depend on.
        let handle = std::thread::spawn(|| panic!("worker exploded"));
        assert!(
            handle.join().is_err(),
            "a worker panic must be observable by its joiner, not fatal"
        );
    }

    #[test]
    fn the_release_profile_unwinds_so_recovery_paths_can_run() {
        const CARGO_TOML: &str = include_str!("../Cargo.toml");
        let release = CARGO_TOML
            .split_once("[profile.release]")
            .expect("a release profile must exist")
            .1;
        let release = release
            .split_once("\n[")
            .map(|parts| parts.0)
            .unwrap_or(release);
        // Settings only: the profile's comment explains what `abort` used to do
        // and would otherwise trip a naive scan of the whole block.
        let panic_setting = release
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#'))
            .find_map(|line| line.strip_prefix("panic ="))
            .map(str::trim)
            .expect("the release profile must state a panic strategy");
        assert_eq!(
            panic_setting, "\"unwind\"",
            "release must unwind: abort makes every panic-recovery branch dead code"
        );
    }

    #[test]
    fn dictation_admits_samples_until_the_session_ceiling() {
        // Ordinary callback, plenty of headroom: everything is kept and nothing
        // is announced.
        let admission = admit_dictation_samples(0, 480, 48_000);
        assert_eq!(admission.accepted, 480);
        assert!(!admission.ceiling_reached);

        // Exactly filling the buffer is still a complete accept: no audio was
        // lost, so the user has nothing to be told about yet.
        let admission = admit_dictation_samples(47_520, 480, 48_000);
        assert_eq!(admission.accepted, 480);
        assert!(!admission.ceiling_reached);
    }

    #[test]
    fn dictation_truncates_the_callback_that_overruns_the_ceiling() {
        // Partial fit: keep the leading samples that still fit, and report the
        // ceiling so capture stops and the user is told.
        let admission = admit_dictation_samples(47_800, 480, 48_000);
        assert_eq!(admission.accepted, 200);
        assert!(admission.ceiling_reached);
    }

    #[test]
    fn dictation_admits_nothing_once_the_buffer_is_full() {
        let admission = admit_dictation_samples(48_000, 480, 48_000);
        assert_eq!(admission.accepted, 0);
        assert!(admission.ceiling_reached);

        // An empty callback against a full buffer is not the moment the limit
        // was hit; re-announcing it would stop a session twice.
        let admission = admit_dictation_samples(48_000, 0, 48_000);
        assert_eq!(admission.accepted, 0);
        assert!(!admission.ceiling_reached);
    }

    #[test]
    fn dictation_session_ceiling_bounds_worst_case_capture_memory() {
        // The ceiling exists to bound RAM. Pin the arithmetic so a future bump
        // cannot quietly reintroduce an unbounded-in-practice buffer: f32 mono
        // at a 48kHz device.
        let max_samples = 48_000_u64 * AudioCapture::dictation_max_session_seconds();
        let worst_case_bytes = max_samples * std::mem::size_of::<f32>() as u64;
        assert!(
            worst_case_bytes <= 192 * 1024 * 1024,
            "dictation capture may buffer at most 192 MiB, got {worst_case_bytes} bytes"
        );
    }

    #[test]
    fn provider_specific_session_limit_is_consumed_then_resets_to_default() {
        let mut audio = AudioCapture::new();
        audio.set_next_dictation_max_session_seconds(30);

        assert_eq!(audio.activate_dictation_session_limit(), 30);
        assert_eq!(audio.dictation_last_max_session_seconds(), 30);
        assert_eq!(
            audio.activate_dictation_session_limit(),
            AudioCapture::dictation_max_session_seconds()
        );
        assert_eq!(
            audio.dictation_last_max_session_seconds(),
            AudioCapture::dictation_max_session_seconds()
        );
    }

    #[test]
    fn thirty_second_limit_uses_the_existing_partial_callback_admission() {
        let max_samples = 48_000_u64 * 30;
        let admission = admit_dictation_samples(max_samples - 200, 480, max_samples);
        assert_eq!(admission.accepted, 200);
        assert!(admission.ceiling_reached);
    }

    #[test]
    fn a_fresh_dictation_session_clears_the_previous_ceiling_flag() {
        // The truncation notice is per session. A session that hit the ceiling
        // must not make the next one report truncation it never suffered.
        let mut audio = AudioCapture::new();
        audio
            .dictation_max_duration_reached
            .store(true, Ordering::SeqCst);
        audio
            .dictation_buffered_samples
            .store(999, Ordering::SeqCst);
        audio.is_dictating.store(true, Ordering::SeqCst);

        audio.abort_dictation();

        assert!(!audio.dictation_hit_max_duration());
        assert_eq!(audio.dictation_buffered_samples.load(Ordering::SeqCst), 0);
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
mod dictation_level_meter_tests {
    use super::DictationLevelMeter;

    fn assert_level(meter: &DictationLevelMeter, expected: f32) {
        let actual = meter.read();
        assert!((actual - expected).abs() < 1e-4, "{actual} != {expected}");
    }

    #[test]
    fn the_meter_reports_the_loudest_callback_between_polls_and_reads_do_not_reset_it() {
        let meter = DictationLevelMeter::default();
        meter.record(0.1, 1_000);
        meter.record(0.3, 11_000);
        meter.record(0.02, 51_000);

        assert_level(&meter, 0.3);
        // A second poller reading right after the first sees the same level.
        assert_level(&meter, 0.3);

        // The window rotates; the finished one still counts for one more.
        meter.record(0.05, 125_000);
        assert_level(&meter, 0.3);
        meter.record(0.01, 250_000);
        assert_level(&meter, 0.05);
    }

    #[test]
    fn a_new_session_starts_from_silence_on_its_own_clock() {
        let meter = DictationLevelMeter::default();
        meter.record(0.4, 900_000);
        meter.reset();
        assert_level(&meter, 0.0);

        meter.record(0.2, 2_000);
        meter.record(0.1, 12_000);
        assert_level(&meter, 0.2);
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
        audio.hands_free_tap.lock().unwrap().pre_roll = Some(ring);
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

        assert!(audio.hands_free_tap.lock().unwrap().pre_roll.is_none());
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
        assert!(audio.hands_free_tap.lock().unwrap().pre_roll.is_none());

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

    #[test]
    fn the_dictation_delivery_mode_defaults_to_system_and_accepts_preview() {
        use crate::models::DictationDeliveryMode;

        let default_options = crate::models::DictationStartOptions::default();
        assert_eq!(default_options.delivery_mode, DictationDeliveryMode::System);

        let from_empty: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(from_empty.delivery_mode, DictationDeliveryMode::System);

        let from_preview: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({ "deliveryMode": "preview" })).unwrap();
        assert_eq!(from_preview.delivery_mode, DictationDeliveryMode::Preview);
    }

    const RATE: u32 = 16_000;

    /// 10 ms frames; 5 frames of speech latch it.
    fn quick_gate() -> std::sync::Mutex<Box<dyn crate::audio::vad::VadGate + Send>> {
        std::sync::Mutex::new(Box::new(crate::audio::vad::EnergyThresholdVadGate::new(
            &crate::audio::vad::VadConfig {
                frame_size: 160,
                sample_rate: RATE,
                threshold_db: Some(-40.0),
                min_speech_duration: 0.05,
                min_silence_duration: 0.05,
                padding_seconds: 0.0,
            },
        )))
    }

    fn running_monitor(audio: &mut AudioCapture, device_id: &str) {
        audio.hands_free_tap = std::sync::Arc::new(std::sync::Mutex::new(super::HandsFreeTap {
            pre_roll: Some(crate::audio::preroll::PreRollBuffer::new(RATE, 2.0)),
            device_id: device_id.to_string(),
            sample_rate: RATE,
            channels: 1,
            ..super::HandsFreeTap::default()
        }));
        audio
            .hands_free_monitor_active
            .store(true, Ordering::SeqCst);
    }

    fn device(device_id: &str) -> super::ResolvedAudioInputDevice {
        super::ResolvedAudioInputDevice {
            device_id: device_id.to_string(),
            device_name: device_id.to_string(),
            transport_type: None,
            is_default: true,
            is_bluetooth_like: false,
            used_fallback: false,
            advisory: None,
        }
    }

    fn session_sink(
        audio: &AudioCapture,
        capture_stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> std::sync::Arc<super::DictationCaptureSink> {
        audio.dictation_capture_sink(7, 600, RATE, capture_stop, std::time::Instant::now(), None)
    }

    fn drain(audio: &AudioCapture) -> Vec<f32> {
        std::iter::from_fn(|| audio.dictation_buffer.pop()).collect()
    }

    /// The reason for the hand-off: the stream the monitor heard the opening
    /// words on keeps running into the session, so the buffer is the pre-roll
    /// followed directly by what came next, with nothing lost to a reopen.
    #[test]
    fn a_hands_free_start_takes_over_the_monitor_stream_without_a_gap() {
        let mut audio = AudioCapture::new();
        running_monitor(&mut audio, "mic");
        let tap = std::sync::Arc::clone(&audio.hands_free_tap);
        let running = std::sync::Arc::clone(&audio.hands_free_monitor_active);
        let gate = quick_gate();
        let handle = test_handle();
        let feed = |samples: &[f32]| {
            super::feed_hands_free_monitor(samples, 1, &tap, &running, &gate, &handle, 0)
        };

        feed(&[0.001, 0.002]);
        let capture_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let sink = session_sink(&audio, &capture_stop);
        assert!(audio.hand_monitor_stream_to_session(&sink, &device("mic"), RATE, 1));
        assert!(
            !audio.is_hands_free_monitor_active(),
            "reconcile must not see a monitor while the session owns the stream"
        );
        feed(&[0.003, 0.004]);

        assert_eq!(drain(&audio), vec![0.001, 0.002, 0.003, 0.004]);
        assert_eq!(audio.dictation_buffered_samples.load(Ordering::SeqCst), 4);
        assert!(tap.lock().unwrap().session_running());

        // Stop, cancel and the length ceiling all end capture through this
        // flag; the stream then goes quiet and its thread lets it close.
        capture_stop.store(false, Ordering::SeqCst);
        feed(&[0.005]);
        assert!(drain(&audio).is_empty());
        assert!(!tap.lock().unwrap().session_running());
    }

    #[test]
    fn a_monitor_on_another_device_or_format_is_not_taken_over() {
        let mut audio = AudioCapture::new();
        running_monitor(&mut audio, "mic");
        audio
            .hands_free_tap
            .lock()
            .unwrap()
            .pre_roll
            .as_mut()
            .unwrap()
            .push(&[0.1]);
        let capture_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let sink = session_sink(&audio, &capture_stop);

        assert!(!audio.hand_monitor_stream_to_session(&sink, &device("usb"), RATE, 1));
        assert!(!audio.hand_monitor_stream_to_session(&sink, &device("mic"), 48_000, 1));
        assert!(!audio.hand_monitor_stream_to_session(&sink, &device("mic"), RATE, 2));
        audio
            .hands_free_monitor_active
            .store(false, Ordering::SeqCst);
        assert!(!audio.hand_monitor_stream_to_session(&sink, &device("mic"), RATE, 1));

        let tap = audio.hands_free_tap.lock().unwrap();
        assert!(tap.session.is_none());
        assert_eq!(tap.pre_roll.as_ref().map(|ring| ring.len()), Some(1));
        drop(tap);
        assert!(drain(&audio).is_empty());
    }

    /// While a start it signalled is in flight the monitor keeps recording the
    /// pre-roll but must not signal again or move the onset mark.
    #[test]
    fn a_held_monitor_keeps_listening_without_signalling() {
        let mut audio = AudioCapture::new();
        running_monitor(&mut audio, "mic");
        let tap = std::sync::Arc::clone(&audio.hands_free_tap);
        let running = std::sync::Arc::clone(&audio.hands_free_monitor_active);
        let gate = quick_gate();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = SidecarHandle::new(tx);
        let speech = vec![0.5_f32; 160 * 10];

        audio.hold_hands_free_monitor(true);
        super::feed_hands_free_monitor(&speech, 1, &tap, &running, &gate, &handle, 0);
        assert!(rx.try_recv().is_err());
        assert_eq!(
            tap.lock().unwrap().pre_roll.as_ref().map(|ring| ring.len()),
            Some(speech.len())
        );

        audio.hold_hands_free_monitor(false);
        super::feed_hands_free_monitor(&speech, 1, &tap, &running, &gate, &handle, 0);
        assert!(rx.try_recv().unwrap().contains("hands_free_start"));
    }
}

#[cfg(test)]
mod dictation_loudness_tests {
    use super::normalize_dictation_loudness;

    fn tone(amplitude: f32, seconds: f32, rate: u32) -> Vec<f32> {
        (0..(seconds * rate as f32) as usize)
            .map(|i| {
                amplitude * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / rate as f32).sin()
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn a_whisper_is_lifted_toward_normal_speech_level() {
        let mut quiet = tone(0.02, 1.0, 16_000);
        normalize_dictation_loudness(&mut quiet, 16_000);
        let level = rms(&quiet);
        assert!(level > 0.09 && level < 0.11, "rms {level}");
    }

    #[test]
    fn normal_speech_and_silence_are_left_alone() {
        let mut loud = tone(0.3, 1.0, 16_000);
        let before = loud.clone();
        normalize_dictation_loudness(&mut loud, 16_000);
        assert_eq!(loud, before);

        let mut silence = vec![0.0005; 16_000];
        let before = silence.clone();
        normalize_dictation_loudness(&mut silence, 16_000);
        assert_eq!(silence, before);
    }

    #[test]
    fn a_key_click_does_not_cap_the_gain_and_never_clips() {
        let mut samples = vec![0.0; 800];
        samples[10] = 0.95; // push-to-talk click
        samples.extend(tone(0.02, 1.0, 16_000));
        normalize_dictation_loudness(&mut samples, 16_000);
        // The old peak-based boost gave this utterance no gain at all.
        assert!(rms(&samples[800..]) > 0.08);
        assert!(samples.iter().all(|s| s.abs() <= 1.0));
    }

    #[test]
    fn steady_room_noise_with_no_words_is_not_lifted() {
        // Deterministic white noise at about -45 dBFS RMS.
        let mut state = 0x2545_f491_u32;
        let mut noise: Vec<f32> = (0..32_000)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
            })
            .map(|sample| sample * 0.01)
            .collect();
        let before = noise.clone();
        normalize_dictation_loudness(&mut noise, 16_000);
        assert_eq!(noise, before);
    }

    #[test]
    fn a_whisper_after_a_pause_is_still_lifted() {
        let mut samples = vec![0.0005; 8_000];
        samples.extend(tone(0.02, 1.0, 16_000));
        normalize_dictation_loudness(&mut samples, 16_000);
        assert!(rms(&samples[8_000..]) > 0.08);
    }

    #[test]
    fn gain_is_capped_so_hiss_is_not_turned_into_speech() {
        let mut faint = tone(0.004, 1.0, 16_000);
        normalize_dictation_loudness(&mut faint, 16_000);
        assert!(rms(&faint) <= 0.004 * 10.0 / 2f32.sqrt() + 1e-4);
    }
}

#[cfg(test)]
mod meeting_microphone_input_tests {
    use super::*;

    #[test]
    fn meeting_microphone_input_uses_actual_resolver_fallback() {
        let resolved = ResolvedAudioInputDevice {
            device_id: "actual".into(),
            device_name: "Built-in Microphone".into(),
            transport_type: None,
            is_default: true,
            is_bluetooth_like: false,
            used_fallback: true,
            advisory: Some("Saved microphone is unavailable".into()),
        };
        let input = MeetingMicrophoneInput::from_resolved(&resolved, Some("Desk microphone"));
        assert_eq!(input.requested_name.as_deref(), Some("Desk microphone"));
        assert_eq!(input.resolved_name, "Built-in Microphone");
        assert!(input.used_fallback);
        let wire = serde_json::to_value(input).unwrap();
        assert_eq!(wire["resolvedName"], "Built-in Microphone");
        assert!(wire.get("deviceId").is_none());
    }

    #[test]
    fn meeting_microphone_input_does_not_invent_requested_device() {
        let resolved = ResolvedAudioInputDevice {
            device_id: "actual".into(),
            device_name: "Built-in Microphone".into(),
            transport_type: None,
            is_default: true,
            is_bluetooth_like: false,
            used_fallback: false,
            advisory: None,
        };
        let input = MeetingMicrophoneInput::from_resolved(&resolved, None);
        assert!(input.requested_name.is_none());
        assert!(!input.used_fallback);
    }
}

#[cfg(test)]
mod responsiveness_tests {
    use super::*;
    #[test]
    fn responsiveness_hands_free_ingress_stops_and_cannot_be_rearmed_by_a_new_session() {
        assert!(monitor_accepts_audio(true, false, 0, 0));
        assert!(monitor_accepts_audio(false, true, 7, 7));
        assert!(!monitor_accepts_audio(false, true, 0, 1));
        assert!(!monitor_accepts_audio(false, false, 7, 7));
        assert!(!monitor_accepts_audio(false, true, 7, 8));
    }

    #[test]
    fn responsiveness_unit_capture_defaults_never_use_the_live_profile() {
        assert!(default_capture_data_directory()
            .unwrap()
            .starts_with(std::env::temp_dir()));
    }

    #[test]
    fn responsiveness_an_intentionally_stopped_stream_does_not_become_stale_during_encoding() {
        let mut audio = AudioCapture::new();
        audio.dictation_capture_started_at = Some(Instant::now() - Duration::from_secs(10));
        audio.dictation_callback_count.store(1, Ordering::SeqCst);
        assert!(!audio.dictation_capture_interrupted());
    }

    #[test]
    fn responsiveness_stop_reports_a_worker_that_missed_the_drain_deadline() {
        let mut audio = AudioCapture::new();
        audio.is_dictating.store(true, Ordering::SeqCst);
        audio.dictation_capture_started_at = Some(Instant::now());
        audio.dictation_callback_count.store(1, Ordering::SeqCst);
        let (release, blocked) = bounded::<()>(1);
        audio.dictation_thread = Some(std::thread::spawn(move || {
            let _ = blocked.recv();
        }));
        let _ = audio.stop_dictation();
        let interrupted = audio.dictation_capture_interrupted();
        release.send(()).unwrap();
        assert!(
            interrupted,
            "a timed-out capture drain must be reported as interrupted"
        );
    }

    #[test]
    fn accepted_audio_drains_after_stop_but_cannot_enter_a_replacement_session() {
        let mut audio = AudioCapture::new();
        let running = Arc::new(AtomicBool::new(true));
        let sink = audio.dictation_capture_sink(1, 1, 2, &running, Instant::now(), None);
        sink.ingest(&[0.1_f32, 0.2], 1);
        running.store(false, Ordering::SeqCst);
        sink.process_pending();
        assert_eq!(audio.dictation_buffer.pop(), Some(0.1));
        assert_eq!(audio.dictation_buffer.pop(), Some(0.2));
        running.store(true, Ordering::SeqCst);
        sink.ingest(&[0.3_f32], 1);
        running.store(false, Ordering::SeqCst);
        audio.reset_dictation_sample_storage();
        sink.process_pending();
        assert!(audio.dictation_buffer.is_empty());
        assert_eq!(audio.dictation_buffered_samples.load(Ordering::SeqCst), 0);
        assert!(!audio.dictation_hit_max_duration());
    }

    #[test]
    fn overflow_marks_dictation_as_interrupted_without_discarding_accepted_audio() {
        let audio = AudioCapture::new();
        let running = Arc::new(AtomicBool::new(true));
        let sink = audio.dictation_capture_sink(1, 600, 10, &running, Instant::now(), None);
        sink.ingest(&[0.1_f32; 25], 1);
        assert!(audio.dictation_stream_failed.load(Ordering::SeqCst));
        sink.process_pending();
        assert_eq!(audio.dictation_buffer.len(), 20);
        assert_eq!(audio.dictation_buffered_samples.load(Ordering::SeqCst), 20);
    }

    #[test]
    fn dictation_callback_does_not_wait_for_the_preview_lock() {
        let audio = AudioCapture::new();
        let running = Arc::new(AtomicBool::new(true));
        let sink = audio.dictation_capture_sink(1, 600, 48_000, &running, Instant::now(), None);
        sink.streaming_active.store(true, Ordering::Relaxed);
        let lock = audio.dictation_partial_buffer.lock().unwrap();
        let (done_tx, done_rx) = bounded(1);
        let worker = std::thread::spawn(move || {
            sink.ingest(&[0.1_f32; 480], 1);
            done_tx.send(()).unwrap();
        });
        let completed = done_rx.recv_timeout(Duration::from_millis(100));
        drop(lock);
        worker.join().unwrap();
        assert!(
            completed.is_ok(),
            "audio callback waited for the preview lock"
        );
    }
}

#[cfg(test)]
mod meeting_aside_capture_tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn auto_stop_off() -> DictationAutoStopConfig {
        DictationAutoStopConfig {
            enabled: false,
            silence_timeout_seconds: 0.0,
            vad_backend: VadBackendKind::EnergyThreshold,
            silero_model_path: None,
        }
    }

    /// A recording meeting with no device behind it; each test plays the
    /// capture worker by forwarding blocks to the tap itself.
    fn recording_meeting(
        audio: &mut AudioCapture,
        captures_microphone: bool,
    ) -> Arc<MeetingMicTap> {
        let tap = Arc::new(MeetingMicTap::default());
        audio.active_recording = Some(ActiveRecordingSession {
            id: "meeting".to_string(),
            audio_path: PathBuf::new(),
            mic_audio_path: None,
            system_audio_path: None,
            writer_handles: Vec::new(),
            activation: None,
            capture_stop_flag: Arc::new(AtomicBool::new(true)),
            capture_handle: None,
            mixed_capture: None,
            waveform_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
            streaming_queue: Arc::new(crossbeam::queue::ArrayQueue::new(1)),
            sample_rate: RATE,
            dropped_stream_chunks: Arc::new(AtomicU64::new(0)),
            dropped_writer_chunks: Arc::new(AtomicU64::new(0)),
            capture_failure: Arc::new(std::sync::Mutex::new(None)),
            writer_failure: Arc::new(std::sync::Mutex::new(None)),
            track_write_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
            paused: Arc::new(AtomicBool::new(false)),
            recorded_frames: Arc::new(AtomicU64::new(0)),
            pause_ledger: PauseLedger::default(),
            mic_inactive_seconds: None,
            mic_level: None,
            activity_epoch: Instant::now(),
            aside_tap: Arc::clone(&tap),
            captures_microphone,
            microphone_device_id: None,
        });
        tap
    }

    /// One second of a voiced tone in the 10 ms blocks a worker drains.
    fn speech_blocks() -> Vec<Vec<f32>> {
        let samples: Vec<f32> = (0..RATE as usize)
            .map(|index| {
                let t = index as f32 / RATE as f32;
                0.2 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                    + 0.05 * (2.0 * std::f32::consts::PI * 660.0 * t).sin()
            })
            .collect();
        samples.chunks(480).map(<[f32]>::to_vec).collect()
    }

    #[test]
    fn the_disabled_gate_preserves_the_existing_pause_drain_policy() {
        let tap = MeetingMicTap::default();
        assert_eq!(
            forward_meeting_microphone(&tap, &[0.1; 20], true, false),
            Some(false)
        );
    }

    #[test]
    fn paused_aside_crash_recovery_acceptance() {
        aside_capture_recovery_acceptance(true, false);
    }

    #[test]
    fn open_aside_crash_recovery_acceptance() {
        aside_capture_recovery_acceptance(false, false);
    }

    #[test]
    fn different_microphone_aside_crash_recovery_acceptance() {
        aside_capture_recovery_acceptance(false, true);
    }

    fn aside_capture_recovery_acceptance(paused: bool, separate_input: bool) {
        let root = crate::test_fs::TempDir::new("aside-capture-crash");
        let source = root.path().join("meeting.wav");
        let mut writer = hound::WavWriter::create(
            &source,
            hound::WavSpec {
                channels: 1,
                sample_rate: RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..RATE {
            writer.write_sample(0i16).unwrap();
        }
        let journal_path = root.path().join("meeting.db");
        let mut db = crate::db::Database::open_at_path(&journal_path, None).unwrap();
        let recording = serde_json::from_value(serde_json::json!({"id":"meeting","title":"Synthetic meeting","projectId":"default","duration":1,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":source,"status":"recording"})).unwrap();
        db.create_recording(&recording).unwrap();
        let mut capture = AudioCapture::new();
        let tap = recording_meeting(&mut capture, true);
        tap.forward(&[0.0; RATE as usize], true, false);
        tap.writer_accepted(u64::from(RATE));
        let sink = if separate_input {
            // The same marker + own sink path, without opening a device.
            tap.attach_journaled(1, RATE, Arc::new(AsideMarker), unix_now_ms(), |ticket| {
                db.insert_pending_aside("meeting", ticket, 1, RATE)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
            capture.dictation_aside_tap = Some(Arc::clone(&tap));
            capture.dictation_sample_rate = 24_000;
            let (_, sink) =
                capture.begin_dictation_capture_session(1, 600, 24_000, &auto_stop_off(), None);
            capture.begin_aside_capture_checkpoint(1, 24_000).unwrap();
            Some(sink)
        } else {
            capture
                .start_dictation_aside(
                    1,
                    auto_stop_off(),
                    None,
                    None,
                    |recording_id, ticket, rate| {
                        db.insert_pending_aside(recording_id, ticket, 1, rate)
                            .map_err(|e| e.to_string())
                    },
                )
                .unwrap();
            None
        };
        let blocks = speech_blocks();
        for block in &blocks {
            let meeting_block = if separate_input {
                vec![0.0; block.len()]
            } else {
                block.clone()
            };
            tap.forward(&meeting_block, !paused, false);
            if !paused {
                for sample in &meeting_block {
                    writer
                        .write_sample((*sample * i16::MAX as f32) as i16)
                        .unwrap();
                }
            }
            if let Some(sink) = &sink {
                sink.ingest(block, 1);
                sink.process_pending();
            }
        }
        writer.finalize().unwrap();
        assert!(capture.dictation_buffered_samples.load(Ordering::SeqCst) > 0);
        // Keep test storage through the simulated restart. The killed-writer
        // test separately proves recovery without WavWriter's destructor.
        let checkpoint_root = capture.dictation_checkpoint_root.take().unwrap();
        drop(sink);
        drop(capture);
        drop(tap);
        drop(db);
        let db = crate::db::Database::open_at_path(&journal_path, None).unwrap();
        let spans = db.unrecovered_aside_spans("meeting").unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].end_frame, None);
        let original_frames = hound::WavReader::open(&source).unwrap().duration();
        if paused {
            assert_eq!(original_frames, RATE);
        }
        let now = std::time::SystemTime::now();
        crate::dictation_checkpoint::promote_leftover_dictation_checkpoint(
            checkpoint_root.path(),
            now,
        );
        let recovered =
            crate::dictation_checkpoint::pending_dictation_recovery(checkpoint_root.path(), now)
                .expect("capture audio survives independently of the meeting track");
        let mut reader = hound::WavReader::open(&recovered.path).unwrap();
        assert_eq!(
            reader.spec().sample_rate,
            if separate_input { 24_000 } else { RATE }
        );
        assert_eq!(
            reader
                .samples::<f32>()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            blocks.concat()
        );
        let masked = root.path().join("masked.wav");
        crate::meeting_aside_audio::copy_wav(&source, &masked, &spans, false).unwrap();
        let samples = hound::WavReader::open(masked)
            .unwrap()
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(samples.iter().all(|sample| *sample == 0));
        assert_eq!(
            hound::WavReader::open(&source).unwrap().duration(),
            original_frames
        );
    }

    #[test]
    fn cancelling_an_aside_after_capture_stops_discards_its_capture_checkpoint() {
        let mut capture = AudioCapture::new();
        let tap = recording_meeting(&mut capture, true);
        capture
            .start_dictation_aside(7, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .unwrap();
        for block in speech_blocks() {
            tap.forward(&block, false, false);
        }
        capture.stop_dictation().unwrap();
        assert!(!capture.abort_dictation_for_session(7));
        let root = capture.dictation_checkpoint_root.as_ref().unwrap();
        let now = std::time::SystemTime::now();
        crate::dictation_checkpoint::promote_leftover_dictation_checkpoint(root.path(), now);
        assert!(
            crate::dictation_checkpoint::pending_dictation_recovery(root.path(), now).is_none()
        );
    }

    #[test]
    fn queued_aside_frames_are_discarded_if_detach_races_a_pause() {
        let mut capture = AudioCapture::new();
        let tap = recording_meeting(&mut capture, true);
        capture
            .start_dictation_aside(1, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .unwrap();
        tap.forward(&[0.2; 480], true, false);
        capture.abort_dictation_for_session(1);
        assert_eq!(
            forward_meeting_microphone(&tap, &[0.2; 480], true, true),
            None
        );
        capture
            .start_dictation_aside(2, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .unwrap();
        tap.forward(&[0.1; 20], true, false);
        capture.abort_dictation_for_session(2);
        assert_eq!(tap.spans()[1].start_frame, 480);
    }

    #[test]
    fn failed_journal_never_attaches_or_keeps_dictation_running() {
        let mut audio = AudioCapture::new();
        let tap = recording_meeting(&mut audio, true);
        assert!(audio
            .start_dictation_aside(1, auto_stop_off(), None, None, |_, _, _| Err(
                "disk full".into()
            ))
            .is_err());
        assert!(!audio.is_dictating());
        assert!(!tap.is_attached());
        assert!(!tap.forward(&[0.2; 480], true, false));
    }

    /// Real models, isolated profile, no device or insertion. The measured
    /// interval is stop request through capture tail, WAV encode, ASR and local
    /// formatting. Optional AI formatting and Electron delivery are excluded.
    #[tokio::test]
    #[ignore = "requires isolated profile, pinned models and corpus; writes a paired latency receipt"]
    async fn measure_aside_dictation_pairs() {
        use crate::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
        use crate::text::format::DictationAppCategory;
        use std::io::Write;
        crate::meeting_eval::require_isolated_profile().unwrap();
        let manifest = std::env::var("PLAINSONG_ASIDE_PAIRS_MANIFEST").unwrap();
        let paths: Vec<String> = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        let provider = crate::asr::AsrProviderType::Whisper;
        let model = "base.en";
        let options = crate::meeting_eval::MeetingEvalOptions {
            audio: paths[0].clone().into(),
            provider,
            model_id: model.into(),
            asr_mode: crate::meeting_eval::MeetingEvalAsrMode::MeetingChunks,
            diarization_model_id: None,
            transcript_from: None,
            refinement: crate::diarization::DEFAULT_CLUSTER_REFINEMENT,
            source_tracks: None,
            aside_spans: vec![],
            canaries: vec![],
        };
        crate::meeting_eval::verify_models(&options).await.unwrap();
        let manager = Arc::new(crate::asr::AsrManager::new());
        let directory = crate::paths::data_dir().unwrap().join("Plainsong");
        let mut journal = crate::db::Database::open_at_path(
            &directory.join(format!("aside-pairs-{}.db", uuid::Uuid::new_v4())),
            None,
        )
        .unwrap();
        let recording = serde_json::from_value(serde_json::json!({"id":"meeting","title":"Synthetic meeting","projectId":"default","duration":0,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":"","status":"recording"})).unwrap();
        journal.create_recording(&recording).unwrap();
        let checkpoint_directory =
            crate::dictation_checkpoint::dictation_checkpoint_directory().unwrap();
        let mut output =
            std::fs::File::create(std::env::var("PLAINSONG_ASIDE_PAIRS_OUT").unwrap()).unwrap();
        // Warm the chosen provider before either timed arm.
        manager
            .transcribe_bytes_for_dictation(
                provider,
                &std::fs::read(&paths[0]).unwrap(),
                Some(model),
            )
            .await
            .unwrap();
        for (index, path) in paths.iter().enumerate() {
            let (samples, rate) =
                crate::meeting_transcribe::read_track_frames(Path::new(path), &(0..u64::MAX))
                    .unwrap();
            assert_eq!(rate, RATE);
            let mut pair = Vec::new();
            for aside in if index % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                // Timing admission is outside the measured stop clock. The
                // external guard records host load and other build-slot owners.
                if let Ok(guard) = std::env::var("PLAINSONG_ASIDE_TIMING_HOST_GUARD") {
                    assert!(std::process::Command::new("python3")
                        .arg(guard)
                        .arg(path)
                        .arg(aside.to_string())
                        .status()
                        .unwrap()
                        .success());
                }
                let stream = crate::streaming::StreamingTranscriber::new(Arc::clone(&manager));
                let meeting_guard = aside.then(crate::llm::speech_priority::meeting_speech);
                let (stream_id, mut stream_rx) = stream
                    .start_session(provider, RATE, model.into())
                    .await
                    .unwrap();
                let receiver =
                    tokio::spawn(async move { while stream_rx.recv().await.is_some() {} });
                // Seed a real live decode before capture; asides hold new chunks.
                if aside {
                    let seed: Vec<f32> = samples
                        .iter()
                        .copied()
                        .cycle()
                        .take(RATE as usize * 10)
                        .collect();
                    stream.feed_audio(&stream_id, &seed).await.unwrap();
                    tokio::task::yield_now().await;
                }
                let mut capture = AudioCapture::new();
                let mut standalone_sink = None;
                let tap = if aside {
                    let tap = recording_meeting(&mut capture, true);
                    capture
                        .start_dictation_aside(
                            1,
                            auto_stop_off(),
                            None,
                            None,
                            |recording_id, ticket, rate| {
                                journal
                                    .insert_pending_aside(recording_id, ticket, 1, rate)
                                    .map_err(|e| e.to_string())
                            },
                        )
                        .unwrap();
                    Some(tap)
                } else {
                    capture.dictation_sample_rate = RATE;
                    capture.dictation_channels = 1;
                    let max = capture.activate_dictation_session_limit();
                    let (_, sink) = capture.begin_dictation_capture_session(
                        1,
                        max,
                        RATE,
                        &auto_stop_off(),
                        None,
                    );
                    standalone_sink = Some(sink);
                    None
                };
                crate::llm::speech_priority::set_dictation_active(true);
                for block in samples.chunks(4800) {
                    if let Some(tap) = &tap {
                        tap.forward(block, true, false);
                    }
                    if let Some(sink) = &standalone_sink {
                        sink.ingest(block, 1);
                        sink.process_pending();
                    }
                    if aside {
                        stream
                            .feed_audio(&stream_id, &vec![0.0; block.len()])
                            .await
                            .unwrap();
                    }
                    if aside {
                        tokio::time::sleep(Duration::from_secs_f64(
                            block.len() as f64 / f64::from(RATE),
                        ))
                        .await;
                    }
                }
                let started = Instant::now();
                let tail =
                    vec![0.0; RATE as usize * DICTATION_STOP_CAPTURE_TAIL_MS as usize / 1000];
                if let Some(tap) = &tap {
                    tap.forward(&tail, true, false);
                }
                if let Some(sink) = &standalone_sink {
                    sink.ingest(&tail, 1);
                    sink.process_pending();
                }
                tokio::time::sleep(Duration::from_millis(DICTATION_STOP_CAPTURE_TAIL_MS)).await;
                let tail_ms = started.elapsed().as_secs_f64() * 1000.0;
                let stage = Instant::now();
                let wav = capture.stop_dictation().unwrap();
                let encode_ms = stage.elapsed().as_secs_f64() * 1000.0;
                let stage = Instant::now();
                if let Some(tap) = &tap {
                    journal
                        .finish_dictation_aside("meeting", 1, &tap.spans())
                        .unwrap();
                }
                let journal_ms = stage.elapsed().as_secs_f64() * 1000.0;
                let stage = Instant::now();
                let checkpoint = crate::dictation_checkpoint::DictationCheckpoint::write(
                    &checkpoint_directory,
                    &wav,
                )
                .unwrap();
                capture.discard_capture_checkpoint(1);
                let checkpoint_ms = stage.elapsed().as_secs_f64() * 1000.0;
                let stage = Instant::now();
                let waiting = crate::llm::local_model_load::user_waiting_decode();
                let asr_stages = crate::asr::stage_timing::Stages::default();
                let decoded = crate::asr::stage_timing::CURRENT
                    .scope(
                        Arc::clone(&asr_stages),
                        manager.transcribe_bytes_for_dictation(provider, &wav, Some(model)),
                    )
                    .await;
                let asr_ms = stage.elapsed().as_secs_f64() * 1000.0;
                let stage = Instant::now();
                let result = decoded.map(|decoded| {
                    apply_dictation_pipeline(DictationPipelineInput {
                        text: &decoded.text,
                        spoken_language: None,
                        dictionary_entries: &[],
                        snippets: &[],
                        app_target: None,
                        mode_preset: "voice",
                        smart_formatting_enabled: true,
                        clean_disfluencies: true,
                        numbers_as_digits: true,
                        recent_inserted_text: None,
                        command_mode_enabled: false,
                        destination_category: DictationAppCategory::Other,
                        structured_layout: false,
                    })
                    .text
                });
                let format_ms = stage.elapsed().as_secs_f64() * 1000.0;
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                drop(checkpoint);
                drop(waiting);
                crate::llm::speech_priority::set_dictation_active(false);
                // Drain any live decode before the next arm uses the provider.
                stream.finalize_session(&stream_id).await.ok();
                receiver.abort();
                drop(meeting_guard);
                let error = result.as_ref().err().map(|e| format!("{e:#}"));
                writeln!(output, "{}", serde_json::json!({"clip": path, "aside": aside, "stopToLocalTextMs": ms, "stagesMs": {"tail": tail_ms, "encode": encode_ms, "journal": journal_ms, "checkpoint": checkpoint_ms, "asr": asr_ms, "format": format_ms}, "asrStagesMs": *asr_stages.lock().unwrap(), "asrRoute": "whisper_in_process_no_helper_ipc", "text": result.as_ref().ok(), "error": error, "scope": "capture_tail_encode_journal_checkpoint_asr_local_format", "simulatedPhysicalMemoryGb": std::env::var("PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB").ok()})).unwrap();
                output.flush().unwrap();
                pair.push((aside, result.unwrap()));
            }
            assert_eq!(pair[0].1, pair[1].1, "different final text for {path}");
        }
        drop(manager);
        crate::shutdown_for_sidecar().await;
    }

    #[test]
    fn an_aside_hands_the_recognizer_exactly_what_standalone_capture_would() {
        let blocks = speech_blocks();

        // The aside: the meeting's worker forwards each block it writes.
        let mut meeting = AudioCapture::new();
        let tap = recording_meeting(&mut meeting, true);
        tap.forward(&[0.0; 4_800], true, false);
        meeting
            .start_dictation_aside(5, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .expect("aside starts");
        assert_eq!(meeting.meeting_aside_session(), Some(5));
        assert!(meeting.is_dictating());
        assert_eq!(meeting.dictation_sample_rate(), RATE);
        for block in &blocks {
            assert!(tap.forward(block, true, false));
        }
        let aside_wav = meeting.stop_dictation().expect("aside stops");
        assert_eq!(meeting.meeting_aside_session(), None);
        // The meeting keeps recording, and its frames are its own again.
        assert!(!tap.forward(&blocks[0], true, false));

        // Standalone: the same session setup and sink, fed the way a stream
        // callback and its worker feed it.
        let mut standalone = AudioCapture::new();
        standalone.dictation_sample_rate = RATE;
        standalone.dictation_channels = 1;
        let session_max_seconds = standalone.activate_dictation_session_limit();
        let (_stop, sink) = standalone.begin_dictation_capture_session(
            6,
            session_max_seconds,
            RATE,
            &auto_stop_off(),
            None,
        );
        for block in &blocks {
            sink.ingest(block, 1);
            sink.process_pending();
        }
        let standalone_wav = standalone.stop_dictation().expect("standalone stops");

        assert_eq!(aside_wav, standalone_wav);

        // The span names exactly the Me-track frames the dictation took.
        let spans = tap.spans();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_frame, 4_800);
        assert_eq!(spans[0].end_frame, Some(4_800 + u64::from(RATE)));
        assert_eq!(spans[0].dictation_session_id, 5);
    }

    #[test]
    fn no_meeting_or_a_system_audio_only_meeting_offers_no_aside() {
        let mut audio = AudioCapture::new();
        assert_eq!(audio.meeting_microphone(), MeetingMicrophone::Idle);
        assert!(audio
            .start_dictation_aside(1, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .is_err());
        assert!(!audio.is_dictating());

        recording_meeting(&mut audio, false);
        assert_eq!(
            audio.meeting_microphone(),
            MeetingMicrophone::Recording {
                captures_microphone: false,
                stopping: false
            }
        );
        assert!(audio
            .start_dictation_aside(1, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .is_err());
        assert!(!audio.is_dictating());
    }

    #[test]
    fn a_stopping_meeting_refuses_a_new_aside_and_leaves_dictation_idle() {
        let mut audio = AudioCapture::new();
        recording_meeting(&mut audio, true);
        audio.refuse_new_meeting_asides();
        assert_eq!(
            audio.meeting_microphone(),
            MeetingMicrophone::Recording {
                captures_microphone: true,
                stopping: true
            }
        );
        assert!(audio
            .start_dictation_aside(2, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .is_err());
        assert!(!audio.is_dictating());
        assert_eq!(audio.dictation_capture_session_id, None);
    }

    #[test]
    fn a_cancelled_aside_detaches_and_its_frames_stay_out_of_the_meeting() {
        let mut audio = AudioCapture::new();
        let tap = recording_meeting(&mut audio, true);
        audio
            .start_dictation_aside(3, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .expect("aside starts");
        tap.forward(&[0.1; 480], true, false);
        assert!(audio.abort_dictation_for_session(3));
        assert_eq!(audio.meeting_aside_session(), None);
        assert!(!tap.is_attached());
        assert!(audio.stop_dictation().is_err());
        // Cancelling the dictation does not hand its words to the meeting.
        assert_eq!(tap.spans().len(), 1);
    }

    #[test]
    fn a_meeting_that_ends_under_an_aside_leaves_the_dictation_its_audio_and_says_so() {
        let mut audio = AudioCapture::new();
        let tap = recording_meeting(&mut audio, true);
        audio
            .start_dictation_aside(4, auto_stop_off(), None, None, |_, _, _| Ok(()))
            .expect("aside starts");
        for block in speech_blocks() {
            tap.forward(&block, true, false);
        }
        assert!(!audio.dictation_capture_interrupted());
        assert_eq!(tap.close(10), Some(4));
        assert!(audio.dictation_capture_interrupted());
        let wav = audio
            .stop_dictation()
            .expect("the dictation keeps its audio");
        assert!(!wav.is_empty());
        assert!(audio.dictation_capture_interrupted());
    }
}
