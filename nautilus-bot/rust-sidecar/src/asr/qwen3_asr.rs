//! Qwen3-ASR: Alibaba's state-of-the-art open-source ASR model.
//!
//! Encoder-decoder architecture with an autoregressive LLM-based decoder.
//! Supports 30+ languages with automatic language detection. The model
//! outputs a language prefix tag ("language <Name>\n") before the transcript.
//!
//! # ONNX model contract
//!
//! Uses the pre-exported ONNX models from `andrewleech/qwen3-asr-0.6b-onnx`:
//!
//! - `encoder.int4.onnx` — audio encoder (mel → audio features). FP32 weights
//!   inlined (FP16 adds 9-13% CPU overhead per experiment 110).
//! - `decoder_init.int4.onnx` — prefill decoder (full prompt sequence → logits
//!   + KV cache). Graph proto only; weights in `decoder_weights.int4.data`.
//! - `decoder_step.int4.onnx` — autoregressive step (single token embed + KV
//!   cache → logits + updated KV cache). Graph proto + inlined lm_head.
//! - `decoder_weights.int4.data` — shared external weights for both decoders.
//!   ORT memory-maps this file once.
//! - `embed_tokens.bin` — token embedding matrix `[vocab_size, hidden_size]`,
//!   FP16 storage. Consumer casts to FP32 for embedding lookups in the
//!   decoder_step loop.
//! - `config.json` — architecture config, special token IDs, mel params.
//! - `tokenizer.json` — HuggingFace BPE tokenizer.
//!
//! # Inference flow
//!
//! 1. Load audio, compute 128-bin log-mel spectrogram
//! 2. Run encoder → audio features `[1, seq_len, hidden_size]`
//! 3. Build prompt token IDs (special tokens + audio pad tokens)
//! 4. Run decoder_init (prefill) → first token logits + KV cache
//! 5. Loop: embedding lookup → decoder_step → next token logits + KV cache
//! 6. Decode tokens, strip language prefix
//!
//! # Frontend and prompt contract
//!
//! Both follow the export's own reference consumer
//! (`andrewleech/qwen3-asr-onnx`, `src/mel.py` and `src/prompt.py`):
//!
//! - The mel frontend is Whisper's: centered STFT with reflect padding,
//!   periodic Hann window, power spectrum, Slaney-normalized 128-bin mel
//!   filterbank, `log10`, an 8-decade dynamic-range floor, `(x + 4) / 4`,
//!   last frame dropped, laid out as `[1, n_mels, frames]`.
//! - The prompt is the chat template
//!   `<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>`
//!   `<|audio_pad|>×N<|audio_end|><|im_end|>\n<|im_start|>assistant\n`, where
//!   N is the encoder's output length. The role words are looked up in the
//!   shipped tokenizer at load time rather than hard-coded.
//! - The model answers `language <Name><asr_text><transcript>`; the
//!   `<asr_text>` token splits the detected language from the text.
//!
//! # Status
//!
//! Validated with real audio on 2026-09-01 (see the opt-in
//! `qwen3_asr_real_audio_eval` test and item 7 of
//! docs/model-inventory-upgrades.md): the first end-to-end run found the mel
//! layout transposed and the chat-template prefix missing, both fixed here.
//! Upstream reports 5.16% WER on LibriSpeech test-other for the int4 export.
//! On CPU the int4 decoders run slower than real time; the measured numbers
//! live in the route's tradeoff copy (src/lib/asr-capabilities.ts).

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
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
const QWEN3_ASR_MODEL_ID: &str = "qwen3-asr-0.6b";
const QWEN3_ASR_HF_REPO: &str = "andrewleech/qwen3-asr-0.6b-onnx";
const QWEN3_ASR_HF_REVISION: &str = "main";

const QWEN3_ASR_LOCAL_ENCODER: &str = "encoder.int4.onnx";
const QWEN3_ASR_LOCAL_DECODER_INIT: &str = "decoder_init.int4.onnx";
const QWEN3_ASR_LOCAL_DECODER_STEP: &str = "decoder_step.int4.onnx";
const QWEN3_ASR_LOCAL_DECODER_WEIGHTS: &str = "decoder_weights.int4.data";
const QWEN3_ASR_LOCAL_EMBED_TOKENS: &str = "embed_tokens.bin";
const QWEN3_ASR_LOCAL_CONFIG: &str = "config.json";
const QWEN3_ASR_LOCAL_TOKENIZER: &str = "tokenizer.json";

/// Mel spectrogram parameters (matching Qwen3-ASR's config.json).
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_N_MELS: usize = 128;
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_N_FFT: usize = 400;
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_HOP_LENGTH: usize = 160;
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_SAMPLE_RATE: u32 = 16_000;

/// Longest stretch of audio decoded in one pass. Longer input is split at
/// pauses (`split_audio_into_chunks`) and each piece decoded on its own, so
/// a 10-minute dictation or a 90 s meeting chunk never runs the decoder
/// past the regime it was validated in (the 44 s real-audio eval), and the
/// KV cache the step loop re-copies on every token stays bounded.
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_CHUNK_SECONDS: f64 = 60.0;

/// Upper bound on generated tokens per second of audio, used to size each
/// chunk's token cap. Basis: the real-audio eval (`qwen3_asr_real_audio_eval`
/// prints tokens and tokens/s per fixture) generates about 4 tokens per
/// second of fluent English (`language English<asr_text>` prefix included);
/// Chinese, Japanese and Korean tokenize near one token per character,
/// roughly 5-6/s of speech. 12/s leaves better than 2x headroom over the
/// densest observed output; a chunk that needs more is looping, not talking.
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_MAX_TOKENS_PER_AUDIO_SECOND: f64 = 12.0;
/// Floor so a one-word clip can still fit its language tag and marker.
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_MIN_NEW_TOKENS: usize = 64;
/// Hard ceiling regardless of chunk length (a full 60 s chunk at 12/s is 736).
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_MAX_NEW_TOKENS_CEILING: usize = 1024;
/// Wall-clock budget for decoding one chunk: 4x the chunk's own duration,
/// at least 30 s. The shared-CPU measurement came in at 0.6-1.3x real time,
/// so 4x is generous on a healthy machine; it is what bounds how long an
/// abandoned request can keep the runtime mutex.
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_DECODE_BUDGET_PER_AUDIO_SECOND: f64 = 4.0;
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_DECODE_BUDGET_MIN_SECONDS: f64 = 30.0;

/// Token cap for one chunk of `audio_seconds`, scaled with the audio and
/// clamped to `[QWEN3_ASR_MIN_NEW_TOKENS, QWEN3_ASR_MAX_NEW_TOKENS_CEILING]`.
#[cfg(feature = "asr-parakeet")]
fn max_new_tokens_for_audio(audio_seconds: f64) -> usize {
    let scaled = (audio_seconds.max(0.0) * QWEN3_ASR_MAX_TOKENS_PER_AUDIO_SECOND).ceil() as usize;
    (scaled + 16).clamp(QWEN3_ASR_MIN_NEW_TOKENS, QWEN3_ASR_MAX_NEW_TOKENS_CEILING)
}

/// Wall-clock budget for decoding one chunk of `audio_seconds`.
#[cfg(feature = "asr-parakeet")]
fn decode_budget_for_audio(audio_seconds: f64) -> Duration {
    Duration::from_secs_f64(
        (audio_seconds.max(0.0) * QWEN3_ASR_DECODE_BUDGET_PER_AUDIO_SECOND)
            .max(QWEN3_ASR_DECODE_BUDGET_MIN_SECONDS),
    )
}

/// Why a decode stopped before the model finished on its own.
#[cfg(feature = "asr-parakeet")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodeStop {
    /// The async caller dropped the request (`CancelOnDrop` fired).
    Cancelled,
    /// The chunk's wall-clock budget ran out.
    DeadlineExceeded,
    /// The token cap was reached without an end-of-speech token.
    TokenCap,
}

/// Cooperative check run once per generated token. The blocking step loop
/// cannot be pre-empted, so this is what turns an abandoned request or a
/// runaway decode into a bounded return instead of a mutex held to the end.
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

/// The error a stopped decode surfaces. None of these ever becomes a
/// normal-looking transcript: a chunk that hit its cap without end-of-speech
/// would be silently missing its tail, so it is refused outright.
#[cfg(feature = "asr-parakeet")]
fn decode_stop_error(
    stop: DecodeStop,
    generated: usize,
    cap: usize,
    audio_seconds: f64,
) -> anyhow::Error {
    match stop {
        DecodeStop::Cancelled => anyhow::anyhow!(
            "Qwen3-ASR decode cancelled by the caller after {generated} tokens of a {audio_seconds:.1} s chunk"
        ),
        DecodeStop::DeadlineExceeded => anyhow::anyhow!(
            "Qwen3-ASR decode exceeded its {:.0} s budget for a {audio_seconds:.1} s chunk after {generated} tokens",
            decode_budget_for_audio(audio_seconds).as_secs_f64()
        ),
        DecodeStop::TokenCap => anyhow::anyhow!(
            "Qwen3-ASR hit its {cap}-token cap for a {audio_seconds:.1} s chunk before end-of-speech; refusing to return a silently truncated transcript"
        ),
    }
}

