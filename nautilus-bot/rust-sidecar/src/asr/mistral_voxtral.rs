//! Mistral Voxtral ASR provider — cloud speech-to-text over the batch
//! `/v1/audio/transcriptions` endpoint.
//!
//! Verified against <https://docs.mistral.ai/capabilities/audio/speech_to_text/offline_transcription>
//! and <https://mistral.ai/news/voxtral-transcribe-2/> on 2026-09-03. Research
//! write-up and the measurements that put this route here rather than a local
//! Voxtral: `artifacts/qa/model-selection-2026-09-03.md`.
//!
//! Four things about this endpoint shape the code below:
//!
//! 1. It is **multipart/form-data**, not a raw body — so the meeting lane's
//!    whole-recording upload streams the WAV into one multipart part rather
//!    than reading a several-hundred-megabyte file into memory.
//! 2. `timestamp_granularities` and `language` are **mutually exclusive**
//!    ("currently not compatible", Mistral's own docs, fetched 2026-09-03).
//!    The meeting lane needs timestamps, so a meeting request cannot carry the
//!    user's chosen language and must auto-detect; dictation, which needs no
//!    timestamps, sends the language. This is the same shape as the Gemini
//!    vocabulary/timestamp exclusion already documented in
//!    `docs/model-inventory-2026-09.md` §2.2, and it is handled the same way:
//!    in one pure function with a test, not discovered as a 400.
//! 3. Speaker labels arrive on **segments** (`segments[].speaker`), not on
//!    words — unlike Deepgram. They are surfaced as
//!    `TranscriptionResult::speaker_turns` and never merged into the segment
//!    text here.
//! 4. `context_bias` is Voxtral's vocabulary-hint field, capped by Mistral at
//!    100 terms. The cap is enforced here rather than discovered as a rejected
//!    request.

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

const MISTRAL_TRANSCRIPTIONS_URL: &str = "https://api.mistral.ai/v1/audio/transcriptions";

/// The batch model this provider sends. `voxtral-mini-2602` is the pinned
/// snapshot behind Mistral's `voxtral-mini-latest` alias for Voxtral Mini
/// Transcribe 2; the alias is deliberately not used, for the same reason no
/// other model download in this app points at a moving target.
pub const VOXTRAL_MINI_TRANSCRIBE_MODEL_ID: &str = "voxtral-mini-2602";

/// Dictation-shaped requests: a few seconds of audio already in memory. Kept
/// in line with the other cloud providers so a hung provider cannot hold a
/// dictation session open to IPC's five-minute deadline.
const MISTRAL_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(45),
    total: Duration::from_secs(60),
};

/// Whole-recording requests from the meeting lane. Mistral accepts up to three
/// hours per request, which is a large upload before a word comes back, so the
/// dictation ceiling would fail every long meeting on the upload alone. Still
/// bounded: a meeting that has not answered in fifteen minutes has failed, and
/// the meeting lane falls back to chunked transcription with Plainsong's own
/// diarizer.
const MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(15),
    read: Duration::from_secs(10 * 60),
    total: Duration::from_secs(15 * 60),
};

/// Mistral's documented ceiling on `context_bias`: "up to 100 words or
/// phrases".
const MAX_CONTEXT_BIAS_TERMS: usize = 100;

pub struct MistralVoxtralProvider {
    model_id: String,
    client: reqwest::Client,
    whole_file_client: reqwest::Client,
}

/// Only the batch transcription model reaches this endpoint.
///
/// `voxtral-mini-realtime-2602` is Mistral's websocket realtime model; it is a
/// different endpoint, it cannot diarize (Mistral: "Realtime transcription is
/// not compatible with the `diarize` parameter"), and this provider posts to
/// the batch one. `voxtral-mini-2507` is the deprecated v25.07 predecessor.
/// Anything unrecognised, including the moving `voxtral-mini-latest` alias,
/// normalizes to the pinned snapshot. Model names verified against
/// <https://docs.mistral.ai/models/> on 2026-09-03.
pub(crate) fn sanitize_mistral_model_id(model_id: &str) -> &'static str {
    match model_id.trim() {
        VOXTRAL_MINI_TRANSCRIBE_MODEL_ID => VOXTRAL_MINI_TRANSCRIBE_MODEL_ID,
        _ => VOXTRAL_MINI_TRANSCRIBE_MODEL_ID,
    }
}

