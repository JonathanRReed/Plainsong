//! Starting, pausing and stopping a meeting recording.
//!
//! The preconditions a start has to clear (verified system audio, a ready
//! vault), the typed start-failure codes and the rollback that keeps the
//! database honest when a start half-succeeded, the capture and call-detection
//! monitors, the pause span ledger, and the stop path with its storage gate.
//! Also the revalidation that decides whether a recording's audio asset is
//! still there and still usable.
//!
//! Everything here is `pub(crate)` (or `pub`, where it already was) and
//! re-exported from `lib.rs`; the move did not rename or re-sign anything.

use super::*;

pub(crate) fn system_audio_capability_is_verified(
    capability: &audio::system_capture::SystemAudioCapability,
) -> bool {
    capability.ready
        && capability.readiness == audio::system_capture::SystemAudioReadiness::Ready
        && capability.backend != audio::system_capture::SystemAudioBackend::None
}

pub(crate) fn require_verified_system_audio_for_meeting(
    capability: &audio::system_capture::SystemAudioCapability,
) -> Result<(), String> {
    if system_audio_capability_is_verified(capability) {
        return Ok(());
    }

    Err(
        "Me + Them capture is not verified ready. Run Test system audio in Setup, or start this meeting in Mic only mode."
            .to_string(),
    )
}

pub(crate) fn require_recording_vault_ready(
    vault_initialized: bool,
    vault_state: &VaultRuntimeState,
) -> Result<(), String> {
    if vault_initialized && (!vault_state.unlocked || vault_state.recording_key.is_none()) {
        return Err("Unlock the vault before starting a meeting".to_string());
    }
    Ok(())
}

pub(crate) fn recording_activation_failure_updates(
    plan: &recording_audio::RecordingCapturePlan,
    activation_error: &str,
) -> Vec<(
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
)> {
    plan.paths()
        .map(
            |(role, path)| match recording_audio::validate_plaintext_wav(path) {
                recording_audio::RecordingAudioValidation::Ready(metadata) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Failed,
                    Some(metadata),
                    Some(format!("Capture activation failed: {activation_error}")),
                ),
                recording_audio::RecordingAudioValidation::Missing(error) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Missing,
                    None,
                    Some(format!("{activation_error}; {error}")),
                ),
                recording_audio::RecordingAudioValidation::Failed(error) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Failed,
                    None,
                    Some(format!("{activation_error}; {error}")),
                ),
            },
        )
        .collect()
}

pub(crate) fn recording_activation_failure_has_audio(
    updates: &[(
        recording_audio::RecordingAudioRole,
        recording_audio::RecordingAudioLifecycle,
        Option<recording_audio::ValidatedRecordingAudio>,
        Option<String>,
    )],
) -> bool {
    updates
        .iter()
        .any(|(_, lifecycle, _, _)| *lifecycle != recording_audio::RecordingAudioLifecycle::Missing)
}

pub(crate) async fn persist_or_rollback_recording_activation_failure(
    state: &AppState,
    plan: &recording_audio::RecordingCapturePlan,
    activation_error: &str,
) {
    let updates = recording_activation_failure_updates(plan, activation_error);
    if !recording_activation_failure_has_audio(&updates) {
        let bundle = {
            let db = state.db.lock().await;
            db.load_recording_audio_bundle(&plan.recording_id)
        };
        if let Ok(bundle) = bundle {
            let deletion = remove_owned_recording_audio(&bundle, "unstarted recording rollback");
            if deletion.failures.is_empty() && deletion.cleared_roles.len() == updates.len() {
                let mut db = state.db.lock().await;
                let rollback_result = db
                    .set_audio_asset_validation_states(&plan.recording_id, &updates, "error")
                    .and_then(|_| db.delete_recording(&plan.recording_id));
                match rollback_result {
                    Ok(_) => {
                        let _ = db.log_audit_event(
                            "recording_start_rolled_back",
                            Some(serde_json::json!({
                                "recording_id": &plan.recording_id,
                                "error": activation_error,
                                "deleted_audio_files": deletion.deleted_files,
                            })),
                            "warning",
                        );
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(
                            "Failed to roll back unstarted recording '{}': {}",
                            plan.recording_id,
                            error
                        );
                    }
                }
            } else {
                tracing::warn!(
                    "Kept unstarted recording '{}' because its owned audio could not be removed: {}",
                    plan.recording_id,
                    deletion.failures.join("; ")
                );
            }
        }
    }

    let mut db = state.db.lock().await;
    if let Err(error) = db.set_audio_asset_validation_states(&plan.recording_id, &updates, "error")
    {
        tracing::error!(
            "Failed to persist activation failure for recording '{}': {}",
            plan.recording_id,
            error
        );
    }
}

/// Lifecycle for one owned asset after a stop-time failure.
///
/// A stop that fails *after* the WAV is already on disk (a vault key that went
/// away, a database write that lost a race, a join that timed out) says nothing
/// about the audio itself. This used to mark every asset `failed` regardless,
/// and nothing anywhere promotes an asset back to `ready`, so one transient
/// stop-time error permanently condemned a perfectly good meeting recording.
///
/// The file's own validation result decides the lifecycle now. Audio that still
/// reads back as a complete WAV stays `ready` and carries the stop-time error in
/// `last_error` so the failure is still recorded and visible; `failed` is
/// reserved for audio that genuinely did not survive.
pub(crate) fn recording_finalization_failure_update(
    role: recording_audio::RecordingAudioRole,
    validation: recording_audio::RecordingAudioValidation,
    finalization_error: &str,
) -> (
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
) {
    match validation {
        recording_audio::RecordingAudioValidation::Ready(metadata) => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            Some(metadata),
            Some(format!(
                "Recording finalization failed after the audio was saved: {finalization_error}"
            )),
        ),
        recording_audio::RecordingAudioValidation::Missing(error) => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some(format!("{finalization_error}; {error}")),
        ),
        recording_audio::RecordingAudioValidation::Failed(error) => (
            role,
            recording_audio::RecordingAudioLifecycle::Failed,
            None,
            Some(format!("{finalization_error}; {error}")),
        ),
    }
}

pub(crate) async fn persist_recording_finalization_failure(
    state: &AppState,
    recording_id: &str,
    finalization_error: &str,
) {
    let bundle = {
        let db = state.db.lock().await;
        match db.load_recording_audio_bundle(recording_id) {
            Ok(bundle) => bundle,
            Err(error) => {
                tracing::error!(
                    "Failed to load audio assets after finalization failure for '{}': {}",
                    recording_id,
                    error
                );
                return;
            }
        }
    };
    let updates = bundle
        .assets()
        .map(|asset| {
            recording_finalization_failure_update(
                asset.role,
                recording_audio::validate_plaintext_wav(&asset.path),
                finalization_error,
            )
        })
        .collect::<Vec<_>>();
    let salvageable = updates.iter().any(|(role, lifecycle, _, _)| {
        *role == recording_audio::RecordingAudioRole::Primary
            && *lifecycle == recording_audio::RecordingAudioLifecycle::Ready
    });
    let mut db = state.db.lock().await;
    if let Err(error) = db.set_audio_asset_validation_states(recording_id, &updates, "error") {
        tracing::error!(
            "Failed to persist finalization failure for recording '{}': {}",
            recording_id,
            error
        );
        return;
    }
    if salvageable {
        tracing::warn!(
            "Recording {} failed to finalize but its saved audio still validates; it stays recoverable",
            recording_id
        );
        let _ = db.log_audit_event(
            "recording_finalization_failed_audio_retained",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "error": finalization_error,
            })),
            "warning",
        );
    }
}