/// Sets the shared flag when dropped. The async `transcribe` future holds
/// one across its `.await`, so a caller that abandons the request (the
/// sidecar aborts a request's task when Electron gives up on it) flips the
/// flag and the blocking step loop returns at its next token instead of
/// holding the runtime mutex until it finishes on its own.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Split audio into pieces of at most `QWEN3_ASR_CHUNK_SECONDS`, each cut in
/// a pause where the last few seconds of the window offer one (the same
/// energy-based search the meeting pipeline uses), so a sentence is not
/// severed at a fixed sample count. Covers every sample exactly once.
#[cfg(feature = "asr-parakeet")]
fn split_audio_into_chunks(samples: &[f32], sample_rate: u32) -> Vec<Vec<f32>> {
    let chunk_size = ((sample_rate as f64 * QWEN3_ASR_CHUNK_SECONDS) as usize).max(1);
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < samples.len() {
        let remaining = &samples[offset..];
        if remaining.len() <= chunk_size {
            chunks.push(remaining.to_vec());
            break;
        }
        let window = &remaining[..chunk_size];
        let cut = crate::vad_aligned_cut_point(window, sample_rate);
        let cut = if cut == 0 || cut > window.len() {
            window.len()
        } else {
            cut
        };
        chunks.push(window[..cut].to_vec());
        offset += cut;
    }
    chunks
}

/// `<asr_text>`: separates the model's language tag from the transcript in
/// its answer. `config.json` carries the id; this is the fallback when an
/// older config omits it.
const QWEN3_ASR_TEXT_TOKEN_ID: i64 = 151704;

/// The 30 languages the Qwen3-ASR model card lists (the 22 Chinese dialects
/// it also names all surface as `zh`/`yue`). Kept in one place so the
/// settings language picker and the detected-language mapping agree.
pub(crate) const QWEN3_ASR_LANGUAGES: &[(&str, &str)] = &[
    ("Chinese", "zh"),
    ("English", "en"),
    ("Cantonese", "yue"),
    ("Arabic", "ar"),
    ("German", "de"),
    ("French", "fr"),
    ("Spanish", "es"),
    ("Portuguese", "pt"),
    ("Indonesian", "id"),
    ("Italian", "it"),
    ("Korean", "ko"),
    ("Russian", "ru"),
    ("Thai", "th"),
    ("Vietnamese", "vi"),
    ("Japanese", "ja"),
    ("Turkish", "tr"),
    ("Hindi", "hi"),
    ("Malay", "ms"),
    ("Dutch", "nl"),
    ("Swedish", "sv"),
    ("Danish", "da"),
    ("Finnish", "fi"),
    ("Polish", "pl"),
    ("Czech", "cs"),
    ("Filipino", "fil"),
    ("Persian", "fa"),
    ("Greek", "el"),
    ("Hungarian", "hu"),
    ("Macedonian", "mk"),
    ("Romanian", "ro"),
];

/// ISO-style code for a language name the model emits, or the lowercased
/// name when it is not one of the 30 the model card lists.
fn language_code_for_name(name: &str) -> String {
    let trimmed = name.trim();
    QWEN3_ASR_LANGUAGES
        .iter()
        .find(|(label, _)| label.eq_ignore_ascii_case(trimmed))
        .map(|(_, code)| (*code).to_string())
        .unwrap_or_else(|| trimmed.to_lowercase())
}

/// Transcription seconds per audio second measured in Plainsong on an Apple
/// M4 Pro with the int4 decoders on CPU (`benchmark-latency --provider
/// qwen3_asr`, 44 s fixture, 3-run p50 on 2026-09-01). Above 1.0 means
/// slower than real time. Provisional: the CPU was shared with other
/// builds during the run; quieter eval runs of the same fixture measured
/// 0.58 and 0.26. Re-measure on a quiet machine before quoting it.
const QWEN3_ASR_MEASURED_RTF: f64 = 1.33;

fn qwen3_asr_artifact_max_bytes(local_name: &str) -> u64 {
    match local_name {
        QWEN3_ASR_LOCAL_ENCODER => 1024 * 1024 * 1024,
        QWEN3_ASR_LOCAL_DECODER_WEIGHTS => 1024 * 1024 * 1024,
        QWEN3_ASR_LOCAL_EMBED_TOKENS => 512 * 1024 * 1024,
        QWEN3_ASR_LOCAL_DECODER_STEP => 128 * 1024 * 1024,
        QWEN3_ASR_LOCAL_TOKENIZER => 16 * 1024 * 1024,
        _ => 64 * 1024 * 1024,
    }
}

/// Files required for Qwen3-ASR, with their HF repo paths and SHA256 hashes.
///
/// SHA256 hashes are pinned from the `andrewleech/qwen3-asr-0.6b-onnx`
/// HuggingFace repo (revision `main`). If the upstream files change, these
/// must be regenerated — otherwise `download_verified_model_asset` will
/// reject the download as a tamper/integrity failure.
fn qwen3_asr_repo_files() -> [(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
); 7] {
    [
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "encoder.int4.onnx",
            QWEN3_ASR_LOCAL_ENCODER,
            "3c027f880f677615de85e1f6934906e1d5d77624b724096d33accef99c753eed",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "decoder_init.int4.onnx",
            QWEN3_ASR_LOCAL_DECODER_INIT,
            "6d54633bbb9e6b1ecf372f218d04adb3bf6f2bfc442ce55c988526d532896faa",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "decoder_step.int4.onnx",
            QWEN3_ASR_LOCAL_DECODER_STEP,
            "7eaa4f31d5eb6ae2937ff45222c32f692f2d5ac29b46cbae9046da332a9f317d",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "decoder_weights.int4.data",
            QWEN3_ASR_LOCAL_DECODER_WEIGHTS,
            "d68cd1c0695a7ba42651d06b1bc1158e2e58af5f9adbb6dba874fbbb8a4f22cf",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "embed_tokens.bin",
            QWEN3_ASR_LOCAL_EMBED_TOKENS,
            "e80150119fa5f7e56e85aed64c3a02d5c78eb7a37cfdcb973d0987316f15bee2",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "config.json",
            QWEN3_ASR_LOCAL_CONFIG,
            "df31c4689abe9d782366fffd2454b546291d0205d082b3fd01b99fb76a45b11f",
        ),
        (
            QWEN3_ASR_HF_REPO,
            QWEN3_ASR_HF_REVISION,
            "tokenizer.json",
            QWEN3_ASR_LOCAL_TOKENIZER,
            "bd2a97b55c8f7f9c328c73ee9b9178771037e9f566dfca8e238a063d41cbac92",
        ),
    ]
}

