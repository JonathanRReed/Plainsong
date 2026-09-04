//! One dictation session, from hotkey to inserted text.
//!
//! Starting capture (including the VAD model resolution and the partial-decode
//! tasks), and the stop path: taking ownership of the session, running the
//! pre-insert passes under their timeouts, delivering the text, recording the
//! result so a repaste can reuse it, and failing in a way that always resets
//! the runtime state instead of wedging the hotkey. The overlay idle reset and
//! the post-insert correction readback close the session out.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

/// Compose the done-phase message for a finished dictation session.
///
/// A session that degraded (an LLM pass that failed or timed out, a command
/// with no text to work on) still reports as done, but the warning describes
/// the *formatting* pass while the outcome describes where the text actually
/// went. Leading with the warning alone used to hide the outcome entirely —
/// so a clipboard-only fallback, or a delivery that failed outright, read as
/// an ordinary success. Say what happened to the text first, then why it is
/// not quite what was asked for.
/// What the delivery step observed, reduced to the terminal `outcome` string
/// the overlay, the audit log and the renderer key on.
pub(crate) struct DictationDeliveryFacts<'a> {
    pub(crate) pasted: bool,
    pub(crate) copied: bool,
    /// The target was observed to take the text (direct Accessibility write),
    /// as opposed to a Cmd+V that was merely dispatched.
    pub(crate) confirmed: bool,
    pub(crate) undo_performed: bool,
    /// The secure-field policy refused delivery: nothing inserted, nothing
    /// on the clipboard. Distinct from `error` so the renderer can say why.
    pub(crate) secure_field_refused: bool,
    pub(crate) has_paste_error: bool,
    /// The outcome already set before delivery ran (an undo-only session,
    /// or nothing at all), kept when delivery reported nothing.
    pub(crate) previous: &'a str,
}

pub(crate) fn resolve_dictation_delivery_outcome(facts: DictationDeliveryFacts<'_>) -> String {
    if facts.pasted {
        if facts.undo_performed {
            "replaced".to_string()
        } else if facts.confirmed {
            "pasted".to_string()
        } else {
            // Dispatched via Cmd+V with no read-back. Claiming a confirmed
            // insert here is what let the app tell users it had typed text
            // into an app that never took it.
            "paste_dispatched".to_string()
        }
    } else if facts.copied {
        if facts.undo_performed {
            "copied_replacement".to_string()
        } else {
            "copied".to_string()
        }
    } else if facts.secure_field_refused {
        dictation_secure_field::SECURE_FIELD_REASON_CODE.to_string()
    } else if facts.has_paste_error {
        "error".to_string()
    } else {
        facts.previous.to_string()
    }
}

pub(crate) fn dictation_done_message(
    outcome: &str,
    final_text_is_empty: bool,
    warnings: &[String],
) -> String {
    let outcome_message = match outcome {
        "pasted" | "replaced" => "Inserted into the target app.",
        // Refused on purpose: the focused control is a password or other
        // secure input. Says so, says nothing was copied either, and says
        // where the words are.
        dictation_secure_field::SECURE_FIELD_REASON_CODE => {
            "Not inserted: the field in front is a password or secure input. Plainsong did not insert or copy the words; they are saved in your dictation history."
        }
        // The paste keystroke was sent but nothing reported back that the app
        // took it, so this says what actually happened and leaves the user a
        // next step. The text stays on the clipboard for exactly this case.
        "paste_dispatched" => {
            "Sent to the target app. If nothing appeared, press Cmd+V to paste it."
        }
        "copied" | "copied_replacement" => "Copied to the clipboard and ready to paste.",
        "previewed" => "Ready in Plainsong.",
        "undone" => "Undo applied.",
        "error" => "Could not deliver the text. It is saved in your dictation history.",
        _ if final_text_is_empty => "No speech detected.",
        _ => "Result ready.",
    };

    if warnings.is_empty() {
        outcome_message.to_string()
    } else {
        format!("{} {}", outcome_message, warnings.join(" "))
    }
}

pub(crate) fn should_deliver_dictation_text(delivery_mode: models::DictationDeliveryMode) -> bool {
    delivery_mode == models::DictationDeliveryMode::System
}

pub(crate) fn should_insert_dictation_result(
    final_text: &str,
    command_applied: Option<&str>,
    undo_previous_insert: bool,
    undo_performed: bool,
) -> bool {
    (!final_text.trim().is_empty()
        || matches!(command_applied, Some("delete_selection" | "delete_phrase")))
        && replacement_insertion_is_authorized(undo_previous_insert, undo_performed)
}

/// Resolve the on-disk path to the Silero VAD ONNX model, but only when
/// `vad_backend` actually calls for it -- when the energy-threshold backend
/// is selected, skip touching the filesystem/download-manager entirely and
/// return `None`, since `build_vad_gate` never consults it in that case.
///
/// Returns `None` (rather than erroring) if the download manager can't be
/// constructed or the model hasn't been downloaded yet; both are handled,
/// expected cases that `crate::audio::silero_vad::build_vad_gate` already
/// treats as "fall back to energy-threshold".
pub(crate) fn resolve_silero_vad_model_path(
    vad_backend: audio::vad::VadBackendKind,
) -> Option<std::path::PathBuf> {
    if vad_backend != audio::vad::VadBackendKind::Silero {
        return None;
    }
    let manager = download::DownloadManager::new().ok()?;
    if !manager.is_silero_vad_model_downloaded() {
        return None;
    }
    Some(manager.silero_vad_model_path())
}

/// Sidecar-compatible start_dictation: simplified version that emits events via SidecarHandle.
/// Full overlay sync and tray updates are handled by Electron.
/// Handles captured under the audio lock to drive the UI-only streaming-partial
/// task: (partial sample buffer, is-dictating flag, capture sample rate).
pub(crate) type PartialTaskHandles = (
    Arc<std::sync::Mutex<audio::DictationPartialBuffer>>,
    Arc<AtomicBool>,
    u32,
);

