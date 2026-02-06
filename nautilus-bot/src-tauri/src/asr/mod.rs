pub mod canary;
pub mod manager;
pub mod parakeet;
pub mod whisper;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// ASR Provider trait for modular transcription support
#[async_trait::async_trait]
pub trait AsrProvider: Send + Sync {
    /// Provider name
    fn name(&self) -> &str;

    /// Provider description
    fn description(&self) -> &str;

    /// Check if the provider is available (models downloaded, etc.)
    fn is_available(&self) -> bool;

    /// Get model information
    fn model_info(&self) -> ModelInfo;

    /// Transcribe audio file
    async fn transcribe(&self, audio_path: &PathBuf) -> anyhow::Result<TranscriptionResult>;

    /// Transcribe audio bytes
    async fn transcribe_bytes(&self, audio_data: &[u8]) -> anyhow::Result<TranscriptionResult>;

    /// Get download status/progress
    fn download_status(&self) -> DownloadStatus;

    /// Download required models
    async fn download_models(&self) -> anyhow::Result<()>;
}

/// Model information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub version: String,
    pub size_mb: f64,
    pub parameters: String,
    pub languages: Vec<String>,
    pub word_error_rate: Option<f64>,
    pub real_time_factor: Option<f64>,
    pub license: String,
    pub source_url: String,
}

/// Transcription result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub language: String,
    pub confidence: f64,
    pub processing_time_ms: u64,
    pub model_name: String,
}

/// Transcript segment with timing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub confidence: f64,
}

/// Download status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DownloadStatus {
    NotDownloaded,
    Downloading { progress: f64 },
    Downloaded,
    Error(String),
}

/// ASR Provider type
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderType {
    Whisper,
    Parakeet,
    Canary,
}

impl AsrProviderType {
    pub fn all() -> Vec<AsrProviderType> {
        vec![AsrProviderType::Whisper]
    }

    #[allow(dead_code)]
    pub fn display_name(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "OpenAI Whisper",
            AsrProviderType::Parakeet => "NVIDIA Parakeet TDT",
            AsrProviderType::Canary => "NVIDIA Canary Qwen",
        }
    }
}

/// Factory for creating ASR providers
pub struct AsrProviderFactory;

impl AsrProviderFactory {
    pub fn create(provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::Whisper => Box::new(whisper::WhisperProvider::new()),
            AsrProviderType::Parakeet => Box::new(parakeet::ParakeetProvider::new()),
            AsrProviderType::Canary => Box::new(canary::CanaryProvider::new()),
        }
    }
}

// Re-export manager types
pub use manager::{AsrManager, BenchmarkResult, ProviderInfo};
