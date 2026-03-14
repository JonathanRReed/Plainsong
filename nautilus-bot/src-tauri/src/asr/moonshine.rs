use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
#[cfg(feature = "asr-parakeet")]
use std::{cell::RefCell, thread_local};

// ---------------------------------------------------------------------------
// UsefulSensors Moonshine — native ONNX inference, no Python required.
// Uses the official merged ONNX export: encoder_model.onnx + decoder_model_merged.onnx.
// Input: raw 16 kHz f32 PCM (no mel preprocessing — Moonshine operates on
// raw waveform directly). Tokenizer: SentencePiece BPE (32 768 tokens).
// ---------------------------------------------------------------------------
const MOONSHINE_BASE_MODEL_ID: &str = "moonshine-base";
const MOONSHINE_TINY_MODEL_ID: &str = "moonshine-tiny";
const MOONSHINE_ONNX_HF_REPO: &str = "UsefulSensors/moonshine";
const MOONSHINE_TINY_HF_REPO: &str = "UsefulSensors/moonshine-tiny";
const MOONSHINE_BASE_HF_REPO: &str = "UsefulSensors/moonshine-base";

/// ONNX files and tokenizer shipped in the UsefulSensors/moonshine HF repo.
const MOONSHINE_LOCAL_ENCODER: &str = "encoder_model.onnx";
const MOONSHINE_LOCAL_DECODER: &str = "decoder_model_merged.onnx";
const MOONSHINE_LOCAL_TOKENIZER: &str = "tokenizer.json";

/// BOS / EOS token IDs for the Moonshine tokenizer (only used in ONNX path).
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_BOS: i64 = 1;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_EOS: i64 = 2;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_MAX_TOKENS: usize = 192;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_NUM_LAYERS: usize = 8;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_NUM_KEY_VALUE_HEADS: usize = 8;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_HEAD_DIM: usize = 52;

#[cfg(feature = "asr-parakeet")]
struct MoonshineRuntime {
    model_dir_key: String,
    encoder: ort::session::Session,
    decoder: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
}

#[cfg(feature = "asr-parakeet")]
fn load_runtime(model_dir: &Path) -> Result<MoonshineRuntime> {
    use ort::session::Session;
    use tokenizers::Tokenizer;

    let encoder = Session::builder()
        .context("Failed to create Moonshine encoder builder")?
        .commit_from_file(model_dir.join(MOONSHINE_LOCAL_ENCODER))
        .context("Failed to load Moonshine encoder ONNX")?;

    let decoder = Session::builder()
        .context("Failed to create Moonshine decoder builder")?
        .commit_from_file(model_dir.join(MOONSHINE_LOCAL_DECODER))
        .context("Failed to load Moonshine decoder ONNX")?;

    let tokenizer = Tokenizer::from_file(model_dir.join(MOONSHINE_LOCAL_TOKENIZER))
        .map_err(|e| anyhow::anyhow!("Failed to load Moonshine tokenizer: {}", e))?;

    Ok(MoonshineRuntime {
        model_dir_key: model_dir.to_string_lossy().to_string(),
        encoder,
        decoder,
        tokenizer,
    })
}

#[cfg(feature = "asr-parakeet")]
thread_local! {
    static RUNTIME_CACHE: RefCell<Option<MoonshineRuntime>> = const { RefCell::new(None) };
}

#[cfg(feature = "asr-parakeet")]
pub(crate) fn clear_cached_runtime(model_dir: &Path) {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    RUNTIME_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache
            .as_ref()
            .map(|runtime| runtime.model_dir_key == model_dir_key)
            .unwrap_or(false)
        {
            *cache = None;
            tracing::info!(
                "Cleared cached Moonshine runtime for {}",
                model_dir.display()
            );
        }
    });
}

#[cfg(not(feature = "asr-parakeet"))]
pub(crate) fn clear_cached_runtime(_model_dir: &Path) {}

