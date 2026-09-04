//! What the app is allowed to do on this Mac, and how to ask.
//!
//! Requesting microphone, accessibility and Apple Speech permission,
//! collecting the diagnostics the Setup screen reads, repairing a cursor-insert
//! grant that the OS is holding stale, the smoke test that proves insertion
//! actually works, and opening the right System Settings pane when it does not.
//! The diarization model picker and a few small "open this for me" handlers sit
//! here because they are the same kind of host interaction.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn validate_shortcut_settings(
    shortcuts: &settings::KeyboardShortcuts,
) -> Result<(), String> {
    settings::validate_dictation_bindings(&shortcuts.dictation_bindings)
}

pub(crate) async fn qa_smoke_test_cursor_insert_impl(
    state: &AppState,
    text: Option<String>,
) -> Result<serde_json::Value, String> {
    if std::env::var_os("PLAINSONG_PACKAGED_QA_APP_MATRIX").as_deref()
        != Some(std::ffi::OsStr::new("1"))
    {
        return Err("Packaged app-matrix insertion is disabled".to_string());
    }
    let sample = text
        .unwrap_or_else(|| "Plainsong app matrix insertion test".to_string())
        .trim()
        .to_string();
    if sample.is_empty() {
        return Err("App-matrix insertion text cannot be empty".to_string());
    }

    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };
    #[cfg(not(target_os = "macos"))]
    let target = (get_frontmost_app_name(), None);

    let outcome = paste_text_systemwide(
        &state.accessibility_trust_observed,
        &sample,
        true,
        target.0.as_deref(),
        target.1.as_deref(),
    );
    Ok(serde_json::json!({
        "text": sample,
        "targetApp": target.0,
        "targetBundleId": target.1,
        "pasted": outcome.pasted,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) async fn request_dictation_permissions_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Err(error) = ensure_microphone_permission(true) {
            notes.push(format!("Microphone permission request result: {}", error));
        }

        let apple_speech_selected = {
            let settings = state.settings_manager.lock().await.settings().clone();
            resolve_transcription_provider_and_model(
                &settings.transcription,
                TranscriptionScope::Dictation,
            )
            .0 == asr::AsrProviderType::MacosAppleSpeech
        };
        if apple_speech_selected {
            if let Err(error) = crate::asr::platform::macos_speech::ensure_speech_authorized(true) {
                notes.push(format!(
                    "Speech recognition permission request result: {}",
                    error
                ));
            }
        }

        if !request_accessibility_permission() {
            notes.push(
                "Accessibility permission is still not granted for this app copy. macOS may require you to re-enable Plainsong under Privacy & Security > Accessibility after app updates."
                    .to_string(),
            );
        }

        if !request_post_event_access() {
            notes.push(
                "macOS native keyboard-event access is still not granted for this app copy. Plainsong may need direct Accessibility text insertion instead."
                    .to_string(),
            );
        }
    }

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(collect_permission_diagnostics(state, notes).await)
}

pub(crate) async fn request_apple_speech_permission_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    if let Err(error) = crate::asr::platform::macos_speech::ensure_speech_authorized(true) {
        notes.push(format!(
            "Speech recognition permission request result: {}",
            error
        ));
    }

    #[cfg(not(target_os = "macos"))]
    notes.push("Apple Speech permission is available on macOS only.".to_string());

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(collect_permission_diagnostics(state, notes).await)
}

/// What the Models screen gets back after asking macOS for a language.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleSpeechLanguageInstallResult {
    install: Option<crate::asr::platform::macos_speech::AppleSpeechAssetInstall>,
    readiness: crate::asr::platform::macos_speech::AppleSpeechReadiness,
    notes: Vec<String>,
}

/// What to tell the reader when a language install ended without installing.
///
/// Stopping on purpose is not a failure: reporting it as one puts a serialized
/// error payload in front of somebody who pressed Cancel and already knows
/// what happened. Everything else keeps the underlying error, which carries
/// the code and details the Models screen needs to say what to do next.
pub(crate) fn apple_speech_install_note(error: &anyhow::Error) -> String {
    if crate::asr::platform::macos_speech::typed_error_code(error).as_deref() == Some("cancelled") {
        return "Language install stopped.".to_string();
    }
    format!("Apple Speech language install failed: {}", error)
}

