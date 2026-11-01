//! Model download manager with progress tracking
//!
//! Handles downloading ASR models from HuggingFace and other sources
//! with resume support, checksum verification, and progress callbacks.

use anyhow::{Context, Result};
use futures_util::{Stream, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

const WHISPER_MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MAX_GENERIC_MODEL_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

const MAX_DOWNLOAD_ERROR_BODY_BYTES: usize = 4 * 1024;

async fn bounded_download_error_snippet<S, B, E>(body: S) -> String
where
    S: Stream<Item = std::result::Result<B, E>>,
    B: AsRef<[u8]>,
{
    futures_util::pin_mut!(body);
    let mut prefix = Vec::with_capacity(MAX_DOWNLOAD_ERROR_BODY_BYTES);
    while prefix.len() < MAX_DOWNLOAD_ERROR_BODY_BYTES {
        let Some(Ok(chunk)) = body.next().await else {
            break;
        };
        let bytes = chunk.as_ref();
        let remaining = MAX_DOWNLOAD_ERROR_BODY_BYTES - prefix.len();
        prefix.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    }
    // Dropping the stream discards the rest without draining an untrusted body.
    String::from_utf8_lossy(&prefix)
        .trim()
        .chars()
        .take(200)
        .collect()
}

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
pub(crate) const SILERO_VAD_ONNX_SHA256: &str =
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
        NEMOTRON_DIARIZATION_MODEL_ID => Some(DiarizationModelInfo {
            url: "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/nemotron3_diar_v3.onnx",
            file_name: "nemotron3_diar_v3.onnx",
            sha256: "915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a",
            max_bytes: 512 * 1024 * 1024,
        }),
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
        _ => None,
    }
}

pub(crate) const NEMOTRON_DIARIZATION_MODEL_ID: &str = "nemotron3_diarization";

/// Model id of the pyannote community-1 speaker model (Plainsong's Rust port,
/// `diarization::community1`).
pub(crate) const COMMUNITY1_MODEL_ID: &str = "pyannote_community1";

/// A failed community-1 download, said so a reader can act on it. A 404
/// means Plainsong's model release does not carry the file (yet), which is
/// not the user's network and not worth retrying today. The reader sees one
/// plain sentence (`to_string`); the file name and HTTP status stay in the
/// error chain (`{:#}`) and the log.
fn community1_download_error(file_name: &str, error: anyhow::Error) -> anyhow::Error {
    let detail = format!("{error:#}");
    tracing::warn!("Speaker model download failed ({file_name}): {detail}");
    let error = error.context(format!("speaker model file {file_name}"));
    if detail.contains("HTTP 404") {
        error.context("The speaker model isn't available to download yet.")
    } else {
        error.context("The speaker model download didn't finish. Try again.")
    }
}

/// Per-destination download locks, so two in-process downloads of the same
/// file never write the same `.tmp` at once. Entries are a few bytes per
/// model file this process ever fetched; they are not worth reclaiming.
type DownloadDestinationLocks =
    Mutex<std::collections::HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>;

fn download_destination_locks() -> &'static DownloadDestinationLocks {
    static LOCKS: OnceLock<DownloadDestinationLocks> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// Wait for, then hold, the download lock of `destination`.
async fn lock_download_destination(destination: &Path) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
        let mut locks = download_destination_locks()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Arc::clone(locks.entry(destination.to_path_buf()).or_default())
    };
    lock.lock_owned().await
}

/// Sub-directory of `models/diarization/` holding the community-1 bundle.
pub(crate) const COMMUNITY1_BUNDLE_DIR: &str = "pyannote-community-1";

#[derive(Clone, Copy)]
pub(crate) struct ModelBundleFile {
    pub(crate) url: &'static str,
    pub(crate) file_name: &'static str,
    pub(crate) sha256: &'static str,
    pub(crate) max_bytes: u64,
}

macro_rules! community1_file {
    ($name:literal, $sha:literal, $max:expr) => {
        ModelBundleFile {
            url: concat!(
                "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/",
                $name
            ),
            file_name: $name,
            sha256: $sha,
            max_bytes: $max,
        }
    };
}

/// The pyannote community-1 bundle (CC BY 4.0), served from Plainsong's
/// `models-2026-10` release because the ONNX graphs are Plainsong's own
/// exports: `scripts/pyannote-community1/export_onnx.py` turns
/// `pyannote-community/speaker-diarization-community-1` into these bytes
/// deterministically, from source revision 8a527374977391da736e0daaef26855d949d9685. The two `.npz` files are upstream's, byte for byte
/// (their SHA-256 equals the Hugging Face LFS ids at that revision). The
/// LICENSE and NOTICE travel with the weights, as CC BY requires.
pub(crate) const COMMUNITY1_BUNDLE: &[ModelBundleFile] = &[
    community1_file!(
        "pyannote-community-1-segmentation.onnx",
        "298eb9736b09b350733083d04cdaedb67bd68144d1727a9e278489112362c4dd",
        16 * 1024 * 1024
    ),
    community1_file!(
        "pyannote-community-1-embedding.onnx",
        "00b1cb7b3c5244cdc89eed0668efd1bd0699f7a371fa4eea1c63afe7e9a64c6d",
        64 * 1024 * 1024
    ),
    community1_file!(
        "pyannote-community-1-plda.npz",
        "9b77bcd840692710dd3496f62ecfeed8d8e5f002fd991b785079b244eab7d255",
        1024 * 1024
    ),
    community1_file!(
        "pyannote-community-1-xvec_transform.npz",
        "325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f",
        1024 * 1024
    ),
    community1_file!(
        "pyannote-community-1-LICENSE.txt",
        "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
        64 * 1024
    ),
    community1_file!(
        "pyannote-community-1-NOTICE.txt",
        "73c0019490cfdc57752cfbf217f4dee39330f6fa12a1f75625dc8fc852b7d49c",
        64 * 1024
    ),
];

/// Every file of the community-1 bundle is verified against its pin.
#[cfg(any(test, feature = "diarization"))]
pub(crate) fn is_community1_bundle_installed(bundle_dir: &Path) -> bool {
    is_bundle_installed(
        bundle_dir,
        COMMUNITY1_BUNDLE
            .iter()
            .map(|file| (file.file_name, file.sha256)),
    )
}

/// All-or-nothing readiness for a multi-file model bundle: every named file
/// must exist in `bundle_dir` and be recorded as verified against its
/// expected hash. Generic over the file list so the rule can be
/// tested with fixtures instead of the real multi-megabyte weights.
#[cfg(any(test, feature = "diarization"))]
fn is_bundle_installed<'a>(
    bundle_dir: &Path,
    files: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> bool {
    files.into_iter().all(|(file_name, sha256)| {
        is_model_artifact_installed(&bundle_dir.join(file_name), Some(sha256))
    })
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

/// The sibling receipt file older builds wrote beside each model. Nothing
/// trusts it any more; listings still hide it, and deleting or re-verifying a
/// model still removes it.
fn legacy_integrity_receipt_path(path: &Path) -> PathBuf {
    path_with_suffix(path, ".plainsong-integrity")
}

fn is_internal_model_metadata_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".plainsong-integrity") || name.contains(".plainsong-integrity.tmp")
        })
}

mod model_trust;

use model_trust::{assert_pinned_digest_is_never_empty, forget_verified_models_under};
pub(crate) use model_trust::{
    forget_verified_model, is_integrity_mismatch, is_model_artifact_changed,
    is_model_artifact_installed, is_model_artifact_verified, mismatch_first,
    open_model_artifact_to_hash, open_verified_model_artifact, preverify_models_in_background,
    read_verified_model_bytes, remove_legacy_verified_model_cache, verify_and_remember_model,
    verify_or_record_model_integrity, VerifiedModelArtifact,
};
#[cfg(test)]
pub(crate) use model_trust::{full_hash_count_for_tests, mark_model_verified_for_tests};
#[cfg(test)]
use model_trust::{
    is_model_artifact_installed_in, is_model_artifact_verified_in, open_verified_model_artifact_in,
    preverify_models_in, verify_or_record_model_integrity_in, ModelTrustSession,
    LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME,
};

#[cfg(feature = "asr-whisper")]
pub(crate) fn whisper_model_expected_sha256(model_id: &str) -> Option<String> {
    get_whisper_model_info(model_id).map(|model| model.sha256)
}

#[cfg(feature = "asr-whisper")]
pub(crate) fn is_whisper_model_artifact_installed(model_id: &str, path: &Path) -> bool {
    whisper_model_expected_sha256(model_id)
        .is_some_and(|sha256| is_model_artifact_installed(path, Some(&sha256)))
}

/// The Whisper route's one model file.
pub(crate) fn whisper_route_artifacts(
    models_root: &Path,
    model_id: &str,
) -> Vec<(PathBuf, String)> {
    get_whisper_model_info(model_id)
        .map(|model| {
            (
                models_root.join("whisper").join(model.file_name),
                model.sha256,
            )
        })
        .into_iter()
        .collect()
}

pub(crate) fn diarization_model_expected_sha256(model_id: &str) -> Option<&'static str> {
    diarization_model_info(model_id).map(|model| model.sha256)
}

pub(crate) fn is_diarization_model_artifact_installed(model_id: &str, path: &Path) -> bool {
    diarization_model_info(model_id)
        .is_some_and(|model| is_model_artifact_installed(path, Some(model.sha256)))
}

