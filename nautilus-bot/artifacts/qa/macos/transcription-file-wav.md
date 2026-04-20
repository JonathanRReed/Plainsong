# Transcription: WAV file transcription through active dictation route

Status: BLOCKED
Owner: qa-macos
Generated: 2026-04-18T22:55:00.000Z

## Blocker
The WAV file transcription product surface exists, but full manual packaged QA execution has not been completed yet.

## Unblock Criteria
- Run a packaged macOS build.
- Select a known-good WAV fixture in Dictation > File Transcription.
- Confirm the active dictation route transcribes the file, displays provider/model/timing metadata, and places the result in the latest transcript panel.
- Confirm empty/invalid file handling shows a recoverable error.
- Attach screenshot/video/log evidence and PASS/FAIL notes.
