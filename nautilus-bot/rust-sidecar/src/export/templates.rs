//! Export templates for different use cases
//!
//! Provides pre-configured templates for:
//! - Meeting notes with action items
//! - Journal entries with timestamps
//! - Medical transcription with specific formatting
//! - Interview transcripts
//! - Quick notes
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Export template definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTemplate {
    /// Template ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Description
    pub description: String,
    /// Output format
    pub format: ExportFormat,
    /// Template content with placeholders
    pub template: String,
    /// Whether to include speaker labels
    pub include_speakers: bool,
    /// Whether to include timestamps
    pub include_timestamps: bool,
    /// Whether to include confidence scores
    pub include_confidence: bool,
    /// Custom fields specific to this template
    pub custom_fields: HashMap<String, String>,
}

/// Export format type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Markdown,
    PlainText,
    Html,
    Json,
    Csv,
    Pdf,
}

impl std::fmt::Display for ExportFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExportFormat::Markdown => write!(f, "markdown"),
            ExportFormat::PlainText => write!(f, "txt"),
            ExportFormat::Html => write!(f, "html"),
            ExportFormat::Json => write!(f, "json"),
            ExportFormat::Csv => write!(f, "csv"),
            ExportFormat::Pdf => write!(f, "pdf"),
        }
    }
}

/// Template manager
pub struct TemplateManager {
    templates: HashMap<String, ExportTemplate>,
}

impl TemplateManager {
    pub fn new() -> Self {
        let mut manager = Self {
            templates: HashMap::new(),
        };

        manager.register_builtin_templates();
        manager
    }

    /// Get a template by ID
    pub fn get_template(&self, id: &str) -> Option<&ExportTemplate> {
        self.templates.get(id)
    }

    /// List all available templates
    pub fn list_templates(&self) -> Vec<&ExportTemplate> {
        self.templates.values().collect()
    }

    /// Register a custom template
    pub fn register_template(&mut self, template: ExportTemplate) {
        self.templates.insert(template.id.clone(), template);
    }

    /// Render a template with data
    pub fn render(&self, template_id: &str, data: &RenderData) -> anyhow::Result<String> {
        let template = self
            .get_template(template_id)
            .ok_or_else(|| anyhow::anyhow!("Template not found: {}", template_id))?;

        let mut output = template.template.clone();

        // Replace placeholders
        output = output.replace("{{title}}", &data.title);
        output = output.replace("{{date}}", &data.date);
        output = output.replace("{{duration}}", &format_duration(data.duration_seconds));
        output = output.replace("{{transcript}}", &data.transcript);
        output = output.replace("{{speakers}}", &format_speakers(&data.speakers));
        output = output.replace("{{action_items}}", &format_action_items(&data.action_items));
        output = output.replace(
            "{{summary}}",
            data.summary.as_ref().unwrap_or(&String::new()),
        );

        Ok(output)
    }

    /// Register built-in templates
    fn register_builtin_templates(&mut self) {
        // Meeting Notes Template
        self.register_template(ExportTemplate {
            id: "meeting".to_string(),
            name: "Meeting Notes".to_string(),
            description: "Structured meeting notes with action items".to_string(),
            format: ExportFormat::Markdown,
            template: MEETING_TEMPLATE.to_string(),
            include_speakers: true,
            include_timestamps: true,
            include_confidence: false,
            custom_fields: HashMap::new(),
        });

        // Journal Template
        self.register_template(ExportTemplate {
            id: "journal".to_string(),
            name: "Journal Entry".to_string(),
            description: "Personal journal with date and time".to_string(),
            format: ExportFormat::Markdown,
            template: JOURNAL_TEMPLATE.to_string(),
            include_speakers: false,
            include_timestamps: false,
            include_confidence: false,
            custom_fields: HashMap::new(),
        });

        // Medical Template
        self.register_template(ExportTemplate {
            id: "medical".to_string(),
            name: "Medical Transcription".to_string(),
            description: "Clinical notes with speaker identification".to_string(),
            format: ExportFormat::PlainText,
            template: MEDICAL_TEMPLATE.to_string(),
            include_speakers: true,
            include_timestamps: true,
            include_confidence: true,
            custom_fields: HashMap::new(),
        });

        // Interview Template
        self.register_template(ExportTemplate {
            id: "interview".to_string(),
            name: "Interview Transcript".to_string(),
            description: "Q&A format with clear speaker labels".to_string(),
            format: ExportFormat::Markdown,
            template: INTERVIEW_TEMPLATE.to_string(),
            include_speakers: true,
            include_timestamps: true,
            include_confidence: false,
            custom_fields: HashMap::new(),
        });

        // Quick Notes Template
        self.register_template(ExportTemplate {
            id: "quick".to_string(),
            name: "Quick Notes".to_string(),
            description: "Minimal formatting for fast capture".to_string(),
            format: ExportFormat::PlainText,
            template: QUICK_TEMPLATE.to_string(),
            include_speakers: false,
            include_timestamps: false,
            include_confidence: false,
            custom_fields: HashMap::new(),
        });

        // Podcast Template
        self.register_template(ExportTemplate {
            id: "podcast".to_string(),
            name: "Podcast Transcript".to_string(),
            description: "Web-ready HTML transcript".to_string(),
            format: ExportFormat::Html,
            template: PODCAST_TEMPLATE.to_string(),
            include_speakers: true,
            include_timestamps: true,
            include_confidence: false,
            custom_fields: HashMap::new(),
        });

        // Research Template
        self.register_template(ExportTemplate {
            id: "research".to_string(),
            name: "Research Notes".to_string(),
            description: "Academic-style with citations and timestamps".to_string(),
            format: ExportFormat::Markdown,
            template: RESEARCH_TEMPLATE.to_string(),
            include_speakers: true,
            include_timestamps: true,
            include_confidence: true,
            custom_fields: HashMap::new(),
        });
    }
}