pub(crate) async fn start_dictation_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut options: models::DictationStartOptions,
) -> Result<u64, String> {
    let mut settings_snapshot = {
        let sm = state.settings_manager.lock().await;
        sm.settings().clone()
    };
    // A per-mode binding runs this one session under its mode; the snapshot
    // is what every mode-dependent decision below reads, and the options are
    // stored as the session record so stop applies the same override.
    apply_dictation_session_mode_override(&mut settings_snapshot, &mut options);
    let requested_selection = resolve_transcription_provider_and_model(
        &settings_snapshot.transcription,
        TranscriptionScope::Dictation,
    );

    let (
        dictation_provider,
        dictation_model_id,
        resolved_route_preference,
        resolved_hosting,
        provider_warning,
    ) = resolve_ready_dictation_selection(
        state,
        &settings_snapshot.transcription,
        options.route_preference.as_deref(),
        settings_snapshot.privacy.remote_processing_enabled,
    )
    .await?;

    if let Some(warning) = provider_warning.as_deref() {
        handle.emit_event("asr-provider-warning", warning.to_string());
    }

    let requested_provider_value =
        asr_provider_to_settings_value(requested_selection.0).to_string();
    let requested_model_id_value = requested_selection.1.clone();
    let actual_provider_value = asr_provider_to_settings_value(dictation_provider).to_string();
    let actual_model_id_value = dictation_model_id.clone();

    options.requested_provider = Some(requested_provider_value.clone());
    options.requested_model_id = Some(requested_model_id_value.clone());
    options.actual_provider = Some(actual_provider_value.clone());
    options.actual_model_id = Some(actual_model_id_value.clone());
    options.route_preference =
        Some(dictation_route_preference_to_settings_value(resolved_route_preference).to_string());
    options.resolved_route = Some(format!(
        "{}/{}",
        asr_provider_to_settings_value(dictation_provider),
        dictation_model_id
    ));
    options.provider_model_label = Some(format!(
        "{} · {}",
        dictation_provider.display_name(),
        dictation_model_id
    ));
    options.resolved_hosting =
        Some(hosting_environment_to_settings_value(resolved_hosting).to_string());
    capture_sidecar_dictation_start_context(state, &settings_snapshot, &mut options).await;

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Idle {
            return Err("Dictation is already active".to_string());
        }
        let (has_mic, meeting_recording) = {
            let audio = state.audio_capture.lock().await;
            (audio.has_microphone_input(), audio.is_recording())
        };
        if meeting_recording {
            return Err("Cannot start dictation while a meeting recording is active".to_string());
        }
        if !has_mic {
            return Err(
                "No microphone available. Please connect a microphone and grant permission."
                    .to_string(),
            );
        }
        *runtime_state = DictationSessionState::Starting;
    }

    let session_started_at_ms = chrono::Utc::now().timestamp_millis();
    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.next_session_id += 1;
        tracker.active_session_id = Some(tracker.next_session_id);
        // A new session never inherits the previous session's stop claim.
        tracker.stopping_session_id = None;
        tracker.started_at = Some(std::time::Instant::now());
        tracker.started_at_epoch_ms = Some(session_started_at_ms);
        tracker.startup_latency_ms = None;
        tracker.acknowledged_at_epoch_ms = None;
        tracker.capture_ready_at_epoch_ms = None;
        tracker.first_stable_partial_at_epoch_ms = None;
        tracker.stop_requested_at = None;
        tracker.final_transcript_at_epoch_ms = None;
        tracker.insertion_completed_at_epoch_ms = None;
        tracker.insertion_mode_at_start = Some(DictationInsertionMode::from_settings_value(
            &settings_snapshot.transcription.dictation_insertion_mode,
        ));
        tracker.copy_to_clipboard_at_start =
            Some(settings_snapshot.transcription.dictation_copy_to_clipboard);
        tracker.next_session_id
    };

    {
        let mut active_options = state.dictation_start_options.lock().await;
        *active_options = options.clone();
    }

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "preparing".to_string();
        overlay.dismissed = false;
        overlay.session_id = Some(session_id);
        overlay.started_at_ms = Some(session_started_at_ms);
        overlay.message = Some("Loading the selected dictation model".to_string());
        overlay.dictation_provider =
            Some(asr_provider_to_settings_value(dictation_provider).to_string());
        overlay.dictation_model_id = Some(dictation_model_id.clone());
        overlay.model_readiness = Some("loading".to_string());
        overlay.capture_ready = false;
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "preparing",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "message": "Loading the selected dictation model",
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "modelReadiness": "loading",
            "captureReady": false,
        }),
    );
    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id) {
            tracker.acknowledged_at_epoch_ms = Some(chrono::Utc::now().timestamp_millis());
        }
    }
    handle.window_command("show-dictation-overlay", &serde_json::Value::Null);

    state
        .asr_manager
        .set_provider_model_id(dictation_provider, dictation_model_id.clone())
        .await;

    let startup_result: Result<DictationModelWarmState, String> = async {
        #[cfg(target_os = "macos")]
        ensure_microphone_permission(
            settings_snapshot
                .transcription
                .dictation_auto_request_permissions,
        )
        .map_err(|error| format!("Microphone permission is not ready. {}", error))?;

        #[cfg(target_os = "macos")]
        if dictation_provider == asr::AsrProviderType::MacosAppleSpeech {
            crate::asr::platform::macos_speech::ensure_speech_authorized(
                settings_snapshot
                    .transcription
                    .dictation_auto_request_permissions,
            )
            .map_err(|error| {
                format!(
                    "Apple Native Speech is selected for dictation, but speech recognition permission is not ready. {}",
                    error
                )
            })?;
        }

        prepare_dictation_model(
            dictation_provider,
            &dictation_model_id,
            &settings_snapshot.transcription.dictation_keep_warm,
        )
        .await
    }
    .await;

    let model_warm_state = match startup_result {
        Ok(model_warm_state) => model_warm_state,
        Err(error) => {
            let cleaned_current_session = reset_dictation_session_runtime_if_current(
                &state.dictation_runtime_state,
                &state.dictation_session_tracker,
                &state.dictation_start_options,
                session_id,
            )
            .await;
            if cleaned_current_session {
                if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                    if overlay.session_id == Some(session_id) {
                        overlay.phase = "error".to_string();
                        overlay.message = Some(error.clone());
                        overlay.model_readiness = Some("error".to_string());
                        overlay.capture_ready = false;
                    }
                }
                handle.emit_event(
                    "dictation-state-changed",
                    serde_json::json!({
                        "phase": "error",
                        "sessionId": session_id,
                        "message": error,
                        "modelReadiness": "error",
                        "captureReady": false,
                    }),
                );
            }
            return Err(error);
        }
    };

    // A cancellation can land while a cold model is loading. Do not let the
    // completed warmup resurrect that cancelled session and open the mic.
    if state
        .dictation_session_tracker
        .lock()
        .await
        .active_session_id
        != Some(session_id)
    {
        return Err("Dictation start was cancelled".to_string());
    }
    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Starting {
            return Err("Dictation start was cancelled".to_string());
        }
        *runtime_state = DictationSessionState::Primed;
    }

    let primed_message = match model_warm_state {
        DictationModelWarmState::Ready => "Local model ready. Opening the microphone.",
        DictationModelWarmState::Deferred => {
            "Opening the microphone. The local model will load after capture."
        }
        DictationModelWarmState::NotRequired => "Opening the microphone.",
    };

    // Update overlay state so get_dictation_overlay_state returns the correct snapshot.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "primed".to_string();
        overlay.dismissed = false;
        overlay.session_id = Some(session_id);
        overlay.started_at_ms = Some(session_started_at_ms);
        overlay.message = Some(primed_message.to_string());
        overlay.model_readiness = Some(model_warm_state.as_event_value().to_string());
        overlay.capture_ready = false;
        overlay.dictation_provider =
            Some(asr_provider_to_settings_value(dictation_provider).to_string());
        overlay.dictation_model_id = Some(dictation_model_id.clone());
        overlay.requested_provider = Some(requested_provider_value.clone());
        overlay.actual_provider = Some(actual_provider_value.clone());
        overlay.requested_model_id = Some(requested_model_id_value.clone());
        overlay.actual_model_id = Some(actual_model_id_value.clone());
        overlay.fallback_reason = provider_warning.clone();
        overlay.target_app = options.context_app_name.clone();
        overlay.resolved_mode_preset = options.resolved_mode_preset.clone();
        overlay.resolved_custom_mode_id = options.resolved_custom_mode_id.clone();
        overlay.resolved_mode_label = options.resolved_mode_label.clone();
        overlay.context_source = Some(options.context_source.clone());
        overlay.insertion_mode = Some(
            normalize_dictation_insertion_mode(
                &settings_snapshot.transcription.dictation_insertion_mode,
            )
            .to_string(),
        );
        overlay.app_target = options.context_app_name.clone();
        overlay.activation_matcher = options.activation_matcher.clone();
        overlay.requested_route = options.route_preference.clone();
        overlay.resolved_route = options.resolved_route.clone();
        overlay.provider_model_label = options.provider_model_label.clone();
        overlay.dictation_route_preference = options.route_preference.clone();
        overlay.dictation_resolved_hosting = options.resolved_hosting.clone();
    }

    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "primed",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "message": primed_message,
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "requestedProvider": requested_provider_value,
            "actualProvider": actual_provider_value,
            "requestedModelId": requested_model_id_value,
            "actualModelId": actual_model_id_value,
            "fallbackReason": provider_warning,
            "targetApp": options.context_app_name,
            "resolvedModePreset": options.resolved_mode_preset,
            "resolvedCustomModeId": options.resolved_custom_mode_id,
            "resolvedModeLabel": options.resolved_mode_label,
            "contextSource": options.context_source,
            "insertionMode": normalize_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode),
            "appTarget": options.context_app_name,
            "activationMatcher": options.activation_matcher,
            "requestedRoute": options.route_preference,
            "resolvedRoute": options.resolved_route,
            "providerModelLabel": options.provider_model_label,
            "dictationRoutePreference": options.route_preference,
            "dictationResolvedHosting": options.resolved_hosting,
            "modelReadiness": model_warm_state.as_event_value(),
            "captureReady": false,
        }),
    );

    // Tell Electron to show the dictation overlay window.
    handle.window_command("show-dictation-overlay", &serde_json::Value::Null);

    let preferred_input_device = {
        let sm = state.settings_manager.lock().await;
        let settings = sm.settings();
        if settings.audio.dictation_input_override_enabled {
            settings.audio.dictation_input_device.clone()
        } else {
            settings.audio.preferred_input_device.clone()
        }
    };

    // Which engine draws the live preview, if any. The re-decode preview is
    // UI-only and only runs for local providers (cloud providers must not be
    // hit per-tick); Apple Speech is excluded because that generic mechanism
    // repeatedly batch-decodes the growing WAV buffer, which would launch a new
    // helper process about every 700 ms. Streaming replaces the *preview*
    // only -- the inserted text is the batch decode either way.
    let live_preview_language = options.language_override.clone();
    let live_preview_engine = resolve_dictation_live_preview_engine(DictationLivePreviewInputs {
        live_preview_enabled: settings_snapshot
            .transcription
            .dictation_live_preview_enabled,
        engine_setting: &settings_snapshot
            .transcription
            .dictation_live_preview_engine,
        provider_supports_redecode: provider_supports_generic_live_preview(dictation_provider),
        streaming_compiled_in: streaming_live_preview_compiled_in(),
        streaming_model_ready: streaming_live_preview_model_ready(),
        streaming_language_supported: streaming_live_preview_supports_language(
            live_preview_language.as_deref(),
        ),
    });
    // Both engines read the same UI-only sample buffer, so the capture callback
    // fills it for either.
    let streaming_partials_enabled = live_preview_engine != DictationLivePreviewEngine::Off;

    // Auto-stop after sustained silence: gated on `dictation_silence_timeout_seconds`
    // (0 = disabled, matching the field's existing "0 disables" contract already
    // used by the settings UI/normalizer). Works regardless of activation mode
    // (toggle, push-to-talk, or hands-free) since it just stops the session the
    // same way a manual stop would.
    //
    // Hands-free is a special case: it starts the session automatically on
    // detected speech, so if silence auto-stop is left disabled it would never
    // stop on its own. The Settings UI ("Hands-free guide") promises a 1.8s
    // fallback in that case, so apply it here.
    let effective_silence_timeout_seconds = resolve_dictation_auto_stop_silence_timeout_seconds(
        settings_snapshot.transcription.dictation_hands_free_enabled,
        settings_snapshot
            .transcription
            .dictation_silence_timeout_seconds,
    );
    let vad_backend = audio::vad::VadBackendKind::from_settings_str(
        &settings_snapshot.transcription.dictation_vad_backend,
    );
    let auto_stop_config = audio::DictationAutoStopConfig {
        enabled: effective_silence_timeout_seconds > 0.0,
        silence_timeout_seconds: effective_silence_timeout_seconds,
        vad_backend,
        silero_model_path: resolve_silero_vad_model_path(vad_backend),
    };

    // Handles captured under the audio lock when capture starts successfully, so
    // the partial-decode task can be spawned after the lock is released.
    let mut partial_task_handles: Option<PartialTaskHandles> = None;

    {
        let mut audio = state.audio_capture.lock().await;
        if *state.dictation_runtime_state.lock().await != DictationSessionState::Primed {
            return Err("Dictation start was cancelled".to_string());
        }
        audio.set_streaming_partials_enabled(streaming_partials_enabled);
        match audio.start_dictation(
            preferred_input_device.as_ref(),
            session_id,
            auto_stop_config,
            Some(handle.clone()),
            // Only a start the hands-free monitor itself asked for may inherit
            // the monitor's pre-roll. `dispatch_command` stops the monitor
            // immediately before every start, so the ring is always fresh
            // enough to pass `take_dictation_pre_roll`'s age guard — this flag
            // is what keeps a hotkey press from picking it up.
            options.hands_free_trigger,
        ) {
            Ok(resolved_input) => {
                if let Some(advisory) = resolved_input.advisory.as_deref() {
                    handle.emit_event("audio-input-advisory", advisory.to_string());
                }
                if streaming_partials_enabled {
                    partial_task_handles = Some((
                        audio.dictation_partial_buffer_handle(),
                        audio.is_dictating_handle(),
                        audio.dictation_sample_rate(),
                    ));
                }
            }
            Err(e) => {
                let mut runtime_state = state.dictation_runtime_state.lock().await;
                *runtime_state = DictationSessionState::Idle;
                drop(runtime_state);
                let mut tracker = state.dictation_session_tracker.lock().await;
                if tracker.active_session_id == Some(session_id) {
                    tracker.active_session_id = None;
                    tracker.stopping_session_id = None;
                }
                if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                    *overlay = DictationOverlayState::default();
                }
                handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
                return Err(format!("Failed to start audio capture: {}", e));
            }
        }
    }

    // Starting capture is synchronous but force-stop runs on another request
    // task. Publish Recording only while this start still owns the session.
    // If cancellation won immediately after capture opened, close the stream
    // we just created instead of resurrecting an untracked microphone.
    let owns_session = {
        let tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id) {
            let mut runtime_state = state.dictation_runtime_state.lock().await;
            if *runtime_state == DictationSessionState::Primed {
                *runtime_state = DictationSessionState::Recording;
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if !owns_session {
        state
            .audio_capture
            .lock()
            .await
            .abort_dictation_for_session(session_id);
        return Err("Dictation start was cancelled".to_string());
    }

    // Spawn the UI-only live-preview task. Both engines emit live-preview text
    // and NEITHER feeds the final transcript: the only thing they write is a
    // `partialText` field on `dictation-state-changed`. Best-effort; they
    // swallow their own errors and stop when dictation does.
    if let Some((partial_buffer, is_dictating, sample_rate)) = partial_task_handles.clone() {
        if live_preview_engine == DictationLivePreviewEngine::Streaming {
            // Signal and abort any preview still in the slot *before* spawning
            // this one: the new task waits for the single engine permit, and
            // the old one only releases it once its recognizer is dropped.
            {
                let mut slot = state.dictation_live_preview.lock().await;
                if let Some(previous) = slot.take() {
                    previous
                        .stop
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    previous.task.abort();
                }
            }
            // The streaming preview is held in AppState rather than detached,
            // because the stop path has to be able to close the recognizer
            // before the batch decode that produces the inserted text starts.
            let control = spawn_streaming_live_preview(
                Arc::clone(&state.dictation_session_tracker),
                handle.clone(),
                session_id,
                partial_buffer,
                is_dictating,
                sample_rate,
                live_preview_language.clone(),
            );
            state.dictation_live_preview.lock().await.replace(control);
        }
    }
    if let Some((partial_buffer, is_dictating, sample_rate)) =
        partial_task_handles.filter(|_| live_preview_engine == DictationLivePreviewEngine::Redecode)
    {
        let asr_manager = Arc::clone(&state.asr_manager);
        let session_tracker = Arc::clone(&state.dictation_session_tracker);
        let provider = dictation_provider;
        let model_id = dictation_model_id.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut last_decoded_total_samples: u64 = 0;
            let mut last_decode_finished_at = std::time::Instant::now();
            let mut last_emitted_text = String::new();
            while is_dictating.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(DICTATION_PARTIAL_POLL_MS)).await;

                // Stop promptly if dictation ended or a NEWER session started.
                // Gating on the monotonic active session id (not the shared
                // is_dictating flag, which a rapid stop->restart flips back to
                // true) prevents a stale in-flight task from emitting a
                // wrong-session partial that would disrupt the new session's UI.
                if session_tracker.lock().await.active_session_id != Some(session_id) {
                    break;
                }

                let (snapshot, total_samples) = {
                    partial_buffer
                        .lock()
                        .map(|buffer| (buffer.samples.clone(), buffer.total_samples))
                        .unwrap_or_default()
                };

                if !partial_should_decode(
                    total_samples,
                    last_decoded_total_samples,
                    sample_rate,
                    last_decode_finished_at.elapsed().as_millis() as u64,
                ) {
                    continue;
                }

                // Only recent audio may trigger another preview. Re-checking
                // the entire sliding window let old speech repeatedly decode
                // while the user was currently silent.
                if !partial_recent_window_has_speech(&snapshot, sample_rate) {
                    continue;
                }

                if !is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                    || session_tracker.lock().await.active_session_id != Some(session_id)
                {
                    break;
                }

                let bytes = match mono_samples_to_wav_bytes(&snapshot, sample_rate) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        tracing::debug!("Streaming partial wav encode failed: {}", error);
                        continue;
                    }
                };

                let result = asr_manager
                    .transcribe_bytes_for_dictation(provider, &bytes, Some(&model_id))
                    .await;
                last_decoded_total_samples = total_samples;
                last_decode_finished_at = std::time::Instant::now();

                match result {
                    Ok(transcription) => {
                        let text = transcription.text.trim().to_string();
                        // Re-check the live session id right before emit: the
                        // decode may have outlived the session it was started for.
                        let still_current = is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                            && session_tracker.lock().await.active_session_id == Some(session_id);
                        if still_current && !text.is_empty() && text != last_emitted_text {
                            {
                                let mut tracker = session_tracker.lock().await;
                                if tracker.active_session_id == Some(session_id)
                                    && tracker.first_stable_partial_at_epoch_ms.is_none()
                                {
                                    tracker.first_stable_partial_at_epoch_ms =
                                        Some(chrono::Utc::now().timestamp_millis());
                                }
                            }
                            handle.emit_event(
                                "dictation-state-changed",
                                serde_json::json!({
                                    "phase": "recording",
                                    "sessionId": session_id,
                                    "partialText": text,
                                }),
                            );
                            last_emitted_text = text;
                        }
                    }
                    Err(error) => {
                        tracing::debug!("Streaming partial decode failed: {}", error);
                    }
                }
            }
        });
    }

    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id) && tracker.startup_latency_ms.is_none() {
            tracker.startup_latency_ms = tracker.started_at.map(|started_at| {
                started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
            });
            tracker.capture_ready_at_epoch_ms = Some(chrono::Utc::now().timestamp_millis());
        }
    }

    // Update overlay state to "recording" phase (matches frontend DictationPhase type).
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "recording".to_string();
        overlay.message = Some("Listening".to_string());
        overlay.capture_ready = true;
    }

    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "recording",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "requestedProvider": asr_provider_to_settings_value(requested_selection.0),
            "actualProvider": asr_provider_to_settings_value(dictation_provider),
            "requestedModelId": requested_selection.1,
            "actualModelId": dictation_model_id,
            "targetApp": options.context_app_name,
            "resolvedModePreset": options.resolved_mode_preset,
            "resolvedCustomModeId": options.resolved_custom_mode_id,
            "resolvedModeLabel": options.resolved_mode_label,
            "contextSource": options.context_source,
            "insertionMode": normalize_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode),
            "appTarget": options.context_app_name,
            "activationMatcher": options.activation_matcher,
            "requestedRoute": options.route_preference,
            "resolvedRoute": options.resolved_route,
            "providerModelLabel": options.provider_model_label,
            "dictationRoutePreference": options.route_preference,
            "dictationResolvedHosting": options.resolved_hosting,
            "modelReadiness": model_warm_state.as_event_value(),
            "captureReady": true,
        }),
    );

    Ok(session_id)
}

