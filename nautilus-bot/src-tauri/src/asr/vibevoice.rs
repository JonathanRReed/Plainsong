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
        let has_config = is_valid_json_artifact(&self.model_dir.join("config.json"), 128);
        let has_single_weights =
            is_valid_binary_artifact(&self.model_dir.join("model.safetensors"), 1024);
        let has_index_shards = vibevoice_index_shards_present(&self.model_dir);
        has_config && (has_single_weights || has_index_shards)
    }
}

fn is_valid_binary_artifact(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 1];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

fn is_valid_json_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok()
}

fn vibevoice_index_shards_present(model_dir: &Path) -> bool {
    let index_path = model_dir.join("model.safetensors.index.json");
    let Ok(raw) = std::fs::read_to_string(index_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(weight_map) = json.get("weight_map").and_then(|w| w.as_object()) else {
        return false;
    };
    if weight_map.is_empty() {
        return false;
    }
    let shard_names = weight_map
        .values()
        .filter_map(|v| v.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if shard_names.is_empty() {
        return false;
    }
    shard_names
        .iter()
        .all(|name| is_valid_binary_artifact(&model_dir.join(name), 1024))
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

        let text = output.text.unwrap_or_default().trim().to_string();
        if text.is_empty() {
            return Err(anyhow::anyhow!(
                "VibeVoice returned an empty transcript. Verify runtime dependencies and model artifacts."
            ));
        }
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
