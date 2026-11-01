//! The sidecar's side of `plainsong-text-helper`, the llama.cpp process that
//! runs built-in meeting notes, Ask and dictation cleanup.
//!
//! # Why a separate process
//!
//! The sidecar already links two ggml builds (whisper.cpp and transcribe.cpp);
//! llama.cpp brings a third. In its own process it cannot collide with them,
//! and ending the process returns all of its memory to macOS, which an
//! in-process runtime never fully did.
//!
//! # Trust
//!
//! The sidecar opens and verifies the model file and passes the open
//! descriptor to the helper as fd 3, so the helper loads exactly the bytes
//! that passed the integrity check. In a packaged app only the signed helper
//! inside the bundle is ever started.
//!
//! # Memory
//!
//! A [`HelperProcess`] holds a claim on the sidecar's native working-memory
//! budget from before it starts until it has exited, sized from the helper's
//! measured footprint (see [`requirement_bytes`]).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::bundled_local::CancelFlag;

pub const HELPER_BINARY_NAME: &str = "plainsong-text-helper";
/// Shared with `rust-sidecar/text-helper/src/main.rs`.
pub const PROTOCOL_VERSION: u32 = 2;
/// The packaged helper's directory under `Contents/Resources`.
pub const HELPER_RESOURCE_DIR: &str = "text-helper";
/// Longest answer line accepted. A 2,048-token answer is far below this.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Startup includes the Metal shader library load: about 3 s on an M4 Pro,
/// much longer when memory is tight.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a cancelled request may take to stop before the process is ended.
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// The model descriptor's number inside the helper.
const MODEL_FD: i32 = 3;

const MIB: u64 = 1024 * 1024;

/// How much memory a helper running one model needs, fitted to the measured
/// peak resident set of the real helper on Metal (2026-10-23, M4 Pro,
/// `artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/notes/`).
///
/// Resident, not footprint: llama.cpp maps the model file, so its weights
/// are file-backed pages that Activity Monitor's footprint leaves out, yet a
/// model only runs at speed while they stay in memory. Counting them is the
/// honest requirement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryProfile {
    /// The model file, which ends up resident.
    pub model_bytes: u64,
    /// Process, Metal and compute buffers that do not grow with the context.
    pub fixed_bytes: u64,
    /// q8_0 KV cache plus the compute buffers that scale with the context.
    pub per_token_bytes: u64,
}

/// What a helper with a `context_tokens` window needs.
pub fn requirement_bytes(profile: MemoryProfile, context_tokens: usize) -> u64 {
    profile
        .model_bytes
        .saturating_add(profile.fixed_bytes)
        .saturating_add(
            profile
                .per_token_bytes
                .saturating_mul(context_tokens as u64),
        )
}

/// Fixed overhead every measured model stayed under: the measured peak minus
/// the model file and its context terms was 120-160 MiB for each one.
pub const FIXED_OVERHEAD_BYTES: u64 = 256 * MIB;

/// One model a helper can run.
#[derive(Debug, Clone)]
pub struct HelperModel {
    pub path: PathBuf,
    pub sha256: &'static str,
    /// The largest window any request may use; also sizes the claim.
    pub max_context_tokens: usize,
    pub batch_tokens: u32,
    pub profile: MemoryProfile,
}

impl HelperModel {
    pub fn claim_bytes(&self) -> u64 {
        requirement_bytes(self.profile, self.max_context_tokens)
    }
}

/// Why a helper request failed, in the terms the providers map to their
/// transport errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperFailure {
    /// No helper binary in this build or bundle.
    Unavailable(String),
    /// Not enough verified memory for the claim.
    Memory(String),
    /// The prompt plus output budget does not fit the window.
    Context(String),
    Invalid(String),
    Timeout,
    Cancelled,
    /// The helper crashed, stopped answering or broke the protocol.
    Crashed(String),
}

impl std::fmt::Display for HelperFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(message)
            | Self::Memory(message)
            | Self::Context(message)
            | Self::Invalid(message)
            | Self::Crashed(message) => out.write_str(message),
            Self::Timeout => {
                out.write_str("The built-in text model took too long and was stopped.")
            }
            Self::Cancelled => {
                out.write_str("The built-in text model was stopped before it finished.")
            }
        }
    }
}

impl std::error::Error for HelperFailure {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperMemory {
    pub footprint_bytes: u64,
    pub peak_footprint_bytes: u64,
    pub peak_resident_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Response {
    Ready {
        protocol_version: u32,
        gpu_offload: bool,
    },
    Loaded {
        #[expect(
            dead_code,
            reason = "sent by the helper; the sidecar reads only `memory`"
        )]
        train_context_tokens: u32,
        #[expect(
            dead_code,
            reason = "sent by the helper; the sidecar reads only `memory`"
        )]
        model_bytes: u64,
        #[expect(
            dead_code,
            reason = "sent by the helper; the sidecar reads only `memory`"
        )]
        elapsed_ms: u64,
        memory: HelperMemory,
    },
    Count {
        tokens: usize,
    },
    Result {
        text: String,
        finish: String,
        prompt_tokens: usize,
        generated_tokens: usize,
        #[serde(default)]
        repetition: Option<RepetitionDiagnostic>,
        context_tokens: u32,
        elapsed_ms: u64,
        memory: HelperMemory,
    },
    Error {
        kind: String,
        message: String,
    },
}

