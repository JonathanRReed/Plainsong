# Apple Developer Setup

This guide covers the Apple-side prerequisites for shipping the Electron build of Nautilus on macOS.

## Prerequisites

- Apple Developer Program membership
- Apple ID with two-factor authentication
- A Mac with Keychain Access and Xcode command line tools

## 1. Confirm team access

1. Sign in at [developer.apple.com](https://developer.apple.com/).
2. Confirm your membership is active.
3. Record your Apple team ID from the account portal.

## 2. Create a Developer ID Application certificate

Generate a private key and certificate signing request:

```bash
openssl genrsa -out NautilusPrivate.key 2048
openssl req -new -key NautilusPrivate.key -out Nautilus.csr \
  -subj "/emailAddress=your-email@example.com, CN=Your Name, C=US"
```

Then in the Apple developer portal:

1. Open Certificates.
2. Create a new `Developer ID Application` certificate.
3. Upload `Nautilus.csr`.
4. Download the generated certificate.

Export the certificate and private key as a `.p12` bundle for CI:

```bash
openssl x509 -in developerID_application.cer -inform DER -out NautilusCert.pem -outform PEM
openssl pkcs12 -export -out NautilusCert.p12 \
  -inkey NautilusPrivate.key \
  -in NautilusCert.pem \
  -name "Nautilus Developer ID"
```

## 3. Create notarization credentials

1. Sign in at [appleid.apple.com](https://appleid.apple.com/).
2. Generate an app-specific password.
3. Store that password with the Apple ID and team ID used for release notarization.

## 4. Keep the repo config aligned

The Electron packaging files that matter for macOS are:

- `electron-builder.yml`
- `build-resources/entitlements.mac.plist`
- `build-resources/entitlements.mac.inherit.plist`

If you need additional permissions for dictation, meeting capture, or automation, update those entitlement files. Do not add retired desktop-shell config files back into the repo.

## 5. Run a local package build

```bash
bun install
bun run electron:build:dmg
```

Expected outputs land in `release/`, including `Nautilus.app` and a DMG.

## 6. Verify signing and notarization

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Nautilus.app"
spctl --assess --verbose=4 "release/mac-arm64/Nautilus.app"
```

For a release-ready build, `spctl` should report `accepted`.

## Troubleshooting

### No valid signing identity found

- Confirm the Developer ID Application certificate is installed in Keychain.
- Confirm the certificate common name matches the identity configured in your release environment.

### Notarization authentication failed

- Recheck the Apple ID, app-specific password, and team ID.
- Make sure the Apple ID belongs to the same developer team as the signing certificate.

### Entitlement-related launch failure

- Compare the packaged app behavior against `build-resources/entitlements.mac.plist`.
- Keep changes minimal, then rebuild and reassess with `codesign` and `spctl`.
