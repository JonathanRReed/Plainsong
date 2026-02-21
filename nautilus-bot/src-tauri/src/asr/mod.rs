pub mod canary;
pub mod distil_whisper;
pub mod elevenlabs_scribe;
pub mod manager;
pub mod moonshine;
pub mod openai_cloud;
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
pub struct ModelOption {
    pub id: String,
    pub label: String,
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
    ElevenLabsScribe,
    OpenAiCloud,
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
            AsrProviderType::ElevenLabsScribe,
            AsrProviderType::OpenAiCloud,
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
            AsrProviderType::ElevenLabsScribe => "ElevenLabs Scribe",
            AsrProviderType::OpenAiCloud => "OpenAI Whisper (Cloud)",
        }
    }

    pub fn default_model_id(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "base.en",
            AsrProviderType::Parakeet => "parakeet-tdt-0.6b-v3",
            AsrProviderType::Canary => "canary-qwen-2.5b",
            AsrProviderType::DistilWhisper => "distil-large-v3.5",
            AsrProviderType::Moonshine => "moonshine",
            AsrProviderType::VibeVoice => "vibevoice-asr",
            AsrProviderType::Voxtral => "voxtral-local",
            AsrProviderType::ElevenLabsScribe => "scribe_v1",
            AsrProviderType::OpenAiCloud => "whisper-1",
        }
    }

    pub fn model_options(&self) -> Vec<ModelOption> {
        match self {
            AsrProviderType::Whisper => vec![
                ModelOption {
                    id: "tiny".to_string(),
                    label: "tiny (fastest)".to_string(),
                },
                ModelOption {
                    id: "tiny.en".to_string(),
                    label: "tiny.en (fastest, English)".to_string(),
                },
                ModelOption {
                    id: "base".to_string(),
                    label: "base (balanced)".to_string(),
                },
                ModelOption {
                    id: "base.en".to_string(),
                    label: "base.en (balanced, English)".to_string(),
                },
                ModelOption {
                    id: "small".to_string(),
                    label: "small (better accuracy)".to_string(),
                },
                ModelOption {
                    id: "small.en".to_string(),
                    label: "small.en (better accuracy, English)".to_string(),
                },
                ModelOption {
                    id: "medium".to_string(),
                    label: "medium (high accuracy)".to_string(),
                },
                ModelOption {
                    id: "medium.en".to_string(),
                    label: "medium.en (high accuracy, English)".to_string(),
                },
                ModelOption {
                    id: "large-v3-turbo".to_string(),
                    label: "large-v3-turbo (fast + accurate)".to_string(),
                },
                ModelOption {
                    id: "large-v3".to_string(),
                    label: "large-v3 (best accuracy)".to_string(),
                },
            ],
            AsrProviderType::Parakeet => vec![ModelOption {
                id: "parakeet-tdt-0.6b-v3".to_string(),
                label: "Parakeet TDT 0.6B v3".to_string(),
            }],
            AsrProviderType::Canary => vec![ModelOption {
                id: "canary-qwen-2.5b".to_string(),
                label: "Canary Qwen 2.5B".to_string(),
            }],
            AsrProviderType::DistilWhisper => vec![ModelOption {
                id: "distil-large-v3.5".to_string(),
                label: "Distil Whisper Large v3.5".to_string(),
            }],
            AsrProviderType::Moonshine => vec![ModelOption {
                id: "moonshine".to_string(),
                label: "Moonshine".to_string(),
            }],
            AsrProviderType::VibeVoice => vec![ModelOption {
                id: "vibevoice-asr".to_string(),
                label: "VibeVoice ASR".to_string(),
            }],
            AsrProviderType::Voxtral => vec![
                ModelOption {
                    id: "voxtral-local".to_string(),
                    label: "Voxtral Mini 4B (Local)".to_string(),
                },
                ModelOption {
                    id: "voxtral-cloud".to_string(),
                    label: "Voxtral Mini 4B (Mistral Cloud)".to_string(),
                },
            ],
            AsrProviderType::ElevenLabsScribe => vec![ModelOption {
                id: "scribe_v1".to_string(),
                label: "Scribe v1".to_string(),
            }],
            AsrProviderType::OpenAiCloud => vec![
                ModelOption {
                    id: "whisper-1".to_string(),
                    label: "whisper-1".to_string(),
                },
                ModelOption {
                    id: "gpt-4o-mini-transcribe".to_string(),
                    label: "gpt-4o-mini-transcribe".to_string(),
                },
                ModelOption {
                    id: "gpt-4o-transcribe".to_string(),
                    label: "gpt-4o-transcribe".to_string(),
                },
            ],
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
            AsrProviderType::VibeVoice => {
                Box::new(vibevoice::VibeVoiceProvider::new(selected_model_id))
            }
            AsrProviderType::Voxtral => Box::new(voxtral::VoxtralProvider::new(selected_model_id)),
            AsrProviderType::ElevenLabsScribe => Box::new(
                elevenlabs_scribe::ElevenLabsScribeProvider::new(selected_model_id),
            ),
            AsrProviderType::OpenAiCloud => Box::new(
                openai_cloud::OpenAiCloudWhisperProvider::new(selected_model_id),
            ),
        }
    }
}

// Re-export manager types
pub use manager::{AsrManager, BenchmarkResult, ProviderInfo, RuntimeDiagnostics};
