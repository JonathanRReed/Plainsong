//! Settings and user preferences persistence
//!
//! Manages user configuration including:
//! - Audio settings (input device preferences)
//! - Transcription preferences
//! - UI settings
//! - Keyboard shortcuts
//!
//! Every field in this schema must have a real runtime reader. Dead
//! "placebo" fields are removed outright (see `REMOVED_SETTINGS_KEYS` for
//! the load-time migration that strips their stale keys from settings.json).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::text::format::{self, DictationAppCategory};

pub(crate) fn nautilus_config_dir() -> Result<PathBuf> {
    let config_dir = crate::paths::config_dir()
        .context("Could not find config directory")?
        .join("Plainsong");

    std::fs::create_dir_all(&config_dir)?;

    Ok(config_dir)
}

pub(crate) fn settings_file_path() -> Result<PathBuf> {
    Ok(nautilus_config_dir()?.join("settings.json"))
}

/// Application settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Audio recording settings
    pub audio: AudioSettings,
    /// Transcription preferences
    pub transcription: TranscriptionSettings,
    /// UI preferences
    pub ui: UiSettings,
    /// Export configuration (transitional empty container; see `ExportSettings`)
    pub export: ExportSettings,
    /// Privacy and security
    pub privacy: PrivacySettings,
    /// Keyboard shortcuts
    pub shortcuts: KeyboardShortcuts,
    /// Update preferences
    pub updates: UpdateSettings,
    /// Meeting behaviours that live around a capture rather than inside it:
    /// noticing a call, ending a meeting nobody is in any more.
    pub meetings: MeetingsSettings,
    /// Which events may reach macOS Notification Center.
    pub notifications: NotificationsSettings,
    /// Local automation surfaces (command-line tool, MCP server, deep links).
    pub automation: AutomationSettings,
    /// Theme
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            audio: AudioSettings::default(),
            transcription: TranscriptionSettings::default(),
            ui: UiSettings::default(),
            export: ExportSettings::default(),
            privacy: PrivacySettings::default(),
            shortcuts: KeyboardShortcuts::default(),
            updates: UpdateSettings::default(),
            meetings: MeetingsSettings::default(),
            notifications: NotificationsSettings::default(),
            automation: AutomationSettings::default(),
            theme: "system".to_string(),
        }
    }
}

/// Local automation surfaces: the `plainsong` command-line tool, the read-only
/// MCP server it serves, and `plainsong://` deep links.
///
/// One switch gates all three because they share one consequence: another
/// process on this Mac can read meeting notes, transcripts and dictation
/// history (the CLI/MCP) or trigger a dictation/meeting gesture (deep links).
/// Off by default; nothing else in the app reads this section, so a fresh
/// install behaves exactly as it did before the section existed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutomationSettings {
    /// Allow the `plainsong` CLI / MCP server to open the local database
    /// read-only, and the app to act on `plainsong://` deep links.
    pub local_tools_enabled: bool,
}

/// Audio recording settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSettings {
    /// Preferred app-wide input device selection.
    pub preferred_input_device: Option<AudioInputDevicePreference>,
    /// Whether dictation should override the app-wide microphone selection.
    pub dictation_input_override_enabled: bool,
    /// Preferred microphone for dictation when override is enabled.
    pub dictation_input_device: Option<AudioInputDevicePreference>,
    /// Whether meetings should override the app-wide microphone selection.
    pub meeting_input_override_enabled: bool,
    /// Preferred microphone for meetings when override is enabled.
    pub meeting_input_device: Option<AudioInputDevicePreference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioInputDevicePreference {
    pub device_id: String,
    pub device_name: String,
    pub transport_type: Option<String>,
}

/// Transcription settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TranscriptionSettings {
    /// Default ASR provider
    pub default_provider: String,
    /// Selected model identifier for local model backends
    pub selected_model_id: String,
    /// Whether dictation and meeting transcription should share the same ASR selection.
    pub use_shared_asr_selection: bool,
    /// Dedicated ASR provider for dictation when shared selection is disabled.
    pub dictation_provider: String,
    /// Dedicated model identifier for dictation when shared selection is disabled.
    pub dictation_model_id: String,
    /// Dedicated ASR provider for meetings when shared selection is disabled.
    pub meeting_provider: String,
    /// Dedicated model identifier for meetings when shared selection is disabled.
    pub meeting_model_id: String,
    /// Meeting route policy: prefer_local or best_available.
    pub meeting_route_policy: String,
    /// Provider-specific model identifiers (keyed by provider value, e.g. "whisper")
    pub provider_model_ids: HashMap<String, String>,
    /// Visible providers that should run through MLX Audio when a compatible model is selected.
    /// Kept for migration/display; per-slot flags below are the authoritative routing source.
    pub mlx_accelerated_providers: Vec<String>,
    /// Whether the dictation route slot should use MLX acceleration when available.
    pub dictation_mlx_enabled: bool,
    /// Whether the meeting route slot should use MLX acceleration when available.
    pub meeting_mlx_enabled: bool,
    /// Enable speaker diarization
    pub enable_diarization: bool,
    /// Selected diarization speaker embedding model ID. Defaults to
    /// `ecapa_tdnn_speaker` when unset.
    pub diarization_model_id: Option<String>,
    /// Language (auto-detect if None)
    pub language: Option<String>,
    /// Skip silence segments during transcription.
    pub silence_skip_enabled: bool,
    /// Dictation: Keep latest dictation result in clipboard
    pub dictation_copy_to_clipboard: bool,
    /// Dictation: auto-request runtime permissions before capture/transcription.
    pub dictation_auto_request_permissions: bool,
    /// Dictation: Use Push-to-Talk (start on press, stop on release)
    pub dictation_push_to_talk: bool,
    /// Dictation: Hands-free mode (start on press, stop on silence or next press)
    pub dictation_hands_free_enabled: bool,
    /// Dictation route preference: local or cloud.
    pub dictation_route_preference: String,
    /// Dictation: allow quick one-shot route override for the next manual capture.
    pub dictation_route_override_enabled: bool,
    /// Dictation: `on` pre-warms the model at session start, `off` skips it.
    pub dictation_keep_warm: String,
    /// Dictation: show live partial text in popup/inline surfaces.
    pub dictation_live_preview_enabled: bool,
    /// Dictation: Smart Format, LLM polishes text before insert
    pub dictation_ai_formatting: bool,
    /// Dictation: translate whatever was spoken into English before the text
    /// is formatted and inserted. This is the built-in modes' setting; a saved
    /// custom mode carries its own `translate_to_english` flag instead. How
    /// the translation actually runs depends on the selected model -- see
    /// `resolve_dictation_translation_route` in `lib.rs`.
    pub dictation_translate_to_english: bool,
    /// Dictation mode preset: voice, messages, email, notes, meeting_follow_up,
    /// custom. (`translate_english` is only valid as a custom mode's
    /// `base_mode_preset`, not as the top-level preset — see
    /// `normalize_dictation_mode_preset` in `lib.rs`.)
    pub dictation_mode_preset: String,
    /// Selected saved custom dictation mode id, if any.
    pub dictation_selected_custom_mode_id: Option<String>,
    /// Saved reusable custom dictation modes.
    pub dictation_custom_modes: Vec<DictationCustomMode>,
    /// Dictation context source: none, clipboard, selected_text, application_context
    pub dictation_context_source: String,
    /// Dictation: Command mode toggle (e.g. "command newline")
    pub dictation_command_mode_enabled: bool,
    /// Dictation: Prefix used to activate command mode
    pub dictation_command_prefix: String,
    /// Dictation insertion mode: auto (insert at cursor) or clipboard_only.
    pub dictation_insertion_mode: String,
    /// Active language set used when session language remains on auto.
    pub dictation_active_languages: Vec<String>,
    /// Dictation: snippet expansion toggle
    pub dictation_snippets_enabled: bool,
    /// Dictation: learn safe confirmed text corrections into the dictionary automatically.
    pub dictation_auto_learn_corrections: bool,
    /// Dictation: after inserting into another app, read that one field back
    /// briefly to notice corrections the user made there.
    ///
    /// Off by default and deliberately not covered by any "turn everything on"
    /// preset: this is the only dictation setting that reads text back out of
    /// another application, so it stays an explicit choice the user makes once,
    /// having read what it does. See `dictation_correction_capture` for the
    /// window, the abort conditions and the filters.
    pub dictation_learn_from_external_corrections: bool,
    /// Custom system prompt for Smart Format
    pub dictation_custom_prompt: Option<String>,
    /// Custom system prompt for Meeting Summaries
    pub meeting_custom_prompt: Option<String>,
    /// Auto-generate meeting title when transcription finishes
    pub meeting_auto_name_enabled: bool,
    /// Optional model override for meeting title generation
    pub meeting_auto_name_model: Option<String>,
    /// Persist dictation outputs into project storage.
    pub dictation_save_to_inbox: bool,
    /// Dictation profile preference: normal_speed or power_rewrite.
    pub dictation_profile: String,
    /// Target project for saved dictations.
    pub dictation_project_id: String,
    /// Dictation recording retention policy.
    pub dictation_retention_preset: String,
    /// Dictation retention custom duration in hours.
    pub dictation_retention_custom_hours: u32,
    /// Meeting audio storage mode: always or transcript_only.
    pub meeting_audio_storage_mode: String,
    /// Meeting retention policy.
    pub meeting_retention_preset: String,
    /// Meeting retention custom duration in months.
    pub meeting_retention_custom_months: u32,
    /// Meeting retention delete mode: audio_only or audio_and_transcript.
    pub meeting_retention_delete_mode: String,
    /// Dictation: Silence timeout in seconds before auto-stop (0 = disabled)
    pub dictation_silence_timeout_seconds: f32,
    /// Which speech/silence detector backs hands-free auto-start and
    /// auto-stop-on-silence: "energy_threshold" (default, always available,
    /// cheap O(1) heuristic) or "silero" (higher-accuracy ONNX model,
    /// requires the Silero VAD model to be downloaded; automatically falls
    /// back to "energy_threshold" if it isn't -- see
    /// `crate::audio::silero_vad::build_vad_gate`).
    pub dictation_vad_backend: String,
    /// Memory search mode: "fts" (default) or "ollama_embeddings"
    pub memory_search_mode: String,
    /// Ollama embedding model name (e.g. "nomic-embed-text")
    pub embedding_model: String,
    /// Auto-run Plainsong-style summary + action items after recording transcription
    pub enable_auto_analysis: bool,
    /// Platform-specific ASR optimization policy and engine preferences.
    pub platform_optimization: PlatformOptimizationSettings,
    /// Master toggle for destination-app-aware dictation formatting (independent
    /// of the general Smart Format toggle above).
    pub dictation_category_formatting_enabled: bool,
    /// User-defined per-app category overrides, checked before the built-in
    /// bundle-id/name classifier. First match wins.
    pub dictation_app_category_overrides: Vec<DictationAppCategoryOverride>,
    /// User-saved meeting templates ("recipes"), alongside the built-in set
    /// in `meeting-templates.ts`. Mirrors `dictation_custom_modes` -- same
    /// storage shape, same load/save sanitization discipline -- because a
    /// meeting template is a name plus a couple of prompts, exactly like a
    /// dictation mode is a name plus a prompt.
    pub meeting_custom_templates: Vec<MeetingCustomTemplate>,
}

/// A user-defined override that pins a destination app (matched by substring,
/// same convention as `dictation_parity`'s snippet/dictionary `app_scope`
/// matching) to a specific dictation formatting category.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationAppCategoryOverride {
    pub id: String,
    pub app_matcher: String,
    pub category: String,
    pub enabled: bool,
}

/// A user-saved meeting template ("recipe"): a name plus the two prompts a
/// built-in `MeetingTemplateOption` carries in `meeting-templates.ts` --
/// the summary instruction handed to the analysis pass, and the notes
/// outline seeded into a fresh meeting's notes. Unlike a built-in, this has
/// no fixed `value` enum member -- `id` is a generated string, checked
/// against the built-in id list at sanitization time so a custom template
/// can never shadow one.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MeetingCustomTemplate {
    pub id: String,
    pub name: String,
    pub summary_prompt: String,
    pub notes_outline: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationCustomMode {
    pub id: String,
    pub name: String,
    pub description: String,
    pub base_mode_preset: Option<String>,
    pub custom_prompt: Option<String>,
    pub profile: String,
    pub route_preference: Option<String>,
    pub language_override: Option<String>,
    pub live_preview_enabled: Option<bool>,
    pub insertion_mode: String,
    pub context_source: String,
    pub save_to_inbox: bool,
    pub copy_to_clipboard: bool,
    pub command_mode_enabled: bool,
    pub dictation_provider: Option<String>,
    pub dictation_model_id: Option<String>,
    pub ai_provider: Option<String>,
    pub ai_model_id: Option<String>,
    pub activation_app_matcher: Option<String>,
    pub activation_domain_matcher: Option<String>,
    /// Translate the spoken words into English for this mode. Mirrors the
    /// built-in modes' `dictation_translate_to_english`.
    pub translate_to_english: bool,
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            // Default to Parakeet TDT 0.6B v3, already fully integrated and
            // used as the recommended meeting-lane route. This repo's own
            // benchmark shows whisper.cpp base.en mis-transcribing words it
            // hasn't seen before -- including "Plainsong" itself -- so it is
            // offered as the small-download alternative (142 MB vs
            // Parakeet's 640 MB) rather than the out-of-the-box default.
            // (An earlier default routed through a 756M Candle model on CPU
            // in F32 -- multi-second latency on the dictation hot path --
            // which whisper.cpp base.en replaced before this change.)
            default_provider: "parakeet".to_string(),
            selected_model_id: "parakeet-tdt-0.6b-v3".to_string(),
            use_shared_asr_selection: true,
            dictation_provider: "parakeet".to_string(),
            dictation_model_id: "parakeet-tdt-0.6b-v3".to_string(),
            // The stored meeting slot names the route the meeting lane
            // actually resolves to. whisper.cpp is not a meeting-supported
            // provider (`meeting_provider_is_supported` in lib.rs), so the
            // old "whisper"/"base.en" default was a slot nothing ever read:
            // the effective route already fell through to Parakeet TDT
            // 0.6B v3. Storing that route removes the lie without changing
            // behavior; `migrate_dead_whisper_meeting_slot` rewrites files
            // that still carry the old pair.
            meeting_provider: "parakeet".to_string(),
            meeting_model_id: "parakeet-tdt-0.6b-v3".to_string(),
            meeting_route_policy: "prefer_local".to_string(),
            provider_model_ids: HashMap::new(),
            mlx_accelerated_providers: Vec::new(),
            dictation_mlx_enabled: false,
            meeting_mlx_enabled: false,
            enable_diarization: true,
            diarization_model_id: None,
            language: None,
            silence_skip_enabled: false,
            // Off by default: the paste path stages the dictated text on the
            // clipboard and restores the user's previous clipboard ~900ms
            // later, and that restore only runs when this is false. Defaulting
            // it to true meant every dictation permanently destroyed whatever
            // the user had copied. Settings files that already carry an
            // explicit value keep it (serde only falls back to this default
            // for an absent key).
            dictation_copy_to_clipboard: false,
            dictation_auto_request_permissions: true,
            // Toggle mode is safer for new users and avoids silent hold-to-talk confusion.
            dictation_push_to_talk: false,
            dictation_hands_free_enabled: false,
            dictation_route_preference: "local".to_string(),
            dictation_route_override_enabled: true,
            dictation_keep_warm: "on".to_string(),
            dictation_live_preview_enabled: true,
            dictation_ai_formatting: false,
            dictation_translate_to_english: false,
            dictation_mode_preset: "voice".to_string(),
            dictation_selected_custom_mode_id: None,
            dictation_custom_modes: Vec::new(),
            dictation_context_source: "none".to_string(),
            dictation_command_mode_enabled: true,
            dictation_command_prefix: "command".to_string(),
            dictation_insertion_mode: "auto".to_string(),
            dictation_active_languages: Vec::new(),
            dictation_snippets_enabled: true,
            dictation_auto_learn_corrections: true,
            dictation_learn_from_external_corrections: false,
            dictation_custom_prompt: None,
            meeting_custom_prompt: None,
            meeting_auto_name_enabled: true,
            meeting_auto_name_model: None,
            dictation_save_to_inbox: true,
            dictation_profile: "normal_speed".to_string(),
            dictation_project_id: "inbox".to_string(),
            dictation_retention_preset: "never".to_string(),
            dictation_retention_custom_hours: 24,
            meeting_audio_storage_mode: "always".to_string(),
            meeting_retention_preset: "never".to_string(),
            meeting_retention_custom_months: 1,
            meeting_retention_delete_mode: "audio_only".to_string(),
            dictation_silence_timeout_seconds: 0.0,
            dictation_vad_backend: "energy_threshold".to_string(),
            memory_search_mode: "fts".to_string(),
            embedding_model: "nomic-embed-text".to_string(),
            enable_auto_analysis: true,
            platform_optimization: PlatformOptimizationSettings::default(),
            dictation_category_formatting_enabled: true,
            dictation_app_category_overrides: Vec::new(),
            meeting_custom_templates: Vec::new(),
        }
    }
}

