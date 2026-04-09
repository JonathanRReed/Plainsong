# NautilusBot Pre-Launch Readiness

This report summarizes launch-readiness status for the strict GA scope: **all ASR providers enabled**, **no runtime fallback behavior**, and **macOS + Windows** as target GA platforms.

## Scope

- Target GA platforms: **macOS + Windows**
- Policy: strict release gates (compile/test/perf/cloud live checks)
- ASR policy: all listed providers functional, no implicit Whisper fallback

## What Was Implemented (2026-03-02 refresh)

- Removed fallback behavior and fallback data fields across backend/frontend contracts.
- Removed fallback setting from app settings and UI.
- Removed Parakeet legacy filename compatibility (`model.onnx`/`vocab.txt`); now `encoder.onnx` + `tokens.txt` only.
- Fixed Parakeet `ort` API compatibility and compile blockers.
- Implemented managed Python runtime bridge for Voxtral local mode.
- Refactored Voxtral into explicit local/cloud modes (`voxtral-local`, `voxtral-cloud`) with no automatic local->cloud fallback.
- Added live cloud smoke gate script and fixed WAV fixture.
- Added live cloud Rust integration test gate and local ASR RTF performance gate test.
- Added cold-start gate utility (`scripts/cold-start-gate.mjs`) for M1 baseline verification (<2.5s).
- Added release workflow enforcement for required cloud secrets and cloud smoke artifacts.
- Fixed release cold-start process matcher to use the packaged binary (`nautilus-bot`) so the gate can pass.
- Added benchmark launch gate enforcement script for CP-13/CP-14/CP-15 (`scripts/verify-benchmark-gates.mjs`).
- Added benchmark gate artifact schema validation (`docs/ci/schemas/benchmark-gate-result.schema.json`).
- Filled packaged QA matrix owners and evidence paths to support execution tracking.
- Resolved frontend dependency advisory (`rollup`) and restored a clean dependency audit state.
- Hardened licensing so raw license key material is stored in OS secure storage instead of the persisted renderer-visible cache.
- Hardened backup and restore with staged writes, rollback support, and non-destructive iCloud swap behavior.
- Added an explicit renderer command allowlist at the Electron bridge to narrow the preload command surface.

## What Was Executed (2026-03-05 blocked-first run)

- Re-ran strict automated build/test gates (`bun run typecheck`, `bun run test`, `bun run build:renderer`, `cargo check --all-targets`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`, `cargo test --tests`) and confirmed pass.
- Ran strict ASR preflight artifact generation and schema validation:
  - `artifacts/asr-preflight-macos.json` (schema-valid; strict run fails due missing cloud secrets).
- Converted packaged QA matrix from `PENDING` to explicit `BLOCKED` rows with evidence stubs:
  - `docs/packaged-app-qa-matrix.md` now `49 BLOCKED / 0 PENDING`.
  - Generated 49 evidence files under `artifacts/qa/macos/*` and `artifacts/qa/windows/*`.
- Re-generated and schema-validated packaged QA evidence bundle:
  - `artifacts/packaged-qa-evidence-bundle.json`.
- Captured strict gate blocker outputs:
  - `artifacts/cloud-asr-smoke.blocked.md`
  - `artifacts/benchmark-packaged.blocked.md`
  - `artifacts/release-blockers.json`

## Release Gate Status

See `docs/release-gate-evidence.md` for command-level results.

Current status:

- Frontend compile/test/build: ✅ PASS
- Rust format/clippy/check/lib/tests: ✅ PASS
- Local packaging perf gates: ✅ PASS (`bun run gate:size` now passes at `403.09 MB` against the `450 MB` budget; cold-start remains historical evidence)
- Local packaged update path: ✅ PASS (packaging path verified through the Electron release flow; production release still requires final signing and notarization credentials)
- Packaged QA matrix execution: ⚠️ BLOCKED (49/49 blocked; no rows pending, no rows passed)
- Benchmark parity artifacts (CP-13/CP-14/CP-15): ⚠️ PARTIAL (local fixture-driven baseline, macOS, and Windows benchmark JSON artifacts now exist and the local gate outputs pass; packaged benchmark evidence is still missing)
- Dictation parity Phase 0 artifacts: ⚠️ PARTIAL (local command, snippet, dictionary, formatting, correction, prompt-regression, launch-language, and launch-app artifacts now regenerate cleanly and cover the frozen corpus; packaged benchmark and QA evidence still missing)
- Superwhisper core comparison: ✅ PARITY-OR-BETTER on the repo-owned interactive dictation surface; public 100-language breadth, translate-to-English positioning, and file-transcription product path still need explicit launch scope or follow-up work
- Cloud ASR smoke gate: ❌ BLOCKED (missing required cloud API secrets)
- Internal launch hardening: ✅ COMPLETE for licensing, backup or restore safety, and renderer command allowlisting
- Frontend dependency audit: ⚠️ PARTIAL (critical `wait-on` to `axios` path removed; remaining Bun-reported `esbuild` advisory is treated as a local dev residual because the installed graph resolves to `esbuild@0.27.7` and dev binds to `127.0.0.1`)

See `docs/strict-release-blocker-register.md` for blocker ownership and unblock actions.
See `docs/launch-execution-plan.md` for the recommended execution order, owners, and effort.

## Current Blockers

1. Required cloud ASR secrets are missing:
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `MISTRAL_API_KEY`
2. Benchmark run artifacts for CP-13/CP-14/CP-15 are still not launch-complete:
   - Present locally: `docs/evals/benchmark-run-baseline.json`
   - Present locally: `docs/evals/benchmark-run-latest-macos.json`
   - Present locally: `docs/evals/benchmark-run-latest-windows.json`
   - Present locally: `artifacts/benchmark-gates-macos.json`
   - Present locally: `artifacts/benchmark-gates-windows.json`
   - Present locally: `artifacts/dictation-parity-evidence.json`
   - Present locally: `artifacts/dictation-prompt-eval.json`
   - Present locally: `docs/evals/dictation-parity-artifact-summary.md`
   - Present locally: `docs/evals/dictation-prompt-eval-report.md`
   - Present locally: `docs/evals/dictation-language-certification-matrix.md`
   - Present locally: `docs/evals/dictation-app-matrix-evidence.md`
   - The local benchmark corpus now covers the frozen launch-language set and the frozen launch app matrix.
   - The current baseline and platform artifacts are fixture-driven local runs, not packaged-app execution, so they do not satisfy the packaged evidence requirement by themselves.
   - Tracking doc: `docs/evals/dictation-parity-launch-scorecard.md`
   - App matrix: `docs/dictation-app-compatibility-matrix.md`
   - Blocked apps: `docs/dictation-blocked-app-register.md`
3. Apple paid signing/notarization setup is unavailable, blocking signed DMG + notarization evidence.
4. Windows code-signing certificate is unavailable, blocking signed installer security evidence.
5. Packaged QA rows are marked BLOCKED, but strict release requires PASS evidence across scope.
6. Bun still reports the generic `esbuild` dev-server advisory against the Vite family:
   - installed graph resolves to `esbuild@0.27.7`
   - residual risk is local-dev-only and mitigated by binding dev to `127.0.0.1`
   - release builds do not expose the Vite dev server

## Recent Ship-Path Fixes

- Packaging no longer depends on retired shell config files or updater key injection.
- Local Electron packaging is now the only supported desktop release path.
- Signed package verification is tracked against the `release/` artifacts generated by `electron-builder`.
- The stale `dictation-parity-benchmark` helper no longer bloats `Nautilus.app`; the benchmark workflow now runs from a dedicated Rust binary target instead of a packaged binary.
- The repo now includes `bun run gate:release:local` to capture a reproducible current-platform local release artifact before manual QA.
- The repo now includes `bun run gate:blockers:refresh` to refresh blocker evidence and the packaged QA bundle from the current repo state.
- The repo now includes `bun run gate:launch:report` and writes `docs/launch-readiness-dashboard.md` plus `artifacts/launch-readiness-report.json` as the single repo-side launch control surface.
- The repo now includes `bun run gate:dictation:artifacts` to regenerate the local dictation parity evidence suite and its launch-facing markdown rollups.
- The repo no longer ships raw license material to the renderer, and license secrets now live in OS secure storage.
- Backup creation now writes a manifest, restore is staged with rollback, and iCloud sync swaps non-destructively.
- Renderer commands are now explicitly allowlisted in Electron before crossing the preload boundary.

## Residual Preconditions

- Release signing and notarization credentials must be configured for macOS and Windows in the release environment.
- Gate runners must have access to required local ASR model assets if local RTF gate remains enforced in CI.
- Benchmark baseline/candidate JSON artifacts must exist and pass schema + threshold validation.
- Dictation Phase 0 must move from frozen assumptions to real packaged evidence before any dictation parity claim is credible.
- Final Go/No-Go still requires QA + engineering signoff.

## Launch Recommendation

- **Current recommendation: NO-GO**.
- Move to **GO** only after:
  1. cloud smoke prerequisites are met and gate passes,
  2. CP benchmark artifacts exist and pass schema + launch-threshold checks,
  3. blocked QA rows are replaced with executed PASS evidence where required,
  4. signed update/install flows are validated on macOS + Windows packaged builds,
  5. the remaining Bun-reported `esbuild` advisory remains documented as a local-dev residual unless the upstream tooling stops flagging it.
