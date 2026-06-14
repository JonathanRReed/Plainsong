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
use std::time::Instant;

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let idx = args.iter().position(|a| a == name)?;
    args.get(idx + 1).cloned()
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

fn wav_duration_seconds(path: &str) -> Option<f64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }
    let frames = reader.len() as f64 / spec.channels as f64;
    Some(frames / spec.sample_rate as f64)
}

fn percentile(mut values: Vec<u64>, p: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let rank = ((p / 100.0) * values.len() as f64).ceil() as usize;
    values[rank.saturating_sub(1).min(values.len() - 1)]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wav = arg_value(&args, "--wav")
        .unwrap_or_else(|| "scripts/fixtures/local-perf-30s.wav".to_string());
    let provider_name = arg_value(&args, "--provider").unwrap_or_else(|| "whisper".to_string());
    let model = arg_value(&args, "--model").unwrap_or_else(|| "base.en".to_string());
    let runs: usize = arg_value(&args, "--runs")
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);

    let Some(provider_type) = provider_from_str(&provider_name) else {
        eprintln!("Unknown provider '{provider_name}'. Try: whisper, parakeet, moonshine.");
        std::process::exit(2);
    };

    let audio_bytes = match std::fs::read(&wav) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("Failed to read WAV '{wav}': {e}");
            std::process::exit(2);
        }
    };
    let audio_seconds = wav_duration_seconds(&wav).unwrap_or(0.0);

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async move {
        let provider = AsrProviderFactory::create_with_model(provider_type, Some(&model));

        eprintln!(
            "Benchmarking {provider_name}/{model} on {wav} ({audio_seconds:.1}s audio), {runs} runs…"
        );

        // Warm-up run (pays model load); not timed.
        if let Err(e) = provider.transcribe_bytes(&audio_bytes).await {
            eprintln!(
                "Transcription failed (is the model downloaded?): {e}\n\
                 Download it in-app or run the model-provisioning step first."
            );
            std::process::exit(1);
        }

        let mut wall_ms: Vec<u64> = Vec::with_capacity(runs);
        let mut last_text = String::new();
        for _ in 0..runs {
            let start = Instant::now();
            match provider.transcribe_bytes(&audio_bytes).await {
                Ok(result) => {
                    wall_ms.push(start.elapsed().as_millis() as u64);
                    last_text = result.text;
                }
                Err(e) => {
                    eprintln!("Transcription run failed: {e}");
                    std::process::exit(1);
                }
            }
        }

        let p50 = percentile(wall_ms.clone(), 50.0);
        let p95 = percentile(wall_ms.clone(), 95.0);
        let rtf = if p50 > 0 {
            audio_seconds / (p50 as f64 / 1000.0)
        } else {
            0.0
        };

        let sample: String = last_text.chars().take(80).collect();
        let report = serde_json::json!({
            "provider": provider_name,
            "model": model,
            "wav": wav,
            "audioSeconds": (audio_seconds * 100.0).round() / 100.0,
            "runs": runs,
            "transcriptionMsP50": p50,
            "transcriptionMsP95": p95,
            "realTimeFactor": (rtf * 100.0).round() / 100.0,
            "transcriptSample": sample,
        });
        println!("{}", serde_json::to_string(&report).unwrap());
        eprintln!(
            "→ p50 {p50}ms, p95 {p95}ms, {rtf:.1}x real-time for {audio_seconds:.1}s of audio."
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
