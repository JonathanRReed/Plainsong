//! The dictation live preview: text on screen while you are still speaking.
//!
//! Choosing an engine for a session, the compiled-in/model-ready/language
//! checks the Models screen reads, downloading and deleting the preview model,
//! the single-slot engine permit, and the preview task itself.
//!
//! Whichever engine draws the preview, the inserted text is unaffected: it is
//! always the batch decode taken after capture stops. The preview task may only
//! emit `dictation-state-changed`, which the guard
//! `the_streaming_preview_task_only_ever_emits_a_preview_event` pins.
//!
//! Everything here is `pub(crate)` (or `pub`, where it already was) and
//! re-exported from `lib.rs`; the move did not rename or re-sign anything.

use super::*;

/// Which engine draws the dictation live preview for one session.
///
/// Whichever it is, **the inserted text is unaffected**: it is always the batch
/// decode of the selected dictation engine, run after capture stops. See
/// `docs/streaming-dictation-plan.md` and the source-scan test
/// `dictation_insertion_never_reads_a_streaming_partial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationLivePreviewEngine {
    /// No preview. The popup shows the finished text and nothing before it.
    Off,
    /// Re-decode a growing copy of the audio with the dictation engine every
    /// few hundred milliseconds. Works with any local batch engine; the words
    /// arrive a re-decode behind the speaker.
    Redecode,
    /// A cache-aware streaming recognizer fed chunk by chunk, which keeps its
    /// encoder state instead of starting over.
    Streaming,
}

impl DictationLivePreviewEngine {
    fn as_event_value(self) -> &'static str {
        match self {
            DictationLivePreviewEngine::Off => "off",
            DictationLivePreviewEngine::Redecode => "redecode",
            DictationLivePreviewEngine::Streaming => "streaming",
        }
    }
}

/// Everything the engine choice depends on, so the choice itself is a pure
/// function with no model on disk and no microphone.
#[derive(Debug, Clone, Copy)]
pub struct DictationLivePreviewInputs<'a> {
    /// The existing Live Preview setting. False means no preview, full stop.
    pub live_preview_enabled: bool,
    /// `dictation_live_preview_engine`: auto, redecode or streaming.
    pub engine_setting: &'a str,
    /// Whether the selected dictation engine can serve the re-decode preview
    /// (local, and not Apple Speech, whose helper would relaunch per tick).
    pub provider_supports_redecode: bool,
    /// Whether a streaming engine is compiled into this build at all.
    pub streaming_compiled_in: bool,
    /// Whether its weights are downloaded AND carry a trusted integrity
    /// receipt.
    pub streaming_model_ready: bool,
    /// Whether the streaming engine covers the language this session will use.
    pub streaming_language_supported: bool,
}

/// Pick the live-preview engine for one dictation session.
///
/// The rule the whole feature rests on: streaming is an *upgrade to the
/// preview*, never a requirement. If it is not compiled in, not downloaded,
/// not verified, or does not speak the language, the re-decode preview runs
/// exactly as it did before. An explicit `streaming` choice falls back the same
/// way, because a user who asked for the faster preview wants a preview, and
/// showing nothing would be a worse answer than showing the slower one.
pub(crate) fn resolve_dictation_live_preview_engine(
    inputs: DictationLivePreviewInputs<'_>,
) -> DictationLivePreviewEngine {
    if !inputs.live_preview_enabled {
        return DictationLivePreviewEngine::Off;
    }
    let streaming_available = inputs.streaming_compiled_in
        && inputs.streaming_model_ready
        && inputs.streaming_language_supported;
    let fallback = if inputs.provider_supports_redecode {
        DictationLivePreviewEngine::Redecode
    } else {
        DictationLivePreviewEngine::Off
    };
    match inputs.engine_setting.trim() {
        "redecode" => fallback,
        _ if streaming_available => DictationLivePreviewEngine::Streaming,
        _ => fallback,
    }
}

/// The live-preview engine setting to resolve for this dictation route.
///
/// On `auto`, Parakeet on the Neural Engine draws the preview by re-decoding
/// with the model already loaded for the final text (about 65 ms for 10 s of
/// speech), instead of loading the separate streaming model next to it. That
/// keeps one speech model resident during dictation. An explicit choice is
/// left alone.
pub(crate) fn live_preview_engine_setting_for_route<'a>(
    setting: &'a str,
    provider: asr::AsrProviderType,
    model_id: &str,
) -> &'a str {
    if setting.trim() == "auto" && dictation_route_runs_on_neural_engine(provider, model_id) {
        "redecode"
    } else {
        setting
    }
}

