//! Model download manager with progress tracking
//!
//! Handles downloading ASR models from HuggingFace and other sources
//! with resume support, checksum verification, and progress callbacks.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// Download manager for ASR models
pub struct DownloadManager {
    client: reqwest::Client,
    models_dir: PathBuf,
}

/// Download progress information
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    #[allow(dead_code)]
    pub speed_mbps: f64,
}

impl DownloadManager {
    /// Create a new download manager
    pub fn new() -> Result<Self> {
        let models_dir = dirs::data_dir()
            .context("Could not find data directory")?
            .join("Nautilus")
            .join("models");

        std::fs::create_dir_all(&models_dir)?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()?;

        Ok(Self { client, models_dir })
    }

    /// Download a file with progress tracking
    #[allow(dead_code)]
    pub async fn download_file(
        &self,
        url: &str,
        destination: &PathBuf,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<()> {
        // Create parent directory if needed
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Create temp file
        let temp_path = destination.with_extension("tmp");

        // Check for partial download
        let start_byte = if temp_path.exists() {
            let metadata = tokio::fs::metadata(&temp_path).await?;
            metadata.len()
        } else {
            0
        };

        // Build request with resume support
        let mut request = self.client.get(url);
        if start_byte > 0 {
            request = request.header("Range", format!("bytes={}-", start_byte));
        }

        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let snippet = body.trim().chars().take(200).collect::<String>();
            return Err(anyhow::anyhow!(
                "Download failed for {}: HTTP {}{}",
                url,
                status,
                if snippet.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", snippet)
                }
            ));
        }
        let expected_sha256 = extract_sha256_from_headers(response.headers());

        // Get total size
        let total_size = response
            .content_length()
            .map(|l| l + start_byte)
            .unwrap_or(0);

        // Open file for writing (append if resuming)
        let mut file = File::options()
            .create(true)
            .append(true)
            .open(&temp_path)
            .await?;

        let mut stream = response.bytes_stream();
        let bytes_downloaded = Arc::new(AtomicU64::new(start_byte));
        let start_time = std::time::Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;

            let current = bytes_downloaded.fetch_add(chunk.len() as u64, Ordering::SeqCst)
                + chunk.len() as u64;

            // Calculate progress
            let elapsed_secs = start_time.elapsed().as_secs_f64();
            let speed_mbps = if elapsed_secs > 0.0 {
                (current as f64 / elapsed_secs) / (1024.0 * 1024.0)
            } else {
                0.0
            };

            let progress = DownloadProgress {
                bytes_downloaded: current,
                total_bytes: total_size,
                percentage: if total_size > 0 {
                    (current as f64 / total_size as f64) * 100.0
                } else {
                    0.0
                },
                speed_mbps,
            };

