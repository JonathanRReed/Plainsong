use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub duration: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub source_type: String,
    pub audio_path: String,
    pub status: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub action_items: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub id: String,
    pub recording_id: String,
    pub segments: Vec<TranscriptSegment>,
    pub full_text: String,
    pub language: String,
    pub confidence: f64,
    pub model: String,
    pub model_id: Option<String>,
    pub requested_provider: Option<String>,
    pub actual_provider: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub speaker_id: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Whether this project uses per-project encryption
    pub encrypted: bool,
    /// Key salt for derivation (stored, not the key itself)
    pub key_salt: Option<String>,
    /// Key hint for user (optional reminder)
    pub key_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub mic: bool,
    pub system_audio: bool,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DictationProfile {
    #[default]
    Speed,
    Accuracy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationStartOptions {
    pub save_to_inbox: bool,
    pub project_id: Option<String>,
    pub profile: DictationProfile,
}

impl Default for DictationStartOptions {
    fn default() -> Self {
        Self {
            save_to_inbox: true,
            project_id: Some("inbox".to_string()),
            profile: DictationProfile::Speed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub event: String,
    pub details: serde_json::Value,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub recording_id: String,
    pub recording_title: String,
    pub project_id: String,
    pub segment_id: String,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrBenchmarkEntry {
    pub id: String,
    pub provider_type: String,
    pub provider_name: String,
    pub model_id: String,
    pub runtime_status: String,
    pub non_empty_transcript: bool,
    pub processing_time_ms: i64,
    pub confidence: f64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub format: String,
    pub redaction_level: String,
    pub preview: bool,
    pub export_path: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateExportResponse {
    pub template_id: String,
    pub preview: bool,
    pub export_path: Option<String>,
    pub content: Option<String>,
}
