//! One local text operation at a time, including model loading and unloading.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::sync::{Semaphore, SemaphorePermit};

/// Wakes paused background workers on gate release, foreground completion or
/// cancellation. The generation closes the check-before-sleep race.
pub(super) struct RuntimeEvent {
    generation: std::sync::Mutex<u64>,
    changed: std::sync::Condvar,
}

impl RuntimeEvent {
    const fn new() -> Self {
        Self {
            generation: std::sync::Mutex::new(0),
            changed: std::sync::Condvar::new(),
        }
    }

    #[cfg(feature = "diarization")]
    pub(super) fn generation(&self) -> u64 {
        *self.generation.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn notify(&self) {
        let mut generation = self.generation.lock().unwrap_or_else(|e| e.into_inner());
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }

    #[cfg(feature = "diarization")]
    pub(super) fn wait(&self, observed: u64, timeout: std::time::Duration) {
        let generation = self.generation.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self
            .changed
            .wait_timeout_while(generation, timeout, |value| *value == observed)
            .unwrap_or_else(|e| e.into_inner());
    }
}

pub(super) static RUNTIME_EVENT: RuntimeEvent = RuntimeEvent::new();

/// Returns the semaphore before notifying background workers.
#[derive(Debug)]
pub(crate) struct RuntimePermit<'a>(Option<SemaphorePermit<'a>>);
impl Drop for RuntimePermit<'_> {
    fn drop(&mut self) {
        self.0 = None;
        RUNTIME_EVENT.notify();
    }
}

const UNKNOWN: &str = "An earlier Ollama request may still be running. Local processing is paused because its completion could not be confirmed. Restarting Plainsong or checking loaded models does not confirm it stopped.";
const STORAGE: &str = "Local processing is paused because Plainsong could not read or update its Ollama safety marker in the configuration directory.";
const MARKER_BUSY: &str =
    "Another Plainsong process is updating the Ollama safety marker. Try again after it finishes.";
pub(crate) const OPERATION_BUSY: &str =
    "Another local text operation is running. Try again after it finishes.";

#[cfg(feature = "diarization")]
pub(crate) fn is_marker_busy(error: &str) -> bool {
    error == MARKER_BUSY
}

