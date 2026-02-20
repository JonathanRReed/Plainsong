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
- **Re-run all gates** after pre-launch review session 2 fixes below before Go/No-Go.

## ASR Fixes Pass (re-verification required)

The following ASR changes were made after the 2026-02-19 audit. **Re-run all Rust gates before Go/No-Go.**

| Area | Change |
| --- | --- |
| `parakeet.rs` | Switched to sherpa-onnx ONNX format (`encoder.onnx` + `tokens.txt`), raw-waveform `[1,T,n_mels]` input, updated download URL to `k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en`, backward-compatible with legacy `model.onnx`/`vocab.txt` |
| `canary.rs` | Extracted `pub(super) run_canary_inference_on_samples` shared function; `run_canary_candle` now delegates to it |
| `distil_whisper.rs` | `run_distil_candle` now delegates to `canary::run_canary_inference_on_samples` (same Whisper architecture) |
| `voxtral.rs` | Added local model download infra + dual-mode (local stub → cloud fallback); `download_models` fetches `mistralai/Voxtral-Mini-4B-Realtime-2602` |
| `mel.rs` | `#[allow(dead_code)]` on `n_frames()` |
| `streaming.rs` | `#[allow(dead_code)]` on `StreamingSession`, `stop_session`, `is_session_active` |
| `manager.rs` | Updated Parakeet diagnostics (`encoder.onnx`\|`model.onnx` + `tokens.txt`\|`vocab.txt`); updated Voxtral diagnostics for local+cloud |
| `asr-provider-manager.tsx` | Replaced stale Python `pip install` hints with accurate "Download button / API key" guidance per provider |
| `model-downloader.tsx` | Fixed Parakeet indicator from `parakeet-tdt-0.6b-v3.nemo` → `parakeet/encoder.onnx` |

## Pre-Launch Code Review — Session 2 (2026-02-20)

Full audit of all Rust modules, security layer, audio pipeline, LLM providers, frontend types, and Tauri command surface.

### Bugs Fixed

| File | Bug | Fix |
| --- | --- | --- |
| `src-tauri/src/llm/cloud.rs` | `println!` logged raw LLM response body to stdout in production | Replaced with `tracing::debug!` (byte-count only) |
| `src-tauri/src/download/mod.rs` | `println!` in diarization download path logged to stdout | Replaced with `tracing::info!` |
| `src/types/settings.ts` | `TranscriptionSettings` missing `enableAutoAnalysis: boolean` — every `saveSettings()` silently reset it to `true` via serde default | Added field to interface |
| `src/types/settings.ts` | `Settings` missing `updates: UpdateSettings` — every `saveSettings()` silently reset update channel to `"stable"` | Added `UpdateSettings` interface and `updates` field |

### Remaining Blocker — Manual Action Required

| Item | Action Required |
| --- | --- |
| `src-tauri/tauri.conf.json` `plugins.updater.pubkey` is placeholder `"TODO_REPLACE_WITH_OUTPUT_OF_tauri_signer_generate"` | Run `node scripts/setup-updater-key.js` after `npm install` to generate keypair and auto-apply public key. Store private key as `TAURI_PRIVATE_KEY` CI/CD secret. |

### Audit Findings — All Clear

| Area | Result |
| --- | --- |
| Security (Argon2id KDF, AES-256-GCM, OS keychain migration) | ✅ Clean |
| Path traversal (`ensure_path_in_approved_roots` + canonicalize) | ✅ Protected |
| SQL injection (parameterized queries; PRAGMA keys are hex-encoded) | ✅ Clean |
| rclone backup command injection (remote name validated; `.arg()` not shell) | ✅ Safe |
| License logic (trial countdown, grace period, activation limits) | ✅ Correct |
| Tauri command surface (63 commands, frontend ↔ backend) | ✅ Fully aligned |
| DB `unwrap()` calls | ✅ All in test code only |
| Production `panic!` | ✅ App-init only (acceptable) |
| `unsafe` in `canary.rs` | ✅ Standard Candle mmap safetensors load |
| Hardcoded secrets | ✅ None found |
| Frontend `console.error` usage | ✅ All inside proper catch blocks |
