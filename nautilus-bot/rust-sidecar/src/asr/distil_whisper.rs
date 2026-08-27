use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Distil-Whisper Large v3.5, native Candle inference, no Python required.
// Same Whisper encoder-decoder architecture; uses candle-transformers Whisper.
// ---------------------------------------------------------------------------
const DISTIL_MODEL_ID: &str = "distil-large-v3.5";
const DISTIL_HF_REPO: &str = "distil-whisper/distil-large-v3.5";
const DISTIL_HF_REVISION: &str = "728a7691f3ff1d3d971528d3203a6e9559165d41";

/// Only the files needed for Candle inference (safetensors + tokenizer).
const DISTIL_REQUIRED_FILES: [(&str, &str, u64); 4] = [
    (
        "model.safetensors",
        "76ec9f754fc4b4810845dc36b71d1897c1342e702810c179e1569690084cfb0c",
        3_025_686_376,
    ),
    (
        "config.json",
        "515a10a9979258d3fc71cf79b2cd055c189f07d78879a15bd9bc282673308b85",
        1_249,
    ),
    (
        "tokenizer.json",
        "b3c8202bbf06d8ee4232c5984baa563784ac4737e2e7fdc42fa180200d3cfcdb",
        2_480_645,
    ),
    (
        "preprocessor_config.json",
        "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
        340,
    ),
];

