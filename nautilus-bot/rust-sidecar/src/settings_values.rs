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
        screen_vocabulary: None,
        context_app_name: None,
        context_app_bundle_id: None,
        focused_field_fingerprint: None,
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
        // Like the trigger above: only the binding that started a session
        // knows whether it asked for Return.
        submit_after_insert: false,
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
fn bundled_cleanup_prewarm_enabled(settings: &settings::Settings) -> bool {
    // On an 8 GB Mac the cleanup model starts on demand instead, and leaves
    // two minutes after the last dictation.
    if crate::hardware_tier::current() == crate::hardware_tier::HardwareTier::Light
        || !dictation_keep_warm_enabled(&settings.transcription.dictation_keep_warm)
        || !dictation_llm_formatting_enabled(settings, &dictation_options_from_settings(settings))
    {
        return false;
    }
    let lane = settings.privacy.ai_lane(settings::AiLane::Dictation);
    let provider = active_dictation_custom_mode(settings)
        .and_then(|mode| mode.ai_provider.as_deref())
        .unwrap_or(&lane.provider);
    provider == llm::bundled_local::PROVIDER_SETTINGS_VALUE
}

#[cfg(not(test))]
pub(crate) fn schedule_bundled_cleanup_prewarm(settings: &settings::Settings) {
    if !bundled_cleanup_prewarm_enabled(settings) {
        return;
    }
    let Some(models_root) =
        crate::paths::data_dir().map(|dir| dir.join("Plainsong").join("models"))
    else {
        return;
    };
    if !llm::bundled_local::artifacts_installed(&llm::bundled_local::model_dir(&models_root)) {
        // Not downloaded yet, or this session found a file wrong. The Models screen
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

/// Mirror the speech-model settings into the ASR runtime: how long an unused
/// model stays loaded, and which Parakeet family suits the transcription
/// language. Called at startup and on every save.
pub(crate) fn apply_speech_model_residency(settings: &settings::Settings) {
    asr::speech_residency::set_keep_ready(&settings.transcription.speech_model_keep_ready);
    #[cfg(feature = "asr-transcribe-cpp")]
    {
        asr::neural_engine::set_transcription_language(settings.transcription.language.as_deref());
        // After the language: it picks which Parakeet family to fetch.
        schedule_neural_engine_maintenance(parakeet_serves_speech(&settings.transcription));
    }
}

#[cfg(feature = "asr-transcribe-cpp")]
fn parakeet_serves_speech(transcription: &settings::TranscriptionSettings) -> bool {
    [TranscriptionScope::Dictation, TranscriptionScope::Meeting]
        .into_iter()
        .any(|scope| {
            let (provider, model_id) =
                resolve_transcription_provider_and_model(transcription, scope);
            provider == asr::AsrProviderType::TranscribeCpp
                && asr::transcribe_cpp::route_spec_for(&model_id).model_id
                    == asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID
        })
}

/// Fetch or re-prepare the Neural Engine build of Parakeet in the background
/// when Parakeet serves dictation or meetings. A no-op on Macs that cannot
/// run it.
#[cfg(all(feature = "asr-transcribe-cpp", not(test)))]
fn schedule_neural_engine_maintenance(parakeet_selected: bool) {
    let Some(models_root) =
        crate::paths::data_dir().map(|dir| dir.join("Plainsong").join("models"))
    else {
        return;
    };
    asr::neural_engine::schedule_maintenance(models_root, parakeet_selected);
}

#[cfg(all(feature = "asr-transcribe-cpp", test))]
thread_local! {
    pub(crate) static NEURAL_ENGINE_MAINTENANCE_REQUESTS: std::cell::RefCell<Vec<bool>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Tests never download or compile models; they read what was asked for.
#[cfg(all(feature = "asr-transcribe-cpp", test))]
fn schedule_neural_engine_maintenance(parakeet_selected: bool) {
    NEURAL_ENGINE_MAINTENANCE_REQUESTS
        .with(|requests| requests.borrow_mut().push(parakeet_selected));
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
    apply_bundled_cleanup_keep_warm_to(llm::bundled_local::residency(), settings);
}

/// The same, against a given residency state, so a test can observe the
/// setting arriving without racing other tests that save settings.
pub(crate) fn apply_bundled_cleanup_keep_warm_to(
    residency: &'static llm::bundled_local::Residency,
    settings: &settings::Settings,
) {
    residency.set_keep_warm(dictation_keep_warm_enabled(
        &settings.transcription.dictation_keep_warm,
    ));
}

pub(crate) fn ollama_dictation_prewarm_model(settings: &settings::Settings) -> Option<String> {
    let options = dictation_options_from_settings(settings);
    ollama_dictation_prewarm_model_for_options(settings, &options)
}

pub(crate) fn ollama_dictation_prewarm_model_for_options(
    settings: &settings::Settings,
    options: &models::DictationStartOptions,
) -> Option<String> {
    if !dictation_keep_warm_enabled(&settings.transcription.dictation_keep_warm) {
        return None;
    }
    if !dictation_llm_formatting_enabled(settings, options) {
        return None;
    }
    let mut resolved = settings.clone();
    if let Some(custom) = active_dictation_custom_mode(settings) {
        if let Some(provider) = custom.ai_provider.as_deref() {
            resolved.privacy.dictation_ai.provider = provider.to_string();
        }
        if let Some(model_id) = custom.ai_model_id.as_deref() {
            resolved.privacy.dictation_ai.model_id = Some(model_id.to_string());
        }
    }
    let (provider, _, model) = dictation_session_ai_selection(&resolved).ok()?;
    if provider != AnalysisProvider::Ollama {
        return None;
    }
    Some(model)
}

#[cfg(not(test))]
struct OllamaDictationPrewarmTask {
    model_id: String,
    status: Arc<std::sync::atomic::AtomicU8>,
    handle: tokio::task::JoinHandle<()>,
}

const OLLAMA_PREWARM_RUNNING: u8 = 0;
const OLLAMA_PREWARM_SUCCEEDED: u8 = 1;
const OLLAMA_PREWARM_FAILED: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OllamaPrewarmTaskDecision {
    Keep,
    Start,
    Cancel,
    Replace,
}

fn ollama_prewarm_task_decision(
    target: Option<&str>,
    existing: Option<(&str, u8)>,
    recheck_success: bool,
) -> OllamaPrewarmTaskDecision {
    match (target, existing) {
        (None, None) => OllamaPrewarmTaskDecision::Keep,
        (None, Some(_)) => OllamaPrewarmTaskDecision::Cancel,
        (Some(_), None) => OllamaPrewarmTaskDecision::Start,
        (Some(target), Some((model, OLLAMA_PREWARM_FAILED))) if target == model => {
            OllamaPrewarmTaskDecision::Replace
        }
        (Some(target), Some((model, OLLAMA_PREWARM_SUCCEEDED)))
            if target == model && recheck_success =>
        {
            OllamaPrewarmTaskDecision::Replace
        }
        (Some(target), Some((model, _))) if target == model => OllamaPrewarmTaskDecision::Keep,
        (Some(_), Some(_)) => OllamaPrewarmTaskDecision::Replace,
    }
}

#[cfg(not(test))]
static OLLAMA_DICTATION_PREWARM_TASK: LazyLock<StdMutex<Option<OllamaDictationPrewarmTask>>> =
    LazyLock::new(|| StdMutex::new(None));

#[cfg(test)]
pub(crate) fn schedule_ollama_dictation_prewarm(
    _settings: &settings::Settings,
    _client: Arc<llm::OllamaClient>,
) {
}

#[cfg(not(test))]
pub(crate) fn schedule_ollama_dictation_prewarm(
    settings: &settings::Settings,
    client: Arc<llm::OllamaClient>,
) {
    schedule_ollama_dictation_prewarm_inner(settings, None, client, false)
}

#[cfg(not(test))]
pub(crate) fn schedule_ollama_dictation_prewarm_for_session(
    settings: &settings::Settings,
    options: &models::DictationStartOptions,
    client: Arc<llm::OllamaClient>,
) {
    schedule_ollama_dictation_prewarm_inner(settings, Some(options), client, true)
}

#[cfg(test)]
pub(crate) fn schedule_ollama_dictation_prewarm_for_session(
    _settings: &settings::Settings,
    _options: &models::DictationStartOptions,
    _client: Arc<llm::OllamaClient>,
) {
}

#[cfg(not(test))]
fn schedule_ollama_dictation_prewarm_inner(
    settings: &settings::Settings,
    options: Option<&models::DictationStartOptions>,
    client: Arc<llm::OllamaClient>,
    recheck_success: bool,
) {
    let target = options.map_or_else(
        || ollama_dictation_prewarm_model(settings),
        |options| ollama_dictation_prewarm_model_for_options(settings, options),
    );
    let mut slot = OLLAMA_DICTATION_PREWARM_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let existing = slot.as_ref().map(|task| {
        (
            task.model_id.as_str(),
            task.status.load(std::sync::atomic::Ordering::Acquire),
        )
    });
    match ollama_prewarm_task_decision(target.as_deref(), existing, recheck_success) {
        OllamaPrewarmTaskDecision::Keep => return,
        OllamaPrewarmTaskDecision::Cancel | OllamaPrewarmTaskDecision::Replace => {
            if let Some(previous) = slot.take() {
                previous.handle.abort();
            }
        }
        OllamaPrewarmTaskDecision::Start => {}
    }
    let Some(model_id) = target else { return };
    let status = Arc::new(std::sync::atomic::AtomicU8::new(OLLAMA_PREWARM_RUNNING));
    let task_status = Arc::clone(&status);
    let task_model = model_id.clone();
    let handle = tokio::spawn(async move {
        match client.prewarm_local_model(&task_model).await {
            Ok(()) => {
                task_status.store(
                    OLLAMA_PREWARM_SUCCEEDED,
                    std::sync::atomic::Ordering::Release,
                );
                tracing::info!("Ollama dictation model '{}' prewarmed", task_model);
            }
            Err(error) => {
                task_status.store(OLLAMA_PREWARM_FAILED, std::sync::atomic::Ordering::Release);
                tracing::warn!("Ollama dictation prewarm skipped: {}", error);
            }
        }
    });
    *slot = Some(OllamaDictationPrewarmTask {
        model_id,
        status,
        handle,
    });
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
    #[cfg(feature = "asr-transcribe-cpp")]
    if provider == asr::AsrProviderType::TranscribeCpp {
        return true;
    }
    matches!(
        provider,
        asr::AsrProviderType::Whisper
            | asr::AsrProviderType::WhisperCandle
            | asr::AsrProviderType::DistilWhisper
            | asr::AsrProviderType::Moonshine
            | asr::AsrProviderType::Parakeet
            | asr::AsrProviderType::Qwen3Asr
            | asr::AsrProviderType::CohereLocal
            | asr::AsrProviderType::Whistle
    )
}

type SpeechRoute = (asr::AsrProviderType, String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DictationSpeechSelection {
    pub(crate) requested: SpeechRoute,
    pub(crate) effective: SpeechRoute,
}

// Tracks speech residency without taking ownership away from shutdown's
// prewarm JoinHandles. The counter is released only after native warmup ends.
#[derive(Default)]
pub(crate) struct DictationModelReleaseCoordinator {
    generation: std::sync::atomic::AtomicU64,
    warmups: std::sync::atomic::AtomicUsize,
    routes: StdMutex<Vec<SpeechRoute>>,
    configured: StdMutex<Option<DictationSpeechSelection>>,
    actual_route: StdMutex<Option<(DictationSpeechSelection, SpeechRoute)>>,
    deferred_warmup: StdMutex<Option<SpeechRoute>>,
    changed: tokio::sync::Notify,
}

impl DictationModelReleaseCoordinator {
    pub(crate) fn remember(&self, provider: asr::AsrProviderType, model: String) {
        if !dictation_provider_uses_local_model(provider) {
            return;
        }
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        if !routes
            .iter()
            .any(|route| route == &(provider, model.clone()))
        {
            routes.push((provider, model));
        }
    }

    pub(crate) fn select_configured(&self, selection: DictationSpeechSelection) {
        let previous = self
            .configured
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(selection);
        // The replaced coordinator descriptor follows successful persistence,
        // unlike an early snapshot from another concurrent settings request.
        if let Some(previous) = previous {
            self.remember(previous.requested.0, previous.requested.1);
            self.remember(previous.effective.0, previous.effective.1);
        }
        self.notify();
    }

    pub(crate) fn remember_actual(&self, selection: DictationSpeechSelection, actual: SpeechRoute) {
        self.remember(actual.0, actual.1.clone());
        let configured = self.configured.lock().unwrap_or_else(|e| e.into_inner());
        // An older session must not overwrite the fallback of a newer setting.
        if configured.as_ref() == Some(&selection) {
            *self.actual_route.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((selection, actual));
        }
        drop(configured);
        self.notify();
    }

    fn remember_deferred_warmup(&self, route: SpeechRoute) {
        let configured = self.configured.lock().unwrap_or_else(|e| e.into_inner());
        if configured
            .as_ref()
            .is_some_and(|selection| selection.requested == route)
        {
            *self
                .deferred_warmup
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(route);
        }
    }

    fn record_background_warmup_result(
        &self,
        route: SpeechRoute,
        allow_retry: bool,
        result: &Result<DictationModelWarmState, String>,
    ) {
        if allow_retry && matches!(result, Ok(DictationModelWarmState::Deferred)) {
            self.remember_deferred_warmup(route);
        } else {
            let mut pending = self
                .deferred_warmup
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if pending.as_ref() == Some(&route) {
                *pending = None;
            }
        }
    }

    fn take_deferred_warmup(&self, keep_warm: bool) -> Option<SpeechRoute> {
        let configured = self.configured.lock().unwrap_or_else(|e| e.into_inner());
        let pending = self
            .deferred_warmup
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        pending.filter(|route| {
            keep_warm
                && configured
                    .as_ref()
                    .is_some_and(|selection| selection.requested == *route)
        })
    }

    fn unused_routes(&self, keep_warm: bool) -> Vec<SpeechRoute> {
        let configured = self.configured.lock().unwrap_or_else(|e| e.into_inner());
        let actual = self.actual_route.lock().unwrap_or_else(|e| e.into_inner());
        let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        if keep_warm && configured.is_none() {
            return Vec::new();
        }
        routes
            .iter()
            .filter(|route| {
                if !keep_warm && !asr::speech_residency::manages_route(route.0, &route.1) {
                    return true;
                }
                let Some(current) = configured.as_ref() else {
                    return false;
                };
                **route != current.requested
                    && **route != current.effective
                    && !actual.as_ref().is_some_and(|(selection, fallback)| {
                        selection == current && fallback == *route
                    })
            })
            .cloned()
            .collect()
    }

    /// Whether dictation would run on `route` now: the configured route, the
    /// one it resolves to, or the fallback the latest session actually used.
    /// Unknown (nothing configured yet) counts as yes.
    fn serves_dictation(&self, route: &SpeechRoute) -> bool {
        let configured = self.configured.lock().unwrap_or_else(|e| e.into_inner());
        let Some(current) = configured.as_ref() else {
            return true;
        };
        let actual = self.actual_route.lock().unwrap_or_else(|e| e.into_inner());
        current.requested == *route
            || current.effective == *route
            || actual
                .as_ref()
                .is_some_and(|(selection, fallback)| selection == current && fallback == route)
    }

    fn forget_released(&self, released: &[SpeechRoute]) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|route| !released.contains(route));
    }

    pub(crate) fn invalidate(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify();
        generation
    }

    fn begin_warmup(
        self: &Arc<Self>,
        provider: asr::AsrProviderType,
        model: String,
    ) -> DictationModelWarmupLease {
        self.remember(provider, model);
        self.warmups.fetch_add(1, Ordering::SeqCst);
        DictationModelWarmupLease(Arc::clone(self))
    }

    pub(crate) fn notify(&self) {
        self.changed.notify_waiters();
    }
}

struct DictationModelWarmupLease(Arc<DictationModelReleaseCoordinator>);
impl Drop for DictationModelWarmupLease {
    fn drop(&mut self) {
        self.0.warmups.fetch_sub(1, Ordering::SeqCst);
        self.0.notify();
    }
}

/// Called with settings locked after a successful replacement. Every save
/// invalidates the preceding worker, including Off -> On -> Off transitions.
pub(crate) fn reconcile_dictation_model_release(
    state: &AppState,
    transcription: &settings::TranscriptionSettings,
    current_selection: DictationSpeechSelection,
) {
    let coordinator = Arc::clone(&state.dictation_model_release);
    coordinator.select_configured(current_selection);
    spawn_dictation_model_release(
        state,
        dictation_keep_warm_enabled(&transcription.dictation_keep_warm),
    );
}

pub(crate) fn spawn_dictation_model_release(state: &AppState, keep_warm: bool) {
    let coordinator = Arc::clone(&state.dictation_model_release);
    let generation = coordinator.invalidate();
    let manager = Arc::clone(&state.asr_manager);
    let settings = Arc::clone(&state.settings_manager);
    let runtime = Arc::clone(&state.dictation_runtime_state);
    let operations = Arc::clone(&state.operation_coordinator);
    let shutting_down = Arc::clone(&state.sidecar_shutting_down);
    let operation_changes = operations.changes();
    tokio::spawn(run_pending_speech_release(
        coordinator.clone(),
        generation,
        operation_changes,
        move || {
            let coordinator = coordinator.clone();
            let manager = manager.clone();
            let settings = settings.clone();
            let runtime = runtime.clone();
            let operations = operations.clone();
            let shutting_down = shutting_down.clone();
            async move {
                if shutting_down.load(Ordering::SeqCst) {
                    return true;
                }
                // A warm worker stays parked for future actual-route changes.
                // Avoid taking a lease with no work: its Drop notification
                // would otherwise wake this same worker indefinitely.
                if coordinator.unused_routes(keep_warm).is_empty() {
                    return !keep_warm;
                }
                let gate = match llm::local_model_load::acquire_cleanup_gate().await {
                    Ok(gate) => gate,
                    Err(error) => {
                        tracing::warn!("Deferred speech release refused: {error}");
                        return true;
                    }
                };
                // Hold settings through synchronous eviction so another save
                // cannot re-enable warmth between validation and cleanup.
                let settings_guard = settings.lock().await;
                let runtime_guard = runtime.lock().await;
                if coordinator.generation.load(Ordering::SeqCst) != generation
                    || shutting_down.load(Ordering::SeqCst)
                {
                    return true;
                }
                if *runtime_guard != DictationSessionState::Idle
                    || coordinator.warmups.load(Ordering::SeqCst) != 0
                {
                    return false;
                }
                let current_keep_warm = dictation_keep_warm_enabled(
                    &settings_guard.settings().transcription.dictation_keep_warm,
                );
                let routes = coordinator.unused_routes(current_keep_warm);
                if routes.is_empty() {
                    return !current_keep_warm;
                }
                let _activity = match operations
                    .try_acquire(operation_coordinator::OperationKind::ModelRelease)
                {
                    Ok(lease) => lease,
                    Err(_) => return false,
                };
                for (provider, model) in &routes {
                    manager.clear_resolved_local_route_after_gate(*provider, model, &gate);
                }
                coordinator.forget_released(&routes);
                let retry = coordinator.take_deferred_warmup(current_keep_warm);
                let transcription = settings_guard.settings().transcription.clone();
                // A new initializer must acquire its own gates, never inherit
                // the cleanup gate or activity lease used for eviction.
                drop(_activity);
                drop(runtime_guard);
                drop(gate);
                if retry.is_some() {
                    schedule_dictation_model_prewarm_once(&transcription, &coordinator, false);
                }
                // Keep validation and scheduling serialized against saves.
                drop(settings_guard);
                !current_keep_warm
            }
        },
    ));
}

/// Whether a meeting waiting for memory may drop the cached model of one of
/// `routes` (the route as requested and as it resolves).
///
/// A route dictation does not use is the meeting's own to release. One that
/// dictation shares is released under the same conditions as the idle
/// release in [`spawn_dictation_model_release`]: no dictation session or
/// warmup in flight, and keep-warm off -- otherwise the next dictation would
/// pay a cold load the user asked to avoid, or lose a model mid-session.
fn meeting_may_release_route(
    coordinator: &DictationModelReleaseCoordinator,
    routes: &[SpeechRoute],
    dictation_idle: bool,
    keep_warm: bool,
) -> bool {
    // A live dictation session or warmup may be on a route the coordinator
    // never recorded (a custom mode can name its own model), so nothing is
    // released while dictation is busy.
    if !dictation_idle || coordinator.warmups.load(Ordering::SeqCst) != 0 {
        return false;
    }
    !keep_warm
        || !routes
            .iter()
            .any(|route| coordinator.serves_dictation(route))
}

/// Release the meeting route's cached model before a long memory wait, unless
/// dictation is relying on it. Returns whether it was released.
///
/// Takes the cleanup gate, then settings, then the dictation session state --
/// the order the idle release uses -- and holds them through the eviction, so
/// a dictation cannot start on the route between the check and the release.
pub(crate) async fn release_meeting_route_for_memory_wait(
    state: &AppState,
    provider: asr::AsrProviderType,
    model: &str,
) -> bool {
    let requested = (provider, model.to_string());
    let resolved = state
        .asr_manager
        .resolved_local_route_for_cleanup(provider, model)
        .await;
    let gate = match llm::local_model_load::acquire_cleanup_gate().await {
        Ok(gate) => gate,
        Err(error) => {
            tracing::warn!("Meeting model release refused: {error}");
            return false;
        }
    };
    let settings_guard = state.settings_manager.lock().await;
    let runtime_guard = state.dictation_runtime_state.lock().await;
    let keep_warm =
        dictation_keep_warm_enabled(&settings_guard.settings().transcription.dictation_keep_warm);
    if !meeting_may_release_route(
        &state.dictation_model_release,
        &[requested, resolved.clone()],
        *runtime_guard == DictationSessionState::Idle,
        keep_warm,
    ) {
        tracing::info!(
            "Keeping {} {} loaded through the memory wait: dictation uses it",
            resolved.0.display_name(),
            resolved.1
        );
        return false;
    }
    state
        .asr_manager
        .clear_resolved_local_route_after_gate(resolved.0, &resolved.1, &gate);
    drop(runtime_guard);
    drop(settings_guard);
    true
}

async fn run_pending_speech_release<F, Fut>(
    coordinator: Arc<DictationModelReleaseCoordinator>,
    generation: u64,
    operation_changes: Arc<tokio::sync::Notify>,
    mut attempt: F,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    loop {
        // Register before checking. A native warmup or meeting can finish
        // between the check and await without losing its notification.
        let changed = coordinator.changed.notified();
        let operation_changed = operation_changes.notified();
        tokio::pin!(changed, operation_changed);
        changed.as_mut().enable();
        operation_changed.as_mut().enable();
        if coordinator.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if coordinator.warmups.load(Ordering::SeqCst) == 0 && attempt().await {
            return;
        }
        tokio::select! { _ = &mut changed => {}, _ = &mut operation_changed => {} }
    }
}

#[cfg(test)]
mod speech_release_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn selection(model: &str) -> DictationSpeechSelection {
        let route = (asr::AsrProviderType::Whisper, model.to_string());
        DictationSpeechSelection {
            requested: route.clone(),
            effective: route,
        }
    }

    #[test]
    fn a_meeting_memory_wait_never_releases_the_model_dictation_keeps_warm() {
        let coordinator = Arc::new(DictationModelReleaseCoordinator::default());
        let dictation = selection("base.en");
        coordinator.select_configured(dictation.clone());
        let shared = [dictation.requested.clone(), dictation.effective.clone()];
        let other = [(
            asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3".to_string(),
        )];

        // Same route as dictation: keep-warm on, a live session, or a warmup
        // in flight each keep the model.
        assert!(!meeting_may_release_route(
            &coordinator,
            &shared,
            true,
            true
        ));
        assert!(!meeting_may_release_route(
            &coordinator,
            &shared,
            false,
            false
        ));
        let warmup = coordinator.begin_warmup(dictation.requested.0, dictation.requested.1.clone());
        assert!(!meeting_may_release_route(
            &coordinator,
            &shared,
            true,
            false
        ));
        drop(warmup);
        // Idle, nothing warming, keep-warm off: the idle release would drop
        // it too, so the meeting may.
        assert!(meeting_may_release_route(
            &coordinator,
            &shared,
            true,
            false
        ));

        // A route dictation does not use is the meeting's own while dictation
        // is idle. A live session may be a custom mode on that very route,
        // which the coordinator never records, so nothing is released then.
        assert!(meeting_may_release_route(&coordinator, &other, true, true));
        assert!(!meeting_may_release_route(
            &coordinator,
            &other,
            false,
            true
        ));
        let warmup = coordinator.begin_warmup(other[0].0, other[0].1.clone());
        assert!(!meeting_may_release_route(&coordinator, &other, true, true));
        drop(warmup);

        // A fallback the latest dictation session actually ran on counts as
        // dictation's too.
        coordinator.remember_actual(dictation.clone(), other[0].clone());
        assert!(!meeting_may_release_route(&coordinator, &other, true, true));
    }

    #[test]
    fn deferred_warmup_is_consumed_once_and_stale_or_disabled_requests_are_discarded() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let old = selection("base.en");
        let current = selection("small.en");
        coordinator.select_configured(current.clone());
        coordinator.remember_deferred_warmup(current.effective.clone());
        assert_eq!(
            coordinator.take_deferred_warmup(true),
            Some(current.effective.clone())
        );
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.remember_deferred_warmup(old.effective.clone());
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.remember_deferred_warmup(current.effective.clone());
        coordinator.select_configured(old.clone());
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.remember_deferred_warmup(old.effective.clone());
        assert_eq!(coordinator.take_deferred_warmup(false), None);
        assert_eq!(coordinator.take_deferred_warmup(true), None);
    }

    #[test]
    fn retry_refusal_or_success_never_rearms_background_warmup() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let current = selection("base.en");
        coordinator.select_configured(current.clone());
        coordinator.record_background_warmup_result(
            current.effective.clone(),
            true,
            &Ok(DictationModelWarmState::Deferred),
        );
        assert_eq!(
            coordinator.take_deferred_warmup(true),
            Some(current.effective.clone())
        );
        coordinator.record_background_warmup_result(
            current.effective.clone(),
            false,
            &Ok(DictationModelWarmState::Deferred),
        );
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.record_background_warmup_result(
            current.effective.clone(),
            true,
            &Ok(DictationModelWarmState::Ready),
        );
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.record_background_warmup_result(
            current.effective,
            true,
            &Err("native admission refused".into()),
        );
        assert_eq!(coordinator.take_deferred_warmup(true), None);
    }

    #[test]
    fn requested_warmup_retry_survives_fallback_and_completion_only_clears_its_route() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let mut current = selection("base.en");
        current.effective = (
            asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3".into(),
        );
        coordinator.select_configured(current.clone());
        coordinator.record_background_warmup_result(
            current.requested.clone(),
            true,
            &Ok(DictationModelWarmState::Deferred),
        );
        assert_eq!(
            coordinator.take_deferred_warmup(true),
            Some(current.requested.clone())
        );
        coordinator.remember_deferred_warmup(current.requested.clone());
        coordinator.record_background_warmup_result(
            current.effective.clone(),
            true,
            &Ok(DictationModelWarmState::Ready),
        );
        assert_eq!(
            coordinator.take_deferred_warmup(true),
            Some(current.requested.clone())
        );
        coordinator.remember_deferred_warmup(current.requested.clone());
        coordinator.record_background_warmup_result(
            current.requested,
            true,
            &Ok(DictationModelWarmState::Ready),
        );
        assert_eq!(coordinator.take_deferred_warmup(true), None);
    }

    #[tokio::test]
    async fn eviction_consumes_one_retry_and_notifications_cannot_rearm_it() {
        let coordinator = Arc::new(DictationModelReleaseCoordinator::default());
        let old = selection("base.en");
        let current = selection("small.en");
        coordinator.select_configured(old);
        coordinator.select_configured(current.clone());
        coordinator.record_background_warmup_result(
            current.requested,
            true,
            &Ok(DictationModelWarmState::Deferred),
        );
        let retries = Arc::new(AtomicUsize::new(0));
        let work = coordinator.clone();
        let count = retries.clone();
        let task = tokio::spawn(run_pending_speech_release(
            coordinator.clone(),
            0,
            Arc::new(tokio::sync::Notify::new()),
            move || {
                let routes = work.unused_routes(true);
                work.forget_released(&routes);
                if !routes.is_empty() {
                    if let Some(route) = work.take_deferred_warmup(true) {
                        count.fetch_add(1, Ordering::SeqCst);
                        work.record_background_warmup_result(
                            route,
                            false,
                            &Ok(DictationModelWarmState::Deferred),
                        );
                    }
                }
                async { false }
            },
        ));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(retries.load(Ordering::SeqCst), 1);
        for _ in 0..5 {
            coordinator.notify();
            tokio::task::yield_now().await;
        }
        assert_eq!(retries.load(Ordering::SeqCst), 1);
        assert_eq!(coordinator.take_deferred_warmup(true), None);
        coordinator.invalidate();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn speech_residency_auto_preserves_other_models_startup_prewarm() {
        assert!(startup_speech_prewarm_for_route(
            asr::AsrProviderType::Whisper,
            "base.en",
            true,
            false,
        ));
        assert!(!startup_speech_prewarm_for_route(
            asr::AsrProviderType::Whisper,
            "base.en",
            false,
            true,
        ));
    }

    #[cfg(feature = "asr-transcribe-cpp")]
    #[test]
    fn speech_residency_survives_the_legacy_keep_warm_switch() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let route = (
            asr::AsrProviderType::TranscribeCpp,
            asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID.to_string(),
        );
        coordinator.select_configured(DictationSpeechSelection {
            requested: route.clone(),
            effective: route.clone(),
        });
        coordinator.remember(route.0, route.1.clone());
        assert!(
            coordinator.unused_routes(false).is_empty(),
            "The Parakeet idle timer, including Always, owns the current model"
        );
        coordinator.select_configured(selection("base.en"));
        assert!(
            coordinator.unused_routes(false).contains(&route),
            "Changing speech models must still release the previous route"
        );
    }

    #[test]
    fn route_switch_retires_old_actual_without_waiting_for_another_session() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let old = selection("base.en");
        let new = selection("small.en");
        coordinator.select_configured(old.clone());
        coordinator.remember_actual(old.clone(), old.effective.clone());
        coordinator.select_configured(new.clone());
        coordinator.remember(new.requested.0, new.requested.1.clone());
        assert_eq!(coordinator.unused_routes(true), vec![old.effective]);
        assert!(!coordinator.unused_routes(true).contains(&new.effective));
    }

    #[test]
    fn unrelated_save_keeps_pending_retirement_and_protects_current_fallback() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let old = selection("base.en");
        let current = selection("small.en");
        let fallback = (
            asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3".into(),
        );
        coordinator.select_configured(old.clone());
        coordinator.remember_actual(old.clone(), old.effective.clone());
        coordinator.select_configured(current.clone());
        coordinator.remember_actual(current.clone(), fallback.clone());
        coordinator.select_configured(current.clone());
        assert_eq!(coordinator.unused_routes(true), vec![old.effective]);
        assert!(!coordinator.unused_routes(true).contains(&fallback));
        assert!(!coordinator.unused_routes(true).contains(&current.effective));
    }

    #[test]
    fn stale_session_cannot_replace_a_current_fallback() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let old = selection("base.en");
        let current = selection("small.en");
        let fallback = (
            asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3".into(),
        );
        coordinator.select_configured(current.clone());
        coordinator.remember_actual(current.clone(), fallback.clone());
        coordinator.remember_actual(old.clone(), old.effective.clone());
        assert_eq!(coordinator.unused_routes(true), vec![old.effective]);
        assert!(!coordinator.unused_routes(true).contains(&fallback));
    }

    #[test]
    fn replacing_fallback_retires_previous_fallback_and_off_retires_every_route() {
        let coordinator = DictationModelReleaseCoordinator::default();
        let current = selection("base.en");
        let fallback = (
            asr::AsrProviderType::Parakeet,
            "parakeet-tdt-0.6b-v3".into(),
        );
        coordinator.select_configured(current.clone());
        coordinator.remember_actual(current.clone(), fallback.clone());
        coordinator.remember_actual(current.clone(), current.effective.clone());
        assert_eq!(coordinator.unused_routes(true), vec![fallback.clone()]);
        coordinator.forget_released(&[fallback]);
        assert!(coordinator.unused_routes(true).is_empty());
        assert_eq!(coordinator.unused_routes(false), vec![current.effective]);
    }

    #[tokio::test]
    async fn parked_warm_worker_does_not_spin_when_no_routes_need_release() {
        let coordinator = Arc::new(DictationModelReleaseCoordinator::default());
        coordinator.select_configured(selection("base.en"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let calls = attempts.clone();
        let task = tokio::spawn(run_pending_speech_release(
            coordinator.clone(),
            0,
            Arc::new(tokio::sync::Notify::new()),
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { false }
            },
        ));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        coordinator.invalidate();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn pending_release_waits_for_owned_warmup_and_activity_then_runs_once() {
        let coordinator = Arc::new(DictationModelReleaseCoordinator::default());
        let warmup = coordinator.begin_warmup(asr::AsrProviderType::Whisper, "base.en".into());
        let activity = Arc::new(AtomicBool::new(true));
        let count = Arc::new(AtomicUsize::new(0));
        let changes = Arc::new(tokio::sync::Notify::new());
        let busy = activity.clone();
        let calls = count.clone();
        let task = tokio::spawn(run_pending_speech_release(
            coordinator.clone(),
            0,
            changes.clone(),
            move || {
                let busy = busy.clone();
                let calls = calls.clone();
                async move {
                    if busy.load(Ordering::SeqCst) {
                        false
                    } else {
                        calls.fetch_add(1, Ordering::SeqCst);
                        true
                    }
                }
            },
        ));
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(!task.is_finished());
        drop(warmup);
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(!task.is_finished());
        activity.store(false, Ordering::SeqCst);
        changes.notify_waiters();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn enabling_keep_warm_invalidates_pending_release_without_aborting_warmup() {
        let coordinator = Arc::new(DictationModelReleaseCoordinator::default());
        let warmup = coordinator.begin_warmup(asr::AsrProviderType::Whisper, "base.en".into());
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let task = tokio::spawn(run_pending_speech_release(
            coordinator.clone(),
            0,
            Arc::new(tokio::sync::Notify::new()),
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { true }
            },
        ));
        tokio::task::yield_now().await;
        coordinator.generation.fetch_add(1, Ordering::SeqCst);
        coordinator.notify();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.warmups.load(Ordering::SeqCst), 1);
        drop(warmup);
        assert_eq!(coordinator.warmups.load(Ordering::SeqCst), 0);
    }

    #[test]
    #[cfg(feature = "asr-transcribe-cpp")]
    fn release_registry_retains_the_actual_fallback_and_transcribe_cpp_routes() {
        let coordinator = DictationModelReleaseCoordinator::default();
        coordinator.remember(asr::AsrProviderType::Parakeet, "requested".into());
        coordinator.remember(asr::AsrProviderType::Whisper, "fallback".into());
        coordinator.remember(asr::AsrProviderType::TranscribeCpp, "bundled".into());
        let routes = coordinator.routes.lock().unwrap();
        assert_eq!(routes.len(), 3);
        assert!(routes.contains(&(asr::AsrProviderType::Whisper, "fallback".into())));
        assert!(routes.contains(&(asr::AsrProviderType::TranscribeCpp, "bundled".into())));
    }

    #[test]
    fn release_registry_retains_only_exact_local_routes_without_duplicates() {
        let coordinator = DictationModelReleaseCoordinator::default();
        coordinator.remember(asr::AsrProviderType::Whisper, "base.en".into());
        coordinator.remember(asr::AsrProviderType::Whisper, "base.en".into());
        coordinator.remember(asr::AsrProviderType::Whisper, "small.en".into());
        coordinator.remember(asr::AsrProviderType::OpenAiCloud, "cloud".into());
        assert_eq!(
            *coordinator.routes.lock().unwrap(),
            vec![
                (asr::AsrProviderType::Whisper, "base.en".into()),
                (asr::AsrProviderType::Whisper, "small.en".into())
            ]
        );
    }
}

