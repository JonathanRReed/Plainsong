use super::{
    platform::{
        macos_speech::AppleSpeechReadiness, EngineDiagnostics, EngineProbe, PlatformEngine,
    },
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionOptions, TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

// Parakeet legacy 110M: one sherpa-onnx CTC graph plus tokens. `encoder.onnx`
// is what `scripts/provision-asr-assets.mjs` writes; `model.onnx` is what older
// in-app downloads left behind. `asr/parakeet.rs` accepts either, so diagnostics
// must too — checking only one is how "Ready" and "model missing" came to
// disagree.
const PARAKEET_ONNX_NAMES: [&str; 2] = ["encoder.onnx", "model.onnx"];
const PARAKEET_VOCAB_NAMES: [&str; 1] = ["tokens.txt"];
// Parakeet TDT v3: three ONNX graphs plus tokens, with the same size floors as
// `PARAKEET_V3_ARTIFACTS` in `asr/parakeet.rs`.
const PARAKEET_V3_REQUIRED_FILES: [(&str, u64); 4] = [
    ("encoder.int8.onnx", 64 * 1024 * 1024),
    ("decoder.int8.onnx", 1024 * 1024),
    ("joiner.int8.onnx", 512 * 1024),
    ("tokens.txt", 4096),
];
// Whisper Candle: Whisper Large V3 Turbo via Candle (no Python)
const WHISPER_CANDLE_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];
// DistilWhisper: Candle native (no Python)
const DISTIL_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];
/// Manages multiple ASR providers
pub struct AsrManager {
    default_provider: RwLock<AsrProviderType>,
    selected_model_id: RwLock<String>,
    provider_model_ids: RwLock<HashMap<AsrProviderType, String>>,
    /// Legacy global set, kept for provider-info display and backward-compat callers.
    mlx_accelerated_providers: RwLock<HashSet<AsrProviderType>>,
    /// Per-slot MLX flags, these are the authoritative source for routing.
    dictation_mlx_enabled: RwLock<bool>,
    meeting_mlx_enabled: RwLock<bool>,
    /// `transcription.language` as the user set it, mirrored here so the
    /// meeting lane -- which builds its own options and never sees the
    /// settings -- can tell a cloud provider what to listen for.
    transcription_language: RwLock<Option<String>>,
    silence_skip_enabled: RwLock<bool>,
    platform_optimization: RwLock<crate::settings::PlatformOptimizationSettings>,
    last_runtime_errors: RwLock<HashMap<AsrProviderType, String>>,
    provider_inventory_cache: RwLock<Option<Vec<ProviderInventory>>>,
    provider_info_cache: RwLock<Option<Vec<ProviderInfo>>>,
    remote_processing_gate: RwLock<Option<Arc<crate::remote_processing::RemoteProcessingGate>>>,
    models_dir: PathBuf,
}

fn has_provider_secret_or_env(secret_name: &str, env_name: &str) -> bool {
    match crate::secrets::get_provider_secret(secret_name) {
        Ok(Some(secret)) if !secret.trim().is_empty() => true,
        _ => std::env::var(env_name)
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
    }
}

impl AsrManager {
    pub fn new() -> Self {
        let models_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");

        std::fs::create_dir_all(&models_dir).ok();
        migrate_legacy_local_artifacts(&models_dir);

        let provider_model_ids: HashMap<AsrProviderType, String> = AsrProviderType::all()
            .into_iter()
            .map(|provider| (provider, provider.default_model_id().to_string()))
            .collect();

        Self {
            silence_skip_enabled: RwLock::new(false),
            platform_optimization: RwLock::new(
                crate::settings::PlatformOptimizationSettings::default(),
            ),
            // whisper.cpp (Metal/CoreML) with base.en is the fast default route;
            // the Candle/Distil path runs on CPU in F32 and is multi-second.
            default_provider: RwLock::new(AsrProviderType::Whisper),
            selected_model_id: RwLock::new(AsrProviderType::Whisper.default_model_id().to_string()),
            provider_model_ids: RwLock::new(provider_model_ids),
            mlx_accelerated_providers: RwLock::new(HashSet::new()),
            dictation_mlx_enabled: RwLock::new(false),
            meeting_mlx_enabled: RwLock::new(false),
            transcription_language: RwLock::new(None),
            last_runtime_errors: RwLock::new(HashMap::new()),
            provider_inventory_cache: RwLock::new(None),
            provider_info_cache: RwLock::new(None),
            remote_processing_gate: RwLock::new(None),
            models_dir,
        }
    }

    pub async fn set_remote_processing_gate(
        &self,
        gate: Arc<crate::remote_processing::RemoteProcessingGate>,
    ) {
        *self.remote_processing_gate.write().await = Some(gate);
    }

