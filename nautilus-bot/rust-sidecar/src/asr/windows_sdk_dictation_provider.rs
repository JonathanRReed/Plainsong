use super::{
    platform::{self, PlatformEngine},
    AsrProvider, DownloadStatus, ModelInfo, TranscriptionResult,
};
use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

pub struct WindowsSdkDictationProvider;

impl WindowsSdkDictationProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsSdkDictationProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for WindowsSdkDictationProvider {
    fn name(&self) -> &str {
        "Windows Native Speech"
    }

    fn description(&self) -> &str {
        "Windows SDK dictation transcription managed by the OS speech runtime."
    }

    fn is_available(&self) -> bool {
        PlatformEngine::WindowsSdkDictation.probe().ready
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Windows Native Speech".to_string(),
            version: "system".to_string(),
            size_mb: 0.0,
            parameters: "OS managed".to_string(),
            languages: vec!["system".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Microsoft platform terms".to_string(),
            source_url: "https://learn.microsoft.com/en-us/windows/ai/apis/speech-recognition"
                .to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let result = platform::transcription::transcribe_with_engine(
            PlatformEngine::WindowsSdkDictation,
            Some(audio_path),
            None,
        )?;
        Ok(TranscriptionResult {
            text: result.text,
            segments: Vec::new(),
            language: result.language,
            confidence: result.confidence,
            processing_time_ms: result.processing_time_ms,
            model_name: "Windows Native Speech".to_string(),
            model_id: "windows_sdk_dictation".to_string(),
            requested_provider: super::AsrProviderType::WindowsSdkDictation,
            actual_provider: super::AsrProviderType::WindowsSdkDictation,
            requested_engine: Some(PlatformEngine::WindowsSdkDictation.id().to_string()),
            actual_engine: Some(PlatformEngine::WindowsSdkDictation.id().to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let result = platform::transcription::transcribe_with_engine(
            PlatformEngine::WindowsSdkDictation,
            None,
            Some(audio_data),
        )?;
        Ok(TranscriptionResult {
            text: result.text,
            segments: Vec::new(),
            language: result.language,
            confidence: result.confidence,
            processing_time_ms: result.processing_time_ms,
            model_name: "Windows Native Speech".to_string(),
            model_id: "windows_sdk_dictation".to_string(),
            requested_provider: super::AsrProviderType::WindowsSdkDictation,
            actual_provider: super::AsrProviderType::WindowsSdkDictation,
            requested_engine: Some(PlatformEngine::WindowsSdkDictation.id().to_string()),
            actual_engine: Some(PlatformEngine::WindowsSdkDictation.id().to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
        })
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::Downloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        Ok(())
    }
}
