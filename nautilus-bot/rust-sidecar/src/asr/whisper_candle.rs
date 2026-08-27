use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
#[cfg(feature = "asr-canary")]
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Model: openai/whisper-large-v3-turbo via Candle (experimental local path)
// ---------------------------------------------------------------------------
const WHISPER_CANDLE_MODEL_ID: &str = "whisper-large-v3-turbo";
const WHISPER_CANDLE_HF_REPO: &str = "openai/whisper-large-v3-turbo";
const WHISPER_CANDLE_HF_REVISION: &str = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9";

const WHISPER_CANDLE_REQUIRED_FILES: [(&str, &str); 4] = [
    (
        "model.safetensors",
        "542566a422ae4f3fd23f1ba11add198fca01bbf82e66e6a2857b3f608b1eb9d1",
    ),
    (
        "config.json",
        "c5b526b3e3cd64cd8940dabb45e8ba726629e22d8ed389c29b552f9140daf04a",
    ),
    (
        "tokenizer.json",
        "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
    ),
    (
        "preprocessor_config.json",
        "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
    ),
];

fn whisper_candle_artifact_max_bytes(file_name: &str) -> u64 {
    if file_name == "model.safetensors" {
        4 * 1024 * 1024 * 1024
    } else {
        64 * 1024 * 1024
    }
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let model_dir = models_root.join("canary");
    WHISPER_CANDLE_REQUIRED_FILES
        .iter()
        .map(|(file_name, sha256)| (model_dir.join(file_name), (*sha256).to_string()))
        .collect()
}

#[cfg(feature = "asr-canary")]
struct WhisperCandleRuntime {
    model_dir_key: String,
    n_mels: usize,
    device: candle_core::Device,
    tokenizer: tokenizers::Tokenizer,
    model: candle_transformers::models::whisper::model::Whisper,
}

/// Select the best available Candle compute device: Metal GPU on macOS
/// (when compiled with the `candle-metal` feature), CPU everywhere else.
/// Falls back to CPU if Metal initialization fails for any reason.
#[cfg(feature = "asr-canary")]
fn select_best_device() -> candle_core::Device {
    #[cfg(feature = "candle-metal")]
    {
        match candle_core::Device::new_metal(0) {
            Ok(device) => {
                tracing::info!("Candle using Metal GPU device");
                return device;
            }
            Err(error) => {
                tracing::warn!("Candle Metal GPU init failed, falling back to CPU: {error}");
            }
        }
    }
    tracing::info!("Candle using CPU device");
    candle_core::Device::Cpu
}

#[cfg(feature = "asr-canary")]
fn load_runtime(model_dir: &Path) -> Result<WhisperCandleRuntime> {
    use candle_core::DType;
    use candle_nn::VarBuilder;
    use candle_transformers::models::whisper::{model::Whisper, Config};
    use tokenizers::Tokenizer;

    let device = select_best_device();
    let cfg_text = std::fs::read_to_string(model_dir.join("config.json"))
        .context("Failed to read Whisper Candle config.json")?;
    let config: Config =
        serde_json::from_str(&cfg_text).context("Failed to parse Whisper Candle config.json")?;
    let n_mels = config.num_mel_bins;

    let weights_path = model_dir.join("model.safetensors");
    let vb = unsafe {
        VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)
            .context("Failed to load Whisper Candle weights")?
    };
    let model = Whisper::load(&vb, config).context("Failed to initialise Whisper Candle model")?;

    let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
        .map_err(|e| anyhow::anyhow!("Failed to load Whisper Candle tokenizer: {}", e))?;

    Ok(WhisperCandleRuntime {
        model_dir_key: model_dir.to_string_lossy().to_string(),
        n_mels,
        device,
        tokenizer,
        model,
    })
}

#[cfg(feature = "asr-canary")]
fn runtime_cache() -> &'static Mutex<Option<WhisperCandleRuntime>> {
    static CACHE: OnceLock<Mutex<Option<WhisperCandleRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-canary")]
