# A signed Plainsong you can install and use on this Mac — build receipt

**Date:** 2026-09-03
**Machine:** Apple M4 Pro (14 cores), 24 GB, macOS 27.0 (build 26A5406e), Xcode 26.2
**Branch:** `worktree-agent-a7989c7610bb925cf`, merged to `parity-waves` @ `39a987a1`
**Commit under test:** `59605fb1` (`fix(release): let the packaged-helper gate run on an unsigned bundle`)
**Version:** `0.9.0-beta.3` (`CFBundleVersion` 900303)

This build is **signed and NOT notarized**. What that means in practice is the
last section of this file; read it before handing the DMG to anyone.

## The artifact

| | |
|---|---|
| DMG | `nautilus-bot/release/Plainsong-0.9.0-beta.3-arm64.dmg` |
| DMG size | 129,140,311 bytes (123.2 MiB) |
| DMG sha256 | `1fcbe41d104219e389d7d2079800c671ef09182a4be37eb229bf8eda86298fb7` |
| DMG format | UDIF read-only compressed (lzfse) — the `ULFO` the config asks for |
| App inside | `Plainsong.app`, 311,358,436 bytes / 296.93 MiB |
| ZIP (updater) | `Plainsong-0.9.0-beta.3-arm64-mac.zip`, 130,152,737 bytes |
| ZIP sha256 | `9372835a491ad7be9d2a45afe901b004046bfb6da328238d17a010041acf6985` |
| Blockmap | `Plainsong-0.9.0-beta.3-arm64-mac.zip.blockmap`, 137,651 bytes |
| Update manifest | `release/beta-mac.yml`, version `0.9.0-beta.3`, channel `beta` |

To install: open the DMG, drag `Plainsong` onto the `/Applications` alias
beside it. The image mounts read-only and was verified whole — see
"The DMG was opened, not just produced" below.

## Exact commands

Run from `nautilus-bot/`, with `CARGO_TARGET_DIR` pointed at the shared
sidecar target directory.

```
bun run gate:release-credentials:preflight     # reports NOT READY, see below
bun run electron:pack                          # now finishes; see "The blocker"
bun run release:mac                            # the DMG + ZIP + manifest
bun run gate:size
bun run gate:cold-start
bun run gate:packaged:macos:native
bun run gate:release:dependencies              # FAILS, pre-existing, see below
bun run gate:release:licenses
bun run qa:packaged:macos:update-metadata
```

Source gates were run before the build and all passed: `bun run typecheck`,
`bun run test` (151 files, 1758 tests), `bun run lint:rust` (fmt + clippy
`-D warnings`), `bun run test:rust` (1562 + 19 + 4 passed, 15 ignored),
`bun run gate:ipc-contract` (205 renderer commands, 191 dispatched all
reachable), `bun run gate:dead-code`.

## The blocker, and what it actually was

`bun run electron:pack` could not finish here. The reported cause was that a
`--dir` pack signs nothing, so the `afterPack` gate's entitlement assertions
had nothing to read. **The first half of that is wrong and the second half is
right for a different reason**, and the difference is why the fix is what it
is.

electron-builder emits `afterPack` **before** it signs, on every path.
`app-builder-lib/out/platformPackager.js` `doPack` runs
`emitAfterPack` → `doAddElectronFuses` → `doSignAfterPack`, in that order. So
the bundle the gate inspects has never been signed — not during a `--dir`
pack and **not during `release:mac` either**. Every entitlement assertion in
that hook was reading a signature that did not exist yet.

For most of the helpers that did not matter: `build.rs` and the three
`build-native-*.mjs` scripts each run `codesign` themselves, so the Speech,
calendar, shortcut and Foundation Models helpers arrive at `afterPack`
already carrying a deliberate ad-hoc signature and their chosen entitlements.
The two that are not signed by anything are the cargo outputs. `plainsong-cli`
reaches the hook as `flags=0x20002(adhoc,linker-signed)` — the linker's own
stamp, no codesign, no entitlement blob — and
`codesign -d --entitlements` prints nothing for it, so the "empty entitlement
set" check failed on *"has no readable entitlement property list"*. A message
about the gate's assumptions, not about the build.

The fix distinguishes the three states `codesign -dv` reports and only asserts
on the one that carries information:

- exits non-zero (*code object is not signed at all*) → nothing signed it;
- `linker-signed` in the flags → the linker did, not codesign;
- anything else → someone chose these entitlements, so assert.

