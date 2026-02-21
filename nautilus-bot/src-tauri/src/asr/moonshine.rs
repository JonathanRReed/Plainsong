use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// UsefulSensors Moonshine Base — native ONNX inference, no Python required.
// Uses the official ONNX export: encode.onnx + uncached_decode.onnx.
// Input: raw 16 kHz f32 PCM (no mel preprocessing — Moonshine operates on
// raw waveform directly). Tokenizer: SentencePiece BPE (32 768 tokens).
// ---------------------------------------------------------------------------
const MOONSHINE_MODEL_ID: &str = "moonshine-base";
const MOONSHINE_HF_REPO: &str = "UsefulSensors/moonshine";

/// ONNX files and tokenizer shipped in the UsefulSensors/moonshine HF repo.
const MOONSHINE_ENCODER_FILE: &str = "moonshine/base/encode.onnx";
const MOONSHINE_DECODER_FILE: &str = "moonshine/base/uncached_decode.onnx";
const MOONSHINE_TOKENIZER_FILE: &str = "moonshine/base/tokenizer.json";

/// Local filenames stored in the model dir.
const MOONSHINE_LOCAL_ENCODER: &str = "encode.onnx";
const MOONSHINE_LOCAL_DECODER: &str = "uncached_decode.onnx";
const MOONSHINE_LOCAL_TOKENIZER: &str = "tokenizer.json";

/// BOS / EOS token IDs for the Moonshine tokenizer (only used in ONNX path).
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_BOS: u32 = 1;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_EOS: u32 = 2;
#[cfg(feature = "asr-parakeet")]
const MOONSHINE_MAX_TOKENS: usize = 448;

pub struct MoonshineProvider {
    model_dir: PathBuf,
}

impl MoonshineProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("moonshine");
        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        self.model_dir.join(MOONSHINE_LOCAL_ENCODER).exists()
            && self.model_dir.join(MOONSHINE_LOCAL_DECODER).exists()
            && self.model_dir.join(MOONSHINE_LOCAL_TOKENIZER).exists()
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

impl Default for MoonshineProvider {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Native ONNX inference (feature-gated via asr-parakeet since it shares ort)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn run_moonshine_onnx(model_dir: &Path, audio_path: &Path) -> Result<String> {
    use ndarray::{Array, IxDyn};
    use ort::session::builder::GraphOptimizationLevel;
    use ort::session::Session;
    use ort::value::Tensor;
    use tokenizers::Tokenizer;

    // -----------------------------------------------------------------
    // 1. Load 16 kHz mono f32 samples (Moonshine takes raw waveform)
    // -----------------------------------------------------------------
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Moonshine")?;

    if samples.is_empty() {
        return Ok(String::new());
    }

    // -----------------------------------------------------------------
    // 2. Run encoder: input shape [1, n_samples]
    // -----------------------------------------------------------------
    let n = samples.len();
    let audio_arr: Array<f32, IxDyn> = Array::from_shape_vec(IxDyn(&[1, n]), samples)
        .context("Failed to build Moonshine audio array")?;

