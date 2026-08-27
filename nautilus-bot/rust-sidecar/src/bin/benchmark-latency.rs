//! Real dictation transcription latency benchmark.
//!
//! Unlike the old fixture-multiplied "benchmark", this runs actual audio
//! through the actual ASR provider and reports MEASURED wall-clock latency and
//! the real-time factor (RTF = audio_seconds / transcription_seconds; higher is
//! faster than real time). It requires the chosen model to be downloaded.
//!
//! Usage:
//!   benchmark-latency [--wav <path>] [--provider <name>] [--model <id>] [--runs N] [--out <path>] [--out-e2e <path>]
//!
//! Defaults: the bundled fixture, provider `whisper`, model `base.en`, 5 runs.
//! Output: a JSON line on stdout plus a human-readable summary on stderr.
//!
//! Every run also drives the full post-ASR pipeline (dictionary/snippet/local
//! smart-format, with Smart Format on AND off, then a mocked insertion) and
//! writes a second, `metricScope: "end_to_end"` receipt to `--out-e2e`. See
//! `build_end_to_end_report` for exactly what "format on" and "mock
//! insertion" do and don't cover.

use plainsong_lib::asr::{AsrProviderFactory, AsrProviderType};
use plainsong_lib::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
use plainsong_lib::text::format::DictationAppCategory;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_WAV: &str = "scripts/fixtures/real-speech-44s.wav";
const DEFAULT_PROVIDER: &str = "whisper";
const DEFAULT_RUNS: usize = 5;
const MAX_RUNS: usize = 100;
const DEFAULT_REPORT_PATH: &str = "artifacts/qa/dictation-latency.json";
const DEFAULT_REPORT_PATH_E2E: &str = "artifacts/qa/dictation-latency-e2e.json";
const HELP_TEXT: &str = "\
Measure real Plainsong transcription latency with a downloaded ASR model.

Usage:
  benchmark-latency [OPTIONS]

Options:
  --wav <PATH>        Spoken WAV fixture [default: scripts/fixtures/real-speech-44s.wav]
  --provider <NAME>   whisper, parakeet, moonshine, whisper_candle,
                      distil_whisper, or macos_apple_speech [default: whisper]
  --model <ID>        Model ID for the selected provider [default: provider default]
  --runs <1..100>     Timed transcription runs after one warm-up [default: 5]
  --out <PATH>        provider_transcription_only JSON report path
                      [default: artifacts/qa/dictation-latency.json]
  --out-e2e <PATH>    end_to_end JSON report path (full pipeline: ASR, local
                      format on/off, mocked insertion)
                      [default: artifacts/qa/dictation-latency-e2e.json]
  -h, --help          Print this help without loading a model

Output:
  Two JSON objects on stdout (provider-only, then end-to-end), one per line.
  Progress and the human summary are written to stderr.";

#[derive(Debug, Clone, PartialEq, Eq)]
struct BenchmarkArgs {
    wav: PathBuf,
    provider_name: String,
    provider_type: AsrProviderType,
    model: String,
    runs: usize,
    report_path: PathBuf,
    report_path_e2e: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParseOutcome {
    Help,
    Run(BenchmarkArgs),
}

fn next_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    let Some(value) = args.get(*index) else {
        return Err(format!("{flag} requires a value"));
    };
    if value.starts_with('-') {
        return Err(format!("{flag} requires a value, got option '{value}'"));
    }
    Ok(value.clone())
}

fn set_once(slot: &mut Option<String>, value: String, flag: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        return Err(format!("{flag} may only be specified once"));
    }
    Ok(())
}

fn provider_from_str(value: &str) -> Option<AsrProviderType> {
    Some(match value {
        "whisper" => AsrProviderType::Whisper,
        "parakeet" => AsrProviderType::Parakeet,
        "moonshine" => AsrProviderType::Moonshine,
        "whisper_candle" => AsrProviderType::WhisperCandle,
        "distil_whisper" => AsrProviderType::DistilWhisper,
        "macos_apple_speech" => AsrProviderType::MacosAppleSpeech,
        _ => return None,
    })
}

