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

const SCRIBE_API_URL: &str = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(90),
    total: Duration::from_secs(120),
};

pub struct ElevenLabsScribeProvider {
    model_id: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct ScribeResponse {
    text: Option<String>,
    words: Option<Vec<ScribeWord>>,
}

/// This provider posts to the batch `/v1/speech-to-text` file-upload endpoint
/// (see `SCRIBE_API_URL`), not ElevenLabs' realtime websocket API. Verified
/// live against
/// https://elevenlabs.io/docs/api-reference/speech-to-text/convert on
/// 2026-08-27: the batch endpoint's documented `model_id` examples and
/// changelog entries only ever show `scribe_v2` / `scribe_v2_experimental`;
/// `scribe_v2_realtime` (and its `_turbo`/`_lite` siblings) are introduced
/// exclusively under ElevenLabs' realtime speech-to-text docs, gated behind
/// the websocket API. Selecting `scribe_v2_realtime` here previously sent a
/// model this endpoint cannot serve. `scribe_v1` was removed 2026-07-09 and
/// remapped to `scribe_v2` for existing settings.
fn sanitize_elevenlabs_asr_model_id(model_id: &str) -> &'static str {
    match model_id {
        "scribe_v2" => "scribe_v2",
        "scribe_v2_experimental" => "scribe_v2_experimental",
        "scribe_v1" => "scribe_v2",
        "scribe_v1_experimental" => "scribe_v2_experimental",
        // Legacy settings/callers may still carry the realtime-only id; remap
        // it to the batch-endpoint model instead of sending a value the batch
        // API cannot serve.
        "scribe_v2_realtime" => "scribe_v2",
        _ => "scribe_v2",
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
        Self::new(Some("scribe_v2"))
    }
}

impl ElevenLabsScribeProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_elevenlabs_asr_model_id(selected_model_id.unwrap_or("scribe_v2"))
                .to_string(),
            client: build_cloud_asr_client(ELEVENLABS_HTTP_TIMEOUTS),
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

    async fn transcribe_impl(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context("ELEVENLABS_API_KEY environment variable not set")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .part("audio", part)
            .text("model_id", self.model_id.clone());

        // Personal-dictionary vocabulary bias. Scribe's documented field is
        // `keyterms` (one multipart field per term). ElevenLabs bills a 20%
        // surcharge on a request that carries keyterms, which is why this is
        // only ever sent when the user's own dictionary has applicable
        // entries — see CHANGELOG and docs/evals/dictation-dictionary-fixture-report.md.
        let mut vocabulary_hint_terms_applied = 0usize;
        if let Some(hint) = options.vocabulary_hint.as_ref() {
            for term in scribe_keyterms(hint.terms()) {
                vocabulary_hint_terms_applied += 1;
                form = form.text("keyterms", term);
            }
        }

        let response = self
            .client
            .post(SCRIBE_API_URL)
            .header("xi-api-key", &api_key)
            .multipart(form)
            .timeout(ELEVENLABS_HTTP_TIMEOUTS.total)
            .send()
            .await
            .context("ElevenLabs Scribe API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(cloud_asr_status_error("ElevenLabs Scribe", status));
        }

        let result: ScribeResponse = read_cloud_asr_json(response, "ElevenLabs Scribe").await?;

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
            vocabulary_hint_terms_applied,
        })
    }

    fn selected_label(&self) -> &'static str {
        match self.model_id.as_str() {
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
        ModelInfo {
            name: self.selected_label().to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://elevenlabs.io/docs/api-reference/speech-to-text".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let audio_data = tokio::fs::read(audio_path)
            .await
            .context("Failed to read audio file for ElevenLabs Scribe")?;
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
    use super::{
        sanitize_elevenlabs_asr_model_id, ElevenLabsScribeProvider, ELEVENLABS_HTTP_TIMEOUTS,
    };
    use crate::asr::AsrProvider;
    use std::time::Duration;

    #[test]
    fn elevenlabs_cloud_client_has_bounded_timeouts() {
        assert_eq!(ELEVENLABS_HTTP_TIMEOUTS.connect, Duration::from_secs(10));
        assert_eq!(ELEVENLABS_HTTP_TIMEOUTS.read, Duration::from_secs(90));
        assert_eq!(ELEVENLABS_HTTP_TIMEOUTS.total, Duration::from_secs(120));
        assert!(ELEVENLABS_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
    }

    #[test]
    fn realtime_model_never_reaches_the_batch_endpoint() {
        // scribe_v2_realtime is a websocket-only model; this provider posts to
        // the batch /v1/speech-to-text endpoint, which cannot serve it. Every
        // path that used to default to it must land on scribe_v2 instead.
        assert_eq!(
            sanitize_elevenlabs_asr_model_id("scribe_v2_realtime"),
            "scribe_v2"
        );
        assert_eq!(sanitize_elevenlabs_asr_model_id(""), "scribe_v2");
        assert_eq!(sanitize_elevenlabs_asr_model_id("garbage"), "scribe_v2");
        assert_eq!(
            ElevenLabsScribeProvider::new(Some("scribe_v2_realtime"))
                .model_info()
                .version,
            "scribe_v2"
        );
        assert_eq!(
            ElevenLabsScribeProvider::default().model_info().version,
            "scribe_v2"
        );
        assert_eq!(
            ElevenLabsScribeProvider::new(None).model_info().version,
            "scribe_v2"
        );
    }

    #[test]
    fn removed_scribe_v1_still_remaps_for_legacy_settings() {
        assert_eq!(sanitize_elevenlabs_asr_model_id("scribe_v1"), "scribe_v2");
        assert_eq!(
            sanitize_elevenlabs_asr_model_id("scribe_v1_experimental"),
            "scribe_v2_experimental"
        );
    }
}

/// Scribe's documented `keyterms` limits: at most 50 characters and 5 words
/// per term, none of `< > { } [ ] \`, and at most 1,000 terms per request.
/// Terms that break a limit are dropped rather than failing the whole
/// transcription — the hint is an accuracy aid, never a precondition.
fn scribe_keyterms(terms: &[String]) -> Vec<String> {
    const MAX_TERMS: usize = 1000;
    const MAX_CHARS: usize = 50;
    const MAX_WORDS: usize = 5;
    terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .filter(|term| term.chars().count() <= MAX_CHARS)
        .filter(|term| term.split_whitespace().count() <= MAX_WORDS)
        .filter(|term| {
            !term
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | '{' | '}' | '[' | ']' | '\\'))
        })
        .take(MAX_TERMS)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod keyterm_tests {
    use super::scribe_keyterms;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn keyterms_that_break_scribes_documented_limits_are_dropped_not_fatal() {
        let terms = strings(&[
            "Plainsong",
            "  Kubernetes ",
            "",
            "one two three four five six",
            "angle<bracket>",
            "brace{s}",
            "square[s]",
            "back\\slash",
            "this term is far too long to be a keyterm for scribe at all, over fifty",
        ]);
        assert_eq!(
            scribe_keyterms(&terms),
            strings(&["Plainsong", "Kubernetes"])
        );
    }

    #[test]
    fn five_word_phrases_and_fifty_char_terms_are_still_allowed() {
        let terms = strings(&["one two three four five", &"x".repeat(50)]);
        assert_eq!(scribe_keyterms(&terms).len(), 2);
    }
}
