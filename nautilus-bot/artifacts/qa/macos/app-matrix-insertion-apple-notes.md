# macOS Dictation App Matrix Insertion Capture

Status: PASS
Generated: 2026-05-03T12:45:53.981Z

## Evidence

- Artifact: `artifacts/qa/macos/app-matrix-insertion-apple-notes.json`
- App: `Apple Notes`
- Scratch target: `Apple Notes QA scratch note body`
- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`
- Sample: `Nautilus app matrix smoke 2026-05-03T12-45-53-981Z`

## Checks

- Sidecar command completed: yes
- Frontmost app matched target: yes
- Paste reported by sidecar: yes
- Manual observation accepted: yes

## Manual Observation

- Result: `exact`
- Notes: Computer Use accessibility tree confirmed the exact sample text in the Notes body after packaged sidecar insertion.

## Follow-Up

- Promote the target app in `docs/dictation-app-compatibility-matrix.md` only when this artifact shows `PASS`.
- Close related entries in `docs/dictation-blocked-app-register.md` only when the required evidence matches the entry.
