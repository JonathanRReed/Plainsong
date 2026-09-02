/// Plainsong sidecar binary entrypoint.
///
/// Runs the full Plainsong backend as a stdio JSON-RPC server.
/// The Electron main process spawns this binary, writes requests to its stdin,
/// and reads responses/events from its stdout.
///
/// Protocol: newline-delimited JSON-RPC 2.0
///   Request:  { "jsonrpc":"2.0", "id":"<uuid>", "method":"<command>", "params":{...} }
///   Response: { "jsonrpc":"2.0", "id":"<uuid>", "result":<value> }
///   Error:    { "jsonrpc":"2.0", "id":"<uuid>", "error":{"code":-32000,"message":"..."} }
///   Event:    { "jsonrpc":"2.0", "id":null, "method":"event", "params":{"event":"<name>","payload":<value>} }
use plainsong_lib::sidecar_handle::SidecarHandle;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

const MAX_JSON_RPC_LINE_BYTES: usize = 32 * 1024 * 1024;

type ActiveAnalysisRun = (AbortHandle, Value, String);
type ActiveAnalysisRuns = Arc<Mutex<HashMap<String, ActiveAnalysisRun>>>;
type ActiveRequests = Arc<Mutex<HashMap<String, AbortHandle>>>;
type ActiveResponseClaims = Arc<Mutex<HashSet<String>>>;

enum BoundedLine {
    Eof,
    Line(Vec<u8>),
    TooLong,
}

fn read_bounded_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<BoundedLine> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if too_long {
                Ok(BoundedLine::TooLong)
            } else if line.is_empty() {
                Ok(BoundedLine::Eof)
            } else {
                Ok(BoundedLine::Line(line))
            };
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(buffer.len());
        if !too_long {
            if line.len().saturating_add(take) > max_bytes {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(&buffer[..take]);
            }
        }
        let consumed = take + usize::from(newline.is_some());
        reader.consume(consumed);

        if newline.is_some() {
            return if too_long {
                Ok(BoundedLine::TooLong)
            } else {
                Ok(BoundedLine::Line(line))
            };
        }
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    _jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

fn write_response(id: Value, result: Result<Value, String>) {
    let response = match result {
        Ok(value) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(value),
            error: None,
        },
        Err(msg) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32000,
                message: msg,
            }),
        },
    };
    if let Ok(line) = serde_json::to_string(&response) {
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        let _ = writeln!(lock, "{}", line);
    }
}

fn response_key(id: &Value) -> Option<String> {
    if id.is_null() {
        None
    } else {
        serde_json::to_string(id).ok()
    }
}

fn claim_response(active_response_claims: &ActiveResponseClaims, request_key: &str) -> bool {
    active_response_claims
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(request_key)
}

fn abort_active_requests(
    active_requests: &ActiveRequests,
    active_analysis_runs: &ActiveAnalysisRuns,
    active_response_claims: &ActiveResponseClaims,
) -> usize {
    let handles = {
        let mut active = active_requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
    };
    let analysis_handles = {
        let mut active = active_analysis_runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active
            .drain()
            .map(|(_, (handle, _, _))| handle)
            .collect::<Vec<_>>()
    };
    let count = handles.len().max(analysis_handles.len());
    for handle in handles {
        handle.abort();
    }
    // Analysis handles normally refer to the same tasks as `active_requests`,
    // but abort them explicitly as well so non-string JSON-RPC IDs cannot
    // leave an analysis task running during teardown.
    for handle in analysis_handles {
        handle.abort();
    }
    active_response_claims
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    count
}

