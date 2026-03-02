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

## Release Gate Status

See `docs/release-gate-evidence.md` for command-level results.

Current status:

- Frontend compile/test/build: ✅ PASS
- Rust format/clippy/check/lib/tests: ✅ PASS
- Local packaging perf gates (size + cold start): ✅ PASS
- Packaged QA matrix execution: ❌ NOT STARTED (rows still PENDING)
- Benchmark parity artifacts (CP-13/CP-14/CP-15): ❌ NOT PRODUCED

## Current Blockers

1. Packaged app QA matrix remains pending for macOS and Windows (0/49 PASS).
2. Benchmark run artifacts for CP-13/CP-14/CP-15 are required but not yet committed:
   - `docs/evals/benchmark-run-baseline.json`
   - `docs/evals/benchmark-run-latest-macos.json`
   - `docs/evals/benchmark-run-latest-windows.json`
3. Final release still depends on configured signing + distribution secrets in CI.

## Residual Preconditions

- Release signing + notarization secrets must be configured (`TAURI_SIGNING_*`, `APPLE_*`, `WINDOWS_CERTIFICATE*`).
- Gate runners must have access to required local ASR model assets if local RTF gate remains enforced in CI.
- Final Go/No-Go still requires QA + engineering signoff.

## Launch Recommendation

- **Current recommendation: NO-GO**.
- Move to **GO** only after:
  1. packaged QA matrix is completed and signed off,
  2. CP benchmark artifacts pass schema + launch-threshold checks,
  3. signed update/install flows are validated on macOS + Windows packaged builds.