/// The repeated token n-gram's counts and keyed identity, without its words
/// or reversible token IDs. The fingerprint changes when the helper restarts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepetitionDiagnostic {
    pub window_tokens: usize,
    pub period_tokens: usize,
    pub observed_tokens: usize,
    pub kept_tokens: usize,
    pub ngram_fingerprint: String,
}

/// A finished generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generation {
    pub text: String,
    /// False when the output budget ran out before the model stopped, or the
    /// helper stopped a structured answer that began copying itself.
    pub stopped: bool,
    /// The helper stopped because the output repeated itself; `text` keeps
    /// one copy of the repeated run.
    pub repeated: bool,
    pub repetition: Option<RepetitionDiagnostic>,
    pub prompt_tokens: usize,
    pub generated_tokens: usize,
    pub context_tokens: u32,
    pub elapsed_ms: u64,
    pub memory: HelperMemory,
}

/// Candidate helper locations, packaged first. Inside a `.app` there is
/// exactly one legitimate path and nothing else is tried.
pub fn helper_candidates(executable: &Path, repo_root: Option<&Path>) -> Vec<PathBuf> {
    if let Some(app_root) = executable.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    }) {
        return vec![app_root
            .join("Contents")
            .join("Resources")
            .join(HELPER_RESOURCE_DIR)
            .join(HELPER_BINARY_NAME)];
    }
    let mut candidates = Vec::new();
    if let Some(root) = repo_root {
        candidates.push(root.join("dist-native").join(HELPER_BINARY_NAME));
        candidates.push(
            root.join("rust-sidecar")
                .join("text-helper")
                .join("target")
                .join("release")
                .join(HELPER_BINARY_NAME),
        );
    }
    if let Some(directory) = executable.parent() {
        candidates.push(directory.join(HELPER_BINARY_NAME));
    }
    candidates
}

fn resolve_helper() -> Result<PathBuf, HelperFailure> {
    let executable = std::env::current_exe().map_err(|error| {
        HelperFailure::Unavailable(format!("Could not locate the running sidecar: {error}"))
    })?;
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    let candidates = helper_candidates(&executable, repo_root);
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .ok_or_else(|| {
            HelperFailure::Unavailable(
                "The built-in text model isn't available in this version of Plainsong.".into(),
            )
        })
}

/// Whether this build can start the helper at all.
pub fn helper_present() -> bool {
    cfg!(unix) && resolve_helper().is_ok()
}

/// A running helper with one model loaded.
pub struct HelperProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<Result<String, String>>,
    pub loaded_memory: HelperMemory,
    pub gpu_offload: bool,
    pub model_key: String,
    qa_residency: Option<crate::memory_pressure::QaResidency>,
    max_context_tokens: usize,
    // Released only after the process has exited (see `Drop`).
    claim: Option<super::local_model_load::MemoryClaim<'static>>,
}

impl HelperProcess {
    /// Claim memory, verify the model, start the helper and load the model.
    pub fn start(
        model: &HelperModel,
        model_key: &str,
        cancel: &CancelFlag,
        deadline: Instant,
    ) -> Result<Self, HelperFailure> {
        let claim = super::local_model_load::text_helper_claim(model.claim_bytes())
            .map_err(|error| HelperFailure::Memory(error.to_string()))?;
        let helper = resolve_helper()?;
        Self::start_at_until(
            &helper,
            model,
            model_key,
            Some(claim),
            Some(cancel),
            deadline,
        )
    }

    #[cfg(test)]
    fn start_at(
        helper: &Path,
        model: &HelperModel,
        model_key: &str,
        claim: Option<super::local_model_load::MemoryClaim<'static>>,
    ) -> Result<Self, HelperFailure> {
        Self::start_at_until(
            helper,
            model,
            model_key,
            claim,
            None,
            Instant::now() + START_TIMEOUT,
        )
    }

