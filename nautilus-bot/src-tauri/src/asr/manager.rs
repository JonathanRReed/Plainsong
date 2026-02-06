use super::{
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::RwLock;

/// Manages multiple ASR providers
#[allow(dead_code)]
pub struct AsrManager {
    providers: RwLock<HashMap<AsrProviderType, Box<dyn AsrProvider>>>,
    default_provider: RwLock<AsrProviderType>,
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

        // Initialize all providers
        for provider_type in AsrProviderType::all() {
            let provider = AsrProviderFactory::create(provider_type);
            providers.insert(provider_type, provider);
        }

        Self {
            providers: RwLock::new(providers),
            default_provider: RwLock::new(AsrProviderType::Whisper),
            models_dir,
        }
    }

    /// Get a provider by type - creates fresh instance each time
    #[allow(dead_code)]
    pub fn get_provider(&self, provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        AsrProviderFactory::create(provider_type)
    }

    /// Get the default provider
    pub async fn get_default_provider(&self) -> AsrProviderType {
        *self.default_provider.read().await
    }

    /// Set the default provider
    pub async fn set_default_provider(&self, provider_type: AsrProviderType) {
        *self.default_provider.write().await = provider_type;
    }

    /// Transcribe using the default provider
    pub async fn transcribe(&self, audio_path: &PathBuf) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        let provider = AsrProviderFactory::create(provider_type);
        provider.transcribe(audio_path).await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        let provider = AsrProviderFactory::create(provider_type);
        provider.transcribe_bytes(audio_data).await
    }

    /// Transcribe with a specific provider
    #[allow(dead_code)]
    pub async fn transcribe_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_path: &PathBuf,
    ) -> Result<TranscriptionResult> {
        let provider = AsrProviderFactory::create(provider_type);
        provider.transcribe(audio_path).await
    }

    /// Get info for all providers
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        let mut infos = Vec::new();

        for provider_type in AsrProviderType::all() {
            let provider = AsrProviderFactory::create(provider_type);
            infos.push(ProviderInfo {
                provider_type,
                name: provider.name().to_string(),
                description: provider.description().to_string(),
                is_available: provider.is_available(),
                model_info: provider.model_info(),
                download_status: provider.download_status(),
            });
        }

        Ok(infos)
    }

    /// Download models for a provider
    pub async fn download_models(&self, provider_type: AsrProviderType) -> Result<()> {
        let provider = AsrProviderFactory::create(provider_type);
        provider.download_models().await
    }

    /// Get models directory
    #[allow(dead_code)]
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Compare providers with benchmark
    pub async fn benchmark_providers(&self, test_audio: &PathBuf) -> Vec<BenchmarkResult> {
        let mut results = Vec::new();

        for provider_type in AsrProviderType::all() {
            let provider = AsrProviderFactory::create(provider_type);

            if !provider.is_available() {
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
    pub model_info: ModelInfo,
    pub download_status: DownloadStatus,
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
