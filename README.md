# Plainsong

Dictate into other apps and record meetings without a bot joining the call. Plainsong transcribes on your Mac by default and turns recordings into searchable notes.

[Website](https://plainsong.jonathanrreed.com) · [Releases](https://github.com/JonathanRReed/Plainsong/releases) · [Privacy](PRIVACY.md)

![Dictation workspace](docs/images/plainsong-dictation.png)

The app is free and MIT-licensed, with no trial, paid tiers, or required account. Optional cloud transcription and AI cleanup use your own provider keys, stored in the OS keychain. Those requests go to the selected provider, not through a Plainsong server. Local transcription remains the default.

## Install the beta

`0.9.0-beta.4` requires macOS 13+ on Apple Silicon. Windows and Linux are planned, not supported release targets.

Download [Plainsong-0.9.0-beta.4-arm64.dmg](https://github.com/JonathanRReed/Plainsong/releases/download/v0.9.0-beta.4/Plainsong-0.9.0-beta.4-arm64.dmg), then verify it:

```bash
shasum -a 256 Plainsong-0.9.0-beta.4-arm64.dmg
```

Expected SHA-256:

```text
28f1b1a42306095afe36b24c126a42ec060f7e5a1a22b37e1d0b2bceee759cb4
```

The file is 136,566,773 bytes, Developer ID signed, notarized, and stapled. Drag `Plainsong.app` into `/Applications` and open it there. No macOS security bypass is required.

Grant Microphone access for recording and Accessibility access for text insertion. Download the default Parakeet TDT 0.6B v3 model, 640 MB, or the smaller Whisper `base.en`, 142 MB.

### Known limits

Read transcripts before relying on them and keep your own backups. In the last two documented maker tests, toggle and hold-to-talk passed but hands-free dictation did not activate. Meetings longer than 45 seconds have not been soak-tested.

As of the September 5, 2026 release, the real-hardware dictation matrix, long meeting tests, and updater journey remain unfinished. There is no 1.0 or Homebrew cask yet.

The app's update target is `https://updates.plainsong.jonathanrreed.com/beta/`, backed by [infra/updates-worker](infra/updates-worker/). Its configuration is not proof of a qualified end-to-end update path. [Homebrew plan](nautilus-bot/docs/homebrew.md).

## Use it

Press the global hotkey to dictate. Activation options are toggle, hold-to-talk through a native listener, and the currently unqualified hands-free mode. Dictation tools include snippets, a personal dictionary, modes, and editing commands.

Meeting capture records the microphone and system audio where available. Review transcripts, summaries, and action items, or search across meetings. AI analysis can use local Ollama or an explicitly configured cloud provider.

![Meetings workspace](docs/images/plainsong-meetings.png)

## Build from source

The app lives in `nautilus-bot/`. Install Bun, stable Rust, CMake, and Xcode Command Line Tools with `xcrun` and `swiftc`. The command-line tools installer is `xcode-select --install`.

```bash
cd nautilus-bot
bun install
bun run sidecar:build:release
bun run dev
```

`./setup.sh` in that directory checks prerequisites and runs the setup. Ollama is optional for local AI cleanup.

## Verify and contribute

From `nautilus-bot/`:

```bash
bun run lint
bun run test
bun run test:rust
```

Lint includes type checking, Cargo formatting, and Clippy. Renderer and Electron tests use Vitest through `bun run test`, not `bun test`.

[Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [Privacy](PRIVACY.md)

## License

[MIT](LICENSE) © 2026 Jonathan Reed