/// What the filesystem said about one owned asset during a re-validation pass.
///
/// Ciphertext cannot be parsed as a WAV without the vault key, so an encrypted
/// asset is only ever probed for presence. That is enough: the encryption switch
/// only ever runs on an asset that was already `ready`, so a ciphertext file that
/// is still on disk is still the ready audio it was when it was published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecordingAudioProbe {
    Plaintext(recording_audio::RecordingAudioValidation),
    Encrypted { present: bool },
}

/// Repair one asset's lifecycle from what is actually on disk right now.
///
/// This is the only path that can move an asset out of `failed`. Without it a
/// stop-time or startup failure was permanent for the life of the recording.
pub(crate) fn revalidated_recording_audio_update(
    role: recording_audio::RecordingAudioRole,
    probe: RecordingAudioProbe,
) -> (
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
) {
    match probe {
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Ready(
            metadata,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            Some(metadata),
            None,
        ),
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Missing(
            error,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some(error),
        ),
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Failed(
            error,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Failed,
            None,
            Some(error),
        ),
        RecordingAudioProbe::Encrypted { present: true } => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            None,
            None,
        ),
        RecordingAudioProbe::Encrypted { present: false } => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some("Encrypted audio file is absent".to_string()),
        ),
    }
}

pub(crate) fn probe_recording_audio_asset(
    asset: &recording_audio::RecordingAudioAsset,
) -> RecordingAudioProbe {
    match asset.protection {
        recording_audio::RecordingAudioProtection::Plaintext => {
            RecordingAudioProbe::Plaintext(recording_audio::validate_plaintext_wav(&asset.path))
        }
        recording_audio::RecordingAudioProtection::Encrypted => RecordingAudioProbe::Encrypted {
            present: asset.path.is_file(),
        },
    }
}

pub(crate) fn revalidated_recording_audio_updates(
    bundle: &recording_audio::RecordingAudioBundle,
) -> Vec<(
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
)> {
    bundle
        .assets()
        .map(|asset| {
            revalidated_recording_audio_update(asset.role, probe_recording_audio_asset(asset))
        })
        .collect()
}

pub(crate) fn revalidated_recording_audio_is_recoverable(
    updates: &[(
        recording_audio::RecordingAudioRole,
        recording_audio::RecordingAudioLifecycle,
        Option<recording_audio::ValidatedRecordingAudio>,
        Option<String>,
    )],
) -> bool {
    !updates.is_empty()
        && updates.iter().all(|(_, lifecycle, _, _)| {
            *lifecycle == recording_audio::RecordingAudioLifecycle::Ready
        })
}

/// Re-read every owned audio file for one meeting and repair its lifecycle rows.
///
/// This is the user-reachable half of the repair: a meeting whose assets were
/// condemned by a stop-time failure has intact audio on disk but rows that say
/// otherwise, and every runtime resolver refuses anything that is not `ready`.
/// Before this command the only escape was to relaunch the app and hope the
/// startup reconcile covered it, which it did not for a recording already parked
/// in `error`.
///
/// The recording's own status is deliberately left alone. Re-validating audio is
/// evidence about files, not about whether the meeting was transcribed; the user
/// re-transcribes from here if the audio came back ready.
pub(crate) async fn revalidate_recording_audio_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
) -> Result<serde_json::Value, String> {
    let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
        "Recording storage is busy with encryption, backup, deletion, or retention. Try again shortly."
            .to_string()
    })?;

    let recording = {
        let db = state.db.lock().await;
        db.get_recording(recording_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Meeting '{recording_id}' was not found."))?
    };
    if matches!(recording.status.as_str(), "recording" | "processing") {
        return Err(
            "Wait for this meeting to finish capturing and processing before re-checking its audio."
                .to_string(),
        );
    }

    let bundle = {
        let db = state.db.lock().await;
        db.load_recording_audio_bundle(recording_id)
            .map_err(|error| error.to_string())?
    };
    let updates = revalidated_recording_audio_updates(&bundle);
    if updates.is_empty() {
        return Err(format!(
            "Meeting '{recording_id}' no longer owns any audio files to re-check."
        ));
    }
    let recoverable = revalidated_recording_audio_is_recoverable(&updates);
    let repaired_duration = updates
        .iter()
        .find(|(role, _, _, _)| *role == recording_audio::RecordingAudioRole::Primary)
        .and_then(|(_, _, metadata, _)| metadata.as_ref())
        .map(|metadata| metadata.duration_seconds)
        .filter(|duration| *duration > 0);
    let assets = updates
        .iter()
        .map(|(role, lifecycle, _, last_error)| {
            serde_json::json!({
                "role": role.as_str(),
                "lifecycle": lifecycle.as_str(),
                "error": last_error,
            })
        })
        .collect::<Vec<_>>();

    {
        let mut db = state.db.lock().await;
        db.repair_audio_asset_lifecycles(recording_id, &updates, None)
            .map_err(|error| error.to_string())?;
        // A finalization failure can land before the duration was ever written,
        // so a repaired meeting would otherwise read as 0 seconds forever.
        if recording.duration <= 0 {
            if let Some(duration) = repaired_duration {
                if let Err(error) = db.update_recording_duration(recording_id, duration) {
                    tracing::warn!(
                        "Repaired audio for {} but its duration could not be written: {}",
                        recording_id,
                        error
                    );
                }
            }
        }
        let _ = db.log_audit_event(
            "recording_audio_revalidated",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "recoverable": recoverable,
                "assets": &assets,
            })),
            if recoverable { "info" } else { "warning" },
        );
    }

    let message = if recoverable {
        "Saved meeting audio was re-checked and is intact. Re-transcribe this meeting to finish it."
    } else {
        "Saved meeting audio was re-checked and some of it could not be read."
    };
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": recording_id,
            "status": &recording.status,
            "message": message,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    Ok(serde_json::json!({
        "recordingId": recording_id,
        "recoverable": recoverable,
        "message": message,
        "assets": assets,
    }))
}

