use super::{
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

// Parakeet: native ONNX inference — sherpa-onnx format (encoder.onnx + tokens.txt)
// Legacy names (model.onnx / vocab.txt) are also accepted by the provider itself.
const PARAKEET_ONNX_NAMES: [&str; 2] = ["encoder.onnx", "model.onnx"];
const PARAKEET_VOCAB_NAMES: [&str; 2] = ["tokens.txt", "vocab.txt"];
// Canary: Whisper Large V3 Turbo via Candle (no Python)
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
// Moonshine: native ONNX (no Python)
const MOONSHINE_REQUIRED_FILES: [&str; 3] = [
    "encode.onnx",
    "uncached_decode.onnx",
    "tokenizer.json",
];

/// Manages multiple ASR providers
#[allow(dead_code)]
pub struct AsrManager {
    default_provider: RwLock<AsrProviderType>,
    selected_model_id: RwLock<String>,
    provider_model_ids: RwLock<HashMap<AsrProviderType, String>>,
    allow_whisper_fallback: RwLock<bool>,
    silence_skip_enabled: RwLock<bool>,
    last_runtime_errors: RwLock<HashMap<AsrProviderType, String>>,
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

        let provider_model_ids: HashMap<AsrProviderType, String> = AsrProviderType::all()
            .into_iter()
            .map(|provider| (provider, provider.default_model_id().to_string()))
            .collect();

        Self {
            silence_skip_enabled: RwLock::new(false),
            default_provider: RwLock::new(AsrProviderType::Whisper),
            selected_model_id: RwLock::new(AsrProviderType::Whisper.default_model_id().to_string()),
            provider_model_ids: RwLock::new(provider_model_ids),
            allow_whisper_fallback: RwLock::new(false),
            last_runtime_errors: RwLock::new(HashMap::new()),
            models_dir,
        }
    }

    fn normalize_model_id(provider_type: AsrProviderType, model_id: &str) -> String {
        let trimmed = model_id.trim();
        if trimmed.is_empty() {
            provider_type.default_model_id().to_string()
        } else {
            trimmed.to_string()
        }
    }

    fn provider_with_model(
        provider_type: AsrProviderType,
        selected_model_id: Option<&str>,
    ) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::Whisper | AsrProviderType::DistilWhisper => {
                AsrProviderFactory::create_with_model(provider_type, selected_model_id)
            }
            _ => AsrProviderFactory::create(provider_type),
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
    }

    pub async fn set_allow_whisper_fallback(&self, allow: bool) {
        *self.allow_whisper_fallback.write().await = allow;
    }

    pub async fn allow_whisper_fallback(&self) -> bool {
        *self.allow_whisper_fallback.read().await
    }

    pub async fn set_silence_skip_enabled(&self, enabled: bool) {
        *self.silence_skip_enabled.write().await = enabled;
    }

    pub async fn silence_skip_enabled(&self) -> bool {
        *self.silence_skip_enabled.read().await
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
    }

    pub async fn get_runtime_diagnostics(
        &self,
        provider_type: AsrProviderType,
    ) -> RuntimeDiagnostics {
        let selected_model = self.provider_model_id(provider_type).await;
        let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
        let last_error = self
            .last_runtime_errors
            .read()
            .await
            .get(&provider_type)
            .cloned();

        let diagnostics = runtime_diagnostics_for_provider(
            provider_type,
            selected_model.as_str(),
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
    ) -> Result<TranscriptionResult> {
        let resolved_model = match selected_model {
            Some(value) => Self::normalize_model_id(provider_type, value),
            None => self.provider_model_id(provider_type).await,
        };
        let provider = Self::provider_with_model(provider_type, Some(resolved_model.as_str()));
        let fallback_allowed = self.allow_whisper_fallback().await;
        let skip_silence = self.silence_skip_enabled().await;

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

        let primary_result = match (file_path, effective_audio_data) {
            (Some(path), None) => provider.transcribe(path).await,
            (None, Some(bytes)) => provider.transcribe_bytes(bytes).await,
            _ => Err(anyhow::anyhow!("Invalid transcription input")),
        };

        match primary_result {
            Ok(mut result) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .remove(&provider_type);
                result.requested_provider = provider_type;
                result.actual_provider = provider_type;
                result.fallback_used = false;
                result.fallback_reason = None;
                if result.model_id.trim().is_empty() {
                    result.model_id = resolved_model.clone();
                }
                Ok(result)
            }
            Err(primary_error) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .insert(provider_type, primary_error.to_string());

                if !fallback_allowed || provider_type == AsrProviderType::Whisper {
                    return Err(anyhow::anyhow!(
                        "{} failed: {}",
                        provider_type.display_name(),
                        primary_error
                    ));
                }

                let fallback_provider = Self::provider_with_model(
                    AsrProviderType::Whisper,
                    Some(self.provider_model_id(AsrProviderType::Whisper).await.as_str()),
                );
                let fallback_result = match (file_path, audio_data) {
                    (Some(path), None) => fallback_provider.transcribe(path).await,
                    (None, Some(bytes)) => fallback_provider.transcribe_bytes(bytes).await,
                    _ => Err(anyhow::anyhow!("Invalid fallback transcription input")),
                };

                let mut result = fallback_result.map_err(|fallback_error| {
                    anyhow::anyhow!(
                        "{} failed: {}; Whisper fallback failed: {}",
                        provider_type.display_name(),
                        primary_error,
                        fallback_error
                    )
                })?;
                result.requested_provider = provider_type;
                result.actual_provider = AsrProviderType::Whisper;
                result.fallback_used = true;
                result.fallback_reason = Some(primary_error.to_string());
                Ok(result)
            }
        }
    }

    /// Transcribe using the default provider
    pub async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(provider_type, Some(audio_path), None, None)
            .await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(provider_type, None, Some(audio_data), None)
            .await
    }

    /// Transcribe bytes with a specific provider.
    pub async fn transcribe_bytes_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(provider_type, None, Some(audio_data), selected_model)
            .await
    }

    /// Transcribe with a specific provider
    #[allow(dead_code)]
    pub async fn transcribe_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_path: &Path,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(provider_type, Some(audio_path), None, None)
            .await
    }

    /// Get info for all providers (Parallelized)
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        let provider_models = self.provider_model_map().await;
        let last_errors = self.last_runtime_errors.read().await.clone();

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
            let selected_model = provider_models
                .get(&provider_type)
                .cloned()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            let last_error = last_errors.get(&provider_type).cloned();

            async move {
                tokio::task::spawn_blocking(move || {
                    let provider =
                        Self::provider_with_model(provider_type, Some(selected_model.as_str()));
                    let is_available = provider.is_available();
                    let diagnostics = runtime_diagnostics_for_provider(
                        provider_type,
                        selected_model.as_str(),
                        is_available,
                        last_error.as_deref(),
                    );
                    ProviderInfo {
                        provider_type,
                        name: provider.name().to_string(),
                        description: provider.description().to_string(),
                        is_available,
                        inference_enabled: Self::is_provider_transcription_enabled(provider_type),
                        model_info: provider.model_info(),
                        selected_model_id: selected_model.clone(),
                        model_options: provider_type.model_options(),
                        download_status: provider.download_status(),
                        runtime_status: diagnostics.runtime_status,
                        runtime_message: diagnostics.runtime_message,
                        runtime_details: diagnostics.runtime_details,
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

        Ok(infos)
    }

    /// Download models for a provider
    pub async fn download_models(
        &self,
        provider_type: AsrProviderType,
        progress_cb: Box<dyn Fn(f32) + Send + Sync>,
    ) -> Result<()> {
        let selected_model = self.provider_model_id(provider_type).await;
        let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
        provider.download_models(progress_cb).await
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
                    results.push(BenchmarkResult {
                        provider_type,
                        provider_name: provider.name().to_string(),
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

/// Benchmark result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub provider_type: AsrProviderType,
    pub provider_name: String,
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
            let model_path = models_root.join("whisper").join(format!(
                "ggml-{}.bin",
                sanitize_whisper_model_id(selected_model_id)
            ));
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
                },
            }
        }
        AsrProviderType::Parakeet => {
            let model_dir = models_root.join("parakeet");
            let has_onnx = PARAKEET_ONNX_NAMES.iter().any(|f| {
                let p = model_dir.join(f);
                p.exists() && p.metadata().map(|m| m.len() > 4096).unwrap_or(false)
            });
            let has_vocab = PARAKEET_VOCAB_NAMES.iter().any(|f| model_dir.join(f).exists());
            let model_ready = has_onnx && has_vocab;
            if !model_ready {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(
                        "Parakeet model not downloaded. Download encoder.onnx + tokens.txt \
                         (from k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en) or provide \
                         your own NeMo ONNX export."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
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
                        .unwrap_or_else(|| "Parakeet ONNX runtime ready.".to_string()),
                ),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: None,
                },
            }
        }
        AsrProviderType::Canary => {
            let model_dir = models_root.join("canary");
            let model_ready = CANARY_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                "Canary model not downloaded. Download Whisper Large V3 Turbo safetensors first.",
                "Canary (Whisper Large V3 Turbo) native Candle inference ready.",
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
                "Distil-Whisper model not downloaded. Download model.safetensors + config first.",
                "Distil-Whisper native Candle inference ready.",
                last_error,
            )
        }
        AsrProviderType::Moonshine => {
            let model_dir = models_root.join("moonshine");
            let model_ready = MOONSHINE_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                "Moonshine ONNX model not downloaded. Download encode.onnx + uncached_decode.onnx first.",
                "Moonshine native ONNX inference ready.",
                last_error,
            )
        }

        AsrProviderType::VibeVoice => RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingRuntime,
            runtime_message: Some(
                "VibeVoice native integration is not yet available. Select a different provider."
                    .to_string(),
            ),
            runtime_details: RuntimeDetails {
                model_path: None,
                python_path: None,
            },
        },
        AsrProviderType::Voxtral => {
            let has_key = has_provider_secret_or_env("mistral", "MISTRAL_API_KEY");
            let model_dir = models_root.join("voxtral");
            let has_local = ["config.json", "tokenizer.json", "model.safetensors"]
                .iter()
                .all(|f| model_dir.join(f).exists());
            RuntimeDiagnosticsInternal {
                runtime_status: if has_local || has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingRuntime
                },
                runtime_message: Some(if has_local && has_key {
                    "Voxtral ready \u2014 local model + cloud API available.".to_string()
                } else if has_local {
                    "Voxtral ready \u2014 local model (Canary encoder). Download Canary model for inference.".to_string()
                } else if has_key {
                    "Voxtral ready \u2014 Mistral cloud API active.".to_string()
                } else {
                    "Voxtral unavailable \u2014 download the model or set MISTRAL_API_KEY.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: if has_local { Some(model_dir.to_string_lossy().to_string()) } else { None },
                    python_path: None,
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
    missing_model_message: &str,
    ready_message: &str,
    last_error: Option<&str>,
) -> RuntimeDiagnosticsInternal {
    if !model_ready {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingModel,
            runtime_message: Some(missing_model_message.to_string()),
            runtime_details: RuntimeDetails {
                model_path: Some(model_dir.to_string_lossy().to_string()),
                python_path: None,
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
        },
    }
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
