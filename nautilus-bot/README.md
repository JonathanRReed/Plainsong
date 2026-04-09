# Nautilus Bot

Nautilus is a local-first desktop app for dictation and meeting capture.

Launch status on 2026-04-09: `NO-GO`.

Launch readiness is tracked in:

- `docs/launch-readiness-dashboard.md`
- `artifacts/launch-readiness-report.json`
- `docs/final-ship-checklist.md`

## Implemented Product Surface (2026-04-09)

- Dictation capture via global hotkey
- Dictation push-to-talk and live partial preview
- Dictation mini window and meeting mini window
- Dictation command mode (prefix-triggered editing commands)
- Dictation snippets (trigger phrase expansion with optional app scoping)
- Context-aware custom modes with app and domain auto-activation
- Dictation history with reprocessing and recovery metadata
- Meeting recording (microphone, optional system-loopback when available)
- Multi-provider transcription (Whisper, Parakeet, Canary, Distil-Whisper, Moonshine, Voxtral, OpenAI Cloud, ElevenLabs Scribe)
- Transcript browsing, speaker labeling, and evidence export/verification
- Local AI analysis via Ollama
- Clipboard restore after paste success
- Local backup plus cloud sync integrations (rclone/iCloud paths)
- Bring-your-own API keys for cloud transcription and analysis providers

This section describes what the codebase currently implements.
It is not the same thing as launch-certified scope.

## Launch-Certified Scope

The certified launch scope is narrower than the implemented surface and is controlled by evidence, not code presence.

- Frozen launch app matrix: `docs/dictation-app-compatibility-matrix.md`
- Frozen launch language set: `docs/evals/dictation-language-certification-matrix.md`
- Launch claim policy: `docs/launch-claim-scope.md`
- Entitlement matrix: `docs/entitlement-matrix.md`

Current state:

- packaged dictation certification is still pending
- packaged meeting certification is still pending
- app-specific launch claims are not yet certified
- language certification is frozen, but packaged evidence is still pending
- cloud providers are optional bring-your-own-key integrations, not fully local workflows

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

## Claim Discipline

- Do not treat implemented features as launch-certified features.
- Do not claim app coverage beyond the frozen launch matrix.
- Do not claim language coverage beyond the frozen certification matrix.
- Do not describe cloud-backed workflows as fully local.
- Do not describe cloud sync as hosted Nautilus storage; it is bring-your-own-cloud only.

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
Use `bun run gate:launch:report` to regenerate the launch dashboard and machine-readable launch status report.
Use `bun run electron:build:mac` only on macOS, and `bun run electron:build:win` only on Windows.

## Security Notes

- API secrets are stored through OS credential storage
- Sensitive filesystem command inputs are constrained to approved Nautilus roots
- Renderer no longer directly invokes shell open for recording paths
- Evidence bundle verification enforces approved path boundaries

## Launch Audit Artifacts

- `docs/launch-readiness-dashboard.md`
- `docs/launch-claim-scope.md`
- `docs/entitlement-matrix.md`
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
