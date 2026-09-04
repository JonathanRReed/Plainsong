//! The vocabulary the settings file speaks.
//!
//! Normalising every stored string the sidecar reads back -- dictation profile,
//! mode preset, command prefix, context source, route preference, insertion
//! mode, colour scheme, platform optimisation, model ids -- and the
//! model-warm-up scheduling that keeps a chosen local model loaded. An unknown
//! value always normalises to a default rather than failing the load, which is
//! what lets an older settings file open in a newer build.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn default_speaker_color(index: usize) -> String {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#6366F1", "#14B8A6",
    ];
    COLORS[index % COLORS.len()].to_string()
}

pub(crate) fn dictation_options_from_settings(
    settings: &settings::Settings,
) -> models::DictationStartOptions {
    let active_language_override = if settings.transcription.language.is_none()
        && settings.transcription.dictation_active_languages.len() == 1
    {
        settings
            .transcription
            .dictation_active_languages
            .first()
            .cloned()
    } else {
        None
    };

    models::DictationStartOptions {
        save_to_inbox: settings.transcription.dictation_save_to_inbox,
        project_id: Some(settings.transcription.dictation_project_id.clone()),
        profile: dictation_profile_from_settings_value(&settings.transcription.dictation_profile),
        context_source: normalize_dictation_context_source(
            &settings.transcription.dictation_context_source,
        )
        .to_string(),
        route_preference: Some(settings.transcription.dictation_route_preference.clone()),
        language_override: settings
            .transcription
            .language
            .clone()
            .or(active_language_override),
        live_preview_enabled: Some(settings.transcription.dictation_live_preview_enabled),
        requested_provider: None,
        requested_model_id: None,
        actual_provider: None,
        actual_model_id: None,
        resolved_route: None,
        provider_model_label: None,
        resolved_hosting: None,
        captured_context_text: None,
        context_app_name: None,
        context_app_bundle_id: None,
        resolved_mode_preset: None,
        resolved_custom_mode_id: None,
        resolved_mode_label: None,
        activation_matcher: None,
        preferred_input_device_id: settings
            .audio
            .dictation_input_device
            .as_ref()
            .filter(|_| settings.audio.dictation_input_override_enabled)
            .or(settings.audio.preferred_input_device.as_ref())
            .map(|device| device.device_id.clone()),
        delivery_mode: models::DictationDeliveryMode::System,
        // Never inferred from settings: this is a property of how a specific
        // start was triggered, and only the caller that received the
        // `hands_free_start` signal knows it.
        hands_free_trigger: false,
        mode_override: None,
    }
}

pub(crate) fn normalize_optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(crate) fn normalize_dictation_custom_mode(
    mode: &mut settings::DictationCustomMode,
    fallback_ai_provider: &str,
    fallback_ai_model: Option<&str>,
) {
    mode.name = mode.name.trim().to_string();
    if mode.name.is_empty() {
        mode.name = "Custom Mode".to_string();
    }
    mode.description = mode.description.trim().to_string();
    mode.profile =
        dictation_profile_to_settings_value(&dictation_profile_from_settings_value(&mode.profile))
            .to_string();
    mode.route_preference = mode
        .route_preference
        .clone()
        .map(|preference| normalize_dictation_route_preference(&preference).to_string());
    mode.language_override = normalize_optional_trimmed(mode.language_override.clone());
    mode.insertion_mode = normalize_dictation_insertion_mode(&mode.insertion_mode).to_string();
    mode.context_source = normalize_dictation_context_source(&mode.context_source).to_string();
    mode.dictation_provider =
        normalize_optional_trimmed(mode.dictation_provider.clone()).map(|provider| {
            asr_provider_to_settings_value(
                asr_provider_from_settings_value(&provider)
                    .unwrap_or(asr::AsrProviderType::Whisper),
            )
            .to_string()
        });
    mode.dictation_model_id = normalize_optional_trimmed(mode.dictation_model_id.clone());
    mode.ai_provider = normalize_optional_trimmed(mode.ai_provider.clone()).or_else(|| {
        let normalized = AnalysisProvider::from_settings_value(fallback_ai_provider)
            .expect("fallback analysis provider is validated before custom modes")
            .as_settings_value()
            .to_string();
        Some(normalized)
    });
    mode.ai_model_id = normalize_optional_trimmed(mode.ai_model_id.clone())
        .or_else(|| fallback_ai_model.map(str::to_string));
    mode.activation_app_matcher = normalize_optional_trimmed(mode.activation_app_matcher.clone());
    mode.activation_domain_matcher =
        normalize_optional_trimmed(mode.activation_domain_matcher.clone());
}

