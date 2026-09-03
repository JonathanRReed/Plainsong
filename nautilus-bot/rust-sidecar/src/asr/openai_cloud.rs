use super::{
    cloud_asr_status_error, read_cloud_asr_json, AsrProvider, AsrProviderType, DownloadStatus,
    ModelInfo, TranscriptSegment, TranscriptionOptions, TranscriptionResult, VocabularyHint,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use std::{path::Path, time::Duration};

const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(90),
    total: Duration::from_secs(120),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CloudAsrHttpTimeouts {
    pub connect: Duration,
    pub read: Duration,
    pub total: Duration,
}

pub(super) fn build_cloud_asr_client(timeouts: CloudAsrHttpTimeouts) -> reqwest::Client {
    // A provider that accepts the upload but never answers must not hold the dictation
    // session until IPC's five-minute deadline. The request deadline below is still
    // applied separately so redirects, uploads, and body reads share one hard ceiling.
    reqwest::Client::builder()
        .connect_timeout(timeouts.connect)
        .read_timeout(timeouts.read)
        .build()
        .expect("static cloud ASR HTTP client configuration must be valid")
}

pub struct OpenAiCloudWhisperProvider {
    model_id: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
    segments: Option<Vec<OpenAiSegment>>,
    language: Option<String>,
}

/// Verified live against
/// https://developers.openai.com/api/docs/guides/speech-to-text on
/// 2026-08-27: `gpt-transcribe` is OpenAI's current recommended default for
/// transcribing recorded speech, superseding `whisper-1` as the out-of-the-box
/// choice. `whisper-1`, `gpt-4o-mini-transcribe`, and `gpt-4o-transcribe`
/// remain live, documented models (whisper-1 is still recommended for
/// timestamps/subtitles/translation), so existing user selections keep
/// working unchanged -- only the empty/unrecognized fallback moved.
/// `gpt-live-transcribe` is deliberately excluded: it is a realtime/streaming
/// model for the websocket API, not this file-upload endpoint.
fn sanitize_openai_asr_model_id(model_id: &str) -> &'static str {
    match model_id {
        "whisper-1" => "whisper-1",
        "gpt-4o-mini-transcribe" => "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe" => "gpt-4o-transcribe",
        "gpt-transcribe" => "gpt-transcribe",
        _ => "gpt-transcribe",
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
        Self::new(None)
    }
}

impl OpenAiCloudWhisperProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_openai_asr_model_id(selected_model_id.unwrap_or("gpt-transcribe"))
                .to_string(),
            client: build_cloud_asr_client(OPENAI_HTTP_TIMEOUTS),
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

    fn selected_label(&self) -> &'static str {
        match self.model_id.as_str() {
            "gpt-4o-mini-transcribe" => "GPT-4o Mini Transcribe",
            "gpt-4o-transcribe" => "GPT-4o Transcribe",
            "whisper-1" => "Whisper-1",
            _ => "GPT Transcribe",
        }
    }

    async fn transcribe_impl(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
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

        // Personal-dictionary vocabulary bias. OpenAI's transcription API
        // reads `prompt` as style/spelling guidance for every model here
        // (whisper-1 and the gpt-4o transcribe family alike).
        let mut vocabulary_hint_terms_applied = 0usize;
        if let Some(hint) = options.vocabulary_hint.as_ref() {
            vocabulary_hint_terms_applied = hint.terms().len();
            form = form.text("prompt", VocabularyHint::as_prompt(hint));
        }

        let response = self
            .client
            .post(OPENAI_TRANSCRIPTION_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(OPENAI_HTTP_TIMEOUTS.total)
            .send()
            .await
            .context("OpenAI Whisper API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(cloud_asr_status_error("OpenAI Whisper", status));
        }

        let payload: Value = read_cloud_asr_json(response, "OpenAI Whisper").await?;

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
            vocabulary_hint_terms_applied,
            speaker_turns: Vec::new(),
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
            name: format!("OpenAI {}", self.selected_label()),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://developers.openai.com/api/docs/guides/speech-to-text".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for OpenAI Whisper")?;
        self.transcribe_impl(&audio_data, &TranscriptionOptions::default())
            .await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        self.transcribe_impl(audio_data, &TranscriptionOptions::default())
            .await
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        self.transcribe_impl(audio_data, options).await
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
    use super::{OpenAiCloudWhisperProvider, OPENAI_HTTP_TIMEOUTS};
    use crate::asr::AsrProvider;
    use std::time::Duration;

    #[test]
    fn openai_cloud_client_has_bounded_timeouts() {
        assert_eq!(OPENAI_HTTP_TIMEOUTS.connect, Duration::from_secs(10));
        assert_eq!(OPENAI_HTTP_TIMEOUTS.read, Duration::from_secs(90));
        assert_eq!(OPENAI_HTTP_TIMEOUTS.total, Duration::from_secs(120));
        assert!(OPENAI_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
    }

    #[test]
    fn openai_asr_response_format_matches_selected_model() {
        assert!(OpenAiCloudWhisperProvider::new(Some("whisper-1")).uses_verbose_json());
        assert!(!OpenAiCloudWhisperProvider::new(Some("gpt-4o-transcribe")).uses_verbose_json());
        assert!(
            !OpenAiCloudWhisperProvider::new(Some("gpt-4o-mini-transcribe")).uses_verbose_json()
        );
    }

    #[test]
    fn openai_model_info_tracks_selected_model() {
        let info = OpenAiCloudWhisperProvider::new(Some("gpt-4o-mini-transcribe")).model_info();

        assert_eq!(info.name, "OpenAI GPT-4o Mini Transcribe");
        assert_eq!(info.version, "gpt-4o-mini-transcribe");
    }

    #[test]
    fn default_and_unrecognized_selections_land_on_gpt_transcribe_not_whisper_1() {
        // Regression coverage for the 2026-08-27 model-currency audit:
        // gpt-transcribe is OpenAI's current recommended default, so an
        // absent or garbage selection must not silently coerce to the older
        // whisper-1 model.
        assert_eq!(
            OpenAiCloudWhisperProvider::new(None).model_info().version,
            "gpt-transcribe"
        );
        assert_eq!(
            OpenAiCloudWhisperProvider::default().model_info().version,
            "gpt-transcribe"
        );
        assert_eq!(
            OpenAiCloudWhisperProvider::new(Some("some-future-model"))
                .model_info()
                .version,
            "gpt-transcribe"
        );
        assert!(!OpenAiCloudWhisperProvider::new(Some("gpt-transcribe")).uses_verbose_json());
    }

    #[test]
    fn legacy_whisper_1_and_gpt4o_transcribe_selections_still_pass_through() {
        // Existing user settings pointing at these documented, still-live
        // models must survive unchanged.
        assert_eq!(
            OpenAiCloudWhisperProvider::new(Some("whisper-1"))
                .model_info()
                .version,
            "whisper-1"
        );
        assert_eq!(
            OpenAiCloudWhisperProvider::new(Some("gpt-4o-transcribe"))
                .model_info()
                .version,
            "gpt-4o-transcribe"
        );
    }
}
