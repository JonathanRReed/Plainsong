# Changelog

All notable changes to Plainsong are documented in this file.

## [0.9.0-beta.2] - 2026-08-23 (integration candidate)

This private candidate reconciles the full dual-pillar beta with current
application, Rust, and workflow dependency updates. It repairs exact-candidate
QA receipt wiring, separates measured latency from clean-checkout source gates,
closes release-workflow verification gaps, and fixes validated Dictation and
Meetings lifecycle defects before a new package is qualified.

### Repaired
- QA receipt wiring: aggregators and producers now agree on `release/qa` paths.
- Latency gate: self-sufficient source gate separated from measured receipt.
- Release workflow: license and cold-start gates added; Windows publish-on-tag
  removed.
- Meeting lifecycle: stop failures now surface to the user instead of causing
  unhandled rejections; renderer and main-process lifecycle events reconciled.
- Capture admission: privileged storage operations guarded.
- Electron 43 module resolution: process-scoped imports (`electron/main`,
  `electron/renderer`, `electron/common`) resolved for both runtime and tests.
- `nanoid@3.3.18` security fix applied via package.json override.
- Dependency updates from all three Dependabot branches reconciled.

### Verified locally
- 868 Vitest tests, Rust library and binary tests, IPC contract, dead-code,
  TypeScript, renderer build, Electron build, Rust fmt and Clippy.
- Local package: native helpers, licenses, third-party notices, Electron fuses,
  Developer ID signatures, hardened runtime, secure timestamps, arm64, zip
  extraction, size gate (374 MB), cold-start gate (2428 ms).

No `0.9.0-beta.2` artifact has been notarized, stapled, or distributed. Signing,
notarization, Gatekeeper, clean-install, real-device, and updater claims require
fresh evidence from the exact final revision.

## [0.9.0-beta.1] - 2026-08-08 (historical candidate)

The free, open-source relaunch. The previously commercial app (NautilusBot /
Nautilus) was rebuilt as **Plainsong** — MIT licensed, no trial, no tiers,
no telemetry. This limited beta targets macOS on Apple Silicon (arm64).

Dictation and Meetings are both supported release pillars. The beta adds
explicit runtime readiness, bounded recovery, local-first remote-processing
revocation, guarded privileged storage operations, rollback-resistant beta
updates, and exact-candidate QA receipts. The first invite-limited group accepts
the formal real-device Dictation matrix, remaining Meeting lifecycle rows, and
a repeat three-hour capture soak as documented beta risks. They remain required
before public launch. Distribution still requires explicit approval, and
automatic updates remain gated on the exact-candidate updater journey and
publication of the beta update feed. Its historical receipts do not establish
those states for later candidates.

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
