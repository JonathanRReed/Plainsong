# Claims Parity Matrix (2026-02-09)

This matrix maps product claims to executable evidence in the repository.

| Claim | Source | Evidence | Status | Action |
|---|---|---|---|---|
| Whisper transcription is production-enabled | README.md | `src-tauri/src/asr/mod.rs` (`AsrProviderType::all()`), `src-tauri/src/asr/whisper.rs` | Pass | None |
| Parakeet and Canary inference are production-enabled | Historical README claims | `src-tauri/src/asr/parakeet.rs`, `src-tauri/src/asr/canary.rs` return not-implemented inference errors | Mismatch resolved | README and UI updated to mark as not enabled |
| Audio files can be opened safely from recordings UI | Recordings UX | `src/components/views/recordings-view.tsx`, `src/lib/tauri.ts`, `src-tauri/src/lib.rs` (`open_recording_audio`) | Pass | Renderer direct shell-open removed |
| Filesystem path inputs are constrained | Security requirement | `src-tauri/src/lib.rs` path validation helpers + command checks for `targetPath`, `data_dir`, `path`, `recording_path` | Pass | Continue adding tests |
| Evidence bundle verification is bounded to Nautilus roots | Export/security requirement | `src-tauri/src/lib.rs` (`verify_evidence_bundle`) | Pass | None |
| Strict clippy warning-free Rust policy | Launch gate | `cargo clippy --all-targets -- -D warnings` (local run on 2026-02-09) | Pass | CI now fails on clippy warnings |
| JS dependency vulnerability scan at moderate+ | Launch gate | `npm audit --audit-level=moderate` (local run on 2026-02-09) | Pass | CI step added |
| Rust advisory scan | Launch gate | `cargo audit` tooling installed; advisory DB fetch failed twice due network I/O | Blocked | Retry in connected environment / CI |
| Cross-platform runtime E2E (macOS + Windows) completed | Launch gate | macOS local automated checks done; Windows manual runtime still pending | Blocked | Run matrix on Windows machine and attach evidence |
| External dependency readiness (Ollama + rclone) validated as hard requirement | Launch policy | Code paths exist; full runtime dependency validation not fully executed in this run | Blocked | Complete manual E2E dependency scenarios |