pub(crate) fn extract_host_from_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host = without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .split('@')
        .next_back()
        .unwrap_or(without_scheme)
        .split(':')
        .next()
        .unwrap_or(without_scheme)
        .trim()
        .trim_start_matches("www.");
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

pub(crate) fn custom_mode_matches_context(
    mode: &settings::DictationCustomMode,
    app_name: Option<&str>,
    browser_url: Option<&str>,
) -> Option<String> {
    if let Some(matcher) = mode.activation_domain_matcher.as_deref() {
        let normalized_matcher = matcher
            .trim()
            .trim_start_matches("www.")
            .to_ascii_lowercase();
        if !normalized_matcher.is_empty() {
            if let Some(active_domain) = browser_url.and_then(extract_host_from_url) {
                if active_domain == normalized_matcher
                    || active_domain.ends_with(&format!(".{}", normalized_matcher))
                {
                    return Some(matcher.trim().to_string());
                }
            }
        }
    }

    if let Some(matcher) = mode.activation_app_matcher.as_deref() {
        if let Some(active_app) = app_name.map(str::trim).filter(|value| !value.is_empty()) {
            if active_app
                .to_ascii_lowercase()
                .contains(&matcher.trim().to_ascii_lowercase())
            {
                return Some(matcher.trim().to_string());
            }
        }
    }

    None
}

pub(crate) fn dictation_mode_label(
    mode_preset: &str,
    selected_custom_mode_id: Option<&str>,
    custom_modes: &[settings::DictationCustomMode],
) -> String {
    match normalize_dictation_mode_preset(mode_preset) {
        "messages" => "Messages".to_string(),
        "email" => "Email".to_string(),
        "notes" => "Notes".to_string(),
        "meeting_follow_up" => "Meeting Follow-up".to_string(),
        "custom" => selected_custom_mode_id
            .and_then(|selected_id| {
                custom_modes
                    .iter()
                    .find(|mode| mode.id == selected_id)
                    .map(|mode| mode.name.clone())
            })
            .unwrap_or_else(|| "Custom".to_string()),
        _ => "Voice".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_dictation_formatting_hint(
    app_target: Option<&str>,
    activation_matcher: Option<&str>,
    context_app_name: Option<&str>,
) -> Option<String> {
    activation_matcher
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            app_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            context_app_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

pub(crate) fn dictation_profile_to_settings_value(
    profile: &models::DictationProfile,
) -> &'static str {
    match profile {
        models::DictationProfile::NormalSpeed => "normal_speed",
        models::DictationProfile::PowerRewrite => "power_rewrite",
    }
}

pub(crate) fn dictation_profile_from_settings_value(value: &str) -> models::DictationProfile {
    match value {
        "power_rewrite" | "accuracy" => models::DictationProfile::PowerRewrite,
        _ => models::DictationProfile::NormalSpeed,
    }
}

pub(crate) fn normalize_dictation_command_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DICTATION_COMMAND_PREFIX_DEFAULT
    } else {
        trimmed
    }
}

pub(crate) fn normalize_dictation_mode_preset(value: &str) -> &'static str {
    match value.trim() {
        "voice" => "voice",
        "messages" => "messages",
        "email" => "email",
        "notes" => "notes",
        "meeting_follow_up" => "meeting_follow_up",
        "custom" => "custom",
        _ => "voice",
    }
}

