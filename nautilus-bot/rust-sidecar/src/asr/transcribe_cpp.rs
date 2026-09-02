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
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, ModelOption, TranscriptSegment,
    TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, Session, TimestampKind};

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
];

pub(crate) fn spec_for(model_id: &str) -> &'static TranscribeCppModelSpec {
    let trimmed = model_id.trim();
    MODEL_SPECS
        .iter()
        .find(|spec| spec.model_id == trimmed)
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

/// One user-facing sentence per failure class: what happened, why, and the next
/// action. Deliberately does NOT include `error.partial()` — a partial
/// transcript is user speech and must not be pasted into a log line or an error
/// toast.
pub(crate) fn describe_transcribe_error(model_id: &str, error: &transcribe_cpp::Error) -> String {
    use transcribe_cpp::Error;
    match error {
        Error::ModelFileNotFound(_) => format!(
            "The transcribe.cpp weights for '{model_id}' are not on disk. Download the model from Settings."
        ),
        Error::ModelLoad(_) => format!(
            "transcribe.cpp could not load '{model_id}': the GGUF is unreadable or its architecture is not supported by this build. Re-download the model from Settings."
        ),
        Error::Backend(_) => format!(
            "transcribe.cpp could not use the requested compute backend for '{model_id}'. Unset {BACKEND_ENV_VAR} to let it choose, or use another route."
        ),
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
        Error::VersionMismatch(_) | Error::BadStructSize(_) => format!(
            "The bundled transcribe.cpp library does not match the bindings this build was compiled against, so '{model_id}' cannot run. This is a packaging fault; report it."
        ),
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
}

fn runtime_cache() -> &'static Mutex<Option<CachedRuntime>> {
    static CACHE: OnceLock<Mutex<Option<CachedRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn runtime_key(model_path: &Path, backend: BackendChoice) -> String {
    format!("{}::{}", model_path.to_string_lossy(), backend.label())
}

/// Drop any cached native model, so a re-download or a settings change cannot
/// keep serving transcripts from weights that are no longer on disk.
pub(crate) fn clear_cached_runtime() {
    if let Ok(mut cache) = runtime_cache().lock() {
        if cache.take().is_some() {
            tracing::info!("Cleared cached transcribe.cpp runtime");
        }
    }
}

/// Wall-clock milliseconds spent loading the cached model, or `None` when no
/// model is loaded. The benchmark reports this; nothing in the app reads it.
pub fn cached_model_load_ms() -> Option<u64> {
    runtime_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().map(|runtime| runtime.load_ms))
}

struct NativeRun {
    text: String,
    raw_segments: Vec<RawSegment>,
    token_probabilities: Vec<f32>,
    load_ms: u64,
    language: Option<String>,
}

fn run_native(model_path: &Path, backend: BackendChoice, pcm: &[f32]) -> Result<NativeRun> {
    let key = runtime_key(model_path, backend);
    let mut cache = runtime_cache()
        .lock()
        .map_err(|_| anyhow::anyhow!("transcribe.cpp runtime lock was poisoned"))?;

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
        .map_err(|error| {
            anyhow::anyhow!(describe_transcribe_error(
                &model_path.file_name().unwrap_or_default().to_string_lossy(),
                &error
            ))
        })?;
        let session = model.session().map_err(|error| {
            anyhow::anyhow!(describe_transcribe_error(
                &model_path.file_name().unwrap_or_default().to_string_lossy(),
                &error
            ))
        })?;
        let load_ms = started.elapsed().as_millis() as u64;
        tracing::info!(
            "transcribe.cpp loaded {} on {} in {} ms",
            model_path.display(),
            backend.label(),
            load_ms
        );
        *cache = Some(CachedRuntime {
            key,
            _model: model,
            session,
            load_ms,
        });
    }

    let runtime = cache
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("transcribe.cpp runtime disappeared after loading"))?;

    let options = RunOptions {
        // Segment granularity is what the dictation and meeting contracts
        // consume; asking for `Auto` would let a family return token rows we
        // then throw away.
        timestamps: TimestampKind::Segment,
        ..RunOptions::default()
    };

    let transcript = runtime.session.run(pcm, &options).map_err(|error| {
        anyhow::anyhow!(describe_transcribe_error(
            &model_path.file_name().unwrap_or_default().to_string_lossy(),
            &error
        ))
    })?;

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
        let spec = spec_for(selected_model_id.unwrap_or(PARAKEET_GGUF_MODEL_ID));
        let model_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models")
            .join(TRANSCRIBE_CPP_MODEL_DIR);
        Self {
            model_dir,
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

    fn is_available(&self) -> bool {
        self.has_required_file()
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

        let run = tokio::task::spawn_blocking(move || run_native(&model_path, backend, &samples))
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
        std::fs::write(&temp_path, audio_data)
            .context("failed to write temp wav for transcribe.cpp")?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
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
        tokio::task::spawn_blocking(move || run_native(&model_path, backend, &silence))
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// The spike's headline risk: whisper-rs vendors its own ggml and
    /// transcribe.cpp vendors another, both statically linked into the same
    /// binary. They do not collide today because transcribe.cpp builds its
    /// tree with hidden visibility (`CMAKE_C_VISIBILITY_PRESET hidden`), so
    /// on Mach-O every one of its ggml symbols is `private external` while
    /// whisper-rs's are plain `external`.
    ///
    /// That is a property of two upstreams' build flags, not a guarantee, so
    /// this test calls into BOTH native libraries from one process. It needs
    /// no model on disk: `transcribe_version()` and `whisper_lang_str()` are
    /// pure C entry points. If a future bump makes the two ggml copies fight,
    /// this fails here rather than in somebody's dictation.
    #[test]
    fn both_native_runtimes_are_callable_from_one_process() {
        let native = transcribe_cpp::version();
        assert!(!native.is_empty(), "libtranscribe reported no version");
        assert_eq!(
            native,
            transcribe_cpp::compiled_version(),
            "the linked libtranscribe disagrees with the bindings it was built against"
        );

        // whisper.cpp, in the same process, still answers on its own symbols.
        assert_eq!(whisper_rs::get_lang_str(0), Some("en"));
        assert_eq!(whisper_rs::get_lang_str(-1), None);

        // ... and transcribe.cpp still answers after whisper.cpp was touched.
        assert_eq!(transcribe_cpp::version(), native);
    }

    #[test]
    fn the_provider_reports_no_word_error_rate_it_did_not_measure() {
        let info = TranscribeCppProvider::new(None).model_info();
        assert!(info.word_error_rate.is_none());
        assert!(info.real_time_factor.is_none());
        assert_eq!(info.license, "CC-BY-4.0");
        assert_eq!(info.languages.len(), 25);
    }
}
