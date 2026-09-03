pub mod cohere;
pub mod cohere_local;
pub mod deepgram;
pub mod distil_whisper;
pub mod elevenlabs_scribe;
pub mod gemini_transcribe;
pub mod groq;
pub mod macos_apple_speech_provider;
pub mod manager;
pub mod moonshine;
pub mod openai_cloud;
pub mod parakeet;
#[cfg(feature = "asr-parakeet")]
pub mod parakeet_tdt;
pub mod platform;
pub mod qwen3_asr;
#[cfg(feature = "asr-transcribe-cpp")]
pub mod transcribe_cpp;
#[cfg(feature = "asr-whisper")]
pub mod whisper;
#[cfg(not(feature = "asr-whisper"))]
pub mod whisper_stub;
#[cfg(not(feature = "asr-whisper"))]
pub use whisper_stub as whisper;
pub mod whisper_candle;
pub mod windows_sdk_dictation_provider;

use anyhow::Result;
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const CLOUD_ASR_RESPONSE_BODY_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) async fn read_cloud_asr_json<T: DeserializeOwned>(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<T> {
    crate::llm::transport::read_json_body(response, CLOUD_ASR_RESPONSE_BODY_LIMIT)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "{} response was invalid or exceeded the {} MiB limit: {}",
                provider_label,
                CLOUD_ASR_RESPONSE_BODY_LIMIT / (1024 * 1024),
                error
            )
        })
}

pub(crate) fn cloud_asr_status_error(
    provider_label: &str,
    status: reqwest::StatusCode,
) -> anyhow::Error {
    anyhow::anyhow!("{} API returned HTTP {}", provider_label, status.as_u16())
}

/// The error a non-2xx cloud ASR response becomes.
///
/// Takes the response **by value**, so from here on its body is unreachable
/// rather than merely unread. A provider's error body can echo the audio's
/// transcript, the prompt, or a keyterm list out of the user's personal
/// dictionary, and none of that belongs in a message that ends up in a log or
/// on screen. "Remember to pass only the status" is not a guarantee; consuming
/// the response is.
pub(crate) fn cloud_asr_response_error(
    provider_label: &str,
    response: reqwest::Response,
) -> anyhow::Error {
    cloud_asr_status_error(provider_label, response.status())
}

/// Warnings a provider raised about work it does *outside* the transcript.
///
/// Today there is exactly one producer: the Gemini route uploads audio to
/// Google's Files API and then deletes it, and a delete that does not succeed
/// leaves a user's meeting in a third-party store for the 48-hour default
/// lifetime. That is worth an audit record and a word to the user, and it used
/// to be a `tracing::warn!` nobody would ever read.
///
/// A process-wide sink rather than a field on [`TranscriptionResult`] because
/// the delete outlives the result: it must also be reportable when the
/// transcription itself failed, and when the request was cancelled and there is
/// no result to attach anything to. Bounded, because nothing guarantees a
/// drainer runs.
const PROVIDER_CLEANUP_WARNING_LIMIT: usize = 32;

fn provider_cleanup_warnings() -> &'static std::sync::Mutex<std::collections::VecDeque<String>> {
    static WARNINGS: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<String>>> =
        std::sync::OnceLock::new();
    WARNINGS.get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()))
}

/// Record one cleanup warning. Oldest is dropped once the sink is full: a
/// backlog nobody drained is not a reason to grow without bound.
pub(crate) fn record_provider_cleanup_warning(warning: String) {
    tracing::warn!("{}", warning);
    let Ok(mut warnings) = provider_cleanup_warnings().lock() else {
        return;
    };
    if warnings.len() >= PROVIDER_CLEANUP_WARNING_LIMIT {
        warnings.pop_front();
    }
    warnings.push_back(warning);
}

/// Take everything recorded so far, leaving the sink empty. Called where a
/// recording finishes, which is where the audit log and the user-visible
/// notice both live.
pub fn take_provider_cleanup_warnings() -> Vec<String> {
    provider_cleanup_warnings()
        .lock()
        .map(|mut warnings| warnings.drain(..).collect())
        .unwrap_or_default()
}

/// Read size for a streamed upload. Large enough that a long meeting is not
/// thousands of tiny frames, small enough that peak memory is a constant.
pub(crate) const UPLOAD_CHUNK_BYTES: usize = 256 * 1024;

/// Stream a WAV off disk as a request body, with its length.
///
/// The meeting lane sends whole recordings to the cloud providers, and a
/// meeting is written as mono 16-bit PCM at the capture device's own sample
/// rate: thirty minutes at 48 kHz is 172.8 MB, two hours is 691 MB. Reading
/// that into a `Vec` to hand to `.body()` holds all of it in memory at once.
/// A streamed body keeps peak usage at one [`UPLOAD_CHUNK_BYTES`] buffer
/// regardless of meeting length.
///
/// The length comes from the already-open handle rather than a separate
/// `metadata()` call on the path, so the number a caller declares in a header
/// and the bytes this stream yields describe the same file.
pub(crate) async fn streaming_wav_body(path: &Path) -> Result<(reqwest::Body, u64)> {
    use anyhow::Context;

    let file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("Failed to open {} for upload", path.display()))?;
    let byte_len = file
        .metadata()
        .await
        .with_context(|| format!("Failed to size {} for upload", path.display()))?
        .len();
    Ok((
        reqwest::Body::wrap_stream(upload_chunk_stream(file)),
        byte_len,
    ))
}

/// The chunking behind [`streaming_wav_body`], separated so the memory bound
/// it exists for can be asserted without a network client.
pub(crate) fn upload_chunk_stream(
    file: tokio::fs::File,
) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    use tokio::io::AsyncReadExt;

    futures_util::stream::try_unfold(file, |mut file| async move {
        let mut buffer = vec![0u8; UPLOAD_CHUNK_BYTES];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buffer.truncate(read);
            Ok(Some((buffer, file)))
        }
    })
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let mut artifacts = Vec::new();
    artifacts.extend(distil_whisper::model_integrity_artifacts(models_root));
    artifacts.extend(moonshine::model_integrity_artifacts(models_root));
    artifacts.extend(parakeet::model_integrity_artifacts(models_root));
    artifacts.extend(whisper_candle::model_integrity_artifacts(models_root));
    artifacts.extend(qwen3_asr::model_integrity_artifacts(models_root));
    artifacts.extend(cohere_local::model_integrity_artifacts(models_root));
    #[cfg(feature = "asr-transcribe-cpp")]
    artifacts.extend(transcribe_cpp::model_integrity_artifacts(models_root));
    artifacts
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub version: String,
    pub size_mb: f64,
    pub parameters: String,
    pub languages: Vec<String>,
    pub word_error_rate: Option<f64>,
    pub real_time_factor: Option<f64>,
    pub license: String,
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub confidence: f64,
}

/// One speaker turn exactly as a *provider* reported it, on that request's own
/// timeline.
///
/// These are deliberately kept beside the transcript rather than merged into
/// `segments` by the provider. The meeting lane feeds them through the same
/// `DiarizationEngine::merge_with_transcript` the local diarizer uses, so the
/// two diarizers cannot drift into producing differently-shaped transcripts —
/// swapping the diarizer is swapping which turns go into one merge, and
/// nothing else.
///
/// `speaker_id` is already in Plainsong's own `S1`/`S2` form, not the
/// provider's numbering, because that is what the rename/alias flow and the
/// transcript viewer read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerTurn {
    pub start_time: f64,
    pub end_time: f64,
    pub speaker_id: String,
    pub confidence: f64,
}

