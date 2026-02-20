pub mod asr;
mod audio;
mod backup;
mod crypto;
mod db;
mod diarization;
mod download;
mod export;
mod integrations;
mod license;
mod llm;
mod models;
mod performance;
mod secrets;
mod settings;
mod streaming;
mod text;
mod transcription;
pub mod update;

use anyhow::Result;
use rand::RngCore;
use regex::Regex;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;

pub struct AppState {
    db: Arc<Mutex<db::Database>>,
    audio_capture: Arc<Mutex<audio::AudioCapture>>,
    asr_manager: Arc<asr::AsrManager>,
    ollama_client: Arc<llm::OllamaClient>,
    ollama_embedder: Arc<llm::OllamaEmbedder>,
    #[allow(dead_code)]
    integration_manager: Arc<integrations::IntegrationManager>,
    settings_manager: Arc<Mutex<settings::SettingsManager>>,
    backup_manager: Arc<Mutex<backup::BackupManager>>,
    template_manager: Arc<export::templates::TemplateManager>,
    dictation_hotkey_active: Arc<Mutex<bool>>,
    dictation_release_pending: Arc<AtomicBool>,
    dictation_watchdog_generation: Arc<Mutex<u64>>,
    dictation_session_tracker: Arc<Mutex<DictationSessionTracker>>,
    dictation_runtime_state: Arc<Mutex<DictationSessionState>>,
    dictation_start_options: Arc<Mutex<models::DictationStartOptions>>,
    dictation_overlay_state: Arc<StdMutex<DictationOverlayState>>,
    recording_overlay_state: Arc<StdMutex<RecordingOverlayState>>,
    streaming_transcriber: Arc<streaming::StreamingTranscriber>,
    vault_state: Arc<Mutex<VaultRuntimeState>>,
}

const DICTATION_OVERLAY_LABEL: &str = "dictation-overlay";
const RECORDING_OVERLAY_LABEL: &str = "recording-overlay";
const RECORDING_TRAY_ID: &str = "recording-indicator";
const DICTATION_MAX_DURATION_SECONDS: u64 = 120;
const STREAMING_PREVIEW_MAX_SECONDS: f64 = 90.0;
const VAULT_DB_KEY_SECRET: &str = "vault_db_key";
const VAULT_UNLOCK_CHECK_SECRET: &str = "vault_unlock_check";
const VAULT_RECORDING_KEY_SALT_LEN: usize = 16;
const VAULT_UNLOCK_CHECK_PLAINTEXT: &[u8] = b"nautilus-vault-check";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationSessionState {
    Idle,
    Recording,
    Stopping,
    Transcribing,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, Default)]
struct DictationSessionTracker {
    next_session_id: u64,
    active_session_id: Option<u64>,
    started_at: Option<std::time::Instant>,
}

#[derive(Debug, Clone)]
struct AnalysisContextSegment {
    recording_id: String,
    recording_title: String,
    segment_id: String,
    text: String,
    start_time: f64,
    end_time: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationOverlayState {
    phase: String,
    started_at_ms: Option<i64>,
    message: Option<String>,
    preview: Option<String>,
    session_id: Option<u64>,
    stop_reason: Option<String>,
    outcome: Option<String>,
}

impl Default for DictationOverlayState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            started_at_ms: None,
            message: None,
            preview: None,
            session_id: None,
            stop_reason: None,
            outcome: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingOverlayState {
    phase: String,
    recording_id: Option<String>,
    started_at_ms: Option<i64>,
    system_audio_active: Option<bool>,
    message: Option<String>,
}

impl Default for RecordingOverlayState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            recording_id: None,
            started_at_ms: None,
            system_audio_active: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionDiagnostics {
    microphone_ready: bool,
    accessibility_ready: bool,
    automation_ready: bool,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisProvider {
    Ollama,
    OpenAi,
    Anthropic,
    Gemini,
    DeepSeek,
    OllamaCloud,
}

impl AnalysisProvider {
    fn from_settings_value(value: &str) -> Self {
        match value {
            "openai" => Self::OpenAi,
            "anthropic" => Self::Anthropic,
            "gemini" => Self::Gemini,
            "deepseek" => Self::DeepSeek,
            "ollama-cloud" => Self::OllamaCloud,
            _ => Self::Ollama,
        }
    }

    fn as_settings_value(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::DeepSeek => "deepseek",
            Self::OllamaCloud => "ollama-cloud",
        }
    }

    fn is_remote(self) -> bool {
        !matches!(self, Self::Ollama)
    }

    fn provider_secret_name(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("openai"),
            Self::Anthropic => Some("anthropic"),
            Self::Gemini => Some("gemini"),
            Self::DeepSeek => Some("deepseek"),
            Self::OllamaCloud => Some("ollama-cloud"),
            Self::Ollama => None,
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Ollama => "llama3.2",
            Self::OpenAi => "gpt-4o-mini",
            Self::Anthropic => "claude-sonnet-4-20250514",
            Self::Gemini => "gemini-2.0-flash",
            Self::DeepSeek => "deepseek-chat",
            Self::OllamaCloud => "llama3.2",
        }
    }
}

#[derive(Debug, Default)]
struct VaultRuntimeState {
    unlocked: bool,
    db_encrypted: bool,
    recording_key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityStatus {
    vault_initialized: bool,
    vault_unlocked: bool,
    database_encrypted: bool,
    recordings_encrypted: bool,
    llm_provider: String,
    remote_processing_enabled: bool,
    export_root: Option<String>,
}

#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutAction {
    ToggleRecording,
    ToggleDictation,
    OpenWindow,
    QuickExport,
    FocusSearch,
    EmergencyStopDictation,
}

#[cfg(desktop)]
#[derive(Clone)]
struct ShortcutBinding {
    action: ShortcutAction,
    shortcut: tauri_plugin_global_shortcut::Shortcut,
}

#[cfg(desktop)]
fn canonicalize_shortcut_value(value: &str) -> Result<String, String> {
    let mut has_cmd = false;
    let mut has_ctrl = false;
    let mut has_alt = false;
    let mut has_shift = false;
    let mut key: Option<String> = None;

    for token in value
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        let normalized = token.to_ascii_uppercase();
        match normalized.as_str() {
            "CMD" | "COMMAND" | "SUPER" | "META" => has_cmd = true,
            "CTRL" | "CONTROL" => has_ctrl = true,
            "ALT" | "OPTION" => has_alt = true,
            "SHIFT" => has_shift = true,
            _ => {
                if key.is_some() {
                    return Err(format!(
                        "Shortcut '{}' must contain exactly one non-modifier key",
                        value
                    ));
                }

                let normalized_key = match normalized.as_str() {
                    "ESC" => "Escape".to_string(),
                    "RETURN" => "Enter".to_string(),
                    "SPACEBAR" => "Space".to_string(),
                    _ if normalized.len() == 1 => normalized.to_string(),
                    _ => {
                        let lower = normalized.to_ascii_lowercase();
                        let mut chars = lower.chars();
                        if let Some(first) = chars.next() {
                            let mut titled = String::new();
                            titled.push(first.to_ascii_uppercase());
                            titled.push_str(chars.as_str());
                            titled
                        } else {
                            normalized
                        }
                    }
                };

                key = Some(normalized_key);
            }
        }
    }

    if !(has_cmd || has_ctrl || has_alt || has_shift) {
        return Err(format!(
            "Shortcut '{}' must include at least one modifier key",
            value
        ));
    }

    let key = key.ok_or_else(|| format!("Shortcut '{}' must include a key", value))?;
    let mut parts = Vec::new();
    if has_cmd {
        parts.push("Cmd");
    }
    if has_ctrl {
        parts.push("Ctrl");
    }
    if has_alt {
        parts.push("Alt");
    }
    if has_shift {
        parts.push("Shift");
    }
    parts.push(key.as_str());
    Ok(parts.join("+"))
}

#[cfg(desktop)]
fn parse_shortcut_value(value: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    let canonical = canonicalize_shortcut_value(value)?;
    canonical
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| format!("Unsupported shortcut '{}'", value))
}

#[cfg(desktop)]
fn shortcut_bindings_from_settings(
    shortcuts: &settings::KeyboardShortcuts,
) -> Result<Vec<ShortcutBinding>, String> {
    let mut bindings = Vec::new();
    let mut seen = std::collections::HashMap::<String, &'static str>::new();

    let configured = [
        (
            ShortcutAction::ToggleRecording,
            "toggle recording",
            shortcuts.toggle_recording.as_str(),
        ),
        (
            ShortcutAction::ToggleDictation,
            "toggle dictation",
            shortcuts.toggle_dictation.as_str(),
        ),
        (
            ShortcutAction::OpenWindow,
            "open window",
            shortcuts.open_window.as_str(),
        ),
        (
            ShortcutAction::QuickExport,
            "quick export",
            shortcuts.quick_export.as_str(),
        ),
        (
            ShortcutAction::FocusSearch,
            "focus search",
            shortcuts.focus_search.as_str(),
        ),
    ];

    for (action, action_label, value) in configured {
        let canonical = canonicalize_shortcut_value(value)
            .map_err(|error| format!("Invalid {} shortcut: {}", action_label, error))?;
        if let Some(conflict) = seen.insert(canonical.clone(), action_label) {
            return Err(format!(
                "Shortcut conflict: '{}' is assigned to both '{}' and '{}'",
                canonical, conflict, action_label
            ));
        }
        let shortcut = parse_shortcut_value(&canonical)?;
        bindings.push(ShortcutBinding { action, shortcut });
    }

    let emergency_canonical = canonicalize_shortcut_value("Ctrl+Shift+Escape")?;
    if let Some(conflict) = seen.get(emergency_canonical.as_str()) {
        return Err(format!(
            "Shortcut conflict: emergency stop uses '{}' which is already assigned to '{}'",
            emergency_canonical, conflict
        ));
    }
    bindings.push(ShortcutBinding {
        action: ShortcutAction::EmergencyStopDictation,
        shortcut: parse_shortcut_value(emergency_canonical.as_str())?,
    });

    Ok(bindings)
}

#[cfg(desktop)]
fn validate_shortcut_settings(shortcuts: &settings::KeyboardShortcuts) -> Result<(), String> {
    shortcut_bindings_from_settings(shortcuts).map(|_| ())
}

#[cfg(not(desktop))]
fn validate_shortcut_settings(_shortcuts: &settings::KeyboardShortcuts) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn check_system_audio_availability(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let audio = state.audio_capture.lock().await;
    Ok(audio.is_system_audio_available())
}

#[tauri::command]
async fn get_loopback_device_name(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let audio = state.audio_capture.lock().await;
    Ok(audio.get_loopback_device_name())
}

#[tauri::command]
async fn get_permission_diagnostics(
    state: tauri::State<'_, AppState>,
) -> Result<PermissionDiagnostics, String> {
    let microphone_ready = {
        let audio = state.audio_capture.lock().await;
        audio.has_microphone_input()
    };

    #[cfg(target_os = "macos")]
    let (accessibility_ready, automation_ready, notes) = {
        let mut notes = Vec::new();
        let probe = std::process::Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to get name of first process")
            .output();
        match probe {
            Ok(output) if output.status.success() => (true, true, notes),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                notes.push(format!(
                    "Accessibility probe failed. Grant Nautilus access in Privacy & Security > Accessibility. {}",
                    stderr
                ));
                (false, false, notes)
            }
            Err(error) => {
                notes.push(format!("Failed to run macOS permission probe: {}", error));
                (false, false, notes)
            }
        }
    };

    #[cfg(not(target_os = "macos"))]
    let (accessibility_ready, automation_ready, notes) = {
        let notes = vec![
            "Accessibility and automation probes are implemented for macOS first.".to_string(),
        ];
        (false, false, notes)
    };

    Ok(PermissionDiagnostics {
        microphone_ready,
        accessibility_ready,
        automation_ready,
        notes,
    })
}

#[tauri::command]
fn open_permission_settings(section: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = match section.as_str() {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "automation" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        };

        let status = std::process::Command::new("open")
            .arg(target)
            .status()
            .map_err(|e| format!("Failed to open System Settings: {}", e))?;
        if !status.success() {
            return Err("Failed to open System Settings".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = section;
        Err("Permission settings shortcut is supported on macOS only.".to_string())
    }
}

#[tauri::command]
fn get_dictation_overlay_state(state: tauri::State<'_, AppState>) -> DictationOverlayState {
    state
        .dictation_overlay_state
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| DictationOverlayState::default())
}

#[tauri::command]
fn get_recording_overlay_state(state: tauri::State<'_, AppState>) -> RecordingOverlayState {
    state
        .recording_overlay_state
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| RecordingOverlayState::default())
}

