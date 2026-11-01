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
            "plainsong-whisper-input-pid-{}-{}.wav",
            std::process::id(),
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
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    static REGISTRATION: OnceLock<Arc<crate::model_residency::IdleModel>> = OnceLock::new();
    REGISTRATION.get_or_init(|| {
        crate::model_residency::register(3 * 1024 * 1024 * 1024, move |policy| {
            if policy.release_idle() {
                crate::model_residency::release_shared_cache(cache);
            }
        })
    });
    cache
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

#[cfg(test)]
pub(crate) fn is_model_cached(model_id: &str) -> bool {
    whisper_context_cache()
        .lock()
        .map(|cache| cache.contains_key(model_id))
        .unwrap_or(false)
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

        Self {
            model_path,
            model_id,
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

        let digest = crate::download::whisper_model_expected_sha256(&self.model_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown Whisper model: {}", self.model_id))?;
        let model_id = &self.model_id;
        let verified_model =
            crate::download::open_verified_model_artifact(&self.model_path, &digest)
                .with_context(|| {
                    format!("Whisper model '{model_id}' could not be verified. Download it again in Settings > Models.")
                })?;

        let _model_load = crate::llm::local_model_load::admit_asr(
            &[verified_model.load_path()],
            AsrProviderType::Whisper,
            &self.model_id,
            crate::llm::local_model_load::NativeAllocation::Constructor,
        )?;

        tracing::info!("Loading Whisper model from {:?}", self.model_path);

        // Enable GPU acceleration on supported platforms
        let mut params = whisper_rs::WhisperContextParameters::default();

        // On macOS, use_gpu is automatically enabled when whisper-rs is
        // compiled with the "metal" feature. CoreML is deliberately not enabled
        // — see the whisper-gpu feature in Cargo.toml for why.
        #[cfg(target_os = "macos")]
        {
            params.use_gpu = true;
            // The pinned Turbo model preserves more discussion detail without
            // flash attention. See docs/evals/whisper-turbo-decoding-2026-10-05.
            params.flash_attn = self.model_id != "large-v3-turbo";
            tracing::info!(
                flash_attention = params.flash_attn,
                "Whisper: enabling GPU acceleration (Metal)"
            );
        }

        #[cfg(not(target_os = "macos"))]
        {
            // On non-macOS, GPU requires explicit CUDA/Vulkan setup
            // Default to CPU for broader compatibility
            params.use_gpu = false;
        }

        let ctx = Arc::new(verified_model.load(|path| {
            whisper_rs::WhisperContext::new_with_params(path, params)
                .context("Failed to load Whisper model")
        })?);

        if let Ok(mut cache) = whisper_context_cache().lock() {
            cache.insert(self.model_id.clone(), Arc::clone(&ctx));
        }
        tracing::info!("Whisper model loaded successfully");
        Ok(ctx)
    }

    fn get_or_load_ctx(&self) -> Result<Arc<whisper_rs::WhisperContext>> {
        self.load_model()
    }

    async fn transcribe_owned_path(
        &self,
        audio_path: PathBuf,
        temp_wav: Option<TempWav>,
        vocabulary_hint: Option<VocabularyHint>,
        translate_to_english: bool,
        language: Option<String>,
    ) -> Result<TranscriptionResult> {
        let language =
            normalized_whisper_language(language.as_deref(), self.model_id.ends_with(".en"))?;
        #[cfg(test)]
        let stages = super::stage_timing::current();
        #[cfg(test)]
        let runtime_wait = std::time::Instant::now();
        let ctx = self.get_or_load_ctx()?;
        #[cfg(test)]
        super::stage_timing::record(&stages, "runtimeLock", runtime_wait);
        let model_id = self.model_id.clone();
        let model_path = self.model_path.clone();
        #[cfg(test)]
        let queued = std::time::Instant::now();
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            super::stage_timing::record(&stages, "workerQueue", queued);
            #[cfg(test)]
            let admission = std::time::Instant::now();
            let host_bytes = whisper_audio_host_bytes(&audio_path)?;
            let _working = crate::llm::local_model_load::admit_asr(
                &[&model_path],
                AsrProviderType::Whisper,
                &model_id,
                crate::llm::local_model_load::NativeAllocation::Inference { host_bytes },
            )?;
            #[cfg(test)]
            super::stage_timing::record(&stages, "admission", admission);
            let result = transcribe_blocking(
                &ctx,
                &model_id,
                &audio_path,
                vocabulary_hint.as_ref(),
                translate_to_english,
                language.as_deref(),
                #[cfg(test)]
                &stages,
            );
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
        crate::download::is_whisper_model_artifact_installed(&self.model_id, &self.model_path)
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
        self.transcribe_owned_path(audio_path.to_path_buf(), None, None, false, None)
            .await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_wav = TempWav::create(audio_data)?;
        let temp_path = temp_wav.path().to_path_buf();
        self.transcribe_owned_path(temp_path, Some(temp_wav), None, false, None)
            .await
    }

    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        self.transcribe_owned_path(
            audio_path.to_path_buf(),
            None,
            options.vocabulary_hint.clone(),
            options.translate_to_english,
            options.language.clone(),
        )
        .await
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let temp_wav = TempWav::create(audio_data)?;
        let temp_path = temp_wav.path().to_path_buf();
        self.transcribe_owned_path(
            temp_path,
            Some(temp_wav),
            options.vocabulary_hint.clone(),
            options.translate_to_english,
            options.language.clone(),
        )
        .await
    }

    fn download_status(&self) -> DownloadStatus {
        if crate::download::is_whisper_model_artifact_installed(&self.model_id, &self.model_path) {
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

        // Downloading verifies files. Loading belongs to the selected model's
        // resource-checked warmup or an explicit transcription request.
        Ok(())
    }
}

// Avoid changing the decoder input for a negligible saving. Even one VAD
// frame can change numeric tokenization while saving no useful inference time.
fn normalized_whisper_language(
    language: Option<&str>,
    english_only: bool,
) -> Result<Option<String>> {
    let Some(raw) = language
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
    else {
        return Ok(None);
    };
    // whisper-rs converts this to a CString and panics on embedded NUL.
    anyhow::ensure!(
        !raw.contains('\0'),
        "Whisper language contains an invalid character"
    );
    let base = raw
        .split(['-', '_'])
        .next()
        .unwrap_or(raw)
        .to_ascii_lowercase();
    let id = whisper_rs::get_lang_id(&base)
        .ok_or_else(|| anyhow::anyhow!("Whisper does not support the selected language '{raw}'"))?;
    let canonical = whisper_rs::get_lang_str(id)
        .ok_or_else(|| anyhow::anyhow!("Whisper language mapping is unavailable"))?;
    anyhow::ensure!(
        !english_only || canonical == "en",
        "This English-only Whisper model cannot transcribe '{raw}'; select a multilingual model"
    );
    Ok(Some(canonical.to_string()))
}

fn whisper_audio_host_bytes(path: &Path) -> Result<u64> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if extension.eq_ignore_ascii_case("wav") {
        let reader =
            hound::WavReader::open(path).context("Failed to inspect Whisper WAV metadata")?;
        whisper_audio_buffer_bytes(reader.spec(), u64::from(reader.len()), 0)
    } else if extension.eq_ignore_ascii_case("pcm") || extension.eq_ignore_ascii_case("raw") {
        let source_bytes = std::fs::metadata(path)
            .context("Failed to inspect Whisper PCM metadata")?
            .len();
        anyhow::ensure!(
            source_bytes.is_multiple_of(2),
            "PCM audio contains an incomplete 16-bit sample"
        );
        whisper_audio_buffer_bytes(
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
            source_bytes / 2,
            source_bytes,
        )
    } else {
        anyhow::bail!("Unsupported audio format: {}", extension)
    }
}

fn whisper_audio_buffer_bytes(
    spec: hound::WavSpec,
    samples: u64,
    source_bytes: u64,
) -> Result<u64> {
    anyhow::ensure!(
        matches!(spec.channels, 1 | 2) && spec.sample_rate > 0,
        "Whisper audio requires mono or stereo audio and a nonzero sample rate"
    );
    anyhow::ensure!(
        matches!(
            (spec.sample_format, spec.bits_per_sample),
            (hound::SampleFormat::Int, 16 | 24 | 32) | (hound::SampleFormat::Float, 32)
        ),
        "Unsupported Whisper WAV sample format"
    );
    anyhow::ensure!(
        samples.is_multiple_of(u64::from(spec.channels)),
        "WAV audio contains an incomplete channel frame"
    );
    let frames = samples / u64::from(spec.channels);
    let normalized = frames
        .checked_mul(16_000)
        .and_then(|value| value.checked_add(u64::from(spec.sample_rate) - 1))
        .context("Whisper audio sample count is too large")?
        / u64::from(spec.sample_rate);
    // filter_map collection can hold old and new f32 allocations during growth.
    // Also cover retained source bytes, stereo conversion, resampling, and the
    // trim copy while its original normalized waveform remains live.
    let decoded = samples.checked_mul(12);
    let mono = if spec.channels == 2 {
        frames.checked_mul(4)
    } else {
        Some(0)
    };
    let resampled = if spec.sample_rate != 16_000 {
        normalized.checked_mul(4)
    } else {
        Some(0)
    };
    let trimmed = normalized.checked_mul(4);
    // Short audio may grow again to Whisper's existing 1.1-second minimum.
    let padding = if normalized > 0 && normalized < 17_600 {
        Some(17_600 * 8)
    } else {
        Some(0)
    };
    [decoded, mono, resampled, trimmed, padding]
        .into_iter()
        .try_fold(source_bytes, |total, bytes| total.checked_add(bytes?))
        .and_then(|bytes| bytes.checked_add(64 * 1024))
        .context("Whisper audio memory budget is too large")
}

