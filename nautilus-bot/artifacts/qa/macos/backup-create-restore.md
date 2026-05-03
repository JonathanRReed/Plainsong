# Backup: Create backup / restore backup

Status: PASS
Owner: qa-macos
Evidence: artifacts/qa/macos/backup-create-restore.json
Generated: 2026-05-02T22:42:51.955Z

## Command

`bun run qa:packaged:macos:backup`

## Verification

- Launched the packaged sidecar from `release/mac-arm64/Nautilus.app`.
- Saved an isolated backup config pointing to `artifacts/qa/macos/backup-create-restore-workdir`.
- Created a settings-only backup through packaged `create_settings_backup_default`.
- Verified the backup directory contains `settings.json` and `manifest.json` with the `settings` component.
- Mutated the live settings file through packaged `save_settings`.
- Restored the created backup through packaged `restore_backup_default`.
- Verified the restored settings file hash matched the backup settings hash.
- Verified packaged `list_backups` included the created backup id.
- Restored the original raw settings file bytes and original backup config file state after the sidecar exited.
- Removed the temporary backup workdir after hashing the restore evidence.

## Result

The packaged app created and restored a settings backup successfully without leaving user settings or backup config drift.
