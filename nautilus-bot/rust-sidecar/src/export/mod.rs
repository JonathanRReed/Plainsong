//! Export system for recordings and transcripts
//!
//! Supports multiple formats:
//! - Markdown (.md) - Human-readable with formatting
//! - JSON (.json) - Machine-readable with full metadata
//! - TXT (.txt) - Plain text
//! - SRT (.srt) / WebVTT (.vtt) - Subtitles built from the timed segments
//! - Word (.docx) - The Markdown document, written as an Office package
//!
//! Every format is produced as text, and `encode_export` turns that text into
//! the bytes a file gets. For `.docx` the text is the Markdown the document is
//! built from, which is also what a preview shows. Redaction runs on the text
//! (see `transcription::export_with_policy`), except for the subtitle formats,
//! whose own scaffolding is digits — those are redacted at the source instead;
//! `redacts_before_render` says which is which.

use anyhow::{Context, Result};
use chrono::Utc;
pub mod action_items;
pub mod docx;
pub mod subtitles;
pub mod templates;

use crate::models::{Recording, Transcript};
use std::collections::HashMap;
use std::path::PathBuf;

/// Export format
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportFormat {
    Markdown,
    Json,
    Text,
    Srt,
    Vtt,
    Docx,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Json => "json",
            ExportFormat::Text => "txt",
            ExportFormat::Srt => "srt",
            ExportFormat::Vtt => "vtt",
            ExportFormat::Docx => "docx",
        }
    }

    /// True when the written file is not the export text itself. Callers that
    /// show a preview say so rather than implying the preview is the file.
    pub fn is_binary(&self) -> bool {
        matches!(self, ExportFormat::Docx)
    }

    /// True when redaction has to run on the transcript before the document is
    /// built, rather than over the finished text.
    ///
    /// Subtitle files carry structure made of digits: cue numbers and
    /// timestamps. A meeting long enough to reach cue 1000 would have that
    /// number masked by the strict level's four-digit rule, and the file would
    /// no longer parse. Redacting the segments first keeps redaction on the
    /// content, where it belongs, and leaves the format's own scaffolding
    /// alone.
    pub fn redacts_before_render(&self) -> bool {
        matches!(self, ExportFormat::Srt | ExportFormat::Vtt)
    }
}

impl std::str::FromStr for ExportFormat {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "md" | "markdown" => Ok(ExportFormat::Markdown),
            "json" => Ok(ExportFormat::Json),
            "txt" | "text" => Ok(ExportFormat::Text),
            "srt" | "subtitles" => Ok(ExportFormat::Srt),
            "vtt" | "webvtt" => Ok(ExportFormat::Vtt),
            "docx" | "word" => Ok(ExportFormat::Docx),
            _ => Err(anyhow::anyhow!("Unknown export format: {}", s)),
        }
    }
}

/// What an export needs beyond the recording row and its transcript.
///
/// Only speaker names so far: subtitles label a cue with the alias a person
/// set in the transcript viewer instead of the raw `me`/`them` capture side.
#[derive(Debug, Clone, Default)]
pub struct ExportContext {
    pub speaker_names: HashMap<String, String>,
}

/// Export a recording to the specified format.
///
/// The result is always text. For `ExportFormat::Docx` it is the Markdown the
/// Word document is built from: call `encode_export` (after redaction) for the
/// bytes that belong in the file.
pub fn export_recording(
    recording: &Recording,
    transcript: Option<&Transcript>,
    format: ExportFormat,
    include_metadata: bool,
    context: &ExportContext,
) -> Result<String> {
    match format {
        // Word documents are the Markdown export, re-encoded by `encode_export`.
        ExportFormat::Markdown | ExportFormat::Docx => {
            export_markdown(recording, transcript, include_metadata)
        }
        ExportFormat::Json => export_json(recording, transcript),
        ExportFormat::Text => export_text(recording, transcript),
        ExportFormat::Srt => export_subtitles(transcript, subtitles::SubtitleFormat::Srt, context),
        ExportFormat::Vtt => export_subtitles(transcript, subtitles::SubtitleFormat::Vtt, context),
    }
}