pub struct MoonshineProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl MoonshineProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let model_id =
            normalize_moonshine_model_id(selected_model_id.unwrap_or(MOONSHINE_BASE_MODEL_ID));
        let root_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models");
        let model_dir = if model_id == MOONSHINE_BASE_MODEL_ID {
            root_dir.join("moonshine")
        } else {
            root_dir.join("moonshine_tiny")
        };
        Self {
            model_dir,
            model_id,
        }
    }

    fn has_required_files(&self) -> bool {
        is_valid_onnx_file(&self.model_dir.join(MOONSHINE_LOCAL_ENCODER))
            && is_valid_onnx_file(&self.model_dir.join(MOONSHINE_LOCAL_DECODER))
            && is_valid_tokenizer_file(&self.model_dir.join(MOONSHINE_LOCAL_TOKENIZER))
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

fn is_valid_onnx_file(path: &Path) -> bool {
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
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

fn is_valid_tokenizer_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 1024 {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok()
}

impl Default for MoonshineProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

fn normalize_moonshine_model_id(model_id: &str) -> String {
    match model_id.trim() {
        "moonshine" | MOONSHINE_BASE_MODEL_ID => MOONSHINE_BASE_MODEL_ID.to_string(),
        MOONSHINE_TINY_MODEL_ID => MOONSHINE_TINY_MODEL_ID.to_string(),
        _ => MOONSHINE_BASE_MODEL_ID.to_string(),
    }
}

fn moonshine_repo_files(model_id: &str) -> [(&'static str, &'static str, &'static str); 3] {
    match model_id {
        MOONSHINE_TINY_MODEL_ID => [
            (
                MOONSHINE_ONNX_HF_REPO,
                "onnx/merged/tiny/float/encoder_model.onnx",
                MOONSHINE_LOCAL_ENCODER,
            ),
            (
                MOONSHINE_ONNX_HF_REPO,
                "onnx/merged/tiny/float/decoder_model_merged.onnx",
                MOONSHINE_LOCAL_DECODER,
            ),
            (
                MOONSHINE_TINY_HF_REPO,
                "tokenizer.json",
                MOONSHINE_LOCAL_TOKENIZER,
            ),
        ],
        _ => [
            (
                MOONSHINE_ONNX_HF_REPO,
                "onnx/merged/base/float/encoder_model.onnx",
                MOONSHINE_LOCAL_ENCODER,
            ),
            (
                MOONSHINE_ONNX_HF_REPO,
                "onnx/merged/base/float/decoder_model_merged.onnx",
                MOONSHINE_LOCAL_DECODER,
            ),
            (
                MOONSHINE_BASE_HF_REPO,
                "tokenizer.json",
                MOONSHINE_LOCAL_TOKENIZER,
            ),
        ],
    }
}

// ---------------------------------------------------------------------------
// Native ONNX inference (feature-gated via asr-parakeet since it shares ort)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn run_moonshine_onnx(model_dir: &Path, audio_path: &Path) -> Result<String> {
    use ndarray::{Array, IxDyn};
    use ort::value::Tensor;

    // -----------------------------------------------------------------
    // 1. Load 16 kHz mono f32 samples (Moonshine takes raw waveform)
    // -----------------------------------------------------------------
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Moonshine")?;

    if samples.is_empty() {
        return Ok(String::new());
    }

    let model_dir_key = model_dir.to_string_lossy().to_string();
    RUNTIME_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let should_reload = cache
            .as_ref()
            .map(|runtime| runtime.model_dir_key != model_dir_key)
            .unwrap_or(true);
        if should_reload {
            *cache = Some(load_runtime(model_dir)?);
        }
        let runtime = cache
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Moonshine runtime cache unavailable"))?;

        let encoder = &mut runtime.encoder;
        let decoder = &mut runtime.decoder;

        // -----------------------------------------------------------------
        // 3. Run encoder: input shape [1, n_samples]
        // -----------------------------------------------------------------
        let n = samples.len();
        let audio_arr: Array<f32, IxDyn> = Array::from_shape_vec(IxDyn(&[1, n]), samples)
            .context("Failed to build Moonshine audio array")?;
        let audio_tensor =
            Tensor::from_array(audio_arr).context("Failed to create Moonshine audio tensor")?;
        let attention_mask_arr: Array<i64, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, n]), vec![1; n])
                .context("Failed to build Moonshine attention mask")?;
        let attention_mask_tensor = Tensor::from_array(attention_mask_arr)
            .context("Failed to create Moonshine attention mask tensor")?;

        let encoder_input_names: HashSet<String> = encoder
            .inputs()
            .iter()
            .map(|input| input.name().to_string())
            .collect();
        if !encoder_input_names.contains("input_values") {
            return Err(anyhow::anyhow!(
                "Unsupported Moonshine encoder inputs: {:?}",
                encoder_input_names
            ));
        }

        let mut encoder_inputs = ort::inputs!["input_values" => audio_tensor];
        if encoder_input_names.contains("attention_mask") {
            encoder_inputs.push(("attention_mask".into(), attention_mask_tensor.into()));
        }

        let enc_outputs = encoder
            .run(encoder_inputs)
            .context("Moonshine encoder inference failed")?;

        // Context shape: [1, seq_len, hidden_size]
        let _context_array = enc_outputs[0]
            .try_extract_array::<f32>()
            .context("Failed to extract Moonshine encoder context")?;

        // -----------------------------------------------------------------
        // 5. Autoregressive decode using decoder_model_merged.onnx
        // -----------------------------------------------------------------
        let decoder_input_names_ordered = decoder
            .inputs()
            .iter()
            .map(|input| input.name().to_string())
            .collect::<Vec<_>>();
        let decoder_output_names = decoder
            .outputs()
            .iter()
            .map(|output| output.name().to_string())
            .collect::<Vec<_>>();
        let decoder_input_names: HashSet<String> =
            decoder_input_names_ordered.iter().cloned().collect();
        for required in ["input_ids", "encoder_hidden_states", "use_cache_branch"] {
            if !decoder_input_names.contains(required) {
                return Err(anyhow::anyhow!(
                    "Unsupported Moonshine decoder inputs: missing '{}' in {:?}",
                    required,
                    decoder_input_names
                ));
            }
        }
        let needs_encoder_attention_mask = decoder_input_names.contains("encoder_attention_mask");

        let past_key_names = decoder_input_names_ordered
            .iter()
            .filter(|name| name.starts_with("past_key_values."))
            .cloned()
            .collect::<Vec<_>>();
        let past_key_indices = past_key_names
            .iter()
            .enumerate()
            .map(|(idx, name)| (name.clone(), idx))
            .collect::<HashMap<_, _>>();

        let enc_mask_arr: Array<i64, IxDyn> = Array::from_shape_vec(IxDyn(&[1, n]), vec![1; n])
            .context("Failed to build mask array")?;
        let enc_mask_tensor = Tensor::from_array(enc_mask_arr)
            .context("Failed to create Moonshine encoder attention mask tensor")?;

        let mut token_ids: Vec<i64> = vec![MOONSHINE_BOS];
        let mut past_arrays: Vec<Array<f32, IxDyn>> = past_key_names
            .iter()
            .map(|_| {
                Array::zeros(IxDyn(&[
                    0,
                    MOONSHINE_NUM_KEY_VALUE_HEADS,
                    1,
                    MOONSHINE_HEAD_DIM,
                ]))
            })
            .collect();
        if !past_key_names.is_empty() && past_key_names.len() != MOONSHINE_NUM_LAYERS * 4 {
            tracing::warn!(
                "Unexpected Moonshine past key tensor count: {}",
                past_key_names.len()
            );
        }

        let max_decode_steps = moonshine_max_tokens_for_audio(n);
        for step in 0..max_decode_steps {
            let use_cache_branch = step > 0;
            let input_ids_values = if use_cache_branch {
                vec![*token_ids.last().unwrap_or(&MOONSHINE_BOS)]
            } else {
                token_ids.clone()
            };
            let n_tokens = input_ids_values.len();

            let input_ids_arr: Array<i64, IxDyn> =
                Array::from_shape_vec(IxDyn(&[1, n_tokens]), input_ids_values)
                    .context("Failed to build Moonshine input_ids")?;
            let input_ids_tensor = Tensor::from_array(input_ids_arr)
                .context("Failed to create Moonshine input_ids tensor")?;
            let use_cache_arr: Array<bool, IxDyn> =
                Array::from_shape_vec(IxDyn(&[1]), vec![use_cache_branch])
                    .context("Failed to build Moonshine use_cache_branch tensor")?;
            let use_cache_tensor = Tensor::from_array(use_cache_arr)
                .context("Failed to create Moonshine use_cache_branch tensor")?;

            let mut decoder_inputs = ort::inputs![
                "input_ids" => input_ids_tensor,
                "encoder_hidden_states" => &enc_outputs[0],
                "use_cache_branch" => use_cache_tensor
            ];
            if needs_encoder_attention_mask {
                decoder_inputs.push(("encoder_attention_mask".into(), (&enc_mask_tensor).into()));
            }

            for (name, past_array) in past_key_names.iter().zip(past_arrays.iter()) {
                let tensor = Tensor::from_array(past_array.clone())
                    .context("Failed to create Moonshine past_key_values tensor")?;
                decoder_inputs.push((name.clone().into(), tensor.into()));
            }

            let dec_outputs = decoder.run(decoder_inputs).map_err(|error| {
                anyhow::anyhow!(
                    "Moonshine decoder inference failed at step {} (use_cache_branch={}, input_token_count={}): {}",
                    step,
                    use_cache_branch,
                    n_tokens,
                    error
                )
            })?;

            // logits shape: [1, n_tokens, vocab_size] — take last position
            let logits_array = dec_outputs[0]
                .try_extract_array::<f32>()
                .context("Failed to extract Moonshine logits")?;
            let shape = logits_array.shape().to_vec();
            let vocab_size = *shape.last().unwrap_or(&1);
            let logits_flat: Vec<f32> = logits_array.iter().copied().collect();

            // Last token's logits = offset [(n_tokens-1) * vocab_size ..]
            let last_offset = (n_tokens - 1) * vocab_size;
            let last_logits = &logits_flat[last_offset..last_offset + vocab_size];
            let next_token = last_logits
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(i, _)| i as i64)
                .unwrap_or(MOONSHINE_EOS);

            if next_token == MOONSHINE_EOS {
                break;
            }
            token_ids.push(next_token);

            if !past_key_names.is_empty() {
                let mut updated_past = past_arrays.clone();
                for idx in 1..dec_outputs.len() {
                    let Some(output_name) = decoder_output_names.get(idx) else {
                        continue;
                    };
                    let Some(suffix) = output_name.strip_prefix("present.") else {
                        continue;
                    };
                    let past_name = format!("past_key_values.{}", suffix);
                    let Some(past_idx) = past_key_indices.get(past_name.as_str()) else {
                        continue;
                    };
                    let past_array = dec_outputs[idx]
                        .try_extract_array::<f32>()
                        .context("Failed to extract Moonshine present key/value tensor")?
                        .to_owned();
                    if past_name.contains(".encoder.")
                        && past_array.shape().first().copied().unwrap_or_default() == 0
                    {
                        // Some decoder steps return empty encoder cache placeholders; keep the
                        // last non-empty encoder cache to avoid shape regressions in later steps.
                        continue;
                    }
                    updated_past[*past_idx] = past_array;
                }
                past_arrays = updated_past;
            }
        }

        // Decode tokens (skip BOS)
        let output_ids: Vec<u32> = token_ids.iter().skip(1).map(|id| *id as u32).collect();
        if output_ids.is_empty() {
            return Ok(String::new());
        }
        let text = runtime
            .tokenizer
            .decode(&output_ids, true)
            .map_err(|e| anyhow::anyhow!("Moonshine tokenizer decode failed: {}", e))?;

        Ok(text.trim().to_string())
    })
}

