//! ML-based punctuation and casing restoration for ASR transcripts.
//!
//! Uses the `punct_cap_seg_en.onnx` model from `1-800-BAD-CODE/punctuation_fullstop_truecase_english`
//! which performs punctuation restoration, true-casing (capitalization), and
//! sentence boundary detection in a single pass.
//!
//! # Model contract
//!
//! - **ONNX file**: `punct_cap_seg_en.onnx` (210 MB)
//! - **Tokenizer**: `spe_32k_lc_en.model` (SentencePiece, 32k vocab, 588 KB)
//! - **Input**: lowercased, unpunctuated English text
//! - **Output**: punctuation tokens, casing labels, sentence boundary labels
//! - **Architecture**: 6-layer Transformer encoder (base-sized, 512 dim) with
//!   feed-forward classification heads for punctuation, casing, and SBD
//!
//! # Alternative: ReCasePunct 1 Flash
//!
//! `MihaiPopa-1/ReCasePunct-1-Flash` was the original candidate but is only
//! published as Safetensors (PyTorch format) with a custom
//! `AlbertForPunctuationAndCasing` architecture — no ONNX export exists.
//! Using it would require either exporting to ONNX (Python/PyTorch) or
//! implementing the custom ALBERT variant in Candle. The `punct_cap_seg_en`
//! model was chosen instead because it has a pre-exported ONNX file.
//!
//! # Status
//!
//! The download infrastructure, model registration, and ONNX inference
//! pipeline are complete. The inference pipeline tokenizes input text
//! with SentencePiece, runs the ONNX model, and reassembles text with
//! restored punctuation, capitalization, and sentence boundaries.
//! When the `text-recasepunct` feature is not enabled, the function
//! gracefully falls back to returning the input unchanged.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// HuggingFace repository for the punctuation/casing model.
const PUNCT_CAP_SEG_HF_REPO: &str = "1-800-BAD-CODE/punctuation_fullstop_truecase_english";
const PUNCT_CAP_SEG_HF_REVISION: &str = "1c4d82c3e56c0d2fc01fa827e4362eccf38b8951";

/// Local filenames within the models directory.
const PUNCT_CAP_SEG_LOCAL_ONNX: &str = "punct_cap_seg_en.onnx";
const PUNCT_CAP_SEG_LOCAL_TOKENIZER: &str = "spe_32k_lc_en.model";

/// Maximum download size for the ONNX model (210 MB + headroom).
const PUNCT_CAP_SEG_ONNX_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum download size for the SentencePiece tokenizer (588 KB + headroom).
const PUNCT_CAP_SEG_TOKENIZER_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Model ID used in settings and download manager.
pub const PUNCT_CAP_SEG_MODEL_ID: &str = "punct_cap_seg_en";

/// Returns the directory where the punctuation/casing model is stored.
fn model_dir() -> PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("punctuation")
}

/// Returns the path to the ONNX model file.
pub fn onnx_model_path() -> PathBuf {
    model_dir().join(PUNCT_CAP_SEG_LOCAL_ONNX)
}

/// Returns the path to the SentencePiece tokenizer file.
pub fn tokenizer_path() -> PathBuf {
    model_dir().join(PUNCT_CAP_SEG_LOCAL_TOKENIZER)
}

/// Checks if the punctuation/casing model is downloaded and integrity-verified.
pub fn is_model_available() -> bool {
    let onnx = onnx_model_path();
    let tokenizer = tokenizer_path();
    crate::download::is_model_artifact_trusted(
        &onnx,
        "dd922d459da618cd324280889740608b76fb3e9e61d3f402291be1251f91421b",
    ) && crate::download::is_model_artifact_trusted(
        &tokenizer,
        "9e86d0263de80b3b68327a21f5350c8cdf846e4c4400253c9baf05e3d44871c3",
    )
}

