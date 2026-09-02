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
    /// Who was in the meeting, captured from the calendar event that started
    /// it (or typed by hand afterwards). Empty for every meeting that did
    /// not start from a calendar cue, and for everything recorded before
    /// this column existed.
    #[serde(default)]
    pub attendees: Vec<MeetingAttendee>,
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

/// One person in a meeting. Mirrors `MeetingAttendee` in
/// `src/lib/attendees.ts` -- same shape, same caps, same identity rule.
///
/// `email` exists because it is the only reliable way to recognize the same
/// person across two meetings: display names differ between accounts and an
/// address does not. It is stored, shown on a chip's tooltip, and matched
/// against -- and it is never put in a prompt. `attendee_names_for_context`
/// is the only function that produces prompt-bound text from a list, and it
/// drops the address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MeetingAttendee {
    pub name: String,
    pub email: Option<String>,
    pub is_organizer: bool,
}

/// Mirrors `MAX_MEETING_ATTENDEES` in src/lib/attendees.ts. A meeting with
/// more invitees than this is a mailing list, and the header chips would be
/// unreadable long before the list was.
pub const MAX_MEETING_ATTENDEES: usize = 40;
const MAX_ATTENDEE_FIELD_LENGTH: usize = 256;

/// True for a character that steers rendering rather than saying anything.
///
/// C0/C1 controls, the bidi marks and isolates (U+200E/U+200F, U+202A-U+202E,
/// U+2066-U+2069) and the zero-width joiners and BOM. Whitespace collapsing
/// does not touch any of them: `split_whitespace` sees U+202E as an ordinary
/// character, so a name of "Dana\u{202E}kafo" survived the whole sanitizer.
///
/// They matter because an attendee name is not just a chip. It is rendered
/// beside other text in the meeting header, written verbatim into an export,
/// and -- through `attendee_names_for_context` -- placed inside a fenced block
/// in a prompt. A right-to-left override there reverses everything drawn after
/// it, which is how one line of a document is made to read as another. The
/// name is calendar text somebody else wrote, so it is exactly the text that
/// should not be able to do that.
///
/// Mirrors `isFormattingControl` in src/lib/attendees.ts.
fn is_formatting_control(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
            | '\u{feff}'
    )
}

