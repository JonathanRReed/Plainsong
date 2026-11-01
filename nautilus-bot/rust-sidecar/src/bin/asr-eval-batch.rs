//! Transcribe a list of WAV files with one local ASR provider, loading the
//! model once.
//!
//! ```text
//! asr-eval-batch --provider parakeet [--model <id>] --list <wavs.txt> --out <results.jsonl>
//!     [--dictation-preprocess] [--language <code>]
//!     [--vocabulary-terms <terms.json>] [--vocabulary-built-in]
//!     [--vocabulary-exclude <terms.json>] [--vocabulary-floors <floors.json>]
//!     [--calendar-names <names.json>] [--contact-names <names.json>]
//! asr-eval-batch --replay <previous.jsonl> --out <results.jsonl> [vocabulary flags]
//! ```
//!
//! `--list` holds one WAV path per line. Each output line is JSON:
//! `{"wav", "transcript", "formatted", "ms", "error"}`, where `transcript` is
//! the raw recognizer text and `formatted` is the local dictation pipeline
//! with Smart Format and numbers as digits on (no LLM). Score transcripts with
//! `scripts/lib/asr-wer.ts`. Unlike `benchmark-latency`, which
//! `scripts/eval-asr-wer.ts` starts once per clip, the model loads once, so
//! hundreds of noisy, quiet or far-field clips take minutes. `ms` is warm
//! recognition time only.
//!
//! Installed models are integrity-checked in this process first (a missing
//! one downloads). The provider then runs its own native-load admission,
//! exactly as dictation does; when headroom is short a clip records the
//! refusal in `error` rather than waiting.
//!
//! `--dictation-preprocess` reads each WAV as captured samples and hands the
//! recognizer what a dictation stop would: the stop-time loudness
//! normalization and minimum-length padding of
//! `encode_dictation_recognition_wav`, at the file's own sample rate. Use it
//! for recorded speech that has not been through the app (public test sets);
//! leave it off for fixtures already written in the app's output form.
//! `--language` sets the transcription language the way the app's language
//! setting does (unset means the provider's automatic choice).
//!
//! `--vocabulary-terms` (a JSON array of `{"text", "spoken"}`, `spoken`
//! optional) acts as the user's dictionary: the local pipeline applies it,
//! and with `--vocabulary-built-in` (the built-in names and tools) it becomes
//! the acoustic vocabulary list of `dictation_vocabulary`. Lines then also
//! carry `vocabulary_terms`, the helper's `candidates`, and `with_vocabulary`:
//! `formatted` after the acoustic spelling stage. `formatted` itself is the
//! same pipeline without that stage, so one run gives both arms.
//! `--vocabulary-exclude` (a JSON array of strings) drops those terms from the
//! built-in list only, to measure it on names it does not contain.
//! `--vocabulary-floors` (a JSON array of `dictation_vocabulary::Floors`)
//! adds `with_vocabulary_sweep`, the same stage under each set of floors.
//! `--replay <previous.jsonl> --out <new.jsonl>` reruns only the text stages
//! on a previous run's transcripts and candidates, with the same vocabulary
//! flags, so floors can be compared without recognizing again.
//! Name-source flags provide spelling hints without adding dictionary rules.
//! Native rows time the vocabulary build per clip as `vocabulary_build_us`.

use plainsong_lib::asr::{
    AsrProviderFactory, AsrProviderType, TranscriptionOptions, VocabularyCandidate,
};
use plainsong_lib::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
use plainsong_lib::dictation_vocabulary::Floors;
use plainsong_lib::text::format::DictationAppCategory;
use std::io::Write;
use std::time::Instant;

