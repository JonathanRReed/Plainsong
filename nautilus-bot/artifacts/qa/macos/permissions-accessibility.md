# Permissions: Accessibility Permission Flow

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T19:42:15.603Z

## Evidence

- Command: `bun run qa:packaged:macos:smoke`
- Packaged app: `release/mac-arm64/Nautilus.app`
- Evidence artifact: `artifacts/qa/macos/packaged-smoke.json`

## Result

- `accessibilityReady`: `true`
- `accessibilityTrusted`: `true`
- `postEventReady`: `true`
- `cursorInsertionReady`: `true`
- Preferred insertion strategy: `accessibility_direct_text`
- Available insertion strategies: `accessibility_direct_text`, `simulated_typing`

## Scope

This validates the packaged app's granted-permission path for direct text insertion and native keyboard fallback on this macOS host. It does not validate first-time System Settings prompt wording on a clean macOS account.
