//! xAI Grok speech-to-text over the batch `POST /v1/stt` endpoint.
//!
//! Request and response shapes follow `@ai-sdk/xai` 5.0.7 (Vercel's
//! maintained client for this endpoint, `XaiTranscriptionModel`), read on
//! 2026-09-24 because docs.x.ai was not reachable from the build machine.
//! Re-check against https://docs.x.ai before relying on anything beyond:
//!
//! - multipart upload, audio in a `file` part, `Authorization: Bearer`;
//! - `keyterm` repeated once per term to bias recognition;
//! - JSON reply `{ text, language?, duration?, words?: [{ text, start, end }] }`.
//!
//! The endpoint takes no model parameter: it serves whichever model xAI
//! currently runs behind it (reported as Grok Voice Transcribe 2.0 in
//! September 2026, listed at 2.3% on the Artificial Analysis AA-WER board). Dictation only for now:
//! the meeting lane needs xAI's per-request size and duration limits, which
//! have not been confirmed against xAI's own documentation.

use super::{
    cloud_asr_status_error,
    openai_cloud::{build_cloud_asr_client, CloudAsrHttpTimeouts},
    read_cloud_asr_json, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptSegment, TranscriptionOptions, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::{path::Path, time::Duration};

const XAI_STT_API_URL: &str = "https://api.x.ai/v1/stt";

/// The one route id this provider offers. The endpoint picks the model, so
/// this names the endpoint rather than pinning a snapshot.
pub(crate) const XAI_STT_MODEL_ID: &str = "grok-stt";

const XAI_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(90),
    total: Duration::from_secs(120),
};

/// xAI's reported ceiling on bias terms per request. Unconfirmed against
/// xAI's own docs, so extra terms are dropped rather than risk a rejected
/// request: the hint is an accuracy aid, never a precondition.
const MAX_KEYTERMS: usize = 100;

/// Word timestamps are real; the endpoint reports no per-word confidence.
const XAI_SEGMENT_CONFIDENCE: f64 = 0.95;

pub struct XaiSttProvider {
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct XaiSttResponse {
    /// Defaulted so silent audio reads as an empty transcript ("no speech")
    /// rather than a failed request.
    #[serde(default, deserialize_with = "null_as_default")]
    text: String,
    language: Option<String>,
    words: Option<Vec<XaiSttWord>>,
}

/// Every word field is optional: a word missing its timing (or its text)
/// is dropped from the timestamps, never allowed to fail the transcript.
#[derive(Deserialize)]
struct XaiSttWord {
    text: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
}

fn null_as_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

impl Default for XaiSttProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

impl XaiSttProvider {
    pub fn new(_selected_model_id: Option<&str>) -> Self {
        Self {
            client: build_cloud_asr_client(XAI_HTTP_TIMEOUTS),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("xai") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("XAI_API_KEY")
                .ok()
                .filter(|key| !key.is_empty()),
        }
    }