    fn start_at_until(
        helper: &Path,
        model: &HelperModel,
        model_key: &str,
        claim: Option<super::local_model_load::MemoryClaim<'static>>,
        cancel: Option<&CancelFlag>,
        deadline: Instant,
    ) -> Result<Self, HelperFailure> {
        let verified = crate::download::open_verified_model_artifact(&model.path, model.sha256)
            .map_err(|error| HelperFailure::Invalid(error.to_string()))?;
        let mut command = Command::new(helper);
        command
            .arg("--model-fd")
            .arg(MODEL_FD.to_string())
            .env_remove("PLAINSONG_TEXT_HELPER_LOGS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(test)]
        if let Some(path) = std::env::var_os("PLAINSONG_PRESSURE_PROBE_STDERR") {
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|error| HelperFailure::Unavailable(error.to_string()))?;
            command.env("PLAINSONG_TEXT_HELPER_LOGS", "1").stderr(log);
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;
            let source = verified.as_file().as_raw_fd();
            // Runs in the forked child before exec; dup2 and fcntl are
            // async-signal-safe. dup2 onto itself keeps close-on-exec, so
            // when the verified file already is fd 3 the flag is cleared.
            unsafe {
                command.pre_exec(move || {
                    let result = if source == MODEL_FD {
                        libc::fcntl(MODEL_FD, libc::F_SETFD, 0)
                    } else {
                        libc::dup2(source, MODEL_FD)
                    };
                    if result == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().map_err(|error| {
            HelperFailure::Unavailable(format!("Could not start the built-in text model: {error}"))
        })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stdin = child.stdin.take();
        #[cfg(unix)]
        if let Some(stdin) = &stdin {
            use std::os::fd::AsRawFd;
            let fd = stdin.as_raw_fd();
            // The parent must still observe deadlines when a child stops reading.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags == -1
                || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HelperFailure::Crashed(
                    "Could not bound writes to the text helper.".into(),
                ));
            }
        }
        let (sender, lines) = mpsc::sync_channel(1);
        std::thread::spawn(move || read_lines(stdout, sender));
        let mut process = Self {
            child,
            stdin,
            lines,
            loaded_memory: HelperMemory::default(),
            gpu_offload: false,
            model_key: model_key.into(),
            qa_residency: None,
            max_context_tokens: model.max_context_tokens,
            claim,
        };
        match process.receive(deadline.min(Instant::now() + START_TIMEOUT), cancel)? {
            Response::Ready {
                protocol_version,
                gpu_offload,
                ..
            } if protocol_version == PROTOCOL_VERSION => process.gpu_offload = gpu_offload,
            Response::Ready { .. } => {
                return Err(HelperFailure::Crashed(
                    "The built-in text model helper speaks a different protocol version.".into(),
                ))
            }
            other => return Err(unexpected(other)),
        }
        process.send(
            &serde_json::json!({
                "op": "load",
                "maxContextTokens": model.max_context_tokens,
                "batchTokens": model.batch_tokens,
                "kvType": "q8_0",
            }),
            deadline.min(Instant::now() + START_TIMEOUT),
            cancel,
        )?;
        match process.receive(deadline.min(Instant::now() + START_TIMEOUT), cancel)? {
            Response::Loaded { memory, .. } => process.loaded_memory = memory,
            Response::Error { kind, message } => {
                // The next start hashes the file again rather than trusting
                // bytes the helper could not load.
                verified.forget();
                return Err(failure(&kind, message));
            }
            other => return Err(unexpected(other)),
        }
        drop(verified);
        let lane = if model_key == super::bundled_local::MODEL_ID {
            "cleanup"
        } else {
            "notes"
        };
        process.qa_residency =
            crate::memory_pressure::QaResidency::loaded(lane, process.child.id());
        Ok(process)
    }

    fn send(
        &mut self,
        request: &serde_json::Value,
        deadline: Instant,
        cancel: Option<&CancelFlag>,
    ) -> Result<(), HelperFailure> {
        let mut line = serde_json::to_vec(request)
            .map_err(|error| HelperFailure::Invalid(error.to_string()))?;
        line.push(b'\n');
        if line.len() > MAX_RESPONSE_BYTES {
            return Err(HelperFailure::Invalid(
                "The text helper request is too large.".into(),
            ));
        }
        let mut offset = 0;
        while offset < line.len() {
            if cancel.is_some_and(CancelFlag::is_cancelled) {
                self.kill();
                return Err(HelperFailure::Cancelled);
            }
            if Instant::now() >= deadline {
                self.kill();
                return Err(HelperFailure::Timeout);
            }
            let stdin = self
                .stdin
                .as_mut()
                .ok_or_else(|| HelperFailure::Crashed("The helper's input is closed.".into()))?;
            match stdin.write(&line[offset..]) {
                Ok(0) => return Err(HelperFailure::Crashed("The helper stopped reading.".into())),
                Ok(written) => offset += written,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => {
                    return Err(HelperFailure::Crashed(format!(
                        "The helper stopped reading: {error}"
                    )))
                }
            }
        }
        Ok(())
    }

    /// Wait for the next answer, sending a cancel at most once if `cancel`
    /// fires, and ending the process if it misses the deadline.
    fn receive(
        &mut self,
        deadline: Instant,
        cancel: Option<&CancelFlag>,
    ) -> Result<Response, HelperFailure> {
        let mut cancel_sent_at: Option<Instant> = None;
        loop {
            let now = Instant::now();
            if cancel.is_some_and(CancelFlag::must_stop_now) {
                self.kill();
                return Err(HelperFailure::Cancelled);
            }
            if now >= deadline {
                self.kill();
                return Err(
                    if cancel_sent_at.is_some() || cancel.is_some_and(CancelFlag::is_cancelled) {
                        HelperFailure::Cancelled
                    } else {
                        HelperFailure::Timeout
                    },
                );
            }
            if let Some(sent) = cancel_sent_at {
                if now.duration_since(sent) > CANCEL_GRACE {
                    self.kill();
                    return Err(HelperFailure::Cancelled);
                }
            } else if cancel.is_some_and(CancelFlag::is_cancelled) {
                cancel_sent_at = Some(now);
                if self
                    .send(
                        &serde_json::json!({ "op": "cancel" }),
                        deadline.min(now + CANCEL_GRACE),
                        None,
                    )
                    .is_err()
                {
                    self.kill();
                    return Err(HelperFailure::Cancelled);
                }
            }
            let wait = deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(50));
            match self.lines.recv_timeout(wait) {
                Ok(Ok(line)) => {
                    return serde_json::from_str(&line).map_err(|error| {
                        self.kill();
                        HelperFailure::Crashed(format!(
                            "The built-in text model helper sent an unreadable answer: {error}"
                        ))
                    })
                }
                Ok(Err(message)) => {
                    self.kill();
                    return Err(HelperFailure::Crashed(message));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.kill();
                    return Err(HelperFailure::Crashed(
                        "The built-in text model stopped unexpectedly.".into(),
                    ));
                }
            }
        }
    }

    /// Tokens `text` takes in this model.
    pub fn count_tokens(&mut self, text: &str, deadline: Instant) -> Result<usize, HelperFailure> {
        self.send(
            &serde_json::json!({ "op": "count", "text": text }),
            deadline,
            None,
        )?;
        match self.receive(deadline, None)? {
            Response::Count { tokens } => Ok(tokens),
            Response::Error { kind, message } => Err(failure(&kind, message)),
            other => Err(unexpected(other)),
        }
    }

    /// Greedy generation of at most `max_tokens`, optionally constrained to
    /// `json_schema`. The context is sized to this request and freed after it.
    pub fn generate(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        json_schema: Option<&serde_json::Value>,
        cancel: &CancelFlag,
        deadline: Instant,
    ) -> Result<Generation, HelperFailure> {
        if cancel.is_cancelled() {
            return Err(HelperFailure::Cancelled);
        }
        self.send(
            &serde_json::json!({
                "op": "generate",
                "prompt": prompt,
                "maxTokens": max_tokens,
                "jsonSchema": json_schema,
            }),
            deadline,
            Some(cancel),
        )?;
        let response = self.receive(deadline, Some(cancel))?;
        if cancel.is_cancelled() {
            return Err(HelperFailure::Cancelled);
        }
        match response {
            Response::Result { finish, .. } if finish == "cancelled" => {
                Err(HelperFailure::Cancelled)
            }
            Response::Result {
                text,
                finish,
                prompt_tokens,
                generated_tokens,
                repetition,
                context_tokens,
                elapsed_ms,
                memory,
            } if (matches!(finish.as_str(), "stop" | "length")
                || (finish == "repetition" && json_schema.is_some()))
                && generated_tokens <= max_tokens
                && context_tokens as usize <= self.max_context_tokens
                && prompt_tokens > 0
                && prompt_tokens.saturating_add(generated_tokens) <= context_tokens as usize =>
            {
                Ok(Generation {
                    text,
                    stopped: finish == "stop",
                    repeated: finish == "repetition",
                    repetition,
                    prompt_tokens,
                    generated_tokens,
                    context_tokens,
                    elapsed_ms,
                    memory,
                })
            }
            Response::Error { kind, message } => Err(failure(&kind, message)),
            other => Err(unexpected(other)),
        }
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// The memory this helper holds against the sidecar's budget.
    pub fn claim_bytes(&self) -> u64 {
        self.claim
            .as_ref()
            .map_or(0, super::local_model_load::MemoryClaim::bytes)
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        // Closing stdin asks the helper to exit; it frees everything it holds.
        drop(self.stdin.take());
        let deadline = Instant::now() + EXIT_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = self.child.kill();
                    if self.child.wait().is_err() {
                        // Exit is unconfirmed, so the memory may still be in
                        // use: keep it claimed for the sidecar's lifetime.
                        std::mem::forget(self.claim.take());
                        std::mem::forget(self.qa_residency.take());
                        tracing::error!("Could not confirm the text helper stopped");
                    }
                    break;
                }
            }
        }
        drop(self.claim.take());
    }
}

