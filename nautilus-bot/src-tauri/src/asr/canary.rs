use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
#[cfg(feature = "asr-canary")]
use std::{cell::RefCell, thread_local};

// ---------------------------------------------------------------------------
// Model: openai/whisper-large-v3-turbo via Candle (max accuracy, no Python)
// ---------------------------------------------------------------------------
const CANARY_MODEL_ID: &str = "canary-whisper-large-v3-turbo";
const CANARY_HF_REPO: &str = "openai/whisper-large-v3-turbo";

const CANARY_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];

pub struct CanaryProvider {
    model_dir: PathBuf,
}

impl CanaryProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("canary");
        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        CANARY_REQUIRED_FILES
            .iter()
            .all(|f| self.model_dir.join(f).exists())
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

impl Default for CanaryProvider {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Native Candle inference (feature-gated)
// ---------------------------------------------------------------------------
/// Public entry point for running Whisper-Large-V3-Turbo inference on raw f32 samples.
/// Called by canary.rs and voxtral.rs (which reuses the same encoder architecture).
#[cfg(feature = "asr-canary")]
pub(super) fn run_canary_inference_on_samples(
    samples: Vec<f32>,
    model_dir: &Path,
) -> Result<String> {
    use crate::audio::mel::MelSpectrogram;
    use candle_core::{DType, Device, IndexOp, Tensor};
    use candle_nn::VarBuilder;
    use candle_transformers::models::whisper::{self as w, model::Whisper, Config};
    use tokenizers::Tokenizer;

    struct CanaryRuntime {
        model_dir_key: String,
        n_mels: usize,
        device: Device,
        tokenizer: Tokenizer,
        model: Whisper,
    }

    fn load_runtime(model_dir: &Path) -> Result<CanaryRuntime> {
        let device = Device::Cpu;
        let cfg_text = std::fs::read_to_string(model_dir.join("config.json"))
            .context("Failed to read Canary config.json")?;
        let config: Config =
            serde_json::from_str(&cfg_text).context("Failed to parse Canary config.json")?;
        let n_mels = config.num_mel_bins;

        let weights_path = model_dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)
                .context("Failed to load Canary weights")?
        };
        let model =
            Whisper::load(&vb, config).context("Failed to initialise Canary Whisper model")?;

        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("Failed to load Canary tokenizer: {}", e))?;

        Ok(CanaryRuntime {
            model_dir_key: model_dir.to_string_lossy().to_string(),
            n_mels,
            device,
            tokenizer,
            model,
        })
    }

    thread_local! {
        static RUNTIME_CACHE: RefCell<Option<CanaryRuntime>> = const { RefCell::new(None) };
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
            .ok_or_else(|| anyhow::anyhow!("Canary runtime cache unavailable"))?;

        let n_frames = w::N_FRAMES;
        let mel_extractor = MelSpectrogram::new(512, 160, 400, runtime.n_mels, 16000);
        let spec = mel_extractor.compute_whisper_normalized(&samples);

        let mel_flat: Vec<f32> = (0..runtime.n_mels)
            .flat_map(|m| {
                let row = if m < spec.len() { &spec[m] } else { &[][..] };
                (0..n_frames).map(move |t| if t < row.len() { row[t] } else { 0.0 })
            })
            .collect();

        let mel_tensor = Tensor::from_vec(mel_flat, (1, runtime.n_mels, n_frames), &runtime.device)
            .context("Failed to build mel tensor")?;

        let audio_features = runtime
            .model
            .encoder
            .forward(&mel_tensor, true)
            .context("Canary encoder failed")?;

        let sot = runtime.tokenizer.token_to_id(w::SOT_TOKEN).unwrap_or(50258);
        let eot = runtime.tokenizer.token_to_id(w::EOT_TOKEN).unwrap_or(50257);
        let transcribe = runtime
            .tokenizer
            .token_to_id(w::TRANSCRIBE_TOKEN)
            .unwrap_or(50360);
        let no_ts = runtime
            .tokenizer
            .token_to_id(w::NO_TIMESTAMPS_TOKEN)
            .unwrap_or(50364);
        let lang_en = runtime.tokenizer.token_to_id("<|en|>").unwrap_or(50259);

        let mut tokens: Vec<u32> = vec![sot, lang_en, transcribe, no_ts];
        let max_new_tokens = max_new_tokens_for_audio(samples.len());

        for _ in 0..max_new_tokens {
            let token_tensor = Tensor::new(tokens.as_slice(), &runtime.device)
                .context("Failed to create token tensor")?
                .unsqueeze(0)
                .context("unsqueeze failed")?;

            let decoder_out = runtime
                .model
                .decoder
                .forward(&token_tensor, &audio_features, tokens.len() == 4)
                .context("Canary decoder step failed")?;

            let logits = runtime
                .model
                .decoder
                .final_linear(&decoder_out)
                .context("final_linear failed")?;

            let last_logits = logits.i((0, tokens.len() - 1))?;
            let next_token = last_logits
                .argmax(0)
                .context("argmax failed")?
                .to_scalar::<u32>()
                .context("scalar failed")?;

            if next_token == eot {
                break;
            }
            tokens.push(next_token);
        }

        let output_ids: Vec<u32> = tokens[4..].to_vec();
        let text = runtime
            .tokenizer
            .decode(&output_ids, true)
            .map_err(|e| anyhow::anyhow!("Tokenizer decode failed: {}", e))?;

        Ok(text.trim().to_string())
    })
}

