use super::{EngineProbe, PlatformEngine};
use anyhow::Result;
use std::path::Path;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use std::path::PathBuf;

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use anyhow::Context;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use serde::Deserialize;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use std::process::{Command, Output, Stdio};
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use std::time::{Duration, Instant};
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use tokio::process::Command as TokioCommand;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use tokio::sync::{mpsc, oneshot};

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
const HELPER_BASE_NAME: &str = "nautilus-macos-speech-helper";
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
const HELPER_TARGET_NAME: &str = "nautilus-macos-speech-helper-aarch64-apple-darwin";
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
const AUTH_STATUS_ARG: &str = "--authorization-status";
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
const AUTH_REQUEST_ARG: &str = "--request-authorization";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechAuthorizationStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    Unavailable,
    Unknown(isize),
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub fn probe() -> EngineProbe {
    match resolve_helper_binary_path() {
        Ok(path) => EngineProbe {
            engine: PlatformEngine::MacosAppleSpeech,
            ready: true,
            notes: vec![
                "Apple Speech native transcription runtime is available.".to_string(),
                format!("Speech helper path: {}", path.display()),
            ],
        },
        Err(error) => EngineProbe {
            engine: PlatformEngine::MacosAppleSpeech,
            ready: false,
            notes: vec![
                format!(
                    "Apple Speech helper is missing or not executable: {}",
                    error
                ),
                "Rebuild Plainsong on macOS to regenerate the helper sidecar.".to_string(),
            ],
        },
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    not(nautilus_macos_speech_helper)
))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: false,
        notes: vec![
            "Apple Speech helper was not bundled in this build.".to_string(),
            "Rebuild on macOS with Xcode command line tools installed.".to_string(),
        ],
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: false,
        notes: vec!["Requires macOS on Apple Silicon".to_string()],
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
#[derive(Deserialize)]
struct MacosSpeechPayload {
    text: String,
    language: String,
    confidence: Option<f64>,
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
#[derive(Debug, Deserialize)]
struct MacosSpeechAuthorizationPayload {
    status: String,
    code: isize,
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
#[derive(Debug, Clone, Deserialize)]
pub struct LiveSpeechEvent {
    pub event: String,
    pub text: String,
    pub language: String,
    pub confidence: f64,
    #[serde(rename = "isFinal")]
    pub is_final: bool,
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
#[derive(Debug, Clone)]
pub struct LiveSpeechEvent {
    pub event: String,
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub is_final: bool,
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
#[derive(Debug, Clone)]
pub struct LiveSpeechResult {
    pub text: String,
    pub language: String,
    pub confidence: f64,
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
#[derive(Debug, Clone)]
pub struct LiveSpeechResult {
    pub text: String,
    pub language: String,
    pub confidence: f64,
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub struct LiveSpeechAudioSink {
    sender: mpsc::UnboundedSender<Vec<f32>>,
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
pub struct LiveSpeechAudioSink;

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, chunk: Vec<f32>) -> Result<()> {
        self.sender
            .send(chunk)
            .map_err(|_| anyhow::anyhow!("Apple live dictation audio stream is closed"))?;
        Ok(())
    }
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, _chunk: Vec<f32>) -> Result<()> {
        Err(anyhow::anyhow!(
            "Apple live dictation is unavailable in this build"
        ))
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub fn transcribe_file(audio_path: &Path) -> Result<(String, String, f64)> {
    ensure_speech_authorized(false)?;
    let helper = resolve_helper_binary_path()?;
    let timeout = helper_timeout_for_audio(audio_path);
    let output = run_helper_with_timeout(&helper, audio_path, timeout)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        if trimmed.to_ascii_lowercase().contains("not authorized") {
            return Err(anyhow::anyhow!(
                "macOS Speech permission is not authorized. Open System Settings > Privacy & Security > Speech Recognition and enable Plainsong."
            ));
        }
        return Err(anyhow::anyhow!(
            "macOS Speech helper failed: {}",
            if trimmed.is_empty() {
                "unknown error".to_string()
            } else {
                trimmed.to_string()
            }
        ));
    }

    let payload: MacosSpeechPayload =
        serde_json::from_slice(&output.stdout).with_context(|| {
            format!(
                "Failed to parse macOS Speech helper output as JSON: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })?;

    if payload.text.trim().is_empty() {
        return Err(anyhow::anyhow!("macOS Speech returned an empty transcript"));
    }

    Ok((
        payload.text,
        payload.language,
        payload.confidence.unwrap_or(0.0),
    ))
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub async fn start_live_dictation_session(
    sample_rate: u32,
) -> Result<(
    LiveSpeechAudioSink,
    mpsc::UnboundedReceiver<LiveSpeechEvent>,
    oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    ensure_speech_authorized(false)?;
    let helper = resolve_helper_binary_path()?;
    let mut child = TokioCommand::new(&helper)
        .arg("--live")
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "Failed to start macOS Speech live helper at '{}'",
                helper.display()
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("macOS Speech live helper stdin is unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("macOS Speech live helper stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("macOS Speech live helper stderr is unavailable"))?;

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (event_tx, event_rx) = mpsc::unbounded_channel::<LiveSpeechEvent>();
    let (final_tx, final_rx) = oneshot::channel::<Result<LiveSpeechResult, String>>();

    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(chunk) = audio_rx.recv().await {
            let mut bytes = Vec::with_capacity(chunk.len() * std::mem::size_of::<f32>());
            for sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }

            if let Err(error) = stdin.write_all(&bytes).await {
                tracing::warn!("Failed writing Apple live dictation audio chunk: {}", error);
                break;
            }
        }

        let _ = stdin.shutdown().await;
    });

    tokio::spawn(async move {
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut stderr_text = String::new();
            let _ = reader.read_to_string(&mut stderr_text).await;
            stderr_text
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut last_payload: Option<LiveSpeechEvent> = None;
        let mut final_sent = false;
        let mut parse_error: Option<String> = None;
        let mut final_tx = Some(final_tx);

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<LiveSpeechEvent>(&line) {
                Ok(payload) => {
                    if !payload.text.trim().is_empty() {
                        last_payload = Some(payload.clone());
                    }
                    let _ = event_tx.send(payload.clone());
                    if payload.is_final || payload.event == "final" {
                        if let Some(sender) = final_tx.take() {
                            let _ = sender.send(Ok(LiveSpeechResult {
                                text: payload.text,
                                language: payload.language,
                                confidence: payload.confidence,
                            }));
                        }
                        final_sent = true;
                        break;
                    }
                }
                Err(error) => {
                    parse_error = Some(format!(
                        "Failed to parse macOS Speech live helper output: {} ({})",
                        error, line
                    ));
                }
            }
        }

        let child_status = child.wait().await.ok();
        let stderr_text = stderr_task.await.unwrap_or_default();

        if !final_sent {
            if let Some(payload) = last_payload {
                if let Some(sender) = final_tx.take() {
                    let _ = sender.send(Ok(LiveSpeechResult {
                        text: payload.text,
                        language: payload.language,
                        confidence: payload.confidence,
                    }));
                }
            } else {
                let status_note = child_status
                    .and_then(|status| status.code().map(|code| format!("exit code {}", code)))
                    .unwrap_or_else(|| "unknown exit status".to_string());
                let stderr_note = stderr_text.trim();
                let message = parse_error
                    .or_else(|| {
                        if stderr_note.is_empty() {
                            None
                        } else {
                            Some(stderr_note.to_string())
                        }
                    })
                    .unwrap_or_else(|| {
                        format!(
                            "macOS Speech live helper ended without a final transcript ({})",
                            status_note
                        )
                    });
                if let Some(sender) = final_tx.take() {
                    let _ = sender.send(Err(message));
                }
            }
        }
    });

    Ok((LiveSpeechAudioSink { sender: audio_tx }, event_rx, final_rx))
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
pub async fn start_live_dictation_session(
    _sample_rate: u32,
) -> Result<(
    LiveSpeechAudioSink,
    tokio::sync::mpsc::UnboundedReceiver<LiveSpeechEvent>,
    tokio::sync::oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    Err(anyhow::anyhow!(
        "Apple live dictation is unavailable in this build"
    ))
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn helper_timeout_for_audio(audio_path: &Path) -> Duration {
    let duration_secs = hound::WavReader::open(audio_path)
        .ok()
        .map(|reader| {
            let spec = reader.spec();
            if spec.sample_rate == 0 {
                0.0
            } else {
                reader.duration() as f64 / spec.sample_rate as f64
            }
        })
        .unwrap_or(0.0);
    let timeout_secs = ((duration_secs * 3.0).ceil() as u64 + 12).clamp(12, 120);
    Duration::from_secs(timeout_secs)
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn run_helper_with_timeout(helper: &Path, audio_path: &Path, timeout: Duration) -> Result<Output> {
    let mut child = Command::new(helper)
        .arg(audio_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "Failed to start macOS Speech helper at '{}'",
                helper.display()
            )
        })?;

    let started = Instant::now();
    loop {
        if let Some(_status) = child
            .try_wait()
            .with_context(|| "Failed while waiting for macOS Speech helper".to_string())?
        {
            return child
                .wait_with_output()
                .with_context(|| "Failed to capture macOS Speech helper output".to_string());
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow::anyhow!(
                "macOS Speech helper timed out after {}s.",
                timeout.as_secs()
            ));
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub fn ensure_speech_authorized(prompt_if_needed: bool) -> Result<()> {
    if prompt_if_needed && !is_packaged_app_context() {
        return Err(anyhow::anyhow!(
            "Speech recognition permission has not been granted yet. Run the packaged Plainsong app and allow Speech Recognition access, then retry."
        ));
    }

    match helper_authorization_status(prompt_if_needed)? {
        SpeechAuthorizationStatus::Authorized => Ok(()),
        SpeechAuthorizationStatus::NotDetermined => Err(anyhow::anyhow!(
            "Speech recognition permission has not been granted yet. Enable auto-request permissions or grant it in System Settings > Privacy & Security > Speech Recognition."
        )),
        SpeechAuthorizationStatus::Denied => Err(anyhow::anyhow!(
            "macOS Speech permission denied. Enable Plainsong in System Settings > Privacy & Security > Speech Recognition."
        )),
        SpeechAuthorizationStatus::Restricted => Err(anyhow::anyhow!(
            "macOS Speech permission is restricted by system policy."
        )),
        SpeechAuthorizationStatus::Unavailable => Err(anyhow::anyhow!(
            "macOS Apple Speech native engine is unavailable in this build"
        )),
        SpeechAuthorizationStatus::Unknown(code) => Err(anyhow::anyhow!(
            "Unexpected macOS Speech authorization status: {}",
            code
        )),
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    helper_authorization_status(false).unwrap_or(SpeechAuthorizationStatus::Unavailable)
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn is_packaged_app_context() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };

    exe.ancestors().any(|ancestor| {
        ancestor
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
    })
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn helper_authorization_status(prompt_if_needed: bool) -> Result<SpeechAuthorizationStatus> {
    let helper = resolve_helper_binary_path()?;
    let auth_arg = if prompt_if_needed {
        AUTH_REQUEST_ARG
    } else {
        AUTH_STATUS_ARG
    };
    let output = Command::new(&helper)
        .arg(auth_arg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| {
            format!(
                "Failed to start macOS Speech authorization helper at '{}'",
                helper.display()
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(anyhow::anyhow!(
            "macOS Speech authorization helper failed: {}",
            if trimmed.is_empty() {
                "unknown error".to_string()
            } else {
                trimmed.to_string()
            }
        ));
    }

    let payload: MacosSpeechAuthorizationPayload = serde_json::from_slice(&output.stdout)
        .with_context(|| {
            format!(
                "Failed to parse macOS Speech authorization helper output as JSON: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })?;

    Ok(map_authorization_status_payload(&payload))
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn map_authorization_status_payload(
    payload: &MacosSpeechAuthorizationPayload,
) -> SpeechAuthorizationStatus {
    match payload.status.trim() {
        "authorized" => SpeechAuthorizationStatus::Authorized,
        "not_determined" => SpeechAuthorizationStatus::NotDetermined,
        "denied" => SpeechAuthorizationStatus::Denied,
        "restricted" => SpeechAuthorizationStatus::Restricted,
        "unavailable" => SpeechAuthorizationStatus::Unavailable,
        _ => SpeechAuthorizationStatus::Unknown(payload.code),
    }
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
pub fn transcribe_file(_audio_path: &Path) -> Result<(String, String, f64)> {
    Err(anyhow::anyhow!(
        "macOS Apple Speech native engine is unavailable in this build"
    ))
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
pub fn ensure_speech_authorized(_prompt_if_needed: bool) -> Result<()> {
    Err(anyhow::anyhow!(
        "macOS Apple Speech native engine is unavailable in this build"
    ))
}

#[cfg(not(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
)))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    SpeechAuthorizationStatus::Unavailable
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn resolve_helper_binary_path() -> Result<PathBuf> {
    if let Ok(override_path) = std::env::var("PLAINSONG_MACOS_SPEECH_HELPER_PATH") {
        let candidate = PathBuf::from(override_path.trim());
        if is_executable_file(&candidate) {
            return Ok(candidate);
        }
    }

    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(HELPER_BASE_NAME));
            candidates.push(dir.join(HELPER_TARGET_NAME));
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binaries_dir = manifest_dir.join("binaries");
    candidates.push(binaries_dir.join(HELPER_BASE_NAME));
    candidates.push(binaries_dir.join(HELPER_TARGET_NAME));

    for candidate in candidates {
        if is_executable_file(&candidate) {
            return Ok(candidate);
        }
    }

    Err(anyhow::anyhow!(
        "Expected '{}' or '{}' near app executable or rust-sidecar/binaries",
        HELPER_BASE_NAME,
        HELPER_TARGET_NAME
    ))
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            let mode = metadata.permissions().mode();
            return mode & 0o111 != 0;
        }
    }

    false
}

#[cfg(all(
    test,
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
mod tests {
    use super::{
        map_authorization_status_payload, MacosSpeechAuthorizationPayload,
        SpeechAuthorizationStatus,
    };

    #[test]
    fn helper_authorization_payload_maps_known_statuses() {
        assert_eq!(
            map_authorization_status_payload(&MacosSpeechAuthorizationPayload {
                status: "authorized".to_string(),
                code: 3,
            }),
            SpeechAuthorizationStatus::Authorized
        );
        assert_eq!(
            map_authorization_status_payload(&MacosSpeechAuthorizationPayload {
                status: "not_determined".to_string(),
                code: 0,
            }),
            SpeechAuthorizationStatus::NotDetermined
        );
        assert_eq!(
            map_authorization_status_payload(&MacosSpeechAuthorizationPayload {
                status: "denied".to_string(),
                code: 1,
            }),
            SpeechAuthorizationStatus::Denied
        );
        assert_eq!(
            map_authorization_status_payload(&MacosSpeechAuthorizationPayload {
                status: "restricted".to_string(),
                code: 2,
            }),
            SpeechAuthorizationStatus::Restricted
        );
    }

    #[test]
    fn helper_authorization_payload_preserves_unknown_code() {
        assert_eq!(
            map_authorization_status_payload(&MacosSpeechAuthorizationPayload {
                status: "mystery".to_string(),
                code: 99,
            }),
            SpeechAuthorizationStatus::Unknown(99)
        );
    }
}
