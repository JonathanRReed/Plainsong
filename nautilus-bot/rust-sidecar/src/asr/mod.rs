pub mod cohere;
pub mod distil_whisper;
pub mod elevenlabs_scribe;
pub mod groq;
pub mod macos_apple_speech_provider;
pub mod manager;
pub mod moonshine;
pub mod openai_cloud;
pub mod parakeet;
#[cfg(feature = "asr-parakeet")]
pub mod parakeet_tdt;
pub mod platform;
pub mod qwen3_asr;
#[cfg(feature = "asr-whisper")]
pub mod whisper;
#[cfg(not(feature = "asr-whisper"))]
pub mod whisper_stub;
#[cfg(not(feature = "asr-whisper"))]
pub use whisper_stub as whisper;
pub mod whisper_candle;
pub mod windows_sdk_dictation_provider;

use anyhow::Result;
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const CLOUD_ASR_RESPONSE_BODY_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) async fn read_cloud_asr_json<T: DeserializeOwned>(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<T> {
    crate::llm::transport::read_json_body(response, CLOUD_ASR_RESPONSE_BODY_LIMIT)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "{} response was invalid or exceeded the {} MiB limit: {}",
                provider_label,
                CLOUD_ASR_RESPONSE_BODY_LIMIT / (1024 * 1024),
                error
            )
        })
}

pub(crate) fn cloud_asr_status_error(
    provider_label: &str,
    status: reqwest::StatusCode,
) -> anyhow::Error {
    anyhow::anyhow!("{} API returned HTTP {}", provider_label, status.as_u16())
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let mut artifacts = Vec::new();
    artifacts.extend(distil_whisper::model_integrity_artifacts(models_root));
    artifacts.extend(moonshine::model_integrity_artifacts(models_root));
    artifacts.extend(parakeet::model_integrity_artifacts(models_root));
    artifacts.extend(whisper_candle::model_integrity_artifacts(models_root));
    artifacts.extend(qwen3_asr::model_integrity_artifacts(models_root));
    artifacts
}

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
    /// How many vocabulary-hint terms the provider actually attached to the
    /// request (whisper's initial prompt, a cloud `prompt`/`keyterms`
    /// field). Zero for providers that ignore the hint and for a whisper
    /// decode that withheld the prompt on near-silent audio. Compared with
    /// the number of terms *built* in the audit log, so "the dictionary
    /// reached the recognizer" is never claimed for a route it did not.
    #[serde(default)]
    pub vocabulary_hint_terms_applied: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    NotDownloaded,
    Downloading(f32),
    Downloaded,
    Error,
}

/// Recognizer-side vocabulary bias: the spellings the recognizer should
/// prefer for this request. Built at dictation time from the user's personal
/// dictionary (the *replacement* spellings, never the misheard forms) and
/// plain-word snippet triggers (never their expansions), scoped and capped by
/// `dictation_parity::build_vocabulary_hint`. Providers that accept a prompt
/// or keyterm list attach it; every other provider ignores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabularyHint {
    terms: Vec<String>,
}

impl VocabularyHint {
    /// `None` for an empty list, so a hint is only ever attached when there
    /// is something in it — an empty whisper prompt is worse than none.
    pub fn new(terms: Vec<String>) -> Option<Self> {
        if terms.is_empty() {
            None
        } else {
            Some(Self { terms })
        }
    }

    pub fn terms(&self) -> &[String] {
        &self.terms
    }

    /// Conservative token estimate for a prompt string, for budgeting against
    /// whisper's prompt window (half of its 448-token text context, so 224).
    /// Heuristic, stated plainly: one token per three characters — proper
    /// nouns and unfamiliar spellings tokenize into short pieces, so the
    /// usual "four characters per token" for prose is too generous here —
    /// plus one token per comma or period. Over-estimating only trims a few
    /// of the oldest terms; under-estimating would let whisper silently drop
    /// the newest.
    pub fn estimate_prompt_tokens(prompt: &str) -> usize {
        let chars = prompt.chars().count();
        let separators = prompt.chars().filter(|ch| matches!(ch, ',' | '.')).count();
        chars.div_ceil(3) + separators
    }

    /// `estimate_prompt_tokens` of this hint's own `as_prompt()`.
    pub fn estimated_prompt_tokens(&self) -> usize {
        Self::estimate_prompt_tokens(&self.as_prompt())
    }

