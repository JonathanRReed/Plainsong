use super::{
    platform::{EngineDiagnostics, PlatformEngine},
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

// Parakeet: native ONNX inference — sherpa-onnx format (encoder.onnx + tokens.txt)
const PARAKEET_ONNX_NAMES: [&str; 1] = ["encoder.onnx"];
const PARAKEET_VOCAB_NAMES: [&str; 1] = ["tokens.txt"];
// Whisper Candle: Whisper Large V3 Turbo via Candle (no Python)
const CANARY_REQUIRED_FILES: [&str; 4] = [
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
#[allow(dead_code)]
pub struct AsrManager {
    default_provider: RwLock<AsrProviderType>,
    selected_model_id: RwLock<String>,
    provider_model_ids: RwLock<HashMap<AsrProviderType, String>>,
    /// Legacy global set — kept for provider-info display and backward-compat callers.
    mlx_accelerated_providers: RwLock<HashSet<AsrProviderType>>,
    /// Per-slot MLX flags — these are the authoritative source for routing.
    dictation_mlx_enabled: RwLock<bool>,
    meeting_mlx_enabled: RwLock<bool>,
    silence_skip_enabled: RwLock<bool>,
    platform_optimization: RwLock<crate::settings::PlatformOptimizationSettings>,
    last_runtime_errors: RwLock<HashMap<AsrProviderType, String>>,
    provider_info_cache: RwLock<Option<Vec<ProviderInfo>>>,
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
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
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
            // Distil-Whisper is 6x faster than Whisper for English
            default_provider: RwLock::new(AsrProviderType::DistilWhisper),
            selected_model_id: RwLock::new(
                AsrProviderType::DistilWhisper
                    .default_model_id()
                    .to_string(),
            ),
            provider_model_ids: RwLock::new(provider_model_ids),
            mlx_accelerated_providers: RwLock::new(HashSet::new()),
            dictation_mlx_enabled: RwLock::new(false),
            meeting_mlx_enabled: RwLock::new(false),
            last_runtime_errors: RwLock::new(HashMap::new()),
            provider_info_cache: RwLock::new(None),
            models_dir,
        }
    }

    fn normalize_model_id(provider_type: AsrProviderType, model_id: &str) -> String {
        let trimmed = model_id.trim();
        let candidate = if trimmed.is_empty() {
            provider_type.default_model_id()
        } else {
            trimmed
        };

        match provider_type {
            AsrProviderType::Parakeet => match candidate {
                "parakeet-tdt-0.6b-v3" | "parakeet-ctc-0.6b" => "parakeet-ctc-0.6b".to_string(),
                "parakeet-ctc-1.1b" => "parakeet-ctc-1.1b".to_string(),
                "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => {
                    "parakeet-tdt-ctc-110m".to_string()
                }
                _ => "parakeet-ctc-0.6b".to_string(),
            },
            AsrProviderType::Voxtral => match candidate {
                "voxtral-mini-4b" => "voxtral-local".to_string(),
                "voxtral-local" | "voxtral-cloud" => candidate.to_string(),
                _ => "voxtral-local".to_string(),
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
        if requested_provider != AsrProviderType::MlxAudio
            && cfg!(all(target_os = "macos", target_arch = "aarch64"))
            && optimization.macos.mlx_enabled
            && mlx_enabled
        {
            if let Some(mlx_model_id) = crate::asr::mlx_audio::mapped_model_for_visible_route(
                requested_provider,
                normalized_model_id.as_str(),
            ) {
                return EffectiveProviderSelection {
                    provider_type: AsrProviderType::MlxAudio,
                    model_id: mlx_model_id.to_string(),
                    mlx_accelerated: true,
                };
            }
        }

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
            | AsrProviderType::MlxAudio => true,
            AsrProviderType::Parakeet => effective.model_id == "parakeet-tdt-ctc-110m",
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
                super::canary::clear_cached_runtime(&self.models_dir.join("canary"));
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
            AsrProviderType::MlxAudio => {
                let _ = effective.model_id;
            }
            AsrProviderType::Parakeet if effective.model_id == "parakeet-tdt-ctc-110m" => {
                super::parakeet::clear_cached_session();
            }
            _ => {}
        }
    }

    pub async fn invalidate_provider_info_cache(&self) {
        *self.provider_info_cache.write().await = None;
    }

    /// Get a provider by type - creates fresh instance each time
    #[allow(dead_code)]
    pub async fn get_provider(&self, provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        let selected_model = self.provider_model_id(provider_type).await;
        Self::provider_with_model(provider_type, Some(selected_model.as_str()))
    }

    /// Whether the provider has active transcription inference in this build.
    pub fn is_provider_transcription_enabled(provider_type: AsrProviderType) -> bool {
        let _ = provider_type;
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
        let last_error = self
            .last_runtime_errors
            .read()
            .await
            .get(&effective.provider_type)
            .cloned();

        let diagnostics = runtime_diagnostics_for_provider(
            effective.provider_type,
            effective.model_id.as_str(),
            provider.is_available(),
            last_error.as_deref(),
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
    ) -> Result<TranscriptionResult> {
        let provider = Self::provider_with_model(actual_provider, Some(model_id));
        let primary_result = match (file_path, audio_data) {
            (Some(path), None) => provider.transcribe(path).await,
            (None, Some(bytes)) => provider.transcribe_bytes(bytes).await,
            _ => Err(anyhow::anyhow!("Invalid transcription input")),
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

                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                if optimization.macos.apple_native_enabled {
                    return Some(PlatformEngine::MacosAppleSpeech);
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
        self.transcribe_inner(provider_type, Some(audio_path), None, None, None)
            .await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(provider_type, None, Some(audio_data), None, None)
            .await
    }

    /// Transcribe bytes with a specific provider (uses the global MLX accelerated set).
    pub async fn transcribe_bytes_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(provider_type, None, Some(audio_data), selected_model, None)
            .await
    }

    /// Transcribe bytes for the dictation route slot (uses per-slot dictation MLX flag).
    pub async fn transcribe_bytes_for_dictation(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        let mlx_enabled = *self.dictation_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            selected_model,
            Some(mlx_enabled),
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
        let mlx_enabled = *self.meeting_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            selected_model,
            Some(mlx_enabled),
        )
        .await
    }

    /// Transcribe with a specific provider
    #[allow(dead_code)]
    pub async fn transcribe_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_path: &Path,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(provider_type, Some(audio_path), None, None, None)
            .await
    }

    /// Get info for all providers (Parallelized)
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        if let Some(cached) = self.provider_info_cache.read().await.clone() {
            return Ok(cached);
        }

        let provider_models = self.provider_model_map().await;
        let last_errors = self.last_runtime_errors.read().await.clone();
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
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
                    let is_available = provider.is_available();
                    let diagnostics = runtime_diagnostics_for_provider(
                        effective.provider_type,
                        effective.model_id.as_str(),
                        is_available,
                        last_error.as_deref(),
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
                        ),
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
            let probe = engine.probe();
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
                        && engine.probe().ready
                        && Self::engine_runtime_executable(*engine))
            })
            .map(|engine| engine.id().to_string());

        diagnostics.active_engine =
            active.or_else(|| Some(PlatformEngine::ProviderDefault.id().to_string()));

        diagnostics
    }

    /// Download models for a provider
    pub async fn download_models(
        &self,
        provider_type: AsrProviderType,
        progress_cb: Box<dyn Fn(f32) + Send + Sync>,
    ) -> Result<()> {
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
        let result = provider.download_models(progress_cb).await;
        self.invalidate_provider_info_cache().await;
        result
    }

    /// Get models directory
    #[allow(dead_code)]
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
) -> RuntimeDiagnosticsInternal {
    let models_root = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
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
            if normalized_model == "parakeet-tdt-ctc-110m" {
                let model_dir = models_root.join("parakeet");
                let has_onnx = PARAKEET_ONNX_NAMES
                    .iter()
                    .any(|f| is_valid_onnx_artifact(&model_dir.join(f)));
                let has_vocab = PARAKEET_VOCAB_NAMES
                    .iter()
                    .any(|f| is_valid_token_list_artifact(&model_dir.join(f), 128));
                let model_ready = has_onnx && has_vocab;
                let mut missing_files = Vec::new();
                if !has_onnx {
                    missing_files.push("encoder.onnx (valid ONNX export)".to_string());
                }
                if !has_vocab {
                    missing_files.push("tokens.txt (valid token list)".to_string());
                }
                if !model_ready {
                    return RuntimeDiagnosticsInternal {
                        runtime_status: RuntimeStatus::MissingModel,
                        runtime_message: Some(
                            "Parakeet legacy model not downloaded. Download encoder.onnx + tokens.txt from Settings -> ASR Models."
                                .to_string(),
                        ),
                        runtime_details: RuntimeDetails {
                            model_path: Some(model_dir.to_string_lossy().to_string()),
                            python_path: None,
                            missing_files,
                            setup_action: Some(
                                "Download Parakeet legacy artifacts (encoder.onnx + tokens.txt) in Settings -> ASR Models.".to_string(),
                            ),
                        },
                    };
                }
                return RuntimeDiagnosticsInternal {
                    runtime_status: if provider_available {
                        RuntimeStatus::Ready
                    } else {
                        RuntimeStatus::Error
                    },
                    runtime_message: Some(
                        last_error
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "Parakeet legacy ONNX runtime ready.".to_string()),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: Vec::new(),
                        setup_action: None,
                    },
                };
            }

            let model_dir = models_root.join(normalized_model.replace('-', "_"));
            let manifest = model_dir.join("manifest.json");
            let detected_python = super::python_runtime::find_python_for_provider("parakeet_ctc")
                .or_else(super::python_runtime::managed_python_path);
            if !manifest.exists() {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(format!(
                        "Parakeet model '{}' is not downloaded yet.",
                        normalized_model
                    )),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: detected_python,
                        missing_files: vec!["manifest.json".to_string()],
                        setup_action: Some(
                            "Download the selected Parakeet bundle in Settings -> ASR Models."
                                .to_string(),
                        ),
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
                    format!("Parakeet runtime ready for {}.", normalized_model)
                })),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: detected_python,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::WhisperCandle => {
            let model_dir = models_root.join("canary");
            let model_ready = CANARY_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_required_files(
                    models_root.join("canary").as_path(),
                    &CANARY_REQUIRED_FILES,
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
        AsrProviderType::MlxAudio => {
            if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingRuntime,
                    runtime_message: Some("MLX Audio requires macOS on Apple Silicon.".to_string()),
                    runtime_details: RuntimeDetails {
                        model_path: None,
                        python_path: None,
                        missing_files: vec!["Apple Silicon (M-series)".to_string()],
                        setup_action: Some(
                            "Use an Apple Silicon Mac, or choose another ASR provider.".to_string(),
                        ),
                    },
                };
            }

            let normalized_model = crate::asr::mlx_audio::normalize_model_id(selected_model_id);
            let model_dir = crate::asr::mlx_audio::model_dir_for(normalized_model.as_str());
            let model_ready = crate::asr::mlx_audio::model_is_ready(normalized_model.as_str());
            let detected_python = super::python_runtime::find_python_for_provider("mlx_audio_stt")
                .or_else(super::python_runtime::managed_python_path);

            if detected_python.is_none() {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingRuntime,
                    runtime_message: Some(
                        "MLX Audio runtime missing: install mlx-audio 0.4.1+ in the managed runtime."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: vec!["mlx-audio[stt]>=0.4.1".to_string()],
                        setup_action: Some(
                            "Use Download on the selected MLX Audio model to bootstrap the managed MLX runtime."
                                .to_string(),
                        ),
                    },
                };
            }

            if !model_ready {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(format!(
                        "MLX Audio model '{}' is not downloaded yet.",
                        normalized_model
                    )),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: detected_python,
                        missing_files: vec!["model artifacts".to_string()],
                        setup_action: Some(
                            "Download the selected MLX Audio model in Settings -> ASR / Providers."
                                .to_string(),
                        ),
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
                        .unwrap_or_else(|| "MLX Audio runtime ready.".to_string()),
                ),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: detected_python,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::MacosAppleSpeech => {
            let probe = PlatformEngine::MacosAppleSpeech.probe();
            let authorization = crate::asr::platform::macos_speech::speech_authorization_status();
            let (runtime_status, runtime_message) = match authorization {
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::Authorized => (
                    if provider_available && probe.ready {
                        RuntimeStatus::Ready
                    } else {
                        RuntimeStatus::MissingRuntime
                    },
                    "Apple native speech runtime ready.".to_string(),
                ),
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::NotDetermined => (
                    RuntimeStatus::Error,
                    "Apple native speech permission has not been granted yet.".to_string(),
                ),
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::Denied => (
                    RuntimeStatus::Error,
                    "Apple native speech permission is denied. Enable Nautilus in System Settings > Privacy & Security > Speech Recognition.".to_string(),
                ),
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::Restricted => (
                    RuntimeStatus::Error,
                    "Apple native speech permission is restricted by system policy.".to_string(),
                ),
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::Unavailable => (
                    RuntimeStatus::MissingRuntime,
                    "Apple native speech is unavailable in this build.".to_string(),
                ),
                crate::asr::platform::macos_speech::SpeechAuthorizationStatus::Unknown(status) => (
                    RuntimeStatus::Error,
                    format!(
                        "Apple native speech returned an unknown authorization status: {}.",
                        status
                    ),
                ),
            };

            RuntimeDiagnosticsInternal {
                runtime_status,
                runtime_message: Some(runtime_message),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: Some(if probe.ready {
                        "Grant Speech Recognition permission in macOS System Settings, or choose another ASR provider."
                            .to_string()
                    } else {
                        probe.notes.join(" ")
                    }),
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

        AsrProviderType::Voxtral => {
            let cloud_mode = selected_model_id.trim() == "voxtral-cloud";
            let has_key = has_provider_secret_or_env("mistral", "MISTRAL_API_KEY");
            let model_dir = models_root.join("voxtral");
            if cloud_mode {
                return RuntimeDiagnosticsInternal {
                    runtime_status: if has_key {
                        RuntimeStatus::Ready
                    } else {
                        RuntimeStatus::MissingRuntime
                    },
                    runtime_message: Some(if has_key {
                        "Voxtral cloud runtime ready (Mistral API key present).".to_string()
                    } else {
                        "Voxtral cloud mode requires MISTRAL_API_KEY.".to_string()
                    }),
                    runtime_details: RuntimeDetails {
                        model_path: None,
                        python_path: None,
                        missing_files: if has_key {
                            Vec::new()
                        } else {
                            vec!["MISTRAL_API_KEY".to_string()]
                        },
                        setup_action: if has_key {
                            None
                        } else {
                            Some("Set MISTRAL_API_KEY in Settings -> API Keys.".to_string())
                        },
                    },
                };
            }

            let missing_files = missing_or_invalid_voxtral_local_files(&model_dir);
            let has_local = missing_files.is_empty();
            let python = super::python_runtime::find_python_for_provider("voxtral_local");
            let managed_python = super::python_runtime::managed_python_path();
            let detected_python = python.or(managed_python);

            if !has_local {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(
                        "Voxtral local model not downloaded. Download model assets before use."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: detected_python,
                        missing_files,
                        setup_action: Some(
                            "Use Download on Voxtral (local mode) to fetch assets and bootstrap runtime."
                                .to_string(),
                        ),
                    },
                };
            }

            if detected_python.is_none() {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingRuntime,
                    runtime_message: Some(
                        "Voxtral local runtime missing: bootstrap managed Python runtime for local mode."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: Vec::new(),
                        setup_action: Some(
                            "Click Download or Re-check runtime to bootstrap managed runtime.".to_string(),
                        ),
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
                        .unwrap_or_else(|| "Voxtral local runtime ready.".to_string()),
                ),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: detected_python,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
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

fn has_any_safetensors(model_dir: &Path, min_bytes: u64) -> bool {
    std::fs::read_dir(model_dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.extension()
                    .map(|ext| ext == "safetensors")
                    .unwrap_or(false)
                    && is_valid_binary_artifact(&path, min_bytes)
            })
        })
        .unwrap_or(false)
}

