//! Built-in text embedding models for meaning search.
//!
//! Plainsong downloads these itself from pinned Hugging Face revisions,
//! verifies every file by SHA-256, and runs them in-process through ONNX
//! Runtime on the CPU. Nothing is sent anywhere: the transcript text, the
//! question and the vectors stay on the Mac. Ollama remains an optional route
//! for people who want to bring their own embedding model.
//!
//! Which three, and why, is measured in
//! `artifacts/continuation-2026-10-20/opus-embeddings/`: 124 hand-written
//! questions and 2,423 annotator summary sentences over 98 hours of AMI
//! meetings, and 44 questions over dictation-style notes, indexed the way
//! this app indexes and run through ONNX Runtime 1.28, the version linked
//! here.

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// How a model turns token states into one vector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pooling {
    /// The graph already pools, projects and normalizes into
    /// `sentence_embedding`.
    SentenceOutput,
    /// The last real token's state; inputs are left-padded.
    LastToken,
}

/// One pinned file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct EmbeddingArtifact {
    pub repo: &'static str,
    pub revision: &'static str,
    pub hf_path: &'static str,
    pub local_name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

#[derive(Debug)]
#[cfg_attr(
    not(feature = "local-embeddings"),
    expect(
        dead_code,
        reason = "pooling, width and token limit are read only by the ONNX runtime, which this build leaves out"
    )
)]
pub(crate) struct BuiltinEmbeddingModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub vendor: &'static str,
    /// One line for Settings, printed as it is: how often it found the
    /// answer in Plainsong's meeting test and what it costs. Licence terms are
    /// left to the terms note below the picker.
    pub summary: &'static str,
    pub languages: &'static str,
    pub license: &'static str,
    /// Where the terms the weights come under can be read in full.
    pub terms_url: &'static str,
    /// A use policy the model's publisher asks deployments to follow, shown
    /// beside the model.
    pub use_policy_url: Option<&'static str>,
    /// Whether the user must accept `terms_url` and the use policy before the
    /// weights download or run. Enforced here, not only in the UI.
    pub requires_terms_acceptance: bool,
    /// Text the terms require to travel with the weights. Written to a
    /// `NOTICE` file beside them when they are downloaded.
    pub notice: Option<&'static str>,
    pub dimensions: usize,
    pub pooling: Pooling,
    pub query_prefix: &'static str,
    pub document_prefix: &'static str,
    /// Inputs are cut to this many tokens. Index windows are about a hundred
    /// words, so nothing the app indexes reaches it.
    pub max_tokens: usize,
    pub graph: &'static str,
    /// The external weights file the graph names, when it has one.
    pub external_data: Option<&'static str>,
    pub tokenizer: &'static str,
    pub artifacts: &'static [EmbeddingArtifact],
}

impl BuiltinEmbeddingModel {
    pub(crate) fn download_bytes(&self) -> u64 {
        self.artifacts.iter().map(|entry| entry.size_bytes).sum()
    }

    #[cfg(any(feature = "local-embeddings", test))]
    fn pin(&self, local_name: &str) -> Result<&'static EmbeddingArtifact> {
        self.artifacts
            .iter()
            .find(|entry| entry.local_name == local_name)
            .ok_or_else(|| anyhow::anyhow!("Missing integrity pin for {local_name}"))
    }
}

pub(crate) const MODEL_DIR_NAME: &str = "text_embeddings";

/// The default for new installs: Apache-2.0, so it needs no terms beyond
/// the licence, and within two points of the best in Plainsong's test.
pub(crate) const DEFAULT_MODEL_ID: &str = "embeddinggemma-2";

const GEMMA_TERMS_URL: &str = "https://ai.google.dev/gemma/terms";
const GEMMA_PROHIBITED_USE_URL: &str = "https://ai.google.dev/gemma/prohibited_use_policy";

/// The notice the Gemma Terms of Use (section 3.1) require with a copy of
/// the weights, the statement that the files are modified, and where the
/// terms and their use restrictions are.
const GEMMA_NOTICE: &str = "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms\n\nThese files are a modified version of EmbeddingGemma 300M by Google: onnx-community converted Google's weights to ONNX and quantized them to 8 bits (huggingface.co/onnx-community/embeddinggemma-300m-ONNX). Plainsong downloads those files unchanged and does not modify them further.\n\nUse is subject to the Gemma Terms of Use (https://ai.google.dev/gemma/terms), including the use restrictions in section 3.2 and the Gemma Prohibited Use Policy (https://ai.google.dev/gemma/prohibited_use_policy). Plainsong downloads these files only after you accept those terms.";

/// Apache-2.0 asks for no notice file, but the files are a converted copy and
/// Google's model card asks deployments to follow the Gemma Prohibited Use
/// Policy, so both travel with the weights.
const GEMMA2_NOTICE: &str = "EmbeddingGemma 2 by Google is licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).\n\nThese files are onnx-community's ONNX export of Google's weights, quantized to 8 bits (huggingface.co/onnx-community/embeddinggemma-2-ONNX). Plainsong downloads them unchanged.\n\nGoogle's model card asks that deployments adhere to the Gemma Prohibited Use Policy: https://ai.google.dev/gemma/prohibited_use_policy";

const GEMMA_REPO: &str = "onnx-community/embeddinggemma-300m-ONNX";
const GEMMA_REVISION: &str = "5090578d9565bb06545b4552f76e6bc2c93e4a66";
const QWEN_REPO: &str = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const QWEN_REVISION: &str = "c25a394dd583836952667c12f008335071b3f43d";
const GEMMA2_REPO: &str = "onnx-community/embeddinggemma-2-ONNX";
const GEMMA2_REVISION: &str = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/// The built-in search models, the default first. Digests are the Hugging Face LFS
/// sha256 of each file at the pinned revision and are re-verified on every
/// download and load.
pub(crate) const MODELS: &[BuiltinEmbeddingModel] = &[
    BuiltinEmbeddingModel {
        id: "embeddinggemma-2",
        display_name: "EmbeddingGemma 2",
        vendor: "Google",
        summary: "In an October 2026 English test of 124 questions over selected meetings, meaning search returned a relevant passage in the top five for 75.0%, against 53.2% for word matching.",
        languages: "English and 100+ other languages",
        license: "Apache-2.0",
        terms_url: "https://www.apache.org/licenses/LICENSE-2.0",
        use_policy_url: Some(GEMMA_PROHIBITED_USE_URL),
        requires_terms_acceptance: false,
        notice: Some(GEMMA2_NOTICE),
        dimensions: 768,
        pooling: Pooling::SentenceOutput,
        query_prefix: "task: search result | query: ",
        document_prefix: "title: none | text: ",
        max_tokens: 512,
        graph: "model_quantized.onnx",
        external_data: Some("model_quantized.onnx_data"),
        tokenizer: "tokenizer.json",
        artifacts: &[
            EmbeddingArtifact {
                repo: GEMMA2_REPO,
                revision: GEMMA2_REVISION,
                hf_path: "onnx/model_quantized.onnx",
                local_name: "model_quantized.onnx",
                sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953",
                size_bytes: 495_165,
            },
            EmbeddingArtifact {
                repo: GEMMA2_REPO,
                revision: GEMMA2_REVISION,
                hf_path: "onnx/model_quantized.onnx_data",
                local_name: "model_quantized.onnx_data",
                sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b",
                size_bytes: 313_724_928,
            },
            EmbeddingArtifact {
                repo: GEMMA2_REPO,
                revision: GEMMA2_REVISION,
                hf_path: "tokenizer.json",
                local_name: "tokenizer.json",
                sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
                size_bytes: 32_170_510,
            },
        ],
    },
    BuiltinEmbeddingModel {
        id: "embeddinggemma-300m",
        display_name: "EmbeddingGemma 300M",
        vendor: "Google",
        summary: "In the same October 2026 English test of 124 questions over selected meetings, meaning search returned a relevant passage in the top five for 77.4%. You accept the Gemma Terms of Use before it downloads.",
        languages: "English and 100+ other languages",
        license: "Gemma Terms of Use",
        terms_url: GEMMA_TERMS_URL,
        use_policy_url: Some(GEMMA_PROHIBITED_USE_URL),
        requires_terms_acceptance: true,
        notice: Some(GEMMA_NOTICE),
        dimensions: 768,
        pooling: Pooling::SentenceOutput,
        query_prefix: "task: search result | query: ",
        document_prefix: "title: none | text: ",
        max_tokens: 512,
        graph: "model_quantized.onnx",
        external_data: Some("model_quantized.onnx_data"),
        tokenizer: "tokenizer.json",
        artifacts: &[
            EmbeddingArtifact {
                repo: GEMMA_REPO,
                revision: GEMMA_REVISION,
                hf_path: "onnx/model_quantized.onnx",
                local_name: "model_quantized.onnx",
                sha256: "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8",
                size_bytes: 567_874,
            },
            EmbeddingArtifact {
                repo: GEMMA_REPO,
                revision: GEMMA_REVISION,
                hf_path: "onnx/model_quantized.onnx_data",
                local_name: "model_quantized.onnx_data",
                sha256: "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0",
                size_bytes: 308_890_624,
            },
            EmbeddingArtifact {
                repo: GEMMA_REPO,
                revision: GEMMA_REVISION,
                hf_path: "tokenizer.json",
                local_name: "tokenizer.json",
                sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47",
                size_bytes: 20_323_312,
            },
        ],
    },
    BuiltinEmbeddingModel {
        id: "qwen3-embedding-0.6b",
        display_name: "Qwen3 Embedding 0.6B",
        vendor: "Qwen",
        summary: "In the same October 2026 English test of 124 questions over selected meetings, meaning search returned a relevant passage in the top five for 71.0%. Larger download and slower indexing than the default in that test.",
        languages: "English and 100+ other languages",
        license: "Apache-2.0",
        terms_url: "https://www.apache.org/licenses/LICENSE-2.0",
        use_policy_url: None,
        requires_terms_acceptance: false,
        notice: None,
        dimensions: 1024,
        pooling: Pooling::LastToken,
        query_prefix: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
        document_prefix: "",
        max_tokens: 512,
        graph: "model_int8.onnx",
        external_data: None,
        tokenizer: "tokenizer.json",
        artifacts: &[
            EmbeddingArtifact {
                repo: QWEN_REPO,
                revision: QWEN_REVISION,
                hf_path: "onnx/model_int8.onnx",
                local_name: "model_int8.onnx",
                sha256: "6d0ea863f78b4a84afa3c7fcba1ec341572b5e28121aef77b7092b1dfdf679c7",
                size_bytes: 613_527_539,
            },
            EmbeddingArtifact {
                repo: QWEN_REPO,
                revision: QWEN_REVISION,
                hf_path: "tokenizer.json",
                local_name: "tokenizer.json",
                sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a",
                size_bytes: 11_423_705,
            },
        ],
    },
];

pub(crate) fn model(id: &str) -> Option<&'static BuiltinEmbeddingModel> {
    MODELS.iter().find(|model| model.id == id)
}

/// The model a setting names, or the default when the setting names none
/// this build knows.
pub(crate) fn model_or_default(id: &str) -> &'static BuiltinEmbeddingModel {
    model(id).unwrap_or_else(|| model(DEFAULT_MODEL_ID).expect("the default model is listed"))
}

/// Whether the user may download and run `model`: always for a model whose
/// licence asks for no acceptance, otherwise only with a recorded acceptance
/// of the terms this build shows for it.
pub(crate) fn terms_accepted(
    model: &BuiltinEmbeddingModel,
    acceptances: &[crate::settings::EmbeddingTermsAcceptance],
) -> bool {
    !model.requires_terms_acceptance
        || acceptances
            .iter()
            .any(|entry| entry.model_id == model.id && entry.terms_url == model.terms_url)
}

/// Whether this build can run the built-in models at all.
pub(crate) const fn runtime_compiled() -> bool {
    cfg!(feature = "local-embeddings")
}

pub(crate) fn models_root() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("Plainsong").join("models"))
}

pub(crate) fn model_dir(models_root: &Path, model: &BuiltinEmbeddingModel) -> PathBuf {
    models_root.join(MODEL_DIR_NAME).join(model.id)
}