    /// Characters `as_prompt` adds around the joined terms. Callers that
    /// budget the prompt (`dictation_parity::build_vocabulary_hint`) count
    /// this so the whole prompt, not only the terms, stays under the cap.
    pub const PROMPT_FRAME_CHARS: usize = "Vocabulary: .".len();

    /// The prompt form for whisper-style `initial_prompt` / `prompt` fields:
    /// one framed sentence, `Vocabulary: term, term, term.`
    ///
    /// The shape matters more than it looks. whisper treats the prompt as
    /// *prior transcript*, so a bare comma list (`Plainsong, hotkey, Slack,
    /// Nautilus`) taught `base.en` the wrong things on the repo fixtures:
    /// it dropped a sentence boundary on the 44 s fixture and turned a
    /// correctly-heard "Nautilus" into "not-a-list" on the 5 s one. Ending
    /// with a period fixed the words but leaked comma-only punctuation into
    /// the output. The framed sentence kept every word fix and left the
    /// punctuation identical to the un-hinted decode. See
    /// docs/evals/dictation-dictionary-fixture-report.md.
    pub fn as_prompt(&self) -> String {
        format!("Vocabulary: {}.", self.terms.join(", "))
    }
}

/// Per-request options for `AsrProvider::transcribe_bytes_with_options`.
/// `Default` is "no options", which is what every path other than dictation
/// passes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptionOptions {
    pub vocabulary_hint: Option<VocabularyHint>,
}

#[async_trait]
pub trait AsrProvider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn is_available(&self) -> bool;
    fn model_info(&self) -> ModelInfo;
    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult>;
    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult>;
    /// `transcribe_bytes` with per-request options. The default drops the
    /// options on the floor, so a provider that has no use for them (no
    /// prompt or vocabulary field in its API) needs no change; providers that
    /// can bias recognition override this.
    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let _ = options;
        self.transcribe_bytes(audio_data).await
    }
    /// Optionally pre-load the model into the same process cache used by
    /// transcription. Unlike the old best-effort hook, this acknowledgement is
    /// allowed to fail so callers cannot publish a false "model ready" state.
    async fn prewarm(&self) -> Result<()> {
        Ok(())
    }
    fn download_status(&self) -> DownloadStatus;
    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()>;
}

pub struct AsrProviderFactory;

#[cfg(test)]
mod cloud_response_security_tests {
    use super::cloud_asr_status_error;

    #[test]
    fn provider_status_errors_never_include_response_body_content() {
        let marker = "secret-transcript-marker";
        let error = cloud_asr_status_error("Test ASR", reqwest::StatusCode::BAD_REQUEST);
        let rendered = error.to_string();

        assert!(rendered.contains("Test ASR"));
        assert!(rendered.contains("400"));
        assert!(!rendered.contains(marker));
    }
}

/// ASR Provider type
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderType {
    Whisper,
    Parakeet,
    WhisperCandle,
    DistilWhisper,
    MacosAppleSpeech,
    Moonshine,
    WindowsSdkDictation,
    ElevenLabsScribe,
    OpenAiCloud,
    Groq,
    CohereTranscribe,
    Qwen3Asr,
}

