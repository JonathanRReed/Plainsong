# Plainsong launch checklist

Current release state as of July 23, 2026.

Plainsong v1.0.0 is locally built and verified for macOS 13 or later on Apple
Silicon. The candidate is Developer ID signed, but it is not notarized,
stapled, Gatekeeper-approved, published, or deployed. The repository is still
private and no public release exists.

## Verified locally

### Source and build

- [x] Bun install and source build complete.
- [x] TypeScript lint and typecheck pass.
- [x] Rust formatting, clippy, and tests pass.
- [x] Renderer and Electron tests pass.
- [x] IPC contract and dead-code gates pass.
- [x] Production renderer, Electron main process, Rust sidecar, and native
      shortcut helper build successfully.

### v1.0.0 package

- [x] `release/Plainsong-1.0.0-arm64.dmg` exists.
- [x] `release/Plainsong-1.0.0-arm64-mac.zip` exists.
- [x] ZIP and DMG blockmaps exist.
- [x] `release/latest-mac.yml` exists.
- [x] `release/mac-arm64/Plainsong.app` exists and launches for rendered QA.
- [x] The package is arm64-only, matching the v1 support statement.
- [x] The app is below the 450 MB size gate.
- [x] The packaged Info.plist contains microphone and speech recognition usage
      descriptions.
- [x] The app contains executable arm64 copies of `plainsong-sidecar` and
      `plainsong-native-shortcut-helper`.

### Signing and updater evidence

- [x] The app, sidecar, and shortcut helper have valid Developer ID
      Application signatures.
- [x] All shipped executables use Apple team `AJ9VWBRNZN`.
- [x] Hardened runtime and secure timestamps are present.
- [x] Packaged update metadata points to
      `JonathanRReed/Plainsong`.
- [x] `latest-mac.yml` reports v1.0.0 and resolves the arm64 ZIP.
- [x] The ZIP size and SHA-512 digest match the updater manifest.
- [x] The updater blockmap is present.

Evidence:

- `nautilus-bot/artifacts/qa/macos/update-metadata.json`
- `nautilus-bot/artifacts/qa/macos/update-metadata.md`
- `nautilus-bot/artifacts/release/macos-trust.json`
- `nautilus-bot/artifacts/release/macos-trust.md`

### Packaged sidecar smoke and rendered application

- [x] The packaged sidecar starts and completes the smoke protocol.
- [x] The direct sidecar smoke reports microphone, Accessibility, post-event,
      cursor insertion, dictation setup, meeting setup, and system-audio
      readiness.
- [x] The packaged app was rendered and inspected in its real UI.
- [x] The live packaged app reports microphone, system audio, local routes,
      and installed models available.
- [x] Authentic Dictation, Meetings, and Settings captures are available under
      `docs/images/`.

Evidence:

- `nautilus-bot/artifacts/qa/macos/packaged-smoke.json`
- `docs/images/plainsong-dictation.png`
- `docs/images/plainsong-meetings.png`
- `docs/images/plainsong-settings.png`

The packaged smoke launches the bundled sidecar directly. Its Accessibility
and cursor-insertion flags do not prove those permissions for the signed
application identity. In the live packaged application, Accessibility and
cursor insertion are not currently granted. An audible speech round trip,
observed insertion into another application, and a recorded meeting also
remain unproven. These are blocking manual checks below.

## Release workflow now fails closed

The official `.github/workflows/release.yml` path:

1. verifies the tag matches `nautilus-bot/package.json`
2. runs source tests and the IPC contract
3. requires the complete Developer ID and Apple notarization credential set
4. builds the DMG, ZIP, blockmaps, and updater manifest without publishing
5. verifies updater metadata, signatures, notarization ticket, Gatekeeper,
   TCC strings, package size, and release assets
6. creates or refreshes a draft GitHub release only after every gate passes

The workflow refuses to modify a published release. Updater users cannot see a
draft release. A human must review and publish the draft.

There is no supported unsigned official-release path and no Gatekeeper bypass
in the launch instructions.

