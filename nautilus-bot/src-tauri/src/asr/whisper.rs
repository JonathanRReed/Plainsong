use super::{AsrProvider, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

pub struct WhisperProvider {
    model_path: PathBuf,
    #[allow(dead_code)]
    models_dir: PathBuf,
    ctx: Option<whisper_rs::WhisperContext>,
}

impl WhisperProvider {
    pub fn new() -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("whisper");

        let model_path = models_dir.join("ggml-base.en.bin");

        let mut provider = Self {
            model_path: model_path.clone(),
            models_dir,
            ctx: None,
        };

        // Try to load the model if it exists
        if model_path.exists() {
            if let Err(e) = provider.load_model() {
                tracing::error!("Failed to load Whisper model: {}", e);
            }
        }

        provider
    }

    fn load_model(&mut self) -> Result<()> {
        tracing::info!("Loading Whisper model from {:?}", self.model_path);

        let ctx = whisper_rs::WhisperContext::new_with_params(
            &self.model_path.to_string_lossy(),
            whisper_rs::WhisperContextParameters::default(),
        )
        .context("Failed to load Whisper model")?;

        self.ctx = Some(ctx);
        tracing::info!("Whisper model loaded successfully");

        Ok(())
    }

    /// Get list of available models
    #[allow(dead_code)]
    pub fn get_available_models() -> Vec<WhisperModel> {
        vec![
            WhisperModel {
                name: "tiny".to_string(),
                file_name: "ggml-tiny.bin".to_string(),
                #[allow(dead_code)]
                size_mb: 75.0,
                parameters: "39M".to_string(),
                languages: vec!["multilingual".to_string()],
                wer: 18.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "tiny.en".to_string(),
                file_name: "ggml-tiny.en.bin".to_string(),
                size_mb: 75.0,
                parameters: "39M".to_string(),
                languages: vec!["en".to_string()],
                wer: 14.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "base".to_string(),
                file_name: "ggml-base.bin".to_string(),
                size_mb: 142.0,
                parameters: "74M".to_string(),
                languages: vec!["multilingual".to_string()],
                wer: 14.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "base.en".to_string(),
                file_name: "ggml-base.en.bin".to_string(),
                size_mb: 142.0,
                parameters: "74M".to_string(),
                languages: vec!["en".to_string()],
                wer: 11.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "small".to_string(),
                file_name: "ggml-small.bin".to_string(),
                size_mb: 466.0,
                parameters: "244M".to_string(),
                languages: vec!["multilingual".to_string()],
                wer: 10.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "medium".to_string(),
                file_name: "ggml-medium.bin".to_string(),
                size_mb: 1.5,
                parameters: "769M".to_string(),
                languages: vec!["multilingual".to_string()],
                wer: 8.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
                    .to_string(),
            },
            WhisperModel {
                name: "large-v3".to_string(),
                file_name: "ggml-large-v3.bin".to_string(),
                size_mb: 2.9,
                parameters: "1550M".to_string(),
                languages: vec!["multilingual".to_string()],
                wer: 6.0,
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
                    .to_string(),
            },
        ]
    }
}

#[async_trait]
impl AsrProvider for WhisperProvider {
    fn name(&self) -> &str {
        "OpenAI Whisper"
    }

    fn description(&self) -> &str {
        "OpenAI's Whisper model - the gold standard in open-source ASR. \
         Supports 99 languages with excellent accuracy. Uses whisper.cpp for efficient inference."
    }

    fn is_available(&self) -> bool {
        self.ctx.is_some()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Whisper".to_string(),
            version: "large-v3".to_string(),
            size_mb: 2900.0,
            parameters: "1550M".to_string(),
            languages: vec![
                "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
                "sv", "it", "id", "hi", "fi", "vi",
            ]
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
            word_error_rate: Some(6.0),
            real_time_factor: Some(1.5),
            license: "MIT".to_string(),
            source_url: "https://github.com/openai/whisper".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let ctx = self
            .ctx
            .as_ref()
            .context("Whisper model not loaded. Please download and load the model first.")?;

        let start_time = std::time::Instant::now();

        // Load and preprocess audio
        let audio_data = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio file")?;

        // Create state and configure
        let mut state = ctx
            .create_state()
            .context("Failed to create Whisper state")?;

        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(Some("en"));
        params.set_translate(false);

        // Run transcription
        state
            .full(params, &audio_data)
            .context("Failed to run Whisper transcription")?;

        let num_segments = state
            .full_n_segments()
            .context("Failed to get segment count")?;

        let mut segments = Vec::new();
        let mut full_text = String::new();

        for i in 0..num_segments {
            let segment = state
                .full_get_segment_text(i)
                .context("Failed to get segment text")?;
            let start = state
                .full_get_segment_t0(i)
                .context("Failed to get segment start time")?;
            let end = state
                .full_get_segment_t1(i)
                .context("Failed to get segment end time")?;

            segments.push(TranscriptSegment {
                start_time: start as f64 / 100.0, // Convert from centiseconds to seconds
                end_time: end as f64 / 100.0,
                text: segment.trim().to_string(),
                confidence: 0.9, // whisper-rs doesn't provide per-segment confidence
            });

            if !full_text.is_empty() {
                full_text.push(' ');
            }
            full_text.push_str(segment.trim());
        }

        let processing_time = start_time.elapsed().as_millis() as u64;

        tracing::info!(
            "Whisper transcription completed: {} segments in {}ms",
            segments.len(),
            processing_time
        );

        Ok(TranscriptionResult {
            text: full_text,
            segments,
            language: "en".to_string(),
            confidence: 0.9,
            processing_time_ms: processing_time,
            model_name: "whisper-base.en".to_string(),
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        // Save to temp file and transcribe
        let temp_path = std::env::temp_dir().join("whisper_temp.wav");
        std::fs::write(&temp_path, audio_data)?;
        self.transcribe(&temp_path).await
    }

    fn download_status(&self) -> DownloadStatus {
        if self.model_path.exists() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self) -> Result<()> {
        use crate::download::DownloadManager;

        let manager = DownloadManager::new()?;

        // Extract model name from path (e.g., "ggml-base.en.bin" -> "base.en")
        let model_name = self
            .model_path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("ggml-"))
            .unwrap_or("base.en");

        let progress_callback = |progress: crate::download::DownloadProgress| {
            tracing::info!(
                "Download progress: {:.1}% ({}/s)",
                progress.percentage,
                crate::download::format_bytes(progress.bytes_downloaded)
            );
        };

        manager
            .download_whisper_model(model_name, progress_callback)
            .await?;

        // Reload the model
        let mut provider = Self::new();
        if let Err(e) = provider.load_model() {
            tracing::error!("Failed to load model after download: {}", e);
        }

        Ok(())
    }
}

pub struct WhisperModel {
    #[allow(dead_code)]
    pub name: String,
    #[allow(dead_code)]
    pub file_name: String,
    #[allow(dead_code)]
    pub size_mb: f64,
    #[allow(dead_code)]
    pub parameters: String,
    #[allow(dead_code)]
    pub languages: Vec<String>,
    #[allow(dead_code)]
    pub wer: f64,
    #[allow(dead_code)]
    pub url: String,
}
