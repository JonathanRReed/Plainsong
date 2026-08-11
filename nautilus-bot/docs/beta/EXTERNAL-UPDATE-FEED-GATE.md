# External gate record: credential-free beta update feed

- Status: waiting for user
- Observed at: 2026-08-09T22:08:50-05:00
- Objective: let an installed Plainsong limited beta check for and download signed updates without a repository token or other credential
- Original operation: request `https://updates.plainsong.jonathanrreed.com/beta/beta-mac.yml` without credentials and require the exact candidate manifest, ZIP, blockmap, hashes, sizes, and byte-range behavior
- Blocker class: Authority, with User decision and Provider contributing
- Current symptom: the signed and notarized candidate names the exact generic feed, beta channel, and single-range behavior, but the public host does not resolve or return the manifest

## Boundary

- Initiating surface: the installed Plainsong `electron-updater` client; the current diagnostic is `bun run qa:packaged:macos:public-update-feed`
- Execution host: the signed arm64 Plainsong app on a tester Mac; the diagnostic ran from the beta worktree on Jonathan's Mac
- Principal or identity class: anonymous HTTPS reader for the update client; an authenticated Cloudflare account owner would perform provisioning and upload
- Provider account, tenant, or control plane: the active Cloudflare account and active `jonathanrreed.com` zone were resolved through the existing secure Wrangler session; exact identifiers remain in local release evidence rather than source
- Target resource, environment, and release subject: a proposed production R2 bucket on `updates.plainsong.jonathanrreed.com`, serving Plainsong `0.9.0-beta.1` update assets
- Required permission or credential class: Cloudflare R2 bucket administration, DNS or custom-domain administration, and object write access; credential values must remain in Cloudflare or a secure credential store
- Authority source and approval status: the user authorized beta preparation, but has not yet authorized creating a public bucket, changing DNS, incurring provider usage, uploading release artifacts, committing, pushing, tagging, publishing, or inviting testers
- Cost, security, public, restart, and rollback effects: R2 Standard has usage-based storage and operation pricing with a free tier; the bucket and custom domain would be public; rollback is disabling or removing the custom domain and public access; the app needs another rebuild only if the approved feed origin changes

## Evidence

| Observed at | Read-only probe | Exact subject | Sanitized result | Supports |
| --- | --- | --- | --- | --- |
| 2026-08-09T19:43:00-05:00 | `gh repo view` | `JonathanRReed/Plainsong` | repository is private | a private GitHub release cannot be the unauthenticated installed-app feed |
| 2026-08-09T19:43:00-05:00 | GitHub Releases API | `JonathanRReed/Plainsong` | no releases exist | no current GitHub feed is available |
| 2026-08-09T19:44:14-05:00 | unauthenticated HTTPS request | `https://plainsong.jonathanrreed.com/` | HTTP 200 through Cloudflare | a public Cloudflare-backed product domain already exists |
| 2026-08-09T19:50:29-05:00 | exact feed verifier | proposed `updates/beta/` feed and prior signed candidate | manifest HTTP 404 and packaged provider `github` | the prior package and host both contradicted the gate |
| 2026-08-09T19:45:00-05:00 | current Cloudflare documentation | Pages and R2 limits | Pages allows 25 MiB per asset; the candidate ZIP exceeds that limit; R2 supports objects far larger than the candidate | the existing Pages project cannot carry the ZIP, while R2 can |
| 2026-08-09T20:19:12-05:00 | Apple trust gate | rebuilt `0.9.0-beta.1` app, ZIP, helpers, and DMG | Developer ID signatures, notarization tickets, stapling, and Gatekeeper all pass | the rebuilt candidate is a valid distribution artifact |
| 2026-08-09T20:19:34-05:00 | exact feed verifier | rebuilt candidate and `https://updates.plainsong.jonathanrreed.com/beta/` | packaged provider, URL, channel, and single-range settings all pass; unauthenticated manifest fetch fails because the host is unavailable | only public host provisioning and exact asset publication remain for this gate |
| 2026-08-09T22:04:00-05:00 | Wrangler account and R2 read-only queries | authenticated Cloudflare account | one account was resolved; its three existing Standard buckets are unrelated and total about 1.6 MB across 21 objects | a new narrowly named bucket is required and current observed storage is far below the Standard free allowance |
| 2026-08-09T22:06:00-05:00 | Cloudflare zone API | `jonathanrreed.com` | the zone is active in the same resolved account | the proposed R2 custom domain satisfies the same-account zone requirement |
| 2026-08-09T22:07:00-05:00 | public DNS and unauthenticated HTTPS | `updates.plainsong.jonathanrreed.com` | the hostname has no DNS answer and the manifest request cannot resolve | no public resource exists to preserve or overwrite |

## Attempts

| Attempt | Action | What changed first | Result or partial effect | Retry decision |
| --- | --- | --- | --- | --- |
| 1 | read-only request to the proposed Pages path | nothing | HTTP 404 | do not retry unchanged |
| 2 | added a fail-closed verifier and tested it against the proposed origin | local source and QA receipt only | verifier correctly rejected the missing feed and the packaged-provider mismatch | wait for an authorized host decision before any remote write |
| 3 | rebuilt with the exact generic feed and re-ran Apple and updater gates | generated release candidate only | package metadata and Apple trust pass; the live manifest request still fails | do not change the baked origin; provision and populate it after approval |
| 4 | resolved the Cloudflare account, zone, existing bucket inventory, current Wrangler commands, pricing, and rollback | read-only provider state and local staging only | exact target and a version-pinned publication plan are ready; no bucket, object, domain, or DNS record was created | wait for explicit production and public publication approval |

## Verification

- Original-operation retest: fail, the unauthenticated manifest request could not reach a live feed
- Independent state check: pass for the package, the signed candidate's `app-update.yml` names `provider: generic`, the exact approved URL, channel `beta`, and `useMultipleRangeRequest: false`
- Clearance decision: unresolved

## Handoff

- Next safe action: approve or reject creation of the new R2 Standard bucket `plainsong-updates`, public custom domain `updates.plainsong.jonathanrreed.com`, exact beta.1 asset publication, and the temporary beta.2 updater rehearsal; the resolved, version-pinned plan is stored outside source at `/Users/jonathanreed/Applications/Plainsong-Updater-QA.Current.LGZNl7/publication-plan.md`
- Action owner: user for approval, then agent for the narrowly approved configuration and upload
- Exact check to rerun afterward: upload the exact `beta-mac.yml`, ZIP, and blockmap, run `bun run qa:packaged:macos:public-update-feed -- --feed-url https://updates.plainsong.jonathanrreed.com/beta/`, then run the installed updater and aggregate release audit
- Remaining product, release, security, or external risks: the public origin, asset integrity, redirect behavior, and byte-range behavior are unproven until the feed is live; any change to the baked URL or candidate assets requires requalification before invitations
