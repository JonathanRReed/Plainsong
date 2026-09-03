//! Deepgram Nova-3 ASR provider — cloud speech-to-text over the batch
//! `/v1/listen` endpoint.
//!
//! Verified live against <https://developers.deepgram.com/docs/pre-recorded-audio>,
//! <https://developers.deepgram.com/docs/diarization>,
//! <https://developers.deepgram.com/docs/keyterm> and
//! <https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program>
//! on 2026-09-02. Research write-up: `docs/model-inventory-2026-09.md`.
//!
//! Three things about this endpoint shape the code below:
//!
//! 1. It takes the audio as the **raw request body** with the file's own
//!    `Content-Type`, not as a multipart part. That is what lets the meeting
//!    lane stream a whole recording off disk without buffering it.
//! 2. It is the first provider in this app that returns **speaker labels**, in
//!    `results.utterances[]` and per word as `speaker`. They are surfaced as
//!    `TranscriptionResult::speaker_turns`, never merged into the segments
//!    here — see the doc comment on `SpeakerTurn`.
//! 3. Deepgram's Model Improvement Partnership Program is the only route by
//!    which customer audio can reach their training set, and it is refused per
//!    request with `mip_opt_out=true`. The docs call participation voluntary
//!    while third-party summaries describe standard pricing as assuming it;
//!    rather than bet a user's meeting audio on which reading is right, this
//!    provider sends the opt-out on **every** request and has a test that says
//!    so.

use super::{
    cloud_asr_response_error,
    openai_cloud::{build_cloud_asr_client, CloudAsrHttpTimeouts},
    provider_speaker_id, read_cloud_asr_json, AsrProvider, AsrProviderType, DownloadStatus,
    ModelInfo, SpeakerTurn, TranscriptSegment, TranscriptionOptions, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::{path::Path, time::Duration};

const DEEPGRAM_LISTEN_URL: &str = "https://api.deepgram.com/v1/listen";

/// Dictation-shaped requests: a few seconds of audio already in memory. Kept
/// in line with the other cloud providers so a hung provider cannot hold a
/// dictation session open to IPC's five-minute deadline.
const DEEPGRAM_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(45),
    total: Duration::from_secs(60),
};

/// Whole-recording requests from the meeting lane. A two-hour meeting is a
/// several-hundred-megabyte upload before Deepgram has transcribed a word, so
/// the dictation ceiling would fail every long meeting on the upload alone.
/// Still bounded: a meeting that has not answered in fifteen minutes has
/// failed, and the meeting lane falls back to chunked transcription.
const DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(15),
    read: Duration::from_secs(10 * 60),
    total: Duration::from_secs(15 * 60),
};

pub struct DeepgramProvider {
    model_id: String,
    client: reqwest::Client,
    whole_file_client: reqwest::Client,
}

/// Only the two batch models this provider is allowed to send. `nova-3` is the
/// general model; `nova-3-medical` is the clinical-vocabulary variant. Both
/// accept `keyterm` and `diarize`. Deepgram's realtime `flux` model is
/// deliberately absent: it is a websocket conversational model and this
/// provider posts to the batch endpoint.
fn sanitize_deepgram_model_id(model_id: &str) -> &'static str {
    match model_id.trim() {
        "nova-3-medical" => "nova-3-medical",
        _ => "nova-3",
    }
}

/// Deepgram caps keyterm prompting at 500 tokens per request and returns an
/// error past that, so the cap is enforced here rather than discovered as a
/// failed transcription. Terms are counted the way the limit is described —
/// whitespace-separated tokens — and the budget is spent oldest-first, so a
/// long dictionary loses its tail rather than the whole request.
///
/// Terms containing a `&` or `=` would corrupt the query string; they are
/// dropped rather than escaped, because a keyterm is an accuracy aid and never
/// a precondition.
fn deepgram_keyterms(terms: &[String]) -> Vec<String> {
    const MAX_TOKENS: usize = 500;
    let mut budget = MAX_TOKENS;
    let mut accepted = Vec::new();
    for term in terms {
        let trimmed = term.trim();
        if trimmed.is_empty() || trimmed.contains('&') || trimmed.contains('=') {
            continue;
        }
        let tokens = trimmed.split_whitespace().count();
        if tokens == 0 || tokens > budget {
            continue;
        }
        budget -= tokens;
        accepted.push(trimmed.to_string());
    }
    accepted
}

