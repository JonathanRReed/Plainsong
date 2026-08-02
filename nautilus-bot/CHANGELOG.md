# Changelog

All notable changes to Plainsong are documented in this file.

## [1.0.0] - 2026-07 (unreleased)

The free, open-source relaunch. The previously commercial app (NautilusBot /
Nautilus) was rebuilt as **Plainsong** — MIT licensed, no trial, no tiers,
no telemetry. macOS on Apple Silicon (arm64) only for v1.

### Added
- **Hold-to-talk dictation**: true press-and-hold via a native macOS
  CGEventTap helper, with automatic fallback to toggle if the helper is
  unavailable.
- **Hands-free dictation**: voice-activity auto start/stop, with an optional
  Silero VAD (ONNX) model download for higher accuracy than the built-in
  energy-threshold gate.
- **Destination-app-aware AI formatting**: dictation cleanup adapts to the app
  being dictated into (email, messaging, AI chat, code editor, notes), with
  per-app overrides.
- **Voice/palette editing of selected text**: Cmd+K commands (shorten, expand,
  proofread, tone rewrite, translate, and more) that replace the selection in
  place.
- **Live streaming partials**: words appear in the overlay as you speak
  (UI-only; never changes the inserted text).
- **Menu-bar tray** with Open/Quit and a minimize-to-tray setting; multi-monitor
  and notch-aware placement for the dictation/recording overlays.
- **Shortcut-conflict detection** with an inline warning in Settings.
- Dictionary/snippet **category scoping**, a "recently learned" list, and a
  capitalization-only quick action.
- Real dictation latency benchmark (`bun run benchmark:latency`) measured on a
  real spoken-speech fixture (`scripts/fixtures/real-speech-44s.wav`).

### Changed
- **Renamed** end-to-end to Plainsong: bundle id `com.plainsong.app`, sidecar
  binary `plainsong-sidecar`, data directory, and all brand text (pre-launch,
  so no data migration).
- Renderer restyled to the manuscript brand (see `STYLE.md`); themes collapsed
  to two.
- Default local route is whisper.cpp (Metal) `base.en`; hot path
  unblocked (concurrent JSON-RPC dispatch, model pre-warm, in-process
  frontmost-app lookup).

### Removed
- All commercial licensing, trial, nag, and entitlement code.
- Telemetry/analytics: none ship; keys live in the OS keychain; dictation audio
  is never persisted (see `../PRIVACY.md`).

## [Pre-relaunch] - 2026-03-02

Work recorded before the rename to Plainsong; names below reflect the app as it
was then.

### Added
- Added benchmark launch gate verifier (`scripts/verify-benchmark-gates.mjs`) for CP-13/CP-14/CP-15 thresholds.
- Added benchmark gate artifact schema (`docs/ci/schemas/benchmark-gate-result.schema.json`).
- Added owner/evidence placeholders across all packaged QA matrix rows.

### Changed
- Updated release cold-start gate process matcher to target the then-current packaged binary `nautilus-bot` (now `plainsong-sidecar`).
- Updated competitor parity command docs (the project has since standardized on bun).
- Updated release/prelaunch readiness docs with current gate status and blockers.
- Improved artifact validator support for `date-time` formats and regex `pattern`.
- Stabilized the recordings view cross-meeting recall test so it waits for the recall button before clicking ([PR #9](https://github.com/JonathanRReed/Plainsong/pull/9)).

### Security
- Updated lockfile dependencies to remediate Rollup path traversal advisory.