/// Drop every piece of per-session dictation state, so the next hotkey press
/// starts a fresh session instead of stopping one that no longer exists.
///
/// Takes the individual handles rather than `&AppState` so it can be unit
/// tested without a database, audio device, or ASR manager.
pub(crate) async fn reset_dictation_session_runtime(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
) {
    {
        let mut runtime_state = runtime_state.lock().await;
        *runtime_state = DictationSessionState::Idle;
    }
    {
        let mut tracker = session_tracker.lock().await;
        tracker.active_session_id = None;
        tracker.stopping_session_id = None;
        tracker.started_at = None;
        tracker.started_at_epoch_ms = None;
        tracker.startup_latency_ms = None;
        tracker.acknowledged_at_epoch_ms = None;
        tracker.capture_ready_at_epoch_ms = None;
        tracker.first_stable_partial_at_epoch_ms = None;
        tracker.stop_requested_at = None;
        tracker.final_transcript_at_epoch_ms = None;
        tracker.insertion_completed_at_epoch_ms = None;
    }
    {
        let mut active_options = start_options.lock().await;
        *active_options = models::DictationStartOptions::default();
    }
}

pub(crate) async fn reset_dictation_session_runtime_if_current(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
    expected_session_id: u64,
) -> bool {
    let mut tracker = session_tracker.lock().await;
    if tracker.active_session_id != Some(expected_session_id) {
        return false;
    }
    let mut runtime_state = runtime_state.lock().await;
    let mut start_options = start_options.lock().await;
    *runtime_state = DictationSessionState::Idle;
    tracker.active_session_id = None;
    tracker.stopping_session_id = None;
    tracker.started_at = None;
    tracker.started_at_epoch_ms = None;
    tracker.startup_latency_ms = None;
    tracker.acknowledged_at_epoch_ms = None;
    tracker.capture_ready_at_epoch_ms = None;
    tracker.first_stable_partial_at_epoch_ms = None;
    tracker.stop_requested_at = None;
    tracker.final_transcript_at_epoch_ms = None;
    tracker.insertion_completed_at_epoch_ms = None;
    *start_options = models::DictationStartOptions::default();
    true
}

/// Session metadata every terminal dictation-stop error event carries.
/// Captured once so each failure site reports the same shape.
pub(crate) struct DictationStopFailureContext {
    session_id: u64,
    requested_provider: &'static str,
    actual_provider: &'static str,
    requested_model_id: Option<String>,
    actual_model_id: Option<String>,
    app_target: Option<String>,
    insertion_mode: String,
    resolved_route: Option<String>,
    route_preference: Option<String>,
}

/// The one terminal error path for `stop_dictation_for_sidecar`.
///
/// Every failure after the active session is resolved must come through here.
/// An early return that skips it leaves `dictation_runtime_state` on
/// `Recording` and never emits a terminal phase, so Electron's mirrored phase
/// stays "stopping", the hotkey resolves to "ignore", Escape (which only
/// cancels from a live phase) has nothing to act on, and dictation is dead
/// until the app is restarted. Returns the message to hand back as `Err`.
pub(crate) async fn fail_dictation_stop(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    context: &DictationStopFailureContext,
    fallback_reason: Option<String>,
    message: String,
) -> String {
    // A cancelled stop may finish after another session has started. Its
    // failure belongs only to the old session and must not stop the new
    // preview, clear its tracker, or replace its overlay with an error.
    let cleaned_current_session = reset_dictation_session_runtime_if_current(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
        context.session_id,
    )
    .await;
    if !cleaned_current_session {
        return message;
    }
    // Every terminal stop failure comes through here, so this is where a
    // preview that outlived its session is guaranteed to be closed.
    stop_dictation_live_preview_for_session(state, context.session_id).await;

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        if overlay.session_id == Some(context.session_id) {
            overlay.phase = "error".to_string();
            overlay.message = Some(message.clone());
            overlay.requested_provider = Some(context.requested_provider.to_string());
            overlay.actual_provider = Some(context.actual_provider.to_string());
            overlay.requested_model_id = context.requested_model_id.clone();
            overlay.actual_model_id = context.actual_model_id.clone();
            overlay.fallback_reason = fallback_reason.clone();
            overlay.target_app = context.app_target.clone();
        }
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "error",
            "sessionId": context.session_id,
            "message": message,
            "requestedProvider": context.requested_provider,
            "actualProvider": context.actual_provider,
            "requestedModelId": context.requested_model_id,
            "actualModelId": context.actual_model_id,
            "fallbackReason": fallback_reason,
            "targetApp": context.app_target,
            "insertionMode": context.insertion_mode,
            "resolvedRoute": context.resolved_route,
            "routePreference": context.route_preference,
        }),
    );

    schedule_dictation_overlay_idle_reset(
        state,
        handle,
        context.session_id,
        "error",
        DICTATION_IDLE_RESET_ERROR_MS,
    );

    message
}