/// Provider speaker numbering is per request and starts at zero; Plainsong's
/// own diarizer emits `S1`, `S2`, … and the whole UI is built on that shape.
pub(crate) fn provider_speaker_id(index: u32) -> String {
    format!("S{}", index.saturating_add(1))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    /// Speaker turns the provider itself reported, empty for every provider
    /// that does not diarize (which is all of them except Deepgram and Gemini).
    #[serde(default)]
    pub speaker_turns: Vec<SpeakerTurn>,
    pub language: String,
    pub confidence: f64,
    pub processing_time_ms: u64,
    pub model_name: String,
    pub model_id: String,
    pub requested_provider: AsrProviderType,
    pub actual_provider: AsrProviderType,
    #[serde(default)]
    pub requested_engine: Option<String>,
    #[serde(default)]
    pub actual_engine: Option<String>,
    #[serde(default)]
    pub optimization_applied: bool,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    /// How many vocabulary-hint terms the provider actually attached to the
    /// request (whisper's initial prompt, a cloud `prompt`/`keyterms` field,
    /// Apple's `contextualStrings`). Zero for providers with no such field at
    /// all and for a whisper decode that withheld the prompt on near-silent
    /// audio. Compared with the number of terms *built* in the audit log, so
    /// "the dictionary reached the recognizer" is never claimed for a route it
    /// did not.
    ///
    /// Attached, not obeyed. Apple's SpeechAnalyzer takes the terms and, on
    /// macOS 27.0, returns exactly the transcript it would have returned
    /// without them (`artifacts/qa/speechanalyzer-vocab-2026-09-02.md`), while
    /// SFSpeechRecognizer measurably acts on them. Reporting zero for the
    /// former would mean hard-coding one OS version's behaviour into a runtime
    /// count that would then go quietly stale; whether a recognizer used what
    /// it was handed is a measurement, not a field.
    #[serde(default)]
    pub vocabulary_hint_terms_applied: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    NotDownloaded,
    Downloading(f32),
    Downloaded,
    Error,
}

/// Recognizer-side vocabulary bias: the spellings the recognizer should
/// prefer for this request. Built at dictation time from the user's personal
/// dictionary (the *replacement* spellings, never the misheard forms) and
/// plain-word snippet triggers (never their expansions), scoped and capped by
/// `dictation_parity::build_vocabulary_hint`. Providers that accept a prompt
/// or keyterm list attach it; every other provider ignores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabularyHint {
    terms: Vec<String>,
}

impl VocabularyHint {
    /// `None` for an empty list, so a hint is only ever attached when there
    /// is something in it — an empty whisper prompt is worse than none.
    pub fn new(terms: Vec<String>) -> Option<Self> {
        if terms.is_empty() {
            None
        } else {
            Some(Self { terms })
        }
    }

    pub fn terms(&self) -> &[String] {
        &self.terms
    }

    /// Conservative token estimate for a prompt string, for budgeting against
    /// whisper's prompt window (half of its 448-token text context, so 224).
    /// Heuristic, stated plainly: one token per three characters — proper
    /// nouns and unfamiliar spellings tokenize into short pieces, so the
    /// usual "four characters per token" for prose is too generous here —
    /// plus one token per comma or period. Over-estimating only trims a few
    /// of the oldest terms; under-estimating would let whisper silently drop
    /// the newest.
    pub fn estimate_prompt_tokens(prompt: &str) -> usize {
        let chars = prompt.chars().count();
        let separators = prompt.chars().filter(|ch| matches!(ch, ',' | '.')).count();
        chars.div_ceil(3) + separators
    }

    /// `estimate_prompt_tokens` of this hint's own `as_prompt()`.
    pub fn estimated_prompt_tokens(&self) -> usize {
        Self::estimate_prompt_tokens(&self.as_prompt())
    }

    /// Characters `as_prompt` adds around the joined terms. Callers that
    /// budget the prompt (`dictation_parity::build_vocabulary_hint`) count
    /// this so the whole prompt, not only the terms, stays under the cap.
    pub const PROMPT_FRAME_CHARS: usize = "Vocabulary: .".len();

    /// The prompt form for whisper-style `initial_prompt` / `prompt` fields:
    /// one framed sentence, `Vocabulary: term, term, term.`
    ///
    /// The shape matters more than it looks. whisper treats the prompt as
    /// *prior transcript*, so a bare comma list (`Plainsong, hotkey, Slack,
    /// Nautilus`) taught `base.en` the wrong things on the repo fixtures:
    /// it dropped a sentence boundary on the 44 s fixture and turned a
    /// correctly-heard "Nautilus" into "not-a-list" on the 5 s one. Ending
    /// with a period fixed the words but leaked comma-only punctuation into
    /// the output. The framed sentence kept every word fix and left the
    /// punctuation identical to the un-hinted decode. See
    /// docs/evals/dictation-dictionary-fixture-report.md.
    pub fn as_prompt(&self) -> String {
        format!("Vocabulary: {}.", self.terms.join(", "))
    }
}

/// Per-request options for `AsrProvider::transcribe_bytes_with_options`.
/// `Default` is "no options", which is what every path other than dictation
/// passes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptionOptions {
    pub vocabulary_hint: Option<VocabularyHint>,
    /// Ask the recognizer itself to emit English for non-English speech.
    /// Only whisper.cpp with a multilingual model honours it (the `.en`
    /// builds cannot translate); every other provider ignores the flag and
    /// the caller translates the transcript afterwards. See
    /// `resolve_dictation_translation_route` in `lib.rs`.
    pub translate_to_english: bool,
    /// The Apple Speech engine this request requires, when its correctness
    /// depends on one of the two. The meeting route sets `SpeechAnalyzer`
    /// because it is the only one that returns timed segments; every other
    /// caller leaves this `None` and either engine is a correct answer.
    /// Ignored by every provider but Apple Speech.
    pub apple_speech_required_engine: Option<platform::macos_speech::AppleSpeechEngine>,
    /// Ask the provider for speaker labels on this request.
    ///
    /// Only the meeting lane sets it, and only providers that actually
    /// diarize read it. It is a request option rather than a provider
    /// setting because the same provider is used for both lanes and the
    /// answer differs: Gemini's API refuses `custom_vocabulary` on a request
    /// that asks for diarization or word timestamps (confirmed by Google on
    /// 2026-09-01), so dictation gets the dictionary and meetings get the
    /// speakers, and neither lane can silently take the other's shape.
    pub request_speaker_labels: bool,
    /// The transcription language the user selected, as they wrote it
    /// (`"en"`, `"en-US"`, `"fr"`); `None` is the default, meaning auto.
    ///
    /// Local routes ignore it and auto-detect -- whisper.cpp deliberately
    /// passes `None` to its decoder -- but a cloud API has to be *told*
    /// something, and its default is rarely "detect". Deepgram's is English:
    /// with no `language` parameter, a French meeting came back as English
    /// nonsense while the route advertised itself as multilingual. Providers
    /// that read this map it onto their own vocabulary.
    pub language: Option<String>,
}

#[async_trait]
pub trait AsrProvider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn is_available(&self) -> bool;
    fn model_info(&self) -> ModelInfo;
    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult>;
    /// `transcribe` with per-request options, for the whole-file meeting route.
    ///
    /// The default drops them, exactly like `transcribe_bytes_with_options`, so
    /// a provider with nothing to do with them needs no change. Providers with
    /// a whole-file meeting route override it: without this the caller's
    /// options were discarded on the path, and the two providers that have such
    /// a route had to hard-code `request_speaker_labels: true` inside their own
    /// `transcribe` -- a second copy of the caller's intent that nothing kept
    /// in step, and a language or vocabulary hint that could never arrive.
    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let _ = options;
        self.transcribe(audio_path).await
    }
    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult>;
    /// `transcribe_bytes` with per-request options. The default drops the
    /// options on the floor, so a provider that has no use for them (no
    /// prompt or vocabulary field in its API) needs no change; providers that
    /// can bias recognition override this.
    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let _ = options;
        self.transcribe_bytes(audio_data).await
    }
    /// Optionally pre-load the model into the same process cache used by
    /// transcription. Unlike the old best-effort hook, this acknowledgement is
    /// allowed to fail so callers cannot publish a false "model ready" state.
    async fn prewarm(&self) -> Result<()> {
        Ok(())
    }
    fn download_status(&self) -> DownloadStatus;
    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()>;
}

// ---------------------------------------------------------------------------
// Streaming recognition (live preview only)
// ---------------------------------------------------------------------------

/// Sample rate every streaming session accepts. The batch `AsrProvider`s each
/// resample internally from whatever the caller hands them; a streaming
/// session cannot, because it is fed a chunk at a time and a per-chunk
/// resample would restart the interpolation at every boundary. So the contract
/// is explicit: the caller resamples once, continuously, and feeds 16 kHz mono
/// f32.
pub const STREAMING_SAMPLE_RATE_HZ: u32 = 16_000;

