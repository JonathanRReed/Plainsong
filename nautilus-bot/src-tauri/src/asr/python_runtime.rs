use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

fn python_probe_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn managed_runtime_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
        .join("runtime")
        .join("python")
}

fn managed_venv_dir() -> PathBuf {
    managed_runtime_root().join("asr")
}

#[cfg(target_os = "windows")]
fn managed_python_executable(venv_dir: &Path) -> PathBuf {
    venv_dir.join("Scripts").join("python.exe")
}

#[cfg(not(target_os = "windows"))]
fn managed_python_executable(venv_dir: &Path) -> PathBuf {
    venv_dir.join("bin").join("python3")
}

pub fn managed_python_path() -> Option<String> {
    let python = managed_python_executable(&managed_venv_dir());
    if python.exists() {
        Some(python.to_string_lossy().to_string())
    } else {
        None
    }
}

pub fn clear_runtime_probe_cache() {
    if let Ok(mut cache) = python_probe_cache().lock() {
        cache.clear();
    }
}

fn python_worker_cache(
) -> &'static tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<PythonAsrWorker>>>> {
    static CACHE: OnceLock<
        tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<PythonAsrWorker>>>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

struct PythonAsrWorker {
    provider: String,
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct WorkerRequest {
    action: String,
    model_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
}

impl PythonAsrWorker {
    fn spawn(provider: &str, python: &str) -> Result<Self> {
        let script = runner_script_path();
        if !script.exists() {
            return Err(anyhow!(
                "Python ASR runner script not found at {}",
                script.display()
            ));
        }

        let mut cmd = TokioCommand::new(python);
        cmd.arg(script)
            .arg("--provider")
            .arg(provider)
            .arg("--action")
            .arg("serve")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PYTHONUNBUFFERED", "1");

        let mut child = cmd
            .spawn()
            .with_context(|| format!("Failed to spawn Python ASR worker for '{}'", provider))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Failed to acquire stdin for Python ASR worker"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Failed to acquire stdout for Python ASR worker"))?;

