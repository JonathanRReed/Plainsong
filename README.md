# Nautilus

**Free, open-source, local-first voice input for your whole computer.**

Nautilus is a desktop app for fast system-wide dictation and bot-free meeting
capture. Press a hotkey, speak, and your words appear at the cursor in any app —
transcribed on your own machine. Meetings are recorded, transcribed, and turned
into searchable notes without sending a bot into your call.

- **Local-first.** Transcription runs on your Mac by default. No account, no
  cloud dependency, no audio leaving your machine unless you opt in.
- **Bring your own keys.** Optional cloud transcription and AI cleanup use your
  own OpenAI / Anthropic / Mistral / ElevenLabs / Groq keys — billed to you,
  stored in the OS keychain, never routed through our servers.
- **Actually free and open.** MIT licensed, no trial, no tiers, no nags. Build
  it yourself or download a release.

> Status: this is an active rebuild of a previously commercial app into a fully
> free, open-source project. macOS is the primary target today; Windows and
> Linux are on the roadmap.

## Features

- System-wide dictation via a global hotkey, with a focus-preserving overlay
- Local speech recognition (Whisper and other engines) with optional BYOK cloud
- Dictation modes, snippets, a personal dictionary, and editing commands
- Meeting recording (microphone, plus system audio where available), transcript
  review, summaries, action items, and cross-meeting search
- Optional local AI analysis via Ollama, or BYOK cloud providers

## Quick start

The app lives in [`nautilus-bot/`](./nautilus-bot/).

```bash
cd nautilus-bot
bun install
bun run dev
```

### Prerequisites

- [Bun](https://bun.sh)
- Rust toolchain (stable) — builds the local transcription sidecar
- macOS (Windows/Linux are not yet GA targets)
- Optional: [Ollama](https://ollama.com) running locally for on-device AI cleanup

## Verifying a change

```bash
cd nautilus-bot
bun run lint        # typecheck + cargo fmt + clippy
bun run test        # renderer/Electron tests (Vitest)
bun run test:rust   # Rust sidecar unit tests
```

Use `bun run test` (Vitest), not `bun test`.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Security
reports go to [SECURITY.md](./SECURITY.md). What the app does and does not do
with your audio is documented in [PRIVACY.md](./PRIVACY.md).

## License

[MIT](./LICENSE) © 2026 Jonathan Reed