/// The chunk sizes a caller may pick from, smallest first.
///
/// A cache-aware streaming FastConformer does not accept an arbitrary chunk:
/// the chunk is the encoder's right-context window, and the model ships a
/// discrete set of operating points. For Nemotron 3.5 ASR Streaming — the only
/// streaming family Plainsong has measured, see
/// `artifacts/qa/transcribe-cpp-spike-2026-09-02.md` — the GGUF port exposes
/// `att_context_right` of 0, 3, 6 or 13, which at 80 ms per frame is 80, 320,
/// 560 and 1120 ms. (NVIDIA's own card also names 160 ms, but the port does not
/// offer the `att_context_right = 1` that would select it, so it is not in this
/// table; the C1 lane brief asked for 160 and this is why it is 320 instead.)
/// 80 ms is left out because at that size the per-chunk call overhead dominates
/// on a machine that is also running the app.
///
/// The tradeoff runs one way: a smaller chunk means the first partial arrives
/// sooner and costs more encoder work per second of audio; a larger one means
/// fewer, better-conditioned partials. 560 ms is the default because it is the
/// largest chunk that still fits a ~600 ms end-to-end preview budget, and
/// `artifacts/qa/streaming-partials-receipt-2026-09-02.md` measures all three.
pub const STREAMING_CHUNK_MS_CHOICES: [u32; 3] = [320, 560, 1120];

/// The chunk size a live preview opens with. Index 1 of the table above.
pub const DEFAULT_STREAMING_CHUNK_MS: u32 = STREAMING_CHUNK_MS_CHOICES[1];

/// Samples in one chunk of `chunk_ms` at [`STREAMING_SAMPLE_RATE_HZ`].
pub fn streaming_chunk_samples(chunk_ms: u32) -> usize {
    (u64::from(STREAMING_SAMPLE_RATE_HZ) * u64::from(chunk_ms.max(1)) / 1000).max(1) as usize
}

/// One live-preview update from a streaming recognizer.
///
/// `stable_prefix` is text the recognizer has committed to; `volatile_suffix`
/// is the tail it may still rewrite. Splitting them is the whole point of a
/// streaming display: the committed half can be rendered as settled text, the
/// volatile half as something still being heard.
///
/// This is a *preview* type. Nothing in it may reach the inserted transcript —
/// see `docs/streaming-dictation-plan.md` and the source-scan test
/// `dictation_insertion_never_reads_a_streaming_partial` in `lib.rs`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Partial {
    pub stable_prefix: String,
    pub volatile_suffix: String,
    /// Audio fed to the session so far, in seconds. Latency measurements
    /// subtract this from wall clock; the UI does not read it.
    pub elapsed_audio_s: f64,
}

impl Partial {
    /// Everything the recognizer currently believes, committed half first.
    pub fn display_text(&self) -> String {
        let mut text = String::with_capacity(self.stable_prefix.len() + self.volatile_suffix.len());
        text.push_str(&self.stable_prefix);
        text.push_str(&self.volatile_suffix);
        text
    }

    pub fn is_empty(&self) -> bool {
        self.stable_prefix.trim().is_empty() && self.volatile_suffix.trim().is_empty()
    }
}

/// A mutable, single-utterance streaming recognition session.
///
/// Deliberately *not* the same shape as [`AsrProvider`]: that trait is
/// `Send + Sync` and takes `&self` because a batch decode is a pure function of
/// its audio. A streaming session is the opposite — a state machine that only
/// makes sense fed in order, from one place — so it takes `&mut self` and is
/// `Send` but not `Sync`.
pub trait StreamingAsrSession: Send {
    /// Feed the next chunk of 16 kHz mono PCM and return the current preview.
    /// Chunks should be [`StreamingAsrSession::chunk_samples`] long; a shorter
    /// or longer one is accepted, but the recognizer is not tuned for it.
    fn feed(&mut self, pcm16k: &[f32]) -> Result<Partial>;

    /// Signal end of input: flush whatever is buffered and return the last
    /// preview. The session is finished afterwards; `reset` starts a new one.
    ///
    /// This is still a preview. The inserted text is the batch decode.
    fn finalize(&mut self) -> Result<Partial>;

    /// Abandon the current utterance and return to a fresh state, keeping the
    /// loaded model. Used when a pause is long enough that continuing would
    /// make the recognizer condition new speech on stale context.
    fn reset(&mut self) -> Result<()>;

    /// The chunk size this session was opened with, in samples.
    fn chunk_samples(&self) -> usize {
        streaming_chunk_samples(DEFAULT_STREAMING_CHUNK_MS)
    }
}

/// Opens [`StreamingAsrSession`]s. Separate from [`AsrProvider`] because
/// almost no ASR route can do this: it needs a model trained for cache-aware
/// streaming and a runtime that exposes it.
pub trait StreamingAsrProvider: Send + Sync {
    /// Short engine name for logs and receipts, e.g. `transcribe.cpp Nemotron`.
    fn streaming_engine_name(&self) -> &str;

    /// The model id whose weights back this engine, for the Models screen.
    fn streaming_model_id(&self) -> &str;

    /// Whether the weights are on disk *and* carry a trusted integrity
    /// receipt. A half-downloaded GGUF is not available.
    fn is_streaming_available(&self) -> bool;

    /// Whether this engine covers `language` (an ISO code, or `None` for
    /// "let the recognizer decide").
    fn supports_language(&self, language: Option<&str>) -> bool;

    /// Load the model and begin a session. Blocking and slow (model load), so
    /// callers run it off the async runtime.
    fn open_session(&self, language_hint: Option<&str>) -> Result<Box<dyn StreamingAsrSession>>;
}

/// Cuts arbitrary-length PCM pushes into whole streaming chunks.
///
/// The capture callback hands over whatever the device gave it; the recognizer
/// wants a fixed chunk. This holds the remainder between pushes so no sample is
/// dropped or fed twice.
#[derive(Debug)]
pub struct PcmChunker {
    chunk_samples: usize,
    pending: Vec<f32>,
}

impl PcmChunker {
    pub fn new(chunk_samples: usize) -> Self {
        Self {
            chunk_samples: chunk_samples.max(1),
            pending: Vec::new(),
        }
    }

    /// Append `samples` and return every whole chunk that is now available.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.pending.extend_from_slice(samples);
        let mut chunks = Vec::new();
        while self.pending.len() >= self.chunk_samples {
            chunks.push(self.pending.drain(..self.chunk_samples).collect());
        }
        chunks
    }

    /// Take the partial tail, for the last feed before `finalize`.
    pub fn take_remainder(&mut self) -> Option<Vec<f32>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }

    pub fn pending_samples(&self) -> usize {
        self.pending.len()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

/// The display state of one live preview.
///
/// Two jobs, both about not lying to the eye:
///
/// 1. The committed prefix is append-only within an utterance. A family that
///    briefly reports a *shorter* committed prefix (the same words, fewer of
///    them) would make settled text flicker away and back, so a strict prefix
///    of what is already shown is ignored. Anything else replaces it: if the
///    recognizer genuinely retracted words, continuing to show them would be
///    the worse lie.
/// 2. Repeated identical text is not re-emitted, so the popup does not
///    re-animate on every chunk that changed nothing.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StreamingPartialTracker {
    stable: String,
    volatile: String,
}