/// Platform optimization policy for ASR routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlatformOptimizationSettings {
    /// Routing mode: auto or manual.
    pub mode: String,
    /// Fallback policy: local_only, allow_cloud, fail_fast.
    pub fallback_policy: String,
    /// macOS-specific optimization controls.
    pub macos: MacosPlatformOptimizationSettings,
    /// Windows-specific optimization controls.
    pub windows: WindowsPlatformOptimizationSettings,
    /// Ordered manual engine priority list.
    pub manual_engine_priority: Vec<String>,
}

impl Default for PlatformOptimizationSettings {
    fn default() -> Self {
        Self {
            mode: "auto".to_string(),
            fallback_policy: "local_only".to_string(),
            macos: MacosPlatformOptimizationSettings::default(),
            windows: WindowsPlatformOptimizationSettings::default(),
            manual_engine_priority: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MacosPlatformOptimizationSettings {
    /// Enable Apple-native STT engine routing.
    pub apple_native_enabled: bool,
    /// Enable MLX sidecar optimization routing.
    pub mlx_enabled: bool,
}

impl Default for MacosPlatformOptimizationSettings {
    fn default() -> Self {
        Self {
            apple_native_enabled: false,
            mlx_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowsPlatformOptimizationSettings {
    /// Enable Foundry Local optimization routing.
    pub foundry_enabled: bool,
    /// Enable Windows SDK dictation route.
    pub windows_sdk_dictation_enabled: bool,
}

/// UI settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiSettings {
    /// Always on top
    pub always_on_top: bool,
    /// Minimize to tray on close
    pub minimize_to_tray: bool,
    /// Show dictation overlay popup
    pub show_dictation_popup: bool,
    /// Show meeting recording overlay popup
    pub show_recording_popup: bool,
    /// Selected premium color scheme applied via `data-theme`
    pub color_scheme: String,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            always_on_top: false,
            minimize_to_tray: true,
            show_dictation_popup: true,
            show_recording_popup: true,
            color_scheme: "default".to_string(),
        }
    }
}

/// Export settings.
///
/// All previous fields (default format, export directory, include flags,
/// open-after-export, auto-export) were placebo settings with no reader —
/// export requests carry their own format/target. The empty container is
/// kept transitionally so the renderer's `settings.export` access stays
/// defined until the Storage-tab UI section is removed; drop the whole
/// struct together with that UI.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportSettings {}

/// One AI lane: which analysis provider runs a class of work, and on which
/// model.
///
/// There are two lanes because the two classes of work have opposite
/// constraints. Dictation cleanup runs on every capture behind a short
/// timeout, so it needs a model that answers fast. Meeting summaries, action
/// items, and Q&A are batch work that can afford a slower, smarter model. A
/// single global choice could only ever be right for one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiLaneSettings {
    /// Analysis LLM provider for this lane
    pub provider: String,
    /// Model ID for this lane (provider-specific; `None` means the provider's
    /// own default model)
    pub model_id: Option<String>,
}

impl Default for AiLaneSettings {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            model_id: None,
        }
    }
}

/// Which AI lane a piece of work belongs to. Every consumer of an analysis
/// provider names its lane so the choice is made once, at the call site that
/// knows what kind of work it is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiLane {
    /// Dictation cleanup and formatting.
    Dictation,
    /// Meeting summaries, action items, and meeting Q&A.
    Meetings,
}

/// Privacy settings
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    /// Allow remote provider processing (local-first default)
    pub remote_processing_enabled: bool,
    /// AI lane for dictation cleanup and formatting. Latency-critical: this
    /// runs on every capture behind a short timeout.
    pub dictation_ai: AiLaneSettings,
    /// AI lane for meeting summaries, action items, and meeting Q&A. Batch
    /// work, so it can afford a slower model.
    pub meetings_ai: AiLaneSettings,
    /// Optional absolute export root constraint
    pub export_root: Option<PathBuf>,
    /// Opaque reference to a location approved through Electron's native picker.
    pub export_location_id: Option<String>,
    /// Safe, non-path label shown to the renderer.
    pub export_location_label: Option<String>,
    /// Runtime approval state. The registry remains authoritative at each sink.
    pub export_location_approved: bool,
    /// Whether vault migration has completed
    pub vault_initialized: bool,
    /// Salt used to derive recording-encryption key material
    pub vault_salt: Option<String>,
}

impl PrivacySettings {
    /// The provider/model pair that runs `lane`.
    pub fn ai_lane(&self, lane: AiLane) -> &AiLaneSettings {
        match lane {
            AiLane::Dictation => &self.dictation_ai,
            AiLane::Meetings => &self.meetings_ai,
        }
    }
}

/// What physically fires a dictation binding.
///
/// Mirrors `DictationBindingTrigger` in `src/types/settings.ts`. A `key`
/// accelerator uses the same `Cmd+Shift+Space` spelling as `toggle_dictation`;
/// a lone modifier (`Fn`, `Cmd`, ...) is allowed and means "that modifier on
/// its own", which only the native macOS helper can deliver. A `mouse` trigger
/// names an extra mouse button (3, 4 or 5 -- middle, back, forward) plus any
/// modifiers that must be held with it; those are helper-only too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationBindingTrigger {
    Key {
        accelerator: String,
    },
    Mouse {
        button: u8,
        #[serde(default)]
        modifiers: Vec<String>,
    },
}

/// What a dictation binding does when its trigger fires.
///
/// Mirrors `DictationBindingAction` in `src/types/settings.ts`. `Dictation`
/// starts (or stops) a dictation session: `mode_id` is `None` for "whichever
/// mode is selected", a built-in preset id, or a saved custom mode id, used for
/// that session only; `behavior` is `toggle`, `hold`, or `inherit` (follow the
/// activation setting). `CycleMode` moves the selected mode to the next one;
/// `Cancel` discards a running session, the same as Escape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationBindingAction {
    #[serde(rename_all = "camelCase")]
    Dictation {
        #[serde(default)]
        mode_id: Option<String>,
        #[serde(default = "default_dictation_binding_behavior")]
        behavior: String,
    },
    CycleMode,
    Cancel,
}

fn default_dictation_binding_behavior() -> String {
    "inherit".to_string()
}

/// One entry of the dictation binding table (roadmap item B4). The first
/// binding whose action is `Dictation { mode_id: None, .. }` with a `key`
/// trigger is the "primary" binding, and `toggle_dictation` is kept equal to
/// its accelerator so an older build that only reads that key still has a
/// hotkey.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBinding {
    pub id: String,
    pub trigger: DictationBindingTrigger,
    pub action: DictationBindingAction,
}

/// The id the migration gives the binding built from the legacy
/// `toggleDictation` key.
pub const PRIMARY_DICTATION_BINDING_ID: &str = "primary";

pub const DICTATION_BINDING_BEHAVIORS: &[&str] = &["inherit", "toggle", "hold"];
pub const DICTATION_MOUSE_BUTTONS: &[u8] = &[3, 4, 5];
const MAX_DICTATION_BINDINGS: usize = 16;

#[cfg(test)]
#[path = "settings_dictation_binding_tests.rs"]
mod dictation_binding_tests;

/// A malformed entry must not take the whole settings file down with it: an
/// unreadable binding is dropped on load (and the file rewritten without it
/// by the normal save path), the rest of the table survives.
fn deserialize_tolerant_dictation_bindings<'de, D>(
    deserializer: D,
) -> Result<Vec<DictationBinding>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: Vec<serde_json::Value> = Vec::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(
            |value| match serde_json::from_value::<DictationBinding>(value) {
                Ok(binding) => Some(binding),
                Err(error) => {
                    tracing::warn!("Dropping an unreadable dictation binding: {}", error);
                    None
                }
            },
        )
        .collect())
}

/// Keyboard shortcuts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcuts {
    /// Toggle dictation mode. Since the binding table below arrived this is a
    /// derived value -- the primary binding's accelerator, or empty when there
    /// is no primary key binding -- written so a downgrade keeps a hotkey.
    /// The retired `toggleDictationAlternates` list is dropped on load (see
    /// `REMOVED_SETTINGS_KEYS`).
    pub toggle_dictation: String,
    /// Open main window
    pub open_window: String,
    /// Re-insert the last dictation result at the cursor. The recovery path
    /// when an insertion landed in the wrong app or silently failed. Empty
    /// means unbound.
    pub repaste_last_dictation: String,
    /// Copy the last dictation result to the clipboard again. Empty means
    /// unbound.
    pub recopy_last_dictation: String,
    /// The dictation binding table. Empty on a file written before it existed;
    /// `normalize_keyboard_shortcuts` builds the first entry from
    /// `toggle_dictation` in that case.
    ///
    /// The field-level `default` matters: the struct-level one would fill an
    /// absent `dictationBindings` with `KeyboardShortcuts::default()`'s
    /// primary binding on the *product default* accelerator, and the
    /// reconciliation below would then overwrite a pre-B4 file's own
    /// `toggleDictation` with it. An empty vec is how "this file predates the
    /// table" is spelled.
    #[serde(default, deserialize_with = "deserialize_tolerant_dictation_bindings")]
    pub dictation_bindings: Vec<DictationBinding>,
}

impl Default for KeyboardShortcuts {
    fn default() -> Self {
        Self {
            toggle_dictation: default_dictation_shortcut().to_string(),
            open_window: "Ctrl+Shift+N".to_string(),
            repaste_last_dictation: default_repaste_shortcut().to_string(),
            recopy_last_dictation: default_recopy_shortcut().to_string(),
            dictation_bindings: vec![primary_dictation_binding(default_dictation_shortcut())],
        }
    }
}

fn primary_dictation_binding(accelerator: &str) -> DictationBinding {
    DictationBinding {
        id: PRIMARY_DICTATION_BINDING_ID.to_string(),
        trigger: DictationBindingTrigger::Key {
            accelerator: accelerator.to_string(),
        },
        action: DictationBindingAction::Dictation {
            mode_id: None,
            behavior: "inherit".to_string(),
        },
    }
}

fn is_primary_dictation_binding(binding: &DictationBinding) -> bool {
    matches!(binding.trigger, DictationBindingTrigger::Key { .. })
        && matches!(
            binding.action,
            DictationBindingAction::Dictation { mode_id: None, .. }
        )
}

const SHORTCUT_MODIFIER_TOKENS: &[&str] = &["cmd", "ctrl", "alt", "shift", "fn"];

/// Chords macOS itself owns, as `(sorted modifiers, key)` in the canonical
/// spelling `dictation_binding_trigger_key` produces. Binding one either does
/// nothing (the system swallows it first) or takes a gesture the user needs
/// more than a dictation hotkey -- quit, close, app switch, Spotlight, hide,
/// minimize. Mirrored by `RESERVED_SHORTCUT_ACCELERATORS` in
/// `electron/dictation-bindings.ts`.
const RESERVED_SHORTCUT_CHORDS: &[(&str, &str)] = &[
    ("cmd", "q"),
    ("cmd", "w"),
    ("cmd", "tab"),
    ("cmd", "space"),
    ("cmd", "h"),
    ("cmd", "m"),
];

/// `f1` through `f24` and nothing else. The old check accepted `f` followed
/// by any digits, so `f0`, `f99` and `f12345` all passed as "a function key"
/// and skipped the needs-a-modifier rule. Mirrors the TS side's
/// `/^f([1-9]|1[0-9]|2[0-4])$/`, leading zeros included.
fn is_function_key_token(key: &str) -> bool {
    let Some(digits) = key.strip_prefix('f') else {
        return false;
    };
    if digits.is_empty() || digits.starts_with('0') {
        return false;
    }
    digits
        .parse::<u32>()
        .is_ok_and(|number| (1..=24).contains(&number))
}

fn normalize_shortcut_token(token: &str) -> String {
    match token.trim().to_ascii_lowercase().as_str() {
        "⌘" | "cmd" | "command" | "meta" | "super" => "cmd".to_string(),
        "⌃" | "ctrl" | "control" => "ctrl".to_string(),
        "⌥" | "alt" | "option" | "opt" => "alt".to_string(),
        "⇧" | "shift" => "shift".to_string(),
        "fn" | "function" => "fn".to_string(),
        "spacebar" | "space" => "space".to_string(),
        other => other.to_string(),
    }
}

/// Canonical form of a trigger for duplicate detection: modifiers sorted,
/// tokens lower-cased, so `Shift+Cmd+Space` and `cmd shift space` collide.
pub(crate) fn dictation_binding_trigger_key(trigger: &DictationBindingTrigger) -> String {
    match trigger {
        DictationBindingTrigger::Key { accelerator } => {
            // The symbols are separated out, NOT deleted. Replacing them with
            // a space dropped the modifier entirely, so "⌘+Q" normalized to
            // the bare key "q" -- which made it look like ordinary typing to
            // the validator and made "⌘⇧Space" and "Space" the same trigger
            // for duplicate detection. Mirrors `splitShortcutTokens` in
            // `electron/shortcut-registration.ts`, which pads them the same
            // way; `normalize_shortcut_token` maps each symbol to its word.
            let tokens: Vec<String> = accelerator
                .replace('⌘', " ⌘ ")
                .replace('⌃', " ⌃ ")
                .replace('⌥', " ⌥ ")
                .replace('⇧', " ⇧ ")
                .split(|c: char| c == '+' || c.is_whitespace())
                .filter(|part| !part.trim().is_empty())
                .map(normalize_shortcut_token)
                .collect();
            let mut modifiers: Vec<&str> = tokens
                .iter()
                .map(String::as_str)
                .filter(|token| SHORTCUT_MODIFIER_TOKENS.contains(token))
                .collect();
            modifiers.sort_unstable();
            modifiers.dedup();
            let keys: Vec<&str> = tokens
                .iter()
                .map(String::as_str)
                .filter(|token| !SHORTCUT_MODIFIER_TOKENS.contains(token))
                .collect();
            format!("key:{}:{}", modifiers.join("+"), keys.join("+"))
        }
        DictationBindingTrigger::Mouse { button, modifiers } => {
            let mut normalized: Vec<String> = modifiers
                .iter()
                .map(|modifier| normalize_shortcut_token(modifier))
                .filter(|modifier| SHORTCUT_MODIFIER_TOKENS.contains(&modifier.as_str()))
                .collect();
            normalized.sort_unstable();
            normalized.dedup();
            format!("mouse:{}:{}", normalized.join("+"), button)
        }
    }
}

/// Validation the save path applies to the binding table. Mirrors
/// `validateDictationBindings` in `electron/dictation-bindings.ts`, which
/// additionally knows whether the native helper is present (a mouse or
/// lone-modifier binding needs it); this side owns the checks that do not
/// depend on the machine.
///
/// Only a malformed *trigger* is rejected here, because there is no sane way
/// to guess what the user meant. Collisions are not rejected:
/// `drop_duplicate_dictation_bindings` runs first on both the load and save
/// paths and has already removed them, so the duplicate-id and
/// duplicate-trigger arms below are unreachable invariant assertions for
/// direct callers rather than something a settings save can trip over.
pub(crate) fn validate_dictation_bindings(bindings: &[DictationBinding]) -> Result<(), String> {
    if bindings.len() > MAX_DICTATION_BINDINGS {
        return Err(format!(
            "At most {} dictation bindings are supported.",
            MAX_DICTATION_BINDINGS
        ));
    }
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_triggers = std::collections::HashSet::new();
    for binding in bindings {
        if binding.id.trim().is_empty() {
            return Err("Every dictation binding needs an id.".to_string());
        }
        if !seen_ids.insert(binding.id.trim().to_string()) {
            return Err(format!(
                "Dictation binding id '{}' is used twice.",
                binding.id
            ));
        }
        match &binding.trigger {
            DictationBindingTrigger::Key { accelerator } => {
                let key = dictation_binding_trigger_key(&binding.trigger);
                let body = key.trim_start_matches("key:");
                let (modifiers, keys) = body.split_once(':').unwrap_or(("", ""));
                if accelerator.trim().is_empty() || (modifiers.is_empty() && keys.is_empty()) {
                    return Err("A key binding needs at least one key.".to_string());
                }
                if keys.contains('+') {
                    return Err(format!(
                        "'{}' names more than one non-modifier key.",
                        accelerator
                    ));
                }
                if keys.is_empty() {
                    // A modifier on its own. Only Fn is offered and only Fn is
                    // safe: the helper matches `.maskCommand` (either Cmd key)
                    // and arms after 150 ms with nothing else pressed, so a
                    // lone Cmd would start dictation from an ordinary pause
                    // mid-chord. Fn is the one modifier nothing else on macOS
                    // treats as a hold.
                    if modifiers != "fn" {
                        return Err(format!(
                            "'{}' cannot be a trigger on its own. Fn is the only modifier that can.",
                            accelerator
                        ));
                    }
                } else if modifiers.is_empty() && !is_function_key_token(keys) {
                    return Err(format!(
                        "'{}' would fire on ordinary typing. Add a modifier such as Cmd or Ctrl.",
                        accelerator
                    ));
                }
                if RESERVED_SHORTCUT_CHORDS
                    .iter()
                    .any(|(reserved_modifiers, reserved_key)| {
                        *reserved_modifiers == modifiers && *reserved_key == keys
                    })
                {
                    return Err(format!(
                        "'{}' is reserved by macOS. Pick a different combination.",
                        accelerator
                    ));
                }
            }
            DictationBindingTrigger::Mouse { button, .. } => {
                if !DICTATION_MOUSE_BUTTONS.contains(button) {
                    return Err(format!(
                        "Mouse button {} cannot be bound; use button 3, 4 or 5.",
                        button
                    ));
                }
            }
        }
        if !seen_triggers.insert(dictation_binding_trigger_key(&binding.trigger)) {
            return Err(format!(
                "Two dictation bindings use the same trigger ({}).",
                describe_dictation_binding_trigger(&binding.trigger)
            ));
        }
        if let DictationBindingAction::Dictation { behavior, .. } = &binding.action {
            if !DICTATION_BINDING_BEHAVIORS.contains(&behavior.as_str()) {
                return Err(format!(
                    "Dictation binding behavior '{}' is not one of inherit, toggle, hold.",
                    behavior
                ));
            }
        }
    }
    Ok(())
}

