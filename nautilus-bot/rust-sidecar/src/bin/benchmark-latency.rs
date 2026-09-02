//! Real dictation transcription latency benchmark.
//!
//! Unlike the old fixture-multiplied "benchmark", this runs actual audio
//! through the actual ASR provider and reports MEASURED wall-clock latency and
//! the real-time factor (RTF = audio_seconds / transcription_seconds; higher is
//! faster than real time). It requires the chosen model to be downloaded.
//!
//! Usage:
//!   benchmark-latency [--wav <path>] [--secondary-wav <path>] [--provider <name>] [--model <id>] [--runs N] [--vocabulary <terms>] [--out <path>] [--out-e2e <path>]
//!
//! Defaults: `--wav` is the short-utterance reference fixture
//! (`scripts/fixtures/local-quality-gate.wav`, ~5.3s), `--secondary-wav` is a
//! long-form fixture (`scripts/fixtures/real-speech-44s.wav`, ~44s) kept for
//! comparison. Provider `whisper`, model `base.en`, 5 runs.
//! Output: two JSON lines on stdout plus a human-readable summary on stderr.
//!
//! Every run of the primary AND secondary fixture also drives the full
//! post-ASR pipeline (dictionary/snippet/local smart-format, with Smart
//! Format on AND off, then a mocked insertion) and writes a second,
//! `metricScope: "asr_and_local_format_only"` receipt to `--out-e2e`. See
//! `build_pipeline_report` for exactly what that scope name promises -- and,
//! as importantly, what it does not: no key-release, no IPC hop, no
//! `DICTATION_STOP_CAPTURE_TAIL_MS` wait, no real insertion, no LLM pass.

use plainsong_lib::asr::{
    AsrProviderFactory, AsrProviderType, TranscriptionOptions, VocabularyHint,
};
use plainsong_lib::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
use plainsong_lib::text::format::DictationAppCategory;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_WAV: &str = "scripts/fixtures/local-quality-gate.wav";
const DEFAULT_SECONDARY_WAV: &str = "scripts/fixtures/real-speech-44s.wav";
const DEFAULT_PROVIDER: &str = "whisper";
const DEFAULT_RUNS: usize = 5;
const MAX_RUNS: usize = 100;
const DEFAULT_REPORT_PATH: &str = "artifacts/qa/dictation-latency.json";
const DEFAULT_REPORT_PATH_E2E: &str = "artifacts/qa/dictation-latency-e2e.json";

/// Mirrors `audio::DICTATION_STOP_CAPTURE_TAIL_MS` (`pub(crate)`, so not
/// reachable from this external bin) -- the deliberate sleep
/// `stop_dictation_for_sidecar` awaits, before this benchmark's clock or any
/// other stage timer starts, so a speaker's final consonant lands in the
/// captured audio. Neither this benchmark nor the runtime
/// `DictationTimingRecord`'s "audio finalized" stage includes it, because
/// both start their own clocks strictly after it. It is real, user-felt
/// latency the receipt below would otherwise silently omit, so it is
/// reported explicitly instead. A `lib.rs` test
/// (`benchmark_capture_tail_constant_matches_the_documented_value`) pins the
/// real constant so this copy cannot silently drift.
const CAPTURE_TAIL_EXCLUDED_MS: u64 = 120;

const HELP_TEXT: &str = "\
Measure real Plainsong transcription latency with a downloaded ASR model.

Usage:
  benchmark-latency [OPTIONS]

Options:
  --wav <PATH>          Primary (short-utterance) WAV fixture
                        [default: scripts/fixtures/local-quality-gate.wav]
  --secondary-wav <PATH> Secondary long-form WAV fixture, reported alongside
                        the primary but not gated against its thresholds
                        [default: scripts/fixtures/real-speech-44s.wav]
  --provider <NAME>     whisper, parakeet, moonshine, whisper_candle,
                        distil_whisper, macos_apple_speech, or qwen3_asr
                        [default: whisper]
  --model <ID>          Model ID for the selected provider [default: provider default]
  --runs <1..100>       Timed transcription runs after one warm-up [default: 5]
  --vocabulary <TERMS>  Comma-separated vocabulary hint handed to the provider
                        exactly as dictation does (whisper initial prompt,
                        OpenAI/Groq prompt, ElevenLabs keyterms) [default: none]
  --out <PATH>          provider_transcription_only JSON report path
                        (primary fixture only)
                        [default: artifacts/qa/dictation-latency.json]
  --out-e2e <PATH>      asr_and_local_format_only JSON report path (primary +
                        secondary fixtures, local format on/off, mocked
                        insertion)
                        [default: artifacts/qa/dictation-latency-e2e.json]
  --print-transcript    Also print each fixture's full final transcript to
                        stderr (the receipts only carry 160-char samples)
  -h, --help            Print this help without loading a model

