use super::{
    python_runtime, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment,
    TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

const VIBE_MODEL_REPO: &str = "microsoft/VibeVoice-ASR";
const VIBE_MODEL_ID: &str = "vibevoice-asr";

pub struct VibeVoiceProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl VibeVoiceProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("vibevoice");

        let model_id = selected_model_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(VIBE_MODEL_ID)
            .to_string();

        Self {
            model_dir,
            model_id,
        }
    }

    fn has_local_model(&self) -> bool {
        let has_config = self.model_dir.join("config.json").exists();
        let has_tokenizer = self.model_dir.join("tokenizer.json").exists()
            || self.model_dir.join("tokenizer_config.json").exists();

        let has_weights = self.model_dir.join("model.safetensors").exists()
            || self.model_dir.join("model.safetensors.index.json").exists()
            || std::fs::read_dir(&self.model_dir)
                .ok()
                .map(|entries| {
                    entries.flatten().any(|entry| {
                        entry
                            .path()
                            .extension()
                            .map(|ext| ext == "safetensors")
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);

        has_config && has_tokenizer && has_weights
    }
}

impl Default for VibeVoiceProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for VibeVoiceProvider {
    fn name(&self) -> &str {
        "Microsoft VibeVoice"
    }

    fn description(&self) -> &str {
        "Microsoft VibeVoice-ASR via managed Python runtime bridge"
    }

    fn is_available(&self) -> bool {
        self.has_local_model() && python_runtime::find_python_for_provider("vibevoice").is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "VibeVoice ASR".to_string(),
            version: "1.0".to_string(),
            size_mb: 5000.0,
            parameters: "Unknown".to_string(),
            languages: vec!["en".to_string(), "zh".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "MIT".to_string(),
            source_url: format!("https://huggingface.co/{}", VIBE_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_local_model() {
            return Err(anyhow::anyhow!(
                "VibeVoice model not downloaded. Download model assets first."
            ));
        }

        let start = std::time::Instant::now();
        let output = python_runtime::run_python_asr_action(
            "vibevoice",
            "transcribe",
            Some(self.model_id.as_str()),
            &self.model_dir,
            Some(audio_path),
            900,
        )
        .await
        .context("VibeVoice Python transcription failed")?;

        let text = output.text.unwrap_or_default();
        let duration = self.transcribe_duration(audio_path).unwrap_or(0.0);

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: duration,
                text,
                confidence: output.confidence.unwrap_or(0.9),
            }],
            language: output.language.unwrap_or_else(|| "auto".to_string()),
            confidence: output.confidence.unwrap_or(0.9),
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "vibevoice-asr".to_string(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::VibeVoice,
            actual_provider: AsrProviderType::VibeVoice,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("vibevoice_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for VibeVoice")?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_local_model() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create VibeVoice model directory")?;

        progress_cb(1.0);
        python_runtime::run_python_asr_action(
            "vibevoice",
            "download",
            Some(self.model_id.as_str()),
            &self.model_dir,
            None,
            3600,
        )
        .await
        .context("Failed to download VibeVoice model assets")?;
        progress_cb(100.0);

        Ok(())
    }
}

impl VibeVoiceProvider {
    fn transcribe_duration(&self, path: &Path) -> Option<f64> {
        let reader = hound::WavReader::open(path).ok()?;
        let spec = reader.spec();
        if spec.sample_rate == 0 {
            return Some(0.0);
        }
        Some(reader.duration() as f64 / spec.sample_rate as f64)
    }
}
