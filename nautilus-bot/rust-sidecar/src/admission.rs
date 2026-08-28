use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_CONCURRENT_REQUESTS: usize = 32;
const MAX_CONCURRENT_DOWNLOADS: usize = 2;
const MAX_CONCURRENT_BENCHMARKS: usize = 1;
const MAX_CONCURRENT_ANALYSES: usize = 3;
const MAX_CONCURRENT_BACKUP_WORK: usize = 1;
const MAX_CONCURRENT_CAPTURE_COMMANDS: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandClass {
    General,
    Download,
    Benchmark,
    Analysis,
    Backup,
    Capture,
}

impl CommandClass {
    fn label(self) -> &'static str {
        match self {
            Self::General => "sidecar request",
            Self::Download => "model download",
            Self::Benchmark => "ASR benchmark",
            Self::Analysis => "analysis",
            Self::Backup => "backup operation",
            Self::Capture => "capture command",
        }
    }
}

pub struct AdmissionController {
    overall: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
    benchmarks: Arc<Semaphore>,
    analyses: Arc<Semaphore>,
    backups: Arc<Semaphore>,
    capture: Arc<Semaphore>,
    duplicate_keys: Arc<Mutex<HashSet<String>>>,
}

impl Default for AdmissionController {
    fn default() -> Self {
        Self {
            overall: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
            downloads: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
            benchmarks: Arc::new(Semaphore::new(MAX_CONCURRENT_BENCHMARKS)),
            analyses: Arc::new(Semaphore::new(MAX_CONCURRENT_ANALYSES)),
            backups: Arc::new(Semaphore::new(MAX_CONCURRENT_BACKUP_WORK)),
            capture: Arc::new(Semaphore::new(MAX_CONCURRENT_CAPTURE_COMMANDS)),
            duplicate_keys: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

impl AdmissionController {
    pub fn admit(&self, command: &str, params: &Value) -> Result<AdmissionLease, String> {
        let class = classify_command(command);
        let overall = Arc::clone(&self.overall)
            .try_acquire_owned()
            .map_err(|_| busy_error(CommandClass::General))?;
        let class_permit = self
            .semaphore(class)
            .map(|semaphore| semaphore.try_acquire_owned().map_err(|_| busy_error(class)))
            .transpose()?;

        let duplicate_key = duplicate_work_key(command, params);
        if let Some(key) = duplicate_key.as_deref() {
            let mut keys = self
                .duplicate_keys
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !keys.insert(key.to_string()) {
                return Err(format!(
                    "SIDECAR_DUPLICATE: {} is already running for this target.",
                    command
                ));
            }
        }

        Ok(AdmissionLease {
            _overall: overall,
            _class: class_permit,
            duplicate_key,
            duplicate_keys: Arc::clone(&self.duplicate_keys),
        })
    }

    fn semaphore(&self, class: CommandClass) -> Option<Arc<Semaphore>> {
        match class {
            CommandClass::General => None,
            CommandClass::Download => Some(Arc::clone(&self.downloads)),
            CommandClass::Benchmark => Some(Arc::clone(&self.benchmarks)),
            CommandClass::Analysis => Some(Arc::clone(&self.analyses)),
            CommandClass::Backup => Some(Arc::clone(&self.backups)),
            CommandClass::Capture => Some(Arc::clone(&self.capture)),
        }
    }
}

fn busy_error(class: CommandClass) -> String {
    format!(
        "SIDECAR_BUSY: {} capacity is full. Wait for active work to finish and retry.",
        class.label()
    )
}

fn classify_command(command: &str) -> CommandClass {
    match command {
        "download_asr_models"
        | "download_diarization_model"
        | "download_platform_assets"
        | "download_silero_vad_model"
        | "download_whisper_model" => CommandClass::Download,
        "benchmark_asr_providers" | "benchmark_asr_providers_bytes" => CommandClass::Benchmark,
        "analyze_recording"
        | "analyze_recordings"
        | "ask_memory"
        | "extract_action_items"
        | "extract_action_items_grounded"
        | "retry_meeting_analysis"
        | "summarize_recording"
        | "summarize_recording_grounded" => CommandClass::Analysis,
        "create_backup_default"
        | "create_settings_backup_default"
        | "restore_backup_default"
        | "sync_backup_to_cloud" => CommandClass::Backup,
        "start_recording" | "stop_recording" => CommandClass::Capture,
        _ => CommandClass::General,
    }
}

fn string_param(params: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        params
            .get(*name)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn duplicate_work_key(command: &str, params: &Value) -> Option<String> {
    let class = classify_command(command);
    let target = match class {
        CommandClass::Download => {
            string_param(params, &["modelName", "modelId", "providerType", "assetId"])
                .unwrap_or_else(|| command.to_string())
        }
        CommandClass::Benchmark => "benchmark".to_string(),
        CommandClass::Analysis => string_param(params, &["runId", "recordingId"])
            .or_else(|| {
                params
                    .get("recordingIds")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
            })
            .unwrap_or_else(|| command.to_string()),
        CommandClass::Backup => {
            string_param(params, &["backupId"]).unwrap_or_else(|| command.to_string())
        }
        CommandClass::Capture => command.to_string(),
        CommandClass::General => return None,
    };
    Some(format!("{command}:{target}"))
}

pub struct AdmissionLease {
    _overall: OwnedSemaphorePermit,
    _class: Option<OwnedSemaphorePermit>,
    duplicate_key: Option<String>,
    duplicate_keys: Arc<Mutex<HashSet<String>>>,
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if let Some(key) = self.duplicate_key.as_deref() {
            self.duplicate_keys
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(key);
        }
    }
}

/// How long an issued capture-admission nonce stays redeemable.
///
/// The nonce is minted the instant the user clicks and redeemed by the very next
/// `start_recording`, so this only has to cover one IPC hop. Short on purpose: a
/// nonce that outlives the gesture it represents is no longer evidence that a
/// human asked for this capture.
const CAPTURE_ADMISSION_TTL: Duration = Duration::from_secs(30);

/// Why a capture-admission nonce was not accepted.
///
/// There is deliberately no distinct "reused" case. Redeeming removes the nonce,
/// so a replay is indistinguishable from a proof that was never issued -- and
/// reporting the safer of the two is the right answer either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureAdmissionRejection {
    /// Never issued by the privileged Electron side, or already redeemed.
    Unknown,
    /// Issued, but older than [`CAPTURE_ADMISSION_TTL`].
    Expired,
}

impl CaptureAdmissionRejection {
    pub fn message(self) -> &'static str {
        match self {
            Self::Unknown => "Meeting capture admission proof was not issued by Plainsong",
            Self::Expired => "Meeting capture admission proof expired. Start the meeting again.",
        }
    }
}

/// Single-use, short-lived proof that a real user gesture asked for a capture.
///
/// The sidecar used to accept any well-formed UUID as admission, which made the
/// check a formality: anything that could reach the command could mint its own
/// proof. Registering each issued nonce turns it into something only the
/// privileged Electron side can produce.
///
/// Enforcement is opt-in *by first use*: until Electron registers its first
/// nonce, a UUID-shaped proof is still accepted, exactly as before. Rejecting
/// unregistered nonces before the registrar exists would take meeting capture
/// down entirely. The moment the first nonce is registered, the registry is
/// authoritative and unknown, expired, and reused nonces are all refused.
pub struct CaptureAdmissionRegistry {
    issued: Mutex<HashMap<String, Instant>>,
    /// Flipped the first time a nonce is registered, and never back.
    registrar_active: AtomicBool,
    ttl: Duration,
}

impl Default for CaptureAdmissionRegistry {
    fn default() -> Self {
        Self::with_ttl(CAPTURE_ADMISSION_TTL)
    }
}

impl CaptureAdmissionRegistry {
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            issued: Mutex::new(HashMap::new()),
            registrar_active: AtomicBool::new(false),
            ttl,
        }
    }

    /// Whether the privileged registrar has ever registered a nonce.
    pub fn is_enforcing(&self) -> bool {
        self.registrar_active.load(Ordering::SeqCst)
    }

    /// Record a nonce the privileged side just issued.
    pub fn register(&self, nonce: &str) {
        let mut issued = self
            .issued
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Sweep on write: the map only ever holds nonces from the last few
        // seconds, so it never needs its own timer.
        let ttl = self.ttl;
        issued.retain(|_, issued_at| issued_at.elapsed() <= ttl);
        issued.insert(nonce.to_string(), Instant::now());
        drop(issued);
        self.registrar_active.store(true, Ordering::SeqCst);
    }

    /// Redeem a nonce. Succeeds at most once per registered nonce.
    pub fn consume(&self, nonce: &str) -> Result<(), CaptureAdmissionRejection> {
        let mut issued = self
            .issued
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match issued.remove(nonce) {
            Some(issued_at) if issued_at.elapsed() <= self.ttl => Ok(()),
            Some(_) => Err(CaptureAdmissionRejection::Expired),
            None => {
                if self.registrar_active.load(Ordering::SeqCst) {
                    // Once the registrar is live, an unrecognised nonce is
                    // either forged or already spent. Both are refusals; the
                    // registry cannot tell them apart after removal, and
                    // "unknown" is the safer thing to report.
                    Err(CaptureAdmissionRejection::Unknown)
                } else {
                    Ok(())
                }
            }
        }
    }
}

