# Cloud Sync — Bring Your Own Cloud (BYOC)

Nautilus is **local-first**: all recordings, transcripts, and encryption keys stay on your Mac by default. Cloud sync is optional and uses *your* storage — we never host your data.

## Supported Providers

| Provider | Protocol | Free tier | Setup difficulty |
|----------|----------|-----------|-----------------|
| iCloud Drive | File system | 5 GB | Trivial |
| Dropbox | File system | 2 GB | Easy |
| Google Drive | File system | 15 GB | Easy |
| S3-compatible | S3 API | Varies | Moderate |
| Syncthing | P2P | Unlimited | Moderate |

## Quick Start: iCloud Drive / Dropbox / Google Drive

1. Open **Settings → Storage**.
2. Set **Export root** to a folder inside your cloud provider's sync folder:
   - iCloud: `~/Library/Mobile Documents/com~apple~CloudDocs/Nautilus`
   - Dropbox: `~/Dropbox/Nautilus`
   - Google Drive: `~/Google Drive/My Drive/Nautilus`
3. Enable **Auto-export** so new transcripts are written there automatically.
4. Your recordings and transcripts sync across any Mac with the same cloud folder.

> **Encryption note**: If you have Vault encryption enabled, exported files are encrypted at rest. The encryption key is stored in your macOS Keychain — you must transfer it manually to other machines via `security export` or by re-entering your Vault passphrase.

## S3-Compatible Storage (Advanced)

For users who want programmatic access or cross-platform sync via S3-compatible storage (AWS S3, Backblaze B2, MinIO, Cloudflare R2):

1. Create a bucket (e.g. `nautilus-backup`).
2. Create an IAM user or application key with `PutObject` and `GetObject` permissions.
3. Open **Settings → Storage → Backup**.
4. Enter:
   - **Endpoint** (leave blank for AWS S3)
   - **Bucket name**
   - **Access key ID**
   - **Secret access key**
   - **Region** (e.g. `us-east-1`)
5. Click **Verify Connection** to test.
6. Enable scheduled backups or trigger manual sync.

### Cost Estimate

| Provider | Storage cost | Egress |
|----------|-------------|--------|
| AWS S3 | $0.023/GB/mo | $0.09/GB |
| Backblaze B2 | $0.006/GB/mo | Free 1 GB/day |
| Cloudflare R2 | $0.015/GB/mo | Free egress |

## Syncthing (P2P, No Cloud)

For maximum privacy, use [Syncthing](https://syncthing.net/) to sync directly between your devices with no cloud intermediary:

1. Install Syncthing on all devices.
2. Share the Nautilus data folder (`~/Library/Application Support/Nautilus`).
3. Syncthing handles conflict resolution and versioning automatically.

> **Warning**: Do not sync the SQLite database file while Nautilus is running. Only sync the `exports/` and `audio/` directories, or stop Nautilus before syncing.

## Security Considerations

- **Vault encryption**: Always enable Vault encryption before syncing sensitive recordings to any cloud provider.
- **API keys**: Nautilus stores cloud credentials in the macOS Keychain, never in plain text.
- **Zero-knowledge**: We have no access to your cloud storage. Nautilus talks directly to your provider.
- **Selective sync**: You can choose to sync only transcripts (small) and skip audio files (large) to save bandwidth.

## Troubleshooting

| Issue | Solution |
|-------|---------|
| Files not syncing | Verify the export root path exists and your cloud app is running |
| Duplicate files | Check that only one Nautilus instance writes to the sync folder at a time |
| Large audio files slow to sync | Use selective sync to skip `.wav` files, or compress exports |
| Encryption key mismatch | Re-enter your Vault passphrase on the new machine, or export/import the keychain entry |

## Roadmap

- **Scheduled sync**: Automatic periodic backup to S3-compatible storage (coming soon).
- **Selective export**: Fine-grained control over which projects/recordings sync.
- **Cross-platform**: Windows and Linux support for cloud sync paths.
