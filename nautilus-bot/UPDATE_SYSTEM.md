# NautilusBot Licensing & Update System - Implementation Summary

## Overview

This implementation adds a production-ready licensing, tier management, and automatic update system to NautilusBot. The system includes:

- **Entitlement-based update gating** - Only licensed users or active trials can receive updates
- **Tier-specific activation limits** - 5 devices for Basic, 10 for Friends Club
- **Dual update channels** - Stable for all entitled users, Beta for Friends Club only
- **Automated CI/CD** - Full release pipeline with signing and notarization
- **Professional hosting** - Artifacts on GitHub Releases, manifests on custom domain

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (React)                          │
├─────────────────────────────────────────────────────────────────────┤
│  UpdateStatusWidget    BetaChannelToggle    Update Gating UI       │
│  (Check/install)       (Friends Club only)  (License prompts)      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                        Rust Backend (Tauri)                         │
├─────────────────────────────────────────────────────────────────────┤
│  UpdateService         LicenseManager         SettingsManager      │
│  ├─ Entitlement checks ├─ LS API integration  ├─ UpdateChannel    │
│  ├─ Beta gating        ├─ Tier detection      └─ Auto-check pref  │
│  └─ Status tracking    └─ 5/10 device limits                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                       External Services                             │
├─────────────────────────────────────────────────────────────────────┤
│  Lemon Squeezy          GitHub Releases         nautilusbot.com    │
│  (License validation)   (Artifacts)             (Manifest CDN)     │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Dependencies & Configuration (Phase 1)

**Files Modified:**
- `src-tauri/Cargo.toml` - Added `tauri-plugin-updater = "2"` and `lazy_static = "1.4"`
- `src-tauri/tauri.conf.json` - Added updater configuration with endpoints
- `src-tauri/capabilities/main-capability.json` - Added updater permissions
- `package.json` - Added `@tauri-apps/plugin-updater`

**Key Configuration:**
```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://nautilusbot.jonathanrreed.com/updates/{{target}}/{{arch}}/{{current_version}}"
      ],
      "dialog": false,
      "pubkey": "YOUR_ED25519_PUBLIC_KEY_HERE"
    }
  }
}
```

### 2. Enhanced License System (Phase 2)

**File Modified:** `src-tauri/src/license.rs`

**Changes:**
- Added `trial_active` boolean field to `LicenseInfo` struct
- Implemented `get_tier_activation_limit()` function:
  - Basic: 5 devices
  - Friends Club: 10 devices
- Updated activation error messages to show tier-specific limits

### 3. Update Service Module (Phase 3)

**Files Created:**
- `src-tauri/src/update/mod.rs` - Module exports
- `src-tauri/src/update/types.rs` - UpdateChannel, UpdateError, UpdateInfo, UpdateStatus
- `src-tauri/src/update/gating.rs` - Entitlement checking logic
- `src-tauri/src/update/service.rs` - UpdateService implementation

**Key Features:**
- Entitlement-based gating: Updates only for valid licenses or active trials
- Beta channel restricted to Friends Club tier
- Lazy-static storage for current channel and status
- Integration with tauri-plugin-updater

### 4. Settings Extension (Phase 4)

**File Modified:** `src-tauri/src/settings.rs`

**Added:**
```rust
pub struct UpdateSettings {
    pub channel: UpdateChannel,      // "stable" or "beta"
    pub auto_check: bool,            // Check on startup
    pub last_check_at: Option<String>,
    pub last_seen_version: Option<String>,
}
```

### 5. Tauri Commands (Phase 5)

**File Modified:** `src-tauri/src/lib.rs`

**Commands Added:**
- `check_for_updates()` - Check for updates with entitlement validation
- `install_update()` - Download and install update
- `get_update_status()` - Get current update status
- `get_update_channel()` / `set_update_channel()` - Channel management
- `can_use_beta_channel()` - Check beta access
- `get_update_lock_reason()` - Get unlock requirements

### 6. Frontend Components (Phase 6)

**Files Created:**
- `src/components/update/UpdateStatusWidget.tsx` - Update check/install UI
- `src/components/update/BetaChannelToggle.tsx` - Beta channel toggle (FC only)
- `src/components/update/index.ts` - Component exports
- `src/hooks/use-update-check.ts` - Update checking hook
- `src/lib/tauri.ts` - Added update commands and types

**Settings View Updated:**
- Added "Updates" tab with UpdateStatusWidget and BetaChannelToggle
- Updated License tab to show correct device limit (5 vs 10)

### 7. Manifest Generation Scripts (Phase 7)

**Files Created:**
- `scripts/generate-update-manifest.js` - Generates Tauri updater manifest JSON
- `scripts/sign-update.js` - Signs artifacts with Ed25519