/// Every query parameter the request carries, in a stable order so a test can
/// assert on the whole set rather than on the presence of one string.
///
/// `mip_opt_out` is unconditional; see the module doc. `smart_format` gives
/// punctuation, casing and number formatting, which every other route in this
/// app already produces. `utterances` is what turns word-level speaker labels
/// into turn-level segments the transcript viewer can group.
fn build_deepgram_query(
    model_id: &str,
    diarize: bool,
    keyterms: &[String],
    language: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut query: Vec<(&'static str, String)> = vec![
        ("model", model_id.to_string()),
        (
            "language",
            deepgram_language(model_id, language).to_string(),
        ),
        ("smart_format", "true".to_string()),
        ("utterances", "true".to_string()),
        ("mip_opt_out", "true".to_string()),
    ];
    if diarize {
        query.push(("diarize", "true".to_string()));
    }
    for term in keyterms {
        query.push(("keyterm", term.clone()));
    }
    query
}

/// `build_deepgram_query` rendered onto the listen endpoint with every value
/// percent-encoded. A keyterm is arbitrary text out of the user's personal
/// dictionary, so it is encoded by the URL parser rather than concatenated
/// into a query string by hand.
fn build_deepgram_url(
    model_id: &str,
    diarize: bool,
    keyterms: &[String],
    language: Option<&str>,
) -> Result<reqwest::Url> {
    let query = build_deepgram_query(model_id, diarize, keyterms, language);
    reqwest::Url::parse_with_params(DEEPGRAM_LISTEN_URL, &query)
        .context("Failed to build the Deepgram request URL")
}

/// The `language` value a request carries.
///
/// Deepgram's default when the parameter is absent is English, and nothing was
/// sending it -- so every request was English-only while the route advertised
/// itself as multilingual and the picker offered it to everyone. A French
/// meeting came back as English nonsense with nothing saying why.
///
/// `multi` is Nova-3's code-switching mode. It is not free: Deepgram prices
/// multilingual at $0.0052/min against $0.0043/min monolingual (fetched
/// 2026-09-02), so it is sent when the user's language setting says the audio
/// may not be English -- including "auto", because auto that quietly means
/// English is the bug this fixes -- and `en` when they have chosen English.
/// The route copy states both rates.
///
/// `nova-3-medical` is always asked for `en`: it is an English clinical model,
/// and asking it for a mode it does not offer would fail the request rather
/// than degrade. If that ever changes, the change belongs here.
pub(crate) fn deepgram_language(model_id: &str, selected: Option<&str>) -> &'static str {
    if model_id.trim() != "nova-3" {
        return "en";
    }
    let Some(selected) = selected.map(str::trim).filter(|value| !value.is_empty()) else {
        return "multi";
    };
    let primary = selected
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if primary == "en" {
        "en"
    } else {
        "multi"
    }
}

#[derive(Debug, Default, Deserialize)]
struct DeepgramResponse {
    results: Option<DeepgramResults>,
}

#[derive(Debug, Default, Deserialize)]
struct DeepgramResults {
    #[serde(default)]
    channels: Vec<DeepgramChannel>,
    #[serde(default)]
    utterances: Vec<DeepgramUtterance>,
}

#[derive(Debug, Default, Deserialize)]
struct DeepgramChannel {
    #[serde(default)]
    alternatives: Vec<DeepgramAlternative>,
    #[serde(default)]
    detected_language: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DeepgramAlternative {
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Deserialize)]
struct DeepgramWord {
    #[serde(default)]
    word: Option<String>,
    #[serde(default)]
    punctuated_word: Option<String>,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    speaker: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct DeepgramUtterance {
    start: f64,
    end: f64,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    speaker: Option<u32>,
}

/// What `parse_deepgram_transcript` could establish from one response. Every
/// field is what the payload actually carried; nothing is invented to fill a
/// gap.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ParsedDeepgramTranscript {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub speaker_turns: Vec<SpeakerTurn>,
    pub language: Option<String>,
    pub confidence: Option<f64>,
}

