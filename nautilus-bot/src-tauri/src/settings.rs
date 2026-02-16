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
use std::path::PathBuf;

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
    /// Enable noise suppression
    pub noise_suppression: bool,
    /// Enable VAD (auto-stop on silence)
    pub voice_activity_detection: bool,
    /// Silence threshold (seconds before auto-stop)
    pub silence_timeout_seconds: f32,
    /// Auto-gain control
    pub auto_gain_control: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            channels: 1,
            capture_system_audio: true,
            capture_microphone: true,
            noise_suppression: true,
            voice_activity_detection: true,
            silence_timeout_seconds: 3.0,
            auto_gain_control: true,
        }
    }
}

/// Transcription settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TranscriptionSettings {
    /// Default ASR provider
    pub default_provider: String,
    /// Selected model identifier for local model backends
    pub selected_model_id: String,
    /// If true, fallback to Whisper when selected provider fails
    pub allow_whisper_fallback: bool,
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
    /// Save raw transcript without formatting
    pub save_raw_transcript: bool,
    /// Persist dictation outputs into project storage.
    pub dictation_save_to_inbox: bool,
    /// Dictation profile preference: speed or accuracy.
    pub dictation_profile: String,
    /// Target project for saved dictations.
    pub dictation_project_id: String,
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            default_provider: "whisper".to_string(),
            selected_model_id: "base.en".to_string(),
            allow_whisper_fallback: false,
            auto_transcribe: true,
            enable_diarization: true,
            intelligent_punctuation: true,
            language: None,
            num_speakers: 0,
            save_raw_transcript: false,
            dictation_save_to_inbox: true,
            dictation_profile: "speed".to_string(),
            dictation_project_id: "inbox".to_string(),
        }
    }
}

/// UI settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiSettings {
    /// Always on top
    pub always_on_top: bool,
    /// Show in dock/menu bar
    pub show_in_dock: bool,
    /// Minimize to tray on close
    pub minimize_to_tray: bool,
    /// Start minimized
    pub start_minimized: bool,
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
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            always_on_top: false,
            show_in_dock: true,
            minimize_to_tray: true,
            start_minimized: false,
            window_position: None,
            window_size: None,
            font_size: 14,
            show_dictation_popup: true,
            show_recording_popup: true,
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
            toggle_dictation: "Ctrl+Shift+Space".to_string(),
            toggle_dictation_alternates: default_dictation_alternate_shortcuts(),
            open_window: "Ctrl+Shift+N".to_string(),
            quick_export: "Ctrl+Shift+E".to_string(),
            focus_search: "Ctrl+Shift+F".to_string(),
        }
    }
}

fn default_dictation_alternate_shortcuts() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec!["Cmd+Shift+Space".to_string()]
    }

    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
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
        let settings = if config_path.exists() {
            Self::load_from_file(&config_path)?
        } else {
            Settings::default()
        };

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

    /// Save settings to disk
    pub fn save(&self) -> Result<()> {
        let json =
            serde_json::to_string_pretty(&self.settings).context("Failed to serialize settings")?;

        std::fs::write(&self.config_path, json).context("Failed to write settings file")?;

        Ok(())
    }

    /// Reset to defaults
    #[allow(dead_code)]
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
        let config_dir = dirs::config_dir()
            .context("Could not find config directory")?
            .join("Nautilus");

        std::fs::create_dir_all(&config_dir)?;

        Ok(config_dir.join("settings.json"))
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
