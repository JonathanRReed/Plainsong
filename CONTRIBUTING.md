# Contributing to Nautilus

Thanks for your interest in making Nautilus better. It's a free, open-source,
local-first voice-input app, and contributions of all sizes are welcome.

## Getting set up

```bash
cd nautilus-bot
bun install
bun run dev
```

You'll need [Bun](https://bun.sh) and a stable Rust toolchain. The Rust sidecar
in `nautilus-bot/rust-sidecar/` does audio capture and speech recognition; the
Electron main process is in `nautilus-bot/electron/`; the React UI is in
`nautilus-bot/src/`.

## Before you open a PR

Run the same checks CI runs:

```bash
cd nautilus-bot
bun run lint        # typecheck + cargo fmt --check + clippy -D warnings
bun run test        # Vitest (renderer + Electron)
bun run test:rust   # Rust sidecar unit tests
bun run build:renderer && bun run electron:compile   # production build sanity
```

CI must be green. Clippy is run with `-D warnings`, so warnings are errors.

## Guidelines

- **Keep diffs focused.** One logical change per PR; match the surrounding code
  style rather than reformatting unrelated code.
- **The hot path is sacred.** Changes to the dictation capture → transcribe →
  insert loop should be measured, not guessed. Don't add blocking work to it.
- **Local-first by default.** Anything that sends audio or text off the machine
  must be opt-in, use the user's own keys, and be clearly labeled. Don't add
  telemetry or analytics.
- **No dead UI.** Don't ship buttons that do nothing or shortcut hints that
  aren't wired up.
- **Tests for behavior changes.** If you change transcription/formatting
  behavior, add or update a test that locks it in.

## Reporting bugs and ideas

Open an issue with what you expected, what happened, your OS version, and the
model/provider you were using. For dictation issues, the app records per-session
latency locally — sharing those numbers helps.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

By contributing, you agree your contributions are licensed under the project's
[MIT license](./LICENSE).
