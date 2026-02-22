use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Distil-Whisper Large v3.5 — native Candle inference, no Python required.
// Same Whisper encoder-decoder architecture; uses candle-transformers Whisper.
// ---------------------------------------------------------------------------
const DISTIL_MODEL_ID: &str = "distil-large-v3.5";
const DISTIL_HF_REPO: &str = "distil-whisper/distil-large-v3.5";

/// Only the files needed for Candle inference (safetensors + tokenizer).
const DISTIL_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];

pub struct DistilWhisperProvider {
    model_dir: PathBuf,
}

impl DistilWhisperProvider {
    pub fn new(_selected_model_id: Option<&str>) -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("distil_whisper");
        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        DISTIL_REQUIRED_FILES
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

impl Default for DistilWhisperProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

// ---------------------------------------------------------------------------
// Native Candle inference (feature-gated via asr-canary since it shares deps)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-canary")]
fn run_distil_candle(model_dir: &Path, audio_path: &Path) -> Result<String> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Distil-Whisper")?;
    // DistilWhisper shares the same Whisper encoder-decoder architecture as Canary.
    super::canary::run_canary_inference_on_samples(samples, model_dir)
}

#[cfg(not(feature = "asr-canary"))]
fn run_distil_candle(_model_dir: &Path, _audio_path: &Path) -> Result<String> {
    Err(anyhow::anyhow!(
        "Distil-Whisper requires the `asr-canary` feature. Rebuild with that feature enabled."
    ))
}

// ---------------------------------------------------------------------------
// AsrProvider implementation
// ---------------------------------------------------------------------------
#[async_trait]
impl AsrProvider for DistilWhisperProvider {
    fn name(&self) -> &str {
        "Distil-Whisper Large v3.5"
    }

    fn description(&self) -> &str {
        "Distil-Whisper Large v3.5 — native Candle inference, 6x faster than Whisper Large, no Python."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Distil-Whisper Large v3.5".to_string(),
            version: DISTIL_MODEL_ID.to_string(),
            size_mb: 1530.0,
            parameters: "756M".to_string(),
            languages: vec!["en".to_string()],
            word_error_rate: Some(6.6),
            real_time_factor: Some(0.6),
            license: "Apache 2.0".to_string(),
            source_url: format!("https://huggingface.co/{}", DISTIL_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Distil-Whisper model not downloaded. Use the model manager to download it."
            ));
        }

        let start = std::time::Instant::now();
        let model_dir = self.model_dir.clone();
        let audio_path_owned = audio_path.to_path_buf();
        let audio_for_dur = audio_path_owned.clone();

        let text =
            tokio::task::spawn_blocking(move || run_distil_candle(&model_dir, &audio_path_owned))
                .await
                .context("Distil-Whisper inference task panicked")??;

        let duration = Self::wav_duration_seconds(&audio_for_dur);
        let segment = TranscriptSegment {
            start_time: 0.0,
            end_time: duration,
            text: text.clone(),
            confidence: 0.87,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.87,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "distil-whisper-large-v3.5".to_string(),
            model_id: DISTIL_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::DistilWhisper,
            actual_provider: AsrProviderType::DistilWhisper,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join(format!("distil_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Distil")?;
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
            .context("Failed to create Distil-Whisper model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);
        let n_files = DISTIL_REQUIRED_FILES.len() as f32;

        for (i, file_name) in DISTIL_REQUIRED_FILES.iter().enumerate() {
            let destination = self.model_dir.join(file_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                DISTIL_HF_REPO, file_name
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &destination, move |p| {
                    cb((i as f32 / n_files + p.percentage as f32 / 100.0 / n_files) * 100.0);
                    tracing::info!(
                        "Distil-Whisper {} download: {:.1}%",
                        file_name,
                        p.percentage
                    );
                })
                .await?;
        }
        tracing::info!("Distil-Whisper model downloaded successfully");
        Ok(())
    }
}
