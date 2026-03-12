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
- Resolved frontend dependency advisory (`rollup`) and restored `npm audit` clean state.

## What Was Executed (2026-03-05 blocked-first run)

- Re-ran strict automated build/test gates (`tsc`, `npm test`, `npm run build`, `cargo check --all-targets`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`, `cargo test --tests`) and confirmed pass.
- Ran strict ASR preflight artifact generation and schema validation:
  - `artifacts/asr-preflight-macos.json` (schema-valid; strict run fails due missing cloud secrets).
- Converted packaged QA matrix from `PENDING` to explicit `BLOCKED` rows with evidence stubs:
  - `docs/packaged-app-qa-matrix.md` now `49 BLOCKED / 0 PENDING`.
  - Generated 49 evidence files under `artifacts/qa/macos/*` and `artifacts/qa/windows/*`.
- Re-generated and schema-validated packaged QA evidence bundle:
  - `artifacts/packaged-qa-evidence-bundle.json`.
- Captured strict gate blocker outputs:
  - `artifacts/cloud-asr-smoke.blocked.md`
  - `artifacts/benchmark-gates-macos.blocked.md`
  - `artifacts/benchmark-gates-windows.blocked.md`
  - `artifacts/release-blockers.json`

## Release Gate Status

See `docs/release-gate-evidence.md` for command-level results.

Current status:

- Frontend compile/test/build: ✅ PASS
- Rust format/clippy/check/lib/tests: ✅ PASS
- Local packaging perf gates (size + cold start): ✅ PASS (cold-start currently historical evidence)
- Packaged QA matrix execution: ⚠️ BLOCKED (49/49 blocked; no rows pending, no rows passed)
- Benchmark parity artifacts (CP-13/CP-14/CP-15): ❌ NOT PRODUCED (gate fails on missing files)
- Dictation parity Phase 0 artifacts: ⚠️ IN PROGRESS (`docs/evals/dictation-parity-launch-scorecard.md`, app matrix frozen, benchmark JSON still missing)
- Cloud ASR smoke gate: ❌ BLOCKED (missing required cloud API secrets)

See `docs/strict-release-blocker-register.md` for blocker ownership and unblock actions.

## Current Blockers

1. Required cloud ASR secrets are missing:
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `MISTRAL_API_KEY`
2. Benchmark run artifacts for CP-13/CP-14/CP-15 are required but not yet committed:
   - `docs/evals/benchmark-run-baseline.json`
   - `docs/evals/benchmark-run-latest-macos.json`
   - `docs/evals/benchmark-run-latest-windows.json`
   - Tracking doc: `docs/evals/dictation-parity-launch-scorecard.md`
   - App matrix: `docs/dictation-app-compatibility-matrix.md`
   - Blocked apps: `docs/dictation-blocked-app-register.md`
3. Apple paid signing/notarization setup is unavailable, blocking signed DMG + notarization evidence.
4. Windows code-signing certificate is unavailable, blocking signed installer security evidence.
5. Packaged QA rows are marked BLOCKED, but strict release requires PASS evidence across scope.

## Residual Preconditions

- Release signing + notarization secrets must be configured (`TAURI_SIGNING_*`, `APPLE_*`, `WINDOWS_CERTIFICATE*`) and accessible in the release environment.
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
  4. signed update/install flows are validated on macOS + Windows packaged builds.
