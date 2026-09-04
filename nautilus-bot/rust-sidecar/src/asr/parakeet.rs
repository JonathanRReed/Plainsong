//! NVIDIA Parakeet, three pure-ONNX routes and nothing else.
//!
//! * `parakeet-tdt-0.6b-v2` — the English 0.6B transducer, run as three ONNX
//!   graphs with the same bounded greedy TDT decoder.
//! * `parakeet-tdt-0.6b-v3` — the multilingual 0.6B transducer, run as three
//!   ONNX graphs (encoder / decoder / joiner) with the greedy TDT decoder in
//!   [`super::parakeet_tdt`].
//! * `parakeet-tdt-ctc-110m` — the older English 110M CTC export, a single
//!   graph decoded by argmax with repeat collapsing.
//!
//! There used to be `parakeet-ctc-0.6b` and `parakeet-ctc-1.1b` here too. They
//! resolved raw `nvidia/*` NeMo checkpoints through a managed Python venv that
//! needed `torch` and `transformers`, so they could never start on a user's
//! machine. They are gone rather than hidden.

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
#[cfg(feature = "asr-parakeet")]
use std::sync::{Mutex, OnceLock};

#[cfg(feature = "asr-parakeet")]
use ort::session::Session;

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------
const PARAKEET_V3_MODEL_ID: &str = "parakeet-tdt-0.6b-v3";
const PARAKEET_V2_MODEL_ID: &str = "parakeet-tdt-0.6b-v2";
const PARAKEET_LEGACY_MODEL_ID: &str = "parakeet-tdt-ctc-110m";

// ---------------------------------------------------------------------------
// v3 artifacts
//
// sherpa-onnx's int8 export of `nvidia/parakeet-tdt-0.6b-v3`, four files. Sizes
// are the upstream `content-length` values, checked against the copy on disk;
// they drive both the download progress weighting and the "is this a real
// artifact or an HTML error page" floor.
// ---------------------------------------------------------------------------
const PARAKEET_V3_REPO: &str = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_V3_REVISION: &str = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
const PARAKEET_TDT_ENCODER_FILE: &str = "encoder.int8.onnx";
const PARAKEET_TDT_DECODER_FILE: &str = "decoder.int8.onnx";
const PARAKEET_TDT_JOINER_FILE: &str = "joiner.int8.onnx";

const PARAKEET_V2_REPO: &str = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const PARAKEET_V2_REVISION: &str = "1ab9323565ddb038682214b292f588070a538ce2";

/// The v3 encoder declares `audio_signal [batch, 128, frames]`. Handing it a
/// different width fails to bind rather than degrading quietly, so this is a
/// contract, not a tuning knob.
#[cfg(feature = "asr-parakeet")]
const PARAKEET_TDT_FEAT_DIM: usize = 128;

/// Every file the v3 route needs: `(filename, upstream bytes, minimum bytes)`.
///
/// The upstream size drives download progress weighting. The minimum is a
/// sanity floor: `is_valid_onnx_file` alone only rejects HTML and JSON error
/// bodies, so a stub or half-extracted binary would sail through it and then
/// fail deep inside ONNX Runtime with an unreadable protobuf error. The floors
/// are set well under the real sizes so an upstream re-export does not trip
/// them, but far enough above zero to catch anything that is not a model.
const PARAKEET_V3_ARTIFACTS: [(&str, u64, u64); 4] = [
    (PARAKEET_TDT_ENCODER_FILE, 652_184_281, 64 * 1024 * 1024),
    (PARAKEET_TDT_DECODER_FILE, 11_845_275, 1024 * 1024),
    (PARAKEET_TDT_JOINER_FILE, 6_355_277, 512 * 1024),
    (PARAKEET_VOCAB_FILE, 93_939, 4096),
];

const PARAKEET_V2_ARTIFACTS: [(&str, u64, u64); 4] = [
    (PARAKEET_TDT_ENCODER_FILE, 652_184_296, 64 * 1024 * 1024),
    (PARAKEET_TDT_DECODER_FILE, 7_257_753, 1024 * 1024),
    (PARAKEET_TDT_JOINER_FILE, 1_739_080, 512 * 1024),
    (PARAKEET_VOCAB_FILE, 9_384, 4096),
];

fn v3_sha256(file_name: &str) -> Option<&'static str> {
    match file_name {
        PARAKEET_TDT_ENCODER_FILE => {
            Some("acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247")
        }
        PARAKEET_TDT_DECODER_FILE => {
            Some("179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e")
        }
        PARAKEET_TDT_JOINER_FILE => {
            Some("3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3")
        }
        PARAKEET_VOCAB_FILE => {
            Some("d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d")
        }
        _ => None,
    }
}

fn v2_sha256(file_name: &str) -> Option<&'static str> {
    match file_name {
        PARAKEET_TDT_ENCODER_FILE => {
            Some("a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab")
        }
        PARAKEET_TDT_DECODER_FILE => {
            Some("b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e")
        }
        PARAKEET_TDT_JOINER_FILE => {
            Some("7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2")
        }
        PARAKEET_VOCAB_FILE => {
            Some("ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d")
        }
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct TdtContract {
    model_id: &'static str,
    display_version: &'static str,
    repo: &'static str,
    revision: &'static str,
    artifacts: &'static [(&'static str, u64, u64); 4],
    blank_id: usize,
    encoder_dim: usize,
}

const PARAKEET_V2: TdtContract = TdtContract {
    model_id: PARAKEET_V2_MODEL_ID,
    display_version: "v2",
    repo: PARAKEET_V2_REPO,
    revision: PARAKEET_V2_REVISION,
    artifacts: &PARAKEET_V2_ARTIFACTS,
    blank_id: super::parakeet_tdt::V2_BLANK_ID,
    encoder_dim: super::parakeet_tdt::V2_ENCODER_DIM,
};

const PARAKEET_V3: TdtContract = TdtContract {
    model_id: PARAKEET_V3_MODEL_ID,
    display_version: "v3",
    repo: PARAKEET_V3_REPO,
    revision: PARAKEET_V3_REVISION,
    artifacts: &PARAKEET_V3_ARTIFACTS,
    blank_id: super::parakeet_tdt::V3_BLANK_ID,
    encoder_dim: super::parakeet_tdt::V3_ENCODER_DIM,
};

fn tdt_sha256(contract: TdtContract, file_name: &str) -> Option<&'static str> {
    if contract.model_id == PARAKEET_V2_MODEL_ID {
        v2_sha256(file_name)
    } else {
        v3_sha256(file_name)
    }
}

fn tdt_min_bytes(contract: TdtContract, file_name: &str) -> u64 {
    contract
        .artifacts
        .iter()
        .find(|(name, _, _)| *name == file_name)
        .map(|(_, _, min)| *min)
        .unwrap_or(4096)
}