/// Remember a completed result for the re-paste/re-copy recovery hotkeys and
/// the menu-bar menu. Empty results are not worth offering to re-paste.
pub(crate) fn record_recent_dictation_result(
    state: &AppState,
    text: &str,
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
) {
    if text.trim().is_empty() {
        return;
    }

    let Ok(mut results) = state.recent_dictation_results.lock() else {
        return;
    };
    push_recent_dictation_result(
        &mut results,
        RecentDictationResult {
            text: text.to_string(),
            app_target: app_target.map(str::to_string),
            app_bundle_id: app_bundle_id.map(str::to_string),
            at_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
}

/// Newest first, capped at [`RECENT_DICTATION_RESULT_LIMIT`]. Split out from
/// the state-holding caller so the ordering and the cap are testable without
/// standing up an `AppState`.
pub(crate) fn push_recent_dictation_result(
    results: &mut Vec<RecentDictationResult>,
    candidate: RecentDictationResult,
) {
    if candidate.text.trim().is_empty() {
        return;
    }
    results.insert(0, candidate);
    results.truncate(RECENT_DICTATION_RESULT_LIMIT);
}

/// Where a re-paste should land: whatever is frontmost *now*, never the app the
/// original session targeted.
///
/// The recovery hotkey exists because the first insert went somewhere the user
/// did not want, so by the time it is pressed the frontmost app is usually a
/// different one — that is the whole point of the path. Replaying the stored
/// target would send `reactivate_target_application` off to `open -b <bundle>`,
/// which raises the app the user just left (and can relaunch one they have
/// since quit, since nothing expires `recent_dictation_results`) and inserts
/// there instead of at their caret. Re-resolving instead of passing `None`
/// keeps the frontmost-app logging and the self/transient filtering in
/// `sanitize_dictation_target` intact.
pub(crate) fn resolve_recent_dictation_repaste_target() -> (Option<String>, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        (None, None)
    }
}

/// Re-insert (or just re-copy) one of the recent results. `index` defaults to
/// the newest, which is what both recovery hotkeys bind to.
pub(crate) fn reuse_recent_dictation_result(
    state: &AppState,
    params: &serde_json::Value,
    paste: bool,
) -> Result<serde_json::Value, String> {
    let index = params
        .get("index")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as usize;
    let Some(result) = recent_dictation_result_at(state, index) else {
        return Err("No recent dictation result is available to reuse.".to_string());
    };

    if !paste {
        copy_to_clipboard(&result.text)?;
        return Ok(serde_json::json!({ "pasted": false, "copied": true }));
    }

    let (target_app, target_app_bundle_id) = resolve_recent_dictation_repaste_target();
    let outcome = paste_text_systemwide(
        &state.accessibility_trust_observed,
        &result.text,
        false,
        target_app.as_deref(),
        target_app_bundle_id.as_deref(),
    );
    if !outcome.pasted && !outcome.copied {
        return Err(outcome
            .error
            .unwrap_or_else(|| "Could not re-insert the last dictation result.".to_string()));
    }
    Ok(serde_json::json!({
        "pasted": outcome.pasted,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

pub(crate) fn recent_dictation_result_at(
    state: &AppState,
    index: usize,
) -> Option<RecentDictationResult> {
    state
        .recent_dictation_results
        .lock()
        .ok()
        .and_then(|results| results.get(index).cloned())
}

/// Sidecar-compatible stop_dictation.
///
/// `expected_session_id`, when provided, scopes the stop to a specific
/// session: if the currently active session differs (e.g. a delayed VAD
/// auto-stop for session A arriving after session B already started), the
/// stop is rejected without touching any state, so a stale stop can never
/// tear down a session it doesn't own.
///
/// `stop_gesture_epoch_ms`, when the caller supplies it, is the epoch ms of
/// the real client-side stop gesture (hotkey release, hands-free toggle,
/// etc.) as observed by Electron -- see `dictation-shortcut-controller.ts`,
/// which captures it before any `invoke` await. Absent that (an older
/// caller, or a stop path with no discrete client gesture), the timing
/// record's zero point honestly falls back to when this handler itself
/// observed the stop, which is measurably later than the real gesture by
/// whatever the Electron-to-sidecar IPC hop costs.
pub(crate) async fn stop_dictation_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    stop_reason: &str,
    expected_session_id: Option<u64>,
    stop_gesture_epoch_ms: Option<i64>,
) -> Result<String, String> {
    // Single `Instant`, captured once, that every stage of the timing record
    // below measures elapsed time from. Each stage used to re-lock
    // `dictation_session_tracker` just to read `stop_requested_at` back out
    // -- extra lock traffic bought nothing (the value never changes once set
    // a few lines down), one of those locks sat inside the very insertion
    // window it was measuring, and reading it back through a lock left a
    // window where a concurrent reset (`force_stop_dictation`, or a second
    // stop racing this one) could clear `stop_requested_at` mid-flight and
    // silently drop a stage's timing. A local `Instant` is `Copy`, cannot be
    // reset out from under this function, and costs nothing to read.
    let stop_signal_instant = std::time::Instant::now();
    let handler_received_at_epoch_ms = chrono::Utc::now().timestamp_millis();
    let (stop_command_received_at_epoch_ms, gesture_to_handler_ms) =
        crate::dictation_timing::resolve_stop_timing(
            handler_received_at_epoch_ms,
            stop_gesture_epoch_ms,
        );
    let elapsed_since_stop = || {
        gesture_to_handler_ms.saturating_add(
            stop_signal_instant
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        )
    };

    // Claim the session atomically. Reading the active id and then re-taking
    // the lock later leaves a window where a second stop passes the same
    // checks; both would then run audio finalization and the loser would reset
    // the tracker, throwing away audio the winner had already captured.
    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        let active = tracker
            .active_session_id
            .ok_or_else(|| "No active dictation session to stop".to_string())?;

        if let Some(expected) = expected_session_id {
            if expected != active {
                return Err(format!(
                    "Stale stop request for dictation session {} ignored (active session is {})",
                    expected, active
                ));
            }
        }

        if tracker.stopping_session_id == Some(active) {
            return Err(format!(
                "Dictation session {} is already stopping; ignoring duplicate stop",
                active
            ));
        }

        tracker.stopping_session_id = Some(active);
        tracker.stop_requested_at = Some(stop_signal_instant);
        active
    };
    let mut dictation_options = state.dictation_start_options.lock().await.clone();
    let mut settings_snapshot = {
        let sm = state.settings_manager.lock().await;
        sm.settings().clone()
    };
    // Same per-session mode override the start applied, so the format prompt,
    // translate flag and history record describe the mode this session
    // actually ran under rather than whatever is selected in Settings now.
    apply_dictation_session_mode_override(&mut settings_snapshot, &mut dictation_options);
    let fallback_provider_type = {
        resolve_transcription_provider_and_model(
            &settings_snapshot.transcription,
            TranscriptionScope::Dictation,
        )
        .0
    };
    let requested_provider_type = dictation_options
        .requested_provider
        .as_deref()
        .and_then(asr_provider_from_settings_value)
        .unwrap_or(fallback_provider_type);
    let provider_type = dictation_options
        .actual_provider
        .as_deref()
        .and_then(asr_provider_from_settings_value)
        .unwrap_or(requested_provider_type);
    let requested_model_id = dictation_options.requested_model_id.clone();
    let actual_model_id = dictation_options
        .actual_model_id
        .clone()
        .or_else(|| requested_model_id.clone());
    let app_target = dictation_options.context_app_name.clone();
    let app_bundle_id = dictation_options.context_app_bundle_id.clone();
    let preview_only = !should_deliver_dictation_text(dictation_options.delivery_mode);
    let requested_insertion_mode = if preview_only {
        "preview".to_string()
    } else {
        tracker_insertion_mode(state).await
    };
    // From here on the session is owned: every exit path must be either the
    // terminal "done" emit at the bottom or `fail_dictation_stop`.
    let failure_context = DictationStopFailureContext {
        session_id,
        requested_provider: asr_provider_to_settings_value(requested_provider_type),
        actual_provider: asr_provider_to_settings_value(provider_type),
        requested_model_id: requested_model_id.clone(),
        actual_model_id: actual_model_id.clone(),
        app_target: app_target.clone(),
        insertion_mode: requested_insertion_mode.clone(),
        resolved_route: dictation_options.resolved_route.clone(),
        route_preference: dictation_options.route_preference.clone(),
    };
    let mut warnings: Vec<String> = Vec::new();

    if let Some(model_id) = actual_model_id.as_ref() {
        state
            .asr_manager
            .set_provider_model_id(provider_type, model_id.clone())
            .await;
    }

    // Emit stopping phase so the UI shows feedback immediately.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "stopping".to_string();
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "stopping",
            "sessionId": session_id,
            "stopReason": stop_reason,
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": requested_insertion_mode,
            "appTarget": app_target,
            "activationMatcher": dictation_options.activation_matcher,
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    // Deliberate extra recording so the speaker's final consonant lands (see
    // `DICTATION_STOP_CAPTURE_TAIL_MS`). It is awaited here, *before* taking the
    // capture mutex: as a blocking sleep inside `stop_dictation` it held the
    // async `audio_capture` lock and parked a tokio worker for its whole
    // duration. Waiting first preserves the ordering the tail depends on --
    // capture is still live and `is_dictating` is still true.
    tokio::time::sleep(Duration::from_millis(
        crate::audio::DICTATION_STOP_CAPTURE_TAIL_MS,
    ))
    .await;

    let audio_stop_result = {
        let mut audio = state.audio_capture.lock().await;
        let hit_max_duration = audio.dictation_hit_max_duration();
        audio
            .stop_dictation_for_session(session_id)
            .map(|audio_bytes| (audio_bytes, hit_max_duration))
    };
    let (audio_bytes, hit_max_duration) = match audio_stop_result {
        Ok(result) => result,
        Err(error) => {
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                None,
                format!("Failed to stop dictation audio: {}", error),
            )
            .await);
        }
    };
    // Put the live preview down before anything asks the GPU for the final
    // result. Capture has ended, so the preview has nothing left to show, and
    // the streaming recognizer holds its model's compute lease until its
    // session is closed -- which this awaits. The preview never fed the
    // transcript; this only stops it competing with the decode that does.
    stop_dictation_live_preview_for_session(state, session_id).await;

    let audio_finalized_ms = Some(elapsed_since_stop());
    if hit_max_duration {
        // The session was ended by the length ceiling, not by the user. Say so:
        // the transcript that follows covers only the audio that fit.
        warnings.push(format!(
            "Dictation reached the maximum length of {} minutes and was stopped. Only the audio captured up to that point was transcribed.",
            crate::audio::AudioCapture::dictation_max_session_seconds() / 60
        ));
    }
    let dictation_duration_seconds = match compute_wav_duration_seconds_from_bytes(&audio_bytes) {
        Ok(duration_seconds) => duration_seconds,
        Err(error) => {
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                Some(error.clone()),
                format!("Failed to read captured dictation duration: {}", error),
            )
            .await);
        }
    };

    // Dictionary entries always apply: `dictation_auto_learn_corrections`
    // only gates whether new entries are learned from user corrections
    // (see the auto-learn handlers), not whether existing entries — manual,
    // CSV-imported, or previously learned — are used. Loaded before
    // transcription (not after, as they once were) because the recognizer
    // gets them as a vocabulary hint as well as the text pass afterwards.
    let dictionary_entries = {
        let db = state.db.lock().await;
        match db.list_dictation_dictionary_entries() {
            Ok(entries) => entries,
            Err(error) => {
                drop(db);
                return Err(fail_dictation_stop(
                    state,
                    handle,
                    &failure_context,
                    None,
                    format!("Failed to read the dictation dictionary: {}", error),
                )
                .await);
            }
        }
    };
    let snippets = if settings_snapshot.transcription.dictation_snippets_enabled {
        let db = state.db.lock().await;
        match db.list_dictation_snippets() {
            Ok(snippets) => snippets,
            Err(error) => {
                drop(db);
                return Err(fail_dictation_stop(
                    state,
                    handle,
                    &failure_context,
                    None,
                    format!("Failed to read dictation snippets: {}", error),
                )
                .await);
            }
        }
    } else {
        Vec::new()
    };

    let formatting_hint = resolve_dictation_formatting_hint(
        app_target.as_deref(),
        dictation_options.activation_matcher.as_deref(),
        dictation_options.context_app_name.as_deref(),
    );
    // Resolve the destination-app category once — settings overrides,
    // bundle id, AND the browser-domain formatting hint — so the recognizer
    // vocabulary hint, dictionary/snippet category scoping and local smart
    // formatting all agree on the same category (matching what the LLM
    // prompt path resolves).
    let destination_category = settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings_snapshot.transcription,
        app_target.as_deref(),
        app_bundle_id.as_deref(),
        formatting_hint.as_deref(),
    );

    // Recognizer vocabulary bias, built from the same dictionary and snippet
    // entries the post-transcription pass applies and scoped the same way
    // (app, destination category, enabled). Whisper gets it as the initial
    // prompt; OpenAI/Groq as `prompt`; ElevenLabs as `keyterms`; every other
    // provider ignores it. `None` when nothing applies, so no provider ever
    // sees a blank hint.
    // Translate-to-English (B7a): decided once, before the recognizer runs,
    // because multilingual whisper.cpp does the translation inside the
    // decode while every other route needs a second pass afterwards.
    let translation_route = resolve_dictation_translation_route(
        provider_type,
        actual_model_id.as_deref().unwrap_or_default(),
        dictation_translate_to_english_enabled(&settings_snapshot),
    );
    let transcription_options = asr::TranscriptionOptions {
        vocabulary_hint: crate::dictation_parity::build_vocabulary_hint(
            &crate::dictation_pipeline::vocabulary_candidates_from_entries(
                &dictionary_entries,
                &snippets,
            ),
            app_target.as_deref(),
            destination_category,
        ),
        translate_to_english: translation_route == DictationTranslationRoute::WhisperNative,
        // Dictation is served correctly by either Apple engine; only the
        // meeting route depends on SpeechAnalyzer's timed segments.
        apple_speech_required_engine: None,
        request_speaker_labels: false,
        language: settings_snapshot.transcription.language.clone(),
    };
    let vocabulary_hint_terms_built = transcription_options
        .vocabulary_hint
        .as_ref()
        .map(|hint| hint.terms().len())
        .unwrap_or(0);

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "transcribing".to_string();
        overlay.message = Some("Transcribing…".to_string());
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "transcribing",
            "sessionId": session_id,
            "message": "Transcribing…",
            "requestedProvider": asr_provider_to_settings_value(requested_provider_type),
            "actualProvider": asr_provider_to_settings_value(provider_type),
            "requestedModelId": requested_model_id.clone(),
            "actualModelId": actual_model_id.clone(),
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": requested_insertion_mode,
            "appTarget": app_target.clone(),
            "activationMatcher": dictation_options.activation_matcher,
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    let transcription_result = match state
        .asr_manager
        .transcribe_bytes_for_dictation_with_options(
            provider_type,
            &audio_bytes,
            actual_model_id.as_deref(),
            &transcription_options,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            let route_label = actual_model_id
                .as_deref()
                .map(|model| format!("{} / {}", provider_type.display_name(), model))
                .unwrap_or_else(|| provider_type.display_name().to_string());
            let user_message = format!(
                "Dictation transcription failed on {}: {}",
                route_label, error
            );
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                Some(error.to_string()),
                user_message,
            )
            .await);
        }
    };

    // Built is what the dictionary offered; applied is what the route that
    // actually ran attached (a whisper decode withholds it on near-silent
    // audio, cloud routes without a prompt field ignore it entirely). Only
    // the second says the dictionary reached the recognizer.
    let vocabulary_hint_terms_applied = transcription_result.vocabulary_hint_terms_applied;
    if vocabulary_hint_terms_built > 0 {
        tracing::info!(
            "Dictation vocabulary hint: {} term(s) built, {} applied by {}",
            vocabulary_hint_terms_built,
            vocabulary_hint_terms_applied,
            transcription_result.actual_provider.display_name()
        );
    }

    let final_transcript_at_epoch_ms = chrono::Utc::now().timestamp_millis();
    let final_transcript_latency_ms = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.final_transcript_at_epoch_ms = Some(final_transcript_at_epoch_ms);
        tracker.stop_requested_at.map(|stopped_at| {
            gesture_to_handler_ms
                .saturating_add(stopped_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
        })
    };

    let raw_transcribed_text =
        sanitize_dictation_output(&transcription_result.text, &transcription_result.text)
            .trim()
            .to_string();
    let now = chrono::Utc::now();
    let recent_delivery = state.recent_dictation_delivery.lock().await.clone();
    let recent_inserted_text = recent_delivery
        .as_ref()
        .filter(|delivery| {
            recent_delivery_matches_target_and_is_fresh(
                delivery,
                app_target.as_deref(),
                app_bundle_id.as_deref(),
                now,
            )
        })
        .map(|delivery| delivery.text.as_str());

    let effective_mode = resolved_dictation_mode_preset(&settings_snapshot).to_string();

    let mut final_text = raw_transcribed_text.clone();
    let mut command_applied: Option<String> = None;
    let mut prompt_source: Option<String> = None;
    let mut prompt_preview: Option<String> = None;
    let mut dictionary_applied_count = 0usize;
    let mut snippet_applied_count = 0usize;
    let mut formatting_applied = false;
    let mut recent_insert_reused = false;
    let mut pipeline_stage_keys: Vec<String> = Vec::new();
    let mut undo_previous_insert = false;
    // Timing-record fields for the format/cleanup stage. Stays
    // `NotApplicable` unless the pipeline below actually reaches formatting
    // (an empty transcript or a consumed command skips it entirely).
    let mut format_outcome = crate::dictation_timing::DictationFormatOutcome::NotApplicable;

    if settings_snapshot
        .transcription
        .dictation_command_mode_enabled
    {
        if let Some((command_key, action)) = parse_dictation_command(
            raw_transcribed_text.as_str(),
            &settings_snapshot.transcription.dictation_command_prefix,
        ) {
            // Command mode ships on while the text-context source defaults to
            // "none", so every selection-scoped command would otherwise have
            // nothing to work on. Capture the selection here — only once a
            // command actually parsed — instead of defaulting the context
            // source to "selected_text", which would fire a synthetic copy
            // into the frontmost app (and clobber the clipboard) on every
            // ordinary dictation.
            let mut command_context_text = dictation_options.captured_context_text.clone();
            let mut command_context_source =
                normalize_dictation_context_source(&dictation_options.context_source).to_string();
            let needs_context =
                crate::dictation_parity::dictation_command_action_needs_context(&action);
            if needs_context
                && command_context_source == "none"
                && command_context_text
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .is_empty()
            {
                command_context_source = "selected_text".to_string();
                match capture_dictation_context_text("selected_text", app_target.as_deref()) {
                    Ok(captured) => command_context_text = captured,
                    Err(error) => tracing::info!(
                        "Selection capture for dictation command '{}' failed: {}",
                        command_key,
                        error
                    ),
                }
            }

            let ai_selection = match dictation_session_ai_selection(&settings_snapshot) {
                Ok(selection) => selection,
                Err(error) => {
                    return Err(
                        fail_dictation_stop(state, handle, &failure_context, None, error).await,
                    );
                }
            };
            match execute_dictation_command_action(
                state,
                &command_key,
                action,
                command_context_text.as_deref(),
                &command_context_source,
                &ai_selection,
            )
            .await
            {
                Ok(execution) => {
                    final_text = execution.output_text.trim().to_string();
                    command_applied = Some(execution.command_applied);
                    prompt_source = execution.prompt_source;
                    prompt_preview = execution.prompt_preview;
                    undo_previous_insert = execution.undo_previous_insert;
                    pipeline_stage_keys.push("command".to_string());
                }
                Err(DictationCommandError::MissingContext(warning)) => {
                    // Non-fatal: leave `command_applied` unset so the ordinary
                    // pipeline below runs on the raw transcript. The user gets
                    // their words plus an explanation, instead of a failed stop.
                    tracing::warn!(
                        "Dictation command '{}' had no text to work on: {}",
                        command_key,
                        warning
                    );
                    warnings.push(warning);
                }
                Err(DictationCommandError::Failed(error)) => {
                    return Err(
                        fail_dictation_stop(state, handle, &failure_context, None, error).await,
                    );
                }
            }
        }
    }

    if command_applied.is_none() {
        // `destination_category` was resolved once, before transcription, so
        // the recognizer hint and this pass scope entries identically.
        let pipeline_result = crate::dictation_pipeline::apply_dictation_pipeline(
            crate::dictation_pipeline::DictationPipelineInput {
                text: raw_transcribed_text.as_str(),
                dictionary_entries: &dictionary_entries,
                snippets: &snippets,
                app_target: app_target.as_deref(),
                mode_preset: effective_mode.as_str(),
                smart_formatting_enabled: true,
                numbers_as_digits: resolve_dictation_numbers_as_digits(&settings_snapshot),
                recent_inserted_text,
                command_mode_enabled: settings_snapshot
                    .transcription
                    .dictation_command_mode_enabled,
                destination_category,
            },
        );
        final_text = pipeline_result.text.trim().to_string();
        command_applied = pipeline_result.command_applied.clone();
        dictionary_applied_count = pipeline_result.dictionary_applied_count;
        snippet_applied_count = pipeline_result.snippet_applied_count;
        formatting_applied = pipeline_result.formatting_applied;
        recent_insert_reused = pipeline_result.recent_insert_reused;
        pipeline_stage_keys = pipeline_result.pipeline_stage_keys.clone();
        undo_previous_insert = pipeline_result.undo_previous_insert;
    }

    // Baseline for the format/cleanup stage: reached, and the local pipeline
    // pass above already ran (it runs unconditionally whenever there is no
    // command to service). The match below only ever narrows this further
    // -- to `Skipped` when a mode has no local equivalent and LLM formatting
    // is off, or to `TimedOut`/`Failed` when an LLM pass was attempted and
    // didn't return cleanly.
    if !final_text.is_empty() && command_applied.is_none() {
        format_outcome = crate::dictation_timing::DictationFormatOutcome::Applied;
    }

    // One budget for the whole pre-insert stretch, not one per pass. A single
    // dictation can run translate-to-English and then a formatting pass back
    // to back; taking a fresh `dictation_format_timeout` for each made the
    // real worst-case insertion delay twice the constant (12 s local). The
    // clock starts inside the first pass -- provider resolution and prompt
    // building stay outside it deliberately -- and every later pass gets what
    // is left. See `DictationPreInsertBudget`.
    let mut pre_insert_budget = crate::dictation_timing::DictationPreInsertBudget::new();

    // Translate-to-English through the AI lane (B7a). Runs before the mode
    // transform / Smart Format pass so that pass formats English, out of the
    // shared pre-insert budget above. A failed or timed-out translation keeps
    // the source-language words -- the user's speech must never be lost to a
    // slow model -- and says so.
    let mut translation_applied =
        translation_route == DictationTranslationRoute::WhisperNative && !final_text.is_empty();
    if translation_route == DictationTranslationRoute::AiLane
        && !final_text.is_empty()
        && command_applied.is_none()
    {
        let attempt = match dictation_session_ai_selection(&settings_snapshot).and_then(
            |(provider, remote_processing_enabled, model)| {
                enforce_remote_provider_policy(provider, remote_processing_enabled)
                    .map(|()| (provider, remote_processing_enabled, model))
            },
        ) {
            Ok((provider, remote_processing_enabled, model)) => {
                let format_timeout = pre_insert_budget.remaining(
                    dictation_format_timeout(provider),
                    std::time::Instant::now(),
                );
                let translated = tokio::time::timeout(
                    format_timeout,
                    run_custom_dictation_transform_with_provider(
                        state,
                        final_text.as_str(),
                        DICTATION_TRANSLATE_TO_ENGLISH_PROMPT,
                        provider,
                        &model,
                        remote_processing_enabled,
                    ),
                )
                .await;
                match translated {
                    Ok(Ok((output, _, _))) => {
                        crate::dictation_timing::DictationFormatAttempt::Applied(output)
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(
                            "Translate-to-English failed, inserting the source-language words: {}",
                            error
                        );
                        crate::dictation_timing::DictationFormatAttempt::Failed
                    }
                    Err(_) => {
                        tracing::warn!(
                            "Translate-to-English timed out after {}ms, inserting the source-language words",
                            format_timeout.as_millis()
                        );
                        crate::dictation_timing::DictationFormatAttempt::TimedOut
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Translate-to-English could not resolve an AI provider, inserting the source-language words: {}",
                    error
                );
                crate::dictation_timing::DictationFormatAttempt::Failed
            }
        };
        let fallback =
            crate::dictation_timing::resolve_dictation_format_attempt(attempt, final_text.as_str());
        if fallback.format_outcome == crate::dictation_timing::DictationFormatOutcome::Applied {
            final_text = sanitize_dictation_output(fallback.final_text.trim(), final_text.as_str())
                .trim()
                .to_string();
            translation_applied = true;
            pipeline_stage_keys.push("translate_to_english".to_string());
        } else {
            final_text = fallback.final_text;
            warnings.push(DICTATION_TRANSLATE_FAILED_WARNING.to_string());
            pipeline_stage_keys.push("translate_to_english_fallback".to_string());
        }
    }

    if !final_text.is_empty() && command_applied.is_none() {
        match effective_mode.as_str() {
            // Same gate and the same insertion-delay cap as the Smart Format
            // branch below: this arm used to call the model on every single
            // dictation with no opt-in and no timeout, then quietly replace the
            // result with a crude local rewrite whenever the call failed.
            "messages" | "email" | "meeting_follow_up" => {
                if let Some((prompt, resolved_prompt_source)) =
                    resolve_dictation_mode_transform_prompt(&settings_snapshot, &effective_mode)
                        .filter(|_| {
                            dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options)
                        })
                {
                    // Resolve the provider (and enforce remote-processing
                    // policy) before the clock starts: neither is the model
                    // call the budget is meant to time, and a policy-blocked
                    // remote provider should fail fast rather than occupy
                    // the timer only to be rejected inside it.
                    let attempt = match dictation_session_ai_selection(&settings_snapshot).and_then(
                        |(provider, remote_processing_enabled, model)| {
                            enforce_remote_provider_policy(provider, remote_processing_enabled)
                                .map(|()| (provider, remote_processing_enabled, model))
                        },
                    ) {
                        Ok((provider, remote_processing_enabled, model)) => {
                            let format_timeout = pre_insert_budget.remaining(
                                dictation_format_timeout(provider),
                                std::time::Instant::now(),
                            );
                            let transform = tokio::time::timeout(
                                format_timeout,
                                run_custom_dictation_transform_with_provider(
                                    state,
                                    final_text.as_str(),
                                    prompt.as_str(),
                                    provider,
                                    &model,
                                    remote_processing_enabled,
                                ),
                            )
                            .await;
                            match transform {
                                Ok(Ok((output, _, _))) => {
                                    crate::dictation_timing::DictationFormatAttempt::Applied(output)
                                }
                                Ok(Err(error)) => {
                                    // Keep the local pipeline output
                                    // verbatim: it is the user's words,
                                    // correctly formatted.
                                    tracing::warn!(
                                        "Dictation mode transform for '{}' failed, keeping local pipeline output: {}",
                                        effective_mode,
                                        error
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::Failed
                                }
                                Err(_) => {
                                    tracing::warn!(
                                        "Dictation mode transform for '{}' timed out after {}ms, keeping local pipeline output",
                                        effective_mode,
                                        format_timeout.as_millis()
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::TimedOut
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                "Dictation mode transform for '{}' could not resolve a provider, keeping local pipeline output: {}",
                                effective_mode,
                                error
                            );
                            crate::dictation_timing::DictationFormatAttempt::Failed
                        }
                    };
                    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
                        attempt,
                        final_text.as_str(),
                    );
                    format_outcome = fallback.format_outcome;
                    match format_outcome {
                        crate::dictation_timing::DictationFormatOutcome::Applied => {
                            final_text = sanitize_dictation_output(
                                fallback.final_text.trim(),
                                final_text.as_str(),
                            )
                            .trim()
                            .to_string();
                            prompt_source = Some(resolved_prompt_source);
                            prompt_preview = truncate_for_audit_preview(Some(prompt.as_str()), 180);
                            pipeline_stage_keys.push("mode_transform".to_string());
                        }
                        _ => {
                            final_text = fallback.final_text;
                            if fallback.warn_failed {
                                warnings.push(DICTATION_FORMAT_FAILED_WARNING.to_string());
                            }
                            if fallback.warn_timed_out {
                                warnings.push(DICTATION_FORMAT_TIMEOUT_WARNING.to_string());
                            }
                            pipeline_stage_keys.push("mode_transform_fallback".to_string());
                        }
                    }
                } else {
                    // No local equivalent exists for "rewrite this as an
                    // email" -- the stage was reached but had nothing to run,
                    // because Smart Format / AI formatting is off.
                    format_outcome = crate::dictation_timing::DictationFormatOutcome::Skipped;
                }
            }
            "notes" => {
                let bulletized = bulletize_text(final_text.as_str());
                if bulletized != final_text {
                    final_text = bulletized;
                    pipeline_stage_keys.push("mode_transform".to_string());
                }
                format_outcome = crate::dictation_timing::DictationFormatOutcome::Applied;
            }
            _ => {
                if dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options) {
                    // Preparation (provider/model resolution, frontmost-app
                    // lookup, prompt building) runs before the clock starts;
                    // only `execute_dictation_formatting_request` -- the
                    // actual model call -- is timed.
                    let attempt = match prepare_dictation_formatting_request(
                        state,
                        &dictation_options,
                    )
                    .await
                    {
                        Ok(prepared) => {
                            let format_timeout = pre_insert_budget.remaining(
                                dictation_format_timeout(prepared.provider),
                                std::time::Instant::now(),
                            );
                            let formatting = tokio::time::timeout(
                                format_timeout,
                                execute_dictation_formatting_request(
                                    state,
                                    &prepared,
                                    final_text.as_str(),
                                ),
                            )
                            .await;
                            match formatting {
                                Ok(Ok(output)) => {
                                    crate::dictation_timing::DictationFormatAttempt::Applied(output)
                                }
                                Ok(Err(error)) => {
                                    tracing::warn!(
                                        "LLM dictation formatting failed, keeping local pipeline output: {}",
                                        error
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::Failed
                                }
                                Err(_) => {
                                    tracing::warn!(
                                        "LLM dictation formatting timed out after {}ms, keeping local pipeline output",
                                        format_timeout.as_millis()
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::TimedOut
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                "LLM dictation formatting could not be prepared, keeping local pipeline output: {}",
                                error
                            );
                            crate::dictation_timing::DictationFormatAttempt::Failed
                        }
                    };
                    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
                        attempt,
                        final_text.as_str(),
                    );
                    format_outcome = fallback.format_outcome;
                    match format_outcome {
                        crate::dictation_timing::DictationFormatOutcome::Applied => {
                            final_text = sanitize_dictation_output(
                                fallback.final_text.trim(),
                                final_text.as_str(),
                            )
                            .trim()
                            .to_string();
                            let (resolved_prompt_source, resolved_prompt_preview) =
                                resolve_dictation_format_prompt_metadata(&settings_snapshot);
                            prompt_source = resolved_prompt_source;
                            prompt_preview =
                                truncate_for_audit_preview(resolved_prompt_preview.as_deref(), 180);
                            if !pipeline_stage_keys
                                .iter()
                                .any(|stage| stage == "smart_formatting")
                            {
                                pipeline_stage_keys.push("smart_formatting".to_string());
                            }
                            formatting_applied = true;
                        }
                        _ => {
                            final_text = fallback.final_text;
                            if fallback.warn_failed {
                                warnings.push(DICTATION_FORMAT_FAILED_WARNING.to_string());
                            }
                            if fallback.warn_timed_out {
                                warnings.push(DICTATION_FORMAT_TIMEOUT_WARNING.to_string());
                            }
                        }
                    }
                }
                // else: LLM formatting is off. The local pipeline's smart-
                // format pass already ran above; baseline `Applied` stands.
            }
        }
    }
    // `None` when the stage was never reached at all (empty transcript, or a
    // command consumed the utterance): `NotApplicable` must mean exactly
    // that, not "reached instantly," so this is guarded on the same
    // condition that flips `format_outcome` off its `NotApplicable` default.
    let format_complete_ms = (format_outcome
        != crate::dictation_timing::DictationFormatOutcome::NotApplicable)
        .then(&elapsed_since_stop);

    final_text = sanitize_dictation_output(final_text.as_str(), raw_transcribed_text.as_str())
        .trim()
        .to_string();

    // Escape (force_stop_dictation) clears the active session while this stop
    // is still transcribing or formatting. Honor it: a cancel that let the
    // text land anyway would be a lie, and force_stop has already reset the
    // runtime and emitted its terminal phase, so there is nothing left to
    // clean up here.
    if active_dictation_session_id(state).await != Some(session_id) {
        tracing::info!(
            "Dictation session {} was cancelled before insertion; discarding the result",
            session_id
        );
        return Ok(String::new());
    }

    let startup_latency_ms = {
        let tracker = state.dictation_session_tracker.lock().await;
        tracker.startup_latency_ms
    };
    let transcription_latency_ms = transcription_result.processing_time_ms;
    let persist_to_history = should_persist_dictation(
        dictation_options.save_to_inbox,
        &settings_snapshot.transcription.dictation_retention_preset,
    );
    let recording_id = uuid::Uuid::new_v4().to_string();
    let stored_text = if final_text.trim().is_empty() {
        raw_transcribed_text.clone()
    } else {
        final_text.clone()
    };
    let transcript = models::Transcript {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        segments: if stored_text == raw_transcribed_text {
            transcription_result
                .segments
                .iter()
                .cloned()
                .map(|segment| models::TranscriptSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    text: segment.text,
                    speaker_id: None,
                    confidence: segment.confidence,
                })
                .collect()
        } else if stored_text.is_empty() {
            Vec::new()
        } else {
            vec![models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: 0.0,
                end_time: 0.0,
                text: stored_text.clone(),
                speaker_id: None,
                confidence: transcription_result.confidence,
            }]
        },
        full_text: stored_text.clone(),
        language: transcription_result.language.clone(),
        confidence: transcription_result.confidence,
        model: transcription_result.model_name.clone(),
        model_id: Some(transcription_result.model_id.clone()),
        requested_provider: Some(
            asr_provider_to_settings_value(transcription_result.requested_provider).to_string(),
        ),
        actual_provider: Some(
            asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        ),
        created_at: now,
    };
    // Opt-in: keep the captured WAV so this entry can be processed again.
    // Written before the row so a failed write never leaves a row that claims
    // audio it does not have; a failed row write removes the file again below.
    let kept_audio_path =
        if persist_to_history && settings_snapshot.transcription.dictation_keep_audio {
            match write_kept_dictation_audio(&recording_id, &audio_bytes) {
                Ok(path) => Some(path),
                Err(error) => {
                    tracing::warn!("Dictation audio was not kept: {}", error);
                    warnings.push(format!(
                        "The dictation audio could not be kept for Process again: {error}"
                    ));
                    None
                }
            }
        } else {
            None
        };
    let kept_audio_metadata = kept_audio_path
        .as_deref()
        .map(recording_audio::validate_plaintext_wav)
        .and_then(|validation| match validation {
            recording_audio::RecordingAudioValidation::Ready(metadata) => Some(metadata),
            _ => None,
        });
    let history_text = crate::store::DictationHistoryTextRecord {
        recording_id: recording_id.clone(),
        final_text: stored_text.clone(),
        raw_text: raw_transcribed_text.clone(),
        reprocessed_from_id: None,
        mode_preset: Some(effective_mode.clone()),
        created_at: now,
    };
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Dictation - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: dictation_options
            .project_id
            .clone()
            .unwrap_or_else(|| "inbox".to_string()),
        duration: dictation_duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "dictation".to_string(),
        audio_path: kept_audio_metadata
            .as_ref()
            .and(kept_audio_path.as_ref())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        status: "completed".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: None,
        meeting_template_id: None,
        meeting_capture_mode: None,
        imported_source_name: None,
        notes_updated_at: None,
        consent_prompt_shown: false,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        attendees: Vec::new(),
        pause_spans: Vec::new(),
        video_service: None,
        transcript_complete: true,
        transcript_degraded_reason: None,
        transcript_incomplete_acknowledged_at: None,
        capture_degraded_summary: None,
    };

    // Cursor delivery crosses native process and accessibility boundaries.
    // Commit the only recoverable copy first, as one transaction, so a helper
    // failure or app termination during insertion cannot erase the words.
    if persist_to_history {
        let mut db = state.db.lock().await;
        if let Err(error) = db.create_dictation_history_entry(
            &recording,
            &transcript,
            &history_text,
            kept_audio_metadata.as_ref(),
        ) {
            drop(db);
            if let Some(path) = kept_audio_path.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            record_recent_dictation_result(
                state,
                &final_text,
                app_target.as_deref(),
                dictation_options.context_app_bundle_id.as_deref(),
            );
            if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                overlay.preview = Some(final_text.clone());
            }
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                None,
                format!(
                    "Plainsong could not save this dictation, so no text was inserted. \
                     Your words remain available in the dictation window: {}",
                    error
                ),
            )
            .await);
        }
    }

    // Kept dictation audio is an owned asset in the recordings store exactly
    // like a meeting's track, and it went in as `protection 'plaintext'`. With
    // the vault on it has to be encrypted here, or the words the reader chose
    // to keep sit in the clear under a vault the UI says covers them.
    //
    // A failure is a warning, not a refusal: the transcript is already
    // committed and the text still has to be delivered. The asset stays
    // plaintext and `get_security_status` keeps reporting it as such, which is
    // the truth, and the reader is told rather than left to find out.
    if kept_audio_metadata.is_some() {
        if let Err(error) =
            encrypt_finalized_recording_audio(state, Some(handle), &recording_id).await
        {
            tracing::warn!("Kept dictation audio was not encrypted: {}", error);
            warnings.push(format!(
                "The kept dictation audio is not in the vault yet: {error}"
            ));
        }
    }

    let mut insert_latency_ms: Option<u64> = None;
    let mut post_insert_focus_anchor: Option<
        dictation_correction_capture::FocusedFieldFingerprint,
    > = None;
    let mut pasted = false;
    let mut copied = false;
    let mut paste_error: Option<String> = None;
    let mut actual_insertion_mode = requested_insertion_mode.clone();
    let mut outcome = "ready".to_string();
    let mut undo_performed = false;
    // Timing-record fields for the insertion stage. Stay `None` unless text
    // insertion is actually dispatched below (preview-only delivery and an
    // undo-only command never reach it).
    let mut insertion_dispatched_ms: Option<u64> = None;
    let mut insertion_confirmed_ms: Option<u64> = None;
    let mut insertion_confirmed_flag = false;

    if preview_only {
        actual_insertion_mode = "preview".to_string();
        outcome = if final_text.is_empty() {
            "empty".to_string()
        } else {
            "previewed".to_string()
        };
    } else {
        if undo_previous_insert {
            // Re-sample focus immediately before the destructive operation.
            // The session's start target alone is insufficient because focus
            // can change while audio is being transcribed.
            let focused_app = get_frontmost_app_name();
            let focused_bundle_id = get_frontmost_app_bundle_id();
            let undo_authorized = recent_delivery.as_ref().is_some_and(|delivery| {
                recent_delivery_authorizes_undo(
                    delivery,
                    app_target.as_deref(),
                    app_bundle_id.as_deref(),
                    focused_app.as_deref(),
                    focused_bundle_id.as_deref(),
                    &requested_insertion_mode,
                    chrono::Utc::now(),
                )
            });
            if undo_authorized {
                match send_native_undo_key(app_target.as_deref(), app_bundle_id.as_deref()) {
                    Ok(()) => {
                        undo_performed = true;
                        outcome = "undone".to_string();
                    }
                    Err(error) => {
                        paste_error = Some(error);
                    }
                }
            }
            if !undo_performed {
                if paste_error.is_none() {
                    paste_error =
                        Some("No recent dictation insert was available to undo.".to_string());
                }
                actual_insertion_mode = "command_only".to_string();
                outcome = "error".to_string();
            }
        }

        if should_insert_dictation_result(
            &final_text,
            command_applied.as_deref(),
            undo_previous_insert,
            undo_performed,
        ) {
            let insert_started_at = std::time::Instant::now();
            insertion_dispatched_ms = Some(elapsed_since_stop());
            let paste_outcome =
                match DictationInsertionMode::from_settings_value(&requested_insertion_mode) {
                    DictationInsertionMode::ClipboardOnly => {
                        // Clipboard-only delivery still hands the words to
                        // whatever is in front: a password box's owner can
                        // paste them straight back in. Same refusal as
                        // insertion, decided before the clipboard is touched.
                        let secure_field =
                            tokio::task::spawn_blocking(probe_clipboard_delivery_secure_field)
                                .await
                                .unwrap_or_else(|join_error| {
                                    tracing::warn!(
                                "Secure-field probe before clipboard delivery did not complete: {}",
                                join_error
                            );
                                    None
                                });
                        if let Some(signal) = secure_field {
                            secure_field_refusal_outcome(signal)
                        } else {
                            match copy_to_clipboard(final_text.as_str()) {
                                Ok(()) => PasteOutcome {
                                    pasted: false,
                                    copied: true,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: None,
                                },
                                Err(error) => PasteOutcome {
                                    pasted: false,
                                    copied: false,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: Some(error),
                                },
                            }
                        }
                    }
                    DictationInsertionMode::Auto => {
                        // Insertion shells out to `open`, waits for the target
                        // app to come forward, then polls for the paste to land
                        // -- close to a second of blocking work on the hottest
                        // dictation path. Running it inline stalled a tokio
                        // worker for that whole window. Hoist the few reads it
                        // needs, then hand the blocking body to the blocking
                        // pool, matching how `get_frontmost_app_name` is already
                        // dispatched.
                        let keep_text_in_clipboard = tracker_copy_to_clipboard(state).await;
                        let accessibility_trust_observed =
                            Arc::clone(&state.accessibility_trust_observed);
                        let insert_text = final_text.clone();
                        let insert_app_target = app_target.clone();
                        let insert_app_bundle_id = app_bundle_id.clone();
                        match tokio::task::spawn_blocking(move || {
                            paste_text_systemwide(
                                &accessibility_trust_observed,
                                insert_text.as_str(),
                                keep_text_in_clipboard,
                                insert_app_target.as_deref(),
                                insert_app_bundle_id.as_deref(),
                            )
                        })
                        .await
                        {
                            Ok(outcome) => outcome,
                            Err(join_error) => {
                                // A panic inside insertion must not be reported
                                // as a successful insert; the transcript is
                                // already durably committed above.
                                tracing::error!(
                                    "Dictation insertion task failed to complete: {}",
                                    join_error
                                );
                                PasteOutcome {
                                    pasted: false,
                                    copied: false,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: Some(
                                        "Text insertion did not complete. The transcript was saved."
                                            .to_string(),
                                    ),
                                }
                            }
                        }
                    }
                };
            insert_latency_ms = Some(
                insert_started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            insertion_confirmed_flag = paste_outcome.confirmed;
            // Only a positively-confirmed insertion gets a confirmed
            // timestamp -- a bare Cmd+V with no read-back (`paste_dispatched`)
            // or a clipboard-only copy never confirms delivery, so recording
            // a timestamp here under either name would claim knowledge this
            // path doesn't have. `assemble_dictation_timing_record`'s
            // `total_ms` already falls back to `insertion_dispatched_ms` for
            // exactly this case.
            if insertion_confirmed_flag {
                insertion_confirmed_ms = Some(elapsed_since_stop());
            }
            pasted = paste_outcome.pasted;
            copied = paste_outcome.copied;
            let secure_field_refused = paste_outcome.secure_field.is_some();
            if paste_error.is_none() {
                paste_error = paste_outcome.error;
            }
            // Anchor the insertion to the field it landed in, while the field
            // is still the one on screen. Gated on the setting, so with the
            // feature off Plainsong never reads a destination field at all —
            // not even this once.
            if pasted
                && settings_snapshot
                    .transcription
                    .dictation_learn_from_external_corrections
                && !is_self_activation_target(app_target.as_deref(), app_bundle_id.as_deref())
            {
                let anchor_text = final_text.clone();
                post_insert_focus_anchor = tokio::task::spawn_blocking(move || {
                    dictation_correction_capture::capture_insertion_anchor(
                        &MacosFocusedFieldReader,
                        anchor_text.as_str(),
                        // Re-asked against the app actually in front now. The
                        // check above used the target recorded when the
                        // session started, which is still "Slack" even when
                        // reactivation failed and the text landed here.
                        &is_self_activation_target,
                    )
                })
                .await
                .unwrap_or_else(|join_error| {
                    tracing::warn!(
                        "Post-insert correction anchor did not complete: {}",
                        join_error
                    );
                    None
                });
            }
            outcome = resolve_dictation_delivery_outcome(DictationDeliveryFacts {
                pasted,
                copied,
                confirmed: paste_outcome.confirmed,
                undo_performed,
                secure_field_refused,
                has_paste_error: paste_error.is_some(),
                previous: outcome.as_str(),
            });
        } else if undo_performed {
            actual_insertion_mode = "command_only".to_string();
        } else if paste_error.is_none() {
            outcome = "empty".to_string();
        }
    }

    let insertion_completed_at_epoch_ms = chrono::Utc::now().timestamp_millis();
    let (
        acknowledgement_latency_ms,
        capture_ready_latency_ms,
        first_stable_partial_latency_ms,
        acknowledged_at_epoch_ms,
        capture_ready_at_epoch_ms,
        first_stable_partial_at_epoch_ms,
        end_to_end_ms,
    ) = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.insertion_completed_at_epoch_ms = Some(insertion_completed_at_epoch_ms);
        let started_at_epoch_ms = tracker.started_at_epoch_ms;
        let elapsed_from_start = |event_at: Option<i64>| {
            started_at_epoch_ms
                .zip(event_at)
                .map(|(start, event)| event.saturating_sub(start).max(0) as u64)
        };
        let end_to_end_ms = tracker
            .started_at
            .map(|started_at| started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(transcription_latency_ms + insert_latency_ms.unwrap_or(0));
        (
            elapsed_from_start(tracker.acknowledged_at_epoch_ms),
            elapsed_from_start(tracker.capture_ready_at_epoch_ms),
            elapsed_from_start(tracker.first_stable_partial_at_epoch_ms),
            tracker.acknowledged_at_epoch_ms,
            tracker.capture_ready_at_epoch_ms,
            tracker.first_stable_partial_at_epoch_ms,
            end_to_end_ms,
        )
    };
    // The Wave 3 timing record: stop-command-to-glyph (key-release-to-glyph
    // when Electron supplied the real gesture epoch -- see the function doc
    // above and dictation_timing.rs's module doc for the honest distinction),
    // not just ASR decode time. Additive on the completion event below and
    // logged once here -- one plain Instant captured above, no new locks, no
    // new syscalls, dropped on the floor if nothing reads it.
    let dictation_timing_record = crate::dictation_timing::assemble_dictation_timing_record(
        crate::dictation_timing::DictationTimingInputs {
            stop_command_received_at_epoch_ms,
            audio_finalized_ms,
            asr_complete_ms: final_transcript_latency_ms,
            format_complete_ms,
            format_outcome,
            insertion_dispatched_ms,
            insertion_confirmed_ms,
            insertion_confirmed: insertion_confirmed_flag,
        },
    );
    tracing::info!(
        "dictation {} timing: {}",
        session_id,
        crate::dictation_timing::format_dictation_timing_summary(&dictation_timing_record)
    );
    let fallback_message = build_provider_fallback_message(
        transcription_result.requested_provider,
        transcription_result.actual_provider,
        transcription_result.fallback_reason.as_deref(),
        transcription_result.optimization_applied,
    );

    if persist_to_history {
        let mut db = state.db.lock().await;
        let _ = db.save_transcript_artifact(&TranscriptArtifactRecord {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.clone(),
            transcript_id: Some(transcript.id.clone()),
            segment_count: transcript.segments.len() as i64,
            model_id: Some(transcription_result.model_id.clone()),
            requested_provider: Some(
                asr_provider_to_settings_value(transcription_result.requested_provider).to_string(),
            ),
            actual_provider: Some(
                asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
            ),
            quality_score: Some(transcription_result.confidence),
            startup_latency_ms: startup_latency_ms.map(|value| value as i64),
            transcription_latency_ms: Some(transcription_latency_ms as i64),
            insert_latency_ms: insert_latency_ms.map(|value| value as i64),
            end_to_end_ms: Some(end_to_end_ms as i64),
            created_at: now,
        });
        let _ = db.save_insertion_action(&InsertionActionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: Some(session_id.to_string()),
            recording_id: Some(recording_id.clone()),
            requested_mode: requested_insertion_mode.clone(),
            actual_mode: actual_insertion_mode.clone(),
            pasted,
            copied,
            failed: paste_error.is_some() && !pasted && !copied,
            undo_token: None,
            command_applied: command_applied.clone(),
            snippet_applied_count: snippet_applied_count as i64,
            app_target: app_target.clone(),
            error: paste_error.clone(),
            created_at: now,
        });

        let custom_mode = active_dictation_custom_mode(&settings_snapshot);
        let audit_details = strip_captured_context_from_dictation_audit(serde_json::json!({
            "recording_id": &recording_id,
            "session_id": session_id.to_string(),
            "stop_reason": stop_reason,
            "dictation_mode_preset": dictation_options.resolved_mode_preset,
            "dictation_mode_label": dictation_options.resolved_mode_label,
            "dictation_base_mode_preset": effective_mode,
            "dictation_base_mode_label": resolved_dictation_base_mode_label(&settings_snapshot),
            "dictation_custom_mode_id": custom_mode.map(|mode| mode.id.clone()),
            "dictation_custom_mode_name": custom_mode.map(|mode| mode.name.clone()),
            "context_source": normalize_dictation_context_source(&dictation_options.context_source),
            "context_app_name": dictation_options.context_app_name,
            "app_target": app_target,
            "activation_matcher": dictation_options.activation_matcher,
            "command_applied": command_applied,
            "dictionary_applied_count": dictionary_applied_count,
            "snippet_applied_count": snippet_applied_count,
            "vocabulary_hint_terms_built": vocabulary_hint_terms_built,
            "vocabulary_hint_terms_applied": vocabulary_hint_terms_applied,
            "formatting_applied": formatting_applied,
            "recent_insert_reused": recent_insert_reused,
            "pipeline_stage_keys": pipeline_stage_keys,
            "prompt_source": prompt_source,
            "prompt_preview": prompt_preview,
            "requested_provider": asr_provider_to_settings_value(transcription_result.requested_provider),
            "actual_provider": asr_provider_to_settings_value(transcription_result.actual_provider),
            "model_id": transcription_result.model_id,
            "route_preference": dictation_options.route_preference,
            "resolved_hosting": dictation_options.resolved_hosting,
            "acknowledgement_latency_ms": acknowledgement_latency_ms,
            "capture_ready_latency_ms": capture_ready_latency_ms,
            "first_stable_partial_latency_ms": first_stable_partial_latency_ms,
            "final_transcript_latency_ms": final_transcript_latency_ms,
            "startup_latency_ms": startup_latency_ms,
            "transcription_latency_ms": transcription_latency_ms,
            "insert_latency_ms": insert_latency_ms,
            "end_to_end_ms": end_to_end_ms,
            "outcome": outcome,
            "warnings": warnings,
            "timing": dictation_timing_record,
        }));
        // Added after the literal above: `serde_json::json!` expands
        // recursively per key and that object already sits at the compiler's
        // recursion limit.
        let mut audit_details = audit_details;
        if let Some(map) = audit_details.as_object_mut() {
            map.insert(
                "dictation_mode_override".to_string(),
                serde_json::json!(dictation_options
                    .mode_override
                    .as_ref()
                    .map(|value| value.preset.clone())),
            );
            map.insert(
                "detected_language".to_string(),
                serde_json::json!(transcription_result.language),
            );
            map.insert(
                "translation_route".to_string(),
                serde_json::json!(translation_route.as_audit_value()),
            );
            map.insert(
                "translation_applied".to_string(),
                serde_json::json!(translation_route
                    .as_audit_value()
                    .map(|_| translation_applied)),
            );
        }
        let _ = db.log_audit_event("dictation_completed", Some(audit_details), "info");
    }

    // A cloud dictation route may have left a file behind on the provider's
    // side. There is no finished recording to hang a note on here, so this
    // lands in the audit log only.
    report_provider_cleanup_warnings(state, None::<(&crate::sidecar_handle::SidecarHandle, &str)>)
        .await;

    {
        let mut recent_delivery_slot = state.recent_dictation_delivery.lock().await;
        if pasted || copied {
            *recent_delivery_slot = Some(RecentDictationDelivery {
                text: final_text.clone(),
                app_target: app_target.clone(),
                app_bundle_id: app_bundle_id.clone(),
                delivered_at: now,
                undo_eligible: insertion_confirmed_flag,
            });
        } else if undo_performed {
            *recent_delivery_slot = None;
        }
    }

    if let Some(anchor) = post_insert_focus_anchor {
        schedule_post_insert_correction_readback(
            state,
            handle,
            final_text.clone(),
            app_target.clone(),
            anchor,
            now,
        );
    }

    reset_dictation_session_runtime(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
    )
    .await;

    let done_message = dictation_done_message(&outcome, final_text.is_empty(), &warnings);

    // Emit done phase so the popup shows the result, then idle to dismiss it.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "done".to_string();
        overlay.message = Some(done_message.clone());
        overlay.preview = Some(final_text.clone());
        overlay.stop_reason = Some(stop_reason.to_string());
        overlay.outcome = Some(outcome.clone());
    }
    let payload = build_dictation_text_ready_payload(
        session_id,
        stop_reason,
        &outcome,
        &transcription_result,
        pasted,
        copied,
        paste_error.as_deref(),
        fallback_message.as_deref(),
        acknowledgement_latency_ms,
        capture_ready_latency_ms,
        first_stable_partial_latency_ms,
        final_transcript_latency_ms,
        startup_latency_ms,
        transcription_latency_ms,
        insert_latency_ms,
        end_to_end_ms,
        acknowledged_at_epoch_ms,
        capture_ready_at_epoch_ms,
        first_stable_partial_at_epoch_ms,
        final_transcript_at_epoch_ms,
        insertion_completed_at_epoch_ms,
        actual_insertion_mode.as_str(),
        command_applied.as_deref(),
        dictionary_applied_count,
        snippet_applied_count,
        formatting_applied,
        recent_insert_reused,
        &pipeline_stage_keys,
        app_target.as_deref(),
        dictation_options.activation_matcher.as_deref(),
        Some(normalize_dictation_context_source(
            &dictation_options.context_source,
        )),
        dictation_options
            .captured_context_text
            .as_deref()
            .map(|value| value.chars().count()),
        dictation_options.route_preference.as_deref(),
        dictation_options.resolved_route.as_deref(),
        dictation_options.resolved_hosting.as_deref(),
        dictation_options.provider_model_label.as_deref(),
        &warnings,
        dictation_timing_record,
    );
    let mut payload_value = match serde_json::to_value(payload) {
        Ok(value) => value,
        Err(error) => {
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                None,
                format!("Failed to build the dictation result event: {}", error),
            )
            .await);
        }
    };
    if let Some(object) = payload_value.as_object_mut() {
        object.insert(
            "text".to_string(),
            serde_json::Value::String(final_text.clone()),
        );
    }
    record_recent_dictation_result(
        state,
        &final_text,
        app_target.as_deref(),
        dictation_options.context_app_bundle_id.as_deref(),
    );
    handle.emit_event("dictation-text-ready", payload_value);
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "done",
            "sessionId": session_id,
            "stopReason": stop_reason,
            "outcome": outcome,
            "preview": &final_text,
            "message": done_message,
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": actual_insertion_mode,
            "appTarget": app_target.clone(),
            "activationMatcher": dictation_options.activation_matcher,
            "dictationProvider": asr_provider_to_settings_value(provider_type),
            "dictationModelId": actual_model_id.clone(),
            "requestedProvider": asr_provider_to_settings_value(transcription_result.requested_provider),
            "actualProvider": asr_provider_to_settings_value(transcription_result.actual_provider),
            "requestedModelId": dictation_options.requested_model_id.clone(),
            "actualModelId": dictation_options.actual_model_id.clone(),
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    // Honor the dictation retention preset as soon as a session completes
    // (mirrors `enforce_meeting_retention_policy` after meeting
    // transcription), so "Immediately"/short retention windows work without
    // waiting for the daily maintenance pass.
    if let Err(error) =
        enforce_dictation_retention_policy(state, Some(handle), "dictation-completed").await
    {
        tracing::warn!(
            "Dictation retention cleanup after session completion failed: {}",
            error
        );
    }

    // Keep the result visible briefly, then reset to idle — but do it on a
    // detached task so this command returns immediately. Otherwise the stop
    // handler blocks for ~1.8s, which (a) delays the response and (b) prevented
    // starting the next dictation until the display window elapsed.
    //
    // A delivery failure lands here too, and it needs the longer error window:
    // the words exist only in dictation history, so 1.8s is not enough time to
    // notice that nothing arrived and act on it.
    schedule_dictation_overlay_idle_reset(
        state,
        handle,
        session_id,
        stop_reason,
        dictation_overlay_idle_reset_delay_ms(&outcome),
    );

    Ok(final_text)
}

