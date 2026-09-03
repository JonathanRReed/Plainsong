//! Google Gemini 3.5 Transcribe ASR provider — cloud speech-to-text over the
//! batch `v1beta/interactions` endpoint.
//!
//! Verified live against <https://ai.google.dev/gemini-api/docs/transcribe>,
//! <https://ai.google.dev/gemini-api/docs/files> and
//! <https://ai.google.dev/gemini-api/terms> on 2026-09-02. Research write-up:
//! `docs/model-inventory-2026-09.md`.
//!
//! Four things about this API shape the code below:
//!
//! 1. **There is no documented inline-audio form.** The transcription guide's
//!    only REST example uploads through the Files API first and passes the
//!    returned `uri`. So every request here is upload → wait for `ACTIVE` →
//!    transcribe → delete, and the delete is not optional: Plainsong should
//!    not leave a user's meeting sitting in Google's file store for the 48-hour
//!    default lifetime when one more request removes it.
//! 2. **`custom_vocabulary` cannot be combined with diarization or word
//!    timestamps.** Google staff confirmed on 2026-09-01 that the HTTP 400 is
//!    intended and the docs were wrong, not the API. The meeting lane needs
//!    timestamps, so a meeting request cannot carry the personal dictionary and
//!    a dictation request can. `TranscriptionOptions::request_speaker_labels`
//!    is what picks between the two, and the count reported back in
//!    `vocabulary_hint_terms_applied` is zero for a meeting so the audit log
//!    never claims the dictionary reached a request that refused it.
//! 3. **Diarization caps out at 8 speakers**, and Google calls attribution for
//!    three or more experimental. That is in the route copy, not hidden here.
//! 4. **The training terms are tier-dependent.** Paid-tier prompts are not used
//!    to improve Google's products; free-tier content is, and may be read by
//!    human reviewers. Plainsong cannot tell which tier a BYOK key is on, so
//!    the provider description says so rather than implying a guarantee.

use super::{
    cloud_asr_status_error,
    openai_cloud::{build_cloud_asr_client, CloudAsrHttpTimeouts},
    read_cloud_asr_json, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, SpeakerTurn,
    TranscriptSegment, TranscriptionOptions, TranscriptionResult,
};
use crate::secrets;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com";
const GEMINI_INTERACTIONS_PATH: &str = "/v1beta/interactions";
const GEMINI_FILES_UPLOAD_PATH: &str = "/upload/v1beta/files";

const GEMINI_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(10),
    read: Duration::from_secs(90),
    total: Duration::from_secs(120),
};

/// Whole-recording meeting requests. Upload, processing wait and transcription
/// all sit inside this ceiling, and it is still bounded so a meeting that
/// never comes back fails instead of hanging.
const GEMINI_WHOLE_FILE_HTTP_TIMEOUTS: CloudAsrHttpTimeouts = CloudAsrHttpTimeouts {
    connect: Duration::from_secs(15),
    read: Duration::from_secs(10 * 60),
    total: Duration::from_secs(15 * 60),
};

/// How long to wait for an uploaded file to leave `PROCESSING`, and how often
/// to ask. Bounded: a file stuck in processing is a failed transcription, not
/// a reason to wait forever.
const FILE_ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(750);
const FILE_ACTIVE_POLL_LIMIT: Duration = Duration::from_secs(5 * 60);

