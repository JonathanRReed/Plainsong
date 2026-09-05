# Plainsong

**Free, open-source, local-first voice input for your whole computer.**

**[Website](https://plainsong.jonathanrreed.com)** ·
**[Releases](https://github.com/JonathanRReed/Plainsong/releases)** ·
**[Privacy](./PRIVACY.md)** · **[Contributing](./CONTRIBUTING.md)**

Plainsong is a desktop app for fast system-wide dictation and bot-free meeting
capture. Press a hotkey, speak, and your words appear at the cursor in any app,
transcribed on your own machine. Meetings are recorded, transcribed, and turned
into searchable notes without sending a bot into your call.

![Plainsong dictation workspace](./docs/images/plainsong-dictation.png)

- **Local-first.** Transcription runs on your Mac by default. No account, no
  cloud dependency, no audio leaving your machine unless you opt in.
- **Bring your own keys.** Optional cloud transcription and AI cleanup use your
  own keys for providers such as OpenAI, Anthropic, ElevenLabs, Groq,
  Cohere, DeepSeek, and Gemini. Usage is billed to you, keys are stored in the OS keychain,
  never routed through our servers.
- **Actually free and open.** MIT licensed, no trial, no tiers, no nags. The
  source is public, and a signed, notarized 0.9 beta 4 build is downloadable
  from [Releases](https://github.com/JonathanRReed/Plainsong/releases). A 1.0
  will follow the remaining beta qualification gates.

> Status: this is an active rebuild of a previously commercial app into a fully
> free, open-source project. macOS is the primary target today; Windows and
> Linux are on the roadmap.

## Features

- System-wide dictation via a global hotkey, with a focus-preserving overlay
- Three activation modes: toggle, hold-to-talk (native key listener), and
  hands-free voice-activity detection
- Local speech recognition (Parakeet by default, plus Whisper and other
  engines) with optional BYOK cloud
- Dictation modes, snippets, a personal dictionary, and editing commands
- Meeting recording (microphone, plus system audio where available), transcript
  review, summaries, action items, and cross-meeting search
- Optional local AI analysis via Ollama, or BYOK cloud providers

![Plainsong meetings workspace](./docs/images/plainsong-meetings.png)

## Install

Plainsong `0.9.0-beta.4` targets **macOS 13 or later on Apple Silicon
(arm64)**. It is a beta: keep your own backups, read a transcript before you
rely on it, and expect the interface to change between builds. Hands-free
dictation did not activate in the maker's last two test runs (toggle and
hold-to-talk passed), and meetings longer than 45 seconds have not been
soak-tested yet.

> Status, September 5, 2026: the source and the beta 4 release are public. The
> real-hardware Dictation matrix, the Meeting soak, and the updater journey are
> still owed before a 1.0.

1. Download
   [`Plainsong-0.9.0-beta.4-arm64.dmg`](https://github.com/JonathanRReed/Plainsong/releases/download/v0.9.0-beta.4/Plainsong-0.9.0-beta.4-arm64.dmg)
   (136,566,773 bytes) and check it:
   `shasum -a 256 Plainsong-0.9.0-beta.4-arm64.dmg` must print
   `28f1b1a42306095afe36b24c126a42ec060f7e5a1a22b37e1d0b2bceee759cb4`.
   The DMG is Developer ID signed, notarized, and stapled, so macOS opens it
   without any bypass.
2. Drag `Plainsong.app` into `/Applications` and open it from there.
3. On first run, grant Microphone access so Plainsong can hear you and
   Accessibility access so it can insert text into other apps. Then let it
   download the recommended default model, Parakeet TDT 0.6B v3 (640 MB);
   Whisper `base.en` (142 MB) is offered as a smaller, less accurate
   alternative.

Updates: an installed app checks `https://updates.plainsong.jonathanrreed.com/beta/`
when you ask it to; that feed follows the GitHub releases (see
[infra/updates-worker](./infra/updates-worker/)). Homebrew is planned after 1.0
(see [nautilus-bot/docs/homebrew.md](./nautilus-bot/docs/homebrew.md)).

## Quick start (from source)

The app lives in [`nautilus-bot/`](./nautilus-bot/).

```bash
cd nautilus-bot
bun install
bun run sidecar:build:release   # build the Rust transcription sidecar (required once)
bun run dev
```

Or run `./setup.sh` inside `nautilus-bot/`, which checks prerequisites and does
the equivalent.

### Prerequisites

- [Bun](https://bun.sh)
- Rust toolchain (stable), which builds the local transcription sidecar
- [CMake](https://cmake.org/)
- Xcode Command Line Tools, including `xcrun` and the Swift compiler (`swiftc`);
  install them with `xcode-select --install`
- macOS 13 or later on Apple Silicon (Windows/Linux are not yet GA targets)
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

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). Security
reports go to [SECURITY.md](./SECURITY.md). What the app does and does not do
with your audio is documented in [PRIVACY.md](./PRIVACY.md).

## License

[MIT](./LICENSE) © 2026 Jonathan Reed
