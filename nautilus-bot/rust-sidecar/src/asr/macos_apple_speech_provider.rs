use super::{
    platform::{self, transcription::PlatformTranscriptionOptions, PlatformEngine},
    AsrProvider, DownloadStatus, ModelInfo, TranscriptionOptions, TranscriptionResult,
};
use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

pub struct MacosAppleSpeechProvider;

impl MacosAppleSpeechProvider {
    pub fn new() -> Self {
        Self
    }

    /// The one place the route's result is shaped, so the batch and bytes
    /// paths cannot drift apart on which fields they carry.
    fn result_from(
        transcription: platform::transcription::PlatformTranscription,
    ) -> TranscriptionResult {
        TranscriptionResult {
            text: transcription.text,
            // Empty on the SFSpeechRecognizer path, populated on the
            // SpeechAnalyzer path; the meeting chunker offsets and merges
            // whatever arrives here.
            segments: transcription.segments,
            language: transcription.language,
            confidence: transcription.confidence,
            processing_time_ms: transcription.processing_time_ms,
            model_name: "Apple Speech (On-Device)".to_string(),
            model_id: "macos_apple_speech".to_string(),
            requested_provider: super::AsrProviderType::MacosAppleSpeech,
            actual_provider: super::AsrProviderType::MacosAppleSpeech,
            requested_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            actual_engine: Some(PlatformEngine::MacosAppleSpeech.id().to_string()),
            optimization_applied: false,
            fallback_reason: None,
            // What the helper says it handed the recognizer, not what was
            // sent: an older helper that does not know the option reports
            // zero, and the audit log must not claim the dictionary reached
            // a recognizer that never saw it.
            vocabulary_hint_terms_applied: transcription.vocabulary_hint_terms_applied,
        }
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
        // Which sentence is true depends on which engine this Mac will run.
        // SpeechAnalyzer returns per-segment timestamps, so the route is
        // meeting-capable; SFSpeechRecognizer does not, so it is not.
        if platform::macos_speech::meetings_supported() {
            "On-device transcription through Apple's SpeechAnalyzer engine: nothing to download, per-segment timestamps, and no server fallback."
        } else {
            "Dictation-only transcription through Apple's Speech framework with server fallback disabled."
        }
    }

    fn is_available(&self) -> bool {
        platform::macos_speech::readiness().ready
    }

    fn model_info(&self) -> ModelInfo {
        // The language list is whatever SpeechAnalyzer reports on this Mac at
        // probe time, not a list this repo maintains: Apple ships the assets
        // and the set differs per machine and per OS version. Falls back to
        // "system" when the probe has nothing to say (older macOS, or the
        // helper could not run).
        let readiness = platform::macos_speech::readiness();
        let languages = if readiness.speech_analyzer_locales.is_empty() {
            vec!["system".to_string()]
        } else {
            readiness.speech_analyzer_locales.clone()
        };
        ModelInfo {
            name: "Apple Speech (On-Device)".to_string(),
            version: "system".to_string(),
            size_mb: 0.0,
            parameters: "OS managed".to_string(),
            languages,
            word_error_rate: None,
            real_time_factor: None,
            license: "Apple platform terms".to_string(),
            source_url: "https://developer.apple.com/documentation/speech".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        Ok(Self::result_from(
            platform::transcription::transcribe_with_engine(
                PlatformEngine::MacosAppleSpeech,
                Some(audio_path),
                None,
            )?,
        ))
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        Ok(Self::result_from(
            platform::transcription::transcribe_with_engine(
                PlatformEngine::MacosAppleSpeech,
                None,
                Some(audio_data),
            )?,
        ))
    }

    /// The only provider that reads `apple_speech_required_engine`: it is the
    /// only one with two engines whose results differ in a way a caller can
    /// depend on (timed segments or none at all).
    ///
    /// It also passes the vocabulary hint through, which it did not use to.
    /// Both Apple engines take a bias list; measured on macOS 27.0 the older
    /// SFSpeechRecognizer engine acts on it (5.93% -> 2.96% WER on the repo's
    /// 44 s fixture with a three-term hint) and SpeechAnalyzer accepts it with
    /// no observable change. Sending it to both is what makes the reported
    /// applied count honest for whichever one runs.
    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        Ok(Self::result_from(
            platform::transcription::transcribe_with_engine_options(
                PlatformEngine::MacosAppleSpeech,
                None,
                Some(audio_data),
                PlatformTranscriptionOptions {
                    apple_speech_required_engine: options.apple_speech_required_engine,
                    contextual_strings: platform::macos_speech::contextual_strings_for_helper(
                        options.vocabulary_hint.as_ref(),
                    ),
                },
            )?,
        ))
    }

    fn download_status(&self) -> DownloadStatus {
        DownloadStatus::Downloaded
    }

    async fn download_models(&self, _progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        Ok(())
    }
}
