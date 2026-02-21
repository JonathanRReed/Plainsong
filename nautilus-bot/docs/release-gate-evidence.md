# Release Gate Evidence

This file records release-gate command outcomes after the all-provider GA hardening pass on **2026-02-21**.

## Frontend Gates

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm test` | PASS |
| `npm run build` | PASS |

## Rust Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `cargo fmt --check` | PASS | Formatting gate is clean after trailing-whitespace cleanup |
| `cargo clippy --all-targets -- -D warnings` | PASS | Includes newly added integration/perf test targets |
| `cargo check --all-targets` | PASS | Compiles all library + test targets |
| `cargo test --lib` | PASS | 81/81 passing |
| `cargo test --tests` | FAIL (expected pre-release) | Blocked by required live cloud secrets (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`) |
| `cargo test --test asr_live_cloud_integration` | FAIL (expected pre-release) | Missing cloud secrets in local env |
| `cargo test --test asr_local_performance_gate` | FAIL (expected pre-release) | Missing required local model assets (first failure observed: Parakeet) |
| `node scripts/cold-start-gate.mjs --threshold-ms 2500 -- <cold-start-command>` | PENDING | Gate utility added; requires execution on M1-class macOS baseline |

## Cloud Live-Test Gate

| Command | Outcome | Notes |
| --- | --- | --- |
| `node scripts/live-cloud-asr-smoke.mjs` | FAIL (expected pre-release) | Script now fails fast with explicit missing-secret list |

## Workflow Enforcement Added

- `.github/workflows/release.yml` now includes:
  - Fail-fast validation of required cloud secrets in `prepare`.
  - Mandatory live cloud smoke run (`scripts/live-cloud-asr-smoke.mjs`) with artifact upload.
  - Rust live cloud integration test gate in macOS build.
  - Rust local ASR performance gate (`RTF <= 1.2`) in macOS build.

## Notes

- Automated gate infrastructure is implemented and wired.
- Release remains blocked until secrets are provisioned and local model assets are present on gate runners.
- Manual packaged-app QA is still required before Go/No-Go.
