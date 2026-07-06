//! Settings and user preferences persistence
//!
//! Manages user configuration including:
//! - Audio settings (sample rate, channels, etc.)
//! - Transcription preferences
//! - UI settings
//! - Keyboard shortcuts
//! - Export templates

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
    /// Export configuration
    pub export: ExportSettings,
    /// Privacy and security
    pub privacy: PrivacySettings,
    /// Keyboard shortcuts
    pub shortcuts: KeyboardShortcuts,
    /// Update preferences
    pub updates: UpdateSettings,
    /// Selected export template
    pub default_template: String,
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
            default_template: "meeting".to_string(),
            theme: "system".to_string(),
        }
    }
}

/// Audio recording settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSettings {
    /// Sample rate (Hz)
    pub sample_rate: u32,
    /// Number of channels (1=mono, 2=stereo)
    pub channels: u16,
    /// Enable system audio capture
    pub capture_system_audio: bool,
    /// Enable microphone capture
    pub capture_microphone: bool,
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
    /// Enable noise suppression
    pub noise_suppression: bool,
    /// Enable VAD (auto-stop on silence)
    pub voice_activity_detection: bool,
    /// Silence threshold (seconds before auto-stop)
    pub silence_timeout_seconds: f32,
    /// Auto-gain control
    pub auto_gain_control: bool,
    /// Manual gain (dB) when auto-gain is off (-20 to +20)
    pub manual_gain_db: f32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            channels: 1,
            capture_system_audio: true,
            capture_microphone: true,
            preferred_input_device: None,
            dictation_input_override_enabled: false,
            dictation_input_device: None,
            meeting_input_override_enabled: false,
            meeting_input_device: None,
            noise_suppression: true,
            voice_activity_detection: true,
            silence_timeout_seconds: 300.0,
            auto_gain_control: true,
            manual_gain_db: 0.0,
        }
    }
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
    /// Auto-transcribe after recording
    pub auto_transcribe: bool,
    /// Enable speaker diarization
    pub enable_diarization: bool,
    /// Enable intelligent punctuation
    pub intelligent_punctuation: bool,
    /// Language (auto-detect if None)
    pub language: Option<String>,
    /// Number of speakers (0 = auto-detect)
    pub num_speakers: usize,
    /// Speaker naming method: auto (infer from speech), numbered, manual
    pub speaker_naming_method: String,
    /// Selected diarization model id
    pub diarization_model_id: String,
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
    /// Dictation: keep the current route warm between captures.
    pub dictation_keep_warm: String,
    /// Dictation: show live partial text in popup/inline surfaces.
    pub dictation_live_preview_enabled: bool,
    /// Dictation: Smart Format, LLM polishes text before insert
    pub dictation_ai_formatting: bool,
    /// Dictation mode preset: voice, messages, email, notes, translate_english, meeting_follow_up, custom
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
    /// Dictation insertion mode: auto, paste, clipboard_only
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
    /// Save raw transcript without formatting
    pub save_raw_transcript: bool,
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
            auto_transcribe: true,
            enable_diarization: true,
            intelligent_punctuation: true,
            language: None,
            num_speakers: 0,
            speaker_naming_method: "auto".to_string(),
            diarization_model_id: "ecapa_tdnn_speaker".to_string(),
            silence_skip_enabled: false,
            dictation_copy_to_clipboard: true,
            dictation_auto_request_permissions: true,
            // Toggle mode is safer for new users and avoids silent hold-to-talk confusion.
            dictation_push_to_talk: false,
            dictation_hands_free_enabled: false,
            dictation_route_preference: "local".to_string(),
            dictation_route_override_enabled: true,
            dictation_keep_warm: "short".to_string(),
            dictation_live_preview_enabled: true,
            dictation_ai_formatting: false,
            dictation_mode_preset: "voice".to_string(),
            dictation_selected_custom_mode_id: None,
            dictation_custom_modes: Vec::new(),
            dictation_context_source: "none".to_string(),
            dictation_command_mode_enabled: true,
            dictation_command_prefix: "command".to_string(),
            dictation_insertion_mode: "paste".to_string(),
            dictation_active_languages: Vec::new(),
            dictation_snippets_enabled: true,
            dictation_auto_learn_corrections: true,
            dictation_custom_prompt: None,
            meeting_custom_prompt: None,
            meeting_auto_name_enabled: true,
            meeting_auto_name_model: None,
            save_raw_transcript: false,
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
    /// Window position (x, y)
    pub window_position: Option<(i32, i32)>,
    /// Window size (width, height)
    pub window_size: Option<(u32, u32)>,
    /// Font size
    pub font_size: u32,
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
            window_position: None,
            window_size: None,
            font_size: 14,
            show_dictation_popup: true,
            show_recording_popup: true,
            color_scheme: "default".to_string(),
        }
    }
}

