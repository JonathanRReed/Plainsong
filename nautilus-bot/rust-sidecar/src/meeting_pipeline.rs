//! What runs after a meeting stops.
//!
//! The post-stop pipeline: transcribe, diarize, apply the learned dictionary,
//! persist, then analyse and name. It is spawned from the stop path rather than
//! awaited, so this is also where a failure has to be persisted rather than
//! only announced -- except during shutdown, when there is nothing left to tell.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

/// Shown when the automatic speaker pass finished after the reader had
/// already edited the transcript: their edit is kept, so the labels are not.
pub(crate) const DIARIZATION_SKIPPED_FOR_EDIT_NOTICE: &str = "Speakers were not labelled because the transcript was edited while they were being identified. Your edit is saved; choose Label the speakers to label them now.";

pub(crate) const MEETING_TRANSCRIPTION_PENDING_NOTICE: &str =
    "Transcription is pending. The recording is saved. Free some memory, then retry transcription.";

pub(crate) fn persist_pending_meeting_transcription(
    db: &mut db::Database,
    recording_id: &str,
) -> Result<()> {
    db.complete_recording_with_transcript_state(
        recording_id,
        "pending",
        false,
        Some(MEETING_TRANSCRIPTION_PENDING_NOTICE),
    )
}

async fn defer_meeting_transcription(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
) {
    let result = {
        let mut db = state.db.lock().await;
        persist_pending_meeting_transcription(&mut db, recording_id)
    };
    let (status, phase, message) = match result {
        Ok(()) => (
            "pending",
            "recoverable",
            MEETING_TRANSCRIPTION_PENDING_NOTICE.to_string(),
        ),
        Err(error) => {
            tracing::error!("Could not save pending transcription for {recording_id}: {error:#}");
            (
                "error",
                "error",
                "Could not save transcription status. Open Meetings to retry from saved audio."
                    .to_string(),
            )
        }
    };
    emit_recording_status(handle, recording_id, status, Some(&message), None);
    // A retry can finish after a newer capture opened its own overlay.
    let updated_overlay = state
        .recording_overlay_state
        .lock()
        .ok()
        .is_some_and(|mut overlay| {
            if overlay.recording_id.as_deref() != Some(recording_id) {
                return false;
            }
            overlay.phase = phase.to_string();
            overlay.dismissed = false;
            overlay.message = Some(message.clone());
            true
        });
    if updated_overlay {
        handle.emit_event(
            "meeting-recording-state-changed",
            serde_json::json!({
                "phase": phase, "recordingId": recording_id, "message": message,
            }),
        );
    }
}

pub(crate) fn emit_completed_after_persistence(
    persistence_result: Result<(), String>,
    app: &impl crate::sidecar_handle::AppEmitter,
    payload: serde_json::Value,
) -> Result<(), String> {
    persistence_result?;
    app.emit_event("recording-status-changed", payload);
    Ok(())
}

fn meeting_completion_degraded_reason(
    capture_summary: Result<Option<String>, String>,
    asr_reason: Option<&str>,
) -> Option<String> {
    let capture_reason = match capture_summary {
        Ok(summary) => summary,
        Err(_) => Some("The recording's saved audio could not be checked for missing parts. This transcript may be incomplete.".to_string()),
    };
    let reasons: Vec<&str> = [capture_reason.as_deref(), asr_reason]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .collect();
    (!reasons.is_empty()).then(|| reasons.join(" "))
}