#[cfg(test)]
mod capture_admission_tests {
    use super::*;

    #[test]
    fn an_unregistered_nonce_is_accepted_until_the_registrar_appears() {
        // Compatibility path: rejecting before Electron registers anything
        // would take meeting capture down outright.
        let registry = CaptureAdmissionRegistry::default();
        assert!(!registry.is_enforcing());
        assert!(registry.consume("any-uuid").is_ok());
    }

    #[test]
    fn registering_a_nonce_turns_on_enforcement() {
        let registry = CaptureAdmissionRegistry::default();
        registry.register("nonce-1");

        assert!(registry.is_enforcing());
        assert_eq!(
            registry.consume("never-issued"),
            Err(CaptureAdmissionRejection::Unknown)
        );
    }

    #[test]
    fn a_registered_nonce_is_accepted_exactly_once() {
        let registry = CaptureAdmissionRegistry::default();
        registry.register("nonce-1");

        assert!(registry.consume("nonce-1").is_ok());
        // Single use: a replayed proof is no proof.
        assert_eq!(
            registry.consume("nonce-1"),
            Err(CaptureAdmissionRejection::Unknown)
        );
    }

    #[test]
    fn an_expired_nonce_is_rejected() {
        let registry = CaptureAdmissionRegistry::with_ttl(Duration::from_millis(0));
        registry.register("nonce-1");
        std::thread::sleep(Duration::from_millis(5));

        assert_eq!(
            registry.consume("nonce-1"),
            Err(CaptureAdmissionRejection::Expired)
        );
    }

