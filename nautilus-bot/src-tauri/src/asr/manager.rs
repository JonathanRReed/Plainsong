use super::{
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

const PARAKEET_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3.nemo";
const CANARY_REQUIRED_FILES: [&str; 3] = ["config.json", "model.safetensors", "LICENSES"];
const DISTIL_REQUIRED_FILES: [&str; 8] = [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "merges.txt",
    "vocab.json",
];

/// Manages multiple ASR providers
#[allow(dead_code)]
pub struct AsrManager {
    providers: RwLock<HashMap<AsrProviderType, Box<dyn AsrProvider>>>,
    default_provider: RwLock<AsrProviderType>,
    selected_model_id: RwLock<String>,
    allow_whisper_fallback: RwLock<bool>,
    last_runtime_errors: RwLock<HashMap<AsrProviderType, String>>,
    models_dir: PathBuf,
}

impl AsrManager {
    pub fn new() -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models");

        std::fs::create_dir_all(&models_dir).ok();

        let mut providers: HashMap<AsrProviderType, Box<dyn AsrProvider>> = HashMap::new();
        for provider_type in AsrProviderType::all() {
            let provider = AsrProviderFactory::create(provider_type);
            providers.insert(provider_type, provider);
        }

        Self {
            providers: RwLock::new(providers),
            default_provider: RwLock::new(AsrProviderType::Whisper),
            selected_model_id: RwLock::new("base.en".to_string()),
            allow_whisper_fallback: RwLock::new(false),
            last_runtime_errors: RwLock::new(HashMap::new()),
            models_dir,
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
        *self.selected_model_id.write().await = model_id;
    }

    pub async fn selected_model_id(&self) -> String {
        self.selected_model_id.read().await.clone()
    }

    pub async fn set_allow_whisper_fallback(&self, allow: bool) {
        *self.allow_whisper_fallback.write().await = allow;
    }

    pub async fn allow_whisper_fallback(&self) -> bool {
        *self.allow_whisper_fallback.read().await
    }

    /// Get a provider by type - creates fresh instance each time
    #[allow(dead_code)]
    pub async fn get_provider(&self, provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        let selected_model = self.selected_model_id().await;
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
    }

    pub async fn get_runtime_diagnostics(
        &self,
        provider_type: AsrProviderType,
    ) -> RuntimeDiagnostics {
        let selected_model = self.selected_model_id().await;
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
    ) -> Result<TranscriptionResult> {
        let selected_model = self.selected_model_id().await;
        let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
        let fallback_allowed = self.allow_whisper_fallback().await;

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
                    .remove(&provider_type);
                result.requested_provider = provider_type;
                result.actual_provider = provider_type;
                result.fallback_used = false;
                result.fallback_reason = None;
                if result.model_id.trim().is_empty() {
                    result.model_id = selected_model;
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
                    Some(self.selected_model_id().await.as_str()),
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
        self.transcribe_inner(provider_type, Some(audio_path), None)
            .await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(provider_type, None, Some(audio_data))
            .await
    }

    /// Transcribe with a specific provider
    #[allow(dead_code)]
    pub async fn transcribe_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_path: &Path,
    ) -> Result<TranscriptionResult> {
        self.transcribe_inner(provider_type, Some(audio_path), None)
            .await
    }

    /// Get info for all providers
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        let mut infos = Vec::new();
        let selected_model = self.selected_model_id().await;

        for provider_type in AsrProviderType::all() {
            let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
            let diagnostics = self.get_runtime_diagnostics(provider_type).await;
            infos.push(ProviderInfo {
                provider_type,
                name: provider.name().to_string(),
                description: provider.description().to_string(),
                is_available: provider.is_available(),
                inference_enabled: Self::is_provider_transcription_enabled(provider_type),
                model_info: provider.model_info(),
                download_status: provider.download_status(),
                runtime_status: diagnostics.runtime_status,
                runtime_message: diagnostics.runtime_message,
                runtime_details: diagnostics.runtime_details,
            });
        }

        Ok(infos)
    }

    /// Download models for a provider
    pub async fn download_models(&self, provider_type: AsrProviderType) -> Result<()> {
        let selected_model = self.selected_model_id().await;
        let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
        provider.download_models().await
    }

    /// Get models directory
    #[allow(dead_code)]
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Compare providers with benchmark
    pub async fn benchmark_providers(&self, test_audio: &Path) -> Vec<BenchmarkResult> {
        let mut results = Vec::new();
        let selected_model = self.selected_model_id().await;

        for provider_type in AsrProviderType::all() {
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
            let model_path = models_root.join("parakeet").join(PARAKEET_MODEL_FILE);
            let python =
                super::python_runtime::find_python_with_imports("import nemo.collections.asr");
            runtime_from_model_and_python(
                provider_available,
                model_path,
                python,
                "Parakeet model not downloaded. Download the provider model first.",
                "Parakeet runtime missing. Install NeMo ASR and set NAUTILUS_PYTHON to the same interpreter.",
                "Parakeet runtime detected but failed health check.",
                "Parakeet runtime ready.",
                last_error,
            )
        }
        AsrProviderType::Canary => {
            let model_dir = models_root.join("canary");
            let model_ready = CANARY_REQUIRED_FILES
                .iter()
                .all(|file_name| model_dir.join(file_name).exists());
            let python = super::python_runtime::find_python_with_imports(
                "import torch; import transformers",
            );
            runtime_from_model_dir_and_python(
                provider_available,
                model_dir,
                model_ready,
                python,
                "Canary model files are incomplete. Download required model artifacts first.",
                "Canary runtime missing. Install torch + transformers and set NAUTILUS_PYTHON.",
                "Canary runtime detected but provider health check failed.",
                "Canary runtime ready.",
                last_error,
            )
        }
        AsrProviderType::DistilWhisper => {
            let model_dir = models_root.join("distil_whisper");
            let model_ready = DISTIL_REQUIRED_FILES
                .iter()
                .all(|file_name| model_dir.join(file_name).exists());
            let python = super::python_runtime::find_python_with_imports(
                "import torch; import transformers",
            );
            runtime_from_model_dir_and_python(
                provider_available,
                model_dir,
                model_ready,
                python,
                "Distil model files are incomplete. Download required model artifacts first.",
                "Distil runtime missing. Install torch + transformers and set NAUTILUS_PYTHON.",
                "Distil runtime detected but provider health check failed.",
                "Distil runtime ready.",
                last_error,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn runtime_from_model_and_python(
    provider_available: bool,
    model_path: PathBuf,
    python_path: Option<String>,
    missing_model_message: &str,
    missing_runtime_message: &str,
    health_error_message: &str,
    ready_message: &str,
    last_error: Option<&str>,
) -> RuntimeDiagnosticsInternal {
    if !model_path.exists() {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingModel,
            runtime_message: Some(missing_model_message.to_string()),
            runtime_details: RuntimeDetails {
                python_path,
                model_path: Some(model_path.to_string_lossy().to_string()),
            },
        };
    }

    if python_path.is_none() {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingRuntime,
            runtime_message: Some(missing_runtime_message.to_string()),
            runtime_details: RuntimeDetails {
                python_path: None,
                model_path: Some(model_path.to_string_lossy().to_string()),
            },
        };
    }

    if !provider_available {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::Error,
            runtime_message: Some(
                last_error
                    .map(ToString::to_string)
                    .unwrap_or_else(|| health_error_message.to_string()),
            ),
            runtime_details: RuntimeDetails {
                python_path,
                model_path: Some(model_path.to_string_lossy().to_string()),
            },
        };
    }

    RuntimeDiagnosticsInternal {
        runtime_status: RuntimeStatus::Ready,
        runtime_message: Some(ready_message.to_string()),
        runtime_details: RuntimeDetails {
            python_path,
            model_path: Some(model_path.to_string_lossy().to_string()),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn runtime_from_model_dir_and_python(
    provider_available: bool,
    model_dir: PathBuf,
    model_ready: bool,
    python_path: Option<String>,
    missing_model_message: &str,
    missing_runtime_message: &str,
    health_error_message: &str,
    ready_message: &str,
    last_error: Option<&str>,
) -> RuntimeDiagnosticsInternal {
    if !model_ready {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingModel,
            runtime_message: Some(missing_model_message.to_string()),
            runtime_details: RuntimeDetails {
                python_path,
                model_path: Some(model_dir.to_string_lossy().to_string()),
            },
        };
    }

    if python_path.is_none() {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingRuntime,
            runtime_message: Some(missing_runtime_message.to_string()),
            runtime_details: RuntimeDetails {
                python_path: None,
                model_path: Some(model_dir.to_string_lossy().to_string()),
            },
        };
    }

    if !provider_available {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::Error,
            runtime_message: Some(
                last_error
                    .map(ToString::to_string)
                    .unwrap_or_else(|| health_error_message.to_string()),
            ),
            runtime_details: RuntimeDetails {
                python_path,
                model_path: Some(model_dir.to_string_lossy().to_string()),
            },
        };
    }

    RuntimeDiagnosticsInternal {
        runtime_status: RuntimeStatus::Ready,
        runtime_message: Some(ready_message.to_string()),
        runtime_details: RuntimeDetails {
            python_path,
            model_path: Some(model_dir.to_string_lossy().to_string()),
        },
    }
}

fn sanitize_whisper_model_id(model_id: &str) -> &'static str {
    match model_id {
        "large-v3-turbo" => "large-v3-turbo",
        "large-v3" => "large-v3",
        "medium" => "medium",
        "medium.en" => "medium.en",
        "small" => "small",
        "small.en" => "small.en",
        "base" => "base",
        _ => "base.en",
    }
}
