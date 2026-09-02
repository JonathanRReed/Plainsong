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
//! # Performance (0.6B int4, CPU)
//!
//! - WER: 5.16% (LibriSpeech test-other) vs Parakeet TDT 0.6B INT8 at 5.45%
//! - RTF: 0.17x (faster than real-time)
//! - Model size: ~1.3 GB compressed (int4 variant)
//!
//! # Status
//!
//! The encoder + decoder_init (prefill) and autoregressive decoder_step loop
//! with KV cache threading are implemented. The decoder loop threads
//! present_keys/present_values outputs from decoder_init into past_keys/
//! past_values inputs for decoder_step by layer index, running until EOS or
//! the token cap is reached.
//!
//! The implementation is not yet validated with real audio — transcription
//! is gated out of active use (`is_provider_transcription_enabled` returns
//! false) until end-to-end testing confirms correct output.

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
#[cfg(feature = "asr-parakeet")]
use std::sync::{Mutex, OnceLock};

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

/// Maximum decoder tokens to generate (caps KV cache growth).
/// 512 tokens is sufficient for ~60s of typical English audio.
#[cfg(feature = "asr-parakeet")]
const QWEN3_ASR_MAX_TOKENS: usize = 512;

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

#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize, Default)]
#[allow(dead_code)]
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

#[cfg(feature = "asr-parakeet")]
#[derive(serde::Deserialize, Default)]
#[allow(dead_code)]
struct SpecialTokens {
    #[serde(default)]
    pad_token_id: i64,
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
    #[serde(default)]
    eos_token_ids: Vec<i64>,
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
// Mel spectrogram computation (128-bin log-mel, matching Qwen3-ASR config)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn compute_log_mel_spectrogram(
    samples: &[f32],
    fmin: f32,
    fmax: f32,
) -> Result<ndarray::Array3<f32>> {
    use rustfft::FftPlanner;
    use std::f32::consts::PI;

    let n_fft = QWEN3_ASR_N_FFT;
    let hop = QWEN3_ASR_HOP_LENGTH;
    let n_mels = QWEN3_ASR_N_MELS;
    let sample_rate = QWEN3_ASR_SAMPLE_RATE as f32;

    // Hann window
    let window: Vec<f64> = (0..n_fft)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / n_fft as f32).cos() as f64)
        .collect();

    let mel_bank =
        crate::audio::mel::create_mel_filterbank_ln(n_fft, sample_rate, n_mels, fmin, fmax);

    let num_frames = if samples.len() < n_fft {
        1
    } else {
        (samples.len() - n_fft) / hop + 1
    };

    let mut all_features = Vec::with_capacity(num_frames * n_mels);
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n_fft);

    for frame_idx in 0..num_frames {
        let start = frame_idx * hop;
        let end = (start + n_fft).min(samples.len());

        let mut buffer: Vec<rustfft::num_complex::Complex<f64>> = (0..n_fft)
            .map(|i| {
                if start + i < end {
                    rustfft::num_complex::Complex::new(samples[start + i] as f64 * window[i], 0.0)
                } else {
                    rustfft::num_complex::Complex::new(0.0, 0.0)
                }
            })
            .collect();
        fft.process(&mut buffer);

        let power_spectrum: Vec<f64> = buffer[..n_fft / 2 + 1]
            .iter()
            .map(|c| (c.norm_sqr() / n_fft as f64).max(1e-10))
            .collect();

        for mel_bank_row in &mel_bank {
            let mut mel_energy = 0.0f64;
            for (bin_idx, &weight) in mel_bank_row.iter().enumerate() {
                if bin_idx < power_spectrum.len() {
                    mel_energy += power_spectrum[bin_idx] * weight;
                }
            }
            all_features.push((mel_energy + 1e-10).ln() as f32);
        }
    }

    // CMVN (mean normalization per mel bin)
    let num_features = all_features.len() / n_mels;
    if num_features > 0 {
        let mut means = vec![0.0f32; n_mels];
        for frame_idx in 0..num_features {
            for (mel_idx, mean) in means.iter_mut().enumerate() {
                *mean += all_features[frame_idx * n_mels + mel_idx];
            }
        }
        for mean in &mut means {
            *mean /= num_features as f32;
        }
        for frame_idx in 0..num_features {
            for (mel_idx, mean) in means.iter().enumerate() {
                all_features[frame_idx * n_mels + mel_idx] -= mean;
            }
        }
    }

    ndarray::Array3::from_shape_vec((1, num_features, n_mels), all_features)
        .context("Failed to shape Qwen3-ASR mel spectrogram")
}

