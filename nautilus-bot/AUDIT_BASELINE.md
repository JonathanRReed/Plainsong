# Nautilus Audit Baseline

## Verification Snapshot
- Date: 2026-02-06
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass

## Severity Register

### P0 (Stop-Ship)
1. Audio capture lifecycle leaked non-owned streams, causing unbounded resource retention and undefined shutdown behavior.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/audio.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/audio/system_capture.rs`
- Owner: platform/runtime

2. Command payload naming mismatches (`camelCase` UI vs `snake_case` backend) caused broken invocations at runtime.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/models.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/lib/tauri.ts`
- Owner: platform/api

3. DB lock scope crossed async network/IO boundaries in analysis/export paths, increasing deadlock risk and reducing throughput.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`
- Owner: platform/runtime

4. Mock transcript/speaker paths were still active in the recordings detail flow, causing non-deterministic behavior and non-persistent diarization edits.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/recordings-view.tsx`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/transcript-viewer.tsx`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/db.rs`
- Owner: frontend + platform

### P1 (High)
1. Non-production crypto (custom stream cipher/KDF) was insufficient for enterprise baseline.
- Status: fixed (Argon2id + AES-256-GCM + key zeroization)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/crypto.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/Cargo.toml`
- Owner: security

2. Theme settings persistence was calling a non-existent command (`update_settings`).
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/theme-provider.tsx`
- Owner: frontend/settings

3. Frontend waveform rendering used synthetic data instead of backend capture data.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/waveform-visualizer.tsx`
- Owner: frontend/audio

4. API credentials were not persisted in secure OS credential storage.
- Status: fixed
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/secrets.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/settings-view-simple.tsx`
- Owner: security + frontend

5. Export workflow lacked policy-bound preview/redaction semantics.
- Status: fixed (v2 export API with `preview` + `redactionLevel`)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/transcription.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/exports-view.tsx`
- Owner: platform + frontend

6. Cloud backup provider integration for OneDrive/Google Drive/Proton Drive/iCloud was placeholder.
- Status: fixed (real provider sync: iCloud filesystem sync + rclone remotes)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/backup.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/settings-view-simple.tsx`
- Owner: platform + integrations + frontend

7. Cloud provider readiness lacked detailed setup diagnostics, making production onboarding opaque.
- Status: fixed (structured setup checks + UI report for rclone/remote/iCloud readiness)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/backup.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/lib/tauri.ts`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/settings-view-simple.tsx`
- Owner: platform + integrations + frontend

### P2 (Medium)
1. CI/release validation missing for macOS + Windows.
- Status: fixed (baseline CI added)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/.github/workflows/ci.yml`
- Owner: release engineering

2. Signed evidence bundle export and cryptographic verification metadata were missing.
- Status: fixed (deterministic payload + audit hash-chain + Ed25519 signature metadata + in-app bundle verifier)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/transcription.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/lib.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/db.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/exports-view.tsx`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/lib/tauri.ts`
- Owner: security + export

3. Diarization embedding inference was not implemented in the ONNX embedder path.
- Status: fixed (real ONNX inference + normalized embedding extraction)
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/diarization/embedder.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/diarization/mod.rs`
- Owner: speech intelligence

4. Non-Whisper ASR providers (Parakeet/Canary) remain unavailable in this build and are intentionally excluded from active provider list.
- Status: open
- Files: `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/asr/mod.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/asr/parakeet.rs`, `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src-tauri/src/asr/canary.rs`
- Owner: speech intelligence