impl Default for TemplateManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Data for template rendering
pub struct RenderData {
    pub title: String,
    pub date: String,
    pub duration_seconds: u64,
    pub transcript: String,
    pub speakers: Vec<SpeakerInfo>,
    pub action_items: Vec<String>,
    pub summary: Option<String>,
}

/// Speaker information
pub struct SpeakerInfo {
    #[expect(
        dead_code,
        reason = "speaker id is retained for export template compatibility"
    )]
    pub id: String,
    pub name: String,
    pub segments: Vec<(f64, f64, String)>, // start, end, text
}

/// Meeting notes template
const MEETING_TEMPLATE: &str = r#"# {{title}}

**Date:** {{date}} | **Duration:** {{duration}}

---

## Meeting Summary

{{summary}}

---

## Action Items

{{action_items}}

---

## Transcript

{{transcript}}

---

## Attendees
{{speakers}}

---
*Generated by Plainsong*
"#;

/// Journal template
const JOURNAL_TEMPLATE: &str = r#"# {{date}} - {{title}}

{{transcript}}

---
*Duration: {{duration}}*
"#;

/// Medical transcription template
const MEDICAL_TEMPLATE: &str = r#"MEDICAL TRANSCRIPTION
========================

Date: {{date}}
Duration: {{duration}}
Title: {{title}}

TRANSCRIPT:
-----------
{{transcript}}

SPEAKERS:
---------
{{speakers}}
"#;

/// Interview template
const INTERVIEW_TEMPLATE: &str = r#"# {{title}}

**Interview Date:** {{date}}  
**Duration:** {{duration}}

---

## Transcript

{{transcript}}

---
## Participants

{{speakers}}
"#;

/// Quick notes template
const QUICK_TEMPLATE: &str = r#"{{date}} - {{duration}}

{{transcript}}
"#;

/// Podcast template (HTML)
const PODCAST_TEMPLATE: &str = r#"<!DOCTYPE html>
<html>
<head>
    <title>{{title}}</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
        .header { border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .timestamp { color: #666; font-size: 0.85em; margin-right: 10px; }
        .speaker { font-weight: bold; color: #2563eb; }
        .segment { margin: 15px 0; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="header">
        <h1>{{title}}</h1>
        <p>{{date}} | {{duration}}</p>
    </div>
    <div class="transcript">
        {{transcript}}
    </div>
</body>
</html>"#;

/// Research notes template
const RESEARCH_TEMPLATE: &str = r#"---
title: {{title}}
date: {{date}}
duration: {{duration}}
---

# {{title}}

## Transcript

{{transcript}}

## Speaker Breakdown

{{speakers}}

## Key Points

{{summary}}

## Action Items / Follow-ups

{{action_items}}

---
*Confidence scores included where available*
"#;

/// Format duration as human-readable string
fn format_duration(seconds: u64) -> String {
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

/// Format speakers list
fn format_speakers(speakers: &[SpeakerInfo]) -> String {
    if speakers.is_empty() {
        return "No speakers identified".to_string();
    }

    speakers
        .iter()
        .map(|s| format!("- **{}** ({} segments)", s.name, s.segments.len()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Format action items
fn format_action_items(items: &[String]) -> String {
    if items.is_empty() {
        return "No action items identified".to_string();
    }

    items
        .iter()
        .enumerate()
        .map(|(i, item)| format!("{}. {}", i + 1, item))
        .collect::<Vec<_>>()
        .join("\n")
}