/// Turn a Deepgram batch payload into Plainsong's transcript shape.
///
/// Segment source, in order of preference:
///
/// 1. `results.utterances[]` — turn-level, which is what `utterances=true`
///    exists to produce and what the transcript viewer groups by.
/// 2. runs of consecutive words that share a speaker, when utterances are
///    absent but words are present.
/// 3. one segment spanning the whole transcript, when only `transcript` came
///    back.
///
/// Speaker turns come from whichever of the first two produced the segments,
/// and are empty when the response carried no `speaker` field at all —
/// `diarize` was off, or the model ignored it. An empty turn list is the
/// signal the meeting lane uses to fall back to local diarization, so it must
/// never be faked.
#[cfg(test)]
pub(crate) fn parse_deepgram_transcript(payload: &str) -> Result<ParsedDeepgramTranscript> {
    let response: DeepgramResponse =
        serde_json::from_str(payload).context("Failed to decode Deepgram transcription payload")?;
    Ok(parse_deepgram_response(response))
}

fn parse_deepgram_response(response: DeepgramResponse) -> ParsedDeepgramTranscript {
    let results = response.results.unwrap_or_default();
    let channel = results.channels.into_iter().next().unwrap_or_default();
    let language = channel
        .detected_language
        .and_then(|value| non_empty(value.trim()));
    let alternative = channel.alternatives.into_iter().next().unwrap_or_default();
    let text = alternative
        .transcript
        .unwrap_or_default()
        .trim()
        .to_string();
    let confidence = alternative.confidence;

    let mut segments = Vec::new();
    let mut speaker_turns = Vec::new();

    if !results.utterances.is_empty() {
        for utterance in &results.utterances {
            let utterance_text = utterance.transcript.trim();
            if utterance_text.is_empty() {
                continue;
            }
            let utterance_confidence = utterance.confidence.unwrap_or(0.9);
            segments.push(TranscriptSegment {
                start_time: utterance.start,
                end_time: utterance.end,
                text: utterance_text.to_string(),
                confidence: utterance_confidence,
            });
            if let Some(speaker) = utterance.speaker {
                speaker_turns.push(SpeakerTurn {
                    start_time: utterance.start,
                    end_time: utterance.end,
                    speaker_id: provider_speaker_id(speaker),
                    confidence: utterance_confidence,
                });
            }
        }
    } else if !alternative.words.is_empty() {
        for run in group_words_by_speaker(&alternative.words) {
            segments.push(TranscriptSegment {
                start_time: run.start,
                end_time: run.end,
                text: run.text.clone(),
                confidence: run.confidence,
            });
            if let Some(speaker) = run.speaker {
                speaker_turns.push(SpeakerTurn {
                    start_time: run.start,
                    end_time: run.end,
                    speaker_id: provider_speaker_id(speaker),
                    confidence: run.confidence,
                });
            }
        }
    } else if !text.is_empty() {
        segments.push(TranscriptSegment {
            start_time: 0.0,
            end_time: 0.0,
            text: text.clone(),
            confidence: confidence.unwrap_or(0.9),
        });
    }

    // The channel-level transcript is Deepgram's own joined text; only fall
    // back to re-joining the segments when it was absent.
    let text = if text.is_empty() {
        segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        text
    };

    ParsedDeepgramTranscript {
        text,
        segments,
        speaker_turns,
        language,
        confidence,
    }
}

struct WordRun {
    start: f64,
    end: f64,
    text: String,
    confidence: f64,
    speaker: Option<u32>,
}

/// Consecutive words that share a speaker become one segment. With no speaker
/// field at all this yields exactly one run, which is the right answer: an
/// un-diarized word list carries no boundary information Plainsong can use.
fn group_words_by_speaker(words: &[DeepgramWord]) -> Vec<WordRun> {
    let mut runs: Vec<WordRun> = Vec::new();
    for word in words {
        let text = word
            .punctuated_word
            .as_deref()
            .or(word.word.as_deref())
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        let confidence = word.confidence.unwrap_or(0.9);
        match runs.last_mut() {
            Some(run) if run.speaker == word.speaker => {
                run.end = word.end;
                run.text.push(' ');
                run.text.push_str(text);
                // Running mean, so one low-confidence word does not define the
                // whole turn and the last word does not overwrite the rest.
                let count = run.text.split_whitespace().count().max(1) as f64;
                run.confidence = run.confidence + (confidence - run.confidence) / count;
            }
            _ => runs.push(WordRun {
                start: word.start,
                end: word.end,
                text: text.to_string(),
                confidence,
                speaker: word.speaker,
            }),
        }
    }
    runs
}

