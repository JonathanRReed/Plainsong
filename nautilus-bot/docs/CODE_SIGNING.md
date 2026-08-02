# Code signing, notarization, and distribution

App bundle identifier: `com.plainsong.app`

Plainsong v1 is an Apple Silicon macOS application packaged with
`electron-builder`. The package includes the Electron application, Rust
sidecar, native macOS shortcut helper, and Apple Speech helper.

## Current local status

The exact July 30, 2026 v1.0.0 validation candidate is under
`release-plainsong-launch-candidate-20260730/`:

- `release-plainsong-launch-candidate-20260730/Plainsong-1.0.0-arm64.dmg`
- `release-plainsong-launch-candidate-20260730/Plainsong-1.0.0-arm64-mac.zip`
- `release-plainsong-launch-candidate-20260730/Plainsong-1.0.0-arm64-mac.zip.blockmap`
- `release-plainsong-launch-candidate-20260730/latest-mac.yml`
- `release-plainsong-launch-candidate-20260730/mac-arm64/Plainsong.app`

Developer ID signing, hardened runtime, secure timestamps, embedded executable
signatures, arm64 architecture, update metadata, TCC usage strings, Electron
fuses, DMG integrity, mounted-app signature identity, ZIP extraction, and the
package size gate all pass. The app, sidecar, shortcut helper, and Apple Speech
helper are signed by
`Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`. The app CDHash is
`557a50446a500d8cb995203f24e029102b8ed3a5`. The mounted DMG and
ZIP-contained app have the same identity. The updater manifest matches the
140,353,736-byte ZIP exactly.

The candidate is not notarized. The required local `plainsong-notary`
Keychain profile has not been confirmed, and no Plainsong submission has been
made. Electron-builder could not generate notarization options without those
credentials and skipped notarization, so the build has no stapled ticket.
Every local trust check passes except the eight checks that specifically
require notarization, stapling, or Gatekeeper acceptance. The trust report
correctly records:

```text
Plainsong.app does not have a ticket stapled to it.
source=Unnotarized Developer ID
```

Do not distribute this candidate. Create `plainsong-notary` as documented in
`APPLE_DEVELOPER_SETUP.md`, then rebuild through the official release workflow.
The app-specific password belongs only in the login Keychain. Never write it
to a repository file, build log, shell history, or release artifact, and never
reuse another product's notarization profile.

## Release inputs

- Packaging config: `electron-builder.yml`
- macOS entitlements: `build-resources/entitlements.mac.plist`
- Inherited entitlements: `build-resources/entitlements.mac.inherit.plist`
- Rust sidecar: `rust-sidecar/target/release/plainsong-sidecar`
- Shortcut helper: `dist-native/plainsong-native-shortcut-helper`
- Output directory: `release/`

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
- the sidecar and shortcut helper do not inherit unnecessary entitlements
- only the Apple Speech helper receives the Speech Recognition entitlement
- all shipped executables are arm64
- a notarization ticket is stapled
- Gatekeeper accepts the app as `Notarized Developer ID`

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

## Official release behavior

`.github/workflows/release.yml` is the only official publication path. It:

1. verifies the tag matches `package.json`
2. runs source tests and contract gates
3. requires the full signing and notarization credential set
4. builds with direct publication disabled
5. verifies updater metadata, signatures, stapling, Gatekeeper, TCC strings,
   size, and release assets
6. creates or refreshes a draft GitHub release only after every gate passes

A rerun may replace assets on an existing draft. It refuses to modify a
published release. A human must review the draft before publishing it.

The repository is currently private, and no public release or deployment has
occurred.

## Windows

Windows is not a v1 release target. Do not add a Windows leg to the official
workflow until the sidecar, packaging, signing, and platform QA have their own
complete release path.
