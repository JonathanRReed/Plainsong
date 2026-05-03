# Windows Packaged QA Handoff

Status: BLOCKED
Generated: 2026-05-03T15:52:37.456Z

This handoff is generated from `docs/packaged-app-qa-matrix.md`. It defines the Windows-host evidence required before Nautilus can be considered ready, excluding signing and publishing.

## Required Windows Commands

1. Build or unpack the Windows packaged app so `release/win-unpacked/resources/sidecar/nautilus-sidecar.exe` exists.
2. Run `bun run benchmark:dictation:packaged:windows`.
3. Run `pwsh scripts/windows-packaged-qa-runner.ps1 -ProductOnly` to walk product QA rows and validate evidence statuses.
4. Run `bun run gate:app-matrix` after packaged app-matrix evidence is added.
5. Copy the return artifacts listed below back to this repo and run `bun run gate:blockers:refresh`.

## Generated Runner

- Runner: `scripts/windows-packaged-qa-runner.ps1`
- Product-only execution: `pwsh scripts/windows-packaged-qa-runner.ps1 -ProductOnly`
- Validation-only check: `pwsh scripts/windows-packaged-qa-runner.ps1 -ProductOnly -SkipBenchmark -ValidateOnly`

## Summary

- Windows rows: 25
- Product rows: 20
- Distribution rows: 5
- Blocked product rows: 20
- Blocked distribution rows: 5
- QA bundle Windows summary: 0 PASS / 25 BLOCKED / 0 PENDING

## Return Artifacts

- `docs/evals/benchmark-run-packaged-windows.json`
- `artifacts/benchmark-packaged-windows.json`
- `artifacts/benchmark-gates-packaged-windows.json`
- `artifacts/dictation-app-matrix-gate.json`
- `artifacts/packaged-qa-evidence-bundle.json`

## Product QA Rows

- Permissions: Microphone permission flow
  - Evidence: `artifacts/qa/windows/permissions-microphone.md`
  - Open: `notepad artifacts/qa/windows/permissions-microphone.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Onboarding: Normal user onboarding completes and persists baseline settings
  - Evidence: `artifacts/qa/windows/onboarding-normal.md`
  - Open: `notepad artifacts/qa/windows/onboarding-normal.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Onboarding: Power user onboarding completes and persists advanced storage/retention settings
  - Evidence: `artifacts/qa/windows/onboarding-power.md`
  - Open: `notepad artifacts/qa/windows/onboarding-power.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Capture: Dictation hotkey end-to-end
  - Evidence: `artifacts/qa/windows/capture-dictation-hotkey.md`
  - Open: `notepad artifacts/qa/windows/capture-dictation-hotkey.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Use safe scratch fields only and record target app plus inserted text.
- Capture: Meeting recording mic-only
  - Evidence: `artifacts/qa/windows/capture-meeting-mic.md`
  - Open: `notepad artifacts/qa/windows/capture-meeting-mic.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Capture: Meeting recording with loopback/system audio
  - Evidence: `artifacts/qa/windows/capture-meeting-system-audio.md`
  - Open: `notepad artifacts/qa/windows/capture-meeting-system-audio.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Capture: Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh
  - Evidence: `artifacts/qa/windows/capture-processing-ux.md`
  - Open: `notepad artifacts/qa/windows/capture-processing-ux.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Capture: 3h+ meeting soak (mic + system audio) completes transcript end-to-end
  - Evidence: `artifacts/qa/windows/capture-soak-3h.md`
  - Open: `notepad artifacts/qa/windows/capture-soak-3h.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Retention: Transcript-only storage deletes audio and keeps transcript accessible
  - Evidence: `artifacts/qa/windows/retention-transcript-only.md`
  - Open: `notepad artifacts/qa/windows/retention-transcript-only.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Retention: Meeting retention `audio_only` clears file/path but keeps transcript
  - Evidence: `artifacts/qa/windows/retention-audio-only.md`
  - Open: `notepad artifacts/qa/windows/retention-audio-only.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Retention: Meeting retention `audio_and_transcript` deletes full entity
  - Evidence: `artifacts/qa/windows/retention-audio-and-transcript.md`
  - Open: `notepad artifacts/qa/windows/retention-audio-and-transcript.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Transcription: Whisper transcription end-to-end
  - Evidence: `artifacts/qa/windows/transcription-whisper-e2e.md`
  - Open: `notepad artifacts/qa/windows/transcription-whisper-e2e.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- AI: Local/remote analysis configured paths
  - Evidence: `artifacts/qa/windows/ai-analysis-paths.md`
  - Open: `notepad artifacts/qa/windows/ai-analysis-paths.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence.
- Export: Standard exports, signed evidence bundle, and built-in templates
  - Evidence: `artifacts/qa/windows/exports.md`
  - Open: `notepad artifacts/qa/windows/exports.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Attach export filenames and bundle verification result.
- Backup: Create backup / restore backup
  - Evidence: `artifacts/qa/windows/backup-create-restore.md`
  - Open: `notepad artifacts/qa/windows/backup-create-restore.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Record backup path, restore target, and cleanup result.
- Backup: Cloud provider setup + sync + restore (at least one provider)
  - Evidence: `artifacts/qa/windows/backup-cloud-sync.md`
  - Open: `notepad artifacts/qa/windows/backup-cloud-sync.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Record backup path, restore target, and cleanup result.
