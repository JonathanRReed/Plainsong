# Plainsong (app)

**Free, open-source, local-first dictation and meeting capture for macOS.**

- **Website:** https://plainsong.jonathanrreed.com
- **Project repository:** https://github.com/JonathanRReed/Plainsong
- **Release target:** `0.9.0-beta.7` source candidate. Publication and package qualification need separate receipts.

This directory contains the Plainsong desktop app: the Electron main process,
the React/TypeScript renderer, and the Rust transcription sidecar.

For the product overview, privacy posture, and contribution guide, see the
[repository root](../README.md), [PRIVACY.md](../PRIVACY.md), and
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What it is

Press a hotkey, speak, and your words appear at the cursor in supported apps,
transcribed on your own machine. Meetings are recorded, transcribed, and turned
into searchable notes without sending a bot into the call.

- **Local-first.** Speech recognition runs on-device by default. New installs
  on Apple Silicon dictate and record meetings with Parakeet TDT 0.6B v3,
  one download for both: the Core ML build on macOS 14 or later (about
  735 MB, 567 MB for English), otherwise the 739 MB GGUF through
  transcribe.cpp; other Macs
  use the ONNX build of the same model, about 670 MB. whisper.cpp `base.en`,
  about 148 MB, is offered as a smaller download, and existing installs keep the model they
  had configured. No account and no audio leaves your machine unless you
  opt in.
- **Optional cloud processing.** Cloud transcription and AI cleanup can use
  your own provider keys, stored in the OS keychain. ChatGPT sign-in is a
  separate, text-only preview that has not yet been qualified with a real
  account in the installed app. Requests go to the selected provider, not
  through a Plainsong server.
- **Honest about the beta.** The candidate includes three dictation activation modes: **toggle** (the
  onboarding default), **hold-to-talk** (selectable in Settings; a native
  CGEventTap helper with automatic fallback to toggle if the helper isn't
  running), and **hands-free** (VAD auto start/stop, with an optional Silero
  speech-detection model download). The beta requires **macOS 13 or later**
  and is **arm64-only**.
- **Yours from the terminal, too.** An off-by-default `plainsong` command
  reads your meetings, transcripts and dictation history (`list`, `search`,
  `show`, `transcript`, `export`, `dictations`, `stats`), serves them to
  Claude Desktop, Claude Code or Cursor as a local, read-only MCP server
  (`plainsong mcp`), and `plainsong://` links drive dictation and meeting
  start/stop from Raycast or Shortcuts. No account, no history cap, no write
  path; transcript text reaches an assistant wrapped as untrusted content.
  See [docs/automation.md](docs/automation.md).
- **Free and MIT-licensed.** No paid tier, account or billing.

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
(`scripts/verify-ipc-contract.ts`).

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

The source version is `0.9.0-beta.7`, with dictation and meetings as its two
product pillars. Source checks do not establish publication, installation,
permissions, insertion, capture or updater behavior. Those require receipts
for the exact delivered package. See [LAUNCH.md](../LAUNCH.md),
[beta.7 evidence](docs/evals/beta7-evidence.md) and
[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

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

With Bun 1.4.3 or newer, `bun run typecheck:bun` checks the renderer and
Electron configurations with Bun's built-in TypeScript checker. It uses one
thread for shared machines. The existing `bun run typecheck` remains the
standard check, and TypeScript still compiles Electron.

For a focused development check, run
`bun check --threads 1 src/components/views/exports-view.tsx`. This checks the
file and its imports using the project configuration. Run the full project
check before treating a change as verified, since callers can break too.

## Measuring real dictation latency

`benchmark:latency` runs a fixture WAV through the actual transcription path and
reports measured wall-clock latency, conventional real-time factor, and
real-time speedup. It requires the selected model to be downloaded:

```bash
bun run benchmark:latency -- --help
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
# Example output only, not a beta.7 measurement:
# {"transcriptionMsP50":593,"transcriptionMsP95":600,
#  "realTimeFactor":0.01,"realtimeSpeedup":74.4,...}
```

Real-time factor is `transcription seconds / audio seconds`, so lower is
faster. `realtimeSpeedup` is its inverse and is easier to read as "times faster
than real time." The JSON receipt also includes the canonical fixture path,
SHA-256, byte count, audio duration, warm-up time, every timed measurement,
p50, p95, run count, model, provider, and transcript sample.

The default fixture is `scripts/fixtures/real-speech-44s.wav`, which contains
44 seconds of real spoken speech. The example above shows the output fields.
No candidate-bound receipt backs those numbers, so do not quote them as
measured beta.7 latency. Earlier documentation cited
about 137 ms p50 and about 218 times real-time on a pure sine-tone fixture.
That is not representative of dictation and must not be quoted as a product
result.

This replaces an earlier "benchmark" that multiplied fixture numbers by a CLI
flag. Invalid providers, model/provider combinations, run counts, flags, and
fixture paths now fail before model initialization instead of silently
changing the requested benchmark.

## ASR providers

Speech recognition runs locally by default: Parakeet TDT 0.6B v3 is the
recommended default model for dictation and meetings (in GGUF through
transcribe.cpp on Apple Silicon, ONNX elsewhere), with Whisper (via whisper.cpp),
Distil-Whisper, Moonshine, and other native engines available as
alternatives. Optional bring-your-own-key cloud providers (OpenAI,
ElevenLabs, Groq, Cohere, Deepgram, Google Gemini, Mistral, xAI) are
supported. Keys are stored in the OS
keychain and requests go directly to the provider, never through a Plainsong
server.

Ollama is **not** a speech-recognition provider here — there is no Ollama
engine in `rust-sidecar/src/asr/`. It is the default *analysis* provider (local
meeting summaries and action items).