pub(crate) fn clear_cached_runtime(model_dir: &Path) {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    if let Ok(mut cache) = runtime_cache().lock() {
        if cache
            .as_ref()
            .map(|runtime| runtime.model_dir_key == model_dir_key)
            .unwrap_or(false)
        {
            *cache = None;
            tracing::info!(
                "Cleared cached Whisper Candle runtime for {}",
                model_dir.display()
            );
        }
    }
}

#[cfg(not(feature = "asr-canary"))]
pub(crate) fn clear_cached_runtime(_model_dir: &Path) {}

pub struct WhisperCandleProvider {
    model_dir: PathBuf,
}

impl WhisperCandleProvider {
    pub fn new(_selected_model_id: Option<&str>) -> Self {
        let model_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models")
            .join("canary");
        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        WHISPER_CANDLE_REQUIRED_FILES
            .iter()
            .all(|(file_name, _)| self.model_dir.join(file_name).exists())
    }

    fn has_trusted_required_files(&self) -> bool {
        WHISPER_CANDLE_REQUIRED_FILES
            .iter()
            .all(|(file_name, sha256)| {
                crate::download::is_model_artifact_trusted(
                    &self.model_dir.join(file_name),
                    Some(sha256),
                )
            })
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

impl Default for WhisperCandleProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

// ---------------------------------------------------------------------------
// Native Candle inference (feature-gated)
// ---------------------------------------------------------------------------
/// Public entry point for running Whisper-Large-V3-Turbo inference on raw f32 samples.
/// Shared with `distil_whisper.rs`, which is the same encoder-decoder architecture.
#[cfg(feature = "asr-canary")]
pub(super) fn run_whisper_candle_inference_on_samples(
    samples: Vec<f32>,
    model_dir: &Path,
) -> Result<String> {
    use crate::audio::mel::MelSpectrogram;
    use candle_core::{IndexOp, Tensor};
    use candle_transformers::models::whisper as w;

    let model_dir_key = model_dir.to_string_lossy().to_string();
    {
        let mut cache = runtime_cache().lock().map_err(|error| {
            anyhow::anyhow!("Whisper Candle runtime cache is unavailable: {}", error)
        })?;
        let should_reload = cache
            .as_ref()
            .map(|runtime| runtime.model_dir_key != model_dir_key)
            .unwrap_or(true);
        if should_reload {
            *cache = Some(load_runtime(model_dir)?);
        }

        let runtime = cache
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Whisper Candle runtime cache unavailable"))?;

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
            .context("Whisper Candle encoder failed")?;

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
                .context("Whisper Candle decoder step failed")?;

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
    }
}

#[cfg(feature = "asr-canary")]
pub(super) fn prewarm_runtime(model_dir: &Path) -> Result<()> {
    let model_dir_key = model_dir.to_string_lossy().to_string();
    let mut cache = runtime_cache().lock().map_err(|error| {
        anyhow::anyhow!("Whisper Candle runtime cache is unavailable: {}", error)
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

#[cfg(not(feature = "asr-canary"))]
pub(super) fn prewarm_runtime(_model_dir: &Path) -> Result<()> {
    Err(anyhow::anyhow!(
        "Whisper Candle support is not compiled into this build."
    ))
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
fn run_whisper_candle_inference_from_file(model_dir: &Path, audio_path: &Path) -> Result<String> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Whisper Candle")?;
    run_whisper_candle_inference_on_samples(samples, model_dir)
}

#[cfg(not(feature = "asr-canary"))]
fn run_whisper_candle_inference_from_file(_model_dir: &Path, _audio_path: &Path) -> Result<String> {
    Err(anyhow::anyhow!(
        "Whisper Candle support is not compiled in. Rebuild with the `asr-canary` feature."
    ))
}

// ---------------------------------------------------------------------------
// AsrProvider implementation
// ---------------------------------------------------------------------------
#[async_trait]
impl AsrProvider for WhisperCandleProvider {
    fn name(&self) -> &str {
        "Whisper Candle"
    }

    fn description(&self) -> &str {
        "OpenAI Whisper Large V3 Turbo via native Candle inference. Experimental local path."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        if !self.has_required_files() {
            anyhow::bail!(
                "Whisper Candle model is not downloaded. Use the model manager to download it."
            );
        }
        if !self.has_trusted_required_files() {
            anyhow::bail!(
                "Whisper Candle model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            );
        }
        let model_dir = self.model_dir.clone();
        tokio::task::spawn_blocking(move || prewarm_runtime(&model_dir))
            .await
            .context("Whisper Candle model warmup task panicked")??;
        Ok(())
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
            source_url: format!("https://huggingface.co/{}", WHISPER_CANDLE_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Whisper Candle model is not downloaded. Use the model manager to download it."
            ));
        }
        if !self.has_trusted_required_files() {
            return Err(anyhow::anyhow!(
                "Whisper Candle model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            ));
        }

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_path_for_dur = audio_path.to_path_buf();

        // VAD pre-filtering: trim silence for faster processing
        let raw_samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for Whisper Candle")?;

        let use_trimmed = if raw_samples.len() > 16000 {
            let trimmed = crate::audio::vad::trim_silence(&raw_samples, 16000, -40.0);
            if !trimmed.is_empty() && trimmed.len() < raw_samples.len() * 9 / 10 {
                let saved_ms = raw_samples.len().saturating_sub(trimmed.len()) as f64 / 16.0;
                if saved_ms > 100.0 {
                    tracing::info!(
                        "Whisper Candle: VAD trimmed {:.0}ms of silence, processing {:.0}ms",
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
            let temp_path = std::env::temp_dir().join(format!(
                "whisper_candle_trimmed_{}.wav",
                uuid::Uuid::new_v4()
            ));
            {
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: 16000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&temp_path, spec)
                    .context("Failed to create temp WAV for Whisper Candle")?;
                for sample in &samples {
                    let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                    writer
                        .write_sample(int_sample)
                        .context("Failed to write sample")?;
                }
                writer.finalize().context("Failed to finalize temp WAV")?;
            }
            let temp_path_for_cleanup = temp_path.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_whisper_candle_inference_from_file(&model_dir, &temp_path)
            })
            .await
            .context("Whisper Candle inference task panicked");
            let _ = std::fs::remove_file(&temp_path_for_cleanup);
            result??
        } else {
            let audio_path_owned = audio_path.to_path_buf();
            tokio::task::spawn_blocking(move || {
                run_whisper_candle_inference_from_file(&model_dir, &audio_path_owned)
            })
            .await
            .context("Whisper Candle inference task panicked")??
        };

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
            model_id: WHISPER_CANDLE_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::WhisperCandle,
            actual_provider: AsrProviderType::WhisperCandle,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("whisper_candle_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data)
            .context("failed to write temp wav for Whisper Candle")?;
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
            .context("Failed to create Whisper Candle model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);

        for (i, (file_name, sha256)) in WHISPER_CANDLE_REQUIRED_FILES.iter().enumerate() {
            let destination = self.model_dir.join(file_name);
            let url = format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                WHISPER_CANDLE_HF_REPO, WHISPER_CANDLE_HF_REVISION, file_name
            );
            let cb = progress_cb.clone();
            let n_files = WHISPER_CANDLE_REQUIRED_FILES.len() as f32;
            manager
                .download_verified_model_asset(
                    &url,
                    &destination,
                    Some(sha256),
                    whisper_candle_artifact_max_bytes(file_name),
                    move |p| {
                        cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                        tracing::info!(
                            "Whisper Candle {} download: {:.1}%",
                            file_name,
                            p.percentage
                        );
                    },
                )
                .await?;
        }

        tracing::info!("Whisper Candle model downloaded successfully");
        Ok(())
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    #[test]
    fn runtime_assets_are_revision_and_digest_pinned() {
        assert_eq!(WHISPER_CANDLE_HF_REVISION.len(), 40);
        for (file_name, sha256) in WHISPER_CANDLE_REQUIRED_FILES {
            assert!(!file_name.is_empty());
            assert_eq!(sha256.len(), 64);
            assert!(sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
        }
    }
}
