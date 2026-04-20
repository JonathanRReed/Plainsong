# NautilusBot

NautilusBot is a local-first desktop app for dictation and meeting capture.

The actual app lives in [`nautilus-bot/`](./nautilus-bot/), which contains the Electron app, Rust sidecar, UI, tests, and launch-readiness docs.

## Quick Start

```bash
cd nautilus-bot
bun install
bun run dev
```

## Verification

```bash
cd nautilus-bot
bun run lint
bun run test
bun run typecheck
```

## Main Docs

- [`nautilus-bot/README.md`](./nautilus-bot/README.md)
- [`nautilus-bot/docs/prelaunch-readiness.md`](./nautilus-bot/docs/prelaunch-readiness.md)
- [`nautilus-bot/docs/final-ship-checklist.md`](./nautilus-bot/docs/final-ship-checklist.md)
- [`nautilus-bot/docs/launch-readiness-dashboard.md`](./nautilus-bot/docs/launch-readiness-dashboard.md)
