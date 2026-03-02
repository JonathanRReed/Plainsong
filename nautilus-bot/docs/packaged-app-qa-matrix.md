# Packaged App QA Matrix (macOS + Windows)

Use this matrix to record packaged-build validation evidence before launch.

## Legend

- Status: `PASS` / `FAIL` / `BLOCKED` / `PENDING`
- Evidence: link to screenshot/video/log or short note

## macOS

| Area | Test Case | Status | Evidence | Owner |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed DMG | PENDING | artifacts/qa/macos/install-fresh-dmg.md | qa-macos |
| Install | Upgrade from previous released version | PENDING | artifacts/qa/macos/install-upgrade.md | qa-macos |
| Security | Gatekeeper assessment accepted | PENDING | artifacts/qa/macos/security-gatekeeper.md | qa-macos |
| Security | Notarization ticket validated | PENDING | artifacts/qa/macos/security-notarization.md | qa-macos |
| Permissions | Microphone permission flow | PENDING | artifacts/qa/macos/permissions-microphone.md | qa-macos |
| Permissions | Accessibility permission flow | PENDING | artifacts/qa/macos/permissions-accessibility.md | qa-macos |
| Onboarding | Normal user onboarding completes and persists baseline settings | PENDING | artifacts/qa/macos/onboarding-normal.md | qa-macos |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | PENDING | artifacts/qa/macos/onboarding-power.md | qa-macos |
| Capture | Dictation hotkey end-to-end | PENDING | artifacts/qa/macos/capture-dictation-hotkey.md | qa-macos |
| Capture | Meeting recording mic-only | PENDING | artifacts/qa/macos/capture-meeting-mic.md | qa-macos |
| Capture | Meeting recording with system audio (where available) | PENDING | artifacts/qa/macos/capture-meeting-system-audio.md | qa-macos |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | PENDING | artifacts/qa/macos/capture-processing-ux.md | qa-macos |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | PENDING | artifacts/qa/macos/capture-soak-3h.md | qa-macos |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | PENDING | artifacts/qa/macos/retention-transcript-only.md | qa-macos |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | PENDING | artifacts/qa/macos/retention-audio-only.md | qa-macos |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | PENDING | artifacts/qa/macos/retention-audio-and-transcript.md | qa-macos |
| Transcription | Whisper transcription end-to-end | PENDING | artifacts/qa/macos/transcription-whisper-e2e.md | qa-macos |
| AI | Local analysis (Ollama) flow | PENDING | artifacts/qa/macos/ai-ollama-local.md | qa-macos |
| Backup | Create backup / restore backup | PENDING | artifacts/qa/macos/backup-create-restore.md | qa-macos |
| Backup | Cloud provider setup + sync + restore (at least one provider) | PENDING | artifacts/qa/macos/backup-cloud-sync.md | qa-macos |
| Updates | Stable channel check + install | PENDING | artifacts/qa/macos/updates-stable-install.md | qa-macos |
| Licensing | Trial expiry + nag behavior | PENDING | artifacts/qa/macos/licensing-trial-expiry.md | qa-macos |
| Licensing | License activation/deactivation | PENDING | artifacts/qa/macos/licensing-activate-deactivate.md | qa-macos |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | PENDING | artifacts/qa/macos/licensing-tier-matrix.md | qa-macos |
| Licensing | 30-day pro lockout behavior verified | PENDING | artifacts/qa/macos/licensing-30-day-lockout.md | qa-macos |

## Windows

| Area | Test Case | Status | Evidence | Owner |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed installer | PENDING | artifacts/qa/windows/install-fresh-installer.md | qa-windows |
| Install | Upgrade from previous released version | PENDING | artifacts/qa/windows/install-upgrade.md | qa-windows |
| Security | Authenticode signature valid | PENDING | artifacts/qa/windows/security-authenticode.md | qa-windows |
| Security | SmartScreen publisher display | PENDING | artifacts/qa/windows/security-smartscreen.md | qa-windows |
| Permissions | Microphone permission flow | PENDING | artifacts/qa/windows/permissions-microphone.md | qa-windows |
| Onboarding | Normal user onboarding completes and persists baseline settings | PENDING | artifacts/qa/windows/onboarding-normal.md | qa-windows |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | PENDING | artifacts/qa/windows/onboarding-power.md | qa-windows |
| Capture | Dictation hotkey end-to-end | PENDING | artifacts/qa/windows/capture-dictation-hotkey.md | qa-windows |
| Capture | Meeting recording mic-only | PENDING | artifacts/qa/windows/capture-meeting-mic.md | qa-windows |
| Capture | Meeting recording with loopback/system audio | PENDING | artifacts/qa/windows/capture-meeting-system-audio.md | qa-windows |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | PENDING | artifacts/qa/windows/capture-processing-ux.md | qa-windows |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | PENDING | artifacts/qa/windows/capture-soak-3h.md | qa-windows |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | PENDING | artifacts/qa/windows/retention-transcript-only.md | qa-windows |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | PENDING | artifacts/qa/windows/retention-audio-only.md | qa-windows |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | PENDING | artifacts/qa/windows/retention-audio-and-transcript.md | qa-windows |
| Transcription | Whisper transcription end-to-end | PENDING | artifacts/qa/windows/transcription-whisper-e2e.md | qa-windows |
| AI | Local/remote analysis configured paths | PENDING | artifacts/qa/windows/ai-analysis-paths.md | qa-windows |
| Backup | Create backup / restore backup | PENDING | artifacts/qa/windows/backup-create-restore.md | qa-windows |
| Backup | Cloud provider setup + sync + restore (at least one provider) | PENDING | artifacts/qa/windows/backup-cloud-sync.md | qa-windows |
| Updates | Stable channel check + install | PENDING | artifacts/qa/windows/updates-stable-install.md | qa-windows |
| Licensing | Trial expiry + nag behavior | PENDING | artifacts/qa/windows/licensing-trial-expiry.md | qa-windows |
| Licensing | License activation/deactivation | PENDING | artifacts/qa/windows/licensing-activate-deactivate.md | qa-windows |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | PENDING | artifacts/qa/windows/licensing-tier-matrix.md | qa-windows |
| Licensing | 30-day pro lockout behavior verified | PENDING | artifacts/qa/windows/licensing-30-day-lockout.md | qa-windows |

## Final QA Signoff

- QA Lead: ____________________
- Date: ____________________
- Overall Result: `PASS` / `FAIL`
- Notes:
