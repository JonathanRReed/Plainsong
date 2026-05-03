# Onboarding: Normal user baseline settings

Status: PASS
Owner: qa-macos
Evidence: artifacts/qa/macos/onboarding-settings.json

## Command

`bun run qa:packaged:macos:onboarding`

## Verification

- Launched the packaged sidecar from `release/mac-arm64/Nautilus.app`.
- Saved the normal onboarding profile through the packaged `save_settings` command.
- Read persisted settings back through packaged `get_settings`.
- Verified dark theme, meeting template, shared Distil-Whisper route, normal dictation profile, paste insertion, local-only privacy, and never-retain defaults.
- Restored the original raw settings file bytes after the sidecar exited.

## Result

The packaged app persisted every normal-profile setting check and restored the original settings file hash.