/// The bytes that belong in the export file, from the (already redacted)
/// export text.
pub fn encode_export(format: ExportFormat, text: &str) -> Result<Vec<u8>> {
    if !format.is_binary() {
        return Ok(text.as_bytes().to_vec());
    }
    match format {
        ExportFormat::Docx => docx::markdown_to_docx(text),
        // Unreachable while Docx is the only binary format; a new one added to
        // `is_binary` without an encoder should say so instead of writing the
        // source text into a file that claims to be something else.
        other => anyhow::bail!("Export format .{} has no encoder", other.extension()),
    }
}

/// Subtitles need timed segments, which a recording only has once it has been
/// transcribed. Say so instead of writing an empty cue list.
fn export_subtitles(
    transcript: Option<&Transcript>,
    format: subtitles::SubtitleFormat,
    context: &ExportContext,
) -> Result<String> {
    let transcript = transcript.ok_or_else(|| {
        anyhow::anyhow!("This recording has no transcript yet, so it has no subtitles to export")
    })?;
    let cues = subtitles::build_cues(&transcript.segments, true, &context.speaker_names);
    if cues.is_empty() {
        anyhow::bail!(
            "This transcript has no timed segments, so subtitles cannot be built from it"
        );
    }
    Ok(subtitles::render(&cues, format))
}