pub(crate) fn normalize_dictation_context_source(value: &str) -> &'static str {
    match value {
        "clipboard" => "clipboard",
        "selected_text" => "selected_text",
        "application_context" => "application_context",
        _ => "none",
    }
}

pub(crate) fn normalize_dictation_route_preference(value: &str) -> &'static str {
    match value {
        "cloud" => "cloud",
        _ => "local",
    }
}

pub(crate) fn normalize_dictation_insertion_mode(value: &str) -> &'static str {
    DictationInsertionMode::from_settings_value(value).as_settings_value()
}

/// Whether the dictation model should be pre-warmed on session start.
///
/// Only "off" turns it off. The retired "short"/"long" values were two names
/// for the same (unconditional) behavior, so they read as on.
pub(crate) fn dictation_keep_warm_enabled(value: &str) -> bool {
    value.trim() != "off"
}

/// Last answer from the Apple Foundation Models availability probe.
///
/// Probed once at startup and cached: the answer only changes when the user
/// changes a System Settings switch or finishes an OS-level model download,
/// and spawning a helper process on every readiness render would be a
/// per-frame process spawn. `refresh_apple_language_model_availability` is
/// the escape hatch for a user who just turned Apple Intelligence on.
pub(crate) static APPLE_LANGUAGE_MODEL_AVAILABILITY: LazyLock<
    StdMutex<Option<llm::apple_language_model::AppleModelAvailability>>,
> = LazyLock::new(|| StdMutex::new(None));