#[cfg(feature = "asr-canary")]
fn max_new_tokens_for_audio(sample_count: usize) -> usize {
    // Keep generation bounded to expected utterance length for dictation.
    // This avoids excessive autoregressive decode steps on short clips.
    let seconds = sample_count as f32 / 16_000.0;
    let estimated = (seconds * 6.0).ceil() as usize + 32;
    estimated.clamp(64, 320)
}

#[cfg(feature = "asr-canary")]
fn run_canary_candle(model_dir: &Path, audio_path: &Path) -> Result<String> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Canary")?;
    run_canary_inference_on_samples(samples, model_dir)
}

#[cfg(not(feature = "asr-canary"))]
fn run_canary_candle(_model_dir: &Path, _audio_path: &Path) -> Result<String> {
    Err(anyhow::anyhow!(
        "Canary Candle support is not compiled in. Rebuild with the `asr-canary` feature."
    ))
}

// ---------------------------------------------------------------------------
// AsrProvider implementation
// ---------------------------------------------------------------------------
#[async_trait]
impl AsrProvider for CanaryProvider {
    fn name(&self) -> &str {
        "Canary (Max Accuracy)"
    }

    fn description(&self) -> &str {
        "Whisper Large V3 Turbo via Candle — highest accuracy, native on-device inference."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Whisper Large V3 Turbo".to_string(),
            version: "large-v3-turbo".to_string(),
            size_mb: 1600.0,
            parameters: "809M".to_string(),
            languages: vec![
                "en", "es", "de", "fr", "it", "pt", "pl", "nl", "tr", "ru", "uk", "ar", "zh", "ja",
                "ko", "hi", "vi", "th", "id",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(4.2),
            real_time_factor: Some(0.9),
            license: "MIT".to_string(),
            source_url: format!("https://huggingface.co/{}", CANARY_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Canary model is not downloaded. Use the model manager to download it."
            ));
        }

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_path_owned = audio_path.to_path_buf();
        let audio_path_for_dur = audio_path_owned.clone();

        let text =
            tokio::task::spawn_blocking(move || run_canary_candle(&model_dir, &audio_path_owned))
                .await
                .context("Canary inference task panicked")??;

        let duration = Self::wav_duration_seconds(&audio_path_for_dur);
        let segment = TranscriptSegment {
            start_time: 0.0,
            end_time: duration,
            text: text.clone(),
            confidence: 0.92,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.92,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "whisper-large-v3-turbo".to_string(),
            model_id: CANARY_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::Canary,
            actual_provider: AsrProviderType::Canary,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join(format!("canary_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Canary")?;
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
            .context("Failed to create Canary model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);

        for (i, file_name) in CANARY_REQUIRED_FILES.iter().enumerate() {
            let destination = self.model_dir.join(file_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                CANARY_HF_REPO, file_name
            );
            let cb = progress_cb.clone();
            let n_files = CANARY_REQUIRED_FILES.len() as f32;
            manager
                .download_file_unverified(&url, &destination, move |p| {
                    cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                    tracing::info!("Canary {} download: {:.1}%", file_name, p.percentage);
                })
                .await?;
        }

        tracing::info!("Canary model downloaded successfully");
        Ok(())
    }
}