fn describe_dictation_binding_trigger(trigger: &DictationBindingTrigger) -> String {
    match trigger {
        DictationBindingTrigger::Key { accelerator } => accelerator.clone(),
        DictationBindingTrigger::Mouse { button, modifiers } => {
            let mut parts = modifiers.clone();
            parts.push(format!("Mouse {}", button));
            parts.join("+")
        }
    }
}

// The de-facto convention for these two (Wispr Flow binds the same chords), so
// a user arriving from another dictation app finds them where they expect.
fn default_repaste_shortcut() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Cmd+Ctrl+V"
    }

    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Alt+V"
    }
}

fn default_recopy_shortcut() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Cmd+Ctrl+C"
    }

    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Alt+C"
    }
}

fn default_dictation_shortcut() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Cmd+Shift+Space"
    }

    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Shift+Space"
    }
}

/// Load-time reconciliation between the legacy `toggle_dictation` key and the
/// binding table.
///
/// - A file with no bindings (written before B4) gets one built from
///   `toggle_dictation`; an empty `toggle_dictation` on such a file falls back
///   to the product default exactly as it did before the table existed.
/// - A file with bindings treats them as the source of truth and rewrites
///   `toggle_dictation` from the primary binding, so the legacy key can never
///   disagree with what the app actually registers.
pub(crate) fn normalize_keyboard_shortcuts(shortcuts: &mut KeyboardShortcuts) {
    reconcile_keyboard_shortcuts(shortcuts, true);
}

/// The save-path counterpart of `normalize_keyboard_shortcuts`.
///
/// A writer that predates the binding table (the first-run wizard, a hand
/// edit, an older build's settings screen) changes `toggle_dictation` and
/// nothing else. When the incoming legacy key differs from what is stored
/// while the binding table is unchanged, that key is the user's edit and is
/// applied to the primary binding; otherwise the table is authoritative, as on
/// load. An emptied table is honoured (no default springs back), because
/// removing every binding is how the hotkey is switched off until the next
/// launch, exactly as clearing the legacy key used to work.
pub(crate) fn reconcile_saved_keyboard_shortcuts(
    shortcuts: &mut KeyboardShortcuts,
    previous: &KeyboardShortcuts,
) {
    let legacy_key_edited = shortcuts.toggle_dictation.trim() != previous.toggle_dictation.trim();
    let bindings_unchanged = shortcuts.dictation_bindings == previous.dictation_bindings;
    if legacy_key_edited && bindings_unchanged {
        let legacy = shortcuts.toggle_dictation.trim().to_string();
        let primary_index = shortcuts
            .dictation_bindings
            .iter()
            .position(is_primary_dictation_binding);
        match (primary_index, legacy.is_empty()) {
            (Some(index), true) => {
                shortcuts.dictation_bindings.remove(index);
            }
            (Some(index), false) => {
                shortcuts.dictation_bindings[index].trigger = DictationBindingTrigger::Key {
                    accelerator: legacy,
                };
            }
            (None, true) => {}
            (None, false) => {
                shortcuts
                    .dictation_bindings
                    .insert(0, primary_dictation_binding(&legacy));
            }
        }
    }
    reconcile_keyboard_shortcuts(shortcuts, false);
}

/// Keep the first binding for each id and each trigger; drop the rest with a
/// warning.
///
/// A duplicate trigger used to be a hard `Err` out of
/// `validate_dictation_bindings`, which `save_settings_for_sidecar`
/// propagated -- so one colliding row failed the *entire* batched settings
/// save, taking every unrelated edit in the same payload with it, while the
/// renderer's own validator (`validateDictationBindings` in
/// `electron/dictation-bindings.ts`) only warned in the row. Only one of two
/// identical triggers can ever fire, so dropping the later one loses nothing
/// the user had; failing the save loses everything else they changed.
pub(crate) fn drop_duplicate_dictation_bindings(bindings: &mut Vec<DictationBinding>) {
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_triggers = std::collections::HashSet::new();
    bindings.retain(|binding| {
        if !seen_ids.insert(binding.id.clone()) {
            tracing::warn!(
                "Dropping dictation binding with duplicate id '{}'",
                binding.id
            );
            return false;
        }
        if !seen_triggers.insert(dictation_binding_trigger_key(&binding.trigger)) {
            tracing::warn!(
                "Dropping dictation binding '{}': {} is already bound",
                binding.id,
                describe_dictation_binding_trigger(&binding.trigger)
            );
            return false;
        }
        true
    });
}

fn reconcile_keyboard_shortcuts(
    shortcuts: &mut KeyboardShortcuts,
    restore_default_when_empty: bool,
) {
    for binding in &mut shortcuts.dictation_bindings {
        binding.id = binding.id.trim().to_string();
        if let DictationBindingTrigger::Key { accelerator } = &mut binding.trigger {
            *accelerator = accelerator.trim().to_string();
        }
        if let DictationBindingAction::Dictation { mode_id, behavior } = &mut binding.action {
            *mode_id = mode_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let normalized = behavior.trim().to_ascii_lowercase();
            *behavior = if DICTATION_BINDING_BEHAVIORS.contains(&normalized.as_str()) {
                normalized
            } else {
                "inherit".to_string()
            };
        }
    }
    shortcuts.dictation_bindings.retain(|binding| {
        !binding.id.is_empty()
            && match &binding.trigger {
                DictationBindingTrigger::Key { accelerator } => !accelerator.is_empty(),
                DictationBindingTrigger::Mouse { button, .. } => {
                    DICTATION_MOUSE_BUTTONS.contains(button)
                }
            }
    });
    drop_duplicate_dictation_bindings(&mut shortcuts.dictation_bindings);

    if shortcuts.dictation_bindings.is_empty() {
        if restore_default_when_empty && shortcuts.toggle_dictation.trim().is_empty() {
            shortcuts.toggle_dictation = default_dictation_shortcut().to_string();
        }
        let legacy = shortcuts.toggle_dictation.trim().to_string();
        if !legacy.is_empty() {
            shortcuts.dictation_bindings = vec![primary_dictation_binding(&legacy)];
        }
        shortcuts.toggle_dictation = legacy;
        return;
    }

    shortcuts.toggle_dictation = shortcuts
        .dictation_bindings
        .iter()
        .find(|binding| is_primary_dictation_binding(binding))
        .and_then(|binding| match &binding.trigger {
            DictationBindingTrigger::Key { accelerator } => Some(accelerator.clone()),
            DictationBindingTrigger::Mouse { .. } => None,
        })
        .unwrap_or_default();
}

/// Collapse a stored provider name onto one that still exists.
///
/// The catch-all is the migration path, not a fallback for typos: a settings
/// file written before `mlx_audio`, `voxtral`, or the managed-Python Parakeet
/// routes were deleted will still name them, and the honest answer is to land
/// that user on `whisper` rather than keep a name no engine answers to. Adding
/// an arm here for a provider that no longer ships would make the retired name
/// the canonical output of the settings layer, which is how a deleted feature
/// comes back as a ghost.
fn normalize_transcription_provider_value(provider: &str) -> String {
    match provider.trim() {
        "canary" => "whisper_candle".to_string(),
        "whisper_candle" => "whisper_candle".to_string(),
        "whisper" => "whisper".to_string(),
        "parakeet" => "parakeet".to_string(),
        "distil_whisper" => "distil_whisper".to_string(),
        "macos_apple_speech" => "macos_apple_speech".to_string(),
        "moonshine" => "moonshine".to_string(),
        "windows_sdk_dictation" => "windows_sdk_dictation".to_string(),
        "elevenlabs_scribe" => "elevenlabs_scribe".to_string(),
        "openai_cloud" => "openai_cloud".to_string(),
        "groq" => "groq".to_string(),
        "cohere_transcribe" => "cohere_transcribe".to_string(),
        "qwen3_asr" => "qwen3_asr".to_string(),
        _ => "whisper".to_string(),
    }
}

fn normalize_transcription_model_id(provider: &str, model_id: &str) -> String {
    match provider {
        "whisper" => match model_id.trim() {
            "tiny" | "tiny.en" | "base" | "base.en" | "small" | "small.en" | "medium"
            | "medium.en" | "large-v3" | "large-v3-turbo" => model_id.trim().to_string(),
            _ => "base.en".to_string(),
        },
        "parakeet" => match model_id.trim() {
            "parakeet-tdt-0.6b-v2" | "parakeet-tdt-0.6b-v3" => "parakeet-tdt-0.6b-v3".to_string(),
            "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => "parakeet-tdt-ctc-110m".to_string(),
            _ => "parakeet-tdt-0.6b-v3".to_string(),
        },
        "whisper_candle" => "whisper-large-v3-turbo".to_string(),
        "distil_whisper" => "distil-large-v3.5".to_string(),
        "macos_apple_speech" => "macos_apple_speech".to_string(),
        "moonshine" => match model_id.trim() {
            "moonshine" | "moonshine-base" => "moonshine-base".to_string(),
            "moonshine-tiny" => "moonshine-tiny".to_string(),
            _ => "moonshine-base".to_string(),
        },
        "windows_sdk_dictation" => "windows_sdk_dictation".to_string(),
        "elevenlabs_scribe" => match model_id.trim() {
            "" => "scribe_v2".to_string(),
            "scribe_v1" => "scribe_v2".to_string(),
            "scribe_v1_experimental" => "scribe_v2_experimental".to_string(),
            "scribe_v2_realtime" => "scribe_v2".to_string(),
            value => value.to_string(),
        },
        "openai_cloud" => match model_id.trim() {
            // Must track asr/mod.rs's AsrProviderType::OpenAiCloud::default_model_id()
            // and openai_cloud.rs's sanitize_openai_asr_model_id() empty-case default,
            // or this normalizer and those two disagree about the actual default.
            "" => "gpt-transcribe".to_string(),
            value => value.to_string(),
        },
        "groq" => match model_id.trim() {
            "" => "whisper-large-v3-turbo".to_string(),
            value => value.to_string(),
        },
        "cohere_transcribe" => match model_id.trim() {
            "" => "cohere-transcribe-03-2026".to_string(),
            value => value.to_string(),
        },
        "qwen3_asr" => match model_id.trim() {
            "" | "qwen3-asr-0.6b" => "qwen3-asr-0.6b".to_string(),
            value => value.to_string(),
        },
        _ => "base.en".to_string(),
    }
}

/// Normalize the keep-warm choice to the two states the app can actually
/// deliver.
///
/// It used to offer off/short/long, and none of the three was read anywhere:
/// the model prewarm ran unconditionally, so "off" was a lie and "short" and
/// "long" were the same thing. The setting now gates the prewarm, and the two
/// old "on" values migrate to `on`.
fn normalize_dictation_keep_warm(value: &str) -> String {
    match value.trim() {
        "off" => "off".to_string(),
        _ => "on".to_string(),
    }
}

/// Normalize an insertion mode to the two behaviors that actually differ.
///
/// `paste` and `inline` were extra names for what `auto` already did (all
/// three called the same insert path), so saved files carrying them land on
/// `auto`. `clipboard_only` is the only value that ever behaved differently.
/// The renderer looks these up in a table that no longer has the retired
/// keys, so a value that survives the load renders as a blank label.
fn normalize_dictation_insertion_mode(value: &str) -> String {
    match value.trim() {
        "clipboard_only" => "clipboard_only".to_string(),
        _ => "auto".to_string(),
    }
}

/// Every language the multilingual Whisper family can transcribe.
///
/// Whisper's own published set; the `ModelInfo::languages` shown in the model
/// picker is a curated "most common" subset for display and is not a statement
/// of what the model can decode.
pub const WHISPER_MULTILINGUAL_LANGUAGES: &[&str] = &[
    "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy", "da",
    "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw", "he",
    "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la",
    "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl",
    "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so",
    "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz",
    "vi", "yi", "yo", "yue", "zh",
];

/// The 25 European languages Parakeet TDT v3 documents.
pub const PARAKEET_V3_LANGUAGES: &[&str] = &[
    "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it", "lt", "lv", "mt",
    "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk",
];

const ENGLISH_ONLY_LANGUAGES: &[&str] = &["en"];

/// The 30 languages the Qwen3-ASR model card lists. Mirrors
/// `asr::qwen3_asr::QWEN3_ASR_LANGUAGES` (a test keeps the two in step) and
/// `QWEN3_ASR_LANGUAGE_CODES` in src/lib/asr-capabilities.ts.
pub const QWEN3_ASR_LANGUAGES: &[&str] = &[
    "ar", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fil", "fr", "hi", "hu", "id", "it",
    "ja", "ko", "mk", "ms", "nl", "pl", "pt", "ro", "ru", "sv", "th", "tr", "vi", "yue", "zh",
];

/// Which languages the *selected* dictation model can actually transcribe.
///
/// `None` means the model imposes no set Plainsong can enumerate -- a cloud
/// endpoint, or a platform recognizer that follows the OS language list -- so
/// any well-formed tag is accepted rather than guessed at.
///
/// This replaces a hardcoded twelve-language allowlist that silently dropped
/// everything else. It rejected Polish and Turkish on a Whisper large model that
/// handles both, and it equally accepted languages the selected model could not
/// decode at all. Driving the check from the model is what makes it correct in
/// both directions.
pub fn dictation_supported_languages(
    provider: &str,
    model_id: &str,
) -> Option<&'static [&'static str]> {
    let model = model_id.trim().to_ascii_lowercase();
    match provider.trim().to_ascii_lowercase().as_str() {
        "whisper" | "whisper_candle" => {
            // The `.en` builds are single-language by construction.
            if model.contains(".en") || model.ends_with("-en") {
                Some(ENGLISH_ONLY_LANGUAGES)
            } else {
                Some(WHISPER_MULTILINGUAL_LANGUAGES)
            }
        }
        // Distil-Whisper's shipped builds are English-only.
        "distil_whisper" => Some(ENGLISH_ONLY_LANGUAGES),
        "parakeet" => {
            if model.contains("v3") {
                Some(PARAKEET_V3_LANGUAGES)
            } else {
                // The TDT/CTC 110m and v2 builds are English-only.
                Some(ENGLISH_ONLY_LANGUAGES)
            }
        }
        "moonshine" => Some(ENGLISH_ONLY_LANGUAGES),
        "qwen3_asr" => Some(QWEN3_ASR_LANGUAGES),
        // Cloud and platform routes follow their own service/OS language list,
        // which Plainsong cannot enumerate locally.
        _ => None,
    }
}

/// Whether a string is a plausible BCP-47 primary language subtag.
///
/// Deliberately shape-only: the authority on what is *supported* is
/// `dictation_supported_languages`, and inventing a second opinion here is how
/// the old allowlist ended up rejecting real languages.
fn is_language_tag_shaped(value: &str) -> bool {
    let length = value.len();
    (2..=8).contains(&length) && value.bytes().all(|byte| byte.is_ascii_lowercase())
}