/// Sidecar-compatible start_recording. Emits state events via SidecarHandle.
/// Overlay show/hide and tray updates are handled by Electron.
/// Verify that this capture was asked for by a real user gesture.
///
/// The nonce used to be validated only as a UUID, which made the check a
/// formality: anything that could reach the command could mint a well-formed
/// proof for itself. It is now redeemed against the registry the privileged
/// Electron side writes to, single use and short lived.
pub(crate) fn authorize_meeting_capture_options(
    capture_admission: &admission::CaptureAdmissionRegistry,
    mut options: models::RecordingOptions,
) -> Result<models::RecordingOptions, String> {
    let nonce = options
        .admission_nonce
        .take()
        .ok_or("Meeting capture requires privileged Electron admission")?;
    uuid::Uuid::parse_str(&nonce)
        .map_err(|_| "Meeting capture admission proof is invalid".to_string())?;

    capture_admission
        .consume(&nonce)
        .map_err(|rejection| rejection.message().to_string())?;

    // Reaching here means a privileged gesture stands behind this capture, which
    // is exactly what the consent prompt attests to.
    options.consent_prompt_shown = true;
    Ok(options)
}

/// Why a meeting failed to start, as a value the renderer can branch on.
///
/// The renderer used to substring-match the error text to decide what advice to
/// show, which quietly broke every time a message was reworded and could never
/// distinguish two failures that happened to share a phrase. These codes are the
/// stable contract; the human-readable message travels alongside, unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingStartErrorCode {
    MicPermissionDenied,
    SystemAudioUnavailable,
    AudioDeviceNotFound,
    SidecarUnavailable,
    DiskFull,
    AlreadyRecording,
    ConsentRequired,
    Unknown,
}

impl MeetingStartErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::MicPermissionDenied => "mic_permission_denied",
            Self::SystemAudioUnavailable => "system_audio_unavailable",
            Self::AudioDeviceNotFound => "audio_device_not_found",
            Self::SidecarUnavailable => "sidecar_unavailable",
            Self::DiskFull => "disk_full",
            Self::AlreadyRecording => "already_recording",
            Self::ConsentRequired => "consent_required",
            Self::Unknown => "unknown",
        }
    }
}

/// Whether a meeting-start failure was really "the disk is full".
///
/// Text matching, because the failure arrives as a flattened `anyhow` chain by
/// the time it reaches the start path and the original `io::Error` (with its
/// `ENOSPC`) is no longer reachable. This classifier exists precisely so the
/// *renderer* never has to do this: the guesswork stays on one line here, behind
/// a typed code, instead of being spread across UI branches that silently stop
/// matching whenever a message is reworded.
pub(crate) fn meeting_start_failure_is_out_of_space(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    // "disk space" is the fragment that catches the capture preflight's own
    // refusal ("Not enough free disk space to record a meeting..."), along with
    // "insufficient disk space" and "out of disk space". Matching the narrower
    // "not enough space" alone missed it.
    normalized.contains("no space left")
        || normalized.contains("not enough space")
        || normalized.contains("insufficient space")
        || normalized.contains("disk space")
        || normalized.contains("disk is full")
        || normalized.contains("free space")
}

/// Announce a meeting-start failure with its typed code, and hand back the
/// human-readable message for the command's `Err`.
///
/// Failures before the recording row exists have no id yet, so `recording_id` is
/// optional; the phase event still carries the code so the renderer can explain
/// the failure without parsing prose.
pub(crate) fn fail_meeting_start(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: Option<&str>,
    code: MeetingStartErrorCode,
    message: String,
) -> String {
    if let Some(recording_id) = recording_id {
        if let Ok(mut overlay) = state.recording_overlay_state.lock() {
            overlay.phase = "error".to_string();
            overlay.dismissed = false;
            overlay.recording_id = Some(recording_id.to_string());
            overlay.message = Some(message.clone());
        }
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "error",
            "recordingId": recording_id,
            "code": code.as_str(),
            "message": &message,
        }),
    );
    // The returned string is what reaches the renderer as the command's error.
    // JSON-RPC carries only a message there, so the typed code rides in a
    // machine-readable prefix that the Electron bridge lifts back onto
    // `error.code` -- the same `PREFIX:` convention `SIDECAR_DUPLICATE:`
    // already uses. Callers that persist or log the failure use `message`
    // directly, before this point, so nothing stores the prefix.
    format!(
        "{}{}:{}",
        MEETING_START_FAILURE_PREFIX,
        code.as_str(),
        message
    )
}

/// Marks a meeting-start error as carrying a typed code.
///
/// Wire form: `MEETING_START_FAILED:<code>:<human message>`.
pub(crate) const MEETING_START_FAILURE_PREFIX: &str = "MEETING_START_FAILED:";

pub(crate) fn emit_meeting_lifecycle_phase(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    phase: &str,
    recording_id: &str,
    message: Option<&str>,
) {
    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = phase.to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.to_string());
        overlay.message = message.map(str::to_string);
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": phase,
            "recordingId": recording_id,
            "message": message,
        }),
    );
}

pub(crate) fn meeting_stop_is_already_terminal_or_processing(status: &str) -> bool {
    matches!(status, "processing" | "completed" | "error")
}

