//! Spoken commands: capturing what they act on, and running them.
//!
//! The context a command needs (the selected text, the clipboard, the focused
//! app) captured at the moment dictation starts, and the execution of the
//! resolved command action. A command that finds nothing to work on is a
//! warning, not a failure: the caller falls back to the ordinary dictation
//! pipeline on the raw transcript rather than costing the user their words.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

/// Why `execute_dictation_command_action` could not produce a result.
#[derive(Debug)]
pub(crate) enum DictationCommandError {
    /// The command needed selected or clipboard text and there was none.
    /// Non-fatal: the caller drops back to the ordinary dictation pipeline on
    /// the raw transcript and reports this as a warning, so a selection-scoped
    /// command spoken with nothing selected never costs the user their words
    /// (and never fails the whole stop, which used to wedge the hotkey).
    MissingContext(String),
    /// Anything else — prompt lookup, a transform helper rejecting its input.
    /// Still terminal, but routed through the same cleanup as every other
    /// stop failure.
    Failed(String),
}

impl From<String> for DictationCommandError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

#[derive(Debug)]
pub(crate) struct DictationCommandExecutionResult {
    pub(crate) output_text: String,
    pub(crate) command_applied: String,
    pub(crate) prompt_source: Option<String>,
    pub(crate) prompt_preview: Option<String>,
    pub(crate) undo_previous_insert: bool,
}