**Usage:**
```bash
# Generate manifest
node scripts/generate-update-manifest.js --version 1.2.3 --channel stable

# Sign artifact
node scripts/sign-update.js --file Nautilus_1.2.3_aarch64.dmg --key private.key

# Generate keypair
node scripts/sign-update.js --generate-keypair
```

### 8. CI/CD Release Workflow (Phase 8)

**File Created:** `.github/workflows/release.yml`

**Workflow Features:**
- Builds for macOS (Apple Silicon + Intel) and Windows
- Code signing with Apple Developer ID
- Notarization with Apple notarytool
- Artifact signing with Ed25519
- Manifest generation and upload
- Optional CDN deployment (S3 + CloudFront)
- Supports both stable and beta channels

**Required GitHub Secrets:**
- `APPLE_CERTIFICATE` - Base64-encoded .p12
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`
- `TAURI_SIGNING_PRIVATE_KEY`

### 9. Documentation (Phase 9)

**File Created:** `docs/APPLE_DEVELOPER_SETUP.md`

Comprehensive guide covering:
- Apple Developer Program enrollment
- Certificate generation and export
- App-specific password creation
- GitHub Secrets configuration
- Troubleshooting common issues

## Feature Gating Matrix

| Feature | None | Basic | Friends Club | Trial |
|---------|------|-------|--------------|-------|
| App Usage | ✅ | ✅ | ✅ | ✅ |
| Stable Updates | ❌ | ✅ | ✅ | ✅ |
| Beta Updates | ❌ | ❌ | ✅ | ❌ |
| Cloud Sync | ❌ | ❌ | ✅ | ❌ |
| Priority Support | ❌ | ❌ | ✅ | ❌ |
| Device Limit | 0 | 5 | 10 | N/A |

## Security Considerations

1. **Signature Verification**: All updates signed with Ed25519
2. **Entitlement Checks**: Updates blocked for unlicensed users
3. **HTTPS Only**: Update endpoints use TLS
4. **No Secrets in Code**: All sensitive data in GitHub Secrets
5. **Certificate Security**: Apple Developer certs stored securely

## Next Steps

### Immediate (Before First Release)

1. **Set up Apple Developer account** (follow `docs/APPLE_DEVELOPER_SETUP.md`)
2. **Configure GitHub Secrets** with certificates and credentials
3. **Generate Ed25519 keypair** for update signing
4. **Update `tauri.conf.json`** with public key
5. **Set up CDN** (S3/CloudFront) for manifest hosting
6. **Configure DNS** for nautilusbot.jonathanrreed.com

### Testing

1. Create test release tag: `git tag -a v0.0.1-test -m "Test"`
2. Push tag to trigger workflow
3. Download and verify signed app
4. Test update flow end-to-end
5. Delete test tag: `git tag -d v0.0.1-test`

### Production Release

1. Update CHANGELOG.md
2. Bump version in `package.json` and `Cargo.toml`
3. Create release tag: `git tag -a v1.0.0 -m "Release v1.0.0"`
4. Push tag to trigger production build
5. Monitor workflow execution
6. Verify manifests deployed to CDN

## File Summary

### Modified (7 files)
1. `src-tauri/Cargo.toml`
2. `src-tauri/tauri.conf.json`
3. `src-tauri/capabilities/main-capability.json`
4. `src-tauri/src/license.rs`
5. `src-tauri/src/settings.rs`
6. `src-tauri/src/lib.rs`
7. `src/components/views/settings-view-simple.tsx`

### Created (14 files)
1. `src-tauri/src/update/mod.rs`
2. `src-tauri/src/update/types.rs`
3. `src-tauri/src/update/gating.rs`
4. `src-tauri/src/update/service.rs`
5. `src/components/update/UpdateStatusWidget.tsx`
6. `src/components/update/BetaChannelToggle.tsx`
7. `src/components/update/index.ts`
8. `src/hooks/use-update-check.ts`
9. `scripts/generate-update-manifest.js`
10. `scripts/sign-update.js`
11. `.github/workflows/release.yml`
12. `docs/APPLE_DEVELOPER_SETUP.md`

## Verification

### Backend Tests
```bash
cd src-tauri && cargo test update::
```

### Frontend Tests
```bash
npm test
```

### Build Verification
```bash
npm run tauri build
```

### Manual Testing Checklist
- [ ] Trial user can check for stable updates
- [ ] Trial user cannot use beta channel
- [ ] Basic licensed user can check for stable updates
- [ ] Basic licensed user cannot use beta channel
- [ ] Friends Club user can use beta channel
- [ ] Expired trial user cannot check for updates
- [ ] Device limits enforced correctly (5 vs 10)
- [ ] Update install works and restarts app

## Support

For issues or questions:
1. Check `docs/APPLE_DEVELOPER_SETUP.md` for signing issues
2. Review GitHub Actions logs for build failures
3. Verify GitHub Secrets are configured correctly
4. Test update flow with test releases before production
