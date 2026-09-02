use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment,
    TranscriptionOptions, TranscriptionResult, VocabularyHint,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

struct TempWav {
    path: PathBuf,
}

impl TempWav {
    fn create(audio_data: &[u8]) -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "plainsong-dictation-whisper-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let guard = Self { path };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&guard.path)
            .context("Failed to create temporary Whisper audio")?;
        file.write_all(audio_data)
            .context("Failed to write temporary Whisper audio")?;
        Ok(guard)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempWav {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = ?self.path, "Failed to remove temporary Whisper audio: {error}");
            }
        }
    }
}

fn whisper_context_cache() -> &'static Mutex<HashMap<String, Arc<whisper_rs::WhisperContext>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<whisper_rs::WhisperContext>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn whisper_model_load_gate(model_id: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut gates = gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        gates
            .entry(model_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

pub(crate) fn clear_cached_model(model_id: &str) {
    if let Ok(mut cache) = whisper_context_cache().lock() {
        if cache.remove(model_id).is_some() {
            tracing::info!("Cleared cached Whisper context for model {}", model_id);
        }
    }
}

pub(crate) fn clear_all_cached_models() {
    let mut cache = whisper_context_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache.is_empty() {
        tracing::info!(
            "Releasing {} cached Whisper context(s) before shutdown",
            cache.len()
        );
        cache.clear();
    }
}

#[derive(Clone)]
pub struct WhisperProvider {
    model_path: PathBuf,
    model_id: String,
    ctx: Option<Arc<whisper_rs::WhisperContext>>,
}

impl WhisperProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let models_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
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

        // Prewarm, live preview, and the final decode may reach this method at
        // the same time. Serialize loads for one model and re-check after
        // acquiring the gate so only one Metal context is created.
        let load_gate = whisper_model_load_gate(&self.model_id);
        let _load_guard = load_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(cache) = whisper_context_cache().lock() {
            if let Some(cached) = cache.get(&self.model_id).cloned() {
                return Ok(cached);
            }
        }

        if !crate::download::is_whisper_model_artifact_trusted(&self.model_id, &self.model_path) {
            anyhow::bail!(
                "Whisper model '{}' has not passed Plainsong integrity verification. Re-download it from Settings.",
                self.model_id
            );
        }

        tracing::info!("Loading Whisper model from {:?}", self.model_path);

        // Enable GPU acceleration on supported platforms
        let mut params = whisper_rs::WhisperContextParameters::default();

        // On macOS, use_gpu is automatically enabled when whisper-rs is
        // compiled with the "metal" feature. CoreML is deliberately not enabled
        // — see the whisper-gpu feature in Cargo.toml for why.
        #[cfg(target_os = "macos")]
        {
            params.use_gpu = true;
            params.flash_attn = true; // Flash attention for faster decoding
            tracing::info!("Whisper: enabling GPU acceleration (Metal) with flash attention");
        }

        #[cfg(not(target_os = "macos"))]
        {
            // On non-macOS, GPU requires explicit CUDA/Vulkan setup
            // Default to CPU for broader compatibility
            params.use_gpu = false;
        }

        let ctx = Arc::new(
            whisper_rs::WhisperContext::new_with_params(&self.model_path, params)
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

    async fn transcribe_owned_path(
        &self,
        audio_path: PathBuf,
        temp_wav: Option<TempWav>,
        vocabulary_hint: Option<VocabularyHint>,
    ) -> Result<TranscriptionResult> {
        let ctx = self.get_or_load_ctx()?;
        let model_id = self.model_id.clone();
        tokio::task::spawn_blocking(move || {
            let result =
                transcribe_blocking(&ctx, &model_id, &audio_path, vocabulary_hint.as_ref());
            // Tokio cannot cancel a running blocking closure. Keeping the guard in
            // this closure leaves the WAV readable until inference actually exits,
            // while still unlinking it after an async caller is cancelled.
            drop(temp_wav);
            result
        })
        .await
        .context("Whisper inference task panicked")?
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
            || crate::download::is_whisper_model_artifact_trusted(&self.model_id, &self.model_path)
    }

    async fn prewarm(&self) -> Result<()> {
        // Load the model into the global context cache on a blocking thread so
        // the first utterance after dictation start doesn't pay a cold load.
        // This is an acknowledged readiness operation: a missing or invalid
        // model must fail here instead of letting the UI claim it is ready.
        if !self.model_path.exists() {
            anyhow::bail!(
                "Whisper model '{}' is not downloaded. Download it from Settings before dictating.",
                self.model_id
            );
        }
        let provider = self.clone();
        tokio::task::spawn_blocking(move || provider.load_model().map(|_| ()))
            .await
            .context("Whisper model warmup task panicked")??;
        Ok(())
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
        // whisper.cpp decoding is a multi-second, fully synchronous CPU/GPU
        // burn. Running it inline blocked a tokio worker for the whole decode,
        // which the live meeting preview cannot afford now that it decodes a
        // span every few seconds while capture, mixing and event emission all
        // want the runtime. Every other local provider here already wraps its
        // inference in `spawn_blocking`; this brings Whisper in line. The
        // Whisper *state* is created inside the closure so only the
        // `Arc<WhisperContext>` (`Send + Sync`) crosses the boundary.
        self.transcribe_owned_path(audio_path.to_path_buf(), None, None)
            .await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_wav = TempWav::create(audio_data)?;
        let temp_path = temp_wav.path().to_path_buf();
        self.transcribe_owned_path(temp_path, Some(temp_wav), None)
            .await
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let temp_wav = TempWav::create(audio_data)?;
        let temp_path = temp_wav.path().to_path_buf();
        self.transcribe_owned_path(temp_path, Some(temp_wav), options.vocabulary_hint.clone())
            .await
    }

    fn download_status(&self) -> DownloadStatus {
        if crate::download::is_whisper_model_artifact_trusted(&self.model_id, &self.model_path) {
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

/// The synchronous half of [`WhisperProvider::transcribe`], run on a blocking
/// thread. Audio loading, VAD trimming and the beam search are all CPU-bound
/// and must stay off the async runtime's workers.
fn transcribe_blocking(
    ctx: &Arc<whisper_rs::WhisperContext>,
    model_id: &str,
    audio_path: &Path,
    vocabulary_hint: Option<&VocabularyHint>,
) -> Result<TranscriptionResult> {
    let start_time = std::time::Instant::now();

    tracing::info!("Loading audio file for Whisper: {:?}", audio_path);

    // Load and preprocess audio
    let raw_audio_data =
        crate::audio::utils::load_audio_file(audio_path).context("Failed to load audio file")?;

    // VAD pre-filtering: trim silence to speed up transcription
    let mut audio_data = if raw_audio_data.len() > 16000 {
        // Only trim if > 1 second of audio
        let trimmed = crate::audio::vad::trim_silence(&raw_audio_data, 16000, -40.0);
        if trimmed.is_empty() {
            raw_audio_data
        } else {
            let saved_ms = raw_audio_data.len().saturating_sub(trimmed.len()) as f64 / 16.0;
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

    // Speech that survived the VAD trim, before the padding below: what the
    // prompt gate and the echo filter reason about.
    let voiced_samples = audio_data.len();

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

    let audio_stats = PromptAudioStats::measure(&audio_data, voiced_samples);
    if !audio_data.is_empty() {
        tracing::info!(
            "Whisper audio stats: peak={:.4}, rms={:.4}, voiced={:.2}s",
            audio_stats.peak,
            audio_stats.rms,
            audio_stats.voiced_seconds()
        );
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
    // English-only models (".en") are forced to English; multilingual models
    // auto-detect the spoken language rather than assuming English.
    let english_only = model_id.ends_with(".en");
    params.set_language(if english_only { Some("en") } else { None });
    params.set_translate(false);

    // Anti-repetition and hallucination mitigation
    params.set_no_context(true); // Don't use previous context to prevent loop hallucinations
    params.set_entropy_thold(2.4); // Stricter entropy threshold
    params.set_logprob_thold(-1.0); // Stricter logprob threshold

    // Beam search patience for better accuracy on technical terms
    params.set_token_timestamps(true); // Enable token-level timestamps for better alignment

    // Personal-dictionary vocabulary bias, as whisper's initial prompt. Only
    // attached when there is something in it: an empty prompt buys nothing
    // and a blank one is a known way to make small models drift. The
    // `set_no_context(true)` above does not discard it — whisper.cpp clears
    // the rolling context *before* seeding the initial prompt, so the first
    // decode window is conditioned on these spellings (checked against
    // whisper_full_with_state in the vendored whisper.cpp).
    //
    // Withheld on near-silent or sub-half-second audio: with nothing to
    // transcribe, a prompted decoder's cheapest output is the prompt itself,
    // so a silent hotkey tap could type "Vocabulary:" or a bare dictionary
    // term into the target. The gate is energy + voiced duration, measured
    // after the VAD trim (whisper-rs 0.16 exposes no no-speech probability).
    let mut prompted_hint: Option<&VocabularyHint> = None;
    if let Some(hint) = vocabulary_hint {
        let prompt = sanitize_initial_prompt(&hint.as_prompt());
        if prompt.is_empty() {
            // Nothing survived sanitising; behave as if no hint was given.
        } else if !audio_stats.carries_enough_speech_for_a_prompt() {
            tracing::info!(
                "Whisper initial prompt withheld: {:.2}s voiced at rms {:.4} is too little audio to prompt safely",
                audio_stats.voiced_seconds(),
                audio_stats.rms
            );
        } else {
            tracing::info!(
                "Whisper initial prompt carries a {}-char vocabulary hint ({} terms)",
                prompt.chars().count(),
                hint.terms().len()
            );
            params.set_initial_prompt(&prompt);
            prompted_hint = Some(hint);
        }
    }

    // Run transcription
    state
        .full(params, &audio_data)
        .context("Failed to run Whisper transcription")?;

    let num_segments = state.full_n_segments();

    // Report the actual language: forced "en" for English-only models,
    // otherwise the language Whisper detected during decoding.
    let detected_language = if english_only {
        "en".to_string()
    } else {
        let lang_id = state.full_lang_id_from_state();
        whisper_rs::get_lang_str(lang_id)
            .unwrap_or("en")
            .to_string()
    };

    tracing::info!("Whisper produced {} segments", num_segments);

    let mut segments = Vec::new();
    let mut full_text = String::new();

    for i in 0..num_segments {
        let segment = state
            .get_segment(i)
            .ok_or_else(|| anyhow::anyhow!("Failed to get Whisper segment {}", i))?;
        let text = segment.to_str().context("Failed to get segment text")?;
        let start = segment.start_timestamp();
        let end = segment.end_timestamp();

        segments.push(TranscriptSegment {
            start_time: start as f64 / 100.0, // Convert from centiseconds to seconds
            end_time: end as f64 / 100.0,
            text: text.trim().to_string(),
            confidence: 0.9, // whisper-rs doesn't provide per-segment confidence
        });

        if !full_text.is_empty() {
            full_text.push(' ');
        }
        full_text.push_str(text.trim());
    }

    // Second line of defence behind the gate above: audio quiet or short
    // enough to be a tap rather than speech, and an output that is nothing
    // but the hint (the frame word, hint terms, or both) — that is the prompt
    // echoing, not the user speaking. Dropped rather than delivered.
    let vocabulary_hint_terms_applied = prompted_hint.map(|hint| hint.terms().len()).unwrap_or(0);
    if let Some(hint) = prompted_hint {
        if prompt_echo_should_be_dropped(&full_text, hint, &audio_stats) {
            tracing::warn!(
                "Whisper output only echoed the vocabulary hint on weak audio ({:.2}s voiced, rms {:.4}); dropping '{}'",
                audio_stats.voiced_seconds(),
                audio_stats.rms,
                full_text
            );
            full_text.clear();
            segments.clear();
        }
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
        language: detected_language,
        confidence: 0.9,
        processing_time_ms: processing_time,
        model_name: format!("whisper-{}", model_id),
        model_id: model_id.to_string(),
        requested_provider: AsrProviderType::Whisper,
        actual_provider: AsrProviderType::Whisper,
        requested_engine: Some("provider_default".to_string()),
        actual_engine: Some("provider_default".to_string()),
        optimization_applied: false,
        fallback_reason: None,
        vocabulary_hint_terms_applied,
    })
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
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
        },
        "tiny.en" => WhisperModelSpec {
            id: "tiny.en",
            size_mb: 75.0,
            parameters: "39M",
            wer: 15.0,
            real_time_factor: 0.2,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin",
        },
        "large-v3-turbo" => WhisperModelSpec {
            id: "large-v3-turbo",
            size_mb: 1620.0,
            parameters: "809M",
            wer: 6.4,
            real_time_factor: 0.7,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin",
        },
        "large-v3" => WhisperModelSpec {
            id: "large-v3",
            size_mb: 2900.0,
            parameters: "1550M",
            wer: 6.0,
            real_time_factor: 1.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin",
        },
        "medium" => WhisperModelSpec {
            id: "medium",
            size_mb: 1500.0,
            parameters: "769M",
            wer: 8.0,
            real_time_factor: 1.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium.bin",
        },
        "medium.en" => WhisperModelSpec {
            id: "medium.en",
            size_mb: 1500.0,
            parameters: "769M",
            wer: 8.2,
            real_time_factor: 1.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium.en.bin",
        },
        "small" => WhisperModelSpec {
            id: "small",
            size_mb: 466.0,
            parameters: "244M",
            wer: 10.0,
            real_time_factor: 0.8,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
        },
        "small.en" => WhisperModelSpec {
            id: "small.en",
            size_mb: 466.0,
            parameters: "244M",
            wer: 10.4,
            real_time_factor: 0.8,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en.bin",
        },
        "base" => WhisperModelSpec {
            id: "base",
            size_mb: 142.0,
            parameters: "74M",
            wer: 14.0,
            real_time_factor: 0.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
        },
        _ => WhisperModelSpec {
            id: "base.en",
            size_mb: 142.0,
            parameters: "74M",
            wer: 11.0,
            real_time_factor: 0.5,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
        },
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn temporary_wav_is_removed_on_drop() {
        let temp_wav = TempWav::create(b"not a real wav, but sufficient for lifecycle testing")
            .expect("temporary audio should be created");
        let path = temp_wav.path().to_path_buf();
        assert!(path.exists());

        drop(temp_wav);

        assert!(!path.exists());
    }

    #[test]
    fn model_load_gate_is_shared_per_model() {
        let first = whisper_model_load_gate("base.en");
        let second = whisper_model_load_gate("base.en");
        let other = whisper_model_load_gate("small.en");

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }
}

/// `FullParams::set_initial_prompt` builds a `CString` and panics on an
/// interior NUL. Dictionary text is user-supplied (typed, CSV-imported, or
/// learned from corrections), so strip control characters instead of
/// trusting it. Everything else is passed through untouched.
fn sanitize_initial_prompt(prompt: &str) -> String {
    prompt
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// What the prompt gate and the echo filter measure about the decoded
/// audio: overall level and how much speech survived the VAD trim.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PromptAudioStats {
    peak: f32,
    rms: f32,
    voiced_samples: usize,
}

impl PromptAudioStats {
    const SAMPLE_RATE: f32 = 16_000.0;
    /// Below this RMS the clip is silence or a noise floor, not a voice.
    /// Speech through a normal mic sits around 0.02–0.1; a quiet voice near
    /// 0.01; an empty room around 0.001–0.003.
    const PROMPT_MIN_RMS: f32 = 0.004;
    /// Less voiced audio than this is a tap or a breath, not an utterance.
    const PROMPT_MIN_VOICED_SECONDS: f32 = 0.5;
    /// The echo filter's "weak audio" band: quiet enough, or short enough,
    /// that an output made only of hint words is more likely the prompt
    /// than the user.
    const ECHO_MAX_RMS: f32 = 0.012;
    const ECHO_MAX_VOICED_SECONDS: f32 = 1.0;

    fn measure(audio: &[f32], voiced_samples: usize) -> Self {
        if audio.is_empty() {
            return Self {
                peak: 0.0,
                rms: 0.0,
                voiced_samples: 0,
            };
        }
        let peak = audio.iter().fold(0.0_f32, |p, s| p.max(s.abs()));
        let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32).sqrt();
        Self {
            peak,
            rms,
            voiced_samples,
        }
    }

    fn voiced_seconds(&self) -> f32 {
        self.voiced_samples as f32 / Self::SAMPLE_RATE
    }

    /// Whether attaching the vocabulary prompt is safe: enough level and
    /// enough voiced audio that the decoder has speech to condition on.
    fn carries_enough_speech_for_a_prompt(&self) -> bool {
        self.rms >= Self::PROMPT_MIN_RMS && self.voiced_seconds() >= Self::PROMPT_MIN_VOICED_SECONDS
    }

    /// Weak enough that a hint-only output is treated as prompt echo.
    fn is_weak_enough_for_prompt_echo(&self) -> bool {
        self.rms < Self::ECHO_MAX_RMS || self.voiced_seconds() < Self::ECHO_MAX_VOICED_SECONDS
    }
}

/// Lower-cased alphanumeric words (apostrophes and hyphens kept) of a piece
/// of text, so "Vocabulary: Plainsong, hotkey." and "plainsong HOTKEY"
/// compare equal.
fn prompt_words(text: &str) -> Vec<String> {
    text.split(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '\'' | '-')))
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase())
        .collect()
}

/// Whether `text` consists of nothing but the hint: the frame word and/or
/// words from the hint's terms. An empty output is not an echo.
fn output_is_only_prompt_echo(text: &str, hint: &VocabularyHint) -> bool {
    let words = prompt_words(text);
    if words.is_empty() {
        return false;
    }
    let mut allowed: std::collections::HashSet<String> =
        prompt_words("Vocabulary").into_iter().collect();
    for term in hint.terms() {
        allowed.extend(prompt_words(term));
    }
    words.iter().all(|word| allowed.contains(word))
}

/// The post-filter decision: prompt echo on weak audio is dropped; the same
/// hint-only text on clearly voiced audio is the user actually saying a
/// dictionary word and is kept.
fn prompt_echo_should_be_dropped(
    text: &str,
    hint: &VocabularyHint,
    audio: &PromptAudioStats,
) -> bool {
    audio.is_weak_enough_for_prompt_echo() && output_is_only_prompt_echo(text, hint)
}

#[cfg(test)]
mod prompt_gate_tests {
    use super::{output_is_only_prompt_echo, prompt_echo_should_be_dropped, PromptAudioStats};
    use crate::asr::VocabularyHint;

    fn hint(terms: &[&str]) -> VocabularyHint {
        VocabularyHint::new(terms.iter().map(|t| (*t).to_string()).collect()).expect("terms")
    }

    /// Deterministic noise (an LCG) at a given amplitude — no fixture file.
    fn noise(seconds: f32, amplitude: f32) -> Vec<f32> {
        let mut state: u32 = 0x1234_5678;
        (0..(seconds * 16_000.0) as usize)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let unit = (state >> 8) as f32 / (1u32 << 24) as f32; // 0..1
                (unit * 2.0 - 1.0) * amplitude
            })
            .collect()
    }

    /// A voiced-sounding tone at speech level.
    fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
        (0..(seconds * 16_000.0) as usize)
            .map(|i| (i as f32 * 220.0 * std::f32::consts::TAU / 16_000.0).sin() * amplitude)
            .collect()
    }

    #[test]
    fn silence_never_gets_a_prompt() {
        let silence = vec![0.0_f32; 2 * 16_000];
        let stats = PromptAudioStats::measure(&silence, silence.len());
        assert!(!stats.carries_enough_speech_for_a_prompt());
        // Padded-to-1.1s silence from an empty tap is the same answer.
        let padded = vec![0.0_f32; 17_600];
        assert!(!PromptAudioStats::measure(&padded, 0).carries_enough_speech_for_a_prompt());
    }

    #[test]
    fn a_short_noise_tap_or_a_faint_noise_floor_never_gets_a_prompt() {
        // Loud but only 0.3 s of it: a key tap, not an utterance.
        let tap = noise(0.3, 0.05);
        assert!(!PromptAudioStats::measure(&tap, tap.len()).carries_enough_speech_for_a_prompt());
        // Long but at an empty-room level.
        let floor = noise(2.0, 0.003);
        let stats = PromptAudioStats::measure(&floor, floor.len());
        assert!(
            stats.rms < PromptAudioStats::PROMPT_MIN_RMS,
            "rms {}",
            stats.rms
        );
        assert!(!stats.carries_enough_speech_for_a_prompt());
    }

    #[test]
    fn speech_level_audio_of_normal_length_gets_the_prompt() {
        let speech = tone(1.5, 0.05);
        let stats = PromptAudioStats::measure(&speech, speech.len());
        assert!(stats.rms > 0.03, "rms {}", stats.rms);
        assert!(stats.carries_enough_speech_for_a_prompt());
    }

    #[test]
    fn output_made_only_of_the_frame_or_hint_terms_is_an_echo() {
        let hint = hint(&["Plainsong", "hotkey", "Jonathan Reed"]);
        for echo in [
            "Vocabulary: Plainsong, hotkey, Jonathan Reed.",
            "Vocabulary:",
            "Plainsong",
            "plainsong hotkey",
            "Jonathan",
        ] {
            assert!(output_is_only_prompt_echo(echo, &hint), "{echo}");
        }
        for real in ["Plainsong is ready", "press the hotkey now", "hello", ""] {
            assert!(!output_is_only_prompt_echo(real, &hint), "{real}");
        }
    }

    #[test]
    fn echo_is_dropped_only_on_weak_audio() {
        let hint = hint(&["Plainsong"]);
        // Quiet and short: the classic silent-tap echo.
        let weak = PromptAudioStats::measure(&noise(0.6, 0.012), 9_600);
        assert!(prompt_echo_should_be_dropped("Plainsong", &hint, &weak));
        // Clearly voiced, two seconds: the user said the word. Keep it.
        let voiced = tone(2.0, 0.05);
        let strong = PromptAudioStats::measure(&voiced, voiced.len());
        assert!(!prompt_echo_should_be_dropped("Plainsong", &hint, &strong));
        // Weak audio but real words beyond the hint: also kept.
        assert!(!prompt_echo_should_be_dropped(
            "Plainsong is ready",
            &hint,
            &weak
        ));
    }
}

#[cfg(test)]
mod initial_prompt_tests {
    use super::sanitize_initial_prompt;

    #[test]
    fn interior_nul_and_control_characters_never_reach_whisper() {
        // A NUL would panic inside whisper-rs; a newline would be a second
        // "line" of prompt the model was never meant to see.
        assert_eq!(
            sanitize_initial_prompt("Plainsong,\u{0} Kubernetes\n, OpenAI "),
            "Plainsong, Kubernetes, OpenAI"
        );
        assert_eq!(sanitize_initial_prompt("\u{0}\t"), "");
    }

    #[test]
    fn ordinary_terms_pass_through_unchanged() {
        assert_eq!(
            sanitize_initial_prompt("Plainsong, Céline, naïve, C++"),
            "Plainsong, Céline, naïve, C++"
        );
    }
}