impl StreamingPartialTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one partial in. Returns true when the rendered text changed.
    pub fn accept(&mut self, partial: &Partial) -> bool {
        let incoming_stable = partial.stable_prefix.as_str();
        let keep_existing =
            incoming_stable.len() < self.stable.len() && self.stable.starts_with(incoming_stable);
        let (next_stable, next_volatile) = if keep_existing {
            // Keeping the longer committed prefix means the incoming split
            // point is behind ours, so the incoming *suffix* still contains
            // words we already show as committed. Re-split the incoming whole
            // text at our own boundary instead of pasting the two halves
            // together, which would render "ship the" + " the release".
            let incoming_whole = format!("{incoming_stable}{}", partial.volatile_suffix);
            let tail = incoming_whole
                .strip_prefix(self.stable.as_str())
                .map(str::to_string)
                // The recognizer rewrote something inside the prefix we are
                // holding, so there is no boundary to cut at. Showing the raw
                // suffix repeats fewer words than pasting the whole thing.
                .unwrap_or_else(|| partial.volatile_suffix.clone());
            (self.stable.clone(), tail)
        } else {
            (incoming_stable.to_string(), partial.volatile_suffix.clone())
        };
        if next_stable == self.stable && next_volatile == self.volatile {
            return false;
        }
        self.stable = next_stable;
        self.volatile = next_volatile;
        true
    }

    /// Drop everything, for a new utterance after a pause.
    pub fn reset(&mut self) {
        self.stable.clear();
        self.volatile.clear();
    }

    pub fn stable(&self) -> &str {
        &self.stable
    }

    pub fn volatile(&self) -> &str {
        &self.volatile
    }

    pub fn display(&self) -> String {
        format!("{}{}", self.stable, self.volatile)
    }

    pub fn is_empty(&self) -> bool {
        self.stable.trim().is_empty() && self.volatile.trim().is_empty()
    }
}

/// Continuous linear resampler to [`STREAMING_SAMPLE_RATE_HZ`].
///
/// `audio/utils.rs` resamples a whole clip in one call; a streaming preview
/// gets the audio a few hundred samples at a time, and calling that per chunk
/// restarts the interpolation at every boundary — a discontinuity at every
/// seam and a slow drift in total length. This carries the fractional read
/// position and the last input sample across calls instead.
#[derive(Debug)]
pub struct StreamingResampler {
    from_rate: u32,
    /// Read position, in input samples, into `carry ++ input`.
    position: f64,
    step: f64,
    carry: Option<f32>,
}

impl StreamingResampler {
    pub fn new(from_rate: u32) -> Self {
        let from_rate = from_rate.max(1);
        Self {
            from_rate,
            position: 0.0,
            step: f64::from(from_rate) / f64::from(STREAMING_SAMPLE_RATE_HZ),
            carry: None,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        self.from_rate == STREAMING_SAMPLE_RATE_HZ
    }

    /// Resample `input`, continuing where the previous call stopped.
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        if self.is_passthrough() {
            return input.to_vec();
        }
        // One virtual buffer: the sample carried over from last time, then the
        // new input. `position` indexes into it.
        let carry = self.carry;
        let carry_len = usize::from(carry.is_some());
        let total = carry_len + input.len();
        let sample_at = |index: usize| -> f32 {
            if index < carry_len {
                carry.unwrap_or(0.0)
            } else {
                input[index - carry_len]
            }
        };

        let mut output = Vec::with_capacity((input.len() as f64 / self.step).ceil() as usize + 1);
        while self.position + 1.0 < total as f64 {
            let index = self.position as usize;
            let frac = (self.position - index as f64) as f32;
            let a = sample_at(index);
            let b = sample_at(index + 1);
            output.push(a * (1.0 - frac) + b * frac);
            self.position += self.step;
        }
        // Keep the last input sample and rebase the position onto it, so the
        // next call interpolates across the boundary rather than from zero.
        self.carry = Some(input[input.len() - 1]);
        self.position = (self.position - (total - 1) as f64).max(0.0);
        output
    }
}

pub struct AsrProviderFactory;

/// The streaming seam, exercised without a GGUF.
///
/// Everything the dictation preview depends on that is not the recognizer
/// itself lives here — chunking, stable/volatile bookkeeping, ordering, the
/// continuous resampler — so a machine with no model on disk still fails when
/// one of them regresses.
#[cfg(test)]
mod streaming_seam_tests {
    use super::{
        streaming_chunk_samples, Partial, PcmChunker, StreamingAsrSession, StreamingPartialTracker,
        StreamingResampler, DEFAULT_STREAMING_CHUNK_MS, STREAMING_CHUNK_MS_CHOICES,
        STREAMING_SAMPLE_RATE_HZ,
    };
    use anyhow::Result;

    /// A session that replays a scripted transcript, one word per feed, and
    /// records the calls it received. It commits every word but the last, the
    /// way a stable-prefix policy does.
    struct StubStreamingSession {
        words: Vec<&'static str>,
        fed_chunks: usize,
        fed_samples: usize,
        calls: Vec<&'static str>,
        finalized: bool,
        fail_after_finalize: bool,
    }

    impl StubStreamingSession {
        fn new(words: &[&'static str]) -> Self {
            Self {
                words: words.to_vec(),
                fed_chunks: 0,
                fed_samples: 0,
                calls: Vec::new(),
                finalized: false,
                fail_after_finalize: true,
            }
        }

        fn partial(&self) -> Partial {
            let shown = self.words.iter().take(self.fed_chunks).count();
            let committed = shown.saturating_sub(1);
            Partial {
                stable_prefix: self.words[..committed].join(" "),
                volatile_suffix: if shown > committed {
                    let mut tail = String::new();
                    if committed > 0 {
                        tail.push(' ');
                    }
                    tail.push_str(self.words[committed..shown].join(" ").as_str());
                    tail
                } else {
                    String::new()
                },
                elapsed_audio_s: self.fed_samples as f64 / f64::from(STREAMING_SAMPLE_RATE_HZ),
            }
        }
    }

    impl StreamingAsrSession for StubStreamingSession {
        fn feed(&mut self, pcm16k: &[f32]) -> Result<Partial> {
            self.calls.push("feed");
            if self.finalized && self.fail_after_finalize {
                anyhow::bail!("fed a finished stream");
            }
            self.fed_samples += pcm16k.len();
            self.fed_chunks = (self.fed_chunks + 1).min(self.words.len());
            Ok(self.partial())
        }

        fn finalize(&mut self) -> Result<Partial> {
            self.calls.push("finalize");
            self.finalized = true;
            self.fed_chunks = self.words.len();
            let mut partial = self.partial();
            partial.stable_prefix = self.words.join(" ");
            partial.volatile_suffix.clear();
            Ok(partial)
        }

        fn reset(&mut self) -> Result<()> {
            self.calls.push("reset");
            self.finalized = false;
            self.fed_chunks = 0;
            Ok(())
        }
    }

    #[test]
    fn the_chunk_table_is_ordered_and_the_default_is_one_of_it() {
        let mut sorted = STREAMING_CHUNK_MS_CHOICES;
        sorted.sort_unstable();
        assert_eq!(
            sorted, STREAMING_CHUNK_MS_CHOICES,
            "the table must be ordered"
        );
        assert!(STREAMING_CHUNK_MS_CHOICES.contains(&DEFAULT_STREAMING_CHUNK_MS));
        assert_eq!(streaming_chunk_samples(560), 8_960);
        assert_eq!(streaming_chunk_samples(320), 5_120);
        assert_eq!(streaming_chunk_samples(1120), 17_920);
        // Never zero, whatever a caller does.
        assert_eq!(streaming_chunk_samples(0), 16);
    }