/// Whether all seven pinned files in `model_dir` pass `is_model_artifact_trusted`
/// (the receipt the download path or the startup migration wrote after
/// hashing them). Shared with the manager's diagnostics so both say the same.
pub(crate) fn artifacts_trusted(model_dir: &Path) -> bool {
    qwen3_asr_repo_files()
        .iter()
        .all(|(_, _, _, local_name, sha256)| {
            crate::download::is_model_artifact_trusted(&model_dir.join(local_name), Some(sha256))
        })
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let model_dir = models_root.join("qwen3_asr");
    qwen3_asr_repo_files()
        .into_iter()
        .filter(|(_, _, _, _, sha256)| !sha256.is_empty())
        .map(|(_, _, _, local_name, sha256)| (model_dir.join(local_name), sha256.to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// ONNX inference (feature-gated via asr-parakeet since it shares ort)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
struct Qwen3AsrRuntime {
    model_dir_key: String,
    encoder: ort::session::Session,
    decoder_init: ort::session::Session,
    decoder_step: ort::session::Session,
    embed_tokens: ndarray::Array2<f32>,
    config: Qwen3AsrConfig,
    tokenizer: tokenizers::Tokenizer,
    roles: RoleTokens,
}

/// Token ids for the chat-template role words, resolved from the shipped
/// tokenizer so the prompt cannot drift from the vocabulary it decodes with.
#[cfg(feature = "asr-parakeet")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RoleTokens {
    system: Vec<i64>,
    user: Vec<i64>,
    assistant: Vec<i64>,
    newline: Vec<i64>,
}

#[cfg(feature = "asr-parakeet")]
impl RoleTokens {
    fn from_tokenizer(tokenizer: &tokenizers::Tokenizer) -> Result<Self> {
        let encode = |text: &str| -> Result<Vec<i64>> {
            let encoding = tokenizer
                .encode(text, false)
                .map_err(|e| anyhow::anyhow!("Failed to tokenize {text:?}: {e}"))?;
            let ids: Vec<i64> = encoding.get_ids().iter().map(|id| *id as i64).collect();
            if ids.is_empty() {
                anyhow::bail!("Qwen3-ASR tokenizer produced no ids for {text:?}");
            }
            Ok(ids)
        };
        Ok(Self {
            system: encode("system")?,
            user: encode("user")?,
            assistant: encode("assistant")?,
            newline: encode("\n")?,
        })
    }
}

#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize)]
struct Qwen3AsrConfig {
    #[serde(default)]
    decoder: DecoderConfig,
    #[serde(default)]
    mel: MelConfig,
    #[serde(default)]
    special_tokens: SpecialTokens,
    #[serde(default = "default_embed_tokens_dtype")]
    embed_tokens_dtype: String,
}

#[cfg(feature = "asr-parakeet")]
fn default_embed_tokens_dtype() -> String {
    "float16".to_string()
}

#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize, Default)]
struct DecoderConfig {
    #[serde(default)]
    hidden_size: usize,
}

/// Mel parameters as `config.json` states them. Every field is checked
/// against the constants this frontend is built for at load time, so a
/// re-exported model with a different frontend fails loudly instead of
/// producing fluent nonsense.
#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize, Default)]
struct MelConfig {
    #[serde(default = "default_n_mels")]
    n_mels: usize,
    #[serde(default = "default_n_fft")]
    n_fft: usize,
    #[serde(default = "default_hop")]
    hop_length: usize,
    #[serde(default)]
    sample_rate: u32,
    #[serde(default)]
    fmin: f32,
    #[serde(default = "default_fmax")]
    fmax: f32,
}

#[cfg(feature = "asr-parakeet")]
fn default_n_mels() -> usize {
    128
}
#[cfg(feature = "asr-parakeet")]
fn default_n_fft() -> usize {
    400
}
#[cfg(feature = "asr-parakeet")]
fn default_hop() -> usize {
    160
}
#[cfg(feature = "asr-parakeet")]
fn default_fmax() -> f32 {
    8000.0
}

/// The special-token ids the prompt and the answer parser need. The pad id
/// (`<|endoftext|>`) is deliberately not read: it doubles as an EOS id and
/// arrives through `eos_token_ids`.
#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize, Default)]
struct SpecialTokens {
    #[serde(default)]
    im_start_token_id: i64,
    #[serde(default)]
    im_end_token_id: i64,
    #[serde(default)]
    audio_start_token_id: i64,
    #[serde(default)]
    audio_end_token_id: i64,
    #[serde(default)]
    audio_pad_token_id: i64,
    #[serde(default = "default_asr_text_token_id")]
    asr_text_token_id: i64,
    #[serde(default)]
    eos_token_ids: Vec<i64>,
}

#[cfg(feature = "asr-parakeet")]
fn default_asr_text_token_id() -> i64 {
    QWEN3_ASR_TEXT_TOKEN_ID
}

#[cfg(feature = "asr-parakeet")]
impl Qwen3AsrConfig {
    fn load(model_dir: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(model_dir.join(QWEN3_ASR_LOCAL_CONFIG))
            .context("Failed to read Qwen3-ASR config.json")?;
        serde_json::from_str(&text).context("Failed to parse Qwen3-ASR config.json")
    }
}

#[cfg(feature = "asr-parakeet")]
fn load_embed_cache(path: &Path, config: &Qwen3AsrConfig) -> Result<ndarray::Array2<f32>> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Failed to read embed_tokens.bin from {}", path.display()))?;

    let hidden_size = config.decoder.hidden_size;
    if hidden_size == 0 {
        return Err(anyhow::anyhow!(
            "Qwen3-ASR config has hidden_size=0; cannot interpret embed_tokens.bin"
        ));
    }

    let is_fp16 = config.embed_tokens_dtype.eq_ignore_ascii_case("fp16")
        || config.embed_tokens_dtype.eq_ignore_ascii_case("half")
        || config.embed_tokens_dtype.eq_ignore_ascii_case("float16");

    if is_fp16 {
        if bytes.len() % 2 != 0 {
            return Err(anyhow::anyhow!(
                "embed_tokens.bin has {} bytes, not a whole number of float16 values",
                bytes.len()
            ));
        }
        let element_count = bytes.len() / 2;
        if element_count % hidden_size != 0 {
            return Err(anyhow::anyhow!(
                "embed_tokens.bin size {} is not divisible by hidden_size {}",
                bytes.len(),
                hidden_size
            ));
        }
        let vocab_size = element_count / hidden_size;
        let mut data = Vec::with_capacity(element_count);
        for chunk in bytes.chunks_exact(2) {
            let bits = u16::from_le_bytes([chunk[0], chunk[1]]);
            data.push(crate::audio::mel::f16_bits_to_f32(bits));
        }
        ndarray::Array2::from_shape_vec((vocab_size, hidden_size), data)
            .context("Failed to shape embed_tokens matrix")
    } else {
        if bytes.len() % 4 != 0 {
            return Err(anyhow::anyhow!(
                "embed_tokens.bin has {} bytes, not a whole number of float32 values",
                bytes.len()
            ));
        }
        let element_count = bytes.len() / 4;
        if element_count % hidden_size != 0 {
            return Err(anyhow::anyhow!(
                "embed_tokens.bin size {} is not divisible by hidden_size {}",
                bytes.len(),
                hidden_size
            ));
        }
        let vocab_size = element_count / hidden_size;
        let mut data = Vec::with_capacity(element_count);
        for chunk in bytes.chunks_exact(4) {
            data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        ndarray::Array2::from_shape_vec((vocab_size, hidden_size), data)
            .context("Failed to shape embed_tokens matrix")
    }
}

#[cfg(feature = "asr-parakeet")]
fn load_runtime(model_dir: &Path) -> Result<Qwen3AsrRuntime> {
    let config = Qwen3AsrConfig::load(model_dir)?;

    if config.mel.n_mels != QWEN3_ASR_N_MELS {
        return Err(anyhow::anyhow!(
            "Qwen3-ASR config n_mels={} does not match expected {}",
            config.mel.n_mels,
            QWEN3_ASR_N_MELS
        ));
    }
    if config.mel.n_fft != QWEN3_ASR_N_FFT || config.mel.hop_length != QWEN3_ASR_HOP_LENGTH {
        return Err(anyhow::anyhow!(
            "Qwen3-ASR config n_fft={} hop_length={} do not match the expected {}/{}",
            config.mel.n_fft,
            config.mel.hop_length,
            QWEN3_ASR_N_FFT,
            QWEN3_ASR_HOP_LENGTH
        ));
    }
    if config.mel.sample_rate != 0 && config.mel.sample_rate != QWEN3_ASR_SAMPLE_RATE {
        return Err(anyhow::anyhow!(
            "Qwen3-ASR config sample_rate={} does not match expected {}",
            config.mel.sample_rate,
            QWEN3_ASR_SAMPLE_RATE
        ));
    }

    let tokenizer = tokenizers::Tokenizer::from_file(model_dir.join(QWEN3_ASR_LOCAL_TOKENIZER))
        .map_err(|e| anyhow::anyhow!("Failed to load Qwen3-ASR tokenizer: {}", e))?;

    // The encoder is a standard ONNX model and benefits from CoreML EP.
    let encoder = crate::ort_utils::build_session(&model_dir.join(QWEN3_ASR_LOCAL_ENCODER))
        .context("Failed to load Qwen3-ASR encoder")?;
    // The int4-quantized decoders use matmul ops that CoreML does not support
    // efficiently; routing them through CoreML adds EP dispatch overhead
    // without any acceleration. Use the CPU-only path instead.
    let decoder_init = crate::ort_utils::build_session_no_coreml(
        &model_dir.join(QWEN3_ASR_LOCAL_DECODER_INIT),
        Ok,
    )
    .context("Failed to load Qwen3-ASR decoder_init")?;
    let decoder_step = crate::ort_utils::build_session_no_coreml(
        &model_dir.join(QWEN3_ASR_LOCAL_DECODER_STEP),
        Ok,
    )
    .context("Failed to load Qwen3-ASR decoder_step")?;

    let embed_tokens = load_embed_cache(&model_dir.join(QWEN3_ASR_LOCAL_EMBED_TOKENS), &config)?;
    let roles = RoleTokens::from_tokenizer(&tokenizer)?;

    tracing::info!(
        "Qwen3-ASR loaded: encoder + decoder_init + decoder_step + embed_tokens {:?}",
        embed_tokens.shape()
    );

    Ok(Qwen3AsrRuntime {
        model_dir_key: model_dir.to_string_lossy().to_string(),
        encoder,
        decoder_init,
        decoder_step,
        embed_tokens,
        config,
        tokenizer,
        roles,
    })
}

#[cfg(feature = "asr-parakeet")]
fn runtime_cache() -> &'static Mutex<Option<Qwen3AsrRuntime>> {
    static CACHE: OnceLock<Mutex<Option<Qwen3AsrRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-parakeet")]
pub(crate) fn clear_cached_runtime(model_dir: &Path) {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    if let Ok(mut cache) = runtime_cache().lock() {
        if cache
            .as_ref()
            .map(|rt| rt.model_dir_key == model_dir_key)
            .unwrap_or(false)
        {
            *cache = None;
            tracing::info!(
                "Cleared cached Qwen3-ASR runtime for {}",
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
    let mut cache = runtime_cache()
        .lock()
        .map_err(|error| anyhow::anyhow!("Qwen3-ASR runtime cache is unavailable: {}", error))?;
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
        "Qwen3-ASR ONNX support is not compiled into this build."
    ))
}

// ---------------------------------------------------------------------------
// Mel spectrogram computation: Whisper's frontend, as the export expects
// ---------------------------------------------------------------------------

/// Whisper-compatible 128-bin log-mel spectrogram laid out `[1, n_mels, T]`.
///
/// Mirrors the export's reference `src/mel.py` step for step: centered STFT
/// (reflect padding of `n_fft / 2` on both sides, as `torch.stft` does),
/// periodic Hann window, power spectrum, Slaney mel filterbank, `log10`
/// floored at `1e-10`, values floored at `max - 8`, then `(x + 4) / 4`, and
/// the last STFT frame dropped to match `WhisperFeatureExtractor`.
#[cfg(feature = "asr-parakeet")]
fn compute_log_mel_spectrogram(
    samples: &[f32],
    fmin: f32,
    fmax: f32,
) -> Result<ndarray::Array3<f32>> {
    use rustfft::FftPlanner;
    use std::f64::consts::PI;

    let n_fft = QWEN3_ASR_N_FFT;
    let hop = QWEN3_ASR_HOP_LENGTH;
    let n_mels = QWEN3_ASR_N_MELS;
    let sample_rate = QWEN3_ASR_SAMPLE_RATE as f32;
    let pad = n_fft / 2;

    // torch.stft(center=True) reflect-pads; reflection needs more than `pad`
    // samples on each side, so a clip too short for that is zero-padded.
    let mut padded: Vec<f64> = Vec::with_capacity(samples.len() + 2 * pad);
    if samples.len() > pad {
        padded.extend(samples[1..=pad].iter().rev().map(|s| *s as f64));
        padded.extend(samples.iter().map(|s| *s as f64));
        let tail_start = samples.len() - pad - 1;
        padded.extend(
            samples[tail_start..samples.len() - 1]
                .iter()
                .rev()
                .map(|s| *s as f64),
        );
    } else {
        padded.extend(std::iter::repeat_n(0.0, pad));
        padded.extend(samples.iter().map(|s| *s as f64));
        padded.extend(std::iter::repeat_n(0.0, pad));
    }

    let window: Vec<f64> = (0..n_fft)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / n_fft as f64).cos())
        .collect();
    let mel_bank =
        crate::audio::mel::create_mel_filterbank_slaney(n_fft, sample_rate, n_mels, fmin, fmax);

    let stft_frames = if padded.len() < n_fft {
        0
    } else {
        1 + (padded.len() - n_fft) / hop
    };
    // WhisperFeatureExtractor drops the final frame.
    let num_frames = stft_frames.saturating_sub(1);
    if num_frames == 0 {
        return Err(anyhow::anyhow!(
            "Audio is too short for a Qwen3-ASR mel spectrogram ({} samples)",
            samples.len()
        ));
    }

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut log_mel = vec![0.0f64; n_mels * num_frames];
    let mut buffer: Vec<rustfft::num_complex::Complex<f64>> = vec![Default::default(); n_fft];
    let mut power = vec![0.0f64; n_fft / 2 + 1];

    for frame_idx in 0..num_frames {
        let start = frame_idx * hop;
        for (i, slot) in buffer.iter_mut().enumerate() {
            *slot = rustfft::num_complex::Complex::new(padded[start + i] * window[i], 0.0);
        }
        fft.process(&mut buffer);
        for (bin, slot) in power.iter_mut().enumerate() {
            *slot = buffer[bin].norm_sqr();
        }
        for (mel_idx, mel_row) in mel_bank.iter().enumerate() {
            let energy: f64 = mel_row
                .iter()
                .zip(power.iter())
                .map(|(weight, value)| weight * value)
                .sum();
            log_mel[mel_idx * num_frames + frame_idx] = energy.max(1e-10).log10();
        }
    }

    let max = log_mel.iter().copied().fold(f64::MIN, f64::max);
    let floor = max - 8.0;
    let normalized: Vec<f32> = log_mel
        .iter()
        .map(|value| ((value.max(floor) + 4.0) / 4.0) as f32)
        .collect();

    ndarray::Array3::from_shape_vec((1, n_mels, num_frames), normalized)
        .context("Failed to shape Qwen3-ASR mel spectrogram")
}

// ---------------------------------------------------------------------------
// Prompt building and inference
// ---------------------------------------------------------------------------
/// The chat-template prompt the export's decoder was traced with:
/// an empty system turn, a user turn holding the audio placeholders, and an
/// open assistant turn for the model to fill.
#[cfg(feature = "asr-parakeet")]
fn build_prompt_ids(
    special: &SpecialTokens,
    roles: &RoleTokens,
    audio_token_count: usize,
) -> Vec<i64> {
    let mut ids = Vec::with_capacity(audio_token_count + 24);
    ids.push(special.im_start_token_id);
    ids.extend_from_slice(&roles.system);
    ids.extend_from_slice(&roles.newline);
    ids.push(special.im_end_token_id);
    ids.extend_from_slice(&roles.newline);

    ids.push(special.im_start_token_id);
    ids.extend_from_slice(&roles.user);
    ids.extend_from_slice(&roles.newline);
    ids.push(special.audio_start_token_id);
    ids.extend(std::iter::repeat_n(
        special.audio_pad_token_id,
        audio_token_count,
    ));
    ids.push(special.audio_end_token_id);
    ids.push(special.im_end_token_id);
    ids.extend_from_slice(&roles.newline);

    ids.push(special.im_start_token_id);
    ids.extend_from_slice(&roles.assistant);
    ids.extend_from_slice(&roles.newline);
    ids
}

/// Extract an ONNX session output as an owned `ArrayD<f32>` by name.
///
/// Returns `None` if the output is not found; returns `Err` if found but
/// cannot be extracted as a float32 array.
#[cfg(feature = "asr-parakeet")]
fn extract_array_output_by_name(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Option<Result<ndarray::Array<f32, ndarray::IxDyn>>> {
    for (output_name, value) in outputs.iter() {
        if output_name == name {
            return Some(
                value
                    .try_extract_array::<f32>()
                    .map(|v| v.into_owned())
                    .map_err(|e| anyhow::anyhow!("Failed to extract '{}': {}", name, e)),
            );
        }
    }
    None
}

/// Greedy pick over the vocabulary at one sequence position of a
/// `[1, seq, vocab]` logits tensor, read in place: the prefill logits cover
/// the whole prompt (hundreds of positions × 151k vocabulary), so copying
/// them out to find one row would cost more than the decoder step itself.
#[cfg(feature = "asr-parakeet")]
fn argmax_slice(logits: &ndarray::Array<f32, ndarray::IxDyn>, position: usize) -> Result<i64> {
    let view = logits
        .view()
        .into_dimensionality::<ndarray::Ix3>()
        .context("Qwen3-ASR logits are not [1, seq, vocab]")?;
    if position >= view.shape()[1] {
        return Err(anyhow::anyhow!(
            "argmax: position {} exceeds logits sequence length {}",
            position,
            view.shape()[1]
        ));
    }
    let row = view.index_axis(ndarray::Axis(0), 0);
    let row = row.index_axis(ndarray::Axis(0), position);
    Ok(row
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i as i64)
        .unwrap_or(0))
}

/// What one inference produced: the language the model tagged the audio
/// with (from its `language <Name><asr_text>` answer prefix) and the text.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Qwen3Decoded {
    language: Option<String>,
    text: String,
    /// Tokens the decoder generated (language tag, marker and text), summed
    /// over chunks. The eval prints it per second of audio, which is where
    /// `QWEN3_ASR_MAX_TOKENS_PER_AUDIO_SECOND` comes from.
    generated_tokens: usize,
    /// How many pieces the audio was decoded in.
    chunks: usize,
}

