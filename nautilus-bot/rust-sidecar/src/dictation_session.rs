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
use crate::settings::Settings;

/// Keep current consent locked through the field read. Selected-text delivery
/// already owns this lock, so transfer that authority instead of reacquiring it.
fn with_insertion_anchor_consent<T>(
    settings: &Arc<tokio::sync::Mutex<settings::SettingsManager>>,
    held: Option<tokio::sync::OwnedMutexGuard<settings::SettingsManager>>,
    read: impl FnOnce() -> Option<T>,
) -> (
    Option<T>,
    Option<tokio::sync::OwnedMutexGuard<settings::SettingsManager>>,
) {
    let authority = held.or_else(|| Arc::clone(settings).try_lock_owned().ok());
    let anchor = if authority.as_ref().is_some_and(|manager| {
        manager
            .settings()
            .transcription
            .dictation_learn_from_external_corrections
    }) {
        read()
    } else {
        None
    };
    (anchor, authority)
}

fn dictation_history_requested_for_capture(
    save_to_inbox: bool,
    retention_preset: &str,
    meeting_aside: bool,
) -> bool {
    !meeting_aside && should_persist_dictation(save_to_inbox, retention_preset)
}

/// A completed dictation belongs in durable history only when the row retains
/// something the reader can use: text, or validated audio that can be processed
/// again. Retention and inbox settings remain the outer privacy gate.
fn should_persist_completed_dictation(
    history_requested: bool,
    stored_text: &str,
    kept_audio_ready: bool,
) -> bool {
    history_requested && (!stored_text.trim().is_empty() || kept_audio_ready)
}

fn should_persist_failed_dictation_recovery(
    save_to_inbox: bool,
    retention_preset: &str,
    keep_audio: bool,
) -> bool {
    keep_audio
        && retention_preset != "off"
        && should_persist_dictation(save_to_inbox, retention_preset)
}

/// A just-written WAV that failed validation cannot be linked from the
/// recording transaction. Remove it now so skipping an unusable empty row does
/// not leave an orphan in the recordings directory.
fn discard_unvalidated_kept_audio(
    kept_audio_path: &mut Option<std::path::PathBuf>,
) -> std::io::Result<()> {
    if let Some(path) = kept_audio_path.take() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

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
    /// Delivery was refused and the clipboard fallback was skipped because
    /// someone else wrote to the clipboard meanwhile. Their newer copy was
    /// left alone; the words are in history or Recent dictations.
    pub(crate) newer_clipboard_kept: bool,
    pub(crate) has_paste_error: bool,
    /// The user asked for clipboard-only delivery, so a copy is the goal
    /// rather than a fallback from a failed insert.
    pub(crate) clipboard_requested: bool,
    /// The outcome already set before delivery ran (an undo-only session,
    /// or nothing at all), kept when delivery reported nothing.
    pub(crate) previous: &'a str,
}

/// Outcome for a refused delivery whose clipboard fallback was skipped to keep
/// a copy the user made while Plainsong was working.
pub(crate) const NEWER_CLIPBOARD_KEPT_OUTCOME: &str = "clipboard_kept";

/// Where the words can be picked up again after a session, kept apart from
/// the outcome, which only says what delivery observed. A paste that was
/// dispatched but not read back can leave the text on the clipboard or not;
/// either way the observation is the same, and only this says where to look.
pub(crate) fn dictation_recovery_location(
    copied: bool,
    final_text_is_empty: bool,
    history_persisted: bool,
) -> Option<&'static str> {
    if final_text_is_empty {
        None
    } else if copied {
        Some("clipboard")
    } else if history_persisted {
        Some("history")
    } else {
        Some("recent_dictations")
    }
}

pub(crate) fn resolve_dictation_delivery_outcome(facts: DictationDeliveryFacts<'_>) -> String {
    if facts.pasted {
        if !facts.confirmed {
            "paste_dispatched".to_string()
        } else if facts.undo_performed {
            "replaced".to_string()
        } else {
            "pasted".to_string()
        }
    } else if facts.copied {
        if facts.undo_performed {
            "copied_replacement".to_string()
        } else if facts.clipboard_requested {
            "copied".to_string()
        } else {
            "copied_instead".to_string()
        }
    } else if facts.secure_field_refused {
        dictation_secure_field::SECURE_FIELD_REASON_CODE.to_string()
    } else if facts.newer_clipboard_kept {
        "clipboard_kept".to_string()
    } else if facts.has_paste_error {
        "error".to_string()
    } else {
        facts.previous.to_string()
    }
}

/// Facts the done message names: where the text went, whether Return was
/// pressed after it, and why delivery failed.
#[derive(Default, Clone, Copy)]
pub(crate) struct DictationDoneContext<'a> {
    pub(crate) app: Option<&'a str>,
    /// `None` when Return after inserting was not requested.
    pub(crate) submit_after_insert_sent: Option<bool>,
    pub(crate) delivery_error: Option<&'a str>,
    /// The session was not written to dictation history (history is off, or
    /// retention keeps nothing). The words then live only in the popup and the
    /// paste-last slot, and the message must not send the reader to history.
    pub(crate) history_off: bool,
}

pub(crate) fn dictation_done_message(
    outcome: &str,
    final_text_is_empty: bool,
    copied: bool,
    warnings: &[String],
    context: DictationDoneContext<'_>,
) -> String {
    let app = context
        .app
        .map(str::trim)
        .filter(|app| !app.is_empty())
        .unwrap_or("the app");
    let outcome_message = match outcome {
        "pasted" | "replaced" if context.submit_after_insert_sent == Some(true) => {
            format!("Inserted and sent in {app}.")
        }
        "pasted" | "replaced" => format!("Inserted into {app}."),
        // Refused on purpose: the focused control is a password or other
        // secure input. Says so, says nothing was copied either, and says
        // where the words are.
        dictation_secure_field::SECURE_FIELD_REASON_CODE if context.history_off => {
            "Not inserted: the field in front is a password or secure input. Plainsong did not insert or copy the words. History is off; they are under Recent dictations in the Plainsong menu bar menu.".to_string()
        }
        dictation_secure_field::SECURE_FIELD_REASON_CODE => {
            "Not inserted: the field in front is a password or secure input. Plainsong did not insert or copy the words; they are saved in your dictation history.".to_string()
        }
        // The paste keystroke was sent but nothing confirmed the app took it.
        "paste_dispatched" if copied => format!(
            "Plainsong couldn't confirm the text landed in {app}. If it's missing, press Cmd+V."
        ),
        "paste_dispatched" => format!(
            "Plainsong couldn't confirm the text landed in {app}. If it's missing, use Copy result in Plainsong."
        ),
        "copied_instead" => format!(
            "Couldn't insert into {app}, so the text is on your clipboard. Press Cmd+V to paste it."
        ),
        NEWER_CLIPBOARD_KEPT_OUTCOME if context.history_off => format!(
            "Not inserted into {app}. You copied something while Plainsong was working, so your clipboard was left alone. History is off; copy the words from Recent dictations in the Plainsong menu bar menu."
        ),
        NEWER_CLIPBOARD_KEPT_OUTCOME => format!(
            "Not inserted into {app}. You copied something while Plainsong was working, so your clipboard was left alone. The words are saved in your dictation history."
        ),
        "copied" | "copied_replacement" => "Copied to the clipboard and ready to paste.".to_string(),
        "previewed" => "Ready in Plainsong.".to_string(),
        "undone" => "Undo applied.".to_string(),
        "command_applied" => "Voice edit applied.".to_string(),
        "error" => {
            let kept = if context.history_off {
                "History is off; copy it from Recent dictations in the Plainsong menu bar menu."
            } else {
                "The text is saved in your dictation history."
            };
            match context.delivery_error.map(str::trim).filter(|e| !e.is_empty()) {
                Some(error) => format!("Not inserted. {error} {kept}"),
                None => format!("Not inserted. {kept}"),
            }
        }
        _ if final_text_is_empty => "No speech detected.".to_string(),
        _ => "Result ready.".to_string(),
    };
    let submit_note = (context.submit_after_insert_sent == Some(false)).then_some(
        "Return not pressed: Plainsong couldn't confirm the text was in the same field. Check it, then press Return yourself.",
    );
    std::iter::once(outcome_message.as_str())
        .chain(submit_note)
        .chain(warnings.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether a delivery that put the words nowhere should leave them on the
/// clipboard instead.
///
/// Secure-field refusals are excluded on purpose (dictated words aimed at a
/// password box do not belong on a clipboard every app can read), and so is a
/// clipboard someone other than Plainsong changed while delivery ran: that is
/// the user copying something, which must survive. Plainsong putting back a
/// clipboard it staged for a refused paste does not count as a change.
pub(crate) fn refused_delivery_needs_clipboard_copy(
    outcome: &PasteOutcome,
    clipboard_untouched: bool,
    text_is_empty: bool,
) -> bool {
    !outcome.pasted
        && !outcome.copied
        && outcome.secure_field.is_none()
        && outcome.error.is_some()
        && clipboard_untouched
        && !text_is_empty
}

/// A refused delivery that would have gone to the clipboard, except that
/// someone other than Plainsong wrote to the clipboard meanwhile.
pub(crate) fn refused_delivery_kept_newer_clipboard(
    outcome: &PasteOutcome,
    clipboard_untouched: bool,
    text_is_empty: bool,
) -> bool {
    !clipboard_untouched && refused_delivery_needs_clipboard_copy(outcome, true, text_is_empty)
}

/// Put refused dictation on the clipboard, re-checking the field in front for
/// a secure input first. The refusal reason is kept for history and audit.
///
/// The clipboard is checked again right before the copy: the user can copy
/// something while the secure-field probe runs, and that newer copy wins.
/// The second value is `true` when that is why nothing was copied.
pub(crate) fn clipboard_fallback_for_refused_delivery(
    outcome: PasteOutcome,
    text: &str,
    probe_secure_field: impl FnOnce() -> Option<dictation_secure_field::SecureFieldSignal>,
    clipboard_still_untouched: impl FnOnce() -> bool,
    copy: impl FnOnce(&str) -> Result<(), String>,
) -> (PasteOutcome, bool) {
    if let Some(signal) = probe_secure_field() {
        return (secure_field_refusal_outcome(signal), false);
    }
    if !clipboard_still_untouched() {
        return (outcome, true);
    }
    match copy(text) {
        Ok(()) => (
            PasteOutcome {
                copied: true,
                ..outcome
            },
            false,
        ),
        Err(copy_error) => {
            let reason = outcome.error.clone().unwrap_or_default();
            (
                PasteOutcome {
                    error: Some(
                        format!("{reason} Clipboard copy also failed: {copy_error}")
                            .trim()
                            .to_string(),
                    ),
                    ..outcome
                },
                false,
            )
        }
    }
}

/// The refused-delivery fallback as the stop path runs it: put the words on
/// the clipboard unless the field in front is secure, the session lost
/// ownership, or someone else changed the clipboard since
/// `clipboard_count_before_delivery`. Returns the final outcome and whether a
/// newer user clipboard was kept.
async fn apply_refused_delivery_fallback(
    state: &AppState,
    session_id: u64,
    paste_outcome: PasteOutcome,
    final_text: &str,
    clipboard_count_before_delivery: Option<isize>,
) -> (PasteOutcome, bool) {
    let text_is_empty = final_text.trim().is_empty();
    let clipboard_untouched =
        crate::text_insert::clipboard_unchanged_by_others_since(clipboard_count_before_delivery);
    if refused_delivery_kept_newer_clipboard(&paste_outcome, clipboard_untouched, text_is_empty) {
        return (paste_outcome, true);
    }
    if !refused_delivery_needs_clipboard_copy(&paste_outcome, clipboard_untouched, text_is_empty)
        || !dictation_delivery_may_publish(
            &*state.dictation_session_tracker.lock().await,
            session_id,
        )
    {
        return (paste_outcome, false);
    }
    let text = final_text.to_string();
    tokio::task::spawn_blocking(move || {
        clipboard_fallback_for_refused_delivery(
            paste_outcome,
            text.as_str(),
            probe_clipboard_delivery_secure_field,
            || {
                crate::text_insert::clipboard_unchanged_by_others_since(
                    clipboard_count_before_delivery,
                )
            },
            copy_to_clipboard,
        )
    })
    .await
    .unwrap_or_else(|join_error| {
        tracing::error!("Clipboard fallback did not complete: {}", join_error);
        (
            PasteOutcome {
                pasted: false,
                copied: false,
                direct_accessibility: false,
                confirmed: false,
                paste_requested: false,
                successful_strategy: None,
                secure_field: None,
                error: Some("Not inserted, and the clipboard copy did not complete.".to_string()),
            },
            false,
        )
    })
}

fn live_dictation_insertion_mode(saved: &str, delivery: models::DictationDeliveryMode) -> String {
    if delivery == models::DictationDeliveryMode::Preview {
        "preview".to_string()
    } else {
        normalize_dictation_insertion_mode(saved).to_string()
    }
}

pub(crate) fn should_deliver_dictation_text(delivery_mode: models::DictationDeliveryMode) -> bool {
    delivery_mode == models::DictationDeliveryMode::System
}

pub(crate) fn is_intentional_dictation_command_output(
    candidate: &str,
    command_applied: Option<&str>,
) -> bool {
    matches!(
        (command_applied, candidate),
        (Some("newline"), "\n")
            | (Some("paragraph"), "\n\n")
            | (
                Some(
                    "delete_selection"
                        | "select_phrase"
                        | "move_to_start"
                        | "move_to_end"
                        | "delete_that"
                        | "replace_selection_text"
                        | "replace_selection"
                        | "append_to_selection"
                        | "prepend_to_selection"
                        | "uppercase_selection"
                        | "lowercase_selection"
                        | "title_case_selection"
                        | "sentence_case_selection"
                        | "newline"
                        | "paragraph"
                        | "delete_phrase"
                        | "undo_last_insert"
                        | "delete_last_sentence"
                        | "backtrack_undo_last_insert"
                ),
                ""
            )
    )
}

pub(crate) fn dictation_history_final_text(
    final_text: &str,
    raw_text: &str,
    command_applied: Option<&str>,
) -> String {
    if final_text.trim().is_empty()
        && !is_intentional_dictation_command_output(final_text, command_applied)
    {
        raw_text.to_string()
    } else {
        final_text.to_string()
    }
}

/// The destination category the stop path resolves once per dictation:
/// settings overrides, then bundle id and app name, then the browser-domain
/// formatting hint. Shared with the end-to-end fidelity harness.
pub(crate) fn resolve_dictation_destination_category(
    settings: &Settings,
    options: &models::DictationStartOptions,
) -> crate::text::format::DictationAppCategory {
    let formatting_hint = resolve_dictation_formatting_hint(
        options.context_app_name.as_deref(),
        options.activation_matcher.as_deref(),
        options.context_app_name.as_deref(),
    );
    settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings.transcription,
        options.context_app_name.as_deref(),
        options.context_app_bundle_id.as_deref(),
        formatting_hint.as_deref(),
    )
}

/// Where the local text pass is headed: the app name, its resolved
/// category, and the focused control's accessibility role.
pub(crate) struct LocalDictationDestination<'a> {
    /// The decided spoken language (`text::language::dictation_spoken_language`).
    pub(crate) spoken_language: Option<&'a str>,
    pub(crate) app_target: Option<&'a str>,
    pub(crate) category: crate::text::format::DictationAppCategory,
    pub(crate) field_role: Option<&'a str>,
}

/// The deterministic local pass between recognition and any AI pass, with
/// every switch read from settings exactly as dictation reads it. The
/// end-to-end fidelity harness calls this same function, so what it scores
/// is what the stop path inserts.
pub(crate) fn run_local_dictation_pipeline(
    raw_transcribed_text: &str,
    settings: &Settings,
    dictionary_entries: &[models::DictationDictionaryEntry],
    snippets: &[models::DictationSnippet],
    recent_inserted_text: Option<&str>,
    destination: LocalDictationDestination<'_>,
) -> crate::dictation_pipeline::DictationPipelineResult {
    crate::dictation_pipeline::apply_dictation_pipeline(
        crate::dictation_pipeline::DictationPipelineInput {
            spoken_language: destination.spoken_language,
            text: raw_transcribed_text,
            dictionary_entries,
            snippets,
            app_target: destination.app_target,
            mode_preset: resolved_dictation_mode_preset(settings),
            smart_formatting_enabled: true,
            clean_disfluencies: settings.transcription.dictation_remove_disfluencies,
            numbers_as_digits: resolve_dictation_numbers_as_digits(settings),
            recent_inserted_text,
            command_mode_enabled: settings.transcription.dictation_command_mode_enabled,
            destination_category: destination.category,
            // Lists, paragraphs and email lines only where the user kept
            // destination-aware formatting on and the focused control
            // takes more than one line.
            structured_layout: settings.transcription.dictation_category_formatting_enabled
                && crate::text::layout::field_role_allows_line_breaks(destination.field_role),
        },
    )
}

pub(crate) fn finalize_dictation_result_text(
    candidate: &str,
    raw_transcribed_text: &str,
    command_applied: Option<&str>,
) -> String {
    if is_intentional_dictation_command_output(candidate, command_applied) {
        candidate.to_string()
    } else {
        sanitize_dictation_output(candidate, raw_transcribed_text)
            .trim()
            .to_string()
    }
}

