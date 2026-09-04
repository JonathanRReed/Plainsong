//! Where files may be written, and what goes in them.
//!
//! The template export path -- the persisted analysis a template renders, the
//! export context for a recording, the format extension and the write itself --
//! and the path guard the whole sidecar shares: the approved roots, the
//! canonicalisation that refuses anything outside them, and opening a finished
//! file in the user's default app.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn persisted_template_analysis(
    recording: &models::Recording,
    redaction_level: &str,
) -> (Option<String>, Vec<String>) {
    let summary_note =
        recording
            .summary
            .as_ref()
            .map(|_| match recording.summary_provenance.as_ref() {
                None => "Analysis provenance is unavailable or stale.".to_string(),
                Some(provenance) if !provenance.grounded => {
                    "Analysis is not fully grounded in verified transcript citations.".to_string()
                }
                Some(provenance) => format!(
                    "Grounded analysis: {} / {}; {} transcript citation(s).",
                    provenance.actual_provider,
                    provenance.actual_model,
                    provenance.citations.len()
                ),
            });
    let summary = recording.summary.as_deref().map(|value| {
        let redacted = transcription::apply_redaction(value, redaction_level);
        summary_note
            .as_deref()
            .map(|note| format!("[{}]\n\n{}", note, redacted))
            .unwrap_or(redacted)
    });
    let mut action_items = recording
        .action_items
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|item| transcription::apply_redaction(&item, redaction_level))
        .collect::<Vec<_>>();
    if !action_items.is_empty() {
        let note = match recording.action_items_provenance.as_ref() {
            None => "Analysis provenance is unavailable or stale.".to_string(),
            Some(provenance) if !provenance.grounded => {
                "Analysis is not fully grounded in verified transcript citations.".to_string()
            }
            Some(provenance) => format!(
                "Grounded analysis: {} / {}; {} transcript citation(s).",
                provenance.actual_provider,
                provenance.actual_model,
                provenance.citations.len()
            ),
        };
        action_items.insert(0, format!("[{}]", note));
    }
    (summary, action_items)
}

/// Speaker names an export may show, read from the aliases a person set in
/// the transcript viewer. A speaker with no alias is left out: subtitles then
/// fall back to the capture side (`Me`/`Them`) rather than invent a name.
pub(crate) fn export_context_for_recording(
    db: &db::Database,
    recording_id: &str,
) -> export::ExportContext {
    let speaker_names = db
        .get_speaker_aliases(recording_id)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(speaker_id, (name, _, _))| {
            let name = name?.trim().to_string();
            (!name.is_empty()).then_some((speaker_id, name))
        })
        .collect();
    export::ExportContext { speaker_names }
}

pub(crate) fn write_template_export(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        safe_fs::ensure_directory_without_links(parent).map_err(|error| {
            format!(
                "Failed to create export directory '{}': {}",
                parent.display(),
                error
            )
        })?;
    }
    safe_fs::atomic_write(path, contents).map_err(|error| {
        format!(
            "Failed to write template export '{}': {}",
            path.display(),
            error
        )
    })
}

pub(crate) fn template_format_extension(format: &export::templates::ExportFormat) -> &'static str {
    match format {
        export::templates::ExportFormat::Markdown => "md",
        export::templates::ExportFormat::PlainText => "txt",
        export::templates::ExportFormat::Html => "html",
        export::templates::ExportFormat::Json => "json",
        export::templates::ExportFormat::Csv => "csv",
        export::templates::ExportFormat::Pdf => "pdf",
        export::templates::ExportFormat::Docx => "docx",
    }
}

pub(crate) fn compute_wav_duration_seconds_from_bytes(bytes: &[u8]) -> Result<i64, String> {
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("Captured audio is not a readable WAV: {}", error))?;
    let sample_rate = reader.spec().sample_rate;
    if sample_rate == 0 {
        return Err("Captured audio has an invalid zero sample rate".to_string());
    }
    Ok((reader.duration() as f64 / sample_rate as f64)
        .round()
        .max(1.0) as i64)
}

