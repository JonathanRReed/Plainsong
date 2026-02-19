# Release Gate Evidence

This file records automated release-gate command outcomes from the production-readiness audit pass.

## Frontend Gates

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm test` | PASS |
| `npm run build` | PASS |

## Rust Gates

| Command | Outcome |
| --- | --- |
| `cargo fmt --check` | PASS |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo check --all-targets` | PASS |
| `cargo test --lib` | PASS |
| `cargo test --tests` | PASS |

## Security Audit Gate

| Command | Outcome | Notes |
| --- | --- | --- |
| `./scripts/run-cargo-audit-policy.sh` | PASS | Uses policy-managed RustSec ignore list in `src-tauri/audit.toml` |

## Notes

- All gates above were re-run after remediation changes and remained green.
- Integration tests include `tests/asr_runtime_integration.rs` and passed in this cycle.
- Manual packaged-app QA still required before Go decision.
