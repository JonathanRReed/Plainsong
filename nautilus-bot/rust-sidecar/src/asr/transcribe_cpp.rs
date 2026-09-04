//! transcribe.cpp provider — the single-runtime spike (feature `asr-transcribe-cpp`).
//!
//! Plainsong runs three inference stacks today: whisper-rs (ggml, Metal),
//! ONNX Runtime on the CPU for the default Parakeet TDT 0.6B v3 int8 route,
//! and Candle with Metal for the Whisper-derived models. The default dictation
//! engine — Parakeet — is the one that never touches the GPU.
//!
//! [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) is
//! a ggml runtime that loads Parakeet TDT, Whisper, Nemotron streaming,
//! Qwen3-ASR, Cohere Transcribe, Voxtral and Moonshine v2 from one GGUF loader
//! with Metal on by default. This module is the spike that measures whether it
//! could replace the custom Parakeet-on-Metal FFI that
//! `docs/model-inventory-upgrades.md` item 1 estimated at 1-2 weeks.
//!
//! It is evidence, not a product decision:
//!
//! - The whole module is behind `asr-transcribe-cpp`, which is OFF by default
//!   and deliberately absent from `scripts/sidecar-cargo-features.mjs`, so no
//!   shipped binary contains it.
//! - When it *is* compiled in, it appears as one extra local route labelled
//!   experimental in the route catalog and is never recommended or defaulted.
//! - The measurements are in `artifacts/qa/transcribe-cpp-spike-2026-09-02.md`.

use super::{
    streaming_chunk_samples, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, ModelOption,
    Partial, StreamingAsrProvider, StreamingAsrSession, TranscriptSegment, TranscriptionResult,
    DEFAULT_STREAMING_CHUNK_MS, STREAMING_CHUNK_MS_CHOICES, STREAMING_SAMPLE_RATE_HZ,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};
use transcribe_cpp::{
    Backend, CancelToken, CommitPolicy, Model, ModelOptions, ParakeetStreamOptions, RunOptions,
    Session, StreamExtension, StreamOptions, TimestampKind,
};

/// Directory under `models/` that holds every GGUF this provider fetches.
/// Flat, one file per model, because a GGUF is a single self-contained file —
/// unlike the ORT Parakeet route, whose four artifacts need their own folder.
pub(crate) const TRANSCRIBE_CPP_MODEL_DIR: &str = "transcribe_cpp";

/// The one route this provider offers: Parakeet TDT 0.6B v3, Q8_0-quantized,
/// the closest GGUF analogue to the int8 ONNX export the app ships today.
pub const PARAKEET_GGUF_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-q8_0";

/// Loaded (and benchmarked) only to prove the runtime path for a
/// streaming-capable family; NOT offered as a route — streaming integration is
/// a separate piece of work, and a batch decode of a streaming model is not a
/// streaming feature.
pub const NEMOTRON_STREAMING_GGUF_MODEL_ID: &str = "nemotron-3.5-asr-streaming-0.6b-q8_0";

/// Mistral's offline audio-LLM, the open-weights accuracy leader on the
/// Artificial Analysis non-streaming board. Measured here on 2026-09-03 and
/// **not** offered as a route: see
/// `artifacts/qa/model-selection-2026-09-03.md`.
pub const VOXTRAL_MINI_3B_GGUF_MODEL_ID: &str = "voxtral-mini-3b-2507-q4_k_m";

/// Mistral's streaming sibling. Also measured, also not a route, for the same
/// reason plus one more: it emits no timestamps at all.
pub const VOXTRAL_REALTIME_4B_GGUF_MODEL_ID: &str = "voxtral-mini-4b-realtime-2602-q4_k_m";

/// Env override for the compute backend, so one binary can measure Metal and
/// CPU without a rebuild. Spike-only: nothing in the app sets it, and the
/// default (`Auto`) is what a user would get.
pub(crate) const BACKEND_ENV_VAR: &str = "PLAINSONG_TRANSCRIBE_CPP_BACKEND";

/// Parakeet is a transducer: it emits a blank per frame and reports no
/// per-token probability, so there is no measured confidence to report. This
/// is the same placeholder `asr/parakeet.rs` uses for the same weights, chosen
/// so that swapping the runtime under a route does not silently move the
/// transcript quality score in `lib.rs`. It is a constant, not a measurement,
/// and `token_confidence` below prefers a real number whenever the family
/// gives one.
const UNSCORED_TRANSDUCER_CONFIDENCE: f64 = 0.88;

/// A GGUF this provider knows how to fetch, verify and load.
pub(crate) struct TranscribeCppModelSpec {
    pub model_id: &'static str,
    pub label: &'static str,
    pub display_name: &'static str,
    pub file_name: &'static str,
    pub hf_repo: &'static str,
    /// Pinned repo commit, so the URL is immutable the way every other model
    /// download in this app is.
    pub hf_revision: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub license: &'static str,
    pub upstream_url: &'static str,
    pub languages: &'static [&'static str],
    /// Whether the route catalog is offered this model at all.
    pub offered_as_route: bool,
}

impl TranscribeCppModelSpec {
    pub(crate) fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.hf_repo, self.hf_revision, self.file_name
        )
    }

    /// Download ceiling: the pinned size plus 1 MiB of slack, so a server that
    /// starts streaming a different (larger) file is cut off long before it
    /// fills the disk. The SHA-256 check is what actually rejects it.
    pub(crate) fn max_bytes(&self) -> u64 {
        self.size_bytes + 1024 * 1024
    }

    pub(crate) fn size_mib(&self) -> f64 {
        self.size_bytes as f64 / (1024.0 * 1024.0)
    }
}

/// The 25 languages NVIDIA lists for Parakeet TDT 0.6B v3 — the same set the
/// ORT route in `asr/parakeet.rs` declares, because it is the same weights.
const PARAKEET_V3_LANGUAGES: &[&str] = &[
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt",
    "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];

/// The 8 languages Mistral lists on the `Voxtral-Mini-3B-2507` model card.
const VOXTRAL_2507_LANGUAGES: &[&str] = &["en", "fr", "de", "es", "it", "pt", "nl", "hi"];

/// The 13 languages Mistral lists on the `Voxtral-Mini-4B-Realtime-2602` card.
/// The streaming processor is auto-detect only — there is no language hint to
/// send — so this is a coverage claim, not a selector.
const VOXTRAL_REALTIME_LANGUAGES: &[&str] = &[
    "en", "fr", "es", "de", "ru", "zh", "ja", "it", "pt", "nl", "ar", "hi", "ko",
];

pub(crate) const MODEL_SPECS: &[TranscribeCppModelSpec] = &[
    TranscribeCppModelSpec {
        model_id: PARAKEET_GGUF_MODEL_ID,
        label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp (experimental)",
        display_name: "Parakeet TDT 0.6B v3 (GGUF Q8_0)",
        file_name: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
        hf_repo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
        hf_revision: "85ac09ea12fc4b1112fa76810059364bc6adc9de",
        sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
        size_bytes: 739_508_576,
        // Verified on the GGUF repo's own model card metadata
        // (`cardData.license == "cc-by-4.0"`) on 2026-09-02, matching the
        // NVIDIA source weights this conversion is derived from.
        license: "CC-BY-4.0",
        upstream_url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf",
        languages: PARAKEET_V3_LANGUAGES,
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: NEMOTRON_STREAMING_GGUF_MODEL_ID,
        label: "Nemotron 3.5 ASR Streaming 0.6B GGUF Q8_0 (runtime proof only)",
        display_name: "Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0)",
        file_name: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
        hf_repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
        hf_revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
        sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
        size_bytes: 751_094_240,
        // NVIDIA ships this one under OpenMDW-1.1, not CC-BY-4.0. It is
        // loaded by the benchmark to prove the runtime path and is NOT
        // offered as a route, so nothing redistributes it.
        license: "OpenMDW-1.1",
        upstream_url: "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
        // The model card lists 32 language-locales; only English is exercised
        // here, so no language list is claimed.
        languages: &["en"],
        offered_as_route: false,
    },
    TranscribeCppModelSpec {
        model_id: VOXTRAL_MINI_3B_GGUF_MODEL_ID,
        label: "Voxtral Mini 3B 2507 GGUF Q4_K_M (measured, not a route)",
        display_name: "Voxtral Mini 3B (2507, GGUF Q4_K_M)",
        file_name: "Voxtral-Mini-3B-2507-Q4_K_M.gguf",
        hf_repo: "handy-computer/Voxtral-Mini-3B-2507-gguf",
        hf_revision: "5690205813042c07cbaa86d2a9dcc585fcd31304",
        sha256: "3a6717aa8f8989108d260cbd237584289eec43cc987e10133c33643515936205",
        size_bytes: 2_984_721_056,
        // Mistral ships Voxtral under Apache-2.0 and the GGUF repo's card
        // metadata repeats it; verified 2026-09-03. Q4_K_M is the smallest and
        // fastest tier upstream publishes, and its LibriSpeech WER (1.94%) is
        // within noise of BF16 (1.88%) — so this is Voxtral at its best case
        // for latency, which is the comparison that had to be made.
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf",
        languages: VOXTRAL_2507_LANGUAGES,
        offered_as_route: false,
    },
    TranscribeCppModelSpec {
        model_id: VOXTRAL_REALTIME_4B_GGUF_MODEL_ID,
        label: "Voxtral Mini 4B Realtime 2602 GGUF Q4_K_M (measured, not a route)",
        display_name: "Voxtral Mini 4B Realtime (2602, GGUF Q4_K_M)",
        file_name: "Voxtral-Mini-4B-Realtime-2602-Q4_K_M.gguf",
        hf_repo: "handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
        hf_revision: "b3e1c979e3775cbd0a49a65878a0ec7f06789ed7",
        sha256: "39dc1f65539373a406edea7490505822d77c12edff521744678717eef4da4723",
        size_bytes: 2_830_493_984,
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
        languages: VOXTRAL_REALTIME_LANGUAGES,
        offered_as_route: false,
    },
];

pub(crate) fn spec_for(model_id: &str) -> &'static TranscribeCppModelSpec {
    let trimmed = model_id.trim();
    MODEL_SPECS
        .iter()
        .find(|spec| spec.model_id == trimmed)
        .unwrap_or(&MODEL_SPECS[0])
}

/// The same lookup, restricted to what the route catalog actually offers.
///
/// `spec_for` knows every model this provider can load, including the Nemotron
/// streaming GGUF the benchmark loads to prove the runtime path. A saved
/// settings file must not be able to name that one: `model_options()` never
/// offers it, so a settings value normalized through `spec_for` would leave the
/// picker showing a model it does not list and the route pointing at weights
/// nobody can download from the app.
pub(crate) fn route_spec_for(model_id: &str) -> &'static TranscribeCppModelSpec {
    let spec = spec_for(model_id);
    if spec.offered_as_route {
        return spec;
    }
    MODEL_SPECS
        .iter()
        .find(|candidate| candidate.offered_as_route)
        .unwrap_or(&MODEL_SPECS[0])
}

