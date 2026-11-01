# Code signing, notarization, and distribution

App bundle identifier: `com.plainsong.app`

Plainsong beta is an Apple Silicon macOS application packaged with
`electron-builder`. The package includes the Electron application, Rust
sidecar, native macOS shortcut helper, and Apple Speech helper.

## Current release target

The app [package version](../package.json) targets `0.9.0-beta.7`. It remains
unreleased. Its expected outputs are:

- `release/Plainsong-0.9.0-beta.7-arm64.dmg`
- `release/Plainsong-0.9.0-beta.7-arm64-mac.zip`
- `release/Plainsong-0.9.0-beta.7-arm64-mac.zip.blockmap`
- `release/beta-mac.yml`
- `release/mac-arm64/Plainsong.app`

A package trust claim requires passing gates for the exact chosen candidate.
Preserve accepted bytes. Historical signatures, notarization tickets,
Gatekeeper results and hashes do not prove another candidate.

Exact hashes, Apple submission identifiers, and QA receipts belong under
`artifacts/qa/macos/`, not in this source guide. The current beta 7 candidate has not
been published. Keep the app-specific password only in the login Keychain,
never in source, logs, shell history, or release artifacts.

## Release inputs

- Packaging config: `electron-builder.yml`
- macOS entitlements: `build-resources/entitlements.mac.plist` (main app)
- Inherited entitlements: `build-resources/entitlements.mac.inherit.plist`
  (GPU/Renderer/Plugin Electron helpers)
- Generic helper entitlements: `build-resources/entitlements.mac.helper.plist`
  (the Electron helper that hosts Chromium's utility processes, audio
  included)
- Sidecar and shortcut-helper entitlements:
  `build-resources/entitlements.mac.sidecar.plist` and
  `build-resources/entitlements.mac.shortcut-helper.plist` (both empty —
  neither binary is signed with any entitlement)
- Speech helper entitlements:
  `rust-sidecar/native/macos_speech_helper.entitlements.plist`
- Signing dispatch: `scripts/sign-macos.mjs` — the source of truth for which
  binary gets which entitlements file (see "Per-binary entitlements" below) —
  except the GPU/Renderer/Plugin helpers, which take `entitlementsInherit`
  from `electron-builder.yml`
- Rust sidecar: `rust-sidecar/target/release/plainsong-sidecar`
- Shortcut helper: `dist-native/plainsong-native-shortcut-helper`
- Output directory: `release/`

## Per-binary entitlements (Wave 1 split)

The package used to sign every Electron child process — the GPU, Renderer,
and Plugin helpers, plus the generic helper that hosts Chromium's utility
processes — with a copy of the main app's own entitlements. None of them
open a device or drive another application, so that handed three idle
processes the microphone, unscoped Apple Events, and disabled library
validation for no reason. `scripts/sign-macos.mjs` now routes each binary to
its own file:

