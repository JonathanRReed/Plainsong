use super::{
    python_runtime, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment,
    TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::{Path, PathBuf};

const VOXTRAL_LOCAL_MODEL_ID: &str = "voxtral-local";
const VOXTRAL_CLOUD_MODEL_ID: &str = "voxtral-cloud";
const VOXTRAL_API_MODEL: &str = "voxtral-mini-4b-2602";
const MISTRAL_ASR_URL: &str = "https://api.mistral.ai/v1/audio/transcriptions";
const VOXTRAL_HF_REPO: &str = "mistralai/Voxtral-Mini-4B-Realtime-2602";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VoxtralMode {
    Local,
    Cloud,
}

fn sanitize_voxtral_mode(model_id: Option<&str>) -> VoxtralMode {
    match model_id.unwrap_or(VOXTRAL_LOCAL_MODEL_ID).trim() {
        VOXTRAL_CLOUD_MODEL_ID => VoxtralMode::Cloud,
        "voxtral-mini-4b" => VoxtralMode::Local,
        _ => VoxtralMode::Local,
    }
}

#[derive(Deserialize)]
struct MistralTranscriptionResponse {
    text: String,
}

pub struct VoxtralProvider {
    model_dir: PathBuf,
    mode: VoxtralMode,
}

impl VoxtralProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("voxtral");

        Self {
            model_dir,
            mode: sanitize_voxtral_mode(selected_model_id),
        }
    }

    fn has_local_model(&self) -> bool {
        let has_config = is_valid_json_artifact(&self.model_dir.join("config.json"), 64);
        let has_processor =
            is_valid_json_artifact(&self.model_dir.join("processor_config.json"), 64);
        let has_tekken = is_valid_json_artifact(&self.model_dir.join("tekken.json"), 64);
        let has_weights = is_valid_binary_artifact(&self.model_dir.join("model.safetensors"), 1024)
            || is_valid_binary_artifact(&self.model_dir.join("consolidated.safetensors"), 1024)
            || has_any_valid_safetensors(&self.model_dir, 1024);

        has_config && has_processor && has_tekken && has_weights
    }

    fn api_key() -> Option<String> {
        match crate::secrets::get_provider_secret("mistral") {
            Ok(Some(secret)) if !secret.trim().is_empty() => Some(secret),
            _ => std::env::var("MISTRAL_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        }
    }

    fn selected_model_id(&self) -> &'static str {
        match self.mode {
            VoxtralMode::Local => VOXTRAL_LOCAL_MODEL_ID,
            VoxtralMode::Cloud => VOXTRAL_CLOUD_MODEL_ID,
        }
    }

    async fn transcribe_cloud(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let api_key =
            Self::api_key().context("Mistral API key not set. Add it in Settings → API Keys.")?;

        let start = std::time::Instant::now();

        let part = reqwest::multipart::Part::bytes(audio_data.to_vec())
            .file_name("audio.wav")
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", VOXTRAL_API_MODEL);

        let client = reqwest::Client::new();
        let response = client
            .post(MISTRAL_ASR_URL)
            .bearer_auth(&api_key)
            .multipart(form)
            .send()
            .await
            .context("Mistral Voxtral API request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Mistral Voxtral API error {}: {}", status, body);
        }

        let result = response
            .json::<MistralTranscriptionResponse>()
            .await
            .context("Failed to parse Mistral Voxtral response")?;

        let text = result.text;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0,
                text,
                confidence: 0.93,
            }],
            language: "auto".to_string(),
            confidence: 0.93,
            processing_time_ms: elapsed,
            model_name: format!("Voxtral Mini ({})", VOXTRAL_API_MODEL),
            model_id: self.selected_model_id().to_string(),
            requested_provider: AsrProviderType::Voxtral,
            actual_provider: AsrProviderType::Voxtral,
            fallback_reason: None,
        })
    }

    async fn transcribe_local(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !self.has_local_model() {
            anyhow::bail!("Voxtral local model not downloaded. Download model assets first.");
        }

        let start = std::time::Instant::now();
        let output = python_runtime::run_python_asr_action(
            "voxtral_local",
            "transcribe",
            Some(self.selected_model_id()),
            &self.model_dir,
            Some(audio_path),
            900,
        )
        .await
        .context("Voxtral local transcription failed")?;

        let text = output.text.unwrap_or_default().trim().to_string();
        if text.is_empty() {
            anyhow::bail!("Voxtral local returned an empty transcript");
        }

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: vec![TranscriptSegment {
                start_time: 0.0,
                end_time: 0.0,
                text,
                confidence: output.confidence.unwrap_or(0.9),
            }],
            language: output.language.unwrap_or_else(|| "auto".to_string()),
            confidence: output.confidence.unwrap_or(0.9),
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "voxtral-mini-4b-local".to_string(),
            model_id: self.selected_model_id().to_string(),
            requested_provider: AsrProviderType::Voxtral,
            actual_provider: AsrProviderType::Voxtral,
            fallback_reason: None,
        })
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

