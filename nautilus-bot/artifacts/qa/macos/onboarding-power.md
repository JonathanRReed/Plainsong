# Onboarding: Power user advanced settings

Status: PASS
Owner: qa-macos
Evidence: artifacts/qa/macos/onboarding-settings.json

## Command

`bun run qa:packaged:macos:onboarding`

## Verification

- Launched the packaged sidecar from `release/mac-arm64/Nautilus.app`.
- Saved the power-user onboarding profile through the packaged `save_settings` command.
- Read persisted settings back through packaged `get_settings`.
- Verified dedicated Parakeet v3 dictation routing, Distil-Whisper meeting routing, power rewrite profile, selected-text context, auto insertion, long keep-warm, hands-free mode, Smart Format, custom dictation retention, transcript-only meeting storage, and local-only privacy.
- Restored the original raw settings file bytes after the sidecar exited.

## Result

The packaged app persisted every power-profile setting check and restored the original settings file hash.
