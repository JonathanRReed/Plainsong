use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct MoonshineProvider {
    model_dir: PathBuf,
}

const MOONSHINE_MODEL_ID: &str = "moonshine-base";
const MOONSHINE_MODEL_REPO: &str = "UsefulSensors/moonshine-base";
// Required files for transformers to load the model locally
const MOONSHINE_REQUIRED_FILES: [&str; 5] = [
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
];

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
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
        MOONSHINE_REQUIRED_FILES
            .iter()
            .all(|file_name| self.model_dir.join(file_name).exists())
    }

    fn python_runtime(&self) -> Option<String> {
        // Moonshine requires transformers >= 4.40 or similar for support?
        // We check for torch and transformers.
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
    # Use automatic-speech-recognition pipeline
    pipe = pipeline(
        task="automatic-speech-recognition",
        model=model_dir,
        tokenizer=model_dir,
        feature_extractor=model_dir,
        device=-1, # CPU
        generate_kwargs={}
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
            .context("failed to run local Moonshine worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Moonshine local worker failed: {}",
                stderr.trim()
            ));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid Moonshine worker output")?;
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

impl Default for MoonshineProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for MoonshineProvider {
    fn name(&self) -> &str {
        "UsefulSensors Moonshine"
    }

    fn description(&self) -> &str {
        "UsefulSensors Moonshine Base. Fast, on-device ASR optimized for edge devices."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Moonshine Base".to_string(),
            version: "base".to_string(),
            size_mb: 246.0, // Avg size
            parameters: "Base".to_string(),
            languages: vec!["en".to_string()], // Primary focus is English? Or check
            word_error_rate: Some(4.0),        // Approximate
            real_time_factor: Some(0.5),       // Very fast
            license: "MIT".to_string(),
            source_url: format!("https://huggingface.co/{}", MOONSHINE_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Moonshine model is not downloaded. Download it before selecting this provider."
            ));
        }
        let python_bin = match self.python_runtime() {
            Some(value) => value,
            None => {
                return Err(anyhow::anyhow!(
                    "Moonshine runtime is not ready. Install local Python dependencies (torch + transformers) and/or set NAUTILUS_PYTHON."
                ));
            }
        };
        let start = std::time::Instant::now();
        let text = self.run_python_transcription(&python_bin, audio_path)?;
        let duration = Self::wav_duration_seconds(audio_path);

        // Simple segment since we get full text
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
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("moonshine_temp.wav");
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Moonshine")?;
        self.transcribe(&temp_path).await
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

        let manager = DownloadManager::new()?;
        std::fs::create_dir_all(&self.model_dir).context("failed to create moonshine model dir")?;
        let progress_cb = std::sync::Arc::new(progress_cb);

        for file_name in MOONSHINE_REQUIRED_FILES {
            let destination = self.model_dir.join(file_name);
            if destination.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                MOONSHINE_MODEL_REPO, file_name
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &destination, move |progress| {
                    cb(progress.percentage as f32);
                    tracing::info!(
                        "Moonshine {} download: {:.1}%",
                        file_name,
                        progress.percentage
                    );
                })
                .await?;
        }

        Ok(())
    }
}
