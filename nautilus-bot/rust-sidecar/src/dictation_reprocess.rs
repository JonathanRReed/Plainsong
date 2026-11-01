//! Running it again, and transforming what is already on screen.
//!
//! Reprocessing a kept dictation recording (audio or text) through a different
//! route, and the selected-text transforms: capturing the selection or the
//! whole field, deciding the scope, running the command, and putting the result
//! back.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

const REPROCESS_PROGRESS_MESSAGE: &str = "Processing a saved dictation again…";

/// Clear this operation's progress message on errors and cancellation too.
/// A newer capture message belongs to its own operation and must survive.
struct ReprocessProgressMessageGuard(Arc<StdMutex<DictationOverlayState>>);

impl ReprocessProgressMessageGuard {
    fn begin(overlay: &Arc<StdMutex<DictationOverlayState>>) -> Self {
        if let Ok(mut state) = overlay.lock() {
            state.message = Some(REPROCESS_PROGRESS_MESSAGE.to_string());
        }
        Self(Arc::clone(overlay))
    }
}

impl Drop for ReprocessProgressMessageGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            if state.message.as_deref() == Some(REPROCESS_PROGRESS_MESSAGE) {
                state.message = None;
            }
        }
    }
}

#[cfg(test)]
mod reprocess_progress_tests {
    use super::*;

    #[test]
    fn early_error_clears_owned_progress_and_keeps_newer_message() {
        let overlay = Arc::new(StdMutex::new(DictationOverlayState::default()));
        let fail = || -> Result<(), String> {
            let _progress = ReprocessProgressMessageGuard::begin(&overlay);
            assert_eq!(
                overlay.lock().unwrap().message.as_deref(),
                Some(REPROCESS_PROGRESS_MESSAGE)
            );
            Err("recognizer heard nothing".to_string())
        };
        assert!(fail().is_err());
        assert!(overlay.lock().unwrap().message.is_none());
        let progress = ReprocessProgressMessageGuard::begin(&overlay);
        overlay.lock().unwrap().message = Some("Listening".to_string());
        drop(progress);
        assert_eq!(
            overlay.lock().unwrap().message.as_deref(),
            Some("Listening")
        );
    }

    #[tokio::test]
    async fn cancellation_clears_owned_progress() {
        let overlay = Arc::new(StdMutex::new(DictationOverlayState::default()));
        let worker_overlay = Arc::clone(&overlay);
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _progress = ReprocessProgressMessageGuard::begin(&worker_overlay);
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(overlay.lock().unwrap().message.is_none());
    }
}

pub(crate) async fn tracker_insertion_mode(state: &AppState) -> String {
    let tracker = state.dictation_session_tracker.lock().await;
    tracker
        .insertion_mode_at_start
        .unwrap_or(DictationInsertionMode::Auto)
        .as_settings_value()
        .to_string()
}

pub(crate) async fn tracker_copy_to_clipboard(state: &AppState) -> bool {
    let tracker = state.dictation_session_tracker.lock().await;
    // Matches `dictation_copy_to_clipboard`'s default: without an explicit
    // opt-in, do not leave the dictated text sitting on the user's clipboard.
    tracker.copy_to_clipboard_at_start.unwrap_or(false)
}

/// What `reprocess_dictation` was asked to do. `mode_id` is a built-in
/// preset ("voice", "messages", ...) or the id of a custom mode; `provider`
/// and `model_id` override the dictation lane's route for this run only.
#[derive(Debug, Clone)]
pub(crate) struct DictationReprocessRequest {
    pub(crate) history_id: String,
    pub(crate) mode_id: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) model_id: Option<String>,
}

fn reprocess_transform_policy(
    settings: &settings::Settings,
    custom_mode: Option<&settings::DictationCustomMode>,
) -> DictationAiTransformPolicy {
    // An explicit preset choice must not inherit another selected mode's prompt.
    let mut resolved = settings.clone();
    resolved.transcription.dictation_selected_custom_mode_id =
        custom_mode.map(|mode| mode.id.clone());
    resolved.transcription.dictation_custom_modes = custom_mode.into_iter().cloned().collect();
    let options = models::DictationStartOptions {
        profile: if custom_mode.is_some_and(|mode| mode.profile == "power_rewrite") {
            models::DictationProfile::PowerRewrite
        } else {
            models::DictationProfile::NormalSpeed
        },
        ..Default::default()
    };
    dictation_ai_transform_policy(&resolved, &options)
}

async fn bounded_reprocess_ai_attempt<T>(
    provider: AnalysisProvider,
    policy: DictationAiTransformPolicy,
    transform: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(
        dictation_format_timeout_for_policy(provider, policy),
        transform,
    )
    .await
    .map_err(|_| "Dictation reprocess AI formatting timed out.".to_string())?
}

fn finish_reprocess_ai_attempt(
    input: &str,
    result: Result<(String, AnalysisProvider, String), String>,
) -> DictationTextTransformOutput {
    match result {
        Ok((output_text, provider, model_id)) => DictationTextTransformOutput {
            output_text,
            used_ai: true,
            provider: Some(provider.as_settings_value().to_string()),
            model_id: Some(model_id),
        },
        Err(error) => {
            tracing::warn!("Dictation reprocess kept the local transcript: {}", error);
            DictationTextTransformOutput {
                output_text: input.to_string(),
                used_ai: false,
                provider: None,
                model_id: None,
            }
        }
    }
}

fn reprocess_llm_allowed(smart_format_enabled: bool, policy: DictationAiTransformPolicy) -> bool {
    smart_format_enabled || policy == DictationAiTransformPolicy::MeaningPreservingRewrite
}

fn reprocess_ai_selection(
    settings: &settings::Settings,
    custom_mode: Option<&settings::DictationCustomMode>,
) -> Result<(AnalysisProvider, bool, String), String> {
    let mut resolved = settings.clone();
    if let Some(mode) = custom_mode {
        if let Some(provider) = mode.ai_provider.as_deref() {
            resolved.privacy.dictation_ai.provider = provider.to_string();
        }
        if let Some(model_id) = mode.ai_model_id.as_deref() {
            resolved.privacy.dictation_ai.model_id = Some(model_id.to_string());
        }
    }
    dictation_session_ai_selection(&resolved)
}