pub(crate) async fn start_recording_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut options: models::RecordingOptions,
) -> Result<String, String> {
    {
        let dictation_state = state.dictation_runtime_state.lock().await;
        if *dictation_state != DictationSessionState::Idle {
            return Err(fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AlreadyRecording,
                "Cannot start recording while dictation is active".to_string(),
            ));
        }
    }
    let capture_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::Capture)
        .map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AlreadyRecording,
                error,
            )
        })?;
    let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::AlreadyRecording,
            "Recording storage is busy with encryption, backup, deletion, or retention. Try again shortly."
                .to_string(),
        )
    })?;

    let settings_snapshot = state.settings_manager.lock().await.settings().clone();
    let meeting_selection = resolve_ready_meeting_selection(
        state,
        &settings_snapshot.transcription,
        settings_snapshot.privacy.remote_processing_enabled,
    )
    .await
    .map_err(|error| {
        // The transcription route is unusable: no model, no runtime, or a
        // remote route the privacy settings forbid.
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::SidecarUnavailable,
            error,
        )
    })?;

    #[cfg(target_os = "macos")]
    if options.mic {
        ensure_microphone_permission(
            settings_snapshot
                .transcription
                .dictation_auto_request_permissions,
        )
        .map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::MicPermissionDenied,
                format!("Microphone permission is not ready. {}", error),
            )
        })?;
    }

    ensure_asr_route_ready(
        state,
        meeting_selection.0,
        &meeting_selection.1,
        "meeting transcription",
    )
    .await
    .map_err(|error| {
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::SidecarUnavailable,
            error,
        )
    })?;

    if options.system_audio {
        let capability = {
            let audio = state.audio_capture.lock().await;
            audio.system_audio_capability()
        };
        require_verified_system_audio_for_meeting(&capability).map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::SystemAudioUnavailable,
                error,
            )
        })?;
    }

    if options.mic && options.preferred_input_device_id.is_none() {
        let settings = state.settings_manager.lock().await.settings().clone();
        options.preferred_input_device_id = settings
            .audio
            .meeting_input_device
            .as_ref()
            .filter(|_| settings.audio.meeting_input_override_enabled)
            .or(settings.audio.preferred_input_device.as_ref())
            .map(|device| device.device_id.clone());
    }

    {
        let vault_state = state.vault_state.lock().await;
        require_recording_vault_ready(settings_snapshot.privacy.vault_initialized, &vault_state)
            .map_err(|error| {
                fail_meeting_start(
                    state,
                    handle,
                    None,
                    MeetingStartErrorCode::ConsentRequired,
                    error,
                )
            })?;
    }

    let plan = {
        let audio = state.audio_capture.lock().await;
        audio.plan_recording(&options).map_err(|error| {
            // Planning fails when neither capture source is usable, which is a
            // device problem rather than a permission or capability one.
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AudioDeviceNotFound,
                error.to_string(),
            )
        })?
    };
    let recording_id = plan.recording_id.clone();
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Meeting - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: options.project_id.clone(),
        duration: 0,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        source_type: "meeting".to_string(),
        audio_path: plan.primary_path.to_string_lossy().to_string(),
        status: "recording".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: options
            .meeting_notes
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        meeting_template_id: options.template.clone(),
        meeting_capture_mode: Some(options.meeting_capture_mode.clone().unwrap_or_else(|| {
            if options.system_audio {
                "me_and_them".to_string()
            } else {
                "mic_only".to_string()
            }
        })),
        // Recorded here, never imported.
        imported_source_name: None,
        notes_updated_at: options
            .meeting_notes
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|_| chrono::Utc::now()),
        consent_prompt_shown: options.consent_prompt_shown,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        attendees: Vec::new(),
        pause_spans: Vec::new(),
        video_service: models::known_video_service(options.video_service.as_deref()),
        transcript_complete: true,
        transcript_degraded_reason: None,
        transcript_incomplete_acknowledged_at: None,
        capture_degraded_summary: None,
    };

    {
        let mut db = state.db.lock().await;
        db.create_recording_with_audio_plan(&recording, &plan)
            .map_err(|error| {
                let message = error.to_string();
                // The capture preflight refuses here when there is not enough
                // room to hold the recording, which is the one failure the user
                // can fix directly.
                let code = if meeting_start_failure_is_out_of_space(&message) {
                    MeetingStartErrorCode::DiskFull
                } else {
                    MeetingStartErrorCode::Unknown
                };
                fail_meeting_start(state, handle, Some(&recording_id), code, message)
            })?;
    }

    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = "preparing".to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.clone());
        overlay.started_at_ms = None;
        overlay.system_audio_active = Some(options.system_audio);
        overlay.consent_prompt_shown = Some(options.consent_prompt_shown);
        overlay.message = Some("Preparing meeting audio capture".to_string());
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "preparing",
            "recordingId": &recording_id,
            "systemAudioActive": options.system_audio,
            "consentPromptShown": options.consent_prompt_shown,
            "message": "Preparing meeting audio capture",
        }),
    );

    let preparation_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.start_recording(plan.clone(), options.clone(), Some(handle.clone()))
    };
    if let Err(error) = preparation_result {
        let message = error.to_string();
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        // Opening the capture devices is where a missing or busy input device
        // shows up, and where a full disk first refuses to create the WAV.
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::AudioDeviceNotFound
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }

    if let Err(error) = {
        let mut db = state.db.lock().await;
        db.mark_audio_assets_writing(&recording_id)
    } {
        let message = format!("Failed to mark recording audio writers active: {error}");
        {
            let mut audio = state.audio_capture.lock().await;
            audio.abort_prepared_recording();
        }
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::Unknown
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }

    let activation_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.activate_recording(&recording_id)
    };
    if let Err(error) = activation_result {
        let message = error.to_string();
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::AudioDeviceNotFound
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }
    *state.active_capture_lease.lock().await = Some((recording_id.clone(), capture_lease));

    let maybe_stream_info = {
        let audio = state.audio_capture.lock().await;
        audio.get_streaming_queue(&recording_id)
    };

    {
        let mut db = state.db.lock().await;
        if let Some(ref template) = options.template {
            if let Ok(mut templates) = state.recording_templates.lock() {
                templates.insert(recording_id.clone(), template.clone());
            }
        }

        let details = serde_json::json!({
            "recording_id": &recording_id,
            "project_id": &options.project_id,
            "mic_enabled": options.mic,
            "system_audio_enabled": options.system_audio
        });
        if let Err(error) = db.log_audit_event("recording_started", Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }

        if options.consent_prompt_shown {
            // Plainsong shows the notice and copies it on request; it never
            // posts it, so the recorded mode is always manual.
            let status = meeting_consent_notice_status(state);
            let _ = db.update_recording_consent_state(
                &recording_id,
                true,
                Some(MEETING_CONSENT_NOTICE_MODE_MANUAL),
                status.surface.as_deref(),
                Some(status.message.as_str()),
            );
        } else {
            let _ = db.update_recording_consent_state(&recording_id, false, None, None, None);
        }
    }

    if let Some((stream_queue, sample_rate)) = maybe_stream_info {
        state.recording_stream_stop.store(false, Ordering::SeqCst);
        let stop_flag = Arc::clone(&state.recording_stream_stop);
        let streaming_transcriber = Arc::clone(&state.streaming_transcriber);
        let streaming_provider = meeting_selection.0;
        let streaming_model_id = meeting_selection.1.clone();
        let emit_handle = handle.clone();
        let rec_id = recording_id.clone();
        tokio::spawn(async move {
            let session_result = streaming_transcriber
                .start_session(streaming_provider, sample_rate, streaming_model_id)
                .await;
            let (session_id, mut result_rx) = match session_result {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("Failed to start live streaming session: {}", e);
                    return;
                }
            };
            let emit_inner = emit_handle.clone();
            let emit_rec_id = rec_id.clone();
            let recv_task = tokio::spawn(async move {
                while let Some(result) = result_rx.recv().await {
                    if !should_emit_streaming_result(&result) {
                        continue;
                    }
                    emit_inner.emit_event(
                        "recording-transcription-stream",
                        streaming_stream_event_payload(&emit_rec_id, &result),
                    );
                }
            });
            let chunk_threshold = (sample_rate as usize) / 2;
            let mut pending: Vec<f32> = Vec::with_capacity(chunk_threshold * 2);
            while !stop_flag.load(Ordering::SeqCst) {
                while let Some(chunk) = stream_queue.pop() {
                    pending.extend_from_slice(&chunk);
                }
                if pending.len() >= chunk_threshold {
                    let feed_slice = std::mem::take(&mut pending);
                    if let Err(e) = streaming_transcriber
                        .feed_audio(&session_id, &feed_slice)
                        .await
                    {
                        tracing::warn!("Live streaming feed error: {}", e);
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            while let Some(chunk) = stream_queue.pop() {
                pending.extend_from_slice(&chunk);
            }
            if !pending.is_empty() {
                let _ = streaming_transcriber
                    .feed_audio(&session_id, &pending)
                    .await;
            }
            let _ = streaming_transcriber.finalize_session(&session_id).await;
            // Finalizing drops the session's sender, so the receiver loop ends
            // on its own. Await it rather than aborting: the closing segment is
            // already in the channel and aborting would drop it in flight.
            if tokio::time::timeout(Duration::from_secs(5), recv_task)
                .await
                .is_err()
            {
                tracing::warn!("Live streaming receiver did not drain within 5s");
            }
        });
    }

    let started_at_ms = chrono::Utc::now().timestamp_millis();

    // Update recording_overlay_state so get_recording_overlay_state returns the correct snapshot.
    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = "recording".to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.clone());
        overlay.started_at_ms = Some(started_at_ms);
        overlay.system_audio_active = Some(options.system_audio);
        overlay.consent_prompt_shown = Some(options.consent_prompt_shown);
        overlay.message = None;
        overlay.paused = false;
        overlay.closed_paused_ms = 0;
        overlay.pause_started_at_ms = None;
    }

    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "recording", "recordingId": &recording_id,
            "startedAtMs": started_at_ms,
            "systemAudioActive": options.system_audio,
            "consentPromptShown": options.consent_prompt_shown,
        }),
    );
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": &recording_id, "status": "recording",
            "updatedAt": chrono::Utc::now().to_rfc3339(),
            "consentPromptShown": options.consent_prompt_shown,
        }),
    );

    // Tell Electron to show the recording overlay window.
    handle.window_command("show-recording-overlay", &serde_json::Value::Null);

    spawn_meeting_capture_monitor(
        Arc::clone(state),
        handle.clone(),
        recording_id.clone(),
        options.detected_call_id,
    );

    Ok(recording_id)
}

