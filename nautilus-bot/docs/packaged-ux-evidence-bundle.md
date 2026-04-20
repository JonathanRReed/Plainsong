# Packaged UX Evidence Bundle

Generated: 2026-04-19T00:04:39.159Z
Overall status: `BLOCKED`

This bundle maps the packaged QA matrix to the P0 Nautilus UX launch gates. It is intentionally blocker-first: a gate can only pass after packaged macOS and Windows evidence exists for the relevant user journey.

## Summary

| Total rows | PASS | FAIL | BLOCKED | PENDING |
| --- | --- | --- | --- | --- |
| 53 | 0 | 0 | 53 | 0 |

## Product Readiness

Status: `BLOCKED`

Do not prioritize signing/notarization work until core app quality, competitor parity, and packaged UX evidence are credible.

Source docs:

- docs/competitor-parity-gates.md
- docs/evals/dictation-parity-launch-scorecard.md
- docs/evals/superwhisper-parity-audit-2026-04-09.md

Current product blockers:

- Competitor parity gates are not PASS; the launch rule in docs/competitor-parity-gates.md is NO-GO if any CP gate is not PASS.
- Dictation parity scorecard still depends on packaged app evidence, app-matrix insertion evidence, provider telemetry proof, command/snippet reliability evidence, language certification, latency trend evidence, and trust/recovery UX proof.
- The app still lacks packaged evidence for broad language breadth, translate-to-English mode, and user-facing file transcription.
- Manual UX screenshots/videos are still missing for the P0 first-run, permissions, recording, processing, transcript, retention, backup, licensing, provider routing, failure recovery, and platform-scope journeys.

Later release blockers:

- Apple signing and notarization remain required before release.
- Windows signing and SmartScreen validation remain required before release.
- Signed updater validation remains required before release.

Optional backlog, not launch blockers:

- Mouse-button shortcut controls remain optional parity backlog per docs/evals/superwhisper-parity-audit-2026-04-09.md; do not block private beta or GA on that item unless the launch scope changes.

## UX Gates

| Gate | Status | Evidence rows | Owner |
| --- | --- | --- | --- |
| First-run orientation | `BLOCKED` | 4 | qa-release |
| OS permissions | `BLOCKED` | 3 | qa-release |
| Recording visibility | `BLOCKED` | 6 | qa-release |
| Meeting processing state | `BLOCKED` | 2 | qa-release |
| Transcript-ready state | `BLOCKED` | 8 | qa-release |
| Retention and delete | `BLOCKED` | 6 | qa-release |
| Backup/restore trust | `BLOCKED` | 4 | qa-release |
| Licensing and trial | `BLOCKED` | 8 | qa-release |
| Provider/model routing | `BLOCKED` | 8 | qa-release |
| Failure recovery | `BLOCKED` | 33 | qa-release |
| Platform scope | `BLOCKED` | 10 | release-owner |
| Install, update, and platform trust | `BLOCKED` | 10 | release-owner |

## Gate Details

### First-run orientation

Status: `BLOCKED`

New user understands what Nautilus does, local-first posture, required permissions, and the fastest safe starting path.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Onboarding | Normal user onboarding completes and persists baseline settings | `BLOCKED` | artifacts/qa/macos/onboarding-normal.md |
| macOS | Onboarding | Power user onboarding completes and persists advanced storage/retention settings | `BLOCKED` | artifacts/qa/macos/onboarding-power.md |
| Windows | Onboarding | Normal user onboarding completes and persists baseline settings | `BLOCKED` | artifacts/qa/windows/onboarding-normal.md |
| Windows | Onboarding | Power user onboarding completes and persists advanced storage/retention settings | `BLOCKED` | artifacts/qa/windows/onboarding-power.md |

### OS permissions

Status: `BLOCKED`

Microphone, accessibility/input, screen/meeting-related permissions, and denial recovery are explained before and after system prompts.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Permissions | Microphone permission flow | `BLOCKED` | artifacts/qa/macos/permissions-microphone.md |
| macOS | Permissions | Accessibility permission flow | `BLOCKED` | artifacts/qa/macos/permissions-accessibility.md |
| Windows | Permissions | Microphone permission flow | `BLOCKED` | artifacts/qa/windows/permissions-microphone.md |

### Recording visibility

Status: `BLOCKED`

