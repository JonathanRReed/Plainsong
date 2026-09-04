//! Cohere Transcribe 03-2026, run locally on ONNX Runtime.
//!
//! Plainsong already calls Cohere Transcribe as a cloud API (`asr/cohere.rs`).
//! The same weights are Apache-2.0 and the community export
//! `onnx-community/cohere-transcribe-03-2026-ONNX` publishes them as ONNX, so
//! this route is the identical model with no key, no upload and no network.
//! `docs/model-inventory-2026-09.md` §5 ranks it the highest-value local model
//! outstanding: 5.42% WER against Parakeet TDT v3's 6.32%, over 14 languages.
//!
//! # Shape of the export
//!
//! Two graphs, both int4-quantized (`*_q4`), each with its weights in a
//! sidecar `.onnx_data` file:
//!
//! - `encoder_model_q4.onnx` — a 48-layer FastConformer (`parakeet_encoder`,
//!   d_model 1280, 8× subsampling). `input_features [1, frames, 128]` f32 in,
//!   `last_hidden_state [1, frames/8, 1024]` f32 out.
//! - `decoder_model_merged_q4.onnx` — an 8-layer transformer decoder with a
//!   merged prefill/step graph: `input_ids`, `attention_mask`, `position_ids`,
//!   `num_logits_to_keep`, `encoder_hidden_states` and 32 `past_key_values.*`
//!   tensors in; `logits [1, kept, 16384]` and 32 `present.*` tensors out.
//!
//! The `.onnx_data` filenames are recorded **inside** the graphs, so the local
//! copies keep their upstream names exactly. Renaming them breaks the load
//! with an error that points at the graph rather than at the rename.
//!
//! # Why this is experimental, and never the default
//!
//! The encoder is roughly 1.9B of the model's 2B parameters and there is no
//! Metal path: `ort` links ONNX Runtime's CPU provider here, and the CoreML EP
//! is measured to be a regression on this app's other ONNX graphs
//! (`scripts/sidecar-cargo-features.mjs`). So this route buys accuracy with
//! wall time. The decision rule from the inventory doc is that it earns a
//! promoted slot only if it lands within ~1.5× of Parakeet's latency on the
//! 5.3 s fixture; the receipt
//! `artifacts/qa/cohere-local-receipt-2026-09-02.md` records what it actually
//! did.
//!
//! # Two honest limitations
//!
//! 1. **No language auto-detection.** The decoder prompt names the language
//!    twice and the processor rejects anything outside its 14. A request with
//!    no language selected is transcribed as English, and the route copy says
//!    so rather than implying detection.
//! 2. **No real timestamps.** The prompt this route sends carries
//!    `<|notimestamp|>`, so the token stream has no time anchors. Segments are
//!    cut at sentence boundaries and their times apportioned by character
//!    count — good enough to read, not good enough to seek or to diarize
//!    against — which is why the route is not offered for meetings.

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment,
    TranscriptionOptions, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(feature = "asr-parakeet")]
use std::sync::{Mutex, OnceLock};
#[cfg(feature = "asr-parakeet")]
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/// Route model id. The `-q4` suffix is part of the identity: the export
/// publishes fp32, fp16, int8 and int4 variants and they are different
/// artifacts with different digests, so the setting has to say which one.
pub(crate) const COHERE_LOCAL_MODEL_ID: &str = "cohere-transcribe-03-2026-q4";
const COHERE_LOCAL_HF_REPO: &str = "onnx-community/cohere-transcribe-03-2026-ONNX";
/// Pinned to a commit, not to `main`: the digests below are only meaningful
/// against an immutable revision.
const COHERE_LOCAL_HF_REVISION: &str = "31b1c6211c9000d76b077ddd23b74c9090badeba";
/// Directory under `models/` holding the flat bundle.
pub(crate) const COHERE_LOCAL_MODEL_DIR: &str = "cohere_local";

// The four ONNX artifacts keep their upstream names because the two `.onnx`
// graphs name their `.onnx_data` companions internally.
const LOCAL_ENCODER: &str = "encoder_model_q4.onnx";
const LOCAL_ENCODER_DATA: &str = "encoder_model_q4.onnx_data";
const LOCAL_DECODER: &str = "decoder_model_merged_q4.onnx";
const LOCAL_DECODER_DATA: &str = "decoder_model_merged_q4.onnx_data";
const LOCAL_TOKENIZER: &str = "tokenizer.json";
const LOCAL_CONFIG: &str = "config.json";
const LOCAL_GENERATION_CONFIG: &str = "generation_config.json";
const LOCAL_PREPROCESSOR: &str = "preprocessor_config.json";

/// Total bytes of the eight pinned files, summed from the sizes HuggingFace
/// publishes and confirmed against the downloaded copies on 2026-09-02.
const COHERE_LOCAL_BUNDLE_BYTES: u64 = 2_127_674_554;

// ---------------------------------------------------------------------------
// Front end (CohereAsrFeatureExtractor), and the decode budget
// ---------------------------------------------------------------------------

/// Sample rate the export's feature extractor declares.
pub(crate) const COHERE_LOCAL_SAMPLE_RATE: u32 = 16_000;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_N_FFT: usize = 512;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_HOP_LENGTH: usize = 160;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_WIN_LENGTH: usize = 400;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_N_MELS: usize = 128;
/// `LOG_ZERO_GUARD_VALUE` in `feature_extraction_cohere_asr.py`.
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_LOG_ZERO_GUARD: f64 = 5.960_464_477_539_063e-8; // 2^-24
/// `EPSILON` in the same file, added to the per-bin standard deviation.
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_NORM_EPSILON: f64 = 1e-5;

/// Pre-emphasis coefficient from `preprocessor_config.json`.
const COHERE_LOCAL_PREEMPHASIS: f32 = 0.97;
/// `max_audio_clip_s`: the longest clip the encoder is exported for.
const COHERE_LOCAL_MAX_CLIP_SECONDS: f64 = 35.0;
/// `overlap_chunk_second`: how far back from a chunk boundary the splitter
/// looks for a quiet point. Despite the upstream name the chunks do **not**
/// overlap — this is a search span, not an overlap.
const COHERE_LOCAL_BOUNDARY_SEARCH_SECONDS: f64 = 5.0;
/// `min_energy_window_samples`: the RMS window the splitter slides.
const COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES: usize = 1600;

/// Token budget per second of audio, with the same shape as Qwen3-ASR's: a
/// decoder that never emits EOS must stop somewhere, and "somewhere" has to
/// scale with the audio or a long dictation is silently truncated. 12 tokens
/// per second is roughly 3× the fastest observed speech rate on this
/// tokenizer.
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_MAX_TOKENS_PER_AUDIO_SECOND: f64 = 12.0;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_MIN_NEW_TOKENS: usize = 64;
/// `max_position_embeddings` in `config.json` is 1024; the decoder cannot be
/// asked for more positions than it was exported with.
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_MAX_NEW_TOKENS_CEILING: usize = 1024;

/// Wall-clock the decode of one chunk may take, per second of audio in it.
/// Generous because this route is CPU-only and 2B parameters: the budget is a
/// wedge guard, not a performance target.
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_DECODE_BUDGET_PER_AUDIO_SECOND: f64 = 30.0;
#[cfg(feature = "asr-parakeet")]
const COHERE_LOCAL_DECODE_BUDGET_MIN_SECONDS: f64 = 120.0;

/// The 14 languages `CohereAsrProcessor.LANGUAGES` accepts, with the display
/// names the settings list uses. Anything outside this set is refused rather
/// than quietly transcribed as English.
pub(crate) const COHERE_LOCAL_LANGUAGES: &[(&str, &str)] = &[
    ("Arabic", "ar"),
    ("German", "de"),
    ("Greek", "el"),
    ("English", "en"),
    ("Spanish", "es"),
    ("French", "fr"),
    ("Italian", "it"),
    ("Japanese", "ja"),
    ("Korean", "ko"),
    ("Dutch", "nl"),
    ("Polish", "pl"),
    ("Portuguese", "pt"),
    ("Vietnamese", "vi"),
    ("Chinese", "zh"),
];