/// Downloads the punctuation/casing model from HuggingFace.
pub async fn download_model(progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
    use crate::download::DownloadManager;

    let dir = model_dir();
    std::fs::create_dir_all(&dir).context("Failed to create punctuation model directory")?;

    let manager = DownloadManager::new()?;
    let progress_cb = std::sync::Arc::new(progress_cb);

    // Download ONNX model
    let onnx_url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        PUNCT_CAP_SEG_HF_REPO, PUNCT_CAP_SEG_HF_REVISION, PUNCT_CAP_SEG_LOCAL_ONNX
    );
    let onnx_dest = dir.join(PUNCT_CAP_SEG_LOCAL_ONNX);
    let cb1 = progress_cb.clone();
    manager
        .download_verified_model_asset(
            &onnx_url,
            &onnx_dest,
            "dd922d459da618cd324280889740608b76fb3e9e61d3f402291be1251f91421b",
            PUNCT_CAP_SEG_ONNX_MAX_BYTES,
            move |p| {
                cb1((p.percentage * 0.9) as f32);
                tracing::info!("PunctCapSeg ONNX download: {:.1}%", p.percentage);
            },
        )
        .await?;

    // Download SentencePiece tokenizer
    let tokenizer_url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        PUNCT_CAP_SEG_HF_REPO, PUNCT_CAP_SEG_HF_REVISION, PUNCT_CAP_SEG_LOCAL_TOKENIZER
    );
    let tokenizer_dest = dir.join(PUNCT_CAP_SEG_LOCAL_TOKENIZER);
    let cb2 = progress_cb.clone();
    manager
        .download_verified_model_asset(
            &tokenizer_url,
            &tokenizer_dest,
            "9e86d0263de80b3b68327a21f5350c8cdf846e4c4400253c9baf05e3d44871c3",
            PUNCT_CAP_SEG_TOKENIZER_MAX_BYTES,
            move |p| {
                cb2((90.0 + p.percentage * 0.1) as f32);
                tracing::info!("PunctCapSeg tokenizer download: {:.1}%", p.percentage);
            },
        )
        .await?;

    tracing::info!("PunctCapSeg model downloaded successfully");
    Ok(())
}

/// ML-based punctuation and casing restoration.
///
/// Takes lowercase, unpunctuated text (as produced by ASR) and returns
/// text with restored punctuation, capitalization, and sentence boundaries.
///
/// When the model is not available or inference fails, the input text is
/// returned unchanged (graceful fallback to the rule-based formatter in
/// `text/format.rs`).
pub fn restore_punctuation_and_casing(text: &str) -> Result<String> {
    if !is_model_available() {
        return Ok(text.to_string());
    }

    #[cfg(feature = "text-recasepunct")]
    {
        match run_punct_cap_seg_inference(text) {
            Ok(result) => Ok(result),
            Err(e) => {
                tracing::warn!(
                    "PunctCapSeg inference failed, returning input unchanged: {:#}",
                    e
                );
                Ok(text.to_string())
            }
        }
    }

    #[cfg(not(feature = "text-recasepunct"))]
    {
        tracing::debug!(
            "PunctCapSeg model is available but the text-recasepunct feature is not \
             enabled; returning input unchanged"
        );
        Ok(text.to_string())
    }
}

/// Label sets for the English PunctCapSeg model, from `config.yaml`.
///
/// `pre_labels`: punctuation inserted *before* a token.
/// `post_labels`: punctuation inserted *after* a token.
/// Index 0 in each list is `<NULL>` (no punctuation).
#[cfg(feature = "text-recasepunct")]
const PRE_LABELS: &[&str] = &["<NULL>", "¿"];

#[cfg(feature = "text-recasepunct")]
const POST_LABELS: &[&str] = &["<NULL>", "<ACRONYM>", ".", ",", "?"];

/// Maximum sequence length for the model (from `config.yaml`).
/// The model has 512 positional embeddings but was only trained on 256.
#[cfg(feature = "text-recasepunct")]
const MAX_SEQ_LEN: usize = 256;

