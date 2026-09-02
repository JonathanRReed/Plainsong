//! Export system for recordings and transcripts
//!
//! Supports multiple formats:
//! - Markdown (.md) - Human-readable with formatting
//! - JSON (.json) - Machine-readable with full metadata
//! - TXT (.txt) - Plain text

use anyhow::{Context, Result};
use chrono::Utc;
pub mod templates;

use crate::models::{Recording, Transcript};
use std::path::PathBuf;

/// Export format
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportFormat {
    Markdown,
    Json,
    Text,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Json => "json",
            ExportFormat::Text => "txt",
        }
    }
}

impl std::str::FromStr for ExportFormat {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "md" | "markdown" => Ok(ExportFormat::Markdown),
            "json" => Ok(ExportFormat::Json),
            "txt" | "text" => Ok(ExportFormat::Text),
            _ => Err(anyhow::anyhow!("Unknown export format: {}", s)),
        }
    }
}

/// Export a recording to the specified format
pub fn export_recording(
    recording: &Recording,
    transcript: Option<&Transcript>,
    format: ExportFormat,
    include_metadata: bool,
) -> Result<String> {
    match format {
        ExportFormat::Markdown => export_markdown(recording, transcript, include_metadata),
        ExportFormat::Json => export_json(recording, transcript),
        ExportFormat::Text => export_text(recording, transcript),
    }
}

/// Export to Markdown format
fn export_markdown(
    recording: &Recording,
    transcript: Option<&Transcript>,
    include_metadata: bool,
) -> Result<String> {
    let mut output = String::new();

    // Title
    output.push_str(&format!("# {}\n\n", recording.title));

    // Metadata
    if include_metadata {
        output.push_str("## Metadata\n\n");
        output.push_str(&format!(
            "- **Date:** {}\n",
            recording.created_at.format("%Y-%m-%d %H:%M")
        ));
        output.push_str(&format!(
            "- **Duration:** {}\n",
            format_duration(recording.duration)
        ));
        output.push_str(&format!("- **Type:** {}\n", recording.source_type));
        output.push_str(&format!("- **Status:** {}\n", recording.status));
        output.push_str(&format!("- **Recording ID:** {}\n", recording.id));
        output.push('\n');
    }

    if recording.source_type == "meeting" {
        if let Some(summary) = recording
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            output.push_str("## Summary\n\n");
            output.push_str(summary);
            output.push_str("\n\n");
        }

        let action_items = recording
            .action_items
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if !action_items.is_empty() {
            output.push_str("## Action Items\n\n");
            for item in action_items {
                output.push_str(&format!("- {}\n", item));
            }
            output.push('\n');
        }

        if let Some(notes) = recording
            .meeting_notes
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
        {
            output.push_str("## Notes\n\n");
            output.push_str(notes);
            output.push_str("\n\n");
        }
    }

    // Transcript
    if let Some(t) = transcript {
        output.push_str("## Transcript\n\n");

        for segment in &t.segments {
            let speaker = segment.speaker_id.as_deref().unwrap_or("Unknown");
            let time = format_time_range(segment.start_time, segment.end_time);

            output.push_str(&format!(
                "**[{}]** *{}*: {}\n\n",
                time, speaker, segment.text
            ));
        }

        // Full text
        output.push_str("---\n\n");
        output.push_str("## Full Text\n\n");
        output.push_str(&t.full_text);
        output.push_str("\n\n");

        // Transcription info
        output.push_str("## Transcription Info\n\n");
        output.push_str(&format!("- **Language:** {}\n", t.language));
        output.push_str(&format!("- **Model:** {}\n", t.model));
        output.push_str(&format!("- **Confidence:** {:.1}%\n", t.confidence * 100.0));
        output.push('\n');
    } else {
        output.push_str("*Transcript not yet available*\n\n");
    }

    // Footer
    output.push_str("---\n\n");
    output.push_str(&format!(
        "*Exported from Plainsong on {}*\n",
        Utc::now().format("%Y-%m-%d %H:%M")
    ));

    Ok(output)
}

/// Export to JSON format
fn export_json(recording: &Recording, transcript: Option<&Transcript>) -> Result<String> {
    use serde_json::json;

    let export_data = json!({
        "version": "1.0",
        "exported_at": Utc::now(),
        "recording": {
            "id": recording.id,
            "title": recording.title,
            "project_id": recording.project_id,
            "duration_seconds": recording.duration,
            "created_at": recording.created_at,
            "updated_at": recording.updated_at,
            "source_type": recording.source_type,
            "status": recording.status,
            "audio_path": recording.audio_path,
            "summary": recording.summary,
            "action_items": recording.action_items,
            "meeting_notes": recording.meeting_notes,
            "meeting_template_id": recording.meeting_template_id,
            "meeting_capture_mode": recording.meeting_capture_mode,
            "consent_notice_mode": recording.consent_notice_mode,
        },
        "transcript": transcript.map(|t| {
            json!({
                "id": t.id,
                "language": t.language,
                "confidence": t.confidence,
                "model": t.model,
                "created_at": t.created_at,
                "segments": t.segments.iter().map(|s| {
                    json!({
                        "id": s.id,
                        "start_time": s.start_time,
                        "end_time": s.end_time,
                        "text": s.text,
                        "speaker_id": s.speaker_id,
                        "confidence": s.confidence,
                    })
                }).collect::<Vec<_>>(),
                "full_text": t.full_text,
            })
        }),
    });

    serde_json::to_string_pretty(&export_data).context("Failed to serialize to JSON")
}

/// Export to plain text format
fn export_text(recording: &Recording, transcript: Option<&Transcript>) -> Result<String> {
    let mut output = String::new();

    output.push_str(&format!("Title: {}\n", recording.title));
    output.push_str(&format!(
        "Date: {}\n",
        recording.created_at.format("%Y-%m-%d %H:%M")
    ));
    output.push_str(&format!(
        "Duration: {}\n\n",
        format_duration(recording.duration)
    ));

    if recording.source_type == "meeting" {
        if let Some(summary) = recording
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            output.push_str("SUMMARY\n");
            output.push_str(&"=".repeat(50));
            output.push_str("\n\n");
            output.push_str(summary);
            output.push_str("\n\n");
        }

        let action_items = recording
            .action_items
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if !action_items.is_empty() {
            output.push_str("ACTION ITEMS\n");
            output.push_str(&"=".repeat(50));
            output.push_str("\n\n");
            for item in action_items {
                output.push_str(&format!("- {}\n", item));
            }
            output.push('\n');
        }

        if let Some(notes) = recording
            .meeting_notes
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
        {
            output.push_str("NOTES\n");
            output.push_str(&"=".repeat(50));
            output.push_str("\n\n");
            output.push_str(notes);
            output.push_str("\n\n");
        }
    }

    if let Some(t) = transcript {
        output.push_str("TRANSCRIPT\n");
        output.push_str(&"=".repeat(50));
        output.push_str("\n\n");

        for segment in &t.segments {
            let speaker = segment.speaker_id.as_deref().unwrap_or("Unknown");
            output.push_str(&format!("[{}] ", format_time(segment.start_time)));
            output.push_str(&format!("{}: ", speaker));
            output.push_str(&segment.text);
            output.push('\n');
        }
    } else {
        output.push_str("Transcript not yet available.\n");
    }

    Ok(output)
}

/// Format duration in seconds to human-readable string
fn format_duration(seconds: i64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, secs)
    } else {
        format!("{}s", secs)
    }
}

/// Format time in seconds to MM:SS
fn format_time(seconds: f64) -> String {
    let mins = (seconds / 60.0) as i64;
    let secs = (seconds % 60.0) as i64;
    format!("{:02}:{:02}", mins, secs)
}

/// Format time range
fn format_time_range(start: f64, end: f64) -> String {
    format!("{} - {}", format_time(start), format_time(end))
}

/// Get default export path
pub fn get_default_export_path(recording: &Recording, format: ExportFormat) -> PathBuf {
    let exports_dir = crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("exports");

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!(
        "{}_{}.{}",
        sanitize_filename(&recording.title),
        timestamp,
        format.extension()
    );

    exports_dir.join(filename)
}