/// Model ids the route catalog is allowed to offer.
pub fn route_model_options() -> Vec<ModelOption> {
    MODEL_SPECS
        .iter()
        .filter(|spec| spec.offered_as_route)
        .map(|spec| ModelOption {
            id: spec.model_id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

/// Every model this provider can load, including the ones the route catalog is
/// not offered. `benchmark-latency` uses this so the spike's runtime proof for
/// a streaming-capable family can be measured without making it a route.
pub fn benchmark_model_options() -> Vec<ModelOption> {
    MODEL_SPECS
        .iter()
        .map(|spec| ModelOption {
            id: spec.model_id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

/// Pinned (path, sha256) pairs for the startup integrity sweep, exactly like
/// every other local model.
pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let dir = models_root.join(TRANSCRIBE_CPP_MODEL_DIR);
    MODEL_SPECS
        .iter()
        .map(|spec| (dir.join(spec.file_name), spec.sha256.to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendChoice {
    /// What a user gets: Metal on this build, CPU everywhere it is missing.
    Auto,
    /// Fail rather than silently fall back — the benchmark needs to know which
    /// device produced a number.
    Metal,
    /// Strict CPU, for the same reason.
    Cpu,
}

impl BackendChoice {
    fn to_backend(self) -> Backend {
        match self {
            BackendChoice::Auto => Backend::Auto,
            BackendChoice::Metal => Backend::Metal,
            BackendChoice::Cpu => Backend::Cpu,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            BackendChoice::Auto => "auto",
            BackendChoice::Metal => "metal",
            BackendChoice::Cpu => "cpu",
        }
    }
}

/// Parses `PLAINSONG_TRANSCRIBE_CPP_BACKEND`. Anything unrecognised is `Auto`:
/// a typo must not silently pin the slow device.
pub(crate) fn parse_backend_choice(raw: Option<&str>) -> BackendChoice {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "metal" | "gpu" => BackendChoice::Metal,
        "cpu" => BackendChoice::Cpu,
        _ => BackendChoice::Auto,
    }
}

fn backend_choice_from_env() -> BackendChoice {
    parse_backend_choice(std::env::var(BACKEND_ENV_VAR).ok().as_deref())
}

// ---------------------------------------------------------------------------
// Result mapping (pure, so it is testable without a GGUF on disk)
// ---------------------------------------------------------------------------

/// The subset of `transcribe_cpp::Segment` this provider consumes, lifted into
/// a plain struct so segment building can be unit-tested without loading a
/// model.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Mean of the finite per-token probabilities, or the documented placeholder
/// when the family reports none (Parakeet's transducer reports NaN).
pub(crate) fn token_confidence(probabilities: &[f32]) -> f64 {
    let finite: Vec<f64> = probabilities
        .iter()
        .filter(|p| p.is_finite())
        .map(|p| f64::from(*p))
        .filter(|p| (0.0..=1.0).contains(p))
        .collect();
    if finite.is_empty() {
        return UNSCORED_TRANSDUCER_CONFIDENCE;
    }
    finite.iter().sum::<f64>() / finite.len() as f64
}

/// Turn the binding's millisecond segments into the second-based
/// `TranscriptSegment` rows the dictation and meeting contracts consume.
///
/// Three properties the meeting timeline depends on, and which the raw rows do
/// not guarantee:
///
/// - times are seconds, monotonically non-decreasing, and never negative;
/// - an end time before its start collapses to the start rather than producing
///   a backwards span that breaks seeking;
/// - a family that returns text with no timed rows at all still yields exactly
///   one segment covering the clip, the way `asr/parakeet.rs` does, so the
///   meeting view never renders an empty transcript for a non-empty decode.
pub(crate) fn build_segments(
    raw: &[RawSegment],
    full_text: &str,
    audio_seconds: f64,
    confidence: f64,
) -> Vec<TranscriptSegment> {
    let clip_end = if audio_seconds.is_finite() && audio_seconds > 0.0 {
        audio_seconds
    } else {
        0.0
    };

    let mut segments: Vec<TranscriptSegment> = Vec::with_capacity(raw.len());
    for row in raw {
        let text = row.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = (row.start_ms.max(0) as f64) / 1000.0;
        let end = (row.end_ms.max(0) as f64) / 1000.0;
        segments.push(TranscriptSegment {
            start_time: start,
            end_time: end.max(start),
            text: text.to_string(),
            confidence,
        });
    }

    if segments.is_empty() {
        let text = full_text.trim();
        if text.is_empty() {
            return Vec::new();
        }
        return vec![TranscriptSegment {
            start_time: 0.0,
            end_time: clip_end,
            text: text.to_string(),
            confidence,
        }];
    }

    segments
}

/// The longest upstream diagnostic that may be quoted into a user-facing
/// sentence before it stops being a sentence.
const MAX_UPSTREAM_DETAIL_CHARS: usize = 160;

/// Upstream's own message, folded onto one line and capped.
///
/// Only ever applied to the failure classes whose message is a library
/// diagnostic — a path, a GGUF architecture name, an ABI version — never to
/// `Aborted`/`OutputTruncated`, whose payload is derived from what the user
/// said.
pub(crate) fn short_upstream_detail(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    if trimmed.chars().count() <= MAX_UPSTREAM_DETAIL_CHARS {
        return trimmed.to_string();
    }
    let mut capped: String = trimmed.chars().take(MAX_UPSTREAM_DETAIL_CHARS).collect();
    capped.push('…');
    capped
}

/// Append the upstream diagnostic to a Plainsong sentence, or leave the
/// sentence alone when upstream said nothing usable.
fn with_upstream_detail(sentence: String, raw: &str) -> String {
    let detail = short_upstream_detail(raw);
    if detail.is_empty() {
        return sentence;
    }
    format!("{sentence} transcribe.cpp said: {detail}.")
}

/// One user-facing sentence per failure class: what happened, why, and the next
/// action. Deliberately does NOT include `error.partial()` — a partial
/// transcript is user speech and must not be pasted into a log line or an error
/// toast.
///
/// Three of these classes are packaging or environment faults a user cannot act
/// on without the detail — which GGUF architecture was rejected, which backend
/// was missing, which ABI version disagreed. Those keep a short form of
/// upstream's message in the sentence and log the full one at warn; a bug
/// report that says only "the GGUF is unreadable" cannot be triaged.
pub(crate) fn describe_transcribe_error(model_id: &str, error: &transcribe_cpp::Error) -> String {
    use transcribe_cpp::Error;
    match error {
        Error::ModelFileNotFound(_) => format!(
            "The transcribe.cpp weights for '{model_id}' are not on disk. Download the model from Settings."
        ),
        Error::ModelLoad(detail) => {
            tracing::warn!("transcribe.cpp could not load '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "transcribe.cpp could not load '{model_id}': the GGUF is unreadable or its architecture is not supported by this build. Re-download the model from Settings."
                ),
                detail,
            )
        }
        Error::Backend(detail) => {
            tracing::warn!("transcribe.cpp backend unavailable for '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "transcribe.cpp could not use the requested compute backend for '{model_id}'. Unset {BACKEND_ENV_VAR} to let it choose, or use another route."
                ),
                detail,
            )
        }
        Error::OutOfMemory(_) => format!(
            "transcribe.cpp ran out of memory transcribing with '{model_id}'. Close other applications or pick a smaller model."
        ),
        Error::InputTooLong(_) => format!(
            "The recording is longer than '{model_id}' can decode in one pass. Use a shorter clip or a long-form route."
        ),
        Error::Unsupported(_) | Error::NotImplemented(_) => format!(
            "'{model_id}' cannot satisfy this request through transcribe.cpp. Use another route."
        ),
        Error::Aborted { .. } => {
            format!("Transcription with '{model_id}' was cancelled before it finished.")
        }
        Error::OutputTruncated { .. } => format!(
            "transcribe.cpp stopped decoding '{model_id}' at its generation budget, so the transcript is incomplete. Transcribe a shorter clip."
        ),
        Error::Busy(_) => format!(
            "transcribe.cpp is already transcribing with '{model_id}'. Wait for the current transcription to finish."
        ),
        Error::VersionMismatch(detail) | Error::BadStructSize(detail) => {
            tracing::warn!("transcribe.cpp ABI mismatch for '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "The bundled transcribe.cpp library does not match the bindings this build was compiled against, so '{model_id}' cannot run. This is a packaging fault; report it."
                ),
                detail,
            )
        }
        Error::InvalidArgument(_) | Error::Nul(_) => format!(
            "transcribe.cpp rejected the request for '{model_id}' as malformed. This is a bug in Plainsong; report it."
        ),
        // `transcribe_cpp::Error` is `#[non_exhaustive]`: a future variant
        // lands here rather than failing to compile, and still says what to do.
        _ => format!(
            "transcribe.cpp failed to transcribe with '{model_id}'. Try again, or use another route."
        ),
    }
}

// ---------------------------------------------------------------------------
// Native runtime, cached per (model file, backend)
// ---------------------------------------------------------------------------

struct CachedRuntime {
    key: String,
    /// Held so the native model outlives the session; also what a future
    /// multi-session path would clone.
    _model: Model,
    session: Session,
    load_ms: u64,
    /// The finest timestamp granularity this family can produce, read from the
    /// loaded model. Asking for more than this is a hard error upstream, not a
    /// silent downgrade — see `timestamp_request_for`.
    max_timestamp_kind: TimestampKind,
}

/// What to ask a loaded model for, given the finest granularity it advertises.
///
/// The dictation and meeting contracts want `Segment` rows. Families differ:
/// Parakeet advertises `Token`, Voxtral advertises `None`. `transcribe_run`
/// rejects a request finer than `max_timestamp_kind` with
/// `TRANSCRIBE_ERR_UNSUPPORTED_TIMESTAMPS` rather than clamping it, so asking
/// every family for `Segment` makes a timestamp-free family fail to decode at
/// all instead of returning the text it does have. Clamp here, explicitly,
/// rather than passing `Auto` — `Auto` would let a token-capable family return
/// per-token rows this provider would then throw away.
pub(crate) fn timestamp_request_for(max_timestamp_kind: TimestampKind) -> TimestampKind {
    match max_timestamp_kind {
        TimestampKind::Segment | TimestampKind::Word | TimestampKind::Token => {
            TimestampKind::Segment
        }
        // `Auto` is not a capability a model reports; treat anything else as
        // "no timed rows available".
        TimestampKind::None | TimestampKind::Auto => TimestampKind::None,
    }
}

fn runtime_cache() -> &'static Mutex<Option<CachedRuntime>> {
    static CACHE: OnceLock<Mutex<Option<CachedRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn runtime_key(model_path: &Path, backend: BackendChoice) -> String {
    format!("{}::{}", model_path.to_string_lossy(), backend.label())
}

/// Take the cache lock, recovering from poison instead of wedging the route for
/// the life of the process.
///
/// `panic = "unwind"` (see Cargo.toml) means a panic anywhere under the lock —
/// a bug in this module, an allocation failure while materializing a
/// transcript — unwinds and poisons the mutex. Every `lock()?` after that
/// returns `Err` forever, so `clear_cached_runtime()` silently did nothing and
/// the route was dead until the user restarted the app. Poison recovery drops
/// whatever was cached, because a native session that was mid-decode when the
/// unwind happened is exactly the thing not to keep using; the next call
/// reloads.
fn lock_runtime_cache() -> MutexGuard<'static, Option<CachedRuntime>> {
    match runtime_cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            runtime_cache().clear_poison();
            let mut guard = poisoned.into_inner();
            if guard.take().is_some() {
                tracing::warn!(
                    "Dropped the transcribe.cpp runtime that was cached when a panic unwound \
                     through the decode; the next transcription reloads it"
                );
            }
            guard
        }
    }
}

/// Drop any cached native model, so a re-download or a settings change cannot
/// keep serving transcripts from weights that are no longer on disk.
pub(crate) fn clear_cached_runtime() {
    if lock_runtime_cache().take().is_some() {
        tracing::info!("Cleared cached transcribe.cpp runtime");
    }
}

/// Wall-clock milliseconds spent loading the cached model, or `None` when no
/// model is loaded. The benchmark reports this; nothing in the app reads it.
pub fn cached_model_load_ms() -> Option<u64> {
    lock_runtime_cache().as_ref().map(|runtime| runtime.load_ms)
}

// ---------------------------------------------------------------------------
// Cancellation and deadline
// ---------------------------------------------------------------------------

/// Wall-clock decode budget per second of audio, and the floor for very short
/// clips. Same numbers as `qwen3_asr.rs`, for the same reason: generous enough
/// that a cold Metal shader compile on a loaded machine is not mistaken for a
/// hang, tight enough that a runaway decode cannot hold the single global
/// runtime forever.
const DECODE_BUDGET_PER_AUDIO_SECOND: f64 = 4.0;
const DECODE_BUDGET_MIN_SECONDS: f64 = 30.0;

/// How often the watchdog re-reads the abandonment flag. Dropping a future
/// raises no signal, so this one has to be polled; the deadline itself is
/// waited on exactly.
const ABANDON_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// How often a request waiting for the runtime retries the lock.
const RUNTIME_ACQUIRE_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Wall-clock budget for decoding `audio_seconds` of audio.
pub(crate) fn decode_budget_for_audio(audio_seconds: f64) -> Duration {
    Duration::from_secs_f64(
        (audio_seconds.max(0.0) * DECODE_BUDGET_PER_AUDIO_SECOND).max(DECODE_BUDGET_MIN_SECONDS),
    )
}

/// Why a decode stopped before the model finished on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecodeStop {
    /// The async caller dropped the request (`CancelOnDrop` fired).
    Cancelled,
    /// The wall-clock budget ran out.
    DeadlineExceeded,
}

