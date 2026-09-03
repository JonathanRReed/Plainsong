//! Is the model on disk actually a model?
//!
//! Artifact validation for the local model cache -- ONNX graphs, token lists,
//! JSON configs and plain binaries -- and the repair pass that removes the
//! truncated or half-downloaded files an interrupted download leaves behind, so
//! the next attempt starts from a known-empty slot instead of failing to load.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn is_valid_onnx_artifact(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 4096 {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 1];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

pub(crate) fn is_valid_token_list_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
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

pub(crate) fn is_valid_json_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok()
}

pub(crate) fn is_valid_binary_artifact(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 1];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

pub(crate) fn remove_artifact(
    path: &Path,
    reason: &str,
    removed_paths: &mut Vec<String>,
    notes: &mut Vec<String>,
) {
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(_) => {
            removed_paths.push(path.to_string_lossy().to_string());
            notes.push(format!(
                "Removed invalid artifact ({}): {}",
                reason,
                path.display()
            ));
        }
        Err(error) => {
            notes.push(format!(
                "Failed removing invalid artifact '{}': {}",
                path.display(),
                error
            ));
        }
    }
}

pub(crate) fn remove_download_temp_files(
    model_dir: &Path,
    removed_paths: &mut Vec<String>,
    notes: &mut Vec<String>,
) {
    let Ok(entries) = std::fs::read_dir(model_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_tmp = path.extension().map(|ext| ext == "tmp").unwrap_or(false);
        if is_tmp {
            remove_artifact(&path, "stale temp download", removed_paths, notes);
        }
    }
}