/// Every pinned file is present and this session has not found it wrong.
pub(crate) fn artifacts_installed(models_root: &Path, model: &BuiltinEmbeddingModel) -> bool {
    let dir = model_dir(models_root, model);
    model.artifacts.iter().all(|entry| {
        crate::download::is_model_artifact_installed(
            &dir.join(entry.local_name),
            Some(entry.sha256),
        )
    })
}

pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    MODELS
        .iter()
        .flat_map(|model| {
            let dir = model_dir(models_root, model);
            model
                .artifacts
                .iter()
                .map(move |entry| (dir.join(entry.local_name), entry.sha256.to_string()))
        })
        .collect()
}

static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_CANCEL: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Stop a running search-model download. Files already verified stay; the
/// one in flight is discarded by the download path.
pub(crate) fn cancel_download() {
    if download_active() {
        DOWNLOAD_CANCELLED.store(true, Ordering::Release);
        DOWNLOAD_CANCEL.notify_waiters();
    }
}

pub(crate) fn download_active() -> bool {
    DOWNLOAD_ACTIVE.load(Ordering::Acquire)
}

struct DownloadClaim;
impl Drop for DownloadClaim {
    fn drop(&mut self) {
        DOWNLOAD_ACTIVE.store(false, Ordering::Release);
    }
}

/// Fetch every pinned file through the app's verified download path.
/// `progress` receives 0..=100 weighted by file size.
pub(crate) async fn download(
    models_root: &Path,
    model: &'static BuiltinEmbeddingModel,
    acceptances: &[crate::settings::EmbeddingTermsAcceptance],
    progress: impl Fn(f32) + Send + Sync + 'static,
) -> Result<()> {
    if !terms_accepted(model, acceptances) {
        anyhow::bail!(
            "{} downloads only after you accept the Gemma Terms of Use and the Gemma Prohibited Use Policy in Settings.",
            model.display_name
        );
    }
    if !runtime_compiled() {
        anyhow::bail!("This build of Plainsong cannot run built-in search models.");
    }
    if DOWNLOAD_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        anyhow::bail!("A search model is already downloading.");
    }
    let _claim = DownloadClaim;
    DOWNLOAD_CANCELLED.store(false, Ordering::Release);
    let dir = model_dir(models_root, model);
    tokio::fs::create_dir_all(&dir).await?;
    let manager = crate::download::DownloadManager::new()?;
    let progress = std::sync::Arc::new(progress);
    let total = model.download_bytes().max(1) as f64;
    let mut completed = 0_u64;
    for entry in model.artifacts {
        let destination = dir.join(entry.local_name);
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            entry.repo, entry.revision, entry.hf_path
        );
        let callback = progress.clone();
        let base = completed as f64;
        let share = entry.size_bytes as f64;
        // Register for the cancel signal before reading the flag, so a cancel
        // between files or during this one is never missed.
        let cancelled = DOWNLOAD_CANCEL.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        if DOWNLOAD_CANCELLED.load(Ordering::Acquire) {
            anyhow::bail!("{DOWNLOAD_CANCELLED_MESSAGE}");
        }
        tokio::select! {
            result = manager.download_verified_model_asset(
                &url,
                &destination,
                Some(entry.sha256),
                entry.size_bytes.saturating_add(1024 * 1024),
                move |update| {
                    let fraction = (update.percentage / 100.0).clamp(0.0, 1.0);
                    callback((((base + share * fraction) / total) * 100.0) as f32);
                },
            ) => { result?; }
            _ = &mut cancelled => { anyhow::bail!("{DOWNLOAD_CANCELLED_MESSAGE}"); }
        }
        completed = completed.saturating_add(entry.size_bytes);
        progress(((completed as f64 / total) * 100.0) as f32);
    }
    if let Some(notice) = model.notice {
        tokio::fs::write(dir.join("NOTICE"), format!("{notice}\n")).await?;
    }
    tracing::info!("{} downloaded to {}", model.display_name, dir.display());
    Ok(())
}

pub(crate) const DOWNLOAD_CANCELLED_MESSAGE: &str = "The search model download was cancelled.";

/// Remove the model's files and drop a resident copy. Waits for the runtime
/// gate, so it never unloads a model mid-batch, and does the unload and the
/// file removal on a blocking thread.
pub(crate) async fn delete(
    models_root: &Path,
    model: &'static BuiltinEmbeddingModel,
) -> Result<()> {
    if download_active() {
        anyhow::bail!("Wait for the search model download to finish, or cancel it, first.");
    }
    let gate = super::local_model_load::acquire_cleanup_gate().await?;
    let dir = model_dir(models_root, model);
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _gate = gate;
        clear_resident_if(model.id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| anyhow::anyhow!("Removing the search model stopped: {error}"))?
}

/// Whether text is a question being asked or a passage being indexed. Most
/// of these models were trained with different prefixes for the two.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TextRole {
    Query,
    Document,
}

#[cfg(any(feature = "local-embeddings", test))]
pub(crate) fn prepared_text(model: &BuiltinEmbeddingModel, role: TextRole, text: &str) -> String {
    let prefix = match role {
        TextRole::Query => model.query_prefix,
        TextRole::Document => model.document_prefix,
    };
    format!("{prefix}{}", text.trim())
}

/// One job's use of a built-in search model: a search, or an indexing pass.
/// On macOS the model runs in a helper process, started on the job's first
/// batch and kept for the rest of it, so the model files are hashed and
/// loaded once per job rather than once per batch. The helper exits when
/// the job drops its last clone of this value or calls [`Self::close`].
#[derive(Clone)]
pub(crate) struct EmbeddingRun {
    root: PathBuf,
    model: &'static BuiltinEmbeddingModel,
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    helper: std::sync::Arc<std::sync::Mutex<Option<HelperProcess>>>,
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    _residency: std::sync::Arc<crate::model_residency::IdleModel>,
}

impl EmbeddingRun {
    pub(crate) fn new(models_root: &Path, model: &'static BuiltinEmbeddingModel) -> Self {
        #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
        let helper = std::sync::Arc::new(std::sync::Mutex::new(None));
        Self {
            root: models_root.to_path_buf(),
            model,
            #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
            _residency: crate::model_residency::watch_owned_cache(
                model.download_bytes() + 512 * 1024 * 1024,
                &helper,
            ),
            #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
            helper,
        }
    }

    /// Embed up to a handful of texts. Blocking: call from `spawn_blocking`.
    /// Loading and every batch go through native admission and hold the
    /// native runtime gate only while they run, so a dictation decode waits
    /// at most one small batch.
    pub(crate) fn embed_blocking(&self, role: TextRole, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_with(role, texts, None)
    }

    /// [`Self::embed_blocking`] for background indexing: the batch is
    /// stopped, within about 10 ms, as soon as `yield_to` says something else
    /// needs the runtime. Stopping it ends the helper, and with it this run.
    pub(crate) fn embed_yielding_blocking(
        &self,
        texts: &[String],
        yield_to: fn() -> bool,
    ) -> Result<Vec<Vec<f32>>> {
        self.embed_with(TextRole::Document, texts, Some(yield_to))
    }

    /// End the helper now, if one is running. The next batch starts another,
    /// which verifies the model files again.
    pub(crate) fn close(&self) {
        #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
        drop(
            self.helper
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take(),
        );
    }

    #[cfg(feature = "local-embeddings")]
    fn embed_with(
        &self,
        role: TextRole,
        texts: &[String],
        yield_to: Option<fn() -> bool>,
    ) -> Result<Vec<Vec<f32>>> {
        #[cfg(any(not(target_os = "macos"), test))]
        let _ = yield_to;
        #[cfg(all(target_os = "macos", not(test)))]
        {
            if texts.is_empty() {
                return Ok(Vec::new());
            }
            anyhow::ensure!(
                texts.len() <= BATCH,
                "Too many texts for one search-model batch."
            );
            let output = helper_call(
                self,
                HelperWork::Embed {
                    role,
                    texts: texts.to_vec(),
                },
                yield_to,
            )?;
            let HelperOutput::Embeddings { vectors } = output else {
                anyhow::bail!("The search helper returned the wrong response.");
            };
            anyhow::ensure!(
                vectors.len() == texts.len()
                    && vectors.iter().all(|row| row.len() == self.model.dimensions
                        && row.iter().all(|value| value.is_finite())),
                "The search helper returned invalid vectors."
            );
            Ok(vectors)
        }
        #[cfg(any(not(target_os = "macos"), test))]
        runtime::embed(&self.root, self.model, role, texts)
    }

    #[cfg(not(feature = "local-embeddings"))]
    fn embed_with(
        &self,
        _role: TextRole,
        _texts: &[String],
        _yield_to: Option<fn() -> bool>,
    ) -> Result<Vec<Vec<f32>>> {
        anyhow::bail!("This build of Plainsong cannot run built-in search models.")
    }
}

/// [`EmbeddingRun::embed_blocking`] as a job of its own.
#[cfg(test)]
pub(crate) fn embed_blocking(
    models_root: &Path,
    model: &'static BuiltinEmbeddingModel,
    role: TextRole,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    EmbeddingRun::new(models_root, model).embed_blocking(role, texts)
}

/// A background batch was stopped so dictation, a meeting capture or other
/// foreground work could have the runtime. Not a failure of the helper.
pub(crate) const SEARCH_BATCH_YIELDED: &str = "The search batch stopped so speech could run.";
/// An away-only batch ended without a helper failure. Retried by the indexer.
pub(crate) const SEARCH_AWAY_WINDOW_ENDED: &str =
    "Paused until you're away or more memory is free.";

// Negative control for the previous best-effort cleanup at an idle age of zero.
#[cfg(all(test, feature = "local-embeddings"))]
async fn legacy_release_now() {
    runtime::release_tokenizer();
    if !runtime::has_resident() {
        return;
    }
    let Ok(gate) = super::native_runtime_gate::NATIVE_RUNTIME.acquire() else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || {
        let _gate = gate;
        runtime::release_all();
    })
    .await;
}

/// Release search weights and tokenizers after active native work finishes.
/// Waiting for the cleanup gate prevents a completed batch from silently
/// leaving its model resident while another native operation owns the runtime.
pub(crate) async fn release_now() {
    #[cfg(feature = "local-embeddings")]
    {
        let gate = match super::local_model_load::acquire_cleanup_gate().await {
            Ok(gate) => gate,
            Err(error) => {
                tracing::warn!("Search model release refused by the runtime gate: {error}");
                return;
            }
        };
        if let Err(error) = tokio::task::spawn_blocking(move || {
            let _gate = gate;
            runtime::release_all();
        })
        .await
        {
            tracing::warn!("Search model release task failed: {error}");
        }
    }
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct HelperQaProcess {
    pid: u32,
    label: String,
}
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct HelperQaSnapshot {
    captured_at_ms: u64,
    helper_pid: u32,
    processes: Vec<HelperQaProcess>,
    alive_after: Vec<u32>,
    footprint_output: String,
    error: Option<String>,
}
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(Default)]
struct HelperQaHistory {
    reports: Vec<HelperQaSnapshot>,
    overflow: bool,
}
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
static HELPER_QA: std::sync::Mutex<HelperQaHistory> = std::sync::Mutex::new(HelperQaHistory {
    reports: Vec::new(),
    overflow: false,
});