/// How often a running meeting's capture health and free disk space are polled.
///
/// Fast enough that a dead writer surfaces while there is still a meeting to
/// salvage, slow enough that the `statvfs` and the audio-capture lock are noise
/// next to the capture threads themselves.
pub(crate) const MEETING_CAPTURE_MONITOR_INTERVAL: Duration = Duration::from_secs(5);

/// Pause or resume the active meeting on behalf of a renderer.
///
/// The capture streams are not touched (see `AudioCapture::pause_recording`);
/// what changes here is everything that reads the pause: the overlay snapshot
/// a reopened window hydrates from, the lifecycle event every live window
/// listens to, and the audit log.
pub(crate) async fn set_recording_paused_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    pause: bool,
) -> Result<serde_json::Value, String> {
    let snapshot = {
        let mut audio = state.audio_capture.lock().await;
        if pause {
            audio.pause_recording(recording_id)
        } else {
            audio.resume_recording(recording_id)
        }
    }
    .map_err(|error| error.to_string())?;

    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.paused = snapshot.paused;
        overlay.closed_paused_ms = snapshot.closed_paused_ms;
        overlay.pause_started_at_ms = snapshot.pause_started_at_ms;
    }
    // Phase stays `recording`: capture is still the live session, the device
    // is still held, and the renderer's reducer keys everything else off the
    // pause fields. A new phase would put every window into a state nothing
    // renders.
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "recording",
            "recordingId": recording_id,
            "paused": snapshot.paused,
            "closedPausedMs": snapshot.closed_paused_ms,
            "pauseStartedAtMs": snapshot.pause_started_at_ms,
        }),
    );
    {
        let mut db = state.db.lock().await;
        // Written on every pause and resume, not only at stop: the audio file
        // skips the pauses, so these spans are the only record of where the
        // gaps are, and a crash mid-meeting used to lose all of them. The
        // ledger is small and the DB lock is already held for the audit event.
        // A failure costs the timeline markers and nothing else, so it does
        // not fail the pause.
        if let Err(error) = db.set_recording_pause_spans(recording_id, &snapshot.spans) {
            tracing::warn!(
                "Failed to persist pause spans for {}: {}",
                recording_id,
                error
            );
        }
        let details = serde_json::json!({
            "recording_id": recording_id,
            "pause_count": snapshot.spans.len(),
            "at_seconds": snapshot.spans.last().map(|span| span.at_seconds),
            "closed_paused_ms": snapshot.closed_paused_ms,
        });
        let event = if pause {
            "recording_paused"
        } else {
            "recording_resumed"
        };
        if let Err(error) = db.log_audit_event(event, Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }
    }
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

/// Why the capture monitor ended a meeting on its own.
pub(crate) enum MeetingAutoStopReason {
    CallEnded { app: &'static str },
    Silence { minutes: u32 },
}

/// End a running meeting for `reason`, saying so on every surface first.
///
/// The `meeting-auto-stopped` event goes out before the stop so the shell can
/// post its notification against a meeting that is still the active one; the
/// stop itself is the ordinary stop path, so the audio lands, is hashed, and
/// goes to transcription exactly as a click on Stop would have it.
pub(crate) async fn auto_stop_meeting(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    reason: MeetingAutoStopReason,
) {
    let (reason_key, message, app, silence_minutes) = match reason {
        MeetingAutoStopReason::CallEnded { app } => (
            "call_ended",
            format!("{app} closed, so Plainsong stopped the meeting and is saving what it captured."),
            Some(app),
            None,
        ),
        MeetingAutoStopReason::Silence { minutes } => (
            "silence",
            format!("Nothing audible for {minutes} minutes, so Plainsong stopped the meeting and is saving what it captured."),
            None,
            Some(minutes),
        ),
    };
    tracing::info!("Auto-stopping meeting {}: {}", recording_id, message);
    handle.emit_event(
        "meeting-auto-stopped",
        serde_json::json!({
            "recordingId": recording_id,
            "reason": reason_key,
            "app": app,
            "silenceMinutes": silence_minutes,
            "message": &message,
        }),
    );
    emit_meeting_capture_warning(state.as_ref(), handle, recording_id, &message);
    {
        let mut db = state.db.lock().await;
        let _ = db.log_audit_event(
            "recording_auto_stopped",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "reason": reason_key,
                "app": app,
                "silence_minutes": silence_minutes,
            })),
            "info",
        );
    }
    if let Err(error) = stop_recording_for_sidecar(state, handle, recording_id.to_string()).await {
        tracing::error!(
            "Failed to auto-stop meeting {} ({}): {}",
            recording_id,
            reason_key,
            error
        );
    }
}

/// How often the running applications are looked at for a live call.
pub(crate) const MEETING_CALL_DETECTION_INTERVAL: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
pub(crate) fn accessibility_granted_for_call_detection() -> bool {
    check_accessibility_permission()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn accessibility_granted_for_call_detection() -> bool {
    false
}

pub(crate) async fn meeting_call_status_for_sidecar(state: &AppState) -> serde_json::Value {
    let enabled = state
        .settings_manager
        .lock()
        .await
        .settings()
        .meetings
        .call_detection_enabled;
    let active_call = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| detector.active().cloned());
    let status = meeting_detect::MeetingCallStatus {
        supported: cfg!(target_os = "macos"),
        enabled,
        accessibility_granted: accessibility_granted_for_call_detection(),
        active_call,
    };
    serde_json::to_value(status).unwrap_or(serde_json::Value::Null)
}

