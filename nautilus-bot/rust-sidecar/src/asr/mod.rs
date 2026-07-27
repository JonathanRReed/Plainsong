pub mod cohere;
pub mod distil_whisper;
pub mod elevenlabs_scribe;
pub mod groq;
pub mod macos_apple_speech_provider;
pub mod manager;
pub mod mlx_audio;
pub mod moonshine;
pub mod openai_cloud;
pub mod parakeet;
pub mod platform;
pub mod python_runtime;
pub mod voxtral;
pub mod whisper;
pub mod whisper_candle;
pub mod windows_sdk_dictation_provider;

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
    #[serde(default)]
    pub requested_engine: Option<String>,
    #[serde(default)]
    pub actual_engine: Option<String>,
    #[serde(default)]
    pub optimization_applied: bool,
    #[serde(default)]
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
    /// Optionally pre-load the model into cache so the first transcription after
    /// dictation start doesn't pay a cold model load. Best-effort; default no-op.
    async fn prewarm(&self) {}
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
    WhisperCandle,
    DistilWhisper,
    MlxAudio,
    MacosAppleSpeech,
    Moonshine,
    Voxtral,
    WindowsSdkDictation,
    ElevenLabsScribe,
    OpenAiCloud,
    Groq,
    CohereTranscribe,
}

