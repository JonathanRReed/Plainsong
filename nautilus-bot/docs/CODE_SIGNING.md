# Code Signing & Distribution Certification — Nautilus

App bundle identifier: **`com.nautilus.bot`**  
Tauri config: `src-tauri/tauri.conf.json`

This doc covers everything needed to produce signed, verified distributable builds for macOS, Windows, and Linux.

---

## macOS

> [!IMPORTANT]
> You need a **paid Apple Developer Program membership** ($99/year) and a **Mac** to generate certificates. See [docs/APPLE_DEVELOPER_SETUP.md](./APPLE_DEVELOPER_SETUP.md) for the complete step-by-step walkthrough.

### What macOS certification gives you
- App passes Gatekeeper ("not from an unidentified developer")
- Notarization ticket stapled so the app opens offline without phoning home
- Required for distribution outside the Mac App Store

### Quick reference — required GitHub Secrets

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password (not your Apple ID password) |
| `APPLE_TEAM_ID` | 10-character team ID, e.g. `ABCD123456` |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key used to sign update artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key, if you protected it |
| `TAURI_SIGNING_PUBLIC_KEY` | Tauri updater public key injected into `tauri.conf.json` at release build time |

### tauri.conf.json — macOS signing fields

```json
"macOS": {
  "entitlements": "../src-tauri/Entitlements.plist",
  "signingIdentity": null,
  "providerShortName": null
}
```

`signingIdentity` stays `null` — Tauri picks it up automatically from the `APPLE_SIGNING_IDENTITY` environment variable during CI.

Updater note: keep the updater `pubkey` placeholder in source control and inject the real value in CI (`scripts/inject-updater-pubkey.js`) using `TAURI_SIGNING_PUBLIC_KEY`. If the private key is password-protected, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in CI.

### Entitlements.plist — capabilities needed

Nautilus needs microphone access and accessibility to capture system audio:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Microphone / audio capture -->
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.device.microphone</key>
  <true/>
  <!-- Accessibility (for hotkey capture & system audio) -->
  <key>com.apple.security.temporary-exception.apple-events</key>
  <true/>
  <!-- Disable sandbox — required for local Ollama socket + file I/O -->
  <key>com.apple.security.app-sandbox</key>
  <false/>
</dict>
</plist>
```

> [!NOTE]
> `app-sandbox = false` is intentional. Nautilus uses a local UNIX socket to reach Ollama, reads/writes arbitrary audio paths, and accesses system accessibility APIs — none of which are compatible with the Mac App Sandbox. This is fully valid for Developer ID distribution (outside the Mac App Store).

### Build command

```bash
# Run on a macOS runner with secrets set
npm run tauri build
# Tauri automatically signs + notarizes when APPLE_* env vars are present
```

### Verify the build

```bash
# Check signature
codesign --verify --verbose=4 "dist/bundle/macos/Nautilus.app"