#[cfg(test)]
mod audio_memory_budget_tests {
    use super::{whisper_audio_buffer_bytes, whisper_audio_host_bytes, TempWav};

    fn spec(channels: u16, sample_rate: u32) -> hound::WavSpec {
        hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    #[test]
    fn audio_budget_covers_decode_resample_and_trim_buffers() {
        const FIXED: u64 = 64 * 1024;
        for (channels, rate, expected) in [
            (1, 16_000, 153_600_000),
            (2, 16_000, 307_200_000),
            (1, 48_000, 422_400_000),
            (2, 48_000, 883_200_000),
        ] {
            let samples = 600 * u64::from(rate) * u64::from(channels);
            assert_eq!(
                whisper_audio_buffer_bytes(spec(channels, rate), samples, 0).unwrap(),
                expected + FIXED
            );
        }
    }

    #[test]
    fn audio_budget_covers_short_padding_and_raw_source_bytes() {
        assert_eq!(
            whisper_audio_buffer_bytes(spec(1, 16_000), 800, 0).unwrap(),
            800 * 16 + 17_600 * 8 + 64 * 1024
        );
        assert_eq!(
            whisper_audio_buffer_bytes(spec(1, 16_000), 32_000, 64_000).unwrap(),
            32_000 * 16 + 64_000 + 64 * 1024
        );
    }

    #[test]
    fn audio_budget_rejects_invalid_metadata_and_overflow() {
        assert!(whisper_audio_buffer_bytes(spec(0, 16_000), 10, 0).is_err());
        assert!(whisper_audio_buffer_bytes(spec(1, 0), 10, 0).is_err());
        assert!(whisper_audio_buffer_bytes(spec(3, 16_000), 12, 0).is_err());
        assert!(whisper_audio_buffer_bytes(spec(2, 16_000), 3, 0).is_err());
        for (format, bits) in [
            (hound::SampleFormat::Int, 8),
            (hound::SampleFormat::Float, 16),
        ] {
            let invalid = hound::WavSpec {
                sample_format: format,
                bits_per_sample: bits,
                ..spec(1, 16_000)
            };
            assert!(whisper_audio_buffer_bytes(invalid, 10, 0).is_err());
        }
        assert!(whisper_audio_buffer_bytes(spec(1, 16_000), u64::MAX, 0).is_err());
        assert!(whisper_audio_buffer_bytes(spec(1, 16_000), 32_000, u64::MAX).is_err());
    }

    fn fixture(extension: &str) -> TempWav {
        TempWav {
            path: std::env::temp_dir().join(format!(
                "plainsong-whisper-budget-{}.{}",
                uuid::Uuid::new_v4(),
                extension
            )),
        }
    }

    #[test]
    fn wav_budget_uses_declared_metadata_without_decoding_payload() {
        let file = fixture("wav");
        let mut writer = hound::WavWriter::create(&file.path, spec(1, 48_000)).unwrap();
        for _ in 0..48_000 {
            writer.write_sample(0_i16).unwrap();
        }
        writer.finalize().unwrap();
        let expected = whisper_audio_host_bytes(&file.path).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file.path)
            .unwrap()
            .set_len(44)
            .unwrap();
        assert_eq!(whisper_audio_host_bytes(&file.path).unwrap(), expected);
    }

    #[test]
    fn raw_budget_uses_even_length_metadata_and_rejects_unknown_formats() {
        for extension in ["pcm", "raw"] {
            let file = fixture(extension);
            std::fs::write(&file.path, [0_u8; 64]).unwrap();
            assert_eq!(
                whisper_audio_host_bytes(&file.path).unwrap(),
                whisper_audio_buffer_bytes(spec(1, 16_000), 32, 64).unwrap()
            );
            std::fs::write(&file.path, [0_u8; 63]).unwrap();
            assert!(whisper_audio_host_bytes(&file.path).is_err());
        }
        let file = fixture("wav");
        std::fs::write(&file.path, b"malformed header").unwrap();
        assert!(whisper_audio_host_bytes(&file.path).is_err());
        assert!(whisper_audio_host_bytes(&fixture("mp3").path).is_err());
    }
}

fn whisper_audio_trim_range(samples: &[f32]) -> std::ops::Range<usize> {
    if samples.len() <= 16_000 {
        return 0..samples.len();
    }
    // Energy alone cannot distinguish quiet words from silence. Preserve
    // quiet signal and remove only near-zero digital edges, retaining
    // 50ms of context. This also avoids decoding long digital preludes.
    let has_signal = |sample: &f32| !sample.is_finite() || sample.abs() > 1e-6;
    let Some(first) = samples.iter().position(has_signal) else {
        return 0..samples.len();
    };
    let last = samples.iter().rposition(has_signal).unwrap_or(first);
    let range = first.saturating_sub(800)..last.saturating_add(801).min(samples.len());
    if samples.len() - range.len() < 1_600 {
        0..samples.len()
    } else {
        range
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
    translate_to_english: bool,
    language: Option<&str>,
    #[cfg(test)] stages: &Option<super::stage_timing::Stages>,
) -> Result<TranscriptionResult> {
    let start_time = std::time::Instant::now();

    tracing::info!("Loading audio file for Whisper: {:?}", audio_path);

    // Load and preprocess audio
    let raw_audio_data =
        crate::audio::utils::load_audio_file(audio_path).context("Failed to load audio file")?;

    let trim_range = whisper_audio_trim_range(&raw_audio_data);
    let saved_ms = (raw_audio_data.len() - trim_range.len()) as f64 / 16.0;
    if saved_ms > 100.0 {
        tracing::info!(
            leading_trim_ms = trim_range.start as f64 / 16.0,
            "VAD trimmed {:.0}ms of silence, processing {:.0}ms",
            saved_ms,
            trim_range.len() as f64 / 16.0
        );
    }
    let mut audio_data = if trim_range.start == 0 && trim_range.end == raw_audio_data.len() {
        raw_audio_data
    } else {
        raw_audio_data[trim_range.clone()].to_vec()
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

    // English-only models (".en") are forced to English; multilingual models
    // auto-detect the spoken language rather than assuming English.
    let english_only = model_id.ends_with(".en");
    let translate_task = whisper_translate_task_enabled(model_id, translate_to_english);
    if translate_to_english && !translate_task {
        tracing::info!(
            "Whisper model '{}' is English-only and cannot run the translate task; transcribing as-is",
            model_id
        );
    }

    #[cfg(test)]
    super::stage_timing::record(stages, "audioPrepare", start_time);

    // One decode of `audio_data` on `state` with the given initial prompt.
    // The prompt policy may call this twice: once with the vocabulary prompt
    // and, if that decode only echoed the prompt on weak audio, once more
    // without it.
    let mut decoded_once = false;
    let mut prompted_language = None;
    let mut unprompted_language = None;
    let mut decode = |initial_prompt: Option<&str>| -> Result<WhisperDecodeOutput> {
        if decoded_once {
            state = ctx
                .create_state()
                .context("Failed to create independent Whisper verification state")?;
        }
        decoded_once = true;
        let mut params = build_whisper_params(english_only, translate_task, language);
        if let Some(prompt) = initial_prompt {
            tracing::info!(
                "Whisper initial prompt carries a {}-char vocabulary hint",
                prompt.chars().count()
            );
            params.set_initial_prompt(prompt);
        }
        #[cfg(test)]
        let inference = std::time::Instant::now();
        let result = state.full(params, &audio_data);
        #[cfg(test)]
        super::stage_timing::record(stages, "inference", inference);
        result.context("Failed to run Whisper transcription")?;
        let language_id = state.full_lang_id_from_state();
        if initial_prompt.is_some() {
            prompted_language = Some(language_id);
        } else {
            unprompted_language = Some(language_id);
        }
        collect_whisper_segments(&state)
    };
    let (output, vocabulary_hint_terms_applied) =
        decode_with_prompt_policy(vocabulary_hint, &audio_stats, &mut decode)?;
    let WhisperDecodeOutput {
        mut segments,
        text: full_text,
    } = output;
    restore_whisper_timeline(&mut segments, trim_range);

    // Report the actual language: forced "en" for English-only models,
    // otherwise the language Whisper detected during decoding.
    let detected_language = if audio_stats.is_digital_silence() {
        String::new()
    } else if english_only {
        "en".to_string()
    } else {
        let lang_id = if vocabulary_hint_terms_applied > 0 {
            prompted_language
        } else {
            unprompted_language
        }
        .unwrap_or(-1);
        whisper_rs::get_lang_str(lang_id)
            .unwrap_or("en")
            .to_string()
    };

    tracing::info!("Whisper produced {} segments", segments.len());

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
        confidence: if audio_stats.is_digital_silence() {
            0.0
        } else {
            0.9
        },
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
        measured_word_timestamps: false,
        speaker_turns: Vec::new(),
        vocabulary_candidates: Vec::new(),
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
    fn temporary_audio_names_its_live_owner_and_drops_normally() {
        let temporary = TempWav::create(b"test-owned bytes").unwrap();
        let path = temporary.path().to_path_buf();
        assert!(
            !path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("plainsong-dictation-"),
            "Older broad startup sweeps must not match new inputs"
        );
        assert_eq!(
            crate::dictation_temp_audio_owner_pid(path.file_name().unwrap().to_str().unwrap()),
            Some(std::process::id())
        );
        assert!(path.exists());
        drop(temporary);
        assert!(!path.exists());
    }

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

    fn is_digital_silence(&self) -> bool {
        self.peak.is_finite() && self.rms.is_finite() && self.peak <= 1e-6 && self.rms <= 1e-6
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

/// What to do with a prompted decode's output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptEchoDecision {
    /// The output is the user's words; return it.
    Keep,
    /// The output is nothing but the hint on weak audio — more likely the
    /// prompt echoing than the user. Decode the same audio again without
    /// the prompt and return *that*: a real quiet one-word dictation of a
    /// dictionary term survives (the plain decode hears it too), and true
    /// silence comes back empty.
    RedecodeWithoutPrompt,
}

/// The post-filter decision. Hint-only text on clearly voiced audio is the
/// user actually saying a dictionary word and is kept.
fn prompt_echo_decision(
    text: &str,
    hint: &VocabularyHint,
    audio: &PromptAudioStats,
) -> PromptEchoDecision {
    if audio.is_weak_enough_for_prompt_echo() && output_is_only_prompt_echo(text, hint) {
        PromptEchoDecision::RedecodeWithoutPrompt
    } else {
        PromptEchoDecision::Keep
    }
}

fn restore_whisper_timeline(segments: &mut [TranscriptSegment], source: std::ops::Range<usize>) {
    let offset = source.start as f64 / 16_000.0;
    let retained = (source.end - source.start) as f64 / 16_000.0;
    for segment in segments {
        let start = segment.start_time.clamp(0.0, retained);
        let end = segment.end_time.clamp(start, retained);
        segment.start_time = offset + start;
        segment.end_time = offset + end;
    }
}

/// One whisper decode's output, before the provider result is assembled.
#[derive(Debug, Clone)]
struct WhisperDecodeOutput {
    text: String,
    segments: Vec<TranscriptSegment>,
}

/// Whether a whisper.cpp decode may run the translate task for `model_id`.
///
/// The `.en` builds have no translate head -- whisper.cpp ignores the flag on
/// them and would still transcribe -- so the task is only requested for a
/// multilingual model. Pure so the routing decision is testable without a
/// model on disk; `build_whisper_params` takes its answer.
fn whisper_translate_task_enabled(model_id: &str, translate_to_english: bool) -> bool {
    translate_to_english && !model_id.trim().to_ascii_lowercase().ends_with(".en")
}

/// Shared decode parameters. Language and the initial prompt come from the request.
fn build_whisper_params<'a>(
    english_only: bool,
    translate_to_english: bool,
    language: Option<&'a str>,
) -> whisper_rs::FullParams<'a, 'static> {
    // Use beam search for better accuracy (5 beams is a good balance)
    configure_whisper_params(
        whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: 1.0, // Standard patience - higher values search more but slower
        }),
        english_only,
        translate_to_english,
        language,
    )
}