- Licensing: Trial expiry + nag behavior
  - Evidence: `artifacts/qa/windows/licensing-trial-expiry.md`
  - Open: `notepad artifacts/qa/windows/licensing-trial-expiry.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Use disposable QA license keys only and never write raw keys into evidence.
- Licensing: License activation/deactivation
  - Evidence: `artifacts/qa/windows/licensing-activate-deactivate.md`
  - Open: `notepad artifacts/qa/windows/licensing-activate-deactivate.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Use disposable QA license keys only and never write raw keys into evidence.
- Licensing: License tiers unlock correct features (basic/pro/friends-club)
  - Evidence: `artifacts/qa/windows/licensing-tier-matrix.md`
  - Open: `notepad artifacts/qa/windows/licensing-tier-matrix.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Use disposable QA license keys only and never write raw keys into evidence.
- Licensing: 30-day pro lockout behavior verified
  - Evidence: `artifacts/qa/windows/licensing-30-day-lockout.md`
  - Open: `notepad artifacts/qa/windows/licensing-30-day-lockout.md`
  - Acceptance: Replace the BLOCKED artifact with Status: PASS or Status: FAIL. Include build path, Windows version, app version, tester, timestamp, and observed result. Include screenshots, logs, or exported files where the row requires visual or file evidence. Use disposable QA license keys only and never write raw keys into evidence.

## Distribution Rows

These still matter for release, but the current objective explicitly excludes signing and publishing.

- Install: Fresh install from signed installer
  - Evidence: `artifacts/qa/windows/install-fresh-installer.md`
  - Open: `notepad artifacts/qa/windows/install-fresh-installer.md`
- Install: Upgrade from previous released version
  - Evidence: `artifacts/qa/windows/install-upgrade.md`
  - Open: `notepad artifacts/qa/windows/install-upgrade.md`
- Security: Authenticode signature valid
  - Evidence: `artifacts/qa/windows/security-authenticode.md`
  - Open: `notepad artifacts/qa/windows/security-authenticode.md`
- Security: SmartScreen publisher display
  - Evidence: `artifacts/qa/windows/security-smartscreen.md`
  - Open: `notepad artifacts/qa/windows/security-smartscreen.md`
- Updates: Stable channel check + install
  - Evidence: `artifacts/qa/windows/updates-stable-install.md`
  - Open: `notepad artifacts/qa/windows/updates-stable-install.md`

## Matrix

| Area | Test Case | Status | Scope | Evidence |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed installer | BLOCKED | distribution | `artifacts/qa/windows/install-fresh-installer.md` |
| Install | Upgrade from previous released version | BLOCKED | distribution | `artifacts/qa/windows/install-upgrade.md` |
| Security | Authenticode signature valid | BLOCKED | distribution | `artifacts/qa/windows/security-authenticode.md` |
| Security | SmartScreen publisher display | BLOCKED | distribution | `artifacts/qa/windows/security-smartscreen.md` |
| Permissions | Microphone permission flow | BLOCKED | product | `artifacts/qa/windows/permissions-microphone.md` |
| Onboarding | Normal user onboarding completes and persists baseline settings | BLOCKED | product | `artifacts/qa/windows/onboarding-normal.md` |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | BLOCKED | product | `artifacts/qa/windows/onboarding-power.md` |
| Capture | Dictation hotkey end-to-end | BLOCKED | product | `artifacts/qa/windows/capture-dictation-hotkey.md` |
| Capture | Meeting recording mic-only | BLOCKED | product | `artifacts/qa/windows/capture-meeting-mic.md` |
| Capture | Meeting recording with loopback/system audio | BLOCKED | product | `artifacts/qa/windows/capture-meeting-system-audio.md` |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | BLOCKED | product | `artifacts/qa/windows/capture-processing-ux.md` |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | BLOCKED | product | `artifacts/qa/windows/capture-soak-3h.md` |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | BLOCKED | product | `artifacts/qa/windows/retention-transcript-only.md` |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | BLOCKED | product | `artifacts/qa/windows/retention-audio-only.md` |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | BLOCKED | product | `artifacts/qa/windows/retention-audio-and-transcript.md` |
| Transcription | Whisper transcription end-to-end | BLOCKED | product | `artifacts/qa/windows/transcription-whisper-e2e.md` |
| AI | Local/remote analysis configured paths | BLOCKED | product | `artifacts/qa/windows/ai-analysis-paths.md` |
| Export | Standard exports, signed evidence bundle, and built-in templates | BLOCKED | product | `artifacts/qa/windows/exports.md` |
| Backup | Create backup / restore backup | BLOCKED | product | `artifacts/qa/windows/backup-create-restore.md` |
| Backup | Cloud provider setup + sync + restore (at least one provider) | BLOCKED | product | `artifacts/qa/windows/backup-cloud-sync.md` |
| Updates | Stable channel check + install | BLOCKED | distribution | `artifacts/qa/windows/updates-stable-install.md` |
| Licensing | Trial expiry + nag behavior | BLOCKED | product | `artifacts/qa/windows/licensing-trial-expiry.md` |
| Licensing | License activation/deactivation | BLOCKED | product | `artifacts/qa/windows/licensing-activate-deactivate.md` |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | BLOCKED | product | `artifacts/qa/windows/licensing-tier-matrix.md` |
| Licensing | 30-day pro lockout behavior verified | BLOCKED | product | `artifacts/qa/windows/licensing-30-day-lockout.md` |
