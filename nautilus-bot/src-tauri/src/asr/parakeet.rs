use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(feature = "asr-parakeet")]
use ort::session::Session;

// ---------------------------------------------------------------------------
// ONNX Session Cache (reuse sessions across transcriptions)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn onnx_session_cache() -> &'static Mutex<Option<Session>> {
    static CACHE: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-parakeet")]
fn get_or_create_session(onnx_path: &Path) -> Result<std::sync::MutexGuard<'static, Option<Session>>> {
    let mut cache = onnx_session_cache().lock().unwrap();
    
    // If session exists, return it
    if cache.is_some() {
        return Ok(cache);
    }
    
    // Create new session
    use ort::session::builder::GraphOptimizationLevel;
    
    tracing::info!("Creating new Parakeet ONNX session from {}", onnx_path.display());
    let session = Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("Failed to set opt level")?
        .commit_from_file(onnx_path)
        .context("Failed to load Parakeet ONNX — ensure encoder.onnx is a valid NeMo CTC export")?;
    
    *cache = Some(session);
    
    tracing::info!("Parakeet ONNX session cached successfully");
    Ok(cache)
}

// ---------------------------------------------------------------------------
// Model artifact filenames
// sherpa-onnx NeMo Parakeet TDT 0.6B: encoder + token list
// ---------------------------------------------------------------------------
const PARAKEET_ONNX_FILE: &str = "encoder.onnx";
const PARAKEET_VOCAB_FILE: &str = "tokens.txt";

// CTC ONNX export hosted on HuggingFace (public, no auth required).
// The primary source uses model.onnx + tokens.txt and is normalized to
// encoder.onnx + tokens.txt in local storage.
const PARAKEET_HF_REPO: &str = "csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000";
const PARAKEET_ONNX_SOURCES: [&str; 2] = [
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/main/model.onnx",
    "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/encoder.onnx",
];
const PARAKEET_TOKENS_SOURCES: [&str; 2] = [
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/main/tokens.txt",
    "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/tokens.txt",
];

/// Returns true only if the file exists, is non-trivially sized, and does NOT
/// start with an HTML/JSON error marker (which would indicate a failed download).
fn is_valid_onnx_file(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 4096 {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 4];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    // Reject HTML (starts with '<') or JSON error responses (starts with '{')
    buf[0] != b'<' && buf[0] != b'{'
}

fn is_valid_tokens_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 128 {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('{') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<html")
        || lower.starts_with("<!doctype")
        || lower.starts_with("<head")
        || lower.starts_with("<body")
    {
        return false;
    }

    let valid_lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let mut parts = line.split_whitespace();
            let token = parts.next();
            let maybe_id = parts.next_back();
            token.is_some()
                && maybe_id
                    .and_then(|value| value.parse::<usize>().ok())
                    .is_some()
        })
        .take(8)
        .count();

    valid_lines >= 4
}

pub struct ParakeetProvider {
    model_dir: PathBuf,
}

impl ParakeetProvider {
    pub fn new() -> Self {
        let model_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("parakeet");

        Self { model_dir }
    }

    fn onnx_path(&self) -> PathBuf {
        self.model_dir.join(PARAKEET_ONNX_FILE)
    }

    fn vocab_path(&self) -> PathBuf {
        self.model_dir.join(PARAKEET_VOCAB_FILE)
    }

    fn has_required_files(&self) -> bool {
        is_valid_tokens_file(&self.vocab_path()) && is_valid_onnx_file(&self.onnx_path())
    }

