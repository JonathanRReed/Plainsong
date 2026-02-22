//! Export system for recordings and transcripts
//!
//! Supports multiple formats:
//! - Markdown (.md) - Human-readable with formatting
//! - JSON (.json) - Machine-readable with full metadata
//! - PDF (.pdf) - Formatted document (if genpdf feature enabled)
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
    #[cfg(feature = "export-pdf")]
    Pdf,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Json => "json",
            ExportFormat::Text => "txt",
            #[cfg(feature = "export-pdf")]
            ExportFormat::Pdf => "pdf",
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
            #[cfg(feature = "export-pdf")]
            "pdf" => Ok(ExportFormat::Pdf),
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
        #[cfg(feature = "export-pdf")]
        ExportFormat::Pdf => export_pdf(recording, transcript, include_metadata),
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
        "*Exported from Nautilus on {}*\n",
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

/// Export to PDF format (requires genpdf feature)
#[cfg(feature = "export-pdf")]
fn export_pdf(
    recording: &Recording,
    transcript: Option<&Transcript>,
    include_metadata: bool,
) -> Result<String> {
    use genpdf::elements::Paragraph;
    use genpdf::{Document, Element};

    // Create document with builtin font
    let mut doc = Document::new(genpdf::fonts::Builtin::Helvetica);
    doc.set_title(&recording.title);
    doc.set_minimal_conformance();

    // Add title
    doc.push(Paragraph::new(&recording.title));
    doc.push(Paragraph::new(""));

    // Add metadata
    if include_metadata {
        doc.push(Paragraph::new("Metadata"));
        doc.push(Paragraph::new(format!(
            "Date: {}",
            recording.created_at.format("%Y-%m-%d %H:%M")
        )));
        doc.push(Paragraph::new(format!(
            "Duration: {}",
            format_duration(recording.duration)
        )));
        doc.push(Paragraph::new(format!("Type: {}", recording.source_type)));
        doc.push(Paragraph::new(format!("Status: {}", recording.status)));
        doc.push(Paragraph::new(""));
    }

    // Add transcript
    if let Some(t) = transcript {
        doc.push(Paragraph::new("Transcript"));
        doc.push(Paragraph::new(""));

        for segment in &t.segments {
            let speaker = segment.speaker_id.as_deref().unwrap_or("Unknown");
            let time = format_time_range(segment.start_time, segment.end_time);

            let text = format!("[{}] {}: {}", time, speaker, segment.text);
            doc.push(Paragraph::new(text));
        }

        doc.push(Paragraph::new(""));
        doc.push(Paragraph::new("Full Text"));
        doc.push(Paragraph::new(&t.full_text));
        doc.push(Paragraph::new(""));

        // Transcription info
        doc.push(Paragraph::new("Transcription Info"));
        doc.push(Paragraph::new(format!("Language: {}", t.language)));
        doc.push(Paragraph::new(format!("Model: {}", t.model)));
        doc.push(Paragraph::new(format!(
            "Confidence: {:.1}%",
            t.confidence * 100.0
        )));
    } else {
        doc.push(Paragraph::new("Transcript not yet available"));
    }

    // Footer
    doc.push(Paragraph::new(""));
    doc.push(Paragraph::new(format!(
        "Exported from Nautilus on {}",
        Utc::now().format("%Y-%m-%d %H:%M")
    )));

    // Generate PDF to string (base64 encoded)
    let mut buffer = Vec::new();
    doc.render_to(&mut buffer).context("Failed to render PDF")?;

    // Return as base64
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(STANDARD.encode(&buffer))
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
    let exports_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
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
