use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

const PARAKEET_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3.nemo";

pub struct ParakeetProvider {
    model_path: PathBuf,
}

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
}

impl ParakeetProvider {
    pub fn new() -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("parakeet");

        Self {
            model_path: models_dir.join(PARAKEET_MODEL_FILE),
        }
    }

    fn python_runtime(&self) -> Option<String> {
        super::python_runtime::find_python_with_imports("import nemo.collections.asr")
    }

    fn runtime_ready(&self) -> bool {
        self.python_runtime().is_some()
    }

    fn run_python_transcription(&self, python_bin: &str, audio_path: &Path) -> Result<String> {
        let py = r#"
import json
import sys
from nemo.collections.asr.models import ASRModel

model_path = sys.argv[1]
audio_path = sys.argv[2]

try:
    model = ASRModel.restore_from(model_path)
    result = model.transcribe([audio_path], batch_size=1)
    text = ""
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, str):
            text = first
        elif hasattr(first, "text"):
            text = first.text
    print(json.dumps({"text": text}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(2)
"#;

        let output = Command::new(python_bin)
            .arg("-c")
            .arg(py)
            .arg(self.model_path.as_os_str())
            .arg(audio_path.as_os_str())
            .output()
            .context("failed to run local Parakeet worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Parakeet local worker failed: {}",
                stderr.trim()
            ));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid Parakeet worker output")?;
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
impl AsrProvider for ParakeetProvider {
    fn name(&self) -> &str {
        "NVIDIA Parakeet TDT"
    }

    fn description(&self) -> &str {
        "NVIDIA Parakeet TDT 0.6B v3 running locally through a NeMo runtime bridge."
    }

    fn is_available(&self) -> bool {
        self.model_path.exists() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Parakeet TDT 0.6B V3".to_string(),
            version: "0.6b-v3".to_string(),
            size_mb: 1150.0,
            parameters: "600M".to_string(),
            languages: vec![
                "en", "es", "fr", "de", "bg", "hr", "cs", "da", "nl", "et", "fi", "el", "hu", "it",
                "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "sv", "ru", "uk",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(6.05),
            real_time_factor: Some(0.7),
            license: "CC-BY-4.0".to_string(),
            source_url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.model_path.exists() {
            return Err(anyhow::anyhow!(
                "Parakeet model is not downloaded. Download it before selecting this provider."
            ));
        }
        let python_bin = match self.python_runtime() {
            Some(value) => value,
            None => {
                return Err(anyhow::anyhow!(
                    "Parakeet runtime is not ready. Install Python NeMo locally and/or set NAUTILUS_PYTHON to a compatible interpreter."
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
            confidence: 0.88,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.88,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "parakeet-tdt-0.6b-v3".to_string(),
            model_id: "parakeet-tdt-0.6b-v3".to_string(),
            requested_provider: AsrProviderType::Parakeet,
            actual_provider: AsrProviderType::Parakeet,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("parakeet_temp.wav");
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Parakeet")?;
        self.transcribe(&temp_path).await
    }

    fn download_status(&self) -> DownloadStatus {
        if self.model_path.exists() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self) -> Result<()> {
        use crate::download::DownloadManager;
        let manager = DownloadManager::new()?;
        let url =
            "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/parakeet-tdt-0.6b-v3.nemo";

        let progress_callback = |progress: crate::download::DownloadProgress| {
            tracing::info!("Parakeet download progress: {:.1}%", progress.percentage);
        };

        manager
            .download_file(url, &self.model_path, progress_callback)
            .await?;
        Ok(())
    }
}