fn missing_or_invalid_voxtral_local_files(model_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_json_artifact(&model_dir.join("config.json"), 64) {
        missing.push("config.json (valid JSON)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("processor_config.json"), 64) {
        missing.push("processor_config.json (valid JSON)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("tekken.json"), 64) {
        missing.push("tekken.json (valid JSON)".to_string());
    }
    let has_weights = is_valid_binary_artifact(&model_dir.join("model.safetensors"), 1024)
        || is_valid_binary_artifact(&model_dir.join("consolidated.safetensors"), 1024)
        || has_any_safetensors(model_dir, 1024);
    if !has_weights {
        missing.push("model.safetensors|consolidated.safetensors|*.safetensors".to_string());
    }
    missing
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
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 4096 {
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

fn is_valid_binary_artifact(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
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
        migrate_legacy_local_artifacts, missing_or_invalid_voxtral_local_files, AsrManager,
        AsrProviderType,
    };
    use crate::asr::AsrProviderFactory;
    use crate::settings::PlatformOptimizationSettings;
    use std::path::PathBuf;

    fn temp_models_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nautilus-asr-manager-tests-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp models root");
        root
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

    #[test]
    fn voxtral_diagnostics_report_invalid_local_payloads() {
        let models_root = temp_models_root();
        let voxtral = models_root.join("voxtral");
        std::fs::create_dir_all(&voxtral).expect("create voxtral dir");

        std::fs::write(voxtral.join("config.json"), b"<html>not json</html>")
            .expect("write invalid config");
        std::fs::write(
            voxtral.join("processor_config.json"),
            serde_json::json!({"processor": "ok", "padding": "long-enough-for-min-size-check"})
                .to_string(),
        )
        .expect("write processor config");
        std::fs::write(
            voxtral.join("tekken.json"),
            serde_json::json!({"tokens": ["a", "b", "c"], "meta": "long-enough-for-min-size-check"})
                .to_string(),
        )
        .expect("write tekken");
        std::fs::write(voxtral.join("model.safetensors"), b"tiny").expect("write invalid weights");

        let missing = missing_or_invalid_voxtral_local_files(&voxtral);
        assert!(
            missing.iter().any(|entry| entry.contains("config.json")),
            "config should be reported invalid"
        );
        assert!(
            missing
                .iter()
                .any(|entry| entry.contains("model.safetensors")),
            "weights should be reported invalid"
        );

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
    async fn manual_mode_honors_engine_priority() {
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
        let expected = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some("macos_apple_speech")
        } else {
            Some("provider_default")
        };
        assert_eq!(
            whisper.engine_diagnostics.active_engine.as_deref(),
            expected
        );
    }

    #[tokio::test]
    async fn mlx_acceleration_reuses_visible_provider_slot() {
        let manager = AsrManager::new();
        manager
            .set_mlx_accelerated_providers(std::iter::once(AsrProviderType::Moonshine).collect())
            .await;

        let (provider, model_id, accelerated) = manager
            .resolve_effective_provider_and_model(AsrProviderType::Moonshine, "moonshine-base")
            .await;

        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(provider, AsrProviderType::MlxAudio);
            assert_eq!(model_id, "UsefulSensors/moonshine-base");
            assert!(accelerated);
        } else {
            assert_eq!(provider, AsrProviderType::Moonshine);
            assert_eq!(model_id, "moonshine-base");
            assert!(!accelerated);
        }
    }

    #[tokio::test]
    async fn mlx_audio_no_longer_reports_sidecar_as_active_engine() {
        let diagnostics = AsrManager::engine_diagnostics_for_provider(
            AsrProviderType::MlxAudio,
            crate::asr::mlx_audio::default_model_id(),
            &PlatformOptimizationSettings::default(),
            false,
        );
        assert_eq!(
            diagnostics.active_engine.as_deref(),
            Some("provider_default")
        );
        assert!(!diagnostics
            .available_engines
            .iter()
            .any(|engine| engine == "macos_mlx_sidecar"));
    }

    #[tokio::test]
    async fn diagnostics_report_ready_native_engines_even_when_disabled() {
        let manager = AsrManager::new();
        manager
            .set_platform_optimization(PlatformOptimizationSettings::default())
            .await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let whisper = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::Whisper)
            .expect("whisper provider should exist");

        if cfg!(all(
            target_os = "macos",
            target_arch = "aarch64",
            nautilus_macos_speech_helper
        )) {
            assert!(
                whisper
                    .engine_diagnostics
                    .available_engines
                    .iter()
                    .any(|engine| engine == "macos_apple_speech"),
                "macOS Apple Speech should be reported as available even before the toggle is enabled"
            );
        }
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
    async fn mlx_audio_provider_honors_selected_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(
                AsrProviderType::MlxAudio,
                "mlx-community/SenseVoiceSmall".to_string(),
            )
            .await;

        let provider = manager.get_provider(AsrProviderType::MlxAudio).await;
        let model = provider.model_info();

        assert_eq!(model.version, "mlx-community/SenseVoiceSmall");
    }

    #[tokio::test]
    async fn mlx_keep_warm_helpers_are_runtime_safe() {
        let manager = AsrManager::new();
        manager
            .set_mlx_accelerated_providers(std::iter::once(AsrProviderType::Whisper).collect())
            .await;

        assert!(manager
            .supports_short_keep_warm(AsrProviderType::Whisper, "base.en")
            .await);

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
            .set_provider_model_id(AsrProviderType::Parakeet, "parakeet-ctc-1.1b".to_string())
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Moonshine, "moonshine-tiny".to_string())
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Voxtral, "voxtral-cloud".to_string())
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
            "parakeet-ctc-1.1b"
        );
        assert_eq!(
            selected_model_id(AsrProviderType::Moonshine),
            "moonshine-tiny"
        );
        assert_eq!(selected_model_id(AsrProviderType::Voxtral), "voxtral-cloud");
        assert_eq!(
            selected_model_id(AsrProviderType::OpenAiCloud),
            "gpt-4o-mini-transcribe"
        );
        assert_eq!(selected_model_id(AsrProviderType::Groq), "whisper-large-v3");
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