/// The `file.name` an upload response carried, found without requiring the rest
/// of the response to be the shape we expect.
///
/// This is what makes the delete unconditional. The typed parse used to run
/// first, so an upload that succeeded but answered with an envelope we could
/// not deserialise returned an error before any name was captured -- and the
/// file then sat in Google's store until the 48-hour expiry. Both the
/// documented `{ "file": { "name": ... } }` shape and a bare `{ "name": ... }`
/// are accepted, because either one names a file that now exists.
pub(crate) fn gemini_uploaded_file_name(envelope: &Value) -> Option<String> {
    envelope
        .get("file")
        .and_then(|file| file.get("name"))
        .or_else(|| envelope.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// What the user is told when the upload could not be removed. State, cause,
/// next action -- and the retention period, because that is the part that
/// actually matters to them.
pub(crate) fn gemini_delete_failure_notice(http_status: Option<u16>) -> String {
    let cause = match http_status {
        Some(status) => format!("Google's API answered HTTP {status}"),
        None => "the request to delete it did not complete".to_string(),
    };
    format!(
        "The audio uploaded to Google for this transcription could not be deleted \
         afterwards: {cause}. Google removes it automatically after 48 hours; you can \
         delete it sooner from Google AI Studio."
    )
}

/// What the user is told when there is not even a name to delete with.
pub(crate) fn gemini_unknown_upload_notice() -> String {
    "Audio was uploaded to Google for this transcription, but the response did not \
     name the uploaded file, so Plainsong could not delete it. Google removes it \
     automatically after 48 hours."
        .to_string()
}

/// Deletes the upload on every exit path, including one that never returns.
///
/// The delete used to run after the transcription future finished, which
/// covered errors but not two other exits: a successful upload whose response
/// body did not parse (the name was never captured at all), and cancellation --
/// if the meeting is cancelled or the request dropped mid-flight, the future
/// never reaches the delete. `Drop` closes the second gap by spawning the
/// delete; `delete_now` is the normal path, where awaiting it means a failure
/// is recorded while the completion path is still there to report it.
struct UploadedFileGuard {
    client: reqwest::Client,
    api_key: String,
    name: Option<String>,
}

impl UploadedFileGuard {
    fn new(client: &reqwest::Client, api_key: &str, name: Option<String>) -> Self {
        if name.is_none() {
            super::record_provider_cleanup_warning(gemini_unknown_upload_notice());
        }
        Self {
            client: client.clone(),
            api_key: api_key.to_string(),
            name,
        }
    }

    async fn delete_now(mut self) {
        let Some(name) = self.name.take() else {
            return;
        };
        GeminiTranscribeProvider::delete_file(&self.client, &self.api_key, &name).await;
    }
}

impl Drop for UploadedFileGuard {
    fn drop(&mut self) {
        // Only reachable when the future was dropped before `delete_now` ran,
        // i.e. cancellation. `take` means a normal completion drops a guard
        // with nothing left to do.
        let Some(name) = self.name.take() else {
            return;
        };
        let client = self.client.clone();
        let api_key = std::mem::take(&mut self.api_key);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    GeminiTranscribeProvider::delete_file(&client, &api_key, &name).await;
                });
            }
            // No runtime to spawn on: say so rather than dropping the fact
            // that a file was left behind.
            Err(_) => super::record_provider_cleanup_warning(gemini_delete_failure_notice(None)),
        }
    }
}

/// The audio one request uploads.
///
/// Two shapes because the two lanes arrive differently. Dictation already
/// holds its chunk in memory (a few seconds of PCM), so copying it again would
/// buy nothing. A meeting is a file on disk written as mono 16-bit PCM at the
/// capture device's own sample rate: thirty minutes -- Gemini's ceiling for a
/// diarized request -- is 172.8 MB at 48 kHz, and that used to be read into a
/// `Vec` in full before the upload began.
enum GeminiUploadSource {
    Memory(Vec<u8>),
    File(std::path::PathBuf),
}

impl GeminiUploadSource {
    /// The request body and the exact number of bytes it will yield. The
    /// resumable upload declares that count in a header before the bytes go
    /// out, so it has to be known up front either way -- streaming does not
    /// cost the caller the length.
    async fn into_body(self) -> Result<(reqwest::Body, u64)> {
        match self {
            GeminiUploadSource::Memory(bytes) => {
                let byte_len = bytes.len() as u64;
                Ok((reqwest::Body::from(bytes), byte_len))
            }
            GeminiUploadSource::File(path) => super::streaming_wav_body(&path).await,
        }
    }
}

pub struct GeminiTranscribeProvider {
    model_id: String,
    client: reqwest::Client,
    whole_file_client: reqwest::Client,
}

/// `gemini-3.5-transcribe-live` is deliberately unreachable from here: it is
/// the websocket streaming model, it cannot diarize, and this provider posts
/// to the batch interactions endpoint.
fn sanitize_gemini_asr_model_id(model_id: &str) -> &'static str {
    match model_id.trim() {
        "gemini-3.5-transcribe" => "gemini-3.5-transcribe",
        _ => "gemini-3.5-transcribe",
    }
}

/// Gemini caps `custom_vocabulary` at 1,000 terms. Anything past that is
/// dropped rather than failing the transcription.
fn gemini_custom_vocabulary(terms: &[String]) -> Vec<String> {
    const MAX_TERMS: usize = 1000;
    terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .take(MAX_TERMS)
        .map(str::to_string)
        .collect()
}

/// The interactions request body.
///
/// The mutual exclusion is enforced here, in one place, rather than left to
/// each caller: a request either asks for speaker labels and word timestamps,
/// or it carries the user's vocabulary. Never both — the API rejects that with
/// HTTP 400 and the whole transcription is lost.
pub(crate) fn build_gemini_transcription_request(
    model_id: &str,
    file_uri: &str,
    request_speaker_labels: bool,
    vocabulary: &[String],
) -> Value {
    let mut mode = json!({ "type": "verbatim" });
    let mut transcription_config = serde_json::Map::new();

    if request_speaker_labels {
        mode["diarization_mode"] = json!("speaker");
        mode["timestamp_granularities"] = json!(["word"]);
    } else if !vocabulary.is_empty() {
        transcription_config.insert("custom_vocabulary".to_string(), json!(vocabulary));
    }

    transcription_config.insert("mode".to_string(), mode);

    json!({
        "model": model_id,
        "input": [{
            "type": "audio",
            "uri": file_uri,
            "mime_type": "audio/wav",
        }],
        "generation_config": { "transcription_config": Value::Object(transcription_config) },
    })
}

