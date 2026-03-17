# Apple Developer Setup Guide for NautilusBot

This guide walks you through setting up an Apple Developer account, obtaining signing certificates, and configuring notarization for NautilusBot macOS releases.

## Prerequisites

- **Apple Developer Program membership** ($99/year)
  - Enroll at: https://developer.apple.com/programs/
  - Takes 24-48 hours for approval

- **Apple ID with two-factor authentication enabled**

- **A Mac computer** (required for generating Certificate Signing Requests)

## Step 1: Enroll in Apple Developer Program

1. Visit https://developer.apple.com/programs/
2. Click "Enroll" and sign in with your Apple ID
3. Complete the enrollment process:
   - Choose entity type (Individual or Organization)
   - Provide required information
   - Pay $99 annual fee
4. Wait for approval email (typically 24-48 hours)

## Step 2: Generate Signing Certificate

### 2.1 Create Certificate Signing Request (CSR)

On your Mac, open Terminal and run:

```bash
# Generate private key
openssl genrsa -out NautilusPrivate.key 2048

# Generate CSR
openssl req -new -key NautilusPrivate.key -out Nautilus.csr \
  -subj "/emailAddress=your-email@example.com, CN=Your Name, C=US"
```

Save these files securely - you'll need the private key for signing.

### 2.2 Request Developer ID Certificate

1. Go to https://developer.apple.com/account/resources/certificates/list
2. Click the "+" button to add a new certificate
3. Select **"Developer ID Application"** (NOT "iOS App Development")
4. Click "Continue"
5. Upload your `Nautilus.csr` file
6. Click "Generate"
7. Download the certificate (named something like `developerID_application.cer`)

### 2.3 Export Certificate as .p12

The GitHub Actions workflow needs the certificate in .p12 format:

```bash
# Convert .cer to .pem
openssl x509 -in developerID_application.cer -inform DER -out NautilusCert.pem -outform PEM

# Create .p12 file (you'll be prompted for a password)
openssl pkcs12 -export -out NautilusCert.p12 \
  -inkey NautilusPrivate.key \
  -in NautilusCert.pem \
  -name "Nautilus Developer ID"
```

**Important**: Choose a strong password and save it securely - you'll need it for GitHub Secrets.

## Step 3: Create App-Specific Password for Notarization

Notarization requires an app-specific password:

1. Sign in to https://appleid.apple.com
2. Go to "Sign-In and Security" → "App-Specific Passwords"
3. Click "Generate an app-specific password"
4. Name it "Nautilus Notarization"
5. Save the generated password securely

## Step 4: Get Team ID

Find your Apple Developer Team ID:

1. Go to https://developer.apple.com/account
2. Look for "Team ID" in the top right or membership details
3. It looks like: `ABCD123456` (10 characters)

## Step 5: Configure GitHub Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

| Secret Name | Value | How to Get |
|-------------|-------|------------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 file | `base64 -i NautilusCert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for .p12 | From step 2.3 |
| `APPLE_SIGNING_IDENTITY` | Certificate Common Name | From Keychain: "Developer ID Application: Your Name (TEAM_ID)" |
| `APPLE_ID` | Your Apple ID email | e.g., `you@example.com` |
| `APPLE_PASSWORD` | App-specific password | From step 3 |
| `APPLE_TEAM_ID` | Team ID | From step 4 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key | Generate with `npm exec tauri signer generate -- -w ~/.tauri/nautilus.key` (keep private key secret) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key | Only needed if you set one during `tauri signer generate` |
| `TAURI_SIGNING_PUBLIC_KEY` | Tauri updater public key | Base64 public key paired with `TAURI_SIGNING_PRIVATE_KEY` |

The release workflow injects `TAURI_SIGNING_PUBLIC_KEY` into `src-tauri/tauri.conf.json` via `scripts/inject-updater-pubkey.js` before Tauri build/sign steps.

### Add Secrets via GitHub CLI (optional):

```bash
# Encode certificate
export CERT_BASE64=$(base64 -i NautilusCert.p12)