/// Sanitize a string for use as a filename
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            ' ' | '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .take(50) // Limit length
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn meeting_recording_with_recap() -> Recording {
        let now = Utc
            .with_ymd_and_hms(2026, 8, 9, 2, 13, 0)
            .single()
            .expect("valid test timestamp");
        Recording {
            id: "meeting-1".to_string(),
            title: "Limited beta review".to_string(),
            project_id: "inbox".to_string(),
            duration: 90,
            created_at: now,
            updated_at: now,
            source_type: "meeting".to_string(),
            audio_path: String::new(),
            status: "completed".to_string(),
            summary: Some("The signed candidate completed the local meeting flow.".to_string()),
            action_items: Some(vec![
                "Jonathan confirms export before beta invites.".to_string(),
            ]),
            summary_provenance: None,
            action_items_provenance: None,
            meeting_notes: Some(
                "## Goals\nVerify the limited beta meeting flow.\n\n## Decisions\nKeep capture local."
                    .to_string(),
            ),
            meeting_template_id: None,
            meeting_capture_mode: Some("me_and_them".to_string()),
            imported_source_name: None,
            notes_updated_at: Some(now),
            consent_prompt_shown: true,
            consent_notice_mode: Some("manual".to_string()),
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: Some(now),
            analysis_failure: None,
        }
    }

    #[test]
    fn meeting_markdown_export_includes_recap_notes_and_transcript() {
        let now = Utc
            .with_ymd_and_hms(2026, 8, 9, 2, 13, 0)
            .single()
            .expect("valid test timestamp");
        let transcript = Transcript {
            id: "transcript-1".to_string(),
            recording_id: "meeting-1".to_string(),
            segments: vec![],
            full_text: "The local transcript stays in the full record.".to_string(),
            language: "en".to_string(),
            confidence: 0.91,
            model: "distil-whisper-large-v3.5".to_string(),
            model_id: None,
            requested_provider: None,
            actual_provider: Some("distil_whisper".to_string()),
            created_at: now,
        };

        let output = export_markdown(&meeting_recording_with_recap(), Some(&transcript), true)
            .expect("meeting markdown export");

        assert!(
            output.contains("## Summary\n\nThe signed candidate completed the local meeting flow.")
        );
        assert!(
            output.contains("## Action Items\n\n- Jonathan confirms export before beta invites.")
        );
        assert!(output.contains("## Notes\n\n## Goals\nVerify the limited beta meeting flow."));
        assert!(output.contains("## Full Text\n\nThe local transcript stays in the full record."));
    }

    #[test]
    fn meeting_text_and_json_exports_include_saved_meeting_work() {
        let recording = meeting_recording_with_recap();

        let text = export_text(&recording, None).expect("meeting text export");
        assert!(text.contains(
            "SUMMARY\n==================================================\n\nThe signed candidate completed the local meeting flow."
        ));
        assert!(text.contains("ACTION ITEMS\n=================================================="));
        assert!(text.contains("- Jonathan confirms export before beta invites."));
        assert!(text.contains("NOTES\n=================================================="));
        assert!(text.contains("## Decisions\nKeep capture local."));

        let json = export_json(&recording, None).expect("meeting json export");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid export json");
        assert_eq!(
            parsed["recording"]["summary"],
            "The signed candidate completed the local meeting flow."
        );
        assert_eq!(
            parsed["recording"]["action_items"][0],
            "Jonathan confirms export before beta invites."
        );
        assert_eq!(
            parsed["recording"]["meeting_notes"],
            "## Goals\nVerify the limited beta meeting flow.\n\n## Decisions\nKeep capture local."
        );
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(125), "2m 5s");
        assert_eq!(format_duration(3665), "1h 1m 5s");
    }

    #[test]
    fn test_format_time() {
        assert_eq!(format_time(65.5), "01:05");
        assert_eq!(format_time(125.0), "02:05");
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("Hello World"), "Hello_World");
        assert_eq!(sanitize_filename("file/name"), "file_name");
        assert_eq!(sanitize_filename("test:file"), "test_file");
    }
}
