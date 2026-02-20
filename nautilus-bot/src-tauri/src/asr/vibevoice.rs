use super::{
    AsrProvider, DownloadStatus, ModelInfo, TranscriptionResult,
};
use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

// ---------------------------------------------------------------------------
// Microsoft VibeVoice-ASR
// The public HuggingFace model (microsoft/VibeVoice-ASR) is a 5 GB sharded
// model that requires Microsoft-specific runtime libraries not available as
// standard ONNX or transformers exports. Native integration is planned.
// ---------------------------------------------------------------------------
const VIBE_MODEL_REPO: &str = "microsoft/VibeVoice-ASR";

pub struct VibeVoiceProvider;

impl VibeVoiceProvider {
    pub fn new() -> Self {
        Self
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
        "Microsoft VibeVoice-ASR — native integration coming soon (requires Microsoft runtime)."
    }

    fn is_available(&self) -> bool {
        false
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

    async fn transcribe(&self, _audio_path: &Path) -> Result<TranscriptionResult> {
        Err(anyhow::anyhow!(
            "VibeVoice native integration is not yet available. \
             Please select a different ASR provider."
        ))
    }

    async fn transcribe_bytes(&self, _audio_data: &[u8]) -> Result<TranscriptionResult> {
        Err(anyhow::anyhow!(
            "VibeVoice native integration is not yet available."
        ))
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::NotDownloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        Err(anyhow::anyhow!(
            "VibeVoice download is not yet supported. \
             Native ONNX integration is planned for a future release."
        ))
    }
}