/// The `context_bias` terms a request carries.
///
/// Mistral caps the list at 100 entries and describes the feature as
/// "optimized for English; support for other languages is experimental", so
/// this is an accuracy aid and never a precondition: an over-long dictionary
/// loses its tail rather than failing the request, and blank entries are
/// dropped. Unlike Deepgram's keyterms these travel as multipart fields, so no
/// character needs escaping.
pub(crate) fn mistral_context_bias(terms: &[String]) -> Vec<String> {
    terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .take(MAX_CONTEXT_BIAS_TERMS)
        .map(str::to_string)
        .collect()
}

/// What one request may ask for, given what the caller wants.
///
/// Mistral's docs state plainly that `timestamp_granularities` "is currently
/// not compatible with `language`". The meeting lane needs timed segments to
/// offset and merge, and speaker turns are worthless without them; dictation
/// needs neither. So:
///
/// - a request that wants speaker labels asks for segment timestamps and sends
///   no language, accepting Voxtral's own language detection;
/// - every other request sends the user's language and no timestamps.
///
/// Returning the decision as a value, rather than branching inside the request
/// builder, is what lets a test assert that the two fields never travel
/// together — which is the whole point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MistralRequestShape {
    /// `["segment"]` when timestamps were asked for, empty otherwise.
    pub timestamp_granularities: Vec<&'static str>,
    /// The `language` form field, or `None` when timestamps took its slot.
    pub language: Option<String>,
    pub diarize: bool,
}

pub(crate) fn mistral_request_shape(
    request_speaker_labels: bool,
    selected_language: Option<&str>,
) -> MistralRequestShape {
    if request_speaker_labels {
        return MistralRequestShape {
            timestamp_granularities: vec!["segment"],
            language: None,
            diarize: true,
        };
    }
    MistralRequestShape {
        timestamp_granularities: Vec::new(),
        language: selected_language
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        diarize: false,
    }
}

#[derive(Debug, Default, Deserialize)]
struct MistralTranscriptionResponse {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    segments: Vec<MistralSegment>,
}

#[derive(Debug, Deserialize)]
struct MistralSegment {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
    #[serde(default)]
    speaker: Option<serde_json::Value>,
}

/// What `parse_mistral_transcript` could establish from one response. Every
/// field is what the payload actually carried; nothing is invented to fill a
/// gap.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ParsedMistralTranscript {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub speaker_turns: Vec<SpeakerTurn>,
    pub language: Option<String>,
}

/// Voxtral reports no per-token or per-segment probability, so there is no
/// measured confidence to pass on. This is the placeholder the transcript
/// quality score reads, chosen to match the other cloud routes that also
/// report nothing.
const UNSCORED_CLOUD_CONFIDENCE: f64 = 0.92;

/// Mistral labels speakers as strings (`"speaker_0"`, `"A"`, or a bare
/// integer in some payloads). Plainsong's contract is `S1`, `S2`, … in
/// first-appearance order, which is what the rename/alias flow and the meeting
/// header already work on, so labels are mapped through an appearance table
/// rather than parsed. A payload that numbers speakers differently between two
/// requests therefore cannot leak its numbering into the transcript.
fn speaker_label(raw: &serde_json::Value, seen: &mut Vec<String>) -> String {
    let key = match raw {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => String::new(),
    };
    if let Some(index) = seen.iter().position(|existing| existing == &key) {
        return provider_speaker_id(index as u32);
    }
    seen.push(key);
    provider_speaker_id((seen.len() - 1) as u32)
}

