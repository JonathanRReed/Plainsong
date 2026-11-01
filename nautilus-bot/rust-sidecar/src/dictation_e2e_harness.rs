//! End-to-end dictation fidelity harness (ignored; run on demand).
//!
//! Drives the dictation stop path headlessly, from a captured-audio WAV to
//! the text that would be inserted into an empty field:
//!
//! 1. `audio::encode_dictation_recognition_wav`, the capture-to-recognizer
//!    transform `stop_dictation` applies (loudness gain, minimum duration).
//! 2. The dictation decode through `AsrManager`, on the new-install route
//!    (transcribe.cpp Parakeet TDT 0.6B v3 Q8_0) with the options the stop
//!    path builds from settings.
//! 3. `sanitize_dictation_output`, then `run_local_dictation_pipeline` with
//!    the destination category from `resolve_dictation_destination_category`
//!    and the field's accessibility role, exactly as the stop path calls
//!    them.
//! 4. With `PLAINSONG_E2E_AI=1`, AI formatting on through the default
//!    dictation lane (bundled S1-mini), prepared and executed by the same
//!    functions, under the same deadline, with the same fallback.
//! 5. `finalize_dictation_result_text`. Cursor fitting is the identity at the
//!    start of an empty field, so it is not applied.
//!
//! Settings are the ones a new install starts with: an empty, isolated config
//! directory loaded by `SettingsManager`. Nothing is captured from a
//! microphone, nothing is inserted, and no user data is read.
//!
//! ```text
//! PLAINSONG_E2E_ROOT=<root> PLAINSONG_DATA_DIR=<root>/data \
//! PLAINSONG_CONFIG_DIR=<root>/config TMPDIR=<root>/tmp \
//! PLAINSONG_E2E_MANIFEST=<manifest.json> PLAINSONG_E2E_CORPUS=<corpus.json> \
//! PLAINSONG_E2E_OUT=<results.jsonl> [PLAINSONG_E2E_AI=1] \
//! cargo test --lib dictation_e2e_harness -- --ignored --nocapture
//! ```
//!
//! The manifest lists `{clip, wav, dests}`; the corpus maps each destination
//! key to `{app, bundle, role}`. WAVs are 48 kHz mono float32 captures.
//! `PLAINSONG_E2E_DICTIONARY` optionally names a JSON dictionary.

use super::*;
use std::io::Write as _;

fn read_capture_f32(path: &str) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path).expect("open capture WAV");
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "{path}: captures are mono");
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|sample| sample.expect("read sample"))
            .collect(),
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .map(|sample| sample.expect("read sample") as f32 / i16::MAX as f32)
            .collect(),
    };
    (samples, spec.sample_rate)
}