pub(crate) const DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS: u64 = 45;

pub(crate) struct DictationModelPrewarmTask {
    pub(crate) provider: asr::AsrProviderType,
    pub(crate) model_id: String,
    pub(crate) handle: tokio::task::JoinHandle<()>,
    /// Flips to true when the warmup finishes, however it finishes.
    pub(crate) done: tokio::sync::watch::Receiver<bool>,
}

/// Marks a warmup finished even if its task panics or is aborted.
#[cfg(not(test))]
struct PrewarmDone(tokio::sync::watch::Sender<bool>);
#[cfg(not(test))]
impl Drop for PrewarmDone {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

/// Wait for every in-flight warmup of this model. The final decode admits its
/// own native load with try-acquire, so starting it while a warmup still
/// holds the runtime would fail as busy instead of waiting.
pub(crate) async fn wait_for_matching_prewarms(
    mut pending: Vec<tokio::sync::watch::Receiver<bool>>,
) {
    let bound = Duration::from_secs(DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS + 5);
    for done in &mut pending {
        let _ = tokio::time::timeout(bound, done.wait_for(|finished| *finished)).await;
    }
}

#[cfg(not(test))]
pub(crate) async fn wait_for_dictation_model_prewarm(
    provider: asr::AsrProviderType,
    model_id: &str,
) {
    let pending: Vec<_> = DICTATION_MODEL_PREWARM_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter(|task| {
            task.provider == provider && task.model_id == model_id && !task.handle.is_finished()
        })
        .map(|task| task.done.clone())
        .collect();
    wait_for_matching_prewarms(pending).await;
}

#[cfg(test)]
pub(crate) async fn wait_for_dictation_model_prewarm(
    _provider: asr::AsrProviderType,
    _model_id: &str,
) {
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
        .any(|task| task.provider == provider && task.model_id == model_id && !*task.done.borrow())
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
    let mut warmup = Box::pin(warmup);
    match tokio::time::timeout(
        Duration::from_secs(DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS),
        warmup.as_mut(),
    )
    .await
    {
        Ok(Ok(())) => Ok(DictationModelWarmState::Ready),
        Ok(Err(error)) => Err(format!(
            "Could not prepare the selected local dictation model '{}': {}",
            model_id, error
        )),
        Err(_) => {
            tracing::warn!(model_id, "Speech model warmup timed out; retaining ownership until the native worker finishes");
            // spawn_blocking cannot be cancelled by dropping its JoinHandle.
            // Keep this tracked task alive so shutdown cannot clear caches or
            // tear down native state while an initializer is still running.
            let _ = warmup.await;
            Err(format!(
                "Preparing the selected local dictation model '{}' exceeded {} seconds. Choose a smaller local model or try again.",
                model_id, DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS
            ))
        }
    }
}

/// Why a speech model is warming. A background warm-up is optional and waits
/// for headroom; a session warm-up only moves the load the stop would make
/// anyway, so it goes straight to the load's own admission.
fn startup_speech_prewarm_for_route(
    provider: asr::AsrProviderType,
    model_id: &str,
    legacy_keep_warm: bool,
    speech_always_ready: bool,
) -> bool {
    legacy_keep_warm
        && (!asr::speech_residency::manages_route(provider, model_id) || speech_always_ready)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WarmupReason {
    Background,
    Session,
}

pub(crate) async fn prepare_dictation_model(
    provider: asr::AsrProviderType,
    model_id: &str,
    keep_warm: &str,
    reason: WarmupReason,
) -> Result<DictationModelWarmState, String> {
    if !dictation_provider_uses_local_model(provider) {
        return Ok(DictationModelWarmState::NotRequired);
    }
    if !dictation_keep_warm_enabled(keep_warm) {
        return Ok(DictationModelWarmState::Deferred);
    }

    let provider_runtime = asr::AsrProviderFactory::create_with_model(provider, Some(model_id));
    if reason == WarmupReason::Background
        && !llm::speech_prewarm_has_current_headroom(
            provider,
            model_id,
            provider_runtime.model_info().size_mb,
        )
    {
        tracing::info!(model_id, "Automatic speech model warmup deferred: insufficient or unknown current memory headroom");
        return Ok(DictationModelWarmState::Deferred);
    }
    acknowledge_dictation_model_warmup(model_id, async move {
        // The native gate admits one load at a time without waiting. Losing a
        // race to another warm-up (startup cleanup, for example) is not a
        // failure; try again briefly so the model is warm when speech ends.
        let busy_deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            match provider_runtime.prewarm().await {
                Err(error)
                    if llm::native_runtime_is_busy(&error.to_string())
                        && std::time::Instant::now() < busy_deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                other => break other.map_err(|error| error.to_string()),
            }
        }
    })
    .await
}

#[cfg(test)]
pub(crate) fn schedule_dictation_model_prewarm(
    _transcription: &settings::TranscriptionSettings,
    _coordinator: &Arc<DictationModelReleaseCoordinator>,
) {
    schedule_dictation_model_prewarm_once(_transcription, _coordinator, true);
}

#[cfg(test)]
fn schedule_dictation_model_prewarm_once(
    _transcription: &settings::TranscriptionSettings,
    _coordinator: &Arc<DictationModelReleaseCoordinator>,
    _allow_retry: bool,
) {
    // Unit tests exercise startup and settings persistence with the user's
    // real Application Support directory. Loading a Metal model there makes
    // the test binary own native global state and can abort in whisper.cpp's
    // process teardown. Warmup behavior itself is tested deterministically
    // through `acknowledge_dictation_model_warmup`.
}

#[cfg(not(test))]
pub(crate) fn schedule_dictation_model_prewarm(
    transcription: &settings::TranscriptionSettings,
    coordinator: &Arc<DictationModelReleaseCoordinator>,
) {
    schedule_dictation_model_prewarm_once(transcription, coordinator, true);
}

#[cfg(not(test))]
fn schedule_dictation_model_prewarm_once(
    transcription: &settings::TranscriptionSettings,
    coordinator: &Arc<DictationModelReleaseCoordinator>,
    allow_retry: bool,
) {
    let (provider, model_id) =
        resolve_transcription_provider_and_model(transcription, TranscriptionScope::Dictation);
    if !startup_speech_prewarm_for_route(
        provider,
        &model_id,
        dictation_keep_warm_enabled(&transcription.dictation_keep_warm),
        asr::speech_residency::startup_prewarm_allowed(),
    ) {
        return;
    }
    if !dictation_provider_uses_local_model(provider) {
        return;
    }
    spawn_dictation_model_prewarm(
        provider,
        model_id,
        transcription.dictation_keep_warm.clone(),
        coordinator,
        allow_retry,
        WarmupReason::Background,
    );
}

#[cfg(not(test))]
fn spawn_dictation_model_prewarm(
    provider: asr::AsrProviderType,
    model_id: String,
    keep_warm: String,
    coordinator: &Arc<DictationModelReleaseCoordinator>,
    allow_retry: bool,
    reason: WarmupReason,
) {
    let mut tasks = DICTATION_MODEL_PREWARM_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tasks.retain(|existing| !existing.handle.is_finished());
    if allow_retry && has_matching_model_prewarm(&tasks, provider, &model_id) {
        return;
    }
    let task_model_id = model_id.clone();
    let warmup_lease = coordinator.begin_warmup(provider, model_id.clone());
    let task_coordinator = Arc::clone(coordinator);
    let (done_sender, done) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let _done = PrewarmDone(done_sender);
        let _warmup_lease = warmup_lease;
        let result = prepare_dictation_model(provider, &task_model_id, &keep_warm, reason).await;
        task_coordinator.record_background_warmup_result(
            (provider, task_model_id.clone()),
            allow_retry,
            &result,
        );
        if let Err(error) = result {
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
        done,
    });
}

