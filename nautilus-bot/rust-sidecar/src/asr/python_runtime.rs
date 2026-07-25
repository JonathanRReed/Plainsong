use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

fn python_probe_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn managed_runtime_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
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
            .stderr(std::process::Stdio::null())
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
            return Err(anyhow!(
                "Python ASR worker '{}' exited unexpectedly",
                self.provider
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
    matches!(provider, "voxtral_local" | "mlx_audio_stt")
}

async fn get_or_spawn_worker(
    provider: &str,
    python: &str,
) -> Result<Arc<tokio::sync::Mutex<PythonAsrWorker>>> {
    let mut cache = python_worker_cache().lock().await;
    if let Some(existing) = cache.get(provider) {
        return Ok(existing.clone());
    }

    let worker = Arc::new(tokio::sync::Mutex::new(PythonAsrWorker::spawn(
        provider, python,
    )?));
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
        "mlx_audio_stt" => "import mlx_audio.stt; import mlx.core",
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
        "mlx_audio_stt" => &["mlx-audio[stt]>=0.4.1"],
        _ => &["numpy>=1.26.0"],
    }
}

/// Upper bound on a single interpreter probe.
///
/// Probes are `python -c "import ..."` calls that can legitimately take a few
/// seconds on a cold filesystem, but a probe that never returns (stalled network
/// volume, wedged interpreter) must not hang provider enumeration, which runs on
/// the first-run wizard and dashboard paths.
const PYTHON_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Bytes inspected when deciding whether a binary is the xcode-select shim.
/// The shim is ~120 KB; the dylib load commands sit near the head of the file.
#[cfg(any(target_os = "macos", test))]
const XCSELECT_SCAN_LIMIT: u64 = 1 << 20;

fn command_success(program: &str, args: &[&str]) -> bool {
    command_success_with_timeout(program, args, PYTHON_PROBE_TIMEOUT)
}

/// Run a short probe command and report whether it exited successfully, killing
/// it if it outlives `timeout`.
///
/// Uses null stdio because callers only inspect the exit status; that also keeps
/// a killed child from leaving a full pipe behind.
fn command_success_with_timeout(program: &str, args: &[&str], timeout: Duration) -> bool {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!(
                        "Python probe '{}' exceeded {}s and was terminated",
                        program,
                        timeout.as_secs()
                    );
                    return false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return false,
        }
    }
}

/// Active Xcode / command line tools developer directory, resolved without
/// spawning anything.
///
/// `xcode-select --print-path` would be the obvious source, but shelling out is
/// exactly what we are trying to avoid here; `xcode-select` persists its answer
/// as this symlink.
#[cfg(target_os = "macos")]
fn xcode_developer_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("DEVELOPER_DIR") {
        let path = PathBuf::from(value);
        if path.is_dir() {
            return Some(path);
        }
    }

    if let Ok(target) = std::fs::read_link("/var/db/xcode_select_link") {
        if target.is_dir() {
            return Some(target);
        }
    }

    let default = PathBuf::from("/Library/Developer/CommandLineTools");
    if default.is_dir() {
        return Some(default);
    }

    None
}

/// True when `path` is the xcode-select shim rather than a real interpreter.
///
/// macOS has bundled no Python 3 since 12.3. `/usr/bin/python3` on a stock Mac
/// is one hard-linked multiplexer shared with `/usr/bin/git`, `/usr/bin/clang`
/// and friends: it contains no Python, links only `libxcselect.dylib`, and when
/// no developer directory is installed it shows the "command line developer
/// tools" install dialog — a ~1 GB toolchain offer — instead of running.
/// Detect it by its `libxcselect` linkage, which no real interpreter carries.
#[cfg(target_os = "macos")]
fn binary_links_xcselect(path: &Path) -> bool {
    use std::io::Read;

    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };

    let mut head = Vec::new();
    if file
        .take(XCSELECT_SCAN_LIMIT)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }

    contains_subslice(&head, b"libxcselect")
}