fn dictation_route_runs_on_neural_engine(provider: asr::AsrProviderType, model_id: &str) -> bool {
    crate::paths::data_dir()
        .map(|dir| dir.join("Plainsong").join("models"))
        .is_some_and(|models_root| route_runs_on_neural_engine_at(&models_root, provider, model_id))
}

fn route_runs_on_neural_engine_at(
    models_root: &std::path::Path,
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        if provider != asr::AsrProviderType::TranscribeCpp
            || asr::transcribe_cpp::route_spec_for(model_id).model_id
                != asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID
        {
            return false;
        }
        // Also before a first dictation has compiled a Core ML build that
        // serves alone (no ggml file here): that dictation decodes on it.
        asr::neural_engine::request_spec_for_family(
            models_root,
            asr::neural_engine::preferred_family(),
            asr::transcribe_cpp::parakeet_ggml_ready(models_root),
        )
        .is_some()
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        let _ = (models_root, provider, model_id);
        false
    }
}

/// Whether this build has a streaming live-preview engine compiled in at all.
pub(crate) fn streaming_live_preview_compiled_in() -> bool {
    cfg!(feature = "asr-transcribe-cpp")
}

/// Whether the streaming engine's pinned weights are on disk and this session
/// has not found them wrong.
pub(crate) fn streaming_live_preview_model_ready() -> bool {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        use asr::StreamingAsrProvider;
        asr::transcribe_cpp::TranscribeCppStreamingProvider::new().is_streaming_available()
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        false
    }
}

/// Whether the streaming engine covers `language` (`None` = let it decide).
pub(crate) fn streaming_live_preview_supports_language(language: Option<&str>) -> bool {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        use asr::StreamingAsrProvider;
        asr::transcribe_cpp::TranscribeCppStreamingProvider::new().supports_language(language)
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        let _ = language;
        false
    }
}

/// The streaming live preview's status, for the Models screen and Settings.
pub(crate) fn streaming_live_preview_status() -> serde_json::Value {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        use asr::StreamingAsrProvider;
        let provider = asr::transcribe_cpp::TranscribeCppStreamingProvider::new();
        let spec = asr::transcribe_cpp::TranscribeCppStreamingProvider::spec();
        let path = provider.model_path();
        let bytes_on_disk = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        serde_json::json!({
            "supported": true,
            "ready": provider.is_streaming_available(),
            "modelId": provider.streaming_model_id(),
            "displayName": spec.display_name,
            "engineName": provider.streaming_engine_name(),
            "license": spec.license,
            "upstreamUrl": spec.upstream_url,
            "downloadBytes": spec.size_bytes,
            "bytesOnDisk": bytes_on_disk,
            "languages": asr::transcribe_cpp::NEMOTRON_STREAMING_LANGUAGES,
            "chunkMs": provider.chunk_ms(),
            "path": path.to_string_lossy(),
        })
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        serde_json::json!({
            "supported": false,
            "ready": false,
            "modelId": serde_json::Value::Null,
            "displayName": serde_json::Value::Null,
            "engineName": serde_json::Value::Null,
            "license": serde_json::Value::Null,
            "upstreamUrl": serde_json::Value::Null,
            "downloadBytes": 0,
            "bytesOnDisk": 0,
            "languages": Vec::<String>::new(),
            "chunkMs": serde_json::Value::Null,
            "path": serde_json::Value::Null,
        })
    }
}

/// Download the streaming live-preview engine's weights through the same
/// pinned-SHA-256 path every other model uses.
pub(crate) async fn download_live_preview_engine_model(
    handle: &crate::sidecar_handle::SidecarHandle,
) -> Result<(), String> {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        let provider =
            asr::transcribe_cpp::TranscribeCppStreamingProvider::new().download_provider();
        let progress_handle = handle.clone();
        let progress: Box<dyn Fn(f32) + Send + Sync> = Box::new(move |percentage| {
            progress_handle.emit_event(
                "model-download-progress",
                serde_json::json!({
                    "modelName": asr::transcribe_cpp::NEMOTRON_STREAMING_GGUF_MODEL_ID,
                    "percentage": percentage,
                }),
            );
        });
        asr::AsrProvider::download_models(&provider, progress)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        let _ = handle;
        Err(
            "This build has no streaming live-preview engine, so there is nothing to download."
                .to_string(),
        )
    }
}

/// Delete those weights, and any receipt file an older build left beside them.
pub(crate) async fn delete_live_preview_engine_model() -> Result<(), String> {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        let path = asr::transcribe_cpp::TranscribeCppStreamingProvider::new().model_path();
        if !path.exists() {
            return Ok(());
        }
        let manager = crate::download::DownloadManager::new().map_err(|error| error.to_string())?;
        manager
            .delete_model(&path)
            .await
            .map_err(|error| error.to_string())?;
        // The batch route caches one loaded model per process; if it happened
        // to be these weights, keep it from serving a file that is now gone.
        asr::transcribe_cpp::clear_cached_runtime();
        Ok(())
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        Ok(())
    }
}

pub(crate) enum DictationLivePreviewTask {
    Streaming(tokio::task::JoinHandle<()>),
    Redecode(tokio::task::JoinHandle<()>),
}

impl DictationLivePreviewTask {
    fn is_finished(&self) -> bool {
        match self {
            Self::Streaming(task) | Self::Redecode(task) => task.is_finished(),
        }
    }
}

/// A running live preview, retained through native completion.
///
/// Held in `AppState` so `stop_dictation_for_sidecar` can close the session
/// *before* it starts the batch decode: the two would otherwise contend for the
/// same GPU, and the final text is the one that matters.
pub(crate) struct DictationLivePreviewControl {
    pub(crate) session_id: u64,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) task: DictationLivePreviewTask,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DictationLivePreviewStop {
    NotOwned,
    Closed,
    Pending,
}

const DICTATION_REDECODE_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the streaming stop waits for its preview task to put its session down.
/// Longer than a chunk decode by a wide margin; short enough that a wedged
/// engine costs the user a moment rather than the dictation.
pub(crate) const DICTATION_LIVE_PREVIEW_CLOSE_TIMEOUT: Duration = Duration::from_millis(2_000);

/// How often the streaming preview drains the capture buffer. Matched to a
/// capture callback's cadence, not to the chunk size: the chunker regroups.
pub(crate) const DICTATION_STREAMING_POLL_MS: u64 = 100;

/// How long a starting preview waits for the previous session's recognizer to
/// let go of the one engine slot below.
///
/// Long enough that an orderly close a few milliseconds behind a fast
/// stop->start still gets its preview; short enough that a wedged engine costs
/// the next dictation only its preview, and never a second model load.
pub(crate) const DICTATION_LIVE_PREVIEW_ENGINE_WAIT: Duration = Duration::from_millis(1_500);

/// The one process-wide permit for a loaded streaming live-preview engine.
///
/// Each session loads its own copy of the weights — roughly a gigabyte, plus a
/// Metal context — and a session that stops answering is *detached* rather
/// than joined, precisely so a wedged engine cannot hold the dictation stop
/// path open. Without this permit that detached engine would still be resident
/// when the next dictation opened a second one beside it. The permit travels
/// with the session (see [`StreamingLivePreviewEngine`]) and is released by
/// whichever thread finally drops it, detached or not.
pub(crate) fn live_preview_engine_permits() -> &'static Arc<tokio::sync::Semaphore> {
    static PERMITS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

/// Wait up to `wait` for a slot in `permits`.
///
/// `None` means it never came free: the previous session's recognizer is still
/// resident, so this dictation goes without a streaming preview rather than
/// opening a second model beside it. A preview is not worth a gigabyte. Takes
/// the semaphore rather than reaching for the global one so the policy is
/// testable without process-wide state.
pub(crate) async fn acquire_engine_slot(
    permits: &Arc<tokio::sync::Semaphore>,
    wait: Duration,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    tokio::time::timeout(wait, Arc::clone(permits).acquire_owned())
        .await
        .ok()
        .and_then(Result::ok)
}

/// [`acquire_engine_slot`] against the one process-wide live-preview slot.
pub(crate) async fn acquire_live_preview_engine_slot(
    wait: Duration,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    acquire_engine_slot(live_preview_engine_permits(), wait).await
}

