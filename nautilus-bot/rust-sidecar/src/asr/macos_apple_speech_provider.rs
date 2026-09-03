use super::{
    platform::{self, PlatformEngine},
    AsrProvider, DownloadStatus, ModelInfo, TranscriptionResult,
};
use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

pub struct MacosAppleSpeechProvider;

impl MacosAppleSpeechProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacosAppleSpeechProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AsrProvider for MacosAppleSpeechProvider {
    fn name(&self) -> &str {
        "Apple Speech (On-Device)"
    }

    fn description(&self) -> &str {
        "Dictation-only transcription through Apple's Speech framework with server fallback disabled."
    }

    fn is_available(&self) -> bool {
        platform::macos_speech::readiness().ready
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Apple Speech (On-Device)".to_string(),
            version: "system".to_string(),
            size_mb: 0.0,
            parameters: "OS managed".to_string(),
            languages: vec!["system".to_string()],
            word_error_rate: None,
            real_time_factor: None,
            license: "Apple platform terms".to_string(),
            source_url: "https://developer.apple.com/documentation/speech".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let result = platform::transcription::transcribe_with_engine(
            PlatformEngine::MacosAppleSpeech,
            Some(audio_path),
            None,
        )?;
        Ok(TranscriptionResult {
            text: result.text,
            segments: Vec::new(),
            language: result.language,
            confidence: result.confidence,
            processing_time_ms: result.processing_time_ms,
            model_name: "Apple Speech (On-Device)".to_string(),
            model_id: "macos_apple_speech".to_string(),
            requested_provider: super::AsrProviderType::MacosAppleSpeech,
            actual_provider: super::AsrProviderType::MacosAppleSpeech,
            requested_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            actual_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let result = platform::transcription::transcribe_with_engine(
            PlatformEngine::MacosAppleSpeech,
            None,
            Some(audio_data),
        )?;
        Ok(TranscriptionResult {
            text: result.text,
            segments: Vec::new(),
            language: result.language,
            confidence: result.confidence,
            processing_time_ms: result.processing_time_ms,
            model_name: "Apple Speech (On-Device)".to_string(),
            model_id: "macos_apple_speech".to_string(),
            requested_provider: super::AsrProviderType::MacosAppleSpeech,
            actual_provider: super::AsrProviderType::MacosAppleSpeech,
            requested_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            actual_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::Downloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        Ok(())
    }
}
