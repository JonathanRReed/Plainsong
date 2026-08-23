# Apple Developer release setup

This guide covers the Apple-side work required to reproduce and stage the
limited Plainsong macOS beta.

## Confirmed local state

As of August 8, 2026:

- a Developer ID Application identity for team `AJ9VWBRNZN` is installed
- the local `plainsong-notary` Keychain profile authenticates successfully
- the exact `release/mac-arm64/Plainsong.app` beta candidate, sidecar, native
  shortcut helper, and Apple Speech helper are Developer ID signed
- hardened runtime and secure timestamps are present
- the app and DMG are notarized and stapled
- Gatekeeper reports `source=Notarized Developer ID` for both surfaces
- the arm64 DMG, ZIP, blockmap, and beta updater manifest are built locally
- no release, update feed, website deployment, or beta invitation has been
  published

Use only `plainsong-notary` for local notarization. A new final candidate must
still run the full credentialed build, DMG submission, stapler, Gatekeeper, and
repository trust gates. Never transfer trust receipts from an older candidate.

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

### Recreating the `notarytool` Keychain profile

The `plainsong-notary` profile already exists on the release machine. Use these
steps only when replacing it or provisioning another trusted release machine.
Only the account holder should handle the Apple ID and app-specific password.

1. Create an app-specific password at
   [account.apple.com](https://account.apple.com/) under Sign-In and Security →
   App-Specific Passwords. It is shown once.
2. Store it against a profile name. The command prompts for the password; it is
   written to the login Keychain and never echoed:

   ```bash
   xcrun notarytool store-credentials "plainsong-notary" --apple-id "<apple-id-email>" --team-id "AJ9VWBRNZN"
   ```

3. Confirm the profile resolves and authenticates:

   ```bash
   xcrun notarytool history --keychain-profile "plainsong-notary"
   ```

For a local machine with that profile in place, use `CSC_NAME` and
`APPLE_KEYCHAIN_PROFILE` instead of exporting the certificate and Apple ID
password:

```bash
CSC_NAME="Jonathan Reed (AJ9VWBRNZN)" \
APPLE_KEYCHAIN_PROFILE="plainsong-notary" \
bun run gate:release-credentials:preflight

CSC_NAME="Jonathan Reed (AJ9VWBRNZN)" \
APPLE_KEYCHAIN_PROFILE="plainsong-notary" \
bun run release:mac
```

Do not include the `Developer ID Application:` prefix in `CSC_NAME`;
`electron-builder` rejects the prefixed form. You can also omit `CSC_NAME`
when automatic identity discovery selects the intended Developer ID identity.

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

## 6. Run the artifact-staging release workflow

After the release changes are merged and the intended beta tag exists, trigger
`.github/workflows/release.yml` with that tag. For this candidate, the tag is
`v0.9.0-beta.2`.

The workflow:

1. verifies source and tag consistency
2. fails closed if any signing or notarization credential is missing
3. builds the DMG, ZIP, blockmaps, and updater metadata without publishing
4. verifies signatures, notarization, stapling, Gatekeeper, TCC strings, size,
   and updater metadata
5. creates or refreshes an artifact-only draft GitHub release after every
   automated artifact check passes

The workflow refuses to overwrite a published release. Its draft does not
prove the real-hardware Dictation, Meetings, clean-install, updater-journey, or
three-hour soak gates. The aggregate release audit remains authoritative for
beta readiness.

## 7. Review before launch

Before publishing the draft:

1. verify the draft contains the DMG, ZIP, blockmap, `beta-mac.yml`, and
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