/// Languages written without spaces between words, which the upstream
/// processor joins chunk texts for with an empty separator.
const COHERE_LOCAL_NO_SPACE_LANGUAGES: [&str; 2] = ["ja", "zh"];

/// The language a request with no explicit selection is decoded as.
///
/// This route has no auto-detect path: the decoder prompt carries the language
/// tag twice, so *something* has to be chosen. English is the choice, and the
/// route copy says so.
pub(crate) const COHERE_LOCAL_DEFAULT_LANGUAGE: &str = "en";

// ---------------------------------------------------------------------------
// Pure helpers (no ONNX, no weights, so they are testable everywhere)
// ---------------------------------------------------------------------------

/// Map a user-selected language tag onto one of the 14 the model accepts.
///
/// Accepts a bare code (`"fr"`) or a region-qualified one (`"pt-BR"`), and is
/// case-insensitive. Returns `None` for anything the model does not list —
/// callers surface that as an error rather than substituting English.
pub(crate) fn supported_language_code(requested: &str) -> Option<&'static str> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = trimmed
        .split(['-', '_'])
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    COHERE_LOCAL_LANGUAGES
        .iter()
        .find(|(_, code)| *code == base)
        .map(|(_, code)| *code)
}

/// The decoder prompt `CohereAsrProcessor.get_decoder_prompt_ids` builds.
///
/// Ten control tokens, in this order, resolved through `lookup` so the shape
/// can be tested without the 1.1 MB tokenizer on disk. `<|notimestamp|>` and
/// `<|nodiarize|>` are deliberate: this route claims neither, so it must not
/// ask the model for either.
pub(crate) fn decoder_prompt_tokens(language: &str, punctuation: bool) -> [String; 10] {
    let language_tag = format!("<|{language}|>");
    [
        "\u{2581}".to_string(),
        "<|startofcontext|>".to_string(),
        "<|startoftranscript|>".to_string(),
        "<|emo:undefined|>".to_string(),
        language_tag.clone(),
        language_tag,
        if punctuation { "<|pnc|>" } else { "<|nopnc|>" }.to_string(),
        "<|noitn|>".to_string(),
        "<|notimestamp|>".to_string(),
        "<|nodiarize|>".to_string(),
    ]
}

/// Apply the first-order pre-emphasis filter the extractor applies:
/// `y[0] = x[0]`, `y[i] = x[i] - coefficient * x[i - 1]`.
pub(crate) fn preemphasize(samples: &[f32], coefficient: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(samples.len());
    out.push(samples[0]);
    for index in 1..samples.len() {
        out.push(samples[index] - coefficient * samples[index - 1]);
    }
    out
}

/// Split audio into clips of at most `max_audio_clip_s`, cutting at the
/// quietest 100 ms window in the last `overlap_chunk_second` of each clip.
///
/// A port of `_split_audio_chunks_energy`. The clips do not overlap and they
/// cover every sample exactly once, which is what lets the texts be joined
/// with a separator rather than de-duplicated.
pub(crate) fn split_audio_into_chunks(samples: &[f32], sample_rate: u32) -> Vec<(usize, usize)> {
    let total = samples.len();
    if total == 0 {
        return Vec::new();
    }
    let rate = f64::from(sample_rate.max(1));
    let chunk_size = ((COHERE_LOCAL_MAX_CLIP_SECONDS * rate).round() as usize).max(1);
    let search_span = ((COHERE_LOCAL_BOUNDARY_SEARCH_SECONDS * rate).round() as usize).max(1);
    if total <= chunk_size {
        return vec![(0, total)];
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < total {
        if start + chunk_size >= total {
            chunks.push((start, total));
            break;
        }
        let search_start = start.max(start + chunk_size - search_span);
        let search_end = (start + chunk_size).min(total);
        let split = if search_end <= search_start {
            start + chunk_size
        } else {
            quietest_split_point(samples, search_start, search_end)
        };
        let split = split.clamp(start + 1, total);
        chunks.push((start, split));
        start = split;
    }
    chunks.into_iter().filter(|(a, b)| b > a).collect()
}

/// The start of the lowest-RMS `min_energy_window_samples` window inside
/// `[start, end)`, or `end` when the span is too short to hold one window.
fn quietest_split_point(samples: &[f32], start: usize, end: usize) -> usize {
    let span = end.saturating_sub(start);
    if span <= COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES {
        return end;
    }
    let upper = span - COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES;
    let mut best_energy = f64::INFINITY;
    let mut best = end;
    let mut offset = 0usize;
    while offset < upper {
        let window =
            &samples[start + offset..start + offset + COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES];
        let energy = (window
            .iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum::<f64>()
            / COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES as f64)
            .sqrt();
        if energy < best_energy {
            best_energy = energy;
            best = start + offset;
        }
        offset += COHERE_LOCAL_MIN_ENERGY_WINDOW_SAMPLES;
    }
    best
}

/// Join per-chunk texts the way `_reassemble_chunk_texts` does: drop empties,
/// right-trim the first, trim the rest, and join with a space (or nothing for
/// a language written without them).
pub(crate) fn join_chunk_texts(texts: &[String], language: &str) -> String {
    let separator = if COHERE_LOCAL_NO_SPACE_LANGUAGES.contains(&language) {
        ""
    } else {
        " "
    };
    let non_empty: Vec<&String> = texts
        .iter()
        .filter(|text| !text.trim().is_empty())
        .collect();
    let Some((first, rest)) = non_empty.split_first() else {
        return String::new();
    };
    let mut parts: Vec<&str> = vec![first.trim_end()];
    parts.extend(rest.iter().map(|text| text.trim()));
    parts.join(separator)
}

/// Cut a transcript into sentence-shaped segments and apportion the clip's
/// duration across them by character count.
///
/// These times are **not** measured. The prompt carries `<|notimestamp|>`, so
/// the token stream has no time anchors at all; this exists so the transcript
/// renders as more than one block, and every caller that needs real times
/// (seeking, diarization alignment) is kept off this route instead.
pub(crate) fn apportioned_segments(
    text: &str,
    start_seconds: f64,
    end_seconds: f64,
) -> Vec<TranscriptSegment> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let span = (end_seconds - start_seconds).max(0.0);
    let sentences = split_sentences(trimmed);
    let total_chars: usize = sentences.iter().map(|s| s.chars().count()).sum();
    if sentences.len() <= 1 || total_chars == 0 || span <= 0.0 {
        return vec![TranscriptSegment {
            start_time: start_seconds,
            end_time: end_seconds,
            text: trimmed.to_string(),
            confidence: 0.9,
        }];
    }

    let mut segments = Vec::with_capacity(sentences.len());
    let mut consumed = 0usize;
    let mut cursor = start_seconds;
    for (index, sentence) in sentences.iter().enumerate() {
        consumed += sentence.chars().count();
        let next = if index + 1 == sentences.len() {
            end_seconds
        } else {
            start_seconds + span * (consumed as f64 / total_chars as f64)
        };
        segments.push(TranscriptSegment {
            start_time: cursor,
            end_time: next.max(cursor),
            text: sentence.clone(),
            confidence: 0.9,
        });
        cursor = next.max(cursor);
    }
    segments
}

/// Split on sentence-final punctuation, keeping the punctuation with its
/// sentence. Deliberately simple: it only has to produce readable blocks, and
/// a cleverer splitter would imply a precision the times do not have.
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        current.push(character);
        if matches!(character, '.' | '!' | '?' | '。' | '！' | '？') {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                sentences.push(trimmed.to_string());
            }
            current.clear();
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        sentences.push(trimmed.to_string());
    }
    if sentences.is_empty() {
        sentences.push(text.to_string());
    }
    sentences
}

#[cfg(feature = "asr-parakeet")]
fn max_new_tokens_for_audio(audio_seconds: f64) -> usize {
    if !audio_seconds.is_finite() || audio_seconds <= 0.0 {
        return COHERE_LOCAL_MIN_NEW_TOKENS;
    }
    let scaled = (audio_seconds * COHERE_LOCAL_MAX_TOKENS_PER_AUDIO_SECOND).ceil() as usize + 16;
    scaled.clamp(
        COHERE_LOCAL_MIN_NEW_TOKENS,
        COHERE_LOCAL_MAX_NEW_TOKENS_CEILING,
    )
}

