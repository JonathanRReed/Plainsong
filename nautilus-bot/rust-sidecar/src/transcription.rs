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
    // Fail loudly on formats this build cannot produce instead of silently
    // writing another format into a mislabeled file.
    let export_format = format.parse::<ExportFormat>().map_err(|_| {
        anyhow::anyhow!("Export format '{}' is not supported in this build", format)
    })?;

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
        crate::safe_fs::ensure_directory_without_links(parent)?;
    }
    crate::safe_fs::atomic_write(&export_path, redacted_content.as_bytes())?;

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
    let export_format = format.parse::<ExportFormat>().map_err(|_| {
        anyhow::anyhow!("Export format '{}' is not supported in this build", format)
    })?;

    let export_path = match target {
        Some(path) => PathBuf::from(path),
        None => export::get_default_export_path(recording, export_format),
    };

    if let Some(parent) = export_path.parent() {
        crate::safe_fs::ensure_directory_without_links(parent)?;
    }

    let content = export_recording(recording, transcript, export_format, true)?;
    crate::safe_fs::atomic_write(&export_path, content.as_bytes())?;

    tracing::info!("Exported recording {} to {:?}", recording.id, export_path);

    Ok(export_path.to_string_lossy().to_string())
}

pub(crate) fn apply_redaction(content: &str, redaction_level: &str) -> String {
    match redaction_level {
        "none" => content.to_string(),
        "strict" => redact_strict(content),
        _ => redact_basic(content),
    }
}

/// True when a phone-candidate match is actually a date or date-time
/// (`2026-07-13`, `2026-07-13 14`, `07-13-2026`, ...). The `regex` crate has
/// no lookarounds, so candidates are matched broadly and then vetted here to
/// keep export metadata lines and spoken dates intact.
fn is_date_like(candidate: &str) -> bool {
    let date_like =
        Regex::new(r"^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4})(?:[\sT]+\d{1,2})?$")
            .expect("valid date-like regex");
    // The broad candidate pattern can absorb a leading '(' or '+' (e.g.
    // "(2026-07-20)"), which would break the ^-anchored date match, so strip
    // that prefix before vetting.
    date_like.is_match(candidate.trim().trim_start_matches(['(', '+']))
}

fn redact_basic(content: &str) -> String {
    let email =
        Regex::new(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b").expect("valid email regex");
    // Broad phone candidate: optional +/( prefix, then digits with common
    // separators. Real redaction is decided per match below so date-like
    // strings survive.
    let phone = Regex::new(r"\+?\(?\d[\d\-\s\(\)]{7,}\d").expect("valid phone regex");

    let without_email = email.replace_all(content, "[REDACTED_EMAIL]");
    phone
        .replace_all(&without_email, |caps: &regex::Captures<'_>| {
            redact_phone_candidate(caps.get(0).expect("match 0 always present").as_str())
        })
        .to_string()
}