fn provider_from_str(value: &str) -> Option<AsrProviderType> {
    Some(match value {
        "whisper" => AsrProviderType::Whisper,
        "parakeet" => AsrProviderType::Parakeet,
        "moonshine" => AsrProviderType::Moonshine,
        "whisper_candle" => AsrProviderType::WhisperCandle,
        "distil_whisper" => AsrProviderType::DistilWhisper,
        "qwen3_asr" => AsrProviderType::Qwen3Asr,
        "cohere_local" => AsrProviderType::CohereLocal,
        #[cfg(feature = "asr-transcribe-cpp")]
        "transcribe_cpp" => AsrProviderType::TranscribeCpp,
        _ => return None,
    })
}

fn create_provider(
    provider_type: AsrProviderType,
    model: &str,
) -> Result<Box<dyn plainsong_lib::asr::AsrProvider>, String> {
    #[cfg(feature = "asr-transcribe-cpp")]
    if provider_type == AsrProviderType::TranscribeCpp {
        return plainsong_lib::asr::transcribe_cpp::TranscribeCppProvider::for_benchmark(model)
            .map(|provider| Box::new(provider) as Box<dyn plainsong_lib::asr::AsrProvider>);
    }
    Ok(AsrProviderFactory::create_with_model(
        provider_type,
        Some(model),
    ))
}

/// The app's local pipeline with its default settings. `spoken_language`
/// follows the app: the `--language` setting, else the recognizer's report.
fn format_locally(
    text: &str,
    spoken_language: Option<&str>,
    dictionary_entries: &[plainsong_lib::dictation_vocabulary::DictationDictionaryEntry],
) -> plainsong_lib::dictation_pipeline::DictationPipelineResult {
    apply_dictation_pipeline(DictationPipelineInput {
        spoken_language,
        text,
        dictionary_entries,
        snippets: &[],
        app_target: None,
        mode_preset: "voice",
        smart_formatting_enabled: true,
        clean_disfluencies: true,
        numbers_as_digits: true,
        recent_inserted_text: None,
        command_mode_enabled: false,
        destination_category: DictationAppCategory::Other,
        structured_layout: false,
    })
}

/// `--vocabulary-terms`: (written, spoken) pairs. A missing spoken form is
/// the written form, as a user adding a word to the dictionary would.
fn read_vocabulary_terms(path: &str) -> Vec<(String, String)> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| {
        eprintln!("Failed to read {path}: {error}");
        std::process::exit(2);
    });
    let rows: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_else(|error| {
        eprintln!("Invalid {path}: {error}");
        std::process::exit(2);
    });
    rows.iter()
        .filter_map(|row| {
            let written = row.get("text")?.as_str()?.to_string();
            let spoken = row
                .get("spoken")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&written)
                .to_string();
            Some((written, spoken))
        })
        .collect()
}

fn candidate_json(candidate: &VocabularyCandidate) -> serde_json::Value {
    serde_json::json!({
        "term": candidate.term,
        "heard": candidate.heard,
        "word_start": candidate.word_start,
        "word_end": candidate.word_end,
        "similarity": candidate.similarity,
        "margin": candidate
            .term_score
            .zip(candidate.heard_score)
            .map(|(term, heard)| term - heard),
        "term_score": candidate.term_score,
        "heard_score": candidate.heard_score,
        "best_path_score": candidate.best_path_score,
        "spoken_form": candidate.spoken_form,
        "ctc_heard": candidate.ctc_heard,
    })
}

fn candidate_from_json(row: &serde_json::Value) -> Option<VocabularyCandidate> {
    let number = |key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_f64)
            .map(|v| v as f32)
    };
    let text = |key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let word_start = row.get("word_start")?.as_u64()? as usize;
    let heard = text("heard")?;
    Some(VocabularyCandidate {
        term: text("term")?,
        word_end: row
            .get("word_end")
            .and_then(serde_json::Value::as_u64)
            .map_or(word_start + heard.split_whitespace().count(), |end| {
                end as usize
            }),
        heard,
        word_start,
        similarity: number("similarity")?,
        term_score: number("term_score"),
        heard_score: number("heard_score"),
        best_path_score: number("best_path_score"),
        spoken_form: text("spoken_form"),
        ctc_heard: text("ctc_heard"),
    })
}

