# Updates: Stable channel check + install

Status: BLOCKED
Owner: qa-macos
Generated: 2026-05-05T15:17:06.616Z

## Current Local Observation
- Local packaged artifacts build successfully.
- Local packaged update metadata passes `bun run qa:packaged:macos:update-metadata`:
  - `release/mac-arm64/Nautilus.app/Contents/Resources/app-update.yml` is present.
  - `release/latest-mac.yml` points at the generated macOS ZIP artifact.
  - ZIP SHA-512, size, and blockmap evidence match the manifest.
- No signed update feed or prior installed release candidate was exercised in this pass.

## Blocking Detail
- Stable-channel install validation still requires signed release artifacts and a real update flow test.
