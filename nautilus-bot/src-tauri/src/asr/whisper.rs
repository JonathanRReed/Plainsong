use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

fn whisper_context_cache() -> &'static Mutex<HashMap<String, Arc<whisper_rs::WhisperContext>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<whisper_rs::WhisperContext>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct WhisperProvider {
    model_path: PathBuf,
    #[allow(dead_code)]
    models_dir: PathBuf,
    model_id: String,
    ctx: Option<Arc<whisper_rs::WhisperContext>>,
}

impl WhisperProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("whisper");

        let model_id = sanitize_model_id(selected_model_id.unwrap_or("base.en"));
        let model_path = models_dir.join(format!("ggml-{}.bin", model_id));

        // Check cache first without loading
        let ctx = if model_path.exists() {
            if let Ok(cache) = whisper_context_cache().lock() {
                cache.get(&model_id).cloned()
            } else {
                None
            }
        } else {
            None
        };

        Self {
            model_path,
            models_dir,
            model_id,
            ctx,
        }
    }

    fn model_spec(&self) -> WhisperModelSpec {
        whisper_model_spec(&self.model_id)
    }

    fn load_model(&self) -> Result<Arc<whisper_rs::WhisperContext>> {
        // Check cache first
        if let Ok(cache) = whisper_context_cache().lock() {
            if let Some(cached) = cache.get(&self.model_id).cloned() {
                return Ok(cached);
            }
        }

        tracing::info!("Loading Whisper model from {:?}", self.model_path);

        // Enable GPU acceleration on supported platforms
        let mut params = whisper_rs::WhisperContextParameters::default();

        // On macOS with Metal/CoreML support, use_gpu is automatically enabled
        // when whisper-rs is compiled with "metal" and "coreml" features
        #[cfg(target_os = "macos")]
        {
            params.use_gpu = true;
            params.flash_attn = true; // Flash attention for faster decoding
            tracing::info!(
                "Whisper: enabling GPU acceleration (Metal/CoreML) with flash attention"
            );
        }

        #[cfg(not(target_os = "macos"))]
        {
            // On non-macOS, GPU requires explicit CUDA/Vulkan setup
            // Default to CPU for broader compatibility
            params.use_gpu = false;
        }

        let ctx = Arc::new(
            whisper_rs::WhisperContext::new_with_params(&self.model_path.to_string_lossy(), params)
                .context("Failed to load Whisper model")?,
        );

        if let Ok(mut cache) = whisper_context_cache().lock() {
            cache.insert(self.model_id.clone(), Arc::clone(&ctx));
        }
        tracing::info!("Whisper model loaded successfully");
        Ok(ctx)
    }

    fn get_or_load_ctx(&self) -> Result<Arc<whisper_rs::WhisperContext>> {
        if let Some(ctx) = &self.ctx {
            return Ok(Arc::clone(ctx));
        }
        self.load_model()
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
        // Model is available if either already loaded in cache OR file exists
        self.ctx.is_some() || self.model_path.exists()
    }

    fn model_info(&self) -> ModelInfo {
        let spec = self.model_spec();
        ModelInfo {
            name: "Whisper".to_string(),
            version: spec.id.to_string(),
            size_mb: spec.size_mb,
            parameters: spec.parameters.to_string(),
            languages: vec![
                "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
                "sv", "it", "id", "hi", "fi", "vi",
            ]
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
            word_error_rate: Some(spec.wer),
            real_time_factor: Some(spec.real_time_factor),
            license: "MIT".to_string(),
            source_url: spec.url.to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let ctx = self.get_or_load_ctx()?;

        let start_time = std::time::Instant::now();

        tracing::info!("Loading audio file for Whisper: {:?}", audio_path);

        // Load and preprocess audio
        let raw_audio_data = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio file")?;

        // VAD pre-filtering: trim silence to speed up transcription
        let mut audio_data = if raw_audio_data.len() > 16000 {
            // Only trim if > 1 second of audio
            let trimmed = crate::audio::vad::trim_silence(&raw_audio_data, 16000, -40.0);
            if trimmed.is_empty() {
                raw_audio_data
            } else {
                let saved_ms = (raw_audio_data.len() - trimmed.len()) as f64 / 16.0;
                if saved_ms > 100.0 {
                    tracing::info!(
                        "VAD trimmed {:.0}ms of silence, processing {:.0}ms",
                        saved_ms,
                        trimmed.len() as f64 / 16.0
                    );
                }
                trimmed
            }
        } else {
            raw_audio_data
        };

        // Whisper requires > 1000ms of audio; pad with silence to 1.1s if needed
        let min_samples = (16000.0_f32 * 1.1).ceil() as usize;
        if !audio_data.is_empty() && audio_data.len() < min_samples {
            tracing::info!(
                "Whisper audio too short ({} samples / {:.0}ms), padding to {}ms",
                audio_data.len(),
                audio_data.len() as f64 / 16.0,
                min_samples as f64 / 16.0
            );
            audio_data.resize(min_samples, 0.0);
        }

        tracing::info!(
            "Whisper received {} samples (sample rate 16000, duration {:.2}s)",
            audio_data.len(),
            audio_data.len() as f64 / 16000.0
        );

        // Log audio statistics
        if !audio_data.is_empty() {
            let peak = audio_data.iter().fold(0.0_f32, |p, s| p.max(s.abs()));
            let rms =
                (audio_data.iter().map(|s| s * s).sum::<f32>() / audio_data.len() as f32).sqrt();
            tracing::info!("Whisper audio stats: peak={:.4}, rms={:.4}", peak, rms);
        }

        // Create state and configure
        let mut state = ctx
            .create_state()
            .context("Failed to create Whisper state")?;

        // Use beam search for better accuracy (5 beams is a good balance)
        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: 1.0, // Standard patience - higher values search more but slower
        });

        // Speed optimizations
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4);
        params.set_n_threads(std::cmp::min(num_threads, 8)); // Cap at 8 threads to avoid diminishing returns

        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(Some("en"));
        params.set_translate(false);

        // Anti-repetition and hallucination mitigation
        params.set_no_context(true); // Don't use previous context to prevent loop hallucinations
        params.set_entropy_thold(2.4); // Stricter entropy threshold
        params.set_logprob_thold(-1.0); // Stricter logprob threshold

        // Beam search patience for better accuracy on technical terms
        params.set_token_timestamps(true); // Enable token-level timestamps for better alignment

        // Run transcription
        state
            .full(params, &audio_data)
            .context("Failed to run Whisper transcription")?;

        let num_segments = state
            .full_n_segments()
            .context("Failed to get segment count")?;

        tracing::info!("Whisper produced {} segments", num_segments);

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
            "Whisper transcription completed: '{}' ({} segments in {}ms)",
            full_text,
            segments.len(),
            processing_time
        );

        Ok(TranscriptionResult {
            text: full_text,
            segments,
            language: "en".to_string(),
            confidence: 0.9,
            processing_time_ms: processing_time,
            model_name: format!("whisper-{}", self.model_id),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Whisper,
            actual_provider: AsrProviderType::Whisper,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join(format!("whisper_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data)?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    fn download_status(&self) -> DownloadStatus {
        if self.model_path.exists() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;

        let manager = DownloadManager::new()?;

        let model_name = self.model_id.as_str();

        let progress_callback = move |progress: crate::download::DownloadProgress| {
            progress_cb(progress.percentage as f32);
            tracing::info!(
                "Download progress: {:.1}% ({}/s)",
                progress.percentage,
                crate::download::format_bytes(progress.bytes_downloaded)
            );
        };

        manager
            .download_whisper_model(model_name, progress_callback)
            .await?;

        // Pre-load the model into cache after download
        let provider = Self::new(Some(model_name));
        if let Err(e) = provider.load_model() {
            tracing::error!("Failed to load model after download: {}", e);
        }

        Ok(())
    }
}

#[derive(Clone, Copy)]
struct WhisperModelSpec {
    id: &'static str,
    size_mb: f64,
    parameters: &'static str,
    wer: f64,
    real_time_factor: f64,
    url: &'static str,
}

fn sanitize_model_id(model_id: &str) -> String {
    match model_id {
        "tiny" => "tiny".to_string(),
        "tiny.en" => "tiny.en".to_string(),
        "base" => "base".to_string(),
        "base.en" => "base.en".to_string(),
        "small" => "small".to_string(),
        "small.en" => "small.en".to_string(),
        "medium" => "medium".to_string(),
        "medium.en" => "medium.en".to_string(),
        "large-v3-turbo" => "large-v3-turbo".to_string(),
        "large-v3" => "large-v3".to_string(),
        _ => "base.en".to_string(),
    }
}

fn whisper_model_spec(model_id: &str) -> WhisperModelSpec {
    match model_id {
        "tiny" => WhisperModelSpec {
            id: "tiny",
            size_mb: 75.0,
            parameters: "39M",
            wer: 18.0,
            real_time_factor: 0.2,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        },
        "tiny.en" => WhisperModelSpec {
            id: "tiny.en",
            size_mb: 75.0,
            parameters: "39M",
            wer: 15.0,
            real_time_factor: 0.2,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
        },
        "large-v3-turbo" => WhisperModelSpec {
            id: "large-v3-turbo",
            size_mb: 1620.0,
            parameters: "809M",
            wer: 6.4,
            real_time_factor: 0.7,
            url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        },
        "large-v3" => WhisperModelSpec {
            id: "large-v3",
            size_mb: 2900.0,
            parameters: "1550M",
            wer: 6.0,
            real_time_factor: 1.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        },
        "medium" => WhisperModelSpec {
            id: "medium",
            size_mb: 1500.0,
            parameters: "769M",
            wer: 8.0,
            real_time_factor: 1.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        },
        "medium.en" => WhisperModelSpec {
            id: "medium.en",
            size_mb: 1500.0,
            parameters: "769M",
            wer: 8.2,
            real_time_factor: 1.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
        },
        "small" => WhisperModelSpec {
            id: "small",
            size_mb: 466.0,
            parameters: "244M",
            wer: 10.0,
            real_time_factor: 0.8,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        },
        "small.en" => WhisperModelSpec {
            id: "small.en",
            size_mb: 466.0,
            parameters: "244M",
            wer: 10.4,
            real_time_factor: 0.8,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
        },
        "base" => WhisperModelSpec {
            id: "base",
            size_mb: 142.0,
            parameters: "74M",
            wer: 14.0,
            real_time_factor: 0.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        },
        _ => WhisperModelSpec {
            id: "base.en",
            size_mb: 142.0,
            parameters: "74M",
            wer: 11.0,
            real_time_factor: 0.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        },
    }
}