/// Whether an error is only the native runtime being busy with other work.
pub(crate) fn is_operation_busy(error: &str) -> bool {
    error.contains("Another local text operation is running")
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeHealthState {
    Available,
    Busy,
    CompletionUnknown,
    StorageError,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct RuntimeHealth {
    pub(crate) state: RuntimeHealthState,
    message: Option<&'static str>,
}

impl RuntimeHealth {
    fn new(state: RuntimeHealthState, message: Option<&'static str>) -> Self {
        Self { state, message }
    }
}

#[derive(Debug)]
enum MarkerLockError {
    Busy,
    Storage,
}

struct MarkerLock {
    file: std::fs::File,
}
impl MarkerLock {
    fn acquire(marker: &std::path::Path) -> Result<Self, MarkerLockError> {
        let parent = marker.parent().ok_or(MarkerLockError::Storage)?;
        std::fs::create_dir_all(parent).map_err(|_| MarkerLockError::Storage)?;
        // This stable lock file is never removed. All Plainsong marker changes
        // cooperate through it; external tools that ignore it are not protected.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(marker.with_extension("lock"))
            .map_err(|_| MarkerLockError::Storage)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(MarkerLockError::Busy),
            Err(std::fs::TryLockError::Error(_)) => Err(MarkerLockError::Storage),
        }
    }
}

impl Drop for MarkerLock {
    fn drop(&mut self) {
        // Release explicitly rather than by closing. An flock belongs to the
        // open file description, and a process spawned on another thread while
        // this descriptor is open briefly shares that description until its
        // exec closes it. Closing here would leave the lock held for that
        // window, so a waiting Plainsong caller would see a busy marker that
        // nothing owns. Unlocking through any reference releases it for all.
        let _ = self.file.unlock();
    }
}

fn sync_directory(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

enum MarkerLocation {
    None,
    #[cfg(not(test))]
    Configuration,
    #[cfg(test)]
    Path(PathBuf),
}

pub(crate) struct RuntimeGate {
    semaphore: Semaphore,
    blocked: AtomicU8,
    marker: MarkerLocation,
}
impl RuntimeGate {
    /// A gate without the Ollama safety marker.
    pub(crate) const fn new() -> Self {
        Self {
            semaphore: Semaphore::const_new(1),
            blocked: AtomicU8::new(0),
            marker: MarkerLocation::None,
        }
    }
    #[cfg(not(test))]
    const fn durable() -> Self {
        Self {
            semaphore: Semaphore::const_new(1),
            blocked: AtomicU8::new(0),
            marker: MarkerLocation::Configuration,
        }
    }
    #[cfg(test)]
    pub(super) fn with_marker(path: PathBuf) -> Self {
        Self {
            marker: MarkerLocation::Path(path),
            ..Self::new()
        }
    }
    fn marker_path(&self) -> Result<Option<PathBuf>, &'static str> {
        match &self.marker {
            MarkerLocation::None => Ok(None),
            #[cfg(not(test))]
            MarkerLocation::Configuration => crate::paths::config_dir()
                .map(|root| Some(root.join("Plainsong").join("ollama-request-pending.json")))
                .ok_or(STORAGE),
            #[cfg(test)]
            MarkerLocation::Path(path) => Ok(Some(path.clone())),
        }
    }
    fn block(&self, reason: u8) {
        self.blocked.store(reason, Ordering::Release);
        self.semaphore.close();
    }
    fn blocked_message(&self) -> &'static str {
        if self.blocked.load(Ordering::Acquire) == 2 {
            STORAGE
        } else {
            UNKNOWN
        }
    }
    pub(super) fn refusal(&self) -> Option<&'static str> {
        self.semaphore.is_closed().then(|| self.blocked_message())
    }
    /// Observe admission without acquiring a permit, changing a marker, or latching a refusal.
    pub(crate) fn health(&self) -> RuntimeHealth {
        use RuntimeHealthState::*;
        if self.semaphore.is_closed() {
            return RuntimeHealth::new(
                if self.blocked.load(Ordering::Acquire) == 2 {
                    StorageError
                } else {
                    CompletionUnknown
                },
                Some(self.blocked_message()),
            );
        }
        // An owned request has a pending marker too. Its active lease is busy,
        // not evidence that completion was lost.
        if self.semaphore.available_permits() == 0 {
            return RuntimeHealth::new(Busy, Some(OPERATION_BUSY));
        }
        let path = match self.marker_path() {
            Ok(path) => path,
            Err(_) => return RuntimeHealth::new(StorageError, Some(STORAGE)),
        };
        if let Some(path) = path {
            match std::fs::symlink_metadata(path) {
                Ok(_) => return RuntimeHealth::new(CompletionUnknown, Some(UNKNOWN)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return RuntimeHealth::new(StorageError, Some(STORAGE)),
            }
        }
        RuntimeHealth::new(Available, None)
    }
    /// Whether an operation holds the gate right now.
    pub(crate) fn is_busy(&self) -> bool {
        !self.semaphore.is_closed() && self.semaphore.available_permits() == 0
    }
    pub(crate) fn acquire(&self) -> Result<RuntimePermit<'_>, &'static str> {
        let permit = self.semaphore.try_acquire().map_err(|_| {
            if self.semaphore.is_closed() {
                self.blocked_message()
            } else {
                OPERATION_BUSY
            }
        })?;
        self.validate_durable_admission()?;
        Ok(RuntimePermit(Some(permit)))
    }
    /// Wait for an active operation to release its permit, then apply the same
    /// durable admission checks as a nonblocking inference request.
    pub(crate) async fn acquire_when_available(&self) -> Result<RuntimePermit<'_>, &'static str> {
        let permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| self.blocked_message())?;
        self.validate_durable_admission()?;
        Ok(RuntimePermit(Some(permit)))
    }
    fn validate_durable_admission(&self) -> Result<(), &'static str> {
        let path = self.marker_path().inspect_err(|_| self.block(2))?;
        if let Some(path) = path {
            let _lock = MarkerLock::acquire(&path).map_err(|error| match error {
                MarkerLockError::Busy => MARKER_BUSY,
                MarkerLockError::Storage => {
                    self.block(2);
                    STORAGE
                }
            })?;
            match std::fs::symlink_metadata(path) {
                Ok(_) => {
                    self.block(1);
                    return Err(UNKNOWN);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    self.block(2);
                    return Err(STORAGE);
                }
            }
        }
        Ok(())
    }
}
/// Text work that runs outside the sidecar: the notes and cleanup helpers,
/// Apple's language model and local Ollama requests. One at a time, behind
/// the Ollama safety marker.
#[cfg(not(test))]
pub(crate) static TEXT_RUNTIME: RuntimeGate = RuntimeGate::durable();
#[cfg(test)]
pub(crate) static TEXT_RUNTIME: RuntimeGate = RuntimeGate::new();

