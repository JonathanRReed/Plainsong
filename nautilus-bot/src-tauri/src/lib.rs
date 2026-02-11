mod asr;
mod audio;
mod backup;
mod crypto;
mod db;
mod diarization;
mod download;
mod export;
mod integrations;
mod llm;
mod models;
mod performance;
mod secrets;
mod settings;
mod streaming;
mod text;
mod transcription;

use anyhow::Result;
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
    dictation_overlay_state: Arc<StdMutex<DictationOverlayState>>,
    recording_overlay_state: Arc<StdMutex<RecordingOverlayState>>,
}

const DICTATION_OVERLAY_LABEL: &str = "dictation-overlay";
const RECORDING_OVERLAY_LABEL: &str = "recording-overlay";
const DICTATION_MAX_DURATION_SECONDS: u64 = 120;

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
        return Ok(());
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
    let (audio_path, transcript_opt) = {
        let db = state.db.lock().await;
        let recording = db
            .get_recording(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?;
        let transcript = db.get_transcript(&recordingId).map_err(|e| e.to_string())?;
        (std::path::PathBuf::from(recording.audio_path), transcript)
    };

    let diarization = diarization::run_diarization(&audio_path)
        .await
        .map_err(|e| e.to_string())?;

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
async fn start_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    start_dictation_session(state.inner(), &app, "manual")
        .await
        .map(|_| ())
}

