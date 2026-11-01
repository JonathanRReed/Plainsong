# Plainsong limited beta launch checklist

Source target: `0.9.0-beta.7`

Last reconciled: October 30, 2026

## Beta.7 evidence boundary

Electron is the chosen shell. Dictation and meetings are the product's two
pillars. Source checks, recorded-audio evaluations, packaged interaction and
public distribution need separate evidence. The
[beta.7 evidence index](nautilus-bot/docs/evals/beta7-evidence.md) records the
measurements used in the release notes and their limits.

The `models-2026-10` assets are published as a prerelease, per the maintainer's
October 22 verification. This does not establish publication or qualification
of the beta.7 app. No fresh model-release check was made in this reconciliation.

Use either the local candidate path or the
[release workflow](.github/workflows/release.yml). The
[signing guide](nautilus-bot/docs/CODE_SIGNING.md#official-publication-paths)
describes both official paths. Signing, notarization, clean installation, capture,
insertion and updater receipts must cover the delivered bytes. Publication
and replacing an installed app require the task's authorization.

## Publication and rollout gates

Jonathan approved the local release path on October 30, 2026. Build, notarize
and verify with `bun run release:mac`, which runs
`nautilus-bot/scripts/release-mac.mjs`. Keep those exact bytes for upload and
finish qualification before requesting publication approval. Actions is an
alternative that builds its own candidate, which needs its own qualification.

From `nautilus-bot/`, run:

```bash
bun run qa:packaged:macos:release-audit:pre -- \
  --candidate /absolute/path/to/candidate --qa-dir /absolute/path/to/qa
```

Pre checks candidate identity and bytes, Developer ID trust, notarization,
update metadata, packaged licenses, the 450 MiB size limit and required
qualification receipts. It does not require the candidate to be published.
`release-pre-audit.json` must report `PASS` and `publicationReady: true`.
Missing, stale or failed qualification evidence blocks publication.

The [candidate receipt checklist](nautilus-bot/scripts/qa/README.md) maps all 24
requirements to producers and lists b27 qualification commands. Beta.7 has five
recorded decisions by Jonathan in
[release-scope-exceptions.json](nautilus-bot/release-scope-exceptions.json).
The October 30 decisions exclude the beta.5 updater journey and the audible
benchmark. The updater reports `excluded by decision`; the benchmark appears
outside the 24 audit rows in the decision list.

The October 31 decisions exclude only these parts:

- `memory-footprint`, 8 GB tier, `idle-after-dictation`: "Accept 8 GB window-open idle after dictation for beta.7; fix in beta.8". Reason: "Average is at the 300 MiB limit with the speech model kept warm and the main window open; brief graphics peaks to 534 MiB; window closed is about 200 MiB."
- `host-matrix`, Google Docs in Chrome: "Skip Google Docs typing for beta.7". Reason: "Chrome has no QA connection on this Mac; Notes, Slack and Messages pass."
- `clean-install`, clean-account permission and first dictation/insertion journey: "Skip fresh-account install journey for beta.7". Reason: "Needs a new macOS user account; quarantined DMG install, signatures and Gatekeeper pass."

Partial exclusions report `proved with scoped exclusion`, counted separately
from clean proofs, only if the remaining checks pass. Other memory states and
effective-memory verdicts, receipt validity, candidate binding, required hosts,
quarantined install, bundle match, signatures and Gatekeeper still apply.
The 16 GB footprint gate has no exclusion. These decisions do not qualify
physical 8 GB hardware or packaged encrypted migration. Other missing or
failed gates still block.

After Jonathan authorizes publication, upload those unchanged assets to the
GitHub release. The update Worker serves that release through the feed.
Capture the feed receipt and update the site's metadata from those assets:

```bash
bun run qa:packaged:macos:public-update-feed -- \
  --candidate /absolute/path/to/candidate \
  --feed-url https://updates.plainsong.jonathanrreed.com/beta/ \
  --out /absolute/path/to/qa/public-update-feed.json \
  --markdown /absolute/path/to/qa/public-update-feed.md
bun run qa:packaged:macos:release-audit:post -- \
  --candidate /absolute/path/to/candidate --qa-dir /absolute/path/to/qa
```

Post requires the exact-candidate pre PASS, the public feed serving that
candidate, public DMG and ZIP downloads matching hashes and sizes, and the
public download page and `llms.txt` matching the release. Public requests are
unauthenticated GETs. `release-post-audit.json` must report `PASS` and
`launchDone: true` before rollout is complete. A pre PASS does not close rollout.
The unsuffixed `qa:packaged:macos:release-audit` defaults to pre. Explicit
`--phase pre|post` selects a phase; each writes separate default receipts.

The feed gate uses `nautilus-bot/release-channel-policy.json`. With
`stableReleaseExists: false`, the exact stable manifest URL must return 404,
recorded as `expected-absent-before-first-stable-release`. Beta must remain
valid and match the candidate. A stable 200, beta build in stable, redirect,
or unexpected error blocks the gate. Change the value to `true` in reviewed
source when the first stable release is published. Stable must then return a
valid stable manifest. Never create a fake stable manifest to pass a beta gate.

Everything below is a historical candidate record. Its package names, test
counts, repository visibility and hosting status do not describe beta.7.
The phase rules above replace the historical aggregate-audit ordering.

## Two-submission macOS release flow

`bun run release:mac` compiles and signs the app, submits its ZIP, then staples
and verifies the app. It builds and signs the DMG from that stapled app,
submits and staples the DMG, and verifies its mounted payload read-only under
the system temporary directory. It builds the updater ZIP, blockmap and
`beta-mac.yml` from the stapled app and verifies the extracted copy. The full
trust policy must pass before `SHA256SUMS` and the completion receipt are
written. Attach `SHA256SUMS` to the release and include download checksums in
release notes.

Set `PLAINSONG_BUILD_SLOT` to the shared host's existing guard. The runner holds
the slot only for compilation, with nice 10 and four Cargo jobs. Apple uploads
and waits hold no build slot. Do not wrap the whole release command in the
guard.

Use a fresh `PLAINSONG_RELEASE_DIR` outside iCloud. App and DMG uploads have
separate retry journals. Resume with
`bun scripts/release-mac.mjs --resume <candidate-directory>`. It reuses selected
submissions, recovers IDs and never waits on cut-off uploads still In Progress.
Old single-submission candidates require a fresh candidate directory. Preserve
b22's evidence rather than rebuilding its submitted bytes.

The encrypted-snapshot integration test runs real sidecar startup across
isolated child processes with a test key. It checks encryption, ordering,
two-copy retention and migration-failure preservation. No production key
mechanism is added. This does not qualify a packaged encrypted updater journey.
See [CODE_SIGNING.md](nautilus-bot/docs/CODE_SIGNING.md) for commands and limits.

## Historical beta 4 boundary

- Source, release, binaries, and update feed went public on September 5, 2026
  at the maintainer's direction (repository public, release `v0.9.0-beta.4`
  public, `updates.plainsong.jonathanrreed.com` served by
  `infra/updates-worker`). The unreleased Reaper integration stays private.
  The acceptance gates below are unchanged by this: they are still owed
  before a 1.0.
