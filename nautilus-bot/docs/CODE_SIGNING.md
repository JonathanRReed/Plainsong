# Code signing, notarization, and distribution

App bundle identifier: `com.plainsong.app`

Plainsong beta is an Apple Silicon macOS application packaged with
`electron-builder`. The package includes the Electron application, Rust
sidecar, native macOS shortcut helper, and Apple Speech helper.

## Current local status

The current integration target is `0.9.0-beta.2`. Its expected outputs are:

- `release/Plainsong-0.9.0-beta.2-arm64.dmg`
- `release/Plainsong-0.9.0-beta.2-arm64-mac.zip`
- `release/Plainsong-0.9.0-beta.2-arm64-mac.zip.blockmap`
- `release/beta-mac.yml`
- `release/mac-arm64/Plainsong.app`

No exact `0.9.0-beta.2` package trust claim is established until these artifacts
are rebuilt and the current gates pass. Historical signatures, notarization
tickets, Gatekeeper results, and hashes belong to their historical artifacts
and do not prove this revision.

Exact hashes, Apple submission identifiers, and QA receipts belong under
`artifacts/qa/macos/`, not in this source guide. The current candidate has not
been published. Keep the app-specific password only in the login Keychain,
never in source, logs, shell history, or release artifacts.

## Release inputs

- Packaging config: `electron-builder.yml`
- macOS entitlements: `build-resources/entitlements.mac.plist` (main app)
- Inherited entitlements: `build-resources/entitlements.mac.inherit.plist`
  (GPU/Renderer/Plugin Electron helpers)
- Generic helper entitlements: `build-resources/entitlements.mac.helper.plist`
  (the Electron helper that hosts Chromium's utility processes, audio
  included)
- Sidecar and shortcut-helper entitlements:
  `build-resources/entitlements.mac.sidecar.plist` and
  `build-resources/entitlements.mac.shortcut-helper.plist` (both empty —
  neither binary is signed with any entitlement)
- Speech helper entitlements:
  `rust-sidecar/native/macos_speech_helper.entitlements.plist`
- Signing dispatch: `scripts/sign-macos.mjs` — the source of truth for which
  binary gets which entitlements file (see "Per-binary entitlements" below) —
  except the GPU/Renderer/Plugin helpers, which take `entitlementsInherit`
  from `electron-builder.yml`
- Rust sidecar: `rust-sidecar/target/release/plainsong-sidecar`
- Shortcut helper: `dist-native/plainsong-native-shortcut-helper`
- Output directory: `release/`

## Per-binary entitlements (Wave 1 split)

The package used to sign every Electron child process — the GPU, Renderer,
and Plugin helpers, plus the generic helper that hosts Chromium's utility
processes — with a copy of the main app's own entitlements. None of them
open a device or drive another application, so that handed three idle
processes the microphone, unscoped Apple Events, and disabled library
validation for no reason. `scripts/sign-macos.mjs` now routes each binary to
its own file:

| Binary | Entitlements file | Holds |
| --- | --- | --- |
| `Plainsong.app` (main) | `entitlements.mac.plist` | JIT, unsigned executable memory, microphone, audio input, blanket Apple Events automation, plus an (inert, unsandboxed) `temporary-exception` list naming `com.apple.systempreferences` and `com.apple.finder` |
| `Plainsong Helper (GPU).app`, `(Renderer).app`, `(Plugin).app` | `entitlements.mac.inherit.plist` | JIT, unsigned executable memory, `inherit` only — no device, no Apple Events, no disabled library validation |
| `Plainsong Helper.app` (generic — hosts Chromium's utility processes, including the audio service the Settings microphone test uses via `getUserMedia`) | `entitlements.mac.helper.plist` | the inherit set plus `device.audio-input` and `device.microphone` — nothing else |
| `sidecar/plainsong-sidecar` | `entitlements.mac.sidecar.plist` | none (empty `<dict/>`) |
| `shortcut-helper/plainsong-native-shortcut-helper` | `entitlements.mac.shortcut-helper.plist` | none (empty `<dict/>`) |
| `sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin` | `rust-sidecar/native/macos_speech_helper.entitlements.plist` | `com.apple.security.personal-information.speech-recognition` only |

The generic helper is matched by shape (`/^.+ Helper(\.app)?$/`), not by the
literal product name, so a `productName` change can't silently reroute it —
and the pattern is anchored so it does not also match the GPU/Renderer/Plugin
helpers, which must keep the narrower inherit set.

**`com.apple.security.cs.disable-library-validation` was removed from the
main app's entitlements** (previously present, now gone). Library validation
is only disabled to load code signed by someone else, and nothing the main
process loads needs that — no production dependency ships a `.node` binary,
and the sidecar, Speech helper, and shortcut helper are separate signed
processes. Disabling it on the bundle that holds the microphone, Apple
Events, and (at runtime) the Accessibility grant turns a notarized Plainsong
into a loader for someone else's dylib. This change is flagged for
packaged-QA verification: if a packaged smoke test ever fails to launch
because of it, the fix is to find and sign the unsigned library, not to
restore the entitlement (see the comment block in
`build-resources/entitlements.mac.plist` and the `REVERTABLE`-tagged commit
that made this change).

The release environment must provide:

- `CSC_LINK` plus `CSC_KEY_PASSWORD`, or `CSC_NAME`
- `APPLE_KEYCHAIN_PROFILE`, or all of:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`

The GitHub Actions workflow maps those values from:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`APPLE_KEYCHAIN_PROFILE` is intended for local release builds whose
`notarytool` credentials are already stored in the login Keychain. GitHub
Actions uses the explicit secret variables because hosted runners do not share
the local Keychain. Never add certificate files, passwords, tokens, or
generated credential reports containing secret values to source control.

## Credential preflight

Run the fail-closed credential check before an official build:

```bash
bun run gate:release-credentials:preflight
```

It writes:

- `artifacts/release-credential-preflight.json`
- `artifacts/release-credential-preflight.md`

Those reports contain only boolean presence checks, signing identity counts,
a boolean result for the selected Developer ID identity, and a boolean result
from authenticating the selected Keychain profile. Identity names, profile
names, and secrets are never written to the reports. The command exits nonzero
when the selected identity cannot sign, the complete notarization credential
set is unavailable, or a named Keychain profile cannot authenticate.

## Build without publishing

```bash
bun install --frozen-lockfile
bun run release:mac
```

`release:mac` builds the arm64 DMG, ZIP, blockmap, and updater manifest with
publication disabled. `electron-builder.yml` explicitly enables notarization.
An official build must stop if notarization cannot complete.

## Verify the package

Run the repository gates:

```bash
bun run qa:packaged:macos:update-metadata
APPLE_TEAM_ID="<team-id>" bun run gate:release:macos:trust
bun run gate:size
```

The trust gate verifies:

- the app, sidecar, shortcut helper, and Apple Speech helper are present and executable
- all four signatures are valid Developer ID signatures
- hardened runtime and secure timestamps are present
- all embedded executables use the expected Apple team
- the sidecar and shortcut helper carry none of their forbidden entitlements
  (including Speech Recognition and, for the sidecar, disabled library
  validation)
- the main app has library validation enabled (not disabled)
- the GPU, Renderer, and Plugin Electron helpers hold no device or Apple
  Events entitlement, and the generic Electron helper holds no Apple Events
  entitlement or disabled library validation (audio is expected there)
- only the Apple Speech helper receives the Speech Recognition entitlement
- all shipped executables are arm64
- the DMG itself — not just the `.app` inside it — is signed, has a stapled
  notarization ticket, and is accepted by Gatekeeper
- the ZIP's extracted `.app` passes every one of the checks above independently
- a notarization ticket is stapled on the app bundle
- Gatekeeper accepts the app as `Notarized Developer ID`

Any one of these failing fails the gate closed (`status: "FAIL"`); there is no
partial-pass state.

Useful direct checks are:

```bash
codesign --verify --deep --strict --verbose=2 \
  "release/mac-arm64/Plainsong.app"
xcrun stapler validate "release/mac-arm64/Plainsong.app"
spctl --assess --type execute --verbose=4 \
  "release/mac-arm64/Plainsong.app"
```

For a launchable build, stapler must validate successfully and `spctl` must
report `accepted` with `source=Notarized Developer ID`.

## Embedded executable scope

The packaged application contains three important native executables under
`Contents/Resources`:

```text
sidecar/plainsong-sidecar
sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin
shortcut-helper/plainsong-native-shortcut-helper
```

All three must use the same Developer ID identity and Apple team as the main
application. The release trust gate checks them independently, in addition to
the deep application signature. The Speech helper alone receives the Speech
Recognition entitlement.

The bundle also contains four Electron child-process helpers under
`Contents/Frameworks`, each its own signed `.app`:

```text
Plainsong Helper.app                  (generic — hosts Chromium's audio service)
Plainsong Helper (GPU).app
Plainsong Helper (Renderer).app
Plainsong Helper (Plugin).app
```

The trust gate does not run the Apple-team-match check against these four the
way it does for the sidecar, shortcut helper, and Speech helper, but it does
verify each one is present and carries only the entitlements described in
"Per-binary entitlements" above — the GPU/Renderer/Plugin three hold no
device or automation authority, and the generic one holds nothing beyond
audio.

## Artifact-staging release behavior

`.github/workflows/release.yml` is the only official publication path. It:

1. verifies the tag matches `package.json`
2. runs source tests and contract gates
3. requires the full signing and notarization credential set
4. builds with direct publication disabled
5. verifies updater metadata, signatures, stapling, Gatekeeper, TCC strings,
   size, packaged licenses, cold start, and release assets
6. creates or refreshes an artifact-only draft GitHub release after every
   automated artifact gate passes

A rerun may replace assets on an existing draft. It refuses to modify a
published release. This workflow does not prove the real-hardware product,
clean-install, updater-journey, or soak gates. A human must confirm the current
aggregate release audit before publishing the draft.

The repository is currently private, and no public release or deployment has
occurred. The first distribution is a small invitation-only beta.

## Operational notes

Hard-won since the last `0.9.0-beta.2` build attempt — read this before
building or distributing anything.

- **`bun run release:mac` is the only sanctioned path to a distributable
  DMG.** `scripts/build-dmg.mjs` is a separate, ad-hoc local tool for testing
  the install gesture on one machine; it does not notarize, does not staple,
  and does not apply the DMG layout above, and no gate in this repository
  inspects its output. The `0.9.0-beta.2` DMG shipped unnotarized because
  this script was run instead of `bun run release:mac`. The script now
  prints an unmissable warning to that effect before and after every local
  build, but the fix is procedural: never distribute anything
  `build-dmg.mjs` produced.
- **Run `bun run gate:release:macos:trust` before any distribution, not just
  before publishing.** It now fails closed on an unnotarized or unstapled
  DMG or ZIP (not only the `.app` bundle) and on any forbidden entitlement on
  any embedded binary — see "Per-binary entitlements" and "Verify the
  package" above. A green run of this gate is a precondition for handing an
  artifact to anyone, including a single invited tester.
- **The public update feed needs both channel manifests published, not just
  the one this build uses.** `qa:packaged:macos:public-update-feed` now
  checks that `/beta/beta-mac.yml` *and* `/stable/latest-mac.yml` both
  resolve, because a running app re-resolves its feed URL from its own
  channel at check time (see `electron/updater-channel.ts`). The first
  stable release must publish `/stable/latest-mac.yml` before that gate can
  pass — publishing only a beta manifest is not enough once a stable channel
  exists.
- **Notarization needs `APPLE_KEYCHAIN_PROFILE`, or all of `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.** Run
  `bun run gate:release-credentials:preflight` first; see "Credential
  preflight" above and `scripts/release-credentials-preflight.mjs`.
- **`updates.plainsong.jonathanrreed.com` currently has no DNS record.**
  Verified directly (`host updates.plainsong.jonathanrreed.com`) on
  2026-08-27: NXDOMAIN. `electron-builder.yml`'s `publish.url` and
  `electron/updater-channel.ts`'s `UPDATE_FEED_BASE_URL` both point at this
  host, so no packaged build's auto-updater can reach a live feed until the
  host resolves and serves both channel manifests. This is the same external
  gate `LAUNCH.md` and
  `nautilus-bot/docs/beta/EXTERNAL-UPDATE-FEED-GATE.md` describe; it has not
  been provisioned since that record was written.

## Windows

Windows is not a beta release target. Do not add a Windows leg to the official
workflow until the sidecar, packaging, signing, and platform QA have their own
complete release path.