pub(crate) fn should_insert_dictation_result(
    final_text: &str,
    command_applied: Option<&str>,
    undo_previous_insert: bool,
    undo_performed: bool,
) -> bool {
    (!final_text.trim().is_empty()
        || matches!(
            (command_applied, final_text),
            (Some("newline"), "\n") | (Some("paragraph"), "\n\n")
        )
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

async fn claim_dictation_start_session(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
    options: &models::DictationStartOptions,
    session_started_at_ms: i64,
    insertion_mode: DictationInsertionMode,
    copy_to_clipboard: bool,
) -> Result<u64, String> {
    // Match reset's tracker -> runtime -> options order. All state changes
    // happen after the last await, so cancellation cannot leave half a session.
    let mut tracker = session_tracker.lock().await;
    let mut runtime_state = runtime_state.lock().await;
    if *runtime_state != DictationSessionState::Idle {
        return Err("Dictation is already active".to_string());
    }
    let mut active_options = start_options.lock().await;
    *runtime_state = DictationSessionState::Starting;
    // From here until the session is idle again, background notes yield to it.
    crate::llm::speech_priority::set_dictation_active(true);
    tracker.next_session_id += 1;
    tracker.active_session_id = Some(tracker.next_session_id);
    // A new session never inherits the previous session's stop claim.
    tracker.stopping_session_id = None;
    tracker.cancellation_requested_session_id = None;
    tracker.delivery_started_session_id = None;
    tracker.started_at = Some(std::time::Instant::now());
    tracker.started_at_epoch_ms = Some(session_started_at_ms);
    tracker.startup_latency_ms = None;
    tracker.acknowledged_at_epoch_ms = None;
    tracker.capture_ready_at_epoch_ms = None;
    tracker.first_stable_partial_at_epoch_ms = None;
    tracker.stop_requested_at = None;
    tracker.final_transcript_at_epoch_ms = None;
    tracker.insertion_completed_at_epoch_ms = None;
    tracker.insertion_mode_at_start = Some(insertion_mode);
    tracker.copy_to_clipboard_at_start = Some(copy_to_clipboard);
    *active_options = options.clone();
    Ok(tracker.next_session_id)
}

pub(crate) fn dictation_start_matches(
    tracker: &DictationSessionTracker,
    runtime: DictationSessionState,
    session_id: u64,
    phase: DictationSessionState,
) -> bool {
    tracker.active_session_id == Some(session_id)
        && tracker.stopping_session_id != Some(session_id)
        && runtime == phase
}

async fn prime_dictation_start_if_current(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    session_id: u64,
) -> bool {
    let tracker = session_tracker.lock().await;
    if tracker.active_session_id != Some(session_id)
        || tracker.stopping_session_id == Some(session_id)
    {
        return false;
    }
    let mut runtime = runtime_state.lock().await;
    if *runtime != DictationSessionState::Starting {
        return false;
    }
    *runtime = DictationSessionState::Primed;
    true
}

pub(crate) struct UnfinishedDictationStart {
    rollback: Option<Box<dyn FnOnce() + Send>>,
    after_commit: Option<Box<dyn FnOnce() + Send>>,
}

impl UnfinishedDictationStart {
    pub(crate) fn disarm(&mut self) {
        self.rollback = None;
        if let Some(after_commit) = self.after_commit.take() {
            after_commit();
        }
    }
}

impl Drop for UnfinishedDictationStart {
    fn drop(&mut self) {
        if let Some(rollback) = self.rollback.take() {
            rollback();
        }
    }
}

pub(crate) async fn persist_finished_meeting_aside(state: &AppState, session_id: u64) {
    let snapshot = state.audio_capture.lock().await.meeting_aside_spans();
    if let Some((recording_id, spans)) = snapshot {
        if let Err(error) =
            state
                .db
                .lock()
                .await
                .finish_dictation_aside(&recording_id, session_id, &spans)
        {
            tracing::error!("Could not close aside journal: {error}");
        }
    }
}

async fn rollback_cancelled_dictation_start(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
    session_id: u64,
) {
    #[cfg(target_os = "macos")]
    release_session_selection_owner(&state, session_id).await;
    state
        .audio_capture
        .lock()
        .await
        .abort_dictation_for_session(session_id);
    persist_finished_meeting_aside(&state, session_id).await;
    if !reset_dictation_session_runtime_if_current(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
        session_id,
    )
    .await
    {
        return;
    }
    stop_dictation_live_preview_for_session(&state, session_id).await;
    state.dictation_model_release.notify();
    let owns_overlay = if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        if overlay.session_id == Some(session_id) {
            *overlay = DictationOverlayState::default();
            true
        } else {
            false
        }
    } else {
        false
    };
    if owns_overlay {
        handle.emit_event("dictation-state-changed", serde_json::json!({
            "phase": "idle", "sessionId": session_id, "outcome": "aborted", "stopReason": "start-cancelled", "captureReady": false,
        }));
        handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
    }
    reconcile_hands_free_monitor(&state, &handle).await;
}

#[cfg(target_os = "macos")]
pub(crate) async fn release_session_selection_owner(state: &AppState, session_id: u64) {
    let mut slot = state.dictation_selection_owner.lock().await;
    if slot.as_ref().is_some_and(|(id, _)| *id == session_id) {
        if let Some((_, owner)) = slot.take() {
            owner.guard.invalidate();
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) struct SessionSelectionOwner {
    pub(crate) guard: Arc<crate::text_insert::PreparedDictationSelectedContext>,
    consent: DictationFieldContextConsent,
    start_options: models::DictationStartOptions,
}

#[cfg(target_os = "macos")]
impl std::fmt::Debug for SessionSelectionOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionSelectionOwner")
    }
}

#[cfg(target_os = "macos")]
impl SessionSelectionOwner {
    fn permits(
        &self,
        settings: &settings::Settings,
        options: &models::DictationStartOptions,
    ) -> bool {
        self.guard.is_valid()
            && self
                .consent
                .permits(DictationFieldContextConsent::capture(settings, options))
    }
}

#[cfg(any(target_os = "macos", test))]
fn selection_consent_transition_revokes(
    previous: &settings::Settings,
    candidate: &settings::Settings,
    options: &models::DictationStartOptions,
) -> bool {
    !DictationFieldContextConsent::capture(previous, options)
        .permits(DictationFieldContextConsent::capture(candidate, options))
        || previous.transcription.dictation_command_mode_enabled
            != candidate.transcription.dictation_command_mode_enabled
        || previous.transcription.dictation_command_prefix
            != candidate.transcription.dictation_command_prefix
}

#[cfg(target_os = "macos")]
pub(crate) async fn invalidate_active_selection_owner(state: &AppState) {
    state
        .dictation_selection_policy_revision
        .fetch_add(1, Ordering::AcqRel);
    let slot = state.dictation_selection_owner.lock().await;
    if let Some((_, owner)) = slot.as_ref() {
        owner.guard.invalidate();
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn invalidate_selection_owner_for_settings_transition(
    state: &AppState,
    previous: &settings::Settings,
    candidate: &settings::Settings,
) {
    advance_selection_policy_revision(
        &state.dictation_selection_policy_revision,
        previous,
        candidate,
    );
    let slot = state.dictation_selection_owner.lock().await;
    if let Some((_, owner)) = slot.as_ref() {
        if selection_consent_transition_revokes(previous, candidate, &owner.start_options) {
            owner.guard.invalidate();
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn advance_selection_policy_revision(
    revision: &std::sync::atomic::AtomicU64,
    previous: &settings::Settings,
    candidate: &settings::Settings,
) {
    let mode_policy = |settings: &settings::Settings| {
        settings
            .transcription
            .dictation_custom_modes
            .iter()
            .map(|mode| {
                (
                    mode.id.clone(),
                    (
                        normalize_dictation_context_source(&mode.context_source).to_string(),
                        mode.voice_edit,
                    ),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    if selection_consent_transition_revokes(previous, candidate, &Default::default())
        || previous.transcription.dictation_nearby_spelling
            != candidate.transcription.dictation_nearby_spelling
        || mode_policy(previous) != mode_policy(candidate)
    {
        revision.fetch_add(1, Ordering::AcqRel);
    }
}

#[cfg(any(target_os = "macos", test))]
fn selection_start_policy_is_current(
    revision: &std::sync::atomic::AtomicU64,
    expected: u64,
) -> bool {
    revision.load(Ordering::Acquire) == expected
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, PartialEq, Eq)]
struct DictationFieldContextConsent {
    source: String,
    mode: String,
    custom_mode_id: Option<String>,
    selected_mode_source: Option<String>,
    bound_mode_source: Option<String>,
    voice_edit_modes: Vec<(String, bool)>,
    remote_enabled: bool,
}

#[cfg(any(target_os = "macos", test))]
impl DictationFieldContextConsent {
    fn capture(settings: &settings::Settings, options: &models::DictationStartOptions) -> Self {
        let transcription = &settings.transcription;
        let mode_source = |id: Option<&str>| {
            id.and_then(|id| {
                transcription
                    .dictation_custom_modes
                    .iter()
                    .find(|mode| mode.id == id)
                    .map(|mode| {
                        normalize_dictation_context_source(&mode.context_source).to_string()
                    })
            })
        };
        Self {
            source: transcription.dictation_context_source.clone(),
            mode: transcription.dictation_mode_preset.clone(),
            custom_mode_id: transcription.dictation_selected_custom_mode_id.clone(),
            selected_mode_source: mode_source(
                transcription.dictation_selected_custom_mode_id.as_deref(),
            ),
            bound_mode_source: mode_source(
                options
                    .mode_override
                    .as_ref()
                    .and_then(|mode| mode.custom_mode_id.as_deref()),
            ),
            voice_edit_modes: transcription
                .dictation_custom_modes
                .iter()
                .filter(|mode| {
                    Some(mode.id.as_str())
                        == transcription.dictation_selected_custom_mode_id.as_deref()
                        || Some(mode.id.as_str())
                            == options
                                .mode_override
                                .as_ref()
                                .and_then(|mode| mode.custom_mode_id.as_deref())
                })
                .map(|mode| (mode.id.clone(), mode.voice_edit))
                .collect(),
            remote_enabled: settings.privacy.remote_processing_enabled,
        }
    }

    fn permits(&self, mut current: Self) -> bool {
        if self.remote_enabled && !current.remote_enabled {
            return false;
        }
        current.remote_enabled = self.remote_enabled;
        *self == current
    }
}

#[cfg(any(target_os = "macos", test))]
async fn commit_owned_dictation_field_context(
    tracker: &Mutex<DictationSessionTracker>,
    runtime: &Mutex<DictationSessionState>,
    options: &Mutex<models::DictationStartOptions>,
    session_id: u64,
    expected: &models::DictationStartOptions,
    text: &str,
    valid: impl Fn() -> bool,
) -> bool {
    let tracker = tracker.lock().await;
    let runtime = runtime.lock().await;
    let mut options = options.lock().await;
    if tracker.active_session_id != Some(session_id)
        || tracker.stopping_session_id == Some(session_id)
        || tracker.cancellation_requested_session_id == Some(session_id)
        || tracker.delivery_started_session_id == Some(session_id)
        || *runtime != DictationSessionState::Recording
        || options.captured_context_text.is_some()
        || expected.captured_context_text.is_some()
        || !matches!(
            normalize_dictation_context_source(&expected.context_source),
            "selected_text" | "application_context"
        )
        || options.context_source != expected.context_source
        || options.context_app_name != expected.context_app_name
        || options.context_app_bundle_id != expected.context_app_bundle_id
        || options.focused_field_fingerprint != expected.focused_field_fingerprint
        || options.resolved_route != expected.resolved_route
        || options.resolved_mode_preset != expected.resolved_mode_preset
        || options.resolved_custom_mode_id != expected.resolved_custom_mode_id
        || options.activation_matcher != expected.activation_matcher
        || options.actual_provider != expected.actual_provider
        || options.actual_model_id != expected.actual_model_id
        || !valid()
    {
        return false;
    }
    let text: String = text.trim().chars().take(4000).collect();
    if text.is_empty() {
        return false;
    }
    options.captured_context_text = Some(text);
    true
}

#[cfg(target_os = "macos")]
fn schedule_owned_dictation_field_context(
    state: Arc<AppState>,
    session_id: u64,
    expected: models::DictationStartOptions,
    consent: DictationFieldContextConsent,
    guard: Arc<crate::text_insert::PreparedDictationSelectedContext>,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    tokio::spawn(async move {
        if std::time::Instant::now() >= deadline {
            return;
        }
        // Hold consent across the native read and context commit.
        // Stop never waits for this task.
        let manager = state.settings_manager.lock().await;
        if !consent.permits(DictationFieldContextConsent::capture(
            manager.settings(),
            &expected,
        )) {
            return;
        }
        let Ok((guard, Some(text))) = tokio::task::spawn_blocking(move || {
            let text = guard.read_selected_text();
            (guard, text)
        })
        .await
        else {
            return;
        };
        let _ = commit_owned_dictation_field_context(
            &state.dictation_session_tracker,
            &state.dictation_runtime_state,
            &state.dictation_start_options,
            session_id,
            &expected,
            &text,
            || std::time::Instant::now() < deadline && guard.is_valid(),
        )
        .await;
    });
}

/// Voice Edit sends free-form speech to the model. With the prefix, the whole
/// command grammar applies, as in ordinary command mode. Without it, only
/// commands that carry no text of their own run locally: "change the tone to
/// formal" reads as a literal swap, so payload commands need the prefix.
fn parse_voice_edit_command(raw: &str, prefix: &str) -> Option<(String, DictationCommandAction)> {
    parse_dictation_command(raw, prefix).or_else(|| {
        let spoken_prefix = if prefix.trim().is_empty() {
            "command"
        } else {
            prefix.trim()
        };
        parse_dictation_command(&format!("{spoken_prefix} {raw}"), prefix)
            .filter(|(_, action)| voice_edit_runs_without_prefix(action))
    })
}

/// Select carries a phrase but only moves the selection and never changes
/// text, and a phrase that is not found is refused rather than rewritten.
fn voice_edit_runs_without_prefix(action: &DictationCommandAction) -> bool {
    use DictationCommandAction as Action;
    match action {
        Action::UndoLastInsert
        | Action::DeleteThat
        | Action::DeleteLastSentence
        | Action::SelectPhrase(_)
        | Action::MoveToStart
        | Action::MoveToEnd
        | Action::DeleteSelection
        | Action::UppercaseSelection
        | Action::LowercaseSelection
        | Action::TitleCaseSelection
        | Action::SentenceCaseSelection => true,
        Action::InsertText(text) => text.chars().all(|ch| ch == '\n'),
        Action::ReplaceEntireSelection(_)
        | Action::ReplaceSelection { .. }
        | Action::AppendToSelection(_)
        | Action::PrependToSelection(_)
        | Action::DeletePhrase(_)
        | Action::RewriteShorter(_)
        | Action::RewriteProfessional(_)
        | Action::Bulletize(_) => false,
    }
}

/// A phrase selection that finds nothing is refused, never retried as a
/// rewrite: a misheard phrase must not become a model rewrite of the user's
/// selected text. In Voice Edit, say how to ask for a rewrite instead.
fn voice_edit_command_refusal(
    voice_edit_mode: bool,
    action: &DictationCommandAction,
    error: String,
) -> String {
    let phrase_command = matches!(action, DictationCommandAction::SelectPhrase(_));
    let found_nothing = ["not found", "could not find", "inside a longer word"]
        .iter()
        .any(|reason| error.contains(reason));
    if voice_edit_mode && phrase_command && found_nothing {
        format!(
            "{error} Voice Edit read this as a fixed command, so nothing was rewritten. To ask for a rewrite, start with another word, such as \"make\" or \"rewrite\"."
        )
    } else {
        error
    }
}

#[cfg(target_os = "macos")]
fn apply_screen_spelling(
    result: &mut crate::dictation_pipeline::DictationPipelineResult,
    vocabulary: &crate::dictation_screen_context::Vocabulary,
    code_editor: bool,
) {
    let (text, applied) = crate::dictation_screen_context::correct(
        &result.text,
        vocabulary,
        &result.applied_dictionary_replacements,
        code_editor,
    );
    if !applied.is_empty() {
        result.text = text;
        result.dictionary_applied_count += applied.len();
        result.applied_dictionary_replacements.extend(applied);
        result
            .pipeline_stage_keys
            .push("nearby_spelling".to_string());
    }
}

#[cfg(target_os = "macos")]
async fn commit_screen_vocabulary(
    tracker: &Mutex<DictationSessionTracker>,
    options: &Mutex<models::DictationStartOptions>,
    session_id: u64,
    expected: &models::DictationStartOptions,
    revision: u64,
    vocabulary: crate::dictation_screen_context::Vocabulary,
) -> bool {
    let tracker = tracker.lock().await;
    let mut options = options.lock().await;
    if tracker.active_session_id != Some(session_id)
        || tracker.stopping_session_id.is_some()
        || tracker.cancellation_requested_session_id.is_some()
        || options.focused_field_fingerprint != expected.focused_field_fingerprint
        || options.context_app_bundle_id != expected.context_app_bundle_id
    {
        return false;
    }
    options.screen_vocabulary = Some((revision, vocabulary));
    true
}

#[cfg(target_os = "macos")]
fn schedule_screen_vocabulary(
    state: Arc<AppState>,
    session_id: u64,
    options: &models::DictationStartOptions,
    revision: u64,
) {
    let Some(field) = options.focused_field_fingerprint.clone() else {
        return;
    };
    if crate::dictation_screen_context::denied_app(
        options.context_app_name.as_deref(),
        options.context_app_bundle_id.as_deref(),
    ) {
        return;
    }
    let expected = options.clone();
    // Queued work expires too. Stop never joins this task.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    tokio::spawn(async move {
        {
            let manager = state.settings_manager.lock().await;
            if !manager.settings().transcription.dictation_nearby_spelling
                || !selection_start_policy_is_current(
                    &state.dictation_selection_policy_revision,
                    revision,
                )
                || std::time::Instant::now() >= deadline
            {
                return;
            }
        }
        // No session/settings lock spans AX IPC or blocking-pool scheduling.
        let read_state = Arc::clone(&state);
        let Ok(vocabulary) = tokio::task::spawn_blocking(move || {
            let valid = || {
                std::time::Instant::now() < deadline
                    && selection_start_policy_is_current(
                        &read_state.dictation_selection_policy_revision,
                        revision,
                    )
            };
            if !valid() {
                return Default::default();
            }
            crate::text_insert::nearby_context::capture(&field, &valid)
        })
        .await
        else {
            return;
        };
        let manager = state.settings_manager.lock().await;
        if std::time::Instant::now() < deadline
            && manager.settings().transcription.dictation_nearby_spelling
            && selection_start_policy_is_current(
                &state.dictation_selection_policy_revision,
                revision,
            )
        {
            commit_screen_vocabulary(
                &state.dictation_session_tracker,
                &state.dictation_start_options,
                session_id,
                &expected,
                revision,
                vocabulary,
            )
            .await;
        }
    });
}

pub(crate) async fn start_dictation_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut options: models::DictationStartOptions,
) -> Result<(u64, UnfinishedDictationStart), String> {
    #[cfg(target_os = "macos")]
    let selection_policy_revision;
    let mut settings_snapshot = {
        let sm = state.settings_manager.lock().await;
        #[cfg(target_os = "macos")]
        {
            selection_policy_revision = state
                .dictation_selection_policy_revision
                .load(Ordering::Acquire);
        }
        sm.settings().clone()
    };
    #[cfg(target_os = "macos")]
    let field_context_consent = DictationFieldContextConsent::capture(&settings_snapshot, &options);
    // A per-mode binding runs this one session under its mode; the snapshot
    // is what every mode-dependent decision below reads, and the options are
    // stored as the session record so stop applies the same override.
    apply_dictation_session_mode_override(&mut settings_snapshot, &mut options);
    // Voice Edit sends most speech to the rewrite model, so it prewarms like
    // ordinary dictation; admission still decides whether a model may load.
    schedule_ollama_dictation_prewarm_for_session(
        &settings_snapshot,
        &options,
        Arc::clone(&state.ollama_client),
    );
    let requested_selection = resolve_transcription_provider_and_model(
        &settings_snapshot.transcription,
        TranscriptionScope::Dictation,
    );

    let requested_effective = state
        .asr_manager
        .resolved_local_route_for_cleanup(requested_selection.0, &requested_selection.1)
        .await;
    let requested_speech_selection = DictationSpeechSelection {
        requested: requested_selection.clone(),
        effective: requested_effective,
    };

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
    // The name the dictation view and history show; the ids stay in
    // `actual_provider`, `actual_model_id` and `resolved_route` above.
    options.provider_model_label = Some(dictation_provider.speech_model_name(&dictation_model_id));
    options.resolved_hosting =
        Some(hosting_environment_to_settings_value(resolved_hosting).to_string());
    capture_sidecar_dictation_start_context(state, &settings_snapshot, &mut options).await;
    #[cfg(target_os = "macos")]
    let selection_owner = {
        let mut selection_owner = None;
        let source = normalize_dictation_context_source(&options.context_source);
        if source == "selected_text" {
            // Ten-minute capture limit plus five minutes for preparation/ASR,
            // formatting and archival. Expiry refuses replacement, never recovery.
            let lifetime = std::time::Duration::from_secs(
                audio::AudioCapture::dictation_max_session_seconds() + 300,
            );
            selection_owner = options
                .focused_field_fingerprint
                .as_ref()
                .and_then(|field| {
                    crate::text_insert::prepare_session_selection_watch(
                        field,
                        options.context_app_name.as_deref(),
                        options.context_app_bundle_id.as_deref(),
                        lifetime,
                    )
                })
                .map(|guard| {
                    guard.use_explicit_snapshot();
                    Arc::new(SessionSelectionOwner {
                        guard: Arc::new(guard),
                        consent: field_context_consent.clone(),
                        start_options: options.clone(),
                    })
                });
            options.captured_context_text = None;
        }
        selection_owner
    };

    // A recording meeting holds the microphone. With asides on, the
    // dictation takes the meeting's own frames; otherwise this refuses
    // exactly as before. Decided again under the lock that starts capture,
    // since the meeting can start or stop while the model loads.
    let (meeting_aside, dictation_during_meeting) = {
        let audio = state.audio_capture.lock().await;
        let microphone = audio.meeting_microphone();
        let route = crate::meeting_asides::dictation_audio_route(
            microphone,
            crate::meeting_asides::MEETING_ASIDES_ENABLED,
            options.hands_free_trigger,
        );
        if let crate::meeting_asides::DictationAudioRoute::Refuse(message) = route {
            return Err(message.to_string());
        }
        if !audio.has_microphone_input() {
            return Err(
                "No microphone available. Please connect a microphone and grant permission."
                    .to_string(),
            );
        }
        (
            route == crate::meeting_asides::DictationAudioRoute::MeetingAside,
            microphone != crate::meeting_asides::MeetingMicrophone::Idle,
        )
    };
    let session_started_at_ms = chrono::Utc::now().timestamp_millis();
    let session_id = claim_dictation_start_session(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
        &options,
        session_started_at_ms,
        DictationInsertionMode::from_settings_value(
            &settings_snapshot.transcription.dictation_insertion_mode,
        ),
        settings_snapshot.transcription.dictation_copy_to_clipboard,
    )
    .await?;
    let cleanup_state = Arc::clone(state);
    let cleanup_handle = handle.clone();
    let start_guard = UnfinishedDictationStart {
        after_commit: None,
        rollback: Some(Box::new(move || {
            track_capture_start_rollback(tokio::spawn(rollback_cancelled_dictation_start(
                cleanup_state,
                cleanup_handle,
                session_id,
            )));
        })),
    };

    #[cfg(target_os = "macos")]
    if settings_snapshot.transcription.dictation_nearby_spelling {
        schedule_screen_vocabulary(
            Arc::clone(state),
            session_id,
            &options,
            selection_policy_revision,
        );
    }

    #[cfg(target_os = "macos")]
    let deferred_field_context = if options.captured_context_text.is_none()
        && matches!(
            normalize_dictation_context_source(&options.context_source),
            "selected_text" | "application_context"
        ) {
        selection_owner
            .as_ref()
            .map(|owner| Arc::clone(&owner.guard))
    } else {
        None
    };

    #[cfg(target_os = "macos")]
    if let Some(owner) = selection_owner.as_ref() {
        let manager = state.settings_manager.lock().await;
        if !selection_start_policy_is_current(
            &state.dictation_selection_policy_revision,
            selection_policy_revision,
        ) || !owner.permits(manager.settings(), &options)
        {
            owner.guard.invalidate();
        }
        *state.dictation_selection_owner.lock().await = Some((session_id, Arc::clone(owner)));
        drop(manager);
        let owner = Arc::downgrade(owner);
        let state = Arc::clone(state);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let Some(owner) = owner.upgrade() else {
                    break;
                };
                let tracker = state.dictation_session_tracker.lock().await;
                if tracker.active_session_id != Some(session_id)
                    || tracker.cancellation_requested_session_id == Some(session_id)
                {
                    owner.guard.invalidate();
                    let mut slot = state.dictation_selection_owner.lock().await;
                    if slot.as_ref().is_some_and(|(id, _)| *id == session_id) {
                        *slot = None;
                    }
                    break;
                }
                drop(tracker);
                let manager = state.settings_manager.lock().await;
                if !owner.permits(
                    manager.settings(),
                    &*state.dictation_start_options.lock().await,
                ) {
                    owner.guard.invalidate();
                    let mut slot = state.dictation_selection_owner.lock().await;
                    if slot.as_ref().is_some_and(|(id, _)| *id == session_id) {
                        *slot = None;
                    }
                    break;
                }
            }
        });
    }

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "preparing".to_string();
        overlay.dismissed = false;
        overlay.session_id = Some(session_id);
        overlay.started_at_ms = Some(session_started_at_ms);
        overlay.message = Some("Loading the selected dictation model".to_string());
        overlay.clear_warnings();
        overlay.dictation_provider =
            Some(asr_provider_to_settings_value(dictation_provider).to_string());
        overlay.dictation_model_id = Some(dictation_model_id.clone());
        overlay.model_readiness = Some("loading".to_string());
        overlay.capture_ready = false;
        overlay.meeting_aside = dictation_during_meeting;
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
            "meetingAside": dictation_during_meeting,
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

    // Readiness routing may choose a local fallback that differs from saved
    // settings. Keep its exact cache key available to terminal cleanup.
    let actual_speech_route = state
        .asr_manager
        .resolved_local_route_for_cleanup(dictation_provider, &dictation_model_id)
        .await;
    state
        .dictation_model_release
        .remember_actual(requested_speech_selection, actual_speech_route);
    let keep_warm_for_preparation = state
        .settings_manager
        .lock()
        .await
        .settings()
        .transcription
        .dictation_keep_warm
        .clone();

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
                    "Apple Speech is selected for dictation, but speech recognition permission is not ready. {}",
                    error
                )
            })?;
        }

        // Open the microphone first. Speech said while the model loads is
        // captured and decoded at stop, after the warmup finishes.
        Ok(begin_session_dictation_model_warmup(
            &state.dictation_model_release,
            dictation_provider,
            &dictation_model_id,
            &keep_warm_for_preparation,
        ))
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
                state.dictation_model_release.notify();
                if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                    if overlay.session_id == Some(session_id) {
                        overlay.phase = "error".to_string();
                        overlay.message = Some(error.clone());
                        overlay.clear_warnings();
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

    // Check ownership and publish Primed together; a stale warmup must not
    // prime a replacement session that is still loading its own model.
    if !prime_dictation_start_if_current(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        session_id,
    )
    .await
    {
        return Err("Dictation start was cancelled".to_string());
    }

    let primed_message = match model_warm_state {
        DictationModelWarmState::Ready => "Local model ready. Opening the microphone.",
        DictationModelWarmState::Loading => "Opening the microphone.",
        DictationModelWarmState::Deferred => {
            "Opening the microphone. The local model will load after capture."
        }
        DictationModelWarmState::NotRequired => "Opening the microphone.",
    };

    {
        let tracker = state.dictation_session_tracker.lock().await;
        let runtime = state.dictation_runtime_state.lock().await;
        if !dictation_start_matches(
            &tracker,
            *runtime,
            session_id,
            DictationSessionState::Primed,
        ) {
            return Err("Dictation start was cancelled".to_string());
        }
        // Update overlay state so get_dictation_overlay_state returns the correct snapshot.
        if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
            if overlay.session_id == Some(session_id) {
                overlay.phase = "primed".to_string();
                overlay.dismissed = false;
                overlay.session_id = Some(session_id);
                overlay.started_at_ms = Some(session_started_at_ms);
                overlay.message = Some(primed_message.to_string());
                overlay.clear_warnings();
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
                    live_dictation_insertion_mode(
                        &settings_snapshot.transcription.dictation_insertion_mode,
                        options.delivery_mode,
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
                overlay.meeting_aside = dictation_during_meeting;
            }
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
            "insertionMode": live_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode, options.delivery_mode),
            "appTarget": options.context_app_name,
            "activationMatcher": options.activation_matcher,
            "requestedRoute": options.route_preference,
            "resolvedRoute": options.resolved_route,
            "providerModelLabel": options.provider_model_label,
            "dictationRoutePreference": options.route_preference,
            "dictationResolvedHosting": options.resolved_hosting,
            "modelReadiness": model_warm_state.as_event_value(),
            "captureReady": false,
            "meetingAside": dictation_during_meeting,
        }),
    );

        // Tell Electron to show the dictation overlay window.
        handle.window_command("show-dictation-overlay", &serde_json::Value::Null);
    }

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
            .dictation_live_preview_enabled
            && dictation_route_supports_live_preview(dictation_provider, &dictation_model_id),
        engine_setting: live_preview_engine_setting_for_route(
            &settings_snapshot
                .transcription
                .dictation_live_preview_engine,
            dictation_provider,
            &dictation_model_id,
        ),
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
    // The first-sample flag and the start-sound delay for the input that
    // opened, read under the audio lock alongside the partial handles.
    let mut first_sample_flag: Option<Arc<std::sync::atomic::AtomicU64>> = None;
    let mut start_sound_delay_ms = 0u64;

    // What to tell the user when capture is refused for a meeting reason
    // rather than failing to open the device.
    let mut capture_refusal: Option<&'static str> = None;
    let capture_result = {
        let tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id != Some(session_id)
            || tracker.stopping_session_id == Some(session_id)
        {
            return Err("Dictation start was cancelled".to_string());
        }
        let runtime = state.dictation_runtime_state.lock().await;
        if *runtime != DictationSessionState::Primed {
            return Err("Dictation start was cancelled".to_string());
        }
        let mut audio = state.audio_capture.lock().await;
        audio.set_streaming_partials_enabled(streaming_partials_enabled);
        audio.set_next_dictation_max_session_seconds(
            if dictation_provider == asr::AsrProviderType::Whistle {
                30
            } else {
                audio::AudioCapture::dictation_max_session_seconds()
            },
        );
        let route = crate::meeting_asides::dictation_audio_route(
            audio.meeting_microphone(),
            crate::meeting_asides::MEETING_ASIDES_ENABLED,
            options.hands_free_trigger,
        );
        let started = match route {
            crate::meeting_asides::DictationAudioRoute::Refuse(message) => {
                capture_refusal = Some(message);
                Err(anyhow::anyhow!(message))
            }
            crate::meeting_asides::DictationAudioRoute::MeetingAside if meeting_aside => {
                let db = state.db.lock().await;
                audio.start_dictation_aside(
                    session_id,
                    auto_stop_config,
                    Some(handle.clone()),
                    preferred_input_device.as_ref(),
                    |recording_id, ticket, rate| {
                        db.insert_pending_aside(recording_id, ticket, session_id, rate)
                            .map_err(|e| e.to_string())
                    },
                )
            }
            crate::meeting_asides::DictationAudioRoute::Standalone if !meeting_aside => audio
                .start_dictation(
                    preferred_input_device.as_ref(),
                    session_id,
                    auto_stop_config,
                    Some(handle.clone()),
                    // Only a start the hands-free monitor itself asked for may
                    // take over the monitor's stream and pre-roll.
                    // `dispatch_command` stops the monitor immediately before
                    // every other start, so this flag is what keeps a hotkey
                    // press from picking up the ring.
                    options.hands_free_trigger,
                ),
            // The meeting started or stopped while the model loaded. The HUD
            // already said which kind of dictation this is, so do not switch.
            _ => {
                capture_refusal = Some(crate::meeting_asides::MEETING_CHANGED_DURING_START);
                Err(anyhow::anyhow!(
                    crate::meeting_asides::MEETING_CHANGED_DURING_START
                ))
            }
        };
        match started {
            Ok(resolved_input) => {
                if let Some(advisory) = resolved_input.advisory.as_deref() {
                    handle.emit_event("audio-input-advisory", advisory.to_string());
                }
                first_sample_flag = Some(audio.dictation_first_sample_handle());
                start_sound_delay_ms = audio::dictation_start_sound_delay_ms(
                    resolved_input.transport_type.as_deref(),
                    &resolved_input.device_name,
                );
                if streaming_partials_enabled {
                    partial_task_handles = Some((
                        audio.dictation_partial_buffer_handle(),
                        audio.is_dictating_handle(),
                        audio.dictation_sample_rate(),
                    ));
                }
                Ok(())
            }
            Err(error) => Err(error),
        }
    };
    if let Err(error) = capture_result {
        let cleaned = reset_dictation_session_runtime_if_current(
            &state.dictation_runtime_state,
            &state.dictation_session_tracker,
            &state.dictation_start_options,
            session_id,
        )
        .await;
        if cleaned {
            state.dictation_model_release.notify();
            if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                if overlay.session_id == Some(session_id) {
                    *overlay = DictationOverlayState::default();
                }
            }
            handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
        }
        tracing::warn!(
            "dictation {} audio capture failed to start: {}",
            session_id,
            error
        );
        return Err(capture_refusal
            .unwrap_or("Couldn't open the microphone. Check that it's connected, then try again.")
            .to_string());
    }

    // Starting capture is synchronous but force-stop runs on another request
    // task. Publish Recording only while this start still owns the session.
    // If cancellation won immediately after capture opened, close the stream
    // we just created instead of resurrecting an untracked microphone.
    let owns_session = {
        let tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id)
            && tracker.stopping_session_id != Some(session_id)
        {
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
        persist_finished_meeting_aside(state, session_id).await;
        return Err("Dictation start was cancelled".to_string());
    }

    // Spawn the UI-only live-preview task. Both engines emit live-preview text
    // and NEITHER feeds the final transcript: the only thing they write is a
    // `partialText` field on `dictation-state-changed`. Best-effort; they
    // swallow their own errors and stop when dictation does.
    if let Some((partial_buffer, is_dictating, sample_rate)) = partial_task_handles.clone() {
        if live_preview_engine == DictationLivePreviewEngine::Streaming {
            install_dictation_live_preview_for_session(
                &state.dictation_live_preview,
                &state.dictation_session_tracker,
                session_id,
                || {
                    spawn_streaming_live_preview(
                        Arc::clone(&state.dictation_session_tracker),
                        handle.clone(),
                        session_id,
                        partial_buffer,
                        is_dictating,
                        sample_rate,
                        live_preview_language.clone(),
                    )
                },
            )
            .await;
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
        install_dictation_live_preview_for_session(
            &state.dictation_live_preview,
            &state.dictation_session_tracker,
            session_id,
            || {
                let stop = Arc::new(AtomicBool::new(false));
                let task_stop = Arc::clone(&stop);
                let task = tokio::spawn(async move {
                    let mut last_decoded_total_samples: u64 = 0;
                    let mut last_decode_finished_at = std::time::Instant::now();
                    let mut last_emitted_text = String::new();
                    while !task_stop.load(std::sync::atomic::Ordering::SeqCst)
                        && is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                    {
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

                        if task_stop.load(std::sync::atomic::Ordering::SeqCst)
                            || !is_dictating.load(std::sync::atomic::Ordering::SeqCst)
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
                                let text = strip_non_speech_placeholder(&transcription.text);
                                // Re-check the live session id right before emit: the
                                // decode may have outlived the session it was started for.
                                let still_current = !task_stop
                                    .load(std::sync::atomic::Ordering::SeqCst)
                                    && is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                                    && session_tracker.lock().await.active_session_id
                                        == Some(session_id);
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
                DictationLivePreviewControl {
                    session_id,
                    stop,
                    task: DictationLivePreviewTask::Redecode(task),
                }
            },
        )
        .await;
    }

    {
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
    }
    // "Listening", and the start sound Electron plays for it, mean audio is
    // arriving. Published here when the first sample is already in, otherwise
    // by a watcher the moment it lands; until then the HUD keeps saying the
    // microphone is opening. Capture itself is live either way.
    let listening_event = serde_json::json!({
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
        "insertionMode": live_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode, options.delivery_mode),
        "appTarget": options.context_app_name,
        "activationMatcher": options.activation_matcher,
        "requestedRoute": options.route_preference,
        "resolvedRoute": options.resolved_route,
        "providerModelLabel": options.provider_model_label,
        "dictationRoutePreference": options.route_preference,
        "dictationResolvedHosting": options.resolved_hosting,
        "modelReadiness": model_warm_state.as_event_value(),
        "captureReady": true,
        "startSoundDelayMs": start_sound_delay_ms,
        "meetingAside": dictation_during_meeting,
    });
    let first_sample_arrived = |flag: &Option<Arc<std::sync::atomic::AtomicU64>>| {
        flag.as_ref()
            .is_none_or(|flag| flag.load(std::sync::atomic::Ordering::SeqCst) != 0)
    };
    if first_sample_arrived(&first_sample_flag) {
        publish_dictation_listening(state, handle, session_id, listening_event).await;
    } else if let Some(flag) = first_sample_flag {
        let watcher_state = Arc::clone(state);
        let watcher_handle = handle.clone();
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + DICTATION_FIRST_SAMPLE_WATCH;
            while flag.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                if std::time::Instant::now() >= deadline {
                    tracing::warn!(
                        session_id,
                        "No microphone audio arrived; the dictation HUD keeps saying the microphone is opening"
                    );
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            publish_dictation_listening(
                &watcher_state,
                &watcher_handle,
                session_id,
                listening_event,
            )
            .await;
        });
    }

    #[cfg(target_os = "macos")]
    let mut start_guard = start_guard;
    #[cfg(target_os = "macos")]
    if let Some(guard) = deferred_field_context {
        let context_state = Arc::clone(state);
        let context_options = options.clone();
        start_guard.after_commit = Some(Box::new(move || {
            schedule_owned_dictation_field_context(
                context_state,
                session_id,
                context_options,
                field_context_consent,
                guard,
            );
        }));
    }

    // Dispatch retains rollback across its hands-free reconciliation await.
    Ok((session_id, start_guard))
}

/// How long the start path waits for a silent input's first sample before it
/// stops watching. Capture keeps running; only the "Listening" notice waits.
const DICTATION_FIRST_SAMPLE_WATCH: Duration = Duration::from_secs(10);

/// Publish "Listening" for `session_id` once its first sample is in, unless
/// the session has since stopped, been cancelled or been replaced.
async fn publish_dictation_listening(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    session_id: u64,
    event: serde_json::Value,
) -> bool {
    let mut tracker = state.dictation_session_tracker.lock().await;
    let runtime = state.dictation_runtime_state.lock().await;
    if !dictation_start_matches(
        &tracker,
        *runtime,
        session_id,
        DictationSessionState::Recording,
    ) {
        return false;
    }
    if tracker.startup_latency_ms.is_none() {
        tracker.startup_latency_ms = tracker
            .started_at
            .map(|started_at| started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        tracker.capture_ready_at_epoch_ms = Some(chrono::Utc::now().timestamp_millis());
    }
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        if overlay.session_id == Some(session_id) {
            overlay.phase = "recording".to_string();
            overlay.message = Some("Listening".to_string());
            overlay.clear_warnings();
            overlay.capture_ready = true;
        }
    }
    handle.emit_event("dictation-state-changed", event);
    true
}

fn dictation_processing_owned_by(tracker: &DictationSessionTracker, session_id: u64) -> bool {
    tracker.active_session_id == Some(session_id)
        && tracker.cancellation_requested_session_id != Some(session_id)
        && tracker.delivery_started_session_id != Some(session_id)
}

fn claim_dictation_delivery(tracker: &mut DictationSessionTracker, session_id: u64) -> bool {
    if !dictation_processing_owned_by(tracker, session_id) {
        return false;
    }
    tracker.delivery_started_session_id = Some(session_id);
    true
}

fn dictation_delivery_may_publish(tracker: &DictationSessionTracker, session_id: u64) -> bool {
    tracker.active_session_id == Some(session_id)
        && tracker.delivery_started_session_id == Some(session_id)
        && tracker.cancellation_requested_session_id != Some(session_id)
}

async fn run_owned_dictation_stage<F, T>(state: &AppState, session_id: u64, work: F) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    run_owned_dictation_stage_with_tracker(&state.dictation_session_tracker, session_id, work).await
}

