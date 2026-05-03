# Licensing: License tiers unlock correct features (basic/pro/friends-club)

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T22:29:38.559Z

## Evidence
- Command: `cargo test --manifest-path rust-sidecar/Cargo.toml license::tests`
- Result: PASS
- Command: `bun run test -- src/__tests__/entitlement.test.ts src/__tests__/nag-modal.test.tsx`
- Result: PASS

## Verified Behavior
- Free or expired trial state resolves to the free tier with Pro and Friends Club features disabled.
- Active trial resolves to Pro feature access and update access, with Friends Club features disabled.
- Valid Pro resolves to Pro feature access, update access, and no Friends Club-only cloud sync or priority support.
- Valid Friends Club resolves to Friends tier access, Pro features, cloud sync, and priority support.
- Theme access remains basic for trial users, Pro for valid Pro users, and Friends for valid Friends Club users.