/// Native allocations inside the sidecar (ggml, ONNX and Candle speech, the
/// speaker and search embedders) and Apple's speech recognizer. These used to
/// share `TEXT_RUNTIME` with the in-process text model; since text moved into
/// helper processes the two only meet through memory admission, so a notes
/// request no longer refuses or delays speech here. The Neural Engine speech
/// helper takes neither gate.
pub(crate) static NATIVE_RUNTIME: RuntimeGate = RuntimeGate::new();

/// Held by the HTTP owner, never by the caller waiting for its result.
pub(super) struct LocalRequestGuard<'a> {
    gate: &'a RuntimeGate,
    _permit: Option<RuntimePermit<'a>>,
    dispatched: bool,
    terminal: bool,
    marker: Option<(PathBuf, String)>,
}

impl<'a> LocalRequestGuard<'a> {
    pub(super) fn new(gate: &'a RuntimeGate, permit: Option<RuntimePermit<'a>>) -> Self {
        Self {
            gate,
            _permit: permit,
            dispatched: false,
            terminal: false,
            marker: None,
        }
    }
    pub(super) fn requires_terminal(&self) -> bool {
        self._permit.is_some()
    }
    pub(super) fn begin_dispatch(&mut self, operation: &'static str) -> Result<(), &'static str> {
        use std::io::Write;
        if self._permit.is_none() {
            self.dispatched = true;
            return Ok(());
        }
        let path = self
            .gate
            .marker_path()
            .inspect_err(|_| self.gate.block(2))?;
        let _lock = path
            .as_deref()
            .map(MarkerLock::acquire)
            .transpose()
            .map_err(|error| match error {
                MarkerLockError::Busy => MARKER_BUSY,
                MarkerLockError::Storage => {
                    self.gate.block(2);
                    STORAGE
                }
            })?;
        // Arm only after locking. Contention before any POST remains retryable.
        self.dispatched = true;
        let persist = || -> std::io::Result<Option<(PathBuf, String)>> {
            if let Some(path) = &path {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                // Existence is the safety signal, even if this write is interrupted.
                let metadata = serde_json::json!({"version":1,"operation":operation,"requestId":uuid::Uuid::new_v4().to_string(),"processId":std::process::id()}).to_string();
                file.write_all(metadata.as_bytes())?;
                file.sync_all()?;
                sync_directory(path.parent().unwrap())?;
                return Ok(Some((path.clone(), metadata)));
            }
            Ok(None)
        };
        self.marker = persist().map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                self.gate.block(1);
                UNKNOWN
            } else {
                self.gate.block(2);
                STORAGE
            }
        })?;
        Ok(())
    }
    pub(super) fn confirm_terminal(&mut self) -> Result<(), &'static str> {
        use std::io::Read;
        self.terminal = true;
        if let Some((path, metadata)) = self.marker.take() {
            let _lock = MarkerLock::acquire(&path).map_err(|_| {
                self.gate.block(2);
                STORAGE
            })?;
            // Cooperative replacement cannot interleave this compare and unlink.
            let read_marker = || -> std::io::Result<Vec<u8>> {
                let mut bytes = Vec::new();
                std::fs::File::open(&path)?
                    .take(4097)
                    .read_to_end(&mut bytes)?;
                Ok(bytes)
            };
            if read_marker().ok().as_deref() != Some(metadata.as_bytes()) {
                self.gate.block(2);
                return Err(STORAGE);
            }
            if std::fs::remove_file(&path)
                .and_then(|()| sync_directory(path.parent().unwrap()))
                .is_err()
            {
                self.gate.block(2);
                return Err(STORAGE);
            }
        }
        Ok(())
    }
    /// The owner has not polled its HTTP send future, so no POST was dispatched.
    pub(super) fn cancel_before_send(&mut self) -> Result<(), &'static str> {
        self.confirm_terminal()
    }
}