/// `with_vocabulary` (shipped floors), `with_vocabulary_sweep` (one text per
/// `--vocabulary-floors` entry) and the helper's candidates.
fn add_vocabulary_fields(
    line: &mut serde_json::Value,
    formatted: &plainsong_lib::dictation_pipeline::DictationPipelineResult,
    raw: &str,
    candidates: &[VocabularyCandidate],
    acoustic_vocabulary: &[plainsong_lib::asr::AcousticVocabularyTerm],
    floors_sweep: &[Floors],
) {
    let apply = |floors: Option<&Floors>| {
        let mut result = formatted.clone();
        plainsong_lib::dictation_vocabulary::apply_for_eval(
            &mut result,
            raw,
            candidates,
            acoustic_vocabulary,
            floors,
        );
        result.text
    };
    line["vocabulary_terms"] = acoustic_vocabulary.len().into();
    let vocabulary_started = Instant::now();
    line["with_vocabulary"] = apply(None).into();
    line["vocabulary_apply_us"] = (vocabulary_started.elapsed().as_micros() as u64).into();
    if !floors_sweep.is_empty() {
        line["with_vocabulary_sweep"] = floors_sweep
            .iter()
            .map(|floors| serde_json::Value::from(apply(Some(floors))))
            .collect::<Vec<_>>()
            .into();
    }
    line["candidates"] = candidates
        .iter()
        .map(candidate_json)
        .collect::<Vec<_>>()
        .into();
}

/// Decode a WAV to mono f32 samples (channels averaged), as capture holds
/// them before the stop-time transform.
fn read_capture_samples(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

fn dictation_recognition_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (mut samples, sample_rate) = read_capture_samples(bytes)?;
    plainsong_lib::encode_dictation_recognition_wav_for_eval(&mut samples, sample_rate)
        .map_err(|e| e.to_string())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> T {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| {
        eprintln!("Failed to read {path}: {error}");
        std::process::exit(2);
    });
    serde_json::from_str(&text).unwrap_or_else(|error| {
        eprintln!("Invalid {path}: {error}");
        std::process::exit(2);
    })
}

