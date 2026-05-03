# Install: Fresh install from signed DMG

Status: BLOCKED
Owner: qa-macos
Generated: 2026-05-03T15:52:37.638Z

## Current Local Observation
- DMG helper path passes locally and produced `release/Nautilus-1.0.0-arm64.dmg`.
- Fresh-install execution was not performed manually from the packaged DMG in this pass.

## Blocking Detail
- Local packaging is using the `Nautilus Local Dev` identity, not a release-notarized identity.
- This row still needs a real install walkthrough and evidence capture from the packaged DMG.