#[allow(clippy::too_many_arguments)]
async fn run_reprocess_ai_transform(
    state: &AppState,
    settings: &settings::Settings,
    custom_mode: Option<&settings::DictationCustomMode>,
    input: &str,
    prompt: &str,
    policy: DictationAiTransformPolicy,
    applied_dictionary_replacements: &[String],
    english_rules: bool,
) -> Result<(String, AnalysisProvider, String), String> {
    let (provider, remote_processing_enabled, model) =
        reprocess_ai_selection(settings, custom_mode)?;
    let result = bounded_reprocess_ai_attempt(provider, policy, async {
        match policy {
            DictationAiTransformPolicy::StrictCleanup => {
                let prompt = crate::dictation_fidelity::dictionary_spelling_prompt(
                    prompt,
                    applied_dictionary_replacements,
                );
                run_dictation_cleanup_with_provider(
                    state,
                    input,
                    &prompt,
                    provider,
                    &model,
                    remote_processing_enabled,
                    // German "um" and Portuguese "um" are words: the AI pass
                    // follows the local pipeline's language decision.
                    settings.transcription.dictation_remove_disfluencies && english_rules,
                )
                .await
            }
            DictationAiTransformPolicy::MeaningPreservingRewrite => {
                let custom_prompt = custom_mode
                    .and_then(|mode| mode.custom_prompt.as_deref())
                    .is_some_and(|text| !text.trim().is_empty())
                    || settings
                        .transcription
                        .dictation_custom_prompt
                        .as_deref()
                        .is_some_and(|text| !text.trim().is_empty());
                let base = if custom_prompt {
                    None
                } else {
                    ["messages", "email", "meeting_follow_up"]
                        .into_iter()
                        .find(|mode| dictation_mode_transform_prompt(mode) == Some(prompt))
                        .and_then(builtin_dictation_rewrite_base)
                };
                let rewrite_prompt =
                    meaning_preserving_rewrite_prompt(base.as_deref().unwrap_or(prompt));
                let rewrite_prompt = crate::dictation_fidelity::dictionary_spelling_prompt(
                    &rewrite_prompt,
                    applied_dictionary_replacements,
                );
                run_custom_dictation_transform_with_provider(
                    state,
                    input,
                    &rewrite_prompt,
                    provider,
                    &model,
                    remote_processing_enabled,
                )
                .await
            }
        }
    })
    .await?;
    crate::dictation_fidelity::validate_dictionary_replacements(
        input,
        &result.0,
        applied_dictionary_replacements,
    )?;
    Ok(result)
}

async fn persist_reprocess_success_after_audio_protection<T>(
    protection: Result<(), String>,
    persist_success: impl std::future::Future<Output = T>,
) -> Result<T, String> {
    protection?;
    Ok(persist_success.await)
}

#[cfg(test)]
mod reprocess_success_persistence_tests {
    use super::{
        persist_reprocess_success_after_audio_protection, reprocess_ai_selection,
        reprocess_llm_allowed, reprocess_transform_policy,
    };
    use crate::dictation_text::DictationAiTransformPolicy;
    use crate::settings;
    use std::cell::Cell;