/// How long the done HUD stays up before resetting to idle. A successful
/// delivery is self-evident and gets the short window; a failed one leaves the
/// text only in dictation history, so the user needs long enough to notice and
/// reach for it.
pub(crate) fn dictation_overlay_idle_reset_delay_ms(outcome: &str) -> u64 {
    // A secure-field refusal is a non-delivery too: the words exist only in
    // dictation history, so it gets the same longer window as an error.
    if outcome == "error" || outcome == dictation_secure_field::SECURE_FIELD_REASON_CODE {
        DICTATION_IDLE_RESET_ERROR_MS
    } else {
        DICTATION_IDLE_RESET_SUCCESS_MS
    }
}

/// Whether a scheduled idle reset still owns the overlay it was scheduled for.
/// `None` means no session has claimed the overlay, so the reset is safe.
pub(crate) fn dictation_idle_reset_applies(
    overlay_session_id: Option<u64>,
    scheduled_for: u64,
) -> bool {
    match overlay_session_id {
        Some(active) => active == scheduled_for,
        None => true,
    }
}

/// Take the always-on-top dictation HUD down after `delay_ms` and put the
/// overlay state back to idle. Detached so the caller returns immediately.
///
/// Every terminal phase must schedule one of these. A phase that emits `done`
/// or `error` and schedules nothing leaves a floating panel on screen with no
/// timer behind it, which is exactly how a failed dictation used to park the
/// HUD over the user's work until they found the close button.
pub(crate) fn schedule_dictation_overlay_idle_reset(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    session_id: u64,
    stop_reason: &str,
    delay_ms: u64,
) {
    let overlay_state = Arc::clone(&state.dictation_overlay_state);
    let idle_handle = handle.clone();
    let idle_stop_reason = stop_reason.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        if let Ok(mut overlay) = overlay_state.lock() {
            // A newer session may have claimed the overlay while this timer
            // ran; resetting then would hide a HUD that is legitimately live.
            if !dictation_idle_reset_applies(overlay.session_id, session_id) {
                return;
            }
            *overlay = DictationOverlayState::default();
        }
        idle_handle.emit_event(
            "dictation-state-changed",
            serde_json::json!({
                "phase": "idle",
                "sessionId": session_id,
                "stopReason": idle_stop_reason,
            }),
        );
        idle_handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
    });
}