    #[test]
    fn the_chunker_never_drops_or_repeats_a_sample() {
        let mut chunker = PcmChunker::new(4);
        let mut seen: Vec<f32> = Vec::new();
        // Deliberately ragged pushes, the way a capture callback arrives.
        for push in [
            vec![1.0, 2.0, 3.0],
            vec![4.0],
            vec![5.0, 6.0, 7.0, 8.0, 9.0],
        ] {
            for chunk in chunker.push(&push) {
                assert_eq!(chunk.len(), 4);
                seen.extend(chunk);
            }
        }
        assert_eq!(seen, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        assert_eq!(chunker.pending_samples(), 1);
        assert_eq!(chunker.take_remainder(), Some(vec![9.0]));
        assert_eq!(chunker.take_remainder(), None);
    }

    #[test]
    fn a_session_is_fed_whole_chunks_in_order_and_finalized_once() {
        let mut session = StubStreamingSession::new(&["ship", "the", "release"]);
        let mut chunker = PcmChunker::new(streaming_chunk_samples(DEFAULT_STREAMING_CHUNK_MS));
        let mut tracker = StreamingPartialTracker::new();

        // 3 chunks' worth of audio, delivered in 100 ms slices.
        let slice = vec![0.01f32; streaming_chunk_samples(100)];
        let mut emitted: Vec<String> = Vec::new();
        for _ in 0..17 {
            for chunk in chunker.push(&slice) {
                let partial = session.feed(&chunk).expect("feed");
                if tracker.accept(&partial) {
                    emitted.push(tracker.display());
                }
            }
        }
        let final_partial = session.finalize().expect("finalize");
        assert!(tracker.accept(&final_partial));
        emitted.push(tracker.display());

        // 1700 ms of audio is three whole 560 ms chunks, and 20 ms is left
        // pending rather than fed short.
        assert_eq!(
            session.calls,
            vec!["feed", "feed", "feed", "finalize"],
            "feeds must all precede the single finalize"
        );
        assert_eq!(
            chunker.pending_samples(),
            streaming_chunk_samples(100) * 17 % 8_960
        );
        assert_eq!(
            emitted,
            vec![
                "ship".to_string(),
                // The last emit renders the same words: finalize moves the
                // tail from volatile to stable, which the popup shows
                // differently even though the text is unchanged.
                "ship the".to_string(),
                "ship the release".to_string(),
                "ship the release".to_string(),
            ],
            "identical text must not be re-emitted once the stub runs out of words"
        );
        assert_eq!(tracker.stable(), "ship the release");
        assert_eq!(tracker.volatile(), "");
        assert_eq!(tracker.display(), "ship the release");
    }

    #[test]
    fn feeding_a_finalized_session_is_an_error_until_it_is_reset() {
        let mut session = StubStreamingSession::new(&["one", "two"]);
        session.feed(&[0.0; 16]).expect("first feed");
        session.finalize().expect("finalize");
        assert!(
            session.feed(&[0.0; 16]).is_err(),
            "a finished stream must not silently accept more audio"
        );
        session.reset().expect("reset");
        assert!(
            session.feed(&[0.0; 16]).is_ok(),
            "reset reopens the session"
        );
        assert_eq!(
            session.calls,
            vec!["feed", "finalize", "feed", "reset", "feed"]
        );
    }

    #[test]
    fn the_tracker_keeps_committed_text_from_flickering_away() {
        let mut tracker = StreamingPartialTracker::new();
        assert!(tracker.accept(&Partial {
            stable_prefix: "ship the".to_string(),
            volatile_suffix: " rel".to_string(),
            elapsed_audio_s: 1.1,
        }));
        // A shorter committed prefix that is a prefix of what is shown is
        // flicker, not a retraction: keep the longer one.
        assert!(tracker.accept(&Partial {
            stable_prefix: "ship".to_string(),
            volatile_suffix: " the release".to_string(),
            elapsed_audio_s: 1.7,
        }));
        assert_eq!(tracker.stable(), "ship the");
        // The tail is re-cut at the boundary we kept, so the two words the
        // incoming suffix re-sent are not shown twice.
        assert_eq!(tracker.volatile(), " release");
        assert_eq!(
            tracker.display(),
            "ship the release",
            "holding the longer prefix must not duplicate the words the \
             incoming suffix repeats"
        );
    }

    #[test]
    fn a_rewrite_under_a_held_prefix_falls_back_to_the_incoming_suffix() {
        let mut tracker = StreamingPartialTracker::new();
        assert!(tracker.accept(&Partial {
            stable_prefix: "ship the".to_string(),
            volatile_suffix: " rel".to_string(),
            elapsed_audio_s: 1.1,
        }));
        // Shorter *and* a prefix of what is shown, so the flicker guard holds
        // "ship the" -- but the incoming whole text ("ship a release") no
        // longer starts with it, so there is no boundary to cut at. Showing
        // the raw suffix is the least-wrong fallback, and it must never
        // repeat the held prefix.
        assert!(tracker.accept(&Partial {
            stable_prefix: "ship".to_string(),
            volatile_suffix: " a release".to_string(),
            elapsed_audio_s: 1.7,
        }));
        assert_eq!(tracker.stable(), "ship the");
        assert_eq!(tracker.display(), "ship the a release");
        assert!(
            !tracker.display().contains("ship the ship"),
            "the held prefix must not appear twice"
        );
    }

    #[test]
    fn every_flicker_guarded_step_renders_each_word_once() {
        // A recognizer whose committed boundary walks backwards and forwards
        // over the same utterance. Whatever the split, `display()` must stay
        // a plain prefix of the finished sentence.
        let mut tracker = StreamingPartialTracker::new();
        let steps = [
            ("ship", " the"),
            ("ship the", " rel"),
            ("ship", " the release"),
            ("ship the", " release"),
            ("ship the release", ""),
        ];
        for (stable_prefix, volatile_suffix) in steps {
            tracker.accept(&Partial {
                stable_prefix: stable_prefix.to_string(),
                volatile_suffix: volatile_suffix.to_string(),
                elapsed_audio_s: 1.0,
            });
            assert!(
                "ship the release".starts_with(tracker.display().as_str()),
                "rendered {:?}, which is not a prefix of the utterance",
                tracker.display()
            );
        }
        assert_eq!(tracker.display(), "ship the release");
    }

    #[test]
    fn the_tracker_follows_a_real_retraction_rather_than_showing_dropped_words() {
        let mut tracker = StreamingPartialTracker::new();
        tracker.accept(&Partial {
            stable_prefix: "ship the reelase".to_string(),
            volatile_suffix: String::new(),
            elapsed_audio_s: 1.1,
        });
        // Different words, not a prefix: the recognizer changed its mind and
        // the display must follow it.
        assert!(tracker.accept(&Partial {
            stable_prefix: "ship the release".to_string(),
            volatile_suffix: String::new(),
            elapsed_audio_s: 1.7,
        }));
        assert_eq!(tracker.display(), "ship the release");
    }

    #[test]
    fn an_unchanged_partial_is_not_re_emitted() {
        let mut tracker = StreamingPartialTracker::new();
        let partial = Partial {
            stable_prefix: "ship".to_string(),
            volatile_suffix: " the".to_string(),
            elapsed_audio_s: 0.6,
        };
        assert!(tracker.accept(&partial));
        assert_eq!(tracker.display(), "ship the");
        assert!(!tracker.accept(&partial), "no change, no emit");
        assert!(!tracker.accept(&Partial {
            elapsed_audio_s: 1.2,
            ..partial.clone()
        }));
        assert_eq!(tracker.display(), "ship the");
    }

    #[test]
    fn resetting_on_silence_clears_the_display_and_starts_a_new_utterance() {
        let mut tracker = StreamingPartialTracker::new();
        tracker.accept(&Partial {
            stable_prefix: "first sentence".to_string(),
            volatile_suffix: String::new(),
            elapsed_audio_s: 2.0,
        });
        tracker.reset();
        assert!(tracker.is_empty());
        assert_eq!(tracker.display(), "");
        // The same text again after a reset counts as a change, so the popup
        // is repopulated rather than left blank.
        assert!(tracker.accept(&Partial {
            stable_prefix: "first sentence".to_string(),
            volatile_suffix: String::new(),
            elapsed_audio_s: 0.6,
        }));
        assert_eq!(tracker.display(), "first sentence");
    }

    #[test]
    fn partial_display_text_joins_the_two_halves_in_order() {
        let partial = Partial {
            stable_prefix: "ship the".to_string(),
            volatile_suffix: " release".to_string(),
            elapsed_audio_s: 1.4,
        };
        assert_eq!(partial.display_text(), "ship the release");
        assert!(!partial.is_empty());
        assert!(Partial::default().is_empty());
        assert!(Partial {
            stable_prefix: "   ".to_string(),
            volatile_suffix: "\n".to_string(),
            elapsed_audio_s: 0.0,
        }
        .is_empty());
    }

    #[test]
    fn the_resampler_is_a_passthrough_at_the_streaming_rate() {
        let mut resampler = StreamingResampler::new(STREAMING_SAMPLE_RATE_HZ);
        assert!(resampler.is_passthrough());
        assert_eq!(resampler.push(&[0.25, -0.5]), vec![0.25, -0.5]);
    }

    #[test]
    fn resampling_in_chunks_matches_resampling_the_whole_signal() {
        // A ramp makes an interpolation restart at a chunk boundary obvious:
        // the output would step backwards there.
        let from_rate = 48_000;
        let input: Vec<f32> = (0..48_000).map(|i| i as f32 / 48_000.0).collect();

        let mut whole = StreamingResampler::new(from_rate);
        let whole_out = whole.push(&input);

        let mut chunked = StreamingResampler::new(from_rate);
        let mut chunked_out = Vec::new();
        for slice in input.chunks(517) {
            chunked_out.extend(chunked.push(slice));
        }

        // One second of 48 kHz becomes one second of 16 kHz, within a sample.
        assert!(
            (whole_out.len() as i64 - 16_000).abs() <= 2,
            "whole: {} samples",
            whole_out.len()
        );
        assert!(
            (chunked_out.len() as i64 - whole_out.len() as i64).abs() <= 2,
            "chunked {} vs whole {}",
            chunked_out.len(),
            whole_out.len()
        );
        for (index, value) in chunked_out.iter().enumerate().take(whole_out.len()) {
            assert!(
                (value - whole_out[index]).abs() < 1e-4,
                "sample {index} drifted: {} vs {}",
                value,
                whole_out[index]
            );
        }
        // And it never steps backwards across a seam.
        for pair in chunked_out.windows(2) {
            assert!(pair[1] >= pair[0] - 1e-6, "ramp went backwards: {pair:?}");
        }
    }
}

/// The sink exists so a failed cleanup reaches an audit record instead of a log
/// line, so what is asserted is that it keeps what it is given and stays
/// bounded when nobody drains it.
///
/// One test rather than two: the sink is process-wide, and two tests draining
/// it in parallel would race each other rather than test anything.
#[cfg(test)]
mod provider_cleanup_warning_tests {
    use super::{
        record_provider_cleanup_warning, take_provider_cleanup_warnings,
        PROVIDER_CLEANUP_WARNING_LIMIT,
    };