/// Strip the steering characters, then collapse runs of whitespace.
///
/// In that order: a control character is not whitespace, so collapsing first
/// would leave "Dana\u{202e} Okafor" with the override still in it, and
/// removing it afterwards would leave the double space behind.
///
/// Mirrors `normalizeAttendeeText` in src/lib/attendees.ts.
fn collapse_whitespace(value: &str) -> String {
    value
        .chars()
        .filter(|c| !is_formatting_control(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn clip_attendee_field(value: &str) -> String {
    let collapsed = collapse_whitespace(value);
    if collapsed.chars().count() <= MAX_ATTENDEE_FIELD_LENGTH {
        return collapsed;
    }
    collapsed
        .chars()
        .take(MAX_ATTENDEE_FIELD_LENGTH)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// How two attendee entries are recognized as the same person.
///
/// Address first, because display names differ between accounts ("J. Reed"
/// in one invite, "Jonathan Reed" in another) and an address does not. Name
/// only when there is no address.
pub fn attendee_identity_key(name: &str, email: Option<&str>) -> String {
    match email.map(str::trim).filter(|value| !value.is_empty()) {
        Some(address) => format!("email:{}", address.to_lowercase()),
        None => format!("name:{}", collapse_whitespace(name).to_lowercase()),
    }
}

/// Trim, de-duplicate and cap an attendee list, whatever produced it.
///
/// Run on every path that stores one -- the renderer's write command, and
/// the read back out of SQLite -- so a duplicated invite or a hand-edited
/// database row cannot put the same person on the header twice, and so a
/// crafted payload cannot store 5000 of them.
pub fn sanitize_meeting_attendees(attendees: Vec<MeetingAttendee>) -> Vec<MeetingAttendee> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for attendee in attendees {
        let name = clip_attendee_field(&attendee.name);
        if name.is_empty() {
            continue;
        }
        let email = attendee
            .email
            .as_deref()
            .map(clip_attendee_field)
            .filter(|value| !value.is_empty());
        let key = attendee_identity_key(&name, email.as_deref());
        if !seen.insert(key) {
            continue;
        }
        result.push(MeetingAttendee {
            name,
            email,
            is_organizer: attendee.is_organizer,
        });
        if result.len() >= MAX_MEETING_ATTENDEES {
            break;
        }
    }
    result
}

/// The names, and only the names, for a grounded prompt's "Attendees:" line.
///
/// The single place an attendee list becomes prompt-bound text. Addresses are
/// dropped here rather than at each call site so there is exactly one thing
/// to audit: a summary lane pointed at a cloud provider must not carry the
/// reader's contact book there, and a model does not answer better for
/// knowing someone's employer domain.
pub fn attendee_names_for_context(attendees: &[MeetingAttendee]) -> Vec<String> {
    attendees
        .iter()
        .map(|attendee| collapse_whitespace(&attendee.name))
        .filter(|name| !name.is_empty())
        .collect()
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
mod attendee_tests {
    use super::{
        attendee_identity_key, attendee_names_for_context, sanitize_meeting_attendees,
        MeetingAttendee, MAX_MEETING_ATTENDEES,
    };

    fn attendee(name: &str, email: Option<&str>) -> MeetingAttendee {
        MeetingAttendee {
            name: name.to_string(),
            email: email.map(str::to_string),
            is_organizer: false,
        }
    }

    #[test]
    fn identity_prefers_the_address_over_the_display_name() {
        assert_eq!(
            attendee_identity_key("J. Reed", Some("j@example.com")),
            attendee_identity_key("Jonathan Reed", Some("J@Example.com")),
            "the same address is the same person however the invite spelled the name"
        );
        assert_eq!(
            attendee_identity_key("  Alice   Brown ", None),
            attendee_identity_key("alice brown", None)
        );
        assert_ne!(
            attendee_identity_key("Alex", Some("a@one.com")),
            attendee_identity_key("Alex", Some("a@two.com"))
        );
    }

    #[test]
    fn sanitize_drops_nameless_and_duplicate_entries_and_caps_the_list() {
        let sanitized = sanitize_meeting_attendees(vec![
            attendee("   ", None),
            attendee("  Alice   Brown ", None),
            attendee("Alice Brown", None),
            attendee("Bob", Some("bob@example.com")),
            attendee("Robert", Some("BOB@example.com")),
        ]);
        assert_eq!(
            sanitized
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alice Brown", "Bob"]
        );

        let many: Vec<MeetingAttendee> = (0..(MAX_MEETING_ATTENDEES + 20))
            .map(|index| attendee(&format!("Person {index}"), None))
            .collect();
        assert_eq!(
            sanitize_meeting_attendees(many).len(),
            MAX_MEETING_ATTENDEES
        );
    }

    #[test]
    fn sanitize_treats_a_blank_address_as_no_address() {
        let sanitized = sanitize_meeting_attendees(vec![attendee("Alice", Some("   "))]);
        assert_eq!(sanitized[0].email, None);
    }

    /// A display name comes off somebody else's calendar invite. A
    /// right-to-left override in one reverses every glyph drawn after it, in
    /// the header, in an export, and inside the fenced block of a prompt.
    #[test]
    fn sanitize_strips_bidi_overrides_and_control_characters() {
        let sanitized = sanitize_meeting_attendees(vec![MeetingAttendee {
            name: "Dana\u{202e}\u{2066} Okafor\u{7}".to_string(),
            email: Some("dana\u{200b}@example.com".to_string()),
            is_organizer: false,
        }]);
        assert_eq!(sanitized[0].name, "Dana Okafor");
        assert_eq!(sanitized[0].email.as_deref(), Some("dana@example.com"));
        assert!(!sanitized[0].name.chars().any(super::is_formatting_control));

        // The prompt path is the one that matters most, and it reads the same
        // normalizer, so an override cannot ride a name into a fenced block.
        let names = attendee_names_for_context(&[MeetingAttendee {
            name: "\u{202d}Sam\u{202c} Ito".to_string(),
            email: None,
            is_organizer: false,
        }]);
        assert_eq!(names, vec!["Sam Ito"]);

        // And a name that is nothing but steering characters is not a name.
        assert!(sanitize_meeting_attendees(vec![MeetingAttendee {
            name: "\u{202e}\u{feff}".to_string(),
            email: None,
            is_organizer: false,
        }])
        .is_empty());
    }

    /// The one rule the whole feature rests on: names may reach a prompt,
    /// addresses never do. A summary lane pointed at a cloud provider must
    /// not carry the reader's contact book there.
    #[test]
    fn context_names_never_carry_an_address() {
        let names = attendee_names_for_context(&[
            attendee("Alice  Brown", Some("alice@acme-holdings.example")),
            attendee("Bob", Some("bob@example.com")),
            attendee("   ", None),
        ]);
        assert_eq!(names, vec!["Alice Brown", "Bob"]);
        assert!(!names.join(" ").contains('@'));
    }
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