/// Strict validation for a user-initiated save.
///
/// Returns a clear error naming the languages the selected model cannot handle,
/// rather than dropping them and leaving the user staring at a picker that
/// forgot what they chose.
pub fn validate_dictation_active_languages(
    provider: &str,
    model_id: &str,
    languages: &[String],
) -> Result<Vec<String>, String> {
    let supported = dictation_supported_languages(provider, model_id);
    let mut normalized: Vec<String> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();

    for language in languages {
        let trimmed = language.trim().to_ascii_lowercase();
        if trimmed.is_empty() {
            continue;
        }
        if !is_language_tag_shaped(&trimmed) {
            unsupported.push(trimmed);
            continue;
        }
        if let Some(supported) = supported {
            if !supported.contains(&trimmed.as_str()) {
                unsupported.push(trimmed);
                continue;
            }
        }
        if !normalized.contains(&trimmed) {
            normalized.push(trimmed);
        }
    }

    if unsupported.is_empty() {
        return Ok(normalized);
    }
    Err(format!(
        "The selected dictation model ({}) cannot transcribe: {}. Choose a different model or remove those languages.",
        model_id.trim(),
        unsupported.join(", ")
    ))
}

/// Lenient normalization for the load path.
///
/// Load must not fail: a settings file can legitimately name a language the
/// *currently* selected model does not handle, because the user switched models
/// after choosing it. Dropping is right here and wrong on save, which is why the
/// strict variant above exists separately.
fn normalize_dictation_active_languages(
    provider: &str,
    model_id: &str,
    languages: &[String],
) -> Vec<String> {
    let supported = dictation_supported_languages(provider, model_id);
    let mut normalized: Vec<String> = Vec::new();
    for language in languages {
        let trimmed = language.trim().to_ascii_lowercase();
        if trimmed.is_empty() || !is_language_tag_shaped(&trimmed) {
            continue;
        }
        if let Some(supported) = supported {
            if !supported.contains(&trimmed.as_str()) {
                continue;
            }
        }
        if !normalized.contains(&trimmed) {
            normalized.push(trimmed);
        }
    }
    normalized
}

fn normalize_audio_input_device_preference(
    preference: Option<AudioInputDevicePreference>,
) -> Option<AudioInputDevicePreference> {
    preference.and_then(|mut value| {
        value.device_id = value.device_id.trim().to_string();
        value.device_name = value.device_name.trim().to_string();
        value.transport_type = value.transport_type.and_then(|transport| {
            let trimmed = transport.trim().to_ascii_lowercase();
            match trimmed.as_str() {
                "builtin" | "bluetooth" | "usb" | "virtual" | "unknown" => Some(trimmed),
                _ => None,
            }
        });
        if value.device_id.is_empty() || value.device_name.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

pub(crate) fn normalize_loaded_audio_settings(audio: &mut AudioSettings) {
    audio.preferred_input_device =
        normalize_audio_input_device_preference(audio.preferred_input_device.clone());
    audio.dictation_input_device =
        normalize_audio_input_device_preference(audio.dictation_input_device.clone());
    audio.meeting_input_device =
        normalize_audio_input_device_preference(audio.meeting_input_device.clone());

    if !audio.dictation_input_override_enabled {
        audio.dictation_input_device = None;
    }
    if !audio.meeting_input_override_enabled {
        audio.meeting_input_device = None;
    }
}

/// Rewrite the retired "whisper"/"base.en" meeting slot to the route the
/// meeting lane resolves it to anyway.
///
/// whisper.cpp has never been a meeting-supported provider, so a stored
/// whisper meeting slot was dead: `preferred_meeting_provider` in lib.rs
/// skipped it and fell through to Parakeet TDT 0.6B v3. Storing that route
/// instead changes nothing at runtime and stops the settings file from
/// claiming a route that never ran. Only the old default pair is rewritten;
/// any other explicit whisper model in the slot is left for the resolver.
fn migrate_dead_whisper_meeting_slot(transcription: &mut TranscriptionSettings) {
    if transcription.meeting_provider == "whisper" && transcription.meeting_model_id == "base.en" {
        transcription.meeting_provider = "parakeet".to_string();
        transcription.meeting_model_id = "parakeet-tdt-0.6b-v3".to_string();
    }
}

/// Whether a raw settings.json still stores the retired meeting slot pair,
/// so the load path rewrites the file the way it does for removed keys.
fn raw_settings_carry_dead_whisper_meeting_slot(raw: &serde_json::Value) -> bool {
    let Some(transcription) = raw.get("transcription") else {
        return false;
    };
    transcription
        .get("meetingProvider")
        .and_then(serde_json::Value::as_str)
        == Some("whisper")
        && transcription
            .get("meetingModelId")
            .and_then(serde_json::Value::as_str)
            == Some("base.en")
}

fn normalize_loaded_transcription_settings(transcription: &mut TranscriptionSettings) {
    transcription.default_provider =
        normalize_transcription_provider_value(&transcription.default_provider);
    transcription.dictation_provider =
        normalize_transcription_provider_value(&transcription.dictation_provider);
    transcription.meeting_provider =
        normalize_transcription_provider_value(&transcription.meeting_provider);

    transcription.selected_model_id = normalize_transcription_model_id(
        transcription.default_provider.as_str(),
        &transcription.selected_model_id,
    );
    transcription.dictation_model_id = normalize_transcription_model_id(
        transcription.dictation_provider.as_str(),
        &transcription.dictation_model_id,
    );
    transcription.meeting_model_id = normalize_transcription_model_id(
        transcription.meeting_provider.as_str(),
        &transcription.meeting_model_id,
    );
    migrate_dead_whisper_meeting_slot(transcription);

    let mut normalized_provider_models = HashMap::new();
    for (provider, model_id) in std::mem::take(&mut transcription.provider_model_ids) {
        let normalized_provider = normalize_transcription_provider_value(&provider);
        let normalized_model =
            normalize_transcription_model_id(normalized_provider.as_str(), &model_id);
        normalized_provider_models.insert(normalized_provider, normalized_model);
    }
    transcription.provider_model_ids = normalized_provider_models;

    transcription.dictation_keep_warm =
        normalize_dictation_keep_warm(&transcription.dictation_keep_warm);
    transcription.dictation_active_languages = normalize_dictation_active_languages(
        &transcription.dictation_provider,
        &transcription.dictation_model_id,
        &transcription.dictation_active_languages,
    );

    for mode in &mut transcription.dictation_custom_modes {
        mode.base_mode_preset = mode.base_mode_preset.clone().and_then(|value| {
            let normalized = match value.trim() {
                "messages" => Some("messages"),
                "email" => Some("email"),
                "notes" => Some("notes"),
                "translate_english" => Some("translate_english"),
                "meeting_follow_up" => Some("meeting_follow_up"),
                "voice" => Some("voice"),
                _ => None,
            };
            normalized.map(str::to_string)
        });

        if let Some(provider) = mode.dictation_provider.as_mut() {
            *provider = normalize_transcription_provider_value(provider);
        }

        if let Some(model_id) = mode.dictation_model_id.as_mut() {
            let normalized_provider = mode
                .dictation_provider
                .as_deref()
                .map(normalize_transcription_provider_value)
                .unwrap_or_else(|| transcription.dictation_provider.clone());
            *model_id = normalize_transcription_model_id(normalized_provider.as_str(), model_id);
        }

        // The save path normalizes this (`normalize_dictation_custom_mode`),
        // but `get_settings` hands the loaded file straight to the renderer,
        // so a profile saved before the retirement has to be migrated here too
        // or its card renders an empty "Result:" chip.
        mode.insertion_mode = normalize_dictation_insertion_mode(&mode.insertion_mode);

        mode.language_override = mode.language_override.clone().and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        mode.custom_prompt = mode.custom_prompt.clone().and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
    }

    transcription.dictation_insertion_mode =
        normalize_dictation_insertion_mode(&transcription.dictation_insertion_mode);

    transcription.meeting_route_policy = match transcription.meeting_route_policy.trim() {
        "best_available" => "best_available".to_string(),
        _ => "prefer_local".to_string(),
    };

    // Loaded straight from disk, so a hand-edited or pre-upgrade settings.json
    // gets the same treatment `save_settings` gives a fresh write -- see
    // `sanitize_meeting_custom_templates` for why.
    transcription.meeting_custom_templates = sanitize_meeting_custom_templates(std::mem::take(
        &mut transcription.meeting_custom_templates,
    ));
}

/// Ids of the built-in `MEETING_TEMPLATES` entries in
/// `src/lib/meeting-templates.ts`. A custom template can never take one of
/// these ids -- if it did, it would silently replace a built-in everywhere
/// the built-in is resolved by id (the picker, the analysis pass, note
/// parsing), which is a much stranger failure than just refusing the save.
pub(crate) const BUILTIN_MEETING_TEMPLATE_IDS: &[&str] = &[
    "auto",
    "1on1",
    "standup",
    "sales",
    "interview",
    "brainstorm",
    "coaching",
    "doctor",
    "legal",
    "research",
    "personal_admin",
];

/// A saved template list beyond this is almost certainly a bug (a sync loop,
/// a corrupted file) rather than a user with 50 genuine playbooks.
const MAX_MEETING_CUSTOM_TEMPLATES: usize = 50;
/// Generous for a template name, which is meant to read as a short label in
/// a picker list.
const MAX_MEETING_TEMPLATE_NAME_LEN: usize = 80;
/// The summary prompt is handed to the analysis LLM verbatim (see
/// `resolve_meeting_template_summary_instruction` in `lib.rs`), so it gets
/// the same generous ceiling as the existing free-text custom prompt fields.
const MAX_MEETING_TEMPLATE_PROMPT_LEN: usize = 4000;
/// A notes outline is a handful of section headings, not a document.
const MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS: usize = 12;
const MAX_MEETING_TEMPLATE_OUTLINE_SECTION_LEN: usize = 80;

/// Sanitize a saved (or about-to-be-saved) meeting template list, mirroring
/// the discipline `normalize_dictation_custom_mode` applies to dictation
/// modes: trim and cap every free-text field, and never let a malformed or
/// oversized entry -- however it got there -- reach either the renderer's
/// picker or the analysis pass.
///
/// Called on both load (`normalize_loaded_transcription_settings`) and save
/// (`update_settings` in `lib.rs`), so a template that fails one of these
/// checks is dropped once and stays dropped rather than round-tripping back
/// in from whichever path didn't just sanitize it.
pub(crate) fn sanitize_meeting_custom_templates(
    templates: Vec<MeetingCustomTemplate>,
) -> Vec<MeetingCustomTemplate> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut sanitized = Vec::new();

    for mut template in templates {
        template.id = template.id.trim().to_string();
        template.name = template.name.trim().to_string();

        // Malformed: no identity, no label, or an id that collides with a
        // built-in template -- any of these would make the entry unusable or
        // dangerous to resolve by id, so it is dropped rather than repaired.
        if template.id.is_empty()
            || template.name.is_empty()
            || BUILTIN_MEETING_TEMPLATE_IDS.contains(&template.id.as_str())
        {
            continue;
        }
        // First occurrence wins; a duplicate id is as unresolvable as a
        // missing one, so keeping only one copy is the safe choice.
        if !seen_ids.insert(template.id.clone()) {
            continue;
        }

        template
            .name
            .truncate_to_char_count(MAX_MEETING_TEMPLATE_NAME_LEN);
        template.summary_prompt = template.summary_prompt.trim().to_string();
        template
            .summary_prompt
            .truncate_to_char_count(MAX_MEETING_TEMPLATE_PROMPT_LEN);

        template.notes_outline = template
            .notes_outline
            .into_iter()
            .map(|section| section.trim().to_string())
            .filter(|section| !section.is_empty())
            .take(MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS)
            .map(|mut section| {
                section.truncate_to_char_count(MAX_MEETING_TEMPLATE_OUTLINE_SECTION_LEN);
                section
            })
            .collect();

        sanitized.push(template);
        if sanitized.len() >= MAX_MEETING_CUSTOM_TEMPLATES {
            break;
        }
    }

    sanitized
}

/// Caps by *character* count, not byte length. The renderer's editor dialog
/// enforces the same ceilings with a plain HTML `maxLength`, which counts
/// UTF-16 code units -- for any non-ASCII text (accented names, CJK, emoji
/// within the BMP, etc.) a byte-length cap would truncate far short of what
/// the client already accepted, silently discarding content the user was
/// told fit. Counting characters here is what keeps the two ceilings in
/// agreement.
trait TruncateToCharCount {
    fn truncate_to_char_count(&mut self, max_chars: usize);
}

impl TruncateToCharCount for String {
    fn truncate_to_char_count(&mut self, max_chars: usize) {
        if self.chars().count() <= max_chars {
            return;
        }
        *self = self.chars().take(max_chars).collect();
    }
}

fn normalize_ai_lane_settings(lane: &mut AiLaneSettings) {
    // Normalize LLM provider to ensure it's a valid value
    lane.provider = lane.provider.trim().to_lowercase();
    if lane.provider.is_empty() {
        lane.provider = "ollama".to_string();
    }

    // Normalize model ID if present
    if let Some(model_id) = lane.model_id.as_mut() {
        *model_id = model_id.trim().to_string();
        if model_id.is_empty() {
            lane.model_id = None;
        }
    }
}

fn normalize_loaded_privacy_settings(privacy: &mut PrivacySettings) {
    normalize_ai_lane_settings(&mut privacy.dictation_ai);
    normalize_ai_lane_settings(&mut privacy.meetings_ai);
}

/// Update channel (stable or beta)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable releases.
    #[default]
    Stable,
    /// Opt into beta releases.
    Beta,
}

impl std::fmt::Display for UpdateChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateChannel::Stable => write!(f, "stable"),
            UpdateChannel::Beta => write!(f, "beta"),
        }
    }
}

impl From<String> for UpdateChannel {
    fn from(s: String) -> Self {
        match s.to_lowercase().as_str() {
            "beta" => UpdateChannel::Beta,
            _ => UpdateChannel::Stable,
        }
    }
}

/// Update settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    /// Update channel (stable or beta)
    pub channel: UpdateChannel,
    /// Automatically check for updates on startup
    pub auto_check: bool,
    /// Timestamp of last update check (ISO 8601)
    pub last_check_at: Option<String>,
    /// Current app version (for detecting updates)
    pub last_seen_version: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            auto_check: true,
            last_check_at: None,
            last_seen_version: None,
        }
    }
}

/// Longest silence auto-stop a user can configure, in minutes. Four hours is
/// past any meeting; beyond it the setting is a typo, not an intent.
pub const MEETING_AUTO_STOP_SILENCE_MINUTES_MAX: u32 = 240;

/// Meeting behaviours that live around a capture. Mirrors `MeetingsSettings`
/// in `src/types/settings.ts`; every field has a runtime reader
/// (`meeting_detect.rs` for detection, the meeting capture monitor in lib.rs
/// for the two auto-stops).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MeetingsSettings {
    /// Poll the running applications on this Mac for a conferencing app with
    /// a call in progress, and offer to record it. Local only; nothing leaves
    /// the machine and nothing is recorded until the user says so.
    pub call_detection_enabled: bool,
    /// End a running meeting when the call app it was recorded alongside quits
    /// (or its call window closes).
    pub auto_stop_when_call_app_quits: bool,
    /// End a running meeting after this many minutes with nothing audible on
    /// any captured source. `0` turns it off.
    pub auto_stop_after_silence_minutes: u32,
}

impl Default for MeetingsSettings {
    fn default() -> Self {
        Self {
            call_detection_enabled: true,
            auto_stop_when_call_app_quits: true,
            auto_stop_after_silence_minutes: 15,
        }
    }
}

/// Which events may become an OS notification. Mirrors `NotificationsSettings`
/// in `src/types/settings.ts`; read by `electron/notification-policy.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationsSettings {
    /// Meeting started, stopped, auto-stopped, transcript ready, notes ready
    /// or failed.
    pub meeting_events: bool,
    /// A dictation that could not be delivered, shown only while the dictation
    /// mini window is hidden (when it is visible it already says so).
    pub dictation_failures: bool,
}

impl Default for NotificationsSettings {
    fn default() -> Self {
        Self {
            meeting_events: true,
            dictation_failures: true,
        }
    }
}

/// Keep the silence auto-stop inside the range the UI offers, so a hand-edited
/// file cannot make the monitor wait for a value it will never reach.
fn normalize_loaded_meetings_settings(meetings: &mut MeetingsSettings) {
    meetings.auto_stop_after_silence_minutes = meetings
        .auto_stop_after_silence_minutes
        .min(MEETING_AUTO_STOP_SILENCE_MINUTES_MAX);
}

/// Stable string identifier for a `DictationAppCategory`, used for
/// serializing user-facing override values (settings JSON + frontend Select).
pub fn dictation_app_category_to_key(category: DictationAppCategory) -> &'static str {
    match category {
        DictationAppCategory::Other => "other",
        DictationAppCategory::Messaging => "messaging",
        DictationAppCategory::Email => "email",
        DictationAppCategory::Notes => "notes",
        DictationAppCategory::Worklog => "worklog",
        DictationAppCategory::AiChat => "ai_chat",
        DictationAppCategory::CodeEditor => "code_editor",
    }
}