    #[test]
    fn cleanup_warnings_are_kept_for_the_drainer_and_stay_bounded() {
        let marker = "plainsong-cleanup-marker";
        record_provider_cleanup_warning(format!("{marker}: the upload was not deleted"));
        let drained = take_provider_cleanup_warnings();
        assert!(
            drained.iter().any(|warning| warning.contains(marker)),
            "a recorded warning must survive to the drainer"
        );
        assert!(
            take_provider_cleanup_warnings().is_empty(),
            "draining must leave the sink empty, or a warning is reported twice"
        );

        for index in 0..(PROVIDER_CLEANUP_WARNING_LIMIT * 2) {
            record_provider_cleanup_warning(format!("{marker}-flood-{index}"));
        }
        let flooded = take_provider_cleanup_warnings();
        assert!(
            flooded.len() <= PROVIDER_CLEANUP_WARNING_LIMIT,
            "a backlog nobody drained must not grow without bound"
        );
        // The oldest are the ones dropped, so the most recent failure -- the
        // one a user is most likely to still be able to act on -- survives.
        assert!(flooded
            .last()
            .is_some_and(|warning| warning.ends_with(&format!(
                "-flood-{}",
                PROVIDER_CLEANUP_WARNING_LIMIT * 2 - 1
            ))));
    }
}

/// The upload path exists to keep a whole meeting out of memory, so that is
/// what is asserted: bounded chunks, in order, adding up to the file, with the
/// declared length matching what will actually be sent.
#[cfg(test)]
mod upload_streaming_tests {
    use super::{streaming_wav_body, upload_chunk_stream, UPLOAD_CHUNK_BYTES};
    use futures_util::StreamExt;

    #[tokio::test]
    async fn a_large_upload_is_read_in_bounded_chunks_not_all_at_once() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-upload-stream-{}.wav",
            uuid::Uuid::new_v4()
        ));
        // Two and a half read buffers: large enough that "read whole" and
        // "read in chunks" are distinguishable, small enough to stay a unit
        // test.
        let payload: Vec<u8> = (0..UPLOAD_CHUNK_BYTES * 5 / 2)
            .map(|index| (index % 251) as u8)
            .collect();
        tokio::fs::write(&path, &payload)
            .await
            .expect("fixture write");

        let (_body, declared) = streaming_wav_body(&path).await.expect("streaming body");
        assert_eq!(
            declared,
            payload.len() as u64,
            "the length a caller declares in a header must be the file's own"
        );

        let file = tokio::fs::File::open(&path).await.expect("reopen fixture");
        let chunks: Vec<Vec<u8>> = upload_chunk_stream(file)
            .map(|chunk| chunk.expect("chunk read"))
            .collect()
            .await;

        assert!(
            chunks.len() > 1,
            "a file larger than one buffer must arrive in more than one chunk,              or it was read whole after all"
        );
        for chunk in &chunks {
            assert!(
                chunk.len() <= UPLOAD_CHUNK_BYTES,
                "peak memory is one buffer, not the length of the meeting"
            );
        }
        assert_eq!(
            chunks.concat(),
            payload,
            "the streamed bytes must be the file's bytes, in order"
        );

        let _ = tokio::fs::remove_file(&path).await;
    }
}

/// A marker no provider error may ever carry, used by the body-leak tests in
/// this module and in each provider.
#[cfg(test)]
pub(crate) const CLOUD_ASR_BODY_MARKER: &str = "secret-transcript-marker";

/// A real `reqwest::Response` with the given status and a body containing
/// [`CLOUD_ASR_BODY_MARKER`], served over a loopback socket.
///
/// The tests that assert "the body never reaches the message" used to build no
/// response at all: they called `cloud_asr_status_error(label, status)`, which
/// has no body in scope, and then asserted the marker was absent from the
/// result. That could not have failed. Serving a real response is what makes
/// the assertion mean something -- the marker is genuinely present in the
/// response the code is handed.
#[cfg(test)]
pub(crate) async fn cloud_asr_error_response_fixture(
    status: u16,
    reason: &str,
) -> reqwest::Response {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let body = format!(r#"{{"err_code":9,"err_msg":"{CLOUD_ASR_BODY_MARKER}"}}"#);
    assert!(
        body.contains(CLOUD_ASR_BODY_MARKER),
        "the fixture body must actually carry the marker"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port for the fixture");
    let address = listener.local_addr().expect("fixture address");
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });

    reqwest::Client::new()
        .get(format!("http://{address}/"))
        .send()
        .await
        .expect("fixture response")
}

#[cfg(test)]
mod cloud_response_security_tests {
    use super::{
        cloud_asr_error_response_fixture, cloud_asr_response_error, CLOUD_ASR_BODY_MARKER,
    };

    #[tokio::test]
    async fn provider_status_errors_never_include_response_body_content() {
        // First, proof that the marker really does arrive over the wire, so
        // the assertion below is about the code and not about an empty body.
        let served = cloud_asr_error_response_fixture(400, "Bad Request").await;
        assert_eq!(served.status(), reqwest::StatusCode::BAD_REQUEST);
        assert!(served
            .text()
            .await
            .expect("fixture body")
            .contains(CLOUD_ASR_BODY_MARKER));

        let response = cloud_asr_error_response_fixture(400, "Bad Request").await;
        let error = cloud_asr_response_error("Test ASR", response);
        let rendered = format!("{error:#}");

        assert!(rendered.contains("Test ASR"));
        assert!(rendered.contains("400"));
        assert!(
            !rendered.contains(CLOUD_ASR_BODY_MARKER),
            "a provider error body reached the message: {rendered}"
        );
        // Exact, not "does not contain the marker": the message may carry the
        // provider and the status and nothing else, so a future addition of a
        // URL, a key or a snippet fails here too.
        assert_eq!(rendered, "Test ASR API returned HTTP 400");
    }
}

/// The transcribe.cpp spike is compiled out of the default build, and this is
/// the test that proves it rather than trusting the `#[cfg]`s to be spelled
/// right. Both halves run: the default build asserts the route cannot be
/// named, and the feature build asserts it appears exactly once and as an
/// extra route, not a replacement.
#[cfg(test)]
mod transcribe_cpp_feature_gate_tests {
    use super::AsrProviderType;

    #[cfg(not(feature = "asr-transcribe-cpp"))]
    #[test]
    fn the_default_build_has_no_transcribe_cpp_route_at_all() {
        // There is no variant, so a settings file or an IPC payload naming it
        // cannot deserialize into one.
        assert!(serde_json::from_str::<AsrProviderType>("\"transcribe_cpp\"").is_err());
        assert!(AsrProviderType::all()
            .iter()
            .all(|provider| provider.display_name() != "transcribe.cpp (experimental)"));
        assert!(AsrProviderType::all()
            .iter()
            .flat_map(|provider| provider.model_options())
            .all(|option| !option.id.contains("q8_0")));
    }

