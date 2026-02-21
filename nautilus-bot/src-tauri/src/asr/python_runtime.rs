use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::Command as TokioCommand;

fn python_probe_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Find a Python executable that can import the required runtime probe modules.
///
/// Resolution order:
/// 1. `NAUTILUS_PYTHON` env var (if set)
/// 2. common versioned python commands
/// 3. common absolute Homebrew / system paths
pub fn find_python_with_imports(import_probe: &str) -> Option<String> {
    let probe_key = import_probe.trim().to_string();
    if probe_key.is_empty() {
        return None;
    }

    if let Ok(cache) = python_probe_cache().lock() {
        if let Some(cached) = cache.get(&probe_key) {
            return cached.clone();
        }
    }

    let mut candidates: Vec<String> = Vec::new();

    if let Ok(value) = std::env::var("NAUTILUS_PYTHON") {
        if !value.trim().is_empty() {
            candidates.push(value);
        }
    }

    candidates.extend(
        [
            "python3.11",
            "python3.12",
            "python3.10",
            "python3",
            "/opt/homebrew/bin/python3.11",
            "/opt/homebrew/bin/python3.12",
            "/usr/local/bin/python3.11",
            "/usr/local/bin/python3.12",
            "/usr/bin/python3",
        ]
        .iter()
        .map(|value| (*value).to_string()),
    );

    let mut seen = HashSet::new();
    let mut resolved: Option<String> = None;
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }

        let output = Command::new(&candidate).args(["-c", import_probe]).output();

        if let Ok(result) = output {
            if result.status.success() {
                resolved = Some(candidate);
                break;
            }
        }
    }

    if let Ok(mut cache) = python_probe_cache().lock() {
        cache.insert(probe_key, resolved.clone());
    }

    resolved
}

pub fn find_python_for_provider(provider: &str) -> Option<String> {
    let probe = match provider {
        "vibevoice" | "voxtral_local" => {
            "import torch; import transformers; import soundfile; import librosa"
        }
        _ => "import json",
    };
    find_python_with_imports(probe)
}

fn runner_script_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("python")
        .join("asr")
        .join("runner.py")
}

#[derive(Debug, Deserialize)]
pub struct PythonAsrActionOutput {
    pub ok: bool,
    pub text: Option<String>,
    pub language: Option<String>,
    pub confidence: Option<f64>,
    pub error: Option<String>,
}

pub async fn run_python_asr_action(
    provider: &str,
    action: &str,
    model_id: Option<&str>,
    model_dir: &Path,
    audio_path: Option<&Path>,
    timeout_seconds: u64,
) -> Result<PythonAsrActionOutput> {
    let python = find_python_for_provider(provider).ok_or_else(|| {
        anyhow!(
            "Python runtime with required modules for '{}' is not available",
            provider
        )
    })?;

    let script = runner_script_path();
    if !script.exists() {
        return Err(anyhow!(
            "Python ASR runner script not found at {}",
            script.display()
        ));
    }

    let mut cmd = TokioCommand::new(&python);
    cmd.arg(script)
        .arg("--provider")
        .arg(provider)
        .arg("--action")
        .arg(action)
        .arg("--model-dir")
        .arg(model_dir)
        .env("PYTHONUNBUFFERED", "1");

    if let Some(model_id) = model_id {
        cmd.arg("--model-id").arg(model_id);
    }

    if let Some(audio_path) = audio_path {
        cmd.arg("--audio-path").arg(audio_path);
    }

    let output = tokio::time::timeout(Duration::from_secs(timeout_seconds), cmd.output())
        .await
        .map_err(|_| {
            anyhow!(
                "Python {} action for '{}' timed out after {} seconds",
                action,
                provider,
                timeout_seconds
            )
        })?
        .context("Failed to execute Python ASR runner")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no error output".to_string()
        };
        return Err(anyhow!(
            "Python {} action for '{}' failed: {}",
            action,
            provider,
            detail
        ));
    }

    let stdout =
        String::from_utf8(output.stdout).context("Python ASR runner returned non-UTF8 output")?;
    let parsed: PythonAsrActionOutput = serde_json::from_str(stdout.trim())
        .with_context(|| format!("Failed to parse Python ASR output: {}", stdout.trim()))?;

    if !parsed.ok {
        let msg = parsed
            .error
            .clone()
            .unwrap_or_else(|| "Unknown Python ASR runtime error".to_string());
        return Err(anyhow!(msg));
    }

    Ok(parsed)
}
