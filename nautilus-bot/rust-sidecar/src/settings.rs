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
    let config_dir = dirs::config_dir()
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
            theme: "system".to_string(),
        }
    }
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
    /// Language (auto-detect if None)
    pub language: Option<String>,
    /// Skip silence segments during transcription (Pro/Friends Club feature)
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
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            // Default to whisper.cpp (Metal/CoreML-accelerated on Apple Silicon)
            // with the small, fast base.en model. The previous default routed
            // through a 756M Candle model on CPU in F32 — multi-second latency
            // on the dictation hot path. whisper.cpp base.en is the fast,
            // production-quality default; larger/multilingual models are one
            // setting away.
            default_provider: "whisper".to_string(),
            selected_model_id: "base.en".to_string(),
            use_shared_asr_selection: true,
            dictation_provider: "whisper".to_string(),
            dictation_model_id: "base.en".to_string(),
            meeting_provider: "whisper".to_string(),
            meeting_model_id: "base.en".to_string(),
            meeting_route_policy: "prefer_local".to_string(),
            provider_model_ids: HashMap::new(),
            mlx_accelerated_providers: Vec::new(),
            dictation_mlx_enabled: false,
            meeting_mlx_enabled: false,
            enable_diarization: true,
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

/// Privacy settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    /// Allow remote provider processing (local-first default)
    pub remote_processing_enabled: bool,
    /// Default analysis LLM provider
    pub llm_provider: String,
    /// Default LLM model ID (provider-specific)
    pub llm_model_id: Option<String>,
    /// Optional absolute export root constraint
    pub export_root: Option<PathBuf>,
    /// Whether vault migration has completed
    pub vault_initialized: bool,
    /// Salt used to derive recording-encryption key material
    pub vault_salt: Option<String>,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            remote_processing_enabled: false,
            llm_provider: "ollama".to_string(),
            llm_model_id: None,
            export_root: None,
            vault_initialized: false,
            vault_salt: None,
        }
    }
}

/// Keyboard shortcuts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcuts {
    /// Toggle dictation mode
    pub toggle_dictation: String,
    /// Additional dictation bindings for platform parity (macOS command key, etc.)
    pub toggle_dictation_alternates: Vec<String>,
    /// Open main window
    pub open_window: String,
    /// Re-insert the last dictation result at the cursor. The recovery path
    /// when an insertion landed in the wrong app or silently failed. Empty
    /// means unbound.
    pub repaste_last_dictation: String,
    /// Copy the last dictation result to the clipboard again. Empty means
    /// unbound.
    pub recopy_last_dictation: String,
}

