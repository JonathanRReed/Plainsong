//! Cohere Transcribe ASR Provider - Cloud speech-to-text via Cohere API
//!
//! Uses the OpenAI-compatible endpoint at api.cohere.com.
//! Model: cohere-transcribe-03-2026 — low WER, 14 languages, up to 25 MB audio.

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;

const COHERE_TRANSCRIPTION_URL: &str =
    "https://api.cohere.com/compatibility/v1/audio/transcriptions";

pub struct CohereTranscribeProvider {
    model_id: String,
}

#[derive(Deserialize)]
struct CohereTranscriptionResponse {
    text: String,
}

fn sanitize_cohere_model_id(model_id: &str) -> &'static str {
    match model_id {
        "cohere-transcribe-03-2026" => "cohere-transcribe-03-2026",
        _ => "cohere-transcribe-03-2026",
    }
}

impl Default for CohereTranscribeProvider {
    fn default() -> Self {
        Self {
            model_id: "cohere-transcribe-03-2026".to_string(),
        }
    }
}

impl CohereTranscribeProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_cohere_model_id(
                selected_model_id.unwrap_or("cohere-transcribe-03-2026"),
            )
            .to_string(),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("cohere") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("CO_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    async fn transcribe_impl(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context(
            "Cohere API key not set. Add it in Settings → API Keys or set CO_API_KEY.",
        )?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", self.model_id.clone())
            .text("language", "en");

        let client = reqwest::Client::new();
        let response = client
            .post(COHERE_TRANSCRIPTION_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .context("Cohere Transcribe API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Cohere Transcribe API error {}: {}", status, body);
        }

        let result = response
            .json::<CohereTranscriptionResponse>()
            .await
            .context("Failed to parse Cohere Transcribe response")?;

        let text = result.text;
        let elapsed = start.elapsed().as_millis() as u64;

        tracing::info!(
            "Cohere transcription completed: {} chars in {}ms using {}",
            text.len(),
            elapsed,
            self.model_id
        );

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0,
                text,
                confidence: 0.94,
            }],
            language: "en".to_string(),
            confidence: 0.94,
            processing_time_ms: elapsed,
            model_name: format!("Cohere Transcribe ({})", self.model_id),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::CohereTranscribe,
            actual_provider: AsrProviderType::CohereTranscribe,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }
}

#[async_trait]
impl AsrProvider for CohereTranscribeProvider {
    fn name(&self) -> &str {
        "Cohere Transcribe"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via Cohere API. Low word error rate, supports 14 languages. \
         Requires CO_API_KEY from https://dashboard.cohere.com/api-keys"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Cohere Transcribe".to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec![
                "en", "fr", "de", "es", "it", "pt", "nl", "pl", "ru", "ja", "zh", "ko", "ar",
                "hi",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://docs.cohere.com/docs/audio-transcription-quickstart".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for Cohere Transcribe")?;
        self.transcribe_impl(&audio_data).await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        self.transcribe_impl(audio_data).await
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::Downloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        Ok(())
    }
}
