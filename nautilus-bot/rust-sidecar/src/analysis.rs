//! Meeting analysis: the LLM passes and what is built from them.
//!
//! Loading a recording's segments, running the grounded summary and
//! action-item passes against the selected provider, persisting and announcing
//! the outcome, the meeting brief, and the relationship memory assembled from
//! past meetings. The provider timeouts and the analysis phase vocabulary live
//! here too, because they are only meaningful to these passes.

use super::*;

pub(crate) const ANALYSIS_LOCAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const ANALYSIS_REMOTE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3 * 60);
pub(crate) const ANALYSIS_LOCAL_JOB_TIMEOUT: Duration = Duration::from_secs(45 * 60);
pub(crate) const ANALYSIS_REMOTE_JOB_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) const ACTION_ITEMS_INSTRUCTION: &str = "Extract every agreed concrete action item that remains pending after the meeting. Exclude completed activities, introductions, demonstrations and exercises. Return an empty list when no pending task was agreed. Include the specific task or deliverable, the responsible person when stated, and any stated deadline or timeframe. Preserve corrections, negation, conditions and uncertainty. A participant's explicit commitment is a task even when conditional; it does not require separate group agreement. Extract each separate commitment. Put every prerequisite and blocking condition in the task text, including conditions stated in related lines, and cite those lines too. A nearby prohibition about the same action and deliverable constrains that task: copy its blocking instruction into the task text and cite its line, rather than leaving it only in the summary. When it restricts an existing commitment, fold it into that commitment instead of listing the prohibition as a separate ownerless task. Keep conditions for different deliverables separate. Preserve blocking instructions verbatim: do not X unless Y means X only if Y, never affirmative X unless Y. Do not turn proposals or rejected suggestions into commitments. Keep the final agreed owner and date when a speaker corrects them. Copy stated deadline wording verbatim. Do not invent owners or dates.";

#[derive(Debug, Clone, Copy)]
pub(crate) struct AnalysisTimeouts {
    pub(crate) request: Duration,
    pub(crate) job: Duration,
}

pub(crate) fn analysis_timeouts(provider: AnalysisProvider) -> AnalysisTimeouts {
    // `is_remote()` rather than `== Ollama`: the bundled model and Apple's
    // on-device model also pay a local cold-load cost and also never touch a
    // network, so they belong on the local side of this split.
    if !provider.is_remote() {
        AnalysisTimeouts {
            request: ANALYSIS_LOCAL_REQUEST_TIMEOUT,
            job: ANALYSIS_LOCAL_JOB_TIMEOUT,
        }
    } else {
        AnalysisTimeouts {
            request: ANALYSIS_REMOTE_REQUEST_TIMEOUT,
            job: ANALYSIS_REMOTE_JOB_TIMEOUT,
        }
    }
}

pub(crate) fn group_transcript_segments_for_analysis(
    recording_id: &str,
    segments: &[models::TranscriptSegment],
) -> Vec<AnalysisContextSegment> {
    let mut grouped = Vec::<AnalysisContextSegment>::new();
    let mut grouped_speaker: Option<&Option<String>> = None;
    let mut source_tracks = HashMap::<&str, usize>::new();

    for segment in segments {
        // Source-aware capture interleaves mic and system words in time order.
        // Each track needs its own phrase, rather than alternating one-word
        // citations. Diarized speaker changes still start a new phrase.
        let track = segment
            .speaker_id
            .as_deref()
            .filter(|id| matches!(*id, "me" | "them"));
        let candidate = if let Some(track) = track {
            source_tracks.get(track).copied()
        } else {
            grouped
                .len()
                .checked_sub(1)
                .filter(|_| grouped_speaker.is_some_and(|speaker| speaker == &segment.speaker_id))
        };
        let can_append = candidate
            .and_then(|index| grouped.get(index))
            .is_some_and(|current| {
                current.start_time.is_finite()
                    && current.end_time.is_finite()
                    && current.end_time >= current.start_time
                    && segment.start_time.is_finite()
                    && segment.end_time.is_finite()
                    && segment.end_time >= segment.start_time
                    && segment.start_time >= current.end_time
                    && segment.start_time - current.end_time <= 0.5
                    && segment.end_time - current.start_time <= 30.0
                    && current.text.chars().count() + 1 + segment.text.chars().count() <= 800
            });

        if can_append {
            let current =
                &mut grouped[candidate.expect("an appendable analysis segment must exist")];
            current.text.push(' ');
            current.text.push_str(&segment.text);
            current.end_time = segment.end_time;
        } else {
            if let Some(track) = track {
                source_tracks.insert(track, grouped.len());
            }
            grouped.push(AnalysisContextSegment {
                recording_id: recording_id.to_string(),
                segment_id: segment.id.clone(),
                text: segment.text.clone(),
                start_time: segment.start_time,
                end_time: segment.end_time,
            });
        }
        grouped_speaker = Some(&segment.speaker_id);
    }

    grouped
}

pub(crate) async fn load_recording_analysis_input(
    state: &AppState,
    recording_id: &str,
) -> Result<
    (
        Vec<AnalysisContextSegment>,
        Option<String>,
        Option<String>,
        RecordingAnalysisSnapshot,
    ),
    String,
> {
    let db = state.db.lock().await;
    let recording = db
        .get_recording(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or("Recording not found")?;
    let (transcript, transcript_revision) = db
        .get_transcript_with_revision(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or("Transcript not found")?;
    let segments = group_transcript_segments_for_analysis(recording_id, &transcript.segments);
    if segments.is_empty() {
        return Err("Transcript contains no segments for grounded analysis".to_string());
    }
    let meeting_notes = recording.meeting_notes.clone();
    let meeting_template_id = recording.meeting_template_id.clone();
    let attendee_names = models::attendee_names_for_context(&recording.attendees);
    // Saved notes become canonical evidence rows in the recording context.
    // Keep only attendee metadata supplemental, avoiding a second uncitable
    // copy of every note in each chunk's fixed prompt.
    let composed_notes = compose_analysis_notes(None, &attendee_names);
    let snapshot = RecordingAnalysisSnapshot {
        transcript_revision,
        transcript_complete: recording.transcript_complete,
        transcript_degraded_reason: recording.transcript_degraded_reason.clone(),
        capture_degraded_summary: recording.capture_degraded_summary.clone(),
        meeting_notes,
        notes_updated_at: recording.notes_updated_at,
        meeting_template_id: meeting_template_id.clone(),
        expected_summary: recording.summary,
        expected_action_items: recording.action_items,
        custom_summary_prompt: None,
        attendee_names,
        speaker_names: None,
    };
    Ok((segments, composed_notes, meeting_template_id, snapshot))
}

fn source_allows_grounded<'a>(
    snapshot: &RecordingAnalysisSnapshot,
    needs_coverage: bool,
    citation_kinds: impl Iterator<Item = Option<&'a str>>,
) -> bool {
    let intact = snapshot.transcript_complete
        && snapshot
            .capture_degraded_summary
            .as_deref()
            .is_none_or(|s| s.trim().is_empty())
        && snapshot
            .transcript_degraded_reason
            .as_deref()
            .is_none_or(|s| s.trim().is_empty());
    if intact {
        return true;
    }
    if needs_coverage {
        return false;
    }
    let mut kinds = citation_kinds.peekable();
    kinds.peek().is_some() && kinds.all(|kind| kind == Some("meeting_note"))
}

pub(crate) fn persisted_analysis_citations(
    citations: &[llm::Citation],
) -> Vec<models::AnalysisCitation> {
    citations
        .iter()
        .map(|citation| models::AnalysisCitation {
            source_kind: citation.source_kind.clone(),
            text: citation.text.clone(),
            line_id: citation.line_id.clone(),
            segment_id: citation.segment_id.clone(),
            start_time: citation.start_time,
            end_time: citation.end_time,
            recording_id: citation.recording_id.clone(),
            certainty: citation.certainty,
        })
        .collect()
}

pub(crate) fn analysis_progress_callback(
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    target: &str,
    run_id: Option<&str>,
) -> llm::OrchestrationProgressCallback {
    let handle = handle.clone();
    let recording_id = recording_id.to_string();
    let target = target.to_string();
    let run_id = run_id.map(str::to_string);
    Arc::new(move |progress| {
        let strategy = match progress.strategy {
            llm::OrchestrationStrategy::Direct => "direct",
            llm::OrchestrationStrategy::Chunked => "chunked",
        };
        let stage = match progress.stage {
            llm::OrchestrationStage::Planning => "planning",
            llm::OrchestrationStage::Mapping => "mapping",
            llm::OrchestrationStage::Reducing => "reducing",
            llm::OrchestrationStage::Synthesizing => "synthesizing",
            llm::OrchestrationStage::Completed => "completed",
        };
        let message = match progress.stage {
            llm::OrchestrationStage::Planning
                if progress.strategy == llm::OrchestrationStrategy::Chunked =>
            {
                format!(
                    "Preparing full-transcript analysis across {} chunks",
                    progress.total
                )
            }
            llm::OrchestrationStage::Planning => "Preparing full-transcript analysis".to_string(),
            llm::OrchestrationStage::Mapping => format!(
                "Reading transcript chunk {} of {}",
                progress.completed, progress.total
            ),
            llm::OrchestrationStage::Reducing => format!(
                "Combining grounded evidence, pass {} ({} of {})",
                progress.pass, progress.completed, progress.total
            ),
            llm::OrchestrationStage::Synthesizing => "Writing the grounded result".to_string(),
            llm::OrchestrationStage::Completed => "Analysis complete".to_string(),
        };
        handle.emit_event(
            "recording-analysis-progress",
            serde_json::json!({
                "recordingId": &recording_id,
                "runId": &run_id,
                "target": &target,
                "stage": stage,
                "strategy": strategy,
                "completed": progress.completed,
                "total": progress.total,
                "pass": progress.pass,
                "message": message,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            }),
        );
    })
}

pub(crate) fn emit_analysis_failure(
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    target: &str,
    run_id: Option<&str>,
    reason: &str,
) {
    handle.emit_event(
        "recording-analysis-failed",
        serde_json::json!({
            "recordingId": recording_id,
            "runId": run_id,
            "target": target,
            "reason": reason,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );
}

/// Lifecycle of one meeting's automatic-analysis pass.
///
/// The pass used to report nothing at all: a default install points the meeting
/// AI lane at an Ollama that is not installed, every stage failed, and the only
/// trace was a `tracing::warn!`. The user was left with an unexplained
/// placeholder title and no summary. These phases are what let the app say the
/// analysis is running, that it failed and why, or that it finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingAnalysisPhase {
    Running,
    /// The built-in model could not get the memory it needs yet. The pass
    /// tries again on its own; see `run_meeting_analysis_until_written`.
    Waiting,
    Failed,
    Completed,
}

impl MeetingAnalysisPhase {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Failed => "failed",
            Self::Completed => "completed",
        }
    }
}

/// Stored and shown while a meeting's notes wait for memory. The renderer
/// matches this text to keep its retry offer next to the waiting notice.
pub(crate) const MEMORY_WAIT_NOTICE: &str = "Notes will be written when memory frees up.";

/// After a call ends, Light checks every 10 seconds for an away window.
/// Other tiers start at a minute and double up to a quarter of an hour.
const MEMORY_RETRY_FIRST: Duration = Duration::from_secs(60);
const MEMORY_RETRY_MAX: Duration = Duration::from_secs(15 * 60);
const MEMORY_RETRY_POLL: Duration = Duration::from_secs(5);

/// How long cancelling waits for an active pass, and then for the text
/// helper's request, to stop. The helper's own cancel and exit graces are two
/// seconds each.
const CANCEL_RELEASE_TIMEOUT: Duration = Duration::from_secs(10);
const CANCEL_HELPER_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn next_memory_retry_delay(previous: Duration) -> Duration {
    (previous * 2).min(MEMORY_RETRY_MAX)
}

fn first_memory_retry_delay(tier: crate::hardware_tier::HardwareTier) -> Duration {
    if tier == crate::hardware_tier::HardwareTier::Light {
        Duration::from_secs(10)
    } else {
        MEMORY_RETRY_FIRST
    }
}

/// Set once a pass is cancelled. The pass checks it before every save, so an
/// acknowledged cancel never writes notes, titles or outcomes afterwards.
#[derive(Clone, Default)]
pub(crate) struct PassCancel(Arc<std::sync::atomic::AtomicBool>);

impl PassCancel {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }

    fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}

fn cancellable_progress(
    cancel: &PassCancel,
    progress: llm::OrchestrationProgressCallback,
) -> llm::OrchestrationProgressCallback {
    let cancel = cancel.clone();
    Arc::new(move |update| {
        if !cancel.is_cancelled() {
            progress(update);
        }
    })
}

/// A pass that is running now for a meeting's memory wait.
struct ActivePass {
    abort: futures_util::future::AbortHandle,
    cancel: PassCancel,
    /// Turns true once the pass future has been dropped, which is when its
    /// post-call lease and model request are released.
    released: tokio::sync::watch::Receiver<bool>,
}

impl ActivePass {
    fn stop(&self) {
        self.cancel.cancel();
        self.abort.abort();
    }
}

struct MemoryWait {
    generation: u64,
    active: Option<ActivePass>,
    checkpoints: Arc<llm::grounded::NotesCheckpoints>,
}

/// One generation number per meeting waiting for memory. Starting another
/// pass or cancelling bumps or removes it, which stops the older retry loop
/// at its next wake and aborts its running pass.
static MEMORY_WAITS: std::sync::LazyLock<StdMutex<HashMap<String, MemoryWait>>> =
    std::sync::LazyLock::new(|| StdMutex::new(HashMap::new()));
static MEMORY_WAIT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn begin_memory_wait_generation(recording_id: &str) -> u64 {
    let generation = MEMORY_WAIT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let superseded = MEMORY_WAITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            recording_id.to_owned(),
            MemoryWait {
                generation,
                active: None,
                checkpoints: Arc::default(),
            },
        );
    // The newer pass redoes whatever the older one had not saved.
    if let Some(active) = superseded.and_then(|wait| wait.active) {
        active.stop();
    }
    generation
}

fn memory_wait_is_current(recording_id: &str, generation: u64) -> bool {
    MEMORY_WAITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(recording_id)
        .is_some_and(|wait| wait.generation == generation)
}

fn finish_memory_wait(recording_id: &str, generation: u64) {
    let mut waits = MEMORY_WAITS.lock().unwrap_or_else(|e| e.into_inner());
    if waits
        .get(recording_id)
        .is_some_and(|wait| wait.generation == generation)
    {
        waits.remove(recording_id);
    }
}

/// Signals `ActivePass::released` when dropped, including by an abort.
struct ReleaseOnDrop(tokio::sync::watch::Sender<bool>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

/// Run one pass under the meeting's current wait so a cancel can abort it.
/// Returns `None` when the wait was cancelled or superseded, before or
/// during the pass.
async fn run_registered_pass<F, Fut, T>(recording_id: &str, generation: u64, pass: F) -> Option<T>
where
    F: FnOnce(PassCancel) -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let cancel = PassCancel::default();
    let (abort, registration) = futures_util::future::AbortHandle::new_pair();
    let (released_tx, released) = tokio::sync::watch::channel(false);
    let checkpoints = {
        let mut waits = MEMORY_WAITS.lock().unwrap_or_else(|e| e.into_inner());
        match waits.get_mut(recording_id) {
            Some(wait) if wait.generation == generation => {
                wait.active = Some(ActivePass {
                    abort,
                    cancel: cancel.clone(),
                    released,
                });
                Arc::clone(&wait.checkpoints)
            }
            _ => return None,
        }
    };
    let _released = ReleaseOnDrop(released_tx);
    let result = futures_util::future::Abortable::new(
        llm::grounded::with_notes_checkpoints(checkpoints, pass(cancel.clone())),
        registration,
    )
    .await;
    {
        let mut waits = MEMORY_WAITS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(wait) = waits.get_mut(recording_id) {
            if wait.generation == generation {
                wait.active = None;
            }
        }
    }
    match result {
        Ok(value) if !cancel.is_cancelled() => Some(value),
        _ => None,
    }
}

/// Stop retrying a meeting's notes, abort a pass that is running for it, and
/// wait until that pass and its model request have let go. The stored notice
/// and its retry stay.
pub(crate) async fn cancel_memory_wait(recording_id: &str) -> bool {
    let Some(wait) = MEMORY_WAITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(recording_id)
    else {
        return false;
    };
    let Some(active) = wait.active else {
        return true;
    };
    active.stop();
    let mut released = active.released;
    if tokio::time::timeout(CANCEL_RELEASE_TIMEOUT, released.wait_for(|done| *done))
        .await
        .is_err()
    {
        tracing::warn!(recording_id = %recording_id, "A cancelled notes pass is still stopping");
        return true;
    }
    // Dropping the request asks the helper to stop; its worker holds the text
    // runtime until it has. Then end the idle helper so its memory is freed.
    let deadline = tokio::time::Instant::now() + CANCEL_HELPER_RELEASE_TIMEOUT;
    while llm::native_runtime_gate::TEXT_RUNTIME.is_busy() && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    llm::native_text::end_job();
    true
}

#[cfg(test)]
fn is_waiting_for_memory(recording_id: &str) -> bool {
    MEMORY_WAITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(recording_id)
}

fn is_memory_wait_message(error: &str) -> bool {
    error.contains(llm::native_text::MEMORY_REFUSAL)
        || error.contains(llm::native_text::WINDOW_WAIT_REFUSAL)
        || is_speech_yield_message(error)
}