/// The one control decision, kept pure so it is testable without a GGUF.
pub(crate) fn check_decode_control(
    abandoned: &AtomicBool,
    deadline: Instant,
) -> Result<(), DecodeStop> {
    if abandoned.load(Ordering::Relaxed) {
        return Err(DecodeStop::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(DecodeStop::DeadlineExceeded);
    }
    Ok(())
}

/// Sets the shared flag when dropped. The async `transcribe` future holds one
/// across its `.await`, so a caller that abandons the request (the sidecar
/// aborts a request's task when Electron gives up on it) flips the flag; the
/// watchdog then cancels the native run instead of leaving the single global
/// runtime locked until the decode finishes on its own.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// The error a request that never got the runtime surfaces.
///
/// Both arms exist because the wait is now bounded. Before, a second request
/// blocked on the mutex for as long as the first decode took, with nothing to
/// show the user; `Busy` is the honest name for that, and it is upstream's own
/// name for the same condition.
fn runtime_wait_error(stop: DecodeStop, model_label: &str, budget: Duration) -> anyhow::Error {
    use transcribe_cpp::Error;
    let error = match stop {
        DecodeStop::Cancelled => Error::Aborted {
            message: "the caller abandoned the request while it waited for the runtime".to_string(),
            partial: None,
        },
        DecodeStop::DeadlineExceeded => Error::Busy(format!(
            "another decode held the runtime for the whole {:.0} s budget",
            budget.as_secs_f64()
        )),
    };
    anyhow::anyhow!(describe_transcribe_error(model_label, &error))
}

/// Cancels `token` when the caller abandons the request or the deadline passes.
///
/// transcribe.cpp polls its abort callback between decode steps
/// (`Session::set_cancel_token`), so this thread is what turns an abandoned or
/// runaway decode into a bounded return. It exits as soon as the decode signals
/// that it finished, so a normal transcription pays one thread spawn and no
/// added latency.
struct DecodeWatchdog {
    finished: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<std::thread::JoinHandle<Option<DecodeStop>>>,
}

impl DecodeWatchdog {
    fn spawn(token: CancelToken, abandoned: Arc<AtomicBool>, deadline: Instant) -> Self {
        let finished = Arc::new((Mutex::new(false), Condvar::new()));
        let watched = Arc::clone(&finished);
        let handle = std::thread::spawn(move || {
            let (lock, condvar) = &*watched;
            let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if *done {
                    return None;
                }
                if let Err(stop) = check_decode_control(&abandoned, deadline) {
                    token.cancel();
                    return Some(stop);
                }
                let wait = deadline
                    .saturating_duration_since(Instant::now())
                    .min(ABANDON_POLL_INTERVAL);
                done = condvar
                    .wait_timeout(done, wait)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        });
        Self {
            finished,
            handle: Some(handle),
        }
    }

    fn signal_finished(&self) {
        let (lock, condvar) = &*self.finished;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        condvar.notify_all();
    }

    /// Stop watching, and report why the run was cancelled if it was.
    fn finish(mut self) -> Option<DecodeStop> {
        self.signal_finished();
        self.handle
            .take()
            .and_then(|handle| handle.join().unwrap_or(None))
    }
}

impl Drop for DecodeWatchdog {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.signal_finished();
            let _ = handle.join();
        }
    }
}

/// Take the runtime lock, but never for longer than the request's own budget.
fn acquire_runtime(
    abandoned: &AtomicBool,
    deadline: Instant,
    model_label: &str,
    budget: Duration,
) -> Result<MutexGuard<'static, Option<CachedRuntime>>> {
    loop {
        match runtime_cache().try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Ok(lock_runtime_cache()),
            Err(TryLockError::WouldBlock) => {
                if let Err(stop) = check_decode_control(abandoned, deadline) {
                    return Err(runtime_wait_error(stop, model_label, budget));
                }
                std::thread::sleep(RUNTIME_ACQUIRE_POLL_INTERVAL);
            }
        }
    }
}

struct NativeRun {
    text: String,
    raw_segments: Vec<RawSegment>,
    token_probabilities: Vec<f32>,
    load_ms: u64,
    language: Option<String>,
}

fn run_native(
    model_path: &Path,
    backend: BackendChoice,
    pcm: &[f32],
    audio_seconds: f64,
    abandoned: &Arc<AtomicBool>,
) -> Result<NativeRun> {
    let model_label = model_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let budget = decode_budget_for_audio(audio_seconds);
    let deadline = Instant::now() + budget;

    let key = runtime_key(model_path, backend);
    let mut cache = acquire_runtime(abandoned, deadline, &model_label, budget)?;

    if cache
        .as_ref()
        .map(|runtime| runtime.key != key)
        .unwrap_or(false)
    {
        *cache = None;
    }

    if cache.is_none() {
        let started = std::time::Instant::now();
        let model = Model::load_with(
            model_path,
            &ModelOptions {
                backend: backend.to_backend(),
                device: None,
            },
        )
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
        let session = model
            .session()
            .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
        let load_ms = started.elapsed().as_millis() as u64;
        let max_timestamp_kind = model.capabilities().max_timestamp_kind;
        tracing::info!(
            "transcribe.cpp loaded {} on {} in {} ms (max timestamps: {:?})",
            model_path.display(),
            backend.label(),
            load_ms,
            max_timestamp_kind
        );
        *cache = Some(CachedRuntime {
            key,
            _model: model,
            session,
            load_ms,
            max_timestamp_kind,
        });
    }

    let runtime = cache
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("transcribe.cpp runtime disappeared after loading"))?;

    let options = RunOptions {
        // Segment granularity is what the dictation and meeting contracts
        // consume, clamped to what this family can actually produce: a request
        // finer than the model's `max_timestamp_kind` is rejected outright.
        timestamps: timestamp_request_for(runtime.max_timestamp_kind),
        ..RunOptions::default()
    };

    // Install the abort callback, start the watchdog, decode. The watchdog owns
    // the only clone that fires; the token is cleared before the guard is
    // released so the next decode installs its own.
    let token = CancelToken::new();
    runtime.session.set_cancel_token(&token);
    let watchdog = DecodeWatchdog::spawn(token, Arc::clone(abandoned), deadline);
    let outcome = runtime.session.run(pcm, &options);
    runtime.session.clear_cancel_token();
    let stop = watchdog.finish();

    let transcript = match outcome {
        Ok(transcript) => transcript,
        Err(error) => {
            return Err(match stop {
                // The watchdog, not the model, ended this one. Upstream calls
                // it `Aborted` either way, so say which of ours it was.
                Some(DecodeStop::DeadlineExceeded) => anyhow::anyhow!(
                    "transcribe.cpp did not finish '{model_label}' within its {:.0} s budget for {audio_seconds:.1} s of audio, so the decode was stopped. Use a shorter clip or another route.",
                    budget.as_secs_f64()
                ),
                _ => anyhow::anyhow!(describe_transcribe_error(&model_label, &error)),
            });
        }
    };

    Ok(NativeRun {
        text: transcript.text.clone(),
        raw_segments: transcript
            .segments
            .iter()
            .map(|segment| RawSegment {
                start_ms: segment.t0_ms,
                end_ms: segment.t1_ms,
                text: segment.text.clone(),
            })
            .collect(),
        token_probabilities: transcript.tokens.iter().map(|token| token.p).collect(),
        load_ms: runtime.load_ms,
        language: transcript.language.clone(),
    })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct TranscribeCppProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl TranscribeCppProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let models_root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&models_root, selected_model_id)
    }

    /// The same provider rooted at an arbitrary models directory, so the
    /// integrity rules can be exercised against real files in a temp dir
    /// instead of the user's data directory.
    pub(crate) fn with_models_root(models_root: &Path, selected_model_id: Option<&str>) -> Self {
        let spec = spec_for(selected_model_id.unwrap_or(PARAKEET_GGUF_MODEL_ID));
        Self {
            model_dir: models_root.join(TRANSCRIBE_CPP_MODEL_DIR),
            model_id: spec.model_id.to_string(),
        }
    }

    fn spec(&self) -> &'static TranscribeCppModelSpec {
        spec_for(&self.model_id)
    }

    fn model_path(&self) -> PathBuf {
        self.model_dir.join(self.spec().file_name)
    }

    fn has_required_file(&self) -> bool {
        std::fs::metadata(self.model_path())
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false)
    }

    fn has_trusted_required_file(&self) -> bool {
        crate::download::is_model_artifact_trusted(&self.model_path(), Some(self.spec().sha256))
    }

    fn wav_duration_seconds(path: &Path) -> f64 {
        match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                if spec.sample_rate == 0 {
                    0.0
                } else {
                    reader.duration() as f64 / spec.sample_rate as f64
                }
            }
            Err(_) => 0.0,
        }
    }
}

impl Default for TranscribeCppProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for TranscribeCppProvider {
    fn name(&self) -> &str {
        "transcribe.cpp (experimental)"
    }

    fn description(&self) -> &str {
        "Experimental: Parakeet TDT 0.6B v3 in GGUF through transcribe.cpp's ggml runtime, on Metal. Same weights as the shipped Parakeet route, a different engine."
    }