pub(crate) fn cached_apple_language_model_availability(
) -> Option<llm::apple_language_model::AppleModelAvailability> {
    APPLE_LANGUAGE_MODEL_AVAILABILITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub(crate) fn store_apple_language_model_availability(
    availability: llm::apple_language_model::AppleModelAvailability,
) {
    *APPLE_LANGUAGE_MODEL_AVAILABILITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(availability);
}

/// Re-probe and cache. Never prompts and never downloads anything.
pub(crate) async fn refresh_apple_language_model_availability(
) -> llm::apple_language_model::AppleModelAvailability {
    let availability = llm::apple_language_model::probe().await;
    store_apple_language_model_availability(availability.clone());
    availability
}

#[cfg(test)]
pub(crate) fn schedule_apple_language_model_probe() {
    // Unit tests must not spawn the packaged helper: it is not built in a
    // `cargo test` tree, and the answer would depend on whether the machine
    // running the suite happens to have Apple Intelligence switched on.
    // `parse_helper_line` and `availability_from_response` carry the
    // behavior deterministically.
}

#[cfg(not(test))]
pub(crate) fn schedule_apple_language_model_probe() {
    tokio::spawn(async {
        let availability = refresh_apple_language_model_availability().await;
        if availability.available {
            tracing::info!("Apple on-device language model is available for dictation cleanup");
        } else {
            tracing::info!(
                "Apple on-device language model unavailable ({}): {}",
                availability.reason.as_deref().unwrap_or("unknown"),
                availability.detail.as_deref().unwrap_or("no detail")
            );
        }
    });
}

#[cfg(test)]
pub(crate) fn schedule_bundled_cleanup_prewarm(_settings: &settings::Settings) {
    // Same reason as `schedule_dictation_model_prewarm`'s test stub: loading a
    // 484 MB GGUF into the test process (against the user's real Application
    // Support directory) would make the suite own native global state.
}

/// Load the bundled cleanup model in the background when it is the selected
/// dictation route and keep-warm is on, so the first dictation of the session
/// does not spend its 6 s budget on a cold load.
#[cfg(not(test))]
pub(crate) fn schedule_bundled_cleanup_prewarm(settings: &settings::Settings) {
    if settings
        .privacy
        .ai_lane(settings::AiLane::Dictation)
        .provider
        != llm::bundled_local::PROVIDER_SETTINGS_VALUE
    {
        return;
    }
    if !dictation_keep_warm_enabled(&settings.transcription.dictation_keep_warm) {
        return;
    }
    let Some(models_root) =
        crate::paths::data_dir().map(|dir| dir.join("Plainsong").join("models"))
    else {
        return;
    };
    if !llm::bundled_local::artifacts_trusted(&llm::bundled_local::model_dir(&models_root)) {
        // Not downloaded yet, or a receipt did not verify. The Models screen
        // is where that gets fixed; a warmup is not the place to say so.
        return;
    }
    tokio::task::spawn_blocking(move || match llm::bundled_local::prewarm(&models_root) {
        Ok(backend) => tracing::info!(
            "{} by {} warmed on {}",
            llm::bundled_local::MODEL_DISPLAY_NAME,
            llm::bundled_local::MODEL_VENDOR,
            backend
        ),
        Err(error) => tracing::warn!("Bundled cleanup model warmup failed: {}", error),
    });
}

/// Mirror the keep-warm setting into the bundled cleanup provider.
///
/// `keep_warm: "off"` used to mean only "skip the prewarm": the first real
/// cleanup loaded the model anyway and nothing short of deleting it ever let
/// go, so the switch saved memory exactly until the first dictation. The
/// provider now unloads itself after an idle interval when this is off, and
/// this is where the setting reaches it -- at startup and on every save, the
/// same two places the prewarm is scheduled from.
pub(crate) fn apply_bundled_cleanup_keep_warm(settings: &settings::Settings) {
    llm::bundled_local::set_keep_warm(dictation_keep_warm_enabled(
        &settings.transcription.dictation_keep_warm,
    ));
}

/// Whether switching the dictation lane from `previous` to `next` should drop
/// the resident bundled model.
///
/// Pointing the lane at Ollama or a cloud provider means nothing will ask the
/// bundled model for anything again, but its ~0.5 GB stayed resident for the
/// rest of the session because only `delete()` cleared the slot. Leaving the
/// route is the moment to let go of it.
pub(crate) fn bundled_cleanup_runtime_should_unload(previous: &str, next: &str) -> bool {
    previous == llm::bundled_local::PROVIDER_SETTINGS_VALUE
        && next != llm::bundled_local::PROVIDER_SETTINGS_VALUE
}

/// What the Models screen needs to render the bundled cleanup model's row.
pub(crate) fn bundled_cleanup_model_status() -> serde_json::Value {
    let models_root = crate::paths::data_dir()
        .map(|dir| dir.join("Plainsong").join("models"))
        .unwrap_or_default();
    let dir = llm::bundled_local::model_dir(&models_root);
    let missing = llm::bundled_local::untrusted_artifacts(&dir);
    let backend = llm::bundled_local::available_backend();
    serde_json::json!({
        "provider": llm::bundled_local::PROVIDER_SETTINGS_VALUE,
        "modelId": llm::bundled_local::MODEL_ID,
        "displayName": llm::bundled_local::MODEL_DISPLAY_NAME,
        "vendor": llm::bundled_local::MODEL_VENDOR,
        "downloadBytes": llm::bundled_local::total_download_bytes(),
        "bytesOnDisk": llm::bundled_local::bytes_on_disk(&models_root),
        "ready": missing.is_empty(),
        "missingFiles": missing,
        "path": dir.to_string_lossy(),
        // Which backend a cleanup would actually run on, and whether that
        // backend can meet the pre-insert budget. "Downloaded" and "usable"
        // are different questions here: on CPU a 200-word dictation takes
        // 11-13 s against a 6 s budget, so the Models screen has to say so
        // rather than let the user discover it as a recurring warning.
        "backend": backend,
        "backendMeetsBudget": llm::bundled_local::backend_meets_dictation_budget(backend),
        "backendPresent": llm::bundled_local::backend_is_present(backend),
        "residentBytes": llm::bundled_local::RESIDENT_BYTES,
    })
}

pub(crate) fn dictation_provider_uses_local_model(provider: asr::AsrProviderType) -> bool {
    matches!(
        provider,
        asr::AsrProviderType::Whisper
            | asr::AsrProviderType::WhisperCandle
            | asr::AsrProviderType::DistilWhisper
            | asr::AsrProviderType::Moonshine
            | asr::AsrProviderType::Parakeet
            | asr::AsrProviderType::Qwen3Asr
            | asr::AsrProviderType::CohereLocal
    )
}

pub(crate) const DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS: u64 = 45;

pub(crate) struct DictationModelPrewarmTask {
    pub(crate) provider: asr::AsrProviderType,
    pub(crate) model_id: String,
    pub(crate) handle: tokio::task::JoinHandle<()>,
}

#[cfg(not(test))]
pub(crate) static DICTATION_MODEL_PREWARM_TASKS: LazyLock<
    StdMutex<Vec<DictationModelPrewarmTask>>,
> = LazyLock::new(|| StdMutex::new(Vec::new()));

pub(crate) fn has_matching_model_prewarm(
    tasks: &[DictationModelPrewarmTask],
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    tasks
        .iter()
        .any(|task| task.provider == provider && task.model_id == model_id)
}

pub(crate) async fn join_background_tasks(tasks: Vec<tokio::task::JoinHandle<()>>) {
    // Local model initializers run through spawn_blocking. Aborting the async
    // wrapper detaches that native work instead of cancelling it, which lets
    // whisper.cpp keep touching global state while shutdown clears its caches.
    // Join the bounded warmup (it already has a 45-second timeout) before any
    // provider cache is released.
    for task in tasks {
        let _ = task.await;
    }
}

pub(crate) async fn acknowledge_dictation_model_warmup<F>(
    model_id: &str,
    warmup: F,
) -> Result<DictationModelWarmState, String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    match tokio::time::timeout(
        Duration::from_secs(DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS),
        warmup,
    )
    .await
    {
        Ok(Ok(())) => Ok(DictationModelWarmState::Ready),
        Ok(Err(error)) => Err(format!(
            "Could not prepare the selected local dictation model '{}': {}",
            model_id, error
        )),
        Err(_) => Err(format!(
            "Preparing the selected local dictation model '{}' exceeded {} seconds. Choose a smaller local model or try again.",
            model_id, DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS
        )),
    }
}