// ---------------------------------------------------------------------------
// Legacy 110M CTC artifacts
//
// Two names are accepted for the graph. `encoder.onnx` is what
// `scripts/provision-asr-assets.mjs` writes and what `asr/manager.rs`
// diagnostics look for; `model.onnx` is what older in-app downloads left
// behind. Accepting both is what stops diagnostics reporting Ready while
// transcription reports the model missing.
// ---------------------------------------------------------------------------
const PARAKEET_LEGACY_ONNX_FILE: &str = "encoder.onnx";
const PARAKEET_LEGACY_ONNX_ALIASES: [&str; 2] = ["encoder.onnx", "model.onnx"];
const PARAKEET_VOCAB_FILE: &str = "tokens.txt";

const PARAKEET_LEGACY_REPO: &str = "csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000";
const PARAKEET_LEGACY_ONNX_SOURCES: [(&str, &str); 1] = [
    (
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/3af92f152d32c836acabf38f4c993bc96b80eb2d/model.onnx",
        "936806cf3dd0db5aba53f8c7410bb5632d7a8ad6b2c51009f5e4fc0890ec76bf",
    ),
];
const PARAKEET_LEGACY_TOKENS_SOURCES: [(&str, &str); 1] = [
    (
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/3af92f152d32c836acabf38f4c993bc96b80eb2d/tokens.txt",
        "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
    ),
];
const PARAKEET_LEGACY_ONNX_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PARAKEET_LEGACY_TOKENS_MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let legacy_dir = models_root.join("parakeet");
    let mut artifacts = PARAKEET_LEGACY_ONNX_ALIASES
        .iter()
        .map(|file_name| {
            (
                legacy_dir.join(file_name),
                PARAKEET_LEGACY_ONNX_SOURCES[0].1.to_string(),
            )
        })
        .collect::<Vec<_>>();
    artifacts.push((
        legacy_dir.join(PARAKEET_VOCAB_FILE),
        PARAKEET_LEGACY_TOKENS_SOURCES[0].1.to_string(),
    ));

    let v3_dir = legacy_dir.join(PARAKEET_V3_MODEL_ID);
    artifacts.extend(PARAKEET_V3_ARTIFACTS.iter().map(|(file_name, _, _)| {
        (
            v3_dir.join(file_name),
            v3_sha256(file_name)
                .expect("every v3 artifact has a pinned digest")
                .to_string(),
        )
    }));
    let v2_dir = legacy_dir.join(PARAKEET_V2_MODEL_ID);
    artifacts.extend(PARAKEET_V2_ARTIFACTS.iter().map(|(file_name, _, _)| {
        (
            v2_dir.join(file_name),
            v2_sha256(file_name)
                .expect("every v2 artifact has a pinned digest")
                .to_string(),
        )
    }));
    artifacts
}

// ---------------------------------------------------------------------------
// Artifact validation
// ---------------------------------------------------------------------------

/// True only if the file exists, clears `min_bytes`, and does not start with an
/// HTML/JSON error marker (which would mean the download returned a page, not a
/// model).
fn is_valid_onnx_file(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes.max(4096) {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 4];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
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

/// Read `tokens.txt` into a table indexed by the id each line declares.
///
/// The file is `<piece> <id>` per line. Indexing by the declared id rather than
/// by line order means a reordered or gapped file decodes correctly instead of
/// producing plausible-looking nonsense. Split from the right because a piece
/// may contain characters that `split_whitespace` would treat as a boundary.
fn load_token_table(vocab_path: &Path) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(vocab_path)
        .with_context(|| format!("Failed to read Parakeet vocab: {}", vocab_path.display()))?;

    let mut table: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((piece, raw_id)) = line.rsplit_once(' ') else {
            continue;
        };
        let Ok(id) = raw_id.trim().parse::<usize>() else {
            continue;
        };
        if table.len() <= id {
            table.resize(id + 1, String::new());
        }
        table[id] = piece.to_string();
    }

    if table.is_empty() {
        return Err(anyhow::anyhow!(
            "Parakeet vocab at {} contained no usable '<piece> <id>' lines",
            vocab_path.display()
        ));
    }

    tracing::debug!(
        "Parakeet: loaded {} vocab entries from {}",
        table.len(),
        vocab_path.display()
    );
    Ok(table)
}

// ---------------------------------------------------------------------------
// TDT runtime: three sessions plus the token table, cached across utterances
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
struct ParakeetTdtRuntime {
    model_dir_key: String,
    encoder: Session,
    decoder: Session,
    joiner: Session,
    vocab: Vec<String>,
}

#[cfg(feature = "asr-parakeet")]
fn tdt_runtime_cache() -> &'static Mutex<Option<ParakeetTdtRuntime>> {
    static CACHE: OnceLock<Mutex<Option<ParakeetTdtRuntime>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-parakeet")]
fn build_tdt_session(path: &Path, label: &str, version: &str) -> Result<Session> {
    use ort::session::builder::GraphOptimizationLevel;

    Session::builder()
        .with_context(|| format!("Failed to create Parakeet {version} {label} session builder"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| {
            anyhow::anyhow!(
                "Failed to set optimization level for Parakeet {version} {label}: {error}"
            )
        })?
        .commit_from_file(path)
        .with_context(|| {
            format!(
                "Failed to load Parakeet {version} {label} from {}",
                path.display()
            )
        })
}

#[cfg(feature = "asr-parakeet")]
fn get_or_create_tdt_runtime(
    model_dir: &Path,
    contract: TdtContract,
) -> Result<std::sync::MutexGuard<'static, Option<ParakeetTdtRuntime>>> {
    let mut cache = tdt_runtime_cache()
        .lock()
        .map_err(|error| anyhow::anyhow!("Parakeet TDT runtime cache is unavailable: {}", error))?;

    let model_dir_key = model_dir.to_string_lossy().to_string();
    if cache
        .as_ref()
        .is_some_and(|runtime| runtime.model_dir_key == model_dir_key)
    {
        return Ok(cache);
    }

    tracing::info!(
        "Loading Parakeet TDT {} graphs from {}",
        contract.display_version,
        model_dir.display()
    );

    let vocab = load_token_table(&model_dir.join(PARAKEET_VOCAB_FILE))?;
    // The blank id is what tells the decoder when to stop emitting at a frame.
    // If tokens.txt is not the file this export was built with, decoding still
    // produces fluent-looking text off the wrong ids, so check it up front.
    let blank = vocab.get(contract.blank_id).map(String::as_str);
    if blank != Some("<blk>") {
        return Err(anyhow::anyhow!(
            "Parakeet {} tokens.txt does not match the shipped export: id {} is {:?}, expected \"<blk>\". Re-download the model in Settings -> ASR Models.",
            contract.display_version,
            contract.blank_id,
            blank
        ));
    }

    let encoder = build_tdt_session(
        &model_dir.join(PARAKEET_TDT_ENCODER_FILE),
        "encoder",
        contract.display_version,
    )?;
    let decoder = build_tdt_session(
        &model_dir.join(PARAKEET_TDT_DECODER_FILE),
        "decoder",
        contract.display_version,
    )?;
    let joiner = build_tdt_session(
        &model_dir.join(PARAKEET_TDT_JOINER_FILE),
        "joiner",
        contract.display_version,
    )?;

    *cache = Some(ParakeetTdtRuntime {
        model_dir_key,
        encoder,
        decoder,
        joiner,
        vocab,
    });

    tracing::info!(
        "Parakeet TDT {} runtime cached ({} vocab entries)",
        contract.display_version,
        cache.as_ref().map(|r| r.vocab.len()).unwrap_or(0)
    );
    Ok(cache)
}

