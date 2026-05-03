# Capture: Dictation hotkey end-to-end

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T22:17:58.744Z

## Evidence

- Artifact: `artifacts/qa/macos/capture-dictation-hotkey.json`
- Command: `bun run qa:packaged:macos:dictation-hotkey`
- App: `release/mac-arm64/Nautilus.app`
- Executable: `release/mac-arm64/Nautilus.app/Contents/MacOS/Nautilus`
- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`

## Verified Checks

- Packaged app launched and registered `Command+Shift+Space`.
- The harness sent the real macOS `Cmd+Shift+Space` key chord to start dictation.
- The harness sent the same key chord to stop dictation.
- Electron QA logs confirmed the shortcut path invoked `start_dictation` and `stop_dictation`.
- A new `sourceType: dictation` recording row was created.
- The dictation recording completed and persisted a transcript row.
- The insertion action was persisted in `clipboard_only` mode.
- Overlay renderers were allowed to read dictation and recording overlay state through IPC.
- Stale Moonshine route errors were absent after route repair.
- QA harness restored the live Nautilus database and settings hashes.

## Notes

- The capture used clipboard-only delivery to avoid writing into the user's foreground app during packaged QA.
- The run exposed and verified repair for native Moonshine not being launch-ready; the packaged app fell back to a stable local route instead of selecting the broken native runtime.
