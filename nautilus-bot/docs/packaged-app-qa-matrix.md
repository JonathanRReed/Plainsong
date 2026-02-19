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
| Capture | Dictation hotkey end-to-end | PENDING |  |  |
| Capture | Meeting recording mic-only | PENDING |  |  |
| Capture | Meeting recording with system audio (where available) | PENDING |  |  |
| Transcription | Whisper transcription end-to-end | PENDING |  |  |
| AI | Local analysis (Ollama) flow | PENDING |  |  |
| Backup | Create backup / restore backup | PENDING |  |  |
| Updates | Stable channel check + install | PENDING |  |  |
| Licensing | Trial expiry + nag behavior | PENDING |  |  |
| Licensing | License activation/deactivation | PENDING |  |  |

## Windows

| Area | Test Case | Status | Evidence | Owner |
| --- | --- | --- | --- | --- |
| Install | Fresh install from signed installer | PENDING |  |  |
| Install | Upgrade from previous released version | PENDING |  |  |
| Security | Authenticode signature valid | PENDING |  |  |
| Security | SmartScreen publisher display | PENDING |  |  |
| Permissions | Microphone permission flow | PENDING |  |  |
| Capture | Dictation hotkey end-to-end | PENDING |  |  |
| Capture | Meeting recording mic-only | PENDING |  |  |
| Capture | Meeting recording with loopback/system audio | PENDING |  |  |
| Transcription | Whisper transcription end-to-end | PENDING |  |  |
| AI | Local/remote analysis configured paths | PENDING |  |  |
| Backup | Create backup / restore backup | PENDING |  |  |
| Updates | Stable channel check + install | PENDING |  |  |
| Licensing | Trial expiry + nag behavior | PENDING |  |  |
| Licensing | License activation/deactivation | PENDING |  |  |

## Final QA Signoff

- QA Lead: ____________________
- Date: ____________________
- Overall Result: `PASS` / `FAIL`
- Notes:
