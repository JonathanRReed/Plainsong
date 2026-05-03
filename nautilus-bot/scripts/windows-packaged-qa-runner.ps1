param(
  [switch]$ProductOnly,
  [switch]$SkipBenchmark,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$RowsJson = @'
[
  {
    "area": "Install",
    "testCase": "Fresh install from signed installer",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/install-fresh-installer.md",
    "distributionOnly": true,
    "launchBlockingProductRow": false,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Install",
    "testCase": "Upgrade from previous released version",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/install-upgrade.md",
    "distributionOnly": true,
    "launchBlockingProductRow": false,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Security",
    "testCase": "Authenticode signature valid",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/security-authenticode.md",
    "distributionOnly": true,
    "launchBlockingProductRow": false,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Security",
    "testCase": "SmartScreen publisher display",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/security-smartscreen.md",
    "distributionOnly": true,
    "launchBlockingProductRow": false,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Permissions",
    "testCase": "Microphone permission flow",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/permissions-microphone.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Onboarding",
    "testCase": "Normal user onboarding completes and persists baseline settings",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/onboarding-normal.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Onboarding",
    "testCase": "Power user onboarding completes and persists advanced storage/retention settings",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/onboarding-power.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Capture",
    "testCase": "Dictation hotkey end-to-end",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/capture-dictation-hotkey.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Use safe scratch fields only and record target app plus inserted text."
    ]
  },
  {
    "area": "Capture",
    "testCase": "Meeting recording mic-only",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/capture-meeting-mic.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Capture",
    "testCase": "Meeting recording with loopback/system audio",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/capture-meeting-system-audio.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Capture",
    "testCase": "Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/capture-processing-ux.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Capture",
    "testCase": "3h+ meeting soak (mic + system audio) completes transcript end-to-end",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/capture-soak-3h.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Retention",
    "testCase": "Transcript-only storage deletes audio and keeps transcript accessible",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/retention-transcript-only.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Retention",
    "testCase": "Meeting retention `audio_only` clears file/path but keeps transcript",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/retention-audio-only.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Retention",
    "testCase": "Meeting retention `audio_and_transcript` deletes full entity",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/retention-audio-and-transcript.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Transcription",
    "testCase": "Whisper transcription end-to-end",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/transcription-whisper-e2e.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "AI",
    "testCase": "Local/remote analysis configured paths",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/ai-analysis-paths.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Export",
    "testCase": "Standard exports, signed evidence bundle, and built-in templates",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/exports.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Attach export filenames and bundle verification result."
    ]
  },
  {
    "area": "Backup",
    "testCase": "Create backup / restore backup",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/backup-create-restore.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Record backup path, restore target, and cleanup result."
    ]
  },
  {
    "area": "Backup",
    "testCase": "Cloud provider setup + sync + restore (at least one provider)",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/backup-cloud-sync.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Record backup path, restore target, and cleanup result."
    ]
  },
  {
    "area": "Updates",
    "testCase": "Stable channel check + install",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/updates-stable-install.md",
    "distributionOnly": true,
    "launchBlockingProductRow": false,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence."
    ]
  },
  {
    "area": "Licensing",
    "testCase": "Trial expiry + nag behavior",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/licensing-trial-expiry.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Use disposable QA license keys only and never write raw keys into evidence."
    ]
  },
  {
    "area": "Licensing",
    "testCase": "License activation/deactivation",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/licensing-activate-deactivate.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Use disposable QA license keys only and never write raw keys into evidence."
    ]
  },
  {
    "area": "Licensing",
    "testCase": "License tiers unlock correct features (basic/pro/friends-club)",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/licensing-tier-matrix.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Use disposable QA license keys only and never write raw keys into evidence."
    ]
  },
  {
    "area": "Licensing",
    "testCase": "30-day pro lockout behavior verified",
    "status": "BLOCKED",
    "evidence": "artifacts/qa/windows/licensing-30-day-lockout.md",
    "distributionOnly": false,
    "launchBlockingProductRow": true,
    "acceptanceChecks": [
      "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
      "Include build path, Windows version, app version, tester, timestamp, and observed result.",
      "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
      "Use disposable QA license keys only and never write raw keys into evidence."
    ]
  }
]
'@

$Rows = $RowsJson | ConvertFrom-Json
$RequiredReturnArtifacts = @(
  "docs/evals/benchmark-run-packaged-windows.json",
  "artifacts/benchmark-packaged-windows.json",
  "artifacts/benchmark-gates-packaged-windows.json",
  "artifacts/dictation-app-matrix-gate.json",
  "artifacts/packaged-qa-evidence-bundle.json"
)

