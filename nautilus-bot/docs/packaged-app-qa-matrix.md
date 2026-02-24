# Packaged App QA Matrix (macOS + Windows)

Use this matrix to record packaged-build validation evidence before launch.

## Legend

- Status: `PASS` / `FAIL` / `BLOCKED` / `PENDING`
- Evidence: link to screenshot/video/log or short note

## macOS

| Area | Test Case | Status | Evidence | Owner |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed DMG | PENDING |  |  |
| Install | Upgrade from previous released version | PENDING |  |  |
| Security | Gatekeeper assessment accepted | PENDING |  |  |
| Security | Notarization ticket validated | PENDING |  |  |
| Permissions | Microphone permission flow | PENDING |  |  |
| Permissions | Accessibility permission flow | PENDING |  |  |
| Onboarding | Normal user onboarding completes and persists baseline settings | PENDING |  |  |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | PENDING |  |  |
| Capture | Dictation hotkey end-to-end | PENDING |  |  |
| Capture | Meeting recording mic-only | PENDING |  |  |
| Capture | Meeting recording with system audio (where available) | PENDING |  |  |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | PENDING |  |  |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | PENDING |  |  |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | PENDING |  |  |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | PENDING |  |  |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | PENDING |  |  |
| Transcription | Whisper transcription end-to-end | PENDING |  |  |
| AI | Local analysis (Ollama) flow | PENDING |  |  |
| Backup | Create backup / restore backup | PENDING |  |  |
| Backup | Cloud provider setup + sync + restore (at least one provider) | PENDING |  |  |
| Updates | Stable channel check + install | PENDING |  |  |
| Licensing | Trial expiry + nag behavior | PENDING |  |  |
| Licensing | License activation/deactivation | PENDING |  |  |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | PENDING |  |  |
| Licensing | 30-day pro lockout behavior verified | PENDING |  |  |

## Windows

| Area | Test Case | Status | Evidence | Owner |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed installer | PENDING |  |  |
| Install | Upgrade from previous released version | PENDING |  |  |
| Security | Authenticode signature valid | PENDING |  |  |
| Security | SmartScreen publisher display | PENDING |  |  |
| Permissions | Microphone permission flow | PENDING |  |  |
| Onboarding | Normal user onboarding completes and persists baseline settings | PENDING |  |  |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | PENDING |  |  |
| Capture | Dictation hotkey end-to-end | PENDING |  |  |
| Capture | Meeting recording mic-only | PENDING |  |  |
| Capture | Meeting recording with loopback/system audio | PENDING |  |  |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | PENDING |  |  |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | PENDING |  |  |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | PENDING |  |  |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | PENDING |  |  |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | PENDING |  |  |
| Transcription | Whisper transcription end-to-end | PENDING |  |  |
| AI | Local/remote analysis configured paths | PENDING |  |  |
| Backup | Create backup / restore backup | PENDING |  |  |
| Backup | Cloud provider setup + sync + restore (at least one provider) | PENDING |  |  |
| Updates | Stable channel check + install | PENDING |  |  |
| Licensing | Trial expiry + nag behavior | PENDING |  |  |
| Licensing | License activation/deactivation | PENDING |  |  |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | PENDING |  |  |
| Licensing | 30-day pro lockout behavior verified | PENDING |  |  |

## Final QA Signoff

- QA Lead: ____________________
- Date: ____________________
- Overall Result: `PASS` / `FAIL`
- Notes:
