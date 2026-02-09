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
use std::sync::Arc;
use tauri::Emitter;
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

    if let Some(mut transcript) = transcript_opt {
        let engine = diarization::DiarizationEngine::new();
        engine.merge_with_transcript(&diarization, &mut transcript.segments);

        let mut db = state.db.lock().await;
        db.update_transcript_segments(&recordingId, &transcript.segments)
            .map_err(|e| e.to_string())?;
    }

    {
        let mut db = state.db.lock().await;
        for speaker in &diarization.speakers {
            db.upsert_speaker_alias(
                &recordingId,
                &speaker.id,
                speaker.name.as_deref(),
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
async fn start_dictation(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut audio = state.audio_capture.lock().await;
    audio.start_dictation().map_err(|e| e.to_string())?;

    // Log audit event
    let mut db = state.db.lock().await;
    if let Err(e) = db.log_audit_event("dictation_started", None, "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

#[tauri::command]
async fn stop_dictation(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let audio_data = {
        let mut audio = state.audio_capture.lock().await;
        audio.stop_dictation().map_err(|e| e.to_string())?
    };

    // Use ASR manager for transcription
    let result = state
        .asr_manager
        .transcribe_bytes(&audio_data)
        .await
        .map_err(|e| e.to_string())?;

    // Log audit event
    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "model": &result.model_name,
        "language": &result.language,
        "text_length": result.text.len()
    });
    if let Err(e) = db.log_audit_event("dictation_completed", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(result.text)
}

#[tauri::command]
async fn start_recording(
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

    Ok(recording_id)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn stop_recording(
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
    db.update_recording_path(&recordingId, &audio_path)
        .map_err(|e| e.to_string())?;

    // Log audit event with hash
    let details = serde_json::json!({
        "recording_id": &recordingId,
        "audio_path": &audio_path,
        "content_hash": &content_hash
    });
    if let Err(e) = db.log_audit_event("recording_stopped", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    // Trigger transcription in background using ASR manager
    let asr_manager = Arc::clone(&state.asr_manager);
    let db_clone = Arc::clone(&state.db);
    let recording_id_clone = recordingId.clone();
    let audio_path_clone = audio_path.clone();

    tokio::spawn(async move {
        let path = std::path::PathBuf::from(&audio_path_clone);
        match asr_manager.transcribe(&path).await {
            Ok(result) => {
                tracing::info!("Transcription completed for {}", recording_id_clone);

                // Save transcript to database
                let mut db = db_clone.lock().await;

                // Clone values before moving into struct
                let model_name_clone = result.model_name.clone();
                let language_clone = result.language.clone();

                let transcript = models::Transcript {
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
                    created_at: chrono::Utc::now(),
                };

                if let Err(e) = db.save_transcript(&transcript) {
                    tracing::error!("Failed to save transcript: {}", e);
                }

                if let Err(e) = db.update_recording_status(&recording_id_clone, "completed") {
                    tracing::error!("Failed to update recording status: {}", e);
                }

                // Log audit event
                let details = serde_json::json!({
                    "recording_id": &recording_id_clone,
                    "model": &model_name_clone,
                    "language": &language_clone
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
    let db = state.db.lock().await;
    db.get_recordings(projectId.as_deref())
        .map_err(|e| e.to_string())
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
    let path = std::path::Path::new(&targetPath);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Nautilus");
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let canonical_str = canonical.to_string_lossy();
    if !canonical.starts_with(&data_dir) && !canonical.starts_with(&home_dir) {
        return Err(format!(
            "Refusing to read file outside user directories: {}",
            canonical_str
        ));
    }
    transcription::verify_evidence_bundle_file(&targetPath).map_err(|e| e.to_string())
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
    let audio_path = db.delete_recording(&recordingId).map_err(|e| e.to_string())?;

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
    let provider = asr::AsrProviderFactory::create(providerType);
    if !provider.is_available() {
        return Err(format!(
            "ASR provider '{}' is not available in this build",
            provider.name()
        ));
    }
    state.asr_manager.set_default_provider(providerType).await;
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

    let path = std::path::PathBuf::from(path);
    manager.delete_model(&path).await.map_err(|e| e.to_string())
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

    let data =
        waveform::generate_waveform_from_file(&recording_path, 200).map_err(|e| e.to_string())?;

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
    let path = std::path::PathBuf::from(data_dir);
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
    let path = std::path::PathBuf::from(data_dir);
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
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .export_backup(&backupId, std::path::Path::new(&targetPath))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
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
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

                let ctrl_shift_space = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

                match tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts([ctrl_shift_space])
                {
                    Ok(builder) => {
                        let result = app.handle().plugin(
                            builder
                                .with_handler(move |_app, shortcut, event| {
                                    match event.state() {
                                        ShortcutState::Pressed => {
                                            tracing::info!("Global hotkey pressed: {:?}", shortcut);
                                            _app.emit("dictation-hotkey-pressed", ()).ok();
                                        }
                                        ShortcutState::Released => {
                                            tracing::info!("Global hotkey released: {:?}", shortcut);
                                            _app.emit("dictation-hotkey-released", ()).ok();
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
        .invoke_handler(tauri::generate_handler![
            start_dictation,
            stop_dictation,
            start_recording,
            stop_recording,
            get_recordings,
            get_recording,
            get_transcript,
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
            get_default_asr_provider,
            set_default_asr_provider,
            download_asr_models,
            benchmark_asr_providers,
            get_audit_log,
            download_whisper_model,
            list_downloaded_models,
            delete_model,
            get_available_space,
            check_system_audio_availability,
            get_loopback_device_name,
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

fn default_speaker_color(index: usize) -> String {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#6366F1", "#14B8A6",
    ];
    COLORS[index % COLORS.len()].to_string()
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