fn read_lines(stdout: std::process::ChildStdout, sender: mpsc::SyncSender<Result<String, String>>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = Read::by_ref(&mut reader)
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line);
        match read {
            Ok(0) | Err(_) => return,
            Ok(_) if line.len() > MAX_RESPONSE_BYTES => {
                let _ = sender.send(Err(format!(
                    "The built-in text model helper wrote more than {MAX_RESPONSE_BYTES} bytes in one answer."
                )));
                return;
            }
            Ok(_) => {
                if sender
                    .send(
                        String::from_utf8(line.clone())
                            .map_err(|_| "The helper sent invalid UTF-8.".into()),
                    )
                    .is_err()
                {
                    return;
                }
            }
        }
    }
}

fn failure(kind: &str, message: String) -> HelperFailure {
    match kind {
        "context" => HelperFailure::Context(message),
        "memory" => HelperFailure::Memory(message),
        "invalid" | "load" => HelperFailure::Invalid(message),
        _ => HelperFailure::Crashed(message),
    }
}

fn unexpected(response: Response) -> HelperFailure {
    match response {
        Response::Error { kind, message } => failure(&kind, message),
        _ => HelperFailure::Crashed("The built-in text model helper answered out of turn.".into()),
    }
}

/// One warm helper, shared by the requests of one lane. A different model,
/// an exited process or an idle timeout replaces or ends it.
pub struct WarmSlot {
    state: std::sync::Mutex<Option<(HelperProcess, Instant)>>,
}

