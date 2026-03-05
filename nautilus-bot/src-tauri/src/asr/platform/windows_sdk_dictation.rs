use super::{EngineProbe, PlatformEngine};
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
use anyhow::Context;
use anyhow::Result;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
use serde::Deserialize;
use std::path::Path;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
use std::process::{Child, Command, Output, Stdio};
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
use std::time::{Duration, Instant};

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::WindowsSdkDictation,
        ready: true,
        notes: vec![
            "Windows native dictation runtime is available.".to_string(),
            "Uses System.Speech dictation grammar for file transcription.".to_string(),
        ],
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::WindowsSdkDictation,
        ready: false,
        notes: vec!["Requires Windows x86_64".to_string()],
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
#[derive(Deserialize)]
struct WindowsDictationPayload {
    text: String,
    language: String,
    confidence: Option<f64>,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const WINDOWS_DICTATION_PS1: &str = r#"
param(
  [Parameter(Mandatory = $true)]
  [string]$AudioPath
)

try {
  Add-Type -AssemblyName System.Speech

  if (-not (Test-Path -LiteralPath $AudioPath)) {
    throw "Audio file does not exist: $AudioPath"
  }

  $culture = [System.Globalization.CultureInfo]::CurrentCulture
  $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if ($null -eq $recognizers -or $recognizers.Count -eq 0) {
    throw "No Windows speech recognizers are installed."
  }

  $selectedRecognizer = $recognizers | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
  if ($null -eq $selectedRecognizer) {
    $selectedRecognizer = $recognizers |
      Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName } |
      Select-Object -First 1
  }
  if ($null -eq $selectedRecognizer) {
    $selectedRecognizer = $recognizers | Select-Object -First 1
  }

  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($selectedRecognizer)
  $culture = $selectedRecognizer.Culture
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($AudioPath)

  $parts = New-Object System.Collections.Generic.List[string]
  $sumConfidence = 0.0
  $count = 0

  while ($true) {
    $result = $engine.Recognize()
    if ($null -eq $result) { break }
    if (-not [string]::IsNullOrWhiteSpace($result.Text)) {
      $parts.Add($result.Text.Trim())
      $sumConfidence += [double]$result.Confidence
      $count += 1
    }
  }

  $text = [string]::Join(" ", $parts).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "No speech recognized from audio file."
  }

  $avg = if ($count -gt 0) { $sumConfidence / $count } else { 0.0 }
  [ordered]@{
    text = $text
    language = $culture.Name
    confidence = $avg
  } | ConvertTo-Json -Compress | Write-Output
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
"#;

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn transcribe_file(audio_path: &Path) -> Result<(String, String, f64)> {
    let script_path = std::env::temp_dir().join(format!(
        "nautilus-windows-sdk-dictation-{}.ps1",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&script_path, WINDOWS_DICTATION_PS1).with_context(|| {
        format!(
            "Failed to write Windows dictation helper script '{}'",
            script_path.display()
        )
    })?;

    let script_value = script_path.to_string_lossy().to_string();
    let audio_value = audio_path.to_string_lossy().to_string();
    let args = vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script_value,
        "-AudioPath".to_string(),
        audio_value,
    ];

    let timeout = Duration::from_secs(90);
    let output = if let Ok(child) = Command::new("powershell.exe")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        wait_with_timeout(child, timeout)?
    } else {
        let child = Command::new("pwsh.exe")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| "Failed to start Windows dictation PowerShell runtime".to_string())?;
        wait_with_timeout(child, timeout)?
    };

    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "Windows dictation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let payload: WindowsDictationPayload =
        serde_json::from_slice(&output.stdout).with_context(|| {
            format!(
                "Failed to parse Windows dictation output: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })?;

    Ok((
        payload.text,
        payload.language,
        payload.confidence.unwrap_or(0.0),
    ))
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn wait_with_timeout(mut child: Child, timeout: Duration) -> Result<Output> {
    let started = Instant::now();
    loop {
        if let Some(_status) = child
            .try_wait()
            .with_context(|| "Failed while waiting for Windows dictation runtime".to_string())?
        {
            return child
                .wait_with_output()
                .with_context(|| "Failed to capture Windows dictation runtime output".to_string());
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow::anyhow!(
                "Windows dictation runtime timed out after {}s.",
                timeout.as_secs()
            ));
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub fn transcribe_file(_audio_path: &Path) -> Result<(String, String, f64)> {
    Err(anyhow::anyhow!(
        "Windows SDK dictation engine requires Windows x86_64"
    ))
}