// Diarization commands
#[tauri::command]
#[allow(non_snake_case)]
async fn run_diarization(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<diarization::DiarizationResult, String> {
    let (recording_audio_path, transcript_opt) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;
        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        (recording.audio_path, transcript)
    };

    let (audio_path, cleanup_path) = resolve_audio_path_for_runtime(
        state.inner(),
        &recording_audio_path,
        "recording audio path",
    )
    .await?;

    let diarization = diarization::run_diarization(&audio_path)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_temp_file(cleanup_path);

    let mut inferred_aliases = std::collections::HashMap::new();
    if let Some(mut transcript) = transcript_opt {
        let engine = diarization::DiarizationEngine::new();
        engine.merge_with_transcript(&diarization, &mut transcript.segments);
        inferred_aliases = infer_speaker_aliases_from_segments(&transcript.segments);

        let mut db = state.db.lock().await;
        db.update_transcript_segments(&recordingId, &transcript.segments)
            .map_err(|e| e.to_string())?;
    }

    {
        let mut db = state.db.lock().await;
        let existing_aliases = db
            .get_speaker_aliases(&recordingId)
            .map_err(|e| e.to_string())?;

        for (index, speaker) in diarization.speakers.iter().enumerate() {
            let existing_name = existing_aliases
                .get(&speaker.id)
                .and_then(|(name, _, _)| name.as_deref());
            let inferred_name = inferred_aliases.get(&speaker.id).map(String::as_str);
            let resolved_name =
                resolve_speaker_name(existing_name, inferred_name, speaker.name.as_deref(), index);
            db.upsert_speaker_alias(
                &recordingId,
                &speaker.id,
                resolved_name.as_deref(),
                Some(&speaker.color),
                speaker.sample_count as i64,
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(diarization)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_speakers(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<Vec<diarization::Speaker>, String> {
    let (transcript_opt, aliases) = {
        let db = state.db.lock().await;
        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        let aliases = db
            .get_speaker_aliases(&recordingId)
            .map_err(|e| e.to_string())?;
        (transcript, aliases)
    };

    let Some(transcript) = transcript_opt else {
        return Ok(Vec::new());
    };

    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for segment in &transcript.segments {
        if let Some(speaker_id) = &segment.speaker_id {
            *counts.entry(speaker_id.clone()).or_insert(0) += 1;
        }
    }

    let speakers = counts
        .into_iter()
        .enumerate()
        .map(|(idx, (speaker_id, sample_count))| {
            let alias = aliases.get(&speaker_id);
            let name = alias
                .and_then(|(name, _, _)| name.clone())
                .or_else(|| Some(format!("Speaker {}", idx + 1)));
            let color = alias
                .and_then(|(_, color, _)| color.clone())
                .unwrap_or_else(|| default_speaker_color(idx));
            diarization::Speaker {
                id: speaker_id,
                name,
                color,
                sample_count,
            }
        })
        .collect();

    Ok(speakers)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn rename_speaker(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    speakerId: String,
    newName: String,
) -> Result<(), String> {
    let mut db = state.db.lock().await;
    db.upsert_speaker_alias(&recordingId, &speakerId, Some(&newName), None, 0)
        .map_err(|e| e.to_string())?;

    if let Err(e) = db.log_audit_event(
        "speaker_renamed",
        Some(serde_json::json!({
            "recording_id": &recordingId,
            "speaker_id": &speakerId,
            "new_name": &newName
        })),
        "info",
    ) {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
fn is_diarization_model_available() -> bool {
    diarization::DiarizationEngine::is_real_available()
}

#[tauri::command]
async fn download_diarization_model(_app: tauri::AppHandle) -> Result<(), String> {
    use crate::download::DownloadManager;

    let manager = DownloadManager::new().map_err(|e| e.to_string())?;

    let progress_callback = |progress: crate::download::DownloadProgress| {
        tracing::info!(
            "Diarization model download progress: {:.1}%",
            progress.percentage
        );
    };

    manager
        .download_diarization_model(progress_callback)
        .await
        .map_err(|e| e.to_string())?;

    tracing::info!("Diarization model downloaded successfully");
    Ok(())
}

#[tauri::command]
async fn start_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    options: Option<models::DictationStartOptions>,
) -> Result<(), String> {
    let resolved_options = match options {
        Some(provided) => provided,
        None => default_dictation_start_options(state.inner()).await,
    };
    start_dictation_session(state.inner(), &app, "manual", resolved_options)
        .await
        .map(|_| ())
}

#[tauri::command]
async fn stop_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let paste_to_cursor = state.settings_manager.lock().await.settings().transcription.dictation_paste_to_cursor;
    stop_dictation_session(state.inner(), &app, "manual", paste_to_cursor).await
}

#[tauri::command]
async fn force_stop_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    force_stop_dictation_session(state.inner(), &app, "force_stop").await
}

#[tauri::command]
async fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    options: models::RecordingOptions,
) -> Result<String, String> {
    {
        let dictation_state = state.dictation_runtime_state.lock().await;
        if *dictation_state != DictationSessionState::Idle {
            return Err("Cannot start recording while dictation is active".to_string());
        }
    }

    let mut audio = state.audio_capture.lock().await;
    let recording_id = audio
        .start_recording(options.clone())
        .map_err(|e| e.to_string())?;

    // Create recording entry in database
    let mut db = state.db.lock().await;
    db.create_recording(&models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Recording {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: options.project_id.clone(),
        duration: 0,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        source_type: "meeting".to_string(),
        audio_path: String::new(),
        status: "recording".to_string(),
    })
    .map_err(|e| e.to_string())?;

    // Log audit event
    let details = serde_json::json!({
        "recording_id": &recording_id,
        "project_id": &options.project_id,
        "mic_enabled": options.mic,
        "system_audio_enabled": options.system_audio
    });
    if let Err(e) = db.log_audit_event("recording_started", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    if should_show_recording_overlay(state.inner()).await {
        show_recording_overlay(&app);
    } else {
        hide_overlay_window(&app, RECORDING_OVERLAY_LABEL);
    }
    emit_recording_state(
        &app,
        "recording",
        Some(recording_id.as_str()),
        Some(chrono::Utc::now().timestamp_millis()),
        Some(options.system_audio),
        None,
    );

    Ok(recording_id)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn stop_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<(), String> {
    let (audio_path, content_hash) = {
        let mut audio = state.audio_capture.lock().await;
        audio
            .stop_recording(&recordingId)
            .map_err(|e| e.to_string())?
    };

    let mut db = state.db.lock().await;
    let duration_seconds = compute_wav_duration_seconds(&audio_path);
    db.update_recording_path(&recordingId, &audio_path, duration_seconds)
        .map_err(|e| e.to_string())?;

    // Log audit event with hash
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "audio_path": &audio_path,
        "content_hash": &content_hash,
        "duration_seconds": duration_seconds
    });
    if let Err(e) = db.log_audit_event("recording_stopped", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    emit_recording_state(
        &app,
        "transcribing",
        Some(recordingId.as_str()),
        None,
        None,
        Some("Processing transcript"),
    );

    // Trigger transcription in background using ASR manager
    let app_handle = app.clone();
    let asr_manager = Arc::clone(&state.asr_manager);
    let streaming_transcriber = Arc::clone(&state.streaming_transcriber);
    let db_clone = Arc::clone(&state.db);
    let settings_manager_clone = Arc::clone(&state.settings_manager);
    let vault_state_clone = Arc::clone(&state.vault_state);
    let recording_id_clone = recordingId.clone();
    let audio_path_clone = audio_path.clone();

    tokio::spawn(async move {
        let path = std::path::PathBuf::from(&audio_path_clone);
        let preview_task = {
            let app = app_handle.clone();
            let recording_id = recording_id_clone.clone();
            let path = path.clone();
            let streaming_transcriber = Arc::clone(&streaming_transcriber);
            let asr_manager = Arc::clone(&asr_manager);
            tokio::spawn(async move {
                if let Err(error) = emit_streaming_transcription_previews(
                    &app,
                    streaming_transcriber,
                    asr_manager,
                    &recording_id,
                    &path,
                )
                .await
                {
                    tracing::warn!(
                        "Streaming preview failed for recording {}: {}",
                        recording_id,
                        error
                    );
                }
            })
        };

        match asr_manager.transcribe(&path).await {
            Ok(result) => {
                tracing::info!("Transcription completed for {}", recording_id_clone);

                // Clone values before moving into struct
                let model_name_clone = result.model_name.clone();
                let model_id_clone = result.model_id.clone();
                let language_clone = result.language.clone();
                let requested_provider_clone = result.requested_provider;
                let actual_provider_clone = result.actual_provider;
                let fallback_used_clone = result.fallback_used;
                let fallback_reason_clone = result.fallback_reason.clone();

                let mut transcript = models::Transcript {
                    id: uuid::Uuid::new_v4().to_string(),
                    recording_id: recording_id_clone.clone(),
                    segments: result
                        .segments
                        .into_iter()
                        .map(|s| models::TranscriptSegment {
                            id: uuid::Uuid::new_v4().to_string(),
                            start_time: s.start_time,
                            end_time: s.end_time,
                            text: s.text,
                            speaker_id: None,
                            confidence: s.confidence,
                        })
                        .collect(),
                    full_text: result.text,
                    language: result.language,
                    confidence: result.confidence,
                    model: result.model_name,
                    model_id: Some(result.model_id),
                    requested_provider: Some(
                        asr_provider_to_settings_value(result.requested_provider).to_string(),
                    ),
                    actual_provider: Some(
                        asr_provider_to_settings_value(result.actual_provider).to_string(),
                    ),
                    fallback_used: Some(result.fallback_used),
                    fallback_reason: result.fallback_reason.clone(),
                    created_at: chrono::Utc::now(),
                };

                let enable_diarization = {
                    let settings_manager = settings_manager_clone.lock().await;
                    settings_manager.settings().transcription.enable_diarization
                };

                let mut diarization_result: Option<diarization::DiarizationResult> = None;
                if enable_diarization {
                    match diarization::run_diarization(&path).await {
                        Ok(result) => {
                            let engine = diarization::DiarizationEngine::new();
                            engine.merge_with_transcript(&result, &mut transcript.segments);
                            diarization_result = Some(result);
                        }
                        Err(error) => {
                            tracing::warn!(
                                "Automatic diarization failed for {}: {}",
                                recording_id_clone,
                                error
                            );
                        }
                    }
                }

                let inferred_aliases = infer_speaker_aliases_from_segments(&transcript.segments);

                // Save transcript to database
                let mut db = db_clone.lock().await;
                if let Err(e) = db.save_transcript(&transcript) {
                    tracing::error!("Failed to save transcript: {}", e);
                }

                if let Some(result) = diarization_result {
                    let existing_aliases = match db.get_speaker_aliases(&recording_id_clone) {
                        Ok(aliases) => aliases,
                        Err(error) => {
                            tracing::warn!(
                                "Failed to load speaker aliases for {}: {}",
                                recording_id_clone,
                                error
                            );
                            std::collections::HashMap::new()
                        }
                    };

                    for (index, speaker) in result.speakers.iter().enumerate() {
                        let existing_name = existing_aliases
                            .get(&speaker.id)
                            .and_then(|(name, _, _)| name.as_deref());
                        let inferred_name = inferred_aliases.get(&speaker.id).map(String::as_str);
                        let resolved_name = resolve_speaker_name(
                            existing_name,
                            inferred_name,
                            speaker.name.as_deref(),
                            index,
                        );

                        if let Err(error) = db.upsert_speaker_alias(
                            &recording_id_clone,
                            &speaker.id,
                            resolved_name.as_deref(),
                            Some(&speaker.color),
                            speaker.sample_count as i64,
                        ) {
                            tracing::warn!(
                                "Failed to save speaker alias for {}:{}: {}",
                                recording_id_clone,
                                speaker.id,
                                error
                            );
                        }
                    }
                }

                if let Err(e) = db.update_recording_status(&recording_id_clone, "completed") {
                    tracing::error!("Failed to update recording status: {}", e);
                }

                let encrypt_recordings = {
                    let settings_manager = settings_manager_clone.lock().await;
                    settings_manager.settings().privacy.encrypt_recordings
                };
                if encrypt_recordings {
                    let recording_key = {
                        let vault_state = vault_state_clone.lock().await;
                        if vault_state.unlocked {
                            vault_state.recording_key
                        } else {
                            None
                        }
                    };

                    if let Some(key) = recording_key {
                        match encrypt_recording_file_in_place(&path, &key) {
                            Ok(encrypted_path) => {
                                let encrypted_path_string =
                                    encrypted_path.to_string_lossy().to_string();
                                let duration_seconds =
                                    compute_wav_duration_seconds(&audio_path_clone);
                                if let Err(error) = db.update_recording_path(
                                    &recording_id_clone,
                                    &encrypted_path_string,
                                    duration_seconds,
                                ) {
                                    tracing::warn!(
                                        "Failed to update encrypted recording path for {}: {}",
                                        recording_id_clone,
                                        error
                                    );
                                } else if let Err(error) = db.log_audit_event(
                                    "recording_encrypted",
                                    Some(serde_json::json!({
                                        "recording_id": &recording_id_clone,
                                        "encrypted_audio_path": &encrypted_path_string
                                    })),
                                    "info",
                                ) {
                                    tracing::warn!(
                                        "Failed to log recording encryption event: {}",
                                        error
                                    );
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "Failed to encrypt recording artifact for {}: {}",
                                    recording_id_clone,
                                    error
                                );
                            }
                        }
                    } else {
                        tracing::warn!(
                            "Recording encryption is enabled but vault is locked; leaving '{}' unencrypted",
                            recording_id_clone
                        );
                    }
                }

                // Log audit event
                let details = serde_json::json!({
                    "recording_id": &recording_id_clone,
                    "model": &model_name_clone,
                    "model_id": &model_id_clone,
                    "language": &language_clone,
                    "requested_provider": asr_provider_to_settings_value(requested_provider_clone),
                    "actual_provider": asr_provider_to_settings_value(actual_provider_clone),
                    "fallback_used": fallback_used_clone,
                    "fallback_reason": fallback_reason_clone,
                });
                if let Err(e) = db.log_audit_event("transcription_completed", Some(details), "info")
                {
                    tracing::warn!("Failed to log audit event: {}", e);
                }
            }
            Err(e) => {
                tracing::error!("Failed to transcribe {}: {}", recording_id_clone, e);
                let mut db = db_clone.lock().await;
                if let Err(e) = db.update_recording_status(&recording_id_clone, "error") {
                    tracing::error!("Failed to update recording status: {}", e);
                }

                // Log audit event
                let details = serde_json::json!({
                    "recording_id": &recording_id_clone,
                    "error": e.to_string()
                });
                if let Err(e) = db.log_audit_event("transcription_failed", Some(details), "error") {
                    tracing::warn!("Failed to log audit event: {}", e);
                }
            }
        }

        preview_task.abort();
        emit_recording_state(&app_handle, "idle", None, None, None, None);
        hide_overlay_window(&app_handle, RECORDING_OVERLAY_LABEL);
    });

    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_recordings(
    state: tauri::State<'_, AppState>,
    projectId: Option<String>,
) -> Result<Vec<models::Recording>, String> {
    let mut recordings = {
        let db = state.db.lock().await;
        db.get_recordings(projectId.as_deref())
            .map_err(|e| e.to_string())?
    };

    let mut repaired_durations: Vec<(String, i64)> = Vec::new();
    for recording in &mut recordings {
        if recording.duration <= 0
            && !recording.audio_path.trim().is_empty()
            && !recording.audio_path.ends_with(".enc")
        {
            let duration = compute_wav_duration_seconds(&recording.audio_path);
            if duration > 0 {
                recording.duration = duration;
                repaired_durations.push((recording.id.clone(), duration));
            }
        }
    }

    if !repaired_durations.is_empty() {
        let mut db = state.db.lock().await;
        for (recording_id, duration_seconds) in repaired_durations {
            if let Err(error) = db.update_recording_duration(&recording_id, duration_seconds) {
                tracing::warn!(
                    "Failed to persist repaired duration for '{}': {}",
                    recording_id,
                    error
                );
            }
        }
    }

    Ok(recordings)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<Option<models::Recording>, String> {
    let db = state.db.lock().await;
    db.get_recording(&recordingId).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_transcript(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<Option<models::Transcript>, String> {
    let db = state.db.lock().await;
    db.get_transcript(&recordingId).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn open_recording_audio(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<(), String> {
    let recording = {
        let db = state.db.lock().await;
        db.get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?
    };

    if recording.audio_path.trim().is_empty() {
        return Err("Recording has no audio file path".to_string());
    }

    let canonical_audio =
        canonicalize_existing_absolute_path(&recording.audio_path, "recording audio path")?;
    if !canonical_audio.is_file() {
        return Err(format!(
            "Recording audio path is not a file: {}",
            canonical_audio.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical_audio, "recording audio path")?;

    let (resolved_path, cleanup_path) = resolve_audio_path_for_runtime(
        state.inner(),
        canonical_audio.to_string_lossy().as_ref(),
        "recording audio path",
    )
    .await?;

    open_path_in_default_app(&resolved_path)?;
    if let Some(path) = cleanup_path {
        schedule_temp_file_cleanup(path, Duration::from_secs(120));
    }

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "audio_path": canonical_audio.to_string_lossy().to_string(),
    });
    if let Err(e) = db.log_audit_event("recording_audio_opened", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_waveform_data(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<Vec<f32>, String> {
    let audio = state.audio_capture.lock().await;
    Ok(audio.get_waveform_data(&recordingId).unwrap_or_default())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_recording_waveform(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    points: Option<usize>,
) -> Result<Vec<f32>, String> {
    let recording = {
        let db = state.db.lock().await;
        db.get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?
    };

    if recording.audio_path.is_empty() {
        return Ok(Vec::new());
    }

    let (runtime_path, cleanup_path) = resolve_audio_path_for_runtime(
        state.inner(),
        &recording.audio_path,
        "recording audio path",
    )
    .await?;

    let result = crate::audio::waveform::generate_waveform_from_file(
        runtime_path.to_string_lossy().as_ref(),
        points.unwrap_or(400),
    )
    .map(|data| data.samples)
    .map_err(|e| e.to_string());
    cleanup_temp_file(cleanup_path);
    result
}

#[tauri::command]
#[allow(non_snake_case)]
async fn analyze_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    query: String,
    model: Option<String>,
) -> Result<llm::AnalysisResult, String> {
    let (recording, transcript) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;
        let transcript = db
            .get_transcript(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Transcript not found")?;
        (recording, transcript)
    };

    let mut context_segments = transcript
        .segments
        .iter()
        .map(|segment| AnalysisContextSegment {
            recording_id: recordingId.clone(),
            recording_title: recording.title.clone(),
            segment_id: segment.id.clone(),
            text: segment.text.clone(),
            start_time: segment.start_time,
            end_time: segment.end_time,
        })
        .collect::<Vec<_>>();
    if context_segments.is_empty() {
        return Err("Transcript contains no segments for grounded analysis".to_string());
    }
    if context_segments.len() > 140 {
        context_segments.truncate(140);
    }

    let transcript_context = context_segments
        .iter()
        .map(|segment| {
            format!(
                "[recordingId:{}|title:{}|segmentId:{}|startTime:{:.2}|endTime:{:.2}] {}",
                segment.recording_id,
                segment.recording_title,
                segment.segment_id,
                segment.start_time,
                segment.end_time,
                segment.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let strict_query = format!(
        "{}\n\nReturn JSON only with schema:\n{{\"response\":\"string\",\"citations\":[{{\"recordingId\":\"string\",\"startTime\":number,\"endTime\":number,\"text\":\"string\",\"certainty\":number}}]}}\nCitations must use exact recordingId/startTime/endTime from provided transcript lines.",
        query
    );

    let model_name = model.unwrap_or_default();
    let mut result = run_analysis_with_selected_provider(
        state.inner(),
        &transcript_context,
        &strict_query,
        if model_name.trim().is_empty() {
            None
        } else {
            Some(model_name.as_str())
        },
    )
    .await?;

    let structured = parse_structured_analysis_json(&result.response).ok_or_else(|| {
        "Model response did not include required JSON citation payload".to_string()
    })?;
    let validated_citations = validate_structured_citations(&structured.1, &context_segments)?;
    result.response = structured.0;
    result.citations = validated_citations;

    // Log audit event
    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "query": &query,
        "model": &result.model
    });
    if let Err(e) = db.log_audit_event("analysis_completed", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(result)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn summarize_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    model: Option<String>,
) -> Result<String, String> {
    let transcript = {
        let db = state.db.lock().await;
        db.get_transcript(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Transcript not found")?
    };

    let summary =
        run_summary_with_selected_provider(state.inner(), &transcript.full_text, model.as_deref())
            .await?;

    Ok(summary)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn extract_action_items(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    model: Option<String>,
) -> Result<Vec<llm::ActionItem>, String> {
    let transcript = {
        let db = state.db.lock().await;
        db.get_transcript(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Transcript not found")?
    };

    let items = run_action_items_with_selected_provider(
        state.inner(),
        &transcript.full_text,
        model.as_deref(),
    )
    .await?;

    Ok(items)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn search_transcripts(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    projectIds: Option<Vec<String>>,
) -> Result<Vec<models::SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let db = state.db.lock().await;
    db.search_transcripts(trimmed, limit.unwrap_or(20).min(200), projectIds.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn analyze_recordings(
    state: tauri::State<'_, AppState>,
    recordingIds: Vec<String>,
    query: String,
    model: Option<String>,
) -> Result<llm::AnalysisResult, String> {
    if recordingIds.is_empty() {
        return Err("recordingIds cannot be empty".to_string());
    }

    let mut context_segments: Vec<AnalysisContextSegment> = Vec::new();
    {
        let db = state.db.lock().await;
        let search_hits = db
            .search_transcripts_in_recordings(&query, 40, &recordingIds)
            .map_err(|e| e.to_string())?;

        if !search_hits.is_empty() {
            context_segments.extend(search_hits.into_iter().map(|hit| AnalysisContextSegment {
                recording_id: hit.recording_id,
                recording_title: hit.recording_title,
                segment_id: hit.segment_id,
                text: hit.text,
                start_time: hit.start_time,
                end_time: hit.end_time,
            }));
        } else {
            for recording_id in &recordingIds {
                let recording = match db.get_recording(recording_id).map_err(|e| e.to_string())? {
                    Some(value) => value,
                    None => continue,
                };
                let transcript = match db.get_transcript(recording_id).map_err(|e| e.to_string())? {
                    Some(value) => value,
                    None => continue,
                };

                context_segments.extend(transcript.segments.iter().take(8).map(|segment| {
                    AnalysisContextSegment {
                        recording_id: recording_id.clone(),
                        recording_title: recording.title.clone(),
                        segment_id: segment.id.clone(),
                        text: segment.text.clone(),
                        start_time: segment.start_time,
                        end_time: segment.end_time,
                    }
                }));
            }
        }
    }

    if context_segments.is_empty() {
        return Err("No transcript context found for selected recordings".to_string());
    }

    let transcript_context = context_segments
        .iter()
        .map(|segment| {
            format!(
                "[recordingId:{}|title:{}|segmentId:{}|startTime:{:.2}|endTime:{:.2}] {}",
                segment.recording_id,
                segment.recording_title,
                segment.segment_id,
                segment.start_time,
                segment.end_time,
                segment.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let strict_query = format!(
        "{}\n\nReturn JSON only with schema:\n{{\"response\":\"string\",\"citations\":[{{\"recordingId\":\"string\",\"startTime\":number,\"endTime\":number,\"text\":\"string\",\"certainty\":number}}]}}\nCitations must use exact recordingId/startTime/endTime from provided transcript lines.",
        query
    );

    let model_name = model.unwrap_or_default();
    let mut result = run_analysis_with_selected_provider(
        state.inner(),
        &transcript_context,
        &strict_query,
        if model_name.trim().is_empty() {
            None
        } else {
            Some(model_name.as_str())
        },
    )
    .await?;

    let structured = parse_structured_analysis_json(&result.response).ok_or_else(|| {
        "Model response did not include required JSON citation payload".to_string()
    })?;

    let validated_citations = validate_structured_citations(&structured.1, &context_segments)?;
    result.response = structured.0;
    result.citations = validated_citations;

    let mut db = state.db.lock().await;
    if let Err(error) = db.log_audit_event(
        "analysis_multi_recording_completed",
        Some(serde_json::json!({
            "recording_ids": recordingIds,
            "query": query,
            "model": result.model,
            "citation_count": result.citations.len()
        })),
        "info",
    ) {
        tracing::warn!("Failed to log multi-recording analysis event: {}", error);
    }

    Ok(result)
}

#[tauri::command]
async fn ask_memory(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<llm::AnalysisResult, String> {
    let entitlement = license::get_current_entitlement();
    if !entitlement.pro_enabled {
        return Err("Memory requires a Pro license or active trial".to_string());
    }

    let (memory_search_mode, embedding_model) = {
        let sm = state.settings_manager.lock().await;
        let s = sm.settings();
        (
            s.transcription.memory_search_mode.clone(),
            s.transcription.embedding_model.clone(),
        )
    };

    let mut context_segments: Vec<AnalysisContextSegment> = Vec::new();

    let used_embeddings = if memory_search_mode == "ollama_embeddings" {
        match state.ollama_embedder.embed(&embedding_model, &query).await {
            Ok(query_vec) => {
                let db = state.db.lock().await;
                match db.search_embeddings(&query_vec, 30) {
                    Ok(hits) if !hits.is_empty() => {
                        context_segments.extend(hits.into_iter().map(|hit| {
                            AnalysisContextSegment {
                                recording_id: hit.recording_id,
                                recording_title: hit.recording_title,
                                segment_id: hit.segment_id,
                                text: hit.text,
                                start_time: hit.start_time,
                                end_time: hit.end_time,
                            }
                        }));
                        true
                    }
                    Ok(_) => {
                        tracing::info!("Embedding search returned no results, falling back to FTS");
                        false
                    }
                    Err(e) => {
                        tracing::warn!("Embedding search failed, falling back to FTS: {}", e);
                        false
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Ollama embedding failed, falling back to FTS: {}", e);
                false
            }
        }
    } else {
        false
    };

    if !used_embeddings {
        let db = state.db.lock().await;
        let search_hits = db
            .search_transcripts(&query, 30, None)
            .map_err(|e| e.to_string())?;

        context_segments.extend(search_hits.into_iter().map(|hit| AnalysisContextSegment {
            recording_id: hit.recording_id,
            recording_title: hit.recording_title,
            segment_id: hit.segment_id,
            text: hit.text,
            start_time: hit.start_time,
            end_time: hit.end_time,
        }));
    }

    if context_segments.is_empty() {
        return Err("No relevant transcripts found. Record some meetings first.".to_string());
    }

    let transcript_context = context_segments
        .iter()
        .map(|segment| {
            format!(
                "[recordingId:{}|title:{}|segmentId:{}|startTime:{:.2}|endTime:{:.2}] {}",
                segment.recording_id,
                segment.recording_title,
                segment.segment_id,
                segment.start_time,
                segment.end_time,
                segment.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let strict_query = format!(
        "{}\n\nReturn JSON only with schema:\n{{\"response\":\"string\",\"citations\":[{{\"recordingId\":\"string\",\"startTime\":number,\"endTime\":number,\"text\":\"string\",\"certainty\":number}}]}}\nCitations must use exact recordingId/startTime/endTime from provided transcript lines.",
        query
    );

    let mut result = run_analysis_with_selected_provider(
        state.inner(),
        &transcript_context,
        &strict_query,
        None,
    )
    .await?;

    if let Some(structured) = parse_structured_analysis_json(&result.response) {
        if let Ok(validated) = validate_structured_citations(&structured.1, &context_segments) {
            result.response = structured.0;
            result.citations = validated;
        }
    }

    let mut db = state.db.lock().await;
    if let Err(error) = db.log_audit_event(
        "memory_query",
        Some(serde_json::json!({
            "query": query,
            "model": result.model,
            "citation_count": result.citations.len()
        })),
        "info",
    ) {
        tracing::warn!("Failed to log memory query event: {}", error);
    }

    Ok(result)
}

#[tauri::command]
async fn get_ollama_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.ollama_client.is_available().await)
}

#[tauri::command]
async fn reindex_embeddings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let embedding_model = {
        let sm = state.settings_manager.lock().await;
        sm.settings().transcription.embedding_model.clone()
    };

    if !state.ollama_embedder.is_available().await {
        return Err("Ollama is not running. Start Ollama and try again.".to_string());
    }

    // Collect all transcripts
    let transcripts = {
        let db = state.db.lock().await;
        db.get_recordings(None)
            .map_err(|e: anyhow::Error| e.to_string())?
            .into_iter()
            .filter_map(|rec| {
                db.get_transcript(&rec.id)
                    .ok()
                    .flatten()
                    .map(|t| (rec.id, t))
            })
            .collect::<Vec<_>>()
    };

    // Clear existing embeddings
    {
        let db = state.db.lock().await;
        db.delete_all_embeddings().map_err(|e| e.to_string())?;
    }

    let total_recordings = transcripts.len();
    let mut total_segments = 0usize;
    let mut errors = 0usize;

    for (idx, (recording_id, transcript)) in transcripts.iter().enumerate() {
        let texts: Vec<String> = transcript
            .segments
            .iter()
            .filter(|s| !s.text.trim().is_empty())
            .map(|s| s.text.clone())
            .collect();

        if texts.is_empty() {
            continue;
        }

        match state
            .ollama_embedder
            .embed_batch(&embedding_model, &texts)
            .await
        {
            Ok(embeddings) => {
                let db = state.db.lock().await;
                for (seg_idx, (segment, embedding)) in transcript
                    .segments
                    .iter()
                    .filter(|s| !s.text.trim().is_empty())
                    .zip(embeddings.iter())
                    .enumerate()
                {
                    let segment_id = if segment.id.is_empty() {
                        format!("seg_{}", seg_idx)
                    } else {
                        segment.id.clone()
                    };
                    if let Err(e) = db.save_embedding(
                        recording_id,
                        &segment_id,
                        &segment.text,
                        embedding,
                        &embedding_model,
                        segment.start_time,
                        segment.end_time,
                    ) {
                        tracing::warn!("Failed to save embedding: {}", e);
                        errors += 1;
                    } else {
                        total_segments += 1;
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to embed segments for recording {}: {}",
                    recording_id,
                    e
                );
                errors += 1;
            }
        }

        let _ = app.emit(
            "reindex-embeddings-progress",
            serde_json::json!({
                "current": idx + 1,
                "total": total_recordings,
                "segments": total_segments,
            }),
        );
    }

    Ok(serde_json::json!({
        "recordings": total_recordings,
        "segments": total_segments,
        "errors": errors,
    }))
}

#[tauri::command]
async fn get_embedding_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock().await;
    let count = db.embedding_count().map_err(|e| e.to_string())?;
    let ollama_available = state.ollama_embedder.is_available().await;
    Ok(serde_json::json!({
        "embeddingCount": count,
        "ollamaAvailable": ollama_available,
    }))
}

#[tauri::command]
async fn list_ollama_models(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .ollama_client
        .list_models()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_ollama_cloud_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("ollama-cloud")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    // Log secret status (don't log the key itself!)
    if secret.is_empty() {
        tracing::warn!("list_ollama_cloud_models called but secret is empty");
        println!("Ollama Cloud: Secret is empty");
        return Ok(vec![]);
    } else {
        println!("Ollama Cloud: Secret found (len: {})", secret.len());
    }

    let client = llm::OllamaCloudClient::with_api_key(Some(secret));

    // Log intent
    tracing::info!("Fetching Ollama Cloud models...");

    match client.list_models().await {
        Ok(models) => {
            tracing::info!("Ollama Cloud returned {} models", models.len());
            Ok(models)
        }
        Err(e) => {
            tracing::warn!("Ollama Cloud list_models failed: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn list_openai_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("openai")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::OpenAIClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_anthropic_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("anthropic")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::AnthropicClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_gemini_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("gemini")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::GeminiClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_deepseek_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("deepseek")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::DeepSeekClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn export_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    format: String,
    target: Option<String>,
) -> Result<String, String> {
    let (recording, transcript) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;

        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        (recording, transcript)
    };

    let validated_target = match target.as_deref() {
        Some(path) => Some(validate_export_target_path(state.inner(), path).await?),
        None => None,
    };
    let export_path = transcription::export(
        &recording,
        transcript.as_ref(),
        &format,
        validated_target.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    // Log audit event
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "format": &format,
        "target": validated_target,
        "export_path": &export_path
    });
    let mut db = state.db.lock().await;
    if let Err(e) = db.log_audit_event("recording_exported", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(export_path)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn export_recording_v2(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    format: String,
    redactionLevel: Option<String>,
    target: Option<String>,
    preview: Option<bool>,
) -> Result<models::ExportResponse, String> {
    let (recording, transcript, audit_log) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;

        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        let audit_log = db.get_all_audit_log().map_err(|e| e.to_string())?;
        (recording, transcript, audit_log)
    };

    let validated_target = match target.as_deref() {
        Some(path) => Some(validate_export_target_path(state.inner(), path).await?),
        None => None,
    };

    let redaction_level = redactionLevel.unwrap_or_else(|| "basic".to_string());
    let preview_mode = preview.unwrap_or(false);
    let result = transcription::export_with_policy(
        &recording,
        transcript.as_ref(),
        &audit_log,
        &format,
        validated_target.as_deref(),
        &redaction_level,
        preview_mode,
    )
    .map_err(|e| e.to_string())?;

    let details = serde_json::json!({
        "recording_id": &recordingId,
        "format": &format,
        "target": &validated_target,
        "preview": preview_mode,
        "redaction_level": &redaction_level,
        "export_path": &result.export_path
    });
    let mut db = state.db.lock().await;
    if let Err(e) = db.log_audit_event("recording_exported_v2", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(result)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn verify_evidence_bundle(
    targetPath: String,
) -> Result<transcription::EvidenceVerificationResult, String> {
    let canonical = canonicalize_existing_absolute_path(&targetPath, "targetPath")?;
    if !canonical.is_file() {
        return Err(format!(
            "targetPath must be a file, got: {}",
            canonical.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical, "targetPath")?;

    let canonical_str = canonical.to_string_lossy().to_string();
    transcription::verify_evidence_bundle_file(&canonical_str).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_projects(state: tauri::State<'_, AppState>) -> Result<Vec<models::Project>, String> {
    let db = state.db.lock().await;
    db.get_projects().map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_project(
    state: tauri::State<'_, AppState>,
    project: models::CreateProjectRequest,
) -> Result<models::Project, String> {
    let mut db = state.db.lock().await;
    db.create_project(&project).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn delete_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
) -> Result<(), String> {
    let mut db = state.db.lock().await;
    let audio_path = db
        .delete_recording(&recordingId)
        .map_err(|e| e.to_string())?;

    // Try to delete the audio file from disk
    if !audio_path.is_empty() {
        let path = std::path::Path::new(&audio_path);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!("Failed to delete audio file {}: {}", audio_path, e);
            }
        }
    }

    let details = serde_json::json!({ "recording_id": &recordingId });
    if let Err(e) = db.log_audit_event("recording_deleted", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn rename_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    newTitle: String,
) -> Result<(), String> {
    let mut db = state.db.lock().await;
    db.rename_recording(&recordingId, &newTitle)
        .map_err(|e| e.to_string())?;

    let details = serde_json::json!({
        "recording_id": &recordingId,
        "new_title": &newTitle
    });
    if let Err(e) = db.log_audit_event("recording_renamed", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn delete_project(
    state: tauri::State<'_, AppState>,
    projectId: String,
) -> Result<(), String> {
    let mut db = state.db.lock().await;
    db.delete_project(&projectId).map_err(|e| e.to_string())?;

    let details = serde_json::json!({ "project_id": &projectId });
    if let Err(e) = db.log_audit_event("project_deleted", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
async fn get_asr_providers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<asr::ProviderInfo>, String> {
    state.asr_manager.get_all_providers_info().await
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_asr_runtime_diagnostics(
    state: tauri::State<'_, AppState>,
    providerType: asr::AsrProviderType,
) -> Result<asr::RuntimeDiagnostics, String> {
    Ok(state
        .asr_manager
        .get_runtime_diagnostics(providerType)
        .await)
}

#[tauri::command]
async fn get_default_asr_provider(
    state: tauri::State<'_, AppState>,
) -> Result<asr::AsrProviderType, String> {
    Ok(state.asr_manager.get_default_provider().await)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn set_default_asr_provider(
    state: tauri::State<'_, AppState>,
    providerType: asr::AsrProviderType,
) -> Result<(), String> {
    if !asr::AsrManager::is_provider_transcription_enabled(providerType) {
        let provider = state.asr_manager.get_provider(providerType).await;
        return Err(format!(
            "ASR provider '{}' is downloaded but not enabled for inference in this build",
            provider.name()
        ));
    }

    let provider = state.asr_manager.get_provider(providerType).await;
    if !provider.is_available() {
        let diagnostics = state
            .asr_manager
            .get_runtime_diagnostics(providerType)
            .await;
        return Err(diagnostics.runtime_message.unwrap_or_else(|| {
            format!(
                "ASR provider '{}' is not available in this build",
                provider.name()
            )
        }));
    }
    state.asr_manager.set_default_provider(providerType).await;

    let mut settings_manager = state.settings_manager.lock().await;
    settings_manager
        .settings_mut()
        .transcription
        .default_provider = asr_provider_to_settings_value(providerType).to_string();
    settings_manager.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn download_asr_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    providerType: asr::AsrProviderType,
) -> Result<(), String> {
    let app_handle = app.clone();
    let provider_type_clone = providerType;
    let cb = Box::new(move |progress: f32| {
        let _ = app_handle.emit("asr-download-progress", (provider_type_clone, progress));
    });

    state
        .asr_manager
        .download_models(providerType, cb)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn benchmark_asr_providers(
    state: tauri::State<'_, AppState>,
    testAudioPath: String,
) -> Result<Vec<asr::BenchmarkResult>, String> {
    let path = std::path::PathBuf::from(testAudioPath);
    let results = state.asr_manager.benchmark_providers(&path).await;
    persist_benchmark_results(state.inner(), &results).await;
    Ok(results)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn benchmark_asr_providers_bytes(
    state: tauri::State<'_, AppState>,
    audioBytes: Vec<u8>,
) -> Result<Vec<asr::BenchmarkResult>, String> {
    let temp_path =
        std::env::temp_dir().join(format!("nautilus-benchmark-{}.wav", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, audioBytes).map_err(|e| e.to_string())?;
    let results = state.asr_manager.benchmark_providers(&temp_path).await;
    let _ = std::fs::remove_file(&temp_path);
    persist_benchmark_results(state.inner(), &results).await;
    Ok(results)
}

#[tauri::command]
async fn list_asr_benchmarks(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<models::AsrBenchmarkEntry>, String> {
    let db = state.db.lock().await;
    db.list_asr_benchmarks(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_audit_log(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<models::AuditLogEntry>, String> {
    let db = state.db.lock().await;
    db.get_audit_log().map_err(|e| e.to_string())
}

// Download manager commands
#[tauri::command]
#[allow(non_snake_case)]
async fn download_whisper_model(modelName: String) -> Result<String, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;

    let progress_callback = |progress: download::DownloadProgress| {
        tracing::info!(
            "Download progress: {:.1}% ({}/{})",
            progress.percentage,
            download::format_bytes(progress.bytes_downloaded),
            download::format_bytes(progress.total_bytes)
        );
    };

    let path = manager
        .download_whisper_model(&modelName, progress_callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn list_downloaded_models() -> Result<Vec<download::DownloadedModel>, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;

    manager
        .list_downloaded_models()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_model(path: String) -> Result<(), String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;

    let canonical = canonicalize_existing_absolute_path(&path, "path")?;
    let models_root = nautilus_data_root()?.join("models");
    let models_root = models_root.canonicalize().unwrap_or(models_root);
    if !canonical.starts_with(&models_root) {
        return Err(format!(
            "Refusing to delete model outside managed directory '{}': {}",
            models_root.display(),
            canonical.display()
        ));
    }
    manager
        .delete_model(&canonical)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_available_space() -> Result<u64, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;

    manager
        .get_available_space()
        .await
        .map_err(|e| e.to_string())
}

// Settings commands
#[tauri::command]
async fn get_settings(state: tauri::State<'_, AppState>) -> Result<settings::Settings, String> {
    let settings_manager = state.settings_manager.lock().await;
    Ok(settings_manager.settings().clone())
}

#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut settings: settings::Settings,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();

    let previous_settings = {
        let settings_manager = state.settings_manager.lock().await;
        settings_manager.settings().clone()
    };
    let previous_default_provider = previous_settings.transcription.default_provider.clone();
    let previous_export_root = previous_settings.privacy.export_root.clone();

    let result: Result<(), String> = async {
        let dictation_options = dictation_options_from_settings(&settings);
        state
            .asr_manager
            .set_selected_model_id(settings.transcription.selected_model_id.clone())
            .await;
        state
            .asr_manager
            .set_allow_whisper_fallback(settings.transcription.allow_whisper_fallback)
            .await;
        state
            .asr_manager
            .set_silence_skip_enabled(settings.transcription.silence_skip_enabled)
            .await;

        if settings.transcription.default_provider != previous_default_provider {
            if let Some(provider_type) =
                asr_provider_from_settings_value(&settings.transcription.default_provider)
            {
                state.asr_manager.set_default_provider(provider_type).await;

                let provider = state.asr_manager.get_provider(provider_type).await;
                if !provider.is_available() {
                    let warning = format!(
                        "{} is not ready — Whisper fallback will be used for transcription",
                        provider_type.display_name()
                    );
                    tracing::warn!("{}", warning);
                    if let Err(e) = app.emit("asr-provider-warning", &warning) {
                        tracing::warn!("Failed to emit asr-provider-warning: {}", e);
                    }
                }
            }
        }

        settings.privacy.llm_provider =
            AnalysisProvider::from_settings_value(&settings.privacy.llm_provider)
                .as_settings_value()
                .to_string();
        settings.transcription.dictation_profile = dictation_profile_to_settings_value(
            &dictation_profile_from_settings_value(&settings.transcription.dictation_profile),
        )
        .to_string();
        settings.shortcuts.toggle_dictation_alternates.clear();
        validate_shortcut_settings(&settings.shortcuts)?;
        if settings
            .transcription
            .dictation_project_id
            .trim()
            .is_empty()
        {
            settings.transcription.dictation_project_id = "inbox".to_string();
        }

        if settings.privacy.export_root != previous_export_root {
            if let Some(export_root) = settings.privacy.export_root.as_ref() {
                let canonical_root =
                    canonicalize_or_create_absolute_path(export_root, "exportRoot")?;
                settings.privacy.export_root = Some(canonical_root);
            }
        }

        let mut settings_manager = state.settings_manager.lock().await;
        *settings_manager.settings_mut() = settings;
        settings_manager.save().map_err(|e| e.to_string())?;

        let mut active_dictation_options = state.dictation_start_options.lock().await;
        *active_dictation_options = dictation_options;

        Ok(())
    }
    .await;

    #[cfg(debug_assertions)]
    tracing::debug!(
        "save_settings completed in {:?} (ok: {})",
        started.elapsed(),
        result.is_ok()
    );

    result
}

#[tauri::command]
async fn has_provider_secret(provider: String) -> Result<bool, String> {
    let normalized = normalize_provider_secret_name(&provider)?;
    secrets::has_provider_secret(normalized).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_provider_secret(provider: String, secret: String) -> Result<(), String> {
    eprintln!(
        "!!! BACKEND: set_provider_secret for '{}' (len: {}) !!!",
        provider,
        secret.len()
    );
    let normalized = normalize_provider_secret_name(&provider)?;
    secrets::set_provider_secret(normalized, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_provider_secret(provider: String) -> Result<(), String> {
    let normalized = normalize_provider_secret_name(&provider)?;
    secrets::clear_provider_secret(normalized).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_security_status(state: tauri::State<'_, AppState>) -> Result<SecurityStatus, String> {
    build_security_status(state.inner()).await
}

#[tauri::command]
async fn validate_license() -> license::LicenseInfo {
    license::validate_license().await
}

#[tauri::command]
async fn activate_license(key: String) -> Result<license::LicenseInfo, String> {
    license::activate_license(&key).await
}

#[tauri::command]
async fn deactivate_license() -> Result<(), String> {
    license::deactivate_license().await
}

#[tauri::command]
fn get_entitlement() -> license::Entitlement {
    license::get_current_entitlement()
}

// ── Update Commands ───────────────────────────────────────────────────────────

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<update::UpdateInfo>, String> {
    let update_service = update::UpdateService::new(app);
    update_service
        .check_for_updates()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update_service = update::UpdateService::new(app);
    update_service
        .install_update()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_update_status(app: AppHandle) -> Result<update::UpdateStatus, String> {
    let update_service = update::UpdateService::new(app);
    Ok(update_service.get_status().await)
}

#[tauri::command]
async fn get_update_channel(app: AppHandle) -> Result<update::UpdateChannel, String> {
    let update_service = update::UpdateService::new(app);
    Ok(update_service.get_channel().await)
}

#[tauri::command]
async fn set_update_channel(app: AppHandle, channel: update::UpdateChannel) -> Result<(), String> {
    let update_service = update::UpdateService::new(app);
    update_service
        .set_channel(channel)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn can_use_beta_channel(app: AppHandle) -> Result<bool, String> {
    let update_service = update::UpdateService::new(app);
    Ok(update_service.can_use_beta().await)
}

#[tauri::command]
async fn get_update_lock_reason(app: AppHandle) -> Result<Option<String>, String> {
    let update_service = update::UpdateService::new(app);
    Ok(update_service.get_lock_reason().await)
}

#[tauri::command]
async fn unlock_vault(state: tauri::State<'_, AppState>, password: String) -> Result<(), String> {
    unlock_vault_runtime(state.inner(), &password).await
}

#[tauri::command]
async fn lock_vault(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut vault_state = state.vault_state.lock().await;
    if let Some(mut key) = vault_state.recording_key.take() {
        use zeroize::Zeroize;
        key.zeroize();
    }
    vault_state.unlocked = false;
    Ok(())
}

#[tauri::command]
async fn migrate_to_encrypted_storage(
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    migrate_storage_encryption(state.inner(), &password).await
}

// VAD and noise suppression commands
#[tauri::command]
async fn set_vad_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut audio = state.audio_capture.lock().await;
    audio.set_vad_enabled(enabled);
    Ok(())
}

#[tauri::command]
async fn set_noise_suppression_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut audio = state.audio_capture.lock().await;
    audio.set_noise_suppression_enabled(enabled);
    Ok(())
}

#[tauri::command]
async fn get_audio_settings(state: tauri::State<'_, AppState>) -> Result<(bool, bool), String> {
    let audio = state.audio_capture.lock().await;
    Ok((audio.is_vad_enabled(), audio.is_noise_suppression_enabled()))
}

// Export template commands
#[tauri::command]
async fn list_export_templates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<export::templates::ExportTemplate>, String> {
    let templates: Vec<_> = state
        .template_manager
        .list_templates()
        .into_iter()
        .cloned()
        .collect();
    Ok(templates)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn export_with_template(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    templateId: String,
    target: Option<String>,
    preview: Option<bool>,
) -> Result<models::TemplateExportResponse, String> {
    use export::templates::RenderData;

    let (recording, transcript) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;

        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        (recording, transcript)
    };

    let render_data = RenderData {
        title: recording.title.clone(),
        date: recording.created_at.format("%Y-%m-%d %H:%M").to_string(),
        duration_seconds: recording.duration as u64,
        transcript: transcript
            .as_ref()
            .map(|t| t.full_text.clone())
            .unwrap_or_default(),
        speakers: vec![], // Would populate from diarization
        action_items: vec![],
        summary: None,
    };

    let rendered = state
        .template_manager
        .render(&templateId, &render_data)
        .map_err(|e| e.to_string())?;

    let preview_mode = preview.unwrap_or(true);
    if preview_mode {
        return Ok(models::TemplateExportResponse {
            template_id: templateId,
            preview: true,
            export_path: None,
            content: Some(rendered),
        });
    }

    let template = state
        .template_manager
        .get_template(&templateId)
        .ok_or_else(|| format!("Template not found: {}", templateId))?;
    let export_path = match target.as_deref() {
        Some(path) => validate_export_target_path(state.inner(), path).await?,
        None => {
            let fallback = export::get_default_export_path(&recording, export::ExportFormat::Text);
            fallback
                .with_extension(template_format_extension(&template.format))
                .to_string_lossy()
                .to_string()
        }
    };

    let export_path_buf = std::path::PathBuf::from(&export_path);
    if let Some(parent) = export_path_buf.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create export directory '{}': {}",
                parent.display(),
                e
            )
        })?;
    }
    std::fs::write(&export_path_buf, rendered).map_err(|e| {
        format!(
            "Failed to write template export '{}': {}",
            export_path_buf.display(),
            e
        )
    })?;

    let mut db = state.db.lock().await;
    if let Err(error) = db.log_audit_event(
        "recording_template_exported",
        Some(serde_json::json!({
            "recording_id": &recordingId,
            "template_id": &templateId,
            "target": &export_path
        })),
        "info",
    ) {
        tracing::warn!("Failed to log template export audit event: {}", error);
    }

    Ok(models::TemplateExportResponse {
        template_id: templateId,
        preview: false,
        export_path: Some(export_path),
        content: None,
    })
}

// Waveform commands
#[tauri::command]
async fn generate_waveform_svg(
    state: tauri::State<'_, AppState>,
    recording_path: String,
    width: u32,
    height: u32,
) -> Result<String, String> {
    use crate::audio::waveform;

    let canonical_path = canonicalize_existing_absolute_path(&recording_path, "recording_path")?;
    if !canonical_path.is_file() {
        return Err(format!(
            "recording_path must be a file, got: {}",
            canonical_path.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical_path, "recording_path")?;

    let (runtime_path, cleanup_path) = resolve_audio_path_for_runtime(
        state.inner(),
        canonical_path.to_string_lossy().as_ref(),
        "recording_path",
    )
    .await?;

    let data = waveform::generate_waveform_from_file(&runtime_path.to_string_lossy(), 200)
        .map_err(|e| e.to_string())?;
    cleanup_temp_file(cleanup_path);

    let svg = waveform::export_waveform_svg(&data, width, height, "#3b82f6");
    Ok(svg)
}

// Backup commands
#[tauri::command]
async fn list_backups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<backup::BackupInfo>, String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .list_backups()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_backup(
    state: tauri::State<'_, AppState>,
    data_dir: String,
) -> Result<backup::BackupInfo, String> {
    let path = canonicalize_existing_absolute_path(&data_dir, "data_dir")?;
    let expected_data_root = nautilus_data_root()?;
    if path != expected_data_root {
        return Err(format!(
            "data_dir must be Nautilus data directory '{}', got '{}'",
            expected_data_root.display(),
            path.display()
        ));
    }
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .create_backup(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_backup_default(
    state: tauri::State<'_, AppState>,
) -> Result<backup::BackupInfo, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Nautilus");
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .create_backup(&data_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_backup(
    state: tauri::State<'_, AppState>,
    backup_id: String,
    data_dir: String,
) -> Result<(), String> {
    let path = canonicalize_existing_absolute_path(&data_dir, "data_dir")?;
    let expected_data_root = nautilus_data_root()?;
    if path != expected_data_root {
        return Err(format!(
            "data_dir must be Nautilus data directory '{}', got '{}'",
            expected_data_root.display(),
            path.display()
        ));
    }
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .restore_backup(&backup_id, &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_backup_config(
    state: tauri::State<'_, AppState>,
) -> Result<backup::BackupConfig, String> {
    let backup_manager = state.backup_manager.lock().await;
    Ok(backup_manager.config().clone())
}

#[tauri::command]
async fn save_backup_config(
    state: tauri::State<'_, AppState>,
    config: backup::BackupConfig,
) -> Result<(), String> {
    let mut backup_manager = state.backup_manager.lock().await;
    backup_manager.set_config(config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn verify_backup_cloud_connection(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .verify_cloud_connection()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_backup_setup_report(
    state: tauri::State<'_, AppState>,
) -> Result<backup::CloudSetupReport, String> {
    let backup_manager = state.backup_manager.lock().await;
    Ok(backup_manager.cloud_setup_report().await)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn sync_backup_to_cloud(
    state: tauri::State<'_, AppState>,
    backupId: String,
) -> Result<(), String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .sync_backup_to_cloud(&backupId)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn export_backup_archive(
    state: tauri::State<'_, AppState>,
    backupId: String,
    targetPath: String,
) -> Result<(), String> {
    let canonical_target = canonicalize_existing_absolute_path(&targetPath, "targetPath")?;
    if !canonical_target.is_dir() {
        return Err(format!(
            "targetPath must be an existing directory, got '{}'",
            canonical_target.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical_target, "targetPath")?;

    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .export_backup(&backupId, &canonical_target)
        .await
        .map_err(|e| e.to_string())
}

// Intelligent punctuation command
#[tauri::command]
async fn punctuate_text(text: String, use_case: String) -> Result<String, String> {
    use text::format::format_for_use_case;

    let result = format_for_use_case(&text, &use_case);
    Ok(result)
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

async fn start_dictation_session(
    state: &AppState,
    app: &AppHandle,
    source: &str,
    options: models::DictationStartOptions,
) -> Result<u64, String> {
    {
        let recording_state = state
            .recording_overlay_state
            .lock()
            .map(|s| s.phase.clone())
            .unwrap_or_default();
        if recording_state != "idle" {
            return Err("Cannot start dictation while meeting recording is active".to_string());
        }
    }

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Idle {
            return Err("Dictation is already active".to_string());
        }

        let has_mic = {
            let audio = state.audio_capture.lock().await;
            audio.has_microphone_input()
        };
        if !has_mic {
            return Err(
                "No microphone available. Please connect a microphone and grant permission."
                    .to_string(),
            );
        }

        *runtime_state = DictationSessionState::Recording;
    }

    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.next_session_id += 1;
        tracker.active_session_id = Some(tracker.next_session_id);
        tracker.started_at = Some(std::time::Instant::now());
        tracker.next_session_id
    };

    {
        let mut audio = state.audio_capture.lock().await;
        if let Err(error) = audio.start_dictation() {
            let mut runtime_state = state.dictation_runtime_state.lock().await;
            *runtime_state = DictationSessionState::Idle;
            let mut tracker = state.dictation_session_tracker.lock().await;
            if tracker.active_session_id == Some(session_id) {
                tracker.active_session_id = None;
            }
            return Err(error.to_string());
        }
    }

    {
        let mut active_options = state.dictation_start_options.lock().await;
        *active_options = options;
    }

    if should_show_dictation_overlay(state).await {
        show_dictation_overlay(app);
    } else {
        hide_overlay_window(app, DICTATION_OVERLAY_LABEL);
    }
    emit_dictation_state(
        app,
        "recording",
        Some(chrono::Utc::now().timestamp_millis()),
        None,
        None,
        Some(session_id),
        None,
        None,
    );

    let mut db = state.db.lock().await;
    if let Err(e) = db.log_audit_event(
        "dictation_started",
        Some(serde_json::json!({ "source": source, "session_id": session_id })),
        "info",
    ) {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    let generation = {
        let mut value = state.dictation_watchdog_generation.lock().await;
        *value += 1;
        *value
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(DICTATION_MAX_DURATION_SECONDS)).await;
        let state = app_handle.state::<AppState>();
        let current_generation = *state.dictation_watchdog_generation.lock().await;
        if current_generation != generation {
            return;
        }
        let current_session = active_dictation_session_id(state.inner()).await;
        if current_session != Some(session_id) {
            return;
        }
        let current_state = *state.dictation_runtime_state.lock().await;
        if current_state == DictationSessionState::Recording {
            tracing::warn!("Dictation watchdog forcing stop after max duration");
            let _ = stop_dictation_session_for_session(
                state.inner(),
                &app_handle,
                session_id,
                "watchdog",
                true,
            )
            .await;
        }
    });

    Ok(session_id)
}

async fn stop_dictation_session(
    state: &AppState,
    app: &AppHandle,
    stop_reason: &str,
    paste_to_focused_app: bool,
) -> Result<String, String> {
    let session_id = active_dictation_session_id(state)
        .await
        .ok_or_else(|| "No active dictation session to stop".to_string())?;
    stop_dictation_session_for_session(state, app, session_id, stop_reason, paste_to_focused_app)
        .await
}

async fn stop_dictation_session_for_session(
    state: &AppState,
    app: &AppHandle,
    session_id: u64,
    stop_reason: &str,
    paste_to_focused_app: bool,
) -> Result<String, String> {
    let active_session = active_dictation_session_id(state).await;
    if active_session != Some(session_id) {
        return Err("Stale dictation stop request".to_string());
    }

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Recording {
            return Err("No active dictation session to stop".to_string());
        }
        *runtime_state = DictationSessionState::Stopping;
    }
    set_dictation_hotkey_flags(state, false, false).await;

    emit_dictation_state(
        app,
        "stopping",
        None,
        None,
        None,
        Some(session_id),
        Some(stop_reason),
        None,
    );
    show_dictation_overlay(app);

    let audio_data = {
        let mut audio = state.audio_capture.lock().await;
        match audio.stop_dictation() {
            Ok(bytes) => bytes,
            Err(error) => {
                let message = error.to_string();
                {
                    let mut runtime_state = state.dictation_runtime_state.lock().await;
                    *runtime_state = DictationSessionState::Error;
                }
                emit_dictation_state(
                    app,
                    "error",
                    None,
                    Some(&message),
                    None,
                    Some(session_id),
                    Some(stop_reason),
                    Some("provider_error"),
                );
                schedule_dictation_idle_reset(
                    app.clone(),
                    session_id,
                    Duration::from_secs(2),
                    Some(stop_reason.to_string()),
                    Some("provider_error".to_string()),
                );
                return Err(message);
            }
        }
    };

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        *runtime_state = DictationSessionState::Transcribing;
    }
    emit_dictation_state(
        app,
        "transcribing",
        None,
        None,
        None,
        Some(session_id),
        Some(stop_reason),
        None,
    );

    let dictation_options = state.dictation_start_options.lock().await.clone();
    let dictation_model_id = state.asr_manager.selected_model_id().await;

    // Remove leading/trailing silence to prevent Whisper hallucinations ("Thank you", repetitive loops)
    let processed_audio = crate::audio::utils::remove_silence_from_wav_bytes(&audio_data)
        .unwrap_or_else(|e| {
            tracing::warn!("Failed to remove silence from dictation audio, using raw audio: {}", e);
            audio_data.clone()
        });

    let mut result = match state.asr_manager.transcribe_bytes(&processed_audio).await {
        Ok(result) => result,
        Err(error) => {
            let message = error.to_string();
            {
                let mut runtime_state = state.dictation_runtime_state.lock().await;
                *runtime_state = DictationSessionState::Error;
            }
            emit_dictation_state(
                app,
                "error",
                None,
                Some(&message),
                None,
                Some(session_id),
                Some(stop_reason),
                Some("provider_error"),
            );
            schedule_dictation_idle_reset(
                app.clone(),
                session_id,
                Duration::from_secs(3),
                Some(stop_reason.to_string()),
                Some("provider_error".to_string()),
            );
            return Err(message);
        }
    };

    // Apply AI Formatting (Super Mode) if enabled
    let ai_formatting_enabled = state.settings_manager.lock().await.settings().transcription.dictation_ai_formatting;
    if ai_formatting_enabled && !result.text.trim().is_empty() {
        emit_dictation_state(
            app,
            "transcribing", // Or maybe a new state like "formatting", but "transcribing" keeps the UI spinner going
            None,
            Some("Applying AI formatting..."),
            None,
            Some(session_id),
            Some(stop_reason),
            None,
        );
        match run_dictation_formatting_with_selected_provider(state, &result.text).await {
            Ok(formatted_text) => {
                tracing::info!("AI Formatting applied successfully");
                result.text = formatted_text.trim().to_string();
            }
            Err(e) => {
                tracing::warn!("AI Formatting failed, falling back to raw transcript: {}", e);
            }
        }
    }

    let mut pasted = false;
    let mut copied = false;
    let mut paste_error: Option<String> = None;
    if paste_to_focused_app && !result.text.trim().is_empty() {
        let outcome = paste_text_systemwide(&result.text);
        pasted = outcome.pasted;
        copied = outcome.copied;
        paste_error = outcome.error;
    } else if !result.text.trim().is_empty() {
        copied = copy_to_clipboard(&result.text).is_ok();
    }

    if let Err(error) = app.emit(
        "dictation-text-ready",
        serde_json::json!({
            "sessionId": session_id,
            "stopReason": stop_reason,
            "outcome": if pasted { "pasted" } else if copied { "copied" } else { "none" },
            "text": result.text,
            "pasted": pasted,
            "copied": copied,
            "pasteError": paste_error,
            "requestedProvider": result.requested_provider,
            "actualProvider": result.actual_provider,
            "fallbackUsed": result.fallback_used,
            "fallbackReason": result.fallback_reason,
            "modelId": result.model_id
        }),
    ) {
        tracing::warn!("Failed to emit dictation text event: {}", error);
    }

    let preview = result
        .text
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    let outcome = if pasted {
        "pasted"
    } else if copied {
        "copied"
    } else {
        "none"
    };
    if !copied && paste_error.is_some() {
        let error_message = paste_error.as_deref().unwrap_or("Paste failed");
        {
            let mut runtime_state = state.dictation_runtime_state.lock().await;
            *runtime_state = DictationSessionState::Error;
        }
        emit_dictation_state(
            app,
            "error",
            None,
            Some(error_message),
            None,
            Some(session_id),
            Some(stop_reason),
            Some(outcome),
        );
        schedule_dictation_idle_reset(
            app.clone(),
            session_id,
            Duration::from_secs(3),
            Some(stop_reason.to_string()),
            Some(outcome.to_string()),
        );
    } else {
        {
            let mut runtime_state = state.dictation_runtime_state.lock().await;
            *runtime_state = DictationSessionState::Done;
        }
        let done_message = paste_error.as_deref();
        emit_dictation_state(
            app,
            "done",
            None,
            done_message,
            if preview.is_empty() {
                None
            } else {
                Some(preview.as_str())
            },
            Some(session_id),
            Some(stop_reason),
            Some(outcome),
        );
        schedule_dictation_idle_reset(
            app.clone(),
            session_id,
            Duration::from_secs(2),
            Some(stop_reason.to_string()),
            Some(outcome.to_string()),
        );
    }

    let mut db = state.db.lock().await;
    if dictation_options.save_to_inbox && !result.text.trim().is_empty() {
        let recording_id = uuid::Uuid::new_v4().to_string();
        let project_id = dictation_options
            .project_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("inbox");
        let duration_seconds = compute_wav_duration_seconds_from_bytes(&audio_data);
        let now = chrono::Utc::now();
        let recording = models::Recording {
            id: recording_id.clone(),
            title: format!(
                "Dictation {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M")
            ),
            project_id: project_id.to_string(),
            duration: duration_seconds,
            created_at: now,
            updated_at: now,
            source_type: "dictation".to_string(),
            audio_path: String::new(),
            status: "completed".to_string(),
        };

        if let Err(error) = db.create_recording(&recording) {
            tracing::warn!("Failed to persist dictation recording: {}", error);
        } else {
            let transcript = models::Transcript {
                id: uuid::Uuid::new_v4().to_string(),
                recording_id: recording_id.clone(),
                segments: result
                    .segments
                    .iter()
                    .map(|segment| models::TranscriptSegment {
                        id: uuid::Uuid::new_v4().to_string(),
                        start_time: segment.start_time,
                        end_time: segment.end_time,
                        text: segment.text.clone(),
                        speaker_id: None,
                        confidence: segment.confidence,
                    })
                    .collect(),
                full_text: result.text.clone(),
                language: result.language.clone(),
                confidence: result.confidence,
                model: result.model_name.clone(),
                model_id: Some(result.model_id.clone()),
                requested_provider: Some(
                    asr_provider_to_settings_value(result.requested_provider).to_string(),
                ),
                actual_provider: Some(
                    asr_provider_to_settings_value(result.actual_provider).to_string(),
                ),
                fallback_used: Some(result.fallback_used),
                fallback_reason: result.fallback_reason.clone(),
                created_at: now,
            };

            if let Err(error) = db.save_transcript(&transcript) {
                tracing::warn!("Failed to persist dictation transcript: {}", error);
            }
        }
    }

    let details = serde_json::json!({
        "stop_reason": stop_reason,
        "session_id": session_id,
        "model": &result.model_name,
        "model_id": &result.model_id,
        "language": &result.language,
        "requested_provider": result.requested_provider,
        "actual_provider": result.actual_provider,
        "fallback_used": result.fallback_used,
        "fallback_reason": result.fallback_reason,
        "text_length": result.text.len(),
        "pasted": pasted,
        "copied": copied,
        "paste_error": paste_error,
        "outcome": outcome,
        "save_to_inbox": dictation_options.save_to_inbox,
        "dictation_project_id": dictation_options.project_id,
        "dictation_profile": dictation_profile_to_settings_value(&dictation_options.profile),
        "dictation_model_id": dictation_model_id,
    });
    if let Err(e) = db.log_audit_event("dictation_completed", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    set_dictation_hotkey_flags(state, false, false).await;
    Ok(result.text)
}

async fn force_stop_dictation_session(
    state: &AppState,
    app: &AppHandle,
    source: &str,
) -> Result<String, String> {
    let session_id = active_dictation_session_id(state).await;
    {
        let mut audio = state.audio_capture.lock().await;
        audio.abort_dictation();
    }

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        *runtime_state = DictationSessionState::Idle;
    }
    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.active_session_id = None;
    }
    set_dictation_hotkey_flags(state, false, false).await;

    hide_overlay_window(app, DICTATION_OVERLAY_LABEL);
    emit_dictation_state(
        app,
        "idle",
        None,
        None,
        None,
        session_id,
        Some(source),
        Some("aborted"),
    );

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "session_id": session_id,
        "source": source,
        "outcome": "aborted"
    });
    if let Err(e) = db.log_audit_event("dictation_force_stopped", Some(details), "warn") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok("Dictation force stopped".to_string())
}

async fn should_show_dictation_overlay(state: &AppState) -> bool {
    let settings_manager = state.settings_manager.lock().await;
    settings_manager.settings().ui.show_dictation_popup
}

async fn should_show_recording_overlay(state: &AppState) -> bool {
    let settings_manager = state.settings_manager.lock().await;
    settings_manager.settings().ui.show_recording_popup
}

async fn handle_global_dictation_toggle(app: AppHandle, is_press: bool) {
    let state = app.state::<AppState>();
    let settings = state.settings_manager.lock().await.settings().clone();
    let is_ptt = settings.transcription.dictation_push_to_talk;
    let paste_to_cursor = settings.transcription.dictation_paste_to_cursor;
    
    let current_state = *state.dictation_runtime_state.lock().await;

    match current_state {
        DictationSessionState::Idle => {
            if !is_press {
                return; // Releasing hotkey when idle does nothing
            }
            // Start dictation
            let options = default_dictation_start_options(state.inner()).await;
            match start_dictation_session(state.inner(), &app, "hotkey", options).await {
                Ok(_id) => {
                    tracing::info!("Dictation started via toggle hotkey");
                }
                Err(error) => {
                    if !error.to_lowercase().contains("already in progress") {
                        tracing::warn!("Failed to start hotkey dictation: {}", error);
                        emit_dictation_state(
                            &app, "error", None, Some(&error), None, None, None, None,
                        );
                    }
                }
            }
        }
        DictationSessionState::Recording => {
            if is_ptt && is_press {
                // In PTT mode, pressing while recording shouldn't stop it (it's already recording).
                // Releasing it will stop it.
                return;
            }
            if !is_ptt && !is_press {
                // In Toggle mode, releasing shouldn't stop it.
                return;
            }
            
            // Stop dictation
            let session_id = match active_dictation_session_id(state.inner()).await {
                Some(value) => value,
                None => return,
            };

            if let Err(error) = stop_dictation_session_for_session(
                state.inner(),
                &app,
                session_id,
                if is_ptt { "ptt_release" } else { "toggle" },
                paste_to_cursor,
            )
            .await
            {
                tracing::warn!("Failed to stop hotkey dictation: {}", error);
                let normalized = error.to_lowercase();
                if !normalized.contains("stale")
                    && !normalized.contains("no active dictation session")
                {
                    let _ = force_stop_dictation_session(state.inner(), &app, "forced").await;
                }
            }
        }
        _ => {
            // Stopping/Transcribing/Done/Error — ignore
            tracing::debug!("Dictation toggle ignored in state {:?}", current_state);
        }
    }
}

async fn active_dictation_session_id(state: &AppState) -> Option<u64> {
    state
        .dictation_session_tracker
        .lock()
        .await
        .active_session_id
}

async fn set_dictation_hotkey_flags(state: &AppState, active: bool, release_pending: bool) {
    {
        let mut hotkey_active = state.dictation_hotkey_active.lock().await;
        *hotkey_active = active;
    }
    state
        .dictation_release_pending
        .store(release_pending, Ordering::SeqCst);
}

fn schedule_dictation_idle_reset(
    app: AppHandle,
    session_id: u64,
    delay: Duration,
    stop_reason: Option<String>,
    outcome: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let state = app.state::<AppState>();
        {
            let mut tracker = state.dictation_session_tracker.lock().await;
            if tracker.active_session_id != Some(session_id) {
                return;
            }
            tracker.active_session_id = None;
        }
        {
            let mut runtime_state = state.dictation_runtime_state.lock().await;
            *runtime_state = DictationSessionState::Idle;
        }
        set_dictation_hotkey_flags(state.inner(), false, false).await;

        hide_overlay_window(&app, DICTATION_OVERLAY_LABEL);
        emit_dictation_state(
            &app,
            "idle",
            None,
            None,
            None,
            Some(session_id),
            stop_reason.as_deref(),
            outcome.as_deref(),
        );
    });
}

#[allow(clippy::too_many_arguments)]
fn emit_dictation_state(
    app: &AppHandle,
    phase: &str,
    started_at_ms: Option<i64>,
    message: Option<&str>,
    preview: Option<&str>,
    session_id: Option<u64>,
    stop_reason: Option<&str>,
    outcome: Option<&str>,
) {
    if let Ok(mut state) = app.state::<AppState>().dictation_overlay_state.lock() {
        state.phase = phase.to_string();
        state.started_at_ms = started_at_ms;
        state.message = message.map(str::to_string);
        state.preview = preview.map(str::to_string);
        state.session_id = session_id;
        state.stop_reason = stop_reason.map(str::to_string);
        state.outcome = outcome.map(str::to_string);
    }

    let payload = serde_json::json!({
        "phase": phase,
        "startedAtMs": started_at_ms,
        "message": message,
        "preview": preview,
        "sessionId": session_id,
        "stopReason": stop_reason,
        "outcome": outcome
    });
    if let Err(error) = app.emit("dictation-state-changed", payload) {
        tracing::warn!("Failed to emit dictation state: {}", error);
    }
}

fn emit_recording_state(
    app: &AppHandle,
    phase: &str,
    recording_id: Option<&str>,
    started_at_ms: Option<i64>,
    system_audio_active: Option<bool>,
    message: Option<&str>,
) {
    if let Ok(mut state) = app.state::<AppState>().recording_overlay_state.lock() {
        state.phase = phase.to_string();
        state.recording_id = recording_id.map(str::to_string);
        state.started_at_ms = started_at_ms;
        state.system_audio_active = system_audio_active;
        state.message = message.map(str::to_string);
    }

    let payload = serde_json::json!({
        "phase": phase,
        "recordingId": recording_id,
        "startedAtMs": started_at_ms,
        "systemAudioActive": system_audio_active,
        "message": message
    });
    if let Err(error) = app.emit("meeting-recording-state-changed", payload) {
        tracing::warn!("Failed to emit meeting recording state: {}", error);
    }

    // Update macOS menu bar recording indicator
    match phase {
        "recording" => show_recording_tray_icon(app),
        "stopped" | "error" | "idle" => hide_recording_tray_icon(app),
        _ => {}
    }
}

fn show_recording_tray_icon(app: &AppHandle) {
    use tauri::tray::TrayIconBuilder;
    // Only create if not already present
    if app.tray_by_id(RECORDING_TRAY_ID).is_some() {
        return;
    }
    // Build a small 16x16 red circle RGBA icon for the menu bar
    let size: u32 = 16;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let center = size as f32 / 2.0;
    let radius = center - 1.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let idx = ((y * size + x) * 4) as usize;
            if dx * dx + dy * dy <= radius * radius {
                rgba[idx] = 220; // R
                rgba[idx + 1] = 38; // G
                rgba[idx + 2] = 38; // B
                rgba[idx + 3] = 255; // A
            }
        }
    }
    let icon = tauri::image::Image::new_owned(rgba, size, size);
    match TrayIconBuilder::with_id(RECORDING_TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Nautilus — Recording in progress")
        .build(app)
    {
        Ok(_) => tracing::debug!("Recording tray icon shown"),
        Err(e) => tracing::warn!("Failed to create recording tray icon: {}", e),
    }
}

fn hide_recording_tray_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(RECORDING_TRAY_ID) {
        if let Err(e) = tray.set_visible(false) {
            tracing::warn!("Failed to hide recording tray icon: {}", e);
        }
        // Remove it entirely
        drop(tray);
    }
}

fn show_dictation_overlay(app: &AppHandle) {
    show_overlay_window(
        app,
        DICTATION_OVERLAY_LABEL,
        "dictation",
        "Dictation",
        360.0,
        160.0,
    );
}

fn show_recording_overlay(app: &AppHandle) {
    show_overlay_window(
        app,
        RECORDING_OVERLAY_LABEL,
        "recording",
        "Recording",
        460.0,
        220.0,
    );
}

fn show_overlay_window(
    app: &AppHandle,
    label: &str,
    _overlay_type: &str,
    title: &str,
    width: f64,
    height: f64,
) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.show() {
            tracing::warn!("Failed to show '{}' window: {}", label, error);
        }
        return;
    }

    let url = WebviewUrl::App("index.html".into());
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(width, height)
        .resizable(true)
        .min_inner_size(240.0, 100.0)
        .decorations(false)
        .always_on_top(true)
        .focused(false)
        .transparent(true)
        .skip_taskbar(true);

    if let Err(error) = builder.build() {
        tracing::warn!("Failed to create '{}' window: {}", label, error);
    }
}

fn hide_overlay_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.hide() {
            tracing::warn!("Failed to hide '{}' window: {}", label, error);
        }
    }
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_iter()
            .find_map(|(label, window)| {
                if label == DICTATION_OVERLAY_LABEL || label == RECORDING_OVERLAY_LABEL {
                    None
                } else {
                    Some(window)
                }
            })
    });

    let Some(window) = window else {
        return Err("Main window was not found".to_string());
    };

    if let Ok(true) = window.is_minimized() {
        let _ = window.unminimize();
    }

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_provider_secret_name(provider: &str) -> Result<&'static str, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "openai" => Ok("openai"),
        "anthropic" => Ok("anthropic"),
        "gemini" => Ok("gemini"),
        "deepseek" => Ok("deepseek"),
        "ollama-cloud" | "ollama_cloud" | "ollamacloud" => Ok("ollama-cloud"),
        "ollama" => Err("Local Ollama does not require a stored API key".to_string()),
        _ => Err(format!(
            "Unsupported provider '{}'. Expected one of: openai, anthropic, gemini, deepseek, ollama-cloud",
            provider
        )),
    }
}

fn canonicalize_or_create_absolute_path(raw_path: &Path, label: &str) -> Result<PathBuf, String> {
    if !raw_path.is_absolute() {
        return Err(format!(
            "{} must be an absolute path, got '{}'",
            label,
            raw_path.display()
        ));
    }

    if raw_path.exists() {
        return raw_path.canonicalize().map_err(|e| {
            format!(
                "Failed to resolve {} '{}': {}",
                label,
                raw_path.display(),
                e
            )
        });
    }

    std::fs::create_dir_all(raw_path)
        .map_err(|e| format!("Failed to create {} '{}': {}", label, raw_path.display(), e))?;
    raw_path.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve {} '{}': {}",
            label,
            raw_path.display(),
            e
        )
    })
}

async fn validate_export_target_path(state: &AppState, raw_target: &str) -> Result<String, String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return Err("target cannot be empty".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!(
            "target must be an absolute path, got '{}'",
            candidate.display()
        ));
    }

    let export_root = {
        let settings_manager = state.settings_manager.lock().await;
        settings_manager.settings().privacy.export_root.clone()
    };

    let resolved_target = if candidate.exists() {
        let canonical = canonicalize_existing_absolute_path(trimmed, "target")?;
        if canonical.is_dir() {
            return Err(format!(
                "target must be a file path, got directory '{}'",
                canonical.display()
            ));
        }
        canonical
    } else {
        let Some(parent) = candidate.parent() else {
            return Err(format!(
                "target must include a parent directory, got '{}'",
                candidate.display()
            ));
        };
        let canonical_parent = canonicalize_or_create_absolute_path(parent, "target parent")?;
        let Some(file_name) = candidate.file_name() else {
            return Err(format!(
                "target must include a file name, got '{}'",
                candidate.display()
            ));
        };
        canonical_parent.join(file_name)
    };

    if let Some(root) = export_root {
        let canonical_root = canonicalize_or_create_absolute_path(&root, "exportRoot")?;
        if !resolved_target.starts_with(&canonical_root) {
            return Err(format!(
                "target '{}' is outside configured exportRoot '{}'",
                resolved_target.display(),
                canonical_root.display()
            ));
        }
    } else {
        let parent_to_check = resolved_target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| resolved_target.clone());
        ensure_path_in_approved_roots(&parent_to_check, "target")?;
    }

    Ok(resolved_target.to_string_lossy().to_string())
}

async fn selected_analysis_provider_and_settings(
    state: &AppState,
) -> (AnalysisProvider, bool, String, Option<String>) {
    let settings_manager = state.settings_manager.lock().await;
    let settings = settings_manager.settings();
    (
        AnalysisProvider::from_settings_value(&settings.privacy.llm_provider),
        settings.privacy.remote_processing_enabled,
        settings.privacy.llm_provider.clone(),
        settings.privacy.llm_model_id.clone(),
    )
}

fn enforce_remote_provider_policy(
    provider: AnalysisProvider,
    remote_processing_enabled: bool,
) -> Result<(), String> {
    if provider.is_remote() && !remote_processing_enabled {
        return Err(format!(
            "Remote provider '{}' is blocked by policy. Enable Settings > Security > Remote processing to continue.",
            provider.as_settings_value()
        ));
    }
    Ok(())
}

fn missing_provider_secret_error(provider: AnalysisProvider) -> String {
    format!(
        "Missing provider secret for '{}'. Add an API key in Settings > AI & Keys.",
        provider.as_settings_value()
    )
}

fn provider_secret_for(provider: AnalysisProvider) -> Result<String, String> {
    let Some(secret_name) = provider.provider_secret_name() else {
        return Err(format!(
            "Provider '{}' does not use API keys",
            provider.as_settings_value()
        ));
    };

    match secrets::get_provider_secret(secret_name).map_err(|e| e.to_string())? {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(missing_provider_secret_error(provider)),
    }
}

async fn run_analysis_with_selected_provider(
    state: &AppState,
    transcript: &str,
    query: &str,
    model: Option<&str>,
) -> Result<llm::AnalysisResult, String> {
    let (provider, remote_processing_enabled, configured_provider, settings_model) =
        selected_analysis_provider_and_settings(state).await;

    enforce_remote_provider_policy(provider, remote_processing_enabled)?;

    // Use provided model, then settings model, then provider default
    let selected_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| settings_model.as_deref().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| provider.default_model());

    tracing::info!(
        "Running analysis with provider '{}' and model '{}'",
        provider.as_settings_value(),
        selected_model
    );

    match provider {
        AnalysisProvider::Ollama => state
            .ollama_client
            .analyze_transcript(transcript, query, selected_model)
            .await
            .map_err(|e| e.to_string()),
        AnalysisProvider::OpenAi => {
            let api_key = provider_secret_for(provider)?;
            llm::OpenAIClient::with_api_key(Some(api_key))
                .analyze_transcript(transcript, query, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Anthropic => {
            let api_key = provider_secret_for(provider)?;
            llm::AnthropicClient::with_api_key(Some(api_key))
                .analyze_transcript(transcript, query, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Gemini => {
            let api_key = provider_secret_for(provider)?;
            llm::GeminiClient::with_api_key(Some(api_key))
                .analyze_transcript(transcript, query, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::DeepSeek => {
            let api_key = provider_secret_for(provider)?;
            llm::DeepSeekClient::with_api_key(Some(api_key))
                .analyze_transcript(transcript, query, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::OllamaCloud => {
            let api_key = provider_secret_for(provider)?;
            llm::OllamaCloudClient::with_api_key(Some(api_key))
                .analyze_transcript(transcript, query, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
    }
    .map_err(|error| {
        format!(
            "Analysis provider '{}' failed (configured '{}'): {}",
            provider.as_settings_value(),
            configured_provider,
            error
        )
    })
}

#[cfg(target_os = "macos")]
fn get_frontmost_app_name() -> Option<String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get name of first application process whose frontmost is true")
        .output()
        .ok()?;
        
    if output.status.success() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn get_frontmost_app_name() -> Option<String> {
    None
}

fn generate_default_dictation_prompt(active_app: Option<String>, clipboard_text: Option<String>) -> String {
    let mut base = "You are an AI dictation assistant. Your job is to format the user's raw dictated text. 
        Fix any grammar, punctuation, and capitalization errors. Remove filler words (ums, ahs). 
        Do not add any conversational filler, do not add quotes around the output, and do not answer any questions in the text. 
        Just output the corrected text directly.".to_string();

    if let Some(app_name) = active_app {
        base = format!(
            "You are an AI dictation assistant. Your job is to format the user's raw dictated text. 
            The user is currently dictating into the application: '{}'. 
            Format the text appropriately for this context (e.g. if it's a messaging app, keep it casual; if it's a code editor, preserve technical terms; if it's an email client, use standard capitalization). 
            Fix any grammar, punctuation, and capitalization errors. Remove filler words (ums, ahs). 
            Do not add any conversational filler, do not add quotes around the output, and do not answer any questions in the text. 
            Just output the corrected text directly.",
            app_name
        );
    }

    if let Some(clip) = clipboard_text {
        base = format!(
            "{}

For additional context, the user's clipboard currently contains the following text (they may be referencing it or replying to it):
\"{}\"",
            base, clip
        );
    }

    base
}

async fn run_dictation_formatting_with_selected_provider(
    state: &AppState,
    transcript: &str,
) -> Result<String, String> {
    let (provider, remote_processing_enabled, _, settings_model) =
        selected_analysis_provider_and_settings(state).await;
    enforce_remote_provider_policy(provider.clone(), remote_processing_enabled)?;

    let selected_model = settings_model
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| provider.default_model());

    let active_app = tauri::async_runtime::spawn_blocking(|| {
        get_frontmost_app_name()
    })
    .await
    .unwrap_or(None);
    
    let settings = state.settings_manager.lock().await.settings().clone();
    
        #[cfg(target_os = "macos")]
    let clipboard_text = read_clipboard_text().ok().filter(|s| !s.trim().is_empty() && s.len() < 5000);
    #[cfg(not(target_os = "macos"))]
    let clipboard_text: Option<String> = None;

    let system_prompt = if let Some(custom_prompt) = &settings.transcription.dictation_custom_prompt {
        if !custom_prompt.trim().is_empty() {
            let mut base = custom_prompt.clone();
            if let Some(app_name) = &active_app {
                base = format!("{}\n\n[Context: User is dictating into application '{}']", base, app_name);
            }
            if let Some(clip) = &clipboard_text {
                base = format!("{}\n\n[Context: User's clipboard currently contains: '{}']", base, clip);
            }
            base
        } else {
            generate_default_dictation_prompt(active_app, clipboard_text)
        }
    } else {
        generate_default_dictation_prompt(active_app, clipboard_text)
    };

    match provider {
        AnalysisProvider::Ollama => state
            .ollama_client
            .generate(selected_model, &format!("{}\n\n{}", system_prompt, transcript))
            .await
            .map_err(|e| e.to_string()),
        AnalysisProvider::OllamaCloud => {
            let api_key = provider_secret_for(provider.clone())?;
            llm::OllamaCloudClient::with_api_key(Some(api_key))
                .generate(selected_model, &format!("{}\n\n{}", system_prompt, transcript))
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::OpenAi => {
            let api_key = provider_secret_for(provider.clone())?;
            llm::OpenAIClient::with_api_key(Some(api_key))
                .generate(selected_model, transcript, Some(&system_prompt))
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Anthropic => {
            let api_key = provider_secret_for(provider.clone())?;
            llm::AnthropicClient::with_api_key(Some(api_key))
                .generate(selected_model, transcript, Some(&system_prompt))
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Gemini => {
            let api_key = provider_secret_for(provider.clone())?;
            llm::GeminiClient::with_api_key(Some(api_key))
                .generate(selected_model, transcript, Some(&system_prompt))
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::DeepSeek => {
            let api_key = provider_secret_for(provider.clone())?;
            llm::DeepSeekClient::with_api_key(Some(api_key))
                .generate(selected_model, transcript, Some(&system_prompt))
                .await
                .map_err(|e| e.to_string())
        }
    }
}

async fn run_summary_with_selected_provider(
    state: &AppState,
    transcript: &str,
    model: Option<&str>,
) -> Result<String, String> {
    let (provider, remote_processing_enabled, _, settings_model) =
        selected_analysis_provider_and_settings(state).await;
    enforce_remote_provider_policy(provider, remote_processing_enabled)?;

    let selected_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| settings_model.as_deref().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| provider.default_model());

    match provider {
        AnalysisProvider::Ollama => state
            .ollama_client
            .summarize(transcript, selected_model)
            .await
            .map_err(|e| e.to_string()),
        AnalysisProvider::OpenAi => {
            let api_key = provider_secret_for(provider)?;
            llm::OpenAIClient::with_api_key(Some(api_key))
                .summarize(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Anthropic => {
            let api_key = provider_secret_for(provider)?;
            llm::AnthropicClient::with_api_key(Some(api_key))
                .summarize(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Gemini => {
            let api_key = provider_secret_for(provider)?;
            llm::GeminiClient::with_api_key(Some(api_key))
                .summarize(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::DeepSeek => {
            let api_key = provider_secret_for(provider)?;
            llm::DeepSeekClient::with_api_key(Some(api_key))
                .summarize(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::OllamaCloud => {
            let api_key = provider_secret_for(provider)?;
            llm::OllamaCloudClient::with_api_key(Some(api_key))
                .summarize(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

async fn run_action_items_with_selected_provider(
    state: &AppState,
    transcript: &str,
    model: Option<&str>,
) -> Result<Vec<llm::ActionItem>, String> {
    let (provider, remote_processing_enabled, _, settings_model) =
        selected_analysis_provider_and_settings(state).await;
    enforce_remote_provider_policy(provider, remote_processing_enabled)?;

    let selected_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| settings_model.as_deref().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| provider.default_model());

    match provider {
        AnalysisProvider::Ollama => state
            .ollama_client
            .extract_action_items(transcript, selected_model)
            .await
            .map_err(|e| e.to_string()),
        AnalysisProvider::OpenAi => {
            let api_key = provider_secret_for(provider)?;
            llm::OpenAIClient::with_api_key(Some(api_key))
                .extract_action_items(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Anthropic => {
            let api_key = provider_secret_for(provider)?;
            llm::AnthropicClient::with_api_key(Some(api_key))
                .extract_action_items(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::Gemini => {
            let api_key = provider_secret_for(provider)?;
            llm::GeminiClient::with_api_key(Some(api_key))
                .extract_action_items(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::DeepSeek => {
            let api_key = provider_secret_for(provider)?;
            llm::DeepSeekClient::with_api_key(Some(api_key))
                .extract_action_items(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
        AnalysisProvider::OllamaCloud => {
            let api_key = provider_secret_for(provider)?;
            llm::OllamaCloudClient::with_api_key(Some(api_key))
                .extract_action_items(transcript, selected_model)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

async fn build_security_status(state: &AppState) -> Result<SecurityStatus, String> {
    let (privacy, vault_unlocked, db_encrypted) = {
        let settings_manager = state.settings_manager.lock().await;
        let privacy = settings_manager.settings().privacy.clone();
        let vault_state = state.vault_state.lock().await;
        (privacy, vault_state.unlocked, vault_state.db_encrypted)
    };

    Ok(SecurityStatus {
        vault_initialized: privacy.vault_initialized,
        vault_unlocked,
        database_encrypted: db_encrypted,
        recordings_encrypted: privacy.encrypt_recordings,
        llm_provider: AnalysisProvider::from_settings_value(&privacy.llm_provider)
            .as_settings_value()
            .to_string(),
        remote_processing_enabled: privacy.remote_processing_enabled,
        export_root: privacy
            .export_root
            .map(|path| path.to_string_lossy().to_string()),
    })
}

async fn unlock_vault_runtime(state: &AppState, password: &str) -> Result<(), String> {
    let password = password.trim();
    if password.is_empty() {
        return Err("Vault password cannot be empty".to_string());
    }

    let (vault_initialized, existing_salt) = {
        let settings_manager = state.settings_manager.lock().await;
        (
            settings_manager.settings().privacy.vault_initialized,
            settings_manager.settings().privacy.vault_salt.clone(),
        )
    };

    let salt = if let Some(value) = existing_salt.as_deref() {
        crate::crypto::ProjectKeyManager::salt_from_string(value)
            .map_err(|e| format!("Invalid vault salt in settings: {}", e))?
    } else {
        let mut generated = [0u8; VAULT_RECORDING_KEY_SALT_LEN];
        rand::thread_rng().fill_bytes(&mut generated);
        generated
    };

    let recording_key = crate::crypto::ProjectKeyManager::derive_key(password, &salt);

    if vault_initialized {
        let Some(blob_hex) =
            secrets::get_internal_secret(VAULT_UNLOCK_CHECK_SECRET).map_err(|e| e.to_string())?
        else {
            return Err("Vault is initialized but unlock verifier is missing".to_string());
        };
        let blob = hex::decode(blob_hex).map_err(|e| format!("Invalid unlock verifier: {}", e))?;
        let plaintext = crate::crypto::ProjectKeyManager::decrypt(&blob, &recording_key)
            .map_err(|_| "Invalid vault password".to_string())?;
        if plaintext != VAULT_UNLOCK_CHECK_PLAINTEXT {
            return Err("Invalid vault password".to_string());
        }
    } else {
        let mut settings_manager = state.settings_manager.lock().await;
        if settings_manager.settings().privacy.vault_salt.is_none() {
            settings_manager.settings_mut().privacy.vault_salt =
                Some(crate::crypto::ProjectKeyManager::salt_to_string(&salt));
            settings_manager.save().map_err(|e| e.to_string())?;
        }
    }

    let db_encrypted = {
        let db = state.db.lock().await;
        db.is_encrypted().map_err(|e| e.to_string())?
    };

    let mut vault_state = state.vault_state.lock().await;
    if let Some(mut previous_key) = vault_state.recording_key.take() {
        use zeroize::Zeroize;
        previous_key.zeroize();
    }
    vault_state.unlocked = true;
    vault_state.db_encrypted = db_encrypted;
    vault_state.recording_key = Some(recording_key);

    Ok(())
}

async fn migrate_storage_encryption(state: &AppState, password: &str) -> Result<(), String> {
    let password = password.trim();
    if password.len() < 8 {
        return Err("Vault password must be at least 8 characters".to_string());
    }

    let (already_initialized, existing_salt) = {
        let settings_manager = state.settings_manager.lock().await;
        (
            settings_manager.settings().privacy.vault_initialized,
            settings_manager.settings().privacy.vault_salt.clone(),
        )
    };

    let salt = if let Some(value) = existing_salt.as_deref() {
        crate::crypto::ProjectKeyManager::salt_from_string(value)
            .map_err(|e| format!("Invalid vault salt in settings: {}", e))?
    } else {
        let mut generated = [0u8; VAULT_RECORDING_KEY_SALT_LEN];
        rand::thread_rng().fill_bytes(&mut generated);
        generated
    };

    let recording_key = crate::crypto::ProjectKeyManager::derive_key(password, &salt);

    if !already_initialized {
        let mut db_key_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut db_key_bytes);
        let db_key = hex::encode(db_key_bytes);

        #[cfg(feature = "sqlcipher")]
        {
            let db = state.db.lock().await;
            db.change_key(&db_key).map_err(|e| e.to_string())?;
        }
        #[cfg(not(feature = "sqlcipher"))]
        {
            let _ = &db_key;
            tracing::warn!(
                "sqlcipher feature is disabled in this build; database encryption migration skipped"
            );
        }

        let verifier =
            crate::crypto::ProjectKeyManager::encrypt(VAULT_UNLOCK_CHECK_PLAINTEXT, &recording_key)
                .map_err(|e| e.to_string())?;
        secrets::set_internal_secret(VAULT_UNLOCK_CHECK_SECRET, &hex::encode(verifier))
            .map_err(|e| e.to_string())?;
        secrets::set_internal_secret(VAULT_DB_KEY_SECRET, &db_key).map_err(|e| e.to_string())?;
    }

    let recordings = {
        let db = state.db.lock().await;
        db.get_recordings(None).map_err(|e| e.to_string())?
    };

    for recording in recordings {
        if recording.audio_path.trim().is_empty() || recording.audio_path.ends_with(".enc") {
            continue;
        }
        let original_duration = compute_wav_duration_seconds(&recording.audio_path);
        let encrypted_path =
            encrypt_recording_file_in_place(Path::new(&recording.audio_path), &recording_key)?;
        let mut db = state.db.lock().await;
        db.update_recording_path(
            &recording.id,
            encrypted_path.to_string_lossy().as_ref(),
            original_duration,
        )
        .map_err(|e| e.to_string())?;
    }

    {
        let mut settings_manager = state.settings_manager.lock().await;
        let privacy = &mut settings_manager.settings_mut().privacy;
        privacy.encrypt_recordings = true;
        privacy.vault_initialized = true;
        privacy.vault_salt = Some(crate::crypto::ProjectKeyManager::salt_to_string(&salt));
        settings_manager.save().map_err(|e| e.to_string())?;
    }

    let db_encrypted = {
        let db = state.db.lock().await;
        db.is_encrypted().map_err(|e| e.to_string())?
    };

    let mut vault_state = state.vault_state.lock().await;
    vault_state.unlocked = true;
    vault_state.db_encrypted = db_encrypted;
    if let Some(mut previous_key) = vault_state.recording_key.take() {
        use zeroize::Zeroize;
        previous_key.zeroize();
    }
    vault_state.recording_key = Some(recording_key);

    Ok(())
}

fn encrypted_output_path(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("enc"))
        .unwrap_or(false)
    {
        return path.to_path_buf();
    }

    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => path.with_extension(format!("{}.enc", ext)),
        _ => path.with_extension("enc"),
    }
}

fn encrypt_recording_file_in_place(path: &Path, key: &[u8; 32]) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve recording path '{}': {}",
            path.display(),
            e
        )
    })?;
    if !canonical.is_file() {
        return Err(format!(
            "recording path must point to a file, got '{}'",
            canonical.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical, "recording path")?;

    if canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("enc"))
        .unwrap_or(false)
    {
        return Ok(canonical);
    }

    let plaintext = std::fs::read(&canonical).map_err(|e| {
        format!(
            "Failed to read recording '{}' for encryption: {}",
            canonical.display(),
            e
        )
    })?;
    let ciphertext = crate::crypto::ProjectKeyManager::encrypt(&plaintext, key).map_err(|e| {
        format!(
            "Failed to encrypt recording '{}': {}",
            canonical.display(),
            e
        )
    })?;

    let output_path = encrypted_output_path(&canonical);
    let temp_path = output_path.with_extension("enc.tmp");
    std::fs::write(&temp_path, ciphertext).map_err(|e| {
        format!(
            "Failed to write encrypted recording '{}' : {}",
            temp_path.display(),
            e
        )
    })?;
    std::fs::rename(&temp_path, &output_path).map_err(|e| {
        format!(
            "Failed to finalize encrypted recording '{}' : {}",
            output_path.display(),
            e
        )
    })?;
    std::fs::remove_file(&canonical).map_err(|e| {
        format!(
            "Failed to remove plaintext recording '{}' after encryption: {}",
            canonical.display(),
            e
        )
    })?;

    Ok(output_path)
}

async fn resolve_audio_path_for_runtime(
    state: &AppState,
    audio_path: &str,
    label: &str,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let canonical = canonicalize_existing_absolute_path(audio_path, label)?;
    if !canonical.is_file() {
        return Err(format!("{} is not a file: {}", label, canonical.display()));
    }
    ensure_path_in_approved_roots(&canonical, label)?;

    let is_encrypted = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("enc"))
        .unwrap_or(false);
    if !is_encrypted {
        return Ok((canonical, None));
    }

    let key = {
        let vault_state = state.vault_state.lock().await;
        if !vault_state.unlocked {
            return Err(
                "Vault is locked. Unlock vault before opening encrypted recordings.".to_string(),
            );
        }
        vault_state.recording_key
    }
    .ok_or_else(|| "Vault is unlocked but no runtime recording key is available".to_string())?;

    let encrypted_bytes = tokio::fs::read(&canonical).await.map_err(|e| {
        format!(
            "Failed to read encrypted recording '{}': {}",
            canonical.display(),
            e
        )
    })?;
    let decrypted_bytes = crate::crypto::ProjectKeyManager::decrypt(&encrypted_bytes, &key)
        .map_err(|_| {
            format!(
                "Failed to decrypt recording '{}'. Verify vault password and retry.",
                canonical.display()
            )
        })?;

    let runtime_dir = nautilus_data_root()?
        .join("runtime")
        .join("decrypted-audio");
    tokio::fs::create_dir_all(&runtime_dir).await.map_err(|e| {
        format!(
            "Failed to prepare runtime decrypted-audio directory '{}': {}",
            runtime_dir.display(),
            e
        )
    })?;

    let temp_path = runtime_dir.join(format!("{}.wav", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp_path, decrypted_bytes)
        .await
        .map_err(|e| {
            format!(
                "Failed to write runtime decrypted audio '{}': {}",
                temp_path.display(),
                e
            )
        })?;

    Ok((temp_path.clone(), Some(temp_path)))
}

fn cleanup_temp_file(path: Option<PathBuf>) {
    if let Some(path) = path {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(
                "Failed to clean up temp file '{}': {}",
                path.display(),
                error
            );
        }
    }
}

fn schedule_temp_file_cleanup(path: PathBuf, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        cleanup_temp_file(Some(path));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    #[cfg(debug_assertions)]
    let db_init_started = std::time::Instant::now();

    let initial_db_key = secrets::get_internal_secret(VAULT_DB_KEY_SECRET)
        .expect("Failed to read database key from secure credential storage");
    let database = db::Database::new_with_key(initial_db_key.as_deref()).unwrap_or_else(|error| {
        if initial_db_key.is_some() {
            panic!(
                "Failed to open encrypted database with stored key. Restore keychain entry or migrate vault state. Root cause: {}",
                error
            );
        }
        panic!("Failed to initialize local database: {}", error);
    });
    #[cfg(debug_assertions)]
    tracing::debug!(
        "Database initialization completed in {:?}",
        db_init_started.elapsed()
    );

    let settings_manager = settings::SettingsManager::new().expect("Failed to initialize settings");
    let initial_dictation_options = dictation_options_from_settings(settings_manager.settings());
    let asr_manager = Arc::new(asr::AsrManager::new());
    let streaming_transcriber = Arc::new(streaming::StreamingTranscriber::new(Arc::clone(
        &asr_manager,
    )));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            db: Arc::new(Mutex::new(database)),
            audio_capture: Arc::new(Mutex::new(audio::AudioCapture::new())),
            asr_manager,
            ollama_client: Arc::new(llm::OllamaClient::new()),
            ollama_embedder: Arc::new(llm::OllamaEmbedder::new()),
            integration_manager: Arc::new(integrations::IntegrationManager::new()),
            settings_manager: Arc::new(Mutex::new(settings_manager)),
            backup_manager: Arc::new(Mutex::new(backup::BackupManager::default())),
            template_manager: Arc::new(export::templates::TemplateManager::new()),
            dictation_hotkey_active: Arc::new(Mutex::new(false)),
            dictation_release_pending: Arc::new(AtomicBool::new(false)),
            dictation_watchdog_generation: Arc::new(Mutex::new(0)),
            dictation_session_tracker: Arc::new(Mutex::new(DictationSessionTracker::default())),
            dictation_runtime_state: Arc::new(Mutex::new(DictationSessionState::Idle)),
            dictation_start_options: Arc::new(Mutex::new(initial_dictation_options)),
            dictation_overlay_state: Arc::new(StdMutex::new(DictationOverlayState::default())),
            recording_overlay_state: Arc::new(StdMutex::new(RecordingOverlayState::default())),
            streaming_transcriber,
            vault_state: Arc::new(Mutex::new(VaultRuntimeState::default())),
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            tauri::async_runtime::block_on(async {
                let (configured_provider, selected_model_id, allow_whisper_fallback, silence_skip) = {
                    let settings_manager = state.settings_manager.lock().await;
                    (
                        settings_manager.settings().transcription.default_provider.clone(),
                        settings_manager
                            .settings()
                            .transcription
                            .selected_model_id
                            .clone(),
                        settings_manager
                            .settings()
                            .transcription
                            .allow_whisper_fallback,
                        settings_manager
                            .settings()
                            .transcription
                            .silence_skip_enabled,
                    )
                };

                state
                    .asr_manager
                    .set_selected_model_id(selected_model_id)
                    .await;
                state
                    .asr_manager
                    .set_allow_whisper_fallback(allow_whisper_fallback)
                    .await;
                state
                    .asr_manager
                    .set_silence_skip_enabled(silence_skip)
                    .await;

                if let Some(provider_type) =
                    asr_provider_from_settings_value(&configured_provider)
                {
                    if asr::AsrManager::is_provider_transcription_enabled(provider_type) {
                        state.asr_manager.set_default_provider(provider_type).await;
                    } else {
                        let mut settings_manager = state.settings_manager.lock().await;
                        settings_manager.settings_mut().transcription.default_provider =
                            asr_provider_to_settings_value(asr::AsrProviderType::Whisper)
                                .to_string();
                        if let Err(error) = settings_manager.save() {
                            tracing::warn!(
                                "Failed to persist Whisper fallback for unsupported ASR provider: {}",
                                error
                            );
                        }
                    }
                }

                let db_encrypted = {
                    let db = state.db.lock().await;
                    db.is_encrypted().unwrap_or(false)
                };
                {
                    let mut vault_state = state.vault_state.lock().await;
                    vault_state.db_encrypted = db_encrypted;
                }
            });

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::ShortcutState;

                let configured_shortcuts = {
                    let settings_manager = tauri::async_runtime::block_on(async {
                        let settings_manager = state.settings_manager.lock().await;
                        settings_manager.settings().shortcuts.clone()
                    });
                    shortcut_bindings_from_settings(&settings_manager).or_else(|error| {
                        tracing::warn!(
                            "Invalid shortcut settings ({}). Falling back to defaults.",
                            error
                        );
                        let fallback = settings::KeyboardShortcuts::default();
                        shortcut_bindings_from_settings(&fallback)
                    })
                };

                match configured_shortcuts {
                    Ok(shortcut_bindings) => {
                        let registered_shortcuts = shortcut_bindings
                            .iter()
                            .map(|binding| binding.shortcut)
                            .collect::<Vec<_>>();
                        let bindings_for_handler = shortcut_bindings.clone();

                        match tauri_plugin_global_shortcut::Builder::new()
                            .with_shortcuts(registered_shortcuts)
                        {
                            Ok(builder) => {
                                let result = app.handle().plugin(
                                    builder
                                        .with_handler(move |_app, shortcut, event| {
                                            let Some(binding) = bindings_for_handler
                                                .iter()
                                                .find(|entry| entry.shortcut == *shortcut)
                                            else {
                                                return;
                                            };

                                            match binding.action {
                                                ShortcutAction::OpenWindow
                                                    if matches!(event.state(), ShortcutState::Pressed) =>
                                                {
                                                    if let Err(error) = show_main_window(_app) {
                                                        tracing::warn!(
                                                            "Failed to show main window from shortcut: {}",
                                                            error
                                                        );
                                                    }
                                                }
                                                ShortcutAction::EmergencyStopDictation
                                                    if matches!(event.state(), ShortcutState::Pressed) =>
                                                {
                                                    let app_handle = _app.clone();
                                                    tauri::async_runtime::spawn(async move {
                                                        let state = app_handle.state::<AppState>();
                                                        let current_state =
                                                            *state.dictation_runtime_state.lock().await;
                                                        if current_state != DictationSessionState::Idle {
                                                            let _ = force_stop_dictation_session(
                                                                state.inner(),
                                                                &app_handle,
                                                                "emergency",
                                                            )
                                                            .await;
                                                        }
                                                    });
                                                }
                                                ShortcutAction::ToggleDictation => {
                                                    let is_pressed = matches!(event.state(), ShortcutState::Pressed);
                                                    tracing::info!(
                                                        "Global dictation hotkey {}: {:?}",
                                                        if is_pressed { "pressed" } else { "released" },
                                                        shortcut
                                                    );
                                                    
                                                    if is_pressed {
                                                        _app.emit("dictation-hotkey-pressed", ()).ok();
                                                    } else {
                                                        _app.emit("dictation-hotkey-released", ()).ok();
                                                    }
                                                    
                                                    let app_handle = _app.clone();
                                                    tauri::async_runtime::spawn(async move {
                                                        handle_global_dictation_toggle(app_handle, is_pressed).await;
                                                    });
                                                }
                                                ShortcutAction::ToggleRecording
                                                    if matches!(event.state(), ShortcutState::Pressed) =>
                                                {
                                                    _app.emit(
                                                        "shortcut-action",
                                                        serde_json::json!({ "action": "toggle_recording" }),
                                                    )
                                                    .ok();
                                                }
                                                ShortcutAction::QuickExport
                                                    if matches!(event.state(), ShortcutState::Pressed) =>
                                                {
                                                    _app.emit(
                                                        "shortcut-action",
                                                        serde_json::json!({ "action": "quick_export" }),
                                                    )
                                                    .ok();
                                                }
                                                ShortcutAction::FocusSearch
                                                    if matches!(event.state(), ShortcutState::Pressed) =>
                                                {
                                                    _app.emit(
                                                        "shortcut-action",
                                                        serde_json::json!({ "action": "focus_search" }),
                                                    )
                                                    .ok();
                                                }
                                                _ => {}
                                            }
                                        })
                                        .build(),
                                );
                                if let Err(e) = result {
                                    tracing::warn!("Failed to register global shortcut: {}. Accessibility permissions may be required.", e);
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Failed to create global shortcut builder: {}. Accessibility permissions may be required.", e);
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            "Failed to configure global shortcuts: {}. Hotkeys will be unavailable.",
                            error
                        );
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == DICTATION_OVERLAY_LABEL || window.label() == RECORDING_OVERLAY_LABEL {
                    return;
                }
                let app_state = window.state::<AppState>();
                let capture_active = tauri::async_runtime::block_on(async {
                    let audio = app_state.audio_capture.lock().await;
                    audio.is_dictating() || audio.is_recording()
                });
                if capture_active {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        tracing::warn!("Failed to hide main window on close: {}", error);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_dictation,
            stop_dictation,
            force_stop_dictation,
            start_recording,
            stop_recording,
            get_recordings,
            get_recording,
            get_transcript,
            open_recording_audio,
            get_waveform_data,
            get_recording_waveform,
            analyze_recording,
            analyze_recordings,
            summarize_recording,
            extract_action_items,
            search_transcripts,
            get_ollama_status,
            reindex_embeddings,
            get_embedding_status,
            list_ollama_models,
            list_ollama_cloud_models,
            list_openai_models,
            list_anthropic_models,
            list_gemini_models,
            list_deepseek_models,
            export_recording,
            export_recording_v2,
            verify_evidence_bundle,
            get_projects,
            create_project,
            delete_recording,
            rename_recording,
            delete_project,
            get_asr_providers,
            get_asr_runtime_diagnostics,
            get_default_asr_provider,
            set_default_asr_provider,
            download_asr_models,
            benchmark_asr_providers,
            benchmark_asr_providers_bytes,
            list_asr_benchmarks,
            get_audit_log,
            download_whisper_model,
            list_downloaded_models,
            delete_model,
            get_available_space,
            get_dictation_overlay_state,
            get_recording_overlay_state,
            open_main_window,
            check_system_audio_availability,
            get_loopback_device_name,
            get_permission_diagnostics,
            open_permission_settings,
            run_diarization,
            get_speakers,
            rename_speaker,
            is_diarization_model_available,
            download_diarization_model,
            get_settings,
            save_settings,
            has_provider_secret,
            set_provider_secret,
            clear_provider_secret,
            get_security_status,
            unlock_vault,
            lock_vault,
            migrate_to_encrypted_storage,
            set_vad_enabled,
            set_noise_suppression_enabled,
            get_audio_settings,
            list_export_templates,
            export_with_template,
            generate_waveform_svg,
            list_backups,
            create_backup,
            create_backup_default,
            restore_backup,
            get_backup_config,
            save_backup_config,
            verify_backup_cloud_connection,
            get_backup_setup_report,
            sync_backup_to_cloud,
            export_backup_archive,
            punctuate_text,
            activate_license,
            validate_license,
            deactivate_license,
            get_entitlement,
            ask_memory,
            check_for_updates,
            install_update,
            get_update_status,
            get_update_channel,
            set_update_channel,
            can_use_beta_channel,
            get_update_lock_reason,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn infer_speaker_aliases_from_segments(
    segments: &[models::TranscriptSegment],
) -> std::collections::HashMap<String, String> {
    let mut aliases = std::collections::HashMap::new();
    let intro_pattern =
        Regex::new(r"\b(?:this is|i am|i'm|my name is)\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+)?)\b")
            .expect("valid intro regex");
    let next_pattern =
        Regex::new(r"\b(?:next is|up next is)\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+)?)\b")
            .expect("valid next regex");

    for (index, segment) in segments.iter().enumerate() {
        let Some(current_speaker_id) = segment.speaker_id.as_ref() else {
            continue;
        };

        if !aliases.contains_key(current_speaker_id) {
            let lowered = segment.text.to_lowercase();
            if let Some(captured) = intro_pattern.captures(&lowered) {
                if let Some(name_match) = captured.get(1) {
                    if let Some(name) = normalize_person_name(name_match.as_str()) {
                        aliases.insert(current_speaker_id.clone(), name);
                    }
                }
            }
        }

        let lowered = segment.text.to_lowercase();
        if let Some(captured) = next_pattern.captures(&lowered) {
            if let Some(name_match) = captured.get(1) {
                if let Some(name) = normalize_person_name(name_match.as_str()) {
                    let next_speaker_id = segments.iter().skip(index + 1).find_map(|candidate| {
                        let speaker_id = candidate.speaker_id.as_ref()?;
                        if speaker_id != current_speaker_id {
                            Some(speaker_id.clone())
                        } else {
                            None
                        }
                    });
                    if let Some(next_speaker_id) = next_speaker_id {
                        aliases.entry(next_speaker_id).or_insert(name);
                    }
                }
            }
        }
    }

    aliases
}

fn resolve_speaker_name(
    existing_name: Option<&str>,
    inferred_name: Option<&str>,
    fallback_name: Option<&str>,
    index: usize,
) -> Option<String> {
    if let Some(name) = existing_name {
        if !is_generic_speaker_name(name) {
            return Some(name.trim().to_string());
        }
    }

    if let Some(name) = inferred_name {
        return Some(name.trim().to_string());
    }

    if let Some(name) = existing_name {
        return Some(name.trim().to_string());
    }

    if let Some(name) = fallback_name {
        return Some(name.trim().to_string());
    }

    Some(format!("Speaker {}", index + 1))
}

fn normalize_person_name(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphabetic() && c != '\'' && c != '-' && c != ' ')
        .to_lowercase();

    let blocked_words = [
        "here", "there", "speaking", "next", "up", "and", "with", "from", "the", "a", "an", "you",
        "they", "we",
    ];

    let parts: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|token| !blocked_words.contains(token) && token.len() >= 2)
        .take(2)
        .collect();

    if parts.is_empty() {
        return None;
    }

    let title_cased = parts
        .iter()
        .map(|token| {
            let mut chars = token.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");

    if title_cased.is_empty() {
        None
    } else {
        Some(title_cased)
    }
}

fn is_generic_speaker_name(name: &str) -> bool {
    let trimmed = name.trim().to_lowercase();
    trimmed == "unknown"
        || Regex::new(r"^speaker\s*\d+$")
            .expect("valid speaker regex")
            .is_match(&trimmed)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    fn seg(speaker_id: &str, text: &str) -> models::TranscriptSegment {
        models::TranscriptSegment {
            id: "seg".to_string(),
            start_time: 0.0,
            end_time: 1.0,
            text: text.to_string(),
            speaker_id: Some(speaker_id.to_string()),
            confidence: 0.9,
        }
    }

    #[test]
    fn infers_speaker_name_from_intro_phrase() {
        let segments = vec![seg("S1", "This is jonathan speaking about the roadmap.")];
        let aliases = infer_speaker_aliases_from_segments(&segments);
        assert_eq!(aliases.get("S1").map(String::as_str), Some("Jonathan"));
    }

    #[test]
    fn infers_next_speaker_name() {
        let segments = vec![
            seg("S1", "Next is ro khanan to cover the banking section."),
            seg("S2", "Thank you, let me jump in."),
        ];
        let aliases = infer_speaker_aliases_from_segments(&segments);
        assert_eq!(aliases.get("S2").map(String::as_str), Some("Ro Khanan"));
    }

    #[test]
    fn remote_provider_policy_denies_when_disabled() {
        let denied = enforce_remote_provider_policy(AnalysisProvider::OpenAi, false);
        assert!(denied.is_err());

        let allowed = enforce_remote_provider_policy(AnalysisProvider::Ollama, false);
        assert!(allowed.is_ok());
    }

    #[test]
    fn provider_secret_name_normalization_is_strict() {
        assert_eq!(normalize_provider_secret_name("OpenAI").unwrap(), "openai");
        assert_eq!(
            normalize_provider_secret_name("ollama_cloud").unwrap(),
            "ollama-cloud"
        );
        assert!(normalize_provider_secret_name("ollama").is_err());
        assert!(normalize_provider_secret_name("unknown-provider").is_err());
    }

    #[test]
    fn canonicalize_or_create_requires_absolute_path() {
        let err = canonicalize_or_create_absolute_path(Path::new("relative/path"), "testPath");
        assert!(err.is_err());
    }

    #[test]
    fn structured_analysis_parser_handles_embedded_json() {
        let raw = "analysis:\n{\"response\":\"ok\",\"citations\":[{\"recordingId\":\"r1\",\"startTime\":1.0,\"endTime\":2.0,\"text\":\"hello\",\"certainty\":0.9}]}";
        let parsed = parse_structured_analysis_json(raw).expect("parser should extract payload");
        assert_eq!(parsed.0, "ok");
        assert_eq!(parsed.1.len(), 1);
    }

    #[test]
    fn structured_citation_validation_requires_matching_segment() {
        let context = vec![AnalysisContextSegment {
            recording_id: "r1".to_string(),
            recording_title: "A".to_string(),
            segment_id: "s1".to_string(),
            text: "budget went up".to_string(),
            start_time: 1.0,
            end_time: 2.0,
        }];

        let unresolved = vec![StructuredCitationPayload {
            recording_id: Some("r2".to_string()),
            start_time: Some(4.0),
            end_time: Some(6.0),
            text: Some("missing".to_string()),
            certainty: Some(0.7),
        }];

        assert!(validate_structured_citations(&unresolved, &context).is_err());

        let resolved = vec![StructuredCitationPayload {
            recording_id: Some("r1".to_string()),
            start_time: Some(1.0),
            end_time: Some(2.0),
            text: Some("budget went up".to_string()),
            certainty: Some(1.5),
        }];
        let validated = validate_structured_citations(&resolved, &context)
            .expect("matching citation should validate");
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].recording_id.as_deref(), Some("r1"));
        assert_eq!(validated[0].certainty, Some(1.0));
    }
}

fn default_speaker_color(index: usize) -> String {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#6366F1", "#14B8A6",
    ];
    COLORS[index % COLORS.len()].to_string()
}

async fn default_dictation_start_options(state: &AppState) -> models::DictationStartOptions {
    let settings_manager = state.settings_manager.lock().await;
    dictation_options_from_settings(settings_manager.settings())
}

fn dictation_options_from_settings(settings: &settings::Settings) -> models::DictationStartOptions {
    models::DictationStartOptions {
        save_to_inbox: settings.transcription.dictation_save_to_inbox,
        project_id: Some(settings.transcription.dictation_project_id.clone()),
        profile: dictation_profile_from_settings_value(&settings.transcription.dictation_profile),
    }
}

fn dictation_profile_to_settings_value(profile: &models::DictationProfile) -> &'static str {
    match profile {
        models::DictationProfile::Speed => "speed",
        models::DictationProfile::Accuracy => "accuracy",
    }
}

fn dictation_profile_from_settings_value(value: &str) -> models::DictationProfile {
    match value {
        "accuracy" => models::DictationProfile::Accuracy,
        _ => models::DictationProfile::Speed,
    }
}

async fn emit_streaming_transcription_previews(
    app: &AppHandle,
    streaming_transcriber: Arc<streaming::StreamingTranscriber>,
    asr_manager: Arc<asr::AsrManager>,
    recording_id: &str,
    audio_path: &Path,
) -> Result<(), String> {
    let mut reader = hound::WavReader::open(audio_path).map_err(|e| {
        format!(
            "Failed to open recording '{}' for streaming preview: {}",
            audio_path.display(),
            e
        )
    })?;
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return Err("Streaming preview requires non-zero sample rate".to_string());
    }
    if spec.channels == 0 {
        return Err("Streaming preview requires at least one channel".to_string());
    }

    let provider = asr_manager.get_default_provider().await;
    let selected_model_id = asr_manager.selected_model_id().await;
    let (session_id, mut result_rx) = streaming_transcriber
        .start_session(provider, spec.sample_rate, selected_model_id)
        .await
        .map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let event_recording_id = recording_id.to_string();
    let receiver_task = tokio::spawn(async move {
        while let Some(result) = result_rx.recv().await {
            if result.text.trim().is_empty() {
                continue;
            }
            if let Err(error) = app_handle.emit(
                "recording-transcription-stream",
                serde_json::json!({
                    "recordingId": &event_recording_id,
                    "isPartial": result.is_partial,
                    "isFinal": result.is_final,
                    "text": result.text,
                    "startTime": result.start_time,
                    "endTime": result.end_time,
                    "confidence": result.confidence,
                }),
            ) {
                tracing::warn!("Failed to emit streaming preview event: {}", error);
                break;
            }
        }
    });

    let preview_limit_frames = (STREAMING_PREVIEW_MAX_SECONDS * spec.sample_rate as f64) as usize;
    let chunk_size = (spec.sample_rate / 2).max(1) as usize; // 0.5s chunks
    let channel_count = spec.channels as usize;
    let mut mono_chunk: Vec<f32> = Vec::with_capacity(chunk_size);
    let mut channel_accumulator: Vec<f32> = Vec::with_capacity(channel_count);
    let mut frames_processed = 0usize;

    for sample in reader.samples::<i16>() {
        let normalized = sample.map_err(|e| e.to_string())? as f32 / i16::MAX as f32;
        channel_accumulator.push(normalized);
        if channel_accumulator.len() < channel_count {
            continue;
        }

        let mono = channel_accumulator.iter().copied().sum::<f32>() / channel_count as f32;
        channel_accumulator.clear();
        mono_chunk.push(mono);
        frames_processed += 1;

        if mono_chunk.len() >= chunk_size {
            streaming_transcriber
                .feed_audio(&session_id, &mono_chunk)
                .await
                .map_err(|e| e.to_string())?;
            mono_chunk.clear();
        }
        if frames_processed >= preview_limit_frames {
            break;
        }
    }

    if !mono_chunk.is_empty() {
        streaming_transcriber
            .feed_audio(&session_id, &mono_chunk)
            .await
            .map_err(|e| e.to_string())?;
    }

    let _ = streaming_transcriber
        .finalize_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = receiver_task.await;
    Ok(())
}

fn compute_wav_duration_seconds_from_bytes(audio_data: &[u8]) -> i64 {
    let cursor = std::io::Cursor::new(audio_data);
    match hound::WavReader::new(cursor) {
        Ok(reader) => {
            let spec = reader.spec();
            if spec.sample_rate == 0 {
                return 0;
            }
            (reader.duration() as f64 / spec.sample_rate as f64).round() as i64
        }
        Err(error) => {
            tracing::warn!(
                "Failed to compute in-memory dictation duration from bytes: {}",
                error
            );
            0
        }
    }
}

async fn persist_benchmark_results(state: &AppState, results: &[asr::BenchmarkResult]) {
    if results.is_empty() {
        return;
    }

    let model_id = state.asr_manager.selected_model_id().await;
    let mut entries = Vec::new();
    for result in results {
        let runtime = state
            .asr_manager
            .get_runtime_diagnostics(result.provider_type)
            .await;
        entries.push(models::AsrBenchmarkEntry {
            id: uuid::Uuid::new_v4().to_string(),
            provider_type: asr_provider_to_settings_value(result.provider_type).to_string(),
            provider_name: result.provider_name.clone(),
            model_id: model_id.clone(),
            runtime_status: format!("{:?}", runtime.runtime_status).to_lowercase(),
            processing_time_ms: result.processing_time_ms as i64,
            confidence: result.confidence,
            created_at: chrono::Utc::now(),
        });
    }

    let mut db = state.db.lock().await;
    for entry in entries {
        if let Err(error) = db.save_asr_benchmark(&entry) {
            tracing::warn!("Failed to persist ASR benchmark entry: {}", error);
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StructuredCitationPayload {
    recording_id: Option<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    text: Option<String>,
    certainty: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
struct StructuredAnalysisPayload {
    response: String,
    citations: Vec<StructuredCitationPayload>,
}

fn parse_structured_analysis_json(raw: &str) -> Option<(String, Vec<StructuredCitationPayload>)> {
    let parse_direct = serde_json::from_str::<StructuredAnalysisPayload>(raw).ok();
    let payload = if let Some(value) = parse_direct {
        value
    } else {
        let start = raw.find('{')?;
        let end = raw.rfind('}')?;
        if start >= end {
            return None;
        }
        serde_json::from_str::<StructuredAnalysisPayload>(&raw[start..=end]).ok()?
    };

    Some((payload.response, payload.citations))
}

fn validate_structured_citations(
    citations: &[StructuredCitationPayload],
    context_segments: &[AnalysisContextSegment],
) -> Result<Vec<llm::Citation>, String> {
    if citations.is_empty() {
        return Err("Model returned no citations".to_string());
    }

    let mut validated = Vec::new();

    for citation in citations {
        let text = citation.text.as_deref().map(str::trim).unwrap_or_default();
        let record_filter = citation
            .recording_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let matched = context_segments.iter().find(|segment| {
            if let Some(recording_id) = record_filter {
                if segment.recording_id != recording_id {
                    return false;
                }
            }

            let timing_match = if let (Some(start), Some(end)) =
                (citation.start_time, citation.end_time)
            {
                (segment.start_time - start).abs() <= 0.75 && (segment.end_time - end).abs() <= 0.75
            } else {
                true
            };

            if !timing_match {
                return false;
            }

            if text.is_empty() {
                return true;
            }

            let seg_text = segment.text.to_lowercase();
            let cit_text = text.to_lowercase();
            seg_text.contains(&cit_text) || cit_text.contains(&seg_text)
        });

        let Some(segment) = matched else {
            return Err("Model returned unresolved citation payload".to_string());
        };

        let certainty = citation
            .certainty
            .map(|value| value.clamp(0.0, 1.0))
            .unwrap_or(0.85);

        validated.push(llm::Citation {
            text: if text.is_empty() {
                segment.text.clone()
            } else {
                text.to_string()
            },
            start_time: Some(segment.start_time),
            end_time: Some(segment.end_time),
            recording_id: Some(segment.recording_id.clone()),
            certainty: Some(certainty),
        });
    }

    Ok(validated)
}

fn asr_provider_to_settings_value(provider: asr::AsrProviderType) -> &'static str {
    match provider {
        asr::AsrProviderType::Whisper => "whisper",
        asr::AsrProviderType::Parakeet => "parakeet",
        asr::AsrProviderType::Canary => "canary",
        asr::AsrProviderType::DistilWhisper => "distil_whisper",
        asr::AsrProviderType::Moonshine => "moonshine",
        asr::AsrProviderType::VibeVoice => "vibevoice",
        asr::AsrProviderType::Voxtral => "voxtral",
        asr::AsrProviderType::ElevenLabsScribe => "elevenlabs_scribe",
        asr::AsrProviderType::OpenAiCloud => "openai_cloud",
    }
}

fn asr_provider_from_settings_value(value: &str) -> Option<asr::AsrProviderType> {
    match value {
        "whisper" => Some(asr::AsrProviderType::Whisper),
        "parakeet" => Some(asr::AsrProviderType::Parakeet),
        "canary" => Some(asr::AsrProviderType::Canary),
        "distil_whisper" => Some(asr::AsrProviderType::DistilWhisper),
        "moonshine" => Some(asr::AsrProviderType::Moonshine),
        "vibevoice" => Some(asr::AsrProviderType::VibeVoice),
        "voxtral" => Some(asr::AsrProviderType::Voxtral),
        "elevenlabs_scribe" => Some(asr::AsrProviderType::ElevenLabsScribe),
        "openai_cloud" => Some(asr::AsrProviderType::OpenAiCloud),
        _ => None,
    }
}

fn template_format_extension(format: &export::templates::ExportFormat) -> &'static str {
    match format {
        export::templates::ExportFormat::Markdown => "md",
        export::templates::ExportFormat::PlainText => "txt",
        export::templates::ExportFormat::Html => "html",
        export::templates::ExportFormat::Json => "json",
        export::templates::ExportFormat::Csv => "csv",
        export::templates::ExportFormat::Pdf => "pdf",
    }
}

fn compute_wav_duration_seconds(audio_path: &str) -> i64 {
    match hound::WavReader::open(audio_path) {
        Ok(reader) => {
            let spec = reader.spec();
            if spec.sample_rate == 0 {
                return 0;
            }
            (reader.duration() as f64 / spec.sample_rate as f64).round() as i64
        }
        Err(error) => {
            tracing::warn!(
                "Failed to compute recording duration for '{}': {}",
                audio_path,
                error
            );
            0
        }
    }
}

fn canonicalize_existing_absolute_path(raw_path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!(
            "{} must be an absolute path, got '{}'",
            label, trimmed
        ));
    }
    if !candidate.exists() {
        return Err(format!("{} does not exist: '{}'", label, trimmed));
    }

    candidate
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {} '{}': {}", label, trimmed, e))
}

fn nautilus_data_root() -> Result<PathBuf, String> {
    let root = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Nautilus");
    std::fs::create_dir_all(&root).map_err(|e| {
        format!(
            "Failed to prepare Nautilus data root '{}': {}",
            root.display(),
            e
        )
    })?;
    Ok(root.canonicalize().unwrap_or(root))
}

fn approved_path_roots() -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();

    roots.push(nautilus_data_root()?);

    let config_root = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("Nautilus");
    if let Err(e) = std::fs::create_dir_all(&config_root) {
        tracing::warn!(
            "Failed to prepare Nautilus config root '{}': {}",
            config_root.display(),
            e
        );
    } else {
        roots.push(config_root.canonicalize().unwrap_or(config_root));
    }

    let documents_base = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Could not find documents directory")?;
    let documents_root = documents_base.join("Nautilus");
    if let Err(e) = std::fs::create_dir_all(&documents_root) {
        tracing::warn!(
            "Failed to prepare Nautilus documents root '{}': {}",
            documents_root.display(),
            e
        );
    } else {
        roots.push(documents_root.canonicalize().unwrap_or(documents_root));
    }

    if roots.is_empty() {
        return Err("No approved Nautilus roots are available".to_string());
    }
    Ok(roots)
}

fn ensure_path_in_approved_roots(path: &Path, label: &str) -> Result<(), String> {
    let roots = approved_path_roots()?;
    if roots.iter().any(|root| path.starts_with(root)) {
        return Ok(());
    }

    Err(format!(
        "{} '{}' is outside approved Nautilus roots",
        label,
        path.display()
    ))
}

fn open_path_in_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("Failed to launch 'open' for '{}': {}", path.display(), e))?;

    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch Windows opener for '{}': {}",
                path.display(),
                e
            )
        })?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open")
        .arg(path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch 'xdg-open' for '{}': {}",
                path.display(),
                e
            )
        })?;

    if !status.success() {
        return Err(format!(
            "Default app open command failed for '{}'",
            path.display()
        ));
    }

    Ok(())
}

struct PasteOutcome {
    pasted: bool,
    copied: bool,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
fn check_accessibility_permission() -> bool {
    std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get name of first process")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    tracing::info!("Copying {} chars to clipboard", text.len());

    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let mut pbcopy = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch pbcopy: {}", e))?;
        if let Some(stdin) = pbcopy.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("Failed to write text to clipboard: {}", e))?;
        }
        let copy_status = pbcopy
            .wait()
            .map_err(|e| format!("Failed waiting for pbcopy: {}", e))?;
        if !copy_status.success() {
            return Err("pbcopy exited with failure status".to_string());
        }
        tracing::info!("Successfully copied to clipboard via pbcopy");
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};

        let mut clip = Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch clip.exe: {}", e))?;
        if let Some(stdin) = clip.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("Failed to write text to clipboard: {}", e))?;
        }
        let status = clip
            .wait()
            .map_err(|e| format!("Failed waiting for clip.exe: {}", e))?;
        if !status.success() {
            return Err("clip.exe exited with failure status".to_string());
        }
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = text;
        Err("Clipboard copy is not implemented on this platform yet.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_text() -> Result<String, String> {
    let output = std::process::Command::new("pbpaste")
        .output()
        .map_err(|e| format!("Failed to launch pbpaste: {}", e))?;
    if !output.status.success() {
        return Err("pbpaste exited with failure status".to_string());
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Clipboard data was not utf-8: {}", e))
}

#[cfg(target_os = "macos")]
fn send_native_paste_key() -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    std::thread::sleep(std::time::Duration::from_millis(50));

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "Failed to create event source for paste".to_string())?;

    let keycode_v: CGKeyCode = 9;
    let key_down = CGEvent::new_keyboard_event(source.clone(), keycode_v, true)
        .map_err(|_| "Failed to create key down event".to_string())?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    std::thread::sleep(std::time::Duration::from_millis(20));

    let key_up = CGEvent::new_keyboard_event(source, keycode_v, false)
        .map_err(|_| "Failed to create key up event".to_string())?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);

    tracing::info!("Cmd+V keystroke posted successfully");
    Ok(())
}

fn paste_text_systemwide(text: &str) -> PasteOutcome {
    tracing::info!("paste_text_systemwide called with {} chars", text.len());

    let original_clipboard = {
        #[cfg(target_os = "macos")]
        {
            read_clipboard_text().ok()
        }
        #[cfg(not(target_os = "macos"))]
        {
            None::<String>
        }
    };

    if let Err(error) = copy_to_clipboard(text) {
        tracing::error!("Failed to copy to clipboard: {}", error);
        return PasteOutcome {
            pasted: false,
            copied: false,
            error: Some(error),
        };
    }
    tracing::info!("Text copied to clipboard successfully");

    #[cfg(target_os = "macos")]
    {
        if !check_accessibility_permission() {
            tracing::warn!("Accessibility permission not granted - cannot simulate paste");
            return PasteOutcome {
                pasted: false,
                copied: true,
                error: Some("Copied to clipboard. To insert at cursor, grant Accessibility permission in System Settings > Privacy & Security > Accessibility.".to_string()),
            };
        }

        let paste_result = send_native_paste_key();
        let restore_result = if let Some(previous) = original_clipboard {
            copy_to_clipboard(&previous)
        } else {
            Ok(())
        };

        if let Err(error) = paste_result {
            tracing::error!("Paste key simulation failed: {}", error);
            let remediation = format!(
                "Copied to clipboard. macOS blocked keystroke paste ({}). Grant Accessibility in System Settings > Privacy & Security > Accessibility.",
                error
            );
            if let Err(restore_error) = restore_result {
                tracing::warn!(
                    "Failed to restore previous clipboard after paste failure: {}",
                    restore_error
                );
            }
            return PasteOutcome {
                pasted: false,
                copied: true,
                error: Some(remediation),
            };
        }

        if let Err(restore_error) = restore_result {
            tracing::warn!("Failed to restore previous clipboard: {}", restore_error);
        }

        tracing::info!("Paste successful - text inserted at cursor");
        PasteOutcome {
            pasted: true,
            copied: true,
            error: None,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        PasteOutcome {
            pasted: false,
            copied: true,
            error: Some(
                "Copied to clipboard. System-wide paste is currently supported on macOS only."
                    .to_string(),
            ),
        }
    }
}
