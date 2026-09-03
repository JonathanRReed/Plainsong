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

/// Whether this build has a streaming live-preview engine compiled in at all.
pub(crate) fn streaming_live_preview_compiled_in() -> bool {
    cfg!(feature = "asr-transcribe-cpp")
}

/// Whether the streaming engine's weights are on disk with a trusted receipt.
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
        let provider = asr::transcribe_cpp::TranscribeCppProvider::new(Some(
            asr::transcribe_cpp::NEMOTRON_STREAMING_GGUF_MODEL_ID,
        ));
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

/// Delete those weights and their integrity receipt.
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

/// A running streaming live preview, and the handle that stops it.
///
/// Held in `AppState` so `stop_dictation_for_sidecar` can close the session
/// *before* it starts the batch decode: the two would otherwise contend for the
/// same GPU, and the final text is the one that matters.
pub(crate) struct DictationLivePreviewControl {
    pub(crate) session_id: u64,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) task: tokio::task::JoinHandle<()>,
}

/// How long the stop path waits for the preview task to put its session down.
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

/// Wait for one live-preview task to end, and *abort* it if it will not.
///
/// Returns true when the task ended on its own. Dropping a `JoinHandle`
/// detaches the task rather than cancelling it, so a bare `timeout` left a
/// wedged preview running — with its model resident — while the next dictation
/// started. The abort is what makes "the preview is closed" true rather than
/// hopeful; the engine slot in [`live_preview_engine_permits`] is what keeps a
/// second model from loading in the window where it is not yet.
pub(crate) async fn await_live_preview_task(
    task: tokio::task::JoinHandle<()>,
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

/// Stop the streaming live preview, if one is running, and wait for it to
/// release the recognizer.
///
/// Called on every dictation stop path before transcription starts. Waits, but
/// never forever: a preview that will not put itself down must not take the
/// user's words with it.
pub(crate) async fn stop_dictation_live_preview(state: &AppState) {
    let control = { state.dictation_live_preview.lock().await.take() };
    let Some(control) = control else {
        return;
    };
    control
        .stop
        .store(true, std::sync::atomic::Ordering::SeqCst);
    await_live_preview_task(control.task, control.session_id).await;
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
        task,
    }
}