/// `--replay`: the vocabulary stage again on a previous run's transcripts
/// and candidates, without recognition.
fn replay(
    previous: &str,
    out: &str,
    language: Option<&str>,
    user_dictionary: &[plainsong_lib::dictation_vocabulary::DictationDictionaryEntry],
    acoustic_vocabulary: &[plainsong_lib::asr::AcousticVocabularyTerm],
    floors_sweep: &[Floors],
) {
    let text = std::fs::read_to_string(previous).unwrap_or_else(|error| {
        eprintln!("Failed to read {previous}: {error}");
        std::process::exit(2);
    });
    let mut output = std::fs::File::create(out).unwrap_or_else(|error| {
        eprintln!("Failed to create {out}: {error}");
        std::process::exit(2);
    });
    for row in text
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
    {
        let mut line = row.clone();
        let transcript = row
            .get("transcript")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let detected = row.get("language").and_then(serde_json::Value::as_str);
        let formatted = format_locally(
            transcript,
            plainsong_lib::text::language::dictation_spoken_language(
                language,
                Some(detected.unwrap_or("en")),
                false,
            ),
            user_dictionary,
        );
        line["formatted"] = formatted.text.clone().into();
        let candidates: Vec<VocabularyCandidate> = row
            .get("candidates")
            .and_then(serde_json::Value::as_array)
            .map(|rows| rows.iter().filter_map(candidate_from_json).collect())
            .unwrap_or_default();
        if !acoustic_vocabulary.is_empty() {
            add_vocabulary_fields(
                &mut line,
                &formatted,
                transcript,
                &candidates,
                acoustic_vocabulary,
                floors_sweep,
            );
        }
        writeln!(output, "{line}").expect("write result");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let calendar_names: Vec<String> = value("--calendar-names")
        .map(|path| read_json(&path))
        .unwrap_or_default();
    let contact_names: Vec<String> = value("--contact-names")
        .map(|path| read_json(&path))
        .unwrap_or_default();
    let floors_sweep: Vec<Floors> = value("--vocabulary-floors")
        .map(|path| read_json(&path))
        .unwrap_or_default();
    if let (Some(previous), Some(out)) = (value("--replay"), value("--out")) {
        let user_terms = value("--vocabulary-terms")
            .map(|path| read_vocabulary_terms(&path))
            .unwrap_or_default();
        let built_in = args.iter().any(|arg| arg == "--vocabulary-built-in");
        let exclude: Vec<String> = value("--vocabulary-exclude")
            .map(|path| read_json(&path))
            .unwrap_or_default();
        let user_dictionary = plainsong_lib::dictation_vocabulary::dictionary_for_eval(&user_terms);
        let acoustic_vocabulary = if built_in
            || !user_terms.is_empty()
            || !calendar_names.is_empty()
            || !contact_names.is_empty()
        {
            plainsong_lib::dictation_vocabulary::list_with_names_for_eval(
                &user_dictionary,
                built_in,
                &exclude,
                &calendar_names,
                &contact_names,
            )
        } else {
            Vec::new()
        };
        replay(
            &previous,
            &out,
            value("--language").as_deref(),
            &user_dictionary,
            &acoustic_vocabulary,
            &floors_sweep,
        );
        return;
    }
    let (Some(provider_name), Some(list), Some(out)) =
        (value("--provider"), value("--list"), value("--out"))
    else {
        eprintln!(
            "Usage: asr-eval-batch --provider <name> [--model <id>] --list <wavs.txt> --out <results.jsonl>"
        );
        std::process::exit(2);
    };
    let Some(provider_type) = provider_from_str(&provider_name) else {
        eprintln!("Unknown provider '{provider_name}'");
        std::process::exit(2);
    };
    let model = value("--model").unwrap_or_else(|| provider_type.default_model_id().to_string());
    let dictation_preprocess = args.iter().any(|arg| arg == "--dictation-preprocess");
    let language = value("--language");
    let user_terms = value("--vocabulary-terms")
        .map(|path| read_vocabulary_terms(&path))
        .unwrap_or_default();
    let built_in = args.iter().any(|arg| arg == "--vocabulary-built-in");
    let exclude: Vec<String> = value("--vocabulary-exclude")
        .map(|path| read_json(&path))
        .unwrap_or_default();
    let user_dictionary = plainsong_lib::dictation_vocabulary::dictionary_for_eval(&user_terms);
    let acoustic_vocabulary = if built_in
        || !user_terms.is_empty()
        || !calendar_names.is_empty()
        || !contact_names.is_empty()
    {
        plainsong_lib::dictation_vocabulary::list_with_names_for_eval(
            &user_dictionary,
            built_in,
            &exclude,
            &calendar_names,
            &contact_names,
        )
    } else {
        Vec::new()
    };
    let wavs: Vec<String> = std::fs::read_to_string(&list)
        .unwrap_or_else(|error| {
            eprintln!("Failed to read {list}: {error}");
            std::process::exit(2);
        })
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    plainsong_lib::asr::apply_transcription_language(language.as_deref());
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async move {
        let provider = create_provider(provider_type, &model).unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            std::process::exit(2);
        });
        let prepare_started = Instant::now();
        // Verification lives in each process's memory, so verify the
        // installed files in this process, exactly as
        // `benchmark-latency --ensure-model` does. A missing model downloads.
        let progress: Box<dyn Fn(f32) + Send + Sync> = Box::new(|_| {});
        if let Err(error) = provider.download_models(progress).await {
            eprintln!("Model verification failed for {provider_name}/{model}: {error}");
            std::process::exit(1);
        }
        #[cfg(feature = "asr-transcribe-cpp")]
        if provider_type == AsrProviderType::TranscribeCpp && !acoustic_vocabulary.is_empty() {
            let prepared =
                plainsong_lib::asr::transcribe_cpp::TranscribeCppProvider::for_benchmark(&model)
                    .and_then(|provider| provider.prepare_vocabulary_model_for_eval());
            if let Err(error) = prepared {
                eprintln!("Vocabulary model preparation failed: {error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = provider.prewarm().await {
            eprintln!("Model preparation failed for {provider_name}/{model}: {error}");
            std::process::exit(1);
        }
        eprintln!(
            "{provider_name}/{model} prepared in {} ms; {} files",
            prepare_started.elapsed().as_millis(),
            wavs.len()
        );
        let mut options = TranscriptionOptions {
            vocabulary_hint: None,
            translate_to_english: false,
            apple_speech_required_engine: None,
            request_speaker_labels: false,
            language: language.clone(),
            acoustic_vocabulary: acoustic_vocabulary.clone(),
        };
        let load = |wav: &str| -> Vec<u8> {
            let bytes = std::fs::read(wav).unwrap_or_else(|error| {
                eprintln!("Failed to read {wav}: {error}");
                std::process::exit(2);
            });
            if !dictation_preprocess {
                return bytes;
            }
            dictation_recognition_bytes(&bytes).unwrap_or_else(|error| {
                eprintln!("Failed to preprocess {wav}: {error}");
                std::process::exit(2);
            })
        };
        let mut output = std::fs::File::create(&out).unwrap_or_else(|error| {
            eprintln!("Failed to create {out}: {error}");
            std::process::exit(2);
        });
        // One untimed warm-up so the first fixture's latency is not a cold run.
        if let Some(first) = wavs.first() {
            let _ = provider
                .transcribe_bytes_with_options(&load(first), &options)
                .await;
        }
        for (index, wav) in wavs.iter().enumerate() {
            let bytes = load(wav);
            let build_started = Instant::now();
            // A live dictation copies the in-memory sources and builds once.
            let calendar = calendar_names.clone();
            let contacts = contact_names.clone();
            options.acoustic_vocabulary = if acoustic_vocabulary.is_empty() {
                Vec::new()
            } else {
                plainsong_lib::dictation_vocabulary::list_with_names_for_eval(
                    &user_dictionary,
                    built_in,
                    &exclude,
                    &calendar,
                    &contacts,
                )
            };
            let vocabulary_build_us = build_started.elapsed().as_micros() as u64;
            debug_assert_eq!(options.acoustic_vocabulary, acoustic_vocabulary);
            let started = Instant::now();
            let result = provider
                .transcribe_bytes_with_options(&bytes, &options)
                .await;
            let ms = started.elapsed().as_millis() as u64;
            let line = match result {
                Ok(result) => {
                    let formatted = format_locally(
                        &result.text,
                        plainsong_lib::text::language::dictation_spoken_language(
                            language.as_deref(),
                            Some(result.language.as_str()),
                            false,
                        ),
                        &user_dictionary,
                    );
                    let mut line = serde_json::json!({
                        "wav": wav,
                        "transcript": result.text,
                        "language": result.language,
                        "formatted": formatted.text,
                        "ms": ms,
                        "vocabulary_build_us": vocabulary_build_us,
                    });
                    if !acoustic_vocabulary.is_empty() {
                        add_vocabulary_fields(
                            &mut line,
                            &formatted,
                            &result.text,
                            &result.vocabulary_candidates,
                            &acoustic_vocabulary,
                            &floors_sweep,
                        );
                    }
                    line
                }
                Err(error) => serde_json::json!({
                    "wav": wav,
                    "transcript": "",
                    "formatted": "",
                    "ms": ms,
                    "error": error.to_string(),
                }),
            };
            writeln!(output, "{line}").expect("write result");
            if (index + 1) % 25 == 0 {
                eprintln!("  {}/{}", index + 1, wavs.len());
            }
        }
        drop(provider);
        // Release native models before ggml's Metal globals run at process exit.
        plainsong_lib::shutdown_for_sidecar().await;
    });
}
