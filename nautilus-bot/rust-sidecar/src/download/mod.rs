//! Model download manager with progress tracking
//!
//! Handles downloading ASR models from HuggingFace and other sources
//! with resume support, checksum verification, and progress callbacks.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const WHISPER_MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_INTEGRITY_RECEIPT_VERSION: &str = "plainsong-model-integrity-v1";
const MAX_GENERIC_MODEL_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Download manager for ASR models
pub struct DownloadManager {
    client: reqwest::Client,
    models_dir: PathBuf,
}

/// Silero VAD (MIT-licensed) ONNX model, fetched directly from the upstream
/// `snakers4/silero-vad` GitHub repo. Verified by direct binary download and
/// inspection: this is a real ONNX protobuf file (not an HTML/LFS-pointer
/// error page), current size ~2.2MB.
/// See `crate::audio::silero_vad` for the model's input/output contract.
const SILERO_VAD_ONNX_URL: &str =
    "https://raw.githubusercontent.com/snakers4/silero-vad/76e3dc408eb2a5c655c34e230d2d5459b4439daa/src/silero_vad/data/silero_vad.onnx";
const SILERO_VAD_ONNX_SHA256: &str =
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";
const SILERO_VAD_ONNX_FILE: &str = "silero_vad.onnx";
/// The real file is ~2.2MB; tolerate upstream size drift but reject tiny
/// HTML/error-page payloads (same defensive pattern as
/// `min_expected_model_bytes` for Whisper models).
const SILERO_VAD_MIN_EXPECTED_BYTES: u64 = 512 * 1024;
const SILERO_VAD_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
struct DiarizationModelInfo {
    url: &'static str,
    file_name: &'static str,
    sha256: &'static str,
    max_bytes: u64,
}

fn diarization_model_info(model_id: &str) -> Option<DiarizationModelInfo> {
    match model_id {
        "ecapa_tdnn_speaker" => Some(DiarizationModelInfo {
            url: "https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM/resolve/a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b/voxceleb_ECAPA512_LM.onnx",
            file_name: "ecapa_tdnn_speaker.onnx",
            sha256: "d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0",
            max_bytes: 256 * 1024 * 1024,
        }),
        "resnet34_speaker" => Some(DiarizationModelInfo {
            url: "https://huggingface.co/Wespeaker/wespeaker-resnet34-LM/resolve/f0c48c298fd835726c27956a5d617bad7115627e/voxceleb_resnet34_LM.onnx",
            file_name: "resnet34_speaker.onnx",
            sha256: "7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068",
            max_bytes: 256 * 1024 * 1024,
        }),
        "campplus_speaker" => Some(DiarizationModelInfo {
            url: "https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM/resolve/c5e01c6fcffcce160861e7e79782828320192b5c/voxceleb_CAM%2B%2B_LM.onnx",
            file_name: "campplus_speaker.onnx",
            sha256: "1068e4ac3a76bb9c769e6816ef30bf89363f6e966f1d938210cb8ed4038f8e93",
            max_bytes: 256 * 1024 * 1024,
        }),
        "eres2netv2_speaker" => Some(DiarizationModelInfo {
            url: "https://huggingface.co/phoenix124/kept-models/resolve/42de48f3d8cb1c33ad29f4dbe2db0801a0759ddf/diarize-embedding-eres2netv2-int8.onnx",
            file_name: "eres2netv2_speaker.onnx",
            sha256: "be6b162137d8b08854268a97763c007e49882f221e02950242923d40d2be157e",
            max_bytes: 64 * 1024 * 1024,
        }),
        _ => None,
    }
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn model_integrity_receipt_path(path: &Path) -> PathBuf {
    path_with_suffix(path, ".plainsong-integrity")
}

fn is_internal_model_metadata_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".plainsong-integrity") || name.contains(".plainsong-integrity.tmp")
        })
}

fn model_integrity_receipt_contents(path: &Path, expected_sha256: &str) -> Result<String> {
    let metadata = std::fs::metadata(path)?;
    let modified_nanos = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .context("Model modification time predates the Unix epoch")?
        .as_nanos();
    Ok(format!(
        "{}\nsha256={}\nsize={}\nmodified_nanos={}\n",
        MODEL_INTEGRITY_RECEIPT_VERSION,
        expected_sha256,
        metadata.len(),
        modified_nanos
    ))
}

pub(crate) fn is_model_artifact_trusted(path: &Path, expected_sha256: &str) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(expected_receipt) = model_integrity_receipt_contents(path, expected_sha256) else {
        return false;
    };
    std::fs::read_to_string(model_integrity_receipt_path(path))
        .is_ok_and(|receipt| receipt == expected_receipt)
}

#[cfg(feature = "asr-whisper")]
pub(crate) fn whisper_model_expected_sha256(model_id: &str) -> Option<String> {
    get_whisper_model_info(model_id).map(|model| model.sha256)
}

#[cfg(feature = "asr-whisper")]
pub(crate) fn is_whisper_model_artifact_trusted(model_id: &str, path: &Path) -> bool {
    whisper_model_expected_sha256(model_id)
        .is_some_and(|sha256| is_model_artifact_trusted(path, &sha256))
}

pub(crate) fn is_diarization_model_artifact_trusted(model_id: &str, path: &Path) -> bool {
    diarization_model_info(model_id)
        .is_some_and(|model| is_model_artifact_trusted(path, model.sha256))
}

async fn write_model_integrity_receipt(path: &Path, expected_sha256: &str) -> Result<()> {
    let receipt_path = model_integrity_receipt_path(path);
    let temp_receipt_path = path_with_suffix(&receipt_path, ".tmp");
    let contents = model_integrity_receipt_contents(path, expected_sha256)?;
    tokio::fs::write(&temp_receipt_path, contents).await?;
    tokio::fs::rename(&temp_receipt_path, &receipt_path).await?;
    Ok(())
}