/// Follow one insertion up: a few seconds later, look once at the field it
/// landed in and see whether the user fixed a word there.
///
/// Only ever reached when `capture_insertion_anchor` already found the inserted
/// text sitting in that field, which itself only runs when the user turned the
/// setting on. Detached so the stop handler returns immediately, and written so
/// that every way this can go wrong is a silent no-op:
///
/// - the setting was turned off during the wait → nothing read;
/// - a newer dictation was delivered → nothing read (the anchor describes a
///   field the user has already moved on from);
/// - the frontmost app, the owning process or the focused element changed →
///   read, then discarded without being diffed;
/// - the field is empty, unreadable, unchanged, or no longer recognisably holds
///   the insertion → discarded.
///
/// What it produces, at most, is queued suggestions. Nothing on this path can
/// change the dictionary; only the user approving a suggestion does that.
pub(crate) fn schedule_post_insert_correction_readback(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    inserted_text: String,
    app_target: Option<String>,
    anchor: dictation_correction_capture::FocusedFieldFingerprint,
    delivered_at: chrono::DateTime<chrono::Utc>,
) {
    let db = Arc::clone(&state.db);
    let settings_manager = Arc::clone(&state.settings_manager);
    let recent_delivery = Arc::clone(&state.recent_dictation_delivery);
    let readback_handle = handle.clone();

    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            dictation_correction_capture::POST_INSERT_READBACK_WINDOW_SECS.max(0) as u64,
        ))
        .await;

        // Re-read the setting rather than trusting the value from insertion
        // time: the user may have turned it off in the seconds since, and the
        // answer to "may Plainsong read that field" has to be the current one.
        let enabled = {
            let manager = settings_manager.lock().await;
            manager
                .settings()
                .transcription
                .dictation_learn_from_external_corrections
        };

        let delivery_is_current = recent_delivery
            .lock()
            .await
            .as_ref()
            .map(|delivery| delivery.delivered_at == delivered_at)
            .unwrap_or(false);

        let known_dictionary_spoken_forms = {
            let db = db.lock().await;
            db.list_dictation_dictionary_entries()
                .map(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| entry.spoken_form.to_lowercase())
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default()
        };

        let request = dictation_correction_capture::PostInsertReadbackRequest {
            enabled,
            inserted_text,
            insertion_fingerprint: anchor,
            elapsed_secs: chrono::Utc::now()
                .signed_duration_since(delivered_at)
                .num_seconds(),
            delivery_is_current,
            known_dictionary_spoken_forms,
        };

        let outcome = match tokio::task::spawn_blocking(move || {
            dictation_correction_capture::evaluate_post_insert_readback(
                &MacosFocusedFieldReader,
                &request,
            )
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(join_error) => {
                tracing::warn!(
                    "Post-insert correction readback did not complete: {}",
                    join_error
                );
                return;
            }
        };

        let candidates = match outcome {
            dictation_correction_capture::ReadbackOutcome::Candidates(candidates) => candidates,
            dictation_correction_capture::ReadbackOutcome::Aborted(abort) => {
                // Debug, not warn: every abort here is the feature working.
                tracing::debug!("Post-insert correction readback stopped: {:?}", abort);
                return;
            }
        };

        let mut queued = 0usize;
        {
            let mut db = db.lock().await;
            for candidate in &candidates {
                match db.upsert_dictation_correction_suggestion(
                    candidate.spoken_form.as_str(),
                    candidate.replacement.as_str(),
                    candidate.spoken_form.as_str(),
                    candidate.replacement.as_str(),
                    app_target.as_deref(),
                    Some(models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
                ) {
                    Ok(_) => queued += 1,
                    Err(error) => {
                        tracing::warn!("Queuing a correction suggestion failed: {}", error);
                    }
                }
            }
            if let Err(error) = db.prune_dictation_correction_suggestions(
                chrono::Utc::now(),
                dictation_correction_capture::CORRECTION_SUGGESTION_MAX_AGE_DAYS,
                dictation_correction_capture::CORRECTION_SUGGESTION_QUEUE_CAP,
            ) {
                tracing::warn!("Pruning stale correction suggestions failed: {}", error);
            }
        }

        if queued > 0 {
            readback_handle.emit_event(
                "dictation-correction-suggestions-changed",
                serde_json::json!({
                    "queued": queued,
                    "appTarget": app_target,
                    "source": models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP,
                }),
            );
        }
    });
}