/// Strictly parses a category key back into a `DictationAppCategory`,
/// returning `None` for unknown values so callers can distinguish a typo'd
/// key from an explicit "other". Used by dictionary/snippet
/// `category_scope` matching (an unknown scope must match nothing, not the
/// `Other` category) and by category-scope validation.
pub fn dictation_app_category_from_key_strict(key: &str) -> Option<DictationAppCategory> {
    match key.trim().to_ascii_lowercase().as_str() {
        "other" => Some(DictationAppCategory::Other),
        "messaging" => Some(DictationAppCategory::Messaging),
        "email" => Some(DictationAppCategory::Email),
        "notes" => Some(DictationAppCategory::Notes),
        "worklog" => Some(DictationAppCategory::Worklog),
        "ai_chat" => Some(DictationAppCategory::AiChat),
        "code_editor" => Some(DictationAppCategory::CodeEditor),
        _ => None,
    }
}

/// Parses a category key back into a `DictationAppCategory`. Unknown/blank
/// values fall back to `Other` (i.e. behave as if no override matched).
pub fn dictation_app_category_from_key(key: &str) -> DictationAppCategory {
    dictation_app_category_from_key_strict(key).unwrap_or(DictationAppCategory::Other)
}

/// Uses the same case-insensitive substring containment as
/// `dictation_parity::snippet_app_scope_matches`, but with inverted blank-matcher
/// semantics: there, a blank scope matches everything; here, an empty/blank
/// matcher matches nothing (an override must specify an app to scope to). A
/// missing app target never matches a non-empty matcher in either function.
fn dictation_app_category_override_matches(app_matcher: &str, app_target: Option<&str>) -> bool {
    let matcher = app_matcher.trim();
    if matcher.is_empty() {
        return false;
    }
    let Some(app_name) = app_target else {
        return false;
    };
    app_name.to_lowercase().contains(&matcher.to_lowercase())
}

/// Settings-aware dictation destination-app category resolver. Checks user
/// overrides first (first enabled match wins, in list order), then falls
/// through to the built-in bundle-id/name classifier.
///
/// This always resolves the real category, regardless of
/// `dictation_category_formatting_enabled` — that toggle only controls
/// whether the LLM dictation-formatting prompt injects a category-specific
/// fragment (see `run_dictation_formatting_with_selected_provider` in
/// `lib.rs`, which applies that gating itself). Other consumers, like
/// dictionary/snippet `category_scope` matching in `dictation_parity.rs`,
/// need the real resolved category unconditionally, since that's an
/// unrelated setting from AI-category-formatting.
pub fn resolve_dictation_app_category_with_overrides(
    transcription: &TranscriptionSettings,
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
) -> DictationAppCategory {
    resolve_dictation_app_category_with_overrides_and_hint(
        transcription,
        app_target,
        app_bundle_id,
        None,
    )
}

/// Like `resolve_dictation_app_category_with_overrides`, but additionally
/// considers a formatting hint (e.g. the browser activation matcher domain,
/// "mail.google.com") for both override matching and the built-in
/// classifier fallback, so web apps dictated into through a browser resolve
/// to the same category everywhere (local formatting, dictionary/snippet
/// scoping, and the LLM prompt fragment) rather than falling back to the
/// browser's own name.
pub fn resolve_dictation_app_category_with_overrides_and_hint(
    transcription: &TranscriptionSettings,
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
    formatting_hint: Option<&str>,
) -> DictationAppCategory {
    for override_entry in &transcription.dictation_app_category_overrides {
        if !override_entry.enabled {
            continue;
        }
        if dictation_app_category_override_matches(&override_entry.app_matcher, app_target)
            || dictation_app_category_override_matches(&override_entry.app_matcher, formatting_hint)
            || dictation_app_category_override_matches(&override_entry.app_matcher, app_bundle_id)
        {
            // An override with an unknown category key must behave as if no
            // override matched (per `dictation_app_category_from_key`'s
            // contract) instead of short-circuiting with `Other` and
            // suppressing the built-in classifier.
            if let Some(category) = dictation_app_category_from_key_strict(&override_entry.category)
            {
                return category;
            }
        }
    }

    let resolved = format::resolve_dictation_app_category(app_target, app_bundle_id);
    if resolved != DictationAppCategory::Other {
        return resolved;
    }
    formatting_hint
        .map(|hint| format::resolve_dictation_app_category(Some(hint), None))
        .unwrap_or(DictationAppCategory::Other)
}

/// Settings keys that are no longer part of the schema, either because they
/// had no runtime reader (placebo settings) or because a migration moved
/// their value somewhere else. Serde already ignores unknown keys on load;
/// this list drives the load-time migration that rewrites settings.json
/// without them so stale keys don't linger on disk implying behavior that
/// doesn't exist. Paths are `(section, camelCase key)`; an empty section
/// means a top-level key.
///
/// A key whose value still matters must be read out of the raw payload
/// before it is dropped — see `migrate_legacy_ai_lane_settings` for the
/// `privacy.llmProvider` / `privacy.llmModelId` pair.
const REMOVED_SETTINGS_KEYS: &[(&str, &str)] = &[
    ("", "defaultTemplate"),
    ("audio", "sampleRate"),
    ("audio", "channels"),
    ("audio", "captureSystemAudio"),
    ("audio", "captureMicrophone"),
    ("audio", "noiseSuppression"),
    ("audio", "voiceActivityDetection"),
    ("audio", "silenceTimeoutSeconds"),
    ("audio", "autoGainControl"),
    ("audio", "manualGainDb"),
    ("transcription", "autoTranscribe"),
    ("transcription", "intelligentPunctuation"),
    ("transcription", "numSpeakers"),
    ("transcription", "speakerNamingMethod"),
    // `diarizationModelId` was previously removed but has been re-added
    // as a valid field for the diarization model picker. It is no longer
    // in the removed-keys list.
    ("transcription", "saveRawTranscript"),
    ("ui", "windowPosition"),
    ("ui", "windowSize"),
    ("ui", "fontSize"),
    ("export", "defaultFormat"),
    ("export", "autoExport"),
    ("export", "exportDirectory"),
    ("export", "includeTimestamps"),
    ("export", "includeSpeakers"),
    ("export", "openAfterExport"),
    ("privacy", "encryptRecordings"),
    ("privacy", "autoDeleteDays"),
    ("privacy", "requirePassword"),
    ("privacy", "auditLogging"),
    ("privacy", "cloudSync"),
    // Superseded by the `dictationAi` / `meetingsAi` lanes; the value is
    // carried over by `migrate_legacy_ai_lane_settings` before it is dropped.
    ("privacy", "llmProvider"),
    ("privacy", "llmModelId"),
    ("shortcuts", "toggleRecording"),
    ("shortcuts", "quickExport"),
    ("shortcuts", "focusSearch"),
    // Only ever written as an empty list; real multi-binding support arrives
    // with its own schema (roadmap item B4), not through this key.
    ("shortcuts", "toggleDictationAlternates"),
];

/// Whether a raw settings.json payload still carries any key that was
/// removed from the schema (and should therefore be rewritten on load).
fn raw_settings_contain_removed_keys(raw: &serde_json::Value) -> bool {
    REMOVED_SETTINGS_KEYS.iter().any(|(section, key)| {
        let scope = if section.is_empty() {
            Some(raw)
        } else {
            raw.get(section)
        };
        scope.and_then(|value| value.get(key)).is_some()
    })
}

/// Carry a pre-lane settings.json onto the two AI lanes.
///
/// Before the split, `privacy.llmProvider` / `privacy.llmModelId` was a single
/// choice serving dictation cleanup, meeting summaries, action items, and
/// meeting Q&A. Copying that one pair into both lanes is what makes the
/// upgrade silent: every job keeps running on exactly the model it ran on
/// before, and the user only sees a difference once they deliberately point a
/// lane somewhere else.
///
/// A lane that the file already carries is never touched, even when a stale
/// legacy key sits beside it — the explicit per-lane choice is the newer
/// intent. Lanes are considered independently, so a file carrying only one of
/// them still gets the legacy value copied into the other.
fn migrate_legacy_ai_lane_settings(raw: &serde_json::Value, privacy: &mut PrivacySettings) {
    let Some(raw_privacy) = raw.get("privacy") else {
        return;
    };

    let legacy_provider = raw_privacy
        .get("llmProvider")
        .and_then(serde_json::Value::as_str);
    let legacy_model_id = raw_privacy.get("llmModelId");
    if legacy_provider.is_none() && legacy_model_id.is_none() {
        return;
    }

    // `llmModelId` was nullable, so a present-but-null key is a real "no
    // model chosen" and must land on the lanes as `None` rather than being
    // treated as absent.
    let legacy_model_id = legacy_model_id.and_then(|value| match value {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(model_id) => Some(Some(model_id.clone())),
        _ => None,
    });

    for (lane_key, lane) in [
        ("dictationAi", &mut privacy.dictation_ai),
        ("meetingsAi", &mut privacy.meetings_ai),
    ] {
        if raw_privacy.get(lane_key).is_some() {
            continue;
        }
        if let Some(provider) = legacy_provider {
            lane.provider = provider.to_string();
        }
        if let Some(model_id) = legacy_model_id.as_ref() {
            lane.model_id = model_id.clone();
        }
    }
}

/// Settings manager
pub struct SettingsManager {
    settings: Settings,
    config_path: PathBuf,
}

impl SettingsManager {
    /// Create new settings manager.
    pub fn new() -> Result<Self> {
        Self::load_from_path(Self::config_path()?)
    }

    fn load_from_path(config_path: PathBuf) -> Result<Self> {
        let mut needs_migration_rewrite = false;
        let mut settings = if config_path.exists() {
            match Self::load_from_file(&config_path) {
                Ok((mut settings, raw)) => {
                    needs_migration_rewrite = raw_settings_contain_removed_keys(&raw)
                        || raw_settings_carry_dead_whisper_meeting_slot(&raw);
                    // Must run before the removed keys are dropped from disk
                    // by the rewrite below: it is the only thing that reads
                    // the retired single AI provider/model pair.
                    migrate_legacy_ai_lane_settings(&raw, &mut settings.privacy);
                    settings
                }
                Err(err) => {
                    // A corrupt or truncated settings file must never block startup.
                    // Move it aside for diagnostics and fall back to defaults. The
                    // backup name is timestamped so a later corruption never
                    // overwrites an earlier diagnostic copy.
                    tracing::warn!(
                        "Settings file at {} is unreadable ({}); backing it up and using defaults",
                        config_path.display(),
                        err
                    );
                    let backup_path = config_path.with_extension(format!(
                        "json.corrupt-{}",
                        chrono::Utc::now().format("%Y%m%dT%H%M%S")
                    ));
                    if let Err(rename_err) = std::fs::rename(&config_path, &backup_path) {
                        tracing::warn!(
                            "Failed to move corrupt settings file aside: {}",
                            rename_err
                        );
                    }
                    Settings::default()
                }
            }
        } else {
            Settings::default()
        };
        normalize_loaded_audio_settings(&mut settings.audio);
        normalize_keyboard_shortcuts(&mut settings.shortcuts);
        normalize_loaded_transcription_settings(&mut settings.transcription);
        normalize_loaded_privacy_settings(&mut settings.privacy);
        normalize_loaded_meetings_settings(&mut settings.meetings);

        let manager = Self {
            settings,
            config_path,
        };

        // Migration: rewrite settings.json without keys removed from the
        // schema, so the on-disk file honestly matches what the app reads.
        if needs_migration_rewrite {
            if let Err(error) = manager.save() {
                tracing::warn!(
                    "Failed to rewrite settings.json while dropping removed keys: {}",
                    error
                );
            }
        }

        Ok(manager)
    }

    /// Replace the in-memory settings with a freshly normalized load from the
    /// same file. Restore uses this so `get_settings` changes immediately.
    pub(crate) fn reload_from_disk(&mut self) -> Result<()> {
        let replacement = Self::load_from_path(self.config_path.clone())?;
        *self = replacement;
        Ok(())
    }

    /// Get settings reference
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Get mutable settings reference
    pub fn settings_mut(&mut self) -> &mut Settings {
        &mut self.settings
    }

    /// Save settings to disk atomically (write to a temp file, then rename) so
    /// a crash or power loss mid-write can never leave a truncated settings file.
    pub fn save(&self) -> Result<()> {
        let json =
            serde_json::to_string_pretty(&self.settings).context("Failed to serialize settings")?;

        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create settings directory")?;
        }

        let tmp_path = self.config_path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut tmp_file =
                std::fs::File::create(&tmp_path).context("Failed to create temp settings file")?;
            tmp_file
                .write_all(json.as_bytes())
                .context("Failed to write temp settings file")?;
            // Flush file contents to stable storage before the rename so a
            // power loss can't commit an empty/truncated file over the old one.
            tmp_file
                .sync_all()
                .context("Failed to sync temp settings file")?;
        }
        std::fs::rename(&tmp_path, &self.config_path).context("Failed to commit settings file")?;

        Ok(())
    }

    /// Reset to defaults
    pub fn reset(&mut self) {
        self.settings = Settings::default();
    }

    /// Load settings from file, also returning the raw JSON value so the
    /// caller can detect stale removed keys that need a migration rewrite.
    fn load_from_file(path: &PathBuf) -> Result<(Settings, serde_json::Value)> {
        let json = std::fs::read_to_string(path).context("Failed to read settings file")?;

        let raw: serde_json::Value =
            serde_json::from_str(&json).context("Failed to parse settings file")?;
        let settings: Settings =
            serde_json::from_value(raw.clone()).context("Failed to parse settings file")?;

        Ok((settings, raw))
    }

    /// Get config directory path
    fn config_path() -> Result<PathBuf> {
        settings_file_path()
    }
}

impl Default for SettingsManager {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            config_path: PathBuf::from("settings.json"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dictation_app_category_from_key, dictation_app_category_to_key,
        dictation_supported_languages, migrate_legacy_ai_lane_settings,
        normalize_audio_input_device_preference, validate_dictation_active_languages,
        AutomationSettings, ENGLISH_ONLY_LANGUAGES, PARAKEET_V3_LANGUAGES,
        WHISPER_MULTILINGUAL_LANGUAGES,
    };
    use super::{
        normalize_dictation_active_languages, normalize_loaded_privacy_settings,
        normalize_loaded_transcription_settings, normalize_transcription_model_id,
        resolve_dictation_app_category_with_overrides, sanitize_meeting_custom_templates, AiLane,
        AiLaneSettings, AudioInputDevicePreference, DictationAppCategoryOverride,
        DictationCustomMode, MeetingCustomTemplate, MeetingsSettings, PlatformOptimizationSettings,
        PrivacySettings, Settings, SettingsManager, TranscriptionSettings,
        MAX_MEETING_CUSTOM_TEMPLATES, MAX_MEETING_TEMPLATE_NAME_LEN,
        MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS, MAX_MEETING_TEMPLATE_OUTLINE_SECTION_LEN,
        MAX_MEETING_TEMPLATE_PROMPT_LEN, MEETING_AUTO_STOP_SILENCE_MINUTES_MAX,
    };
    use crate::text::format::DictationAppCategory;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn settings_written_before_the_python_providers_were_deleted_land_on_whisper() {
        // mlx_audio, voxtral and the managed-Python Parakeet routes are gone.
        // A settings.json from before that still names them, and normalization
        // is the only thing standing between that file and a provider slot
        // pointing at an engine that cannot answer. Keeping an arm for a
        // retired name would make it the canonical output of the settings
        // layer, so these must fall through.
        let mut retired_providers = TranscriptionSettings {
            default_provider: "mlx_audio".to_string(),
            dictation_provider: "voxtral".to_string(),
            ..Default::default()
        };
        normalize_loaded_transcription_settings(&mut retired_providers);
        assert_eq!(retired_providers.default_provider, "whisper");
        assert_eq!(retired_providers.dictation_provider, "whisper");
        // The model id is normalized against its own provider, so a slot that
        // fell back to whisper must carry a whisper model, not the orphaned id
        // of the engine that just went away.
        assert_eq!(retired_providers.dictation_model_id, "base.en");

        // Parakeet itself survives; only its managed-Python model ids went. A
        // stale id collapses to the shipping v3 route rather than taking the
        // whole provider down with it.
        let mut retired_model = TranscriptionSettings {
            dictation_provider: "parakeet".to_string(),
            dictation_model_id: "parakeet-ctc-1.1b".to_string(),
            ..Default::default()
        };
        normalize_loaded_transcription_settings(&mut retired_model);
        assert_eq!(retired_model.dictation_provider, "parakeet");
        assert_eq!(retired_model.dictation_model_id, "parakeet-tdt-0.6b-v3");
    }