/// Installs the SpeechAnalyzer assets for one language.
///
/// This is the only place in the app that starts an Apple language download,
/// and it only runs when the reader asks for it. Progress is emitted as it
/// arrives rather than buffered, because the download is the OS's and can take
/// minutes.
pub(crate) async fn install_apple_speech_language_impl(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    locale: Option<&str>,
) -> Result<AppleSpeechLanguageInstallResult, String> {
    let mut notes = Vec::new();
    let install =
        match crate::asr::platform::macos_speech::install_language_assets(locale, |progress| {
            handle.emit_event(
                "apple-speech-language-install-progress",
                serde_json::json!({
                    "stage": progress.stage,
                    "locale": progress.locale,
                    "fraction": progress.fraction,
                    "message": progress.message,
                }),
            );
        })
        .await
        {
            Ok(install) => Some(install),
            Err(error) => {
                notes.push(apple_speech_install_note(&error));
                None
            }
        };

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(AppleSpeechLanguageInstallResult {
        install,
        readiness: crate::asr::platform::macos_speech::fresh_readiness(),
        notes,
    })
}

pub(crate) async fn repair_cursor_insert_permissions_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    {
        state
            .accessibility_trust_observed
            .store(false, Ordering::Relaxed);

        match reset_tcc_service("Accessibility", APP_BUNDLE_IDENTIFIER) {
            Ok(()) => notes.push(
                "Reset the macOS Accessibility privacy decision for Plainsong. Re-enable Plainsong in Privacy & Security > Accessibility if macOS shows it turned off."
                    .to_string(),
            ),
            Err(error) => notes.push(format!(
                "Could not reset the macOS Accessibility privacy decision automatically: {}",
                error
            )),
        }

        if !request_accessibility_permission() {
            notes.push(
                "macOS still has not granted Accessibility to this Plainsong app copy. Turn Plainsong back on in Privacy & Security > Accessibility, then re-check readiness."
                    .to_string(),
            );
        }

        if let Err(error) = open_permission_settings_impl("accessibility") {
            notes.push(format!(
                "Could not open macOS Accessibility settings automatically: {}",
                error
            ));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        notes.push("Cursor insert permission repair is supported on macOS only.".to_string());
    }

    Ok(collect_permission_diagnostics(state, notes).await)
}

pub(crate) fn microphone_setup_ready(input_present: bool, permission_granted: bool) -> bool {
    input_present && permission_granted
}

