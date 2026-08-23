# Plainsong Finish and Branch Integration Implementation Plan

Date: 2026-08-22
Status: Approved design; implementation pending explicit start instruction
Design: `docs/superpowers/specs/2026-08-22-plainsong-finish-integration-design.md`

## Terminal Objective

Produce a locally committed and merged `main` containing the best coherent Plainsong implementation from every current branch, with all source-controlled defects found during integration fixed and the strongest locally available source, runtime, rendered UI, package, and real-device gates run against the exact merged revision.

The repository remains private. This plan does not authorize pushing, tagging, publishing, deploying, provisioning an update host, distributing an artifact, changing repository visibility, changing credentials or provider settings, spending money, or deleting user data.

## Execution Rules

- Work from `/Users/jonathanreed/Downloads/Plainsong`; run app commands from `nautilus-bot/` unless a command explicitly targets the outer repository.
- Preserve local `main` at `be52f87ae0d94bbcf5e72aadf8083f1bcdf324a3` until the final merge.
- Carry the approved design and this plan onto the finish branch without overwriting candidate files.
- Use Bun because the repository declares `bun@1.3.14`; do not substitute npm, pnpm, Yarn, or `bun test` for repository scripts.
- Do not add a production dependency unless existing repository-native code cannot satisfy an approved invariant and the user separately approves the dependency.
- Treat generated lockfiles as package-manager output. Never splice conflicted lock hunks manually.
- Diagnose failures before fixing them. For behavior changes, add or identify a failing check at the owning boundary first.
- Keep source, local runtime, package, signed/notarized artifact, deployed feed, and public release states separate.
- Keep generated QA artifacts, audio, transcripts, support bundles, secrets, credentials, and personal paths out of commits. Commit only reviewed source, configuration, tests, and truthful sanitized documentation.
- Use isolated QA profiles and reversible fixtures. Do not touch live Plainsong user data.
- Create local checkpoint commits only after the corresponding gate passes. Do not rewrite history or force-push.
- Stop for destructive actions, production/provider changes, authentication, paid actions, or any authority boundary not covered above.

## Pinned Inputs

- Baseline `main`: `be52f87ae0d94bbcf5e72aadf8083f1bcdf324a3`
- Dual-pillar candidate: `9fe9b431a9ee0bac2eb83d8df90bae3ba29f12d6`
- GitHub Actions dependency branch: `31440a75232aedd65e1f237ca0023cf92648d4dd`
- Cargo dependency branch: `42f7e2d509bb1c6e05e77fda7178caf33b498287`
- Bun dependency branch: `0eeba1848ef308e4b3dedadd9be0ebf58259692a`
- Planned local integration branch: `finish/plainsong`
- Planned integrated package version: `0.9.0-beta.2`

`0.9.0-beta.2` is used because the integrated result changes source, dependencies, QA contracts, and artifact identity after the historical `0.9.0-beta.1` candidate. It also preserves `beta.1` as the correct future N-to-N+1 update baseline. This does not authorize publication of either version.

## Phase 0: Reconfirm and Preserve the Baseline

### Task 0.1: Re-read current repository state

Run read-only checks:

```bash
git status --short --branch
git rev-parse HEAD
git branch --all --verbose --no-abbrev
git remote --verbose
git worktree list --porcelain
git stash list
git log --oneline --decorate -n 12
```

Acceptance:

- `main` remains at the pinned baseline.
- The only expected worktree additions are this approved design and plan.
- No new branch, stash, worktree, or remote commit appeared since inspection without being classified.
- If remote state drifted, inventory and compare it before mutation.

### Task 0.2: Confirm the local toolchain without changing it

```bash
bun --version
cargo --version
rustc --version
xcode-select -p
xcrun --find notarytool
```

Acceptance:

- Required tools are available.
- A Bun version mismatch is recorded. Use the repository-declared version if already available; do not change global tooling or project security policy merely to silence a mismatch.

### Task 0.3: Preserve planning artifacts

Confirm both files are complete and whitespace-clean:

- `docs/superpowers/specs/2026-08-22-plainsong-finish-integration-design.md`
- `docs/superpowers/plans/2026-08-22-plainsong-finish-integration-plan.md`

Do not commit them on baseline `main`. Carry them into the finish branch and include them in the first verified checkpoint.

## Phase 1: Establish the Candidate Finish Branch

