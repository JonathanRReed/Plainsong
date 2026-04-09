# Security: Gatekeeper assessment accepted

Status: BLOCKED
Owner: qa-macos
Generated: 2026-04-09T22:43:47.406Z

## Current Local Observation
- `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app` passed.
- `spctl -a -vv release/mac-arm64/Nautilus.app` still rejects the app with `origin=Nautilus Local Dev`.

## Blocking Detail
- Gatekeeper acceptance remains blocked until Apple release signing and notarization are configured and re-tested on the packaged app.