#[cfg(test)]
pub(crate) fn parse_mistral_transcript(payload: &str) -> Result<ParsedMistralTranscript> {
    let response: MistralTranscriptionResponse =
        serde_json::from_str(payload).context("Failed to decode Mistral transcription payload")?;
    Ok(parse_mistral_response(response))
}

fn parse_mistral_response(response: MistralTranscriptionResponse) -> ParsedMistralTranscript {
    let text = response.text.unwrap_or_default().trim().to_string();
    let language = response
        .language
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut speaker_turns: Vec<SpeakerTurn> = Vec::new();
    let mut seen_speakers: Vec<String> = Vec::new();

    for segment in &response.segments {
        let segment_text = segment.text.trim();
        if segment_text.is_empty() {
            continue;
        }
        // A segment with no times is text, not a timed row. Collapsing it to
        // 0.0 would put it at the start of the meeting timeline, so it is
        // clamped to a non-negative, non-backwards span instead.
        let start = segment
            .start
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
            .max(0.0);
        let end = segment
            .end
            .filter(|value| value.is_finite())
            .unwrap_or(start)
            .max(start);
        segments.push(TranscriptSegment {
            start_time: start,
            end_time: end,
            text: segment_text.to_string(),
            confidence: UNSCORED_CLOUD_CONFIDENCE,
        });
        if let Some(raw) = segment.speaker.as_ref() {
            let speaker_id = speaker_label(raw, &mut seen_speakers);
            speaker_turns.push(SpeakerTurn {
                start_time: start,
                end_time: end,
                speaker_id,
                confidence: UNSCORED_CLOUD_CONFIDENCE,
            });
        }
    }

    // A response with no segments at all (the dictation shape, where no
    // timestamps were requested) still has to yield one segment, the way every
    // other route does, or the meeting view renders an empty transcript for a
    // non-empty decode.
    if segments.is_empty() && !text.is_empty() {
        segments.push(TranscriptSegment {
            start_time: 0.0,
            end_time: 0.0,
            text: text.clone(),
            confidence: UNSCORED_CLOUD_CONFIDENCE,
        });
    }

    let text = if text.is_empty() {
        segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        text
    };

    ParsedMistralTranscript {
        text,
        segments,
        speaker_turns,
        language,
    }
}

impl Default for MistralVoxtralProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

