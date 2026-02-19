pub mod canary;
pub mod distil_whisper;
pub mod manager;
pub mod moonshine;
pub mod parakeet;
pub mod python_runtime;
pub mod vibevoice;
pub mod voxtral;
pub mod whisper;

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub language: String,
    pub confidence: f64,
    pub processing_time_ms: u64,
    pub model_name: String,
    pub model_id: String,
    pub requested_provider: AsrProviderType,
    pub actual_provider: AsrProviderType,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    NotDownloaded,
    Downloading(f32),
    Downloaded,
    Error,
}

#[async_trait]
pub trait AsrProvider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn is_available(&self) -> bool;
    fn model_info(&self) -> ModelInfo;
    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult>;
    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult>;
    fn download_status(&self) -> DownloadStatus;
    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()>;
}

pub struct AsrProviderFactory;

/// ASR Provider type
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderType {
    Whisper,
    Parakeet,
    Canary,
    DistilWhisper,
    Moonshine,
    VibeVoice,
    Voxtral,
}

impl AsrProviderType {
    pub fn all() -> Vec<AsrProviderType> {
        vec![
            AsrProviderType::Whisper,
            AsrProviderType::Parakeet,
            AsrProviderType::Canary,
            AsrProviderType::DistilWhisper,
            AsrProviderType::Moonshine,
            AsrProviderType::VibeVoice,
            AsrProviderType::Voxtral,
        ]
    }

    #[allow(dead_code)]
    pub fn display_name(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "OpenAI Whisper",
            AsrProviderType::Parakeet => "NVIDIA Parakeet TDT",
            AsrProviderType::Canary => "NVIDIA Canary Qwen",
            AsrProviderType::DistilWhisper => "Distil Whisper",
            AsrProviderType::Moonshine => "UsefulSensors Moonshine",
            AsrProviderType::VibeVoice => "Microsoft VibeVoice",
            AsrProviderType::Voxtral => "Mistral Voxtral Mini",
        }
    }
}

impl AsrProviderFactory {
    pub fn create(provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        Self::create_with_model(provider_type, None)
    }

    pub fn create_with_model(
        provider_type: AsrProviderType,
        selected_model_id: Option<&str>,
    ) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::Whisper => Box::new(whisper::WhisperProvider::new(selected_model_id)),
            AsrProviderType::Parakeet => Box::new(parakeet::ParakeetProvider::new()),
            AsrProviderType::Canary => Box::new(canary::CanaryProvider::new()),
            AsrProviderType::DistilWhisper => Box::new(distil_whisper::DistilWhisperProvider::new(
                selected_model_id,
            )),
            AsrProviderType::Moonshine => Box::new(moonshine::MoonshineProvider::new()),
            AsrProviderType::VibeVoice => Box::new(vibevoice::VibeVoiceProvider::new()),
            AsrProviderType::Voxtral => Box::new(voxtral::VoxtralProvider::new()),
        }
    }
}

// Re-export manager types
pub use manager::{AsrManager, BenchmarkResult, ProviderInfo, RuntimeDiagnostics};