pub(crate) fn repair_local_model_cache_at(models_root: &Path) -> LocalModelRepairReport {
    let mut removed_paths: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    if !models_root.exists() {
        notes.push(format!(
            "Models root does not exist yet: {}",
            models_root.display()
        ));
        return LocalModelRepairReport {
            repaired_count: 0,
            removed_paths,
            notes,
        };
    }

    let whisper_dir = models_root.join("whisper");
    if whisper_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&whisper_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                let is_whisper_bin = file_name.starts_with("ggml-")
                    && path.extension().map(|ext| ext == "bin").unwrap_or(false);
                if is_whisper_bin && !is_valid_binary_artifact(&path, 1024 * 1024) {
                    remove_artifact(
                        &path,
                        "invalid whisper model binary",
                        &mut removed_paths,
                        &mut notes,
                    );
                }
            }
        }
        remove_download_temp_files(&whisper_dir, &mut removed_paths, &mut notes);
    }

    let parakeet_dir = models_root.join("parakeet");
    if parakeet_dir.exists() {
        let encoder = parakeet_dir.join("encoder.onnx");
        if !is_valid_onnx_artifact(&encoder) {
            remove_artifact(
                &encoder,
                "invalid Parakeet encoder ONNX",
                &mut removed_paths,
                &mut notes,
            );
        }
        let legacy_model = parakeet_dir.join("model.onnx");
        if legacy_model.exists() && !is_valid_onnx_artifact(&legacy_model) {
            remove_artifact(
                &legacy_model,
                "invalid legacy Parakeet model.onnx",
                &mut removed_paths,
                &mut notes,
            );
        }
        let tokens = parakeet_dir.join("tokens.txt");
        if tokens.exists() && !is_valid_token_list_artifact(&tokens, 128) {
            remove_artifact(
                &tokens,
                "invalid Parakeet tokens.txt",
                &mut removed_paths,
                &mut notes,
            );
        }
        let legacy_vocab = parakeet_dir.join("vocab.txt");
        if legacy_vocab.exists() && !is_valid_token_list_artifact(&legacy_vocab, 128) {
            remove_artifact(
                &legacy_vocab,
                "invalid legacy Parakeet vocab.txt",
                &mut removed_paths,
                &mut notes,
            );
        }
        remove_download_temp_files(&parakeet_dir, &mut removed_paths, &mut notes);
    }

    for (moonshine_dir, label) in [
        (models_root.join("moonshine"), "Moonshine Base"),
        (models_root.join("moonshine_tiny"), "Moonshine Tiny"),
    ] {
        if !moonshine_dir.exists() {
            continue;
        }

        let encoder_model = moonshine_dir.join("encoder_model.onnx");
        if encoder_model.exists() && !is_valid_onnx_artifact(&encoder_model) {
            remove_artifact(
                &encoder_model,
                &format!("invalid {} encoder_model.onnx", label),
                &mut removed_paths,
                &mut notes,
            );
        }
        let decoder_model = moonshine_dir.join("decoder_model_merged.onnx");
        if decoder_model.exists() && !is_valid_onnx_artifact(&decoder_model) {
            remove_artifact(
                &decoder_model,
                &format!("invalid {} decoder_model_merged.onnx", label),
                &mut removed_paths,
                &mut notes,
            );
        }
        let tokenizer = moonshine_dir.join("tokenizer.json");
        if tokenizer.exists() && !is_valid_json_artifact(&tokenizer, 1024) {
            remove_artifact(
                &tokenizer,
                &format!("invalid {} tokenizer.json", label),
                &mut removed_paths,
                &mut notes,
            );
        }
        let legacy_encode = moonshine_dir.join("encode.onnx");
        if legacy_encode.exists() && !is_valid_onnx_artifact(&legacy_encode) {
            remove_artifact(
                &legacy_encode,
                &format!("invalid legacy {} encode.onnx", label),
                &mut removed_paths,
                &mut notes,
            );
        }
        let legacy_uncached = moonshine_dir.join("uncached_decode.onnx");
        if legacy_uncached.exists() && !is_valid_onnx_artifact(&legacy_uncached) {
            remove_artifact(
                &legacy_uncached,
                &format!("invalid legacy {} uncached_decode.onnx", label),
                &mut removed_paths,
                &mut notes,
            );
        }
        remove_download_temp_files(&moonshine_dir, &mut removed_paths, &mut notes);
    }

    let whisper_candle_dir = models_root.join("canary");
    if whisper_candle_dir.exists() {
        let model = whisper_candle_dir.join("model.safetensors");
        if model.exists() && !is_valid_binary_artifact(&model, 1024 * 1024) {
            remove_artifact(
                &model,
                "invalid Whisper Candle model.safetensors",
                &mut removed_paths,
                &mut notes,
            );
        }
        for json_name in ["config.json", "tokenizer.json", "preprocessor_config.json"] {
            let path = whisper_candle_dir.join(json_name);
            if path.exists() && !is_valid_json_artifact(&path, 128) {
                remove_artifact(
                    &path,
                    "invalid Whisper Candle JSON artifact",
                    &mut removed_paths,
                    &mut notes,
                );
            }
        }
        remove_download_temp_files(&whisper_candle_dir, &mut removed_paths, &mut notes);
    }

    let distil_dir = models_root.join("distil_whisper");
    if distil_dir.exists() {
        let model = distil_dir.join("model.safetensors");
        if model.exists() && !is_valid_binary_artifact(&model, 1024 * 1024) {
            remove_artifact(
                &model,
                "invalid Distil-Whisper model.safetensors",
                &mut removed_paths,
                &mut notes,
            );
        }
        for json_name in ["config.json", "tokenizer.json", "preprocessor_config.json"] {
            let path = distil_dir.join(json_name);
            if path.exists() && !is_valid_json_artifact(&path, 128) {
                remove_artifact(
                    &path,
                    "invalid Distil-Whisper JSON artifact",
                    &mut removed_paths,
                    &mut notes,
                );
            }
        }
        remove_download_temp_files(&distil_dir, &mut removed_paths, &mut notes);
    }

    // Voxtral had a repair sweep here, validating its JSON and safetensors
    // artifacts. The engine is gone, so validating its cache is dead work: no
    // code path can produce or consume those files any more. A user upgrading
    // from a build that had Voxtral may still have `models/voxtral/` on disk
    // with weights in it. Reclaiming that space is a product decision about
    // deleting a user's files, not a repair, so it is deliberately not done
    // here rather than smuggled into a function called "repair".

    let repaired_count = removed_paths.len();
    if repaired_count == 0 {
        notes.push("No invalid local ASR artifacts were found.".to_string());
    }

    LocalModelRepairReport {
        repaired_count,
        removed_paths,
        notes,
    }
}