        Ok(Self {
            provider: provider.to_string(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    async fn send_request(
        &mut self,
        request: &WorkerRequest,
        timeout_seconds: u64,
    ) -> Result<PythonAsrActionOutput> {
        let payload =
            serde_json::to_string(request).context("Failed to encode Python ASR worker request")?;
        self.stdin
            .write_all(payload.as_bytes())
            .await
            .with_context(|| {
                format!(
                    "Failed writing request to Python ASR worker for '{}'",
                    self.provider
                )
            })?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;

        let mut response_line = String::new();
        let bytes_read = tokio::time::timeout(
            Duration::from_secs(timeout_seconds),
            self.stdout.read_line(&mut response_line),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Python ASR worker '{}' timed out after {} seconds",
                self.provider,
                timeout_seconds
            )
        })?
        .with_context(|| {
            format!(
                "Failed reading response from Python ASR worker for '{}'",
                self.provider
            )
        })?;

        if bytes_read == 0 {
            let stderr = if let Some(mut stderr_pipe) = self.child.stderr.take() {
                let mut stderr_buf = Vec::new();
                let _ = stderr_pipe.read_to_end(&mut stderr_buf).await;
                String::from_utf8_lossy(&stderr_buf).trim().to_string()
            } else {
                String::new()
            };
            let detail = if stderr.is_empty() {
                "no stderr output".to_string()
            } else {
                stderr
            };
            return Err(anyhow!(
                "Python ASR worker '{}' exited unexpectedly: {}",
                self.provider,
                detail
            ));
        }

        parse_python_asr_stdout(response_line.trim())
    }

    async fn shutdown(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

fn supports_persistent_worker(provider: &str) -> bool {
    matches!(provider, "voxtral_local")
}

async fn get_or_spawn_worker(
    provider: &str,
    python: &str,
) -> Result<Arc<tokio::sync::Mutex<PythonAsrWorker>>> {
    {
        let cache = python_worker_cache().lock().await;
        if let Some(existing) = cache.get(provider) {
            return Ok(existing.clone());
        }
    }

    let worker = Arc::new(tokio::sync::Mutex::new(PythonAsrWorker::spawn(
        provider, python,
    )?));
    let mut cache = python_worker_cache().lock().await;
    Ok(cache
        .entry(provider.to_string())
        .or_insert_with(|| worker.clone())
        .clone())
}

async fn remove_worker(provider: &str) {
    let maybe_worker = {
        let mut cache = python_worker_cache().lock().await;
        cache.remove(provider)
    };

    if let Some(worker) = maybe_worker {
        let mut guard = worker.lock().await;
        guard.shutdown().await;
    }
}

pub async fn shutdown_python_workers() {
    let workers = {
        let mut cache = python_worker_cache().lock().await;
        cache.drain().map(|(_, worker)| worker).collect::<Vec<_>>()
    };

    for worker in workers {
        let mut guard = worker.lock().await;
        guard.shutdown().await;
    }
}

fn provider_import_probe(provider: &str) -> &'static str {
    match provider {
        "voxtral_local" => {
            "import torch; import soundfile; import librosa; from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration; from mistral_common.tokens.tokenizers.audio import Audio"
        }
        "parakeet_ctc" => {
            "import torch; from transformers import pipeline"
        }
        _ => "import json",
    }
}

fn provider_requirements(provider: &str) -> &'static [&'static str] {
    match provider {
        "voxtral_local" => &[
            "torch>=2.3.0",
            "transformers>=5.2.0,<6",
            "mistral-common[audio]>=1.9.0",
            "huggingface_hub>=0.29.0",
            "soundfile>=0.12.1",
            "librosa>=0.10.2",
            "numpy>=1.26.0",
        ],
        "parakeet_ctc" => &[
            "torch>=2.3.0",
            "transformers>=4.56.0,<6",
            "huggingface_hub>=0.29.0",
            "soundfile>=0.12.1",
            "librosa>=0.10.2",
            "numpy>=1.26.0",
        ],
        _ => &["numpy>=1.26.0"],
    }
}

fn command_success(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn bootstrap_python_candidates() -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(value) = std::env::var("NAUTILUS_PYTHON") {
        if !value.trim().is_empty() {
            candidates.push(value);
        }
    }
    candidates.extend(
        [
            "python3.12",
            "python3.11",
            "python3.10",
            "python3",
            "/opt/homebrew/bin/python3.12",
            "/opt/homebrew/bin/python3.11",
            "/usr/local/bin/python3.12",
            "/usr/local/bin/python3.11",
            "/usr/bin/python3",
        ]
        .iter()
        .map(|value| (*value).to_string()),
    );

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

fn remove_managed_runtime_dir(venv_dir: &Path) -> Result<()> {
    if !venv_dir.exists() {
        return Ok(());
    }

    std::fs::remove_dir_all(venv_dir).with_context(|| {
        format!(
            "Failed to remove managed ASR runtime at {}",
            venv_dir.display()
        )
    })
}

fn install_managed_runtime_for_candidate(
    provider: &str,
    venv_dir: &Path,
    bootstrap_python: &str,
    probe: &str,
) -> Result<String> {
    remove_managed_runtime_dir(venv_dir)?;

    let output = Command::new(bootstrap_python)
        .args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        .output()
        .with_context(|| {
            format!(
                "Failed to create managed ASR virtualenv with '{}'",
                bootstrap_python
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "unknown virtualenv creation error"
        };
        return Err(anyhow!(
            "Failed to create managed ASR runtime with '{}': {}",
            bootstrap_python,
            detail
        ));
    }

    let python_path = managed_python_executable(venv_dir);
    let python_string = python_path.to_string_lossy().to_string();

    let pip_bootstrap = Command::new(&python_string)
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .args([
            "-m",
            "pip",
            "install",
            "--upgrade",
            "pip",
            "setuptools",
            "wheel",
        ])
        .output()
        .context("Failed to install base Python packaging tools")?;
    if !pip_bootstrap.status.success() {
        let stderr = String::from_utf8_lossy(&pip_bootstrap.stderr);
        let stdout = String::from_utf8_lossy(&pip_bootstrap.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "unknown pip bootstrap error"
        };
        return Err(anyhow!(
            "Failed to bootstrap managed runtime tooling with '{}': {}",
            bootstrap_python,
            detail
        ));
    }

    let requirements = provider_requirements(provider);
    let mut install_args = vec!["-m", "pip", "install", "--upgrade"];
    install_args.extend(requirements.iter().copied());
    let install_output = Command::new(&python_string)
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .args(&install_args)
        .output()
        .with_context(|| {
            format!(
                "Failed to install managed runtime dependencies for {} with '{}'",
                provider, bootstrap_python
            )
        })?;
    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        let stdout = String::from_utf8_lossy(&install_output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "unknown dependency install error"
        };
        return Err(anyhow!(
            "Managed runtime dependency install failed for {} with '{}': {}",
            provider,
            bootstrap_python,
            detail
        ));
    }

    if !command_success(&python_string, &["-c", probe]) {
        return Err(anyhow!(
            "Managed runtime installed with '{}' but required '{}' imports are still unavailable",
            bootstrap_python,
            provider
        ));
    }

    Ok(python_string)
}

fn ensure_managed_runtime(provider: &str) -> Result<String> {
    let venv_dir = managed_venv_dir();
    std::fs::create_dir_all(venv_dir.parent().unwrap_or_else(|| Path::new(".")))
        .context("Failed to create managed runtime root")?;
    let python_path = managed_python_executable(&venv_dir);
    let python_string = python_path.to_string_lossy().to_string();
    let probe = provider_import_probe(provider);

    if python_path.exists() && command_success(&python_string, &["-c", probe]) {
        return Ok(python_string);
    }

    let candidates = bootstrap_python_candidates();
    if candidates.is_empty() {
        return Err(anyhow!(
            "Could not find a Python interpreter candidate for managed ASR runtime bootstrap"
        ));
    }

    let mut failures = Vec::new();
    for candidate in candidates {
        if !command_success(&candidate, &["-c", "import venv"]) {
            failures.push(format!("{}: missing venv support", candidate));
            continue;
        }

        match install_managed_runtime_for_candidate(provider, &venv_dir, &candidate, probe) {
            Ok(python) => return Ok(python),
            Err(error) => {
                failures.push(format!("{}: {}", candidate, error));
                let _ = remove_managed_runtime_dir(&venv_dir);
            }
        }
    }

    Err(anyhow!(
        "Failed to bootstrap managed runtime for '{}'. Tried: {}",
        provider,
        failures.join(" | ")
    ))
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

    if let Some(managed) = managed_python_path() {
        candidates.push(managed);
    }

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
    let probe = provider_import_probe(provider);
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

fn parse_python_asr_stdout(stdout: &str) -> Result<PythonAsrActionOutput> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Python ASR runner returned empty output"));
    }

    if let Ok(parsed) = serde_json::from_str::<PythonAsrActionOutput>(trimmed) {
        return Ok(parsed);
    }

    for line in trimmed.lines().rev() {
        let candidate = line.trim();
        if !(candidate.starts_with('{') && candidate.ends_with('}')) {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<PythonAsrActionOutput>(candidate) {
            return Ok(parsed);
        }
    }

    let compact = if trimmed.chars().count() > 800 {
        let mut snippet = trimmed.chars().take(800).collect::<String>();
        snippet.push_str("...");
        snippet
    } else {
        trimmed.to_string()
    };
    Err(anyhow!("Failed to parse Python ASR output: {}", compact))
}

pub async fn run_python_asr_action(
    provider: &str,
    action: &str,
    model_id: Option<&str>,
    model_dir: &Path,
    audio_path: Option<&Path>,
    timeout_seconds: u64,
) -> Result<PythonAsrActionOutput> {
    let python = if let Some(existing) = find_python_for_provider(provider) {
        existing
    } else {
        let provider_owned = provider.to_string();
        tokio::task::spawn_blocking(move || ensure_managed_runtime(&provider_owned))
            .await
            .context("Managed runtime bootstrap task failed")??
    };

    let parsed = if supports_persistent_worker(provider) {
        let request = WorkerRequest {
            action: action.to_string(),
            model_dir: model_dir.to_string_lossy().to_string(),
            audio_path: audio_path.map(|path| path.to_string_lossy().to_string()),
            model_id: model_id.map(str::to_string),
        };

        let mut last_error: Option<anyhow::Error> = None;
        let mut parsed: Option<PythonAsrActionOutput> = None;

        for _ in 0..2 {
            let worker = match get_or_spawn_worker(provider, &python).await {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(error);
                    remove_worker(provider).await;
                    continue;
                }
            };

            let response = {
                let mut guard = worker.lock().await;
                guard.send_request(&request, timeout_seconds).await
            };

            match response {
                Ok(value) => {
                    parsed = Some(value);
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    remove_worker(provider).await;
                }
            }
        }

        if let Some(value) = parsed {
            value
        } else {
            return Err(last_error.unwrap_or_else(|| {
                anyhow!(
                    "Python {} action for '{}' failed with unknown worker error",
                    action,
                    provider
                )
            }));
        }
    } else {
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

        let stdout = String::from_utf8(output.stdout)
            .context("Python ASR runner returned non-UTF8 output")?;
        parse_python_asr_stdout(stdout.as_str())?
    };

    if !parsed.ok {
        let msg = parsed
            .error
            .clone()
            .unwrap_or_else(|| "Unknown Python ASR runtime error".to_string());
        return Err(anyhow!(msg));
    }

    Ok(parsed)
}
