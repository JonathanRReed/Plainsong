use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct VibeVoiceProvider {
    model_dir: PathBuf,
}

const VIBE_MODEL_ID: &str = "vibevoice";
const VIBE_MODEL_REPO: &str = "microsoft/VibeVoice-ASR";
const VIBE_REQUIRED_FILES: [&str; 3] = [
    "config.json",
    "model.safetensors.index.json",
    "README.md", // placeholder
];

#[derive(Deserialize)]
struct PythonTranscription {
    text: Option<String>,
    error: Option<String>,
}

impl VibeVoiceProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("vibevoice");

        Self { model_dir }
    }

    fn has_required_files(&self) -> bool {
        // Check basic files + shards
        if !VIBE_REQUIRED_FILES
            .iter()
            .all(|f| self.model_dir.join(f).exists())
        {
            return false;
        }
        // Check 8 shards
        for i in 1..=8 {
            let name = format!("model-{:05}-of-00008.safetensors", i);
            if !self.model_dir.join(name).exists() {
                return false;
            }
        }
        true
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
        device=-1 
    )
    result = pipe(audio_path)
    text = result.get("text", "") if isinstance(result, dict) else str(result)
    # VibeVoice output might need specific parsing if it returns rich structs
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
            .context("failed to run local VibeVoice worker")?;

        if !output.status.success() && output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "VibeVoice worker failed: {}",
                stderr.trim()
            ));
        }

        let payload: PythonTranscription =
            serde_json::from_slice(&output.stdout).context("invalid VibeVoice output")?;
        if let Some(error) = payload.error {
            return Err(anyhow::anyhow!(error));
        }

        Ok(payload.text.unwrap_or_default())
    }
}

impl Default for VibeVoiceProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for VibeVoiceProvider {
    fn name(&self) -> &str {
        "Microsoft VibeVoice"
    }

    fn description(&self) -> &str {
        "Microsoft VibeVoice-ASR. Robust speech recognition with speaker diarization capabilities."
    }

    fn is_available(&self) -> bool {
        self.has_required_files() && self.runtime_ready()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "VibeVoice ASR".to_string(),
            version: "1.0".to_string(),
            size_mb: 5000.0, // estimate based on shards
            parameters: "Unknown".to_string(),
            languages: vec!["en".to_string(), "zh".to_string()], // Supports 50+
            word_error_rate: None,
            real_time_factor: None,
            license: "MIT".to_string(),
            source_url: format!("https://huggingface.co/{}", VIBE_MODEL_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_required_files() {
            return Err(anyhow::anyhow!("VibeVoice model not downloaded"));
        }
        let python_bin = match self.python_runtime() {
            Some(v) => v,
            None => return Err(anyhow::anyhow!("VibeVoice runtime not found")),
        };

        let start = std::time::Instant::now();
        let text = self.run_python_transcription(&python_bin, audio_path)?;

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0,
                text,
                confidence: 1.0,
            }],
            language: "auto".to_string(),
            confidence: 1.0,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "vibevoice".to_string(),
            model_id: VIBE_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::VibeVoice,
            actual_provider: AsrProviderType::VibeVoice,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("vibevoice_temp.wav");
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

        // Base files
        for file in VIBE_REQUIRED_FILES {
            let dest = self.model_dir.join(file);
            if dest.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                VIBE_MODEL_REPO, file
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &dest, move |p| {
                    cb(p.percentage as f32);
                })
                .await?;
        }

        // Shards
        for i in 1..=8 {
            let name = format!("model-{:05}-of-00008.safetensors", i);
            let dest = self.model_dir.join(&name);
            if dest.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                VIBE_MODEL_REPO, name
            );
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(&url, &dest, move |p| {
                    cb(p.percentage as f32);
                    tracing::info!("VibeVoice shard {} download: {:.1}%", i, p.percentage);
                })
                .await?;
        }

        Ok(())
    }
}