pub(crate) async fn prepare_dictation_model(
    provider: asr::AsrProviderType,
    model_id: &str,
    keep_warm: &str,
) -> Result<DictationModelWarmState, String> {
    if !dictation_provider_uses_local_model(provider) {
        return Ok(DictationModelWarmState::NotRequired);
    }
    if !dictation_keep_warm_enabled(keep_warm) {
        return Ok(DictationModelWarmState::Deferred);
    }

    let provider_runtime = asr::AsrProviderFactory::create_with_model(provider, Some(model_id));
    acknowledge_dictation_model_warmup(model_id, async move {
        provider_runtime
            .prewarm()
            .await
            .map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
pub(crate) fn schedule_dictation_model_prewarm(_transcription: &settings::TranscriptionSettings) {
    // Unit tests exercise startup and settings persistence with the user's
    // real Application Support directory. Loading a Metal model there makes
    // the test binary own native global state and can abort in whisper.cpp's
    // process teardown. Warmup behavior itself is tested deterministically
    // through `acknowledge_dictation_model_warmup`.
}

#[cfg(not(test))]
pub(crate) fn schedule_dictation_model_prewarm(transcription: &settings::TranscriptionSettings) {
    if !dictation_keep_warm_enabled(&transcription.dictation_keep_warm) {
        return;
    }
    let (provider, model_id) =
        resolve_transcription_provider_and_model(transcription, TranscriptionScope::Dictation);
    if !dictation_provider_uses_local_model(provider) {
        return;
    }
    let keep_warm = transcription.dictation_keep_warm.clone();
    let mut tasks = DICTATION_MODEL_PREWARM_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tasks.retain(|existing| !existing.handle.is_finished());
    if has_matching_model_prewarm(&tasks, provider, &model_id) {
        return;
    }
    let task_model_id = model_id.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = prepare_dictation_model(provider, &task_model_id, &keep_warm).await {
            // Startup remains usable so the readiness and model screens can
            // explain or repair the model. A dictation start repeats this
            // acknowledged handshake and surfaces the failure in the HUD.
            tracing::warn!("Background dictation model warmup failed: {}", error);
        }
    });
    tasks.push(DictationModelPrewarmTask {
        provider,
        model_id,
        handle: task,
    });
}

pub(crate) fn normalize_dictation_silence_timeout_seconds(value: f32) -> f32 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else {
        value.clamp(
            MIN_DICTATION_SILENCE_TIMEOUT_SECONDS,
            MAX_DICTATION_SILENCE_TIMEOUT_SECONDS,
        )
    }
}

