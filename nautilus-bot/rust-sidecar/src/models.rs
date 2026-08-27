use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ANALYSIS_PROVENANCE_VERSION: u32 = 1;

/// Hashes persisted analysis content with an explicit schema/version prefix so
/// future normalization changes can coexist with existing local data.
pub fn analysis_content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    format!(
        "v{}:sha256:{}",
        ANALYSIS_PROVENANCE_VERSION,
        hex::encode(digest)
    )
}

pub fn action_items_content_hash(action_items: &[String]) -> String {
    let canonical = serde_json::to_string(action_items).unwrap_or_else(|_| "[]".to_string());
    analysis_content_hash(&canonical)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisCitation {
    pub text: String,
    #[serde(default)]
    pub line_id: Option<String>,
    #[serde(default)]
    pub segment_id: Option<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub recording_id: Option<String>,
    pub certainty: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProvenance {
    pub version: u32,
    pub content_hash: String,
    pub actual_provider: String,
    pub actual_model: String,
    pub prompt_source: String,
    pub completed_at: DateTime<Utc>,
    pub citations: Vec<AnalysisCitation>,
    pub grounded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemProvenance {
    pub content_hash: String,
    pub citations: Vec<AnalysisCitation>,
    pub grounded: bool,
    #[serde(default)]
    pub generated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemsProvenance {
    pub version: u32,
    pub content_hash: String,
    pub actual_provider: String,
    pub actual_model: String,
    pub prompt_source: String,
    pub completed_at: DateTime<Utc>,
    pub citations: Vec<AnalysisCitation>,
    pub grounded: bool,
    pub items: Vec<ActionItemProvenance>,
}

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
    #[serde(default)]
    pub summary_provenance: Option<AnalysisProvenance>,
    #[serde(default)]
    pub action_items_provenance: Option<ActionItemsProvenance>,
    #[serde(default)]
    pub meeting_notes: Option<String>,
    #[serde(default)]
    pub meeting_template_id: Option<String>,
    #[serde(default)]
    pub meeting_capture_mode: Option<String>,
    #[serde(default)]
    pub notes_updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub consent_prompt_shown: bool,
    #[serde(default)]
    pub consent_notice_mode: Option<String>,
    #[serde(default)]
    pub consent_notice_surface: Option<String>,
    #[serde(default)]
    pub consent_notice_message: Option<String>,
    #[serde(default)]
    pub consent_notice_updated_at: Option<DateTime<Utc>>,
    /// Why the last automatic analysis pass failed, or `None` when the most
    /// recent pass succeeded. Serialized as `analysisFailure`.
    ///
    /// Analysis failure used to be reported only to the log, so a default
    /// install pointing at an uninstalled Ollama silently produced no summary,
    /// no action items, and no title. Persisting the reason is what lets the app
    /// say so and offer a retry.
    #[serde(default)]
    pub analysis_failure: Option<String>,
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
    pub preferred_input_device_id: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub meeting_notes: Option<String>,
    #[serde(default)]
    pub consent_prompt_shown: bool,
    #[serde(default)]
    pub meeting_capture_mode: Option<String>,
    #[serde(default)]
    pub admission_nonce: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DictationDeliveryMode {
    #[default]
    System,
    Preview,
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
    pub route_preference: Option<String>,
    #[serde(default)]
    pub language_override: Option<String>,
    #[serde(default)]
    pub live_preview_enabled: Option<bool>,
    #[serde(default)]
    pub requested_provider: Option<String>,
    #[serde(default)]
    pub requested_model_id: Option<String>,
    #[serde(default)]
    pub actual_provider: Option<String>,
    #[serde(default)]
    pub actual_model_id: Option<String>,
    #[serde(default)]
    pub resolved_route: Option<String>,
    #[serde(default)]
    pub provider_model_label: Option<String>,
    #[serde(default)]
    pub resolved_hosting: Option<String>,
    #[serde(default)]
    pub captured_context_text: Option<String>,
    #[serde(default)]
    pub context_app_name: Option<String>,
    #[serde(default)]
    pub context_app_bundle_id: Option<String>,
    #[serde(default)]
    pub resolved_mode_preset: Option<String>,
    #[serde(default)]
    pub resolved_custom_mode_id: Option<String>,
    #[serde(default)]
    pub resolved_mode_label: Option<String>,
    #[serde(default)]
    pub activation_matcher: Option<String>,
    #[serde(default)]
    pub preferred_input_device_id: Option<String>,
    /// Controls where the final text is delivered. Preview keeps the full
    /// capture, transcription, and durable-history path, but deliberately
    /// avoids clipboard and system-wide insertion side effects.
    #[serde(default)]
    pub delivery_mode: DictationDeliveryMode,
    /// True only when the hands-free idle monitor's own `hands_free_start`
    /// signal triggered this start. It is the one activation path allowed to be
    /// seeded from the monitor's pre-roll ring; a hotkey press means "start
    /// now", and prepending the audio from before the press would put words the
    /// user never meant to dictate at their cursor.
    #[serde(default)]
    pub hands_free_trigger: bool,
}

impl Default for DictationStartOptions {
    fn default() -> Self {
        Self {
            save_to_inbox: true,
            project_id: Some("inbox".to_string()),
            profile: DictationProfile::NormalSpeed,
            context_source: "none".to_string(),
            route_preference: None,
            language_override: None,
            live_preview_enabled: None,
            requested_provider: None,
            requested_model_id: None,
            actual_provider: None,
            actual_model_id: None,
            resolved_route: None,
            provider_model_label: None,
            resolved_hosting: None,
            captured_context_text: None,
            context_app_name: None,
            context_app_bundle_id: None,
            resolved_mode_preset: None,
            resolved_custom_mode_id: None,
            resolved_mode_label: None,
            activation_matcher: None,
            preferred_input_device_id: None,
            delivery_mode: DictationDeliveryMode::System,
            hands_free_trigger: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistoryDetails {
    pub mode_preset: Option<String>,
    pub mode_label: Option<String>,
    pub base_mode_preset: Option<String>,
    pub base_mode_label: Option<String>,
    pub custom_mode_id: Option<String>,
    pub custom_mode_name: Option<String>,
    pub context_source: Option<String>,
    pub context_app_name: Option<String>,
    pub app_target: Option<String>,
    pub activation_matcher: Option<String>,
    pub command_applied: Option<String>,
    pub dictionary_applied_count: Option<u64>,
    pub snippet_applied_count: Option<u64>,
    pub formatting_applied: Option<bool>,
    pub recent_insert_reused: Option<bool>,
    pub pipeline_stage_keys: Vec<String>,
    pub prompt_source: Option<String>,
    pub prompt_preview: Option<String>,
    pub requested_provider: Option<String>,
    pub actual_provider: Option<String>,
    pub model_id: Option<String>,
    pub route_preference: Option<String>,
    pub resolved_hosting: Option<String>,
    pub startup_latency_ms: Option<u64>,
    pub transcription_latency_ms: Option<u64>,
    pub insert_latency_ms: Option<u64>,
    pub end_to_end_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationInsights {
    pub total_dictations: u64,
    pub dictated_words: u64,
    pub average_words_per_dictation: u64,
    pub active_days: u64,
    pub last_seven_days_dictations: u64,
    pub commands_used: u64,
    pub backtracks_used: u64,
    pub snippets_triggered: u64,
    pub top_app_target: Option<String>,
    pub top_app_target_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptDetails {
    pub segment_count: u64,
    pub model: Option<String>,
    pub model_id: Option<String>,
    pub requested_provider: Option<String>,
    pub actual_provider: Option<String>,
    pub quality_score: Option<f64>,
    pub transcription_latency_ms: Option<u64>,
    pub source_mode: String,
    pub has_source_aware_speakers: bool,
    pub has_speaker_labels: bool,
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
pub struct RelationshipMemoryEvidence {
    pub recording_id: String,
    pub recording_title: String,
    pub created_at: DateTime<Utc>,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonMemoryProfile {
    pub id: String,
    pub name: String,
    pub recording_count: u64,
    pub last_seen_at: DateTime<Utc>,
    pub related_companies: Vec<String>,
    pub recent_meetings: Vec<RelationshipMemoryEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyMemoryProfile {
    pub id: String,
    pub name: String,
    pub recording_count: u64,
    pub last_seen_at: DateTime<Utc>,
    pub related_people: Vec<String>,
    pub recent_meetings: Vec<RelationshipMemoryEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipMemory {
    pub people: Vec<PersonMemoryProfile>,
    pub companies: Vec<CompanyMemoryProfile>,
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
pub struct DictationDictionaryEntry {
    pub id: String,
    pub spoken_form: String,
    pub replacement: String,
    pub app_scope: Option<String>,
    pub case_sensitive: bool,
    pub enabled: bool,
    /// Optional dictation-destination-app category key (other/messaging/email/
    /// notes/worklog/ai_chat/code_editor, see `settings::dictation_app_category_to_key`).
    /// `None` means the entry applies regardless of destination-app category.
    #[serde(default)]
    pub category_scope: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDictationDictionaryEntryRequest {
    pub spoken_form: String,
    pub replacement: String,
    #[serde(default)]
    pub app_scope: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub category_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDictationDictionaryEntryRequest {
    pub spoken_form: Option<String>,
    pub replacement: Option<String>,
    pub app_scope: Option<Option<String>>,
    pub case_sensitive: Option<bool>,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub category_scope: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnDictationCorrectionRequest {
    pub original_text: String,
    pub corrected_text: String,
    #[serde(default)]
    pub app_target: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnDictationCorrectionResult {
    pub learned: bool,
    pub action: Option<String>,
    pub reason: Option<String>,
    pub spoken_form: Option<String>,
    pub replacement: Option<String>,
    pub entry: Option<DictationDictionaryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationDictionaryCsvImportResult {
    pub created_count: usize,
    pub updated_count: usize,
    pub skipped_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCorrectionSuggestion {
    pub id: String,
    pub original_text: String,
    pub corrected_text: String,
    pub spoken_form: String,
    pub replacement: String,
    pub app_target: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDictationCorrectionSuggestionResult {
    pub queued: bool,
    pub action: Option<String>,
    pub reason: Option<String>,
    pub spoken_form: Option<String>,
    pub replacement: Option<String>,
    pub suggestion: Option<DictationCorrectionSuggestion>,
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
    /// See `DictationDictionaryEntry::category_scope`.
    #[serde(default)]
    pub category_scope: Option<String>,
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
    #[serde(default)]
    pub category_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDictationSnippetRequest {
    pub trigger: Option<String>,
    pub expansion: Option<String>,
    pub app_scope: Option<Option<String>>,
    pub case_sensitive: Option<bool>,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub category_scope: Option<Option<String>>,
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