impl AsrProviderType {
    pub fn all() -> Vec<AsrProviderType> {
        vec![
            AsrProviderType::Whisper,
            AsrProviderType::Parakeet,
            AsrProviderType::WhisperCandle,
            AsrProviderType::DistilWhisper,
            AsrProviderType::MacosAppleSpeech,
            AsrProviderType::Moonshine,
            AsrProviderType::WindowsSdkDictation,
            AsrProviderType::ElevenLabsScribe,
            AsrProviderType::OpenAiCloud,
            AsrProviderType::Groq,
            AsrProviderType::CohereTranscribe,
            AsrProviderType::Qwen3Asr,
        ]
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "OpenAI Whisper",
            AsrProviderType::Parakeet => "NVIDIA Parakeet",
            AsrProviderType::WhisperCandle => "Whisper Candle",
            AsrProviderType::DistilWhisper => "Distil Whisper",
            AsrProviderType::MacosAppleSpeech => "Apple Speech (On-Device)",
            AsrProviderType::Moonshine => "UsefulSensors Moonshine",
            AsrProviderType::WindowsSdkDictation => "Windows Native Speech",
            AsrProviderType::ElevenLabsScribe => "ElevenLabs Scribe",
            AsrProviderType::OpenAiCloud => "OpenAI Whisper (Cloud)",
            AsrProviderType::Groq => "Groq Whisper (Cloud)",
            AsrProviderType::CohereTranscribe => "Cohere Transcribe",
            AsrProviderType::Qwen3Asr => "Qwen3-ASR (Local)",
        }
    }

    pub fn default_model_id(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "base.en",
            AsrProviderType::Parakeet => "parakeet-tdt-0.6b-v3",
            AsrProviderType::WhisperCandle => "whisper-large-v3-turbo",
            AsrProviderType::DistilWhisper => "distil-large-v3.5",
            AsrProviderType::MacosAppleSpeech => "macos_apple_speech",
            AsrProviderType::Moonshine => "moonshine-base",
            AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation",
            // scribe_v2_realtime is websocket-only and cannot be served by
            // this provider's batch /v1/speech-to-text endpoint -- see
            // elevenlabs_scribe.rs's sanitize_elevenlabs_asr_model_id.
            AsrProviderType::ElevenLabsScribe => "scribe_v2",
            // Verified live against
            // https://developers.openai.com/api/docs/guides/speech-to-text on
            // 2026-08-27: gpt-transcribe is OpenAI's current recommended
            // default for this endpoint, superseding whisper-1.
            AsrProviderType::OpenAiCloud => "gpt-transcribe",
            AsrProviderType::Groq => "whisper-large-v3-turbo",
            AsrProviderType::CohereTranscribe => "cohere-transcribe-03-2026",
            AsrProviderType::Qwen3Asr => "qwen3-asr-0.6b",
        }
    }

    /// Canonical credential slot so reset coverage follows the exhaustive provider enum.
    pub fn provider_secret_name(self) -> Option<&'static str> {
        match self {
            AsrProviderType::ElevenLabsScribe => Some("elevenlabs"),
            AsrProviderType::OpenAiCloud => Some("openai"),
            AsrProviderType::Groq => Some("groq"),
            AsrProviderType::CohereTranscribe => Some("cohere"),
            AsrProviderType::Whisper
            | AsrProviderType::Parakeet
            | AsrProviderType::WhisperCandle
            | AsrProviderType::DistilWhisper
            | AsrProviderType::MacosAppleSpeech
            | AsrProviderType::Moonshine
            | AsrProviderType::WindowsSdkDictation
            | AsrProviderType::Qwen3Asr => None,
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
                    id: "parakeet-tdt-ctc-110m".to_string(),
                    label: "Parakeet TDT CTC 110M legacy (English only)".to_string(),
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
            AsrProviderType::WindowsSdkDictation => vec![ModelOption {
                id: "windows_sdk_dictation".to_string(),
                label: "Managed by Windows".to_string(),
            }],
            // scribe_v2_realtime is intentionally not offered here: it is a
            // websocket-only model and this provider posts to the batch
            // /v1/speech-to-text endpoint, which cannot serve it (see
            // elevenlabs_scribe.rs's sanitize_elevenlabs_asr_model_id).
            AsrProviderType::ElevenLabsScribe => vec![
                ModelOption {
                    id: "scribe_v2".to_string(),
                    label: "Scribe v2 (recommended)".to_string(),
                },
                ModelOption {
                    id: "scribe_v2_experimental".to_string(),
                    label: "Scribe v2 Experimental".to_string(),
                },
            ],
            AsrProviderType::OpenAiCloud => vec![
                ModelOption {
                    id: "gpt-transcribe".to_string(),
                    label: "gpt-transcribe (recommended)".to_string(),
                },
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
            AsrProviderType::Qwen3Asr => vec![ModelOption {
                id: "qwen3-asr-0.6b".to_string(),
                label: "Qwen3-ASR 0.6B int4 (multilingual, fast)".to_string(),
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
            AsrProviderType::MacosAppleSpeech => {
                Box::new(macos_apple_speech_provider::MacosAppleSpeechProvider::new())
            }
            AsrProviderType::Moonshine => {
                Box::new(moonshine::MoonshineProvider::new(selected_model_id))
            }
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
            AsrProviderType::Qwen3Asr => {
                Box::new(qwen3_asr::Qwen3AsrProvider::new(selected_model_id))
            }
        }
    }
}

// Re-export manager types
pub use manager::{
    AsrManager, BenchmarkResult, ProviderInfo, ProviderInventory, RuntimeDiagnostics,
};
