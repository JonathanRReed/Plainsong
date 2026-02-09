# Launch Checklist (macOS + Windows GA)

Date: 2026-02-09

## Automated Gates

- [x] `npm test`
- [x] `npx tsc --noEmit`
- [x] `npm run build`
- [x] `cargo fmt --check`
- [x] `cargo clippy --all-targets -- -D warnings`
- [x] `cargo check --all-targets`
- [x] `cargo test --lib`
- [x] `npm audit --audit-level=moderate`
- [ ] `cargo audit` (blocked by advisory DB network fetch failures)

## Security / Command Surface

- [x] Renderer direct shell-open removed for recordings audio
- [x] Backend `open_recording_audio` command added with path/root checks
- [x] Path validation added for `targetPath`, `data_dir`, `path`, `recording_path`
- [x] Tauri capability surface reduced (removed shell/fs/process permissions)
- [x] Tauri plugin surface reduced (removed shell/fs/process plugin init)

## Claims / Docs Parity

- [x] README updated to reflect actual production ASR availability
- [x] ASR UI provider status updated to avoid unsupported production claims
- [x] Claims parity matrix created

## Runtime E2E

- [x] Local macOS automated validation complete
- [ ] macOS manual end-to-end matrix (recording, dictation, export, backup, cloud, failure paths)
- [ ] Windows manual end-to-end matrix (recording, dictation, export, backup, cloud, failure paths)

## Hard-Requirement Integrations

- [ ] Ollama installed/running and analysis flows validated end-to-end
- [ ] rclone configured and cloud sync flows validated end-to-end
- [ ] iCloud path validation (if enabled) validated end-to-end

## Final Sign-off

- [ ] Zero open P0/P1 findings
- [ ] Go/No-Go decision documented
- [ ] Rollback/containment plan documented