    #[cfg(feature = "asr-transcribe-cpp")]
    #[test]
    fn the_spike_build_adds_exactly_one_experimental_route_and_replaces_nothing() {
        let all = AsrProviderType::all();
        assert!(all.contains(&AsrProviderType::TranscribeCpp));
        // Every route the default build offers is still there.
        for provider in [
            AsrProviderType::Whisper,
            AsrProviderType::Parakeet,
            AsrProviderType::WhisperCandle,
            AsrProviderType::DistilWhisper,
            AsrProviderType::MacosAppleSpeech,
            AsrProviderType::Moonshine,
            AsrProviderType::WindowsSdkDictation,
            AsrProviderType::ElevenLabsScribe,
            AsrProviderType::OpenAiCloud,
            AsrProviderType::Groq,
            AsrProviderType::CohereTranscribe,
            AsrProviderType::Qwen3Asr,
        ] {
            assert!(all.contains(&provider), "{provider:?} disappeared");
        }
        assert_eq!(
            serde_json::from_str::<AsrProviderType>("\"transcribe_cpp\"").unwrap(),
            AsrProviderType::TranscribeCpp
        );
        // One model in the picker: the Nemotron streaming GGUF the benchmark
        // loads is deliberately not a route.
        assert_eq!(AsrProviderType::TranscribeCpp.model_options().len(), 1);
        assert_eq!(
            AsrProviderType::TranscribeCpp.default_model_id(),
            super::transcribe_cpp::PARAKEET_GGUF_MODEL_ID
        );
        assert!(AsrProviderType::TranscribeCpp
            .provider_secret_name()
            .is_none());
    }
}

/// ASR Provider type
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderType {
    Whisper,
    Parakeet,
    WhisperCandle,
    DistilWhisper,
    MacosAppleSpeech,
    Moonshine,
    WindowsSdkDictation,
    ElevenLabsScribe,
    OpenAiCloud,
    Groq,
    CohereTranscribe,
    /// The same Cohere Transcribe weights as `CohereTranscribe`, run locally
    /// on ONNX Runtime instead of over Cohere's API. Experimental, and never
    /// a default: see `asr/cohere_local.rs`.
    CohereLocal,
    Qwen3Asr,
    Deepgram,
    GeminiTranscribe,
    /// The transcribe.cpp spike route (feature `asr-transcribe-cpp`, OFF by
    /// default). It exists in the enum only when the spike is compiled in, so
    /// a default build cannot name it, offer it, or persist it.
    #[cfg(feature = "asr-transcribe-cpp")]
    TranscribeCpp,
}

