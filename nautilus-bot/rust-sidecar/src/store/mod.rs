use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventRecord {
    pub id: String,
    pub event_type: String,
    pub surface: Option<String>,
    pub session_id: Option<String>,
    pub recording_id: Option<String>,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSessionRecord {
    pub id: String,
    pub surface: String,
    pub state: String,
    pub started_at: DateTime<Utc>,
    pub stopped_at: Option<DateTime<Utc>>,
    pub audio_sources: Vec<String>,
    pub target_app: Option<String>,
    pub context_snapshot_id: Option<String>,
    pub policy_snapshot_id: Option<String>,
    pub provider_plan_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshotRecord {
    pub id: String,
    pub frontmost_app: Option<String>,
    pub frontmost_bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    pub clipboard_text: Option<String>,
    pub meeting_hint: Option<String>,
    pub active_mode: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptArtifactRecord {
    pub id: String,
    pub recording_id: String,
    pub transcript_id: Option<String>,
    pub segment_count: i64,
    pub model_id: Option<String>,
    pub requested_provider: Option<String>,
    pub actual_provider: Option<String>,
    pub quality_score: Option<f64>,
    pub startup_latency_ms: Option<i64>,
    pub transcription_latency_ms: Option<i64>,
    pub insert_latency_ms: Option<i64>,
    pub end_to_end_ms: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertionActionRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub recording_id: Option<String>,
    pub requested_mode: String,
    pub actual_mode: String,
    pub pasted: bool,
    pub copied: bool,
    pub failed: bool,
    pub undo_token: Option<String>,
    pub command_applied: Option<String>,
    pub snippet_applied_count: i64,
    pub app_target: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingChatCitationRecord {
    pub text: String,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub recording_id: Option<String>,
    pub certainty: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingChatMessageRecord {
    pub id: String,
    pub role: String,
    pub content: String,
    pub template_id: Option<String>,
    pub citations: Vec<MeetingChatCitationRecord>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingArtifactRecord {
    pub id: String,
    pub recording_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub action_items: Vec<String>,
    #[serde(default)]
    pub summary_provenance: Option<crate::models::AnalysisProvenance>,
    #[serde(default)]
    pub action_items_provenance: Option<crate::models::ActionItemsProvenance>,
    pub decisions: Vec<String>,
    pub deadlines: Vec<String>,
    pub template_id: Option<String>,
    pub chat_messages: Vec<MeetingChatMessageRecord>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshotRecord {
    pub id: String,
    pub retention_mode: String,
    pub storage_mode: String,
    pub provider_policy: serde_json::Value,
    pub ai_policy: serde_json::Value,
    pub insertion_policy: serde_json::Value,
    pub export_constraints: serde_json::Value,
    pub created_at: DateTime<Utc>,
}
