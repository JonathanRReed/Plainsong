use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;

const SCRIBE_API_URL: &str = "https://api.elevenlabs.io/v1/speech-to-text";

pub struct ElevenLabsScribeProvider {
    model_id: String,
}

#[derive(Deserialize)]
struct ScribeResponse {
    text: Option<String>,
    words: Option<Vec<ScribeWord>>,
}

fn sanitize_elevenlabs_asr_model_id(model_id: &str) -> &'static str {
    match model_id {
        "scribe_v2_realtime" => "scribe_v2_realtime",
        "scribe_v2" => "scribe_v2",
        "scribe_v2_experimental" => "scribe_v2_experimental",
        "scribe_v1" => "scribe_v2",
        "scribe_v1_experimental" => "scribe_v2_experimental",
        _ => "scribe_v2_realtime", // Default to v2 Realtime for ultra-low latency
    }
}

#[derive(Deserialize)]
struct ScribeWord {
    text: String,
    start: f64,
    end: f64,
}

impl Default for ElevenLabsScribeProvider {
    fn default() -> Self {
        Self {
            model_id: "scribe_v2_realtime".to_string(),
        }
    }
}

impl ElevenLabsScribeProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_elevenlabs_asr_model_id(selected_model_id.unwrap_or("scribe_v2"))
                .to_string(),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("elevenlabs") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("ELEVENLABS_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    async fn transcribe_impl(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context("ELEVENLABS_API_KEY environment variable not set")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .part("audio", part)
            .text("model_id", self.model_id.clone());

        let client = reqwest::Client::new();
        let response = client
            .post(SCRIBE_API_URL)
            .header("xi-api-key", &api_key)
            .multipart(form)
            .send()
            .await
            .context("ElevenLabs Scribe API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("ElevenLabs Scribe API error {}: {}", status, body);
        }

        let result: ScribeResponse = response
            .json()
            .await
            .context("Failed to parse ElevenLabs Scribe response")?;

        let text = result.text.unwrap_or_default();
        let segments = result
            .words
            .map(|words| {
                words
                    .iter()
                    .map(|w| TranscriptSegment {
                        start_time: w.start,
                        end_time: w.end,
                        text: w.text.clone(),
                        confidence: 0.95,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let elapsed = start.elapsed().as_millis() as u64;

        Ok(TranscriptionResult {
            text,
            segments,
            language: "en".to_string(),
            confidence: 0.95,
            processing_time_ms: elapsed,
            model_name: format!("ElevenLabs Scribe ({})", self.model_id),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::ElevenLabsScribe,
            actual_provider: AsrProviderType::ElevenLabsScribe,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }

    fn selected_label(&self) -> &'static str {
        match self.model_id.as_str() {
            "scribe_v2_realtime" => "Scribe v2 Realtime",
            "scribe_v2_experimental" => "Scribe v2 Experimental",
            _ => "Scribe v2",
        }
    }
}

#[async_trait]
impl AsrProvider for ElevenLabsScribeProvider {
    fn name(&self) -> &str {
        "ElevenLabs Scribe"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via ElevenLabs Scribe API"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        let (languages, wer, rtf) = match self.model_id.as_str() {
            "scribe_v2_realtime" => (
                vec!["90+ languages".to_string()],
                Some(3.0),
                Some(0.05), // 150ms latency = 0.05 RTF
            ),
            _ => (
                vec!["en".to_string(), "multilingual".to_string()],
                None,
                None,
            ),
        };

        ModelInfo {
            name: self.selected_label().to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages,
            word_error_rate: wer,
            real_time_factor: rtf,
            license: "Commercial API".to_string(),
            source_url: "https://elevenlabs.io/docs/api-reference/speech-to-text".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for ElevenLabs Scribe")?;
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