    async fn transcribe_impl(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key()
            .context("No xAI API key: add one in Settings, API Keys, or set XAI_API_KEY")?;
        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new().part("file", part);
        // Only a concrete language: leaving it out is how the endpoint
        // auto-detects, and "auto" is Plainsong's name for that.
        let requested_language = xai_language(options.language.as_deref());
        if let Some(language) = requested_language.as_deref() {
            form = form.text("language", language.to_string());
        }

        let mut vocabulary_hint_terms_applied = 0usize;
        if let Some(hint) = options.vocabulary_hint.as_ref() {
            for term in xai_keyterms(hint.terms()) {
                vocabulary_hint_terms_applied += 1;
                form = form.text("keyterm", term);
            }
        }

        let response = self
            .client
            .post(XAI_STT_API_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .timeout(XAI_HTTP_TIMEOUTS.total)
            .send()
            .await
            .context("xAI speech-to-text request failed")?;

        if !response.status().is_success() {
            return Err(cloud_asr_status_error("xAI Grok", response.status()));
        }

        let result: XaiSttResponse = read_cloud_asr_json(response, "xAI Grok").await?;
        let segments = result
            .words
            .unwrap_or_default()
            .into_iter()
            .filter_map(|word| {
                Some(TranscriptSegment {
                    start_time: word.start?,
                    end_time: word.end?,
                    text: word.text?,
                    confidence: XAI_SEGMENT_CONFIDENCE,
                })
            })
            .collect();

        Ok(TranscriptionResult {
            text: result.text,
            segments,
            // What xAI detected, else what was asked for; never a guessed
            // "en" that would hide auto-detection from later stages.
            language: result
                .language
                .filter(|language| !language.trim().is_empty())
                .or(requested_language)
                .unwrap_or_default(),
            confidence: XAI_SEGMENT_CONFIDENCE,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "xAI Grok speech-to-text".to_string(),
            model_id: XAI_STT_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::XaiStt,
            actual_provider: AsrProviderType::XaiStt,
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
impl AsrProvider for XaiSttProvider {
    fn name(&self) -> &str {
        "xAI Grok"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via xAI's Grok API"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Grok speech-to-text".to_string(),
            version: XAI_STT_MODEL_ID.to_string(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://docs.x.ai".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for xAI speech-to-text")?;
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

fn xai_language(language: Option<&str>) -> Option<String> {
    language
        .map(str::trim)
        .filter(|language| !language.is_empty() && !language.eq_ignore_ascii_case("auto"))
        .map(str::to_string)
}

/// Trimmed, de-duplicated, non-empty terms, capped at [`MAX_KEYTERMS`].
fn xai_keyterms(terms: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for term in terms.iter().map(|term| term.trim()) {
        if term.is_empty() || kept.iter().any(|existing| existing == term) {
            continue;
        }
        kept.push(term.to_string());
        if kept.len() == MAX_KEYTERMS {
            break;
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn keyterms_are_trimmed_deduplicated_and_capped() {
        let terms = strings(&["  Plainsong ", "", "Plainsong", "Kubernetes"]);
        assert_eq!(xai_keyterms(&terms), strings(&["Plainsong", "Kubernetes"]));

        let many: Vec<String> = (0..150).map(|index| format!("term{index}")).collect();
        assert_eq!(xai_keyterms(&many).len(), MAX_KEYTERMS);
    }

    #[test]
    fn parses_the_documented_reply_with_and_without_words() {
        let full: XaiSttResponse = serde_json::from_str(
            r#"{"text":"hello there","language":"en","duration":1.2,
                "words":[{"text":"hello","start":0.0,"end":0.4},{"text":"there","start":0.5,"end":0.9}]}"#,
        )
        .expect("full reply");
        assert_eq!(full.text, "hello there");
        assert_eq!(full.words.map(|words| words.len()), Some(2));

        let bare: XaiSttResponse =
            serde_json::from_str(r#"{"text":"hi","language":null,"words":null}"#)
                .expect("bare reply");
        assert!(bare.words.is_none());
        assert!(bare.language.is_none());
    }

    #[test]
    fn language_is_sent_only_when_concrete() {
        assert_eq!(xai_language(Some("de")), Some("de".to_string()));
        assert_eq!(xai_language(Some(" auto ")), None);
        assert_eq!(xai_language(Some("")), None);
        assert_eq!(xai_language(None), None);
    }

    #[test]
    fn a_reply_without_text_is_an_empty_transcript_not_an_error() {
        let reply: XaiSttResponse = serde_json::from_str(r#"{"language":"en"}"#).expect("no text");
        assert!(reply.text.is_empty());
    }

    #[test]
    fn null_text_or_untimed_words_do_not_fail_the_reply() {
        let reply: XaiSttResponse = serde_json::from_str(
            r#"{"text":null,"words":[{"text":"hi","start":0.0},{"text":null,"start":1,"end":2}]}"#,
        )
        .expect("lenient reply");
        assert!(reply.text.is_empty());
        assert_eq!(reply.words.map(|words| words.len()), Some(2));
    }

    #[test]
    fn cloud_client_has_bounded_timeouts() {
        assert!(XAI_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
        assert!(XAI_HTTP_TIMEOUTS.connect <= XAI_HTTP_TIMEOUTS.read);
    }
}
