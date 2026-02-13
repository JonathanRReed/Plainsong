# Nautilus Audit Baseline

Date: 2026-02-13
Scope: launch-readiness baseline for macOS + Windows

## Command Gates (local execution snapshot)

- `npm test`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `cargo test --tests`: pass
- `cargo audit -f Cargo.lock`: pass for vulnerabilities using policy script `src-tauri/scripts/run-cargo-audit-policy.sh`

## Security Hardening Baseline

1. Backend remote-provider policy enforcement added for all analysis commands.
2. Provider secret handling is keyring-backed in backend command execution path.
3. Vault lifecycle and encryption status commands implemented and exposed to frontend.
4. SQLCipher-enabled build path wired in default features (`src-tauri/Cargo.toml`).
5. Recording artifacts now support authenticated at-rest encryption (`.enc`) and runtime decrypt flow.
6. Export targets are validated against configured safe root / approved roots.
7. Non-Whisper model downloads now validate checksum metadata.
8. Evidence bundle tamper detection tests remain passing.

## Residual Risks / Open Items

### P1

1. Packaged manual QA matrix remains incomplete on both macOS and Windows.
- Exit criteria: complete `/docs/packaged-app-qa-matrix.md` with executed evidence.

### P2

1. `cargo audit` warning set is policy-accepted but non-empty (unmaintained ecosystem dependencies).
- Mitigation: accepted advisory IDs are documented in `src-tauri/audit.toml` and enforced via `src-tauri/scripts/run-cargo-audit-policy.sh`.
- Exit criteria: shrink warning set during dependency refresh cycles.

## Sign-off State

Current state: **NO-GO** until manual QA matrix evidence is attached for both launch OS targets.

