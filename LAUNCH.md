# Plainsong limited beta launch checklist

Release target: `0.9.0-beta.1`

Last reconciled: August 10, 2026

This checklist is the release boundary for the first limited beta. Dictation
and Meetings are both supported product pillars. Source readiness, packaged
candidate readiness, and distribution are separate states.

## Current verdict

The current source passes all 11 source gates, including lint, TypeScript,
Vitest, Rust tests, builds, IPC reachability, dead-code checks, dependency
checks, and the committed Dictation latency budget. The current signed and
notarized `0.9.0-beta.1` candidate has release identity
`046a6dd6562e94f8a04656f251acb454c8c301fbd90accaec70602dc69a6983d`.
Its DMG, ZIP, blockmap, manifest, app, and native helpers are bound to that
identity and the current aggregate audit proves 16 of 21 release requirements.

The candidate is configured to use the credential-free generic feed at
`https://updates.plainsong.jonathanrreed.com/beta/`, but the host is not
provisioned or serving the candidate assets. Clearing that gate requires
publishing the exact manifest, ZIP, and blockmap at the configured origin and
passing the live feed verifier.

No beta artifact has been distributed, tagged, pushed, published, or sent to
testers from this work. Those external actions still require explicit approval.

Five aggregate audit rows remain contradicted. For the first invite-limited
group, the owner accepted three interference-prone observation rows as known
beta risks on August 10, 2026: the formal current-hash four-app Dictation
matrix, the remaining real-device Meeting lifecycle rows, and a repeat
three-hour exact-candidate soak. Core exact-candidate Dictation and Meeting
flows, including local transcription, insertion, microphone and system-audio
capture, Me + Them capture, persistence, export, recovery, clean installation,
and package trust, have separate passing evidence. Foreground app changes and
unrelated audio activity contaminated attempts to repeat the three accepted
rows while the Mac was also in active use.

This limited-beta acceptance does not convert those rows into passing evidence.
They remain required before a broader public launch. The signed beta.1 to
beta.2 updater journey and the public update feed also remain genuine
distribution gates, not accepted risks. Separately, GitHub reports that CI jobs
were not started because recent account payments failed or the Actions spending
limit must be increased. A beta tag must not be pushed until that account gate
is cleared and Actions can allocate and run, or the user explicitly approves a
manual local-release fallback. See
`nautilus-bot/docs/beta/EXTERNAL-GITHUB-ACTIONS-GATE.md`.

The historical `1.0.0` package was a prelaunch artifact and is not the beta
candidate. Its checksums, signatures, and QA receipts do not prove anything
about `0.9.0-beta.1`.

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
bun run gate:dictation-latency
bun run build:renderer
bun run build:electron
bun run gate:release:dependencies
bun run licenses:generate
git diff --check
```

Source-ready does not mean beta-ready.

## Exact packaged candidate gate

The following evidence must refer to the same app digest and package version:

- `Plainsong-0.9.0-beta.1-arm64.dmg`
- `Plainsong-0.9.0-beta.1-arm64-mac.zip`
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
bun run release:mac
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

The aggregate release audit is:

```bash
bun run qa:packaged:macos:release-audit
```

It must report `PASS`. Missing evidence is a blocker, not an implicit pass.

## Beta update gate

- `0.9.0-beta.1` requests `beta-mac.yml`.
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
credential-free update host. The current signed candidate is already bound to
the dedicated generic feed above, so another rebuild is required only if that
origin changes. This is an external distribution gate, not something source
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
3. Create and push tag `v0.9.0-beta.1`.
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