Output:
  Two JSON objects on stdout (provider-only, then pipeline), one per line.
  Progress and the human summary are written to stderr. Neither receipt is
  committed to source control -- artifacts/qa/'s .gitignore names both
  dictation-latency JSON files explicitly (other qa receipts are tracked) --
  so attach them to release evidence by hand instead.";

#[derive(Debug, Clone, PartialEq, Eq)]
struct BenchmarkArgs {
    wav: PathBuf,
    secondary_wav: PathBuf,
    provider_name: String,
    provider_type: AsrProviderType,
    model: String,
    runs: usize,
    vocabulary_hint: Option<VocabularyHint>,
    report_path: PathBuf,
    report_path_e2e: PathBuf,
    print_transcript: bool,
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
        "qwen3_asr" => AsrProviderType::Qwen3Asr,
        _ => return None,
    })
}

fn existing_wav_path(raw: Option<String>, default: &str) -> Result<PathBuf, String> {
    // Deliberately NOT canonicalized to an absolute path: the receipt embeds
    // this string verbatim as `fixture`, and an absolute path ties the
    // receipt to one machine's directory layout. Both defaults are already
    // repo-relative (this binary is meant to be run from the `nautilus-bot`
    // root, matching `bun run benchmark:latency`); an operator-supplied path
    // is used exactly as given.
    let path = PathBuf::from(raw.unwrap_or_else(|| default.to_string()));
    let metadata = std::fs::metadata(&path)
        .map_err(|_| format!("WAV fixture does not exist: {}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "WAV fixture is not a regular file: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn parse_args(args: &[String]) -> Result<ParseOutcome, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(ParseOutcome::Help);
    }

    let mut wav = None;
    let mut secondary_wav = None;
    let mut provider_name = None;
    let mut model = None;
    let mut runs = None;
    let mut vocabulary = None;
    let mut report_path = None;
    let mut report_path_e2e = None;
    let mut print_transcript = false;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--wav" => {
                let value = next_value(args, &mut index, "--wav")?;
                set_once(&mut wav, value, "--wav")?;
            }
            "--secondary-wav" => {
                let value = next_value(args, &mut index, "--secondary-wav")?;
                set_once(&mut secondary_wav, value, "--secondary-wav")?;
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
            "--vocabulary" => {
                let value = next_value(args, &mut index, "--vocabulary")?;
                set_once(&mut vocabulary, value, "--vocabulary")?;
            }
            "--out" => {
                let value = next_value(args, &mut index, "--out")?;
                set_once(&mut report_path, value, "--out")?;
            }
            "--out-e2e" => {
                let value = next_value(args, &mut index, "--out-e2e")?;
                set_once(&mut report_path_e2e, value, "--out-e2e")?;
            }
            "--print-transcript" => {
                print_transcript = true;
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
             moonshine, whisper_candle, distil_whisper, macos_apple_speech, qwen3_asr"
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

    let wav = existing_wav_path(wav, DEFAULT_WAV)?;
    let secondary_wav = existing_wav_path(secondary_wav, DEFAULT_SECONDARY_WAV)?;

    Ok(ParseOutcome::Run(BenchmarkArgs {
        wav,
        secondary_wav,
        provider_name,
        provider_type,
        model,
        runs,
        vocabulary_hint: parse_vocabulary_terms(vocabulary.as_deref()),
        report_path: PathBuf::from(report_path.unwrap_or_else(|| DEFAULT_REPORT_PATH.to_string())),
        report_path_e2e: PathBuf::from(
            report_path_e2e.unwrap_or_else(|| DEFAULT_REPORT_PATH_E2E.to_string()),
        ),
        print_transcript,
    }))
}

/// `--vocabulary "Plainsong, Kubernetes"` -> the same hint shape dictation
/// builds; blank terms are ignored and an empty list is no hint at all.
fn parse_vocabulary_terms(raw: Option<&str>) -> Option<VocabularyHint> {
    let terms = raw?
        .split(',')
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    VocabularyHint::new(terms)
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
    vocabulary_hint_terms: usize,
}

/// Shared `hardware` block for both receipts (`provider_transcription_only`
/// and `asr_and_local_format_only`) so the two are directly comparable and
/// the reference-hardware checks in `verify-dictation-latency.mjs` apply
/// identically.
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
        "vocabularyHintTerms": input.vocabulary_hint_terms,
    })
}