impl MistralVoxtralProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_mistral_model_id(
                selected_model_id.unwrap_or(VOXTRAL_MINI_TRANSCRIBE_MODEL_ID),
            )
            .to_string(),
            client: build_cloud_asr_client(MISTRAL_HTTP_TIMEOUTS),
            whole_file_client: build_cloud_asr_client(MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("mistral") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("MISTRAL_API_KEY")
                .ok()
                .filter(|key| !key.is_empty()),
        }
    }

    /// The form every request shares, minus the audio part.
    fn build_form(&self, options: &TranscriptionOptions) -> (reqwest::multipart::Form, usize) {
        let shape =
            mistral_request_shape(options.request_speaker_labels, options.language.as_deref());
        let mut form = reqwest::multipart::Form::new().text("model", self.model_id.clone());
        for granularity in &shape.timestamp_granularities {
            // Mistral's array form field carries the PHP-style bracket suffix.
            form = form.text("timestamp_granularities[]", *granularity);
        }
        if let Some(language) = shape.language {
            form = form.text("language", language);
        }
        if shape.diarize {
            form = form.text("diarize", "true");
        }

        let terms = options
            .vocabulary_hint
            .as_ref()
            .map(|hint| mistral_context_bias(hint.terms()))
            .unwrap_or_default();
        for term in &terms {
            form = form.text("context_bias[]", term.clone());
        }
        (form, terms.len())
    }

    async fn send(
        &self,
        client: &reqwest::Client,
        timeouts: CloudAsrHttpTimeouts,
        api_key: &str,
        form: reqwest::multipart::Form,
    ) -> Result<ParsedMistralTranscript> {
        let response = client
            .post(MISTRAL_TRANSCRIPTIONS_URL)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
            .multipart(form)
            .timeout(timeouts.total)
            .send()
            .await
            .context("Mistral transcription request failed")?;

        if !response.status().is_success() {
            // The response is handed over whole, so its body cannot reach the
            // error message even by accident. See `cloud_asr_response_error`.
            return Err(cloud_asr_response_error("Mistral Voxtral", response));
        }

        let payload: serde_json::Value = read_cloud_asr_json(response, "Mistral Voxtral").await?;
        Ok(parse_mistral_response(
            serde_json::from_value(payload).context("Failed to decode Mistral payload")?,
        ))
    }

    fn finish(
        &self,
        parsed: ParsedMistralTranscript,
        vocabulary_hint_terms_applied: usize,
        elapsed_ms: u64,
    ) -> TranscriptionResult {
        TranscriptionResult {
            text: parsed.text,
            segments: parsed.segments,
            speaker_turns: parsed.speaker_turns,
            language: parsed.language.unwrap_or_else(|| "auto".to_string()),
            confidence: UNSCORED_CLOUD_CONFIDENCE,
            processing_time_ms: elapsed_ms,
            model_name: "Mistral Voxtral Mini Transcribe 2".to_string(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::MistralVoxtral,
            actual_provider: AsrProviderType::MistralVoxtral,
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
            "Mistral API key not set. Add it in Settings → API Keys or set MISTRAL_API_KEY.",
        )?;
        let start = std::time::Instant::now();
        let (form, term_count) = self.build_form(options);
        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let parsed = self
            .send(
                &self.client,
                MISTRAL_HTTP_TIMEOUTS,
                &api_key,
                form.part("file", part),
            )
            .await?;
        Ok(self.finish(parsed, term_count, start.elapsed().as_millis() as u64))
    }
}