`verifyAppBundle` gained an `allowUnsigned` mode. The `afterPack` hook passes
it, because as established the hook is never looking at a signed bundle. The
standalone gate defaults to **off** and gained strictness in the process: an
unsigned binary in `release/mac-arm64/Plainsong.app` is now a named failure
rather than a cryptic one.

Checks that read the Mach-O rather than a signature — presence, executability,
arm64-only-ness, the calendar helper's embedded `__TEXT,__info_plist`, and the
app's own `Info.plist` usage strings — are unchanged and run in both modes.

Test: `src/__tests__/packaged-native-helper-signature-mode.test.ts`, with
verbatim `codesign -dv` output for all four states.

### Both modes were exercised against a real bundle

A `--dir` pack on **this** machine is in fact signed at the end, because
electron-builder auto-discovers the Developer ID identity in the keychain
(`executing custom sign … identityName=Developer ID Application: Jonathan
Reed (AJ9VWBRNZN)` appears in the `--dir` log). So a genuinely unsigned
bundle was produced deliberately to test the other path:

```
CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/build-electron-release.mjs pack
```

That bundle's app executable and `plainsong-cli` are both
`flags=0x20002(adhoc,linker-signed)`. Against it:

| invocation | result |
|---|---|
| `--allow-unsigned` | `pass: true`, `unsignedSkips: ["plainsong CLI"]` — every other helper still fully asserted |
| default (strict) | fails: *"plainsong CLI is not signed at …; a signed build must sign every native helper (pass --allow-unsigned to verify an unsigned --dir pack)"* |

Against the signed `release:mac` bundle the strict gate passes with
`unsignedSkips: []`.

## Credential preflight: what is missing

`bun run gate:release-credentials:preflight` exits 1, `ready: false`. Exactly
two things are false, and only one of them is a real obstacle:

```
codesigningIdentityCount: 2
hasCertificateInput:      false   <- no CSC_NAME / CSC_LINK is EXPORTED
hasNotarizationInputs:    false   <- no notarytool credentials exist at all
```

- **`hasCertificateInput: false` did not stop the build.** The preflight wants
  the identity named explicitly (`CSC_NAME`, or `CSC_LINK` +
  `CSC_KEY_PASSWORD`) so a CI build cannot silently pick a different
  certificate. electron-builder's own auto-discovery found
  `Developer ID Application: Jonathan Reed (AJ9VWBRNZN)` in the login keychain
  and signed with it. Both are correct: the preflight is stricter than
  electron-builder needs, deliberately.