#[tauri::command]
async fn stop_dictation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    stop_dictation_session(state.inner(), &app, "manual", false).await
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

    emit_recording_state(&app, "idle", None, None, None, None);
    hide_overlay_window(&app, RECORDING_OVERLAY_LABEL);

    // Trigger transcription in background using ASR manager
    let asr_manager = Arc::clone(&state.asr_manager);
    let db_clone = Arc::clone(&state.db);
    let settings_manager_clone = Arc::clone(&state.settings_manager);
    let recording_id_clone = recordingId.clone();
    let audio_path_clone = audio_path.clone();

    tokio::spawn(async move {
        let path = std::path::PathBuf::from(&audio_path_clone);
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
        if recording.duration <= 0 && !recording.audio_path.trim().is_empty() {
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

    open_path_in_default_app(&canonical_audio)?;

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

    crate::audio::waveform::generate_waveform_from_file(
        &recording.audio_path,
        points.unwrap_or(400),
    )
    .map(|data| data.samples)
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn analyze_recording(
    state: tauri::State<'_, AppState>,
    recordingId: String,
    query: String,
    model: Option<String>,
) -> Result<llm::AnalysisResult, String> {
    let transcript = {
        let db = state.db.lock().await;
        db.get_transcript(&recordingId)
            .map_err(|e| e.to_string())?
            .ok_or("Transcript not found")?
    };

    // Use Ollama for analysis
    let model = model.unwrap_or_else(|| "llama3.2".to_string());
    let mut result = state
        .ollama_client
        .analyze_transcript(&transcript.full_text, &query, &model)
        .await
        .map_err(|e| e.to_string())?;

    hydrate_citation_ranges(&mut result, &transcript.segments);
    if result.citations.is_empty() {
        result.citations = fallback_citations_from_response(&result.response, &transcript.segments);
    }

    // Log audit event
    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "query": &query,
        "model": &model
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

    let model = model.unwrap_or_else(|| "llama3.2".to_string());
    let summary = state
        .ollama_client
        .summarize(&transcript.full_text, &model)
        .await
        .map_err(|e| e.to_string())?;

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

    let model = model.unwrap_or_else(|| "llama3.2".to_string());
    let items = state
        .ollama_client
        .extract_action_items(&transcript.full_text, &model)
        .await
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
async fn get_ollama_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.ollama_client.is_available().await)
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

    let export_path =
        transcription::export(&recording, transcript.as_ref(), &format, target.as_deref())
            .map_err(|e| e.to_string())?;

    // Log audit event
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "format": &format,
        "target": target,
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

    let redaction_level = redactionLevel.unwrap_or_else(|| "basic".to_string());
    let preview_mode = preview.unwrap_or(false);
    let result = transcription::export_with_policy(
        &recording,
        transcript.as_ref(),
        &audit_log,
        &format,
        target.as_deref(),
        &redaction_level,
        preview_mode,
    )
    .map_err(|e| e.to_string())?;

    let details = serde_json::json!({
        "recording_id": &recordingId,
        "format": &format,
        "target": &target,
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
    Ok(state.asr_manager.get_runtime_diagnostics(providerType).await)
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
        let diagnostics = state.asr_manager.get_runtime_diagnostics(providerType).await;
        return Err(format!(
            "{}",
            diagnostics
                .runtime_message
                .unwrap_or_else(|| format!("ASR provider '{}' is not available in this build", provider.name()))
        ));
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
    state: tauri::State<'_, AppState>,
    providerType: asr::AsrProviderType,
) -> Result<(), String> {
    state
        .asr_manager
        .download_models(providerType)
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
    Ok(state.asr_manager.benchmark_providers(&path).await)
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
    state: tauri::State<'_, AppState>,
    settings: settings::Settings,
) -> Result<(), String> {
    state
        .asr_manager
        .set_selected_model_id(settings.transcription.selected_model_id.clone())
        .await;
    state
        .asr_manager
        .set_allow_whisper_fallback(settings.transcription.allow_whisper_fallback)
        .await;

    if let Some(provider_type) =
        asr_provider_from_settings_value(&settings.transcription.default_provider)
    {
        let provider = state.asr_manager.get_provider(provider_type).await;
        if provider.is_available()
            && asr::AsrManager::is_provider_transcription_enabled(provider_type)
        {
            state.asr_manager.set_default_provider(provider_type).await;
        }
    }

    let mut settings_manager = state.settings_manager.lock().await;
    *settings_manager.settings_mut() = settings;
    settings_manager.save().map_err(|e| e.to_string())
}

#[tauri::command]
async fn has_provider_secret(provider: String) -> Result<bool, String> {
    secrets::has_provider_secret(&provider).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_provider_secret(provider: String, secret: String) -> Result<(), String> {
    secrets::set_provider_secret(&provider, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_provider_secret(provider: String) -> Result<(), String> {
    secrets::clear_provider_secret(&provider).map_err(|e| e.to_string())
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
) -> Result<String, String> {
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

    let result = state
        .template_manager
        .render(&templateId, &render_data)
        .map_err(|e| e.to_string())?;

    Ok(result)
}

// Waveform commands
#[tauri::command]
async fn generate_waveform_svg(
    _state: tauri::State<'_, AppState>,
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

    let data = waveform::generate_waveform_from_file(&canonical_path.to_string_lossy(), 200)
        .map_err(|e| e.to_string())?;

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
) -> Result<u64, String> {
    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Idle {
            return Err("Dictation is already active".to_string());
        }
        *runtime_state = DictationSessionState::Recording;
    }

    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.next_session_id += 1;
        tracker.active_session_id = Some(tracker.next_session_id);
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

    let result = match state.asr_manager.transcribe_bytes(&audio_data).await {
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
        let done_message = if let Some(error_message) = paste_error.as_deref() {
            Some(error_message)
        } else {
            None
        };
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
        "outcome": outcome
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

#[cfg(target_os = "macos")]
fn is_dictation_hotkey_pressed_macos() -> bool {
    use core_graphics::event::CGKeyCode;
    use core_graphics::event_source::CGEventSourceStateID;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: CGEventSourceStateID, key: CGKeyCode) -> bool;
    }

    unsafe {
        let state_id = CGEventSourceStateID::CombinedSessionState;
        let space_down = CGEventSourceKeyState(state_id, 49); // space
        let control_down =
            CGEventSourceKeyState(state_id, 59) || CGEventSourceKeyState(state_id, 62); // left/right ctrl
        let command_down =
            CGEventSourceKeyState(state_id, 55) || CGEventSourceKeyState(state_id, 54); // left/right cmd
        let shift_down = CGEventSourceKeyState(state_id, 56) || CGEventSourceKeyState(state_id, 60); // left/right shift
        space_down && shift_down && (control_down || command_down)
    }
}

async fn handle_global_dictation_pressed(app: AppHandle) {
    let state = app.state::<AppState>();
    let current_state = *state.dictation_runtime_state.lock().await;
    if current_state != DictationSessionState::Idle {
        return;
    }

    {
        let active = state.dictation_hotkey_active.lock().await;
        if *active {
            return;
        }
    }
    set_dictation_hotkey_flags(state.inner(), true, true).await;

    let session_id = match start_dictation_session(state.inner(), &app, "hotkey").await {
        Ok(id) => id,
        Err(error) => {
            set_dictation_hotkey_flags(state.inner(), false, false).await;
            if !error.to_lowercase().contains("already in progress") {
                tracing::warn!("Failed to start hotkey dictation: {}", error);
                emit_dictation_state(&app, "error", None, Some(&error), None, None, None, None);
            }
            return;
        }
    };

    spawn_hotkey_release_fallback_monitor(app.clone(), session_id);
}

async fn handle_global_dictation_released(app: AppHandle) {
    let state = app.state::<AppState>();
    set_dictation_hotkey_flags(state.inner(), false, false).await;

    let session_id = match active_dictation_session_id(state.inner()).await {
        Some(value) => value,
        None => return,
    };

    let current_state = *state.dictation_runtime_state.lock().await;
    if current_state != DictationSessionState::Recording {
        return;
    }

    if let Err(error) =
        stop_dictation_session_for_session(state.inner(), &app, session_id, "released", true).await
    {
        tracing::warn!("Failed to stop hotkey dictation: {}", error);
        let normalized = error.to_lowercase();
        if !normalized.contains("stale") && !normalized.contains("no active dictation session") {
            let _ = force_stop_dictation_session(state.inner(), &app, "forced").await;
        }
    }
}

async fn active_dictation_session_id(state: &AppState) -> Option<u64> {
    state.dictation_session_tracker.lock().await.active_session_id
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

fn spawn_hotkey_release_fallback_monitor(app: AppHandle, session_id: u64) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = session_id;
        return;
    }

    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;

        loop {
            tokio::time::sleep(Duration::from_millis(75)).await;

            let state = app.state::<AppState>();
            let active_session = active_dictation_session_id(state.inner()).await;
            if active_session != Some(session_id) {
                break;
            }

            let current_state = *state.dictation_runtime_state.lock().await;
            if current_state != DictationSessionState::Recording {
                break;
            }

            if !is_dictation_hotkey_pressed_macos() {
                tracing::warn!(
                    "Global hotkey release event was missed; stopping dictation via key-state fallback"
                );
                if let Err(error) = stop_dictation_session_for_session(
                    state.inner(),
                    &app,
                    session_id,
                    "released",
                    true,
                )
                .await
                {
                    tracing::warn!("Fallback stop failed: {}", error);
                    let normalized = error.to_lowercase();
                    if !normalized.contains("stale")
                        && !normalized.contains("no active dictation session")
                    {
                        let _ = force_stop_dictation_session(state.inner(), &app, "forced").await;
                    }
                }
                break;
            }
        }
    });
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            db: Arc::new(Mutex::new(
                db::Database::new().expect("Failed to initialize database"),
            )),
            audio_capture: Arc::new(Mutex::new(audio::AudioCapture::new())),
            asr_manager: Arc::new(asr::AsrManager::new()),
            ollama_client: Arc::new(llm::OllamaClient::new()),
            integration_manager: Arc::new(integrations::IntegrationManager::new()),
            settings_manager: Arc::new(Mutex::new(
                settings::SettingsManager::new().expect("Failed to initialize settings"),
            )),
            backup_manager: Arc::new(Mutex::new(backup::BackupManager::default())),
            template_manager: Arc::new(export::templates::TemplateManager::new()),
            dictation_hotkey_active: Arc::new(Mutex::new(false)),
            dictation_release_pending: Arc::new(AtomicBool::new(false)),
            dictation_watchdog_generation: Arc::new(Mutex::new(0)),
            dictation_session_tracker: Arc::new(Mutex::new(DictationSessionTracker::default())),
            dictation_runtime_state: Arc::new(Mutex::new(DictationSessionState::Idle)),
            dictation_overlay_state: Arc::new(StdMutex::new(DictationOverlayState::default())),
            recording_overlay_state: Arc::new(StdMutex::new(RecordingOverlayState::default())),
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            tauri::async_runtime::block_on(async {
                let (configured_provider, selected_model_id, allow_whisper_fallback) = {
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

                if let Some(provider_type) =
                    asr_provider_from_settings_value(&configured_provider)
                {
                    let provider = state.asr_manager.get_provider(provider_type).await;
                    if provider.is_available()
                        && asr::AsrManager::is_provider_transcription_enabled(provider_type)
                    {
                        state.asr_manager.set_default_provider(provider_type).await;
                    } else if !asr::AsrManager::is_provider_transcription_enabled(provider_type) {
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
            });

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

                let ctrl_shift_space =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                let ctrl_shift_n =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                let ctrl_shift_escape =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Escape);
                #[cfg(target_os = "macos")]
                let cmd_shift_space =
                    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);

                let mut shortcut_bindings = vec![
                    ctrl_shift_space.clone(),
                    ctrl_shift_n.clone(),
                    ctrl_shift_escape.clone(),
                ];
                #[cfg(target_os = "macos")]
                shortcut_bindings.push(cmd_shift_space.clone());

                match tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(shortcut_bindings)
                {
                    Ok(builder) => {
                        let result = app.handle().plugin(
                            builder
                                .with_handler(move |_app, shortcut, event| {
                                    if shortcut == &ctrl_shift_n
                                        && matches!(event.state(), ShortcutState::Pressed)
                                    {
                                        if let Err(error) = show_main_window(_app) {
                                            tracing::warn!(
                                                "Failed to show main window from shortcut: {}",
                                                error
                                            );
                                        }
                                        return;
                                    }

                                    if shortcut == &ctrl_shift_escape
                                        && matches!(event.state(), ShortcutState::Pressed)
                                    {
                                        let app_handle = _app.clone();
                                        tauri::async_runtime::spawn(async move {
                                            let state = app_handle.state::<AppState>();
                                            let current_state = *state.dictation_runtime_state.lock().await;
                                            if current_state != DictationSessionState::Idle {
                                                let _ = force_stop_dictation_session(
                                                    state.inner(),
                                                    &app_handle,
                                                    "emergency",
                                                )
                                                .await;
                                            }
                                        });
                                        return;
                                    }

                                    #[cfg(target_os = "macos")]
                                    let is_dictation_shortcut =
                                        shortcut == &ctrl_shift_space || shortcut == &cmd_shift_space;
                                    #[cfg(not(target_os = "macos"))]
                                    let is_dictation_shortcut = shortcut == &ctrl_shift_space;

                                    if !is_dictation_shortcut {
                                        return;
                                    }

                                    match event.state() {
                                        ShortcutState::Pressed => {
                                            tracing::info!("Global hotkey pressed: {:?}", shortcut);
                                            _app.emit("dictation-hotkey-pressed", ()).ok();
                                            let app_handle = _app.clone();
                                            tauri::async_runtime::spawn(async move {
                                                handle_global_dictation_pressed(app_handle).await;
                                            });
                                        }
                                        ShortcutState::Released => {
                                            tracing::info!("Global hotkey released: {:?}", shortcut);
                                            _app.emit("dictation-hotkey-released", ()).ok();
                                            let app_handle = _app.clone();
                                            tauri::async_runtime::spawn(async move {
                                                handle_global_dictation_released(app_handle).await;
                                            });
                                        }
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
            summarize_recording,
            extract_action_items,
            get_ollama_status,
            list_ollama_models,
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
            get_settings,
            save_settings,
            has_provider_secret,
            set_provider_secret,
            clear_provider_secret,
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
}

fn default_speaker_color(index: usize) -> String {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#6366F1", "#14B8A6",
    ];
    COLORS[index % COLORS.len()].to_string()
}

fn asr_provider_to_settings_value(provider: asr::AsrProviderType) -> &'static str {
    match provider {
        asr::AsrProviderType::Whisper => "whisper",
        asr::AsrProviderType::Parakeet => "parakeet",
        asr::AsrProviderType::Canary => "canary",
        asr::AsrProviderType::DistilWhisper => "distil_whisper",
    }
}

fn asr_provider_from_settings_value(value: &str) -> Option<asr::AsrProviderType> {
    match value {
        "whisper" => Some(asr::AsrProviderType::Whisper),
        "parakeet" => Some(asr::AsrProviderType::Parakeet),
        "canary" => Some(asr::AsrProviderType::Canary),
        "distil_whisper" => Some(asr::AsrProviderType::DistilWhisper),
        _ => None,
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

fn hydrate_citation_ranges(
    result: &mut llm::AnalysisResult,
    segments: &[models::TranscriptSegment],
) {
    for citation in &mut result.citations {
        if citation.start_time.is_some() && citation.end_time.is_some() {
            continue;
        }
        let citation_text = citation.text.trim().to_lowercase();
        if citation_text.is_empty() {
            continue;
        }
        if let Some(segment) = segments.iter().find(|segment| {
            let segment_text = segment.text.to_lowercase();
            segment_text.contains(&citation_text) || citation_text.contains(&segment_text)
        }) {
            citation.start_time = Some(segment.start_time);
            citation.end_time = Some(segment.end_time);
        }
    }
}

fn fallback_citations_from_response(
    response: &str,
    segments: &[models::TranscriptSegment],
) -> Vec<llm::Citation> {
    use std::collections::HashSet;

    let tokens: HashSet<String> = response
        .split(|c: char| !c.is_alphanumeric())
        .map(|token| token.trim().to_lowercase())
        .filter(|token| token.len() >= 5)
        .collect();

    let mut scored: Vec<(&models::TranscriptSegment, usize)> = segments
        .iter()
        .map(|segment| {
            let seg_text = segment.text.to_lowercase();
            let score = tokens
                .iter()
                .filter(|token| seg_text.contains(*token))
                .count();
            (segment, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();

    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.truncate(3);

    scored
        .into_iter()
        .map(|(segment, _)| llm::Citation {
            text: segment.text.clone(),
            start_time: Some(segment.start_time),
            end_time: Some(segment.end_time),
        })
        .collect()
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

fn copy_to_clipboard(text: &str) -> Result<(), String> {
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
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = text;
        return Err("Clipboard copy is not implemented on Windows yet.".to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = text;
        return Err("Clipboard copy is not implemented on this platform yet.".to_string());
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

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "Failed to create event source for paste".to_string())?;

    let keycode_v: CGKeyCode = 9;
    let key_down = CGEvent::new_keyboard_event(source.clone(), keycode_v, true)
        .map_err(|_| "Failed to create key down event".to_string())?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source, keycode_v, false)
        .map_err(|_| "Failed to create key up event".to_string())?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}

fn paste_text_systemwide(text: &str) -> PasteOutcome {
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
        return PasteOutcome {
            pasted: false,
            copied: false,
            error: Some(error),
        };
    }

    #[cfg(target_os = "macos")]
    {
        let paste_result = send_native_paste_key();
        let restore_result = if let Some(previous) = original_clipboard {
            copy_to_clipboard(&previous)
        } else {
            Ok(())
        };

        if let Err(error) = paste_result {
            let remediation = format!(
                "Copied only. macOS blocked keystroke paste ({error}). Run the packaged Nautilus app and grant Accessibility to Nautilus."
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

        return PasteOutcome {
            pasted: true,
            copied: true,
            error: None,
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        PasteOutcome {
            pasted: false,
            copied: true,
            error: Some(
                "Copied only. System-wide paste is currently supported on macOS packaged builds."
                    .to_string(),
            ),
        }
    }
}