### Task 1.1: Create the private local finish branch

Create `finish/plainsong` directly at the dual-pillar candidate SHA. Do not move `main`.

Acceptance:

- `finish/plainsong` points at `9fe9b43` before local changes.
- The approved design and plan remain present as uncommitted additions.
- No remote branch or repository visibility changes.

### Task 1.2: Install the candidate's frozen dependencies

From `nautilus-bot/`:

```bash
bun install --frozen-lockfile
cargo fetch --locked --manifest-path rust-sidecar/Cargo.toml
```

Do not regenerate either lockfile in this phase. A frozen-install failure is candidate evidence and must be diagnosed before dependency integration.

### Task 1.3: Run the candidate source baseline

Run independently so each failure is attributable:

```bash
bun run gate:ipc-contract
bun run gate:dead-code
bun run typecheck
bun run test
bun run lint:rust
bun run test:rust
bun run build:renderer
bun run build:electron
bun run gate:release:dependencies
git diff --check
```

Do not run the aggregate source-gate command as proof until its latency and receipt wiring are repaired in Phase 2.

Acceptance:

- Every failure is reproduced and classified as product, test, build, environment, or external.
- Candidate failures are not waived because historical documentation claims they passed.
- The tracked `real-speech-44s.wav` fixture is included in the test checkout. A prior review's missing-fixture failures came from archiving only `rust-sidecar/`, not from the candidate tree, and must not be treated as a product defect unless reproduced from the full checkout.

### Task 1.4: Record the candidate baseline

Commit the approved design and plan together with only fixes required to make the untouched candidate source baseline reproducible. Do not include ignored artifacts or package output.

Checkpoint acceptance:

- Branch identity is recorded.
- Source baseline results are current.
- `main` remains unchanged.

## Phase 2: Repair Candidate Gate and Release Contracts

### Task 2.1: Unify QA receipt paths and names

Owning files:

- `nautilus-bot/scripts/capture-packaged-macos-release-audit.mjs`
- `nautilus-bot/scripts/capture-packaged-macos-meeting-lifecycle.mjs`
- their `.d.mts` contracts where applicable
- `nautilus-bot/package.json`
- `nautilus-bot/docs/CODE_SIGNING.md`
- focused tests under `nautilus-bot/src/__tests__/`

Test first:

- Add producer-to-consumer contract cases showing the aggregators consume the exact default paths and filenames emitted by packaged QA commands.
- Cover the canonical directory, an explicit override, missing evidence, stale evidence, and exact-candidate identity mismatch.
- Confirm the new contract tests fail against the candidate.

Implementation:

- Use `artifacts/qa/macos/` as the canonical local receipt directory.
- Preserve explicit `--qa-dir` support where operators need an isolated receipt root.
- Align aggregator inputs with producer filenames, including microphone, combined meeting/system audio, system-audio test, soak, trust, update metadata, source gates, support bundle, backup, retention, exports, app matrix, and Whisper transcription.
- Put the aggregate release-audit output under the same isolated receipt contract unless a package-owned output has a documented reason to differ.
- Bind source evidence by revision or digest rather than relying only on file modification times when possible.

Verification:

```bash
bun run test -- src/__tests__/packaged-meeting-lifecycle-script.test.ts \
  src/__tests__/release-receipt-freshness.test.ts \
  src/__tests__/release-candidate-identity.test.ts
bun run qa:packaged:macos:meeting:lifecycle -- --qa-dir artifacts/qa/macos
bun run qa:packaged:macos:release-audit -- --qa-dir artifacts/qa/macos
```

The aggregate may honestly report missing real-device receipts, but it must not report contradictions caused solely by mismatched repository defaults.

### Task 2.2: Make the Dictation latency gate reproducible and honestly classified

Owning files:

- `nautilus-bot/package.json`
- `nautilus-bot/scripts/capture-source-gates.mjs`
- `nautilus-bot/scripts/verify-dictation-latency.mjs`
- `nautilus-bot/src/__tests__/dictation-latency-gate.test.ts`
- `nautilus-bot/src/__tests__/reproducibility-config.test.ts`
- `LAUNCH.md`

Selected policy:

- Treat measured Dictation latency as a runtime/package gate, not an unconditional source-only gate, because it requires a real model and generated receipt.
- Keep the verifier strict.
- Provide an explicit benchmark-then-verify command sequence.
- Remove any clean-checkout source aggregate that attempts to verify a nonexistent ignored receipt.
- When the model is unavailable, return an actionable prerequisite status rather than implying a passing or silently skipped measurement.

Test first:

- Fresh checkout with no receipt is classified as missing runtime evidence, not a source-code failure.
- Invalid, stale, wrong-model, wrong-fixture, and over-budget receipts fail.
- A current valid receipt passes.

Verification when the local model is available:

```bash
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
bun run gate:dictation-latency
```

### Task 2.3: Correct unsupported candidate readiness claims

Owning documentation:

- `README.md`
- `nautilus-bot/README.md`
- `nautilus-bot/CHANGELOG.md`
- `LAUNCH.md`
- `nautilus-bot/docs/CODE_SIGNING.md`
- relevant beta documents under `nautilus-bot/docs/beta/`

Implementation:

- Remove or qualify claims that clean install, the aggregate 16-of-21 audit, or exact-candidate package gates are currently reproducible.
- Keep historical evidence explicitly historical and tied to its old revision/artifact identity.
- State that the integrated `beta.2` artifact requires fresh source, package, runtime, and real-device evidence before distribution.
- Keep GitHub Actions account status and public update-feed provisioning as external gates.

Verification:

- Search all release-facing documentation for old candidate hashes, `16 of 21`, unqualified clean-install claims, and stale `1.0.0` or `beta.1` completion language.
- Review every remaining match in context rather than performing blind replacement.

### Task 2.4: Close release-workflow package-gate omissions

Owning files:

- `.github/workflows/release.yml`
- workflow/reproducibility tests that assert release order

Test first:

- Assert third-party notices are generated before packaging.
- Assert packaged licenses and cold start are verified before draft staging.
- Assert the workflow still cannot publish directly and refuses to alter a published release.

Implementation order:

1. Generate current notices before `release:mac`.
2. Build without direct publication.
3. Run dependency, TCC, native helper, updater metadata, size, license, and cold-start gates.
4. Notarize/staple the DMG when credentials are available.
5. Run the trust gate.
6. Only then stage an artifact-only draft.

Do not run or dispatch the workflow during local implementation.

### Task 2.5: Remove stale or unsafe release surfaces

Owning files:

- `nautilus-bot/package.json`
- `.github/workflows/ci.yml`
- `nautilus-bot/docs/homebrew.md`
- `nautilus-bot/electron-builder.yml`
- release-identity/reproducibility tests

Implementation:

- Ensure every Windows command uses `--publish never`, or remove an unsupported command only when no documented consumer requires it.
- Update the CI package comment to the beta manifest.
- Make Homebrew examples derive from package metadata and avoid naming a nonexistent historical artifact.
- Remove hard-coded release-version assumptions from tests where package metadata is authoritative.
- Synchronize the integrated version to `0.9.0-beta.2` across package, Rust manifest, package configuration, workflow expectations, tests, documentation, and artifact naming.

Phase 2 acceptance:

```bash
bun run typecheck
bun run test
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
git diff --check
```

Create a local checkpoint commit only after these pass.

## Phase 3: Close Product, Lifecycle, and Security Findings

### Task 3.1: Make every Meeting stop failure visible and recoverable

Owning files:

- `nautilus-bot/src/components/popups/recording-popup.tsx`
- `nautilus-bot/src/components/views/recordings-view.tsx`
- `nautilus-bot/src/hooks/use-recording.tsx`
- `nautilus-bot/src/__tests__/recording-popup.test.tsx`
- `nautilus-bot/src/__tests__/recordings-view.test.tsx`
- `nautilus-bot/src/__tests__/use-recording.test.ts`

Test first:

- Overlay Stop success reaches a terminal state.
- Overlay Stop failure shows a visible actionable error and does not create an unhandled rejection.
- Main Meetings Stop failure shows the same cause and retry path.
- Duplicate Stop remains idempotent.
- Sidecar loss during Stop preserves the recording identity and user recovery information.

Implementation:

- Use the lifecycle state as the shared source for phase and error copy.
- Catch button-handler failures at the UI boundary.
- Keep recording state active or recoverable until the backend confirms a terminal state.
- Avoid console-only failure handling.

### Task 3.2: Reconcile renderer and Electron Meeting state machines

Owning files:

- `nautilus-bot/src/features/meetings/runtime.ts`
- `nautilus-bot/electron/meeting-lifecycle.ts`
- `nautilus-bot/electron/main.ts`
- focused renderer and Electron lifecycle tests

Test first:

- Same-ID progress transitions.
- Different-ID active event while another recording is active.
- Stale terminal event.
- Crash/reconnect event with authoritative persisted identity.
- Delayed or missing terminal sidecar event after Stop.
- Stop request with matching and mismatching requested IDs.

Selected invariant:

- Electron and renderer apply one documented identity policy.
- A new active ID cannot silently replace another active ID.
- Recovery/reconnect can adopt a different persisted ID only through an explicit authoritative reconciliation transition.
- The active ID clears only on the matching terminal event or confirmed reconciliation.

### Task 3.3: Prove capture admission through the real Electron event boundary

Owning files:

- `nautilus-bot/electron/capture-admission.ts`
- `nautilus-bot/electron/main.ts`
- `nautilus-bot/electron/ipc-command-policy.ts`
- Electron IPC/admission tests
- packaged Meetings lifecycle harness

Test first:

- Recent trusted keyboard input issues one route-specific, window-bound capability.
- Recent trusted mouse input does the same.
- Stale, replayed, wrong-window, wrong-origin, and wrong-route capabilities fail.
- Overlay interactions do not bypass or accidentally suppress Electron observation.

Follow with a packaged manual mouse and keyboard Start/Stop check in Phase 5.

### Task 3.4: Review capture/update shutdown timing and stale active IDs

Owning files:

- `nautilus-bot/electron/main.ts`
- `nautilus-bot/electron/updater-install-flow.ts`
- `nautilus-bot/electron/meeting-lifecycle.ts`
- lifecycle and updater tests

Test first:

- Meeting finalization budget cannot exceed forced-quit behavior in a way that truncates normal sidecar shutdown.
- Update installation cannot begin while a meeting is active or unresolved.
- Lost lifecycle events are reconciled from backend state before quit or update.
- Updater failure leaves the installed version runnable.

### Task 3.5: Review Rust coordination and filesystem boundaries

Owning files:

- `nautilus-bot/rust-sidecar/src/operation_coordinator.rs`
- `nautilus-bot/rust-sidecar/src/admission.rs`
- `nautilus-bot/rust-sidecar/src/approved_locations.rs`
- `nautilus-bot/rust-sidecar/src/safe_fs.rs`
- `nautilus-bot/rust-sidecar/src/backup.rs`
- `nautilus-bot/rust-sidecar/src/export/mod.rs`
- `nautilus-bot/rust-sidecar/src/lib.rs`

Test first where a direct boundary is feasible:

- Capture and restore cannot overlap unsafely.
- Dictation cannot race into Meeting capture after admission checks.
- Existing and not-yet-created export paths reject symlink parents and unsafe traversal at final write time.
- Backup rollback and publication do not follow attacker-controlled symlinks.
- Remote-processing revocation prevents later transmission and aborts in-flight work where supported.
- UUID-shaped Meeting data is not treated as renderer authorization; Electron-issued admission remains the privileged trust decision.

Implementation guidance:

- Preserve the candidate's `safe_fs`, approved-location, coordinator, and remote-gate architecture.
- Prefer descriptor-relative or no-follow operations already present in `safe_fs` over new ad hoc path checks.
- Replace production panic paths only where the reviewed code can return a meaningful error without broad refactoring.
- Do not claim a vulnerability where the final `safe_fs` write already fails closed; improve resilience and error clarity at the narrow boundary.

### Task 3.6: Confirm intentional feature and version changes

- Confirm no renderer, Electron, Rust, script, or documentation consumer still requires `export-pdf`, `genpdf`, or its optional `base64` dependency.
- Preserve their candidate removal if no supported consumer exists.
- Do not restore historical `1.0.0`; the integrated candidate is `0.9.0-beta.2` by design.
- Ensure the source fixture `scripts/fixtures/real-speech-44s.wav` remains tracked and available to full-checkout tests.

Phase 3 acceptance:

```bash
bun run test
bun run test:rust
bun run lint
bun run gate:ipc-contract
bun run build:renderer
bun run build:electron
git diff --check
```

Do not begin dependency integration until these pass. Create a checkpoint commit after the full phase is green.

## Phase 4: Reconcile Dependency Branches Semantically

