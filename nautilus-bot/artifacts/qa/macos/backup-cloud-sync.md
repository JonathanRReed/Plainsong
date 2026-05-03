# Backup: Cloud provider setup + sync + restore (at least one provider)

Status: PASS
Owner: qa-macos
Evidence: artifacts/qa/macos/backup-create-restore.json
Generated: 2026-05-02T22:42:51.955Z

## Command

`bun run qa:packaged:macos:backup`

## Verification

- Launched the packaged sidecar from `release/mac-arm64/Nautilus.app`.
- Configured the iCloud backup provider against an isolated filesystem root under `artifacts/qa/macos/backup-create-restore-workdir/icloud-root`.
- Verified cloud setup checks passed for cloud sync enabled, backup directory access, provider selection, cloud folder validation, iCloud path resolution, iCloud path existence, and iCloud write access.
- Ran packaged `verify_backup_cloud_connection` successfully.
- Created a settings-only cloud backup through packaged `create_settings_backup_default`.
- Verified the synced provider path contained `settings.json` and `manifest.json`.
- Repointed the backup directory to the synced provider folder and restored through packaged `restore_backup_default`.
- Verified the restored settings hash matched the synced cloud backup hash.
- Restored the original raw settings file bytes and original backup config file state after the sidecar exited.
- Removed the temporary cloud workdir after hashing the restore evidence.

## Result

The packaged app completed provider setup, cloud sync, and restore through the iCloud provider code path without leaving user settings or backup config drift.