User can always tell whether audio is being captured, paused, stopped, or unavailable.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Capture | Dictation hotkey end-to-end | `BLOCKED` | artifacts/qa/macos/capture-dictation-hotkey.md |
| macOS | Capture | Meeting recording mic-only | `BLOCKED` | artifacts/qa/macos/capture-meeting-mic.md |
| macOS | Capture | Meeting recording with system audio (where available) | `BLOCKED` | artifacts/qa/macos/capture-meeting-system-audio.md |
| Windows | Capture | Dictation hotkey end-to-end | `BLOCKED` | artifacts/qa/windows/capture-dictation-hotkey.md |
| Windows | Capture | Meeting recording mic-only | `BLOCKED` | artifacts/qa/windows/capture-meeting-mic.md |
| Windows | Capture | Meeting recording with loopback/system audio | `BLOCKED` | artifacts/qa/windows/capture-meeting-system-audio.md |

### Meeting processing state

Status: `BLOCKED`

On stop, meeting status changes to processing immediately; spinner/detail state updates without manual modal reopen.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | `BLOCKED` | artifacts/qa/macos/capture-processing-ux.md |
| Windows | Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | `BLOCKED` | artifacts/qa/windows/capture-processing-ux.md |

### Transcript-ready state

Status: `BLOCKED`

User can see when transcript is ready, incomplete, failed, or degraded, with recovery guidance.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | `BLOCKED` | artifacts/qa/macos/capture-soak-3h.md |
| macOS | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-whisper-e2e.md |
| macOS | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-translate-english.md |
| macOS | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/macos/transcription-file-wav.md |
| Windows | Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | `BLOCKED` | artifacts/qa/windows/capture-soak-3h.md |
| Windows | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-whisper-e2e.md |
| Windows | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-translate-english.md |
| Windows | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/windows/transcription-file-wav.md |

### Retention and delete

Status: `BLOCKED`

User understands where transcripts and audio live, what delete modes remove, and what remains accessible.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Retention | Transcript-only storage deletes audio and keeps transcript accessible | `BLOCKED` | artifacts/qa/macos/retention-transcript-only.md |
| macOS | Retention | Meeting retention `audio_only` clears file/path but keeps transcript | `BLOCKED` | artifacts/qa/macos/retention-audio-only.md |
| macOS | Retention | Meeting retention `audio_and_transcript` deletes full entity | `BLOCKED` | artifacts/qa/macos/retention-audio-and-transcript.md |
| Windows | Retention | Transcript-only storage deletes audio and keeps transcript accessible | `BLOCKED` | artifacts/qa/windows/retention-transcript-only.md |
| Windows | Retention | Meeting retention `audio_only` clears file/path but keeps transcript | `BLOCKED` | artifacts/qa/windows/retention-audio-only.md |
| Windows | Retention | Meeting retention `audio_and_transcript` deletes full entity | `BLOCKED` | artifacts/qa/windows/retention-audio-and-transcript.md |

### Backup/restore trust

Status: `BLOCKED`

Backup, restore, and cloud sync paths show clear user-facing state and do not overstate hosted storage guarantees.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Backup | Create backup / restore backup | `BLOCKED` | artifacts/qa/macos/backup-create-restore.md |
| macOS | Backup | Cloud provider setup + sync + restore (at least one provider) | `BLOCKED` | artifacts/qa/macos/backup-cloud-sync.md |
| Windows | Backup | Create backup / restore backup | `BLOCKED` | artifacts/qa/windows/backup-create-restore.md |
| Windows | Backup | Cloud provider setup + sync + restore (at least one provider) | `BLOCKED` | artifacts/qa/windows/backup-cloud-sync.md |

### Licensing and trial

Status: `BLOCKED`

Trial, activation, expiry, tier boundaries, and lockout states are visible and recoverable.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Licensing | Trial expiry + nag behavior | `BLOCKED` | artifacts/qa/macos/licensing-trial-expiry.md |
| macOS | Licensing | License activation/deactivation | `BLOCKED` | artifacts/qa/macos/licensing-activate-deactivate.md |
| macOS | Licensing | License tiers unlock correct features (basic/pro/friends-club) | `BLOCKED` | artifacts/qa/macos/licensing-tier-matrix.md |
| macOS | Licensing | 30-day pro lockout behavior verified | `BLOCKED` | artifacts/qa/macos/licensing-30-day-lockout.md |
| Windows | Licensing | Trial expiry + nag behavior | `BLOCKED` | artifacts/qa/windows/licensing-trial-expiry.md |
| Windows | Licensing | License activation/deactivation | `BLOCKED` | artifacts/qa/windows/licensing-activate-deactivate.md |
| Windows | Licensing | License tiers unlock correct features (basic/pro/friends-club) | `BLOCKED` | artifacts/qa/windows/licensing-tier-matrix.md |
| Windows | Licensing | 30-day pro lockout behavior verified | `BLOCKED` | artifacts/qa/windows/licensing-30-day-lockout.md |