/// Full post-capture meeting transcription pipeline: chunked ASR (source-aware
/// when the per-source WAVs exist), diarization, persistence, storage policy,
/// auto-naming, auto-analysis, and retention. The chunked transcription itself
/// emits progressive transcript events, so starting a second preview decoder
/// here would duplicate local model work and delay the durable transcript.
/// Shared by the stop-recording flow and the `retranscribe_recording`
/// command.
pub(crate) async fn run_meeting_transcription_pipeline(
    state_clone: Arc<AppState>,
    handle_clone: crate::sidecar_handle::SidecarHandle,
    recording_id_clone: String,
    _audio_postprocessing_guard: MeetingAudioPostprocessingGuard,
) {
    let cleanup_state = Arc::clone(&state_clone);
    let cleanup_handle = handle_clone.clone();
    let cleanup_id = recording_id_clone.clone();
    let coordinator = Arc::clone(&state_clone.operation_coordinator);
    coordinator
        .run_post_call("meeting transcription and speaker labelling", async move {
            run_meeting_transcription_pipeline_inner(
                state_clone,
                handle_clone,
                recording_id_clone,
                _audio_postprocessing_guard,
            )
            .await;
        })
        .await;
    // The audio and processing owners have dropped before their cleanup runs.
    if let Err(error) = apply_meeting_transcript_only_storage_policy(
        cleanup_state.as_ref(),
        Some(&cleanup_handle),
        "meeting-post-processing-finished",
        Some(&cleanup_id),
    )
    .await
    {
        tracing::debug!("Meeting audio cleanup deferred: {error}");
    }
}

