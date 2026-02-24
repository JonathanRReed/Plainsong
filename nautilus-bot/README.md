# Nautilus Bot

Nautilus is a local-first desktop app for recording, transcribing, and auditing dictation/meeting audio.

## Current Production Scope (2026-02-21)

- Dictation capture via global hotkey
- Meeting recording (microphone, optional system-loopback when available)
- Multi-provider transcription (Whisper, Parakeet, Canary, Distil-Whisper, Moonshine, Voxtral, OpenAI Cloud, ElevenLabs Scribe)
- Transcript browsing, speaker labeling, and evidence export/verification
- Local AI analysis via Ollama
- Local backup plus cloud sync integrations (rclone/iCloud paths)

## Capability Status

### ASR Providers

- **Whisper**: enabled in this build (production path)
- **Parakeet**: native ONNX inference (`encoder.onnx` + `tokens.txt`)
- **Canary**: native Candle inference
- **Distil-Whisper**: native Candle inference
- **Moonshine**: native ONNX inference
- **Voxtral**: explicit local mode (Python bridge) and cloud mode (Mistral API)
- **OpenAI Cloud**: live API transcription
- **ElevenLabs Scribe**: live API transcription

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
cargo test --tests
node ../scripts/live-cloud-asr-smoke.mjs
```

## Security Notes

- API secrets are stored through OS credential storage
- Sensitive filesystem command inputs are constrained to approved Nautilus roots
- Renderer no longer directly invokes shell open for recording paths
- Evidence bundle verification enforces approved path boundaries

## Launch Audit Artifacts

- `docs/prelaunch-readiness.md`
- `docs/prelaunch-action-checklist.md`
- `docs/competitor-parity-gates.md`
- `docs/release-gate-evidence.md`
- `docs/packaged-app-qa-matrix.md`

## Project Layout

```text
nautilus-bot/
  src/          # React + TypeScript UI
  src-tauri/    # Rust backend and Tauri commands
  README.md
```
