# Plainsong launch checklist

Release state as of **July 28, 2026**.

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
- [x] 351.53 MB app size, below the 450 MB gate. The rise from 343.29 MB is
      Electron 43.
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

Every row below was re-run on July 28 against a rebuilt app carrying the merged
dependency groups — Electron 42 -> 43, TypeScript 6 -> 7, React 19.2.6 ->
19.2.8, the Radix and Vite bumps, and the Rust group. Eleven suites, zero
failures. Two numbers moved and are called out after the table.

| Check | Result | Scope |
| --- | --- | --- |
| native helper/package gate | pass | Presence, arm64 architecture, deployment floor, entitlements |
| update metadata | pass | Version, ZIP, blockmap, size, SHA-512 |
| size gate | pass | 351.53 MB of 450 MB maximum |
| component smoke | pass | Sidecar, permissions diagnostics, insertion components, setup checks |
| local Whisper fixture | pass | Nonempty transcript, one model load, clean sidecar exit |
| retention | pass | Transcript-only, audio-only, and audio-plus-transcript policies |
| backup and restore | pass | Local create/restore plus explicit iCloud-provider sync/restore path |
| exports | pass | Markdown, JSON, text, all seven templates, database restore, fixture cleanup |
| packaged renderer | pass | Main window and Dictation render through the production protocol |
| cold start | pass | Production renderer emitted `App rendered` in 1,118 ms against a 2.5 s gate. See the first-launch note below |
| dictation hotkey | pass | Packaged global shortcut, microphone capture, Whisper transcript, clipboard delivery |
| Apple Notes insertion | pass | Real packaged insertion into Notes, including native-paste fallback and bundle-ID evidence |
| microphone meeting | pass | Real capture, overlays, persisted audio, database/settings restore, cleanup |
| system-audio known tone | pass | Core Audio process tap, callbacks, non-silent frames, and 997 Hz fixture |
| combined meeting capture | pass | Same-session system-audio verification plus mic, system, and mixed WAV output |
| meeting soak preflight | pass | 30-second mic capture, completed transcript, event lifecycle, restore, cleanup |
| local Ollama analysis | pass | `gpt-oss:20b` summary and action items with grounded citations |
| idle CPU | pass | 0.45% average, 5.7% maximum, 2% p95, clean exit. Was 0.05% / 0.9% / 0.1% on Electron 42 — see below |
| release trust | expected fail | Every local signature check passes; notarization checks fail closed |

### Idle CPU rose on Electron 43 and still passes

Average idle CPU went from 0.05% to 0.45% against a 1% gate, with the maximum
moving 0.9% -> 5.7% and p95 0.1% -> 2%. The gate passes and 0.45% is still low
in absolute terms, but it is a nine-fold move and the only change between the
two measurements is the July 28 dependency group, of which Electron 42 -> 43 is
the plausible cause. Recorded rather than rounded away: if it climbs again on a
future bump, the gate is close enough to matter, and the number to compare
against is this one, not the 0.05% it replaced.

### First launch after a build is not a representative cold start

The cold-start gate fails on the very first launch of a freshly signed bundle
and passes on every launch after it. Measured on July 28: first launch exceeded
the 2,500 ms gate; the next four were 1,118 / 853 / 970 / 1,334 ms. macOS
validates the whole 351 MB signature once and caches the result, so the first
number is signature validation, not renderer readiness.

This matters twice. Run `bun run gate:cold-start` a second time after any
release build before believing a failure. And expect real users to pay that
cost once on first launch, because their first launch is also a first launch —
the gate does not measure what they will feel on day one.

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

Developer ID signing is available and working: the July 28 rebuild signed the
app, sidecar, shortcut helper, Speech helper, and DMG with
`Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`.

**No notarization credential exists on this machine.** An earlier revision of
this file said a local Keychain profile was available; that was wrong. Verified
July 28: the login Keychain holds no generic-password item under
`com.apple.gs.appleid.auth`, `notarytool`, `Xcode`, or `altool`, and
`xcrun notarytool history --keychain-profile <name>` returns "No Keychain
password item found" for every plausible name. Creating one requires an Apple
ID and an app-specific password, so it is the account holder's step — see
"Creating the `notarytool` Keychain profile" in
`nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md`.

The current candidate was built with all notarization inputs absent, and no
Plainsong submission appears in `notarytool` history. The trust gate therefore
reports:

- app: `source=Unnotarized Developer ID`
- ZIP-contained app: `source=Unnotarized Developer ID`
- no stapled ticket on the app, DMG, or ZIP-contained app
- Gatekeeper rejection, as required before notarization

Complete these only when notarization is resumed:

- [x] Confirm a Developer ID identity is available.
- [ ] Create a `notarytool` credential — no route currently exists. Account
      holder only.
- [ ] Resume a credentialed build with `APPLE_KEYCHAIN_PROFILE`, or with
      `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- [ ] Run `bun run gate:release-credentials:preflight`.
- [ ] Restore GitHub Actions billing — see below. The release workflow cannot
      start until this is fixed.
- [ ] Build through `.github/workflows/release.yml`.
- [ ] Submit and staple the signed DMG.
- [ ] Require `bun run gate:release:macos:trust` to pass for the app, DMG, and
      ZIP with `source=Notarized Developer ID`.

See `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md` and
`nautilus-bot/docs/CODE_SIGNING.md`.

### GitHub Actions billing is blocking every workflow run

Every run since at least July 27 has failed within seconds, on all four jobs,
with the annotation:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

This is an account-billing state, not a repository or code problem — the same
commits pass every gate locally. It blocks the release workflow, so it blocks
notarized publication, and it also means CI has not actually verified any
commit for at least a day. Fix it under GitHub Settings → Billing and plans,
then re-run one CI workflow and confirm the jobs start before relying on any
green check.

Worth knowing while it is broken: local Rust is 1.93.0 while CI resolves
`dtolnay/rust-toolchain@stable` to 1.97.1, so local gate runs and CI are four
releases apart. That gap has not been exercised, because CI has not run.

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
      `latest-mac.yml`. **Deliberately not attempted locally — see below.**
- [ ] Recapture public screenshots from the final notarized build.

### Why the updater test is deferred rather than run locally

A local N-to-N+1 install is mechanically possible: build a 1.0.1 candidate with
the same Developer ID, serve `release/` from `127.0.0.1` with
`-c.publish.provider=generic`, and let Squirrel swap the bundle. It was not run,
and the reason is that **it would pass for the wrong reason.**

Locally built fixtures carry no `com.apple.quarantine` attribute, so Gatekeeper
never assesses them the way it assesses a downloaded DMG. An unnotarized swap
between two locally built bundles therefore succeeds regardless of whether the
real path works. The app's own install gate agrees with this reading: `main.ts`
sets `updateInstallBlockedReason` from `isMacAppCodeSigned()` alone, which these
candidates satisfy while remaining unnotarized.

What such a run *would* prove — manifest parsing, version comparison, channel
resolution, download, and the Squirrel swap — is either already covered by
`bun run qa:packaged:macos:update-metadata` (which validates the manifest,
SHA-512, and size against the built ZIP, and passes) or is the part least likely
to differ once notarized.

So this box stays open on purpose, and it should be closed the first time it can
be closed honestly: install the notarized 1.0.0 DMG on a clean Mac, then take a
notarized 1.0.1 through the published feed.

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