#[derive(Debug, Default, Deserialize)]
struct GeminiFileEnvelope {
    #[serde(default)]
    file: Option<GeminiFile>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct GeminiFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// What `parse_gemini_transcript` could establish from one interactions
/// response.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ParsedGeminiTranscript {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub speaker_turns: Vec<SpeakerTurn>,
}

/// A `"0.100s"` protobuf duration string, or a bare number, in seconds.
/// Anything else is not a timestamp and is reported as absent rather than as
/// zero — a word at 0.0 s and a word with no timing are different facts.
fn parse_offset_seconds(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().trim_end_matches('s').parse::<f64>().ok(),
        _ => None,
    }
}

/// `"spk_1"` → `"S1"`. Gemini labels speakers from one; Plainsong's own
/// diarizer, alias flow and transcript viewer all use `S1`, `S2`, … so the
/// label is translated at the boundary rather than leaking a second speaker
/// vocabulary into the transcript.
///
/// A label with no digits in it is kept verbatim: it is still a stable speaker
/// key, and inventing an index for it would merge two speakers.
pub(crate) fn gemini_speaker_id(label: &str) -> String {
    let digits: String = label.chars().filter(char::is_ascii_digit).collect();
    match digits.parse::<u32>() {
        Ok(index) => format!("S{}", index.max(1)),
        Err(_) => label.trim().to_string(),
    }
}

