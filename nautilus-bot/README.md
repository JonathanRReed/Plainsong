# Nautilus Bot

Nautilus is a local-first desktop app for recording, transcribing, and auditing dictation/meeting audio.

## Current Production Scope (2026-02-21)

- Dictation capture via global hotkey
- Dictation command mode (prefix-triggered editing commands)
- Dictation snippets (trigger phrase expansion with optional app scoping)
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

- Bun
- Rust toolchain (stable)
- Ollama installed and running for AI analysis flows
- macOS or Windows (Linux may work but is not a GA target in this launch audit)

### Install and Run

```bash
cd nautilus-bot
bun install
bun run dev
```

### Optional AI Setup

```bash
ollama serve
ollama pull llama3.2
```

## Verification Commands

```bash
bun run lint
bun run test
bun run typecheck
bun run electron:compile
bun run electron:build
bun run electron:build:mac
bun run electron:build:win
bun run gate:release:local
bun run gate:blockers:refresh
cargo build --manifest-path rust-sidecar/Cargo.toml --bin nautilus-sidecar --release
cargo fmt --manifest-path rust-sidecar/Cargo.toml --check
cargo clippy --manifest-path rust-sidecar/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path rust-sidecar/Cargo.toml --all-targets
cargo test --manifest-path rust-sidecar/Cargo.toml --lib
cargo test --manifest-path rust-sidecar/Cargo.toml --tests
```

Use `bun run test`, not `bun test`. The repo test runner is Vitest.
Use `bun run gate:release:local` for the current-platform local release verification pass.
Use `bun run gate:blockers:refresh` to regenerate the blocker JSON and packaged QA evidence bundle from the current repo state.
Use `bun run electron:build:mac` only on macOS, and `bun run electron:build:win` only on Windows.

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
  rust-sidecar/ # Rust backend (sidecar binary)
  electron/     # Electron main process
  build-resources/
  README.md
```
