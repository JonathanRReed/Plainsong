/// Nautilus sidecar binary entrypoint.
///
/// Runs the full Nautilus backend as a stdio JSON-RPC server.
/// The Electron main process spawns this binary, writes requests to its stdin,
/// and reads responses/events from its stdout.
///
/// Protocol: newline-delimited JSON-RPC 2.0
///   Request:  { "jsonrpc":"2.0", "id":"<uuid>", "method":"<command>", "params":{...} }
///   Response: { "jsonrpc":"2.0", "id":"<uuid>", "result":<value> }
///   Error:    { "jsonrpc":"2.0", "id":"<uuid>", "error":{"code":-32000,"message":"..."} }
///   Event:    { "jsonrpc":"2.0", "id":null, "method":"event", "params":{"event":"<name>","payload":<value>} }
use nautilus_bot_lib::sidecar_handle::SidecarHandle;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

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

fn main() {
    tracing_subscriber::fmt().with_writer(io::stderr).init();

    let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

    runtime.block_on(async {
        run_sidecar().await;
    });
}

async fn run_sidecar() {
    let state = match nautilus_bot_lib::build_app_state().await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("[sidecar] Failed to initialize state: {}", e);
            std::process::exit(1);
        }
    };

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<String>();
    let handle = SidecarHandle::new(event_tx);

    // Spawn task to flush events from channel to stdout
    tokio::spawn(async move {
        while let Some(line) = event_rx.recv().await {
            let stdout = io::stdout();
            let mut lock = stdout.lock();
            let _ = writeln!(lock, "{}", line);
        }
    });

    // Signal readiness to Electron
    eprintln!("[sidecar] ready");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
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
                tracing::warn!("Invalid JSON-RPC request: {} | input: {}", e, line);
                write_response(Value::Null, Err(format!("Parse error: {}", e)));
                continue;
            }
        };

        if request.method == "shutdown" {
            tracing::info!("Received shutdown command, exiting");
            std::process::exit(0);
        }

        let id = request.id.clone().unwrap_or(Value::Null);
        let result =
            nautilus_bot_lib::dispatch_command(&state, &handle, &request.method, request.params)
                .await;

        write_response(id, result);
    }
}