/// Decide what a broad phone-candidate span becomes. Spans with a plausible
/// phone digit count (7-15) are redacted unless they are date-like. Spans with
/// more digits than any real phone number — the greedy pattern spanning a date
/// next to a phone, or a card number — are re-vetted per whitespace-separated
/// run so dates survive while every phone-sized digit run is still redacted
/// instead of the whole span leaking unredacted.
fn redact_phone_candidate(matched: &str) -> String {
    if is_date_like(matched) {
        return matched.to_string();
    }
    let digit_count = matched.chars().filter(char::is_ascii_digit).count();
    if digit_count < 7 {
        return matched.to_string();
    }
    if digit_count <= 15 {
        return "[REDACTED_PHONE]".to_string();
    }

    fn flush(run: &mut Vec<&str>, pieces: &mut Vec<String>) {
        if run.is_empty() {
            return;
        }
        let joined = run.join(" ");
        let digits = joined.chars().filter(char::is_ascii_digit).count();
        if digits >= 7 {
            pieces.push("[REDACTED_PHONE]".to_string());
        } else {
            pieces.push(joined);
        }
        run.clear();
    }

    let mut pieces: Vec<String> = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    for token in matched.split_whitespace() {
        if is_date_like(token) {
            flush(&mut run, &mut pieces);
            pieces.push(token.to_string());
        } else {
            run.push(token);
        }
    }
    flush(&mut run, &mut pieces);
    pieces.join(" ")
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
    use chrono::Utc;

    fn test_recording() -> Recording {
        Recording {
            id: "r1".to_string(),
            title: "Test".to_string(),
            project_id: "inbox".to_string(),
            duration: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            source_type: "meeting".to_string(),
            audio_path: String::new(),
            status: "completed".to_string(),
            summary: None,
            action_items: None,
            summary_provenance: None,
            action_items_provenance: None,
            meeting_notes: None,
            meeting_template_id: None,
            meeting_capture_mode: None,
            imported_source_name: None,
            notes_updated_at: None,
            consent_prompt_shown: false,
            consent_notice_mode: None,
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: None,
            analysis_failure: None,
        }
    }

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

    #[test]
    fn redact_basic_preserves_dates_and_datetimes() {
        let input = "- **Date:** 2026-07-13 14:30\nDue on 2026-07-13 and 07-13-2026.";
        assert_eq!(apply_redaction(input, "basic"), input);
    }

    #[test]
    fn redact_basic_preserves_parenthesized_dates() {
        let input = "next sync (2026-07-20) works for me";
        assert_eq!(apply_redaction(input, "basic"), input);
    }

    #[test]
    fn redact_basic_redacts_phone_adjacent_to_date() {
        let out = apply_redaction("on 2026-07-13 555-123-4567", "basic");
        assert_eq!(out, "on 2026-07-13 [REDACTED_PHONE]");
    }

    #[test]
    fn redact_basic_redacts_card_like_digit_groups() {
        let out = apply_redaction("card 1234 5678 9012 3456 on file", "basic");
        assert_eq!(out, "card [REDACTED_PHONE] on file");
    }

    #[test]
    fn redact_basic_consumes_leading_paren_of_phone() {
        let out = apply_redaction("call me at (555) 123-4567 today", "basic");
        assert_eq!(out, "call me at [REDACTED_PHONE] today");
    }

    #[test]
    fn export_with_policy_rejects_unsupported_format() {
        let recording = test_recording();
        let error = export_with_policy(&recording, None, "bogus", None, "none", true)
            .expect_err("unknown format must not silently fall back");
        assert!(error.to_string().contains("not supported"));
    }

    #[cfg(unix)]
    #[test]
    fn export_replaces_a_link_leaf_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-export-link-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create export test root");
        let root = root.canonicalize().expect("canonical export test root");
        let outside = root.join("outside.txt");
        let destination = root.join("transcript.txt");
        std::fs::write(&outside, "keep me").expect("write outside target");
        symlink(&outside, &destination).expect("create destination link");

        export(
            &test_recording(),
            None,
            "text",
            Some(destination.to_str().expect("utf-8 test path")),
        )
        .expect("safe export");

        assert_eq!(
            std::fs::read_to_string(&outside).expect("read outside target"),
            "keep me"
        );
        assert!(
            !std::fs::symlink_metadata(&destination)
                .expect("inspect destination")
                .file_type()
                .is_symlink(),
            "the export leaf should be a regular file"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn export_with_policy_rejects_a_linked_parent_without_creating_outside_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-policy-export-parent-link-test-{}",
            uuid::Uuid::new_v4()
        ));
        let approved = root.join("approved");
        let outside = root.join("outside");
        std::fs::create_dir_all(&approved).expect("create approved root");
        std::fs::create_dir_all(&outside).expect("create outside root");
        let root = root.canonicalize().expect("canonical test root");
        symlink(&outside, approved.join("linked")).expect("create linked export parent");
        let destination = approved.join("linked/nested/transcript.txt");

        export_with_policy(
            &test_recording(),
            None,
            "text",
            Some(destination.to_str().expect("utf-8 test path")),
            "none",
            false,
        )
        .expect_err("the export_recording_v2 write path must reject a linked parent");

        assert!(!outside.join("nested").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