fn parse_args(args: &[String]) -> Result<ParseOutcome, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(ParseOutcome::Help);
    }

    let mut wav = None;
    let mut provider_name = None;
    let mut model = None;
    let mut runs = None;
    let mut report_path = None;
    let mut report_path_e2e = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--wav" => {
                let value = next_value(args, &mut index, "--wav")?;
                set_once(&mut wav, value, "--wav")?;
            }
            "--provider" => {
                let value = next_value(args, &mut index, "--provider")?;
                set_once(&mut provider_name, value, "--provider")?;
            }
            "--model" => {
                let value = next_value(args, &mut index, "--model")?;
                set_once(&mut model, value, "--model")?;
            }
            "--runs" => {
                let value = next_value(args, &mut index, "--runs")?;
                set_once(&mut runs, value, "--runs")?;
            }
            "--out" => {
                let value = next_value(args, &mut index, "--out")?;
                set_once(&mut report_path, value, "--out")?;
            }
            "--out-e2e" => {
                let value = next_value(args, &mut index, "--out-e2e")?;
                set_once(&mut report_path_e2e, value, "--out-e2e")?;
            }
            "--" => {}
            unknown => {
                return Err(format!("Unknown option '{unknown}'"));
            }
        }
        index += 1;
    }

    let provider_name = provider_name.unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let Some(provider_type) = provider_from_str(&provider_name) else {
        return Err(format!(
            "Unknown provider '{provider_name}'. Valid providers: whisper, parakeet, \
             moonshine, whisper_candle, distil_whisper, macos_apple_speech"
        ));
    };

    let model = model.unwrap_or_else(|| provider_type.default_model_id().to_string());
    let valid_models = provider_type.model_options();
    if !valid_models.iter().any(|option| option.id == model) {
        let choices = valid_models
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Model '{model}' is not valid for provider '{provider_name}'. Valid models: {choices}"
        ));
    }

    let runs = match runs {
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| (1..=MAX_RUNS).contains(value))
            .ok_or_else(|| "--runs must be an integer from 1 to 100".to_string())?,
        None => DEFAULT_RUNS,
    };

    let wav = PathBuf::from(wav.unwrap_or_else(|| DEFAULT_WAV.to_string()));
    let metadata = std::fs::metadata(&wav)
        .map_err(|_| format!("WAV fixture does not exist: {}", wav.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "WAV fixture is not a regular file: {}",
            wav.display()
        ));
    }

    Ok(ParseOutcome::Run(BenchmarkArgs {
        wav,
        provider_name,
        provider_type,
        model,
        runs,
        report_path: PathBuf::from(report_path.unwrap_or_else(|| DEFAULT_REPORT_PATH.to_string())),
        report_path_e2e: PathBuf::from(
            report_path_e2e.unwrap_or_else(|| DEFAULT_REPORT_PATH_E2E.to_string()),
        ),
    }))
}

fn wav_duration_seconds(path: &Path) -> Result<f64, String> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| format!("Failed to parse WAV '{}': {error}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err(format!(
            "WAV '{}' has an invalid sample rate or channel count",
            path.display()
        ));
    }
    let frames = reader.len() as f64 / spec.channels as f64;
    if frames == 0.0 {
        return Err(format!("WAV '{}' contains no audio frames", path.display()));
    }
    Ok(frames / spec.sample_rate as f64)
}

fn percentile(mut values: Vec<u64>, p: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let rank = ((p / 100.0) * values.len() as f64).ceil() as usize;
    values[rank.saturating_sub(1).min(values.len() - 1)]
}

fn round_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

struct BenchmarkReportInput<'a> {
    provider: &'a str,
    model: &'a str,
    fixture: &'a str,
    fixture_sha256: &'a str,
    fixture_bytes: usize,
    audio_seconds: f64,
    cold_model_preparation_ms: u64,
    warmup_inference_ms: u64,
    wall_ms: &'a [u64],
    transcript: &'a str,
}

/// Shared `hardware` block for both receipts (`provider_transcription_only`
/// and `end_to_end`) so the two are directly comparable and the reference-
/// hardware checks in `verify-dictation-latency.mjs` apply identically.
fn hardware_context() -> serde_json::Value {
    let logical_cpus = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let cpu_model = if cfg!(target_os = "macos") {
        std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    };
    let memory_bytes = if cfg!(target_os = "macos") {
        std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
    } else {
        None
    };

    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "logicalCpus": logical_cpus,
        "cpuModel": cpu_model,
        "memoryBytes": memory_bytes,
    })
}