fn configure_whisper_params<'a>(
    mut params: whisper_rs::FullParams<'a, 'static>,
    english_only: bool,
    translate_to_english: bool,
    language: Option<&'a str>,
) -> whisper_rs::FullParams<'a, 'static> {
    // Speed optimizations
    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4);
    params.set_n_threads(std::cmp::min(num_threads, 8)); // Cap at 8 threads to avoid diminishing returns

    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(if english_only { Some("en") } else { language });
    // The translate task only exists on multilingual weights; the caller has
    // already folded the model check in (`whisper_translate_task_enabled`),
    // and this guard keeps a future caller from asking a `.en` build anyway.
    params.set_translate(translate_to_english && !english_only);

    // Anti-repetition and hallucination mitigation. `set_no_context(true)`
    // does not discard an initial prompt — whisper.cpp clears the rolling
    // context *before* seeding the prompt, so the first decode window is
    // still conditioned on it (checked against whisper_full_with_state in
    // the vendored whisper.cpp).
    params.set_no_context(true); // Don't use previous context to prevent loop hallucinations
    params.set_entropy_thold(2.4); // Stricter entropy threshold
    params.set_logprob_thold(-1.0); // Stricter logprob threshold

    // Beam search patience for better accuracy on technical terms
    params.set_token_timestamps(true); // Enable token-level timestamps for better alignment
    params
}

/// Reads the segments of the decode that just ran on `state`.
fn collect_whisper_segments(state: &whisper_rs::WhisperState) -> Result<WhisperDecodeOutput> {
    let num_segments = state.full_n_segments();
    let mut segments = Vec::new();
    let mut text = String::new();

    for i in 0..num_segments {
        let segment = state
            .get_segment(i)
            .ok_or_else(|| anyhow::anyhow!("Failed to get Whisper segment {}", i))?;
        let segment_text = segment.to_str().context("Failed to get segment text")?;
        let start = segment.start_timestamp();
        let end = segment.end_timestamp();

        segments.push(TranscriptSegment {
            start_time: start as f64 / 100.0, // Convert from centiseconds to seconds
            end_time: end as f64 / 100.0,
            text: segment_text.trim().to_string(),
            confidence: 0.9, // whisper-rs doesn't provide per-segment confidence
        });

        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(segment_text.trim());
    }

    Ok(WhisperDecodeOutput { text, segments })
}

fn hint_self_introduction_header(text: &str, hint: &VocabularyHint) -> Option<(usize, String)> {
    for term in hint.terms() {
        let term_lower = term.to_lowercase();
        let pattern = format!(r"(?i)^\s*{}\s*(?::|\bcolon\b)\s*", regex::escape(term));
        let Ok(matcher) = regex::Regex::new(&pattern) else {
            continue;
        };
        let Some(header) = matcher.find(text) else {
            continue;
        };
        let body = text[header.end()..].to_lowercase();
        for intro in ["i'm ", "i’m ", "i am ", "my name is "] {
            if let Some(rest) = body
                .strip_prefix(intro)
                .and_then(|rest| rest.strip_prefix(&term_lower))
            {
                if rest
                    .chars()
                    .next()
                    .is_none_or(|ch| !ch.is_alphanumeric() && !matches!(ch, '-' | '\'' | '’'))
                {
                    return Some((header.end(), rest.to_string()));
                }
            }
        }
    }
    None
}

#[cfg(test)]
fn has_hint_self_introduction_header(text: &str, hint: &VocabularyHint) -> bool {
    hint_self_introduction_header(text, hint).is_some()
}

fn header_verification_covers_body(hinted_tail: &str, unprompted: &str) -> bool {
    let unprompted = unprompted.trim_start().to_lowercase();
    let Some(after_intro) = ["i'm ", "i’m ", "i am ", "my name is "]
        .iter()
        .find_map(|intro| unprompted.strip_prefix(intro))
    else {
        return false;
    };
    let Some(end) = after_intro.find(['.', ',', ';', '!', '?']) else {
        return false;
    };
    if after_intro[..end].trim().is_empty() {
        return false;
    }
    let words = |text: &str| {
        prompt_words(text)
            .into_iter()
            .filter(|word| !matches!(word.as_str(), "a" | "an" | "the"))
            .collect::<Vec<_>>()
    };
    words(hinted_tail) == words(&after_intro[end + 1..])
}

fn remove_verified_hint_header(
    output: &WhisperDecodeOutput,
    hint: &VocabularyHint,
) -> Option<WhisperDecodeOutput> {
    let (end, _) = hint_self_introduction_header(&output.text, hint)?;
    let mut result = output.clone();
    if let Some(first) = result.segments.first_mut() {
        let (segment_end, _) = hint_self_introduction_header(&first.text, hint)?;
        first.text = first.text[segment_end..].to_string();
    }
    result.text = result.text[end..].to_string();
    Some(result)
}

fn has_unprompted_self_introduction_header(text: &str) -> bool {
    use std::sync::OnceLock;
    static HEADER: OnceLock<regex::Regex> = OnceLock::new();
    HEADER
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)^\s*[^:\n]{1,80}(?::|\bcolon\b)\s*(?:i['’]m\b|i am\b|my name is\b)",
            )
            .unwrap()
        })
        .is_match(text)
}

