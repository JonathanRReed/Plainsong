use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use nautilus_bot_lib::dictation_parity::{
    generate_dictation_benchmark_run, DictationBenchmarkContext, DictationBenchmarkFixture,
};

fn value_for(args: &[String], name: &str, fallback: Option<&str>) -> Option<String> {
    args.windows(2)
        .find_map(|window| (window[0] == name).then(|| window[1].clone()))
        .or_else(|| fallback.map(ToString::to_string))
}

fn required_value(args: &[String], name: &str) -> Result<String> {
    value_for(args, name, None).with_context(|| format!("missing required argument: {name}"))
}

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();

    let fixtures_path = PathBuf::from(required_value(&args, "--fixtures")?);
    let output_path = PathBuf::from(required_value(&args, "--out")?);
    let run_id = required_value(&args, "--run-id")?;
    let generated_at = required_value(&args, "--generated-at")?;
    let build_version = required_value(&args, "--build-version")?;
    let build_commit = required_value(&args, "--build-commit")?;
    let platform_os = required_value(&args, "--platform-os")?;
    let platform_os_version = required_value(&args, "--platform-version")?;
    let device = required_value(&args, "--device")?;
    let latency_scale = required_value(&args, "--latency-scale")?
        .parse::<f64>()
        .context("invalid --latency-scale value")?;

    let fixture = serde_json::from_slice::<DictationBenchmarkFixture>(
        &fs::read(&fixtures_path)
            .with_context(|| format!("failed to read fixture file {}", fixtures_path.display()))?,
    )
    .with_context(|| format!("failed to parse fixture file {}", fixtures_path.display()))?;

    let context = DictationBenchmarkContext {
        run_id,
        generated_at,
        build_version,
        build_commit,
        platform_os,
        platform_os_version,
        device,
        latency_scale,
    };

    let run = generate_dictation_benchmark_run(&fixture, &context);
    let json = serde_json::to_string_pretty(&run).context("failed to serialize benchmark run")?;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }

    fs::write(&output_path, format!("{json}\n"))
        .with_context(|| format!("failed to write output file {}", output_path.display()))?;

    println!("{}", output_path.display());

    Ok(())
}
