# Nautilus Launch Audit Report

Date: 2026-02-09
Target: macOS + Windows GA
Policy: strict zero-P1 required for launch

## Findings (ordered by severity)

### P1-1: Rust advisory gate is not currently executable in this environment
- Evidence: `cargo audit` failed twice while fetching RustSec advisory DB due network I/O errors (`https://github.com/RustSec/advisory-db.git`).
- Impact: required dependency-security gate is not complete, so launch sign-off cannot be granted under strict policy.
- Current status: open blocker.
- Owner: release engineering.
- Required close condition: successful `cargo audit` execution with archived output.

### P1-2: Cross-platform runtime matrix incomplete
- Evidence: automated checks pass locally, but full manual runtime matrix is still pending (especially Windows machine scenarios).
- Impact: GA target is macOS + Windows; missing manual runtime evidence leaves material operational risk.
- Current status: open blocker.
- Owner: QA / release.
- Required close condition: attach completed macOS + Windows E2E matrix with pass/fail logs.

### P1-3: Hard-required external dependency flows not fully validated
- Evidence: launch policy marks Ollama/rclone/cloud paths as hard requirements, but this run did not complete manual dependency-ready scenarios end-to-end.
- Impact: integration paths may fail in production onboarding despite core app stability.
- Current status: open blocker.
- Owner: integrations.
- Required close condition: complete and record Ollama + rclone/iCloud readiness tests and failure handling checks.

## Resolved High-Risk Items In This Implementation

- Added backend-mediated `open_recording_audio` command and removed renderer direct `plugin:shell|open` usage.
- Added command input path hardening in `src-tauri/src/lib.rs` for `targetPath`, `data_dir`, `path`, and `recording_path`.
- Reduced Tauri capability surface (`shell`, `fs`, and `process` permissions removed from main capability).
- Reduced runtime plugin surface (removed shell/fs/process plugin init from Tauri builder).
- Enforced warning-free clippy policy (`cargo clippy --all-targets -- -D warnings` now passing locally).
- Updated CI to fail on clippy warnings and run dependency audit commands.
- Updated README and ASR UI text to align with actual production ASR availability.

## Gate Evidence Snapshot

- `npm test`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `npm audit --audit-level=moderate`: pass (0 vulnerabilities)
- `cargo audit`: failed in this environment (network fetch error)

## Go/No-Go

Current decision: **NO-GO** (strict policy not yet satisfied).

Launch can move to GO only after all open P1 items above are closed with evidence.

## Rollback / Containment Guidance

- If production issues are detected after enabling changes, disable release and keep previous stable build artifacts.
- Treat path-validation failures as security events: preserve logs and reject unsafe command inputs rather than fallback behavior.
- Keep ASR scope constrained to Whisper until Parakeet/Canary inference is fully implemented and validated.
