# Capture: Meeting recording mic-only

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T21:55:56.002Z

## Evidence

- Artifact: `artifacts/qa/macos/capture-meeting-mic.json`
- Command: `bun run qa:packaged:macos:meeting:mic`
- App: `release/mac-arm64/Nautilus.app`
- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`

## Verified Checks

- Packaged sidecar reported meeting setup ready.
- `start_recording` returned a recording id.
- Recording overlay entered `recording`.
- `stop_recording` moved the overlay to `transcribing`.
- Recording row was created as `sourceType: meeting`.
- Capture mode was `mic_only`.
- Recording status moved to `processing`.
- Audio path was persisted.
- WAV file existed and had sample data.
- Start and processing events were emitted.
- Recording overlay show and hide window commands were emitted.
- Stale meeting route errors were absent after repaired-route processing.
- QA harness restored the live Nautilus database and settings hashes.
- QA harness removed the temporary audio file after evidence capture.

## Notes

- This row verifies mic-only packaged capture and immediate processing transition through the packaged sidecar.
- It does not promote the broader processing UX row because spinner rendering and detail auto-refresh require renderer-level UI dogfooding.