// ---------------------------------------------------------------------------
// Legacy CTC session cache
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn legacy_session_cache() -> &'static Mutex<Option<Session>> {
    static CACHE: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "asr-parakeet")]
pub(crate) fn clear_cached_session() {
    if let Ok(mut cache) = legacy_session_cache().lock() {
        if cache.take().is_some() {
            tracing::info!("Cleared cached Parakeet legacy ONNX session");
        }
    }
    if let Ok(mut cache) = tdt_runtime_cache().lock() {
        if cache.take().is_some() {
            tracing::info!("Cleared cached Parakeet TDT runtime");
        }
    }
}

#[cfg(not(feature = "asr-parakeet"))]
pub(crate) fn clear_cached_session() {}

#[cfg(feature = "asr-parakeet")]
fn get_or_create_legacy_session(
    onnx_path: &Path,
) -> Result<std::sync::MutexGuard<'static, Option<Session>>> {
    let mut cache = legacy_session_cache().lock().map_err(|error| {
        anyhow::anyhow!("Parakeet ONNX session cache is unavailable: {}", error)
    })?;

    if cache.is_some() {
        return Ok(cache);
    }

    tracing::info!(
        "Creating new Parakeet legacy ONNX session from {}",
        onnx_path.display()
    );
    let session = build_tdt_session(onnx_path, "legacy CTC encoder", "legacy")?;
    *cache = Some(session);

    tracing::info!("Parakeet legacy ONNX session cached successfully");
    Ok(cache)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