impl AsrProviderType {
    pub fn all() -> Vec<AsrProviderType> {
        vec![
            AsrProviderType::Whisper,
            AsrProviderType::Parakeet,
            AsrProviderType::WhisperCandle,
            AsrProviderType::DistilWhisper,
            AsrProviderType::MacosAppleSpeech,
            AsrProviderType::Moonshine,
            AsrProviderType::WindowsSdkDictation,
            AsrProviderType::ElevenLabsScribe,
            AsrProviderType::OpenAiCloud,
            AsrProviderType::Groq,
            AsrProviderType::CohereTranscribe,
            AsrProviderType::CohereLocal,
            AsrProviderType::Qwen3Asr,
            AsrProviderType::Deepgram,
            AsrProviderType::GeminiTranscribe,
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp,
        ]
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "OpenAI Whisper",
            AsrProviderType::Parakeet => "NVIDIA Parakeet",
            AsrProviderType::WhisperCandle => "Whisper Candle",
            AsrProviderType::DistilWhisper => "Distil Whisper",
            AsrProviderType::MacosAppleSpeech => "Apple Speech (On-Device)",
            AsrProviderType::Moonshine => "UsefulSensors Moonshine",
            AsrProviderType::WindowsSdkDictation => "Windows Native Speech",
            AsrProviderType::ElevenLabsScribe => "ElevenLabs Scribe",
            AsrProviderType::OpenAiCloud => "OpenAI Whisper (Cloud)",
            AsrProviderType::Groq => "Groq Whisper (Cloud)",
            AsrProviderType::CohereTranscribe => "Cohere Transcribe",
            AsrProviderType::CohereLocal => "Cohere Transcribe (Local)",
            AsrProviderType::Qwen3Asr => "Qwen3-ASR (Local)",
            AsrProviderType::Deepgram => "Deepgram Nova",
            AsrProviderType::GeminiTranscribe => "Google Gemini Transcribe",
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => "transcribe.cpp (experimental)",
        }
    }

    pub fn default_model_id(&self) -> &'static str {
        match self {
            AsrProviderType::Whisper => "base.en",
            AsrProviderType::Parakeet => "parakeet-tdt-0.6b-v3",
            AsrProviderType::WhisperCandle => "whisper-large-v3-turbo",
            AsrProviderType::DistilWhisper => "distil-large-v3.5",
            AsrProviderType::MacosAppleSpeech => "macos_apple_speech",
            AsrProviderType::Moonshine => "moonshine-base",
            AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation",
            // scribe_v2_realtime is websocket-only and cannot be served by
            // this provider's batch /v1/speech-to-text endpoint -- see
            // elevenlabs_scribe.rs's sanitize_elevenlabs_asr_model_id.
            AsrProviderType::ElevenLabsScribe => "scribe_v2",
            // Verified live against
            // https://developers.openai.com/api/docs/guides/speech-to-text on
            // 2026-08-27: gpt-transcribe is OpenAI's current recommended
            // default for this endpoint, superseding whisper-1.
            AsrProviderType::OpenAiCloud => "gpt-transcribe",
            AsrProviderType::Groq => "whisper-large-v3-turbo",
            AsrProviderType::CohereTranscribe => "cohere-transcribe-03-2026",
            AsrProviderType::CohereLocal => cohere_local::COHERE_LOCAL_MODEL_ID,
            AsrProviderType::Qwen3Asr => "qwen3-asr-0.6b",
            // Verified live against
            // https://developers.deepgram.com/docs/pre-recorded-audio on
            // 2026-09-02: nova-3 is Deepgram's current general model for the
            // batch /v1/listen endpoint, and the only family that accepts
            // keyterm prompting.
            AsrProviderType::Deepgram => "nova-3",
            // Verified live against
            // https://ai.google.dev/gemini-api/docs/transcribe on 2026-09-02.
            // gemini-3.5-transcribe-live is deliberately excluded: it is the
            // websocket model, it cannot diarize, and this provider posts to
            // the batch interactions endpoint.
            AsrProviderType::GeminiTranscribe => "gemini-3.5-transcribe",
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => transcribe_cpp::PARAKEET_GGUF_MODEL_ID,
        }
    }

    /// Canonical credential slot so reset coverage follows the exhaustive provider enum.
    pub fn provider_secret_name(self) -> Option<&'static str> {
        match self {
            AsrProviderType::ElevenLabsScribe => Some("elevenlabs"),
            AsrProviderType::OpenAiCloud => Some("openai"),
            AsrProviderType::Groq => Some("groq"),
            AsrProviderType::CohereTranscribe => Some("cohere"),
            AsrProviderType::Deepgram => Some("deepgram"),
            AsrProviderType::GeminiTranscribe => Some("gemini"),
            AsrProviderType::Whisper
            | AsrProviderType::Parakeet
            | AsrProviderType::WhisperCandle
            | AsrProviderType::DistilWhisper
            | AsrProviderType::MacosAppleSpeech
            | AsrProviderType::Moonshine
            | AsrProviderType::WindowsSdkDictation
            | AsrProviderType::CohereLocal
            | AsrProviderType::Qwen3Asr => None,
            // Local weights on disk; no credential slot, like every other
            // local route.
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => None,
        }
    }

    pub fn model_options(&self) -> Vec<ModelOption> {
        match self {
            AsrProviderType::Whisper => vec![
                ModelOption {
                    id: "tiny".to_string(),
                    label: "tiny (fastest)".to_string(),
                },
                ModelOption {
                    id: "tiny.en".to_string(),
                    label: "tiny.en (fastest, English)".to_string(),
                },
                ModelOption {
                    id: "base".to_string(),
                    label: "base (balanced)".to_string(),
                },
                ModelOption {
                    id: "base.en".to_string(),
                    label: "base.en (balanced, English)".to_string(),
                },
                ModelOption {
                    id: "small".to_string(),
                    label: "small (better accuracy)".to_string(),
                },
                ModelOption {
                    id: "small.en".to_string(),
                    label: "small.en (better accuracy, English)".to_string(),
                },
                ModelOption {
                    id: "medium".to_string(),
                    label: "medium (high accuracy)".to_string(),
                },
                ModelOption {
                    id: "medium.en".to_string(),
                    label: "medium.en (high accuracy, English)".to_string(),
                },
                ModelOption {
                    id: "large-v3-turbo".to_string(),
                    label: "large-v3-turbo (fast + accurate)".to_string(),
                },
                ModelOption {
                    id: "large-v3".to_string(),
                    label: "large-v3 (best accuracy)".to_string(),
                },
            ],
            AsrProviderType::Parakeet => vec![
                ModelOption {
                    id: "parakeet-tdt-0.6b-v3".to_string(),
                    label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)".to_string(),
                },
                ModelOption {
                    id: "parakeet-tdt-ctc-110m".to_string(),
                    label: "Parakeet TDT CTC 110M legacy (English only)".to_string(),
                },
            ],
            AsrProviderType::WhisperCandle => vec![ModelOption {
                id: "whisper-large-v3-turbo".to_string(),
                label: "Whisper Large V3 Turbo via Candle (experimental)".to_string(),
            }],
            AsrProviderType::DistilWhisper => vec![ModelOption {
                id: "distil-large-v3.5".to_string(),
                label: "Distil Whisper Large v3.5".to_string(),
            }],
            AsrProviderType::MacosAppleSpeech => vec![ModelOption {
                id: "macos_apple_speech".to_string(),
                label: "Apple Speech · on-device dictation".to_string(),
            }],
            AsrProviderType::Moonshine => vec![
                ModelOption {
                    id: "moonshine-tiny".to_string(),
                    label: "Moonshine Tiny (stable, edge)".to_string(),
                },
                ModelOption {
                    id: "moonshine-base".to_string(),
                    label: "Moonshine Base (stable)".to_string(),
                },
            ],
            AsrProviderType::WindowsSdkDictation => vec![ModelOption {
                id: "windows_sdk_dictation".to_string(),
                label: "Managed by Windows".to_string(),
            }],
            // scribe_v2_realtime is intentionally not offered here: it is a
            // websocket-only model and this provider posts to the batch
            // /v1/speech-to-text endpoint, which cannot serve it (see
            // elevenlabs_scribe.rs's sanitize_elevenlabs_asr_model_id).
            AsrProviderType::ElevenLabsScribe => vec![
                ModelOption {
                    id: "scribe_v2".to_string(),
                    label: "Scribe v2 (recommended)".to_string(),
                },
                ModelOption {
                    id: "scribe_v2_experimental".to_string(),
                    label: "Scribe v2 Experimental".to_string(),
                },
            ],
            AsrProviderType::OpenAiCloud => vec![
                ModelOption {
                    id: "gpt-transcribe".to_string(),
                    label: "gpt-transcribe (recommended)".to_string(),
                },
                ModelOption {
                    id: "whisper-1".to_string(),
                    label: "whisper-1".to_string(),
                },
                ModelOption {
                    id: "gpt-4o-mini-transcribe".to_string(),
                    label: "gpt-4o-mini-transcribe".to_string(),
                },
                ModelOption {
                    id: "gpt-4o-transcribe".to_string(),
                    label: "gpt-4o-transcribe".to_string(),
                },
            ],
            AsrProviderType::Groq => vec![
                ModelOption {
                    id: "whisper-large-v3-turbo".to_string(),
                    label: "whisper-large-v3-turbo (fast, recommended)".to_string(),
                },
                ModelOption {
                    id: "whisper-large-v3".to_string(),
                    label: "whisper-large-v3 (best accuracy)".to_string(),
                },
            ],
            AsrProviderType::CohereTranscribe => vec![ModelOption {
                id: "cohere-transcribe-03-2026".to_string(),
                label: "Cohere Transcribe (03-2026)".to_string(),
            }],
            AsrProviderType::CohereLocal => vec![ModelOption {
                id: cohere_local::COHERE_LOCAL_MODEL_ID.to_string(),
                label: "Cohere Transcribe 03-2026 int4 (offline, 14 languages, slow)".to_string(),
            }],
            AsrProviderType::Qwen3Asr => vec![ModelOption {
                id: "qwen3-asr-0.6b".to_string(),
                label: "Qwen3-ASR 0.6B int4 (multilingual, fast)".to_string(),
            }],
            AsrProviderType::Deepgram => vec![
                ModelOption {
                    id: "nova-3".to_string(),
                    label: "Nova-3 (recommended, $0.0043/min English, $0.0052/min other languages)"
                        .to_string(),
                },
                ModelOption {
                    id: "nova-3-medical".to_string(),
                    label: "Nova-3 Medical (clinical vocabulary)".to_string(),
                },
            ],
            AsrProviderType::GeminiTranscribe => vec![ModelOption {
                id: "gemini-3.5-transcribe".to_string(),
                label: "Gemini 3.5 Transcribe ($0.005/min)".to_string(),
            }],
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => transcribe_cpp::route_model_options(),
        }
    }
}

impl AsrProviderFactory {
    pub fn create(provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        Self::create_with_model(provider_type, None)
    }

    pub fn create_with_model(
        provider_type: AsrProviderType,
        selected_model_id: Option<&str>,
    ) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::Whisper => Box::new(whisper::WhisperProvider::new(selected_model_id)),
            AsrProviderType::Parakeet => {
                Box::new(parakeet::ParakeetProvider::new(selected_model_id))
            }
            AsrProviderType::WhisperCandle => Box::new(whisper_candle::WhisperCandleProvider::new(
                selected_model_id,
            )),
            AsrProviderType::DistilWhisper => Box::new(distil_whisper::DistilWhisperProvider::new(
                selected_model_id,
            )),
            AsrProviderType::MacosAppleSpeech => {
                Box::new(macos_apple_speech_provider::MacosAppleSpeechProvider::new())
            }
            AsrProviderType::Moonshine => {
                Box::new(moonshine::MoonshineProvider::new(selected_model_id))
            }
            AsrProviderType::WindowsSdkDictation => {
                Box::new(windows_sdk_dictation_provider::WindowsSdkDictationProvider::new())
            }
            AsrProviderType::ElevenLabsScribe => Box::new(
                elevenlabs_scribe::ElevenLabsScribeProvider::new(selected_model_id),
            ),
            AsrProviderType::OpenAiCloud => Box::new(
                openai_cloud::OpenAiCloudWhisperProvider::new(selected_model_id),
            ),
            AsrProviderType::Groq => Box::new(groq::GroqProvider::new(selected_model_id)),
            AsrProviderType::CohereTranscribe => {
                Box::new(cohere::CohereTranscribeProvider::new(selected_model_id))
            }
            AsrProviderType::CohereLocal => {
                Box::new(cohere_local::CohereLocalProvider::new(selected_model_id))
            }
            AsrProviderType::Qwen3Asr => {
                Box::new(qwen3_asr::Qwen3AsrProvider::new(selected_model_id))
            }
            AsrProviderType::Deepgram => {
                Box::new(deepgram::DeepgramProvider::new(selected_model_id))
            }
            AsrProviderType::GeminiTranscribe => Box::new(
                gemini_transcribe::GeminiTranscribeProvider::new(selected_model_id),
            ),
            #[cfg(feature = "asr-transcribe-cpp")]
            AsrProviderType::TranscribeCpp => Box::new(transcribe_cpp::TranscribeCppProvider::new(
                selected_model_id,
            )),
        }
    }
}

// Re-export manager types
pub use manager::{
    AsrManager, BenchmarkResult, ProviderInfo, ProviderInventory, RuntimeDiagnostics,
};