async fn verify_or_record_model_integrity(path: &PathBuf, expected_sha256: &str) -> Result<bool> {
    if is_model_artifact_trusted(path, expected_sha256) {
        return Ok(true);
    }

    // When no SHA256 is pinned, skip integrity verification and trust the
    // file as-is. This is used for models whose hashes have not yet been
    // populated. The file must still exist and be non-empty.
    if expected_sha256.is_empty() {
        let exists = tokio::fs::metadata(path).await.is_ok();
        if exists {
            tracing::warn!(
                "Model {} has no pinned SHA256 — skipping integrity verification",
                path.display()
            );
        }
        return Ok(exists);
    }

    let actual_sha256 = calculate_sha256(path).await?;
    if actual_sha256 != expected_sha256 {
        return Ok(false);
    }
    write_model_integrity_receipt(path, expected_sha256).await?;
    Ok(true)
}

#[derive(Debug, Default)]
pub(crate) struct ModelIntegrityMigrationReport {
    pub migrated_count: usize,
    pub rejected_paths: Vec<PathBuf>,
    pub errors: Vec<(PathBuf, String)>,
}

/// Upgrade model caches created before integrity receipts were introduced.
///
/// Each existing artifact is hashed once against an application-pinned
/// digest. Exact matches receive a metadata-bound receipt, so all later
/// readiness checks stay fast. Mismatches remain installed but untrusted,
/// preserving the fail-closed security boundary without deleting user data
/// during startup.
pub(crate) async fn migrate_legacy_model_integrity_receipts(
    artifacts: &[(PathBuf, String)],
) -> ModelIntegrityMigrationReport {
    let mut report = ModelIntegrityMigrationReport::default();

    for (path, expected_sha256) in artifacts {
        if !path.is_file() || is_model_artifact_trusted(path, expected_sha256) {
            continue;
        }

        match verify_or_record_model_integrity(path, expected_sha256).await {
            Ok(true) => report.migrated_count += 1,
            Ok(false) => {
                tokio::fs::remove_file(model_integrity_receipt_path(path))
                    .await
                    .ok();
                report.rejected_paths.push(path.clone());
            }
            Err(error) => {
                tokio::fs::remove_file(model_integrity_receipt_path(path))
                    .await
                    .ok();
                report.errors.push((path.clone(), error.to_string()));
            }
        }
    }

    report
}

pub(crate) fn managed_model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let mut artifacts = Vec::new();

    for model_id in [
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v3",
        "large-v3-turbo",
    ] {
        if let Some(model) = get_whisper_model_info(model_id) {
            artifacts.push((
                models_root.join("whisper").join(model.file_name),
                model.sha256,
            ));
        }
    }

    for model_id in [
        "ecapa_tdnn_speaker",
        "resnet34_speaker",
        "campplus_speaker",
        "eres2netv2_speaker",
    ] {
        if let Some(model) = diarization_model_info(model_id) {
            artifacts.push((
                models_root.join("diarization").join(model.file_name),
                model.sha256.to_string(),
            ));
        }
    }

    artifacts.push((
        models_root.join("vad").join(SILERO_VAD_ONNX_FILE),
        SILERO_VAD_ONNX_SHA256.to_string(),
    ));
    artifacts
}

async fn remove_model_artifact(path: &Path) {
    tokio::fs::remove_file(path).await.ok();
    tokio::fs::remove_file(model_integrity_receipt_path(path))
        .await
        .ok();
}

/// HTTP client for model downloads. Deliberately no total-request timeout:
/// model files run to ~2.8 GiB, and a total timeout kills any healthy
/// transfer slower than (size / timeout) — e.g. a 5-minute cap required
/// ~41 Mbps sustained for distil-large-v3.5, so slower connections failed
/// on every attempt. Instead, bound how long we wait to connect and how
/// long a read may sit idle, which still catches dead connections quickly.
fn build_download_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
}

fn download_size_limit_error(url: &str, max_bytes: u64) -> anyhow::Error {
    anyhow::anyhow!(
        "SIDECAR_SIZE_LIMIT: download from {} exceeds the pinned artifact ceiling of {} bytes.",
        url,
        max_bytes
    )
}

fn checked_download_size(
    current: u64,
    next_chunk_bytes: usize,
    max_bytes: u64,
    url: &str,
) -> Result<u64> {
    let next = current
        .checked_add(next_chunk_bytes as u64)
        .ok_or_else(|| download_size_limit_error(url, max_bytes))?;
    if next > max_bytes {
        return Err(download_size_limit_error(url, max_bytes));
    }
    Ok(next)
}

fn progress_percent_bucket(current_bytes: u64, total_bytes: u64) -> Option<u8> {
    if total_bytes == 0 {
        return None;
    }
    Some((((current_bytes as f64 / total_bytes as f64) * 100.0).floor() as u64).min(100) as u8)
}

/// Download progress information
#[derive(Debug, Clone)]
#[expect(
    dead_code,
    reason = "progress speed is exposed to downloader callbacks even when current callers ignore it"
)]
pub struct DownloadProgress {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub speed_mbps: f64,
}

impl DownloadManager {
    /// Create a new download manager
    pub fn new() -> Result<Self> {
        let models_dir = crate::paths::data_dir()
            .context("Could not find data directory")?
            .join("Plainsong")
            .join("models");

        std::fs::create_dir_all(&models_dir)?;

        let client = build_download_client()?;

        Ok(Self { client, models_dir })
    }