/// Stands in for the real insertion path (a native paste/Accessibility write,
/// or a clipboard copy) in the pipeline benchmark below.
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

    /// Test-only readback proving `insert` actually does the work it claims,
    /// rather than a stub that would also satisfy a pure timing assertion.
    #[cfg(test)]
    fn contents(&self) -> String {
        self.buffer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// One run's worth of stage timings feeding the pipeline receipt. ASR runs
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

struct FixtureBenchmarkResult {
    fixture: String,
    fixture_sha256: String,
    fixture_bytes: usize,
    audio_seconds: f64,
    asr_wall_ms: Vec<u64>,
    last_transcript: String,
    samples: Vec<StageSample>,
}

/// Run the ASR-plus-local-pipeline-plus-mocked-insertion loop for one WAV
/// fixture against an already-prepared (prewarmed) `provider`. Called once
/// per fixture; the caller prewarms and warms up the provider exactly once
/// regardless of how many fixtures follow.
async fn run_fixture_benchmark(
    provider: &dyn plainsong_lib::asr::AsrProvider,
    mock_insertion: &MockInsertionSink,
    wav_path: &Path,
    runs: usize,
    options: &TranscriptionOptions,
) -> Result<FixtureBenchmarkResult, String> {
    let audio_bytes = std::fs::read(wav_path)
        .map_err(|e| format!("Failed to read WAV '{}': {e}", wav_path.display()))?;
    let audio_seconds = wav_duration_seconds(wav_path)?;
    let fixture_sha256 = hex::encode(Sha256::digest(&audio_bytes));
    // Repo-relative, not canonicalized: see `existing_wav_path`'s doc comment
    // for why an absolute path does not belong in a committed-evidence-style
    // receipt.
    let fixture = wav_path.display().to_string();

    let mut asr_wall_ms: Vec<u64> = Vec::with_capacity(runs);
    let mut samples: Vec<StageSample> = Vec::with_capacity(runs);
    let mut last_transcript = String::new();

    for run_index in 1..=runs {
        let start = Instant::now();
        let (text, asr_ms) = match provider
            .transcribe_bytes_with_options(&audio_bytes, options)
            .await
        {
            Ok(result) => {
                let asr_ms = start.elapsed().as_millis() as u64;
                asr_wall_ms.push(asr_ms);
                last_transcript = result.text.clone();
                (result.text, asr_ms)
            }
            Err(e) => {
                return Err(format!(
                    "Transcription run {run_index}/{runs} on '{}' failed: {e}",
                    wav_path.display()
                ));
            }
        };

        // Full post-ASR pipeline, Smart Format off then on, sharing the one
        // ASR result above -- matching reality: ASR runs once regardless of
        // the Smart Format setting. See `build_pipeline_report` for what
        // "format on" does and does not cover.
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

        let insertion_off_ms = mock_insertion.insert(format_off.text.as_str()).as_millis() as u64;
        let insertion_on_ms = mock_insertion.insert(format_on.text.as_str()).as_millis() as u64;

        samples.push(StageSample {
            asr_ms,
            format_off_ms,
            format_on_ms,
            insertion_off_ms,
            insertion_on_ms,
        });
    }

    Ok(FixtureBenchmarkResult {
        fixture,
        fixture_sha256,
        fixture_bytes: audio_bytes.len(),
        audio_seconds,
        asr_wall_ms,
        last_transcript,
        samples,
    })
}

fn fixture_report(result: &FixtureBenchmarkResult) -> serde_json::Value {
    let asr_ms: Vec<u64> = result.samples.iter().map(|sample| sample.asr_ms).collect();
    let format_off_ms: Vec<u64> = result
        .samples
        .iter()
        .map(|sample| sample.format_off_ms)
        .collect();
    let format_on_ms: Vec<u64> = result
        .samples
        .iter()
        .map(|sample| sample.format_on_ms)
        .collect();
    let insertion_off_ms: Vec<u64> = result
        .samples
        .iter()
        .map(|sample| sample.insertion_off_ms)
        .collect();
    let insertion_on_ms: Vec<u64> = result
        .samples
        .iter()
        .map(|sample| sample.insertion_on_ms)
        .collect();
    let total_off_ms: Vec<u64> = result
        .samples
        .iter()
        .map(StageSample::total_off_ms)
        .collect();
    let total_on_ms: Vec<u64> = result
        .samples
        .iter()
        .map(StageSample::total_on_ms)
        .collect();

    serde_json::json!({
        "fixture": result.fixture,
        "fixtureSha256": result.fixture_sha256,
        "fixtureBytes": result.fixture_bytes,
        "audioSeconds": round_two(result.audio_seconds),
        "runs": result.samples.len(),
        "sampleCount": result.samples.len(),
        "stageBreakdownMs": {
            "asr": stage_stats(&asr_ms),
            "formatOff": stage_stats(&format_off_ms),
            "formatOn": stage_stats(&format_on_ms),
            "insertionMockOff": stage_stats(&insertion_off_ms),
            "insertionMockOn": stage_stats(&insertion_on_ms),
        },
        "formatOff": {
            "measurementsMs": total_off_ms,
            "pipelineMsP50": percentile(total_off_ms.clone(), 50.0),
            "pipelineMsP95": percentile(total_off_ms.clone(), 95.0),
        },
        "formatOn": {
            "measurementsMs": total_on_ms,
            "pipelineMsP50": percentile(total_on_ms.clone(), 50.0),
            "pipelineMsP95": percentile(total_on_ms.clone(), 95.0),
        },
    })
}

struct PipelineReportInput<'a> {
    provider: &'a str,
    model: &'a str,
    runs: usize,
    primary: &'a FixtureBenchmarkResult,
    secondary: &'a FixtureBenchmarkResult,
}

