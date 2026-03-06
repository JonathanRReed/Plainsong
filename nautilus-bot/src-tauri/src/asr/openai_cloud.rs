use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";

pub struct OpenAiCloudWhisperProvider {
    model_id: String,
}

#[derive(Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
    segments: Option<Vec<OpenAiSegment>>,
    language: Option<String>,
}

fn sanitize_openai_asr_model_id(model_id: &str) -> &'static str {
    match model_id {
        "whisper-1" => "whisper-1",
        "gpt-4o-mini-transcribe" => "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe" => "gpt-4o-transcribe",
        _ => "whisper-1",
    }
}

#[derive(Deserialize)]
struct OpenAiSegment {
    start: f64,
    end: f64,
    text: String,
}

impl Default for OpenAiCloudWhisperProvider {
    fn default() -> Self {
        Self {
            model_id: "whisper-1".to_string(),
        }
    }
}

impl OpenAiCloudWhisperProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_openai_asr_model_id(selected_model_id.unwrap_or("whisper-1"))
                .to_string(),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("openai") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    fn uses_verbose_json(&self) -> bool {
        self.model_id == "whisper-1"
    }

    async fn transcribe_impl(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context("OPENAI_API_KEY environment variable not set")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", self.model_id.clone());

        if self.uses_verbose_json() {
            form = form
                .text("response_format", "verbose_json")
                .text("timestamp_granularities[]", "segment");
        } else {
            form = form.text("response_format", "json");
        }

        let client = reqwest::Client::new();
        let response = client
            .post(OPENAI_TRANSCRIPTION_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .send()
            .await
            .context("OpenAI Whisper API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("OpenAI Whisper API error {}: {}", status, body);
        }

        let payload = response
            .json::<Value>()
            .await
            .context("Failed to parse OpenAI Whisper response")?;

        let result: OpenAiTranscriptionResponse = serde_json::from_value(payload.clone())
            .context("Failed to decode OpenAI transcription payload")?;

        let segments: Vec<TranscriptSegment> = result
            .segments
            .map(|segs: Vec<OpenAiSegment>| {
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
        let language = result
            .language
            .or_else(|| {
                payload
                    .get("language")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "auto".to_string());

        Ok(TranscriptionResult {
            text: result.text,
            segments,
            language,
            confidence: 0.92,
            processing_time_ms: elapsed,
            model_name: format!("OpenAI ASR ({})", self.model_id),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::OpenAiCloud,
            actual_provider: AsrProviderType::OpenAiCloud,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }
}

#[async_trait]
impl AsrProvider for OpenAiCloudWhisperProvider {
    fn name(&self) -> &str {
        "OpenAI Whisper (Cloud)"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via OpenAI Whisper API"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Whisper (Cloud)".to_string(),
            version: "1.0".to_string(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://platform.openai.com/docs/guides/speech-to-text".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for OpenAI Whisper")?;
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

#[cfg(test)]
mod tests {
    use super::OpenAiCloudWhisperProvider;

    #[test]
    fn openai_asr_response_format_matches_selected_model() {
        assert!(OpenAiCloudWhisperProvider::new(Some("whisper-1")).uses_verbose_json());
        assert!(!OpenAiCloudWhisperProvider::new(Some("gpt-4o-transcribe")).uses_verbose_json());
        assert!(
            !OpenAiCloudWhisperProvider::new(Some("gpt-4o-mini-transcribe")).uses_verbose_json()
        );
    }
}