// ---------------------------------------------------------------------------
// Prompt building and inference
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn build_prompt_ids(special: &SpecialTokens, audio_token_count: usize) -> Vec<i64> {
    let mut ids = Vec::with_capacity(audio_token_count + 8);
    ids.push(special.im_start_token_id);
    ids.push(special.audio_start_token_id);
    ids.extend(std::iter::repeat_n(
        special.audio_pad_token_id,
        audio_token_count,
    ));
    ids.push(special.audio_end_token_id);
    ids.push(special.im_end_token_id);
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

#[cfg(feature = "asr-parakeet")]
fn argmax_slice(logits: &ndarray::Array<f32, ndarray::IxDyn>, position: usize) -> Result<i64> {
    let shape = logits.shape();
    let vocab_size = *shape.last().unwrap_or(&1);
    let flat: Vec<f32> = logits.iter().copied().collect();
    let offset = position * vocab_size;
    if offset + vocab_size > flat.len() {
        return Err(anyhow::anyhow!(
            "argmax: position {} + vocab {} exceeds logits len {}",
            position,
            vocab_size,
            flat.len()
        ));
    }
    let slice = &flat[offset..offset + vocab_size];
    Ok(slice
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i as i64)
        .unwrap_or(0))
}

#[cfg(feature = "asr-parakeet")]
fn run_qwen3_asr_onnx(model_dir: &Path, audio_path: &Path) -> Result<String> {
    use ndarray::{Array1, Array2};
    use ort::value::Tensor;

    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Qwen3-ASR")?;

    if samples.is_empty() {
        return Ok(String::new());
    }

    let model_dir_key = model_dir.to_string_lossy().to_string();
    {
        let mut cache = runtime_cache().lock().map_err(|error| {
            anyhow::anyhow!("Qwen3-ASR runtime cache is unavailable: {}", error)
        })?;
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

        // 1. Compute mel spectrogram
        let mel =
            compute_log_mel_spectrogram(&samples, runtime.config.mel.fmin, runtime.config.mel.fmax)
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
        let prompt_ids = build_prompt_ids(&runtime.config.special_tokens, audio_token_count);
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
            return Ok(decode_tokens(&runtime.tokenizer, &output_tokens));
        }

        // 5. Autoregressive decode loop with KV cache threading.
        //
        // decoder_step accepts:
        //   input_embeds  [1, 1, hidden_size]  f32
        //   position_ids  [1]                  i64
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

        for _ in 1..QWEN3_ASR_MAX_TOKENS {
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
            let pos_arr = Array1::from_elem(1, pos);
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
                break;
            }
            output_tokens.push(next_token);
            current_token = next_token;
            pos += 1;
        }

        Ok(decode_tokens(&runtime.tokenizer, &output_tokens))
    }
}

#[cfg(feature = "asr-parakeet")]
fn decode_tokens(tokenizer: &tokenizers::Tokenizer, token_ids: &[i64]) -> String {
    let ids: Vec<u32> = token_ids.iter().map(|&id| id as u32).collect();
    tokenizer.decode(&ids, true).unwrap_or_default()
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_qwen3_asr_onnx(_model_dir: &Path, _audio_path: &Path) -> Result<String> {
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
        let model_id = selected_model_id.unwrap_or(QWEN3_ASR_MODEL_ID).to_string();
        let root_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        let model_dir = root_dir.join("qwen3_asr");
        Self {
            model_dir,
            model_id,
        }
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
        "Alibaba Qwen3-ASR 0.6B, native ONNX, multilingual (30+ languages), int4 quantized, no Python."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        if !self.has_required_files() {
            anyhow::bail!(
                "Qwen3-ASR model is not downloaded. Use the model manager to download it."
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
            size_mb: 1300.0,
            parameters: "0.6B".to_string(),
            languages: vec![
                "en".to_string(),
                "zh".to_string(),
                "ja".to_string(),
                "ko".to_string(),
                "fr".to_string(),
                "es".to_string(),
                "de".to_string(),
                "it".to_string(),
                "pt".to_string(),
                "ru".to_string(),
                "ar".to_string(),
                "hi".to_string(),
            ],
            word_error_rate: Some(5.16),
            real_time_factor: Some(0.17),
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

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_for_dur = audio_path.to_path_buf();
        let audio_path_owned = audio_path.to_path_buf();

        let raw_text =
            tokio::task::spawn_blocking(move || run_qwen3_asr_onnx(&model_dir, &audio_path_owned))
                .await
                .context("Qwen3-ASR inference task panicked")??;

        let text = strip_language_prefix(&raw_text);
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
            language: "auto".to_string(),
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