fn is_speech_yield_message(error: &str) -> bool {
    error.contains(llm::native_text::SPEECH_YIELD_REFUSAL)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingAnalysisPassOutcome {
    /// Written, or failed for a reason waiting will not fix.
    Settled,
    WaitingForMemory,
    /// Gave way to a dictation or a meeting capture: tried again as soon as
    /// that ends, not on the memory backoff. Shown as the same memory wait.
    WaitingForSpeech,
}

/// Run the analysis pass, and when the built-in model has to wait for
/// memory, keep trying in the background until the notes are written or the
/// wait is cancelled. Light checks every 10 seconds; other tiers keep the
/// minute-based backoff. The person's own retry stays available.
pub(crate) async fn run_meeting_analysis_until_written(
    state: &Arc<AppState>,
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    mode: MeetingAnalysisMode,
) -> MeetingAnalysisPassOutcome {
    let generation = begin_memory_wait_generation(recording_id);
    let outcome = run_registered_pass(recording_id, generation, |cancel| {
        run_meeting_analysis_pass(state.as_ref(), handle, recording_id, mode, cancel)
    })
    .await;
    let after_speech = match outcome {
        Some(MeetingAnalysisPassOutcome::WaitingForMemory) => false,
        Some(MeetingAnalysisPassOutcome::WaitingForSpeech) => true,
        // Cancelled or superseded: the newer owner of the wait decides.
        None => return MeetingAnalysisPassOutcome::Settled,
        Some(settled) => {
            finish_memory_wait(recording_id, generation);
            return settled;
        }
    };
    let state = Arc::clone(state);
    let handle = handle.clone();
    let recording_id = recording_id.to_owned();
    tokio::spawn(async move {
        retry_meeting_analysis_for_memory(&state, &handle, &recording_id, generation, after_speech)
            .await;
    });
    MeetingAnalysisPassOutcome::WaitingForMemory
}

async fn retry_meeting_analysis_for_memory(
    state: &Arc<AppState>,
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    generation: u64,
    after_speech: bool,
) {
    let state = state.as_ref();
    drive_memory_retries(
        crate::hardware_tier::current(),
        move || async move {
            state.audio_capture.lock().await.is_recording() || llm::speech_priority::speech_active()
        },
        after_speech,
        move || memory_wait_is_current(recording_id, generation),
        move || async move {
            let outcome = run_registered_pass(recording_id, generation, |cancel| {
                run_meeting_analysis_pass(
                    state,
                    handle,
                    recording_id,
                    MeetingAnalysisMode::MissingOnly,
                    cancel,
                )
            })
            .await;
            if outcome == Some(MeetingAnalysisPassOutcome::Settled) {
                finish_memory_wait(recording_id, generation);
            }
            outcome
        },
    )
    .await;
}

/// Poll until no call is being captured. `None` means the wait was cancelled
/// meanwhile; otherwise whether a call had to be waited out.
async fn wait_out_capture<C, CF>(capturing: &mut C, is_current: &impl Fn() -> bool) -> Option<bool>
where
    C: FnMut() -> CF,
    CF: std::future::Future<Output = bool>,
{
    let mut waited = false;
    while capturing().await {
        waited = true;
        tokio::time::sleep(MEMORY_RETRY_POLL).await;
        if !is_current() {
            return None;
        }
    }
    Some(waited)
}

/// The retry schedule, apart from the app state so it can be tested on a
/// paused clock. Capture always wins: the first retry comes once a call ends,
/// and a call that starts during a backoff is waited out before generating.
/// `capturing` also covers dictation; a pass that gave way to speech
/// (`after_speech`) is retried as soon as speech ends, without the backoff.
async fn drive_memory_retries<C, CF, P, PF>(
    tier: crate::hardware_tier::HardwareTier,
    mut capturing: C,
    mut after_speech: bool,
    is_current: impl Fn() -> bool,
    mut run_pass: P,
) where
    C: FnMut() -> CF,
    CF: std::future::Future<Output = bool>,
    P: FnMut() -> PF,
    PF: std::future::Future<Output = Option<MeetingAnalysisPassOutcome>>,
{
    let mut delay = first_memory_retry_delay(tier);
    loop {
        // During a call the capture and transcription own the memory.
        let Some(waited_for_call) = wait_out_capture(&mut capturing, &is_current).await else {
            return;
        };
        if !waited_for_call && !after_speech {
            let wake = tokio::time::Instant::now() + delay;
            while tokio::time::Instant::now() < wake {
                tokio::time::sleep(MEMORY_RETRY_POLL.min(wake - tokio::time::Instant::now())).await;
                if !is_current() {
                    return;
                }
            }
            delay = if tier == crate::hardware_tier::HardwareTier::Light {
                first_memory_retry_delay(tier)
            } else {
                next_memory_retry_delay(delay)
            };
            if wait_out_capture(&mut capturing, &is_current)
                .await
                .is_none()
            {
                return;
            }
        }
        if !is_current() {
            return;
        }
        match run_pass().await {
            Some(MeetingAnalysisPassOutcome::WaitingForMemory) => after_speech = false,
            Some(MeetingAnalysisPassOutcome::WaitingForSpeech) => after_speech = true,
            _ => return,
        }
    }
}

pub(crate) fn emit_meeting_analysis_status(
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    phase: MeetingAnalysisPhase,
    error: Option<&str>,
) {
    handle.emit_event(
        "meeting-analysis-status",
        serde_json::json!({
            "recordingId": recording_id,
            "phase": phase.as_str(),
            "error": error,
        }),
    );
}

/// Persist (or clear) a meeting's analysis failure and announce the outcome.
///
/// Persistence and the event are deliberately paired: an event alone is lost the
/// moment the window reloads, and a column alone never reaches an open library
/// view. A failure to write the column must not mask the failure being reported,
/// so it degrades to a log.
pub(crate) async fn record_meeting_analysis_outcome(
    state: &AppState,
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    failure: Option<&str>,
) {
    {
        let mut db = state.db.lock().await;
        if let Err(error) = db.set_recording_analysis_failure(recording_id, failure) {
            tracing::warn!(
                "Failed to persist analysis outcome for {}: {}",
                recording_id,
                error
            );
        }
    }
    match failure {
        Some(reason) => emit_meeting_analysis_status(
            handle,
            recording_id,
            MeetingAnalysisPhase::Failed,
            Some(reason),
        ),
        None => emit_meeting_analysis_status(
            handle,
            recording_id,
            MeetingAnalysisPhase::Completed,
            None,
        ),
    }
}

#[derive(Debug, thiserror::Error)]
enum MeetingSummaryError {
    #[error("{0}")]
    Input(String),
    #[error(transparent)]
    Provider(#[from] llm::transport::LlmError),
}

impl From<String> for MeetingSummaryError {
    fn from(error: String) -> Self {
        Self::Input(error)
    }
}

impl MeetingSummaryError {
    fn is_timeout(&self) -> bool {
        matches!(self, Self::Provider(error) if error.kind == llm::transport::ErrorKind::Timeout)
    }

    fn is_memory_wait(&self) -> bool {
        match self {
            Self::Provider(error) => {
                llm::native_text::is_memory_wait(error) || llm::native_text::is_speech_yield(error)
            }
            Self::Input(message) => is_memory_wait_message(message),
        }
    }

    fn is_speech_yield(&self) -> bool {
        match self {
            Self::Provider(error) => llm::native_text::is_speech_yield(error),
            Self::Input(message) => is_speech_yield_message(message),
        }
    }
}

async fn run_action_items_unless_summary_timed_out<T>(
    summary_timed_out: bool,
    action_items: impl std::future::Future<Output = T>,
) -> Option<T> {
    if summary_timed_out {
        None
    } else {
        Some(action_items.await)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MeetingAnalysisMode {
    Automatic,
    MissingOnly,
}

/// A stored empty list is also complete: the database distinguishes an unsaved
/// artifact default from an explicitly saved empty list when loading recordings.
fn meeting_analysis_stages(
    mode: MeetingAnalysisMode,
    summary: Option<&str>,
    action_items: Option<&[String]>,
    has_action_provenance: bool,
) -> (bool, bool) {
    if mode == MeetingAnalysisMode::Automatic {
        return (true, true);
    }
    (
        summary.is_none_or(|text| text.trim().is_empty() || llm::is_transcript_facts_notes(text)),
        action_items.is_none() && !has_action_provenance,
    )
}

fn meeting_title_fallback_allowed(mode: MeetingAnalysisMode, summary: Option<&str>) -> bool {
    summary.is_none_or(llm::is_transcript_facts_notes)
        || (mode == MeetingAnalysisMode::MissingOnly
            && summary.and_then(build_meeting_title_from_summary).is_none())
}

/// Run the meeting analysis pass: summary, action items, and title.
///
/// Shared by the automatic post-meeting lane and `retry_meeting_analysis` so a
/// retry fills missing stages while retaining saved analysis.
///
/// `auto_name_meeting_recording` runs unconditionally at the end. It used to run
/// only when auto-analysis was disabled, or as a side effect of a *successful*
/// summary, so the one case that most needed a title -- analysis failing on a
/// default install -- was the case that never got one, and the meeting kept its
/// placeholder name forever.
pub(crate) async fn run_meeting_analysis_pass(
    state: &AppState,
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
    mode: MeetingAnalysisMode,
    cancel: PassCancel,
) -> MeetingAnalysisPassOutcome {
    let work = async {
        // A cancelled pass writes nothing from here on. The abort handle stops
        // it at its next await; these checks cover the save boundaries.
        if cancel.is_cancelled() {
            return MeetingAnalysisPassOutcome::Settled;
        }
        // One heavy job at a time after a call: the whole pass (summary, action
        // items, title) counts as foreground text work, so search indexing does
        // not load its model in the gaps between stages while the notes model is
        // still resident.
        let _foreground = crate::llm::local_model_load::foreground_work();
        emit_meeting_analysis_status(handle, recording_id, MeetingAnalysisPhase::Running, None);

        let recording = {
            let db = state.db.lock().await;
            db.get_recording(recording_id)
                .map_err(|error| error.to_string())
                .and_then(|recording| {
                    recording.ok_or_else(|| format!("Recording not found: {}", recording_id))
                })
        };
        let recording = match recording {
            Ok(recording) => recording,
            Err(error) => {
                if !cancel.is_cancelled() {
                    record_meeting_analysis_outcome(state, handle, recording_id, Some(&error))
                        .await;
                }
                return MeetingAnalysisPassOutcome::Settled;
            }
        };
        let (run_summary, run_actions) = meeting_analysis_stages(
            mode,
            recording.summary.as_deref(),
            recording.action_items.as_deref(),
            recording.action_items_provenance.is_some(),
        );

        // Summary and action items are independent safe patches. A failed pass
        // leaves any prior successful content and provenance untouched.
        let mut failure_reasons: Vec<String> = Vec::new();
        let mut summary_text = if mode == MeetingAnalysisMode::MissingOnly {
            recording
                .summary
                .clone()
                .filter(|text| !text.trim().is_empty() && !llm::is_transcript_facts_notes(text))
        } else {
            None
        };
        let mut summary_timed_out = false;
        let mut waiting_for_memory = false;
        let mut yielded_to_speech = false;

        if run_summary {
            match summarize_recording_grounded_typed(
                state,
                recording_id,
                None,
                Some(cancellable_progress(
                    &cancel,
                    analysis_progress_callback(handle, recording_id, "summary", None),
                )),
            )
            .await
            {
                Ok(mut result) => {
                    if cancel.is_cancelled() {
                        return MeetingAnalysisPassOutcome::Settled;
                    }
                    if mode == MeetingAnalysisMode::MissingOnly {
                        result.snapshot.expected_summary = recording.summary.clone();
                    }
                    match persist_grounded_summary(state, recording_id, &result).await {
                        Ok(recording) => {
                            emit_analysis_ready(handle, &recording, "summary");
                            summary_text = Some(result.summary.clone());
                        }
                        Err(error) => {
                            emit_analysis_failure(handle, recording_id, "summary", None, &error);
                            failure_reasons.push(format!("summary: {}", error));
                        }
                    }
                }
                Err(error) => {
                    if cancel.is_cancelled() {
                        return MeetingAnalysisPassOutcome::Settled;
                    }
                    summary_timed_out = error.is_timeout();
                    if error.is_memory_wait() {
                        waiting_for_memory = true;
                        yielded_to_speech |= error.is_speech_yield();
                    } else {
                        emit_analysis_failure(
                            handle,
                            recording_id,
                            "summary",
                            None,
                            &error.to_string(),
                        );
                        // The meeting still gets its decisions, tasks and
                        // figures, quoted from the transcript; the failure
                        // stays recorded so Retry notes is offered.
                        if leaves_transcript_facts(recording.summary.as_deref()) {
                            match transcript_facts_summary(state, recording_id, &error).await {
                                Ok(mut facts) => {
                                    facts.snapshot.expected_summary = recording.summary.clone();
                                    match persist_grounded_summary(state, recording_id, &facts)
                                        .await
                                    {
                                        Ok(saved) => emit_analysis_ready(handle, &saved, "summary"),
                                        Err(error) => tracing::warn!(
                                            "Could not save transcript facts for {}: {}",
                                            recording_id,
                                            error
                                        ),
                                    }
                                }
                                Err(error) => tracing::warn!(
                                    "Could not build transcript facts for {}: {}",
                                    recording_id,
                                    error
                                ),
                            }
                        }
                    }
                    failure_reasons.push(format!("summary: {}", error));
                }
            }
        } else {
            emit_analysis_ready(handle, &recording, "summary");
        }

        if run_actions {
            match run_action_items_unless_summary_timed_out(
                summary_timed_out,
                extract_action_items_grounded_internal(
                    state,
                    recording_id,
                    None,
                    Some(cancellable_progress(
                        &cancel,
                        analysis_progress_callback(handle, recording_id, "actionItems", None),
                    )),
                ),
            )
            .await
            {
                _ if cancel.is_cancelled() => return MeetingAnalysisPassOutcome::Settled,
                Some(Ok(mut result)) => {
                    if mode == MeetingAnalysisMode::MissingOnly {
                        // Compare against the pass entry, including edits made during summary generation.
                        result.snapshot.expected_action_items = recording.action_items.clone();
                    }
                    match persist_grounded_action_items(state, recording_id, &result).await {
                        Ok(recording) => emit_analysis_ready(handle, &recording, "actionItems"),
                        Err(error) => {
                            emit_analysis_failure(
                                handle,
                                recording_id,
                                "actionItems",
                                None,
                                &error,
                            );
                            failure_reasons.push(format!("action items: {}", error));
                        }
                    }
                }
                Some(Err(error)) => {
                    if is_memory_wait_message(&error) {
                        waiting_for_memory = true;
                        yielded_to_speech |= is_speech_yield_message(&error);
                    } else {
                        emit_analysis_failure(handle, recording_id, "actionItems", None, &error);
                    }
                    failure_reasons.push(format!("action items: {}", error));
                }
                None => {
                    let reason = "Action extraction skipped because the summary model timed out. Retry meeting analysis to try again.";
                    emit_analysis_failure(handle, recording_id, "actionItems", None, reason);
                    failure_reasons.push(reason.to_string());
                }
            }
        } else {
            emit_analysis_ready(handle, &recording, "actionItems");
        }

        if cancel.is_cancelled() {
            return MeetingAnalysisPassOutcome::Settled;
        }
        // A meeting whose summary failed still deserves a real name. With a
        // summary it titles from that; without one it falls back to the
        // transcript, which is exactly the path a failed analysis needs. A
        // pass that gave way to speech is the exception: it comes back once
        // speech ends, and naming now would fix a fallback title before the
        // summary it should come from.
        let title = if yielded_to_speech {
            Ok(None)
        } else {
            auto_name_meeting_recording(
                state,
                handle,
                recording_id,
                summary_text.as_deref(),
                meeting_title_fallback_allowed(mode, summary_text.as_deref()),
            )
            .await
        };
        if let Err(error) = title {
            tracing::warn!("Meeting auto-name failed for '{}': {}", recording_id, error);
            if is_memory_wait_message(&error) {
                waiting_for_memory = true;
                yielded_to_speech |= is_speech_yield_message(&error);
            }
            failure_reasons.push(format!("title: {}", error));
        }

        // The notes job is over; its helper process exits and frees its memory.
        llm::native_text::end_job();

        if cancel.is_cancelled() {
            return MeetingAnalysisPassOutcome::Settled;
        }
        if failure_reasons.is_empty() {
            record_meeting_analysis_outcome(state, handle, recording_id, None).await;
            MeetingAnalysisPassOutcome::Settled
        } else if waiting_for_memory {
            tracing::info!(recording_id = %recording_id, "Meeting notes are waiting for memory");
            {
                let mut db = state.db.lock().await;
                if let Err(error) =
                    db.set_recording_analysis_failure(recording_id, Some(MEMORY_WAIT_NOTICE))
                {
                    tracing::warn!(
                        "Failed to persist the memory wait for {}: {}",
                        recording_id,
                        error
                    );
                }
            }
            emit_meeting_analysis_status(
                handle,
                recording_id,
                MeetingAnalysisPhase::Waiting,
                Some(MEMORY_WAIT_NOTICE),
            );
            if yielded_to_speech {
                MeetingAnalysisPassOutcome::WaitingForSpeech
            } else {
                MeetingAnalysisPassOutcome::WaitingForMemory
            }
        } else {
            let reason = failure_reasons.join("; ");
            tracing::warn!(
                recording_id = %recording_id,
                failure_count = failure_reasons.len(),
                "Automatic analysis finished with failures"
            );
            record_meeting_analysis_outcome(state, handle, recording_id, Some(&reason)).await;
            MeetingAnalysisPassOutcome::Settled
        }
    };
    // Every built-in model request of the pass yields to live speech.
    state
        .operation_coordinator
        .run_post_call(
            "meeting recap, action items and title",
            llm::speech_priority::as_background_text(work),
        )
        .await
}

/// Brief retrieval considers the newest 200 meetings, capped in SQL.
pub(crate) const MEETING_BRIEF_SCAN_LIMIT: usize = 200;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeetingBriefResult {
    event_id: String,
    /// "ready" — a written brief with citations.
    /// "sources_only" — related meetings found, but no brief could be
    ///   written; `unavailableReason` says why, and the renderer shows the
    ///   raw list. This is the state a Mac with no AI route lands in.
    /// "no_sources" — no eligible source in the newest 200 meetings.
    state: String,
    related: Vec<meeting_brief::RelatedMeeting>,
    brief: Option<String>,
    citations: Vec<llm::Citation>,
    grounded: bool,
    model: Option<String>,
    actual_provider: Option<String>,
    unavailable_reason: Option<String>,
    generated_at: Option<chrono::DateTime<chrono::Utc>>,
    /// True when this answer came back from the cache rather than a model.
    cached: bool,
}

/// A pre-meeting brief, from local data only.
///
/// The only thing that leaves this Mac is the prompt, and only down the AI
/// route the reader already chose for meetings. The evidence is prior
/// recordings' own summaries, decisions and action items -- text that is
/// already on disk -- and it travels as grounded lines, which `grounded.rs`
/// fences and the shared system prompt declares untrusted. The instruction is
/// the fixed `BRIEF_INSTRUCTION`; nothing the reader or a transcript wrote is
/// ever concatenated into it.
///
/// A failure to reach a model is not an error here. It is the
/// `sources_only` state, which still carries the related meetings and their
/// open items -- which is most of what a brief is, and all of it on a Mac
/// with no analysis provider configured.
pub(crate) async fn prepare_meeting_brief(
    state: &AppState,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let event_id: String =
        serde_json::from_value(params["eventId"].clone()).map_err(|e| e.to_string())?;
    let title: String =
        serde_json::from_value(params["title"].clone()).map_err(|e| e.to_string())?;
    let attendees: Vec<models::MeetingAttendee> = match params.get("attendees") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
    };
    let refresh = params
        .get("refresh")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let target = meeting_brief::BriefTarget {
        event_id: event_id.clone(),
        title,
        attendees: models::sanitize_meeting_attendees(attendees),
    };

    let related = {
        let db = state.db.lock().await;
        let candidates = db
            .meeting_brief_candidates(MEETING_BRIEF_SCAN_LIMIT)
            .map_err(|e| e.to_string())?;
        meeting_brief::related_meetings(&target, &candidates)
    };
    let attendee_names = models::attendee_names_for_context(&target.attendees);

    if related.is_empty() {
        return serde_json::to_value(MeetingBriefResult {
            event_id,
            state: "no_sources".to_string(),
            related,
            brief: None,
            citations: Vec::new(),
            grounded: false,
            model: None,
            actual_provider: None,
            unavailable_reason: None,
            generated_at: None,
            cached: false,
        })
        .map_err(|e| e.to_string());
    }

    let evidence = meeting_brief::brief_evidence_lines(&related);
    let cache_key = meeting_brief::brief_cache_key(&target, &attendee_names, &evidence);

    if !refresh {
        let cached = {
            let db = state.db.lock().await;
            db.get_meeting_brief(&event_id, &cache_key)
                .map_err(|e| e.to_string())?
        };
        if let Some(payload) = cached {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&payload) {
                // The list is re-derived rather than cached with the answer:
                // a related meeting could have been deleted since, and a
                // panel offering a link to a row that is gone is worse than
                // a slightly slower render.
                value["related"] = serde_json::to_value(&related).map_err(|e| e.to_string())?;
                value["cached"] = serde_json::Value::Bool(true);
                return Ok(value);
            }
        }
    }

    let segments: Vec<AnalysisContextSegment> = evidence
        .iter()
        .map(|line| AnalysisContextSegment {
            recording_id: line.recording_id.clone(),
            segment_id: line.segment_id.clone(),
            text: line.text.clone(),
            // A brief cites a prior MEETING, not a moment inside one, so
            // there is no timestamp to claim. Zero here rather than a
            // fabricated offset the renderer would render as "0.0s - 0.0s"
            // in a transcript that has no such line.
            start_time: 0.0,
            end_time: 0.0,
        })
        .collect();

    let notes = meeting_brief::brief_context_notes(&target.title, &attendee_names);
    let output = run_grounded_response_for_segments(
        state,
        segments,
        meeting_brief::BRIEF_INSTRUCTION,
        Some(&notes),
        None,
        llm::CompletionPurpose::Ask,
        None,
    )
    .await;

    let result = match output {
        Ok(output) if !output.response.trim().is_empty() => MeetingBriefResult {
            event_id: event_id.clone(),
            state: "ready".to_string(),
            related: related.clone(),
            brief: Some(output.response),
            citations: output.citations,
            grounded: meeting_brief::brief_is_grounded(output.grounded, &related),
            model: Some(output.model),
            actual_provider: Some(output.actual_provider),
            unavailable_reason: None,
            generated_at: Some(chrono::Utc::now()),
            cached: false,
        },
        Ok(_) => MeetingBriefResult {
            event_id: event_id.clone(),
            state: "sources_only".to_string(),
            related: related.clone(),
            brief: None,
            citations: Vec::new(),
            grounded: false,
            model: None,
            actual_provider: None,
            unavailable_reason: Some("The analysis provider returned an empty brief.".to_string()),
            generated_at: None,
            cached: false,
        },
        Err(error) => MeetingBriefResult {
            event_id: event_id.clone(),
            state: "sources_only".to_string(),
            related: related.clone(),
            brief: None,
            citations: Vec::new(),
            grounded: false,
            model: None,
            actual_provider: None,
            unavailable_reason: Some(error),
            generated_at: None,
            cached: false,
        },
    };

    let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    // Only a real brief is worth caching. Caching a failure would make a
    // fixed AI route look broken until the evidence happened to change.
    if result.state == "ready" {
        let payload = value.to_string();
        let mut db = state.db.lock().await;
        if let Err(error) = db.save_meeting_brief(&event_id, &cache_key, &payload) {
            tracing::warn!("Failed to cache the pre-meeting brief: {}", error);
        }
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq)]
struct AskSourceState {
    revision: i64,
    complete: bool,
    asr_reason: Option<String>,
    capture_warning: Option<String>,
}

pub(crate) fn select_recording_ask_segments(
    recording_id: &str,
    segments: Vec<models::TranscriptSegment>,
) -> impl Iterator<Item = AnalysisContextSegment> + '_ {
    segments
        .into_iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .enumerate()
        .map(move |(index, segment)| AnalysisContextSegment {
            recording_id: recording_id.to_string(),
            segment_id: if segment.id.is_empty() {
                format!("seg_{index}")
            } else {
                segment.id
            },
            text: segment.text,
            start_time: segment.start_time,
            end_time: segment.end_time,
        })
}

fn ask_timestamp_key(time: f64) -> u64 {
    if time == 0.0 {
        0
    } else {
        time.to_bits()
    }
}

fn load_ask_sources(
    db: &db::Database,
    segments: &[AnalysisContextSegment],
) -> Result<std::collections::HashMap<String, AskSourceState>, String> {
    let mut selected_by_recording =
        std::collections::HashMap::<&str, Vec<&AnalysisContextSegment>>::new();
    for segment in segments {
        selected_by_recording
            .entry(&segment.recording_id)
            .or_default()
            .push(segment);
    }
    let mut sources = std::collections::HashMap::new();
    for (recording_id, selected) in selected_by_recording {
        let recording = db
            .get_recording(recording_id)
            .map_err(|error| error.to_string())?
            .ok_or("Ask source recording was deleted")?;
        let (transcript, revision) = db
            .get_transcript_with_revision(recording_id)
            .map_err(|error| error.to_string())?
            .ok_or("Ask source transcript is missing")?;
        let mut current_segments = std::collections::HashSet::new();
        let mut fallback_ids = Vec::new();
        for (index, current) in transcript
            .segments
            .iter()
            .filter(|s| !s.text.trim().is_empty())
            .enumerate()
        {
            fallback_ids.push(if current.id.is_empty() {
                format!("seg_{index}")
            } else {
                String::new()
            });
        }
        for (current, fallback_id) in transcript
            .segments
            .iter()
            .filter(|s| !s.text.trim().is_empty())
            .zip(&fallback_ids)
        {
            if current.start_time.is_nan() || current.end_time.is_nan() {
                continue;
            }
            let key = (
                current.id.as_str(),
                current.text.as_str(),
                ask_timestamp_key(current.start_time),
                ask_timestamp_key(current.end_time),
            );
            current_segments.insert(key);
            if current.id.is_empty() {
                current_segments.insert((fallback_id.as_str(), key.1, key.2, key.3));
            }
        }
        for selected in selected {
            // A transcript row matches exactly; a search window matches while
            // it still quotes a run of the current rows (whatever rule or
            // tokenizer built it).
            let row_matches = !selected.start_time.is_nan()
                && !selected.end_time.is_nan()
                && current_segments.contains(&(
                    selected.segment_id.as_str(),
                    selected.text.as_str(),
                    ask_timestamp_key(selected.start_time),
                    ask_timestamp_key(selected.end_time),
                ));
            if !row_matches
                && !crate::semantic_index::window_matches_transcript(selected, &transcript.segments)
            {
                return Err(
                    "Ask source text or timestamps changed; refresh the search and try again."
                        .into(),
                );
            }
        }
        sources.insert(
            recording_id.to_string(),
            AskSourceState {
                revision,
                complete: recording.transcript_complete,
                asr_reason: recording.transcript_degraded_reason,
                capture_warning: recording.capture_degraded_summary,
            },
        );
    }
    Ok(sources)
}

fn ask_sources_allow_grounded(
    sources: &std::collections::HashMap<String, AskSourceState>,
    citations: &[llm::Citation],
) -> bool {
    !citations.is_empty()
        && citations.iter().all(|citation| {
            let Some(source) = citation
                .recording_id
                .as_ref()
                .and_then(|id| sources.get(id))
            else {
                return false;
            };
            // These routes supply only spoken segments. Written-note evidence is
            // added and checked by the single-recording route.
            citation.source_kind.as_deref() != Some("meeting_note")
                && source.complete
                && source
                    .asr_reason
                    .as_deref()
                    .is_none_or(|s| s.trim().is_empty())
                && source
                    .capture_warning
                    .as_deref()
                    .is_none_or(|s| s.trim().is_empty())
        })
}

/// The sources that still quote their recording's current transcript, in
/// order. Search results can go stale between the search and the answer (an
/// edit, a re-transcription); those are dropped rather than failing Ask.
fn current_ask_sources(
    db: &db::Database,
    segments: Vec<AnalysisContextSegment>,
) -> Result<Vec<AnalysisContextSegment>, String> {
    let mut kept = Vec::with_capacity(segments.len());
    let mut verdicts = std::collections::HashMap::<String, bool>::new();
    for segment in segments {
        let key = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            segment.recording_id,
            segment.segment_id,
            segment.text,
            segment.start_time.to_bits(),
            segment.end_time.to_bits()
        );
        let current = match verdicts.get(&key) {
            Some(current) => *current,
            None => {
                let current = load_ask_sources(db, std::slice::from_ref(&segment)).is_ok();
                verdicts.insert(key, current);
                current
            }
        };
        if current {
            kept.push(segment);
        }
    }
    Ok(kept)
}

/// Whether Ask fails or carries on when a source no longer matches the
/// transcript: sources the user chose fail, search results are dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StaleAskSources {
    Fail,
    Drop,
}

pub(crate) async fn run_grounded_ask_for_selected_segments(
    state: &AppState,
    segments: Vec<AnalysisContextSegment>,
    query: &str,
    model: Option<&str>,
    stale: StaleAskSources,
) -> Result<llm::AnalysisResult, String> {
    let segments = match stale {
        StaleAskSources::Fail => segments,
        StaleAskSources::Drop => {
            let kept = current_ask_sources(&*state.db.lock().await, segments)?;
            if kept.is_empty() {
                return Err(
                    "The passages search found changed before Ask could read them; try again."
                        .into(),
                );
            }
            kept
        }
    };
    let sources = load_ask_sources(&*state.db.lock().await, &segments)?;
    let mut output = run_grounded_response_for_segments(
        state,
        segments.clone(),
        query,
        None,
        model,
        llm::CompletionPurpose::Ask,
        None,
    )
    .await?;
    let current = load_ask_sources(&*state.db.lock().await, &segments)?;
    if current != sources {
        return Err(
            "Ask source transcript or integrity changed while analysis was running; try again."
                .into(),
        );
    }
    output.grounded &= ask_sources_allow_grounded(&sources, &output.citations);
    Ok(analysis_result_from_grounded(query, output))
}