/// A loaded streaming recognizer and the engine slot it occupies.
///
/// The two move together everywhere — onto the blocking pool for each batch of
/// chunks, and into the blocking task that finally drops them — so the slot is
/// released exactly when the model's memory is. Keeping the permit in the
/// owning async task instead would release it the moment that task was
/// aborted, while the recognizer was still alive on a detached thread.
pub(crate) struct StreamingLivePreviewEngine {
    session: Box<dyn asr::StreamingAsrSession>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

/// Close one streaming utterance: feed whatever the chunker still holds, then
/// finalize, exactly once. Returns the recognizer's last preview.
///
/// Both halves matter. The chunker holds up to one whole chunk (~560 ms of
/// speech) that has never been fed, and without a `finalize` the stream's last
/// words are never committed — so the preview ended on a tail the engine had
/// not finished thinking about, and on audio it had never heard. Blocking, and
/// split out from the task so the ordering is testable with a stub.
pub(crate) fn finish_streaming_utterance(
    session: &mut dyn asr::StreamingAsrSession,
    remainder: Option<Vec<f32>>,
) -> Option<asr::Partial> {
    if let Some(tail) = remainder {
        if let Err(error) = session.feed(&tail) {
            // Losing the last fragment makes the preview worse, not wrong, and
            // finalize may still commit everything before it.
            tracing::debug!(
                "The live preview could not feed its last partial chunk: {}",
                error
            );
        }
    }
    match session.finalize() {
        Ok(partial) => Some(partial),
        Err(error) => {
            tracing::debug!("The live preview could not finalize: {}", error);
            None
        }
    }
}

/// Keep the streaming preview's bounded wait and abort policy. Its engine slot
/// remains with blocking recognizer work until that work drops the engine.
/// Re-decode must use a drain instead: aborting its caller does not stop ASR.
pub(crate) async fn await_live_preview_task(
    task: &mut tokio::task::JoinHandle<()>,
    session_id: u64,
) -> bool {
    let abort = task.abort_handle();
    match tokio::time::timeout(DICTATION_LIVE_PREVIEW_CLOSE_TIMEOUT, task).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::debug!("The live-preview task ended abnormally: {}", error);
            false
        }
        Err(_) => {
            abort.abort();
            tracing::warn!(
                "The live-preview task for dictation session {} did not stop within {} ms; \
                 aborted it and continued to the final transcription without it",
                session_id,
                DICTATION_LIVE_PREVIEW_CLOSE_TIMEOUT.as_millis()
            );
            false
        }
    }
}

async fn close_live_preview(control: &mut DictationLivePreviewControl) -> bool {
    control
        .stop
        .store(true, std::sync::atomic::Ordering::SeqCst);
    match &mut control.task {
        DictationLivePreviewTask::Streaming(task) => {
            await_live_preview_task(task, control.session_id).await;
            true
        }
        DictationLivePreviewTask::Redecode(task) => {
            // Aborting this async task would detach its spawn_blocking decode,
            // which keeps the native lease until it actually returns.
            match tokio::time::timeout(DICTATION_REDECODE_CLOSE_TIMEOUT, task).await {
                Ok(result) => {
                    if let Err(error) = result {
                        tracing::debug!("The re-decode preview ended abnormally: {}", error);
                    }
                    true
                }
                Err(_) => false,
            }
        }
    }
}

async fn stop_live_preview_slot_for_session(
    slot: &Mutex<Option<DictationLivePreviewControl>>,
    expected_session_id: u64,
) -> DictationLivePreviewStop {
    let mut slot = slot.lock().await;
    let Some(control) = slot.as_mut() else {
        return DictationLivePreviewStop::NotOwned;
    };
    if control.session_id != expected_session_id {
        return if control.session_id < expected_session_id && !control.task.is_finished() {
            DictationLivePreviewStop::Pending
        } else {
            DictationLivePreviewStop::NotOwned
        };
    }
    if matches!(&control.task, DictationLivePreviewTask::Redecode(_))
        && control.stop.load(std::sync::atomic::Ordering::SeqCst)
        && !control.task.is_finished()
    {
        // Terminal error cleanup must not spend another grace period on work
        // whose stop already timed out or whose waiting caller was cancelled.
        return DictationLivePreviewStop::Pending;
    }
    // Borrow the handle in its slot. Cancellation or a timeout must leave the
    // native worker owned and available to the next cleanup attempt.
    if !close_live_preview(control).await {
        return DictationLivePreviewStop::Pending;
    }
    slot.take();
    DictationLivePreviewStop::Closed
}

pub(crate) async fn stop_dictation_live_preview_for_session(
    state: &AppState,
    expected_session_id: u64,
) -> DictationLivePreviewStop {
    stop_live_preview_slot_for_session(&state.dictation_live_preview, expected_session_id).await
}

/// A pending preview gets one final bounded drain before final recognition.
/// Keep its handle and native lease owned if it cannot finish; never start a
/// second recognizer beside an unaccounted blocking decode.
pub(crate) async fn drain_pending_dictation_live_preview(
    slot: &Mutex<Option<DictationLivePreviewControl>>,
    session_id: u64,
) -> DictationLivePreviewStop {
    let mut slot = slot.lock().await;
    let Some(control) = slot.as_mut() else {
        return DictationLivePreviewStop::NotOwned;
    };
    if control.session_id > session_id {
        return DictationLivePreviewStop::NotOwned;
    }
    control
        .stop
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let task = match &mut control.task {
        DictationLivePreviewTask::Streaming(task) | DictationLivePreviewTask::Redecode(task) => {
            task
        }
    };
    if tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .is_err()
    {
        tracing::warn!(
            session_id,
            "Live preview still owns the recognizer after the final drain"
        );
        return DictationLivePreviewStop::Pending;
    }
    slot.take();
    DictationLivePreviewStop::Closed
}