- Apple Silicon macOS only. Intel and Windows are not release targets for this
  beta.
- Local processing is the default. Cloud transcription is an explicit BYOK
  choice, with the provider and data boundary shown before use.
- The 75 inherited pull requests were reviewed individually: 73 merged and two
  closed as superseded. New beta 4 integration pull requests are reviewed and
  must also be resolved before release.
- Source audit is green for known JavaScript and Rust vulnerabilities. The one
  remaining Rust audit warning is the unmaintained transitive `paste` crate in
  the local Candle stack; there is no bounded direct replacement in this beta.
- Half-Bounce is an optional ambition, not a beta release requirement. The
  maintainer accepted fast, usable launch as the objective on September 4.
  The notarized beta 4 sample presented at 3,015 ms and was interactive at
  4,065 ms on a heavily loaded Mac. This is not a quiet-machine benchmark.
- Release `v0.9.0-beta.4` points to `5c0ca098`. Source gates, signing,
  notarization, stapling, Gatekeeper, DMG copy and first-run setup,
  hold and toggle dictation, Apple Notes insertion, meeting capture,
  local analysis, backup, retention, and exports have evidence. Update
  metadata passes; an installed-version updater journey is still unqualified.
- The [final pass](nautilus-bot/docs/beta4-final-pass.md) records the tested
  paths and remaining limits for the maintainer's private week of testing.
  Hands-free did not activate in two speaker-fixture runs. Broad competitor
  superiority and long-meeting qualification are not established.

## Historical beta 2 evidence, not valid for beta 4

The remaining sections preserve the August 23, 2026 beta.2 checklist and
receipts. They do not prove beta.4, beta.7 or any later candidate. Re-run the
source and exact-package gates for the candidate being delivered.

## Historical beta 2 verdict

The integrated `0.9.0-beta.2` source baseline passes IPC, dead-code, TypeScript,
Vitest (868 tests), renderer and Electron builds, Rust formatting, Clippy, and
Rust library and binary tests. QA receipt wiring, latency gate separation,
release-workflow gates, version contracts, Meeting lifecycle recovery, capture
admission, and Electron 43 module resolution have been repaired. Dependency
updates from all three Dependabot branches have been reconciled.

