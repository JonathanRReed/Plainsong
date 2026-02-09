# Nautilus Bot

Nautilus is a local-first desktop app for recording, transcribing, and auditing dictation/meeting audio.

## Current Production Scope (2026-02-09)

- Dictation capture via global hotkey
- Meeting recording (microphone, optional system-loopback when available)
- Whisper-based transcription with model download management
- Transcript browsing, speaker labeling, and evidence export/verification
- Local AI analysis via Ollama
- Local backup plus cloud sync integrations (rclone/iCloud paths)

## Capability Status

### ASR Providers

- **Whisper**: enabled in this build (production path)
- **Parakeet**: model download path exists, inference is not enabled in this build
- **Canary**: model download path exists, inference is not enabled in this build

### Diarization

- Diarization command path exists and persists speaker aliases
- Production quality still depends on local model/runtime availability

### System Audio Capture

- Supported through loopback/virtual devices where available
- Availability is environment-dependent and validated at runtime

## Quick Start

### Prerequisites

- Node.js 18+
- Rust toolchain (stable)
- Ollama installed and running for AI analysis flows
- macOS or Windows (Linux may work but is not a GA target in this launch audit)

### Install and Run

```bash
cd nautilus-bot
npm install
npm run tauri dev
```

### Optional AI Setup

```bash
ollama serve
ollama pull llama3.2
```

## Verification Commands

```bash
npm test
npx tsc --noEmit
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo check --all-targets
cargo test --lib
```

## Security Notes

- API secrets are stored through OS credential storage
- Sensitive filesystem command inputs are constrained to approved Nautilus roots
- Renderer no longer directly invokes shell open for recording paths
- Evidence bundle verification enforces approved path boundaries

## Launch Audit Artifacts

- `AUDIT_BASELINE.md`
- `CLAIMS_PARITY_MATRIX.md`
- `LAUNCH_AUDIT_REPORT.md`
- `LAUNCH_CHECKLIST.md`

## Project Layout

```text
nautilus-bot/
  src/          # React + TypeScript UI
  src-tauri/    # Rust backend and Tauri commands
  README.md
```
