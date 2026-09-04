//! Which recogniser runs, and on what.
//!
//! The provider/model vocabulary the settings file speaks, the route policy
//! and hosting-environment rules that decide whether a remote provider is
//! allowed at all, the support tables for the meeting lane, the ordered
//! candidate lists for both lanes, and the fallback message shown when the
//! requested route could not be used.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn asr_provider_to_settings_value(provider: asr::AsrProviderType) -> &'static str {
    match provider {
        asr::AsrProviderType::Whisper => "whisper",
        asr::AsrProviderType::Parakeet => "parakeet",
        asr::AsrProviderType::WhisperCandle => "whisper_candle",
        asr::AsrProviderType::DistilWhisper => "distil_whisper",
        asr::AsrProviderType::MacosAppleSpeech => "macos_apple_speech",
        asr::AsrProviderType::Moonshine => "moonshine",
        asr::AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation",
        asr::AsrProviderType::ElevenLabsScribe => "elevenlabs_scribe",
        asr::AsrProviderType::OpenAiCloud => "openai_cloud",
        asr::AsrProviderType::Groq => "groq",
        asr::AsrProviderType::CohereTranscribe => "cohere_transcribe",
        asr::AsrProviderType::CohereLocal => "cohere_local",
        asr::AsrProviderType::Qwen3Asr => "qwen3_asr",
        asr::AsrProviderType::Deepgram => "deepgram",
        asr::AsrProviderType::MistralVoxtral => "mistral_voxtral",
        asr::AsrProviderType::GeminiTranscribe => "gemini_transcribe",
        #[cfg(feature = "asr-transcribe-cpp")]
        asr::AsrProviderType::TranscribeCpp => "transcribe_cpp",
    }
}