impl WarmSlot {
    pub const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(None),
        }
    }

    /// Run `work` on the warm helper for `model_key`, starting it if needed.
    /// A crash, timeout or cancellation ends the process so the next request
    /// starts clean.
    pub fn with<R>(
        &self,
        model_key: &str,
        start: impl FnOnce() -> Result<HelperProcess, HelperFailure>,
        work: impl FnOnce(&mut HelperProcess) -> Result<R, HelperFailure>,
    ) -> Result<R, HelperFailure> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let reusable = state
            .as_mut()
            .is_some_and(|(process, _)| process.model_key == model_key && process.is_running());
        if !reusable {
            // Exit the old process, and release its claim, before starting.
            *state = None;
            *state = Some((start()?, Instant::now()));
        }
        let (process, last_used) = state.as_mut().expect("a helper was started above");
        let outcome = work(process);
        *last_used = Instant::now();
        if matches!(
            outcome,
            Err(HelperFailure::Crashed(_) | HelperFailure::Timeout | HelperFailure::Cancelled)
        ) {
            *state = None;
        }
        outcome
    }

    pub fn clear(&self) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    #[cfg(test)]
    pub fn is_loaded(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// End the helper if no request has used it for `idle`. A request in
    /// progress holds the lock, so it is never ended mid-request.
    pub fn end_if_idle_for(&self, idle: Duration) -> bool {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return false,
        };
        let stale = state
            .as_ref()
            .is_some_and(|(_, last_used)| last_used.elapsed() >= idle);
        if stale {
            *state = None;
        }
        stale
    }

    fn release_idle(&self, policy: crate::model_residency::Policy, idle: Duration) {
        let idle = if policy.release_idle() {
            Duration::ZERO
        } else {
            idle
        };
        if self.end_if_idle_for(idle) {
            tracing::info!("Released the unused text helper");
        }
    }

    /// End the helper now unless `keep` accepts its memory claim. Never waits
    /// on a request in progress.
    pub fn end_if_idle_unless(&self, keep: impl FnOnce(u64) -> bool) -> bool {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return false,
        };
        let end = state
            .as_ref()
            .is_some_and(|(process, _)| !keep(process.claim_bytes()));
        if end {
            *state = None;
        }
        end
    }
}

impl Default for WarmSlot {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "pressure_release_probe.rs"]
mod pressure_release_probe;

