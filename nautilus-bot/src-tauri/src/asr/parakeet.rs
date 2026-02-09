use super::{AsrProvider, DownloadStatus, ModelInfo, TranscriptionResult};
use anyhow::Result;
use async_trait::async_trait;
use std::path::{Path, PathBuf};

pub struct ParakeetProvider {
    model_path: PathBuf,
    #[allow(dead_code)]
    models_dir: PathBuf,
}

impl ParakeetProvider {
    pub fn new() -> Self {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("parakeet");

        Self {
            model_path: models_dir.join("parakeet-tdt-0.6b-v3.onnx"),
            models_dir,
        }
    }
}

#[async_trait]
impl AsrProvider for ParakeetProvider {
    fn name(&self) -> &str {
        "NVIDIA Parakeet TDT"
    }

    fn description(&self) -> &str {
        "NVIDIA's Parakeet TDT 0.6B. Download support is available, but inference is not enabled in this production build."
    }

    fn is_available(&self) -> bool {
        false
    }

    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Parakeet TDT 0.6B V3".to_string(),
            version: "0.6b-v3".to_string(),
            size_mb: 600.0,
            parameters: "600M".to_string(),
            languages: vec![
                "en", "bg", "hr", "cs", "da", "nl", "et", "fi", "fr", "de", "el", "hu", "it", "lv",
                "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
            ]
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
            word_error_rate: Some(6.05),
            real_time_factor: Some(3386.0), // Extremely fast!
            license: "CC-BY-4.0".to_string(),
            source_url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3".to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let _ = audio_path;
        Err(anyhow::anyhow!(
            "Parakeet inference is not implemented in this build. Use the Whisper provider."
        ))
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join("parakeet_temp.wav");
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

        let url = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/onnx/model.onnx";

        let progress_callback = |progress: crate::download::DownloadProgress| {
            tracing::info!(
                "Parakeet download progress: {:.1}% ({}/s)",
                progress.percentage,
                crate::download::format_bytes(progress.bytes_downloaded)
            );
        };

        manager
            .download_file(url, &self.model_path, progress_callback)
            .await?;

        tracing::info!("Parakeet model downloaded to {:?}", self.model_path);
        Ok(())
    }
}

/// Performance characteristics of Parakeet TDT:
/// - RTF (Real-Time Factor): 3386x (transcribes 1 hour of audio in ~1 second!)
/// - WER: 6.05% on English
/// - Memory: ~600MB model size
/// - Supports: 25 European languages
/// - Architecture: FastConformer with TDT decoder
/// - Max audio length: 24 minutes
/// - Format: ONNX for cross-platform inference
const _PARAKEET_INFO: () = ();

/// Compute log mel spectrogram from audio samples
/// Parakeet expects 80 mel bins at 16kHz
#[cfg(feature = "asr-parakeet")]
#[allow(dead_code)]
fn compute_log_mel_spectrogram(audio: &[f32], _sample_rate: u32) -> Vec<f32> {
    // Simplified mel spectrogram computation
    // In production, use a proper mel filterbank
    let num_mels = 80;
    let hop_length = 160; // 10ms at 16kHz
    let n_fft = 400; // 25ms window

    let num_frames = (audio.len().saturating_sub(n_fft)) / hop_length + 1;

    // Simplified: just return zeros for now
    // Real implementation would:
    // 1. Apply window function (Hamming/Hann)
    // 2. Compute FFT
    // 3. Apply mel filterbank
    // 4. Take log
    vec![0.0; num_frames * num_mels]
}

/// Decode CTC tokens to text
/// Simplified decoder - real implementation would use a proper tokenizer
#[cfg(feature = "asr-parakeet")]
#[allow(dead_code)]
fn decode_tokens(tokens: &[i64]) -> String {
    // Simple character mapping for demonstration
    // Real implementation would use the SentencePiece or BPE tokenizer
    let alphabet = b" abcdefghijklmnopqrstuvwxyz'";
    let mut result = String::new();
    let mut prev_token = -1i64;

    for &token in tokens {
        // CTC: skip blanks (0) and repeats
        if token == 0 || token == prev_token {
            prev_token = token;
            continue;
        }

        // Map token to character
        let idx = (token - 1) as usize;
        if let Some(byte) = alphabet.get(idx) {
            result.push(char::from(*byte));
        }

        prev_token = token;
    }

    result.trim().to_string()
}