#[async_trait]
impl AsrProvider for MistralVoxtralProvider {
    fn name(&self) -> &str {
        "Mistral Voxtral"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via Mistral's Voxtral Mini Transcribe 2 batch API, at \
         $0.003/min — the cheapest cloud route in Plainsong that returns speaker labels. \
         13 languages, segment timestamps, and context biasing from your personal \
         dictionary (up to 100 terms). Mistral's API does not accept a language and \
         timestamps on the same request, so meetings auto-detect the language and \
         dictation sends the one you chose. \
         Requires MISTRAL_API_KEY from https://console.mistral.ai"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Mistral Voxtral Mini Transcribe 2".to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            // Artificial Analysis non-streaming board, fetched 2026-09-03:
            // Voxtral Mini Transcribe 2 scores 3.59% AA-WER at 83.3x real
            // time. `real_time_factor` is the inverse of that speed factor.
            word_error_rate: Some(0.0359),
            real_time_factor: Some(1.0 / 83.3),
            license: "Commercial API".to_string(),
            source_url:
                "https://docs.mistral.ai/capabilities/audio/speech_to_text/offline_transcription"
                    .to_string(),
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
    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context(
            "Mistral API key not set. Add it in Settings → API Keys or set MISTRAL_API_KEY.",
        )?;
        let start = std::time::Instant::now();
        let (form, term_count) = self.build_form(options);
        // Streamed rather than read into a `Vec`: a two-hour meeting is
        // several hundred megabytes, and the multipart part takes a body with
        // a declared length so the request stays content-length delimited.
        let (body, byte_len) = super::streaming_wav_body(audio_path).await?;
        let part = reqwest::multipart::Part::stream_with_length(body, byte_len)
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let parsed = self
            .send(
                &self.whole_file_client,
                MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS,
                &api_key,
                form.part("file", part),
            )
            .await?;
        Ok(self.finish(parsed, term_count, start.elapsed().as_millis() as u64))
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

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn mistral_clients_have_bounded_timeouts() {
        assert_eq!(MISTRAL_HTTP_TIMEOUTS.connect, Duration::from_secs(10));
        assert_eq!(MISTRAL_HTTP_TIMEOUTS.total, Duration::from_secs(60));
        assert!(MISTRAL_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
        // The whole-file profile is deliberately longer than the dictation
        // one, but still bounded -- an unanswered meeting upload must fail,
        // not hang forever.
        assert!(MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS.total > MISTRAL_HTTP_TIMEOUTS.total);
        assert_eq!(
            MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS.total,
            Duration::from_secs(15 * 60)
        );
        assert!(MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS.read < MISTRAL_WHOLE_FILE_HTTP_TIMEOUTS.total);
    }

    #[test]
    fn only_the_batch_model_reaches_the_transcriptions_endpoint() {
        assert_eq!(
            sanitize_mistral_model_id(VOXTRAL_MINI_TRANSCRIBE_MODEL_ID),
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
        // The realtime model is a websocket route that cannot diarize; this
        // provider posts to the batch endpoint, which cannot serve it.
        assert_eq!(
            sanitize_mistral_model_id("voxtral-mini-realtime-2602"),
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
        // The deprecated v25.07 predecessor.
        assert_eq!(
            sanitize_mistral_model_id("voxtral-mini-2507"),
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
        // The moving alias normalizes to the pinned snapshot.
        assert_eq!(
            sanitize_mistral_model_id("voxtral-mini-latest"),
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
        assert_eq!(
            sanitize_mistral_model_id(""),
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
        assert_eq!(
            MistralVoxtralProvider::new(Some("voxtral-mini-realtime-2602"))
                .model_info()
                .version,
            VOXTRAL_MINI_TRANSCRIBE_MODEL_ID
        );
    }

    /// The constraint that would otherwise be discovered as an HTTP 400:
    /// Mistral rejects `timestamp_granularities` and `language` on the same
    /// request.
    #[test]
    fn a_request_never_carries_both_timestamps_and_a_language() {
        for language in [None, Some("en"), Some("fr-FR"), Some("  ")] {
            for speaker_labels in [true, false] {
                let shape = mistral_request_shape(speaker_labels, language);
                assert!(
                    shape.timestamp_granularities.is_empty() || shape.language.is_none(),
                    "timestamps and language travelled together for {language:?}/{speaker_labels}"
                );
            }
        }
    }

    #[test]
    fn a_meeting_request_asks_for_segments_and_speakers_and_drops_the_language() {
        let shape = mistral_request_shape(true, Some("fr"));
        assert_eq!(shape.timestamp_granularities, vec!["segment"]);
        assert!(shape.diarize);
        // The language is what Mistral's exclusion costs. Voxtral detects it.
        assert_eq!(shape.language, None);
    }

    #[test]
    fn a_dictation_request_keeps_the_language_and_asks_for_no_timestamps() {
        let shape = mistral_request_shape(false, Some("de"));
        assert!(shape.timestamp_granularities.is_empty());
        assert!(!shape.diarize);
        assert_eq!(shape.language.as_deref(), Some("de"));
        // Blank and absent both mean "auto"; neither may become a form field.
        assert_eq!(mistral_request_shape(false, Some("   ")).language, None);
        assert_eq!(mistral_request_shape(false, None).language, None);
    }

    #[test]
    fn context_bias_is_capped_at_the_documented_hundred_terms() {
        let many: Vec<String> = (0..250).map(|index| format!("term{index}")).collect();
        let accepted = mistral_context_bias(&many);
        assert_eq!(accepted.len(), MAX_CONTEXT_BIAS_TERMS);
        // Oldest-first, so a long dictionary loses its tail rather than its head.
        assert_eq!(accepted[0], "term0");
        assert_eq!(accepted[99], "term99");
        // Blank entries never become a form field.
        assert_eq!(
            mistral_context_bias(&strings(&["  ", "Plainsong", ""])),
            strings(&["Plainsong"])
        );
    }

    #[test]
    fn a_diarized_payload_becomes_segments_and_speaker_turns() {
        let parsed = parse_mistral_transcript(
            r#"{
              "text": "Hello there. General Kenobi.",
              "language": "en",
              "segments": [
                {"id": 0, "text": "Hello there.", "start": 0.0, "end": 1.5, "speaker": "speaker_1"},
                {"id": 1, "text": "General Kenobi.", "start": 1.5, "end": 3.0, "speaker": "speaker_0"},
                {"id": 2, "text": "Indeed.", "start": 3.0, "end": 4.0, "speaker": "speaker_1"}
              ]
            }"#,
        )
        .expect("payload parses");
        assert_eq!(parsed.text, "Hello there. General Kenobi.");
        assert_eq!(parsed.language.as_deref(), Some("en"));
        assert_eq!(parsed.segments.len(), 3);
        assert_eq!(parsed.segments[0].start_time, 0.0);
        assert_eq!(parsed.segments[1].end_time, 3.0);
        // Renumbered in first-appearance order, so the provider's own
        // numbering never reaches the transcript.
        let ids: Vec<&str> = parsed
            .speaker_turns
            .iter()
            .map(|turn| turn.speaker_id.as_str())
            .collect();
        assert_eq!(ids, vec!["S1", "S2", "S1"]);
    }

    #[test]
    fn a_dictation_payload_with_no_segments_still_yields_one() {
        let parsed = parse_mistral_transcript(r#"{"text":"Just the words.","language":"en"}"#)
            .expect("payload parses");
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].text, "Just the words.");
        // No `speaker` field anywhere means no speaker turns, which is the
        // signal the meeting lane uses to fall back to local diarization. It
        // must never be faked.
        assert!(parsed.speaker_turns.is_empty());
    }

    #[test]
    fn an_undiarized_segment_list_produces_no_speaker_turns() {
        let parsed = parse_mistral_transcript(
            r#"{"text":"One two.","segments":[{"text":"One two.","start":0.0,"end":1.0}]}"#,
        )
        .expect("payload parses");
        assert_eq!(parsed.segments.len(), 1);
        assert!(parsed.speaker_turns.is_empty());
        assert_eq!(parsed.language, None);
    }

    #[test]
    fn a_segment_with_missing_or_backwards_times_never_produces_a_backwards_span() {
        let parsed = parse_mistral_transcript(
            r#"{"text":"a b","segments":[
                 {"text":"a","start":5.0,"end":2.0},
                 {"text":"b"}
               ]}"#,
        )
        .expect("payload parses");
        assert_eq!(parsed.segments[0].start_time, 5.0);
        assert_eq!(parsed.segments[0].end_time, 5.0);
        assert_eq!(parsed.segments[1].start_time, 0.0);
        assert_eq!(parsed.segments[1].end_time, 0.0);
    }

    #[test]
    fn an_integer_speaker_label_is_mapped_the_same_way_as_a_string_one() {
        let parsed = parse_mistral_transcript(
            r#"{"text":"a b","segments":[
                 {"text":"a","start":0.0,"end":1.0,"speaker":0},
                 {"text":"b","start":1.0,"end":2.0,"speaker":1}
               ]}"#,
        )
        .expect("payload parses");
        let ids: Vec<&str> = parsed
            .speaker_turns
            .iter()
            .map(|turn| turn.speaker_id.as_str())
            .collect();
        assert_eq!(ids, vec!["S1", "S2"]);
    }

    #[test]
    fn the_route_reports_itself_as_mistral_on_both_provider_fields() {
        let provider = MistralVoxtralProvider::new(None);
        let result = provider.finish(ParsedMistralTranscript::default(), 0, 12);
        assert_eq!(result.requested_provider, AsrProviderType::MistralVoxtral);
        assert_eq!(result.actual_provider, AsrProviderType::MistralVoxtral);
        assert_eq!(result.model_id, VOXTRAL_MINI_TRANSCRIBE_MODEL_ID);
        // No language in the payload means auto, not an invented locale.
        assert_eq!(result.language, "auto");
    }
}
