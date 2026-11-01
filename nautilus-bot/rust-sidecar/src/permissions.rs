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
    expected_bundle_id: Option<String>,
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
    let target = (get_frontmost_app_name(), None::<String>);

    validate_qa_insertion_target(expected_bundle_id.as_deref(), target.1.as_deref())?;

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
        "confirmed": outcome.confirmed,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

fn validate_qa_insertion_target(
    expected: Option<&str>,
    actual: Option<&str>,
) -> Result<(), String> {
    let expected = expected
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "QA insertion requires an expected target bundle ID".to_string())?;
    if actual != Some(expected) {
        return Err("QA insertion refused because the frontmost application changed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod qa_insertion_target_tests {
    use super::validate_qa_insertion_target;

    #[test]
    fn qa_insertion_requires_a_known_matching_target_before_delivery() {
        assert!(validate_qa_insertion_target(
            Some("com.apple.TextEdit"),
            Some("com.apple.TextEdit")
        )
        .is_ok());
        for (expected, actual) in [
            (None, Some("com.apple.TextEdit")),
            (Some(" "), Some("com.apple.TextEdit")),
            (Some("com.apple.TextEdit"), None),
            (Some("com.apple.TextEdit"), Some("com.apple.Notes")),
        ] {
            assert!(validate_qa_insertion_target(expected, actual).is_err());
        }
    }
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

#[cfg(any(target_os = "macos", test))]
fn run_accessibility_repair(
    identity: Result<String, String>,
    register: impl FnOnce() -> Result<(), String>,
    reset: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let identity = identity?;
    if !matches!(
        identity.as_str(),
        "com.plainsong.app" | "com.jonathanreed.plainsong.local-qa"
    ) {
        return Err(
            "Permission repair requires a supported Plainsong app bundle identifier.".to_string(),
        );
    }
    register()?;
    reset(&identity)
}

#[cfg(test)]
mod accessibility_repair_target_tests {
    use super::run_accessibility_repair;
    use std::cell::Cell;

    #[test]
    fn resets_exact_running_identity_after_registration() {
        for id in ["com.plainsong.app", "com.jonathanreed.plainsong.local-qa"] {
            let registered = Cell::new(false);
            run_accessibility_repair(
                Ok(id.to_string()),
                || {
                    registered.set(true);
                    Ok(())
                },
                |target| {
                    assert!(registered.get());
                    assert_eq!(target, id);
                    Ok(())
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn invalid_identity_never_registers_or_resets() {
        for identity in [
            Err("unpackaged or missing identifier".to_string()),
            Ok(String::new()),
            Ok(" com.plainsong.app".to_string()),
            Ok("com..plainsong".to_string()),
            Ok("com.foreign.app".to_string()),
            Ok("com.plainsong.app.helper".to_string()),
        ] {
            assert!(run_accessibility_repair(
                identity,
                || panic!("invalid identity must not register"),
                |_| panic!("invalid identity must not reset"),
            )
            .is_err());
        }
    }

    #[test]
    fn registration_failure_never_resets() {
        assert_eq!(
            run_accessibility_repair(
                Ok("com.jonathanreed.plainsong.local-qa".to_string()),
                || Err("registration failed".to_string()),
                |_| panic!("failed registration must not reset"),
            ),
            Err("registration failed".to_string())
        );
    }

    #[test]
    fn reset_failure_is_returned() {
        assert_eq!(
            run_accessibility_repair(
                Ok("com.plainsong.app".to_string()),
                || Ok(()),
                |_| Err("reset failed".to_string()),
            ),
            Err("reset failed".to_string())
        );
    }
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

        let (bundle_path, bundle_id) = crate::text_insert::running_app_bundle_identity()?;
        run_accessibility_repair(
            Ok(bundle_id),
            || crate::text_insert::register_app_bundle(&bundle_path),
            |bundle_id| reset_tcc_service("Accessibility", bundle_id),
        )?;
        notes.push(
            "Reset the macOS Accessibility privacy decision for Plainsong. Re-enable Plainsong in Privacy & Security > Accessibility if macOS shows it turned off."
                .to_string(),
        );

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

#[cfg(any(target_os = "macos", test))]
fn probe_accessibility_status(
    insertion_observed: &std::sync::atomic::AtomicBool,
    probe: impl FnOnce() -> bool,
) -> (bool, bool) {
    (probe(), insertion_observed.load(Ordering::Relaxed))
}

#[cfg(test)]
mod accessibility_authorization_tests {
    use super::*;

    #[test]
    fn fresh_diagnostics_report_revocation_after_successful_insertion() {
        let insertion_observed = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            probe_accessibility_status(&insertion_observed, || true),
            (true, false)
        );
        insertion_observed.store(true, Ordering::Relaxed);
        assert_eq!(
            probe_accessibility_status(&insertion_observed, || true),
            (true, true)
        );
        assert_eq!(
            probe_accessibility_status(&insertion_observed, || false),
            (false, true)
        );
    }
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
        let (accessibility_trusted, cursor_insertion_observed) = probe_accessibility_status(
            &state.accessibility_trust_observed,
            check_accessibility_permission,
        );
        let post_event_ready = check_post_event_access();
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

        let status = std::process::Command::new("/usr/bin/open")
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

        let status = std::process::Command::new("/usr/bin/open")
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
    /// Download size as Finder shows it, for the buttons that offer it.
    pub(crate) download_size: Option<&'static str>,
}

pub(crate) fn list_diarization_models() -> Vec<DiarizationModelOption> {
    #[allow(unused_mut)]
    let mut models = vec![
        DiarizationModelOption {
            id: "ecapa_tdnn_speaker",
            label: diarization::model_label("ecapa_tdnn_speaker"),
            description: "Small and light on memory. Remembers voices.",
            installed: diarization::is_model_available("ecapa_tdnn_speaker"),
            download_size: diarization::model_download_size("ecapa_tdnn_speaker"),
        },
        DiarizationModelOption {
            id: "resnet34_speaker",
            label: diarization::model_label("resnet34_speaker"),
            description: "A small alternative. Remembers voices.",
            installed: diarization::is_model_available("resnet34_speaker"),
            download_size: diarization::model_download_size("resnet34_speaker"),
        },
        DiarizationModelOption {
            id: "campplus_speaker",
            label: diarization::model_label("campplus_speaker"),
            description: "A small alternative. Remembers voices.",
            installed: diarization::is_model_available("campplus_speaker"),
            download_size: diarization::model_download_size("campplus_speaker"),
        },
    ];

    // Offered wherever the ONNX pipeline is compiled in, so the picker never
    // lists a model this build has no code to run.
    #[cfg(feature = "diarization")]
    models.push(DiarizationModelOption {
        id: download::COMMUNITY1_MODEL_ID,
        label: diarization::model_label(download::COMMUNITY1_MODEL_ID),
        description: COMMUNITY1_PICKER_DESCRIPTION,
        installed: diarization::is_model_available(download::COMMUNITY1_MODEL_ID),
        download_size: diarization::model_download_size(download::COMMUNITY1_MODEL_ID),
    });

    #[cfg(feature = "diarization-nemotron")]
    models.push(DiarizationModelOption {
        id: download::NEMOTRON_DIARIZATION_MODEL_ID,
        label: diarization::model_label(download::NEMOTRON_DIARIZATION_MODEL_ID),
        description: "Experimental. Handles up to eight people, including when they talk over each other. Doesn't remember voices. OpenMDW-1.1 license.",
        installed: diarization::is_model_available(download::NEMOTRON_DIARIZATION_MODEL_ID),
        download_size: diarization::model_download_size(download::NEMOTRON_DIARIZATION_MODEL_ID),
    });
    models
}

/// What the picker says about pyannote community-1, shown before anything is
/// downloaded, in the reader's terms: what it is good at and what it costs.
/// The download size is on the picker row itself. The credit is the CC BY 4.0
/// attribution the weights require. "Recommended" only where a new install
/// starts on it (`settings::fresh_install_diarization_model`); everywhere else
/// it runs several times slower, so the description says how slow instead.
/// The renderer prints these descriptions as they are.
#[cfg(all(
    feature = "diarization",
    target_os = "macos",
    target_arch = "aarch64",
    feature = "ort-coreml-ep"
))]
pub(crate) const COMMUNITY1_PICKER_DESCRIPTION: &str = concat!(
    "Recommended. Tells speakers apart even when people talk over each other, ",
    "with no limit on how many. Remembers voices. ",
    "pyannote speaker-diarization-community-1 by pyannote, CC BY 4.0."
);
#[cfg(all(
    feature = "diarization",
    not(all(
        target_os = "macos",
        target_arch = "aarch64",
        feature = "ort-coreml-ep"
    ))
))]
pub(crate) const COMMUNITY1_PICKER_DESCRIPTION: &str = concat!(
    "Tells speakers apart even when people talk over each other, ",
    "with no limit on how many. Remembers voices. ",
    "On this Mac it takes about 8 to 9 minutes per hour of audio ",
    "and up to 0.7 GB of memory. ",
    "pyannote speaker-diarization-community-1 by pyannote, CC BY 4.0."
);