# Check notarization ticket
spctl --assess --verbose=4 "dist/bundle/macos/Nautilus.app"
# Expected: "accepted"
```

---

## Windows

Windows uses **Authenticode** signing with an EV (Extended Validation) or OV (Organization Validation) code signing certificate. This stops Windows SmartScreen from showing "Unknown publisher" warnings.

### What Windows signing gives you
- Eliminates SmartScreen "Windows protected your PC" block on first launch
- EV certificates bypass SmartScreen immediately; OV certificates build reputation over time

### Step 1 — Obtain a certificate

You need a certificate from a **Microsoft-trusted CA**. Recommended vendors:

| CA | Type | Cost | Notes |
|---|---|---|---|
| [DigiCert](https://www.digicert.com/signing/code-signing-certificates) | EV / OV | ~$500/yr EV | Best SmartScreen reputation |
| [Sectigo](https://sectigostore.com/code-signing) | EV / OV | ~$200/yr OV | Budget option |
| [SSL.com](https://www.ssl.com/certificates/ev-code-signing/) | EV | ~$250/yr | Good support |

> [!IMPORTANT]
> **EV certificates require physical hardware** (USB token / HSM). The CA ships you a YubiKey or similar device. You cannot export the private key — signing must happen on the token. For CI, you either:
> - Use a cloud HSM (DigiCert KeyLocker, AWS CloudHSM, Azure Key Vault)
> - Sign locally and upload artifacts to the pipeline

### Step 2 — Export the certificate

For an **OV cert** (non-EV):

```powershell
# Export as PFX from Windows Certificate Manager
certmgr.msc
# Right-click certificate → All Tasks → Export → Yes, export private key → PFX
```

For an **EV cert via cloud HSM (DigiCert KeyLocker)**:
- No export needed — Tauri's `tauri_plugin_signing` calls KeyLocker's API at build time
- Add `WINDOWS_CERTIFICATE_THUMBPRINT` and `SM_API_KEY` secrets instead

### Step 3 — Add GitHub Secrets

For OV/PFX:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | `base64 -i cert.pfx` (base64-encoded PFX) |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX password |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key for signed update artifacts |
| `TAURI_SIGNING_PUBLIC_KEY` | Tauri updater public key injected into `tauri.conf.json` during release builds |

For EV via DigiCert KeyLocker:

| Secret | Value |
|---|---|
| `SM_API_KEY` | DigiCert KeyLocker API key |
| `SM_CLIENT_CERT_FILE` | Base64-encoded PKCS#12 auth cert |
| `SM_CLIENT_CERT_PASSWORD` | Auth cert password |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | Thumbprint of your EV cert |

### Step 4 — Configure tauri.conf.json

No Windows-specific signing keys go in the config file — everything comes from environment variables. Tauri Bundler picks them up automatically:

```
WINDOWS_CERTIFICATE=<base64 pfx>
WINDOWS_CERTIFICATE_PASSWORD=<password>
```

### Step 5 — Build

```bash
# On a Windows runner or using cross-compilation
npm run tauri build -- --target x86_64-pc-windows-msvc
```

The output is a signed `.msi` and `.exe` installer in `src-tauri/target/release/bundle/`.

### Step 6 — Verify

```powershell
# Check signature on the installer
Get-AuthenticodeSignature "Nautilus_1.0.0_x64.msi" | Format-List
# Status should be Valid
```

### SmartScreen reputation timeline (OV certs)

OV certs take time to build SmartScreen reputation. During the first ~1,000 downloads users may still see a warning. Options to accelerate:
- Submit to Microsoft via [WDSI](https://www.microsoft.com/en-us/wdsi/filesubmission) as a false positive
- Upgrade to EV — immediate reputation bypass

---

## Linux

Linux has no mandatory code-signing authority. The standard approach is **GPG-signed packages and checksums** so users can verify authenticity without relying on a central CA.

### What Linux signing gives you
- Users can verify the package hasn't been tampered with
- Package managers (apt/dnf) enforce GPG before installing
- AppImage and Flatpak have their own signing mechanisms

### Tauri outputs for Linux

From `npm run tauri build`:

| Format | Path | Use case |
|---|---|---|
| `.deb` | `bundle/deb/nautilus_1.0.0_amd64.deb` | Debian/Ubuntu |
| `.rpm` | `bundle/rpm/nautilus-1.0.0.x86_64.rpm` | Fedora/RHEL |
| `.AppImage` | `bundle/appimage/nautilus_1.0.0_amd64.AppImage` | Universal, no install |

### Step 1 — Generate a GPG signing key

```bash
gpg --full-generate-key
# Choose: RSA and RSA / 4096 bits / does not expire (or 2 years)
# Use your "NautilusBot Releases <releases@nautilusbot.com>" identity

# Get the key ID
gpg --list-secret-keys --keyid-format=long
# Example output: sec   rsa4096/AABBCCDD11223344
```

### Step 2 — Export and store the key

```bash
# Export public key (publish this)
gpg --armor --export AABBCCDD11223344 > nautilus-releases.gpg.pub

# Export private key (keep this secret — goes into GitHub Secrets)
gpg --armor --export-secret-key AABBCCDD11223344 > nautilus-releases.gpg

# Base64-encode for GitHub Secret
base64 -i nautilus-releases.gpg
```

Add to GitHub Secrets:

| Secret | Value |
|---|---|
| `GPG_PRIVATE_KEY` | Base64-encoded private key |
| `GPG_PASSPHRASE` | Passphrase for the key |

### Step 3 — Sign artifacts in CI

Add a post-build step to your GitHub Actions release workflow:

```yaml
- name: Import GPG key
  run: |
    echo "${{ secrets.GPG_PRIVATE_KEY }}" | base64 -d | gpg --batch --import
    echo "${{ secrets.GPG_PASSPHRASE }}" | gpg --batch --yes --passphrase-fd 0 \
      --pinentry-mode loopback --quick-set-expire \
      $(gpg --list-secret-keys --keyid-format=long | grep sec | awk '{print $2}' | cut -d/ -f2) 0