/// Runs `decode` under the vocabulary-prompt policy and returns the output
/// to deliver plus how many hint terms that output was decoded with.
///
/// The prompt is attached only when there is one and the audio carries
/// enough speech for it (`PromptAudioStats::carries_enough_speech_for_a_prompt`):
/// with nothing to transcribe, a prompted decoder's cheapest output is the
/// prompt itself, so a silent hotkey tap could type "Vocabulary:" or a bare
/// dictionary term. Behind that gate, a prompted output that is nothing but
/// hint words on weak audio is decoded once more without the prompt and
/// that result is returned — empty if it really was silence, the word if
/// the user quietly said it. `decode` is injected so this policy is tested
/// with a counted stub rather than a model.
fn decode_with_prompt_policy(
    vocabulary_hint: Option<&VocabularyHint>,
    audio_stats: &PromptAudioStats,
    decode: &mut dyn FnMut(Option<&str>) -> Result<WhisperDecodeOutput>,
) -> Result<(WhisperDecodeOutput, usize)> {
    if audio_stats.is_digital_silence() {
        return Ok((
            WhisperDecodeOutput {
                text: String::new(),
                segments: Vec::new(),
            },
            0,
        ));
    }
    let Some(hint) = vocabulary_hint else {
        return Ok((decode(None)?, 0));
    };
    let prompt = sanitize_initial_prompt(&hint.as_prompt());
    if prompt.is_empty() {
        // Nothing survived sanitising; behave as if no hint was given.
        return Ok((decode(None)?, 0));
    }
    if !audio_stats.carries_enough_speech_for_a_prompt() {
        tracing::info!(
            "Whisper initial prompt withheld: {:.2}s voiced at rms {:.4} is too little audio to prompt safely",
            audio_stats.voiced_seconds(),
            audio_stats.rms
        );
        return Ok((decode(None)?, 0));
    }

    let prompted = decode(Some(&prompt))?;
    if let Some((_, hinted_tail)) = hint_self_introduction_header(&prompted.text, hint) {
        match decode(None) {
            Ok(unprompted)
                if !has_unprompted_self_introduction_header(&unprompted.text)
                    && header_verification_covers_body(&hinted_tail, &unprompted.text) =>
            {
                if let Some(verified) = remove_verified_hint_header(&prompted, hint) {
                    tracing::info!("Whisper self-introduction header absent in independent recognition; retaining complete hinted body without the header");
                    return Ok((verified, hint.terms().len()));
                }
                return Ok((prompted, hint.terms().len()));
            }
            Ok(_) => return Ok((prompted, hint.terms().len())),
            Err(error) => {
                tracing::warn!("Whisper unprompted header verification failed; retaining original recognition: {}", error);
                return Ok((prompted, hint.terms().len()));
            }
        }
    }
    match prompt_echo_decision(&prompted.text, hint, audio_stats) {
        PromptEchoDecision::Keep => Ok((prompted, hint.terms().len())),
        PromptEchoDecision::RedecodeWithoutPrompt => {
            tracing::warn!(
                "Whisper output only echoed the vocabulary hint on weak audio ({:.2}s voiced, rms {:.4}); decoding again without the prompt: '{}'",
                audio_stats.voiced_seconds(),
                audio_stats.rms,
                prompted.text
            );
            Ok((decode(None)?, 0))
        }
    }
}

#[cfg(test)]
mod prompt_gate_tests {
    use super::{
        decode_with_prompt_policy, has_hint_self_introduction_header,
        has_unprompted_self_introduction_header, output_is_only_prompt_echo, prompt_echo_decision,
        PromptAudioStats, PromptEchoDecision, WhisperDecodeOutput,
    };
    use crate::asr::VocabularyHint;

    #[test]
    fn trimming_keeps_quiet_words_at_both_edges_of_louder_speech() {
        let mut samples = noise(0.4, 0.003);
        samples.extend(tone(2.0, 0.06));
        samples.extend(noise(1.2, 0.003));
        let energy_range = crate::audio::vad::silence_trim_range(&samples, 16_000, -40.0);
        assert!(energy_range.start > 0 && energy_range.end < samples.len());
        assert_eq!(super::whisper_audio_trim_range(&samples), 0..samples.len());
    }

    #[test]
    fn trimming_removes_digital_edges_without_removing_quiet_onset_or_tail() {
        let mut samples = vec![0.0; 90 * 16_000];
        let quiet_start = samples.len();
        samples.extend(noise(0.4, 0.003));
        samples.extend(tone(2.0, 0.06));
        samples.extend(noise(1.2, 0.003));
        let quiet_end = samples.len();
        samples.extend(vec![0.0; 2 * 16_000]);
        let range = super::whisper_audio_trim_range(&samples);
        assert!(range.start >= quiet_start - 800 && range.start <= quiet_start);
        assert!(range.end >= quiet_end && range.end <= quiet_end + 800);
        assert!(range.len() < 4 * 16_000);
        assert_eq!(
            &samples[quiet_start..quiet_end],
            &samples[range.clone()][quiet_start - range.start..quiet_end - range.start]
        );
    }

    #[test]
    fn trimming_keeps_digital_silence_for_the_existing_empty_decode_guard() {
        let samples = vec![0.0; 3 * 16_000];
        let range = super::whisper_audio_trim_range(&samples);
        assert_eq!(range, 0..samples.len());
        assert!(
            PromptAudioStats::measure(&samples[range.clone()], range.len()).is_digital_silence()
        );
    }

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

    #[tokio::test]
    #[ignore = "requires pinned Turbo weights, public audio and an explicit output directory"]
    async fn whisper_alignment_timing_probe() {
        use whisper_rs::{DtwMode, DtwModelPreset, DtwParameters, WhisperContextParameters};
        let model = std::path::PathBuf::from(
            std::env::var("PLAINSONG_WHISPER_ALIGNMENT_MODEL").expect("model"),
        );
        let audio = std::path::PathBuf::from(
            std::env::var("PLAINSONG_WHISPER_ALIGNMENT_AUDIO").expect("audio"),
        );
        let out = std::path::PathBuf::from(
            std::env::var("PLAINSONG_WHISPER_ALIGNMENT_OUT").expect("output"),
        );
        let expected = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        assert!(
            crate::download::verify_or_record_model_integrity(&model, Some(&expected))
                .await
                .unwrap()
        );
        let samples = crate::audio::utils::load_audio_file(&audio).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        for (label, flash_attention, aligned) in [
            ("normal", true, false),
            ("no-flash", false, false),
            ("dtw", false, true),
        ] {
            let verified =
                crate::download::open_verified_model_artifact(&model, &expected).unwrap();
            let mut params = WhisperContextParameters {
                use_gpu: true,
                flash_attn: flash_attention,
                ..Default::default()
            };
            if aligned {
                params.dtw_parameters = DtwParameters {
                    mode: DtwMode::ModelPreset {
                        model_preset: DtwModelPreset::LargeV3Turbo,
                    },
                    ..Default::default()
                };
            }
            let load = std::time::Instant::now();
            let ctx =
                whisper_rs::WhisperContext::new_with_params(verified.load_path(), params).unwrap();
            let load_ms = load.elapsed().as_millis();
            let mut state = ctx.create_state().unwrap();
            let decode = std::time::Instant::now();
            state
                .full(super::build_whisper_params(false, false, None), &samples)
                .unwrap();
            let decode_ms = decode.elapsed().as_millis();
            let output = super::collect_whisper_segments(&state).unwrap();
            let mut tokens = Vec::new();
            for i in 0..state.full_n_segments() {
                let segment = state.get_segment(i).unwrap();
                for j in 0..segment.n_tokens() {
                    let token = segment.get_token(j).unwrap();
                    let data = token.token_data();
                    let bytes = token.to_bytes().unwrap();
                    tokens.push(
                        serde_json::json!({"segment":i,"index":j,"id":token.token_id(),
                        "text":String::from_utf8_lossy(bytes),"bytes":bytes,
                        "t0":data.t0,"t1":data.t1,"dtw":data.t_dtw,"probability":data.p}),
                    );
                }
            }
            let receipt = serde_json::json!({"audio":audio,"model":model,"modelSha256":expected,
                "loadMs":load_ms,"decodeMs":decode_ms,"flashAttention":flash_attention,"dtw":aligned,
                "text":output.text,"segments":output.segments,"tokens":tokens,
                "scope":"Explicit local alignment diagnostic; production defaults and timing provenance unchanged"});
            std::fs::write(
                out.join(format!("{label}.json")),
                serde_json::to_vec_pretty(&receipt).unwrap(),
            )
            .unwrap();
            println!(
                "WHISPER-ALIGN {}",
                serde_json::json!({"mode":label,"loadMs":load_ms,"decodeMs":decode_ms,"segments":output.segments.len(),"tokens":tokens.len()})
            );
        }
    }

    #[test]
    fn whisper_preserves_audio_when_trimming_saves_less_than_100ms() {
        let mut samples = noise(2.0, 0.3);
        samples.extend(vec![0.0; 480]);
        assert_eq!(super::whisper_audio_trim_range(&samples), 0..samples.len());
        let mut padded = vec![0.0; 16_000];
        padded.extend(noise(2.0, 0.3));
        padded.extend(vec![0.0; 16_000]);
        let range = super::whisper_audio_trim_range(&padded);
        assert!(range.start > 0);
        assert!(range.end < padded.len());
    }

    #[test]
    fn restored_whisper_timeline_shifts_once_and_excludes_padding() {
        let mut rows = vec![crate::asr::TranscriptSegment {
            start_time: 0.2,
            end_time: 1.4,
            text: "same words".into(),
            confidence: 0.9,
        }];
        super::restore_whisper_timeline(&mut rows, 32_000..48_000);
        assert_eq!(rows[0].start_time, 2.2);
        assert_eq!(rows[0].end_time, 3.0);
        assert_eq!(rows[0].text, "same words");
        assert_eq!(rows[0].confidence, 0.9);
        let mut tail = vec![crate::asr::TranscriptSegment {
            start_time: 2.0,
            end_time: 3.0,
            text: "tail".into(),
            confidence: 0.8,
        }];
        super::restore_whisper_timeline(&mut tail, 0..16_000);
        assert_eq!((tail[0].start_time, tail[0].end_time), (1.0, 1.0));
    }