pub(crate) fn emit_meeting_call_ended(
    handle: &crate::sidecar_handle::SidecarHandle,
    call: &meeting_detect::ActiveCall,
    reason: meeting_detect::CallEndReason,
) {
    let mut payload = serde_json::to_value(call).unwrap_or_default();
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert(
            "reason".to_string(),
            serde_json::to_value(reason).unwrap_or_default(),
        );
        map.insert(
            "endedAt".to_string(),
            serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
        );
    }
    tracing::info!(
        "Detected {} call {} ended ({:?})",
        call.app_label,
        call.call_id,
        reason
    );
    handle.emit_event("meeting-call-ended", payload);
}

/// One poll's worth of evidence, gathered off the async runtime because the
/// Accessibility reads can block on an unresponsive app.
#[cfg(target_os = "macos")]
pub(crate) async fn sample_call_detection(
    state: &AppState,
) -> Option<meeting_detect::DetectorSample> {
    // While Plainsong itself holds the microphone, "the input device is open
    // somewhere" is true because of us, and says nothing about anyone else.
    let self_holds_microphone = {
        let audio = state.audio_capture.lock().await;
        audio.is_dictating() || audio.is_recording() || audio.is_hands_free_monitor_active()
    };
    let accessibility_granted = check_accessibility_permission();
    // The browser whose window a call was already found in, so this poll can
    // still see that window close. Every other browser is left alone unless
    // the microphone says something is going on — reading a Chromium browser's
    // windows switches it into full accessibility mode for good.
    let active_call_bundle_id = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| detector.active().map(|call| call.bundle_id.clone()));
    tokio::task::spawn_blocking(move || {
        // The microphone answer comes first: it is what decides whether this
        // poll touches Accessibility at all.
        let mic_running_elsewhere = if self_holds_microphone {
            None
        } else {
            meeting_detect::default_input_device_running_somewhere()
        };
        let apps = meeting_detect::sample_running_apps(
            accessibility_granted,
            mic_running_elsewhere,
            active_call_bundle_id.as_deref(),
        );
        meeting_detect::DetectorSample {
            apps,
            mic_running_elsewhere,
        }
    })
    .await
    .ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn sample_call_detection(
    _state: &AppState,
) -> Option<meeting_detect::DetectorSample> {
    None
}

/// Watch for a live call and say so. Never starts a recording: every event
/// this emits ends in an offer the user has to accept.
///
/// Reads the setting on every pass so turning detection off takes effect
/// within one interval, and reports the call it was tracking as ended for
/// that reason — which no auto-stop acts on.
pub fn spawn_meeting_call_detection(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MEETING_CALL_DETECTION_INTERVAL).await;
            if state.sidecar_shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let enabled = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .call_detection_enabled;
            if !enabled || !cfg!(target_os = "macos") {
                let cleared = state
                    .meeting_call_detector
                    .lock()
                    .ok()
                    .and_then(|mut detector| detector.clear());
                if let Some(call) = cleared {
                    emit_meeting_call_ended(
                        &handle,
                        &call,
                        meeting_detect::CallEndReason::DetectionDisabled,
                    );
                }
                continue;
            }
            let Some(sample) = sample_call_detection(state.as_ref()).await else {
                continue;
            };
            let now_ms = chrono::Utc::now().timestamp_millis();
            let event = state
                .meeting_call_detector
                .lock()
                .ok()
                .and_then(|mut detector| detector.observe(&sample, now_ms));
            match event {
                Some(meeting_detect::DetectorEvent::Detected(call)) => {
                    tracing::info!(
                        "Detected a {} call ({:?} confidence)",
                        call.app_label,
                        call.confidence
                    );
                    handle.emit_event("meeting-call-detected", &call);
                }
                Some(meeting_detect::DetectorEvent::Ended { call, reason }) => {
                    emit_meeting_call_ended(&handle, &call, reason);
                }
                None => {}
            }
        }
    });
}

/// Announce a mid-meeting problem on both channels the user can actually see.
///
/// The lifecycle event deliberately re-asserts the `recording` phase rather than
/// inventing a new one: capture really is still running, and the renderer's
/// lifecycle reducer only understands the phases it already has — an unknown
/// phase would put the overlay into a state nothing renders. The message is what
/// carries the news.
pub(crate) fn emit_meeting_capture_warning(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    message: &str,
) {
    tracing::error!("Meeting {} capture warning: {}", recording_id, message);
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": recording_id,
            "status": "warning",
            "message": message,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );
    emit_meeting_lifecycle_phase(state, handle, "recording", recording_id, Some(message));
}

