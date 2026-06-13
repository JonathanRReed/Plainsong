//! Transcript export with optional PII redaction.
//!
//! Plain export to a chosen format, optionally redacting emails/phones (basic)
//! or also URLs/secrets/long numbers (strict) before writing.

use crate::export::{self, export_recording, ExportFormat};
use crate::models::Recording;
use anyhow::Result;
use regex::Regex;
use std::path::PathBuf;

pub fn export_with_policy(
    recording: &Recording,
    transcript: Option<&crate::models::Transcript>,
    format: &str,
    target: Option<&str>,
    redaction_level: &str,
    preview: bool,
) -> Result<crate::models::ExportResponse> {
    let export_format = format
        .parse::<ExportFormat>()
        .unwrap_or(ExportFormat::Markdown);

    let content = export_recording(recording, transcript, export_format, true)?;
    let redacted_content = apply_redaction(&content, redaction_level);

    if preview {
        return Ok(crate::models::ExportResponse {
            format: format.to_string(),
            redaction_level: redaction_level.to_string(),
            preview: true,
            export_path: None,
            content: Some(redacted_content),
        });
    }

    let export_path = match target {
        Some(path) => std::path::PathBuf::from(path),
        None => export::get_default_export_path(recording, export_format),
    };

    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&export_path, redacted_content)?;

    Ok(crate::models::ExportResponse {
        format: format.to_string(),
        redaction_level: redaction_level.to_string(),
        preview: false,
        export_path: Some(export_path.to_string_lossy().to_string()),
        content: None,
    })
}

pub fn export(
    recording: &Recording,
    transcript: Option<&crate::models::Transcript>,
    format: &str,
    target: Option<&str>,
) -> Result<String> {
    let export_format = format
        .parse::<ExportFormat>()
        .unwrap_or(ExportFormat::Markdown);

    let export_path = match target {
        Some(path) => PathBuf::from(path),
        None => export::get_default_export_path(recording, export_format),
    };

    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let content = export_recording(recording, transcript, export_format, true)?;
    std::fs::write(&export_path, content)?;

    tracing::info!("Exported recording {} to {:?}", recording.id, export_path);

    Ok(export_path.to_string_lossy().to_string())
}

fn apply_redaction(content: &str, redaction_level: &str) -> String {
    match redaction_level {
        "none" => content.to_string(),
        "strict" => redact_strict(content),
        _ => redact_basic(content),
    }
}

fn redact_basic(content: &str) -> String {
    let email =
        Regex::new(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b").expect("valid email regex");
    let phone = Regex::new(r"\+?\d[\d\-\s\(\)]{7,}\d").expect("valid phone regex");

    let without_email = email.replace_all(content, "[REDACTED_EMAIL]");
    phone
        .replace_all(&without_email, "[REDACTED_PHONE]")
        .to_string()
}

fn redact_strict(content: &str) -> String {
    let url = Regex::new(r"(?i)\bhttps?://[^\s]+").expect("valid url regex");
    let key_like = Regex::new(r"\b(sk|pk|api|token)[_-]?[a-z0-9]{8,}\b").expect("valid key regex");
    let long_digits = Regex::new(r"\b\d{4,}\b").expect("valid digits regex");

    let basic = redact_basic(content);
    let without_urls = url.replace_all(&basic, "[REDACTED_URL]");
    let without_keys = key_like.replace_all(&without_urls, "[REDACTED_SECRET]");
    long_digits
        .replace_all(&without_keys, "[REDACTED_NUMBER]")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_basic_masks_email_and_phone() {
        let out = apply_redaction("reach me at a@b.com or +1 555 123 4567", "basic");
        assert!(out.contains("[REDACTED_EMAIL]"));
        assert!(out.contains("[REDACTED_PHONE]"));
        assert!(!out.contains("a@b.com"));
    }

    #[test]
    fn redact_strict_also_masks_urls_and_secrets() {
        let out = apply_redaction("see https://example.com key sk_abcdef123456", "strict");
        assert!(out.contains("[REDACTED_URL]"));
        assert!(out.contains("[REDACTED_SECRET]"));
    }

    #[test]
    fn redact_none_is_passthrough() {
        let input = "plain text with a@b.com";
        assert_eq!(apply_redaction(input, "none"), input);
    }
}