impl Drop for LocalRequestGuard<'_> {
    fn drop(&mut self) {
        if self.requires_terminal() && self.dispatched && !self.terminal {
            if !self.gate.semaphore.is_closed() {
                self.gate.block(1);
            }
            tracing::warn!(
                "Ollama request ended without terminal evidence; local runtime remains blocked"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn marker_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("plainsong-ollama-marker-{}", uuid::Uuid::new_v4()))
            .join("pending.json")
    }
    #[cfg(feature = "diarization")]
    #[test]
    fn background_notification_wait_blocks_and_does_not_lose_prior_notifications() {
        use std::time::{Duration, Instant};
        let event = RuntimeEvent::new();
        let observed = event.generation();
        let started = Instant::now();
        event.wait(observed, Duration::from_millis(120));
        assert!(started.elapsed() >= Duration::from_millis(110));
        event.notify();
        let started = Instant::now();
        event.wait(observed, Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn health_does_not_create_marker_directories_or_latch_persisted_uncertainty() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        assert_eq!(
            gate.health(),
            RuntimeHealth::new(RuntimeHealthState::Available, None)
        );
        assert!(!path.parent().unwrap().exists());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"unread private marker content").unwrap();
        assert_eq!(
            gate.health(),
            RuntimeHealth::new(RuntimeHealthState::CompletionUnknown, Some(UNKNOWN))
        );
        assert!(!gate.semaphore.is_closed());
        assert_eq!(gate.blocked.load(Ordering::Acquire), 0);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"unread private marker content"
        );
        assert!(!path.with_extension("lock").exists());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(gate.health().state, RuntimeHealthState::Available);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn health_reports_an_owned_pending_request_as_temporary_busy() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        request.begin_dispatch("chat").unwrap();
        assert_eq!(
            gate.health(),
            RuntimeHealth::new(RuntimeHealthState::Busy, Some(OPERATION_BUSY))
        );
        assert!(!gate.semaphore.is_closed());
        request.confirm_terminal().unwrap();
        drop(request);
        assert_eq!(gate.health().state, RuntimeHealthState::Available);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn health_reports_storage_inspection_failure_without_closing_the_gate() {
        let path = marker_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"parent is a file").unwrap();
        let gate = RuntimeGate::with_marker(path.join("pending.json"));
        assert_eq!(
            gate.health(),
            RuntimeHealth::new(RuntimeHealthState::StorageError, Some(STORAGE))
        );
        assert!(!gate.semaphore.is_closed());
        assert_eq!(gate.blocked.load(Ordering::Acquire), 0);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn health_preserves_an_existing_permanent_refusal() {
        let gate = RuntimeGate::new();
        gate.block(2);
        assert_eq!(
            gate.health(),
            RuntimeHealth::new(RuntimeHealthState::StorageError, Some(STORAGE))
        );
        assert_eq!(gate.acquire().unwrap_err(), STORAGE);
    }
    #[test]
    fn marker_lock_process_fixture() {
        // Only the explicitly spawned helper receives this child-local variable.
        let Some(path) = std::env::var_os("PLAINSONG_TEST_MARKER_LOCK_PATH") else {
            return;
        };
        let _lock = MarkerLock::acquire(&PathBuf::from(path)).unwrap();
        use std::io::Write;
        println!("PLAINSONG_MARKER_LOCK_HELD");
        std::io::stdout().flush().unwrap();
        let mut release = String::new();
        std::io::stdin().read_line(&mut release).unwrap();
    }
    #[test]
    fn marker_lock_contention_is_cross_process_and_retryable() {
        use std::io::{BufRead, Write};
        let path = marker_path();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "llm::native_runtime_gate::tests::marker_lock_process_fixture",
                "--nocapture",
            ])
            .env("PLAINSONG_TEST_MARKER_LOCK_PATH", &path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "lock helper exited before acquiring its lock"
            );
            if line.contains("PLAINSONG_MARKER_LOCK_HELD") {
                break;
            }
        }
        let gate = RuntimeGate::with_marker(path.clone());
        let refusal = gate.acquire().err();
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(refusal, Some(MARKER_BUSY));
        assert!(
            gate.acquire().is_ok(),
            "contention must not permanently close the gate"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn releasing_the_marker_lock_does_not_wait_for_a_shared_descriptor() {
        // A process spawned on another thread while the lock is held shares
        // its open file description until exec. A clone stands in for it.
        let path = marker_path();
        let lock = MarkerLock::acquire(&path).unwrap();
        let shared = lock.file.try_clone().unwrap();
        drop(lock);
        let reacquired = MarkerLock::acquire(&path);
        drop(shared);
        assert!(reacquired.is_ok(), "a released lock must not stay busy");
        drop(reacquired);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn marker_contention_after_admission_prevents_dispatch_without_latching() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        let competing = MarkerLock::acquire(&path).unwrap();
        assert_eq!(request.begin_dispatch("chat"), Err(MARKER_BUSY));
        drop(request);
        assert!(!path.exists());
        drop(competing);
        assert!(gate.acquire().is_ok());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn terminal_cleanup_cannot_interleave_a_cooperative_marker_update() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        request.begin_dispatch("chat").unwrap();
        let competing = MarkerLock::acquire(&path).unwrap();
        std::fs::write(&path, b"cooperating replacement request").unwrap();
        assert!(request.confirm_terminal().is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"cooperating replacement request"
        );
        drop(competing);
        drop(request);
        assert!(gate.acquire().is_err());
        assert!(RuntimeGate::with_marker(path.clone()).acquire().is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn an_unconfirmed_dispatch_remains_blocked_after_gate_recreation() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        request.begin_dispatch("chat").unwrap();
        let metadata = std::fs::read_to_string(&path).unwrap();
        assert!(metadata.contains("requestId"));
        assert!(!metadata.contains("prompt"));
        drop(request);
        assert!(gate.acquire().unwrap_err().contains("may still be running"));
        let restarted = RuntimeGate::with_marker(path.clone());
        assert!(restarted
            .acquire()
            .unwrap_err()
            .contains("may still be running"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn terminal_evidence_clears_only_the_owned_marker() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        request.begin_dispatch("prewarm").unwrap();
        assert!(path.exists());
        request.confirm_terminal().unwrap();
        drop(request);
        assert!(!path.exists());
        assert!(gate.acquire().is_ok());
        assert!(RuntimeGate::with_marker(path.clone()).acquire().is_ok());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn existing_or_unreadable_marker_state_is_never_ignored() {
        let path = marker_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"malformed or interrupted marker").unwrap();
        assert!(RuntimeGate::with_marker(path.clone())
            .acquire()
            .unwrap_err()
            .contains("may still be running"));
        let broken = path.join("not-a-directory");
        assert!(RuntimeGate::with_marker(broken)
            .acquire()
            .unwrap_err()
            .contains("configuration directory"));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"malformed or interrupted marker"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn terminal_owner_never_clears_a_replaced_marker() {
        let path = marker_path();
        let gate = RuntimeGate::with_marker(path.clone());
        let mut request = LocalRequestGuard::new(&gate, Some(gate.acquire().unwrap()));
        request.begin_dispatch("chat").unwrap();
        std::fs::write(&path, b"another request").unwrap();
        assert!(request.confirm_terminal().is_err());
        drop(request);
        assert_eq!(std::fs::read(&path).unwrap(), b"another request");
        assert!(gate.acquire().is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn aborting_the_http_owner_preserves_its_durable_uncertainty() {
        let path = marker_path();
        let gate = std::sync::Arc::new(RuntimeGate::with_marker(path.clone()));
        let worker_gate = gate.clone();
        let (ready, wait_ready) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(async move {
            let mut request =
                LocalRequestGuard::new(&worker_gate, Some(worker_gate.acquire().unwrap()));
            request.begin_dispatch("chat").unwrap();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        wait_ready.await.unwrap();
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        assert!(gate.acquire().is_err());
        assert!(RuntimeGate::with_marker(path.clone()).acquire().is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn a_second_text_operation_cannot_load_while_the_first_is_active() {
        let gate = RuntimeGate::new();
        let first = gate.acquire().unwrap();
        assert!(gate.acquire().is_err());
        drop(first);
        assert!(gate.acquire().is_ok());
    }
    #[test]
    fn error_returns_release_the_operation_lease() {
        fn failed_operation(gate: &RuntimeGate) -> Result<(), &'static str> {
            let _lease = gate.acquire()?;
            Err("Controlled failure")
        }
        let gate = RuntimeGate::new();
        assert!(failed_operation(&gate).is_err());
        assert!(gate.acquire().is_ok());
    }
    #[tokio::test]
    async fn permit_can_cross_an_async_boundary_and_drop_releases_it() {
        let gate = std::sync::Arc::new(RuntimeGate::new());
        let worker_gate = gate.clone();
        let (ready, wait_ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _lease = worker_gate.acquire().unwrap();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        wait_ready.await.unwrap();
        assert!(gate.acquire().is_err());
        task.abort();
        let _ = task.await;
        assert!(gate.acquire().is_ok());
    }
    #[tokio::test]
    async fn waiting_admission_wakes_only_after_the_active_permit_is_released() {
        let gate = RuntimeGate::new();
        let active = gate.acquire().unwrap();
        let waiting = gate.acquire_when_available();
        tokio::pin!(waiting);
        tokio::select! {
            result = &mut waiting => panic!("waiter acquired a held gate: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(active);
        assert!(waiting.await.is_ok());
    }
    #[tokio::test]
    async fn waiting_admission_rejects_a_durable_stale_marker() {
        let path = marker_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"unconfirmed request").unwrap();
        let gate = RuntimeGate::with_marker(path.clone());
        assert_eq!(gate.acquire_when_available().await.unwrap_err(), UNKNOWN);
        assert!(gate.semaphore.is_closed());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn waiting_admission_rejects_a_closed_gate() {
        let gate = RuntimeGate::new();
        gate.block(2);
        assert_eq!(gate.acquire_when_available().await.unwrap_err(), STORAGE);
    }
}
