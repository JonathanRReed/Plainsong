# Plainsong Finish and Branch Integration Design

Date: 2026-08-22
Status: Approved direction; pending written-spec review

## Objective

Produce one best, internally consistent Plainsong codebase by preserving the last known-good `main`, adopting the substantive dual-pillar beta work, reconciling every remaining remote branch, fixing defects found during integration, and merging the verified result into local `main`.

The result must remain private. This design does not authorize pushing, publishing releases, deploying infrastructure, distributing artifacts, changing repository visibility, changing credentials or provider settings, spending money, or deleting user data.

## Completion Boundary

The active completion boundary is a locally committed and merged `main` that:

- contains the useful work from every current branch, or records an evidence-based reason for excluding a change;
- passes the repository's source gates on the exact merged revision;
- builds a coherent macOS package from that revision;
- preserves the product's local-first, security, privacy, recovery, and release invariants;
- has its primary Dictation and Meetings journeys exercised at the strongest locally available layer;
- contains truthful documentation tied to current evidence rather than historical artifacts;
- has no known source-controlled release blocker left unresolved.

Local completion is not public launch. Update-host provisioning, an unauthenticated live update feed, GitHub Actions account recovery, beta distribution, a published release, and repository visibility remain external gates unless separately authorized.

## Product Contract

Plainsong is a free, open-source, local-first macOS speech application. Dictation is the default and fastest route. Meetings is a fully supported second pillar for bot-free capture, transcripts, notes, follow-up material, recovery, and export.

The integrated product preserves these rules:

- local processing is the default;
- remote providers are named, explicitly enabled, revocable, and use user-owned credentials;
- renderer state never authorizes privileged capture, storage, provider, vault, or update operations;
- recognized text and meeting data survive recoverable delivery or lifecycle failures;
- UI status says what is happening, why, and what the user can do next;
- public-facing claims never exceed packaged and runtime evidence.

## Inspected Baseline and Branch Inventory

Repository root: `/Users/jonathanreed/Downloads/Plainsong`

Inspected baseline:

- local `main`: `be52f87ae0d94bbcf5e72aadf8083f1bcdf324a3`;
- `origin/main`: the same revision;
- `origin/launch/audit-remediation`: the same revision;
- worktree: clean at inspection time;
- additional worktrees: none;
- stashes: none;
- repository: private.

Current unique remote branches:

1. `origin/codex/plainsong-dual-pillar-beta` at `9fe9b431a9ee0bac2eb83d8df90bae3ba29f12d6`
   - one commit ahead of `main`;
   - 196 files changed, approximately 18,278 additions and 3,280 deletions;
   - adds coordinated Dictation, Meetings, security, storage, updater, QA, support-bundle, and beta-release work;
   - changes the release identity from historical `1.0.0` prelaunch state to `0.9.0-beta.1`.
2. Bun Dependabot branch at `0eeba1848ef308e4b3dedadd9be0ebf58259692a`
   - updates 14 application and development dependencies;
   - includes higher-risk `jsdom` 29 to 30, Vite 8.1 to 8.2, Electron 43.2 to 43.4, and Knip changes;
   - conflicts with the candidate's generated `bun.lock`.
3. Cargo Dependabot branch at `42f7e2d509bb1c6e05e77fda7178caf33b498287`
   - updates Rubato 4 to 5 and ONNX Runtime bindings from `ort` rc.12 to rc.13, plus lower-risk transitive updates;
   - conflicts with the candidate's `Cargo.lock` and must preserve the candidate's intentional removal of PDF-export dependencies.
4. GitHub Actions Dependabot branch at `31440a75232aedd65e1f237ca0023cf92648d4dd`
   - updates the pinned `Swatinem/rust-cache` commit;
   - merges cleanly but needs an accurate source/version comment because the new pin is not the tagged `v2.9.1` commit.

No other current local or remote branch contains unique work.

## Known Candidate Defects to Resolve First

A read-only review of the dual-pillar candidate identified reproducible integration defects that must be closed before its historical readiness claims are accepted:

1. QA receipt wiring is inconsistent.
   - Most packaged QA commands write under `artifacts/qa/macos/` or `artifacts/release/`.
   - The release-audit and Meetings-lifecycle aggregators read from `release/qa/` and expect different filenames.
   - The aggregators therefore cannot reproduce the documented aggregate result from repository commands.
   - The finish must establish one canonical receipt directory and naming contract, expose an explicit override only where useful, and test producer-to-consumer compatibility.
2. The Dictation latency gate is not self-sufficient on a clean checkout.
   - It requires an ignored `artifacts/qa/dictation-latency.json` receipt.
   - The source-gate aggregator, local-release gate, and launch instructions run the verifier without first producing the receipt.
   - The finish must either generate a current receipt as part of the owning gate or classify the check honestly as a prerequisite-bound runtime gate. A fresh checkout must not advertise an impossible source-gate sequence.
3. Candidate documentation overclaims evidence.
   - Root and app READMEs, the changelog, and launch checklist claim clean-install and aggregate-audit proof that the repository scripts cannot currently reproduce.
   - These claims must be removed or rewritten until current exact-candidate receipts prove them.