#[cfg(feature = "asr-parakeet")]
fn decode_budget_for_audio(audio_seconds: f64) -> Duration {
    let seconds = if audio_seconds.is_finite() && audio_seconds > 0.0 {
        (audio_seconds * COHERE_LOCAL_DECODE_BUDGET_PER_AUDIO_SECOND)
            .max(COHERE_LOCAL_DECODE_BUDGET_MIN_SECONDS)
    } else {
        COHERE_LOCAL_DECODE_BUDGET_MIN_SECONDS
    };
    Duration::from_secs_f64(seconds)
}

#[cfg(feature = "asr-parakeet")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodeStop {
    Cancelled,
    DeadlineExceeded,
    TokenCap,
}

#[cfg(feature = "asr-parakeet")]
fn check_decode_control(cancelled: &AtomicBool, deadline: Instant) -> Result<(), DecodeStop> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(DecodeStop::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(DecodeStop::DeadlineExceeded);
    }
    Ok(())
}

/// A stop is an error, never a short transcript: a decode that ran out of
/// budget produced a prefix of a sentence, and returning it as if it were the
/// whole thing is the failure mode this route must not have.
#[cfg(feature = "asr-parakeet")]
fn decode_stop_error(
    stop: DecodeStop,
    produced: usize,
    cap: usize,
    audio_seconds: f64,
) -> anyhow::Error {
    match stop {
        DecodeStop::Cancelled => anyhow::anyhow!(
            "Cohere Transcribe (local) decode was cancelled after {produced} tokens."
        ),
        DecodeStop::DeadlineExceeded => anyhow::anyhow!(
            "Cohere Transcribe (local) decode exceeded its {:.0} s budget after {produced} tokens; \
             the transcript would have been truncated.",
            decode_budget_for_audio(audio_seconds).as_secs_f64()
        ),
        DecodeStop::TokenCap => anyhow::anyhow!(
            "Cohere Transcribe (local) decode hit its {cap}-token cap for {audio_seconds:.1} s of \
             audio without reaching end-of-text; the transcript would have been truncated."
        ),
    }
}

/// Flips a shared flag when the caller's future is dropped, so a blocking
/// decode nobody is waiting on stops at its next token.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Pinned artifacts and integrity
// ---------------------------------------------------------------------------

/// Upper bound on each artifact's download, so a redirect to something huge
/// is refused before it fills the disk. Generous but finite.
fn cohere_local_artifact_max_bytes(local_name: &str) -> u64 {
    match local_name {
        LOCAL_ENCODER_DATA => 3 * 1024 * 1024 * 1024,
        LOCAL_DECODER_DATA => 512 * 1024 * 1024,
        LOCAL_ENCODER | LOCAL_DECODER => 64 * 1024 * 1024,
        LOCAL_TOKENIZER => 16 * 1024 * 1024,
        _ => 1024 * 1024,
    }
}

/// The eight pinned files: `(repo, revision, path in repo, local name, sha256)`.
///
/// The digests are the `lfs.sha256` values HuggingFace publishes for
/// `onnx-community/cohere-transcribe-03-2026-ONNX` at revision
/// `31b1c621…`, and the locally-computed SHA-256 of the four small files it
/// stores in git. Verified against the downloaded bytes on 2026-09-02.
fn cohere_local_repo_files() -> [(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
); 8] {
    [
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "onnx/encoder_model_q4.onnx",
            LOCAL_ENCODER,
            "de0f7e2c5f4c2e46e3704704a3cb41153ed45f5af07530b4b1d34f895c36db4b",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "onnx/encoder_model_q4.onnx_data",
            LOCAL_ENCODER_DATA,
            "c5c668cc8c5951c789893ad25b06c654fc7cced7fb0989ad7ef0fb44a0554ee6",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "onnx/decoder_model_merged_q4.onnx",
            LOCAL_DECODER,
            "a565cdfa7ad3e12e1149e8cdcf519ade36f9e76c43038471c876c25893f8f8bf",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "onnx/decoder_model_merged_q4.onnx_data",
            LOCAL_DECODER_DATA,
            "9223643714186378c6aa0c95439d74298ed25d40b43b6737c55c016055ceb1ee",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "tokenizer.json",
            LOCAL_TOKENIZER,
            "e263c0ba13be0f0803705b002756908f84efc6e75a4c273231a01c4371908a2b",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "config.json",
            LOCAL_CONFIG,
            "09cec8fb9a44e8c278b23efd2b8afbf29e560c2eb2b5c1a6b448d8b33a6632bf",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "generation_config.json",
            LOCAL_GENERATION_CONFIG,
            "dd575639e03b2651c2ecad52c1a51e6126d2a516780cfe85e7b4517f05bd9754",
        ),
        (
            COHERE_LOCAL_HF_REPO,
            COHERE_LOCAL_HF_REVISION,
            "preprocessor_config.json",
            LOCAL_PREPROCESSOR,
            "25dee36a3a47950bbed2e8c7332e99a87f1b3244864db23f972ccd4121eb469d",
        ),
    ]
}

/// Every pinned artifact carries a valid integrity receipt. Plausible bytes
/// are not enough: a swapped `.onnx_data` of the right size would otherwise
/// run, and it is 2 GB of weights this app never looks inside.
pub(crate) fn artifacts_trusted(model_dir: &Path) -> bool {
    cohere_local_repo_files()
        .iter()
        .all(|(_, _, _, local_name, sha256)| {
            crate::download::is_model_artifact_trusted(&model_dir.join(local_name), Some(sha256))
        })
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let model_dir = models_root.join(COHERE_LOCAL_MODEL_DIR);
    cohere_local_repo_files()
        .into_iter()
        .map(|(_, _, _, local_name, sha256)| (model_dir.join(local_name), sha256.to_string()))
        .collect()
}