/// Watch a running meeting's writer threads and the disk they are writing to.
///
/// Nothing else notices a WAV writer that died: the mic-only capture callback
/// discards every later sample through its `Disconnected` arm without a word,
/// the mixed path just shuts capture down, and the overlay keeps showing an
/// active recording either way. The user found out at stop, by which point the
/// meeting was over. This loop is what makes both failures visible while there
/// is still something to salvage.
pub(crate) fn spawn_meeting_capture_monitor(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
    recording_id: String,
    detected_call_id: Option<u64>,
) {
    // The call this meeting is recorded alongside: the one whose offer the
    // reader accepted, and only that one. Bound once, by exact id — a call
    // that merely happens to be live when capture begins is somebody else's
    // call, and its ending must not end this meeting.
    let bound_call = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| {
            meeting_detect::bind_detected_call(detector.active(), detected_call_id)
        });
    tokio::spawn(async move {
        let mut writer_failure_reported = false;
        let mut low_space_reported = false;
        let mut silence_warning_reported = false;
        loop {
            tokio::time::sleep(MEETING_CAPTURE_MONITOR_INTERVAL).await;

            let health = {
                let audio = state.audio_capture.lock().await;
                audio.recording_capture_health(&recording_id)
            };
            // `None` means this recording is no longer the live session, which
            // is the loop's exit condition — stop already reports everything.
            let Some(health) = health else {
                return;
            };

            let meetings_settings = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .clone();
            if let Some((call_id, app)) = bound_call {
                let ended = state
                    .meeting_call_detector
                    .lock()
                    .ok()
                    .and_then(|detector| detector.ended_reason(call_id));
                if meeting_detect::auto_stop_for_call_end(
                    meetings_settings.auto_stop_when_call_app_quits,
                    ended,
                ) {
                    auto_stop_meeting(
                        &state,
                        &handle,
                        &recording_id,
                        MeetingAutoStopReason::CallEnded { app },
                    )
                    .await;
                    return;
                }
            }
            let silence_minutes = meetings_settings.auto_stop_after_silence_minutes;
            if audio::silence_auto_stop_due(&health, silence_minutes) {
                auto_stop_meeting(
                    &state,
                    &handle,
                    &recording_id,
                    MeetingAutoStopReason::Silence {
                        minutes: silence_minutes,
                    },
                )
                .await;
                return;
            }
            // Said at half the fuse rather than only as the meeting ends: the
            // threshold is a heuristic about room tone, and a quiet lecture
            // deserves the chance to answer it while there is still a meeting
            // to save. Re-arms whenever sound comes back, so a second quiet
            // stretch is announced too.
            if let Some(warn_after) = audio::silence_auto_stop_warning_minutes(silence_minutes) {
                if audio::silence_auto_stop_warning_due(&health, silence_minutes) {
                    if !silence_warning_reported {
                        silence_warning_reported = true;
                        emit_meeting_capture_warning(
                            state.as_ref(),
                            &handle,
                            &recording_id,
                            &format!(
                                "No audio for {warn_after} minutes; Plainsong stops this meeting in {} unless sound resumes.",
                                silence_minutes - warn_after
                            ),
                        );
                    }
                } else {
                    silence_warning_reported = false;
                }
            }

            if !writer_failure_reported {
                if let Some(reason) = health.writer_failure.as_deref() {
                    writer_failure_reported = true;
                    emit_meeting_capture_warning(
                        state.as_ref(),
                        &handle,
                        &recording_id,
                        &format!(
                            "Plainsong stopped being able to save this meeting's audio, so nothing recorded from now on is kept. Stop the meeting to keep what was already saved. ({reason})"
                        ),
                    );
                    let mut db = state.db.lock().await;
                    let _ = db.log_audit_event(
                        "recording_writer_failed",
                        Some(serde_json::json!({
                            "recording_id": &recording_id,
                            "error": reason,
                        })),
                        "error",
                    );
                }
            }

            // Fails open: an unmeasurable volume must not end a meeting.
            let Some(available) = ({
                let audio = state.audio_capture.lock().await;
                audio.recordings_available_space_bytes()
            }) else {
                continue;
            };
            // Sized to what this session actually writes: a mic-only meeting
            // writes one track, "me and them" writes three.
            match audio::meeting_space_pressure(available, health.track_count) {
                audio::MeetingSpacePressure::Ok => {}
                audio::MeetingSpacePressure::Low => {
                    if !low_space_reported {
                        low_space_reported = true;
                        emit_meeting_capture_warning(
                            state.as_ref(),
                            &handle,
                            &recording_id,
                            &format!(
                                "This disk is nearly full ({} MB free). Plainsong will stop this meeting on its own before the disk runs out — free some space to keep recording.",
                                available / (1024 * 1024)
                            ),
                        );
                    }
                }
                audio::MeetingSpacePressure::Critical => {
                    emit_meeting_capture_warning(
                        state.as_ref(),
                        &handle,
                        &recording_id,
                        &format!(
                            "This disk is out of space ({} MB free), so Plainsong is stopping the meeting now to save the audio it already captured.",
                            available / (1024 * 1024)
                        ),
                    );
                    {
                        let mut db = state.db.lock().await;
                        let _ = db.log_audit_event(
                            "recording_stopped_low_disk_space",
                            Some(serde_json::json!({
                                "recording_id": &recording_id,
                                "available_bytes": available,
                            })),
                            "error",
                        );
                    }
                    // A deliberate stop lands the WAVs, hashes them and hands
                    // the meeting to transcription. Letting the writer hit
                    // ENOSPC instead loses everything after the last checkpoint.
                    if let Err(error) =
                        stop_recording_for_sidecar(&state, &handle, recording_id.clone()).await
                    {
                        tracing::error!(
                            "Failed to stop meeting {} after running out of disk space: {}",
                            recording_id,
                            error
                        );
                    }
                    return;
                }
            }
        }
    });
}

/// Padding shorter than this is the normal cost of starting and stopping two
/// devices that never open at exactly the same instant, not a source that went
/// away. Reporting it would put a caveat on every healthy mixed meeting.
pub(crate) const MEETING_SOURCE_SILENCE_REPORT_THRESHOLD_SECONDS: f64 = 1.0;

/// One sentence saying what this meeting's audio is actually missing, or `None`
/// when the capture was clean.
///
/// Persisted on the recording and emitted at stop. Both halves matter: a dead
/// input stream truncates the recording, and a mixed session that lost one
/// source keeps running with that source padded to silence — the file cannot
/// tell that apart from a quiet room, so the record has to.
pub(crate) fn describe_recording_capture_degradation(
    capture_failure: Option<&str>,
    degradation: Option<&audio::RecordingSourceDegradation>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(reason) = capture_failure {
        parts.push(format!(
            "A capture stream stopped sending audio during this meeting, so the recording ends early. Audio captured before that point was saved. ({reason})"
        ));
    }
    if let Some(degradation) = degradation {
        for (label, silent_seconds) in [
            ("The microphone", degradation.mic_silent_seconds),
            ("System audio", degradation.system_silent_seconds),
        ] {
            if silent_seconds < MEETING_SOURCE_SILENCE_REPORT_THRESHOLD_SECONDS {
                continue;
            }
            parts.push(format!(
                "{label} delivered nothing for about {}s of this {}s meeting; that stretch is silence in the saved audio, not a quiet room.",
                silent_seconds.round() as i64,
                degradation.captured_seconds.round() as i64
            ));
        }
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Sidecar-compatible stop_recording. Triggers transcription in a background task.
pub(crate) async fn stop_recording_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: String,
) -> Result<(), String> {
    let result = stop_recording_for_sidecar_inner(state, handle, recording_id.clone()).await;
    if let Err(message) = result.as_ref() {
        let owns_stopping_lifecycle = state
            .recording_overlay_state
            .lock()
            .map(|overlay| {
                overlay.recording_id.as_deref() == Some(recording_id.as_str())
                    && overlay.phase == "stopping"
            })
            .unwrap_or(false);
        if owns_stopping_lifecycle {
            {
                let mut db = state.db.lock().await;
                let _ = db.update_recording_status(&recording_id, "error");
            }
            handle.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "status": "error",
                    "message": message,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state.as_ref(),
                handle,
                "error",
                &recording_id,
                Some(message),
            );
        }
    }
    result
}

/// How long stopping a meeting will wait for the audio storage gate before it
/// ends capture anyway.
///
/// Long enough for a short encryption or deletion step already in flight to
/// finish, short enough that the user is never left recording into a
/// still-running retention sweep.
pub(crate) const MEETING_STOP_STORAGE_GATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Take the audio storage gate, or give up after `timeout`.
///
/// Separated from the stop path so the "how long do we wait" policy is testable
/// without an `AppState`; the caller decides what giving up means.
pub(crate) async fn acquire_storage_gate_for_stop(
    gate: &Mutex<()>,
    timeout: Duration,
) -> Option<tokio::sync::MutexGuard<'_, ()>> {
    tokio::time::timeout(timeout, gate.lock()).await.ok()
}

