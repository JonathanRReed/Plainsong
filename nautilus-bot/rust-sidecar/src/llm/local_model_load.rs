//! Shared admission before native allocations and system-model operations.
use super::native_runtime_gate::RuntimePermit;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static WORKING_BYTES: AtomicU64 = AtomicU64::new(0);
/// The subset of WORKING_BYTES owned by frozen background passes. Claims
/// remain reserved, including live allocations. Only a resident foreground
/// decode may borrow their future workspace while they cannot grow.
#[cfg(feature = "diarization")]
static PAUSED_BYTES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "diarization")]
static PROTECTED_DECODE_EPOCH: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "diarization")]
#[derive(Clone)]
struct BackgroundWaitBudget {
    spent_ms: std::sync::Arc<AtomicU64>,
    limit: std::time::Duration,
}

#[cfg(feature = "diarization")]
tokio::task_local! {
    static BACKGROUND_WAIT_BUDGET: BackgroundWaitBudget;
}

pub(crate) async fn with_background_wait_budget<F: std::future::Future>(
    spent_ms: std::sync::Arc<AtomicU64>,
    limit: std::time::Duration,
    work: F,
) -> F::Output {
    #[cfg(feature = "diarization")]
    {
        BACKGROUND_WAIT_BUDGET
            .scope(BackgroundWaitBudget { spent_ms, limit }, work)
            .await
    }
    #[cfg(not(feature = "diarization"))]
    {
        let _ = (spent_ms, limit);
        work.await
    }
}

/// A paused background pass ran out of its recording's wait budget. Terminal:
/// retrying would redo the finished batches the budget already paid for.
const BACKGROUND_WAIT_EXHAUSTED: &str = "Meeting wait budget exhausted during speaker separation";

pub(crate) fn is_background_wait_exhausted(message: &str) -> bool {
    message.contains(BACKGROUND_WAIT_EXHAUSTED)
}

pub(crate) fn notify_background_waiters() {
    super::native_runtime_gate::RUNTIME_EVENT.notify();
}

#[cfg(feature = "diarization")]
#[derive(Clone)]
pub(crate) struct BackgroundControl {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    budget: BackgroundWaitBudget,
}

#[cfg(feature = "diarization")]
pub(crate) struct CancelBackground(BackgroundControl);
#[cfg(feature = "diarization")]
impl Drop for CancelBackground {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
        super::native_runtime_gate::RUNTIME_EVENT.notify();
    }
}

#[cfg(feature = "diarization")]
pub(crate) fn background_job() -> (CancelBackground, BackgroundControl) {
    let budget = BACKGROUND_WAIT_BUDGET
        .try_with(Clone::clone)
        .unwrap_or_else(|_| BackgroundWaitBudget {
            spent_ms: Default::default(),
            limit: std::time::Duration::from_secs(600),
        });
    let control = BackgroundControl {
        cancelled: Default::default(),
        budget,
    };
    (CancelBackground(control.clone()), control)
}

#[cfg(feature = "diarization")]
impl BackgroundControl {
    fn check(&self) -> Result<()> {
        anyhow::ensure!(
            !self.cancelled.load(Ordering::Acquire),
            "Speaker separation cancelled"
        );
        Ok(())
    }

    fn remaining(&self) -> std::time::Duration {
        self.budget
            .limit
            .saturating_sub(std::time::Duration::from_millis(
                self.budget.spent_ms.load(Ordering::Acquire),
            ))
    }

    fn wait(&self, observed: u64, max_wait: std::time::Duration) -> Result<()> {
        self.check()?;
        let remaining = self.remaining().min(max_wait);
        anyhow::ensure!(!remaining.is_zero(), BACKGROUND_WAIT_EXHAUSTED);
        let started = std::time::Instant::now();
        super::native_runtime_gate::RUNTIME_EVENT.wait(observed, remaining);
        self.budget.spent_ms.fetch_add(
            started
                .elapsed()
                .as_nanos()
                .div_ceil(1_000_000)
                .min(u64::MAX as u128) as u64,
            Ordering::AcqRel,
        );
        self.check()?;
        anyhow::ensure!(!self.remaining().is_zero(), BACKGROUND_WAIT_EXHAUSTED);
        Ok(())
    }
}

/// Marks a final dictation decode the user is waiting on, until dropped.
/// Live previews, meeting finalization, imports and reprocessing never hold
/// one, so they keep the stricter adaptive rule.
pub(crate) struct UserWaitingDecode(());

impl Drop for UserWaitingDecode {
    fn drop(&mut self) {
        super::speech_priority::PRECEDENCE.end_user_waiting();
        super::native_runtime_gate::RUNTIME_EVENT.notify();
    }
}

pub(crate) fn user_waiting_decode() -> UserWaitingDecode {
    super::speech_priority::PRECEDENCE.begin_user_waiting();
    UserWaitingDecode(())
}

/// Whether a dictation decode the user is waiting on is in flight, on every
/// platform.
fn user_is_waiting_any() -> bool {
    super::speech_priority::PRECEDENCE.user_waiting()
}

/// Foreground native text work in flight or waiting for the runtime gate:
/// Ask, meeting summaries and chat, dictation reprocessing, built-in cleanup
/// and local Ollama requests.
static FOREGROUND_WAITERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Marks foreground native text work until dropped. Background work yields
/// the runtime gate to it at its next batch.
pub(crate) struct ForegroundWork(());

impl Drop for ForegroundWork {
    fn drop(&mut self) {
        FOREGROUND_WAITERS.fetch_sub(1, Ordering::AcqRel);
        super::native_runtime_gate::RUNTIME_EVENT.notify();
    }
}

pub(crate) fn foreground_work() -> ForegroundWork {
    FOREGROUND_WAITERS.fetch_add(1, Ordering::AcqRel);
    ForegroundWork(())
}

/// Whether background work (meaning-search indexing, diarization) should
/// leave the runtime gate alone before its next batch: someone is waiting on
/// foreground text work or on a dictation decode.
pub(crate) fn background_should_yield() -> bool {
    FOREGROUND_WAITERS.load(Ordering::Acquire) > 0 || user_is_waiting_any()
}

/// Background batches holding, or about to take, the runtime gate.
static BACKGROUND_HOLDERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Held by background work around one batch that takes the runtime gate, so
/// foreground work that finds the gate busy knows a short wait will free it.
pub(crate) struct BackgroundBatch(());

impl Drop for BackgroundBatch {
    fn drop(&mut self) {
        BACKGROUND_HOLDERS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn background_batch() -> BackgroundBatch {
    BACKGROUND_HOLDERS.fetch_add(1, Ordering::AcqRel);
    BackgroundBatch(())
}

/// How long foreground work waits for a background batch to hand back the
/// runtime gate, and how often it looks.
pub(crate) const FOREGROUND_GATE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
const FOREGROUND_GATE_POLL: std::time::Duration = std::time::Duration::from_millis(100);

fn background_holds_gate(gate: &super::native_runtime_gate::RuntimeGate) -> bool {
    BACKGROUND_HOLDERS.load(Ordering::Acquire) > 0 && gate.is_busy()
}

/// Wait, without taking it, until no background batch holds the runtime gate
/// or `FOREGROUND_GATE_WAIT` passes. For async foreground work that takes the
/// gate itself afterwards; hold a `ForegroundWork` across both.
pub(crate) async fn wait_for_background_gate(gate: &super::native_runtime_gate::RuntimeGate) {
    let deadline = tokio::time::Instant::now() + FOREGROUND_GATE_WAIT;
    while background_holds_gate(gate) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(FOREGROUND_GATE_POLL).await;
    }
}
/// Wait only for admission, not for the decode itself. The caller keeps its
/// foreground marker across this wait and the following provider dispatch.
pub(crate) async fn wait_for_dictation_admission(deadline: std::time::Instant) -> Result<()> {
    wait_for_dictation_admission_from(&super::native_runtime_gate::NATIVE_RUNTIME, deadline).await
}

async fn wait_for_dictation_admission_from(
    gate: &super::native_runtime_gate::RuntimeGate,
    deadline: std::time::Instant,
) -> Result<()> {
    if std::time::Instant::now() >= deadline {
        anyhow::bail!(super::native_runtime_gate::OPERATION_BUSY);
    }
    let permit = tokio::time::timeout_at(deadline.into(), gate.acquire_when_available())
        .await
        .map_err(|_| anyhow::anyhow!(super::native_runtime_gate::OPERATION_BUSY))?
        .map_err(anyhow::Error::msg)?;
    drop(permit);
    Ok(())
}

const WORKING_RESERVE: u64 = 6 * 1024 * 1024 * 1024;

/// Distinguish unreadable counters, a verified pressure deferral, and a
/// measured shortage. All three can be retried by background callers.
const UNVERIFIED_HEADROOM: &str = "Could not verify native memory headroom";
const PRESSURE_DEFERRED: &str = "Native memory admission deferred by memory pressure";
const INSUFFICIENT_HEADROOM: &str = "Not enough verified memory headroom for native inference working buffers alongside other applications.";

/// Whether an error, already flattened to text, is admission refusing for lack
/// of memory headroom.
///
/// That refusal is about the moment, not the request: it clears when other
/// work on the machine finishes or pressure falls, unlike a missing model or
/// unreadable audio. Callers doing long background work (a meeting's chunks)
/// can wait and ask again instead of discarding the audio. Matched on text
/// because the ASR routes report provider failures as strings.
pub(crate) fn is_headroom_refusal(message: &str) -> bool {
    message.contains(UNVERIFIED_HEADROOM)
        || message.contains(INSUFFICIENT_HEADROOM)
        || message.contains(PRESSURE_DEFERRED)
}

#[derive(Clone, Copy)]
pub(crate) enum NativeAllocation {
    Constructor,
    Inference { host_bytes: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeMemoryProfile {
    Standard,
    MoonshineStreaming,
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
    ParakeetV3,
    /// Parakeet TDT 0.6B v3 Q8_0 through transcribe.cpp on Metal. Same
    /// reservation shape as the ONNX export: a 3x-model constructor and a
    /// model-sized inference workspace, plus the long-audio bytes the
    /// provider measured (see `parakeet_gguf_memory_budget`). Peak process
    /// footprint was about 1.0 GB for short dictation, against about 2.1 GB
    /// for the ONNX route on the same clips.
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
    ParakeetGguf,
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
    Whistle,
}

impl NativeMemoryProfile {
    fn constructor_bytes(self, model_bytes: u64) -> Result<u64> {
        let bytes = model_bytes
            .checked_mul(if self == Self::MoonshineStreaming {
                4
            } else {
                3
            })
            .context("The native model memory budget is too large")?;
        Ok(match self {
            Self::Standard | Self::MoonshineStreaming => bytes,
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
            Self::ParakeetV3 | Self::ParakeetGguf => bytes,
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
            Self::Whistle => bytes.max(256 * 1024 * 1024),
        })
    }
    fn bytes(self, model_bytes: u64) -> u64 {
        let bytes = match self {
            Self::Standard => model_bytes / 2,
            Self::MoonshineStreaming => (model_bytes / 2).max(512 * 1024 * 1024),
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
            Self::ParakeetV3 | Self::ParakeetGguf => model_bytes,
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
            Self::Whistle => model_bytes / 2,
        };
        bytes.max(256 * 1024 * 1024)
    }
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn calibrated_workspace(
    provider: crate::asr::AsrProviderType,
    model_id: &str,
) -> NativeMemoryProfile {
    use crate::asr::AsrProviderType;
    match (provider, model_id) {
        (AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v3") => NativeMemoryProfile::ParakeetV3,
        (AsrProviderType::Whistle, "whistle-2.0.0") => NativeMemoryProfile::Whistle,
        #[cfg(feature = "asr-transcribe-cpp")]
        (AsrProviderType::TranscribeCpp, "moonshine-streaming-medium-q8_0") => {
            NativeMemoryProfile::MoonshineStreaming
        }
        // The default and the two optional English derivatives: same
        // architecture, same size, measured on the same path (see
        // `transcribe_cpp::PARAKEET_GGUF_SHAPED_MODEL_IDS`).
        #[cfg(feature = "asr-transcribe-cpp")]
        (
            AsrProviderType::TranscribeCpp,
            "parakeet-tdt-0.6b-v3-q8_0" | "fluid-speech-mini-q8_0" | "underdog-bark-3.0-pro-q8_0",
        ) => NativeMemoryProfile::ParakeetGguf,
        _ => NativeMemoryProfile::Standard,
    }
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn calibrated_asr(provider: crate::asr::AsrProviderType, model_id: &str) -> bool {
    use crate::asr::AsrProviderType;
    match (provider, model_id) {
        (AsrProviderType::Whisper, "base.en")
        | (AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v3")
        | (AsrProviderType::Whistle, "whistle-2.0.0") => true,
        #[cfg(feature = "asr-transcribe-cpp")]
        (AsrProviderType::TranscribeCpp, "moonshine-streaming-medium-q8_0")
        | (AsrProviderType::TranscribeCpp, "parakeet-tdt-0.6b-v3-q8_0")
        | (AsrProviderType::TranscribeCpp, "fluid-speech-mini-q8_0")
        | (AsrProviderType::TranscribeCpp, "underdog-bark-3.0-pro-q8_0") => true,
        _ => false,
    }
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
pub(super) fn adaptive_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
) -> Result<(u64, u64)> {
    let reserve = adaptive_reserve(snapshot)?;
    anyhow::ensure!(
        matches!(snapshot.pressure_level, 1 | 2 | 4),
        "{UNVERIFIED_HEADROOM}: unknown pressure level; {snapshot:?}"
    );
    anyhow::ensure!(
        snapshot.pressure_level == 1,
        "{PRESSURE_DEFERRED}: normal pressure required; {snapshot:?}"
    );
    Ok((snapshot.available_bytes, reserve))
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn adaptive_reserve(snapshot: super::ollama_prewarm_policy::MemorySnapshot) -> Result<u64> {
    const GIB: u64 = 1024 * 1024 * 1024;
    anyhow::ensure!(
        snapshot.physical_bytes > 0 && snapshot.available_bytes <= snapshot.physical_bytes,
        "{UNVERIFIED_HEADROOM}: invalid memory counters; {snapshot:?}"
    );
    Ok((snapshot.physical_bytes / 8).clamp(2 * GIB, WORKING_RESERVE))
}

/// Margin kept above a resident model's measured inference workspace.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
const RESIDENT_INFERENCE_RESERVE: u64 = 1024 * 1024 * 1024;

/// What live speech keeps free on an 8 GB Mac while pressure is normal.
///
/// The adaptive reserve's 2 GiB floor is a quarter of an 8 GB Mac. Beside a
/// call app, a browser and chat such a Mac has roughly 1-3 GB free (inactive
/// pages included), so a 1 GiB Neural Engine load plus 2 GiB was refused on
/// almost every dictation after the 2-minute idle release, and a live
/// meeting transcript never started. Speech is the tier's whole point: its
/// 1 GiB dictation budget assumes the Mac can give Plainsong that much.
/// Only speech gets this, only at normal pressure (the kernel's own verdict
/// that reclaiming the difference is cheap), and only on the Light tier; at
/// warning pressure the full reserve and resident margin still apply, and
/// critical pressure or an unreadable host still refuses. Notes, search
/// and speaker separation keep the full adaptive reserve.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
const LIGHT_SPEECH_RESERVE: u64 = 512 * 1024 * 1024;

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn light_speech_reserve(physical_bytes: u64, pressure_level: i32, reserve: u64) -> u64 {
    if pressure_level == 1
        && crate::hardware_tier::HardwareTier::for_physical_bytes(physical_bytes)
            == crate::hardware_tier::HardwareTier::Light
    {
        reserve.min(LIGHT_SPEECH_RESERVE)
    } else {
        reserve
    }
}

/// Headroom for speech no one is waiting on yet but that is live: a meeting
/// being transcribed as it is captured, or the model warming while someone
/// dictates. New loads use background terms and the Light speech reserve.
/// Resident decodes use `session_headroom` even at warning pressure.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn live_speech_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
) -> Result<(u64, u64)> {
    let (physical, pressure) = (snapshot.physical_bytes, snapshot.pressure_level);
    let (available, reserve) = adaptive_headroom(snapshot)?;
    Ok((available, light_speech_reserve(physical, pressure, reserve)))
}

/// Headroom for a final dictation decode or a resident speech decode. A
/// refused dictation fails in front of the user, so warning pressure still
/// admits it when the measured memory covers the allocation: a load keeps the
/// full adaptive reserve, and a decode on weights that are already resident
/// keeps a 1 GiB margin over its measured workspace. The margin is only for
/// profiles whose post-load growth is measured inside their workspace (the
/// GGUF route, and Neural Engine decodes on a helper that already holds its
/// model); others keep the adaptive reserve. On an 8 GB Mac at normal
/// pressure both keep [`LIGHT_SPEECH_RESERVE`] instead. Critical pressure
/// and unverified host state still refuse.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn session_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
    resident_inference: bool,
) -> Result<(u64, u64)> {
    anyhow::ensure!(
        matches!(snapshot.pressure_level, 1 | 2 | 4),
        "{UNVERIFIED_HEADROOM}: unknown pressure level; {snapshot:?}"
    );
    anyhow::ensure!(
        matches!(snapshot.pressure_level, 1 | 2),
        "{PRESSURE_DEFERRED}: normal or warning pressure required for speech; {snapshot:?}"
    );
    let (physical, pressure) = (snapshot.physical_bytes, snapshot.pressure_level);
    let available = snapshot.available_bytes;
    let reserve = adaptive_reserve(snapshot)?;
    let reserve = if resident_inference {
        RESIDENT_INFERENCE_RESERVE
    } else {
        reserve
    };
    Ok((available, light_speech_reserve(physical, pressure, reserve)))
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn protected_session_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
    resident_inference: bool,
) -> Result<(u64, u64)> {
    let (available, reserve) = session_headroom(snapshot, resident_inference)?;
    #[cfg(feature = "diarization")]
    let available = if resident_inference {
        // The gate prevents these paused passes from allocating until this
        // decode releases its temporary workspace. Their live pages are
        // already excluded from the host's available-memory observation.
        available.saturating_add(PAUSED_BYTES.load(Ordering::Acquire))
    } else {
        available
    };
    Ok((available, reserve))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn speech_headroom(
    user_waiting: bool,
    live: bool,
    resident: bool,
    protect_paused: bool,
) -> Result<(u64, u64)> {
    let snapshot = super::ollama_prewarm_policy::verified_memory_snapshot()?;
    speech_headroom_from(snapshot, user_waiting, live, resident, protect_paused)
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn speech_headroom_from(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
    user_waiting: bool,
    live: bool,
    resident: bool,
    protect_paused: bool,
) -> Result<(u64, u64)> {
    if user_waiting && protect_paused {
        protected_session_headroom(snapshot, resident)
    } else if user_waiting || resident {
        // A helper already holding all requested weights only allocates its
        // established decode allowance, including for meeting finalization.
        session_headroom(snapshot, resident)
    } else if live {
        live_speech_headroom(snapshot)
    } else {
        adaptive_headroom(snapshot)
    }
}

/// Speech admission that never loses to background model work. When memory
/// refuses it while dictation, a meeting capture or a final decode is live,
/// background text requests are stopped (and an idle notes helper ended),
/// and admission asks once more after at most `PREEMPT_RELEASE_WAIT`.
fn with_speech_precedence<T>(admit: impl Fn() -> Result<T>) -> Result<T> {
    speech_precedence_with(
        &super::speech_priority::PRECEDENCE,
        user_is_waiting_any(),
        || super::native_text::end_idle_helper_unless(|_| false),
        admit,
    )
}

fn speech_precedence_with<T>(
    precedence: &super::speech_priority::Precedence,
    user_waiting: bool,
    release_idle: impl FnOnce() -> bool,
    admit: impl Fn() -> Result<T>,
) -> Result<T> {
    let first = admit();
    let Err(error) = &first else {
        return first;
    };
    if !(user_waiting || precedence.speech_active()) || !is_headroom_refusal(&format!("{error:#}"))
    {
        return first;
    }
    let stopped = precedence.stop_all();
    let released = release_idle();
    if stopped == 0 && !released {
        return first;
    }
    precedence.wait_for_stopped(super::speech_priority::PREEMPT_RELEASE_WAIT);
    admit()
}

/// Call only after the provider's pinned artifact integrity checks succeed.
pub(crate) fn admit_asr(
    paths: &[&Path],
    provider: crate::asr::AsrProviderType,
    model_id: &str,
    allocation: NativeAllocation,
) -> Result<LoadReservation<'static>> {
    with_speech_precedence(|| admit_asr_once(paths, provider, model_id, allocation))
}

fn admit_asr_once(
    paths: &[&Path],
    provider: crate::asr::AsrProviderType,
    model_id: &str,
    allocation: NativeAllocation,
) -> Result<LoadReservation<'static>> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    if calibrated_asr(provider, model_id) {
        let workspace = calibrated_workspace(provider, model_id);
        let resident_inference = matches!(allocation, NativeAllocation::Inference { .. })
            && workspace == NativeMemoryProfile::ParakeetGguf;
        let user_waiting = user_is_waiting_any();
        let live = super::speech_priority::speech_active();
        let reservation = admit_with_observation(
            paths,
            &super::native_runtime_gate::NATIVE_RUNTIME,
            &WORKING_BYTES,
            || speech_headroom(user_waiting, live, resident_inference, true),
            allocation,
            workspace,
        )?;
        #[cfg(feature = "diarization")]
        if resident_inference && user_waiting {
            PROTECTED_DECODE_EPOCH.fetch_add(1, Ordering::AcqRel);
        }
        return Ok(reservation);
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    let _ = (provider, model_id);
    admit_with_observation(
        paths,
        &super::native_runtime_gate::NATIVE_RUNTIME,
        &WORKING_BYTES,
        || {
            Ok((
                super::ollama_prewarm_policy::measured_available_memory().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        },
        allocation,
        NativeMemoryProfile::Standard,
    )
}

/// Admission for a diarization speaker-embedding model: ECAPA-TDNN, CAM++,
/// ResNet34 or ERes2NetV2, 7-30 MB ONNX graphs run on one two-second window at
/// a time.
///
/// On Apple Silicon these keep the adaptive reserve the calibrated speech
/// models use (an eighth of physical memory, 2-6 GiB, and only while pressure
/// is normal) instead of the fixed 6 GiB the generic rule keeps free beside an
/// unmeasured model. Under the fixed rule a meeting's speaker labels needed
/// 6.25 GiB reclaimable *after* the meeting's own speech model was resident,
/// and when that was short diarization was refused and the meeting saved with
/// no speakers. The budget itself is unchanged: three times the model to
/// load, and the larger of half the model or 256 MiB, plus the decoded audio,
/// to run. Measured on AMI meetings in a process doing nothing else, the
/// whole ECAPA pass peaked at 0.15 GiB for 14 minutes and 0.25 GiB for 39,
/// against a budget of 0.31 and 0.40 GiB
/// (`artifacts/continuation-2026-10-20/opus-meeting/runs/da.*.json`). Meetings
/// are background work, so they stay on `adaptive_headroom` even while a user
/// waits on a dictation decode.
pub(crate) fn admit_speaker_embedding(
    paths: &[&Path],
    allocation: NativeAllocation,
) -> Result<LoadReservation<'static>> {
    crate::asr::speech_residency::release_for_heavy_work();
    admit_with_observation(
        paths,
        &super::native_runtime_gate::NATIVE_RUNTIME,
        &WORKING_BYTES,
        background_headroom,
        allocation,
        NativeMemoryProfile::Standard,
    )
}

fn background_headroom() -> Result<(u64, u64)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        adaptive_headroom(super::ollama_prewarm_policy::verified_memory_snapshot()?)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        Ok((
            super::ollama_prewarm_policy::measured_available_memory().context(
                "Could not verify native memory headroom: available-memory sample failed",
            )?,
            WORKING_RESERVE,
        ))
    }
}

#[cfg(feature = "diarization")]
pub(crate) fn admit_background_speaker(
    paths: &[&Path],
    host_bytes: u64,
    control: BackgroundControl,
) -> Result<YieldingGate<'static>> {
    if background_should_yield() {
        anyhow::bail!(super::native_runtime_gate::OPERATION_BUSY);
    }
    let batch = background_batch();
    let reservation = admit_speaker_embedding(paths, NativeAllocation::Inference { host_bytes })?;
    Ok(reservation.into_background(batch, control))
}

/// Built-in search keeps the standard model estimates and adaptive reserve.
/// Background indexing may use the existing Light-tier away window. The
/// parent stops its owned helper if that window ends, and the helper checks
/// the same host conditions again before each allocation.
pub(crate) fn admit_text_embedding(
    paths: &[&Path],
    allocation: NativeAllocation,
) -> Result<LoadReservation<'static>> {
    crate::asr::speech_residency::release_for_heavy_work();
    admit_with_observation(
        paths,
        &super::native_runtime_gate::NATIVE_RUNTIME,
        &WORKING_BYTES,
        text_embedding_observation,
        allocation,
        NativeMemoryProfile::Standard,
    )
}

fn text_embedding_observation() -> Result<(u64, u64)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        embedding_headroom(
            super::ollama_prewarm_policy::verified_memory_snapshot()?,
            super::notes_window::admission_active() && super::notes_window::away(),
        )
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    background_headroom()
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn embedding_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
    away: bool,
) -> Result<(u64, u64)> {
    let physical = snapshot.physical_bytes;
    let (available, reserve) = adaptive_headroom(snapshot)?;
    let reserve = if away
        && crate::hardware_tier::HardwareTier::for_physical_bytes(physical)
            == crate::hardware_tier::HardwareTier::Light
    {
        super::notes_window::AWAY_RESERVE
    } else {
        reserve
    };
    Ok((available, reserve))
}

/// The helper's process-local counter cannot see other native claims in the
/// parent. Reserve its full constructor budget here until the reply or exit,
/// while the caller holds the parent's runtime gate. This also covers the
/// smaller inference budget for every supported four-text, 512-token batch.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
pub(crate) fn text_embedding_helper_claim(paths: &[&Path]) -> Result<MemoryClaim<'static>> {
    let bytes = NativeMemoryProfile::Standard.constructor_bytes(model_bytes(paths)?)?;
    text_helper_claim_with(bytes, &WORKING_BYTES, text_embedding_observation)
}

/// Working memory of one pyannote community-1 pass beyond the model files:
/// the Core ML program and ONNX Runtime buffers for the two networks (about
/// 0.7 GB whatever the length), plus what grows with the recording -- the
/// decoded float32 audio (64 KB a second) and the per-window segmentation,
/// embeddings and clustering state.
///
/// Calibrated on the peak physical footprint (`ri_lifetime_max_phys_footprint`,
/// which counts what the GPU driver maps and what is compressed, and runs
/// 0.2-0.4 GiB above the resident set here), never on `ru_maxrss`. On an M4
/// Pro, release build, embeddings on the GPU, through the meeting path
/// (`meeting-eval`) on 21 AMI recordings of 14-50 minutes: 0.73 GiB for 14
/// minutes rising to 0.87 for 50; a 75-minute recording peaked at 0.97 GiB.
/// With the embeddings on the CPU the pass peaked lower (0.43 GiB for 17.5
/// minutes, 0.66 for 75). With the standard 256 MiB inference floor that
/// `admit_community1` adds, this budget is 17-23% above every GPU measurement.
/// Receipts: `artifacts/continuation-2026-10-20/opus-pyannote-c1/deeprec/runs/pad1.*`
/// and `.../opus-pyannote-c1/budget/`.
#[cfg(any(test, feature = "diarization"))]
pub(crate) fn community1_working_bytes(audio_seconds: f64) -> u64 {
    let seconds = if audio_seconds.is_finite() && audio_seconds > 0.0 {
        audio_seconds.ceil() as u64
    } else {
        0
    };
    COMMUNITY1_FIXED_BYTES.saturating_add(seconds.saturating_mul(COMMUNITY1_BYTES_PER_SECOND))
}

#[cfg(any(test, feature = "diarization"))]
const COMMUNITY1_FIXED_BYTES: u64 = 544 * 1024 * 1024;
#[cfg(any(test, feature = "diarization"))]
const COMMUNITY1_BYTES_PER_SECOND: u64 = 96 * 1024;

/// Admission for the pyannote community-1 speaker model. Background work like
/// the embedding diarizers, so it keeps the same adaptive reserve on Apple
/// Silicon; the budget is the measured working set for the recording's length.
/// The memory claim lasts the whole pass; the gate yields to dictation
/// ([`YieldingGate`]).
#[cfg(feature = "diarization")]
pub(crate) fn admit_community1(
    paths: &[&Path],
    audio_seconds: f64,
    decode_scratch_bytes: u64,
    control: BackgroundControl,
) -> Result<YieldingGate<'static>> {
    let host_bytes = community1_working_bytes(audio_seconds)
        .checked_add(decode_scratch_bytes)
        .context("The speaker audio memory budget is too large")?;
    admit_background_speaker(paths, host_bytes, control)
}