/// Transcribe a file: load it (mono, 16 kHz), split it into pause-aligned
/// chunks, and decode each with the cached runtime. The runtime mutex is
/// held for the whole call; every chunk's step loop checks `cancelled` and
/// its own deadline per token, so the hold is bounded even for a request
/// nobody is waiting on any more.
#[cfg(feature = "asr-parakeet")]
fn run_qwen3_asr_onnx(
    model_dir: &Path,
    audio_path: &Path,
    cancelled: &AtomicBool,
) -> Result<Qwen3Decoded> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Qwen3-ASR")?;

    if samples.is_empty() {
        return Ok(Qwen3Decoded {
            language: None,
            text: String::new(),
            generated_tokens: 0,
            chunks: 0,
        });
    }

    let model_dir_key = model_dir.to_string_lossy().to_string();
    let mut cache = runtime_cache()
        .lock()
        .map_err(|error| anyhow::anyhow!("Qwen3-ASR runtime cache is unavailable: {}", error))?;
    let should_reload = cache
        .as_ref()
        .map(|rt| rt.model_dir_key != model_dir_key)
        .unwrap_or(true);
    if should_reload {
        *cache = Some(load_runtime(model_dir)?);
    }
    let runtime = cache
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR runtime cache unavailable"))?;

    let chunks = split_audio_into_chunks(&samples, QWEN3_ASR_SAMPLE_RATE);
    let mut language = None;
    let mut texts = Vec::with_capacity(chunks.len());
    let mut generated_tokens = 0usize;
    for chunk in &chunks {
        let decoded = decode_chunk(runtime, chunk, cancelled)?;
        if language.is_none() {
            language = decoded.language;
        }
        generated_tokens += decoded.generated_tokens;
        if !decoded.text.is_empty() {
            texts.push(decoded.text);
        }
    }

    Ok(Qwen3Decoded {
        language,
        text: texts.join(" "),
        generated_tokens,
        chunks: chunks.len(),
    })
}

