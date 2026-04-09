# Release Gate Evidence

This file records launch-gate outcomes after the March hardening pass, the blocker-first strict run on **2026-03-05**, the local ship-path verification refresh on **2026-03-20**, and the Electron release-path refresh on **2026-04-09**.

## Frontend Gates

| Command | Outcome |
| --- | --- |
| `bun run lint` | PASS |
| `bun run typecheck` | PASS |
| `bun run test` | PASS |
| `bun run build:renderer` | PASS |
| `bun audit` | PASS |
| `bun run gate:dictation:artifacts` | PASS | Regenerates `artifacts/dictation-parity-evidence.json` plus the launch-facing dictation parity rollups under `docs/evals/` |
| `bun run gate:blockers:refresh` | PASS | Regenerates `artifacts/release-blockers.json`, `artifacts/benchmark-packaged.blocked.md`, and `artifacts/packaged-qa-evidence-bundle.json` from the current repo state |
| `bun run gate:release:local` | PASS | Produces `artifacts/local-release-macos.json` for the current-platform local release sweep, including the current size-gate summary |

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
| `node scripts/size-gate.mjs --app release/mac-arm64/Nautilus.app --max-mb 450` | PASS | Electron bundle stays under the current packaged size budget |
| `node scripts/cold-start-gate.mjs --threshold-ms 2500 --ready-command "pgrep -f '/Nautilus.app/Contents/MacOS/nautilus-bot'" -- <launch-command>` | PASS (historical) | 168 ms on prior baseline run |
| `bun run electron:build` | PASS (local packaging path) | Produces the packaged macOS app and ZIP through the current-platform Electron release flow |
| `node scripts/build-dmg.mjs` | PASS (local DMG helper path) | Produces the packaged macOS DMG from the signed app bundle in `release/mac-arm64` |
| `electron-builder --mac dmg zip --publish never` | FAIL (local-only) | Electron Builder's built-in DMG step currently fails in this environment with `hdiutil: attach failed - no mountable file systems`; the repo now uses ZIP as the default macOS build target and the explicit DMG helper as the fallback |
| `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app` | PASS | Local bundle signature validates with the dev identity |
| `spctl -a -vv release/mac-arm64/Nautilus.app` | FAIL (expected) | Rejected as `origin=Nautilus Local Dev`; real Gatekeeper acceptance still requires Apple release signing + notarization |

## Local Benchmark Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `bun run benchmark:dictation:fixtures:refresh` | PASS | Rebuilds the local fixture-driven baseline, macOS candidate, Windows candidate, and gate result artifacts |
| `bun run gate:benchmark:macos` | PASS | Local fixture-driven macOS benchmark gate currently passes |
| `bun run gate:benchmark:windows` | PASS | Local fixture-driven Windows benchmark gate currently passes |

## Local Dictation Parity Artifacts

| Artifact | Outcome | Notes |
| --- | --- | --- |
| `artifacts/dictation-parity-evidence.json` | PASS | Command, snippet, dictionary, formatting, and correction fixture suites all pass locally |
| `docs/evals/dictation-parity-artifact-summary.md` | PASS | Rollup reflects 100% local fixture success and passing local macOS + Windows latency gates |
| `docs/evals/dictation-language-certification-matrix.md` | PARTIAL | Language guidance is frozen locally and the local benchmark corpus now covers the frozen launch-language set; packaged evidence is still pending |
| `docs/evals/dictation-app-matrix-evidence.md` | PARTIAL | The local benchmark corpus now covers the frozen launch app matrix; packaged insertion validation is still pending |

## Strict Artifact Gates (Blocked-First Run)

| Command | Outcome | Evidence |
| --- | --- | --- |
| `node scripts/provision-asr-assets.mjs --validate-only --out artifacts/asr-preflight-macos.json` | FAIL (expected) | Missing cloud secrets in strict mode; artifact still generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/asr-preflight.schema.json --file artifacts/asr-preflight-macos.json` | PASS | `artifacts/asr-preflight-macos.json` schema-valid |
| `node scripts/live-cloud-asr-smoke.mjs --out artifacts/cloud-asr-smoke.json` | FAIL | `artifacts/cloud-asr-smoke.blocked.md` (missing `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`) |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-macos.json` | FAIL (historical) | Historical blocked-first result before the refreshed local benchmark artifacts existed |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-windows.json` | FAIL (historical) | Historical blocked-first result before the refreshed local benchmark artifacts existed |
| `node scripts/verify-qa-matrix.mjs --file docs/packaged-app-qa-matrix.md` | PASS | Matrix now `49 BLOCKED / 0 PENDING` |
| `node scripts/export-qa-evidence-bundle.mjs --matrix docs/packaged-app-qa-matrix.md --out artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/packaged-qa-evidence-bundle.schema.json --file artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle schema-valid |

## Remaining Launch Blockers

- Packaged QA matrix is now **49/49 BLOCKED** with blocker evidence stubs; no manual PASS evidence yet.
- CP-13 / CP-14 / CP-15 benchmark artifacts are now required in release workflow:
  - `docs/evals/benchmark-run-baseline.json`
  - `docs/evals/benchmark-run-latest-macos.json`
  - `docs/evals/benchmark-run-latest-windows.json`
- Local fixture-driven gate outputs now exist:
  - `artifacts/benchmark-gates-macos.json`
  - `artifacts/benchmark-gates-windows.json`
- Local dictation parity artifacts now exist and pass:
  - `artifacts/dictation-parity-evidence.json`
  - `docs/evals/dictation-parity-artifact-summary.md`
  - `docs/evals/dictation-command-corpus-log.md`
  - `docs/evals/dictation-snippet-fixture-list.md`
  - `docs/evals/dictation-dictionary-fixture-report.md`
  - `docs/evals/dictation-formatter-benchmark-report.md`
  - `docs/evals/dictation-language-certification-matrix.md`
  - `docs/evals/dictation-app-matrix-evidence.md`
- The local benchmark corpus now covers:
  - the frozen launch-language set
  - the frozen launch app matrix
- Packaged dictation benchmark evidence is still explicitly blocked in:
  - `artifacts/benchmark-packaged.blocked.md`
- Dictation launch now also tracks Phase 0 readiness in:
  - `docs/evals/dictation-parity-launch-scorecard.md`
  - `docs/dictation-app-compatibility-matrix.md`
  - `docs/dictation-blocked-app-register.md`
- Cloud smoke gate is blocked by missing required live keys: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`.
- Production update validation still depends on final release credentials and signed packaged artifacts.
- Signed install validation remains blocked by unavailable Apple notarization setup and Windows signing certificate.