| Binary | Entitlements file | Holds |
| --- | --- | --- |
| `Plainsong.app` (main) | `entitlements.mac.plist` | JIT, unsigned executable memory, microphone, audio input, blanket Apple Events automation, plus an (inert, unsandboxed) `temporary-exception` list naming `com.apple.systempreferences` and `com.apple.finder` |
| `Plainsong Helper (GPU).app`, `(Renderer).app`, `(Plugin).app` | `entitlements.mac.inherit.plist` | JIT, unsigned executable memory, `inherit` only — no device, no Apple Events, no disabled library validation |
| `Plainsong Helper.app` (generic — hosts Chromium's utility processes, including the audio service the Settings microphone test uses via `getUserMedia`) | `entitlements.mac.helper.plist` | the inherit set plus `device.audio-input` and `device.microphone` — nothing else |
| `sidecar/plainsong-sidecar` | `entitlements.mac.sidecar.plist` | none (empty `<dict/>`) |
| `shortcut-helper/plainsong-native-shortcut-helper` | `entitlements.mac.shortcut-helper.plist` | none (empty `<dict/>`) |
| `asr-helper/plainsong-native-asr-helper` | `entitlements.mac.asr-helper.plist` | none (empty `<dict/>`); reads 16 kHz audio from the sidecar on stdin and runs Parakeet on the Neural Engine (CPU on Macs with less than 12 GB of memory) |
| `sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin` | `rust-sidecar/native/macos_speech_helper.entitlements.plist` | `com.apple.security.personal-information.speech-recognition` only |

The generic helper is matched by shape (`/^.+ Helper(\.app)?$/`), not by the
literal product name, so a `productName` change can't silently reroute it —
and the pattern is anchored so it does not also match the GPU/Renderer/Plugin
helpers, which must keep the narrower inherit set.

**`com.apple.security.cs.disable-library-validation` was removed from the
main app's entitlements** (previously present, now gone). Library validation
is only disabled to load code signed by someone else, and nothing the main
process loads needs that — no production dependency ships a `.node` binary,
and the sidecar, Speech helper, and shortcut helper are separate signed
processes. Disabling it on the bundle that holds the microphone, Apple
Events, and (at runtime) the Accessibility grant turns a notarized Plainsong
into a loader for someone else's dylib. This change is flagged for
packaged-QA verification: if a packaged smoke test ever fails to launch
because of it, the fix is to find and sign the unsigned library, not to
restore the entitlement (see the comment block in
`build-resources/entitlements.mac.plist` and the `REVERTABLE`-tagged commit
that made this change).

The release environment must provide:

- `CSC_LINK` plus `CSC_KEY_PASSWORD`, or `CSC_NAME`
- `APPLE_KEYCHAIN_PROFILE`, or all of:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`

The GitHub Actions workflow maps those values from:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`APPLE_KEYCHAIN_PROFILE` is intended for local release builds whose
`notarytool` credentials are already stored in the login Keychain. GitHub
Actions uses the explicit secret variables because hosted runners do not share
the local Keychain. Never add certificate files, passwords, tokens, or
generated credential reports containing secret values to source control.

## Credential preflight

Run the fail-closed credential check before an official build:

```bash
bun run gate:release-credentials:preflight
```

It writes:

- `artifacts/release-credential-preflight.json`
- `artifacts/release-credential-preflight.md`

Those reports contain only boolean presence checks, signing identity counts,
a boolean result for the selected Developer ID identity, and a boolean result
from authenticating the selected Keychain profile. Identity names, profile
names, and secrets are never written to the reports. The command exits nonzero
when the selected identity cannot sign, the complete notarization credential
set is unavailable, or a named Keychain profile cannot authenticate.

## Build without publishing

```bash
bun install --frozen-lockfile
bun run release:mac
```

`release:mac` compiles the app and runs `scripts/release-mac.mjs`. Use a fresh
output directory outside iCloud. On the shared qualification host, set
`PLAINSONG_BUILD_SLOT` to the existing machine-wide build-slot script:

```bash
CSC_NAME="Jonathan Reed (AJ9VWBRNZN)" \
APPLE_KEYCHAIN_PROFILE=plainsong-notary APPLE_TEAM_ID=AJ9VWBRNZN \
PLAINSONG_BUILD_SLOT=/Users/jonathanreed/Documents/Plainsong/nautilus-bot/artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/build-slot.sh \
PLAINSONG_RELEASE_DIR="$HOME/Library/Caches/Plainsong-release/candidate-next" \
bun run release:mac
```

The runner acquires the configured slot only for `release:mac:compile`, with
nice 10 and four Cargo jobs. It releases the slot before packaging, uploads,
Apple processing, stapling and trust checks. Do not wrap `release:mac` itself
in `build-slot.sh`. Resume skips compilation.

The runner publishes nothing. It performs these steps:

1. Compile and Developer ID sign the arm64 app and helpers with hardened
   runtime. Disable electron-builder's app notarization. Record the app cdhash
   and flow version in `notary/candidate.json`.
2. Archive the signed app with `ditto -c -k --keepParent`. Keep this upload-only
   archive under `notary/Plainsong-notarization.zip`. Submit it and require
   Apple's acceptance log to match its SHA-256 and app cdhash. Staple the app,
   then validate its ticket, strict signature and Gatekeeper assessment.
3. Build and sign the DMG with `--prepackaged` from that stapled app. Submit
   the DMG and require its acceptance log to match the uploaded SHA-256 and
   both app and DMG cdhashes. Staple and verify the DMG.
4. Mount the DMG read-only under the system temporary directory. Validate the
   embedded app's staple, signature, Gatekeeper assessment and cdhash, then
   detach. Never recursively remove a mount after a failed detach.
5. Build the update ZIP, blockmap and `beta-mac.yml` from the stapled app with
   electron-builder's `--prepackaged` path. Check the ZIP's SHA-512 against the
   manifest. Extract it under the system temporary directory and verify its
   app's staple, signature, Gatekeeper assessment and cdhash.
6. Require the unmodified `gate:release:macos:trust` to pass, including byte
   identity of the standalone, mounted and extracted apps. Save its JSON and
   Markdown under `notary/`. Only then write `SHA256SUMS` and
   `notary/complete.json`.

App and DMG submissions have separate journals under `notary/app/` and
`notary/dmg/`. Each records the original upload SHA-256, cdhashes, attempts and
selected submission. Commands write receipts under `notary/` with stage
prefixes. Each stage defaults to twelve attempts, 600 seconds apart, controlled
by `UPLOAD_TRIES` and `UPLOAD_SLEEP`. Both use
`--no-s3-acceleration --no-progress` without `submit --wait`.

Only exit zero with a valid ID counts as a clean upload. Before each upload,
the journal saves the known history IDs and start time. Resume recovers missing
IDs by filename, time and exclusion of those IDs. Ambiguous recovery stops with
the matching IDs recorded. A failed upload still In Progress is never waited
on. A terminal Apple result can prove remote completion after a submit crash.
Clean uploads use a bounded wait, default `NOTARY_WAIT_TIMEOUT=3h`. Retry limits
persist across resumes separately for each stage.

Preserve a failed candidate and resume it:

```bash
APPLE_KEYCHAIN_PROFILE=plainsong-notary APPLE_TEAM_ID=AJ9VWBRNZN \
bun scripts/release-mac.mjs --resume "$HOME/Library/Caches/Plainsong-release/candidate-next"
```

Resume reuses each selected submission and refuses changed signatures. A
per-directory lock prevents concurrent runs. After a process is killed,
inspect its receipts and confirm it has stopped before removing only its
`.release-lock` directory. Do not rebuild submitted bytes. Old single-submission
candidates, including b22, require a fresh output directory for this flow.

Apple's [custom workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
documents nested tickets, separate stapling and rebuilding distribution ZIPs
from stapled items. Its [packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
recommends notarizing the outermost container for nested distributions. That
permits a single DMG submission, but does not staple the app already inside an
immutable DMG. Stapling the standalone app afterward leaves that payload
unchanged. Rebuilding and signing the DMG afterward creates a new container
identity which needs its own ticket. The two submissions implement this
repository's stronger requirement that every shipped app copy carries a staple.
See Apple's [explanation of ticket hashes](https://developer.apple.com/documentation/technotes/tn3126-inside-code-signing-hashes).

The fake-tool tests prove orchestration and recovery behavior. They do not
prove Apple acceptance or Gatekeeper behavior for a future candidate.

### Encrypted startup migration proof

`rust-sidecar/src/startup_migration_tests.rs` calls the real
`open_database_with_vault_key_recovery` startup function in fresh child test
processes. Each receives an isolated data directory and a test key directly.
It never creates or reads a keychain item. The test checks encrypted snapshots
before migration DDL, preservation across restart, two-copy retention and
preservation after a migration failure. It verifies unreadability without the
key, keyed integrity and original contents. Its entire module is gated by
`cfg(all(test, feature = "sqlcipher"))`; a source test checks that gate. No
production QA key override is added.

This is sidecar integration evidence, not a packaged updater journey. The
plaintext b22 journey does not prove an encrypted-vault update.

## Verify the package

Run the repository gates:

```bash
bun run qa:packaged:macos:update-metadata
APPLE_TEAM_ID="<team-id>" bun run gate:release:macos:trust
bun run gate:size
```

The trust gate verifies:

- the app, sidecar, shortcut helper, and Apple Speech helper are present and executable
- all four signatures are valid Developer ID signatures
- hardened runtime and secure timestamps are present
- all embedded executables use the expected Apple team
- the sidecar and shortcut helper carry none of their forbidden entitlements
  (including Speech Recognition and, for the sidecar, disabled library
  validation)
- the main app has library validation enabled (not disabled)
- the GPU, Renderer, and Plugin Electron helpers hold no device or Apple
  Events entitlement, and the generic Electron helper holds no Apple Events
  entitlement or disabled library validation (audio is expected there)
- only the Apple Speech helper receives the Speech Recognition entitlement
- all shipped executables are arm64
- the DMG itself — not just the `.app` inside it — is signed, has a stapled
  notarization ticket, and is accepted by Gatekeeper
- the ZIP's extracted `.app` passes every one of the checks above independently
- a notarization ticket is stapled on the app bundle
- Gatekeeper accepts the app as `Notarized Developer ID`

Any one of these failing fails the gate closed (`status: "FAIL"`); there is no
partial-pass state.

Useful direct checks are:

```bash
codesign --verify --deep --strict --verbose=2 \
  "release/mac-arm64/Plainsong.app"
xcrun stapler validate "release/mac-arm64/Plainsong.app"
spctl --assess --type execute --verbose=4 \
  "release/mac-arm64/Plainsong.app"
```

For a launchable build, stapler must validate successfully and `spctl` must
report `accepted` with `source=Notarized Developer ID`.

Dictation latency is not covered by the trust/size gates above and needs its
own measurement per candidate: run `bun run sidecar:build:release` then `bun
run benchmark:latency -- --provider whisper --model base.en --runs 10`,
followed by `bun run gate:dictation-latency` and `bun run
gate:dictation-latency:e2e`. This writes `artifacts/qa/dictation-latency.json`
(ASR decode only) and `artifacts/qa/dictation-latency-e2e.json` (`metricScope:
"asr_and_local_format_only"` -- ASR plus the local formatting pipeline plus a
mocked insertion stage; see the receipt's own `insertionStrategyNote` and
`formatOnScopeNote` for exactly what that scope does and doesn't cover). Both
receipts are gitignored by design (`artifacts/` is never committed) and must
stay that way — attach them to the release evidence bundle by hand alongside
the other `artifacts/qa/` receipts referenced above, the same way a stale or
missing receipt is a launch blocker.

## Embedded executable scope

The packaged application contains three important native executables under
`Contents/Resources`:

```text
sidecar/plainsong-sidecar
sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin
shortcut-helper/plainsong-native-shortcut-helper
```

All three must use the same Developer ID identity and Apple team as the main
application. The release trust gate checks them independently, in addition to
the deep application signature. The Speech helper alone receives the Speech
Recognition entitlement.

The bundle also contains four Electron child-process helpers under
`Contents/Frameworks`, each its own signed `.app`:

```text
Plainsong Helper.app                  (generic — hosts Chromium's audio service)
Plainsong Helper (GPU).app
Plainsong Helper (Renderer).app
Plainsong Helper (Plugin).app
```

The trust gate does not run the Apple-team-match check against these four the
way it does for the sidecar, shortcut helper, and Speech helper, but it does
verify each one is present and carries only the entitlements described in
"Per-binary entitlements" above — the GPU/Renderer/Plugin three hold no
device or automation authority, and the generic one holds nothing beyond
audio.

## Official publication paths

Jonathan approved the local release path on October 30, 2026. Build, notarize
and verify with `scripts/release-mac.mjs`, then upload those exact bytes after
the candidate passes qualification and publication is authorized. GitHub
Actions remains an alternative that produces its own candidate. Do not combine
their outputs or replace qualified bytes with a rebuild.

### Local candidate

1. Build with `bun run release:mac`, which runs `scripts/release-mac.mjs`, using
   the fresh output directory and signing inputs described above. It uploads
   only notarization submissions to Apple. It does not publish to GitHub or
   the update feed.
2. Preserve the resulting app, DMG, update ZIP, blockmap, `beta-mac.yml`,
   `SHA256SUMS` and `notary/` receipts. Complete product qualification against
   those exact bytes. Keep all machine-readable receipts in one QA directory.
   The audit expects `macos-trust.json` and `update-metadata.json` there, along
   with its required qualification receipts.
3. Run the pre-publication audit:

   ```bash
   bun run qa:packaged:macos:release-audit:pre -- \
     --candidate /absolute/path/to/candidate --qa-dir /absolute/path/to/qa
   ```

   `release-pre-audit.json` must report `PASS` and `publicationReady: true`.
   It checks local candidate identity, signing, notarization, update metadata,
   licenses, size and qualification receipts. It makes no production requests
   and does not require the unpublished candidate to be on the public feed.
4. After Jonathan authorizes publication, upload that candidate's unchanged
   DMG, ZIP, blockmap, `beta-mac.yml` and `SHA256SUMS` to its GitHub release.
   The update Worker proxies the published release assets. With the current
   GitHub-backed feed, there is no separate asset upload to Cloudflare.
   Recheck `SHA256SUMS` before and after transferring the bytes. Never rebuild
   or overwrite published assets to repair a failed rollout.
5. Capture `public-update-feed.json` for that candidate, publish site metadata
   from the same assets, then run the post-publication audit:

   ```bash
   bun run qa:packaged:macos:public-update-feed -- \
     --candidate /absolute/path/to/candidate \
     --feed-url https://updates.plainsong.jonathanrreed.com/beta/ \
     --out /absolute/path/to/qa/public-update-feed.json \
     --markdown /absolute/path/to/qa/public-update-feed.md
   bun run qa:packaged:macos:release-audit:post -- \
     --candidate /absolute/path/to/candidate --qa-dir /absolute/path/to/qa
   ```

   Post requires the exact-candidate pre PASS, the public feed receipt,
   public DMG and ZIP hashes and sizes, and matching download-page and
   `llms.txt` metadata. Its public requests use unauthenticated GETs.
   `release-post-audit.json` must report `PASS` before rollout is complete.
   A pre PASS alone does not establish public availability.

### GitHub Actions alternative

`.github/workflows/release.yml` stages an artifact-only draft release. It:

1. verifies the tag matches `package.json`
2. runs source tests and contract gates
3. requires the full signing and notarization credential set
4. builds with direct publication disabled
5. verifies updater metadata, signatures, stapling, Gatekeeper, TCC strings,
   size, packaged licenses, cold start, and release assets
6. creates or refreshes a draft GitHub release after its automated gates pass

Configure the workflow's signing secrets and `release` environment before
using it. A rerun may replace draft assets. It refuses to modify a published
release. Qualify the bytes it builds, then run the same pre-publication audit
before publishing the draft. The workflow does not prove real-hardware
product acceptance, clean installation, updater journeys or soak behavior.
Run the post-publication checks after publishing. This documentation changes
no workflow behavior.

## Operational notes

Hard-won since the last `0.9.0-beta.2` build attempt — read this before
building or distributing anything.

- **`bun run release:mac` is the only sanctioned path to a distributable
  DMG.** `scripts/build-dmg.ts` is a separate, ad-hoc local tool for testing
  the install gesture on one machine; it does not notarize, does not staple,
  and does not apply the DMG layout above, and no gate in this repository
  inspects its output. The `0.9.0-beta.2` DMG shipped unnotarized because
  this script was run instead of `bun run release:mac`. The script now
  prints an unmissable warning to that effect before and after every local
  build, but the fix is procedural: never distribute anything
  `build-dmg.ts` produced.
- **Run `bun run gate:release:macos:trust` before any distribution, not just
  before publishing.** It now fails closed on an unnotarized or unstapled
  DMG or ZIP (not only the `.app` bundle) and on any forbidden entitlement on
  any embedded binary — see "Per-binary entitlements" and "Verify the
  package" above. A green run of this gate is a precondition for handing an
  artifact to anyone, including a single invited tester.
- The public feed gate follows `release-channel-policy.json`. While
  `stableReleaseExists` is `false`, `/stable/latest-mac.yml` must return 404
  at its exact URL. The receipt records
  `expected-absent-before-first-stable-release`. Any other response blocks
  the gate, including a 200 serving a beta build. When publishing the first
  stable release, change that value to `true` in reviewed source. Stable must
  then return a valid stable manifest. Beta must always return a valid
  manifest and the checked beta feed must match the exact candidate.
- **Notarization needs `APPLE_KEYCHAIN_PROFILE`, or all of `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.** Run
  `bun run gate:release-credentials:preflight` first; see "Credential
  preflight" above and `scripts/release-credentials-preflight.ts`.
  On this Mac the keychain profile is `plainsong-notary`, with
  `CSC_NAME="Jonathan Reed (AJ9VWBRNZN)"` and `APPLE_TEAM_ID=AJ9VWBRNZN`.
- **Package outside an iCloud-synced folder.** With Desktop & Documents in
  iCloud, File Provider can add `com.apple.FinderInfo` and break signatures.
  Set `PLAINSONG_RELEASE_DIR` to a fresh directory under `~/Library/Caches`.
  Use the release runner for the whole sequence, including resumptions.
- **`updates.plainsong.jonathanrreed.com` currently has no DNS record.**
  Verified directly (`host updates.plainsong.jonathanrreed.com`) on
  2026-08-27: NXDOMAIN. `electron-builder.yml`'s `publish.url` and
  `electron/updater-channel.ts`'s `UPDATE_FEED_BASE_URL` both point at this
  host, so no packaged build's auto-updater can reach a live feed until the
  host resolves and serves both channel manifests. This is the same external
  gate `LAUNCH.md` and
  `nautilus-bot/docs/beta/EXTERNAL-UPDATE-FEED-GATE.md` describe; it has not
  been provisioned since that record was written.

## Windows

Windows is not a beta release target. Do not add a Windows leg to the official
workflow until the sidecar, packaging, signing, and platform QA have their own
complete release path.
