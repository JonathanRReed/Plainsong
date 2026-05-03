# Retention: Transcript-only storage

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T21:24:18.183Z

## Command

`bun run qa:packaged:macos:retention`

## Evidence

- Packaged sidecar launched from `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`.
- Seeded completed meeting with `meetingAudioStorageMode` set to `transcript_only`.
- Maintenance removed the fixture audio file, cleared `recording.audioPath`, and preserved the recording and transcript.
- Live database and settings files were restored to their original hashes after the run.

## Artifact

`artifacts/qa/macos/retention-policies.json`
