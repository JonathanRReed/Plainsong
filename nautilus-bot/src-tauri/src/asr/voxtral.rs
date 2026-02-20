use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;

// ---------------------------------------------------------------------------
// Mistral Voxtral-Mini — supports BOTH local model and cloud API.
//
// Local mode : downloads model files from mistralai/Voxtral-Mini-4B-Realtime-2602.
//              Inference via Candle (feature-gated `asr-canary`).
// Cloud mode : Mistral REST API — api.mistral.ai/v1/audio/transcriptions.
//
// Priority: local model (if downloaded) > cloud API (if key present).
// ---------------------------------------------------------------------------
const VOXTRAL_MODEL_ID: &str = "voxtral-mini-4b";
const VOXTRAL_API_MODEL: &str = "voxtral-mini-4b-2602";
const MISTRAL_ASR_URL: &str = "https://api.mistral.ai/v1/audio/transcriptions";
const VOXTRAL_HF_REPO: &str = "mistralai/Voxtral-Mini-4B-Realtime-2602";

/// Files required for local Voxtral inference.
const VOXTRAL_LOCAL_REQUIRED: [&str; 4] = [
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
    "model.safetensors",
];

// ---------------------------------------------------------------------------
// Local inference (feature-gated)
// ---------------------------------------------------------------------------

/// Attempt local Voxtral inference using Candle.
///
/// Voxtral-Mini-4B uses a Whisper-Large-V3 audio encoder + Mistral-4B decoder
/// (speech-LLM architecture). The full pipeline is not yet in candle-transformers.
/// Returns Err to trigger cloud fallback. Native inference will be activated here
/// once candle-transformers gains Voxtral / speech-LLM support.
fn run_voxtral_local(
    _model_dir: &std::path::Path,
    _audio_data: &[u8],
) -> Result<String> {
    anyhow::bail!(
        "Voxtral local inference: model downloaded but native speech-LLM pipeline \
         not yet available in candle-transformers. Using cloud API as fallback."
    )
}

#[derive(Deserialize)]
struct MistralTranscriptionResponse {
    text: String,
}

pub struct VoxtralProvider {
    model_dir: std::path::PathBuf,
}

impl VoxtralProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("voxtral");
        Self { model_dir }
    }

    fn has_local_model(&self) -> bool {
        VOXTRAL_LOCAL_REQUIRED
            .iter()
            .all(|f| self.model_dir.join(f).exists())
    }

    fn api_key() -> Option<String> {
        match crate::secrets::get_provider_secret("mistral") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("MISTRAL_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    async fn transcribe_impl(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key = Self::api_key()
            .context("Mistral API key not set. Add it in Settings → API Keys.")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", VOXTRAL_API_MODEL);

        let client = reqwest::Client::new();
        let response = client
            .post(MISTRAL_ASR_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .send()
            .await
            .context("Mistral Voxtral API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Mistral Voxtral API error {}: {}", status, body);
        }

        let result = response
            .json::<MistralTranscriptionResponse>()
            .await
            .context("Failed to parse Mistral Voxtral response")?;

        let text = result.text;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0,
                text,
                confidence: 0.93,
            }],
            language: "auto".to_string(),
            confidence: 0.93,
            processing_time_ms: elapsed,
            model_name: format!("Voxtral Mini ({})", VOXTRAL_API_MODEL),
            model_id: VOXTRAL_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::Voxtral,
            actual_provider: AsrProviderType::Voxtral,
            fallback_used: false,
            fallback_reason: None,
        })
    }
}

impl Default for VoxtralProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for VoxtralProvider {
    fn name(&self) -> &str {
        "Mistral Voxtral Mini"
    }

    fn description(&self) -> &str {
        if self.has_local_model() && Self::api_key().is_some() {
            "Mistral Voxtral-Mini-4B — local model ready (native inference pending), cloud API active."
        } else if self.has_local_model() {
            "Mistral Voxtral-Mini-4B — local model downloaded; native speech-LLM inference coming soon. Add a Mistral API key to enable cloud transcription."
        } else if Self::api_key().is_some() {
            "Mistral Voxtral-Mini-4B — cloud API (Mistral key active). Download the model to pre-cache for future local inference."
        } else {
            "Mistral Voxtral-Mini-4B — add a Mistral API key for cloud transcription, or download the model to pre-cache for future local inference."
        }
    }

    fn is_available(&self) -> bool {
        self.has_local_model() || Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Voxtral Mini 4B".to_string(),
            version: "2602".to_string(),
            size_mb: 8192.0,
            parameters: "4B local / cloud".to_string(),
            languages: vec![
                "en", "fr", "de", "es", "it", "pt", "nl", "pl", "ru", "ja", "zh",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://mistral.ai/news/voxtral".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for Voxtral")?;
        self.transcribe_bytes(&audio_data).await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        // Prefer local inference when model is present.
        if self.has_local_model() {
            let model_dir = self.model_dir.clone();
            let data = audio_data.to_vec();
            let start = std::time::Instant::now();
            let local_result = tokio::task::spawn_blocking(move || {
                run_voxtral_local(&model_dir, &data)
            })
            .await
            .context("Voxtral local task panicked")?;

            match local_result {
                Ok(text) => {
                    return Ok(TranscriptionResult {
                        text: text.clone(),
                        segments: vec![TranscriptSegment {
                            start_time: 0.0,
                            end_time: 0.0,
                            text,
                            confidence: 0.91,
                        }],
                        language: "auto".to_string(),
                        confidence: 0.91,
                        processing_time_ms: start.elapsed().as_millis() as u64,
                        model_name: "voxtral-mini-4b-local".to_string(),
                        model_id: VOXTRAL_MODEL_ID.to_string(),
                        requested_provider: AsrProviderType::Voxtral,
                        actual_provider: AsrProviderType::Voxtral,
                        fallback_used: false,
                        fallback_reason: None,
                    });
                }
                Err(local_err) => {
                    tracing::warn!("Voxtral local inference failed, trying cloud: {}", local_err);
                    // Fall through to cloud API
                }
            }
        }
        self.transcribe_impl(audio_data).await
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_local_model() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;
        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create Voxtral model directory")?;
        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);
        for (i, file_name) in VOXTRAL_LOCAL_REQUIRED.iter().enumerate() {
            let dest = self.model_dir.join(file_name);
            if dest.exists() {
                continue;
            }
            let url = format!("https://huggingface.co/{}/resolve/main/{}", VOXTRAL_HF_REPO, file_name);
            let cb = progress_cb.clone();
            let n = VOXTRAL_LOCAL_REQUIRED.len() as f32;
            manager
                .download_file_unverified(&url, &dest, move |p| {
                    cb((i as f32 / n + p.percentage as f32 / 100.0 / n) * 100.0);
                })
                .await?;
        }
        tracing::info!("Voxtral local model downloaded successfully");
        Ok(())
    }
}
