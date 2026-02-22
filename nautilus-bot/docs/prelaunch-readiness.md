# NautilusBot Pre-Launch Readiness

This report summarizes launch-readiness status for the strict GA scope: **all ASR providers enabled**, **no runtime fallback behavior**, and **macOS + Windows** as target GA platforms.

## Scope

- Target GA platforms: **macOS + Windows**
- Policy: strict release gates (compile/test/perf/cloud live checks)
- ASR policy: all listed providers functional, no implicit Whisper fallback

## What Was Implemented (2026-02-21)

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

## Release Gate Status

See `docs/release-gate-evidence.md` for command-level results.

Current status:

- Frontend compile/test/build: ✅ PASS
- Rust format/clippy/check/lib tests: ✅ PASS
- Rust integration/perf gates: ❌ BLOCKED by missing runtime prerequisites (cloud secrets + local model assets)

## Current Blockers

1. Required cloud secrets are not present in the current environment:
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `MISTRAL_API_KEY`
2. Local ASR performance gate cannot pass without pre-provisioned local model assets for all required local providers.
3. Packaged app QA matrix remains pending for macOS and Windows.

## Residual Preconditions

- Release signing + notarization secrets must be configured (`TAURI_SIGNING_*`, `APPLE_*`, `WINDOWS_CERTIFICATE*`).
- Gate runners must have access to required local ASR model assets if local RTF gate is enforced in CI.
- Final Go/No-Go still requires QA + engineering signoff.

## Launch Recommendation

- **Current recommendation: NO-GO**.
- Move to **GO** only after:
  1. cloud secrets are provisioned,
  2. local-provider performance gate passes,
  3. packaged QA matrix is completed and signed off.