/// Export settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportSettings {
    /// Default export format
    pub default_format: String,
    /// Auto-export after transcription
    pub auto_export: bool,
    /// Export directory
    pub export_directory: Option<PathBuf>,
    /// Include timestamps
    pub include_timestamps: bool,
    /// Include speaker labels
    pub include_speakers: bool,
    /// Open after export
    pub open_after_export: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            default_format: "markdown".to_string(),
            auto_export: false,
            export_directory: None,
            include_timestamps: true,
            include_speakers: true,
            open_after_export: false,
        }
    }
}

/// Privacy settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    /// Encrypt recordings at rest
    pub encrypt_recordings: bool,
    /// Auto-delete after days (0 = never)
    pub auto_delete_days: u32,
    /// Require password for access
    pub require_password: bool,
    /// Enable audit logging
    pub audit_logging: bool,
    /// Cloud sync enabled
    pub cloud_sync: bool,
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
            encrypt_recordings: false,
            auto_delete_days: 0,
            require_password: false,
            audit_logging: true,
            cloud_sync: false,
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
    /// Toggle recording
    pub toggle_recording: String,
    /// Toggle dictation mode
    pub toggle_dictation: String,
    /// Additional dictation bindings for platform parity (macOS command key, etc.)
    pub toggle_dictation_alternates: Vec<String>,
    /// Open main window
    pub open_window: String,
    /// Quick export
    pub quick_export: String,
    /// Focus search
    pub focus_search: String,
}

impl Default for KeyboardShortcuts {
    fn default() -> Self {
        Self {
            toggle_recording: "Ctrl+Shift+R".to_string(),
            toggle_dictation: default_dictation_shortcut().to_string(),
            toggle_dictation_alternates: Vec::new(),
            open_window: "Ctrl+Shift+N".to_string(),
            quick_export: "Ctrl+Shift+E".to_string(),
            focus_search: "Ctrl+Shift+F".to_string(),
        }
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

fn normalize_dictation_keep_warm(value: &str) -> String {
    match value.trim() {
        "off" => "off".to_string(),
        "long" => "long".to_string(),
        _ => "short".to_string(),
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

    // Migrate legacy Notes preset behavior away from inline insertion.
    if transcription.dictation_mode_preset == "notes"
        && transcription.dictation_insertion_mode == "inline"
        && transcription.dictation_selected_custom_mode_id.is_none()
    {
        transcription.dictation_insertion_mode = "paste".to_string();
    }

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

/// Parses a category key back into a `DictationAppCategory`. Unknown/blank
/// values fall back to `Other` (i.e. behave as if no override matched).
pub fn dictation_app_category_from_key(key: &str) -> DictationAppCategory {
    match key.trim().to_ascii_lowercase().as_str() {
        "messaging" => DictationAppCategory::Messaging,
        "email" => DictationAppCategory::Email,
        "notes" => DictationAppCategory::Notes,
        "worklog" => DictationAppCategory::Worklog,
        "ai_chat" => DictationAppCategory::AiChat,
        "code_editor" => DictationAppCategory::CodeEditor,
        _ => DictationAppCategory::Other,
    }
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
    for override_entry in &transcription.dictation_app_category_overrides {
        if !override_entry.enabled {
            continue;
        }
        if dictation_app_category_override_matches(&override_entry.app_matcher, app_target) {
            return dictation_app_category_from_key(&override_entry.category);
        }
    }

    format::resolve_dictation_app_category(app_target, app_bundle_id)
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
        let mut settings = if config_path.exists() {
            match Self::load_from_file(&config_path) {
                Ok(settings) => settings,
                Err(err) => {
                    // A corrupt or truncated settings file must never block startup.
                    // Move it aside for diagnostics and fall back to defaults.
                    tracing::warn!(
                        "Settings file at {} is unreadable ({}); backing it up and using defaults",
                        config_path.display(),
                        err
                    );
                    let backup_path = config_path.with_extension("json.corrupt");
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

        Ok(Self {
            settings,
            config_path,
        })
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
        std::fs::write(&tmp_path, json).context("Failed to write temp settings file")?;
        std::fs::rename(&tmp_path, &self.config_path).context("Failed to commit settings file")?;

        Ok(())
    }

    /// Reset to defaults
    pub fn reset(&mut self) {
        self.settings = Settings::default();
    }

    /// Load settings from file
    fn load_from_file(path: &PathBuf) -> Result<Settings> {
        let json = std::fs::read_to_string(path).context("Failed to read settings file")?;

        let settings: Settings =
            serde_json::from_str(&json).context("Failed to parse settings file")?;

        Ok(settings)
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
        resolve_dictation_app_category_with_overrides, AudioInputDevicePreference,
        DictationAppCategoryOverride, PlatformOptimizationSettings, Settings,
        TranscriptionSettings,
    };
    use crate::text::format::DictationAppCategory;

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
        assert_eq!(settings.transcription.dictation_insertion_mode, "paste");
        assert!(settings.transcription.dictation_snippets_enabled);
        assert!(settings.transcription.dictation_auto_learn_corrections);
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