#[cfg(any(target_os = "macos", test))]
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Structural backstop for shim detection on macOS.
///
/// `/usr/bin` is read-only under SIP and macOS has bundled no Python 3 since
/// 12.3, so any python candidate resolving there is the xcode-select shim even
/// if a future build of it stops carrying the `libxcselect` marker.
#[cfg(any(target_os = "macos", test))]
fn is_system_bin_path(path: &Path) -> bool {
    path.parent() == Some(Path::new("/usr/bin"))
}

fn path_is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Filesystem view used to decide which interpreter candidates may be executed.
///
/// Behind a trait so the candidate rules can be unit tested without depending on
/// which Python interpreters happen to exist on the machine running the tests.
trait CandidateEnv {
    fn path_dirs(&self) -> &[PathBuf];
    fn is_executable_file(&self, path: &Path) -> bool;
    fn is_xcode_select_shim(&self, path: &Path) -> bool;
    /// Real interpreter behind the shim, when the developer tools are installed.
    fn xcode_developer_python(&self) -> Option<PathBuf>;
    fn dedupe_key(&self, path: &Path) -> PathBuf;
}

struct HostCandidateEnv {
    path_dirs: Vec<PathBuf>,
    xcode_developer_python: Option<PathBuf>,
}

impl HostCandidateEnv {
    fn new() -> Self {
        let path_dirs = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();

        Self {
            path_dirs,
            xcode_developer_python: Self::resolve_xcode_developer_python(),
        }
    }

    #[cfg(target_os = "macos")]
    fn resolve_xcode_developer_python() -> Option<PathBuf> {
        let python = xcode_developer_dir()?
            .join("usr")
            .join("bin")
            .join("python3");
        // Only accept a real interpreter: some developer directories expose
        // another shim at this path.
        if path_is_executable_file(&python) && !binary_links_xcselect(&python) {
            Some(python)
        } else {
            None
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn resolve_xcode_developer_python() -> Option<PathBuf> {
        None
    }
}

impl CandidateEnv for HostCandidateEnv {
    fn path_dirs(&self) -> &[PathBuf] {
        &self.path_dirs
    }

    fn is_executable_file(&self, path: &Path) -> bool {
        path_is_executable_file(path)
    }

    fn is_xcode_select_shim(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        {
            binary_links_xcselect(path) || is_system_bin_path(path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            false
        }
    }

    fn xcode_developer_python(&self) -> Option<PathBuf> {
        self.xcode_developer_python.clone()
    }

    fn dedupe_key(&self, path: &Path) -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }
}

fn candidate_file_names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
        names.push(format!("{}.exe", name));
    }
    names
}

/// Resolve one candidate to an executable that is safe to run, or `None`.
///
/// Returning `None` means "do not spawn this": either nothing is there, or it is
/// the xcode-select shim with no real interpreter behind it.
fn resolve_candidate<E: CandidateEnv>(candidate: &str, env: &E) -> Option<PathBuf> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_directory = Path::new(trimmed)
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty());

    let resolved = if has_directory {
        let path = PathBuf::from(trimmed);
        env.is_executable_file(&path).then_some(path)
    } else {
        env.path_dirs()
            .iter()
            .flat_map(|dir| {
                candidate_file_names(trimmed)
                    .into_iter()
                    .map(move |name| dir.join(name))
            })
            .find(|path| env.is_executable_file(path))
    }?;

    if env.is_xcode_select_shim(&resolved) {
        // Never execute the shim: with no developer tools installed it shows the
        // macOS toolchain install dialog instead of running Python. Substitute
        // the real interpreter behind it when the tools are present, so machines
        // that only have CLT Python keep working.
        return env.xcode_developer_python();
    }

    Some(resolved)
}

/// Filter a raw candidate list down to interpreters that exist and are safe to
/// execute, deduplicated by the file they actually resolve to.
fn usable_python_candidates<E: CandidateEnv>(candidates: &[String], env: &E) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut usable = Vec::new();

    for candidate in candidates {
        let Some(resolved) = resolve_candidate(candidate, env) else {
            continue;
        };
        if !seen.insert(env.dedupe_key(&resolved)) {
            continue;
        }
        usable.push(resolved.to_string_lossy().to_string());
    }

    usable
}