pub(crate) async fn install_dictation_live_preview_for_session(
    slot: &Mutex<Option<DictationLivePreviewControl>>,
    tracker: &Mutex<DictationSessionTracker>,
    session_id: u64,
    spawn: impl FnOnce() -> DictationLivePreviewControl,
) -> bool {
    let mut slot = slot.lock().await;
    if slot
        .as_ref()
        .is_some_and(|control| control.session_id > session_id)
    {
        return false;
    }
    let may_start = || async {
        let tracker = tracker.lock().await;
        tracker.active_session_id == Some(session_id)
            && tracker.stopping_session_id != Some(session_id)
            && tracker.cancellation_requested_session_id != Some(session_id)
    };
    if !may_start().await {
        return false;
    }
    if let Some(previous) = slot.as_mut() {
        if !close_live_preview(previous).await {
            return false;
        }
    }
    slot.take();
    if !may_start().await {
        return false;
    }
    slot.replace(spawn());
    true
}

/// Open a streaming session from whichever streaming engine this build has.
///
/// One place, so `spawn_streaming_live_preview` below needs no `#[cfg]` of its
/// own and the default build still compiles every line of it.
pub(crate) fn open_streaming_live_preview_session(
    language: Option<&str>,
) -> anyhow::Result<Box<dyn asr::StreamingAsrSession>> {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        use asr::StreamingAsrProvider;
        asr::transcribe_cpp::TranscribeCppStreamingProvider::new().open_session(language)
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        let _ = language;
        anyhow::bail!("This build has no streaming live-preview engine compiled in.")
    }
}