/// Start a hotkey session without waiting for the speech model: the
/// microphone opens immediately and the model loads in the background under
/// the same warmup lease and shutdown join as startup prewarm. Its memory
/// check is the load's own admission, which the stop would apply anyway.
#[cfg(not(test))]
pub(crate) fn begin_session_dictation_model_warmup(
    coordinator: &Arc<DictationModelReleaseCoordinator>,
    provider: asr::AsrProviderType,
    model_id: &str,
    keep_warm: &str,
) -> DictationModelWarmState {
    if !dictation_provider_uses_local_model(provider) {
        return DictationModelWarmState::NotRequired;
    }
    if !dictation_keep_warm_enabled(keep_warm) {
        return DictationModelWarmState::Deferred;
    }
    spawn_dictation_model_prewarm(
        provider,
        model_id.to_string(),
        keep_warm.to_string(),
        coordinator,
        true,
        WarmupReason::Session,
    );
    DictationModelWarmState::Loading
}

/// Unit tests never load native models; the decision is the same, without
/// spawning the warmup.
#[cfg(test)]
pub(crate) fn begin_session_dictation_model_warmup(
    _coordinator: &Arc<DictationModelReleaseCoordinator>,
    provider: asr::AsrProviderType,
    _model_id: &str,
    keep_warm: &str,
) -> DictationModelWarmState {
    if !dictation_provider_uses_local_model(provider) {
        DictationModelWarmState::NotRequired
    } else if dictation_keep_warm_enabled(keep_warm) {
        DictationModelWarmState::Loading
    } else {
        DictationModelWarmState::Deferred
    }
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
            "parakeet-tdt-0.6b-v2" | "parakeet-tdt-0.6b-v3" | "orukeet-v0.1.0-int8" => {
                candidate.to_string()
            }
            "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => "parakeet-tdt-ctc-110m".to_string(),
            _ => "parakeet-tdt-0.6b-v3".to_string(),
        },
        asr::AsrProviderType::WhisperCandle => "whisper-large-v3-turbo".to_string(),
        asr::AsrProviderType::Whistle => asr::whistle::MODEL_ID.to_string(),
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

    #[test]
    fn bundled_prewarm_requires_active_cleanup_and_keep_warm() {
        let mut settings = settings::Settings::default();
        settings.privacy.dictation_ai.provider = "bundled_local".into();
        settings.transcription.dictation_mode_preset = "voice".into();
        settings.transcription.dictation_ai_formatting = false;
        settings.transcription.dictation_keep_warm = "on".into();
        assert!(!bundled_cleanup_prewarm_enabled(&settings));
        settings.transcription.dictation_ai_formatting = true;
        assert!(bundled_cleanup_prewarm_enabled(&settings));
        settings.transcription.dictation_keep_warm = "off".into();
        assert!(!bundled_cleanup_prewarm_enabled(&settings));
        settings.transcription.dictation_keep_warm = "on".into();
        settings.privacy.dictation_ai.provider = "ollama".into();
        assert!(!bundled_cleanup_prewarm_enabled(&settings));
    }

    #[test]
    fn bundled_prewarm_uses_custom_modes_actual_route_and_rewrite_intent() {
        let mut settings = settings::Settings::default();
        settings.transcription.dictation_keep_warm = "on".into();
        settings.transcription.dictation_ai_formatting = false;
        settings.privacy.dictation_ai.provider = "ollama".into();
        settings.transcription.dictation_mode_preset = "custom".into();
        settings.transcription.dictation_selected_custom_mode_id = Some("local".into());
        settings.transcription.dictation_custom_modes = vec![settings::DictationCustomMode {
            id: "local".into(),
            name: "Local rewrite".into(),
            profile: "power_rewrite".into(),
            custom_prompt: Some("Polish this.".into()),
            ai_provider: Some("bundled_local".into()),
            ..Default::default()
        }];
        assert!(bundled_cleanup_prewarm_enabled(&settings));
        settings.privacy.dictation_ai.provider = "bundled_local".into();
        settings.transcription.dictation_custom_modes[0].ai_provider = Some("ollama".into());
        assert!(!bundled_cleanup_prewarm_enabled(&settings));
        settings.transcription.dictation_custom_modes[0].ai_provider = None;
        assert!(bundled_cleanup_prewarm_enabled(&settings));
    }

    #[test]
    fn ollama_prewarm_requires_keep_warm_active_ai_and_local_ollama() {
        let mut settings = settings::Settings::default();
        settings.privacy.dictation_ai.provider = "ollama".to_string();
        settings.privacy.dictation_ai.model_id = Some("gemma4:e4b".to_string());
        assert_eq!(ollama_dictation_prewarm_model(&settings), None);

        settings.transcription.dictation_ai_formatting = true;
        assert_eq!(
            ollama_dictation_prewarm_model(&settings).as_deref(),
            Some("gemma4:e4b")
        );
        settings.transcription.dictation_keep_warm = "off".to_string();
        assert_eq!(ollama_dictation_prewarm_model(&settings), None);
        settings.transcription.dictation_keep_warm = "on".to_string();
        settings.privacy.dictation_ai.provider = "bundled_local".to_string();
        assert_eq!(ollama_dictation_prewarm_model(&settings), None);

        settings.privacy.dictation_ai.provider = "ollama".to_string();
        settings.privacy.dictation_ai.model_id = None;
        assert_eq!(
            ollama_dictation_prewarm_model(&settings).as_deref(),
            Some(AnalysisProvider::Ollama.default_model())
        );
        settings.privacy.dictation_ai.model_id = Some("   ".to_string());
        assert_eq!(
            ollama_dictation_prewarm_model(&settings).as_deref(),
            Some(AnalysisProvider::Ollama.default_model())
        );
    }

    #[test]
    fn ollama_prewarm_uses_the_active_custom_modes_actual_ai_model() {
        let mut settings = settings::Settings::default();
        settings.privacy.dictation_ai.provider = "openai".to_string();
        settings.transcription.dictation_mode_preset = "custom".to_string();
        settings.transcription.dictation_selected_custom_mode_id = Some("local".to_string());
        settings.transcription.dictation_custom_modes = vec![settings::DictationCustomMode {
            id: "local".to_string(),
            name: "Local rewrite".to_string(),
            profile: "power_rewrite".to_string(),
            custom_prompt: Some("Polish this.".to_string()),
            ai_provider: Some("ollama".to_string()),
            ai_model_id: Some("local-exact:tag".to_string()),
            ..Default::default()
        }];
        assert_eq!(
            ollama_dictation_prewarm_model(&settings).as_deref(),
            Some("local-exact:tag")
        );
    }

    #[test]
    fn ollama_prewarm_task_decisions_retry_only_failures_and_cancel_obsolete_targets() {
        assert_eq!(
            ollama_prewarm_task_decision(Some("m"), None, false),
            OllamaPrewarmTaskDecision::Start
        );
        for status in [OLLAMA_PREWARM_RUNNING, OLLAMA_PREWARM_SUCCEEDED] {
            assert_eq!(
                ollama_prewarm_task_decision(Some("m"), Some(("m", status)), false),
                OllamaPrewarmTaskDecision::Keep
            );
        }
        assert_eq!(
            ollama_prewarm_task_decision(Some("m"), Some(("m", OLLAMA_PREWARM_FAILED)), false),
            OllamaPrewarmTaskDecision::Replace
        );
        assert_eq!(
            ollama_prewarm_task_decision(Some("new"), Some(("old", OLLAMA_PREWARM_RUNNING)), false),
            OllamaPrewarmTaskDecision::Replace
        );
        assert_eq!(
            ollama_prewarm_task_decision(None, Some(("old", OLLAMA_PREWARM_RUNNING)), false),
            OllamaPrewarmTaskDecision::Cancel
        );
        assert_eq!(
            ollama_prewarm_task_decision(Some("m"), Some(("m", OLLAMA_PREWARM_SUCCEEDED)), true,),
            OllamaPrewarmTaskDecision::Replace
        );
        assert_eq!(
            ollama_prewarm_task_decision(Some("m"), Some(("m", OLLAMA_PREWARM_RUNNING)), true,),
            OllamaPrewarmTaskDecision::Keep
        );
    }

    #[test]
    fn transient_power_rewrite_session_is_eligible_even_when_global_formatting_is_off() {
        let mut settings = settings::Settings::default();
        settings.privacy.dictation_ai.provider = "ollama".to_string();
        settings.privacy.dictation_ai.model_id = Some("session:model".to_string());
        settings.transcription.dictation_ai_formatting = false;
        let options = models::DictationStartOptions {
            profile: models::DictationProfile::PowerRewrite,
            ..Default::default()
        };
        assert_eq!(
            ollama_dictation_prewarm_model_for_options(&settings, &options).as_deref(),
            Some("session:model")
        );
    }
}