    let mut encoder = Session::builder()
        .context("Failed to create Moonshine encoder builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("Failed to set optimization level")?
        .commit_from_file(model_dir.join(MOONSHINE_LOCAL_ENCODER))
        .context("Failed to load Moonshine encoder ONNX")?;

    let audio_tensor =
        Tensor::from_array(audio_arr).context("Failed to create Moonshine audio tensor")?;

    let enc_outputs = encoder
        .run(ort::inputs!["audio" => audio_tensor])
        .context("Moonshine encoder inference failed")?;

    // Context shape: [1, seq_len, hidden_size]
    let context_array = enc_outputs[0]
        .try_extract_array::<f32>()
        .context("Failed to extract Moonshine encoder context")?;
    let context_shape = context_array.shape().to_vec();
    let context_data: Vec<f32> = context_array.iter().copied().collect();

    // -----------------------------------------------------------------
    // 3. Load tokenizer
    // -----------------------------------------------------------------
    let tokenizer = Tokenizer::from_file(model_dir.join(MOONSHINE_LOCAL_TOKENIZER))
        .map_err(|e| anyhow::anyhow!("Failed to load Moonshine tokenizer: {}", e))?;

    // -----------------------------------------------------------------
    // 4. Autoregressive decode using uncached_decode.onnx
    //    inputs: token_ids [1, n_tokens] int32, audio_context [1, S, H]
    //    output: logits [1, n_tokens, vocab_size]
    // -----------------------------------------------------------------
    let mut decoder = Session::builder()
        .context("Failed to create Moonshine decoder builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("Failed to set decoder optimization level")?
        .commit_from_file(model_dir.join(MOONSHINE_LOCAL_DECODER))
        .context("Failed to load Moonshine decoder ONNX")?;

    let mut token_ids: Vec<u32> = vec![MOONSHINE_BOS];

    for _ in 0..MOONSHINE_MAX_TOKENS {
        let n_tokens = token_ids.len();

        // Build token_ids tensor [1, n_tokens] as i32
        let token_i32: Vec<i32> = token_ids.iter().map(|&t| t as i32).collect();
        let token_arr: Array<i32, IxDyn> = Array::from_shape_vec(IxDyn(&[1, n_tokens]), token_i32)
            .context("Failed to build Moonshine token array")?;

        // Rebuild context tensor from stored data + shape
        let ctx_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&context_shape), context_data.clone())
                .context("Failed to rebuild Moonshine context array")?;

        let token_tensor =
            Tensor::from_array(token_arr).context("Failed to create token tensor")?;
        let ctx_tensor = Tensor::from_array(ctx_arr).context("Failed to create context tensor")?;

        let dec_outputs = decoder
            .run(ort::inputs![
                "token_ids" => token_tensor,
                "audio_context" => ctx_tensor
            ])
            .context("Moonshine decoder inference failed")?;

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
            .map(|(i, _)| i as u32)
            .unwrap_or(MOONSHINE_EOS);

        if next_token == MOONSHINE_EOS {
            break;
        }
        token_ids.push(next_token);
    }

    // Decode tokens (skip BOS)
    let output_ids: Vec<u32> = token_ids[1..].to_vec();
    let text = tokenizer
        .decode(&output_ids, true)
        .map_err(|e| anyhow::anyhow!("Moonshine tokenizer decode failed: {}", e))?;

    Ok(text.trim().to_string())
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
        "UsefulSensors Moonshine Base — native ONNX, ultra-low latency, English only, no Python."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Moonshine Base".to_string(),
            version: "base".to_string(),
            size_mb: 246.0,
            parameters: "61M".to_string(),
            languages: vec!["en".to_string()],
            word_error_rate: Some(4.0),
            real_time_factor: Some(0.3),
            license: "MIT".to_string(),
            source_url: format!("https://huggingface.co/{}", MOONSHINE_HF_REPO),
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
        let audio_path_owned = audio_path.to_path_buf();
        let audio_for_dur = audio_path_owned.clone();

        let text =
            tokio::task::spawn_blocking(move || run_moonshine_onnx(&model_dir, &audio_path_owned))
                .await
                .context("Moonshine inference task panicked")??;

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
            model_name: "moonshine-base".to_string(),
            model_id: MOONSHINE_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::Moonshine,
            actual_provider: AsrProviderType::Moonshine,
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

        let files = [
            (MOONSHINE_ENCODER_FILE, MOONSHINE_LOCAL_ENCODER),
            (MOONSHINE_DECODER_FILE, MOONSHINE_LOCAL_DECODER),
            (MOONSHINE_TOKENIZER_FILE, MOONSHINE_LOCAL_TOKENIZER),
        ];
        let n_files = files.len() as f32;

        for (i, (hf_path, local_name)) in files.into_iter().enumerate() {
            let destination = self.model_dir.join(local_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                MOONSHINE_HF_REPO, hf_path
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &destination, move |p| {
                    cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                    tracing::info!("Moonshine {} download: {:.1}%", local_name, p.percentage);
                })
                .await?;
        }

        tracing::info!("Moonshine model downloaded successfully");
        Ok(())
    }
}