async fn run_owned_dictation_stage_with_tracker<F, T>(
    tracker: &Mutex<DictationSessionTracker>,
    session_id: u64,
    work: F,
) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    crate::dictation_stage_ownership::run_while_session_owned(work, || async {
        let tracker = tracker.lock().await;
        dictation_processing_owned_by(&tracker, session_id)
    })
    .await
}

pub(crate) fn claim_dictation_cancellation(
    tracker: &mut DictationSessionTracker,
    expected_session_id: Option<u64>,
) -> Result<u64, String> {
    let active = tracker
        .active_session_id
        .ok_or_else(|| "No active dictation session to force-stop".to_string())?;
    if let Some(expected) = expected_session_id {
        if expected != active {
            return Err(format!(
                "Stale force-stop for dictation session {} ignored (active session is {})",
                expected, active
            ));
        }
    }
    if tracker.delivery_started_session_id == Some(active) {
        return Err("Dictation insertion has already started and cannot be cancelled".to_string());
    }
    tracker.cancellation_requested_session_id = Some(active);
    tracker.stopping_session_id = Some(active);
    Ok(active)
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
        crate::llm::speech_priority::set_dictation_active(false);
    }
    {
        let mut tracker = session_tracker.lock().await;
        tracker.active_session_id = None;
        tracker.stopping_session_id = None;
        tracker.cancellation_requested_session_id = None;
        tracker.delivery_started_session_id = None;
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
    reset_dictation_session_runtime_if_owned(
        runtime_state,
        session_tracker,
        start_options,
        expected_session_id,
        false,
    )
    .await
}

async fn reset_dictation_session_runtime_if_processing(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
    expected_session_id: u64,
) -> bool {
    reset_dictation_session_runtime_if_owned(
        runtime_state,
        session_tracker,
        start_options,
        expected_session_id,
        true,
    )
    .await
}

async fn reset_dictation_session_runtime_if_owned(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
    expected_session_id: u64,
    require_processing: bool,
) -> bool {
    let mut tracker = session_tracker.lock().await;
    if tracker.active_session_id != Some(expected_session_id)
        || (require_processing && !dictation_processing_owned_by(&tracker, expected_session_id))
    {
        return false;
    }
    let mut runtime_state = runtime_state.lock().await;
    let mut start_options = start_options.lock().await;
    *runtime_state = DictationSessionState::Idle;
    crate::llm::speech_priority::set_dictation_active(false);
    tracker.active_session_id = None;
    tracker.stopping_session_id = None;
    tracker.cancellation_requested_session_id = None;
    tracker.delivery_started_session_id = None;
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
    #[cfg(target_os = "macos")]
    release_session_selection_owner(state, context.session_id).await;
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
    state.dictation_model_release.notify();
    finish_dictation_stop_failure(state, handle, context, fallback_reason, message).await
}

fn keep_failed_dictation_audio(
    checkpoint: &mut Option<crate::dictation_checkpoint::DictationCheckpoint>,
    handle: &crate::sidecar_handle::SidecarHandle,
    preview_pending: bool,
    error: &str,
) -> String {
    if !preview_pending && !crate::llm::local_model_load::is_headroom_refusal(error) {
        return String::new();
    }
    match checkpoint
        .take()
        .map(|checkpoint| checkpoint.keep_after_failure(preview_pending, error))
    {
        Some(Ok(true)) => {
            handle.emit_event("dictation-recovery-available", serde_json::json!({}));
            " Your audio was kept for 24 hours. Use Recover last dictation in Plainsong to retry."
                .to_string()
        }
        Some(Ok(false)) => String::new(),
        Some(Err(error)) => format!(" {error}"),
        None => " Captured audio could not be saved for retry.".to_string(),
    }
}

struct DictationRecoveryInput<'a> {
    options: &'a models::DictationStartOptions,
    settings: &'a Settings,
    audio_bytes: &'a [u8],
    duration_seconds: i64,
}

async fn fail_dictation_stop_with_recovery(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    context: &DictationStopFailureContext,
    recovery: DictationRecoveryInput<'_>,
    fallback_reason: String,
    message: String,
) -> String {
    #[cfg(target_os = "macos")]
    release_session_selection_owner(state, context.session_id).await;
    let cleaned_current_session = reset_dictation_session_runtime_if_processing(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
        context.session_id,
    )
    .await;
    if !cleaned_current_session {
        return message;
    }
    // Do not keep a failed route's model resident while file validation,
    // database commit, or vault finalization runs.
    state.dictation_model_release.notify();

    let message = if should_persist_failed_dictation_recovery(
        recovery.options.save_to_inbox,
        &recovery.settings.transcription.dictation_retention_preset,
        recovery.settings.transcription.dictation_keep_audio,
    ) {
        persist_failed_dictation_recovery(
            state,
            handle,
            recovery.options,
            recovery.audio_bytes,
            recovery.duration_seconds,
            &fallback_reason,
            message,
        )
        .await
    } else {
        message
    };

    finish_dictation_stop_failure(state, handle, context, Some(fallback_reason), message).await
}

async fn persist_failed_dictation_recovery(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    dictation_options: &models::DictationStartOptions,
    audio_bytes: &[u8],
    duration_seconds: i64,
    failure_reason: &str,
    message: String,
) -> String {
    let recording_id = uuid::Uuid::new_v4().to_string();
    let mut kept_audio_path = match write_kept_dictation_audio(&recording_id, audio_bytes) {
        Ok(path) => Some(path),
        Err(error) => {
            return format!("{message} Captured audio could not be saved for retry: {error}");
        }
    };
    let kept_audio = match kept_audio_path
        .as_deref()
        .map(recording_audio::validate_plaintext_wav)
    {
        Some(recording_audio::RecordingAudioValidation::Ready(metadata)) => metadata,
        Some(recording_audio::RecordingAudioValidation::Missing(reason))
        | Some(recording_audio::RecordingAudioValidation::Failed(reason)) => {
            if let Err(error) = discard_unvalidated_kept_audio(&mut kept_audio_path) {
                tracing::warn!("Failed to remove invalid failed-dictation audio: {error}");
            }
            return format!("{message} Captured audio could not be saved for retry: {reason}");
        }
        None => return message,
    };
    let now = chrono::Utc::now();
    let audio_path = kept_audio_path
        .as_deref()
        .expect("validated failed-dictation audio has a path")
        .to_string_lossy()
        .to_string();
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
        duration: duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "dictation".to_string(),
        audio_path,
        status: "error".to_string(),
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
        transcript_complete: false,
        transcript_degraded_reason: Some(failure_reason.to_string()),
        transcript_incomplete_acknowledged_at: None,
        capture_degraded_summary: None,
    };
    let save_result = {
        let mut db = state.db.lock().await;
        db.create_failed_dictation_recovery_entry(&recording, &kept_audio)
    };
    if let Err(error) = save_result {
        if let Err(remove_error) = discard_unvalidated_kept_audio(&mut kept_audio_path) {
            tracing::warn!("Failed to remove orphaned failed-dictation audio: {remove_error}");
        }
        return format!("{message} Captured audio could not be saved for retry: {error}");
    }

    let vault_warning =
        match encrypt_finalized_recording_audio(state, Some(handle), &recording_id).await {
            Ok(()) => String::new(),
            Err(error) => {
                tracing::warn!("Recovered dictation audio was not encrypted: {error}");
                format!(" The saved audio is not in the vault yet: {error}")
            }
        };
    handle.emit_event(
        "dictation-history-changed",
        serde_json::json!({
            "recordingId": &recording_id,
            "recovery": true,
        }),
    );
    format!(
        "{message} Captured audio was saved in History so you can process it again.{vault_warning}"
    )
}

async fn finish_dictation_stop_failure(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    context: &DictationStopFailureContext,
    fallback_reason: Option<String>,
    message: String,
) -> String {
    // Every terminal stop failure comes through here, so this is where a
    // preview that outlived its session is guaranteed to be closed.
    stop_dictation_live_preview_for_session(state, context.session_id).await;

    // Recovery may await a database commit and vault finalization after the
    // failed session released the runtime. If a new session claimed the HUD
    // meanwhile, the old terminal event must not replace its live state in a
    // renderer that does not filter events by session id. `None` keeps the
    // historical behavior for callers whose overlay has already been reset.
    let Ok(mut overlay) = state.dictation_overlay_state.lock() else {
        return message;
    };
    if !dictation_failure_event_belongs_to_overlay(overlay.session_id, context.session_id) {
        return message;
    }

    if overlay.session_id == Some(context.session_id) {
        overlay.phase = "error".to_string();
        overlay.message = Some(message.clone());
        overlay.clear_warnings();
        overlay.requested_provider = Some(context.requested_provider.to_string());
        overlay.actual_provider = Some(context.actual_provider.to_string());
        overlay.requested_model_id = context.requested_model_id.clone();
        overlay.actual_model_id = context.actual_model_id.clone();
        overlay.fallback_reason = fallback_reason.clone();
        overlay.target_app = context.app_target.clone();
    }
    // Emit while the overlay lock still owns this session. A new session can
    // claim the overlay only after this old terminal event has been delivered.
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
    drop(overlay);

    schedule_dictation_overlay_idle_reset(
        state,
        handle,
        context.session_id,
        "error",
        DICTATION_IDLE_RESET_ERROR_MS,
    );

    message
}

fn dictation_failure_event_belongs_to_overlay(
    overlay_session_id: Option<u64>,
    failed_session_id: u64,
) -> bool {
    overlay_session_id.is_none() || overlay_session_id == Some(failed_session_id)
}

/// Remember a completed result for the re-paste/re-copy recovery hotkeys and
/// the menu-bar menu. Empty results are not worth offering to re-paste.
pub(crate) fn record_recent_dictation_result(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    text: &str,
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
    owner_session_id: Option<u64>,
    recovery_state: DictationRecoveryState,
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
            state: recovery_state,
            owner_session_id,
            history_id: None,
            text: text.to_string(),
            app_target: app_target.map(str::to_string),
            app_bundle_id: app_bundle_id.map(str::to_string),
            at_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
    handle.emit_event(
        "dictation-recovery-results-changed",
        serde_json::json!({ "results": &*results }),
    );
}

pub(crate) fn retire_resolved_command_recovery(
    results: &mut Vec<RecentDictationResult>,
    session_id: u64,
    final_text: &str,
    command_applied: Option<&str>,
) -> bool {
    if !is_intentional_dictation_command_output(final_text, command_applied) {
        return false;
    }
    let previous_len = results.len();
    results.retain(|result| result.owner_session_id != Some(session_id));
    results.len() != previous_len
}

/// Newest first, capped at [`RECENT_DICTATION_RESULT_LIMIT`]. Split out from
/// the state-holding caller so the ordering and the cap are testable without
/// standing up an `AppState`.
/// The newest words kept for `session_id`, raw or finished. A cancelled
/// session offers nothing.
pub(crate) fn recent_dictation_text_for_session(
    results: &[RecentDictationResult],
    session_id: u64,
) -> Option<String> {
    results
        .iter()
        .find(|row| {
            row.owner_session_id == Some(session_id)
                && row.state != DictationRecoveryState::Cancelled
        })
        .map(|row| row.text.clone())
}

pub(crate) fn push_recent_dictation_result(
    results: &mut Vec<RecentDictationResult>,
    candidate: RecentDictationResult,
) {
    if candidate.text.trim().is_empty() {
        return;
    }
    if let Some(session_id) = candidate.owner_session_id {
        if results.iter().any(|row| {
            row.owner_session_id == Some(session_id)
                && row.state == DictationRecoveryState::Cancelled
        }) {
            return;
        }
        results.retain(|row| row.owner_session_id != Some(session_id));
    }
    results.insert(0, candidate);
    results.truncate(RECENT_DICTATION_RESULT_LIMIT);
}

/// Tie the session's recovery result to the history entry that holds the same
/// words. Returns whether a result was found.
pub(crate) fn link_recent_dictation_result_to_history(
    results: &mut [RecentDictationResult],
    session_id: u64,
    history_id: &str,
) -> bool {
    let mut linked = false;
    for result in results
        .iter_mut()
        .filter(|result| result.owner_session_id == Some(session_id))
    {
        result.history_id = Some(history_id.to_string());
        linked = true;
    }
    linked
}

/// Drop the recovery results whose history entries were just deleted.
/// Returns whether anything was removed.
pub(crate) fn forget_recent_dictation_results(
    results: &mut Vec<RecentDictationResult>,
    deleted_history_ids: &[String],
) -> bool {
    let before = results.len();
    results.retain(|result| {
        result
            .history_id
            .as_ref()
            .is_none_or(|id| !deleted_history_ids.contains(id))
    });
    results.len() != before
}

/// [`forget_recent_dictation_results`] against the live list, telling the
/// menu bar when it changed.
pub(crate) fn forget_deleted_dictation_results(
    state: &AppState,
    emitter: Option<&impl crate::sidecar_handle::AppEmitter>,
    deleted_history_ids: &[String],
) {
    if deleted_history_ids.is_empty() {
        return;
    }
    let Ok(mut results) = state.recent_dictation_results.lock() else {
        return;
    };
    if forget_recent_dictation_results(&mut results, deleted_history_ids) {
        if let Some(emitter) = emitter {
            emitter.emit_event(
                "dictation-recovery-results-changed",
                serde_json::json!({ "results": &*results }),
            );
        }
    }
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

pub(crate) fn cancel_recent_dictation_result(
    results: &mut [RecentDictationResult],
    session_id: u64,
) {
    for row in results
        .iter_mut()
        .filter(|row| row.owner_session_id == Some(session_id))
    {
        row.state = DictationRecoveryState::Cancelled;
    }
}

fn select_recent_dictation_result(
    results: &[RecentDictationResult],
    params: &serde_json::Value,
) -> Result<RecentDictationResult, String> {
    let result = if params
        .get("completedOnly")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        results
            .iter()
            .find(|row| row.state == DictationRecoveryState::Completed)
    } else {
        let index = params
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize;
        results.get(index)
    };
    let result = result
        .cloned()
        .ok_or_else(|| "No recent dictation result is available to reuse.".to_string())?;
    if let Some(expected) = params.get("expectedText") {
        let expected = expected
            .as_str()
            .ok_or_else(|| "Expected recovery text must be a string.".to_string())?;
        if expected != result.text {
            return Err(
                "The recovery menu changed. Reopen it and choose the text again.".to_string(),
            );
        }
    }

    Ok(result)
}

/// Hotkeys select completed results; tray entries use an index and expected text.
pub(crate) fn reuse_recent_dictation_result(
    state: &AppState,
    params: &serde_json::Value,
    paste: bool,
) -> Result<serde_json::Value, String> {
    let result = {
        let results = state
            .recent_dictation_results
            .lock()
            .map_err(|_| "Dictation recovery is unavailable.".to_string())?;
        select_recent_dictation_result(&results, params)?
    };

    if !paste {
        copy_to_clipboard(&result.text)?;
        return Ok(serde_json::json!({ "pasted": false, "copied": true }));
    }

    let (target_app, target_app_bundle_id) = resolve_recent_dictation_repaste_target();
    let outcome = crate::text_insert::paste_manual_current(
        &state.accessibility_trust_observed,
        &result.text,
        false,
        crate::text_insert::ManualCurrentPaste::capture_current(
            target_app.clone(),
            target_app_bundle_id.clone(),
        ),
    );
    if !outcome.pasted && !outcome.copied {
        return Err(outcome
            .error
            .unwrap_or_else(|| "Could not re-insert the last dictation result.".to_string()));
    }
    Ok(serde_json::json!({
        "pasted": outcome.pasted,
        "confirmed": outcome.confirmed,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

/// Whether this dictation is expected to run a pre-insert AI pass, so the
/// finishing bar can reserve room for a Polishing stage. A hint for the UI
/// only: the passes themselves keep their own gates, and a pass that is
/// skipped simply means `done` arrives before the bar reaches that stage.
fn dictation_polish_expected(
    settings: &settings::Settings,
    options: &models::DictationStartOptions,
    translation_route: DictationTranslationRoute,
) -> bool {
    translation_route == DictationTranslationRoute::AiLane
        || dictation_llm_formatting_enabled(settings, options)
}

/// What the HUD says while the first dictation on Parakeet's Core ML build
/// prepares it for this Mac, once, before transcribing.
const SPEECH_MODEL_PREPARING_MESSAGE: &str =
    "Preparing the speech model for this Mac. This happens once.";

/// About how long that first prepare takes: ~10 s for the Neural Engine's
/// compile, ~4 s on the Light tier, where the model loads on the CPU and
/// there is nothing to compile (measured 3.1-3.8 s, 2026-10-25).
fn speech_model_prepare_expected_ms() -> u64 {
    match crate::hardware_tier::current() {
        crate::hardware_tier::HardwareTier::Light => 4_000,
        _ => 10_000,
    }
}

/// The next transcription compiles the speech model first, because no other
/// copy of it can serve on this Mac (see `neural_engine::request_spec_for_family`).
fn speech_model_preparing_first_use(
    provider: asr::AsrProviderType,
    model_id: Option<&str>,
    language: Option<&str>,
) -> bool {
    crate::paths::data_dir()
        .map(|dir| dir.join("Plainsong").join("models"))
        .is_some_and(|models_root| {
            speech_model_preparing_first_use_at(&models_root, provider, model_id, language)
        })
}

fn speech_model_preparing_first_use_at(
    models_root: &std::path::Path,
    provider: asr::AsrProviderType,
    model_id: Option<&str>,
    language: Option<&str>,
) -> bool {
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        if provider != asr::AsrProviderType::TranscribeCpp
            || asr::transcribe_cpp::route_spec_for(model_id.unwrap_or_default()).model_id
                != asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID
        {
            return false;
        }
        asr::neural_engine::first_use_compile_pending(
            models_root,
            asr::neural_engine::family_for_language(language),
            asr::transcribe_cpp::parakeet_ggml_ready(models_root),
        )
    }
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    {
        let _ = (models_root, provider, model_id, language);
        false
    }
}

/// Moves the HUD from Transcribing to Polishing just before a pre-insert AI
/// pass starts. Returns when the stage started and whether the provider is
/// remote, for the timing estimate.
fn emit_dictation_polishing_stage(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    session_id: u64,
    remote: bool,
) -> (std::time::Instant, bool) {
    const POLISHING_MESSAGE: &str = "Polishing…";
    let expected_polish_ms = crate::dictation_progress::expected_polish_ms(remote);
    let mut expected_transcribe_ms = None;
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.message = Some(POLISHING_MESSAGE.to_string());
        overlay.clear_warnings();
        overlay.processing_stage = Some("polishing".to_string());
        overlay.expected_polish_ms = Some(expected_polish_ms);
        expected_transcribe_ms = overlay.expected_transcribe_ms;
    }
    // Repeats the transcription estimate so a HUD that mounted mid-session
    // still places the stage boundary where the first event put it.
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "transcribing",
            "sessionId": session_id,
            "message": POLISHING_MESSAGE,
            "processingStage": "polishing",
            "expectedTranscribeMs": expected_transcribe_ms,
            "expectedPolishMs": expected_polish_ms,
        }),
    );
    (std::time::Instant::now(), remote)
}