### Provider/model routing

Status: `BLOCKED`

Default route is recommended by user job; expert controls do not expose internal inventory as the primary UX.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-whisper-e2e.md |
| macOS | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-translate-english.md |
| macOS | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/macos/transcription-file-wav.md |
| macOS | AI | Local analysis (Ollama) flow | `BLOCKED` | artifacts/qa/macos/ai-ollama-local.md |
| Windows | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-whisper-e2e.md |
| Windows | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-translate-english.md |
| Windows | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/windows/transcription-file-wav.md |
| Windows | AI | Local/remote analysis configured paths | `BLOCKED` | artifacts/qa/windows/ai-analysis-paths.md |

### Failure recovery

Status: `BLOCKED`

Failed setup, failed recording, failed transcription, provider failure, and insert/export failure have clear next steps.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Permissions | Microphone permission flow | `BLOCKED` | artifacts/qa/macos/permissions-microphone.md |
| macOS | Permissions | Accessibility permission flow | `BLOCKED` | artifacts/qa/macos/permissions-accessibility.md |
| macOS | Capture | Dictation hotkey end-to-end | `BLOCKED` | artifacts/qa/macos/capture-dictation-hotkey.md |
| macOS | Capture | Meeting recording mic-only | `BLOCKED` | artifacts/qa/macos/capture-meeting-mic.md |
| macOS | Capture | Meeting recording with system audio (where available) | `BLOCKED` | artifacts/qa/macos/capture-meeting-system-audio.md |
| macOS | Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | `BLOCKED` | artifacts/qa/macos/capture-processing-ux.md |
| macOS | Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | `BLOCKED` | artifacts/qa/macos/capture-soak-3h.md |
| macOS | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-whisper-e2e.md |
| macOS | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/macos/transcription-translate-english.md |
| macOS | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/macos/transcription-file-wav.md |
| macOS | AI | Local analysis (Ollama) flow | `BLOCKED` | artifacts/qa/macos/ai-ollama-local.md |
| macOS | Backup | Create backup / restore backup | `BLOCKED` | artifacts/qa/macos/backup-create-restore.md |
| macOS | Backup | Cloud provider setup + sync + restore (at least one provider) | `BLOCKED` | artifacts/qa/macos/backup-cloud-sync.md |
| macOS | Licensing | Trial expiry + nag behavior | `BLOCKED` | artifacts/qa/macos/licensing-trial-expiry.md |
| macOS | Licensing | License activation/deactivation | `BLOCKED` | artifacts/qa/macos/licensing-activate-deactivate.md |
| macOS | Licensing | License tiers unlock correct features (basic/pro/friends-club) | `BLOCKED` | artifacts/qa/macos/licensing-tier-matrix.md |
| macOS | Licensing | 30-day pro lockout behavior verified | `BLOCKED` | artifacts/qa/macos/licensing-30-day-lockout.md |
| Windows | Permissions | Microphone permission flow | `BLOCKED` | artifacts/qa/windows/permissions-microphone.md |
| Windows | Capture | Dictation hotkey end-to-end | `BLOCKED` | artifacts/qa/windows/capture-dictation-hotkey.md |
| Windows | Capture | Meeting recording mic-only | `BLOCKED` | artifacts/qa/windows/capture-meeting-mic.md |
| Windows | Capture | Meeting recording with loopback/system audio | `BLOCKED` | artifacts/qa/windows/capture-meeting-system-audio.md |
| Windows | Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | `BLOCKED` | artifacts/qa/windows/capture-processing-ux.md |
| Windows | Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | `BLOCKED` | artifacts/qa/windows/capture-soak-3h.md |
| Windows | Transcription | Whisper transcription end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-whisper-e2e.md |
| Windows | Transcription | Translate to English dictation profile end-to-end | `BLOCKED` | artifacts/qa/windows/transcription-translate-english.md |
| Windows | Transcription | WAV file transcription through active dictation route | `BLOCKED` | artifacts/qa/windows/transcription-file-wav.md |
| Windows | AI | Local/remote analysis configured paths | `BLOCKED` | artifacts/qa/windows/ai-analysis-paths.md |
| Windows | Backup | Create backup / restore backup | `BLOCKED` | artifacts/qa/windows/backup-create-restore.md |
| Windows | Backup | Cloud provider setup + sync + restore (at least one provider) | `BLOCKED` | artifacts/qa/windows/backup-cloud-sync.md |
| Windows | Licensing | Trial expiry + nag behavior | `BLOCKED` | artifacts/qa/windows/licensing-trial-expiry.md |
| Windows | Licensing | License activation/deactivation | `BLOCKED` | artifacts/qa/windows/licensing-activate-deactivate.md |
| Windows | Licensing | License tiers unlock correct features (basic/pro/friends-club) | `BLOCKED` | artifacts/qa/windows/licensing-tier-matrix.md |
| Windows | Licensing | 30-day pro lockout behavior verified | `BLOCKED` | artifacts/qa/windows/licensing-30-day-lockout.md |

