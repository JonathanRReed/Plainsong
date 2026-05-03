# Release Gate Evidence

This file records launch-gate outcomes after the March hardening pass, the blocker-first strict run on **2026-03-05**, the local ship-path verification refresh on **2026-03-20**, the Electron release-path refresh on **2026-04-09**, the independent launch audit refresh on **2026-04-09**, and the packaged QA evidence refresh on **2026-05-02**.

Completion audit: `docs/launch-completion-audit.md`.

## Frontend Gates

| Command | Outcome | Notes |
| --- | --- | --- |
| `bun run lint` | PASS | Includes `bun run typecheck`, `cargo fmt --check`, and `cargo clippy --all-targets -- -D warnings` through the package script |
| `bun run typecheck` | PASS | No TypeScript errors in the current repo state |
| `bun run test` | PASS | 28 files, 177 tests passing in the current repo state |
| `bun run build:renderer` | PASS | Production renderer build succeeds |
| `bun audit` | PARTIAL | As of 2026-04-09, the critical `wait-on` to `axios` advisory was removed by deleting the unused dependency and stale npm lockfile. The Vite stack was upgraded to Vite 8 with `esbuild@0.27.x`. Bun still reports the generic `esbuild <=0.24.2` dev-server advisory against the Vite family, but the live graph resolves to `esbuild@0.27.7` and dev is bound to `127.0.0.1`. Residual risk is documented and accepted for local dev only. |
| `bun run gate:dictation:artifacts` | PASS | Regenerates `artifacts/dictation-parity-evidence.json` plus the launch-facing dictation parity rollups under `docs/evals/` |
| `bun run gate:blockers:refresh` | PASS | Regenerates `artifacts/release-blockers.json`, `artifacts/benchmark-packaged.blocked.md`, and `artifacts/packaged-qa-evidence-bundle.json` from the current repo state |
| `bun run gate:launch:report` | PASS | Regenerates `artifacts/launch-readiness-report.json` and `docs/launch-readiness-dashboard.md` so launch state is visible in one place |
| `bun run gate:release:local` | PASS | Produces `artifacts/local-release-macos.json` for the current-platform local release sweep, including the current size-gate summary |
| `bun run gate:app-matrix` | FAIL (expected) | Fails closed until every frozen launch app has supported or partial status, packaged evidence, and no open blocked-app entry; current artifact is `artifacts/dictation-app-matrix-gate.json` |
| `bun run gate:dead-code` | PASS | Knip dead-file, export, and dependency scan passes, and `scripts/verify-dead-code-hygiene.mjs` blocks `allow(dead_code)` suppressions |
| Rust dead-code cleanup pass | PASS | Removed dormant dictation, meeting-title, recording encryption, waveform, crypto session-manager, and audio helper paths while preserving active capture, waveform export, VAD trim, and packaged sidecar flows |

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
| `bun run qa:packaged:macos:idle-cpu` | PASS | Packaged macOS app averages 0.11% total CPU while open and idle after a 30s warmup; evidence in `artifacts/qa/macos/idle-cpu-baseline.md` |
| `bun run qa:packaged:macos:update-metadata` | PASS | Packaged macOS `app-update.yml`, `latest-mac.yml`, ZIP SHA-512, ZIP size, and blockmap are internally consistent; signed install validation still requires a real update feed |
| `bun run qa:packaged:macos:meeting:soak` | PASS | 3-hour packaged mic plus system-audio run completed transcript end-to-end, validated audio artifacts, emitted completion, and restored the user database/settings snapshot; evidence in `artifacts/qa/macos/capture-soak-3h.md` |
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
| `bun run benchmark:dictation:packaged:macos` | PASS | Captures `docs/evals/benchmark-run-packaged-macos.json` from the packaged macOS sidecar with 20 samples |

## Local Dictation Parity Artifacts

| Artifact | Outcome | Notes |
| --- | --- | --- |
| `artifacts/dictation-parity-evidence.json` | PASS | Command, snippet, dictionary, formatting, and correction fixture suites all pass locally |
| `docs/evals/dictation-parity-artifact-summary.md` | PASS | Rollup reflects 100% local fixture success and passing local macOS + Windows latency gates |
| `docs/evals/dictation-language-certification-matrix.md` | PARTIAL | Frozen launch-language set has 10/10 macOS packaged benchmark evidence; Windows packaged evidence is still missing |
| `docs/evals/dictation-app-matrix-evidence.md` | PARTIAL | The local and macOS packaged benchmark corpus cover the frozen launch app names, but app-specific launch certification still fails closed in `artifacts/dictation-app-matrix-gate.json` |
| `artifacts/dictation-app-matrix-gate.json` | FAIL (expected) | `1/16` launch apps ready, `15` pending, `8` missing packaged benchmark evidence, `15` missing insertion evidence, `6` open blocked-app entries |

## Strict Artifact Gates (Blocked-First Run)