/// Register a static helper once. Its request lock spans teardown, so a
/// concurrent request either keeps the helper or starts a new admitted one.
pub fn ensure_idle_reaper(slot: &'static WarmSlot, idle: fn() -> Duration, bytes: u64) {
    use std::sync::{Mutex, OnceLock};
    type Entry = (
        &'static WarmSlot,
        std::sync::Arc<crate::model_residency::IdleModel>,
    );
    static SLOTS: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
    let mut slots = SLOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((_, registration)) = slots
        .iter()
        .find(|(existing, _)| std::ptr::eq(*existing, slot))
    {
        registration.set_bytes(bytes);
    } else {
        let registration = crate::model_residency::register(bytes, move |policy| {
            slot.release_idle(policy, idle());
        });
        slots.push((slot, registration));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_idle_reaper_ends_an_unused_helper() {
        let (helper, model) =
            stub("while read request; do echo '{\"type\":\"count\",\"tokens\":4}'; done");
        let slot = Box::leak(Box::new(WarmSlot::new()));
        slot.with(
            "stub",
            || HelperProcess::start_at(&helper, &model, "stub", None),
            |process| process.count_tokens("text", Instant::now() + Duration::from_secs(5)),
        )
        .unwrap();
        ensure_idle_reaper(slot, || Duration::from_millis(1), 1);
        let deadline = Instant::now() + Duration::from_secs(10);
        while slot.is_loaded() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!slot.is_loaded());
    }

    #[test]
    fn packaged_apps_only_use_the_bundled_helper() {
        let candidates = helper_candidates(
            Path::new("/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar"),
            Some(Path::new("/repo/nautilus-bot")),
        );
        assert_eq!(
            candidates,
            [PathBuf::from(
                "/Applications/Plainsong.app/Contents/Resources/text-helper/plainsong-text-helper"
            )]
        );
        let dev = helper_candidates(
            Path::new("/repo/nautilus-bot/rust-sidecar/target/debug/plainsong-sidecar"),
            Some(Path::new("/repo/nautilus-bot")),
        );
        assert_eq!(
            dev[0],
            PathBuf::from("/repo/nautilus-bot/dist-native/plainsong-text-helper")
        );
    }

    #[test]
    fn requirement_grows_with_the_window() {
        let profile = MemoryProfile {
            model_bytes: 1_000,
            fixed_bytes: 100,
            per_token_bytes: 2,
        };
        assert_eq!(requirement_bytes(profile, 0), 1_100);
        assert_eq!(requirement_bytes(profile, 4_096), 1_100 + 8_192);
    }

    #[test]
    fn protocol_errors_do_not_disclose_generated_text() {
        let response: Response = serde_json::from_value(serde_json::json!({"type":"result", "text":"private fixture words", "finish":"stop", "promptTokens":1, "generatedTokens":1, "contextTokens":256, "elapsedMs":1, "memory":{"footprintBytes":1,"peakFootprintBytes":1,"peakResidentBytes":1}})).unwrap();
        assert!(!unexpected(response)
            .to_string()
            .contains("private fixture words"));
    }

    #[test]
    fn helper_error_kinds_map_to_failures() {
        assert!(matches!(
            failure("context", "x".into()),
            HelperFailure::Context(_)
        ));
        assert!(matches!(
            failure("memory", "x".into()),
            HelperFailure::Memory(_)
        ));
        assert!(matches!(
            failure("load", "x".into()),
            HelperFailure::Invalid(_)
        ));
        assert!(matches!(
            failure("runtime", "x".into()),
            HelperFailure::Crashed(_)
        ));
    }

    /// A stand-in helper written in sh: answers the startup handshake, then
    /// whatever `script` does. Exercises the real process plumbing.
    #[cfg(unix)]
    fn stub(script: &str) -> (PathBuf, HelperModel) {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "plainsong-text-helper-stub-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let helper = directory.join("helper");
        std::fs::write(
            &helper,
            format!(
                "#!/bin/sh\n[ -r /dev/fd/3 ] || exit 9\n\
                 echo '{{\"type\":\"ready\",\"protocolVersion\":2,\"gpuOffload\":true,\"memory\":{{\"footprintBytes\":1,\"peakFootprintBytes\":1,\"peakResidentBytes\":1}}}}'\n\
                 read load\n\
                 echo '{{\"type\":\"loaded\",\"trainContextTokens\":4096,\"modelBytes\":5,\"elapsedMs\":1,\"memory\":{{\"footprintBytes\":2,\"peakFootprintBytes\":2,\"peakResidentBytes\":7}}}}'\n\
                 {script}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let model = directory.join("model.gguf");
        std::fs::write(&model, b"model").unwrap();
        let digest = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(b"model"))
        };
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(crate::download::mark_model_verified_for_tests(
                &model, &digest,
            ))
            .unwrap();
        (
            helper,
            HelperModel {
                path: model,
                sha256: Box::leak(digest.into_boxed_str()),
                max_context_tokens: 4_096,
                batch_tokens: 256,
                profile: MemoryProfile {
                    model_bytes: 5,
                    fixed_bytes: 1,
                    per_token_bytes: 1,
                },
            },
        )
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_loads_the_verified_descriptor_and_generates() {
        let (helper, model) = stub(
            "read request\n\
             echo '{\"type\":\"result\",\"text\":\"Notes.\",\"finish\":\"stop\",\"promptTokens\":3,\"generatedTokens\":2,\"contextTokens\":256,\"elapsedMs\":4,\"memory\":{\"footprintBytes\":3,\"peakFootprintBytes\":9,\"peakResidentBytes\":11}}'\n\
             read eof",
        );
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        assert_eq!(process.loaded_memory.peak_resident_bytes, 7);
        let generation = process
            .generate(
                "prompt",
                16,
                None,
                &CancelFlag::new(),
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(generation.text, "Notes.");
        assert!(generation.stopped);
        assert_eq!(generation.memory.peak_resident_bytes, 11);
    }

    #[cfg(unix)]
    #[test]
    fn repetition_metadata_survives_the_helper_protocol_without_generated_text() {
        let result = serde_json::json!({
            "type": "result", "text": "", "finish": "repetition",
            "promptTokens": 3, "generatedTokens": 128, "contextTokens": 256,
            "elapsedMs": 4, "memory": {"footprintBytes": 3, "peakFootprintBytes": 9, "peakResidentBytes": 11},
            "repetition": {"windowTokens": 64, "periodTokens": 64, "observedTokens": 128,
                "keptTokens": 64, "ngramFingerprint": "0123456789abcdef"}
        });
        let (helper, model) = stub(&format!("read request\necho '{result}'\nread eof"));
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        let generation = process
            .generate(
                "prompt",
                128,
                Some(&serde_json::json!({"type": "object"})),
                &CancelFlag::new(),
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap();
        let diagnostic = generation.repetition.unwrap();
        assert_eq!(diagnostic.observed_tokens, 128);
        assert_eq!(diagnostic.kept_tokens, 64);
        assert_eq!(diagnostic.ngram_fingerprint, "0123456789abcdef");
    }

    #[cfg(unix)]
    #[test]
    fn a_repeating_structured_answer_comes_back_unfinished_with_its_text() {
        let result = "echo '{\"type\":\"result\",\"text\":\"{\\\"evidence\\\":[\",\"finish\":\"repetition\",\"promptTokens\":3,\"generatedTokens\":2,\"contextTokens\":256,\"elapsedMs\":4,\"memory\":{\"footprintBytes\":3,\"peakFootprintBytes\":9,\"peakResidentBytes\":11}}'";
        let (helper, model) = stub(&format!(
            "read request\n{result}\nread request\n{result}\nread eof"
        ));
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let generation = process
            .generate(
                "prompt",
                16,
                Some(&serde_json::json!({"type": "object"})),
                &CancelFlag::new(),
                deadline,
            )
            .unwrap();
        assert_eq!(generation.text, "{\"evidence\":[");
        assert!(!generation.stopped);
        assert!(generation.repeated);
        // Plain text is never cut for repetition, so the finish is a protocol break.
        assert!(process
            .generate("prompt", 16, None, &CancelFlag::new(), deadline)
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_that_stops_answering_is_ended_at_the_deadline() {
        let (helper, model) = stub("read request\nexec sleep 30");
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        let started = Instant::now();
        let error = process
            .generate(
                "prompt",
                16,
                None,
                &CancelFlag::new(),
                Instant::now() + Duration::from_millis(200),
            )
            .unwrap_err();
        assert_eq!(error, HelperFailure::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            !process.is_running() || {
                std::thread::sleep(Duration::from_millis(200));
                !process.is_running()
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_sends_a_cancel_and_reports_cancellation() {
        let (helper, model) = stub(
            "read request\nread cancel\n\
             echo '{\"type\":\"result\",\"text\":\"\",\"finish\":\"cancelled\",\"promptTokens\":3,\"generatedTokens\":0,\"contextTokens\":256,\"elapsedMs\":4,\"memory\":{\"footprintBytes\":3,\"peakFootprintBytes\":9,\"peakResidentBytes\":11}}'\n\
             read eof",
        );
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        let cancel = CancelFlag::new();
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.cancel();
        });
        let error = process
            .generate(
                "prompt",
                16,
                None,
                &cancel,
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap_err();
        assert_eq!(error, HelperFailure::Cancelled);
    }

    #[cfg(unix)]
    #[test]
    fn dictation_on_light_ends_a_notes_request_at_once_even_if_the_helper_ignores_cancel() {
        // A helper mid-generation that never answers a cancel.
        let (helper, model) = stub("read request\nexec sleep 30");
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        let precedence = super::super::speech_priority::Precedence::new(|| {
            crate::hardware_tier::HardwareTier::Light
        });
        let cancel = CancelFlag::new();
        let request = precedence
            .begin_background(1_927_364_608, &cancel)
            .expect("no speech yet");
        let error = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                precedence.set_dictation(true);
            });
            let started = Instant::now();
            let error = process
                .generate(
                    "prompt",
                    16,
                    None,
                    &cancel,
                    Instant::now() + Duration::from_secs(20),
                )
                .unwrap_err();
            // The cancel grace alone is two seconds.
            assert!(started.elapsed() < Duration::from_millis(600));
            error
        });
        assert_eq!(error, HelperFailure::Cancelled);
        assert!(request.yielded());
        drop(process);
        drop(request);
        assert!(precedence.wait_for_stopped(Duration::from_millis(1)));
    }

    #[cfg(unix)]
    #[test]
    fn malformed_crashed_and_unknown_finish_helpers_are_refused() {
        for script in [
            "read request\necho 'not json'",
            "read request\nexit 7",
            "read request\necho '{\"type\":\"result\",\"text\":\"Notes.\",\"finish\":\"surprise\",\"promptTokens\":3,\"generatedTokens\":2,\"contextTokens\":256,\"elapsedMs\":4,\"memory\":{\"footprintBytes\":3,\"peakFootprintBytes\":9,\"peakResidentBytes\":11}}'",
        ] {
            let (helper, model) = stub(script);
            let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
            assert!(matches!(process.generate("prompt", 16, None, &CancelFlag::new(),
                Instant::now() + Duration::from_secs(3)), Err(HelperFailure::Crashed(_))), "{script}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unresponsive_reader_cannot_hold_a_request_past_its_deadline() {
        let (helper, model) = stub("while :; do :; done");
        let mut process = HelperProcess::start_at(&helper, &model, "stub", None).unwrap();
        // A pipe fills even on platforms with a large pipe buffer.
        let prompt = "x".repeat(1024 * 1024);
        let pid = process.child.id();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finished = done.clone();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            if !finished.load(std::sync::atomic::Ordering::Acquire) {
                // Only the helper still owned by this blocked test.
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        });
        let started = Instant::now();
        let outcome = process.generate(
            &prompt,
            16,
            None,
            &CancelFlag::new(),
            Instant::now() + Duration::from_millis(150),
        );
        done.store(true, std::sync::atomic::Ordering::Release);
        watchdog.join().unwrap();
        assert_eq!(outcome.unwrap_err(), HelperFailure::Timeout);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn an_untrusted_model_is_never_handed_to_the_helper() {
        let (helper, mut model) = stub("read eof");
        model.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(matches!(
            HelperProcess::start_at(&helper, &model, "stub", None),
            Err(HelperFailure::Invalid(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_warm_slot_reuses_its_helper_and_ends_it_when_idle() {
        let (helper, model) =
            stub("while read request; do echo '{\"type\":\"count\",\"tokens\":4}'; done");
        let slot = WarmSlot::new();
        let mut starts = 0;
        for _ in 0..3 {
            let tokens = slot
                .with(
                    "stub",
                    || {
                        starts += 1;
                        HelperProcess::start_at(&helper, &model, "stub", None)
                    },
                    |process| process.count_tokens("a b", Instant::now() + Duration::from_secs(5)),
                )
                .unwrap();
            assert_eq!(tokens, 4);
        }
        assert_eq!(starts, 1);
        assert!(!slot.end_if_idle_for(Duration::from_secs(60)));
        assert!(slot.end_if_idle_for(Duration::ZERO));
        assert!(!slot.is_loaded());
    }

    #[cfg(unix)]
    #[test]
    fn pressure_releases_idle_notes_and_cleanup_helpers_and_the_next_request_reloads() {
        use crate::hardware_tier::HardwareTier;
        use crate::memory_pressure::MemoryPressure;
        use crate::model_residency::Policy;
        for lane in ["notes", "cleanup"] {
            let (helper, model) =
                stub("while read request; do echo '{\"type\":\"count\",\"tokens\":4}'; done");
            let slot = WarmSlot::new();
            let (source, mut pressure) = tokio::sync::watch::channel(MemoryPressure::Normal);
            let mut previous = None;
            for level in [MemoryPressure::Warning, MemoryPressure::Critical] {
                let pid = slot
                    .with(
                        lane,
                        || HelperProcess::start_at(&helper, &model, lane, None),
                        |process| {
                            assert_eq!(
                                process.count_tokens(
                                    "text",
                                    Instant::now() + Duration::from_secs(5)
                                )?,
                                4
                            );
                            Ok(process.child.id())
                        },
                    )
                    .unwrap();
                assert_ne!(previous, Some(pid), "a released helper must restart");
                previous = Some(pid);
                source.send(level).unwrap();
                slot.release_idle(
                    Policy {
                        tier: HardwareTier::Light,
                        pressure: *pressure.borrow_and_update(),
                    },
                    Duration::from_secs(300),
                );
                assert!(!slot.is_loaded(), "{lane} stayed resident at {level:?}");
                // Drop waits for the process, not just its pipe or model slot.
                assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            }
            std::fs::remove_dir_all(helper.parent().unwrap()).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn pressure_does_not_end_a_busy_text_helper_and_retries_when_it_finishes() {
        use crate::hardware_tier::HardwareTier;
        use crate::memory_pressure::MemoryPressure;
        use crate::model_residency::Policy;
        let (helper, model) =
            stub("while read request; do echo '{\"type\":\"count\",\"tokens\":4}'; done");
        let slot = WarmSlot::new();
        let (entered, ready) = std::sync::mpsc::channel();
        let (finish, waiting) = std::sync::mpsc::channel();
        let policy = Policy {
            tier: HardwareTier::Best,
            pressure: MemoryPressure::Critical,
        };
        std::thread::scope(|scope| {
            let request_slot = &slot;
            let helper = &helper;
            let model = &model;
            let request = scope.spawn(move || {
                request_slot.with(
                    "notes",
                    || HelperProcess::start_at(helper, model, "notes", None),
                    |process| {
                        entered.send(process.child.id()).unwrap();
                        waiting.recv().unwrap();
                        process.count_tokens("text", Instant::now() + Duration::from_secs(5))
                    },
                )
            });
            let pid = ready.recv_timeout(Duration::from_secs(5)).unwrap();
            slot.release_idle(policy, Duration::ZERO);
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
            finish.send(()).unwrap();
            assert_eq!(request.join().unwrap().unwrap(), 4);
        });
        slot.release_idle(policy, Duration::ZERO);
        assert!(!slot.is_loaded());
        std::fs::remove_dir_all(helper.parent().unwrap()).unwrap();
    }
}