#[cfg(test)]
mod dictation_idle_reset_tests {
    use super::dictation_idle_reset_applies;

    /// The timer scheduled for the session that is still on screen must fire;
    /// this is what stops a failed dictation from parking an always-on-top
    /// panel over the user's work until they hunt down the close button.
    #[test]
    fn a_reset_applies_to_the_session_it_was_scheduled_for() {
        assert!(dictation_idle_reset_applies(Some(7), 7));
        assert!(dictation_idle_reset_applies(None, 7));
    }

    /// ...but a timer from an older session must not hide the HUD of a session
    /// the user just started.
    #[test]
    fn a_stale_reset_never_hides_a_newer_sessions_hud() {
        assert!(!dictation_idle_reset_applies(Some(8), 7));
    }

    /// `fail_dictation_stop` needs a live `AppState` to run, so the invariant
    /// that made a failed dictation park an always-on-top panel forever --- it
    /// emitted a terminal `error` phase and scheduled no reset, unlike the
    /// success path --- is asserted against its shape instead.
    #[test]
    fn the_terminal_error_path_schedules_its_own_idle_reset() {
        const SOURCE: &str = include_str!("dictation_session.rs");
        let start = SOURCE
            .find("async fn fail_dictation_stop(")
            .expect("fail_dictation_stop must exist");
        let end = start
            + SOURCE[start..]
                .find("\n}\n")
                .expect("fail_dictation_stop must be closed");
        let body = &SOURCE[start..end];

        assert!(
            body.contains("schedule_dictation_overlay_idle_reset("),
            "fail_dictation_stop must schedule an idle reset; without one the error HUD stays \
             on screen, always on top, until the user finds the close button"
        );
        assert!(
            body.contains("DICTATION_IDLE_RESET_ERROR_MS"),
            "the error path must use the longer error window, not the success one"
        );
        // Every terminal stop failure funnels through here, and several of
        // them (audio finalization failing, an unreadable capture) happen
        // before the success path's own close. Without this the streaming
        // preview would keep its recognizer -- and its model -- alive after
        // the session it belonged to had already ended in an error.
        assert!(
            body.contains(
                "stop_dictation_live_preview_for_session(state, context.session_id).await;"
            ),
            "the terminal error path must close the live preview; a failed stop otherwise \
             leaves the streaming engine loaded with no session to end it"
        );
        let close = body
            .find("stop_dictation_live_preview_for_session(state, context.session_id).await;")
            .expect("the error path must close the live preview");
        let reset = body
            .find("reset_dictation_session_runtime_if_current(")
            .expect("the error path must reset the session runtime");
        assert!(
            reset < close,
            "session ownership must be checked before scoped preview cleanup"
        );
    }