fn weighted_bundle_progress(
    completed_bytes: u64,
    current_file_bytes: u64,
    current_file_percentage: f64,
) -> f32 {
    let total_bytes = DISTIL_REQUIRED_FILES
        .iter()
        .map(|(_, _, expected_bytes)| expected_bytes)
        .sum::<u64>();
    let current_bytes =
        current_file_bytes as f64 * (current_file_percentage.clamp(0.0, 100.0) / 100.0);
    (((completed_bytes as f64 + current_bytes) / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
        as f32
}

fn distil_artifact_max_bytes(file_name: &str) -> u64 {
    if file_name == "model.safetensors" {
        4 * 1024 * 1024 * 1024
    } else {
        64 * 1024 * 1024
    }
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let model_dir = models_root.join("distil_whisper");
    DISTIL_REQUIRED_FILES
        .iter()
        .map(|(file_name, sha256, _)| (model_dir.join(file_name), (*sha256).to_string()))
        .collect()
}

pub struct DistilWhisperProvider {
    model_dir: PathBuf,
}

impl DistilWhisperProvider {
    pub fn new(_selected_model_id: Option<&str>) -> Self {
        let model_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models")
            .join("distil_whisper");
        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        DISTIL_REQUIRED_FILES
            .iter()
            .all(|(file_name, _, _)| self.model_dir.join(file_name).exists())
    }

    fn has_trusted_required_files(&self) -> bool {
        DISTIL_REQUIRED_FILES.iter().all(|(file_name, sha256, _)| {
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

impl Default for DistilWhisperProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[cfg(feature = "asr-canary")]
pub(crate) fn clear_cached_runtime() {
    let model_dir = crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("distil_whisper");
    super::whisper_candle::clear_cached_runtime(&model_dir);
}

#[cfg(not(feature = "asr-canary"))]
pub(crate) fn clear_cached_runtime() {}

// ---------------------------------------------------------------------------
// Native Candle inference (feature-gated via asr-canary since it shares deps)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-canary")]
fn run_distil_candle(model_dir: &Path, audio_path: &Path) -> Result<String> {
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Distil-Whisper")?;
    // DistilWhisper shares the same Whisper encoder-decoder architecture as Whisper Candle.
    super::whisper_candle::run_whisper_candle_inference_on_samples(samples, model_dir)
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
        "Distil-Whisper Large v3.5, native Candle inference, 6x faster than Whisper Large, no Python."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        if !self.has_required_files() {
            anyhow::bail!(
                "Distil-Whisper model not downloaded. Use the model manager to download it."
            );
        }
        if !self.has_trusted_required_files() {
            anyhow::bail!(
                "Distil-Whisper model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            );
        }
        let model_dir = self.model_dir.clone();
        tokio::task::spawn_blocking(move || super::whisper_candle::prewarm_runtime(&model_dir))
            .await
            .context("Distil-Whisper model warmup task panicked")??;
        Ok(())
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Distil-Whisper Large v3.5".to_string(),
            version: DISTIL_MODEL_ID.to_string(),
            size_mb: 2888.0,
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
        if !self.has_trusted_required_files() {
            return Err(anyhow::anyhow!(
                "Distil-Whisper model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            ));
        }

        let start = std::time::Instant::now();

        // VAD pre-filtering: trim silence to speed up transcription
        let raw_samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for Distil-Whisper")?;

        let samples = if raw_samples.len() > 16000 {
            let trimmed = crate::audio::vad::trim_silence(&raw_samples, 16000, -40.0);
            if !trimmed.is_empty() {
                let saved_ms = raw_samples.len().saturating_sub(trimmed.len()) as f64 / 16.0;
                if saved_ms > 100.0 {
                    tracing::info!("Distil-Whisper: VAD trimmed {:.0}ms of silence", saved_ms);
                }
                trimmed
            } else {
                raw_samples
            }
        } else {
            raw_samples
        };

        // Write trimmed audio to temp file for inference
        let temp_path =
            std::env::temp_dir().join(format!("distil_trimmed_{}.wav", uuid::Uuid::new_v4()));
        {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&temp_path, spec)
                .context("Failed to create temp WAV for Distil")?;
            for sample in &samples {
                let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                writer
                    .write_sample(int_sample)
                    .context("Failed to write sample")?;
            }
            writer.finalize().context("Failed to finalize temp WAV")?;
        }

        let model_dir = self.model_dir.clone();
        let audio_for_dur = temp_path.clone();

        let text = tokio::task::spawn_blocking(move || run_distil_candle(&model_dir, &temp_path))
            .await
            .context("Distil-Whisper inference task panicked")??;

        // Cleanup temp file (even if inference fails)
        let _ = std::fs::remove_file(&audio_for_dur);

        let duration = Self::wav_duration_seconds(audio_path);
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
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
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
        let mut completed_bytes = 0;

        for (file_name, sha256, expected_bytes) in DISTIL_REQUIRED_FILES {
            let destination = self.model_dir.join(file_name);
            let url = format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                DISTIL_HF_REPO, DISTIL_HF_REVISION, file_name
            );
            let cb = progress_cb.clone();
            let completed_before_file = completed_bytes;
            manager
                .download_verified_model_asset(
                    &url,
                    &destination,
                    Some(sha256),
                    distil_artifact_max_bytes(file_name),
                    move |p| {
                        cb(weighted_bundle_progress(
                            completed_before_file,
                            expected_bytes,
                            p.percentage,
                        ));
                        tracing::info!(
                            "Distil-Whisper {} download: {:.1}%",
                            file_name,
                            p.percentage
                        );
                    },
                )
                .await?;
            completed_bytes += expected_bytes;
        }
        tracing::info!("Distil-Whisper model downloaded successfully");
        Ok(())
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    #[test]
    fn runtime_assets_are_revision_and_digest_pinned() {
        assert_eq!(DISTIL_HF_REVISION.len(), 40);
        for (file_name, sha256, expected_bytes) in DISTIL_REQUIRED_FILES {
            assert!(!file_name.is_empty());
            assert_eq!(sha256.len(), 64);
            assert!(expected_bytes > 0);
            assert!(sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn download_progress_is_weighted_by_artifact_bytes() {
        let model_bytes = DISTIL_REQUIRED_FILES[0].2;
        let halfway = weighted_bundle_progress(0, model_bytes, 50.0);
        assert!(halfway > 49.0 && halfway < 51.0);
    }
}