fn non_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

impl Default for DeepgramProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

impl DeepgramProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_deepgram_model_id(selected_model_id.unwrap_or("nova-3")).to_string(),
            client: build_cloud_asr_client(DEEPGRAM_HTTP_TIMEOUTS),
            whole_file_client: build_cloud_asr_client(DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("deepgram") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("DEEPGRAM_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    fn selected_label(&self) -> &'static str {
        match self.model_id.as_str() {
            "nova-3-medical" => "Nova-3 Medical",
            _ => "Nova-3",
        }
    }

    async fn send(
        &self,
        client: &reqwest::Client,
        timeouts: CloudAsrHttpTimeouts,
        api_key: &str,
        options: &TranscriptionOptions,
        body: reqwest::Body,
    ) -> Result<(ParsedDeepgramTranscript, usize)> {
        let keyterms = options
            .vocabulary_hint
            .as_ref()
            .map(|hint| deepgram_keyterms(hint.terms()))
            .unwrap_or_default();
        let url = build_deepgram_url(
            &self.model_id,
            options.request_speaker_labels,
            &keyterms,
            options.language.as_deref(),
        )?;
        let response = client
            .post(url)
            .header(reqwest::header::AUTHORIZATION, format!("Token {api_key}"))
            .header(reqwest::header::CONTENT_TYPE, "audio/wav")
            .body(body)
            .timeout(timeouts.total)
            .send()
            .await
            .context("Deepgram API request failed")?;

        if !response.status().is_success() {
            // The response is handed over whole, so its body cannot reach the
            // error message even by accident. See `cloud_asr_response_error`.
            return Err(cloud_asr_response_error("Deepgram", response));
        }

        let payload: serde_json::Value = read_cloud_asr_json(response, "Deepgram").await?;
        let parsed = parse_deepgram_response(
            serde_json::from_value(payload).context("Failed to decode Deepgram payload")?,
        );
        Ok((parsed, keyterms.len()))
    }

    fn finish(
        &self,
        parsed: ParsedDeepgramTranscript,
        vocabulary_hint_terms_applied: usize,
        elapsed_ms: u64,
    ) -> TranscriptionResult {
        let confidence = parsed.confidence.unwrap_or(0.92);
        TranscriptionResult {
            text: parsed.text,
            segments: parsed.segments,
            speaker_turns: parsed.speaker_turns,
            language: parsed.language.unwrap_or_else(|| "auto".to_string()),
            confidence,
            processing_time_ms: elapsed_ms,
            model_name: format!("Deepgram {}", self.selected_label()),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Deepgram,
            actual_provider: AsrProviderType::Deepgram,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied,
        }
    }

    async fn transcribe_impl(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context(
            "Deepgram API key not set. Add it in Settings → API Keys or set DEEPGRAM_API_KEY.",
        )?;
        let start = std::time::Instant::now();
        let (parsed, keyterm_count) = self
            .send(
                &self.client,
                DEEPGRAM_HTTP_TIMEOUTS,
                &api_key,
                options,
                reqwest::Body::from(audio_data.to_vec()),
            )
            .await?;
        Ok(self.finish(parsed, keyterm_count, start.elapsed().as_millis() as u64))
    }
}

#[async_trait]
impl AsrProvider for DeepgramProvider {
    fn name(&self) -> &str {
        "Deepgram Nova"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via Deepgram's Nova-3 batch API. Returns speaker labels and \
         word timestamps, and accepts keyterm prompting from your personal dictionary. \
         With the transcription language set to English it uses Deepgram's English model \
         ($0.0043/min); on any other setting, including auto, it asks Nova-3 to \
         code-switch, which Deepgram prices at $0.0052/min. Nova-3 Medical is English-only. \
         Every request opts out of Deepgram's model improvement programme. \
         Requires DEEPGRAM_API_KEY from https://console.deepgram.com"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: format!("Deepgram {}", self.selected_label()),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            word_error_rate: None,
            // Deepgram publishes 607.7x real time for Nova-3 on Artificial
            // Analysis (fetched 2026-09-02); real_time_factor is its inverse.
            real_time_factor: Some(1.0 / 607.7),
            license: "Commercial API".to_string(),
            source_url: "https://developers.deepgram.com/docs/pre-recorded-audio".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        // The whole-file path exists for the meeting lane, which is the only
        // caller that wants speaker labels. A caller that has real options
        // goes through `transcribe_path_with_options` instead.
        self.transcribe_path_with_options(
            audio_path,
            &TranscriptionOptions {
                request_speaker_labels: true,
                ..TranscriptionOptions::default()
            },
        )
        .await
    }

