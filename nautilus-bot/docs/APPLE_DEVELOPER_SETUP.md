# Apple Developer release setup

This guide covers the remaining Apple-side work required to notarize and stage
the first Plainsong macOS release.

## Confirmed local state

As of July 23, 2026:

- a Developer ID Application identity for team `AJ9VWBRNZN` is installed
- the v1.0.0 app, sidecar, and native shortcut helper are Developer ID signed
- hardened runtime and secure timestamps are present
- the packaged arm64 DMG, ZIP, blockmap, and updater manifest were built
- the candidate is not notarized because the Apple credential environment
  variables were not available
- stapler reports that no ticket is attached
- Gatekeeper reports `source=Unnotarized Developer ID`

The next build must run through the credentialed official release workflow. Do
not publish the current local candidate.

## 1. Confirm Apple team access

1. Sign in at [developer.apple.com](https://developer.apple.com/).
2. Confirm the Apple Developer Program membership is active.
3. Confirm the release Apple ID belongs to team `AJ9VWBRNZN`.
4. Confirm the Developer ID Application certificate has not expired or been
   revoked.

Verify the local signing identity without printing private material:

```bash
security find-identity -v -p codesigning
```

The output should include the Plainsong Developer ID Application identity.

## 2. Prepare the CI signing certificate

Export the existing Developer ID Application certificate and its private key
from Keychain Access as a password-protected `.p12` file. Do not create a new
certificate unless the existing identity is unavailable or invalid.

Store these GitHub Actions secrets:

- `MAC_CSC_LINK`: the base64-encoded password-protected `.p12`
- `MAC_CSC_KEY_PASSWORD`: the `.p12` export password

Never add the `.p12`, its password, or an encoded copy to the repository.
Remove any temporary export after the secret has been stored and verified.

## 3. Create notarization credentials

1. Sign in at [account.apple.com](https://account.apple.com/) with the release
   Apple ID.
2. Confirm two-factor authentication is enabled.
3. Generate an app-specific password for Plainsong release notarization.
4. Store these GitHub Actions secrets:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`, set to `AJ9VWBRNZN`

Treat the app-specific password as a credential. Do not paste it into source,
logs, issue comments, release notes, or generated artifacts.

## 4. Run the fail-closed preflight

The release workflow maps GitHub secrets to the environment variables consumed
by `electron-builder` and the repository verifier. Before attempting a local
credentialed release build, run:

```bash
bun run gate:release-credentials:preflight
```

The check must pass with all required credential booleans true and at least one
Developer ID signing identity available. Its JSON and Markdown reports contain
no secret values.

## 5. Build and verify locally, if needed

With the credentials supplied securely in the process environment:

```bash
bun install --frozen-lockfile
bun run release:mac
bun run qa:packaged:macos:update-metadata
APPLE_TEAM_ID="AJ9VWBRNZN" bun run gate:release:macos:trust
bun run gate:size
```

The trust gate must pass completely. In particular:

```bash
xcrun stapler validate "release/mac-arm64/Plainsong.app"
spctl --assess --type execute --verbose=4 \
  "release/mac-arm64/Plainsong.app"
```

Expected Gatekeeper evidence:

```text
accepted
source=Notarized Developer ID
```

Signing success alone is not enough. A release is blocked until notarization,
stapling, and Gatekeeper acceptance all pass.

## 6. Run the official release workflow

After the release changes are merged and the intended `v1.0.0` tag exists,
trigger `.github/workflows/release.yml` with that tag.

The workflow:

1. verifies source and tag consistency
2. fails closed if any signing or notarization credential is missing
3. builds the DMG, ZIP, blockmaps, and updater metadata without publishing
4. verifies signatures, notarization, stapling, Gatekeeper, TCC strings, size,
   and updater metadata
5. creates or refreshes a draft GitHub release only after every check passes

The workflow refuses to overwrite a published release.

## 7. Review before launch

Before publishing the draft:

1. verify the draft contains the DMG, ZIP, blockmaps, `latest-mac.yml`, and
   checksum file
2. install the DMG on a clean Apple Silicon Mac
3. confirm Gatekeeper opens it without a bypass
4. complete dictation and meeting permission setup
5. verify a published-to-draft update path with the exact signed ZIP metadata
6. make the repository public before announcing public download links
7. publish the reviewed draft only when the website and release notes are ready

No public release or website deployment has happened yet.

## Troubleshooting

### Credential preflight fails

- Confirm all five required environment variables are present.
- Confirm the `.p12` password matches the exported certificate.
- Confirm `security find-identity -v -p codesigning` finds the Developer ID
  identity.

### Notarization authentication fails

- Generate a fresh app-specific password for the same Apple ID if needed.
- Confirm that Apple ID belongs to team `AJ9VWBRNZN`.
- Confirm the team ID secret has no whitespace.

### Signing passes but Gatekeeper rejects the app

- Run `xcrun stapler validate` and inspect the notarization result first.
- Do not use an `xattr` bypass as release evidence.
- Rebuild through the official credentialed workflow after fixing
  notarization.

### Entitlement-related launch failure

- Compare the packaged behavior with
  `build-resources/entitlements.mac.plist`.
- Keep `electron-builder.yml` aligned with the app and inherited entitlement
  files.
- Rebuild, notarize, staple, and rerun the trust gate.
