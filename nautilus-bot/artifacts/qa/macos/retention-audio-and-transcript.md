# Retention: Meeting audio and transcript delete mode

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T21:24:18.183Z

## Command

`bun run qa:packaged:macos:retention`

## Evidence

- Packaged sidecar launched from `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`.
- Seeded expired completed meeting with `meetingRetentionDeleteMode` set to `audio_and_transcript`.
- Maintenance removed the fixture audio file and deleted the recording plus transcript rows.
- Live database and settings files were restored to their original hashes after the run.

## Artifact

`artifacts/qa/macos/retention-policies.json`