    /// The whole-recording meeting route, with the caller's options.
    ///
    /// The options used to be discarded on this path, so the language never
    /// arrived and a keyterm list could not have arrived even if the meeting
    /// lane built one.
    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context(
            "Deepgram API key not set. Add it in Settings → API Keys or set DEEPGRAM_API_KEY.",
        )?;
        let start = std::time::Instant::now();
        // Streamed rather than read into a `Vec`: see `streaming_wav_body`.
        // Deepgram's batch endpoint accepts the resulting chunked request, so
        // the declared length is not needed here.
        let (body, _byte_len) = super::streaming_wav_body(audio_path).await?;
        let (parsed, keyterm_count) = self
            .send(
                &self.whole_file_client,
                DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS,
                &api_key,
                options,
                body,
            )
            .await?;
        Ok(self.finish(parsed, keyterm_count, start.elapsed().as_millis() as u64))
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
        build_deepgram_query, deepgram_keyterms, deepgram_language, parse_deepgram_transcript,
        sanitize_deepgram_model_id, DeepgramProvider, DEEPGRAM_HTTP_TIMEOUTS,
        DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS,
    };
    use crate::asr::AsrProvider;
    use std::time::Duration;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn deepgram_clients_have_bounded_timeouts() {
        assert_eq!(DEEPGRAM_HTTP_TIMEOUTS.connect, Duration::from_secs(10));
        assert_eq!(DEEPGRAM_HTTP_TIMEOUTS.total, Duration::from_secs(60));
        assert!(DEEPGRAM_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
        // The whole-file profile is deliberately longer than the dictation
        // one, but still bounded -- an unanswered meeting upload must fail,
        // not hang forever.
        assert!(DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS.total > DEEPGRAM_HTTP_TIMEOUTS.total);
        assert_eq!(
            DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS.total,
            Duration::from_secs(15 * 60)
        );
        assert!(DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS.read < DEEPGRAM_WHOLE_FILE_HTTP_TIMEOUTS.total);
    }

    #[test]
    fn only_batch_models_reach_the_listen_endpoint() {
        assert_eq!(sanitize_deepgram_model_id("nova-3"), "nova-3");
        assert_eq!(
            sanitize_deepgram_model_id("nova-3-medical"),
            "nova-3-medical"
        );
        // flux is Deepgram's websocket conversational model; this provider
        // posts to the batch endpoint, which cannot serve it.
        assert_eq!(sanitize_deepgram_model_id("flux"), "nova-3");
        assert_eq!(sanitize_deepgram_model_id(""), "nova-3");
        assert_eq!(sanitize_deepgram_model_id("garbage"), "nova-3");
        assert_eq!(DeepgramProvider::new(None).model_info().version, "nova-3");
        assert_eq!(
            DeepgramProvider::new(Some("flux")).model_info().version,
            "nova-3"
        );
    }

    #[test]
    fn every_request_opts_out_of_the_model_improvement_programme() {
        for diarize in [true, false] {
            for model in ["nova-3", "nova-3-medical"] {
                let query = build_deepgram_query(model, diarize, &[], None);
                assert!(
                    query.contains(&("mip_opt_out", "true".to_string())),
                    "mip_opt_out missing for model={model} diarize={diarize}"
                );
            }
        }
    }

    #[test]
    fn query_carries_diarization_formatting_and_utterances() {
        let query = build_deepgram_query(
            "nova-3",
            true,
            &strings(&["Plainsong", "neume"]),
            Some("en"),
        );
        assert_eq!(
            query,
            vec![
                ("model", "nova-3".to_string()),
                ("language", "en".to_string()),
                ("smart_format", "true".to_string()),
                ("utterances", "true".to_string()),
                ("mip_opt_out", "true".to_string()),
                ("diarize", "true".to_string()),
                ("keyterm", "Plainsong".to_string()),
                ("keyterm", "neume".to_string()),
            ]
        );

        let undiarized = build_deepgram_query("nova-3", false, &[], None);
        assert!(!undiarized.iter().any(|(name, _)| *name == "diarize"));
    }

    /// Deepgram's default with no `language` parameter is English, so a route
    /// that sent none was English-only while `model_info().languages` claimed
    /// multilingual and the picker offered it to everyone.
    #[test]
    fn the_request_states_a_language_instead_of_letting_deepgram_assume_english() {
        // Every request carries one, whatever the caller asked for.
        for model in ["nova-3", "nova-3-medical"] {
            for language in [None, Some("en"), Some("fr")] {
                let query = build_deepgram_query(model, false, &[], language);
                assert!(
                    query.iter().any(|(name, _)| *name == "language"),
                    "no language for model={model} language={language:?}"
                );
            }
        }

        // Auto is not English: it is exactly the case where the audio may not
        // be, so Nova-3 is asked to code-switch.
        assert_eq!(deepgram_language("nova-3", None), "multi");
        assert_eq!(deepgram_language("nova-3", Some("")), "multi");
        assert_eq!(deepgram_language("nova-3", Some("  ")), "multi");
        assert_eq!(deepgram_language("nova-3", Some("fr")), "multi");
        assert_eq!(deepgram_language("nova-3", Some("pt-BR")), "multi");

        // A user who chose English gets the monolingual model, which is also
        // the cheaper one ($0.0043/min against $0.0052/min).
        assert_eq!(deepgram_language("nova-3", Some("en")), "en");
        assert_eq!(deepgram_language("nova-3", Some("en-US")), "en");
        assert_eq!(deepgram_language("nova-3", Some("EN_gb")), "en");

        // The clinical model is English-only, so it is never asked for a mode
        // it does not offer -- that would fail the request, not degrade it.
        for language in [None, Some("fr"), Some("en")] {
            assert_eq!(deepgram_language("nova-3-medical", language), "en");
        }
    }

    #[test]
    fn keyterms_stay_inside_deepgrams_five_hundred_token_budget() {
        let long: Vec<String> =
            std::iter::repeat_n("one two three four five".to_string(), 200).collect();
        let accepted = deepgram_keyterms(&long);
        let tokens: usize = accepted
            .iter()
            .map(|term| term.split_whitespace().count())
            .sum();
        assert!(tokens <= 500, "budget exceeded: {tokens}");
        assert_eq!(accepted.len(), 100);
    }

    #[test]
    fn keyterms_that_would_corrupt_the_query_string_are_dropped_not_fatal() {
        let accepted = deepgram_keyterms(&strings(&[
            "Plainsong",
            "  neume  ",
            "",
            "a&b",
            "c=d",
            "Kubernetes",
        ]));
        assert_eq!(accepted, strings(&["Plainsong", "neume", "Kubernetes"]));
    }

    // Response shape from https://developers.deepgram.com/docs/diarization and
    // https://developers.deepgram.com/docs/pre-recorded-audio (2026-09-02),
    // trimmed to the fields this provider reads.
    const SAMPLE_DIARIZED_RESPONSE: &str = r#"{
      "metadata": { "request_id": "abc", "duration": 6.2, "channels": 1 },
      "results": {
        "channels": [{
          "detected_language": "en",
          "alternatives": [{
            "transcript": "Yeah. As as much as it's worth celebrating.",
            "confidence": 0.97,
            "words": [
              { "word": "yeah", "punctuated_word": "Yeah.", "start": 0.08, "end": 0.32, "confidence": 0.99, "speaker": 0 },
              { "word": "as", "punctuated_word": "As", "start": 1.2, "end": 1.4, "confidence": 0.95, "speaker": 1 }
            ]
          }]
        }],
        "utterances": [
          { "start": 0.08, "end": 0.32, "confidence": 0.99, "transcript": "Yeah.", "speaker": 0 },
          { "start": 1.2, "end": 3.4, "confidence": 0.95, "transcript": "As as much as it's worth celebrating.", "speaker": 1 }
        ]
      }
    }"#;

    #[test]
    fn utterances_become_segments_and_speaker_turns() {
        let parsed = parse_deepgram_transcript(SAMPLE_DIARIZED_RESPONSE).expect("parses");

        assert_eq!(parsed.text, "Yeah. As as much as it's worth celebrating.");
        assert_eq!(parsed.language.as_deref(), Some("en"));
        assert_eq!(parsed.confidence, Some(0.97));

        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.segments[0].text, "Yeah.");
        assert_eq!(parsed.segments[1].start_time, 1.2);
        assert_eq!(parsed.segments[1].end_time, 3.4);

        // Deepgram numbers speakers from zero; Plainsong's whole UI, alias flow
        // and local diarizer use S1/S2.
        assert_eq!(parsed.speaker_turns.len(), 2);
        assert_eq!(parsed.speaker_turns[0].speaker_id, "S1");
        assert_eq!(parsed.speaker_turns[1].speaker_id, "S2");
        assert_eq!(parsed.speaker_turns[1].start_time, 1.2);
    }

    #[test]
    fn words_group_by_speaker_when_utterances_are_absent() {
        let payload = r#"{
          "results": {
            "channels": [{
              "alternatives": [{
                "transcript": "Hello there friend",
                "words": [
                  { "punctuated_word": "Hello", "start": 0.0, "end": 0.4, "confidence": 0.9, "speaker": 0 },
                  { "punctuated_word": "there", "start": 0.4, "end": 0.8, "confidence": 0.9, "speaker": 0 },
                  { "punctuated_word": "friend", "start": 1.0, "end": 1.4, "confidence": 0.8, "speaker": 1 }
                ]
              }]
            }]
          }
        }"#;
        let parsed = parse_deepgram_transcript(payload).expect("parses");
        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.segments[0].text, "Hello there");
        assert_eq!(parsed.segments[1].text, "friend");
        assert_eq!(parsed.speaker_turns.len(), 2);
        assert_eq!(parsed.speaker_turns[0].speaker_id, "S1");
        assert_eq!(parsed.speaker_turns[1].speaker_id, "S2");
    }

    #[test]
    fn an_undiarized_response_reports_no_speaker_turns_rather_than_inventing_one() {
        // This is the signal the meeting lane uses to fall back to local
        // diarization, so it has to stay empty rather than default to "S1".
        let payload = r#"{
          "results": {
            "channels": [{
              "alternatives": [{
                "transcript": "One speaker, no labels.",
                "confidence": 0.91,
                "words": [
                  { "punctuated_word": "One", "start": 0.0, "end": 0.3 },
                  { "punctuated_word": "speaker,", "start": 0.3, "end": 0.7 }
                ]
              }]
            }]
          }
        }"#;
        let parsed = parse_deepgram_transcript(payload).expect("parses");
        assert!(parsed.speaker_turns.is_empty());
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].text, "One speaker,");
    }

    #[test]
    fn an_empty_response_is_empty_not_an_error() {
        let parsed = parse_deepgram_transcript(r#"{"metadata":{}}"#).expect("parses");
        assert_eq!(parsed.text, "");
        assert!(parsed.segments.is_empty());
        assert!(parsed.speaker_turns.is_empty());
        assert_eq!(parsed.language, None);
    }

    #[test]
    fn malformed_json_is_rejected_without_echoing_the_body() {
        let error = parse_deepgram_transcript("{ not json").expect_err("must fail");
        let rendered = format!("{error:#}");
        assert!(rendered.contains("Deepgram"));
        assert!(!rendered.contains("not json"));
    }

    /// A real 401 whose body carries the marker, because the previous version
    /// of this test built no response at all and so could not have failed.
    #[tokio::test]
    async fn provider_status_errors_never_include_response_body_content() {
        let response = crate::asr::cloud_asr_error_response_fixture(401, "Unauthorized").await;
        let error = super::cloud_asr_response_error("Deepgram", response);
        let rendered = format!("{error:#}");
        assert!(rendered.contains("Deepgram"));
        assert!(rendered.contains("401"));
        assert!(
            !rendered.contains(crate::asr::CLOUD_ASR_BODY_MARKER),
            "Deepgram's error body reached the message: {rendered}"
        );
        assert_eq!(rendered, "Deepgram API returned HTTP 401");
    }
}