#[cfg(test)]
mod selected_ask_source_tests {
    use super::*;

    fn citation(id: Option<&str>) -> llm::Citation {
        llm::Citation {
            text: "Current words".into(),
            source_kind: Some("transcript".into()),
            line_id: None,
            segment_id: Some("s1".into()),
            start_time: Some(0.0),
            end_time: Some(1.0),
            recording_id: id.map(str::to_string),
            certainty: None,
        }
    }

    #[test]
    fn only_cited_intact_known_spoken_sources_allow_grounding() {
        let intact = AskSourceState {
            revision: 1,
            complete: true,
            asr_reason: None,
            capture_warning: None,
        };
        let mut sources = std::collections::HashMap::from([
            ("clean".into(), intact.clone()),
            (
                "partial".into(),
                AskSourceState {
                    complete: false,
                    ..intact.clone()
                },
            ),
        ]);
        assert!(ask_sources_allow_grounded(
            &sources,
            &[citation(Some("clean"))]
        ));
        assert!(!ask_sources_allow_grounded(
            &sources,
            &[citation(Some("partial"))]
        ));
        assert!(!ask_sources_allow_grounded(
            &sources,
            &[citation(Some("unknown"))]
        ));
        assert!(!ask_sources_allow_grounded(&sources, &[citation(None)]));
        assert!(!ask_sources_allow_grounded(&sources, &[]));
        let mut unsupported_note = citation(Some("partial"));
        unsupported_note.source_kind = Some("meeting_note".into());
        assert!(!ask_sources_allow_grounded(&sources, &[unsupported_note]));
        sources.get_mut("clean").unwrap().capture_warning = Some("missing audio".into());
        assert!(!ask_sources_allow_grounded(
            &sources,
            &[citation(Some("clean"))]
        ));
        sources.get_mut("clean").unwrap().capture_warning = None;
        sources.get_mut("clean").unwrap().asr_reason = Some("ASR partial".into());
        assert!(!ask_sources_allow_grounded(
            &sources,
            &[citation(Some("clean"))]
        ));
    }

    #[test]
    fn real_schema_production_selection_filters_blanks_and_matches_duplicate_ids_exactly() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-ask-selection-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut db = db::Database::open_at_path(&path, None).unwrap();
        let now = chrono::Utc::now();
        let recording: models::Recording = serde_json::from_value(serde_json::json!({
            "id": "r1", "title": "Test", "projectId": "inbox", "duration": 4,
            "createdAt": now, "updatedAt": now, "sourceType": "meeting",
            "audioPath": "", "status": "completed", "transcriptComplete": true,
        }))
        .unwrap();
        db.create_recording(&recording).unwrap();
        let row = |id: &str, text: &str, start_time, end_time| models::TranscriptSegment {
            id: id.into(),
            text: text.into(),
            start_time,
            end_time,
            speaker_id: None,
            confidence: 1.0,
        };
        let transcript = models::Transcript {
            heard_through_speakers: Vec::new(),
            id: "t1".into(),
            recording_id: "r1".into(),
            segments: vec![
                row("blank", " \t\n", 0.0, 1.0),
                row("", "Fallback words", 1.0, 2.0),
                row("shared", "First words", 2.0, 3.0),
                row("shared", "Second words", 3.0, 4.0),
            ],
            full_text: "Fallback words First words Second words".into(),
            language: "en".into(),
            confidence: 1.0,
            model: "test".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: false,
            created_at: now,
        };
        db.save_transcript(&transcript).unwrap();
        let saved = db.get_transcript("r1").unwrap().unwrap();
        let selected: Vec<_> = select_recording_ask_segments("r1", saved.segments).collect();
        assert_eq!(selected.len(), 3);
        assert_eq!(selected[0].segment_id, "seg_0");
        assert!(load_ask_sources(&db, &selected).is_ok());
        let mut stale = selected.clone();
        stale[1].text = "Second words".into();
        assert!(load_ask_sources(&db, &stale).is_err());
        stale = selected.clone();
        stale[2].start_time = 2.0;
        assert!(load_ask_sources(&db, &stale).is_err());
        assert_eq!(
            select_recording_ask_segments("r1", vec![row("blank", " ", 0.0, 1.0)]).count(),
            0
        );
        assert_eq!(ask_timestamp_key(-0.0), ask_timestamp_key(0.0));
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn meaning_search_windows_are_accepted_only_while_they_match_the_transcript() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-ask-windows-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut db = db::Database::open_at_path(&path, None).unwrap();
        let now = chrono::Utc::now();
        let recording: models::Recording = serde_json::from_value(serde_json::json!({
            "id": "r1", "title": "Test", "projectId": "inbox", "duration": 4,
            "createdAt": now, "updatedAt": now, "sourceType": "meeting",
            "audioPath": "", "status": "completed", "transcriptComplete": true,
        }))
        .unwrap();
        db.create_recording(&recording).unwrap();
        let segments: Vec<models::TranscriptSegment> = ["We", "chose", "the", "kinetic", "battery"]
            .iter()
            .enumerate()
            .map(|(index, word)| models::TranscriptSegment {
                id: format!("w{index}"),
                text: (*word).into(),
                start_time: index as f64 * 0.3,
                end_time: index as f64 * 0.3 + 0.25,
                speaker_id: Some("s1".into()),
                confidence: 1.0,
            })
            .collect();
        db.save_transcript(&models::Transcript {
            heard_through_speakers: Vec::new(),
            id: "t1".into(),
            recording_id: "r1".into(),
            segments: segments.clone(),
            full_text: "We chose the kinetic battery".into(),
            language: "en".into(),
            confidence: 1.0,
            model: "test".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: true,
            created_at: now,
        })
        .unwrap();
        let windows = crate::semantic_index::estimated_windows("r1", &segments);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].text, "We chose the kinetic battery");
        assert!(load_ask_sources(&db, &windows).is_ok());
        let mut stale = windows.clone();
        stale[0].text = "We chose the solar battery".into();
        assert!(load_ask_sources(&db, &stale).is_err());
        // Search results that went stale are dropped, the rest kept.
        let mut mixed = stale.clone();
        mixed.extend(windows.clone());
        assert_eq!(current_ask_sources(&db, mixed).unwrap(), windows);
        db.update_transcript_segment("r1", "w3", "solar").unwrap();
        assert!(load_ask_sources(&db, &windows).is_err());
        assert!(current_ask_sources(&db, windows.clone())
            .unwrap()
            .is_empty());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn real_schema_selected_sources_reject_stale_rows_and_track_integrity() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-ask-sources-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut db = db::Database::open_at_path(&path, None).unwrap();
        let now = chrono::Utc::now();
        let recording: models::Recording = serde_json::from_value(serde_json::json!({
            "id": "r1", "title": "Test", "projectId": "inbox", "duration": 1,
            "createdAt": now, "updatedAt": now, "sourceType": "meeting",
            "audioPath": "", "status": "completed", "transcriptComplete": true,
        }))
        .unwrap();
        db.create_recording(&recording).unwrap();
        let segment = models::TranscriptSegment {
            id: "s1".into(),
            text: "Current words".into(),
            start_time: 0.0,
            end_time: 1.0,
            speaker_id: None,
            confidence: 1.0,
        };
        let transcript = models::Transcript {
            heard_through_speakers: Vec::new(),
            id: "t1".into(),
            recording_id: "r1".into(),
            segments: vec![segment.clone()],
            full_text: segment.text.clone(),
            language: "en".into(),
            confidence: 1.0,
            model: "test".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: false,
            created_at: now,
        };
        db.save_transcript(&transcript).unwrap();
        let selected = vec![AnalysisContextSegment {
            recording_id: "r1".into(),
            segment_id: "s1".into(),
            text: segment.text,
            start_time: 0.0,
            end_time: 1.0,
        }];
        let original = load_ask_sources(&db, &selected).unwrap();
        let snapshot = RecordingAnalysisSnapshot {
            transcript_revision: original["r1"].revision,
            transcript_complete: recording.transcript_complete,
            transcript_degraded_reason: None,
            capture_degraded_summary: None,
            meeting_notes: None,
            notes_updated_at: None,
            meeting_template_id: None,
            expected_summary: None,
            expected_action_items: None,
            custom_summary_prompt: None,
            attendee_names: Vec::new(),
            speaker_names: None,
        };
        assert!(verify_analysis_snapshot(&db, "r1", &snapshot).is_ok());
        let sql = rusqlite::Connection::open(&path).unwrap();
        for mutation in [
            "UPDATE recordings SET transcript_complete = 0 WHERE id = 'r1'",
            "UPDATE recordings SET transcript_complete = 1, capture_degraded_summary = 'dropped' WHERE id = 'r1'",
            "UPDATE recordings SET capture_degraded_summary = NULL, transcript_degraded_reason = 'ASR partial' WHERE id = 'r1'",
        ] {
            sql.execute(mutation, []).unwrap();
            assert_ne!(load_ask_sources(&db, &selected).unwrap(), original);
            assert!(verify_analysis_snapshot(&db, "r1", &snapshot).is_err());
        }
        db.update_transcript_segment("r1", "s1", "Edited words")
            .unwrap();
        assert!(load_ask_sources(&db, &selected).is_err());
        let mut edited = selected.clone();
        edited[0].text = "Edited words".into();
        assert_ne!(
            load_ask_sources(&db, &edited).unwrap()["r1"].revision,
            original["r1"].revision
        );
        edited[0].end_time = 2.0;
        assert!(load_ask_sources(&db, &edited).is_err());
        db.delete_recording("r1").unwrap();
        assert!(load_ask_sources(&db, &selected).is_err());
        drop(sql);
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}