/// Build the `metricScope: "asr_and_local_format_only"` receipt.
///
/// The name is deliberately narrower than "end to end," which this measures
/// only a slice of. What it does NOT cover, all excluded on purpose and all
/// documented in the receipt itself so a reader never has to find this
/// comment:
///
/// - The stop *gesture* (hotkey release) and the Electron-to-sidecar IPC hop
///   before `stop_dictation_for_sidecar` even starts its own clock. Compare
///   against the runtime `DictationTimingRecord` in production for that
///   number, which is real but per-session, not a controlled benchmark.
/// - `DICTATION_STOP_CAPTURE_TAIL_MS` (`captureTailExcludedMs` below): a
///   deliberate 120ms sleep the real stop handler awaits, before its own
///   clock starts, so a speaker's final consonant lands in the capture.
/// - Real insertion: mocked (see `MockInsertionSink`) because a headless
///   benchmark has no live GUI target or Accessibility permission, and must
///   not touch the operator's real system clipboard.
/// - The optional LLM-backed Smart Format pass: `formatOn` here measures
///   only the deterministic *local* smart-formatting pass (`text::format`).
///   The LLM pass sits behind `dictation_format_timeout` in `lib.rs`, calls a
///   live model/provider, and cannot be driven safely, deterministically, or
///   offline from a headless benchmark; its real timing and timeout rate are
///   captured by the runtime `DictationTimingRecord` on every live dictation
///   instead.
///
/// Primary numbers (and the only ones any gate threshold applies to) come
/// from a short, single-utterance fixture -- the regime the audit's
/// 130-700ms competitor bar is actually about. The `real-speech-44s.wav`
/// long-form fixture is retained as `secondaryLongForm`, informational only:
/// ASR decode time scales with audio length, so a 44s clip's pipeline time
/// is dominated by that scaling, not by anything this benchmark is meant to
/// gate.
fn build_pipeline_report(input: PipelineReportInput<'_>) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "benchmarkVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "thresholdProfile": "beta-reference-v1",
        "metricScope": "asr_and_local_format_only",
        "hostApplication": "benchmark-cli",
        "warmState": "warm",
        "hardware": hardware_context(),
        "provider": input.provider,
        "model": input.model,
        "percentileBasis": format!("{} repeats of one fixture", input.runs),
        "insertionMocked": true,
        "insertionStrategy": "mocked-in-memory-copy",
        "insertionStrategyNote": "Real system insertion needs a focused GUI target and, for auto mode, macOS Accessibility permission -- neither available in an automated benchmark, and copying to the real system clipboard on every run would also clobber the operator's own clipboard. This measures a same-shape in-memory copy instead (see MockInsertionSink). Real insertion latency is captured in production by the runtime dictation timing record (dictation_timing.rs) and logged on every live dictation.",
        "formatOnScopeNote": "\"formatOn\" measures the deterministic local smart-formatting pass (text::format), not the optional LLM-based Smart Format pass. That pass calls a live model/provider behind dictation_format_timeout (lib.rs) and cannot be driven safely or deterministically from a headless benchmark; its real timing and timeout rate are captured by the runtime dictation timing record on every live dictation.",
        "captureTailExcludedMs": CAPTURE_TAIL_EXCLUDED_MS,
        "captureTailExcludedNote": "The real stop handler (stop_dictation_for_sidecar) awaits a deliberate DICTATION_STOP_CAPTURE_TAIL_MS sleep, so a speaker's final consonant lands in the capture, before its own clock -- and this benchmark's -- ever starts. That wait is real, user-felt latency this receipt does not include.",
        "zeroPointScopeNote": "This receipt's clock starts at transcribe_bytes with audio already in memory. It does not include the stop gesture (hotkey release), the Electron-to-sidecar IPC hop, or audio finalization -- see the runtime DictationTimingRecord (dictation_timing.rs) for those, measured per live session rather than as a controlled benchmark.",
        "primary": fixture_report(input.primary),
        "secondaryLongForm": fixture_report(input.secondary),
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

    // Route the providers' `tracing` lines to stderr (the sidecar's sink too)
    // so a receipt captured from this binary also shows which compute path
    // ran: "Candle using Metal GPU device", "Registering CoreML EP for ...",
    // or the CPU fallback warnings. Without a subscriber those lines are
    // dropped and an acceleration regression is invisible in the output.
    // ONNX Runtime's per-graph-transformer INFO chatter (hundreds of lines per
    // session) is muted by default; its WARN-level partition report still
    // shows. `RUST_LOG` overrides the default filter.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,ort::logging=warn")),
        )
        .init();

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async move {
        let provider = AsrProviderFactory::create_with_model(args.provider_type, Some(&args.model));

        eprintln!(
            "Benchmarking {}/{} -- primary {} + secondary {}, {} runs each...",
            args.provider_name,
            args.model,
            args.wav.display(),
            args.secondary_wav.display(),
            args.runs
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

        // One functional inference warm-up (against the primary fixture)
        // catches a model that loads but cannot decode audio. It is also
        // reported, but not included in either fixture's percentile sample.
        let warmup_audio = match std::fs::read(&args.wav) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("Failed to read WAV '{}': {e}", args.wav.display());
                std::process::exit(2);
            }
        };
        let options = TranscriptionOptions {
            vocabulary_hint: args.vocabulary_hint.clone(),
        };
        let warmup_started = Instant::now();
        let warmup_result = provider
            .transcribe_bytes_with_options(&warmup_audio, &options)
            .await;
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

        let primary = match run_fixture_benchmark(
            provider.as_ref(),
            &mock_insertion,
            &args.wav,
            args.runs,
            &options,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
        let secondary = match run_fixture_benchmark(
            provider.as_ref(),
            &mock_insertion,
            &args.secondary_wav,
            args.runs,
            &options,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };

        if args.print_transcript {
            eprintln!("transcript [{}]: {}", primary.fixture, primary.last_transcript);
            eprintln!(
                "transcript [{}]: {}",
                secondary.fixture, secondary.last_transcript
            );
        }

        let p50 = percentile(primary.asr_wall_ms.clone(), 50.0);
        let p95 = percentile(primary.asr_wall_ms.clone(), 95.0);
        let speedup = if p50 > 0 {
            primary.audio_seconds / (p50 as f64 / 1000.0)
        } else {
            0.0
        };

        let report = build_report(BenchmarkReportInput {
            provider: &args.provider_name,
            model: &args.model,
            fixture: &primary.fixture,
            fixture_sha256: &primary.fixture_sha256,
            fixture_bytes: primary.fixture_bytes,
            audio_seconds: primary.audio_seconds,
            cold_model_preparation_ms,
            warmup_inference_ms,
            wall_ms: &primary.asr_wall_ms,
            transcript: &primary.last_transcript,
            vocabulary_hint_terms: args
                .vocabulary_hint
                .as_ref()
                .map(|hint| hint.terms().len())
                .unwrap_or(0),
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
            "provider-only (primary fixture): p50 {p50}ms, p95 {p95}ms, {speedup:.1}x real-time \
             for {:.1}s of audio.",
            primary.audio_seconds
        );

        let pipeline_report = build_pipeline_report(PipelineReportInput {
            provider: &args.provider_name,
            model: &args.model,
            runs: args.runs,
            primary: &primary,
            secondary: &secondary,
        });
        let pipeline_report_json = serde_json::to_string(&pipeline_report).unwrap();
        if let Some(parent) = args.report_path_e2e.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("Failed to create pipeline latency report directory: {error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = std::fs::write(
            &args.report_path_e2e,
            serde_json::to_string_pretty(&pipeline_report).unwrap() + "\n",
        ) {
            eprintln!(
                "Failed to write pipeline latency report '{}': {error}",
                args.report_path_e2e.display()
            );
            std::process::exit(1);
        }
        println!("{pipeline_report_json}");
        eprintln!(
            "pipeline (primary): format-off p50 {}ms / p95 {}ms, format-on p50 {}ms / p95 {}ms.",
            percentile(primary.samples.iter().map(StageSample::total_off_ms).collect(), 50.0),
            percentile(primary.samples.iter().map(StageSample::total_off_ms).collect(), 95.0),
            percentile(primary.samples.iter().map(StageSample::total_on_ms).collect(), 50.0),
            percentile(primary.samples.iter().map(StageSample::total_on_ms).collect(), 95.0),
        );
        eprintln!(
            "pipeline (secondary, informational only): format-off p50 {}ms / p95 {}ms, format-on p50 {}ms / p95 {}ms.",
            percentile(secondary.samples.iter().map(StageSample::total_off_ms).collect(), 50.0),
            percentile(secondary.samples.iter().map(StageSample::total_off_ms).collect(), 95.0),
            percentile(secondary.samples.iter().map(StageSample::total_on_ms).collect(), 50.0),
            percentile(secondary.samples.iter().map(StageSample::total_on_ms).collect(), 95.0),
        );
        eprintln!(
            "vocabulary hint: {}",
            match &args.vocabulary_hint {
                Some(hint) => format!("{} term(s): {}", hint.terms().len(), hint.as_prompt()),
                None => "none".to_string(),
            }
        );
        eprintln!("transcript (primary, last run): {}", primary.last_transcript);
        eprintln!(
            "transcript (secondary, last run): {}",
            secondary.last_transcript
        );
        eprintln!(
            "note: this benchmark's clock excludes the stop gesture, the Electron-to-sidecar IPC \
             hop, the {CAPTURE_TAIL_EXCLUDED_MS}ms DICTATION_STOP_CAPTURE_TAIL_MS wait, real \
             insertion, and any LLM formatting pass. See the receipt's own scope notes."
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
    fn vocabulary_flag_splits_terms_and_ignores_blanks() {
        let args = match parse_args(&strings(&[
            "--wav",
            "Cargo.toml",
            "--secondary-wav",
            "Cargo.toml",
            "--vocabulary",
            "Plainsong, Kubernetes,, ",
        ]))
        .expect("parse benchmark args")
        {
            ParseOutcome::Run(args) => args,
            ParseOutcome::Help => panic!("expected runnable benchmark args"),
        };
        let hint = args.vocabulary_hint.expect("a hint was given");
        assert_eq!(hint.terms(), ["Plainsong", "Kubernetes"]);
        assert_eq!(hint.as_prompt(), "Vocabulary: Plainsong, Kubernetes.");

        // Blank or missing -> no hint, matching dictation's "never attach an
        // empty prompt" rule.
        assert_eq!(parse_vocabulary_terms(Some(" , ")), None);
        assert_eq!(parse_vocabulary_terms(None), None);
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
    fn missing_secondary_fixture_is_also_rejected_up_front() {
        let error = parse_args(&strings(&[
            "--secondary-wav",
            "/definitely/missing/plainsong-secondary.wav",
        ]))
        .unwrap_err();
        assert!(error.contains("WAV fixture does not exist"), "{error}");
    }

    #[test]
    fn fixture_paths_default_to_repo_relative_short_and_long_form() {
        // Checks the DEFAULT_* constants directly rather than round-tripping
        // through `parse_args` with no `--wav`/`--secondary-wav` override:
        // `cargo test` runs this binary's tests with the crate root
        // (`rust-sidecar/`) as the working directory, not the repo root
        // (`nautilus-bot/`) the defaults are relative to, so the defaults
        // would never resolve here regardless of whether they're correct.
        // `cargo run` (how `bun run benchmark:latency` actually invokes this
        // binary) preserves the caller's cwd instead, which is why the
        // defaults are written relative to the repo root in the first place.
        assert_eq!(
            DEFAULT_WAV, "scripts/fixtures/local-quality-gate.wav",
            "primary fixture must be the short-utterance reference regime"
        );
        assert_eq!(
            DEFAULT_SECONDARY_WAV,
            "scripts/fixtures/real-speech-44s.wav"
        );
        assert!(
            !PathBuf::from(DEFAULT_WAV).is_absolute(),
            "default fixture paths must stay repo-relative, not canonicalized"
        );
    }

    #[test]
    fn print_transcript_is_off_unless_asked_for() {
        let parse = |extra: &[&str]| {
            let mut args = vec!["--wav", "Cargo.toml", "--secondary-wav", "Cargo.toml"];
            args.extend_from_slice(extra);
            match parse_args(&strings(&args)).expect("parse benchmark args") {
                ParseOutcome::Run(args) => args.print_transcript,
                ParseOutcome::Help => panic!("expected runnable benchmark args"),
            }
        };
        assert!(!parse(&[]));
        assert!(parse(&["--print-transcript"]));
    }

    #[test]
    fn report_path_can_be_overridden_without_touching_the_canonical_receipt() {
        let args = match parse_args(&strings(&[
            "--wav",
            "Cargo.toml",
            "--secondary-wav",
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
            fixture: "scripts/fixtures/fixture.wav",
            fixture_sha256: "abc123",
            fixture_bytes: 42,
            audio_seconds: 2.5,
            cold_model_preparation_ms: 80,
            warmup_inference_ms: 100,
            wall_ms: &[250, 300, 400],
            transcript: "spoken fixture",
            vocabulary_hint_terms: 0,
        });

        assert_eq!(report["provider"], "whisper");
        assert_eq!(report["model"], "base.en");
        assert_eq!(report["fixture"], "scripts/fixtures/fixture.wav");
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
        // Fixture existence is irrelevant to this assertion; override both
        // with a file that actually exists relative to `cargo test`'s
        // working directory (the crate root) so only report-path defaulting
        // is under test. See `fixture_paths_default_to_repo_relative_short_and_long_form`
        // for why the real fixture defaults can't be exercised this way.
        let args = match parse_args(&strings(&[
            "--wav",
            "Cargo.toml",
            "--secondary-wav",
            "Cargo.toml",
        ]))
        .expect("parse benchmark args")
        {
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
            "--secondary-wav",
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

    fn fixture_result(fixture: &str, samples: Vec<StageSample>) -> FixtureBenchmarkResult {
        let asr_wall_ms = samples.iter().map(|sample| sample.asr_ms).collect();
        FixtureBenchmarkResult {
            fixture: fixture.to_string(),
            fixture_sha256: "abc123".to_string(),
            fixture_bytes: 42,
            audio_seconds: 2.5,
            asr_wall_ms,
            last_transcript: "spoken fixture".to_string(),
            samples,
        }
    }

    #[test]
    fn stage_sample_totals_sum_asr_format_and_insertion() {
        let sample = stage_sample(90, 2, 5, 1, 1);
        assert_eq!(sample.total_off_ms(), 93);
        assert_eq!(sample.total_on_ms(), 96);
    }

    #[test]
    fn pipeline_report_has_the_scope_and_stage_breakdown_the_gate_expects() {
        let primary = fixture_result(
            "scripts/fixtures/local-quality-gate.wav",
            vec![
                stage_sample(80, 1, 3, 1, 1),
                stage_sample(90, 2, 4, 1, 1),
                stage_sample(100, 1, 3, 1, 2),
            ],
        );
        let secondary = fixture_result(
            "scripts/fixtures/real-speech-44s.wav",
            vec![
                stage_sample(480, 1, 3, 1, 1),
                stage_sample(490, 2, 4, 1, 1),
                stage_sample(500, 1, 3, 1, 2),
            ],
        );
        let report = build_pipeline_report(PipelineReportInput {
            provider: "whisper",
            model: "base.en",
            runs: 3,
            primary: &primary,
            secondary: &secondary,
        });

        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["thresholdProfile"], "beta-reference-v1");
        assert_eq!(report["metricScope"], "asr_and_local_format_only");
        assert_eq!(report["warmState"], "warm");
        assert_eq!(report["provider"], "whisper");
        assert_eq!(report["model"], "base.en");
        assert_eq!(report["percentileBasis"], "3 repeats of one fixture");
        assert_eq!(report["insertionMocked"], true);
        assert_eq!(report["insertionStrategy"], "mocked-in-memory-copy");
        assert_eq!(report["captureTailExcludedMs"], 120);
        assert!(report["insertionStrategyNote"]
            .as_str()
            .unwrap()
            .contains("Accessibility"));
        assert!(report["formatOnScopeNote"]
            .as_str()
            .unwrap()
            .contains("dictation_format_timeout"));
        assert!(report["captureTailExcludedNote"]
            .as_str()
            .unwrap()
            .contains("DICTATION_STOP_CAPTURE_TAIL_MS"));

        // Hard-coded expected values (computed by hand from the sample list
        // above), not the same `percentile` call the report itself uses --
        // a self-referential comparison would pass even if the report fed
        // percentile() the wrong vector entirely.
        //   primary total_off = [82, 93, 102] -> P50 93, P95 102
        //   primary total_on  = [84, 95, 105] -> P50 95, P95 105
        assert_eq!(
            report["primary"]["fixture"],
            "scripts/fixtures/local-quality-gate.wav"
        );
        assert_eq!(report["primary"]["formatOff"]["pipelineMsP50"], 93);
        assert_eq!(report["primary"]["formatOff"]["pipelineMsP95"], 102);
        assert_eq!(report["primary"]["formatOn"]["pipelineMsP50"], 95);
        assert_eq!(report["primary"]["formatOn"]["pipelineMsP95"], 105);
        //   secondary total_off = [482, 493, 502] -> P50 493, P95 502
        //   secondary total_on  = [484, 495, 505] -> P50 495, P95 505
        assert_eq!(
            report["secondaryLongForm"]["fixture"],
            "scripts/fixtures/real-speech-44s.wav"
        );
        assert_eq!(
            report["secondaryLongForm"]["formatOff"]["pipelineMsP50"],
            493
        );
        assert_eq!(
            report["secondaryLongForm"]["formatOff"]["pipelineMsP95"],
            502
        );
        assert_eq!(
            report["secondaryLongForm"]["formatOn"]["pipelineMsP50"],
            495
        );
        assert_eq!(
            report["secondaryLongForm"]["formatOn"]["pipelineMsP95"],
            505
        );

        for stage in [
            "asr",
            "formatOff",
            "formatOn",
            "insertionMockOff",
            "insertionMockOn",
        ] {
            assert!(
                report["primary"]["stageBreakdownMs"][stage]["p50"].is_u64(),
                "missing stage breakdown for {stage}"
            );
            assert!(
                report["primary"]["stageBreakdownMs"][stage]["measurementsMs"]
                    .as_array()
                    .is_some_and(|values| values.len() == 3),
                "stage {stage} should keep one measurement per run"
            );
        }
    }

    #[test]
    fn mock_insertion_sink_actually_stores_what_it_is_given() {
        let sink = MockInsertionSink::new();
        // Must not touch the real system clipboard: running this test (or
        // the benchmark) repeatedly must never depend on, or clobber,
        // whatever the operator has actually copied.
        let short_text = "hi";
        let long_text = "a".repeat(10_000);

        let elapsed_short = sink.insert(short_text);
        // A stub that never touches the buffer would still pass a bare
        // "< 50ms" timing assertion; reading the content back is what
        // proves `insert` did real, correct work.
        assert_eq!(sink.contents(), short_text);
        assert!(elapsed_short.as_millis() < 50);

        let elapsed_long = sink.insert(&long_text);
        assert_eq!(sink.contents(), long_text);
        assert!(elapsed_long.as_millis() < 50);
    }
}