async fn snapshot_dictation_stop_options(
    tracker: &Mutex<DictationSessionTracker>,
    options: &Mutex<models::DictationStartOptions>,
    session_id: u64,
) -> models::DictationStartOptions {
    let tracker = tracker.lock().await;
    let mut options = options.lock().await;
    let mut snapshot = options.clone();
    snapshot.screen_vocabulary = if tracker.active_session_id == Some(session_id) {
        options.screen_vocabulary.take()
    } else {
        None
    };
    snapshot
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
    let mut dictation_options = snapshot_dictation_stop_options(
        &state.dictation_session_tracker,
        &state.dictation_start_options,
        session_id,
    )
    .await;
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
    let focused_field_fingerprint = dictation_options.focused_field_fingerprint.clone();
    #[cfg(target_os = "macos")]
    let mut selection_owner = {
        let slot = state.dictation_selection_owner.lock().await;
        if slot.as_ref().is_some_and(|(id, _)| *id == session_id) {
            slot.as_ref().map(|(_, owner)| Arc::clone(owner))
        } else {
            None
        }
    };
    #[cfg(target_os = "macos")]
    let mut selection_used = false;

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
        overlay.clear_warnings();
        overlay.processing_stage = None;
        overlay.expected_transcribe_ms = None;
        overlay.expected_polish_ms = None;
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
    //
    // The live preview is put down during the same wait. It never feeds the
    // transcript, and the streaming recognizer holds its model's compute lease
    // until its session closes; closing it here lets an in-flight preview
    // decode drain inside the tail instead of after it, before the final
    // decode asks for the model.
    // Capture ends at the tail regardless of how long the preview takes to
    // close: anything said after the key is released must not be inserted.
    let _capture_checkpoint_completion = state
        .audio_capture
        .lock()
        .await
        .capture_checkpoint_completion(session_id);
    let was_meeting_aside = state.audio_capture.lock().await.is_meeting_aside();
    let (audio_stop_result, preview_handoff, ()) = tokio::join!(
        async {
            let aside_clock = state.audio_capture.lock().await.aside_tail_clock();
            let tail_incomplete = if let Some((tap, start, tail_frames)) = aside_clock {
                let deadline = tokio::time::Instant::now() + Duration::from_millis(400);
                while tap.is_attached()
                    && tap.forwarded_frames().saturating_sub(start) < tail_frames
                    && tokio::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                tap.forwarded_frames().saturating_sub(start) < tail_frames
            } else {
                tokio::time::sleep(Duration::from_millis(
                    crate::audio::DICTATION_STOP_CAPTURE_TAIL_MS,
                ))
                .await;
                false
            };
            let mut audio = state.audio_capture.lock().await;
            let hit_max_duration = audio.dictation_hit_max_duration();
            let max_duration_seconds = audio.dictation_last_max_session_seconds();
            let capture_interrupted =
                !hit_max_duration && (tail_incomplete || audio.dictation_capture_interrupted());
            let result = audio.stop_dictation_for_session(session_id);
            let stopped_hit_max = audio.dictation_hit_max_duration();
            let stopped_interrupted = audio.dictation_capture_interrupted();
            drop(audio);
            persist_finished_meeting_aside(state, session_id).await;
            result.map(|audio_bytes| {
                let hit_max_duration = hit_max_duration || stopped_hit_max;
                let capture_interrupted =
                    !hit_max_duration && (capture_interrupted || stopped_interrupted);
                (
                    audio_bytes,
                    hit_max_duration,
                    max_duration_seconds,
                    capture_interrupted,
                )
            })
        },
        stop_dictation_live_preview_for_session(state, session_id),
        async {
            if !preview_only
                && DictationInsertionMode::from_settings_value(&requested_insertion_mode)
                    == DictationInsertionMode::Auto
            {
                let target = app_target.clone();
                let bundle = app_bundle_id.clone();
                // Restore only when Plainsong took focus. Field identity,
                // security and selection are still checked at delivery, and
                // no clipboard or text write happens during preparation.
                let _ = tokio::task::spawn_blocking(move || {
                    crate::text_insert::restore_target_after_self_focus(
                        target.as_deref(),
                        bundle.as_deref(),
                    );
                })
                .await;
            }
        },
    );
    let (audio_bytes, hit_max_duration, max_duration_seconds, capture_interrupted) =
        match audio_stop_result {
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
    let audio_finalized_ms = Some(elapsed_since_stop());
    if hit_max_duration {
        // The session was ended by the length ceiling, not by the user. Say so:
        // the transcript that follows covers only the audio that fit.
        let limit = if max_duration_seconds % 60 == 0 {
            format!("{} minutes", max_duration_seconds / 60)
        } else {
            format!("{} seconds", max_duration_seconds)
        };
        warnings.push(format!(
            "Dictation reached the maximum length of {limit} and was stopped. Only the audio captured up to that point was transcribed."
        ));
    }
    if capture_interrupted {
        warnings.push(
            "The microphone stopped sending audio during this dictation, so the end may be missing. Check that it is still connected."
                .to_string(),
        );
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

    // Before recognition, put the stopped audio on disk. It is deleted when
    // this function returns with the outcome recorded (the checkpoint's drop),
    // so only a process that dies before then leaves it for the next launch.
    let mut checkpoint = crate::dictation_checkpoint::begin_dictation_checkpoint(&audio_bytes);
    if checkpoint.is_some() {
        state
            .audio_capture
            .lock()
            .await
            .discard_capture_checkpoint(session_id);
    }

    let preview_was_pending = preview_handoff == DictationLivePreviewStop::Pending;
    if preview_was_pending
        && drain_pending_dictation_live_preview(&state.dictation_live_preview, session_id).await
            == DictationLivePreviewStop::Pending
    {
        if !dictation_processing_owned_by(
            &*state.dictation_session_tracker.lock().await,
            session_id,
        ) {
            return Ok(String::new());
        }
        let reason = "Couldn't finish this dictation while the live text was still processing.";
        let recovery = keep_failed_dictation_audio(&mut checkpoint, handle, true, reason);
        return Err(fail_dictation_stop(
            state,
            handle,
            &failure_context,
            Some(reason.to_string()),
            format!("{reason}{recovery}"),
        )
        .await);
    }

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
                return Err(fail_dictation_stop_with_recovery(
                    state,
                    handle,
                    &failure_context,
                    DictationRecoveryInput {
                        options: &dictation_options,
                        settings: &settings_snapshot,
                        audio_bytes: &audio_bytes,
                        duration_seconds: dictation_duration_seconds,
                    },
                    error.to_string(),
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
                return Err(fail_dictation_stop_with_recovery(
                    state,
                    handle,
                    &failure_context,
                    DictationRecoveryInput {
                        options: &dictation_options,
                        settings: &settings_snapshot,
                        audio_bytes: &audio_bytes,
                        duration_seconds: dictation_duration_seconds,
                    },
                    error.to_string(),
                    format!("Failed to read dictation snippets: {}", error),
                )
                .await);
            }
        }
    } else {
        Vec::new()
    };

    // Resolve the destination-app category once — settings overrides,
    // bundle id, AND the browser-domain formatting hint — so the recognizer
    // vocabulary hint, dictionary/snippet category scoping and local smart
    // formatting all agree on the same category (matching what the LLM
    // prompt path resolves).
    let destination_category =
        resolve_dictation_destination_category(&settings_snapshot, &dictation_options);

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
        acoustic_vocabulary: {
            #[cfg(target_os = "macos")]
            let screen_terms = dictation_options
                .screen_vocabulary
                .as_ref()
                .filter(|(revision, _)| {
                    settings_snapshot.transcription.dictation_nearby_spelling
                        && selection_start_policy_is_current(
                            &state.dictation_selection_policy_revision,
                            *revision,
                        )
                })
                .map(|(_, vocabulary)| vocabulary.terms())
                .unwrap_or_default();
            #[cfg(not(target_os = "macos"))]
            let screen_terms: &[String] = &[];
            crate::dictation_vocabulary::for_dictation(
                &dictionary_entries,
                app_target.as_deref(),
                destination_category,
                screen_terms,
            )
        },
    };
    let vocabulary_hint_terms_built = transcription_options
        .vocabulary_hint
        .as_ref()
        .map(|hint| hint.terms().len())
        .unwrap_or(0);

    // Expected stage durations for the finishing bar, learned from this
    // Mac's recent dictations (see `dictation_progress`).
    let progress_route_key = crate::dictation_progress::asr_route_key(
        asr_provider_to_settings_value(provider_type),
        actual_model_id.as_deref(),
    );
    let progress_audio_seconds = dictation_duration_seconds.max(0) as f64;
    let expected_transcribe_ms = crate::dictation_progress::expected_transcribe_ms(
        &progress_route_key,
        provider_type.is_remote(),
        progress_audio_seconds,
    );
    let expected_polish_ms =
        dictation_polish_expected(&settings_snapshot, &dictation_options, translation_route).then(
            || {
                let remote = dictation_session_ai_selection(&settings_snapshot)
                    .map(|(provider, _, _)| provider.is_remote())
                    .unwrap_or(false);
                crate::dictation_progress::expected_polish_ms(remote)
            },
        );

    let speech_model_preparing = speech_model_preparing_first_use(
        provider_type,
        actual_model_id.as_deref(),
        transcription_options.language.as_deref(),
    );
    let (transcribing_message, expected_transcribe_ms) = if speech_model_preparing {
        (
            SPEECH_MODEL_PREPARING_MESSAGE,
            expected_transcribe_ms + speech_model_prepare_expected_ms(),
        )
    } else {
        ("Transcribing…", expected_transcribe_ms)
    };
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "transcribing".to_string();
        overlay.message = Some(transcribing_message.to_string());
        overlay.clear_warnings();
        overlay.processing_stage = Some("transcribing".to_string());
        overlay.expected_transcribe_ms = Some(expected_transcribe_ms);
        overlay.expected_polish_ms = expected_polish_ms;
    }
    let transcribe_started_at = std::time::Instant::now();
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "transcribing",
            "sessionId": session_id,
            "message": transcribing_message,
            "processingStage": "transcribing",
            "speechModelPreparing": speech_model_preparing,
            "expectedTranscribeMs": expected_transcribe_ms,
            "expectedPolishMs": expected_polish_ms,
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

    let retention_settings = Arc::clone(&state.settings_manager);

    let busy_deadline = std::time::Instant::now() + Duration::from_secs(20);
    let user_waiting = crate::llm::local_model_load::user_waiting_decode();
    let _ = tokio::time::timeout_at(
        busy_deadline.into(),
        wait_for_dictation_model_prewarm(
            provider_type,
            actual_model_id.as_deref().unwrap_or_default(),
        ),
    )
    .await;
    let transcription_result = loop {
        if !provider_type.is_remote() {
            if let Err(error) =
                crate::llm::local_model_load::wait_for_dictation_admission(busy_deadline).await
            {
                break Err(error);
            }
        }
        let retention_settings = Arc::clone(&retention_settings);
        let attempt = state
            .asr_manager
            .transcribe_bytes_for_dictation_with_release_decision(
                provider_type,
                &audio_bytes,
                actual_model_id.as_deref(),
                &transcription_options,
                move || {
                    let retention_settings = Arc::clone(&retention_settings);
                    async move {
                        let settings = retention_settings.lock_owned().await;
                        if dictation_keep_warm_enabled(
                            &settings.settings().transcription.dictation_keep_warm,
                        ) {
                            None
                        } else {
                            Some(settings)
                        }
                    }
                },
            )
            .await;
        match attempt {
            Err(error)
                if (crate::llm::native_runtime_is_busy(&error.to_string())
                    || (was_meeting_aside
                        && crate::llm::local_model_load::is_headroom_refusal(
                            &error.to_string(),
                        )))
                    && std::time::Instant::now() < busy_deadline =>
            {
                tokio::time::sleep_until(
                    (std::time::Instant::now() + Duration::from_millis(250))
                        .min(busy_deadline)
                        .into(),
                )
                .await;
            }
            other => break other,
        }
    };
    drop(user_waiting);
    let transcription_result = match transcription_result {
        Ok(result) => result,
        Err(error) => {
            let engine = provider_type.display_name();
            let detail = error.to_string();
            let detail = detail
                .strip_prefix(&format!("{engine} failed: "))
                .unwrap_or(&detail);
            let name =
                provider_type.speech_model_name(actual_model_id.as_deref().unwrap_or_default());
            let user_message = format!("Couldn't transcribe with {name}. {detail}");
            if !dictation_processing_owned_by(
                &*state.dictation_session_tracker.lock().await,
                session_id,
            ) {
                return Ok(String::new());
            }
            let user_message = format!(
                "{user_message}{}",
                keep_failed_dictation_audio(
                    &mut checkpoint,
                    handle,
                    preview_was_pending,
                    &error.to_string()
                )
            );
            return Err(fail_dictation_stop_with_recovery(
                state,
                handle,
                &failure_context,
                DictationRecoveryInput {
                    options: &dictation_options,
                    settings: &settings_snapshot,
                    audio_bytes: &audio_bytes,
                    duration_seconds: dictation_duration_seconds,
                },
                error.to_string(),
                user_message,
            )
            .await);
        }
    };

    if let Some(checkpoint) = checkpoint.as_mut() {
        checkpoint.advance(crate::dictation_checkpoint::DictationCheckpointStage::Recognized);
    }

    // Built is what the dictionary offered; applied is what the route that
    // actually ran attached (a whisper decode withholds it on near-silent
    // audio, cloud routes without a prompt field ignore it entirely). Only
    // the second says the dictionary reached the recognizer.
    // A one-time compile is not how long this route takes to transcribe.
    if !speech_model_preparing {
        crate::dictation_progress::record_transcribe_ms(
            &progress_route_key,
            provider_type.is_remote(),
            progress_audio_seconds,
            transcribe_started_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
    }
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

    let recognition_review_words = models::collect_recognition_review_words(
        transcription_result.actual_provider,
        &transcription_result.segments,
        &transcription_result.text,
        dictation_duration_seconds.max(0) as f64,
    );

    if !dictation_processing_owned_by(&*state.dictation_session_tracker.lock().await, session_id) {
        return Ok(String::new());
    }

    let raw_transcribed_text =
        sanitize_dictation_output(&transcription_result.text, &transcription_result.text)
            .trim()
            .to_string();
    {
        let tracker = state.dictation_session_tracker.lock().await;
        if !dictation_processing_owned_by(&tracker, session_id) {
            return Ok(String::new());
        }
        record_recent_dictation_result(
            state,
            handle,
            &raw_transcribed_text,
            app_target.as_deref(),
            app_bundle_id.as_deref(),
            Some(session_id),
            DictationRecoveryState::Raw,
        );
        if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
            if overlay.session_id == Some(session_id) {
                overlay.preview = Some(raw_transcribed_text.clone());
            }
        }
    }
    let now = chrono::Utc::now();
    let recent_delivery = state
        .recent_dictation_delivery
        .lock()
        .await
        .as_ref()
        .map(|delivery| delivery.snapshot.clone());
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
    let mut applied_dictionary_replacements = Vec::new();
    // The spoken language, and with it whether the English-only rules apply,
    // decided once for the local pipeline and the AI cleanup alike.
    let spoken_language = crate::text::language::dictation_spoken_language(
        settings_snapshot.transcription.language.as_deref(),
        Some(transcription_result.language.as_str()),
        translation_route == DictationTranslationRoute::WhisperNative,
    );
    let mut english_rules =
        crate::text::language::english_rules_apply(spoken_language, &raw_transcribed_text);
    let mut snippet_applied_count = 0usize;
    let mut formatting_applied = false;
    let mut recent_insert_reused = false;
    let mut pipeline_stage_keys: Vec<String> = Vec::new();
    let mut undo_previous_insert = false;
    let mut pending_voice_edit = None;
    // Timing-record fields for the format/cleanup stage. Stays
    // `NotApplicable` unless the pipeline below actually reaches formatting
    // (an empty transcript or a consumed command skips it entirely).
    let mut format_outcome = crate::dictation_timing::DictationFormatOutcome::NotApplicable;

    // Voice Edit: the words are an instruction. Runs instead of the command
    // grammar and the cleanup pipeline, and fails loudly rather than
    // inserting the instruction itself into the user's document.
    let voice_edit_mode = dictation_options
        .resolved_custom_mode_id
        .as_deref()
        .and_then(|id| {
            settings_snapshot
                .transcription
                .dictation_custom_modes
                .iter()
                .find(|mode| mode.id == id)
        })
        .is_some_and(|mode| mode.voice_edit);
    let parsed_command = if voice_edit_mode {
        parse_voice_edit_command(
            &raw_transcribed_text,
            &settings_snapshot.transcription.dictation_command_prefix,
        )
    } else if settings_snapshot
        .transcription
        .dictation_command_mode_enabled
    {
        parse_dictation_command(
            &raw_transcribed_text,
            &settings_snapshot.transcription.dictation_command_prefix,
        )
    } else {
        None
    };
    let deterministic_voice_edit = parsed_command
        .as_ref()
        .is_some_and(|(_, action)| crate::text_insert::voice_edit_is_deterministic(action));
    if voice_edit_mode && !deterministic_voice_edit && !raw_transcribed_text.trim().is_empty() {
        #[cfg(target_os = "macos")]
        {
            selection_used = true;
            let manager = state.settings_manager.lock().await;
            if selection_owner.as_ref().is_none_or(|owner| {
                !owner.permits(manager.settings(), &dictation_options)
                    || !owner.guard.verify_original_selection()
            }) {
                drop(manager);
                let error = "The original selection changed or could not be verified. Your audio is available for recovery; select the text again for Voice Edit.".to_string();
                return Err(fail_dictation_stop_with_recovery(
                    state,
                    handle,
                    &failure_context,
                    DictationRecoveryInput {
                        options: &dictation_options,
                        settings: &settings_snapshot,
                        audio_bytes: &audio_bytes,
                        duration_seconds: dictation_duration_seconds,
                    },
                    error.clone(),
                    error,
                )
                .await);
            }
        }

        let ai_is_remote = dictation_session_ai_selection(&settings_snapshot)
            .map(|(provider, _, _)| provider.is_remote())
            .unwrap_or(false);
        emit_dictation_polishing_stage(state, handle, session_id, ai_is_remote);
        // Only a captured selection is something to edit. Clipboard or window
        // context under a customized profile would otherwise be rewritten
        // and pasted at the caret as if it had been selected.
        let selection = (normalize_dictation_context_source(&dictation_options.context_source)
            == "selected_text")
            .then_some(dictation_options.captured_context_text.as_deref())
            .flatten();
        let voice_edit = run_owned_dictation_stage(
            state,
            session_id,
            crate::dictation_text::run_voice_edit(
                state,
                &settings_snapshot,
                raw_transcribed_text.as_str(),
                selection,
            ),
        )
        .await;
        let Some(voice_edit) = voice_edit else {
            return Ok(String::new());
        };
        match voice_edit {
            Ok((output, kind)) => {
                final_text = output;
                command_applied = Some(kind.command_key().to_string());
                pipeline_stage_keys.push(kind.command_key().to_string());
            }
            Err(error) => {
                return Err(fail_dictation_stop_with_recovery(
                    state,
                    handle,
                    &failure_context,
                    DictationRecoveryInput {
                        options: &dictation_options,
                        settings: &settings_snapshot,
                        audio_bytes: &audio_bytes,
                        duration_seconds: dictation_duration_seconds,
                    },
                    error.clone(),
                    error,
                )
                .await);
            }
        }
    }

    if command_applied.is_none()
        && (voice_edit_mode
            || settings_snapshot
                .transcription
                .dictation_command_mode_enabled)
    {
        if let Some((command_key, action)) = parsed_command {
            if crate::text_insert::voice_edit_uses_native_field(
                &action,
                normalize_dictation_context_source(&dictation_options.context_source),
                &requested_insertion_mode,
            ) {
                #[cfg(target_os = "macos")]
                if normalize_dictation_context_source(&dictation_options.context_source)
                    == "selected_text"
                    && dictation_options
                        .captured_context_text
                        .as_ref()
                        .is_some_and(|text| !text.is_empty())
                    && !matches!(
                        action,
                        DictationCommandAction::SelectPhrase(_)
                            | DictationCommandAction::MoveToStart
                            | DictationCommandAction::MoveToEnd
                            | DictationCommandAction::DeleteLastSentence
                            | DictationCommandAction::UndoLastInsert
                    )
                {
                    selection_used = true;
                }
                pending_voice_edit = Some(action);
                command_applied = Some(command_key);
                final_text.clear();
                pipeline_stage_keys.push("command".into());
            } else {
                let command_context_text = dictation_options.captured_context_text.clone();
                let command_context_source =
                    normalize_dictation_context_source(&dictation_options.context_source)
                        .to_string();
                let context_requirement =
                    crate::dictation_parity::dictation_command_context_requirement(&action);
                if !context_requirement
                    .accepts_context(&command_context_source, command_context_text.as_deref())
                {
                    let error = "Select the text and start Voice Edit to use this command. Your recognized words are ready to review in Plainsong.".to_string();
                    return Err(fail_dictation_stop_with_recovery(
                        state,
                        handle,
                        &failure_context,
                        DictationRecoveryInput {
                            options: &dictation_options,
                            settings: &settings_snapshot,
                            audio_bytes: &audio_bytes,
                            duration_seconds: dictation_duration_seconds,
                        },
                        error.clone(),
                        error,
                    )
                    .await);
                }

                #[cfg(target_os = "macos")]
                if context_requirement
                    != crate::dictation_parity::DictationCommandContextRequirement::None
                    && command_context_source == "selected_text"
                {
                    selection_used = true;
                }

                let ai_selection = match dictation_session_ai_selection(&settings_snapshot) {
                    Ok(selection) => selection,
                    Err(error) => {
                        return Err(fail_dictation_stop_with_recovery(
                            state,
                            handle,
                            &failure_context,
                            DictationRecoveryInput {
                                options: &dictation_options,
                                settings: &settings_snapshot,
                                audio_bytes: &audio_bytes,
                                duration_seconds: dictation_duration_seconds,
                            },
                            error.clone(),
                            error,
                        )
                        .await);
                    }
                };
                let command = run_owned_dictation_stage(
                state,
                session_id,
                async {
                    #[cfg(target_os = "macos")]
                    if selection_used && {
                        let manager = state.settings_manager.lock().await;
                        selection_owner.as_ref().is_none_or(|owner|
                            !owner.permits(manager.settings(), &dictation_options)
                                || !owner.guard.verify_original_selection())
                    } {
                        return Err(DictationCommandError::Failed(
                            "The selected field changed before the command. Select the text again and retry.".into(),
                        ));
                    }
                execute_dictation_command_action(
                    state,
                    &command_key,
                    action,
                    command_context_text.as_deref(),
                    &command_context_source,
                    &ai_selection,
                ).await
                },
            )
            .await;
                let Some(command) = command else {
                    return Ok(String::new());
                };
                match command {
                    Ok(execution) => {
                        final_text = execution.output_text;
                        command_applied = Some(execution.command_applied);
                        prompt_source = execution.prompt_source;
                        prompt_preview = execution.prompt_preview;
                        undo_previous_insert = execution.undo_previous_insert;
                        pipeline_stage_keys.push("command".to_string());
                    }
                    Err(DictationCommandError::MissingContext(error))
                    | Err(DictationCommandError::Failed(error)) => {
                        return Err(fail_dictation_stop_with_recovery(
                            state,
                            handle,
                            &failure_context,
                            DictationRecoveryInput {
                                options: &dictation_options,
                                settings: &settings_snapshot,
                                audio_bytes: &audio_bytes,
                                duration_seconds: dictation_duration_seconds,
                            },
                            error.clone(),
                            error,
                        )
                        .await);
                    }
                }
            }
        } else if crate::dictation_parity::has_dictation_command_prefix(
            raw_transcribed_text.as_str(),
            &settings_snapshot.transcription.dictation_command_prefix,
        ) {
            let error = "The spoken command was not recognized. Your recognized words are available for recovery.".to_string();
            return Err(fail_dictation_stop_with_recovery(
                state,
                handle,
                &failure_context,
                DictationRecoveryInput {
                    options: &dictation_options,
                    settings: &settings_snapshot,
                    audio_bytes: &audio_bytes,
                    duration_seconds: dictation_duration_seconds,
                },
                error.clone(),
                error,
            )
            .await);
        }
    }

    #[cfg(target_os = "macos")]
    if !selection_used {
        if let Some(owner) = selection_owner.take() {
            owner.guard.invalidate();
        }
    }

    if command_applied.is_none() {
        // `destination_category` was resolved once, before transcription, so
        // the recognizer hint and this pass scope entries identically.
        let mut pipeline_result = run_local_dictation_pipeline(
            raw_transcribed_text.as_str(),
            &settings_snapshot,
            &dictionary_entries,
            &snippets,
            recent_inserted_text,
            LocalDictationDestination {
                spoken_language,
                app_target: app_target.as_deref(),
                category: destination_category,
                field_role: focused_field_fingerprint
                    .as_ref()
                    .and_then(|field| field.role.as_deref()),
            },
        );
        if pipeline_result.command_applied.is_none() && pipeline_result.snippet_applied_count == 0 {
            crate::dictation_vocabulary::apply_to_pipeline_result(
                &mut pipeline_result,
                &transcription_result.text,
                &transcription_result.vocabulary_candidates,
                &transcription_options.acoustic_vocabulary,
            );
        }
        #[cfg(target_os = "macos")]
        if pipeline_result.command_applied.is_none() && pipeline_result.snippet_applied_count == 0 {
            if let Some((revision, vocabulary)) = dictation_options.screen_vocabulary.take() {
                let manager = state.settings_manager.lock().await;
                if manager.settings().transcription.dictation_nearby_spelling
                    && selection_start_policy_is_current(
                        &state.dictation_selection_policy_revision,
                        revision,
                    )
                {
                    apply_screen_spelling(
                        &mut pipeline_result,
                        &vocabulary,
                        destination_category
                            == crate::text::format::DictationAppCategory::CodeEditor,
                    );
                }
            }
        }
        final_text = pipeline_result.text.trim().to_string();
        command_applied = pipeline_result.command_applied.clone();
        dictionary_applied_count = pipeline_result.dictionary_applied_count;
        applied_dictionary_replacements = pipeline_result.applied_dictionary_replacements;
        snippet_applied_count = pipeline_result.snippet_applied_count;
        formatting_applied = pipeline_result.formatting_applied;
        recent_insert_reused = pipeline_result.recent_insert_reused;
        pipeline_stage_keys = pipeline_result.pipeline_stage_keys.clone();
        undo_previous_insert = pipeline_result.undo_previous_insert;
        english_rules = pipeline_result.english_rules;
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
    let session_transform_policy =
        dictation_ai_transform_policy(&settings_snapshot, &dictation_options);
    // Set when the first AI pass starts; the HUD switches to Polishing then.
    let mut polish_started_at: Option<(std::time::Instant, bool)> = None;

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
                    dictation_format_timeout_for_policy(provider, session_transform_policy),
                    std::time::Instant::now(),
                );
                polish_started_at.get_or_insert_with(|| {
                    emit_dictation_polishing_stage(state, handle, session_id, provider.is_remote())
                });
                let translated = run_owned_dictation_stage(
                    state,
                    session_id,
                    tokio::time::timeout(
                        format_timeout,
                        run_custom_dictation_transform_with_provider(
                            state,
                            final_text.as_str(),
                            DICTATION_TRANSLATE_TO_ENGLISH_PROMPT,
                            provider,
                            &model,
                            remote_processing_enabled,
                        ),
                    ),
                )
                .await;
                let Some(translated) = translated else {
                    return Ok(String::new());
                };
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
            "messages" | "email" | "meeting_follow_up" | "notes" => {
                if let Some((mut prompt, resolved_prompt_source)) =
                    resolve_dictation_mode_transform_prompt(&settings_snapshot, &effective_mode)
                        .filter(|_| {
                            dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options)
                        })
                {
                    let transform_policy = session_transform_policy;
                    if transform_policy == DictationAiTransformPolicy::MeaningPreservingRewrite
                        && resolved_prompt_source.starts_with("mode_transform:")
                        && preserve_first_person_stance(&settings_snapshot, &dictation_options)
                    {
                        if let Some(base) = builtin_dictation_rewrite_base(&effective_mode) {
                            prompt = base;
                        }
                    }
                    prompt = crate::dictation_fidelity::dictionary_spelling_prompt(
                        &prompt,
                        &applied_dictionary_replacements,
                    );
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
                                dictation_format_timeout_for_policy(provider, transform_policy),
                                std::time::Instant::now(),
                            );
                            polish_started_at.get_or_insert_with(|| {
                                emit_dictation_polishing_stage(
                                    state,
                                    handle,
                                    session_id,
                                    provider.is_remote(),
                                )
                            });
                            let transform = run_owned_dictation_stage(state, session_id,
                                tokio::time::timeout(format_timeout, async {
                                match transform_policy {
                                    DictationAiTransformPolicy::StrictCleanup => {
                                        run_dictation_cleanup_with_provider(
                                            state,
                                            final_text.as_str(),
                                            prompt.as_str(),
                                            provider,
                                            &model,
                                            remote_processing_enabled,
                                            settings_snapshot.transcription.dictation_remove_disfluencies
                                                && english_rules,
                                        )
                                        .await
                                    }
                                    DictationAiTransformPolicy::MeaningPreservingRewrite => {
                                        let rewrite_prompt =
                                            meaning_preserving_rewrite_prompt(&prompt);
                                        run_custom_dictation_transform_with_provider(
                                            state,
                                            final_text.as_str(),
                                            &rewrite_prompt,
                                            provider,
                                            &model,
                                            remote_processing_enabled,
                                        )
                                        .await
                                        .and_then(|result| {
                                            if preserve_first_person_stance(&settings_snapshot, &dictation_options) {
                                                crate::dictation_fidelity::validate_first_person_stance(final_text.as_str(), &result.0).map(|()| result)
                                            } else {
                                                Ok(result)
                                            }
                                        })
                                    }
                                }
                                }),
                            ).await;
                            let Some(transform) = transform else {
                                return Ok(String::new());
                            };
                            match transform {
                                Ok(Ok((output, _, _))) => {
                                    if crate::dictation_fidelity::validate_dictionary_replacements(
                                        &final_text,
                                        &output,
                                        &applied_dictionary_replacements,
                                    )
                                    .is_ok()
                                    {
                                        crate::dictation_timing::DictationFormatAttempt::Applied(
                                            output,
                                        )
                                    } else {
                                        crate::dictation_timing::DictationFormatAttempt::Failed
                                    }
                                }
                                Ok(Err(error)) => {
                                    // Keep the local pipeline output
                                    // verbatim: it is the user's words,
                                    // correctly formatted.
                                    tracing::warn!(
                                        "Dictation mode transform for '{}' did not complete, keeping local pipeline output: {}",
                                        effective_mode,
                                        error
                                    );
                                    dictation_format_attempt_for_error(&error)
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
                } else if effective_mode == "notes" {
                    let bulletized = format_dictation_notes(final_text.as_str());
                    if bulletized != final_text {
                        final_text = bulletized;
                        pipeline_stage_keys.push("mode_transform".to_string());
                    }
                    format_outcome = crate::dictation_timing::DictationFormatOutcome::Applied;
                } else {
                    // No local equivalent exists for "rewrite this as an
                    // email" -- the stage was reached but had nothing to run,
                    // because Smart Format / AI formatting is off.
                    format_outcome = crate::dictation_timing::DictationFormatOutcome::Skipped;
                }
            }
            _ => {
                if dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options)
                    && !short_dictation_cleanup_is_complete(
                        &settings_snapshot,
                        &dictation_options,
                        &final_text,
                    )
                {
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
                        Ok(mut prepared) => {
                            prepared.follow_language_rules(english_rules);
                            prepared.applied_dictionary_replacements =
                                applied_dictionary_replacements.clone();
                            prepared.system_prompt =
                                crate::dictation_fidelity::dictionary_spelling_prompt(
                                    &prepared.system_prompt,
                                    &applied_dictionary_replacements,
                                );
                            let format_timeout = pre_insert_budget.remaining(
                                dictation_format_timeout_for_policy(
                                    prepared.provider,
                                    session_transform_policy,
                                ),
                                std::time::Instant::now(),
                            );
                            polish_started_at.get_or_insert_with(|| {
                                emit_dictation_polishing_stage(
                                    state,
                                    handle,
                                    session_id,
                                    prepared.provider.is_remote(),
                                )
                            });
                            let formatting = run_owned_dictation_stage(
                                state,
                                session_id,
                                tokio::time::timeout(
                                    format_timeout,
                                    execute_dictation_formatting_request(
                                        state,
                                        &prepared,
                                        final_text.as_str(),
                                    ),
                                ),
                            )
                            .await;
                            let Some(formatting) = formatting else {
                                return Ok(String::new());
                            };
                            match formatting {
                                Ok(Ok(output)) => {
                                    crate::dictation_timing::DictationFormatAttempt::Applied(output)
                                }
                                Ok(Err(error)) => {
                                    tracing::warn!(
                                        "LLM dictation formatting did not complete, keeping local pipeline output: {}",
                                        error
                                    );
                                    dictation_format_attempt_for_error(&error)
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
        .then(elapsed_since_stop);
    // A pass that failed fast says nothing about how long a real pass takes;
    // a timeout does, so it is kept.
    if let Some((started_at, remote)) = polish_started_at
        .filter(|_| format_outcome != crate::dictation_timing::DictationFormatOutcome::Failed)
    {
        crate::dictation_progress::record_polish_ms(
            remote,
            started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        );
    }

    final_text = finalize_dictation_result_text(
        final_text.as_str(),
        raw_transcribed_text.as_str(),
        command_applied.as_deref(),
    );

    // Escape (force_stop_dictation) clears the active session while this stop
    // is still transcribing or formatting. Honor it: a cancel that let the
    // text land anyway would be a lie, and force_stop has already reset the
    // runtime and emitted its terminal phase, so there is nothing left to
    // clean up here.
    if !dictation_processing_owned_by(&*state.dictation_session_tracker.lock().await, session_id) {
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
    let history_requested = dictation_history_requested_for_capture(
        dictation_options.save_to_inbox,
        &settings_snapshot.transcription.dictation_retention_preset,
        was_meeting_aside,
    );
    let recording_id = uuid::Uuid::new_v4().to_string();
    let stored_text = dictation_history_final_text(
        &final_text,
        &raw_transcribed_text,
        command_applied.as_deref(),
    );
    let transcript = models::Transcript {
        heard_through_speakers: Vec::new(),
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
        measured_word_timestamps: transcription_result.measured_word_timestamps
            && stored_text == raw_transcribed_text,
        created_at: now,
    };
    // Opt-in: keep the captured WAV so this entry can be processed again.
    // Written before the row so a failed write never leaves a row that claims
    // audio it does not have; a failed row write removes the file again below.
    let mut kept_audio_path =
        if history_requested && settings_snapshot.transcription.dictation_keep_audio {
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
    let kept_audio_metadata = match kept_audio_path
        .as_deref()
        .map(recording_audio::validate_plaintext_wav)
    {
        Some(recording_audio::RecordingAudioValidation::Ready(metadata)) => Some(metadata),
        Some(recording_audio::RecordingAudioValidation::Missing(reason))
        | Some(recording_audio::RecordingAudioValidation::Failed(reason)) => {
            tracing::warn!("Dictation audio failed validation and will be discarded: {reason}");
            warnings.push(format!(
                "The dictation audio could not be kept for Process again: {reason}"
            ));
            if let Err(error) = discard_unvalidated_kept_audio(&mut kept_audio_path) {
                tracing::warn!("Failed to remove invalid kept dictation audio: {error}");
            }
            None
        }
        None => None,
    };
    let persist_to_history = should_persist_completed_dictation(
        history_requested,
        if is_intentional_dictation_command_output(&final_text, command_applied.as_deref()) {
            &raw_transcribed_text
        } else {
            &stored_text
        },
        kept_audio_metadata.is_some(),
    );
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
        if let Err(error) = db.create_dictation_history_entry_with_recognition_review(
            &recording,
            &transcript,
            &history_text,
            kept_audio_metadata.as_ref(),
            recognition_review_words.as_deref(),
        ) {
            drop(db);
            if let Some(path) = kept_audio_path.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            record_recent_dictation_result(
                state,
                handle,
                &final_text,
                app_target.as_deref(),
                dictation_options.context_app_bundle_id.as_deref(),
                Some(session_id),
                DictationRecoveryState::Completed,
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

    // Archiving can await database or vault work. Recheck after those awaits
    // before any clipboard, undo or insertion side effect.
    if !dictation_processing_owned_by(&*state.dictation_session_tracker.lock().await, session_id) {
        return Ok(String::new());
    }
    {
        let tracker = state.dictation_session_tracker.lock().await;
        if !dictation_processing_owned_by(&tracker, session_id) {
            return Ok(String::new());
        }
        if let Ok(mut results) = state.recent_dictation_results.lock() {
            if retire_resolved_command_recovery(
                &mut results,
                session_id,
                &final_text,
                command_applied.as_deref(),
            ) {
                handle.emit_event(
                    "dictation-recovery-results-changed",
                    serde_json::json!({ "results": &*results }),
                );
            }
        }
        record_recent_dictation_result(
            state,
            handle,
            &final_text,
            app_target.as_deref(),
            dictation_options.context_app_bundle_id.as_deref(),
            Some(session_id),
            DictationRecoveryState::Completed,
        );
        if persist_to_history {
            if let Ok(mut results) = state.recent_dictation_results.lock() {
                link_recent_dictation_result_to_history(&mut results, session_id, &recording_id);
            }
        }
    }

    let mut insert_latency_ms: Option<u64> = None;
    let mut post_insert_focus_anchor: Option<
        dictation_correction_capture::FocusedFieldFingerprint,
    > = None;
    let mut pasted = false;
    let mut copied = false;
    // What actually went into the field. Differs from `final_text` when the
    // words were fitted to the text around the caret; undo and the
    // correction anchor must look for this, not the unfitted text.
    let mut inserted_text = final_text.clone();
    let mut paste_error: Option<String> = None;
    let mut actual_insertion_mode = requested_insertion_mode.clone();
    let mut outcome = "ready".to_string();
    let mut undo_performed = false;
    let mut undo_cursor_ready = false;
    let mut owned_undo = None;
    let mut native_edit_completed = false;
    let native_edit_requested = pending_voice_edit.is_some();
    let mut delivered_at = now;
    // Timing-record fields for the insertion stage. Stay `None` unless text
    // insertion is actually dispatched below (preview-only delivery and an
    // undo-only command never reach it).
    let mut insertion_dispatched_ms: Option<u64> = None;
    let mut insertion_confirmed_ms: Option<u64> = None;
    let mut insertion_confirmed_flag = false;
    // `None` unless the starting binding asked for Return after inserting.
    let mut submit_after_insert_sent: Option<bool> = None;

    #[cfg(target_os = "macos")]
    let mut selection_delivery_consent = if selection_used {
        Some(Arc::clone(&state.settings_manager).lock_owned().await)
    } else {
        None
    };
    #[cfg(target_os = "macos")]
    let selection_delivery_allowed = if selection_used {
        selection_owner.as_ref().is_some_and(|owner| {
            selection_delivery_consent
                .as_ref()
                .is_some_and(|manager| owner.permits(manager.settings(), &dictation_options))
                && owner.guard.verify_original_selection()
        })
    } else {
        if let Some(owner) = selection_owner.take() {
            owner.guard.invalidate();
        }
        true
    };
    #[cfg(not(target_os = "macos"))]
    let selection_delivery_allowed = true;

    let automatic_delivery_error = if native_edit_requested
        && !preview_only
        && !matches!(
            DictationInsertionMode::from_settings_value(&requested_insertion_mode),
            DictationInsertionMode::Auto
        ) {
        Some("Choose Insert at cursor to use voice editing commands.".to_string())
    } else {
        (!preview_only
            && matches!(
                DictationInsertionMode::from_settings_value(&requested_insertion_mode),
                DictationInsertionMode::Auto
            ))
        .then(|| {
            crate::text_insert::OriginalAutoDelivery::capture(focused_field_fingerprint.as_ref())
                .err()
        })
        .flatten()
    };
    if !selection_delivery_allowed {
        paste_error = Some("The original selection changed or consent was revoked. Your result is ready to copy in Plainsong.".to_string());
        actual_insertion_mode = "preview".to_string();
        outcome = "error".to_string();
    } else if let Some(error) = automatic_delivery_error {
        // The field the dictation started in could not be identified (no
        // Accessibility element, no fingerprint), so nothing is pasted. That
        // is a refused delivery like any other: the words still go to the
        // clipboard, unless the field in front is secure or the user copied
        // something meanwhile.
        actual_insertion_mode = "preview".to_string();
        outcome = "error".to_string();
        let delivery_started = {
            let mut tracker = state.dictation_session_tracker.lock().await;
            claim_dictation_delivery(&mut tracker, session_id)
        };
        if !delivery_started {
            return Ok(String::new());
        }
        if let Some(checkpoint) = checkpoint.as_mut() {
            checkpoint.advance(crate::dictation_checkpoint::DictationCheckpointStage::Delivering);
        }
        let refusal = PasteOutcome {
            pasted: false,
            copied: false,
            direct_accessibility: false,
            confirmed: false,
            paste_requested: false,
            successful_strategy: None,
            secure_field: None,
            error: Some(error),
        };
        let (fallback, clipboard_kept) = apply_refused_delivery_fallback(
            state,
            session_id,
            refusal,
            &final_text,
            crate::text_insert::clipboard_change_count(),
        )
        .await;
        let newer_clipboard_kept = clipboard_kept;
        copied = fallback.copied;
        if copied {
            delivered_at = chrono::Utc::now();
            actual_insertion_mode = "clipboard_only".to_string();
        }
        paste_error = fallback.error.clone();
        outcome = resolve_dictation_delivery_outcome(DictationDeliveryFacts {
            pasted: false,
            copied,
            confirmed: false,
            undo_performed: false,
            secure_field_refused: fallback.secure_field.is_some(),
            newer_clipboard_kept,
            has_paste_error: paste_error.is_some(),
            clipboard_requested: false,
            previous: outcome.as_str(),
        });
    } else if preview_only {
        actual_insertion_mode = "preview".to_string();
        outcome = if final_text.is_empty() {
            "empty".to_string()
        } else {
            "previewed".to_string()
        };
    } else {
        // Cancellation and delivery compete under the same tracker lock.
        // Once delivery wins, force-stop must not pretend it can undo it.
        let delivery_started = {
            let mut tracker = state.dictation_session_tracker.lock().await;
            claim_dictation_delivery(&mut tracker, session_id)
        };
        if !delivery_started {
            return Ok(String::new());
        }
        if let Some(checkpoint) = checkpoint.as_mut() {
            checkpoint.advance(crate::dictation_checkpoint::DictationCheckpointStage::Delivering);
        }
        if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
            if overlay.session_id == Some(session_id) {
                overlay.phase = "delivering".to_string();
                overlay.message = Some("Inserting…".to_string());
                overlay.clear_warnings();
            }
        }
        handle.emit_event(
            "dictation-state-changed",
            serde_json::json!({
                "phase": "delivering", "sessionId": session_id, "message": "Inserting…",
            }),
        );
        if let Some(action) = pending_voice_edit.take() {
            actual_insertion_mode = "command_only".into();
            // Retire correction learning before our edit can be sampled as a user correction.
            let previous = {
                let mut slot = state.recent_dictation_delivery.lock().await;
                if recent_delivery.as_ref().is_some_and(|delivery| {
                    recent_delivery_owned_by(&slot, delivery.owner_session_id)
                }) {
                    slot.take()
                } else {
                    None
                }
            };
            let prior = previous.as_ref().and_then(|delivery| delivery.undo.clone());
            let field = focused_field_fingerprint.clone();
            let refused_action = action.clone();
            match tokio::task::spawn_blocking(move || {
                crate::text_insert::execute_native_voice_edit(prior, action, field).map_err(
                    |error| voice_edit_command_refusal(voice_edit_mode, &refused_action, error),
                )
            })
            .await
            {
                Ok(Ok(edit)) => {
                    owned_undo = Some(edit);
                    native_edit_completed = true;
                    undo_performed = command_applied.as_deref() == Some("undo_last_insert");
                    outcome = if undo_performed {
                        "undone"
                    } else {
                        "command_applied"
                    }
                    .into();
                    delivered_at = chrono::Utc::now();
                }
                Ok(Err(error)) => {
                    paste_error = Some(error);
                    outcome = "error".into();
                }
                Err(_) => {
                    paste_error = Some("Voice edit could not be verified. Check the field.".into());
                    outcome = "error".into();
                }
            }
            if !native_edit_completed
                && dictation_delivery_may_publish(
                    &*state.dictation_session_tracker.lock().await,
                    session_id,
                )
            {
                let mut slot = state.recent_dictation_delivery.lock().await;
                if slot.is_none() {
                    *slot = previous.map(|mut delivery| {
                        // Keep safe undo after a refused plan, but retire the old
                        // correction observer even if a native write was uncertain.
                        delivery.snapshot.owner_session_id = session_id;
                        delivery.snapshot.text.clear();
                        delivery
                    });
                }
            }
        }
        if undo_previous_insert {
            // Re-sample focus immediately before the destructive operation.
            // The session's start target alone is insufficient because focus
            // can change while audio is being transcribed.
            let focused_app = get_frontmost_app_name();
            let focused_bundle_id = get_frontmost_app_bundle_id();
            let undo_authorized = recent_delivery.as_ref().is_some_and(|delivery| {
                recent_delivery_allows_undo_attempt(
                    delivery,
                    app_target.as_deref(),
                    app_bundle_id.as_deref(),
                    focused_app.as_deref(),
                    focused_bundle_id.as_deref(),
                    &requested_insertion_mode,
                    chrono::Utc::now(),
                )
            });
            let delivery_guard = state.dictation_session_tracker.lock().await;
            let edit =
                if undo_authorized && dictation_delivery_may_publish(&delivery_guard, session_id) {
                    let mut slot = state.recent_dictation_delivery.lock().await;
                    recent_delivery.as_ref().and_then(|delivery| {
                        take_recent_delivery_undo(&mut slot, delivery.owner_session_id)
                    })
                } else {
                    None
                };
            if let Some(edit) = edit {
                let field = focused_field_fingerprint.clone();
                match tokio::task::spawn_blocking(move || {
                    crate::text_insert::undo_owned_dictation_edit(edit, field.as_ref())
                })
                .await
                {
                    Ok(Ok(caret_restored)) => {
                        undo_performed = true;
                        undo_cursor_ready = caret_restored;
                        outcome = "undone".to_string();
                        if !caret_restored {
                            paste_error = Some("The dictated text was removed. Check the cursor position before continuing.".to_string());
                            actual_insertion_mode = "command_only".to_string();
                        }
                    }
                    Ok(Err(error)) => {
                        paste_error = Some(error);
                    }
                    Err(_) => paste_error = Some(
                        "Undo could not be verified. Check the editor before trying another edit."
                            .to_string(),
                    ),
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

        if !native_edit_requested
            && should_insert_dictation_result(
                &final_text,
                command_applied.as_deref(),
                undo_previous_insert,
                undo_performed && undo_cursor_ready,
            )
        {
            // Retire learning and the previous edit before another delivery.
            // A late correction sample must not teach our own edits back to us.
            state.recent_dictation_delivery.lock().await.take();
            let insert_started_at = std::time::Instant::now();
            insertion_dispatched_ms = Some(elapsed_since_stop());
            let clipboard_count_before_delivery = crate::text_insert::clipboard_change_count();
            let paste_outcome =
                match DictationInsertionMode::from_settings_value(&requested_insertion_mode) {
                    DictationInsertionMode::ClipboardOnly => {
                        if let Err(error) = guard_current_delivery_field(
                            focused_field_fingerprint.as_ref(),
                            app_target.as_deref(),
                            app_bundle_id.as_deref(),
                        ) {
                            PasteOutcome {
                                pasted: false,
                                copied: false,
                                direct_accessibility: false,
                                confirmed: false,
                                paste_requested: false,
                                successful_strategy: None,
                                secure_field: None,
                                error: Some(error),
                            }
                        } else {
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
                                        paste_requested: false,
                                        successful_strategy: None,
                                        secure_field: None,
                                        error: None,
                                    },
                                    Err(error) => PasteOutcome {
                                        pasted: false,
                                        copied: false,
                                        direct_accessibility: false,
                                        confirmed: false,
                                        paste_requested: false,
                                        successful_strategy: None,
                                        secure_field: None,
                                        error: Some(error),
                                    },
                                }
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
                        let insert_focused_field = focused_field_fingerprint.clone();
                        #[cfg(target_os = "macos")]
                        let insert_selection = selection_used
                            .then(|| {
                                selection_owner
                                    .as_ref()
                                    .map(|owner| Arc::clone(&owner.guard))
                            })
                            .flatten();
                        let match_surrounding_text = command_applied.is_none()
                            && settings_snapshot
                                .transcription
                                .dictation_match_surrounding_text;
                        match tokio::task::spawn_blocking(move || {
                            let mut steps = crate::dictation_timing::DeliveryStepClock::start();
                            // A click on the pill's Stop button, the menu bar
                            // item or the main window can leave Plainsong in
                            // front. Bring the field the user dictated into back
                            // before checking it still has focus; another app
                            // the user switched to is never pulled back.
                            crate::text_insert::restore_target_after_self_focus(
                                insert_app_target.as_deref(),
                                insert_app_bundle_id.as_deref(),
                            );
                            steps.lap("restore");
                            let original = match crate::text_insert::OriginalAutoDelivery::capture(
                                insert_focused_field.as_ref(),
                            ) {
                                Ok(original) => original,
                                Err(error) => {
                                    return (delivery_refusal_outcome(error), insert_text, None)
                                }
                            };
                            #[cfg(target_os = "macos")]
                            if insert_selection
                                .as_ref()
                                .is_some_and(|guard| !guard.verify_original_selection())
                            {
                                return (
                                    delivery_refusal_outcome(
                                        DICTATION_FOCUS_CHANGED_MESSAGE.into(),
                                    ),
                                    insert_text,
                                    None,
                                );
                            }
                            if let Err(error) = guard_current_delivery_field(
                                insert_focused_field.as_ref(),
                                insert_app_target.as_deref(),
                                insert_app_bundle_id.as_deref(),
                            ) {
                                return (
                                    PasteOutcome {
                                        pasted: false,
                                        copied: false,
                                        direct_accessibility: false,
                                        confirmed: false,
                                        paste_requested: false,
                                        successful_strategy: None,
                                        secure_field: None,
                                        error: Some(error),
                                    },
                                    insert_text,
                                    None,
                                );
                            }
                            steps.lap("field_check");
                            // Fit the words to the sentence around the caret
                            // (spacing, casing, a stray full stop) and spell
                            // sound-alike names the field already contains.
                            // macOS only; the field text is read here and dropped.
                            #[cfg(target_os = "macos")]
                            let insert_text = match match_surrounding_text
                                .then(|| {
                                    crate::text_insert::read_cursor_neighbors(
                                        insert_app_target.as_deref(),
                                        insert_app_bundle_id.as_deref(),
                                    )
                                })
                                .flatten()
                            {
                                Some((before, after, names)) => {
                                    let names: Vec<&str> =
                                        names.iter().map(String::as_str).collect();
                                    let (named, _) =
                                        crate::dictation_sounds_like::correct_sound_alike_terms(
                                            &insert_text,
                                            &names,
                                        );
                                    crate::text::cursor_fit::fit_to_cursor(&named, &before, &after)
                                }
                                None => insert_text,
                            };
                            #[cfg(not(target_os = "macos"))]
                            let _ = match_surrounding_text;
                            steps.lap("cursor_fit");
                            let outcome = crate::text_insert::paste_original_dictation(
                                &accessibility_trust_observed,
                                insert_text.as_str(),
                                keep_text_in_clipboard,
                                insert_app_target.as_deref(),
                                insert_app_bundle_id.as_deref(),
                                original,
                                #[cfg(target_os = "macos")]
                                insert_selection,
                            );
                            steps.lap("write");
                            tracing::info!("dictation delivery steps: {}", steps.summary());
                            (outcome.outcome, insert_text, outcome.undo)
                        })
                        .await
                        {
                            Ok((outcome, text, undo)) => {
                                inserted_text = text;
                                owned_undo = undo;
                                outcome
                            }
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
                                paste_requested: false,
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
            // Never leave the words only inside a popup. A delivery that put
            // them nowhere — focus moved, the field could not be verified, the
            // app refused — leaves them on the clipboard and says so, unless
            // the field in front is a secure input or something other than
            // Plainsong changed the clipboard during delivery (the user copied
            // something). A refused paste that staged the words and put the
            // user's clipboard back still counts as untouched.
            let (paste_outcome, clipboard_kept) = apply_refused_delivery_fallback(
                state,
                session_id,
                paste_outcome,
                &final_text,
                clipboard_count_before_delivery,
            )
            .await;
            let newer_clipboard_kept = clipboard_kept;
            insert_latency_ms = Some(
                insert_started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            if dictation_options.submit_after_insert {
                let gate = crate::dictation_submit::SubmitAfterInsertGate::after(
                    &paste_outcome,
                    true,
                    !matches!(
                        DictationInsertionMode::from_settings_value(&requested_insertion_mode),
                        DictationInsertionMode::Auto
                    ),
                    command_applied.is_none() && !undo_previous_insert && !selection_used,
                    !dictation_delivery_may_publish(
                        &*state.dictation_session_tracker.lock().await,
                        session_id,
                    ),
                );
                let field = focused_field_fingerprint.clone();
                let target_app = app_target.clone();
                let target_bundle_id = app_bundle_id.clone();
                let sent = tokio::task::spawn_blocking(move || {
                    crate::dictation_submit::submit_after_insert(
                        &gate,
                        || {
                            crate::dictation_submit::probe_submit_field(
                                field.as_ref(),
                                target_app.as_deref(),
                                target_bundle_id.as_deref(),
                            )
                        },
                        crate::text_insert::send_return_key,
                    )
                })
                .await
                .unwrap_or(false);
                if sent {
                    // The box was submitted and is likely empty now: there is
                    // no inserted text left to undo or to watch for edits.
                    owned_undo = None;
                }
                submit_after_insert_sent = Some(sent);
            }
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
            if pasted || copied {
                delivered_at = chrono::Utc::now();
            }
            let secure_field_refused = paste_outcome.secure_field.is_some();
            if paste_error.is_none() {
                paste_error = paste_outcome.error;
            }
            // The snapshot limits this session to its original opt-in. Current
            // consent is checked inside the worker and held through the read.
            if pasted
                && submit_after_insert_sent != Some(true)
                && settings_snapshot
                    .transcription
                    .dictation_learn_from_external_corrections
                && !is_self_activation_target(app_target.as_deref(), app_bundle_id.as_deref())
            {
                let anchor_text = inserted_text.clone();
                let anchor_settings = Arc::clone(&state.settings_manager);
                let anchor_reader =
                    MacosFocusedFieldReader::from_original(focused_field_fingerprint.as_ref());
                #[cfg(target_os = "macos")]
                let anchor_consent = selection_delivery_consent.take();
                #[cfg(not(target_os = "macos"))]
                let anchor_consent = None;
                let anchor_result = tokio::task::spawn_blocking(move || {
                    with_insertion_anchor_consent(&anchor_settings, anchor_consent, || {
                        dictation_correction_capture::capture_insertion_anchor(
                            anchor_reader.as_ref()?,
                            anchor_text.as_str(),
                            &is_self_activation_target,
                        )
                    })
                })
                .await;
                match anchor_result {
                    Ok((anchor, _consent)) => {
                        post_insert_focus_anchor = anchor;
                        #[cfg(target_os = "macos")]
                        {
                            selection_delivery_consent = _consent;
                        }
                    }
                    Err(join_error) => {
                        tracing::warn!(
                            "Post-insert correction anchor did not complete: {}",
                            join_error
                        );
                    }
                }
            }
            outcome = resolve_dictation_delivery_outcome(DictationDeliveryFacts {
                pasted,
                copied,
                confirmed: paste_outcome.confirmed,
                undo_performed,
                secure_field_refused,
                newer_clipboard_kept,
                has_paste_error: paste_error.is_some(),
                clipboard_requested: requested_insertion_mode == "clipboard_only",
                previous: outcome.as_str(),
            });
        } else if undo_performed {
            actual_insertion_mode = "command_only".to_string();
        } else if paste_error.is_none() {
            outcome = "empty".to_string();
        }
    }

    #[cfg(target_os = "macos")]
    drop(selection_delivery_consent);

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
                "submit_after_insert_sent".to_string(),
                serde_json::json!(submit_after_insert_sent),
            );
            map.insert(
                "recovery_location".to_string(),
                serde_json::json!(dictation_recovery_location(
                    copied,
                    final_text.is_empty(),
                    persist_to_history
                )),
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

    let delivery_published = {
        let tracker = state.dictation_session_tracker.lock().await;
        if (pasted || copied || native_edit_completed)
            && dictation_delivery_may_publish(&tracker, session_id)
        {
            let mut slot = state.recent_dictation_delivery.lock().await;
            *slot = Some(RecentDictationDelivery {
                snapshot: RecentDictationDeliverySnapshot {
                    owner_session_id: session_id,
                    text: inserted_text.clone(),
                    app_target: app_target.clone(),
                    app_bundle_id: app_bundle_id.clone(),
                    delivered_at,
                    undo_available: owned_undo.is_some(),
                },
                undo: owned_undo,
            });
            true
        } else {
            false
        }
    };

    if let Some(anchor) = post_insert_focus_anchor.filter(|_| delivery_published) {
        schedule_post_insert_correction_readback(
            state,
            handle,
            inserted_text.clone(),
            app_target.clone(),
            anchor,
            delivered_at,
            session_id,
        );
    }

    #[cfg(target_os = "macos")]
    release_session_selection_owner(state, session_id).await;

    reset_dictation_session_runtime(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
    )
    .await;

    state.dictation_model_release.notify();

    let recovery_location =
        dictation_recovery_location(copied, final_text.is_empty(), persist_to_history);
    let done_message = dictation_done_message(
        &outcome,
        final_text.is_empty(),
        copied,
        &warnings,
        DictationDoneContext {
            app: app_target.as_deref(),
            submit_after_insert_sent,
            delivery_error: paste_error.as_deref(),
            history_off: !persist_to_history,
        },
    );

    // Emit done phase so the popup shows the result, then idle to dismiss it.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "done".to_string();
        overlay.message = Some(done_message.clone());
        overlay.warnings = warnings.clone();
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
        object.insert(
            "recognitionReviewWords".to_string(),
            serde_json::to_value(&recognition_review_words).unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "rawTranscript".to_string(),
            serde_json::Value::String(raw_transcribed_text.clone()),
        );
        if let Some(sent) = submit_after_insert_sent {
            object.insert(
                "submitAfterInsertSent".to_string(),
                serde_json::Value::Bool(sent),
            );
        }
        object.insert(
            "recordingId".to_string(),
            if persist_to_history {
                serde_json::Value::String(recording_id.clone())
            } else {
                serde_json::Value::Null
            },
        );
    }
    record_recent_dictation_result(
        state,
        handle,
        &final_text,
        app_target.as_deref(),
        dictation_options.context_app_bundle_id.as_deref(),
        Some(session_id),
        DictationRecoveryState::Completed,
    );
    handle.emit_event("dictation-text-ready", payload_value);
    let mut done_state_event = serde_json::json!({
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
    });
    if let Some(object) = done_state_event.as_object_mut() {
        object.insert(
            "warnings".to_string(),
            serde_json::to_value(&warnings).unwrap_or_else(|_| serde_json::json!([])),
        );
        // What delivery observed is `outcome`; where the words can be picked
        // up again is this, reported on its own.
        object.insert(
            "recoveryLocation".to_string(),
            serde_json::json!(recovery_location),
        );
    }
    handle.emit_event("dictation-state-changed", done_state_event);
    // The outcome is recorded and published: the audio checkpoint has done
    // its job.
    if let Some(checkpoint) = checkpoint.take() {
        checkpoint.resolve();
    }

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
        if submit_after_insert_sent == Some(false) {
            DICTATION_IDLE_RESET_ERROR_MS
        } else {
            dictation_overlay_idle_reset_delay_with_warnings_ms(&outcome, &warnings)
        },
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
    if outcome == "error"
        || outcome == "paste_dispatched"
        || outcome == "copied_instead"
        || outcome == NEWER_CLIPBOARD_KEPT_OUTCOME
        || outcome == dictation_secure_field::SECURE_FIELD_REASON_CODE
    {
        DICTATION_IDLE_RESET_ERROR_MS
    } else {
        DICTATION_IDLE_RESET_SUCCESS_MS
    }
}

/// Warning details need the same readable window as a delivery error even
/// when insertion itself succeeded. Blank placeholders do not extend the HUD.
pub(crate) fn dictation_overlay_idle_reset_delay_with_warnings_ms(
    outcome: &str,
    warnings: &[String],
) -> u64 {
    if warnings.iter().any(|warning| !warning.trim().is_empty()) {
        DICTATION_IDLE_RESET_ERROR_MS
    } else {
        dictation_overlay_idle_reset_delay_ms(outcome)
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

pub(crate) fn hold_dictation_overlay_review(
    overlay: &mut DictationOverlayState,
    session_id: u64,
) -> bool {
    if session_id == 0
        || overlay.session_id != Some(session_id)
        || overlay.dismissed
        || !matches!(overlay.phase.as_str(), "done" | "error")
    {
        return false;
    }
    overlay.review_held = true;
    true
}

pub(crate) fn try_reset_dictation_overlay(
    overlay: &mut DictationOverlayState,
    scheduled_for: u64,
) -> bool {
    if !dictation_idle_reset_applies(overlay.session_id, scheduled_for) || overlay.review_held {
        return false;
    }
    *overlay = DictationOverlayState::default();
    true
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

        let reset = overlay_state
            .lock()
            .map(|mut overlay| try_reset_dictation_overlay(&mut overlay, session_id))
            .unwrap_or(false);
        if !reset {
            return;
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

async fn queue_correction_with_retry<A>(
    acquire_authority: impl Fn() -> Option<A>,
    mut queue: impl FnMut() -> Result<bool, String>,
) -> bool {
    for attempt in 0..2 {
        let result = {
            let Some(_authority) = acquire_authority() else {
                return false;
            };
            queue()
        };
        match result {
            Ok(queued) => return queued,
            Err(error) => tracing::warn!("Queuing a correction suggestion failed: {}", error),
        }
        if attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    false
}

#[cfg(test)]
mod correction_queue_tests {
    use super::queue_correction_with_retry;
    use std::cell::Cell;

    #[tokio::test]
    async fn failed_once_queue_saves_one_pair_without_learning() {
        let mut db = crate::db::Database::new_in_memory_for_test().unwrap();
        let mut attempts = 0;
        let authority = std::sync::Mutex::new(());
        let queued = queue_correction_with_retry(
            || authority.try_lock().ok(),
            || {
                assert!(authority.try_lock().is_err());
                attempts += 1;
                if attempts == 1 {
                    return Err("injected write failure".into());
                }
                db.upsert_dictation_correction_suggestion(
                    "kuberentes",
                    "kubernetes",
                    "kuberentes",
                    "kubernetes",
                    None,
                    Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
                )
                .map(|_| true)
                .map_err(|error| error.to_string())
            },
        )
        .await;
        assert!(queued);
        assert!(authority.try_lock().is_ok());
        assert_eq!(attempts, 2);
        let suggestions = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].original_text, "kuberentes");
        assert_eq!(suggestions[0].corrected_text, "kubernetes");
        assert!(db.list_dictation_dictionary_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn retry_rechecks_consent_and_delivery_and_stops_after_two_failures() {
        for revoke in [Some("consent"), Some("delivery"), None] {
            let consent = Cell::new(true);
            let current_delivery = Cell::new(true);
            let attempts = Cell::new(0);
            let checks = Cell::new(0);
            assert!(
                !queue_correction_with_retry(
                    || {
                        checks.set(checks.get() + 1);
                        (consent.get() && current_delivery.get()).then_some(())
                    },
                    || {
                        attempts.set(attempts.get() + 1);
                        match revoke {
                            Some("consent") => consent.set(false),
                            Some("delivery") => current_delivery.set(false),
                            _ => {}
                        }
                        Err("injected write failure".into())
                    },
                )
                .await
            );
            assert_eq!(checks.get(), 2);
            assert_eq!(attempts.get(), if revoke.is_some() { 1 } else { 2 });
        }
    }
}

/// Watch one inserted field for a settled correction within the value-read budget.
/// Unsupported observers retain the four-second read.
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
///   native metadata is checked before reading field text;
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
    owner_session_id: u64,
) {
    let db = Arc::clone(&state.db);
    let settings_manager = Arc::clone(&state.settings_manager);
    let recent_delivery = Arc::clone(&state.recent_dictation_delivery);
    let readback_handle = handle.clone();

    tokio::spawn(async move {
        let readback_db = Arc::clone(&db);
        let readback_settings = Arc::clone(&settings_manager);
        let readback_delivery = Arc::clone(&recent_delivery);
        let outcome = match tokio::task::spawn_blocking(move || {
            let session = crate::text_insert::CorrectionCaptureSession::claim()?;
            // Optional capture never waits for settings, delivery, or database locks.
            let acquire_read = || {
                let manager = Arc::clone(&readback_settings).try_lock_owned().ok()?;
                if !manager
                    .settings()
                    .transcription
                    .dictation_learn_from_external_corrections
                {
                    return None;
                }
                let delivery = Arc::clone(&readback_delivery).try_lock_owned().ok()?;
                if !recent_delivery_owned_by(&delivery, owner_session_id) {
                    return None;
                }
                Some((manager, delivery))
            };
            let may_read = || acquire_read().is_some();
            if !may_read() {
                return None;
            }
            let elapsed = chrono::Utc::now()
                .signed_duration_since(delivered_at)
                .to_std()
                .ok()?;
            let lifetime = std::time::Duration::from_secs(
                dictation_correction_capture::POST_INSERT_READBACK_WINDOW_SECS as u64,
            );
            let remaining = lifetime.checked_sub(elapsed)?;
            if remaining.is_zero() {
                return None;
            }
            let end = std::time::Instant::now().checked_add(remaining)?;
            let known_dictionary_spoken_forms = {
                let db = readback_db.try_lock().ok()?;
                db.list_dictation_dictionary_entries()
                    .ok()?
                    .into_iter()
                    .map(|entry| entry.spoken_form.to_lowercase())
                    .collect::<HashSet<_>>()
            };
            let sample = match crate::text_insert::observe_post_insert_correction(
                &session,
                &anchor,
                &inserted_text,
                end,
                acquire_read,
                |text| {
                    text.chars().count() <= dictation_correction_capture::MAX_READBACK_CHARS
                        && dictation_correction_capture::derive_readback_candidates(
                            &inserted_text,
                            text,
                            &known_dictionary_spoken_forms,
                        )
                        .is_ok_and(|candidates| !candidates.is_empty())
                },
            ) {
                crate::text_insert::CorrectionWatchOutcome::Sample(sample) => *sample,
                crate::text_insert::CorrectionWatchOutcome::Aborted => return None,
                crate::text_insert::CorrectionWatchOutcome::Unsupported(element_hash) => {
                    // Unsupported observers retain the one-shot read at four seconds
                    // from delivery. Setup time never extends the eight-second window.
                    let elapsed = chrono::Utc::now()
                        .signed_duration_since(delivered_at)
                        .to_std()
                        .ok()?;
                    let delay = crate::text_insert::correction_fallback_wait(elapsed)?;
                    let fallback_at = std::time::Instant::now().checked_add(delay)?;
                    if fallback_at >= end {
                        return None;
                    }
                    while std::time::Instant::now() < fallback_at {
                        if !may_read() || std::time::Instant::now() >= end {
                            return None;
                        }
                        std::thread::sleep(
                            fallback_at
                                .saturating_duration_since(std::time::Instant::now())
                                .min(std::time::Duration::from_millis(20)),
                        );
                    }
                    crate::text_insert::read_post_insert_correction_once(
                        &session,
                        &anchor,
                        element_hash,
                        end,
                        acquire_read,
                    )?
                }
            };
            if !may_read() || std::time::Instant::now() >= end {
                return None;
            }
            let request = dictation_correction_capture::PostInsertReadbackRequest {
                enabled: true,
                inserted_text,
                insertion_fingerprint: anchor,
                elapsed_secs: dictation_correction_capture::readback_elapsed_secs(
                    chrono::Utc::now().signed_duration_since(delivered_at),
                ),
                delivery_is_current: true,
                known_dictionary_spoken_forms,
            };
            struct CapturedField(dictation_correction_capture::FocusedFieldSnapshot);
            impl dictation_correction_capture::FocusedFieldReader for CapturedField {
                fn read_focused_field(
                    &self,
                ) -> Result<Option<dictation_correction_capture::FocusedFieldSnapshot>, String>
                {
                    Ok(Some(self.0.clone()))
                }
            }
            Some(dictation_correction_capture::evaluate_post_insert_readback(
                &CapturedField(sample),
                &request,
            ))
        })
        .await
        {
            Ok(Some(outcome)) => outcome,
            Ok(None) => return,
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
            // Retirement waits until each synchronous queue attempt finishes.
            let acquire_authority = || {
                let settings_guard = settings_manager.try_lock().ok()?;
                let enabled = settings_guard
                    .settings()
                    .transcription
                    .dictation_learn_from_external_corrections;
                let delivery_guard = recent_delivery.try_lock().ok()?;
                let elapsed = chrono::Utc::now().signed_duration_since(delivered_at);
                if !enabled
                    || !recent_delivery_owned_by(&delivery_guard, owner_session_id)
                    || elapsed < chrono::Duration::zero()
                    || elapsed
                        >= chrono::Duration::seconds(
                            dictation_correction_capture::POST_INSERT_READBACK_WINDOW_SECS,
                        )
                {
                    return None;
                }
                Some((settings_guard, delivery_guard))
            };
            for candidate in &candidates {
                if queue_correction_with_retry(&acquire_authority, || {
                    match db.has_learned_global_dictation_correction(
                        &candidate.spoken_form,
                        &candidate.replacement,
                    ) {
                        Ok(true) => return Ok(false),
                        Ok(false) => {}
                        Err(error) => {
                            tracing::warn!("Checking a learned correction failed: {}", error);
                            return Ok(false);
                        }
                    }
                    db.upsert_dictation_correction_suggestion(
                        candidate.spoken_form.as_str(),
                        candidate.replacement.as_str(),
                        candidate.spoken_form.as_str(),
                        candidate.replacement.as_str(),
                        app_target.as_deref(),
                        Some(models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
                    )
                    .map(|_| true)
                    .map_err(|error| error.to_string())
                })
                .await
                {
                    queued += 1;
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
mod insertion_anchor_consent_tests {
    use super::{
        dictation_done_message, finalize_dictation_result_text, with_insertion_anchor_consent,
        DictationDoneContext,
    };
    use crate::settings::SettingsManager;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn manager(enabled: bool) -> Arc<Mutex<SettingsManager>> {
        let mut manager = SettingsManager::default();
        manager
            .settings_mut()
            .transcription
            .dictation_learn_from_external_corrections = enabled;
        Arc::new(Mutex::new(manager))
    }

    /// The action Voice Edit runs locally, or `None` when the utterance goes
    /// to the model rewrite path.
    fn voice_edit_local_action(
        spoken: &str,
        prefix: &str,
    ) -> Option<crate::dictation_parity::DictationCommandAction> {
        super::parse_voice_edit_command(spoken, prefix)
            .map(|(_, action)| action)
            .filter(crate::text_insert::voice_edit_is_deterministic)
    }

    #[test]
    fn voice_edit_sends_unprefixed_payload_commands_to_the_rewrite_path() {
        for spoken in [
            "change the tone to formal",
            "Change the tone to formal.",
            "change that to something warmer",
            "replace the jargon with plain words",
            "replace that with a shorter version",
            "replace selection with a friendlier opening",
            "append a closing line",
            "prepend a short greeting",
            "delete phrase every adjective",
            "remove phrase the hedges",
            "make this more formal",
            "rewrite this politely",
            "Make this more formal.",
            "turn this into bullets",
        ] {
            for prefix in ["command", "plainsong", ""] {
                assert_eq!(
                    voice_edit_local_action(spoken, prefix),
                    None,
                    "{spoken:?} with prefix {prefix:?} must reach the model"
                );
            }
        }
    }

    #[test]
    fn voice_edit_runs_prefixed_payload_commands_deterministically() {
        use crate::dictation_parity::DictationCommandAction as Action;
        let swap = Action::ReplaceSelection {
            target: "Smith".into(),
            replacement: "Smyth".into(),
        };
        for (spoken, prefix) in [
            ("command change Smith to Smyth", "command"),
            ("Command, change Smith to Smyth", "command"),
            ("command change Smith to Smyth", ""),
            ("plainsong change Smith to Smyth", "plainsong"),
            ("command replace Smith with Smyth", "command"),
        ] {
            assert_eq!(
                super::parse_voice_edit_command(spoken, prefix).map(|(_, action)| action),
                Some(swap.clone()),
                "{spoken:?}"
            );
            assert_eq!(
                voice_edit_local_action(spoken, prefix).is_some(),
                cfg!(target_os = "macos"),
                "{spoken:?}"
            );
        }
        for (spoken, action) in [
            (
                "command append see you then",
                Action::AppendToSelection("see you then".into()),
            ),
            (
                "command prepend Hi team,",
                Action::PrependToSelection("Hi team,".into()),
            ),
            (
                "command replace that with revised plan",
                Action::ReplaceEntireSelection("revised plan".into()),
            ),
            (
                "command delete phrase every adjective",
                Action::DeletePhrase("every adjective".into()),
            ),
        ] {
            assert_eq!(
                super::parse_voice_edit_command(spoken, "command").map(|(_, action)| action),
                Some(action),
                "{spoken:?}"
            );
        }
        // A different prefix is just a word, so the utterance is an instruction.
        assert_eq!(
            voice_edit_local_action("command change Smith to Smyth", "plainsong"),
            None
        );
    }

    #[test]
    fn voice_edit_runs_structural_commands_without_the_prefix() {
        use crate::dictation_parity::DictationCommandAction as Action;
        for (spoken, action) in [
            ("undo that", Action::UndoLastInsert),
            ("scratch that", Action::UndoLastInsert),
            ("delete that", Action::DeleteThat),
            ("Delete last sentence.", Action::DeleteLastSentence),
            ("select Smyth", Action::SelectPhrase("Smyth".into())),
            ("move to start", Action::MoveToStart),
            ("move to end", Action::MoveToEnd),
            ("new line", Action::InsertText("\n".into())),
            ("new paragraph", Action::InsertText("\n\n".into())),
            ("capitalise that", Action::SentenceCaseSelection),
            ("make that uppercase", Action::UppercaseSelection),
            ("delete selection", Action::DeleteSelection),
        ] {
            for prefix in ["command", ""] {
                assert_eq!(
                    super::parse_voice_edit_command(spoken, prefix).map(|(_, action)| action),
                    Some(action.clone()),
                    "{spoken:?}"
                );
                assert_eq!(
                    super::parse_voice_edit_command(&format!("command {spoken}"), prefix)
                        .map(|(_, action)| action),
                    Some(action.clone()),
                    "command {spoken:?}"
                );
            }
            assert_eq!(
                voice_edit_local_action(spoken, "command").is_some(),
                cfg!(target_os = "macos"),
                "{spoken:?}"
            );
        }
    }

    #[test]
    fn ordinary_command_mode_still_needs_the_prefix_for_every_command() {
        use crate::dictation_parity::DictationCommandAction as Action;
        assert_eq!(
            super::parse_dictation_command("command change the tone to formal", "command")
                .map(|(_, action)| action),
            Some(Action::ReplaceSelection {
                target: "the tone".into(),
                replacement: "formal".into(),
            })
        );
        assert_eq!(
            super::parse_dictation_command("command select Smyth", "command")
                .map(|(_, action)| action),
            Some(Action::SelectPhrase("Smyth".into()))
        );
        for spoken in [
            "change the tone to formal",
            "change Smith to Smyth",
            "append a closing line",
            "select Smyth",
            "undo that",
            "delete that",
            "new line",
            "make this more formal",
        ] {
            assert_eq!(
                super::parse_dictation_command(spoken, "command"),
                None,
                "{spoken:?}"
            );
        }
    }

    #[test]
    fn voice_edit_phrase_commands_that_find_nothing_are_refused_with_a_rewrite_hint() {
        use crate::dictation_parity::DictationCommandAction as Action;
        // Select never reaches the model, so a misheard phrase is refused.
        assert_eq!(
            super::parse_voice_edit_command("select the intro and make it formal", "command")
                .map(|(_, action)| action),
            Some(Action::SelectPhrase("the intro and make it formal".into()))
        );
        assert_eq!(
            super::parse_voice_edit_command("make this more formal", "command"),
            None
        );

        let select = Action::SelectPhrase("the intro".into());
        for error in [
            "That phrase was not found in the focused field.",
            "That phrase only appears inside a longer word. Say the whole word.",
        ] {
            let message = super::voice_edit_command_refusal(true, &select, error.into());
            assert!(message.starts_with(error), "{message}");
            assert!(message.contains("nothing was rewritten"), "{message}");
        }
        // Outside Voice Edit, for other refusals, and for payload commands,
        // which need the prefix and so match command mode, the reason stays.
        let swap = Action::ReplaceSelection {
            target: "tone".into(),
            replacement: "formal".into(),
        };
        for (mode, action, error) in [
            (
                true,
                &swap,
                "Replace Text could not find 'tone' in the current text.",
            ),
            (
                true,
                &Action::DeletePhrase("every adjective".into()),
                "That phrase was not found in the focused field.",
            ),
            (
                false,
                &select,
                "That phrase was not found in the focused field.",
            ),
            (
                true,
                &select,
                "That phrase occurs more than once. Say a longer phrase.",
            ),
            (
                true,
                &Action::DeleteThat,
                "No verified Plainsong insertion is available in this field.",
            ),
        ] {
            assert_eq!(
                super::voice_edit_command_refusal(mode, action, error.into()),
                error
            );
        }
    }

    #[test]
    fn deterministic_empty_command_results_never_recover_instruction_text() {
        for key in [
            "select_phrase",
            "move_to_start",
            "move_to_end",
            "delete_that",
            "delete_last_sentence",
            "replace_selection_text",
            "replace_selection",
            "uppercase_selection",
            "lowercase_selection",
            "sentence_case_selection",
            "title_case_selection",
            "append_to_selection",
            "prepend_to_selection",
            "delete_phrase",
            "delete_selection",
            "newline",
            "paragraph",
            "undo_last_insert",
        ] {
            assert_eq!(
                finalize_dictation_result_text("", "command delete that", Some(key)),
                "",
                "{key}"
            );
        }
        assert_eq!(
            dictation_done_message(
                "command_applied",
                true,
                false,
                &[],
                DictationDoneContext::default()
            ),
            "Voice edit applied."
        );
    }

    #[test]
    fn disabled_live_consent_never_reads_the_field() {
        let settings = manager(false);
        let (anchor, authority) = with_insertion_anchor_consent(&settings, None, || {
            panic!("disabled consent must not read field text")
        });
        assert_eq!(anchor, None::<()>);
        drop(authority);
        assert!(settings.try_lock().is_ok());
    }

    #[test]
    fn busy_settings_skip_optional_capture_without_waiting() {
        let settings = manager(true);
        let busy = settings.try_lock().unwrap();
        let (anchor, authority) = with_insertion_anchor_consent(&settings, None, || {
            panic!("busy settings must not read field text")
        });
        assert_eq!(anchor, None::<()>);
        assert!(authority.is_none());
        drop(busy);
    }

    #[test]
    fn existing_delivery_authority_is_reused_and_returned() {
        let settings = manager(true);
        let held = Arc::clone(&settings).try_lock_owned().unwrap();
        let (anchor, authority) = with_insertion_anchor_consent(&settings, Some(held), || {
            assert!(
                settings.try_lock().is_err(),
                "revocation must wait for the read"
            );
            Some("anchor")
        });
        assert_eq!(anchor, Some("anchor"));
        assert!(authority.is_some());
        assert!(
            settings.try_lock().is_err(),
            "delivery retains its authority"
        );
        drop(authority);
        assert!(settings.try_lock().is_ok());
    }

    #[test]
    fn live_authority_serializes_revocation_with_the_read() {
        let settings = manager(true);
        let (anchor, authority) = with_insertion_anchor_consent(&settings, None, || {
            assert!(
                settings.try_lock().is_err(),
                "revocation must wait for the read"
            );
            Some("anchor")
        });
        assert_eq!(anchor, Some("anchor"));
        drop(authority);
        settings
            .try_lock()
            .unwrap()
            .settings_mut()
            .transcription
            .dictation_learn_from_external_corrections = false;
        let (anchor, _) = with_insertion_anchor_consent(&settings, None, || {
            panic!("committed revocation must stop the next read")
        });
        assert_eq!(anchor, None::<()>);
    }
}

#[cfg(test)]
mod completed_dictation_persistence_tests {
    use super::{
        dictation_failure_event_belongs_to_overlay, discard_unvalidated_kept_audio,
        should_persist_completed_dictation, should_persist_failed_dictation_recovery,
    };
    use crate::recording_audio;

    #[test]
    fn history_requires_text_or_recoverable_audio() {
        assert!(should_persist_completed_dictation(
            true,
            "spoken words",
            false
        ));
        assert!(should_persist_completed_dictation(true, "", true));
        assert!(!should_persist_completed_dictation(true, "  \n ", false));
    }

    #[test]
    fn retention_privacy_gate_still_wins() {
        assert!(!should_persist_completed_dictation(
            false,
            "spoken words",
            false
        ));
        assert!(!should_persist_completed_dictation(false, "", true));
    }

    #[test]
    fn failed_recovery_requires_history_and_kept_audio_opt_ins() {
        assert!(should_persist_failed_dictation_recovery(
            true, "never", true
        ));
        assert!(should_persist_failed_dictation_recovery(true, "24h", true));
        assert!(!should_persist_failed_dictation_recovery(
            false, "never", true
        ));
        assert!(!should_persist_failed_dictation_recovery(
            true,
            "immediate",
            true
        ));
        assert!(!should_persist_failed_dictation_recovery(true, "off", true));
        assert!(!should_persist_failed_dictation_recovery(
            true, "never", false
        ));
    }

    #[test]
    fn failed_recovery_checks_session_ownership_before_writing_audio() {
        const SOURCE: &str = include_str!("dictation_session.rs");
        let start = SOURCE
            .find("async fn fail_dictation_stop_with_recovery(")
            .expect("failed recovery stop helper");
        let end = start
            + SOURCE[start..]
                .find("\nasync fn persist_failed_dictation_recovery(")
                .expect("failed recovery persistence helper");
        let body = &SOURCE[start..end];
        let ownership = body
            .find("reset_dictation_session_runtime_if_processing(")
            .expect("session ownership check");
        let stale_return = body
            .find("if !cleaned_current_session")
            .expect("stale session return");
        let persistence = body
            .find("persist_failed_dictation_recovery(")
            .expect("recovery persistence call");

        assert!(ownership < stale_return && stale_return < persistence);
    }

    #[test]
    fn stale_failure_event_cannot_replace_a_newer_overlay_session() {
        assert!(dictation_failure_event_belongs_to_overlay(Some(7), 7));
        assert!(dictation_failure_event_belongs_to_overlay(None, 7));
        assert!(!dictation_failure_event_belongs_to_overlay(Some(8), 7));
    }

    #[test]
    fn invalid_new_audio_is_removed_and_cleared() {
        let root = std::env::temp_dir().join(format!(
            "plainsong-invalid-kept-dictation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create fixture directory");
        let file = root.join("invalid.wav");
        std::fs::write(&file, b"not a wav").expect("write invalid fixture");
        let mut path = Some(file.clone());

        assert!(!matches!(
            recording_audio::validate_plaintext_wav(&file),
            recording_audio::RecordingAudioValidation::Ready(_)
        ));

        discard_unvalidated_kept_audio(&mut path).expect("discard invalid audio");

        assert!(path.is_none());
        assert!(!file.exists());
        std::fs::remove_dir_all(root).ok();
    }
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
        let function_body = |signature: &str| {
            let start = SOURCE.find(signature).expect("failure function exists");
            let end = start
                + SOURCE[start..]
                    .find("\n}\n")
                    .expect("failure function is closed");
            &SOURCE[start..end]
        };
        let wrapper = function_body("async fn fail_dictation_stop(");
        assert!(wrapper.contains(
            "finish_dictation_stop_failure(state, handle, context, fallback_reason, message).await"
        ));
        let finish = function_body("async fn finish_dictation_stop_failure(");
        let body = format!("{wrapper}\n{finish}");

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
    #[test]
    fn asides_never_create_searchable_dictation_history() {
        for save_to_inbox in [false, true] {
            for preset in ["immediate", "forever", "three_months"] {
                assert!(!super::dictation_history_requested_for_capture(
                    save_to_inbox,
                    preset,
                    true
                ));
                assert_eq!(
                    super::dictation_history_requested_for_capture(save_to_inbox, preset, false),
                    crate::retention::should_persist_dictation(save_to_inbox, preset)
                );
            }
        }
    }

    use super::{
        cancel_recent_dictation_result, dictation_history_final_text,
        forget_recent_dictation_results, link_recent_dictation_result_to_history,
        push_recent_dictation_result, recent_dictation_text_for_session,
        retire_resolved_command_recovery, select_recent_dictation_result,
        should_persist_completed_dictation, DictationRecoveryState, RecentDictationResult,
        RECENT_DICTATION_RESULT_LIMIT,
    };

    fn result(text: &str) -> RecentDictationResult {
        RecentDictationResult {
            state: DictationRecoveryState::Completed,
            owner_session_id: None,
            history_id: None,
            text: text.to_string(),
            app_target: None,
            app_bundle_id: None,
            at_ms: 0,
        }
    }

    #[test]
    fn quit_copy_reads_only_the_words_of_the_session_being_quit() {
        let mut results = Vec::new();
        let mut older = result("an earlier dictation");
        older.owner_session_id = Some(3);
        push_recent_dictation_result(&mut results, older);
        assert_eq!(recent_dictation_text_for_session(&results, 4), None);

        let mut raw = result("raw words");
        raw.state = DictationRecoveryState::Raw;
        raw.owner_session_id = Some(4);
        push_recent_dictation_result(&mut results, raw);
        assert_eq!(
            recent_dictation_text_for_session(&results, 4).as_deref(),
            Some("raw words")
        );

        cancel_recent_dictation_result(&mut results, 4);
        assert_eq!(recent_dictation_text_for_session(&results, 4), None);
    }

    #[test]
    fn deleting_a_history_entry_drops_its_recovery_result() {
        let mut results = Vec::new();
        push_recent_dictation_result(&mut results, result("kept"));
        let mut saved = result("deleted later");
        saved.owner_session_id = Some(7);
        push_recent_dictation_result(&mut results, saved);
        assert!(link_recent_dictation_result_to_history(
            &mut results,
            7,
            "history-7"
        ));

        assert!(!forget_recent_dictation_results(
            &mut results,
            &["other".to_string()]
        ));
        assert_eq!(results.len(), 2);
        assert!(forget_recent_dictation_results(
            &mut results,
            &["history-7".to_string()]
        ));
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "kept");
    }

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
        for (command, final_text) in [
            ("newline", "\n"),
            ("paragraph", "\n\n"),
            ("delete_selection", ""),
            ("delete_phrase", ""),
            ("undo_last_insert", ""),
            ("backtrack_undo_last_insert", ""),
        ] {
            let mut owned = result("same command words");
            owned.owner_session_id = Some(7);
            let mut other = owned.clone();
            other.owner_session_id = Some(8);
            let staged = result("same command words");
            let mut rows = vec![owned.clone(), other, staged];
            assert!(!retire_resolved_command_recovery(
                &mut rows,
                7,
                "ordinary prose",
                None
            ));
            assert_eq!(rows.len(), 3);
            assert!(retire_resolved_command_recovery(
                &mut rows,
                7,
                final_text,
                Some(command)
            ));
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].owner_session_id, Some(8));
            assert_eq!(rows[1].owner_session_id, None);
            assert!(rows.iter().all(|row| row.text == "same command words"));
            assert!(!retire_resolved_command_recovery(
                &mut rows,
                7,
                final_text,
                Some(command)
            ));
            let raw = "same command words";
            assert_eq!(
                dictation_history_final_text(final_text, raw, Some(command)),
                final_text
            );
            assert!(should_persist_completed_dictation(true, raw, false));
            assert!(!should_persist_completed_dictation(false, raw, false));
        }
        assert_eq!(
            dictation_history_final_text("", "original words", None),
            "original words"
        );
        assert_eq!(
            dictation_history_final_text("new words", "original words", None),
            "new words"
        );
    }

    #[test]
    fn hotkey_skips_inflight_and_cancelled_raw_but_tray_can_recover_it() {
        let mut a = result("A final bytes.\n");
        a.owner_session_id = Some(1);
        let mut b = result("B raw words");
        b.owner_session_id = Some(2);
        b.state = DictationRecoveryState::Raw;
        let mut rows = vec![a];
        push_recent_dictation_result(&mut rows, b);
        let shortcut = serde_json::json!({ "completedOnly": true });
        assert_eq!(
            select_recent_dictation_result(&rows, &shortcut)
                .unwrap()
                .text,
            "A final bytes.\n"
        );
        cancel_recent_dictation_result(&mut rows, 2);
        assert_eq!(rows[0].text, "B raw words");
        assert_eq!(rows[0].state, DictationRecoveryState::Cancelled);
        assert_eq!(
            select_recent_dictation_result(&rows, &shortcut)
                .unwrap()
                .text,
            "A final bytes.\n"
        );
        let tray = serde_json::json!({ "index": 0, "expectedText": "B raw words" });
        assert_eq!(
            select_recent_dictation_result(&rows, &tray).unwrap().text,
            "B raw words"
        );
        assert!(select_recent_dictation_result(
            &rows,
            &serde_json::json!({ "index": 0, "expectedText": "old menu" })
        )
        .is_err());
        let mut late = result("B late final");
        late.owner_session_id = Some(2);
        push_recent_dictation_result(&mut rows, late);
        assert_eq!(rows[0].text, "B raw words");
        assert_eq!(rows.len(), 2);
        assert!(select_recent_dictation_result(&rows[..1], &shortcut).is_err());
    }

    #[test]
    fn final_publication_replaces_only_its_owned_raw_row() {
        for final_text in ["B raw words", "B polished bytes.\n"] {
            let mut a = result("A final");
            a.owner_session_id = Some(1);
            let mut raw = result("B raw words");
            raw.owner_session_id = Some(2);
            raw.state = DictationRecoveryState::Raw;
            let mut rows = vec![a];
            push_recent_dictation_result(&mut rows, raw);
            let mut completed = result(final_text);
            completed.owner_session_id = Some(2);
            push_recent_dictation_result(&mut rows, completed.clone());
            push_recent_dictation_result(&mut rows, completed);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].owner_session_id, Some(2));
            assert_eq!(rows[0].text, final_text);
            assert_eq!(rows[1].text, "A final");
            assert_eq!(
                select_recent_dictation_result(
                    &rows,
                    &serde_json::json!({ "completedOnly": true })
                )
                .unwrap()
                .text,
                final_text
            );
        }
    }

    #[test]
    fn recovery_ownership_is_not_serialized() {
        let mut row = result("words");
        row.owner_session_id = Some(7);
        let value = serde_json::to_value(&row).unwrap();
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, ["appBundleId", "appTarget", "atMs", "text"]);
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
            .split("let outcome = crate::text_insert::paste_manual_current(")
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

#[cfg(test)]
mod startup_cancellation_tests {
    use super::*;

    #[test]
    fn cancelled_or_replaced_sessions_cannot_publish_capture_ready_or_success() {
        let mut tracker = DictationSessionTracker {
            active_session_id: Some(8),
            ..Default::default()
        };
        assert!(dictation_start_matches(
            &tracker,
            DictationSessionState::Recording,
            8,
            DictationSessionState::Recording
        ));
        assert!(!dictation_start_matches(
            &tracker,
            DictationSessionState::Idle,
            8,
            DictationSessionState::Recording
        ));
        assert!(!dictation_start_matches(
            &tracker,
            DictationSessionState::Recording,
            7,
            DictationSessionState::Recording
        ));
        tracker.stopping_session_id = Some(8);
        assert!(!dictation_start_matches(
            &tracker,
            DictationSessionState::Recording,
            8,
            DictationSessionState::Recording
        ));
        tracker.active_session_id = None;
        assert!(!dictation_start_matches(
            &tracker,
            DictationSessionState::Recording,
            8,
            DictationSessionState::Recording
        ));
    }

    #[tokio::test]
    async fn an_old_warmup_cannot_prime_a_replacement_session() {
        let runtime = Mutex::new(DictationSessionState::Starting);
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(2),
            ..Default::default()
        });
        assert!(!prime_dictation_start_if_current(&runtime, &tracker, 1).await);
        assert_eq!(*runtime.lock().await, DictationSessionState::Starting);
        assert!(prime_dictation_start_if_current(&runtime, &tracker, 2).await);
        assert_eq!(*runtime.lock().await, DictationSessionState::Primed);
        assert!(!prime_dictation_start_if_current(&runtime, &tracker, 1).await);
        assert_eq!(tracker.lock().await.active_session_id, Some(2));
    }

    #[tokio::test]
    async fn a_claimed_cancel_prevents_priming_before_audio_cleanup_resets_the_session() {
        let runtime = Mutex::new(DictationSessionState::Starting);
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(7),
            stopping_session_id: Some(7),
            ..Default::default()
        });
        assert!(!prime_dictation_start_if_current(&runtime, &tracker, 7).await);
        assert_eq!(*runtime.lock().await, DictationSessionState::Starting);
    }

    #[tokio::test]
    async fn cancellation_before_claim_commit_leaves_runtime_idle_and_no_session() {
        let runtime = Arc::new(Mutex::new(DictationSessionState::Idle));
        let tracker = Arc::new(Mutex::new(DictationSessionTracker::default()));
        let options = Arc::new(Mutex::new(models::DictationStartOptions::default()));
        let held_options = options.lock().await;
        let r = Arc::clone(&runtime);
        let t = Arc::clone(&tracker);
        let o = Arc::clone(&options);
        let task = tokio::spawn(async move {
            claim_dictation_start_session(
                &r,
                &t,
                &o,
                &models::DictationStartOptions::default(),
                100,
                DictationInsertionMode::from_settings_value("preview"),
                false,
            )
            .await
        });
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        drop(held_options);
        assert_eq!(*runtime.lock().await, DictationSessionState::Idle);
        assert_eq!(tracker.lock().await.active_session_id, None);
        assert_eq!(tracker.lock().await.next_session_id, 0);
    }

    #[tokio::test]
    async fn aborted_claimed_start_runs_scoped_reset_and_allows_the_next_session() {
        let runtime = Arc::new(Mutex::new(DictationSessionState::Idle));
        let tracker = Arc::new(Mutex::new(DictationSessionTracker::default()));
        let options = Arc::new(Mutex::new(models::DictationStartOptions::default()));
        let r = Arc::clone(&runtime);
        let t = Arc::clone(&tracker);
        let o = Arc::clone(&options);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cleaned_tx, cleaned_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let requested = models::DictationStartOptions {
                context_app_name: Some("Fixture editor".to_string()),
                ..Default::default()
            };
            let id = claim_dictation_start_session(
                &r,
                &t,
                &o,
                &requested,
                100,
                DictationInsertionMode::from_settings_value("preview"),
                false,
            )
            .await
            .unwrap();
            let _guard = UnfinishedDictationStart {
                after_commit: None,
                rollback: Some(Box::new(move || {
                    tokio::spawn(async move {
                        let reset =
                            reset_dictation_session_runtime_if_current(&r, &t, &o, id).await;
                        cleaned_tx.send(reset).unwrap();
                    });
                })),
            };
            started_tx.send(id).unwrap();
            std::future::pending::<()>().await;
        });
        assert_eq!(started_rx.await.unwrap(), 1);
        assert_eq!(*runtime.lock().await, DictationSessionState::Starting);
        assert_eq!(
            options.lock().await.context_app_name.as_deref(),
            Some("Fixture editor")
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(cleaned_rx.await.unwrap());
        assert_eq!(*runtime.lock().await, DictationSessionState::Idle);
        assert_eq!(tracker.lock().await.active_session_id, None);
        assert_eq!(options.lock().await.context_app_name, None);
        let next = claim_dictation_start_session(
            &runtime,
            &tracker,
            &options,
            &models::DictationStartOptions::default(),
            200,
            DictationInsertionMode::from_settings_value("preview"),
            false,
        )
        .await
        .unwrap();
        assert_eq!(next, 2);
        assert_eq!(tracker.lock().await.active_session_id, Some(2));
    }

    #[test]
    fn successful_start_disarms_rollback() {
        let called = Arc::new(AtomicBool::new(false));
        let callback = Arc::clone(&called);
        let mut guard = UnfinishedDictationStart {
            after_commit: None,
            rollback: Some(Box::new(move || {
                callback.store(true, Ordering::SeqCst);
            })),
        };
        guard.rollback = None;
        drop(guard);
        assert!(!called.load(Ordering::SeqCst));
    }
}

#[cfg(test)]
mod live_delivery_tests {
    use super::*;

    fn refused(error: &str) -> PasteOutcome {
        delivery_refusal_outcome(error.to_string())
    }

    #[test]
    fn a_refused_delivery_with_an_untouched_clipboard_is_copied() {
        let outcome = refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE);
        assert!(refused_delivery_needs_clipboard_copy(&outcome, true, false));
    }

    #[test]
    fn the_fallback_never_overrides_success_secure_fields_user_copies_or_empty_text() {
        let mut pasted = refused("unconfirmed");
        pasted.pasted = true;
        assert!(!refused_delivery_needs_clipboard_copy(&pasted, true, false));

        let mut copied = refused("copied already");
        copied.copied = true;
        assert!(!refused_delivery_needs_clipboard_copy(&copied, true, false));

        let secure = secure_field_refusal_outcome(
            dictation_secure_field::SecureFieldSignal::SecureTextFieldRole,
        );
        assert!(!refused_delivery_needs_clipboard_copy(&secure, true, false));

        // The clipboard changed during delivery: the user's copy wins.
        let outcome = refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE);
        assert!(!refused_delivery_needs_clipboard_copy(
            &outcome, false, false
        ));
        assert!(!refused_delivery_needs_clipboard_copy(&outcome, true, true));

        // No error means nothing was attempted (e.g. an empty command result).
        let mut silent = refused("x");
        silent.error = None;
        assert!(!refused_delivery_needs_clipboard_copy(&silent, true, false));
    }

    #[test]
    fn the_fallback_copies_the_words_and_keeps_the_reason() {
        let mut copied_text = None;
        let (outcome, kept) = clipboard_fallback_for_refused_delivery(
            refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE),
            "Meet at 3, not 4.",
            || None,
            || true,
            |text| {
                copied_text = Some(text.to_string());
                Ok(())
            },
        );
        assert!(!kept);
        assert_eq!(copied_text.as_deref(), Some("Meet at 3, not 4."));
        assert!(outcome.copied && !outcome.pasted);
        assert_eq!(
            outcome.error.as_deref(),
            Some(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE)
        );
        assert_eq!(
            resolve_dictation_delivery_outcome(DictationDeliveryFacts {
                pasted: outcome.pasted,
                copied: outcome.copied,
                confirmed: outcome.confirmed,
                undo_performed: false,
                secure_field_refused: outcome.secure_field.is_some(),
                newer_clipboard_kept: false,
                has_paste_error: outcome.error.is_some(),
                clipboard_requested: false,
                previous: "",
            }),
            "copied_instead"
        );
    }

    #[test]
    fn the_fallback_rechecks_for_a_secure_field_before_copying() {
        let (outcome, kept) = clipboard_fallback_for_refused_delivery(
            refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE),
            "hunter2",
            || Some(dictation_secure_field::SecureFieldSignal::SecureEventInput),
            || true,
            |_| panic!("a secure field in front must not receive a clipboard copy"),
        );
        assert!(!kept);
        assert!(!outcome.copied);
        assert!(outcome.secure_field.is_some());
    }

    #[test]
    fn a_copy_made_during_the_fallback_is_kept_and_reported() {
        // The user copied something between the first clipboard check and
        // the copy itself. Their copy wins, and the session says so instead
        // of reporting a generic failure.
        let (outcome, kept) = clipboard_fallback_for_refused_delivery(
            refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE),
            "Meet at 3, not 4.",
            || None,
            || false,
            |_| panic!("a newer user clipboard must not be overwritten"),
        );
        assert!(kept);
        assert!(!outcome.copied && !outcome.pasted);
        assert_eq!(
            resolve_dictation_delivery_outcome(DictationDeliveryFacts {
                pasted: false,
                copied: false,
                confirmed: false,
                undo_performed: false,
                secure_field_refused: false,
                newer_clipboard_kept: kept,
                has_paste_error: outcome.error.is_some(),
                clipboard_requested: false,
                previous: "error",
            }),
            NEWER_CLIPBOARD_KEPT_OUTCOME
        );
    }

    #[test]
    fn a_kept_clipboard_says_where_the_words_are_without_cmd_v() {
        let saved = dictation_done_message(
            NEWER_CLIPBOARD_KEPT_OUTCOME,
            false,
            false,
            &[],
            DictationDoneContext {
                app: Some("Notes"),
                ..DictationDoneContext::default()
            },
        );
        assert!(saved.starts_with("Not inserted into Notes."), "{saved}");
        assert!(saved.contains("left alone"), "{saved}");
        assert!(saved.contains("dictation history"), "{saved}");
        assert!(!saved.contains("Cmd+V"), "{saved}");
        let history_off = dictation_done_message(
            NEWER_CLIPBOARD_KEPT_OUTCOME,
            false,
            false,
            &[],
            DictationDoneContext {
                history_off: true,
                ..DictationDoneContext::default()
            },
        );
        assert!(history_off.contains("Recent dictations"), "{history_off}");
        assert!(!history_off.contains("dictation history"), "{history_off}");
        assert_eq!(
            dictation_overlay_idle_reset_delay_ms(NEWER_CLIPBOARD_KEPT_OUTCOME),
            DICTATION_IDLE_RESET_ERROR_MS
        );
    }

    #[test]
    fn a_user_copy_before_the_fallback_is_kept_rather_than_failed() {
        let outcome = refused(crate::text_insert::DICTATION_FOCUS_CHANGED_MESSAGE);
        assert!(refused_delivery_kept_newer_clipboard(
            &outcome, false, false
        ));
        assert!(!refused_delivery_kept_newer_clipboard(
            &outcome, true, false
        ));
        // Nothing to keep the clipboard from: no words, or a secure field.
        assert!(!refused_delivery_kept_newer_clipboard(
            &outcome, false, true
        ));
        let secure = secure_field_refusal_outcome(
            dictation_secure_field::SecureFieldSignal::SecureTextFieldRole,
        );
        assert!(!refused_delivery_kept_newer_clipboard(
            &secure, false, false
        ));
    }

    #[test]
    fn recovery_location_is_reported_apart_from_the_outcome() {
        // An unverified paste with the words retained on the clipboard and one
        // without them share an outcome; only the location differs.
        assert_eq!(
            dictation_recovery_location(true, false, true),
            Some("clipboard")
        );
        assert_eq!(
            dictation_recovery_location(false, false, true),
            Some("history")
        );
        assert_eq!(
            dictation_recovery_location(false, false, false),
            Some("recent_dictations")
        );
        assert_eq!(dictation_recovery_location(false, true, true), None);
    }

    #[test]
    fn a_missing_field_fingerprint_goes_through_the_clipboard_fallback() {
        // `OriginalAutoDelivery::capture` refuses without a usable field
        // identity. That refusal has to reach the same fallback as any other
        // refused delivery instead of ending as a bare error.
        let source = include_str!("dictation_session.rs");
        let start = source
            .find("} else if let Some(error) = automatic_delivery_error {")
            .expect("the missing-fingerprint branch exists");
        let branch = &source[start..start + 2400];
        assert!(branch.contains("claim_dictation_delivery("), "{branch}");
        assert!(
            branch.contains("apply_refused_delivery_fallback("),
            "{branch}"
        );
    }

    #[test]
    fn a_failed_fallback_copy_says_so_and_claims_nothing() {
        let (outcome, _) = clipboard_fallback_for_refused_delivery(
            refused("Focus changed."),
            "words",
            || None,
            || true,
            |_| Err("pbcopy exited with failure status".to_string()),
        );
        assert!(!outcome.copied && !outcome.pasted);
        assert_eq!(
            outcome.error.as_deref(),
            Some("Focus changed. Clipboard copy also failed: pbcopy exited with failure status")
        );
    }
    #[test]
    fn preview_delivery_overrides_saved_insertion_without_changing_settings() {
        for saved in ["auto", "clipboard_only", "paste"] {
            assert_eq!(
                live_dictation_insertion_mode(saved, models::DictationDeliveryMode::Preview),
                "preview"
            );
        }
        assert_eq!(
            live_dictation_insertion_mode("clipboard_only", models::DictationDeliveryMode::System),
            "clipboard_only"
        );
        assert_eq!(
            live_dictation_insertion_mode("paste", models::DictationDeliveryMode::System),
            "auto"
        );
    }
}

#[cfg(test)]
mod processing_cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn command_owned_stage_never_starts_cancelled_or_replaced_work() {
        for replaced in [false, true] {
            let tracker = Mutex::new(DictationSessionTracker {
                active_session_id: Some(if replaced { 8 } else { 7 }),
                cancellation_requested_session_id: (!replaced).then_some(7),
                ..Default::default()
            });
            let result = run_owned_dictation_stage_with_tracker(&tracker, 7, async {
                panic!("disowned session must not start selection read or command execution");
            })
            .await;
            assert_eq!(result, None::<()>);
        }
    }

    #[tokio::test]
    async fn command_owned_stage_drops_read_result_after_cancel_or_replacement() {
        for replaced in [false, true] {
            let tracker = Mutex::new(DictationSessionTracker {
                active_session_id: Some(7),
                ..Default::default()
            });
            let result = run_owned_dictation_stage_with_tracker(&tracker, 7, async {
                let mut current = tracker.lock().await;
                if replaced {
                    current.active_session_id = Some(8);
                } else {
                    claim_dictation_cancellation(&mut current, Some(7)).unwrap();
                }
                "selection read completed"
            })
            .await;
            assert_eq!(result, None);
            assert_eq!(
                run_owned_dictation_stage_with_tracker(&tracker, 7, async {
                    panic!("disowned command must never execute");
                })
                .await,
                None::<()>
            );
        }
    }

    #[test]
    fn only_current_claimed_delivery_can_publish_after_completion() {
        let mut tracker = DictationSessionTracker {
            next_session_id: 7,
            active_session_id: Some(7),
            ..Default::default()
        };
        assert!(!dictation_delivery_may_publish(&tracker, 7));
        assert!(claim_dictation_delivery(&mut tracker, 7));
        assert!(dictation_delivery_may_publish(&tracker, 7));
        assert!(!dictation_delivery_may_publish(&tracker, 8));
        tracker.reset_for_app_state();
        assert!(!dictation_delivery_may_publish(&tracker, 7));
        tracker.active_session_id = Some(8);
        tracker.delivery_started_session_id = Some(8);
        assert!(dictation_delivery_may_publish(&tracker, 8));
        assert!(!dictation_delivery_may_publish(&tracker, 7));
        tracker.cancellation_requested_session_id = Some(8);
        assert!(!dictation_delivery_may_publish(&tracker, 8));
    }

    #[test]
    fn cancellation_claim_disowns_processing_before_runtime_cleanup() {
        let mut tracker = DictationSessionTracker {
            active_session_id: Some(7),
            stopping_session_id: Some(7),
            ..Default::default()
        };
        assert!(dictation_processing_owned_by(&tracker, 7));
        assert_eq!(claim_dictation_cancellation(&mut tracker, Some(7)), Ok(7));
        assert_eq!(tracker.active_session_id, Some(7));
        assert!(!dictation_processing_owned_by(&tracker, 7));
    }

    #[test]
    fn stale_cancellation_cannot_disown_a_newer_session() {
        let mut tracker = DictationSessionTracker {
            active_session_id: Some(8),
            ..Default::default()
        };
        assert!(claim_dictation_cancellation(&mut tracker, Some(7)).is_err());
        assert!(dictation_processing_owned_by(&tracker, 8));
        assert_eq!(tracker.cancellation_requested_session_id, None);
    }

    #[test]
    fn cancellation_and_delivery_have_one_ordered_boundary() {
        let mut cancelled = DictationSessionTracker {
            active_session_id: Some(7),
            ..Default::default()
        };
        assert_eq!(claim_dictation_cancellation(&mut cancelled, Some(7)), Ok(7));
        assert!(!claim_dictation_delivery(&mut cancelled, 7));
        let mut delivering = DictationSessionTracker {
            active_session_id: Some(8),
            ..Default::default()
        };
        assert!(claim_dictation_delivery(&mut delivering, 8));
        assert!(claim_dictation_cancellation(&mut delivering, Some(8)).is_err());
        assert_eq!(delivering.cancellation_requested_session_id, None);
        assert_eq!(delivering.active_session_id, Some(8));
    }

    #[tokio::test]
    async fn recovery_reset_preserves_a_claimed_cancellation() {
        let runtime = Mutex::new(DictationSessionState::Starting);
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(7),
            stopping_session_id: Some(7),
            cancellation_requested_session_id: Some(7),
            ..Default::default()
        });
        let options = Mutex::new(models::DictationStartOptions {
            project_id: Some("keep-until-discard".into()),
            ..Default::default()
        });
        assert!(
            !reset_dictation_session_runtime_if_processing(&runtime, &tracker, &options, 7).await
        );
        assert_eq!(*runtime.lock().await, DictationSessionState::Starting);
        assert_eq!(
            tracker.lock().await.cancellation_requested_session_id,
            Some(7)
        );
        assert_eq!(
            options.lock().await.project_id.as_deref(),
            Some("keep-until-discard")
        );
        assert!(reset_dictation_session_runtime_if_current(&runtime, &tracker, &options, 7).await);
        assert_eq!(*runtime.lock().await, DictationSessionState::Idle);
    }

    #[tokio::test]
    async fn recovery_reset_rejects_stale_and_delivered_sessions() {
        for (active, delivered) in [(Some(8), None), (Some(7), Some(7))] {
            let runtime = Mutex::new(DictationSessionState::Starting);
            let tracker = Mutex::new(DictationSessionTracker {
                active_session_id: active,
                delivery_started_session_id: delivered,
                ..Default::default()
            });
            let options = Mutex::new(models::DictationStartOptions::default());
            assert!(
                !reset_dictation_session_runtime_if_processing(&runtime, &tracker, &options, 7)
                    .await
            );
            assert_eq!(tracker.lock().await.active_session_id, active);
            assert_eq!(*runtime.lock().await, DictationSessionState::Starting);
        }
    }

    #[tokio::test]
    async fn recovery_reset_claims_current_processing_session() {
        let runtime = Mutex::new(DictationSessionState::Starting);
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(7),
            stopping_session_id: Some(7),
            ..Default::default()
        });
        let options = Mutex::new(models::DictationStartOptions {
            project_id: Some("custom-project".into()),
            ..Default::default()
        });
        assert!(
            reset_dictation_session_runtime_if_processing(&runtime, &tracker, &options, 7).await
        );
        assert_eq!(*runtime.lock().await, DictationSessionState::Idle);
        assert_eq!(tracker.lock().await.active_session_id, None);
        assert_eq!(options.lock().await.project_id.as_deref(), Some("inbox"));
    }

    #[tokio::test]
    async fn scoped_reset_clears_cancellation_without_resetting_newer_sessions() {
        let runtime = Mutex::new(DictationSessionState::Starting);
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(8),
            cancellation_requested_session_id: Some(7),
            ..Default::default()
        });
        let options = Mutex::new(models::DictationStartOptions::default());
        assert!(!reset_dictation_session_runtime_if_current(&runtime, &tracker, &options, 7).await);
        assert_eq!(tracker.lock().await.active_session_id, Some(8));
        assert!(reset_dictation_session_runtime_if_current(&runtime, &tracker, &options, 8).await);
        assert_eq!(tracker.lock().await.cancellation_requested_session_id, None);
    }
}

#[cfg(test)]
mod late_field_context_tests {
    use super::*;

    fn fixture() -> (
        Mutex<DictationSessionTracker>,
        Mutex<DictationSessionState>,
        Mutex<models::DictationStartOptions>,
        models::DictationStartOptions,
    ) {
        let expected = models::DictationStartOptions {
            context_source: "selected_text".into(),
            context_app_name: Some("Fixture editor".into()),
            context_app_bundle_id: Some("test.editor".into()),
            actual_provider: Some("parakeet".into()),
            actual_model_id: Some("fixture".into()),
            resolved_route: Some("parakeet/fixture".into()),
            ..Default::default()
        };
        (
            Mutex::new(DictationSessionTracker {
                active_session_id: Some(7),
                ..Default::default()
            }),
            Mutex::new(DictationSessionState::Recording),
            Mutex::new(expected.clone()),
            expected,
        )
    }

    #[tokio::test]
    async fn late_field_context_commits_only_text_and_bounds_unicode() {
        let (tracker, runtime, options, expected) = fixture();
        assert!(
            commit_owned_dictation_field_context(
                &tracker,
                &runtime,
                &options,
                7,
                &expected,
                &format!("  {}  ", "字".repeat(5000)),
                || true
            )
            .await
        );
        let actual = options.lock().await;
        assert_eq!(
            actual
                .captured_context_text
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            4000
        );
        assert_eq!(actual.actual_provider, expected.actual_provider);
        assert_eq!(actual.actual_model_id, expected.actual_model_id);
        assert_eq!(actual.resolved_route, expected.resolved_route);
        assert_eq!(actual.context_app_name, expected.context_app_name);
        assert_eq!(
            actual.mode_override.as_ref().map(|value| &value.preset),
            expected.mode_override.as_ref().map(|value| &value.preset)
        );
    }

    #[tokio::test]
    async fn late_field_context_stop_cancel_and_replacement_veto() {
        for veto in 0..5 {
            let (tracker, runtime, options, expected) = fixture();
            {
                let mut tracker = tracker.lock().await;
                match veto {
                    0 => tracker.stopping_session_id = Some(7),
                    1 => tracker.cancellation_requested_session_id = Some(7),
                    2 => tracker.active_session_id = Some(8),
                    3 => tracker.delivery_started_session_id = Some(7),
                    _ => *runtime.lock().await = DictationSessionState::Idle,
                }
            }
            assert!(
                !commit_owned_dictation_field_context(
                    &tracker,
                    &runtime,
                    &options,
                    7,
                    &expected,
                    "selected",
                    || true
                )
                .await
            );
            assert!(options.lock().await.captured_context_text.is_none());
        }
    }

    #[tokio::test]
    async fn late_field_context_existing_source_target_or_route_changes_veto() {
        for veto in 0..6 {
            let (tracker, runtime, options, expected) = fixture();
            {
                let mut options = options.lock().await;
                match veto {
                    0 => options.captured_context_text = Some("Provided context".into()),
                    1 => options.context_source = "none".into(),
                    2 => options.context_app_name = Some("Another editor".into()),
                    3 => options.context_app_bundle_id = Some("test.another".into()),
                    4 => options.resolved_route = Some("another/route".into()),
                    _ => options.actual_model_id = Some("another-model".into()),
                }
            }
            assert!(
                !commit_owned_dictation_field_context(
                    &tracker,
                    &runtime,
                    &options,
                    7,
                    &expected,
                    "selected",
                    || true
                )
                .await
            );
            assert_ne!(
                options.lock().await.captured_context_text.as_deref(),
                Some("selected")
            );
        }
    }

    #[tokio::test]
    async fn late_field_context_invalidated_or_empty_reads_veto() {
        let (tracker, runtime, options, expected) = fixture();
        assert!(
            !commit_owned_dictation_field_context(
                &tracker,
                &runtime,
                &options,
                7,
                &expected,
                "selected",
                || false
            )
            .await
        );
        assert!(
            !commit_owned_dictation_field_context(
                &tracker,
                &runtime,
                &options,
                7,
                &expected,
                " \n ",
                || true
            )
            .await
        );
        assert!(options.lock().await.captured_context_text.is_none());
    }

    #[tokio::test]
    async fn late_field_context_stop_freezes_before_delayed_result_without_waiting() {
        let (tracker, runtime, options, expected) = fixture();
        let tracker = Arc::new(tracker);
        let runtime = Arc::new(runtime);
        let options = Arc::new(options);
        let (reader_started, started) = tokio::sync::oneshot::channel();
        let (finish_read, read) = tokio::sync::oneshot::channel();
        let task = {
            let tracker = Arc::clone(&tracker);
            let runtime = Arc::clone(&runtime);
            let options = Arc::clone(&options);
            tokio::spawn(async move {
                let _ = reader_started.send(());
                let _ = read.await;
                commit_owned_dictation_field_context(
                    &tracker,
                    &runtime,
                    &options,
                    7,
                    &expected,
                    "late selection",
                    || true,
                )
                .await
            })
        };
        started.await.unwrap();
        assert_eq!(*runtime.lock().await, DictationSessionState::Recording);
        tracker.lock().await.stopping_session_id = Some(7);
        assert!(options.lock().await.clone().captured_context_text.is_none());
        finish_read.send(()).unwrap();
        assert!(!task.await.unwrap());
    }

    #[tokio::test]
    async fn late_field_context_none_clipboard_and_supplied_options_are_not_replaced() {
        for source in ["none", "clipboard", "selected_text"] {
            let (tracker, runtime, options, mut expected) = fixture();
            expected.context_source = source.into();
            if source == "selected_text" {
                expected.captured_context_text = Some("Supplied context".into());
            }
            *options.lock().await = expected.clone();
            assert!(
                !commit_owned_dictation_field_context(
                    &tracker,
                    &runtime,
                    &options,
                    7,
                    &expected,
                    "late selection",
                    || true
                )
                .await
            );
            assert_eq!(
                options.lock().await.captured_context_text,
                expected.captured_context_text
            );
        }
    }

    #[test]
    fn selection_startup_revision_retains_revocation_before_owner_publication() {
        let revision = std::sync::atomic::AtomicU64::new(0);
        let initial = settings::Settings::default();
        let expected = revision.load(Ordering::Acquire);
        let mut unrelated = initial.clone();
        unrelated.ui.always_on_top = !unrelated.ui.always_on_top;
        advance_selection_policy_revision(&revision, &initial, &unrelated);
        assert!(selection_start_policy_is_current(&revision, expected));
        let mut revoked = initial.clone();
        revoked.transcription.dictation_context_source = "clipboard".into();
        advance_selection_policy_revision(&revision, &initial, &revoked);
        advance_selection_policy_revision(&revision, &revoked, &initial);
        assert!(!selection_start_policy_is_current(&revision, expected));
        let expected = revision.load(Ordering::Acquire);
        let mut bound = initial.clone();
        bound
            .transcription
            .dictation_custom_modes
            .push(settings::DictationCustomMode {
                id: "bound".into(),
                context_source: "selected_text".into(),
                voice_edit: true,
                ..Default::default()
            });
        advance_selection_policy_revision(&revision, &initial, &bound);
        advance_selection_policy_revision(&revision, &bound, &initial);
        assert!(!selection_start_policy_is_current(&revision, expected));
    }

    #[test]
    fn selection_settings_transition_detects_revoke_restore_and_preserves_unrelated_changes() {
        let previous = settings::Settings::default();
        let options = models::DictationStartOptions::default();
        let mut candidate = previous.clone();
        candidate.transcription.dictation_context_source = "selected_text".into();
        let mut valid = true;
        valid &= !selection_consent_transition_revokes(&previous, &candidate, &options);
        valid &= !selection_consent_transition_revokes(&candidate, &previous, &options);
        assert!(!valid);
        let mut command_change = previous.clone();
        command_change.transcription.dictation_command_mode_enabled =
            !previous.transcription.dictation_command_mode_enabled;
        assert!(selection_consent_transition_revokes(
            &previous,
            &command_change,
            &options
        ));
        let mut prefix_change = previous.clone();
        prefix_change
            .transcription
            .dictation_command_prefix
            .push_str(" changed");
        assert!(selection_consent_transition_revokes(
            &previous,
            &prefix_change,
            &options
        ));
        let mut remote_allowed = previous.clone();
        remote_allowed.privacy.remote_processing_enabled = true;
        let mut remote_revoked = remote_allowed.clone();
        remote_revoked.privacy.remote_processing_enabled = false;
        assert!(selection_consent_transition_revokes(
            &remote_allowed,
            &remote_revoked,
            &options
        ));
        let mut unrelated = previous.clone();
        unrelated.ui.color_scheme = "dark".into();
        assert!(!selection_consent_transition_revokes(
            &previous, &unrelated, &options
        ));
    }

    #[test]
    fn late_field_context_starts_only_after_owned_start_commit() {
        for commit in [false, true] {
            let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = Arc::clone(&starts);
            let mut guard = UnfinishedDictationStart {
                rollback: None,
                after_commit: Some(Box::new(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                })),
            };
            assert_eq!(starts.load(Ordering::SeqCst), 0);
            if commit {
                guard.disarm();
                guard.disarm();
            }
            drop(guard);
            assert_eq!(starts.load(Ordering::SeqCst), usize::from(commit));
        }
    }

    #[test]
    fn late_field_context_bound_mode_context_edits_revoke_consent_without_changing_route() {
        let mut settings = settings::Settings::default();
        settings.transcription.dictation_custom_modes = vec![settings::DictationCustomMode {
            id: "bound".into(),
            context_source: "selected_text".into(),
            ..Default::default()
        }];
        let options = models::DictationStartOptions {
            mode_override: Some(models::DictationSessionModeOverride {
                preset: "custom".into(),
                custom_mode_id: Some("bound".into()),
            }),
            actual_provider: Some("parakeet".into()),
            ..Default::default()
        };
        let baseline = DictationFieldContextConsent::capture(&settings, &options);
        settings.transcription.dictation_custom_modes[0].context_source = "none".into();
        assert!(!baseline.permits(DictationFieldContextConsent::capture(&settings, &options)));
        assert_eq!(options.actual_provider.as_deref(), Some("parakeet"));
    }

    #[test]
    fn late_field_context_voice_edit_revocation_vetoes_same_profile() {
        let mut settings = settings::Settings::default();
        settings.transcription.dictation_selected_custom_mode_id = Some("edit".into());
        settings.transcription.dictation_custom_modes = vec![settings::DictationCustomMode {
            id: "edit".into(),
            voice_edit: true,
            context_source: "selected_text".into(),
            ..Default::default()
        }];
        let options = models::DictationStartOptions::default();
        let consent = DictationFieldContextConsent::capture(&settings, &options);
        assert!(consent.permits(DictationFieldContextConsent::capture(&settings, &options)));
        settings.transcription.dictation_custom_modes[0].voice_edit = false;
        assert!(!consent.permits(DictationFieldContextConsent::capture(&settings, &options)));
    }

    #[test]
    fn late_field_context_consent_changes_and_remote_revocation_veto() {
        let settings = settings::Settings::default();
        let options = models::DictationStartOptions::default();
        let baseline = DictationFieldContextConsent::capture(&settings, &options);
        assert!(baseline.permits(DictationFieldContextConsent::capture(&settings, &options)));
        let mut changed = settings.clone();
        changed.transcription.dictation_context_source = "clipboard".into();
        assert!(!baseline.permits(DictationFieldContextConsent::capture(&changed, &options)));
        let mut changed = settings.clone();
        changed.transcription.dictation_mode_preset = "email".into();
        assert!(!baseline.permits(DictationFieldContextConsent::capture(&changed, &options)));
        let mut allowed = settings.clone();
        allowed.privacy.remote_processing_enabled = true;
        let baseline = DictationFieldContextConsent::capture(&allowed, &options);
        assert!(!baseline.permits(DictationFieldContextConsent::capture(&settings, &options)));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod screen_vocabulary_tests {
    use super::*;

    #[test]
    fn screen_spelling_uses_existing_review_baseline_and_ai_fidelity_protection() {
        let settings = Settings::default();
        let raw = "Ask Jonathon Reed, not Prishma, for 12 reports.";
        let mut result = run_local_dictation_pipeline(
            raw,
            &settings,
            &[],
            &[],
            None,
            LocalDictationDestination {
                spoken_language: Some("en"),
                app_target: Some("Mail"),
                category: crate::text::format::DictationAppCategory::Other,
                field_role: None,
            },
        );
        apply_screen_spelling(
            &mut result,
            &crate::dictation_screen_context::extract("Jonathan Reed\nPrishma"),
            false,
        );
        assert_eq!(
            result.text,
            "Ask Jonathan Reed, not Prishma, for 12 reports."
        );
        assert!(result
            .pipeline_stage_keys
            .contains(&"nearby_spelling".into()));
        assert!(crate::dictation_fidelity::validate_cleanup(
            &result.text,
            "Ask Jonathan Reed, not Prishma, for 12 reports."
        )
        .is_ok());
        for bad in [
            "Ask Jonathan Reed, Prishma, for 12 reports.",
            "Ask Jonathan Reed, not Prishma, for 21 reports.",
        ] {
            assert!(crate::dictation_fidelity::validate_cleanup(&result.text, bad).is_err());
        }
        assert!(crate::dictation_fidelity::validate_dictionary_replacements(
            &result.text,
            "Ask Jonathon Reed, not Prishma, for 12 reports.",
            &result.applied_dictionary_replacements
        )
        .is_err());
        assert_eq!(raw, "Ask Jonathon Reed, not Prishma, for 12 reports.");
    }

    #[tokio::test]
    async fn screen_vocabulary_is_not_serialized_and_expires_on_reset() {
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(7),
            ..Default::default()
        });
        let expected = models::DictationStartOptions::default();
        let options = Mutex::new(expected.clone());
        assert!(
            commit_screen_vocabulary(
                &tracker,
                &options,
                7,
                &expected,
                0,
                crate::dictation_screen_context::extract("Jonathan Reed")
            )
            .await
        );
        let json = serde_json::to_string(&*options.lock().await).unwrap();
        assert!(!json.contains("vocabulary"));
        assert!(!json.contains("Jonathan"));
        let forged: models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({"screenVocabulary": [0, ["ForgedName"]]}))
                .unwrap();
        assert!(forged.screen_vocabulary.is_none());
        reset_dictation_session_runtime(
            &Mutex::new(DictationSessionState::Recording),
            &tracker,
            &options,
        )
        .await;
        assert!(options.lock().await.screen_vocabulary.is_none());
    }

    #[tokio::test]
    async fn screen_vocabulary_rejects_late_stale_cancelled_and_retargeted_reads() {
        for case in 0..4 {
            let mut tracker = DictationSessionTracker {
                active_session_id: Some(7),
                ..Default::default()
            };
            let expected = models::DictationStartOptions::default();
            let mut options = expected.clone();
            match case {
                0 => tracker.stopping_session_id = Some(7),
                1 => tracker.active_session_id = Some(8),
                2 => tracker.cancellation_requested_session_id = Some(7),
                _ => options.context_app_bundle_id = Some("other.app".into()),
            }
            let options = Mutex::new(options);
            assert!(
                !commit_screen_vocabulary(
                    &Mutex::new(tracker),
                    &options,
                    7,
                    &expected,
                    0,
                    crate::dictation_screen_context::extract("Jonathan Reed")
                )
                .await
            );
            assert!(options.lock().await.screen_vocabulary.is_none());
        }
    }

    #[tokio::test]
    async fn screen_vocabulary_stop_drains_only_its_own_session() {
        let tracker = Mutex::new(DictationSessionTracker {
            active_session_id: Some(8),
            ..Default::default()
        });
        let options = Mutex::new(models::DictationStartOptions {
            screen_vocabulary: Some((3, crate::dictation_screen_context::extract("Jonathan Reed"))),
            ..Default::default()
        });
        assert!(snapshot_dictation_stop_options(&tracker, &options, 7)
            .await
            .screen_vocabulary
            .is_none());
        assert!(options.lock().await.screen_vocabulary.is_some());
        assert!(snapshot_dictation_stop_options(&tracker, &options, 8)
            .await
            .screen_vocabulary
            .is_some());
        assert!(options.lock().await.screen_vocabulary.is_none());
    }

    #[test]
    fn screen_spelling_defaults_off_and_revoke_restore_invalidates_capture() {
        let mut previous = Settings::default();
        assert!(!previous.transcription.dictation_nearby_spelling);
        previous.transcription.dictation_nearby_spelling = true;
        let mut revoked = previous.clone();
        revoked.transcription.dictation_nearby_spelling = false;
        let revision = std::sync::atomic::AtomicU64::new(0);
        advance_selection_policy_revision(&revision, &previous, &revoked);
        advance_selection_policy_revision(&revision, &revoked, &previous);
        assert!(!selection_start_policy_is_current(&revision, 0));
    }
}

