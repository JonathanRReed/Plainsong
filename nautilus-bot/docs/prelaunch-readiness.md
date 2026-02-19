# NautilusBot Pre-Launch Readiness

This report summarizes the production-readiness audit, remediations completed in code, current risk posture, and final launch recommendation for macOS + Windows.

## Scope

- Target GA platforms: **macOS + Windows**
- Audit mode: full-system code and release-path review with moderate refactors allowed
- Policy: fix all identified issues in scope now

## What Was Audited

- Frontend build/test pipeline and runtime flows
- Rust backend commands, licensing, updates, backup, and secret handling
- Release automation (GitHub workflow + updater signing path)
- Security-sensitive path validation and entitlement logic
- Pre-launch documentation and launch artifact references

## Release Gate Evidence (Automated)

All required automated gates passed locally during this audit cycle:

- `npx tsc --noEmit` ✅
- `npm test` ✅
- `npm run build` ✅
- `cargo fmt --check` ✅
- `cargo clippy --all-targets -- -D warnings` ✅
- `cargo check --all-targets` ✅
- `cargo test --lib` ✅
- `cargo test --tests` ✅
- `./scripts/run-cargo-audit-policy.sh` ✅

See `docs/release-gate-evidence.md` for details.

## Findings and Status

### P0 (fixed)

1. **Secret storage was plaintext file-based with verbose secret logging**
   - Risk: credential disclosure and local persistence in insecure format.
   - Fix: migrated to OS credential storage via `keyring`, with one-time migration from legacy JSON and plaintext logging removal.
   - Files:
     - `src-tauri/src/secrets.rs`

2. **License validity could remain effectively fail-open after stale validations**
   - Risk: invalid entitlement state beyond intended grace period.
   - Fix: tightened validity checks to require active status, activation limits, and grace freshness; fail-closed on malformed trial metadata; explicit invalidation handling from license API responses.
   - Files:
     - `src-tauri/src/license.rs`
     - `src-tauri/src/update/gating.rs`

### P1 (fixed)

1. **Backup ID path traversal surface in backup restore/export/sync paths**
   - Risk: unsafe path resolution from user-provided backup IDs.
   - Fix: added backup ID validation, canonical path enforcement under configured backup root, and cloud-folder validation hardening.
   - Files:
     - `src-tauri/src/backup.rs`

2. **Release builds could ship updater placeholder public key**
   - Risk: updater signature verification misconfiguration in production artifacts.
   - Fix: added CI-time updater pubkey injection step for macOS/Windows/Linux release jobs and created injection script with strict env checks.
   - Files:
     - `.github/workflows/release.yml`
     - `scripts/inject-updater-pubkey.js`
     - `docs/CODE_SIGNING.md`
     - `docs/APPLE_DEVELOPER_SETUP.md`

### P2/P3 (fixed hygiene)

- Removed stale launch artifact references and aligned README to maintained prelaunch docs.
- Removed stale TODO comments from production Lemon Squeezy checkout URLs.

Files:
- `README.md`
- `src/components/activation-modal.tsx`
- `src/components/nag-modal.tsx`

## Residual Risks / External Preconditions

These are not code defects but launch prerequisites:

1. GitHub release secrets must be populated correctly:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PUBLIC_KEY`
   - platform signing secrets (`APPLE_*`, `WINDOWS_CERTIFICATE*`)
2. Manual packaged-app QA matrix execution/signoff is still required.
3. Final Go/No-Go requires human signoff after packaged QA completion.

## Launch Recommendation

- **Current recommendation: NO-GO** until all rows in `docs/packaged-app-qa-matrix.md` are executed and signed off.
- **Expected status after QA completion + secret verification: GO** (automated gates and critical code-level risks are addressed).
