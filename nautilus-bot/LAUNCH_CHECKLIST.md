# Launch Checklist (macOS + Windows GA)

Date: 2026-02-13

## Automated Gates

- [x] `npm test`
- [x] `npx tsc --noEmit`
- [x] `npm run build`
- [x] `cargo fmt --check`
- [x] `cargo clippy --all-targets -- -D warnings`
- [x] `cargo check --all-targets`
- [x] `cargo test --lib`
- [x] `cargo test --tests`
- [x] `cargo audit -f src-tauri/Cargo.lock` via `src-tauri/scripts/run-cargo-audit-policy.sh`

## Security-Critical Implementation Gates

- [x] Remote analysis egress denied by default; explicit opt-in required.
- [x] Remote provider credentials sourced from OS keyring in backend analysis paths.
- [x] Vault lifecycle commands wired (`unlock_vault`, `lock_vault`, `migrate_to_encrypted_storage`, `get_security_status`).
- [x] SQLCipher mode enabled in default build feature graph.
- [x] Recording artifacts encrypted at rest (`.enc`) with authenticated encryption.
- [x] Export target path constrained to configured safe root / approved roots.
- [x] Non-Whisper model download checksum verification enabled.

## Reliability / Parity Gates

- [x] Windows clipboard copy fallback implemented in backend.
- [x] ASR runtime integration tests replaced with real assertions.
- [ ] macOS packaged manual QA matrix completed and attached.
- [ ] Windows packaged manual QA matrix completed and attached.

## Competitive Evidence Gates

- [x] `COMPETITIVE_SCORECARD.md` published.
- [x] Beat-threshold criteria documented.
- [ ] Dictation >=99% end-to-end success validated in packaged manual matrix.

## Final Sign-off

- [ ] Zero open P0/P1 launch blockers.
- [ ] Go/No-Go decision approved with attached macOS + Windows QA evidence.