fn build_report(input: BenchmarkReportInput<'_>) -> serde_json::Value {
    let p50 = percentile(input.wall_ms.to_vec(), 50.0);
    let p95 = percentile(input.wall_ms.to_vec(), 95.0);
    let p50_seconds = p50 as f64 / 1000.0;
    let real_time_factor = if input.audio_seconds > 0.0 {
        p50_seconds / input.audio_seconds
    } else {
        0.0
    };
    let realtime_speedup = if p50_seconds > 0.0 {
        input.audio_seconds / p50_seconds
    } else {
        0.0
    };
    let transcript_sample: String = input.transcript.chars().take(160).collect();
    let transcript_tail_sample: String = input
        .transcript
        .chars()
        .rev()
        .take(160)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let transcript_character_count = input.transcript.chars().count();
    let transcript_word_count = input.transcript.split_whitespace().count();

    serde_json::json!({
        "schemaVersion": 1,
        "benchmarkVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "thresholdProfile": "beta-reference-v1",
        "metricScope": "provider_transcription_only",
        "hostApplication": "benchmark-cli",
        "warmState": "warm",
        "hardware": hardware_context(),
        "provider": input.provider,
        "model": input.model,
        "fixture": input.fixture,
        "fixtureSha256": input.fixture_sha256,
        "fixtureBytes": input.fixture_bytes,
        "audioSeconds": round_two(input.audio_seconds),
        "coldModelPreparationMs": input.cold_model_preparation_ms,
        "warmupInferenceMs": input.warmup_inference_ms,
        "runs": input.wall_ms.len(),
        "sampleCount": input.wall_ms.len(),
        "measurementsMs": input.wall_ms,
        "transcriptionMsP50": p50,
        "transcriptionMsP95": p95,
        "realTimeFactor": round_two(real_time_factor),
        "realTimeFactorDefinition": "transcription_seconds / audio_seconds; lower is faster",
        "realtimeSpeedup": round_two(realtime_speedup),
        "transcriptCharacterCount": transcript_character_count,
        "transcriptWordCount": transcript_word_count,
        "transcriptSample": transcript_sample,
        "transcriptTailSample": transcript_tail_sample,
    })
}

/// Stands in for the real insertion path (a native paste/Accessibility write,
/// or a clipboard copy) in the end-to-end benchmark below.
///
/// Real insertion needs a live, focused GUI target and, for the `auto` mode,
/// macOS Accessibility permission -- neither available in an automated
/// benchmark, and copying to the *real* system clipboard on every run would
/// also clobber whatever the operator had copied. This measures a real (not
/// invented) elapsed time for an operation of comparable shape -- an
/// exclusive lock plus a full copy of the delivered text into memory --
/// while staying entirely side-effect free. It is a floor, not a ceiling:
/// actual insertion latency is measured in production by the runtime timing
/// record (`dictation_timing.rs`) and logged on every live dictation via
/// `tracing::info!("dictation {} timing: ...")`.
struct MockInsertionSink {
    buffer: Mutex<String>,
}

impl MockInsertionSink {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(String::new()),
        }
    }

    fn insert(&self, text: &str) -> Duration {
        let start = Instant::now();
        let mut guard = self
            .buffer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = text.to_string();
        drop(guard);
        start.elapsed()
    }
}

/// One run's worth of stage timings feeding the end-to-end receipt. ASR runs
/// once per sample (format on/off share the same transcript, matching
/// reality: ASR happens regardless of the Smart Format setting).
struct StageSample {
    asr_ms: u64,
    format_off_ms: u64,
    format_on_ms: u64,
    insertion_off_ms: u64,
    insertion_on_ms: u64,
}

impl StageSample {
    fn total_off_ms(&self) -> u64 {
        self.asr_ms + self.format_off_ms + self.insertion_off_ms
    }

    fn total_on_ms(&self) -> u64 {
        self.asr_ms + self.format_on_ms + self.insertion_on_ms
    }
}

fn stage_stats(values: &[u64]) -> serde_json::Value {
    serde_json::json!({
        "measurementsMs": values,
        "p50": percentile(values.to_vec(), 50.0),
        "p95": percentile(values.to_vec(), 95.0),
    })
}

struct EndToEndReportInput<'a> {
    provider: &'a str,
    model: &'a str,
    fixture: &'a str,
    fixture_sha256: &'a str,
    fixture_bytes: usize,
    audio_seconds: f64,
    samples: &'a [StageSample],
}

