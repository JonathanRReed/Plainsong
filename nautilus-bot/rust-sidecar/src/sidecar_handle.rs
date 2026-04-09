use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

/// Lightweight handle passed to command functions in sidecar mode.
///
/// Sends JSON-RPC event notifications back to the Electron main process via stdout.
#[derive(Clone)]
pub struct SidecarHandle {
    pub(crate) event_tx: UnboundedSender<String>,
}

impl SidecarHandle {
    pub fn new(event_tx: UnboundedSender<String>) -> Self {
        Self { event_tx }
    }

    /// Emit a named event with a serializable payload.
    /// The Electron IPC bridge reads this from sidecar stdout and forwards it to all renderers.
    pub fn emit<P: Serialize>(&self, event: &str, payload: P) {
        match serde_json::to_value(payload) {
            Ok(value) => {
                let msg = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "method": "event",
                    "params": {
                        "event": event,
                        "payload": value
                    }
                });
                if let Ok(line) = serde_json::to_string(&msg) {
                    let _ = self.event_tx.send(line);
                }
            }
            Err(e) => {
                tracing::warn!(
                    "SidecarHandle::emit failed to serialize payload for '{}': {}",
                    event,
                    e
                );
            }
        }
    }

    /// Emit a window command to tell Electron to show/hide overlay windows.
    pub fn window_command<P: Serialize>(&self, command: &str, payload: P) {
        self.emit(&format!("window:{}", command), payload);
    }
}

/// Trait for emitting frontend events from the native backend into the active shell.
pub trait AppEmitter: Send + Sync {
    fn emit_event<P: Serialize + Clone + Send>(&self, event: &str, payload: P);
}

impl AppEmitter for SidecarHandle {
    fn emit_event<P: Serialize + Clone + Send>(&self, event: &str, payload: P) {
        self.emit(event, payload);
    }
}