/// Overlap between segments for long text (tokens).
#[cfg(feature = "text-recasepunct")]
const SEGMENT_OVERLAP: usize = 16;

/// Runs the full PunctCapSeg ONNX inference pipeline.
#[cfg(feature = "text-recasepunct")]
fn run_punct_cap_seg_inference(text: &str) -> Result<String> {
    use ndarray::Array2;
    use ort::value::Tensor;
    use sentencepiece_rs::SentencePieceProcessor;

    // 1. Load SentencePiece tokenizer
    let sp_path = tokenizer_path();
    let sp = SentencePieceProcessor::open(&sp_path)
        .with_context(|| format!("Failed to load SentencePiece tokenizer from {:?}", sp_path))?;

    // 2. Load ONNX session via the shared helper (applies CoreML EP on macOS)
    let onnx_path = onnx_model_path();
    let mut session = crate::ort_utils::build_session_with(&onnx_path, |b| {
        b.with_intra_threads(1)
            .map_err(|e| anyhow::anyhow!("Failed to set thread count: {e}"))
    })?;

    // 3. Tokenize input (lowercased)
    let lowercased = text.to_lowercase();
    let all_ids = sp.encode_to_ids(&lowercased)?;

    // 4. Segment into chunks of MAX_SEQ_LEN - 2 (room for BOS/EOS)
    let max_content_len = MAX_SEQ_LEN - 2;
    let segments = segment_tokens(&all_ids, max_content_len, SEGMENT_OVERLAP);

    // 5. Run inference on each segment and collect results
    let mut all_pre_preds: Vec<usize> = Vec::new();
    let mut all_post_preds: Vec<usize> = Vec::new();
    let mut all_cap_preds: Vec<Vec<i64>> = Vec::new();
    let mut all_sbd_preds: Vec<i64> = Vec::new();
    let mut all_ids_out: Vec<usize> = Vec::new();

    let bos = sp
        .bos_id()
        .context("SentencePiece model has no BOS token")?;
    let eos = sp
        .eos_id()
        .context("SentencePiece model has no EOS token")?;
    let pad = sp.pad_id().unwrap_or(0);

    for (seg_idx, seg_ids) in segments.iter().enumerate() {
        // Build input_ids with BOS + content + EOS, padded to segment length
        let mut input_ids = vec![pad; MAX_SEQ_LEN];
        input_ids[0] = bos;
        for (i, &id) in seg_ids.iter().enumerate() {
            input_ids[1 + i] = id;
        }
        let content_len = seg_ids.len();
        input_ids[1 + content_len] = eos;
        let actual_len = content_len + 2; // BOS + content + EOS

        let ids_arr: Array2<i64> = Array2::from_shape_vec((1, MAX_SEQ_LEN), {
            input_ids.iter().map(|&id| id as i64).collect()
        })
        .context("Failed to shape PunctCapSeg input_ids")?;

        let ids_tensor = Tensor::from_array(ids_arr.into_dyn())
            .context("Failed to create PunctCapSeg input_ids tensor")?;

        // Run inference — outputs: pre_preds, post_preds, cap_preds, seg_preds
        let outputs = session
            .run(ort::inputs!["input_ids" => ids_tensor])
            .context("PunctCapSeg ONNX inference failed")?;

        // Extract outputs by position (the model outputs 4 arrays in order).
        // We use `into_owned()` because `try_extract_array` returns a borrowed
        // view that doesn't outlive the `outputs` binding.
        let mut output_iter = outputs.iter();
        let pre_preds = output_iter
            .next()
            .ok_or_else(|| anyhow::anyhow!("PunctCapSeg produced no pre_preds output"))?
            .1
            .try_extract_array::<i64>()
            .context("Failed to extract pre_preds")?
            .into_owned();
        let post_preds = output_iter
            .next()
            .ok_or_else(|| anyhow::anyhow!("PunctCapSeg produced no post_preds output"))?
            .1
            .try_extract_array::<i64>()
            .context("Failed to extract post_preds")?
            .into_owned();
        let cap_preds = output_iter
            .next()
            .ok_or_else(|| anyhow::anyhow!("PunctCapSeg produced no cap_preds output"))?
            .1
            .try_extract_array::<i64>()
            .context("Failed to extract cap_preds")?
            .into_owned();
        let seg_preds = output_iter
            .next()
            .ok_or_else(|| anyhow::anyhow!("PunctCapSeg produced no seg_preds output"))?
            .1
            .try_extract_array::<i64>()
            .context("Failed to extract seg_preds")?
            .into_owned();

        // Strip BOS/EOS: take predictions for positions [1, actual_len-1)
        let start = 1;
        let stop = actual_len - 1; // exclusive

        // Apply overlap trimming
        let trim_start = if seg_idx > 0 { SEGMENT_OVERLAP / 2 } else { 0 };
        let trim_end = if seg_idx < segments.len() - 1 {
            SEGMENT_OVERLAP / 2
        } else {
            0
        };

        let effective_start = start + trim_start;
        let effective_stop = stop.saturating_sub(trim_end);

        for i in effective_start..effective_stop {
            // pre_preds shape: [1, seq_len]
            let pre_idx = pre_preds[[0, i]] as usize;
            let post_idx = post_preds[[0, i]] as usize;
            let sbd = seg_preds[[0, i]];

            // cap_preds shape: [1, seq_len, max_subtoken_len]
            // Extract per-character capitalization flags for this token
            let cap_dim2 = cap_preds.shape()[2];
            let cap_flags: Vec<i64> = (0..cap_dim2).map(|j| cap_preds[[0, i, j]]).collect();

            all_pre_preds.push(pre_idx);
            all_post_preds.push(post_idx);
            all_cap_preds.push(cap_flags);
            all_sbd_preds.push(sbd);
            all_ids_out.push(input_ids[i]);
        }
    }

    // 6. Reassemble text with punctuation/casing
    let result = reassemble_text(
        &sp,
        &all_ids_out,
        &all_pre_preds,
        &all_post_preds,
        &all_cap_preds,
        &all_sbd_preds,
    );

    Ok(result)
}