    fn normalize_model_id(provider_type: AsrProviderType, model_id: &str) -> String {
        let trimmed = model_id.trim();
        let candidate = if trimmed.is_empty() {
            provider_type.default_model_id()
        } else {
            trimmed
        };

        match provider_type {
            // Only two Parakeet routes exist, and both are pure ONNX. Anything
            // else -- including the retired managed-Python `parakeet-ctc-*`
            // ids -- resolves to v3 so an old settings file still lands on a
            // route that runs.
            AsrProviderType::Parakeet => match candidate {
                "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => {
                    "parakeet-tdt-ctc-110m".to_string()
                }
                _ => "parakeet-tdt-0.6b-v3".to_string(),
            },
            _ => candidate.to_string(),
        }
    }

    fn provider_with_model(
        provider_type: AsrProviderType,
        selected_model_id: Option<&str>,
    ) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::MacosAppleSpeech | AsrProviderType::WindowsSdkDictation => {
                AsrProviderFactory::create(provider_type)
            }
            _ => AsrProviderFactory::create_with_model(provider_type, selected_model_id),
        }
    }

    fn platform_readiness_for_provider(
        provider_type: AsrProviderType,
    ) -> Option<AppleSpeechReadiness> {
        match provider_type {
            AsrProviderType::MacosAppleSpeech => {
                Some(crate::asr::platform::macos_speech::readiness())
            }
            _ => None,
        }
    }

    async fn fresh_apple_speech_readiness() -> Result<AppleSpeechReadiness, String> {
        tokio::task::spawn_blocking(crate::asr::platform::macos_speech::fresh_readiness)
            .await
            .map_err(|error| format!("Apple Speech readiness task failed: {error}"))
    }

    fn engine_probe(
        engine: PlatformEngine,
        apple_speech_readiness: Option<&AppleSpeechReadiness>,
    ) -> EngineProbe {
        if engine == PlatformEngine::MacosAppleSpeech {
            if let Some(readiness) = apple_speech_readiness {
                return crate::asr::platform::macos_speech::probe_from_readiness(readiness);
            }
        }
        engine.probe()
    }

    pub async fn set_selected_model_id(&self, model_id: String) {
        let default_provider = self.get_default_provider().await;
        let normalized = Self::normalize_model_id(default_provider, &model_id);
        self.provider_model_ids
            .write()
            .await
            .insert(default_provider, normalized.clone());
        *self.selected_model_id.write().await = normalized;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn selected_model_id(&self) -> String {
        self.selected_model_id.read().await.clone()
    }

    pub async fn set_provider_model_id(&self, provider_type: AsrProviderType, model_id: String) {
        let normalized = Self::normalize_model_id(provider_type, &model_id);
        self.provider_model_ids
            .write()
            .await
            .insert(provider_type, normalized.clone());

        if self.get_default_provider().await == provider_type {
            *self.selected_model_id.write().await = normalized;
        }
        self.invalidate_provider_info_cache().await;
    }

    pub async fn provider_model_id(&self, provider_type: AsrProviderType) -> String {
        self.provider_model_ids
            .read()
            .await
            .get(&provider_type)
            .cloned()
            .unwrap_or_else(|| provider_type.default_model_id().to_string())
    }

    pub async fn provider_model_map(&self) -> HashMap<AsrProviderType, String> {
        self.provider_model_ids.read().await.clone()
    }

    pub async fn set_mlx_accelerated_providers(&self, providers: HashSet<AsrProviderType>) {
        *self.mlx_accelerated_providers.write().await = providers;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn mlx_accelerated_providers(&self) -> HashSet<AsrProviderType> {
        self.mlx_accelerated_providers.read().await.clone()
    }

    pub async fn set_dictation_mlx_enabled(&self, enabled: bool) {
        *self.dictation_mlx_enabled.write().await = enabled;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_meeting_mlx_enabled(&self, enabled: bool) {
        *self.meeting_mlx_enabled.write().await = enabled;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_transcription_language(&self, language: Option<String>) {
        *self.transcription_language.write().await = language;
    }

    pub async fn transcription_language(&self) -> Option<String> {
        self.transcription_language.read().await.clone()
    }

    pub async fn dictation_mlx_enabled(&self) -> bool {
        *self.dictation_mlx_enabled.read().await
    }

    pub async fn meeting_mlx_enabled(&self) -> bool {
        *self.meeting_mlx_enabled.read().await
    }

    pub async fn resolve_effective_provider_and_model(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
    ) -> (AsrProviderType, String, bool) {
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            model_id,
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        (
            effective.provider_type,
            effective.model_id,
            effective.mlx_accelerated,
        )
    }

    pub async fn set_provider_model_map(&self, provider_map: HashMap<AsrProviderType, String>) {
        let mut merged: HashMap<AsrProviderType, String> = AsrProviderType::all()
            .into_iter()
            .map(|provider| {
                let selected = provider_map
                    .get(&provider)
                    .cloned()
                    .unwrap_or_else(|| provider.default_model_id().to_string());
                (provider, Self::normalize_model_id(provider, &selected))
            })
            .collect();

        let default_provider = self.get_default_provider().await;
        let default_selected = merged
            .get(&default_provider)
            .cloned()
            .unwrap_or_else(|| default_provider.default_model_id().to_string());

        *self.provider_model_ids.write().await = std::mem::take(&mut merged);
        *self.selected_model_id.write().await = default_selected;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_silence_skip_enabled(&self, enabled: bool) {
        *self.silence_skip_enabled.write().await = enabled;
    }

    pub async fn silence_skip_enabled(&self) -> bool {
        *self.silence_skip_enabled.read().await
    }

    pub async fn set_platform_optimization(
        &self,
        settings: crate::settings::PlatformOptimizationSettings,
    ) {
        *self.platform_optimization.write().await = settings;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn platform_optimization(&self) -> crate::settings::PlatformOptimizationSettings {
        self.platform_optimization.read().await.clone()
    }

    pub async fn clear_runtime_errors(&self) {
        self.last_runtime_errors.write().await.clear();
        self.invalidate_provider_info_cache().await;
    }

    fn effective_provider_selection(
        requested_provider: AsrProviderType,
        requested_model_id: &str,
        optimization: &crate::settings::PlatformOptimizationSettings,
        mlx_enabled: bool,
    ) -> EffectiveProviderSelection {
        let normalized_model_id = Self::normalize_model_id(requested_provider, requested_model_id);
        // The MLX Audio provider used to hijack this selection and swap in a
        // managed-Python route. It is gone, so the requested provider is always
        // the effective one. `optimization` and `mlx_enabled` are kept in the
        // signature because callers still thread real settings through here and
        // a future accelerated route would need them.
        let _ = (optimization, mlx_enabled);

        EffectiveProviderSelection {
            provider_type: requested_provider,
            model_id: normalized_model_id,
            mlx_accelerated: false,
        }
    }

    pub async fn supports_short_keep_warm(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
    ) -> bool {
        let normalized = Self::normalize_model_id(provider_type, model_id);
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            normalized.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        match effective.provider_type {
            AsrProviderType::Whisper
            | AsrProviderType::WhisperCandle
            | AsrProviderType::DistilWhisper
            | AsrProviderType::Moonshine
            // Both Parakeet routes are native ONNX and hold cached sessions.
            | AsrProviderType::Parakeet
            | AsrProviderType::Qwen3Asr
            // Two cached ONNX sessions and 2 GiB of mapped weights: the most
            // expensive route in the app to reload, so the most worth cooling.
            | AsrProviderType::CohereLocal => true,
            _ => false,
        }
    }

    pub async fn cool_down_local_route(&self, provider_type: AsrProviderType, model_id: &str) {
        let normalized = Self::normalize_model_id(provider_type, model_id);
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            normalized.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        match effective.provider_type {
            AsrProviderType::Whisper => super::whisper::clear_cached_model(&normalized),
            AsrProviderType::WhisperCandle => {
                super::whisper_candle::clear_cached_runtime(&self.models_dir.join("canary"));
            }
            AsrProviderType::DistilWhisper => {
                super::distil_whisper::clear_cached_runtime();
            }
            AsrProviderType::Moonshine => {
                let model_dir = if effective.model_id == "moonshine-tiny" {
                    self.models_dir.join("moonshine_tiny")
                } else {
                    self.models_dir.join("moonshine")
                };
                super::moonshine::clear_cached_runtime(&model_dir);
            }
            AsrProviderType::Parakeet => {
                super::parakeet::clear_cached_session();
            }
            AsrProviderType::Qwen3Asr => {
                super::qwen3_asr::clear_cached_runtime(&self.models_dir.join("qwen3_asr"));
            }
            AsrProviderType::CohereLocal => {
                super::cohere_local::clear_cached_runtime(
                    &self
                        .models_dir
                        .join(super::cohere_local::COHERE_LOCAL_MODEL_DIR),
                );
            }
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => {
                super::transcribe_cpp::clear_cached_runtime();
            }
            _ => {}
        }
    }

    pub async fn invalidate_provider_info_cache(&self) {
        *self.provider_inventory_cache.write().await = None;
        *self.provider_info_cache.write().await = None;
    }

    pub async fn get_provider_inventory(&self) -> Result<Vec<ProviderInventory>, String> {
        let apple_speech_readiness = Self::fresh_apple_speech_readiness().await?;
        let cached_inventory = self.provider_inventory_cache.read().await.clone();
        if let Some(mut cached) = cached_inventory {
            if let Some(apple) = cached
                .iter_mut()
                .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            {
                apple.is_available = apple_speech_readiness.ready;
                apple.platform_readiness = Some(apple_speech_readiness);
            }
            *self.provider_inventory_cache.write().await = Some(cached.clone());
            return Ok(cached);
        }

        let provider_models = self.provider_model_map().await;

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
            let apple_speech_readiness = apple_speech_readiness.clone();
            let selected_model = provider_models
                .get(&provider_type)
                .cloned()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());

            async move {
                tokio::task::spawn_blocking(move || {
                    let provider =
                        Self::provider_with_model(provider_type, Some(selected_model.as_str()));
                    let platform_readiness = match provider_type {
                        AsrProviderType::MacosAppleSpeech => Some(apple_speech_readiness),
                        _ => None,
                    };
                    let is_available = platform_readiness
                        .as_ref()
                        .map(|readiness| readiness.ready)
                        .unwrap_or_else(|| provider.is_available());
                    ProviderInventory {
                        provider_type,
                        name: provider.name().to_string(),
                        description: provider.description().to_string(),
                        is_available,
                        inference_enabled: Self::is_provider_transcription_enabled(provider_type),
                        selected_model_id: selected_model,
                        model_options: provider_type.model_options(),
                        download_status: provider.download_status(),
                        platform_readiness,
                    }
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))
            }
        });

        let results = futures_util::future::join_all(futures).await;

        let mut inventory = Vec::new();
        for res in results {
            match res {
                Ok(item) => inventory.push(item),
                Err(e) => return Err(e),
            }
        }

        *self.provider_inventory_cache.write().await = Some(inventory.clone());
        Ok(inventory)
    }

    /// Get a provider by type - creates fresh instance each time
    pub async fn get_provider(&self, provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        let selected_model = self.provider_model_id(provider_type).await;
        Self::provider_with_model(provider_type, Some(selected_model.as_str()))
    }

    /// Whether the provider has active transcription inference in this build.
    ///
    /// This is the seam a provider sits behind while its runtime is still
    /// unproven. Nothing is behind it today: Qwen3-ASR, the last occupant,
    /// left on 2026-09-01 once its real-audio eval passed (see
    /// `qwen3_asr_real_audio_eval` in asr/qwen3_asr.rs). The flag still
    /// reaches the UI as `inferenceEnabled`, so a future provider can ship
    /// downloadable-but-not-selectable without a schema change.
    pub fn is_provider_transcription_enabled(_provider_type: AsrProviderType) -> bool {
        true
    }

    /// Get the default provider
    pub async fn get_default_provider(&self) -> AsrProviderType {
        *self.default_provider.read().await
    }

    /// Set the default provider
    pub async fn set_default_provider(&self, provider_type: AsrProviderType) {
        *self.default_provider.write().await = provider_type;
        let selected = self.provider_model_id(provider_type).await;
        *self.selected_model_id.write().await = selected;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn get_runtime_diagnostics(
        &self,
        provider_type: AsrProviderType,
    ) -> RuntimeDiagnostics {
        let selected_model = self.provider_model_id(provider_type).await;
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        let provider =
            Self::provider_with_model(effective.provider_type, Some(effective.model_id.as_str()));
        let platform_readiness = Self::platform_readiness_for_provider(effective.provider_type);
        let provider_available = platform_readiness
            .as_ref()
            .map(|readiness| readiness.ready)
            .unwrap_or_else(|| provider.is_available());
        let last_error = self
            .last_runtime_errors
            .read()
            .await
            .get(&effective.provider_type)
            .cloned();

        let diagnostics = runtime_diagnostics_for_provider(
            effective.provider_type,
            effective.model_id.as_str(),
            provider_available,
            last_error.as_deref(),
            platform_readiness.as_ref(),
        );

        RuntimeDiagnostics {
            provider_type,
            runtime_status: diagnostics.runtime_status,
            runtime_message: diagnostics.runtime_message,
            runtime_details: diagnostics.runtime_details,
        }
    }

    async fn transcribe_inner(
        &self,
        provider_type: AsrProviderType,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        selected_model: Option<&str>,
        // When `Some`, bypasses the global mlx_accelerated_providers set.
        // Use this for slot-aware routing (dictation vs meeting).
        mlx_override: Option<bool>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let requested_provider = provider_type;
        let resolved_model = match selected_model {
            Some(value) => Self::normalize_model_id(provider_type, value),
            None => self.provider_model_id(provider_type).await,
        };
        let skip_silence = self.silence_skip_enabled().await;
        let optimization = self.platform_optimization().await;
        let mlx_enabled = match mlx_override {
            Some(b) => b,
            None => self
                .mlx_accelerated_providers()
                .await
                .contains(&requested_provider),
        };
        let effective_selection = Self::effective_provider_selection(
            requested_provider,
            resolved_model.as_str(),
            &optimization,
            mlx_enabled,
        );

        // Pre-process: remove silence from audio bytes if enabled
        let processed_bytes: Option<Vec<u8>> = if skip_silence {
            audio_data.and_then(|bytes| {
                match crate::audio::utils::remove_silence_from_wav_bytes(bytes) {
                    Ok(filtered) => Some(filtered),
                    Err(e) => {
                        tracing::warn!(
                            "Silence skip preprocessing failed, using original audio: {}",
                            e
                        );
                        None
                    }
                }
            })
        } else {
            None
        };
        let effective_audio_data = processed_bytes.as_deref().or(audio_data);

        let mut attempt_errors: Vec<String> = Vec::new();
        let requested_engine =
            Self::select_requested_engine(effective_selection.provider_type, &optimization);
        let exclusive_engine = requested_engine
            .map(|engine| Self::engine_selection_is_exclusive(engine, &optimization))
            .unwrap_or(false);
        let engine_failure_suffix = if exclusive_engine {
            "no provider fallback will be attempted".to_string()
        } else {
            format!(
                "continuing with selected provider '{}'",
                requested_provider.display_name()
            )
        };
        let mut provider_requested_engine =
            requested_engine.unwrap_or(PlatformEngine::ProviderDefault);

        if let Some(engine) = requested_engine {
            let engine_probe = engine.probe();
            if engine != PlatformEngine::ProviderDefault {
                if Self::engine_enabled(engine, &optimization)
                    && engine_probe.ready
                    && engine.supports_provider(effective_selection.provider_type)
                {
                    if !Self::engine_runtime_executable(engine) {
                        attempt_errors.push(format!(
                            "Engine '{}' unavailable: execution path is not implemented in this build; {}",
                            engine.id(),
                            engine_failure_suffix.as_str()
                        ));
                        if exclusive_engine {
                            return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                        }
                    } else {
                        match self
                            .transcribe_with_platform_engine_attempt(
                                requested_provider,
                                file_path,
                                effective_audio_data,
                                engine,
                            )
                            .await
                        {
                            Ok(result) => return Ok(result),
                            Err(error) => {
                                attempt_errors.push(format!(
                                    "Engine '{}' failed: {}; {}",
                                    engine.id(),
                                    error,
                                    engine_failure_suffix.as_str()
                                ));
                                if exclusive_engine {
                                    return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                                }
                            }
                        }
                    }
                } else {
                    let reason = if !Self::engine_enabled(engine, &optimization) {
                        "disabled in settings".to_string()
                    } else if !engine_probe.ready {
                        engine_probe.notes.join("; ")
                    } else {
                        "not supported for selected provider".to_string()
                    };
                    attempt_errors.push(format!(
                        "Engine '{}' unavailable: {}; {}",
                        engine.id(),
                        reason,
                        engine_failure_suffix.as_str()
                    ));
                    if exclusive_engine {
                        return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                    }
                }
                provider_requested_engine = PlatformEngine::ProviderDefault;
            }
        }

        match self
            .transcribe_with_provider_attempt(
                requested_provider,
                effective_selection.provider_type,
                effective_selection.model_id.as_str(),
                file_path,
                effective_audio_data,
                provider_requested_engine,
                PlatformEngine::ProviderDefault,
                effective_selection.mlx_accelerated,
                None,
                options,
            )
            .await
        {
            Ok(result) => return Ok(result),
            Err(primary_error) => {
                attempt_errors.push(format!(
                    "{} failed: {}",
                    requested_provider.display_name(),
                    primary_error
                ));
            }
        }

        Err(anyhow::anyhow!(attempt_errors.join(" | ")))
    }

    async fn transcribe_with_platform_engine_attempt(
        &self,
        requested_provider: AsrProviderType,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        engine: PlatformEngine,
    ) -> Result<TranscriptionResult> {
        let file_path_owned = file_path.map(PathBuf::from);
        let audio_data_owned = audio_data.map(|bytes| bytes.to_vec());
        let engine_id = engine.id().to_string();
        let platform_result = tokio::task::spawn_blocking(move || {
            crate::asr::platform::transcription::transcribe_with_engine(
                engine,
                file_path_owned.as_deref(),
                audio_data_owned.as_deref(),
            )
        })
        .await
        .map_err(|join_error| {
            anyhow::anyhow!(
                "Native engine '{}' task failed to join: {}",
                engine_id,
                join_error
            )
        })??;

        self.last_runtime_errors
            .write()
            .await
            .remove(&requested_provider);

        Ok(TranscriptionResult {
            text: platform_result.text,
            segments: Vec::new(),
            language: platform_result.language,
            confidence: platform_result.confidence,
            processing_time_ms: platform_result.processing_time_ms,
            model_name: engine.id().to_string(),
            model_id: engine.id().to_string(),
            requested_provider,
            actual_provider: requested_provider,
            requested_engine: Some(engine.id().to_string()),
            actual_engine: Some(engine.id().to_string()),
            optimization_applied: true,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn transcribe_with_provider_attempt(
        &self,
        requested_provider: AsrProviderType,
        actual_provider: AsrProviderType,
        model_id: &str,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        requested_engine: PlatformEngine,
        actual_engine: PlatformEngine,
        optimization_applied: bool,
        fallback_reason: Option<String>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let provider = Self::provider_with_model(actual_provider, Some(model_id));
        let request = async {
            match (file_path, audio_data) {
                (Some(path), None) => provider.transcribe_path_with_options(path, options).await,
                (None, Some(bytes)) => provider.transcribe_bytes_with_options(bytes, options).await,
                _ => Err(anyhow::anyhow!("Invalid transcription input")),
            }
        };
        tokio::pin!(request);
        let primary_result = if actual_provider.is_remote() {
            let gate = self
                .remote_processing_gate
                .read()
                .await
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Remote processing gate is unavailable"))?;
            let mut grant = gate.grant().map_err(anyhow::Error::msg)?;
            tokio::select! {
                result = &mut request => result,
                _ = grant.cancelled() => Err(anyhow::anyhow!(
                    "Remote processing was revoked while transcription was active"
                )),
            }
        } else {
            request.await
        };

        match primary_result {
            Ok(mut result) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .remove(&actual_provider);
                result.requested_provider = requested_provider;
                result.actual_provider = actual_provider;
                result.requested_engine = Some(requested_engine.id().to_string());
                result.actual_engine = Some(actual_engine.id().to_string());
                result.optimization_applied = optimization_applied;
                if result.model_id.trim().is_empty() {
                    result.model_id = model_id.to_string();
                }
                if fallback_reason.is_some() {
                    result.fallback_reason = fallback_reason;
                }
                Ok(result)
            }
            Err(error) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .insert(actual_provider, error.to_string());
                Err(error)
            }
        }
    }

    fn select_requested_engine(
        provider_type: AsrProviderType,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> Option<PlatformEngine> {
        // Apple Speech is a first-class, dictation-only provider. It is not an
        // optimization engine for Whisper (or any other provider), and routing it
        // through the engine layer would make an unavailable Apple route silently
        // fall back to the requested provider.
        if provider_type == AsrProviderType::MacosAppleSpeech {
            return None;
        }

        let selected = match optimization.mode.as_str() {
            "manual" => optimization
                .manual_engine_priority
                .iter()
                .filter_map(|id| PlatformEngine::from_id(id))
                .find(|engine| {
                    Self::engine_enabled(*engine, optimization)
                        && engine.supports_provider(provider_type)
                }),
            _ => {
                if !provider_type.is_local() {
                    return None;
                }

                #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                if optimization.windows.windows_sdk_dictation_enabled {
                    return Some(PlatformEngine::WindowsSdkDictation);
                }

                #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                if optimization.windows.foundry_enabled {
                    return Some(PlatformEngine::WindowsFoundryLocal);
                }

                None
            }
        };

        selected
    }

    fn engine_enabled(
        engine: PlatformEngine,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> bool {
        match engine {
            PlatformEngine::ProviderDefault => true,
            PlatformEngine::MacosAppleSpeech => optimization.macos.apple_native_enabled,
            PlatformEngine::MacosMlxSidecar => optimization.macos.mlx_enabled,
            PlatformEngine::WindowsFoundryLocal => optimization.windows.foundry_enabled,
            PlatformEngine::WindowsSdkDictation => {
                optimization.windows.windows_sdk_dictation_enabled
            }
        }
    }

    fn engine_runtime_executable(engine: PlatformEngine) -> bool {
        match engine {
            PlatformEngine::ProviderDefault
            | PlatformEngine::MacosMlxSidecar
            | PlatformEngine::WindowsFoundryLocal => true,
            PlatformEngine::MacosAppleSpeech => {
                cfg!(all(target_os = "macos", target_arch = "aarch64"))
            }
            PlatformEngine::WindowsSdkDictation => {
                cfg!(all(target_os = "windows", target_arch = "x86_64"))
            }
        }
    }

    fn engine_selection_is_exclusive(
        engine: PlatformEngine,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> bool {
        if engine == PlatformEngine::ProviderDefault {
            return false;
        }

        if optimization.mode == "manual" {
            if let Some(first) = optimization
                .manual_engine_priority
                .iter()
                .filter_map(|id| PlatformEngine::from_id(id))
                .next()
            {
                return first == engine && first != PlatformEngine::ProviderDefault;
            }
        }

        match engine {
            PlatformEngine::MacosAppleSpeech => optimization.macos.apple_native_enabled,
            PlatformEngine::WindowsSdkDictation => {
                optimization.windows.windows_sdk_dictation_enabled
            }
            _ => false,
        }
    }

    /// Transcribe using the default provider
    pub async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(
            provider_type,
            Some(audio_path),
            None,
            None,
            None,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            None,
            None,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// Transcribe bytes with a specific provider (uses the global MLX accelerated set).
    pub async fn transcribe_bytes_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            selected_model,
            None,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// Transcribe bytes for the dictation route slot (uses per-slot dictation MLX flag).
    pub async fn transcribe_bytes_for_dictation(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        self.transcribe_bytes_for_dictation_with_options(
            provider_type,
            audio_data,
            selected_model,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// `transcribe_bytes_for_dictation` with per-request options — the final
    /// dictation decode passes the personal-dictionary vocabulary hint here.
    /// Options ride along through the engine/provider fallback chain, so a
    /// fallback provider that can use them still gets them.
    pub async fn transcribe_bytes_for_dictation_with_options(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let mlx_enabled = *self.dictation_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            selected_model,
            Some(mlx_enabled),
            options,
        )
        .await
    }

    /// Transcribe bytes for the meeting route slot (uses per-slot meeting MLX flag).
    pub async fn transcribe_bytes_for_meeting(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        // Apple Speech reaches meetings only through SpeechAnalyzer, which is
        // the only one of its two engines that returns the per-segment
        // timestamps the meeting transcript is assembled from.
        let mut options = meeting_transcription_options(self.transcription_language().await);
        if provider_type == AsrProviderType::MacosAppleSpeech {
            // `meetings_supported` can run a bounded probe when nothing has
            // looked yet, so it does not hold a runtime worker.
            let meeting_capable =
                tokio::task::spawn_blocking(crate::asr::platform::macos_speech::meetings_supported)
                    .await
                    .unwrap_or(false);
            if !meeting_capable {
                return Err(anyhow::anyhow!(
                    "Apple Speech serves meetings only through SpeechAnalyzer, which needs macOS 26 or later with the language installed. Choose a meeting-capable provider."
                ));
            }
            // Carried down rather than re-decided inside the route. The gate
            // above reads a probe result; the route used to run its own probe
            // moments later, so an asset or reservation change in between put
            // SFSpeechRecognizer on a meeting the gate had cleared for
            // SpeechAnalyzer.
            options.apple_speech_required_engine =
                Some(crate::asr::platform::macos_speech::AppleSpeechEngine::SpeechAnalyzer);
        }
        let mlx_enabled = *self.meeting_mlx_enabled.read().await;
        let result = self
            .transcribe_inner(
                provider_type,
                None,
                Some(audio_data),
                selected_model,
                Some(mlx_enabled),
                &options,
            )
            .await?;

        if let Some(refusal) =
            Self::untimestamped_meeting_refusal(provider_type, &result.text, result.segments.len())
        {
            return Err(anyhow::anyhow!(refusal));
        }
        Ok(result)
    }

    /// Transcribe a whole recording from disk for the meeting route slot.
    ///
    /// Used only where a provider can take an entire meeting in one request:
    /// a provider's speaker numbering is scoped to one request, so this is the
    /// only shape in which its diarization covers the whole recording.
    ///
    /// The options below reach the provider whichever way the request is
    /// served: path mode goes through `AsrProvider::transcribe_path_with_options`
    /// and bytes mode through `transcribe_bytes_with_options`. They used to be
    /// dropped on the path, which is why the two whole-file providers each
    /// hard-coded `request_speaker_labels: true` inside their own `transcribe`.
    pub async fn transcribe_path_for_meeting(
        &self,
        provider_type: AsrProviderType,
        audio_path: &Path,
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        if provider_type == AsrProviderType::MacosAppleSpeech {
            return Err(anyhow::anyhow!(
                "Apple Speech is dictation-only and cannot be routed through meeting transcription. Choose a meeting-capable provider."
            ));
        }
        let mlx_enabled = *self.meeting_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            Some(audio_path),
            None,
            selected_model,
            Some(mlx_enabled),
            &meeting_transcription_options(self.transcription_language().await),
        )
        .await
    }

    /// Why an Apple Speech result cannot become a meeting transcript.
    ///
    /// A meeting transcript is assembled from per-chunk segments with real
    /// start/end times. SFSpeechRecognizer returns one formatted string and no
    /// segments, so text with no segments means the engine that ran was not
    /// the one the gate chose -- and letting it through saved a meeting with a
    /// full transcript, zero timestamps and no error anywhere. The last net
    /// under the required-engine check the helper call already makes, so a new
    /// path into the meeting route cannot reintroduce the same silence.
    ///
    /// Pure, so the policy is testable without a Mac.
    fn untimestamped_meeting_refusal(
        provider_type: AsrProviderType,
        text: &str,
        segment_count: usize,
    ) -> Option<String> {
        if provider_type != AsrProviderType::MacosAppleSpeech
            || text.trim().is_empty()
            || segment_count > 0
        {
            return None;
        }
        Some(
            "Apple Speech returned a transcript with no timestamps, so SFSpeechRecognizer ran instead of SpeechAnalyzer. The meeting was not saved with an untimed transcript. Install the language for SpeechAnalyzer, or choose another meeting provider."
                .to_string(),
        )
    }

    /// Get info for all providers (Parallelized)
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        let apple_speech_readiness = Self::fresh_apple_speech_readiness().await?;
        let cached_info = self.provider_info_cache.read().await.clone();
        if let Some(mut cached) = cached_info {
            if let Some(apple) = cached
                .iter_mut()
                .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            {
                let optimization = self.platform_optimization().await;
                let mlx_enabled = self
                    .mlx_accelerated_providers()
                    .await
                    .contains(&AsrProviderType::MacosAppleSpeech);
                let last_error = self
                    .last_runtime_errors
                    .read()
                    .await
                    .get(&AsrProviderType::MacosAppleSpeech)
                    .cloned();
                let diagnostics = runtime_diagnostics_for_provider(
                    AsrProviderType::MacosAppleSpeech,
                    apple.selected_model_id.as_str(),
                    apple_speech_readiness.ready,
                    last_error.as_deref(),
                    Some(&apple_speech_readiness),
                );
                apple.is_available = apple_speech_readiness.ready;
                apple.runtime_status = diagnostics.runtime_status;
                apple.runtime_message = diagnostics.runtime_message;
                apple.runtime_details = diagnostics.runtime_details;
                apple.engine_diagnostics = Self::engine_diagnostics_for_provider(
                    AsrProviderType::MacosAppleSpeech,
                    apple.selected_model_id.as_str(),
                    &optimization,
                    mlx_enabled,
                    Some(&apple_speech_readiness),
                );
                apple.platform_readiness = Some(apple_speech_readiness);
            }
            *self.provider_info_cache.write().await = Some(cached.clone());
            return Ok(cached);
        }

        let provider_models = self.provider_model_map().await;
        let last_errors = self.last_runtime_errors.read().await.clone();
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
            let apple_speech_readiness = apple_speech_readiness.clone();
            let selected_model = provider_models
                .get(&provider_type)
                .cloned()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            let optimization = optimization.clone();
            let mlx_accelerated_providers = mlx_accelerated_providers.clone();
            let mlx_enabled = mlx_accelerated_providers.contains(&provider_type);
            let effective = Self::effective_provider_selection(
                provider_type,
                selected_model.as_str(),
                &optimization,
                mlx_enabled,
            );
            let last_error = last_errors.get(&effective.provider_type).cloned();

            async move {
                tokio::task::spawn_blocking(move || {
                    let visible_provider =
                        Self::provider_with_model(provider_type, Some(selected_model.as_str()));
                    let provider = Self::provider_with_model(
                        effective.provider_type,
                        Some(effective.model_id.as_str()),
                    );
                    let platform_readiness = match provider_type {
                        AsrProviderType::MacosAppleSpeech => Some(apple_speech_readiness),
                        _ => None,
                    };
                    let is_available = platform_readiness
                        .as_ref()
                        .map(|readiness| readiness.ready)
                        .unwrap_or_else(|| provider.is_available());
                    let diagnostics = runtime_diagnostics_for_provider(
                        effective.provider_type,
                        effective.model_id.as_str(),
                        is_available,
                        last_error.as_deref(),
                        platform_readiness.as_ref(),
                    );
                    ProviderInfo {
                        provider_type,
                        name: visible_provider.name().to_string(),
                        description: if effective.mlx_accelerated {
                            format!(
                                "{} MLX acceleration is enabled for the selected model.",
                                visible_provider.description()
                            )
                        } else {
                            visible_provider.description().to_string()
                        },
                        is_available,
                        inference_enabled: Self::is_provider_transcription_enabled(provider_type),
                        model_info: provider.model_info(),
                        selected_model_id: selected_model.clone(),
                        model_options: provider_type.model_options(),
                        download_status: provider.download_status(),
                        runtime_status: diagnostics.runtime_status,
                        runtime_message: diagnostics.runtime_message,
                        runtime_details: diagnostics.runtime_details,
                        engine_diagnostics: Self::engine_diagnostics_for_provider(
                            effective.provider_type,
                            effective.model_id.as_str(),
                            &optimization,
                            mlx_enabled,
                            platform_readiness.as_ref(),
                        ),
                        platform_readiness,
                    }
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))
            }
        });

        // Current crate uses futures-util
        let results = futures_util::future::join_all(futures).await;

        let mut infos = Vec::new();
        for res in results {
            match res {
                Ok(info) => infos.push(info),
                Err(e) => return Err(e),
            }
        }

        *self.provider_info_cache.write().await = Some(infos.clone());
        Ok(infos)
    }

    fn engine_diagnostics_for_provider(
        provider_type: AsrProviderType,
        selected_model_id: &str,
        optimization: &crate::settings::PlatformOptimizationSettings,
        mlx_enabled: bool,
        apple_speech_readiness: Option<&AppleSpeechReadiness>,
    ) -> EngineDiagnostics {
        let mut diagnostics = EngineDiagnostics::default();
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model_id,
            optimization,
            mlx_enabled,
        );
        let all_engines = [
            PlatformEngine::ProviderDefault,
            PlatformEngine::MacosMlxSidecar,
            PlatformEngine::MacosAppleSpeech,
            PlatformEngine::WindowsFoundryLocal,
            PlatformEngine::WindowsSdkDictation,
        ];

        for engine in all_engines {
            if !engine.supports_provider(effective.provider_type) {
                continue;
            }
            let enabled = Self::engine_enabled(engine, optimization);
            let probe = Self::engine_probe(engine, apple_speech_readiness);
            if probe.ready && Self::engine_runtime_executable(engine) {
                diagnostics.available_engines.push(engine.id().to_string());
                if engine != PlatformEngine::ProviderDefault && !enabled {
                    diagnostics.notes.push(format!(
                        "Engine '{}' is available but currently disabled in settings.",
                        engine.id()
                    ));
                }
            } else if probe.ready && engine != PlatformEngine::ProviderDefault {
                diagnostics.notes.push(format!(
                    "Engine '{}' is configured but execution path is not implemented in this build.",
                    engine.id()
                ));
            }
            diagnostics.notes.extend(probe.notes);
        }

        let active = Self::select_requested_engine(effective.provider_type, optimization)
            .filter(|engine| {
                *engine == PlatformEngine::ProviderDefault
                    || (Self::engine_enabled(*engine, optimization)
                        && engine.supports_provider(effective.provider_type)
                        && Self::engine_probe(*engine, apple_speech_readiness).ready
                        && Self::engine_runtime_executable(*engine))
            })
            .map(|engine| engine.id().to_string());

        diagnostics.active_engine =
            active.or_else(|| Some(PlatformEngine::ProviderDefault.id().to_string()));

        diagnostics
    }

    async fn resolve_download_model_id(
        &self,
        provider_type: AsrProviderType,
        requested_model_id: Option<&str>,
    ) -> Result<String> {
        let model_id = match requested_model_id {
            Some(value) => Self::normalize_model_id(provider_type, value),
            None => self.provider_model_id(provider_type).await,
        };
        if !provider_type
            .model_options()
            .iter()
            .any(|option| option.id == model_id)
        {
            anyhow::bail!("Model '{model_id}' is not available for {provider_type:?}");
        }
        Ok(model_id)
    }

    /// Download models for a provider
    pub async fn download_models(
        &self,
        provider_type: AsrProviderType,
        requested_model_id: Option<&str>,
        progress_cb: Box<dyn Fn(f32) + Send + Sync>,
    ) -> Result<()> {
        let selected_model = self
            .resolve_download_model_id(provider_type, requested_model_id)
            .await?;
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        let provider =
            Self::provider_with_model(effective.provider_type, Some(effective.model_id.as_str()));
        let result = provider.download_models(progress_cb).await;
        self.invalidate_provider_info_cache().await;
        result
    }

    /// Get models directory
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Compare providers with benchmark
    pub async fn benchmark_providers(&self, test_audio: &Path) -> Vec<BenchmarkResult> {
        let mut results = Vec::new();

        for provider_type in AsrProviderType::all() {
            let selected_model = self.provider_model_id(provider_type).await;
            let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
            if !provider.is_available() || !Self::is_provider_transcription_enabled(provider_type) {
                continue;
            }

            let start = std::time::Instant::now();
            match provider.transcribe(test_audio).await {
                Ok(transcription) => {
                    let non_empty_transcript = !transcription.text.trim().is_empty();
                    results.push(BenchmarkResult {
                        provider_type,
                        provider_name: provider.name().to_string(),
                        model_id: selected_model.clone(),
                        runtime_status: RuntimeStatus::Ready,
                        non_empty_transcript,
                        processing_time_ms: start.elapsed().as_millis() as u64,
                        transcription: transcription.text,
                        confidence: transcription.confidence,
                    });
                }
                Err(e) => {
                    tracing::error!("Benchmark failed for {}: {}", provider.name(), e);
                }
            }
        }

        results
    }
}

/// Provider information for UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider_type: AsrProviderType,
    pub name: String,
    pub description: String,
    pub is_available: bool,
    pub inference_enabled: bool,
    pub model_info: ModelInfo,
    pub selected_model_id: String,
    pub model_options: Vec<super::ModelOption>,
    pub download_status: DownloadStatus,
    pub runtime_status: RuntimeStatus,
    pub runtime_message: Option<String>,
    pub runtime_details: RuntimeDetails,
    #[serde(default)]
    pub engine_diagnostics: EngineDiagnostics,
    #[serde(default)]
    pub platform_readiness: Option<crate::asr::platform::macos_speech::AppleSpeechReadiness>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInventory {
    pub provider_type: AsrProviderType,
    pub name: String,
    pub description: String,
    pub is_available: bool,
    pub inference_enabled: bool,
    pub selected_model_id: String,
    pub model_options: Vec<super::ModelOption>,
    pub download_status: DownloadStatus,
    #[serde(default)]
    pub platform_readiness: Option<crate::asr::platform::macos_speech::AppleSpeechReadiness>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Ready,
    MissingRuntime,
    MissingModel,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDetails {
    pub python_path: Option<String>,
    pub model_path: Option<String>,
    #[serde(default)]
    pub missing_files: Vec<String>,
    pub setup_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub provider_type: AsrProviderType,
    pub runtime_status: RuntimeStatus,
    pub runtime_message: Option<String>,
    pub runtime_details: RuntimeDetails,
}

#[derive(Debug, Clone)]
struct RuntimeDiagnosticsInternal {
    runtime_status: RuntimeStatus,
    runtime_message: Option<String>,
    runtime_details: RuntimeDetails,
}

#[derive(Debug, Clone)]
struct EffectiveProviderSelection {
    provider_type: AsrProviderType,
    model_id: String,
    mlx_accelerated: bool,
}

/// Benchmark result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub provider_type: AsrProviderType,
    pub provider_name: String,
    pub model_id: String,
    pub runtime_status: RuntimeStatus,
    pub non_empty_transcript: bool,
    pub processing_time_ms: u64,
    pub transcription: String,
    pub confidence: f64,
}

impl Default for AsrManager {
    fn default() -> Self {
        Self::new()
    }
}

fn runtime_diagnostics_for_provider(
    provider_type: AsrProviderType,
    selected_model_id: &str,
    provider_available: bool,
    last_error: Option<&str>,
    apple_speech_readiness: Option<&AppleSpeechReadiness>,
) -> RuntimeDiagnosticsInternal {
    let models_root = crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models");

    match provider_type {
        AsrProviderType::Whisper => {
            let model_file = format!("ggml-{}.bin", sanitize_whisper_model_id(selected_model_id));
            let model_path = models_root.join("whisper").join(&model_file);
            if !model_path.exists() {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(
                        "Whisper model not downloaded yet. Download a model to enable this provider."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_path.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: vec![model_file],
                        setup_action: Some(
                            "Download a Whisper model in Settings -> ASR Models.".to_string(),
                        ),
                    },
                };
            }
            if provider_available {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::Ready,
                    runtime_message: Some("Whisper runtime ready.".to_string()),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_path.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: Vec::new(),
                        setup_action: None,
                    },
                };
            }
            RuntimeDiagnosticsInternal {
                runtime_status: RuntimeStatus::Error,
                runtime_message: Some(last_error.map(ToString::to_string).unwrap_or_else(|| {
                    "Whisper model exists but failed to initialize.".to_string()
                })),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_path.to_string_lossy().to_string()),
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::Parakeet => {
            let normalized_model = AsrManager::normalize_model_id(provider_type, selected_model_id);
            let legacy = normalized_model == "parakeet-tdt-ctc-110m";

            let (model_dir, missing_files) =
                parakeet_model_dir_and_missing_files(models_root.as_path(), &normalized_model);

            if !missing_files.is_empty() {
                let (message, setup_action) = if legacy {
                    (
                        "Parakeet legacy model not downloaded. Download encoder.onnx + tokens.txt from Settings -> ASR Models.".to_string(),
                        "Download Parakeet legacy artifacts (encoder.onnx + tokens.txt) in Settings -> ASR Models.".to_string(),
                    )
                } else {
                    (
                        format!(
                            "Parakeet model '{}' is not downloaded yet.",
                            normalized_model
                        ),
                        "Download Parakeet TDT v3 (encoder + decoder + joiner + tokens) in Settings -> ASR Models.".to_string(),
                    )
                };
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(message),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files,
                        setup_action: Some(setup_action),
                    },
                };
            }

            RuntimeDiagnosticsInternal {
                runtime_status: if provider_available {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::Error
                },
                runtime_message: Some(last_error.map(ToString::to_string).unwrap_or_else(|| {
                    if legacy {
                        "Parakeet legacy ONNX runtime ready.".to_string()
                    } else {
                        "Parakeet TDT v3 native ONNX runtime ready.".to_string()
                    }
                })),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::WhisperCandle => {
            let model_dir = models_root.join("canary");
            let model_ready = WHISPER_CANDLE_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_required_files(
                    models_root.join("canary").as_path(),
                    &WHISPER_CANDLE_REQUIRED_FILES,
                ),
                MissingModelCopy {
                    message:
                        "Whisper Candle model not downloaded. Download Whisper Large V3 Turbo safetensors first.",
                    setup_action: "Download Whisper Candle model assets in Settings -> ASR Models.",
                },
                "Whisper Candle native local runtime ready.",
                last_error,
            )
        }
        AsrProviderType::DistilWhisper => {
            let model_dir = models_root.join("distil_whisper");
            let model_ready = DISTIL_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_required_files(
                    models_root.join("distil_whisper").as_path(),
                    &DISTIL_REQUIRED_FILES,
                ),
                MissingModelCopy {
                    message:
                        "Distil-Whisper model not downloaded. Download model.safetensors + config first.",
                    setup_action: "Download Distil-Whisper model assets in Settings -> ASR Models.",
                },
                "Distil-Whisper native Candle inference ready.",
                last_error,
            )
        }
        AsrProviderType::MacosAppleSpeech => {
            use crate::asr::platform::macos_speech::AppleSpeechReadinessStatus;

            let readiness = apple_speech_readiness
                .cloned()
                .unwrap_or_else(crate::asr::platform::macos_speech::readiness);
            let runtime_status = match readiness.status {
                AppleSpeechReadinessStatus::Ready if provider_available => RuntimeStatus::Ready,
                AppleSpeechReadinessStatus::UnsupportedPlatform
                | AppleSpeechReadinessStatus::HelperMissing
                | AppleSpeechReadinessStatus::RuntimeUnavailable => RuntimeStatus::MissingRuntime,
                _ => RuntimeStatus::Error,
            };

            RuntimeDiagnosticsInternal {
                runtime_status,
                runtime_message: Some(readiness.message),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if readiness.helper_present {
                        Vec::new()
                    } else {
                        vec!["nautilus-macos-speech-helper-aarch64-apple-darwin".to_string()]
                    },
                    setup_action: readiness.setup_action,
                },
            }
        }
        AsrProviderType::Moonshine => {
            let normalized_model = AsrManager::normalize_model_id(provider_type, selected_model_id);
            let model_dir = if normalized_model == "moonshine-tiny" {
                models_root.join("moonshine_tiny")
            } else {
                models_root.join("moonshine")
            };
            let model_ready = is_valid_onnx_artifact(&model_dir.join("encoder_model.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_model_merged.onnx"))
                && is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024);
            let missing_files = missing_or_invalid_moonshine_files(model_dir.as_path());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message:
                        "Moonshine ONNX model not downloaded. Download encoder_model.onnx + decoder_model_merged.onnx first.",
                    setup_action: "Re-download Moonshine ONNX assets in Settings -> ASR Models.",
                },
                "Moonshine native ONNX inference ready.",
                last_error,
            )
        }

        AsrProviderType::WindowsSdkDictation => {
            let probe = PlatformEngine::WindowsSdkDictation.probe();
            RuntimeDiagnosticsInternal {
                runtime_status: if provider_available && probe.ready {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingRuntime
                },
                runtime_message: Some(if provider_available && probe.ready {
                    "Windows native speech runtime ready.".to_string()
                } else if !probe.notes.is_empty() {
                    probe.notes.join(" ")
                } else {
                    "Windows native speech is unavailable in this build.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: Some(
                        "Use a supported Windows x86_64 build with native speech components installed, or choose another ASR provider."
                            .to_string(),
                    ),
                },
            }
        }
        AsrProviderType::ElevenLabsScribe => {
            let has_key = has_provider_secret_or_env("elevenlabs", "ELEVENLABS_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "ElevenLabs Scribe cloud API ready.".to_string()
                } else {
                    "Set ELEVENLABS_API_KEY to enable ElevenLabs Scribe.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["ELEVENLABS_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Set ELEVENLABS_API_KEY in Settings -> API Keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::OpenAiCloud => {
            let has_key = has_provider_secret_or_env("openai", "OPENAI_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "OpenAI Whisper cloud API ready.".to_string()
                } else {
                    "Set OPENAI_API_KEY to enable OpenAI Whisper cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["OPENAI_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Set OPENAI_API_KEY in Settings -> API Keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::Groq => {
            let has_key = has_provider_secret_or_env("groq", "GROQ_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Groq Whisper cloud API ready. Ultra-fast transcription at 164x real-time."
                        .to_string()
                } else {
                    "Set GROQ_API_KEY to enable Groq Whisper cloud (ultra-fast).".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["GROQ_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Get API key from https://console.groq.com/keys and set in Settings -> API Keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::CohereTranscribe => {
            let has_key = has_provider_secret_or_env("cohere", "CO_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Cohere Transcribe cloud API ready. Low WER, 14 languages supported."
                        .to_string()
                } else {
                    "Set CO_API_KEY to enable Cohere Transcribe cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["CO_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Get API key from https://dashboard.cohere.com/api-keys and set in Settings -> API Keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::Deepgram => {
            let has_key = has_provider_secret_or_env("deepgram", "DEEPGRAM_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Deepgram Nova cloud API ready. Returns speaker labels and word timestamps; \
                     every request opts out of Deepgram's model improvement programme."
                        .to_string()
                } else {
                    "Set DEEPGRAM_API_KEY to enable Deepgram Nova cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["DEEPGRAM_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://console.deepgram.com and set it in Settings -> API Keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::GeminiTranscribe => {
            let has_key = has_provider_secret_or_env("gemini", "GEMINI_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Gemini 3.5 Transcribe cloud API ready. Google's paid tier does not train on \
                     your prompts; the free tier does."
                        .to_string()
                } else {
                    "Set GEMINI_API_KEY to enable Gemini 3.5 Transcribe cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["GEMINI_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://aistudio.google.com/apikey and set it in Settings -> API Keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::Qwen3Asr => {
            let model_dir = models_root.join("qwen3_asr");
            let model_ready = is_valid_onnx_artifact(&model_dir.join("encoder.int4.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_init.int4.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_step.int4.onnx"))
                && is_valid_json_artifact(&model_dir.join("config.json"), 64)
                && is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024);
            let mut missing_files = missing_or_invalid_qwen3_asr_files(model_dir.as_path());
            // Bytes that look right are not enough: readiness follows the
            // integrity receipts, the same rule `Qwen3AsrProvider::is_available`
            // applies, so the diagnostics never say Ready for a swapped file.
            let trusted = super::qwen3_asr::artifacts_trusted(model_dir.as_path());
            if model_ready && !trusted {
                missing_files.push(
                    "integrity receipts for the pinned Qwen3-ASR files (not verified)".to_string(),
                );
            }
            let model_ready = model_ready && trusted;
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message:
                        "Qwen3-ASR model files are missing or have not passed Plainsong integrity verification.",
                    setup_action: "Re-download Qwen3-ASR ONNX assets in Settings -> ASR Models.",
                },
                "Qwen3-ASR native ONNX inference ready.",
                last_error,
            )
        }
        AsrProviderType::CohereLocal => {
            use super::cohere_local;
            let model_dir = models_root.join(cohere_local::COHERE_LOCAL_MODEL_DIR);
            let mut missing_files = cohere_local::missing_or_invalid_files(model_dir.as_path());
            let model_ready = missing_files.is_empty();
            // Bytes that look right are not enough: 2 GiB of weights this app
            // never reads is exactly the artifact worth swapping, so readiness
            // follows the integrity receipts like every other local route.
            let trusted = cohere_local::artifacts_trusted(model_dir.as_path());
            if model_ready && !trusted {
                missing_files.push(
                    "integrity receipts for the pinned Cohere Transcribe files (not verified)"
                        .to_string(),
                );
            }
            let model_ready = model_ready && trusted;
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message:
                        "Cohere Transcribe (local) files are missing or have not passed Plainsong integrity verification.",
                    setup_action: "Download Cohere Transcribe (local) in Settings -> ASR Models.",
                },
                "Cohere Transcribe (local) ONNX inference ready, on CPU.",
                last_error,
            )
        }
        #[cfg(feature = "asr-transcribe-cpp")]
        AsrProviderType::TranscribeCpp => {
            use super::transcribe_cpp;
            let spec = transcribe_cpp::spec_for(selected_model_id);
            let model_dir = models_root.join(transcribe_cpp::TRANSCRIBE_CPP_MODEL_DIR);
            let model_path = model_dir.join(spec.file_name);
            let present = std::fs::metadata(&model_path)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false);
            // Bytes that look right are not enough, same rule as every other
            // local route: readiness follows the integrity receipt.
            let trusted =
                crate::download::is_model_artifact_trusted(&model_path, Some(spec.sha256));
            let mut missing_files = Vec::new();
            if !present {
                missing_files.push(spec.file_name.to_string());
            } else if !trusted {
                missing_files.push(format!(
                    "integrity receipt for {} (not verified)",
                    spec.file_name
                ));
            }
            runtime_native_model(
                provider_available,
                model_dir,
                present && trusted,
                &missing_files,
                MissingModelCopy {
                    message:
                        "The transcribe.cpp GGUF is missing or has not passed Plainsong integrity verification.",
                    setup_action:
                        "Re-download the transcribe.cpp model in Settings -> ASR Models.",
                },
                "transcribe.cpp GGUF inference ready (experimental).",
                last_error,
            )
        }
    }
}

/// The per-request options every meeting transcription uses.
///
/// The meeting lane always asks for speaker labels, even for a ninety-second
/// chunk whose labels it will then throw away. Gemini only returns word
/// timestamps on a request that also asks for diarization or timestamps, and a
/// meeting without timestamps has no timeline to seek, no diarization to merge
/// and no playhead to follow -- so asking is what buys the timings. Whether
/// the labels that come back are *usable* is decided afterwards by
/// `provider_speaker_turns_survive_chunking`, because a provider numbers its
/// speakers per request.
///
/// No vocabulary hint: the personal dictionary is a dictation feature, and
/// Gemini's API refuses it on the same request as timestamps anyway.
///
/// The language is carried because a cloud provider has to be told one; see
/// `TranscriptionOptions::language`.
fn meeting_transcription_options(language: Option<String>) -> TranscriptionOptions {
    TranscriptionOptions {
        request_speaker_labels: true,
        language,
        ..TranscriptionOptions::default()
    }
}

/// Diagnostics for native-inference providers (no Python, no external runtime).
fn runtime_native_model(
    provider_available: bool,
    model_dir: PathBuf,
    model_ready: bool,
    missing_files: &[String],
    missing_model_copy: MissingModelCopy<'_>,
    ready_message: &str,
    last_error: Option<&str>,
) -> RuntimeDiagnosticsInternal {
    if !model_ready {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingModel,
            runtime_message: Some(missing_model_copy.message.to_string()),
            runtime_details: RuntimeDetails {
                model_path: Some(model_dir.to_string_lossy().to_string()),
                python_path: None,
                missing_files: missing_files.to_vec(),
                setup_action: Some(missing_model_copy.setup_action.to_string()),
            },
        };
    }
    RuntimeDiagnosticsInternal {
        runtime_status: if provider_available {
            RuntimeStatus::Ready
        } else {
            RuntimeStatus::Error
        },
        runtime_message: Some(
            last_error
                .map(ToString::to_string)
                .unwrap_or_else(|| ready_message.to_string()),
        ),
        runtime_details: RuntimeDetails {
            model_path: Some(model_dir.to_string_lossy().to_string()),
            python_path: None,
            missing_files: Vec::new(),
            setup_action: None,
        },
    }
}