    /// Readiness follows the integrity receipt, not the bytes.
    ///
    /// `has_required_file` only proves something non-empty is at the path, and
    /// the diagnostics surface in `asr/manager.rs` already refuses to call the
    /// route ready without the receipt. Reporting `true` here while the
    /// diagnostics said "not verified" put the two in direct contradiction on
    /// the same screen, and it is the looser of the two that decides whether
    /// `transcribe()` is even attempted.
    fn is_available(&self) -> bool {
        self.has_required_file() && self.has_trusted_required_file()
    }

    fn model_info(&self) -> ModelInfo {
        let spec = self.spec();
        ModelInfo {
            name: spec.display_name.to_string(),
            version: "q8_0".to_string(),
            size_mb: spec.size_mib(),
            parameters: "600M".to_string(),
            languages: spec.languages.iter().map(|code| code.to_string()).collect(),
            // No WER or RTF is claimed here. Upstream publishes both, but they
            // were not measured in Plainsong, and this struct is rendered to
            // users as if it were.
            word_error_rate: None,
            real_time_factor: None,
            license: spec.license.to_string(),
            source_url: spec.upstream_url.to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_file() {
            return Err(anyhow::anyhow!(
                "The transcribe.cpp weights for '{}' are not downloaded. Download the model from Settings.",
                self.model_id
            ));
        }
        if !self.has_trusted_required_file() {
            return Err(anyhow::anyhow!(
                "The transcribe.cpp weights for '{}' have not passed Plainsong integrity verification. Re-download the model from Settings.",
                self.model_id
            ));
        }

        let start = std::time::Instant::now();
        let duration = Self::wav_duration_seconds(audio_path);
        let samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for transcribe.cpp")?;
        let model_path = self.model_path();
        let backend = backend_choice_from_env();

        // Dropping this future (the sidecar aborts a request's task when the
        // caller gives up) flips the flag; the watchdog cancels the native run
        // at its next decode step and the runtime is free for the next request.
        let abandoned = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&abandoned));
        let run = tokio::task::spawn_blocking(move || {
            run_native(&model_path, backend, &samples, duration, &abandoned)
        })
        .await
        .context("transcribe.cpp inference task panicked")??;

        let confidence = token_confidence(&run.token_probabilities);
        let segments = build_segments(&run.raw_segments, &run.text, duration, confidence);
        let text = run.text.trim().to_string();

        tracing::info!(
            "transcribe.cpp transcription complete: model={}, backend={}, load={}ms, {} chars in {}ms",
            self.model_id,
            backend.label(),
            run.load_ms,
            text.len(),
            start.elapsed().as_millis()
        );

        Ok(TranscriptionResult {
            text,
            segments,
            // Parakeet through this runtime returns text and timings, never
            // speaker attribution. Empty is the only honest value: a meeting
            // on this route gets Plainsong's own diarizer, and
            // `resolve_meeting_diarizer` reads this to know that.
            speaker_turns: Vec::new(),
            language: run.language.unwrap_or_else(|| "en".to_string()),
            confidence,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: self.spec().display_name.to_string(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::TranscribeCpp,
            actual_provider: AsrProviderType::TranscribeCpp,
            requested_engine: Some(format!("transcribe_cpp_{}", backend.label())),
            actual_engine: Some(format!("transcribe_cpp_{}", backend.label())),
            optimization_applied: false,
            fallback_reason: None,
            // Parakeet has no prompt or keyterm field, so the dictionary never
            // reaches the recognizer on this route. Claiming otherwise is the
            // exact failure the field exists to prevent.
            vocabulary_hint_terms_applied: 0,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("transcribe_cpp_{}.wav", uuid::Uuid::new_v4()));
        let temp = crate::recording_audio::write_secure_temporary_audio(&temp_path, audio_data)
            .context("failed to write temp wav for transcribe.cpp")?;
        self.transcribe(temp.path()).await
    }

    async fn prewarm(&self) -> Result<()> {
        if !self.has_trusted_required_file() {
            return Err(anyhow::anyhow!(
                "The transcribe.cpp weights for '{}' are not downloaded and verified yet.",
                self.model_id
            ));
        }
        let model_path = self.model_path();
        let backend = backend_choice_from_env();
        // 20 ms of silence: enough to force the model load and one decode
        // through the real path, short enough that a prewarm is not a
        // transcription.
        let silence = vec![0.0f32; 320];
        let abandoned = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&abandoned));
        tokio::task::spawn_blocking(move || {
            run_native(&model_path, backend, &silence, 0.02, &abandoned)
        })
        .await
        .context("transcribe.cpp prewarm task panicked")??;
        Ok(())
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_required_file() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;

        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create transcribe.cpp model directory")?;

        let spec = self.spec();
        let manager = DownloadManager::new()?;
        let destination = self.model_path();
        manager
            .download_verified_model_asset(
                &spec.url(),
                &destination,
                Some(spec.sha256),
                spec.max_bytes(),
                move |p| {
                    progress_cb(p.percentage as f32);
                },
            )
            .await?;

        // A new file under an old cache entry would otherwise keep serving the
        // previous weights for the life of the process.
        clear_cached_runtime();
        tracing::info!("transcribe.cpp model '{}' downloaded", spec.model_id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Streaming session (live dictation preview)
// ---------------------------------------------------------------------------

/// The language codes the pinned Nemotron GGUF declares in its own model-card
/// metadata at the revision this app downloads.
///
/// Three different counts are in circulation for this model and it matters
/// which one the gate uses. NVIDIA advertises **40 language-locales**; the GGUF
/// port's card says **32** are supported ("the model's tokenizer recognizes 40,
/// but 8 are adaptation-ready and need fine-tuning"); and the file's own
/// `language:` metadata — the only one that is pinned with the bytes — lists
/// the **28** codes below. The gate uses the 28, because that is the list the
/// artifact on disk actually claims, and being wrong here means showing a live
/// preview in a language the recognizer will garble.
pub(crate) const NEMOTRON_STREAMING_LANGUAGES: &[&str] = &[
    "en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk", "pl",
    "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et",
];

/// The cache-aware right-context that produces `chunk_ms` of look-ahead.
///
/// The encoder advances 80 ms per frame, so `att_context_right` of 0, 3, 6 and
/// 13 are 80, 320, 560 and 1120 ms — the four operating points the GGUF port
/// exposes. An unrecognised size falls back to the default rather than pinning
/// a value the model was not trained on.
pub(crate) fn att_context_right_for_chunk_ms(chunk_ms: u32) -> i32 {
    match chunk_ms {
        80 => 0,
        320 => 3,
        560 => 6,
        1120 => 13,
        _ => att_context_right_for_chunk_ms(DEFAULT_STREAMING_CHUNK_MS),
    }
}

/// How long a single `feed`/`finalize`/`reset` may take before the session is
/// declared dead.
///
/// A live preview that has stopped answering must not hold the dictation stop
/// path open waiting for it. Generous next to a measured per-chunk decode
/// (tens of milliseconds) so ordinary contention never trips it.
const STREAM_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// What [`TranscribeCppStreamingSession::open`] should do with the live-preview
/// thread after waiting for it to report that its model is loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerDisposition {
    /// The worker answered, or hung up: it is on its way out, so joining it is
    /// bounded and reclaims the thread.
    Join,
    /// It never answered. It may still be inside the native load, so joining
    /// would block the caller for exactly as long as that does.
    Detach,
}

/// Wait for the worker's "ready", with a ceiling, and say what to do with the
/// thread afterwards.
///
/// Split out from `open` so the join-versus-detach decision is testable with a
/// plain channel and no model on disk.
fn await_worker_ready(
    ready_rx: &std::sync::mpsc::Receiver<Result<u64>>,
    timeout: Duration,
    model_label: &str,
) -> (WorkerDisposition, Result<u64>) {
    match ready_rx.recv_timeout(timeout) {
        Ok(Ok(load_ms)) => (WorkerDisposition::Join, Ok(load_ms)),
        Ok(Err(error)) => (WorkerDisposition::Join, Err(error)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (
            WorkerDisposition::Detach,
            Err(anyhow::anyhow!(
                "The live-preview engine did not load '{model_label}' within {} s.",
                timeout.as_secs()
            )),
        ),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => (
            WorkerDisposition::Join,
            Err(anyhow::anyhow!(
                "The live-preview engine stopped before it could load '{model_label}'."
            )),
        ),
    }
}

/// What one `feed`/`finalize` produced, moved back over the channel.
struct StreamOutcome {
    stable: String,
    volatile: String,
}

enum StreamCommand {
    Feed(Vec<f32>),
    Finalize,
    Reset,
}

/// Opens Nemotron streaming sessions for the dictation live preview.
///
/// Separate from [`TranscribeCppProvider`] on purpose: that one is a route the
/// user can select and it transcribes what gets inserted. This one is never a
/// route — `route_model_options()` does not offer the Nemotron GGUF — and
/// nothing it produces can reach the inserted text.
pub struct TranscribeCppStreamingProvider {
    model_dir: PathBuf,
    chunk_ms: u32,
}

impl TranscribeCppStreamingProvider {
    pub fn new() -> Self {
        Self::with_chunk_ms(DEFAULT_STREAMING_CHUNK_MS)
    }

    /// The same provider at a named chunk size. `benchmark-latency --stream`
    /// uses it to measure every entry of `STREAMING_CHUNK_MS_CHOICES`.
    pub fn with_chunk_ms(chunk_ms: u32) -> Self {
        let models_root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&models_root, chunk_ms)
    }

    pub(crate) fn with_models_root(models_root: &Path, chunk_ms: u32) -> Self {
        Self {
            model_dir: models_root.join(TRANSCRIBE_CPP_MODEL_DIR),
            chunk_ms: if STREAMING_CHUNK_MS_CHOICES.contains(&chunk_ms) {
                chunk_ms
            } else {
                DEFAULT_STREAMING_CHUNK_MS
            },
        }
    }

    pub(crate) fn spec() -> &'static TranscribeCppModelSpec {
        spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID)
    }

    pub fn model_path(&self) -> PathBuf {
        self.model_dir.join(Self::spec().file_name)
    }

    pub fn chunk_ms(&self) -> u32 {
        self.chunk_ms
    }
}

impl Default for TranscribeCppStreamingProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingAsrProvider for TranscribeCppStreamingProvider {
    fn streaming_engine_name(&self) -> &str {
        "Nemotron 3.5 ASR Streaming via transcribe.cpp"
    }

    fn streaming_model_id(&self) -> &str {
        NEMOTRON_STREAMING_GGUF_MODEL_ID
    }

    /// The receipt, not the bytes — the same rule the batch route follows. A
    /// half-written GGUF is not a live preview, it is a crash.
    fn is_streaming_available(&self) -> bool {
        let path = self.model_path();
        std::fs::metadata(&path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false)
            && crate::download::is_model_artifact_trusted(&path, Some(Self::spec().sha256))
    }

    fn supports_language(&self, language: Option<&str>) -> bool {
        let Some(language) = language else {
            // No language selected means "let the recognizer decide", and this
            // model has language detection. Nothing to refuse.
            return true;
        };
        let normalized = language.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized == "auto" {
            return true;
        }
        // Accept both `en` and locale forms like `en-US` / `en_US`.
        let base = normalized
            .split(['-', '_'])
            .next()
            .unwrap_or(normalized.as_str());
        NEMOTRON_STREAMING_LANGUAGES.contains(&base)
    }