pub(crate) fn helper_qa_footprints() -> Option<serde_json::Value> {
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    if std::env::var("PLAINSONG_QA_MODE").as_deref() == Ok("1") {
        let history = HELPER_QA.lock().unwrap_or_else(|error| error.into_inner());
        return Some(
            serde_json::json!({ "reports": history.reports, "overflow": history.overflow }),
        );
    }
    None
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn capture_helper_qa(root: u32, parent: u32) -> HelperQaSnapshot {
    use std::process::{Command, Stdio};
    type ProcessRow = (u32, u32, String);
    fn table() -> Option<(u32, Vec<ProcessRow>)> {
        let child = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,command="])
            .stdout(Stdio::piped())
            .spawn()
            .ok()?;
        let pid = child.id();
        let output = child.wait_with_output().ok()?;
        if !output.status.success() {
            return None;
        }
        let rows = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse().ok()?;
                let ppid = fields.next()?.parse().ok()?;
                Some((pid, ppid, fields.collect::<Vec<_>>().join(" ")))
            })
            .collect();
        Some((pid, rows))
    }
    let mut report = HelperQaSnapshot {
        captured_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        helper_pid: std::process::id(),
        processes: Vec::new(),
        alive_after: Vec::new(),
        footprint_output: String::new(),
        error: None,
    };
    let Some((ps_pid, rows)) = table() else {
        report.error = Some("Could not enumerate helper processes".to_string());
        return report;
    };
    let mut owned = std::collections::HashSet::from([root]);
    loop {
        let previous = owned.len();
        for (pid, ppid, _) in &rows {
            if owned.contains(ppid) {
                owned.insert(*pid);
            }
        }
        if owned.len() == previous {
            break;
        }
    }
    if !owned.contains(&report.helper_pid) {
        report.error = Some("Helper was outside the measured app tree".to_string());
        return report;
    }
    for (pid, _, command) in &rows {
        if !owned.contains(pid) || *pid == ps_pid {
            continue;
        }
        let label = if *pid == report.helper_pid {
            "embedding-helper"
        } else if *pid == parent {
            "sidecar"
        } else if command.contains("--type=renderer") {
            "renderer"
        } else if command.contains("--type=gpu-process") {
            "gpu"
        } else if command.contains("--type=utility") {
            "utility"
        } else if *pid == root {
            "main"
        } else if command.contains("plainsong-sidecar") {
            "sidecar-child"
        } else if command.contains("speech-helper") {
            "speech-helper"
        } else if command.contains("shortcut-helper") {
            "shortcut-helper"
        } else if command.contains("calendar-helper") {
            "calendar-helper"
        } else if command.contains("language-model-helper") {
            "language-model-helper"
        } else {
            "app-helper"
        };
        report.processes.push(HelperQaProcess {
            pid: *pid,
            label: label.to_string(),
        });
    }
    let mut command = Command::new("/usr/bin/footprint");
    command.args(["-f", "bytes"]);
    for process in &report.processes {
        command.arg("-p").arg(process.pid.to_string());
    }
    match command.output() {
        Ok(output) => {
            report.footprint_output = String::from_utf8_lossy(&output.stdout).into_owned();
            if !output.status.success() {
                report.error = Some("Helper footprint capture failed".to_string());
            }
        }
        Err(_) => report.error = Some("Could not run helper footprint capture".to_string()),
    }
    if let Some((_, after)) = table() {
        report.alive_after = after.into_iter().map(|row| row.0).collect();
    } else {
        report.error = Some("Could not verify helper process coverage".to_string());
    }
    report
}

/// Version 2 frames each message and serves a whole job per helper.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
const HELPER_PROTOCOL: u8 = 2;
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
const HELPER_MESSAGE_LIMIT: u64 = 32 * 1024 * 1024;
/// A helper that waits this long for its next request, or spends this long
/// on one, exits: either means its parent stopped driving it.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
const HELPER_STALL_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);
/// The parent replaces a helper idle this long rather than race the
/// helper's own stall limit.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
const HELPER_REUSE_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// The helper hashes every model byte it uses itself; a request carries no
/// claim about the files, and any field it does not know is refused.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperRequest {
    version: u8,
    parent_pid: u32,
    #[serde(default)]
    qa_root_pid: Option<u32>,
    models_root: PathBuf,
    model_id: String,
    #[serde(default)]
    away_admission: bool,
    work: HelperWork,
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum HelperWork {
    Embed {
        role: TextRole,
        texts: Vec<String>,
    },
    Windows {
        recording_id: String,
        segments: Vec<crate::models::TranscriptSegment>,
    },
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(serde::Serialize, serde::Deserialize)]
struct WindowWire {
    recording_id: String,
    segment_id: String,
    text: String,
    start_time: f64,
    end_time: f64,
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
impl From<crate::llm::GroundedSegment> for WindowWire {
    fn from(row: crate::llm::GroundedSegment) -> Self {
        Self {
            recording_id: row.recording_id,
            segment_id: row.segment_id,
            text: row.text,
            start_time: row.start_time,
            end_time: row.end_time,
        }
    }
}
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
impl From<WindowWire> for crate::llm::GroundedSegment {
    fn from(row: WindowWire) -> Self {
        Self {
            recording_id: row.recording_id,
            segment_id: row.segment_id,
            text: row.text,
            start_time: row.start_time,
            end_time: row.end_time,
        }
    }
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum HelperOutput {
    Embeddings { vectors: Vec<Vec<f32>> },
    Windows { windows: Vec<WindowWire> },
}
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
#[derive(serde::Serialize, serde::Deserialize)]
struct HelperResponse {
    version: u8,
    result: std::result::Result<HelperOutput, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    qa_snapshot: Option<HelperQaSnapshot>,
}

/// Messages on the helper's pipes: a 4-byte big-endian length, then JSON.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn write_frame(output: &mut impl std::io::Write, bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.len() as u64 <= HELPER_MESSAGE_LIMIT,
        "The search helper message is too large."
    );
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(bytes)?;
    output.flush()?;
    Ok(())
}