/// What a meeting would do about speakers right now, for the selected model:
/// whether it is downloaded, and which model would actually run (a
/// downloaded stand-in, or none). One answer for the meeting's Download
/// button, the first-run meeting step and the remembered-voices note, so none
/// of them guesses the fallback rule on its own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiarizationModelPlan {
    pub(crate) selected_model_id: String,
    pub(crate) selected_label: String,
    pub(crate) selected_download_size: Option<&'static str>,
    pub(crate) selected_installed: bool,
    /// The model the next run would use; `None` when no speaker model is
    /// downloaded at all.
    pub(crate) run_model_id: Option<String>,
    pub(crate) fallback_notice: Option<String>,
}

pub(crate) fn diarization_model_plan(selected_model_id: &str) -> DiarizationModelPlan {
    let resolved = diarization::resolve_model_for_run(selected_model_id);
    // A turned-off model is never offered for download: setup and the meeting
    // offer the model that runs in its place, or the default when none can.
    let offered_id = if selected_model_id == diarization::LICENSE_BLOCKED_SPEAKER_MODEL_ID {
        resolved
            .as_ref()
            .map(|model| model.model_id.as_str())
            .unwrap_or(diarization::DEFAULT_EMBEDDING_MODEL_ID)
    } else {
        selected_model_id
    };
    DiarizationModelPlan {
        selected_model_id: offered_id.to_string(),
        selected_label: diarization::model_label(offered_id).to_string(),
        selected_download_size: diarization::model_download_size(offered_id),
        selected_installed: is_diarization_model_available(Some(offered_id.to_string())),
        run_model_id: resolved.as_ref().map(|resolved| resolved.model_id.clone()),
        fallback_notice: resolved.and_then(|resolved| resolved.fallback_notice),
    }
}

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

pub(crate) async fn capture_selected_text_for_playback_impl(
    state: &AppState,
    admission_nonce: &str,
) -> Result<Option<String>, String> {
    // Unlike meeting capture's compatibility path, this renderer-facing read
    // primitive is never allowed before the privileged Electron registrar has
    // issued a proof. The proof is short-lived and removed on this call.
    state
        .capture_admission
        .consume_required(admission_nonce)
        .map_err(|_| "Selected text playback admission proof is invalid".to_string())?;

    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(target_os = "windows")]
    let target = (get_frontmost_app_name(), None::<String>);

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

    let resolved = resolve_recording_audio_for_runtime(
        state,
        recording_id,
        RuntimeAudioResolveMode::PlaybackPrimary,
    )
    .await?;
    let resolved =
        crate::meeting_aside_audio::mask_external_audio(state, recording_id, resolved).await?;
    open_path_in_default_app(&resolved.primary)?;
    schedule_recording_audio_bundle_cleanup(
        resolved,
        Duration::from_secs(120),
        runtime_audio_lease,
    );

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": recording_id,
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