4. The candidate release workflow omits declared package gates.
   - The workflow does not run the release-license or cold-start gates before staging a draft.
   - License generation is not explicitly refreshed before packaging.
   - The finish must close these gaps or narrow the workflow's stated completion claim.
5. Stale release surfaces remain.
   - The unused Windows release command retains `--publish always` despite Windows being outside the supported build.
   - A CI comment names the stable manifest instead of the beta manifest.
   - The Homebrew template hard-codes the historical `1.0.0` artifact.
   - These surfaces must be made safe and consistent with the selected beta contract.

Historical receipts remain useful investigation inputs, but no candidate gate is considered passing until its current command and evidence contract is reproducible.

## Selected Integration Architecture

Use a candidate-first private finish branch.

1. Preserve `main` at the last known-good notarized baseline.
2. Create `finish/plainsong` from the dual-pillar candidate revision.
3. Validate the candidate before applying any dependency branch.
4. Repair candidate defects and documentation drift in bounded vertical tranches.
5. Reconcile the three dependency branches semantically rather than blindly accepting conflicted generated files.
6. Verify the combined exact revision through source, package, runtime, and rendered-product layers.
7. Create local checkpoint commits only after their corresponding gates pass.
8. Merge the verified finish branch into local `main`.
9. Re-run the final acceptance set on merged `main` because the merge result, not the finish branch alone, is the completion target.

This approach is preferred over selective porting because the dual-pillar candidate contains cross-layer security and lifecycle invariants that could be broken by extracting files independently. It is preferred over updating `main` immediately because the known-good baseline remains untouched until the candidate and dependency work are proven together.

## Integration Tranches

### Tranche 1: Candidate adoption and source baseline

Establish `finish/plainsong` at the dual-pillar candidate. Inspect the complete candidate diff and run its declared source gates without changing dependencies.

Required evidence:

- clean branch identity and worktree;
- frozen dependency install;
- typecheck and lint;
- Vitest and Rust tests;
- renderer and Electron builds;
- IPC, dead-code, dependency, latency, license, and whitespace gates where present;
- classified failures with no failure waived as historical noise.

Any candidate failure is fixed before dependency updates begin unless the failure is conclusively environmental and recorded as such.

### Tranche 2: Product and security closure

Review and exercise the candidate's highest-risk contracts:

- privileged capture admission;
- authoritative Dictation and Meetings identifiers and lifecycle transitions;
- remote-processing consent and revocation;
- privileged export, backup, restore, and vault destinations;
- operation serialization and cancellation;
- model download limits and integrity;
- updater version, channel, downgrade, and artifact-identity rules;
- support-bundle redaction;
- recovery after insertion, capture, sidecar, helper, or renderer failure.

For every defect, add or identify a failing check at the owning boundary, apply the narrowest fix, and re-run adjacent regression coverage.

### Tranche 3: Dependency reconciliation

Integrate dependency work in this order:

1. GitHub Actions pin update.
   - Apply the updated immutable SHA.
   - Correct any misleading version comment.
   - Validate workflow syntax and inspect the resulting workflow diff.
2. Rust dependency updates.
   - Apply manifest intent on top of the candidate.
   - Regenerate or selectively update `Cargo.lock` from the merged manifest.
   - Do not reintroduce removed `base64`, `genpdf`, or `export-pdf` functionality.
   - Focus verification on Rubato resampling, Parakeet, Moonshine, diarization, and every `ort` execution-provider path available locally.
3. Bun dependency updates.
   - Apply manifest updates while preserving the candidate's security overrides and beta scripts.
   - Regenerate `bun.lock`; do not hand-splice conflict hunks.
   - Verify Vitest/jsdom behavior, renderer production output, Electron capture behavior, Knip output, and package metadata.

A dependency update may be excluded only when direct evidence shows an unresolved regression or incompatible release contract. Any exclusion is documented with the exact package, attempted version, observed failure, and smallest future probe.

### Tranche 4: Product-quality and rendered-runtime review

Run Plainsong and inspect the real interface rather than treating tests as UI proof.

Cover:

- onboarding and limited-mode behavior;
- Dictation default route, shortcut states, insertion result, copy fallback, and recovery;
- Meetings start readiness, microphone/system-audio choices, stable recording identity, processing, results, and recovery;
- Settings, provider consent, model status, vault/storage status, and update messaging;
- support-bundle preview and redaction;
- dark and light themes;
- keyboard navigation, focus return, accessible names, live status, reduced motion, and minimum supported window size;
- loading, empty, blocked, degraded, success, and error states;
- browser console and Electron logs.

Visual changes remain within the established Plainsong vellum, ink, gold, rust, Newsreader, and IBM Plex system. This effort fixes hierarchy, state clarity, accessibility, and workflow quality; it does not rebrand the product.

### Tranche 5: Exact package and local acceptance

Build the exact integrated candidate and bind evidence to its source revision and artifact identity.

Where credentials, permissions, hardware, and existing safe test fixtures permit, verify:

- native helper architecture and entitlements;
- package version and beta update metadata;
- package size, cold start, licenses, signatures, notarization/stapling state, and Gatekeeper assessment;
- local Whisper dictation and latency receipt;
- representative insertion host classes;
- microphone and system-audio meeting routes;
- persistence, relaunch recovery, export, retention, backup, and restore;
- updater policy without publishing or provisioning a public feed.

Existing historical package receipts may guide investigation but do not prove the new integrated artifact.

### Tranche 6: Documentation, final review, and merge

Reconcile README, app README, changelog, launch checklist, beta materials, security/dependency notes, setup instructions, and release workflow claims against the final evidence.

Then:

1. run a focused correctness, security, test-gap, performance, and UI review of the complete integration diff;
2. fix validated findings and repeat affected checks;
3. run the full final gate on `finish/plainsong`;
4. merge the verified branch into local `main`;
5. run merge-sensitive checks and the final acceptance set on local `main`;
6. confirm local `main` is clean and contains every intended branch result.

No push or publication occurs.

## Component and Data-Flow Invariants

### Renderer

The React renderer presents authoritative state and sends user intent. It does not infer privileged readiness from platform assumptions, stored values, or optimistic defaults. It must preserve actionable error and recovery state across remounts and route changes.

### Electron

Electron owns global shortcuts, trusted user-action capabilities, window identity, native insertion, top-level permissions, updater policy, and the renderer-to-sidecar IPC boundary. Sensitive operations must be bound to a current trusted window or global shortcut and constrained by typed command policy.

### Rust sidecar

Rust owns audio capture, ASR, recording lifecycle, durable data, model integrity, vault operations, remote-processing enforcement, exports, backups, and operation coordination. Filesystem work remains under approved roots and rejects unsafe traversal or symlink behavior.

### Primary Dictation flow

Trusted action -> readiness/admission -> capture -> transcription -> durable result -> insertion attempt -> independently recorded delivery status -> recovery actions.

Recognized text is never destroyed because insertion, cleanup, or target detection fails.

### Primary Meetings flow

Trusted action -> immutable readiness snapshot -> stable recording identifier -> transactional source startup -> recording -> bounded stop -> persistence -> processing -> transcript and follow-up material -> export/recovery.

Duplicate or stale events cannot clear or replace the authoritative recording identity.

### Remote flow

Explicit user enablement -> privileged consent generation -> provider request admission -> immediate pre-transmission consent recheck -> bounded request -> named result or actionable error.

Revocation increments the generation, aborts in-flight work where possible, and prevents later transmission.

## Error Handling and Rollback

- Preserve the known-good `main` until final merge.
- Use narrow checkpoint commits after verified tranches so integration failures can be isolated without rewriting history.
- Do not use force pushes, resets that discard work, broad file restoration, or destructive cleanup.
- Diagnose failing tests and runtime paths before applying fixes.
- Treat permission, credential, provider-account, CI-account, signing, notarization, feed-hosting, and publication failures as separate external categories.
- Never convert an unavailable external gate into a passing product claim.
- Do not log or commit secrets, provider keys, transcripts, audio, personal paths, or unsanitized support artifacts.
- Do not delete user content or mutate live Plainsong data. Runtime QA uses isolated profiles or reversible fixtures.

## Verification Strategy

Verification follows an evidence ladder. Later layers do not imply earlier ones, and earlier layers do not prove later behavior.

1. Source: review, typecheck, formatting, lint, unit and integration tests.
2. Contract: IPC reachability, command policy, state-machine, security regression, dependency, dead-code, and notice checks.
3. Build: renderer, Electron, Rust sidecar, and native helpers.
4. Local runtime: real app startup, logs, Dictation, Meetings, provider-disabled behavior, and recovery.
5. Rendered UI: navigation, states, themes, keyboard, accessibility, responsiveness, and console cleanliness.
6. Package: exact app/DMG/ZIP identity, architecture, metadata, fuses, entitlements, licenses, size, cold start, signatures, and update metadata.
7. Real-device acceptance: locally available insertion hosts, microphone, system audio, persistence, relaunch, backup, restore, and update-policy behavior.
8. External/public: CI account, public update feed, clean external Mac, distribution, release publication, and repository visibility. These remain blocked or not authorized unless separately approved.

The final report names the exact revision, commands, outcomes, runtime observations, package identity, excluded branch changes, and remaining external blockers.

## Acceptance Criteria

The local integration is complete only when:

- every current branch has been evaluated;
- the dual-pillar candidate is integrated and reviewed;
- dependency branches are integrated or explicitly excluded with direct regression evidence;
- all source-controlled defects found during the effort are fixed;
- required source and build commands pass on local `main`;
- the app launches and primary rendered flows have current observations;
- the strongest available package and real-device gates have been run against the exact integrated revision;
- documentation matches the actual current evidence;
- local checkpoint and merge commits are present;
- local `main` is clean and contains the finished result;
- no remote, production, publication, visibility, credential, spending, or destructive action has occurred.

If an unavailable external gate prevents a broader claim, the local product may be complete within this boundary while public launch remains explicitly blocked. The final report must keep those states separate.