/// The next message, or `None` when the pipe closes between messages.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn read_frame(input: &mut impl std::io::Read) -> Result<Option<Vec<u8>>> {
    let mut length = [0_u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match input.read(&mut length[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => anyhow::bail!("The search helper message was cut off."),
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    let length = u64::from(u32::from_be_bytes(length));
    anyhow::ensure!(
        length <= HELPER_MESSAGE_LIMIT,
        "The search helper message is too large."
    );
    let mut bytes = vec![0_u8; length as usize];
    input
        .read_exact(&mut bytes)
        .map_err(|_| anyhow::anyhow!("The search helper message was cut off."))?;
    Ok(Some(bytes))
}

/// The parent's handle on one job's helper.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
struct HelperProcess {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    replies: std::sync::mpsc::Receiver<Result<Option<Vec<u8>>>>,
    temporary: PathBuf,
    last_used: std::time::Instant,
    /// Keep the job's marker namespace for diagnosis after a failure.
    keep_temporary: bool,
    qa_residency: Option<crate::memory_pressure::QaResidency>,
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
impl HelperProcess {
    fn spawn(root: &Path) -> Result<Self> {
        use std::process::{Command, Stdio};
        let temporary = crate::paths::data_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find the data directory"))?
            .join("Plainsong")
            .join("helper-runtime")
            .join(format!("embedding-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temporary)?;
        #[cfg(test)]
        let executable = PathBuf::from(std::env::var("PLAINSONG_PRESSURE_PROBE_SIDECAR")?);
        #[cfg(not(test))]
        let executable = {
            let current = std::env::current_exe()?;
            if current
                .file_stem()
                .is_some_and(|name| name == "plainsong-sidecar")
            {
                current
            } else {
                current
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("Could not find the sidecar folder"))?
                    .join("plainsong-sidecar")
            }
        };
        let mut command = Command::new(executable);
        if let Some(baseline) = crate::hardware_tier::available_memory_simulation_baseline() {
            command.env(
                crate::hardware_tier::SIMULATED_AVAILABLE_BASELINE_ENV,
                baseline.to_string(),
            );
        }
        let mut child = command
            .arg("--embedding-helper")
            .env("PLAINSONG_EMBEDDING_MODELS_ROOT", root)
            .env("PLAINSONG_DATA_DIR", temporary.join("data"))
            .env("PLAINSONG_CONFIG_DIR", temporary.join("config"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (sender, replies) = std::sync::mpsc::channel();
        let mut helper = Self {
            child,
            stdin,
            replies,
            temporary,
            last_used: std::time::Instant::now(),
            keep_temporary: false,
            qa_residency: None,
        };
        let mut stdout =
            stdout.ok_or_else(|| anyhow::anyhow!("Search helper output is unavailable"))?;
        // Both pipes are drained on their own threads so a full pipe cannot
        // stall the helper. Stderr is never published: a tokenizer error can
        // contain private input.
        std::thread::Builder::new()
            .name("search-helper-replies".into())
            .spawn(move || loop {
                let frame = read_frame(&mut stdout);
                let last = !matches!(frame, Ok(Some(_)));
                if sender.send(frame).is_err() || last {
                    break;
                }
            })
            .inspect_err(|_| helper.keep_temporary = true)?;
        if let Some(mut stderr) = stderr {
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            });
        }
        Ok(helper)
    }

    /// Send one request and wait for its reply; `None` when `yield_to` asked
    /// for the runtime first.
    fn exchange(
        &mut self,
        request: &[u8],
        yield_to: Option<fn() -> bool>,
        away_admission: bool,
    ) -> Result<Option<Vec<u8>>> {
        use std::sync::mpsc::RecvTimeoutError;
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Search helper input is unavailable"))?;
        write_frame(stdin, request)?;
        loop {
            match self
                .replies
                .recv_timeout(std::time::Duration::from_millis(10))
            {
                Ok(Ok(Some(reply))) => {
                    self.last_used = std::time::Instant::now();
                    return Ok(Some(reply));
                }
                Ok(Err(error)) => return Err(error),
                Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("The search helper closed its output.")
                }
                Err(RecvTimeoutError::Timeout) => {
                    if yield_to.is_some_and(|yield_to| yield_to()) {
                        return Ok(None);
                    }
                    if away_admission && !super::notes_window::away() {
                        anyhow::bail!(SEARCH_AWAY_WINDOW_ENDED);
                    }
                }
            }
        }
    }

    /// End the helper at once, mid-batch if need be.
    fn stop(mut self) {
        let _ = self.child.kill();
    }
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
impl Drop for HelperProcess {
    fn drop(&mut self) {
        // Closing its input tells the helper the job is over.
        drop(self.stdin.take());
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                _ => {
                    let _ = self.child.kill();
                    if self.child.wait().is_err() {
                        // Do not report an unload without confirming process exit.
                        std::mem::forget(self.qa_residency.take());
                    }
                    break;
                }
            }
        }
        if !self.keep_temporary {
            let _ = std::fs::remove_dir_all(&self.temporary);
        }
    }
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn helper_call(
    run: &EmbeddingRun,
    work: HelperWork,
    yield_to: Option<fn() -> bool>,
) -> Result<HelperOutput> {
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    static FAILED: AtomicBool = AtomicBool::new(false);
    const STOPPED: &str =
        "The search helper stopped unexpectedly. Restart Plainsong before retrying.";
    anyhow::ensure!(!FAILED.load(Ordering::Acquire), STOPPED);
    // Keep the parent's native permit until the batch's reply. Foreground
    // dictation then waits for this bounded batch, just as it did for
    // in-process inference.
    let _gate = if matches!(&work, HelperWork::Embed { .. }) {
        Some(
            super::native_runtime_gate::NATIVE_RUNTIME
                .acquire()
                .map_err(anyhow::Error::msg)?,
        )
    } else {
        None
    };
    let qa_root_pid = if std::env::var("PLAINSONG_QA_MODE").as_deref() == Ok("1") {
        // SAFETY: getppid only reads the current process's parent identifier.
        let parent = unsafe { libc::getppid() } as u32;
        let name = Command::new("/bin/ps")
            .args(["-ww", "-p", &parent.to_string(), "-o", "comm="])
            .output()?;
        Some(
            if String::from_utf8_lossy(&name.stdout)
                .trim()
                .ends_with("/Contents/MacOS/Plainsong")
            {
                parent
            } else {
                std::process::id()
            },
        )
    } else {
        None
    };
    let away_admission = yield_to.is_some() && super::notes_window::away();
    // Release only idle caches owned by this sidecar. Their locks leave
    // active speech and notes alone; the claim below still counts them.
    if yield_to.is_some() {
        crate::asr::speech_residency::release_for_heavy_work();
        super::native_text::end_idle_helper_unless(|_| false);
    }
    let directory = model_dir(&run.root, run.model);
    let claim_path = match &work {
        HelperWork::Embed { .. } => directory,
        HelperWork::Windows { .. } => directory.join(run.model.tokenizer),
    };
    let _claim = super::notes_window::with_admission(away_admission, || {
        super::local_model_load::text_embedding_helper_claim(&[&claim_path])
    })?;
    let request = HelperRequest {
        version: HELPER_PROTOCOL,
        parent_pid: std::process::id(),
        qa_root_pid,
        models_root: run.root.clone(),
        model_id: run.model.id.to_string(),
        away_admission,
        work,
    };
    let bytes = serde_json::to_vec(&request)?;
    anyhow::ensure!(
        bytes.len() as u64 <= HELPER_MESSAGE_LIMIT,
        "The search helper request is too large."
    );
    let mut slot = run.helper.lock().unwrap_or_else(|error| error.into_inner());
    if slot
        .as_ref()
        .is_some_and(|helper| helper.last_used.elapsed() >= HELPER_REUSE_LIMIT)
    {
        *slot = None;
    }
    let helper = match slot.as_mut() {
        Some(helper) => helper,
        None => slot.insert(HelperProcess::spawn(&run.root)?),
    };
    let failed = |slot: &mut Option<HelperProcess>| {
        if let Some(mut helper) = slot.take() {
            helper.keep_temporary = true;
            helper.stop();
        }
        FAILED.store(true, Ordering::Release);
    };
    let reply = match helper.exchange(&bytes, yield_to, away_admission) {
        Ok(Some(reply)) => reply,
        Ok(None) => {
            if let Some(helper) = slot.take() {
                helper.stop();
            }
            anyhow::bail!(SEARCH_BATCH_YIELDED);
        }
        Err(error) if error.to_string() == SEARCH_AWAY_WINDOW_ENDED => {
            if let Some(helper) = slot.take() {
                helper.stop();
            }
            return Err(error);
        }
        Err(_) => {
            failed(&mut slot);
            anyhow::bail!(STOPPED);
        }
    };
    let Ok(reply) = serde_json::from_slice::<HelperResponse>(&reply) else {
        failed(&mut slot);
        anyhow::bail!(
            "The search helper returned an invalid response. Restart Plainsong before retrying."
        );
    };
    if reply.version != HELPER_PROTOCOL {
        failed(&mut slot);
        anyhow::bail!("The search helper protocol changed. Restart Plainsong before retrying.");
    }
    if let Some(mut report) = reply.qa_snapshot {
        if let Err(error) = &reply.result {
            report.error = Some(format!("Search helper job did not complete: {error}"));
        }
        let mut history = HELPER_QA.lock().unwrap_or_else(|error| error.into_inner());
        if history.reports.len() < 64 {
            history.reports.push(report);
        } else {
            history.overflow = true;
        }
    }
    // Token-window replies only load a tokenizer, not the embedding model.
    if matches!(&reply.result, Ok(HelperOutput::Embeddings { vectors }) if !vectors.is_empty())
        && helper.qa_residency.is_none()
    {
        helper.qa_residency =
            crate::memory_pressure::QaResidency::loaded("search", helper.child.id());
    }
    if reply.result.is_err() {
        // The next batch starts a fresh helper; this one's markers stay.
        if let Some(mut helper) = slot.take() {
            helper.keep_temporary = true;
        }
    }
    reply.result.map_err(anyhow::Error::msg)
}

/// When the helper last started or finished a request, so it can exit once
/// its parent stops driving it.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
struct HelperClock {
    started: std::time::Instant,
    /// Milliseconds since `started`; `u64::MAX` while idle.
    busy_since: std::sync::atomic::AtomicU64,
    idle_since: std::sync::atomic::AtomicU64,
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
impl HelperClock {
    fn new() -> Self {
        Self {
            started: std::time::Instant::now(),
            busy_since: std::sync::atomic::AtomicU64::new(u64::MAX),
            idle_since: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn now(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX - 1)
    }

    fn begin(&self) {
        self.busy_since
            .store(self.now(), std::sync::atomic::Ordering::Release);
    }

    fn end(&self) {
        self.idle_since
            .store(self.now(), std::sync::atomic::Ordering::Release);
        self.busy_since
            .store(u64::MAX, std::sync::atomic::Ordering::Release);
    }

    fn stalled(&self) -> bool {
        let limit = u64::try_from(HELPER_STALL_LIMIT.as_millis()).unwrap_or(u64::MAX);
        let since = match self.busy_since.load(std::sync::atomic::Ordering::Acquire) {
            u64::MAX => self.idle_since.load(std::sync::atomic::Ordering::Acquire),
            busy => busy,
        };
        self.now().saturating_sub(since) >= limit
    }
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
struct HelperContext<'a> {
    /// Canonical; every request must name it.
    models_root: PathBuf,
    parent_pid: u32,
    model: fn(&str) -> Option<&'static BuiltinEmbeddingModel>,
    clock: &'a HelperClock,
}

/// Answer requests until the parent closes the pipe. One helper serves one
/// model from one models folder, so the model it loaded and hashed is never
/// reused for another.
#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn serve_helper(
    input: &mut impl std::io::Read,
    output: &mut impl std::io::Write,
    context: &HelperContext<'_>,
) -> Result<()> {
    let mut serving: Option<String> = None;
    while let Some(bytes) = read_frame(input)? {
        context.clock.begin();
        let request: HelperRequest = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            request.version == HELPER_PROTOCOL,
            "Unsupported search helper protocol."
        );
        anyhow::ensure!(
            request.parent_pid > 1 && request.parent_pid == context.parent_pid,
            "The search helper parent changed."
        );
        anyhow::ensure!(
            std::fs::canonicalize(&request.models_root)? == context.models_root,
            "The search helper model root changed."
        );
        anyhow::ensure!(
            serving.get_or_insert_with(|| request.model_id.clone()) == &request.model_id,
            "The search helper was sent a different model."
        );
        let result = super::notes_window::with_admission(
            request.away_admission && super::notes_window::away(),
            || serve_helper_request(&request, context.model),
        );
        let qa_snapshot = request
            .qa_root_pid
            .filter(|_| std::env::var("PLAINSONG_QA_MODE").as_deref() == Ok("1"))
            .map(|root| capture_helper_qa(root, request.parent_pid));
        let response = HelperResponse {
            version: HELPER_PROTOCOL,
            qa_snapshot,
            result: result.map_err(|error| {
                let message = format!("{error:#}");
                if message.to_lowercase().contains("tokeniz") {
                    "The search tokenizer failed. Download the model again.".to_string()
                } else {
                    message
                }
            }),
        };
        write_frame(output, &serde_json::to_vec(&response)?)?;
        context.clock.end();
    }
    Ok(())
}

#[cfg(all(target_os = "macos", feature = "local-embeddings"))]
fn serve_helper_request(
    request: &HelperRequest,
    model: fn(&str) -> Option<&'static BuiltinEmbeddingModel>,
) -> Result<HelperOutput> {
    let selected =
        model(&request.model_id).ok_or_else(|| anyhow::anyhow!("Unknown search model"))?;
    match &request.work {
        HelperWork::Embed { role, texts } => {
            anyhow::ensure!(
                texts.len() <= BATCH,
                "Too many texts for one search-model batch."
            );
            // The first batch hashes and loads the model; it then stays
            // loaded in this helper for the rest of the job.
            Ok(HelperOutput::Embeddings {
                vectors: runtime::embed(&request.models_root, selected, *role, texts)?,
            })
        }
        HelperWork::Windows {
            recording_id,
            segments,
        } => {
            let directory = model_dir(&request.models_root, selected);
            let _claim = super::local_model_load::admit_text_embedding(
                &[&directory.join(selected.tokenizer)],
                super::local_model_load::NativeAllocation::Constructor,
            )?;
            runtime::verified_shared_tokenizer(&request.models_root, selected)?;
            let count = token_counter(&request.models_root, selected);
            let windows = crate::semantic_index::index_windows(recording_id, segments, &*count);
            Ok(HelperOutput::Windows {
                windows: windows.into_iter().map(Into::into).collect(),
            })
        }
    }
}

/// Private entry point for one job's helper. Requests and replies stay on
/// local pipes; no application state, microphone, database or provider
/// account is initialized. The helper exits when its input closes.
pub async fn run_embedding_helper_stdio() -> Result<()> {
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    {
        let expected = std::env::var_os("PLAINSONG_EMBEDDING_MODELS_ROOT")
            .ok_or_else(|| anyhow::anyhow!("Search helper model root is unavailable"))?;
        // SAFETY: getppid only reads this process's parent identifier.
        let parent = unsafe { libc::getppid() } as u32;
        let clock = std::sync::Arc::new(HelperClock::new());
        let watchdog = std::sync::Arc::clone(&clock);
        std::thread::spawn(move || loop {
            // SAFETY: getppid only reads this process's parent identifier.
            if unsafe { libc::getppid() } as u32 != parent || watchdog.stalled() {
                std::process::exit(124);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        });
        let context = HelperContext {
            models_root: std::fs::canonicalize(expected)?,
            parent_pid: parent,
            model,
            clock: &clock,
        };
        serve_helper(
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &context,
        )
    }
    #[cfg(not(all(target_os = "macos", feature = "local-embeddings")))]
    anyhow::bail!("This build cannot run a search helper.");
}

impl EmbeddingRun {
    /// Prepare exact token windows without loading a tokenizer into the
    /// capture process.
    pub(crate) fn recording_windows_blocking(
        &self,
        recording_id: &str,
        segments: &[crate::models::TranscriptSegment],
    ) -> Result<Vec<crate::llm::GroundedSegment>> {
        #[cfg(all(target_os = "macos", feature = "local-embeddings", not(test)))]
        {
            let _batch = super::local_model_load::background_batch();
            let output = helper_call(
                self,
                HelperWork::Windows {
                    recording_id: recording_id.to_string(),
                    segments: segments.to_vec(),
                },
                None,
            )?;
            let HelperOutput::Windows { windows } = output else {
                anyhow::bail!("The search helper returned the wrong response.");
            };
            anyhow::ensure!(
                windows.iter().all(|row| row.recording_id == recording_id
                    && row.start_time.is_finite()
                    && row.end_time.is_finite()),
                "The search helper returned invalid windows."
            );
            Ok(windows.into_iter().map(Into::into).collect())
        }
        #[cfg(any(not(target_os = "macos"), not(feature = "local-embeddings"), test))]
        {
            let count = token_counter(&self.root, self.model);
            Ok(crate::semantic_index::index_windows(
                recording_id,
                segments,
                &*count,
            ))
        }
    }
}

/// Count the tokens the model's own tokenizer makes of `text`, without
/// special tokens. Falls back to an estimate (words, plus one per CJK
/// character) when the tokenizer cannot be read. Blocking.
pub(crate) fn token_counter(
    models_root: &Path,
    model: &'static BuiltinEmbeddingModel,
) -> Box<dyn Fn(&str) -> usize + Send + Sync> {
    #[cfg(feature = "local-embeddings")]
    if let Some(tokenizer) = runtime::shared_tokenizer(models_root, model) {
        return Box::new(move |text: &str| {
            tokenizer
                .encode(text, false)
                .map(|encoding| encoding.get_ids().len())
                .unwrap_or_else(|_| estimated_tokens(text))
        });
    }
    let _ = (models_root, model);
    Box::new(estimated_tokens)
}

/// A model-free token estimate: one per whitespace-separated word, plus one
/// per CJK character, since those scripts write words without spaces.
pub(crate) fn estimated_tokens(text: &str) -> usize {
    let words = text.split_whitespace().count();
    let cjk = text.chars().filter(|c| is_cjk(*c)).count();
    words + cjk
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF // Hiragana, Katakana
        | 0x3400..=0x4DBF // CJK Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7AF // Hangul syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        | 0x20000..=0x2FA1F) // CJK Extensions B-F and supplements
}

fn clear_resident_if(model_id: &str) {
    #[cfg(feature = "local-embeddings")]
    runtime::clear_if(model_id);
    #[cfg(not(feature = "local-embeddings"))]
    let _ = model_id;
}

/// The largest number of texts one native call embeds.
pub(crate) const BATCH: usize = 4;

#[cfg(feature = "local-embeddings")]
mod runtime {
    use super::*;
    use anyhow::{anyhow, Context};
    use ort::session::Session;
    use ort::value::Tensor;
    use std::sync::{Mutex, OnceLock};

    struct Resident {
        model_id: &'static str,
        session: Session,
        tokenizer: tokenizers::Tokenizer,
        pad_id: u32,
        /// Declared after `session`, so it is dropped after the session that
        /// reads it.
        _weights: Option<ExternalWeights>,
    }

    /// A model's external weights file, as ONNX Runtime is given it.
    pub(super) enum ExternalWeights {
        /// A read-only map of the verified descriptor. Its pages are clean
        /// and file-backed, so they are not in the process's footprint; a
        /// heap copy of EmbeddingGemma's weights cost the helper 300 MiB.
        /// The same trust as the text helper's mapped `--model-fd`.
        #[cfg(unix)]
        Mapped {
            address: std::ptr::NonNull<u8>,
            len: usize,
            _file: crate::download::VerifiedModelArtifact,
        },
        #[cfg(not(unix))]
        Owned(Vec<u8>),
    }

    // SAFETY: the mapping is read-only and owned by this value.
    #[cfg(unix)]
    unsafe impl Send for ExternalWeights {}
    #[cfg(unix)]
    unsafe impl Sync for ExternalWeights {}

    impl ExternalWeights {
        pub(super) fn bytes(&self) -> &[u8] {
            match self {
                // SAFETY: `address` maps `len` readable bytes until drop.
                #[cfg(unix)]
                Self::Mapped { address, len, .. } => unsafe {
                    std::slice::from_raw_parts(address.as_ptr(), *len)
                },
                #[cfg(not(unix))]
                Self::Owned(bytes) => bytes,
            }
        }

        /// The weights for ort, which wants a `'static` buffer.
        ///
        /// # Safety
        /// The caller keeps `self` alive for as long as the session built
        /// from the returned buffer.
        unsafe fn for_session(&self) -> std::borrow::Cow<'static, [u8]> {
            // SAFETY: upheld by the caller.
            std::borrow::Cow::Borrowed(unsafe { &*std::ptr::from_ref::<[u8]>(self.bytes()) })
        }
    }

    #[cfg(unix)]
    impl Drop for ExternalWeights {
        fn drop(&mut self) {
            let Self::Mapped { address, len, .. } = self;
            // SAFETY: unmaps exactly the region mapped in `external_weights`.
            unsafe {
                libc::munmap(address.as_ptr().cast(), *len);
            }
        }
    }

    /// The external weights a verified graph names, without copying them.
    #[cfg(unix)]
    pub(super) fn external_weights(dir: &Path, pin: &EmbeddingArtifact) -> Result<ExternalWeights> {
        use std::os::fd::AsRawFd;
        let file = crate::download::open_model_artifact_to_hash(&dir.join(pin.local_name))?;
        let len = usize::try_from(file.as_file().metadata()?.len())?;
        anyhow::ensure!(
            len > 0,
            "{} is empty. Download the search model again.",
            pin.local_name
        );
        // SAFETY: a fresh read-only private mapping of an open regular file.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_PRIVATE,
                file.as_file().as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("Failed to map {}", pin.local_name));
        }
        let Some(address) = std::ptr::NonNull::new(address.cast::<u8>()) else {
            anyhow::bail!("Failed to map {}", pin.local_name);
        };
        // Hash the bytes ONNX will read: the mapping itself. Reading the map
        // adds clean file pages, not footprint.
        use sha2::{Digest, Sha256};
        // SAFETY: `address` maps `len` readable bytes until the munmap below
        // or the drop of the `ExternalWeights` built from it.
        let digest = hex::encode(Sha256::digest(unsafe {
            std::slice::from_raw_parts(address.as_ptr(), len)
        }));
        match file.finish(&digest, pin.sha256) {
            Ok(file) => Ok(ExternalWeights::Mapped {
                address,
                len,
                _file: file,
            }),
            Err(error) => {
                // SAFETY: unmaps exactly the region mapped above.
                unsafe {
                    libc::munmap(address.as_ptr().cast(), len);
                }
                Err(integrity_error(error, pin))
            }
        }
    }

    fn integrity_error(error: anyhow::Error, pin: &EmbeddingArtifact) -> anyhow::Error {
        if crate::download::is_integrity_mismatch(&error) {
            anyhow!(
                "{} failed its integrity check. Download the search model again.",
                pin.local_name
            )
        } else {
            error
        }
    }

    #[cfg(not(unix))]
    pub(super) fn external_weights(dir: &Path, pin: &EmbeddingArtifact) -> Result<ExternalWeights> {
        Ok(ExternalWeights::Owned(verified_bytes(dir, pin)?))
    }

    static RESIDENT: OnceLock<Mutex<Option<Resident>>> = OnceLock::new();

    fn resident() -> &'static Mutex<Option<Resident>> {
        let cache = RESIDENT.get_or_init(|| Mutex::new(None));
        static REGISTRATION: OnceLock<std::sync::Arc<crate::model_residency::IdleModel>> =
            OnceLock::new();
        crate::model_residency::watch_cache(&REGISTRATION, 1024 * 1024 * 1024, cache);
        cache
    }

    pub(super) fn clear_if(model_id: &str) {
        let mut slot = resident().lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|value| value.model_id == model_id)
        {
            *slot = None;
        }
    }

    type SharedTokenizer = Option<(&'static str, std::sync::Arc<tokenizers::Tokenizer>)>;
    static TOKENIZER: Mutex<SharedTokenizer> = Mutex::new(None);

    /// Forget the window-counting tokenizer. A counter already handed out
    /// keeps its own reference until it finishes.
    pub(super) fn release_tokenizer() {
        *TOKENIZER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The tokenizer for counting window tokens, loaded once per model and
    /// kept apart from the ONNX session so counting never loads the model.
    /// Released with the model, so an idle app holds neither.
    pub(super) fn shared_tokenizer(
        models_root: &Path,
        model: &'static BuiltinEmbeddingModel,
    ) -> Option<std::sync::Arc<tokenizers::Tokenizer>> {
        verified_shared_tokenizer(models_root, model).ok()
    }

    /// [`shared_tokenizer`], with the reason it could not be loaded.
    pub(super) fn verified_shared_tokenizer(
        models_root: &Path,
        model: &'static BuiltinEmbeddingModel,
    ) -> Result<std::sync::Arc<tokenizers::Tokenizer>> {
        static REGISTRATION: OnceLock<std::sync::Arc<crate::model_residency::IdleModel>> =
            OnceLock::new();
        crate::model_residency::watch_cache(&REGISTRATION, 64 * 1024 * 1024, &TOKENIZER);
        let mut slot = TOKENIZER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((id, tokenizer)) = slot.as_ref() {
            if *id == model.id {
                return Ok(tokenizer.clone());
            }
        }
        let dir = model_dir(models_root, model);
        let bytes = verified_bytes(&dir, model.pin(model.tokenizer)?)?;
        let mut tokenizer = tokenizers::Tokenizer::from_bytes(&bytes)
            .map_err(|error| anyhow!("Failed to load the search model tokenizer: {error}"))?;
        tokenizer
            .with_truncation(None)
            .map_err(|error| anyhow!("Failed to configure the search model tokenizer: {error}"))?;
        tokenizer.with_padding(None);
        let tokenizer = std::sync::Arc::new(tokenizer);
        *slot = Some((model.id, tokenizer.clone()));
        Ok(tokenizer)
    }

    #[cfg(test)]
    pub(super) fn has_resident() -> bool {
        resident()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
    }

    pub(super) fn release_all() {
        *resident().lock().unwrap_or_else(|error| error.into_inner()) = None;
        release_tokenizer();
    }

    /// The file's bytes, hashed as read: the copy handed to the parser is
    /// the copy that matched the pin.
    pub(super) fn verified_bytes(dir: &Path, pin: &EmbeddingArtifact) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let file = crate::download::open_model_artifact_to_hash(&dir.join(pin.local_name))?;
        let mut bytes = Vec::new();
        file.as_file()
            .read_to_end(&mut bytes)
            .with_context(|| format!("Failed to read {}", pin.local_name))?;
        file.finish(&hex::encode(Sha256::digest(&bytes)), pin.sha256)
            .map_err(|error| integrity_error(error, pin))?;
        Ok(bytes)
    }

    /// Hash `reader` from its current position to the end, then put it back
    /// at the start for the loader.
    #[cfg(unix)]
    pub(super) fn hash_and_rewind<R: std::io::Read + std::io::Seek>(
        reader: &mut R,
    ) -> Result<String> {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        reader.rewind()?;
        Ok(hex::encode(digest.finalize()))
    }

    /// ONNX opens the graph by path, so it is hashed through its own
    /// descriptor and loaded through [`crate::download::VerifiedModelArtifact::load_path`],
    /// which names that same file.
    #[cfg(unix)]
    fn verified_graph(
        dir: &Path,
        pin: &EmbeddingArtifact,
    ) -> Result<crate::download::VerifiedModelArtifact> {
        let file = crate::download::open_model_artifact_to_hash(&dir.join(pin.local_name))?;
        let digest = hash_and_rewind(&mut file.as_file())?;
        file.finish(&digest, pin.sha256)
            .map_err(|error| integrity_error(error, pin))
    }

    fn load(models_root: &Path, model: &'static BuiltinEmbeddingModel) -> Result<Resident> {
        if !artifacts_installed(models_root, model) {
            anyhow::bail!(
                "{} is not downloaded or did not pass its integrity check.",
                model.display_name
            );
        }
        let dir = model_dir(models_root, model);
        let _load = super::super::local_model_load::admit_text_embedding(
            &[&dir],
            super::super::local_model_load::NativeAllocation::Constructor,
        )?;
        let tokenizer_bytes = verified_bytes(&dir, model.pin(model.tokenizer)?)?;
        let mut tokenizer = tokenizers::Tokenizer::from_bytes(&tokenizer_bytes)
            .map_err(|error| anyhow!("Failed to load the search model tokenizer: {error}"))?;
        tokenizer
            .with_truncation(None)
            .map_err(|error| anyhow!("Failed to configure the search model tokenizer: {error}"))?;
        tokenizer.with_padding(None);
        let pad_id = ["<pad>", "[PAD]", "<|endoftext|>"]
            .iter()
            .find_map(|token| tokenizer.token_to_id(token))
            .unwrap_or(0);
        // Keep the verified descriptor alive while ONNX opens the graph.
        // This avoids a second whole-file allocation, up to 585 MiB for
        // the self-contained graph. External weights go to ort's in-memory
        // initializer API, so relative paths cannot escape verification.
        #[cfg(unix)]
        let graph = verified_graph(&dir, model.pin(model.graph)?)?;
        // A Windows load path names the original path rather than an open
        // descriptor. Keep the checked bytes so a rename cannot redirect ONNX
        // between hashing and loading.
        #[cfg(not(unix))]
        let graph = verified_bytes(&dir, model.pin(model.graph)?)?;
        let weights = match model.external_data {
            Some(name) => Some((name, external_weights(&dir, model.pin(name)?)?)),
            None => None,
        };
        let builder = Session::builder()
            .context("Failed to create an ONNX session builder")?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|error| anyhow!("Failed to set ONNX optimization: {error}"))?
            .with_intra_threads(4)
            .map_err(|error| anyhow!("Failed to set ONNX threads: {error}"))?;
        let mut builder = match &weights {
            Some((name, weights)) => builder
                // SAFETY: `Resident` keeps `weights` alive and drops it after
                // the session that reads it.
                .with_external_initializer_file_in_memory(name, unsafe { weights.for_session() })
                .map_err(|error| anyhow!("Failed to attach the search model weights: {error}"))?,
            None => builder,
        };
        #[cfg(unix)]
        let session = graph.load(|path| {
            builder
                .commit_from_file(path)
                .map_err(|error| anyhow!("Failed to load {}: {error}", model.display_name))
        })?;
        #[cfg(not(unix))]
        let session = builder
            .commit_from_memory(&graph)
            .map_err(|error| anyhow!("Failed to load {}: {error}", model.display_name))?;
        Ok(Resident {
            model_id: model.id,
            session,
            tokenizer,
            pad_id,
            _weights: weights.map(|(_, weights)| weights),
        })
    }

    pub(super) fn embed(
        models_root: &Path,
        model: &'static BuiltinEmbeddingModel,
        role: TextRole,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > BATCH {
            anyhow::bail!("Too many texts for one search-model batch.");
        }
        let mut slot = resident().lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|value| value.model_id != model.id) {
            *slot = None;
            *slot = Some(load(models_root, model)?);
        }
        let resident = slot.as_mut().expect("the search model was just loaded");
        let prepared: Vec<String> = texts
            .iter()
            .map(|text| prepared_text(model, role, text))
            .collect();
        let encodings = resident
            .tokenizer
            .encode_batch(prepared, true)
            .map_err(|error| anyhow!("Failed to tokenize text for search: {error}"))?;
        let rows: Vec<Vec<u32>> = encodings
            .iter()
            .map(|encoding| {
                let ids = encoding.get_ids();
                if ids.len() <= model.max_tokens {
                    return ids.to_vec();
                }
                // Keep the final special token: last-token models read it.
                let mut cut = ids[..model.max_tokens - 1].to_vec();
                cut.push(*ids.last().expect("a long input has a last token"));
                cut
            })
            .collect();
        let width = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
        let batch = rows.len();
        let left = model.pooling == Pooling::LastToken;
        let mut input_ids = vec![i64::from(resident.pad_id); batch * width];
        let mut mask = vec![0_i64; batch * width];
        for (row, ids) in rows.iter().enumerate() {
            let offset = if left { width - ids.len() } else { 0 };
            for (column, id) in ids.iter().enumerate() {
                input_ids[row * width + offset + column] = i64::from(*id);
                mask[row * width + offset + column] = 1;
            }
        }
        let dir = model_dir(models_root, model);
        let host_bytes = (batch * width * model.dimensions * 4 * 32) as u64;
        let _working = super::super::local_model_load::admit_text_embedding(
            &[&dir],
            super::super::local_model_load::NativeAllocation::Inference { host_bytes },
        )?;
        let wanted: Vec<(String, Vec<i64>)> = resident
            .session
            .inputs()
            .iter()
            .map(|input| {
                let shape = match input.dtype() {
                    ort::value::ValueType::Tensor { shape, .. } => shape.iter().copied().collect(),
                    _ => Vec::new(),
                };
                (input.name().to_string(), shape)
            })
            .collect();
        let fixed = |shape: &[i64], index: usize, name: &str| -> Result<usize> {
            shape
                .get(index)
                .and_then(|dim| usize::try_from(*dim).ok())
                .ok_or_else(|| anyhow!("The search model input {name} has an unexpected shape."))
        };
        let mut inputs: Vec<(String, ort::session::SessionInputValue<'_>)> = Vec::new();
        for (name, shape) in wanted {
            // Multimodal exports (EmbeddingGemma 2) take image, video and
            // audio features beside the text; text search passes none.
            if name.ends_with("_features") {
                let width = fixed(&shape, shape.len().saturating_sub(1), &name)?;
                let tensor = Tensor::from_array(([0_usize, width], Vec::<f32>::new()))
                    .with_context(|| format!("Failed to build the empty {name} tensor"))?;
                inputs.push((name, tensor.into()));
                continue;
            }
            // Decoder exports (Qwen3 Embedding) take a key/value cache; one
            // pass over the whole text starts from an empty one.
            if name.starts_with("past_key_values") {
                let heads = fixed(&shape, 1, &name)?;
                let head_dim = fixed(&shape, 3, &name)?;
                let tensor = Tensor::from_array(([batch, heads, 0, head_dim], Vec::<f32>::new()))
                    .with_context(|| format!("Failed to build the empty {name} tensor"))?;
                inputs.push((name, tensor.into()));
                continue;
            }
            let values = match name.as_str() {
                "input_ids" => input_ids.clone(),
                "attention_mask" => mask.clone(),
                "token_type_ids" => vec![0_i64; batch * width],
                "position_ids" => {
                    let mut positions = vec![0_i64; batch * width];
                    for row in 0..batch {
                        let mut next = 0_i64;
                        for column in 0..width {
                            if mask[row * width + column] == 1 {
                                positions[row * width + column] = next;
                                next += 1;
                            }
                        }
                    }
                    positions
                }
                other => anyhow::bail!("The search model asks for an unknown input {other}."),
            };
            let tensor = Tensor::from_array(([batch, width], values))
                .with_context(|| format!("Failed to build the {name} tensor"))?;
            inputs.push((name, tensor.into()));
        }
        let outputs = resident
            .session
            .run(inputs)
            .context("The search model failed to run")?;
        let vectors = match model.pooling {
            Pooling::SentenceOutput => {
                let (shape, data) = outputs
                    .get("sentence_embedding")
                    .ok_or_else(|| anyhow!("The search model has no sentence_embedding output"))?
                    .try_extract_tensor::<f32>()
                    .context("Failed to read the search model output")?;
                if shape.len() != 2 || shape[0] as usize != batch {
                    anyhow::bail!("The search model returned an unexpected shape.");
                }
                let dims = shape[1] as usize;
                data.chunks_exact(dims)
                    .map(<[f32]>::to_vec)
                    .collect::<Vec<_>>()
            }
            Pooling::LastToken => {
                let (shape, data) = outputs
                    .get("last_hidden_state")
                    .ok_or_else(|| anyhow!("The search model has no last_hidden_state output"))?
                    .try_extract_tensor::<f32>()
                    .context("Failed to read the search model output")?;
                if shape.len() != 3 || shape[0] as usize != batch || shape[1] as usize != width {
                    anyhow::bail!("The search model returned an unexpected shape.");
                }
                let hidden = shape[2] as usize;
                (0..batch)
                    .map(|row| {
                        // Left padding puts every last real token in the last column.
                        let token = width - 1;
                        let start = (row * width + token) * hidden;
                        data[start..start + hidden].to_vec()
                    })
                    .collect()
            }
        };
        let mut normalized = Vec::with_capacity(vectors.len());
        for mut vector in vectors {
            if vector.len() < model.dimensions {
                anyhow::bail!("The search model returned a short vector.");
            }
            // Matryoshka models keep their leading dimensions meaningful.
            vector.truncate(model.dimensions);
            let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
            if !norm.is_finite() || norm == 0.0 {
                anyhow::bail!("The search model returned an unusable vector.");
            }
            vector.iter_mut().for_each(|value| *value /= norm);
            normalized.push(vector);
        }
        Ok(normalized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    #[ignore = "requires the exact helper, owned pinned models, 8 GB/2.5 GiB simulation and a real away window; run alone in a build slot"]
    fn owned_light_away_meeting_becomes_searchable() {
        assert_eq!(
            crate::hardware_tier::current(),
            crate::hardware_tier::HardwareTier::Light
        );
        assert_eq!(
            std::env::var(crate::hardware_tier::SIMULATED_AVAILABLE_MEMORY_ENV).as_deref(),
            Ok("2.5")
        );
        let root = PathBuf::from(std::env::var("PLAINSONG_PRESSURE_PROBE_MODELS").unwrap());
        let selected = model(DEFAULT_MODEL_ID).unwrap();
        let scratch = crate::test_fs::TempDir::new("index-away-meeting");
        let mut db =
            crate::db::Database::open_at_path(&scratch.path().join("meeting.db"), None).unwrap();
        let now = chrono::Utc::now();
        let recording = serde_json::from_value(serde_json::json!({
            "id": "away-meeting", "title": "Synthetic launch review", "projectId": "inbox", "duration": 600,
            "createdAt": now, "updatedAt": now, "sourceType": "meeting", "audioPath": "",
            "status": "processing", "transcriptComplete": true,
        })).unwrap();
        db.create_recording(&recording).unwrap();
        let segments: Vec<_> = (0..9)
            .map(|index| crate::models::TranscriptSegment {
                id: format!("s{index}"),
                start_time: index as f64 * 60.0,
                end_time: index as f64 * 60.0 + 20.0,
                text: "Priya will review the launch checklist before the beta ships. ".repeat(8),
                speaker_id: None,
                confidence: 1.0,
            })
            .collect();
        db.save_completed_transcript(&crate::models::Transcript {
            heard_through_speakers: Vec::new(),
            id: "t-away".into(),
            recording_id: "away-meeting".into(),
            full_text: segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            segments: segments.clone(),
            language: "en".into(),
            confidence: 1.0,
            model: "fixture".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: false,
            created_at: now,
        })
        .unwrap();
        let key = crate::semantic_index::index_key(crate::semantic_index::SemanticRoute::BuiltIn(
            selected.id,
        ));
        assert_eq!(db.semantic_index_coverage(&key).unwrap(), (0, 1));
        assert!(!db
            .search_transcripts("checklist", 10, None)
            .unwrap()
            .is_empty());
        // No fake idle, pressure or power counters authorize this run.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        while !crate::llm::notes_window::away() {
            assert!(
                std::time::Instant::now() < deadline,
                "real away window did not open"
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let started = std::time::Instant::now();
        let run = EmbeddingRun::new(&root, selected);
        let output = helper_call(
            &run,
            HelperWork::Windows {
                recording_id: "away-meeting".into(),
                segments,
            },
            None,
        )
        .unwrap();
        let HelperOutput::Windows { windows } = output else {
            panic!("expected windows")
        };
        let windows: Vec<crate::llm::GroundedSegment> =
            windows.into_iter().map(Into::into).collect();
        assert!(
            windows.len() > BATCH,
            "exercise helper reuse across batches"
        );
        let mut vectors = Vec::new();
        let mut samples = Vec::new();
        for batch in windows.chunks(BATCH) {
            let output = helper_call(
                &run,
                HelperWork::Embed {
                    role: TextRole::Document,
                    texts: batch.iter().map(|w| w.text.clone()).collect(),
                },
                Some(|| false),
            )
            .unwrap();
            let HelperOutput::Embeddings { vectors: rows } = output else {
                panic!("expected vectors")
            };
            assert_eq!(rows.len(), batch.len());
            assert!(rows
                .iter()
                .all(|v| v.len() == selected.dimensions && v.iter().all(|n| n.is_finite())));
            vectors.extend(rows);
            let pid = run.helper.lock().unwrap().as_ref().unwrap().child.id();
            let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
            // SAFETY: the kernel writes the matching rusage version into this storage.
            assert_eq!(
                unsafe {
                    libc::proc_pid_rusage(
                        pid as i32,
                        libc::RUSAGE_INFO_V4,
                        info.as_mut_ptr().cast(),
                    )
                },
                0
            );
            // SAFETY: the successful call initialized the structure.
            let info = unsafe { info.assume_init() };
            samples.push(
                serde_json::json!({"pid":pid,"footprintBytes":info.ri_phys_footprint,
                "peakFootprintBytes":info.ri_lifetime_max_phys_footprint}),
            );
        }
        let fingerprint = db.transcript_fingerprint("away-meeting").unwrap().unwrap();
        let rows: Vec<_> = windows.into_iter().zip(vectors).collect();
        assert!(db
            .replace_recording_embeddings("away-meeting", &fingerprint, &key, &rows)
            .unwrap());
        assert_eq!(db.semantic_index_coverage(&key).unwrap(), (1, 1));
        assert!(db
            .recordings_missing_semantic_index(&key, 10)
            .unwrap()
            .is_empty());
        run.close();
        assert!(run.helper.lock().unwrap().is_none());
        std::fs::write(
            std::env::var("PLAINSONG_PRESSURE_PROBE_OUT").unwrap(),
            serde_json::to_vec_pretty(
                &serde_json::json!({"model":selected.id,"windows":rows.len(),
                "indexedRecordings":1,"keywordSearchBeforeEmbeddings":true,
                "elapsedMs":started.elapsed().as_millis(),"samples":samples}),
            )
            .unwrap(),
        )
        .unwrap();
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    #[ignore = "requires the exact sidecar helper, QA model root and native headroom; run alone in a build slot"]
    fn measure_search_pressure_release() {
        use crate::hardware_tier::HardwareTier;
        use crate::memory_pressure::MemoryPressure;
        use crate::model_residency::Policy;
        fn memory(pid: u32) -> Option<serde_json::Value> {
            let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
            // SAFETY: matching storage for the requested kernel structure.
            if unsafe {
                libc::proc_pid_rusage(pid as i32, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast())
            } != 0
            {
                return None;
            }
            // SAFETY: the successful kernel call initialized the structure.
            let info = unsafe { info.assume_init() };
            Some(
                serde_json::json!({ "pid": pid, "residentBytes": info.ri_resident_size, "footprintBytes": info.ri_phys_footprint }),
            )
        }
        let root = PathBuf::from(std::env::var("PLAINSONG_PRESSURE_PROBE_MODELS").unwrap());
        let run = EmbeddingRun::new(&root, model(DEFAULT_MODEL_ID).unwrap());
        let mut rows = Vec::new();
        let mut expected = None;
        for pass in 0..2 {
            let started = std::time::Instant::now();
            let output = helper_call(
                &run,
                HelperWork::Embed {
                    role: TextRole::Query,
                    texts: vec!["Avery will review the notes.".into()],
                },
                None,
            )
            .unwrap();
            let request_ms = started.elapsed().as_secs_f64() * 1000.0;
            let HelperOutput::Embeddings { vectors } = output else {
                panic!("expected real vectors")
            };
            assert_eq!(vectors.len(), 1);
            assert_eq!(vectors[0].len(), run.model.dimensions);
            assert!(vectors[0].iter().all(|v| v.is_finite()));
            if let Some(expected) = &expected {
                assert_eq!(&vectors, expected);
            } else {
                expected = Some(vectors);
            }
            let pid = run.helper.lock().unwrap().as_ref().unwrap().child.id();
            let before = memory(pid).unwrap();
            // Holding the real job lock represents an in-flight batch.
            {
                let busy = run.helper.lock().unwrap();
                run._residency.check(Policy {
                    tier: HardwareTier::Light,
                    pressure: MemoryPressure::Warning,
                });
                assert!(busy.is_some());
            }
            let started = std::time::Instant::now();
            run._residency.check(Policy {
                tier: HardwareTier::Light,
                pressure: MemoryPressure::Warning,
            });
            let release_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert!(run.helper.lock().unwrap().is_none());
            assert!(memory(pid).is_none());
            rows.push(serde_json::json!({ "model": run.model.id, "pass": pass, "requestMs": request_ms,
                "releaseMs": release_ms, "before": before, "afterHelperBytes": 0, "vectorsMatched": true }));
        }
        std::fs::write(
            std::env::var("PLAINSONG_PRESSURE_PROBE_OUT").unwrap(),
            serde_json::to_vec_pretty(&rows).unwrap(),
        )
        .unwrap();
    }

    #[cfg(all(feature = "local-embeddings", unix))]
    #[cfg(feature = "local-embeddings")]
    #[tokio::test]
    #[ignore = "requires app-pinned model files in an owned QA folder"]
    async fn owned_embedding_release_waits_for_a_busy_runtime() {
        let root =
            std::path::PathBuf::from(std::env::var("PLAINSONG_EMBEDDING_SMOKE_ROOT").unwrap());
        let selected = model(DEFAULT_MODEL_ID).unwrap();
        for pin in selected.artifacts {
            assert!(crate::download::verify_or_record_model_integrity(
                &model_dir(&root, selected).join(pin.local_name),
                Some(pin.sha256)
            )
            .await
            .unwrap());
        }
        let vectors = embed_blocking(
            &root,
            selected,
            TextRole::Query,
            &["Review the beta notes.".to_string()],
        )
        .unwrap();
        assert_eq!(vectors[0].len(), selected.dimensions);
        let held = super::super::local_model_load::acquire_cleanup_gate()
            .await
            .unwrap();
        let mut release = Box::pin(async {
            if std::env::var_os("PLAINSONG_TEST_LEGACY_EMBED_RELEASE").is_some() {
                legacy_release_now().await;
            } else {
                release_now().await;
            }
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut release)
                .await
                .is_err(),
            "completed search work must wait for the runtime before releasing its model"
        );
        drop(held);
        release.await;
        assert!(!runtime::has_resident());
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn helper_window_wire_preserves_text_and_source_spans() {
        let original = crate::llm::GroundedSegment {
            recording_id: "fixture-recording".to_string(),
            segment_id: "fixture-segment".to_string(),
            text: "Priya said résumé, 14, and do not send it.".to_string(),
            start_time: 1.25,
            end_time: 4.5,
        };
        let encoded = serde_json::to_vec(&WindowWire::from(original.clone())).unwrap();
        let restored: WindowWire = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(crate::llm::GroundedSegment::from(restored), original);
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn helper_protocol_rejects_unknown_work_and_missing_ownership() {
        assert!(serde_json::from_str::<HelperRequest>(r#"{"version":1,"model_id":"embeddinggemma-2","models_root":"/tmp/models","work":{"kind":"shell","command":"echo no"}}"#).is_err());
        let reply = HelperResponse {
            version: HELPER_PROTOCOL,
            result: Err("memory admission refused".to_string()),
            qa_snapshot: None,
        };
        let encoded = serde_json::to_vec(&reply).unwrap();
        let decoded: HelperResponse = serde_json::from_slice(&encoded).unwrap();
        assert!(decoded.result.is_err());
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[tokio::test]
    async fn external_weights_are_mapped_from_the_verified_file_not_copied() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("plainsong-weights-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes: Vec<u8> = (0..(1 << 20)).map(|index| (index % 251) as u8).collect();
        let path = dir.join("weights.onnx_data");
        std::fs::write(&path, &bytes).unwrap();
        let pin = EmbeddingArtifact {
            repo: "fixture",
            revision: "fixture",
            hf_path: "weights.onnx_data",
            local_name: "weights.onnx_data",
            sha256: Box::leak(hex::encode(Sha256::digest(&bytes)).into_boxed_str()),
            size_bytes: bytes.len() as u64,
        };
        let wrong = EmbeddingArtifact {
            sha256: Box::leak("0".repeat(64).into_boxed_str()),
            ..pin
        };
        let refused = runtime::external_weights(&dir, &wrong)
            .err()
            .expect("weights that do not match their pin must not load");
        assert!(refused.to_string().contains("failed its integrity check"));
        let before = crate::download::full_hash_count_for_tests(&path);
        let weights = runtime::external_weights(&dir, &pin).unwrap();
        assert_eq!(weights.bytes(), &bytes[..]);
        assert_eq!(
            crate::download::full_hash_count_for_tests(&path),
            before + 1,
            "the mapped bytes are hashed once, and nothing else is"
        );
        // A heap copy has no backing file; a mapping names the weights file.
        let backing_file = |address: *const u8| {
            let mut name = vec![0_u8; libc::PATH_MAX as usize];
            // SAFETY: the buffer is PATH_MAX bytes and the address is mapped.
            let written = unsafe {
                libc::proc_regionfilename(
                    libc::getpid(),
                    address as u64,
                    name.as_mut_ptr().cast(),
                    name.len() as u32,
                )
            };
            String::from_utf8_lossy(&name[..written.max(0) as usize]).into_owned()
        };
        assert!(!backing_file(bytes.as_ptr()).ends_with("weights.onnx_data"));
        let backing = backing_file(weights.bytes().as_ptr());
        assert!(
            backing.ends_with("weights.onnx_data"),
            "weights are backed by {backing:?}"
        );
        drop(weights);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(all(feature = "local-embeddings", unix))]
    #[test]
    fn a_hashed_graph_remains_readable_through_its_original_descriptor() {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Seek, Write};
        let path = std::env::temp_dir().join(format!("plainsong-graph-{}", uuid::Uuid::new_v4()));
        let mut original = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        std::fs::remove_file(path).unwrap();
        original.write_all(b"verified graph bytes").unwrap();
        original.rewind().unwrap();
        let mut verifier = original.try_clone().unwrap();
        assert_eq!(
            runtime::hash_and_rewind(&mut verifier).unwrap(),
            hex::encode(Sha256::digest(b"verified graph bytes"))
        );
        let mut loaded = Vec::new();
        original.read_to_end(&mut loaded).unwrap();
        assert_eq!(
            loaded, b"verified graph bytes",
            "the loader must read the graph after hashing"
        );
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn helper_requests_carry_no_claim_about_the_model_files() {
        let request = HelperRequest {
            version: HELPER_PROTOCOL,
            parent_pid: 42,
            qa_root_pid: None,
            away_admission: false,
            models_root: PathBuf::from("/tmp/models"),
            model_id: DEFAULT_MODEL_ID.to_string(),
            work: HelperWork::Embed {
                role: TextRole::Query,
                texts: vec!["notes".to_string()],
            },
        };
        let mut wire: serde_json::Value = serde_json::to_value(&request).unwrap();
        assert!(wire.get("verified").is_none());
        wire["verified"] = serde_json::json!([{
            "local_name": "model.onnx",
            "sha256": "0".repeat(64),
            "identity": {}
        }]);
        assert!(
            serde_json::from_value::<HelperRequest>(wire).is_err(),
            "a request that vouches for files is refused, not ignored"
        );
    }

    /// A tokenizer-only model: the windows work needs nothing else, and a
    /// real tokenizer file is a few megabytes.
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    fn fixture_tokenizer_model(sha256: &str) -> &'static BuiltinEmbeddingModel {
        let id: &'static str =
            Box::leak(format!("fixture-{}", uuid::Uuid::new_v4()).into_boxed_str());
        let artifacts: &'static [EmbeddingArtifact] = Box::leak(Box::new([EmbeddingArtifact {
            repo: "fixture",
            revision: "fixture",
            hf_path: "tokenizer.json",
            local_name: "tokenizer.json",
            sha256: Box::leak(sha256.to_string().into_boxed_str()),
            size_bytes: 1,
        }]));
        let base = model(DEFAULT_MODEL_ID).unwrap();
        Box::leak(Box::new(BuiltinEmbeddingModel {
            id,
            tokenizer: "tokenizer.json",
            artifacts,
            ..*base
        }))
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    const FIXTURE_TOKENIZER: &str = r#"{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],"normalizer":null,"pre_tokenizer":{"type":"Whitespace"},"post_processor":null,"decoder":null,"model":{"type":"WordLevel","vocab":{"[UNK]":0,"do":1,"not":2,"send":3,"it":4},"unk_token":"[UNK]"}}"#;

    /// Serve `requests` window requests through one helper loop. Fixture
    /// runs share the window tokenizer slot, so they take turns, and a run
    /// whose admission found another test holding the native runtime is
    /// served again.
    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    fn serve_fixture(
        selected: &'static BuiltinEmbeddingModel,
        root: &Path,
        requests: usize,
    ) -> Vec<HelperResponse> {
        static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _turn = TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for _ in 0..200 {
            let replies = serve_fixture_once(selected, root, requests);
            let busy = replies.iter().any(|reply| {
                reply
                    .result
                    .as_ref()
                    .is_err_and(|error| super::super::native_runtime_gate::is_operation_busy(error))
            });
            if !busy {
                return replies;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("the native runtime stayed busy");
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    fn serve_fixture_once(
        selected: &'static BuiltinEmbeddingModel,
        root: &Path,
        requests: usize,
    ) -> Vec<HelperResponse> {
        static FIXTURES: std::sync::Mutex<Vec<&'static BuiltinEmbeddingModel>> =
            std::sync::Mutex::new(Vec::new());
        FIXTURES.lock().unwrap().push(selected);
        fn lookup(id: &str) -> Option<&'static BuiltinEmbeddingModel> {
            FIXTURES
                .lock()
                .unwrap()
                .iter()
                .copied()
                .find(|model| model.id == id)
        }
        let mut input = Vec::new();
        for index in 0..requests {
            let request = HelperRequest {
                version: HELPER_PROTOCOL,
                parent_pid: 42,
                qa_root_pid: None,
                away_admission: false,
                models_root: root.to_path_buf(),
                model_id: selected.id.to_string(),
                work: HelperWork::Windows {
                    recording_id: format!("recording-{index}"),
                    segments: vec![crate::models::TranscriptSegment {
                        id: "s1".to_string(),
                        start_time: 0.0,
                        end_time: 1.0,
                        text: "do not send it".to_string(),
                        speaker_id: None,
                        confidence: 1.0,
                    }],
                },
            };
            write_frame(&mut input, &serde_json::to_vec(&request).unwrap()).unwrap();
        }
        let clock = HelperClock::new();
        let context = HelperContext {
            models_root: std::fs::canonicalize(root).unwrap(),
            parent_pid: 42,
            model: lookup,
            clock: &clock,
        };
        let mut output = Vec::new();
        serve_helper(&mut input.as_slice(), &mut output, &context).unwrap();
        let mut replies = Vec::new();
        let mut reader = output.as_slice();
        while let Some(frame) = read_frame(&mut reader).unwrap() {
            replies.push(serde_json::from_slice(&frame).unwrap());
        }
        assert!(!clock.stalled());
        replies
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn one_helper_serves_a_whole_job_and_hashes_the_tokenizer_once() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("plainsong-helper-{}", uuid::Uuid::new_v4()));
        let selected = fixture_tokenizer_model(&hex::encode(Sha256::digest(FIXTURE_TOKENIZER)));
        let dir = model_dir(&root, selected);
        std::fs::create_dir_all(&dir).unwrap();
        let tokenizer = dir.join("tokenizer.json");
        std::fs::write(&tokenizer, FIXTURE_TOKENIZER).unwrap();

        let replies = serve_fixture(selected, &root, 3);
        assert_eq!(replies.len(), 3, "one helper answered every batch");
        for reply in &replies {
            let Ok(HelperOutput::Windows { windows }) = &reply.result else {
                panic!("windows failed: {:?}", reply.result.as_ref().err());
            };
            assert_eq!(windows.len(), 1);
            assert_eq!(windows[0].text, "do not send it");
        }
        assert_eq!(
            crate::download::full_hash_count_for_tests(&tokenizer),
            1,
            "the tokenizer is hashed once per job, not once per batch"
        );
        runtime::release_tokenizer();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn the_helper_refuses_a_tokenizer_that_does_not_match_its_pin() {
        let root = std::env::temp_dir().join(format!("plainsong-helper-{}", uuid::Uuid::new_v4()));
        let selected = fixture_tokenizer_model(&"0".repeat(64));
        let dir = model_dir(&root, selected);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tokenizer.json"), FIXTURE_TOKENIZER).unwrap();

        let replies = serve_fixture(selected, &root, 2);
        assert_eq!(replies.len(), 2);
        for reply in replies {
            let error = reply
                .result
                .err()
                .expect("a mismatched tokenizer is refused");
            assert!(error.contains("Download the model again"), "{error}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(target_os = "macos", feature = "local-embeddings"))]
    #[test]
    fn a_helper_refuses_to_switch_models_mid_job() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("plainsong-helper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let selected = fixture_tokenizer_model(&hex::encode(Sha256::digest(FIXTURE_TOKENIZER)));
        let mut input = Vec::new();
        for id in [selected.id, DEFAULT_MODEL_ID] {
            let request = HelperRequest {
                version: HELPER_PROTOCOL,
                parent_pid: 42,
                qa_root_pid: None,
                away_admission: false,
                models_root: root.clone(),
                model_id: id.to_string(),
                work: HelperWork::Embed {
                    role: TextRole::Query,
                    texts: Vec::new(),
                },
            };
            write_frame(&mut input, &serde_json::to_vec(&request).unwrap()).unwrap();
        }
        let clock = HelperClock::new();
        let context = HelperContext {
            models_root: std::fs::canonicalize(&root).unwrap(),
            parent_pid: 42,
            model: |_| None,
            clock: &clock,
        };
        let error = serve_helper(&mut input.as_slice(), &mut Vec::new(), &context).unwrap_err();
        assert!(error.to_string().contains("different model"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "local-embeddings")]
    #[tokio::test]
    #[ignore = "requires app-pinned model files in an owned QA folder"]
    async fn owned_embedding_model_loads_and_releases() {
        let root =
            std::path::PathBuf::from(std::env::var("PLAINSONG_EMBEDDING_SMOKE_ROOT").unwrap());
        let selected = model(DEFAULT_MODEL_ID).unwrap();
        let dir = model_dir(&root, selected);
        for pin in selected.artifacts {
            assert!(crate::download::verify_or_record_model_integrity(
                &dir.join(pin.local_name),
                Some(pin.sha256)
            )
            .await
            .unwrap());
        }
        #[cfg(target_os = "macos")]
        fn measure(phase: &str) {
            let output = std::process::Command::new("/usr/bin/footprint")
                .args(["-f", "bytes", "-p", &std::process::id().to_string()])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            let bytes = text.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("phys_footprint:")
                    .and_then(|value| value.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
            });
            eprintln!(
                "EMBEDDING_FOOTPRINT {}",
                serde_json::json!({"phase":phase,"pid":std::process::id(),"bytes":bytes,"cachedModel":runtime::has_resident()})
            );
        }
        #[cfg(target_os = "macos")]
        measure("before");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        if let Some(snapshot) = super::super::ollama_prewarm_policy::measured_memory_snapshot() {
            eprintln!(
                "EMBEDDING_ADMISSION {}",
                serde_json::json!({
                    "physicalBytes": snapshot.physical_bytes,
                    "availableBytes": snapshot.available_bytes,
                    "pressureLevel": snapshot.pressure_level,
                })
            );
        }
        let documents = vec![
            "Priya will review the notes before we ship the beta on the fourteenth.".to_string(),
            "Blue whales live in the Pacific Ocean.".to_string(),
        ];
        let vectors = embed_blocking(&root, selected, TextRole::Document, &documents).unwrap();
        let query =
            embed_blocking(&root, selected, TextRole::Query, &[documents[0].clone()]).unwrap();
        assert_eq!(vectors.len(), 2);
        for vector in vectors.iter().chain(query.iter()) {
            assert_eq!(vector.len(), selected.dimensions);
            assert!(vector.iter().all(|value| value.is_finite()));
            let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 0.001);
        }
        let similarity =
            |vector: &[f32]| query[0].iter().zip(vector).map(|(a, b)| a * b).sum::<f32>();
        assert!(similarity(&vectors[0]) > similarity(&vectors[1]));
        #[cfg(target_os = "macos")]
        measure("loaded");
        release_now().await;
        assert!(
            !runtime::has_resident(),
            "completed search work must release its model"
        );
        #[cfg(target_os = "macos")]
        measure("released");
    }

    #[test]
    fn the_catalog_is_complete_and_pinned() {
        assert_eq!(MODELS.len(), 3);
        assert!(model(DEFAULT_MODEL_ID).is_some());
        let mut ids = std::collections::HashSet::new();
        for model in MODELS {
            assert!(ids.insert(model.id));
            for name in [
                Some(model.graph),
                model.external_data,
                Some(model.tokenizer),
            ]
            .into_iter()
            .flatten()
            {
                assert!(model.pin(name).is_ok(), "{} lacks {name}", model.id);
            }
            for entry in model.artifacts {
                assert_eq!(entry.sha256.len(), 64);
                assert!(entry.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert_eq!(entry.revision.len(), 40);
                assert!(entry.size_bytes > 0);
            }
        }
        assert_eq!(model_or_default("missing").id, DEFAULT_MODEL_ID);
    }

    #[test]
    fn the_default_is_apache_2_and_needs_no_acceptance() {
        assert_eq!(DEFAULT_MODEL_ID, "embeddinggemma-2");
        assert_eq!(MODELS[0].id, DEFAULT_MODEL_ID);
        let default = model(DEFAULT_MODEL_ID).unwrap();
        assert_eq!(default.license, "Apache-2.0");
        assert!(!default.requires_terms_acceptance);
        assert!(terms_accepted(default, &[]));
        assert_eq!(default.use_policy_url, Some(GEMMA_PROHIBITED_USE_URL));
        assert!(default
            .notice
            .is_some_and(|notice| notice.contains(GEMMA_PROHIBITED_USE_URL)));
        // Every model that needs acceptance says what it needs it for.
        for model in MODELS
            .iter()
            .filter(|model| model.requires_terms_acceptance)
        {
            assert!(model.notice.is_some(), "{} has no NOTICE", model.id);
            assert!(
                model.use_policy_url.is_some(),
                "{} has no use policy",
                model.id
            );
        }
    }

    #[test]
    fn gemma_300m_needs_its_terms_accepted_and_carries_the_required_notice() {
        let gemma = model("embeddinggemma-300m").unwrap();
        assert!(gemma.requires_terms_acceptance);
        assert_eq!(gemma.terms_url, GEMMA_TERMS_URL);
        let notice = gemma.notice.unwrap();
        assert!(notice.starts_with(
            "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms\n"
        ));
        assert!(notice.contains("modified version"));
        assert!(notice.contains(GEMMA_PROHIBITED_USE_URL));
        let accepted =
            |model_id: &str, terms_url: &str| crate::settings::EmbeddingTermsAcceptance {
                model_id: model_id.into(),
                terms_url: terms_url.into(),
                accepted_at: "2026-10-21T00:00:00Z".into(),
            };
        assert!(!terms_accepted(gemma, &[]));
        assert!(!terms_accepted(
            gemma,
            &[accepted("embeddinggemma-2", GEMMA_TERMS_URL)]
        ));
        assert!(!terms_accepted(
            gemma,
            &[accepted(gemma.id, "https://example.com/old-terms")]
        ));
        assert!(terms_accepted(
            gemma,
            &[accepted(gemma.id, GEMMA_TERMS_URL)]
        ));
    }

    #[tokio::test]
    async fn the_300m_download_is_refused_without_a_recorded_acceptance() {
        let root =
            std::env::temp_dir().join(format!("plainsong-embedding-terms-{}", std::process::id()));
        let gemma = model("embeddinggemma-300m").unwrap();
        let error = download(&root, gemma, &[], |_| {}).await.unwrap_err();
        assert!(
            error.to_string().contains("accept the Gemma Terms of Use"),
            "{error}"
        );
        // Refused before anything touches the disk or the network.
        assert!(!model_dir(&root, gemma).exists());
        assert!(!download_active());
    }

    /// Manual parity check against vectors computed outside the app.
    /// `PLAINSONG_EMBEDDING_PARITY=<models root>:<model id>:<reference json>`
    /// where the JSON is `[{"role": "query"|"document", "text": ..., "vector": [...]}]`.
    /// The models root must already hold the pinned files; the download path
    /// verifies them by SHA-256 without fetching anything.
    #[cfg(feature = "local-embeddings")]
    #[tokio::test]
    #[ignore = "needs downloaded model files; run by hand"]
    async fn matches_reference_vectors() {
        let spec =
            std::env::var("PLAINSONG_EMBEDDING_PARITY").expect("set PLAINSONG_EMBEDDING_PARITY");
        let mut parts = spec.splitn(3, ':');
        let root = std::path::PathBuf::from(parts.next().unwrap());
        let id = parts.next().unwrap();
        let model = model(id).unwrap_or_else(|| panic!("unknown model {id:?} in {spec:?}"));
        let reference: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(parts.next().unwrap()).unwrap()).unwrap();
        let accepted = [crate::settings::EmbeddingTermsAcceptance {
            model_id: model.id.to_string(),
            terms_url: model.terms_url.to_string(),
            accepted_at: "by hand".to_string(),
        }];
        download(&root, model, &accepted, |_| {}).await.unwrap();
        assert!(artifacts_installed(&root, model));
        let started = std::time::Instant::now();
        let mut lowest = f32::MAX;
        for item in &reference {
            let role = if item["role"] == "query" {
                TextRole::Query
            } else {
                TextRole::Document
            };
            let text = item["text"].as_str().unwrap().to_string();
            let vector = embed_blocking(&root, model, role, &[text])
                .unwrap()
                .remove(0);
            let expected: Vec<f32> = item["vector"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap() as f32)
                .collect();
            let cosine: f32 = vector.iter().zip(&expected).map(|(a, b)| a * b).sum();
            eprintln!("cosine {cosine:.4} for {}", item["text"]);
            lowest = lowest.min(cosine);
        }
        let floor: f32 = std::env::var("PLAINSONG_EMBEDDING_PARITY_FLOOR")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0.99);
        assert!(
            lowest > floor,
            "lowest cosine {lowest} is not above {floor}"
        );
        eprintln!(
            "{} reference texts matched in {:?}",
            reference.len(),
            started.elapsed()
        );
        // Optional throughput check: a JSON array of passages to index.
        if let Ok(path) = std::env::var("PLAINSONG_EMBEDDING_BENCH") {
            let texts: Vec<String> =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let started = std::time::Instant::now();
            for batch in texts.chunks(BATCH) {
                embed_blocking(&root, model, TextRole::Document, batch).unwrap();
            }
            let elapsed = started.elapsed();
            let mut query_times = Vec::new();
            for item in reference.iter().cycle().take(20) {
                let text = item["text"].as_str().unwrap().to_string();
                let started = std::time::Instant::now();
                embed_blocking(&root, model, TextRole::Query, &[text]).unwrap();
                query_times.push(started.elapsed());
            }
            query_times.sort();
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
            // SAFETY: getrusage fills the struct it is given.
            let peak = unsafe {
                libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
                usage.assume_init().ru_maxrss
            };
            eprintln!(
                "{} passages in {:?} ({:.1}/s); median query {:?}; peak RSS {:.2} GiB",
                texts.len(),
                elapsed,
                texts.len() as f64 / elapsed.as_secs_f64(),
                query_times[query_times.len() / 2],
                peak as f64 / 1024.0 / 1024.0 / 1024.0
            );
        }
    }

    #[test]
    fn queries_and_passages_get_their_own_prefixes() {
        let model = model(DEFAULT_MODEL_ID).unwrap();
        assert_eq!(
            prepared_text(model, TextRole::Query, " battery? "),
            format!("{}battery?", model.query_prefix)
        );
        assert_eq!(
            prepared_text(model, TextRole::Document, "kinetic"),
            format!("{}kinetic", model.document_prefix)
        );
    }
}
