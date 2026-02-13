# Security Best Practices Report

Date: 2026-02-13
Scope: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot`

## Executive Summary
Nautilus now enforces local-first remote-provider policy at backend command boundaries, uses keyring-backed runtime credentials for remote LLM providers, adds vault lifecycle commands with SQLCipher-enabled migration hooks, encrypts recording artifacts at rest, constrains export paths, and verifies download integrity metadata for model artifacts. The highest-priority implementation gaps from the prior baseline are closed. Residual risk is concentrated in dependency hygiene (unmaintained crates warnings) and operational hardening (vault unlock abuse controls).

## Critical

### SBP-001 (Closed): Remote provider use was not hard-denied by backend policy
- Impact: Cloud egress for sensitive transcripts could occur against local-first policy.
- Evidence (implemented):
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2648`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2691`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2750`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2801`
- Fix summary: `analyze_recording`, `summarize_recording`, and `extract_action_items` now route through provider selection that hard-denies remote providers when `privacy.remoteProcessingEnabled` is false.

### SBP-002 (Closed): Remote providers could rely on env-only credentials
- Impact: Inconsistent runtime auth and accidental secret leakage patterns.
- Evidence (implemented):
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2668`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/secrets.rs:38`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/llm/openai.rs:21`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/llm/anthropic.rs:22`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/llm/gemini.rs:22`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/llm/cloud.rs:24`
- Fix summary: Backend analysis paths now require provider secrets from keyring and return deterministic credential errors when missing.

### SBP-003 (Closed): At-rest encryption implementation gap
- Impact: Confidential recordings and database state could remain plaintext at rest.
- Evidence (implemented):
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/Cargo.toml:83`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/db.rs:20`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2868`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2931`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:3045`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:3112`
- Fix summary: Added vault lock/unlock/migration commands, SQLCipher feature wiring, recording file encryption (`.enc`), and runtime decrypt path for authorized reads.

## High

### SBP-004 (Closed): Export path boundary enforcement was incomplete
- Impact: Export writes could escape intended storage boundaries.
- Evidence (implemented):
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2571`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:1093`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:1142`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/transcription.rs:189`
- Fix summary: Export targets must be absolute and constrained to configured `privacy.exportRoot` (or approved roots when unset); v1 export now honors explicit target path.

### SBP-005 (Closed): Non-Whisper model downloads lacked integrity verification
- Impact: Tampered model artifacts could be ingested silently.
- Evidence (implemented):
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/download/mod.rs:77`
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/download/mod.rs:457`
- Fix summary: Download manager now extracts SHA-256 digests from response checksum metadata (`x-linked-etag`/`etag`) and fails closed on mismatch.

## Medium

### SBP-006 (Open): Dependency warnings remain in `cargo audit`
- Impact: Long-term maintenance and ecosystem risk from unmaintained crates.
- Evidence:
  - `cargo audit -f /Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/Cargo.lock` (2026-02-13)
- Current status: No unresolved vulnerability remains for `time` after upgrading to `0.3.47`; unmaintained warnings remain and require policy acceptance and periodic review.

### SBP-007 (Open): Vault unlock path has no explicit local brute-force throttling
- Impact: Local attacker with app access can repeatedly attempt passwords.
- Evidence:
  - `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs:2868`
- Recommendation: Add bounded retry delays and lockout telemetry in the vault unlock command path.

## Verification Notes
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `cargo audit -f src-tauri/Cargo.lock`: pass for vulnerabilities, warnings remain

