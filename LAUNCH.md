# Plainsong launch checklist

Release state as of **July 27, 2026**.

The current working tree contains a locally verified Plainsong v1.0.0 release
candidate for Apple Silicon Macs. The app, DMG, ZIP, sidecar, shortcut helper,
and Apple Speech helper are Developer ID signed. The candidate is deliberately
not notarized or stapled because notarization was deferred for this pass. It is
not Gatekeeper-approved, tagged, or published.

This file separates source and local-package completion from the credentials
and user-present checks that cannot be completed by an unattended build.

## Verdict

**Source, local package, and current-host acceptance: ready. Public release:
deferred.**

The remaining release gates are Apple notarization, a clean-Mac install and
permission pass, an N-to-N+1 updater installation, broader target-app
compatibility, and publication. Do not describe v1.0.0 as launched until every
item under "External release gates" is complete.

## Verified source gates

- [x] Frozen Bun install.
- [x] TypeScript typecheck for renderer and Electron projects.
- [x] Renderer and Electron test suite.
- [x] Rust library test suite, with only the documented hardware-dependent
      tests ignored.
- [x] Rust formatting and clippy with the locked dependency graph.
- [x] IPC contract in both directions: 168 renderer commands, 230 sidecar
      commands, and 157 dispatched commands are reachable.
- [x] Dead-code hygiene through pinned Knip and the repository gate.
- [x] Renderer, Electron main process, Rust sidecar, native shortcut helper,
      and Apple Speech helper build.

## Verified local package

- [x] `nautilus-bot/release/mac-arm64/Plainsong.app`.
- [x] `nautilus-bot/release/Plainsong-1.0.0-arm64.dmg`.
- [x] `nautilus-bot/release/Plainsong-1.0.0-arm64-mac.zip`.
- [x] ZIP blockmap and `latest-mac.yml`.
- [x] 343.29 MB app size, below the 450 MB gate.
- [x] arm64 app and every native executable.
- [x] macOS 13.0 deployment floor in bundle metadata, sidecar, shortcut
      helper, and Apple Speech helper.
- [x] Microphone, system-audio capture, and Speech Recognition usage strings.
- [x] App, sidecar, shortcut helper, Speech helper, and DMG use Developer ID
      Application signing for team `AJ9VWBRNZN`.
- [x] Hardened runtime and secure timestamps on executable code.
- [x] Shortcut helper has an empty entitlement set.
- [x] Apple Speech helper has only the Speech Recognition entitlement.
- [x] Update manifest SHA-512 and size match the generated ZIP.
- [x] Electron fuses disable RunAsNode, NodeOptions, Node CLI inspection, and
      privileged `file://` behavior. ASAR integrity and ASAR-only loading are
      enabled.
- [x] The packaged renderer uses the restricted
      `plainsong://bundle/index.html` origin with path containment checks.
- [x] The real packaged app renders through
      `plainsong://bundle/index.html`. The final Dictation workspace was
      visually inspected after the release build.

## Packaged QA completed in this run

| Check | Result | Scope |
| --- | --- | --- |
| native helper/package gate | pass | Presence, arm64 architecture, deployment floor, entitlements |
| update metadata | pass | Version, ZIP, blockmap, size, SHA-512 |
| size gate | pass | 343.29 MB of 450 MB maximum |
| component smoke | pass | Sidecar, permissions diagnostics, insertion components, setup checks |
| local Whisper fixture | pass | Nonempty transcript, one model load, clean sidecar exit |
| retention | pass | Transcript-only, audio-only, and audio-plus-transcript policies |
| backup and restore | pass | Local create/restore plus explicit iCloud-provider sync/restore path |
| exports | pass | Markdown, JSON, text, all seven templates, database restore, fixture cleanup |
| packaged renderer | pass | Main window and Dictation render through the production protocol |
| cold start | pass | Production renderer emitted `App rendered` in 1,822 ms against a 2.5 s gate |
| dictation hotkey | pass | Packaged global shortcut, microphone capture, Whisper transcript, clipboard delivery |
| Apple Notes insertion | pass | Real packaged insertion into Notes, including native-paste fallback and bundle-ID evidence |
| microphone meeting | pass | Real capture, overlays, persisted audio, database/settings restore, cleanup |
| system-audio known tone | pass | Core Audio process tap, callbacks, non-silent frames, and 997 Hz fixture |
| combined meeting capture | pass | Same-session system-audio verification plus mic, system, and mixed WAV output |
| meeting soak preflight | pass | 30-second mic capture, completed transcript, event lifecycle, restore, cleanup |
| local Ollama analysis | pass | `gpt-oss:20b` summary and action items with grounded citations |
| idle CPU | pass | 0.05% average, 0.9% maximum, 0.1% p95, clean exit |
| release trust | expected fail | Every local signature check passes; notarization checks fail closed |

The retention, backup, and export harnesses restore the original database and
settings after each run. The export harness tests the supported plain export
contract. The old signed evidence-bundle feature was intentionally removed in
June and is not a v1 feature.

## Completed product corrections

- [x] The packaged renderer no longer opens a blank
      `chrome-error://chromewebdata/` window when privileged `file://` behavior
      is disabled.
- [x] Meeting retranscription reaches the shared post-processing pipeline and
      is protected from retention or reset races.
- [x] Recording completion is persisted before optional diarization work.
- [x] Reset refuses to purge database content when owned audio deletion fails.
- [x] Retention and legacy cleanup delete only regular files under approved
      app-owned roots.
- [x] Backup creation, validation, and restore reject nested symlinks.
- [x] OpenAI refusals and Gemini safety blocks are surfaced as policy errors.
- [x] Gemini responses retain the provider-reported model version.
- [x] Streaming transcript auto-scroll no longer produces unhandled browser
      errors.
- [x] Sidecar shutdown releases Whisper and runtime state cleanly instead of
      exiting while Metal contexts are still live.
- [x] Concurrent Whisper prewarm, preview, and final decode paths share one
      per-model load gate instead of constructing duplicate Metal contexts.
- [x] Meeting consent delivery is manual and fail-safe in v1. The app does not
      toggle a meeting chat or press Send without proving the intended field
      has focus.
- [x] Visible placeholder shortcut controls were removed. Only working
      shortcuts remain in Settings.
- [x] Competitive positioning was rewritten using current first-party sources
      and no longer contains unsupported allegations or stale uniqueness
      claims.
- [x] Native helper packaging verifies both usage strings and the least-
      privilege entitlement split.
- [x] Ollama structured analysis uses the documented chat endpoint, which
      returns `gpt-oss` structured output in assistant message content.
- [x] Combined and soak meeting harnesses verify the system-audio known tone
      before setup and recording in the same sidecar session.
- [x] The app-matrix insertion harness recognizes known target bundle IDs when
      macOS omits the application name.
- [x] The cold-start gate measures real packaged renderer readiness and stops
      the launched process after evidence is captured.

## System-audio support

Plainsong prefers native Core Audio process-tap capture on supported macOS
14.7 or later systems. The implementation resolves the newer Core Audio
symbols dynamically so the macOS 13 app can still launch. A virtual loopback
device remains the compatibility path on macOS 13 and earlier macOS 14
versions.

The packaged native process-tap route passed a real known-tone capture on this
Mac. It produced 247 callbacks, 106,479 non-silent frames, and detected the
997 Hz fixture. A same-session Me + Them recording then produced microphone,
system, and mixed WAV files. Clean-Mac permission behavior remains an external
release gate.

## External release gates

### Apple notarization

Developer ID signing and a local Keychain notarization profile are available.
The credentialed build was stopped before submission when notarization was
explicitly deferred. A fresh signed candidate was then rebuilt with all
notarization inputs removed, and no Plainsong submission appears in
`notarytool` history. The trust gate therefore reports:

- app: `source=Unnotarized Developer ID`
- ZIP-contained app: `source=Unnotarized Developer ID`
- no stapled ticket on the app, DMG, or ZIP-contained app
- Gatekeeper rejection, as required before notarization

Complete these only when notarization is resumed:

- [x] Confirm a Developer ID identity and supported notarization credential
      route are available.
- [ ] Resume a credentialed build with `APPLE_KEYCHAIN_PROFILE`, or with
      `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- [ ] Run `bun run gate:release-credentials:preflight`.
- [ ] Build through `.github/workflows/release.yml`.
- [ ] Submit and staple the signed DMG.
- [ ] Require `bun run gate:release:macos:trust` to pass for the app, DMG, and
      ZIP with `source=Notarized Developer ID`.

See `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md` and
`nautilus-bot/docs/CODE_SIGNING.md`.

### User-present acceptance

- [ ] On a clean Mac, install from the notarized DMG and confirm Gatekeeper
      opens it without a bypass.
- [ ] Complete first-run microphone, Speech Recognition, Accessibility, and
      system-audio permissions.
- [x] Trigger the packaged global shortcut, capture microphone audio, complete
      local Whisper transcription, and deliver through the clipboard.
- [x] Insert packaged dictation into Apple Notes and verify the exact text in
      the target note.
- [x] Record packaged mic-only and native system-audio meetings, including a
      known audible tone.
- [ ] Extend insertion coverage to an installed browser and code editor, and
      exercise toggle, hold-to-talk, and hands-free modes on the clean Mac.
- [ ] Confirm paste-last, copy-last, and open-window shortcuts behave as
      labeled on the clean Mac.
- [ ] Verify transcript, summary, action items, diarization enrichment,
      retention, and export on the real recordings.
- [ ] Install an update end to end from the signed ZIP and
      `latest-mac.yml`.
- [ ] Recapture public screenshots from the final notarized build.

## Publication sequence

The commit and push requested for this pass do not authorize tagging or release
publication.

- [x] Review and commit the current working tree.
- [x] Push the reviewed `main` branch.
- [ ] Create and push the `v1.0.0` tag.
- [ ] Let the release workflow create a verified draft release.
- [ ] Review checksums, release notes, and clean-Mac evidence.
- [ ] Publish the repository and draft release only when intended.
- [ ] Verify the public DMG, ZIP, blockmap, update manifest, and updater URLs.
- [ ] Point the website download links at the verified public assets.
- [ ] Submit a Homebrew cask only after the notarized DMG is public.

## Public claims until launch

- Apple Silicon, macOS 13 or later.
- Local transcription is the default. Cloud providers are optional and use
  credentials supplied by the user.
- Native system-audio capture is preferred on supported macOS 14.7 or later
  systems. Older supported systems use a virtual loopback compatibility path.
- Meeting completion is saved before best-effort diarization enrichment.
- No public download or shipped release exists until notarization and
publication are complete.
