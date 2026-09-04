//! Meeting analysis: the LLM passes and what is built from them.
//!
//! Loading a recording's segments, running the grounded summary and
//! action-item passes against the selected provider, persisting and announcing
//! the outcome, the meeting brief, and the relationship memory assembled from
//! past meetings. The provider timeouts and the analysis phase vocabulary live
//! here too, because they are only meaningful to these passes.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) const ANALYSIS_LOCAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const ANALYSIS_REMOTE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3 * 60);
pub(crate) const ANALYSIS_LOCAL_JOB_TIMEOUT: Duration = Duration::from_secs(45 * 60);
pub(crate) const ANALYSIS_REMOTE_JOB_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) const ACTION_ITEMS_INSTRUCTION: &str = "Extract every concrete action item from the meeting. Include the specific task or deliverable, the responsible person when stated, and any stated deadline or timeframe. Do not invent owners or dates.";

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
    let segments = transcript
        .segments
        .into_iter()
        .map(|segment| AnalysisContextSegment {
            recording_id: recording_id.to_string(),
            segment_id: segment.id,
            text: segment.text,
            start_time: segment.start_time,
            end_time: segment.end_time,
        })
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return Err("Transcript contains no segments for grounded analysis".to_string());
    }
    let meeting_notes = recording.meeting_notes.clone();
    let meeting_template_id = recording.meeting_template_id.clone();
    let attendee_names = models::attendee_names_for_context(&recording.attendees);
    let composed_notes = compose_analysis_notes(meeting_notes.as_deref(), &attendee_names);
    let snapshot = RecordingAnalysisSnapshot {
        transcript_revision,
        meeting_notes,
        notes_updated_at: recording.notes_updated_at,
        meeting_template_id: meeting_template_id.clone(),
        expected_summary: recording.summary,
        expected_action_items: recording.action_items,
        custom_summary_prompt: None,
        attendee_names,
    };
    Ok((segments, composed_notes, meeting_template_id, snapshot))
}

pub(crate) fn persisted_analysis_citations(
    citations: &[llm::Citation],
) -> Vec<models::AnalysisCitation> {
    citations
        .iter()
        .map(|citation| models::AnalysisCitation {
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
    Failed,
    Completed,
}

impl MeetingAnalysisPhase {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Completed => "completed",
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

/// Run the meeting analysis pass: summary, action items, and title.
///
/// Shared by the automatic post-meeting lane and `retry_meeting_analysis` so a
/// retry is exactly the pass that failed, not a second implementation of it.
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
) {
    emit_meeting_analysis_status(handle, recording_id, MeetingAnalysisPhase::Running, None);

    // Summary and action items are independent safe patches. A failed pass
    // leaves any prior successful content and provenance untouched.
    let mut failure_reasons: Vec<String> = Vec::new();
    let mut summary_text: Option<String> = None;

    match summarize_recording_grounded_internal(
        state,
        recording_id,
        None,
        Some(analysis_progress_callback(
            handle,
            recording_id,
            "summary",
            None,
        )),
    )
    .await
    {
        Ok(result) => match persist_grounded_summary(state, recording_id, &result).await {
            Ok(recording) => {
                emit_analysis_ready(handle, &recording, "summary");
                summary_text = Some(result.summary.clone());
            }
            Err(error) => {
                emit_analysis_failure(handle, recording_id, "summary", None, &error);
                failure_reasons.push(format!("summary: {}", error));
            }
        },
        Err(error) => {
            emit_analysis_failure(handle, recording_id, "summary", None, &error);
            failure_reasons.push(format!("summary: {}", error));
        }
    }

    match extract_action_items_grounded_internal(
        state,
        recording_id,
        None,
        Some(analysis_progress_callback(
            handle,
            recording_id,
            "actionItems",
            None,
        )),
    )
    .await
    {
        Ok(result) => match persist_grounded_action_items(state, recording_id, &result).await {
            Ok(recording) => emit_analysis_ready(handle, &recording, "actionItems"),
            Err(error) => {
                emit_analysis_failure(handle, recording_id, "actionItems", None, &error);
                failure_reasons.push(format!("action items: {}", error));
            }
        },
        Err(error) => {
            emit_analysis_failure(handle, recording_id, "actionItems", None, &error);
            failure_reasons.push(format!("action items: {}", error));
        }
    }

    // Unconditional: a meeting whose summary failed still deserves a real name.
    // With a summary it titles from that; without one it falls back to the
    // transcript, which is exactly the path a failed analysis needs.
    if let Err(error) = auto_name_meeting_recording(
        state,
        handle,
        recording_id,
        summary_text.as_deref(),
        summary_text.is_none(),
    )
    .await
    {
        tracing::warn!("Meeting auto-name failed for '{}': {}", recording_id, error);
        failure_reasons.push(format!("title: {}", error));
    }

    if failure_reasons.is_empty() {
        record_meeting_analysis_outcome(state, handle, recording_id, None).await;
    } else {
        let reason = failure_reasons.join("; ");
        tracing::warn!(
            recording_id = %recording_id,
            failure_count = failure_reasons.len(),
            "Automatic analysis finished with failures"
        );
        record_meeting_analysis_outcome(state, handle, recording_id, Some(&reason)).await;
    }
}

/// How far back the brief looks for related meetings.
///
/// The scan loads recordings newest-first and stops here, so the cost of
/// "Prepare" does not grow with a lifetime meeting library. Six sources come
/// out of it at most; a related meeting older than this is unlikely to have
/// an item that is still open.
///
/// Applied by SQL (`Database::get_recent_recordings`), not by a `.take()` on
/// a fully loaded library -- otherwise the cap bounds the ranking work and
/// nothing else, and every row is still read and deserialized.
pub(crate) const MEETING_BRIEF_SCAN_LIMIT: usize = 200;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeetingBriefResult {
    event_id: String,
    /// "ready" — a written brief with citations.
    /// "sources_only" — related meetings found, but no brief could be
    ///   written; `unavailableReason` says why, and the renderer shows the
    ///   raw list. This is the state a Mac with no AI route lands in.
    /// "no_sources" — nothing on this Mac relates to this event.
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

    // Phase 1: rank on what a recording row already carries. Decisions live
    // on the meeting artifact, which is a second query per meeting, so they
    // are loaded only for the handful that survive the relation test.
    let mut related = {
        let db = state.db.lock().await;
        let recordings = db
            .get_recent_recordings(MEETING_BRIEF_SCAN_LIMIT)
            .map_err(|e| e.to_string())?;
        let candidates: Vec<meeting_brief::BriefCandidate> = recordings
            .into_iter()
            .map(|recording| meeting_brief::BriefCandidate {
                recording_id: recording.id,
                title: recording.title,
                created_at: recording.created_at,
                summary: recording.summary,
                action_items: recording.action_items.unwrap_or_default(),
                decisions: Vec::new(),
                attendees: recording.attendees,
            })
            .collect();
        let mut related = meeting_brief::related_meetings(&target, &candidates);
        for meeting in &mut related {
            if let Ok(Some(artifact)) = db.get_meeting_artifact(&meeting.recording_id) {
                meeting.decisions = meeting_brief::clip_brief_items(&artifact.decisions);
            }
        }
        related
    };
    // Decisions arrived after the ranking, so the clip is the only thing left
    // to do; the order is already settled and must not shift under the reader
    // between a Prepare and a Refresh.
    related.truncate(meeting_brief::MAX_BRIEF_SOURCES);

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
            grounded: output.grounded,
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

pub(crate) async fn run_grounded_response_for_segments(
    state: &AppState,
    segments: Vec<AnalysisContextSegment>,
    instruction: &str,
    notes: Option<&str>,
    model: Option<&str>,
    purpose: llm::CompletionPurpose,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<llm::GroundedTextOutput, String> {
    let context = llm::GroundingContext::new(segments)?;
    let runtime = selected_analysis_runtime(state, settings::AiLane::Meetings, model, None).await?;
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
        .run_response(purpose, instruction, notes)
        .await
        .map_err(|error| error.to_string())
}

/// Speaker aliases a person set for this recording, as plain names. An action
/// item may be owned by one of them even when the transcript never spells the
/// name out, because the alias is the person's own labelling of that voice.
pub(crate) async fn speaker_names_for_recording(
    state: &AppState,
    recording_id: &str,
) -> Vec<String> {
    let db = state.db.lock().await;
    db.get_speaker_aliases(recording_id)
        .unwrap_or_default()
        .into_values()
        .filter_map(|(name, _, _)| {
            let name = name?.trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

pub(crate) async fn run_grounded_action_items_for_segments(
    state: &AppState,
    segments: Vec<AnalysisContextSegment>,
    notes: Option<&str>,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
    speaker_names: Vec<String>,
) -> Result<llm::GroundedActionItemsOutput, String> {
    let context = llm::GroundingContext::new(segments)?;
    let runtime = selected_analysis_runtime(state, settings::AiLane::Meetings, model, None).await?;
    let timeouts = analysis_timeouts(runtime.provider());
    let orchestrator = llm::GroundedOrchestrator::new(
        &runtime,
        runtime.model().to_string(),
        context,
        timeouts.request,
        timeouts.job,
        llm::OrchestrationOptions::default(),
    )
    .with_speaker_names(speaker_names);
    let orchestrator = match progress {
        Some(callback) => orchestrator.with_progress_callback(callback),
        None => orchestrator,
    };
    orchestrator
        .run_action_items(ACTION_ITEMS_INSTRUCTION, notes)
        .await
        .map_err(|error| error.to_string())
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
        completed_at: chrono::Utc::now(),
        citations: persisted_analysis_citations(&output.citations),
        grounded: output.grounded,
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
    let (segments, notes, _, _) = load_recording_analysis_input(state, recording_id).await?;
    let output = run_grounded_response_for_segments(
        state,
        segments,
        query,
        notes.as_deref(),
        model,
        llm::CompletionPurpose::Ask,
        progress,
    )
    .await?;
    Ok(analysis_result_from_grounded(query, output))
}

pub(crate) async fn summarize_recording_grounded_internal(
    state: &AppState,
    recording_id: &str,
    model: Option<&str>,
    progress: Option<llm::OrchestrationProgressCallback>,
) -> Result<GroundedSummaryResult, String> {
    let (segments, notes, template_id, mut snapshot) =
        load_recording_analysis_input(state, recording_id).await?;
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
        "{}:input={}",
        prompt_source,
        analysis_input_fingerprint(&snapshot, &instruction)
    );
    let output = run_grounded_response_for_segments(
        state,
        segments,
        &instruction,
        notes.as_deref(),
        model,
        llm::CompletionPurpose::Summary,
        progress,
    )
    .await?;
    if output.response.trim().is_empty() {
        return Err("Summary analysis returned no content".to_string());
    }
    let provenance = models::AnalysisProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        content_hash: models::analysis_content_hash(&output.response),
        actual_provider: output.actual_provider.clone(),
        actual_model: output.model.clone(),
        prompt_source,
        completed_at: chrono::Utc::now(),
        citations: persisted_analysis_citations(&output.citations),
        grounded: output.grounded,
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
            "Provide a concise but complete meeting summary with key discussion points, decisions, and concrete outcomes."
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
    let (segments, notes, _, snapshot) = load_recording_analysis_input(state, recording_id).await?;
    let speaker_names = speaker_names_for_recording(state, recording_id).await;
    let output = run_grounded_action_items_for_segments(
        state,
        segments,
        notes.as_deref(),
        model,
        progress,
        speaker_names,
    )
    .await?;
    let items: Vec<GroundedActionItem> = output
        .items
        .into_iter()
        .map(|item| GroundedActionItem {
            task: item.task,
            assignee: item.assignee,
            deadline: item.deadline,
            citations: item.citations,
            grounded: item.grounded,
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
    let provenance = models::ActionItemsProvenance {
        version: models::ANALYSIS_PROVENANCE_VERSION,
        content_hash: models::action_items_content_hash(&persisted_items),
        actual_provider: output.actual_provider.clone(),
        actual_model: output.model.clone(),
        prompt_source: format!(
            "plainsong_action_items_v1:input={}",
            analysis_input_fingerprint(&snapshot, ACTION_ITEMS_INSTRUCTION)
        ),
        completed_at: chrono::Utc::now(),
        citations,
        grounded: output.grounded,
        items: item_provenance,
    };
    Ok(GroundedActionItemsResult {
        items,
        actual_provider: output.actual_provider,
        model: output.model,
        processing_time_ms: output.processing_time_ms,
        grounded: output.grounded,
        provenance,
        snapshot,
    })
}

pub(crate) fn verify_analysis_snapshot(
    db: &db::Database,
    recording_id: &str,
    snapshot: &RecordingAnalysisSnapshot,
) -> Result<models::Recording, String> {
    let (_, revision) = db
        .get_transcript_with_revision(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Transcript not found while saving analysis".to_string())?;
    let recording = db
        .get_recording(recording_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Recording not found while saving analysis".to_string())?;
    if revision != snapshot.transcript_revision
        || recording.meeting_notes != snapshot.meeting_notes
        || recording.notes_updated_at != snapshot.notes_updated_at
    {
        return Err(
            "The transcript or meeting notes changed while analysis was running; the stale result was not saved."
                .to_string(),
        );
    }
    Ok(recording)
}

pub(crate) async fn persist_grounded_summary(
    state: &AppState,
    recording_id: &str,
    result: &GroundedSummaryResult,
) -> Result<models::Recording, String> {
    if meeting_custom_prompt_from_settings(state).await != result.snapshot.custom_summary_prompt {
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
    db.patch_recording_analysis_with_provenance(
        recording_id,
        Some(Some(result.summary.as_str())),
        None,
        Some(&result.provenance),
        None,
    )
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