/// Drive the streaming live preview for one dictation session.
///
/// Reads the same UI-only sample buffer the re-decode preview reads, resamples
/// it once, feeds it to the recognizer chunk by chunk, and emits the same
/// `dictation-state-changed` preview event. It writes nothing else: no
/// transcript, no history row, nothing the insertion path reads.
///
/// Best-effort throughout. Every failure -- the model refusing to load, a chunk
/// erroring, the engine going quiet -- ends the preview and leaves the session
/// otherwise untouched, because a preview is not worth failing a dictation for.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_streaming_live_preview(
    session_tracker: Arc<Mutex<DictationSessionTracker>>,
    handle: crate::sidecar_handle::SidecarHandle,
    session_id: u64,
    partial_buffer: Arc<StdMutex<audio::DictationPartialBuffer>>,
    is_dictating: Arc<AtomicBool>,
    sample_rate: u32,
    language: Option<String>,
) -> DictationLivePreviewControl {
    /// The one preview payload, built in one place so the stop-path emit and
    /// the in-loop emit cannot drift apart. Nested rather than a free function
    /// so the guarantee scan still reads it as part of this task's body.
    fn preview_event(session_id: u64, tracker: &asr::StreamingPartialTracker) -> serde_json::Value {
        // The two halves are rendered side by side, so the leading space
        // belongs to neither: trim it off whichever half is first and leave
        // the seam between them alone.
        let stable = tracker.stable().trim_start();
        let volatile = if stable.is_empty() {
            tracker.volatile().trim_start()
        } else {
            tracker.volatile()
        };
        serde_json::json!({
            "phase": "recording",
            "sessionId": session_id,
            "partialText": tracker.display().trim(),
            "partialStableText": stable,
            "partialVolatileText": volatile,
            "partialEngine": DictationLivePreviewEngine::Streaming.as_event_value(),
        })
    }

    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = Arc::clone(&stop);
    let task = tokio::spawn(async move {
        // One loaded engine at a time, process-wide: a previous session whose
        // recognizer had to be detached is still holding roughly a gigabyte,
        // and a preview is not worth a second copy of it.
        let Some(slot) = acquire_live_preview_engine_slot(DICTATION_LIVE_PREVIEW_ENGINE_WAIT).await
        else {
            tracing::warn!(
                "Live preview stayed off for dictation session {}: the previous session's \
                 recognizer has not been released yet",
                session_id
            );
            return;
        };
        let opened = tokio::task::spawn_blocking(move || {
            open_streaming_live_preview_session(language.as_deref())
        })
        .await;
        let mut engine = match opened {
            Ok(Ok(session)) => StreamingLivePreviewEngine {
                session,
                _slot: slot,
            },
            Ok(Err(error)) => {
                tracing::warn!(
                    "Live preview stayed off for dictation session {}: {}",
                    session_id,
                    error
                );
                return;
            }
            Err(error) => {
                tracing::warn!("The live-preview session failed to open: {}", error);
                return;
            }
        };

        let mut resampler = asr::StreamingResampler::new(sample_rate);
        let mut chunker = asr::PcmChunker::new(engine.session.chunk_samples());
        let mut tracker = asr::StreamingPartialTracker::new();
        // How much of the capture buffer's monotonic sample count has been fed.
        let mut consumed: u64 = 0;

        loop {
            tokio::time::sleep(Duration::from_millis(DICTATION_STREAMING_POLL_MS)).await;
            if task_stop.load(std::sync::atomic::Ordering::SeqCst)
                || !is_dictating.load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            // Gate on the monotonic session id, not the shared `is_dictating`
            // flag, which a fast stop->restart flips back to true: a stale task
            // must never paint a partial into a newer session's popup.
            if session_tracker.lock().await.active_session_id != Some(session_id) {
                break;
            }

            let fresh = {
                let Ok(buffer) = partial_buffer.lock() else {
                    break;
                };
                let total = buffer.total_samples;
                if total <= consumed {
                    Vec::new()
                } else {
                    let wanted = (total - consumed) as usize;
                    // The capture buffer is a sliding window. If this task ever
                    // falls further behind than the window is long, the audio in
                    // between is gone; take what is there and resync rather than
                    // feeding the recognizer the wrong samples.
                    let available = buffer.samples.len();
                    if wanted > available {
                        tracing::debug!(
                            "Live preview fell {} samples behind the capture window; resyncing",
                            wanted - available
                        );
                    }
                    let take = wanted.min(available);
                    consumed = total;
                    buffer.samples[available - take..].to_vec()
                }
            };
            if fresh.is_empty() {
                continue;
            }

            let chunks = chunker.push(&resampler.push(&fresh));
            if chunks.is_empty() {
                continue;
            }

            // The native call blocks, so it goes to the blocking pool; the
            // engine moves with it and comes back, because it is `Send` and
            // owned by exactly one place at a time.
            let fed = tokio::task::spawn_blocking(move || {
                let mut partials = Vec::with_capacity(chunks.len());
                for chunk in chunks {
                    match engine.session.feed(&chunk) {
                        Ok(partial) => partials.push(Ok(partial)),
                        Err(error) => {
                            partials.push(Err(error));
                            break;
                        }
                    }
                }
                (engine, partials)
            })
            .await;
            let (returned, partials) = match fed {
                Ok(pair) => pair,
                Err(error) => {
                    tracing::debug!("The live-preview feed task panicked: {}", error);
                    return;
                }
            };
            engine = returned;

            let mut failed = false;
            for partial in partials {
                match partial {
                    Ok(partial) => {
                        if !tracker.accept(&partial) || tracker.is_empty() {
                            continue;
                        }
                        let still_current = is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                            && session_tracker.lock().await.active_session_id == Some(session_id);
                        if !still_current {
                            failed = true;
                            break;
                        }
                        {
                            let mut tracker_guard = session_tracker.lock().await;
                            if tracker_guard.active_session_id == Some(session_id)
                                && tracker_guard.first_stable_partial_at_epoch_ms.is_none()
                            {
                                tracker_guard.first_stable_partial_at_epoch_ms =
                                    Some(chrono::Utc::now().timestamp_millis());
                            }
                        }
                        handle.emit_event(
                            "dictation-state-changed",
                            preview_event(session_id, &tracker),
                        );
                    }
                    Err(error) => {
                        tracing::debug!("Live preview chunk failed: {}", error);
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                break;
            }
        }

        // Close the utterance before the recognizer goes. The chunker still
        // holds up to one whole chunk of speech that was never fed, and the
        // stream's last words are never committed without a `finalize`, so the
        // preview otherwise ended on audio the engine had not heard and a tail
        // it had not finished. Same blocking pool, engine still owned here.
        let remainder = chunker.take_remainder();
        let closed = tokio::task::spawn_blocking(move || {
            let last = finish_streaming_utterance(engine.session.as_mut(), remainder);
            (engine, last)
        })
        .await;
        let (engine, last) = match closed {
            Ok(pair) => pair,
            Err(error) => {
                tracing::debug!("Closing the live-preview utterance panicked: {}", error);
                return;
            }
        };

        // Paint the finished utterance only while the popup is still on this
        // session's recording phase. On the ordinary stop path it is not:
        // capture has already ended and the HUD has moved to "stopping", and a
        // late "recording" event would walk it backwards. This is for the
        // other ways the loop ends -- the capture buffer going away underneath
        // it while the user is still speaking.
        if let Some(partial) = last {
            if tracker.accept(&partial)
                && !tracker.is_empty()
                && is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                && session_tracker.lock().await.active_session_id == Some(session_id)
            {
                handle.emit_event(
                    "dictation-state-changed",
                    preview_event(session_id, &tracker),
                );
            }
        }

        // Put the recognizer down on the blocking pool: dropping the session
        // joins its worker thread, which is what makes "the GPU is free before
        // the batch decode" true rather than hopeful. Dropping it also releases
        // the engine slot, so the next dictation may load its own.
        if let Err(error) = tokio::task::spawn_blocking(move || drop(engine)).await {
            tracing::debug!("Closing the live-preview session panicked: {}", error);
        }
    });

    DictationLivePreviewControl {
        session_id,
        stop,
        task: DictationLivePreviewTask::Streaming(task),
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    async fn blocked_redecode(
        session_id: u64,
    ) -> (
        DictationLivePreviewControl,
        Arc<tokio::sync::Semaphore>,
        std::sync::mpsc::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let worker_gate = Arc::clone(&gate);
        let (release, released) = std::sync::mpsc::channel();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (finished, finished_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _lease = worker_gate.try_acquire().expect("mock native lease");
                let _ = started.send(());
                // Dropping the sender on a failed assertion also releases this
                // worker, so the test cannot strand a blocking thread.
                let _ = released.recv();
            })
            .await
            .unwrap();
            let _ = finished.send(());
        });
        started_rx.await.unwrap();
        (
            DictationLivePreviewControl {
                session_id,
                stop: Arc::new(AtomicBool::new(false)),
                task: DictationLivePreviewTask::Redecode(task),
            },
            gate,
            release,
            finished_rx,
        )
    }

    async fn wait_for_stop(stop: &AtomicBool) {
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn redecode_handoff_waits_for_its_blocking_native_lease() {
        let (control, gate, release, finished) = blocked_redecode(7).await;
        let stop = Arc::clone(&control.stop);
        let slot = Arc::new(Mutex::new(Some(control)));
        let draining = tokio::spawn({
            let slot = Arc::clone(&slot);
            let gate = Arc::clone(&gate);
            async move {
                let result = stop_live_preview_slot_for_session(&slot, 7).await;
                assert_eq!(result, DictationLivePreviewStop::Closed);
                assert!(
                    gate.try_acquire().is_ok(),
                    "final decode must acquire after handoff"
                );
            }
        });
        wait_for_stop(&stop).await;
        tokio::time::advance(DICTATION_LIVE_PREVIEW_CLOSE_TIMEOUT + Duration::from_secs(1)).await;
        assert!(
            !draining.is_finished(),
            "streaming's timeout must not abort re-decode"
        );
        assert!(gate.try_acquire().is_err());
        release.send(()).unwrap();
        finished.await.unwrap();
        draining.await.unwrap();
        assert!(slot.lock().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn redecode_timeout_retains_owner_without_repeating_terminal_cleanup_wait() {
        let (control, gate, release, finished) = blocked_redecode(7).await;
        let stop = Arc::clone(&control.stop);
        let slot = Arc::new(Mutex::new(Some(control)));
        let draining = tokio::spawn({
            let slot = Arc::clone(&slot);
            async move { stop_live_preview_slot_for_session(&slot, 7).await }
        });
        wait_for_stop(&stop).await;
        tokio::time::advance(DICTATION_REDECODE_CLOSE_TIMEOUT + Duration::from_millis(1)).await;
        assert_eq!(draining.await.unwrap(), DictationLivePreviewStop::Pending);
        assert!(slot.lock().await.is_some());
        assert!(
            gate.try_acquire().is_err(),
            "a timeout did not release the blocking lease"
        );
        let terminal_cleanup_started = tokio::time::Instant::now();
        assert_eq!(
            stop_live_preview_slot_for_session(&slot, 7).await,
            DictationLivePreviewStop::Pending
        );
        assert_eq!(tokio::time::Instant::now(), terminal_cleanup_started);
        let final_drain = tokio::spawn({
            let slot = Arc::clone(&slot);
            async move { drain_pending_dictation_live_preview(&slot, 7).await }
        });
        tokio::task::yield_now().await;
        assert!(!final_drain.is_finished());
        assert!(gate.try_acquire().is_err());
        release.send(()).unwrap();
        finished.await.unwrap();
        assert_eq!(final_drain.await.unwrap(), DictationLivePreviewStop::Closed);
        assert!(slot.lock().await.is_none());
        assert!(gate.try_acquire().is_ok(), "final recognition can now run");
    }

    #[tokio::test(start_paused = true)]
    async fn final_drain_is_bounded_and_keeps_a_stuck_preview_owned() {
        let (control, gate, release, finished) = blocked_redecode(7).await;
        let stop = Arc::clone(&control.stop);
        let slot = Arc::new(Mutex::new(Some(control)));
        let draining = tokio::spawn({
            let slot = Arc::clone(&slot);
            async move { drain_pending_dictation_live_preview(&slot, 7).await }
        });
        wait_for_stop(&stop).await;
        tokio::time::advance(Duration::from_secs(21)).await;
        assert_eq!(draining.await.unwrap(), DictationLivePreviewStop::Pending);
        assert!(slot.lock().await.is_some());
        assert!(gate.try_acquire().is_err());
        release.send(()).unwrap();
        finished.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_redecode_stop_keeps_the_owned_handle_in_its_slot() {
        let (control, gate, release, finished) = blocked_redecode(7).await;
        let stop = Arc::clone(&control.stop);
        let slot = Arc::new(Mutex::new(Some(control)));
        let draining = tokio::spawn({
            let slot = Arc::clone(&slot);
            async move { stop_live_preview_slot_for_session(&slot, 7).await }
        });
        wait_for_stop(&stop).await;
        draining.abort();
        assert!(draining.await.unwrap_err().is_cancelled());
        assert!(slot.lock().await.is_some());
        assert!(stop.load(std::sync::atomic::Ordering::SeqCst));
        assert!(gate.try_acquire().is_err());
        release.send(()).unwrap();
        finished.await.unwrap();
        assert_eq!(
            stop_live_preview_slot_for_session(&slot, 7).await,
            DictationLivePreviewStop::Closed
        );
        assert!(gate.try_acquire().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn stale_preview_stop_does_not_touch_a_newer_session() {
        let (control, gate, release, finished) = blocked_redecode(9).await;
        let stop = Arc::clone(&control.stop);
        let slot = Mutex::new(Some(control));
        assert_eq!(
            stop_live_preview_slot_for_session(&slot, 8).await,
            DictationLivePreviewStop::NotOwned
        );
        assert_eq!(
            stop_live_preview_slot_for_session(&slot, 10).await,
            DictationLivePreviewStop::Pending
        );
        assert!(!stop.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(slot.lock().await.as_ref().unwrap().session_id, 9);
        assert!(gate.try_acquire().is_err());
        release.send(()).unwrap();
        finished.await.unwrap();
        assert_eq!(
            stop_live_preview_slot_for_session(&slot, 9).await,
            DictationLivePreviewStop::Closed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn preview_install_rechecks_session_after_draining_previous_work() {
        let (control, _, release, finished) = blocked_redecode(7).await;
        let stop = Arc::clone(&control.stop);
        let slot = Arc::new(Mutex::new(Some(control)));
        let tracker = Arc::new(Mutex::new(DictationSessionTracker {
            active_session_id: Some(8),
            ..Default::default()
        }));
        let spawned = Arc::new(AtomicBool::new(false));
        let installing = tokio::spawn({
            let slot = Arc::clone(&slot);
            let tracker = Arc::clone(&tracker);
            let spawned = Arc::clone(&spawned);
            async move {
                install_dictation_live_preview_for_session(&slot, &tracker, 8, || {
                    spawned.store(true, std::sync::atomic::Ordering::SeqCst);
                    panic!("a replaced session must not spawn its preview")
                })
                .await
            }
        });
        wait_for_stop(&stop).await;
        // The preview must be able to read its tracker while stop joins it.
        tokio::time::timeout(Duration::from_millis(100), tracker.lock())
            .await
            .unwrap()
            .active_session_id = Some(9);
        release.send(()).unwrap();
        finished.await.unwrap();
        assert!(!installing.await.unwrap());
        assert!(!spawned.load(std::sync::atomic::Ordering::SeqCst));
        assert!(slot.lock().await.is_none());
    }
}

#[cfg(all(test, feature = "asr-transcribe-cpp"))]
mod route_tests {
    use super::*;
    use crate::asr::neural_engine::{self, PARAKEET_V2_COREML, PARAKEET_V3_COREML};

    #[test]
    fn the_preview_redecodes_on_a_core_ml_build_with_no_ggml_file() {
        let root =
            std::env::temp_dir().join(format!("live-preview-coreml-{}", uuid::Uuid::new_v4()));
        for spec in [&PARAKEET_V3_COREML, &PARAKEET_V2_COREML] {
            let dir = spec.dir(&root);
            for file in spec.files {
                let path = dir.join(file.path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"x").unwrap();
            }
        }
        let parakeet = asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID;
        let provider = asr::AsrProviderType::TranscribeCpp;
        // The final text decodes on the Core ML build (compiling it first),
        // so the preview reuses that model instead of loading another.
        assert_eq!(
            route_runs_on_neural_engine_at(&root, provider, parakeet),
            neural_engine::serves_without_ggml(&root, neural_engine::preferred_family())
        );
        // Other routes never do.
        assert!(!route_runs_on_neural_engine_at(
            &root,
            provider,
            asr::transcribe_cpp::NEMOTRON_STREAMING_GGUF_MODEL_ID
        ));
        assert!(!route_runs_on_neural_engine_at(
            &root,
            asr::AsrProviderType::Whisper,
            "base.en"
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