/// Decode one chunk of at most `QWEN3_ASR_CHUNK_SECONDS` of 16 kHz audio.
#[cfg(feature = "asr-parakeet")]
fn decode_chunk(
    runtime: &mut Qwen3AsrRuntime,
    samples: &[f32],
    cancelled: &AtomicBool,
) -> Result<Qwen3Decoded> {
    use ndarray::{Array1, Array2};
    use ort::value::Tensor;

    let audio_seconds = samples.len() as f64 / f64::from(QWEN3_ASR_SAMPLE_RATE);
    let cap = max_new_tokens_for_audio(audio_seconds);
    let deadline = Instant::now() + decode_budget_for_audio(audio_seconds);
    let mut reached_eos = false;

    {
        // 1. Compute mel spectrogram
        let mel =
            compute_log_mel_spectrogram(samples, runtime.config.mel.fmin, runtime.config.mel.fmax)
                .context("Failed to compute Qwen3-ASR mel spectrogram")?;

        // 2. Run encoder
        let mel_arr = mel.into_dyn();
        let mel_tensor =
            Tensor::from_array(mel_arr).context("Failed to create Qwen3-ASR mel tensor")?;
        let enc_outputs = runtime
            .encoder
            .run(ort::inputs!["mel" => mel_tensor])
            .context("Qwen3-ASR encoder inference failed")?;

        let audio_features = enc_outputs
            .iter()
            .next()
            .map(|(_, v)| v)
            .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR encoder produced no outputs"))?
            .try_extract_array::<f32>()
            .context("Failed to extract Qwen3-ASR audio features")?
            .into_owned();

        // 3. Build prompt
        let audio_token_count = audio_features.shape()[1];
        let prompt_ids = build_prompt_ids(
            &runtime.config.special_tokens,
            &runtime.roles,
            audio_token_count,
        );
        let seq_len = prompt_ids.len();

        let audio_start = prompt_ids
            .iter()
            .position(|&id| id == runtime.config.special_tokens.audio_pad_token_id)
            .unwrap_or(1);

        let input_ids_arr: Array2<i64> = Array2::from_shape_vec((1, seq_len), prompt_ids.clone())
            .context("Failed to shape Qwen3-ASR input_ids")?;
        let position_ids_arr: Array2<i64> = Array2::from_shape_fn((1, seq_len), |(_, j)| j as i64);
        let audio_offset_arr: Array1<i64> = Array1::from_elem(1, audio_start as i64);

        let input_ids_tensor = Tensor::from_array(input_ids_arr.into_dyn())
            .context("Failed to create input_ids tensor")?;
        let position_ids_tensor = Tensor::from_array(position_ids_arr.into_dyn())
            .context("Failed to create position_ids tensor")?;
        let audio_features_tensor = Tensor::from_array(audio_features.clone().into_dyn())
            .context("Failed to create audio_features tensor")?;
        let audio_offset_tensor = Tensor::from_array(audio_offset_arr.into_dyn())
            .context("Failed to create audio_offset tensor")?;

        // 4. Run decoder_init (prefill)
        //
        // The andrewleech export's decoder_init accepts:
        //   input_ids      [1, seq_len]      i64
        //   position_ids   [1, seq_len]      i64
        //   audio_features [1, N, 1024]      f32
        //   audio_offset   [1]               i64
        //
        // And outputs:
        //   logits         [1, seq_len, vocab_size]  f32
        //   present_keys   [28, 1, 8, seq_len, 128]  f32  (stacked KV cache)
        //   present_values [28, 1, 8, seq_len, 128]  f32
        let init_outputs = runtime
            .decoder_init
            .run(ort::inputs![
                "input_ids" => input_ids_tensor,
                "position_ids" => position_ids_tensor,
                "audio_features" => audio_features_tensor,
                "audio_offset" => audio_offset_tensor,
            ])
            .context("Qwen3-ASR decoder_init inference failed")?;

        // Extract logits (first output) and KV cache (present_keys/present_values)
        // by name. The ONNX model outputs them in a known order, but looking
        // up by name is more robust against export variations.
        let logits = extract_array_output_by_name(&init_outputs, "logits")
            .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR decoder_init did not output 'logits'"))?
            .context("Failed to extract Qwen3-ASR logits")?;

        let mut past_keys = extract_array_output_by_name(&init_outputs, "present_keys")
            .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR decoder_init did not output 'present_keys'"))?
            .context("Failed to extract Qwen3-ASR present_keys")?;
        let mut past_values = extract_array_output_by_name(&init_outputs, "present_values")
            .ok_or_else(|| {
                anyhow::anyhow!("Qwen3-ASR decoder_init did not output 'present_values'")
            })?
            .context("Failed to extract Qwen3-ASR present_values")?;

        let last_pos = logits.shape()[1]
            .checked_sub(1)
            .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR decoder_init returned empty logits"))?;
        let mut current_token = argmax_slice(&logits, last_pos)?;

        let mut output_tokens = vec![current_token];

        // Check for EOS
        if runtime
            .config
            .special_tokens
            .eos_token_ids
            .contains(&current_token)
        {
            return Ok(decode_generation(
                &runtime.tokenizer,
                runtime.config.special_tokens.asr_text_token_id,
                &output_tokens,
            ));
        }

        // 5. Autoregressive decode loop with KV cache threading.
        //
        // decoder_step accepts:
        //   input_embeds  [1, 1, hidden_size]  f32
        //   position_ids  [1, 1]               i64
        //   past_keys     [28, 1, 8, seq, 128]  f32
        //   past_values   [28, 1, 8, seq, 128]  f32
        //
        // And outputs:
        //   logits         [1, 1, vocab_size]  f32
        //   present_keys   [28, 1, 8, seq+1, 128]  f32
        //   present_values [28, 1, 8, seq+1, 128]  f32
        //
        // The present_* outputs become past_* inputs for the next iteration.
        let hidden_size = runtime.config.decoder.hidden_size;
        let mut pos = seq_len as i64;

        for _ in 1..cap {
            if let Err(stop) = check_decode_control(cancelled, deadline) {
                return Err(decode_stop_error(
                    stop,
                    output_tokens.len(),
                    cap,
                    audio_seconds,
                ));
            }

            // Embedding lookup from cached table
            let token_embed = {
                let id = current_token as usize;
                if id >= runtime.embed_tokens.nrows() {
                    return Err(anyhow::anyhow!(
                        "Qwen3-ASR token ID {} exceeds embedding rows {}",
                        id,
                        runtime.embed_tokens.nrows()
                    ));
                }
                let row = runtime.embed_tokens.row(id);
                let mut arr = ndarray::Array3::<f32>::zeros((1, 1, hidden_size));
                arr.slice_mut(ndarray::s![0, 0, ..]).assign(&row);
                arr
            };

            let embed_dyn = token_embed.into_dyn();
            let embed_tensor =
                Tensor::from_array(embed_dyn).context("Failed to create input_embeds tensor")?;
            let pos_arr: Array2<i64> = Array2::from_elem((1, 1), pos);
            let pos_tensor = Tensor::from_array(pos_arr.into_dyn())
                .context("Failed to create position_ids tensor")?;

            let past_keys_tensor = Tensor::from_array(past_keys.clone().into_dyn())
                .context("Failed to create past_keys tensor")?;
            let past_values_tensor = Tensor::from_array(past_values.clone().into_dyn())
                .context("Failed to create past_values tensor")?;

            let step_outputs = runtime
                .decoder_step
                .run(ort::inputs![
                    "input_embeds" => embed_tensor,
                    "position_ids" => pos_tensor,
                    "past_keys" => past_keys_tensor,
                    "past_values" => past_values_tensor,
                ])
                .map_err(|e| anyhow::anyhow!("Qwen3-ASR decoder_step failed: {}", e))?;

            // Extract logits and updated KV cache
            let step_logits = extract_array_output_by_name(&step_outputs, "logits")
                .ok_or_else(|| anyhow::anyhow!("Qwen3-ASR decoder_step did not output 'logits'"))?
                .context("Failed to extract Qwen3-ASR step logits")?;

            let new_keys = extract_array_output_by_name(&step_outputs, "present_keys")
                .ok_or_else(|| {
                    anyhow::anyhow!("Qwen3-ASR decoder_step did not output 'present_keys'")
                })?
                .context("Failed to extract Qwen3-ASR step present_keys")?;
            let new_values = extract_array_output_by_name(&step_outputs, "present_values")
                .ok_or_else(|| {
                    anyhow::anyhow!("Qwen3-ASR decoder_step did not output 'present_values'")
                })?
                .context("Failed to extract Qwen3-ASR step present_values")?;

            // Update KV cache for next iteration
            past_keys = new_keys;
            past_values = new_values;

            let next_token = argmax_slice(&step_logits, 0)?;

            if runtime
                .config
                .special_tokens
                .eos_token_ids
                .contains(&next_token)
            {
                reached_eos = true;
                break;
            }
            output_tokens.push(next_token);
            current_token = next_token;
            pos += 1;
        }

        if !reached_eos {
            return Err(decode_stop_error(
                DecodeStop::TokenCap,
                output_tokens.len(),
                cap,
                audio_seconds,
            ));
        }

        Ok(decode_generation(
            &runtime.tokenizer,
            runtime.config.special_tokens.asr_text_token_id,
            &output_tokens,
        ))
    }
}

#[cfg(feature = "asr-parakeet")]
fn decode_tokens(tokenizer: &tokenizers::Tokenizer, token_ids: &[i64]) -> String {
    let ids: Vec<u32> = token_ids.iter().map(|&id| id as u32).collect();
    tokenizer.decode(&ids, true).unwrap_or_default()
}

/// Split the model's answer at `<asr_text>`: everything before it is the
/// language tag (`language <Name>`), everything after is the transcript.
/// Without the marker the whole answer is decoded and the textual prefix is
/// stripped as a fallback.
#[cfg(feature = "asr-parakeet")]
fn decode_generation(
    tokenizer: &tokenizers::Tokenizer,
    asr_text_token_id: i64,
    token_ids: &[i64],
) -> Qwen3Decoded {
    if let Some(split) = token_ids.iter().position(|id| *id == asr_text_token_id) {
        let prefix = decode_tokens(tokenizer, &token_ids[..split]);
        let language = prefix
            .trim()
            .strip_prefix("language ")
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        return Qwen3Decoded {
            language,
            text: decode_tokens(tokenizer, &token_ids[split + 1..])
                .trim()
                .to_string(),
            generated_tokens: token_ids.len(),
            chunks: 1,
        };
    }
    let raw = decode_tokens(tokenizer, token_ids);
    Qwen3Decoded {
        language: fallback_language_name(&raw),
        text: strip_language_prefix(&raw).trim().to_string(),
        generated_tokens: token_ids.len(),
        chunks: 1,
    }
}