    #[tokio::test]
    #[ignore = "requires pinned Turbo weights, explicit source audio and an output path"]
    async fn whisper_whole_audio_silence_probe() {
        use crate::asr::AsrProvider;
        let audio =
            std::path::PathBuf::from(std::env::var("PLAINSONG_WHOLE_WHISPER_AUDIO").unwrap());
        let out = std::path::PathBuf::from(std::env::var("PLAINSONG_WHOLE_WHISPER_OUT").unwrap());
        let provider = super::WhisperProvider::new(Some("large-v3-turbo"));
        let expected = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        assert!(crate::download::verify_or_record_model_integrity(
            &provider.model_path,
            Some(&expected)
        )
        .await
        .unwrap());
        let samples = crate::audio::utils::load_audio_file(&audio).unwrap();
        let range = super::whisper_audio_trim_range(&samples);
        let result = provider.transcribe(&audio).await.unwrap();
        let receipt = serde_json::json!({"sourceSamples":samples.len(),"retainedStart":range.start,
            "retainedEnd":range.end,"result":result,"scope":"Actual Whisper provider on one whole source file, without meeting chunking"});
        std::fs::write(out, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        println!("WHOLE-WHISPER {}", receipt);
        drop(provider);
        super::clear_all_cached_models();
    }

    #[test]
    fn digital_silence_never_reaches_the_decoder() {
        let samples = vec![0.0; 90 * 16_000];
        let stats = PromptAudioStats::measure(&samples, samples.len());
        let mut decode = |_: Option<&str>| -> anyhow::Result<WhisperDecodeOutput> {
            panic!("Silent input must not run the model")
        };
        let (result, terms) = decode_with_prompt_policy(None, &stats, &mut decode).unwrap();
        assert!(result.text.is_empty());
        assert!(result.segments.is_empty());
        assert_eq!(terms, 0);
        let quiet = noise(2.0, 0.003);
        let stats = PromptAudioStats::measure(&quiet, quiet.len());
        let mut calls = 0;
        let mut decode = |_: Option<&str>| {
            calls += 1;
            Ok(output("quiet opening"))
        };
        let (result, _) = decode_with_prompt_policy(None, &stats, &mut decode).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result.text, "quiet opening");
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
    fn echo_decision_asks_for_a_re_decode_only_on_weak_audio() {
        let hint = hint(&["Plainsong"]);
        // Quiet and short: the classic silent-tap echo.
        let weak = PromptAudioStats::measure(&noise(0.6, 0.012), 9_600);
        assert_eq!(
            prompt_echo_decision("Plainsong", &hint, &weak),
            PromptEchoDecision::RedecodeWithoutPrompt
        );
        // Clearly voiced, two seconds: the user said the word. Keep it.
        let voiced = tone(2.0, 0.05);
        let strong = PromptAudioStats::measure(&voiced, voiced.len());
        assert_eq!(
            prompt_echo_decision("Plainsong", &hint, &strong),
            PromptEchoDecision::Keep
        );
        // Weak audio but real words beyond the hint: also kept.
        assert_eq!(
            prompt_echo_decision("Plainsong is ready", &hint, &weak),
            PromptEchoDecision::Keep
        );
    }

    fn output(text: &str) -> WhisperDecodeOutput {
        WhisperDecodeOutput {
            text: text.to_string(),
            segments: Vec::new(),
        }
    }

    #[test]
    fn hint_self_introduction_headers_are_verified_without_deleting_recognized_words() {
        let hint = hint(&["Jeanne-Oui"]);
        let speech = tone(1.5, 0.05);
        let stats = PromptAudioStats::measure(&speech, speech.len());
        let mut calls = 0;
        let mut decode = |prompt: Option<&str>| {
            calls += 1;
            Ok(output(if prompt.is_some() {
                "Jeanne-Oui: I'm Jeanne-Oui. My role is designer."
            } else {
                "I'm Janavi. My role is designer."
            }))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &stats, &mut decode).unwrap();
        assert_eq!(result.text, "I'm Jeanne-Oui. My role is designer.");
        assert_eq!(applied, 1);
        assert_eq!(calls, 2);
        let mut decode = |prompt: Option<&str>| {
            Ok(output(if prompt.is_some() {
                "Jeanne-Oui: I'm Jeanne-Oui."
            } else {
                "Janavi: I'm Janavi."
            }))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &stats, &mut decode).unwrap();
        assert_eq!(result.text, "Jeanne-Oui: I'm Jeanne-Oui.");
        assert_eq!(applied, 1);
        assert!(has_unprompted_self_introduction_header(
            "Janavi colon I'm Janavi."
        ));
        assert!(!has_hint_self_introduction_header(
            "Jeanne-Oui: Please review this.",
            &hint
        ));
        assert!(!has_hint_self_introduction_header(
            "Jeanne-Oui: I'm Jeanne-Ouisa.",
            &hint
        ));
        assert!(has_hint_self_introduction_header(
            "Jeanne-Oui : I'm Jeanne-Oui.",
            &hint
        ));
        assert!(has_hint_self_introduction_header(
            "Jeanne-Oui colon I'm Jeanne-Oui.",
            &hint
        ));
        assert!(has_hint_self_introduction_header(
            "Jeanne-Oui: I'm Jeanne-Oui.",
            &VocabularyHint::new(vec!["Plainsong".into(), "Jeanne-Oui".into()]).unwrap()
        ));
        for incomplete in ["", "I'm Janavi."] {
            let mut decode = |prompt: Option<&str>| {
                Ok(output(if prompt.is_some() {
                    "Jeanne-Oui: I'm Jeanne-Oui. My role is designer and I approved the launch."
                } else {
                    incomplete
                }))
            };
            let (result, _) = decode_with_prompt_policy(Some(&hint), &stats, &mut decode).unwrap();
            assert!(result.text.contains("I approved the launch"));
            assert!(result.text.starts_with("Jeanne-Oui:"));
        }
    }

    #[test]
    fn echo_on_weak_audio_is_decoded_again_without_the_prompt_not_dropped() {
        // A prompted decode of a quiet tap came back as nothing but the hint.
        // The policy must run a second, un-prompted decode and return that:
        // empty for real silence...
        let hint = hint(&["Plainsong"]);
        let weak = PromptAudioStats::measure(&noise(0.6, 0.012), 9_600);
        let mut calls: Vec<Option<String>> = Vec::new();
        let mut silence_stub = |prompt: Option<&str>| {
            calls.push(prompt.map(str::to_string));
            Ok(output(if prompt.is_some() { "Plainsong" } else { "" }))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &weak, &mut silence_stub).expect("decode");
        assert_eq!(result.text, "");
        assert_eq!(applied, 0, "the returned decode carried no prompt");
        assert_eq!(
            calls,
            vec![Some("Vocabulary: Plainsong.".to_string()), None],
            "prompted decode first, then exactly one re-decode without the prompt"
        );

        // ...and the word itself when the user quietly said it: the plain
        // decode hears it too, and it is returned rather than lost.
        let mut calls: Vec<Option<String>> = Vec::new();
        let mut quiet_word_stub = |prompt: Option<&str>| {
            calls.push(prompt.map(str::to_string));
            Ok(output(if prompt.is_some() {
                "Plainsong"
            } else {
                "plainsong"
            }))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &weak, &mut quiet_word_stub).expect("decode");
        assert_eq!(result.text, "plainsong");
        assert_eq!(applied, 0);
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn hint_only_output_on_voiced_audio_is_kept_after_a_single_decode() {
        let hint = hint(&["Plainsong"]);
        let voiced = tone(2.0, 0.05);
        let strong = PromptAudioStats::measure(&voiced, voiced.len());
        let mut calls = 0usize;
        let mut stub = |prompt: Option<&str>| {
            calls += 1;
            assert!(
                prompt.is_some(),
                "the prompt must be attached on voiced audio"
            );
            Ok(output("Plainsong"))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &strong, &mut stub).expect("decode");
        assert_eq!(result.text, "Plainsong");
        assert_eq!(applied, 1);
        assert_eq!(calls, 1, "no re-decode when the user clearly spoke");
    }

    #[test]
    fn the_prompt_is_withheld_before_any_decode_on_silence() {
        let hint = hint(&["Plainsong"]);
        let silence = vec![0.0_f32; 17_600];
        let stats = PromptAudioStats::measure(&silence, 0);
        let mut calls: Vec<Option<String>> = Vec::new();
        let mut stub = |prompt: Option<&str>| {
            calls.push(prompt.map(str::to_string));
            Ok(output(""))
        };
        let (result, applied) =
            decode_with_prompt_policy(Some(&hint), &stats, &mut stub).expect("decode");
        assert_eq!(result.text, "");
        assert_eq!(applied, 0);
        assert!(
            calls.is_empty(),
            "Digital silence attaches no prompt and runs no decode"
        );
    }
}

#[cfg(test)]
mod language_selection_tests {
    use super::*;

    #[test]
    fn language_selection_preserves_auto_and_normalizes_supported_tags() {
        for value in [None, Some(""), Some(" Auto ")] {
            assert_eq!(normalized_whisper_language(value, false).unwrap(), None);
        }
        for (input, expected) in [
            ("fr-FR", "fr"),
            ("DE_de", "de"),
            (" Polish ", "pl"),
            ("zh-CN", "zh"),
        ] {
            assert_eq!(
                normalized_whisper_language(Some(input), false)
                    .unwrap()
                    .as_deref(),
                Some(expected)
            );
        }
        assert_eq!(
            normalized_whisper_language(Some("en-US"), true)
                .unwrap()
                .as_deref(),
            Some("en")
        );
        assert!(normalized_whisper_language(Some("fr"), true).is_err());
        assert!(normalized_whisper_language(Some("not-a-language"), false).is_err());
        assert!(normalized_whisper_language(Some("fr\0"), false).is_err());
    }

    #[tokio::test]
    async fn path_and_bytes_reject_invalid_selection_before_loading_missing_weights() {
        let provider = WhisperProvider {
            model_path: PathBuf::from("/nonexistent/whisper-language-test.bin"),
            model_id: "large-v3-turbo".into(),
        };
        let options = TranscriptionOptions {
            language: Some("unsupported-language".into()),
            ..Default::default()
        };
        let path_error = provider
            .transcribe_path_with_options(Path::new("/nonexistent/audio.wav"), &options)
            .await
            .unwrap_err();
        let bytes_error = provider
            .transcribe_bytes_with_options(b"not decoded because the language is invalid", &options)
            .await
            .unwrap_err();
        for error in [path_error, bytes_error] {
            assert!(error.to_string().contains("selected language"));
        }
    }
}

#[cfg(test)]
mod translate_task_tests {
    use super::whisper_translate_task_enabled;

    #[test]
    fn translate_task_only_runs_on_multilingual_models_when_asked() {
        assert!(whisper_translate_task_enabled("base", true));
        assert!(whisper_translate_task_enabled("large-v3-turbo", true));
        assert!(!whisper_translate_task_enabled("base.en", true));
        assert!(!whisper_translate_task_enabled("Small.EN", true));
        assert!(!whisper_translate_task_enabled("base", false));
        assert!(!whisper_translate_task_enabled("base.en", false));
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

#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
mod recorded_model_probe {
    use super::*;

    #[tokio::test]
    #[ignore = "requires isolated roots, pinned Turbo weights and the public name clip"]
    async fn pinned_dictionary_name_hint_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let root = PathBuf::from(std::env::var("PLAINSONG_NAME_HINT_PROBE_ROOT").unwrap());
        assert_eq!(crate::paths::data_dir().unwrap(), root.join("data"));
        assert_eq!(crate::paths::config_dir().unwrap(), root.join("config"));
        assert_eq!(std::env::temp_dir(), root.join("tmp"));
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let model_path = root.join("turbo.bin");
        let expected = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        let mut file = std::fs::File::open(&model_path).unwrap();
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let count = file.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        assert_eq!(hex::encode(digest.finalize()), expected);
        crate::download::verify_and_remember_model(&model_path, &expected)
            .await
            .unwrap();
        let provider = WhisperProvider {
            model_path,
            model_id: "large-v3-turbo".into(),
        };
        let audio = std::fs::read(root.join("audio.wav")).unwrap();
        let mut rows = Vec::new();
        for hinted in [false, true, false, true] {
            let options = TranscriptionOptions {
                vocabulary_hint: if hinted {
                    VocabularyHint::new(vec!["Jeanne-Oui".into()])
                } else {
                    None
                },
                ..Default::default()
            };
            let start = std::time::Instant::now();
            let result = provider
                .transcribe_bytes_with_options(&audio, &options)
                .await
                .unwrap();
            rows.push(serde_json::json!({"hinted":hinted,"result":result,"elapsedMs":start.elapsed().as_millis()}));
            std::fs::write(
                root.join("results.json"),
                serde_json::to_vec_pretty(&rows).unwrap(),
            )
            .unwrap();
        }
        clear_all_cached_models();
    }

    struct ProbeDigitMask {
        ids: Vec<usize>,
        vocab: usize,
    }

    // Test-only, synchronous whisper_full callback. The borrowed mask is
    // immutable and alive for the full decode. Context/state are never touched.
    unsafe extern "C" fn filter_probe_digits(
        _ctx: *mut whisper_rs::WhisperSysContext,
        _state: *mut whisper_rs::WhisperSysState,
        _tokens: *const whisper_rs::WhisperTokenData,
        _n_tokens: std::os::raw::c_int,
        logits: *mut f32,
        user_data: *mut std::ffi::c_void,
    ) {
        if logits.is_null() || user_data.is_null() {
            return;
        }
        // SAFETY: setter points at the live ProbeDigitMask; native logits hold
        // n_vocab floats for this same context. Indices were checked at build.
        let mask = unsafe { &*(user_data as *const ProbeDigitMask) };
        for &id in &mask.ids {
            if id < mask.vocab {
                unsafe {
                    *logits.add(id) = f32::NEG_INFINITY;
                }
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires explicit isolated roots, pinned Turbo and a public financial speech clip"]
    async fn pinned_financial_number_style_probe() {
        use sha2::{Digest, Sha256};
        let root = PathBuf::from(std::env::var("PLAINSONG_FINANCIAL_ASR_PROBE_ROOT").unwrap());
        assert_eq!(crate::paths::data_dir().unwrap(), root.join("data"));
        assert_eq!(crate::paths::config_dir().unwrap(), root.join("config"));
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let model_id = std::env::var("PLAINSONG_FINANCIAL_ASR_MODEL")
            .unwrap_or_else(|_| "large-v3-turbo".into());
        assert!(matches!(
            model_id.as_str(),
            "large-v3-turbo" | "large-v3" | "base.en"
        ));
        let model_path = root.join(if model_id == "large-v3-turbo" {
            "turbo.bin"
        } else {
            "model.bin"
        });
        let expected = crate::download::whisper_model_expected_sha256(&model_id).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&model_path).unwrap())),
            expected
        );
        crate::download::verify_and_remember_model(&model_path, &expected)
            .await
            .unwrap();
        let provider = WhisperProvider {
            model_path,
            model_id,
        };
        let ctx = provider.get_or_load_ctx().unwrap();
        let samples = crate::audio::utils::load_audio_file(&root.join("audio.wav")).unwrap();
        let range = whisper_audio_trim_range(&samples);
        let mut rows = Vec::new();
        let decoder_probe = std::env::var("PLAINSONG_WHISPER_DECODER_PROBE").as_deref() == Ok("1");
        let numeral_probe = std::env::var("PLAINSONG_WHISPER_NUMERAL_PROBE").as_deref() == Ok("1");
        let vocab = usize::try_from(ctx.n_vocab()).unwrap();
        let mut all_digits = ProbeDigitMask {
            ids: Vec::new(),
            vocab,
        };
        let mut numeric_only = ProbeDigitMask {
            ids: Vec::new(),
            vocab,
        };
        if numeral_probe {
            // Normal text vocabulary only: never suppress EOT, languages,
            // tasks or timestamps. Byte inspection also handles non-UTF8 BPE.
            for id in 0..ctx.token_eot() {
                let bytes = ctx.token_to_bytes(id).unwrap();
                if bytes.iter().any(u8::is_ascii_digit) {
                    let index = usize::try_from(id).unwrap();
                    assert!(index < vocab);
                    all_digits.ids.push(index);
                    if bytes.iter().all(|b| {
                        b.is_ascii_digit() || b.is_ascii_whitespace() || b".,+-".contains(b)
                    }) {
                        numeric_only.ids.push(index);
                    }
                }
            }
        }
        let beam = |size| whisper_rs::SamplingStrategy::BeamSearch {
            beam_size: size,
            patience: 1.0,
        };
        let numeral_hint = std::env::var("PLAINSONG_WHISPER_NUMERAL_HINT").ok();
        let allowed_hint_tokens = numeral_hint
            .as_deref()
            .map(|hint| {
                ctx.tokenize(hint, 1024)
                    .unwrap()
                    .into_iter()
                    .filter_map(|id| usize::try_from(id).ok())
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        let numeric_with_hints = ProbeDigitMask {
            ids: numeric_only
                .ids
                .iter()
                .copied()
                .filter(|id| !allowed_hint_tokens.contains(id))
                .collect(),
            vocab,
        };
        let all_with_hints = ProbeDigitMask {
            ids: all_digits
                .ids
                .iter()
                .copied()
                .filter(|id| !allowed_hint_tokens.contains(id))
                .collect(),
            vocab,
        };
        let mut cases = if numeral_probe {
            vec![
                ("baseline-beam5", None, beam(5), None),
                ("numeric-only-token-mask", None, beam(5), None),
                ("all-digit-bearing-text-mask", None, beam(5), None),
            ]
        } else if decoder_probe {
            vec![
                ("baseline-beam5", None, beam(5), None),
                ("beam1", None, beam(1), None),
                ("beam8", None, beam(8), None),
                (
                    "greedy1",
                    None,
                    whisper_rs::SamplingStrategy::Greedy { best_of: 1 },
                    None,
                ),
                ("beam5-explicit-english", None, beam(5), Some("en")),
            ]
        } else {
            vec![
                ("baseline", None, beam(5), None),
                (
                    "number-word-instruction",
                    Some("Write all numbers in words. This is English speech."),
                    beam(5),
                    None,
                ),
                (
                    "unrelated-spoken-price-example",
                    Some("The price is seven euros and forty cents. The total is thirty euros."),
                    beam(5),
                    None,
                ),
            ]
        };
        if numeral_probe {
            if let Some(hint) = numeral_hint.as_deref() {
                cases.extend([
                    ("baseline-hinted", Some(hint), beam(5), None),
                    ("numeric-only-token-mask-hinted", Some(hint), beam(5), None),
                    (
                        "all-digit-bearing-text-mask-hinted",
                        Some(hint),
                        beam(5),
                        None,
                    ),
                    ("allowlisted-numeric-without-prompt", None, beam(5), None),
                    ("allowlisted-all-without-prompt", None, beam(5), None),
                    ("allowlisted-numeric-hinted", Some(hint), beam(5), None),
                    ("allowlisted-all-hinted", Some(hint), beam(5), None),
                ]);
            }
        }
        for (label, prompt, strategy, language) in cases {
            let mut state = ctx.create_state().unwrap();
            let mut params = configure_whisper_params(
                whisper_rs::FullParams::new(strategy),
                false,
                false,
                language,
            );
            if let Some(prompt) = prompt {
                params.set_initial_prompt(prompt);
            }
            let mask = if label.starts_with("allowlisted-numeric") {
                Some(&numeric_with_hints)
            } else if label.starts_with("allowlisted-all") {
                Some(&all_with_hints)
            } else if label.starts_with("numeric-only-token-mask") {
                Some(&numeric_only)
            } else if label.starts_with("all-digit-bearing-text-mask") {
                Some(&all_digits)
            } else {
                None
            };
            if let Some(mask) = mask {
                // SAFETY: read-only mask lives outside this decode; callback
                // only writes native-owned logits within the checked bounds.
                unsafe {
                    params.set_filter_logits_callback(Some(filter_probe_digits));
                    params.set_filter_logits_callback_user_data(
                        mask as *const ProbeDigitMask as *mut std::ffi::c_void,
                    );
                }
            }
            let start = std::time::Instant::now();
            let result = state
                .full(params, &samples[range.clone()])
                .map_err(|error| error.to_string())
                .and_then(|()| collect_whisper_segments(&state).map_err(|error| error.to_string()));
            let row = match result {
                Ok(output) => {
                    serde_json::json!({"label":label,"prompt":prompt,"text":output.text,"elapsedMs":start.elapsed().as_millis()})
                }
                Err(error) => {
                    serde_json::json!({"label":label,"prompt":prompt,"error":error,"elapsedMs":start.elapsed().as_millis()})
                }
            };
            rows.push(row);
            std::fs::write(
                root.join(if numeral_probe {
                    "number-token-results.json"
                } else if decoder_probe {
                    "number-decode-results.json"
                } else {
                    "number-style-results.json"
                }),
                serde_json::to_vec_pretty(&rows).unwrap(),
            )
            .unwrap();
        }
        clear_all_cached_models();
    }

    #[tokio::test]
    #[ignore = "requires an explicit isolated boundary probe with pinned Turbo weights and public audio"]
    async fn frozen_quiet_boundary_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let root = PathBuf::from(
            std::env::var("PLAINSONG_WHISPER_BOUNDARY_PROBE_ROOT")
                .expect("explicit isolated probe root"),
        );
        let model_path = root.join("turbo-model/ggml-large-v3-turbo.bin");
        let expected = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        let mut file = std::fs::File::open(&model_path).unwrap();
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let n = file.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        assert_eq!(hex::encode(digest.finalize()), expected);
        crate::download::verify_and_remember_model(&model_path, &expected)
            .await
            .unwrap();
        let source = root.join("source.wav");
        let samples = crate::audio::utils::load_audio_file(&source).unwrap();
        let range = whisper_audio_trim_range(&samples);
        let provider = WhisperProvider {
            model_path,
            model_id: "large-v3-turbo".into(),
        };
        let ctx = provider.get_or_load_ctx().unwrap();
        let mut rows = Vec::new();
        for (label, input) in [
            ("production-trim", &samples[range.clone()]),
            ("full-source", samples.as_slice()),
        ] {
            let mut state = ctx.create_state().unwrap();
            state
                .full(build_whisper_params(false, false, Some("pl")), input)
                .unwrap();
            let output = collect_whisper_segments(&state).unwrap();
            rows.push(serde_json::json!({"label":label,"inputSamples":input.len(),"text":output.text,"segments":output.segments}));
        }
        let peak = |data: &[f32]| {
            data.iter()
                .fold(0.0_f32, |value, sample| value.max(sample.abs()))
        };
        std::fs::write(root.join("boundary-result.json"), serde_json::to_vec_pretty(&serde_json::json!({"modelSha256":expected,"sourceSha256":hex::encode(Sha256::digest(std::fs::read(source).unwrap())),"sourceSamples":samples.len(),"retainedStart":range.start,"retainedEnd":range.end,"removedPrefixPeak":peak(&samples[..range.start]),"removedSuffixPeak":peak(&samples[range.end..]),"rows":rows,"scope":"Same public Polish clip, model, parameters, and result assembly; only the input sample range differs. No app capture or competitors."})).unwrap()).unwrap();
        drop(ctx);
        drop(provider);
        clear_all_cached_models();
    }

    /// Frozen public clips and a separately staged model only. Never changes
    /// app settings or the user's cached model.
    #[tokio::test]
    #[ignore = "requires an explicit frozen multilingual corpus and staged pinned Turbo model"]
    async fn frozen_multilingual_speech_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let root = PathBuf::from(
            std::env::var("PLAINSONG_MULTILINGUAL_PROBE_ROOT")
                .expect("explicit isolated probe root"),
        );
        let model_path = root.join("turbo-model/ggml-large-v3-turbo.bin");
        let expected = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        let mut file = std::fs::File::open(&model_path).expect("staged cached model");
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let n = file.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        assert_eq!(hex::encode(digest.finalize()), expected);
        crate::download::verify_and_remember_model(&model_path, &expected)
            .await
            .unwrap();
        let manifest_bytes = std::fs::read(root.join("manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest["complete"], true);
        let clips = manifest["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 12);
        let provider = WhisperProvider {
            model_path,
            model_id: "large-v3-turbo".into(),
        };
        let mut observations = Vec::new();
        for clip in clips {
            let relative = Path::new(clip["audioFile"].as_str().unwrap());
            assert!(
                !relative.is_absolute()
                    && relative
                        .components()
                        .all(|component| !matches!(component, std::path::Component::ParentDir))
            );
            let audio = root.join(relative);
            assert_eq!(
                hex::encode(Sha256::digest(std::fs::read(&audio).unwrap())),
                clip["wavSha256"].as_str().unwrap()
            );
            for mode in ["auto", "explicit"] {
                let options = TranscriptionOptions {
                    language: (mode == "explicit")
                        .then(|| clip["language"].as_str().unwrap().to_string()),
                    ..Default::default()
                };
                let started = std::time::Instant::now();
                let result = provider
                    .transcribe_path_with_options(&audio, &options)
                    .await
                    .unwrap();
                assert_eq!(result.actual_provider, AsrProviderType::Whisper);
                assert_eq!(result.model_id, "large-v3-turbo");
                if mode == "explicit" {
                    assert_eq!(result.language, clip["language"].as_str().unwrap());
                }
                observations.push(serde_json::json!({"id":clip["id"],"expectedLanguage":clip["language"],"mode":mode,"elapsedMs":started.elapsed().as_millis(),"result":result}));
                std::fs::write(root.join("turbo-results.json"), serde_json::to_vec_pretty(&serde_json::json!({"scope":"Production Whisper provider on frozen public multilingual clips; no capture, formatting, insertion, UI, or competitors", "manifestSha256":hex::encode(Sha256::digest(&manifest_bytes)),"modelSha256":expected,"observations":observations})).unwrap()).unwrap();
            }
        }
        // A deliberately different language on a public German clip proves
        // that bytes requests reach the decoder rather than only its metadata.
        assert_ne!(clips[0]["language"].as_str().unwrap(), "fr");
        let control_audio =
            std::fs::read(root.join(clips[0]["audioFile"].as_str().unwrap())).unwrap();
        let control = provider
            .transcribe_bytes_with_options(
                &control_audio,
                &TranscriptionOptions {
                    language: Some("fr-FR".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(control.language, "fr");
        std::fs::write(root.join("forced-language-control.json"), serde_json::to_vec_pretty(&serde_json::json!({"expectedSourceLanguage":clips[0]["language"],"requestedLanguage":"fr-FR","purpose":"Wrong-language diagnostic only, not an accuracy result","result":control})).unwrap()).unwrap();
        drop(provider);
        clear_all_cached_models();
    }

    /// Opt-in native ASR probe. Only reads synthetic fixture audio and pinned
    /// local model artifacts; never opens a microphone or downloads a model.
    #[tokio::test]
    #[ignore = "requires separately verified local Whisper base.en and turbo artifacts"]
    async fn pinned_whisper_turbo_meaning_probe() {
        let root = std::env::var("PLAINSONG_WHISPER_PROBE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp/plainsong-model-eval-20261003"));
        let audio = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/evals/audio-2026-10-02");
        let models = [
            ("base.en", root.join("ggml-base.en.bin")),
            ("large-v3-turbo", root.join("ggml-large-v3-turbo.bin")),
        ];
        let selected_model = std::env::var("PLAINSONG_WHISPER_PROBE_MODEL").ok();
        let mut observations = Vec::new();
        for (model, path) in models {
            if selected_model
                .as_deref()
                .is_some_and(|selected| selected != model)
            {
                continue;
            }
            let spec =
                crate::download::whisper_model_expected_sha256(model).expect("pinned model spec");
            // Verify the actual bytes before issuing a test-key receipt. Both
            // files live in the evaluation directory, outside the running app.
            use sha2::{Digest, Sha256};
            use std::io::Read;
            let mut file = std::fs::File::open(&path).unwrap();
            let mut digest = Sha256::new();
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let count = file.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            assert_eq!(hex::encode(digest.finalize()), spec);
            // Remembered in this test process only.
            crate::download::verify_and_remember_model(&path, &spec)
                .await
                .expect("verify test model");
            let provider = WhisperProvider {
                model_path: path,
                model_id: model.to_string(),
            };
            clear_cached_model(model);
            let started = std::time::Instant::now();
            provider.prewarm().await.expect("native model preparation");
            let preparation_ms = started.elapsed().as_millis();
            for hinted in [false, true] {
                let options = TranscriptionOptions {
                    vocabulary_hint: if hinted {
                        VocabularyHint::new(vec![
                            "Priya".into(),
                            "Marcus".into(),
                            "fetchUserId".into(),
                            "--locked".into(),
                            "/users".into(),
                        ])
                    } else {
                        None
                    },
                    ..Default::default()
                };
                for id in ["budget", "technical"] {
                    let bytes =
                        std::fs::read(audio.join(format!("{id}.wav"))).expect("synthetic WAV");
                    for repeat in 0..2 {
                        let started = std::time::Instant::now();
                        let result = provider
                            .transcribe_bytes_with_options(&bytes, &options)
                            .await
                            .expect("native ASR");
                        observations.push(serde_json::json!({"model": model, "hinted": hinted, "fixture": id,
                            "repeat": repeat, "preparationMs": preparation_ms, "recognitionMs": started.elapsed().as_millis(),
                            "modelSha256": spec, "result": result}));
                    }
                }
            }
            clear_cached_model(model);
        }
        assert!(
            !observations.is_empty(),
            "selected probe model must be declared"
        );
        let output = match selected_model.as_deref() {
            Some("base.en") => "whisper-base-process.json",
            Some("large-v3-turbo") => "whisper-turbo-process.json",
            _ => "whisper-comparison.json",
        };
        std::fs::write(root.join(output), serde_json::to_string_pretty(&serde_json::json!({
            "scope": "Matched synthetic WAV files through production native Metal Whisper providers; excludes capture, cleanup, insertion, user speech and competitors",
            "vocabulary": ["Priya", "Marcus", "fetchUserId", "--locked", "/users"],
            "observations": observations,
        })).unwrap()).unwrap();
    }
    #[tokio::test]
    #[ignore = "requires frozen LibriSpeech clips and cloned pinned local model artifacts"]
    async fn frozen_human_speech_model_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let root = Path::new("/tmp/plainsong-human-asr-20261003");
        assert_eq!(
            crate::paths::data_dir().as_deref(),
            Some(root.join("data").as_path()),
            "probe must use only its isolated model directory"
        );
        let models_root = root.join("data/Plainsong/models");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        let clips = manifest["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 8);
        let whisper_root = Path::new("/tmp/plainsong-model-eval-20261003");
        let mut artifacts = super::super::parakeet::model_integrity_artifacts(&models_root);
        artifacts.extend(super::super::whistle::model_integrity_artifacts(
            &models_root,
        ));
        for model in ["base.en", "large-v3-turbo"] {
            artifacts.push((
                whisper_root.join(format!("ggml-{model}.bin")),
                crate::download::whisper_model_expected_sha256(model).unwrap(),
            ));
        }
        let mut pins = Vec::new();
        for (path, expected) in artifacts {
            if !path.is_file() {
                continue;
            }
            let mut file = std::fs::File::open(&path).unwrap();
            let mut digest = Sha256::new();
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let n = file.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                digest.update(&buffer[..n]);
            }
            assert_eq!(hex::encode(digest.finalize()), expected);
            crate::download::verify_and_remember_model(&path, &expected)
                .await
                .unwrap();
            pins.push(serde_json::json!({"path": path, "sha256": expected}));
        }
        let providers: Vec<(&str, Box<dyn AsrProvider>)> = vec![
            (
                "whisper:base.en",
                Box::new(WhisperProvider {
                    model_path: whisper_root.join("ggml-base.en.bin"),
                    model_id: "base.en".into(),
                }),
            ),
            (
                "whisper:large-v3-turbo",
                Box::new(WhisperProvider {
                    model_path: whisper_root.join("ggml-large-v3-turbo.bin"),
                    model_id: "large-v3-turbo".into(),
                }),
            ),
            (
                "parakeet:v3",
                Box::new(super::super::parakeet::ParakeetProvider::with_models_root(
                    &models_root,
                    Some("parakeet-tdt-0.6b-v3"),
                )),
            ),
            (
                "whistle:2.0",
                Box::new(super::super::whistle::WhistleProvider::new(None)),
            ),
        ];
        let mut observations = Vec::new();
        for (route, provider) in providers {
            assert!(
                provider.is_available(),
                "pinned route must be ready: {route}"
            );
            let start = std::time::Instant::now();
            provider.prewarm().await.expect("model preparation");
            let preparation_ms = start.elapsed().as_millis();
            for clip in clips {
                let audio = std::fs::read(root.join(clip["audioFile"].as_str().unwrap())).unwrap();
                assert_eq!(
                    hex::encode(Sha256::digest(&audio)),
                    clip["wavSha256"].as_str().unwrap()
                );
                let start = std::time::Instant::now();
                let result = provider
                    .transcribe_bytes_with_options(&audio, &TranscriptionOptions::default())
                    .await
                    .expect("native human speech recognition");
                observations.push(serde_json::json!({"route": route, "id": clip["id"], "speakerId": clip["speakerId"],
                    "durationSeconds": clip["durationSeconds"], "preparationMs": preparation_ms,
                    "recognitionMs": start.elapsed().as_millis(), "result": result}));
                std::fs::write(root.join("recognition.json"), serde_json::to_string_pretty(&serde_json::json!({
                    "scope": "Frozen human read-speech WAVs through production local recognizers without hints; excludes capture, cleanup, insertion and competitors",
                    "artifactPins": pins, "observations": observations,
                })).unwrap()).unwrap();
            }
            if route.starts_with("whisper:") {
                clear_all_cached_models();
            }
        }
    }
    #[tokio::test]
    #[ignore = "requires frozen public speech and cloned Parakeet model artifacts"]
    async fn parakeet_first_clip_replay_probe() {
        let root = Path::new("/tmp/plainsong-human-asr-20261003");
        let provider = super::super::parakeet::ParakeetProvider::with_models_root(
            &root.join("data/Plainsong/models"),
            Some("parakeet-tdt-0.6b-v3"),
        );
        assert!(provider.is_available());
        provider.prewarm().await.unwrap();
        let fixtures = [
            ("human-short", root.join("audio/6930-75918-0000.wav")),
            (
                "synthetic-budget",
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../docs/evals/audio-2026-10-02/budget.wav"),
            ),
            (
                "synthetic-technical",
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../docs/evals/audio-2026-10-02/technical.wav"),
            ),
        ];
        let mut results = Vec::new();
        for (id, path) in fixtures {
            let bytes = std::fs::read(path).unwrap();
            for repeat in 0..3 {
                let started = std::time::Instant::now();
                let result = provider
                    .transcribe_bytes_with_options(&bytes, &TranscriptionOptions::default())
                    .await
                    .unwrap();
                if id == "human-short" {
                    assert_eq!(
                        result
                            .text
                            .trim()
                            .trim_end_matches('.')
                            .to_ascii_uppercase(),
                        "CONCORD RETURNED TO ITS PLACE AMIDST THE TENTS",
                        "the known truncation must not return"
                    );
                }
                results.push(serde_json::json!({"id": id, "repeat": repeat, "elapsedMs": started.elapsed().as_millis(), "result": result}));
            }
        }
        std::fs::write(
            root.join("parakeet-replay.json"),
            serde_json::to_string_pretty(&results).unwrap(),
        )
        .unwrap();
    }
}

#[cfg(test)]
mod natural_meeting_eval {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    #[tokio::test]
    #[ignore = "requires frozen public AMI audio and the existing pinned Whisper Turbo artifact"]
    async fn frozen_ami_whisper_chunks() {
        let root = PathBuf::from("/tmp/plainsong-ami-eval-20261003");
        let input = std::fs::read(root.join("ES2004a.Mix-Headset.first600s.wav")).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&input)),
            "54463cc2b337b9b47b6210de678cd0d9aa464d5b74b4f6c0099608dd60dde309"
        );
        let mut reader = hound::WavReader::new(Cursor::new(input)).unwrap();
        let spec = reader.spec();
        let samples: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        let path = PathBuf::from("/tmp/plainsong-model-eval-20261003/ggml-large-v3-turbo.bin");
        let sha = crate::download::whisper_model_expected_sha256("large-v3-turbo").unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
            sha
        );
        crate::download::verify_and_remember_model(&path, &sha)
            .await
            .unwrap();
        let provider = WhisperProvider {
            model_path: path,
            model_id: "large-v3-turbo".into(),
        };
        let start = std::time::Instant::now();
        provider.prewarm().await.unwrap();
        let preparation_ms = start.elapsed().as_millis();
        let mut observations = Vec::new();
        for (index, chunk) in samples.chunks(30 * 16_000).enumerate() {
            let mut bytes = Cursor::new(Vec::new());
            {
                let mut writer = hound::WavWriter::new(&mut bytes, spec).unwrap();
                for sample in chunk {
                    writer.write_sample(*sample).unwrap();
                }
                writer.finalize().unwrap();
            }
            let start = std::time::Instant::now();
            let result = provider.transcribe_bytes(bytes.get_ref()).await.unwrap();
            assert_eq!(result.actual_provider, AsrProviderType::Whisper);
            observations.push(serde_json::json!({"model": "whisper-turbo", "start": index * 30, "end": (index + 1) * 30,
                "preparationMs": preparation_ms, "recognitionMs": start.elapsed().as_millis(), "result": result}));
            std::fs::write(
                root.join("whisper-asr.json"),
                serde_json::to_vec_pretty(&serde_json::json!({"observations": observations}))
                    .unwrap(),
            )
            .unwrap();
        }
        super::clear_all_cached_models();
    }
}