    fn open_session(&self, language_hint: Option<&str>) -> Result<Box<dyn StreamingAsrSession>> {
        let session = TranscribeCppStreamingSession::open(
            &self.model_path(),
            backend_choice_from_env(),
            language_hint,
            self.chunk_ms,
        )?;
        Ok(Box::new(session))
    }
}

/// One live Nemotron stream, driven from a dedicated OS thread.
///
/// The binding's `Stream<'a>` borrows its `Session` mutably for the stream's
/// whole life, so a struct owning both would be self-referential. Rather than
/// reach for a raw pointer, the model, session and stream all live on one
/// thread and this handle talks to it over a channel. Two things fall out for
/// free: the native calls never touch a tokio worker, and closing the session
/// *joins* that thread — so when `stop_dictation_for_sidecar` closes the
/// preview, the GPU is provably released before the batch decode asks for it.
///
/// The model is loaded per session and dropped when the session closes.
/// Caching it would save the ~0.5 s load on every dictation after the first, at
/// the cost of holding roughly a gigabyte resident for the rest of the app's
/// life; a preview is not worth that, and the load happens while the user is
/// still drawing breath.
pub struct TranscribeCppStreamingSession {
    commands: Option<std::sync::mpsc::Sender<StreamCommand>>,
    replies: std::sync::mpsc::Receiver<Result<StreamOutcome>>,
    worker: Option<std::thread::JoinHandle<()>>,
    chunk_samples: usize,
    fed_samples: u64,
    /// False once a call timed out or the worker died: the thread may still be
    /// inside a native call, so it is detached rather than joined.
    healthy: bool,
    load_ms: u64,
}

impl TranscribeCppStreamingSession {
    /// Milliseconds spent loading the model when this session opened. The
    /// receipt reports it; nothing in the app reads it.
    pub fn load_ms(&self) -> u64 {
        self.load_ms
    }

    fn open(
        model_path: &Path,
        backend: BackendChoice,
        language_hint: Option<&str>,
        chunk_ms: u32,
    ) -> Result<Self> {
        let model_label = model_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let owned_path = model_path.to_path_buf();
        let language = language_hint
            .map(str::trim)
            .filter(|hint| !hint.is_empty() && !hint.eq_ignore_ascii_case("auto"))
            .map(str::to_string);
        let att_context_right = att_context_right_for_chunk_ms(chunk_ms);

        let (command_tx, command_rx) = std::sync::mpsc::channel::<StreamCommand>();
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<StreamOutcome>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();

        let worker_label = model_label.clone();
        let worker = std::thread::Builder::new()
            .name("plainsong-live-preview".to_string())
            .spawn(move || {
                stream_worker(
                    owned_path,
                    backend,
                    language,
                    att_context_right,
                    worker_label,
                    ready_tx,
                    command_rx,
                    reply_tx,
                );
            })
            .context("Failed to start the live-preview thread")?;

        // Bounded, and detaching on timeout, exactly like `call()` below. A
        // `Model::load_with` that never returns used to park this wait
        // forever: the caller sat on a blocking-pool thread, the preview never
        // opened and never failed, and every later dictation stop paid the
        // close timeout in full.
        let load_ms = match await_worker_ready(&ready_rx, STREAM_CALL_TIMEOUT, &model_label) {
            // Loaded: the worker stays, because it is the session.
            (_, Ok(load_ms)) => load_ms,
            (WorkerDisposition::Join, Err(error)) => {
                // It answered with a failure, or hung up: either way it is on
                // its way out, so joining is bounded and reclaims the thread.
                let _ = worker.join();
                return Err(error);
            }
            (WorkerDisposition::Detach, Err(error)) => {
                // Still inside the native load: joining would block whoever
                // asked for the preview for as long as that does.
                tracing::warn!(
                    "Left the live-preview thread detached: '{}' did not load within {} s",
                    model_label,
                    STREAM_CALL_TIMEOUT.as_secs()
                );
                drop(worker);
                return Err(error);
            }
        };

        Ok(Self {
            commands: Some(command_tx),
            replies: reply_rx,
            worker: Some(worker),
            chunk_samples: streaming_chunk_samples(chunk_ms),
            fed_samples: 0,
            healthy: true,
            load_ms,
        })
    }

    /// Send one command and wait for its reply, marking the session dead if the
    /// worker does not answer.
    fn call(&mut self, command: StreamCommand) -> Result<StreamOutcome> {
        if !self.healthy {
            anyhow::bail!("The live-preview session is no longer running.");
        }
        let Some(commands) = self.commands.as_ref() else {
            anyhow::bail!("The live-preview session is closed.");
        };
        if commands.send(command).is_err() {
            self.healthy = false;
            anyhow::bail!("The live-preview engine stopped.");
        }
        match self.replies.recv_timeout(STREAM_CALL_TIMEOUT) {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(error)) => Err(error),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.healthy = false;
                anyhow::bail!(
                    "The live-preview engine did not answer within {} s.",
                    STREAM_CALL_TIMEOUT.as_secs()
                )
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                self.healthy = false;
                anyhow::bail!("The live-preview engine stopped.")
            }
        }
    }

    fn partial_from(&self, outcome: StreamOutcome) -> Partial {
        Partial {
            stable_prefix: outcome.stable,
            volatile_suffix: outcome.volatile,
            elapsed_audio_s: self.fed_samples as f64 / f64::from(STREAMING_SAMPLE_RATE_HZ),
        }
    }

    /// Shut the worker down. Joins only when the session is still healthy: a
    /// thread that is wedged inside a native call would otherwise block the
    /// dictation stop path forever.
    pub fn close(&mut self) {
        self.commands = None;
        if let Some(worker) = self.worker.take() {
            if self.healthy {
                let _ = worker.join();
            } else {
                tracing::warn!(
                    "Left the live-preview thread detached: it stopped answering, so joining it \
                     would block the dictation stop path"
                );
            }
        }
    }
}

impl Drop for TranscribeCppStreamingSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl StreamingAsrSession for TranscribeCppStreamingSession {
    fn feed(&mut self, pcm16k: &[f32]) -> Result<Partial> {
        self.fed_samples = self.fed_samples.saturating_add(pcm16k.len() as u64);
        let outcome = self.call(StreamCommand::Feed(pcm16k.to_vec()))?;
        Ok(self.partial_from(outcome))
    }

    fn finalize(&mut self) -> Result<Partial> {
        let outcome = self.call(StreamCommand::Finalize)?;
        Ok(self.partial_from(outcome))
    }

    fn reset(&mut self) -> Result<()> {
        self.call(StreamCommand::Reset)?;
        self.fed_samples = 0;
        Ok(())
    }

    fn chunk_samples(&self) -> usize {
        self.chunk_samples
    }
}

/// The body of the live-preview thread: load once, then serve commands until
/// the handle drops.
#[allow(clippy::too_many_arguments)]
fn stream_worker(
    model_path: PathBuf,
    backend: BackendChoice,
    language: Option<String>,
    att_context_right: i32,
    model_label: String,
    ready_tx: std::sync::mpsc::Sender<Result<u64>>,
    command_rx: std::sync::mpsc::Receiver<StreamCommand>,
    reply_tx: std::sync::mpsc::Sender<Result<StreamOutcome>>,
) {
    let started = Instant::now();
    let model = match Model::load_with(
        &model_path,
        &ModelOptions {
            backend: backend.to_backend(),
            device: None,
        },
    ) {
        Ok(model) => model,
        Err(error) => {
            let _ = ready_tx.send(Err(anyhow::anyhow!(describe_transcribe_error(
                &model_label,
                &error
            ))));
            return;
        }
    };
    if !model.capabilities().supports_streaming {
        let _ = ready_tx.send(Err(anyhow::anyhow!(
            "'{model_label}' is not a streaming model, so it cannot drive the live preview."
        )));
        return;
    }
    let mut session = match model.session() {
        Ok(session) => session,
        Err(error) => {
            let _ = ready_tx.send(Err(anyhow::anyhow!(describe_transcribe_error(
                &model_label,
                &error
            ))));
            return;
        }
    };
    let load_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        "Live preview loaded {} on {} in {} ms",
        model_path.display(),
        backend.label(),
        load_ms
    );
    if ready_tx.send(Ok(load_ms)).is_err() {
        return;
    }

    let run_options = RunOptions {
        // Text only: the preview renders words, and asking for alignment makes
        // the family materialize rows nobody reads.
        timestamps: TimestampKind::None,
        language,
        ..RunOptions::default()
    };
    // Cache-aware right context matched to the chunk size the caller feeds.
    // If the family rejects the extension the stream is begun without it
    // rather than failing the preview outright — the model's own default
    // operating point still streams.
    let with_extension = StreamOptions {
        commit_policy: CommitPolicy::Auto,
        stable_prefix_agreement_n: 0,
        family: Some(StreamExtension::ParakeetStream(ParakeetStreamOptions {
            att_context_right: Some(att_context_right),
        })),
    };
    let without_extension = StreamOptions {
        commit_policy: CommitPolicy::Auto,
        ..StreamOptions::default()
    };
    // Probed once, before any audio: begin a stream with the extension and
    // abandon it. Deciding per utterance would mean a failed `begin` inside the
    // reset path, where there is no caller left to tell.
    let stream_options = match session.stream(&run_options, &with_extension) {
        Ok(mut probe) => {
            probe.reset();
            with_extension
        }
        Err(error) => {
            tracing::debug!(
                "Live preview could not set the cache-aware right context ({}); \
                 falling back to the model's default streaming point",
                error
            );
            without_extension
        }
    };

    'session: loop {
        let mut stream = match session.stream(&run_options, &stream_options) {
            Ok(stream) => stream,
            Err(error) => {
                let _ = reply_tx.send(Err(anyhow::anyhow!(describe_transcribe_error(
                    &model_label,
                    &error
                ))));
                return;
            }
        };

        loop {
            let Ok(command) = command_rx.recv() else {
                // The handle dropped: abandon the stream and let the model go.
                return;
            };
            match command {
                StreamCommand::Feed(pcm) => {
                    let outcome = stream
                        .feed(&pcm)
                        .map_err(|error| {
                            anyhow::anyhow!(describe_transcribe_error(&model_label, &error))
                        })
                        .map(|_| {
                            let text = stream.text();
                            StreamOutcome {
                                stable: text.committed,
                                volatile: text.tentative,
                            }
                        });
                    if reply_tx.send(outcome).is_err() {
                        return;
                    }
                }
                StreamCommand::Finalize => {
                    let outcome = stream
                        .finalize()
                        .map_err(|error| {
                            anyhow::anyhow!(describe_transcribe_error(&model_label, &error))
                        })
                        .map(|_| {
                            let text = stream.text();
                            StreamOutcome {
                                stable: text.committed,
                                volatile: text.tentative,
                            }
                        });
                    if reply_tx.send(outcome).is_err() {
                        return;
                    }
                }
                StreamCommand::Reset => {
                    stream.reset();
                    if reply_tx
                        .send(Ok(StreamOutcome {
                            stable: String::new(),
                            volatile: String::new(),
                        }))
                        .is_err()
                    {
                        return;
                    }
                    continue 'session;
                }
            }
        }
    }
}