pub(crate) async fn collect_permission_diagnostics(
    state: &AppState,
    mut notes: Vec<String>,
) -> PermissionDiagnostics {
    let microphone_input_present = {
        let audio = state.audio_capture.lock().await;
        audio.has_microphone_input()
    };

    #[cfg(target_os = "macos")]
    let microphone_permission_ready = check_microphone_permission();

    #[cfg(not(target_os = "macos"))]
    let microphone_permission_ready = microphone_input_present;

    let microphone_ready =
        microphone_setup_ready(microphone_input_present, microphone_permission_ready);

    if !microphone_input_present {
        notes.push("No microphone input device is currently available.".to_string());
    }

    if !microphone_permission_ready {
        notes.push(
            "Microphone permission not granted yet. Enable Plainsong in Privacy & Security > Microphone."
                .to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    let app_bundle_path = current_app_bundle_path().map(|path| path.to_string_lossy().to_string());

    #[cfg(not(target_os = "macos"))]
    let app_bundle_path: Option<String> = None;

    #[cfg(target_os = "macos")]
    let recommended_app_bundle_path =
        installed_nautilus_app_bundle_path().map(|path| path.to_string_lossy().to_string());

    #[cfg(not(target_os = "macos"))]
    let recommended_app_bundle_path: Option<String> = None;

    #[cfg(target_os = "macos")]
    let running_from_disk_image = is_running_from_disk_image();

    #[cfg(not(target_os = "macos"))]
    let running_from_disk_image = false;

    #[cfg(target_os = "macos")]
    if running_from_disk_image {
        let running_path = app_bundle_path
            .as_deref()
            .unwrap_or("/Volumes/.../Plainsong.app");
        if let Some(installed_path) = recommended_app_bundle_path.as_deref() {
            notes.push(format!(
                "Plainsong is running from the mounted disk image at {}. macOS permissions granted to {} do not apply to this copy. Quit this DMG copy and open the installed app instead.",
                running_path, installed_path
            ));
        } else {
            notes.push(format!(
                "Plainsong is running from the mounted disk image at {}. Copy Plainsong.app into /Applications and open that installed copy so macOS permissions apply consistently.",
                running_path
            ));
        }
    }

    #[cfg(target_os = "macos")]
    let speech_recognition_ready = {
        let readiness = crate::asr::platform::macos_speech::readiness();
        let permission_ready = readiness.authorization == "authorized";
        if !readiness.ready {
            notes.push(readiness.message);
            if let Some(action) = readiness.setup_action {
                notes.push(action);
            }
        }
        permission_ready
    };

    #[cfg(not(target_os = "macos"))]
    let speech_recognition_ready = false;

    #[cfg(target_os = "macos")]
    let (
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
    ) = {
        let last_cursor_insert_status = state
            .last_cursor_insert_status
            .lock()
            .ok()
            .and_then(|status| status.clone());
        let accessibility_probe_ready = check_accessibility_permission();
        let post_event_ready = check_post_event_access();
        let cursor_insertion_observed = state.accessibility_trust_observed.load(Ordering::Relaxed);
        let accessibility_trusted = accessibility_probe_ready || cursor_insertion_observed;
        if !accessibility_probe_ready && accessibility_trusted {
            notes.push(
                "Direct Accessibility insertion was verified by Plainsong in this session. The macOS permission probe may be stale for this app copy."
                    .to_string(),
            );
        }
        if let Some(status) = last_cursor_insert_status.as_ref() {
            if status.copied_only {
                let detail = status
                    .message
                    .as_deref()
                    .unwrap_or("Plainsong copied the dictation result but could not post Cmd+V.");
                notes.push(format!(
                    "Latest cursor insert attempt fell back to clipboard-only. {}",
                    detail
                ));
            }
        }
        let automation_ready = false;

        let mut available_insert_strategies = Vec::new();
        if accessibility_trusted {
            available_insert_strategies.push(CursorInsertStrategy::AccessibilityDirectText);
        }
        if accessibility_trusted || post_event_ready {
            available_insert_strategies.push(CursorInsertStrategy::SimulatedTyping);
        }
        let preferred_insert_strategy = available_insert_strategies.first().copied();
        let cursor_insertion_ready = !available_insert_strategies.is_empty();
        let accessibility_ready = accessibility_trusted;
        if !cursor_insertion_ready {
            if running_from_disk_image {
                notes.push(
                    "Cursor insertion is being checked for the currently running DMG copy, not the installed /Applications copy."
                        .to_string(),
                );
            } else {
                notes.push(
                    "Cursor insertion is not ready yet. Enable Plainsong in Privacy & Security > Accessibility so it can insert text into other apps."
                        .to_string(),
                );
            }
        } else if !accessibility_ready && post_event_ready {
            notes.push(
                "Cursor insertion can still work through a native macOS Cmd+V keyboard fallback even though direct Accessibility text insertion is not currently verified."
                    .to_string(),
            );
        }

        (
            accessibility_ready,
            accessibility_trusted,
            post_event_ready,
            automation_ready,
            cursor_insertion_ready,
            cursor_insertion_observed,
            preferred_insert_strategy,
            available_insert_strategies,
            last_cursor_insert_status,
        )
    };

    #[cfg(not(target_os = "macos"))]
    let (
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
    ) = {
        notes.push(
            "Accessibility and automation probes are implemented for macOS first.".to_string(),
        );
        (
            false,
            false,
            false,
            false,
            false,
            false,
            None,
            Vec::new(),
            None,
        )
    };

    PermissionDiagnostics {
        microphone_ready,
        microphone_permission_ready,
        speech_recognition_ready,
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
        running_from_disk_image,
        app_bundle_path,
        recommended_app_bundle_path,
        notes,
    }
}

pub(crate) fn open_permission_settings_impl(section: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = match section {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "speech" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "automation" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
            }
            "system_audio" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            // Notifications are not a Privacy & Security row, so this is the
            // Notifications pane itself rather than a `Privacy_` anchor. The
            // reader lands where Plainsong's own alert style is set.
            "notifications" => {
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
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

pub(crate) fn open_installed_nautilus_app_impl() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_path = installed_nautilus_app_bundle_path()
            .ok_or_else(|| "Installed Plainsong.app was not found in /Applications.".to_string())?;

        let status = std::process::Command::new("open")
            .arg(app_path)
            .status()
            .map_err(|e| format!("Failed to open installed Plainsong.app: {}", e))?;

        if !status.success() {
            return Err("Failed to open installed Plainsong.app".to_string());
        }

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Opening the installed Plainsong app is supported on macOS only.".to_string())
    }
}

// Diarization commands

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiarizationModelOption {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) description: &'static str,
    pub(crate) installed: bool,
}

pub(crate) fn list_diarization_models() -> Vec<DiarizationModelOption> {
    #[allow(unused_mut)]
    let mut models = vec![
        DiarizationModelOption {
            id: "ecapa_tdnn_speaker",
            label: diarization::model_label("ecapa_tdnn_speaker"),
            description: "Fast and accurate, recommended for most use cases (~25 MB)",
            installed: diarization::is_model_available("ecapa_tdnn_speaker"),
        },
        DiarizationModelOption {
            id: "resnet34_speaker",
            label: diarization::model_label("resnet34_speaker"),
            description: "Balanced performance, good accuracy with moderate speed (~30 MB)",
            installed: diarization::is_model_available("resnet34_speaker"),
        },
        DiarizationModelOption {
            id: "campplus_speaker",
            label: diarization::model_label("campplus_speaker"),
            description: "Highest accuracy, best for challenging audio conditions (~35 MB)",
            installed: diarization::is_model_available("campplus_speaker"),
        },
        DiarizationModelOption {
            id: "eres2netv2_speaker",
            label: diarization::model_label("eres2netv2_speaker"),
            description: "Modern int8-quantized embedder, 192-dim, compact (~28 MB)",
            installed: diarization::is_model_available("eres2netv2_speaker"),
        },
    ];

    // Only offered when the backend is compiled in, so the picker never lists
    // a model this build has no code to run. The label says "experimental"
    // because it is: no shipped build enables it, and Plainsong has no DER
    // number of its own for either backend yet.
    #[cfg(feature = "diarization-speakrs")]
    models.push(DiarizationModelOption {
        id: download::SPEAKRS_MODEL_ID,
        label: diarization::model_label(download::SPEAKRS_MODEL_ID),
        description: SPEAKRS_PICKER_DESCRIPTION,
        installed: diarization::is_model_available(download::SPEAKRS_MODEL_ID),
    });

    models
}

/// What the picker says about the experimental speakrs entry, shown in the
/// option itself and therefore before anything is downloaded.
///
/// The licensing sentence is here rather than only in a Rust doc comment and a
/// QA receipt: the person who needs to know that these weights are mirrored
/// without a declared license is the one deciding whether to fetch them.
#[cfg(feature = "diarization-speakrs")]
pub(crate) const SPEAKRS_PICKER_DESCRIPTION: &str = concat!(
    "Full pyannote pipeline with overlap handling, via speakrs. Slower than ",
    "the embedding models and unmeasured on your audio (~60 MB, ten files). ",
    "Model weights mirrored without a declared license; upstream terms are ",
    "CC-BY-4.0 and gated. Not offered in shipped builds until resolved."
);

#[allow(non_snake_case)]
pub(crate) fn is_diarization_model_available(modelId: Option<String>) -> bool {
    let id = modelId
        .as_deref()
        .unwrap_or(diarization::DEFAULT_EMBEDDING_MODEL_ID);
    // An id this build does not offer is not "available": a run would silently
    // load ECAPA-TDNN for it, but telling the UI "yes, you have that model"
    // about a model that does not exist is a different claim. Ids that *are*
    // offered delegate, so the picker's badge, this probe and the gate on the
    // automatic pass give one answer instead of three.
    if !list_diarization_models().iter().any(|model| model.id == id) {
        return false;
    }
    diarization::is_model_available(id)
}

pub(crate) async fn capture_selected_text_for_playback_impl() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(target_os = "windows")]
    let target = (get_frontmost_app_name(), None);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        capture_selected_text_via_clipboard(target.0.as_deref())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Selected text playback is only supported on macOS and Windows.".to_string())
    }
}

pub(crate) async fn open_recording_audio_impl(
    state: &AppState,
    recording_id: &str,
) -> Result<(), String> {
    let runtime_audio_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::RuntimeAudio)?;
    let recording = {
        let db = state.db.lock().await;
        db.get_recording(recording_id)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?
    };

    if recording.audio_path.trim().is_empty() {
        return Err("Recording has no audio file path".to_string());
    }

    let resolved = resolve_recording_audio_bundle_for_runtime(state, recording_id).await?;
    open_path_in_default_app(&resolved.primary)?;
    schedule_recording_audio_bundle_cleanup(
        resolved,
        Duration::from_secs(120),
        runtime_audio_lease,
    );

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": recording_id,
        "audio_path": recording.audio_path,
    });
    if let Err(e) = db.log_audit_event("recording_audio_opened", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

pub(crate) fn open_export_path_impl(target_path: &str) -> Result<(), String> {
    let canonical = canonicalize_existing_absolute_path(target_path, "targetPath")?;
    if !canonical.is_file() {
        return Err(format!(
            "targetPath must point to a file, got: {}",
            canonical.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical, "targetPath")?;
    open_path_in_default_app(&canonical)
}
