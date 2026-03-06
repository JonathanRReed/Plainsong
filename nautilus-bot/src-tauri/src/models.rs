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
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub consent_prompt_shown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DictationProfile {
    #[default]
    #[serde(rename = "normal_speed", alias = "speed")]
    NormalSpeed,
    #[serde(rename = "power_rewrite", alias = "accuracy")]
    PowerRewrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationStartOptions {
    pub save_to_inbox: bool,
    pub project_id: Option<String>,
    pub profile: DictationProfile,
    #[serde(default)]
    pub context_source: String,
    #[serde(default)]
    pub captured_context_text: Option<String>,
    #[serde(default)]
    pub context_app_name: Option<String>,
}

impl Default for DictationStartOptions {
    fn default() -> Self {
        Self {
            save_to_inbox: true,
            project_id: Some("inbox".to_string()),
            profile: DictationProfile::NormalSpeed,
            context_source: "none".to_string(),
            captured_context_text: None,
            context_app_name: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistoryDetails {
    pub mode_preset: Option<String>,
    pub context_source: Option<String>,
    pub context_preview: Option<String>,
    pub context_app_name: Option<String>,
    pub app_target: Option<String>,
    pub command_applied: Option<String>,
    pub prompt_source: Option<String>,
    pub prompt_preview: Option<String>,
    pub requested_provider: Option<String>,
    pub actual_provider: Option<String>,
    pub model_id: Option<String>,
    pub transcription_latency_ms: Option<u64>,
    pub insert_latency_ms: Option<u64>,
    pub end_to_end_ms: Option<u64>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSnippet {
    pub id: String,
    pub trigger: String,
    pub expansion: String,
    pub app_scope: Option<String>,
    pub case_sensitive: bool,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDictationSnippetRequest {
    pub trigger: String,
    pub expansion: String,
    #[serde(default)]
    pub app_scope: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDictationSnippetRequest {
    pub trigger: Option<String>,
    pub expansion: Option<String>,
    pub app_scope: Option<Option<String>>,
    pub case_sensitive: Option<bool>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCommandPreset {
    pub id: String,
    pub command_key: String,
    pub system_prompt: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertDictationCommandPresetRequest {
    pub command_key: String,
    pub system_prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}
