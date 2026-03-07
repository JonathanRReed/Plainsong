use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStateChangedEvent {
    pub phase: String,
    pub started_at_ms: Option<i64>,
    pub message: Option<String>,
    pub preview: Option<String>,
    pub session_id: Option<u64>,
    pub stop_reason: Option<String>,
    pub outcome: Option<String>,
    pub resolved_mode_preset: Option<String>,
    pub resolved_custom_mode_id: Option<String>,
    pub resolved_mode_label: Option<String>,
    pub context_source: Option<String>,
    pub insertion_mode: Option<String>,
    pub app_target: Option<String>,
    pub dictation_provider: Option<String>,
    pub dictation_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecordingStateChangedEvent {
    pub phase: String,
    pub recording_id: Option<String>,
    pub started_at_ms: Option<i64>,
    pub system_audio_active: Option<bool>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatusChangedEvent {
    pub recording_id: String,
    pub status: String,
    pub message: Option<String>,
    pub progress: Option<f64>,
    pub updated_at: String,
    pub meeting_processing_started_at: Option<String>,
    pub transcript_first_available_at: Option<String>,
    pub consent_prompt_shown: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationTextReadyEvent {
    pub session_id: u64,
    pub stop_reason: String,
    pub outcome: String,
    pub text: String,
    pub pasted: bool,
    pub copied: bool,
    pub paste_error: Option<String>,
    pub requested_provider: String,
    pub actual_provider: String,
    pub is_fallback: bool,
    pub requested_engine: Option<String>,
    pub actual_engine: Option<String>,
    pub optimization_applied: Option<bool>,
    pub fallback_reason: Option<String>,
    pub fallback_message: Option<String>,
    pub model_id: String,
    pub startup_latency_ms: Option<u64>,
    pub latency_ms: u64,
    pub insert_latency_ms: Option<u64>,
    pub end_to_end_ms: u64,
    pub insertion_mode_used: String,
    pub command_applied: Option<String>,
    pub snippet_applied_count: usize,
    pub app_target: Option<String>,
    pub context_source: Option<String>,
    pub context_chars: Option<usize>,
}
