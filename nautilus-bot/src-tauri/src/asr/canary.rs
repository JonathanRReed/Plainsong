use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct CanaryProvider {
    model_dir: PathBuf,
}

const CANARY_MODEL_ID: &str = "canary-qwen-2.5b";
const CANARY_MODEL_REPO: &str = "nvidia/canary-qwen-2.5b";
const CANARY_REQUIRED_FILES: [&str; 3] = ["config.json", "model.safetensors", "LICENSES"];

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
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
            .all(|file_name| self.model_dir.join(file_name).exists())
    }

    fn python_runtime(&self) -> Option<String> {
        super::python_runtime::find_python_with_imports("import torch; import transformers")
    }

    fn runtime_ready(&self) -> bool {
        self.python_runtime().is_some()
    }

    fn run_python_transcription(&self, python_bin: &str, audio_path: &Path) -> Result<String> {
        let py = r#"
import json
import sys
from transformers import pipeline

model_dir = sys.argv[1]
audio_path = sys.argv[2]

try:
    pipe = pipeline(
        task="automatic-speech-recognition",
        model=model_dir,
        tokenizer=model_dir,
        feature_extractor=model_dir,
        device=-1
    )
    result = pipe(audio_path)
    text = result.get("text", "") if isinstance(result, dict) else str(result)
    print(json.dumps({"text": text}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(2)
"#;

        let output = Command::new(python_bin)
            .arg("-c")
            .arg(py)
            .arg(self.model_dir.as_os_str())
            .arg(audio_path.as_os_str())
            .output()
            .context("failed to run local Canary worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Canary local worker failed: {}",
                stderr.trim()
            ));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid Canary worker output")?;
        if let Some(error) = payload.error {
            return Err(anyhow::anyhow!(error));
        }

        Ok(payload.text.unwrap_or_default())
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

#[async_trait]
impl AsrProvider for CanaryProvider {
    fn name(&self) -> &str {
        "NVIDIA Canary Qwen"
    }

    fn description(&self) -> &str {
        "NVIDIA Canary Qwen local runtime with on-device inference through a Python worker bridge."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Canary Qwen 2.5B".to_string(),
            version: "2.5b-local".to_string(),
            size_mb: 2500.0,
            parameters: "2.5B".to_string(),
            languages: vec![
                "en", "es", "de", "fr", "it", "pt", "pl", "nl", "tr", "ru", "uk", "ar", "zh", "ja",
                "ko", "hi", "vi", "th", "id",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(5.63),
            real_time_factor: Some(1.4),
            license: "Apache 2.0".to_string(),
            source_url: format!("https://huggingface.co/{}", CANARY_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Canary model is not downloaded. Download it before selecting this provider."
            ));
        }
        let python_bin = match self.python_runtime() {
            Some(value) => value,
            None => {
                return Err(anyhow::anyhow!(
                    "Canary runtime is not ready. Install local Python dependencies (torch + transformers) and/or set NAUTILUS_PYTHON."
                ));
            }
        };
        let start = std::time::Instant::now();
        let text = self.run_python_transcription(&python_bin, audio_path)?;
        let duration = Self::wav_duration_seconds(audio_path);
        let segment = TranscriptSegment {
            start_time: 0.0,
            end_time: duration,
            text: text.clone(),
            confidence: 0.85,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.85,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "canary-qwen-local".to_string(),
            model_id: CANARY_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::Canary,
            actual_provider: AsrProviderType::Canary,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("canary_temp.wav");
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Canary")?;
        self.transcribe(&temp_path).await
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_required_files() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self) -> Result<()> {
        use crate::download::DownloadManager;

        let manager = DownloadManager::new()?;
        for file_name in CANARY_REQUIRED_FILES {
            let destination = self.model_dir.join(file_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                CANARY_MODEL_REPO, file_name
            );
            manager
                .download_file(&url, &destination, move |progress| {
                    tracing::info!("Canary {} download: {:.1}%", file_name, progress.percentage);
                })
                .await?;
        }

        Ok(())
    }
}

#[allow(dead_code)]
fn _provider_type_marker() -> AsrProviderType {
    AsrProviderType::Canary
}