/// Whether an optional speech-model warm-up would pass the admission its own
/// load uses right now. Calibrated models keep their measured reserve; the
/// rest keep the fixed rule. Unknown memory or raised pressure defers it.
pub(crate) fn asr_prewarm_has_headroom(
    provider: crate::asr::AsrProviderType,
    model_id: &str,
    model_mib: f64,
) -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    if calibrated_asr(provider, model_id) {
        return calibrated_prewarm_fits(
            model_mib,
            calibrated_workspace(provider, model_id),
            super::ollama_prewarm_policy::measured_memory_snapshot(),
            reserved_working_bytes(),
        );
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    let _ = (provider, model_id);
    super::ollama_prewarm_policy::speech_prewarm_has_headroom(
        model_mib,
        super::ollama_prewarm_policy::available_memory(),
    )
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn calibrated_prewarm_fits(
    model_mib: f64,
    workspace: NativeMemoryProfile,
    snapshot: Option<super::ollama_prewarm_policy::MemorySnapshot>,
    reserved: u64,
) -> bool {
    let model = (model_mib * 1024.0 * 1024.0).ceil();
    if !model.is_finite() || model <= 0.0 || model >= u64::MAX as f64 {
        return false;
    }
    let Some((available, reserve)) = snapshot.and_then(|snapshot| adaptive_headroom(snapshot).ok())
    else {
        return false;
    };
    workspace
        .constructor_bytes(model as u64)
        .ok()
        .and_then(|bytes| bytes.checked_add(reserved))
        .and_then(|bytes| bytes.checked_add(reserve))
        .is_some_and(|required| available >= required)
}

pub(crate) fn reserved_working_bytes() -> u64 {
    WORKING_BYTES.load(Ordering::Acquire)
}

fn reserve(counter: &AtomicU64, bytes: u64, available: impl Fn() -> Option<u64>) -> Result<()> {
    reserve_with_observation(counter, bytes, || {
        Ok((
            available().context(
                "Could not verify native memory headroom: available-memory sample failed",
            )?,
            WORKING_RESERVE,
        ))
    })
}

fn reserve_with_observation(
    counter: &AtomicU64,
    bytes: u64,
    observation: impl Fn() -> Result<(u64, u64)>,
) -> Result<()> {
    loop {
        let previous = counter.load(Ordering::Acquire);
        let next = previous
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("Native working-memory budget is too large"))?;
        let (available, reserve) = observation()?;
        let required = next
            .checked_add(reserve)
            .ok_or_else(|| anyhow::anyhow!("Native working-memory budget is too large"))?;
        if available < required {
            anyhow::bail!(
                "{INSUFFICIENT_HEADROOM} available_bytes={available}, required_bytes={required}, \
                 reserve_bytes={reserve}, existing_claims_bytes={previous}, request_bytes={bytes}"
            );
        }
        if counter
            .compare_exchange(previous, next, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return Ok(());
        }
    }
}

#[cfg(feature = "diarization")]
fn verify_reserved_headroom(
    counter: &AtomicU64,
    observation: impl Fn() -> Result<(u64, u64)>,
) -> Result<()> {
    let (available, reserve) = observation()?;
    let required = counter
        .load(Ordering::Acquire)
        .checked_add(reserve)
        .context("Native working-memory budget is too large")?;
    anyhow::ensure!(available >= required, "{INSUFFICIENT_HEADROOM} available_bytes={available}, required_bytes={required}, reserve_bytes={reserve}");
    Ok(())
}

pub(crate) fn working_buffers(paths: &[&Path]) -> Result<LoadReservation<'static>> {
    working_buffers_with_extra(paths, 0)
}

pub(crate) fn working_buffers_with_extra(
    paths: &[&Path],
    host_bytes: u64,
) -> Result<LoadReservation<'static>> {
    with_speech_precedence(|| {
        working_with_memory(
            paths,
            &super::native_runtime_gate::NATIVE_RUNTIME,
            &WORKING_BYTES,
            super::ollama_prewarm_policy::measured_available_memory,
            host_bytes,
        )
    })
}

/// Admit loading Parakeet into the Core ML speech helper.
///
/// The memory lives outside this process (the helper and, on the Neural
/// Engine route, the kernel's Neural Engine driver and, on a first compile,
/// Apple's compiler service; the CPU route on the Light tier wires nothing),
/// so it is an allowance rather than a file-size calculation. Unlike
/// [`system_runtime`], whose fixed 6 GiB reserve would refuse every load on
/// an 8 GB Mac, it keeps the same tier-scaled reserve as the calibrated ggml
/// route: a background load defers at any raised pressure, and a load a
/// dictation is waiting on is admitted at warning pressure when measured
/// memory covers it.
///
/// It takes no runtime gate: the helper has its own route lock, and a notes
/// request holding the text gate must never refuse a dictation here. Memory
/// is the only thing the two share.
pub(crate) fn admit_neural_engine_speech(allowance: u64) -> Result<LoadReservation<'static>> {
    admit_neural_engine_decode(allowance, false)
}

/// [`admit_neural_engine_speech`] for a request whose models the helper
/// already holds (`resident`). Their memory is already in use, so it is
/// already missing from the free memory admission reads; the allowance is
/// the request's own, and a dictation the user waits on keeps the resident
/// decode margin rather than a load's reserve.
pub(crate) fn admit_neural_engine_decode(
    allowance: u64,
    resident: bool,
) -> Result<LoadReservation<'static>> {
    with_speech_precedence(|| neural_engine_speech_once(allowance, resident))
}

fn neural_engine_speech_once(allowance: u64, resident: bool) -> Result<LoadReservation<'static>> {
    let user_waiting = user_is_waiting_any();
    let live = super::speech_priority::speech_active();
    neural_engine_speech_with(&WORKING_BYTES, allowance, || {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            speech_headroom(user_waiting, live, resident, false)
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            let _ = (user_waiting, live, resident);
            Ok((
                super::ollama_prewarm_policy::measured_available_memory().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        }
    })
}

fn neural_engine_speech_with(
    counter: &AtomicU64,
    allowance: u64,
    observation: impl Fn() -> Result<(u64, u64)>,
) -> Result<LoadReservation<'_>> {
    anyhow::ensure!(
        allowance > 0,
        "A speech helper load needs a nonzero memory allowance"
    );
    reserve_with_observation(counter, allowance, observation)?;
    Ok(LoadReservation {
        _claim: MemoryClaim {
            bytes: allowance,
            counter,
            #[cfg(feature = "diarization")]
            paused: false,
        },
        _permit: None,
    })
}

/// Admit preparing Parakeet in a helper process of its own: the Neural
/// Engine compile on most Macs, a plain model load on the Light tier's CPU
/// route. The reservation covers only the prepare's memory: it takes no
/// text-runtime permit, because it shares nothing with text work and can run
/// for minutes. ANE compilation defers at any raised pressure; CPU preparation
/// uses `admit_cpu_speech_prepare`.
pub(crate) fn admit_neural_engine_compile(allowance: u64) -> Result<MemoryClaim<'static>> {
    compile_claim_with(&WORKING_BYTES, allowance, || {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            speech_prepare_headroom(
                super::ollama_prewarm_policy::verified_memory_snapshot()?,
                false,
            )
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            Ok((
                super::ollama_prewarm_policy::measured_available_memory().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        }
    })
}

/// CPU preparation loads the already compiled bundles. It has no ANE compiler
/// service and may run at warning pressure, with its full cold-load claim.
pub(crate) fn admit_cpu_speech_prepare(allowance: u64) -> Result<MemoryClaim<'static>> {
    compile_claim_with(&WORKING_BYTES, allowance, || {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            speech_prepare_headroom(
                super::ollama_prewarm_policy::verified_memory_snapshot()?,
                true,
            )
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            Ok((
                super::ollama_prewarm_policy::measured_available_memory().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        }
    })
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn speech_prepare_headroom(
    snapshot: super::ollama_prewarm_policy::MemorySnapshot,
    cpu_only: bool,
) -> Result<(u64, u64)> {
    if cpu_only {
        session_headroom(snapshot, false)
    } else {
        adaptive_headroom(snapshot)
    }
}

/// Meeting chunks wait before starting native work. An in-flight chunk keeps
/// its ownership until it finishes; dictation gets the next available turn.
///
/// A dictation taken during a recording meeting (an aside) holds new chunks
/// for all of its run, not only its final decode: a live chunk started
/// mid-aside would otherwise still own the runtime when the user stops, and
/// the aside would wait for it where standalone dictation does not. The
/// live preview catches up afterwards from its ring.
pub(crate) async fn yield_to_dictation() {
    yield_to_dictation_while(|| {
        user_is_waiting_any() || super::speech_priority::dictation_beside_meeting()
    })
    .await;
}

async fn yield_to_dictation_while(waiting: impl Fn() -> bool) {
    while waiting() {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn compile_claim_with(
    counter: &AtomicU64,
    allowance: u64,
    observation: impl Fn() -> Result<(u64, u64)>,
) -> Result<MemoryClaim<'_>> {
    anyhow::ensure!(
        allowance > 0,
        "A speech model compile needs a nonzero memory allowance"
    );
    reserve_with_observation(counter, allowance, observation)?;
    Ok(MemoryClaim {
        bytes: allowance,
        counter,
        #[cfg(feature = "diarization")]
        paused: false,
    })
}

/// Whether a dictation decode the user is waiting on is in flight.
pub(crate) fn user_is_waiting_on_speech() -> bool {
    user_is_waiting_any()
}

/// Admit a system-owned runtime whose model files and allocations are not
/// exposed to Plainsong. The allowance is a conservative budget, not a
/// measurement or a claim that dropping the lease unloads system weights.
pub(crate) fn system_runtime(allowance: u64) -> Result<LoadReservation<'static>> {
    system_runtime_with_memory(
        allowance,
        &super::native_runtime_gate::TEXT_RUNTIME,
        &WORKING_BYTES,
        super::ollama_prewarm_policy::measured_available_memory,
    )
}

/// [`system_runtime`] for Apple's speech recognizer. It takes the native
/// gate, not the text gate, so notes written by Apple's language model never
/// refuse a dictation.
pub(crate) fn system_speech_runtime(allowance: u64) -> Result<LoadReservation<'static>> {
    with_speech_precedence(|| {
        system_runtime_with_memory(
            allowance,
            &super::native_runtime_gate::NATIVE_RUNTIME,
            &WORKING_BYTES,
            super::ollama_prewarm_policy::measured_available_memory,
        )
    })
}

pub(super) fn system_runtime_with_memory<'a>(
    allowance: u64,
    gate: &'a super::native_runtime_gate::RuntimeGate,
    counter: &'a AtomicU64,
    available: impl Fn() -> Option<u64>,
) -> Result<LoadReservation<'a>> {
    let permit = gate.acquire().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        allowance > 0,
        "A system runtime needs a nonzero memory allowance"
    );
    reserve(counter, allowance, available)?;
    Ok(LoadReservation {
        _claim: MemoryClaim {
            bytes: allowance,
            counter,
            #[cfg(feature = "diarization")]
            paused: false,
        },
        _permit: Some(permit),
    })
}

