#[path = "../src/dictation_parity.rs"]
mod dictation_parity;

use dictation_parity::{
    generate_dictation_benchmark_run, DictationBenchmarkContext, DictationBenchmarkFixture,
};
use std::fs;
use std::path::PathBuf;

fn arg_value(args: &[String], name: &str, default: Option<&str>) -> String {
    let mut resolved = default.map(str::to_string).unwrap_or_default();
    for window in args.windows(2) {
        if window[0] == name {
            resolved = window[1].clone();
        }
    }
    resolved
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();

    let fixtures_path = PathBuf::from(arg_value(
        &args,
        "--fixtures",
        Some("docs/evals/dictation-parity-fixture.json"),
    ));
    let output_path = PathBuf::from(arg_value(
        &args,
        "--out",
        Some("artifacts/evals/dictation-benchmark-run.json"),
    ));
    let latency_scale = arg_value(&args, "--latency-scale", Some("1.0"))
        .parse::<f64>()
        .unwrap_or(1.0)
        .max(0.01);

    let fixture =
        serde_json::from_str::<DictationBenchmarkFixture>(&fs::read_to_string(&fixtures_path)?)?;
    let context = DictationBenchmarkContext {
        run_id: arg_value(&args, "--run-id", Some("dictation-parity-benchmark")),
        generated_at: arg_value(
            &args,
            "--generated-at",
            Some(&chrono::Utc::now().to_rfc3339()),
        ),
        build_version: arg_value(&args, "--build-version", Some("nautilus-dev")),
        build_commit: arg_value(&args, "--build-commit", Some("unknown")),
        platform_os: arg_value(&args, "--platform-os", Some("macOS")),
        platform_os_version: arg_value(&args, "--platform-version", Some("unknown")),
        device: arg_value(&args, "--device", Some("unknown")),
        latency_scale,
    };

    let run = generate_dictation_benchmark_run(&fixture, &context);
    let payload = serde_json::to_string_pretty(&run)?;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output_path, format!("{payload}\n"))?;

    println!("{payload}");
    Ok(())
}