- **`hasNotarizationInputs: false` is the real gate.** No
  `APPLE_KEYCHAIN_PROFILE` and no `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/
  `APPLE_TEAM_ID`. Creating either needs an Apple ID and an app-specific
  password, which only the account holder can enter. Nothing in this lane
  asked for, entered, or stored an Apple credential.

## `mac.notarize: true` does not fail the build without credentials

The brief asked whether a documented `PLAINSONG_SKIP_NOTARIZE` escape hatch
was needed. **It is not, and none was added** — the existing behaviour already
does the right thing. `MacTargetHelper.notarizeIfProvided` calls
`getNotarizeOptions`, which returns `undefined` when no Apple credentials are
in the environment, and then logs and returns:

```
• skipped macOS notarization  reason=`notarize` options were unable to be generated
```

`release:mac` exited 0 and produced the DMG. So the release path is unchanged
and `electron-builder.yml` was not touched.

**The thing to be aware of** is that this is a *warning*, not an error, and
`docs/CODE_SIGNING.md` says "An official build must stop if notarization
cannot complete." What actually enforces that is
`bun run gate:release:macos:trust`, which requires a stapled ticket and a
Gatekeeper `Notarized Developer ID` assessment and fails closed. That gate is
not in this receipt because it cannot pass without notarization — which is the
correct outcome and is why this build is a local test build and not a release
candidate.

## Gate results

Every number below was taken on a machine shared with other build lanes.
Sizes and hashes are load-independent; timings carry their load average.

| gate | result | evidence |
|---|---|---|
| `gate:size` | **PASS** | 311,358,436 bytes / **296.93 MiB**, threshold 450 MiB |
| `gate:cold-start` | **PASS** | **1,940 ms** on the recorded run, threshold 2,500 ms, load 1m ≈ 86 |
| `gate:packaged:macos:native` | **PASS** | `pass: true`, `allowUnsigned: false`, `unsignedSkips: []`; Speech helper contract `pass: true`, engine `speech_analyzer`, deployment target 13.0, arm64 |
| `gate:release:dependencies` | **FAIL** (pre-existing) | 5 advisories, see below |
| `gate:release:licenses` | **PASS** | notices sha256 `647eebd1363520e7358b63db3d1d3b40bf46f19ec55db9c3927aec724869e9ad`; LICENSE and `LICENSES.chromium.html` present |
| `qa:packaged:macos:update-metadata` | **PASS** | all 22 checks true, including `zipSha512MatchesManifest` and `blockmapExists` |

Raw outputs: `artifacts/qa/macos/local-test-build-gates-2026-09-03.json`.
`qa:packaged:macos:update-metadata` writes its own
`artifacts/qa/macos/update-metadata.{json,md}`.

### Size and cold start — the two the ledger owed

**Size: 296.93 MiB / 311,358,436 bytes.** Load-independent. This agrees with
the 297.22 MiB the shell-size lane measured on an unsigned pack of the same
tree; the ~0.3 MiB difference is the signatures and the `app-update.yml` that
only a full build writes.

**Cold start: 1,940 ms**, threshold 2,500 ms, at 1-minute load ≈ 86. Five
consecutive runs immediately before it, at load ≈ 80, were **850, 848, 727,
849 and 849 ms**.

That spread needs one honest caveat. The **first** launches of a freshly
built bundle — before the page cache held its 297 MiB — measured **3,522,
4,139, 5,477, 2,573, 3,615 and 6,318 ms** at loads of 75 to 102, i.e. the
2,500 ms gate *failed* on a genuinely cold bundle under this load. The gate's
"cold start" means a fresh process against an isolated data directory, not a
cold page cache, and the passing numbers above are the ones it is defined to
measure. But a first-ever launch on a busy machine is slower than the gate
implies, and on a quiet machine both figures would only improve. Do not quote
the 727 ms as a headline number; the honest one for this build is **under 2 s
warm, and single-digit seconds on the very first open of a busy machine**.

### `gate:release:dependencies` — what fails and why it is not this build

Five `bun audit` advisories, all in **build-time** packages, none reaching the
shipped app:

| package | severity | vulnerable | fixed in |
|---|---|---|---|
| `@xmldom/xmldom` (1158518) | moderate | `>=0.7.0 <=0.8.14` | 0.9.x |
| `fast-uri` (1158521, 1158524, 1158527, 1158530) | high ×4 | `<3.1.6` | 3.1.6 |

Both are already pinned in `package.json` `overrides` — `@xmldom/xmldom`
`^0.8.13`, `fast-uri` `^3.1.5` — against *earlier* advisories; these are new
ones published against the pinned versions. `@xmldom/xmldom` comes in through
electron-builder's `plist`, `fast-uri` through `ajv`.

Neither appears in the packaged `app.asar` (checked with
`@electron/asar list`), and the gate's own `affectedLockEntries` and
`packagedExcludedModules` counts are both `0`. So the DMG in this receipt is
not carrying either package.

Not fixed here for two reasons: this lane changes no dependencies, and the fix
(`fast-uri` → `^3.1.6`, and a decision about the `@xmldom/xmldom` 0.9 major)
requires a `bun install` and a lockfile change, which this lane is instructed
not to run. It is a one-line override bump for whoever can.

## The DMG was opened, not just produced

`electron-builder.yml` asks for this explicitly: the DMG target had never been
exercised end to end before this build.

- `hdiutil imageinfo` → **UDIF read-only compressed (lzfse)** — the configured
  `ULFO`, so the format change is real and not silently downgraded.
- Attached read-only. Contents: `Plainsong.app`, an `Applications` symlink,
  and the Finder layout metadata. Detached cleanly.
- `codesign -dv` on the app **inside the mounted image**: `com.plainsong.app`,
  `TeamIdentifier=AJ9VWBRNZN`, `flags=0x10000(runtime)`, timestamped.
- `codesign --verify --deep --strict` on it: exit 0.

One small deviation from the config's stated intent, noted rather than
changed: `electron-builder.yml` says "No background image deliberately", and
the image nonetheless contains a `.background.tiff` that electron-builder
generated on its own. Harmless — the icon layout is the one the config
specifies — but the comment and the artifact disagree.

## Smoke: it launches, the sidecar comes up, it quits

Launched from the built bundle against an isolated `PLAINSONG_DATA_DIR` /
`PLAINSONG_CONFIG_DIR` and a throwaway Electron profile, three times. **No OS
permission prompt appeared and nothing was clicked.**

| run | `[main] App rendered` | sidecar child | exit | strays after quit |
|---|---|---|---|---|
| 1 | 2,898 ms | yes (2 pids) | 0 | none |
| 2 | 1,511 ms | yes | 0 | none |
| 3 | 1,212 ms | yes (2 pids) | 0 | none |

The sidecar log shows the real thing running: `[sidecar] connected`,
`Completed audit detail startup scrub`, `Re-verifying integrity receipts for
47 local model artifact(s) at startup`, `[sidecar] ready`, and the system
audio layer finding the loopback device. Two expected warnings on a clean
data directory — the Parakeet TDT v3 weights are not downloaded, and Apple
Intelligence reports `model_not_ready` — both of which are the app correctly
describing an absent local model rather than failing.

**One thing worth a follow-up.** On the first of these three runs, the sidecar
exited about a second after `App rendered` and the app restarted it —
`[sidecar] restarting in 1000ms (attempt 1/5)` — then came up normally, logged
`[sidecar] ready`, and stayed up for the rest of the run. Nothing in the log
says why the first one exited. It did not recur on the two runs after it.

Note what this does and does not tell you. These three runs are the **only**
launches held open long enough to see it: `gate:cold-start` sends SIGTERM the
instant `App rendered` appears, which is roughly when this happens, so none of
its thirteen launches could have observed a restart either way. So "1 of 3" is
the whole sample, and the recovery path did its job. Recorded because it is
real and unexplained, not because it blocked anything.

## What is signed, what is not, and what that means for you

**Signed.** `Plainsong.app` and the DMG both carry
`Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`, team `AJ9VWBRNZN`,
hardened runtime (`flags=0x10000(runtime)`), and a secure timestamp from
Apple's timestamp server. `codesign --verify --deep --strict` reports *valid
on disk* and *satisfies its Designated Requirement*. Every embedded helper is
signed under the per-binary entitlement policy: the calendar helper holds only
`com.apple.security.personal-information.calendars`, the Speech helper only
`…speech-recognition`, and the sidecar, the `plainsong` CLI, the shortcut
helper and the Foundation Models helper hold nothing at all.

**Not notarized.** No ticket was requested and none is stapled:

```
xcrun stapler validate …/Plainsong.app
  → Plainsong.app does not have a ticket stapled to it.