/// Memory held by a built-in text helper process for as long as it runs: its
/// mapped model plus the measured context and compute buffers. The helper is
/// a separate process, so this claim is how other native loads in this
/// sidecar see it. Keeps the adaptive reserve (an eighth of RAM, 2-6 GiB)
/// while pressure is normal and the fixed 6 GiB otherwise, like the earlier
/// in-process text runtime. A scoped Light-tier notes request may use the
/// away reserve; all other native claims still count in full.
pub(crate) fn text_helper_claim(bytes: u64) -> Result<MemoryClaim<'static>> {
    crate::asr::speech_residency::release_for_heavy_work();
    text_helper_claim_with(bytes, &WORKING_BYTES, text_helper_observation)
}

fn text_helper_claim_with<'a>(
    bytes: u64,
    counter: &'a AtomicU64,
    observation: impl Fn() -> Result<(u64, u64)>,
) -> Result<MemoryClaim<'a>> {
    anyhow::ensure!(bytes > 0, "A text helper needs a nonzero memory claim");
    reserve_with_observation(counter, bytes, observation)?;
    Ok(MemoryClaim {
        bytes,
        counter,
        #[cfg(feature = "diarization")]
        paused: false,
    })
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn text_helper_reserve(snapshot: super::ollama_prewarm_policy::MemorySnapshot, away: bool) -> u64 {
    match adaptive_headroom(snapshot) {
        Ok(_) if away => super::notes_window::AWAY_RESERVE,
        Ok((_, reserve)) => reserve,
        Err(_) => WORKING_RESERVE,
    }
}

fn text_helper_observation() -> Result<(u64, u64)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let snapshot = super::ollama_prewarm_policy::verified_memory_snapshot()?;
        let available = snapshot.available_bytes;
        let reserve = text_helper_reserve(
            snapshot,
            super::notes_window::admission_active() && super::notes_window::away(),
        );
        Ok((available, reserve))
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        Ok((
            super::ollama_prewarm_policy::available_memory().context(
                "Could not verify native memory headroom: available-memory sample failed",
            )?,
            WORKING_RESERVE,
        ))
    }
}

/// Whether a text helper claim of `bytes` would be admitted right now,
/// without taking it. For status surfaces only; admission takes the claim.
pub(crate) fn text_helper_would_admit(bytes: u64) -> Option<(u64, u64)> {
    let (available, reserve) = text_helper_observation().ok()?;
    Some((
        available.saturating_sub(reserved_working_bytes()),
        bytes.saturating_add(reserve),
    ))
}

fn working_with_memory<'a>(
    paths: &[&Path],
    gate: &'a super::native_runtime_gate::RuntimeGate,
    counter: &'a AtomicU64,
    available: impl Fn() -> Option<u64>,
    host_bytes: u64,
) -> Result<LoadReservation<'a>> {
    admit_with_observation(
        paths,
        gate,
        counter,
        || {
            Ok((
                available().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        },
        NativeAllocation::Inference { host_bytes },
        NativeMemoryProfile::Standard,
    )
}

fn admit_with_observation<'a>(
    paths: &[&Path],
    gate: &'a super::native_runtime_gate::RuntimeGate,
    counter: &'a AtomicU64,
    observation: impl Fn() -> Result<(u64, u64)>,
    allocation: NativeAllocation,
    workspace: NativeMemoryProfile,
) -> Result<LoadReservation<'a>> {
    // Retain both the shared gate and the claim until the native worker exits.
    let permit = gate.acquire().map_err(anyhow::Error::msg)?;
    let model = model_bytes(paths)?;
    let bytes = match allocation {
        NativeAllocation::Constructor => workspace.constructor_bytes(model)?,
        NativeAllocation::Inference { host_bytes } => workspace
            .bytes(model)
            .checked_add(host_bytes)
            .context("The native audio working-memory budget is too large")?,
    };
    reserve_with_observation(counter, bytes, observation)?;
    Ok(LoadReservation {
        _claim: MemoryClaim {
            bytes,
            counter,
            #[cfg(feature = "diarization")]
            paused: false,
        },
        _permit: Some(permit),
    })
}

fn model_bytes(paths: &[&Path]) -> Result<u64> {
    let mut pending: Vec<PathBuf> = paths.iter().map(|path| path.to_path_buf()).collect();
    let mut directories = std::collections::HashSet::new();
    let mut total = 0u64;
    let mut visited = 0usize;
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > 4096 {
            anyhow::bail!("The model bundle contains too many files to verify its memory budget.");
        }
        let metadata =
            std::fs::metadata(&path).context("Could not inspect the native model files")?;
        if metadata.is_file() {
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| anyhow::anyhow!("The model size is too large"))?;
        } else if metadata.is_dir() {
            if !directories.insert(std::fs::canonicalize(&path)?) {
                anyhow::bail!("The model bundle contains a directory cycle.");
            }
            for entry in std::fs::read_dir(path)? {
                pending.push(entry?.path());
            }
        } else {
            anyhow::bail!("The model bundle contains an unsupported file type.");
        }
    }
    if total == 0 {
        anyhow::bail!("Could not verify the native model size.");
    }
    Ok(total)
}

/// A native operation's admission: its claim on working memory and the
/// native-runtime gate. Fields drop in order, so the claim is returned before
/// the gate opens.
pub(crate) struct LoadReservation<'a> {
    _claim: MemoryClaim<'a>,
    _permit: Option<RuntimePermit<'a>>,
}

/// Working memory counted against [`WORKING_BYTES`] until dropped.
pub(crate) struct MemoryClaim<'a> {
    bytes: u64,
    counter: &'a AtomicU64,
    #[cfg(feature = "diarization")]
    paused: bool,
}

impl MemoryClaim<'_> {
    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }
}

#[cfg(feature = "diarization")]
impl MemoryClaim<'_> {
    fn pause(&mut self) {
        if !self.paused {
            PAUSED_BYTES.fetch_add(self.bytes, Ordering::AcqRel);
            self.paused = true;
        }
    }

    fn resume(&mut self) {
        if self.paused {
            PAUSED_BYTES.fetch_sub(self.bytes, Ordering::AcqRel);
            self.paused = false;
        }
    }
}

impl Drop for MemoryClaim<'_> {
    fn drop(&mut self) {
        #[cfg(feature = "diarization")]
        if self.paused {
            PAUSED_BYTES.fetch_sub(self.bytes, Ordering::AcqRel);
        }
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// A background pass owns memory independently of its gate. While paused it
/// cannot allocate or run a network. Its claim stays reserved throughout;
/// resident foreground dictation borrows only while it holds the gate.
#[cfg(feature = "diarization")]
pub(crate) struct YieldingGate<'a> {
    gate: &'a super::native_runtime_gate::RuntimeGate,
    memory: Option<MemoryClaim<'a>>,
    permit: Option<RuntimePermit<'a>>,
    batch: Option<BackgroundBatch>,
    control: BackgroundControl,
    waiting: fn() -> bool,
    marks_background: bool,
    observation: fn() -> Result<(u64, u64)>,
}

#[cfg(feature = "diarization")]
impl<'a> LoadReservation<'a> {
    fn into_background(
        self,
        batch: BackgroundBatch,
        control: BackgroundControl,
    ) -> YieldingGate<'a> {
        YieldingGate {
            gate: &super::native_runtime_gate::NATIVE_RUNTIME,
            permit: self._permit,
            batch: Some(batch),
            memory: Some(self._claim),
            control,
            waiting: background_should_yield,
            marks_background: true,
            observation: background_headroom,
        }
    }
}

#[cfg(feature = "diarization")]
impl YieldingGate<'_> {
    #[cfg(test)]
    pub(crate) fn for_test(
        gate: &super::native_runtime_gate::RuntimeGate,
        control: BackgroundControl,
    ) -> YieldingGate<'_> {
        YieldingGate {
            gate,
            permit: Some(gate.acquire().unwrap()),
            batch: None,
            memory: None,
            control,
            waiting: background_should_yield,
            marks_background: false,
            observation: background_headroom,
        }
    }

    pub(crate) fn between_batches(&mut self) -> Result<bool> {
        // No other decode can start while this batch still holds the gate.
        let epoch = PROTECTED_DECODE_EPOCH.load(Ordering::Acquire);
        if let Some(memory) = &mut self.memory {
            memory.pause();
        }
        self.permit = None;
        self.batch = None;
        let mut yielded = false;
        loop {
            let checked_at = std::time::Instant::now();
            let observed = super::native_runtime_gate::RUNTIME_EVENT.generation();
            self.control.check()?;
            let mut external_wait = None;
            if (self.waiting)() {
                yielded = true;
            } else {
                let batch = self.marks_background.then(background_batch);
                match self.gate.acquire() {
                    Ok(permit) => {
                        // A resident decode may retain its allocated workspace
                        // in the runtime cache. Verify headroom before letting
                        // this pass grow again after it lent that workspace.
                        let admission = self
                            .memory
                            .as_mut()
                            .map(|memory| {
                                if PROTECTED_DECODE_EPOCH.load(Ordering::Acquire) != epoch {
                                    verify_reserved_headroom(memory.counter, self.observation)?;
                                }
                                memory.resume();
                                Ok::<_, anyhow::Error>(())
                            })
                            .transpose();
                        match admission {
                            Ok(_) => {
                                self.permit = Some(permit);
                                self.batch = batch;
                                return Ok(yielded);
                            }
                            Err(error) if is_headroom_refusal(&error.to_string()) => {
                                external_wait = Some(std::time::Duration::from_secs(5));
                                drop(permit);
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Err(error) if super::native_runtime_gate::is_operation_busy(error) => {
                        yielded = true;
                    }
                    Err(error) if super::native_runtime_gate::is_marker_busy(error) => {
                        external_wait = Some(std::time::Duration::from_secs(1));
                    }
                    Err(error) => anyhow::bail!(error),
                }
            }
            // Foreground pauses wait only for notifications. Only an external
            // memory or cross-process marker refusal needs a timed resample.
            let (observed, bound) = if let Some(bound) = external_wait {
                (
                    super::native_runtime_gate::RUNTIME_EVENT.generation(),
                    bound,
                )
            } else {
                (observed, self.control.remaining())
            };
            self.control.budget.spent_ms.fetch_add(
                checked_at
                    .elapsed()
                    .as_nanos()
                    .div_ceil(1_000_000)
                    .min(u64::MAX as u128) as u64,
                Ordering::AcqRel,
            );
            self.control.wait(observed, bound)?;
        }
    }

    pub(crate) fn release(&mut self) {
        self.permit = None;
        self.batch = None;
    }
}

fn guard_with_memory<'a>(
    paths: &[&Path],
    gate: &'a super::native_runtime_gate::RuntimeGate,
    counter: &'a AtomicU64,
    available: impl Fn() -> Option<u64>,
) -> Result<LoadReservation<'a>> {
    admit_with_observation(
        paths,
        gate,
        counter,
        || {
            Ok((
                available().context(
                    "Could not verify native memory headroom: available-memory sample failed",
                )?,
                WORKING_RESERVE,
            ))
        },
        NativeAllocation::Constructor,
        NativeMemoryProfile::Standard,
    )
}

pub(crate) fn guard(paths: &[&Path]) -> Result<LoadReservation<'static>> {
    with_speech_precedence(|| {
        guard_with_memory(
            paths,
            &super::native_runtime_gate::NATIVE_RUNTIME,
            &WORKING_BYTES,
            super::ollama_prewarm_policy::measured_available_memory,
        )
    })
}

/// Wait for active native work to finish before dropping a cached runtime.
///
/// Only ordinary operation contention is retryable. Durable marker or storage
/// failures stay fail-closed, matching every other user of the runtime gate.
async fn acquire_cleanup_gate_from(
    gate: &super::native_runtime_gate::RuntimeGate,
) -> Result<RuntimePermit<'_>> {
    gate.acquire_when_available()
        .await
        .map_err(anyhow::Error::msg)
}