fn main() -> ExitCode {
    tracing_subscriber::fmt().with_writer(io::stderr).init();

    if std::env::args_os()
        .skip(1)
        .any(|argument| argument == plainsong_lib::SYSTEM_AUDIO_TEST_WORKER_ARGUMENT)
    {
        // The parent sidecar normally kills and reaps this helper after 75s.
        // Keep a second deadline inside the helper so quitting or crashing the
        // parent during a blocked Core Audio permission request cannot leave an
        // orphan process behind for the audio server's multi-minute timeout.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(70));
            eprintln!("[sidecar] System-audio worker reached its safety deadline");
            std::process::exit(plainsong_lib::SYSTEM_AUDIO_TEST_WORKER_TIMEOUT_EXIT_CODE);
        });
        let result = plainsong_lib::audio_system_test_worker();
        return match serde_json::to_string(&result) {
            Ok(payload) => {
                println!("{payload}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("[sidecar] Failed to serialize system-audio test result: {error}");
                ExitCode::FAILURE
            }
        };
    }

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[sidecar] Failed to create Tokio runtime: {error}");
            return ExitCode::FAILURE;
        }
    };

    let result = runtime.block_on(run_sidecar());
    // Abort and join runtime-owned tasks before Rust values and whisper.cpp's
    // process-global Metal cleanup run. `std::process::exit` skipped those
    // drops and could trigger a ggml residency-set assertion after a successful
    // transcription.
    runtime.shutdown_timeout(Duration::from_secs(2));

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[sidecar] {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run_sidecar() -> Result<(), String> {
    let state = match plainsong_lib::build_app_state().await {
        Ok(s) => Arc::new(s),
        Err(error) => return Err(format!("Failed to initialize state: {error}")),
    };

    // A previous process that crashed mid-playback can leave decrypted audio
    // in the app-owned runtime directory. Nothing else owns those files, so
    // they go before the first command is read.
    match plainsong_lib::sweep_runtime_playback_audio_for_sidecar() {
        Ok(true) => tracing::info!("Removed leftover decrypted playback audio from a prior run"),
        Ok(false) => {}
        Err(error) => tracing::warn!("Playback audio sweep at startup failed: {}", error),
    }

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<String>();
    let handle = SidecarHandle::new(event_tx);
    let active_requests: ActiveRequests = Arc::new(Mutex::new(HashMap::new()));
    let active_analysis_runs: ActiveAnalysisRuns = Arc::new(Mutex::new(HashMap::new()));
    let active_response_claims: ActiveResponseClaims = Arc::new(Mutex::new(HashSet::new()));
    let admission = plainsong_lib::admission::AdmissionController::default();

    // Spawn task to flush events from channel to stdout
    tokio::spawn(async move {
        while let Some(line) = event_rx.recv().await {
            let stdout = io::stdout();
            let mut lock = stdout.lock();
            let _ = writeln!(lock, "{}", line);
        }
    });

    // Canonicalize only explicit legacy recording paths before any startup
    // maintenance can inspect, retain, or delete recording audio.
    match plainsong_lib::backfill_recording_audio_for_sidecar(&state).await {
        Ok(inserted) if inserted > 0 => {
            tracing::info!("Backfilled {} legacy recording audio assets", inserted)
        }
        Ok(_) => {}
        Err(error) => tracing::warn!("Recording audio backfill failed: {}", error),
    }

    // The database is opened before the event channel exists, so a vault
    // repair that ran at startup has had nowhere to say so until now.
    plainsong_lib::announce_vault_startup_migration(&state, &handle);

    // If hands-free dictation is enabled, start the idle-time monitor right away so
    // hands-free listening is live as soon as the app launches, not just after the
    // first settings save. No-op (stays stopped) if the setting is off.
    plainsong_lib::reconcile_hands_free_monitor_for_sidecar(&state, &handle).await;

    // Mark recordings stranded mid-capture/mid-transcription by a previous
    // crash as errored, then start the daily storage retention schedule so
    // retention settings are honored without requiring new recordings.
    plainsong_lib::reconcile_interrupted_recordings_for_sidecar(&state, &handle).await;
    plainsong_lib::spawn_storage_retention_maintenance(Arc::clone(&state), handle.clone());

    // Watch for a live call and offer to record it. It only ever emits
    // events; the recording itself waits for the user to accept the offer.
    plainsong_lib::spawn_meeting_call_detection(Arc::clone(&state), handle.clone());

    // Signal readiness to Electron
    eprintln!("[sidecar] ready");

    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    loop {
        let line = match read_bounded_line(&mut stdin, MAX_JSON_RPC_LINE_BYTES) {
            Ok(BoundedLine::Eof) => break,
            Ok(BoundedLine::TooLong) => {
                tracing::warn!(
                    "Rejected JSON-RPC request larger than {} bytes",
                    MAX_JSON_RPC_LINE_BYTES
                );
                write_response(
                    Value::Null,
                    Err(format!(
                        "SIDECAR_SIZE_LIMIT: JSON-RPC request exceeds {} bytes.",
                        MAX_JSON_RPC_LINE_BYTES
                    )),
                );
                continue;
            }
            Ok(BoundedLine::Line(line)) => match String::from_utf8(line) {
                Ok(line) => line,
                Err(error) => {
                    write_response(
                        Value::Null,
                        Err(format!("Parse error: request is not UTF-8 ({error})")),
                    );
                    continue;
                }
            },
            Err(e) => {
                tracing::warn!("stdin read error: {}", e);
                break;
            }
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Invalid JSON-RPC request: {}", e);
                write_response(Value::Null, Err(format!("Parse error: {}", e)));
                continue;
            }
        };

        if request.method == "shutdown" {
            plainsong_lib::begin_sidecar_shutdown(&state);
            write_response(request.id.unwrap_or(Value::Null), Ok(Value::Null));
            let aborted = abort_active_requests(
                &active_requests,
                &active_analysis_runs,
                &active_response_claims,
            );
            if aborted > 0 {
                tracing::info!("Cancelled {aborted} active request(s) during shutdown");
            }
            plainsong_lib::shutdown_for_sidecar().await;
            if let Err(error) = plainsong_lib::sweep_runtime_playback_audio_for_sidecar() {
                tracing::warn!("Playback audio sweep at shutdown failed: {}", error);
            }
            tracing::info!("Received shutdown command, exiting cleanly");
            break;
        }

        if request.method == "$/cancelRequest" {
            let cancelled_id = request.params.get("id").cloned();
            if let Some((cancelled_id, cancelled_key)) = cancelled_id
                .as_ref()
                .and_then(|id| response_key(id).map(|key| (id.clone(), key)))
            {
                if let Some(abort_handle) = active_requests
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&cancelled_key)
                {
                    abort_handle.abort();
                }
                active_analysis_runs
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .retain(|_, (_, _, request_key)| request_key != &cancelled_key);
                if claim_response(&active_response_claims, &cancelled_key) {
                    write_response(cancelled_id, Err("Request cancelled".to_string()));
                }
            }
            write_response(request.id.clone().unwrap_or(Value::Null), Ok(Value::Null));
            continue;
        }

        if request.method == "cancel_analysis_run" {
            let run_id = request
                .params
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(run_id) = run_id {
                let active_run = {
                    active_analysis_runs
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&run_id)
                };
                if let Some((abort_handle, request_id, request_key)) = active_run {
                    abort_handle.abort();
                    active_requests
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&request_key);
                    if claim_response(&active_response_claims, &request_key) {
                        write_response(request_id, Err("Analysis cancelled".to_string()));
                    }
                }
            }
            write_response(request.id.clone().unwrap_or(Value::Null), Ok(Value::Null));
            continue;
        }

        // Dispatch each request on its own task so a slow command (model
        // download, meeting summarization, AI formatting) never blocks reading
        // and handling the next request — most importantly the dictation
        // hotkey's start/stop commands. Shared state is guarded by the mutexes
        // inside AppState, and responses carry their request id, so out-of-order
        // completion is safe for the Electron side.
        let id = request.id.clone().unwrap_or(Value::Null);
        let response_id_for_cancel = id.clone();
        let request_key = response_key(&id);
        let request_key_for_cancel = request_key.clone().unwrap_or_default();
        let admission_lease = match admission.admit(&request.method, &request.params) {
            Ok(lease) => lease,
            Err(error) => {
                write_response(id, Err(error));
                continue;
            }
        };
        let state = Arc::clone(&state);
        let handle = handle.clone();
        let method = request.method;
        let analysis_run_id = request
            .params
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let params = request.params;
        let active_requests_for_task = Arc::clone(&active_requests);
        let active_analysis_runs_for_task = Arc::clone(&active_analysis_runs);
        let active_response_claims_for_task = Arc::clone(&active_response_claims);
        let request_key_for_task = request_key.clone();
        let analysis_run_id_for_task = analysis_run_id.clone();
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _admission_lease = admission_lease;
            let _ = start_rx.await;
            let result = plainsong_lib::dispatch_command(&state, &handle, &method, params).await;
            if let Some(request_key) = request_key_for_task.as_deref() {
                active_requests_for_task
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(request_key);
            }
            if let Some(run_id) = analysis_run_id_for_task {
                active_analysis_runs_for_task
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&run_id);
            }
            if request_key_for_task.as_deref().is_none_or(|request_key| {
                claim_response(&active_response_claims_for_task, request_key)
            }) {
                write_response(id, result);
            }
        });
        if let Some(request_key) = request_key {
            active_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(request_key.clone(), task.abort_handle());
            active_response_claims
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(request_key);
        }
        if let Some(run_id) = analysis_run_id {
            active_analysis_runs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    run_id,
                    (
                        task.abort_handle(),
                        response_id_for_cancel,
                        request_key_for_cancel,
                    ),
                );
        }
        let _ = start_tx.send(());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn oversized_json_rpc_line_is_drained_without_hiding_the_next_request() {
        let mut input = Cursor::new(b"123456789\n{}\n".to_vec());
        assert!(matches!(
            read_bounded_line(&mut input, 8).expect("oversized line"),
            BoundedLine::TooLong
        ));
        let BoundedLine::Line(next) = read_bounded_line(&mut input, 8).expect("next bounded line")
        else {
            panic!("next request should remain readable");
        };
        assert_eq!(next, b"{}");
    }

    #[test]
    fn bounded_json_rpc_line_accepts_exact_limit_and_eof_without_newline() {
        let mut input = Cursor::new(b"12345678".to_vec());
        let BoundedLine::Line(line) = read_bounded_line(&mut input, 8).expect("bounded line")
        else {
            panic!("exactly bounded request should be accepted");
        };
        assert_eq!(line, b"12345678");
        assert!(matches!(
            read_bounded_line(&mut input, 8).expect("eof"),
            BoundedLine::Eof
        ));
    }

    #[tokio::test]
    async fn shutdown_aborts_and_clears_active_requests() {
        let active_requests: ActiveRequests = Arc::new(Mutex::new(HashMap::new()));
        let active_analysis_runs: ActiveAnalysisRuns = Arc::new(Mutex::new(HashMap::new()));
        let active_response_claims: ActiveResponseClaims = Arc::new(Mutex::new(HashSet::new()));
        let request = tokio::spawn(std::future::pending::<()>());
        let analysis = tokio::spawn(std::future::pending::<()>());

        active_requests
            .lock()
            .expect("active request lock")
            .insert("request-1".to_string(), request.abort_handle());
        active_analysis_runs
            .lock()
            .expect("active analysis lock")
            .insert(
                "run-1".to_string(),
                (
                    analysis.abort_handle(),
                    Value::String("response-1".to_string()),
                    "request-1".to_string(),
                ),
            );
        active_response_claims
            .lock()
            .expect("active response claim lock")
            .insert(response_key(&Value::String("request-1".to_string())).expect("response key"));

        assert_eq!(
            abort_active_requests(
                &active_requests,
                &active_analysis_runs,
                &active_response_claims,
            ),
            1
        );
        assert!(request
            .await
            .expect_err("request must be aborted")
            .is_cancelled());
        assert!(analysis
            .await
            .expect_err("analysis must be aborted")
            .is_cancelled());
        assert!(active_requests
            .lock()
            .expect("active request lock")
            .is_empty());
        assert!(active_analysis_runs
            .lock()
            .expect("active analysis lock")
            .is_empty());
        assert!(active_response_claims
            .lock()
            .expect("active response claim lock")
            .is_empty());
    }

    #[test]
    fn response_claim_can_only_be_won_once() {
        let claims: ActiveResponseClaims = Arc::new(Mutex::new(HashSet::new()));
        let key = response_key(&Value::String("request-1".to_string())).expect("response key");
        claims
            .lock()
            .expect("active response claim lock")
            .insert(key.clone());

        assert!(claim_response(&claims, &key));
        assert!(!claim_response(&claims, &key));
    }
}