/// Segments a token list into chunks of `max_len` with `overlap` tokens
/// of overlap between consecutive segments.
#[cfg(feature = "text-recasepunct")]
fn segment_tokens(ids: &[usize], max_len: usize, overlap: usize) -> Vec<Vec<usize>> {
    if ids.is_empty() {
        return vec![];
    }
    let mut segments = Vec::new();
    let mut start = 0;
    while start < ids.len() {
        let stop = (start + max_len).min(ids.len());
        segments.push(ids[start..stop].to_vec());
        if stop >= ids.len() {
            break;
        }
        start = stop.saturating_sub(overlap);
    }
    segments
}

/// Reassembles text from token IDs and model predictions, following the
/// reference implementation in `PunctCapSegResultCollector.produce()`.
#[cfg(feature = "text-recasepunct")]
fn reassemble_text(
    sp: &sentencepiece_rs::SentencePieceProcessor,
    ids: &[usize],
    pre_preds: &[usize],
    post_preds: &[usize],
    cap_preds: &[Vec<i64>],
    sbd_preds: &[i64],
) -> String {
    let mut output_sentences: Vec<String> = Vec::new();
    let mut current_chars: Vec<char> = Vec::new();

    for (token_idx, &id) in ids.iter().enumerate() {
        // Decode a single token ID to its piece string
        let token = sp.id_to_piece(id).unwrap_or("");

        // SentencePiece uses '▁' (U+2581) as the word boundary marker
        if token.starts_with('▁') && !current_chars.is_empty() {
            current_chars.push(' ');
        }

        let chars: Vec<char> = if token.starts_with('▁') {
            token[1..].chars().collect()
        } else {
            token.chars().collect()
        };

        let char_start = 0;
        for (token_char_idx, char) in chars.iter().enumerate() {
            // Insert pre-punctuation before the first char of the token
            if token_char_idx == char_start && pre_preds[token_idx] < PRE_LABELS.len() {
                let pre_label = PRE_LABELS[pre_preds[token_idx]];
                if pre_label != "<NULL>" {
                    current_chars.extend(pre_label.chars());
                }
            }

            // Apply capitalization
            let should_capitalize = cap_preds[token_idx]
                .get(token_char_idx)
                .copied()
                .unwrap_or(0)
                != 0;
            let final_char = if should_capitalize {
                char.to_uppercase().next().unwrap_or(*char)
            } else {
                *char
            };
            current_chars.push(final_char);

            // Insert post-punctuation
            if post_preds[token_idx] < POST_LABELS.len() {
                let post_label = POST_LABELS[post_preds[token_idx]];
                if post_label == "<ACRONYM>" {
                    // All characters in this subtoken get a period
                    current_chars.push('.');
                } else if token_char_idx == chars.len() - 1 && post_label != "<NULL>" {
                    current_chars.extend(post_label.chars());
                }
            }

            // Sentence boundary detection
            if token_char_idx == chars.len() - 1 && sbd_preds[token_idx] != 0 {
                output_sentences.push(current_chars.iter().collect());
                current_chars.clear();
            }
        }
    }

    if !current_chars.is_empty() {
        output_sentences.push(current_chars.iter().collect());
    }

    output_sentences.join(" ")
}