pub(crate) async fn acquire_cleanup_gate() -> Result<RuntimePermit<'static>> {
    acquire_cleanup_gate_from(&super::native_runtime_gate::NATIVE_RUNTIME).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resident_meeting_speech_survives_warning_pressure_without_changing_load_reserves() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        for physical in [8 * GIB, 16 * GIB] {
            for available in [3 * GIB / 2, 3 * GIB] {
                for live in [false, true] {
                    let counter = AtomicU64::new(0);
                    let lease =
                        neural_engine_speech_with(&counter, 192 * MIB + 16 * 160_000, || {
                            speech_headroom_from(
                                snapshot(available, physical, 2),
                                false,
                                live,
                                true,
                                false,
                            )
                        })
                        .unwrap();
                    assert!(counter.load(Ordering::Acquire) > 0);
                    drop(lease);
                    assert_eq!(counter.load(Ordering::Acquire), 0);
                    // The same request must not start a new model at warning.
                    assert!(speech_headroom_from(
                        snapshot(available, physical, 2),
                        false,
                        live,
                        false,
                        false
                    )
                    .is_err());
                }
            }
        }
        for resident in [false, true] {
            assert!(speech_headroom_from(
                snapshot(8 * GIB, 8 * GIB, 4),
                false,
                true,
                resident,
                false
            )
            .is_err());
            assert!(
                speech_headroom_from(snapshot(8 * GIB, 0, 1), false, true, resident, false)
                    .is_err()
            );
        }
        // A resident decode still counts competing claims and its full margin.
        let counter = AtomicU64::new(GIB);
        let error = neural_engine_speech_with(&counter, 192 * MIB, || {
            speech_headroom_from(snapshot(3 * GIB / 2, 8 * GIB, 2), false, true, true, false)
        })
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains(INSUFFICIENT_HEADROOM));
        assert!(error.contains("existing_claims_bytes=1073741824"));
        assert_eq!(counter.load(Ordering::Acquire), GIB);
    }

    #[test]
    fn pressure_deferrals_and_unreadable_counters_have_distinct_retryable_causes() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for pressure in [2, 4] {
            let message = adaptive_headroom(snapshot(3 * GIB, 8 * GIB, pressure))
                .unwrap_err()
                .to_string();
            assert!(message.contains(PRESSURE_DEFERRED));
            assert!(message.contains(&format!("pressure_level: {pressure}")));
            assert!(message.contains("available_bytes: 3221225472"));
            assert!(!message.contains(UNVERIFIED_HEADROOM));
            assert!(is_headroom_refusal(&format!(
                "Search helper job did not complete: {message}"
            )));
        }
        for state in [
            snapshot(3 * GIB, 0, 1),
            snapshot(9 * GIB, 8 * GIB, 1),
            snapshot(3 * GIB, 8 * GIB, 0),
        ] {
            let message = adaptive_headroom(state).unwrap_err().to_string();
            assert!(message.contains(UNVERIFIED_HEADROOM));
            assert!(is_headroom_refusal(&message));
        }
    }

    #[test]
    fn a_speech_model_compile_reserves_only_its_own_memory() {
        let counter = AtomicU64::new(0);
        // A bare memory claim: no text-runtime permit rides along with it.
        let claim: MemoryClaim<'_> =
            compile_claim_with(&counter, 1_000, || Ok((10_000, 0))).unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1_000);
        assert!(compile_claim_with(&counter, 9_500, || Ok((10_000, 0))).is_err());
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        assert!(compile_claim_with(&counter, 1_000, || Err(anyhow::anyhow!(
            UNVERIFIED_HEADROOM
        )))
        .is_err());
        assert!(compile_claim_with(&counter, 0, || Ok((10_000, 0))).is_err());
    }

    /// A notes request holds the text runtime for its whole helper request.
    async fn notes_request_in_flight() -> RuntimePermit<'static> {
        super::super::native_runtime_gate::TEXT_RUNTIME
            .acquire_when_available()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn neural_engine_speech_starts_while_notes_are_being_written() {
        let _notes = notes_request_in_flight().await;
        let counter = AtomicU64::new(0);
        let started = std::time::Instant::now();
        let admission = neural_engine_speech_with(&counter, 1_000, || Ok((10_000, 0)))
            .expect("notes must not refuse the Neural Engine speech helper");
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
        assert_eq!(counter.load(Ordering::Acquire), 1_000);
        drop(admission);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn a_dictation_is_admitted_while_notes_are_being_written() {
        let _notes = notes_request_in_flight().await;
        // Generous only because other tests share the native gate; with the
        // notes request holding the gate dictation used to wait for, this
        // timed out however long it was.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        wait_for_dictation_admission(deadline)
            .await
            .expect("dictation does not wait for notes");
    }

    #[test]
    fn speech_refused_for_memory_stops_notes_and_is_admitted_once_they_end() {
        use super::super::speech_priority::Precedence;
        let precedence = Precedence::new(|| crate::hardware_tier::HardwareTier::Best);
        precedence.set_dictation(true);
        let stop = super::super::bundled_local::CancelFlag::new();
        let notes = precedence.begin_background(3_902_210_048, &stop).unwrap();
        let ended = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            // Stands in for the notes worker: ends its helper once stopped.
            scope.spawn(|| {
                while !notes.yielded() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                ended.store(true, Ordering::SeqCst);
                drop(notes);
            });
            let started = std::time::Instant::now();
            let attempts = std::sync::atomic::AtomicUsize::new(0);
            let admitted = speech_precedence_with(
                &precedence,
                false,
                || false,
                || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    if ended.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(anyhow::anyhow!(INSUFFICIENT_HEADROOM))
                    }
                },
            );
            assert!(admitted.is_ok());
            assert_eq!(attempts.load(Ordering::SeqCst), 2);
            assert!(started.elapsed() < PREEMPT_WAIT_BOUND);
        });
        assert_eq!(precedence.background_count(), 0);
    }

    const PREEMPT_WAIT_BOUND: std::time::Duration =
        super::super::speech_priority::PREEMPT_RELEASE_WAIT;

    #[test]
    fn without_live_speech_a_memory_refusal_leaves_notes_alone() {
        use super::super::speech_priority::Precedence;
        let precedence = Precedence::new(|| crate::hardware_tier::HardwareTier::Light);
        let stop = super::super::bundled_local::CancelFlag::new();
        let notes = precedence.begin_background(1, &stop).unwrap();
        let refused: Result<()> = speech_precedence_with(
            &precedence,
            false,
            || true,
            || Err(anyhow::anyhow!(INSUFFICIENT_HEADROOM)),
        );
        assert!(refused.is_err());
        assert!(!notes.yielded());
        // Not a memory refusal: nothing is stopped even while speech runs.
        let notes_fit = Precedence::new(|| crate::hardware_tier::HardwareTier::Best);
        notes_fit.set_dictation(true);
        let other = super::super::bundled_local::CancelFlag::new();
        let kept = notes_fit.begin_background(1, &other).unwrap();
        let failed: Result<()> =
            speech_precedence_with(&notes_fit, true, || true, || anyhow::bail!("bad audio"));
        assert!(failed.is_err());
        assert!(!kept.yielded());
    }

    #[cfg(feature = "diarization")]
    fn test_background_control() -> BackgroundControl {
        BackgroundControl {
            cancelled: Default::default(),
            budget: BackgroundWaitBudget {
                spent_ms: Default::default(),
                limit: std::time::Duration::from_secs(600),
            },
        }
    }

    #[tokio::test]
    async fn dictation_admission_obeys_its_deadline_across_the_gate_await() {
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let held = gate.acquire().unwrap();
        let started = std::time::Instant::now();
        let error = wait_for_dictation_admission_from(
            &gate,
            started + std::time::Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert!(super::super::native_runtime_gate::is_operation_busy(
            &error.to_string()
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        drop(held);
        assert!(wait_for_dictation_admission_from(&gate, started)
            .await
            .is_err());
    }

    #[test]
    fn foreground_work_asks_background_batches_to_yield() {
        let _batch = background_batch();
        let foreground = foreground_work();
        assert!(background_should_yield());
        drop(foreground);
    }

    /// A long community-1 pass hands the gate to a dictation decode between
    /// batches, and takes it back once the decode is done.
    #[cfg(feature = "diarization")]
    #[test]
    fn a_waiting_dictation_gets_the_gate_between_batches_of_a_long_diarization() {
        use std::sync::atomic::AtomicBool;
        use std::time::{Duration, Instant};
        static GATE: super::super::native_runtime_gate::RuntimeGate =
            super::super::native_runtime_gate::RuntimeGate::new();
        static WAITING: AtomicBool = AtomicBool::new(false);
        const BATCHES: usize = 150;
        const BATCH: Duration = Duration::from_millis(20);

        let mut turn = YieldingGate {
            gate: &GATE,
            permit: Some(GATE.acquire().unwrap()),
            batch: None,
            marks_background: false,
            observation: background_headroom,
            waiting: || WAITING.load(Ordering::Acquire),
            memory: None,
            control: test_background_control(),
        };
        let (paused, waited) = std::thread::scope(|scope| {
            let dictation = scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(200));
                // The decode marks itself waiting, then polls the gate the way
                // the dictation stop does (try-acquire, retry on busy).
                WAITING.store(true, Ordering::Release);
                let asked = Instant::now();
                let permit = loop {
                    match GATE.acquire() {
                        Ok(permit) => break permit,
                        Err(error) => {
                            assert!(super::super::native_runtime_gate::is_operation_busy(error));
                            std::thread::sleep(Duration::from_millis(10));
                        }
                    }
                };
                let waited = asked.elapsed();
                std::thread::sleep(Duration::from_millis(100));
                drop(permit);
                WAITING.store(false, Ordering::Release);
                super::super::native_runtime_gate::RUNTIME_EVENT.notify();
                waited
            });
            let mut paused = 0;
            for _ in 0..BATCHES {
                std::thread::sleep(BATCH);
                if turn.between_batches().unwrap() {
                    paused += 1;
                }
            }
            (paused, dictation.join().unwrap())
        });
        assert_eq!(paused, 1, "the pass waited once, for the one decode");
        assert!(
            waited < Duration::from_millis(500),
            "the decode waited {waited:?} for the gate"
        );
        // The pass holds the gate again, so other work still waits for it...
        assert!(GATE.acquire().is_err());
        // ...until it has no network left to run.
        turn.release();
        drop(GATE.acquire().unwrap());
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn a_paused_pass_stops_when_its_wait_budget_is_exhausted() {
        use std::time::Duration;
        static GATE: super::super::native_runtime_gate::RuntimeGate =
            super::super::native_runtime_gate::RuntimeGate::new();
        let mut turn = YieldingGate {
            gate: &GATE,
            permit: Some(GATE.acquire().unwrap()),
            batch: None,
            marks_background: false,
            observation: background_headroom,
            waiting: || true,
            memory: None,
            control: test_background_control(),
        };
        turn.control.budget.limit = Duration::from_millis(30);
        let error = turn.between_batches().unwrap_err();
        assert!(error.to_string().contains("Meeting wait budget exhausted"));
        // It gave the gate up rather than keep it while giving up.
        drop(GATE.acquire().unwrap());
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn a_paused_claim_protects_resident_dictation_without_releasing_live_allocations() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let background_bytes = 1770 * GIB / 1000;
        let counter = AtomicU64::new(background_bytes);
        let mut claim = MemoryClaim {
            bytes: background_bytes,
            counter: &counter,
            paused: false,
        };
        claim.pause();
        assert_eq!(counter.load(Ordering::Acquire), background_bytes);
        let workspace = 689 * GIB / 1000;
        // 2.5 GiB available and a 1.689 GiB resident decode, including margin.
        assert!(
            reserve_with_observation(&counter, workspace, || session_headroom(
                snapshot(5 * GIB / 2, 24 * GIB, 1),
                true
            ))
            .is_err()
        );
        assert!(
            reserve_with_observation(&counter, workspace, || {
                protected_session_headroom(snapshot(workspace + GIB - 1, 24 * GIB, 1), true)
            })
            .is_err(),
            "borrowing never reduces the decode's own workspace and margin"
        );
        reserve_with_observation(&counter, workspace, || {
            protected_session_headroom(snapshot(5 * GIB / 2, 24 * GIB, 1), true)
        })
        .unwrap();
        assert_eq!(
            counter.load(Ordering::Acquire),
            background_bytes + workspace
        );
        counter.fetch_sub(workspace, Ordering::AcqRel);
        // Cold construction never borrows a paused pass's reservation.
        assert!(
            reserve_with_observation(&counter, workspace, || protected_session_headroom(
                snapshot(5 * GIB / 2, 24 * GIB, 1),
                false
            ))
            .is_err()
        );
        claim.resume();
        assert_eq!(counter.load(Ordering::Acquire), background_bytes);
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn background_resume_refuses_growth_if_a_foreground_cache_retains_workspace() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let counter = AtomicU64::new(1770 * GIB / 1000);
        assert!(verify_reserved_headroom(&counter, || Ok((2 * GIB, 3 * GIB))).is_err());
        assert!(
            verify_reserved_headroom(&counter, || Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)))
                .is_err()
        );
        verify_reserved_headroom(&counter, || Ok((5 * GIB, 3 * GIB))).unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1770 * GIB / 1000);
    }

    #[cfg(feature = "diarization")]
    #[tokio::test]
    async fn batch_waits_spend_the_recordings_existing_budget_and_exhaustion_is_terminal() {
        use std::time::Duration;
        let spent = std::sync::Arc::new(AtomicU64::new(580));
        let control =
            with_background_wait_budget(spent.clone(), Duration::from_millis(600), async {
                let (_cancel, control) = background_job();
                // Retain a control independent of that async caller for this wait test.
                BackgroundControl {
                    cancelled: Default::default(),
                    ..control
                }
            })
            .await;
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let mut turn = YieldingGate::for_test(&gate, control);
        turn.waiting = || true;
        let error = turn.between_batches().unwrap_err();
        assert!(error.to_string().contains("Meeting wait budget exhausted"));
        assert!(spent.load(Ordering::Acquire) >= 600);
        assert!(
            !crate::llm::native_runtime_is_busy(&error.to_string()),
            "exhausted passes must not restart from scratch"
        );
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn another_track_spending_the_shared_budget_wakes_a_paused_pass() {
        use std::time::{Duration, Instant};
        let control = test_background_control();
        let spent = control.budget.spent_ms.clone();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                spent.store(600_000, Ordering::Release);
                notify_background_waiters();
            });
            let started = Instant::now();
            // Unrelated events may also notify; continue until this recording's
            // other track has consumed the budget.
            let error = loop {
                let observed = super::super::native_runtime_gate::RUNTIME_EVENT.generation();
                if let Err(error) = control.wait(observed, control.remaining()) {
                    break error;
                }
            };
            assert!(error.to_string().contains("Meeting wait budget exhausted"));
            assert!(started.elapsed() < Duration::from_secs(1));
        });
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn cancellation_wakes_a_paused_worker_without_waiting_for_the_budget() {
        use std::time::{Duration, Instant};
        let (cancel, control) = background_job();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let mut turn = YieldingGate::for_test(&gate, control);
        turn.waiting = || true;
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                drop(cancel);
            });
            let started = Instant::now();
            let error = turn.between_batches().unwrap_err();
            assert!(error.to_string().contains("cancelled"));
            assert!(started.elapsed() < Duration::from_secs(1));
        });
    }

    #[test]
    fn community1_budget_covers_its_measured_peaks_with_margin() {
        const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
        // (audio seconds, measured peak physical footprint in bytes), M4 Pro
        // release build, embeddings on the GPU: the shortest, a middle and the
        // longest AMI recording through meeting-eval, and the two 75-minute
        // concatenations through community1-eval.
        for (seconds, peak) in [
            (838.8, 786_810_248u64),
            (1_049.4, 799_688_096),
            (2_345.5, 897_648_176),
            (2_972.3, 938_460_672),
            (4_498.2, 1_038_616_136),
            (4_503.2, 1_041_319_592),
        ] {
            let budget = NativeMemoryProfile::Standard.bytes(32 * 1024 * 1024)
                + community1_working_bytes(seconds);
            let ratio = budget as f64 / peak as f64;
            assert!(
                (1.15..1.35).contains(&ratio),
                "{seconds} s: budget {:.2} GiB for a {:.2} GiB peak",
                budget as f64 / GIB,
                peak as f64 / GIB
            );
        }
        assert_eq!(community1_working_bytes(f64::NAN), COMMUNITY1_FIXED_BYTES);
        assert_eq!(community1_working_bytes(-5.0), COMMUNITY1_FIXED_BYTES);
    }

    #[test]
    fn a_speaker_embedder_admits_on_the_adaptive_reserve_the_fixed_rule_refused() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-speaker-embedding-admission-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // The pinned ECAPA-TDNN is 24,861,931 bytes; a sparse stand-in of the
        // same length is all the budget reads.
        let model = dir.join("ecapa_tdnn_speaker.onnx");
        std::fs::File::create(&model)
            .unwrap()
            .set_len(24_861_931)
            .unwrap();
        // A two-hour meeting decoded to 16 kHz f32.
        let audio = 2 * 60 * 60 * 16_000 * 4;
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(0);
        // A 16 GiB Mac with 4 GiB reclaimable while the meeting's speech model
        // is resident.
        let adaptive = || adaptive_headroom(snapshot(4 * GIB, 16 * GIB, 1));
        let fixed = || Ok((4 * GIB, WORKING_RESERVE));
        for load in [true, false] {
            let allocation = || {
                if load {
                    NativeAllocation::Constructor
                } else {
                    NativeAllocation::Inference { host_bytes: audio }
                }
            };
            assert!(admit_with_observation(
                &[model.as_path()],
                &gate,
                &counter,
                fixed,
                allocation(),
                NativeMemoryProfile::Standard
            )
            .is_err());
            let lease = admit_with_observation(
                &[model.as_path()],
                &gate,
                &counter,
                adaptive,
                allocation(),
                NativeMemoryProfile::Standard,
            )
            .expect("adaptive reserve admits");
            assert!(counter.load(Ordering::Acquire) >= 71 * MIB);
            drop(lease);
            assert_eq!(counter.load(Ordering::Acquire), 0);
        }
        // Raised pressure still refuses, whatever is free.
        assert!(adaptive_headroom(snapshot(12 * GIB, 16 * GIB, 2)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn both_headroom_refusals_are_recognised_through_provider_wrapping() {
        let counter = AtomicU64::new(0);
        let short = reserve_with_observation(&counter, 1, || Ok((0, 1))).unwrap_err();
        let unverified =
            reserve_with_observation(&counter, 1, || Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)))
                .unwrap_err();
        for error in [short, unverified] {
            let wrapped = format!("Chunk 3 failed at 179.6s: NVIDIA Parakeet failed: {error:#}");
            assert!(is_headroom_refusal(&wrapped), "{wrapped}");
        }
        assert!(!is_headroom_refusal(
            "Parakeet model files failed their integrity check."
        ));
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[test]
    fn calibrated_prewarm_matches_the_load_admission() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let parakeet = NativeMemoryProfile::ParakeetV3;
        // 640 MiB x3 constructor plus a 3 GiB reserve on a 24 GiB Mac.
        let required = 1920 * MIB + 3 * GIB;
        assert!(calibrated_prewarm_fits(
            640.0,
            parakeet,
            Some(snapshot(required, 24 * GIB, 1)),
            0
        ));
        assert!(!calibrated_prewarm_fits(
            640.0,
            parakeet,
            Some(snapshot(required - 1, 24 * GIB, 1)),
            0
        ));
        // Other native claims count, raised pressure and unknown memory defer.
        assert!(!calibrated_prewarm_fits(
            640.0,
            parakeet,
            Some(snapshot(required, 24 * GIB, 1)),
            1
        ));
        assert!(!calibrated_prewarm_fits(
            640.0,
            parakeet,
            Some(snapshot(64 * GIB, 24 * GIB, 2)),
            0
        ));
        assert!(!calibrated_prewarm_fits(640.0, parakeet, None, 0));
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(!calibrated_prewarm_fits(
                invalid,
                parakeet,
                Some(snapshot(64 * GIB, 64 * GIB, 1)),
                0
            ));
        }
        // The old fixed 6 GiB rule refused this common 16 GiB case.
        let sixteen = 1920 * MIB + 2 * GIB;
        assert!(calibrated_prewarm_fits(
            640.0,
            parakeet,
            Some(snapshot(sixteen, 16 * GIB, 1)),
            0
        ));
        assert!(
            !super::super::ollama_prewarm_policy::speech_prewarm_has_headroom(640.0, Some(sixteen))
        );
    }

    #[test]
    fn moonshine_profile_covers_measured_constructor_and_workspaces() {
        const MIB: u64 = 1024 * 1024;
        let profile = NativeMemoryProfile::MoonshineStreaming;
        assert_eq!(
            profile.constructor_bytes(295_793_568).unwrap(),
            1_183_174_272
        );
        assert!(profile.constructor_bytes(u64::MAX / 4 + 1).is_err());
        assert_eq!(profile.bytes(295_793_568), 512 * MIB);
        assert_eq!(profile.bytes(295_793_568) + 1536 * MIB, 2048 * MIB);
        assert_eq!(
            NativeMemoryProfile::Standard
                .constructor_bytes(295_793_568)
                .unwrap(),
            887_380_704
        );
        assert_eq!(NativeMemoryProfile::Standard.bytes(295_793_568), 256 * MIB);
    }

    #[test]
    fn moonshine_workspace_counts_other_claims_and_refuses_pressure() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-moonshine-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("weights"), [0u8; 10]).unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(4096);
        let required = 5 * GIB + 4096;
        for observation in [
            adaptive_headroom(snapshot(required - 1, 24 * GIB, 1)),
            adaptive_headroom(snapshot(required, 24 * GIB, 2)),
            Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)),
        ] {
            assert!(admit_with_observation(
                &[&dir],
                &gate,
                &counter,
                || observation
                    .as_ref()
                    .copied()
                    .map_err(|error| anyhow::anyhow!("{error}")),
                NativeAllocation::Inference {
                    host_bytes: 1536 * 1024 * 1024
                },
                NativeMemoryProfile::MoonshineStreaming
            )
            .is_err());
            assert_eq!(counter.load(Ordering::Acquire), 4096);
        }
        let lease = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(required, 24 * GIB, 1)),
            NativeAllocation::Inference {
                host_bytes: 1536 * 1024 * 1024,
            },
            NativeMemoryProfile::MoonshineStreaming,
        )
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 4096 + 2 * GIB);
        assert!(gate.acquire().is_err());
        drop(lease);
        assert_eq!(counter.load(Ordering::Acquire), 4096);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "asr-transcribe-cpp")]
    #[test]
    fn parakeet_gguf_profile_admits_on_the_adaptive_reserve_the_fixed_rule_refused() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        // The pinned parakeet-tdt-0.6b-v3-Q8_0.gguf.
        let model = 739_508_576_u64;
        let profile = calibrated_workspace(
            crate::asr::AsrProviderType::TranscribeCpp,
            "parakeet-tdt-0.6b-v3-q8_0",
        );
        assert_eq!(profile, NativeMemoryProfile::ParakeetGguf);
        assert_eq!(profile.constructor_bytes(model).unwrap(), 3 * model);
        assert_eq!(profile.bytes(model), model);
        assert_eq!(NativeMemoryProfile::Standard.bytes(model), model / 2);
        // A busy 24 GiB Mac with 6 GiB available: the fixed rule needed
        // 3x the model plus 6 GiB; the calibrated one needs a 3 GiB reserve.
        let available = 6 * GIB;
        let model_mib = model as f64 / MIB as f64;
        assert!(calibrated_prewarm_fits(
            model_mib,
            profile,
            Some(snapshot(available, 24 * GIB, 1)),
            0
        ));
        assert!(
            !super::super::ollama_prewarm_policy::speech_prewarm_has_headroom(
                model_mib,
                Some(available)
            )
        );
        // Raised pressure and unknown memory still defer it.
        assert!(!calibrated_prewarm_fits(
            model_mib,
            profile,
            Some(snapshot(64 * GIB, 24 * GIB, 2)),
            0
        ));
        assert!(!calibrated_prewarm_fits(model_mib, profile, None, 0));
    }

    #[test]
    fn parakeet_gguf_long_workspace_counts_other_claims_until_drop() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-parakeet-gguf-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("weights"))
            .unwrap()
            .set_len(705 * MIB)
            .unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(4096);
        let long_audio = NativeAllocation::Inference {
            host_bytes: 1536 * MIB,
        };
        // 705 MiB model + 1.5 GiB long-audio workspace + 3 GiB reserve.
        let required = 705 * MIB + 1536 * MIB + 3 * GIB + 4096;
        for observation in [
            adaptive_headroom(snapshot(required - 1, 24 * GIB, 1)),
            adaptive_headroom(snapshot(required, 24 * GIB, 2)),
            Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)),
        ] {
            assert!(admit_with_observation(
                &[&dir],
                &gate,
                &counter,
                || observation
                    .as_ref()
                    .copied()
                    .map_err(|error| anyhow::anyhow!("{error}")),
                NativeAllocation::Inference {
                    host_bytes: 1536 * MIB
                },
                NativeMemoryProfile::ParakeetGguf
            )
            .is_err());
            assert_eq!(counter.load(Ordering::Acquire), 4096);
        }
        let lease = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(required, 24 * GIB, 1)),
            long_audio,
            NativeMemoryProfile::ParakeetGguf,
        )
        .unwrap();
        assert_eq!(
            counter.load(Ordering::Acquire),
            4096 + 705 * MIB + 1536 * MIB
        );
        assert!(gate.acquire().is_err());
        drop(lease);
        assert_eq!(counter.load(Ordering::Acquire), 4096);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn whistle_constructor_covers_the_native_child_without_changing_other_models() {
        const MIB: u64 = 1024 * 1024;
        assert_eq!(
            NativeMemoryProfile::Whistle
                .constructor_bytes(17 * MIB)
                .unwrap(),
            256 * MIB
        );
        assert_eq!(
            NativeMemoryProfile::Standard
                .constructor_bytes(17 * MIB)
                .unwrap(),
            51 * MIB
        );
        assert!(NativeMemoryProfile::Whistle
            .constructor_bytes(u64::MAX)
            .is_err());
    }

    #[test]
    fn calibrated_asr_requires_the_exact_provider_and_model_pair() {
        use crate::asr::AsrProviderType;
        for (provider, model) in [
            (AsrProviderType::Whisper, "base.en"),
            (AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v3"),
            (AsrProviderType::Whistle, "whistle-2.0.0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (
                AsrProviderType::TranscribeCpp,
                "moonshine-streaming-medium-q8_0",
            ),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "parakeet-tdt-0.6b-v3-q8_0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "fluid-speech-mini-q8_0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "underdog-bark-3.0-pro-q8_0"),
        ] {
            assert!(calibrated_asr(provider, model));
            assert_eq!(
                calibrated_workspace(provider, model),
                if provider == AsrProviderType::Parakeet {
                    NativeMemoryProfile::ParakeetV3
                } else if provider == AsrProviderType::Whistle {
                    NativeMemoryProfile::Whistle
                } else if matches!(
                    model,
                    "parakeet-tdt-0.6b-v3-q8_0"
                        | "fluid-speech-mini-q8_0"
                        | "underdog-bark-3.0-pro-q8_0"
                ) {
                    NativeMemoryProfile::ParakeetGguf
                } else if model == "moonshine-streaming-medium-q8_0" {
                    NativeMemoryProfile::MoonshineStreaming
                } else {
                    NativeMemoryProfile::Standard
                }
            );
        }
        for (provider, model) in [
            (AsrProviderType::Whistle, "whistle-2.0.0-extra"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (
                AsrProviderType::TranscribeCpp,
                "moonshine-streaming-medium-Q8_0",
            ),
            (
                AsrProviderType::Moonshine,
                "moonshine-streaming-medium-q8_0",
            ),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "parakeet-tdt-0.6b-v3-Q8_0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "parakeet-tdt-0.6b-v3"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "orukeet-r3-q8_0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "fluid-speech-mini-Q8_0"),
            #[cfg(feature = "asr-transcribe-cpp")]
            (AsrProviderType::TranscribeCpp, "underdog-bark-3.0-pro"),
            (AsrProviderType::Parakeet, "fluid-speech-mini-q8_0"),
            (AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v3-q8_0"),
            (AsrProviderType::Whisper, "tiny.en"),
            (AsrProviderType::Whisper, "BASE.EN"),
            (AsrProviderType::Whisper, "base.en-extra"),
            (AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v2"),
            (AsrProviderType::Parakeet, "orukeet-v0.1.0-int8"),
            (AsrProviderType::Parakeet, "parakeet-tdt-ctc-110m"),
            (AsrProviderType::Moonshine, "moonshine-base"),
            (AsrProviderType::Moonshine, "moonshine-tiny"),
            (AsrProviderType::Moonshine, "base.en"),
            (AsrProviderType::WhisperCandle, "base.en"),
        ] {
            assert!(!calibrated_asr(provider, model));
            assert_eq!(
                calibrated_workspace(provider, model),
                NativeMemoryProfile::Standard
            );
        }
    }

    /// The provider keys its calibrated budget by this list, so admission has
    /// to agree: each entry loads and decodes on the `ParakeetGguf` profile,
    /// and with it the resident-decode margin in `session_headroom`.
    #[cfg(feature = "asr-transcribe-cpp")]
    #[test]
    fn every_parakeet_shaped_gguf_route_shares_the_gguf_profile() {
        use crate::asr::AsrProviderType;
        let models = crate::asr::transcribe_cpp::PARAKEET_GGUF_SHAPED_MODEL_IDS;
        assert_eq!(models.len(), 3);
        for model in models {
            assert!(
                calibrated_asr(AsrProviderType::TranscribeCpp, model),
                "{model}"
            );
            assert_eq!(
                calibrated_workspace(AsrProviderType::TranscribeCpp, model),
                NativeMemoryProfile::ParakeetGguf,
                "{model}"
            );
        }
    }

    /// The route a new install dictates on must warm and load through its
    /// measured reserve, as ONNX Parakeet's does, rather than the fixed 6 GiB
    /// rule that defers the launch prewarm on a busy 16-24 GB Mac.
    #[test]
    fn every_fresh_install_dictation_default_has_a_calibrated_admission() {
        let (provider, model) = crate::settings::fresh_install_dictation_route()
            .map(|(provider, model)| {
                (
                    crate::asr_provider_from_settings_value(provider)
                        .expect("the fresh-install provider is compiled in"),
                    model,
                )
            })
            .unwrap_or((
                crate::asr::AsrProviderType::Parakeet,
                "parakeet-tdt-0.6b-v3",
            ));
        assert!(calibrated_asr(provider, model));
        assert_ne!(
            calibrated_workspace(provider, model),
            NativeMemoryProfile::Standard
        );
    }

    #[test]
    fn parakeet_workspace_admits_the_full_model_and_host_budget_until_drop() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-parakeet-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("weights"))
            .unwrap()
            .set_len(600 * MIB)
            .unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(1024);
        let required = 3 * GIB + 1024 + 616 * MIB;
        let workspace = calibrated_workspace(
            crate::asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3",
        );
        assert_eq!(workspace.bytes(600 * MIB), 600 * MIB);
        assert_eq!(workspace.bytes(1), 256 * MIB);
        assert_eq!(NativeMemoryProfile::Standard.bytes(600 * MIB), 300 * MIB);
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(required - 1, 24 * GIB, 1)),
            NativeAllocation::Inference {
                host_bytes: 16 * MIB
            },
            workspace,
        )
        .is_err());
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        assert!(gate.acquire().is_ok());
        let claim = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(required, 24 * GIB, 1)),
            NativeAllocation::Inference {
                host_bytes: 16 * MIB,
            },
            workspace,
        )
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1024 + 616 * MIB);
        assert!(gate.acquire().is_err());
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || Ok((u64::MAX, 0)),
            NativeAllocation::Inference {
                host_bytes: u64::MAX
            },
            workspace,
        )
        .is_err());
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn snapshot(
        available: u64,
        physical: u64,
        pressure: i32,
    ) -> super::super::ollama_prewarm_policy::MemorySnapshot {
        super::super::ollama_prewarm_policy::MemorySnapshot {
            available_bytes: available,
            physical_bytes: physical,
            pressure_level: pressure,
        }
    }

    #[test]
    fn adaptive_reserve_clamps_and_refuses_unverified_host_state() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for (physical, reserve) in [(8, 2), (16, 2), (24, 3), (48, 6), (96, 6)] {
            assert_eq!(
                adaptive_headroom(snapshot(7 * GIB, physical * GIB, 1)).unwrap(),
                (7 * GIB, reserve * GIB)
            );
        }
        for pressure in [0, 2, 4, 3, -1] {
            assert!(adaptive_headroom(snapshot(7 * GIB, 24 * GIB, pressure)).is_err());
        }
        assert!(adaptive_headroom(snapshot(GIB, 0, 1)).is_err());
        assert!(adaptive_headroom(snapshot(25 * GIB, 24 * GIB, 1)).is_err());
    }

    #[test]
    fn session_headroom_admits_user_speech_at_warning_but_not_critical_pressure() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for pressure in [1, 2] {
            // A load keeps the adaptive reserve; a resident decode keeps 1 GiB.
            assert_eq!(
                session_headroom(snapshot(5 * GIB, 24 * GIB, pressure), false).unwrap(),
                (5 * GIB, 3 * GIB)
            );
            assert_eq!(
                session_headroom(snapshot(5 * GIB, 24 * GIB, pressure), true).unwrap(),
                (5 * GIB, GIB)
            );
        }
        for pressure in [0, 4, 3, -1] {
            assert!(session_headroom(snapshot(5 * GIB, 24 * GIB, pressure), true).is_err());
            assert!(session_headroom(snapshot(5 * GIB, 24 * GIB, pressure), false).is_err());
        }
        assert!(session_headroom(snapshot(GIB, 0, 2), true).is_err());
        assert!(session_headroom(snapshot(25 * GIB, 24 * GIB, 2), true).is_err());
        // Background warm-ups and optional cleanup still defer at warning.
        assert!(adaptive_headroom(snapshot(5 * GIB, 24 * GIB, 2)).is_err());
    }

    #[test]
    fn an_8_gb_mac_beside_a_call_keeps_dictation_and_live_meetings_working() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        // Free memory beside Zoom, a browser and Slack (realistic-8gb plan).
        let typical = 7 * GIB / 4;
        let light = |pressure| snapshot(typical, 8 * GIB, pressure);
        // A load claim between the Light tier's CPU speech load (320 MiB
        // cold, 256 + 160 MiB warm with the vocabulary model) and the
        // Neural Engine route's (1.3 GiB cold, 1152 + 160 MiB warm, which
        // only 12 GB-and-up Macs run): this much still fits beside a call.
        let cold_load = GIB + 160 * MIB;
        // A decode on a helper that holds both models: 128 + 64 MiB + audio.
        let warm_decode = 192 * MIB + 16 * 160_000;
        let fits = |observation: Result<(u64, u64)>, bytes: u64| {
            let counter = AtomicU64::new(0);
            reserve_with_observation(&counter, bytes, || {
                observation
                    .as_ref()
                    .copied()
                    .map_err(|error| anyhow::anyhow!("{error}"))
            })
            .is_ok()
        };
        // Normal pressure: dictation the user waits on, cold or warm, and
        // live meeting speech fit beside the call.
        assert_eq!(
            session_headroom(light(1), false).unwrap(),
            (typical, 512 * MIB)
        );
        assert!(fits(session_headroom(light(1), false), cold_load));
        assert!(fits(session_headroom(light(1), true), warm_decode));
        assert_eq!(
            live_speech_headroom(light(1)).unwrap(),
            (typical, 512 * MIB)
        );
        assert!(fits(live_speech_headroom(light(1)), cold_load));
        // Under the old 2 GiB floor neither load fit.
        assert!(!fits(adaptive_headroom(light(1)), cold_load));
        // What a load leaves free still admits the next warm dictation.
        let after_load = snapshot(typical - GIB, 8 * GIB, 1);
        assert!(fits(session_headroom(after_load, true), warm_decode));
        // Warning pressure keeps the full reserve for a load and the 1 GiB
        // margin for a resident decode; live meeting speech waits.
        assert_eq!(
            session_headroom(light(2), false).unwrap(),
            (typical, 2 * GIB)
        );
        assert_eq!(session_headroom(light(2), true).unwrap(), (typical, GIB));
        assert!(!fits(session_headroom(light(2), false), cold_load));
        assert!(live_speech_headroom(light(2)).is_err());
        // Critical pressure and an unreadable host still refuse.
        assert!(session_headroom(light(4), true).is_err());
        assert!(live_speech_headroom(light(4)).is_err());
        assert!(session_headroom(snapshot(9 * GIB, 8 * GIB, 1), true).is_err());
        // Larger Macs and background work are unchanged.
        assert_eq!(
            session_headroom(snapshot(typical, 16 * GIB, 1), false).unwrap(),
            (typical, 2 * GIB)
        );
        assert_eq!(
            live_speech_headroom(snapshot(typical, 16 * GIB, 1)).unwrap(),
            (typical, 2 * GIB)
        );
        assert_eq!(adaptive_headroom(light(1)).unwrap(), (typical, 2 * GIB));
    }

    #[test]
    fn cpu_prepare_at_warning_pressure_requires_its_cold_claim_and_reserve() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let counter = AtomicU64::new(0);
        let claim = 320 * 1024 * 1024;
        let available = 5 * GIB / 2;
        let lease = compile_claim_with(&counter, claim, || {
            speech_prepare_headroom(snapshot(available, 8 * GIB, 2), true)
        })
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), claim);
        drop(lease);
        assert!(
            compile_claim_with(&counter, claim, || speech_prepare_headroom(
                snapshot(available, 8 * GIB, 2),
                false
            ))
            .is_err()
        );
        assert!(
            compile_claim_with(&counter, claim, || speech_prepare_headroom(
                snapshot(2 * GIB + claim - 1, 8 * GIB, 2),
                true
            ))
            .is_err()
        );
        assert!(
            compile_claim_with(&counter, claim, || speech_prepare_headroom(
                snapshot(available, 8 * GIB, 4),
                true
            ))
            .is_err()
        );
        assert!(
            compile_claim_with(&counter, claim, || speech_prepare_headroom(
                snapshot(available, 0, 2),
                true
            ))
            .is_err()
        );
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn meeting_chunks_wait_for_foreground_dictation() {
        let waiting = std::sync::atomic::AtomicBool::new(true);
        let wait = yield_to_dictation_while(|| waiting.load(Ordering::Acquire));
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut wait)
                .await
                .is_err()
        );
        waiting.store(false, Ordering::Release);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn light_live_chunks_wait_for_the_whole_aside() {
        let precedence = super::super::speech_priority::Precedence::new(|| {
            crate::hardware_tier::HardwareTier::Light
        });
        precedence.begin_meeting();
        precedence.set_dictation(true);
        let wait = yield_to_dictation_while(|| precedence.dictation_beside_meeting());
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut wait)
                .await
                .is_err()
        );
        precedence.set_dictation(false);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .unwrap();
        precedence.end_meeting();
    }

    #[test]
    fn a_user_waiting_decode_is_marked_only_while_held() {
        let waiting = user_waiting_decode();
        assert!(user_is_waiting_any());
        let nested = user_waiting_decode();
        drop(waiting);
        assert!(user_is_waiting_any());
        drop(nested);
    }

    #[test]
    fn resident_gguf_decode_at_warning_pressure_needs_only_its_workspace_and_margin() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-parakeet-gguf-session-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("weights"))
            .unwrap()
            .set_len(705 * MIB)
            .unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(0);
        // 705 MiB workspace + 1 GiB margin for a short decode.
        let required = 705 * MIB + GIB;
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || session_headroom(snapshot(required - 1, 24 * GIB, 2), true),
            NativeAllocation::Inference { host_bytes: 0 },
            NativeMemoryProfile::ParakeetGguf,
        )
        .is_err());
        let lease = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || session_headroom(snapshot(required, 24 * GIB, 2), true),
            NativeAllocation::Inference { host_bytes: 0 },
            NativeMemoryProfile::ParakeetGguf,
        )
        .unwrap();
        drop(lease);
        // Loading the weights at warning still needs 3x the model and 3 GiB.
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || session_headroom(snapshot(3 * 705 * MIB + 3 * GIB - 1, 24 * GIB, 2), false),
            NativeAllocation::Constructor,
            NativeMemoryProfile::ParakeetGguf,
        )
        .is_err());
        assert_eq!(counter.load(Ordering::Acquire), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adaptive_claim_threshold_counts_existing_claims_and_rechecks_after_cas_failure() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let counter = AtomicU64::new(GIB);
        assert!(
            reserve_with_observation(&counter, GIB, || adaptive_headroom(snapshot(
                5 * GIB - 1,
                24 * GIB,
                1
            )))
            .is_err()
        );
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        reserve_with_observation(&counter, GIB, || {
            adaptive_headroom(snapshot(5 * GIB, 24 * GIB, 1))
        })
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 2 * GIB);

        counter.store(0, Ordering::Release);
        let samples = std::cell::Cell::new(0);
        assert!(reserve_with_observation(&counter, GIB, || {
            samples.set(samples.get() + 1);
            if samples.get() == 1 {
                counter.store(GIB, Ordering::Release);
                adaptive_headroom(snapshot(8 * GIB, 24 * GIB, 1))
            } else {
                adaptive_headroom(snapshot(5 * GIB - 1, 24 * GIB, 1))
            }
        })
        .is_err());
        assert_eq!(samples.get(), 2);
        assert_eq!(counter.load(Ordering::Acquire), GIB);
    }

    #[test]
    fn adaptive_admission_preserves_estimates_gate_and_claim_lifetime() {
        const GIB: u64 = 1024 * 1024 * 1024;
        const MIB: u64 = 1024 * 1024;
        let dir = std::env::temp_dir().join(format!(
            "plainsong-adaptive-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("weights"), [0u8; 10]).unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(1024);
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)),
            NativeAllocation::Constructor,
            NativeMemoryProfile::Standard
        )
        .is_err());
        assert!(gate.acquire().is_ok());
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        let claim = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(3 * GIB + 1054, 24 * GIB, 1)),
            NativeAllocation::Constructor,
            NativeMemoryProfile::Standard,
        )
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1054);
        assert!(gate.acquire().is_err());
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        let claim = admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || adaptive_headroom(snapshot(8 * GIB, 24 * GIB, 1)),
            NativeAllocation::Inference { host_bytes: MIB },
            NativeMemoryProfile::Standard,
        )
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1024 + 257 * MIB);
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        assert!(admit_with_observation(
            &[&dir],
            &gate,
            &counter,
            || Ok((u64::MAX, 3 * GIB)),
            NativeAllocation::Inference {
                host_bytes: u64::MAX
            },
            NativeMemoryProfile::Standard
        )
        .is_err());
        assert_eq!(counter.load(Ordering::Acquire), 1024);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn observation_and_counter_overflow_never_claim_memory() {
        let counter = AtomicU64::new(u64::MAX);
        assert!(reserve_with_observation(&counter, 1, || Ok((u64::MAX, 0))).is_err());
        assert_eq!(counter.load(Ordering::Acquire), u64::MAX);
        counter.store(0, Ordering::Release);
        assert!(reserve_with_observation(&counter, 1, || Ok((u64::MAX, u64::MAX))).is_err());
        assert!(
            reserve_with_observation(&counter, 1, || Err(anyhow::anyhow!(UNVERIFIED_HEADROOM)))
                .is_err()
        );
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }
    #[tokio::test]
    async fn cleanup_waits_for_active_native_work() {
        let gate = std::sync::Arc::new(super::super::native_runtime_gate::RuntimeGate::new());
        let active = gate.acquire().unwrap();
        let waiting_gate = std::sync::Arc::clone(&gate);
        let waiting = tokio::spawn(async move {
            let _cleanup = acquire_cleanup_gate_from(&waiting_gate).await.unwrap();
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(active);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .expect("cleanup acquired the released gate")
            .unwrap();
    }
    #[test]
    fn system_runtime_requires_fresh_headroom_and_counts_other_claims() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(GIB);
        assert!(system_runtime_with_memory(4 * GIB, &gate, &counter, || None).is_err());
        assert!(
            system_runtime_with_memory(4 * GIB, &gate, &counter, || Some(11 * GIB - 1)).is_err()
        );
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        assert!(gate.acquire().is_ok());

        let samples = std::cell::Cell::new(0);
        let admission = system_runtime_with_memory(4 * GIB, &gate, &counter, || {
            samples.set(samples.get() + 1);
            Some(11 * GIB)
        })
        .unwrap();
        assert_eq!(samples.get(), 1);
        assert_eq!(counter.load(Ordering::Acquire), 5 * GIB);
        assert!(gate.acquire().is_err());
        drop(admission);
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        assert!(gate.acquire().is_ok());
        // A successful earlier sample never admits a later low-memory call.
        assert!(system_runtime_with_memory(4 * GIB, &gate, &counter, || Some(8 * GIB)).is_err());
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        assert!(system_runtime_with_memory(0, &gate, &counter, || Some(11 * GIB)).is_err());
        assert!(system_runtime_with_memory(u64::MAX, &gate, &counter, || Some(u64::MAX)).is_err());
        assert_eq!(counter.load(Ordering::Acquire), GIB);
    }
    #[test]
    fn concurrent_working_claims_are_counted_and_refusals_do_not_reserve() {
        let counter = AtomicU64::new(0);
        const GIB: u64 = 1024 * 1024 * 1024;
        reserve(&counter, GIB, || Some(8 * GIB)).unwrap();
        assert!(reserve(&counter, 2 * GIB, || Some(8 * GIB)).is_err());
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        assert!(reserve(&counter, GIB, || None).is_err());
        assert_eq!(counter.load(Ordering::Acquire), GIB);
        counter.fetch_sub(GIB, Ordering::AcqRel);
        reserve(&counter, 2 * GIB, || Some(8 * GIB)).unwrap();
    }
    #[test]
    fn files_are_measured_and_admission_owns_the_operation_until_drop() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-model-load-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("weights"), [0u8; 100]).unwrap();
        std::fs::write(dir.join("nested/extra"), [0u8; 50]).unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(0);
        assert_eq!(model_bytes(&[&dir]).unwrap(), 150);
        assert!(
            guard_with_memory(&[&dir], &gate, &counter, || Some(4 * 1024 * 1024 * 1024)).is_err()
        );
        assert!(guard_with_memory(&[&dir], &gate, &counter, || None).is_err());
        let permit =
            guard_with_memory(&[&dir], &gate, &counter, || Some(8 * 1024 * 1024 * 1024)).unwrap();
        assert!(gate.acquire().is_err());
        assert_eq!(counter.load(Ordering::Acquire), 450);
        assert!(reserve(&counter, 2 * 1024 * 1024 * 1024, || Some(
            8 * 1024 * 1024 * 1024
        ))
        .is_err());
        assert_eq!(counter.load(Ordering::Acquire), 450);
        drop(permit);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        assert!(gate.acquire().is_ok());
        let working =
            working_with_memory(&[&dir], &gate, &counter, || Some(8 * 1024 * 1024 * 1024), 0)
                .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 256 * 1024 * 1024);
        assert!(
            guard_with_memory(&[&dir], &gate, &counter, || Some(8 * 1024 * 1024 * 1024)).is_err()
        );
        assert!(
            working_with_memory(&[&dir], &gate, &counter, || Some(8 * 1024 * 1024 * 1024), 0)
                .is_err()
        );
        drop(working);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn host_buffers_are_accounted_and_overflow_does_not_claim_memory() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-host-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("weights"), [0u8; 10]).unwrap();
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(0);
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(working_with_memory(&[&dir], &gate, &counter, || Some(8 * GIB), u64::MAX).is_err());
        assert_eq!(counter.load(Ordering::Acquire), 0);
        assert!(gate.acquire().is_ok());
        assert!(working_with_memory(&[&dir], &gate, &counter, || Some(7 * GIB), GIB).is_err());
        assert_eq!(counter.load(Ordering::Acquire), 0);
        let claim = working_with_memory(&[&dir], &gate, &counter, || Some(8 * GIB), GIB).unwrap();
        assert_eq!(counter.load(Ordering::Acquire), GIB + 256 * 1024 * 1024);
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_or_empty_bundles_cannot_admit_a_load() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-empty-model-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(model_bytes(&[&dir]).is_err());
        assert!(model_bytes(&[&dir.join("missing")]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod away_claim_tests {
    use super::*;
    #[test]
    fn away_reserve_admits_the_unchanged_light_claim_at_two_and_a_half_gib() {
        let snapshot = super::super::ollama_prewarm_policy::MemorySnapshot {
            physical_bytes: 8 * 1024 * 1024 * 1024,
            available_bytes: 5 * 1024 * 1024 * 1024 / 2,
            pressure_level: 1,
        };
        let bytes = super::super::native_text::requirement_bytes(
            super::super::native_text::spec_for_model("qwen3-1.7b-q4_k_m").unwrap(),
        );
        let counter = AtomicU64::new(0);
        assert!(text_helper_claim_with(bytes, &counter, || Ok((
            snapshot.available_bytes,
            text_helper_reserve(snapshot, false)
        )))
        .is_err());
        let claim = text_helper_claim_with(bytes, &counter, || {
            Ok((
                snapshot.available_bytes,
                text_helper_reserve(snapshot, true),
            ))
        })
        .unwrap();
        assert_eq!(counter.load(Ordering::Acquire), bytes);
        assert_eq!(text_helper_reserve(snapshot, true), 512 * 1024 * 1024);
        assert!(
            text_helper_claim_with(256 * 1024 * 1024, &counter, || Ok((
                snapshot.available_bytes,
                text_helper_reserve(snapshot, true)
            )))
            .is_err(),
            "resident speech claims are never discounted"
        );
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        for pressure_level in [0, 2, 4] {
            assert_eq!(
                text_helper_reserve(
                    super::super::ollama_prewarm_policy::MemorySnapshot {
                        pressure_level,
                        ..snapshot
                    },
                    true
                ),
                WORKING_RESERVE
            );
        }
    }
}

#[cfg(test)]
mod embedding_away_tests {
    use super::*;
    const GIB: u64 = 1024 * 1024 * 1024;

    fn snapshot(
        available: u64,
        physical: u64,
        pressure_level: i32,
    ) -> super::super::ollama_prewarm_policy::MemorySnapshot {
        super::super::ollama_prewarm_policy::MemorySnapshot {
            available_bytes: available,
            physical_bytes: physical,
            pressure_level,
        }
    }

    #[test]
    fn light_indexing_fits_while_away_without_changing_model_estimates_or_claims() {
        let dir = crate::test_fs::TempDir::new("embedding-away-admission");
        let path = dir.path().join("model");
        let model = super::super::builtin_embeddings::model("embeddinggemma-2").unwrap();
        let bytes = model.download_bytes();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(bytes)
            .unwrap();
        assert_eq!(bytes, 346_390_603);
        let gate = super::super::native_runtime_gate::RuntimeGate::new();
        let counter = AtomicU64::new(0);
        let host = snapshot(5 * GIB / 2, 8 * GIB, 1);
        let attempt = |away, allocation| {
            admit_with_observation(
                &[&path],
                &gate,
                &counter,
                || embedding_headroom(host, away),
                allocation,
                NativeMemoryProfile::Standard,
            )
        };
        let before = attempt(false, NativeAllocation::Constructor)
            .err()
            .unwrap()
            .to_string();
        assert!(before.contains("required_bytes=3186655457"));
        assert!(!gate.is_busy());
        assert_eq!(counter.load(Ordering::Acquire), 0);
        let claim = attempt(true, NativeAllocation::Constructor).unwrap();
        assert_eq!(counter.load(Ordering::Acquire), 1_039_171_809);
        assert!(gate.is_busy());
        // Even the away window cannot borrow another native task's claim.
        let remaining = host.available_bytes - GIB / 2 - counter.load(Ordering::Acquire);
        assert!(
            text_helper_claim_with(remaining + 1, &counter, || embedding_headroom(host, true))
                .is_err()
        );
        assert_eq!(counter.load(Ordering::Acquire), 1_039_171_809);
        drop(claim);
        assert!(!gate.is_busy());
        assert_eq!(counter.load(Ordering::Acquire), 0);
        // The constructor also bounds the largest supported Gemma batch.
        let host_bytes = (4 * 512 * model.dimensions * 4 * 32) as u64;
        let claim = attempt(true, NativeAllocation::Inference { host_bytes }).unwrap();
        assert_eq!(
            counter.load(Ordering::Acquire),
            256 * 1024 * 1024 + host_bytes
        );
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[test]
    fn away_indexing_keeps_pressure_validation_tier_and_memory_limits() {
        let host = snapshot(5 * GIB / 2, 8 * GIB, 1);
        assert_eq!(
            embedding_headroom(host, false).unwrap(),
            (5 * GIB / 2, 2 * GIB)
        );
        assert_eq!(
            embedding_headroom(host, true).unwrap(),
            (5 * GIB / 2, GIB / 2)
        );
        for pressure in [0, 2, 4] {
            assert!(embedding_headroom(snapshot(5 * GIB / 2, 8 * GIB, pressure), true).is_err());
        }
        for physical in [16, 24, 48] {
            let host = snapshot(5 * GIB / 2, physical * GIB, 1);
            assert_eq!(
                embedding_headroom(host, true).unwrap(),
                adaptive_headroom(host).unwrap()
            );
        }
        assert!(embedding_headroom(snapshot(GIB, 0, 1), true).is_err());
        assert!(embedding_headroom(snapshot(9 * GIB, 8 * GIB, 1), true).is_err());
        let counter = AtomicU64::new(0);
        assert!(
            text_helper_claim_with(1_039_171_809, &counter, || embedding_headroom(
                snapshot(1_576_042_720, 8 * GIB, 1),
                true
            ))
            .is_err()
        );
        let claim = text_helper_claim_with(1_039_171_809, &counter, || {
            embedding_headroom(snapshot(1_576_042_721, 8 * GIB, 1), true)
        })
        .unwrap();
        drop(claim);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[test]
    fn helper_constructor_claim_covers_every_supported_batch() {
        for model in super::super::builtin_embeddings::MODELS {
            let constructor = NativeMemoryProfile::Standard
                .constructor_bytes(model.download_bytes())
                .unwrap();
            let host_bytes = (super::super::builtin_embeddings::BATCH
                * model.max_tokens
                * model.dimensions
                * 4
                * 32) as u64;
            assert!(
                constructor
                    >= NativeMemoryProfile::Standard.bytes(model.download_bytes()) + host_bytes
            );
        }
    }
}
