//! Run finished meeting recordings through Plainsong's post-capture meeting
//! path headlessly and write what the transcript would contain.
//!
//! ```text
//! meeting-eval --provider parakeet [--model <id>] [--whole-file]
//!              [--diarization <model id> | --no-diarization]
//!              [--transcript-from <earlier report.json>]
//!              [--diar-absorb <share|off>] [--diar-fold-distance <d|off>]
//!              [--diar-fold-max-windows <n>] [--diar-fold-min-windows <n>]
//!              [--mic <mic.wav> --system <system.wav>]
//!              [--asides <spans.json> [--canaries <word,word>]]
//!              --out <report.json> <recording.wav>
//! ```
//!
//! `--asides` names a JSON array of aside spans (`meeting_asides::AsideSpan`)
//! on the Me track: the `--mic` track, or the recording itself when it is
//! microphone-only. The report's `asides` section counts each `--canaries`
//! word in the stored transcript, in the notes input and in the asides' own
//! decode; only the last may be non-zero.
//!
//! With `--mic` and `--system`, `<recording.wav>` is the mixed track of a
//! "Me + Them" meeting and the run takes the app's source-aware path instead
//! (rows labelled "me" and "them"; diarization does not apply). Adding
//! `--transcript-from <earlier source-aware report>` skips the recogniser and
//! reruns only the far-side bleed check on that report's rows.
//!
//! Requires `PLAINSONG_DATA_DIR` and `PLAINSONG_CONFIG_DIR` to name an isolated
//! profile (models are verified there and receipts written beside them); the
//! user's own data directory is refused. The report holds the transcript rows
//! before and after the diarization merge, the diarizer's turns, the chunk
//! boundaries, and wall time and peak RSS per stage. See `meeting_eval.rs`.

use plainsong_lib::asr::AsrProviderType;
use plainsong_lib::meeting_eval::{self, MeetingEvalAsrMode, MeetingEvalOptions};
use std::path::PathBuf;

fn provider_from_str(value: &str) -> Option<AsrProviderType> {
    Some(match value {
        "parakeet" => AsrProviderType::Parakeet,
        "whisper" => AsrProviderType::Whisper,
        "distil_whisper" => AsrProviderType::DistilWhisper,
        #[cfg(feature = "asr-transcribe-cpp")]
        "transcribe_cpp" => AsrProviderType::TranscribeCpp,
        _ => return None,
    })
}

/// Flags that take a value; every other `--flag` is a switch.
const VALUE_FLAGS: [&str; 13] = [
    "--mic",
    "--system",
    "--asides",
    "--canaries",
    "--provider",
    "--model",
    "--diarization",
    "--transcript-from",
    "--diar-absorb",
    "--diar-fold-distance",
    "--diar-fold-max-windows",
    "--diar-fold-min-windows",
    "--out",
];
const SWITCHES: [&str; 2] = ["--whole-file", "--no-diarization"];