/// Which pinned files are missing or unusable, for the diagnostics surface.
pub(crate) fn missing_or_invalid_files(model_dir: &Path) -> Vec<String> {
    cohere_local_repo_files()
        .into_iter()
        .filter(|(_, _, _, local_name, _)| {
            let path = model_dir.join(local_name);
            !std::fs::metadata(&path)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        })
        .map(|(_, _, _, local_name, _)| local_name.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// ONNX runtime (feature-gated via asr-parakeet, which is what pulls in ort)
// ---------------------------------------------------------------------------

#[cfg(feature = "asr-parakeet")]
struct CohereLocalRuntime {
    model_dir_key: String,
    encoder: ort::session::Session,
    decoder: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
    /// Slaney mel filterbank, `[128][257]`, built once per load.
    mel_filters: Vec<Vec<f64>>,
    /// `torch.hann_window(400, periodic=False)` zero-padded to `n_fft`,
    /// centered, exactly as `torch.stft` does for `win_length < n_fft`.
    window: Vec<f32>,
    eos_token_id: i64,
    /// Decoder layers, from the graph's `past_key_values.N.*` inputs.
    num_layers: usize,
    /// Attention heads and per-head dimension of the decoder's KV cache.
    num_kv_heads: usize,
    head_dim: usize,
}

#[cfg(feature = "asr-parakeet")]
fn load_runtime(model_dir: &Path) -> Result<CohereLocalRuntime> {
    #[derive(serde::Deserialize)]
    struct PreprocessorConfig {
        feature_size: usize,
        hop_length: usize,
        n_fft: usize,
        win_length: usize,
        sampling_rate: u32,
    }
    #[derive(serde::Deserialize)]
    struct GenerationConfig {
        eos_token_id: i64,
    }
    #[derive(serde::Deserialize)]
    struct DecoderConfig {
        num_hidden_layers: usize,
        num_key_value_heads: usize,
        head_dim: usize,
    }

    let verified = |local_name: &str| {
        let sha256 = cohere_local_repo_files()
            .into_iter()
            .find(|(_, _, _, candidate, _)| *candidate == local_name)
            .map(|(_, _, _, _, sha256)| sha256)
            .ok_or_else(|| anyhow::anyhow!("Missing integrity pin for {local_name}"))?;
        crate::download::open_verified_model_artifact(&model_dir.join(local_name), sha256)
    };
    let preprocessor_file = verified(LOCAL_PREPROCESSOR)?;
    let generation_file = verified(LOCAL_GENERATION_CONFIG)?;
    let config_file = verified(LOCAL_CONFIG)?;
    let tokenizer_file = verified(LOCAL_TOKENIZER)?;
    let encoder_file = verified(LOCAL_ENCODER)?;
    let decoder_file = verified(LOCAL_DECODER)?;

    // The front end below hard-codes the export's numbers. Read them back and
    // refuse a mismatch rather than computing features the encoder was not
    // exported for -- a silently wrong mel is the failure mode that took the
    // Qwen3 lane a full end-to-end run to find.
    let preprocessor: PreprocessorConfig = serde_json::from_str(
        &std::fs::read_to_string(preprocessor_file.load_path())
            .context("Failed to read Cohere Transcribe preprocessor_config.json")?,
    )
    .context("Failed to parse Cohere Transcribe preprocessor_config.json")?;
    if preprocessor.feature_size != COHERE_LOCAL_N_MELS
        || preprocessor.hop_length != COHERE_LOCAL_HOP_LENGTH
        || preprocessor.n_fft != COHERE_LOCAL_N_FFT
        || preprocessor.win_length != COHERE_LOCAL_WIN_LENGTH
        || preprocessor.sampling_rate != COHERE_LOCAL_SAMPLE_RATE
    {
        anyhow::bail!(
            "Cohere Transcribe preprocessor_config.json describes a front end this build does not \
             implement (feature_size={} hop={} n_fft={} win={} rate={}); expected {}/{}/{}/{}/{}.",
            preprocessor.feature_size,
            preprocessor.hop_length,
            preprocessor.n_fft,
            preprocessor.win_length,
            preprocessor.sampling_rate,
            COHERE_LOCAL_N_MELS,
            COHERE_LOCAL_HOP_LENGTH,
            COHERE_LOCAL_N_FFT,
            COHERE_LOCAL_WIN_LENGTH,
            COHERE_LOCAL_SAMPLE_RATE,
        );
    }

    let generation: GenerationConfig = serde_json::from_str(
        &std::fs::read_to_string(generation_file.load_path())
            .context("Failed to read Cohere Transcribe generation_config.json")?,
    )
    .context("Failed to parse Cohere Transcribe generation_config.json")?;

    let config_value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(config_file.load_path())
            .context("Failed to read Cohere Transcribe config.json")?,
    )
    .context("Failed to parse Cohere Transcribe config.json")?;
    let decoder_config: DecoderConfig = serde_json::from_value(serde_json::json!({
        "num_hidden_layers": config_value["num_hidden_layers"],
        "num_key_value_heads": config_value["num_key_value_heads"],
        "head_dim": config_value["head_dim"],
    }))
    .context("Cohere Transcribe config.json is missing the decoder cache shape")?;

    let tokenizer = tokenizers::Tokenizer::from_file(tokenizer_file.load_path())
        .map_err(|error| anyhow::anyhow!("Failed to load Cohere Transcribe tokenizer: {error}"))?;

    // CoreML is not registered for either graph. The encoder is int4
    // (`MatMulNBits`, a com.microsoft op CoreML does not implement) and the
    // decoder is a merged graph whose control flow CoreML rejects outright --
    // the same two reasons the Qwen3 decoders bypass it. Both run on the CPU
    // provider and the route copy says so rather than implying Metal.
    let encoder = crate::ort_utils::build_session_no_coreml(encoder_file.load_path(), Ok)
        .context("Failed to load the Cohere Transcribe encoder")?;
    let decoder = crate::ort_utils::build_session_no_coreml(decoder_file.load_path(), Ok)
        .context("Failed to load the Cohere Transcribe decoder")?;

    let mel_filters = crate::audio::mel::create_mel_filterbank_slaney(
        COHERE_LOCAL_N_FFT,
        COHERE_LOCAL_SAMPLE_RATE as f32,
        COHERE_LOCAL_N_MELS,
        0.0,
        COHERE_LOCAL_SAMPLE_RATE as f32 / 2.0,
    );

    tracing::info!(
        "Cohere Transcribe (local) loaded from {}: {} decoder layers, {} KV heads, head dim {}",
        model_dir.display(),
        decoder_config.num_hidden_layers,
        decoder_config.num_key_value_heads,
        decoder_config.head_dim,
    );

    Ok(CohereLocalRuntime {
        model_dir_key: model_dir.to_string_lossy().to_string(),
        encoder,
        decoder,
        tokenizer,
        mel_filters,
        window: stft_window(),
        eos_token_id: generation.eos_token_id,
        num_layers: decoder_config.num_hidden_layers,
        num_kv_heads: decoder_config.num_key_value_heads,
        head_dim: decoder_config.head_dim,
    })
}

/// `torch.hann_window(win_length, periodic=False)` placed in the middle of an
/// `n_fft`-long buffer, which is what `torch.stft` does when
/// `win_length < n_fft`.
#[cfg(feature = "asr-parakeet")]
fn stft_window() -> Vec<f32> {
    let mut window = vec![0.0f32; COHERE_LOCAL_N_FFT];
    let offset = (COHERE_LOCAL_N_FFT - COHERE_LOCAL_WIN_LENGTH) / 2;
    for index in 0..COHERE_LOCAL_WIN_LENGTH {
        let phase =
            2.0 * std::f64::consts::PI * index as f64 / (COHERE_LOCAL_WIN_LENGTH - 1) as f64;
        window[offset + index] = (0.5 - 0.5 * phase.cos()) as f32;
    }
    window
}

/// How many STFT frames `input_features` holds for `sample_count` samples, and
/// how many of them are inside the audio rather than the centering pad.
///
/// `torch.stft(center=True)` returns `1 + samples / hop` frames; the reference
/// then masks all but `samples / hop` of them, so the final frame is always
/// zeroed. Both numbers are needed: the encoder is fed the whole tensor and
/// the normalization statistics come from the valid part only.
pub(crate) fn feature_frame_counts(sample_count: usize, hop_length: usize) -> (usize, usize) {
    if hop_length == 0 {
        return (0, 0);
    }
    let valid = sample_count / hop_length;
    (valid + 1, valid)
}

/// The `input_features [1, frames, 128]` tensor the encoder takes.
///
/// A step-for-step port of `CohereAsrFeatureExtractor`: pre-emphasis, a
/// centered STFT with a symmetric 400-sample Hann window zero-padded to 512,
/// power spectrum, Slaney mel filterbank, `log(x + 2^-24)`, then per-mel-bin
/// mean/sample-variance normalization over the valid frames with the trailing
/// pad frame zeroed.
///
/// The reference's `dither` is **not** applied. It adds `1e-5 * randn` seeded
/// from the clip length through torch's own RNG, which nothing outside torch
/// can reproduce bit-for-bit; at 1e-5 it is 100 dB below full scale, so
/// omitting it is a smaller divergence than a different noise stream would be.
#[cfg(feature = "asr-parakeet")]
fn compute_input_features(
    samples: &[f32],
    mel_filters: &[Vec<f64>],
    window: &[f32],
) -> Result<ndarray::Array3<f32>> {
    use rustfft::num_complex::Complex;
    use rustfft::FftPlanner;

    let (num_frames, valid_frames) = feature_frame_counts(samples.len(), COHERE_LOCAL_HOP_LENGTH);
    if num_frames == 0 {
        anyhow::bail!("Cohere Transcribe front end was handed no audio");
    }

    let emphasized = preemphasize(samples, COHERE_LOCAL_PREEMPHASIS);

    // center=True with pad_mode="constant": n_fft/2 zeros on each side.
    let pad = COHERE_LOCAL_N_FFT / 2;
    let mut padded = vec![0.0f32; emphasized.len() + 2 * pad];
    padded[pad..pad + emphasized.len()].copy_from_slice(&emphasized);

    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(COHERE_LOCAL_N_FFT);
    let num_bins = COHERE_LOCAL_N_FFT / 2 + 1;
    let mut buffer = vec![Complex::new(0.0f64, 0.0f64); COHERE_LOCAL_N_FFT];

    // [frames][mels], the layout the encoder wants.
    let mut features = vec![vec![0.0f64; COHERE_LOCAL_N_MELS]; num_frames];
    for (frame_index, frame) in features.iter_mut().enumerate() {
        let start = frame_index * COHERE_LOCAL_HOP_LENGTH;
        for (bin, slot) in buffer.iter_mut().enumerate() {
            let sample = padded.get(start + bin).copied().unwrap_or(0.0);
            *slot = Complex::new(f64::from(sample * window[bin]), 0.0);
        }
        fft.process(&mut buffer);
        let power: Vec<f64> = buffer[..num_bins]
            .iter()
            .map(|value| value.re * value.re + value.im * value.im)
            .collect();
        for (mel_index, filter) in mel_filters.iter().enumerate() {
            let energy: f64 = filter
                .iter()
                .zip(power.iter())
                .map(|(weight, value)| weight * value)
                .sum();
            frame[mel_index] = (energy + COHERE_LOCAL_LOG_ZERO_GUARD).ln();
        }
    }

    // Per-bin mean and *sample* variance over the valid frames only. The
    // reference divides by (n - 1); with fewer than two valid frames there is
    // no variance to speak of, so normalization degrades to mean removal.
    let counted = valid_frames.max(1).min(num_frames);
    for mel_index in 0..COHERE_LOCAL_N_MELS {
        let mean: f64 = features[..counted]
            .iter()
            .map(|frame| frame[mel_index])
            .sum::<f64>()
            / counted as f64;
        let std = if counted > 1 {
            let variance: f64 = features[..counted]
                .iter()
                .map(|frame| {
                    let centered = frame[mel_index] - mean;
                    centered * centered
                })
                .sum::<f64>()
                / (counted - 1) as f64;
            variance.sqrt()
        } else {
            0.0
        };
        let scale = 1.0 / (std + COHERE_LOCAL_NORM_EPSILON);
        for frame in features.iter_mut() {
            frame[mel_index] = (frame[mel_index] - mean) * scale;
        }
    }

    // Frames outside the valid length are the centering pad; the reference
    // masks them to zero before handing the tensor to the encoder.
    for frame in features.iter_mut().skip(valid_frames) {
        frame.iter_mut().for_each(|value| *value = 0.0);
    }

    let flat: Vec<f32> = features
        .iter()
        .flat_map(|frame| frame.iter().map(|value| *value as f32))
        .collect();
    ndarray::Array3::from_shape_vec((1, num_frames, COHERE_LOCAL_N_MELS), flat)
        .context("Failed to shape the Cohere Transcribe input_features tensor")
}

#[cfg(feature = "asr-parakeet")]
fn runtime_cache() -> &'static Mutex<Option<CohereLocalRuntime>> {
    static CACHE: OnceLock<Mutex<Option<CohereLocalRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-parakeet")]
pub(crate) fn clear_cached_runtime(model_dir: &Path) {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    if let Ok(mut cache) = runtime_cache().lock() {
        if cache
            .as_ref()
            .is_some_and(|runtime| runtime.model_dir_key == model_dir_key)
        {
            *cache = None;
            tracing::info!(
                "Cleared the cached Cohere Transcribe (local) runtime for {}",
                model_dir.display()
            );
        }
    }
}

#[cfg(not(feature = "asr-parakeet"))]
pub(crate) fn clear_cached_runtime(_model_dir: &Path) {}

#[cfg(feature = "asr-parakeet")]
fn prewarm_runtime(model_dir: &Path) -> Result<()> {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    let mut cache = runtime_cache().lock().map_err(|error| {
        anyhow::anyhow!("Cohere Transcribe (local) runtime cache is unavailable: {error}")
    })?;
    if cache
        .as_ref()
        .is_some_and(|runtime| runtime.model_dir_key == model_dir_key)
    {
        return Ok(());
    }
    *cache = Some(load_runtime(model_dir)?);
    Ok(())
}

#[cfg(not(feature = "asr-parakeet"))]
fn prewarm_runtime(_model_dir: &Path) -> Result<()> {
    Err(anyhow::anyhow!(
        "Cohere Transcribe (local) needs ONNX Runtime, which is not compiled into this build \
         (the `asr-parakeet` feature is off)."
    ))
}

/// One chunk's transcript and how many tokens it took.
#[cfg(feature = "asr-parakeet")]
struct ChunkDecode {
    text: String,
    generated_tokens: usize,
}

#[cfg(feature = "asr-parakeet")]
fn decode_chunk(
    runtime: &mut CohereLocalRuntime,
    samples: &[f32],
    language: &str,
    cancelled: &AtomicBool,
) -> Result<ChunkDecode> {
    use ndarray::{Array2, Array4, IxDyn};
    use ort::value::Tensor;

    let audio_seconds = samples.len() as f64 / f64::from(COHERE_LOCAL_SAMPLE_RATE);
    let cap = max_new_tokens_for_audio(audio_seconds);
    let deadline = Instant::now() + decode_budget_for_audio(audio_seconds);

    let features = compute_input_features(samples, &runtime.mel_filters, &runtime.window)
        .context("Failed to compute Cohere Transcribe input features")?;

    let features_tensor = Tensor::from_array(features.into_dyn())
        .context("Failed to create the Cohere Transcribe input_features tensor")?;
    let encoder_outputs = runtime
        .encoder
        .run(ort::inputs!["input_features" => features_tensor])
        .context("Cohere Transcribe encoder inference failed")?;
    let hidden = encoder_outputs
        .get("last_hidden_state")
        .ok_or_else(|| {
            anyhow::anyhow!("Cohere Transcribe encoder did not output 'last_hidden_state'")
        })?
        .try_extract_array::<f32>()
        .context("Failed to extract Cohere Transcribe encoder hidden states")?
        .into_owned();
    drop(encoder_outputs);

    // Built once and passed by reference every step: the cross-attention
    // states do not change, and at ~1.8 MB for a 35 s clip re-uploading them
    // per token would cost more than the decoder step.
    let hidden_tensor = Tensor::from_array(hidden)
        .context("Failed to create the Cohere Transcribe encoder_hidden_states tensor")?;

    let prompt_tokens = decoder_prompt_tokens(language, true);
    let prompt_ids: Vec<i64> = prompt_tokens
        .iter()
        .map(|token| {
            runtime
                .tokenizer
                .token_to_id(token)
                .map(i64::from)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Cohere Transcribe tokenizer has no id for the prompt token {token:?}"
                    )
                })
        })
        .collect::<Result<_>>()?;

    // Zero-length past on the first step: the merged graph takes the cache
    // shape and an empty sequence dimension is how it is told there is none.
    let empty_cache = Array4::<f32>::zeros((1, runtime.num_kv_heads, 0, runtime.head_dim));
    let mut past: Vec<ndarray::Array<f32, IxDyn>> = Vec::with_capacity(runtime.num_layers * 4);
    for _ in 0..runtime.num_layers {
        for _ in 0..4 {
            past.push(empty_cache.clone().into_dyn());
        }
    }

    let mut input_ids = prompt_ids.clone();
    let mut position = 0i64;
    let mut generated: Vec<i64> = Vec::new();
    let mut reached_eos = false;

    loop {
        if let Err(stop) = check_decode_control(cancelled, deadline) {
            return Err(decode_stop_error(stop, generated.len(), cap, audio_seconds));
        }

        let step_len = input_ids.len();
        let total_len = position as usize + step_len;
        let ids = Array2::from_shape_vec((1, step_len), input_ids.clone())
            .context("Failed to shape the Cohere Transcribe input_ids tensor")?;
        let positions: Array2<i64> =
            Array2::from_shape_fn((1, step_len), |(_, index)| position + index as i64);
        let attention: Array2<i64> = Array2::from_elem((1, total_len), 1);

        let mut inputs: Vec<(String, ort::session::SessionInputValue<'_>)> = vec![
            (
                "input_ids".to_string(),
                Tensor::from_array(ids.into_dyn())
                    .context("input_ids tensor")?
                    .into(),
            ),
            (
                "attention_mask".to_string(),
                Tensor::from_array(attention.into_dyn())
                    .context("attention_mask tensor")?
                    .into(),
            ),
            (
                "position_ids".to_string(),
                Tensor::from_array(positions.into_dyn())
                    .context("position_ids tensor")?
                    .into(),
            ),
            // A rank-0 scalar, as the graph declares it: only the last
            // position's logits are wanted, and asking for the whole prompt's
            // would be 10 x 16384 floats thrown away on the first step.
            (
                "num_logits_to_keep".to_string(),
                Tensor::from_array(ndarray::Array0::from_elem((), 1i64).into_dyn())
                    .context("num_logits_to_keep tensor")?
                    .into(),
            ),
            ("encoder_hidden_states".to_string(), (&hidden_tensor).into()),
        ];
        for layer in 0..runtime.num_layers {
            for (offset, name) in [
                "decoder.key",
                "decoder.value",
                "encoder.key",
                "encoder.value",
            ]
            .into_iter()
            .enumerate()
            {
                let tensor = past[layer * 4 + offset].clone();
                inputs.push((
                    format!("past_key_values.{layer}.{name}"),
                    Tensor::from_array(tensor)
                        .context("past_key_values tensor")?
                        .into(),
                ));
            }
        }

        let outputs = runtime
            .decoder
            .run(inputs)
            .context("Cohere Transcribe decoder inference failed")?;

        let next = {
            let logits = outputs
                .get("logits")
                .ok_or_else(|| {
                    anyhow::anyhow!("Cohere Transcribe decoder did not output 'logits'")
                })?
                .try_extract_array::<f32>()
                .context("Failed to extract Cohere Transcribe logits")?
                .into_dimensionality::<ndarray::Ix3>()
                .context("Cohere Transcribe logits are not [1, kept, vocab]")?;
            let last = logits.shape()[1].checked_sub(1).ok_or_else(|| {
                anyhow::anyhow!("Cohere Transcribe decoder returned empty logits")
            })?;
            let row = logits.index_axis(ndarray::Axis(0), 0);
            let row = row.index_axis(ndarray::Axis(0), last);
            row.iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(index, _)| index as i64)
                .unwrap_or(0)
        };

        let mut next_past = Vec::with_capacity(runtime.num_layers * 4);
        for layer in 0..runtime.num_layers {
            for name in [
                "decoder.key",
                "decoder.value",
                "encoder.key",
                "encoder.value",
            ] {
                let key = format!("present.{layer}.{name}");
                let value = outputs.get(key.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("Cohere Transcribe decoder did not output '{key}'")
                })?;
                next_past.push(
                    value
                        .try_extract_array::<f32>()
                        .with_context(|| format!("Failed to extract '{key}'"))?
                        .into_owned(),
                );
            }
        }
        drop(outputs);
        past = next_past;

        position += step_len as i64;
        if next == runtime.eos_token_id {
            reached_eos = true;
            break;
        }
        generated.push(next);
        if generated.len() >= cap {
            break;
        }
        input_ids = vec![next];
    }

    if !reached_eos {
        return Err(decode_stop_error(
            DecodeStop::TokenCap,
            generated.len(),
            cap,
            audio_seconds,
        ));
    }

    let generated_u32: Vec<u32> = generated.iter().map(|id| *id as u32).collect();
    let text = runtime
        .tokenizer
        .decode(&generated_u32, true)
        .map_err(|error| anyhow::anyhow!("Failed to decode Cohere Transcribe tokens: {error}"))?;

    Ok(ChunkDecode {
        text: text.trim().to_string(),
        generated_tokens: generated.len(),
    })
}