| Command | Outcome | Evidence |
| --- | --- | --- |
| `node scripts/provision-asr-assets.mjs --validate-only --out artifacts/asr-preflight-macos.json` | FAIL (expected) | Missing cloud secrets in strict mode; artifact still generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/asr-preflight.schema.json --file artifacts/asr-preflight-macos.json` | PASS | `artifacts/asr-preflight-macos.json` schema-valid |
| `node scripts/live-cloud-asr-smoke.mjs --out artifacts/cloud-asr-smoke.json` | FAIL | `artifacts/cloud-asr-smoke.blocked.md` (missing `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`) |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-macos.json` | FAIL (historical) | Historical blocked-first result before the refreshed local benchmark artifacts existed |
| `node scripts/verify-benchmark-gates.mjs ... --candidate docs/evals/benchmark-run-latest-windows.json` | FAIL (historical) | Historical blocked-first result before the refreshed local benchmark artifacts existed |
| `bun run qa:packaged:macos:exports` | PASS | Packaged macOS sidecar exports Markdown, JSON, text, signed evidence bundle, verifies the bundle signature/hash chain, renders all seven built-in templates, and restores the user database snapshot |
| `node scripts/capture-packaged-macos-meeting-soak.mjs --record-ms 30000 --min-record-ms 30000 ...` | PASS | Short packaged soak preflight proves mic plus system-audio capture, processing events, persisted transcript text, source-aware segments, artifact cleanup, DB restore, and settings restore after fixing text-only MLX meeting output |
| `bun run qa:packaged:macos:meeting:soak -- --speak-fixture` | PASS | Strict 3-hour packaged mic plus system-audio soak passes with 1348 transcript characters, completed recording status, audio cleanup, and DB/settings restore |
| `node scripts/verify-qa-matrix.mjs --file docs/packaged-app-qa-matrix.md` | PASS | Matrix now `21 PASS / 31 BLOCKED / 0 PENDING`; macOS `21 PASS / 6 BLOCKED / 0 PENDING`; Windows `0 PASS / 25 BLOCKED / 0 PENDING` |
| `node scripts/export-qa-evidence-bundle.mjs --matrix docs/packaged-app-qa-matrix.md --out artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle generated |
| `node scripts/validate-gate-artifact.mjs --schema docs/ci/schemas/packaged-qa-evidence-bundle.schema.json --file artifacts/packaged-qa-evidence-bundle.json` | PASS | Bundle schema-valid |

## Remaining Launch Blockers

- Packaged QA matrix is now **21 PASS / 31 BLOCKED / 0 PENDING**, with macOS at **21 PASS / 6 BLOCKED / 0 PENDING** and Windows at **0 PASS / 25 BLOCKED / 0 PENDING**.
- CP-13 / CP-14 / CP-15 benchmark artifacts are now required in release workflow:
  - `docs/evals/benchmark-run-baseline.json`
  - `docs/evals/benchmark-run-latest-macos.json`
  - `docs/evals/benchmark-run-latest-windows.json`
- Local fixture-driven gate outputs now exist:
  - `artifacts/benchmark-gates-macos.json`
  - `artifacts/benchmark-gates-windows.json`
- Packaged macOS benchmark outputs now exist and pass:
  - `docs/evals/benchmark-run-packaged-macos.json`
  - `artifacts/benchmark-packaged-macos.json`
  - `artifacts/benchmark-gates-packaged-macos.json`
- Packaged macOS meeting soak preflight now exists and passes:
  - `artifacts/qa/macos/capture-soak-preflight.json`
  - `artifacts/qa/macos/capture-soak-preflight.md`
- Packaged macOS strict meeting soak now exists and passes:
  - `artifacts/qa/macos/capture-soak-3h.json`
  - `artifacts/qa/macos/capture-soak-3h.md`
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
- Packaged dictation benchmark evidence is still blocked for Windows in:
  - `artifacts/benchmark-packaged.blocked.md`
- Frozen app matrix certification is blocked in:
  - `artifacts/dictation-app-matrix-gate.json`
- Dictation launch now also tracks Phase 0 readiness in:
  - `docs/evals/dictation-parity-launch-scorecard.md`
  - `docs/dictation-app-compatibility-matrix.md`
  - `docs/dictation-blocked-app-register.md`
- Cloud smoke gate is blocked by missing required live keys: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`.
- Dependency audit status on 2026-04-09:
  - removed the unused `wait-on` dependency and the stale `package-lock.json`, which cleared the `axios` critical advisory
  - upgraded to `vite@8.0.8`, `@vitejs/plugin-react@6.0.1`, and `esbuild@0.27.7`
  - Bun still reports the generic `esbuild` dev-server advisory against the Vite family even though the installed graph resolves above the vulnerable range
  - residual risk is limited to the local dev server and is mitigated by binding dev to `127.0.0.1`
- Production update validation still depends on final release credentials and signed packaged artifacts.
- Signed install validation remains blocked by unavailable Apple notarization setup and Windows signing certificate.