Integrate in this order: GitHub Actions, Rust, Bun. Do not merge either generated lockfile from its Dependabot branch wholesale.

### Task 4.1: Integrate the GitHub Actions pin

Apply commit intent to:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

Requirements:

- Use immutable SHA `258712b0b7b1ddf8bddc9fc3b0faca682b2736c3` everywhere the action appears.
- Replace the inaccurate `v2.9.1` comment with an upstream-verified tag/version or a truthful commit-specific comment.
- Inspect the upstream commit before adoption if network access is available.
- Validate workflow syntax with the repository's available YAML/action tooling and focused tests. Do not add a dependency only to validate YAML.

### Task 4.2: Integrate Cargo updates

Start from the candidate manifest, preserving removed PDF-export dependencies.

Manifest intent:

- `rubato = "5.0"`
- `ort = "2.0.0-rc.13"`
- compatible patch updates for `thiserror`, Futures, `async-trait`, and other lock-resolved packages from the branch

Regenerate `Cargo.lock` using targeted Cargo updates, then inspect the complete lock diff. Do not reintroduce `genpdf`, optional PDF `base64`, or stale packages made unreachable by candidate removal.

Verification:

```bash
cargo fmt --manifest-path rust-sidecar/Cargo.toml --check
cargo clippy --locked --manifest-path rust-sidecar/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path rust-sidecar/Cargo.toml --lib --bins
```

Focused runtime/test surfaces:

- Rubato resampling and mixed capture
- Parakeet and Moonshine
- diarization embeddings
- every locally available `ort` execution provider
- Whisper behavior as a regression control

If `ort` rc.13 or Rubato 5 causes an unresolved product regression, revert only that update, record direct evidence, and keep the rest of the safe dependency work. Do not weaken tests or feature flags to force acceptance.

### Task 4.3: Integrate Bun application updates

Apply manifest intent while preserving candidate beta scripts and security overrides:

- `@base-ui/react` `^1.7.0`
- `lucide-react` `^1.31.0`
- `@testing-library/jest-dom` `^7.0.1`
- `@testing-library/user-event` `^14.6.4`
- `@types/node` `^26.2.0`
- `@types/react` `^19.2.18`
- `@types/react-dom` `^19.2.4`
- `@vitejs/plugin-react` `^6.0.5`
- `electron` `^43.4.0`
- `esbuild` `^0.28.2`
- `jsdom` `^30.0.1`
- `knip` `6.32.2`
- `postcss` `^8.5.26`
- `vite` `^8.2.1`

Preserve or update candidate overrides deliberately, including `fast-uri`, `js-yaml`, and `esbuild`. Update Knip's schema and exact reproducibility assertions with the package version.

Run `bun install` to regenerate `bun.lock` from the merged manifest, then inspect the full lock diff. Pay special attention to the root/nested Vite split, Rolldown/OXC changes, jsdom 30 behavior, Electron capture changes, and Knip findings.