#[cfg(all(test, feature = "asr-transcribe-cpp"))]
mod speech_model_preparing_tests {
    use super::*;
    use crate::asr::neural_engine::{self, Family, PARAKEET_V3_COREML};

    #[test]
    fn the_hud_says_preparing_only_when_this_dictation_compiles_the_model() {
        let root = std::env::temp_dir().join(format!("session-preparing-{}", uuid::Uuid::new_v4()));
        let dir = PARAKEET_V3_COREML.dir(&root);
        for file in PARAKEET_V3_COREML.files {
            let path = dir.join(file.path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"x").unwrap();
        }
        let parakeet = Some(asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID);
        let provider = asr::AsrProviderType::TranscribeCpp;
        // A Core ML build alone, not compiled yet: this dictation compiles it
        // where the Mac runs it.
        assert_eq!(
            speech_model_preparing_first_use_at(&root, provider, parakeet, Some("de")),
            neural_engine::serves_without_ggml(&root, Family::Multilingual)
        );
        // Another model, or another provider, never prepares this build.
        assert!(!speech_model_preparing_first_use_at(
            &root,
            provider,
            Some(asr::transcribe_cpp::NEMOTRON_STREAMING_GGUF_MODEL_ID),
            Some("de")
        ));
        assert!(!speech_model_preparing_first_use_at(
            &root,
            asr::AsrProviderType::Whisper,
            Some("base.en"),
            Some("de")
        ));
        // A compile this macOS refused is not retried on the user's
        // dictation: that dictation waits for the ggml download instead.
        neural_engine::mark_refused_for_test(&root, &PARAKEET_V3_COREML);
        assert!(!speech_model_preparing_first_use_at(
            &root,
            provider,
            parakeet,
            Some("de")
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
