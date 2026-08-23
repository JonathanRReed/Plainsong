# Uninstall and rollback

## Remove the app only

1. Quit Plainsong.
2. Move `/Applications/Plainsong.app` to the Trash.
3. Remove Plainsong from Microphone, Accessibility, Speech Recognition, and
   Screen and System Audio Recording in System Settings if you do not plan to
   reinstall it.

This leaves local history and settings in place for a later reinstall.

## Remove local Plainsong data

This is destructive. Export or back up anything you want to keep first.

After quitting and removing the app, move these folders to the Trash:

- `~/Library/Application Support/Plainsong`
- the Plainsong configuration folder if it is separate on your installation

Open Keychain Access, search for Plainsong, inspect each result, and remove only
credentials you intentionally added for Plainsong. Do not delete unrelated
provider or system credentials.

## Roll back to an earlier beta

The automatic updater rejects downgrades. That is intentional. Contact the beta
owner through the invitation channel before manually reinstalling an older
build, because database migrations may not be backward-compatible.

If a rollback is approved:

1. Quit Plainsong.
2. Create a backup and keep a copy outside the Plainsong data folder.
3. Record the current app version and DMG checksum.
4. Remove the current app only, leaving data untouched.
5. Install the specifically approved, signed and notarized prior DMG.
6. Open it and verify your history before deleting the backup.

Never bypass Gatekeeper or install an artifact whose checksum does not match
the value supplied by the beta owner.
