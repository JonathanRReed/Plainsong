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

Dictation latency is not covered by the trust/size gates above and needs its
own measurement per candidate: run `bun run sidecar:build:release` then `bun
run benchmark:latency -- --provider whisper --model base.en --runs 10`,
followed by `bun run gate:dictation-latency` and `bun run
gate:dictation-latency:e2e`. This writes `artifacts/qa/dictation-latency.json`
(ASR decode only) and `artifacts/qa/dictation-latency-e2e.json` (`metricScope:
"asr_and_local_format_only"` -- ASR plus the local formatting pipeline plus a
mocked insertion stage; see the receipt's own `insertionStrategyNote` and
`formatOnScopeNote` for exactly what that scope does and doesn't cover). Both
receipts are gitignored by design (`artifacts/` is never committed) and must
stay that way — attach them to the release evidence bundle by hand alongside
the other `artifacts/qa/` receipts referenced above, the same way a stale or
missing receipt is a launch blocker.

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

## Windows

Windows is not a beta release target. Do not add a Windows leg to the official
workflow until the sidecar, packaging, signing, and platform QA have their own
complete release path.
