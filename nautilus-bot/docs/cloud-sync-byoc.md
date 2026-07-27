# Cloud Sync, Bring Your Own Cloud (BYOC)

Plainsong is **local-first**: recordings, transcripts, and local secrets stay on your machine by default. Cloud sync is optional, uses *your* storage, and is not a hosted Plainsong cloud service.

Current product note:

- manual backup and cloud sync are available to every user
- cloud providers are optional BYOC integrations
- Plainsong never uploads or downloads a backup automatically

## Supported Providers

| Provider | Backup transport | Setup |
|----------|------------------|-------|
| iCloud Drive | Direct file copy | Choose or auto-detect the iCloud Drive root |
| Google Drive | `rclone` | Create a Google Drive remote |
| OneDrive | `rclone` | Create a OneDrive remote |
| Proton Drive | `rclone` | Create a Proton Drive remote |

## Manual Exports to a Synced Folder

1. Open **Settings → Storage**.
2. Set **Export root** to an absolute folder inside your provider's local sync
   directory:
   - iCloud: `/Users/you/Library/Mobile Documents/com~apple~CloudDocs/Plainsong`
   - Dropbox: `/Users/you/Dropbox/Plainsong`
   - Google Drive: `/Users/you/Google Drive/My Drive/Plainsong`
3. Open a recording or the Exports view, choose the destination under that
   root, and export it.
4. Repeat the export when the transcript or notes change. The export-root
   setting is a path boundary, not an automatic export service.

> **Encryption note**: Markdown, JSON, and text exports are readable files.
> Vault encryption protects Plainsong's managed database and recording store;
> it does not encrypt files you explicitly export. Protect the destination with
> the cloud provider's encryption and access controls.

## Manual Cloud Backup

Plainsong creates versioned backup generations locally, then uploads only when
you press a Sync button:

1. Install and configure `rclone` for Google Drive, OneDrive, or Proton Drive.
   iCloud Drive uses a direct filesystem path and does not require `rclone`.
2. Open **Settings → Storage → Backup**.
3. Enable **Manual cloud sync**, select the provider, and configure the cloud
   folder and remote name.
4. Run **Setup Checks** and **Verify Cloud Connection**.
5. Create a settings snapshot or full backup.
6. Press the matching **Sync Latest** button.

Cloud sync is upload-only. To restore on another Mac, first make the backup
generation available locally through iCloud Drive or an explicit `rclone copy`,
set Plainsong's backup directory to that local folder, then use the matching
Restore action.

## Syncthing and Other Folder-Sync Tools

Folder-sync tools can carry exported files or complete backup generations
between devices. Point them at a dedicated export or backup folder.

> **Warning**: Do not live-sync
> `~/Library/Application Support/Plainsong`. The database and active recording
> bundles are application-managed. Create a complete backup first, then sync
> that published backup generation.

## Security Considerations

- **Vault encryption**: Enable Vault encryption before creating backups that
  contain sensitive managed recordings.
- **Cloud credentials**: iCloud uses the signed-in system account. Other
  providers use your external `rclone` configuration; Plainsong does not ask
  for or store those provider credentials.
- **Zero-knowledge**: We have no access to your cloud storage. Plainsong talks directly to your provider.
- **Backup scope**: Settings snapshots exclude recordings and transcripts.
  Full backups include the managed database, settings, and recording bundles.

## Troubleshooting

| Issue | Solution |
|-------|---------|
| Export not appearing | Confirm the destination is under the configured export root, then export again |
| Backup not uploading | Run Setup Checks, verify the `rclone` remote or iCloud path, then press Sync again |
| Duplicate files | Check that only one Plainsong instance writes to the sync folder at a time |
| Full backup is large | Use a settings snapshot when recordings and transcripts are not needed |
| Restore cannot find a cloud backup | Copy or mount the backup generation locally and point the backup directory at it |

Automatic scheduling is intentionally absent in v1. Use the explicit create,
sync, and restore actions so no recording or transcript leaves the Mac without
a user action.
