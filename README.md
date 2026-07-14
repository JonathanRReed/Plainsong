# Plainsong

**Free, open-source, local-first voice input for your whole computer.**

**[Website](https://plainsong.jonathanrreed.com)** ·
**[Download](https://github.com/JonathanRReed/Plainsong/releases)** ·
**[Privacy](./PRIVACY.md)** · **[Contributing](./CONTRIBUTING.md)**

Plainsong is a desktop app for fast system-wide dictation and bot-free meeting
capture. Press a hotkey, speak, and your words appear at the cursor in any app —
transcribed on your own machine. Meetings are recorded, transcribed, and turned
into searchable notes without sending a bot into your call.

<!-- TODO(launch): add hero screenshot / short dictation GIF here after the UI
     overhaul lands — dictation overlay inserting into a real app. -->

- **Local-first.** Transcription runs on your Mac by default. No account, no
  cloud dependency, no audio leaving your machine unless you opt in.
- **Bring your own keys.** Optional cloud transcription and AI cleanup use your
  own keys for providers such as OpenAI, Anthropic, Mistral, ElevenLabs, Groq,
  Cohere, DeepSeek, and Gemini — billed to you, stored in the OS keychain,
  never routed through our servers.
- **Actually free and open.** MIT licensed, no trial, no tiers, no nags. Build
  it yourself or download a release.

> Status: this is an active rebuild of a previously commercial app into a fully
> free, open-source project. macOS is the primary target today; Windows and
> Linux are on the roadmap.

## Features

- System-wide dictation via a global hotkey, with a focus-preserving overlay
- Three activation modes: toggle, hold-to-talk (native key listener), and
  hands-free voice-activity detection
- Local speech recognition (Whisper and other engines) with optional BYOK cloud
- Dictation modes, snippets, a personal dictionary, and editing commands
- Meeting recording (microphone, plus system audio where available), transcript
  review, summaries, action items, and cross-meeting search
- Optional local AI analysis via Ollama, or BYOK cloud providers

<!-- TODO(launch): add 2-3 app screenshots here (dictation view, meeting notes,
     settings) after the UI overhaul lands. -->

## Install

Plainsong v1 runs on **macOS on Apple Silicon (arm64)**.

1. Download the latest DMG or zip from
   [GitHub Releases](https://github.com/JonathanRReed/Plainsong/releases).
2. Drag `Plainsong.app` into `/Applications`.
3. **If the build is unsigned** (no Apple Developer ID yet), macOS Gatekeeper
   will block the first launch. Either right-click the app and choose
   **Open** (then confirm), or clear the quarantine attribute once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Plainsong.app
   ```

   Unsigned builds also can't self-update — the in-app updater will link you
   back to GitHub Releases for new versions.
4. On first run, grant Microphone (to hear you) and Accessibility (to insert
   text into other apps), and let it download the `base.en` model.

Homebrew: planned — a cask will be submitted once the first release is
published (see [nautilus-bot/docs/homebrew.md](./nautilus-bot/docs/homebrew.md)).

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