Verification:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build:renderer
bun run build:electron
bun run gate:dead-code
bun run gate:release:dependencies
```

### Task 4.4: Verify all dependency work together

```bash
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
git diff --check
```

Create one local dependency checkpoint only after combined verification. Record any intentionally excluded bump and its direct failure evidence.

## Phase 5: Run and Inspect the Real Product

### Task 5.1: Build native components and launch with an isolated profile

```bash
bun run sidecar:build:release
bun run shortcut-helper:build
bun run dev
```

Reuse repository QA isolation helpers. Do not point runtime tests at live user storage.

### Task 5.2: Inspect rendered application states

Cover both dark and light themes and the minimum supported window size:

- first-run loading, model prerequisite, permission denial, retry, limited mode, and completion;
- Dictation default route, keyboard and mouse initiation, preparing/listening/transcribing/inserting/completed states, preserved text, copy fallback, retry, and repair action;
- Meetings unavailable, preparing, recording, stopping, processing, ready, duplicate Stop, Cancel, sidecar loss, source interruption, and recovery;
- Settings provider consent disabled/enabled/revoked, no provider call from passive page view, model status, vault/storage state, and update status;
- support-bundle preview and redaction;
- loading, empty, degraded, blocked, success, and error states;
- keyboard traversal, visible focus, focus return, screen-reader names/order, live status, reduced motion, contrast, and long copy;
- renderer console, Electron logs, sidecar logs, and orphan process state.

### Task 5.3: Exercise the reviewed Meeting defects manually

1. Start by mouse in the main window and Stop from the overlay.
2. Start by keyboard and Stop from the Meetings view.
3. Induce a bounded sidecar failure during Stop using the repository harness, not destructive process manipulation against live data.
4. Confirm visible error, preserved ID, retry/recovery path, no unhandled rejection, and no false idle state.
5. Confirm a stale/different-ID event cannot make Electron and renderer disagree.

### Task 5.4: Review UI quality before cosmetic changes

Fix workflow behavior, state hierarchy, accessibility, clipping, and interaction feedback before palette-only changes. Preserve the established Plainsong design system and avoid unrelated rebranding.

Verification receipts remain local and ignored. Summarize sanitized observations in tracked release documentation only after exact revision evidence exists.

Create a checkpoint commit for validated runtime/UI fixes after source checks pass again.

## Phase 6: Build and Verify the Exact Local Candidate

### Task 6.1: Produce one exact package identity

- Regenerate third-party notices before packaging.
- Build the integrated `0.9.0-beta.2` app, ZIP, DMG, blockmap, and `beta-mac.yml` without direct publication.
- If signing/notarization credentials are unavailable or fail authentication, stop that path and classify it as external. Do not print credentials or modify credential configuration.
- An unsigned/local package may prove local package structure and runtime, but not signed, notarized, Gatekeeper, or distribution claims.

### Task 6.2: Run local package gates

```bash
bun run gate:packaged:macos:native
bun run qa:packaged:macos:update-metadata
bun run gate:size
bun run gate:release:licenses
bun run gate:cold-start
```

When a newly signed and notarized exact artifact is legitimately available:

```bash
bun run gate:release:macos:trust
```

Do not reuse an old `beta.1` trust receipt for `beta.2`.

### Task 6.3: Run the strongest available packaged journeys

Using isolated profiles and current receipts:

- packaged smoke and onboarding;
- local Whisper transcription and latency when the model exists;
- toggle, hold-to-talk, and hands-free Dictation where physical input permits;
- representative native, browser, Electron, and editor insertion/read-back;
- microphone, system audio, and combined Meetings where permissions and hardware permit;
- Stop, duplicate Stop, Cancel, interruption, relaunch, and sidecar recovery;
- transcript, notes, summary, action items, follow-up, export, retention, deletion, backup, and restore;
- support-bundle preview/redaction;
- idle CPU and bounded soak where the host can remain uncontaminated.

### Task 6.4: Run the repaired aggregate audit

```bash
bun run qa:source-gates
bun run qa:packaged:macos:meeting:lifecycle -- --qa-dir artifacts/qa/macos
bun run qa:packaged:macos:release-audit -- --qa-dir artifacts/qa/macos
```

Acceptance:

- Every supported row points to the canonical receipt and exact candidate identity.
- Missing external or real-device evidence remains missing/blocked, not passing.
- No row is contradicted due to repository path or filename drift.

### Task 6.5: Record exact local evidence safely

Record locally:

- source revision;
- clean/dirty status at build time;
- package version;
- app, ZIP, DMG, blockmap, and manifest hashes/sizes;
- package/native/signing/trust results;
- runtime and rendered checks;
- external or permission blockers.

Do not commit package binaries, raw audio, transcripts, secrets, unsanitized logs, or ignored receipts. Commit only a sanitized truthful summary if it adds durable release value.

## Phase 7: Final Review, Documentation, and Local Merge

### Task 7.1: Reconcile all release-facing documentation

Review:

- `README.md`
- `nautilus-bot/README.md`
- `nautilus-bot/CHANGELOG.md`
- `LAUNCH.md`
- `nautilus-bot/docs/beta/`
- `nautilus-bot/docs/homebrew.md`
- `nautilus-bot/docs/security/DEPENDENCY_AUDIT.md`
- signing, updater, and setup documentation

Every claim must identify the current layer: implemented, source-tested, locally observed, packaged, signed/notarized, externally served, or distributed. Remove stale artifact hashes and completion statements that refer to another revision unless clearly labeled historical.

### Task 7.2: Run independent final reviews

Use read-only review lanes over the complete finish-branch diff:

- correctness and edge cases;
- security and privacy;
- tests, evidence, and observability;
- performance and resource risk;
- UI, accessibility, and copy.

Collect all reviews before editing. Fix validated findings centrally, rerun affected checks, and record rejected speculative findings with evidence.

### Task 7.3: Run the final finish-branch gate

From the exact finish head:

```bash
bun install --frozen-lockfile
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
bun run gate:release:dependencies
git diff --check
```

Repeat applicable package/runtime checks whenever a relevant source revision changes after package evidence was collected.

### Task 7.4: Create the final finish checkpoint

Before committing, inspect in parallel:

```bash
git status
git diff
git log --oneline -12
```

Review for secrets, generated artifacts, accidental personal data, unrelated changes, and correct commit style. Create a local commit with the required Devin attribution. Do not push.

### Task 7.5: Merge into local `main`

- Reconfirm `main` still points at the pinned baseline and has no unrelated changes.
- Merge `finish/plainsong` into local `main` with an explicit non-fast-forward merge commit and required attribution.
- Do not delete the finish branch.
- Do not push, tag, release, or alter visibility.

### Task 7.6: Verify merged `main`

Run on the exact merge commit:

```bash
git status --short --branch
git log --oneline --decorate -n 12
bun install --frozen-lockfile
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
bun run gate:release:dependencies
```

Re-run package checks only if the merge tree differs from the verified finish head beyond merge metadata. Confirm every unique branch change is integrated or has a recorded evidence-based exclusion.

## Completion Gates

### Required local gates

- [ ] Every current branch is evaluated.
- [ ] Dual-pillar candidate is adopted as one coherent cross-layer change.
- [ ] QA receipt producers and aggregators share one tested contract.
- [ ] Latency evidence is reproducible and honestly classified.
- [ ] Candidate documentation overclaims are corrected.
- [ ] Release workflow includes declared license and cold-start gates.
- [ ] Meeting Stop errors are visible and recoverable.
- [ ] Renderer and Electron Meeting identity policies agree.
- [ ] Capture admission has event-boundary tests and packaged observation.
- [ ] Reviewed Rust coordination/filesystem findings are resolved or disproved with tests.
- [ ] GitHub Actions dependency update is integrated or excluded with evidence.
- [ ] Cargo dependency update is integrated or excluded with evidence.
- [ ] Bun dependency update is integrated or excluded with evidence.
- [ ] Full TypeScript, Vitest, Rust format/Clippy/tests, IPC, dead-code, build, dependency, and whitespace gates pass.
- [ ] Real rendered UI is inspected in both themes and key states.
- [ ] Strongest available package and real-device checks are bound to the exact revision.
- [ ] Documentation matches current evidence.
- [ ] Local checkpoint commits exist.
- [ ] Verified finish branch is merged into local `main`.
- [ ] Merged `main` passes its final gates and is clean.

### External or separately authorized gates

These do not become passing claims during this plan unless separately authorized and directly verified:

- GitHub Actions account/billing runner availability;
- Developer ID credential availability and authentication;
- Apple notarization and stapling of the exact integrated artifact;
- Gatekeeper acceptance on a quarantined clean external Mac;
- public update-host provisioning and unauthenticated live feed;
- signed `beta.1` to `beta.2` installed updater journey through that live feed;
- public tag, draft or published release, repository visibility change, or tester distribution;
- hardware/permission-dependent rows that cannot be safely exercised on the current Mac.

## Stop and Recovery Rules

- If the worktree contains new user-owned changes, stop and classify ownership before editing.
- If a branch or remote moved, re-pin inputs and reassess the plan before merging.
- If a dependency update breaks behavior, revert that bounded update rather than weakening tests or security controls.
- If a package gate fails, fix it and rebuild; do not reuse evidence from the superseded artifact.
- If credentials or account state block a gate, ask the user rather than changing configuration.
- If a destructive cleanup appears necessary, describe the exact operation and wait for confirmation.
- If final merged `main` differs functionally from the verified finish head or fails any gate, keep the work local and repair it before any completion claim.

## Final Handoff

The final report will include:

- exact local `main` revision and branch state;
- all changed and intentionally excluded branch work;
- checkpoint and merge commits;
- files changed by tranche;
- commands run and exact results;
- rendered/runtime observations;
- package/artifact identity and applicable trust status;
- current capability boundary;
- external blockers and smallest next authorized action;
- explicit confirmation that nothing was pushed, published, deployed, distributed, or made public.