pub(crate) async fn stop_recording_for_sidecar_inner(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: String,
) -> Result<(), String> {
    tracing::info!("stop_recording_for_sidecar called for {}", recording_id);
    let _capture_lease = {
        let mut active_capture = state.active_capture_lease.lock().await;
        match active_capture.as_ref() {
            Some((active_recording_id, _)) if active_recording_id == &recording_id => {}
            Some((active_recording_id, _)) => {
                return Err(format!(
                    "Cannot stop recording '{}'; '{}' is the active capture.",
                    recording_id, active_recording_id
                ));
            }
            None => {
                drop(active_capture);
                let stored_status = {
                    let db = state.db.lock().await;
                    db.get_recording(&recording_id)
                        .map_err(|error| error.to_string())?
                        .map(|recording| recording.status)
                };
                return match stored_status.as_deref() {
                    Some(status) if meeting_stop_is_already_terminal_or_processing(status) => {
                        Ok(())
                    }
                    Some(_) => Err(format!(
                        "Meeting '{}' is not an active capture and is not safely finalized.",
                        recording_id
                    )),
                    None => Err(format!("Meeting '{}' was not found.", recording_id)),
                };
            }
        }
        active_capture
            .take()
            .expect("active capture was checked before take")
            .1
    };
    emit_meeting_lifecycle_phase(
        state.as_ref(),
        handle,
        "stopping",
        &recording_id,
        Some("Stopping capture and saving audio"),
    );

    state.recording_stream_stop.store(true, Ordering::SeqCst);

    // Ending data acquisition must not wait behind a storage sweep. The gate
    // protects the recordings directory from concurrent deletion, backup and
    // encryption work; it protects nothing about the capture streams, which is
    // what keeps holding the microphone and filling the disk while the user is
    // waiting for their meeting to stop. The `StorageMaintenance` lease makes
    // this a rare path, and the timeout means "rare" never becomes "forever".
    let mut storage_guard =
        acquire_storage_gate_for_stop(&state.audio_storage_gate, MEETING_STOP_STORAGE_GATE_TIMEOUT)
            .await;
    if storage_guard.is_none() {
        tracing::warn!(
            "Recording storage was still busy after {:?}; ending capture for {} before taking the gate",
            MEETING_STOP_STORAGE_GATE_TIMEOUT,
            recording_id
        );
        emit_meeting_lifecycle_phase(
            state.as_ref(),
            handle,
            "stopping",
            &recording_id,
            Some("Recording storage is busy. Ending capture now and saving the audio as soon as it frees up."),
        );
    }

    let stop_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.stop_recording(&recording_id)
    };

    // Capture has ended either way, so waiting here costs no more audio. Every
    // durable write below — the finalization-failure path included — happens
    // under the gate.
    if storage_guard.is_none() {
        storage_guard = Some(state.audio_storage_gate.lock().await);
    }
    let _storage_guard = storage_guard;

    let stop_result = match stop_result {
        Ok(result) => result,
        Err(error) => {
            let message = format!("Failed to finalize recording: {error}");
            persist_recording_finalization_failure(state.as_ref(), &recording_id, &message).await;
            return Err(message);
        }
    };

    // The input stream can die mid-meeting — an unplugged microphone, a
    // switched audio device, a sample-rate invalidation. CoreAudio reports it
    // to the error callback and then simply stops delivering samples, so the
    // recording still "succeeds" with a file that is shorter than the elapsed
    // session. Say so instead of presenting a silently truncated meeting as a
    // complete one.
    //
    // The per-source silence padding matters for the same reason and is the only
    // way to say it for a "me and them" meeting: a mixed session keeps running
    // when one source dies, and the padded silence in the file is
    // indistinguishable from a quiet room.
    let capture_degradation = describe_recording_capture_degradation(
        stop_result.capture_failure.as_deref(),
        stop_result.source_degradation.as_ref(),
    );
    if let Some(message) = capture_degradation.as_deref() {
        tracing::error!(
            "Recording {} captured degraded audio: {}",
            recording_id,
            message
        );
        handle.emit_event(
            "recording-status-changed",
            serde_json::json!({
                "recordingId": &recording_id,
                "status": "warning",
                "message": message,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            }),
        );
    }

    let audio_path = stop_result.audio_path.clone();
    let duration_seconds = stop_result
        .validated_assets
        .iter()
        .find(|(role, _)| *role == recording_audio::RecordingAudioRole::Primary)
        .map(|(_, metadata)| metadata.duration_seconds)
        .ok_or_else(|| "Finalized recording has no primary audio metadata".to_string())?;
    {
        let mut db = state.db.lock().await;
        db.finalize_recording_audio(
            &recording_id,
            &stop_result.validated_assets,
            duration_seconds,
            "processing",
            capture_degradation.as_deref(),
        )
        .map_err(|error| error.to_string())?;
        // The audio skips every pause, so this is the only record of where
        // the gaps are; a failure to write it costs the timeline markers and
        // nothing else, so it does not fail the stop.
        if let Err(error) = db.set_recording_pause_spans(&recording_id, &stop_result.pause_spans) {
            tracing::warn!(
                "Failed to persist pause spans for {}: {}",
                recording_id,
                error
            );
        }
        let details = serde_json::json!({
            "recording_id": &recording_id, "audio_path": &audio_path,
            "duration_seconds": duration_seconds,
            "dropped_stream_chunks": stop_result.dropped_stream_chunks,
            "capture_degraded_summary": &capture_degradation,
            "pause_count": stop_result.pause_spans.len(),
            "paused_ms": recording_pause::paused_total_ms(
                &stop_result.pause_spans,
                chrono::Utc::now().timestamp_millis(),
            ),
        });
        if let Err(error) = db.log_audit_event("recording_stopped", Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }
    }

    if let Err(error) =
        encrypt_finalized_recording_audio(state.as_ref(), Some(handle), &recording_id).await
    {
        return Err(format!(
            "Recording was finalized, but vault encryption must be retried before transcription: {error}"
        ));
    }

    emit_meeting_lifecycle_phase(
        state.as_ref(),
        handle,
        "processing",
        &recording_id,
        Some("Processing transcript"),
    );
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": &recording_id, "status": "processing",
            "message": "Processing transcript", "progress": 0.0,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    // Hide the recording overlay. Transcription will happen in the background.
    handle.window_command("hide-recording-overlay", &serde_json::Value::Null);

    let pipeline_state = Arc::clone(state);
    let pipeline_handle = handle.clone();
    let pipeline_recording_id = recording_id.clone();
    let postprocessing_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::PostProcess)?;
    let audio_postprocessing_guard = MeetingAudioPostprocessingGuard::coordinated(
        Arc::clone(&state.active_meeting_audio_postprocessing),
        &recording_id,
        postprocessing_lease,
    );
    tokio::spawn(async move {
        run_meeting_transcription_pipeline(
            Arc::clone(&pipeline_state),
            pipeline_handle,
            pipeline_recording_id,
            audio_postprocessing_guard,
        )
        .await;
    });

    Ok(())
}