/// Word end times from a batch decode of the *same* weights, in seconds.
///
/// Only the streaming receipt uses this: "partial latency" is measured from the
/// moment a word finishes being spoken to the moment a partial containing it
/// arrives, and something has to say when each word finished. Taking it from
/// the same model that is being streamed keeps the two sides comparable — a
/// different recognizer's alignment would fold its own segmentation into the
/// number. Nothing in the app calls this.
pub fn streaming_reference_words(model_path: &Path, pcm: &[f32]) -> Result<Vec<(String, f64)>> {
    let model_label = model_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let model = Model::load_with(
        model_path,
        &ModelOptions {
            backend: backend_choice_from_env().to_backend(),
            device: None,
        },
    )
    .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
    let mut session = model
        .session()
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
    let transcript = session
        .run(
            pcm,
            &RunOptions {
                timestamps: TimestampKind::Word,
                ..RunOptions::default()
            },
        )
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
    Ok(transcript
        .words
        .iter()
        .map(|word| (word.text.clone(), word.t1_ms as f64 / 1000.0))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this guards: the provider used to ask every family for
    /// `Segment` timestamps. Voxtral advertises `max_timestamp_kind == None`,
    /// and `transcribe_run` rejects an over-fine request rather than clamping
    /// it, so a Voxtral decode failed outright with
    /// `TRANSCRIBE_ERR_UNSUPPORTED_TIMESTAMPS` instead of returning its text.
    #[test]
    fn the_timestamp_request_is_clamped_to_what_the_family_can_produce() {
        // Parakeet and Nemotron advertise Token; the meeting contract wants
        // Segment, and asking for less than the maximum is always allowed.
        assert_eq!(
            timestamp_request_for(TimestampKind::Token),
            TimestampKind::Segment
        );
        assert_eq!(
            timestamp_request_for(TimestampKind::Word),
            TimestampKind::Segment
        );
        assert_eq!(
            timestamp_request_for(TimestampKind::Segment),
            TimestampKind::Segment
        );
        // Voxtral (both families), Cohere, Canary, Moonshine: text only.
        assert_eq!(
            timestamp_request_for(TimestampKind::None),
            TimestampKind::None
        );
        // `Auto` is a request, never a reported capability. Treat it as the
        // conservative answer rather than assuming timed rows exist.
        assert_eq!(
            timestamp_request_for(TimestampKind::Auto),
            TimestampKind::None
        );
    }

    /// Every spec the provider can load is uniquely named, pins a full
    /// SHA-256, and pins a 40-character commit rather than a branch. The
    /// download path hashes what it fetches, so a wrong hash is caught at
    /// install time — but a `main` revision would silently change what gets
    /// hashed.
    #[test]
    fn every_model_spec_pins_an_immutable_revision_and_a_full_digest() {
        let mut seen: Vec<&str> = Vec::new();
        for spec in MODEL_SPECS {
            assert!(
                !seen.contains(&spec.model_id),
                "duplicate model id {}",
                spec.model_id
            );
            seen.push(spec.model_id);
            assert_eq!(
                spec.hf_revision.len(),
                40,
                "{} must pin a commit, not a branch",
                spec.model_id
            );
            assert_eq!(spec.sha256.len(), 64, "{} needs a sha256", spec.model_id);
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} sha256 is not hex",
                spec.model_id
            );
            assert!(spec.size_bytes > 0, "{} needs a size", spec.model_id);
            assert!(
                !spec.languages.is_empty(),
                "{} claims no languages",
                spec.model_id
            );
        }
    }

    /// Measured on 2026-09-03 and deliberately left out of the picker: both
    /// Voxtral tiers lost the dictation comparison by roughly an order of
    /// magnitude and emit no timestamps at all, so neither can serve meetings
    /// either. `artifacts/qa/model-selection-2026-09-03.md` has the numbers.
    #[test]
    fn the_measured_voxtral_tiers_are_not_offered_as_routes() {
        for model_id in [
            VOXTRAL_MINI_3B_GGUF_MODEL_ID,
            VOXTRAL_REALTIME_4B_GGUF_MODEL_ID,
        ] {
            assert!(
                !spec_for(model_id).offered_as_route,
                "{model_id} must stay out of the route catalog"
            );
            assert!(
                !route_model_options()
                    .iter()
                    .any(|option| option.id == model_id),
                "{model_id} must not be offered in the picker"
            );
            // Nameable from the benchmark, which is the whole point of
            // carrying the spec at all.
            assert!(benchmark_model_options()
                .iter()
                .any(|option| option.id == model_id));
            // A saved settings file naming one must fall back to a real route.
            assert!(route_spec_for(model_id).offered_as_route);
        }
    }

    #[test]
    fn the_streaming_language_gate_uses_the_list_the_pinned_file_declares() {
        let provider = TranscribeCppStreamingProvider::with_models_root(
            Path::new("/nonexistent"),
            DEFAULT_STREAMING_CHUNK_MS,
        );
        // 28 codes, from the GGUF's own `language:` metadata at the pinned
        // revision. Not NVIDIA's advertised 40 locales, and not the port
        // card's 32: this is the list the artifact on disk claims.
        assert_eq!(NEMOTRON_STREAMING_LANGUAGES.len(), 28);
        for supported in ["en", "es", "ja", "uk", "zh"] {
            assert!(provider.supports_language(Some(supported)), "{supported}");
        }
        // Locale forms resolve to their base language.
        assert!(provider.supports_language(Some("en-US")));
        assert!(provider.supports_language(Some("pt_BR")));
        // "no language selected" is not a refusal: the model detects it.
        assert!(provider.supports_language(None));
        assert!(provider.supports_language(Some("auto")));
        assert!(provider.supports_language(Some("  ")));
        // Anything the file does not declare keeps the older preview.
        for unsupported in ["yue", "th", "he", "sw", "fil"] {
            assert!(
                !provider.supports_language(Some(unsupported)),
                "{unsupported} is not in the pinned list and must not be claimed"
            );
        }
    }

    #[test]
    fn every_offered_chunk_size_maps_to_an_operating_point_the_model_ships() {
        // att_context_right 0/3/6/13 at 80 ms per encoder frame.
        assert_eq!(att_context_right_for_chunk_ms(80), 0);
        assert_eq!(att_context_right_for_chunk_ms(320), 3);
        assert_eq!(att_context_right_for_chunk_ms(560), 6);
        assert_eq!(att_context_right_for_chunk_ms(1120), 13);
        // Every size the app can pick is one of those.
        for chunk_ms in STREAMING_CHUNK_MS_CHOICES {
            assert!(
                [0, 3, 6, 13].contains(&att_context_right_for_chunk_ms(chunk_ms)),
                "{chunk_ms} ms has no operating point"
            );
        }
        // A size the model was not trained on falls back to the default rather
        // than pinning a right-context that does not exist.
        assert_eq!(
            att_context_right_for_chunk_ms(999),
            att_context_right_for_chunk_ms(DEFAULT_STREAMING_CHUNK_MS)
        );
    }

    #[test]
    fn a_chunk_size_outside_the_table_falls_back_to_the_default() {
        for requested in [0u32, 100, 999, 5_000] {
            let provider =
                TranscribeCppStreamingProvider::with_models_root(Path::new("/x"), requested);
            assert_eq!(provider.chunk_ms(), DEFAULT_STREAMING_CHUNK_MS);
        }
        for requested in STREAMING_CHUNK_MS_CHOICES {
            let provider =
                TranscribeCppStreamingProvider::with_models_root(Path::new("/x"), requested);
            assert_eq!(provider.chunk_ms(), requested);
        }
    }

    /// Readiness is the integrity receipt, not the bytes. A file that is merely
    /// present must not open a session.
    #[test]
    fn a_present_but_unverified_gguf_is_not_an_available_streaming_engine() {
        let root = std::env::temp_dir()
            .join("plainsong-streaming-availability")
            .join(uuid::Uuid::new_v4().to_string());
        let dir = root.join(TRANSCRIBE_CPP_MODEL_DIR);
        std::fs::create_dir_all(&dir).expect("create dir");
        let provider =
            TranscribeCppStreamingProvider::with_models_root(&root, DEFAULT_STREAMING_CHUNK_MS);
        assert!(!provider.is_streaming_available(), "no file at all");

        std::fs::write(provider.model_path(), b"not really a gguf").expect("write");
        assert!(
            !provider.is_streaming_available(),
            "bytes without a trusted integrity receipt are not a usable engine"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_streaming_engine_names_the_model_the_route_catalog_refuses_to_offer() {
        let provider = TranscribeCppStreamingProvider::with_models_root(
            Path::new("/x"),
            DEFAULT_STREAMING_CHUNK_MS,
        );
        assert_eq!(
            provider.streaming_model_id(),
            NEMOTRON_STREAMING_GGUF_MODEL_ID
        );
        // The whole point: it is a preview engine, never a transcription route.
        assert!(route_model_options()
            .iter()
            .all(|option| option.id != NEMOTRON_STREAMING_GGUF_MODEL_ID));
        assert!(!TranscribeCppStreamingProvider::spec().offered_as_route);
    }

    /// The real thing, when the weights happen to be installed on this machine.
    ///
    /// Skipped rather than failed otherwise: this is a unit-test suite that has
    /// to pass on a checkout with no 716 MB GGUF in it. `--stream` in
    /// `benchmark-latency` is the measured version of the same path, and
    /// `artifacts/qa/streaming-partials-receipt-2026-09-02.md` is its receipt.
    #[test]
    fn an_installed_streaming_engine_transcribes_a_fed_tone_without_panicking() {
        let provider = TranscribeCppStreamingProvider::new();
        if !provider.is_streaming_available() {
            eprintln!("skipping: the Nemotron streaming GGUF is not installed here");
            return;
        }
        let mut session = provider.open_session(Some("en")).expect("open a session");
        assert_eq!(
            session.chunk_samples(),
            streaming_chunk_samples(DEFAULT_STREAMING_CHUNK_MS)
        );
        // Silence: the words do not matter here, the state machine does.
        let chunk = vec![0.0f32; session.chunk_samples()];
        for _ in 0..3 {
            let partial = session.feed(&chunk).expect("feed silence");
            assert!(
                partial.elapsed_audio_s > 0.0,
                "the session must report the audio it has taken"
            );
        }
        let final_partial = session.finalize().expect("finalize");
        assert!(
            final_partial.is_empty(),
            "silence should not produce words: {final_partial:?}"
        );
        session.reset().expect("reset reopens the stream");
        session.feed(&chunk).expect("feed after reset");
    }

    #[test]
    fn every_pinned_model_has_an_immutable_url_and_a_full_length_digest() {
        for spec in MODEL_SPECS {
            assert_eq!(
                spec.sha256.len(),
                64,
                "{} must pin a full SHA-256",
                spec.model_id
            );
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} pinned a non-hex digest",
                spec.model_id
            );
            assert_eq!(
                spec.hf_revision.len(),
                40,
                "{} must pin a full commit sha, not a branch",
                spec.model_id
            );
            let url = spec.url();
            assert!(url.starts_with("https://huggingface.co/"), "{url}");
            assert!(url.contains(spec.hf_revision), "{url} is not pinned");
            assert!(url.ends_with(spec.file_name), "{url}");
            assert!(spec.size_bytes > 0);
            assert!(spec.max_bytes() > spec.size_bytes);
        }
    }

    #[test]
    fn only_the_parakeet_route_is_offered_to_the_route_catalog() {
        let options = route_model_options();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, PARAKEET_GGUF_MODEL_ID);
        // The streaming model is pinned and verifiable but never a route:
        // proving a batch decode is not shipping a streaming feature.
        assert!(MODEL_SPECS.iter().any(
            |spec| spec.model_id == NEMOTRON_STREAMING_GGUF_MODEL_ID && !spec.offered_as_route
        ));
    }

    #[test]
    fn an_unknown_model_id_falls_back_to_the_offered_route() {
        assert_eq!(spec_for("nope").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(spec_for("").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(
            spec_for("  nemotron-3.5-asr-streaming-0.6b-q8_0  ").model_id,
            NEMOTRON_STREAMING_GGUF_MODEL_ID
        );
    }

    #[test]
    fn integrity_artifacts_cover_every_pinned_file() {
        let artifacts = model_integrity_artifacts(Path::new("/models"));
        assert_eq!(artifacts.len(), MODEL_SPECS.len());
        for (path, digest) in artifacts {
            assert!(path.starts_with("/models/transcribe_cpp"));
            assert_eq!(digest.len(), 64);
        }
    }

    #[test]
    fn backend_choice_defaults_to_auto_for_anything_unrecognised() {
        assert_eq!(parse_backend_choice(None), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some("")), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some("vulkan")), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some(" METAL ")), BackendChoice::Metal);
        assert_eq!(parse_backend_choice(Some("Cpu")), BackendChoice::Cpu);
    }

    #[test]
    fn segments_are_seconds_and_never_run_backwards() {
        let raw = vec![
            RawSegment {
                start_ms: 0,
                end_ms: 1_500,
                text: " Hello there ".to_string(),
            },
            RawSegment {
                start_ms: 1_500,
                // A family that reports an end before its start must not
                // produce a backwards span; seeking in the meeting view
                // depends on it.
                end_ms: 900,
                text: "friend".to_string(),
            },
        ];
        let segments = build_segments(&raw, "Hello there friend", 3.0, 0.5);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_time, 0.0);
        assert_eq!(segments[0].end_time, 1.5);
        assert_eq!(segments[0].text, "Hello there");
        assert_eq!(segments[1].start_time, 1.5);
        assert_eq!(segments[1].end_time, 1.5);
        assert!(segments.iter().all(|segment| segment.confidence == 0.5));
    }

    #[test]
    fn blank_rows_are_dropped_and_untimed_text_still_yields_one_segment() {
        let raw = vec![RawSegment {
            start_ms: 0,
            end_ms: 0,
            text: "   ".to_string(),
        }];
        let segments = build_segments(&raw, "the whole decode", 5.25, 0.88);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_time, 0.0);
        assert_eq!(segments[0].end_time, 5.25);
        assert_eq!(segments[0].text, "the whole decode");
    }

    #[test]
    fn an_empty_decode_produces_no_segments() {
        assert!(build_segments(&[], "   ", 5.0, 0.88).is_empty());
    }

    #[test]
    fn a_negative_or_unknown_clip_length_never_becomes_a_negative_span() {
        let segments = build_segments(&[], "text", f64::NAN, 0.88);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].end_time, 0.0);
    }

    #[test]
    fn confidence_falls_back_to_the_documented_constant_when_no_token_scores_exist() {
        assert_eq!(token_confidence(&[]), UNSCORED_TRANSDUCER_CONFIDENCE);
        assert_eq!(
            token_confidence(&[f32::NAN, f32::NAN]),
            UNSCORED_TRANSDUCER_CONFIDENCE
        );
        // Out-of-range values are not probabilities and must not drag the mean.
        assert_eq!(
            token_confidence(&[2.0, -1.0]),
            UNSCORED_TRANSDUCER_CONFIDENCE
        );
        assert!((token_confidence(&[0.5, 1.0]) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn error_messages_name_the_next_action_and_never_carry_the_partial_transcript() {
        use transcribe_cpp::Error;

        let secret = "the user said something private";
        let truncated = Error::OutputTruncated {
            message: format!("run: {secret}"),
            partial: None,
        };
        let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &truncated);
        assert!(!rendered.contains(secret), "{rendered}");
        assert!(rendered.contains("incomplete"), "{rendered}");
        assert!(rendered.contains("shorter clip"), "{rendered}");

        let missing = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::ModelFileNotFound("whatever".into()),
        );
        assert!(
            missing.contains("Download the model from Settings"),
            "{missing}"
        );

        let backend = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::Backend("no metal device".into()),
        );
        assert!(backend.contains(BACKEND_ENV_VAR), "{backend}");

        let busy = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &Error::Busy("x".into()));
        assert!(
            busy.contains("Wait for the current transcription"),
            "{busy}"
        );

        // Every message names the route it is about.
        for error in [
            Error::InvalidArgument("x".into()),
            Error::NotImplemented("x".into()),
            Error::ModelLoad("x".into()),
            Error::OutOfMemory("x".into()),
            Error::Unsupported("x".into()),
            Error::BadStructSize("x".into()),
            Error::InputTooLong("x".into()),
            Error::VersionMismatch("x".into()),
            Error::Other("x".into()),
        ] {
            let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &error);
            assert!(rendered.contains(PARAKEET_GGUF_MODEL_ID), "{rendered}");
            assert!(rendered.ends_with('.'), "{rendered}");
        }
    }

    /// The bindings and the library they linked against agree. Cheap, and it
    /// runs in every build of the spike, including a `--no-default-features
    /// --features asr-transcribe-cpp` one that has no whisper.cpp to compare
    /// against.
    #[test]
    fn the_linked_library_matches_the_bindings() {
        let native = transcribe_cpp::version();
        assert!(!native.is_empty(), "libtranscribe reported no version");
        assert_eq!(
            native,
            transcribe_cpp::compiled_version(),
            "the linked libtranscribe disagrees with the bindings it was built against"
        );
    }

    /// The spike's headline risk: whisper-rs vendors its own ggml and
    /// transcribe.cpp vendors another, both statically linked into the same
    /// binary. They do not collide today because transcribe.cpp builds its
    /// tree with hidden visibility (`CMAKE_C_VISIBILITY_PRESET hidden`), so
    /// on Mach-O every one of its ggml symbols is `private external` while
    /// whisper-rs's are plain `external`.
    ///
    /// That is a property of two upstreams' build flags, not a guarantee, so
    /// this test drives ggml itself on both sides, from one process. Version
    /// and language-table calls (what this used to assert) never reach ggml at
    /// all, so they could not have detected interposition: the whole failure
    /// mode is one library's ggml answering for the other's.
    ///
    /// - transcribe.cpp: `devices()`/`device_count()`/`backend_available()` walk
    ///   its ggml backend registry.
    /// - whisper-rs: `print_system_info()` walks *its* ggml backend registry
    ///   (`ggml_backend_reg_count`/`_get`/`_get_proc_address` in whisper.cpp),
    ///   and `SystemInfo::default()` calls `ggml_cpu_has_*` directly.
    ///
    /// Both are model-free. Each is exercised again after the other has run, so
    /// a registry one library initialized under the other's symbols shows up as
    /// a changed answer rather than as a wrong transcript months later. Needs
    /// `asr-whisper`, or there is no second ggml in the binary to conflict with.
    #[cfg(feature = "asr-whisper")]
    #[test]
    fn both_ggml_copies_serve_their_own_library_in_one_process() {
        let devices = transcribe_cpp::devices();
        assert!(
            !devices.is_empty(),
            "transcribe.cpp's ggml registered no compute device"
        );
        assert_eq!(
            devices.len(),
            transcribe_cpp::device_count(),
            "device enumeration and count disagree"
        );
        assert!(
            transcribe_cpp::backend_available(Backend::Cpu),
            "transcribe.cpp's ggml reports no CPU backend"
        );

        // whisper.cpp's own ggml, in the same process.
        let whisper_info = whisper_rs::print_system_info();
        assert!(
            whisper_info.contains("WHISPER"),
            "whisper.cpp reported no system info: {whisper_info}"
        );
        assert!(
            whisper_info.len() > "WHISPER : COREML = 0 | OPENVINO = 0 | ".len(),
            "whisper.cpp's ggml backend registry walk produced nothing: {whisper_info}"
        );
        // ggml_cpu_has_* through whisper-rs's ggml. The values are host-
        // dependent (all four are x86 flags, so all false on Apple silicon);
        // that this returns at all is the point.
        let _ = whisper_rs::SystemInfo::default();

        // Each library still answers for itself after the other was driven.
        assert_eq!(transcribe_cpp::device_count(), devices.len());
        assert_eq!(whisper_rs::print_system_info(), whisper_info);
    }

    #[test]
    fn the_provider_reports_no_word_error_rate_it_did_not_measure() {
        let info = TranscribeCppProvider::new(None).model_info();
        assert!(info.word_error_rate.is_none());
        assert!(info.real_time_factor.is_none());
        assert_eq!(info.license, "CC-BY-4.0");
        assert_eq!(info.languages.len(), 25);
    }

    #[test]
    fn only_a_model_the_catalog_offers_survives_normalization() {
        // `spec_for` knows the streaming GGUF; the route lookup must not hand
        // it back, or a saved settings file could point the route at weights
        // the picker never lists and the app never downloads.
        assert_eq!(
            spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).model_id,
            NEMOTRON_STREAMING_GGUF_MODEL_ID
        );
        assert_eq!(
            route_spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).model_id,
            PARAKEET_GGUF_MODEL_ID
        );
        assert_eq!(route_spec_for("").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(route_spec_for("nope").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(
            route_spec_for(PARAKEET_GGUF_MODEL_ID).model_id,
            PARAKEET_GGUF_MODEL_ID
        );
        // Whatever it returns is something `model_options()` offers.
        for spec in MODEL_SPECS {
            let normalized = route_spec_for(spec.model_id);
            assert!(
                normalized.offered_as_route,
                "{} normalized to an unoffered route",
                spec.model_id
            );
            assert!(route_model_options()
                .iter()
                .any(|option| option.id == normalized.model_id));
        }
    }

    #[test]
    fn a_packaging_failure_keeps_a_short_form_of_what_the_library_said() {
        use transcribe_cpp::Error;

        let load = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::ModelLoad("unsupported architecture 'canary-1b'".into()),
        );
        assert!(
            load.contains("unsupported architecture 'canary-1b'"),
            "{load}"
        );
        assert!(
            load.contains("Re-download the model from Settings"),
            "{load}"
        );
        assert!(load.ends_with('.'), "{load}");

        let backend = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::Backend("no Metal device on this host".into()),
        );
        assert!(
            backend.contains("no Metal device on this host"),
            "{backend}"
        );
        assert!(backend.contains(BACKEND_ENV_VAR), "{backend}");

        let abi = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::VersionMismatch("library 0.3.0 vs headers 0.2.3".into()),
        );
        assert!(abi.contains("library 0.3.0 vs headers 0.2.3"), "{abi}");

        // An empty upstream message must not leave a dangling clause.
        let empty =
            describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &Error::ModelLoad(String::new()));
        assert!(!empty.contains("transcribe.cpp said"), "{empty}");
        assert!(empty.ends_with('.'), "{empty}");

        // A long or multi-line diagnostic is folded to one capped line.
        let noisy = short_upstream_detail(&format!("line one\n  line two {}", "x".repeat(400)));
        assert!(!noisy.contains('\n'), "{noisy}");
        assert_eq!(noisy.chars().count(), MAX_UPSTREAM_DETAIL_CHARS + 1);
        assert!(noisy.ends_with('…'), "{noisy}");

        // The classes whose payload comes from the audio still say nothing
        // about it.
        let secret = "the user said something private";
        for error in [
            Error::Aborted {
                message: format!("run: {secret}"),
                partial: None,
            },
            Error::OutputTruncated {
                message: format!("run: {secret}"),
                partial: None,
            },
        ] {
            let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &error);
            assert!(!rendered.contains(secret), "{rendered}");
        }
    }

    // The runtime cache is one process-global mutex, so the tests that take,
    // poison or contend it run one at a time.
    fn cache_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_panic_under_the_runtime_lock_does_not_wedge_the_route_forever() {
        let _serialized = cache_test_lock();

        let panicked = std::panic::catch_unwind(|| {
            let _held = runtime_cache().lock().expect("fresh lock");
            panic!("a decode panicked while holding the runtime");
        });
        assert!(panicked.is_err(), "the test needs the panic to unwind");
        assert!(
            runtime_cache().is_poisoned(),
            "the panic should have poisoned the cache"
        );

        // Before: `clear_cached_runtime` matched on `Ok(..)` and silently did
        // nothing, and every later decode failed on the poisoned lock.
        clear_cached_runtime();
        assert!(
            !runtime_cache().is_poisoned(),
            "clear_cached_runtime must clear the poison, not skip over it"
        );

        // The cache is usable again, and empty, so the next decode reloads.
        assert!(lock_runtime_cache().is_none());
        assert_eq!(cached_model_load_ms(), None);
    }

    #[test]
    fn decode_control_stops_on_cancel_and_on_deadline() {
        let flag = AtomicBool::new(false);
        let later = Instant::now() + Duration::from_secs(60);
        assert_eq!(check_decode_control(&flag, later), Ok(()));
        assert_eq!(
            check_decode_control(&flag, Instant::now() - Duration::from_millis(1)),
            Err(DecodeStop::DeadlineExceeded)
        );
        flag.store(true, Ordering::Relaxed);
        assert_eq!(
            check_decode_control(&flag, later),
            Err(DecodeStop::Cancelled)
        );
        // Cancellation wins over an expired deadline: an abandoned request is
        // not a slow one.
        assert_eq!(
            check_decode_control(&flag, Instant::now() - Duration::from_millis(1)),
            Err(DecodeStop::Cancelled)
        );
    }

    #[test]
    fn the_decode_budget_scales_with_the_audio_and_never_goes_below_the_floor() {
        assert_eq!(decode_budget_for_audio(0.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(-5.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(1.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(60.0), Duration::from_secs(240));
    }

    #[test]
    fn dropping_the_cancel_guard_flags_the_decode() {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _guard = CancelOnDrop(Arc::clone(&flag));
            assert!(!flag.load(Ordering::Relaxed));
        }
        assert!(flag.load(Ordering::Relaxed));
    }

    /// The watchdog against a stub decode: a closure that polls the same
    /// `CancelToken` the native session would poll between decode steps, so the
    /// whole cancel path is exercised without a GGUF on disk.
    fn stub_decode(token: &CancelToken, give_up_after: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < give_up_after {
            if token.is_cancelled() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn the_watchdog_cancels_a_stub_decode_when_the_deadline_passes() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_millis(60),
        );
        assert!(
            stub_decode(&token, Duration::from_secs(5)),
            "the decode should have been cancelled well before it gave up"
        );
        assert_eq!(watchdog.finish(), Some(DecodeStop::DeadlineExceeded));
        assert!(token.is_cancelled());
    }

    #[test]
    fn the_watchdog_cancels_a_stub_decode_when_the_caller_abandons_it() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_secs(300),
        );
        // What `CancelOnDrop` does when the request's future is dropped.
        abandoned.store(true, Ordering::Relaxed);
        assert!(
            stub_decode(&token, Duration::from_secs(5)),
            "an abandoned request must not keep decoding"
        );
        assert_eq!(watchdog.finish(), Some(DecodeStop::Cancelled));
    }

    #[test]
    fn a_decode_that_finishes_on_time_is_never_cancelled() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_secs(300),
        );
        assert!(!stub_decode(&token, Duration::from_millis(60)));
        assert_eq!(watchdog.finish(), None);
        assert!(!token.is_cancelled());
    }

    /// The `Busy` arm used to be unreachable: the runtime mutex was taken with
    /// a blocking `lock()`, so a second request waited for as long as the first
    /// decode took, with no way to say so. Now the wait is bounded by the
    /// request's own budget.
    #[test]
    fn a_request_that_cannot_get_the_runtime_says_so_instead_of_blocking_forever() {
        let _serialized = cache_test_lock();
        clear_cached_runtime();

        let held = runtime_cache().lock().expect("hold the runtime");
        let never_abandoned = AtomicBool::new(false);
        let started = Instant::now();
        // `MutexGuard<Option<CachedRuntime>>` is not `Debug`, so match rather
        // than `expect_err`.
        let error = match acquire_runtime(
            &never_abandoned,
            Instant::now() + Duration::from_millis(80),
            "parakeet-tdt-0.6b-v3-Q8_0.gguf",
            Duration::from_millis(80),
        ) {
            Ok(_) => panic!("the runtime is held, so acquisition must not succeed"),
            Err(error) => error,
        };
        let waited = started.elapsed();
        drop(held);

        assert!(
            waited < Duration::from_secs(5),
            "the wait must be bounded, took {waited:?}"
        );
        let rendered = error.to_string();
        assert!(rendered.contains("already transcribing"), "{rendered}");
        assert!(
            rendered.contains("Wait for the current transcription"),
            "{rendered}"
        );

        // And an abandoned request waiting for the runtime reports the abort,
        // not a timeout it never reached.
        let abandoned = AtomicBool::new(true);
        let rendered = runtime_wait_error(
            check_decode_control(&abandoned, Instant::now() + Duration::from_secs(60))
                .expect_err("abandoned"),
            "parakeet-tdt-0.6b-v3-Q8_0.gguf",
            Duration::from_secs(30),
        )
        .to_string();
        assert!(rendered.contains("was cancelled"), "{rendered}");
    }

    fn write_plausible_but_unverified_gguf(model_path: &Path) {
        std::fs::create_dir_all(model_path.parent().expect("model dir")).expect("create model dir");
        // A GGUF magic and enough bytes to look like weights. The point is that
        // none of that is what readiness turns on.
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 8192));
        std::fs::write(model_path, bytes).expect("write gguf");
    }

    /// Readiness must follow the integrity receipt, not plausible bytes: a
    /// swapped GGUF of the right shape would otherwise be loaded and decoded.
    #[tokio::test]
    async fn readiness_requires_an_integrity_receipt_not_just_a_plausible_gguf() {
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-trust-{}", uuid::Uuid::new_v4()));
        let provider = TranscribeCppProvider::with_models_root(&root, None);
        let model_path = provider.model_path();
        write_plausible_but_unverified_gguf(&model_path);

        assert!(provider.has_required_file(), "structure check passes");
        assert_eq!(provider.download_status(), DownloadStatus::Downloaded);
        assert!(!provider.is_available(), "no receipt, so not ready");
        let error = provider
            .prewarm()
            .await
            .expect_err("untrusted weights must not load");
        assert!(
            error.to_string().contains("integrity verification")
                || error.to_string().contains("not downloaded and verified"),
            "{error}"
        );

        // The receipt the download path writes once the file's hash matched its
        // pin is what makes the same bytes trusted.
        crate::download::record_model_integrity_receipt_for_tests(
            &model_path,
            provider.spec().sha256,
        )
        .await
        .expect("receipt");
        assert!(provider.has_trusted_required_file());
        assert!(provider.is_available());

        // Swapping the file invalidates the receipt: it is bound to the size
        // and mtime of the bytes that were hashed, so a forgery of the right
        // shape does not inherit the old receipt's trust.
        std::fs::write(&model_path, vec![0x11u8; 4096]).expect("swap weights");
        assert!(
            !provider.is_available(),
            "swapped weights must not stay trusted"
        );
        let error = provider
            .transcribe(&model_path)
            .await
            .expect_err("a swapped GGUF must be refused before any decode");
        assert!(
            error.to_string().contains("integrity verification"),
            "{error}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_provider_is_rooted_at_the_models_directory_it_is_given() {
        let provider = TranscribeCppProvider::with_models_root(Path::new("/models"), None);
        assert_eq!(
            provider.model_path(),
            Path::new("/models/transcribe_cpp/parakeet-tdt-0.6b-v3-Q8_0.gguf")
        );
        assert!(!provider.is_available(), "nothing is on disk at /models");
    }

    /// The ordinary open: the worker reported its load time, so the thread is
    /// finishing and joining it costs nothing.
    #[test]
    fn a_worker_that_reports_its_load_time_is_joined() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        ready_tx.send(Ok(512)).expect("send ready");
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert_eq!(outcome.expect("a load time"), 512);
    }

    /// It answered with a failure -- a missing file, a non-streaming model --
    /// so it is on its way out and the error is the caller's.
    #[test]
    fn a_worker_that_reports_a_load_failure_is_joined() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        ready_tx
            .send(Err(anyhow::anyhow!("could not read the weights")))
            .expect("send failure");
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert!(outcome
            .expect_err("a failure")
            .to_string()
            .contains("could not read the weights"));
    }

    /// The worker died without a word. Its channel is gone, so joining is
    /// bounded and the caller still gets a named failure.
    #[test]
    fn a_worker_that_hangs_up_is_joined_and_named() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        drop(ready_tx);
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert!(outcome
            .expect_err("a failure")
            .to_string()
            .contains("nemotron.gguf"));
    }

    /// The finding this exists for: a `Model::load_with` that never returns
    /// used to park `open` forever on a blocking-pool thread, so the preview
    /// neither opened nor failed and every later stop paid the close timeout
    /// in full. The wait is now bounded and the thread is detached, exactly
    /// like a `feed` that stops answering.
    #[test]
    fn a_load_that_never_answers_times_out_and_detaches() {
        // Held open on purpose: a live sender with nothing to say is the
        // wedged load, not a hang-up.
        let (_ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        let started = Instant::now();
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_millis(120), "nemotron.gguf");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the wait must be bounded by its timeout, not by the load"
        );
        assert_eq!(
            disposition,
            WorkerDisposition::Detach,
            "a thread that may still be inside the native load must not be joined"
        );
        let error = outcome.expect_err("a failure").to_string();
        assert!(error.contains("nemotron.gguf"), "{error}");
        assert!(error.contains("did not load"), "{error}");
    }

    /// The open path uses the same ceiling as every other call into the
    /// engine, so "the preview stopped answering" means one thing.
    #[test]
    fn the_open_wait_uses_the_same_ceiling_as_every_other_call() {
        const SOURCE: &str = include_str!("transcribe_cpp.rs");
        let start = SOURCE.find("    fn open(").expect("open must exist");
        let end = start
            + SOURCE[start..]
                .find("\n    }\n")
                .expect("open must be closed");
        let body = &SOURCE[start..end];
        assert!(
            body.contains("await_worker_ready(&ready_rx, STREAM_CALL_TIMEOUT"),
            "open must wait with the shared ceiling rather than blocking forever"
        );
        assert!(
            !body.contains("ready_rx.recv()"),
            "an unbounded recv on the ready channel is the wedge this replaced"
        );
    }
}