    #[test]
    fn qwen3_asr_language_list_matches_the_provider_and_names_cjk() {
        let supported = dictation_supported_languages("qwen3_asr", "qwen3-asr-0.6b")
            .expect("Qwen3-ASR enumerates its languages");
        assert_eq!(supported.len(), 30);
        for code in ["en", "zh", "ja", "ko", "yue", "fil"] {
            assert!(supported.contains(&code), "missing {code}");
        }
        let mut from_provider: Vec<&str> = crate::asr::qwen3_asr::QWEN3_ASR_LANGUAGES
            .iter()
            .map(|(_, code)| *code)
            .collect();
        from_provider.sort_unstable();
        let mut from_settings: Vec<&str> = supported.to_vec();
        from_settings.sort_unstable();
        assert_eq!(from_settings, from_provider);

        assert!(validate_dictation_active_languages(
            "qwen3_asr",
            "qwen3-asr-0.6b",
            &["zh".to_string(), "ja".to_string(), "ko".to_string()]
        )
        .is_ok());
        assert!(validate_dictation_active_languages(
            "qwen3_asr",
            "qwen3-asr-0.6b",
            &["uk".to_string()]
        )
        .is_err());
    }

    #[test]
    fn qwen3_asr_provider_and_model_survive_settings_reload() {
        let mut settings = TranscriptionSettings {
            default_provider: "qwen3_asr".to_string(),
            dictation_provider: "qwen3_asr".to_string(),
            meeting_provider: "qwen3_asr".to_string(),
            selected_model_id: "qwen3-asr-0.6b".to_string(),
            dictation_model_id: "qwen3-asr-0.6b".to_string(),
            meeting_model_id: "qwen3-asr-0.6b".to_string(),
            ..Default::default()
        };
        normalize_loaded_transcription_settings(&mut settings);
        assert_eq!(settings.default_provider, "qwen3_asr");
        assert_eq!(settings.dictation_provider, "qwen3_asr");
        assert_eq!(settings.meeting_provider, "qwen3_asr");
        assert_eq!(settings.selected_model_id, "qwen3-asr-0.6b");
        assert_eq!(settings.dictation_model_id, "qwen3-asr-0.6b");
        assert_eq!(settings.meeting_model_id, "qwen3-asr-0.6b");
    }

    #[test]
    fn cohere_transcribe_survives_settings_reload_with_its_model_slot() {
        let mut transcription = TranscriptionSettings {
            default_provider: "cohere_transcribe".to_string(),
            selected_model_id: "cohere-transcribe-03-2026".to_string(),
            ..Default::default()
        };
        transcription.provider_model_ids.insert(
            "cohere_transcribe".to_string(),
            "cohere-transcribe-03-2026".to_string(),
        );

        normalize_loaded_transcription_settings(&mut transcription);

        assert_eq!(transcription.default_provider, "cohere_transcribe");
        assert_eq!(transcription.selected_model_id, "cohere-transcribe-03-2026");
        assert_eq!(
            transcription.provider_model_ids.get("cohere_transcribe"),
            Some(&"cohere-transcribe-03-2026".to_string())
        );
    }

    #[test]
    fn every_provider_model_option_survives_normalization_unchanged() {
        // Regression coverage for the scribe_v2_realtime three-way disagreement:
        // the picker offered it labeled "recommended", the provider accepted
        // it, and this same normalizer silently rewrote it to scribe_v2 on
        // every launch -- so a user's explicit choice never stuck. Every id a
        // provider's own ModelOption list offers must be a fixed point of
        // `normalize_transcription_model_id`, or the picker is lying about
        // what happens when you pick it.
        let providers: &[(&str, crate::asr::AsrProviderType)] = &[
            ("whisper", crate::asr::AsrProviderType::Whisper),
            ("parakeet", crate::asr::AsrProviderType::Parakeet),
            ("whisper_candle", crate::asr::AsrProviderType::WhisperCandle),
            ("distil_whisper", crate::asr::AsrProviderType::DistilWhisper),
            (
                "macos_apple_speech",
                crate::asr::AsrProviderType::MacosAppleSpeech,
            ),
            ("moonshine", crate::asr::AsrProviderType::Moonshine),
            (
                "windows_sdk_dictation",
                crate::asr::AsrProviderType::WindowsSdkDictation,
            ),
            (
                "elevenlabs_scribe",
                crate::asr::AsrProviderType::ElevenLabsScribe,
            ),
            ("openai_cloud", crate::asr::AsrProviderType::OpenAiCloud),
            ("groq", crate::asr::AsrProviderType::Groq),
            (
                "cohere_transcribe",
                crate::asr::AsrProviderType::CohereTranscribe,
            ),
            ("qwen3_asr", crate::asr::AsrProviderType::Qwen3Asr),
        ];

        for (key, provider_type) in providers {
            for option in provider_type.model_options() {
                assert_eq!(
                    normalize_transcription_model_id(key, &option.id),
                    option.id,
                    "provider '{key}' offers model option '{}' that normalization rewrites to something else",
                    option.id
                );
            }
        }
    }

    #[test]
    fn every_provider_empty_string_default_matches_its_asr_provider_type_default() {
        // Regression coverage for the openai_cloud drift this guards against:
        // settings.rs's normalize_transcription_model_id(provider, "") used to
        // disagree with AsrProviderType::default_model_id() (asr/mod.rs) and
        // the provider's own sanitizer default (e.g. openai_cloud.rs's
        // sanitize_openai_asr_model_id empty-case arm) about what an
        // unset/empty model id actually resolves to. All three must always
        // name the same model, or a user with no explicit model id ends up on
        // a different one every time settings.json is normalized.
        let providers: &[(&str, crate::asr::AsrProviderType)] = &[
            ("whisper", crate::asr::AsrProviderType::Whisper),
            ("parakeet", crate::asr::AsrProviderType::Parakeet),
            ("whisper_candle", crate::asr::AsrProviderType::WhisperCandle),
            ("distil_whisper", crate::asr::AsrProviderType::DistilWhisper),
            (
                "macos_apple_speech",
                crate::asr::AsrProviderType::MacosAppleSpeech,
            ),
            ("moonshine", crate::asr::AsrProviderType::Moonshine),
            (
                "windows_sdk_dictation",
                crate::asr::AsrProviderType::WindowsSdkDictation,
            ),
            (
                "elevenlabs_scribe",
                crate::asr::AsrProviderType::ElevenLabsScribe,
            ),
            ("openai_cloud", crate::asr::AsrProviderType::OpenAiCloud),
            ("groq", crate::asr::AsrProviderType::Groq),
            (
                "cohere_transcribe",
                crate::asr::AsrProviderType::CohereTranscribe,
            ),
            ("qwen3_asr", crate::asr::AsrProviderType::Qwen3Asr),
        ];

        for (key, provider_type) in providers {
            assert_eq!(
                normalize_transcription_model_id(key, ""),
                provider_type.default_model_id(),
                "provider '{key}': normalize_transcription_model_id(_, \"\") disagrees with \
                 AsrProviderType::default_model_id()",
            );
        }
    }

    #[test]
    fn reload_from_disk_replaces_live_settings_and_runs_load_normalization() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nautilus-settings-reload-{suffix}"));
        let settings_path = root.join("settings.json");
        fs::create_dir_all(&root).expect("create settings test directory");