    fn missing_or_invalid_reason(&self) -> Option<String> {
        if !self.vocab_path().exists() {
            return Some(
                "Parakeet tokens.txt is missing. Download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        if !is_valid_tokens_file(&self.vocab_path()) {
            return Some(
                "Parakeet tokens.txt appears invalid or truncated. Re-download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        let onnx = self.onnx_path();
        if !onnx.exists() {
            return Some(
                "Parakeet encoder.onnx is missing. Download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        if !is_valid_onnx_file(&onnx) {
            return Some(
                "Parakeet encoder.onnx appears invalid or truncated. Re-download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        None
    }

    fn wav_duration_seconds(path: &Path) -> f64 {
        match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                if spec.sample_rate == 0 {
                    0.0
                } else {
                    reader.duration() as f64 / spec.sample_rate as f64
                }
            }
            Err(_) => 0.0,
        }
    }
}

impl Default for ParakeetProvider {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Native ONNX inference (feature-gated)
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn run_parakeet_onnx(onnx_path: &Path, vocab_path: &Path, audio_path: &Path) -> Result<String> {
    use ndarray::{Array, IxDyn};
    use ort::value::Tensor;

    // -----------------------------------------------------------------
    // 1. Load audio as 16 kHz mono f32 samples
    // -----------------------------------------------------------------
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Parakeet")?;
    if samples.is_empty() {
        tracing::warn!("Parakeet: audio samples are empty");
        return Ok(String::new());
    }
    tracing::debug!("Parakeet: loaded {} audio samples", samples.len());

    // -----------------------------------------------------------------
    // 2. Get or create ONNX session (CACHED for reuse)
    // -----------------------------------------------------------------
    let mut cache_guard = get_or_create_session(onnx_path)?;
    let session = cache_guard.as_mut().context("ONNX session not initialized")?;

    // Inspect input names to determine export contract:
    // 1) sherpa-onnx: x/x_lens (mel)
    // 2) NeMo processed: processed_signal/processed_signal_length (mel)
    // 3) NeMo raw-audio: audio_signal/length (raw waveform)
    let input_names = session
        .inputs()
        .iter()
        .map(|inp| inp.name().to_string())
        .collect::<Vec<_>>();
    let has_sherpa_names = input_names.iter().any(|name| name == "x");
    let has_processed_names = input_names.iter().any(|name| name == "processed_signal");
    let has_raw_audio_names = input_names.iter().any(|name| name == "audio_signal")
        && input_names.iter().any(|name| name == "length");

    let (data, shape) = if has_sherpa_names || has_processed_names {
        use crate::audio::mel::MelSpectrogram;

        let mel = MelSpectrogram::parakeet_defaults();
        let spec = mel.compute(&samples); // [80][T]
        if spec.is_empty() || spec[0].is_empty() {
            tracing::warn!(
                "Parakeet: mel spectrogram empty (mels={}, frames={})",
                spec.len(),
                if spec.is_empty() { 0 } else { spec[0].len() }
            );
            return Ok(String::new());
        }
        let n_mels = spec.len();
        let n_frames = spec[0].len();
        tracing::debug!("Parakeet: mel spec {} mels x {} frames for sherpa/processed path", n_mels, n_frames);

        let mut flat: Vec<f32> = Vec::with_capacity(n_frames * n_mels);
        for t in 0..n_frames {
            for mel_bin in spec.iter().take(n_mels) {
                flat.push(mel_bin[t]);
            }
        }
        let signal_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, n_frames, n_mels]), flat)
                .context("Failed to build mel array")?;
        let len_arr: Array<i64, IxDyn> = Array::from_shape_vec(IxDyn(&[1]), vec![n_frames as i64])
            .context("Failed to build length array")?;
        let signal_tensor =
            Tensor::from_array(signal_arr).context("Failed to create signal tensor")?;
        let len_tensor = Tensor::from_array(len_arr).context("Failed to create length tensor")?;

        let outputs = if has_sherpa_names {
            session
                .run(ort::inputs!["x" => signal_tensor, "x_lens" => len_tensor])
                .map_err(|error| {
                    anyhow::anyhow!(
                        "Parakeet ONNX inference failed (sherpa-onnx input names x/x_lens): {}",
                        error
                    )
                })?
        } else {
            session
                .run(ort::inputs![
                    "processed_signal" => signal_tensor,
                    "processed_signal_length" => len_tensor
                ])
                .map_err(|error| {
                    anyhow::anyhow!(
                        "Parakeet ONNX inference failed (NeMo processed_signal contract): {}",
                        error
                    )
                })?
        };
        let logprobs_array = outputs[0]
            .try_extract_array::<f32>()
            .context("Failed to extract logprobs from Parakeet ONNX output")?;
        let shape = logprobs_array.shape().to_vec();
        if shape.len() < 3 {
            return Err(anyhow::anyhow!(
                "Unexpected Parakeet output shape: {:?}",
                shape
            ));
        }
        let data: Vec<f32> = logprobs_array.iter().copied().collect();
        (data, shape)
    } else if has_raw_audio_names {
        use crate::audio::mel::MelSpectrogram;

        let mel = MelSpectrogram::parakeet_defaults();
        let spec = mel.compute(&samples); // [80][T]
        if spec.is_empty() || spec[0].is_empty() {
            tracing::warn!(
                "Parakeet: mel spectrogram empty for raw_audio path (mels={}, frames={})",
                spec.len(),
                if spec.is_empty() { 0 } else { spec[0].len() }
            );
            return Ok(String::new());
        }
        let n_mels = spec.len();
        let n_frames = spec[0].len();
        tracing::debug!("Parakeet: mel spec {} mels x {} frames for raw_audio path", n_mels, n_frames);
        let mut flat: Vec<f32> = Vec::with_capacity(n_frames * n_mels);
        for mel_bin in spec.iter().take(n_mels) {
            flat.extend(mel_bin.iter().take(n_frames).copied());
        }
        let signal_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, n_mels, n_frames]), flat)
                .context("Failed to build mel array for audio_signal input")?;
        let len_arr: Array<i64, IxDyn> = Array::from_shape_vec(IxDyn(&[1]), vec![n_frames as i64])
            .context("Failed to build frame length tensor for audio_signal input")?;
        let signal_tensor =
            Tensor::from_array(signal_arr).context("Failed to create audio_signal tensor")?;
        let len_tensor = Tensor::from_array(len_arr).context("Failed to create length tensor")?;
        let outputs = session
            .run(ort::inputs!["audio_signal" => signal_tensor, "length" => len_tensor])
            .map_err(|error| {
                anyhow::anyhow!(
                    "Parakeet ONNX inference failed (audio_signal/length mel contract): {}",
                    error
                )
            })?;
        let logprobs_array = outputs[0]
            .try_extract_array::<f32>()
            .context("Failed to extract Parakeet logprobs (audio_signal contract)")?;
        let data: Vec<f32> = logprobs_array.iter().copied().collect();
        let shape = logprobs_array.shape().to_vec();
        if shape.len() < 3 {
            return Err(anyhow::anyhow!(
                "Unexpected Parakeet raw output shape: {:?}",
                shape
            ));
        }
        (data, shape)
    } else {
        return Err(anyhow::anyhow!(
            "Unsupported Parakeet ONNX input names: {:?}",
            input_names
        ));
    };

    let vocab = load_vocab(vocab_path)?;
    let blank_id = vocab.len().saturating_sub(1);

    let t_out;
    let vocab_size;
    let vocab_on_axis_1 = shape[1] == vocab.len();
    let vocab_on_axis_2 = shape[2] == vocab.len();
    if vocab_on_axis_2 {
        t_out = shape[1];
        vocab_size = shape[2];
    } else if vocab_on_axis_1 {
        t_out = shape[2];
        vocab_size = shape[1];
    } else {
        t_out = shape[1];
        vocab_size = shape[2];
    }

    let mut token_ids: Vec<usize> = Vec::new();
    let mut prev = blank_id;
    for t in 0..t_out {
        let best_id = if vocab_on_axis_1 && !vocab_on_axis_2 {
            (0..vocab_size)
                .max_by(|a, b| data[a * t_out + t].total_cmp(&data[b * t_out + t]))
                .unwrap_or(blank_id)
        } else {
            let offset = t * vocab_size;
            let frame = &data[offset..offset + vocab_size];
            frame
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.total_cmp(b))
                .map(|(i, _)| i)
                .unwrap_or(blank_id)
        };
        if best_id != blank_id && best_id != prev {
            token_ids.push(best_id);
        }
        prev = best_id;
    }

    tracing::debug!(
        "Parakeet CTC: {} timesteps, {} tokens, vocab_size={}",
        t_out,
        token_ids.len(),
        vocab.len()
    );

    let text = token_ids
        .iter()
        .filter_map(|&id| vocab.get(id).map(String::as_str))
        .collect::<Vec<_>>()
        .concat()
        .replace('▁', " ") // SentencePiece space
        .replace("##", "") // WordPiece prefix
        .trim()
        .to_string();

    Ok(text)
}

