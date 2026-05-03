# Capture: Meeting recording with system audio

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T21:56:04.049Z

## Evidence

- Artifact: `artifacts/qa/macos/capture-meeting-system-audio.json`
- Command: `bun run qa:packaged:macos:meeting:system`
- App: `release/mac-arm64/Nautilus.app`
- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`

## Verified Checks

- Packaged sidecar reported meeting setup ready with system audio available.
- Loopback device was detected as `BlackHole 2ch`.
- `start_recording` returned a recording id with `systemAudio: true`.
- Recording overlay entered `recording` with `systemAudioActive: true`.
- `stop_recording` moved the overlay to `transcribing`.
- Recording row was created as `sourceType: meeting`.
- Capture mode was `me_and_them`.
- Recording status moved to `processing`.
- Mixed WAV file was created and had sample data.
- Microphone sidecar WAV file was created and had sample data.
- System sidecar WAV file was created and had sample data.
- Start and processing events were emitted.
- Recording overlay show and hide window commands were emitted.
- Stale meeting route errors were absent after repaired-route processing.
- QA harness restored the live Nautilus database and settings hashes.
- QA harness removed temporary mixed, microphone, and system WAV files after evidence capture.

## Notes

- This row verifies packaged system-audio capture where a loopback device is available.
- It does not promote the 3h soak row or final transcript row; those require a long end-to-end capture run.
