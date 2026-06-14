# Launch checklist

Honest state of launch readiness for Plainsong. Everything that can be verified
without a physical machine + microphone is done and green; the rest is listed
explicitly so nothing is assumed.

## Done (verified in-repo)

- **Free & open-source**: all commercial licensing/trial/nag/entitlement code
  removed; MIT LICENSE present.
- **Compiles & passes CI gates**: `cargo clippy -D warnings` clean, 235 Rust
  unit tests, 173 vitest, typecheck (both tsconfigs), IPC contract, knip,
  rustfmt — all green. CI runs the shipped default feature set + a production
  build.
- **Fast default route**: whisper.cpp (Metal/CoreML) `base.en`; measured
  ~137 ms p50 / ~218× real-time on Apple Silicon via `bun run benchmark:latency`.
- **Hot path unblocked**: concurrent JSON-RPC dispatch, model pre-warm on start,
  in-process frontmost-app lookup (no osascript spawn), reduced insertion sleeps.
- **Live streaming partials**: words appear as you speak; UI-only and safe by
  construction (never changes the inserted text); hardened by a 4-reviewer pass.
- **Honest UI**: no fabricated stats, no dead shortcuts, dictation-first default.
- **Privacy by architecture**: no telemetry, keys in OS Keychain, dictation
  audio never persisted; documented vs competitors in PRIVACY.md.
- **macOS TCC**: `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`
  added to the packaged Info.plist (without these macOS kills the app on mic use).
- **Renamed to Plainsong** end-to-end (bundle id `com.plainsong.app`, data dir,
  binary `plainsong-sidecar`, all brand text); pre-launch so no data migration.
- **Release pipeline**: electron-builder workflow that signs/notarizes when the
  secrets are present and otherwise publishes an unsigned build. macOS is
  **arm64-only for v1** (the Rust sidecar is host-arch; Intel needs per-arch
  cross-compiles — tracked).
- **Packaged build verified**: `electron:build:mac` produces `Plainsong.app`
  with bundle id `com.plainsong.app`, both TCC usage strings in the Info.plist,
  and the arm64 `plainsong-sidecar` bundled in `Resources/sidecar/`.
- **Honest hotkey UI**: v1 exposes **toggle** mode only across all surfaces
  (settings, dictation view, onboarding default); the broken hold-to-talk/
  hands-free options are removed (they need a native key listener — fast-follow).
- **App icon**: a clean Plainsong placeholder (single line + note). Replace with
  final designed art before a marketing push, but it is no longer old-project art.

## Must be validated on a real Mac (cannot be done headlessly)

These are not known-broken — they are simply unproven without a machine + mic.
Expect this pass to surface a couple of small fixes; that's normal.

1. **Produce the packaged build and launch it**: confirm it opens, the bundled
   `plainsong-sidecar` spawns, and a dictation round-trips end to end.
2. **Permissions flow**: grant Microphone + Accessibility on first run and
   confirm dictation captures and inserts into other apps.
3. **First-run model download**: confirm `base.en` downloads and transcribes on
   a clean machine.
4. **Streaming-partials feel**: tune the 700 ms tick / 0.5 s min / 30 s window /
   greedy decode on real speech; it's on by default via Live Preview.
5. **Real-app insertion** across the apps you care about (Slack, browser, IDE,
   Notes).

## Known gaps (not hard blockers)

- **Hold-to-talk / hands-free**: real press-and-hold needs a native key listener
  (Electron global shortcuts are press-only); v1 ships honest **toggle** mode.
  Real hold-to-talk is the top fast-follow (needs keyboard validation).
- **App icon** is a clean placeholder mark — replace with final designed art
  before a marketing push (`build-resources/icon.icns` / `.ico` / `.png`).
- **`nautilus-bot/` directory name** retained (CI working-directory depends on
  it); repo-flatten is a separate cleanup.

## Done since the first checklist

- ✅ **`oss-relaunch` branch pushed** to `github.com/JonathanRReed/Plainsong`.
- ✅ **GitHub repo renamed** `NautilusBot → Plainsong`; local remote updated, so
  the publish/auto-update URLs now resolve.

## Remaining — physically require a human (no AI can do these)

- **One on-device validation run**: launch the app on a Mac, grant Microphone +
  Accessibility, **speak into the mic**, confirm dictation inserts into real
  apps, watch the first-run `base.en` download, feel the streaming. (Needs voice
  + GUI permission grants — cannot be automated.)
- **Register `plainsong.app` + grab `@plainsong` handles** (needs payment/accounts).
- **Attorney USPTO TSDR clearance** (Classes 9 + 42) — confirmation, not
  investigation; the name vetted clean in-category. (Needs a lawyer.)
- **$99 Apple Developer ID** → signed + notarized releases (the pipeline already
  uses the secrets when present).