/// Collect every `word_info` annotation, in document order, from wherever the
/// response nests them. The published shape is
/// `steps[].content[].annotations[]`, optionally under an `interaction` key;
/// this walks the tree instead of pinning one path, because a preview API that
/// moves a wrapper key should degrade to "no timings" rather than to "no
/// transcript".
fn collect_word_annotations(root: &Value) -> Vec<&Value> {
    fn walk<'a>(value: &'a Value, out: &mut Vec<&'a Value>) {
        match value {
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("word_info") {
                    out.push(value);
                    return;
                }
                for nested in map.values() {
                    walk(nested, out);
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

fn find_output_text(root: &Value) -> Option<String> {
    if let Some(text) = root.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(interaction) = root.get("interaction") {
        if let Some(text) = interaction.get("output_text").and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }
    None
}

#[cfg(test)]
pub(crate) fn parse_gemini_transcript(payload: &str) -> Result<ParsedGeminiTranscript> {
    let root: Value =
        serde_json::from_str(payload).context("Failed to decode Gemini transcription payload")?;
    Ok(parse_gemini_value(&root))
}

fn parse_gemini_value(root: &Value) -> ParsedGeminiTranscript {
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut speaker_turns: Vec<SpeakerTurn> = Vec::new();

    // Consecutive words sharing a speaker become one turn, which is the unit
    // the transcript viewer groups by and the unit the diarization merge
    // wants.
    let mut current: Option<(String, f64, f64, String)> = None;
    for annotation in collect_word_annotations(root) {
        let text = annotation
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        let start = parse_offset_seconds(annotation.get("start_offset"));
        let end = parse_offset_seconds(annotation.get("end_offset"));
        let (Some(start), Some(end)) = (start, end) else {
            continue;
        };
        let speaker = annotation
            .get("speaker")
            .and_then(Value::as_str)
            .map(gemini_speaker_id)
            .unwrap_or_default();

        match current.as_mut() {
            Some((run_speaker, _, run_end, run_text)) if *run_speaker == speaker => {
                *run_end = end;
                run_text.push(' ');
                run_text.push_str(text);
            }
            _ => {
                if let Some((speaker_id, start_time, end_time, run_text)) = current.take() {
                    push_run(
                        &mut segments,
                        &mut speaker_turns,
                        speaker_id,
                        start_time,
                        end_time,
                        run_text,
                    );
                }
                current = Some((speaker, start, end, text.to_string()));
            }
        }
    }
    if let Some((speaker_id, start_time, end_time, run_text)) = current.take() {
        push_run(
            &mut segments,
            &mut speaker_turns,
            speaker_id,
            start_time,
            end_time,
            run_text,
        );
    }

    let output_text = find_output_text(root)
        .unwrap_or_default()
        .trim()
        .to_string();
    let text = if output_text.is_empty() {
        segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        output_text
    };

    if segments.is_empty() && !text.is_empty() {
        segments.push(TranscriptSegment {
            start_time: 0.0,
            end_time: 0.0,
            text: text.clone(),
            confidence: GEMINI_CONFIDENCE,
        });
    }

    ParsedGeminiTranscript {
        text,
        segments,
        speaker_turns,
    }
}

/// Gemini's transcription response carries no per-word or per-utterance
/// confidence. Rather than leave the field at zero (which the transcript
/// viewer renders as "avg conf 0%") this is a single named constant, so the
/// number in the UI is traceable to "the provider did not report one" instead
/// of looking like a measurement.
const GEMINI_CONFIDENCE: f64 = 0.9;

fn push_run(
    segments: &mut Vec<TranscriptSegment>,
    speaker_turns: &mut Vec<SpeakerTurn>,
    speaker_id: String,
    start_time: f64,
    end_time: f64,
    text: String,
) {
    segments.push(TranscriptSegment {
        start_time,
        end_time,
        text,
        confidence: GEMINI_CONFIDENCE,
    });
    if !speaker_id.is_empty() {
        speaker_turns.push(SpeakerTurn {
            start_time,
            end_time,
            speaker_id,
            confidence: GEMINI_CONFIDENCE,
        });
    }
}

impl Default for GeminiTranscribeProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

impl GeminiTranscribeProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: sanitize_gemini_asr_model_id(
                selected_model_id.unwrap_or("gemini-3.5-transcribe"),
            )
            .to_string(),
            client: build_cloud_asr_client(GEMINI_HTTP_TIMEOUTS),
            whole_file_client: build_cloud_asr_client(GEMINI_WHOLE_FILE_HTTP_TIMEOUTS),
        }
    }

    fn api_key() -> Option<String> {
        match secrets::get_provider_secret("gemini") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("GEMINI_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    /// Resumable upload, exactly as the Files API documents it: a `start`
    /// request that answers with an upload URL in a header, then the bytes.
    async fn upload_file(
        &self,
        client: &reqwest::Client,
        timeouts: CloudAsrHttpTimeouts,
        api_key: &str,
        audio: GeminiUploadSource,
    ) -> Result<Value> {
        let (audio_body, byte_count) = audio.into_body().await?;
        let start = client
            .post(format!("{GEMINI_API_BASE}{GEMINI_FILES_UPLOAD_PATH}"))
            .header("x-goog-api-key", api_key)
            .header("X-Goog-Upload-Protocol", "resumable")
            .header("X-Goog-Upload-Command", "start")
            .header(
                "X-Goog-Upload-Header-Content-Length",
                byte_count.to_string(),
            )
            .header("X-Goog-Upload-Header-Content-Type", "audio/wav")
            .json(&json!({ "file": { "display_name": "plainsong-audio" } }))
            .timeout(timeouts.total)
            .send()
            .await
            .context("Gemini Files API upload request failed")?;

        if !start.status().is_success() {
            return Err(cloud_asr_status_error("Gemini Files", start.status()));
        }

        let upload_url = start
            .headers()
            .get("x-goog-upload-url")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .context("Gemini Files API did not return an upload URL")?;

        // CONTENT_LENGTH is set explicitly because a streamed body has no
        // length of its own, and this endpoint is a resumable upload that was
        // told the total up front in `X-Goog-Upload-Header-Content-Length`.
        // Without it the request would go out chunked, which is a different
        // wire shape from the one this upload was started with. The count and
        // the bytes come from the same open file handle (see
        // `streaming_wav_body`), so they cannot disagree.
        let uploaded = client
            .post(upload_url)
            .header("X-Goog-Upload-Offset", "0")
            .header("X-Goog-Upload-Command", "upload, finalize")
            .header(reqwest::header::CONTENT_TYPE, "audio/wav")
            .header(reqwest::header::CONTENT_LENGTH, byte_count)
            .body(audio_body)
            .timeout(timeouts.total)
            .send()
            .await
            .context("Gemini Files API byte upload failed")?;

        if !uploaded.status().is_success() {
            return Err(cloud_asr_status_error("Gemini Files", uploaded.status()));
        }

        // The raw envelope, not the typed one: the caller pulls the file name
        // out of it before anything that can fail, so a body whose shape we do
        // not recognise still leaves a name to delete.
        read_cloud_asr_json::<Value>(uploaded, "Gemini Files").await
    }

    /// A freshly uploaded file is `PROCESSING` until Gemini has decoded it;
    /// referencing it before it is `ACTIVE` fails the interaction.
    async fn wait_for_active(
        &self,
        client: &reqwest::Client,
        api_key: &str,
        file: GeminiFile,
    ) -> Result<GeminiFile> {
        let mut file = file;
        let deadline = std::time::Instant::now() + FILE_ACTIVE_POLL_LIMIT;
        loop {
            match file.state.as_deref() {
                Some("ACTIVE") => return Ok(file),
                Some("FAILED") => {
                    return Err(anyhow::anyhow!(
                        "Gemini could not process the uploaded audio"
                    ))
                }
                _ => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(anyhow::anyhow!(
                    "Gemini did not finish processing the uploaded audio within {} seconds",
                    FILE_ACTIVE_POLL_LIMIT.as_secs()
                ));
            }
            tokio::time::sleep(FILE_ACTIVE_POLL_INTERVAL).await;

            let name = file
                .name
                .as_deref()
                .context("Gemini file metadata carried no name")?;
            let response = client
                .get(format!("{GEMINI_API_BASE}/v1beta/{name}"))
                .header("x-goog-api-key", api_key)
                .timeout(GEMINI_HTTP_TIMEOUTS.total)
                .send()
                .await
                .context("Gemini Files API status request failed")?;
            if !response.status().is_success() {
                return Err(cloud_asr_status_error("Gemini Files", response.status()));
            }
            let refreshed: GeminiFile = read_cloud_asr_json(response, "Gemini Files").await?;
            file = GeminiFile {
                name: refreshed.name.or(file.name),
                uri: refreshed.uri.or(file.uri),
                state: refreshed.state,
            };
        }
    }

    /// Best-effort removal. Google expires uploads after 48 hours on its own,
    /// but leaving a user's meeting audio in a third-party file store for two
    /// days when one request removes it is not a defensible default. A failed
    /// delete is never surfaced as a transcription failure -- the transcript is
    /// fine -- but it is no longer only a log line either: it goes into the
    /// cleanup-warning sink, which the completion path turns into an audit
    /// record and a note on the finished recording.
    async fn delete_file(client: &reqwest::Client, api_key: &str, name: &str) {
        let outcome = client
            .delete(format!("{GEMINI_API_BASE}/v1beta/{name}"))
            .header("x-goog-api-key", api_key)
            .timeout(GEMINI_HTTP_TIMEOUTS.total)
            .send()
            .await;
        match outcome {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => super::record_provider_cleanup_warning(gemini_delete_failure_notice(
                Some(response.status().as_u16()),
            )),
            Err(_) => super::record_provider_cleanup_warning(gemini_delete_failure_notice(None)),
        }
    }

    async fn transcribe_impl(
        &self,
        client: &reqwest::Client,
        timeouts: CloudAsrHttpTimeouts,
        audio: GeminiUploadSource,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let api_key = Self::api_key().context(
            "Gemini API key not set. Add it in Settings → API Keys or set GEMINI_API_KEY.",
        )?;
        let start = std::time::Instant::now();

        let envelope = self.upload_file(client, timeouts, &api_key, audio).await?;
        // From this line on a file exists in Google's store, so the guard is
        // created before anything else that can fail or be cancelled.
        let guard = UploadedFileGuard::new(client, &api_key, gemini_uploaded_file_name(&envelope));

        let outcome = async {
            let uploaded = serde_json::from_value::<GeminiFileEnvelope>(envelope)
                .context("Gemini Files API response could not be read")?
                .file
                .context("Gemini Files API response carried no file")?;
            let active = self.wait_for_active(client, &api_key, uploaded).await?;
            let uri = active
                .uri
                .clone()
                .context("Gemini file metadata carried no URI")?;

            let vocabulary = options
                .vocabulary_hint
                .as_ref()
                .map(|hint| gemini_custom_vocabulary(hint.terms()))
                .unwrap_or_default();
            let body = build_gemini_transcription_request(
                &self.model_id,
                &uri,
                options.request_speaker_labels,
                &vocabulary,
            );
            // Zero whenever the request asked for speaker labels: the API
            // refuses the vocabulary on that request, so the audit log must
            // not report terms it never sent.
            let vocabulary_hint_terms_applied = if options.request_speaker_labels {
                0
            } else {
                vocabulary.len()
            };

            let response = client
                .post(format!("{GEMINI_API_BASE}{GEMINI_INTERACTIONS_PATH}"))
                .header("x-goog-api-key", &api_key)
                .json(&body)
                .timeout(timeouts.total)
                .send()
                .await
                .context("Gemini transcription request failed")?;
            if !response.status().is_success() {
                return Err(cloud_asr_status_error(
                    "Gemini Transcribe",
                    response.status(),
                ));
            }
            let payload: Value = read_cloud_asr_json(response, "Gemini Transcribe").await?;
            let parsed = parse_gemini_value(&payload);

            Ok(TranscriptionResult {
                text: parsed.text,
                segments: parsed.segments,
                speaker_turns: parsed.speaker_turns,
                language: "auto".to_string(),
                confidence: GEMINI_CONFIDENCE,
                processing_time_ms: start.elapsed().as_millis() as u64,
                model_name: format!("Gemini Transcribe ({})", self.model_id),
                model_id: self.model_id.clone(),
                requested_provider: AsrProviderType::GeminiTranscribe,
                actual_provider: AsrProviderType::GeminiTranscribe,
                requested_engine: Some("provider_default".to_string()),
                actual_engine: Some("provider_default".to_string()),
                optimization_applied: false,
                fallback_reason: None,
                vocabulary_hint_terms_applied,
            })
        }
        .await;

        guard.delete_now().await;

        outcome
    }
}

#[async_trait]
impl AsrProvider for GeminiTranscribeProvider {
    fn name(&self) -> &str {
        "Google Gemini Transcribe"
    }

    fn description(&self) -> &str {
        "Cloud speech-to-text via Google's Gemini 3.5 Transcribe. Returns speaker labels \
         (up to 8; Google calls 3+ experimental) and word timestamps for meetings, and takes \
         your personal dictionary for dictation -- the API refuses both on one request. \
         Google's paid tier does not train on your prompts; the free tier does, and states \
         that human reviewers may read them. Audio is uploaded to Google's Files API and \
         deleted again after each transcription. \
         Requires GEMINI_API_KEY from https://aistudio.google.com/apikey"
    }

    fn is_available(&self) -> bool {
        Self::api_key().is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Gemini 3.5 Transcribe".to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "cloud".to_string(),
            languages: vec!["en".to_string(), "multilingual".to_string()],
            // Google reports 2.6% average WER across 85+ languages, as
            // measured by Artificial Analysis (announced 2026-08-26).
            word_error_rate: Some(2.6),
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: "https://ai.google.dev/gemini-api/docs/transcribe".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        self.transcribe_impl(
            &self.whole_file_client,
            GEMINI_WHOLE_FILE_HTTP_TIMEOUTS,
            // Streamed off disk, never read into a `Vec`: this is the meeting
            // lane, and a thirty-minute recording is 172.8 MB of mono 16-bit
            // PCM at a 48 kHz capture rate.
            GeminiUploadSource::File(audio_path.to_path_buf()),
            &TranscriptionOptions {
                // The whole-file path exists for the meeting lane, which is the
                // only caller that wants speaker labels.
                request_speaker_labels: true,
                ..TranscriptionOptions::default()
            },
        )
        .await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        self.transcribe_impl(
            &self.client,
            GEMINI_HTTP_TIMEOUTS,
            GeminiUploadSource::Memory(audio_data.to_vec()),
            &TranscriptionOptions::default(),
        )
        .await
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        self.transcribe_impl(
            &self.client,
            GEMINI_HTTP_TIMEOUTS,
            GeminiUploadSource::Memory(audio_data.to_vec()),
            options,
        )
        .await
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
        build_gemini_transcription_request, gemini_custom_vocabulary, gemini_speaker_id,
        parse_gemini_transcript, sanitize_gemini_asr_model_id, GeminiTranscribeProvider,
        GEMINI_HTTP_TIMEOUTS, GEMINI_WHOLE_FILE_HTTP_TIMEOUTS,
    };
    use crate::asr::AsrProvider;
    use std::time::Duration;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn gemini_clients_have_bounded_timeouts() {
        assert_eq!(GEMINI_HTTP_TIMEOUTS.connect, Duration::from_secs(10));
        assert_eq!(GEMINI_HTTP_TIMEOUTS.total, Duration::from_secs(120));
        assert!(GEMINI_HTTP_TIMEOUTS.total < Duration::from_secs(5 * 60));
        assert!(GEMINI_WHOLE_FILE_HTTP_TIMEOUTS.total > GEMINI_HTTP_TIMEOUTS.total);
        assert_eq!(
            GEMINI_WHOLE_FILE_HTTP_TIMEOUTS.total,
            Duration::from_secs(15 * 60)
        );
    }

    #[test]
    fn only_the_batch_model_reaches_the_interactions_endpoint() {
        assert_eq!(
            sanitize_gemini_asr_model_id("gemini-3.5-transcribe"),
            "gemini-3.5-transcribe"
        );
        // The -live model is websocket-only and cannot diarize.
        assert_eq!(
            sanitize_gemini_asr_model_id("gemini-3.5-transcribe-live"),
            "gemini-3.5-transcribe"
        );
        assert_eq!(
            GeminiTranscribeProvider::new(None).model_info().version,
            "gemini-3.5-transcribe"
        );
    }

    #[test]
    fn a_meeting_request_asks_for_speakers_and_timestamps_and_sends_no_vocabulary() {
        // Google confirmed on 2026-09-01 that custom_vocabulary alongside
        // diarization or timestamps is an intended HTTP 400. Sending both
        // would lose the whole transcription, so the builder must never
        // produce it.
        let body = build_gemini_transcription_request(
            "gemini-3.5-transcribe",
            "https://example/files/abc",
            true,
            &strings(&["Plainsong", "neume"]),
        );
        let config = &body["generation_config"]["transcription_config"];
        assert_eq!(config["mode"]["diarization_mode"], "speaker");
        assert_eq!(config["mode"]["timestamp_granularities"][0], "word");
        assert!(config.get("custom_vocabulary").is_none());
        assert_eq!(body["input"][0]["uri"], "https://example/files/abc");
        assert_eq!(body["input"][0]["mime_type"], "audio/wav");
    }

    #[test]
    fn a_dictation_request_carries_the_vocabulary_and_asks_for_neither() {
        let body = build_gemini_transcription_request(
            "gemini-3.5-transcribe",
            "https://example/files/abc",
            false,
            &strings(&["Plainsong"]),
        );
        let config = &body["generation_config"]["transcription_config"];
        assert_eq!(config["custom_vocabulary"][0], "Plainsong");
        assert!(config["mode"].get("diarization_mode").is_none());
        assert!(config["mode"].get("timestamp_granularities").is_none());
    }

    #[test]
    fn custom_vocabulary_stays_inside_the_thousand_term_cap() {
        let terms: Vec<String> = (0..1500).map(|index| format!("term{index}")).collect();
        assert_eq!(gemini_custom_vocabulary(&terms).len(), 1000);
        assert_eq!(
            gemini_custom_vocabulary(&strings(&["  Plainsong  ", "", "neume"])),
            strings(&["Plainsong", "neume"])
        );
    }

    #[test]
    fn speaker_labels_translate_into_plainsongs_own_ids() {
        assert_eq!(gemini_speaker_id("spk_1"), "S1");
        assert_eq!(gemini_speaker_id("spk_2"), "S2");
        assert_eq!(gemini_speaker_id("spk_0"), "S1");
        // A label with no index is a stable key in its own right; inventing an
        // index for it would merge two speakers into one.
        assert_eq!(gemini_speaker_id("moderator"), "moderator");
    }

    // Response shape from https://ai.google.dev/gemini-api/docs/transcribe
    // (fetched 2026-09-02), trimmed to the fields this provider reads.
    const SAMPLE_DIARIZED_RESPONSE: &str = r#"{
      "interaction": { "output_text": "Hello there. Good morning." },
      "steps": [{
        "content": [{
          "text": "Hello there. Good morning.",
          "annotations": [
            { "type": "word_info", "text": "Hello", "speaker": "spk_1", "start_offset": "0.100s", "end_offset": "0.450s" },
            { "type": "word_info", "text": "there.", "speaker": "spk_1", "start_offset": "0.450s", "end_offset": "0.900s" },
            { "type": "word_info", "text": "Good", "speaker": "spk_2", "start_offset": "1.200s", "end_offset": "1.500s" },
            { "type": "word_info", "text": "morning.", "speaker": "spk_2", "start_offset": "1.500s", "end_offset": "2.000s" }
          ]
        }]
      }]
    }"#;

    #[test]
    fn word_annotations_become_speaker_runs_with_timings() {
        let parsed = parse_gemini_transcript(SAMPLE_DIARIZED_RESPONSE).expect("parses");

        assert_eq!(parsed.text, "Hello there. Good morning.");
        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.segments[0].text, "Hello there.");
        assert_eq!(parsed.segments[0].start_time, 0.1);
        assert_eq!(parsed.segments[0].end_time, 0.9);
        assert_eq!(parsed.segments[1].text, "Good morning.");
        assert_eq!(parsed.segments[1].start_time, 1.2);

        assert_eq!(parsed.speaker_turns.len(), 2);
        assert_eq!(parsed.speaker_turns[0].speaker_id, "S1");
        assert_eq!(parsed.speaker_turns[1].speaker_id, "S2");
        assert_eq!(parsed.speaker_turns[1].end_time, 2.0);
    }

    #[test]
    fn a_dictation_response_is_one_untimed_segment_with_no_speakers() {
        // No annotations come back when neither diarization nor timestamps
        // were requested, which is exactly the dictation request. The result
        // must still carry the text, and must not claim a speaker.
        let parsed =
            parse_gemini_transcript(r#"{"output_text":"Just the words."}"#).expect("parses");
        assert_eq!(parsed.text, "Just the words.");
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].start_time, 0.0);
        assert!(parsed.speaker_turns.is_empty());
    }

    #[test]
    fn an_annotation_without_timings_is_skipped_rather_than_placed_at_zero() {
        let parsed = parse_gemini_transcript(
            r#"{"output_text":"a b","steps":[{"content":[{"annotations":[
                 {"type":"word_info","text":"a","speaker":"spk_1"},
                 {"type":"word_info","text":"b","speaker":"spk_1","start_offset":"1s","end_offset":"2s"}
               ]}]}]}"#,
        )
        .expect("parses");
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].text, "b");
        assert_eq!(parsed.segments[0].start_time, 1.0);
    }

    #[test]
    fn an_empty_response_is_empty_not_an_error() {
        let parsed = parse_gemini_transcript(r#"{}"#).expect("parses");
        assert_eq!(parsed.text, "");
        assert!(parsed.segments.is_empty());
        assert!(parsed.speaker_turns.is_empty());
    }

    #[test]
    fn malformed_json_is_rejected_without_echoing_the_body() {
        let error = parse_gemini_transcript("{ not json").expect_err("must fail");
        let rendered = format!("{error:#}");
        assert!(rendered.contains("Gemini"));
        assert!(!rendered.contains("not json"));
    }

    /// The exact case that used to leak a file: an upload that succeeded and
    /// answered with a body the typed parse rejects.
    ///
    /// Before this, the typed parse ran first and its `?` returned before any
    /// name was captured, so `delete_file` was never called and the audio sat
    /// in Google's store until the 48-hour expiry. The name is now read out of
    /// the raw envelope first, which is what makes the delete unconditional.
    #[test]
    fn an_unparseable_upload_response_still_yields_a_file_to_delete() {
        // `state` as a number is not the shape `GeminiFile` declares, so the
        // typed parse fails -- but the file exists and is named.
        let envelope = serde_json::json!({
            "file": { "name": "files/abc123", "state": 7 }
        });
        assert!(
            serde_json::from_value::<super::GeminiFileEnvelope>(envelope.clone()).is_err(),
            "fixture must actually be unparseable, or this test proves nothing"
        );
        assert_eq!(
            super::gemini_uploaded_file_name(&envelope).as_deref(),
            Some("files/abc123")
        );

        // A bare `{ "name": ... }` names a file that exists just as much.
        assert_eq!(
            super::gemini_uploaded_file_name(&serde_json::json!({ "name": "files/bare" }))
                .as_deref(),
            Some("files/bare")
        );
        // Nothing to delete is None, not an empty name that would build a
        // request against `/v1beta/`.
        assert_eq!(
            super::gemini_uploaded_file_name(&serde_json::json!({ "file": { "name": "  " } })),
            None
        );
        assert_eq!(
            super::gemini_uploaded_file_name(&serde_json::json!({ "error": "nope" })),
            None
        );
    }

    /// The warning is what the user actually reads, so it has to say the thing
    /// that matters: the audio is still there, and for how long.
    #[test]
    fn a_failed_delete_tells_the_user_the_audio_is_still_on_googles_side() {
        let with_status = super::gemini_delete_failure_notice(Some(503));
        assert!(with_status.contains("could not be deleted"));
        assert!(with_status.contains("503"));
        assert!(with_status.contains("48 hours"));

        let without_status = super::gemini_delete_failure_notice(None);
        assert!(without_status.contains("48 hours"));
        assert!(!without_status.contains("HTTP"));

        let unknown = super::gemini_unknown_upload_notice();
        assert!(unknown.contains("did not name the uploaded file"));
        assert!(unknown.contains("48 hours"));
    }

    /// The resumable upload declares the total byte count in a header before
    /// any bytes go out, and then sends a streamed body whose length reqwest
    /// cannot infer. If those two disagree the request fails at send time, so
    /// the count and the bytes must come from the same place.
    #[tokio::test]
    async fn an_upload_declares_exactly_the_bytes_it_will_send() {
        let payload = vec![7u8; 4096];
        let (_body, declared) = super::GeminiUploadSource::Memory(payload.clone())
            .into_body()
            .await
            .expect("in-memory body");
        assert_eq!(declared, payload.len() as u64);

        let path = std::env::temp_dir().join(format!(
            "plainsong-gemini-upload-{}.wav",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, &payload)
            .await
            .expect("fixture write");
        let (_body, declared) = super::GeminiUploadSource::File(path.clone())
            .into_body()
            .await
            .expect("streamed body");
        assert_eq!(
            declared,
            payload.len() as u64,
            "the meeting lane must declare the file's own size, not a guess"
        );
        let _ = tokio::fs::remove_file(&path).await;

        // A meeting that is not on disk is a failed transcription, not a
        // zero-byte upload.
        assert!(super::GeminiUploadSource::File(path)
            .into_body()
            .await
            .is_err());
    }

    #[test]
    fn provider_status_errors_never_include_response_body_content() {
        let error =
            super::cloud_asr_status_error("Gemini Transcribe", reqwest::StatusCode::FORBIDDEN);
        let rendered = error.to_string();
        assert!(rendered.contains("Gemini Transcribe"));
        assert!(rendered.contains("403"));
        assert!(!rendered.contains("secret-transcript-marker"));
    }
}