    #[test]
    fn registering_sweeps_nonces_that_outlived_their_ttl() {
        // The map must not grow for the life of the process just because some
        // gestures never turned into a capture.
        let registry = CaptureAdmissionRegistry::with_ttl(Duration::from_millis(0));
        registry.register("stale-1");
        std::thread::sleep(Duration::from_millis(5));
        registry.register("fresh-1");

        let issued = registry
            .issued
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(!issued.contains_key("stale-1"));
        assert!(issued.contains_key("fresh-1"));
    }

    #[test]
    fn every_rejection_explains_itself() {
        for rejection in [
            CaptureAdmissionRejection::Unknown,
            CaptureAdmissionRejection::Expired,
        ] {
            assert!(!rejection.message().is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benchmark_capacity_is_bounded_and_recovers_after_drop() {
        let admission = AdmissionController::default();
        let lease = admission
            .admit("benchmark_asr_providers_bytes", &serde_json::json!({}))
            .expect("first benchmark");
        let error = admission
            .admit("benchmark_asr_providers_bytes", &serde_json::json!({}))
            .err()
            .expect("second benchmark must be rejected");
        assert!(error.starts_with("SIDECAR_BUSY:"));
        drop(lease);
        admission
            .admit("benchmark_asr_providers_bytes", &serde_json::json!({}))
            .expect("benchmark capacity must recover");
    }

    #[test]
    fn duplicate_download_is_rejected_but_another_model_can_run() {
        let admission = AdmissionController::default();
        let first = admission
            .admit(
                "download_whisper_model",
                &serde_json::json!({"modelName": "base.en"}),
            )
            .expect("first download");
        let error = admission
            .admit(
                "download_whisper_model",
                &serde_json::json!({"modelName": "base.en"}),
            )
            .err()
            .expect("duplicate download must be rejected");
        assert!(error.starts_with("SIDECAR_DUPLICATE:"));
        admission
            .admit(
                "download_whisper_model",
                &serde_json::json!({"modelName": "tiny.en"}),
            )
            .expect("different model can use the second slot");
        drop(first);
    }

    #[test]
    fn a_manual_retry_is_admitted_as_analysis_work() {
        // A retry that raced the automatic post-stop pass must share the
        // analysis semaphore and the per-recording duplicate key, or two full
        // LLM passes run and last-write-wins on the results.
        let admission = AdmissionController::default();
        let _first = admission
            .admit(
                "retry_meeting_analysis",
                &serde_json::json!({"recordingId": "recording-1"}),
            )
            .expect("first retry");
        let error = admission
            .admit(
                "retry_meeting_analysis",
                &serde_json::json!({"recordingId": "recording-1"}),
            )
            .err()
            .expect("concurrent retry for the same recording must be rejected");
        assert!(error.starts_with("SIDECAR_DUPLICATE:"));
    }

    #[test]
    fn duplicate_analysis_run_id_is_rejected() {
        let admission = AdmissionController::default();
        let _first = admission
            .admit(
                "analyze_recording",
                &serde_json::json!({"runId": "run-1", "recordingId": "recording-1"}),
            )
            .expect("first analysis");
        let error = admission
            .admit(
                "analyze_recording",
                &serde_json::json!({"runId": "run-1", "recordingId": "recording-1"}),
            )
            .err()
            .expect("duplicate analysis must be rejected");
        assert!(error.starts_with("SIDECAR_DUPLICATE:"));
    }
}