    /// Download a file with progress tracking
    #[expect(
        dead_code,
        reason = "generic resumable downloader kept for model sources not covered by specialized helpers"
    )]
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
        let mut start_byte = if temp_path.exists() {
            let metadata = tokio::fs::metadata(&temp_path).await?;
            metadata.len()
        } else {
            0
        };
        if start_byte > MAX_GENERIC_MODEL_ARTIFACT_BYTES {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(
                url,
                MAX_GENERIC_MODEL_ARTIFACT_BYTES,
            ));
        }

        // Build request with resume support
        let mut request = self.client.get(url);
        if start_byte > 0 {
            request = request.header("Range", format!("bytes={}-", start_byte));
        }

        let mut response = request.send().await?;

        // 416 means our tmp file is unusable as a resume base (e.g. already
        // complete); discard it and start over instead of failing forever.
        if start_byte > 0 && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            tracing::warn!(
                "Resume of {} rejected with 416; discarding partial file and restarting",
                url
            );
            tokio::fs::remove_file(&temp_path).await.ok();
            start_byte = 0;
            response = self.client.get(url).send().await?;
        }

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

        // Only a 206 Partial Content reply actually honored the Range header.
        // A server/proxy that ignores Range replies 200 with the entire body,
        // which must overwrite the partial tmp file -- appending it after the
        // existing bytes would silently corrupt the artifact.
        let resuming = start_byte > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if start_byte > 0 && !resuming {
            tracing::warn!(
                "Server ignored Range request for {} (HTTP {}); restarting download from scratch",
                url,
                response.status()
            );
            start_byte = 0;
        }

        // Get total size
        let declared_remaining = response.content_length();
        if declared_remaining
            .is_some_and(|length| length > MAX_GENERIC_MODEL_ARTIFACT_BYTES - start_byte)
        {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(
                url,
                MAX_GENERIC_MODEL_ARTIFACT_BYTES,
            ));
        }
        let total_size = declared_remaining
            .map(|length| length + start_byte)
            .unwrap_or(0);
        if total_size > MAX_GENERIC_MODEL_ARTIFACT_BYTES {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(
                url,
                MAX_GENERIC_MODEL_ARTIFACT_BYTES,
            ));
        }

        // Open file for writing (append only when the server honored the
        // resume; otherwise truncate any stale partial content).
        let mut file = if resuming {
            File::options().append(true).open(&temp_path).await?
        } else {
            File::create(&temp_path).await?
        };

        let mut stream = response.bytes_stream();
        let bytes_downloaded = Arc::new(AtomicU64::new(start_byte));
        let start_time = std::time::Instant::now();
        let mut last_progress_bucket = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let current = match checked_download_size(
                bytes_downloaded.load(Ordering::SeqCst),
                chunk.len(),
                MAX_GENERIC_MODEL_ARTIFACT_BYTES,
                url,
            ) {
                Ok(current) => current,
                Err(error) => {
                    drop(file);
                    tokio::fs::remove_file(&temp_path).await.ok();
                    return Err(error);
                }
            };
            file.write_all(&chunk).await?;
            bytes_downloaded.store(current, Ordering::SeqCst);

            // Calculate progress
            let elapsed_secs = start_time.elapsed().as_secs_f64();
            let speed_mbps = if elapsed_secs > 0.0 {
                (current as f64 / elapsed_secs) / (1024.0 * 1024.0)
            } else {
                0.0
            };

            let current_bucket = progress_percent_bucket(current, total_size);
            if current_bucket != last_progress_bucket {
                last_progress_bucket = current_bucket;
                progress_callback(DownloadProgress {
                    bytes_downloaded: current,
                    total_bytes: total_size,
                    percentage: if total_size > 0 {
                        (current as f64 / total_size as f64) * 100.0
                    } else {
                        0.0
                    },
                    speed_mbps,
                });
            }
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

        // Upgrade legacy caches in place by hashing them once and recording a
        // receipt. Future launches can validate the small receipt plus file
        // metadata instead of re-reading multi-gigabyte models.
        if destination.exists() {
            if validate_whisper_artifact(&destination, min_expected_bytes).await
                && verify_or_record_model_integrity(&destination, &model_info.sha256).await?
            {
                tracing::info!("Model {} already exists at {:?}", model_name, destination);
                return Ok(destination);
            }
            tracing::warn!(
                "Existing Whisper model {} at {:?} failed validation. Re-downloading.",
                model_name,
                destination
            );
            remove_model_artifact(&destination).await;
        }

        tracing::info!(
            "Downloading Whisper model {} from {}",
            model_name,
            model_info.url
        );

        self.download_file_verified(
            &model_info.url,
            &destination,
            &model_info.sha256,
            model_info.max_bytes,
            progress_callback,
        )
        .await?;

        if !validate_whisper_artifact(&destination, min_expected_bytes).await {
            tokio::fs::remove_file(&destination).await.ok();
            return Err(anyhow::anyhow!(
                "Downloaded Whisper model '{}' is invalid or incomplete. Re-try download.",
                model_name
            ));
        }

        Ok(destination)
    }

    /// Download a model to a temporary file and install it only after its
    /// app-pinned SHA-256 digest has been verified.
    async fn download_file_verified(
        &self,
        url: &str,
        destination: &PathBuf,
        expected_sha256: &str,
        max_bytes: u64,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<()> {
        self.download_verified_model_asset(
            url,
            destination,
            expected_sha256,
            max_bytes,
            progress_callback,
        )
        .await
    }

    /// Download or migrate a model asset under an immutable URL and
    /// application-pinned SHA-256 digest.
    pub(crate) async fn download_verified_model_asset(
        &self,
        url: &str,
        destination: &PathBuf,
        expected_sha256: &str,
        max_bytes: u64,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<()> {
        if destination.exists() {
            if verify_or_record_model_integrity(destination, expected_sha256).await? {
                return Ok(());
            }
            remove_model_artifact(destination).await;
        }

        // Create parent directory if needed
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let temp_path = destination.with_extension("tmp");

        let client = &self.client;
        let mut request = client.get(url);

        let mut start_byte = if temp_path.exists() {
            let metadata = tokio::fs::metadata(&temp_path).await?;
            metadata.len()
        } else {
            0
        };
        if start_byte > max_bytes {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(url, max_bytes));
        }

        if start_byte > 0 {
            request = request.header("Range", format!("bytes={}-", start_byte));
        }

        let mut response = request.send().await?;

        // 416 means our tmp file is already at least as long as the remote
        // file (e.g. a completed download that crashed before the rename) or
        // otherwise unusable as a resume base. Discard it and start over,
        // instead of erroring on every retry forever.
        if start_byte > 0 && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            tracing::warn!(
                "Resume of {} rejected with 416; discarding partial file and restarting",
                url
            );
            tokio::fs::remove_file(&temp_path).await.ok();
            start_byte = 0;
            response = client.get(url).send().await?;
        }

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

        // Only a 206 Partial Content reply actually honored the Range header.
        // A server/proxy that ignores Range replies 200 with the entire body,
        // which must overwrite the partial tmp file -- appending it after the
        // existing bytes would silently corrupt the artifact.
        let resuming = start_byte > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if start_byte > 0 && !resuming {
            tracing::warn!(
                "Server ignored Range request for {} (HTTP {}); restarting download from scratch",
                url,
                response.status()
            );
            start_byte = 0;
        }

        let declared_remaining = response.content_length();
        if declared_remaining.is_some_and(|length| length > max_bytes - start_byte) {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(url, max_bytes));
        }
        let total_size = declared_remaining
            .map(|length| length + start_byte)
            .unwrap_or(0);
        if total_size > max_bytes {
            tokio::fs::remove_file(&temp_path).await.ok();
            return Err(download_size_limit_error(url, max_bytes));
        }

        // Preflight: refuse to stream a download the disk can't hold, so the
        // user gets a clear "need N free" error instead of a mid-download
        // ENOSPC after minutes of waiting. Fails open when the free-space
        // probe itself is unavailable.
        if total_size > start_byte {
            let remaining = total_size - start_byte;
            match available_space_for_path(&self.models_dir) {
                Ok(available) if available < remaining => {
                    return Err(anyhow::anyhow!(
                        "Not enough disk space to download {}: need {} free, only {} available.",
                        url,
                        format_bytes(remaining),
                        format_bytes(available)
                    ));
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        "Free-space preflight unavailable, continuing download: {}",
                        error
                    );
                }
            }
        }

        let mut file = if resuming {
            File::options().append(true).open(&temp_path).await?
        } else {
            // Truncates any stale partial content.
            File::create(&temp_path).await?
        };

        let mut stream = response.bytes_stream();
        let bytes_downloaded = Arc::new(AtomicU64::new(start_byte));
        let _start_time = std::time::Instant::now();
        let mut last_progress_bucket = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let current = match checked_download_size(
                bytes_downloaded.load(Ordering::SeqCst),
                chunk.len(),
                max_bytes,
                url,
            ) {
                Ok(current) => current,
                Err(error) => {
                    drop(file);
                    tokio::fs::remove_file(&temp_path).await.ok();
                    return Err(error);
                }
            };
            if let Err(error) = file.write_all(&chunk).await {
                // A full disk leaves a useless (and space-hogging) partial
                // file on an already-full volume; remove it before erroring.
                if error.raw_os_error() == Some(libc::ENOSPC) {
                    drop(file);
                    tokio::fs::remove_file(&temp_path).await.ok();
                    return Err(anyhow::anyhow!(
                        "The disk ran out of space while downloading {}. Free up space and retry.",
                        url
                    ));
                }
                return Err(error.into());
            }

            bytes_downloaded.store(current, Ordering::SeqCst);

            // Emit at most once per whole percentage point. A multi-gigabyte
            // model otherwise floods the IPC bridge and logs once per network
            // chunk, which can mean hundreds of thousands of updates.
            let current_bucket = progress_percent_bucket(current, total_size);
            if current_bucket.is_some() && current_bucket != last_progress_bucket {
                last_progress_bucket = current_bucket;
                progress_callback(DownloadProgress {
                    bytes_downloaded: current,
                    total_bytes: total_size,
                    percentage: (current as f64 / total_size as f64) * 100.0,
                    speed_mbps: 0.0, // simplified
                });
            }
        }

        file.flush().await?;
        drop(file);

        // Validate the finished file against the server-declared length
        // before renaming into place, so a truncated stream can never be
        // installed as a supposedly-complete artifact. The tmp file is kept
        // for the next attempt to resume from.
        if total_size > 0 {
            let final_len = tokio::fs::metadata(&temp_path).await?.len();
            if final_len != total_size {
                return Err(anyhow::anyhow!(
                    "Download of {} is incomplete: got {} bytes, expected {}. Re-try download.",
                    url,
                    final_len,
                    total_size
                ));
            }
        }

        // Skip integrity verification when no SHA256 is pinned. This allows
        // new models to be downloaded before their hashes have been verified
        // and pinned. The file is still checked for completeness above.
        if !expected_sha256.is_empty() {
            let actual_sha256 = calculate_sha256(&temp_path).await?;
            if actual_sha256 != expected_sha256 {
                tokio::fs::remove_file(&temp_path).await.ok();
                return Err(anyhow::anyhow!(
                    "Integrity verification failed for {}. Expected sha256 {}, got {}",
                    destination.display(),
                    expected_sha256,
                    actual_sha256
                ));
            }
            tracing::info!(
                "Integrity verified for {} with app-pinned sha256 {}",
                destination.display(),
                expected_sha256
            );
            tokio::fs::rename(&temp_path, destination).await?;
            write_model_integrity_receipt(destination, expected_sha256).await?;
        } else {
            tracing::warn!(
                "Model {} has no pinned SHA256 — skipping integrity verification",
                destination.display()
            );
            tokio::fs::rename(&temp_path, destination).await?;
        }

        tracing::info!("Downloaded {} to {:?}", url, destination);
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

        let model = diarization_model_info(model_id).ok_or_else(|| {
            anyhow::anyhow!(
                "Unknown diarization model: {}. Supported: ecapa_tdnn_speaker, resnet34_speaker, campplus_speaker, eres2netv2_speaker",
                model_id
            )
        })?;

        let destination = diarization_dir.join(model.file_name);

        if destination.exists() {
            if verify_or_record_model_integrity(&destination, model.sha256).await? {
                tracing::info!(
                    "Diarization model {} already exists at {:?}",
                    model_id,
                    destination
                );
                return Ok(destination);
            }
            tracing::warn!(
                "Existing diarization model {} failed integrity verification. Re-downloading.",
                model_id
            );
            remove_model_artifact(&destination).await;
        }

        tracing::info!(
            "Downloading diarization model {} from {}",
            model_id,
            model.url
        );

        self.download_file_verified(
            model.url,
            &destination,
            model.sha256,
            model.max_bytes,
            _progress_callback,
        )
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
    #[expect(
        dead_code,
        reason = "diarization settings can query this capability independently from downloads"
    )]
    pub fn is_diarization_model_downloaded(&self) -> bool {
        let path = self
            .models_dir
            .join("diarization")
            .join("ecapa_tdnn_speaker.onnx");
        is_diarization_model_artifact_trusted("ecapa_tdnn_speaker", &path)
    }

    /// Path Silero VAD's ONNX model is stored at once downloaded.
    pub fn silero_vad_model_path(&self) -> PathBuf {
        self.models_dir.join("vad").join(SILERO_VAD_ONNX_FILE)
    }

    /// Whether the Silero VAD ONNX model has already been downloaded.
    pub fn is_silero_vad_model_downloaded(&self) -> bool {
        is_model_artifact_trusted(&self.silero_vad_model_path(), SILERO_VAD_ONNX_SHA256)
    }

    /// Download the Silero VAD ONNX model (MIT-licensed, ~2.2MB), the small
    /// voice-activity-detection model from `snakers4/silero-vad` used as an
    /// accuracy-focused v2 backend alongside `StreamingVadGate`'s energy
    /// heuristic. Fetched from an immutable upstream Git commit and verified
    /// against an app-pinned digest.
    ///
    /// Wired to the `download_silero_vad_model` sidecar IPC command (see
    /// `lib.rs`), invoked from the Settings UI's VAD backend selector.
    pub async fn download_silero_vad_model(
        &self,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<PathBuf> {
        let destination = self.silero_vad_model_path();

        if destination.exists() {
            if verify_or_record_model_integrity(&destination, SILERO_VAD_ONNX_SHA256).await? {
                tracing::info!("Silero VAD model already exists at {:?}", destination);
                return Ok(destination);
            }
            tracing::warn!(
                "Existing Silero VAD model at {:?} failed integrity verification; re-downloading",
                destination
            );
            remove_model_artifact(&destination).await;
        }

        tracing::info!("Downloading Silero VAD model from {}", SILERO_VAD_ONNX_URL);
        self.download_file_verified(
            SILERO_VAD_ONNX_URL,
            &destination,
            SILERO_VAD_ONNX_SHA256,
            SILERO_VAD_MAX_BYTES,
            progress_callback,
        )
        .await?;

        let metadata = tokio::fs::metadata(&destination).await?;
        if metadata.len() < SILERO_VAD_MIN_EXPECTED_BYTES {
            tokio::fs::remove_file(&destination).await.ok();
            return Err(anyhow::anyhow!(
                "Downloaded Silero VAD model is too small ({} bytes). Download failed.",
                metadata.len()
            ));
        }

        tracing::info!(
            "Silero VAD model downloaded successfully to {:?}",
            destination
        );
        Ok(destination)
    }

    /// Get available space (bytes) on the volume holding the models directory.
    ///
    /// Returns an error on platforms without an implementation — callers must
    /// treat that as "unknown" and fail open, never assume space is available.
    pub async fn get_available_space(&self) -> Result<u64> {
        available_space_for_path(&self.models_dir)
    }

    /// List downloaded models
    pub async fn list_downloaded_models(&self) -> Result<Vec<DownloadedModel>> {
        let mut models = Vec::new();

        // Check Whisper models
        let whisper_dir = self.models_dir.join("whisper");
        if whisper_dir.exists() {
            let mut entries = tokio::fs::read_dir(&whisper_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
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

        // Check Parakeet models.
        //
        // The legacy 110M export sits directly in `models/parakeet`; TDT v3
        // gets a subdirectory beside it. Walking recursively is what makes the
        // v3 bundle visible here at all -- a flat `read_dir` would list the
        // legacy files and silently omit 639 MB the user cannot then see or
        // delete. The retired `parakeet_ctc_0.6b` / `parakeet_ctc_1.1b`
        // directories are gone with their providers.
        let parakeet_dir = self.models_dir.join("parakeet");
        if parakeet_dir.exists() {
            for entry in walkdir::WalkDir::new(&parakeet_dir)
                .into_iter()
                .filter_map(Result::ok)
            {
                if is_internal_model_metadata_file(entry.path()) {
                    continue;
                }
                let metadata = match entry.metadata() {
                    Ok(metadata) if metadata.is_file() => metadata,
                    _ => continue,
                };
                // `parakeet/tokens.txt` is the legacy export;
                // `parakeet/parakeet-tdt-0.6b-v3/tokens.txt` is v3. Label by
                // the subdirectory so the two are told apart.
                let label = entry
                    .path()
                    .parent()
                    .filter(|parent| *parent != parakeet_dir)
                    .and_then(|parent| parent.file_name())
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "legacy-110m".to_string());
                let name = entry.file_name().to_string_lossy().to_string();
                models.push(DownloadedModel {
                    name: format!("Parakeet {} {}", label, name),
                    provider: "parakeet".to_string(),
                    path: entry.path().to_path_buf(),
                    size_bytes: metadata.len(),
                    downloaded_at: metadata.modified()?,
                });
            }
        }

        // Check Whisper Candle bundle (keeps the legacy canary directory for migration stability)
        let whisper_candle_dir = self.models_dir.join("canary");
        if whisper_candle_dir.exists() {
            let mut entries = tokio::fs::read_dir(&whisper_candle_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Whisper Candle {}", name),
                        provider: "whisper_candle".to_string(),
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
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
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

        // Check Moonshine models
        for (dir_name, label) in [
            ("moonshine", "Moonshine Base"),
            ("moonshine_tiny", "Moonshine Tiny"),
        ] {
            let model_dir = self.models_dir.join(dir_name);
            if !model_dir.exists() {
                continue;
            }

            let mut entries = tokio::fs::read_dir(&model_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("{} {}", label, name),
                        provider: "moonshine".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check Silero VAD model
        let vad_dir = self.models_dir.join("vad");
        if vad_dir.exists() {
            let mut entries = tokio::fs::read_dir(&vad_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Silero VAD {}", name),
                        provider: "silero_vad".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check platform MLX assets
        let mlx_dir = self.models_dir.join("mlx");
        if mlx_dir.exists() {
            let mut entries = tokio::fs::read_dir(&mlx_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("MLX {}", name),
                        provider: "platform_mlx".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check platform Windows Foundry assets
        let foundry_dir = self.models_dir.join("windows_foundry");
        if foundry_dir.exists() {
            let mut entries = tokio::fs::read_dir(&foundry_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if is_internal_model_metadata_file(&entry.path()) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    models.push(DownloadedModel {
                        name: format!("Windows Foundry {}", name),
                        provider: "platform_windows_foundry".to_string(),
                        path: entry.path(),
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                }
            }
        }

        // Check Qwen3-ASR models
        let qwen3_dir = self.models_dir.join("qwen3_asr");
        if qwen3_dir.exists() {
            let mut entries = tokio::fs::read_dir(&qwen3_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_dir() {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let mut total_size = 0u64;
                    let mut has_files = false;
                    let mut downloaded_at = None;
                    if let Ok(mut model_entries) = tokio::fs::read_dir(&path).await {
                        while let Some(model_entry) = model_entries.next_entry().await? {
                            if let Ok(metadata) = model_entry.metadata().await {
                                if metadata.is_file() {
                                    total_size += metadata.len();
                                    has_files = true;
                                    if downloaded_at.is_none() {
                                        if let Ok(modified) = metadata.modified() {
                                            downloaded_at = Some(modified);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if has_files {
                        models.push(DownloadedModel {
                            name,
                            provider: "qwen3_asr".to_string(),
                            path,
                            size_bytes: total_size,
                            downloaded_at: downloaded_at.unwrap_or_else(std::time::SystemTime::now),
                        });
                    }
                }
            }
        }

        // Check punctuation models
        let punct_dir = self.models_dir.join("punctuation");
        if punct_dir.exists() {
            let onnx = punct_dir.join("punct_cap_seg_en.onnx");
            let tokenizer = punct_dir.join("spe_32k_lc_en.model");
            if onnx.is_file() && tokenizer.is_file() {
                let mut total_size = 0u64;
                if let Ok(meta) = tokio::fs::metadata(&onnx).await {
                    total_size += meta.len();
                }
                if let Ok(meta) = tokio::fs::metadata(&tokenizer).await {
                    total_size += meta.len();
                }
                models.push(DownloadedModel {
                    name: "punct_cap_seg_en".to_string(),
                    provider: "punctuation".to_string(),
                    path: punct_dir,
                    size_bytes: total_size,
                    downloaded_at: std::time::SystemTime::now(),
                });
            }
        }

        Ok(models)
    }

    pub async fn download_platform_assets(&self, engine: &str) -> Result<PathBuf> {
        match engine.trim() {
            "macos_mlx_sidecar" => self.download_mlx_assets().await,
            "windows_foundry_local" => self.download_windows_foundry_assets().await,
            _ => Err(anyhow::anyhow!(
                "Unsupported platform asset bundle '{}'. Supported: macos_mlx_sidecar, windows_foundry_local",
                engine
            )),
        }
    }

    async fn download_mlx_assets(&self) -> Result<PathBuf> {
        let mlx_dir = self.models_dir.join("mlx");
        tokio::fs::create_dir_all(&mlx_dir).await?;
        let manifest = mlx_dir.join("manifest.json");
        let payload = serde_json::json!({
            "engine": "macos_mlx_sidecar",
            "installedAt": chrono::Utc::now().to_rfc3339(),
            "note": "Stub MLX sidecar bundle marker. Replace with real sidecar assets in production packaging."
        });
        tokio::fs::write(&manifest, serde_json::to_vec_pretty(&payload)?).await?;
        Ok(manifest)
    }

    async fn download_windows_foundry_assets(&self) -> Result<PathBuf> {
        let foundry_dir = self.models_dir.join("windows_foundry");
        tokio::fs::create_dir_all(&foundry_dir).await?;
        let manifest = foundry_dir.join("manifest.json");
        let payload = serde_json::json!({
            "engine": "windows_foundry_local",
            "installedAt": chrono::Utc::now().to_rfc3339(),
            "note": "Foundry runtime marker. Complete Windows Foundry Local install separately; this marker enables readiness diagnostics."
        });
        tokio::fs::write(&manifest, serde_json::to_vec_pretty(&payload)?).await?;
        Ok(manifest)
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
        let receipt_path = model_integrity_receipt_path(&canonical);
        if let Err(error) = tokio::fs::remove_file(&receipt_path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error).with_context(|| {
                    format!(
                        "Deleted model but failed to remove its integrity receipt: {:?}",
                        receipt_path
                    )
                });
            }
        }
        tracing::info!("Deleted model at {:?}", canonical);
        Ok(())
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        match Self::new() {
            Ok(manager) => manager,
            Err(error) => {
                tracing::error!("Failed to create download manager in data dir: {}", error);
                let models_dir = std::env::temp_dir().join("Plainsong").join("models");
                if let Err(create_error) = std::fs::create_dir_all(&models_dir) {
                    tracing::error!(
                        "Failed to create fallback model directory {}: {}",
                        models_dir.display(),
                        create_error
                    );
                }
                let client = build_download_client().unwrap_or_else(|client_error| {
                    tracing::error!(
                        "Failed to build configured download client, using default client: {}",
                        client_error
                    );
                    reqwest::Client::new()
                });
                Self { client, models_dir }
            }
        }
    }
}

/// Free space (bytes) available to unprivileged callers on the volume
/// containing `path`, via `statvfs` (`f_bavail * f_frsize`).
#[cfg(unix)]
pub(crate) fn available_space_for_path(path: &std::path::Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .context("Models directory path contains an interior NUL byte")?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("statvfs failed for {}", path.display()));
    }
    // The statvfs field widths differ across unix platforms; keep both casts.
    #[allow(clippy::unnecessary_cast)]
    Ok((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(unix))]
pub(crate) fn available_space_for_path(path: &std::path::Path) -> Result<u64> {
    // No implementation on this platform. Return an honest error instead of
    // a fabricated value; callers fail open (skip the preflight check).
    Err(anyhow::anyhow!(
        "Free-space check is not implemented on this platform (path: {})",
        path.display()
    ))
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
    pub size_mb: f64,
    pub url: String,
    pub sha256: String,
    pub max_bytes: u64,
}

/// Get information about a Whisper model
fn get_whisper_model_info(model_name: &str) -> Option<WhisperModelInfo> {
    let whisper_url = |file_name: &str| {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/{}",
            WHISPER_MODEL_REVISION, file_name
        )
    };
    let models = vec![
        WhisperModelInfo {
            name: "tiny".to_string(),
            file_name: "ggml-tiny.bin".to_string(),
            size_mb: 75.0,
            url: whisper_url("ggml-tiny.bin"),
            sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21".to_string(),
            max_bytes: 100 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "tiny.en".to_string(),
            file_name: "ggml-tiny.en.bin".to_string(),
            size_mb: 75.0,
            url: whisper_url("ggml-tiny.en.bin"),
            sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f".to_string(),
            max_bytes: 100 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "base".to_string(),
            file_name: "ggml-base.bin".to_string(),
            size_mb: 142.0,
            url: whisper_url("ggml-base.bin"),
            sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe".to_string(),
            max_bytes: 200 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "base.en".to_string(),
            file_name: "ggml-base.en.bin".to_string(),
            size_mb: 142.0,
            url: whisper_url("ggml-base.en.bin"),
            sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002".to_string(),
            max_bytes: 200 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "small".to_string(),
            file_name: "ggml-small.bin".to_string(),
            size_mb: 466.0,
            url: whisper_url("ggml-small.bin"),
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b".to_string(),
            max_bytes: 650 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "small.en".to_string(),
            file_name: "ggml-small.en.bin".to_string(),
            size_mb: 466.0,
            url: whisper_url("ggml-small.en.bin"),
            sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d".to_string(),
            max_bytes: 650 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "medium".to_string(),
            file_name: "ggml-medium.bin".to_string(),
            size_mb: 1500.0,
            url: whisper_url("ggml-medium.bin"),
            sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208".to_string(),
            max_bytes: 2 * 1024 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "medium.en".to_string(),
            file_name: "ggml-medium.en.bin".to_string(),
            size_mb: 1500.0,
            url: whisper_url("ggml-medium.en.bin"),
            sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356".to_string(),
            max_bytes: 2 * 1024 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "large-v3".to_string(),
            file_name: "ggml-large-v3.bin".to_string(),
            size_mb: 2900.0,
            url: whisper_url("ggml-large-v3.bin"),
            sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2".to_string(),
            max_bytes: 4 * 1024 * 1024 * 1024,
        },
        WhisperModelInfo {
            name: "large-v3-turbo".to_string(),
            file_name: "ggml-large-v3-turbo.bin".to_string(),
            size_mb: 1620.0,
            url: whisper_url("ggml-large-v3-turbo.bin"),
            sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69".to_string(),
            max_bytes: 3 * 1024 * 1024 * 1024,
        },
    ];

    models.into_iter().find(|m| m.name == model_name)
}

/// Calculate SHA256 checksum of a file
async fn calculate_sha256(path: &PathBuf) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let bytes_read = file.read(&mut buffer).await?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    let result = hasher.finalize();

    Ok(hex::encode(result))
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
        assert_eq!(
            info.sha256,
            "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
        );
        assert_eq!(info.max_bytes, 200 * 1024 * 1024);
    }

    #[test]
    fn omitted_content_length_still_has_an_observed_streaming_ceiling() {
        assert_eq!(
            checked_download_size(4, 4, 8, "https://example.invalid/model").unwrap(),
            8
        );
        let error = checked_download_size(8, 1, 8, "https://example.invalid/model")
            .expect_err("observed bytes beyond the ceiling must fail");
        assert!(error.to_string().starts_with("SIDECAR_SIZE_LIMIT:"));
    }

    #[test]
    fn download_size_accounting_rejects_integer_overflow() {
        let error = checked_download_size(u64::MAX, 1, u64::MAX, "https://example.invalid/model")
            .expect_err("overflow must fail closed");
        assert!(error.to_string().starts_with("SIDECAR_SIZE_LIMIT:"));
    }

    #[test]
    fn download_progress_is_bucketed_to_avoid_per_chunk_event_floods() {
        assert_eq!(progress_percent_bucket(0, 0), None);
        assert_eq!(progress_percent_bucket(1, 1_000), Some(0));
        assert_eq!(progress_percent_bucket(9, 1_000), Some(0));
        assert_eq!(progress_percent_bucket(10, 1_000), Some(1));
        assert_eq!(progress_percent_bucket(1_000, 1_000), Some(100));
        assert_eq!(progress_percent_bucket(1_500, 1_000), Some(100));
    }

    #[test]
    fn runtime_model_sources_are_immutable_and_digest_pinned() {
        for model_id in [
            "tiny",
            "tiny.en",
            "base",
            "base.en",
            "small",
            "small.en",
            "medium",
            "medium.en",
            "large-v3",
            "large-v3-turbo",
        ] {
            let model = get_whisper_model_info(model_id).expect("known Whisper model");
            assert!(model.url.contains(WHISPER_MODEL_REVISION));
            assert!(!model.url.contains("/resolve/main/"));
            assert_eq!(model.sha256.len(), 64);
            assert!(model
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
        }

        for model_id in ["ecapa_tdnn_speaker", "resnet34_speaker", "campplus_speaker"] {
            let model = diarization_model_info(model_id).expect("known diarization model");
            assert!(!model.url.contains("/resolve/main/"));
            assert_eq!(model.sha256.len(), 64);
            assert!(model
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
        }

        // ERes2NetV2 has a pinned commit URL and verified SHA256.
        let eres2netv2 =
            diarization_model_info("eres2netv2_speaker").expect("known diarization model");
        assert!(!eres2netv2.url.contains("/resolve/main/"));
        assert_eq!(eres2netv2.sha256.len(), 64);
        assert!(eres2netv2
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit()));

        assert!(!SILERO_VAD_ONNX_URL.contains("/master/"));
        assert_eq!(SILERO_VAD_ONNX_SHA256.len(), 64);
        assert!(SILERO_VAD_ONNX_SHA256
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn integrity_receipt_trusts_only_the_unchanged_verified_artifact() {
        let test_dir = std::env::temp_dir()
            .join("plainsong-model-integrity")
            .join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir_all(&test_dir)
            .await
            .expect("create integrity test directory");
        let model_path = test_dir.join("model.onnx");
        tokio::fs::write(&model_path, b"trusted model bytes")
            .await
            .expect("write model");
        let digest = calculate_sha256(&model_path).await.expect("hash model");

        assert!(verify_or_record_model_integrity(&model_path, &digest)
            .await
            .expect("verify model"));
        assert!(is_model_artifact_trusted(&model_path, &digest));

        tokio::fs::write(&model_path, b"tampered model bytes with a different size")
            .await
            .expect("tamper model");
        assert!(!is_model_artifact_trusted(&model_path, &digest));
        assert!(!verify_or_record_model_integrity(&model_path, &digest)
            .await
            .expect("reject tampered model"));

        tokio::fs::remove_dir_all(&test_dir).await.ok();
    }

    #[tokio::test]
    async fn startup_integrity_migration_upgrades_exact_legacy_artifacts_only() {
        let test_dir = std::env::temp_dir()
            .join("plainsong-model-integrity-migration")
            .join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir_all(&test_dir)
            .await
            .expect("create migration test directory");

        let exact_path = test_dir.join("exact-model.bin");
        let altered_path = test_dir.join("altered-model.bin");
        tokio::fs::write(&exact_path, b"known pinned model bytes")
            .await
            .expect("write exact model");
        tokio::fs::write(&altered_path, b"unexpected model bytes")
            .await
            .expect("write altered model");
        let expected_digest = calculate_sha256(&exact_path)
            .await
            .expect("hash exact model");

        let report = migrate_legacy_model_integrity_receipts(&[
            (exact_path.clone(), expected_digest.clone()),
            (altered_path.clone(), expected_digest.clone()),
        ])
        .await;

        assert_eq!(report.migrated_count, 1);
        assert_eq!(report.rejected_paths, vec![altered_path.clone()]);
        assert!(report.errors.is_empty());
        assert!(is_model_artifact_trusted(&exact_path, &expected_digest));
        assert!(!is_model_artifact_trusted(&altered_path, &expected_digest));
        assert!(!model_integrity_receipt_path(&altered_path).exists());

        tokio::fs::remove_dir_all(&test_dir).await.ok();
    }

    #[cfg(unix)]
    #[test]
    fn test_available_space_for_path_reports_real_value() {
        // Regression: this used to be a stub hardcoded to 100 GB. A real
        // probe of the temp dir must succeed and report a nonzero value.
        let space =
            available_space_for_path(&std::env::temp_dir()).expect("statvfs should succeed");
        assert!(space > 0);
    }

    #[test]
    fn test_download_client_builds_without_total_timeout() {
        build_download_client().expect("download client should build");
    }

    /// Parakeet TDT v3 lives in a subdirectory of the legacy model dir, so a
    /// flat `read_dir` of `models/parakeet` would report the legacy files and
    /// silently omit the 639 MB v3 bundle -- leaving the user unable to see or
    /// delete the largest thing the app downloads.
    #[tokio::test]
    async fn downloaded_model_listing_includes_the_parakeet_v3_subdirectory() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let v3_dir = models_dir.join("parakeet").join("parakeet-tdt-0.6b-v3");
        std::fs::create_dir_all(&v3_dir).expect("create v3 dir");
        std::fs::write(models_dir.join("parakeet").join("tokens.txt"), b"legacy")
            .expect("write legacy tokens");
        std::fs::write(v3_dir.join("encoder.int8.onnx"), b"v3-encoder").expect("write v3 encoder");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        let names: Vec<&str> = listed.iter().map(|model| model.name.as_str()).collect();
        assert!(
            names
                .iter()
                .any(|name| name.contains("parakeet-tdt-0.6b-v3") && name.contains("encoder")),
            "v3 bundle should be listed, got {names:?}"
        );
        assert!(
            names
                .iter()
                .any(|name| name.contains("legacy-110m") && name.contains("tokens.txt")),
            "legacy export should still be listed, got {names:?}"
        );
        assert!(
            listed.iter().all(|model| model.provider == "parakeet"),
            "both routes report the parakeet provider"
        );

        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[tokio::test]
    async fn downloaded_model_listing_excludes_integrity_metadata() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-integrity-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let whisper_dir = models_dir.join("whisper");
        let parakeet_dir = models_dir.join("parakeet").join("parakeet-tdt-0.6b-v3");
        std::fs::create_dir_all(&whisper_dir).expect("create Whisper dir");
        std::fs::create_dir_all(&parakeet_dir).expect("create Parakeet dir");

        let whisper_model = whisper_dir.join("ggml-base.en.bin");
        let parakeet_model = parakeet_dir.join("encoder.int8.onnx");
        for path in [&whisper_model, &parakeet_model] {
            std::fs::write(path, b"model").expect("write model");
            std::fs::write(model_integrity_receipt_path(path), b"receipt").expect("write receipt");
            std::fs::write(
                path_with_suffix(&model_integrity_receipt_path(path), ".tmp-123"),
                b"temporary receipt",
            )
            .expect("write temporary receipt");
        }

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        assert_eq!(listed.len(), 2, "only model payloads should be listed");
        assert!(listed.iter().any(|model| model.path == whisper_model));
        assert!(listed.iter().any(|model| model.path == parakeet_model));
        assert!(listed
            .iter()
            .all(|model| !is_internal_model_metadata_file(&model.path)));

        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[tokio::test]
    async fn deleting_a_model_removes_its_integrity_receipt() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-delete")
            .join(uuid::Uuid::new_v4().to_string());
        let whisper_dir = models_dir.join("whisper");
        std::fs::create_dir_all(&whisper_dir).expect("create Whisper dir");
        let model_path = whisper_dir.join("ggml-base.en.bin");
        let receipt_path = model_integrity_receipt_path(&model_path);
        std::fs::write(&model_path, b"model").expect("write model");
        std::fs::write(&receipt_path, b"receipt").expect("write receipt");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        manager
            .delete_model(&model_path)
            .await
            .expect("deletion should succeed");

        assert!(!model_path.exists());
        assert!(!receipt_path.exists());

        std::fs::remove_dir_all(&models_dir).ok();
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
