//! Stub for the `whisper` module when the `asr-whisper` feature is disabled.
//!
//! The `Whisper` provider type remains in `AsrProviderType` (it is the
//! default fallback for settings migration), but without `whisper-rs` we
//! cannot actually run it. This stub provides the same public surface so
//! the rest of the crate compiles; any attempt to use the provider returns
//! an error or no-op.

use crate::asr::{AsrProvider, DownloadStatus, ModelInfo, TranscriptionResult};
use anyhow::Result;
use async_trait::async_trait;
use std::path::{Path, PathBuf};

pub struct WhisperProvider {
    model_id: String,
}

impl WhisperProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        Self {
            model_id: selected_model_id.unwrap_or("base.en").to_string(),
        }
    }
}

#[async_trait]
impl AsrProvider for WhisperProvider {
    fn name(&self) -> &str {
        "OpenAI Whisper (not compiled)"
    }

    fn description(&self) -> &str {
        "whisper-rs is not compiled in; the asr-whisper feature is disabled"
    }

    fn is_available(&self) -> bool {
        false
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Whisper".to_string(),
            version: self.model_id.clone(),
            size_mb: 0.0,
            parameters: "0".to_string(),
            languages: Vec::new(),
            word_error_rate: None,
            real_time_factor: None,
            license: "MIT".to_string(),
            source_url: String::new(),
        }
    }

    async fn transcribe(&self, _audio_path: &Path) -> Result<TranscriptionResult> {
        anyhow::bail!("whisper-rs is not compiled in; the asr-whisper feature is disabled")
    }

    async fn transcribe_bytes(&self, _audio_data: &[u8]) -> Result<TranscriptionResult> {
        anyhow::bail!("whisper-rs is not compiled in; the asr-whisper feature is disabled")
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::NotDownloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        anyhow::bail!("whisper-rs is not compiled in; the asr-whisper feature is disabled")
    }
}

pub(crate) fn clear_cached_model(_model_id: &str) {}

pub(crate) fn clear_all_cached_models() {}

/// Returns the model directory path used by the Whisper provider, even when
/// the feature is disabled, so settings/diagnostics code can still reason
/// about where models would live.
pub fn whisper_model_path(_model_id: &str) -> PathBuf {
    PathBuf::new()
}
