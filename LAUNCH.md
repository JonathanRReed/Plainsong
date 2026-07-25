# Plainsong launch checklist

Release state as of **July 25, 2026**, commit `d93a396`.

Plainsong v1.0.0 is built, signed, and verified locally for macOS 13+ on Apple
Silicon. It is **not notarized, not stapled, not Gatekeeper-approved, and not
published.** The repository is still private and no public release exists.

Everything marked verified below was produced by a command against the current
artifact. Where a claim rests on this machine's configuration rather than a
stock Mac, that is stated.

## Verdict

**Go, with the conditions in "Before you tag" below.**

A six-lane pre-notarization review produced 52 candidate findings; 41 survived
adversarial verification. Nine were ship blockers. Seven are fixed. Two are
open and named below. Six of the nine lived on the first-run surface, which is
also the surface that has never been exercised on a clean Mac — that is not a
coincidence, and it is the main reason the manual checklist matters.

## Verified against the current build

### Source gates

- [x] TypeScript typecheck (app + electron configs).
- [x] 478 renderer/electron tests.
- [x] 460 Rust tests.
- [x] `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`.
- [x] IPC contract, now checked in **both** directions — 164 renderer
      commands, 224 sidecar commands, 153 dispatched commands all reachable.
- [x] Dead-code hygiene (knip + repo gate).
- [x] Renderer, Electron, sidecar, and native shortcut helper all build.

### Package

- [x] `release/Plainsong-1.0.0-arm64.dmg`, the ZIP, both blockmaps, and
      `latest-mac.yml` exist.
- [x] 343 MB, under the 450 MB gate.
- [x] arm64-only, matching the v1 support statement.
- [x] `CFBundleIdentifier` `com.plainsong.app`, `LSMinimumSystemVersion` 13.0.
- [x] `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`
      present.
- [x] Both native binaries bundled, arm64, executable: `plainsong-sidecar` and
      `plainsong-native-shortcut-helper`.

### Signing

- [x] App, sidecar, and shortcut helper each signed **Developer ID
      Application: Jonathan Reed (AJ9VWBRNZN)** with hardened runtime
      (`flags=0x10000(runtime)`) and secure timestamps.
- [x] `codesign --verify --deep --strict` → valid on disk, satisfies its
      Designated Requirement.
- [x] **The DMG is now signed.** It previously shipped `not signed at all`
      because `dmg: sign: false` was explicit and electron-builder notarizes
      the `.app` only. `spctl` now reports `Unnotarized Developer ID` rather
      than `no usable signature` — the same state as the app, awaiting only a
      ticket.
- [x] **Electron fuses are hardened.** `RunAsNode`, `NodeOptions`,
      `NodeCliInspect`, and `GrantFileProtocolExtraPrivileges` disabled;
      `EmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled.

  This one is worth stating plainly. Before the fix,
  `ELECTRON_RUN_AS_NODE=1 Plainsong.app/Contents/MacOS/Plainsong -e '…'`
  executed arbitrary Node under the Developer ID signature, which carries
  microphone, speech-recognition, and Apple Events entitlements plus the
  Accessibility grant the app holds to inject keystrokes. Notarizing that
  would have created a permanently Apple-trusted TCC-bypass gadget that no
  later release could retract. Retested after the fix: the command no longer
  executes JS, and the signature still verifies.

- [x] `gate:release:macos:trust` now inspects the DMG and ZIP, not just the
      bundle, and asserts the fuse wire read directly out of Electron
      Framework. A negative test proves a permissively-fused bundle fails the
      gate even when every signature is valid.

### Packaged QA matrix, run against this build

| Check | Result |
| --- | --- |
| smoke | pass |
| meeting:mic | pass |
| meeting:system | pass |
| onboarding | pass |
| dictation-hotkey | pass |
| idle-cpu | pass |
| exports | pass |
| backup | pass |
| whisper | pass |
| update-metadata | pass |
| app-matrix:preflight | pass |
| **retention** | **fails — see known issues** |
| meeting:soak | not run (long-running) |

The onboarding check had been failing since `da46a1f` (July 13) and reporting
it as a crash rather than a failed check, because `stableJson` called
`Object.keys()` on an absent settings key. Fixed; three stale expectations it
had been hiding are corrected.

### Mixed "Me + Them" capture, verified on real hardware

The pairing that caused the original defect was exercised directly:
`mic: 48000 Hz / 1 ch, system: 48000 Hz / 2 ch` (BlackHole 2ch).

| Track | Channels | Frames | Duration |
| --- | --- | --- | --- |
| mixed | 1 | 183296 | 3.819 s |
| mic | 1 | 183296 | 3.819 s |
| system | 1 | 183296 | 3.819 s |

Identical frame counts, zero spread, +0.051 s against wall clock — exactly the
2560 frames of startup padding the mixer logged. Before the fix the 2-channel
system source enqueued two samples per frame while the mixer popped 1:1, so
the far-side track ran at half speed and drifted further out of sync every
second, destroying the entire "Them" transcript.

## Blocking: notarization credentials

The local preflight reports `CSC_LINK`, `CSC_NAME`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` all missing;
local Developer ID identities are present. The trust gate correctly fails
closed with `source=Unnotarized Developer ID`.

- [ ] Add the Developer ID `.p12` and password as `MAC_CSC_LINK` and
      `MAC_CSC_KEY_PASSWORD`.
