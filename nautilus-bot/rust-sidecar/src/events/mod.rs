use serde::Serialize;

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
    pub acknowledgement_latency_ms: Option<u64>,
    pub capture_ready_latency_ms: Option<u64>,
    pub first_stable_partial_latency_ms: Option<u64>,
    pub final_transcript_latency_ms: Option<u64>,
    pub startup_latency_ms: Option<u64>,
    pub latency_ms: u64,
    pub insert_latency_ms: Option<u64>,
    pub end_to_end_ms: u64,
    pub acknowledged_at_ms: Option<i64>,
    pub capture_ready_at_ms: Option<i64>,
    pub first_stable_partial_at_ms: Option<i64>,
    pub final_transcript_at_ms: i64,
    pub insertion_completed_at_ms: i64,
    pub insertion_mode_used: String,
    pub command_applied: Option<String>,
    pub dictionary_applied_count: usize,
    pub snippet_applied_count: usize,
    pub formatting_applied: bool,
    pub recent_insert_reused: bool,
    pub pipeline_stage_keys: Vec<String>,
    pub app_target: Option<String>,
    pub activation_matcher: Option<String>,
    pub context_source: Option<String>,
    pub context_chars: Option<usize>,
    pub route_preference: Option<String>,
    pub resolved_route: Option<String>,
    pub resolved_hosting: Option<String>,
    pub provider_model_label: Option<String>,
    /// Non-fatal degradations the session recovered from (an LLM pass that
    /// failed or timed out, a command with no text to work on). The text was
    /// still delivered; these explain why it is not what the user expected.
    pub warnings: Vec<String>,
}