/// Resolves the effective silence-auto-stop timeout for a dictation session,
/// applying the hands-free fallback described in the Settings UI: hands-free
/// sessions always auto-stop on silence, even if the user has silence
/// auto-stop disabled (0) for non-hands-free sessions, since hands-free has
/// no other way to end a session besides a second hotkey press.
pub(crate) fn resolve_dictation_auto_stop_silence_timeout_seconds(
    hands_free_enabled: bool,
    configured_silence_timeout_seconds: f32,
) -> f32 {
    if hands_free_enabled && configured_silence_timeout_seconds <= 0.0 {
        HANDS_FREE_DEFAULT_SILENCE_TIMEOUT_SECONDS
    } else {
        configured_silence_timeout_seconds
    }
}

pub(crate) fn normalize_color_scheme_value(_value: &str) -> String {
    // Plainsong ships a single palette; legacy multi-scheme values collapse
    // to "default" (matches the renderer's `theme-schemes.ts`).
    "default".to_string()
}

pub(crate) fn normalize_asr_model_id(
    provider_type: asr::AsrProviderType,
    model_id: &str,
) -> String {
    let trimmed = model_id.trim();
    let candidate = if trimmed.is_empty() {
        provider_type.default_model_id()
    } else {
        trimmed
    };

    if matches!(candidate, "macos_apple_speech" | "windows_sdk_dictation")
        && !matches!(
            provider_type,
            asr::AsrProviderType::MacosAppleSpeech | asr::AsrProviderType::WindowsSdkDictation
        )
    {
        return provider_type.default_model_id().to_string();
    }

    match provider_type {
        // The retired `parakeet-ctc-0.6b` / `parakeet-ctc-1.1b` ids fall through
        // to the v3 default, matching `asr::parakeet::normalize_parakeet_model_id`.
        asr::AsrProviderType::Parakeet => match candidate {
            "parakeet-tdt-0.6b-v2" | "parakeet-tdt-0.6b-v3" => candidate.to_string(),
            "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => "parakeet-tdt-ctc-110m".to_string(),
            _ => "parakeet-tdt-0.6b-v3".to_string(),
        },
        asr::AsrProviderType::WhisperCandle => "whisper-large-v3-turbo".to_string(),
        asr::AsrProviderType::Moonshine => match candidate {
            "moonshine" | "moonshine-base" => "moonshine-base".to_string(),
            "moonshine-tiny" => "moonshine-tiny".to_string(),
            _ => "moonshine-base".to_string(),
        },
        asr::AsrProviderType::MacosAppleSpeech => "macos_apple_speech".to_string(),
        asr::AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation".to_string(),
        _ => {
            if provider_type
                .model_options()
                .iter()
                .any(|option| option.id == candidate)
            {
                candidate.to_string()
            } else {
                provider_type.default_model_id().to_string()
            }
        }
    }
}