- [ ] Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- [ ] `bun run gate:release-credentials:preflight` in the credentialed
      environment.
- [ ] Rebuild through `.github/workflows/release.yml`.
- [ ] Require `bun run gate:release:macos:trust` to pass with a stapled ticket
      and `source=Notarized Developer ID` **on the app, the DMG, and the ZIP**.

See `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md` and
`nautilus-bot/docs/CODE_SIGNING.md`.

## Before you tag

These need a human. None can be closed from a build machine.

- [ ] **Speak into it.** No one has. The insertion path and the HUD windowing
      both changed substantially. Confirm text lands at the cursor in Notes, a
      browser field, and a code editor, and that toggle, hold-to-talk, and
      hands-free all behave with a real keyboard.
- [ ] **Clean-Mac first run.** Install from the DMG on a machine that has
      never run Plainsong. Six of the nine ship blockers lived on this surface.
      Confirm Gatekeeper opens it without a bypass, the `base.en` download
      completes, and no Xcode developer-tools dialog appears.
- [ ] **Record a real meeting**, mic-only and with system audio, and read the
      resulting transcript, summary, and export.
- [ ] **Recapture the screenshots.** `docs/images/plainsong-dictation.png`
      shows the Profiles-card layout that `b6e5298` replaced with the capture
      hero. The README hero image no longer matches the app.
- [ ] **Decide on `nautilus-bot/docs/competitive-positioning.md`.** Line 19
      asserts as unhedged fact that a named competitor committed "SOC-2 audit
      fraud." It is unsourced, tracked, and already on `main`, so it becomes
      permanent public history the moment the repo flips. `PRIVACY.md` hedges
      far softer competitor claims. Remove it or source it first.
- [ ] Verify an update install end to end using the signed ZIP and
      `latest-mac.yml`.

## Known issues shipping in v1.0.0

State these publicly rather than letting users find them.

**Two open privacy items** (deferred only because another session held
`rust-sidecar/src/lib.rs`):

- Vault encryption reports "every stored recording is encrypted" while the
  per-speaker `_mic` and `_system` companion tracks stay plaintext and survive
  deletion.
- Dictation context — clipboard and selected text — is persisted to the
  append-only audit table, which `PRIVACY.md` says never stores it.

**Other confirmed issues:**

- `qa:packaged:macos:retention` fails. Retention *behaviour* is correct — the
  audio file is removed, the recording and transcript are preserved, the path
  is cleared — but `run_storage_retention_maintenance` reports zero for work it
  demonstrably performed. Reporting bug, not data loss. Pre-existing.
- System audio requires a third-party loopback driver (BlackHole, Loopback,
  VB-Cable). There is no ScreenCaptureKit path. This is not stated in the
  README, and the error message points at the wrong permission.
- The live meeting transcript is a **delayed preview**, not a live one. No
  provider behind `AsrProvider` decodes incrementally, so the words trail the
  speaker. Every event carries `delayedPreview` and `lagSeconds`, and the UI
  labels it as such.
- Hold-to-talk's native helper is compiled without an explicit `-target`, so it
  inherits the build machine's deployment floor and may not load on macOS
  13/14/15 despite the advertised support floor. It degrades to toggle.
- Selecting Parakeet triggers an undisclosed managed-venv `pip install` of
  torch and friends (~1–1.5 GB on top of the stated model size).
- Opening Settings → AI issues authenticated requests to configured cloud
  providers while the same screen may describe keys as inactive.
- "Auto-name meetings" (default on) summarizes the full transcript and does not
  respect the auto-summary toggle.
- The Info.plist carries stock Electron boilerplate usage strings, including a
  camera string the app does not need, and lacks
  `NSAppleEventsUsageDescription` for the AppleScript browser-title reads it
  performs.
- Two global shortcuts (re-paste / re-copy last transcript) bind at startup
  without a prompt and are not mentioned in onboarding.

## Publication sequence

- [ ] Merge and push the reviewed release changes.
- [ ] Create and push the `v1.0.0` tag.
- [ ] Let `release.yml` produce a fully verified **draft** release. It refuses
      to modify a published release and requires the complete credential set.
- [ ] Review the draft assets, checksums, notes, and clean-Mac results.
- [ ] Make `JonathanRReed/Plainsong` public. **Resolve the competitive
      positioning doc first** — publication is irreversible for git history.
- [ ] Publish the draft.
- [ ] Verify the public DMG, ZIP, blockmap, `latest-mac.yml`, and updater URLs
      resolve.
- [ ] Deploy the website only after those links resolve.
- [ ] Submit the Homebrew cask only after the notarized public DMG exists.

## Launch-day public truth

Public copy must state:

- macOS 13+ on Apple Silicon; Windows and Linux are future work.
- Transcription is local by default; cloud providers are optional and use the
  user's own credentials.
- System audio capture requires a third-party loopback driver.
- The in-meeting transcript is a delayed preview, not live captioning.
- No public download exists until the notarized release is published.

Before announcing, verify the README, website, GitHub release, update
manifest, and downloadable assets agree on version, platform, and
availability.

## Post-release

- [ ] Submit the Homebrew cask.
- [ ] Monitor update checks and install reports.
- [ ] Close the two open privacy items in a 1.0.1.
- [ ] Track Windows and Linux as separate platform projects.
- [ ] Trademark clearance, domain purchase, and social handles remain separate
      and are not represented as complete here.
