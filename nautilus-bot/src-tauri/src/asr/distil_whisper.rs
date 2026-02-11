use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

pub struct DistilWhisperProvider {
    model_dir: PathBuf,
}

const DISTIL_MODEL_ID: &str = "distil-large-v3.5";
const DISTIL_MODEL_REPO: &str = "distil-whisper/distil-large-v3.5";
const DISTIL_REQUIRED_FILES: [&str; 8] = [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "merges.txt",
    "vocab.json",
];

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
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
            .context("failed to run local Distil worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Distil local worker failed: {}",
                stderr.trim()
            ));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid Distil worker output")?;
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
impl AsrProvider for DistilWhisperProvider {
    fn name(&self) -> &str {
        "Distil Whisper (Local)"
    }

    fn description(&self) -> &str {
        "Distilled Whisper local runtime with native model artifacts for low-latency transcription."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Distil Whisper".to_string(),
            version: DISTIL_MODEL_ID.to_string(),
            size_mb: 1530.0,
            parameters: "756M".to_string(),
            languages: vec![
                "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
                "sv", "it", "id", "hi", "fi", "vi",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(6.6),
            real_time_factor: Some(0.6),
            license: "Apache 2.0".to_string(),
            source_url: format!("https://huggingface.co/{}", DISTIL_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Distil model is not downloaded. Download it before selecting this provider."
            ));
        }
        let python_bin = match self.python_runtime() {
            Some(value) => value,
            None => {
                return Err(anyhow::anyhow!(
                    "Distil runtime is not ready. Install local Python dependencies (torch + transformers) and/or set NAUTILUS_PYTHON."
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
            confidence: 0.87,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.87,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "distil-whisper-local".to_string(),
            model_id: DISTIL_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::DistilWhisper,
            actual_provider: AsrProviderType::DistilWhisper,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("distil_whisper_temp.wav");
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Distil")?;
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
        for file_name in DISTIL_REQUIRED_FILES {
            let destination = self.model_dir.join(file_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                DISTIL_MODEL_REPO, file_name
            );
            manager
                .download_file(&url, &destination, move |progress| {
                    tracing::info!("Distil {} download: {:.1}%", file_name, progress.percentage);
                })
                .await?;
        }
        Ok(())
    }
}