/// Integrity artifacts for the punctuation/casing model.
/// Returns (path, sha256) pairs for integrity verification.
/// SHA256 hashes are empty until the model is downloaded and verified.
pub fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let dir = models_root.join("punctuation");
    vec![
        (
            dir.join(PUNCT_CAP_SEG_LOCAL_ONNX),
            "dd922d459da618cd324280889740608b76fb3e9e61d3f402291be1251f91421b".to_string(),
        ),
        (
            dir.join(PUNCT_CAP_SEG_LOCAL_TOKENIZER),
            "9e86d0263de80b3b68327a21f5350c8cdf846e4c4400253c9baf05e3d44871c3".to_string(),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_returns_input_when_model_unavailable() {
        // Model is not downloaded in test environment, so this should
        // return the input unchanged.
        let input = "hello world this is a test";
        let result = restore_punctuation_and_casing(input).unwrap();
        assert_eq!(result, input);
    }

    #[test]
    fn model_id_is_stable() {
        assert_eq!(PUNCT_CAP_SEG_MODEL_ID, "punct_cap_seg_en");
    }

    #[test]
    fn integrity_artifacts_contain_pinned_hashes() {
        let temp = std::env::temp_dir().join("punct_integrity_test");
        let artifacts = model_integrity_artifacts(&temp);
        assert_eq!(artifacts.len(), 2);
        for (_, sha256) in &artifacts {
            assert_eq!(sha256.len(), 64);
            assert!(sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[cfg(feature = "text-recasepunct")]
    #[test]
    fn segment_tokens_splits_long_input_with_overlap() {
        let ids: Vec<usize> = (0..300).collect();
        let segments = segment_tokens(&ids, 254, 16);
        assert!(segments.len() > 1);
        // First segment should be 254 tokens
        assert_eq!(segments[0].len(), 254);
        // Second segment should start 16 tokens before the end of the first
        assert_eq!(segments[1][0], 254 - 16);
    }

    #[cfg(feature = "text-recasepunct")]
    #[test]
    fn segment_tokens_returns_empty_for_empty_input() {
        let segments = segment_tokens(&[], 254, 16);
        assert!(segments.is_empty());
    }

    #[cfg(feature = "text-recasepunct")]
    #[test]
    fn segment_tokens_returns_single_segment_for_short_input() {
        let ids: Vec<usize> = vec![1, 2, 3, 4, 5];
        let segments = segment_tokens(&ids, 254, 16);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0], ids);
    }
}