/// One attendee as an export writes them: name, organizer mark, address.
///
/// An export is the reader's own file on their own disk, so unlike a prompt it
/// carries the address the meeting header only shows on hover. The prompt path
/// is `models::attendee_names_for_context`, which drops addresses; the two must
/// stay separate, and this function is deliberately not reachable from it.
fn attendee_export_line(attendee: &crate::models::MeetingAttendee) -> String {
    let mut line = attendee.name.clone();
    if attendee.is_organizer {
        line.push_str(" (organizer)");
    }
    if let Some(email) = attendee
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        line.push_str(&format!(" <{email}>"));
    }
    line
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
        if !recording.attendees.is_empty() {
            output.push_str("## Attendees\n\n");
            for attendee in &recording.attendees {
                output.push_str(&format!("- {}\n", attendee_export_line(attendee)));
            }
            output.push('\n');
        }

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

        let action_items =
            action_items::structured_action_items(recording.action_items.as_deref().unwrap_or(&[]));
        if !action_items.is_empty() {
            output.push_str("## Action Items\n\n");
            for item in &action_items {
                output.push_str(&action_items::markdown_bullet(item));
                output.push('\n');
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
            // The same items with the stored `(Owner: … · Due: …)` suffix read
            // back into parts, so a downstream tool does not have to re-parse
            // the line. `action_items` above stays the verbatim stored text.
            "action_items_structured": action_items::structured_action_items(
                recording.action_items.as_deref().unwrap_or(&[]),
            ),
            // Names AND addresses: an export is the reader's own file. The
            // prompt path drops addresses (`attendee_names_for_context`); this
            // one deliberately does not.
            "attendees": recording.attendees,
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
        if !recording.attendees.is_empty() {
            output.push_str("ATTENDEES\n");
            output.push_str(&"=".repeat(50));
            output.push_str("\n\n");
            for attendee in &recording.attendees {
                output.push_str(&format!("- {}\n", attendee_export_line(attendee)));
            }
            output.push('\n');
        }

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
            attendees: Vec::new(),
            pause_spans: Vec::new(),
            video_service: None,
            transcript_complete: true,
            transcript_degraded_reason: None,
            transcript_incomplete_acknowledged_at: None,
            capture_degraded_summary: None,
        }
    }

    /// `docs/beta/PRIVACY-AND-CLOUD.md` promises the reader that the addresses
    /// the meeting header only shows on hover are in their export. This is that
    /// promise: names AND addresses in Markdown (which is also the .docx text),
    /// plain text and JSON. The prompt path is the opposite rule and is pinned
    /// separately by `context_names_never_carry_an_address` in `models.rs`.
    #[test]
    fn meeting_exports_carry_attendee_names_and_addresses() {
        let mut recording = meeting_recording_with_recap();
        recording.attendees = vec![
            crate::models::MeetingAttendee {
                name: "Dana Okafor".to_string(),
                email: Some("dana@example.com".to_string()),
                is_organizer: true,
            },
            crate::models::MeetingAttendee {
                name: "Sam Ito".to_string(),
                email: None,
                is_organizer: false,
            },
        ];

        let markdown = export_markdown(&recording, None, false).expect("markdown export");
        assert!(
            markdown.contains(
                "## Attendees\n\n- Dana Okafor (organizer) <dana@example.com>\n- Sam Ito\n"
            ),
            "markdown export should list attendees with their addresses: {markdown}"
        );
        // The .docx is built from exactly this text, so it carries them too.
        assert_eq!(
            export_recording(
                &recording,
                None,
                ExportFormat::Docx,
                false,
                &ExportContext::default()
            )
            .expect("docx export text"),
            markdown
        );

        let text = export_text(&recording, None).expect("text export");
        assert!(text.contains("- Dana Okafor (organizer) <dana@example.com>"));

        let json: serde_json::Value =
            serde_json::from_str(&export_json(&recording, None).expect("json export"))
                .expect("json export parses");
        assert_eq!(
            json["recording"]["attendees"],
            serde_json::json!([
                { "name": "Dana Okafor", "email": "dana@example.com", "isOrganizer": true },
                { "name": "Sam Ito", "email": null, "isOrganizer": false },
            ])
        );
    }

    /// A meeting with nobody recorded on it must not grow an empty heading.
    #[test]
    fn an_export_with_no_attendees_has_no_attendee_section() {
        let recording = meeting_recording_with_recap();
        assert!(recording.attendees.is_empty());
        assert!(!export_markdown(&recording, None, false)
            .expect("markdown export")
            .contains("## Attendees"));
        assert!(!export_text(&recording, None)
            .expect("text export")
            .contains("ATTENDEES"));
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

    fn transcript_with_segments() -> Transcript {
        let now = Utc
            .with_ymd_and_hms(2026, 8, 9, 2, 13, 0)
            .single()
            .expect("valid test timestamp");
        Transcript {
            id: "transcript-1".to_string(),
            recording_id: "meeting-1".to_string(),
            segments: vec![
                crate::models::TranscriptSegment {
                    id: "s1".to_string(),
                    start_time: 0.0,
                    end_time: 2.0,
                    text: "Let's start the review.".to_string(),
                    speaker_id: Some("me".to_string()),
                    confidence: 0.9,
                },
                crate::models::TranscriptSegment {
                    id: "s2".to_string(),
                    start_time: 2.0,
                    end_time: 5.5,
                    text: "Sending the deck on Friday.".to_string(),
                    speaker_id: Some("them".to_string()),
                    confidence: 0.9,
                },
            ],
            full_text: "Let's start the review. Sending the deck on Friday.".to_string(),
            language: "en".to_string(),
            confidence: 0.91,
            model: "distil-whisper-large-v3.5".to_string(),
            model_id: None,
            requested_provider: None,
            actual_provider: Some("distil_whisper".to_string()),
            created_at: now,
        }
    }

    #[test]
    fn formats_round_trip_through_their_names_and_extensions() {
        for (name, format, extension) in [
            ("markdown", ExportFormat::Markdown, "md"),
            ("json", ExportFormat::Json, "json"),
            ("text", ExportFormat::Text, "txt"),
            ("srt", ExportFormat::Srt, "srt"),
            ("vtt", ExportFormat::Vtt, "vtt"),
            ("docx", ExportFormat::Docx, "docx"),
        ] {
            let parsed: ExportFormat = name.parse().expect("known format name");
            assert_eq!(parsed, format, "{name}");
            assert_eq!(parsed.extension(), extension, "{name}");
        }
        assert!("pdf".parse::<ExportFormat>().is_err());
        assert!(ExportFormat::Docx.is_binary());
        assert!(!ExportFormat::Srt.is_binary());
    }

    #[test]
    fn subtitle_exports_carry_the_timed_segments_and_speaker_aliases() {
        let context = ExportContext {
            speaker_names: HashMap::from([("them".to_string(), "Priya".to_string())]),
        };
        let srt = export_recording(
            &meeting_recording_with_recap(),
            Some(&transcript_with_segments()),
            ExportFormat::Srt,
            true,
            &context,
        )
        .expect("srt export");
        assert_eq!(
            srt,
            "1\n00:00:00,000 --> 00:00:02,000\nMe: Let's start the review.\n\n\
             2\n00:00:02,000 --> 00:00:05,500\nPriya: Sending the deck on Friday.\n\n"
        );

        let vtt = export_recording(
            &meeting_recording_with_recap(),
            Some(&transcript_with_segments()),
            ExportFormat::Vtt,
            true,
            &context,
        )
        .expect("vtt export");
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:02.000 --> 00:00:05.500"));
    }

    #[test]
    fn subtitle_export_without_timed_segments_says_why() {
        let recording = meeting_recording_with_recap();
        let error = export_recording(
            &recording,
            None,
            ExportFormat::Srt,
            true,
            &ExportContext::default(),
        )
        .expect_err("no transcript means no subtitles");
        assert!(error.to_string().contains("no transcript yet"), "{error}");

        let mut empty = transcript_with_segments();
        empty.segments.clear();
        let error = export_recording(
            &recording,
            Some(&empty),
            ExportFormat::Vtt,
            true,
            &ExportContext::default(),
        )
        .expect_err("no segments means no cues");
        assert!(error.to_string().contains("no timed segments"), "{error}");
    }

    #[test]
    fn docx_export_text_is_the_markdown_and_encodes_to_a_word_package() {
        let recording = meeting_recording_with_recap();
        let markdown = export_recording(
            &recording,
            None,
            ExportFormat::Markdown,
            true,
            &ExportContext::default(),
        )
        .expect("markdown export");
        let docx_source = export_recording(
            &recording,
            None,
            ExportFormat::Docx,
            true,
            &ExportContext::default(),
        )
        .expect("docx export source");
        assert_eq!(docx_source, markdown, "a .docx is the Markdown export");

        let bytes = encode_export(ExportFormat::Docx, &docx_source).expect("encode docx");
        assert_eq!(&bytes[..2], b"PK", "a .docx is a zip package");
        assert_eq!(
            encode_export(ExportFormat::Markdown, &markdown).expect("encode markdown"),
            markdown.as_bytes(),
            "text formats are written as their own bytes"
        );
    }

    #[test]
    fn markdown_and_json_spell_out_an_owner_and_a_due_date() {
        let mut recording = meeting_recording_with_recap();
        recording.action_items = Some(vec![
            "Send the deck (Owner: Priya · Due: Friday)".to_string(),
            "Plain follow-up".to_string(),
        ]);

        let markdown = export_markdown(&recording, None, false).expect("markdown export");
        assert!(
            markdown.contains("- Send the deck — **Owner:** Priya · **Due:** Friday"),
            "{markdown}"
        );
        assert!(markdown.contains("- Plain follow-up"));

        let json = export_json(&recording, None).expect("json export");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid export json");
        assert_eq!(
            parsed["recording"]["action_items"][0], "Send the deck (Owner: Priya · Due: Friday)",
            "the verbatim stored line is preserved"
        );
        let structured = &parsed["recording"]["action_items_structured"];
        assert_eq!(structured[0]["task"], "Send the deck");
        assert_eq!(structured[0]["owner"], "Priya");
        assert_eq!(structured[0]["due_date"], "Friday");
        assert_eq!(structured[1]["task"], "Plain follow-up");
        assert!(structured[1]["owner"].is_null());
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
