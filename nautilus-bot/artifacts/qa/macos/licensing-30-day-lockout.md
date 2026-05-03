# Licensing: 30-day pro lockout behavior verified

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T22:29:38.559Z

## Evidence
- Command: `cargo test --manifest-path rust-sidecar/Cargo.toml license::tests`
- Result: PASS
- Command: `bun run test -- src/__tests__/entitlement.test.ts src/__tests__/nag-modal.test.tsx`
- Result: PASS

## Verified Behavior
- Trial access is active inside the 30-day window.
- Trial access expires at 30 days when no valid license is present.
- Expired trial state disables Pro entitlement, experimental entitlement, and update access.
- Future-dated and malformed trial anchors fail closed.
- Activation-limit enforcement invalidates otherwise active cached licenses when usage exceeds the tier limit.
