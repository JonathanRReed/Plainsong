//! Importing an audio file as a meeting.
//!
//! Probing the file's duration, converting it with `afconvert` under a poll
//! loop that cannot wedge the sidecar, staging the converted WAV where a
//! recording's audio belongs, and persisting the one meeting row that results.
//! `audio_import_tests` moves with the code it covers.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

/// Everything an "Import audio…" produces before the database sees it: the
/// planned recording id and audio path, the title taken from the file, and the
/// converted WAV's validated metadata.
#[derive(Debug)]
pub(crate) struct PreparedAudioImport {
    plan: recording_audio::RecordingCapturePlan,
    title: String,
    source_file_name: String,
    validated: recording_audio::ValidatedRecordingAudio,
}

/// Said when the import path is reached on a platform that has no `afconvert`.
pub(crate) const IMPORT_UNSUPPORTED_PLATFORM: &str =
    "Importing an audio file is not supported on this platform yet. It uses macOS' own audio decoder.";

/// Ask macOS how long a file is without decoding it.
///
/// Plain `afinfo`, not `afinfo --brief`: the brief report has no
/// `estimated duration:` line at all, so the previous invocation always parsed
/// to `None`, the caller treated that as "unknown, carry on", and the four-hour
/// guard never ran -- a nine-hour file was decoded in full before anything
/// refused it. Both report shapes are parsed anyway, so a future macOS that
/// changes which one carries the number still gets a length.
///
/// A length nobody can state is a refusal, not a pass. Refusing costs an
/// unreadable file an error it was going to get from `afconvert` a moment
/// later; passing costs an unbounded decode.
pub(crate) fn probe_audio_duration_seconds(path: &Path) -> Result<f64, String> {
    if !cfg!(target_os = "macos") {
        return Err(IMPORT_UNSUPPORTED_PLATFORM.to_string());
    }
    let output = std::process::Command::new("/usr/bin/afinfo")
        .arg(path)
        .output()
        .map_err(|error| format!("Plainsong could not run the macOS audio inspector: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    audio_import::parse_afinfo_duration_seconds(&stdout)
        .or_else(|| audio_import::parse_afinfo_duration_seconds(&stderr))
        .ok_or_else(|| audio_import::unreadable_duration_message(&stderr))
}

/// How often the conversion is checked for having finished. Short enough that
/// a two-second file still returns promptly, long enough that an eight-hour
/// budget is not a spin loop.
pub(crate) const AFCONVERT_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(50);

/// Run macOS' `afconvert` to decode `source` into `destination`, giving up
/// after `timeout`.
///
/// The timeout is the point of this function. `afconvert` is spawned rather
/// than run to completion with `Command::output()` because the caller holds
/// the audio storage gate and the PostProcess lease for the whole call: a
/// source on a network volume that stops answering used to block here forever,
/// and retention, vault migration, backup and every other meeting's
/// post-processing waited behind it until the sidecar was restarted. The IPC
/// budget cancelling the caller did not help -- nothing killed the child.
pub(crate) fn run_afconvert(
    source: &Path,
    destination: &Path,
    timeout: std::time::Duration,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(IMPORT_UNSUPPORTED_PLATFORM.to_string());
    }
    let mut child = std::process::Command::new("/usr/bin/afconvert")
        .args(audio_import::afconvert_args(source, destination))
        // stdout is discarded rather than piped: nothing reads it until the
        // child exits, and an unread pipe that fills would hang the very wait
        // this function exists to bound. afconvert says nothing there anyway --
        // verified that its refusals ("Error: Couldn't open input file") go to
        // stderr, which stays piped because that sentence is what the reader
        // needs.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Plainsong could not run the macOS audio converter: {error}"))?;

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Plainsong lost track of the macOS audio converter: {error}"
                ));
            }
        }
        if std::time::Instant::now() >= deadline {
            // Kill first, then reap, so the caller's locks are released with no
            // orphan still writing into the recordings folder behind them.
            let _ = child.kill();
            let _ = child.wait();
            return Err(audio_import::conversion_timeout_message(timeout));
        }
        std::thread::sleep(AFCONVERT_POLL_INTERVAL);
    };

    let stderr = child
        .stderr
        .take()
        .map(|mut pipe| {
            use std::io::Read;
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
        .unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    // afconvert reports a codec it cannot read on stderr; the reader needs
    // that sentence, not just an exit code.
    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("the converter gave no reason")
        .to_string();
    Err(format!("macOS could not decode that audio file: {detail}"))
}

/// Validate a chosen audio file and decode it into the recordings store.
///
/// Deliberately free of `AppState` and of the database so the whole
/// file-to-recording step can be tested against a generated WAV in a temp
/// directory without a recognizer, a model, or a running sidecar.
pub(crate) fn prepare_audio_import(
    source_path: &Path,
    recordings_dir: &Path,
) -> Result<PreparedAudioImport, String> {
    audio_import::validate_import_extension(source_path)?;
    let metadata = std::fs::symlink_metadata(source_path).map_err(|error| {
        format!(
            "Plainsong could not read '{}': {}",
            source_path.display(),
            error
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err("Choose an audio file, not a folder or a link.".to_string());
    }
    audio_import::validate_import_size(metadata.len())?;
    // Before anything is decoded: a length macOS will not state is a refusal,
    // and the length it does state is what the 4-hour guard, the conversion
    // timeout and the free-space estimate are all derived from.
    let probed_seconds = probe_audio_duration_seconds(source_path)?;
    audio_import::validate_import_duration(probed_seconds)?;

    std::fs::create_dir_all(recordings_dir).map_err(|error| {
        format!(
            "Failed to prepare the recordings folder '{}': {}",
            recordings_dir.display(),
            error
        )
    })?;
    // Refuse a conversion the volume cannot hold rather than filling the disk
    // and failing halfway, which would also take down any meeting recording
    // into the same folder.
    if let Some(needed) = audio_import::import_space_shortfall(
        probed_seconds,
        crate::download::available_space_for_path(recordings_dir).ok(),
    ) {
        return Err(audio_import::insufficient_space_message(needed));
    }
    // One mic-shaped track: an imported file is a single source, so the plan
    // has a primary path and no per-source companions.
    let plan = recording_audio::RecordingCapturePlan::new(recordings_dir, true, false)
        .map_err(|error| error.to_string())?;
    // Armed until the converted WAV has been read back successfully, so a
    // refused, timed-out or corrupt import leaves nothing behind in the store.
    let converted = recording_audio::DurableTempFile::new(plan.primary_path.clone());
    run_afconvert(
        source_path,
        &plan.primary_path,
        audio_import::import_conversion_timeout(probed_seconds),
    )?;
    let validated = match recording_audio::validate_plaintext_wav(&plan.primary_path) {
        recording_audio::RecordingAudioValidation::Ready(metadata) => metadata,
        recording_audio::RecordingAudioValidation::Missing(reason)
        | recording_audio::RecordingAudioValidation::Failed(reason) => {
            return Err(format!(
                "Plainsong could not read the converted audio: {reason}"
            ));
        }
    };
    // The authoritative duration check: afinfo above is an estimate, this is
    // the file the pipeline will actually transcribe.
    audio_import::validate_import_duration(validated.duration_seconds as f64)?;
    let _ = converted.disarm();

    Ok(PreparedAudioImport {
        title: audio_import::import_title_from_file_name(source_path),
        source_file_name: source_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        plan,
        validated,
    })
}

/// Turn a prepared import into the meeting row the pipeline will pick up.
///
/// `consent_prompt_shown` stays false: nobody was in the room when Plainsong
/// got this audio, so claiming a consent prompt was shown would be a lie. The
/// capture mode is `imported`, which is what the Meetings view reads to show
/// "Imported file" instead of Me + Them.
pub(crate) fn imported_recording_row(
    prepared: &PreparedAudioImport,
    project_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> models::Recording {
    models::Recording {
        id: prepared.plan.recording_id.clone(),
        title: prepared.title.clone(),
        project_id: project_id.to_string(),
        duration: prepared.validated.duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "meeting".to_string(),
        audio_path: prepared.plan.primary_path.to_string_lossy().to_string(),
        status: "processing".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: None,
        meeting_template_id: None,
        meeting_capture_mode: Some(IMPORTED_MEETING_CAPTURE_MODE.to_string()),
        imported_source_name: Some(prepared.source_file_name.clone())
            .filter(|value| !value.trim().is_empty()),
        notes_updated_at: None,
        consent_prompt_shown: false,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        pause_spans: Vec::new(),
        video_service: None,
        attendees: Vec::new(),
    }
}

/// The capture mode written for a meeting that came from a file rather than a
/// microphone. Mirrored by `MEETING_CAPTURE_MODE_IMPORTED` in
/// `src/types/index.ts`.
pub(crate) const IMPORTED_MEETING_CAPTURE_MODE: &str = "imported";

/// Persist a prepared import: the meeting row, its owned audio asset, and the
/// audit entry that records where the audio came from.
pub(crate) fn persist_audio_import(
    db: &mut db::Database,
    prepared: &PreparedAudioImport,
    recording: &models::Recording,
) -> Result<(), String> {
    db.create_recording_with_audio_plan(recording, &prepared.plan)
        .map_err(|error| error.to_string())?;
    db.finalize_recording_audio(
        &recording.id,
        &[(
            recording_audio::RecordingAudioRole::Primary,
            prepared.validated.clone(),
        )],
        prepared.validated.duration_seconds,
        "processing",
        None,
    )
    .map_err(|error| error.to_string())?;
    // The original file's name is recorded; its directory is not, so the audit
    // log does not become a map of the reader's disk.
    if let Err(error) = db.log_audit_event(
        "meeting_audio_imported",
        Some(serde_json::json!({
            "recording_id": &recording.id,
            "source_file_name": &prepared.source_file_name,
            "duration_seconds": prepared.validated.duration_seconds,
            "converted_bytes": prepared.validated.plaintext_bytes,
        })),
        "info",
    ) {
        tracing::warn!("Failed to log audio import audit event: {}", error);
    }
    Ok(())
}

/// `import_audio_file`: decode a file the user picked, save it as a meeting,
/// and hand it to the same post-capture pipeline a stopped meeting uses.
///
/// The original file is only ever read.
pub(crate) async fn import_audio_file_impl(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    source_path: PathBuf,
) -> Result<serde_json::Value, String> {
    // Same lease the stop path and `retranscribe_recording` take, so an import
    // cannot start on top of a backup, a vault migration, or another meeting's
    // post-processing.
    let postprocessing_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::PostProcess)?;

    let project_id = {
        let settings = state.settings_manager.lock().await;
        settings
            .settings()
            .transcription
            .dictation_project_id
            .clone()
    };
    let recordings_dir = nautilus_data_root()?.join("recordings");

    let prepared = {
        // Decoding writes into the recordings store, so it holds the same gate
        // a retention sweep and the vault migration take.
        let _storage_guard = state.audio_storage_gate.lock().await;
        let source_for_task = source_path.clone();
        let dir_for_task = recordings_dir.clone();
        // afconvert on a long file takes minutes; it must not sit on the async
        // runtime while it runs.
        tokio::task::spawn_blocking(move || prepare_audio_import(&source_for_task, &dir_for_task))
            .await
            .map_err(|error| format!("The audio import task failed: {error}"))??
    };

    let recording = imported_recording_row(&prepared, &project_id, chrono::Utc::now());
    {
        let mut db = state.db.lock().await;
        if let Err(error) = persist_audio_import(&mut db, &prepared, &recording) {
            drop(db);
            let _ = std::fs::remove_file(&prepared.plan.primary_path);
            return Err(format!(
                "Plainsong could not save the imported meeting: {error}"
            ));
        }
    }

    let recording_id = recording.id.clone();

    // Same order the stop path uses: the audio is encrypted into the vault
    // before the pipeline is allowed to read it. An imported file lands in the
    // recordings folder as the same kind of owned asset a meeting's audio does,
    // so skipping this left plaintext audio under a vault the UI says is on.
    if let Err(error) =
        encrypt_finalized_recording_audio(state.as_ref(), Some(handle), &recording_id).await
    {
        let mut db = state.db.lock().await;
        let _ = db.update_recording_status(&recording_id, "error");
        drop(db);
        let message = format!(
            "The audio was imported, but vault encryption must be retried before it can be transcribed: {error}"
        );
        emit_meeting_lifecycle_phase(
            state.as_ref(),
            handle,
            "error",
            &recording_id,
            Some(&message),
        );
        return Err(message);
    }

    // The same pair the stop path emits, in the same order. The import
    // previously emitted only `recording-status-changed`, so the renderer's
    // meeting state machine never left `idle` for an import: no processing
    // phase was ever shown, and the pipeline's own terminal `ready` or `error`
    // phase arrived for a meeting the machine had never heard of.
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
            "recordingId": &recording_id,
            "status": "processing",
            "message": "Processing transcript",
            "progress": 0.0,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    let audio_postprocessing_guard = MeetingAudioPostprocessingGuard::coordinated(
        Arc::clone(&state.active_meeting_audio_postprocessing),
        &recording_id,
        postprocessing_lease,
    );
    tokio::spawn(run_meeting_transcription_pipeline(
        Arc::clone(state),
        handle.clone(),
        recording_id.clone(),
        audio_postprocessing_guard,
    ));

    Ok(serde_json::json!({
        "recordingId": recording_id,
        "title": recording.title,
        "sourceFileName": prepared.source_file_name,
        "durationSeconds": prepared.validated.duration_seconds,
    }))
}

/// The import path from a file on disk to a saved meeting row, with the
/// recognizer deliberately left out: `prepare_audio_import` and
/// `persist_audio_import` are the seam, and everything after them is the same
/// pipeline a stopped meeting already runs.
#[cfg(test)]
#[cfg(target_os = "macos")]
mod audio_import_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A short stereo 44.1 kHz WAV, i.e. deliberately not the shape the
    /// meeting pipeline wants, so the conversion has something to do.
    fn write_stereo_fixture(path: &Path, seconds: u32) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create fixture wav");
        for index in 0..(44_100 * seconds) {
            let value = ((index as f32 * 0.05).sin() * 8_000.0) as i16;
            writer.write_sample(value).expect("left");
            writer.write_sample(-value).expect("right");
        }
        writer.finalize().expect("finalize fixture wav");
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nautilus-import-{label}-{suffix}"));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn importing_a_wav_converts_it_and_saves_one_meeting_row() {
        let root = scratch_dir("ok");
        let source = root.join("Q3 planning call.wav");
        write_stereo_fixture(&source, 2);
        let recordings_dir = root.join("recordings");

        let prepared =
            prepare_audio_import(&source, &recordings_dir).expect("a plain WAV must import");

        // The original is only ever read.
        assert!(source.is_file(), "the file the user picked must survive");
        // The converted copy lives in the recordings store, at 16 kHz mono.
        assert!(prepared.plan.primary_path.starts_with(&recordings_dir));
        let converted = hound::WavReader::open(&prepared.plan.primary_path).expect("converted wav");
        assert_eq!(converted.spec().channels, 1);
        assert_eq!(
            converted.spec().sample_rate,
            audio_import::IMPORT_SAMPLE_RATE_HZ
        );
        assert_eq!(prepared.validated.duration_seconds, 2);
        assert_eq!(prepared.title, "Q3 planning call");
        assert_eq!(prepared.source_file_name, "Q3 planning call.wav");

        let mut db = db::Database::new_in_memory_for_test().expect("in-memory db");
        let recording = imported_recording_row(&prepared, "inbox", chrono::Utc::now());
        persist_audio_import(&mut db, &prepared, &recording).expect("persist the imported meeting");

        let stored = db
            .get_recording(&recording.id)
            .expect("read back")
            .expect("the import must produce a recording row");
        assert_eq!(stored.source_type, "meeting");
        assert_eq!(stored.status, "processing");
        assert_eq!(stored.meeting_capture_mode.as_deref(), Some("imported"));
        assert_eq!(
            stored.imported_source_name.as_deref(),
            Some("Q3 planning call.wav")
        );
        assert_eq!(stored.title, "Q3 planning call");
        assert_eq!(stored.duration, 2);
        // Nobody was in the room, so no consent prompt is claimed.
        assert!(!stored.consent_prompt_shown);
        // The audio the pipeline will read is registered as owned, not orphaned.
        let bundle = db
            .load_recording_audio_bundle(&recording.id)
            .expect("audio bundle");
        assert_eq!(
            bundle.primary.as_ref().map(|asset| asset.path.clone()),
            Some(prepared.plan.primary_path.clone())
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_refused_file_leaves_nothing_in_the_recordings_store() {
        let root = scratch_dir("refused");
        let recordings_dir = root.join("recordings");

        // Wrong container: refused before anything is written.
        let text = root.join("notes.pdf");
        std::fs::write(&text, b"not audio").expect("write");
        let refusal = prepare_audio_import(&text, &recordings_dir).unwrap_err();
        assert!(refusal.contains(".pdf"), "{refusal}");
        assert!(
            !recordings_dir.exists(),
            "a refused extension writes nothing"
        );

        // Right container, unreadable contents: afinfo cannot state a length,
        // so the file is refused before afconvert is spawned at all.
        let fake = root.join("broken.mp3");
        std::fs::write(&fake, b"\x00\x01\x02 not an mp3").expect("write");
        let decode_failure = prepare_audio_import(&fake, &recordings_dir).unwrap_err();
        assert!(
            decode_failure.contains("could not determine the length"),
            "{decode_failure}"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&recordings_dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "a refused conversion must leave no file behind: {leftovers:?}"
        );

        // A directory is not a file, however it is spelled.
        let dir = root.join("album.wav");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let not_a_file = prepare_audio_import(&dir, &recordings_dir).unwrap_err();
        assert!(not_a_file.contains("not a folder"), "{not_a_file}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The import wrote its converted WAV into the recordings store and started
    /// the pipeline without ever encrypting it, so with the vault on an
    /// imported meeting was plaintext audio sitting under a vault the UI says
    /// is on. `import_audio_file_impl` now runs the stop path's encryption step
    /// before the pipeline; this is the storage half of that, showing the asset
    /// the import registers is one the vault operation picks up.
    #[test]
    fn an_imported_meetings_audio_is_an_asset_the_vault_operation_can_encrypt() {
        let root = scratch_dir("vault");
        let source = root.join("board call.wav");
        write_stereo_fixture(&source, 1);
        let recordings_dir = root.join("recordings");

        let prepared = prepare_audio_import(&source, &recordings_dir).expect("import");
        let mut db = db::Database::new_in_memory_for_test().expect("in-memory db");
        let recording = imported_recording_row(&prepared, "inbox", chrono::Utc::now());
        persist_audio_import(&mut db, &prepared, &recording).expect("persist");

        // As persisted it is plaintext, like a meeting's audio at finalize.
        assert_eq!(db.count_encrypted_recordings().expect("counts"), (0, 1));

        let operation = db
            .begin_recording_audio_encryption(&recording.id)
            .expect("begin encryption")
            .expect("an imported meeting must open an encryption operation");
        assert_eq!(operation.items.len(), 1);
        assert_eq!(operation.items[0].source_path, prepared.plan.primary_path);

        db.switch_recording_audio_encryption(&operation)
            .expect("switch");
        assert_eq!(db.count_encrypted_recordings().expect("counts"), (1, 1));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The probe is what the four-hour guard depends on, so it has to state a
    /// real length for a real file rather than shrugging.
    #[test]
    fn the_duration_probe_reads_a_real_file_and_refuses_one_it_cannot_read() {
        let root = scratch_dir("probe");
        let source = root.join("two seconds.wav");
        write_stereo_fixture(&source, 2);

        let seconds = probe_audio_duration_seconds(&source)
            .expect("afinfo must state the length of a WAV it just wrote");
        assert!(
            (seconds - 2.0).abs() < 0.05,
            "probed {seconds} s for a 2 s file"
        );
        // The length is well under the guard, and the guard agrees.
        assert!(audio_import::validate_import_duration(seconds).is_ok());

        // A file CoreAudio cannot open has no length, and that is a refusal.
        let junk = root.join("not audio.wav");
        std::fs::write(&junk, b"RIFFnope").expect("write");
        let refusal = probe_audio_duration_seconds(&junk).unwrap_err();
        assert!(
            refusal.contains("could not determine the length"),
            "{refusal}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A conversion that will not finish must not hold the caller's locks
    /// forever, and must not leave the child running behind the error.
    #[test]
    fn a_conversion_that_does_not_finish_is_killed_and_reported() {
        let root = scratch_dir("timeout");
        let source = root.join("silence.wav");
        write_stereo_fixture(&source, 1);
        let destination = root.join("out.wav");

        let started = std::time::Instant::now();
        let failure =
            run_afconvert(&source, &destination, std::time::Duration::from_millis(0)).unwrap_err();
        // A zero budget is past its deadline on the first poll, so this is the
        // timeout path even though the file itself is trivial.
        assert!(failure.contains("Plainsong stopped it"), "{failure}");
        assert!(failure.contains("network volume"), "{failure}");
        // The wait is bounded by the budget, not by the converter.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the timeout must return promptly, took {:?}",
            started.elapsed()
        );

        // The same call with a real budget succeeds, so the timeout is the
        // only thing the failure above proves.
        assert!(run_afconvert(
            &source,
            &destination,
            audio_import::import_conversion_timeout(1.0)
        )
        .is_ok());
        assert!(destination.is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every extension the picker offers must be one macOS can actually open.
    #[test]
    fn every_advertised_extension_is_one_afconvert_can_open() {
        let root = scratch_dir("formats");
        let source = root.join("source.wav");
        write_stereo_fixture(&source, 1);

        // .wav, .m4a, .mp4 and .aac are all CoreAudio-native; converting into
        // each one and probing it back proves the pipeline's own claim.
        for (extension, file_format) in [("m4a", "m4af"), ("mp4", "mp4f"), ("caf", "caff")] {
            let converted = root.join(format!("probe.{extension}"));
            let status = std::process::Command::new("/usr/bin/afconvert")
                .args(["-f", file_format, "-d", "aac"])
                .arg(&source)
                .arg(&converted)
                .status()
                .expect("run afconvert");
            if !status.success() {
                continue;
            }
            let seconds = probe_audio_duration_seconds(&converted)
                .unwrap_or_else(|error| panic!("afinfo could not read .{extension}: {error}"));
            assert!(seconds > 0.5, ".{extension} probed as {seconds} s");
        }

        // And the one that is gone: a real WebM is refused by name before
        // anything runs, which is the whole reason it was dropped.
        let webm = root.join("call.webm");
        std::fs::write(&webm, b"\x1a\x45\xdf\xa3 matroska").expect("write");
        let refusal = prepare_audio_import(&webm, &root.join("recordings")).unwrap_err();
        assert!(refusal.contains(".webm"), "{refusal}");

        let _ = std::fs::remove_dir_all(&root);
    }
}
