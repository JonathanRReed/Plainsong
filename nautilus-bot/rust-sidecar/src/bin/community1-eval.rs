//! Run Plainsong's pyannote community-1 port over one recording, headlessly.
//!
//! ```text
//! community1-eval --bundle <dir> --out <raw.json> [--dump <dir>] <recording.wav>
//! ```
//!
//! `--bundle` names a directory holding the six community-1 bundle files
//! (nothing is written beside them, and nothing is downloaded).
//! The JSON matches `scripts/pyannote-community1/ref_dump.py`'s: regular and
//! exclusive turns, wall time per stage. `--dump` writes every stage as
//! `.npy` for `compare_stages.py`.

#[cfg(feature = "diarization")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut bundle = None;
    let mut out = None;
    let mut dump = None;
    let mut audio = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--bundle" => bundle = iter.next().cloned(),
            "--out" => out = iter.next().cloned(),
            "--dump" => dump = iter.next().cloned(),
            flag if flag.starts_with("--") => {
                eprintln!("Unknown option {flag}");
                std::process::exit(2);
            }
            path => audio = Some(path.to_string()),
        }
    }
    let (Some(bundle), Some(out), Some(audio)) = (bundle, out, audio) else {
        eprintln!(
            "usage: community1-eval --bundle <dir> --out <raw.json> [--dump <dir>] <recording.wav>"
        );
        std::process::exit(2);
    };
    let result = plainsong_lib::community1_eval::eval_file(
        std::path::Path::new(&bundle),
        std::path::Path::new(&audio),
        dump.as_deref().map(std::path::Path::new),
    );
    match result {
        Ok(mut report) => {
            report["peakRssBytes"] = plainsong_lib::meeting_eval::peak_rss_bytes().into();
            report["peakFootprintBytes"] =
                plainsong_lib::meeting_eval::peak_footprint_bytes().into();
            eprintln!(
                "{audio}: {} speakers, run {:.1}s ({:.0}x RT), stages {}",
                report["speakers"],
                report["runS"].as_f64().unwrap_or(0.0),
                report["rtfx"].as_f64().unwrap_or(0.0),
                report["stageS"]
            );
            if let Err(error) =
                std::fs::write(&out, serde_json::to_vec_pretty(&report).expect("json"))
            {
                eprintln!("Failed to write {out}: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("community1-eval failed: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(feature = "diarization"))]
fn main() {
    eprintln!("community1-eval needs the `diarization` feature.");
    std::process::exit(2);
}