#[cfg(feature = "asr-parakeet")]
fn moonshine_max_tokens_for_audio(sample_count: usize) -> usize {
    // Moonshine runs autoregressive decode; cap by utterance duration to reduce latency.
    let seconds = sample_count as f32 / 16_000.0;
    let estimated = (seconds * 5.0).ceil() as usize + 24;
    estimated.clamp(32, MOONSHINE_MAX_TOKENS)
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_moonshine_onnx(_model_dir: &Path, _audio_path: &Path) -> Result<String> {
    Err(anyhow::anyhow!(
        "Moonshine ONNX requires the `asr-parakeet` feature. Rebuild with that feature enabled."
    ))
}

// ---------------------------------------------------------------------------
// AsrProvider implementation
// ---------------------------------------------------------------------------
#[async_trait]
impl AsrProvider for MoonshineProvider {
    fn name(&self) -> &str {
        "UsefulSensors Moonshine"
    }

    fn description(&self) -> &str {
        if self.model_id == MOONSHINE_TINY_MODEL_ID {
            "UsefulSensors Moonshine Tiny — native ONNX, ultra-low latency, English only, no Python."
        } else {
            "UsefulSensors Moonshine Base — native ONNX, ultra-low latency, English only, no Python."
        }
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        if self.model_id == MOONSHINE_TINY_MODEL_ID {
            ModelInfo {
                name: "Moonshine Tiny".to_string(),
                version: "tiny".to_string(),
                size_mb: 120.0,
                parameters: "27M".to_string(),
                languages: vec!["en".to_string()],
                word_error_rate: Some(5.4),
                real_time_factor: Some(0.18),
                license: "MIT".to_string(),
                source_url: format!("https://huggingface.co/{}", MOONSHINE_BASE_HF_REPO),
            }
        } else {
            ModelInfo {
                name: "Moonshine Base".to_string(),
                version: "base".to_string(),
                size_mb: 246.0,
                parameters: "61M".to_string(),
                languages: vec!["en".to_string()],
                word_error_rate: Some(4.0),
                real_time_factor: Some(0.3),
                license: "MIT".to_string(),
                source_url: format!("https://huggingface.co/{}", MOONSHINE_TINY_HF_REPO),
            }
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Moonshine model not downloaded. Use the model manager to download it."
            ));
        }

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_for_dur = audio_path.to_path_buf();

        // VAD pre-filtering: trim silence for faster processing
        let raw_samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for Moonshine")?;

        let use_trimmed = if raw_samples.len() > 16000 {
            let trimmed = crate::audio::vad::trim_silence(&raw_samples, 16000, -40.0);
            if !trimmed.is_empty() && trimmed.len() < raw_samples.len() * 9 / 10 {
                let saved_ms = raw_samples.len().saturating_sub(trimmed.len()) as f64 / 16.0;
                if saved_ms > 100.0 {
                    tracing::info!(
                        "Moonshine: VAD trimmed {:.0}ms of silence, processing {:.0}ms",
                        saved_ms,
                        trimmed.len() as f64 / 16.0
                    );
                }
                Some(trimmed)
            } else {
                None
            }
        } else {
            None
        };

        let text = if let Some(samples) = use_trimmed {
            // Write trimmed audio to temp file
            let temp_path = std::env::temp_dir()
                .join(format!("moonshine_trimmed_{}.wav", uuid::Uuid::new_v4()));
            {
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: 16000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&temp_path, spec)
                    .context("Failed to create temp WAV for Moonshine")?;
                for sample in &samples {
                    let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                    writer
                        .write_sample(int_sample)
                        .context("Failed to write sample")?;
                }
                writer.finalize().context("Failed to finalize temp WAV")?;
            }
            let temp_path_for_cleanup = temp_path.clone();
            let result =
                tokio::task::spawn_blocking(move || run_moonshine_onnx(&model_dir, &temp_path))
                    .await
                    .context("Moonshine inference task panicked")??;
            let _ = std::fs::remove_file(&temp_path_for_cleanup);
            result
        } else {
            let audio_path_owned = audio_path.to_path_buf();
            tokio::task::spawn_blocking(move || run_moonshine_onnx(&model_dir, &audio_path_owned))
                .await
                .context("Moonshine inference task panicked")??
        };

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
            language: "en".to_string(),
            confidence: 0.9,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: self.model_id.clone(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Moonshine,
            actual_provider: AsrProviderType::Moonshine,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("moonshine_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Moonshine")?;
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
            .context("Failed to create Moonshine model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);
        let files = moonshine_repo_files(self.model_id.as_str());
        let n_files = files.len() as f32;

        for (i, (repo_id, hf_path, local_name)) in files.into_iter().enumerate() {
            let destination = self.model_dir.join(local_name);
            let is_valid = if local_name.ends_with(".onnx") {
                is_valid_onnx_file(&destination)
            } else {
                is_valid_tokenizer_file(&destination)
            };
            if is_valid {
                continue;
            }
            if destination.exists() {
                std::fs::remove_file(&destination).ok();
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                repo_id, hf_path
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &destination, move |p| {
                    cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                    tracing::info!("Moonshine {} download: {:.1}%", local_name, p.percentage);
                })
                .await?;
        }

        tracing::info!(
            "Moonshine model '{}' downloaded successfully",
            self.model_id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        moonshine_repo_files, MOONSHINE_BASE_HF_REPO, MOONSHINE_LOCAL_TOKENIZER,
        MOONSHINE_ONNX_HF_REPO, MOONSHINE_TINY_HF_REPO,
    };

    #[test]
    fn tiny_tokenizer_uses_model_specific_repo() {
        let files = moonshine_repo_files("moonshine-tiny");
        assert_eq!(files[0].0, MOONSHINE_ONNX_HF_REPO);
        assert_eq!(files[1].0, MOONSHINE_ONNX_HF_REPO);
        assert_eq!(files[2].0, MOONSHINE_TINY_HF_REPO);
        assert_eq!(files[2].1, "tokenizer.json");
        assert_eq!(files[2].2, MOONSHINE_LOCAL_TOKENIZER);
    }

    #[test]
    fn base_tokenizer_uses_model_specific_repo() {
        let files = moonshine_repo_files("moonshine-base");
        assert_eq!(files[0].0, MOONSHINE_ONNX_HF_REPO);
        assert_eq!(files[1].0, MOONSHINE_ONNX_HF_REPO);
        assert_eq!(files[2].0, MOONSHINE_BASE_HF_REPO);
        assert_eq!(files[2].1, "tokenizer.json");
        assert_eq!(files[2].2, MOONSHINE_LOCAL_TOKENIZER);
    }
}