/// Startup verifies nothing; this is the full pinned set, for the export
/// inventory and the guard test that every entry carries a real digest.
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
        NEMOTRON_DIARIZATION_MODEL_ID,
    ] {
        if let Some(model) = diarization_model_info(model_id) {
            artifacts.push((
                models_root.join("diarization").join(model.file_name),
                model.sha256.to_string(),
            ));
        }
    }

    for file in COMMUNITY1_BUNDLE {
        artifacts.push((
            models_root
                .join("diarization")
                .join(COMMUNITY1_BUNDLE_DIR)
                .join(file.file_name),
            file.sha256.to_string(),
        ));
    }

    artifacts.push((
        models_root.join("vad").join(SILERO_VAD_ONNX_FILE),
        SILERO_VAD_ONNX_SHA256.to_string(),
    ));
    artifacts
}

async fn remove_model_artifact(path: &Path) {
    forget_verified_model(path);
    tokio::fs::remove_file(path).await.ok();
    tokio::fs::remove_file(legacy_integrity_receipt_path(path))
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
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
}

/// The partial file a download appends to before it is verified and renamed.
///
/// The whole file name plus `.tmp`, not `with_extension("tmp")`: that turned
/// both `model_quantized.onnx` and `model_quantized.onnx_data` into
/// `model_quantized.tmp`, so one file's resume could start from the other's
/// bytes.
pub(crate) fn download_temp_path(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    name.push(".tmp");
    destination.with_file_name(name)
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
        let temp_path = download_temp_path(destination);

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
            let snippet = bounded_download_error_snippet(response.bytes_stream()).await;
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

        // An existing file is hashed once and recorded as verified. Future
        // launches compare its file identity instead of re-reading
        // multi-gigabyte models.
        if destination.exists() {
            if validate_whisper_artifact(&destination, min_expected_bytes).await
                && verify_or_record_model_integrity(&destination, Some(&model_info.sha256)).await?
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
            Some(&model_info.sha256),
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
    /// app-pinned SHA-256 digest has been verified. `None` means "not yet
    /// pinned"; see `verify_or_record_model_integrity`.
    async fn download_file_verified(
        &self,
        url: &str,
        destination: &PathBuf,
        expected_sha256: Option<&str>,
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
    /// application-pinned SHA-256 digest. `None` means "not yet pinned"; see
    /// `verify_or_record_model_integrity`.
    pub(crate) async fn download_verified_model_asset(
        &self,
        url: &str,
        destination: &PathBuf,
        expected_sha256: Option<&str>,
        max_bytes: u64,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + 'static,
    ) -> Result<()> {
        assert_pinned_digest_is_never_empty(expected_sha256);
        // One download per destination at a time in this process. A second
        // caller (a Settings click while the meeting's own Download button is
        // still fetching the same file) waits here, then finds the verified
        // file below and returns without touching the network or the shared
        // `.tmp` the first one was appending to.
        let _destination_guard = lock_download_destination(destination).await;
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

        let temp_path = download_temp_path(destination);

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
            let snippet = bounded_download_error_snippet(response.bytes_stream()).await;
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

        // Skip integrity verification when no SHA256 is pinned (expected_sha256
        // is None). This allows new models to be downloaded before their
        // hashes have been verified and pinned. The file is still checked for
        // completeness above. `Some("")` is a programmer error, not a
        // legitimate "unpinned" state -- see `assert_pinned_digest_is_never_empty`.
        if let Some(expected_sha256) = expected_sha256 {
            if expected_sha256.is_empty() {
                tokio::fs::remove_file(&temp_path).await.ok();
                anyhow::bail!(
                    "Refusing to install {}: expected_sha256 was an empty string, not None. \
                     This is a bug in the artifact table, not a legitimate \"unpinned\" model.",
                    destination.display()
                );
            }
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
            // The freshly-downloaded file already passed the real hash
            // comparison above -- it IS correct. Recording it binds the hash
            // to the identity of the installed file; failing to (the file was
            // replaced after the rename) must not fail an otherwise-successful
            // multi-gigabyte download, it only leaves the file unverified.
            if let Err(error) = verify_and_remember_model(destination, expected_sha256).await {
                tracing::warn!(
                    "Downloaded and verified {} but could not record it as verified \
                     ({error}); it will be hashed again before use.",
                    destination.display()
                );
            }
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
        if model_id == crate::diarization::LICENSE_BLOCKED_SPEAKER_MODEL_ID {
            anyhow::bail!(
                "ERes2NetV2 is turned off while its license is unresolved. Choose another speaker model."
            );
        }
        // Like the picker and the run path: a build that cannot run
        // community-1 does not download it either.
        #[cfg(not(feature = "diarization"))]
        if model_id == COMMUNITY1_MODEL_ID {
            anyhow::bail!("pyannote community-1 is not compiled into this build.");
        }
        #[cfg(feature = "diarization")]
        if model_id == COMMUNITY1_MODEL_ID {
            let progress = std::sync::Arc::new(_progress_callback);
            return self
                .download_community1_bundle(move |update| progress(update))
                .await;
        }
        #[cfg(not(feature = "diarization-nemotron"))]
        if model_id == NEMOTRON_DIARIZATION_MODEL_ID {
            anyhow::bail!("Nemotron diarization is not compiled into this build.");
        }
        let diarization_dir = self.models_dir.join("diarization");
        tokio::fs::create_dir_all(&diarization_dir).await?;

        let model = diarization_model_info(model_id).ok_or_else(|| {
            anyhow::anyhow!(
                "Unknown diarization model: {}. Supported: ecapa_tdnn_speaker, resnet34_speaker, campplus_speaker, nemotron3_diarization, pyannote_community1",
                model_id
            )
        })?;

        let destination = diarization_dir.join(model.file_name);

        if destination.exists() {
            if verify_or_record_model_integrity(&destination, Some(model.sha256)).await? {
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
            Some(model.sha256),
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

    /// Verify an installed diarization model in this process without ever
    /// downloading it: a missing or untrusted file is an error. For the
    /// headless evaluation binary, which must not reach the network.
    pub(crate) async fn verify_installed_diarization_model(
        &self,
        model_id: &str,
    ) -> Result<PathBuf> {
        if model_id == COMMUNITY1_MODEL_ID {
            return self.verify_installed_community1_bundle().await;
        }
        let model = diarization_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown diarization model: {model_id}"))?;
        let destination = self.models_dir.join("diarization").join(model.file_name);
        if !destination.exists() {
            anyhow::bail!(
                "Diarization model {model_id} is not installed at {}",
                destination.display()
            );
        }
        if !verify_or_record_model_integrity(&destination, Some(model.sha256)).await? {
            anyhow::bail!(
                "Diarization model {model_id} at {} failed integrity verification",
                destination.display()
            );
        }
        Ok(destination)
    }

    /// Directory the pyannote community-1 bundle lives in.
    pub fn community1_bundle_dir(&self) -> PathBuf {
        self.models_dir
            .join("diarization")
            .join(COMMUNITY1_BUNDLE_DIR)
    }

    /// Download every file of the community-1 bundle, each pinned by SHA-256
    /// and size-bounded like the single-file diarization models. Files already
    /// present that match their pins are left alone, so a retry after
    /// a dropped connection only fetches what is missing.
    #[cfg_attr(
        not(feature = "diarization"),
        expect(
            dead_code,
            reason = "only a build that can run community-1 downloads it"
        )
    )]
    pub async fn download_community1_bundle(
        &self,
        progress_callback: impl Fn(DownloadProgress) + Send + Sync + Clone + 'static,
    ) -> Result<PathBuf> {
        let bundle_dir = self.community1_bundle_dir();
        tokio::fs::create_dir_all(&bundle_dir).await?;

        for file in COMMUNITY1_BUNDLE {
            let destination = bundle_dir.join(file.file_name);
            if destination.exists()
                && verify_or_record_model_integrity(&destination, Some(file.sha256)).await?
            {
                continue;
            }
            if destination.exists() {
                tracing::warn!(
                    "pyannote community-1 file {} failed integrity verification. Re-downloading.",
                    file.file_name
                );
                remove_model_artifact(&destination).await;
            }

            self.download_file_verified(
                file.url,
                &destination,
                Some(file.sha256),
                file.max_bytes,
                progress_callback.clone(),
            )
            .await
            .map_err(|error| community1_download_error(file.file_name, error))?;
        }

        tracing::info!("pyannote community-1 bundle ready at {:?}", bundle_dir);
        Ok(bundle_dir)
    }

    /// Verify an installed community-1 bundle without downloading anything.
    /// For the headless evaluation binary, which must not reach the network.
    pub(crate) async fn verify_installed_community1_bundle(&self) -> Result<PathBuf> {
        let bundle_dir = self.community1_bundle_dir();
        for file in COMMUNITY1_BUNDLE {
            let destination = bundle_dir.join(file.file_name);
            if !destination.exists()
                || !verify_or_record_model_integrity(&destination, Some(file.sha256)).await?
            {
                anyhow::bail!(
                    "pyannote community-1 file {} is missing or failed integrity verification",
                    destination.display()
                );
            }
        }
        Ok(bundle_dir)
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
        is_diarization_model_artifact_installed("ecapa_tdnn_speaker", &path)
    }

    /// Path Silero VAD's ONNX model is stored at once downloaded.
    pub fn silero_vad_model_path(&self) -> PathBuf {
        self.models_dir.join("vad").join(SILERO_VAD_ONNX_FILE)
    }

    /// Whether the Silero VAD ONNX model has already been downloaded.
    pub fn is_silero_vad_model_downloaded(&self) -> bool {
        is_model_artifact_installed(&self.silero_vad_model_path(), Some(SILERO_VAD_ONNX_SHA256))
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
            if verify_or_record_model_integrity(&destination, Some(SILERO_VAD_ONNX_SHA256)).await? {
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
            Some(SILERO_VAD_ONNX_SHA256),
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

        // Keep both Whistle assets visible to readiness and storage.
        let whistle_dir = crate::asr::whistle::model_dir(&self.models_dir);
        for name in [
            crate::asr::whistle::MODEL_FILE,
            crate::asr::whistle::CLI_FILE,
        ] {
            let path = whistle_dir.join(name);
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                if metadata.is_file() {
                    models.push(DownloadedModel {
                        name: format!("Whistle 2.0 {name}"),
                        provider: "whistle".to_string(),
                        path,
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

        // Check diarization models. Without this branch the four speaker
        // embedders and any model bundle on disk were invisible in the models
        // list and missing from the storage total, so a user could neither see
        // them nor delete them -- the app downloaded files it then refused to
        // account for. Named with the picker's own labels so a row can be
        // matched to the entry that fetched it.
        let diarization_dir = self.models_dir.join("diarization");
        if diarization_dir.exists() {
            let mut entries = tokio::fs::read_dir(&diarization_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if is_internal_model_metadata_file(&path) {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if metadata.is_file() {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let nemotron = file_name == "nemotron3_diar_v3.onnx";
                    let model_id = if nemotron {
                        NEMOTRON_DIARIZATION_MODEL_ID
                    } else {
                        file_name.strip_suffix(".onnx").unwrap_or(&file_name)
                    };
                    models.push(DownloadedModel {
                        name: format!(
                            "{} {}",
                            if nemotron {
                                "Speaker labels"
                            } else {
                                "Speaker embedding"
                            },
                            crate::diarization::model_label(model_id)
                        ),
                        provider: "diarization".to_string(),
                        path,
                        size_bytes: metadata.len(),
                        downloaded_at: metadata.modified()?,
                    });
                    continue;
                }
                if !metadata.is_dir() {
                    continue;
                }

                // A bundle is one model in several files (community-1 has six),
                // so it is summed into a single deletable entry the way the
                // Qwen3-ASR and cleanup bundles are.
                let dir_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                let mut total_size = 0u64;
                let mut files = 0usize;
                let mut modified: Option<std::time::SystemTime> = None;
                let mut bundle_entries = tokio::fs::read_dir(&path).await?;
                while let Some(bundle_entry) = bundle_entries.next_entry().await? {
                    let bundle_path = bundle_entry.path();
                    if is_internal_model_metadata_file(&bundle_path) {
                        continue;
                    }
                    if let Ok(metadata) = bundle_entry.metadata().await {
                        if !metadata.is_file() {
                            continue;
                        }
                        total_size += metadata.len();
                        files += 1;
                        if let Ok(entry_modified) = metadata.modified() {
                            modified = Some(match modified {
                                Some(existing) if existing >= entry_modified => existing,
                                _ => entry_modified,
                            });
                        }
                    }
                }
                if files == 0 {
                    continue;
                }
                let name = if dir_name == COMMUNITY1_BUNDLE_DIR {
                    format!(
                        "Speaker labels {}",
                        crate::diarization::model_label(COMMUNITY1_MODEL_ID)
                    )
                } else {
                    format!("Speaker diarization {dir_name}")
                };
                models.push(DownloadedModel {
                    name,
                    provider: "diarization".to_string(),
                    path,
                    size_bytes: total_size,
                    downloaded_at: modified.unwrap_or_else(std::time::SystemTime::now),
                });
            }
        }

        // The macOS MLX sidecar's stub asset listing has been removed along
        // with the retired engine (see `PlatformEngine::MacosMlxSidecar` and
        // `mlx_sidecar::probe`). Any leftover `models/mlx/manifest.json` from
        // a prior install is inert and simply no longer enumerated here.

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

        // Check Qwen3-ASR models. The shipped bundle is seven flat files
        // directly under `models/qwen3_asr` (see asr/qwen3_asr.rs), so they
        // are summed into one entry; a subdirectory is listed as its own
        // bundle in case a later export moves to per-model directories.
        let qwen3_dir = self.models_dir.join("qwen3_asr");
        if qwen3_dir.exists() {
            let mut flat_size = 0u64;
            let mut flat_files = 0usize;
            let mut flat_modified: Option<std::time::SystemTime> = None;
            let mut entries = tokio::fs::read_dir(&qwen3_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_file() {
                    if is_internal_model_metadata_file(&path) {
                        continue;
                    }
                    if let Ok(metadata) = entry.metadata().await {
                        flat_size += metadata.len();
                        flat_files += 1;
                        if let Ok(modified) = metadata.modified() {
                            flat_modified = Some(match flat_modified {
                                Some(existing) if existing >= modified => existing,
                                _ => modified,
                            });
                        }
                    }
                    continue;
                }
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
            if flat_files > 0 {
                models.push(DownloadedModel {
                    name: "qwen3-asr-0.6b".to_string(),
                    provider: "qwen3_asr".to_string(),
                    path: qwen3_dir.clone(),
                    size_bytes: flat_size,
                    downloaded_at: flat_modified.unwrap_or_else(std::time::SystemTime::now),
                });
            }
        }

        // Check the local Cohere Transcribe bundle: eight flat files under
        // `models/cohere_local` (see asr/cohere_local.rs), summed into one
        // entry. At 2.0 GiB it is the largest thing this app downloads, so a
        // user looking for disk to reclaim has to be able to see it.
        let cohere_local_dir = self
            .models_dir
            .join(crate::asr::cohere_local::COHERE_LOCAL_MODEL_DIR);
        if cohere_local_dir.exists() {
            let mut total_size = 0u64;
            let mut files = 0usize;
            let mut modified: Option<std::time::SystemTime> = None;
            let mut entries = tokio::fs::read_dir(&cohere_local_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if !path.is_file() || is_internal_model_metadata_file(&path) {
                    continue;
                }
                if let Ok(metadata) = entry.metadata().await {
                    total_size += metadata.len();
                    files += 1;
                    if let Ok(entry_modified) = metadata.modified() {
                        modified = Some(match modified {
                            Some(existing) if existing >= entry_modified => existing,
                            _ => entry_modified,
                        });
                    }
                }
            }
            if files > 0 {
                models.push(DownloadedModel {
                    name: crate::asr::cohere_local::COHERE_LOCAL_MODEL_ID.to_string(),
                    provider: "cohere_local".to_string(),
                    path: cohere_local_dir.clone(),
                    size_bytes: total_size,
                    downloaded_at: modified.unwrap_or_else(std::time::SystemTime::now),
                });
            }
        }

        // Check the bundled dictation-cleanup model. Four flat files directly
        // under `models/bundled_cleanup` (see llm/bundled_local.rs), summed
        // into one entry like the Qwen3-ASR bundle above.
        //
        // Without this branch the largest single thing the app downloads --
        // 473 MiB -- was invisible in the models list and missing from the
        // storage total, so a user looking for what to delete could neither
        // see it nor account for the disk it had used.
        let bundled_cleanup_dir = self
            .models_dir
            .join(crate::llm::bundled_local::MODEL_DIR_NAME);
        if bundled_cleanup_dir.exists() {
            let mut total_size = 0u64;
            let mut files = 0usize;
            let mut modified: Option<std::time::SystemTime> = None;
            let mut entries = tokio::fs::read_dir(&bundled_cleanup_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if !path.is_file() || is_internal_model_metadata_file(&path) {
                    continue;
                }
                if let Ok(metadata) = entry.metadata().await {
                    total_size += metadata.len();
                    files += 1;
                    if let Ok(entry_modified) = metadata.modified() {
                        modified = Some(match modified {
                            Some(existing) if existing >= entry_modified => existing,
                            _ => entry_modified,
                        });
                    }
                }
            }
            if files > 0 {
                models.push(DownloadedModel {
                    // The license requires this exact name wherever the model
                    // is named: "S1-mini" by "Superwhisper".
                    name: format!(
                        "{} by {}",
                        crate::llm::bundled_local::MODEL_DISPLAY_NAME,
                        crate::llm::bundled_local::MODEL_VENDOR
                    ),
                    provider: crate::llm::bundled_local::PROVIDER_SETTINGS_VALUE.to_string(),
                    path: bundled_cleanup_dir.clone(),
                    size_bytes: total_size,
                    downloaded_at: modified.unwrap_or_else(std::time::SystemTime::now),
                });
            }
        }

        // Check transcribe.cpp models. Flat, like the Qwen3 bundle, but every
        // model is one self-contained GGUF, so each file is its own entry
        // rather than a summed bundle -- `delete_model` removes a file, so a
        // directory-shaped entry would be listed and then refuse to delete.
        //
        // Deliberately NOT behind `#[cfg(feature = "asr-transcribe-cpp")]`: the
        // directory is left on disk by any build that ever ran the spike, and a
        // release build that cannot list it is a release build in which 1.42 GiB
        // of weights are invisible and undeletable from the model manager.
        let transcribe_cpp_dir = self.models_dir.join("transcribe_cpp");
        if transcribe_cpp_dir.exists() {
            let mut entries = tokio::fs::read_dir(&transcribe_cpp_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if !path.is_file() || is_internal_model_metadata_file(&path) {
                    continue;
                }
                let Ok(metadata) = entry.metadata().await else {
                    continue;
                };
                models.push(DownloadedModel {
                    name: entry.file_name().to_string_lossy().to_string(),
                    provider: "transcribe_cpp".to_string(),
                    path,
                    size_bytes: metadata.len(),
                    downloaded_at: metadata
                        .modified()
                        .unwrap_or_else(|_| std::time::SystemTime::now()),
                });
            }
        }

        // The Core ML builds of Parakeet: on a Mac that runs them they are
        // the whole Parakeet download, so they must be listed, counted and
        // removable. One summed entry per model directory; the name is the
        // model id only once every pinned file is here, so an interrupted
        // download does not read as an installed model.
        let neural_engine_dir = self.models_dir.join("neural_engine");
        if neural_engine_dir.exists() {
            let mut entries = tokio::fs::read_dir(&neural_engine_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let model_id = entry.file_name().to_string_lossy().to_string();
                let (size_bytes, modified) = bundle_size_and_modified(&dir);
                if size_bytes == 0 {
                    continue;
                }
                let name = if neural_engine_bundle_installed(&self.models_dir, &model_id) {
                    model_id
                } else {
                    format!("{model_id} (incomplete)")
                };
                models.push(DownloadedModel {
                    name,
                    provider: "transcribe_cpp".to_string(),
                    path: dir,
                    size_bytes,
                    downloaded_at: modified.unwrap_or_else(std::time::SystemTime::now),
                });
            }
        }

        Ok(models)
    }

    pub async fn download_platform_assets(&self, engine: &str) -> Result<PathBuf> {
        match engine.trim() {
            // macos_mlx_sidecar used to write a stub manifest marker here with
            // no real sidecar assets behind it, so "downloading" it just made
            // a broken engine look installed. The engine has been retired.
            "windows_foundry_local" => self.download_windows_foundry_assets().await,
            _ => Err(anyhow::anyhow!(
                "Unsupported platform asset bundle '{}'. Supported: windows_foundry_local",
                engine
            )),
        }
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
        if canonical == models_canonical {
            return Err(anyhow::anyhow!(
                "Refusing to delete the models directory itself: {:?}",
                path
            ));
        }

        // Several listed models are bundles: a directory of files
        // (community-1, Qwen3-ASR, the cleanup model). The listing hands back
        // the directory as the deletable path, so deleting one has to remove
        // the directory rather than fail on `remove_file`.
        if canonical.is_dir() {
            forget_verified_models_under(&canonical);
            tokio::fs::remove_dir_all(&canonical).await?;
            tracing::info!("Deleted model bundle at {:?}", canonical);
            return Ok(());
        }

        forget_verified_model(&canonical);
        tokio::fs::remove_file(&canonical).await?;
        let receipt_path = legacy_integrity_receipt_path(&canonical);
        if let Err(error) = tokio::fs::remove_file(&receipt_path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error).with_context(|| {
                    format!(
                        "Deleted model but failed to remove the receipt an older build left: {:?}",
                        receipt_path
                    )
                });
            }
        }
        tracing::info!("Deleted model at {:?}", canonical);
        Ok(())
    }
}

/// Every regular file under `dir`, summed, and the newest modification time.
/// Plainsong's own metadata files are not model bytes.
fn bundle_size_and_modified(dir: &Path) -> (u64, Option<std::time::SystemTime>) {
    let mut total = 0u64;
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        if is_internal_model_metadata_file(entry.path()) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        total += metadata.len();
        if let Ok(modified) = metadata.modified() {
            newest = Some(newest.map_or(modified, |current| current.max(modified)));
        }
    }
    (total, newest)
}

#[cfg(feature = "asr-transcribe-cpp")]
fn neural_engine_bundle_installed(models_dir: &Path, model_id: &str) -> bool {
    crate::asr::neural_engine::bundle_installed(models_dir, model_id)
}

/// A build without the runtime cannot use the bundles, but still lists them
/// so their bytes stay visible and removable.
#[cfg(not(feature = "asr-transcribe-cpp"))]
fn neural_engine_bundle_installed(_models_dir: &Path, _model_id: &str) -> bool {
    false
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
                let client = build_download_client()
                    .expect("Could not build HTTPS-only model download client");
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
async fn calculate_sha256(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path)?;
        model_trust::hash_open_file(&file, &path, |_| {}).map(|(digest, _)| digest)
    })
    .await
    .map_err(|error| anyhow::anyhow!("Hashing stopped: {error}"))?
}

/// Verify an existing model for this process only, writing nothing beside
/// it. Ignored diagnostics use it to reuse the user's pinned model bytes
/// while keeping the source directory strictly read-only.
#[cfg(test)]
pub(crate) async fn verify_existing_model_in_process(
    path: &Path,
    expected_sha256: &str,
) -> Result<bool> {
    if expected_sha256.is_empty() {
        anyhow::bail!("expected_sha256 is empty; refusing to trust an unpinned model artifact");
    }
    verify_or_record_model_integrity(path, Some(expected_sha256)).await
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

    #[tokio::test]
    async fn download_client_refuses_plaintext_http_before_connecting() {
        let error = build_download_client()
            .expect("download client")
            .get("http://127.0.0.1:9/model.bin")
            .send()
            .await
            .expect_err("model transfers must require HTTPS, including redirect targets");
        assert!(
            error.is_builder(),
            "plaintext URL reached the transport: {error}"
        );
    }

    #[test]
    fn sibling_files_never_share_a_partial_download() {
        let dir = Path::new("/models/embeddinggemma");
        let model = download_temp_path(&dir.join("model_quantized.onnx"));
        let data = download_temp_path(&dir.join("model_quantized.onnx_data"));
        assert_ne!(model, data);
        assert_eq!(model, dir.join("model_quantized.onnx.tmp"));
        assert_eq!(data, dir.join("model_quantized.onnx_data.tmp"));
    }

    #[cfg(not(feature = "diarization-nemotron"))]
    #[tokio::test]
    async fn feature_off_refuses_nemotron_download_before_creating_files() {
        let dir = crate::test_fs::TempDir::new("nemotron-feature-off");
        let manager = DownloadManager {
            models_dir: dir.path().join("models"),
            client: build_download_client().expect("client"),
        };
        let error = manager
            .download_diarization_model_by_id(NEMOTRON_DIARIZATION_MODEL_ID, |_| {})
            .await
            .expect_err("runtime unavailable");
        assert!(error.to_string().contains("not compiled"));
        assert!(!manager.models_dir.exists());
    }

    /// Two downloads of the same file in one process: the second waits for
    /// the first, then finds the verified file and returns without reaching
    /// the network (its URL here goes nowhere) or the first one's `.tmp`.
    #[tokio::test]
    async fn a_second_download_of_the_same_file_waits_and_reuses_the_first() {
        let dir = crate::test_fs::TempDir::new("download-lock");
        let manager = std::sync::Arc::new(DownloadManager {
            models_dir: dir.path().join("models"),
            client: build_download_client().expect("client"),
        });
        let destination = dir.path().join("models").join("speaker.onnx");
        tokio::fs::create_dir_all(destination.parent().unwrap())
            .await
            .unwrap();
        let bytes = b"verified speaker model bytes";
        let scratch = dir.path().join("scratch.onnx");
        tokio::fs::write(&scratch, bytes).await.unwrap();
        let digest = calculate_sha256(&scratch).await.expect("hash");

        // The "first download" holds the lock while it writes the file.
        let first = lock_download_destination(&destination).await;
        let second = {
            let manager = std::sync::Arc::clone(&manager);
            let destination = destination.clone();
            let digest = digest.clone();
            tokio::spawn(async move {
                manager
                    .download_verified_model_asset(
                        "http://127.0.0.1:9/never-reached.onnx",
                        &destination,
                        Some(&digest),
                        1024,
                        |_| {},
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(
            !second.is_finished(),
            "the second caller waits for the first"
        );
        tokio::fs::write(&destination, bytes).await.unwrap();
        drop(first);

        second
            .await
            .expect("join")
            .expect("the second caller reuses the verified file");
        assert!(!download_temp_path(&destination).exists());
    }

    #[tokio::test]
    async fn download_locks_are_per_destination() {
        let a = lock_download_destination(Path::new("/nonexistent/plainsong-a.onnx")).await;
        // A different file does not wait behind `a`.
        let b = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            lock_download_destination(Path::new("/nonexistent/plainsong-b.onnx")),
        )
        .await
        .expect("another destination is not blocked");
        drop((a, b));
    }

    #[tokio::test]
    async fn license_blocked_speaker_download_leaves_existing_files_untouched() {
        let root = std::env::temp_dir().join(format!(
            "plainsong-blocked-speaker-{}",
            uuid::Uuid::new_v4()
        ));
        let model_path = root.join("diarization/eres2netv2_speaker.onnx");
        tokio::fs::create_dir_all(model_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&model_path, b"existing model")
            .await
            .unwrap();
        let manager = DownloadManager {
            client: build_download_client().unwrap(),
            models_dir: root.clone(),
        };
        let error = manager
            .download_diarization_model_by_id("eres2netv2_speaker", |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "ERes2NetV2 is turned off while its license is unresolved. Choose another speaker model."
        );
        assert!(diarization_model_info("eres2netv2_speaker").is_none());
        assert_eq!(
            tokio::fs::read(&model_path).await.unwrap(),
            b"existing model"
        );
        let listed = manager.list_downloaded_models().await.unwrap();
        assert!(listed
            .iter()
            .any(|model| model.path == model_path && model.name.contains("ERes2NetV2")));
        manager.delete_model(&model_path).await.unwrap();
        assert!(!model_path.exists());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn a_missing_community1_file_reads_as_not_published_yet() {
        let error = community1_download_error(
            "pyannote-community-1-embedding.onnx",
            anyhow::anyhow!("Download failed: HTTP 404 Not Found"),
        );
        assert_eq!(
            error.to_string(),
            "The speaker model isn't available to download yet."
        );
        // The file and the status stay in the details.
        let details = format!("{error:#}");
        assert!(details.contains("pyannote-community-1-embedding.onnx"));
        assert!(details.contains("HTTP 404"));
        let other = community1_download_error(
            "pyannote-community-1-embedding.onnx",
            anyhow::anyhow!("connection reset"),
        );
        assert_eq!(
            other.to_string(),
            "The speaker model download didn't finish. Try again."
        );
        assert!(format!("{other:#}").contains("connection reset"));
    }

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

        assert!(!SILERO_VAD_ONNX_URL.contains("/master/"));
        assert_eq!(SILERO_VAD_ONNX_SHA256.len(), 64);
        assert!(SILERO_VAD_ONNX_SHA256
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn community1_bundle_is_pinned_to_plainsongs_release_by_hash_and_size() {
        // The pipeline needs both networks, both PLDA archives, and CC BY 4.0
        // needs the license and notice to travel with them.
        assert_eq!(COMMUNITY1_BUNDLE.len(), 6);
        let mut names: Vec<&str> = COMMUNITY1_BUNDLE.iter().map(|f| f.file_name).collect();
        names.sort_unstable();
        let mut unique = names.clone();
        unique.dedup();
        assert_eq!(names, unique, "bundle file names must be unique");
        for needed in [
            "pyannote-community-1-segmentation.onnx",
            "pyannote-community-1-embedding.onnx",
            "pyannote-community-1-plda.npz",
            "pyannote-community-1-xvec_transform.npz",
            "pyannote-community-1-LICENSE.txt",
            "pyannote-community-1-NOTICE.txt",
        ] {
            assert!(names.contains(&needed), "{needed}");
        }
        for file in COMMUNITY1_BUNDLE {
            assert_eq!(
                file.url,
                format!(
                    "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/{}",
                    file.file_name
                )
            );
            assert_eq!(file.sha256.len(), 64, "{}", file.file_name);
            assert!(file.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(file.max_bytes > 0, "{}", file.file_name);
        }
        // The upstream PLDA archives are re-served byte for byte: their pins
        // are the Hugging Face LFS ids at the source revision.
        let pin = |name: &str| {
            COMMUNITY1_BUNDLE
                .iter()
                .find(|f| f.file_name == name)
                .map(|f| f.sha256)
        };
        assert_eq!(
            pin("pyannote-community-1-plda.npz"),
            Some("9b77bcd840692710dd3496f62ecfeed8d8e5f002fd991b785079b244eab7d255")
        );
        assert_eq!(
            pin("pyannote-community-1-xvec_transform.npz"),
            Some("325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f")
        );
        // The managed-artifact sweep knows every file.
        let root = Path::new("/models");
        let managed = managed_model_integrity_artifacts(root);
        for file in COMMUNITY1_BUNDLE {
            let path = root
                .join("diarization")
                .join(COMMUNITY1_BUNDLE_DIR)
                .join(file.file_name);
            assert!(managed
                .iter()
                .any(|(p, sha)| p == &path && sha == file.sha256));
        }
    }

    /// A scratch models folder holding `bytes` as one pinned file.
    fn trust_fixture(name: &str, bytes: &[u8]) -> (PathBuf, PathBuf, String) {
        use sha2::Digest as _;
        let root = std::env::temp_dir()
            .join("plainsong-model-trust")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create fixture dir");
        let model = root.join("model.bin");
        std::fs::write(&model, bytes).expect("write model");
        (root, model, hex::encode(sha2::Sha256::digest(bytes)))
    }

    /// A fresh sidecar process's verification state.
    fn new_session() -> &'static ModelTrustSession {
        Box::leak(Box::new(ModelTrustSession::default()))
    }

    fn set_modified(path: &Path, time: std::time::SystemTime) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .expect("open model")
            .set_times(std::fs::FileTimes::new().set_modified(time))
            .expect("set modification time");
    }

    /// Overwrite one byte in place, keeping the size and putting the
    /// modification time back: only the change time records the write.
    fn edit_one_byte_in_place(path: &Path) {
        use std::io::{Seek, SeekFrom, Write};
        let mtime = std::fs::metadata(path).unwrap().modified().unwrap();
        let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start(3)).unwrap();
        file.write_all(b"X").unwrap();
        drop(file);
        set_modified(path, mtime);
    }

    #[test]
    fn startup_removes_the_old_verified_model_list_and_hashes_nothing() {
        let (root, model, digest) = trust_fixture("startup", b"pinned model bytes");
        let list = root.join(LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME);
        let partial = root.join(format!("{LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME}.tmp-1234"));
        let forged = format!(
            r#"{{"version":1,"entries":[{{"path":"{}","sha256":"{digest}"}}]}}"#,
            model.display()
        );
        std::fs::write(&list, &forged).unwrap();
        std::fs::write(&partial, &forged).unwrap();

        remove_legacy_verified_model_cache(&root);

        assert!(!list.exists() && !partial.exists());
        assert!(model.exists(), "models are never touched");
        let session = new_session();
        assert!(is_model_artifact_installed_in(
            session,
            &model,
            Some(&digest)
        ));
        assert!(!is_model_artifact_verified_in(session, &model, &digest));
        assert_eq!(
            full_hash_count_for_tests(&model),
            0,
            "readiness reads no bytes"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn first_use_hashes_once_and_later_uses_in_the_session_do_not() {
        let (root, model, digest) = trust_fixture("first-use", b"pinned model bytes");
        let session = new_session();

        let (first, hashed) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        assert!(hashed);
        assert_eq!(
            std::fs::read(first.load_path()).unwrap(),
            b"pinned model bytes"
        );
        drop(first);
        for _ in 0..3 {
            let (again, hashed) =
                open_verified_model_artifact_in(session, &model, &digest).unwrap();
            assert!(!hashed);
            assert_eq!(
                std::fs::read(again.load_path()).unwrap(),
                b"pinned model bytes"
            );
        }
        assert_eq!(full_hash_count_for_tests(&model), 1);

        let (_, hashed) = open_verified_model_artifact_in(new_session(), &model, &digest).unwrap();
        assert!(hashed, "a new process trusts nothing from the last one");
        assert_eq!(full_hash_count_for_tests(&model), 2);
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_byte_changed_in_place_with_size_and_mtime_kept_is_caught() {
        let (root, model, digest) = trust_fixture("edit", b"pinned model bytes");
        let session = new_session();
        open_verified_model_artifact_in(session, &model, &digest).unwrap();

        edit_one_byte_in_place(&model);

        let error = open_verified_model_artifact_in(session, &model, &digest).unwrap_err();
        assert!(is_integrity_mismatch(&error), "{error:#}");
        assert!(
            error.to_string().contains("Download the model again"),
            "{error}"
        );
        assert_eq!(
            full_hash_count_for_tests(&model),
            2,
            "the change time forced a hash"
        );
        assert!(
            !is_model_artifact_installed_in(session, &model, Some(&digest)),
            "a file found wrong reads as missing, which offers the download"
        );

        let next = new_session();
        assert!(is_model_artifact_installed_in(next, &model, Some(&digest)));
        assert!(is_integrity_mismatch(
            &open_verified_model_artifact_in(next, &model, &digest).unwrap_err()
        ));

        // A fresh copy of the right bytes is a new file and verifies again.
        std::fs::write(&model, b"pinned model bytes").unwrap();
        assert!(is_model_artifact_installed_in(next, &model, Some(&digest)));
        assert!(
            open_verified_model_artifact_in(next, &model, &digest)
                .unwrap()
                .1
        );
        std::fs::remove_dir_all(root).ok();
    }

    /// setattrlist accepts a change time but the kernel stamps the change
    /// itself, so a same-user process cannot hide a write by restoring both
    /// times.
    #[cfg(target_os = "macos")]
    #[test]
    fn restoring_the_change_time_with_setattrlist_does_not_hide_a_write() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;
        let (root, model, digest) = trust_fixture("chgtime", b"pinned model bytes");
        let session = new_session();
        open_verified_model_artifact_in(session, &model, &digest).unwrap();
        let before = std::fs::metadata(&model).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        edit_one_byte_in_place(&model);
        #[repr(C, packed)]
        struct Times {
            modified: libc::timespec,
            changed: libc::timespec,
        }
        let mut times = Times {
            modified: libc::timespec {
                tv_sec: before.mtime(),
                tv_nsec: before.mtime_nsec(),
            },
            changed: libc::timespec {
                tv_sec: before.ctime(),
                tv_nsec: before.ctime_nsec(),
            },
        };
        let mut list = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: libc::ATTR_CMN_MODTIME | libc::ATTR_CMN_CHGTIME,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let path = std::ffi::CString::new(model.as_os_str().as_bytes()).unwrap();
        let result = unsafe {
            libc::setattrlist(
                path.as_ptr(),
                (&mut list as *mut libc::attrlist).cast(),
                (&mut times as *mut Times).cast(),
                std::mem::size_of::<Times>(),
                0,
            )
        };
        assert_eq!(result, 0, "{}", std::io::Error::last_os_error());

        let after = std::fs::metadata(&model).unwrap();
        assert_eq!((after.len(), after.ino()), (before.len(), before.ino()));
        assert_eq!(
            (after.mtime(), after.mtime_nsec()),
            (before.mtime(), before.mtime_nsec())
        );
        assert_ne!(
            (after.ctime(), after.ctime_nsec()),
            (before.ctime(), before.ctime_nsec()),
            "the kernel set the change time to now"
        );
        assert!(is_integrity_mismatch(
            &open_verified_model_artifact_in(session, &model, &digest).unwrap_err()
        ));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_new_identity_mid_session_is_hashed_again() {
        let (root, model, digest) = trust_fixture("identity", b"pinned model bytes");
        let session = new_session();
        assert!(
            open_verified_model_artifact_in(session, &model, &digest)
                .unwrap()
                .1
        );

        set_modified(
            &model,
            std::time::SystemTime::now() + std::time::Duration::from_secs(5),
        );
        assert!(!is_model_artifact_verified_in(session, &model, &digest));
        assert!(
            open_verified_model_artifact_in(session, &model, &digest)
                .unwrap()
                .1
        );
        assert!(
            !open_verified_model_artifact_in(session, &model, &digest)
                .unwrap()
                .1
        );

        // Same bytes and times under a new inode.
        let mtime = std::fs::metadata(&model).unwrap().modified().unwrap();
        let copy = model.with_file_name("copy.bin");
        std::fs::write(&copy, b"pinned model bytes").unwrap();
        set_modified(&copy, mtime);
        std::fs::rename(&copy, &model).unwrap();
        assert!(
            open_verified_model_artifact_in(session, &model, &digest)
                .unwrap()
                .1
        );

        // A different pin for the same file is a different question.
        let other_pin = "f".repeat(64);
        assert!(is_integrity_mismatch(
            &open_verified_model_artifact_in(session, &model, &other_pin).unwrap_err()
        ));
        assert_eq!(full_hash_count_for_tests(&model), 4);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_failed_native_load_drops_the_session_entry() {
        let (root, model, digest) = trust_fixture("load-fails", b"pinned model bytes");
        let session = new_session();
        let (artifact, _) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        let error = artifact
            .load(|_| -> Result<()> { anyhow::bail!("the runtime rejected the graph") })
            .unwrap_err();
        assert!(error.to_string().contains("rejected the graph"));
        assert!(!is_model_artifact_verified_in(session, &model, &digest));
        assert!(
            open_verified_model_artifact_in(session, &model, &digest)
                .unwrap()
                .1
        );
        assert_eq!(full_hash_count_for_tests(&model), 2);
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn metadata_changes_during_load_rehash_the_pin_and_preserve_path_checks() {
        use std::os::unix::fs::PermissionsExt;
        let (root, model, digest) = trust_fixture("load-metadata", b"pinned model bytes");
        let session = new_session();
        let (artifact, _) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        artifact
            .load(|_| {
                let mode = std::fs::metadata(&model)?.permissions().mode();
                std::fs::set_permissions(&model, std::fs::Permissions::from_mode(mode ^ 0o100))?;
                Ok(())
            })
            .unwrap();
        artifact.confirm_path_unchanged().unwrap();
        assert!(
            full_hash_count_for_tests(&model) >= 2,
            "metadata changes require a fresh hash"
        );
        assert!(is_model_artifact_verified_in(session, &model, &digest));
        std::fs::rename(&model, model.with_file_name("moved.bin")).unwrap();
        std::fs::write(&model, b"pinned model bytes").unwrap();
        let error = artifact.confirm_path_unchanged().unwrap_err();
        assert!(is_model_artifact_changed(&error), "{error:#}");
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_write_during_a_native_load_fails_the_load() {
        let (root, model, digest) = trust_fixture("load-write", b"pinned model bytes");
        let session = new_session();
        let (artifact, _) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        let error = artifact
            .load(|_| {
                edit_one_byte_in_place(&model);
                Ok(())
            })
            .unwrap_err();
        assert!(is_integrity_mismatch(&error), "{error:#}");
        assert!(!is_model_artifact_installed_in(
            session,
            &model,
            Some(&digest)
        ));
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn loaders_read_the_verified_file_even_after_the_path_is_swapped() {
        let (root, model, digest) = trust_fixture("swap", b"verified bytes");
        let session = new_session();
        let (artifact, _) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        assert_ne!(artifact.load_path(), model.as_path());
        // Move the checked file aside and put other bytes at its path.
        std::fs::rename(&model, model.with_file_name("moved-aside.bin")).unwrap();
        std::fs::write(&model, b"attacker bytes").unwrap();

        // Each open of the load path gets the verified bytes from the start.
        for _ in 0..2 {
            assert_eq!(
                std::fs::read(artifact.load_path()).unwrap(),
                b"verified bytes"
            );
        }
        // The rename may itself move the checked file's change time, which
        // fails the load closed. Either way the swapped-in bytes never load.
        match artifact.load(|path| Ok(std::fs::read(path)?)) {
            Ok(loaded) => assert_eq!(loaded, b"verified bytes"),
            Err(error) => {
                assert!(
                    error.to_string().contains("changed while it was loading"),
                    "{error}"
                )
            }
        }
        assert!(
            artifact.confirm_path_unchanged().is_err(),
            "a loader that must open the path itself sees the swap"
        );
        assert!(is_integrity_mismatch(
            &open_verified_model_artifact_in(session, &model, &digest).unwrap_err()
        ));
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_verified_file_replaced_by_rename_never_loads_the_new_bytes() {
        let (root, model, digest) = trust_fixture("replace", b"verified bytes");
        let (artifact, _) =
            open_verified_model_artifact_in(new_session(), &model, &digest).unwrap();
        let replacement = model.with_file_name("replacement.bin");
        std::fs::write(&replacement, b"attacker bytes").unwrap();
        std::fs::rename(&replacement, &model).unwrap();
        // With its last link gone the checked file may no longer open by
        // inode; the loader then fails instead of reading the replacement.
        match std::fs::read(artifact.load_path()) {
            Ok(bytes) => assert_eq!(bytes, b"verified bytes"),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn hashing_rejects_a_file_written_between_read_chunks() {
        use std::io::{Seek, SeekFrom, Write};
        let (root, model, _) = trust_fixture("mid-hash", &vec![0x5a; 2 * 1024 * 1024]);
        let file = std::fs::File::open(&model).unwrap();
        let mut mutated = false;
        let result = model_trust::hash_open_file(&file, &model, |_| {
            if std::mem::replace(&mut mutated, true) {
                return;
            }
            let mut writer = std::fs::OpenOptions::new()
                .write(true)
                .open(&model)
                .unwrap();
            writer.seek(SeekFrom::Start(1024 * 1024 + 32)).unwrap();
            writer.write_all(b"changed").unwrap();
            writer.sync_all().unwrap();
        });
        assert!(result.is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bytes_hashed_as_they_are_read_are_the_bytes_returned() {
        let (root, model, digest) = trust_fixture("read-bytes", b"tokenizer bytes");
        assert_eq!(
            read_verified_model_bytes(&model, &digest).unwrap(),
            b"tokenizer bytes"
        );
        std::fs::write(&model, b"tokenizer bytez").unwrap();
        let error = read_verified_model_bytes(&model, &digest).unwrap_err();
        assert!(is_integrity_mismatch(&error));
        assert!(!is_model_artifact_installed(&model, Some(&digest)));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn preverification_hashes_each_file_once_so_first_use_does_not_wait() {
        let (root, model, digest) = trust_fixture("preverify", b"pinned model bytes");
        let wrong = root.join("wrong.bin");
        std::fs::write(&wrong, b"not the pinned bytes").unwrap();
        let missing = root.join("missing.bin");
        let artifacts = vec![
            (model.clone(), digest.clone()),
            (wrong.clone(), digest.clone()),
            (missing, digest.clone()),
        ];
        let session = new_session();

        let report = preverify_models_in(session, &artifacts);
        assert_eq!(report.hashed, 1);
        assert_eq!(report.rejected, vec![wrong.clone()]);
        assert!(report.errors.is_empty());
        assert!(!is_model_artifact_installed_in(
            session,
            &wrong,
            Some(&digest)
        ));

        let (_, hashed) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        assert!(!hashed, "the first load found the file already checked");
        let again = preverify_models_in(session, &artifacts);
        assert_eq!((again.hashed, again.already_verified), (0, 1));
        assert_eq!(full_hash_count_for_tests(&model), 1);
        assert_eq!(full_hash_count_for_tests(&wrong), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_load_racing_the_background_check_shares_its_hash() {
        let (root, model, digest) = trust_fixture("race", &vec![7u8; 8 * 1024 * 1024]);
        let session = new_session();
        let artifacts = vec![(model.clone(), digest.clone())];
        let background = std::thread::spawn(move || preverify_models_in(session, &artifacts));
        let (_, _) = open_verified_model_artifact_in(session, &model, &digest).unwrap();
        background.join().unwrap();
        assert_eq!(full_hash_count_for_tests(&model), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn a_bundle_reads_as_installed_until_one_file_is_found_wrong() {
        use sha2::Digest as _;
        let test_dir = std::env::temp_dir()
            .join("plainsong-model-bundle")
            .join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir_all(&test_dir).await.unwrap();
        let names = ["segmentation.onnx", "weights.data", "plda.npy"];
        let expected: Vec<(String, String)> = names
            .iter()
            .map(|name| {
                let contents = format!("bundle-fixture-{name}");
                std::fs::write(test_dir.join(name), &contents).unwrap();
                (
                    name.to_string(),
                    hex::encode(sha2::Sha256::digest(contents)),
                )
            })
            .collect();
        let pins = || {
            expected
                .iter()
                .map(|(name, sha)| (name.as_str(), sha.as_str()))
        };

        assert!(
            is_bundle_installed(&test_dir, pins()),
            "readiness does not hash"
        );
        std::fs::remove_file(test_dir.join(names[2])).unwrap();
        assert!(
            !is_bundle_installed(&test_dir, pins()),
            "every file must be present"
        );
        std::fs::write(
            test_dir.join(names[2]),
            format!("bundle-fixture-{}", names[2]),
        )
        .unwrap();

        std::fs::write(test_dir.join(names[1]), "tampered").unwrap();
        assert!(is_bundle_installed(&test_dir, pins()));
        assert!(
            !verify_or_record_model_integrity(&test_dir.join(names[1]), Some(&expected[1].1))
                .await
                .unwrap()
        );
        assert!(
            !is_bundle_installed(&test_dir, pins()),
            "one file found wrong makes the whole bundle missing"
        );
        assert!(!is_community1_bundle_installed(&test_dir));
        tokio::fs::remove_dir_all(&test_dir).await.ok();
    }

    #[tokio::test]
    async fn verifying_writes_nothing_beside_the_model_and_clears_an_old_receipt() {
        let (root, model, digest) = trust_fixture("no-sibling", b"never verified bytes");
        std::fs::write(
            legacy_integrity_receipt_path(&model),
            format!("plainsong-model-integrity-v2\nsha256={digest}\nmac=00\n"),
        )
        .unwrap();
        assert!(verify_or_record_model_integrity(&model, Some(&digest))
            .await
            .unwrap());
        assert!(!legacy_integrity_receipt_path(&model).exists());
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "verification writes nothing into the models folder"
        );
        assert!(is_model_artifact_verified(&model, &digest));
        assert!(
            verify_existing_model_in_process(&model, &digest)
                .await
                .unwrap(),
            "read-only verification of an existing model"
        );
        assert_eq!(std::fs::read(&model).unwrap(), b"never verified bytes");
        assert!(!verify_existing_model_in_process(&model, &"0".repeat(64))
            .await
            .unwrap());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn every_managed_integrity_artifact_carries_a_real_pinned_digest() {
        // A hand-added table entry with a forgotten or blank sha256 must fail
        // this test rather than silently disabling verification for that
        // artifact (see the historical `expected_sha256.is_empty()` bypass
        // this whole module used to have).
        let artifacts =
            managed_model_integrity_artifacts(std::path::Path::new("/tmp/plainsong-test-root"));
        assert!(
            !artifacts.is_empty(),
            "the managed artifact registry must not be empty"
        );
        for (path, sha256) in &artifacts {
            assert_eq!(
                sha256.len(),
                64,
                "{} has a pinned digest of length {} (expected 64 hex chars)",
                path.display(),
                sha256.len()
            );
            assert!(
                sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} has a non-hex pinned digest: {sha256}",
                path.display()
            );
        }
    }

    #[tokio::test]
    async fn verify_or_record_model_integrity_treats_none_as_not_yet_pinned() {
        let (root, model, _) = trust_fixture("unpinned", b"any bytes at all");
        // `None` means "not yet pinned": the file is accepted on existence
        // alone, and nothing is recorded (there is nothing to pin it to).
        assert!(
            verify_or_record_model_integrity_in(new_session(), &model, None)
                .await
                .expect("unpinned artifacts are accepted on existence")
        );
        assert!(!is_model_artifact_installed(&model, None));
        assert_eq!(full_hash_count_for_tests(&model), 0);
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    #[should_panic(expected = "expected_sha256 must be None")]
    async fn verify_or_record_model_integrity_rejects_empty_string_as_a_hard_error() {
        let (_root, model, _) = trust_fixture("empty-digest", b"some bytes");
        // Some("") must never be silently treated as "not yet pinned" (that
        // is what `None` is for) or as "trust it". Debug/test builds make
        // this a loud panic via `assert_pinned_digest_is_never_empty`; the
        // `anyhow::bail!` further down is the release-build backstop.
        let _ = verify_or_record_model_integrity(&model, Some("")).await;
    }

    #[tokio::test]
    async fn download_error_body_stops_at_four_kib_without_draining() {
        use std::cell::Cell;
        let polls = Cell::new(0);
        let body = futures_util::stream::poll_fn(|_| {
            polls.set(polls.get() + 1);
            assert!(polls.get() <= 4, "error body was drained beyond its limit");
            std::task::Poll::Ready(Some(Ok::<_, std::io::Error>(vec![b'x'; 1024])))
        });
        assert_eq!(bounded_download_error_snippet(body).await, "x".repeat(200));
        assert_eq!(polls.get(), 4);
    }

    #[tokio::test]
    async fn download_error_body_handles_large_chunks_empty_bodies_and_invalid_utf8() {
        let large = futures_util::stream::iter([Ok::<_, std::io::Error>(vec![b'a'; 1024 * 1024])]);
        assert_eq!(bounded_download_error_snippet(large).await, "a".repeat(200));
        let empty = futures_util::stream::empty::<std::io::Result<Vec<u8>>>();
        assert_eq!(bounded_download_error_snippet(empty).await, "");
        let broken = futures_util::stream::iter([
            Ok(vec![b' ', 0xff, b' ']),
            Err(std::io::Error::other("mock read error")),
        ]);
        assert_eq!(bounded_download_error_snippet(broken).await, "\u{fffd}");
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
    async fn downloaded_model_listing_includes_both_whistle_assets() {
        let models_dir = std::env::temp_dir().join(format!(
            "plainsong-whistle-listing-{}",
            uuid::Uuid::new_v4()
        ));
        let dir = crate::asr::whistle::model_dir(&models_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("whistle.cact"), b"model").unwrap();
        std::fs::write(dir.join("needle"), b"cli").unwrap();
        std::fs::write(dir.join("needle.installing"), b"partial").unwrap();
        let manager = DownloadManager {
            client: build_download_client().unwrap(),
            models_dir: models_dir.clone(),
        };
        let rows = manager.list_downloaded_models().await.unwrap();
        let rows = rows
            .iter()
            .filter(|row| row.provider == "whistle")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().map(|row| row.size_bytes).sum::<u64>(), 8);
        assert!(rows.iter().any(|row| row.path == dir.join("whistle.cact")));
        assert!(rows.iter().any(|row| row.path == dir.join("needle")));
        std::fs::remove_dir_all(models_dir).unwrap();
    }

    #[tokio::test]
    async fn downloaded_model_listing_sums_the_flat_qwen3_bundle() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-qwen3-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let qwen3_dir = models_dir.join("qwen3_asr");
        std::fs::create_dir_all(&qwen3_dir).expect("create qwen3 dir");
        std::fs::write(qwen3_dir.join("encoder.int4.onnx"), vec![0u8; 1000]).expect("encoder");
        std::fs::write(qwen3_dir.join("decoder_weights.int4.data"), vec![0u8; 500])
            .expect("weights");
        std::fs::write(qwen3_dir.join("config.json"), b"{}").expect("config");
        std::fs::write(
            qwen3_dir.join("config.json.plainsong-integrity"),
            b"receipt",
        )
        .expect("receipt is metadata, not model footprint");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        let qwen3: Vec<&DownloadedModel> = listed
            .iter()
            .filter(|model| model.provider == "qwen3_asr")
            .collect();
        assert_eq!(qwen3.len(), 1, "one flat bundle entry, got {qwen3:?}");
        assert_eq!(qwen3[0].name, "qwen3-asr-0.6b");
        assert_eq!(qwen3[0].path, qwen3_dir);
        assert_eq!(
            qwen3[0].size_bytes,
            1000 + 500 + 2,
            "the flat files are the footprint; the receipt is not"
        );

        std::fs::remove_dir_all(&models_dir).ok();
    }

    /// 473 MiB of dictation-cleanup weights were invisible here: the listing
    /// had no branch for `models/bundled_cleanup`, so the Models screen could
    /// not show them and the storage total did not count them.
    #[tokio::test]
    async fn downloaded_model_listing_sums_the_bundled_cleanup_model() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-bundled-cleanup-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let bundled_dir = models_dir.join(crate::llm::bundled_local::MODEL_DIR_NAME);
        std::fs::create_dir_all(&bundled_dir).expect("create bundled cleanup dir");
        std::fs::write(bundled_dir.join("s1-mini-q4_k_m.gguf"), vec![0u8; 4_000]).expect("weights");
        std::fs::write(bundled_dir.join("tokenizer.json"), vec![0u8; 900]).expect("tokenizer");
        std::fs::write(bundled_dir.join("LICENSE"), vec![0u8; 80]).expect("license");
        std::fs::write(bundled_dir.join("NOTICE"), vec![0u8; 20]).expect("notice");
        std::fs::write(
            legacy_integrity_receipt_path(&bundled_dir.join("LICENSE")),
            b"receipt",
        )
        .expect("receipt is metadata, not model footprint");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        let bundled: Vec<&DownloadedModel> = listed
            .iter()
            .filter(|model| model.provider == crate::llm::bundled_local::PROVIDER_SETTINGS_VALUE)
            .collect();
        assert_eq!(bundled.len(), 1, "one bundle entry, got {bundled:?}");
        // Apache-2.0 + naming clause: this exact capitalization, wherever used.
        assert_eq!(bundled[0].name, "S1-mini by Superwhisper");
        assert_eq!(bundled[0].path, bundled_dir);
        assert_eq!(
            bundled[0].size_bytes,
            4_000 + 900 + 80 + 20,
            "every pinned file counts toward the footprint; the receipt does not"
        );

        std::fs::remove_dir_all(&models_dir).ok();
    }

    /// The transcribe.cpp GGUFs were invisible to the model manager: the
    /// listing had no branch for `models/transcribe_cpp`, and `delete_model`
    /// only ever removes something the listing surfaced, so 1.42 GiB of weights
    /// could be downloaded and then neither seen nor reclaimed.
    #[tokio::test]
    async fn downloaded_model_listing_shows_and_can_delete_each_transcribe_cpp_gguf() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-transcribe-cpp-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let dir = models_dir.join("transcribe_cpp");
        std::fs::create_dir_all(&dir).expect("create transcribe_cpp dir");
        let parakeet = dir.join("parakeet-tdt-0.6b-v3-Q8_0.gguf");
        let nemotron = dir.join("nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf");
        std::fs::write(&parakeet, vec![0u8; 4096]).expect("parakeet gguf");
        std::fs::write(&nemotron, vec![0u8; 2048]).expect("nemotron gguf");
        std::fs::write(legacy_integrity_receipt_path(&parakeet), b"receipt").expect("receipt");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        let spike: Vec<&DownloadedModel> = listed
            .iter()
            .filter(|model| model.provider == "transcribe_cpp")
            .collect();
        assert_eq!(
            spike.len(),
            2,
            "one entry per GGUF, and the receipt is not one, got {spike:?}"
        );
        let listed_parakeet = spike
            .iter()
            .find(|model| model.path == parakeet)
            .expect("the Parakeet GGUF must be listed");
        assert_eq!(listed_parakeet.name, "parakeet-tdt-0.6b-v3-Q8_0.gguf");
        assert_eq!(listed_parakeet.size_bytes, 4096);
        assert!(spike.iter().any(|model| model.path == nemotron));

        // Every entry names a file, so the path the listing hands back is one
        // `delete_model` can actually remove -- with its receipt.
        for model in [parakeet.clone(), nemotron.clone()] {
            manager
                .delete_model(&model)
                .await
                .unwrap_or_else(|error| panic!("delete {}: {error}", model.display()));
            assert!(!model.exists());
        }
        assert!(!legacy_integrity_receipt_path(&parakeet).exists());
        assert!(manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed")
            .iter()
            .all(|model| model.provider != "transcribe_cpp"));

        std::fs::remove_dir_all(&models_dir).ok();
    }

    /// On a Mac that runs it, Parakeet's download is the Core ML build alone:
    /// it must be listed (or Parakeet reads as not downloaded), counted, and
    /// removable as one bundle.
    #[cfg(feature = "asr-transcribe-cpp")]
    #[tokio::test]
    async fn downloaded_model_listing_shows_and_can_delete_core_ml_bundles() {
        use crate::asr::neural_engine::{PARAKEET_CTC_VOCABULARY, PARAKEET_V3_COREML};
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-neural-engine-listing")
            .join(uuid::Uuid::new_v4().to_string());
        for spec in [&PARAKEET_V3_COREML, &PARAKEET_CTC_VOCABULARY] {
            let dir = spec.dir(&models_dir);
            for file in spec.files {
                let path = dir.join(file.path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"xx").unwrap();
            }
        }
        // An interrupted download of the English build: only one file.
        let partial = models_dir
            .join("neural_engine")
            .join("parakeet-tdt-0.6b-v2-coreml");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(partial.join("config.json"), b"{}").unwrap();

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager.list_downloaded_models().await.expect("listing");
        let entry = |dir: &Path| {
            listed
                .iter()
                .find(|model| model.path == dir)
                .unwrap_or_else(|| panic!("{} is listed", dir.display()))
        };
        let v3 = entry(&PARAKEET_V3_COREML.dir(&models_dir));
        assert_eq!(v3.provider, "transcribe_cpp");
        assert_eq!(v3.name, PARAKEET_V3_COREML.model_id);
        assert_eq!(v3.size_bytes, 2 * PARAKEET_V3_COREML.files.len() as u64);
        assert_eq!(
            entry(&PARAKEET_CTC_VOCABULARY.dir(&models_dir)).name,
            PARAKEET_CTC_VOCABULARY.model_id
        );
        assert_eq!(
            entry(&partial).name,
            "parakeet-tdt-0.6b-v2-coreml (incomplete)"
        );

        manager.delete_model(&v3.path).await.expect("delete bundle");
        assert!(!PARAKEET_V3_COREML.dir(&models_dir).exists());
        std::fs::remove_dir_all(&models_dir).ok();
    }

    /// The four speaker embedders and any model bundle were downloaded into
    /// `models/diarization` and then never listed, so the Models screen could
    /// not show them and `delete_model` had no path to hand back.
    #[tokio::test]
    async fn downloaded_model_listing_includes_diarization_models_and_bundles() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-diarization-listing")
            .join(uuid::Uuid::new_v4().to_string());
        let diarization_dir = models_dir.join("diarization");
        let bundle_dir = diarization_dir.join(COMMUNITY1_BUNDLE_DIR);
        std::fs::create_dir_all(&bundle_dir).expect("create bundle dir");

        std::fs::write(
            diarization_dir.join("ecapa_tdnn_speaker.onnx"),
            vec![0u8; 2_000],
        )
        .expect("ecapa");
        std::fs::write(
            diarization_dir.join("nemotron3_diar_v3.onnx"),
            vec![0u8; 4_000],
        )
        .expect("nemotron");
        std::fs::write(
            diarization_dir.join("campplus_speaker.onnx"),
            vec![0u8; 3_000],
        )
        .expect("campplus");
        std::fs::write(
            legacy_integrity_receipt_path(&diarization_dir.join("campplus_speaker.onnx")),
            b"receipt",
        )
        .expect("receipt is metadata, not model footprint");
        std::fs::write(
            bundle_dir.join("pyannote-community-1-segmentation.onnx"),
            vec![0u8; 500],
        )
        .expect("seg");
        std::fs::write(
            bundle_dir.join("pyannote-community-1-plda.npz"),
            vec![0u8; 120],
        )
        .expect("plda");
        std::fs::write(
            legacy_integrity_receipt_path(&bundle_dir.join("pyannote-community-1-plda.npz")),
            b"receipt",
        )
        .expect("bundle receipt");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let listed = manager
            .list_downloaded_models()
            .await
            .expect("listing should succeed");

        let diarization: Vec<&DownloadedModel> = listed
            .iter()
            .filter(|model| model.provider == "diarization")
            .collect();
        assert_eq!(
            diarization.len(),
            4,
            "two embedders, Nemotron and one bundle: {diarization:?}"
        );

        let ecapa = diarization
            .iter()
            .find(|model| model.path == diarization_dir.join("ecapa_tdnn_speaker.onnx"))
            .expect("ECAPA listed");
        // The picker's own label, so a row can be matched to the entry that
        // downloaded it.
        assert_eq!(ecapa.name, "Speaker embedding ECAPA-TDNN 512");
        assert_eq!(ecapa.size_bytes, 2_000);
        let nemotron = diarization
            .iter()
            .find(|model| model.path == diarization_dir.join("nemotron3_diar_v3.onnx"))
            .expect("Nemotron listed");
        assert_eq!(
            nemotron.name,
            "Speaker labels Nemotron 3 Diarization (experimental)"
        );
        assert_eq!(nemotron.size_bytes, 4_000);

        let campplus = diarization
            .iter()
            .find(|model| model.path == diarization_dir.join("campplus_speaker.onnx"))
            .expect("CAM++ listed");
        assert_eq!(campplus.name, "Speaker embedding CAM++");
        assert_eq!(campplus.size_bytes, 3_000);

        let bundle = diarization
            .iter()
            .find(|model| model.path == bundle_dir)
            .expect("community-1 bundle listed as one entry");
        assert_eq!(bundle.name, "Speaker labels pyannote community-1");
        assert_eq!(
            bundle.size_bytes,
            500 + 120,
            "the bundle's files are the footprint; the receipts are not"
        );
        assert!(
            listed
                .iter()
                .all(|model| !is_internal_model_metadata_file(&model.path)),
            "receipts must not be listed as models"
        );

        std::fs::remove_dir_all(&models_dir).ok();
    }

    /// A bundle is listed by its directory, so deleting one has to remove the
    /// directory. `remove_file` returned an error on every bundle entry, which
    /// is why a diarization bundle (and the Qwen3-ASR and cleanup bundles beside
    /// it) could be seen but not deleted.
    #[tokio::test]
    async fn deleting_a_model_bundle_removes_the_whole_directory() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-delete-bundle")
            .join(uuid::Uuid::new_v4().to_string());
        let bundle_dir = models_dir.join("diarization").join(COMMUNITY1_BUNDLE_DIR);
        std::fs::create_dir_all(&bundle_dir).expect("create bundle dir");
        let payload = bundle_dir.join("pyannote-community-1-segmentation.onnx");
        std::fs::write(&payload, b"weights").expect("write payload");
        std::fs::write(legacy_integrity_receipt_path(&payload), b"receipt").expect("write receipt");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        manager
            .delete_model(&bundle_dir)
            .await
            .expect("a bundle directory is deletable");

        assert!(!bundle_dir.exists(), "the bundle and its receipts are gone");
        assert!(
            models_dir.join("diarization").exists(),
            "only the bundle is removed, not its parent"
        );

        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[tokio::test]
    async fn deleting_the_models_directory_itself_is_refused() {
        let models_dir = std::env::temp_dir()
            .join("plainsong-download-delete-root")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(models_dir.join("diarization")).expect("create models dir");

        let manager = DownloadManager {
            client: build_download_client().expect("client"),
            models_dir: models_dir.clone(),
        };
        let error = manager
            .delete_model(&models_dir)
            .await
            .expect_err("the managed root is not a model");
        assert!(
            error.to_string().contains("models directory itself"),
            "got {error}"
        );
        assert!(models_dir.exists());

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
            std::fs::write(legacy_integrity_receipt_path(path), b"receipt").expect("write receipt");
            std::fs::write(
                path_with_suffix(&legacy_integrity_receipt_path(path), ".tmp-123"),
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
        let receipt_path = legacy_integrity_receipt_path(&model_path);
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
