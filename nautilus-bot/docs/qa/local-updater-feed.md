# Signed local updater QA

This checks the packaged updater without changing DNS, hosts, VPN, proxies or
system settings. It does not prove the public update feed. Run it only with
signed candidates prepared for this test. The implementation tests and dry run
do not establish a successful packaged update.

`PLAINSONG_QA_UPDATE_FEED_URL` is read once by Electron main at launch. It accepts
HTTP or HTTPS with the literal authority `127.0.0.1`, `[::1]` or `localhost` and
an optional port. Userinfo, alternate IP spellings, lookalike names, backslashes
and whitespace are rejected. Invalid values are ignored with one warning that
omits the input. There is no setting or IPC command for this override.

While active, the electron-updater session uses a direct connection, cancels
non-loopback requests, and rejects every HTTP 3xx response. This also blocks
absolute remote ZIP and blockmap URLs in a local manifest. The restriction is
app-local. It does not change the machine's proxy settings.

The installed dependency, electron-updater 6.8.9, follows redirects in
`out/electronHttpExecutor.js`, including requests for manifests, artifacts and
blockmaps. Its `out/MacUpdater.js` verifies the downloaded ZIP's manifest hash
and hands it to Electron's native updater through its own authenticated
127.0.0.1 proxy. Squirrel.Mac checks the update's code signature against the
running app before installation. The QA path retains that code, Plainsong's
Developer ID/team check, and the forward-version check. It does not disable
signature or hash verification. See [Electron's signing requirement](https://www.electronjs.org/docs/latest/api/auto-updater)
and [electron-builder's macOS signature verification](https://www.electron.build/docs/features/key-rotation/).

Use two candidate directories outside `/Applications`. Both candidates must
contain this patch. The old candidate must already support the override; an
older beta.7 binary cannot gain it through an environment variable. For this
run, b7' means an internal `0.9.0-beta.8` build of the intended b7 update.
Use matching package, sidecar and bundle versions when preparing that signed
candidate through the existing release process. `0.9.0-beta.7+qa` is not newer
than beta.7. Neither a version bump nor candidate building is part of this QA
command. Do not publish the internal candidate.

Given complete signed release directories at `/tmp/plainsong-b7` and
`/tmp/plainsong-b7-prime`, each with its `mac-arm64/Plainsong.app`, ZIP, blockmap,
DMG and `beta-mac.yml`, run:

```sh
# From the app directory, nautilus-bot/
bun install --frozen-lockfile

bun scripts/verify-macos-release-trust.ts \
  --app /tmp/plainsong-b7/mac-arm64/Plainsong.app \
  --release-dir /tmp/plainsong-b7 --expected-team AJ9VWBRNZN \
  --out /tmp/plainsong-b7/trust.json --markdown /tmp/plainsong-b7/trust.md
bun scripts/verify-macos-release-trust.ts \
  --app /tmp/plainsong-b7-prime/mac-arm64/Plainsong.app \
  --release-dir /tmp/plainsong-b7-prime --expected-team AJ9VWBRNZN \
  --out /tmp/plainsong-b7-prime/trust.json --markdown /tmp/plainsong-b7-prime/trust.md

journey_args=(
  --before-app /tmp/plainsong-b7/mac-arm64/Plainsong.app
  --after-app /tmp/plainsong-b7-prime/mac-arm64/Plainsong.app
  --before-artifact /tmp/plainsong-b7/Plainsong-0.9.0-beta.7-arm64.dmg
  --after-artifact /tmp/plainsong-b7-prime/Plainsong-0.9.0-beta.8-arm64.dmg
  --before-trust /tmp/plainsong-b7/trust.json
  --after-trust /tmp/plainsong-b7-prime/trust.json
  --manifest /tmp/plainsong-b7-prime/beta-mac.yml
  --expected-before-version 0.9.0-beta.7
  --expected-after-version 0.9.0-beta.8
  --scenario all
  --out artifacts/qa/macos/local-updater
)
bun scripts/capture-packaged-macos-beta-update.ts --dry-run "${journey_args[@]}"
bun scripts/capture-packaged-macos-beta-update.ts --run-local "${journey_args[@]}"
```

The dry run validates versions, trust receipt bindings and static feed inputs,
serves each scenario's manifest, and exits without launching an app. Its output
says `pass: false` and `packagedJourneyRun: false` because it is not update proof.
The unit suite separately exercises ZIP corruption, connection drops and ranges.

The full run copies the old app into a fresh temporary directory per scenario.
It creates HOME, CFFIXED_USER_HOME, Electron userData, config, data and caches
there. It does not clone the user's profile. It seeds synthetic settings,
onboarding, dictation and meeting records, then reads them through the app's
existing commands. A loopback CDP port drives those commands. No new IPC is added.
The QA relaunch uses the copied executable directly and retains its environment
and profile arguments.

Scenarios run in this order:

- `corrupt` flips a byte in the temporary ZIP while keeping the original hash
  in the manifest. It requires a checksum failure, no installation, and a
  successful restart of the old version with its synthetic state intact.
- `interrupted` closes the first ZIP response mid-file. The runner requires the
  failed download, retries Install, and verifies installation and relaunch.
  electron-updater may restart the file instead of resuming at a byte offset;
  request receipts show which happened. The server also supports byte ranges.
- `success` checks, downloads, waits for native staging, and installs on quit.

Successful update receipts require observed updater events, the managed app
quit, a newly connected renderer reporting the target version, verified signing,
matching installed Info.plist and app.asar hashes, and preserved synthetic state.
They pass through the existing journey verifier. Corruption has its own receipt
because rejection is the expected outcome. Every scenario retains its isolated
candidate path in the receipt and stops only processes with that new profile.
The temporary static feed is removed on completion. Inspect the receipts and
logs before deleting the retained candidate directories.