async fn run_meeting_transcription_pipeline_inner(
    state_clone: Arc<AppState>,
    handle_clone: crate::sidecar_handle::SidecarHandle,
    recording_id_clone: String,
    _audio_postprocessing_guard: MeetingAudioPostprocessingGuard,
) {
    if let Err(error) = state_clone
        .db
        .lock()
        .await
        .set_meeting_audio_finalized(&recording_id_clone, false)
    {
        tracing::error!("Could not protect full-rate meeting audio: {error}");
        return;
    }
    let resolved_audio =
        match resolve_recording_audio_bundle_for_runtime(state_clone.as_ref(), &recording_id_clone)
            .await
        {
            Ok(bundle) => bundle,
            Err(error) => {
                tracing::error!(
                    "Failed to resolve recording audio bundle for {}: {}",
                    recording_id_clone,
                    error
                );
                let mut db = state_clone.db.lock().await;
                if let Err(status_error) = db.update_recording_status(&recording_id_clone, "error")
                {
                    tracing::error!(
                        "Failed to persist audio-resolution error status for {}: {}",
                        recording_id_clone,
                        status_error
                    );
                }
                drop(db);
                handle_clone.emit_event(
                    "recording-status-changed",
                    serde_json::json!({
                        "recordingId": &recording_id_clone,
                        "status": "error",
                        "message": &error,
                        "updatedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                emit_meeting_lifecycle_phase(
                    state_clone.as_ref(),
                    &handle_clone,
                    "error",
                    &recording_id_clone,
                    Some(&error),
                );
                return;
            }
        };
    let path = resolved_audio.primary.clone();

    let meeting_selection = {
        let settings = state_clone.settings_manager.lock().await.settings().clone();
        resolve_ready_meeting_selection(
            state_clone.as_ref(),
            &settings.transcription,
            settings.privacy.remote_processing_enabled,
        )
        .await
    };
    let (meeting_provider, meeting_model_id, meeting_route_warning) = match meeting_selection {
        Ok(selection) => selection,
        Err(error) => {
            tracing::error!(
                "Failed to resolve ready meeting route for {}: {}",
                recording_id_clone,
                error
            );
            {
                let mut db = state_clone.db.lock().await;
                if let Err(status_error) = db.update_recording_status(&recording_id_clone, "error")
                {
                    tracing::error!(
                        "Failed to persist route-resolution error status for {}: {}",
                        recording_id_clone,
                        status_error
                    );
                }
                if let Err(audit_error) = db.log_audit_event(
                    "transcription_failed",
                    Some(serde_json::json!({"recording_id": &recording_id_clone, "error": &error})),
                    "error",
                ) {
                    tracing::warn!(
                        "Failed to log route-resolution error for {}: {}",
                        recording_id_clone,
                        audit_error
                    );
                }
            }
            handle_clone.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id_clone, "status": "error",
                    "message": &error, "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state_clone.as_ref(),
                &handle_clone,
                "error",
                &recording_id_clone,
                Some(&error),
            );
            return;
        }
    };
    if let Some(warning) = meeting_route_warning {
        tracing::warn!("{}", warning);
    }

    // Both switches, read together: "keep the speakers a cloud provider sends
    // back" only means anything while speaker separation is on at all, and the
    // whole-file request exists solely to make those labels usable.
    let (enable_diarization, prefer_provider_diarization) = {
        let sm = state_clone.settings_manager.lock().await;
        let settings = sm.settings();
        (
            settings.transcription.enable_diarization,
            settings.meetings.prefer_provider_diarization,
        )
    };

    let spans_result = { state_clone.db.lock().await.aside_spans(&recording_id_clone) };
    let aside_spans = match spans_result {
        Ok(spans) => spans,
        Err(error) => {
            tracing::error!("Could not read aside masks for {recording_id_clone}: {error}");
            defer_meeting_transcription(state_clone.as_ref(), &handle_clone, &recording_id_clone)
                .await;
            return;
        }
    };

    // One wait budget for the whole recording: both capture tracks and the
    // speaker separation after them draw on it.
    let wait_budget = MeetingWaitBudget::sharing_runtime_with(Arc::clone(&state_clone));
    match transcribe_meeting_recording(
        &handle_clone,
        Arc::clone(&state_clone.asr_manager),
        &recording_id_clone,
        &path,
        resolved_audio.mic.as_deref(),
        resolved_audio.system.as_deref(),
        meeting_provider,
        meeting_model_id.clone(),
        enable_diarization,
        prefer_provider_diarization,
        &wait_budget,
        &aside_spans,
    )
    .await
    {
        Ok(output) => {
            let capture_summary = {
                let db = state_clone.db.lock().await;
                db.get_capture_degraded_summary(&recording_id_clone)
                    .map_err(|error| {
                        tracing::warn!(
                            "Could not read capture completeness for meeting {}: {}",
                            recording_id_clone,
                            error
                        );
                        error.to_string()
                    })
            };
            let mut degraded_reason = meeting_completion_degraded_reason(
                capture_summary,
                output.fallback_reason.as_deref(),
            );
            let mut transcript_complete = degraded_reason.is_none();
            let provider_speaker_turns = output.speaker_turns;
            let transcribed_by_provider = output.actual_provider;
            let mut transcript = output.transcript;
            // Load the learned dictionary before enrichment: the correction has
            // to be in the transcript that gets persisted, because summary,
            // action items, and the auto-title are all derived from it
            // afterwards. A dictionary read failure is not worth failing a
            // finished meeting over -- the transcript is still correct, just not
            // term-corrected -- so it degrades to no substitutions.
            let meeting_dictionary_entries = {
                let db = state_clone.db.lock().await;
                match db.list_dictation_dictionary_entries() {
                    Ok(entries) => entries,
                    Err(error) => {
                        tracing::warn!(
                            "Could not read the dictation dictionary for meeting {}; \
                             continuing without term corrections: {}",
                            recording_id_clone,
                            error
                        );
                        Vec::new()
                    }
                }
            };
            enrich_meeting_transcript(&mut transcript, &meeting_dictionary_entries);

            let persistence_result = {
                let mut db = state_clone.db.lock().await;
                match db
                    .set_aside_rows(&recording_id_clone, &output.asides)
                    .and_then(|_| db.save_meeting_transcript(&transcript))
                {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        if let Err(status_error) =
                            db.update_recording_status(&recording_id_clone, "error")
                        {
                            tracing::error!(
                                "Failed to mark meeting {} errored after transcript persistence failed: {}",
                                recording_id_clone,
                                status_error
                            );
                        }
                        if let Err(audit_error) = db.log_audit_event(
                            "transcription_persistence_failed",
                            Some(serde_json::json!({
                                "recording_id": &recording_id_clone,
                                "error": error.to_string(),
                            })),
                            "error",
                        ) {
                            tracing::warn!(
                                "Failed to log transcript persistence failure for {}: {}",
                                recording_id_clone,
                                audit_error
                            );
                        }
                        Err(error.to_string())
                    }
                }
            };

            let transcript_persisted = persistence_result.is_ok();
            if transcript_persisted && wait_budget.memory_deferred() {
                defer_meeting_transcription(
                    state_clone.as_ref(),
                    &handle_clone,
                    &recording_id_clone,
                )
                .await;
                return;
            }

            let completion_result = match persistence_result {
                Ok(()) => {
                    // Status and completeness are written together on purpose.
                    // Any window where this reads as a plain "completed" is a
                    // window in which the transcript-only storage sweep can
                    // delete the audio of a meeting the code already knows was
                    // only partially transcribed.
                    let mut db = state_clone.db.lock().await;
                    match db.complete_recording_with_transcript_state(
                        &recording_id_clone,
                        "completed",
                        degraded_reason.is_none(),
                        degraded_reason.as_deref(),
                    ) {
                        Ok(()) => match db.get_recording(&recording_id_clone) {
                            Ok(Some(recording)) => {
                                transcript_complete = recording.transcript_complete;
                                degraded_reason = recording.transcript_degraded_reason;
                                Ok(())
                            }
                            Ok(None) => Err("Completed recording was not found".to_string()),
                            Err(error) => Err(error.to_string()),
                        },
                        Err(error) => {
                            let _ = db.update_recording_status(&recording_id_clone, "error");
                            Err(error.to_string())
                        }
                    }
                }
                Err(error) => Err(error),
            };
            if transcript_persisted {
                crate::semantic_index::request_index();
            }
            let completed_at = chrono::Utc::now().to_rfc3339();
            let completion_result = emit_completed_after_persistence(
                completion_result,
                &handle_clone,
                serde_json::json!({
                    "recordingId": &recording_id_clone,
                    "status": "completed",
                    "progress": 1.0,
                    "updatedAt": &completed_at,
                    "transcriptFirstAvailableAt": &completed_at,
                    "message": &degraded_reason,
                    "degraded": !transcript_complete,
                }),
            );
            if let Err(error) = completion_result.as_ref() {
                tracing::error!(
                    "Failed to finalize completed transcript for {}: {}",
                    recording_id_clone,
                    error
                );
                handle_clone.emit_event(
                    "recording-status-changed",
                    serde_json::json!({
                        "recordingId": &recording_id_clone,
                        "status": "error",
                        "message": format!("Failed to finalize transcript: {}", error),
                        "updatedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                let message = format!("Failed to finalize transcript: {error}");
                emit_meeting_lifecycle_phase(
                    state_clone.as_ref(),
                    &handle_clone,
                    "error",
                    &recording_id_clone,
                    Some(&message),
                );
                return;
            }

            // Completion is durable and visible before optional diarization begins.
            // The post-processing guard keeps retention and reset from removing
            // this recording while best-effort enrichment is still reading it.
            let mut diarization_updated = false;
            let mut diarization_fallback_notice: Option<String> = None;
            let mut diarization_failure_notice: Option<String> = None;
            if transcript_persisted {
                let (enable_diarization, diarization_model_id) = {
                    let sm = state_clone.settings_manager.lock().await;
                    let transcription = &sm.settings().transcription;
                    (
                        transcription.enable_diarization,
                        transcription
                            .diarization_model_id
                            .clone()
                            .unwrap_or_else(|| "ecapa_tdnn_speaker".to_string()),
                    )
                };
                // The automatic pass runs the model the user picked, not
                // always the default one, and readiness is asked per model
                // (pyannote community-1 needs a six-file bundle, not one
                // .onnx). `resolve_model_for_run` answers both questions at
                // once: whether anything local can run at all, and which model
                // it will be.
                // A meeting never downloads a speaker model: a missing pick
                // falls back to one already on this Mac, and with none at all
                // the meeting is saved without speakers and says how to get
                // one, from the meeting itself.
                let wants_local = resolve_meeting_diarizer(
                    enable_diarization,
                    prefer_provider_diarization,
                    transcript_has_source_aware_speakers(&transcript.segments),
                    transcribed_by_provider,
                    provider_speaker_turns.len(),
                    true,
                ) == MeetingDiarizer::Local;
                let resolved_local_model =
                    diarization::resolve_model_for_run(&diarization_model_id);
                if wants_local && resolved_local_model.is_none() {
                    let notice = diarization::no_speaker_model_notice(&diarization_model_id);
                    tracing::warn!("No speaker model for {}: {}", recording_id_clone, notice);
                    diarization_failure_notice = Some(notice);
                }
                let diarizer = resolve_meeting_diarizer(
                    enable_diarization,
                    prefer_provider_diarization,
                    transcript_has_source_aware_speakers(&transcript.segments),
                    transcribed_by_provider,
                    provider_speaker_turns.len(),
                    resolved_local_model.is_some(),
                );
                let local_diarization_model_id = resolved_local_model
                    .as_ref()
                    .map(|resolved| resolved.model_id.clone())
                    .unwrap_or_else(|| diarization_model_id.clone());
                let diarizer_record = diarizer.record_value(&local_diarization_model_id);

                // Both branches produce a `DiarizationResult` and hand it to
                // the same merge, so the transcript contract, the speaker ids
                // and the rename/alias flow are identical whichever diarizer
                // ran. The only difference the reader sees is the line naming
                // it.
                let diarization_result = match &diarizer {
                    MeetingDiarizer::None => None,
                    MeetingDiarizer::Provider(_) => {
                        let duration = transcript
                            .segments
                            .last()
                            .map(|segment| segment.end_time)
                            .unwrap_or(0.0);
                        Some(Ok(diarization_result_from_provider_turns(
                            &provider_speaker_turns,
                            duration,
                        )))
                    }
                    MeetingDiarizer::Local => Some(
                        run_meeting_diarization_with_waits(
                            &path,
                            &local_diarization_model_id,
                            &recording_id_clone,
                            &wait_budget,
                        )
                        .await,
                    ),
                };

                match diarization_result {
                    None => {}
                    Some(Ok(result)) => {
                        let engine = diarization::DiarizationEngine::new();
                        let mut enriched_segments = transcript.segments.clone();
                        if transcript.measured_word_timestamps {
                            engine.merge_with_measured_words(&result, &mut enriched_segments);
                        } else {
                            engine.merge_with_transcript(&result, &mut enriched_segments);
                        }
                        let update_result = {
                            let mut db = state_clone.db.lock().await;
                            // The audit entry goes in with the enrichment, not
                            // after it: the `diarizer` column and the entry
                            // record the same fact, and writing them under two
                            // separate lock acquisitions left a window where
                            // the column had changed and nothing said why.
                            db.apply_diarization_enrichment(
                                &recording_id_clone,
                                0,
                                &enriched_segments,
                                &[],
                                diarizer_record.as_deref(),
                                Some(serde_json::json!({
                                    "recording_id": &recording_id_clone,
                                    "diarizer": diarizer_record.as_deref(),
                                    "speaker_count": result.speakers.len(),
                                    "speaker_segment_count": result.segments.len(),
                                })),
                            )
                        };
                        match update_result {
                            Ok(true) => {
                                transcript.segments = enriched_segments;
                                diarization_updated = true;
                                // New speaker ids: whatever voices were held
                                // or stored for the old ones no longer
                                // describe them.
                                if let Err(error) = forget_superseded_cluster_voices(
                                    state_clone.as_ref(),
                                    &recording_id_clone,
                                )
                                .await
                                {
                                    tracing::warn!(
                                        "Could not drop superseded voice signatures of {}: {}",
                                        recording_id_clone,
                                        error
                                    );
                                }
                                // Only once labels are actually stored: a
                                // notice about which model produced them is a
                                // lie if none were produced. Only the local
                                // branch can substitute a model, so a provider
                                // pass carries no notice.
                                if diarizer == MeetingDiarizer::Local {
                                    diarization_fallback_notice = resolved_local_model
                                        .as_ref()
                                        .and_then(|resolved| resolved.fallback_notice.clone());
                                    // Voiceprints, on the same terms as the
                                    // manual run: only when the switch is on,
                                    // and best effort -- a meeting is not
                                    // failed by a voice that could not be
                                    // remembered. The signature is recorded
                                    // under the model that actually ran
                                    // (`local_diarization_model_id`, which may
                                    // be the fallback, not the requested one):
                                    // a centroid filed under the wrong
                                    // embedder would be compared across
                                    // embedding spaces, which is exactly what
                                    // the matcher refuses to do. Only this
                                    // branch: a provider pass returns labels,
                                    // not embeddings.
                                    let voice_settings = {
                                        let sm = state_clone.settings_manager.lock().await;
                                        sm.settings().meetings.clone()
                                    };
                                    if voice_settings.remember_voices {
                                        if let Err(error) = store_and_match_cluster_voices(
                                            state_clone.as_ref(),
                                            &recording_id_clone,
                                            &local_diarization_model_id,
                                            &result.cluster_centroids,
                                            voice_settings.auto_apply_confident_voices,
                                        )
                                        .await
                                        {
                                            tracing::warn!(
                                                "Voice matching after diarization of {} did not finish: {}",
                                                recording_id_clone,
                                                error
                                            );
                                        }
                                    }
                                }
                            }
                            Ok(false) => {
                                tracing::warn!(
                                    "Skipped diarization enrichment for {} because the transcript changed while diarization was running",
                                    recording_id_clone
                                );
                                // The reader's edit wins, but a transcript that
                                // silently never gets speakers is owed a reason.
                                diarization_failure_notice =
                                    Some(DIARIZATION_SKIPPED_FOR_EDIT_NOTICE.to_string());
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "Diarization completed for {} but enriched transcript persistence failed: {}",
                                    recording_id_clone,
                                    error
                                );
                                diarization_failure_notice = Some(
                                    "Speakers were not labelled because Plainsong could not save them. The transcript is saved; choose Label the speakers to try again."
                                        .to_string(),
                                );
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let error = format!("{error:#}");
                        tracing::warn!(
                            "Best-effort diarization failed for {}: {}",
                            recording_id_clone,
                            error
                        );
                        // Not only a log line: the reader sees a transcript
                        // with no speakers and is owed the reason.
                        let mut db = state_clone.db.lock().await;
                        if let Err(audit_error) = db.log_audit_event(
                            "meeting_diarization_failed",
                            Some(serde_json::json!({
                                "recording_id": &recording_id_clone,
                                "diarizer": diarizer_record.as_deref(),
                                "error": &error,
                            })),
                            "warning",
                        ) {
                            tracing::warn!(
                                "Failed to log the diarization failure for {}: {}",
                                recording_id_clone,
                                audit_error
                            );
                        }
                        diarization_failure_notice =
                            Some(meeting_diarization_failure_notice(&error));
                    }
                }

                let db = state_clone.db.lock().await;
                if let Ok(Some(latest_transcript)) = db.get_transcript(&recording_id_clone) {
                    transcript = latest_transcript;
                }
            }

            match completion_result {
                Err(error) => {
                    tracing::error!(
                        "Failed to finalize completed transcript for {}: {}",
                        recording_id_clone,
                        error
                    );
                    handle_clone.emit_event(
                        "recording-status-changed",
                        serde_json::json!({
                            "recordingId": &recording_id_clone,
                            "status": "error",
                            "message": format!("Failed to finalize transcript: {}", error),
                            "updatedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                }
                Ok(()) => {
                    if transcript_complete && diarization_failure_notice.is_none() {
                        if let Err(error) = state_clone
                            .db
                            .lock()
                            .await
                            .set_meeting_audio_finalized(&recording_id_clone, true)
                        {
                            tracing::warn!("Could not finalize meeting audio storage: {error}");
                        }
                    }
                    if diarization_updated {
                        handle_clone.emit_event(
                            "transcript-updated",
                            serde_json::json!({
                                "recordingId": &recording_id_clone,
                                "reason": "diarization",
                                "updatedAt": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                        // The completed event has already gone out (completion
                        // is durable before diarization starts), so a model
                        // substitution rides the same "a finished meeting can
                        // still carry a note" path the degraded transcript uses.
                        if let Some(notice) = diarization_fallback_notice.as_deref() {
                            tracing::warn!(
                                "Diarization for {} ran another downloaded speaker model: {}",
                                recording_id_clone,
                                notice
                            );
                            handle_clone.emit_event(
                                "recording-status-changed",
                                serde_json::json!({
                                    "recordingId": &recording_id_clone,
                                    "status": "completed",
                                    "message": notice,
                                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                                }),
                            );
                        }
                    }

                    // Same "a finished meeting can still carry a note" path
                    // as the model substitution above.
                    if let Some(notice) = diarization_failure_notice.as_deref() {
                        handle_clone.emit_event(
                            "recording-status-changed",
                            serde_json::json!({
                                "recordingId": &recording_id_clone,
                                "status": "completed",
                                "message": notice,
                                "updatedAt": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                    }

                    report_provider_cleanup_warnings(
                        state_clone.as_ref(),
                        Some((&handle_clone, recording_id_clone.as_str())),
                    )
                    .await;

                    if let Some(reason) = degraded_reason.as_deref() {
                        tracing::warn!(
                            "Meeting {} completed with a degraded transcript: {}",
                            recording_id_clone,
                            reason
                        );
                        let mut db = state_clone.db.lock().await;
                        if let Err(error) = db.log_audit_event(
                            "meeting_transcript_degraded",
                            Some(serde_json::json!({
                                "recording_id": &recording_id_clone,
                                "reason": reason,
                            })),
                            "warning",
                        ) {
                            tracing::warn!(
                                "Failed to log degraded transcript for {}: {}",
                                recording_id_clone,
                                error
                            );
                        }
                    }

                    let full_text = transcript.full_text.clone();
                    let auto_analyze = {
                        let sm = state_clone.settings_manager.lock().await;
                        sm.settings().transcription.enable_auto_analysis
                    };

                    if auto_analyze && !full_text.trim().is_empty() {
                        let state_analysis = Arc::clone(&state_clone);
                        let handle_analysis = handle_clone.clone();
                        let rec_id_analysis = recording_id_clone.clone();
                        tokio::spawn(async move {
                            run_meeting_analysis_until_written(
                                &state_analysis,
                                &handle_analysis,
                                &rec_id_analysis,
                                MeetingAnalysisMode::Automatic,
                            )
                            .await;
                        });
                    } else {
                        // No analysis pass will run, so nothing else will name
                        // this meeting. Title it from the transcript directly
                        // rather than leaving the placeholder in place.
                        match auto_name_meeting_recording(
                            state_clone.as_ref(),
                            &handle_clone,
                            &recording_id_clone,
                            None,
                            true,
                        )
                        .await
                        {
                            Ok(Some(title)) => {
                                tracing::info!(
                                    "Auto-named meeting '{}' to '{}'",
                                    recording_id_clone,
                                    title
                                )
                            }
                            Ok(None) => {}
                            Err(e) => tracing::warn!(
                                "Meeting auto-name failed for '{}': {}",
                                recording_id_clone,
                                e
                            ),
                        }
                    }

                    if let Err(error) = enforce_meeting_retention_policy(
                        state_clone.as_ref(),
                        None::<&crate::sidecar_handle::SidecarHandle>,
                        "meeting-completed",
                        None,
                    )
                    .await
                    {
                        tracing::warn!(
                            "Failed to enforce meeting retention after {} completed: {}",
                            recording_id_clone,
                            error
                        );
                    }
                }
            }
        }
        Err(e) => {
            if !meeting_pipeline_failure_should_be_persisted(
                state_clone.sidecar_shutting_down.load(Ordering::SeqCst),
            ) {
                tracing::info!(
                    "Meeting transcription for {} was interrupted by sidecar shutdown; leaving it processing for startup recovery",
                    recording_id_clone
                );
                return;
            }
            if wait_budget.memory_deferred() {
                tracing::info!(
                    "Final transcription for {} is pending memory: {}",
                    recording_id_clone,
                    e
                );
                defer_meeting_transcription(
                    state_clone.as_ref(),
                    &handle_clone,
                    &recording_id_clone,
                )
                .await;
                return;
            }
            tracing::error!("Failed to transcribe {}: {}", recording_id_clone, e);
            {
                let mut db = state_clone.db.lock().await;
                if let Err(error) = db.update_recording_status(&recording_id_clone, "error") {
                    tracing::error!(
                        "Failed to persist transcription error status for {}: {}",
                        recording_id_clone,
                        error
                    );
                }
                if let Err(error) = db.log_audit_event(
                    "transcription_failed",
                    Some(serde_json::json!({"recording_id": &recording_id_clone, "error": &e})),
                    "error",
                ) {
                    tracing::warn!(
                        "Failed to log transcription error for {}: {}",
                        recording_id_clone,
                        error
                    );
                }
            }
            handle_clone.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id_clone, "status": "error",
                    "message": &e, "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state_clone.as_ref(),
                &handle_clone,
                "error",
                &recording_id_clone,
                Some(&e),
            );
        }
    }

    let terminal_phase = {
        let db = state_clone.db.lock().await;
        match db.get_recording(&recording_id_clone) {
            Ok(Some(recording)) if recording.status == "completed" => "ready",
            _ => "error",
        }
    };
    // A retranscription may finish while another meeting is capturing. Update
    // only the overlay that still owns this identifier, and retain the terminal
    // state so a renderer remount cannot erase recovery information.
    let terminal_update =
        state_clone
            .recording_overlay_state
            .lock()
            .ok()
            .and_then(|mut overlay| {
                if overlay.recording_id.as_deref() != Some(recording_id_clone.as_str()) {
                    return None;
                }
                if overlay.phase == terminal_phase {
                    return None;
                }
                overlay.phase = terminal_phase.to_string();
                overlay.dismissed = false;
                overlay.message = Some(if terminal_phase == "ready" {
                    "Meeting transcript is ready".to_string()
                } else {
                    "Meeting processing failed. Open Meetings to retry from saved audio."
                        .to_string()
                });
                Some(overlay.message.clone())
            });
    if let Some(message) = terminal_update {
        handle_clone.emit_event(
            "meeting-recording-state-changed",
            serde_json::json!({
                "phase": terminal_phase,
                "recordingId": &recording_id_clone,
                "message": message,
            }),
        );
    }
}

pub(crate) fn meeting_pipeline_failure_should_be_persisted(sidecar_shutting_down: bool) -> bool {
    !sidecar_shutting_down
}

#[cfg(test)]
mod capture_completeness_tests {
    use super::meeting_completion_degraded_reason;

    #[test]
    fn no_loss_is_complete() {
        assert_eq!(meeting_completion_degraded_reason(Ok(None), None), None);
        assert_eq!(
            meeting_completion_degraded_reason(Ok(Some(" ".into())), Some(" ")),
            None
        );
    }

    #[test]
    fn saved_capture_loss_survives_successful_retranscription() {
        let summary = "Part of this conversation was not saved.";
        for _ in 0..2 {
            assert_eq!(
                meeting_completion_degraded_reason(Ok(Some(summary.into())), None).as_deref(),
                Some(summary)
            );
        }
    }

    #[test]
    fn capture_and_asr_reasons_are_both_preserved() {
        assert_eq!(
            meeting_completion_degraded_reason(
                Ok(Some("Missing saved audio.".into())),
                Some(" Part could not be transcribed. ")
            )
            .as_deref(),
            Some("Missing saved audio. Part could not be transcribed.")
        );
        assert_eq!(
            meeting_completion_degraded_reason(Ok(None), Some("Part could not be transcribed."))
                .as_deref(),
            Some("Part could not be transcribed.")
        );
    }

    #[test]
    fn metadata_read_failure_keeps_incomplete_provenance() {
        let reason = meeting_completion_degraded_reason(
            Err("database unavailable".into()),
            Some("ASR was partial."),
        )
        .unwrap();
        assert!(reason.contains("could not be checked"));
        assert!(reason.contains("ASR was partial."));
        assert!(!reason.contains("database unavailable"));
        assert!(
            meeting_completion_degraded_reason(Err("database unavailable".into()), None).is_some()
        );
    }
}
