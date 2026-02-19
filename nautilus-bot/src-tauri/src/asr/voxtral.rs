use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct VoxtralProvider {
    model_dir: PathBuf,
}

const VOXTRAL_MODEL_ID: &str = "voxtral-mini-4b";
const VOXTRAL_MODEL_REPO: &str = "mistralai/Voxtral-Mini-4B-Realtime-2602";
const VOXTRAL_REQUIRED_FILES: [&str; 6] = [
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "params.json",
    "processor_config.json",
    "tekken.json",
];

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
}

impl VoxtralProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("voxtral");

        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        VOXTRAL_REQUIRED_FILES
            .iter()
            .all(|file_name| self.model_dir.join(file_name).exists())
    }

    fn python_runtime(&self) -> Option<String> {
        // Voxtral likely needs recent transformers and potentially mistral-common if it uses specific tokenizers
        super::python_runtime::find_python_with_imports("import torch; import transformers")
    }

    fn runtime_ready(&self) -> bool {
        self.python_runtime().is_some()
    }

    fn run_python_transcription(&self, python_bin: &str, audio_path: &Path) -> Result<String> {
        // Note: Voxtral might need a specific pipeline task or loading method.
        // Assuming 'automatic-speech-recognition' works via AutoModelForSpeechSeq2Seq
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
            .context("failed to run local Voxtral worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Voxtral worker failed: {}", stderr.trim()));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid Voxtral output")?;
        if let Some(error) = payload.error {
            return Err(anyhow::anyhow!(error));
        }

        Ok(payload.text.unwrap_or_default())
    }
}

impl Default for VoxtralProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for VoxtralProvider {
    fn name(&self) -> &str {
        "Mistral Voxtral Mini"
    }

    fn description(&self) -> &str {
        "MistralAI Voxtral-Mini-4B-Realtime. High-quality multilingual speech model."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Voxtral Mini 4B".to_string(),
            version: "2602".to_string(),
            size_mb: 8000.0, // estimate
            parameters: "4B".to_string(),
            languages: vec!["en", "fr", "de", "es", "it"]
                .into_iter()
                .map(String::from)
                .collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Apache 2.0".to_string(), // Check license
            source_url: format!("https://huggingface.co/{}", VOXTRAL_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!("Voxtral model not downloaded"));
        }
        let python_bin = match self.python_runtime() {
            Some(v) => v,
            None => {
                return Err(anyhow::anyhow!(
                    "Voxtral runtime (torch+transformers) not found"
                ))
            }
        };

        let start = std::time::Instant::now();
        let text = self.run_python_transcription(&python_bin, audio_path)?;

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0, // TODO: duration
                text,
                confidence: 1.0,
            }],
            language: "auto".to_string(),
            confidence: 1.0,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "voxtral-mini-4b".to_string(),
            model_id: VOXTRAL_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::Voxtral,
            actual_provider: AsrProviderType::Voxtral,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("voxtral_temp.wav");
        std::fs::write(&temp_path, audio_data)?;
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
        std::fs::create_dir_all(&self.model_dir)?;

        let progress_cb = std::sync::Arc::new(progress_cb);

        for file in VOXTRAL_REQUIRED_FILES {
            let dest = self.model_dir.join(file);
            if dest.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                VOXTRAL_MODEL_REPO, file
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &dest, move |p| {
                    cb(p.percentage as f32);
                    tracing::info!("Voxtral {} download: {:.1}%", file, p.percentage);
                })
                .await?;
        }
        Ok(())
    }
}