spctl --assess --type execute --verbose=4 …/Plainsong.app
  → rejected
  → source=Unnotarized Developer ID
```

**What that means.**

- **On this Mac it installs and runs.** Gatekeeper only enforces on files
  carrying `com.apple.quarantine`, and a locally built DMG has no such
  attribute (checked: the image carries only `com.apple.FinderInfo` and
  `com.apple.provenance`). Mounting it and dragging the app to
  `/Applications` produces an app with no quarantine flag, which launches
  normally. The `spctl` rejection above is what Gatekeeper *would* say if it
  were asked — and for this file, on this machine, it is not asked.
- **Anywhere else it is blocked.** Send this DMG through a browser download,
  a mail attachment, AirDrop, Slack, or any other transport that sets the
  quarantine attribute, and macOS will refuse to open it. There is no
  right-click-Open workaround worth documenting for a beta tester; the answer
  is to notarize.
- **This is not a release artifact.** `bun run gate:release:macos:trust`
  fails closed on the missing ticket, which is exactly what it is for.

## To enable notarization

The only step that needs the account holder. Run it once, in a terminal, and
enter the Apple ID and an app-specific password created at
<https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
`notarytool` prompts for the password interactively; do not put it on the
command line or in a file.

```
xcrun notarytool store-credentials plainsong \
  --apple-id "<your Apple ID email>" \
  --team-id AJ9VWBRNZN
```

Confirm it authenticated:

```
xcrun notarytool history --keychain-profile plainsong
```

Then rebuild, pointing electron-builder at that profile. The whole change is
one exported variable; nothing in the repository needs editing:

```
cd nautilus-bot
export APPLE_KEYCHAIN_PROFILE=plainsong
export CSC_NAME="Jonathan Reed (AJ9VWBRNZN)"     # satisfies the preflight
bun run gate:release-credentials:preflight        # should now print ready: true
bun run release:mac
APPLE_TEAM_ID=AJ9VWBRNZN bun run gate:release:macos:trust
```

`CSC_NAME` is the identity **without** the `Developer ID Application:` prefix —
the preflight rejects the prefixed form on purpose.

Notarization adds several minutes to the build while Apple's service accepts,
scans and issues the ticket; electron-builder staples it to the app before it
builds the DMG. After that, `xcrun stapler validate` succeeds and `spctl`
reports `source=Notarized Developer ID`, and the DMG can be handed to anyone.