pub(crate) async fn run_grounded_response_for_segments(
    state: &AppState,
    segments: Vec<AnalysisContextSegment>,
    instruction: &str,
    notes: Option<&str>,
    model: Option<&str>,
    purpose: llm::CompletionPurpose,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<llm::GroundedTextOutput, String> {
    run_grounded_response_for_context(
        state,
        llm::GroundingContext::new(segments)?,
        instruction,
        notes,
        model,
        purpose,
        progress,
    )
    .await
}

pub(crate) async fn run_grounded_response_for_context(
    state: &AppState,
    context: llm::GroundingContext,
    instruction: &str,
    notes: Option<&str>,
    model: Option<&str>,
    purpose: llm::CompletionPurpose,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<llm::GroundedTextOutput, String> {
    run_grounded_response_for_context_typed(
        state,
        context,
        instruction,
        notes,
        GroundedResponseOptions {
            model,
            purpose,
            progress,
            meeting_summary_coverage: false,
        },
    )
    .await
    .map_err(|error| error.to_string())
}

struct GroundedResponseOptions<'a> {
    model: Option<&'a str>,
    purpose: llm::CompletionPurpose,
    progress: Option<llm::OrchestrationProgressCallback>,
    meeting_summary_coverage: bool,
}

async fn run_grounded_response_for_context_typed(
    state: &AppState,
    context: llm::GroundingContext,
    instruction: &str,
    notes: Option<&str>,
    options: GroundedResponseOptions<'_>,
) -> Result<llm::GroundedTextOutput, MeetingSummaryError> {
    state
        .operation_coordinator
        .run_post_call("meeting analysis", async {
            // Foreground text work: background indexing yields the runtime to it.
            let _foreground = crate::llm::local_model_load::foreground_work();
            let GroundedResponseOptions {
                model,
                purpose,
                progress,
                meeting_summary_coverage,
            } = options;
            let runtime =
                selected_analysis_runtime(state, settings::AiLane::Meetings, model, None).await?;
            let timeouts = analysis_timeouts(runtime.provider());
            let orchestrator = llm::GroundedOrchestrator::new(
                &runtime,
                runtime.model().to_string(),
                context,
                timeouts.request,
                timeouts.job,
                llm::OrchestrationOptions::default(),
            );
            let orchestrator = if meeting_summary_coverage {
                orchestrator
                    .with_meeting_summary_coverage()
                    .with_shared_meeting_facts()
            } else {
                orchestrator
            };
            let orchestrator = match progress {
                Some(callback) => orchestrator.with_progress_callback(callback),
                None => orchestrator,
            };
            orchestrator
                .run_response(purpose, instruction, notes)
                .await
                .map_err(MeetingSummaryError::from)
        })
        .await
}

/// Meeting recaps quote source sentences that a model selects; nothing the
/// model writes is shown. The earlier free-prose recap pipeline stays
/// compiled behind this internal switch for comparison runs only. It is off
/// in every build.
pub(crate) const PROSE_RECAP_ENABLED: bool = false;

/// Prompt-source prefix of a recap quoted from source sentences.
const EXTRACTIVE_RECAP_SOURCE_PREFIX: &str = "extractive_recap_v1:";

/// What a recap instruction asks to emphasise. The default playbook is a
/// writing guide, so it adds nothing to sentence selection; a template or
/// custom recipe says what matters.
pub(crate) fn extractive_recap_focus(instruction: &str) -> Option<&str> {
    (instruction != meeting_template_summary_query(None)).then_some(instruction)
}

async fn run_extractive_recap_for_context(
    state: &AppState,
    context: llm::GroundingContext,
    focus: Option<&str>,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<llm::GroundedTextOutput, MeetingSummaryError> {
    state
        .operation_coordinator
        .run_post_call("meeting analysis", async {
            // Foreground text work: background indexing yields the runtime to it.
            let _foreground = crate::llm::local_model_load::foreground_work();
            let runtime =
                selected_analysis_runtime(state, settings::AiLane::Meetings, model, None).await?;
            let timeouts = analysis_timeouts(runtime.provider());
            let orchestrator = llm::GroundedOrchestrator::new(
                &runtime,
                runtime.model().to_string(),
                context,
                timeouts.request,
                timeouts.job,
                llm::OrchestrationOptions::default(),
            );
            let orchestrator = match progress {
                Some(callback) => orchestrator.with_progress_callback(callback),
                None => orchestrator,
            };
            orchestrator
                .run_extractive_recap(focus)
                .await
                .map_err(MeetingSummaryError::from)
        })
        .await
}

/// Preserve the user-assigned speaker name for each actual transcript segment.
fn segment_speaker_names_for_transcript(
    db: &db::Database,
    transcript: &models::Transcript,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let aliases = db
        .get_speaker_aliases(&transcript.recording_id)
        .map_err(|error| error.to_string())?;
    Ok(transcript
        .segments
        .iter()
        .filter_map(|segment| {
            let speaker = segment.speaker_id.as_ref()?;
            let name = aliases.get(speaker)?.0.as_ref()?.trim();
            (!name.is_empty()).then(|| (segment.id.clone(), name.to_string()))
        })
        .collect())
}

type SegmentSpeakers = HashMap<(String, String), String>;

fn segment_speaker_ids_for_transcript(transcript: &models::Transcript) -> SegmentSpeakers {
    transcript
        .segments
        .iter()
        .filter_map(|segment| {
            segment.speaker_id.as_ref().map(|speaker| {
                (
                    (transcript.recording_id.clone(), segment.id.clone()),
                    speaker.clone(),
                )
            })
        })
        .collect()
}

async fn segment_speaker_context_for_recording(
    state: &AppState,
    recording_id: &str,
) -> Result<(SegmentSpeakers, SegmentSpeakers), String> {
    let db = state.db.lock().await;
    let transcript = db
        .get_transcript(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or("Transcript not found")?;
    let names = segment_speaker_names_for_transcript(&db, &transcript)?
        .into_iter()
        .map(|(segment_id, name)| ((recording_id.to_string(), segment_id), name))
        .collect();
    Ok((names, segment_speaker_ids_for_transcript(&transcript)))
}

pub(crate) async fn run_grounded_action_items_for_segments(
    state: &AppState,
    segments: Vec<AnalysisContextSegment>,
    notes: Option<&str>,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
    // Speaker names and speaker IDs by recording and segment.
    (segment_speakers, segment_speaker_ids): (SegmentSpeakers, SegmentSpeakers),
    written_notes: Option<(&str, &str)>,
) -> Result<llm::GroundedActionItemsOutput, String> {
    state
        .operation_coordinator
        .run_post_call("meeting analysis", async {
            let mut context = llm::GroundingContext::new(segments)?;
            if let Some((recording_id, text)) = written_notes {
                context = context.with_written_notes(recording_id, Some(text))?;
            }
            if !PROSE_RECAP_ENABLED {
                // Read from parsed source commitments; no model is involved.
                // Speaker IDs keep unnamed voices apart, as in the recap.
                return Ok(llm::grounded::extractive_action_items(
                    &context
                        .with_segment_speakers(segment_speakers)
                        .with_segment_speaker_ids(segment_speaker_ids),
                ));
            }
            let _ = segment_speaker_ids;
            let runtime =
                selected_analysis_runtime(state, settings::AiLane::Meetings, model, None).await?;
            let timeouts = analysis_timeouts(runtime.provider());
            let orchestrator = llm::GroundedOrchestrator::new(
                &runtime,
                runtime.model().to_string(),
                context,
                timeouts.request,
                timeouts.job,
                llm::OrchestrationOptions::default(),
            )
            .with_segment_speakers(segment_speakers)
            .with_shared_meeting_facts();
            let orchestrator = match progress {
                Some(callback) => orchestrator.with_progress_callback(callback),
                None => orchestrator,
            };
            orchestrator
                .run_action_items(ACTION_ITEMS_INSTRUCTION, notes)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

pub(crate) fn analysis_result_from_grounded(
    query: &str,
    output: llm::GroundedTextOutput,
) -> llm::AnalysisResult {
    let provenance = models::AnalysisProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        content_hash: models::analysis_content_hash(&output.response),
        actual_provider: output.actual_provider.clone(),
        actual_model: output.model.clone(),
        prompt_source: "analysis_query".to_string(),
        grounding_policy_version: None,
        completed_at: chrono::Utc::now(),
        citations: persisted_analysis_citations(&output.citations),
        grounded: output.grounded,
        unverified_statements: output.unverified_statements.clone(),
        summary_diagnostics: output.summary_diagnostics.clone(),
    };
    llm::AnalysisResult {
        query: query.to_string(),
        response: output.response,
        citations: output.citations,
        actual_provider: output.actual_provider,
        model: output.model,
        processing_time_ms: output.processing_time_ms,
        provenance,
        grounded: output.grounded,
    }
}

pub(crate) async fn run_grounded_response_query_for_recording(
    state: &AppState,
    recording_id: &str,
    query: &str,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<llm::AnalysisResult, String> {
    let (segments, notes, _, mut snapshot) =
        load_recording_analysis_input(state, recording_id).await?;
    let (speakers, speaker_ids) =
        segment_speaker_context_for_recording(state, recording_id).await?;
    snapshot.speaker_names = Some(
        speakers
            .iter()
            .map(|((_, id), name)| (id.clone(), name.clone()))
            .collect(),
    );
    let context = llm::GroundingContext::new(segments)?
        .with_segment_speakers(speakers)
        .with_segment_speaker_ids(speaker_ids)
        .with_written_notes(recording_id, snapshot.meeting_notes.as_deref())?;
    let output = run_grounded_response_for_context(
        state,
        context,
        query,
        notes.as_deref(),
        model,
        llm::CompletionPurpose::Ask,
        progress,
    )
    .await?;
    verify_analysis_snapshot(&*state.db.lock().await, recording_id, &snapshot)?;
    let mut output = output;
    output.grounded &= !output.citations.is_empty()
        && output
            .citations
            .iter()
            .all(|citation| citation.recording_id.as_deref() == Some(recording_id));
    output.grounded &= source_allows_grounded(
        &snapshot,
        false,
        output.citations.iter().map(|c| c.source_kind.as_deref()),
    );
    Ok(analysis_result_from_grounded(query, output))
}

pub(crate) async fn summarize_recording_grounded_internal(
    state: &AppState,
    recording_id: &str,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<GroundedSummaryResult, String> {
    summarize_recording_grounded_typed(state, recording_id, model, progress)
        .await
        .map_err(|error| error.to_string())
}

async fn summarize_recording_grounded_typed(
    state: &AppState,
    recording_id: &str,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<GroundedSummaryResult, MeetingSummaryError> {
    let (segments, notes, template_id, mut snapshot) =
        load_recording_analysis_input(state, recording_id).await?;
    let (speakers, speaker_ids) =
        segment_speaker_context_for_recording(state, recording_id).await?;
    snapshot.speaker_names = Some(
        speakers
            .iter()
            .map(|((_, id), name)| (id.clone(), name.clone()))
            .collect(),
    );
    let context = llm::GroundingContext::new(segments)?
        .with_segment_speakers(speakers)
        .with_segment_speaker_ids(speaker_ids)
        .with_written_notes(recording_id, snapshot.meeting_notes.as_deref())?;
    let custom_prompt = meeting_custom_prompt_from_settings(state).await;
    snapshot.custom_summary_prompt = custom_prompt.clone();
    let prompt_source = if custom_prompt.is_some() {
        "custom_meeting_summary_prompt".to_string()
    } else {
        format!(
            "meeting_playbook:{}",
            template_id.as_deref().unwrap_or("auto")
        )
    };
    let meeting_custom_templates = meeting_custom_templates_from_settings(state).await;
    let instruction = llm::resolve_summary_instruction(
        custom_prompt.as_deref(),
        &resolve_meeting_template_summary_instruction(
            template_id.as_deref(),
            &meeting_custom_templates,
        ),
    );
    let prompt_source = format!(
        "{}{}:input={}",
        if PROSE_RECAP_ENABLED {
            ""
        } else {
            EXTRACTIVE_RECAP_SOURCE_PREFIX
        },
        prompt_source,
        analysis_input_fingerprint(&snapshot, &instruction)
    );
    let output = if PROSE_RECAP_ENABLED {
        run_grounded_response_for_context_typed(
            state,
            context,
            &instruction,
            notes.as_deref(),
            GroundedResponseOptions {
                model,
                purpose: llm::CompletionPurpose::Summary,
                progress,
                meeting_summary_coverage: uses_builtin_meeting_summary_coverage(&instruction),
            },
        )
        .await?
    } else {
        run_extractive_recap_for_context(
            state,
            context,
            extractive_recap_focus(&instruction),
            model,
            progress,
        )
        .await?
    };
    if output.response.trim().is_empty() {
        return Err("Summary analysis returned no content".to_string().into());
    }
    let mut output = output;
    output.grounded &= source_allows_grounded(&snapshot, true, std::iter::empty());
    let provenance = models::AnalysisProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        content_hash: models::analysis_content_hash(&output.response),
        actual_provider: output.actual_provider.clone(),
        actual_model: output.model.clone(),
        prompt_source,
        grounding_policy_version: Some(models::SUMMARY_GROUNDING_POLICY_VERSION),
        completed_at: chrono::Utc::now(),
        citations: persisted_analysis_citations(&output.citations),
        grounded: output.grounded,
        unverified_statements: output.unverified_statements.clone(),
        summary_diagnostics: output.summary_diagnostics.clone(),
    };

    Ok(GroundedSummaryResult {
        summary: output.response,
        citations: output.citations,
        actual_provider: output.actual_provider,
        model: output.model,
        processing_time_ms: output.processing_time_ms,
        grounded: output.grounded,
        provenance,
        snapshot,
    })
}

/// The provenance prompt source of notes quoted from the transcript.
const TRANSCRIPT_FACTS_SOURCE: &str = "transcript_facts_v1";

/// Notes quoted from the transcript, for a meeting whose summary could not
/// be written, saved under the same checks as a written summary.
async fn transcript_facts_summary(
    state: &AppState,
    recording_id: &str,
    error: &MeetingSummaryError,
) -> Result<GroundedSummaryResult, String> {
    let (segments, _, _, mut snapshot) = load_recording_analysis_input(state, recording_id).await?;
    let (speakers, speaker_ids) =
        segment_speaker_context_for_recording(state, recording_id).await?;
    snapshot.speaker_names = Some(
        speakers
            .iter()
            .map(|((_, id), name)| (id.clone(), name.clone()))
            .collect(),
    );
    snapshot.custom_summary_prompt = meeting_custom_prompt_from_settings(state).await;
    let context = llm::GroundingContext::new(segments)?
        .with_segment_speakers(speakers)
        .with_segment_speaker_ids(speaker_ids);
    let (summary, citations) = llm::transcript_facts_notes(&context);
    let grounded = source_allows_grounded(&snapshot, true, std::iter::empty());
    let provenance = models::AnalysisProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        content_hash: models::analysis_content_hash(&summary),
        actual_provider: "plainsong".to_string(),
        actual_model: "transcript quotes".to_string(),
        prompt_source: format!(
            "{TRANSCRIPT_FACTS_SOURCE}:input={}",
            analysis_input_fingerprint(&snapshot, TRANSCRIPT_FACTS_SOURCE)
        ),
        grounding_policy_version: Some(models::SUMMARY_GROUNDING_POLICY_VERSION),
        completed_at: chrono::Utc::now(),
        citations: persisted_analysis_citations(&citations),
        grounded,
        unverified_statements: Vec::new(),
        summary_diagnostics: Some(llm::summary_verification::SummaryDiagnostics {
            fallback_reason: Some("summary_request_failed".into()),
            request_error_kind: match error {
                MeetingSummaryError::Provider(error) => Some(format!("{:?}", error.kind)),
                MeetingSummaryError::Input(_) => None,
            },
            ..Default::default()
        }),
    };
    Ok(GroundedSummaryResult {
        summary,
        citations,
        actual_provider: provenance.actual_provider.clone(),
        model: provenance.actual_model.clone(),
        processing_time_ms: 0,
        grounded,
        provenance,
        snapshot,
    })
}

/// Whether a failed summary pass should leave quoted transcript lines in its
/// place: only where no written summary would be replaced.
fn leaves_transcript_facts(stored_summary: Option<&str>) -> bool {
    stored_summary.is_none_or(|text| text.trim().is_empty() || llm::is_transcript_facts_notes(text))
}

fn uses_builtin_meeting_summary_coverage(instruction: &str) -> bool {
    std::iter::once(None)
        .chain(
            settings::BUILTIN_MEETING_TEMPLATE_IDS
                .iter()
                .copied()
                .map(Some),
        )
        .any(|id| instruction == meeting_template_summary_query(id))
}

pub(crate) fn meeting_template_summary_query(template_id: Option<&str>) -> &'static str {
    match template_id {
        Some("standup") => {
            "Summarize this standup with work completed, work planned next, blockers, and owners where stated."
        }
        Some("1on1") => {
            "Summarize this 1:1 with discussion topics, feedback exchanged, goals, commitments, and unresolved concerns."
        }
        Some("sales") => {
            "Summarize this sales call with prospect context, pain points, objections, buying signals, next steps, and deal status."
        }
        Some("interview") => {
            "Summarize this interview with candidate strengths, weaknesses, notable answers, open concerns, and hiring recommendation."
        }
        Some("brainstorm") => {
            "Summarize this brainstorm with ideas generated, strongest candidates, decisions made, and follow-up experiments or tasks."
        }
        _ => {
            "Write concise meeting notes from the supplied transcript and notes. Summarize material facts once. Include requirements, plans, decisions, commitments, owners, deadlines, and next steps only where stated; omit empty sections. Do not claim that no decisions were made, that agreement was reached, or that the meeting concluded unless the source explicitly says so. Retain stated prices even when no decision or action was agreed. Keep selling prices, tentative converted-price estimates, and exchange rates separate, with their stated currency units and rate direction. Do not calculate conversions or invent missing units. Preserve uncertainty when figures overlap or conflict. Mention introductions and exercises briefly; omit individual exercise answers unless they affect the project. Do not explain an unfamiliar transcript word or guess what it meant. Quote an unclear important term unchanged and mark it unclear, or omit an unimportant fragment. Preserve negation and corrections; a negated comparison is not a positive claim about an entity. Quote ambiguous requirements rather than turning them into specifications. Attach time limits to their actual activities. Attribute statements only when their cited source supports the speaker. Distinguish proposed work from completed work, and do not connect separately discussed activities. Use short topic headings and bullets in plain Markdown. Use ordinary language for amounts and rates; do not introduce equations or LaTeX notation that the source did not use."
        }
    }
}

/// The user's saved meeting templates ("recipes"), sanitized on every load
/// and save (see `settings::sanitize_meeting_custom_templates`), so this is
/// already safe to search by id without re-validating here.
pub(crate) async fn meeting_custom_templates_from_settings(
    state: &AppState,
) -> Vec<settings::MeetingCustomTemplate> {
    state
        .settings_manager
        .lock()
        .await
        .settings()
        .transcription
        .meeting_custom_templates
        .clone()
}

/// Resolve the summary-generation instruction for a meeting's template id,
/// trying a user-saved custom template before falling back to the built-in
/// playbook table in `meeting_template_summary_query`.
///
/// A template id that resolves to neither -- most often a custom template
/// the user has since deleted, but equally a stray or corrupted id -- must
/// never fail the analysis outright; it logs why and falls back to the
/// default playbook exactly as an unrecognized built-in id already does.
pub(crate) fn resolve_meeting_template_summary_instruction(
    template_id: Option<&str>,
    custom_templates: &[settings::MeetingCustomTemplate],
) -> String {
    let Some(id) = template_id else {
        return meeting_template_summary_query(None).to_string();
    };

    // Built-in ids resolve through the fixed playbook table first.
    // `sanitize_meeting_custom_templates` already refuses to save a custom
    // entry carrying a built-in id, so in practice this check never has
    // anything to catch -- but resolving built-in-first here too makes that
    // guard belt-and-braces rather than the only thing standing between a
    // drifted or corrupted custom id and shadowing a built-in in analysis
    // while the picker still shows the built-in's name.
    if settings::BUILTIN_MEETING_TEMPLATE_IDS.contains(&id) {
        return meeting_template_summary_query(Some(id)).to_string();
    }

    if let Some(custom) = custom_templates.iter().find(|template| template.id == id) {
        let prompt = custom.summary_prompt.trim();
        if !prompt.is_empty() {
            return prompt.to_string();
        }
        tracing::warn!(
            template_id = id,
            "custom meeting template has no summary prompt; falling back to the default playbook"
        );
        return meeting_template_summary_query(None).to_string();
    }

    tracing::warn!(
        template_id = id,
        "meeting template id matches neither a built-in nor a saved custom template (likely deleted); falling back to the default playbook"
    );
    meeting_template_summary_query(None).to_string()
}

/// The stored one-line form of a grounded item. `export::action_items` owns
/// the shape so the exports and the workspace read back exactly what was
/// written.
pub(crate) fn format_grounded_action_item_for_storage(item: &GroundedActionItem) -> String {
    export::action_items::format_action_item_for_storage(
        &item.task,
        item.assignee.as_deref(),
        item.deadline.as_deref(),
    )
}

pub(crate) async fn extract_action_items_grounded_internal(
    state: &AppState,
    recording_id: &str,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<GroundedActionItemsResult, String> {
    let (segments, notes, _, mut snapshot) =
        load_recording_analysis_input(state, recording_id).await?;
    let (segment_speakers, segment_speaker_ids) =
        segment_speaker_context_for_recording(state, recording_id).await?;
    snapshot.speaker_names = Some(
        segment_speakers
            .iter()
            .map(|((_, segment_id), name)| (segment_id.clone(), name.clone()))
            .collect(),
    );
    let output = run_grounded_action_items_for_segments(
        state,
        segments,
        notes.as_deref(),
        model,
        progress,
        (segment_speakers, segment_speaker_ids),
        snapshot
            .meeting_notes
            .as_deref()
            .map(|text| (recording_id, text)),
    )
    .await?;
    let items: Vec<GroundedActionItem> = output
        .items
        .into_iter()
        .map(|item| GroundedActionItem {
            task: item.task,
            assignee: item.assignee,
            deadline: item.deadline,
            evidence: item.evidence,
            unclear: item.unclear,
            citations: item.citations,
            grounded: item.grounded && source_allows_grounded(&snapshot, true, std::iter::empty()),
        })
        .collect();
    let persisted_items = items
        .iter()
        .map(format_grounded_action_item_for_storage)
        .collect::<Vec<_>>();
    let item_provenance = items
        .iter()
        .zip(&persisted_items)
        .map(|(item, persisted)| models::ActionItemProvenance {
            content_hash: models::analysis_content_hash(persisted),
            citations: persisted_analysis_citations(&item.citations),
            grounded: item.grounded,
            generated: true,
            evidence: item.evidence.clone(),
            unclear: item.unclear,
        })
        .collect::<Vec<_>>();
    let mut seen_citations = HashSet::new();
    let citations = item_provenance
        .iter()
        .flat_map(|item| item.citations.iter().cloned())
        .filter(|citation| {
            let key = serde_json::to_string(citation).unwrap_or_default();
            seen_citations.insert(key)
        })
        .collect();
    let grounded = output.grounded && source_allows_grounded(&snapshot, true, std::iter::empty());
    let provenance = models::ActionItemsProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        grounding_policy_version: Some(models::SUMMARY_GROUNDING_POLICY_VERSION),
        content_hash: models::action_items_content_hash(&persisted_items),
        actual_provider: output.actual_provider.clone(),
        actual_model: output.model.clone(),
        prompt_source: format!(
            "plainsong_action_items_v1:input={}",
            analysis_input_fingerprint(&snapshot, ACTION_ITEMS_INSTRUCTION)
        ),
        completed_at: chrono::Utc::now(),
        citations,
        grounded,
        items: item_provenance,
    };
    Ok(GroundedActionItemsResult {
        items,
        actual_provider: output.actual_provider,
        model: output.model,
        processing_time_ms: output.processing_time_ms,
        grounded,
        provenance,
        snapshot,
    })
}

pub(crate) fn verify_analysis_snapshot(
    db: &db::Database,
    recording_id: &str,
    snapshot: &RecordingAnalysisSnapshot,
) -> Result<models::Recording, String> {
    let (transcript, revision) = db
        .get_transcript_with_revision(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Transcript not found while saving analysis".to_string())?;
    let recording = db
        .get_recording(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Recording not found while saving analysis".to_string())?;
    if revision != snapshot.transcript_revision
        || recording.transcript_complete != snapshot.transcript_complete
        || recording.transcript_degraded_reason != snapshot.transcript_degraded_reason
        || recording.capture_degraded_summary != snapshot.capture_degraded_summary
        || recording.meeting_notes != snapshot.meeting_notes
        || recording.notes_updated_at != snapshot.notes_updated_at
    {
        return Err(
            "The transcript, source integrity or meeting notes changed while analysis was running; the stale result was not saved."
                .to_string(),
        );
    }
    if models::attendee_names_for_context(&recording.attendees) != snapshot.attendee_names {
        return Err("The meeting attendees changed while analysis was running; the stale result was not saved.".into());
    }
    if let Some(expected_names) = &snapshot.speaker_names {
        if &segment_speaker_names_for_transcript(db, &transcript)? != expected_names {
            return Err("The speaker names changed while analysis was running; the stale result was not saved.".into());
        }
    }
    Ok(recording)
}

pub(crate) async fn persist_grounded_summary(
    state: &AppState,
    recording_id: &str,
    result: &GroundedSummaryResult,
) -> Result<models::Recording, String> {
    let settings_manager = state.settings_manager.lock().await;
    let custom_prompt = normalize_optional_trimmed(
        settings_manager
            .settings()
            .transcription
            .meeting_custom_prompt
            .clone(),
    );
    if custom_prompt != result.snapshot.custom_summary_prompt {
        return Err(
            "The meeting summary prompt changed while analysis was running; the stale result was not saved."
                .to_string(),
        );
    }
    let mut db = state.db.lock().await;
    let recording = verify_analysis_snapshot(&db, recording_id, &result.snapshot)?;
    if recording.meeting_template_id != result.snapshot.meeting_template_id
        || recording.summary != result.snapshot.expected_summary
    {
        return Err(
            "The meeting playbook or summary changed while analysis was running; the stale result was not saved."
                .to_string(),
        );
    }
    let source_fingerprint = result
        .provenance
        .prompt_source
        .rsplit_once(":input=")
        .map(|(_, fingerprint)| fingerprint)
        .ok_or_else(|| "Generated summary provenance has no input fingerprint".to_string())?;
    db.replace_generated_summary_with_undo(
        recording_id,
        result.snapshot.expected_summary.as_deref(),
        result.summary.as_str(),
        &result.provenance,
        source_fingerprint,
    )
    .map_err(|error| error.to_string())
}

pub(crate) async fn undo_summary_regeneration_with_current_input(
    state: &AppState,
    recording_id: &str,
    undo_token: &str,
) -> Result<models::Recording, String> {
    // Hold both inputs through the database transaction. A source edit or a
    // settings save cannot slip between fingerprint validation and restore.
    let settings = state.settings_manager.lock().await;
    let transcription_settings = &settings.settings().transcription;
    let custom_prompt = transcription_settings
        .meeting_custom_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let custom_templates = transcription_settings.meeting_custom_templates.clone();
    let mut db = state.db.lock().await;
    let recording = db
        .get_recording(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Recording not found while undoing summary regeneration".to_string())?;
    let (transcript, transcript_revision) = db
        .get_transcript_with_revision(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Transcript not found while undoing summary regeneration".to_string())?;
    let speaker_names = segment_speaker_names_for_transcript(&db, &transcript)?;
    let template_id = recording.meeting_template_id.clone();
    let attendee_names = models::attendee_names_for_context(&recording.attendees);
    let snapshot = RecordingAnalysisSnapshot {
        transcript_revision,
        transcript_complete: recording.transcript_complete,
        transcript_degraded_reason: recording.transcript_degraded_reason.clone(),
        capture_degraded_summary: recording.capture_degraded_summary.clone(),
        meeting_notes: recording.meeting_notes,
        notes_updated_at: recording.notes_updated_at,
        meeting_template_id: template_id.clone(),
        expected_summary: recording.summary,
        expected_action_items: recording.action_items,
        custom_summary_prompt: custom_prompt.clone(),
        attendee_names,
        speaker_names: Some(speaker_names),
    };
    let instruction = llm::resolve_summary_instruction(
        custom_prompt.as_deref(),
        &resolve_meeting_template_summary_instruction(template_id.as_deref(), &custom_templates),
    );
    let current_fingerprint = analysis_input_fingerprint(&snapshot, &instruction);
    let generated_fingerprint = db
        .summary_regeneration_undo_source_fingerprint(recording_id)
        .map_err(|error| error.to_string())?;
    let verified_fingerprint = (generated_fingerprint.as_deref() == Some(&current_fingerprint))
        .then_some(current_fingerprint.as_str());
    db.undo_summary_regeneration(recording_id, undo_token, verified_fingerprint)
        .map_err(|error| error.to_string())
}

pub(crate) async fn persist_grounded_action_items(
    state: &AppState,
    recording_id: &str,
    result: &GroundedActionItemsResult,
) -> Result<models::Recording, String> {
    let action_items = result
        .items
        .iter()
        .map(format_grounded_action_item_for_storage)
        .collect::<Vec<_>>();
    let mut db = state.db.lock().await;
    let recording = verify_analysis_snapshot(&db, recording_id, &result.snapshot)?;
    if recording.action_items != result.snapshot.expected_action_items {
        return Err(
            "The saved action items changed while analysis was running; the stale result was not saved."
                .to_string(),
        );
    }
    db.patch_recording_analysis_with_provenance(
        recording_id,
        None,
        Some(&action_items),
        None,
        Some(&result.provenance),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn emit_analysis_ready(
    handle: &sidecar_handle::SidecarHandle,
    recording: &models::Recording,
    target: &str,
) {
    handle.emit_event(
        "recording-analysis-ready",
        serde_json::json!({
            "recordingId": &recording.id,
            "target": target,
            "updatedAt": recording.updated_at.to_rfc3339(),
        }),
    );
}

pub(crate) fn build_relationship_memory(
    sources: &[RelationshipMemorySource],
) -> models::RelationshipMemory {
    let mut people: HashMap<String, RelationshipProfileAccumulator> = HashMap::new();
    let mut companies: HashMap<String, RelationshipProfileAccumulator> = HashMap::new();

    for source in sources {
        let mut people_in_recording = collect_people_from_source(source);
        people_in_recording.sort();
        people_in_recording.dedup();

        let mut companies_in_recording = collect_companies_from_source(source);
        companies_in_recording.sort();
        companies_in_recording.dedup();

        for person_name in &people_in_recording {
            let key = normalize_relationship_key(person_name);
            let entry =
                people
                    .entry(key.clone())
                    .or_insert_with(|| RelationshipProfileAccumulator {
                        name: person_name.clone(),
                        ..RelationshipProfileAccumulator::default()
                    });

            entry.recording_ids.insert(source.recording.id.clone());
            upsert_relationship_last_seen(entry, source.recording.created_at);
            for company_name in &companies_in_recording {
                entry.related_entities.insert(company_name.clone());
            }
            push_relationship_evidence(
                &mut entry.recent_meetings,
                models::RelationshipMemoryEvidence {
                    recording_id: source.recording.id.clone(),
                    recording_title: source.recording.title.clone(),
                    created_at: source.recording.created_at,
                    snippet: build_relationship_snippet(source, person_name),
                },
            );
        }

        for company_name in &companies_in_recording {
            let key = normalize_relationship_key(company_name);
            let entry =
                companies
                    .entry(key.clone())
                    .or_insert_with(|| RelationshipProfileAccumulator {
                        name: company_name.clone(),
                        ..RelationshipProfileAccumulator::default()
                    });

            entry.recording_ids.insert(source.recording.id.clone());
            upsert_relationship_last_seen(entry, source.recording.created_at);
            for person_name in &people_in_recording {
                entry.related_entities.insert(person_name.clone());
            }
            push_relationship_evidence(
                &mut entry.recent_meetings,
                models::RelationshipMemoryEvidence {
                    recording_id: source.recording.id.clone(),
                    recording_title: source.recording.title.clone(),
                    created_at: source.recording.created_at,
                    snippet: build_relationship_snippet(source, company_name),
                },
            );
        }
    }

    let mut people_profiles = people
        .into_iter()
        .filter_map(|(id, profile)| {
            profile
                .last_seen_at
                .map(|last_seen_at| models::PersonMemoryProfile {
                    id,
                    name: profile.name,
                    recording_count: profile.recording_ids.len() as u64,
                    last_seen_at,
                    related_companies: sorted_limited_entities(profile.related_entities, 6),
                    recent_meetings: profile.recent_meetings,
                })
        })
        .collect::<Vec<_>>();
    people_profiles.sort_by(|left, right| {
        right
            .recording_count
            .cmp(&left.recording_count)
            .then_with(|| right.last_seen_at.cmp(&left.last_seen_at))
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut company_profiles = companies
        .into_iter()
        .filter_map(|(id, profile)| {
            profile
                .last_seen_at
                .map(|last_seen_at| models::CompanyMemoryProfile {
                    id,
                    name: profile.name,
                    recording_count: profile.recording_ids.len() as u64,
                    last_seen_at,
                    related_people: sorted_limited_entities(profile.related_entities, 6),
                    recent_meetings: profile.recent_meetings,
                })
        })
        .collect::<Vec<_>>();
    company_profiles.sort_by(|left, right| {
        right
            .recording_count
            .cmp(&left.recording_count)
            .then_with(|| right.last_seen_at.cmp(&left.last_seen_at))
            .then_with(|| left.name.cmp(&right.name))
    });

    models::RelationshipMemory {
        people: people_profiles,
        companies: company_profiles,
    }
}

pub(crate) fn collect_people_from_source(source: &RelationshipMemorySource) -> Vec<String> {
    let mut names = source
        .speaker_aliases
        .values()
        .filter_map(|(name, _, _)| name.clone())
        .collect::<Vec<_>>();

    if let Some(transcript) = &source.transcript {
        let inferred = infer_speaker_aliases_from_segments(&transcript.segments);
        for name in inferred.into_values() {
            names.push(name);
        }
    }

    names
        .into_iter()
        .map(|name| clean_memory_entity_name(&name))
        .filter(|name| is_person_memory_candidate(name))
        .collect()
}

pub(crate) fn collect_companies_from_source(source: &RelationshipMemorySource) -> Vec<String> {
    let mut companies = HashSet::new();
    for candidate in extract_company_candidates(&source.recording.title, true) {
        companies.insert(candidate);
    }
    if let Some(summary) = source.recording.summary.as_deref() {
        for candidate in extract_company_candidates(summary, false) {
            companies.insert(candidate);
        }
    }
    if let Some(notes) = source.recording.meeting_notes.as_deref() {
        for candidate in extract_company_candidates(notes, false) {
            companies.insert(candidate);
        }
    }
    if let Some(transcript) = &source.transcript {
        for candidate in extract_company_candidates(&transcript.full_text, false) {
            companies.insert(candidate);
        }
    }

    companies.into_iter().collect()
}

pub(crate) fn build_relationship_snippet(
    source: &RelationshipMemorySource,
    entity_name: &str,
) -> String {
    let search_texts = [
        source.recording.summary.as_deref(),
        source.recording.meeting_notes.as_deref(),
        source
            .transcript
            .as_ref()
            .map(|transcript| transcript.full_text.as_str()),
        Some(source.recording.title.as_str()),
    ];

    for text in search_texts.into_iter().flatten() {
        if let Some(snippet) = find_entity_snippet(text, entity_name) {
            return snippet;
        }
    }

    source.recording.title.clone()
}

pub(crate) fn find_entity_snippet(text: &str, entity_name: &str) -> Option<String> {
    let normalized_text = text.trim();
    if normalized_text.is_empty() {
        return None;
    }

    // Obtain the match offset from the original text. Unicode lowercasing can
    // change a string's byte length, so an offset from a lowercased copy is not
    // necessarily a valid UTF-8 boundary in `normalized_text`.
    let index = regex::RegexBuilder::new(&regex::escape(entity_name))
        .case_insensitive(true)
        .build()
        .ok()
        .and_then(|pattern| pattern.find(normalized_text))
        .map(|matched| matched.start())
        .unwrap_or(0);
    let start = normalized_text[..index]
        .rfind(['.', '\n'])
        .map(|value| value + 1)
        .unwrap_or(0);
    let end = normalized_text[index..]
        .find(['.', '\n'])
        .map(|value| index + value + 1)
        .unwrap_or_else(|| normalized_text.len());

    let snippet = normalized_text[start..end].trim();
    if snippet.is_empty() {
        None
    } else if snippet.chars().count() <= 180 {
        Some(snippet.to_string())
    } else {
        Some(snippet.chars().take(177).collect::<String>() + "...")
    }
}

pub(crate) fn extract_company_candidates(text: &str, allow_title_patterns: bool) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    lazy_static::lazy_static! {
        static ref COMPANY_SUFFIX_RE: Regex = Regex::new(
            r"\b([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,3}\s+(?:AI|Inc|LLC|Ltd|Corp|Co|Company|Technologies|Technology|Systems|Software|Labs|Health|Group|Studio))\b"
        ).expect("company suffix regex");
        static ref TITLE_COMPANY_RE: Regex = Regex::new(
            r"(?i)\b([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,2})\s+(?:sync|review|call|meeting|demo|retro|standup|follow-up|discovery|planning|kickoff|update|notes|brief|interview|debrief|check-in)\b"
        ).expect("title company regex");
        static ref WITH_COMPANY_RE: Regex = Regex::new(
            r"(?i)\bwith\s+([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,2})\b"
        ).expect("with company regex");
        static ref ACRONYM_COMPANY_RE: Regex = Regex::new(r"\b[A-Z][A-Z0-9]{2,7}\b").expect("acronym company regex");
    }

    let mut candidates = Vec::new();
    for captures in COMPANY_SUFFIX_RE.captures_iter(text) {
        if let Some(candidate) = captures.get(1) {
            candidates.push(candidate.as_str().to_string());
        }
    }
    if allow_title_patterns {
        for captures in TITLE_COMPANY_RE.captures_iter(text) {
            if let Some(candidate) = captures.get(1) {
                candidates.push(candidate.as_str().to_string());
            }
        }
        for captures in WITH_COMPANY_RE.captures_iter(text) {
            if let Some(candidate) = captures.get(1) {
                candidates.push(candidate.as_str().to_string());
            }
        }
    }
    for captures in ACRONYM_COMPANY_RE.captures_iter(text) {
        if let Some(candidate) = captures.get(0) {
            candidates.push(candidate.as_str().to_string());
        }
    }

    let mut deduped = HashSet::new();
    candidates
        .into_iter()
        .map(|candidate| clean_memory_entity_name(&candidate))
        .filter(|candidate| is_company_memory_candidate(candidate))
        .filter(|candidate| deduped.insert(normalize_relationship_key(candidate)))
        .collect()
}

pub(crate) fn clean_memory_entity_name(name: &str) -> String {
    name.trim()
        .trim_matches(|character: char| {
            !character.is_alphanumeric() && character != '&' && character != '.' && character != '-'
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn is_person_memory_candidate(name: &str) -> bool {
    if name.is_empty() || is_generic_memory_person_name(name) {
        return false;
    }
    let words = name.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() || words.len() > 4 {
        return false;
    }
    words.iter().all(|word| {
        let trimmed = word.trim_matches(|character: char| !character.is_alphanumeric());
        trimmed.len() >= 2
            && trimmed
                .chars()
                .next()
                .map(|character| character.is_uppercase())
                .unwrap_or(false)
            && trimmed
                .chars()
                .all(|character| character.is_alphabetic() || character == '\'' || character == '-')
    })
}

pub(crate) fn is_company_memory_candidate(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let normalized = normalize_relationship_key(name);
    if normalized.len() < 2 || normalized.len() > 40 {
        return false;
    }
    let banned = [
        "meeting",
        "review",
        "sync",
        "standup",
        "follow up",
        "notes",
        "brief",
        "interview",
        "demo",
        "kickoff",
        "planning",
        "update",
        "check in",
    ];
    if banned.contains(&normalized.as_str()) {
        return false;
    }

    let words = name.split_whitespace().collect::<Vec<_>>();
    if words.len() > 1
        && !words.iter().all(|word| {
            let trimmed = word.trim_matches(|character: char| !character.is_alphanumeric());
            trimmed
                .chars()
                .next()
                .map(|character| character.is_uppercase())
                .unwrap_or(false)
        })
    {
        return false;
    }

    true
}

pub(crate) fn is_generic_memory_person_name(name: &str) -> bool {
    let normalized = normalize_relationship_key(name);
    normalized == "me"
        || normalized == "them"
        || normalized == "speaker"
        || normalized.starts_with("speaker ")
        || normalized.starts_with("participant ")
        || normalized == "unknown"
        || normalized == "unknown speaker"
}

pub(crate) fn normalize_relationship_key(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn upsert_relationship_last_seen(
    profile: &mut RelationshipProfileAccumulator,
    created_at: chrono::DateTime<chrono::Utc>,
) {
    if profile
        .last_seen_at
        .map(|current| created_at > current)
        .unwrap_or(true)
    {
        profile.last_seen_at = Some(created_at);
    }
}

pub(crate) fn push_relationship_evidence(
    evidence: &mut Vec<models::RelationshipMemoryEvidence>,
    next: models::RelationshipMemoryEvidence,
) {
    evidence.push(next);
    evidence.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    evidence.truncate(3);
}

pub(crate) fn sorted_limited_entities(entities: HashSet<String>, limit: usize) -> Vec<String> {
    let mut values = entities.into_iter().collect::<Vec<_>>();
    values.sort();
    values.truncate(limit);
    values
}

#[cfg(test)]
mod analysis_segment_grouping_tests {
    use super::*;

    fn segment(
        id: &str,
        start_time: f64,
        end_time: f64,
        text: &str,
        speaker_id: Option<&str>,
    ) -> models::TranscriptSegment {
        models::TranscriptSegment {
            id: id.to_string(),
            start_time,
            end_time,
            text: text.to_string(),
            speaker_id: speaker_id.map(str::to_string),
            confidence: 0.9,
        }
    }

    #[test]
    fn transcript_speaker_ids_reach_grounding_without_aliases() {
        let transcript = models::Transcript {
            heard_through_speakers: Vec::new(),
            id: "transcript".into(),
            recording_id: "recording".into(),
            segments: vec![
                segment("a", 0.0, 1.0, "We are building a recorder.", Some("s1")),
                segment("b", 2.0, 3.0, "We want it compact,", Some("s1")),
                segment("c", 4.0, 5.0, "not a desktop unit.", Some("s2")),
                segment("d", 6.0, 7.0, "Unidentified.", None),
            ],
            full_text: String::new(),
            language: "en".into(),
            confidence: 0.9,
            model: "test".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: false,
            created_at: chrono::Utc::now(),
        };
        let context = llm::GroundingContext::new(group_transcript_segments_for_analysis(
            &transcript.recording_id,
            &transcript.segments,
        ))
        .unwrap()
        .with_segment_speaker_ids(segment_speaker_ids_for_transcript(&transcript));
        assert!(context
            .lines()
            .iter()
            .all(|line| line.speaker_name.is_none()));
        for line in context.lines() {
            let expected = transcript
                .segments
                .iter()
                .find(|segment| segment.id == line.segment_id)
                .unwrap();
            assert_eq!(line.speaker_id, expected.speaker_id);
        }
        assert!(context
            .lines()
            .iter()
            .any(|line| line.speaker_id.as_deref() == Some("s2")));
        assert!(context.lines().iter().any(|line| line.speaker_id.is_none()));
    }

    #[test]
    fn groups_adjacent_same_speaker_rows_and_keeps_first_identity() {
        let input = vec![
            segment("word-1", 1.0, 1.2, "exact", Some("speaker-1")),
            segment("word-2", 1.3, 1.5, "words", Some("speaker-1")),
            segment("word-3", 1.5, 1.8, "remain", Some("speaker-1")),
        ];
        let original = serde_json::to_value(&input).expect("test input should serialize");

        let grouped = group_transcript_segments_for_analysis("recording-1", &input);

        assert_eq!(
            serde_json::to_value(&input).expect("test input should still serialize"),
            original
        );
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].recording_id, "recording-1");
        assert_eq!(grouped[0].segment_id, "word-1");
        assert_eq!(grouped[0].text, "exact words remain");
        assert_eq!(grouped[0].start_time, 1.0);
        assert_eq!(grouped[0].end_time, 1.8);

        let speaker_map = HashMap::from([(
            ("recording-1".to_string(), "word-1".to_string()),
            "Alice".to_string(),
        )]);
        assert_eq!(
            speaker_map.get(&(
                grouped[0].recording_id.clone(),
                grouped[0].segment_id.clone()
            )),
            Some(&"Alice".to_string())
        );
    }

    #[test]
    fn interleaved_capture_tracks_form_phrases_without_changing_the_transcript() {
        let input = vec![
            segment("me-1", 0.0, 0.2, "Do", Some("me")),
            segment("them-1", 0.0, 0.2, "Priya", Some("them")),
            segment("me-2", 0.2, 0.4, "not", Some("me")),
            segment("them-2", 0.2, 0.4, "will", Some("them")),
            segment("me-3", 0.4, 0.6, "ship", Some("me")),
            segment("them-3", 0.4, 0.6, "review.", Some("them")),
            segment("me-4", 0.6, 0.8, "unless", Some("me")),
            segment("me-5", 0.8, 1.0, "approved.", Some("me")),
        ];
        let original = serde_json::to_value(&input).unwrap();
        let grouped = group_transcript_segments_for_analysis("recording", &input);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].text, "Do not ship unless approved.");
        assert_eq!(grouped[0].segment_id, "me-1");
        assert_eq!(grouped[0].end_time, 1.0);
        assert_eq!(grouped[1].text, "Priya will review.");
        assert_eq!(grouped[1].segment_id, "them-1");
        assert_eq!(serde_json::to_value(&input).unwrap(), original);
    }

    #[test]
    fn interleaved_tracks_still_respect_gaps_and_same_track_overlaps() {
        let input = vec![
            segment("a", 0.0, 1.0, "first", Some("me")),
            segment("b", 0.0, 1.0, "other", Some("them")),
            segment("c", 0.9, 1.2, "overlap", Some("me")),
            segment("d", 2.0, 2.2, "later", Some("them")),
        ];
        assert_eq!(
            group_transcript_segments_for_analysis("recording", &input).len(),
            4
        );
    }

    #[test]
    fn speaker_changes_and_unattributed_rows_form_separate_groups() {
        let input = vec![
            segment("a", 0.0, 1.0, "Alice", Some("speaker-1")),
            segment("b", 1.1, 2.0, "Bob", Some("speaker-2")),
            segment("c", 2.1, 3.0, "unknown", None),
            segment("d", 3.1, 4.0, "continued", None),
            segment("e", 4.1, 5.0, "Alice again", Some("speaker-1")),
        ];

        let grouped = group_transcript_segments_for_analysis("recording-1", &input);

        assert_eq!(grouped.len(), 4);
        assert_eq!(grouped[0].text, "Alice");
        assert_eq!(grouped[1].text, "Bob");
        assert_eq!(grouped[2].text, "unknown continued");
        assert_eq!(grouped[2].segment_id, "c");
        assert_eq!(grouped[3].text, "Alice again");
    }

    #[test]
    fn gap_overlap_duration_and_size_caps_prevent_grouping() {
        let cases = [
            vec![
                segment("first", 0.0, 1.0, "one", Some("speaker")),
                segment("second", 1.6, 2.0, "two", Some("speaker")),
            ],
            vec![
                segment("first", 0.0, 1.0, "one", Some("speaker")),
                segment("second", 0.9, 2.0, "two", Some("speaker")),
            ],
            vec![
                segment("first", 0.0, 1.0, "one", Some("speaker")),
                segment("second", 1.1, 0.5, "two", Some("speaker")),
            ],
            vec![
                segment("first", 0.0, 1.0, "one", Some("speaker")),
                segment("second", 1.5, 30.1, "two", Some("speaker")),
            ],
            vec![
                segment("first", 0.0, 1.0, &"x".repeat(799), Some("speaker")),
                segment("second", 1.5, 2.0, "y", Some("speaker")),
            ],
        ];

        for input in cases {
            let grouped = group_transcript_segments_for_analysis("recording-1", &input);
            assert_eq!(grouped.len(), 2, "input should remain in separate groups");
            assert_eq!(grouped[0].segment_id, "first");
            assert_eq!(grouped[1].segment_id, "second");
        }
    }

    #[test]
    fn exact_gap_duration_and_character_caps_still_group() {
        let input = vec![
            segment("first", 0.0, 1.0, &"é".repeat(798), Some("speaker")),
            segment("second", 1.5, 30.0, "y", Some("speaker")),
        ];

        let grouped = group_transcript_segments_for_analysis("recording-1", &input);

        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].text.chars().count(), 800);
        assert_eq!(grouped[0].end_time, 30.0);
    }
}

#[cfg(test)]
mod meeting_timeout_tests {
    use super::*;
    use llm::transport::{ErrorKind, LlmError};

    #[test]
    fn legacy_summary_template_keeps_default_verification() {
        for id in ["meeting", "deleted-template"] {
            let instruction = resolve_meeting_template_summary_instruction(Some(id), &[]);
            assert_eq!(instruction, meeting_template_summary_query(None));
            assert!(uses_builtin_meeting_summary_coverage(&instruction));
        }
    }

    #[test]
    fn meeting_summary_coverage_follows_the_resolved_instruction() {
        assert!(uses_builtin_meeting_summary_coverage(
            meeting_template_summary_query(None)
        ));
        for id in settings::BUILTIN_MEETING_TEMPLATE_IDS {
            let instruction = resolve_meeting_template_summary_instruction(Some(id), &[]);
            assert!(uses_builtin_meeting_summary_coverage(&instruction));
        }
        let custom = settings::MeetingCustomTemplate {
            id: "custom-design-only".into(),
            summary_prompt: "Design approval only".into(),
            ..Default::default()
        };
        let instruction = resolve_meeting_template_summary_instruction(
            Some(&custom.id),
            std::slice::from_ref(&custom),
        );
        assert!(!uses_builtin_meeting_summary_coverage(&instruction));
        assert!(!uses_builtin_meeting_summary_coverage(
            "Design approval only"
        ));
        let empty = settings::MeetingCustomTemplate {
            summary_prompt: " ".into(),
            ..custom
        };
        let instruction = resolve_meeting_template_summary_instruction(
            Some(&empty.id),
            std::slice::from_ref(&empty),
        );
        assert!(uses_builtin_meeting_summary_coverage(&instruction));
    }

    #[test]
    fn only_the_built_in_models_memory_refusal_is_a_wait() {
        let wait = MeetingSummaryError::from(LlmError::new(
            llm::Provider::NativeText,
            ErrorKind::Policy,
            llm::native_text::MEMORY_REFUSAL,
        ));
        assert!(wait.is_memory_wait());
        let other = MeetingSummaryError::from(LlmError::new(
            llm::Provider::NativeText,
            ErrorKind::Policy,
            "Another local text operation is running",
        ));
        assert!(!other.is_memory_wait());
        assert!(is_memory_wait_message(&format!(
            "native_text: {}",
            llm::native_text::MEMORY_REFUSAL
        )));
    }

    #[test]
    fn notes_that_gave_way_to_speech_wait_for_memory_instead_of_failing() {
        let yielded = MeetingSummaryError::from(LlmError::new(
            llm::Provider::NativeText,
            ErrorKind::Policy,
            llm::native_text::SPEECH_YIELD_REFUSAL,
        ));
        assert!(yielded.is_memory_wait());
        assert!(yielded.is_speech_yield());
        assert!(is_memory_wait_message(&format!(
            "action items: {}",
            llm::native_text::SPEECH_YIELD_REFUSAL
        )));
        let memory = MeetingSummaryError::from(LlmError::new(
            llm::Provider::NativeText,
            ErrorKind::Policy,
            llm::native_text::MEMORY_REFUSAL,
        ));
        assert!(!memory.is_speech_yield());
    }

    #[test]
    fn memory_retries_back_off_to_a_quarter_hour() {
        let mut delay = MEMORY_RETRY_FIRST;
        let mut delays = vec![delay];
        for _ in 0..6 {
            delay = next_memory_retry_delay(delay);
            delays.push(delay);
        }
        let minutes: Vec<_> = delays.iter().map(|delay| delay.as_secs() / 60).collect();
        assert_eq!(minutes, [1, 2, 4, 8, 15, 15, 15]);
    }

    #[tokio::test]
    async fn a_newer_pass_or_a_cancel_ends_an_older_memory_wait() {
        let id = format!("memory-wait-{}", uuid::Uuid::new_v4());
        let first = begin_memory_wait_generation(&id);
        assert!(memory_wait_is_current(&id, first));
        let second = begin_memory_wait_generation(&id);
        assert!(!memory_wait_is_current(&id, first));
        // The superseded loop finishing must not clear the newer wait.
        finish_memory_wait(&id, first);
        assert!(is_waiting_for_memory(&id));
        assert!(cancel_memory_wait(&id).await);
        assert!(!memory_wait_is_current(&id, second));
        assert!(!cancel_memory_wait(&id).await);
    }

    #[tokio::test]
    async fn summary_timeout_does_not_poll_the_action_request() {
        let error = MeetingSummaryError::from(LlmError::new(
            llm::Provider::Ollama,
            ErrorKind::Timeout,
            "request deadline exceeded",
        ));
        let requests = std::sync::atomic::AtomicUsize::new(0);
        let result = run_action_items_unless_summary_timed_out(error.is_timeout(), async {
            requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, String>("new actions")
        })
        .await;
        assert!(result.is_none());
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn non_timeout_failure_still_allows_independent_actions() {
        for kind in [
            ErrorKind::Parse,
            ErrorKind::ContextLimit,
            ErrorKind::EmptyResponse,
        ] {
            let error = MeetingSummaryError::from(LlmError::new(
                llm::Provider::Ollama,
                kind,
                "summary failed",
            ));
            let result = run_action_items_unless_summary_timed_out(error.is_timeout(), async {
                Ok::<_, String>("new actions")
            })
            .await;
            assert_eq!(result, Some(Ok("new actions")));
        }
        assert_eq!(
            run_action_items_unless_summary_timed_out(false, async { "actions" }).await,
            Some("actions")
        );
    }

    #[test]
    fn timeout_words_in_input_errors_do_not_skip_actions() {
        assert!(
            !MeetingSummaryError::from("Ollama Timeout: invalid input".to_string()).is_timeout()
        );
    }
}

#[cfg(test)]
mod meeting_recovery_stage_tests {
    use super::{
        leaves_transcript_facts, llm, meeting_analysis_stages, meeting_title_fallback_allowed,
        MeetingAnalysisMode,
    };

    #[test]
    fn meeting_recovery_can_title_a_meeting_with_a_short_saved_summary() {
        assert!(meeting_title_fallback_allowed(
            MeetingAnalysisMode::MissingOnly,
            Some("OK")
        ));
        assert!(meeting_title_fallback_allowed(
            MeetingAnalysisMode::MissingOnly,
            Some("###")
        ));
        assert!(meeting_title_fallback_allowed(
            MeetingAnalysisMode::MissingOnly,
            None
        ));
        assert!(!meeting_title_fallback_allowed(
            MeetingAnalysisMode::MissingOnly,
            Some("Launch planning")
        ));
        assert!(!meeting_title_fallback_allowed(
            MeetingAnalysisMode::Automatic,
            Some("OK")
        ));
        assert!(meeting_title_fallback_allowed(
            MeetingAnalysisMode::Automatic,
            None
        ));
    }

    #[test]
    fn meeting_recovery_preserves_manual_actions_with_missing_summary() {
        let actions = vec!["Manual action".to_string()];
        assert_eq!(
            meeting_analysis_stages(
                MeetingAnalysisMode::MissingOnly,
                None,
                Some(&actions),
                false
            ),
            (true, false)
        );
    }

    #[test]
    fn meeting_recovery_preserves_summary_with_missing_actions() {
        assert_eq!(
            meeting_analysis_stages(
                MeetingAnalysisMode::MissingOnly,
                Some("Saved summary"),
                None,
                false
            ),
            (false, true)
        );
    }

    #[test]
    fn meeting_recovery_runs_both_missing_stages() {
        assert_eq!(
            meeting_analysis_stages(MeetingAnalysisMode::MissingOnly, Some("  "), None, false),
            (true, true)
        );
    }

    #[test]
    fn retry_replaces_transcript_quotes_but_never_a_written_summary() {
        let quotes = format!(
            "{}\n\n### Decisions\n\n- 1:05 Helen: \"We ship in June.\"",
            llm::grounded::TRANSCRIPT_FACTS_NOTICE
        );
        assert_eq!(
            meeting_analysis_stages(
                MeetingAnalysisMode::MissingOnly,
                Some(&quotes),
                Some(&[]),
                true
            ),
            (true, false),
            "quoted transcript lines stand in for a summary that was never written"
        );
        assert!(meeting_title_fallback_allowed(
            MeetingAnalysisMode::Automatic,
            Some(&quotes)
        ));
        assert!(leaves_transcript_facts(None));
        assert!(leaves_transcript_facts(Some(" ")));
        assert!(leaves_transcript_facts(Some(&quotes)));
        assert!(
            !leaves_transcript_facts(Some("## Launch\n\n- We ship in June.")),
            "a failed pass leaves an earlier written summary in place"
        );
    }

    #[test]
    fn meeting_recovery_preserves_completed_empty_actions() {
        assert_eq!(
            meeting_analysis_stages(MeetingAnalysisMode::MissingOnly, None, Some(&[]), true),
            (true, false)
        );
        assert_eq!(
            meeting_analysis_stages(MeetingAnalysisMode::MissingOnly, None, Some(&[]), false),
            (true, false)
        );
    }

    #[test]
    fn meeting_recovery_automatic_still_replaces_existing_stages() {
        assert_eq!(
            meeting_analysis_stages(
                MeetingAnalysisMode::Automatic,
                Some("Saved summary"),
                Some(&[]),
                true
            ),
            (true, true)
        );
    }
}

#[cfg(test)]
mod source_integrity_tests {
    use super::*;

    #[test]
    fn incomplete_source_requires_review_except_proven_written_notes() {
        let snapshot = RecordingAnalysisSnapshot {
            transcript_revision: 1,
            transcript_complete: false,
            transcript_degraded_reason: Some("ASR chunk missing".into()),
            capture_degraded_summary: None,
            meeting_notes: None,
            notes_updated_at: None,
            meeting_template_id: None,
            expected_summary: None,
            expected_action_items: None,
            custom_summary_prompt: None,
            attendee_names: vec![],
            speaker_names: None,
        };
        assert!(!source_allows_grounded(
            &snapshot,
            true,
            [Some("meeting_note")].into_iter()
        ));
        assert!(source_allows_grounded(
            &snapshot,
            false,
            [Some("meeting_note")].into_iter()
        ));
        for kind in [None, Some("written_note"), Some("transcript")] {
            assert!(!source_allows_grounded(
                &snapshot,
                false,
                [kind].into_iter()
            ));
        }
        assert!(!source_allows_grounded(
            &snapshot,
            false,
            std::iter::empty()
        ));
        let mut capture_only = snapshot.clone();
        capture_only.transcript_complete = true;
        capture_only.transcript_degraded_reason = None;
        capture_only.capture_degraded_summary = Some("Audio was not saved".into());
        assert!(!source_allows_grounded(
            &capture_only,
            true,
            std::iter::empty()
        ));
        let warned_fingerprint = analysis_input_fingerprint(&capture_only, "summary");
        capture_only.capture_degraded_summary = None;
        assert_ne!(
            warned_fingerprint,
            analysis_input_fingerprint(&capture_only, "summary")
        );
        let complete_fingerprint = analysis_input_fingerprint(&capture_only, "summary");
        capture_only.transcript_complete = false;
        assert_ne!(
            complete_fingerprint,
            analysis_input_fingerprint(&capture_only, "summary")
        );
        capture_only.transcript_complete = true;
        assert!(source_allows_grounded(
            &capture_only,
            true,
            std::iter::empty()
        ));
    }
}

#[cfg(test)]
mod memory_wait_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct SetOnDrop(Arc<AtomicBool>);

    impl Drop for SetOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn recording_id() -> String {
        format!("memory-wait-{}", uuid::Uuid::new_v4())
    }

    /// Drive the retry schedule with a fake capture flag and count the passes.
    fn spawn_driver(
        capturing: &Arc<AtomicBool>,
        passes: &Arc<AtomicUsize>,
    ) -> tokio::task::JoinHandle<()> {
        let capturing = Arc::clone(capturing);
        let passes = Arc::clone(passes);
        tokio::spawn(async move {
            drive_memory_retries(
                crate::hardware_tier::HardwareTier::Best,
                move || {
                    let capturing = Arc::clone(&capturing);
                    async move { capturing.load(Ordering::SeqCst) }
                },
                false,
                || true,
                move || {
                    let passes = Arc::clone(&passes);
                    async move {
                        passes.fetch_add(1, Ordering::SeqCst);
                        Some(MeetingAnalysisPassOutcome::Settled)
                    }
                },
            )
            .await;
        })
    }

    #[tokio::test(start_paused = true)]
    async fn light_retries_every_ten_seconds_instead_of_missing_an_away_window() {
        let started = tokio::time::Instant::now();
        let times = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = times.clone();
        drive_memory_retries(
            crate::hardware_tier::HardwareTier::Light,
            || async { false },
            false,
            || true,
            move || {
                let recorded = recorded.clone();
                async move {
                    let mut times = recorded.lock().unwrap();
                    times.push(started.elapsed());
                    Some(if times.len() < 3 {
                        MeetingAnalysisPassOutcome::WaitingForMemory
                    } else {
                        MeetingAnalysisPassOutcome::Settled
                    })
                }
            },
        )
        .await;
        assert_eq!(
            *times.lock().unwrap(),
            [
                Duration::from_secs(10),
                Duration::from_secs(20),
                Duration::from_secs(30)
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_that_starts_during_the_backoff_holds_the_retry() {
        let capturing = Arc::new(AtomicBool::new(false));
        let passes = Arc::new(AtomicUsize::new(0));
        let driver = spawn_driver(&capturing, &passes);

        tokio::time::sleep(MEMORY_RETRY_FIRST / 2).await;
        capturing.store(true, Ordering::SeqCst);
        tokio::time::sleep(MEMORY_RETRY_FIRST * 5).await;
        assert_eq!(
            passes.load(Ordering::SeqCst),
            0,
            "the backoff ended mid-call, and the retry must not race capture for memory"
        );

        capturing.store(false, Ordering::SeqCst);
        tokio::time::sleep(MEMORY_RETRY_POLL * 2).await;
        assert_eq!(passes.load(Ordering::SeqCst), 1);
        driver.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_retry_comes_once_the_call_ends() {
        let capturing = Arc::new(AtomicBool::new(true));
        let passes = Arc::new(AtomicUsize::new(0));
        let driver = spawn_driver(&capturing, &passes);

        tokio::time::sleep(MEMORY_RETRY_POLL * 4).await;
        assert_eq!(passes.load(Ordering::SeqCst), 0);
        capturing.store(false, Ordering::SeqCst);
        tokio::time::sleep(MEMORY_RETRY_POLL * 2).await;
        assert_eq!(
            passes.load(Ordering::SeqCst),
            1,
            "a call already waited out needs no further backoff"
        );
        driver.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn notes_stopped_for_speech_resume_when_it_ends_and_save_once() {
        // The dictation that stopped the notes has already ended.
        let speaking = Arc::new(AtomicBool::new(false));
        let passes = Arc::new(AtomicUsize::new(0));
        let saves = Arc::new(AtomicUsize::new(0));
        let started = tokio::time::Instant::now();
        let driver = tokio::spawn({
            let speaking = Arc::clone(&speaking);
            let passes = Arc::clone(&passes);
            let saves = Arc::clone(&saves);
            async move {
                drive_memory_retries(
                    crate::hardware_tier::HardwareTier::Best,
                    {
                        let speaking = Arc::clone(&speaking);
                        move || {
                            let speaking = Arc::clone(&speaking);
                            async move { speaking.load(Ordering::SeqCst) }
                        }
                    },
                    true,
                    || true,
                    move || {
                        let speaking = Arc::clone(&speaking);
                        let passes = Arc::clone(&passes);
                        let saves = Arc::clone(&saves);
                        async move {
                            // The first retry is stopped again by a second
                            // dictation; the one after it writes the notes.
                            if passes.fetch_add(1, Ordering::SeqCst) == 0 {
                                speaking.store(true, Ordering::SeqCst);
                                return Some(MeetingAnalysisPassOutcome::WaitingForSpeech);
                            }
                            saves.fetch_add(1, Ordering::SeqCst);
                            Some(MeetingAnalysisPassOutcome::Settled)
                        }
                    },
                )
                .await;
            }
        });
        tokio::time::sleep(MEMORY_RETRY_POLL).await;
        assert_eq!(passes.load(Ordering::SeqCst), 1, "retried at once");
        assert_eq!(saves.load(Ordering::SeqCst), 0);
        tokio::time::sleep(MEMORY_RETRY_POLL * 3).await;
        assert_eq!(passes.load(Ordering::SeqCst), 1, "never while speech runs");
        speaking.store(false, Ordering::SeqCst);
        tokio::time::sleep(MEMORY_RETRY_POLL * 2).await;
        driver.await.unwrap();
        assert_eq!(passes.load(Ordering::SeqCst), 2);
        assert_eq!(saves.load(Ordering::SeqCst), 1);
        assert!(
            started.elapsed() < MEMORY_RETRY_FIRST,
            "a pass that gave way to speech skips the memory backoff"
        );
    }

    #[tokio::test]
    async fn cancelling_aborts_the_running_pass_before_it_can_save() {
        let id = recording_id();
        let generation = begin_memory_wait_generation(&id);
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let saved = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let id = id.clone();
            let dropped = Arc::clone(&dropped);
            let saved = Arc::clone(&saved);
            async move {
                run_registered_pass(&id, generation, |cancel| async move {
                    let _released = SetOnDrop(dropped);
                    let _ = started_tx.send(());
                    // Stands in for a model request that is still generating.
                    std::future::pending::<()>().await;
                    if !cancel.is_cancelled() {
                        saved.store(true, Ordering::SeqCst);
                    }
                })
                .await
            }
        });
        started.await.unwrap();

        assert!(cancel_memory_wait(&id).await);
        assert!(
            dropped.load(Ordering::SeqCst),
            "the cancel reply waits until the pass has let go of its lease and request"
        );
        assert_eq!(task.await.unwrap(), None);
        assert!(!saved.load(Ordering::SeqCst));
        assert!(!is_waiting_for_memory(&id));
    }

    #[tokio::test]
    async fn a_pass_cancelled_before_it_starts_never_runs() {
        let id = recording_id();
        let generation = begin_memory_wait_generation(&id);
        assert!(cancel_memory_wait(&id).await);
        let ran = AtomicBool::new(false);
        let outcome = run_registered_pass(&id, generation, |_cancel| async {
            ran.store(true, Ordering::SeqCst);
        })
        .await;
        assert_eq!(outcome, None);
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_newer_pass_aborts_the_older_running_pass() {
        let id = recording_id();
        let first = begin_memory_wait_generation(&id);
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let older = tokio::spawn({
            let id = id.clone();
            let dropped = Arc::clone(&dropped);
            async move {
                run_registered_pass(&id, first, |_cancel| async move {
                    let _released = SetOnDrop(dropped);
                    let _ = started_tx.send(());
                    std::future::pending::<()>().await;
                })
                .await
            }
        });
        started.await.unwrap();

        let second = begin_memory_wait_generation(&id);
        assert_eq!(older.await.unwrap(), None);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(memory_wait_is_current(&id, second));
        assert_eq!(
            run_registered_pass(&id, second, |_cancel| async { 7 }).await,
            Some(7)
        );
        assert!(cancel_memory_wait(&id).await);
    }

    #[test]
    fn a_cancelled_pass_reports_no_more_progress() {
        let cancel = PassCancel::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let progress = cancellable_progress(&cancel, {
            let calls = Arc::clone(&calls);
            Arc::new(move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
            })
        });
        let update = || llm::grounded::OrchestrationProgress {
            strategy: llm::OrchestrationStrategy::Direct,
            stage: llm::OrchestrationStage::Mapping,
            completed: 0,
            total: 1,
            pass: 1,
        };
        progress(update());
        cancel.cancel();
        progress(update());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
