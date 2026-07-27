use super::{EngineProbe, PlatformEngine};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use anyhow::Context;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::ffi::OsString;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::path::PathBuf;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::process::{Command, Output, Stdio};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::sync::{Condvar, Mutex, OnceLock};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::time::{Duration, Instant};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, oneshot};

const HELPER_PROTOCOL_VERSION: u32 = 1;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const HELPER_BASE_NAME: &str = "nautilus-macos-speech-helper";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const HELPER_TARGET_NAME: &str = "nautilus-macos-speech-helper-aarch64-apple-darwin";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechAuthorizationStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    Unavailable,
    Unknown(isize),
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppleSpeechReadinessStatus {
    Ready,
    UnsupportedPlatform,
    HelperMissing,
    AuthorizationNotDetermined,
    AuthorizationDenied,
    AuthorizationRestricted,
    UnsupportedLocale,
    OnDeviceUnavailable,
    RecognizerUnavailable,
    UnknownAuthorization,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleSpeechReadiness {
    pub status: AppleSpeechReadinessStatus,
    pub ready: bool,
    pub platform_supported: bool,
    pub helper_present: bool,
    pub authorization: String,
    pub locale: Option<String>,
    pub locale_supported: bool,
    pub on_device_available: bool,
    pub recognizer_available: bool,
    pub message: String,
    pub setup_action: Option<String>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[derive(Default)]
struct ReadinessProbeState {
    in_flight: bool,
    cached: Option<(Instant, AppleSpeechReadiness)>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static READINESS_PROBE_STATE: OnceLock<(Mutex<ReadinessProbeState>, Condvar)> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct HelperErrorPayload {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    code: String,
    message: String,
    retryable: bool,
    #[serde(default)]
    details: BTreeMap<String, String>,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct HelperProbePayload {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    authorization: String,
    authorization_code: isize,
    locale: String,
    locale_supported: bool,
    on_device_available: bool,
    recognizer_available: bool,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[derive(Debug, Clone, Deserialize)]
struct HelperTranscriptPayload {
    text: String,
    language: String,
    confidence: f64,
    is_final: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LiveSpeechEvent {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub event: String,
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub is_final: bool,
}

#[derive(Debug, Clone)]
pub struct LiveSpeechResult {
    pub text: String,
    pub language: String,
    pub confidence: f64,
}

pub struct LiveSpeechAudioSink {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    sender: mpsc::UnboundedSender<Vec<f32>>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, chunk: Vec<f32>) -> Result<()> {
        self.sender.send(chunk).map_err(|_| {
            typed_error(
                "cancelled",
                "Apple live dictation audio stream is closed.",
                false,
            )
        })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, _chunk: Vec<f32>) -> Result<()> {
        Err(typed_error(
            "helper_missing",
            "Apple live dictation is unavailable in this build.",
            false,
        ))
    }
}

fn typed_error(code: &str, message: impl Into<String>, retryable: bool) -> anyhow::Error {
    typed_error_with_details(code, message, retryable, BTreeMap::new())
}

fn typed_error_with_details(
    code: &str,
    message: impl Into<String>,
    retryable: bool,
    details: BTreeMap<String, String>,
) -> anyhow::Error {
    let payload = HelperErrorPayload {
        protocol_version: HELPER_PROTOCOL_VERSION,
        kind: "error".to_string(),
        code: code.to_string(),
        message: message.into(),
        retryable,
        details,
    };
    anyhow::anyhow!(serialize_helper_error(&payload))
}

fn serialize_helper_error(payload: &HelperErrorPayload) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| {
        format!(
            "{{\"protocol_version\":1,\"type\":\"error\",\"code\":\"{}\",\"message\":\"macOS Speech helper error\",\"retryable\":false,\"details\":{{}}}}",
            payload.code
        )
    })
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn parse_helper_error_line(line: &str) -> Option<HelperErrorPayload> {
    let payload = serde_json::from_str::<HelperErrorPayload>(line).ok()?;
    if payload.protocol_version == HELPER_PROTOCOL_VERSION && payload.kind == "error" {
        Some(payload)
    } else {
        None
    }
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn parse_single_payload<T>(bytes: &[u8], expected_kind: &str) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| {
            typed_error(
                "recognition_failed",
                "macOS Speech helper returned no JSON payload.",
                true,
            )
        })?;

    if let Some(error) = parse_helper_error_line(line) {
        return Err(anyhow::anyhow!(serialize_helper_error(&error)));
    }

    let value: serde_json::Value = serde_json::from_str(line).map_err(|error| {
        typed_error(
            "recognition_failed",
            format!("macOS Speech helper returned malformed JSON: {error}"),
            true,
        )
    })?;
    let version = value
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64);
    let kind = value.get("type").and_then(serde_json::Value::as_str);
    if version != Some(HELPER_PROTOCOL_VERSION as u64) || kind != Some(expected_kind) {
        return Err(typed_error_with_details(
            "recognition_failed",
            "macOS Speech helper returned an unexpected protocol payload.",
            true,
            BTreeMap::from([
                ("expected_type".to_string(), expected_kind.to_string()),
                ("payload".to_string(), line.to_string()),
            ]),
        ));
    }

    serde_json::from_value(value).map_err(|error| {
        typed_error(
            "recognition_failed",
            format!("macOS Speech helper payload did not match the Rust contract: {error}"),
            true,
        )
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn human_error_message(error: &anyhow::Error) -> String {
    serde_json::from_str::<HelperErrorPayload>(&error.to_string())
        .map(|payload| format!("{} ({})", payload.message, payload.code))
        .unwrap_or_else(|_| error.to_string())
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn readiness_from_probe(payload: &HelperProbePayload) -> AppleSpeechReadiness {
    let authorization = map_authorization_status_payload(payload);
    let (status, message, setup_action) = match authorization {
        SpeechAuthorizationStatus::NotDetermined => (
            AppleSpeechReadinessStatus::AuthorizationNotDetermined,
            "Speech Recognition permission has not been decided.".to_string(),
            Some("Request Speech Recognition permission from the installed Plainsong app.".to_string()),
        ),
        SpeechAuthorizationStatus::Denied => (
            AppleSpeechReadinessStatus::AuthorizationDenied,
            "Speech Recognition permission is denied.".to_string(),
            Some("Enable Plainsong in System Settings > Privacy & Security > Speech Recognition.".to_string()),
        ),
        SpeechAuthorizationStatus::Restricted => (
            AppleSpeechReadinessStatus::AuthorizationRestricted,
            "Speech Recognition permission is restricted by system policy.".to_string(),
            Some("Ask the device administrator to allow Speech Recognition, or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Unknown(code) => (
            AppleSpeechReadinessStatus::UnknownAuthorization,
            format!("macOS returned an unknown Speech Recognition authorization status ({code})."),
            Some("Re-check Speech Recognition permission or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Unavailable => (
            AppleSpeechReadinessStatus::RuntimeUnavailable,
            "Speech Recognition authorization is unavailable.".to_string(),
            Some("Choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized if !payload.locale_supported => (
            AppleSpeechReadinessStatus::UnsupportedLocale,
            format!("Apple Speech does not support locale '{}'.", payload.locale),
            Some("Choose a supported macOS speech locale or another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized if !payload.on_device_available => (
            AppleSpeechReadinessStatus::OnDeviceUnavailable,
            format!(
                "On-device Apple Speech is unavailable for locale '{}'; server fallback is disabled.",
                payload.locale
            ),
            Some("Choose another on-device dictation provider or a locale with on-device Apple Speech support.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized if !payload.recognizer_available => (
            AppleSpeechReadinessStatus::RecognizerUnavailable,
            "Apple Speech is temporarily unavailable on this Mac.".to_string(),
            Some("Try again after macOS finishes preparing Speech Recognition, or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized => (
            AppleSpeechReadinessStatus::Ready,
            format!(
                "Apple Speech is ready for on-device dictation in locale '{}'.",
                payload.locale
            ),
            None,
        ),
    };

    AppleSpeechReadiness {
        status,
        ready: status == AppleSpeechReadinessStatus::Ready,
        platform_supported: true,
        helper_present: true,
        authorization: payload.authorization.clone(),
        locale: Some(payload.locale.clone()),
        locale_supported: payload.locale_supported,
        on_device_available: payload.on_device_available,
        recognizer_available: payload.recognizer_available,
        message,
        setup_action,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn readiness_from_probe_error(error: &anyhow::Error) -> AppleSpeechReadiness {
    let typed = serde_json::from_str::<HelperErrorPayload>(&error.to_string()).ok();
    let helper_missing = typed
        .as_ref()
        .map(|payload| matches!(payload.code.as_str(), "helper_missing" | "helper_untrusted"))
        .unwrap_or(false);
    AppleSpeechReadiness {
        status: if helper_missing {
            AppleSpeechReadinessStatus::HelperMissing
        } else {
            AppleSpeechReadinessStatus::RuntimeUnavailable
        },
        ready: false,
        platform_supported: true,
        helper_present: !helper_missing,
        authorization: "unavailable".to_string(),
        locale: None,
        locale_supported: false,
        on_device_available: false,
        recognizer_available: false,
        message: typed
            .as_ref()
            .map(|payload| payload.message.clone())
            .unwrap_or_else(|| human_error_message(error)),
        setup_action: Some(if helper_missing {
            "Reinstall Plainsong so the required macOS Speech helper is present and executable."
                .to_string()
        } else {
            "Re-check Apple Speech readiness or choose another dictation provider.".to_string()
        }),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn readiness_with_policy(force_refresh: bool) -> AppleSpeechReadiness {
    const SHARED_RESULT_WINDOW: Duration = Duration::from_millis(500);
    let (mutex, condition) = READINESS_PROBE_STATE
        .get_or_init(|| (Mutex::new(ReadinessProbeState::default()), Condvar::new()));
    let mut state = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    loop {
        if state.in_flight {
            state = condition
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.in_flight {
                if let Some((_, readiness)) = &state.cached {
                    return readiness.clone();
                }
            }
            continue;
        }
        if !force_refresh {
            if let Some((probed_at, readiness)) = &state.cached {
                if probed_at.elapsed() <= SHARED_RESULT_WINDOW {
                    return readiness.clone();
                }
            }
        }
        state.in_flight = true;
        break;
    }
    drop(state);

    let readiness = helper_probe(false)
        .map(|payload| readiness_from_probe(&payload))
        .unwrap_or_else(|error| readiness_from_probe_error(&error));

    let mut state = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.in_flight = false;
    state.cached = Some((Instant::now(), readiness.clone()));
    condition.notify_all();
    readiness
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn readiness() -> AppleSpeechReadiness {
    readiness_with_policy(false)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn fresh_readiness() -> AppleSpeechReadiness {
    readiness_with_policy(true)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn invalidate_readiness_cache() {
    if let Some((mutex, _)) = READINESS_PROBE_STATE.get() {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cached = None;
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn readiness() -> AppleSpeechReadiness {
    AppleSpeechReadiness {
        status: AppleSpeechReadinessStatus::UnsupportedPlatform,
        ready: false,
        platform_supported: false,
        helper_present: false,
        authorization: "unavailable".to_string(),
        locale: None,
        locale_supported: false,
        on_device_available: false,
        recognizer_available: false,
        message: "Apple Speech dictation requires macOS on Apple Silicon.".to_string(),
        setup_action: Some("Choose a dictation provider supported on this platform.".to_string()),
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn fresh_readiness() -> AppleSpeechReadiness {
    readiness()
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn invalidate_readiness_cache() {}

pub fn probe() -> EngineProbe {
    probe_from_readiness(&readiness())
}

pub fn probe_from_readiness(readiness: &AppleSpeechReadiness) -> EngineProbe {
    let mut notes = vec![readiness.message.clone()];
    if let Some(action) = readiness.setup_action.clone() {
        notes.push(action);
    }
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: readiness.ready,
        notes,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn transcribe_file(audio_path: &Path) -> Result<(String, String, f64)> {
    ensure_speech_authorized(false)?;
    let helper = resolve_helper_binary_path()?;
    let mut arguments = vec![
        OsString::from("--transcribe-file"),
        audio_path.as_os_str().to_os_string(),
    ];
    append_configured_locale(&mut arguments);
    let output =
        run_helper_with_timeout(&helper, &arguments, helper_timeout_for_audio(audio_path))?;
    if !output.status.success() {
        return Err(helper_failure_from_output(
            &output,
            "recognition_failed",
            "macOS Speech helper failed during file transcription.",
        ));
    }

    let payload: HelperTranscriptPayload = parse_single_payload(&output.stdout, "transcript")?;
    if !payload.is_final || payload.text.trim().is_empty() {
        return Err(typed_error(
            "recognition_failed",
            "macOS Speech helper returned an empty or non-final transcript.",
            true,
        ));
    }

    Ok((payload.text, payload.language, payload.confidence))
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn transcribe_file(_audio_path: &Path) -> Result<(String, String, f64)> {
    Err(typed_error(
        "helper_missing",
        "macOS Apple Speech native engine is unavailable in this build.",
        false,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub async fn start_live_dictation_session(
    sample_rate: u32,
) -> Result<(
    LiveSpeechAudioSink,
    mpsc::UnboundedReceiver<LiveSpeechEvent>,
    oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    ensure_speech_authorized(false)?;
    let helper = resolve_helper_binary_path()?;
    let mut command = TokioCommand::new(&helper);
    command
        .arg("--live")
        .arg("--sample-rate")
        .arg(sample_rate.to_string());
    if let Some(locale) = configured_locale() {
        command.arg("--locale").arg(locale);
    }
    let mut child = command
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

    let stdin = child.stdin.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stdin is unavailable.",
            false,
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stdout is unavailable.",
            false,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stderr is unavailable.",
            false,
        )
    })?;

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
        let mut final_tx = Some(final_tx);
        let mut terminal_message: Option<String> = None;
        let mut final_sent = false;

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(error) = parse_helper_error_line(&line) {
                terminal_message = Some(serialize_helper_error(&error));
                break;
            }

            match serde_json::from_str::<LiveSpeechEvent>(&line) {
                Ok(payload)
                    if payload.protocol_version == HELPER_PROTOCOL_VERSION
                        && matches!(payload.kind.as_str(), "partial" | "final") =>
                {
                    let is_final =
                        payload.is_final || payload.kind == "final" || payload.event == "final";
                    let _ = event_tx.send(payload.clone());
                    if is_final {
                        if payload.text.trim().is_empty() {
                            terminal_message = Some(
                                typed_error(
                                    "recognition_failed",
                                    "macOS Speech live helper returned an empty final transcript.",
                                    true,
                                )
                                .to_string(),
                            );
                        } else if let Some(sender) = final_tx.take() {
                            let _ = sender.send(Ok(LiveSpeechResult {
                                text: payload.text,
                                language: payload.language,
                                confidence: payload.confidence,
                            }));
                            final_sent = true;
                        }
                        break;
                    }
                }
                Ok(_) => {
                    terminal_message = Some(
                        typed_error(
                            "recognition_failed",
                            "macOS Speech live helper returned an unexpected protocol payload.",
                            true,
                        )
                        .to_string(),
                    );
                    break;
                }
                Err(error) => {
                    terminal_message = Some(
                        typed_error(
                            "recognition_failed",
                            format!("Failed to parse macOS Speech live helper output: {error}"),
                            true,
                        )
                        .to_string(),
                    );
                    break;
                }
            }
        }

        let child_status = child.wait().await.ok();
        let stderr_text = stderr_task.await.unwrap_or_default();
        if !final_sent {
            let status_note = child_status
                .and_then(|status| status.code().map(|code| format!("exit code {code}")))
                .unwrap_or_else(|| "unknown exit status".to_string());
            let message = terminal_message.unwrap_or_else(|| {
                let stderr_text = stderr_text.trim();
                if stderr_text.is_empty() {
                    typed_error(
                        "recognition_failed",
                        format!(
                            "macOS Speech live helper ended without a final transcript ({status_note})."
                        ),
                        true,
                    )
                    .to_string()
                } else {
                    typed_error_with_details(
                        "recognition_failed",
                        "macOS Speech live helper failed without a typed error.",
                        true,
                        BTreeMap::from([("stderr".to_string(), stderr_text.to_string())]),
                    )
                    .to_string()
                }
            });
            if let Some(sender) = final_tx.take() {
                let _ = sender.send(Err(message));
            }
        }
    });

    Ok((LiveSpeechAudioSink { sender: audio_tx }, event_rx, final_rx))
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub async fn start_live_dictation_session(
    _sample_rate: u32,
) -> Result<(
    LiveSpeechAudioSink,
    mpsc::UnboundedReceiver<LiveSpeechEvent>,
    oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    Err(typed_error(
        "helper_missing",
        "Apple live dictation is unavailable in this build.",
        false,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn ensure_speech_authorized(prompt_if_needed: bool) -> Result<()> {
    if prompt_if_needed && !is_packaged_app_context() {
        return Err(typed_error(
            "authorization_not_determined",
            "Speech Recognition permission must be requested from the packaged Plainsong app.",
            false,
        ));
    }

    let payload = helper_probe(prompt_if_needed)?;
    match map_authorization_status_payload(&payload) {
        SpeechAuthorizationStatus::Authorized => {}
        SpeechAuthorizationStatus::NotDetermined => {
            return Err(typed_error(
                "authorization_not_determined",
                "Speech Recognition permission has not been decided. Request it explicitly before transcription.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Denied => {
            return Err(typed_error(
                "authorization_denied",
                "macOS Speech permission is denied. Enable Plainsong in System Settings > Privacy & Security > Speech Recognition.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Restricted => {
            return Err(typed_error(
                "authorization_restricted",
                "macOS Speech permission is restricted by system policy.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Unavailable => {
            return Err(typed_error(
                "helper_missing",
                "macOS Apple Speech native engine is unavailable in this build.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Unknown(code) => {
            return Err(typed_error_with_details(
                "recognition_failed",
                "macOS returned an unknown Speech Recognition authorization status.",
                false,
                BTreeMap::from([("authorization_code".to_string(), code.to_string())]),
            ));
        }
    }

    if !payload.locale_supported {
        return Err(typed_error_with_details(
            "unsupported_locale",
            "Apple Speech does not support the requested locale.",
            false,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    if !payload.on_device_available {
        return Err(typed_error_with_details(
            "on_device_unavailable",
            "On-device Apple Speech recognition is unavailable for this locale or device; server fallback is disabled.",
            false,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    if !payload.recognizer_available {
        return Err(typed_error_with_details(
            "recognition_failed",
            "Apple Speech recognition is temporarily unavailable.",
            true,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    Ok(())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn ensure_speech_authorized(_prompt_if_needed: bool) -> Result<()> {
    Err(typed_error(
        "helper_missing",
        "macOS Apple Speech native engine is unavailable in this build.",
        false,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    helper_probe(false)
        .map(|payload| map_authorization_status_payload(&payload))
        .unwrap_or(SpeechAuthorizationStatus::Unavailable)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    SpeechAuthorizationStatus::Unavailable
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn helper_probe(prompt_if_needed: bool) -> Result<HelperProbePayload> {
    let helper = resolve_helper_binary_path()?;
    let mut arguments = vec![OsString::from(if prompt_if_needed {
        "--request-authorization"
    } else {
        "--probe"
    })];
    append_configured_locale(&mut arguments);
    let timeout = if prompt_if_needed {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(10)
    };
    let output = run_helper_with_timeout(&helper, &arguments, timeout)?;
    if !output.status.success() {
        return Err(helper_failure_from_output(
            &output,
            "recognition_failed",
            "macOS Speech capability probe failed.",
        ));
    }
    parse_single_payload(&output.stdout, "probe")
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn map_authorization_status_payload(payload: &HelperProbePayload) -> SpeechAuthorizationStatus {
    match payload.authorization.trim() {
        "authorized" => SpeechAuthorizationStatus::Authorized,
        "not_determined" => SpeechAuthorizationStatus::NotDetermined,
        "denied" => SpeechAuthorizationStatus::Denied,
        "restricted" => SpeechAuthorizationStatus::Restricted,
        "unavailable" => SpeechAuthorizationStatus::Unavailable,
        _ => SpeechAuthorizationStatus::Unknown(payload.authorization_code),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
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
    Duration::from_secs(((duration_secs * 3.0).ceil() as u64 + 20).clamp(20, 490))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn run_helper_with_timeout(
    helper: &Path,
    arguments: &[OsString],
    timeout: Duration,
) -> Result<Output> {
    let mut child = Command::new(helper)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            typed_error_with_details(
                "helper_missing",
                "Failed to start the required macOS Speech helper.",
                false,
                BTreeMap::from([
                    ("path".to_string(), helper.display().to_string()),
                    ("error".to_string(), error.to_string()),
                ]),
            )
        })?;

    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .with_context(|| "Failed while waiting for the macOS Speech helper")?
            .is_some()
        {
            return child.wait_with_output().map_err(|error| {
                typed_error(
                    "recognition_failed",
                    format!("Failed to capture macOS Speech helper output: {error}"),
                    true,
                )
            });
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(typed_error_with_details(
                "timeout",
                "macOS Speech helper timed out.",
                true,
                BTreeMap::from([("timeout_seconds".to_string(), timeout.as_secs().to_string())]),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn helper_failure_from_output(
    output: &Output,
    fallback_code: &str,
    fallback_message: &str,
) -> anyhow::Error {
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(error) = stdout.lines().rev().find_map(parse_helper_error_line) {
        return anyhow::anyhow!(serialize_helper_error(&error));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut details = BTreeMap::from([(
        "exit_code".to_string(),
        output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string()),
    )]);
    if !stderr.is_empty() {
        details.insert("stderr".to_string(), stderr);
    }
    typed_error_with_details(fallback_code, fallback_message, true, details)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn is_packaged_app_context() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    exe.ancestors().any(|ancestor| {
        ancestor
            .extension()
            .map(|extension| extension.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn configured_locale() -> Option<String> {
    std::env::var("PLAINSONG_APPLE_SPEECH_LOCALE")
        .ok()
        .map(|locale| locale.trim().to_string())
        .filter(|locale| !locale.is_empty())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn append_configured_locale(arguments: &mut Vec<OsString>) {
    if let Some(locale) = configured_locale() {
        arguments.push(OsString::from("--locale"));
        arguments.push(OsString::from(locale));
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn resolve_helper_binary_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|error| {
        typed_error_with_details(
            "helper_missing",
            "Could not locate the running Plainsong sidecar.",
            false,
            BTreeMap::from([("error".to_string(), error.to_string())]),
        )
    })?;
    resolve_helper_binary_path_for_executable(&executable)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn resolve_helper_binary_path_for_executable(executable: &Path) -> Result<PathBuf> {
    if let Some(app_root) = packaged_app_root(executable) {
        let candidate = app_root
            .join("Contents")
            .join("Resources")
            .join("sidecar")
            .join(HELPER_TARGET_NAME);
        validate_packaged_helper(executable, &app_root, &candidate)?;
        return Ok(candidate);
    }

    let mut candidates = Vec::new();
    if let Some(directory) = executable.parent() {
        candidates.push(directory.join(HELPER_BASE_NAME));
        candidates.push(directory.join(HELPER_TARGET_NAME));
    }

    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    candidates.push(binaries_dir.join(HELPER_BASE_NAME));
    candidates.push(binaries_dir.join(HELPER_TARGET_NAME));

    for candidate in &candidates {
        if is_executable_file(candidate) {
            return Ok(candidate.clone());
        }
    }

    Err(typed_error_with_details(
        "helper_missing",
        "The required macOS Speech helper is missing or not executable.",
        false,
        BTreeMap::from([(
            "searched".to_string(),
            candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
        )]),
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_app_root(executable: &Path) -> Option<PathBuf> {
    executable.ancestors().find_map(|ancestor| {
        ancestor
            .extension()
            .filter(|extension| extension.eq_ignore_ascii_case("app"))
            .map(|_| ancestor.to_path_buf())
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn validate_packaged_helper(executable: &Path, app_root: &Path, helper: &Path) -> Result<()> {
    let helper_metadata = std::fs::symlink_metadata(helper).map_err(|error| {
        typed_error_with_details(
            "helper_missing",
            "The packaged macOS Speech helper is missing or unreadable.",
            false,
            BTreeMap::from([
                ("path".to_string(), helper.display().to_string()),
                ("error".to_string(), error.to_string()),
            ]),
        )
    })?;
    if helper_metadata.file_type().is_symlink() || !is_executable_file(helper) {
        return Err(typed_error_with_details(
            "helper_untrusted",
            "The packaged macOS Speech helper is not a trusted executable file.",
            false,
            BTreeMap::from([("path".to_string(), helper.display().to_string())]),
        ));
    }

    let canonical_app_root = app_root.canonicalize().map_err(|error| {
        packaged_helper_trust_error(
            helper,
            format!("Could not resolve the packaged app bundle: {error}"),
        )
    })?;
    let canonical_helper = helper.canonicalize().map_err(|error| {
        packaged_helper_trust_error(
            helper,
            format!("Could not resolve the packaged Speech helper: {error}"),
        )
    })?;
    let expected_directory = canonical_app_root
        .join("Contents")
        .join("Resources")
        .join("sidecar");
    if canonical_helper.parent() != Some(expected_directory.as_path())
        || canonical_helper.file_name().and_then(|name| name.to_str()) != Some(HELPER_TARGET_NAME)
    {
        return Err(packaged_helper_trust_error(
            helper,
            "The macOS Speech helper resolved outside its fixed app-bundle location.",
        ));
    }

    verify_code_signature(executable, "Plainsong sidecar")?;
    verify_code_signature(helper, "macOS Speech helper")?;

    let sidecar_team = code_signature_team_identifier(executable)?;
    let helper_team = code_signature_team_identifier(helper)?;
    if sidecar_team != helper_team {
        return Err(typed_error_with_details(
            "helper_untrusted",
            "The packaged macOS Speech helper is not signed by the same team as the Plainsong sidecar.",
            false,
            BTreeMap::from([
                (
                    "sidecar_team".to_string(),
                    sidecar_team.unwrap_or_else(|| "not set".to_string()),
                ),
                (
                    "helper_team".to_string(),
                    helper_team.unwrap_or_else(|| "not set".to_string()),
                ),
            ]),
        ));
    }

    verify_packaged_helper_entitlements(helper)?;
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn verify_code_signature(path: &Path, label: &str) -> Result<()> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["--verify", "--strict", "--verbose=2"])
        .arg(path)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                path,
                format!("Could not verify the {label} code signature: {error}"),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }

    Err(packaged_helper_trust_error(
        path,
        format!(
            "The {label} code signature is invalid: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn code_signature_team_identifier(path: &Path) -> Result<Option<String>> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["-dv", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                path,
                format!("Could not inspect the code-signing identity: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(packaged_helper_trust_error(
            path,
            format!(
                "Could not inspect the code-signing identity: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let signing_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(signing_text.lines().find_map(|line| {
        line.strip_prefix("TeamIdentifier=")
            .map(str::trim)
            .filter(|team| !team.is_empty() && *team != "not set")
            .map(ToString::to_string)
    }))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn verify_packaged_helper_entitlements(helper: &Path) -> Result<()> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["-d", "--entitlements", ":-"])
        .arg(helper)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                helper,
                format!("Could not inspect the Speech helper entitlements: {error}"),
            )
        })?;
    let entitlements = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    const SPEECH_ENTITLEMENT: &str = "com.apple.security.personal-information.speech-recognition";
    const FORBIDDEN_ENTITLEMENTS: [&str; 7] = [
        "com.apple.security.device.audio-input",
        "com.apple.security.device.microphone",
        "com.apple.security.automation.apple-events",
        "com.apple.security.temporary-exception.apple-events",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
    ];
    if !output.status.success()
        || !entitlements.contains(SPEECH_ENTITLEMENT)
        || FORBIDDEN_ENTITLEMENTS
            .iter()
            .any(|entitlement| entitlements.contains(entitlement))
    {
        return Err(packaged_helper_trust_error(
            helper,
            "The packaged Speech helper does not carry the expected Speech-only entitlement set.",
        ));
    }
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_helper_trust_error(helper: &Path, message: impl Into<String>) -> anyhow::Error {
    typed_error_with_details(
        "helper_untrusted",
        message,
        false,
        BTreeMap::from([("path".to_string(), helper.display().to_string())]),
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        map_authorization_status_payload, parse_helper_error_line, parse_single_payload,
        readiness_from_probe, serialize_helper_error, typed_error, AppleSpeechReadinessStatus,
        HelperErrorPayload, HelperProbePayload, SpeechAuthorizationStatus, HELPER_PROTOCOL_VERSION,
    };
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    use super::{resolve_helper_binary_path_for_executable, HELPER_TARGET_NAME};

    #[test]
    fn helper_authorization_payload_maps_known_statuses() {
        let payload = |authorization: &str, authorization_code| HelperProbePayload {
            protocol_version: HELPER_PROTOCOL_VERSION,
            kind: "probe".to_string(),
            authorization: authorization.to_string(),
            authorization_code,
            locale: "en_US".to_string(),
            locale_supported: true,
            on_device_available: true,
            recognizer_available: true,
        };
        assert_eq!(
            map_authorization_status_payload(&payload("authorized", 3)),
            SpeechAuthorizationStatus::Authorized
        );
        assert_eq!(
            map_authorization_status_payload(&payload("not_determined", 0)),
            SpeechAuthorizationStatus::NotDetermined
        );
        assert_eq!(
            map_authorization_status_payload(&payload("denied", 1)),
            SpeechAuthorizationStatus::Denied
        );
        assert_eq!(
            map_authorization_status_payload(&payload("restricted", 2)),
            SpeechAuthorizationStatus::Restricted
        );
        assert_eq!(
            map_authorization_status_payload(&payload("mystery", 99)),
            SpeechAuthorizationStatus::Unknown(99)
        );
    }

    #[test]
    fn readiness_requires_authorization_locale_and_on_device_capability() {
        let payload = |authorization: &str,
                       locale_supported: bool,
                       on_device_available: bool,
                       recognizer_available: bool| HelperProbePayload {
            protocol_version: HELPER_PROTOCOL_VERSION,
            kind: "probe".to_string(),
            authorization: authorization.to_string(),
            authorization_code: match authorization {
                "not_determined" => 0,
                "denied" => 1,
                "restricted" => 2,
                "authorized" => 3,
                _ => 99,
            },
            locale: "en_US".to_string(),
            locale_supported,
            on_device_available,
            recognizer_available,
        };

        for (probe, expected) in [
            (
                payload("not_determined", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationNotDetermined,
            ),
            (
                payload("denied", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationDenied,
            ),
            (
                payload("restricted", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationRestricted,
            ),
            (
                payload("authorized", false, false, false),
                AppleSpeechReadinessStatus::UnsupportedLocale,
            ),
            (
                payload("authorized", true, false, true),
                AppleSpeechReadinessStatus::OnDeviceUnavailable,
            ),
            (
                payload("authorized", true, true, false),
                AppleSpeechReadinessStatus::RecognizerUnavailable,
            ),
            (
                payload("authorized", true, true, true),
                AppleSpeechReadinessStatus::Ready,
            ),
        ] {
            let readiness = readiness_from_probe(&probe);
            assert_eq!(readiness.status, expected);
            assert_eq!(
                readiness.ready,
                expected == AppleSpeechReadinessStatus::Ready
            );
            assert!(readiness.helper_present);
            assert!(readiness.platform_supported);
        }
    }

    #[test]
    fn rust_typed_errors_are_valid_helper_protocol_json() {
        let error = typed_error("helper_missing", "The required helper is missing.", false);
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed error should be JSON");
        assert_eq!(payload.protocol_version, HELPER_PROTOCOL_VERSION);
        assert_eq!(payload.kind, "error");
        assert_eq!(payload.code, "helper_missing");
        assert!(!payload.retryable);
    }

    #[test]
    fn helper_contract_accepts_every_required_typed_error_code() {
        for code in [
            "helper_missing",
            "authorization_denied",
            "authorization_restricted",
            "authorization_not_determined",
            "unsupported_locale",
            "on_device_unavailable",
            "malformed_request",
            "timeout",
            "cancelled",
            "recognition_failed",
        ] {
            let line = format!(
                "{{\"protocol_version\":1,\"type\":\"error\",\"code\":\"{code}\",\"message\":\"failure\",\"retryable\":false,\"details\":{{}}}}"
            );
            let payload = parse_helper_error_line(&line).expect("valid typed helper error");
            assert_eq!(payload.code, code);
            assert_eq!(serialize_helper_error(&payload), line);
        }
    }

    #[test]
    fn probe_contract_reports_authorization_locale_and_on_device_capability() {
        let json = br#"{"authorization":"not_determined","authorization_code":0,"locale":"en_US","locale_supported":true,"on_device_available":true,"protocol_version":1,"recognizer_available":true,"type":"probe"}"#;
        let probe: HelperProbePayload =
            parse_single_payload(json, "probe").expect("probe should match Rust contract");
        assert_eq!(probe.authorization, "not_determined");
        assert!(probe.locale_supported);
        assert!(probe.on_device_available);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn packaged_test_paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "nautilus-packaged-speech-helper-test-{}",
            uuid::Uuid::new_v4()
        ));
        let sidecar_dir = root
            .join("Plainsong.app")
            .join("Contents")
            .join("Resources")
            .join("sidecar");
        std::fs::create_dir_all(&sidecar_dir).expect("create fake packaged sidecar directory");
        let sidecar = sidecar_dir.join("plainsong-sidecar");
        std::fs::copy(
            std::env::current_exe().expect("resolve test executable"),
            &sidecar,
        )
        .expect("copy signed test executable into fake app");
        let mut sidecar_permissions = std::fs::metadata(&sidecar)
            .expect("inspect copied sidecar")
            .permissions();
        sidecar_permissions.set_mode(sidecar_permissions.mode() | 0o755);
        std::fs::set_permissions(&sidecar, sidecar_permissions)
            .expect("mark copied sidecar executable");
        let helper = sidecar_dir.join(HELPER_TARGET_NAME);
        (root, sidecar, helper)
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_does_not_fall_back_to_build_tree_helper() {
        let (root, sidecar, helper) = packaged_test_paths();
        assert!(!helper.exists());

        let error = resolve_helper_binary_path_for_executable(&sidecar)
            .expect_err("packaged lookup must fail when the bundle helper is absent");
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed helper error");
        assert_eq!(payload.code, "helper_missing");

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_rejects_unsigned_helper_at_fixed_path() {
        use std::os::unix::fs::PermissionsExt;

        let (root, sidecar, helper) = packaged_test_paths();
        std::fs::write(&helper, b"#!/bin/sh\nprintf 'fake helper\\n'\n")
            .expect("write unsigned fake helper");
        let mut permissions = std::fs::metadata(&helper)
            .expect("inspect fake helper")
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(&helper, permissions).expect("mark fake helper executable");

        let error = resolve_helper_binary_path_for_executable(&sidecar)
            .expect_err("unsigned packaged helper must be rejected");
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed helper trust error");
        assert_eq!(payload.code, "helper_untrusted");

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_accepts_signed_helper_at_fixed_path() {
        use std::os::unix::fs::PermissionsExt;

        let (root, sidecar, helper) = packaged_test_paths();
        let compiled_helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(HELPER_TARGET_NAME);
        std::fs::copy(compiled_helper, &helper).expect("copy compiled helper into fake app");
        let mut permissions = std::fs::metadata(&helper)
            .expect("inspect copied helper")
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(&helper, permissions).expect("mark copied helper executable");

        assert_eq!(
            resolve_helper_binary_path_for_executable(&sidecar)
                .expect("signed helper at fixed packaged path should resolve"),
            helper
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn compiled_helper_probe_matches_rust_contract_without_requesting_permission() {
        use super::{resolve_helper_binary_path, run_helper_with_timeout};
        use std::ffi::OsString;
        use std::time::Duration;

        let helper = resolve_helper_binary_path().expect("required helper should exist");
        let output = run_helper_with_timeout(
            &helper,
            &[OsString::from("--probe")],
            Duration::from_secs(10),
        )
        .expect("probe should run");
        assert!(output.status.success());
        let probe: HelperProbePayload =
            parse_single_payload(&output.stdout, "probe").expect("probe contract should parse");
        assert!(!probe.locale.trim().is_empty());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn compiled_helper_rejects_malformed_requests_with_typed_error() {
        use super::{resolve_helper_binary_path, run_helper_with_timeout};
        use std::ffi::OsString;
        use std::time::Duration;

        let helper = resolve_helper_binary_path().expect("required helper should exist");
        let output = run_helper_with_timeout(
            &helper,
            &[OsString::from("--not-a-command")],
            Duration::from_secs(10),
        )
        .expect("malformed request should return a process result");
        assert!(!output.status.success());
        let stdout = String::from_utf8(output.stdout).expect("helper output should be UTF-8");
        let payload = stdout
            .lines()
            .find_map(parse_helper_error_line)
            .expect("typed malformed request error");
        assert_eq!(payload.code, "malformed_request");
    }
}