    #[test]
    fn audio_guard_is_released_before_stop_failure_cleanup() {
        const SOURCE: &str = include_str!("dictation_session.rs");
        let start = SOURCE
            .find("let audio_stop_result = {")
            .expect("scoped audio stop result");
        let body = &SOURCE[start..];
        let guard_end = body.find("};").expect("audio guard end");
        let failure = body.find("fail_dictation_stop(").expect("failure cleanup");
        assert!(
            guard_end < failure,
            "failure cleanup must run after the audio guard is dropped"
        );
    }
}

#[cfg(test)]
mod recent_dictation_result_tests {
    use super::{
        push_recent_dictation_result, RecentDictationResult, RECENT_DICTATION_RESULT_LIMIT,
    };

    fn result(text: &str) -> RecentDictationResult {
        RecentDictationResult {
            text: text.to_string(),
            app_target: None,
            app_bundle_id: None,
            at_ms: 0,
        }
    }

    /// The recovery hotkeys bind to index 0, so "most recent" has to be the
    /// first entry — re-pasting the oldest of three results would be worse
    /// than doing nothing.
    #[test]
    fn newest_result_is_first_and_the_list_is_capped() {
        let mut results = Vec::new();
        for index in 0..6 {
            push_recent_dictation_result(&mut results, result(&format!("result {index}")));
        }

        assert_eq!(results.len(), RECENT_DICTATION_RESULT_LIMIT);
        assert_eq!(results[0].text, "result 5");
        assert_eq!(results[2].text, "result 3");
    }

    /// A session that produced nothing (silence, a cancelled command) must not
    /// push a blank entry that shadows the last result the user actually wants
    /// back.
    #[test]
    fn blank_results_are_not_offered_for_recovery() {
        let mut results = vec![result("keep me")];

        push_recent_dictation_result(&mut results, result(""));
        push_recent_dictation_result(&mut results, result("   \n  "));

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "keep me");
    }

    /// Source of `reuse_recent_dictation_result`. It needs a live `AppState`
    /// and a real macOS window server to run, so the invariant that keeps the
    /// recovery hotkey from hijacking the user's frontmost app is asserted
    /// against its shape — the same approach `owned_stop_dictation_body` takes.
    fn reuse_recent_dictation_result_body() -> &'static str {
        const SOURCE: &str = include_str!("dictation_session.rs");

        let start = SOURCE
            .find("fn reuse_recent_dictation_result(")
            .expect("reuse_recent_dictation_result must exist");
        let end = start
            + SOURCE[start..]
                .find("\n}\n")
                .expect("reuse_recent_dictation_result must be closed");
        &SOURCE[start..end]
    }

    /// The recovery hotkey is pressed *after* the user has moved on — that is
    /// what it is for. Handing the stored session's app back to
    /// `paste_text_systemwide` makes `reactivate_target_application` shell
    /// `open -b <bundle>`, which raises (or relaunches, since nothing expires
    /// this list) the old app and inserts there instead of at the caret the
    /// user is actually looking at.
    #[test]
    fn repaste_targets_the_current_frontmost_app_not_the_original_one() {
        let body = reuse_recent_dictation_result_body();

        assert!(
            body.contains("resolve_recent_dictation_repaste_target()"),
            "the re-paste target must be re-resolved at re-paste time"
        );
        assert!(
            !body.contains("result.app_target"),
            "the stored session's app must not be reactivated by the recovery hotkey"
        );
        assert!(
            !body.contains("result.app_bundle_id"),
            "the stored session's bundle id must not be reactivated by the recovery hotkey"
        );
    }

    /// Re-paste is an insertion action, not an implicit copy action. Keeping
    /// the recovered text on the clipboard would bypass the user's disabled
    /// clipboard-retention preference; the separate re-copy branch remains
    /// the explicit way to retain it.
    #[test]
    fn repaste_does_not_retain_the_result_on_the_clipboard() {
        let body = reuse_recent_dictation_result_body();
        let paste_call = body
            .split("let outcome = paste_text_systemwide(")
            .nth(1)
            .expect("re-paste must call paste_text_systemwide");

        assert!(
            paste_call.contains("&result.text,\n        false,"),
            "re-paste must restore the prior clipboard after fallback insertion"
        );
        assert!(
            body.contains("if !paste {\n        copy_to_clipboard(&result.text)?;"),
            "re-copy must remain the explicit clipboard-retention action"
        );
    }
}
