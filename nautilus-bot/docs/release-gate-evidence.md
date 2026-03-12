# Release Gate Evidence

This file records launch-gate outcomes after the March hardening pass and blocker-first strict run on **2026-03-05**.

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
| `cargo test --lib` | PASS | 118/118 passing |
| `cargo test --tests` | PASS | Includes local provider smoke + performance tests in this environment |
| `cargo check --all-targets` | PASS | No check errors |
| `cargo clippy --all-targets -- -D warnings` | PASS | No lint failures |

## Packaging + Perf Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `node scripts/size-gate.mjs --app src-tauri/target/release/bundle/macos/Nautilus.app --max-mb 35` | PASS | 32.37 MB |
| `node scripts/cold-start-gate.mjs --threshold-ms 2500 --ready-command "pgrep -f '/Nautilus.app/Contents/MacOS/nautilus-bot'" -- <launch-command>` | PASS (historical) | 168 ms on prior baseline run |

## Strict Artifact Gates (Blocked-First Run)

| Command | Outcome | Evidence |
| --- | --- | --- |
| `node scripts/provision-asr-assets.mjs --validate-only --out artifacts/asr-preflight-macos.json` | FAIL (expected) | Missing cloud secrets in strict mode; artifact still generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/asr-preflight.schema.json --file artifacts/asr-preflight-macos.json` | PASS | `artifacts/asr-preflight-macos.json` schema-valid |
| `node scripts/live-cloud-asr-smoke.mjs --out artifacts/cloud-asr-smoke.json` | FAIL | `artifacts/cloud-asr-smoke.blocked.md` (missing `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`) |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-macos.json` | FAIL | `artifacts/benchmark-gates-macos.blocked.md` (baseline file missing) |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-windows.json` | FAIL | `artifacts/benchmark-gates-windows.blocked.md` (baseline file missing) |
| `node scripts/verify-qa-matrix.mjs --file docs/packaged-app-qa-matrix.md` | PASS | Matrix now `49 BLOCKED / 0 PENDING` |
| `node scripts/export-qa-evidence-bundle.mjs --matrix docs/packaged-app-qa-matrix.md --out artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/packaged-qa-evidence-bundle.schema.json --file artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle schema-valid |

## Remaining Launch Blockers

- Packaged QA matrix is now **49/49 BLOCKED** with blocker evidence stubs; no manual PASS evidence yet.
- CP-13 / CP-14 / CP-15 benchmark artifacts are now required in release workflow:
  - `docs/evals/benchmark-run-baseline.json`
  - `docs/evals/benchmark-run-latest-macos.json`
  - `docs/evals/benchmark-run-latest-windows.json`
- Dictation launch now also tracks Phase 0 readiness in:
  - `docs/evals/dictation-parity-launch-scorecard.md`
  - `docs/dictation-app-compatibility-matrix.md`
  - `docs/dictation-blocked-app-register.md`
- Cloud smoke gate is blocked by missing required live keys: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`.
- Signed update/install validation remains blocked by unavailable Apple notarization setup and Windows signing certificate.
