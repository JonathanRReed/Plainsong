//! The sidecar's JSON-RPC router.
//!
//! `src/bin/sidecar.rs` reads one newline-delimited request off stdin and calls
//! [`dispatch_command`]. This module is the whole renderer-facing surface of the
//! sidecar: the arm list here and the allowlist in `electron/ipc-bridge.ts` are
//! the same contract, checked by `scripts/verify-ipc-contract.ts`.
//!

use super::*;
use crate::models::TranscriptSegmentExpectation;

/// How many bytes an export wrote, for the audit log. The log records the
/// format and this size, never the path: an export is named after its meeting.
fn exported_file_bytes(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn deletable_recording_bundle(
    db: &db::Database,
    recording_id: &str,
) -> Result<crate::recording_audio::RecordingAudioBundle, String> {
    // Refuse while either half of the capture pipeline can still write
    // transcript rows. Deleting during post-processing would let the
    // background task recreate an orphan transcript after this returns.
    if db
        .has_pending_audio_compression(recording_id)
        .map_err(|e| e.to_string())?
    {
        return Err("Wait for audio compression cleanup before deleting this meeting.".into());
    }
    let recording = db
        .get_recording(recording_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Recording not found".to_string())?;
    match recording.status.as_str() {
        "recording" => return Err("Stop the meeting before deleting it.".to_string()),
        "processing" => {
            return Err("Wait for meeting processing to finish before deleting it.".to_string())
        }
        _ => {}
    }
    if db
        .load_open_recording_audio_operation(recording_id)
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err(
            "Wait for recording audio encryption to finish before deleting this meeting."
                .to_string(),
        );
    }
    db.load_recording_audio_bundle(recording_id)
        .map_err(|error| error.to_string())
}

fn parse_save_settings_request(
    mut params: serde_json::Value,
) -> Result<(settings::Settings, bool), String> {
    let envelope = params.as_object_mut().ok_or("Expected settings object")?;
    let preserve_saved_prompts = match envelope.remove("preserveSavedPrompts") {
        None => false,
        Some(serde_json::Value::Bool(value)) => value,
        Some(_) => return Err("preserveSavedPrompts must be a boolean".to_string()),
    };
    let payload = envelope.remove("settings").unwrap_or(params);
    let settings = serde_json::from_value(payload).map_err(|e| e.to_string())?;
    Ok((settings, preserve_saved_prompts))
}

fn parse_settings_update_request(
    params: serde_json::Value,
) -> Result<(settings_patch::SettingsUpdate, bool), String> {
    if params.get("patch").is_some() {
        let mut envelope = params
            .as_object()
            .ok_or("Expected settings object")?
            .clone();
        if envelope
            .keys()
            .any(|key| !matches!(key.as_str(), "patch" | "preserveSavedPrompts"))
        {
            return Err("Unexpected settings patch envelope field".into());
        }
        let preserve = match envelope.remove("preserveSavedPrompts") {
            None => false,
            Some(serde_json::Value::Bool(value)) => value,
            Some(_) => return Err("preserveSavedPrompts must be a boolean".into()),
        };
        let patch =
            settings_patch::SettingsPatch::parse(envelope.remove("patch").ok_or("Missing patch")?)?;
        Ok((settings_patch::SettingsUpdate::Patch(patch), preserve))
    } else {
        let (settings, preserve) = parse_save_settings_request(params)?;
        Ok((
            settings_patch::SettingsUpdate::Replace(Box::new(settings)),
            preserve,
        ))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetSavedPromptsRequest {
    saved_prompts: Vec<settings::SavedPrompt>,
}

fn parse_set_saved_prompts_request(
    params: serde_json::Value,
) -> Result<Vec<settings::SavedPrompt>, String> {
    serde_json::from_value::<SetSavedPromptsRequest>(params)
        .map(|request| request.saved_prompts)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AsrRuntimeDiagnosticsRequest {
    provider_type: asr::AsrProviderType,
    #[serde(default, deserialize_with = "deserialize_diagnostic_model_id")]
    model_id: Option<String>,
}

/// The background speech-model download, for a Models screen that opens
/// after its `speech-model-download-notice` events already went by.
fn speech_model_download_notice() -> Result<serde_json::Value, String> {
    #[cfg(feature = "asr-transcribe-cpp")]
    let notice = asr::neural_engine::download_notice();
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    let notice = serde_json::json!({"state": "idle", "percent": 0, "totalBytes": 0});
    serde_json::to_value(notice).map_err(|e| e.to_string())
}

fn parse_asr_runtime_diagnostics_request(
    params: serde_json::Value,
) -> Result<AsrRuntimeDiagnosticsRequest, String> {
    let request: AsrRuntimeDiagnosticsRequest =
        serde_json::from_value(params).map_err(|e| e.to_string())?;
    if let Some(model_id) = request.model_id.as_deref() {
        if !request
            .provider_type
            .model_options()
            .iter()
            .any(|option| option.id == model_id)
        {
            return Err("modelId is not available for this provider".to_string());
        }
    }
    Ok(request)
}

fn deserialize_diagnostic_model_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let model_id = <String as serde::Deserialize>::deserialize(deserializer)?;
    if model_id.trim().is_empty() || model_id.trim() != model_id {
        return Err(serde::de::Error::custom(
            "modelId must be a nonempty model identifier",
        ));
    }
    Ok(Some(model_id))
}

const MAX_MEETING_FOLLOWUP_QUERY_BYTES: usize = 4_096;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMeetingFollowupsRequest {
    query: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
    #[serde(default)]
    include_completed: bool,
}

struct OllamaPullActiveGuard(Arc<AtomicBool>);

impl Drop for OllamaPullActiveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn normalize_meeting_chat_citation(
    citation: MeetingChatCitationRecord,
) -> Option<MeetingChatCitationRecord> {
    let text = citation.text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let normalize_optional = |value: Option<String>| {
        value.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()))
    };
    Some(MeetingChatCitationRecord {
        text,
        source_kind: normalize_optional(citation.source_kind),
        line_id: normalize_optional(citation.line_id),
        segment_id: normalize_optional(citation.segment_id),
        start_time: citation.start_time,
        end_time: citation.end_time,
        recording_id: normalize_optional(citation.recording_id),
        certainty: citation.certainty,
    })
}

/// What Settings shows about meaning search: the built-in models and whether
/// each is on disk, how much of the library the selected index covers, and
/// whether indexing or a download is running.
async fn embedding_status(state: &AppState) -> Result<serde_json::Value, String> {
    let (route, mode, selected_builtin, acceptances) = {
        let sm = state.settings_manager.lock().await;
        let transcription = &sm.settings().transcription;
        (
            crate::semantic_index::ActiveRoute::from_settings(transcription),
            transcription.memory_search_mode.clone(),
            llm::builtin_embeddings::model_or_default(&transcription.builtin_embedding_model).id,
            transcription.builtin_embedding_terms_acceptances.clone(),
        )
    };
    let (count, coverage) = {
        let db = state.db.lock().await;
        let count = db.embedding_count().map_err(|e| e.to_string())?;
        let coverage = match route.as_ref() {
            Some(route) => Some(
                db.semantic_index_coverage(&route.key())
                    .map_err(|e| e.to_string())?,
            ),
            None => None,
        };
        (count, coverage)
    };
    let ollama_available = if mode == crate::semantic_index::MODE_OLLAMA {
        state.ollama_embedder.is_available().await
    } else {
        false
    };
    let root = llm::builtin_embeddings::models_root();
    let models: Vec<serde_json::Value> = llm::builtin_embeddings::MODELS
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id,
                "displayName": model.display_name,
                "vendor": model.vendor,
                "summary": model.summary,
                "languages": model.languages,
                "license": model.license,
                "termsUrl": model.terms_url,
                "usePolicyUrl": model.use_policy_url,
                "requiresTermsAcceptance": model.requires_terms_acceptance,
                "termsAccepted": llm::builtin_embeddings::terms_accepted(model, &acceptances),
                "downloadBytes": model.download_bytes(),
                "downloaded": root
                    .as_ref()
                    .is_some_and(|root| llm::builtin_embeddings::artifacts_installed(root, model)),
                "isDefault": model.id == llm::builtin_embeddings::DEFAULT_MODEL_ID,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "qaHelperFootprints": llm::builtin_embeddings::helper_qa_footprints(),
        "memorySearchMode": mode,
        "embeddingCount": count,
        "ollamaAvailable": ollama_available,
        "builtInAvailable": llm::builtin_embeddings::runtime_compiled(),
        "builtInModels": models,
        "selectedBuiltInModel": selected_builtin,
        "indexedRecordings": coverage.map(|(indexed, _)| indexed),
        "totalRecordings": coverage.map(|(_, total)| total),
        "indexing": crate::semantic_index::indexing_active(),
        "downloading": llm::builtin_embeddings::download_active(),
        "lastError": crate::semantic_index::last_error(),
    }))
}

async fn publish_dictation_start_error_if_idle<E: crate::sidecar_handle::AppEmitter>(
    tracker: &tokio::sync::Mutex<DictationSessionTracker>,
    emitter: &E,
    error: &str,
) {
    let tracker = tracker.lock().await;
    if tracker.active_session_id.is_none() {
        emitter.emit_event(
            "dictation-state-changed",
            serde_json::json!({
                "phase": "error",
                "message": error,
            }),
        );
    }
}