fn raw_python_candidates(preferred: &[&str]) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(value) = std::env::var("PLAINSONG_PYTHON") {
        if !value.trim().is_empty() {
            candidates.push(value);
        }
    }
    candidates.extend(preferred.iter().map(|value| (*value).to_string()));
    candidates
}

fn bootstrap_python_candidates() -> Vec<String> {
    let candidates = raw_python_candidates(&[
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/bin/python3.11",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/bin/python3",
    ]);

    usable_python_candidates(&candidates, &HostCandidateEnv::new())
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
/// 1. `PLAINSONG_PYTHON` env var (if set)
/// 2. common versioned python commands
/// 3. common absolute Homebrew / system paths
///
/// Candidates that do not exist are never spawned, and on macOS a candidate that
/// resolves to the xcode-select shim is replaced by the real developer-tools
/// interpreter or skipped entirely — see [`resolve_candidate`].
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

    candidates.extend(raw_python_candidates(&[
        "python3.11",
        "python3.12",
        "python3.10",
        "python3",
        "/opt/homebrew/bin/python3.11",
        "/opt/homebrew/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/local/bin/python3.12",
        "/usr/bin/python3",
    ]));

    let mut resolved: Option<String> = None;
    for candidate in usable_python_candidates(&candidates, &HostCandidateEnv::new()) {
        if command_success(&candidate, &["-c", import_probe]) {
            resolved = Some(candidate);
            break;
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
    if let Ok(path) = std::env::var("PLAINSONG_ASR_RUNNER") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("python").join("asr").join("runner.py"));
            if let Some(resources_dir) = exe_dir.parent() {
                candidates.push(resources_dir.join("python").join("asr").join("runner.py"));
            }
        }
    }

    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("asr")
            .join("runner.py"),
    );

    candidates.push(
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("rust-sidecar")
            .join("python")
            .join("asr")
            .join("runner.py"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("python")
                .join("asr")
                .join("runner.py")
        })
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

    tracing::warn!(
        "Python ASR output was not parseable as JSON; suppressing raw runner output from UI"
    );
    Err(anyhow!(
        "The speech runtime returned an unexpected response. Try the route again or switch models."
    ))
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
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            tracing::warn!(
                "Python {} action for '{}' failed with suppressed detail: {}",
                action,
                provider,
                if detail.is_empty() {
                    "<empty>"
                } else {
                    "<suppressed>"
                }
            );
            return Err(anyhow!(
                "The {} speech runtime failed to complete transcription. Try the route again or switch models.",
                action,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake machine, so the candidate rules are exercised deterministically
    /// instead of depending on which interpreters the test host happens to have.
    #[derive(Default)]
    struct FakeEnv {
        path_dirs: Vec<PathBuf>,
        executables: Vec<PathBuf>,
        shims: Vec<PathBuf>,
        developer_python: Option<PathBuf>,
        /// Models symlinks: candidate path -> shared identity.
        links: Vec<(PathBuf, PathBuf)>,
    }

    impl FakeEnv {
        fn with_path(mut self, dirs: &[&str]) -> Self {
            self.path_dirs = dirs.iter().map(PathBuf::from).collect();
            self
        }

        fn executable(mut self, path: &str) -> Self {
            self.executables.push(PathBuf::from(path));
            self
        }

        /// An installed xcode-select shim (present on disk, but not Python).
        fn shim(mut self, path: &str) -> Self {
            self.executables.push(PathBuf::from(path));
            self.shims.push(PathBuf::from(path));
            self
        }

        fn developer_tools_python(mut self, path: &str) -> Self {
            self.developer_python = Some(PathBuf::from(path));
            self.executables.push(PathBuf::from(path));
            self
        }

        fn link(mut self, from: &str, to: &str) -> Self {
            self.links.push((PathBuf::from(from), PathBuf::from(to)));
            self
        }
    }

    impl CandidateEnv for FakeEnv {
        fn path_dirs(&self) -> &[PathBuf] {
            &self.path_dirs
        }

        fn is_executable_file(&self, path: &Path) -> bool {
            self.executables.iter().any(|known| known == path)
        }

        fn is_xcode_select_shim(&self, path: &Path) -> bool {
            self.shims.iter().any(|known| known == path)
        }

        fn xcode_developer_python(&self) -> Option<PathBuf> {
            self.developer_python.clone()
        }

        fn dedupe_key(&self, path: &Path) -> PathBuf {
            self.links
                .iter()
                .find(|(from, _)| from == path)
                .map(|(_, to)| to.clone())
                .unwrap_or_else(|| path.to_path_buf())
        }
    }

    fn candidates(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    const MAC_CANDIDATES: [&str; 9] = [
        "python3.11",
        "python3.12",
        "python3.10",
        "python3",
        "/opt/homebrew/bin/python3.11",
        "/opt/homebrew/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/local/bin/python3.12",
        "/usr/bin/python3",
    ];

    #[test]
    fn clean_mac_never_probes_the_xcode_select_shim() {
        // Stock consumer Mac: no Homebrew, no pyenv, no developer tools. The only
        // thing matching a python3 candidate is the shim, which would pop the
        // "command line developer tools" install dialog if executed.
        let env = FakeEnv::default()
            .with_path(&["/usr/bin", "/bin"])
            .shim("/usr/bin/python3");

        let usable = usable_python_candidates(&candidates(&MAC_CANDIDATES), &env);

        assert!(
            usable.is_empty(),
            "expected no candidate to be spawned on a clean Mac, got {usable:?}"
        );
    }

    #[test]
    fn bare_python3_resolving_to_the_shim_is_not_spawned() {
        let env = FakeEnv::default()
            .with_path(&["/usr/bin"])
            .shim("/usr/bin/python3");

        assert_eq!(resolve_candidate("python3", &env), None);
        assert_eq!(resolve_candidate("/usr/bin/python3", &env), None);
    }

    #[test]
    fn shim_is_replaced_by_the_real_developer_tools_interpreter() {
        // Developer machine with command line tools installed: the shim would
        // have worked, so keep working — but exec the real binary behind it.
        let env = FakeEnv::default()
            .with_path(&["/usr/bin"])
            .shim("/usr/bin/python3")
            .developer_tools_python("/Library/Developer/CommandLineTools/usr/bin/python3");

        let usable = usable_python_candidates(&candidates(&["python3", "/usr/bin/python3"]), &env);

        assert_eq!(
            usable,
            vec!["/Library/Developer/CommandLineTools/usr/bin/python3".to_string()]
        );
    }

    #[test]
    fn homebrew_and_pyenv_pythons_still_resolve() {
        let env = FakeEnv::default()
            .with_path(&["/Users/dev/.pyenv/shims", "/opt/homebrew/bin", "/usr/bin"])
            .executable("/Users/dev/.pyenv/shims/python3")
            .executable("/opt/homebrew/bin/python3.11")
            .shim("/usr/bin/python3");

        let usable = usable_python_candidates(&candidates(&MAC_CANDIDATES), &env);

        assert!(
            usable.contains(&"/Users/dev/.pyenv/shims/python3".to_string()),
            "pyenv interpreter should survive filtering, got {usable:?}"
        );
        assert!(
            usable.contains(&"/opt/homebrew/bin/python3.11".to_string()),
            "Homebrew interpreter should survive filtering, got {usable:?}"
        );
        assert!(
            !usable.iter().any(|value| value == "/usr/bin/python3"),
            "the shim must never be probed, got {usable:?}"
        );
    }

    #[test]
    fn missing_candidates_are_never_spawned() {
        let env = FakeEnv::default().with_path(&["/usr/bin"]);

        assert!(usable_python_candidates(&candidates(&MAC_CANDIDATES), &env).is_empty());
    }

    #[test]
    fn candidates_resolving_to_the_same_interpreter_are_probed_once() {
        let env = FakeEnv::default()
            .with_path(&["/opt/homebrew/bin"])
            .executable("/opt/homebrew/bin/python3")
            .executable("/opt/homebrew/bin/python3.11")
            .link(
                "/opt/homebrew/bin/python3",
                "/opt/homebrew/Cellar/python3.11",
            )
            .link(
                "/opt/homebrew/bin/python3.11",
                "/opt/homebrew/Cellar/python3.11",
            );

        let usable = usable_python_candidates(
            &candidates(&["python3", "/opt/homebrew/bin/python3.11"]),
            &env,
        );

        assert_eq!(usable, vec!["/opt/homebrew/bin/python3".to_string()]);
    }

    #[test]
    fn empty_and_blank_candidates_are_dropped() {
        let env = FakeEnv::default().with_path(&["/usr/bin"]);

        assert_eq!(resolve_candidate("", &env), None);
        assert_eq!(resolve_candidate("   ", &env), None);
    }

    #[test]
    fn system_bin_paths_are_treated_as_shims_regardless_of_binary_contents() {
        assert!(is_system_bin_path(Path::new("/usr/bin/python3")));
        assert!(is_system_bin_path(Path::new("/usr/bin/python3.12")));
        assert!(!is_system_bin_path(Path::new("/usr/local/bin/python3.11")));
        assert!(!is_system_bin_path(Path::new("/opt/homebrew/bin/python3")));
        assert!(!is_system_bin_path(Path::new(
            "/Library/Developer/CommandLineTools/usr/bin/python3"
        )));
    }

    #[test]
    fn contains_subslice_matches_expected_needles() {
        assert!(contains_subslice(
            b"aa/usr/lib/libxcselect.dylib",
            b"libxcselect"
        ));
        assert!(!contains_subslice(
            b"/usr/lib/libSystem.B.dylib",
            b"libxcselect"
        ));
        assert!(!contains_subslice(b"lib", b"libxcselect"));
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_probe_is_killed_at_the_timeout() {
        let started = Instant::now();
        let success = command_success_with_timeout(
            "/bin/sh",
            &["-c", "sleep 30"],
            Duration::from_millis(300),
        );
        let elapsed = started.elapsed();

        assert!(
            !success,
            "a probe that never finishes must not report success"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "probe should have been killed at the timeout, took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fast_probe_still_reports_its_exit_status() {
        assert!(command_success_with_timeout(
            "/bin/sh",
            &["-c", "exit 0"],
            Duration::from_secs(5)
        ));
        assert!(!command_success_with_timeout(
            "/bin/sh",
            &["-c", "exit 1"],
            Duration::from_secs(5)
        ));
        assert!(!command_success_with_timeout(
            "/definitely/not/a/binary",
            &["-c", "exit 0"],
            Duration::from_secs(5)
        ));
    }

    /// Ties the detector to the real mechanism on macOS: `/usr/bin/python3` is a
    /// hard link to the other xcode-select shims (it shares an inode with
    /// `/usr/bin/git`), and must be recognised as one.
    #[cfg(target_os = "macos")]
    #[test]
    fn system_python3_is_detected_as_the_xcode_select_shim() {
        use std::os::unix::fs::MetadataExt;

        let python = Path::new("/usr/bin/python3");
        let git = Path::new("/usr/bin/git");
        let (Ok(python_meta), Ok(git_meta)) = (python.metadata(), git.metadata()) else {
            return;
        };

        if python_meta.ino() != git_meta.ino() || python_meta.dev() != git_meta.dev() {
            // Not the hard-linked shim family on this host; nothing to assert.
            return;
        }

        assert!(
            binary_links_xcselect(python),
            "/usr/bin/python3 is hard-linked to /usr/bin/git and must be treated as the shim"
        );
    }
}