/// Build the `metricScope: "end_to_end"` receipt: the full post-capture
/// pipeline (ASR, then the local dictionary/snippet/smart-format pass with
/// Smart Format on and off, then a mocked insertion), reported as P50/P95
/// totals for each of `formatOff`/`formatOn` plus a per-stage breakdown.
///
/// Two scoping notes, also embedded in the receipt so a reader never has to
/// find this comment:
///
/// - `formatOn` measures the deterministic *local* smart-formatting pass
///   (`text::format`), not the optional LLM-based Smart Format pass that
///   sits behind `DICTATION_FORMAT_TIMEOUT` in `lib.rs`. That pass calls a
///   live model/provider and cannot be driven safely, deterministically, or
///   offline from a headless benchmark. Its real timing and timeout rate are
///   measured in production by the runtime `DictationTimingRecord` on every
///   live dictation instead.
/// - Insertion is mocked (see `MockInsertionSink`) for the same reason: no
///   live GUI target or Accessibility permission in an automated benchmark.
fn build_end_to_end_report(input: EndToEndReportInput<'_>) -> serde_json::Value {
    let asr_ms: Vec<u64> = input.samples.iter().map(|sample| sample.asr_ms).collect();
    let format_off_ms: Vec<u64> = input
        .samples
        .iter()
        .map(|sample| sample.format_off_ms)
        .collect();
    let format_on_ms: Vec<u64> = input
        .samples
        .iter()
        .map(|sample| sample.format_on_ms)
        .collect();
    let insertion_off_ms: Vec<u64> = input
        .samples
        .iter()
        .map(|sample| sample.insertion_off_ms)
        .collect();
    let insertion_on_ms: Vec<u64> = input
        .samples
        .iter()
        .map(|sample| sample.insertion_on_ms)
        .collect();
    let total_off_ms: Vec<u64> = input
        .samples
        .iter()
        .map(StageSample::total_off_ms)
        .collect();
    let total_on_ms: Vec<u64> = input.samples.iter().map(StageSample::total_on_ms).collect();

    serde_json::json!({
        "schemaVersion": 1,
        "benchmarkVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "thresholdProfile": "beta-reference-v1",
        "metricScope": "end_to_end",
        "hostApplication": "benchmark-cli",
        "warmState": "warm",
        "hardware": hardware_context(),
        "provider": input.provider,
        "model": input.model,
        "fixture": input.fixture,
        "fixtureSha256": input.fixture_sha256,
        "fixtureBytes": input.fixture_bytes,
        "audioSeconds": round_two(input.audio_seconds),
        "runs": input.samples.len(),
        "sampleCount": input.samples.len(),
        "insertionStrategy": "mocked-in-memory-copy",
        "insertionStrategyNote": "Real system insertion needs a focused GUI target and, for auto mode, macOS Accessibility permission -- neither available in an automated benchmark, and copying to the real system clipboard on every run would also clobber the operator's own clipboard. This measures a same-shape in-memory copy instead (see MockInsertionSink). Real insertion latency is captured in production by the runtime dictation timing record (dictation_timing.rs) and logged on every live dictation.",
        "formatOnScopeNote": "\"formatOn\" measures the deterministic local smart-formatting pass (text::format), not the optional LLM-based Smart Format pass. That pass calls a live model/provider behind DICTATION_FORMAT_TIMEOUT and cannot be driven safely or deterministically from a headless benchmark; its real timing and timeout rate are captured by the runtime dictation timing record on every live dictation.",
        "stageBreakdownMs": {
            "asr": stage_stats(&asr_ms),
            "formatOff": stage_stats(&format_off_ms),
            "formatOn": stage_stats(&format_on_ms),
            "insertionMockOff": stage_stats(&insertion_off_ms),
            "insertionMockOn": stage_stats(&insertion_on_ms),
        },
        "formatOff": {
            "measurementsMs": total_off_ms,
            "endToEndMsP50": percentile(total_off_ms.clone(), 50.0),
            "endToEndMsP95": percentile(total_off_ms.clone(), 95.0),
        },
        "formatOn": {
            "measurementsMs": total_on_ms,
            "endToEndMsP50": percentile(total_on_ms.clone(), 50.0),
            "endToEndMsP95": percentile(total_on_ms.clone(), 95.0),
        },
    })
}

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw_args) {
        Ok(ParseOutcome::Help) => {
            println!("{HELP_TEXT}");
            return;
        }
        Ok(ParseOutcome::Run(args)) => args,
        Err(error) => {
            eprintln!("Error: {error}\n\n{HELP_TEXT}");
            std::process::exit(2);
        }
    };

    let audio_bytes = match std::fs::read(&args.wav) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("Failed to read WAV '{}': {e}", args.wav.display());
            std::process::exit(2);
        }
    };
    let audio_seconds = match wav_duration_seconds(&args.wav) {
        Ok(duration) => duration,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let fixture_sha256 = hex::encode(Sha256::digest(&audio_bytes));
    let fixture = args
        .wav
        .canonicalize()
        .unwrap_or_else(|_| args.wav.clone())
        .display()
        .to_string();

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async move {
        let provider = AsrProviderFactory::create_with_model(args.provider_type, Some(&args.model));

        eprintln!(
            "Benchmarking {}/{} on {} ({audio_seconds:.1}s audio), {} runs...",
            args.provider_name, args.model, fixture, args.runs
        );

        // Measure cold model preparation separately. Timed samples below are
        // explicitly warm and may never silently include this load.
        let cold_prepare_started = Instant::now();
        if let Err(e) = provider.prewarm().await {
            eprintln!(
                "Model preparation failed for {}/{}: {e}\n\
                 Download the selected model in Plainsong or run the model-provisioning step.",
                args.provider_name, args.model
            );
            std::process::exit(1);
        }
        let cold_model_preparation_ms = cold_prepare_started.elapsed().as_millis() as u64;

        // One functional inference warm-up catches a model that loads but
        // cannot decode the fixture. It is also reported, but not included in
        // the percentile sample.
        let warmup_started = Instant::now();
        let warmup_result = provider.transcribe_bytes(&audio_bytes).await;
        let warmup_inference_ms = warmup_started.elapsed().as_millis() as u64;
        if let Err(e) = warmup_result {
            eprintln!(
                "Transcription warm-up failed for {}/{}: {e}\n\
                 Download the selected model in Plainsong or run the model-provisioning step.",
                args.provider_name, args.model
            );
            std::process::exit(1);
        }

        let mock_insertion = MockInsertionSink::new();
        let mut wall_ms: Vec<u64> = Vec::with_capacity(args.runs);
        let mut stage_samples: Vec<StageSample> = Vec::with_capacity(args.runs);
        let mut last_text = String::new();
        for run_index in 1..=args.runs {
            let start = Instant::now();
            let (text, asr_ms) = match provider.transcribe_bytes(&audio_bytes).await {
                Ok(result) => {
                    let asr_ms = start.elapsed().as_millis() as u64;
                    wall_ms.push(asr_ms);
                    last_text = result.text.clone();
                    (result.text, asr_ms)
                }
                Err(e) => {
                    eprintln!("Transcription run {run_index}/{} failed: {e}", args.runs);
                    std::process::exit(1);
                }
            };

            // Full post-ASR pipeline, Smart Format off then on, sharing the
            // one ASR result above -- matching reality: ASR runs once
            // regardless of the Smart Format setting. See
            // `build_end_to_end_report` for what "format on" does and does
            // not cover.
            let format_off_started = Instant::now();
            let format_off = apply_dictation_pipeline(DictationPipelineInput {
                text: text.as_str(),
                dictionary_entries: &[],
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: false,
                recent_inserted_text: None,
                destination_category: DictationAppCategory::Other,
            });
            let format_off_ms = format_off_started.elapsed().as_millis() as u64;

            let format_on_started = Instant::now();
            let format_on = apply_dictation_pipeline(DictationPipelineInput {
                text: text.as_str(),
                dictionary_entries: &[],
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: true,
                recent_inserted_text: None,
                destination_category: DictationAppCategory::Other,
            });
            let format_on_ms = format_on_started.elapsed().as_millis() as u64;

            let insertion_off_ms =
                mock_insertion.insert(format_off.text.as_str()).as_millis() as u64;
            let insertion_on_ms = mock_insertion.insert(format_on.text.as_str()).as_millis() as u64;

            stage_samples.push(StageSample {
                asr_ms,
                format_off_ms,
                format_on_ms,
                insertion_off_ms,
                insertion_on_ms,
            });
        }

        let p50 = percentile(wall_ms.clone(), 50.0);
        let p95 = percentile(wall_ms.clone(), 95.0);
        let speedup = if p50 > 0 {
            audio_seconds / (p50 as f64 / 1000.0)
        } else {
            0.0
        };

        let report = build_report(BenchmarkReportInput {
            provider: &args.provider_name,
            model: &args.model,
            fixture: &fixture,
            fixture_sha256: &fixture_sha256,
            fixture_bytes: audio_bytes.len(),
            audio_seconds,
            cold_model_preparation_ms,
            warmup_inference_ms,
            wall_ms: &wall_ms,
            transcript: &last_text,
        });
        let report_json = serde_json::to_string(&report).unwrap();
        if let Some(parent) = args.report_path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("Failed to create latency report directory: {error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = std::fs::write(
            &args.report_path,
            serde_json::to_string_pretty(&report).unwrap() + "\n",
        ) {
            eprintln!(
                "Failed to write latency report '{}': {error}",
                args.report_path.display()
            );
            std::process::exit(1);
        }
        println!("{report_json}");
        eprintln!(
            "p50 {p50}ms, p95 {p95}ms, {speedup:.1}x real-time for \
             {audio_seconds:.1}s of audio."
        );

        let e2e_report = build_end_to_end_report(EndToEndReportInput {
            provider: &args.provider_name,
            model: &args.model,
            fixture: &fixture,
            fixture_sha256: &fixture_sha256,
            fixture_bytes: audio_bytes.len(),
            audio_seconds,
            samples: &stage_samples,
        });
        let e2e_report_json = serde_json::to_string(&e2e_report).unwrap();
        if let Some(parent) = args.report_path_e2e.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("Failed to create end-to-end latency report directory: {error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = std::fs::write(
            &args.report_path_e2e,
            serde_json::to_string_pretty(&e2e_report).unwrap() + "\n",
        ) {
            eprintln!(
                "Failed to write end-to-end latency report '{}': {error}",
                args.report_path_e2e.display()
            );
            std::process::exit(1);
        }
        println!("{e2e_report_json}");
        eprintln!(
            "end-to-end: format-off p50 {}ms / p95 {}ms, format-on p50 {}ms / p95 {}ms.",
            percentile(
                stage_samples
                    .iter()
                    .map(StageSample::total_off_ms)
                    .collect(),
                50.0
            ),
            percentile(
                stage_samples
                    .iter()
                    .map(StageSample::total_off_ms)
                    .collect(),
                95.0
            ),
            percentile(
                stage_samples.iter().map(StageSample::total_on_ms).collect(),
                50.0
            ),
            percentile(
                stage_samples.iter().map(StageSample::total_on_ms).collect(),
                95.0
            ),
        );

        use std::io::Write;
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
    });

    // whisper.cpp's ggml Metal backend aborts in a C++ static destructor at
    // normal process exit. The benchmark is done and output is flushed, so skip
    // the C runtime teardown entirely to exit cleanly (important for CI).
    unsafe { libc::_exit(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn help_short_circuits_before_fixture_or_model_loading() {
        assert_eq!(
            parse_args(&strings(&["--help"])).unwrap(),
            ParseOutcome::Help
        );
        assert_eq!(parse_args(&strings(&["-h"])).unwrap(), ParseOutcome::Help);
    }

    #[test]
    fn invalid_provider_names_are_rejected() {
        let error = parse_args(&strings(&["--provider", "not-real"])).unwrap_err();
        assert!(error.contains("Unknown provider 'not-real'"), "{error}");
    }

    #[test]
    fn models_must_belong_to_the_selected_provider() {
        let error = parse_args(&strings(&[
            "--provider",
            "whisper",
            "--model",
            "parakeet-tdt-0.6b-v3",
        ]))
        .unwrap_err();
        assert!(
            error.contains("not valid for provider 'whisper'"),
            "{error}"
        );
        assert!(error.contains("base.en"), "{error}");
    }

    #[test]
    fn run_count_must_be_an_integer_in_the_operator_range() {
        for value in ["0", "101", "five"] {
            let error = parse_args(&strings(&["--runs", value])).unwrap_err();
            assert!(
                error.contains("--runs must be an integer from 1 to 100"),
                "{error}"
            );
        }
    }

    #[test]
    fn missing_fixture_is_rejected_before_provider_initialization() {
        let error =
            parse_args(&strings(&["--wav", "/definitely/missing/plainsong.wav"])).unwrap_err();
        assert!(error.contains("WAV fixture does not exist"), "{error}");
    }

    #[test]
    fn report_path_can_be_overridden_without_touching_the_canonical_receipt() {
        let args = match parse_args(&strings(&[
            "--wav",
            "Cargo.toml",
            "--out",
            "/tmp/plainsong-parakeet-comparison.json",
        ]))
        .expect("parse benchmark args")
        {
            ParseOutcome::Run(args) => args,
            ParseOutcome::Help => panic!("expected runnable benchmark args"),
        };

        assert_eq!(
            args.report_path,
            PathBuf::from("/tmp/plainsong-parakeet-comparison.json")
        );
    }

    #[test]
    fn report_path_may_only_be_specified_once() {
        let error = parse_args(&strings(&[
            "--out",
            "/tmp/first.json",
            "--out",
            "/tmp/second.json",
        ]))
        .unwrap_err();

        assert!(
            error.contains("--out may only be specified once"),
            "{error}"
        );
    }

    #[test]
    fn report_contains_complete_measurement_context() {
        let report = build_report(BenchmarkReportInput {
            provider: "whisper",
            model: "base.en",
            fixture: "/tmp/fixture.wav",
            fixture_sha256: "abc123",
            fixture_bytes: 42,
            audio_seconds: 2.5,
            cold_model_preparation_ms: 80,
            warmup_inference_ms: 100,
            wall_ms: &[250, 300, 400],
            transcript: "spoken fixture",
        });

        assert_eq!(report["provider"], "whisper");
        assert_eq!(report["model"], "base.en");
        assert_eq!(report["fixture"], "/tmp/fixture.wav");
        assert_eq!(report["fixtureSha256"], "abc123");
        assert_eq!(report["fixtureBytes"], 42);
        assert_eq!(report["audioSeconds"], 2.5);
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["thresholdProfile"], "beta-reference-v1");
        assert_eq!(report["metricScope"], "provider_transcription_only");
        assert_eq!(report["warmState"], "warm");
        assert_eq!(report["coldModelPreparationMs"], 80);
        assert_eq!(report["warmupInferenceMs"], 100);
        assert_eq!(report["runs"], 3);
        assert_eq!(report["sampleCount"], 3);
        assert_eq!(report["measurementsMs"], serde_json::json!([250, 300, 400]));
        assert_eq!(report["transcriptionMsP50"], 300);
        assert_eq!(report["transcriptionMsP95"], 400);
        assert_eq!(report["realTimeFactor"], 0.12);
        assert_eq!(report["realtimeSpeedup"], 8.33);
        assert_eq!(report["transcriptCharacterCount"], 14);
        assert_eq!(report["transcriptWordCount"], 2);
        assert_eq!(report["transcriptSample"], "spoken fixture");
        assert_eq!(report["transcriptTailSample"], "spoken fixture");
    }

    #[test]
    fn e2e_report_path_defaults_alongside_the_provider_only_path() {
        let args =
            match parse_args(&strings(&["--wav", "Cargo.toml"])).expect("parse benchmark args") {
                ParseOutcome::Run(args) => args,
                ParseOutcome::Help => panic!("expected runnable benchmark args"),
            };

        assert_eq!(
            args.report_path,
            PathBuf::from("artifacts/qa/dictation-latency.json")
        );
        assert_eq!(
            args.report_path_e2e,
            PathBuf::from("artifacts/qa/dictation-latency-e2e.json")
        );
    }

    #[test]
    fn e2e_report_path_can_be_overridden_independently_of_out() {
        let args = match parse_args(&strings(&[
            "--wav",
            "Cargo.toml",
            "--out",
            "/tmp/provider-only.json",
            "--out-e2e",
            "/tmp/end-to-end.json",
        ]))
        .expect("parse benchmark args")
        {
            ParseOutcome::Run(args) => args,
            ParseOutcome::Help => panic!("expected runnable benchmark args"),
        };

        assert_eq!(args.report_path, PathBuf::from("/tmp/provider-only.json"));
        assert_eq!(args.report_path_e2e, PathBuf::from("/tmp/end-to-end.json"));
    }

    #[test]
    fn e2e_report_path_may_only_be_specified_once() {
        let error = parse_args(&strings(&[
            "--out-e2e",
            "/tmp/first.json",
            "--out-e2e",
            "/tmp/second.json",
        ]))
        .unwrap_err();

        assert!(
            error.contains("--out-e2e may only be specified once"),
            "{error}"
        );
    }

    fn stage_sample(
        asr_ms: u64,
        format_off_ms: u64,
        format_on_ms: u64,
        insertion_off_ms: u64,
        insertion_on_ms: u64,
    ) -> StageSample {
        StageSample {
            asr_ms,
            format_off_ms,
            format_on_ms,
            insertion_off_ms,
            insertion_on_ms,
        }
    }

    #[test]
    fn stage_sample_totals_sum_asr_format_and_insertion() {
        let sample = stage_sample(90, 2, 5, 1, 1);
        assert_eq!(sample.total_off_ms(), 93);
        assert_eq!(sample.total_on_ms(), 96);
    }

    #[test]
    fn end_to_end_report_has_the_scope_and_stage_breakdown_the_gate_expects() {
        let samples = vec![
            stage_sample(80, 1, 3, 1, 1),
            stage_sample(90, 2, 4, 1, 1),
            stage_sample(100, 1, 3, 1, 2),
        ];
        let report = build_end_to_end_report(EndToEndReportInput {
            provider: "whisper",
            model: "base.en",
            fixture: "/tmp/fixture.wav",
            fixture_sha256: "abc123",
            fixture_bytes: 42,
            audio_seconds: 2.5,
            samples: &samples,
        });

        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["thresholdProfile"], "beta-reference-v1");
        assert_eq!(report["metricScope"], "end_to_end");
        assert_eq!(report["warmState"], "warm");
        assert_eq!(report["provider"], "whisper");
        assert_eq!(report["model"], "base.en");
        assert_eq!(report["fixtureSha256"], "abc123");
        assert_eq!(report["runs"], 3);
        assert_eq!(report["sampleCount"], 3);
        assert_eq!(report["insertionStrategy"], "mocked-in-memory-copy");
        assert!(report["insertionStrategyNote"]
            .as_str()
            .unwrap()
            .contains("Accessibility"));
        assert!(report["formatOnScopeNote"]
            .as_str()
            .unwrap()
            .contains("DICTATION_FORMAT_TIMEOUT"));

        let total_off: Vec<u64> = samples.iter().map(StageSample::total_off_ms).collect();
        let total_on: Vec<u64> = samples.iter().map(StageSample::total_on_ms).collect();
        assert_eq!(
            report["formatOff"]["endToEndMsP50"],
            percentile(total_off.clone(), 50.0)
        );
        assert_eq!(
            report["formatOff"]["endToEndMsP95"],
            percentile(total_off, 95.0)
        );
        assert_eq!(
            report["formatOn"]["endToEndMsP50"],
            percentile(total_on.clone(), 50.0)
        );
        assert_eq!(
            report["formatOn"]["endToEndMsP95"],
            percentile(total_on, 95.0)
        );

        for stage in [
            "asr",
            "formatOff",
            "formatOn",
            "insertionMockOff",
            "insertionMockOn",
        ] {
            assert!(
                report["stageBreakdownMs"][stage]["p50"].is_u64(),
                "missing stage breakdown for {stage}"
            );
            assert!(
                report["stageBreakdownMs"][stage]["measurementsMs"]
                    .as_array()
                    .is_some_and(|values| values.len() == 3),
                "stage {stage} should keep one measurement per run"
            );
        }
    }

    #[test]
    fn mock_insertion_sink_is_side_effect_free_and_measures_real_elapsed_time() {
        let sink = MockInsertionSink::new();
        // Must not touch the real system clipboard: running this test (or
        // the benchmark) repeatedly must never depend on, or clobber,
        // whatever the operator has actually copied.
        let elapsed_short = sink.insert("hi");
        let elapsed_long = sink.insert(&"a".repeat(10_000));
        // Both are real (not fabricated) measurements of the same operation;
        // neither should ever be absurdly large.
        assert!(elapsed_short.as_millis() < 50);
        assert!(elapsed_long.as_millis() < 50);
    }
}