pub(crate) fn asr_provider_from_settings_value(value: &str) -> Option<asr::AsrProviderType> {
    match value {
        "whisper" => Some(asr::AsrProviderType::Whisper),
        "parakeet" => Some(asr::AsrProviderType::Parakeet),
        "whisper_candle" | "canary" => Some(asr::AsrProviderType::WhisperCandle),
        "distil_whisper" => Some(asr::AsrProviderType::DistilWhisper),
        "macos_apple_speech" => Some(asr::AsrProviderType::MacosAppleSpeech),
        "moonshine" => Some(asr::AsrProviderType::Moonshine),
        "windows_sdk_dictation" => Some(asr::AsrProviderType::WindowsSdkDictation),
        "elevenlabs_scribe" => Some(asr::AsrProviderType::ElevenLabsScribe),
        "openai_cloud" => Some(asr::AsrProviderType::OpenAiCloud),
        "groq" => Some(asr::AsrProviderType::Groq),
        "cohere_transcribe" => Some(asr::AsrProviderType::CohereTranscribe),
        "cohere_local" => Some(asr::AsrProviderType::CohereLocal),
        "qwen3_asr" => Some(asr::AsrProviderType::Qwen3Asr),
        "deepgram" => Some(asr::AsrProviderType::Deepgram),
        "mistral_voxtral" => Some(asr::AsrProviderType::MistralVoxtral),
        "gemini_transcribe" => Some(asr::AsrProviderType::GeminiTranscribe),
        #[cfg(feature = "asr-transcribe-cpp")]
        "transcribe_cpp" => Some(asr::AsrProviderType::TranscribeCpp),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub(crate) enum TranscriptionScope {
    Dictation,
    Meeting,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingRoutePolicy {
    PreferLocal,
    BestAvailable,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DictationRoutePreference {
    Local,
    Cloud,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostingEnvironment {
    Local,
    Cloud,
}

pub(crate) fn meeting_route_policy_from_settings(value: &str) -> MeetingRoutePolicy {
    match value.trim() {
        "best_available" => MeetingRoutePolicy::BestAvailable,
        _ => MeetingRoutePolicy::PreferLocal,
    }
}

pub(crate) fn dictation_route_preference_from_settings(value: &str) -> DictationRoutePreference {
    match value.trim() {
        "cloud" => DictationRoutePreference::Cloud,
        _ => DictationRoutePreference::Local,
    }
}

pub(crate) fn dictation_route_preference_to_settings_value(
    preference: DictationRoutePreference,
) -> &'static str {
    match preference {
        DictationRoutePreference::Local => "local",
        DictationRoutePreference::Cloud => "cloud",
    }
}

pub(crate) fn dictation_route_preference_from_option(
    value: Option<&str>,
    fallback: &str,
) -> DictationRoutePreference {
    value
        .map(dictation_route_preference_from_settings)
        .unwrap_or_else(|| dictation_route_preference_from_settings(fallback))
}

pub(crate) fn hosting_environment_to_settings_value(hosting: HostingEnvironment) -> &'static str {
    match hosting {
        HostingEnvironment::Local => "local",
        HostingEnvironment::Cloud => "cloud",
    }
}

/// Hosting is currently decided by the provider alone. `_model_id` is kept in the
/// signature because hosting is a property of the *route*, not the provider: Voxtral
/// used to be local or cloud depending on the model, and any future provider with
/// both a local and a hosted model would need the same distinction back.
pub(crate) fn provider_hosting_environment(
    provider: asr::AsrProviderType,
    _model_id: &str,
) -> HostingEnvironment {
    // New hosted providers must inherit the canonical privacy classification
    // instead of falling through a hand-written match as local.
    if provider.is_remote() {
        HostingEnvironment::Cloud
    } else {
        HostingEnvironment::Local
    }
}

pub(crate) fn route_matches_hosting(
    preference: DictationRoutePreference,
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    match preference {
        DictationRoutePreference::Local => {
            provider_hosting_environment(provider, model_id) == HostingEnvironment::Local
        }
        DictationRoutePreference::Cloud => {
            provider_hosting_environment(provider, model_id) == HostingEnvironment::Cloud
        }
    }
}

pub(crate) fn provider_is_dictation_only(provider: asr::AsrProviderType) -> bool {
    !meeting_provider_is_supported(provider)
}

/// Whether a stored meeting route can only ever serve dictation.
///
/// Provider-level for every engine but whisper.cpp, whose meeting support is
/// per model: `base.en` in the meeting slot is dictation-only, `large-v3-turbo`
/// is not. Deciding this at the route level is what lets the resolver keep
/// falling through to Parakeet for the small English models without also
/// throwing away an explicit multilingual selection.
pub(crate) fn meeting_route_is_dictation_only(
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    match provider {
        asr::AsrProviderType::Whisper => !meeting_model_is_supported(provider, model_id),
        _ => provider_is_dictation_only(provider),
    }
}

// ---------------------------------------------------------------------------
// Dictation live preview: which engine draws it
// ---------------------------------------------------------------------------

pub(crate) fn provider_supports_generic_live_preview(provider: asr::AsrProviderType) -> bool {
    !provider.is_remote() && provider != asr::AsrProviderType::MacosAppleSpeech
}

pub(crate) fn provider_allows_automatic_dictation_fallback(provider: asr::AsrProviderType) -> bool {
    provider != asr::AsrProviderType::MacosAppleSpeech
}

/// Whether a provider can serve the meeting lane at all.
///
/// Pinned against the renderer's `MEETING_GRADE_PROVIDER_SET` by
/// `every_meeting_grade_provider_matches_in_both_languages`. The two lists
/// diverging is not cosmetic: `provider_is_dictation_only` is its inverse, and
/// settings normalization rewrites a meeting selection the sidecar calls
/// dictation-only back to Parakeet, so a provider missing here is a meeting
/// route the user chose and cannot keep.
pub(crate) fn meeting_provider_is_supported(provider: asr::AsrProviderType) -> bool {
    meeting_provider_is_supported_with(
        provider,
        crate::asr::platform::macos_speech::meetings_supported(),
    )
}

/// Whether a provider may serve meetings, given whether the Apple Speech route
/// is currently meeting-capable.
///
/// Apple Speech is the one provider whose answer depends on the machine: it
/// reaches meetings only through SpeechAnalyzer (macOS 26+ with the language
/// installed), which is the only one of its two engines that returns the
/// per-segment timestamps `transcribe_recording_in_chunks` offsets and merges.
/// SFSpeechRecognizer stays dictation-only, as it has always been. The flag is
/// passed in rather than read here so the policy is testable without a Mac.
pub(crate) fn meeting_provider_is_supported_with(
    provider: asr::AsrProviderType,
    apple_speech_meeting_capable: bool,
) -> bool {
    if provider == asr::AsrProviderType::MacosAppleSpeech {
        return apple_speech_meeting_capable;
    }
    matches!(
        provider,
        asr::AsrProviderType::Parakeet
            | asr::AsrProviderType::DistilWhisper
            | asr::AsrProviderType::ElevenLabsScribe
            | asr::AsrProviderType::OpenAiCloud
            | asr::AsrProviderType::Groq
            | asr::AsrProviderType::CohereTranscribe
            | asr::AsrProviderType::Qwen3Asr
            | asr::AsrProviderType::Deepgram
            | asr::AsrProviderType::GeminiTranscribe
            | asr::AsrProviderType::MistralVoxtral
            // whisper.cpp is meeting-capable per model, not per provider:
            // see `WHISPER_MEETING_MODEL_IDS`. It never enters the meeting
            // lane on its own (`preferred_meeting_provider_candidates`), only
            // when the meeting slot names one of those models outright.
            | asr::AsrProviderType::Whisper
    ) || {
        // Only exists when the spike is compiled in; a default build has no
        // such variant to match. It returns the same segment rows with
        // timestamps as the shipped local routes (see transcribe_cpp.rs's
        // segment contract), which is what the meeting lane needs, and the
        // renderer already lists it.
        #[cfg(feature = "asr-transcribe-cpp")]
        {
            provider == asr::AsrProviderType::TranscribeCpp
        }
        #[cfg(not(feature = "asr-transcribe-cpp"))]
        {
            false
        }
    }
}

/// The whisper.cpp ggml models allowed in the meeting lane.
///
/// Multilingual weights from `small` up: they carry the ~100-language
/// coverage Parakeet v3 (25 European languages) and Distil-Whisper (English)
/// lack, and whisper.cpp returns per-segment timestamps for them, which is
/// what `transcribe_recording_in_chunks` offsets and merges. `tiny` and
/// `base` are left out on accuracy: this repo's own benchmark shows base.en
/// mis-transcribing unfamiliar words, and the multilingual weights of the same
/// size are worse still. Every `.en` build is left out because the meeting
/// lane exists here for the languages English-only models cannot hear.
pub(crate) const WHISPER_MEETING_MODEL_IDS: &[&str] =
    &["small", "medium", "large-v3", "large-v3-turbo"];

pub(crate) fn meeting_model_is_supported(provider: asr::AsrProviderType, model_id: &str) -> bool {
    if !meeting_provider_is_supported(provider) {
        return false;
    }

    let candidate = normalize_asr_model_id(provider, model_id);
    if provider == asr::AsrProviderType::Whisper {
        return WHISPER_MEETING_MODEL_IDS.contains(&candidate.as_str());
    }
    provider
        .model_options()
        .iter()
        .any(|option| option.id == candidate)
}

pub(crate) fn default_meeting_model_id(provider: asr::AsrProviderType) -> &'static str {
    match provider {
        // The provider default (`base.en`) is dictation-only; the meeting slot
        // needs a model that is actually allowed there.
        asr::AsrProviderType::Whisper => "large-v3-turbo",
        _ => provider.default_model_id(),
    }
}

pub(crate) fn normalize_meeting_model_id(provider: asr::AsrProviderType, model_id: &str) -> String {
    let normalized = normalize_asr_model_id(provider, model_id);
    if meeting_model_is_supported(provider, &normalized) {
        normalized
    } else {
        default_meeting_model_id(provider).to_string()
    }
}

pub(crate) fn meeting_route_is_shared_compatible(
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    meeting_provider_is_supported(provider) && meeting_model_is_supported(provider, model_id)
}

pub(crate) fn ensure_meeting_route_supported(
    provider: asr::AsrProviderType,
    model_id: &str,
) -> Result<(), String> {
    if meeting_route_is_shared_compatible(provider, model_id) {
        return Ok(());
    }

    let apple_speech_choice = if crate::asr::platform::macos_speech::meetings_supported() {
        "Apple Speech, "
    } else {
        ""
    };
    Err(format!(
        "Meetings require a meeting-grade ASR route. '{}' with model '{}' is dictation-only or unsupported for meetings. Choose {}Parakeet, whisper.cpp small/medium/large-v3/large-v3-turbo, Distil Whisper, Qwen3-ASR, ElevenLabs, OpenAI, Groq, Cohere, Deepgram, Gemini Transcribe, or Mistral Voxtral in Settings -> ASR / Providers.",
        provider.display_name(),
        model_id,
        apple_speech_choice
    ))
}

pub(crate) fn preferred_meeting_provider_candidates(
    policy: MeetingRoutePolicy,
    default_provider: asr::AsrProviderType,
    dictation_provider: asr::AsrProviderType,
    meeting_provider: Option<asr::AsrProviderType>,
    meeting_model_id: Option<&str>,
) -> Vec<asr::AsrProviderType> {
    let mut candidates = Vec::new();
    let explicit_candidates = [
        meeting_provider,
        Some(default_provider),
        Some(dictation_provider),
    ];
    let local_defaults = [
        Some(asr::AsrProviderType::Parakeet),
        Some(asr::AsrProviderType::DistilWhisper),
    ];

    let mut ordered_candidates = Vec::new();
    ordered_candidates.extend(explicit_candidates);
    ordered_candidates.extend(local_defaults);

    for provider in ordered_candidates.into_iter().flatten() {
        // A stored API key proves capability, not consent to upload meeting audio.
        // Remote repair is allowed only for the explicitly selected meeting slot.
        let hosting_allowed = match policy {
            MeetingRoutePolicy::PreferLocal => !provider.is_remote(),
            MeetingRoutePolicy::BestAvailable => {
                !provider.is_remote() || meeting_provider == Some(provider)
            }
        };
        // whisper.cpp is a meeting candidate only when the meeting slot itself
        // names a meeting-grade ggml model. Inheriting it from the default or
        // dictation slot would silently move every `base.en` install's
        // meetings onto a 1.6 GB model nobody downloaded, when Parakeet is
        // both ranked first and usually already on disk.
        let supported = if provider == asr::AsrProviderType::Whisper {
            meeting_provider == Some(provider)
                && meeting_model_id.is_some_and(|model_id| {
                    meeting_model_is_supported(asr::AsrProviderType::Whisper, model_id)
                })
        } else if provider == asr::AsrProviderType::MacosAppleSpeech {
            // Same rule as whisper.cpp, for the same reason: eligible is not
            // the same as chosen. Inheriting it from the dictation or default
            // slot would silently move an existing reader's meetings onto a
            // different engine the first time they updated to macOS 26.
            meeting_provider == Some(provider) && meeting_provider_is_supported(provider)
        } else {
            meeting_provider_is_supported(provider)
        };
        if hosting_allowed && supported && !candidates.contains(&provider) {
            candidates.push(provider);
        }
    }
    candidates
}

pub(crate) fn preferred_meeting_provider(
    policy: MeetingRoutePolicy,
    default_provider: asr::AsrProviderType,
    dictation_provider: asr::AsrProviderType,
    meeting_provider: Option<asr::AsrProviderType>,
    meeting_model_id: Option<&str>,
) -> asr::AsrProviderType {
    if let Some(provider) = preferred_meeting_provider_candidates(
        policy,
        default_provider,
        dictation_provider,
        meeting_provider,
        meeting_model_id,
    )
    .into_iter()
    .next()
    {
        return provider;
    }

    asr::AsrProviderType::Parakeet
}

pub(crate) fn preferred_dictation_provider_candidates(
    preference: DictationRoutePreference,
    default_provider: asr::AsrProviderType,
    dictation_provider: asr::AsrProviderType,
) -> Vec<asr::AsrProviderType> {
    let mut candidates = Vec::new();
    let local_defaults = [
        asr::AsrProviderType::DistilWhisper,
        asr::AsrProviderType::MacosAppleSpeech,
        asr::AsrProviderType::WindowsSdkDictation,
        asr::AsrProviderType::Whisper,
        asr::AsrProviderType::Moonshine,
        asr::AsrProviderType::Parakeet,
        asr::AsrProviderType::WhisperCandle,
    ];
    let cloud_defaults = [
        asr::AsrProviderType::OpenAiCloud,
        asr::AsrProviderType::ElevenLabsScribe,
        asr::AsrProviderType::Groq,
    ];

    let mut ordered_candidates = Vec::new();
    ordered_candidates.push(dictation_provider);
    ordered_candidates.push(default_provider);
    match preference {
        DictationRoutePreference::Local => {
            ordered_candidates.extend(local_defaults);
            ordered_candidates.extend(cloud_defaults);
        }
        DictationRoutePreference::Cloud => {
            ordered_candidates.extend(cloud_defaults);
            ordered_candidates.extend(local_defaults);
        }
    }

    for provider in ordered_candidates {
        if !candidates.contains(&provider) {
            candidates.push(provider);
        }
    }

    candidates
}

pub(crate) fn select_ready_dictation_candidate(
    provider_infos: &[asr::manager::ProviderInfo],
    preferred_candidates: &[asr::AsrProviderType],
    preference: DictationRoutePreference,
) -> Option<(asr::AsrProviderType, String)> {
    preferred_candidates.iter().find_map(|candidate_provider| {
        provider_infos
            .iter()
            .find(|info| {
                info.provider_type == *candidate_provider
                    && info.provider_type != asr::AsrProviderType::Moonshine
                    && matches!(info.runtime_status, asr::manager::RuntimeStatus::Ready)
                    && info.is_available
                    && info.inference_enabled
                    && route_matches_hosting(
                        preference,
                        info.provider_type,
                        &info.selected_model_id,
                    )
            })
            .map(|info| (info.provider_type, info.selected_model_id.clone()))
    })
}

pub(crate) fn preferred_same_provider_dictation_fallback_model(
    provider_type: asr::AsrProviderType,
    requested_model_id: &str,
    preference: DictationRoutePreference,
    _models_root: &Path,
) -> Option<String> {
    if !matches!(preference, DictationRoutePreference::Local) {
        return None;
    }

    match provider_type {
        asr::AsrProviderType::Moonshine if requested_model_id == "moonshine-tiny" => None,
        _ => None,
    }
}

pub(crate) fn select_ready_meeting_candidate(
    provider_infos: &[asr::manager::ProviderInfo],
    preferred_candidates: &[asr::AsrProviderType],
    policy: MeetingRoutePolicy,
) -> Option<(asr::AsrProviderType, String)> {
    preferred_candidates.iter().find_map(|candidate_provider| {
        provider_infos
            .iter()
            .find(|info| {
                // Enforce the boundary again at selection time so candidate-list
                // ordering cannot weaken PreferLocal into an upload permission.
                let hosting_allowed = !matches!(policy, MeetingRoutePolicy::PreferLocal)
                    || !info.provider_type.is_remote();
                info.provider_type == *candidate_provider
                    && hosting_allowed
                    && matches!(info.runtime_status, asr::manager::RuntimeStatus::Ready)
                    && info.is_available
                    && meeting_route_is_shared_compatible(
                        info.provider_type,
                        &info.selected_model_id,
                    )
            })
            .map(|info| (info.provider_type, info.selected_model_id.clone()))
    })
}

pub(crate) fn normalize_contextual_asr_settings(
    transcription: &mut settings::TranscriptionSettings,
) {
    let meeting_policy = meeting_route_policy_from_settings(&transcription.meeting_route_policy);
    let default_provider = asr_provider_from_settings_value(&transcription.default_provider)
        .unwrap_or(asr::AsrProviderType::Whisper);
    transcription.dictation_route_preference =
        normalize_dictation_route_preference(&transcription.dictation_route_preference).to_string();
    transcription.dictation_vad_backend =
        audio::vad::VadBackendKind::from_settings_str(&transcription.dictation_vad_backend)
            .as_settings_str()
            .to_string();
    transcription.default_provider = asr_provider_to_settings_value(default_provider).to_string();
    transcription.selected_model_id =
        normalize_asr_model_id(default_provider, &transcription.selected_model_id);

    let dictation_provider = asr_provider_from_settings_value(&transcription.dictation_provider)
        .unwrap_or(default_provider);
    transcription.dictation_provider =
        asr_provider_to_settings_value(dictation_provider).to_string();
    transcription.dictation_model_id = normalize_asr_model_id(
        dictation_provider,
        if transcription.dictation_model_id.trim().is_empty() {
            &transcription.selected_model_id
        } else {
            &transcription.dictation_model_id
        },
    );

    if transcription.use_shared_asr_selection {
        if meeting_route_is_shared_compatible(default_provider, &transcription.selected_model_id) {
            transcription.dictation_provider = transcription.default_provider.clone();
            transcription.dictation_model_id = transcription.selected_model_id.clone();
            transcription.meeting_provider = transcription.default_provider.clone();
            transcription.meeting_model_id =
                normalize_meeting_model_id(default_provider, &transcription.selected_model_id);
            return;
        } else {
            transcription.use_shared_asr_selection = false;
            transcription.dictation_provider = transcription.default_provider.clone();
            transcription.dictation_model_id = transcription.selected_model_id.clone();
        }
    }

    let requested_meeting_provider =
        asr_provider_from_settings_value(&transcription.meeting_provider);
    let meeting_provider = preferred_meeting_provider(
        meeting_policy,
        default_provider,
        dictation_provider,
        requested_meeting_provider.or(Some(default_provider)),
        Some(transcription.meeting_model_id.as_str()),
    );
    transcription.meeting_provider = asr_provider_to_settings_value(meeting_provider).to_string();
    transcription.meeting_model_id = normalize_meeting_model_id(
        meeting_provider,
        if transcription.meeting_model_id.trim().is_empty() {
            &transcription.selected_model_id
        } else {
            &transcription.meeting_model_id
        },
    );
    migrate_mlx_providers_to_slot_flags(transcription);
}

/// One-time migration: if `mlx_accelerated_providers` contains the dictation or meeting provider
/// and the slot-specific flag has never been set (still false), enable it automatically.
pub(crate) fn migrate_mlx_providers_to_slot_flags(
    transcription: &mut settings::TranscriptionSettings,
) {
    let dictation_key = transcription.dictation_provider.as_str();
    if !transcription.dictation_mlx_enabled
        && transcription
            .mlx_accelerated_providers
            .iter()
            .any(|p| p == dictation_key)
    {
        transcription.dictation_mlx_enabled = true;
    }
    let meeting_key = transcription.meeting_provider.as_str();
    if !transcription.meeting_mlx_enabled
        && transcription
            .mlx_accelerated_providers
            .iter()
            .any(|p| p == meeting_key)
    {
        transcription.meeting_mlx_enabled = true;
    }
}

pub(crate) fn resolve_transcription_provider_and_model(
    transcription: &settings::TranscriptionSettings,
    scope: TranscriptionScope,
) -> (asr::AsrProviderType, String) {
    let meeting_policy = meeting_route_policy_from_settings(&transcription.meeting_route_policy);
    let (provider_value, model_value) = if transcription.use_shared_asr_selection {
        (
            transcription.default_provider.as_str(),
            transcription.selected_model_id.as_str(),
        )
    } else {
        match scope {
            TranscriptionScope::Dictation => (
                transcription.dictation_provider.as_str(),
                transcription.dictation_model_id.as_str(),
            ),
            TranscriptionScope::Meeting => (
                transcription.meeting_provider.as_str(),
                transcription.meeting_model_id.as_str(),
            ),
        }
    };

    let provider =
        asr_provider_from_settings_value(provider_value).unwrap_or(asr::AsrProviderType::Whisper);
    let provider = if matches!(scope, TranscriptionScope::Meeting)
        && meeting_route_is_dictation_only(provider, model_value)
    {
        preferred_meeting_provider(
            meeting_policy,
            asr_provider_from_settings_value(&transcription.default_provider)
                .unwrap_or(asr::AsrProviderType::Whisper),
            asr_provider_from_settings_value(&transcription.dictation_provider)
                .unwrap_or(asr::AsrProviderType::Whisper),
            asr_provider_from_settings_value(&transcription.meeting_provider),
            Some(transcription.meeting_model_id.as_str()),
        )
    } else {
        provider
    };
    let model_id = if matches!(scope, TranscriptionScope::Meeting) {
        normalize_meeting_model_id(provider, model_value)
    } else {
        normalize_asr_model_id(provider, model_value)
    };
    (provider, model_id)
}

pub(crate) fn build_provider_fallback_message(
    requested_provider: asr::AsrProviderType,
    actual_provider: asr::AsrProviderType,
    fallback_reason: Option<&str>,
    optimization_applied: bool,
) -> Option<String> {
    // A remap the runtime chose deliberately is an optimization, not a fallback.
    // Suppress the warning.
    if requested_provider == actual_provider || optimization_applied {
        return None;
    }

    let reason = fallback_reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Requested provider could not complete transcription.");

    Some(format!(
        "ASR fallback: requested '{}' but used '{}'. {}",
        requested_provider.display_name(),
        actual_provider.display_name(),
        reason
    ))
}