/// Everything one `transcribe` call produced.
struct LocalDecoded {
    text: String,
    /// `(start_seconds, end_seconds, text)` per audio chunk, so the caller can
    /// place sentence segments inside the chunk they came from rather than
    /// spreading them over the whole file.
    chunks: Vec<(f64, f64, String)>,
}

#[cfg(feature = "asr-parakeet")]
fn run_cohere_local_onnx(
    model_dir: &Path,
    audio_path: &Path,
    language: &str,
    cancelled: &AtomicBool,
) -> Result<LocalDecoded> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Cohere Transcribe (local)")?;
    if samples.is_empty() {
        return Ok(LocalDecoded {
            text: String::new(),
            chunks: Vec::new(),
        });
    }

    let model_dir_key = model_dir.to_string_lossy().to_string();
    let mut cache = runtime_cache().lock().map_err(|error| {
        anyhow::anyhow!("Cohere Transcribe (local) runtime cache is unavailable: {error}")
    })?;
    if cache
        .as_ref()
        .is_none_or(|runtime| runtime.model_dir_key != model_dir_key)
    {
        *cache = Some(load_runtime(model_dir)?);
    }
    let runtime = cache
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("Cohere Transcribe (local) runtime cache is empty"))?;

    let rate = f64::from(COHERE_LOCAL_SAMPLE_RATE);
    let spans = split_audio_into_chunks(&samples, COHERE_LOCAL_SAMPLE_RATE);
    let mut texts = Vec::with_capacity(spans.len());
    let mut chunks = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        let decoded = decode_chunk(runtime, &samples[start..end], language, cancelled)?;
        tracing::debug!(
            "Cohere Transcribe (local) chunk {:.2}-{:.2}s decoded in {} tokens",
            start as f64 / rate,
            end as f64 / rate,
            decoded.generated_tokens,
        );
        chunks.push((start as f64 / rate, end as f64 / rate, decoded.text.clone()));
        texts.push(decoded.text);
    }

    Ok(LocalDecoded {
        text: join_chunk_texts(&texts, language),
        chunks,
    })
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_cohere_local_onnx(
    _model_dir: &Path,
    _audio_path: &Path,
    _language: &str,
    _cancelled: &AtomicBool,
) -> Result<LocalDecoded> {
    Err(anyhow::anyhow!(
        "Cohere Transcribe (local) needs ONNX Runtime, which is not compiled into this build \
         (the `asr-parakeet` feature is off)."
    ))
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct CohereLocalProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl CohereLocalProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let root_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&root_dir, selected_model_id)
    }

    pub(crate) fn with_models_root(models_root: &Path, selected_model_id: Option<&str>) -> Self {
        Self {
            model_dir: models_root.join(COHERE_LOCAL_MODEL_DIR),
            model_id: selected_model_id
                .unwrap_or(COHERE_LOCAL_MODEL_ID)
                .to_string(),
        }
    }

    fn has_required_files(&self) -> bool {
        missing_or_invalid_files(&self.model_dir).is_empty()
    }

    fn has_trusted_required_files(&self) -> bool {
        artifacts_trusted(&self.model_dir)
    }

    fn ensure_ready(&self) -> Result<()> {
        if !self.has_required_files() {
            anyhow::bail!(
                "Cohere Transcribe (local) is not downloaded. Use the model manager to download it."
            );
        }
        if !self.has_trusted_required_files() {
            anyhow::bail!(
                "Cohere Transcribe (local) model files have not passed Plainsong integrity \
                 verification. Re-download the model from Settings."
            );
        }
        Ok(())
    }

    fn wav_duration_seconds(path: &Path) -> f64 {
        match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                if spec.sample_rate == 0 {
                    0.0
                } else {
                    reader.duration() as f64 / f64::from(spec.sample_rate)
                }
            }
            Err(_) => 0.0,
        }
    }

    /// Resolve the request's language onto one of the model's 14.
    ///
    /// An unsupported selection is an error, not a silent fall back to
    /// English: the user asked for Hindi and this route cannot hear Hindi, so
    /// saying so is the only honest answer.
    fn resolve_language(requested: Option<&str>) -> Result<&'static str> {
        let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(COHERE_LOCAL_DEFAULT_LANGUAGE);
        };
        if requested.eq_ignore_ascii_case("auto") {
            return Ok(COHERE_LOCAL_DEFAULT_LANGUAGE);
        }
        supported_language_code(requested).ok_or_else(|| {
            anyhow::anyhow!(
                "Cohere Transcribe (local) does not support {requested}. It covers {} and cannot \
                 detect a language on its own.",
                COHERE_LOCAL_LANGUAGES
                    .iter()
                    .map(|(name, _)| *name)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
    }

    async fn transcribe_in_language(
        &self,
        audio_path: &Path,
        language: &'static str,
    ) -> Result<TranscriptionResult> {
        self.ensure_ready()?;

        let started = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_owned = audio_path.to_path_buf();
        let duration = Self::wav_duration_seconds(audio_path);

        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&cancelled));
        let decoded = tokio::task::spawn_blocking(move || {
            run_cohere_local_onnx(&model_dir, &audio_owned, language, &cancelled)
        })
        .await
        .context("Cohere Transcribe (local) inference task panicked")??;

        let mut segments = Vec::new();
        for (start, end, text) in &decoded.chunks {
            segments.extend(apportioned_segments(text, *start, *end));
        }
        if segments.is_empty() && !decoded.text.is_empty() {
            segments = apportioned_segments(&decoded.text, 0.0, duration);
        }

        Ok(TranscriptionResult {
            text: decoded.text,
            segments,
            language: language.to_string(),
            confidence: 0.9,
            processing_time_ms: started.elapsed().as_millis() as u64,
            model_name: self.model_id.clone(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::CohereLocal,
            actual_provider: AsrProviderType::CohereLocal,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }
}

impl Default for CohereLocalProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for CohereLocalProvider {
    fn name(&self) -> &str {
        "Cohere Transcribe (Local)"
    }

    fn description(&self) -> &str {
        "Cohere Transcribe 03-2026, int4 ONNX on CPU, fully offline. Experimental: 14 languages, \
         and the language must be chosen because this route cannot detect one. No Metal path, so \
         it is much slower than Parakeet. Segment times are estimated, not measured."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.has_trusted_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        self.ensure_ready()?;
        let model_dir = self.model_dir.clone();
        tokio::task::spawn_blocking(move || prewarm_runtime(&model_dir))
            .await
            .context("Cohere Transcribe (local) warmup task panicked")??;
        Ok(())
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Cohere Transcribe 03-2026 (local, int4)".to_string(),
            version: "03-2026-q4".to_string(),
            // MiB across the eight pinned files, like every other provider's
            // `size_mb` (which is MiB despite its name).
            size_mb: (COHERE_LOCAL_BUNDLE_BYTES as f64) / (1024.0 * 1024.0),
            parameters: "2B".to_string(),
            languages: COHERE_LOCAL_LANGUAGES
                .iter()
                .map(|(_, code)| (*code).to_string())
                .collect(),
            // Open ASR Leaderboard figure for the source weights, quoted in
            // docs/model-inventory-2026-09.md §1.2. Not measured here, and not
            // measured on the int4 export.
            word_error_rate: Some(5.42),
            // Left None deliberately: the measured factor is in
            // artifacts/qa/cohere-local-receipt-2026-09-02.md, and it was
            // taken on a loaded machine. A number here would be read as a
            // property of the model rather than of that run.
            real_time_factor: None,
            license: "Apache-2.0".to_string(),
            source_url: format!("https://huggingface.co/{COHERE_LOCAL_HF_REPO}"),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        self.transcribe_in_language(audio_path, COHERE_LOCAL_DEFAULT_LANGUAGE)
            .await
    }

    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let language = Self::resolve_language(options.language.as_deref())?;
        self.transcribe_in_language(audio_path, language).await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("cohere_local_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data)
            .context("Failed to write a temp WAV for Cohere Transcribe (local)")?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let language = Self::resolve_language(options.language.as_deref())?;
        let temp_path =
            std::env::temp_dir().join(format!("cohere_local_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data)
            .context("Failed to write a temp WAV for Cohere Transcribe (local)")?;
        let result = self.transcribe_in_language(&temp_path, language).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_required_files() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;

        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create the Cohere Transcribe (local) model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = Arc::new(progress_cb);
        let files = cohere_local_repo_files();
        let file_count = files.len() as f32;

        for (index, (repo_id, revision, hf_path, local_name, sha256)) in
            files.into_iter().enumerate()
        {
            let destination = self.model_dir.join(local_name);
            let url = format!("https://huggingface.co/{repo_id}/resolve/{revision}/{hf_path}");
            let callback = progress_cb.clone();
            manager
                .download_verified_model_asset(
                    &url,
                    &destination,
                    Some(sha256),
                    cohere_local_artifact_max_bytes(local_name),
                    move |progress| {
                        callback(
                            (index as f32 / file_count
                                + progress.percentage as f32 / 100.0 / file_count)
                                * 100.0,
                        );
                    },
                )
                .await?;
        }

        tracing::info!("Cohere Transcribe (local) model downloaded");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pinned_bundle_is_eight_files_at_one_immutable_revision() {
        let files = cohere_local_repo_files();
        assert_eq!(files.len(), 8);
        for (repo, revision, _, _, sha256) in files {
            assert_eq!(repo, COHERE_LOCAL_HF_REPO);
            // A branch name is not a pin; the digests below only mean
            // something against a commit.
            assert_eq!(revision.len(), 40, "revision must be a full commit sha");
            assert!(revision.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(sha256.len(), 64, "every artifact carries a pinned digest");
            assert!(sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn the_onnx_data_files_keep_the_names_their_graphs_record() {
        // The graphs name their weight files internally. Renaming the local
        // copies breaks the load, so the constants are asserted rather than
        // left to a future tidy-up.
        assert_eq!(LOCAL_ENCODER_DATA, format!("{LOCAL_ENCODER}_data"));
        assert_eq!(LOCAL_DECODER_DATA, format!("{LOCAL_DECODER}_data"));
        let files = cohere_local_repo_files();
        for (_, _, hf_path, local_name, _) in files {
            assert!(
                hf_path.ends_with(local_name),
                "{local_name} must be stored under its upstream name, not {hf_path}"
            );
        }
    }

    #[test]
    fn language_resolution_accepts_the_fourteen_and_refuses_the_rest() {
        assert_eq!(supported_language_code("en"), Some("en"));
        assert_eq!(supported_language_code("FR"), Some("fr"));
        assert_eq!(supported_language_code("pt-BR"), Some("pt"));
        assert_eq!(supported_language_code("zh_Hans"), Some("zh"));
        assert_eq!(supported_language_code("hi"), None);
        assert_eq!(supported_language_code(""), None);
        assert_eq!(COHERE_LOCAL_LANGUAGES.len(), 14);
    }

    #[test]
    fn an_unset_language_is_english_and_an_unsupported_one_is_an_error() {
        assert_eq!(CohereLocalProvider::resolve_language(None).unwrap(), "en");
        assert_eq!(
            CohereLocalProvider::resolve_language(Some("auto")).unwrap(),
            "en"
        );
        assert_eq!(
            CohereLocalProvider::resolve_language(Some("de")).unwrap(),
            "de"
        );
        let error = CohereLocalProvider::resolve_language(Some("hi")).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("hi"), "{message}");
        assert!(message.contains("cannot detect"), "{message}");
    }

    #[test]
    fn the_decoder_prompt_is_the_processors_ten_tokens_and_claims_no_timestamps() {
        let prompt = decoder_prompt_tokens("fr", true);
        assert_eq!(
            prompt,
            [
                "\u{2581}",
                "<|startofcontext|>",
                "<|startoftranscript|>",
                "<|emo:undefined|>",
                "<|fr|>",
                "<|fr|>",
                "<|pnc|>",
                "<|noitn|>",
                "<|notimestamp|>",
                "<|nodiarize|>",
            ]
            .map(str::to_string)
        );
        // The route must not ask for what it does not report.
        assert!(prompt.contains(&"<|notimestamp|>".to_string()));
        assert!(prompt.contains(&"<|nodiarize|>".to_string()));
        assert_eq!(decoder_prompt_tokens("en", false)[6], "<|nopnc|>");
    }

    #[test]
    fn preemphasis_keeps_the_first_sample_and_filters_the_rest() {
        let filtered = preemphasize(&[1.0, 1.0, 0.5], 0.97);
        assert_eq!(filtered.len(), 3);
        assert!((filtered[0] - 1.0).abs() < 1e-6);
        assert!((filtered[1] - 0.03).abs() < 1e-6);
        assert!((filtered[2] - (0.5 - 0.97)).abs() < 1e-6);
        assert!(preemphasize(&[], 0.97).is_empty());
    }

    #[test]
    fn frame_counts_match_the_reference_masking() {
        // torch.stft(center=True) yields 1 + n/hop frames and the extractor
        // masks all but n/hop of them, so the last one is always padding.
        assert_eq!(feature_frame_counts(16_000, 160), (101, 100));
        assert_eq!(feature_frame_counts(0, 160), (1, 0));
        assert_eq!(feature_frame_counts(161, 160), (2, 1));
        assert_eq!(feature_frame_counts(100, 0), (0, 0));
    }

    #[test]
    fn short_audio_is_one_chunk_and_long_audio_cuts_at_the_quiet_point() {
        let rate = COHERE_LOCAL_SAMPLE_RATE;
        let short: Vec<f32> = vec![0.1; rate as usize * 10];
        assert_eq!(
            split_audio_into_chunks(&short, rate),
            vec![(0, short.len())]
        );

        // 60 s of tone with a half-second silence at 32 s -- inside the 5 s
        // search span that ends at the 35 s cap, so the cut must land in it.
        let total = rate as usize * 60;
        let samples: Vec<f32> = (0..total)
            .map(|index| {
                let t = index as f64 / f64::from(rate);
                if (32.0..32.5).contains(&t) {
                    0.0
                } else {
                    (0.3 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32
                }
            })
            .collect();
        let chunks = split_audio_into_chunks(&samples, rate);
        assert_eq!(chunks.len(), 2, "60 s cuts once at the 35 s cap");
        let cut_seconds = chunks[0].1 as f64 / f64::from(rate);
        assert!(
            (32.0..=32.5).contains(&cut_seconds),
            "cut at {cut_seconds:.2} s is not inside the silence"
        );
        // Every sample is covered exactly once.
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks[0].1, chunks[1].0);
        assert_eq!(chunks[1].1, total);
    }

    #[test]
    fn chunk_texts_join_the_way_the_processor_joins_them() {
        let texts = vec![
            "First part. ".to_string(),
            "  second part".to_string(),
            "   ".to_string(),
        ];
        assert_eq!(join_chunk_texts(&texts, "en"), "First part. second part");
        assert_eq!(join_chunk_texts(&texts, "ja"), "First part.second part");
        assert_eq!(join_chunk_texts(&[], "en"), "");
    }

    #[test]
    fn sentence_segments_cover_the_clip_and_stay_ordered() {
        let segments = apportioned_segments("One two. Three four five.", 10.0, 20.0);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_time, 10.0);
        assert_eq!(segments[1].end_time, 20.0);
        assert_eq!(segments[0].end_time, segments[1].start_time);
        assert_eq!(segments[0].text, "One two.");
        assert_eq!(segments[1].text, "Three four five.");
        // A single sentence is one segment spanning the clip, not a division.
        let single = apportioned_segments("Just this", 0.0, 5.0);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].end_time, 5.0);
        assert!(apportioned_segments("   ", 0.0, 5.0).is_empty());
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn the_token_cap_and_budget_scale_with_audio_and_stay_bounded() {
        assert_eq!(max_new_tokens_for_audio(0.0), COHERE_LOCAL_MIN_NEW_TOKENS);
        assert_eq!(
            max_new_tokens_for_audio(f64::NAN),
            COHERE_LOCAL_MIN_NEW_TOKENS
        );
        assert_eq!(max_new_tokens_for_audio(44.0), 544);
        assert_eq!(
            max_new_tokens_for_audio(600.0),
            COHERE_LOCAL_MAX_NEW_TOKENS_CEILING
        );
        assert_eq!(decode_budget_for_audio(1.0), Duration::from_secs(120));
        assert_eq!(decode_budget_for_audio(35.0), Duration::from_secs(1050));
    }

    #[cfg(feature = "asr-parakeet")]
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
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn a_decode_that_ran_out_of_room_is_an_error_not_a_prefix() {
        let message = decode_stop_error(DecodeStop::TokenCap, 544, 544, 44.0).to_string();
        assert!(message.contains("544-token cap"), "{message}");
        assert!(message.contains("truncated"), "{message}");
        let message = decode_stop_error(DecodeStop::DeadlineExceeded, 12, 544, 44.0).to_string();
        assert!(message.contains("1320 s budget"), "{message}");
        let message = decode_stop_error(DecodeStop::Cancelled, 12, 544, 44.0).to_string();
        assert!(message.contains("cancelled"), "{message}");
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

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn the_stft_window_is_a_symmetric_hann_centered_in_the_fft_buffer() {
        let window = stft_window();
        assert_eq!(window.len(), COHERE_LOCAL_N_FFT);
        let offset = (COHERE_LOCAL_N_FFT - COHERE_LOCAL_WIN_LENGTH) / 2;
        // Zero padding either side of the 400-sample window.
        assert!(window[..offset].iter().all(|value| *value == 0.0));
        assert!(window[offset + COHERE_LOCAL_WIN_LENGTH..]
            .iter()
            .all(|value| *value == 0.0));
        // periodic=False: the window starts and ends at exactly zero. Its
        // peak sits *between* samples 199 and 200 because the length is even,
        // so it never quite reaches 1.0 — the same 0.9999845 torch produces.
        assert!(window[offset].abs() < 1e-6);
        assert!(window[offset + COHERE_LOCAL_WIN_LENGTH - 1].abs() < 1e-6);
        let peak = window.iter().cloned().fold(f32::MIN, f32::max);
        assert!((peak - 0.999_984_5).abs() < 1e-6, "peak {peak}");
        // Symmetric about the centre, which a periodic window would not be.
        for index in 0..COHERE_LOCAL_WIN_LENGTH {
            let mirrored = window[offset + COHERE_LOCAL_WIN_LENGTH - 1 - index];
            assert!(
                (window[offset + index] - mirrored).abs() < 1e-6,
                "asymmetric at {index}"
            );
        }
    }

    fn scratch_models_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cohere-local-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn readiness_requires_integrity_receipts_not_just_plausible_files() {
        let models_root = scratch_models_root("trust");
        let model_dir = models_root.join(COHERE_LOCAL_MODEL_DIR);
        std::fs::create_dir_all(&model_dir).expect("model dir");
        for (_, _, _, local_name, _) in cohere_local_repo_files() {
            std::fs::write(model_dir.join(local_name), vec![7u8; 8192]).expect("artifact");
        }

        let provider = CohereLocalProvider::with_models_root(&models_root, None);
        // Bytes of the right shape are on disk...
        assert_eq!(provider.download_status(), DownloadStatus::Downloaded);
        // ...and readiness still refuses them, because nothing hashed them.
        assert!(!provider.is_available());
        let error = provider.prewarm().await.unwrap_err().to_string();
        assert!(error.contains("integrity verification"), "{error}");
        assert!(missing_or_invalid_files(&model_dir).is_empty());
        let _ = std::fs::remove_dir_all(&models_root);
    }

    #[test]
    fn a_missing_artifact_is_named_in_the_diagnostics() {
        let models_root = scratch_models_root("missing");
        let model_dir = models_root.join(COHERE_LOCAL_MODEL_DIR);
        std::fs::create_dir_all(&model_dir).expect("model dir");
        for (_, _, _, local_name, _) in cohere_local_repo_files() {
            if local_name == LOCAL_ENCODER_DATA {
                continue;
            }
            std::fs::write(model_dir.join(local_name), vec![7u8; 8192]).expect("artifact");
        }
        assert_eq!(
            missing_or_invalid_files(&model_dir),
            vec![LOCAL_ENCODER_DATA.to_string()]
        );
        let _ = std::fs::remove_dir_all(&models_root);
    }
}