function Read-StatusFromEvidence {
  param([string]$Path)
  if (!(Test-Path $Path)) {
    return "MISSING"
  }
  $Content = Get-Content -Raw -Path $Path
  if ($Content -match "(?im)^Status:\s*PASS\b") {
    return "PASS"
  }
  if ($Content -match "(?im)^Status:\s*FAIL\b") {
    return "FAIL"
  }
  if ($Content -match "(?im)^Status:\s*BLOCKED\b") {
    return "BLOCKED"
  }
  return "UNKNOWN"
}

function Test-EvidenceMetadata {
  param([string]$Path)
  $RequiredLabels = @(
    "Build path",
    "Windows version",
    "App version",
    "Tester",
    "Timestamp",
    "Observed result"
  )
  $Content = Get-Content -Raw -Path $Path
  $Missing = @()
  foreach ($Label in $RequiredLabels) {
    $EscapedLabel = [Regex]::Escape($Label)
    if ($Content -notmatch "(?im)^\s*-\s*${EscapedLabel}:\s*\S+") {
      $Missing += $Label
    }
  }
  return $Missing
}

function Show-Row {
  param($Row)
  Write-Host ""
  Write-Host ("[{0}] {1}" -f $Row.area, $Row.testCase)
  Write-Host ("Evidence: {0}" -f $Row.evidence)
  foreach ($Check in $Row.acceptanceChecks) {
    Write-Host ("- {0}" -f $Check)
  }
}

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
  throw "Run this script on Windows PowerShell or PowerShell 7 on Windows."
}

$SidecarPath = "release/win-unpacked/resources/sidecar/nautilus-sidecar.exe"
if (!(Test-Path $SidecarPath)) {
  Write-Warning "Packaged sidecar was not found at $SidecarPath. Build or unpack the Windows package before product QA."
}

if (!$SkipBenchmark -and !$ValidateOnly) {
  bun run benchmark:dictation:packaged:windows
}

$RowsToRun = $Rows
if ($ProductOnly) {
  $RowsToRun = $Rows | Where-Object { $_.launchBlockingProductRow -eq $true }
}

if (!$ValidateOnly) {
  foreach ($Row in $RowsToRun) {
    Show-Row $Row
    $Dir = Split-Path -Parent $Row.evidence
    if ($Dir -and !(Test-Path $Dir)) {
      New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    }
    if (!(Test-Path $Row.evidence)) {
      @"
# $($Row.area): $($Row.testCase)

Status: BLOCKED
Owner: qa-windows

## Evidence

- Build path:
- Windows version:
- App version:
- Tester:
- Timestamp:
- Observed result:

## Notes

"@ | Set-Content -Path $Row.evidence -Encoding UTF8
    }
    notepad $Row.evidence
    Read-Host "Update the evidence file, save it, then press Enter"
  }
}

$Failures = @()
foreach ($Row in ($Rows | Where-Object { $_.launchBlockingProductRow -eq $true })) {
  $Status = Read-StatusFromEvidence $Row.evidence
  if ($Status -ne "PASS" -and $Status -ne "FAIL") {
    $Failures += ("{0}: {1} is {2}" -f $Row.testCase, $Row.evidence, $Status)
    continue
  }
  $MissingMetadata = Test-EvidenceMetadata $Row.evidence
  if ($MissingMetadata.Count -gt 0) {
    $Failures += ("{0}: {1} is missing required metadata fields: {2}" -f $Row.testCase, $Row.evidence, ($MissingMetadata -join ", "))
  }
}

Write-Host ""
Write-Host "Required return artifacts:"
foreach ($Artifact in $RequiredReturnArtifacts) {
  $Exists = Test-Path $Artifact
  Write-Host ("- {0}: {1}" -f $Artifact, $(if ($Exists) { "present" } else { "missing" }))
  if (!$Exists) {
    $Failures += ("Required return artifact is missing: {0}" -f $Artifact)
  }
}

if ($Failures.Count -gt 0) {
  $JoinedFailures = $Failures -join [Environment]::NewLine
  Write-Error ("Windows product QA still has unresolved evidence:{0}{1}" -f [Environment]::NewLine, $JoinedFailures)
  exit 1
}

Write-Host "Windows product QA evidence files are resolved. Copy the return artifacts back to the repo and run bun run gate:blockers:refresh."