A local `0.9.0-beta.2` package has been built and verified: native helpers,
licenses, third-party notices, Electron fuses, Developer ID code signatures,
hardened runtime, secure timestamps, arm64 architecture, zip extraction, size
gate (374 MB / 450 MB), and cold-start gate (2428 ms / 2500 ms) all pass.

No `0.9.0-beta.2` artifact has been notarized, stapled, or distributed. Apple
notarization, Gatekeeper acceptance, DMG build, clean-install, real-device
Dictation matrix, Meeting lifecycle soak, and updater journey evidence is
required before any release decision. Historical `1.0.0` and `0.9.0-beta.1`
artifacts, hashes, signatures, and QA receipts do not prove the current build.

The app is configured to use the credential-free generic feed at
`https://updates.plainsong.jonathanrreed.com/beta/`. That host still has no
DNS record — confirmed directly (`host updates.plainsong.jonathanrreed.com`)
on 2026-08-27, NXDOMAIN, same as when
`nautilus-bot/docs/beta/EXTERNAL-UPDATE-FEED-GATE.md` recorded it unprovisioned
on 2026-08-09. It has not moved. Separately, the update-feed gate now also
requires a `/stable/latest-mac.yml` manifest, not only `/beta/beta-mac.yml`
(see `nautilus-bot/docs/CODE_SIGNING.md`'s "Operational notes"), so the first
stable release depends on the same unprovisioned host plus one more published
manifest. GitHub Actions runner availability was also previously blocked by
account state and must be refreshed independently. Neither external gate can
be waived by local source results.

No beta artifact has been distributed, tagged, pushed, published, or sent to
testers from this work. Those external actions still require explicit approval.

## Supported beta shape

- macOS 13 or later on Apple Silicon, arm64 only.
- Dictation is the default landing surface and fastest local path.
- Meetings supports microphone capture, optional system audio, transcript,
  notes, action items, follow-up, export, retention, deletion, and recovery.
- Local transcription and analysis are the default. Remote processing requires
  an explicit opt-in and the user's own provider credentials.
- There is no account, telemetry, subscription, or Plainsong cloud relay.
- The beta is invite-limited, but the artifact and update feed must still be
  safe if an invite link is copied.

## Source-ready gate

Every command must pass on the candidate revision:

```bash
cd nautilus-bot
bun install --frozen-lockfile
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
git diff --check
```

Source-ready does not mean beta-ready.

## Exact packaged candidate gate

The following evidence must refer to the same app digest and package version:

- `Plainsong-0.9.0-beta.2-arm64.dmg`
- `Plainsong-0.9.0-beta.2-arm64-mac.zip`
- matching ZIP blockmap
- `beta-mac.yml`
- `SHA256SUMS`, covering the DMG, ZIP, blockmap, and beta manifest
- Developer ID signature and timestamp for the app and every native helper
- hardened runtime, least-privilege entitlements, and Electron fuse checks
- Apple notarization acceptance and stapled tickets for the app and DMG
- Gatekeeper acceptance for the quarantined distribution artifact
- package-size and cold-start gates
- generated third-party notices present in the package

Required packaged commands:

```bash
bun run licenses:generate
bun run release:mac
bun run gate:release:dependencies
bun run gate:packaged:macos:native
bun run qa:packaged:macos:update-metadata
bun run gate:size
bun run gate:cold-start
bun run qa:packaged:macos:footprint -- --simulate-gb 8
bun run qa:packaged:macos:footprint -- --simulate-gb 16
bun run gate:release:licenses
bun run gate:release:macos:trust
```

The footprint gate launches the candidate in a throwaway QA profile, tells it
to plan for an 8 GB or 16 GB Mac, and sums the `phys_footprint` of every app
process (main, renderers, GPU and utility helpers, the sidecar and native
helpers) once a second through idle (window open and closed to the menu bar),
dictation, a two-minute Me + Them meeting and the work after the call. A state
over the `rust-sidecar/src/hardware_tier.rs` budget for that Mac fails. It
needs a virtual input such as BlackHole for its spoken fixtures; nothing is
played aloud and the QA profile keeps all processing on the Mac. The release
audit requires `artifacts/qa/macos/footprint-8gb.json` and
`artifacts/qa/macos/footprint-16gb.json` for the exact candidate.

## Product acceptance gate

The exact candidate must pass all of these on real hardware:

- clean install from a quarantined DMG without a Gatekeeper bypass
- onboarding loaded before the workspace shell
- skip enters visibly limited mode, not false readiness
- first local Dictation, global hotkey, insertion, copy fallback, and recovery
- latency receipt at or below the committed threshold on the release fixture
- meeting microphone capture and persisted transcript
- system-audio known-tone verification and Me + Them capture
- Stop, duplicate Stop, Cancel, source interruption, quit, relaunch, and sidecar
  recovery with one stable recording identity
- meeting notes, summary, action items, follow-up, export, retention, deletion
- light theme, dark theme, keyboard navigation, screen-reader labels, visible
  focus, contrast, loading, empty, disabled, error, and reduced-motion states
- support bundle preview and redaction checks

Measured latency is a model- and hardware-dependent runtime gate, not a
clean-checkout source gate:

```bash
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
bun run gate:dictation-latency
```

The historical aggregate command now defaults to the pre-publication phase:

```bash
bun run qa:packaged:macos:release-audit
```

Pre must report `PASS` before publication. Post must report `PASS` after
publication. See the current phase commands above. Missing evidence blocks
the selected phase.

## Beta update gate

- `0.9.0-beta.2` requests `beta-mac.yml`.
- The installed updater contains no repository token or other feed credential.
- The manifest, ZIP, blockmap, and checksum set are mutually consistent.
- Update policy accepts only a strictly newer semantic version.
- A signed and notarized `0.9.0-beta.1` installation updates to a separately
  signed and notarized `0.9.0-beta.2` candidate.
- Relaunch preserves settings, Dictation history, Meetings, and onboarding
  state.
- The feed is reachable by an unauthenticated installed beta.

Verify the live feed and prove that the installed package names the same origin:

```bash
bun run qa:packaged:macos:public-update-feed -- \
  --feed-url https://updates.plainsong.jonathanrreed.com/beta/
```

At the beta.2 snapshot, the repository was private. A private GitHub release API is
not a client-reachable feed. Before inviting testers, either the release feed
must be public or the verified beta assets must be placed on another public,
credential-free update host. The integrated candidate is configured for the
dedicated generic feed above; its package and live feed still require fresh
verification. This is an external distribution gate, not something source
tests can waive.

The existing Cloudflare Pages site cannot host the candidate update ZIP because
the ZIP exceeds Pages' per-file limit. The recommendation at that snapshot was a public
R2 Standard bucket on a dedicated custom domain such as
`updates.plainsong.jonathanrreed.com`. Creating the bucket, enabling public
access, connecting DNS, and uploading the release are production changes and
require explicit approval. See
`nautilus-bot/docs/beta/EXTERNAL-UPDATE-FEED-GATE.md` for the current evidence
and handoff.

## Invite kit gate

The tester package must include:

- welcome and supported-hardware note
- privacy and cloud-processing disclosure
- Dictation and Meetings test missions
- support-bundle instructions
- uninstall and rollback instructions
- issue template with app version and candidate checksum
- known limitations and a direct support route

## Distribution sequence

These steps require separate user authorization:

1. Review the exact candidate receipt and checksums.
2. Confirm the beta feed is publicly reachable without credentials.
3. Create and push tag `v0.9.0-beta.2`.
4. Let the release workflow create or refresh an artifact-only draft release.
5. Review the aggregate release audit, draft, release notes, assets, and invite
   kit. A green artifact workflow is not a beta-ready verdict.
6. Publish the approved feed and release.
7. Send invitations to the limited tester group.
8. Verify the invite link and updater from a non-owner, unauthenticated Mac.

The artifact-staging workflow refuses to alter a published release and does not
run the real-hardware, clean-install, updater-journey, or three-hour soak gates.
No automation in this repository is authorized to publish, send invitations,
change repository visibility, or modify production hosting without explicit
user approval.

## Honest beta claims

Allowed only after the exact-candidate gate passes:

- local-first by default
- Dictation and Meetings supported in the beta
- measured Dictation latency using the named hardware, model, fixture, and run
  count from the candidate receipt
- macOS 13 or later, Apple Silicon only

Do not claim Whisperflow or Raycast speed parity without a controlled,
same-hardware comparison. Do not claim Granola feature parity. Do not call the
beta launched until invited testers can install the tested artifact and receive
the tested update feed.

## October 30 release decisions

- Keep the two existing speech fixtures and internal documentation public as
  they are. This records Jonathan's disposition, not new provenance evidence.
- Defer `main` branch protection until after launch. It is not a publication
  gate. Still review the PR and pass its source CI before merging.
- Publish the integration tree through one squash commit on `main`. Create a
  release branch from fresh `origin/main`, squash the reviewed integration tree
  onto it locally, then push that branch and open the PR. Do not push the local
  integration branch's ancestor QA history. Squash-merge the PR and build from
  the resulting main SHA. Review the PR's final tree before the first push.