/// Dispatch a JSON-RPC command by name to the appropriate handler function.
/// Used by the sidecar binary's stdin loop.
///
/// Commands that previously relied on shell-owned window management are handled here
/// with `SidecarHandle` event emission, while window ownership stays in the
/// Electron main process via IPC.
pub async fn dispatch_command(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _command_lease = if method == "restore_backup_default" {
        None
    } else {
        Some(
            state
                .operation_coordinator
                .try_acquire(operation_coordinator::OperationKind::Command)?,
        )
    };
    match method {
        // ── Dictation ──────────────────────────────────────────────────────────
        "start_dictation" => {
            let options: models::DictationStartOptions = serde_json::from_value(
                params
                    .get("options")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(Default::default())),
            )
            .unwrap_or_default();
            let hands_free_trigger = options.hands_free_trigger;
            // The idle-time hands-free monitor and a real dictation session must never
            // hold the microphone at once. A start the monitor itself signalled keeps
            // its stream running for `start_dictation` to take over, so the user's
            // words keep reaching the pre-roll; every other start stops it now (no-op
            // if it wasn't running).
            {
                let mut audio = state.audio_capture.lock().await;
                if hands_free_trigger {
                    audio.hold_hands_free_monitor(true);
                } else {
                    audio.stop_hands_free_monitor();
                }
            }
            // The result is captured rather than `?`-propagated: a `?` here
            // returned before the reconcile below, so a failed start left
            // hands-free monitoring stopped and the user's next utterance was
            // never heard. The comment claimed reconciliation always ran; now
            // it actually does, on both the success and failure paths.
            let start_result = start_dictation_for_sidecar(state, handle, options).await;
            if hands_free_trigger {
                // A start that failed before taking the stream over must not
                // leave the still-running monitor deaf.
                state
                    .audio_capture
                    .lock()
                    .await
                    .hold_hands_free_monitor(false);
            }

            // If starting failed, the runtime state falls back to `Idle` inside
            // `start_dictation_for_sidecar`'s own error handling, so it's always safe to
            // reconcile here regardless of success/failure — this is what resumes idle
            // listening if start_dictation errored out before ever recording.
            reconcile_hands_free_monitor(state.as_ref(), handle).await;

            match start_result {
                Ok((session_id, mut start_guard)) => {
                    let tracker = state.dictation_session_tracker.lock().await;
                    let runtime = state.dictation_runtime_state.lock().await;
                    if !dictation_start_matches(
                        &tracker,
                        *runtime,
                        session_id,
                        DictationSessionState::Recording,
                    ) {
                        return Err("Dictation start was cancelled".to_string());
                    }
                    start_guard.disarm();
                    Ok(serde_json::json!({ "sessionId": session_id }))
                }
                Err(error) => {
                    // Make the failure visible instead of leaving the HUD to
                    // time out on its own. A cancelled start has already
                    // emitted idle, and a stale start must not demote a newer
                    // session with an unscoped error event.
                    if error != "Dictation start was cancelled" {
                        publish_dictation_start_error_if_idle(
                            &state.dictation_session_tracker,
                            handle,
                            &error,
                        )
                        .await;
                    }
                    Err(error)
                }
            }
        }
        "stop_dictation" => {
            let stop_reason = params
                .get("stopReason")
                .and_then(|v| v.as_str())
                .unwrap_or("manual");
            // Optional session scoping (used by the VAD auto-stop path): a
            // stop carrying a sessionId only applies while that session is
            // still the active one. Manual stops omit it and behave as before.
            let expected_session_id = params.get("sessionId").and_then(|v| v.as_u64());
            // Optional real client-side stop-gesture epoch (hotkey release,
            // hands-free toggle) -- see `dictation-shortcut-controller.ts`.
            // Absent for callers that haven't been updated, or stop paths
            // with no discrete client gesture; `stop_dictation_for_sidecar`
            // falls back to its own receipt time and names the field
            // honestly either way.
            let stop_gesture_epoch_ms = params.get("stopGestureEpochMs").and_then(|v| v.as_i64());
            let result = stop_dictation_for_sidecar(
                state.as_ref(),
                handle,
                stop_reason,
                expected_session_id,
                stop_gesture_epoch_ms,
            )
            .await?;
            reconcile_hands_free_monitor(state.as_ref(), handle).await;
            Ok(serde_json::json!({ "text": result }))
        }
        "force_stop_dictation" => {
            let expected_session_id = params.get("sessionId").and_then(|value| value.as_u64());
            // Claim cancellation before touching audio. Startup checks this
            // ownership token after opening capture, so either cancellation
            // aborts the stream or startup observes that it lost ownership
            // and aborts its own newly-created stream.
            let mut tracker = state.dictation_session_tracker.lock().await;
            let active_session_id =
                claim_dictation_cancellation(&mut tracker, expected_session_id)?;
            if let Ok(mut results) = state.recent_dictation_results.lock() {
                cancel_recent_dictation_result(&mut results, active_session_id);
            }
            drop(tracker);
            // Cancelled is a recorded outcome: the stop path, if it is running,
            // deletes its checkpoint when it notices; this covers a quit that
            // ends the process first.
            if let Ok(dir) = crate::dictation_checkpoint::dictation_checkpoint_directory() {
                crate::dictation_checkpoint::discard_in_flight_checkpoint(&dir);
            }
            #[cfg(target_os = "macos")]
            release_session_selection_owner(state.as_ref(), active_session_id).await;
            let mut audio = state.audio_capture.lock().await;
            audio.abort_dictation_for_session(active_session_id);
            drop(audio);
            persist_finished_meeting_aside(state.as_ref(), active_session_id).await;
            let cleaned_current_session = reset_dictation_session_runtime_if_current(
                &state.dictation_runtime_state,
                &state.dictation_session_tracker,
                &state.dictation_start_options,
                active_session_id,
            )
            .await;
            if !cleaned_current_session {
                return Err(format!(
                    "Dictation session {} changed while force-stop was cleaning up",
                    active_session_id
                ));
            }
            stop_dictation_live_preview_for_session(state.as_ref(), active_session_id).await;
            state.dictation_model_release.notify();
            if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                if overlay.session_id == Some(active_session_id) {
                    *overlay = DictationOverlayState::default();
                }
            }
            handle.emit_event("dictation-state-changed", serde_json::json!({ "phase": "idle", "stopReason": "force-stop", "outcome": "aborted" }));
            handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
            reconcile_hands_free_monitor(state.as_ref(), handle).await;
            Ok(serde_json::json!({ "text": "" }))
        }
        "get_dictation_audio_level" => {
            let audio = state.audio_capture.lock().await;
            Ok(serde_json::json!(audio.get_dictation_audio_level()))
        }
        "get_permission_diagnostics" => {
            let result = collect_permission_diagnostics(state.as_ref(), Vec::new()).await;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "check_system_audio_availability" => {
            let audio = state.audio_capture.lock().await;
            Ok(serde_json::json!(audio.is_system_audio_available()))
        }
        "get_loopback_device_name" => {
            let audio = state.audio_capture.lock().await;
            Ok(serde_json::json!(audio.get_loopback_device_name()))
        }
        "get_system_audio_capability" => {
            let result = tokio::task::spawn_blocking(|| {
                audio::system_capture::SystemAudioCapture::new().capability()
            })
            .await
            .map_err(|error| format!("System-audio capability check failed: {error}"))?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "test_system_audio_capture" => {
            let test_guard = {
                let audio = state.audio_capture.lock().await;
                audio
                    .begin_system_audio_test()
                    .map_err(|error| error.to_string())?
            };
            let result = tokio::task::spawn_blocking(move || {
                let _test_guard = test_guard;
                audio::system_capture::SystemAudioCapture::new()
                    .test_system_audio_bounded(std::time::Duration::from_secs(75))
            })
            .await
            .map_err(|error| format!("System-audio verification failed: {error}"))?;
            handle.emit_event(
                "readiness-invalidated",
                serde_json::json!({ "reason": "system_audio_test_completed" }),
            );
            serde_json::to_value(result).map_err(|error| error.to_string())
        }

        // ── Recording ──────────────────────────────────────────────────────────
        "start_recording" => {
            let options: models::RecordingOptions = serde_json::from_value(
                params
                    .get("options")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(Default::default())),
            )
            .map_err(|e| e.to_string())?;
            // Admission is the consent gate: without privileged Electron proof
            // the capture never had a consent prompt behind it.
            let options = authorize_meeting_capture_options(&state.capture_admission, options)
                .map_err(|error| {
                    fail_meeting_start(
                        state.as_ref(),
                        handle,
                        None,
                        MeetingStartErrorCode::ConsentRequired,
                        error,
                    )
                })?;
            let recording_id = start_recording_for_sidecar(state, handle, options).await?;
            Ok(serde_json::json!({ "recordingId": recording_id }))
        }
        "stop_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            stop_recording_for_sidecar(state, handle, recording_id).await?;
            Ok(serde_json::Value::Null)
        }
        "pause_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            set_recording_paused_for_sidecar(state, handle, &recording_id, true).await
        }
        "resume_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            set_recording_paused_for_sidecar(state, handle, &recording_id, false).await
        }
        "get_meeting_call_status" => Ok(meeting_call_status_for_sidecar(state).await),
        "dismiss_detected_call" => {
            // Scoped to one call: the detector only marks the call whose id
            // this is, so a stale dismissal (the call already ended) changes
            // nothing and the next call in the same app is offered again.
            let call_id: u64 =
                serde_json::from_value(params["callId"].clone()).map_err(|e| e.to_string())?;
            let dismissed = state
                .meeting_call_detector
                .lock()
                .map(|mut detector| detector.dismiss(call_id))
                .unwrap_or(false);
            if dismissed {
                tracing::info!("Detected call {} dismissed by the user", call_id);
            }
            Ok(meeting_call_status_for_sidecar(state).await)
        }
        "acknowledge_incomplete_transcript" => {
            // Storage policy holds a meeting's audio back while its transcript
            // is known incomplete, because that audio is the only complete
            // record of what was said. This is the user saying they understand
            // that and want the policy applied anyway. It never claims the
            // transcript became complete — re-transcribing is what does that.
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let reason = {
                let mut db = state.db.lock().await;
                let reason = db
                    .acknowledge_incomplete_transcript(&recording_id)
                    .map_err(|error| error.to_string())?;
                let _ = db.log_audit_event(
                    "meeting_incomplete_transcript_acknowledged",
                    Some(serde_json::json!({
                        "recording_id": &recording_id,
                        "reason": &reason,
                    })),
                    "warning",
                );
                reason
            };
            handle.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "status": "completed",
                    "degraded": true,
                    "message": reason,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            Ok(serde_json::json!({
                "recordingId": &recording_id,
                "acknowledged": true,
                "reason": reason,
            }))
        }
        "get_recording_aside_ranges" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let recording = db
                .get_recording(&recording_id)
                .map_err(|e| e.to_string())?
                .ok_or("Recording not found")?;
            let ranges = db
                .aside_spans(&recording_id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|span| {
                    let start = span.start_frame as f64 / f64::from(span.sample_rate);
                    let end = span.end_frame.map_or(recording.duration as f64, |frame| {
                        frame as f64 / f64::from(span.sample_rate)
                    });
                    serde_json::json!({"startTime":start,"endTime":end.max(start)})
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!(ranges))
        }
        "get_recording_asides" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            serde_json::to_value(
                db.asides_for_review(&recording_id)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "delete_recording_aside" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let aside_id: String =
                serde_json::from_value(params["asideId"].clone()).map_err(|e| e.to_string())?;
            state
                .db
                .lock()
                .await
                .delete_aside(&recording_id, &aside_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "export_recording_audio" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let (recording, spans, mic_only) = {
                let db = state.db.lock().await;
                let recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found")?;
                let bundle = db
                    .load_recording_audio_bundle(&recording_id)
                    .map_err(|e| e.to_string())?;
                let mic_only = bundle.mic.is_none() && bundle.system.is_none();
                (
                    recording,
                    db.aside_spans(&recording_id).map_err(|e| e.to_string())?,
                    mic_only,
                )
            };
            let mut path = export::get_default_export_path(&recording, export::ExportFormat::Text)
                .with_extension("wav");
            let location_id = state
                .settings_manager
                .lock()
                .await
                .settings()
                .privacy
                .export_location_id
                .clone();
            if let Some(location_id) = location_id {
                let root = approved_locations::registry()
                    .map_err(|e| e.to_string())?
                    .resolve_filesystem(
                        &location_id,
                        approved_locations::ApprovedLocationPurpose::Export,
                    )
                    .map_err(|e| e.to_string())?;
                path = root.join(path.file_name().ok_or("Audio export has no filename")?);
            }
            if let Some(parent) = path.parent() {
                safe_fs::ensure_directory_without_links(parent).map_err(|e| e.to_string())?;
            }
            let path = PathBuf::from(
                validate_export_target_path(state.as_ref(), &path.to_string_lossy()).await?,
            );
            let audio = resolve_recording_audio_for_runtime(
                state.as_ref(),
                &recording_id,
                RuntimeAudioResolveMode::PlaybackPrimary,
            )
            .await?;
            let destination = path.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let staged = audio
                    .primary
                    .with_file_name(format!(".aside-export-{}.wav", uuid::Uuid::new_v4()));
                meeting_aside_audio::copy_wav(
                    &audio.primary,
                    &staged,
                    if mic_only { &spans } else { &[] },
                    false,
                )?;
                let owner = recording_audio::DurableTempFile::new(staged.clone());
                if let Some(parent) = destination.parent() {
                    safe_fs::ensure_directory_without_links(parent).map_err(|e| e.to_string())?;
                }
                safe_fs::atomic_replace_with(&destination, |file| {
                    let mut source = std::fs::File::open(owner.path())?;
                    std::io::copy(&mut source, file)?;
                    Ok(())
                })
                .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(serde_json::json!({"exportPath": path}))
        }
        "revalidate_recording_audio" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            revalidate_recording_audio_for_sidecar(state.as_ref(), handle, &recording_id).await
        }
        "retry_meeting_auto_name" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let _transcript = {
                let db = state.db.lock().await;
                db.get_transcript(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Cannot auto-name meeting without a transcript".to_string())?
            };
            auto_name_meeting_recording(state.as_ref(), handle, &recording_id, None, true).await?;
            Ok(serde_json::Value::Null)
        }
        "get_recordings" => {
            let project_id: Option<String> = serde_json::from_value(
                params
                    .get("projectId")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .ok()
            .flatten();
            let db = state.db.lock().await;
            let recs = db
                .get_recordings(project_id.as_deref())
                .map_err(|e| e.to_string())?;
            let mut value = serde_json::to_value(recs).map_err(|e| e.to_string())?;
            // Dictation rows carry a text preview and the app they went into,
            // so history lists can show the words instead of "Dictation - <date>".
            if let Ok(previews) = db.get_dictation_list_previews() {
                if let Some(rows) = value.as_array_mut() {
                    for row in rows {
                        let Some(id) = row.get("id").and_then(|id| id.as_str()) else {
                            continue;
                        };
                        if let Some((preview, app)) = previews.get(id).cloned() {
                            row["dictationPreview"] = serde_json::json!(preview);
                            row["dictationAppTarget"] = serde_json::json!(app);
                        }
                    }
                }
            }
            Ok(value)
        }
        "list_meeting_followups" => {
            let request: ListMeetingFollowupsRequest =
                serde_json::from_value(params).map_err(|error| error.to_string())?;
            if request
                .query
                .as_ref()
                .is_some_and(|query| query.len() > MAX_MEETING_FOLLOWUP_QUERY_BYTES)
            {
                return Err(format!(
                    "Meeting follow-up query cannot exceed {MAX_MEETING_FOLLOWUP_QUERY_BYTES} bytes"
                ));
            }
            let offset = request.offset.unwrap_or(0);
            if offset > MAX_SAFE_JSON_INTEGER.saturating_sub(100) {
                return Err("Meeting follow-up offset is outside the safe range".to_string());
            }
            let offset = usize::try_from(offset)
                .map_err(|_| "Meeting follow-up offset is outside the safe range".to_string())?;
            let limit = request.limit.unwrap_or(30).clamp(1, 100) as usize;
            let db = state.db.lock().await;
            let page = db
                .list_meeting_followups(
                    request.query.as_deref(),
                    offset,
                    limit,
                    request.include_completed,
                )
                .map_err(|error| error.to_string())?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "get_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let result = db.get_recording(&recording_id).map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_meeting_action_completion" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let completed_tasks = db
                .get_meeting_action_completion(&recording_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "completedTasks": completed_tasks }))
        }
        "edit_meeting_action" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let expected_items: Vec<String> =
                serde_json::from_value(params["expectedItems"].clone())
                    .map_err(|e| e.to_string())?;
            let index: usize =
                serde_json::from_value(params["index"].clone()).map_err(|e| e.to_string())?;
            let replacement: String =
                serde_json::from_value(params["replacement"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let (recording, completed_tasks) = db
                .edit_meeting_action(&recording_id, &expected_items, index, &replacement)
                .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "recording": recording, "completedTasks": completed_tasks }))
        }
        "add_meeting_action" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let expected_items: Vec<String> =
                serde_json::from_value(params["expectedItems"].clone())
                    .map_err(|e| e.to_string())?;
            let replacement: String =
                serde_json::from_value(params["replacement"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let (recording, completed_tasks) = db
                .add_meeting_action(&recording_id, &expected_items, &replacement)
                .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "recording": recording, "completedTasks": completed_tasks }))
        }
        "delete_meeting_action" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let expected_items: Vec<String> =
                serde_json::from_value(params["expectedItems"].clone())
                    .map_err(|e| e.to_string())?;
            let index: usize =
                serde_json::from_value(params["index"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let (recording, completed_tasks) = db
                .delete_meeting_action(&recording_id, &expected_items, index)
                .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "recording": recording, "completedTasks": completed_tasks }))
        }
        "set_meeting_action_completed" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let task: String =
                serde_json::from_value(params["task"].clone()).map_err(|e| e.to_string())?;
            let completed: bool =
                serde_json::from_value(params["completed"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let completed_tasks = db
                .set_meeting_action_completed(&recording_id, &task, completed)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "completedTasks": completed_tasks }))
        }
        "get_dictation_edit" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let text = db
                .get_dictation_edit(&recording_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "text": text }))
        }
        "list_dictation_drafts" => {
            let db = state.db.lock().await;
            let drafts = db.list_dictation_drafts().map_err(|e| e.to_string())?;
            serde_json::to_value(drafts).map_err(|e| e.to_string())
        }
        "save_dictation_draft" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let text: Option<String> = serde_json::from_value(
                params
                    .get("text")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let expected_saved_text: Option<String> = serde_json::from_value(
                params
                    .get("expectedSavedText")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.save_dictation_draft(
                &recording_id,
                text.as_deref(),
                expected_saved_text.as_deref(),
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "clear_dictation_draft" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let expected_draft_text: String =
                serde_json::from_value(params["expectedDraftText"].clone())
                    .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let cleared = db
                .clear_dictation_draft(&recording_id, &expected_draft_text)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "cleared": cleared }))
        }
        "stage_saved_dictation_result" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;

            // Remember the idle generation before reading storage. A hotkey can
            // start a new capture while the database lock is awaited, so the
            // same generation must still be idle before this older result is
            // promoted to the front of recovery memory.
            let idle_generation = {
                let tracker = state.dictation_session_tracker.lock().await;
                let runtime = state.dictation_runtime_state.lock().await;
                if tracker.active_session_id.is_some() || *runtime != DictationSessionState::Idle {
                    return Err(
                        "Cannot stage a saved dictation while dictation is active.".to_string()
                    );
                }
                tracker.next_session_id
            };

            // All candidate text comes from native-owned persistence. A saved
            // correction wins when present; otherwise use the original
            // transcript stored with the dictation history row.
            let text = {
                let db = state.db.lock().await;
                match db
                    .get_dictation_edit(&recording_id)
                    .map_err(|e| e.to_string())?
                {
                    Some(text) => text,
                    None => {
                        db.get_transcript(&recording_id)
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| {
                                format!("Recording '{}' has no persisted transcript", recording_id)
                            })?
                            .full_text
                    }
                }
            };
            if text.trim().is_empty() {
                return Err("Saved dictation text is blank.".to_string());
            }

            // Hold the tracker through the synchronous memory write. This
            // closes the gap between the recheck and record_recent... because
            // every new capture claims its session under this same lock.
            let tracker = state.dictation_session_tracker.lock().await;
            let runtime = state.dictation_runtime_state.lock().await;
            if tracker.active_session_id.is_some()
                || tracker.next_session_id != idle_generation
                || *runtime != DictationSessionState::Idle
            {
                return Err("Cannot stage a saved dictation while dictation is active.".to_string());
            }
            record_recent_dictation_result(
                state.as_ref(),
                handle,
                &text,
                None,
                None,
                None,
                DictationRecoveryState::Completed,
            );
            Ok(serde_json::json!({ "text": text }))
        }
        "save_dictation_edit" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let text: Option<String> = serde_json::from_value(
                params
                    .get("text")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let expected_text: Option<String> = serde_json::from_value(
                params
                    .get("expectedText")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let saved = db
                .save_dictation_edit(&recording_id, text.as_deref(), expected_text.as_deref())
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "text": saved }))
        }
        "get_transcript" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let result = db
                .get_transcript(&recording_id)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "delete_recording" => {
            let _publish_guard = crate::publishing::IO_GATE.lock().await;
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;

            if params
                .get("deletePublishedFile")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let receipts = {
                    let db = state.db.lock().await;
                    deletable_recording_bundle(&db, &recording_id)?;
                    db.publish_receipts(&recording_id)
                        .map_err(|e| e.to_string())?
                };
                tokio::task::spawn_blocking(move || crate::publishing::delete_published(receipts))
                    .await
                    .map_err(|_| "Couldn't finish removing the published file")?
                    .map_err(|e| e.to_string())?;
            }
            let _storage_guard = state.audio_storage_gate.lock().await;
            let bundle = deletable_recording_bundle(&*state.db.lock().await, &recording_id)?;
            let deletion = remove_owned_recording_audio(&bundle, "recording delete");
            if !deletion.failures.is_empty() {
                return Err(format!(
                    "Could not delete every owned recording audio file. The meeting was kept so deletion can be retried: {}",
                    deletion.failures.join("; ")
                ));
            }

            let mut db = state.db.lock().await;
            db.delete_recording(&recording_id)
                .map_err(|error| error.to_string())?;
            crate::dictation_session::forget_deleted_dictation_results(
                state.as_ref(),
                Some(handle),
                std::slice::from_ref(&recording_id),
            );
            // The rows are gone; the session's in-memory centroids for this
            // meeting have to go with them, or a deleted meeting would still
            // be describable in voice for as long as the app stayed open.
            state
                .session_cluster_voices
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .forget(&recording_id);
            let _ = db.log_audit_event(
                "recording_deleted",
                Some(serde_json::json!({
                    "recording_id": &recording_id,
                    "deleted_audio_files": deletion.deleted_files,
                })),
                "info",
            );
            Ok(serde_json::json!({
                "deletedAudioFiles": deletion.deleted_files,
                "failedAudioFileDeletions": [],
            }))
        }
        "import_audio_file" => {
            // The path comes from the native open dialog in the main Electron
            // process, never from the renderer: `import_audio_file` is not on
            // the renderer command allowlist, so the only caller that can
            // reach here is the one that just showed the user a file picker.
            let path: String = params
                .get("path")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Choose an audio file to import.".to_string())?
                .to_string();
            import_audio_file_impl(state, handle, PathBuf::from(path)).await
        }
        "retranscribe_recording" => {
            // Recovery path for meetings stranded by a crash or transient ASR
            // failure. The bundle resolver below supports both legacy plaintext
            // recordings and the encrypted multi-track storage model.
            let _storage_guard = state.audio_storage_gate.lock().await;
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let recording = {
                let db = state.db.lock().await;
                let recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Recording not found".to_string())?;
                if db
                    .load_open_recording_audio_operation(&recording_id)
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    return Err(
                        "Finish or retry recording audio encryption before re-transcribing this meeting."
                            .to_string(),
                    );
                }
                recording
            };
            match recording.status.as_str() {
                "recording" => {
                    return Err("Stop the meeting before re-transcribing it.".to_string())
                }
                "processing" => {
                    return Err("This meeting is already being transcribed.".to_string())
                }
                _ => {}
            }

            let postprocessing_lease = state.operation_coordinator.try_acquire_named(
                operation_coordinator::OperationKind::PostProcess,
                "meeting retranscription",
            )?;
            // Persisted completion can precede tail cleanup. Claim the whole
            // pipeline before publishing another processing attempt.
            let audio_postprocessing_guard = MeetingAudioPostprocessingGuard::try_coordinated(
                Arc::clone(&state.active_meeting_audio_postprocessing),
                &recording_id,
                postprocessing_lease,
            )?;

            {
                let mut db = state.db.lock().await;
                db.update_recording_status(&recording_id, "processing")
                    .map_err(|e| e.to_string())?;
                let _ = db.log_audit_event(
                    "recording_retranscribe_requested",
                    Some(serde_json::json!({ "recording_id": &recording_id })),
                    "info",
                );
            }
            handle.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "status": "processing",
                    "message": "Processing transcript",
                    "progress": 0.0,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );

            tokio::spawn(run_meeting_transcription_pipeline(
                Arc::clone(state),
                handle.clone(),
                recording_id,
                audio_postprocessing_guard,
            ));
            Ok(serde_json::json!({ "status": "processing" }))
        }
        "rename_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let new_title: String =
                serde_json::from_value(params["newTitle"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.rename_recording(&recording_id, &new_title)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_meeting_chat_messages" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let artifact = db
                .get_meeting_artifact(&recording_id)
                .map_err(|e| e.to_string())?;
            let messages = artifact.map(|a| a.chat_messages).unwrap_or_default();
            serde_json::to_value(messages).map_err(|e| e.to_string())
        }
        "queue_meeting_note_recovery" => {
            let draft: crate::models::MeetingNoteRecoveryDraft =
                serde_json::from_value(params["draft"].clone()).map_err(|e| e.to_string())?;
            state
                .db
                .lock()
                .await
                .queue_meeting_note_recovery(
                    &draft.id,
                    &draft.recording_id,
                    &draft.base_notes,
                    &draft.notes,
                )
                .map_err(|e| e.to_string())?;
            handle.emit_event(
                "meeting-note-recovery-changed",
                serde_json::json!({"recordingId":draft.recording_id}),
            );
            Ok(serde_json::Value::Null)
        }
        "list_meeting_note_recovery" => serde_json::to_value(
            state
                .db
                .lock()
                .await
                .list_meeting_note_recovery()
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "get_meeting_enhanced_note_draft" => {
            let recording_id = params["recordingId"]
                .as_str()
                .ok_or("Missing recordingId")?;
            serde_json::to_value(
                state
                    .db
                    .lock()
                    .await
                    .get_meeting_enhanced_note_draft(recording_id)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "save_meeting_enhanced_note_draft" => {
            let recording_id = params["recordingId"]
                .as_str()
                .ok_or("Missing recordingId")?;
            let draft: crate::models::MeetingEnhancedNoteDraft =
                serde_json::from_value(params["draft"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(
                state
                    .db
                    .lock()
                    .await
                    .save_meeting_enhanced_note_draft(recording_id, &draft)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "delete_meeting_enhanced_note_draft" => {
            let recording_id = params["recordingId"]
                .as_str()
                .ok_or("Missing recordingId")?;
            state
                .db
                .lock()
                .await
                .delete_meeting_enhanced_note_draft(recording_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "update_recording_notes" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let meeting_notes: String = serde_json::from_value(params["meetingNotes"].clone())
                .map_err(|e| e.to_string())?;
            let normalized = meeting_notes.trim().to_string();
            let mut db = state.db.lock().await;
            db.update_recording_notes_recovering_guarded(
                &recording_id,
                if normalized.is_empty() {
                    None
                } else {
                    Some(normalized.as_str())
                },
                params["recoveryDraftId"].as_str(),
                params["expectedMeetingNotes"].as_str(),
            )
            .map_err(|e| e.to_string())?;
            drop(db);
            if params["recoveryDraftId"].as_str().is_some() {
                handle.emit_event(
                    "meeting-note-recovery-changed",
                    serde_json::json!({"recordingId":recording_id}),
                );
            }
            Ok(serde_json::Value::Null)
        }
        "update_recording_analysis" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let normalized_summary: Option<Option<String>> = match params.get("summary") {
                None => None,
                Some(value) => {
                    let summary = serde_json::from_value::<Option<String>>(value.clone())
                        .map_err(|error| format!("Invalid summary patch: {}", error))?;
                    Some(summary.and_then(|summary| {
                        let summary = summary.trim().to_string();
                        (!summary.is_empty()).then_some(summary)
                    }))
                }
            };
            let normalized_items: Option<Vec<String>> = match params.get("actionItems") {
                None => None,
                Some(value) => Some(
                    serde_json::from_value::<Vec<String>>(value.clone())
                        .map_err(|error| format!("Invalid actionItems patch: {}", error))?
                        .into_iter()
                        .filter_map(|item| {
                            let item = item.trim().to_string();
                            (!item.is_empty()).then_some(item)
                        })
                        .collect(),
                ),
            };
            let summary_provenance: Option<models::AnalysisProvenance> = match params
                .get("summaryProvenance")
            {
                None => None,
                Some(value) => Some(
                    serde_json::from_value(value.clone())
                        .map_err(|error| format!("Invalid summaryProvenance patch: {}", error))?,
                ),
            };
            let action_items_provenance: Option<models::ActionItemsProvenance> =
                match params.get("actionItemsProvenance") {
                    None => None,
                    Some(value) => {
                        Some(serde_json::from_value(value.clone()).map_err(|error| {
                            format!("Invalid actionItemsProvenance patch: {}", error)
                        })?)
                    }
                };
            let mut db = state.db.lock().await;
            let recording = db
                .patch_recording_analysis_with_provenance(
                    &recording_id,
                    normalized_summary
                        .as_ref()
                        .map(|summary| summary.as_deref()),
                    normalized_items.as_deref(),
                    summary_provenance.as_ref(),
                    action_items_provenance.as_ref(),
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(recording).map_err(|e| e.to_string())
        }
        "update_recording_template" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let template_id: Option<String> =
                serde_json::from_value(params["meetingTemplateId"].clone())
                    .ok()
                    .flatten();
            let normalized = template_id.and_then(|v| {
                let t = v.trim().to_string();
                if t.is_empty() || t.eq_ignore_ascii_case("auto") {
                    None
                } else {
                    Some(t)
                }
            });
            let mut db = state.db.lock().await;
            db.update_recording_meeting_template(&recording_id, normalized.as_deref())
                .map_err(|e| e.to_string())?;
            drop(db);
            if let Ok(mut templates) = state.recording_templates.lock() {
                match normalized {
                    Some(ref tid) => {
                        templates.insert(recording_id, tid.clone());
                    }
                    None => {
                        templates.remove(&recording_id);
                    }
                }
            }
            Ok(serde_json::Value::Null)
        }
        "prepare_meeting_brief" => prepare_meeting_brief(state.as_ref(), params).await,
        "update_recording_attendees" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            // Absent means "clear the list", which is what removing the last
            // attendee has to mean; a malformed value is an error rather than
            // a silent clear.
            let attendees: Vec<models::MeetingAttendee> = match params.get("attendees") {
                None | Some(serde_json::Value::Null) => Vec::new(),
                Some(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
            };
            let mut db = state.db.lock().await;
            let stored = db
                .update_recording_attendees(&recording_id, attendees)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(stored).map_err(|e| e.to_string())
        }
        "update_meeting_chat_messages" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let messages: Vec<MeetingChatMessageRecord> =
                serde_json::from_value(params["messages"].clone()).map_err(|e| e.to_string())?;
            let normalized: Vec<MeetingChatMessageRecord> = messages
                .into_iter()
                .map(|m| MeetingChatMessageRecord {
                    id: if m.id.trim().is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        m.id.trim().to_string()
                    },
                    role: if m.role.trim().eq_ignore_ascii_case("assistant") {
                        "assistant".to_string()
                    } else {
                        "user".to_string()
                    },
                    content: m.content.trim().to_string(),
                    template_id: m
                        .template_id
                        .and_then(|v| (!v.trim().is_empty()).then(|| v.trim().to_string())),
                    citations: m
                        .citations
                        .into_iter()
                        .filter_map(normalize_meeting_chat_citation)
                        .collect(),
                    created_at: m.created_at,
                })
                .filter(|m| !m.content.is_empty())
                .collect();
            let mut db = state.db.lock().await;
            db.update_recording_meeting_chat(&recording_id, &normalized)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "edit_transcript_speaker_turn" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let segment_ids: Vec<String> =
                serde_json::from_value(params["segmentIds"].clone()).map_err(|e| e.to_string())?;
            let new_text: String =
                serde_json::from_value(params["newText"].clone()).map_err(|e| e.to_string())?;
            let expected_value = params
                .get("expectedSegments")
                .ok_or("Transcript edit expectations are required")?;
            if !expected_value.as_array().is_some_and(|segments| {
                segments
                    .iter()
                    .all(|segment| segment.get("speakerId").is_some())
            }) {
                return Err("Invalid transcript edit expectations".to_string());
            }
            let expected_segments: Vec<TranscriptSegmentExpectation> =
                serde_json::from_value(expected_value.clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.edit_transcript_speaker_turn(
                &recording_id,
                &segment_ids,
                &new_text,
                &expected_segments,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "delete_transcript_segments" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let segment_ids: Vec<String> =
                serde_json::from_value(params["segmentIds"].clone()).map_err(|e| e.to_string())?;
            let expected_segments: Option<Vec<TranscriptSegmentExpectation>> =
                match params.get("expectedSegments") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(value) => {
                        Some(serde_json::from_value(value.clone()).map_err(|e| e.to_string())?)
                    }
                };
            let mut db = state.db.lock().await;
            let removed = match expected_segments.as_deref() {
                Some(expected) => {
                    db.delete_transcript_segments_guarded(&recording_id, &segment_ids, expected)
                }
                None => db.delete_transcript_segments(&recording_id, &segment_ids),
            }
            .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(removed))
        }
        "get_meeting_transcript_details" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let transcript = db
                .get_transcript(&recording_id)
                .map_err(|e| e.to_string())?;
            let artifact = db
                .get_latest_transcript_artifact(&recording_id)
                .map_err(|e| e.to_string())?;
            let diarizer = db
                .get_transcript_diarizer(&recording_id)
                .map_err(|e| e.to_string())?;
            let result =
                build_meeting_transcript_details(transcript.as_ref(), artifact.as_ref(), diarizer);
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_waveform_data" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let audio = state.audio_capture.lock().await;
            let data = audio.get_waveform_data(&recording_id).unwrap_or_default();
            serde_json::to_value(data).map_err(|e| e.to_string())
        }
        "get_meeting_source_levels" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let audio = state.audio_capture.lock().await;
            let levels = audio
                .get_meeting_source_levels(&recording_id)
                .unwrap_or_default();
            serde_json::to_value(levels).map_err(|e| e.to_string())
        }
        "get_recording_waveform" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let points: Option<usize> = params
                .get("points")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let has_audio = {
                let db = state.db.lock().await;
                !db.get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found".to_string())?
                    .audio_path
                    .is_empty()
            };
            if !has_audio {
                return Ok(serde_json::json!([]));
            }
            let resolved = resolve_recording_audio_for_runtime(
                state.as_ref(),
                &recording_id,
                RuntimeAudioResolveMode::PlaybackPrimary,
            )
            .await?;
            let result = crate::audio::waveform::generate_waveform_from_file(
                resolved.primary.to_string_lossy().as_ref(),
                points.unwrap_or(400),
            )
            .map(|data| data.samples)
            .map_err(|error| error.to_string())?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "set_recording_source_type" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let source_type: String =
                serde_json::from_value(params["sourceType"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.update_recording_source_type(&recording_id, &source_type)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "open_recording_audio" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            open_recording_audio_impl(state.as_ref(), &recording_id).await?;
            Ok(serde_json::Value::Null)
        }
        "prepare_recording_playback" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let prepared = prepare_recording_playback_impl(state, handle, &recording_id).await?;
            serde_json::to_value(prepared).map_err(|e| e.to_string())
        }
        "release_recording_playback" => {
            // Two shapes: a token the reader is done with, or — from the
            // privileged process alone, whose prepare failed after the token
            // was minted — every token one recording holds.
            if let Some(recording_id) = params
                .get("recordingId")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                let released =
                    release_recording_playback_for_recording_impl(state.as_ref(), recording_id)
                        .await?;
                return Ok(serde_json::json!({
                    "released": released > 0,
                    "releasedCount": released,
                }));
            }
            let token: String =
                serde_json::from_value(params["token"].clone()).map_err(|e| e.to_string())?;
            let released = release_recording_playback_impl(state.as_ref(), &token).await?;
            Ok(serde_json::json!({ "released": released }))
        }
        "open_export_path" => {
            let target_path: String =
                serde_json::from_value(params["targetPath"].clone()).map_err(|e| e.to_string())?;
            open_export_path_impl(&target_path)?;
            Ok(serde_json::Value::Null)
        }

        // ── Analysis / LLM ─────────────────────────────────────────────────
        // The sidecar binary intercepts this command and aborts the task keyed by
        // runId before dispatch. Keeping a no-op arm here preserves the command
        // contract for direct library callers and IPC contract verification.
        "cancel_analysis_run" => Ok(serde_json::Value::Null),
        "get_ollama_status" => {
            let available = state.ollama_client.is_available().await;
            Ok(serde_json::json!(available))
        }
        "get_local_text_runtime_health" => {
            let local_gate_applies = match params.get("modelId") {
                None => Some(true),
                Some(value) => {
                    let model_id = value.as_str().ok_or("modelId must be a string")?.trim();
                    if model_id.is_empty() {
                        return Err("modelId must not be empty".into());
                    }
                    state.ollama_client.local_gate_applicability(model_id).await
                }
            };
            Ok(
                serde_json::json!({ "runtimeHealth": llm::native_text::runtime_health(), "localGateApplies": local_gate_applies }),
            )
        }
        "list_ollama_models" => {
            let result = state
                .ollama_client
                .list_models()
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_ollama_model_catalog" => {
            let result = state
                .ollama_client
                .catalog()
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_curated_ollama_model_catalog" => {
            serde_json::to_value(state.ollama_client.curated_catalog()).map_err(|e| e.to_string())
        }
        "install_ollama_model" => {
            let model_id = params
                .get("modelId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "modelId is required".to_string())?;
            let accepted_license = params
                .get("acceptedLicense")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            state
                .ollama_pull_active
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| "Another Ollama model installation is already running".to_string())?;
            state.ollama_pull_cancelled.store(false, Ordering::SeqCst);
            // IPC cancellation aborts this dispatch future, so cleanup must run
            // from Drop rather than only after the pull future completes.
            let _active_guard = OllamaPullActiveGuard(Arc::clone(&state.ollama_pull_active));
            let event_handle = handle.clone();
            let result = state.ollama_client.pull_model(model_id, accepted_license, &state.ollama_pull_cancelled, &state.ollama_pull_cancel_notify, move |completed, total| {
                event_handle.emit_event("ollama-model-pull-progress", serde_json::json!({
                    "modelId": model_id, "completedBytes": completed, "totalBytes": total,
                    "percentage": total.filter(|total| *total > 0).map(|total| completed.saturating_mul(100) / total),
                }));
            }).await;
            let entry = result.map_err(|e| e.to_string())?;
            serde_json::to_value(entry).map_err(|e| e.to_string())
        }
        "cancel_ollama_model_install" => {
            let was_active = state.ollama_pull_active.load(Ordering::SeqCst);
            state.ollama_pull_cancelled.store(true, Ordering::SeqCst);
            if was_active {
                state.ollama_pull_cancel_notify.notify_one();
            }
            Ok(serde_json::json!({ "cancelled": was_active }))
        }
        "list_ollama_cloud_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_ollama_cloud_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_openai_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_openai_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_chatgpt_plan_status" => {
            let result = chatgpt_plan_status().await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_chatgpt_plan_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_chatgpt_plan_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_anthropic_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_anthropic_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_gemini_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_gemini_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_deepseek_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_deepseek_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_embedding_status" => embedding_status(state.as_ref()).await,
        "download_embedding_model" => {
            let model_id: String = serde_json::from_value(params["modelId"].clone())
                .map_err(|_| "modelId must be a string".to_string())?;
            let model = llm::builtin_embeddings::model(&model_id).ok_or("Unknown search model")?;
            let root =
                llm::builtin_embeddings::models_root().ok_or("Could not find the models folder")?;
            let acceptances = state
                .settings_manager
                .lock()
                .await
                .settings()
                .transcription
                .builtin_embedding_terms_acceptances
                .clone();
            let progress_handle = handle.clone();
            let progress_name = format!("{}/{}", llm::builtin_embeddings::MODEL_DIR_NAME, model.id);
            llm::builtin_embeddings::download(&root, model, &acceptances, move |percentage| {
                progress_handle.emit_event(
                    "model-download-progress",
                    serde_json::json!({ "modelName": progress_name, "percentage": percentage }),
                );
            })
            .await
            .map_err(|error| error.to_string())?;
            crate::semantic_index::request_index();
            embedding_status(state.as_ref()).await
        }
        // The user clicked through the terms the renderer showed for this
        // model. The sidecar stamps the time and refuses terms other than the
        // ones this build names, so an acceptance always says what was shown.
        "accept_embedding_model_terms" => {
            let model_id: String = serde_json::from_value(params["modelId"].clone())
                .map_err(|_| "modelId must be a string".to_string())?;
            let terms_url: String = serde_json::from_value(params["termsUrl"].clone())
                .map_err(|_| "termsUrl must be a string".to_string())?;
            let model = llm::builtin_embeddings::model(&model_id).ok_or("Unknown search model")?;
            if !model.requires_terms_acceptance {
                return Err(format!("{} has no terms to accept.", model.display_name));
            }
            if terms_url != model.terms_url {
                return Err(format!(
                    "Those are not the terms {} comes under.",
                    model.display_name
                ));
            }
            state
                .settings_manager
                .lock()
                .await
                .record_embedding_terms_acceptance(model.id, model.terms_url)
                .map_err(|error| error.to_string())?;
            crate::semantic_index::request_index();
            embedding_status(state.as_ref()).await
        }
        "cancel_embedding_model_download" => {
            llm::builtin_embeddings::cancel_download();
            Ok(serde_json::Value::Null)
        }
        "delete_embedding_model" => {
            let model_id: String = serde_json::from_value(params["modelId"].clone())
                .map_err(|_| "modelId must be a string".to_string())?;
            let model = llm::builtin_embeddings::model(&model_id).ok_or("Unknown search model")?;
            let root =
                llm::builtin_embeddings::models_root().ok_or("Could not find the models folder")?;
            if llm::builtin_embeddings::download_active() {
                return Err(
                    "Wait for the search model download to finish, or cancel it, first."
                        .to_string(),
                );
            }
            let _rebuild = crate::semantic_index::EMBEDDING_REBUILD
                .acquire()
                .await
                .map_err(|error| error.to_string())?;
            llm::builtin_embeddings::delete(&root, model)
                .await
                .map_err(|error| error.to_string())?;
            state
                .db
                .lock()
                .await
                .delete_embeddings_with_model(&crate::semantic_index::index_key(
                    crate::semantic_index::SemanticRoute::BuiltIn(model.id),
                ))
                .map_err(|error| error.to_string())?;
            embedding_status(state.as_ref()).await
        }
        "search_transcripts" => {
            let query: String =
                serde_json::from_value(params["query"].clone()).map_err(|e| e.to_string())?;
            let trimmed = query.trim().to_string();
            if trimmed.is_empty() {
                return Ok(serde_json::json!([]));
            }
            let limit: Option<usize> = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let project_ids: Option<Vec<String>> =
                serde_json::from_value(params["projectIds"].clone()).ok();
            let source_type = match params.get("sourceType") {
                None | Some(serde_json::Value::Null) => None,
                Some(value) => {
                    let source_type: String =
                        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                    if !matches!(source_type.as_str(), "meeting" | "dictation") {
                        return Err("sourceType must be 'meeting' or 'dictation'".to_string());
                    }
                    Some(source_type)
                }
            };
            let recording_status = match params.get("recordingStatus") {
                None | Some(serde_json::Value::Null) => None,
                Some(value) => {
                    let recording_status: String =
                        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                    if !matches!(
                        recording_status.as_str(),
                        "completed" | "recording" | "processing" | "error"
                    ) {
                        return Err(
                            "recordingStatus must be 'completed', 'recording', 'processing', or 'error'"
                                .to_string(),
                        );
                    }
                    Some(recording_status)
                }
            };
            let db = state.db.lock().await;
            let result = db
                .search_transcripts_with_filters(
                    &trimmed,
                    limit.unwrap_or(20).min(200),
                    project_ids.as_deref(),
                    source_type.as_deref(),
                    recording_status.as_deref(),
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "analyze_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let query: String =
                serde_json::from_value(params["query"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let run_id = params
                .get("runId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let result = run_grounded_response_query_for_recording(
                state.as_ref(),
                &recording_id,
                &query,
                model.as_deref(),
                Some(analysis_progress_callback(
                    handle,
                    &recording_id,
                    "ask",
                    run_id.as_deref(),
                )),
            )
            .await
            .inspect_err(|error| {
                emit_analysis_failure(handle, &recording_id, "ask", run_id.as_deref(), error);
            })?;
            let mut db = state.db.lock().await;
            let _ = db.log_audit_event("analysis_completed", Some(serde_json::json!({ "recording_id": &recording_id, "query_chars": query.chars().count(), "model": &result.model, "citation_count": result.citations.len(), "grounded": result.grounded })), "info");
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "analyze_recordings" => {
            let recording_ids = validate_and_deduplicate_analysis_recording_ids(
                serde_json::from_value(params["recordingIds"].clone())
                    .map_err(|e| e.to_string())?,
            )?;
            let query: String =
                serde_json::from_value(params["query"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let context_segments = {
                let db = state.db.lock().await;
                let mut segments = Vec::new();
                let mut transcript_bytes = 0usize;
                for recording_id in &recording_ids {
                    let transcript = db
                        .get_transcript(recording_id)
                        .map_err(|error| error.to_string())?
                        .ok_or("Selected recording transcript is missing")?;
                    if transcript.segments.is_empty() {
                        return Err("Selected recording transcript contains no segments".into());
                    }
                    for segment in select_recording_ask_segments(recording_id, transcript.segments)
                    {
                        transcript_bytes = transcript_bytes
                            .checked_add(segment.text.len())
                            .ok_or("Selected transcripts exceed analysis limits")?;
                        enforce_multi_recording_analysis_limits(
                            segments.len() + 1,
                            transcript_bytes,
                        )?;
                        segments.push(segment);
                    }
                }
                segments
            };
            if context_segments.is_empty() {
                return Err("No transcript context found for selected recordings".to_string());
            }
            let result = run_grounded_ask_for_selected_segments(
                state.as_ref(),
                context_segments,
                &query,
                model.as_deref(),
                crate::analysis::StaleAskSources::Fail,
            )
            .await?;
            let mut db = state.db.lock().await;
            let _ = db.log_audit_event("analysis_multi_recording_completed", Some(serde_json::json!({ "recording_ids": &recording_ids, "query_chars": query.chars().count(), "model": &result.model, "citation_count": result.citations.len(), "grounded": result.grounded })), "info");
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "register_capture_admission" => {
            // Called by Electron's CaptureAdmissionController the moment it
            // mints a nonce, before that nonce is handed to `start_recording`.
            // Registering is what turns the nonce from "a UUID" into proof only
            // the privileged side could have produced.
            let nonce: String =
                serde_json::from_value(params["nonce"].clone()).map_err(|e| e.to_string())?;
            uuid::Uuid::parse_str(&nonce)
                .map_err(|_| "Capture admission nonce is not a valid UUID".to_string())?;
            state.capture_admission.register(&nonce);
            Ok(serde_json::json!({ "registered": true }))
        }
        "retry_meeting_analysis" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;

            // Refuse a retry for a meeting that has no transcript to analyse
            // rather than emitting a running/failed pair that tells the user
            // nothing they can act on.
            let transcript_is_analysable = {
                let db = state.db.lock().await;
                db.get_transcript(&recording_id)
                    .map_err(|error| error.to_string())?
                    .is_some_and(|transcript| !transcript.full_text.trim().is_empty())
            };
            if !transcript_is_analysable {
                return Err(
                    "This meeting has no transcript text to analyze. Re-transcribe it first."
                        .to_string(),
                );
            }

            // Recover missing stages without replacing saved analysis. A
            // retry that has to wait for memory keeps trying on its own.
            run_meeting_analysis_until_written(
                state,
                handle,
                &recording_id,
                MeetingAnalysisMode::MissingOnly,
            )
            .await;

            let recording = {
                let db = state.db.lock().await;
                db.get_recording(&recording_id)
                    .map_err(|error| error.to_string())?
            };
            match recording {
                Some(recording) => serde_json::to_value(recording).map_err(|e| e.to_string()),
                None => Err(format!("Recording '{}' no longer exists.", recording_id)),
            }
        }
        "cancel_meeting_notes_wait" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            // Awaited before the notice is written, so a pass that was running
            // cannot report progress or save notes after this reply.
            let mut cancelled = analysis::cancel_memory_wait(&recording_id).await;
            let mut db = state.db.lock().await;
            if db
                .get_recording(&recording_id)
                .map_err(|error| error.to_string())?
                .is_some_and(|recording| {
                    recording.analysis_failure.as_deref() == Some(analysis::MEMORY_WAIT_NOTICE)
                })
            {
                db.set_recording_analysis_failure(
                    &recording_id,
                    Some(llm::notes_queue::CANCELLED_NOTICE),
                )
                .map_err(|error| error.to_string())?;
                cancelled = true;
            }
            Ok(serde_json::json!({ "cancelled": cancelled }))
        }
        "summarize_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let grounded = summarize_recording_grounded_internal(
                state.as_ref(),
                &recording_id,
                model.as_deref(),
                Some(analysis_progress_callback(
                    handle,
                    &recording_id,
                    "summary",
                    None,
                )),
            )
            .await
            .inspect_err(|error| {
                emit_analysis_failure(handle, &recording_id, "summary", None, error);
            })?;
            let recording = persist_grounded_summary(state.as_ref(), &recording_id, &grounded)
                .await
                .inspect_err(|error| {
                    emit_analysis_failure(handle, &recording_id, "summary", None, error);
                })?;
            emit_analysis_ready(handle, &recording, "summary");
            Ok(serde_json::json!(grounded.summary))
        }
        "summarize_recording_grounded" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let persist = params
                .get("persist")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let run_id = params.get("runId").and_then(serde_json::Value::as_str);
            let result = summarize_recording_grounded_internal(
                state.as_ref(),
                &recording_id,
                model.as_deref(),
                Some(analysis_progress_callback(
                    handle,
                    &recording_id,
                    "summary",
                    run_id,
                )),
            )
            .await
            .inspect_err(|error| {
                emit_analysis_failure(handle, &recording_id, "summary", run_id, error);
            })?;
            if persist {
                let recording = persist_grounded_summary(state.as_ref(), &recording_id, &result)
                    .await
                    .inspect_err(|error| {
                        emit_analysis_failure(handle, &recording_id, "summary", run_id, error);
                    })?;
                emit_analysis_ready(handle, &recording, "summary");
            }
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_summary_regeneration_undo" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let undo_token = state
                .db
                .lock()
                .await
                .summary_regeneration_undo_token(&recording_id)
                .map_err(|error| error.to_string())?;
            Ok(match undo_token {
                Some(undo_token) => {
                    serde_json::json!({ "canUndo": true, "undoToken": undo_token })
                }
                None => serde_json::json!({ "canUndo": false }),
            })
        }
        "undo_summary_regeneration" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let undo_token: String = serde_json::from_value(params["undoToken"].clone())
                .map_err(|_| "undoToken is required".to_string())?;
            let recording =
                undo_summary_regeneration_with_current_input(state, &recording_id, &undo_token)
                    .await?;
            emit_analysis_ready(handle, &recording, "summary");
            serde_json::to_value(recording).map_err(|error| error.to_string())
        }
        "extract_action_items" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let persist = params
                .get("persist")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let run_id = params
                .get("runId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let grounded = extract_action_items_grounded_internal(
                state.as_ref(),
                &recording_id,
                model.as_deref(),
                Some(analysis_progress_callback(
                    handle,
                    &recording_id,
                    "actionItems",
                    run_id.as_deref(),
                )),
            )
            .await
            .inspect_err(|error| {
                emit_analysis_failure(
                    handle,
                    &recording_id,
                    "actionItems",
                    run_id.as_deref(),
                    error,
                );
            })?;
            if persist {
                let recording =
                    persist_grounded_action_items(state.as_ref(), &recording_id, &grounded)
                        .await
                        .inspect_err(|error| {
                            emit_analysis_failure(
                                handle,
                                &recording_id,
                                "actionItems",
                                run_id.as_deref(),
                                error,
                            );
                        })?;
                emit_analysis_ready(handle, &recording, "actionItems");
            }
            let items: Vec<llm::ActionItem> = grounded
                .items
                .into_iter()
                .map(|item| llm::ActionItem {
                    task: item.task,
                    assignee: item.assignee,
                    deadline: item.deadline,
                })
                .collect();
            serde_json::to_value(items).map_err(|e| e.to_string())
        }
        "extract_action_items_grounded" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let model: Option<String> = serde_json::from_value(params["model"].clone())
                .ok()
                .flatten();
            let persist = params
                .get("persist")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let run_id = params
                .get("runId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let result = extract_action_items_grounded_internal(
                state.as_ref(),
                &recording_id,
                model.as_deref(),
                Some(analysis_progress_callback(
                    handle,
                    &recording_id,
                    "actionItems",
                    run_id.as_deref(),
                )),
            )
            .await
            .inspect_err(|error| {
                emit_analysis_failure(
                    handle,
                    &recording_id,
                    "actionItems",
                    run_id.as_deref(),
                    error,
                );
            })?;
            if persist {
                let recording =
                    persist_grounded_action_items(state.as_ref(), &recording_id, &result)
                        .await
                        .inspect_err(|error| {
                            emit_analysis_failure(
                                handle,
                                &recording_id,
                                "actionItems",
                                run_id.as_deref(),
                                error,
                            );
                        })?;
                emit_analysis_ready(handle, &recording, "actionItems");
            }
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "ask_memory" => {
            // Covers the question's embedding as well as the answer, so
            // background indexing yields the runtime for both.
            let _foreground = crate::llm::local_model_load::foreground_work();
            let query: String =
                serde_json::from_value(params["query"].clone()).map_err(|e| e.to_string())?;
            // What to look for, when the question arrives wrapped in a
            // follow-up thread or a meeting's summary. Searching the whole
            // prompt cut the new question off the end of the 512-token query
            // embedding and OR-ed every word of the thread into word search.
            let search_query = match params.get("searchQuery") {
                Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
                    value.trim().to_string()
                }
                _ => query.clone(),
            };
            let exclude_recording_id = match params.get("excludeRecordingId") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value)) => {
                    let value = value.trim();
                    (!value.is_empty()).then(|| value.to_string())
                }
                Some(_) => return Err("excludeRecordingId must be a string".to_string()),
            };
            let source_type = match params.get("sourceType") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value)) => {
                    let value = value.trim().to_ascii_lowercase();
                    match value.as_str() {
                        "" => None,
                        "meeting" | "dictation" => Some(value),
                        _ => {
                            return Err(
                                "sourceType must be either 'meeting' or 'dictation'".to_string()
                            )
                        }
                    }
                }
                Some(_) => return Err("sourceType must be a string".to_string()),
            };
            let route = {
                let sm = state.settings_manager.lock().await;
                crate::semantic_index::ActiveRoute::from_settings(&sm.settings().transcription)
            };
            let mut semantic_windows: Vec<AnalysisContextSegment> = Vec::new();
            // The current index, or an Ollama index from before windows
            // (one raw-text vector per transcript row), which keeps answering
            // until it is rebuilt.
            let mut indexed_key: Option<(String, bool)> = None;
            if let Some(route) = route.as_ref() {
                let db = state.db.lock().await;
                for (key, legacy) in std::iter::once((route.key(), false))
                    .chain(route.legacy_key().map(|key| (key, true)))
                {
                    if db
                        .has_embeddings_with_scope(
                            &key,
                            exclude_recording_id.as_deref(),
                            source_type.as_deref(),
                        )
                        .map_err(|error| error.to_string())?
                    {
                        indexed_key = Some((key, legacy));
                        break;
                    }
                }
            }
            if let (Some(route), Some((key, legacy))) = (route.as_ref(), indexed_key.as_ref()) {
                let _search = crate::semantic_index::SearchInFlight::begin();
                let limit = if *legacy {
                    30
                } else {
                    crate::semantic_index::RANKED_CANDIDATES
                };
                let query_vector = crate::semantic_index::embed_texts(
                    state.as_ref(),
                    route,
                    llm::builtin_embeddings::TextRole::Query,
                    std::slice::from_ref(&search_query),
                    *legacy,
                    Duration::from_secs(20),
                )
                .await
                .ok()
                .and_then(|mut vectors| vectors.pop());
                if let Some(query_vector) = query_vector {
                    if let Ok(hits) = crate::semantic_search::search_embeddings_shared(
                        state.db.as_ref(),
                        &query_vector,
                        limit,
                        key,
                        exclude_recording_id.as_deref(),
                        source_type.as_deref(),
                    )
                    .await
                    {
                        semantic_windows.extend(hits.into_iter().map(|hit| {
                            AnalysisContextSegment {
                                recording_id: hit.recording_id,
                                segment_id: hit.segment_id,
                                text: hit.text,
                                start_time: hit.start_time,
                                end_time: hit.end_time,
                            }
                        }));
                    }
                }
            }
            // Word search runs too, and the two rankings are fused, so exact
            // names and numbers still surface from indexed recordings and
            // recordings the index does not cover yet are still found. Its
            // hits are single transcript rows (often single words), so each
            // is widened to the window holding it: the stored window for an
            // indexed recording, so one passage found both ways counts once.
            let word_windows = {
                let db = state.db.lock().await;
                let hits = db
                    .search_transcripts_with_scope(
                        &search_query,
                        200,
                        exclude_recording_id.as_deref(),
                        source_type.as_deref(),
                    )
                    .map_err(|error| error.to_string())?;
                let current_key = indexed_key
                    .as_ref()
                    .filter(|(_, legacy)| !legacy)
                    .map(|(key, _)| key.as_str());
                crate::semantic_index::hits_to_windows(
                    &db,
                    &hits,
                    crate::semantic_index::RANKED_CANDIDATES,
                    current_key,
                )
                .map_err(|error| error.to_string())?
            };
            let context_segments = crate::semantic_index::fuse_rankings(
                &semantic_windows,
                &word_windows,
                crate::semantic_index::SEMANTIC_HITS,
                crate::semantic_index::KEPT_WORD_HITS,
            );
            if context_segments.is_empty() {
                if source_type.as_deref() == Some("meeting") && exclude_recording_id.is_some() {
                    return Err(
                        "No related transcripts from other meetings were found.".to_string()
                    );
                }
                return Err(
                    "Nothing in your recordings matched that question. Try other words, such as a name or topic that was said."
                        .to_string()
                );
            }
            let result = run_grounded_ask_for_selected_segments(
                state.as_ref(),
                context_segments,
                &query,
                None,
                crate::analysis::StaleAskSources::Drop,
            )
            .await?;
            let mut db = state.db.lock().await;
            let _ = db.log_audit_event("memory_query", Some(serde_json::json!({ "query_chars": query.chars().count(), "model": &result.model, "citation_count": result.citations.len(), "grounded": result.grounded })), "info");
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_relationship_memory" => {
            // Cap how many transcripts are loaded and parsed per call:
            // recordings come back newest-first, and without a cap this scan
            // grows linearly with the lifetime meeting library on every
            // meetings-view mount.
            const RELATIONSHIP_MEMORY_MAX_RECORDINGS: usize = 100;
            let sources = {
                let db = state.db.lock().await;
                let recordings = db.get_recordings(None).map_err(|e| e.to_string())?;
                let mut sources =
                    Vec::with_capacity(recordings.len().min(RELATIONSHIP_MEMORY_MAX_RECORDINGS));
                for recording in recordings
                    .into_iter()
                    .take(RELATIONSHIP_MEMORY_MAX_RECORDINGS)
                {
                    let transcript = db
                        .get_transcript(&recording.id)
                        .map_err(|e| e.to_string())?;
                    let speaker_aliases = db
                        .get_speaker_aliases(&recording.id)
                        .map_err(|e| e.to_string())?;
                    sources.push(RelationshipMemorySource {
                        recording,
                        transcript,
                        speaker_aliases,
                    });
                }
                sources
            };
            let result = build_relationship_memory(&sources);
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "reindex_embeddings" => {
            let _rebuild = crate::semantic_index::EMBEDDING_REBUILD
                .try_acquire()
                .map_err(|_| "Search indexing is already running.".to_string())?;
            let route = {
                let sm = state.settings_manager.lock().await;
                let transcription = &sm.settings().transcription;
                crate::semantic_index::ActiveRoute::from_settings(transcription).ok_or_else(
                    || {
                        if transcription.memory_search_mode == crate::semantic_index::MODE_BUILT_IN
                        {
                            format!(
                                "Accept the terms for {} in Settings first.",
                                llm::builtin_embeddings::model_or_default(
                                    &transcription.builtin_embedding_model
                                )
                                .display_name
                            )
                        } else {
                            "Choose meaning search in Settings first.".to_string()
                        }
                    },
                )?
            };
            match &route {
                crate::semantic_index::ActiveRoute::Ollama(_) => {
                    if !state.ollama_embedder.is_available().await {
                        return Err(
                            "Ollama is not running. Start Ollama and try again.".to_string()
                        );
                    }
                }
                crate::semantic_index::ActiveRoute::BuiltIn(model) => {
                    let root = llm::builtin_embeddings::models_root()
                        .ok_or("Could not find the models folder")?;
                    if !llm::builtin_embeddings::artifacts_installed(&root, model) {
                        return Err(format!(
                            "Download {} in Settings first.",
                            model.display_name
                        ));
                    }
                    // The built-in route rebuilds in the background worker,
                    // with its pauses and battery rules; progress arrives as
                    // `semantic-index-progress` events.
                    state
                        .db
                        .lock()
                        .await
                        .delete_embeddings_with_model(&route.key())
                        .map_err(|error| error.to_string())?;
                    crate::semantic_index::request_rebuild();
                    return Ok(serde_json::json!({
                        "recordings": 0, "segments": 0, "errors": 0, "background": true
                    }));
                }
            }
            let key = route.key();
            let (sources, source_signature) = {
                let db = state.db.lock().await;
                let signature = db.begin_embedding_rebuild().map_err(|e| e.to_string())?;
                let mut sources = Vec::new();
                for recording in db.get_recordings(None).map_err(|e| e.to_string())? {
                    if let Some((transcript, _)) = db
                        .get_transcript_with_revision(&recording.id)
                        .map_err(|e| e.to_string())?
                    {
                        let windows = crate::semantic_index::estimated_windows(
                            &recording.id,
                            &transcript.segments,
                        );
                        sources.push(windows);
                    }
                }
                if !db
                    .embedding_sources_unchanged(&signature)
                    .map_err(|e| e.to_string())?
                {
                    return Err("Meetings changed while preparing the index. The existing index was kept. Try again.".to_string());
                }
                (sources, signature)
            };
            let run_id = uuid::Uuid::new_v4().to_string();
            let total_recordings = sources.len();
            let mut total_segments = 0usize;
            let errors = 0usize;
            for (idx, windows) in sources.iter().enumerate() {
                if windows.is_empty() {
                    continue;
                }
                let texts: Vec<String> = windows.iter().map(|window| window.text.clone()).collect();
                match crate::semantic_index::embed_texts(
                    state.as_ref(),
                    &route,
                    llm::builtin_embeddings::TextRole::Document,
                    &texts,
                    false,
                    Duration::from_secs(30),
                )
                .await
                {
                    Ok(embeddings) if embeddings.len() == windows.len() => {
                        let db = state.db.lock().await;
                        for (window, embedding) in windows.iter().zip(embeddings.iter()) {
                            if let Err(error) = db.stage_embedding(
                                &run_id,
                                &window.recording_id,
                                &window.segment_id,
                                &window.text,
                                embedding,
                                &key,
                                window.start_time,
                                window.end_time,
                            ) {
                                let _ = db.discard_embedding_rebuild(&run_id);
                                return Err(format!("The search index was not changed: {error}"));
                            }
                            total_segments += 1;
                        }
                    }
                    Ok(_) => {
                        let db = state.db.lock().await;
                        let _ = db.discard_embedding_rebuild(&run_id);
                        return Err("The search index was not changed: the model returned the wrong number of vectors.".to_string());
                    }
                    Err(error) => {
                        let db = state.db.lock().await;
                        let _ = db.discard_embedding_rebuild(&run_id);
                        return Err(format!("The search index was not changed: {error}"));
                    }
                }
                handle.emit_event("reindex-embeddings-progress", serde_json::json!({ "current": idx + 1, "total": total_recordings, "segments": total_segments }));
            }
            let route_unchanged = {
                let sm = state.settings_manager.lock().await;
                crate::semantic_index::ActiveRoute::from_settings(&sm.settings().transcription)
                    .map(|current| current.key())
                    == Some(key.clone())
            };
            let mut db = state.db.lock().await;
            if !route_unchanged {
                let _ = db.discard_embedding_rebuild(&run_id);
                return Err(
                    "The search model changed. The existing search index was kept. Try again."
                        .to_string(),
                );
            }
            if let Err(error) =
                db.commit_embedding_rebuild(&run_id, &source_signature, total_segments)
            {
                let _ = db.discard_embedding_rebuild(&run_id);
                return Err(format!("The search index was not changed: {error}"));
            }
            Ok(
                serde_json::json!({ "recordings": total_recordings, "segments": total_segments, "errors": errors }),
            )
        }

        // ── ASR ────────────────────────────────────────────────────────────
        "get_asr_providers" => {
            let result = state.asr_manager.get_all_providers_info().await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_asr_provider_inventory" => {
            let result = state.asr_manager.get_provider_inventory().await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_speech_model_download_notice" => speech_model_download_notice(),
        "get_asr_runtime_diagnostics" => {
            let request = parse_asr_runtime_diagnostics_request(params)?;
            let result = match request.model_id.as_deref() {
                Some(model_id) => {
                    state
                        .asr_manager
                        .get_runtime_diagnostics_for_model(request.provider_type, model_id)
                        .await
                }
                None => {
                    state
                        .asr_manager
                        .get_runtime_diagnostics(request.provider_type)
                        .await
                }
            };
            let mut result = serde_json::to_value(result).map_err(|e| e.to_string())?;
            if let Some(model_id) = request.model_id {
                result["selectedModelId"] = serde_json::json!(model_id);
            }
            Ok(result)
        }

        "get_default_asr_provider" => {
            let result = state.asr_manager.get_default_provider().await;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_asr_provider_model" => {
            let provider_type: asr::AsrProviderType =
                serde_json::from_value(params["providerType"].clone())
                    .map_err(|e| e.to_string())?;
            let result = state.asr_manager.provider_model_id(provider_type).await;
            Ok(serde_json::json!(result))
        }
        "get_asr_provider_model_options" => {
            let provider_type: asr::AsrProviderType =
                serde_json::from_value(params["providerType"].clone())
                    .map_err(|e| e.to_string())?;
            let options = provider_type.model_options();
            serde_json::to_value(options).map_err(|e| e.to_string())
        }
        "refresh_asr_runtime_probes" => {
            asr::platform::macos_speech::invalidate_readiness_cache();
            state.asr_manager.clear_runtime_errors().await;
            Ok(serde_json::Value::Null)
        }
        "repair_local_model_cache" => {
            let models_root = crate::paths::data_dir()
                .ok_or_else(|| "Could not find data directory".to_string())?
                .join("Plainsong")
                .join("models");
            repair_local_model_cache_at(&models_root);
            state.asr_manager.clear_runtime_errors().await;
            Ok(serde_json::json!({ "ok": true }))
        }
        "download_asr_models" => {
            let provider_type: asr::AsrProviderType =
                serde_json::from_value(params["providerType"].clone())
                    .map_err(|e| e.to_string())?;
            let model_id = params
                .get("modelId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let handle_clone = handle.clone();
            let cb: Box<dyn Fn(f32) + Send + Sync> = Box::new(move |progress| {
                handle_clone.emit_event(
                    "asr-download-progress",
                    serde_json::json!([provider_type, progress]),
                );
            });
            let result = state
                .asr_manager
                .download_models(provider_type, model_id.as_deref(), cb)
                .await;
            // Progress can reach 100 before provider readiness is invalidated.
            // This signal follows the authoritative cache update, including failures.
            handle.emit_event(
                "readiness-invalidated",
                serde_json::json!({
                    "reason": "asr-download-finished", "providerType": provider_type
                }),
            );
            result.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "list_asr_benchmarks" => {
            let limit: Option<usize> = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let db = state.db.lock().await;
            let result = db
                .list_asr_benchmarks(limit.unwrap_or(50))
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "benchmark_asr_providers" => {
            let audio_path: String = serde_json::from_value(params["testAudioPath"].clone())
                .map_err(|e| e.to_string())?;
            let path = std::path::PathBuf::from(audio_path);
            let results = state.asr_manager.benchmark_providers(&path).await;
            persist_benchmark_results(state.as_ref(), &results).await;
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        "benchmark_asr_providers_bytes" => {
            let audio_bytes = benchmark_audio_bytes_from_params(&params)?;
            let results = state
                .asr_manager
                .benchmark_providers_bytes(audio_bytes)
                .await;
            persist_benchmark_results(state.as_ref(), &results).await;
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        "set_default_asr_provider" => {
            let provider_type: asr::AsrProviderType =
                serde_json::from_value(params["providerType"].clone())
                    .map_err(|e| e.to_string())?;
            if !asr::AsrManager::is_provider_transcription_enabled(provider_type) {
                return Err(format!(
                    "{} can't run in this version of Plainsong.",
                    provider_type.speech_model_name(provider_type.default_model_id())
                ));
            }
            let mut settings_manager = state.settings_manager.lock().await;
            let mut candidate = settings_manager.settings().clone();
            let provider_key = asr_provider_to_settings_value(provider_type).to_string();
            let selected_model = normalize_asr_model_id(
                provider_type,
                candidate
                    .transcription
                    .provider_model_ids
                    .get(&provider_key)
                    .map(String::as_str)
                    .unwrap_or_else(|| provider_type.default_model_id()),
            );
            let diagnostics = state
                .asr_manager
                .get_runtime_diagnostics_for_model(provider_type, &selected_model)
                .await;
            let provider_available =
                asr::AsrProviderFactory::create_with_model(provider_type, Some(&selected_model))
                    .is_available();
            if !matches!(
                diagnostics.runtime_status,
                asr::manager::RuntimeStatus::Ready
            ) || !provider_available
            {
                let runtime_message = diagnostics
                    .runtime_message
                    .unwrap_or_else(|| "It isn't set up yet.".to_string());
                let setup_action = diagnostics
                    .runtime_details
                    .setup_action
                    .unwrap_or_else(|| "Finish its setup in Settings > Models.".to_string());
                return Err(format!(
                    "{} isn't ready to use. {} {}",
                    provider_type.speech_model_name(&selected_model),
                    runtime_message,
                    setup_action
                ));
            }
            candidate.transcription.default_provider = provider_key.clone();
            candidate.transcription.selected_model_id = selected_model.clone();
            candidate
                .transcription
                .provider_model_ids
                .insert(provider_key.clone(), selected_model.clone());
            if settings_manager
                .settings()
                .transcription
                .use_shared_asr_selection
            {
                candidate.transcription.dictation_provider = provider_key.clone();
                candidate.transcription.dictation_model_id = selected_model.clone();
                candidate.transcription.meeting_provider = provider_key;
                candidate.transcription.meeting_model_id = selected_model;
            }
            normalize_contextual_asr_settings(&mut candidate.transcription);
            settings_manager
                .commit_candidate(candidate)
                .map_err(|e| e.to_string())?;
            state
                .asr_manager
                .set_provider_model_id(
                    provider_type,
                    settings_manager
                        .settings()
                        .transcription
                        .selected_model_id
                        .clone(),
                )
                .await;
            state.asr_manager.set_default_provider(provider_type).await;
            Ok(serde_json::Value::Null)
        }
        "set_asr_provider_model" => {
            let provider_type: asr::AsrProviderType =
                serde_json::from_value(params["providerType"].clone())
                    .map_err(|e| e.to_string())?;
            let model_id: String =
                serde_json::from_value(params["modelId"].clone()).map_err(|e| e.to_string())?;
            let normalized_model_id = normalize_asr_model_id(provider_type, &model_id);
            let provider_key = asr_provider_to_settings_value(provider_type).to_string();
            let mut settings_manager = state.settings_manager.lock().await;
            let mut candidate = settings_manager.settings().clone();
            candidate
                .transcription
                .provider_model_ids
                .insert(provider_key.clone(), normalized_model_id.clone());
            if let Some(default_provider) = asr_provider_from_settings_value(
                &settings_manager.settings().transcription.default_provider,
            ) {
                if default_provider == provider_type {
                    candidate.transcription.selected_model_id = normalized_model_id.clone();
                }
            }
            if settings_manager
                .settings()
                .transcription
                .use_shared_asr_selection
            {
                if let Some(default_provider) = asr_provider_from_settings_value(
                    &settings_manager.settings().transcription.default_provider,
                ) {
                    if default_provider == provider_type {
                        candidate.transcription.dictation_model_id = normalized_model_id.clone();
                        candidate.transcription.meeting_model_id = normalized_model_id.clone();
                    }
                }
                if settings_manager.settings().transcription.dictation_provider == provider_key {
                    candidate.transcription.dictation_model_id = normalized_model_id.clone();
                }
                if settings_manager.settings().transcription.meeting_provider == provider_key {
                    candidate.transcription.meeting_model_id = normalized_model_id.clone();
                }
            }
            normalize_contextual_asr_settings(&mut candidate.transcription);
            settings_manager
                .commit_candidate(candidate)
                .map_err(|e| e.to_string())?;
            let transcription = &settings_manager.settings().transcription;
            state
                .asr_manager
                .set_provider_model_id(provider_type, normalized_model_id)
                .await;
            state
                .asr_manager
                .set_dictation_mlx_enabled(transcription.dictation_mlx_enabled)
                .await;
            state
                .asr_manager
                .set_meeting_mlx_enabled(transcription.meeting_mlx_enabled)
                .await;
            state
                .asr_manager
                .set_transcription_language(transcription.language.clone())
                .await;
            Ok(serde_json::Value::Null)
        }
        "list_openai_asr_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_openai_asr_models()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_elevenlabs_asr_models" => {
            let result =
                run_with_remote_processing_gate(state.as_ref(), list_elevenlabs_asr_models())
                    .await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "download_whisper_model" => {
            let model_name: String =
                serde_json::from_value(params["modelName"].clone()).map_err(|e| e.to_string())?;
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            let progress_handle = handle.clone();
            let model_name_for_cb = model_name.clone();
            let path = manager
                .download_whisper_model(&model_name, move |progress: download::DownloadProgress| {
                    progress_handle.emit_event(
                        "model-download-progress",
                        serde_json::json!({
                            "modelName": &model_name_for_cb,
                            "percentage": progress.percentage,
                            "bytesDownloaded": progress.bytes_downloaded,
                            "totalBytes": progress.total_bytes,
                        }),
                    );
                })
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(path.to_string_lossy()))
        }
        "list_downloaded_models" => {
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            let models = manager
                .list_downloaded_models()
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(models).map_err(|e| e.to_string())
        }
        "delete_model" => {
            let path_str: String =
                serde_json::from_value(params["path"].clone()).map_err(|e| e.to_string())?;
            let canonical = canonicalize_existing_absolute_path(&path_str, "path")?;
            let models_root = nautilus_data_root()?.join("models");
            let models_root = models_root.canonicalize().unwrap_or(models_root);
            if !canonical.starts_with(&models_root) {
                return Err(format!(
                    "Refusing to delete model outside managed directory '{}': {}",
                    models_root.display(),
                    canonical.display()
                ));
            }
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            manager
                .delete_model(&canonical)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_available_space" => {
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            let space = manager
                .get_available_space()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(space))
        }
        "download_platform_assets" => {
            let engine: String =
                serde_json::from_value(params["engine"].clone()).map_err(|e| e.to_string())?;
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            let path = manager
                .download_platform_assets(&engine)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(path.to_string_lossy()))
        }

        // ── Diarization ────────────────────────────────────────────────────
        "get_speakers" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let (transcript_opt, aliases) = {
                let db = state.db.lock().await;
                let t = db
                    .get_transcript(&recording_id)
                    .map_err(|e| e.to_string())?;
                let a = db
                    .get_speaker_aliases(&recording_id)
                    .map_err(|e| e.to_string())?;
                (t, a)
            };
            let Some(transcript) = transcript_opt else {
                return Ok(serde_json::json!([]));
            };
            let mut counts: std::collections::BTreeMap<String, usize> =
                std::collections::BTreeMap::new();
            for seg in &transcript.segments {
                if let Some(sid) = &seg.speaker_id {
                    *counts.entry(sid.clone()).or_insert(0) += 1;
                }
            }
            let speakers: Vec<serde_json::Value> = counts.into_iter().enumerate().map(|(idx, (speaker_id, sample_count))| {
                let alias = aliases.get(&speaker_id);
                let name = alias.and_then(|(n, _, _)| n.clone())
                    .or_else(|| default_source_speaker_name(&speaker_id).map(str::to_string))
                    .or_else(|| export::subtitles::default_speaker_name(&speaker_id))
                    .or_else(|| Some(format!("Speaker {}", idx + 1)));
                let color = alias.and_then(|(_, c, _)| c.clone()).unwrap_or_else(|| default_speaker_color(idx));
                serde_json::json!({ "id": speaker_id, "name": name, "color": color, "sampleCount": sample_count })
            }).collect();
            Ok(serde_json::json!(speakers))
        }
        "rename_speaker" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let speaker_id: String =
                serde_json::from_value(params["speakerId"].clone()).map_err(|e| e.to_string())?;
            let new_name: String =
                serde_json::from_value(params["newName"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            // Renaming a speaker who was confirmed as a remembered voice is a
            // correction of that confirmation: the sample it added describes
            // someone else. Withdrawn before the rename, which clears the
            // alias's voice link that older samples are matched through.
            let withdrawn = if new_name.trim().is_empty() {
                0
            } else {
                db.retract_cluster_voice_samples(
                    &recording_id,
                    &speaker_id,
                    Some(new_name.as_str()),
                    None,
                )
                .map_err(|e| e.to_string())?
            };
            db.rename_speaker(&recording_id, &speaker_id, &new_name)
                .map_err(|e| e.to_string())?;
            drop(db);
            if withdrawn > 0 {
                handle.emit_event(
                    "remembered-voices-changed",
                    serde_json::json!({ "withdrawn": withdrawn }),
                );
            }
            Ok(serde_json::Value::Null)
        }
        // ── Voiceprints (opt-in, local only) ─────────────────────────────
        "suggest_speaker_voices" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let remember_voices = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .remember_voices;
            if !remember_voices {
                // Not an error: the reader simply has the feature off, and the
                // transcript should show no chips rather than a failure.
                return Ok(serde_json::json!({
                    "enabled": false,
                    "clusters": [],
                    "nameOptions": [],
                }));
            }
            let (signatures, attendees, profiles) = {
                let db = state.db.lock().await;
                let (signatures, attendees) =
                    cluster_voice_context(&db, &state.session_cluster_voices, &recording_id)?;
                let profiles = db.list_speaker_profiles().map_err(|e| e.to_string())?;
                (signatures, attendees, profiles)
            };
            let clusters =
                diarization::voiceprints::build_suggestions(&signatures, &profiles, &attendees);
            let remembered: Vec<String> = profiles
                .iter()
                .map(|profile| profile.display_name.clone())
                .collect();
            let name_options =
                diarization::voiceprints::confirm_name_options(&attendees, &remembered);
            let clusters: Vec<serde_json::Value> = clusters
                .into_iter()
                .map(|cluster| {
                    serde_json::json!({
                        "speakerId": cluster.speaker_id,
                        "appliedProfileId": cluster.applied_profile_id,
                        "matchState": cluster.match_state,
                        // The centroid itself never leaves the sidecar.
                        "suggestion": cluster.suggestion.map(|matched| serde_json::json!({
                            "profileId": matched.profile_id,
                            "displayName": matched.display_name,
                            "percent": matched.percent(),
                            "confident": matches!(
                                matched.confidence,
                                diarization::voiceprints::MatchConfidence::Confident
                            ),
                        })),
                    })
                })
                .collect();
            Ok(serde_json::json!({
                "enabled": true,
                "clusters": clusters,
                "nameOptions": name_options,
            }))
        }
        "remember_speaker_voice" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let speaker_id: String =
                serde_json::from_value(params["speakerId"].clone()).map_err(|e| e.to_string())?;
            let requested_profile_id: Option<String> = params
                .get("profileId")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let requested_name: Option<String> = params
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::to_string);

            let remember_voices = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .remember_voices;
            diarization::voiceprints::voiceprint_write_allowed(remember_voices)
                .map_err(str::to_string)?;

            let mut db = state.db.lock().await;
            // The session's in-memory centroids count here: this is the moment
            // an unnamed cluster becomes a named one, and it is the moment its
            // signature is written.
            let (signatures, attendees) =
                cluster_voice_context(&db, &state.session_cluster_voices, &recording_id)?;
            let signature = signatures
                .iter()
                .find(|signature| signature.speaker_id == speaker_id)
                .ok_or_else(|| {
                    "Plainsong has no voice signature for this speaker. Run speaker identification again with \"Remember voices\" on."
                        .to_string()
                })?
                .clone();

            let profiles = db.list_speaker_profiles().map_err(|e| e.to_string())?;
            if let Some(profile_id) = requested_profile_id.as_deref() {
                if !diarization::voiceprints::is_current_suggestion(
                    &signatures,
                    &profiles,
                    &attendees,
                    &speaker_id,
                    profile_id,
                ) {
                    return Err(
                        "That remembered-voice suggestion is no longer valid for this speaker. Refresh the meeting and try again."
                            .to_string(),
                    );
                }
            }
            db.record_named_cluster_voice_signature(
                &recording_id,
                &speaker_id,
                &signature.centroid,
                &signature.embedding_model_id,
                true,
            )
            .map_err(|e| e.to_string())?;

            // A profile id decides the name, so a chip and the stored voice can
            // never drift apart; only the free-text path uses `name`.
            let (profile_id, display_name) = match requested_profile_id {
                Some(profile_id) => {
                    let profile = profiles
                        .iter()
                        .find(|profile| profile.id == profile_id)
                        .cloned()
                        .ok_or("That remembered voice no longer exists.")?;
                    if profile.embedding_model_id != signature.embedding_model_id {
                        return Err(
                            "That voice was remembered with a different speaker model, so Plainsong cannot compare it with this meeting."
                                .to_string(),
                        );
                    }
                    // Whatever this speaker was confirmed as before is being
                    // replaced; its sample goes, and re-confirming the same
                    // voice leaves one sample rather than two.
                    db.retract_cluster_voice_samples(&recording_id, &speaker_id, None, None)
                        .map_err(|e| e.to_string())?;
                    db.add_cluster_voice_sample(
                        &profile.id,
                        &signature.centroid,
                        &recording_id,
                        &speaker_id,
                    )
                    .map_err(|e| e.to_string())?;
                    (profile.id, profile.display_name)
                }
                None => {
                    let name = requested_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .ok_or("A remembered voice needs a name.")?
                        .to_string();
                    db.retract_cluster_voice_samples(&recording_id, &speaker_id, None, None)
                        .map_err(|e| e.to_string())?;
                    let profile_id = db
                        .remember_cluster_voice(
                            &name,
                            &signature.embedding_model_id,
                            &signature.centroid,
                            &recording_id,
                            &speaker_id,
                        )
                        .map_err(|e| e.to_string())?;
                    (profile_id, name)
                }
            };

            // The alias goes through the same rename path the pencil button
            // uses, so remembering a voice and renaming a speaker cannot
            // disagree about what the transcript says.
            db.rename_speaker(&recording_id, &speaker_id, &display_name)
                .map_err(|e| e.to_string())?;
            db.set_cluster_voice_match(
                &recording_id,
                &speaker_id,
                &profile_id,
                diarization::voiceprints::MATCH_STATE_CONFIRMED,
            )
            .map_err(|e| e.to_string())?;
            drop(db);

            handle.emit_event(
                "transcript-updated",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "reason": "speaker-voice",
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            Ok(serde_json::json!({
                "profileId": profile_id,
                "displayName": display_name,
            }))
        }
        "reject_speaker_voice" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let speaker_id: String =
                serde_json::from_value(params["speakerId"].clone()).map_err(|e| e.to_string())?;
            let profile_id: String =
                serde_json::from_value(params["profileId"].clone()).map_err(|e| e.to_string())?;
            // The same gate `remember_speaker_voice` has. "Not them" is still
            // a write to the voiceprint columns, and the promise is that
            // nothing about anyone's voice is stored while the switch is off —
            // there is also nothing to dismiss, since the chips are gone.
            let remember_voices = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .remember_voices;
            diarization::voiceprints::voiceprint_write_allowed(remember_voices)
                .map_err(str::to_string)?;
            let mut db = state.db.lock().await;
            // "Not them" about a voice this speaker was confirmed as takes back
            // the sample that confirmation added. Before the rejection, which
            // clears the alias link older samples are matched through.
            let withdrawn = db
                .retract_cluster_voice_samples(
                    &recording_id,
                    &speaker_id,
                    None,
                    Some(profile_id.as_str()),
                )
                .map_err(|e| e.to_string())?;
            db.reject_cluster_voice_match(&recording_id, &speaker_id, &profile_id)
                .map_err(|e| e.to_string())?;
            drop(db);
            if withdrawn > 0 {
                handle.emit_event(
                    "remembered-voices-changed",
                    serde_json::json!({ "withdrawn": withdrawn }),
                );
            }
            Ok(serde_json::Value::Null)
        }
        "list_remembered_voices" => {
            let db = state.db.lock().await;
            let profiles = db.list_speaker_profiles().map_err(|e| e.to_string())?;
            // Deliberately no centroid and no samples: the renderer never needs
            // the numbers, and a voice signature that reaches a window is a
            // voice signature that can end up in a screenshot or a log.
            let voices: Vec<serde_json::Value> = profiles
                .into_iter()
                .map(|profile| {
                    serde_json::json!({
                        "id": profile.id,
                        "displayName": profile.display_name,
                        "embeddingModelId": profile.embedding_model_id,
                        "sampleCount": profile.sample_count,
                        "createdAt": profile.created_at,
                        "updatedAt": profile.updated_at,
                    })
                })
                .collect();
            Ok(serde_json::json!(voices))
        }
        "forget_remembered_voice" => {
            let profile_id: String =
                serde_json::from_value(params["profileId"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let removed = db
                .forget_speaker_voice(&profile_id)
                .map_err(|e| e.to_string())?;
            // The name is user content and stays out of the audit log; that a
            // voice was deleted is the fact worth keeping.
            db.log_audit_event(
                "voiceprint_forgotten",
                Some(serde_json::json!({ "removed": removed })),
                "info",
            )
            .map_err(|e| e.to_string())?;
            drop(db);
            // An open transcript is showing chips for a voice that no longer
            // exists; refreshing only on selection change left them there
            // until the reader navigated away and back.
            handle.emit_event(
                "remembered-voices-changed",
                serde_json::json!({ "removed": removed }),
            );
            Ok(serde_json::json!(removed))
        }
        "forget_all_remembered_voices" => {
            let mut db = state.db.lock().await;
            let removed = db.forget_all_speaker_voices().map_err(|e| e.to_string())?;
            db.log_audit_event(
                "voiceprints_forgotten_all",
                Some(serde_json::json!({ "removed": removed })),
                "info",
            )
            .map_err(|e| e.to_string())?;
            drop(db);
            handle.emit_event(
                "remembered-voices-changed",
                serde_json::json!({ "removed": removed }),
            );
            Ok(serde_json::json!(removed))
        }
        "list_diarization_models" => {
            let models = list_diarization_models();
            serde_json::to_value(models).map_err(|e| e.to_string())
        }
        "get_diarization_model_plan" => {
            let selected = state
                .settings_manager
                .lock()
                .await
                .settings()
                .transcription
                .diarization_model_id
                .clone()
                .unwrap_or_else(|| diarization::DEFAULT_EMBEDDING_MODEL_ID.to_string());
            serde_json::to_value(diarization_model_plan(&selected)).map_err(|e| e.to_string())
        }
        "is_diarization_model_available" => {
            let model_id: Option<String> = params
                .get("modelId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if model_id.is_some() {
                return Ok(serde_json::json!(is_diarization_model_available(model_id)));
            }
            // No id: "can Run speaker labels produce labels now?", answered
            // with the same rule `run_diarization` applies -- the selected
            // model, or the default as a reported fallback. Probing only the
            // default would refuse a run whose selected model is installed.
            let selected = state
                .settings_manager
                .lock()
                .await
                .settings()
                .transcription
                .diarization_model_id
                .clone()
                .unwrap_or_else(|| diarization::DEFAULT_EMBEDDING_MODEL_ID.to_string());
            Ok(serde_json::json!(diarization::resolve_model_for_run(
                &selected
            )
            .is_some()))
        }
        "run_diarization" => {
            let recording_id: String = serde_json::from_value(
                params
                    .get("recordingId")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let postprocessing_lease = state.operation_coordinator.try_acquire_named(
                operation_coordinator::OperationKind::PostProcess,
                "speaker labelling",
            )?;
            let (
                _audio_postprocessing_guard,
                mut transcript,
                transcript_revision,
                existing_aliases,
            ) = {
                let db = state.db.lock().await;
                let _recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found")?;
                let (transcript, revision) = db
                    .get_transcript_with_revision(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| {
                        format!("Transcript not found for recording: {}", recording_id)
                    })?;
                let existing_aliases = db
                    .get_speaker_aliases(&recording_id)
                    .map_err(|e| e.to_string())?;
                let guard = MeetingAudioPostprocessingGuard::coordinated(
                    Arc::clone(&state.active_meeting_audio_postprocessing),
                    &recording_id,
                    postprocessing_lease,
                );
                db.set_meeting_audio_finalized(&recording_id, false)
                    .map_err(|e| e.to_string())?;
                (guard, transcript, revision, existing_aliases)
            };
            let resolved =
                resolve_recording_audio_bundle_for_runtime(state.as_ref(), &recording_id).await?;
            let diarization_model_id = state
                .settings_manager
                .lock()
                .await
                .settings()
                .transcription
                .diarization_model_id
                .clone()
                .unwrap_or_else(|| "ecapa_tdnn_speaker".to_string());
            // Same rule as the automatic pass: run the model the user picked,
            // or say plainly that the default ran instead. Without this the
            // explicit action either failed outright or -- once the fallback
            // existed -- would have swapped models behind the user's back.
            let resolved_model = diarization::resolve_model_for_run(&diarization_model_id)
                .ok_or_else(|| {
                    format!(
                        "No speaker model is downloaded. Download the speaker model in {}, then label the speakers.",
                        diarization::SPEAKER_MODEL_SETTINGS_PATH
                    )
                })?;
            let resolved_diarizer = format!("plainsong:{}", resolved_model.model_id);
            let diarization = state
                .operation_coordinator
                .run_post_call(
                    "speaker labelling",
                    diarization::run_diarization_with_model(
                        &resolved.primary,
                        &resolved_model.model_id,
                    ),
                )
                .await
                .map_err(|error| {
                    let detail = format!("{error:#}");
                    tracing::warn!(
                        "Speaker identification failed for {}: {}",
                        recording_id,
                        detail
                    );
                    crate::meeting_transcribe::manual_diarization_failure_message(&detail)
                })?;

            // Who spoke when before this run, to carry names to the same
            // voices rather than to the same, possibly renumbered, ids.
            let speakers_before: Vec<(f64, f64, Option<String>)> = transcript
                .segments
                .iter()
                .map(|segment| {
                    (
                        segment.start_time,
                        segment.end_time,
                        segment.speaker_id.clone(),
                    )
                })
                .collect();
            let engine = diarization::DiarizationEngine::with_model(&resolved_model.model_id);
            if transcript.measured_word_timestamps {
                engine.merge_with_measured_words(&diarization, &mut transcript.segments);
            } else {
                engine.merge_with_transcript(&diarization, &mut transcript.segments);
            }
            // Nothing found (audio shorter than the analysis window, or only
            // silence): keep the speakers and names the meeting already has.
            if diarization.speakers.is_empty() {
                return Err(
                    "Speaker identification found no speakers in this recording, so nothing was changed."
                        .to_string(),
                );
            }
            let same_voice = match_rerun_speakers(&speakers_before, &transcript.segments);
            let inferred_aliases = infer_speaker_aliases_from_segments(&transcript.segments);
            let alias_updates = diarization
                .speakers
                .iter()
                .enumerate()
                .map(|(index, speaker)| {
                    // A name the user gave follows the voice it was given to;
                    // a generic "Speaker N" is not carried, so it cannot
                    // contradict the new numbering.
                    let existing_name = same_voice
                        .get(&speaker.id)
                        .and_then(|old_id| existing_aliases.get(old_id))
                        .and_then(|(name, _, _)| name.as_deref())
                        .filter(|name| !is_generic_speaker_name(name));
                    let inferred_name = inferred_aliases.get(&speaker.id).map(String::as_str);
                    db::SpeakerAliasUpsert {
                        speaker_id: speaker.id.clone(),
                        name: resolve_speaker_name(
                            &speaker.id,
                            existing_name,
                            inferred_name,
                            speaker.name.as_deref(),
                            index,
                        ),
                        color: Some(speaker.color.clone()),
                        sample_count: speaker.sample_count as i64,
                    }
                })
                .collect::<Vec<_>>();

            let applied = {
                let mut db = state.db.lock().await;
                // Names were carried from a snapshot taken before diarization
                // ran. A rename or voice confirmation made meanwhile would be
                // overwritten, so stop and ask for another run instead.
                if db
                    .get_speaker_aliases(&recording_id)
                    .map_err(|e| e.to_string())?
                    != existing_aliases
                {
                    return Err(
                        "Speaker names changed while speaker identification was running; nothing was changed. Run speaker identification again."
                            .to_string(),
                    );
                }
                // The explicit "identify speakers" action writes the same
                // `diarizer` column as the automatic pass, so it now leaves the
                // same audit record -- previously the column could change here
                // with nothing in the log saying it had.
                // Names are written exactly as decided above: the old row
                // for an id that now belongs to someone else must not keep
                // its name, and a voice link moves with the name it backs.
                db.apply_relabelled_diarization(
                    &recording_id,
                    transcript_revision,
                    &transcript.segments,
                    &alias_updates,
                    &same_voice,
                    Some(&resolved_diarizer),
                    Some(serde_json::json!({
                        "recording_id": &recording_id,
                        "diarizer": &resolved_diarizer,
                        "speaker_count": diarization.speakers.len(),
                        "speaker_segment_count": diarization.segments.len(),
                    })),
                )
                .map_err(|e| e.to_string())?
            };
            if !applied {
                return Err(
                    "Transcript changed while speaker identification was running; no diarization changes were applied. Run speaker identification again."
                        .to_string(),
                );
            }
            state
                .db
                .lock()
                .await
                .set_meeting_audio_finalized(&recording_id, true)
                .map_err(|e| e.to_string())?;

            // Voiceprints. Read the switch here rather than inside the helper,
            // so "nothing is stored while it is off" is visible at the call
            // site. `cluster_centroids` is dropped with `diarization` either
            // way — it is `#[serde(skip)]` and never reaches the renderer.
            // The re-run's speaker ids replace the old ones, so the voices
            // held or stored for those go first, switch on or off.
            if let Err(error) =
                forget_superseded_cluster_voices(state.as_ref(), &recording_id).await
            {
                tracing::warn!(
                    "Could not drop superseded voice signatures of {}: {}",
                    recording_id,
                    error
                );
            }
            // Filed under the model that ran, which is the default when the
            // picked one was not downloaded.
            let voice_settings = {
                let sm = state.settings_manager.lock().await;
                sm.settings().meetings.clone()
            };
            if voice_settings.remember_voices {
                if let Err(error) = store_and_match_cluster_voices(
                    state.as_ref(),
                    &recording_id,
                    &resolved_model.model_id,
                    &diarization.cluster_centroids,
                    voice_settings.auto_apply_confident_voices,
                )
                .await
                {
                    tracing::warn!(
                        "Speaker identification finished for {} but voice matching did not: {}",
                        recording_id,
                        error
                    );
                }
            }

            handle.emit_event(
                "transcript-updated",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "reason": "diarization",
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            if let Some(notice) = resolved_model.fallback_notice.as_deref() {
                tracing::warn!(
                    "Diarization for {} ran another downloaded speaker model: {}",
                    recording_id,
                    notice
                );
                handle.emit_event(
                    "recording-status-changed",
                    serde_json::json!({
                        "recordingId": &recording_id,
                        "status": "completed",
                        "message": notice,
                        "updatedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }
            serde_json::to_value(diarization).map_err(|e| e.to_string())
        }
        "download_diarization_model" => {
            let model_id: Option<String> = params
                .get("modelId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let id = model_id
                .as_deref()
                .unwrap_or("ecapa_tdnn_speaker")
                .to_string();
            let progress_handle = handle.clone();
            let id_for_cb = id.clone();
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            manager
                .download_diarization_model_by_id(
                    &id,
                    move |progress: download::DownloadProgress| {
                        progress_handle.emit_event(
                            "model-download-progress",
                            serde_json::json!({
                                "modelName": &id_for_cb,
                                "percentage": progress.percentage,
                                "bytesDownloaded": progress.bytes_downloaded,
                                "totalBytes": progress.total_bytes,
                            }),
                        );
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        // ── Streaming live-preview engine (Nemotron 3.5 ASR Streaming) ────
        // Its own three commands rather than the ASR route commands: the
        // weights are not a route, `model_options()` never offers them, and
        // nothing here can select them for dictation or meetings. All three
        // answer honestly in a build with no streaming engine compiled in --
        // `supported: false`, and the download refuses.
        "get_live_preview_engine_status" => Ok(streaming_live_preview_status()),
        "download_live_preview_engine_model" => {
            download_live_preview_engine_model(handle).await?;
            Ok(streaming_live_preview_status())
        }
        "delete_live_preview_engine_model" => {
            delete_live_preview_engine_model().await?;
            Ok(streaming_live_preview_status())
        }
        // ── Bundled cleanup model (S1-mini by Superwhisper) ────────────────
        "get_native_text_model_status" => {
            let root = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong")
                .join("models");
            let model_id = params.get("modelId").and_then(serde_json::Value::as_str);
            Ok(llm::native_text::status(&root, model_id))
        }
        "download_native_text_model" => {
            let root = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong")
                .join("models");
            let model_id = params.get("modelId").and_then(serde_json::Value::as_str);
            let progress_handle = handle.clone();
            let progress_model = model_id.map(str::to_owned);
            llm::native_text::download(&root, model_id, move |percentage| progress_handle.emit_event("model-download-progress",
                serde_json::json!({"modelName":llm::native_text::MODEL_DIR,"modelId":progress_model,"percentage":percentage}))).await.map_err(|error|error.to_string())?;
            Ok(llm::native_text::status(&root, model_id))
        }
        "cancel_native_text_model_download" => {
            llm::native_text::cancel_download();
            Ok(serde_json::Value::Null)
        }
        "delete_native_text_model" => {
            let root = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong")
                .join("models");
            let model_id = params.get("modelId").and_then(serde_json::Value::as_str);
            llm::native_text::delete(&root, model_id).map_err(|error| error.to_string())?;
            Ok(llm::native_text::status(&root, model_id))
        }
        "get_bundled_cleanup_model_status" => Ok(bundled_cleanup_model_status()),
        "download_bundled_cleanup_model" => {
            let models_root = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong")
                .join("models");
            let progress_handle = handle.clone();
            llm::bundled_local::download(&models_root, move |percentage| {
                progress_handle.emit_event(
                    "model-download-progress",
                    serde_json::json!({
                        "modelName": llm::bundled_local::MODEL_DIR_NAME,
                        "percentage": percentage,
                    }),
                );
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(bundled_cleanup_model_status())
        }
        "delete_bundled_cleanup_model" => {
            let models_root = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong")
                .join("models");
            llm::bundled_local::delete(&models_root).map_err(|e| e.to_string())?;
            Ok(bundled_cleanup_model_status())
        }
        "get_apple_language_model_availability" => {
            let refresh = params
                .get("refresh")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let availability = match cached_apple_language_model_availability() {
                Some(cached) if !refresh => cached,
                _ => refresh_apple_language_model_availability().await,
            };
            let mut payload = serde_json::to_value(availability).map_err(|e| e.to_string())?;
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "provider".to_string(),
                    llm::apple_language_model::PROVIDER_SETTINGS_VALUE.into(),
                );
                object.insert(
                    "displayName".to_string(),
                    llm::apple_language_model::DISPLAY_NAME.into(),
                );
            }
            Ok(payload)
        }
        "is_silero_vad_model_downloaded" => {
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            Ok(serde_json::json!(manager.is_silero_vad_model_downloaded()))
        }
        "download_silero_vad_model" => {
            let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
            let progress_handle = handle.clone();
            let path = manager
                .download_silero_vad_model(move |progress: download::DownloadProgress| {
                    progress_handle.emit_event(
                        "model-download-progress",
                        serde_json::json!({
                            "modelName": "silero_vad",
                            "percentage": progress.percentage,
                            "bytesDownloaded": progress.bytes_downloaded,
                            "totalBytes": progress.total_bytes,
                        }),
                    );
                })
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(path.to_string_lossy()))
        }

        // ── Projects ───────────────────────────────────────────────────────
        "get_projects" => {
            let db = state.db.lock().await;
            let result = db.get_projects().map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "create_project" => {
            let project: models::CreateProjectRequest =
                serde_json::from_value(params["project"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db.create_project(&project).map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "delete_project" => {
            let project_id: String =
                serde_json::from_value(params["projectId"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.delete_project(&project_id).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }

        // ── Dictation dictionary ───────────────────────────────────────────
        "list_dictation_dictionary_entries" => {
            let db = state.db.lock().await;
            let result = db
                .list_dictation_dictionary_entries()
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "create_dictation_dictionary_entry" => {
            let req: models::CreateDictationDictionaryEntryRequest =
                serde_json::from_value(params["request"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db
                .create_dictation_dictionary_entry(&req)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "update_dictation_dictionary_entry" => {
            let entry_id: String =
                serde_json::from_value(params["entryId"].clone()).map_err(|e| e.to_string())?;
            let req: models::UpdateDictationDictionaryEntryRequest =
                serde_json::from_value(params["request"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db
                .update_dictation_dictionary_entry(&entry_id, &req)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "delete_dictation_dictionary_entry" => {
            let entry_id: String =
                serde_json::from_value(params["entryId"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.delete_dictation_dictionary_entry(&entry_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "list_dictation_snippets" => {
            let db = state.db.lock().await;
            let result = db.list_dictation_snippets().map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "create_dictation_snippet" => {
            let req: models::CreateDictationSnippetRequest =
                serde_json::from_value(params["snippet"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db
                .create_dictation_snippet(&req)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "update_dictation_snippet" => {
            let snippet_id: String =
                serde_json::from_value(params["snippetId"].clone()).map_err(|e| e.to_string())?;
            let req: models::UpdateDictationSnippetRequest =
                serde_json::from_value(params["snippet"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db
                .update_dictation_snippet(&snippet_id, &req)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "delete_dictation_snippet" => {
            let snippet_id: String =
                serde_json::from_value(params["snippetId"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.delete_dictation_snippet(&snippet_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "learn_dictation_correction" => {
            let request: models::LearnDictationCorrectionRequest =
                serde_json::from_value(params["request"].clone()).map_err(|e| e.to_string())?;
            let candidate = match infer_learned_correction_result(&request) {
                Ok(c) => c,
                Err(result) => return serde_json::to_value(*result).map_err(|e| e.to_string()),
            };
            let mut db = state.db.lock().await;
            let result = apply_learned_correction_candidate(&mut db, candidate)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "list_dictation_correction_suggestions" => {
            let mut db = state.db.lock().await;
            // Expiry and the cap are enforced on read: the inbox is the only
            // place these rows are ever looked at, so this is the moment a
            // suggestion nobody reviewed within the week stops existing.
            if let Err(error) = db.prune_dictation_correction_suggestions(
                chrono::Utc::now(),
                dictation_correction_capture::CORRECTION_SUGGESTION_MAX_AGE_DAYS,
                dictation_correction_capture::CORRECTION_SUGGESTION_QUEUE_CAP,
            ) {
                tracing::warn!("Pruning stale correction suggestions failed: {}", error);
            }
            let result = db
                .list_dictation_correction_suggestions()
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "queue_dictation_correction_suggestion" => {
            let request: models::LearnDictationCorrectionRequest =
                serde_json::from_value(params["request"].clone()).map_err(|e| e.to_string())?;
            let candidate = match infer_learned_correction_result(&request) {
                Ok(c) => c,
                Err(result) => {
                    return serde_json::to_value(models::QueueDictationCorrectionSuggestionResult {
                        queued: false,
                        action: None,
                        reason: result.reason,
                        spoken_form: result.spoken_form,
                        replacement: result.replacement,
                        suggestion: None,
                    })
                    .map_err(|e| e.to_string())
                }
            };
            let mut db = state.db.lock().await;
            if db
                .has_learned_global_dictation_correction(
                    &candidate.spoken_form,
                    &candidate.replacement,
                )
                .map_err(|e| e.to_string())?
            {
                return serde_json::to_value(models::QueueDictationCorrectionSuggestionResult {
                    queued: false,
                    action: None,
                    reason: Some("This correction is already learned".into()),
                    spoken_form: Some(candidate.spoken_form),
                    replacement: Some(candidate.replacement),
                    suggestion: None,
                })
                .map_err(|e| e.to_string());
            }
            let (action, suggestion) = db
                .upsert_dictation_correction_suggestion(
                    &request.original_text,
                    &request.corrected_text,
                    candidate.spoken_form.as_str(),
                    candidate.replacement.as_str(),
                    request.app_target.as_deref(),
                    // This arm is the in-app path: the user retyped the result
                    // inside Plainsong. Nothing was read out of another app.
                    None,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(models::QueueDictationCorrectionSuggestionResult {
                queued: true,
                action: Some(action),
                reason: None,
                spoken_form: Some(candidate.spoken_form),
                replacement: Some(candidate.replacement),
                suggestion: Some(suggestion),
            })
            .map_err(|e| e.to_string())
        }
        "approve_dictation_correction_suggestion" => {
            let suggestion_id: String = serde_json::from_value(params["suggestionId"].clone())
                .map_err(|e| e.to_string())?;
            let expected_dictionary: models::CorrectionApprovalDictionarySnapshot =
                serde_json::from_value(params["expectedDictionary"].clone())
                    .map_err(|e| format!("Expected dictionary snapshot is required: {}", e))?;
            let result = state
                .db
                .lock()
                .await
                .approve_dictation_correction_suggestion(&suggestion_id, &expected_dictionary)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "undo_dictation_correction_approval" => {
            let undo_token: String =
                serde_json::from_value(params["undoToken"].clone()).map_err(|e| e.to_string())?;
            let result = state
                .db
                .lock()
                .await
                .undo_dictation_correction_approval(&undo_token)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "reject_dictation_correction_suggestion" => {
            let suggestion_id: String = serde_json::from_value(params["suggestionId"].clone())
                .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.delete_dictation_correction_suggestion(&suggestion_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "list_dictation_command_presets" => {
            let db = state.db.lock().await;
            let result = db
                .list_dictation_command_presets()
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "upsert_dictation_command_preset" => {
            let request: models::UpsertDictationCommandPresetRequest =
                serde_json::from_value(params["request"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let result = db
                .upsert_dictation_command_preset(&request)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "delete_dictation_command_preset" => {
            let command_key: String =
                serde_json::from_value(params["commandKey"].clone()).map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            db.delete_dictation_command_preset(&command_key)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "export_dictation_dictionary_csv" => {
            let db = state.db.lock().await;
            let entries = db
                .list_dictation_dictionary_entries()
                .map_err(|e| e.to_string())?;
            let csv = dictation_dictionary_csv::export_dictionary_entries_csv(&entries);
            Ok(serde_json::json!(csv))
        }
        "import_dictation_dictionary_csv" => {
            let csv_text: String = serde_json::from_value(
                params
                    .get("csvText")
                    .cloned()
                    .unwrap_or(serde_json::Value::String(String::new())),
            )
            .map_err(|e| e.to_string())?;
            let requests = match dictation_dictionary_csv::parse_dictionary_entries_csv(&csv_text) {
                Ok(requests) => requests,
                Err(errors) => {
                    return serde_json::to_value(models::DictationDictionaryCsvImportResult {
                        created_count: 0,
                        updated_count: 0,
                        skipped_count: 0,
                        errors,
                    })
                    .map_err(|e| e.to_string());
                }
            };
            let mut db = state.db.lock().await;
            let existing_entries = db
                .list_dictation_dictionary_entries()
                .map_err(|e| e.to_string())?;
            let (mut created_count, mut updated_count, mut skipped_count) =
                (0usize, 0usize, 0usize);
            let mut errors: Vec<String> = Vec::new();
            for request in requests {
                let normalized = request.spoken_form.trim().to_string();
                let normalized_scope = request
                    .app_scope
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty());
                let existing = existing_entries.iter().find(|e| {
                    e.spoken_form.eq_ignore_ascii_case(&normalized)
                        && scopes_match(e.app_scope.as_deref(), normalized_scope)
                });
                if let Some(existing) = existing {
                    if existing.replacement == request.replacement.trim()
                        && existing.case_sensitive == request.case_sensitive
                        && existing.enabled == request.enabled
                        && existing.category_scope == request.category_scope
                    {
                        skipped_count += 1;
                        continue;
                    }
                    match db.update_dictation_dictionary_entry(
                        &existing.id,
                        &models::UpdateDictationDictionaryEntryRequest {
                            spoken_form: Some(request.spoken_form.clone()),
                            replacement: Some(request.replacement.clone()),
                            app_scope: Some(request.app_scope.clone()),
                            case_sensitive: Some(request.case_sensitive),
                            enabled: Some(request.enabled),
                            category_scope: Some(request.category_scope.clone()),
                        },
                    ) {
                        Ok(_) => updated_count += 1,
                        Err(e) => errors
                            .push(format!("Failed to update '{}': {}", request.spoken_form, e)),
                    }
                } else {
                    match db.create_dictation_dictionary_entry(&request) {
                        Ok(_) => created_count += 1,
                        Err(e) => errors
                            .push(format!("Failed to create '{}': {}", request.spoken_form, e)),
                    }
                }
            }
            serde_json::to_value(models::DictationDictionaryCsvImportResult {
                created_count,
                updated_count,
                skipped_count,
                errors,
            })
            .map_err(|e| e.to_string())
        }

        // ── Settings ──────────────────────────────────────────────────────────
        "get_note_publish_config" => {
            let db = state.db.lock().await;
            let config = db.publish_config().map_err(|e| e.to_string())?;
            let location = config.location_id.as_deref().and_then(|id| {
                approved_locations::registry()
                    .ok()
                    .map(|r| r.summary(id, approved_locations::ApprovedLocationPurpose::Notes))
            });
            Ok(serde_json::json!({"config":config,"location":location}))
        }
        "save_note_publish_config" => {
            let mut config: crate::publishing::PublishConfig =
                serde_json::from_value(params["config"].clone()).map_err(|e| e.to_string())?;
            let template = state
                .template_manager
                .get_template(&config.template_id)
                .ok_or("Choose a Markdown notes format")?;
            if template.format != export::templates::ExportFormat::Markdown {
                return Err("Choose a Markdown notes format".into());
            }
            let _guard = crate::publishing::IO_GATE.lock().await;
            let registry = approved_locations::registry().map_err(|e| e.to_string())?;
            let location = if let Some(id) = config.location_id.as_deref() {
                let existing =
                    registry.summary(id, approved_locations::ApprovedLocationPurpose::Notes);
                if existing.approved {
                    Some(existing)
                } else {
                    // Promote only a native-picker-approved export capability.
                    // The renderer cannot supply a path or mint approval.
                    match registry
                        .resolve_filesystem(id, approved_locations::ApprovedLocationPurpose::Export)
                    {
                        Ok(root) => {
                            let approved = registry
                                .approve_filesystem(
                                    approved_locations::ApprovedLocationPurpose::Notes,
                                    &root,
                                )
                                .map_err(|_| "Couldn't approve the notes folder")?;
                            config.location_id = Some(approved.id.clone());
                            Some(approved)
                        }
                        Err(_) if !config.enabled => {
                            config.location_id = None;
                            None
                        }
                        Err(_) => return Err("Choose the notes folder again".into()),
                    }
                }
            } else {
                None
            };
            if config.enabled && location.is_none() {
                return Err("Choose a notes folder".into());
            }
            let mut kept = {
                let mut db = state.db.lock().await;
                db.save_publish_config(&config).map_err(|e| e.to_string())?;
                db.publish_receipt_locations().map_err(|e| e.to_string())?
            };
            kept.extend(config.location_id.clone());
            // A folder that is neither chosen nor holding a published file
            // keeps no write approval. Failing to prune is not a save error.
            if let Err(error) = registry.retain_notes_locations(&kept) {
                tracing::warn!("Could not prune unused notes folder approvals: {error}");
            }
            Ok(serde_json::json!({"config":config,"location":location}))
        }
        "get_note_publish_status" => {
            let id = params["recordingId"]
                .as_str()
                .ok_or("Missing recording ID")?;
            serde_json::to_value(
                state
                    .db
                    .lock()
                    .await
                    .publish_status(id)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "retry_note_publish" => {
            let id = params["recordingId"]
                .as_str()
                .ok_or("Missing recording ID")?;
            state
                .db
                .lock()
                .await
                .retry_publish(id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_settings" => {
            let settings_manager = state.settings_manager.lock().await;
            let result = visible_settings_for_renderer(settings_manager.settings());
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "approve_export_location_privileged" => {
            let raw_path = params
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or("Native export-folder approval requires a path")?;
            let registry = approved_locations::registry().map_err(|error| error.to_string())?;
            let for_notes = params
                .get("forNotes")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let purpose = if for_notes {
                approved_locations::ApprovedLocationPurpose::Notes
            } else {
                approved_locations::ApprovedLocationPurpose::Export
            };
            let summary = registry
                .approve_filesystem(purpose, Path::new(raw_path))
                .map_err(|error| error.to_string())?;
            if for_notes {
                return serde_json::to_value(summary).map_err(|error| error.to_string());
            }
            let mut settings_manager = state.settings_manager.lock().await;
            settings_manager.settings_mut().privacy.export_root = None;
            settings_manager.settings_mut().privacy.export_location_id = Some(summary.id.clone());
            settings_manager
                .settings_mut()
                .privacy
                .export_location_label = Some(summary.label.clone());
            settings_manager
                .settings_mut()
                .privacy
                .export_location_approved = true;
            settings_manager.save().map_err(|error| error.to_string())?;
            emit_settings_changed(handle, settings_manager.settings());
            serde_json::to_value(summary).map_err(|error| error.to_string())
        }
        "apply_global_shortcuts_now" => Ok(serde_json::json!({
            "ok": true,
            "message": "Global shortcuts applied"
        })),
        "list_audio_input_devices" => {
            let (
                devices,
                preferred_input,
                dictation_override,
                dictation_device,
                meeting_override,
                meeting_device,
            ) = {
                let sm = state.settings_manager.lock().await;
                let s = sm.settings();
                let preferred = s
                    .audio
                    .preferred_input_device
                    .as_ref()
                    .map(|d| d.device_id.clone());
                let dict_dev = s
                    .audio
                    .dictation_input_device
                    .as_ref()
                    .map(|d| d.device_id.clone());
                let meet_dev = s
                    .audio
                    .meeting_input_device
                    .as_ref()
                    .map(|d| d.device_id.clone());
                let dict_override = s.audio.dictation_input_override_enabled;
                let meet_override = s.audio.meeting_input_override_enabled;
                drop(sm);
                let audio = state.audio_capture.lock().await;
                let inv = audio.list_input_devices().map_err(|e| e.to_string())?;
                (
                    inv,
                    preferred,
                    dict_override,
                    dict_dev,
                    meet_override,
                    meet_dev,
                )
            };
            Ok(serde_json::json!({
                "devices": devices,
                "appWideSelectedDeviceId": preferred_input,
                "dictationOverrideEnabled": dictation_override,
                "dictationSelectedDeviceId": dictation_device,
                "meetingOverrideEnabled": meeting_override,
                "meetingSelectedDeviceId": meeting_device,
            }))
        }
        "save_settings" => {
            let (settings, preserve_saved_prompts) = parse_settings_update_request(params)?;
            let saved =
                save_settings_for_sidecar(state.as_ref(), handle, settings, preserve_saved_prompts)
                    .await;
            if saved.is_ok() {
                crate::semantic_index::request_index();
            }
            saved
        }
        "set_dictation_external_correction_learning" => {
            let enabled = params
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .ok_or("enabled must be a boolean")?;
            set_dictation_external_correction_learning_for_sidecar(state.as_ref(), handle, enabled)
                .await
        }
        // From the main process only (not on the renderer allowlist). Names
        // are held in memory for the vocabulary step and never logged; the
        // reply carries only how many were kept.
        "set_dictation_contact_names" => {
            let names: Vec<String> = params
                .get("names")
                .and_then(serde_json::Value::as_array)
                .ok_or("names must be an array")?
                .iter()
                .filter_map(|name| name.as_str().map(str::to_string))
                .collect();
            let settings = state.settings_manager.lock().await;
            let enabled = settings.settings().transcription.dictation_contact_names;
            crate::dictation_vocabulary::set_contact_names(if enabled {
                names
            } else {
                Vec::new()
            });
            Ok(serde_json::json!({
                "count": crate::dictation_vocabulary::contact_name_count()
            }))
        }
        "set_dictation_calendar_names" => {
            let read_names = |key: &str| -> Result<Vec<String>, String> {
                Ok(params
                    .get(key)
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| format!("{key} must be an array"))?
                    .iter()
                    .take(crate::dictation_vocabulary::MAX_CONTACT_NAMES)
                    .filter_map(|name| name.as_str().map(str::to_string))
                    .collect())
            };
            let names = read_names("names")?;
            let meeting_names = read_names("meetingNames")?;
            let settings = state.settings_manager.lock().await;
            if settings.settings().transcription.dictation_calendar_names
                && !settings.settings().meetings.calendar_disconnected
            {
                crate::dictation_vocabulary::set_calendar_names(names, meeting_names);
            } else {
                crate::dictation_vocabulary::set_calendar_names(Vec::new(), Vec::new());
            }
            Ok(serde_json::json!({"count": crate::dictation_vocabulary::calendar_name_count()}))
        }
        "set_saved_prompts" => {
            let prompts = parse_set_saved_prompts_request(params)?;
            set_saved_prompts_for_sidecar(state.as_ref(), handle, prompts).await
        }
        "record_onboarding_state" => {
            let event = params
                .get("event")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let meetings_completed = params
                .get("meetingsCompleted")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let unmet: Vec<String> = params
                .get("unmet")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default();
            record_onboarding_state_for_sidecar(
                state.as_ref(),
                handle,
                event,
                meetings_completed,
                &unmet,
            )
            .await
        }
        "get_audio_storage_status" => {
            crate::audio_compression::storage_status(state.as_ref()).await
        }
        "run_storage_retention_maintenance" => {
            if params.get("audioOnly").and_then(|v| v.as_bool()) == Some(true) {
                if params.get("confirmed").and_then(|v| v.as_bool()) != Some(true) {
                    return Err("Confirm meeting audio deletion first.".into());
                }
                let (transcript_only, confirmed_preset, confirmed_months) = {
                    let manager = state.settings_manager.lock().await;
                    let settings = &manager.settings().transcription;
                    if params.get("preset").and_then(|v| v.as_str())
                        != Some(settings.meeting_retention_preset.as_str())
                        || params.get("storageMode").and_then(|v| v.as_str())
                            != Some(settings.meeting_audio_storage_mode.as_str())
                        || params.get("customMonths").and_then(|v| v.as_u64())
                            != Some(u64::from(settings.meeting_retention_custom_months))
                    {
                        return Err(
                            "Retention settings are still saving. Try again after they save."
                                .into(),
                        );
                    }
                    (
                        settings.meeting_audio_storage_mode == "transcript_only",
                        settings.meeting_retention_preset.clone(),
                        settings.meeting_retention_custom_months,
                    )
                };
                let (immediate_meetings, immediate_files) = if transcript_only {
                    apply_meeting_transcript_only_storage_policy(
                        state.as_ref(),
                        Some(handle),
                        "manual-audio-cleanup",
                        None,
                    )
                    .await?
                } else {
                    (0, 0)
                };
                let (_, files, meetings) = enforce_meeting_retention_policy_inner(
                    state.as_ref(),
                    Some(handle),
                    "manual-audio-cleanup",
                    None,
                    Some((&confirmed_preset, confirmed_months)),
                )
                .await?;
                return Ok(
                    serde_json::json!({"deletedAudioFiles":files + immediate_files,"audioPathsCleared":meetings + immediate_meetings}),
                );
            }
            let recording_id_filter = params
                .get("recordingId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let (transcript_only_clears, transcript_only_deleted_audio_files) =
                apply_meeting_transcript_only_storage_policy(
                    state.as_ref(),
                    Some(handle),
                    "manual-maintenance",
                    recording_id_filter,
                )
                .await?;
            let (dictation_deleted_recordings, dictation_deleted_audio_files) =
                if recording_id_filter.is_some() {
                    (0, 0)
                } else {
                    enforce_dictation_retention_policy(
                        state.as_ref(),
                        Some(handle),
                        "manual-maintenance",
                    )
                    .await?
                };
            let (
                meeting_deleted_recordings,
                meeting_deleted_audio_files,
                meeting_audio_paths_cleared,
            ) = enforce_meeting_retention_policy(
                state.as_ref(),
                Some(handle),
                "manual-maintenance",
                recording_id_filter,
            )
            .await?;
            Ok(serde_json::json!({
                "transcriptOnly": {
                    "audioPathsCleared": transcript_only_clears,
                    "deletedAudioFiles": transcript_only_deleted_audio_files,
                },
                "dictationRetention": {
                    "deletedRecordings": dictation_deleted_recordings,
                    "deletedAudioFiles": dictation_deleted_audio_files,
                },
                "meetingRetention": {
                    "deletedRecordings": meeting_deleted_recordings,
                    "deletedAudioFiles": meeting_deleted_audio_files,
                    "audioPathsCleared": meeting_audio_paths_cleared,
                }
            }))
        }
        "reset_app_state" => reset_app_state_for_sidecar(state.as_ref(), handle).await,

        // ── System / permissions ───────────────────────────────────────────
        "get_audit_log" => {
            let db = state.db.lock().await;
            let result = db.get_audit_log().map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }

        // ── Support bundle ──────────────────────────────────────────────────
        // Both arms are main-process only (see
        // `intentionallyUnreachableSidecarCommands` in
        // scripts/verify-ipc-contract.ts). `describe` is what the Settings
        // screen shows before anything is written; `write` takes a path the
        // reader just chose in a native save dialog, which is why the renderer
        // may not name it.
        "describe_support_bundle" => {
            let audit_entry_count = {
                let db = state.db.lock().await;
                db.get_audit_log().map_err(|e| e.to_string())?.len()
            };
            let artifacts = support_bundle_model_artifacts();
            Ok(serde_json::json!({
                "schemaVersion": support_bundle::SCHEMA_VERSION,
                "sections": support_bundle::sections(),
                "redactionRules": support_bundle::REDACTION_RULES,
                "excludedByDesign": support_bundle::EXCLUDED_BY_DESIGN,
                "auditEntryCount": audit_entry_count.min(support_bundle::MAX_AUDIT_ENTRIES),
                "modelArtifactCount": artifacts.len(),
                "maxLogLines": support_bundle::MAX_LOG_LINES,
            }))
        }
        "write_support_bundle_privileged" => {
            let target_path = params
                .get("targetPath")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Writing a support bundle requires a targetPath")?;
            let target = PathBuf::from(target_path);
            if !target.is_absolute() {
                return Err(format!(
                    "targetPath must be an absolute path, got '{}'",
                    target_path
                ));
            }
            // The dialog picks the file, so the parent must already exist; the
            // leaf must not be a directory we would clobber.
            let parent = target
                .parent()
                .ok_or_else(|| format!("targetPath has no parent directory: '{}'", target_path))?;
            let canonical_parent = canonicalize_existing_absolute_path(
                &parent.to_string_lossy(),
                "targetPath parent",
            )?;
            if !canonical_parent.is_dir() {
                return Err(format!(
                    "targetPath parent must be an existing directory, got '{}'",
                    canonical_parent.display()
                ));
            }
            if target.is_dir() {
                return Err(format!("targetPath is a directory: '{}'", target_path));
            }
            let file_name = target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .ok_or_else(|| format!("targetPath has no file name: '{}'", target_path))?;
            let destination = canonical_parent.join(&file_name);

            let host = params
                .get("host")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let build_identity = params
                .get("buildIdentity")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let log_lines: Vec<String> = params
                .get("logLines")
                .and_then(|value| value.as_array())
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(|line| line.as_str().map(|text| text.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let settings_value = {
                let sm = state.settings_manager.lock().await;
                serde_json::to_value(sm.settings()).map_err(|e| e.to_string())?
            };
            let readiness = collect_permission_diagnostics(state.as_ref(), Vec::new()).await;
            let readiness_value = serde_json::to_value(readiness).map_err(|e| e.to_string())?;
            let models_value = serde_json::json!({
                "artifacts": support_bundle_model_artifacts(),
            });
            let audit_entries: Vec<serde_json::Value> = {
                let db = state.db.lock().await;
                let mut entries = db.get_audit_log().map_err(|e| e.to_string())?;
                // `get_audit_log` returns newest first; the bundle reads best
                // oldest first, and `redact_audit_entries` keeps the tail.
                entries.reverse();
                entries
                    .into_iter()
                    .map(|entry| serde_json::to_value(entry).unwrap_or(serde_json::Value::Null))
                    .collect()
            };

            let generated_at = chrono::Utc::now().to_rfc3339();
            let files = support_bundle::build_files(
                &generated_at,
                &host,
                &build_identity,
                &settings_value,
                &readiness_value,
                &models_value,
                &audit_entries,
                &log_lines,
            );
            support_bundle::write_bundle(&destination, &files).map_err(|e| e.to_string())?;
            let bytes = std::fs::metadata(&destination)
                .map(|meta| meta.len())
                .unwrap_or_default();
            Ok(serde_json::json!({
                "fileName": file_name,
                "bytes": bytes,
                "fileCount": files.len(),
                "generatedAt": generated_at,
            }))
        }
        // Main-process only (see `intentionallyUnreachableSidecarCommands` in
        // scripts/verify-ipc-contract.ts): records what a `plainsong://` deep
        // link asked for and what the app did about it, so the audit log shows
        // every external trigger next to the recordings it touched. The
        // payload is a fixed set of short enum-like strings chosen by
        // main.ts; no URL text or query payload is ever written here.
        "record_automation_audit_event" => {
            let action = params
                .get("action")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty() && v.len() <= 64)
                .ok_or_else(|| "record_automation_audit_event needs an action".to_string())?;
            let outcome = params
                .get("outcome")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty() && v.len() <= 64)
                .ok_or_else(|| "record_automation_audit_event needs an outcome".to_string())?;
            let source = params
                .get("source")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty() && v.len() <= 32)
                .unwrap_or("deep_link");
            let severity = if outcome == "performed" {
                "info"
            } else {
                "warning"
            };
            let mut db = state.db.lock().await;
            db.log_audit_event(
                "automation.deep_link",
                Some(serde_json::json!({
                    "source": source,
                    "action": action,
                    "outcome": outcome,
                })),
                severity,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_dictation_history_details" => {
            let recording_id: String = serde_json::from_value(
                params
                    .get("recording_id")
                    .or_else(|| params.get("recordingId"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let db = state.db.lock().await;
            let transcript_artifact = db
                .get_latest_transcript_artifact(&recording_id)
                .map_err(|e| e.to_string())?;
            let insertion_action = db
                .get_latest_insertion_action(&recording_id)
                .map_err(|e| e.to_string())?;
            let audit_log = db.get_all_audit_log().map_err(|e| e.to_string())?;
            let audit_details = audit_log
                .into_iter()
                .rev()
                .find(|entry| {
                    entry.event == "dictation_completed"
                        && entry.details.get("recording_id").and_then(|v| v.as_str())
                            == Some(recording_id.as_str())
                })
                .map(|entry| dictation_history_details_from_audit(&entry.details))
                .unwrap_or_default();
            let details = merge_dictation_history_details(
                audit_details,
                transcript_artifact.as_ref(),
                insertion_action.as_ref(),
            );
            let history_text = db
                .get_dictation_history_text(&recording_id)
                .map_err(|e| e.to_string())?;
            let recording = db.get_recording(&recording_id).map_err(|e| e.to_string())?;
            let reprocessed_from = match history_text
                .as_ref()
                .and_then(|text| text.reprocessed_from_id.as_deref())
            {
                Some(source_id) => db.get_recording(source_id).map_err(|e| e.to_string())?,
                None => None,
            };
            let mut details = enrich_dictation_history_details(
                details,
                history_text.as_ref(),
                recording.as_ref(),
                reprocessed_from.as_ref(),
            );
            details.recognition_review_words = db
                .get_dictation_recognition_review_words(&recording_id)
                .map_err(|e| e.to_string())?;
            if details.recognition_review_words.is_some() {
                details.raw_transcript = history_text.as_ref().map(|text| text.raw_text.clone());
            }
            let result = if dictation_history_details_is_empty(&details) {
                None
            } else {
                Some(details)
            };
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "search_dictation_history" => {
            let query: String = params
                .get("query")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let limit = params
                .get("limit")
                .and_then(|value| value.as_u64())
                .unwrap_or(25) as usize;
            let offset = params
                .get("offset")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as usize;
            let db = state.db.lock().await;
            let hits = db
                .search_dictation_history(&query, limit, offset)
                .map_err(|e| e.to_string())?;
            // Deliberately not audited. Searching is a read that changes
            // nothing, and the search field re-runs on a debounce and again on
            // every change to the recordings list, so one minute of typing
            // appended dozens of rows and buried the ones that record a change.
            // "Process again", deletion and retention still write theirs.
            serde_json::to_value(hits).map_err(|e| e.to_string())
        }
        "reprocess_dictation" => {
            let history_id: String = params
                .get("historyId")
                .or_else(|| params.get("recordingId"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Process again needs the id of a saved dictation.".to_string())?
                .to_string();
            let optional_string = |key: &str| {
                params
                    .get(key)
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let request = DictationReprocessRequest {
                history_id,
                mode_id: optional_string("modeId"),
                provider: optional_string("provider"),
                model_id: optional_string("modelId"),
            };
            let outcome = reprocess_dictation_impl(state.as_ref(), handle, request).await?;
            serde_json::to_value(outcome).map_err(|e| e.to_string())
        }
        "get_dictation_insights" => {
            // Bounded aggregate query: this used to load every dictation and
            // then issue two more queries per recording, so opening the
            // Dictation view got slower for the rest of the user's life.
            let db = state.db.lock().await;
            let totals = db
                .get_dictation_insight_totals()
                .map_err(|e| e.to_string())?;
            let insights = models::DictationInsights {
                total_dictations: totals.total_dictations,
                dictated_words: totals.dictated_words,
                average_words_per_dictation: totals
                    .dictated_words
                    .checked_div(totals.total_dictations)
                    .unwrap_or(0),
                active_days: totals.active_days,
                last_seven_days_dictations: totals.last_seven_days_dictations,
                commands_used: totals.commands_used,
                backtracks_used: totals.backtracks_used,
                snippets_triggered: totals.snippets_triggered,
                top_app_target: totals.top_app_target,
                top_app_target_count: totals.top_app_target_count,
                spoken_seconds: totals.spoken_seconds,
                current_streak_days: models::current_streak_days(
                    &totals.active_dates,
                    chrono::Local::now().date_naive(),
                ),
            };
            serde_json::to_value(insights).map_err(|e| e.to_string())
        }
        "verify_dictation_setup" => {
            let permissions = collect_permission_diagnostics(state.as_ref(), Vec::new()).await;
            let settings = state.settings_manager.lock().await.settings().clone();
            let dictation_insertion_mode = settings.transcription.dictation_insertion_mode.as_str();
            let cursor_insert_required = dictation_cursor_insert_required(dictation_insertion_mode);
            let cursor_insert_ready =
                dictation_cursor_insert_ready(dictation_insertion_mode, &permissions);
            let mut details = vec![
                format!(
                    "Microphone: {}",
                    if permissions.microphone_ready {
                        "ready"
                    } else if !permissions.microphone_permission_ready {
                        "permission required"
                    } else {
                        "no input device"
                    }
                ),
                format!(
                    "Cursor insert: {}",
                    describe_dictation_cursor_insert_status(dictation_insertion_mode, &permissions)
                ),
            ];
            let result = match resolve_ready_dictation_selection(
                state.as_ref(),
                &settings.transcription,
                Some(&settings.transcription.dictation_route_preference),
                settings.privacy.remote_processing_enabled,
            )
            .await
            {
                Ok((provider, model_id, route_preference, hosting, warning)) => {
                    if provider == asr::AsrProviderType::MacosAppleSpeech {
                        details.push(format!(
                            "Speech recognition: {}",
                            if permissions.speech_recognition_ready {
                                "ready"
                            } else {
                                "needs access"
                            }
                        ));
                    }
                    details.push(format!(
                        "Route preference: {}",
                        dictation_route_preference_to_settings_value(route_preference)
                    ));
                    details.push(format!(
                        "Resolved route: {} / {} ({})",
                        provider.display_name(),
                        model_id,
                        hosting_environment_to_settings_value(hosting)
                    ));
                    if let Some(w) = warning {
                        details.push(w);
                    }
                    let ok = permissions.microphone_ready
                        && cursor_insert_ready
                        && (provider != asr::AsrProviderType::MacosAppleSpeech
                            || permissions.speech_recognition_ready);
                    SetupVerificationResult {
                        ok,
                        title: "Dictation verification".to_string(),
                        summary: if ok {
                            if cursor_insert_required {
                                "Dictation route, microphone, and insertion permissions are ready."
                                    .to_string()
                            } else {
                                "Dictation route and microphone are ready. Clipboard-only delivery does not need cursor insertion.".to_string()
                            }
                        } else {
                            "Dictation route resolved, but one or more permissions still need attention.".to_string()
                        },
                        details,
                    }
                }
                Err(error) => {
                    details.push(error);
                    SetupVerificationResult {
                        ok: false,
                        title: "Dictation verification".to_string(),
                        summary: "No ready dictation route matched the current preference."
                            .to_string(),
                        details,
                    }
                }
            };
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "verify_meeting_setup" => {
            let permissions = collect_permission_diagnostics(state.as_ref(), Vec::new()).await;
            let settings = state.settings_manager.lock().await.settings().clone();
            let system_audio = {
                let audio = state.audio_capture.lock().await;
                audio.system_audio_capability()
            };
            let system_audio_verified = system_audio_capability_is_verified(&system_audio);
            let backend_label = match system_audio.backend {
                audio::system_capture::SystemAudioBackend::CoreAudioProcessTap => {
                    "Core Audio process tap"
                }
                audio::system_capture::SystemAudioBackend::VirtualLoopback => "virtual loopback",
                audio::system_capture::SystemAudioBackend::None => "none",
            };
            let route_available =
                system_audio.backend != audio::system_capture::SystemAudioBackend::None;
            let mut details = vec![
                format!(
                    "Microphone: {}",
                    if permissions.microphone_ready {
                        "ready"
                    } else if !permissions.microphone_permission_ready {
                        "permission required"
                    } else {
                        "no input device"
                    }
                ),
                format!("System audio backend: {}", backend_label),
                format!(
                    "System audio route: {}",
                    system_audio
                        .route_device
                        .as_deref()
                        .unwrap_or("not detected")
                ),
                format!(
                    "System audio native format: {}",
                    match (
                        system_audio.native_sample_rate,
                        system_audio.native_channels,
                    ) {
                        (Some(rate), Some(channels)) => format!("{} Hz / {} ch", rate, channels),
                        _ => "unavailable".to_string(),
                    }
                ),
                format!(
                    "System audio verification: {}",
                    if system_audio_verified {
                        "non-silent test passed"
                    } else if route_available {
                        "route detected; permission/audio unverified"
                    } else {
                        "no usable route"
                    }
                ),
            ];
            if let Some(reason) = &system_audio.actionable_reason {
                details.push(reason.clone());
            }
            let result = match resolve_ready_meeting_selection(
                state.as_ref(),
                &settings.transcription,
                settings.privacy.remote_processing_enabled,
            )
            .await
            {
                Ok((provider, model_id, warning)) => {
                    details.push(format!(
                        "Meeting route: {} / {}",
                        provider.display_name(),
                        model_id
                    ));
                    if let Some(w) = warning {
                        details.push(w);
                    }
                    if !route_available {
                        details.push("Mic-only meetings are available. Me + Them needs a way to record the meeting audio on this Mac.".to_string());
                    } else if !system_audio_verified {
                        details.push("Mic-only meetings are available. Choose Check meeting audio before relying on Me + Them.".to_string());
                    }
                    let meeting_ready = permissions.microphone_ready;
                    let full_capture_ready = meeting_ready && system_audio_verified;
                    details.push(format!(
                        "Full Me + Them capture: {}",
                        if full_capture_ready {
                            "verified"
                        } else {
                            "not verified"
                        }
                    ));
                    SetupVerificationResult {
                        ok: meeting_ready,
                        title: "Meeting verification".to_string(),
                        summary: if full_capture_ready {
                            "Meeting route, microphone, and verified system audio are ready for Me + Them capture."
                                .to_string()
                        } else if meeting_ready {
                            "Meeting route and microphone are ready for mic-only capture. Me + Them capture is not verified yet."
                                .to_string()
                        } else {
                            "The meeting route is ready, but microphone input and permission still need attention."
                                .to_string()
                        },
                        details,
                    }
                }
                Err(error) => {
                    details.push(error);
                    SetupVerificationResult {
                        ok: false,
                        title: "Meeting verification".to_string(),
                        summary: "No speech model for meetings is ready yet.".to_string(),
                        details,
                    }
                }
            };
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "verify_system_audio_setup" => {
            let system_audio = {
                let audio = state.audio_capture.lock().await;
                audio.system_audio_capability()
            };
            let system_audio_verified = system_audio_capability_is_verified(&system_audio);
            let backend_label = match system_audio.backend {
                audio::system_capture::SystemAudioBackend::CoreAudioProcessTap => {
                    "Core Audio process tap"
                }
                audio::system_capture::SystemAudioBackend::VirtualLoopback => "virtual loopback",
                audio::system_capture::SystemAudioBackend::None => "none",
            };
            let mut details = vec![
                format!("Backend: {}", backend_label),
                format!(
                    "Route: {}",
                    system_audio
                        .route_device
                        .as_deref()
                        .unwrap_or("not detected")
                ),
                format!(
                    "Native format: {}",
                    match (
                        system_audio.native_sample_rate,
                        system_audio.native_channels,
                    ) {
                        (Some(rate), Some(channels)) => format!("{} Hz / {} ch", rate, channels),
                        _ => "unavailable".to_string(),
                    }
                ),
            ];
            if let Some(reason) = &system_audio.actionable_reason {
                details.push(reason.clone());
            }
            let result = SetupVerificationResult {
                ok: system_audio_verified,
                title: "Meeting audio check".to_string(),
                summary: if system_audio_verified {
                    "Plainsong can hear all audio playing on this Mac.".to_string()
                } else if system_audio.backend != audio::system_capture::SystemAudioBackend::None {
                    "Plainsong hasn't confirmed it can hear the meeting audio yet. Choose Check meeting audio."
                        .to_string()
                } else {
                    "Plainsong can't record the meeting audio on this Mac yet.".to_string()
                },
                details,
            };
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "get_meeting_consent_notice_status" => {
            let result = meeting_consent_notice_status(state.as_ref());
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "request_dictation_permissions" => {
            let result = request_dictation_permissions_impl(state.as_ref()).await?;
            handle.emit_event(
                "readiness-invalidated",
                serde_json::json!({ "reason": "dictation_permissions_requested" }),
            );
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "install_apple_speech_language" => {
            let locale = params
                .get("locale")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|locale| !locale.is_empty())
                .map(ToString::to_string);
            let result =
                install_apple_speech_language_impl(state.as_ref(), handle, locale.as_deref())
                    .await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        // The install is macOS' download and can run for minutes; the reader
        // who started it needs a way to stop waiting on it. Takes no
        // parameters and reads nothing: it sets a flag the in-flight install
        // loop checks, which kills the helper.
        "cancel_apple_speech_language_install" => {
            crate::asr::platform::macos_speech::cancel_language_install();
            Ok(serde_json::Value::Null)
        }
        "request_apple_speech_permission" => {
            let result = request_apple_speech_permission_impl(state.as_ref()).await?;
            handle.emit_event(
                "readiness-invalidated",
                serde_json::json!({ "reason": "speech_permission_requested" }),
            );
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "repair_cursor_insert_permissions" => {
            let result = repair_cursor_insert_permissions_impl(state.as_ref()).await?;
            handle.emit_event(
                "readiness-invalidated",
                serde_json::json!({ "reason": "cursor_permissions_repaired" }),
            );
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "open_permission_settings" => {
            let section: String =
                serde_json::from_value(params["section"].clone()).map_err(|e| e.to_string())?;
            open_permission_settings_impl(&section)?;
            Ok(serde_json::Value::Null)
        }
        "open_installed_nautilus_app" => {
            open_installed_nautilus_app_impl()?;
            Ok(serde_json::Value::Null)
        }
        "qa_smoke_test_cursor_insert" => {
            let text: Option<String> = serde_json::from_value(
                params
                    .get("text")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            let expected_bundle_id: Option<String> = serde_json::from_value(
                params
                    .get("expectedBundleId")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            qa_smoke_test_cursor_insert_impl(state.as_ref(), text, expected_bundle_id).await
        }
        "capture_selected_text_for_playback" => {
            let admission_nonce: String = serde_json::from_value(
                params
                    .get("admissionNonce")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|_| "Selected text playback requires an admission proof".to_string())?;
            let result =
                capture_selected_text_for_playback_impl(state.as_ref(), &admission_nonce).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "reprocess_dictation_text" => {
            let text: String =
                serde_json::from_value(params["text"].clone()).map_err(|e| e.to_string())?;
            let mode_preset: String =
                serde_json::from_value(params["modePreset"].clone()).map_err(|e| e.to_string())?;
            let app_target: Option<String> = serde_json::from_value(
                params
                    .get("appTarget")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            reprocess_dictation_text_impl(state.as_ref(), text, mode_preset, app_target).await
        }
        "transform_selected_text" => {
            let command_key: String =
                serde_json::from_value(params["commandKey"].clone()).map_err(|e| e.to_string())?;
            let admission_nonce: String = serde_json::from_value(
                params
                    .get("admissionNonce")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|_| "Selected text transform requires an admission proof".to_string())?;
            transform_selected_text_impl(state.as_ref(), &command_key, &admission_nonce).await
        }
        // "Recover last dictation": a checkpoint an earlier process left
        // between stop and a recorded outcome (`dictation_checkpoint`).
        "get_pending_dictation_recovery" => {
            let dir = crate::dictation_checkpoint::dictation_checkpoint_directory()?;
            serde_json::to_value(crate::dictation_checkpoint::pending_dictation_recovery(
                &dir,
                std::time::SystemTime::now(),
            ))
            .map_err(|e| e.to_string())
        }
        "recover_pending_dictation" => {
            let recovered =
                crate::dictation_checkpoint::recover_pending_dictation(state.as_ref()).await?;
            serde_json::to_value(recovered).map_err(|e| e.to_string())
        }
        "discard_pending_dictation_recovery" => {
            let dir = crate::dictation_checkpoint::dictation_checkpoint_directory()?;
            crate::dictation_checkpoint::discard_dictation_recovery(&dir);
            Ok(serde_json::Value::Null)
        }
        // For the quit guard's "Copy text and quit": the words recognized so
        // far for one session, from the same recovery list the menu bar uses.
        "get_dictation_session_text" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| "A dictation session id is required.".to_string())?;
            let text = state
                .recent_dictation_results
                .lock()
                .ok()
                .and_then(|results| recent_dictation_text_for_session(&results, session_id));
            Ok(serde_json::json!({ "text": text }))
        }
        "get_recent_dictation_results" => {
            let results = state
                .recent_dictation_results
                .lock()
                .map(|results| results.clone())
                .unwrap_or_default();
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        // Recovery path for an insertion that landed in the wrong place or
        // silently failed: put the words back without making the user speak
        // them again. Deliberately reuses a result the sidecar produced itself
        // rather than accepting arbitrary text from the renderer.
        "repaste_dictation_result" => reuse_recent_dictation_result(state.as_ref(), &params, true),
        "recopy_dictation_result" => reuse_recent_dictation_result(state.as_ref(), &params, false),
        // ── Window management (handled by Electron) ──────────────────────────
        "open_main_window" => {
            handle.window_command("open-main", &serde_json::Value::Null);
            Ok(serde_json::Value::Null)
        }
        "open_main_window_to" => {
            let view: String =
                serde_json::from_value(params["view"].clone()).map_err(|e| e.to_string())?;
            let recording_id: Option<String> = serde_json::from_value(
                params
                    .get("recordingId")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| e.to_string())?;
            handle.window_command(
                "open-main-to",
                serde_json::json!({ "view": view, "recordingId": recording_id }),
            );
            Ok(serde_json::Value::Null)
        }
        "get_dictation_overlay_state" => {
            let result = state
                .dictation_overlay_state
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "dismiss_meeting_microphone_warning" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let mut overlay = state
                .recording_overlay_state
                .lock()
                .map_err(|_| "Could not dismiss this warning".to_string())?;
            if !dismiss_meeting_microphone_warning(&mut overlay, &recording_id) {
                return Err(
                    "This microphone warning belongs to another or ended meeting.".to_string(),
                );
            }
            // Publish before stop can replace this snapshot with a terminal phase.
            handle.emit_event(
                "meeting-recording-state-changed",
                serde_json::to_value(&*overlay).map_err(|e| e.to_string())?,
            );
            Ok(serde_json::Value::Null)
        }
        "get_recording_overlay_state" => {
            let result = state
                .recording_overlay_state
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "hold_dictation_overlay_review" => {
            let session_id = params
                .get("sessionId")
                .and_then(serde_json::Value::as_u64)
                .filter(|session_id| *session_id > 0)
                .ok_or_else(|| "sessionId must be a positive integer".to_string())?;
            let held = state
                .dictation_overlay_state
                .lock()
                .map(|mut overlay| hold_dictation_overlay_review(&mut overlay, session_id))
                .map_err(|_| "Could not access the dictation result".to_string())?;
            if !held {
                return Err("The dictation result is no longer available for review.".to_string());
            }
            Ok(serde_json::json!({ "held": true, "sessionId": session_id }))
        }
        "dismiss_dictation_overlay" => {
            // Dismissal hides the HUD; it does not stop capture. Reporting it
            // as phase "idle" made Electron mirror an idle phase while the
            // microphone was still live, so the next hotkey press resolved to
            // "start" against a session that was already running. Carry only
            // the dismissal flag — every renderer that cares already keys off
            // it, and the phase mirror is left untouched.
            if let Ok(mut s) = state.dictation_overlay_state.lock() {
                s.dismissed = true;
                s.message = None;
                s.preview = None;
                s.partial_text = None;
                s.clear_warnings();
            }
            handle.emit_event(
                "dictation-state-changed",
                serde_json::json!({
                    "dismissed": true,
                }),
            );
            handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
            Ok(serde_json::Value::Null)
        }
        "dismiss_recording_overlay" => {
            if let Ok(mut s) = state.recording_overlay_state.lock() {
                s.dismissed = true;
            }
            handle.window_command("hide-recording-overlay", &serde_json::Value::Null);
            Ok(serde_json::Value::Null)
        }

        // ── Security / Vault ───────────────────────────────────────────────
        "has_provider_secret" => {
            let provider: String =
                serde_json::from_value(params["provider"].clone()).map_err(|e| e.to_string())?;
            if AnalysisProvider::from_settings_value(&provider).ok()
                == Some(AnalysisProvider::ChatGptPlan)
            {
                let status = chatgpt_plan_status().await?;
                return Ok(serde_json::json!(
                    status.cloud_enabled
                        && status.connected
                        && status.plan_enabled
                        && status.loaded
                ));
            }
            let normalized = normalize_provider_secret_name(&provider)?;
            let result = secrets::has_provider_secret(normalized).map_err(|e| e.to_string())?;
            Ok(serde_json::json!(result))
        }
        "set_provider_secret" => {
            let provider: String =
                serde_json::from_value(params["provider"].clone()).map_err(|e| e.to_string())?;
            let secret: String =
                serde_json::from_value(params["secret"].clone()).map_err(|e| e.to_string())?;
            let normalized = normalize_provider_secret_name(&provider)?;
            secrets::set_provider_secret(normalized, &secret).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "clear_provider_secret" => {
            let provider: String =
                serde_json::from_value(params["provider"].clone()).map_err(|e| e.to_string())?;
            let normalized = normalize_provider_secret_name(&provider)?;
            secrets::clear_provider_secret(normalized).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_security_status" => {
            let result = build_security_status(state.as_ref()).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "unlock_vault" => {
            let password: String =
                serde_json::from_value(params["password"].clone()).map_err(|e| e.to_string())?;
            unlock_vault_runtime(state.as_ref(), &password).await?;
            Ok(serde_json::Value::Null)
        }
        "lock_vault" => {
            let _operation_lease = state
                .operation_coordinator
                .try_acquire(operation_coordinator::OperationKind::VaultLock)?;
            let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
                "Cannot lock the vault while recording audio storage is busy".to_string()
            })?;
            if state.audio_capture.lock().await.is_recording() {
                return Err("Stop the active meeting before locking the vault".to_string());
            }
            if !state
                .db
                .lock()
                .await
                .list_open_recording_audio_operations()
                .map_err(|error| error.to_string())?
                .is_empty()
            {
                return Err(
                    "Finish or retry recording audio encryption before locking the vault"
                        .to_string(),
                );
            }
            // Runtime playback leases are revoked by the coordinator. Give
            // their cleanup tasks a chance to drop file guards, then remove
            // any remaining app-owned plaintext before zeroizing the key.
            tokio::task::yield_now().await;
            let data_dir = crate::paths::data_dir()
                .ok_or("Could not find data directory while locking the vault")?;
            remove_decrypted_runtime_audio_directory(&data_dir)?;
            let mut vault_state = state.vault_state.lock().await;
            if let Some(mut key) = vault_state.recording_key.take() {
                use zeroize::Zeroize;
                key.zeroize();
            }
            vault_state.unlocked = false;
            Ok(serde_json::Value::Null)
        }
        "migrate_to_encrypted_storage" => {
            let password: String =
                serde_json::from_value(params["password"].clone()).map_err(|e| e.to_string())?;
            migrate_storage_encryption(state.as_ref(), &password).await?;
            Ok(serde_json::Value::Null)
        }

        // ── Export ─────────────────────────────────────────────────────────
        "list_export_templates" => {
            let templates: Vec<_> = state
                .template_manager
                .list_templates()
                .into_iter()
                .cloned()
                .collect();
            serde_json::to_value(templates).map_err(|e| e.to_string())
        }
        "export_recording" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let format: String =
                serde_json::from_value(params["format"].clone()).map_err(|e| e.to_string())?;
            let target: Option<String> = params
                .get("target")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let (recording, transcript, export_context) = {
                let db = state.db.lock().await;
                let recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found")?;
                let transcript = db
                    .get_transcript(&recording_id)
                    .map_err(|e| e.to_string())?;
                let context = export_context_for_recording(&db, &recording_id);
                (recording, transcript, context)
            };
            let validated_target = match target.as_deref() {
                Some(path) => Some(validate_export_target_path(state.as_ref(), path).await?),
                None => None,
            };
            let export_path = transcription::export(
                &recording,
                transcript.as_ref(),
                &format,
                validated_target.as_deref(),
                &export_context,
            )
            .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let _ = db.log_audit_event("recording_exported", Some(serde_json::json!({"recording_id": &recording_id, "format": &format, "bytes": exported_file_bytes(&export_path)})), "info");
            Ok(serde_json::json!(export_path))
        }
        "export_recording_v2" => {
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let format: String =
                serde_json::from_value(params["format"].clone()).map_err(|e| e.to_string())?;
            let redaction_level = params
                .get("redactionLevel")
                .and_then(|v| v.as_str())
                .unwrap_or("basic")
                .to_string();
            let target: Option<String> = params
                .get("target")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let preview_mode = params
                .get("preview")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let (recording, transcript, export_context) = {
                let db = state.db.lock().await;
                let recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found")?;
                let transcript = db
                    .get_transcript(&recording_id)
                    .map_err(|e| e.to_string())?;
                let context = export_context_for_recording(&db, &recording_id);
                (recording, transcript, context)
            };
            let validated_target = match target.as_deref() {
                Some(path) => Some(validate_export_target_path(state.as_ref(), path).await?),
                None => None,
            };
            let result = transcription::export_with_policy(
                &recording,
                transcript.as_ref(),
                &format,
                validated_target.as_deref(),
                &redaction_level,
                preview_mode,
                &export_context,
            )
            .map_err(|e| e.to_string())?;
            let mut db = state.db.lock().await;
            let bytes = match (&result.export_path, &result.content) {
                (Some(path), _) => exported_file_bytes(path),
                (None, Some(content)) => Some(content.len() as u64),
                (None, None) => None,
            };
            let _ = db.log_audit_event("recording_exported_v2", Some(serde_json::json!({"recording_id": &recording_id, "format": &format, "preview": preview_mode, "bytes": bytes})), "info");
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "export_with_template" => {
            use export::templates::RenderData;
            let recording_id: String =
                serde_json::from_value(params["recordingId"].clone()).map_err(|e| e.to_string())?;
            let template_id: String =
                serde_json::from_value(params["templateId"].clone()).map_err(|e| e.to_string())?;
            let target: Option<String> = params
                .get("target")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let preview_mode = params
                .get("preview")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            // Template exports honor the same redaction control as plain
            // exports; content is redacted before rendering so the chosen
            // level applies to every templated field.
            let redaction_level: String = params
                .get("redactionLevel")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string();
            let (recording, transcript, speaker_aliases) = {
                let db = state.db.lock().await;
                let recording = db
                    .get_recording(&recording_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Recording not found")?;
                let transcript = db
                    .get_transcript(&recording_id)
                    .map_err(|e| e.to_string())?;
                let speaker_aliases = db.get_speaker_aliases(&recording_id).unwrap_or_default();
                (recording, transcript, speaker_aliases)
            };
            let full_text = transcript
                .as_ref()
                .map(|t| transcription::apply_redaction(&t.full_text, &redaction_level))
                .unwrap_or_default();
            let speakers: Vec<export::templates::SpeakerInfo> = {
                use std::collections::BTreeMap;
                let mut by_speaker: BTreeMap<String, Vec<(f64, f64, String)>> = BTreeMap::new();
                if let Some(t) = &transcript {
                    for seg in &t.segments {
                        let sid = seg
                            .speaker_id
                            .clone()
                            .unwrap_or_else(|| "unknown".to_string());
                        by_speaker.entry(sid).or_default().push((
                            seg.start_time,
                            seg.end_time,
                            transcription::apply_redaction(&seg.text, &redaction_level),
                        ));
                    }
                }
                by_speaker
                    .into_iter()
                    .enumerate()
                    .map(|(idx, (speaker_id, segments))| {
                        let name = speaker_aliases
                            .get(&speaker_id)
                            .and_then(|(n, _, _)| n.clone())
                            .filter(|name| !name.trim().is_empty())
                            .or_else(|| export::subtitles::default_speaker_name(&speaker_id))
                            .unwrap_or_else(|| {
                                if speaker_id == "unknown" {
                                    "Unknown".to_string()
                                } else {
                                    format!("Speaker {}", idx + 1)
                                }
                            });
                        export::templates::SpeakerInfo {
                            id: speaker_id,
                            name: transcription::apply_redaction(&name, &redaction_level),
                            segments,
                        }
                    })
                    .collect()
            };
            // Export is a deterministic read of the saved meeting record. It
            // must not launch another full analysis job under an export timeout:
            // users get the exact summary and action items they reviewed, while
            // missing analysis remains visibly missing in the rendered template.
            let (summary, action_items) = persisted_template_analysis(&recording, &redaction_level);
            let render_data = RenderData {
                title: transcription::apply_redaction(&recording.title, &redaction_level),
                date: recording.created_at.format("%Y-%m-%d %H:%M").to_string(),
                duration_seconds: recording.duration as u64,
                transcript: full_text,
                speakers,
                action_items,
                summary,
                source_limitations: export::meeting_source_limitations(&recording)
                    .map(|text| transcription::apply_redaction(&text, &redaction_level)),
            };
            let rendered = state
                .template_manager
                .render(&template_id, &render_data)
                .map_err(|e| e.to_string())?;
            if preview_mode {
                return serde_json::to_value(models::TemplateExportResponse {
                    template_id,
                    preview: true,
                    export_path: None,
                    content: Some(rendered),
                })
                .map_err(|e| e.to_string());
            }
            let template = state
                .template_manager
                .get_template(&template_id)
                .ok_or_else(|| format!("Template not found: {}", template_id))?;
            let export_path = match target.as_deref() {
                Some(path) => validate_export_target_path(state.as_ref(), path).await?,
                None => {
                    let fallback =
                        export::get_default_export_path(&recording, export::ExportFormat::Text);
                    fallback
                        .with_extension(template_format_extension(&template.format))
                        .to_string_lossy()
                        .to_string()
                }
            };
            let export_path_buf = std::path::PathBuf::from(&export_path);
            // A Docx template renders Markdown like the others; only the file
            // it is written into differs.
            let bytes = if template.format.is_binary() {
                export::docx::markdown_to_docx(&rendered).map_err(|error| error.to_string())?
            } else {
                rendered.as_bytes().to_vec()
            };
            write_template_export(&export_path_buf, &bytes)?;
            let mut db = state.db.lock().await;
            let _ = db.log_audit_event("recording_template_exported", Some(serde_json::json!({"recording_id": &recording_id, "template_id": &template_id, "bytes": bytes.len()})), "info");
            serde_json::to_value(models::TemplateExportResponse {
                template_id,
                preview: false,
                export_path: Some(export_path),
                content: None,
            })
            .map_err(|e| e.to_string())
        }

        // ── Backup ──────────────────────────────────────────────────
        "get_backup_config" => {
            let bm = state.backup_manager.lock().await;
            serde_json::to_value(bm.config_for_renderer()).map_err(|e| e.to_string())
        }
        "save_backup_config" => {
            let config: backup::BackupConfig = serde_json::from_value(
                params
                    .get("config")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(Default::default())),
            )
            .map_err(|e| e.to_string())?;
            let mut bm = state.backup_manager.lock().await;
            bm.set_config_from_renderer(config)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "approve_backup_location_privileged" => {
            let raw_path = params
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or("Native backup-folder approval requires a path")?;
            let registry = approved_locations::registry().map_err(|error| error.to_string())?;
            let summary = registry
                .approve_filesystem(
                    approved_locations::ApprovedLocationPurpose::Backup,
                    Path::new(raw_path),
                )
                .map_err(|error| error.to_string())?;
            let canonical = registry
                .resolve_filesystem(
                    &summary.id,
                    approved_locations::ApprovedLocationPurpose::Backup,
                )
                .map_err(|error| error.to_string())?;
            let mut bm = state.backup_manager.lock().await;
            bm.set_backup_location_privileged(&summary, canonical)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(summary).map_err(|error| error.to_string())
        }
        "approve_cloud_backup_location_privileged" => {
            let provider: backup::CloudProvider = serde_json::from_value(
                params
                    .get("provider")
                    .cloned()
                    .ok_or("Cloud destination approval requires a provider")?,
            )
            .map_err(|error| error.to_string())?;
            let registry = approved_locations::registry().map_err(|error| error.to_string())?;
            let (summary, remote_name, cloud_folder, icloud_path) = match provider {
                backup::CloudProvider::ICloud => {
                    let raw_path = params
                        .get("path")
                        .and_then(|value| value.as_str())
                        .ok_or("iCloud approval requires a picker-selected folder")?;
                    let cloud_folder = params
                        .get("folder")
                        .and_then(|value| value.as_str())
                        .unwrap_or("PlainsongBackups")
                        .trim()
                        .to_string();
                    let summary = registry
                        .approve_filesystem(
                            approved_locations::ApprovedLocationPurpose::CloudBackup,
                            Path::new(raw_path),
                        )
                        .map_err(|error| error.to_string())?;
                    let canonical = registry
                        .resolve_filesystem(
                            &summary.id,
                            approved_locations::ApprovedLocationPurpose::CloudBackup,
                        )
                        .map_err(|error| error.to_string())?;
                    (summary, None, cloud_folder, Some(canonical))
                }
                backup::CloudProvider::GoogleDrive
                | backup::CloudProvider::OneDrive
                | backup::CloudProvider::ProtonDrive => {
                    let remote_name = params
                        .get("remoteName")
                        .and_then(|value| value.as_str())
                        .ok_or("rclone approval requires a remote name")?;
                    let cloud_folder = params
                        .get("folder")
                        .and_then(|value| value.as_str())
                        .ok_or("rclone approval requires a folder")?;
                    let summary = registry
                        .approve_rclone(remote_name, cloud_folder)
                        .map_err(|error| error.to_string())?;
                    let (remote_name, cloud_folder) = registry
                        .resolve_rclone(&summary.id)
                        .map_err(|error| error.to_string())?;
                    (summary, Some(remote_name), cloud_folder, None)
                }
            };
            let mut bm = state.backup_manager.lock().await;
            bm.set_cloud_location_privileged(
                provider,
                &summary,
                remote_name,
                cloud_folder,
                icloud_path,
            )
            .map_err(|error| error.to_string())?;
            serde_json::to_value(summary).map_err(|error| error.to_string())
        }
        "list_backups" => {
            let bm = state.backup_manager.lock().await;
            let backups = bm.list_backups().await.map_err(|e| e.to_string())?;
            serde_json::to_value(backups).map_err(|e| e.to_string())
        }
        "create_backup_default" => {
            let _operation_lease = state
                .operation_coordinator
                .try_acquire(operation_coordinator::OperationKind::Backup)?;
            let _storage_guard = state.audio_storage_gate.lock().await;
            if state.audio_capture.lock().await.is_recording() {
                return Err("Stop the active meeting before creating a full backup".to_string());
            }
            if state
                .db
                .lock()
                .await
                .has_open_recording_audio_operations()
                .map_err(|error| error.to_string())?
            {
                return Err(
                    "Finish or retry recording audio encryption before creating a full backup"
                        .to_string(),
                );
            }
            let data_dir = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong");
            let snapshot = snapshot_live_database(state.as_ref()).await?;
            let backup_result = {
                let bm = state.backup_manager.lock().await;
                bm.create_backup(&data_dir, Some(&snapshot)).await
            };
            if let Err(error) = std::fs::remove_file(&snapshot) {
                tracing::warn!(
                    "Failed to remove temporary database snapshot {}: {}",
                    snapshot.display(),
                    error
                );
            }
            let info = backup_result.map_err(|e| e.to_string())?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        }
        "create_settings_backup_default" => {
            let _operation_lease = state
                .operation_coordinator
                .try_acquire(operation_coordinator::OperationKind::Backup)?;
            let data_dir = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong");
            let bm = state.backup_manager.lock().await;
            let info = bm
                .create_settings_backup(&data_dir)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        }
        "restore_backup_default" => {
            let operation_lease = state
                .operation_coordinator
                .acquire_library_replacement(operation_coordinator::OperationKind::Restore)
                .await?;
            let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
                "Cannot restore while recording encryption or storage cleanup is active."
                    .to_string()
            })?;
            if state.audio_capture.lock().await.is_recording() {
                return Err("Stop the active meeting before restoring a backup.".to_string());
            }
            if active_dictation_session_id(state.as_ref()).await.is_some() {
                return Err("Finish the active dictation before restoring a backup.".to_string());
            }
            if state
                .db
                .lock()
                .await
                .has_open_recording_audio_operations()
                .map_err(|error| error.to_string())?
            {
                return Err(
                    "Finish or retry recording audio encryption before restoring a backup."
                        .to_string(),
                );
            }
            let backup_id: String =
                serde_json::from_value(params["backupId"].clone()).map_err(|e| e.to_string())?;
            let data_dir = crate::paths::data_dir()
                .ok_or("Could not find data directory")?
                .join("Plainsong");
            let previous_settings = state.settings_manager.lock().await.settings().clone();
            let mut database = state.db.lock().await;
            let previous_publish_config = database.publish_config().map_err(|e| e.to_string())?;
            let mut restore_attempt = operation_lease.into_restore_attempt()?;
            let pending = {
                let bm = state.backup_manager.lock().await;
                match bm
                    .restore_backup(&backup_id, &data_dir, &mut database)
                    .await
                {
                    Ok(pending) => pending,
                    Err(error) => {
                        if backup::restore_error_requires_recovery(&error) {
                            state
                                .operation_coordinator
                                .quarantine_after_restore_failure(error.to_string());
                        }
                        if backup::restore_error_rolled_back(&error) {
                            match db::Database::open_at_path(&data_dir.join("plainsong.db"), None) {
                                Ok(reopened) => {
                                    *database = reopened;
                                }
                                Err(reopen_error) => {
                                    state.operation_coordinator.quarantine_after_restore_failure(
                                        format!("Original database could not reopen after restore failure: {reopen_error}"),
                                    );
                                }
                            }
                        }
                        restore_attempt.resolve();
                        return Err(error.to_string());
                    }
                }
            };
            let outcome = pending.outcome();
            let adoption = if outcome.restored_database {
                match db::Database::open_at_path(&data_dir.join("plainsong.db"), None) {
                    Ok(mut reopened) => {
                        // A backup cannot re-enable publishing or replace the
                        // folder the user most recently approved.
                        let saved = reopened
                            .save_publish_config(&previous_publish_config)
                            .map_err(|error| {
                                format!("Failed to preserve folder publishing settings: {error}")
                            });
                        *database = reopened;
                        saved
                    }
                    Err(error) => Err(format!("Failed to reopen restored database: {error}")),
                }
            } else {
                Ok(())
            };
            drop(database);
            let acceptance = match adoption {
                Ok(()) if outcome.restored_settings => {
                    reload_settings_after_restore(state.as_ref(), handle).await
                }
                result => result,
            };
            if let Err(error) = acceptance {
                let mut failures = vec![error];
                let mut recovery_failed = false;
                let mut database = state.db.lock().await;
                if outcome.restored_database {
                    if let Err(close_error) = database.close_for_restore() {
                        let message =
                            format!("Cannot close restored database for recovery: {close_error}");
                        state
                            .operation_coordinator
                            .quarantine_after_restore_failure(message.clone());
                        restore_attempt.resolve();
                        return Err(message);
                    }
                }
                if let Err(recovery_error) = pending.rollback().await {
                    recovery_failed = true;
                    failures.push(format!("File recovery incomplete: {recovery_error}"));
                }
                if outcome.restored_database && !recovery_failed {
                    match db::Database::open_at_path(&data_dir.join("plainsong.db"), None) {
                        Ok(reopened) => {
                            *database = reopened;
                        }
                        Err(recovery_error) => {
                            recovery_failed = true;
                            failures.push(format!("Original database could not reopen after rollback: {recovery_error}"));
                        }
                    }
                }
                drop(database);
                if outcome.restored_settings {
                    *state.settings_manager.lock().await.settings_mut() = previous_settings.clone();
                    if let Err(recovery_error) = apply_restored_settings_to_runtime(
                        state.as_ref(),
                        handle,
                        previous_settings
                            .transcription
                            .meeting_custom_prompt
                            .clone(),
                        previous_settings,
                    )
                    .await
                    {
                        recovery_failed = true;
                        failures.push(format!(
                            "Runtime settings recovery incomplete: {recovery_error}"
                        ));
                    }
                }
                let message = failures.join("; ");
                if recovery_failed {
                    state
                        .operation_coordinator
                        .quarantine_after_restore_failure(message.clone());
                }
                restore_attempt.resolve();
                return Err(message);
            }
            if let Err(error) = pending.accept().await {
                state
                    .operation_coordinator
                    .quarantine_after_restore_failure(error.to_string());
                restore_attempt.resolve();
                return Err(error.to_string());
            }
            restore_attempt.resolve();
            Ok(serde_json::Value::Null)
        }
        "verify_backup_cloud_connection" => {
            let bm = state.backup_manager.lock().await;
            bm.verify_cloud_connection()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_backup_setup_report" => {
            let bm = state.backup_manager.lock().await;
            let report = bm.cloud_setup_report().await;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        "sync_backup_to_cloud" => {
            let backup_id: String =
                serde_json::from_value(params["backupId"].clone()).map_err(|e| e.to_string())?;
            let bm = state.backup_manager.lock().await;
            bm.sync_backup_to_cloud(&backup_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "export_backup_archive" => {
            let backup_id: String =
                serde_json::from_value(params["backupId"].clone()).map_err(|e| e.to_string())?;
            let target_path: String =
                serde_json::from_value(params["targetPath"].clone()).map_err(|e| e.to_string())?;
            let canonical_target = canonicalize_existing_absolute_path(&target_path, "targetPath")?;
            if !canonical_target.is_dir() {
                return Err(format!(
                    "targetPath must be an existing directory, got '{}'",
                    canonical_target.display()
                ));
            }
            ensure_path_in_approved_roots(&canonical_target, "targetPath")?;
            let bm = state.backup_manager.lock().await;
            bm.export_backup(&backup_id, &canonical_target)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }

        // ── Updates (check and install are handled by Electron main) ─────────
        "check_for_updates" => Ok(serde_json::Value::Null),
        "install_update" => Ok(serde_json::Value::Null),
        "get_update_status" => Ok(serde_json::json!({ "status": "unknown" })),
        "get_update_channel" => {
            let settings = state.settings_manager.lock().await.settings().clone();
            serde_json::to_value(settings.updates.channel.to_string()).map_err(|e| e.to_string())
        }
        "set_update_channel" => {
            let channel: String =
                serde_json::from_value(params["channel"].clone()).map_err(|e| e.to_string())?;
            let updated = {
                let mut settings_manager = state.settings_manager.lock().await;
                settings_manager.settings_mut().updates.channel =
                    settings::UpdateChannel::from(channel);
                settings_manager.save().map_err(|e| e.to_string())?;
                settings_manager.settings().clone()
            };
            emit_settings_changed(handle, &updated);
            Ok(serde_json::Value::Null)
        }

        _ => Err(format!("Unknown command: {}", method)),
    }
}

#[cfg(test)]
mod benchmark_dispatch_tests {
    #[test]
    fn bytes_benchmark_dispatches_owned_bytes_without_a_temp_file() {
        const SOURCE: &str = include_str!("dispatch.rs");
        let start = SOURCE
            .find("\"benchmark_asr_providers_bytes\" => {")
            .expect("bytes benchmark dispatch arm");
        let end = SOURCE[start..]
            .find("\"set_default_asr_provider\" => {")
            .expect("next dispatch arm")
            + start;
        let body = &SOURCE[start..end];

        assert!(body.contains("benchmark_providers_bytes(audio_bytes)"));
        assert!(!body.contains("temp_dir"));
        assert!(!body.contains("std::fs::write"));
        assert!(!body.contains("remove_file"));
    }
}

#[cfg(test)]
mod dictation_start_error_race_tests {
    use super::publish_dictation_start_error_if_idle;
    use crate::sidecar_handle::AppEmitter;
    use crate::DictationSessionTracker;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::{Barrier, Mutex};

    #[derive(Clone, Default)]
    struct TestEmitter(Arc<StdMutex<Vec<String>>>);

    impl AppEmitter for TestEmitter {
        fn emit_event<P: serde::Serialize + Clone + Send>(&self, _event: &str, payload: P) {
            let payload = serde_json::to_value(payload).expect("serialize event");
            self.0
                .lock()
                .expect("event lock")
                .push(payload["phase"].as_str().expect("phase").to_string());
        }
    }

    #[test]
    fn stale_start_error_never_publishes_after_replacement_start() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            for _ in 0..64 {
                let tracker = Arc::new(Mutex::new(DictationSessionTracker::default()));
                let emitter = TestEmitter::default();
                let barrier = Arc::new(Barrier::new(2));

                let stale_tracker = Arc::clone(&tracker);
                let stale_emitter = emitter.clone();
                let stale_barrier = Arc::clone(&barrier);
                let stale = tokio::spawn(async move {
                    stale_barrier.wait().await;
                    publish_dictation_start_error_if_idle(
                        stale_tracker.as_ref(),
                        &stale_emitter,
                        "old start failed",
                    )
                    .await;
                });

                let replacement_tracker = Arc::clone(&tracker);
                let replacement_emitter = emitter.clone();
                let replacement_barrier = Arc::clone(&barrier);
                let replacement = tokio::spawn(async move {
                    replacement_barrier.wait().await;
                    replacement_tracker.lock().await.active_session_id = Some(2);
                    replacement_emitter.emit_event(
                        "dictation-state-changed",
                        serde_json::json!({ "phase": "preparing", "sessionId": 2 }),
                    );
                });

                stale.await.expect("stale task");
                replacement.await.expect("replacement task");
                let phases = emitter.0.lock().expect("event lock").clone();
                assert_ne!(phases, ["preparing", "error"]);
                assert_eq!(phases.last().map(String::as_str), Some("preparing"));
            }
        });
    }

    #[test]
    fn force_stop_releases_tracker_before_waiting_for_audio() {
        const SOURCE: &str = include_str!("dispatch.rs");
        let start = SOURCE
            .find("\"force_stop_dictation\" => {")
            .expect("force stop");
        let end = SOURCE[start..]
            .find("\"get_dictation_audio_level\" => {")
            .expect("next dispatch arm")
            + start;
        let body = &SOURCE[start..end];
        let release = body.find("drop(tracker);").expect("tracker release");
        let audio = body
            .find("state.audio_capture.lock().await")
            .expect("audio cleanup");
        assert!(
            release < audio,
            "force-stop must not wait for audio while holding tracker"
        );
    }
}

#[cfg(test)]
mod meeting_chat_citation_tests {
    use super::normalize_meeting_chat_citation;
    use crate::store::MeetingChatCitationRecord;

    #[test]
    fn normalization_preserves_written_note_identity() {
        let normalized = normalize_meeting_chat_citation(MeetingChatCitationRecord {
            text: "  Ship the revised brief  ".to_string(),
            source_kind: Some(" meeting_note ".to_string()),
            line_id: Some(" L7 ".to_string()),
            segment_id: Some(" meeting-note:4 ".to_string()),
            start_time: None,
            end_time: None,
            recording_id: Some(" recording-1 ".to_string()),
            certainty: Some(1.0),
        })
        .expect("citation remains valid");

        assert_eq!(normalized.text, "Ship the revised brief");
        assert_eq!(normalized.source_kind.as_deref(), Some("meeting_note"));
        assert_eq!(normalized.line_id.as_deref(), Some("L7"));
        assert_eq!(normalized.segment_id.as_deref(), Some("meeting-note:4"));
        assert_eq!(normalized.start_time, None);
        assert_eq!(normalized.end_time, None);
        assert_eq!(normalized.recording_id.as_deref(), Some("recording-1"));
    }
}

#[cfg(test)]
mod saved_prompt_write_parser_tests {
    use super::*;

    #[test]
    fn nested_and_flat_legacy_requests_replace_library() {
        let mut settings = settings::Settings::default();
        settings.ai.saved_prompts = vec![settings::SavedPrompt {
            id: "legacy".into(),
            ..Default::default()
        }];
        let flat = serde_json::to_value(&settings).unwrap();
        for payload in [flat.clone(), serde_json::json!({"settings": flat})] {
            let (parsed, preserve) = parse_save_settings_request(payload).unwrap();
            assert!(!preserve);
            assert_eq!(parsed.ai.saved_prompts[0].id, "legacy");
        }
    }

    #[test]
    fn nested_and_flat_metadata_is_explicit_and_removed() {
        let flat = serde_json::to_value(settings::Settings::default()).unwrap();
        for preserve in [false, true] {
            let mut flat_with_metadata = flat.clone();
            flat_with_metadata["preserveSavedPrompts"] = preserve.into();
            for payload in [
                flat_with_metadata,
                serde_json::json!({"settings": flat, "preserveSavedPrompts": preserve}),
            ] {
                let (parsed, actual) = parse_save_settings_request(payload).unwrap();
                assert_eq!(actual, preserve);
                assert!(serde_json::to_value(parsed)
                    .unwrap()
                    .get("preserveSavedPrompts")
                    .is_none());
            }
        }
    }

    #[test]
    fn malformed_preservation_metadata_is_rejected() {
        for metadata in [
            serde_json::Value::Null,
            serde_json::json!("true"),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            for nested in [false, true] {
                let mut payload = if nested {
                    serde_json::json!({"settings": {}})
                } else {
                    serde_json::json!({})
                };
                payload["preserveSavedPrompts"] = metadata.clone();
                assert!(parse_save_settings_request(payload).is_err());
            }
        }
        assert!(parse_save_settings_request(serde_json::json!([])).is_err());
        assert!(parse_save_settings_request(serde_json::json!({"settings": null})).is_err());
    }

    #[test]
    fn setter_requires_a_list_and_rejects_unknown_metadata() {
        assert!(
            parse_set_saved_prompts_request(serde_json::json!({"savedPrompts": []}))
                .unwrap()
                .is_empty()
        );
        for payload in [
            serde_json::json!({}),
            serde_json::json!({"savedPrompts": null}),
            serde_json::json!({"savedPrompts": {}}),
            serde_json::json!({"savedPrompts": [1]}),
            serde_json::json!({"savedPrompts": [], "preserveSavedPrompts": true}),
        ] {
            assert!(parse_set_saved_prompts_request(payload).is_err());
        }
    }
}

#[cfg(test)]
mod asr_runtime_diagnostics_request_tests {
    use super::*;

    #[test]
    fn exact_model_metadata_is_optional_but_strict_when_present() {
        let legacy =
            parse_asr_runtime_diagnostics_request(serde_json::json!({"providerType": "whisper"}))
                .unwrap();
        assert!(legacy.model_id.is_none());
        let exact = parse_asr_runtime_diagnostics_request(
            serde_json::json!({"providerType": "whisper", "modelId": "small.en"}),
        )
        .unwrap();
        assert_eq!(exact.model_id.as_deref(), Some("small.en"));
        for value in [
            serde_json::json!("unknown-model"),
            serde_json::Value::Null,
            serde_json::json!(false),
            serde_json::json!(42),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!(""),
            serde_json::json!(" "),
            serde_json::json!(" small.en "),
        ] {
            assert!(parse_asr_runtime_diagnostics_request(
                serde_json::json!({"providerType": "whisper", "modelId": value}),
            )
            .is_err());
        }
        assert!(parse_asr_runtime_diagnostics_request(
            serde_json::json!({"providerType": "whisper", "modelID": "small.en"}),
        )
        .is_err());
    }
}

#[cfg(test)]
mod settings_patch_request_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_settings_patch_envelope_rejects_mixed_and_unknown_fields() {
        for payload in [
            json!({"settings": {}, "patch": []}),
            json!({"patch": null}),
            json!({"patch": [], "unexpected": true}),
            json!({"patch": [], "preserveSavedPrompts": null}),
        ] {
            assert!(parse_settings_update_request(payload).is_err());
        }
        let (update, preserve) =
            parse_settings_update_request(json!({"patch": [], "preserveSavedPrompts":true}))
                .unwrap();
        assert!(preserve);
        assert!(matches!(update, settings_patch::SettingsUpdate::Patch(_)));
    }

    #[test]
    fn save_settings_update_keeps_legacy_raw_and_enveloped_requests() {
        for payload in [json!({}), json!({"settings": {}})] {
            let (update, preserve) = parse_settings_update_request(payload).unwrap();
            assert!(!preserve);
            assert!(matches!(update, settings_patch::SettingsUpdate::Replace(_)));
        }
    }
}

#[cfg(test)]
mod note_publishing_deletion_tests {
    use super::*;
    #[test]
    fn publishing_deletion_checks_capture_before_touching_the_published_file() {
        let mut db = db::Database::new_in_memory_for_test().unwrap();
        for (status, message) in [
            ("recording", "Stop the meeting"),
            ("processing", "Wait for meeting processing"),
        ] {
            let recording:models::Recording=serde_json::from_value(serde_json::json!({"id":status,"title":"Meeting","projectId":"default","duration":0,"createdAt":"2026-10-23T12:00:00Z","updatedAt":"2026-10-23T12:00:00Z","sourceType":"meeting","audioPath":"","status":status})).unwrap();
            db.create_recording(&recording).unwrap();
            assert!(deletable_recording_bundle(&db, status)
                .err()
                .unwrap()
                .contains(message));
        }
        assert!(deletable_recording_bundle(&db, "missing").is_err());
    }
}