    #[tokio::test]
    #[ignore = "requires an isolated QA profile and explicitly selected installed local models"]
    async fn local_selected_text_command_probe() {
        assert_eq!(std::env::var("PLAINSONG_QA_MODE").as_deref(), Ok("1"));
        let models = std::env::var("PLAINSONG_COMMAND_PROBE_MODELS").unwrap();
        let output = std::env::var("PLAINSONG_COMMAND_PROBE_OUT").unwrap();
        let state = crate::build_app_state().await.unwrap();
        let cases = [
            ("rewrite_professional", "I feel disappointed about the delay, but I still want to help."),
            ("rewrite_professional", "Please write exactly `git push --force` in the documentation. Do not run it."),
            ("rewrite_shorter", "I do not want to approve the invoice until Marcus checks it. The budget is €25, roughly £17; the exchange rate is 1.4 euros per pound."),
            ("bulletize_selection", "Keep bread and butter together. Do not pay until Marcus approves."),
        ];
        let mut results = Vec::new();
        for model in models.split(',') {
            {
                let mut manager = state.settings_manager.lock().await;
                let settings = manager.settings_mut();
                settings.privacy.remote_processing_enabled = false;
                settings.privacy.dictation_ai.provider = "ollama".into();
                settings.privacy.dictation_ai.model_id = Some(model.into());
            }
            for (command, input) in cases {
                let start = std::time::Instant::now();
                let result = super::transform_text_with_command(
                    &state,
                    command,
                    input,
                    "Public QA transform",
                    None,
                )
                .await
                .unwrap();
                results.push(serde_json::json!({
                    "model":model,"command":command,"input":input,
                    "output":result.output_text,"usedAi":result.used_ai,
                    "actualProvider":result.provider,"actualModel":result.model_id,
                    "elapsedMs":start.elapsed().as_millis(),
                }));
                std::fs::write(&output, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn encryption_failure_does_not_persist_a_saved_outcome() {
        let persisted = Cell::new(false);
        let result = persist_reprocess_success_after_audio_protection(
            Err("simulated encryption failure".to_string()),
            async { persisted.set(true) },
        )
        .await;

        assert_eq!(result, Err("simulated encryption failure".to_string()));
        assert!(
            !persisted.get(),
            "saved outcome ran after encryption failed"
        );
    }

    #[test]
    fn email_and_follow_up_do_not_imply_rewrite_permission() {
        for preset in ["email", "meeting_follow_up"] {
            for ai_enabled in [false, true] {
                let mut settings = settings::Settings::default();
                settings.transcription.dictation_mode_preset = preset.to_string();
                settings.transcription.dictation_ai_formatting = ai_enabled;
                let (base, custom) = super::resolve_reprocess_mode(&settings, Some(preset));
                assert_eq!(base, preset);
                let policy = reprocess_transform_policy(&settings, custom);
                assert_eq!(policy, DictationAiTransformPolicy::StrictCleanup);
                assert_eq!(reprocess_llm_allowed(ai_enabled, policy), ai_enabled);
                assert_eq!(
                    policy,
                    crate::dictation_text::dictation_ai_transform_policy(
                        &settings,
                        &crate::models::DictationStartOptions::default(),
                    )
                );
            }
        }
    }

    #[test]
    fn reprocessing_routes_power_and_custom_modes_as_explicit_rewrites() {
        for custom in [
            settings::DictationCustomMode {
                custom_prompt: Some("Tighten the prose.".to_string()),
                profile: "normal_speed".to_string(),
                ..Default::default()
            },
            settings::DictationCustomMode {
                profile: "power_rewrite".to_string(),
                ..Default::default()
            },
        ] {
            let mut settings = settings::Settings::default();
            settings.transcription.dictation_ai_formatting = false;
            let policy = reprocess_transform_policy(&settings, Some(&custom));
            assert_eq!(policy, DictationAiTransformPolicy::MeaningPreservingRewrite);
            assert!(reprocess_llm_allowed(false, policy));
            settings.transcription.dictation_selected_custom_mode_id = Some(custom.id.clone());
            settings.transcription.dictation_custom_modes = vec![custom];
            assert_eq!(
                reprocess_transform_policy(&settings, None),
                DictationAiTransformPolicy::StrictCleanup
            );
        }
    }

    #[test]
    fn saved_global_prompt_requires_ai_formatting() {
        let mut settings = settings::Settings::default();
        settings.transcription.dictation_custom_prompt = Some("Tighten the prose.".to_string());
        for enabled in [false, true] {
            settings.transcription.dictation_ai_formatting = enabled;
            assert_eq!(
                reprocess_transform_policy(&settings, None),
                if enabled {
                    DictationAiTransformPolicy::MeaningPreservingRewrite
                } else {
                    DictationAiTransformPolicy::StrictCleanup
                }
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pending_ai_attempt_keeps_exact_local_text_at_live_deadline() {
        use crate::llm::Provider;
        for provider in [Provider::Ollama, Provider::OpenAi] {
            for policy in [
                DictationAiTransformPolicy::StrictCleanup,
                DictationAiTransformPolicy::MeaningPreservingRewrite,
            ] {
                let input = "5. Keep config.json.\n\n6. Do not deploy!";
                let start = tokio::time::Instant::now();
                let result = super::bounded_reprocess_ai_attempt(
                    provider,
                    policy,
                    std::future::pending::<Result<(String, Provider, String), String>>(),
                )
                .await;
                assert_eq!(
                    start.elapsed(),
                    crate::dictation_format_timeout_for_policy(provider, policy)
                );
                let fallback = super::finish_reprocess_ai_attempt(input, result);
                assert_eq!(fallback.output_text, input);
                assert!(!fallback.used_ai);
                assert!(fallback.provider.is_none());
                assert!(fallback.model_id.is_none());
            }
        }
    }

    #[test]
    fn reprocessing_uses_the_requested_custom_modes_ai_route() {
        let mut settings = settings::Settings::default();
        settings.privacy.dictation_ai.provider = "openai".to_string();
        settings.privacy.dictation_ai.model_id = Some("cloud-model".to_string());
        settings.privacy.remote_processing_enabled = true;
        let custom = settings::DictationCustomMode {
            ai_provider: Some("ollama".to_string()),
            ai_model_id: Some("gemma4:e4b".to_string()),
            ..Default::default()
        };

        let (provider, remote_enabled, model) =
            reprocess_ai_selection(&settings, Some(&custom)).expect("custom route resolves");
        assert_eq!(provider, crate::llm::Provider::Ollama);
        assert!(remote_enabled);
        assert_eq!(model, "gemma4:e4b");

        let (provider, _, model) =
            reprocess_ai_selection(&settings, None).expect("global route resolves");
        assert_eq!(provider, crate::llm::Provider::OpenAi);
        assert_eq!(model, "cloud-model");
    }
}

/// Whether a saved dictation's audio can be run again, decided from facts the
/// caller already has so the refusal can name the setting that would have
/// kept it. Pure so the policy is testable without a database or a file.
pub(crate) fn dictation_reprocess_audio_decision(
    audio_path: &str,
    audio_file_present: bool,
    keep_audio_enabled: bool,
    retention_preset: &str,
) -> Result<(), String> {
    if audio_path.trim().is_empty() {
        return Err(if keep_audio_enabled {
            "This dictation was saved before \"Keep dictation audio\" was turned on, so there is no audio to process again. Newer dictations keep theirs.".to_string()
        } else {
            "This dictation's audio was not kept. Turn on \"Keep dictation audio for Process again\" under Capture and insert on the Dictation page; from then on each dictation keeps its audio until its history entry is deleted.".to_string()
        });
    }
    if !audio_file_present {
        let preset = normalize_dictation_retention_preset(retention_preset);
        return Err(if preset == "never" {
            "This dictation's audio file is no longer on disk, so it cannot be processed again."
                .to_string()
        } else {
            format!(
                "This dictation's audio file is gone. Dictation auto-delete is set to \"{}\", which removes kept audio with the entry; a longer setting keeps it for Process again.",
                match preset {
                    "immediate" => "Immediately",
                    "24h" => "After 24 hours",
                    "72h" => "After 72 hours",
                    _ => "Custom",
                }
            )
        });
    }
    Ok(())
}

/// Resolves a requested mode id to the base preset the pipeline runs and the
/// custom mode (if any) whose prompt applies. Unknown ids fall back to the
/// active mode, the same way live dictation resolves it.
pub(crate) fn resolve_reprocess_mode<'a>(
    settings: &'a settings::Settings,
    mode_id: Option<&str>,
) -> (&'static str, Option<&'a settings::DictationCustomMode>) {
    if let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(custom) = settings
            .transcription
            .dictation_custom_modes
            .iter()
            .find(|mode| mode.id == mode_id)
        {
            let base = custom
                .base_mode_preset
                .as_deref()
                .map(normalize_dictation_base_mode_preset)
                .unwrap_or("voice");
            return (base, Some(custom));
        }
        // `normalize_dictation_mode_preset` answers "voice" for anything it
        // does not know, which would turn a stale or mistyped mode id into a
        // silent style change. Only an id that really is one of the built-in
        // presets short-circuits; everything else falls through to the mode
        // the reader is actually using.
        let preset = normalize_dictation_mode_preset(mode_id);
        if preset != "custom" && preset == mode_id {
            return (preset, None);
        }
    }
    (
        resolved_dictation_mode_preset(settings),
        active_dictation_custom_mode(settings),
    )
}

/// Runs kept dictation audio through the recognizer and the chosen style
/// again and saves the result as a new history entry linked to the original.
/// Nothing is inserted, copied to the clipboard, or shown in the popup.
pub(crate) async fn reprocess_dictation_impl(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    request: DictationReprocessRequest,
) -> Result<models::DictationReprocessOutcome, String> {
    // Foreground text work: background indexing yields the runtime to it.
    let _foreground = crate::llm::local_model_load::foreground_work();
    // Reads stored audio, so it is excluded against backup/restore/vault work
    // exactly like meeting post-processing.
    let _postprocessing_lease = state.operation_coordinator.try_acquire_named(
        operation_coordinator::OperationKind::PostProcess,
        "dictation reprocessing",
    )?;
    let settings_snapshot = state.settings_manager.lock().await.settings().clone();

    let (source, dictionary_entries, snippets) = {
        let db = state.db.lock().await;
        let source = db
            .get_recording(&request.history_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That saved dictation no longer exists.".to_string())?;
        if source.source_type != "dictation" {
            return Err("Process again works on saved dictations only.".to_string());
        }
        let dictionary_entries = db
            .list_dictation_dictionary_entries()
            .map_err(|e| format!("Failed to read the dictation dictionary: {e}"))?;
        let snippets = if settings_snapshot.transcription.dictation_snippets_enabled {
            db.list_dictation_snippets()
                .map_err(|e| format!("Failed to read dictation snippets: {e}"))?
        } else {
            Vec::new()
        };
        (source, dictionary_entries, snippets)
    };

    dictation_reprocess_audio_decision(
        &source.audio_path,
        Path::new(&source.audio_path).is_file(),
        settings_snapshot.transcription.dictation_keep_audio,
        &settings_snapshot.transcription.dictation_retention_preset,
    )?;

    // The resolver pins a private source snapshot under the storage gate.
    // Retention can no longer remove the bytes while this read is in progress.
    let audio_bytes = {
        let bundle = resolve_recording_audio_bundle_for_runtime(state, &source.id).await?;
        std::fs::read(&bundle.primary).map_err(|error| {
            format!(
                "Could not read this dictation's kept audio ({}): {}",
                bundle.primary.display(),
                error
            )
        })?
    };
    let duration_seconds = compute_wav_duration_seconds_from_bytes(&audio_bytes)?;

    let (provider_type, model_id) = match (&request.provider, &request.model_id) {
        (Some(provider), model) => {
            let provider_type = asr_provider_from_settings_value(provider)
                .ok_or_else(|| format!("Unknown speech engine '{provider}'."))?;
            let model_id = model
                .clone()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            (
                provider_type,
                normalize_asr_model_id(provider_type, &model_id),
            )
        }
        (None, _) => resolve_transcription_provider_and_model(
            &settings_snapshot.transcription,
            TranscriptionScope::Dictation,
        ),
    };
    enforce_remote_asr_provider_policy(
        provider_type,
        settings_snapshot.privacy.remote_processing_enabled,
    )?;
    ensure_asr_route_ready(state, provider_type, &model_id, "process again").await?;

    let (base_preset, custom_mode) =
        resolve_reprocess_mode(&settings_snapshot, request.mode_id.as_deref());
    let base_preset = base_preset.to_string();
    let custom_mode = custom_mode.cloned();

    // The original destination app scopes the dictionary and the formatting
    // style, exactly as it did the first time.
    let original_details = {
        let db = state.db.lock().await;
        db.get_all_audit_log()
            .map_err(|e| e.to_string())?
            .into_iter()
            .rev()
            .find(|entry| {
                entry.event == "dictation_completed"
                    && entry.details.get("recording_id").and_then(|v| v.as_str())
                        == Some(source.id.as_str())
            })
            .map(|entry| dictation_history_details_from_audit(&entry.details))
            .unwrap_or_default()
    };
    let app_target = original_details
        .app_target
        .clone()
        .or_else(|| original_details.context_app_name.clone());
    let formatting_hint = resolve_dictation_formatting_hint(
        app_target.as_deref(),
        original_details.activation_matcher.as_deref(),
        original_details.context_app_name.as_deref(),
    );
    let destination_category = settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings_snapshot.transcription,
        app_target.as_deref(),
        None,
        formatting_hint.as_deref(),
    );
    // Translate-to-English follows the mode this re-run selected, not the
    // one that happens to be active now. Only the whisper-native route
    // applies here: it is a decode flag, so it costs nothing extra. The AI
    // lane is a second model pass the live path owns; "Process again" does
    // not re-run it, so a non-whisper recognizer re-runs untranslated.
    let translate_requested = match custom_mode.as_ref() {
        Some(mode) => mode.translate_to_english,
        None => {
            settings_snapshot
                .transcription
                .dictation_translate_to_english
        }
    };
    let translation_route =
        resolve_dictation_translation_route(provider_type, &model_id, translate_requested);
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
        acoustic_vocabulary: Vec::new(),
    };

    let _progress_message = ReprocessProgressMessageGuard::begin(&state.dictation_overlay_state);
    let transcription_started = std::time::Instant::now();
    let transcription_result = state
        .asr_manager
        .transcribe_bytes_for_dictation_with_options(
            provider_type,
            &audio_bytes,
            Some(model_id.as_str()),
            &transcription_options,
        )
        .await
        .map_err(|error| {
            format!(
                "Process again failed with {}: {}",
                provider_type.speech_model_name(&model_id),
                error
            )
        })?;
    let transcription_latency_ms = transcription_started.elapsed().as_millis() as u64;

    let recognition_review_words = models::collect_recognition_review_words(
        transcription_result.actual_provider,
        &transcription_result.segments,
        &transcription_result.text,
        duration_seconds.max(0) as f64,
    );

    let raw_text =
        sanitize_dictation_output(&transcription_result.text, &transcription_result.text)
            .trim()
            .to_string();
    if raw_text.is_empty() {
        return Err(
            "The recognizer heard nothing in this dictation's audio, so there is nothing to save."
                .to_string(),
        );
    }

    // Stage two: the same local pipeline the live path runs, then the mode's
    // transform. Commands are deliberately not re-executed: a "delete that"
    // said last week must not act on whatever is focused now.
    // Numbers as digits follows the mode this re-run selected, for the same
    // reason translate-to-English above does: the selected profile's own
    // override first, then the user's setting for the preset it is built on,
    // then that preset's default.
    let numbers_as_digits = custom_mode
        .as_ref()
        .and_then(|mode| mode.numbers_as_digits)
        .unwrap_or_else(|| {
            settings_snapshot
                .transcription
                .dictation_numbers_as_digits
                .get(base_preset.as_str())
                .copied()
                .unwrap_or_else(|| {
                    settings::default_dictation_numbers_as_digits(base_preset.as_str())
                })
        });
    let pipeline_result = crate::dictation_pipeline::apply_dictation_pipeline(
        crate::dictation_pipeline::DictationPipelineInput {
            spoken_language: crate::text::language::dictation_spoken_language(
                settings_snapshot.transcription.language.as_deref(),
                Some(transcription_result.language.as_str()),
                translation_route == DictationTranslationRoute::WhisperNative,
            ),
            text: raw_text.as_str(),
            dictionary_entries: &dictionary_entries,
            snippets: &snippets,
            app_target: app_target.as_deref(),
            mode_preset: base_preset.as_str(),
            smart_formatting_enabled: true,
            clean_disfluencies: settings_snapshot
                .transcription
                .dictation_remove_disfluencies,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category,
            numbers_as_digits,
            // Process Again saves to history rather than a field, so only the
            // user's destination-aware formatting setting applies.
            structured_layout: settings_snapshot
                .transcription
                .dictation_category_formatting_enabled,
        },
    );
    let mut final_text = pipeline_result.text.trim().to_string();
    let mut used_ai = false;
    let mut ai_rewrite_failed = false;
    let mut pipeline_stage_keys = pipeline_result.pipeline_stage_keys.clone();

    let custom_prompt = custom_mode
        .as_ref()
        .and_then(|mode| mode.custom_prompt.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let transform_policy = reprocess_transform_policy(&settings_snapshot, custom_mode.as_ref());
    let llm_allowed = reprocess_llm_allowed(
        settings_snapshot.transcription.dictation_ai_formatting,
        transform_policy,
    );
    if !final_text.is_empty() {
        match base_preset.as_str() {
            "messages" | "email" | "meeting_follow_up" | "notes" => {
                // A custom mode built on this base supplies the prompt; any
                // other custom mode must not hijack an explicit preset choice.
                let prompt = custom_prompt.clone().unwrap_or_else(|| {
                    dictation_mode_transform_prompt(&base_preset)
                        .unwrap_or_default()
                        .to_string()
                });
                if llm_allowed && !prompt.is_empty() {
                    let transformed = run_reprocess_ai_transform(
                        state,
                        &settings_snapshot,
                        custom_mode.as_ref(),
                        final_text.as_str(),
                        prompt.as_str(),
                        transform_policy,
                        &pipeline_result.applied_dictionary_replacements,
                        pipeline_result.english_rules,
                    )
                    .await;
                    match transformed {
                        Ok((output, _, _)) => {
                            final_text = output.trim().to_string();
                            used_ai = true;
                            pipeline_stage_keys.push("mode_transform".to_string());
                        }
                        Err(error) => {
                            ai_rewrite_failed = true;
                            tracing::warn!(
                                "Process again: '{}' transform kept the local transcript: {}",
                                base_preset,
                                error
                            );
                            // Keep the immediate pre-AI text verbatim, just as live
                            // dictation does. Do not run another rewrite after rejection.
                            pipeline_stage_keys.push("mode_transform_fallback".to_string());
                        }
                    }
                } else if base_preset == "notes" {
                    let bulletized = format_dictation_notes(&final_text);
                    if bulletized != final_text {
                        final_text = bulletized;
                        pipeline_stage_keys.push("mode_transform".to_string());
                    }
                }
            }
            _ => {
                if let (true, Some(prompt)) = (llm_allowed, custom_prompt.as_deref()) {
                    match run_reprocess_ai_transform(
                        state,
                        &settings_snapshot,
                        custom_mode.as_ref(),
                        final_text.as_str(),
                        prompt,
                        transform_policy,
                        &pipeline_result.applied_dictionary_replacements,
                        pipeline_result.english_rules,
                    )
                    .await
                    {
                        Ok((output, _, _)) => {
                            final_text = output.trim().to_string();
                            used_ai = true;
                            pipeline_stage_keys.push("smart_formatting".to_string());
                        }
                        Err(error) => {
                            ai_rewrite_failed = true;
                            tracing::warn!(
                                "Process again: custom-mode formatting kept the local output: {}",
                                error
                            );
                        }
                    }
                }
            }
        }
    }
    final_text = sanitize_dictation_output(final_text.as_str(), raw_text.as_str())
        .trim()
        .to_string();
    let stored_text = if final_text.is_empty() {
        raw_text.clone()
    } else {
        final_text.clone()
    };

    // The new entry keeps its own copy of the audio, so deleting either entry
    // (by hand or by the retention sweep) never strands the other.
    let now = chrono::Utc::now();
    let recording_id = uuid::Uuid::new_v4().to_string();
    let kept_audio_path = if settings_snapshot.transcription.dictation_keep_audio {
        Some(write_kept_dictation_audio(&recording_id, &audio_bytes)?)
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

    let transcript = models::Transcript {
        heard_through_speakers: Vec::new(),
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        segments: if stored_text == raw_text {
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
        requested_provider: Some(asr_provider_to_settings_value(provider_type).to_string()),
        actual_provider: Some(
            asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        ),
        measured_word_timestamps: transcription_result.measured_word_timestamps
            && stored_text == raw_text,
        created_at: now,
    };
    let mode_label = custom_mode
        .as_ref()
        .map(|mode| mode.name.clone())
        .unwrap_or_else(|| {
            dictation_mode_label(
                &base_preset,
                None,
                &settings_snapshot.transcription.dictation_custom_modes,
            )
        });
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Dictation (processed again, {}) - {}",
            mode_label,
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: source.project_id.clone(),
        duration: duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "dictation".to_string(),
        audio_path: kept_audio_path
            .as_ref()
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
        pause_spans: Vec::new(),
        video_service: None,
        transcript_complete: true,
        transcript_degraded_reason: None,
        transcript_incomplete_acknowledged_at: None,
        capture_degraded_summary: None,
        attendees: Vec::new(),
    };
    let history_text = crate::store::DictationHistoryTextRecord {
        recording_id: recording_id.clone(),
        final_text: stored_text.clone(),
        raw_text: raw_text.clone(),
        reprocessed_from_id: Some(source.id.clone()),
        mode_preset: Some(base_preset.clone()),
        created_at: now,
    };

    {
        let mut db = state.db.lock().await;
        if let Err(error) = db.create_dictation_history_entry_with_recognition_review(
            &recording,
            &transcript,
            &history_text,
            kept_audio_metadata.as_ref(),
            recognition_review_words.as_deref(),
        ) {
            if let Some(path) = kept_audio_path.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!(
                "Plainsong could not save the processed-again dictation: {error}"
            ));
        }
        let _ = db.save_transcript_artifact(&TranscriptArtifactRecord {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.clone(),
            transcript_id: Some(transcript.id.clone()),
            segment_count: transcript.segments.len() as i64,
            model_id: Some(transcription_result.model_id.clone()),
            requested_provider: Some(asr_provider_to_settings_value(provider_type).to_string()),
            actual_provider: Some(
                asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
            ),
            quality_score: Some(transcription_result.confidence),
            startup_latency_ms: None,
            transcription_latency_ms: Some(transcription_latency_ms as i64),
            insert_latency_ms: None,
            end_to_end_ms: Some(transcription_latency_ms as i64),
            created_at: now,
        });
    }
    // Do not report the new history entry as saved while its retained copy
    // bypasses an initialized vault. The helper is a no-op without a vault;
    // with one, it journals the transition before requiring the runtime key,
    // so an encryption failure remains visible and blocks vault lock rather
    // than leaving an ordinary plaintext asset behind.
    let protection = if kept_audio_metadata.is_some() {
        encrypt_finalized_recording_audio(state, Some(handle), &recording_id).await
    } else {
        Ok(())
    };
    persist_reprocess_success_after_audio_protection(protection, async {
        let mut db = state.db.lock().await;
        // Mirrors `dictation_completed` closely enough that the history
        // inspector reads the new entry through the same code path.
        let _ = db.log_audit_event(
            "dictation_completed",
            Some(serde_json::json!({
                "recording_id": &recording_id,
                "reprocessed_from_id": &source.id,
                "stop_reason": "process_again",
                "dictation_mode_preset": custom_mode.as_ref().map(|_| "custom").unwrap_or(base_preset.as_str()),
                "dictation_mode_label": mode_label,
                "dictation_base_mode_preset": &base_preset,
                "dictation_custom_mode_id": custom_mode.as_ref().map(|mode| mode.id.clone()),
                "dictation_custom_mode_name": custom_mode.as_ref().map(|mode| mode.name.clone()),
                "app_target": app_target,
                "dictionary_applied_count": pipeline_result.dictionary_applied_count,
                "snippet_applied_count": pipeline_result.snippet_applied_count,
                "formatting_applied": used_ai || pipeline_result.formatting_applied,
                "pipeline_stage_keys": pipeline_stage_keys,
                "requested_provider": asr_provider_to_settings_value(provider_type),
                "actual_provider": asr_provider_to_settings_value(transcription_result.actual_provider),
                "model_id": &transcription_result.model_id,
                "transcription_latency_ms": transcription_latency_ms,
                "ai_rewrite_failed": ai_rewrite_failed,
                "outcome": "saved",
            })),
            "info",
        );
        let _ = db.log_audit_event(
            "dictation_reprocessed",
            Some(serde_json::json!({
                "recording_id": &recording_id,
                "reprocessed_from_id": &source.id,
                "mode_preset": &base_preset,
                "custom_mode_id": custom_mode.as_ref().map(|mode| mode.id.clone()),
                "provider": asr_provider_to_settings_value(transcription_result.actual_provider),
                "model_id": &transcription_result.model_id,
                "used_ai": used_ai,
                "duration_seconds": duration_seconds,
                "transcription_latency_ms": transcription_latency_ms,
            })),
            "info",
        );
    })
    .await?;
    handle.emit_event(
        "dictation-history-changed",
        serde_json::json!({
            "recordingId": &recording_id,
            "reprocessedFromId": &source.id,
        }),
    );

    Ok(models::DictationReprocessOutcome {
        recording,
        transcript,
        final_text: stored_text,
        raw_text,
        mode_preset: base_preset,
        custom_mode_id: custom_mode.as_ref().map(|mode| mode.id.clone()),
        custom_mode_name: custom_mode.as_ref().map(|mode| mode.name.clone()),
        provider: asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        model_id: transcription_result.model_id.clone(),
        used_ai,
        ai_rewrite_failed,
        reprocessed_from_id: source.id.clone(),
        reprocessed_from_created_at: source.created_at,
        transcription_latency_ms,
    })
}

/// Writes a dictation's captured WAV into the recordings store under a name
/// that cannot collide, and returns its path. The caller registers it as the
/// entry's owned primary asset in the same transaction as the row.
pub(crate) fn write_kept_dictation_audio(
    recording_id: &str,
    audio_bytes: &[u8],
) -> Result<PathBuf, String> {
    let recordings_dir = nautilus_data_root()?.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|error| {
        format!(
            "Failed to prepare the recordings folder '{}': {}",
            recordings_dir.display(),
            error
        )
    })?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let short_id: String = recording_id.chars().take(8).collect();
    let path = recordings_dir.join(format!("dictation_{timestamp}_{short_id}.wav"));
    std::fs::write(&path, audio_bytes).map_err(|error| {
        format!(
            "Failed to keep the dictation audio at '{}': {}",
            path.display(),
            error
        )
    })?;
    Ok(path)
}

fn format_reprocessed_dictation_text(
    input: &str,
    mode_preset: &str,
    settings: &settings::Settings,
    app_target: Option<&str>,
) -> String {
    let formatting_hint = resolve_dictation_formatting_hint(app_target, None, None);
    // This is local formatting. The AI category-prompt toggle does not
    // disable destination overrides, just as in live dictation.
    let category = settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings.transcription,
        app_target,
        None,
        formatting_hint.as_deref(),
    );
    let text = sanitize_dictation_output(input, input);
    let english_rules = crate::text::language::english_rules_apply(
        crate::text::language::dictation_spoken_language(
            settings.transcription.language.as_deref(),
            None,
            false,
        ),
        &text,
    );
    crate::text::format::smart_format_dictation_text_for_language(
        text.trim(),
        mode_preset,
        category,
        settings.transcription.dictation_category_formatting_enabled,
        english_rules,
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod reprocess_text_category_tests {
    use super::format_reprocessed_dictation_text;
    use crate::settings::{DictationAppCategoryOverride, Settings};

    fn code_override_settings(enabled: bool) -> Settings {
        let mut settings = Settings::default();
        settings.privacy.remote_processing_enabled = false;
        settings.transcription.dictation_app_category_overrides =
            vec![DictationAppCategoryOverride {
                id: "preview-code".into(),
                app_matcher: "TextEdit".into(),
                category: "code_editor".into(),
                enabled,
            }];
        settings
    }

    #[test]
    fn text_preview_preserves_code_destination_override() {
        let settings = code_override_settings(true);
        assert_eq!(
            format_reprocessed_dictation_text(
                "cd dash dash verbose",
                "voice",
                &settings,
                Some("TextEdit")
            ),
            "cd --verbose"
        );
    }

    #[test]
    fn text_preview_ignores_disabled_destination_override() {
        let settings = code_override_settings(false);
        assert_eq!(
            format_reprocessed_dictation_text(
                "cd dash dash verbose",
                "voice",
                &settings,
                Some("TextEdit")
            ),
            crate::text::format::smart_format_dictation_text_for_app(
                "cd dash dash verbose",
                "voice",
                Some("TextEdit")
            )
        );
        assert_ne!(
            format_reprocessed_dictation_text(
                "cd dash dash verbose",
                "voice",
                &settings,
                Some("TextEdit")
            ),
            "cd --verbose"
        );
    }

    #[test]
    fn text_preview_category_override_survives_disabled_ai_category_prompt() {
        let mut settings = code_override_settings(true);
        settings.transcription.dictation_category_formatting_enabled = false;
        assert_eq!(
            format_reprocessed_dictation_text(
                "cd dash dash verbose",
                "voice",
                &settings,
                Some("TextEdit")
            ),
            "cd --verbose"
        );
    }
}

pub(crate) async fn reprocess_dictation_text_impl(
    state: &AppState,
    text: String,
    mode_preset: String,
    app_target: Option<String>,
) -> Result<serde_json::Value, String> {
    // Foreground text work: background indexing yields the runtime to it.
    let _foreground = crate::llm::local_model_load::foreground_work();
    let input = text.trim();
    if input.is_empty() {
        return Err("Dictation text is empty.".to_string());
    }

    let normalized_mode = normalize_dictation_mode_preset(&mode_preset).to_string();
    let reprocess_settings = state.settings_manager.lock().await.settings().clone();
    let effective_mode = if normalized_mode == "custom" {
        resolved_dictation_mode_preset(&reprocess_settings).to_string()
    } else {
        normalized_mode.clone()
    };
    let mut ai_rewrite_failed = false;
    let (output_text, used_ai, provider, model_id) = match effective_mode.as_str() {
        "messages" | "email" | "meeting_follow_up" => {
            let local_text = format_reprocessed_dictation_text(
                input,
                &effective_mode,
                &reprocess_settings,
                app_target.as_deref(),
            );
            let custom_mode = active_dictation_custom_mode(&reprocess_settings).filter(|mode| {
                mode.base_mode_preset
                    .as_deref()
                    .map(normalize_dictation_base_mode_preset)
                    .unwrap_or("voice")
                    == effective_mode
            });
            let policy = reprocess_transform_policy(&reprocess_settings, custom_mode);
            if reprocess_llm_allowed(
                reprocess_settings.transcription.dictation_ai_formatting,
                policy,
            ) {
                let (prompt, _prompt_source) =
                    resolve_dictation_mode_transform_prompt(&reprocess_settings, &effective_mode)
                        .ok_or_else(|| {
                        "No transform prompt is configured for this mode.".to_string()
                    })?;
                let english_rules = crate::text::language::english_rules_apply(
                    crate::text::language::dictation_spoken_language(
                        reprocess_settings.transcription.language.as_deref(),
                        None,
                        false,
                    ),
                    &local_text,
                );
                let result = run_reprocess_ai_transform(
                    state,
                    &reprocess_settings,
                    custom_mode,
                    &local_text,
                    &prompt,
                    policy,
                    &[],
                    english_rules,
                )
                .await;
                let output = finish_reprocess_ai_attempt(&local_text, result);
                ai_rewrite_failed = !output.used_ai;
                (
                    output.output_text,
                    output.used_ai,
                    output.provider,
                    output.model_id,
                )
            } else {
                (local_text, false, None, None)
            }
        }
        "notes" => (format_dictation_notes(input), false, None, None),
        "voice" | "custom" => (
            format_reprocessed_dictation_text(
                input,
                &effective_mode,
                &reprocess_settings,
                app_target.as_deref(),
            ),
            false,
            None,
            None,
        ),
        _ => (
            format_reprocessed_dictation_text(
                input,
                &effective_mode,
                &reprocess_settings,
                app_target.as_deref(),
            ),
            false,
            None,
            None,
        ),
    };

    Ok(serde_json::json!({
        "modePreset": effective_mode,
        "outputText": output_text,
        "usedAi": used_ai,
        "aiRewriteFailed": ai_rewrite_failed,
        "provider": provider,
        "modelId": model_id
    }))
}

/// Scope a selected-text transform actually ran against: an explicit text
/// selection in the frontmost app, or (Quick-Fix-style commands only) the
/// whole contents of the currently focused field when there was no
/// selection to capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SelectedTextTransformTargetScope {
    Selection,
    FocusedField,
}

impl SelectedTextTransformTargetScope {
    pub(crate) fn as_result_value(self) -> &'static str {
        match self {
            Self::Selection => "selection",
            Self::FocusedField => "focused_field",
        }
    }
}

#[derive(Debug)]
pub(crate) struct SelectedTextTransformTarget {
    pub(crate) text: String,
    pub(crate) scope: SelectedTextTransformTargetScope,
}

/// Runs a dictation command (by `command_key`) against `input_text`,
/// dispatching to a pure-Rust local transform for the four case-transform
/// commands, or to the AI-backed path (with local-transform fallback on
/// error) for everything else. `app_category` is an optional supplemental
/// hint — the same `DictationAppCategory` resolved for the existing
/// dictation-formatting prompt — appended to the AI prompt via
/// `append_category_prompt_fragment` so destination-app guardrails (e.g.
/// "don't touch code" for a code editor) apply here too, without
/// introducing a second, independent app-context branch.
pub(crate) async fn transform_text_with_command(
    state: &AppState,
    command_key: &str,
    input_text: &str,
    action_label: &str,
    app_category: Option<text::format::DictationAppCategory>,
) -> Result<DictationTextTransformOutput, String> {
    // Foreground text work: background indexing yields the runtime to it.
    let _foreground = crate::llm::local_model_load::foreground_work();
    if crate::dictation_parity::is_local_only_selected_text_command(command_key) {
        let raw_output = local_dictation_command_transform(command_key, input_text)?;
        let output_text = sanitize_dictation_output(raw_output.trim(), input_text)
            .trim()
            .to_string();
        if output_text.is_empty() {
            return Err(format!("{} result is empty.", action_label));
        }

        return Ok(DictationTextTransformOutput {
            output_text,
            used_ai: false,
            provider: None,
            model_id: None,
        });
    }

    let base_prompt = resolve_dictation_command_prompt(state, command_key).await?;
    let category_fragment = app_category.and_then(text::format::dictation_category_prompt_fragment);
    let prompt = append_category_prompt_fragment(base_prompt.clone(), category_fragment);

    let (raw_output, used_ai, provider, model_id) =
        match run_custom_dictation_transform_with_selected_provider(state, input_text, &prompt)
            .await
            .and_then(|result| {
                validate_dictation_command_rewrite(input_text, &result.0, &base_prompt)
                    .map(|()| result)
            }) {
            Ok((output, provider, model_id)) => (
                output,
                true,
                Some(provider.as_settings_value().to_string()),
                Some(model_id),
            ),
            Err(error) => {
                tracing::warn!("{} fell back to local transform: {}", action_label, error);
                (
                    local_dictation_command_transform(command_key, input_text)?,
                    false,
                    None,
                    None,
                )
            }
        };
    let output_text = sanitize_dictation_output(raw_output.trim(), input_text)
        .trim()
        .to_string();
    if output_text.is_empty() {
        return Err(format!("{} result is empty.", action_label));
    }

    Ok(DictationTextTransformOutput {
        output_text,
        used_ai,
        provider,
        model_id,
    })
}

pub(crate) struct DictationTextTransformOutput {
    output_text: String,
    used_ai: bool,
    provider: Option<String>,
    model_id: Option<String>,
}

/// Dispatches `command_key` to whichever local text-transform function
/// backs it. Only the commands with local implementations today are
/// supported: the four case-transform primitives (via `dictation_parity`)
/// plus the three commands with an existing local AI-fallback
/// implementation on main (`rewrite_shorter`, `rewrite_professional`,
/// `bulletize_selection`). Every other AI-backed selected-text command
/// (e.g. `expand_text`, `summarize_text`, `prompt_engineer`) has a default
/// prompt via `default_dictation_command_prompt` and runs through the AI
/// provider in `transform_text_with_command`; if that call fails, this
/// function's `_ => Err(...)` arm surfaces a "fell back to local transform"
/// warning and a plain error for those commands rather than a crude local
/// rewrite, since no local heuristic exists for them.
pub(crate) fn local_dictation_command_transform(
    command_key: &str,
    input: &str,
) -> Result<String, String> {
    match command_key {
        "rewrite_shorter" => Ok(rewrite_shorter_text(input)),
        "rewrite_professional" => Ok(rewrite_professional_text(input)),
        "bulletize_selection" => Ok(bulletize_text(input)),
        "uppercase_selection" => crate::dictation_parity::uppercase_context_selection(input),
        "lowercase_selection" => crate::dictation_parity::lowercase_context_selection(input),
        "title_case_selection" => crate::dictation_parity::title_case_context_selection(input),
        "sentence_case_selection" => {
            crate::dictation_parity::sentence_case_context_selection(input)
        }
        _ => Err(format!(
            "Unsupported dictation command transform: {}",
            command_key
        )),
    }
}

/// Resolves the destination-app category for a selected-text transform the
/// same way the dictation-formatting prompt resolves it: via
/// `resolve_dictation_app_category_with_overrides`, using the transform
/// target app's name/bundle id. Returned as an optional hint so callers can
/// append it as a supplement to the transform prompt without it ever being
/// required.
///
/// Like `run_dictation_formatting_with_selected_provider`, this is a
/// prompt-fragment consumer, so it respects
/// `dictation_category_formatting_enabled` itself (returning `Other` when
/// disabled) rather than relying on the resolver to gate it — the resolver
/// always returns the real category so non-prompt consumers (e.g.
/// dictionary/snippet `category_scope` matching) are unaffected by this
/// toggle.
pub(crate) async fn resolve_selected_text_transform_app_category(
    state: &AppState,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> text::format::DictationAppCategory {
    let settings = state.settings_manager.lock().await.settings().clone();
    if !settings.transcription.dictation_category_formatting_enabled {
        return text::format::DictationAppCategory::Other;
    }
    settings::resolve_dictation_app_category_with_overrides(
        &settings.transcription,
        target_app,
        target_app_bundle_id,
    )
}

/// Implements the "transform text selected in any app" feature: captures
/// the transform target (an explicit selection, falling back to the whole
/// focused field for Quick-Fix-style commands only), runs the requested
/// command against it, and writes the result back in place using whichever
/// system-wide write path matches how the target was captured.
pub(crate) async fn transform_selected_text_impl(
    state: &AppState,
    command_key: &str,
    admission_nonce: &str,
) -> Result<serde_json::Value, String> {
    state
        .capture_admission
        .consume_required(admission_nonce)
        .map_err(|_| "Selected text transform admission proof is invalid".to_string())?;

    let action_label = crate::dictation_parity::dictation_command_selected_text_label(command_key)
        .ok_or_else(|| format!("Unsupported selected-text transform: {}", command_key))?;

    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(target_os = "windows")]
    let target = (get_frontmost_app_name(), None);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let transform_target = capture_selected_text_transform_target(
            command_key,
            action_label,
            target.0.as_deref(),
            target.1.as_deref(),
        )?;
        let input_text = transform_target.text;
        let app_category = resolve_selected_text_transform_app_category(
            state,
            target.0.as_deref(),
            target.1.as_deref(),
        )
        .await;
        let transform = transform_text_with_command(
            state,
            command_key,
            input_text.as_str(),
            action_label,
            Some(app_category),
        )
        .await?;

        let paste_outcome = match transform_target.scope {
            SelectedTextTransformTargetScope::Selection => paste_text_systemwide(
                &state.accessibility_trust_observed,
                transform.output_text.as_str(),
                true,
                target.0.as_deref(),
                target.1.as_deref(),
            ),
            SelectedTextTransformTargetScope::FocusedField => {
                replace_focused_field_text_systemwide(
                    transform.output_text.as_str(),
                    target.0.as_deref(),
                    target.1.as_deref(),
                )
            }
        };

        Ok(serde_json::json!({
            "commandKey": command_key,
            "inputText": input_text,
            "outputText": transform.output_text,
            "targetScope": transform_target.scope.as_result_value(),
            "targetApp": target.0,
            "targetBundleId": target.1,
            "pasted": paste_outcome.pasted,
            "confirmed": paste_outcome.confirmed,
            "copied": paste_outcome.copied,
            "error": paste_outcome.error,
            "usedAi": transform.used_ai,
            "provider": transform.provider,
            "modelId": transform.model_id,
        }))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        let _ = command_key;
        Err("Selected-text transforms are only supported on macOS and Windows.".to_string())
    }
}

/// Pure scope-selection policy behind `capture_selected_text_transform_target`
/// (macOS): given the *result* of trying to capture an explicit selection
/// and (lazily) the *result* of trying to capture the focused-field
/// contents, decides whether the transform target is the selection, the
/// focused field, or an error — without itself touching the clipboard or
/// Accessibility APIs. Factored out so this branching logic can be unit
/// tested deterministically, independent of the live OS permission state
/// that the real capture functions depend on.
///
/// `focused_field_capture` is a closure (rather than an already-computed
/// value) so the real caller only pays the Accessibility round-trip when
/// this policy actually needs it, matching the original inline control
/// flow's laziness.
pub(crate) fn resolve_selected_text_transform_target(
    command_key: &str,
    action_label: &str,
    selection_capture: Result<Option<String>, String>,
    focused_field_capture: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<SelectedTextTransformTarget, String> {
    let allows_focused_field_fallback =
        crate::dictation_parity::allows_focused_field_fallback(command_key);

    match selection_capture {
        Ok(Some(text)) => {
            return Ok(SelectedTextTransformTarget {
                text,
                scope: SelectedTextTransformTargetScope::Selection,
            });
        }
        Ok(None) => {}
        Err(selection_error) => {
            if !allows_focused_field_fallback {
                return Err(selection_error);
            }
            if let Some(text) = focused_field_capture()? {
                return Ok(SelectedTextTransformTarget {
                    text,
                    scope: SelectedTextTransformTargetScope::FocusedField,
                });
            }
            return Err(selection_error);
        }
    }

    if allows_focused_field_fallback {
        if let Some(text) = focused_field_capture()? {
            return Ok(SelectedTextTransformTarget {
                text,
                scope: SelectedTextTransformTargetScope::FocusedField,
            });
        }
        return Err(format!(
            "Select text or focus a text field to transform, then run {}.",
            action_label
        ));
    }

    Err(format!(
        "Select text to transform, then run {}.",
        action_label
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_selected_text_transform_target(
    command_key: &str,
    action_label: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<SelectedTextTransformTarget, String> {
    resolve_selected_text_transform_target(
        command_key,
        action_label,
        capture_selected_text_via_clipboard(target_app),
        || capture_focused_field_text_via_accessibility(target_app, target_app_bundle_id),
    )
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_selected_text_transform_target(
    _command_key: &str,
    action_label: &str,
    target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<SelectedTextTransformTarget, String> {
    let text = capture_selected_text_via_clipboard(target_app)?
        .ok_or_else(|| format!("Select text to transform, then run {}.", action_label))?;
    Ok(SelectedTextTransformTarget {
        text,
        scope: SelectedTextTransformTargetScope::Selection,
    })
}