            progress_callback(progress);
        }

        // Close file
        file.flush().await?;
        drop(file);

        // Rename temp file to final destination
        tokio::fs::rename(&temp_path, destination).await?;

        if let Some(expected_sha256) = expected_sha256 {
            let actual_sha256 = calculate_sha256(destination).await?;
            if actual_sha256 != expected_sha256 {
                tokio::fs::remove_file(destination).await.ok();
                return Err(anyhow::anyhow!(
                    "Integrity verification failed for {}. Expected sha256 {}, got {}",
                    destination.display(),
                    expected_sha256,
                    actual_sha256
                ));
            }
            tracing::info!(
                "Integrity verified for {} via response checksum metadata",
                destination.display()
            );
        }

        tracing::info!("Downloaded {} to {:?}", url, destination);

        Ok(())
    }

    /// Download a Whisper model
    pub async fn download_whisper_model(
        &self,
        model_name: &str,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<PathBuf> {
        let model_info = get_whisper_model_info(model_name)
            .ok_or_else(|| anyhow::anyhow!("Unknown Whisper model: {}", model_name))?;

        let destination = self.models_dir.join("whisper").join(&model_info.file_name);
        let min_expected_bytes = min_expected_model_bytes(model_info.size_mb);

        // Check if already downloaded and valid enough for use.
        if destination.exists() {
            if validate_whisper_artifact(&destination, min_expected_bytes).await {
                tracing::info!("Model {} already exists at {:?}", model_name, destination);
                return Ok(destination);
            }
            tracing::warn!(
                "Existing Whisper model {} at {:?} failed validation. Re-downloading.",
                model_name,
                destination
            );
            tokio::fs::remove_file(&destination).await.ok();
        }

        tracing::info!(
            "Downloading Whisper model {} from {}",
            model_name,
            model_info.url
        );

        // Whisper model assets are large LFS blobs; HF response etag/checksum metadata can be
        // inconsistent across redirect hops. Use unverified transport then validate artifact bytes.
        self.download_file_unverified(&model_info.url, &destination, progress_callback)
            .await?;

        if !validate_whisper_artifact(&destination, min_expected_bytes).await {
            tokio::fs::remove_file(&destination).await.ok();
            return Err(anyhow::anyhow!(
                "Downloaded Whisper model '{}' is invalid or incomplete. Re-try download.",
                model_name
            ));
        }

        // Verify checksum if available
        if let Some(expected_checksum) = &model_info.sha256 {
            let actual_checksum = calculate_sha256(&destination).await?;
            if actual_checksum != *expected_checksum {
                // Delete corrupted file
                tokio::fs::remove_file(&destination).await.ok();
                return Err(anyhow::anyhow!(
                    "Checksum mismatch for {}. Expected: {}, Got: {}",
                    model_name,
                    expected_checksum,
                    actual_checksum
                ));
            }
            tracing::info!("Checksum verified for {}", model_name);
        }

        Ok(destination)
    }

    /// Download diarization/speaker embedding model
    /// Download a file without checksum verification (useful for LFS files where ETag != content hash)
    pub async fn download_file_unverified(
        &self,
        url: &str,
        destination: &PathBuf,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<()> {
        // Create parent directory if needed
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let temp_path = destination.with_extension("tmp");

        let client = &self.client;
        let mut request = client.get(url);

        let start_byte = if temp_path.exists() {
            let metadata = tokio::fs::metadata(&temp_path).await?;
            metadata.len()
        } else {
            0
        };

        if start_byte > 0 {
            request = request.header("Range", format!("bytes={}-", start_byte));
        }

        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let snippet = body.trim().chars().take(200).collect::<String>();
            return Err(anyhow::anyhow!(
                "Download failed for {}: HTTP {}{}",
                url,
                status,
                if snippet.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", snippet)
                }
            ));
        }
        let total_size = response
            .content_length()
            .map(|l| l + start_byte)
            .unwrap_or(0);

        let mut file = File::options()
            .create(true)
            .append(true)
            .open(&temp_path)
            .await?;

        let mut stream = response.bytes_stream();
        let bytes_downloaded = Arc::new(AtomicU64::new(start_byte));
        let _start_time = std::time::Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;

            let current = bytes_downloaded.fetch_add(chunk.len() as u64, Ordering::SeqCst)
                + chunk.len() as u64;

            // Throttle progress updates
            if total_size > 0 {
                let progress = DownloadProgress {
                    bytes_downloaded: current,
                    total_bytes: total_size,
                    percentage: (current as f64 / total_size as f64) * 100.0,
                    speed_mbps: 0.0, // simplified
                };
                progress_callback(progress);
            }
        }

        file.flush().await?;
        tokio::fs::rename(temp_path, destination).await?;
        Ok(())
    }

    /// Download a specific diarization model by ID
    pub async fn download_diarization_model_by_id(
        &self,
        model_id: &str,
        _progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<PathBuf> {
        let diarization_dir = self.models_dir.join("diarization");
        tokio::fs::create_dir_all(&diarization_dir).await?;

        let (url, filename) = match model_id {
            "ecapa_tdnn_speaker" => (
                "https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM/resolve/main/voxceleb_ECAPA512_LM.onnx",
                "ecapa_tdnn_speaker.onnx",
            ),
            "resnet34_speaker" => (
                "https://huggingface.co/Wespeaker/wespeaker-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx",
                "resnet34_speaker.onnx",
            ),
            "campplus_speaker" => (
                "https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM/resolve/main/voxceleb_CAM%2B%2B_LM.onnx",
                "campplus_speaker.onnx",
            ),
            _ => {
                return Err(anyhow::anyhow!(
                    "Unknown diarization model: {}. Supported: ecapa_tdnn_speaker, resnet34_speaker, campplus_speaker",
                    model_id
                ));
            }
        };

        let destination = diarization_dir.join(filename);

        if destination.exists() {
            tracing::info!("Diarization model {} already exists at {:?}", model_id, destination);
            return Ok(destination);
        }

        tracing::info!("Downloading diarization model {} from {}", model_id, url);
        tracing::info!("Starting unverified download of diarization model (HF ETag bypassed)");

        // Use unverified download because HF S3 ETag often matches LFS pointer, not content
        self.download_file_unverified(url, &destination, _progress_callback)
            .await?;

        // Verify file size (should be > 5MB)
        let metadata = tokio::fs::metadata(&destination).await?;
        if metadata.len() < 5 * 1024 * 1024 {
            tokio::fs::remove_file(&destination).await.ok();
            return Err(anyhow::anyhow!(
                "Downloaded diarization model is too small ({} bytes). Download failed.",
                metadata.len()
            ));
        }

        tracing::info!(
            "Diarization model {} downloaded successfully to {:?}",
            model_id,
            destination
        );

        Ok(destination)
    }

    /// Check if diarization model is downloaded
    #[allow(dead_code)]
    pub fn is_diarization_model_downloaded(&self) -> bool {
        self.models_dir
            .join("diarization")
            .join("ecapa_tdnn_speaker.onnx")
            .exists()
    }

    /// Get available space in models directory
    pub async fn get_available_space(&self) -> Result<u64> {
        // This is platform-specific
        // For now, return a large number
        Ok(100 * 1024 * 1024 * 1024) // 100 GB
    }

    /// List downloaded models
    pub async fn list_downloaded_models(&self) -> Result<Vec<DownloadedModel>> {
        let mut models = Vec::new();

        // Check Whisper models
        let whisper_dir = self.models_dir.join("whisper");
        if whisper_dir.exists() {
            let mut entries = tokio::fs::read_dir(&whisper_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Whisper {}", name),
                        provider: "whisper".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check Parakeet models
        let parakeet_dir = self.models_dir.join("parakeet");
        if parakeet_dir.exists() {
            let mut entries = tokio::fs::read_dir(&parakeet_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Parakeet {}", name),
                        provider: "parakeet".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check Canary models
        let canary_dir = self.models_dir.join("canary");
        if canary_dir.exists() {
            let mut entries = tokio::fs::read_dir(&canary_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Canary {}", name),
                        provider: "canary".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check Distil Whisper models
        let distil_dir = self.models_dir.join("distil_whisper");
        if distil_dir.exists() {
            let mut entries = tokio::fs::read_dir(&distil_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Distil {}", name),
                        provider: "distil_whisper".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        Ok(models)
    }

    /// Delete a model (path must be under the managed models directory)
    pub async fn delete_model(&self, path: &PathBuf) -> Result<()> {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("Cannot resolve path: {:?}", path))?;
        let models_canonical = self
            .models_dir
            .canonicalize()
            .with_context(|| format!("Cannot resolve models dir: {:?}", self.models_dir))?;

        if !canonical.starts_with(&models_canonical) {
            return Err(anyhow::anyhow!(
                "Refusing to delete file outside models directory: {:?}",
                path
            ));
        }

        tokio::fs::remove_file(&canonical).await?;
        tracing::info!("Deleted model at {:?}", canonical);
        Ok(())
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new().expect("Failed to create download manager")
    }
}

/// Information about a downloaded model
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedModel {
    pub name: String,
    pub provider: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub downloaded_at: std::time::SystemTime,
}

/// Whisper model information
#[derive(Debug, Clone)]
pub struct WhisperModelInfo {
    pub name: String,
    pub file_name: String,
    #[allow(dead_code)]
    pub size_mb: f64,
    pub url: String,
    pub sha256: Option<String>,
}

/// Get information about a Whisper model
fn get_whisper_model_info(model_name: &str) -> Option<WhisperModelInfo> {
    let models = vec![
        WhisperModelInfo {
            name: "tiny".to_string(),
            file_name: "ggml-tiny.bin".to_string(),
            size_mb: 75.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "tiny.en".to_string(),
            file_name: "ggml-tiny.en.bin".to_string(),
            size_mb: 75.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "base".to_string(),
            file_name: "ggml-base.bin".to_string(),
            size_mb: 142.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "base.en".to_string(),
            file_name: "ggml-base.en.bin".to_string(),
            size_mb: 142.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "small".to_string(),
            file_name: "ggml-small.bin".to_string(),
            size_mb: 466.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "small.en".to_string(),
            file_name: "ggml-small.en.bin".to_string(),
            size_mb: 466.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "medium".to_string(),
            file_name: "ggml-medium.bin".to_string(),
            size_mb: 1500.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "medium.en".to_string(),
            file_name: "ggml-medium.en.bin".to_string(),
            size_mb: 1500.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "large-v3".to_string(),
            file_name: "ggml-large-v3.bin".to_string(),
            size_mb: 2900.0,
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
                .to_string(),
            sha256: None,
        },
        WhisperModelInfo {
            name: "large-v3-turbo".to_string(),
            file_name: "ggml-large-v3-turbo.bin".to_string(),
            size_mb: 1620.0,
            url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
                    .to_string(),
            sha256: None,
        },
    ];

    models.into_iter().find(|m| m.name == model_name)
}

/// Calculate SHA256 checksum of a file
async fn calculate_sha256(path: &PathBuf) -> Result<String> {
    use sha2::{Digest, Sha256};

    let data = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();

    Ok(format!("{:x}", result))
}

fn min_expected_model_bytes(size_mb: f64) -> u64 {
    // Be tolerant of upstream size changes while still rejecting tiny HTML/LFS pointer payloads.
    // 25% of expected size, with a 1 MB floor.
    let bytes = (size_mb * 1024.0 * 1024.0 * 0.25) as u64;
    bytes.max(1024 * 1024)
}

async fn validate_whisper_artifact(path: &PathBuf, min_expected_bytes: u64) -> bool {
    use tokio::io::AsyncReadExt;

    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    if meta.len() < min_expected_bytes {
        return false;
    }

    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut first = [0u8; 1];
    if file.read_exact(&mut first).await.is_err() {
        return false;
    }

    first[0] != b'<' && first[0] != b'{'
}

#[allow(dead_code)]
fn extract_sha256_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get("x-linked-etag")
        .or_else(|| headers.get("etag"))
        .and_then(|value| value.to_str().ok())
        .and_then(extract_sha256_from_header_value)
}

fn extract_sha256_from_header_value(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    if let Some(stripped) = value.strip_prefix("W/") {
        value = stripped.trim();
    }
    value = value.trim_matches('"');

    if let Some(stripped) = value.strip_prefix("sha256:") {
        value = stripped.trim();
    }

    let lowered = value.to_ascii_lowercase();
    if lowered.len() == 64 && lowered.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Some(lowered);
    }

    None
}

/// Format bytes to human-readable string
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];

    if bytes == 0 {
        return "0 B".to_string();
    }

    let exp = (bytes as f64).log(1024.0).min(UNITS.len() as f64 - 1.0) as usize;
    let value = bytes as f64 / 1024f64.powi(exp as i32);

    format!("{:.1} {}", value, UNITS[exp])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
    }

    #[test]
    fn test_get_whisper_model_info() {
        let info = get_whisper_model_info("base.en");
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.file_name, "ggml-base.en.bin");
        assert_eq!(info.size_mb, 142.0);
    }

    #[test]
    fn test_extract_sha256_from_header_value() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            extract_sha256_from_header_value(&format!("\"{}\"", digest)),
            Some(digest.to_string())
        );
        assert_eq!(
            extract_sha256_from_header_value(&format!("W/\"sha256:{}\"", digest)),
            Some(digest.to_string())
        );
        assert_eq!(extract_sha256_from_header_value("\"not-a-digest\""), None);
    }
}