- name: Sign and generate checksums
  run: |
    cd src-tauri/target/release/bundle
    # Sign each artifact
    for f in deb/*.deb rpm/*.rpm appimage/*.AppImage; do
      gpg --batch --passphrase "${{ secrets.GPG_PASSPHRASE }}" \
        --pinentry-mode loopback --detach-sign --armor "$f"
    done
    # Generate SHA-256 checksums
    sha256sum deb/*.deb rpm/*.rpm appimage/*.AppImage > SHA256SUMS
    gpg --batch --passphrase "${{ secrets.GPG_PASSPHRASE }}" \
      --pinentry-mode loopback --detach-sign --armor SHA256SUMS
```

### Step 4 — Publish the public key

Upload `nautilus-releases.gpg.pub` to your website and a keyserver:

```bash
# Upload to Ubuntu keyserver
gpg --keyserver keyserver.ubuntu.com --send-keys AABBCCDD11223344

# Or to keys.openpgp.org
gpg --keyserver keys.openpgp.org --send-keys AABBCCDD11223344
```

Add to your release page:

```markdown
**Verify signature:**
curl -sL https://nautilusbot.jonathanrreed.com/releases/nautilus-releases.gpg.pub | gpg --import
gpg --verify nautilus_1.0.0_amd64.AppImage.asc nautilus_1.0.0_amd64.AppImage
```

### Step 5 — AppImage signing (optional, additional trust)

AppImage has a built-in signing mechanism using `appimagetool`:

```bash
# Sign in CI
export SIGN=1
export APPIMAGETOOL_SIGN_ARGS="--sign-key AABBCCDD11223344"
appimagetool --sign <AppDir> Nautilus.AppImage
```

### Step 6 — Flatpak (future distribution)

For Flatpak distribution via Flathub, sign with your GPG key and submit:
- Create a Flatpak manifest (`.yml` / `.json`)
- Submit to [Flathub](https://flathub.org/) via GitHub PR
- Flathub signs the repo itself — your GPG signature is on the source bundle

---

## GitHub Actions — Unified Release Workflow

All three platforms should trigger from the same tag push. Minimal structure:

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ['v*']

jobs:
  build-macos:
    runs-on: macos-latest
    env:
      APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
      APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
      APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
      APPLE_ID: ${{ secrets.APPLE_ID }}
      APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
      APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci && npm run tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: macos-dmg
          path: src-tauri/target/release/bundle/dmg/*.dmg

  build-windows:
    runs-on: windows-latest
    env:
      WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
      WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci && npm run tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: src-tauri/target/release/bundle/msi/*.msi

  build-linux:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: |
          sudo apt-get update
          sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev \
            libayatana-appindicator3-dev librsvg2-dev patchelf
      - run: npm ci && npm run tauri build
      - name: Sign artifacts
        env:
          GPG_PRIVATE_KEY: ${{ secrets.GPG_PRIVATE_KEY }}
          GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}
        run: |
          echo "$GPG_PRIVATE_KEY" | base64 -d | gpg --batch --import
          for f in src-tauri/target/release/bundle/deb/*.deb \
                   src-tauri/target/release/bundle/appimage/*.AppImage; do
            echo "$GPG_PASSPHRASE" | gpg --batch --passphrase-fd 0 \
              --pinentry-mode loopback --detach-sign --armor "$f"
          done
```

> [!TIP]
> Add a `release` job that depends on all three build jobs and uses `gh release create` to upload all artifacts with a single GitHub Release.

---

## Checklist before first release

### macOS
- [ ] Enrolled in Apple Developer Program
- [ ] Developer ID Application certificate generated and in Keychain
- [ ] Notarization app-specific password created
- [ ] All 6 `APPLE_*` GitHub Secrets populated
- [ ] `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PUBLIC_KEY` secrets populated
- [ ] `codesign --verify` passes locally
- [ ] `spctl --assess` returns "accepted"

### Windows
- [ ] OV or EV code signing certificate purchased
- [ ] PFX exported (OV) or cloud HSM configured (EV)
- [ ] `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` Secrets set
- [ ] `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PUBLIC_KEY` secrets set
- [ ] `Get-AuthenticodeSignature` returns `Valid`
- [ ] SmartScreen shows your publisher name (not "Unknown Publisher")

### Linux
- [ ] GPG 4096-bit key generated for releases
- [ ] Public key uploaded to keyserver + hosted on website
- [ ] `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE` Secrets set
- [ ] CI signs all `.deb`, `.rpm`, `.AppImage` artifacts + `SHA256SUMS`
- [ ] Verification instructions published on download page

---

## Related docs

- [docs/APPLE_DEVELOPER_SETUP.md](./APPLE_DEVELOPER_SETUP.md) — full step-by-step Apple cert walkthrough
- [Tauri Code Signing](https://tauri.app/distribute/sign/)
- [Microsoft Authenticode](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/authenticode)
- [DigiCert KeyLocker (EV in CI)](https://docs.digicert.com/en/digicert-keylocker.html)