# Add secrets
github secret set APPLE_CERTIFICATE -b "$CERT_BASE64"
github secret set APPLE_CERTIFICATE_PASSWORD -b "your-p12-password"
github secret set APPLE_SIGNING_IDENTITY -b "Developer ID Application: Your Name (TEAM_ID)"
github secret set APPLE_ID -b "you@example.com"
github secret set APPLE_PASSWORD -b "your-app-specific-password"
github secret set APPLE_TEAM_ID -b "ABCD123456"
```

## Step 6: Configure Tauri

### 6.1 Update tauri.conf.json

Make sure your `src-tauri/tauri.conf.json` has these settings:

```json
{
  "bundle": {
    "macOS": {
      "entitlements": "../src-tauri/Entitlements.plist",
      "providerShortName": null,
      "signingIdentity": null
    }
  }
}
```

**Note**: The `signingIdentity` and `providerShortName` are set to `null` because they will be provided via environment variables during CI/CD.

### 6.2 Update Entitlements

Ensure your `src-tauri/Entitlements.plist` includes necessary permissions:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.microphone</key>
    <true/>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
```

## Step 7: Test Locally (Optional)

To test signing locally before pushing:

```bash
# Set environment variables
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="your-app-specific-password"
export APPLE_TEAM_ID="ABCD123456"

# Build
npm run tauri build
```

## Step 8: Test CI/CD Release

1. Create a test tag:
   ```bash
   git tag -a v0.0.1-test -m "Test release"
   git push origin v0.0.1-test
   ```

2. Monitor the GitHub Actions workflow

3. Download and test the signed app

4. Delete the test tag:
   ```bash
   git tag -d v0.0.1-test
   git push --delete origin v0.0.1-test
   ```

## Troubleshooting

### "No valid signing identity found"
- Verify `APPLE_SIGNING_IDENTITY` matches exactly what's in your Keychain
- Format should be: `Developer ID Application: Your Name (TEAM_ID)`

### "Authentication failed" during notarization
- Check that `APPLE_ID` and `APPLE_PASSWORD` are correct
- Ensure the password is an app-specific password, not your Apple ID password
- Verify `APPLE_TEAM_ID` is correct

### Certificate expired
- Certificates expire after 5-7 years
- Generate a new one following steps 2.1-2.3
- Update GitHub Secrets with the new certificate

### "Team ID not found"
- Make sure your Apple ID is part of a Developer Team
- Check https://developer.apple.com/account for your Team ID
- Individual developers still have a Team ID

## Security Best Practices

1. **Never commit certificates or private keys** to Git
2. **Rotate certificates annually** (optional but recommended)
3. **Use strong, unique passwords** for .p12 files
4. **Limit access** to GitHub Secrets to maintainers only
5. **Store backup copies** of certificates and keys in a secure password manager

## Renewing Certificates

Certificates expire after 5-7 years. To renew:

1. Generate new CSR (step 2.1)
2. Request new certificate (step 2.2)
3. Export as .p12 (step 2.3)
4. Update `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` in GitHub Secrets
5. Revoke the old certificate in Apple Developer Portal

## Additional Resources

- [Apple Developer Documentation](https://developer.apple.com/documentation/xcode/creating-distribution-signed-custom-apps)
- [Tauri Code Signing Guide](https://tauri.app/v1/guides/distribution/sign-macos)
- [Notarizing macOS Software](https://developer.apple.com/documentation/xcode/notarizing_macos_software_before_distribution)

## Next Steps

After completing this setup:

1. ✅ Apple Developer Program enrolled
2. ✅ Signing certificate generated and uploaded to GitHub Secrets
3. ✅ Notarization credentials configured
4. ✅ Test release created successfully
5. 🎉 You're ready for production releases!

The CI/CD workflow will now automatically sign and notarize your macOS releases when you push version tags.