impl AsrProviderType {
    pub fn all() -> Vec<AsrProviderType> {
        vec![
            AsrProviderType::Whisper,
            AsrProviderType::Parakeet,
            AsrProviderType::WhisperCandle,
            AsrProviderType::DistilWhisper,
            AsrProviderType::MlxAudio,
            AsrProviderType::MacosAppleSpeech,
            AsrProviderType::Moonshine,
            AsrProviderType::Voxtral,
            AsrProviderType::WindowsSdkDictation,
            AsrProviderType::ElevenLabsScribe,
            AsrProviderType::OpenAiCloud,
            AsrProviderType::Groq,
            AsrProviderType::CohereTranscribe,
        ]
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "OpenAI Whisper",
            AsrProviderType::Parakeet => "NVIDIA Parakeet",
            AsrProviderType::WhisperCandle => "Whisper Candle",
            AsrProviderType::DistilWhisper => "Distil Whisper",
            AsrProviderType::MlxAudio => "MLX Audio",
            AsrProviderType::MacosAppleSpeech => "Apple Speech (On-Device)",
            AsrProviderType::Moonshine => "UsefulSensors Moonshine",
            AsrProviderType::Voxtral => "Mistral Voxtral Mini",
            AsrProviderType::WindowsSdkDictation => "Windows Native Speech",
            AsrProviderType::ElevenLabsScribe => "ElevenLabs Scribe",
            AsrProviderType::OpenAiCloud => "OpenAI Whisper (Cloud)",
            AsrProviderType::Groq => "Groq Whisper (Cloud)",
            AsrProviderType::CohereTranscribe => "Cohere Transcribe",
        }
    }

    pub fn default_model_id(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "base.en",
            AsrProviderType::Parakeet => "parakeet-tdt-0.6b-v3",
            AsrProviderType::WhisperCandle => "whisper-large-v3-turbo",
            AsrProviderType::DistilWhisper => "distil-large-v3.5",
            AsrProviderType::MlxAudio => mlx_audio::default_model_id(),
            AsrProviderType::MacosAppleSpeech => "macos_apple_speech",
            AsrProviderType::Moonshine => "moonshine-base",
            AsrProviderType::Voxtral => "voxtral-local",
            AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation",
            AsrProviderType::ElevenLabsScribe => "scribe_v2_realtime",
            AsrProviderType::OpenAiCloud => "whisper-1",
            AsrProviderType::Groq => "whisper-large-v3-turbo",
            AsrProviderType::CohereTranscribe => "cohere-transcribe-03-2026",
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
            AsrProviderType::Parakeet => vec![
                ModelOption {
                    id: "parakeet-tdt-0.6b-v3".to_string(),
                    label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)".to_string(),
                },
                ModelOption {
                    id: "parakeet-ctc-0.6b".to_string(),
                    label: "Parakeet CTC 0.6B (English-only)".to_string(),
                },
                ModelOption {
                    id: "parakeet-ctc-1.1b".to_string(),
                    label: "Parakeet CTC 1.1B (experimental)".to_string(),
                },
                ModelOption {
                    id: "parakeet-tdt-ctc-110m".to_string(),
                    label: "Parakeet TDT CTC 110M legacy (experimental)".to_string(),
                },
            ],
            AsrProviderType::WhisperCandle => vec![ModelOption {
                id: "whisper-large-v3-turbo".to_string(),
                label: "Whisper Large V3 Turbo via Candle (experimental)".to_string(),
            }],
            AsrProviderType::DistilWhisper => vec![ModelOption {
                id: "distil-large-v3.5".to_string(),
                label: "Distil Whisper Large v3.5".to_string(),
            }],
            AsrProviderType::MlxAudio => mlx_audio::model_options(),
            AsrProviderType::MacosAppleSpeech => vec![ModelOption {
                id: "macos_apple_speech".to_string(),
                label: "Apple Speech · on-device dictation".to_string(),
            }],
            AsrProviderType::Moonshine => vec![
                ModelOption {
                    id: "moonshine-tiny".to_string(),
                    label: "Moonshine Tiny (stable, edge)".to_string(),
                },
                ModelOption {
                    id: "moonshine-base".to_string(),
                    label: "Moonshine Base (stable)".to_string(),
                },
            ],
            AsrProviderType::Voxtral => vec![
                ModelOption {
                    id: "voxtral-local".to_string(),
                    label: "Voxtral Mini 4B (local, managed Python runtime)".to_string(),
                },
                ModelOption {
                    id: "voxtral-cloud".to_string(),
                    label: "Voxtral Mini 4B (Mistral Cloud)".to_string(),
                },
                ModelOption {
                    id: "voxtral-small".to_string(),
                    label: "Voxtral Small 24B (premium accuracy, Mistral Cloud)".to_string(),
                },
            ],
            AsrProviderType::WindowsSdkDictation => vec![ModelOption {
                id: "windows_sdk_dictation".to_string(),
                label: "Managed by Windows".to_string(),
            }],
            AsrProviderType::ElevenLabsScribe => vec![
                ModelOption {
                    id: "scribe_v2_realtime".to_string(),
                    label: "Scribe v2 Realtime (150ms, 90+ languages, recommended)".to_string(),
                },
                ModelOption {
                    id: "scribe_v2".to_string(),
                    label: "Scribe v2".to_string(),
                },
                ModelOption {
                    id: "scribe_v2_experimental".to_string(),
                    label: "Scribe v2 Experimental".to_string(),
                },
            ],
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
            AsrProviderType::Groq => vec![
                ModelOption {
                    id: "whisper-large-v3-turbo".to_string(),
                    label: "whisper-large-v3-turbo (fast, recommended)".to_string(),
                },
                ModelOption {
                    id: "whisper-large-v3".to_string(),
                    label: "whisper-large-v3 (best accuracy)".to_string(),
                },
            ],
            AsrProviderType::CohereTranscribe => vec![ModelOption {
                id: "cohere-transcribe-03-2026".to_string(),
                label: "Cohere Transcribe (03-2026)".to_string(),
            }],
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
            AsrProviderType::Parakeet => {
                Box::new(parakeet::ParakeetProvider::new(selected_model_id))
            }
            AsrProviderType::WhisperCandle => Box::new(whisper_candle::WhisperCandleProvider::new(
                selected_model_id,
            )),
            AsrProviderType::DistilWhisper => Box::new(distil_whisper::DistilWhisperProvider::new(
                selected_model_id,
            )),
            AsrProviderType::MlxAudio => {
                Box::new(mlx_audio::MlxAudioProvider::new(selected_model_id))
            }
            AsrProviderType::MacosAppleSpeech => {
                Box::new(macos_apple_speech_provider::MacosAppleSpeechProvider::new())
            }
            AsrProviderType::Moonshine => {
                Box::new(moonshine::MoonshineProvider::new(selected_model_id))
            }
            AsrProviderType::Voxtral => Box::new(voxtral::VoxtralProvider::new(selected_model_id)),
            AsrProviderType::WindowsSdkDictation => {
                Box::new(windows_sdk_dictation_provider::WindowsSdkDictationProvider::new())
            }
            AsrProviderType::ElevenLabsScribe => Box::new(
                elevenlabs_scribe::ElevenLabsScribeProvider::new(selected_model_id),
            ),
            AsrProviderType::OpenAiCloud => Box::new(
                openai_cloud::OpenAiCloudWhisperProvider::new(selected_model_id),
            ),
            AsrProviderType::Groq => Box::new(groq::GroqProvider::new(selected_model_id)),
            AsrProviderType::CohereTranscribe => {
                Box::new(cohere::CohereTranscribeProvider::new(selected_model_id))
            }
        }
    }
}

// Re-export manager types
pub use manager::{
    AsrManager, BenchmarkResult, ProviderInfo, ProviderInventory, RuntimeDiagnostics,
};