/// Language name from a `language <Name>...` answer that carried no
/// `<asr_text>` marker: the leading run of letters after the tag. Only a
/// fallback, so a missing newline can over-read into the transcript; the
/// marker path above is what real output takes.
fn fallback_language_name(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("language ")?;
    let name: String = rest.chars().take_while(|c| c.is_alphabetic()).collect();
    (!name.is_empty()).then_some(name)
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_qwen3_asr_onnx(
    _model_dir: &Path,
    _audio_path: &Path,
    _cancelled: &AtomicBool,
) -> Result<Qwen3Decoded> {
    Err(anyhow::anyhow!(
        "Qwen3-ASR ONNX support is not compiled into this build. Rebuild with the `asr-parakeet` feature."
    ))
}

/// Strip the language identification prefix that Qwen3-ASR generates.
///
/// The model outputs "language <Name>\n<transcription>" where \n is
/// GPT-2 BPE token 198. Occasionally the newline is absent.
fn strip_language_prefix(text: &str) -> String {
    if let Some(rest) = text.strip_prefix("language ") {
        if let Some(newline_pos) = rest.find('\n') {
            return rest[newline_pos + 1..].to_string();
        }
        const KNOWN_LANGS: &[&str] = &[
            "English",
            "Chinese",
            "Japanese",
            "Korean",
            "French",
            "Spanish",
            "German",
            "Italian",
            "Portuguese",
            "Russian",
            "Arabic",
            "Hindi",
        ];
        for lang in KNOWN_LANGS {
            if let Some(after) = rest.strip_prefix(lang) {
                return after.to_string();
            }
        }
        return rest.to_string();
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// Provider trait implementation
// ---------------------------------------------------------------------------
pub struct Qwen3AsrProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl Qwen3AsrProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let root_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&root_dir, selected_model_id)
    }

    pub(crate) fn with_models_root(models_root: &Path, selected_model_id: Option<&str>) -> Self {
        Self {
            model_dir: models_root.join("qwen3_asr"),
            model_id: selected_model_id.unwrap_or(QWEN3_ASR_MODEL_ID).to_string(),
        }
    }

    /// Every pinned artifact carries a valid integrity receipt. Plausible
    /// bytes on disk are not enough: a swapped `decoder_step.int4.onnx` of
    /// the right size and header would otherwise run.
    fn has_trusted_required_files(&self) -> bool {
        artifacts_trusted(&self.model_dir)
    }

    fn has_required_files(&self) -> bool {
        fn valid_onnx(path: &Path) -> bool {
            use std::io::Read;
            let Ok(meta) = std::fs::metadata(path) else {
                return false;
            };
            if meta.len() < 4096 {
                return false;
            }
            let Ok(mut f) = std::fs::File::open(path) else {
                return false;
            };
            let mut buf = [0u8; 1];
            f.read_exact(&mut buf).is_ok() && buf[0] != b'<' && buf[0] != b'{'
        }
        fn valid_file(path: &Path, min_size: u64) -> bool {
            std::fs::metadata(path)
                .map(|m| m.len() >= min_size)
                .unwrap_or(false)
        }

        valid_onnx(&self.model_dir.join(QWEN3_ASR_LOCAL_ENCODER))
            && valid_onnx(&self.model_dir.join(QWEN3_ASR_LOCAL_DECODER_INIT))
            && valid_onnx(&self.model_dir.join(QWEN3_ASR_LOCAL_DECODER_STEP))
            && valid_file(&self.model_dir.join(QWEN3_ASR_LOCAL_DECODER_WEIGHTS), 1024)
            && valid_file(&self.model_dir.join(QWEN3_ASR_LOCAL_EMBED_TOKENS), 1024)
            && valid_file(&self.model_dir.join(QWEN3_ASR_LOCAL_CONFIG), 64)
            && valid_file(&self.model_dir.join(QWEN3_ASR_LOCAL_TOKENIZER), 1024)
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

impl Default for Qwen3AsrProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for Qwen3AsrProvider {
    fn name(&self) -> &str {
        "Qwen3-ASR"
    }

    fn description(&self) -> &str {
        "Alibaba Qwen3-ASR 0.6B, native ONNX, int4 decoders on CPU. Experimental: 30 languages listed upstream (incl. Chinese, Japanese, Korean); English validated in Plainsong; slower than real time."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.has_trusted_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        if !self.has_required_files() {
            anyhow::bail!(
                "Qwen3-ASR model is not downloaded. Use the model manager to download it."
            );
        }
        if !self.has_trusted_required_files() {
            anyhow::bail!(
                "Qwen3-ASR model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            );
        }
        let model_dir = self.model_dir.clone();
        tokio::task::spawn_blocking(move || prewarm_runtime(&model_dir))
            .await
            .context("Qwen3-ASR model warmup task panicked")??;
        Ok(())
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Qwen3-ASR 0.6B".to_string(),
            version: "0.6b-int4".to_string(),
            // MiB across the seven pinned files (2,020,098,572 bytes); the
            // field is MiB despite its name, like every other provider's.
            size_mb: 1927.0,
            parameters: "0.6B".to_string(),
            languages: QWEN3_ASR_LANGUAGES
                .iter()
                .map(|(_, code)| (*code).to_string())
                .collect(),
            // Upstream figure for the int4 export on LibriSpeech test-other.
            word_error_rate: Some(5.16),
            // Measured in Plainsong on an Apple M4 Pro, CPU int4 decoders,
            // 44 s fixture: see QWEN3_ASR_MEASURED_RTF.
            real_time_factor: Some(QWEN3_ASR_MEASURED_RTF),
            license: "Apache-2.0".to_string(),
            source_url: format!("https://huggingface.co/{}", QWEN3_ASR_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Qwen3-ASR model not downloaded. Use the model manager to download it."
            ));
        }
        if !self.has_trusted_required_files() {
            return Err(anyhow::anyhow!(
                "Qwen3-ASR model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            ));
        }

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_for_dur = audio_path.to_path_buf();
        let audio_path_owned = audio_path.to_path_buf();

        // Dropping this future (the sidecar aborts a request's task when the
        // caller gives up) flips the flag; the blocking decode sees it at its
        // next token and returns, releasing the runtime for the next request.
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&cancelled));
        let decoded = tokio::task::spawn_blocking(move || {
            run_qwen3_asr_onnx(&model_dir, &audio_path_owned, &cancelled)
        })
        .await
        .context("Qwen3-ASR inference task panicked")??;

        let text = decoded.text;
        let language = decoded
            .language
            .as_deref()
            .map(language_code_for_name)
            .unwrap_or_else(|| "auto".to_string());
        let duration = Self::wav_duration_seconds(&audio_for_dur);
        let segment = TranscriptSegment {
            start_time: 0.0,
            end_time: duration,
            text: text.clone(),
            confidence: 0.9,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language,
            confidence: 0.9,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: self.model_id.clone(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Qwen3Asr,
            actual_provider: AsrProviderType::Qwen3Asr,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("qwen3_asr_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("Failed to write temp WAV for Qwen3-ASR")?;
        let result = self.transcribe(&temp_path).await;
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
            .context("Failed to create Qwen3-ASR model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);
        let files = qwen3_asr_repo_files();
        let n_files = files.len() as f32;

        for (i, (repo_id, revision, hf_path, local_name, sha256)) in files.into_iter().enumerate() {
            let destination = self.model_dir.join(local_name);
            let url = format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                repo_id, revision, hf_path
            );
            let cb = progress_cb.clone();
            manager
                .download_verified_model_asset(
                    &url,
                    &destination,
                    Some(sha256),
                    qwen3_asr_artifact_max_bytes(local_name),
                    move |p| {
                        cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                        tracing::info!("Qwen3-ASR {} download: {:.1}%", local_name, p.percentage);
                    },
                )
                .await?;
        }

        tracing::info!("Qwen3-ASR model downloaded successfully");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_language_prefix_with_newline() {
        assert_eq!(
            strip_language_prefix("language English\nHello world"),
            "Hello world"
        );
    }

    #[test]
    fn strip_language_prefix_without_newline() {
        assert_eq!(
            strip_language_prefix("language EnglishHello world"),
            "Hello world"
        );
    }

    #[test]
    fn strip_language_prefix_no_prefix() {
        assert_eq!(strip_language_prefix("Hello world"), "Hello world");
    }

    #[test]
    fn fallback_language_name_reads_the_tag_without_slicing_bytes() {
        assert_eq!(
            fallback_language_name("language English\nHello world").as_deref(),
            Some("English")
        );
        assert_eq!(
            fallback_language_name("language Chinese\n你好世界").as_deref(),
            Some("Chinese")
        );
        assert_eq!(fallback_language_name("你好世界"), None);
        assert_eq!(fallback_language_name("language "), None);
    }

    #[test]
    fn strip_language_prefix_empty() {
        assert_eq!(strip_language_prefix(""), "");
    }

    #[test]
    fn strip_language_prefix_chinese() {
        assert_eq!(
            strip_language_prefix("language Chinese\n你好世界"),
            "你好世界"
        );
    }

    #[test]
    fn strip_language_prefix_unknown_with_newline() {
        assert_eq!(strip_language_prefix("language Klingon\nQapla!"), "Qapla!");
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn prompt_follows_the_export_chat_template() {
        let special = SpecialTokens {
            im_start_token_id: 151644,
            im_end_token_id: 151645,
            audio_start_token_id: 151669,
            audio_end_token_id: 151670,
            audio_pad_token_id: 151676,
            asr_text_token_id: 151704,
            eos_token_ids: vec![151643, 151645],
        };
        // The ids the export's prompt.py hard-codes for the role words.
        let roles = RoleTokens {
            system: vec![9125],
            user: vec![882],
            assistant: vec![77091],
            newline: vec![198],
        };
        let ids = build_prompt_ids(&special, &roles, 3);
        assert_eq!(
            ids,
            vec![
                151644, 9125, 198, 151645, 198, // <|im_start|>system\n<|im_end|>\n
                151644, 882, 198, 151669, // <|im_start|>user\n<|audio_start|>
                151676, 151676, 151676, // <|audio_pad|> x3
                151670, 151645, 198, // <|audio_end|><|im_end|>\n
                151644, 77091, 198, // <|im_start|>assistant\n
            ]
        );
        // audio_offset is the first pad's index in this sequence.
        assert_eq!(
            ids.iter().position(|id| *id == special.audio_pad_token_id),
            Some(9)
        );
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn token_cap_scales_with_audio_and_stays_bounded() {
        assert_eq!(max_new_tokens_for_audio(0.0), QWEN3_ASR_MIN_NEW_TOKENS);
        assert_eq!(max_new_tokens_for_audio(1.0), QWEN3_ASR_MIN_NEW_TOKENS);
        // 44 s * 12/s + 16 headroom: comfortably above the ~180 tokens the
        // eval generates for the fixture, far below the old fixed 512 for a
        // 10-minute dictation that would have been silently cut.
        assert_eq!(max_new_tokens_for_audio(44.0), 544);
        assert_eq!(max_new_tokens_for_audio(60.0), 736);
        assert_eq!(
            max_new_tokens_for_audio(600.0),
            QWEN3_ASR_MAX_NEW_TOKENS_CEILING
        );
        assert!(max_new_tokens_for_audio(f64::NAN) >= QWEN3_ASR_MIN_NEW_TOKENS);
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn decode_budget_has_a_floor_and_scales_with_audio() {
        assert_eq!(decode_budget_for_audio(1.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(60.0), Duration::from_secs(240));
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
    fn a_decode_that_hits_its_cap_is_an_error_not_a_transcript() {
        let message = decode_stop_error(DecodeStop::TokenCap, 544, 544, 44.0).to_string();
        assert!(message.contains("544-token cap"), "{message}");
        assert!(message.contains("truncated"), "{message}");
        let message = decode_stop_error(DecodeStop::Cancelled, 12, 544, 44.0).to_string();
        assert!(message.contains("cancelled"), "{message}");
        let message = decode_stop_error(DecodeStop::DeadlineExceeded, 12, 544, 44.0).to_string();
        assert!(message.contains("176 s budget"), "{message}");
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn long_audio_splits_at_a_pause_and_covers_every_sample() {
        let rate = QWEN3_ASR_SAMPLE_RATE;
        let seconds = 100.0;
        let total = (rate as f64 * seconds) as usize;
        // A steady tone stands in for speech; half a second of silence at
        // 55.0-55.5 s is the only pause inside the first 60 s window's
        // 8 s search span, so the first cut must land in it.
        let samples: Vec<f32> = (0..total)
            .map(|i| {
                let t = i as f64 / rate as f64;
                if (55.0..55.5).contains(&t) {
                    0.0
                } else {
                    (0.3 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32
                }
            })
            .collect();

        let chunks = split_audio_into_chunks(&samples, rate);
        assert_eq!(chunks.len(), 2, "100 s cuts once");
        let first_seconds = chunks[0].len() as f64 / rate as f64;
        assert!(
            (55.0..=55.5).contains(&first_seconds),
            "first cut at {first_seconds:.2} s is not inside the pause"
        );
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), total);
        let chunk_size = (rate as f64 * QWEN3_ASR_CHUNK_SECONDS) as usize;
        assert!(chunks.iter().all(|chunk| chunk.len() <= chunk_size));
        assert_eq!(chunks[0].as_slice(), &samples[..chunks[0].len()]);

        // A clip shorter than one window is not touched.
        let short = vec![0.1f32; rate as usize * 5];
        assert_eq!(split_audio_into_chunks(&short, rate), vec![short.clone()]);
        // No pause anywhere: the cut falls back to the window boundary.
        let tone: Vec<f32> = (0..rate as usize * 70)
            .map(|i| {
                (0.3 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate as f64).sin()) as f32
            })
            .collect();
        let chunks = split_audio_into_chunks(&tone, rate);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), chunk_size);
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn embed_cache_rejects_a_trailing_partial_element() {
        let config: Qwen3AsrConfig =
            serde_json::from_str(r#"{"decoder":{"hidden_size":4},"embed_tokens_dtype":"float16"}"#)
                .expect("config");
        let dir = std::env::temp_dir().join(format!("qwen3-embed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("embed_tokens.bin");

        std::fs::write(&path, vec![0u8; 2 * 4 * 3 + 1]).expect("write odd");
        let error = load_embed_cache(&path, &config).expect_err("odd byte length");
        assert!(error.to_string().contains("whole number"), "{error}");

        std::fs::write(&path, vec![0u8; 2 * 4 * 3]).expect("write even");
        let table = load_embed_cache(&path, &config).expect("even byte length");
        assert_eq!(table.shape(), &[3, 4]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writes seven files that pass the structural check (sizes, ONNX
    /// header bytes) but carry no integrity receipts.
    fn write_plausible_but_unverified_artifacts(model_dir: &Path) {
        std::fs::create_dir_all(model_dir).expect("model dir");
        let onnx = {
            let mut bytes = vec![0x08u8; 8192];
            bytes[0] = 0x08;
            bytes
        };
        for name in [
            QWEN3_ASR_LOCAL_ENCODER,
            QWEN3_ASR_LOCAL_DECODER_INIT,
            QWEN3_ASR_LOCAL_DECODER_STEP,
        ] {
            std::fs::write(model_dir.join(name), &onnx).expect("write onnx");
        }
        std::fs::write(
            model_dir.join(QWEN3_ASR_LOCAL_DECODER_WEIGHTS),
            vec![1u8; 4096],
        )
        .expect("weights");
        std::fs::write(
            model_dir.join(QWEN3_ASR_LOCAL_EMBED_TOKENS),
            vec![1u8; 4096],
        )
        .expect("embed");
        std::fs::write(
            model_dir.join(QWEN3_ASR_LOCAL_CONFIG),
            format!(
                "{{\"model_type\":\"qwen3_asr\",\"padding\":\"{}\"}}",
                "x".repeat(80)
            ),
        )
        .expect("config");
        std::fs::write(model_dir.join(QWEN3_ASR_LOCAL_TOKENIZER), vec![b'{'; 4096])
            .expect("tokenizer");
    }

    #[tokio::test]
    async fn readiness_requires_integrity_receipts_not_just_plausible_files() {
        let root = std::env::temp_dir().join(format!("qwen3-trust-{}", uuid::Uuid::new_v4()));
        let provider = Qwen3AsrProvider::with_models_root(&root, None);
        write_plausible_but_unverified_artifacts(&provider.model_dir);

        assert!(provider.has_required_files(), "structure check passes");
        assert_eq!(provider.download_status(), DownloadStatus::Downloaded);
        assert!(!provider.is_available(), "no receipts, so not ready");
        let error = provider
            .prewarm()
            .await
            .expect_err("untrusted files must not load");
        assert!(
            error.to_string().contains("integrity verification"),
            "{error}"
        );

        // The receipts the download path (or the startup migration) writes
        // after hashing are what make the same bytes trusted.
        for (_, _, _, local_name, sha256) in qwen3_asr_repo_files() {
            crate::download::record_model_integrity_receipt_for_tests(
                &provider.model_dir.join(local_name),
                sha256,
            )
            .await
            .expect("receipt");
        }
        assert!(provider.has_trusted_required_files());
        assert!(provider.is_available());

        // One swapped artifact breaks trust for the whole route.
        std::fs::write(
            provider.model_dir.join(QWEN3_ASR_LOCAL_DECODER_STEP),
            vec![0x08u8; 8192 + 1],
        )
        .expect("swap decoder_step");
        assert!(
            !provider.is_available(),
            "a swapped decoder_step is not trusted"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn language_names_map_to_codes_the_picker_understands() {
        assert_eq!(language_code_for_name("English"), "en");
        assert_eq!(language_code_for_name("Chinese"), "zh");
        assert_eq!(language_code_for_name("Japanese"), "ja");
        assert_eq!(language_code_for_name("Korean"), "ko");
        assert_eq!(language_code_for_name("Cantonese"), "yue");
        assert_eq!(language_code_for_name(" Filipino "), "fil");
        assert_eq!(language_code_for_name("Klingon"), "klingon");
        assert_eq!(QWEN3_ASR_LANGUAGES.len(), 30);
    }

    #[test]
    fn f16_conversion_known_values() {
        use crate::audio::mel::f16_bits_to_f32;
        // 1.0 in f16 = 0x3C00
        assert!((f16_bits_to_f32(0x3C00) - 1.0).abs() < 1e-6);
        // 0.0 in f16 = 0x0000
        assert_eq!(f16_bits_to_f32(0x0000), 0.0);
        // -1.0 in f16 = 0xBC00
        assert!((f16_bits_to_f32(0xBC00) - (-1.0)).abs() < 1e-6);
        // 2.0 in f16 = 0x4000
        assert!((f16_bits_to_f32(0x4000) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn qwen3_asr_artifact_max_bytes_are_bounded() {
        assert!(qwen3_asr_artifact_max_bytes(QWEN3_ASR_LOCAL_ENCODER) >= 700 * 1024 * 1024);
        assert!(qwen3_asr_artifact_max_bytes(QWEN3_ASR_LOCAL_TOKENIZER) >= 1024 * 1024);
    }

    /// Word error rate of `hypothesis` against `reference`, both normalized to
    /// lowercase words with punctuation stripped, via word-level Levenshtein
    /// distance. Test-only: it exists to score the real-audio eval below.
    fn word_error_rate(reference: &str, hypothesis: &str) -> f64 {
        fn words(text: &str) -> Vec<String> {
            text.split_whitespace()
                .map(|word| {
                    word.chars()
                        .filter(|c| c.is_alphanumeric() || *c == '\'')
                        .collect::<String>()
                        .to_lowercase()
                })
                .filter(|word| !word.is_empty())
                .collect()
        }
        let reference = words(reference);
        let hypothesis = words(hypothesis);
        if reference.is_empty() {
            return if hypothesis.is_empty() { 0.0 } else { 1.0 };
        }
        let mut previous: Vec<usize> = (0..=hypothesis.len()).collect();
        for (i, reference_word) in reference.iter().enumerate() {
            let mut current = vec![i + 1; hypothesis.len() + 1];
            for (j, hypothesis_word) in hypothesis.iter().enumerate() {
                let substitution = previous[j] + usize::from(reference_word != hypothesis_word);
                current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
            }
            previous = current;
        }
        previous[hypothesis.len()] as f64 / reference.len() as f64
    }

    #[test]
    fn word_error_rate_scores_normalized_words() {
        assert_eq!(word_error_rate("Hello, world!", "hello world"), 0.0);
        assert!((word_error_rate("a b c d", "a x c") - 0.5).abs() < 1e-9);
        assert_eq!(word_error_rate("", ""), 0.0);
    }

    /// Repo fixture path, resolved from the crate root so the test does not
    /// depend on the working directory `cargo test` happens to use.
    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures")
            .join(name)
    }

    /// Reference transcripts for the real-audio eval. Neither fixture ships
    /// a human transcript, so these are the Parakeet TDT 0.6B v3 output
    /// cross-checked against whisper.cpp base.en (the two agree on every
    /// content word); see the A4 validation record in
    /// docs/model-inventory-upgrades.md.
    const REAL_SPEECH_44S_REFERENCE: &str =
        "Plainsong is a free and open source dictation app for the Mac. It listens when you press a hot, turns your words into text on your own machine, and types them into whatever app you are using. Nothing you say ever leaves your computer. You can dictate an email in your mail client, a message in Slack, a commit message in your journal, or a note in your editor, and PlainSong will adapt its formatting to where you are typing. It also captures meetings without a bot joining the call, giving you transcripts, summaries, and action items you can search later. The goal is simple, voice input everywhere, with no account, no subscription, and no cloud in the middle. This recording exists to benchmark transcription latency against realistic continuous speech instead of a synthetic tone.";
    const LOCAL_QUALITY_GATE_REFERENCE: &str =
        "This is a Nautilus local quality gate sample with enough spoken words for verification.";

    /// Opt-in, network-bound, real-audio validation of the whole provider:
    /// download through the app's own verified path, load the int4 runtime,
    /// transcribe the repo's two speech fixtures, and score them against the
    /// references above. Prints raw model output so the language-detection
    /// prefix can be inspected, and the wall-clock latency of each run.
    ///
    /// Ignored by default because it fetches ~1.9 GiB into the real models
    /// directory and runs CPU int4 inference. Run with:
    ///
    /// ```text
    /// PLAINSONG_QWEN3_ASR_EVAL=1 cargo test --lib qwen3_asr_real_audio_eval -- --ignored --nocapture
    /// ```
    #[cfg(feature = "asr-parakeet")]
    #[tokio::test]
    #[ignore = "downloads ~1.9 GiB and runs int4 CPU inference; opt in with PLAINSONG_QWEN3_ASR_EVAL=1"]
    async fn qwen3_asr_real_audio_eval() {
        if std::env::var("PLAINSONG_QWEN3_ASR_EVAL").as_deref() != Ok("1") {
            eprintln!("PLAINSONG_QWEN3_ASR_EVAL is not 1; skipping");
            return;
        }

        let provider = Qwen3AsrProvider::new(None);
        if !provider.is_available() {
            eprintln!(
                "Qwen3-ASR not present at {}; downloading through download_models()",
                provider.model_dir.display()
            );
            let started = std::time::Instant::now();
            let last_logged = std::sync::Mutex::new(-10.0f32);
            provider
                .download_models(Box::new(move |percent| {
                    let mut last = last_logged.lock().unwrap();
                    if percent - *last >= 5.0 {
                        eprintln!("  download {percent:.1}%");
                        *last = percent;
                    }
                }))
                .await
                .expect("Qwen3-ASR download through the verified app path");
            eprintln!("download finished in {:?}", started.elapsed());
        }
        assert!(
            provider.is_available(),
            "all seven artifacts must be present"
        );

        let prewarm_started = std::time::Instant::now();
        provider.prewarm().await.expect("prewarm");
        eprintln!("cold runtime load: {:?}", prewarm_started.elapsed());

        let cases = [
            (
                "local-quality-gate.wav",
                fixture("local-quality-gate.wav"),
                LOCAL_QUALITY_GATE_REFERENCE,
            ),
            (
                "real-speech-44s.wav",
                fixture("real-speech-44s.wav"),
                REAL_SPEECH_44S_REFERENCE,
            ),
        ];
        for (label, path, reference) in cases {
            let raw_started = std::time::Instant::now();
            let never_cancelled = AtomicBool::new(false);
            let raw = run_qwen3_asr_onnx(&provider.model_dir, &path, &never_cancelled)
                .expect("raw inference");
            let raw_ms = raw_started.elapsed().as_millis();
            let raw_seconds = Qwen3AsrProvider::wav_duration_seconds(&path);
            eprintln!(
                "[{label}] raw ({raw_ms} ms, {} tokens = {:.2} tokens/s of audio, {} chunk(s)): {raw:?}",
                raw.generated_tokens,
                raw.generated_tokens as f64 / raw_seconds.max(0.001),
                raw.chunks
            );
            assert_eq!(
                raw.chunks, 1,
                "[{label}] a sub-60 s fixture decodes in one chunk"
            );
            assert_eq!(
                raw.language.as_deref(),
                Some("English"),
                "[{label}] expected English to be auto-detected, got: {raw:?}"
            );

            let result_started = std::time::Instant::now();
            let result = provider.transcribe(&path).await.expect("transcribe");
            let result_ms = result_started.elapsed().as_millis();
            let audio_seconds = Qwen3AsrProvider::wav_duration_seconds(&path);
            eprintln!(
                "[{label}] text ({result_ms} ms, {audio_seconds:.1} s audio, RTF {:.2}, language {}): {}",
                result_ms as f64 / 1000.0 / audio_seconds,
                result.language,
                result.text
            );
            assert!(!result.text.trim().is_empty(), "[{label}] empty transcript");
            assert_eq!(result.language, "en", "[{label}] language code");

            let env_key = format!(
                "PLAINSONG_QWEN3_ASR_REF_{}",
                label
                    .trim_end_matches(".wav")
                    .replace('-', "_")
                    .to_uppercase()
            );
            let reference = std::env::var(env_key).unwrap_or_else(|_| reference.to_string());
            if !reference.trim().is_empty() {
                let wer = word_error_rate(&reference, &result.text);
                eprintln!("[{label}] WER vs reference: {:.1}%", wer * 100.0);
                assert!(
                    wer <= 0.15,
                    "[{label}] WER {:.1}% exceeds the 15% acceptance bar",
                    wer * 100.0
                );
            }
        }

        // Long audio takes the chunked path: the 44 s fixture twice with a
        // second of silence between is 89 s, so it must decode as two
        // pause-aligned chunks and still match the doubled reference.
        {
            let source = fixture("real-speech-44s.wav");
            let mut reader = hound::WavReader::open(&source).expect("open fixture");
            let spec = reader.spec();
            let samples: Vec<i16> = reader
                .samples::<i16>()
                .map(|sample| sample.expect("fixture sample"))
                .collect();
            let doubled_path = std::env::temp_dir()
                .join(format!("qwen3-eval-doubled-{}.wav", uuid::Uuid::new_v4()));
            let mut writer = hound::WavWriter::create(&doubled_path, spec).expect("create wav");
            for sample in &samples {
                writer.write_sample(*sample).expect("write");
            }
            for _ in 0..spec.sample_rate {
                writer.write_sample(0i16).expect("write silence");
            }
            for sample in &samples {
                writer.write_sample(*sample).expect("write");
            }
            writer.finalize().expect("finalize");

            let started = std::time::Instant::now();
            let raw =
                run_qwen3_asr_onnx(&provider.model_dir, &doubled_path, &AtomicBool::new(false))
                    .expect("chunked inference");
            eprintln!(
                "[doubled 44s] ({} ms, {} chunks, {} tokens): {}",
                started.elapsed().as_millis(),
                raw.chunks,
                raw.generated_tokens,
                raw.text
            );
            let _ = std::fs::remove_file(&doubled_path);
            assert_eq!(raw.chunks, 2, "89 s of audio must split into two chunks");
            if !REAL_SPEECH_44S_REFERENCE.trim().is_empty() {
                let doubled_reference =
                    format!("{REAL_SPEECH_44S_REFERENCE} {REAL_SPEECH_44S_REFERENCE}");
                let wer = word_error_rate(&doubled_reference, &raw.text);
                eprintln!(
                    "[doubled 44s] WER vs doubled reference: {:.1}%",
                    wer * 100.0
                );
                assert!(wer <= 0.15, "[doubled 44s] WER {:.1}%", wer * 100.0);
            }
        }

        // Optional spot checks in other languages: colon-separated WAV paths
        // whose raw output (language tag + text) is printed, never asserted,
        // because they are operator-supplied and have no reference here.
        if let Ok(extra) = std::env::var("PLAINSONG_QWEN3_ASR_EXTRA_WAVS") {
            for path in extra.split(':').filter(|path| !path.is_empty()) {
                let path = Path::new(path);
                let started = std::time::Instant::now();
                match run_qwen3_asr_onnx(&provider.model_dir, path, &AtomicBool::new(false)) {
                    Ok(raw) => eprintln!(
                        "[extra {}] raw ({} ms, {:.1} s audio): {raw:?}",
                        path.display(),
                        started.elapsed().as_millis(),
                        Qwen3AsrProvider::wav_duration_seconds(path)
                    ),
                    Err(error) => eprintln!("[extra {}] failed: {error:#}", path.display()),
                }
            }
        }
    }

    #[test]
    fn qwen3_asr_model_integrity_artifacts_pinned_with_hashes() {
        let temp = std::env::temp_dir().join("qwen3_integrity_test");
        let artifacts = model_integrity_artifacts(&temp);
        // All 7 files now have pinned SHA256 hashes, so all should be returned
        assert_eq!(artifacts.len(), 7);
        // Every hash should be a 64-char hex string
        for (path, hash) in &artifacts {
            assert_eq!(hash.len(), 64, "hash for {:?} is not 64 chars", path);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }
}
