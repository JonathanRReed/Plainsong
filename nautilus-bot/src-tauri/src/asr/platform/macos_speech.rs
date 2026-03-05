use super::{EngineProbe, PlatformEngine};
use anyhow::Result;
use std::path::{Path, PathBuf};

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
use block2::RcBlock;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
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
use std::sync::{Arc, Condvar, Mutex};
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
const HELPER_BASE_NAME: &str = "nautilus-macos-speech-helper";
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
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
                "Rebuild Nautilus on macOS to regenerate the helper sidecar.".to_string(),
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
                "macOS Speech permission is not authorized. Open System Settings > Privacy & Security > Speech Recognition and enable Nautilus."
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
    unsafe {
        let status = SFSpeechRecognizer::authorizationStatus();
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            return Ok(());
        }
        if status == SFSpeechRecognizerAuthorizationStatus::Denied {
            return Err(anyhow::anyhow!(
                "macOS Speech permission denied. Enable Nautilus in System Settings > Privacy & Security > Speech Recognition."
            ));
        }
        if status == SFSpeechRecognizerAuthorizationStatus::Restricted {
            return Err(anyhow::anyhow!(
                "macOS Speech permission is restricted by system policy."
            ));
        }
        if status != SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            return Err(anyhow::anyhow!(
                "Unexpected macOS Speech authorization status: {}",
                status.0
            ));
        }

        if !prompt_if_needed {
            return Err(anyhow::anyhow!(
                "Speech recognition permission has not been granted yet. Enable auto-request permissions or grant it in System Settings > Privacy & Security > Speech Recognition."
            ));
        }

        if !is_packaged_app_context() {
            return Err(anyhow::anyhow!(
                "Speech recognition permission has not been granted yet. Run the packaged Nautilus app and allow Speech Recognition access, then retry."
            ));
        }

        let state = Arc::new((
            Mutex::new(None::<SFSpeechRecognizerAuthorizationStatus>),
            Condvar::new(),
        ));
        let state_clone = Arc::clone(&state);
        let block = RcBlock::new(move |new_status: SFSpeechRecognizerAuthorizationStatus| {
            let (lock, condvar) = &*state_clone;
            if let Ok(mut guard) = lock.lock() {
                *guard = Some(new_status);
                condvar.notify_one();
            }
        });
        SFSpeechRecognizer::requestAuthorization(&block);

        let (lock, condvar) = &*state;
        let guard = lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to acquire macOS Speech authorization lock"))?;
        let (mut guard, wait_result) = condvar
            .wait_timeout_while(guard, Duration::from_secs(20), |current| current.is_none())
            .map_err(|_| anyhow::anyhow!("Failed while waiting for macOS Speech authorization"))?;

        if wait_result.timed_out() {
            return Err(anyhow::anyhow!(
                "Timed out waiting for macOS Speech authorization response."
            ));
        }

        match guard.take() {
            Some(SFSpeechRecognizerAuthorizationStatus::Authorized) => Ok(()),
            Some(SFSpeechRecognizerAuthorizationStatus::Denied) => Err(anyhow::anyhow!(
                "macOS Speech permission denied. Enable Nautilus in System Settings > Privacy & Security > Speech Recognition."
            )),
            Some(SFSpeechRecognizerAuthorizationStatus::Restricted) => Err(anyhow::anyhow!(
                "macOS Speech permission is restricted by system policy."
            )),
            Some(other) => Err(anyhow::anyhow!(
                "macOS Speech authorization was not granted (status: {}).",
                other.0
            )),
            None => Err(anyhow::anyhow!(
                "macOS Speech authorization callback returned no status."
            )),
        }
    }
}

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    nautilus_macos_speech_helper
))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    unsafe {
        let status = SFSpeechRecognizer::authorizationStatus();
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            SpeechAuthorizationStatus::Authorized
        } else if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            SpeechAuthorizationStatus::NotDetermined
        } else if status == SFSpeechRecognizerAuthorizationStatus::Denied {
            SpeechAuthorizationStatus::Denied
        } else if status == SFSpeechRecognizerAuthorizationStatus::Restricted {
            SpeechAuthorizationStatus::Restricted
        } else {
            SpeechAuthorizationStatus::Unknown(status.0)
        }
    }
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
    if let Ok(override_path) = std::env::var("NAUTILUS_MACOS_SPEECH_HELPER_PATH") {
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
        "Expected '{}' or '{}' near app executable or src-tauri/binaries",
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
