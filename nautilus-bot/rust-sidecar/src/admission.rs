use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
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