/// Split the command line into flags with values, switches and positional
/// arguments, refusing an unknown flag or a value flag with nothing after it.
/// The recording must be given as the one positional argument: taking "the
/// last word" let a forgotten path turn a flag's value into the audio.
struct ParsedArgs {
    values: Vec<(String, String)>,
    switches: Vec<String>,
    audio: PathBuf,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let (mut values, mut switches, mut positional) = (Vec::new(), Vec::new(), Vec::new());
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if VALUE_FLAGS.contains(&arg.as_str()) {
            let value = iter.next().ok_or_else(|| format!("{arg} needs a value"))?;
            values.push((arg.clone(), value.clone()));
        } else if SWITCHES.contains(&arg.as_str()) {
            switches.push(arg.clone());
        } else if arg.starts_with("--") {
            return Err(format!("Unknown option {arg}"));
        } else {
            positional.push(arg.clone());
        }
    }
    match positional.as_slice() {
        [audio] => Ok(ParsedArgs {
            values,
            switches,
            audio: PathBuf::from(audio),
        }),
        [] => Err("Name the recording to evaluate".to_string()),
        _ => Err(format!(
            "Expected one recording, got {}",
            positional.join(" ")
        )),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "Usage: meeting-eval --provider <name> [--model <id>] [--whole-file] \
                 [--diarization <model id> | --no-diarization] [--transcript-from <report.json>] \
                 [--diar-absorb <share|off>] [--diar-fold-distance <d|off>] \
                 [--diar-fold-max-windows <n>] [--diar-fold-min-windows <n>] \
                 [--mic <mic.wav> --system <system.wav>] \
                 --out <report.json> <recording.wav>";
    let ParsedArgs {
        values,
        switches,
        audio,
    } = match parse_args(&args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}\n{usage}");
            std::process::exit(2);
        }
    };
    let value = |flag: &str| {
        values
            .iter()
            .find(|(name, _)| name == flag)
            .map(|(_, value)| value.clone())
    };
    let flag = |name: &str| switches.iter().any(|arg| arg == name);
    if !audio.is_file() {
        eprintln!("No recording at {}", audio.display());
        std::process::exit(2);
    }
    let (Some(provider_name), Some(out)) = (value("--provider"), value("--out")) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    let Some(provider) = provider_from_str(&provider_name) else {
        eprintln!("Unknown provider '{provider_name}'");
        std::process::exit(2);
    };
    let mut refinement = meeting_eval::DEFAULT_CLUSTER_REFINEMENT;
    match value("--diar-absorb").as_deref() {
        None => {}
        Some("off") => refinement.minor_cluster_share = None,
        Some(text) => match text.parse::<f64>() {
            Ok(share) => refinement.minor_cluster_share = Some(share),
            Err(_) => {
                eprintln!("--diar-absorb takes a share or 'off'");
                std::process::exit(2);
            }
        },
    }
    match value("--diar-fold-distance").as_deref() {
        None => {}
        Some("off") => refinement.minor_cluster_fold_distance = None,
        Some(text) => match text.parse::<f32>() {
            Ok(distance) => refinement.minor_cluster_fold_distance = Some(distance),
            Err(_) => {
                eprintln!("--diar-fold-distance takes a cosine distance or 'off'");
                std::process::exit(2);
            }
        },
    }
    if let Some(text) = value("--diar-fold-max-windows") {
        match text.parse::<usize>() {
            Ok(windows) => refinement.minor_cluster_max_windows = windows,
            Err(_) => {
                eprintln!("--diar-fold-max-windows takes a window count");
                std::process::exit(2);
            }
        }
    }
    if let Some(text) = value("--diar-fold-min-windows") {
        match text.parse::<usize>() {
            Ok(windows) => refinement.minor_cluster_min_voice_windows = windows,
            Err(_) => {
                eprintln!("--diar-fold-min-windows takes a window count");
                std::process::exit(2);
            }
        }
    }
    let options = MeetingEvalOptions {
        audio,
        provider,
        model_id: value("--model").unwrap_or_else(|| provider.default_model_id().to_string()),
        asr_mode: if flag("--whole-file") {
            MeetingEvalAsrMode::WholeFile
        } else {
            MeetingEvalAsrMode::MeetingChunks
        },
        diarization_model_id: if flag("--no-diarization") || value("--mic").is_some() {
            None
        } else {
            Some(value("--diarization").unwrap_or_else(|| "ecapa_tdnn_speaker".to_string()))
        },
        transcript_from: value("--transcript-from").map(PathBuf::from),
        refinement,
        source_tracks: match (value("--mic"), value("--system")) {
            (Some(mic), Some(system)) => Some((PathBuf::from(mic), PathBuf::from(system))),
            (None, None) => None,
            _ => {
                eprintln!("--mic and --system go together");
                std::process::exit(2);
            }
        },
        aside_spans: match value("--asides") {
            None => Vec::new(),
            Some(path) => match std::fs::read(&path)
                .map_err(|error| error.to_string())
                .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
            {
                Ok(spans) => spans,
                Err(error) => {
                    eprintln!("--asides {path}: {error}");
                    std::process::exit(2);
                }
            },
        },
        canaries: value("--canaries")
            .map(|words| {
                words
                    .split(',')
                    .map(str::trim)
                    .filter(|word| !word.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    if let Err(error) = meeting_eval::require_isolated_profile() {
        eprintln!("Refusing to run: {error}");
        std::process::exit(2);
    }

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let report = runtime.block_on(async {
        meeting_eval::verify_models(&options).await?;
        meeting_eval::run(&options).await
    });
    match report {
        Ok(report) => {
            let json = serde_json::to_string_pretty(&report).expect("serialize report");
            if let Err(error) = std::fs::write(&out, json) {
                eprintln!("Failed to write {out}: {error}");
                leave(2);
            }
            eprintln!(
                "{} {}/{}: {:.1}s audio, ASR {} ms (RTF {:.3}), diarization {:?} ms, peak RSS {:.2} GiB, peak footprint {:.2} GiB",
                report.asr_mode,
                report.provider,
                report.model_id,
                report.duration_seconds,
                report.asr_wall_ms,
                report.asr_wall_ms as f64 / 1000.0 / report.duration_seconds.max(0.001),
                report.diarization_wall_ms,
                meeting_eval::peak_rss_bytes() as f64 / (1u64 << 30) as f64,
                meeting_eval::peak_footprint_bytes() as f64 / (1u64 << 30) as f64,
            );
            if let Some(error) = report.diarization_error {
                eprintln!("Diarization failed: {error}");
            }
            leave(0);
        }
        Err(error) => {
            eprintln!("Error: {error:#}");
            leave(1);
        }
    }
}

/// Exit without running C++ static destructors. The report is already on
/// disk; ggml's Metal device teardown asserts at exit
/// (`GGML_ASSERT([rsets->data count] == 0)`) after a transcribe.cpp decode,
/// which turned every successful GGUF run into an abort and a crash report.
fn leave(code: i32) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    // SAFETY: `_exit` takes no pointers and never returns.
    unsafe { libc::_exit(code) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &str) -> Vec<String> {
        words.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn the_recording_is_the_one_positional_argument() {
        let ParsedArgs {
            values,
            switches,
            audio,
        } = parse_args(&args("--provider parakeet a.wav --out r.json --whole-file")).unwrap();
        assert_eq!(audio, PathBuf::from("a.wav"));
        assert!(values.contains(&("--out".to_string(), "r.json".to_string())));
        assert_eq!(switches, ["--whole-file"]);
    }

    #[test]
    fn a_missing_recording_is_not_taken_from_a_flag_value() {
        // Before, the last word ("r.json") became the audio.
        assert!(parse_args(&args("--provider parakeet --out r.json")).is_err());
        assert!(parse_args(&args("--provider parakeet --out")).is_err());
        assert!(parse_args(&args("--provider parakeet --out r.json a.wav b.wav")).is_err());
        assert!(parse_args(&args("--provider parakeet --typo x --out r.json a.wav")).is_err());
    }
}
