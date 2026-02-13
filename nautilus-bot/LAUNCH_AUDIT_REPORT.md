# Nautilus Launch Audit Report

Date: 2026-02-13
Target: macOS + Windows GA
Policy: strict launch gate with security-hardening evidence

## Findings (ordered by severity)

### P1-1: Manual packaged QA evidence is still missing for launch platforms
- Evidence: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/docs/packaged-app-qa-matrix.md` rows remain `Pending`.
- Impact: Reliability claims (`>=99%` dictation success and cross-platform parity) are not yet evidence-backed.
- Required close condition: attach completed macOS + Windows run logs/screenshots.

### P2-1: Dependency warning policy accepted but warning count remains non-zero
- Evidence: `cargo audit` passes via `src-tauri/scripts/run-cargo-audit-policy.sh`, but accepted warning list exists in `src-tauri/audit.toml`.
- Impact: Ongoing ecosystem maintenance risk; not an immediate exploitable vulnerability in this scan.
- Required close condition: quarterly reduction of accepted warning set.

## Resolved Security-Critical Items

- Remote analysis egress policy is now backend-enforced with explicit opt-in requirement.
- Provider API credentials in analysis paths now require keyring secrets.
- Vault commands implemented: `unlock_vault`, `lock_vault`, `get_security_status`, `migrate_to_encrypted_storage`.
- SQLCipher-enabled mode wired into default build feature graph.
- Recording artifacts support at-rest encryption and controlled runtime decryption.
- Export path validation now blocks writes outside configured safe boundaries.
- Non-Whisper model downloads verify checksum metadata.
- Windows copy fallback implemented for dictation when system paste is unavailable.

## Gate Evidence Snapshot

- `npm test`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `cargo test --tests`: pass
- `cargo audit -f src-tauri/Cargo.lock`: pass (no unresolved vulnerabilities under policy script)

## Go/No-Go

Current decision: **NO-GO** pending packaged manual QA completion for macOS and Windows.

## Containment / Rollback Notes

- Keep remote processing disabled by default in shipped settings.
- Preserve strict backend denials for unsafe export targets and missing provider secrets.
- If vault migration issues are detected, keep recordings encrypted and block decryption until explicit user unlock succeeds.