pub struct ParakeetProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl ParakeetProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let models_root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&models_root, selected_model_id)
    }

    /// Same as [`Self::new`] but rooted at an explicit models directory, so
    /// tests can exercise the not-downloaded paths without touching the user's
    /// real model store.
    pub(crate) fn with_models_root(models_root: &Path, selected_model_id: Option<&str>) -> Self {
        let model_id =
            normalize_parakeet_model_id(selected_model_id.unwrap_or(PARAKEET_V3_MODEL_ID));
        // The legacy export predates per-model directories and lives directly
        // in `models/parakeet`; v3 gets its own subdirectory beside it.
        let model_dir = if model_id == PARAKEET_LEGACY_MODEL_ID {
            models_root.join("parakeet")
        } else {
            models_root.join("parakeet").join(&model_id)
        };

        Self {
            model_dir,
            model_id,
        }
    }

    fn is_legacy_model(&self) -> bool {
        self.model_id == PARAKEET_LEGACY_MODEL_ID
    }

    fn tdt_contract(&self) -> Option<TdtContract> {
        match self.model_id.as_str() {
            PARAKEET_V2_MODEL_ID => Some(PARAKEET_V2),
            PARAKEET_V3_MODEL_ID => Some(PARAKEET_V3),
            _ => None,
        }
    }

    /// The language to stamp on a `TranscriptionResult`, which is a claim about
    /// *this utterance*, not about what the model can do.
    ///
    /// The legacy 110M export is English-only, so `"en"` is a fact. The v3
    /// export decodes 25 European languages and exposes no language head at
    /// all — encoder, decoder and joiner, nothing that identifies a language —
    /// so there is nothing to report and this returns empty rather than
    /// guessing. That matters downstream: the stored transcript takes this
    /// verbatim (`lib.rs` `language: transcription_result.language.clone()`),
    /// and the meeting aggregator only adopts a per-source language when it is
    /// non-empty, so an empty value correctly reads as "not detected" instead
    /// of labelling German audio `en`.
    fn result_language(&self) -> &'static str {
        if self.is_legacy_model() || self.model_id == PARAKEET_V2_MODEL_ID {
            "en"
        } else {
            ""
        }
    }

    fn vocab_path(&self) -> PathBuf {
        self.model_dir.join(PARAKEET_VOCAB_FILE)
    }

    /// Whichever legacy graph name is actually present and valid, falling back
    /// to the canonical name so error messages stay useful when none is.
    fn legacy_onnx_path(&self) -> PathBuf {
        PARAKEET_LEGACY_ONNX_ALIASES
            .iter()
            .map(|name| self.model_dir.join(name))
            .find(|path| is_valid_onnx_file(path, 4096))
            .unwrap_or_else(|| self.model_dir.join(PARAKEET_LEGACY_ONNX_FILE))
    }

    fn has_required_files(&self) -> bool {
        self.missing_or_invalid_reason().is_none()
    }

    fn has_trusted_required_files(&self) -> bool {
        if self.is_legacy_model() {
            let onnx_sha256 = PARAKEET_LEGACY_ONNX_SOURCES[0].1;
            let tokens_sha256 = PARAKEET_LEGACY_TOKENS_SOURCES[0].1;
            return crate::download::is_model_artifact_trusted(
                &self.legacy_onnx_path(),
                Some(onnx_sha256),
            ) && crate::download::is_model_artifact_trusted(
                &self.vocab_path(),
                Some(tokens_sha256),
            );
        }

        let contract = self
            .tdt_contract()
            .expect("non-legacy Parakeet models have a TDT contract");
        contract.artifacts.iter().all(|(file_name, _, _)| {
            tdt_sha256(contract, file_name).is_some_and(|sha256| {
                crate::download::is_model_artifact_trusted(
                    &self.model_dir.join(file_name),
                    Some(sha256),
                )
            })
        })
    }

    fn missing_or_invalid_reason(&self) -> Option<String> {
        if self.is_legacy_model() {
            return self.legacy_missing_reason();
        }
        self.tdt_missing_reason()
    }

    fn tdt_missing_reason(&self) -> Option<String> {
        let contract = self
            .tdt_contract()
            .expect("non-legacy Parakeet models have a TDT contract");
        let mut missing: Vec<&str> = Vec::new();
        let mut invalid: Vec<&str> = Vec::new();

        for &(file_name, _, _) in contract.artifacts {
            let path = self.model_dir.join(file_name);
            if !path.exists() {
                missing.push(file_name);
                continue;
            }
            let ok = if file_name == PARAKEET_VOCAB_FILE {
                is_valid_tokens_file(&path)
            } else {
                is_valid_onnx_file(&path, tdt_min_bytes(contract, file_name))
            };
            if !ok {
                invalid.push(file_name);
            }
        }

        if !missing.is_empty() {
            return Some(format!(
                "Parakeet TDT {} is not downloaded yet (missing {}). Download it in Settings -> ASR Models.",
                contract.display_version,
                missing.join(", ")
            ));
        }
        if !invalid.is_empty() {
            return Some(format!(
                "Parakeet TDT {} artifacts look truncated or corrupt ({}). Re-download the model in Settings -> ASR Models.",
                contract.display_version,
                invalid.join(", ")
            ));
        }
        None
    }

    fn legacy_missing_reason(&self) -> Option<String> {
        let vocab = self.vocab_path();
        if !vocab.exists() {
            return Some(
                "Parakeet tokens.txt is missing. Download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        if !is_valid_tokens_file(&vocab) {
            return Some(
                "Parakeet tokens.txt appears invalid or truncated. Re-download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        let any_present = PARAKEET_LEGACY_ONNX_ALIASES
            .iter()
            .any(|name| self.model_dir.join(name).exists());
        if !any_present {
            return Some(
                "Parakeet encoder.onnx is missing. Download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        if !is_valid_onnx_file(&self.legacy_onnx_path(), 4096) {
            return Some(
                "Parakeet encoder.onnx appears invalid or truncated. Re-download Parakeet artifacts in Settings -> ASR Models."
                    .to_string(),
            );
        }
        None
    }

    fn source_url(&self) -> String {
        let repo = self
            .tdt_contract()
            .map(|contract| contract.repo)
            .unwrap_or(PARAKEET_LEGACY_REPO);
        format!("https://huggingface.co/{}", repo)
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
        Self::new(None)
    }
}

/// Map any stored selection onto one of the two routes that exist.
///
/// The retired `parakeet-ctc-0.6b` / `parakeet-ctc-1.1b` ids fall through to
/// v3 rather than erroring, so a settings file written by an older build keeps
/// working instead of leaving the user with a dead provider.
fn normalize_parakeet_model_id(model_id: &str) -> String {
    match model_id.trim() {
        PARAKEET_V2_MODEL_ID => PARAKEET_V2_MODEL_ID.to_string(),
        PARAKEET_V3_MODEL_ID => PARAKEET_V3_MODEL_ID.to_string(),
        "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => PARAKEET_LEGACY_MODEL_ID.to_string(),
        _ => PARAKEET_V3_MODEL_ID.to_string(),
    }
}

// ---------------------------------------------------------------------------
// TDT inference: mel -> encoder -> greedy TDT decode
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn run_parakeet_tdt(model_dir: &Path, audio_path: &Path, contract: TdtContract) -> Result<String> {
    use crate::audio::mel::MelSpectrogram;
    use ndarray::{Array, IxDyn};
    use ort::value::Tensor;

    let samples = crate::audio::utils::load_audio_file(audio_path).with_context(|| {
        format!(
            "Failed to load audio for Parakeet {}",
            contract.display_version
        )
    })?;
    if samples.is_empty() {
        tracing::warn!(
            "Parakeet {}: audio samples are empty",
            contract.display_version
        );
        return Ok(String::new());
    }

    // The 128-bin NeMo frontend, with per-feature mean/std normalization. The
    // encoder takes mel, not raw audio.
    let spec = MelSpectrogram::parakeet_v3_defaults().compute_normalized(&samples);
    if spec.is_empty() || spec[0].is_empty() {
        tracing::warn!(
            "Parakeet {}: mel spectrogram came back empty",
            contract.display_version
        );
        return Ok(String::new());
    }
    let n_mels = spec.len();
    let n_frames = spec[0].len();
    if n_mels != PARAKEET_TDT_FEAT_DIM {
        return Err(anyhow::anyhow!(
            "Parakeet {} frontend produced {} mel bins, encoder declares {}",
            contract.display_version,
            n_mels,
            PARAKEET_TDT_FEAT_DIM
        ));
    }

    let mut flat: Vec<f32> = Vec::with_capacity(n_mels * n_frames);
    for bin in &spec {
        flat.extend(bin.iter().copied());
    }

    let mut guard = get_or_create_tdt_runtime(model_dir, contract)?;
    let runtime = guard.as_mut().with_context(|| {
        format!(
            "Parakeet {} runtime failed to initialize",
            contract.display_version
        )
    })?;

    let (encoder_out, frames) = {
        let signal =
            Array::from_shape_vec(IxDyn(&[1, n_mels, n_frames]), flat).with_context(|| {
                format!(
                    "Failed to build Parakeet {} mel tensor",
                    contract.display_version
                )
            })?;
        let length =
            Array::from_shape_vec(IxDyn(&[1]), vec![n_frames as i64]).with_context(|| {
                format!(
                    "Failed to build Parakeet {} length tensor",
                    contract.display_version
                )
            })?;

        let encoded = runtime
            .encoder
            .run(ort::inputs![
                "audio_signal" => Tensor::from_array(signal)?,
                "length" => Tensor::from_array(length)?,
            ])
            .map_err(|error| {
                anyhow::anyhow!(
                    "Parakeet {} encoder inference failed: {}",
                    contract.display_version,
                    error
                )
            })?;

        let array = encoded["outputs"]
            .try_extract_array::<f32>()
            .with_context(|| {
                format!(
                    "Failed to extract Parakeet {} encoder outputs",
                    contract.display_version
                )
            })?;
        let shape = array.shape().to_vec();
        if shape.len() != 3 || shape[1] != contract.encoder_dim {
            return Err(anyhow::anyhow!(
                "Unexpected Parakeet {} encoder output shape {:?}, expected [1, {}, frames]",
                contract.display_version,
                shape,
                contract.encoder_dim
            ));
        }

        // The encoder also reports how many of those frames are real. At batch
        // size one there is no padding so the two agree, but trusting the
        // declared length keeps a padded export from decoding trailing garbage.
        let mut frames = shape[2];
        if let Ok(lengths) = encoded["encoded_lengths"].try_extract_array::<i32>() {
            if let Some(declared) = lengths.iter().next().copied() {
                if declared > 0 {
                    frames = frames.min(declared as usize);
                }
            }
        }

        (array.iter().copied().collect::<Vec<f32>>(), frames)
    };

    let token_ids = super::parakeet_tdt::greedy_decode(
        &mut runtime.decoder,
        &mut runtime.joiner,
        &encoder_out,
        contract.encoder_dim,
        frames,
        contract.blank_id,
    )?;
    let text = super::parakeet_tdt::detokenize(&runtime.vocab, &token_ids);

    tracing::info!(
        "Parakeet {} decoded {} frames -> {} tokens, {} chars",
        contract.display_version,
        frames,
        token_ids.len(),
        text.len()
    );
    Ok(text)
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_parakeet_tdt(
    _model_dir: &Path,
    _audio_path: &Path,
    _contract: TdtContract,
) -> Result<String> {
    Err(anyhow::anyhow!(
        "Parakeet ONNX support is not compiled in. Rebuild with the `asr-parakeet` feature."
    ))
}

// ---------------------------------------------------------------------------
// Legacy CTC inference
// ---------------------------------------------------------------------------
#[cfg(feature = "asr-parakeet")]
fn run_parakeet_legacy_ctc(
    onnx_path: &Path,
    vocab_path: &Path,
    audio_path: &Path,
) -> Result<String> {
    use crate::audio::mel::MelSpectrogram;
    use ndarray::{Array, IxDyn};
    use ort::value::Tensor;

    let samples = crate::audio::utils::load_audio_file(audio_path)
        .context("Failed to load audio for Parakeet")?;
    if samples.is_empty() {
        tracing::warn!("Parakeet: audio samples are empty");
        return Ok(String::new());
    }

    let mut cache_guard = get_or_create_legacy_session(onnx_path)?;
    let session = cache_guard
        .as_mut()
        .context("ONNX session not initialized")?;

    // Three export shapes exist in the wild for this graph:
    //   sherpa-onnx        x / x_lens                          (mel)
    //   NeMo processed     processed_signal / ..._length       (mel)
    //   NeMo raw           audio_signal / audio_signal_length  (waveform)
    // plus `audio_signal` + `length`, which is mel despite the name.
    let input_names = session
        .inputs()
        .iter()
        .map(|inp| inp.name().to_string())
        .collect::<Vec<_>>();

    tracing::info!("Parakeet legacy ONNX inputs: {:?}", input_names);

    let has_sherpa_names = input_names.iter().any(|name| name == "x");
    let has_processed_names = input_names.iter().any(|name| name == "processed_signal");
    let has_mel_with_audio_signal_name = input_names.iter().any(|name| name == "audio_signal")
        && input_names.iter().any(|name| name == "length");
    let has_raw_audio_names = input_names.iter().any(|name| name == "audio_signal")
        && input_names.iter().any(|name| name == "audio_signal_length");

    // sherpa-onnx runs with normalize_samples=True.
    let max_val = samples.iter().fold(0.0f32, |acc, &s| acc.max(s.abs()));
    let normalized: Vec<f32> = if max_val > 0.0 {
        samples.iter().map(|s| s / max_val).collect()
    } else {
        samples.to_vec()
    };

    let (data, shape) = if has_sherpa_names || has_processed_names || has_mel_with_audio_signal_name
    {
        // The 110M export is an 80-bin model. v3 declares 128 and runs through
        // `run_parakeet_tdt`, not here.
        let spec = MelSpectrogram::parakeet_defaults().compute_normalized(&normalized);
        if spec.is_empty() || spec[0].is_empty() {
            tracing::warn!("Parakeet: mel spectrogram empty");
            return Ok(String::new());
        }
        let n_mels = spec.len();
        let n_frames = spec[0].len();

        let mut flat: Vec<f32> = Vec::with_capacity(n_frames * n_mels);
        for mel_bin in spec.iter().take(n_mels) {
            flat.extend(mel_bin.iter().take(n_frames).copied());
        }
        let signal_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, n_mels, n_frames]), flat)
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
        } else if has_mel_with_audio_signal_name {
            session
                .run(ort::inputs!["audio_signal" => signal_tensor, "length" => len_tensor])
                .map_err(|error| {
                    anyhow::anyhow!(
                        "Parakeet ONNX inference failed (audio_signal/length mel contract): {}",
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
        let n_samples = normalized.len();
        let signal_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, n_samples]), normalized)
                .context("Failed to build audio signal array")?;
        let len_arr: Array<i64, IxDyn> = Array::from_shape_vec(IxDyn(&[1]), vec![n_samples as i64])
            .context("Failed to build sample length tensor")?;
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

    let vocab = load_token_table(vocab_path)?;
    // CTC blank is the last token for sherpa-onnx/NeMo CTC exports.
    let blank_id = vocab.len().saturating_sub(1);

    let vocab_on_axis_1 = shape[1] == vocab.len();
    let vocab_on_axis_2 = shape[2] == vocab.len();
    let (t_out, vocab_size) = if vocab_on_axis_2 {
        (shape[1], shape[2])
    } else if vocab_on_axis_1 {
        (shape[2], shape[1])
    } else {
        (shape[1], shape[2])
    };

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

    let text = super::parakeet_tdt::detokenize(&vocab, &token_ids);

    tracing::info!(
        "Parakeet legacy CTC decoded: {} timesteps -> {} tokens, {} chars",
        t_out,
        token_ids.len(),
        text.len()
    );

    Ok(text)
}

#[cfg(not(feature = "asr-parakeet"))]
fn run_parakeet_legacy_ctc(
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
        "NVIDIA Parakeet"
    }

    fn description(&self) -> &str {
        if self.is_legacy_model() {
            "NVIDIA Parakeet TDT CTC 110M, native ONNX inference, English, no Python."
        } else if self.model_id == PARAKEET_V2_MODEL_ID {
            "NVIDIA Parakeet TDT 0.6B v2, native ONNX transducer, English, no Python."
        } else {
            "NVIDIA Parakeet TDT 0.6B v3, native ONNX transducer, 25 European languages, no Python."
        }
    }

    fn is_available(&self) -> bool {
        self.has_required_files()
    }

    async fn prewarm(&self) -> Result<()> {
        if let Some(reason) = self.missing_or_invalid_reason() {
            return Err(anyhow::anyhow!(reason));
        }
        if !self.has_trusted_required_files() {
            return Err(anyhow::anyhow!(
                "Parakeet model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            ));
        }

        #[cfg(feature = "asr-parakeet")]
        {
            let is_legacy = self.is_legacy_model();
            let model_dir = self.model_dir.clone();
            let onnx_path = self.legacy_onnx_path();
            tokio::task::spawn_blocking(move || -> Result<()> {
                if is_legacy {
                    drop(get_or_create_legacy_session(&onnx_path)?);
                } else {
                    let contract = if model_dir.ends_with(PARAKEET_V2_MODEL_ID) {
                        PARAKEET_V2
                    } else {
                        PARAKEET_V3
                    };
                    drop(get_or_create_tdt_runtime(&model_dir, contract)?);
                }
                Ok(())
            })
            .await
            .context("Parakeet model warmup task panicked")??;
            return Ok(());
        }

        #[cfg(not(feature = "asr-parakeet"))]
        {
            Err(anyhow::anyhow!(
                "Parakeet support is not compiled into this build."
            ))
        }
    }

    fn model_info(&self) -> ModelInfo {
        if self.is_legacy_model() {
            return ModelInfo {
                name: "Parakeet TDT CTC 110M".to_string(),
                version: "110m".to_string(),
                // model.onnx is 458,161,021 bytes upstream (checked against the
                // `content-length` of the URL in PARAKEET_LEGACY_ONNX_SOURCES);
                // tokens.txt adds a few KB. The long-standing 170.0 here was a
                // guess and understated the download by 2.6x.
                size_mb: 437.0,
                parameters: "110M".to_string(),
                languages: vec!["en".to_string()],
                word_error_rate: Some(6.05),
                real_time_factor: Some(0.7),
                license: "CC-BY-4.0".to_string(),
                source_url: self.source_url(),
            };
        }

        if self.model_id == PARAKEET_V2_MODEL_ID {
            return ModelInfo {
                name: "Parakeet TDT 0.6B v2".to_string(),
                version: "0.6b-v2".to_string(),
                // The four pinned int8 artifacts total 661,190,513 bytes.
                size_mb: 630.6,
                parameters: "600M".to_string(),
                languages: vec!["en".to_string()],
                // Keep benchmark fields empty until this exact ONNX export is
                // measured in Plainsong on the supported Apple Silicon lane.
                word_error_rate: None,
                real_time_factor: None,
                license: "CC-BY-4.0".to_string(),
                source_url: self.source_url(),
            };
        }

        ModelInfo {
            name: "Parakeet TDT 0.6B v3".to_string(),
            version: "0.6b-v3".to_string(),
            // The four int8 artifacts total 670,478,772 bytes on disk.
            size_mb: 639.4,
            parameters: "600M".to_string(),
            languages: vec![
                "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv",
                "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            word_error_rate: Some(4.5),
            real_time_factor: Some(1.2),
            license: "CC-BY-4.0".to_string(),
            source_url: self.source_url(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if let Some(reason) = self.missing_or_invalid_reason() {
            return Err(anyhow::anyhow!(reason));
        }
        if !self.has_trusted_required_files() {
            return Err(anyhow::anyhow!(
                "Parakeet model files have not passed Plainsong integrity verification. Re-download the model from Settings."
            ));
        }
        let start = std::time::Instant::now();
        let audio_path_owned = audio_path.to_path_buf();
        let audio_path_for_dur = audio_path_owned.clone();

        let text = if self.is_legacy_model() {
            let onnx_path = self.legacy_onnx_path();
            let vocab_path = self.vocab_path();
            tokio::task::spawn_blocking(move || {
                run_parakeet_legacy_ctc(&onnx_path, &vocab_path, &audio_path_owned)
            })
            .await
            .context("Parakeet legacy inference task panicked")??
        } else {
            let model_dir = self.model_dir.clone();
            let contract = self
                .tdt_contract()
                .expect("non-legacy Parakeet models have a TDT contract");
            tokio::task::spawn_blocking(move || {
                run_parakeet_tdt(&model_dir, &audio_path_owned, contract)
            })
            .await
            .context("Parakeet TDT inference task panicked")??
        };

        tracing::info!(
            "Parakeet transcription complete: model={}, {} chars in {}ms",
            self.model_id,
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
            language: self.result_language().to_string(),
            confidence: 0.88,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: self.model_id.clone(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::Parakeet,
            actual_provider: AsrProviderType::Parakeet,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            speaker_turns: Vec::new(),
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path = std::env::temp_dir().join(format!("parakeet_{}.wav", uuid::Uuid::new_v4()));
        let temp = crate::recording_audio::write_secure_temporary_audio(&temp_path, audio_data)
            .context("failed to write temp wav for Parakeet")?;
        self.transcribe(temp.path()).await
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

        if self.is_legacy_model() {
            return download_legacy(&manager, &self.model_dir, progress_cb).await;
        }
        download_tdt(
            &manager,
            &self.model_dir,
            self.tdt_contract()
                .expect("non-legacy Parakeet models have a TDT contract"),
            progress_cb,
        )
        .await
    }
}

/// Fetch the four v3 artifacts, weighting progress by real file size so the bar
/// does not sit at 25% for the entire 622 MB encoder.
async fn download_tdt(
    manager: &crate::download::DownloadManager,
    model_dir: &Path,
    contract: TdtContract,
    progress_cb: std::sync::Arc<Box<dyn Fn(f32) + Send + Sync>>,
) -> Result<()> {
    let total_bytes: u64 = contract.artifacts.iter().map(|(_, size, _)| *size).sum();
    let mut completed_bytes: u64 = 0;

    for &(file_name, expected_bytes, _) in contract.artifacts {
        let destination = model_dir.join(file_name);
        let sha256 = tdt_sha256(contract, file_name)
            .expect("every Parakeet TDT artifact has a pinned digest");
        if crate::download::is_model_artifact_trusted(&destination, Some(sha256)) {
            completed_bytes += expected_bytes;
            progress_cb((completed_bytes as f32 / total_bytes as f32) * 100.0);
            continue;
        }

        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            contract.repo, contract.revision, file_name
        );
        let cb = progress_cb.clone();
        let base = completed_bytes as f32;
        let total = total_bytes as f32;
        let share = expected_bytes as f32;
        manager
            .download_verified_model_asset(
                &url,
                &destination,
                Some(sha256),
                expected_bytes.saturating_mul(2),
                move |p| {
                    let done = base + share * (p.percentage as f32 / 100.0);
                    cb((done / total) * 100.0);
                },
            )
            .await
            .with_context(|| {
                format!(
                    "Failed to download Parakeet {} {file_name}",
                    contract.display_version
                )
            })?;

        let ok = if file_name == PARAKEET_VOCAB_FILE {
            is_valid_tokens_file(&destination)
        } else {
            is_valid_onnx_file(&destination, tdt_min_bytes(contract, file_name))
        };
        if !ok {
            std::fs::remove_file(&destination).ok();
            return Err(anyhow::anyhow!(
                "Downloaded Parakeet {} {} from {} but the artifact is invalid or truncated. Re-try the download.",
                contract.display_version,
                file_name,
                url
            ));
        }

        completed_bytes += expected_bytes;
        progress_cb((completed_bytes as f32 / total_bytes as f32) * 100.0);
    }

    tracing::info!(
        "Parakeet TDT {} model downloaded to {}",
        contract.display_version,
        model_dir.display()
    );
    Ok(())
}

async fn download_legacy(
    manager: &crate::download::DownloadManager,
    model_dir: &Path,
    progress_cb: std::sync::Arc<Box<dyn Fn(f32) + Send + Sync>>,
) -> Result<()> {
    let onnx_dest = model_dir.join(PARAKEET_LEGACY_ONNX_FILE);
    let vocab_dest = model_dir.join(PARAKEET_VOCAB_FILE);

    if onnx_dest.exists() && !is_valid_onnx_file(&onnx_dest, 4096) {
        std::fs::remove_file(&onnx_dest).ok();
    }
    if vocab_dest.exists() && !is_valid_tokens_file(&vocab_dest) {
        std::fs::remove_file(&vocab_dest).ok();
    }

    if !crate::download::is_model_artifact_trusted(
        &onnx_dest,
        Some(PARAKEET_LEGACY_ONNX_SOURCES[0].1),
    ) {
        let mut last_error = None;
        for (source, sha256) in PARAKEET_LEGACY_ONNX_SOURCES {
            let cb = progress_cb.clone();
            match manager
                .download_verified_model_asset(
                    source,
                    &onnx_dest,
                    Some(sha256),
                    PARAKEET_LEGACY_ONNX_MAX_BYTES,
                    move |p| {
                        cb(p.percentage as f32 * 0.95);
                    },
                )
                .await
            {
                Ok(_) if is_valid_onnx_file(&onnx_dest, 4096) => {
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

    if !crate::download::is_model_artifact_trusted(
        &vocab_dest,
        Some(PARAKEET_LEGACY_TOKENS_SOURCES[0].1),
    ) {
        let mut last_error = None;
        for (source, sha256) in PARAKEET_LEGACY_TOKENS_SOURCES {
            let cb = progress_cb.clone();
            match manager
                .download_verified_model_asset(
                    source,
                    &vocab_dest,
                    Some(sha256),
                    PARAKEET_LEGACY_TOKENS_MAX_BYTES,
                    move |p| {
                        cb(95.0 + p.percentage as f32 * 0.05);
                    },
                )
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

    tracing::info!("Parakeet legacy CTC model downloaded successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "plainsong-parakeet-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp models root");
        root
    }

    /// A file that *reports* `len` bytes without occupying them.
    ///
    /// The encoder's floor is 64 MB, so a test that actually wrote a passing
    /// stand-in would move 64 MB of zeros to disk on every run. `set_len` gives
    /// the same `metadata().len()` and the same leading bytes (zeros, which are
    /// neither `<` nor `{`) for free.
    fn sparse_file(path: &Path, len: u64) {
        let file = std::fs::File::create(path).expect("create sparse file");
        file.set_len(len).expect("set sparse length");
    }

    /// A `tokens.txt` that passes validation: `<piece> <id>` per line.
    fn token_file_body(count: usize) -> String {
        (0..count).map(|id| format!("piece{id} {id}\n")).collect()
    }

    #[test]
    fn v3_is_the_default_v2_is_preserved_and_retired_python_ids_fall_back() {
        // `parakeet-ctc-0.6b` and `parakeet-ctc-1.1b` were the managed-Python
        // routes. A settings file still naming one must land on a route that
        // can actually run, not on a dead provider.
        for stored in [
            "",
            "parakeet-ctc-0.6b",
            "parakeet-ctc-1.1b",
            "something-else",
        ] {
            assert_eq!(
                normalize_parakeet_model_id(stored),
                PARAKEET_V3_MODEL_ID,
                "stored id {stored:?} should resolve to v3"
            );
        }
        assert_eq!(
            normalize_parakeet_model_id(PARAKEET_V2_MODEL_ID),
            PARAKEET_V2_MODEL_ID
        );
        assert_eq!(
            normalize_parakeet_model_id("parakeet-tdt-ctc-110m"),
            PARAKEET_LEGACY_MODEL_ID
        );
        assert_eq!(
            normalize_parakeet_model_id("parakeet-legacy-110m"),
            PARAKEET_LEGACY_MODEL_ID
        );
    }

    #[test]
    fn v3_route_reports_not_downloaded_when_the_directory_is_empty() {
        let root = temp_root("v3-empty");
        let provider = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));

        assert!(!provider.is_available());
        assert_eq!(provider.download_status(), DownloadStatus::NotDownloaded);

        let reason = provider
            .missing_or_invalid_reason()
            .expect("empty model dir must produce a reason");
        // The message has to name what is missing; "not downloaded" alone
        // leaves a user with a half-fetched bundle no way to tell what to fix.
        for expected in [
            PARAKEET_TDT_ENCODER_FILE,
            PARAKEET_TDT_DECODER_FILE,
            PARAKEET_TDT_JOINER_FILE,
            PARAKEET_VOCAB_FILE,
        ] {
            assert!(
                reason.contains(expected),
                "reason {reason:?} should name {expected}"
            );
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn v3_route_reports_the_one_file_that_is_missing() {
        let root = temp_root("v3-partial");
        let model_dir = root.join("parakeet").join(PARAKEET_V3_MODEL_ID);
        std::fs::create_dir_all(&model_dir).expect("create model dir");

        // Everything but the joiner, at plausible sizes.
        for file_name in [PARAKEET_TDT_ENCODER_FILE, PARAKEET_TDT_DECODER_FILE] {
            sparse_file(
                &model_dir.join(file_name),
                tdt_min_bytes(PARAKEET_V3, file_name) + 1,
            );
        }
        std::fs::write(model_dir.join(PARAKEET_VOCAB_FILE), token_file_body(64))
            .expect("write tokens");

        let provider = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));
        let reason = provider
            .missing_or_invalid_reason()
            .expect("missing joiner must produce a reason");
        assert!(reason.contains(PARAKEET_TDT_JOINER_FILE), "got {reason:?}");
        assert!(
            !reason.contains(PARAKEET_TDT_ENCODER_FILE),
            "got {reason:?}"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_truncated_v3_encoder_is_rejected_rather_than_handed_to_onnx_runtime() {
        let root = temp_root("v3-truncated");
        let model_dir = root.join("parakeet").join(PARAKEET_V3_MODEL_ID);
        std::fs::create_dir_all(&model_dir).expect("create model dir");

        // 8 KB clears the generic "not an HTML error page" check but is
        // nowhere near a 622 MB encoder.
        std::fs::write(
            model_dir.join(PARAKEET_TDT_ENCODER_FILE),
            vec![0x08u8; 8192],
        )
        .expect("write truncated encoder");
        for file_name in [PARAKEET_TDT_DECODER_FILE, PARAKEET_TDT_JOINER_FILE] {
            sparse_file(
                &model_dir.join(file_name),
                tdt_min_bytes(PARAKEET_V3, file_name) + 1,
            );
        }
        std::fs::write(model_dir.join(PARAKEET_VOCAB_FILE), token_file_body(64))
            .expect("write tokens");

        let provider = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));
        let reason = provider
            .missing_or_invalid_reason()
            .expect("truncated encoder must produce a reason");
        assert!(reason.contains("truncated"), "got {reason:?}");
        assert!(reason.contains(PARAKEET_TDT_ENCODER_FILE), "got {reason:?}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn v3_does_not_claim_english_for_audio_it_cannot_identify() {
        // The v3 route advertises 25 languages, so stamping every transcript
        // `en` would persist and export German or French audio as English.
        // There is no language head in the export, so the honest answer is
        // "nothing", which downstream reads as "not detected".
        let root = temp_root("language-claim");

        let v3 = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));
        assert_eq!(v3.result_language(), "");
        assert!(
            v3.model_info().languages.len() > 1,
            "v3 advertises more than one language, which is why it must not assert one"
        );

        // The 110M export really is English-only, so `en` there is a fact.
        let legacy = ParakeetProvider::with_models_root(&root, Some(PARAKEET_LEGACY_MODEL_ID));
        assert_eq!(legacy.result_language(), "en");
        assert_eq!(legacy.model_info().languages, vec!["en".to_string()]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_route_accepts_either_graph_filename() {
        // `scripts/provision-asr-assets.mjs` and `asr/manager.rs` diagnostics
        // both use `encoder.onnx`; older in-app downloads wrote `model.onnx`.
        // Accepting only one is how diagnostics ended up reporting Ready for a
        // model transcription could not find.
        let tokens = token_file_body(64);

        for graph_name in ["encoder.onnx", "model.onnx"] {
            let root = temp_root("legacy");
            let model_dir = root.join("parakeet");
            std::fs::create_dir_all(&model_dir).expect("create model dir");
            std::fs::write(model_dir.join(graph_name), vec![0x08u8; 8192]).expect("write graph");
            std::fs::write(model_dir.join(PARAKEET_VOCAB_FILE), &tokens).expect("write tokens");

            let provider =
                ParakeetProvider::with_models_root(&root, Some(PARAKEET_LEGACY_MODEL_ID));
            assert!(
                provider.is_available(),
                "legacy route should accept {graph_name}"
            );
            assert_eq!(provider.legacy_onnx_path(), model_dir.join(graph_name));

            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn legacy_and_v3_do_not_share_a_directory() {
        // v3 lives in a subdirectory of the legacy model dir. If they collided,
        // downloading one would appear to satisfy the other.
        let root = temp_root("dirs");
        let legacy = ParakeetProvider::with_models_root(&root, Some(PARAKEET_LEGACY_MODEL_ID));
        let v3 = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));
        let v2 = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V2_MODEL_ID));

        assert_eq!(legacy.model_dir, root.join("parakeet"));
        assert_eq!(
            v3.model_dir,
            root.join("parakeet").join(PARAKEET_V3_MODEL_ID)
        );
        assert_ne!(legacy.model_dir, v3.model_dir);
        assert_eq!(
            v2.model_dir,
            root.join("parakeet").join(PARAKEET_V2_MODEL_ID)
        );
        assert_ne!(v2.model_dir, v3.model_dir);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn token_table_is_indexed_by_declared_id_not_line_order() {
        let root = temp_root("tokens");
        let path = root.join("tokens.txt");
        // Deliberately out of order, and with a piece containing a space so a
        // left-split parser would mangle it.
        std::fs::write(&path, "c 2\na 0\nb 1\n<blk> 4\n").expect("write tokens");

        let table = load_token_table(&path).expect("load");
        assert_eq!(table.len(), 5);
        assert_eq!(table[0], "a");
        assert_eq!(table[1], "b");
        assert_eq!(table[2], "c");
        assert_eq!(table[3], "", "gap ids stay empty rather than shifting");
        assert_eq!(table[4], "<blk>");

        std::fs::remove_dir_all(&root).ok();
    }

    /// The production route, end to end, against the real export.
    ///
    /// `parakeet_tdt.rs` has its own ignored test that drives the decoder
    /// directly. This one goes through `ParakeetProvider::transcribe`, so it is
    /// the wiring — model directory layout, artifact validation, session
    /// construction, the 128-bin frontend, the encoder contract — that is under
    /// test, not just the decoder. That wiring is exactly what was missing
    /// before: a proven decoder with no caller.
    ///
    /// Ignored by default because it needs the ~639 MB bundle. Run with:
    ///
    /// ```text
    /// PLAINSONG_MODELS_ROOT="$HOME/Library/Application Support/Plainsong/models" \
    ///   cargo test --lib parakeet_v3_provider -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn parakeet_v3_provider_transcribes_the_shipped_clip() {
        let Ok(root) = std::env::var("PLAINSONG_MODELS_ROOT") else {
            eprintln!("PLAINSONG_MODELS_ROOT not set; skipping");
            return;
        };
        let root = PathBuf::from(root);
        let provider = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V3_MODEL_ID));

        assert!(
            provider.is_available(),
            "model not present at {}: {:?}",
            provider.model_dir.display(),
            provider.missing_or_invalid_reason()
        );
        assert_eq!(provider.download_status(), DownloadStatus::Downloaded);

        let wav = provider.model_dir.join("test_wavs").join("en.wav");
        let result = provider.transcribe(&wav).await.expect("transcribe");

        eprintln!("[en] {}", result.text);
        // Pinned exactly. A transducer whose duration head is mis-read still
        // emits fluent text, so "not empty" would prove almost nothing.
        assert_eq!(
            result.text,
            "Ask not what your country can do for you. Ask what you can do for your country."
        );
        assert_eq!(result.model_id, PARAKEET_V3_MODEL_ID);
        assert_eq!(result.actual_engine.as_deref(), Some("provider_default"));
    }

    #[test]
    fn v3_artifact_list_matches_the_upstream_repo_layout() {
        // These four names are what the download manager fetches and what
        // validation looks for. If they drift apart the provider advertises a
        // model it cannot load.
        let names: Vec<&str> = PARAKEET_V3_ARTIFACTS.iter().map(|(n, _, _)| *n).collect();
        assert_eq!(
            names,
            vec![
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt"
            ]
        );
        // Every floor must sit below the real file, or a correct download is
        // rejected as corrupt.
        for (name, upstream, minimum) in PARAKEET_V3_ARTIFACTS {
            assert!(
                minimum < upstream,
                "{name}: floor {minimum} must be below upstream size {upstream}"
            );
        }
        assert_eq!(tdt_min_bytes(PARAKEET_V3, "unknown.onnx"), 4096);
        assert_eq!(PARAKEET_V3_REVISION.len(), 40);
        assert!(PARAKEET_LEGACY_ONNX_SOURCES[0]
            .0
            .contains("/resolve/3af92f152d32c836acabf38f4c993bc96b80eb2d/"));
        for (name, _, _) in PARAKEET_V3_ARTIFACTS {
            assert_eq!(v3_sha256(name).expect("pinned v3 digest").len(), 64);
        }
    }

    #[test]
    fn v2_contract_is_pinned_and_english_only() {
        let names: Vec<&str> = PARAKEET_V2_ARTIFACTS
            .iter()
            .map(|(name, _, _)| *name)
            .collect();
        assert_eq!(
            names,
            vec![
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt"
            ]
        );
        assert_eq!(PARAKEET_V2_REVISION.len(), 40);
        assert_eq!(PARAKEET_V2.blank_id, 1024);
        assert_eq!(PARAKEET_V2.encoder_dim, 1024);
        for (name, upstream, minimum) in PARAKEET_V2_ARTIFACTS {
            assert!(minimum < upstream, "{name}: invalid size floor");
            assert_eq!(v2_sha256(name).expect("pinned v2 digest").len(), 64);
        }

        let root = temp_root("v2-contract");
        let provider = ParakeetProvider::with_models_root(&root, Some(PARAKEET_V2_MODEL_ID));
        assert_eq!(provider.model_info().languages, vec!["en".to_string()]);
        assert_eq!(provider.result_language(), "en");
        assert!(provider.source_url().contains(PARAKEET_V2_REPO));
        std::fs::remove_dir_all(&root).ok();
    }
}
