# Nautilus Audit Baseline

## Verification Snapshot

- Date: 2026-02-09
- Scope: strict launch-readiness baseline for macOS + Windows GA

### Command Gates

- `npm test`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `npm audit --audit-level=moderate`: pass
- `cargo audit`: blocked (RustSec advisory DB fetch network failure in this environment)

## Material Baseline Changes From This Audit

1. Renderer direct shell open was removed from recordings flow.
2. Backend command `open_recording_audio` was added with approved-root validation.
3. Path hardening was added for command inputs (`targetPath`, `data_dir`, `path`, `recording_path`).
4. Tauri capability surface was reduced by removing shell/fs/process permissions.
5. Tauri runtime plugin surface was reduced by removing shell/fs/process plugin init.
6. README and ASR provider UI copy were aligned to shipped production behavior (Whisper enabled, Parakeet/Canary not enabled).
7. CI was tightened to fail on clippy warnings and include dependency audit steps.

## Open Blockers (Strict Launch Policy)

### P1

1. Rust advisory gate remains incomplete due `cargo audit` network fetch failure.
- Owner: release engineering
- Exit criteria: successful `cargo audit` run with evidence archived in launch report.

2. Windows manual runtime E2E matrix is pending.
- Owner: QA / release
- Exit criteria: complete matrix attached for recording/dictation/export/backup/cloud/failure paths.

3. Hard-required integration runtime checks (Ollama + rclone/iCloud) are pending.
- Owner: integrations
- Exit criteria: successful and failure-mode validation evidence attached.

## Sign-off State

- Current state: **NO-GO** until all P1 items above are closed.
