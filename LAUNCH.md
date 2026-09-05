# Plainsong limited beta launch checklist

Release target: `0.9.0-beta.4`

Last reconciled: September 4, 2026

This checklist is the release boundary for the private integration candidate.
Dictation and Meetings are both supported product pillars. Source readiness,
packaged candidate readiness, and distribution are separate states.

## Beta 4 current boundary

- Private source only. The repository, release, binaries, update feed, and the
  unreleased Reaper integration stay private.
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
- A Developer ID signed diagnostic build recorded first UI at 890 ms and an
  interactive workspace or wizard at 1,237 ms under high load. It was not
  notarized or stapled, so it is not release evidence and does not yet qualify
  for the Half-Bounce Club.
- The exact beta 4 candidate must pass source gates, Developer ID signing,
  notarization, stapling, Gatekeeper assessment, clean installation, dictation
  and meeting smoke tests, updater validation, and a fresh launch receipt.

## Historical beta 2 evidence, not valid for beta 4

The sections below preserve the beta 2 record so its measurements remain
auditable. They must not be read as evidence for beta 4.

Everything under "Historical beta 2 verdict" and "Exact packaged candidate gate" below
describes the source and package as they stood on **August 23, 2026**. Two
further audited fix waves have merged into `main` since then — Electron
security hardening, meeting data-integrity fixes, model currency, sidecar
robustness, and a renderer UX pass on Dictation and Meetings recovery. See
`nautilus-bot/CHANGELOG.md`'s `[Unreleased] - 0.9.0-beta.3` section for the
full, evidence-checked list. `package.json` has not been bumped and no
`0.9.0-beta.3` package has been built, so this document still tracks
`0.9.0-beta.2` — but its qualification claims are **stale, not current**:

- **Stale: the "868 Vitest tests ... pass" claim and every other source-ready
  line below.** They describe the `0.9.0-beta.2` revision's source tree, not
  current `HEAD`. The two merged waves added new source files, new tests, and
  changed entitlements, packaging config, and default models. The
  source-ready gate must be rerun top to bottom on current `HEAD` before any
  of those lines can be asserted again.
- **Stale: every number in "Exact packaged candidate gate" and the size/
  cold-start figures in "Historical beta 2 verdict."** The size gate (374 MB), the
  cold-start gate (2428 ms), and the native-helper, signature, and
  entitlement checks were all measured against a binary that no longer
  matches current source — the entitlements files changed shape (see
  `nautilus-bot/docs/CODE_SIGNING.md`'s "Per-binary entitlements" section),
  `CFBundleVersion` changed from a string to a numeric build version, and the
  DMG layout changed. None of these numbers can be assumed to still hold;
  they must be re-measured against a freshly built package.
- **Never true, still not true: the product acceptance gate.** Real-hardware
  Dictation matrix, Meeting lifecycle soak, and updater-journey evidence were
  required and absent for `0.9.0-beta.2` before this reconciliation, and
  remain required and absent now. Nothing in this reconciliation changes that.
- **What must be recaptured before a beta.3 candidate decision:** rebuild the
  packaged candidate (`bun run release:mac`) against current `HEAD`; rerun
  every command under "Exact packaged candidate gate"; capture a fresh
  aggregate release audit (`bun run qa:packaged:macos:release-audit`) — the
  existing receipts predate this revision, and
  `scripts/lib/release-receipt-freshness.mjs` is designed to reject a receipt
  older than the candidate it's supposed to describe; and take fresh invite-
  kit screenshots, since the Dictation and Settings UI changed visibly (a new
  clipboard-copy toggle, a searchable language picker, meeting recovery
  actions, and a new onboarding step asking how meeting notes get written).
  This recapture work is scheduled for a later wave. This reconciliation's
  job was to say plainly what is stale, not to produce new green checkmarks
  for claims nobody has re-run.

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
- `SHA256SUMS.txt`, covering the DMG, ZIP, blockmap, and beta manifest
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
bun run gate:release:licenses
bun run gate:release:macos:trust
```

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

The aggregate release audit is:

```bash
bun run qa:packaged:macos:release-audit
```

It must report `PASS`. Missing evidence is a blocker, not an implicit pass.

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

The GitHub repository is currently private. A private GitHub release API is
not a client-reachable feed. Before inviting testers, either the release feed
must be public or the verified beta assets must be placed on another public,
credential-free update host. The integrated candidate is configured for the
dedicated generic feed above; its package and live feed still require fresh
verification. This is an external distribution gate, not something source
tests can waive.

The existing Cloudflare Pages site cannot host the candidate update ZIP because
the ZIP exceeds Pages' per-file limit. The current recommended path is a public
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