/// Load a plain-text vocabulary file (one token per line, 0-indexed).
fn load_vocab(vocab_path: &Path) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(vocab_path)
        .with_context(|| format!("Failed to read Parakeet vocab: {}", vocab_path.display()))?;
    let tokens = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split_whitespace();
            let first = parts.next().unwrap_or(line);
            match parts.next_back() {
                Some(last) if last.parse::<usize>().is_ok() => first.to_string(),
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>();
    tracing::debug!("Parakeet: loaded {} vocab tokens from {}", tokens.len(), vocab_path.display());
    Ok(tokens)
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_parakeet_onnx(_onnx_path: &Path, _vocab_path: &Path, _audio_path: &Path) -> Result<String> {
    Err(anyhow::anyhow!(
        "Parakeet ONNX support is not compiled in. Rebuild with the `asr-parakeet` feature."
    ))
}

// ---------------------------------------------------------------------------
// AsrProvider implementation
// ---------------------------------------------------------------------------
#[async_trait]
impl AsrProvider for ParakeetProvider {
    fn name(&self) -> &str {
        "NVIDIA Parakeet TDT"
    }

    fn description(&self) -> &str {
        "NVIDIA Parakeet TDT CTC 110M — native ONNX inference with local artifacts \
         encoder.onnx + tokens.txt. Download uses public Hugging Face CTC ONNX sources and \
         normalizes files into the local parakeet model folder."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Parakeet TDT CTC 110M".to_string(),
            version: "110m".to_string(),
            size_mb: 170.0,
            parameters: "110M".to_string(),
            languages: vec![
                "en", "es", "fr", "de", "bg", "hr", "cs", "da", "nl", "et", "fi", "el", "hu", "it",
                "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "sv", "ru", "uk",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(6.05),
            real_time_factor: Some(0.7),
            license: "CC-BY-4.0".to_string(),
            source_url: format!("https://huggingface.co/{}", PARAKEET_HF_REPO),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if let Some(reason) = self.missing_or_invalid_reason() {
            return Err(anyhow::anyhow!(reason));
        }
        let start = std::time::Instant::now();
        let onnx_path = self.onnx_path();
        let vocab_path = self.vocab_path();
        let audio_path_owned = audio_path.to_path_buf();
        let audio_path_for_dur = audio_path_owned.clone();

        tracing::info!(
            "Parakeet transcription starting: onnx={}, vocab={}, audio={}",
            onnx_path.display(),
            vocab_path.display(),
            audio_path_owned.display()
        );

        let text = tokio::task::spawn_blocking(move || {
            run_parakeet_onnx(&onnx_path, &vocab_path, &audio_path_owned)
        })
        .await
        .context("Parakeet inference task panicked")??;

        tracing::info!(
            "Parakeet transcription complete: {} chars in {}ms",
            text.len(),
            start.elapsed().as_millis()
        );

        let duration = Self::wav_duration_seconds(&audio_path_for_dur);
        let segment = TranscriptSegment {
            start_time: 0.0,
            end_time: duration,
            text: text.clone(),
            confidence: 0.88,
        };

        Ok(TranscriptionResult {
            text,
            segments: vec![segment],
            language: "en".to_string(),
            confidence: 0.88,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: "parakeet-tdt-ctc-110m".to_string(),
            model_id: "parakeet-tdt-ctc-110m".to_string(),
            requested_provider: AsrProviderType::Parakeet,
            actual_provider: AsrProviderType::Parakeet,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join(format!("parakeet_{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for Parakeet")?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    fn download_status(&self) -> DownloadStatus {
        if self.has_required_files() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;

        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create Parakeet model directory")?;

        let manager = DownloadManager::new()?;
        let progress_cb = std::sync::Arc::new(progress_cb);

        let onnx_dest = self.model_dir.join(PARAKEET_ONNX_FILE);
        let vocab_dest = self.model_dir.join(PARAKEET_VOCAB_FILE);

        if onnx_dest.exists() && !is_valid_onnx_file(&onnx_dest) {
            std::fs::remove_file(&onnx_dest).ok();
        }
        if vocab_dest.exists() && !is_valid_tokens_file(&vocab_dest) {
            std::fs::remove_file(&vocab_dest).ok();
        }

        if !is_valid_onnx_file(&onnx_dest) {
            let mut last_error = None;
            for source in PARAKEET_ONNX_SOURCES {
                let cb = progress_cb.clone();
                match manager
                    .download_file_unverified(source, &onnx_dest, move |p| {
                        cb(p.percentage as f32 * 0.95);
                        tracing::info!(
                            "Parakeet encoder.onnx download from {}: {:.1}%",
                            source,
                            p.percentage
                        );
                    })
                    .await
                {
                    Ok(_) if is_valid_onnx_file(&onnx_dest) => {
                        last_error = None;
                        break;
                    }
                    Ok(_) => {
                        last_error = Some(format!(
                            "downloaded file from {} but artifact is invalid",
                            source
                        ));
                        std::fs::remove_file(&onnx_dest).ok();
                    }
                    Err(error) => {
                        last_error = Some(format!("{} ({})", source, error));
                    }
                }
            }
            if let Some(error) = last_error {
                return Err(anyhow::anyhow!(
                    "Failed to download Parakeet ONNX artifact from known sources: {}",
                    error
                ));
            }
        }

        if !is_valid_tokens_file(&vocab_dest) {
            let mut last_error = None;
            for source in PARAKEET_TOKENS_SOURCES {
                let cb = progress_cb.clone();
                match manager
                    .download_file_unverified(source, &vocab_dest, move |p| {
                        cb(95.0 + p.percentage as f32 * 0.05);
                    })
                    .await
                {
                    Ok(_) if is_valid_tokens_file(&vocab_dest) => {
                        last_error = None;
                        break;
                    }
                    Ok(_) => {
                        last_error = Some(format!(
                            "downloaded file from {} but tokens artifact is invalid",
                            source
                        ));
                        std::fs::remove_file(&vocab_dest).ok();
                    }
                    Err(error) => {
                        last_error = Some(format!("{} ({})", source, error));
                    }
                }
            }
            if let Some(error) = last_error {
                return Err(anyhow::anyhow!(
                    "Failed to download Parakeet tokens artifact from known sources: {}",
                    error
                ));
            }
        }

        tracing::info!("Parakeet TDT model downloaded successfully");
        Ok(())
    }
}
