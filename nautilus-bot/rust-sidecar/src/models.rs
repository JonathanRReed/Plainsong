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
    /// The name of the file an imported meeting came from, without its
    /// directory. `None` for every meeting Plainsong recorded itself.
    ///
    /// Stored so the detail view can still say where the audio came from
    /// after the app restarts, and after the reader renames the meeting.
    /// Only the file name is kept: the folder is the reader's business.
    #[serde(default)]
    pub imported_source_name: Option<String>,
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
    /// Every pause taken while this meeting was recording, in order. The
    /// saved audio does not contain the pauses; `at_seconds` on each span is
    /// where the gap sits in it. Serialized as `pauseSpans`; empty for a
    /// meeting that was never paused or predates the feature.
    #[serde(default)]
    pub pause_spans: Vec<crate::recording_pause::PauseSpan>,
    /// The conferencing service this meeting was on ("zoom", "google_meet",
    /// …), when the calendar event or the detected call it started from named
    /// one. Serialized as `videoService`; `None` for every other meeting.
    #[serde(default)]
    pub video_service: Option<String>,
}

/// The conferencing services a recording may be tagged with.
///
/// The same keys the calendar reader and the call detector already produce, so
/// a meeting that began from an event and one that began from a detected call
/// carry the same tag. Renderer-supplied text is matched against this list and
/// dropped when it is not on it: the column is a tag, not a free-text field.
pub const RECORDING_VIDEO_SERVICES: &[&str] = &[
    "zoom",
    "google_meet",
    "microsoft_teams",
    "webex",
    "whereby",
    "gotomeeting",
    "bluejeans",
    "jitsi",
];

/// `value` if it names a service Plainsong knows, otherwise nothing.
pub fn known_video_service(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    RECORDING_VIDEO_SERVICES
        .contains(&value)
        .then(|| value.to_string())
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
    /// The `callId` of the detected call whose offer the reader accepted, when
    /// this capture began that way. Nothing else may bind a meeting's
    /// auto-stop to a call — see `meeting_detect::bind_detected_call`.
    #[serde(default)]
    pub detected_call_id: Option<u64>,
    /// The conferencing service this meeting is on, when the calendar event or
    /// the detected call that started it knew. Stored with the recording so
    /// both routes leave the same tag; anything unrecognized is dropped rather
    /// than stored, since this is renderer-supplied text.
    #[serde(default)]
    pub video_service: Option<String>,
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
    /// A mode chosen for this session only, by a per-mode dictation binding
    /// (roadmap item B4). `None` means "whatever mode is selected in
    /// Settings". The selected mode in Settings is never changed by this.
    #[serde(default)]
    pub mode_override: Option<DictationSessionModeOverride>,
}

/// The mode a single dictation session runs under when a binding named one.
/// `preset` is a built-in preset id (`voice`, `messages`, ...) or `custom`
/// with `custom_mode_id` naming the saved mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictationSessionModeOverride {
    pub preset: String,
    #[serde(default)]
    pub custom_mode_id: Option<String>,
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
            mode_override: None,
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
    /// BCP-47 primary tag the recognizer reported for the spoken audio
    /// (`en` for an English-only model, which cannot detect anything else).
    #[serde(default)]
    pub detected_language: Option<String>,
    /// How translate-to-English ran for this session: `whisper_native`
    /// (the multilingual whisper.cpp translate task), `ai_lane` (a second
    /// pass through the dictation AI provider), or absent when translation
    /// was off.
    #[serde(default)]
    pub translation_route: Option<String>,
    /// Whether the delivered text is the translated one. `false` with a
    /// route set means the pass failed or timed out and the source-language
    /// words were inserted instead.
    #[serde(default)]
    pub translation_applied: Option<bool>,
    /// What the recognizer heard before the pipeline touched it, when the
    /// dictation was saved with it (older rows only kept the delivered text).
    #[serde(default)]
    pub raw_transcript: Option<String>,
    /// Whether the captured audio is still on disk, which is what "Process
    /// again" needs. `None` for dictations saved without audio.
    #[serde(default)]
    pub audio_available: Option<bool>,
    /// Set on an entry produced by "Process again": the dictation whose audio
    /// it re-ran, and when that dictation was captured.
    #[serde(default)]
    pub reprocessed_from_id: Option<String>,
    #[serde(default)]
    pub reprocessed_from_created_at: Option<DateTime<Utc>>,
}

/// The result of running a saved dictation's audio through the pipeline
/// again: the new history entry plus what produced it. Nothing is inserted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationReprocessOutcome {
    pub recording: Recording,
    pub transcript: Transcript,
    pub final_text: String,
    pub raw_text: String,
    pub mode_preset: String,
    pub custom_mode_id: Option<String>,
    pub custom_mode_name: Option<String>,
    pub provider: String,
    pub model_id: String,
    pub used_ai: bool,
    pub reprocessed_from_id: String,
    pub reprocessed_from_created_at: DateTime<Utc>,
    pub transcription_latency_ms: u64,
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

/// One ranked hit from dictation history search.
///
/// `snippet` is a short window of the matched text with each matched term
/// wrapped in `[[` / `]]`, which the renderer turns into a highlight.
/// `matched_field` says whether the delivered text or the raw transcript
/// matched, so the row can say which of the two it is quoting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistorySearchHit {
    pub recording_id: String,
    pub recording_title: String,
    pub created_at: DateTime<Utc>,
    pub snippet: String,
    pub matched_field: String,
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
    /// How Plainsong came to know about this correction: `in_app_edit` (the
    /// user retyped the result inside Plainsong) or `external_app_readback`
    /// (Plainsong read the destination field back after inserting into it).
    /// `None` on rows written before the distinction existed, which were all
    /// in-app edits. The renderer keeps the two apart because the second kind
    /// carries text that came out of another application.
    #[serde(default)]
    pub source: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `DictationCorrectionSuggestion::source` for a correction Plainsong read back
/// out of the app it inserted into.
pub const CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP: &str = "external_app_readback";

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_known_video_service_key_is_kept_as_a_tag() {
        assert_eq!(known_video_service(Some("zoom")).as_deref(), Some("zoom"));
        assert_eq!(
            known_video_service(Some("  google_meet ")).as_deref(),
            Some("google_meet")
        );
        // Renderer-supplied text that is not one of the known keys is dropped
        // rather than stored: the column is a tag, not a free-text field.
        assert_eq!(known_video_service(Some("carrier_pigeon")), None);
        assert_eq!(known_video_service(Some("")), None);
        assert_eq!(known_video_service(None), None);
    }

    #[test]
    fn a_recording_serializes_its_tag_as_video_service() {
        let json = serde_json::json!({
            "id": "r1",
            "title": "Design review",
            "projectId": "default",
            "duration": 0,
            "createdAt": "2026-09-02T10:00:00Z",
            "updatedAt": "2026-09-02T10:00:00Z",
            "sourceType": "meeting",
            "audioPath": "/tmp/r1.wav",
            "status": "recording",
            "videoService": "zoom"
        });
        let recording: Recording = serde_json::from_value(json).expect("deserialize");
        assert_eq!(recording.video_service.as_deref(), Some("zoom"));
        let back = serde_json::to_value(&recording).expect("serialize");
        assert_eq!(back["videoService"], "zoom");
        assert_eq!(back["pauseSpans"], serde_json::json!([]));
    }
}