fn elapsed_ms(started: std::time::Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// The default-mode AI formatting branch of the stop path, without the HUD.
async fn ai_format(
    state: &AppState,
    settings: &settings::Settings,
    options: &models::DictationStartOptions,
    local_text: &str,
) -> (String, &'static str, Option<String>) {
    if !dictation_llm_formatting_enabled(settings, options)
        || short_dictation_cleanup_is_complete(settings, options, local_text)
    {
        return (local_text.to_string(), "off", None);
    }
    let policy = dictation_ai_transform_policy(settings, options);
    let attempt = match prepare_dictation_formatting_request(state, options).await {
        Ok(mut prepared) => {
            prepared.system_prompt =
                crate::dictation_fidelity::dictionary_spelling_prompt(&prepared.system_prompt, &[]);
            let timeout = dictation_format_timeout_for_policy(prepared.provider, policy);
            match tokio::time::timeout(
                timeout,
                execute_dictation_formatting_request(state, &prepared, local_text),
            )
            .await
            {
                Ok(Ok(output)) => crate::dictation_timing::DictationFormatAttempt::Applied(output),
                Ok(Err(error)) => {
                    let attempt = dictation_format_attempt_for_error(&error);
                    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
                        attempt, local_text,
                    );
                    return (fallback.final_text, "rejected", Some(error));
                }
                Err(_) => crate::dictation_timing::DictationFormatAttempt::TimedOut,
            }
        }
        Err(error) => {
            return (local_text.to_string(), "unprepared", Some(error));
        }
    };
    let timed_out = matches!(
        attempt,
        crate::dictation_timing::DictationFormatAttempt::TimedOut
    );
    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(attempt, local_text);
    if fallback.format_outcome == crate::dictation_timing::DictationFormatOutcome::Applied {
        (
            sanitize_dictation_output(fallback.final_text.trim(), local_text)
                .trim()
                .to_string(),
            "applied",
            None,
        )
    } else {
        (
            fallback.final_text,
            if timed_out { "timed_out" } else { "failed" },
            None,
        )
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an isolated root, a cached Parakeet GGUF model and a corpus manifest"]
async fn dictation_e2e_harness() {
    let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let root = std::path::PathBuf::from(env("PLAINSONG_E2E_ROOT"));
    assert_eq!(crate::paths::data_dir().unwrap(), root.join("data"));
    assert_eq!(crate::paths::config_dir().unwrap(), root.join("config"));
    let ai = std::env::var("PLAINSONG_E2E_AI").as_deref() == Ok("1");
    let manifest: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(env("PLAINSONG_E2E_MANIFEST")).unwrap()).unwrap();
    let corpus: serde_json::Value =
        serde_json::from_slice(&std::fs::read(env("PLAINSONG_E2E_CORPUS")).unwrap()).unwrap();
    let only: Option<Vec<String>> = std::env::var("PLAINSONG_E2E_ONLY")
        .ok()
        .map(|value| value.split(',').map(str::to_string).collect());
    let mut out = std::fs::File::create(env("PLAINSONG_E2E_OUT")).unwrap();

    // Mock credentials: this process never touches the user's keychain.
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let models_root = root.join("data/Plainsong/models");
    let provider_type = asr::AsrProviderType::TranscribeCpp;
    let model_id = asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID;
    {
        use asr::AsrProvider as _;
        let provider = asr::transcribe_cpp::TranscribeCppProvider::for_benchmark(model_id).unwrap();
        provider
            .download_models(Box::new(|_| {}))
            .await
            .expect("verify the cached Parakeet GGUF");
    }
    if ai {
        for (path, digest) in llm::bundled_local::model_integrity_artifacts(&models_root) {
            assert!(
                crate::download::verify_or_record_model_integrity(&path, Some(&digest))
                    .await
                    .unwrap(),
                "verify {}",
                path.display()
            );
        }
    }

    let state = crate::build_app_state().await.unwrap();
    state.remote_processing_gate.set_allowed(false);
    if ai {
        let mut manager = state.settings_manager.lock().await;
        manager.settings_mut().transcription.dictation_ai_formatting = true;
    }
    let settings = state.settings_manager.lock().await.settings().clone();
    assert_eq!(
        (
            settings.transcription.dictation_provider.as_str(),
            settings.transcription.dictation_model_id.as_str()
        ),
        ("transcribe_cpp", model_id),
        "a new install dictates through transcribe.cpp Parakeet on Apple Silicon"
    );
    // Optional user dictionary (`PLAINSONG_E2E_DICTIONARY`: a JSON list of
    // `{spokenForm, replacement}`), applied as unscoped entries. The
    // recognizer hint is built from it the way the stop path builds it.
    let dictionary: Vec<models::DictationDictionaryEntry> =
        std::env::var("PLAINSONG_E2E_DICTIONARY")
            .ok()
            .map(|path| {
                let rules: Vec<serde_json::Value> =
                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                rules
                    .iter()
                    .enumerate()
                    .map(|(index, rule)| models::DictationDictionaryEntry {
                        id: format!("e2e-{index}"),
                        spoken_form: rule["spokenForm"].as_str().unwrap().to_string(),
                        replacement: rule["replacement"].as_str().unwrap().to_string(),
                        app_scope: None,
                        case_sensitive: false,
                        enabled: true,
                        category_scope: None,
                        created_at: chrono::Utc::now(),
                        updated_at: chrono::Utc::now(),
                    })
                    .collect()
            })
            .unwrap_or_default();
    let transcription_options = asr::TranscriptionOptions {
        vocabulary_hint: crate::dictation_parity::build_vocabulary_hint(
            &crate::dictation_pipeline::vocabulary_candidates_from_entries(&dictionary, &[]),
            None,
            crate::text::format::DictationAppCategory::Other,
        ),
        translate_to_english: false,
        apple_speech_required_engine: None,
        request_speaker_labels: false,
        language: settings.transcription.language.clone(),
        acoustic_vocabulary: Vec::new(),
    };

    // One untimed decode so the first clip is not a cold start (the app
    // prewarms the dictation model while recording).
    if let Some(first) = manifest.first() {
        let (mut samples, rate) = read_capture_f32(first["wav"].as_str().unwrap());
        let wav = crate::audio::encode_dictation_recognition_wav(&mut samples, rate).unwrap();
        let _ = state
            .asr_manager
            .transcribe_bytes_for_dictation_with_options(
                provider_type,
                &wav,
                Some(model_id),
                &transcription_options,
            )
            .await;
    }

    for clip in &manifest {
        let clip_id = clip["clip"].as_str().unwrap();
        if only
            .as_ref()
            .is_some_and(|only| !only.iter().any(|id| id == clip_id || clip["item"] == **id))
        {
            continue;
        }
        let (mut samples, rate) = read_capture_f32(clip["wav"].as_str().unwrap());
        let audio_seconds = samples.len() as f64 / rate as f64;
        let started = std::time::Instant::now();
        let wav = crate::audio::encode_dictation_recognition_wav(&mut samples, rate).unwrap();
        let encode_ms = elapsed_ms(started);
        let recognized = state
            .asr_manager
            .transcribe_bytes_for_dictation_with_options(
                provider_type,
                &wav,
                Some(model_id),
                &transcription_options,
            )
            .await;
        let asr_ms = elapsed_ms(started) - encode_ms;
        let (asr_text, asr_error) = match recognized {
            Ok(result) => (result.text, None),
            Err(error) => (String::new(), Some(error.to_string())),
        };
        let raw = sanitize_dictation_output(&asr_text, &asr_text)
            .trim()
            .to_string();
        let to_raw_ms = elapsed_ms(started);

        for dest_key in clip["dests"].as_array().unwrap() {
            let dest_key = dest_key.as_str().unwrap();
            let dest = &corpus["destinations"][dest_key];
            let options = models::DictationStartOptions {
                context_app_name: dest["app"].as_str().map(str::to_string),
                context_app_bundle_id: dest["bundle"].as_str().map(str::to_string),
                ..Default::default()
            };
            let text_started = std::time::Instant::now();
            let category = resolve_dictation_destination_category(&settings, &options);
            let local = run_local_dictation_pipeline(
                &raw,
                &settings,
                &dictionary,
                &[],
                None,
                LocalDictationDestination {
                    spoken_language: None,
                    app_target: options.context_app_name.as_deref(),
                    category,
                    field_role: dest["role"].as_str(),
                },
            );
            let local_text = local.text.trim().to_string();
            let local_ms = elapsed_ms(text_started);
            let (formatted, ai_outcome, ai_error) =
                if local.command_applied.is_none() && !local_text.is_empty() {
                    ai_format(&state, &settings, &options, &local_text).await
                } else {
                    (local_text.clone(), "off", None)
                };
            let inserted =
                finalize_dictation_result_text(&formatted, &raw, local.command_applied.as_deref());
            let text_ms = elapsed_ms(text_started);
            let row = serde_json::json!({
                "clip": clip_id,
                "item": clip["item"],
                "dest": dest_key,
                "category": format!("{category:?}"),
                "ai": ai,
                "asrText": asr_text,
                "asrError": asr_error,
                "raw": raw,
                "localText": local_text,
                "stages": local.pipeline_stage_keys,
                "aiOutcome": ai_outcome,
                "aiError": ai_error,
                "inserted": inserted,
                "audioSeconds": audio_seconds,
                "encodeMs": encode_ms,
                "asrMs": asr_ms,
                "localMs": local_ms,
                "textMs": text_ms,
                // Stop to text, excluding the fixed capture-tail wait the stop
                // path sleeps before finalizing audio (reported separately).
                "stopToTextMs": to_raw_ms + text_ms,
                "captureTailMs": crate::audio::DICTATION_STOP_CAPTURE_TAIL_MS,
            });
            writeln!(out, "{row}").unwrap();
            eprintln!("{clip_id} [{dest_key}] {inserted:?}");
        }
    }
    drop(state);
    crate::shutdown_for_sidecar().await;
}
