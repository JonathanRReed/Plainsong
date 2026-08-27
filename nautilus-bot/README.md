# Plainsong (app)

**Free, open-source, local-first dictation and meeting capture for macOS.**

- **Website:** https://plainsong.jonathanrreed.com
- **Project repository:** https://github.com/JonathanRReed/Plainsong (currently private)
- **Release target:** Private `0.9.0-beta.2` integration candidate. No public build is available yet.

This directory contains the Plainsong desktop app: the Electron main process,
the React/TypeScript renderer, and the Rust transcription sidecar.

For the product overview, privacy posture, and contribution guide, see the
[repository root](../README.md), [PRIVACY.md](../PRIVACY.md), and
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What it is

Press a hotkey, speak, and your words appear at the cursor in any app,
transcribed on your own machine. Meetings are recorded, transcribed, and turned
into searchable notes without sending a bot into the call.

- **Local-first.** Speech recognition runs on-device by default via whisper.cpp
  (`base.en`); no account and no audio leaves your machine unless you opt in.
- **Bring your own keys.** Optional cloud transcription and AI cleanup use your
  own provider keys, stored in the OS keychain and sent directly to the
  provider, never through a Plainsong server.
- **Honest about the beta.** Three dictation activation modes ship: **toggle** (the
  onboarding default), **hold-to-talk** (selectable in Settings; a native
  CGEventTap helper with automatic fallback to toggle if the helper isn't
  running), and **hands-free** (VAD auto start/stop, with an optional Silero
  VAD model download for better accuracy). The beta requires **macOS 13 or later**
  and is **arm64-only**.
- **MIT licensed**, no trial, no tiers, no nags.

## Layout

```text
nautilus-bot/
  src/            React + TypeScript renderer (UI)
  electron/       Electron main process (windows, hotkey, IPC bridge, updates)
  rust-sidecar/   Rust backend: audio capture, ASR engines, dictation pipeline,
                  meetings, diarization, LLM clients, storage
  scripts/        dev, build, packaging, and packaged-app QA scripts
  docs/           developer/setup docs (code signing, app compatibility)
  build-resources/  icons and entitlements
```

The renderer talks to the sidecar through a sandboxed Electron preload that
exposes only an explicit command allowlist (`electron/ipc-bridge.ts`); the
allowlist is checked against the sidecar's actual command handlers in CI
(`scripts/verify-ipc-contract.mjs`).

## Develop

```bash
bun install
bun run sidecar:build:release   # build the Rust transcription sidecar (required once)
bun run dev
```

Or run `./setup.sh`, which checks prerequisites and does the equivalent.
Without the sidecar build, the app starts but shows a "Plainsong sidecar not
found" error. (The macOS hold-to-talk shortcut helper builds automatically
during packaging; it is optional in dev.)

Optional, for on-device AI cleanup:

```bash
ollama serve
ollama pull qwen3.5:4b
```

## Build

```bash
bun run electron:build          # current platform
bun run electron:build:mac      # macOS (run on macOS)
bun run release:mac             # build the macOS DMG, ZIP, and updater metadata
```

`release:mac` never publishes. The artifact-staging release workflow requires
Developer ID signing and Apple notarization credentials, builds without direct
publication, verifies signatures, stapling, Gatekeeper, updater metadata, TCC
usage strings, and size, then creates or refreshes an artifact-only draft
GitHub release. That draft is not a beta-ready verdict because real-hardware,
clean-install, updater-journey, and soak evidence remain in the aggregate
release audit. A missing credential or failed artifact trust check stops the
workflow before any release asset reaches GitHub.

The current release target is `0.9.0-beta.2`, with Dictation and Meetings both
treated as supported pillars. A release is not ready merely because source
tests pass. The exact DMG, update ZIP, `beta-mac.yml`, clean-install journey,
real-device Dictation and Meetings journeys, signing, notarization, Gatekeeper,
and beta updater flow must all pass against the same candidate. Historical
`1.0.0` and `0.9.0-beta.1` receipts do not prove this revision. Fresh aggregate
evidence will be generated after integration and packaging. The exact-candidate
updater journey and public beta update feed remain distribution gates. The
repository is private and no beta has been distributed. See
[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) and
[docs/APPLE_DEVELOPER_SETUP.md](docs/APPLE_DEVELOPER_SETUP.md).

## Verify

```bash
bun run lint        # typecheck + cargo fmt --check + clippy -D warnings
bun run test        # Vitest (renderer + Electron)
bun run test:rust   # Rust library and operator-binary unit tests
bun run gate:ipc-contract
bun run gate:release:local   # source checks + local package build
bun run qa:packaged:macos:update-metadata
bun run gate:release:macos:trust
```

Use `bun run test` (Vitest), not `bun test`.

## Measuring real dictation latency

`benchmark:latency` runs a fixture WAV through the actual transcription path and
reports measured wall-clock latency, conventional real-time factor, and
real-time speedup. It requires the selected model to be downloaded:

```bash
bun run benchmark:latency -- --help
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
# {"transcriptionMsP50":593,"transcriptionMsP95":600,
#  "realTimeFactor":0.01,"realtimeSpeedup":74.4,...}
```

Real-time factor is `transcription seconds / audio seconds`, so lower is
faster. `realtimeSpeedup` is its inverse and is easier to read as "times faster
than real time." The JSON receipt also includes the canonical fixture path,
SHA-256, byte count, audio duration, warm-up time, every timed measurement,
p50, p95, run count, model, provider, and transcript sample.

The default fixture is `scripts/fixtures/real-speech-44s.wav`, which contains
44 seconds of real spoken speech. The numbers above were measured with
whisper.cpp `base.en` using Metal on Apple Silicon. Earlier documentation cited
about 137 ms p50 and about 218 times real-time on a pure sine-tone fixture.
That is not representative of dictation and must not be quoted as a product
result.

This replaces an earlier "benchmark" that multiplied fixture numbers by a CLI
flag. Invalid providers, model/provider combinations, run counts, flags, and
fixture paths now fail before model initialization instead of silently
changing the requested benchmark.

## ASR providers

Speech recognition runs locally by default (Whisper via whisper.cpp, plus other
native engines). Optional bring-your-own-key cloud providers (OpenAI,
ElevenLabs, Groq, Cohere) are supported. Keys are stored in the OS
keychain and requests go directly to the provider, never through a Plainsong
server.

Ollama is **not** a speech-recognition provider here — there is no Ollama
engine in `rust-sidecar/src/asr/`. It is the default *analysis* provider (local
meeting summaries and action items).