## Blocking gate: notarization credentials

The local credential preflight currently reports:

- `CSC_LINK`: missing
- `CSC_NAME`: missing
- `CSC_KEY_PASSWORD`: missing
- `APPLE_ID`: missing
- `APPLE_APP_SPECIFIC_PASSWORD`: missing
- `APPLE_TEAM_ID`: missing
- local Developer ID identities: present

Because notarization credentials were unavailable, the current signed
candidate has no stapled ticket. The release trust gate correctly fails:

```text
Plainsong.app does not have a ticket stapled to it.
source=Unnotarized Developer ID
```

Required actions:

- [ ] Add the password-protected Developer ID `.p12` and password to GitHub
      Actions secrets `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`.
- [ ] Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- [ ] Run `bun run gate:release-credentials:preflight` in the credentialed
      release environment.
- [ ] Rebuild through the official release workflow.
- [ ] Require `bun run gate:release:macos:trust` to pass with a stapled ticket
      and `source=Notarized Developer ID`.

See:

- `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md`
- `nautilus-bot/docs/CODE_SIGNING.md`

## Manual release-candidate checks

Run these against the notarized artifact that the workflow places in the draft,
not against the current unnotarized local candidate.

- [ ] Install from the DMG on a clean Apple Silicon Mac.
- [ ] Confirm Gatekeeper opens the app without a bypass.
- [ ] Complete first-run setup and the `base.en` model download.
- [ ] Grant Accessibility to the real packaged application identity and
      confirm the live app reports Accessibility and cursor insertion ready.
- [ ] Confirm Microphone remains granted to the packaged application.
- [ ] Speak a dictation and confirm the final text inserts at the cursor in
      Notes, a browser text field, and a code editor.
- [ ] Confirm toggle, hold-to-talk, and hands-free activation behave correctly
      with a real keyboard and microphone.
- [ ] Record and stop a microphone-only meeting.
- [ ] Record and stop a meeting with system audio.
- [ ] Review the resulting transcript, summary, and export.
- [ ] Confirm tray open, close-to-tray, overlays, and multi-display placement.
- [ ] Publish a prerequisite build to a private test channel, then verify an
      update install using the signed ZIP and `latest-mac.yml`.
- [ ] Re-run the remaining packaged QA matrix for onboarding, dictation
      hotkey, cross-app insertion, backups, exports, idle CPU, retention, and
      meeting capture.

## Publication and deployment gates

- [ ] Merge the reviewed release changes.
- [ ] Create and push the intended `v1.0.0` tag.
- [ ] Let the official workflow produce a fully verified draft release.
- [ ] Review the draft assets, checksums, release notes, and clean-Mac results.
- [ ] Make `JonathanRReed/Plainsong` public before announcing source or
      download links.
- [ ] Publish the reviewed GitHub draft.
- [ ] Verify the public DMG, ZIP, blockmap, `latest-mac.yml`, and updater URLs.
- [ ] Deploy the prepared website update only after its public links resolve.
- [ ] Verify the rendered production website on desktop and mobile.
- [ ] Submit the Homebrew cask only after the notarized public DMG exists.

No commit, tag, GitHub release publication, repository visibility change,
website deployment, or Homebrew submission has been performed in this
readiness pass.

## Launch-day public truth

Public copy must state:

- Plainsong v1 supports macOS 13 or later on Apple Silicon
- Windows and Linux are future work
- transcription is local by default
- cloud providers are optional and use the user's own credentials
- no public download exists until the notarized GitHub release is published

Before announcement, verify the repository README, live website, GitHub
release, update manifest, and actual downloadable assets agree on version,
platform, and availability.

## Post-release

- [ ] Submit the prepared Homebrew cask.
- [ ] Monitor update checks and install reports.
- [ ] Track Windows and Linux as separate platform projects.
- [ ] Complete any desired legal trademark clearance, domain purchase, or
      social handle registration separately. These are not represented as
      completed in this checklist.