        let original = Settings {
            theme: "light".to_string(),
            ..Settings::default()
        };
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&original).expect("serialize original settings"),
        )
        .expect("write original settings");
        let mut manager =
            SettingsManager::load_from_path(settings_path.clone()).expect("load original settings");
        assert_eq!(manager.settings().theme, "light");

        let restored = Settings {
            theme: "dark".to_string(),
            transcription: TranscriptionSettings {
                default_provider: "canary".to_string(),
                ..TranscriptionSettings::default()
            },
            ..Settings::default()
        };
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&restored).expect("serialize restored settings"),
        )
        .expect("replace settings file");

        manager
            .reload_from_disk()
            .expect("reload restored settings into live manager");
        assert_eq!(manager.settings().theme, "dark");
        assert_eq!(
            manager.settings().transcription.default_provider,
            "whisper_candle"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn meeting_slot_default_names_the_route_the_meeting_lane_runs() {
        let settings = Settings::default();
        assert_eq!(settings.transcription.meeting_provider, "parakeet");
        assert_eq!(
            settings.transcription.meeting_model_id,
            "parakeet-tdt-0.6b-v3"
        );
        assert!(settings.transcription.use_shared_asr_selection);
    }

    #[test]
    fn dead_whisper_meeting_slot_migrates_to_parakeet_without_touching_sharing() {
        for shared in [true, false] {
            let mut transcription = TranscriptionSettings {
                use_shared_asr_selection: shared,
                meeting_provider: "whisper".to_string(),
                meeting_model_id: "base.en".to_string(),
                ..Default::default()
            };
            normalize_loaded_transcription_settings(&mut transcription);
            assert_eq!(transcription.meeting_provider, "parakeet");
            assert_eq!(transcription.meeting_model_id, "parakeet-tdt-0.6b-v3");
            assert_eq!(transcription.use_shared_asr_selection, shared);
        }

        // Only the retired default pair is rewritten. Another whisper model
        // in the slot is an explicit choice the route resolver judges.
        let mut explicit = TranscriptionSettings {
            meeting_provider: "whisper".to_string(),
            meeting_model_id: "small".to_string(),
            ..Default::default()
        };
        normalize_loaded_transcription_settings(&mut explicit);
        assert_eq!(explicit.meeting_provider, "whisper");
        assert_eq!(explicit.meeting_model_id, "small");
    }

    #[test]
    fn stored_whisper_meeting_default_is_rewritten_on_load() {
        use super::raw_settings_carry_dead_whisper_meeting_slot;

        let legacy = serde_json::json!({
            "transcription": { "meetingProvider": "whisper", "meetingModelId": "base.en" }
        });
        assert!(raw_settings_carry_dead_whisper_meeting_slot(&legacy));
        assert!(!raw_settings_carry_dead_whisper_meeting_slot(
            &serde_json::to_value(Settings::default()).expect("settings serialize")
        ));

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nautilus-settings-meeting-slot-{suffix}"));
        let settings_path = root.join("settings.json");
        fs::create_dir_all(&root).expect("create settings test directory");
        fs::write(
            &settings_path,
            serde_json::to_string(&legacy).expect("serialize"),
        )
        .expect("write legacy settings");

        let manager =
            SettingsManager::load_from_path(settings_path.clone()).expect("load legacy settings");
        assert_eq!(
            manager.settings().transcription.meeting_provider,
            "parakeet"
        );
        assert_eq!(
            manager.settings().transcription.meeting_model_id,
            "parakeet-tdt-0.6b-v3"
        );

        let rewritten: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).expect("read rewritten file"))
                .expect("rewritten settings parse");
        assert_eq!(
            rewritten["transcription"]["meetingProvider"],
            serde_json::json!("parakeet")
        );
        assert_eq!(
            rewritten["transcription"]["meetingModelId"],
            serde_json::json!("parakeet-tdt-0.6b-v3")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn settings_file_with_retired_toggle_dictation_alternates_loads_cleanly() {
        use super::raw_settings_contain_removed_keys;

        let legacy = serde_json::json!({
            "shortcuts": {
                "toggleDictation": "Cmd+Shift+Space",
                "toggleDictationAlternates": ["Ctrl+Shift+Space"],
                "openWindow": "Ctrl+Shift+N"
            }
        });
        assert!(raw_settings_contain_removed_keys(&legacy));

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nautilus-settings-alternates-{suffix}"));
        let settings_path = root.join("settings.json");
        fs::create_dir_all(&root).expect("create settings test directory");
        fs::write(
            &settings_path,
            serde_json::to_string(&legacy).expect("serialize"),
        )
        .expect("write legacy settings");

        let manager = SettingsManager::load_from_path(settings_path.clone())
            .expect("a file carrying the retired key must still load");
        assert_eq!(
            manager.settings().shortcuts.toggle_dictation,
            "Cmd+Shift+Space"
        );
        assert_eq!(manager.settings().shortcuts.open_window, "Ctrl+Shift+N");

        let rewritten: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).expect("read rewritten file"))
                .expect("rewritten settings parse");
        assert!(rewritten["shortcuts"]
            .get("toggleDictationAlternates")
            .is_none());
        assert!(
            serde_json::to_value(Settings::default()).expect("settings serialize")["shortcuts"]
                .get("toggleDictationAlternates")
                .is_none()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removed_settings_keys_trigger_migration_rewrite() {
        use super::raw_settings_contain_removed_keys;

        // A legacy file still carrying placebo keys must be flagged for rewrite.
        let legacy: serde_json::Value = serde_json::json!({
            "audio": { "sampleRate": 16000 },
            "privacy": { "encryptRecordings": true },
        });
        assert!(raw_settings_contain_removed_keys(&legacy));

        let legacy_top_level: serde_json::Value =
            serde_json::json!({ "defaultTemplate": "meeting" });
        assert!(raw_settings_contain_removed_keys(&legacy_top_level));

        // A current-schema file must not be rewritten on every load.
        let current = serde_json::to_value(Settings::default()).expect("settings serialize");
        assert!(!raw_settings_contain_removed_keys(&current));
    }

    #[test]
    fn legacy_settings_with_removed_keys_still_deserialize() {
        // serde must ignore removed keys instead of failing the load.
        let parsed: Settings = serde_json::from_str(
            r#"{
                "audio": { "sampleRate": 44100, "noiseSuppression": false },
                "transcription": { "numSpeakers": 3, "speakerNamingMethod": "manual" },
                "privacy": { "encryptRecordings": true, "autoDeleteDays": 7 },
                "shortcuts": { "toggleRecording": "Ctrl+Shift+R" },
                "defaultTemplate": "meeting"
            }"#,
        )
        .expect("legacy settings should deserialize");
        assert!(!parsed.privacy.vault_initialized);
        assert_eq!(parsed.theme, "system");
    }

    /// A settings.json written before the `meetings` and `notifications`
    /// sections existed must load with their defaults: detection on, both
    /// auto-stops on at 15 minutes, both notification classes on.
    #[test]
    fn settings_without_meetings_or_notifications_sections_take_the_defaults() {
        let parsed: Settings = serde_json::from_str(
            r#"{
                "audio": {},
                "transcription": { "defaultProvider": "parakeet" },
                "ui": { "minimizeToTray": false },
                "theme": "dark"
            }"#,
        )
        .expect("pre-meetings settings should deserialize");
        assert!(parsed.meetings.call_detection_enabled);
        assert!(parsed.meetings.auto_stop_when_call_app_quits);
        assert_eq!(parsed.meetings.auto_stop_after_silence_minutes, 15);
        assert!(parsed.notifications.meeting_events);
        assert!(parsed.notifications.dictation_failures);

        // And a partial section keeps the defaults for what it does not name.
        let parsed: Settings = serde_json::from_str(
            r#"{ "meetings": { "callDetectionEnabled": false }, "notifications": { "meetingEvents": false } }"#,
        )
        .expect("partial meetings section should deserialize");
        assert!(!parsed.meetings.call_detection_enabled);
        assert!(parsed.meetings.auto_stop_when_call_app_quits);
        assert_eq!(parsed.meetings.auto_stop_after_silence_minutes, 15);
        assert!(!parsed.notifications.meeting_events);
        assert!(parsed.notifications.dictation_failures);
    }

    #[test]
    fn silence_auto_stop_minutes_are_capped_on_load() {
        let mut meetings = MeetingsSettings {
            auto_stop_after_silence_minutes: 10_000,
            ..MeetingsSettings::default()
        };
        super::normalize_loaded_meetings_settings(&mut meetings);
        assert_eq!(
            meetings.auto_stop_after_silence_minutes,
            MEETING_AUTO_STOP_SILENCE_MINUTES_MAX
        );

        // Zero means off and must survive untouched.
        let mut off = MeetingsSettings {
            auto_stop_after_silence_minutes: 0,
            ..MeetingsSettings::default()
        };
        super::normalize_loaded_meetings_settings(&mut off);
        assert_eq!(off.auto_stop_after_silence_minutes, 0);
    }

    /// A settings.json written before the `automation` section existed must
    /// load with local tools OFF: the section gates other processes reading
    /// meeting data, so its absence has to mean "not granted", never a panic
    /// or a silently-on default.
    #[test]
    fn settings_file_without_automation_section_loads_with_local_tools_off() {
        let parsed: Settings = serde_json::from_str(
            r#"{
                "audio": {},
                "transcription": {},
                "ui": { "minimizeToTray": false },
                "privacy": {},
                "shortcuts": {},
                "updates": {},
                "theme": "dark"
            }"#,
        )
        .expect("pre-automation settings should deserialize");
        assert!(!parsed.automation.local_tools_enabled);
        assert_eq!(parsed.theme, "dark");
        assert_eq!(parsed.automation, AutomationSettings::default());
    }

    #[test]
    fn automation_section_round_trips_in_camel_case() {
        let mut settings = Settings::default();
        settings.automation.local_tools_enabled = true;
        let json = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(
            json["automation"]["localToolsEnabled"],
            serde_json::Value::Bool(true)
        );
        let parsed: Settings = serde_json::from_value(json).expect("round trip");
        assert!(parsed.automation.local_tools_enabled);
    }

    fn lane(provider: &str, model_id: Option<&str>) -> AiLaneSettings {
        AiLaneSettings {
            provider: provider.to_string(),
            model_id: model_id.map(str::to_string),
        }
    }

    /// A fresh install must not silently change which model runs anything, so
    /// both lanes start where the single setting used to.
    #[test]
    fn ai_lane_defaults_match_the_single_setting_they_replaced() {
        let privacy = PrivacySettings::default();
        assert_eq!(privacy.dictation_ai, lane("ollama", None));
        assert_eq!(privacy.meetings_ai, lane("ollama", None));
    }

    #[test]
    fn ai_lane_accessor_returns_the_lane_it_names() {
        let privacy = PrivacySettings {
            dictation_ai: lane("ollama", Some("qwen3:4b")),
            meetings_ai: lane("anthropic", Some("claude-opus-4-1")),
            ..PrivacySettings::default()
        };
        assert_eq!(privacy.ai_lane(AiLane::Dictation), &privacy.dictation_ai);
        assert_eq!(privacy.ai_lane(AiLane::Meetings), &privacy.meetings_ai);
    }

    /// Direction 1: a settings.json written before the split. The one choice
    /// it carries was serving dictation cleanup *and* summaries/action
    /// items/Q&A, so it has to land on both lanes or the upgrade would quietly
    /// move some of that work onto a different model.
    #[test]
    fn legacy_single_ai_setting_migrates_into_both_lanes() {
        let raw = serde_json::json!({
            "privacy": {
                "llmProvider": "anthropic",
                "llmModelId": "claude-sonnet-4-5",
            }
        });
        let mut privacy = PrivacySettings::default();
        migrate_legacy_ai_lane_settings(&raw, &mut privacy);

        assert_eq!(
            privacy.dictation_ai,
            lane("anthropic", Some("claude-sonnet-4-5"))
        );
        assert_eq!(
            privacy.meetings_ai,
            lane("anthropic", Some("claude-sonnet-4-5"))
        );
    }

    /// The provider was required but the model id was nullable, and "no model
    /// chosen" is a real state that means "use the provider's default". A
    /// present-but-null value must not be mistaken for an absent key.
    #[test]
    fn legacy_single_ai_setting_migrates_a_null_model_id() {
        let raw = serde_json::json!({
            "privacy": { "llmProvider": "openai", "llmModelId": null }
        });
        let mut privacy = PrivacySettings {
            dictation_ai: lane("gemini", Some("stale")),
            meetings_ai: lane("gemini", Some("stale")),
            ..PrivacySettings::default()
        };
        migrate_legacy_ai_lane_settings(&raw, &mut privacy);

        assert_eq!(privacy.dictation_ai, lane("openai", None));
        assert_eq!(privacy.meetings_ai, lane("openai", None));
    }

    /// Direction 2: a settings.json already carrying lanes is left alone, even
    /// when a stale legacy key is still sitting beside it — the per-lane
    /// choice is the newer, deliberate one.
    #[test]
    fn settings_already_carrying_lanes_are_left_alone() {
        let raw = serde_json::json!({
            "privacy": {
                "dictationAi": { "provider": "ollama", "modelId": "qwen3:4b" },
                "meetingsAi": { "provider": "anthropic", "modelId": "claude-opus-4-1" },
                "llmProvider": "deepseek",
                "llmModelId": "deepseek-chat",
            }
        });
        let mut privacy = PrivacySettings {
            dictation_ai: lane("ollama", Some("qwen3:4b")),
            meetings_ai: lane("anthropic", Some("claude-opus-4-1")),
            ..PrivacySettings::default()
        };
        migrate_legacy_ai_lane_settings(&raw, &mut privacy);

        assert_eq!(privacy.dictation_ai, lane("ollama", Some("qwen3:4b")));
        assert_eq!(
            privacy.meetings_ai,
            lane("anthropic", Some("claude-opus-4-1"))
        );
    }

    /// A half-written file (one lane saved, the legacy pair never cleaned up)
    /// keeps the lane it has and fills the other from the legacy value.
    #[test]
    fn a_partially_split_file_only_fills_the_missing_lane() {
        let raw = serde_json::json!({
            "privacy": {
                "dictationAi": { "provider": "ollama", "modelId": "qwen3:4b" },
                "llmProvider": "gemini",
                "llmModelId": "gemini-2.5-pro",
            }
        });
        let mut privacy = PrivacySettings {
            dictation_ai: lane("ollama", Some("qwen3:4b")),
            ..PrivacySettings::default()
        };
        migrate_legacy_ai_lane_settings(&raw, &mut privacy);

        assert_eq!(privacy.dictation_ai, lane("ollama", Some("qwen3:4b")));
        assert_eq!(privacy.meetings_ai, lane("gemini", Some("gemini-2.5-pro")));
    }

    /// Direction 3: a blob carrying neither the legacy pair nor the lanes.
    /// Nothing to migrate, so the defaults survive untouched.
    #[test]
    fn settings_with_neither_legacy_keys_nor_lanes_keep_the_defaults() {
        let mut privacy = PrivacySettings::default();

        migrate_legacy_ai_lane_settings(&serde_json::json!({ "theme": "dark" }), &mut privacy);
        assert_eq!(privacy.dictation_ai, lane("ollama", None));
        assert_eq!(privacy.meetings_ai, lane("ollama", None));

        migrate_legacy_ai_lane_settings(
            &serde_json::json!({ "privacy": { "remoteProcessingEnabled": true } }),
            &mut privacy,
        );
        assert_eq!(privacy.dictation_ai, lane("ollama", None));
        assert_eq!(privacy.meetings_ai, lane("ollama", None));
    }

    /// The retired keys go through the same rewrite that strips every other
    /// removed key, so the migrated value doesn't linger on disk next to the
    /// lanes that superseded it.
    #[test]
    fn retired_single_ai_setting_keys_trigger_the_migration_rewrite() {
        use super::raw_settings_contain_removed_keys;

        assert!(raw_settings_contain_removed_keys(&serde_json::json!({
            "privacy": { "llmProvider": "anthropic" }
        })));
        assert!(raw_settings_contain_removed_keys(&serde_json::json!({
            "privacy": { "llmModelId": null }
        })));
        assert!(!raw_settings_contain_removed_keys(
            &serde_json::to_value(Settings::default()).expect("settings serialize")
        ));
    }

    /// End to end through the real load path: a pre-split file on disk comes
    /// back with both lanes set, and is rewritten without the retired keys.
    #[test]
    fn loading_a_pre_split_settings_file_lands_on_both_lanes_and_rewrites_it() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nautilus-settings-ai-lanes-{suffix}"));
        let settings_path = root.join("settings.json");
        fs::create_dir_all(&root).expect("create settings test directory");
        fs::write(
            &settings_path,
            r#"{
                "privacy": {
                    "remoteProcessingEnabled": true,
                    "llmProvider": "  OpenAI  ",
                    "llmModelId": "  gpt-4o  "
                }
            }"#,
        )
        .expect("write pre-split settings");

        let manager = SettingsManager::load_from_path(settings_path.clone())
            .expect("load pre-split settings");
        let privacy = &manager.settings().privacy;
        // Normalization runs per lane, exactly as it ran on the single pair.
        assert_eq!(privacy.dictation_ai, lane("openai", Some("gpt-4o")));
        assert_eq!(privacy.meetings_ai, lane("openai", Some("gpt-4o")));
        assert!(privacy.remote_processing_enabled);

        let rewritten: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).expect("read rewritten file"))
                .expect("rewritten settings parse");
        let rewritten_privacy = rewritten.get("privacy").expect("privacy section");
        assert!(rewritten_privacy.get("llmProvider").is_none());
        assert!(rewritten_privacy.get("llmModelId").is_none());
        assert_eq!(
            rewritten_privacy["dictationAi"]["provider"],
            serde_json::json!("openai")
        );
        assert_eq!(
            rewritten_privacy["meetingsAi"]["modelId"],
            serde_json::json!("gpt-4o")
        );

        // Reloading the rewritten file must be a no-op, not a second migration.
        let reloaded =
            SettingsManager::load_from_path(settings_path.clone()).expect("reload rewritten file");
        assert_eq!(
            reloaded.settings().privacy.dictation_ai,
            lane("openai", Some("gpt-4o"))
        );
        assert_eq!(
            reloaded.settings().privacy.meetings_ai,
            lane("openai", Some("gpt-4o"))
        );

        let _ = fs::remove_dir_all(root);
    }

    /// Normalization is per lane: each one lowercases its own provider, falls
    /// back to the default when it is blank, and drops a whitespace-only model
    /// id — matching what the single pair did before the split.
    #[test]
    fn ai_lane_normalization_applies_to_each_lane_independently() {
        let mut privacy = PrivacySettings {
            dictation_ai: lane("  Ollama  ", Some("   ")),
            meetings_ai: lane("   ", Some("  Claude-Sonnet-4-5  ")),
            ..PrivacySettings::default()
        };
        normalize_loaded_privacy_settings(&mut privacy);

        assert_eq!(privacy.dictation_ai, lane("ollama", None));
        assert_eq!(
            privacy.meetings_ai,
            lane("ollama", Some("Claude-Sonnet-4-5")),
            "a blank provider falls back to the default, and a model id keeps its case"
        );
    }

    #[test]
    fn platform_optimization_defaults_are_stable() {
        let settings = Settings::default();
        let optimization = settings.transcription.platform_optimization;
        assert_eq!(optimization.mode, "auto");
        assert_eq!(optimization.fallback_policy, "local_only");
        assert!(!optimization.macos.apple_native_enabled);
        assert!(optimization.macos.mlx_enabled);
        assert!(!optimization.windows.foundry_enabled);
        assert!(!optimization.windows.windows_sdk_dictation_enabled);
        assert!(optimization.manual_engine_priority.is_empty());
    }

    #[test]
    fn platform_optimization_deserializes_missing_fields() {
        let parsed: PlatformOptimizationSettings =
            serde_json::from_str("{}").expect("platform optimization should deserialize");
        assert_eq!(parsed.mode, "auto");
        assert_eq!(parsed.fallback_policy, "local_only");
    }

    #[test]
    fn dictation_command_defaults_are_stable() {
        let settings = Settings::default();
        assert!(settings.transcription.use_shared_asr_selection);
        assert_eq!(settings.transcription.dictation_provider, "parakeet");
        assert_eq!(settings.transcription.meeting_provider, "parakeet");
        assert!(settings.transcription.dictation_command_mode_enabled);
        assert_eq!(settings.transcription.dictation_command_prefix, "command");
        assert_eq!(settings.transcription.dictation_insertion_mode, "auto");
        assert!(settings.transcription.dictation_snippets_enabled);
        assert!(settings.transcription.dictation_auto_learn_corrections);
    }

    #[test]
    fn reading_other_apps_fields_back_is_off_until_the_user_asks_for_it() {
        // Both a fresh install and a settings file written before this
        // setting existed must land on "off". Serde fills a missing field
        // from `Default`, so these two assertions are the same guarantee
        // seen from the two directions users actually arrive from.
        assert!(
            !Settings::default()
                .transcription
                .dictation_learn_from_external_corrections
        );

        let upgraded: TranscriptionSettings =
            serde_json::from_str("{}").expect("transcription settings should deserialize");
        assert!(!upgraded.dictation_learn_from_external_corrections);
    }

    #[test]
    fn dictation_clipboard_default_is_off_and_saved_values_survive() {
        // Default off so the guarded post-paste clipboard restore actually
        // runs; an existing settings file that turned it on must still load
        // as on.
        assert!(
            !Settings::default()
                .transcription
                .dictation_copy_to_clipboard
        );

        let parsed: TranscriptionSettings =
            serde_json::from_str(r#"{"dictationCopyToClipboard": true}"#)
                .expect("saved transcription settings should deserialize");
        assert!(parsed.dictation_copy_to_clipboard);
    }

    /// The picker used to offer `paste` and `inline` alongside `auto`, and all
    /// three took the same insert path. A settings file still carrying one of
    /// them has to load as the behavior it was actually getting.
    #[test]
    fn retired_insertion_modes_load_as_the_one_insert_behavior() {
        for saved in ["paste", "inline", "something_invented"] {
            let mut transcription = TranscriptionSettings {
                dictation_insertion_mode: saved.to_string(),
                ..Default::default()
            };
            normalize_loaded_transcription_settings(&mut transcription);
            assert_eq!(
                transcription.dictation_insertion_mode, "auto",
                "'{saved}' should migrate onto the insert path it already used"
            );
        }

        let mut clipboard_only = TranscriptionSettings {
            dictation_insertion_mode: "clipboard_only".to_string(),
            ..Default::default()
        };
        normalize_loaded_transcription_settings(&mut clipboard_only);
        assert_eq!(
            clipboard_only.dictation_insertion_mode, "clipboard_only",
            "the one mode that really differed must survive"
        );
    }

    /// Saved custom profiles carry their own insertion mode, and `get_settings`
    /// returns the loaded file verbatim. A profile left on a retired value
    /// reaches the renderer, which looks it up in a table that only has
    /// `auto`/`clipboard_only` and renders a chip reading "Result:" with
    /// nothing after it.
    #[test]
    fn retired_insertion_modes_migrate_inside_saved_custom_modes() {
        let mut transcription = TranscriptionSettings {
            dictation_custom_modes: vec![
                DictationCustomMode {
                    id: "sales".to_string(),
                    name: "Sales Follow-up".to_string(),
                    insertion_mode: "paste".to_string(),
                    ..Default::default()
                },
                DictationCustomMode {
                    id: "notes".to_string(),
                    name: "Notes".to_string(),
                    insertion_mode: "inline".to_string(),
                    ..Default::default()
                },
                DictationCustomMode {
                    id: "quiet".to_string(),
                    name: "Quiet".to_string(),
                    insertion_mode: "clipboard_only".to_string(),
                    ..Default::default()
                },
                DictationCustomMode {
                    id: "blank".to_string(),
                    name: "Blank".to_string(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        normalize_loaded_transcription_settings(&mut transcription);

        let modes = &transcription.dictation_custom_modes;
        assert_eq!(modes[0].insertion_mode, "auto");
        assert_eq!(modes[1].insertion_mode, "auto");
        assert_eq!(
            modes[2].insertion_mode, "clipboard_only",
            "the one mode that really differed must survive inside profiles too"
        );
        assert_eq!(
            modes[3].insertion_mode, "auto",
            "a profile written before the field existed has no value to keep"
        );
    }

    #[test]
    fn meeting_custom_templates_round_trip_through_load_normalization() {
        // A well-formed template, loaded from a settings.json that a previous
        // save already sanitized, must survive `get_settings` unchanged --
        // the same round-trip guarantee `dictation_custom_modes` gets.
        let mut transcription = TranscriptionSettings {
            meeting_custom_templates: vec![MeetingCustomTemplate {
                id: "custom-1".to_string(),
                name: "Board Update".to_string(),
                summary_prompt: "Summarize board sentiment, asks, and follow-ups.".to_string(),
                notes_outline: vec!["Sentiment".to_string(), "Asks".to_string()],
            }],
            ..Default::default()
        };

        normalize_loaded_transcription_settings(&mut transcription);

        assert_eq!(transcription.meeting_custom_templates.len(), 1);
        let template = &transcription.meeting_custom_templates[0];
        assert_eq!(template.id, "custom-1");
        assert_eq!(template.name, "Board Update");
        assert_eq!(
            template.summary_prompt,
            "Summarize board sentiment, asks, and follow-ups."
        );
        assert_eq!(template.notes_outline, vec!["Sentiment", "Asks"]);
    }

    #[test]
    fn meeting_custom_templates_drop_malformed_entries() {
        let sanitized = sanitize_meeting_custom_templates(vec![
            // No id: unresolvable by any picker or analysis lookup.
            MeetingCustomTemplate {
                id: String::new(),
                name: "No id".to_string(),
                ..Default::default()
            },
            // No name: nothing to show in a picker.
            MeetingCustomTemplate {
                id: "custom-blank-name".to_string(),
                name: "   ".to_string(),
                ..Default::default()
            },
            // Collides with a built-in id -- would shadow "standup" everywhere
            // templates are resolved by id.
            MeetingCustomTemplate {
                id: "standup".to_string(),
                name: "Impostor Standup".to_string(),
                ..Default::default()
            },
            // A genuinely valid entry, to prove the sweep is selective.
            MeetingCustomTemplate {
                id: "custom-valid".to_string(),
                name: "Valid Template".to_string(),
                summary_prompt: "Summarize this.".to_string(),
                notes_outline: vec!["Notes".to_string()],
            },
            // Duplicate id of the valid entry above: first occurrence wins.
            MeetingCustomTemplate {
                id: "custom-valid".to_string(),
                name: "Duplicate Id".to_string(),
                ..Default::default()
            },
        ]);

        assert_eq!(
            sanitized.len(),
            1,
            "only the one well-formed entry survives"
        );
        assert_eq!(sanitized[0].id, "custom-valid");
        assert_eq!(sanitized[0].name, "Valid Template");
    }

    #[test]
    fn meeting_custom_templates_cap_lengths_and_count() {
        let oversized_name = "n".repeat(500);
        let oversized_prompt = "p".repeat(10_000);
        let sanitized = sanitize_meeting_custom_templates(vec![MeetingCustomTemplate {
            id: "custom-oversized".to_string(),
            name: oversized_name.clone(),
            summary_prompt: oversized_prompt.clone(),
            notes_outline: (0..30)
                .map(|index| format!("Section {index}: {}", "x".repeat(200)))
                .collect(),
        }]);

        assert_eq!(sanitized.len(), 1);
        let template = &sanitized[0];
        assert!(template.name.len() <= MAX_MEETING_TEMPLATE_NAME_LEN);
        assert!(template.summary_prompt.len() <= MAX_MEETING_TEMPLATE_PROMPT_LEN);
        assert!(template.notes_outline.len() <= MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS);
        for section in &template.notes_outline {
            assert!(section.len() <= MAX_MEETING_TEMPLATE_OUTLINE_SECTION_LEN);
        }

        // Whole-list cap: a settings file with more templates than any user
        // plausibly created (a sync bug, a corrupted file) is truncated
        // rather than trusted wholesale.
        let too_many: Vec<MeetingCustomTemplate> = (0..(MAX_MEETING_CUSTOM_TEMPLATES + 10))
            .map(|index| MeetingCustomTemplate {
                id: format!("custom-{index}"),
                name: format!("Template {index}"),
                ..Default::default()
            })
            .collect();
        let sanitized = sanitize_meeting_custom_templates(too_many);
        assert_eq!(sanitized.len(), MAX_MEETING_CUSTOM_TEMPLATES);
    }

    #[test]
    fn meeting_custom_templates_cap_by_character_count_not_byte_length() {
        // Every character here is 3 bytes in UTF-8 ("日" U+65E5). The
        // renderer's editor enforces the same ceiling with a plain
        // `maxLength`, which counts characters (UTF-16 code units), not
        // bytes -- a byte-length cap here would truncate this name to far
        // fewer characters than the client already accepted as valid,
        // silently discarding content the user was told fit.
        let non_ascii_name: String = "日".repeat(100);
        assert_eq!(non_ascii_name.chars().count(), 100);
        assert_eq!(non_ascii_name.len(), 300, "sanity: 3 bytes per character");

        let sanitized = sanitize_meeting_custom_templates(vec![MeetingCustomTemplate {
            id: "custom-non-ascii".to_string(),
            name: non_ascii_name,
            summary_prompt: String::new(),
            notes_outline: Vec::new(),
        }]);

        assert_eq!(sanitized.len(), 1);
        assert_eq!(
            sanitized[0].name.chars().count(),
            MAX_MEETING_TEMPLATE_NAME_LEN,
            "capped by character count, matching the client's maxLength"
        );
    }

    #[test]
    fn dictation_active_languages_are_normalized() {
        let normalized = normalize_dictation_active_languages(
            "whisper",
            "large-v3",
            &[
                " EN ".to_string(),
                "es".to_string(),
                "ES".to_string(),
                "not-a-language".to_string(),
            ],
        );
        assert_eq!(normalized, vec!["en".to_string(), "es".to_string()]);
    }

    #[test]
    fn multilingual_whisper_accepts_languages_the_old_allowlist_dropped() {
        // The hardcoded twelve-language list silently discarded these, on a
        // model that transcribes every one of them.
        for language in ["pl", "tr", "uk", "vi", "th", "he", "cs", "ro", "id", "ms"] {
            let normalized = normalize_dictation_active_languages(
                "whisper",
                "large-v3",
                &[language.to_string()],
            );
            assert_eq!(
                normalized,
                vec![language.to_string()],
                "{language} must be accepted on multilingual Whisper"
            );
        }
    }

    #[test]
    fn whisper_language_coverage_matches_the_published_set() {
        // ~99 languages, not the curated display subset in the model picker.
        assert!(
            WHISPER_MULTILINGUAL_LANGUAGES.len() >= 98,
            "expected the full Whisper language set, got {}",
            WHISPER_MULTILINGUAL_LANGUAGES.len()
        );
        let mut sorted = WHISPER_MULTILINGUAL_LANGUAGES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            WHISPER_MULTILINGUAL_LANGUAGES.len(),
            "the Whisper language set must not contain duplicates"
        );
    }

    #[test]
    fn english_only_models_reject_other_languages() {
        // `.en` Whisper builds, Distil-Whisper, and Moonshine are single-language
        // by construction: accepting Spanish there would produce nonsense.
        for (provider, model) in [
            ("whisper", "base.en"),
            ("whisper", "small.en"),
            ("distil_whisper", "distil-large-v3.5"),
            ("moonshine", "moonshine-base"),
        ] {
            assert_eq!(
                dictation_supported_languages(provider, model),
                Some(ENGLISH_ONLY_LANGUAGES),
                "{provider}/{model} must be English-only"
            );
            let error = validate_dictation_active_languages(
                provider,
                model,
                &["en".to_string(), "es".to_string()],
            )
            .expect_err("an English-only model must refuse Spanish");
            assert!(error.contains("es"), "the error must name the language");
            assert!(error.contains(model), "the error must name the model");
        }
    }

    #[test]
    fn parakeet_v3_accepts_its_documented_european_set_only() {
        assert_eq!(
            dictation_supported_languages("parakeet", "parakeet-tdt-0.6b-v3"),
            Some(PARAKEET_V3_LANGUAGES)
        );
        // In its documented set...
        assert!(validate_dictation_active_languages(
            "parakeet",
            "parakeet-tdt-0.6b-v3",
            &["pl".to_string(), "sv".to_string(), "mt".to_string()],
        )
        .is_ok());
        // ...but Japanese is not, even though Whisper handles it.
        assert!(validate_dictation_active_languages(
            "parakeet",
            "parakeet-tdt-0.6b-v3",
            &["ja".to_string()],
        )
        .is_err());

        // The legacy Parakeet builds are English-only.
        assert_eq!(
            dictation_supported_languages("parakeet", "parakeet-tdt-ctc-110m"),
            Some(ENGLISH_ONLY_LANGUAGES)
        );
    }

    #[test]
    fn cloud_and_platform_routes_impose_no_local_language_list() {
        // Their language coverage is the service's or the OS's, and guessing at
        // it locally is how real languages got rejected before.
        for provider in ["openai_cloud", "groq", "elevenlabs_scribe", "apple_speech"] {
            assert!(dictation_supported_languages(provider, "any-model").is_none());
        }
        assert!(validate_dictation_active_languages(
            "elevenlabs_scribe",
            "scribe-v2",
            &["sw".to_string(), "yo".to_string()],
        )
        .is_ok());
    }

    #[test]
    fn saving_an_unsupported_language_explains_itself() {
        let error = validate_dictation_active_languages(
            "parakeet",
            "parakeet-tdt-0.6b-v3",
            &["en".to_string(), "ja".to_string(), "ko".to_string()],
        )
        .expect_err("unsupported languages must be refused, not dropped");

        assert!(error.contains("ja") && error.contains("ko"));
        assert!(
            error.contains("Choose a different model"),
            "the error must tell the user what to do: {error}"
        );
    }

    #[test]
    fn loading_settings_drops_rather_than_fails_on_a_model_switch() {
        // A saved file may legitimately name a language the *currently* selected
        // model cannot handle, because the user switched models afterwards.
        // Load must survive that; only save is strict.
        let normalized = normalize_dictation_active_languages(
            "parakeet",
            "parakeet-tdt-0.6b-v3",
            &["en".to_string(), "ja".to_string()],
        );
        assert_eq!(normalized, vec!["en".to_string()]);
    }

    #[test]
    fn malformed_language_tags_are_refused_on_save() {
        for bogus in ["e", "toolongtag", "en-US", "12", "EN!"] {
            assert!(
                validate_dictation_active_languages("whisper", "large-v3", &[bogus.to_string()])
                    .is_err(),
                "{bogus} must not be accepted as a language tag"
            );
        }
    }

    #[test]
    fn audio_input_preference_drops_invalid_values() {
        assert!(
            normalize_audio_input_device_preference(Some(AudioInputDevicePreference {
                device_id: " ".to_string(),
                device_name: "Built-in Microphone".to_string(),
                transport_type: Some("builtin".to_string()),
            }))
            .is_none()
        );
    }

    #[test]
    fn audio_input_preference_normalizes_transport_type() {
        let normalized =
            normalize_audio_input_device_preference(Some(AudioInputDevicePreference {
                device_id: "device-1".to_string(),
                device_name: "Built-in Microphone".to_string(),
                transport_type: Some(" BUILTIN ".to_string()),
            }))
            .expect("valid device preference");
        assert_eq!(normalized.transport_type.as_deref(), Some("builtin"));
    }

    #[test]
    fn dictation_category_formatting_defaults_are_stable() {
        let settings = Settings::default();
        assert!(settings.transcription.dictation_category_formatting_enabled);
        assert!(settings
            .transcription
            .dictation_app_category_overrides
            .is_empty());
    }

    #[test]
    fn dictation_app_category_override_deserializes_missing_fields() {
        let parsed: DictationAppCategoryOverride =
            serde_json::from_str("{}").expect("override should deserialize with defaults");
        assert_eq!(parsed.id, "");
        assert_eq!(parsed.app_matcher, "");
        assert_eq!(parsed.category, "");
        assert!(!parsed.enabled);
    }

    #[test]
    fn dictation_app_category_key_round_trips() {
        for category in [
            DictationAppCategory::Other,
            DictationAppCategory::Messaging,
            DictationAppCategory::Email,
            DictationAppCategory::Notes,
            DictationAppCategory::Worklog,
            DictationAppCategory::AiChat,
            DictationAppCategory::CodeEditor,
        ] {
            let key = dictation_app_category_to_key(category);
            assert_eq!(dictation_app_category_from_key(key), category);
        }
    }

    #[test]
    fn dictation_app_category_from_key_falls_back_to_other() {
        assert_eq!(
            dictation_app_category_from_key("not-a-real-category"),
            DictationAppCategory::Other
        );
        assert_eq!(
            dictation_app_category_from_key(""),
            DictationAppCategory::Other
        );
    }

    #[test]
    fn dictation_app_category_from_key_strict_rejects_unknown_keys() {
        use super::dictation_app_category_from_key_strict;

        assert_eq!(
            dictation_app_category_from_key_strict("other"),
            Some(DictationAppCategory::Other)
        );
        assert_eq!(
            dictation_app_category_from_key_strict(" AI_CHAT "),
            Some(DictationAppCategory::AiChat)
        );
        assert_eq!(dictation_app_category_from_key_strict("ai chat"), None);
        assert_eq!(dictation_app_category_from_key_strict("code-editor"), None);
        assert_eq!(dictation_app_category_from_key_strict(""), None);
    }

    #[test]
    fn resolve_with_overrides_falls_through_when_override_category_key_is_unknown() {
        // An enabled override that matches the app but carries an unknown
        // category key must behave as if no override matched — falling
        // through to the built-in classifier — instead of short-circuiting
        // with `Other`.
        let transcription = TranscriptionSettings {
            dictation_app_category_overrides: vec![DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "slack".to_string(),
                category: "not-a-real-category".to_string(),
                enabled: true,
            }],
            ..TranscriptionSettings::default()
        };

        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Slack"), None);
        assert_eq!(category, DictationAppCategory::Messaging);
    }

    #[test]
    fn resolve_with_overrides_and_hint_uses_browser_domain_hint() {
        use super::resolve_dictation_app_category_with_overrides_and_hint;

        let transcription = TranscriptionSettings::default();

        // Browser Gmail: the app name classifies as Other, but the
        // activation-matcher hint resolves to Email so all consumers
        // (dictionary scoping, local formatting, LLM prompt) agree.
        let category = resolve_dictation_app_category_with_overrides_and_hint(
            &transcription,
            Some("Google Chrome"),
            None,
            Some("mail.google.com"),
        );
        assert_eq!(category, DictationAppCategory::Email);

        // Overrides match against the hint too.
        let with_override = TranscriptionSettings {
            dictation_app_category_overrides: vec![DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "mail.google.com".to_string(),
                category: "notes".to_string(),
                enabled: true,
            }],
            ..TranscriptionSettings::default()
        };
        let category = resolve_dictation_app_category_with_overrides_and_hint(
            &with_override,
            Some("Google Chrome"),
            None,
            Some("mail.google.com"),
        );
        assert_eq!(category, DictationAppCategory::Notes);
    }

    #[test]
    fn resolve_with_overrides_ignores_ai_formatting_toggle() {
        let transcription = TranscriptionSettings {
            dictation_category_formatting_enabled: false,
            dictation_app_category_overrides: vec![DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "slack".to_string(),
                category: "messaging".to_string(),
                enabled: true,
            }],
            ..TranscriptionSettings::default()
        };

        // The AI-category-formatting toggle is a distinct setting from "what
        // category does this app resolve to" — the resolver must always
        // return the real resolved category (here, via the matching
        // override) regardless of whether that toggle is on or off. Gating
        // the LLM prompt fragment on this toggle happens at the
        // lib.rs call site, not inside the resolver itself.
        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Slack"), None);
        assert_eq!(category, DictationAppCategory::Messaging);
    }

    #[test]
    fn resolve_with_overrides_falls_through_to_builtin_classifier_when_ai_formatting_toggle_is_off()
    {
        let transcription = TranscriptionSettings {
            dictation_category_formatting_enabled: false,
            ..TranscriptionSettings::default()
        };

        // No overrides configured, and the toggle is off, but the resolver
        // should still fall through to the built-in bundle-id/name
        // classifier and return the real category (Slack -> Messaging), not
        // `Other`. This is the regression this decoupling fixes: dictionary/
        // snippet category-scope matching must work independently of the
        // AI-formatting toggle.
        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Slack"), None);
        assert_eq!(category, DictationAppCategory::Messaging);
    }

    #[test]
    fn resolve_with_overrides_matches_first_enabled_override_in_order() {
        let transcription = TranscriptionSettings {
            dictation_app_category_overrides: vec![
                DictationAppCategoryOverride {
                    id: "1".to_string(),
                    app_matcher: "notion".to_string(),
                    category: "worklog".to_string(),
                    enabled: true,
                },
                DictationAppCategoryOverride {
                    id: "2".to_string(),
                    app_matcher: "notion".to_string(),
                    category: "notes".to_string(),
                    enabled: true,
                },
            ],
            ..TranscriptionSettings::default()
        };

        // First matching enabled override wins, even though the built-in
        // classifier and a later override would both say Notes.
        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Notion"), None);
        assert_eq!(category, DictationAppCategory::Worklog);
    }

    #[test]
    fn resolve_with_overrides_skips_disabled_overrides() {
        let transcription = TranscriptionSettings {
            dictation_app_category_overrides: vec![
                DictationAppCategoryOverride {
                    id: "1".to_string(),
                    app_matcher: "notion".to_string(),
                    category: "worklog".to_string(),
                    enabled: false,
                },
                DictationAppCategoryOverride {
                    id: "2".to_string(),
                    app_matcher: "notion".to_string(),
                    category: "email".to_string(),
                    enabled: true,
                },
            ],
            ..TranscriptionSettings::default()
        };

        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Notion"), None);
        assert_eq!(category, DictationAppCategory::Email);
    }

    #[test]
    fn resolve_with_overrides_falls_through_to_builtin_classifier_when_no_override_matches() {
        let transcription = TranscriptionSettings {
            dictation_app_category_overrides: vec![DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "salesforce".to_string(),
                category: "worklog".to_string(),
                enabled: true,
            }],
            ..TranscriptionSettings::default()
        };

        // "Slack" doesn't match the "salesforce" override, so this should fall
        // through to the built-in name classifier, which maps Slack to
        // Messaging.
        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Slack"), None);
        assert_eq!(category, DictationAppCategory::Messaging);
    }

    #[test]
    fn dictation_app_category_override_blank_matcher_never_matches() {
        let transcription = TranscriptionSettings {
            dictation_app_category_overrides: vec![DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "   ".to_string(),
                category: "messaging".to_string(),
                enabled: true,
            }],
            ..TranscriptionSettings::default()
        };

        // A blank matcher must not swallow every app; falls through to the
        // built-in classifier (Gmail -> Email).
        let category =
            resolve_dictation_app_category_with_overrides(&transcription, Some("Gmail"), None);
        assert_eq!(category, DictationAppCategory::Email);
    }
}