pub(crate) fn compute_wav_duration_seconds(audio_path: &str) -> i64 {
    match hound::WavReader::open(audio_path) {
        Ok(reader) => {
            let spec = reader.spec();
            if spec.sample_rate == 0 {
                return 0;
            }
            (reader.duration() as f64 / spec.sample_rate as f64).round() as i64
        }
        Err(error) => {
            tracing::warn!(
                "Failed to compute recording duration for '{}': {}",
                audio_path,
                error
            );
            0
        }
    }
}

pub(crate) fn canonicalize_existing_absolute_path(
    raw_path: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!(
            "{} must be an absolute path, got '{}'",
            label, trimmed
        ));
    }
    if !candidate.exists() {
        return Err(format!("{} does not exist: '{}'", label, trimmed));
    }

    candidate
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {} '{}': {}", label, trimmed, e))
}

pub(crate) fn nautilus_data_root() -> Result<PathBuf, String> {
    let root = crate::paths::data_dir()
        .ok_or("Could not find data directory")?
        .join("Plainsong");
    std::fs::create_dir_all(&root).map_err(|e| {
        format!(
            "Failed to prepare Plainsong data root '{}': {}",
            root.display(),
            e
        )
    })?;
    Ok(root.canonicalize().unwrap_or(root))
}

/// One row per model file Plainsong pins a digest for: is it here, how big is
/// it, and does it still carry a trusted integrity receipt.
///
/// Deliberately reports the model directory name and the file name and nothing
/// else -- the full path names the reader's account, and the support bundle
/// refuses to carry that.
pub(crate) fn support_bundle_model_artifacts() -> Vec<serde_json::Value> {
    let Some(models_root) =
        crate::paths::data_dir().map(|dir| dir.join("Plainsong").join("models"))
    else {
        return Vec::new();
    };
    let mut artifacts = download::managed_model_integrity_artifacts(&models_root);
    artifacts.extend(asr::model_integrity_artifacts(&models_root));
    artifacts.extend(llm::bundled_local::model_integrity_artifacts(&models_root));

    artifacts
        .into_iter()
        .map(|(path, sha256)| {
            let present = path.is_file();
            let bytes = if present {
                std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
            } else {
                0
            };
            let trusted =
                present && download::is_model_artifact_trusted(&path, Some(sha256.as_str()));
            serde_json::json!({
                "model": path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                "file": path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                "present": present,
                "bytes": bytes,
                "integrityReceiptTrusted": trusted,
            })
        })
        .collect()
}

pub(crate) fn approved_path_roots() -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();

    roots.push(nautilus_data_root()?);

    let config_root = crate::paths::config_dir()
        .ok_or("Could not find config directory")?
        .join("Plainsong");
    if let Err(e) = std::fs::create_dir_all(&config_root) {
        tracing::warn!(
            "Failed to prepare Plainsong config root '{}': {}",
            config_root.display(),
            e
        );
    } else {
        roots.push(config_root.canonicalize().unwrap_or(config_root));
    }

    let documents_base = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Could not find documents directory")?;
    let documents_root = documents_base.join("Plainsong");
    if let Err(e) = std::fs::create_dir_all(&documents_root) {
        tracing::warn!(
            "Failed to prepare Plainsong documents root '{}': {}",
            documents_root.display(),
            e
        );
    } else {
        roots.push(documents_root.canonicalize().unwrap_or(documents_root));
    }

    if roots.is_empty() {
        return Err("No approved Plainsong roots are available".to_string());
    }
    Ok(roots)
}

pub(crate) fn ensure_path_in_approved_roots(path: &Path, label: &str) -> Result<(), String> {
    let roots = approved_path_roots()?;
    if roots.iter().any(|root| path.starts_with(root)) {
        return Ok(());
    }

    Err(format!(
        "{} '{}' is outside approved Plainsong roots",
        label,
        path.display()
    ))
}

pub(crate) fn open_path_in_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(|e| format!("Failed to launch 'open' for '{}': {}", path.display(), e))?;

    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch Windows opener for '{}': {}",
                path.display(),
                e
            )
        })?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open")
        .arg(path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch 'xdg-open' for '{}': {}",
                path.display(),
                e
            )
        })?;

    if !status.success() {
        return Err(format!(
            "Default app open command failed for '{}'",
            path.display()
        ));
    }

    Ok(())
}
