# Release Gate Evidence

This file records launch-gate outcomes after the March hardening pass on **2026-03-02**.

## Frontend Gates

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm test` | PASS |
| `npm run build` | PASS |
| `npm audit --audit-level=moderate` | PASS |

## Rust Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `cargo test --lib` | PASS | 116/116 passing |
| `cargo test --tests` | PASS | Includes local provider smoke + performance tests in this environment |
| `cargo clippy --all-targets -- -D warnings` | PASS | No lint failures |

## Packaging + Perf Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `node scripts/size-gate.mjs --app src-tauri/target/release/bundle/macos/Nautilus.app --max-mb 35` | PASS | 32.37 MB |
| `node scripts/cold-start-gate.mjs --threshold-ms 2500 --ready-command "pgrep -f '/Nautilus.app/Contents/MacOS/nautilus-bot'" -- <launch-command>` | PASS | 168 ms on local baseline |

## Remaining Launch Blockers

- Packaged QA matrix is still **49/49 PENDING** and requires owner/evidence completion.
- CP-13 / CP-14 / CP-15 benchmark artifacts are now required in release workflow:
  - `docs/evals/benchmark-run-baseline.json`
  - `docs/evals/benchmark-run-latest-macos.json`
  - `docs/evals/benchmark-run-latest-windows.json`
- Signed update/install validation still depends on release secrets and signed artifacts.