fn has_any_valid_safetensors(model_dir: &Path, min_bytes: u64) -> bool {
    std::fs::read_dir(model_dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.extension()
                    .map(|ext| ext == "safetensors")
                    .unwrap_or(false)
                    && is_valid_binary_artifact(&path, min_bytes)
            })
        })
        .unwrap_or(false)
}

impl Default for VoxtralProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for VoxtralProvider {
    fn name(&self) -> &str {
        "Mistral Voxtral Mini"
    }

    fn description(&self) -> &str {
        match self.mode {
            VoxtralMode::Local => {
                "Mistral Voxtral-Mini-4B local mode via managed Python runtime bridge"
            }
            VoxtralMode::Cloud => "Mistral Voxtral-Mini-4B cloud mode via Mistral API",
        }
    }

    fn is_available(&self) -> bool {
        match self.mode {
            VoxtralMode::Local => {
                self.has_local_model()
                    && python_runtime::find_python_for_provider("voxtral_local").is_some()
            }
            VoxtralMode::Cloud => Self::api_key().is_some(),
        }
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Voxtral Mini 4B".to_string(),
            version: "2602".to_string(),
            size_mb: 8192.0,
            parameters: "4B local / cloud".to_string(),
            languages: vec![
                "en", "fr", "de", "es", "it", "pt", "nl", "pl", "ru", "ja", "zh",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Commercial API".to_string(),
            source_url: format!("https://huggingface.co/{}", VOXTRAL_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        match self.mode {
            VoxtralMode::Local => self.transcribe_local(audio_path).await,
            VoxtralMode::Cloud => {
                let audio_data = tokio::fs::read(audio_path)
                    .await
                    .context("Failed to read audio file for Voxtral cloud mode")?;
                self.transcribe_cloud(&audio_data).await
            }
        }
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        match self.mode {
            VoxtralMode::Local => {
                let temp_path =
                    std::env::temp_dir().join(format!("voxtral_{}.wav", uuid::Uuid::new_v4()));
                std::fs::write(&temp_path, audio_data)
                    .context("failed to write temp wav for Voxtral")?;
                let result = self.transcribe_local(&temp_path).await;
                let _ = std::fs::remove_file(&temp_path);
                result
            }
            VoxtralMode::Cloud => self.transcribe_cloud(audio_data).await,
        }
    }

    fn download_status(&self) -> DownloadStatus {
        match self.mode {
            VoxtralMode::Cloud => DownloadStatus::Downloaded,
            VoxtralMode::Local => {
                if self.has_local_model() {
                    DownloadStatus::Downloaded
                } else {
                    DownloadStatus::NotDownloaded
                }
            }
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        if self.mode == VoxtralMode::Cloud {
            return Ok(());
        }

        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create Voxtral model directory")?;

        progress_cb(1.0);
        python_runtime::run_python_asr_action(
            "voxtral_local",
            "download",
            Some(self.selected_model_id()),
            &self.model_dir,
            None,
            3600,
        )
        .await
        .context("Failed to download Voxtral local model assets")?;
        progress_cb(100.0);

        Ok(())
    }
}