pub(crate) fn normalize_platform_mode(value: &str) -> &'static str {
    match value.trim() {
        "manual" => "manual",
        _ => "auto",
    }
}

pub(crate) fn normalize_platform_fallback_policy(value: &str) -> &'static str {
    match value.trim() {
        "allow_cloud" => "allow_cloud",
        "fail_fast" => "fail_fast",
        _ => "local_only",
    }
}

pub(crate) fn normalize_platform_engine_id(value: &str) -> Option<&'static str> {
    match value.trim() {
        "provider_default" => Some("provider_default"),
        "macos_apple_speech" => Some("macos_apple_speech"),
        // macos_mlx_sidecar was a stub engine with no production runtime
        // behind it (see `asr::platform::mlx_sidecar`) and has been retired;
        // rejecting it here drops it from `manual_engine_priority` on load
        // the same way other retired engine ids are dropped.
        "windows_foundry_local" => Some("windows_foundry_local"),
        "windows_sdk_dictation" => Some("windows_sdk_dictation"),
        _ => None,
    }
}

pub(crate) fn normalize_platform_optimization(
    settings: &mut settings::PlatformOptimizationSettings,
) {
    settings.mode = normalize_platform_mode(&settings.mode).to_string();
    settings.fallback_policy =
        normalize_platform_fallback_policy(&settings.fallback_policy).to_string();
    // Apple Speech is exposed only as its own dictation provider. Legacy engine
    // overrides could replace Whisper with Apple Speech and then fall back to
    // Whisper when Apple was unavailable, which made the selected route dishonest.
    settings.macos.apple_native_enabled = false;
    settings.manual_engine_priority = settings
        .manual_engine_priority
        .iter()
        .filter_map(|value| normalize_platform_engine_id(value))
        .filter(|value| *value != "macos_apple_speech")
        .map(ToString::to_string)
        .collect();
    if settings.mode == "manual" && settings.manual_engine_priority.is_empty() {
        settings.mode = "auto".to_string();
    }
}

pub(crate) fn provider_model_map_from_settings(
    transcription: &settings::TranscriptionSettings,
) -> HashMap<asr::AsrProviderType, String> {
    let mut map: HashMap<asr::AsrProviderType, String> = asr::AsrProviderType::all()
        .into_iter()
        .map(|pt| (pt, pt.default_model_id().to_string()))
        .collect();

    for (key, model_id) in &transcription.provider_model_ids {
        if let Some(pt) = asr_provider_from_settings_value(key) {
            let normalized = normalize_asr_model_id(pt, model_id);
            map.insert(pt, normalized);
        }
    }

    if let Some(default_provider) =
        asr_provider_from_settings_value(&transcription.default_provider)
    {
        let normalized = normalize_asr_model_id(default_provider, &transcription.selected_model_id);
        map.insert(default_provider, normalized);
    }

    if let Some(dictation_provider) =
        asr_provider_from_settings_value(&transcription.dictation_provider)
    {
        let normalized =
            normalize_asr_model_id(dictation_provider, &transcription.dictation_model_id);
        map.insert(dictation_provider, normalized);
    }

    if let Some(meeting_provider) =
        asr_provider_from_settings_value(&transcription.meeting_provider)
    {
        let normalized = normalize_asr_model_id(meeting_provider, &transcription.meeting_model_id);
        map.insert(meeting_provider, normalized);
    }

    map
}

pub(crate) fn provider_model_map_to_settings(
    map: &HashMap<asr::AsrProviderType, String>,
) -> HashMap<String, String> {
    map.iter()
        .map(|(pt, model_id)| {
            (
                asr_provider_to_settings_value(*pt).to_string(),
                model_id.clone(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contextual_settings_preserve_parakeet_v2() {
        assert_eq!(
            normalize_asr_model_id(asr::AsrProviderType::Parakeet, "parakeet-tdt-0.6b-v2",),
            "parakeet-tdt-0.6b-v2"
        );
    }
}