struct MissingModelCopy<'a> {
    message: &'a str,
    setup_action: &'a str,
}

fn missing_required_files(model_dir: &Path, required_files: &[&str]) -> Vec<String> {
    required_files
        .iter()
        .filter_map(|name| {
            let path = model_dir.join(name);
            if path.exists() {
                None
            } else {
                Some((*name).to_string())
            }
        })
        .collect()
}

fn missing_or_invalid_moonshine_files(model_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_onnx_artifact(&model_dir.join("encoder_model.onnx")) {
        missing.push("encoder_model.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_model_merged.onnx")) {
        missing.push("decoder_model_merged.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024) {
        missing.push("tokenizer.json (valid tokenizer)".to_string());
    }
    missing
}

fn missing_or_invalid_qwen3_asr_files(model_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_onnx_artifact(&model_dir.join("encoder.int4.onnx")) {
        missing.push("encoder.int4.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_init.int4.onnx")) {
        missing.push("decoder_init.int4.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_step.int4.onnx")) {
        missing.push("decoder_step.int4.onnx (valid ONNX model)".to_string());
    }
    if !std::path::Path::new(&model_dir.join("decoder_weights.int4.data")).exists() {
        missing.push("decoder_weights.int4.data (shared decoder weights)".to_string());
    }
    if !std::path::Path::new(&model_dir.join("embed_tokens.bin")).exists() {
        missing.push("embed_tokens.bin (token embedding cache)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("config.json"), 64) {
        missing.push("config.json (valid model config)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024) {
        missing.push("tokenizer.json (valid tokenizer)".to_string());
    }
    missing
}

/// Where a Parakeet route keeps its artifacts, and which of them are missing or
/// unusable.
///
/// Both routes are native ONNX, so neither reports a `python_path`. The legacy
/// 110M export sits directly in `models/parakeet`; TDT v3 gets a subdirectory
/// beside it. These paths and filenames have to match `asr/parakeet.rs` exactly
/// -- when they drifted apart, diagnostics reported Ready for a model that
/// transcription then could not find.
fn parakeet_model_dir_and_missing_files(
    models_root: &Path,
    normalized_model: &str,
) -> (PathBuf, Vec<String>) {
    let mut missing_files = Vec::new();

    if normalized_model == "parakeet-tdt-ctc-110m" {
        let model_dir = models_root.join("parakeet");
        let has_onnx = PARAKEET_ONNX_NAMES
            .iter()
            .any(|f| is_valid_onnx_artifact(&model_dir.join(f)));
        let has_vocab = PARAKEET_VOCAB_NAMES
            .iter()
            .any(|f| is_valid_token_list_artifact(&model_dir.join(f), 128));
        if !has_onnx {
            missing_files.push(format!(
                "{} (valid ONNX export)",
                PARAKEET_ONNX_NAMES.join(" or ")
            ));
        }
        if !has_vocab {
            missing_files.push("tokens.txt (valid token list)".to_string());
        }
        return (model_dir, missing_files);
    }

    let model_dir = models_root.join("parakeet").join(normalized_model);
    for (file_name, min_bytes) in PARAKEET_V3_REQUIRED_FILES {
        let path = model_dir.join(file_name);
        let ok = if file_name == "tokens.txt" {
            is_valid_token_list_artifact(&path, 128)
        } else {
            is_valid_sized_artifact(&path, min_bytes)
        };
        if !ok {
            missing_files.push(file_name.to_string());
        }
    }
    (model_dir, missing_files)
}

fn migrate_legacy_local_artifacts(models_root: &Path) {
    let parakeet_dir = models_root.join("parakeet");
    if !parakeet_dir.exists() {
        return;
    }

    let legacy_model = parakeet_dir.join("model.onnx");
    let target_model = parakeet_dir.join("encoder.onnx");
    if is_valid_onnx_artifact(&legacy_model) && !target_model.exists() {
        if let Err(error) = std::fs::copy(&legacy_model, &target_model) {
            tracing::warn!(
                "Failed to migrate legacy Parakeet model.onnx -> encoder.onnx: {}",
                error
            );
        }
    } else if legacy_model.exists() && !target_model.exists() {
        tracing::warn!(
            "Legacy Parakeet model.onnx exists but is invalid; skipping migration and requiring redownload."
        );
    }

    let legacy_vocab = parakeet_dir.join("vocab.txt");
    let target_vocab = parakeet_dir.join("tokens.txt");
    if is_valid_token_list_artifact(&legacy_vocab, 128) && !target_vocab.exists() {
        if let Err(error) = std::fs::copy(&legacy_vocab, &target_vocab) {
            tracing::warn!(
                "Failed to migrate legacy Parakeet vocab.txt -> tokens.txt: {}",
                error
            );
        }
    } else if legacy_vocab.exists() && !target_vocab.exists() {
        tracing::warn!(
            "Legacy Parakeet vocab.txt exists but is invalid; skipping migration and requiring redownload."
        );
    }
}

fn is_valid_onnx_artifact(path: &Path) -> bool {
    is_valid_sized_artifact(path, 4096)
}

/// A binary artifact that exists, clears `min_bytes`, and does not begin with
/// an HTML or JSON error marker.
///
/// The size floor is the part that matters for the large ONNX graphs: a stub or
/// half-extracted file passes the "not an error page" check and then fails deep
/// inside ONNX Runtime, where the message tells the user nothing actionable.
fn is_valid_sized_artifact(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes.max(4096) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 1];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

fn is_valid_token_list_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('{') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<html")
        || lower.starts_with("<!doctype")
        || lower.starts_with("<head")
        || lower.starts_with("<body")
    {
        return false;
    }

    let valid_lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let mut parts = line.split_whitespace();
            let token = parts.next();
            let maybe_id = parts.next_back();
            token.is_some()
                && maybe_id
                    .and_then(|value| value.parse::<usize>().ok())
                    .is_some()
        })
        .take(8)
        .count();

    valid_lines >= 4
}