pub(crate) async fn capture_sidecar_dictation_start_context(
    state: &AppState,
    settings_snapshot: &settings::Settings,
    options: &mut models::DictationStartOptions,
) {
    #[cfg(target_os = "macos")]
    capture_pending_hotkey_target(state);

    let (app_name, app_bundle_id, browser_url) = {
        #[cfg(target_os = "macos")]
        {
            if let Some(target) = take_pending_hotkey_target(state) {
                (target.app_name, target.app_bundle_id, target.browser_url)
            } else {
                capture_hotkey_target_context(false)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = state;
            let _ = settings_snapshot;
            capture_hotkey_target_context(false)
        }
    };
    if options.context_app_name.is_none() {
        options.context_app_name = app_name.clone();
    }
    if options.context_app_bundle_id.is_none() {
        options.context_app_bundle_id = app_bundle_id.clone();
    }

    options.resolved_mode_preset = Some(
        settings_snapshot
            .transcription
            .dictation_mode_preset
            .clone(),
    );
    options.resolved_custom_mode_id = settings_snapshot
        .transcription
        .dictation_selected_custom_mode_id
        .clone();
    options.resolved_mode_label = Some(dictation_mode_label(
        &settings_snapshot.transcription.dictation_mode_preset,
        settings_snapshot
            .transcription
            .dictation_selected_custom_mode_id
            .as_deref(),
        &settings_snapshot.transcription.dictation_custom_modes,
    ));

    if options.activation_matcher.is_none() {
        if let Some(mode) = active_dictation_custom_mode(settings_snapshot) {
            options.activation_matcher = custom_mode_matches_context(
                mode,
                options.context_app_name.as_deref(),
                browser_url.as_deref(),
            );
        }
    }

    if options.captured_context_text.is_some() {
        return;
    }

    let context_source = normalize_dictation_context_source(&options.context_source);
    if context_source == "none" {
        return;
    }

    match capture_dictation_context_text(context_source, options.context_app_name.as_deref()) {
        Ok(captured_context_text) => {
            options.captured_context_text = captured_context_text;
        }
        Err(error) => {
            tracing::info!(
                "Dictation start context capture failed for source '{}': {}",
                context_source,
                error
            );
        }
    }
}

pub(crate) async fn execute_dictation_command_action(
    state: &AppState,
    command_key: &str,
    action: DictationCommandAction,
    captured_context_text: Option<&str>,
    context_source: &str,
    ai_selection: &(AnalysisProvider, bool, String),
) -> Result<DictationCommandExecutionResult, DictationCommandError> {
    use crate::dictation_parity::{
        append_to_context_selection, delete_phrase_from_context, lowercase_context_selection,
        prepend_to_context_selection, replace_context_selection, sentence_case_context_selection,
        title_case_context_selection, uppercase_context_selection,
    };

    let execution = match action {
        DictationCommandAction::InsertText(text) => DictationCommandExecutionResult {
            output_text: text,
            command_applied: command_key.to_string(),
            prompt_source: None,
            prompt_preview: None,
            undo_previous_insert: false,
        },
        DictationCommandAction::UndoLastInsert | DictationCommandAction::DeleteLastSentence => {
            DictationCommandExecutionResult {
                output_text: String::new(),
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: true,
            }
        }
        DictationCommandAction::ReplaceEntireSelection(replacement) => {
            let contextual_input = resolve_contextual_command_input(
                &replacement,
                captured_context_text,
                context_source,
                "Replace Text",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = replace_context_selection(&contextual_input, &replacement)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::ReplaceSelection {
            target,
            replacement,
        } => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Replace Text",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let (output_text, _) =
                apply_contextual_phrase_replacement(&contextual_input, &target, &replacement)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::AppendToSelection(suffix) => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Append Text",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = append_to_context_selection(&contextual_input, &suffix)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::PrependToSelection(prefix) => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Prepend Text",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = prepend_to_context_selection(&contextual_input, &prefix)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::DeletePhrase(target) => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Delete Phrase",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let (output_text, _) = delete_phrase_from_context(&contextual_input, &target)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::DeleteSelection => DictationCommandExecutionResult {
            output_text: String::new(),
            command_applied: command_key.to_string(),
            prompt_source: None,
            prompt_preview: None,
            undo_previous_insert: false,
        },
        DictationCommandAction::UppercaseSelection => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Uppercase Selection",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = uppercase_context_selection(&contextual_input)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::LowercaseSelection => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Lowercase Selection",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = lowercase_context_selection(&contextual_input)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::TitleCaseSelection => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Title Case Selection",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = title_case_context_selection(&contextual_input)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::SentenceCaseSelection => {
            let contextual_input = resolve_contextual_command_input(
                "",
                captured_context_text,
                context_source,
                "Sentence Case Selection",
            )
            .map_err(DictationCommandError::MissingContext)?;
            let output_text = sentence_case_context_selection(&contextual_input)?;
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: None,
                prompt_preview: None,
                undo_previous_insert: false,
            }
        }
        DictationCommandAction::RewriteShorter(payload)
        | DictationCommandAction::RewriteProfessional(payload)
        | DictationCommandAction::Bulletize(payload) => {
            let action_label = match command_key {
                "rewrite_shorter" => "Rewrite Shorter",
                "rewrite_professional" => "Rewrite Professional",
                "bulletize_selection" => "Bulletize Selection",
                _ => "Dictation Command",
            };
            let contextual_input = resolve_contextual_command_input(
                &payload,
                captured_context_text,
                context_source,
                action_label,
            )
            .map_err(DictationCommandError::MissingContext)?;
            let prompt = resolve_dictation_command_prompt(state, command_key).await?;
            let output_text = match command_key {
                "rewrite_shorter" => run_custom_dictation_transform_with_provider(
                    state,
                    &contextual_input,
                    &prompt,
                    ai_selection.0,
                    &ai_selection.2,
                    ai_selection.1,
                )
                .await
                .map(|(output, _, _)| output)
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        "Rewrite Shorter command fell back to local transform: {}",
                        error
                    );
                    rewrite_shorter_text(&contextual_input)
                }),
                "rewrite_professional" => run_custom_dictation_transform_with_provider(
                    state,
                    &contextual_input,
                    &prompt,
                    ai_selection.0,
                    &ai_selection.2,
                    ai_selection.1,
                )
                .await
                .map(|(output, _, _)| output)
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        "Rewrite Professional command fell back to local transform: {}",
                        error
                    );
                    rewrite_professional_text(&contextual_input)
                }),
                "bulletize_selection" => run_custom_dictation_transform_with_provider(
                    state,
                    &contextual_input,
                    &prompt,
                    ai_selection.0,
                    &ai_selection.2,
                    ai_selection.1,
                )
                .await
                .map(|(output, _, _)| output)
                .unwrap_or_else(|error| {
                    tracing::warn!("Bulletize command fell back to local transform: {}", error);
                    bulletize_text(&contextual_input)
                }),
                _ => contextual_input,
            };
            DictationCommandExecutionResult {
                output_text,
                command_applied: command_key.to_string(),
                prompt_source: Some(format!("dictation_command:{}", command_key)),
                prompt_preview: Some(prompt),
                undo_previous_insert: false,
            }
        }
    };

    Ok(execution)
}
