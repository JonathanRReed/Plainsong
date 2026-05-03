# Licensing: Trial expiry + nag behavior

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T22:29:38.559Z

## Evidence
- Command: `cargo test --manifest-path rust-sidecar/Cargo.toml license::tests`
- Result: PASS
- Command: `bun run test -- src/__tests__/entitlement.test.ts src/__tests__/nag-modal.test.tsx`
- Result: PASS

## Verified Behavior
- New local trial state starts with 30 trial days and no nag.
- Expired trial state returns 0 remaining days and requires the nag.
- Malformed trial metadata fails closed.
- Future-dated trial metadata fails closed instead of extending the trial.
- Renderer nag cadence is 24 hours for the first expired week, 12 hours after 7 expired days, and 4 hours after 14 expired days.
