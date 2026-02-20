use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Model artifact filenames
// sherpa-onnx NeMo Parakeet TDT 0.6B: encoder + token list
// ---------------------------------------------------------------------------
const PARAKEET_ONNX_FILE: &str = "encoder.onnx";
const PARAKEET_VOCAB_FILE: &str = "tokens.txt";

// Community ONNX export hosted on HuggingFace (k2-fsa / sherpa-onnx project).
// Model: nvidia/parakeet-tdt-0.6b-en converted to ONNX via NeMo export.
const PARAKEET_HF_REPO: &str = "k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en";
const PARAKEET_ONNX_URL: &str =
    "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/encoder.onnx";
const PARAKEET_VOCAB_URL: &str =
    "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/tokens.txt";
// ---------------------------------------------------------------------------
// Legacy filenames — also checked so users who placed model.onnx/vocab.txt work.
// ---------------------------------------------------------------------------
const PARAKEET_ONNX_FILE_ALT: &str = "model.onnx";
const PARAKEET_VOCAB_FILE_ALT: &str = "vocab.txt";

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
        let primary = self.model_dir.join(PARAKEET_ONNX_FILE);
        if is_valid_onnx_file(&primary) {
            return primary;
        }
        let alt = self.model_dir.join(PARAKEET_ONNX_FILE_ALT);
        if is_valid_onnx_file(&alt) {
            return alt;
        }
        primary
    }

    fn vocab_path(&self) -> PathBuf {
        let primary = self.model_dir.join(PARAKEET_VOCAB_FILE);
        if primary.exists() {
            return primary;
        }
        let alt = self.model_dir.join(PARAKEET_VOCAB_FILE_ALT);
        if alt.exists() {
            return alt;
        }
        primary
    }

    fn has_required_files(&self) -> bool {
        self.vocab_path().exists() && is_valid_onnx_file(&self.onnx_path())
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
fn run_parakeet_onnx(
    onnx_path: &Path,
    vocab_path: &Path,
    audio_path: &Path,
) -> Result<String> {
    use crate::audio::mel::MelSpectrogram;
    use ndarray::{Array, IxDyn};
    use ort::session::builder::GraphOptimizationLevel;
    use ort::session::Session;
    use ort::value::Tensor;

    // -----------------------------------------------------------------
    // 1. Load audio as 16 kHz mono f32 samples
    // -----------------------------------------------------------------
    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Parakeet")?;
    if samples.is_empty() {
        return Ok(String::new());
    }

    // -----------------------------------------------------------------
    // 2. Compute 80-bin log-mel spectrogram  → [T, 80] (sherpa-onnx NeMo format)
    //    NeMo ONNX expects: x [1, T, n_mels], x_lens [1]
    // -----------------------------------------------------------------
    let mel = MelSpectrogram::parakeet_defaults();
    let spec = mel.compute(&samples); // [80][T]
    if spec.is_empty() || spec[0].is_empty() {
        return Ok(String::new());
    }
    let n_mels = spec.len();
    let n_frames = spec[0].len();

    // Transpose to [T, n_mels] then pack as [1, T, n_mels]
    let flat: Vec<f32> = (0..n_frames)
        .flat_map(|t| (0..n_mels).map(move |m| spec[m][t]))
        .collect();
    let signal_arr: Array<f32, IxDyn> =
        Array::from_shape_vec(IxDyn(&[1, n_frames, n_mels]), flat)
            .context("Failed to build mel array")?;
    let len_arr: Array<i64, IxDyn> =
        Array::from_shape_vec(IxDyn(&[1]), vec![n_frames as i64])
            .context("Failed to build length array")?;

    // -----------------------------------------------------------------
    // 3. Load ONNX session
    // -----------------------------------------------------------------
    let mut session = Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("Failed to set opt level")?
        .commit_from_file(onnx_path)
        .context("Failed to load Parakeet ONNX — ensure encoder.onnx is a valid NeMo CTC export")?;

    // Build tensors — keep clones for the fallback attempt.
    let signal_arr2 = signal_arr.clone();
    let len_arr2 = len_arr.clone();
    let signal_tensor =
        Tensor::from_array(signal_arr).context("Failed to create signal tensor")?;
    let len_tensor =
        Tensor::from_array(len_arr).context("Failed to create length tensor")?;

    // Try sherpa-onnx naming ("x" / "x_lens") first, then NeMo export naming as fallback.
    // Sequential attempts avoid needing session.inputs introspection.
    let first_result =
        session.run(ort::inputs!["x" => signal_tensor, "x_lens" => len_tensor]);
    let outputs = if first_result.is_ok() {
        first_result.unwrap()
    } else {
        let s2 = Tensor::from_array(signal_arr2).context("Failed to rebuild signal tensor")?;
        let l2 = Tensor::from_array(len_arr2).context("Failed to rebuild length tensor")?;
        session
            .run(ort::inputs![
                "processed_signal" => s2,
                "processed_signal_length" => l2
            ])
            .context(
                "Parakeet ONNX inference failed — tried x/x_lens and \
                 processed_signal/processed_signal_length. \
                 Ensure the ONNX is from k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en \
                 or exported via NeMo (model.export('encoder.onnx')).",
            )?
    };

    // -----------------------------------------------------------------
    // 4. Greedy CTC decode  — output may be [1, T, V] or [1, V, T]
    // -----------------------------------------------------------------
    let logprobs_array = outputs[0]
        .try_extract_array::<f32>()
        .context("Failed to extract logprobs from Parakeet ONNX output")?;
    let shape = logprobs_array.shape().to_vec();
    if shape.len() < 3 {
        return Err(anyhow::anyhow!("Unexpected Parakeet output shape: {:?}", shape));
    }

    // Shape is [1, T_out, V] for sherpa-onnx / NeMo CTC
    let t_out = shape[1];
    let vocab_size = shape[2];

    let vocab = load_vocab(vocab_path)?;
    let blank_id = vocab.len().saturating_sub(1);

    let data: Vec<f32> = logprobs_array.iter().copied().collect();
    let mut token_ids: Vec<usize> = Vec::new();
    let mut prev = blank_id;
    for t in 0..t_out {
        let offset = t * vocab_size;
        let frame = &data[offset..offset + vocab_size];
        let best_id = frame
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(blank_id);
        if best_id != blank_id && best_id != prev {
            token_ids.push(best_id);
        }
        prev = best_id;
    }

    let text = token_ids
        .iter()
        .filter_map(|&id| vocab.get(id).map(String::as_str))
        .collect::<Vec<_>>()
        .concat()
        .replace('▁', " ")   // SentencePiece space
        .replace("##", "")    // WordPiece prefix
        .trim()
        .to_string();

    Ok(text)
}

/// Load a plain-text vocabulary file (one token per line, 0-indexed).
fn load_vocab(vocab_path: &Path) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(vocab_path)
        .with_context(|| format!("Failed to read Parakeet vocab: {}", vocab_path.display()))?;
    Ok(content.lines().map(str::to_string).collect())
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_parakeet_onnx(
    _onnx_path: &Path,
    _vocab_path: &Path,
    _audio_path: &Path,
) -> Result<String> {
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
        "NVIDIA Parakeet TDT 0.6B — native ONNX inference via sherpa-onnx community export. \
         Download provides encoder.onnx + tokens.txt from k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en. \
         You can also place your own NeMo ONNX export (encoder.onnx/model.onnx + tokens.txt/vocab.txt) \
         in the parakeet models folder."
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Parakeet TDT 0.6B V3".to_string(),
            version: "0.6b-v3".to_string(),
            size_mb: 1150.0,
            parameters: "600M".to_string(),
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
        if !self.has_required_files() {
            return Err(anyhow::anyhow!(
                "Parakeet model is not downloaded. Use the model manager to download it first."
            ));
        }
        let start = std::time::Instant::now();
        let onnx_path = self.onnx_path();
        let vocab_path = self.vocab_path();
        let audio_path_owned = audio_path.to_path_buf();
        let audio_path_for_dur = audio_path_owned.clone();

        let text = tokio::task::spawn_blocking(move || {
            run_parakeet_onnx(&onnx_path, &vocab_path, &audio_path_owned)
        })
        .await
        .context("Parakeet inference task panicked")??;

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
            model_name: "parakeet-tdt-0.6b-v3".to_string(),
            model_id: "parakeet-tdt-0.6b-v3".to_string(),
            requested_provider: AsrProviderType::Parakeet,
            actual_provider: AsrProviderType::Parakeet,
            fallback_used: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("parakeet_{}.wav", uuid::Uuid::new_v4()));
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

        // Download ONNX encoder (~600 MB)
        if !is_valid_onnx_file(&onnx_dest) {
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(PARAKEET_ONNX_URL, &onnx_dest, move |p| {
                    cb(p.percentage as f32 * 0.95);
                    tracing::info!("Parakeet encoder.onnx download: {:.1}%", p.percentage);
                })
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Failed to download Parakeet ONNX from {}. \
                     If the URL is unavailable, manually place encoder.onnx in the parakeet \
                     models folder (export from NeMo with: model.export('encoder.onnx')). \
                     Error: {}",
                    PARAKEET_ONNX_URL, e
                ))?;
        }

        // Download vocabulary/token list (~5 KB)
        if !vocab_dest.exists() {
            let cb = progress_cb.clone();
            manager
                .download_file_unverified(PARAKEET_VOCAB_URL, &vocab_dest, move |p| {
                    cb(95.0 + p.percentage as f32 * 0.05);
                })
                .await?;
        }

        tracing::info!("Parakeet TDT model downloaded successfully");
        Ok(())
    }
}