impl Default for KeyboardShortcuts {
    fn default() -> Self {
        Self {
            toggle_dictation: default_dictation_shortcut().to_string(),
            toggle_dictation_alternates: Vec::new(),
            open_window: "Ctrl+Shift+N".to_string(),
            repaste_last_dictation: default_repaste_shortcut().to_string(),
            recopy_last_dictation: default_recopy_shortcut().to_string(),
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

fn normalize_keyboard_shortcuts(shortcuts: &mut KeyboardShortcuts) {
    if shortcuts.toggle_dictation.trim().is_empty() {
        shortcuts.toggle_dictation = default_dictation_shortcut().to_string();
    }

    #[cfg(target_os = "macos")]
    {
        let has_cmd_alternate = shortcuts
            .toggle_dictation_alternates
            .iter()
            .any(|value| value.eq_ignore_ascii_case("Cmd+Shift+Space"));
        if shortcuts
            .toggle_dictation
            .eq_ignore_ascii_case("Ctrl+Shift+Space")
            && has_cmd_alternate
        {
            shortcuts.toggle_dictation = "Cmd+Shift+Space".to_string();
        }
    }

    // New policy: one shortcut per action. Keep legacy field for compatibility,
    // but clear persisted alternates during load/migration.
    shortcuts.toggle_dictation_alternates.clear();
}

fn normalize_transcription_provider_value(provider: &str) -> String {
    match provider.trim() {
        "canary" => "whisper_candle".to_string(),
        "whisper_candle" => "whisper_candle".to_string(),
        "whisper" => "whisper".to_string(),
        "parakeet" => "parakeet".to_string(),
        "distil_whisper" => "distil_whisper".to_string(),
        "mlx_audio" => "mlx_audio".to_string(),
        "macos_apple_speech" => "macos_apple_speech".to_string(),
        "moonshine" => "moonshine".to_string(),
        "voxtral" => "voxtral".to_string(),
        "windows_sdk_dictation" => "windows_sdk_dictation".to_string(),
        "elevenlabs_scribe" => "elevenlabs_scribe".to_string(),
        "openai_cloud" => "openai_cloud".to_string(),
        "groq" => "groq".to_string(),
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
            "parakeet-ctc-0.6b" => "parakeet-ctc-0.6b".to_string(),
            "parakeet-ctc-1.1b" => "parakeet-ctc-1.1b".to_string(),
            "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => "parakeet-tdt-ctc-110m".to_string(),
            _ => "parakeet-tdt-0.6b-v3".to_string(),
        },
        "whisper_candle" => "whisper-large-v3-turbo".to_string(),
        "distil_whisper" => "distil-large-v3.5".to_string(),
        "mlx_audio" => model_id.trim().to_string(),
        "macos_apple_speech" => "macos_apple_speech".to_string(),
        "moonshine" => match model_id.trim() {
            "moonshine" | "moonshine-base" => "moonshine-base".to_string(),
            "moonshine-tiny" => "moonshine-tiny".to_string(),
            _ => "moonshine-base".to_string(),
        },
        "voxtral" => match model_id.trim() {
            "voxtral-cloud" => "voxtral-cloud".to_string(),
            _ => "voxtral-local".to_string(),
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
            "" => "whisper-1".to_string(),
            value => value.to_string(),
        },
        "groq" => match model_id.trim() {
            "" => "whisper-large-v3-turbo".to_string(),
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

fn normalize_dictation_active_languages(languages: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for language in languages {
        let trimmed = language.trim().to_ascii_lowercase();
        let canonical = match trimmed.as_str() {
            "en" | "es" | "fr" | "de" | "it" | "pt" | "ja" | "ko" | "zh" | "ru" | "ar" | "hi" => {
                Some(trimmed)
            }
            _ => None,
        };
        if let Some(language) = canonical {
            if !normalized.contains(&language) {
                normalized.push(language);
            }
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
    transcription.dictation_active_languages =
        normalize_dictation_active_languages(&transcription.dictation_active_languages);

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
}

fn normalize_loaded_privacy_settings(privacy: &mut PrivacySettings) {
    // Normalize LLM provider to ensure it's a valid value
    privacy.llm_provider = privacy.llm_provider.trim().to_lowercase();
    if privacy.llm_provider.is_empty() {
        privacy.llm_provider = "ollama".to_string();
    }

    // Normalize model ID if present
    if let Some(model_id) = privacy.llm_model_id.as_mut() {
        *model_id = model_id.trim().to_string();
        if model_id.is_empty() {
            privacy.llm_model_id = None;
        }
    }
}

/// Update channel (stable or beta)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable releases for all entitled users
    #[default]
    Stable,
    /// Beta releases for Friends Club tier only
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

/// Settings keys that were removed from the schema because they had no
/// runtime reader (placebo settings). Serde already ignores unknown keys on
/// load; this list drives the load-time migration that rewrites
/// settings.json without them so stale keys don't linger on disk implying
/// behavior that doesn't exist. Paths are `(section, camelCase key)`; an
/// empty section means a top-level key.
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
    ("transcription", "diarizationModelId"),
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
    ("shortcuts", "toggleRecording"),
    ("shortcuts", "quickExport"),
    ("shortcuts", "focusSearch"),
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

/// Settings manager
pub struct SettingsManager {
    settings: Settings,
    config_path: PathBuf,
}

impl SettingsManager {
    /// Create new settings manager
    pub fn new() -> Result<Self> {
        let config_path = Self::config_path()?;
        let mut needs_migration_rewrite = false;
        let mut settings = if config_path.exists() {
            match Self::load_from_file(&config_path) {
                Ok((settings, raw)) => {
                    needs_migration_rewrite = raw_settings_contain_removed_keys(&raw);
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
        normalize_audio_input_device_preference, normalize_dictation_active_languages,
        normalize_loaded_transcription_settings, resolve_dictation_app_category_with_overrides,
        AudioInputDevicePreference, DictationAppCategoryOverride, DictationCustomMode,
        PlatformOptimizationSettings, Settings, TranscriptionSettings,
    };
    use crate::text::format::DictationAppCategory;

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
        assert_eq!(settings.transcription.dictation_provider, "whisper");
        assert_eq!(settings.transcription.meeting_provider, "whisper");
        assert!(settings.transcription.dictation_command_mode_enabled);
        assert_eq!(settings.transcription.dictation_command_prefix, "command");
        assert_eq!(settings.transcription.dictation_insertion_mode, "auto");
        assert!(settings.transcription.dictation_snippets_enabled);
        assert!(settings.transcription.dictation_auto_learn_corrections);
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
    fn dictation_active_languages_are_normalized() {
        let normalized = normalize_dictation_active_languages(&[
            " EN ".to_string(),
            "es".to_string(),
            "ES".to_string(),
            "bogus".to_string(),
        ]);
        assert_eq!(normalized, vec!["en".to_string(), "es".to_string()]);
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
