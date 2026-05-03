# Permissions: Microphone Permission Flow

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T19:42:15.603Z

## Evidence

- Command: `bun run qa:packaged:macos:smoke`
- Packaged app: `release/mac-arm64/Nautilus.app`
- Evidence artifact: `artifacts/qa/macos/packaged-smoke.json`

## Result

- `microphoneReady`: `true`
- `microphonePermissionReady`: `true`
- Dictation setup summary: `Dictation route, microphone, and insertion permissions are ready.`
- Meeting setup summary: `Meeting route and system audio are ready for full meeting capture.`

## Scope

This validates the packaged app's ready-permission path on this macOS host. It does not validate first-time system prompt wording on a clean macOS account.
