//! Real dictation transcription latency benchmark.
//!
//! Unlike the old fixture-multiplied "benchmark", this runs actual audio
//! through the actual ASR provider and reports MEASURED wall-clock latency and
//! the real-time factor (RTF = audio_seconds / transcription_seconds; higher is
//! faster than real time). It requires the chosen model to be downloaded.
//!
//! Usage:
//!   benchmark-latency [--wav <path>] [--provider <name>] [--model <id>] [--runs N]
//!
//! Defaults: the bundled fixture, provider `whisper`, model `base.en`, 5 runs.
//! Output: a JSON line on stdout plus a human-readable summary on stderr.

use plainsong_lib::asr::{AsrProviderFactory, AsrProviderType};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

const DEFAULT_WAV: &str = "scripts/fixtures/real-speech-44s.wav";
const DEFAULT_PROVIDER: &str = "whisper";
const DEFAULT_RUNS: usize = 5;
const MAX_RUNS: usize = 100;
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
  -h, --help          Print this help without loading a model

Output:
  One JSON object on stdout. Progress and the human summary are written to stderr.";

#[derive(Debug, Clone, PartialEq, Eq)]
struct BenchmarkArgs {
    wav: PathBuf,
    provider_name: String,
    provider_type: AsrProviderType,
    model: String,
    runs: usize,
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
    warmup_ms: u64,
    wall_ms: &'a [u64],
    transcript: &'a str,
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

    serde_json::json!({
        "benchmarkVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "provider": input.provider,
        "model": input.model,
        "fixture": input.fixture,
        "fixtureSha256": input.fixture_sha256,
        "fixtureBytes": input.fixture_bytes,
        "audioSeconds": round_two(input.audio_seconds),
        "warmupMs": input.warmup_ms,
        "runs": input.wall_ms.len(),
        "measurementsMs": input.wall_ms,
        "transcriptionMsP50": p50,
        "transcriptionMsP95": p95,
        "realTimeFactor": round_two(real_time_factor),
        "realTimeFactorDefinition": "transcription_seconds / audio_seconds; lower is faster",
        "realtimeSpeedup": round_two(realtime_speedup),
        "transcriptSample": transcript_sample,
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

        // Warm-up run (pays model load); not timed.
        let warmup_started = Instant::now();
        let warmup_result = provider.transcribe_bytes(&audio_bytes).await;
        let warmup_ms = warmup_started.elapsed().as_millis() as u64;
        if let Err(e) = warmup_result {
            eprintln!(
                "Transcription warm-up failed for {}/{}: {e}\n\
                 Download the selected model in Plainsong or run the model-provisioning step.",
                args.provider_name, args.model
            );
            std::process::exit(1);
        }

        let mut wall_ms: Vec<u64> = Vec::with_capacity(args.runs);
        let mut last_text = String::new();
        for run_index in 1..=args.runs {
            let start = Instant::now();
            match provider.transcribe_bytes(&audio_bytes).await {
                Ok(result) => {
                    wall_ms.push(start.elapsed().as_millis() as u64);
                    last_text = result.text;
                }
                Err(e) => {
                    eprintln!("Transcription run {run_index}/{} failed: {e}", args.runs);
                    std::process::exit(1);
                }
            }
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
            warmup_ms,
            wall_ms: &wall_ms,
            transcript: &last_text,
        });
        println!("{}", serde_json::to_string(&report).unwrap());
        eprintln!(
            "p50 {p50}ms, p95 {p95}ms, {speedup:.1}x real-time for \
             {audio_seconds:.1}s of audio."
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
    fn report_contains_complete_measurement_context() {
        let report = build_report(BenchmarkReportInput {
            provider: "whisper",
            model: "base.en",
            fixture: "/tmp/fixture.wav",
            fixture_sha256: "abc123",
            fixture_bytes: 42,
            audio_seconds: 2.5,
            warmup_ms: 100,
            wall_ms: &[250, 300, 400],
            transcript: "spoken fixture",
        });

        assert_eq!(report["provider"], "whisper");
        assert_eq!(report["model"], "base.en");
        assert_eq!(report["fixture"], "/tmp/fixture.wav");
        assert_eq!(report["fixtureSha256"], "abc123");
        assert_eq!(report["fixtureBytes"], 42);
        assert_eq!(report["audioSeconds"], 2.5);
        assert_eq!(report["warmupMs"], 100);
        assert_eq!(report["runs"], 3);
        assert_eq!(report["measurementsMs"], serde_json::json!([250, 300, 400]));
        assert_eq!(report["transcriptionMsP50"], 300);
        assert_eq!(report["transcriptionMsP95"], 400);
        assert_eq!(report["realTimeFactor"], 0.12);
        assert_eq!(report["realtimeSpeedup"], 8.33);
        assert_eq!(report["transcriptSample"], "spoken fixture");
    }
}
