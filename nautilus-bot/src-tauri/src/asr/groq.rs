//! Groq Cloud ASR Provider - Ultra-fast Whisper inference (164x real-time)
//!
//! Groq provides OpenAI-compatible Whisper API with exceptional speed:
//! - whisper-large-v3: Best accuracy, multilingual
//! - whisper-large-v3-turbo: Fast + accurate, recommended for dictation

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;

const GROQ_TRANSCRIPTION_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";

pub struct GroqProvider {
    model_id: String,
}

#[derive(Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
    segments: Option<Vec<GroqSegment>>,
}

#[derive(Deserialize)]
struct GroqSegment {
    start: f64,
    end: f64,
    text: String,
}

fn sanitize_groq_model_id(model_id: &str) -> &'static str {
    match model_id {
        "whisper-large-v3" => "whisper-large-v3",
        "whisper-large-v3-turbo" => "whisper-large-v3-turbo",
        _ => "whisper-large-v3-turbo", // Default to turbo for speed
    }
}

impl Default for GroqProvider {
    fn default() -> Self {
        Self {
            model_id: "whisper-large-v3-turbo".to_string(),
        }
    }
}

impl GroqProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_groq_model_id(selected_model_id.unwrap_or("whisper-large-v3-turbo"))
                .to_string(),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("groq") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("GROQ_API_KEY").ok().filter(|k| !k.is_empty()),
        }
    }

    async fn transcribe_impl(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context("GROQ_API_KEY environment variable not set. Get your API key at https://console.groq.com/keys")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", self.model_id.clone())
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "segment");

        let client = reqwest::Client::new();
        let response = client
            .post(GROQ_TRANSCRIPTION_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .context("Groq Whisper API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Groq Whisper API error {}: {}", status, body);
        }

        let result = response
            .json::<GroqTranscriptionResponse>()
            .await
            .context("Failed to parse Groq Whisper response")?;

        let segments: Vec<TranscriptSegment> = result
            .segments
            .map(|segs: Vec<GroqSegment>| {
                segs.iter()
                    .map(|s| TranscriptSegment {
                        start_time: s.start,
                        end_time: s.end,
                        text: s.text.clone(),
                        confidence: 0.92,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let elapsed = start.elapsed().as_millis() as u64;
        tracing::info!(
            "Groq transcription completed: {} chars in {}ms using {}",
            result.text.len(),
            elapsed,
            self.model_id
        );

        Ok(TranscriptionResult {
            text: result.text,
            segments,
            language: "en".to_string(),
            confidence: 0.92,
            processing_time_ms: elapsed,
            model_name: format!("Groq ({})", self.model_id),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Groq,
            actual_provider: AsrProviderType::Groq,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }
}

#[async_trait]
impl AsrProvider for GroqProvider {
    fn name(&self) -> &str {
        "Groq Whisper (Cloud)"
    }

    fn description(&self) -> &str {
        "Ultra-fast cloud Whisper via Groq API. Transcribes at 164x real-time speed. \
         whisper-large-v3-turbo recommended for dictation (fast + accurate). \
         Requires GROQ_API_KEY from https://console.groq.com/keys"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        let (wer, rtf) = match self.model_id.as_str() {
            "whisper-large-v3" => (Some(6.0), Some(0.006)), // 164x RT
            "whisper-large-v3-turbo" => (Some(6.4), Some(0.004)), // Even faster
            _ => (Some(6.4), Some(0.004)),
        };
        ModelInfo {
            name: "Groq Whisper".to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: wer,
            real_time_factor: rtf,
            license: "Commercial API".to_string(),
            source_url: "https://console.groq.com/docs/speech-to-text".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for Groq Whisper")?;
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