fn is_valid_json_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok()
}

fn sanitize_whisper_model_id(model_id: &str) -> &'static str {
    match model_id {
        "tiny" => "tiny",
        "tiny.en" => "tiny.en",
        "base" => "base",
        "base.en" => "base.en",
        "small" => "small",
        "small.en" => "small.en",
        "medium" => "medium",
        "medium.en" => "medium.en",
        "large-v3-turbo" => "large-v3-turbo",
        "large-v3" => "large-v3",
        _ => "base.en",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        meeting_transcription_options, migrate_legacy_local_artifacts,
        parakeet_model_dir_and_missing_files, runtime_diagnostics_for_provider, AsrManager,
        AsrProviderType,
    };
    use crate::asr::AsrProviderFactory;
    use crate::settings::PlatformOptimizationSettings;
    use std::path::PathBuf;

    #[test]
    fn every_meeting_request_asks_for_speaker_labels_because_that_is_what_buys_timestamps() {
        // Gemini returns word timestamps only on a request that also asks for
        // diarization or timestamps. A meeting chunk that stopped asking would
        // come back as one untimed block, and the transcript would lose its
        // timeline, its playhead and any chance of a diarization merge -- a
        // regression that would look like "speakers stopped working" rather
        // than "timestamps stopped arriving".
        let options = meeting_transcription_options(None);
        assert!(options.request_speaker_labels);
        // And never the personal dictionary: it is a dictation feature, and
        // Gemini's API refuses it alongside timestamps.
        assert!(options.vocabulary_hint.is_none());
        assert!(!options.translate_to_english);
    }

    /// A meeting's options have to reach the provider, on the path as well as
    /// on the bytes route.
    ///
    /// They used to be dropped in path mode, so the whole-file providers
    /// hard-coded `request_speaker_labels: true` inside their own `transcribe`
    /// and nothing else -- a language, a keyterm list -- could ever arrive.
    #[tokio::test]
    async fn a_meeting_carries_the_selected_language_to_the_provider() {
        assert_eq!(meeting_transcription_options(None).language, None);
        assert_eq!(
            meeting_transcription_options(Some("fr".to_string())).language,
            Some("fr".to_string())
        );

        // And the manager is where the meeting lane learns it, because it
        // builds its own options and never sees the settings.
        let manager = AsrManager::new();
        assert_eq!(manager.transcription_language().await, None);
        manager
            .set_transcription_language(Some("de".to_string()))
            .await;
        assert_eq!(
            manager.transcription_language().await,
            Some("de".to_string())
        );
    }

    #[test]
    fn no_provider_is_gated_out_of_transcription_in_this_build() {
        // Qwen3-ASR was the last provider behind this gate; it was lifted
        // after the 2026-09-01 real-audio eval. If a provider needs to go
        // back behind it, this test is the place to say which and why.
        for provider in AsrProviderType::all() {
            assert!(
                AsrManager::is_provider_transcription_enabled(provider),
                "{provider:?} is gated out of transcription"
            );
        }
    }

    fn temp_models_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nautilus-asr-manager-tests-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp models root");
        root
    }

    /// Diagnostics must look for the same files `asr/parakeet.rs` loads.
    /// When they disagreed, the UI said Ready and transcription said missing.
    #[test]
    fn parakeet_v3_diagnostics_name_every_artifact_that_is_missing() {
        let models_root = temp_models_root();

        let (model_dir, missing) =
            parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-0.6b-v3");
        assert_eq!(
            model_dir,
            models_root.join("parakeet").join("parakeet-tdt-0.6b-v3"),
            "v3 lives in its own subdirectory, beside the legacy export"
        );
        assert_eq!(
            missing,
            vec![
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt"
            ]
        );

        let _ = std::fs::remove_dir_all(models_root);
    }

    #[test]
    fn parakeet_v3_diagnostics_reject_an_undersized_encoder() {
        let models_root = temp_models_root();
        let model_dir = models_root.join("parakeet").join("parakeet-tdt-0.6b-v3");
        std::fs::create_dir_all(&model_dir).expect("create v3 dir");

        for (file_name, min_bytes) in [
            ("decoder.int8.onnx", 1024 * 1024u64),
            ("joiner.int8.onnx", 512 * 1024),
        ] {
            let file = std::fs::File::create(model_dir.join(file_name)).expect("create");
            file.set_len(min_bytes + 1).expect("size");
        }
        // Big enough to look like a binary, far too small to be a 622 MB encoder.
        let encoder = std::fs::File::create(model_dir.join("encoder.int8.onnx")).expect("create");
        encoder.set_len(8192).expect("size");
        let vocab = (0..100)
            .map(|i| format!("tok{i} {i}\n"))
            .collect::<String>();
        std::fs::write(model_dir.join("tokens.txt"), vocab).expect("write tokens");

        let (_, missing) =
            parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-0.6b-v3");
        assert_eq!(missing, vec!["encoder.int8.onnx"]);

        let _ = std::fs::remove_dir_all(models_root);
    }

    /// The legacy export is named `encoder.onnx` by the provisioning script and
    /// `model.onnx` by older in-app downloads. `asr/parakeet.rs` accepts both,
    /// so diagnostics must too.
    #[test]
    fn parakeet_legacy_diagnostics_accept_either_graph_filename() {
        for graph_name in ["encoder.onnx", "model.onnx"] {
            let models_root = temp_models_root();
            let model_dir = models_root.join("parakeet");
            std::fs::create_dir_all(&model_dir).expect("create parakeet dir");
            std::fs::write(model_dir.join(graph_name), vec![0u8; 5000]).expect("write graph");
            let vocab = (0..100)
                .map(|i| format!("tok{i} {i}\n"))
                .collect::<String>();
            std::fs::write(model_dir.join("tokens.txt"), vocab).expect("write tokens");

            let (dir, missing) =
                parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-ctc-110m");
            assert_eq!(dir, model_dir);
            assert!(
                missing.is_empty(),
                "{graph_name} should satisfy diagnostics"
            );

            let _ = std::fs::remove_dir_all(models_root);
        }
    }

    #[test]
    fn migrates_legacy_parakeet_artifact_names() {
        let models_root = temp_models_root();
        let parakeet = models_root.join("parakeet");
        std::fs::create_dir_all(&parakeet).expect("create parakeet dir");
        let mut legacy_model = vec![0u8; 5000];
        legacy_model[0] = 1;
        std::fs::write(parakeet.join("model.onnx"), legacy_model).expect("write legacy model");
        let vocab_body = (0..100)
            .map(|i| format!("tok{} {}\n", i, i))
            .collect::<String>();
        std::fs::write(parakeet.join("vocab.txt"), vocab_body).expect("write legacy vocab");

        migrate_legacy_local_artifacts(&models_root);

        assert!(parakeet.join("encoder.onnx").exists());
        assert!(parakeet.join("tokens.txt").exists());
        let _ = std::fs::remove_dir_all(models_root);
    }

    #[test]
    fn migration_does_not_overwrite_new_parakeet_artifacts() {
        let models_root = temp_models_root();
        let parakeet = models_root.join("parakeet");
        std::fs::create_dir_all(&parakeet).expect("create parakeet dir");
        let mut legacy_model = vec![0u8; 5000];
        legacy_model[0] = 1;
        std::fs::write(parakeet.join("model.onnx"), legacy_model).expect("write legacy model");
        let vocab_body = (0..100)
            .map(|i| format!("tok{} {}\n", i, i))
            .collect::<String>();
        std::fs::write(parakeet.join("vocab.txt"), vocab_body).expect("write legacy vocab");
        std::fs::write(parakeet.join("encoder.onnx"), b"new-model").expect("write new model");
        std::fs::write(parakeet.join("tokens.txt"), b"new-vocab").expect("write new vocab");

        migrate_legacy_local_artifacts(&models_root);

        let encoder = std::fs::read(parakeet.join("encoder.onnx")).expect("read encoder");
        let tokens = std::fs::read(parakeet.join("tokens.txt")).expect("read tokens");
        assert_eq!(encoder, b"new-model");
        assert_eq!(tokens, b"new-vocab");
        let _ = std::fs::remove_dir_all(models_root);
    }

    #[tokio::test]
    async fn auto_mode_selects_runtime_engine_for_local_provider() {
        let manager = AsrManager::new();
        let optimization = PlatformOptimizationSettings {
            mode: "auto".to_string(),
            ..PlatformOptimizationSettings::default()
        };
        manager.set_platform_optimization(optimization).await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let distil = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::DistilWhisper)
            .expect("distil provider should exist");
        assert!(
            distil.engine_diagnostics.active_engine.as_deref().is_some(),
            "expected active engine to be present"
        );
    }

    #[tokio::test]
    async fn apple_speech_engine_override_does_not_replace_whisper() {
        let manager = AsrManager::new();
        let optimization = PlatformOptimizationSettings {
            mode: "manual".to_string(),
            macos: crate::settings::MacosPlatformOptimizationSettings {
                apple_native_enabled: true,
                ..crate::settings::MacosPlatformOptimizationSettings::default()
            },
            manual_engine_priority: vec!["macos_apple_speech".to_string()],
            ..PlatformOptimizationSettings::default()
        };
        manager.set_platform_optimization(optimization).await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let whisper = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::Whisper)
            .expect("whisper provider should exist");
        assert_eq!(
            whisper.engine_diagnostics.active_engine.as_deref(),
            Some("provider_default")
        );
        assert!(!whisper
            .engine_diagnostics
            .available_engines
            .iter()
            .any(|engine| engine == "macos_apple_speech"));
    }

    #[test]
    fn apple_speech_diagnostics_reuse_supplied_readiness() {
        use crate::asr::platform::macos_speech::{
            AppleSpeechReadiness, AppleSpeechReadinessStatus,
        };

        let readiness = AppleSpeechReadiness {
            status: AppleSpeechReadinessStatus::Ready,
            ready: true,
            platform_supported: true,
            helper_present: true,
            authorization: "authorized".to_string(),
            locale: Some("en_US".to_string()),
            locale_supported: true,
            on_device_available: true,
            recognizer_available: true,
            message: "synthetic single-probe readiness".to_string(),
            setup_action: None,
            speech_analyzer_available: false,
            speech_analyzer_locale_supported: false,
            speech_analyzer_assets_installed: false,
            speech_analyzer_asset_status: String::new(),
            speech_analyzer_locales: Vec::new(),
            speech_analyzer_installed_locales: Vec::new(),
            engine: crate::asr::platform::macos_speech::AppleSpeechEngine::SfSpeechRecognizer,
            operating_system_version: None,
        };
        let runtime = runtime_diagnostics_for_provider(
            AsrProviderType::MacosAppleSpeech,
            "macos_apple_speech",
            true,
            None,
            Some(&readiness),
        );
        assert_eq!(
            runtime.runtime_message.as_deref(),
            Some(readiness.message.as_str())
        );

        let engine = AsrManager::engine_diagnostics_for_provider(
            AsrProviderType::MacosAppleSpeech,
            "macos_apple_speech",
            &PlatformOptimizationSettings::default(),
            false,
            Some(&readiness),
        );
        assert!(engine
            .available_engines
            .iter()
            .any(|id| id == "macos_apple_speech"));
        assert!(engine
            .notes
            .iter()
            .any(|note| note == "synthetic single-probe readiness"));
    }

    #[tokio::test]
    async fn apple_speech_provider_reports_structured_platform_readiness() {
        let manager = AsrManager::new();
        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let apple = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            .expect("Apple Speech provider should exist");
        let readiness = apple
            .platform_readiness
            .as_ref()
            .expect("Apple Speech should expose structured readiness");

        assert_eq!(apple.is_available, readiness.ready);
        assert_eq!(
            matches!(apple.runtime_status, super::RuntimeStatus::Ready),
            readiness.ready
        );
    }

    #[tokio::test]
    async fn cached_provider_views_refresh_without_locking_the_cache() {
        let manager = AsrManager::new();
        manager
            .get_all_providers_info()
            .await
            .expect("initial provider info should load");
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            manager.get_all_providers_info(),
        )
        .await
        .expect("cached provider info refresh must not deadlock")
        .expect("cached provider info should refresh");

        manager
            .get_provider_inventory()
            .await
            .expect("initial provider inventory should load");
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            manager.get_provider_inventory(),
        )
        .await
        .expect("cached provider inventory refresh must not deadlock")
        .expect("cached provider inventory should refresh");
    }

    /// Apple Speech reaches meeting transcription only through SpeechAnalyzer,
    /// the one of its two engines that returns per-segment timestamps.
    ///
    /// Both branches are asserted, with the capability pinned for each rather
    /// than left to whichever machine runs the suite: read from the process
    /// flag, the "capable" branch never ran anywhere, because nothing has
    /// probed in a fresh test process. Neither branch ever transcribes: the
    /// bytes are not audio.
    #[tokio::test]
    async fn apple_speech_reaches_meeting_transcription_only_through_speech_analyzer() {
        use crate::asr::platform::macos_speech::{
            meeting_capability, set_meeting_capability_for_test, AppleSpeechMeetingCapability,
        };

        let manager = AsrManager::new();
        let restore = meeting_capability();

        set_meeting_capability_for_test(AppleSpeechMeetingCapability::Unsupported);
        let refused = manager
            .transcribe_bytes_for_meeting(
                AsrProviderType::MacosAppleSpeech,
                b"not audio",
                Some("macos_apple_speech"),
            )
            .await
            .expect_err("a route without SpeechAnalyzer must be refused");
        assert!(refused.to_string().contains("serves meetings only"));
        assert!(refused.to_string().contains("SpeechAnalyzer"));
        assert!(refused.to_string().contains("macOS 26"));

        set_meeting_capability_for_test(AppleSpeechMeetingCapability::Supported);
        let decoded = manager
            .transcribe_bytes_for_meeting(
                AsrProviderType::MacosAppleSpeech,
                b"not audio",
                Some("macos_apple_speech"),
            )
            .await
            .expect_err("bytes that are not audio must never transcribe");
        assert!(
            !decoded.to_string().contains("serves meetings only"),
            "a meeting-capable route must get past the capability gate: {decoded}"
        );

        set_meeting_capability_for_test(restore);
    }

    /// The last net under the required-engine check: a text-only Apple Speech
    /// result means SFSpeechRecognizer ran, and saving it produces a meeting
    /// with a full transcript, zero timestamps and no error anywhere.
    #[test]
    fn an_apple_meeting_result_without_timestamps_is_refused() {
        let refusal = |provider, text: &str, segments| {
            AsrManager::untimestamped_meeting_refusal(provider, text, segments)
        };

        let refused = refusal(AsrProviderType::MacosAppleSpeech, "hello there", 0)
            .expect("text with no segments must be refused");
        assert!(refused.contains("SFSpeechRecognizer"), "{refused}");
        assert!(refused.contains("SpeechAnalyzer"), "{refused}");

        // Timestamps present: this is what SpeechAnalyzer returns.
        assert!(refusal(AsrProviderType::MacosAppleSpeech, "hello there", 2).is_none());
        // Nothing was recognized; that is a different (already handled) case
        // and not evidence about which engine ran.
        assert!(refusal(AsrProviderType::MacosAppleSpeech, "   ", 0).is_none());
        // Every other provider's meeting segments come from its own path.
        assert!(refusal(AsrProviderType::Whisper, "hello there", 0).is_none());
    }

    #[tokio::test]
    async fn requested_download_model_overrides_provider_state() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "base.en".to_string())
            .await;

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Whisper, Some("large-v3-turbo"))
                .await
                .expect("requested model should resolve"),
            "large-v3-turbo"
        );
    }

    #[tokio::test]
    async fn download_model_falls_back_to_provider_state_for_legacy_callers() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "small.en".to_string())
            .await;

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Whisper, None)
                .await
                .expect("selected model should resolve"),
            "small.en"
        );
    }

    #[tokio::test]
    async fn download_model_normalizes_legacy_parakeet_ids() {
        let manager = AsrManager::new();

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Parakeet, Some("parakeet-ctc-0.6b"),)
                .await
                .expect("legacy Parakeet model should resolve"),
            "parakeet-tdt-0.6b-v3"
        );
    }

    #[tokio::test]
    async fn download_model_rejects_unknown_provider_model_pair() {
        let manager = AsrManager::new();
        let error = manager
            .resolve_download_model_id(AsrProviderType::Whisper, Some("not-a-whisper-model"))
            .await
            .expect_err("unknown model should be rejected");

        assert!(error.to_string().contains("not available"));
    }

    #[tokio::test]
    async fn groq_provider_honors_selected_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Groq, "whisper-large-v3".to_string())
            .await;

        let provider = manager.get_provider(AsrProviderType::Groq).await;
        let model = provider.model_info();

        assert_eq!(model.version, "whisper-large-v3");
    }

    #[tokio::test]
    async fn moonshine_provider_honors_selected_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Moonshine, "moonshine-tiny".to_string())
            .await;

        let provider = manager.get_provider(AsrProviderType::Moonshine).await;
        let model = provider.model_info();

        assert_eq!(model.name, "Moonshine Tiny");
        assert_eq!(model.version, "tiny");
    }

    #[tokio::test]
    async fn mlx_keep_warm_helpers_are_runtime_safe() {
        let manager = AsrManager::new();
        manager
            .set_mlx_accelerated_providers(std::iter::once(AsrProviderType::Whisper).collect())
            .await;

        assert!(
            manager
                .supports_short_keep_warm(AsrProviderType::Whisper, "base.en")
                .await
        );

        manager
            .cool_down_local_route(AsrProviderType::Whisper, "base.en")
            .await;
    }

    #[tokio::test]
    async fn provider_info_reports_selected_model_ids_for_configured_routes() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "base.en".to_string())
            .await;
        manager
            .set_provider_model_id(
                AsrProviderType::Parakeet,
                "parakeet-tdt-ctc-110m".to_string(),
            )
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Moonshine, "moonshine-tiny".to_string())
            .await;
        manager
            .set_provider_model_id(
                AsrProviderType::OpenAiCloud,
                "gpt-4o-mini-transcribe".to_string(),
            )
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Groq, "whisper-large-v3".to_string())
            .await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");

        let selected_model_id = |provider_type| {
            providers
                .iter()
                .find(|provider| provider.provider_type == provider_type)
                .map(|provider| provider.selected_model_id.as_str())
                .expect("provider info should exist")
        };

        assert_eq!(selected_model_id(AsrProviderType::Whisper), "base.en");
        assert_eq!(
            selected_model_id(AsrProviderType::Parakeet),
            "parakeet-tdt-ctc-110m"
        );
        assert_eq!(
            selected_model_id(AsrProviderType::Moonshine),
            "moonshine-tiny"
        );
        assert_eq!(
            selected_model_id(AsrProviderType::OpenAiCloud),
            "gpt-4o-mini-transcribe"
        );
        assert_eq!(selected_model_id(AsrProviderType::Groq), "whisper-large-v3");
    }

    #[tokio::test]
    async fn parakeet_provider_preserves_recommended_v3_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(
                AsrProviderType::Parakeet,
                "parakeet-tdt-0.6b-v3".to_string(),
            )
            .await;

        assert_eq!(
            manager.provider_model_id(AsrProviderType::Parakeet).await,
            "parakeet-tdt-0.6b-v3"
        );

        let provider = manager.get_provider(AsrProviderType::Parakeet).await;
        assert_eq!(provider.model_info().version, "0.6b-v3");
    }

    #[test]
    fn create_with_model_constructs_every_provider_option() {
        for provider_type in AsrProviderType::all() {
            for model_option in provider_type.model_options() {
                let provider = AsrProviderFactory::create_with_model(
                    provider_type,
                    Some(model_option.id.as_str()),
                );
                let model = provider.model_info();

                assert!(
                    !provider.name().trim().is_empty(),
                    "provider name should exist for {:?} {}",
                    provider_type,
                    model_option.id
                );
                assert!(
                    !model.name.trim().is_empty(),
                    "model info should exist for {:?} {}",
                    provider_type,
                    model_option.id
                );
            }
        }
    }
}
