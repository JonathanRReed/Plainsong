//! Plainsong Plus speech-to-text (feature `plainsong-plus`, NOT LAUNCHED).
//!
//! Posts the recording to the Plus relay (`infra/plus-worker`), which picks
//! the model (Grok speech-to-text, with ElevenLabs Scribe as its fallback)
//! and answers in the same shape as `xai_stt.rs` parses. Dictation only for
//! now: the relay's meeting purpose exists, but meetings need speaker labels
//! and chunked uploads this route does not send yet.

use super::{
    openai_cloud::{build_cloud_asr_client, CloudAsrHttpTimeouts},
    read_cloud_asr_json, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptSegment, TranscriptionOptions, TranscriptionResult,
};
use crate::plus;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::{path::Path, time::Duration};

/// The one route id. The relay chooses the model behind it.
pub(crate) const PLUS_STT_MODEL_ID: &str = "plus-best";

const PLUS_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(90),
    total: Duration::from_secs(120),
};

/// The relay caps bias terms at the same 100 as its upstream.
const MAX_KEYTERMS: usize = 100;
const PLUS_SEGMENT_CONFIDENCE: f64 = 0.95;

pub struct PlainsongPlusProvider {
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct PlusSttResponse {
    #[serde(default)]
    text: String,
    language: Option<String>,
    #[serde(default)]
    words: Vec<PlusSttWord>,
}

#[derive(Deserialize)]
struct PlusSttWord {
    text: String,
    start: f64,
    end: f64,
}

impl Default for PlainsongPlusProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

impl PlainsongPlusProvider {
    pub fn new(_selected_model_id: Option<&str>) -> Self {
        Self {
            client: build_cloud_asr_client(PLUS_HTTP_TIMEOUTS),
        }
    }

    async fn transcribe_impl(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let start = std::time::Instant::now();
        let token = plus::access_token().await?;

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("purpose", "dictation");
        let requested_language = options
            .language
            .as_deref()
            .map(str::trim)
            .filter(|language| !language.is_empty() && !language.eq_ignore_ascii_case("auto"))
            .map(str::to_string);
        if let Some(language) = requested_language.as_deref() {
            form = form.text("language", language.to_string());
        }
        let mut vocabulary_hint_terms_applied = 0usize;
        if let Some(hint) = options.vocabulary_hint.as_ref() {
            for term in hint
                .terms()
                .iter()
                .map(|term| term.trim())
                .filter(|term| !term.is_empty())
                .take(MAX_KEYTERMS)
            {
                vocabulary_hint_terms_applied += 1;
                form = form.text("keyterm", term.to_string());
            }
        }

        let response = self
            .client
            .post(format!("{}/v1/audio/transcriptions", plus::base_url()))
            .bearer_auth(&token)
            .multipart(form)
            .timeout(PLUS_HTTP_TIMEOUTS.total)
            .send()
            .await
            .context("Plainsong Plus request failed")?;
        let status = response.status();
        if !status.is_success() {
            // The relay's error bodies are its own fixed messages; they never
            // echo audio, text or keyterms.
            let body = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                plus::forget_token();
            }
            bail!(plus::error_message(status, &body));
        }

        let result: PlusSttResponse = read_cloud_asr_json(response, "Plainsong Plus").await?;
        let segments = result
            .words
            .into_iter()
            .map(|word| TranscriptSegment {
                start_time: word.start,
                end_time: word.end,
                text: word.text,
                confidence: PLUS_SEGMENT_CONFIDENCE,
            })
            .collect();
        Ok(TranscriptionResult {
            text: result.text,
            segments,
            language: result
                .language
                .filter(|language| !language.trim().is_empty())
                .or(requested_language)
                .unwrap_or_default(),
            confidence: PLUS_SEGMENT_CONFIDENCE,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "Plainsong Plus".to_string(),
            model_id: PLUS_STT_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::PlainsongPlus,
            actual_provider: AsrProviderType::PlainsongPlus,
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
impl AsrProvider for PlainsongPlusProvider {
    fn name(&self) -> &str {
        "Plainsong Plus"
    }

    fn description(&self) -> &str {
        "Hosted speech-to-text included with a Plainsong Plus subscription"
    }

    fn is_available(&self) -> bool {
        plus::is_signed_in()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Plainsong Plus".to_string(),
            version: PLUS_STT_MODEL_ID.to_string(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Plainsong Plus subscription".to_string(),
            source_url: plus::base_url(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for Plainsong Plus")?;
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
    use super::*;

    #[test]
    fn parses_the_relay_reply_with_and_without_words() {
        let full: PlusSttResponse = serde_json::from_str(
            r#"{"text":"hello","language":"en","duration":0.5,
                "words":[{"text":"hello","start":0.0,"end":0.4}]}"#,
        )
        .expect("full reply");
        assert_eq!(full.words.len(), 1);
        let bare: PlusSttResponse = serde_json::from_str(r#"{"language":null}"#).expect("bare");
        assert!(bare.text.is_empty() && bare.words.is_empty());
    }
}