### Platform scope

Status: `BLOCKED`

Site/app copy names supported platforms and unavailable platforms without ambiguity.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Install | Fresh install from signed DMG | `BLOCKED` | artifacts/qa/macos/install-fresh-dmg.md |
| macOS | Install | Upgrade from previous released version | `BLOCKED` | artifacts/qa/macos/install-upgrade.md |
| macOS | Security | Gatekeeper assessment accepted | `BLOCKED` | artifacts/qa/macos/security-gatekeeper.md |
| macOS | Security | Notarization ticket validated | `BLOCKED` | artifacts/qa/macos/security-notarization.md |
| macOS | Updates | Stable channel check + install | `BLOCKED` | artifacts/qa/macos/updates-stable-install.md |
| Windows | Install | Fresh install from signed installer | `BLOCKED` | artifacts/qa/windows/install-fresh-installer.md |
| Windows | Install | Upgrade from previous released version | `BLOCKED` | artifacts/qa/windows/install-upgrade.md |
| Windows | Security | Authenticode signature valid | `BLOCKED` | artifacts/qa/windows/security-authenticode.md |
| Windows | Security | SmartScreen publisher display | `BLOCKED` | artifacts/qa/windows/security-smartscreen.md |
| Windows | Updates | Stable channel check + install | `BLOCKED` | artifacts/qa/windows/updates-stable-install.md |

### Install, update, and platform trust

Status: `BLOCKED`

Signing, notarization, SmartScreen, fresh install, upgrade, and update channel evidence matches public copy.

| Platform | Area | Test case | Status | Evidence |
| --- | --- | --- | --- | --- |
| macOS | Install | Fresh install from signed DMG | `BLOCKED` | artifacts/qa/macos/install-fresh-dmg.md |
| macOS | Install | Upgrade from previous released version | `BLOCKED` | artifacts/qa/macos/install-upgrade.md |
| macOS | Security | Gatekeeper assessment accepted | `BLOCKED` | artifacts/qa/macos/security-gatekeeper.md |
| macOS | Security | Notarization ticket validated | `BLOCKED` | artifacts/qa/macos/security-notarization.md |
| macOS | Updates | Stable channel check + install | `BLOCKED` | artifacts/qa/macos/updates-stable-install.md |
| Windows | Install | Fresh install from signed installer | `BLOCKED` | artifacts/qa/windows/install-fresh-installer.md |
| Windows | Install | Upgrade from previous released version | `BLOCKED` | artifacts/qa/windows/install-upgrade.md |
| Windows | Security | Authenticode signature valid | `BLOCKED` | artifacts/qa/windows/security-authenticode.md |
| Windows | Security | SmartScreen publisher display | `BLOCKED` | artifacts/qa/windows/security-smartscreen.md |
| Windows | Updates | Stable channel check + install | `BLOCKED` | artifacts/qa/windows/updates-stable-install.md |

## Blockers

- Core product quality and competitor-parity evidence are not launch-ready.
- Manual packaged QA screenshots or videos are not present for the P0 UX journeys.
- Packaged benchmark and app-matrix evidence are still missing for dictation parity claims.
- Apple/Windows signing and notarization remain later release blockers, but they should not be the next engineering focus until product-quality gates improve.

## Next Actions

1. Turn the competitor parity gates into the immediate implementation backlog: CP-01 through CP-15 must move toward PASS before release signing work matters.
2. Run or add packaged-product evidence for dictation reliability, app-matrix insertion, command/snippet success, latency, and recovery UX.
3. Replace BLOCKED UX stubs with PASS or FAIL notes that link screenshots, videos, logs, and defect IDs.

