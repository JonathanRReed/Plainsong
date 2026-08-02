# Plainsong Product Completion Implementation Plan

Design:
`docs/superpowers/specs/2026-07-29-plainsong-product-completion-design.md`

## Execution Rules

- Work from the outer repository root and run app commands from
  `nautilus-bot/`.
- Use Bun for JavaScript and TypeScript package commands.
- Use `apply_patch` for source and documentation edits.
- Add no production dependency without approval.
- Preserve all concurrent user work.
- Do not stage, commit, push, tag, publish, change repository visibility,
  deploy, or mutate production settings without explicit authorization.
- Never print, log, or write Apple or provider credentials.
- Do not call a gate complete until its evidence covers the exact packaged
  artifact and requested behavior.

## Phase 0: Reconcile The Live Baseline

### Task 0.1: Inventory concurrent work without changing it

Files:

- Read all tracked and untracked changes.
- Do not modify any file whose ownership is unresolved.

Steps:

1. Run:

   ```sh
   git status --short --branch
   git diff --stat
   git diff --name-only
   git log --oneline --decorate -n 12
   ```

2. Record the source revision and modification times.
3. Inspect every concurrent diff and classify it as:
   - product change;
   - security hardening;
   - test-only change;
   - generated output;
   - unrelated work.
4. Check for active processes or agents writing the same files.
5. Wait for the set of modified files to stabilize before running broad
   formatting or package builds.
6. Preserve the design specification as the only change owned by this plan.

Acceptance:

- Every pre-existing change is identified.
- No pre-existing change is overwritten, formatted, staged, or reverted.
- The exact baseline revision and dirty-tree state are recorded.

### Task 0.2: Validate the concurrent Rust tranche as a separate unit

Files:

- Only the Rust files found dirty in Task 0.1.

Commands:

```sh
cargo fmt --manifest-path nautilus-bot/rust-sidecar/Cargo.toml --check
cargo clippy --locked --manifest-path nautilus-bot/rust-sidecar/Cargo.toml \
  --all-targets -- -D warnings
cargo test --locked --manifest-path nautilus-bot/rust-sidecar/Cargo.toml
```

Steps:

1. Review the changes for correctness and security impact.
2. Run the commands without auto-formatting.
3. Attribute failures to the concurrent tranche or the baseline.
4. Do not repair those files until ownership is known or their changes are
   explicitly adopted into this completion pass.

Acceptance:

- The concurrent tranche has an independent review and test result.
- Later Plainsong changes do not silently absorb or conceal its failures.

## Phase 1: Close The Known Release-Security Gap

### Task 1.1: Add a sidecar-specific entitlement policy

Files:

- Add `nautilus-bot/build-resources/entitlements.mac.sidecar.plist`
- Modify `nautilus-bot/scripts/sign-macos.mjs`
- Modify or add the focused signing-script test under
  `nautilus-bot/src/__tests__/`

Test first:

1. Add a test for `optionsForSignedFile` that passes the
   `plainsong-sidecar` path.
2. Assert the returned entitlement path is the new sidecar file.
3. Assert the shortcut and Speech helper behavior remains unchanged.
4. Run the focused test and confirm it fails before implementation.

Implementation:

1. Define a minimal sidecar entitlement file.
2. Exclude:
   - JIT;
   - unsigned executable memory;
   - disabled library validation;
   - Apple Events.
3. Include microphone or audio-input only if the packaged capture test later
   proves it is required.
4. Route `plainsong-sidecar` through the specialized signing callback.

Commands:

```sh
bun run test -- src/__tests__/macos-apple-speech-helper.test.ts
plutil -lint build-resources/entitlements.mac.sidecar.plist
```

Acceptance:

- The sidecar no longer inherits Electron runtime privileges.
- Existing helper entitlement tests continue to pass.

### Task 1.2: Make the release trust gate reject sidecar privilege drift

Files:

- Modify `nautilus-bot/scripts/verify-macos-release-trust.mjs`
- Modify `nautilus-bot/src/__tests__/macos-release-trust-script.test.ts`

Test first:

1. Extend the fake bundle fixture with a sidecar carrying each forbidden
   entitlement.
2. Assert each case exits nonzero and names the exact privilege.
3. Assert the passing fixture allows only the sidecar policy.

Implementation:

1. Parse the sidecar entitlement set independently.
2. Add a `sidecarHasNoForbiddenPrivileges` check.
3. Include the check and diagnostic entitlement list in JSON and Markdown
   reports.
4. Keep reports secret-safe.

Commands:

```sh
bun run test -- src/__tests__/macos-release-trust-script.test.ts
bun run gate:release:macos:trust
```

Expected current artifact result:

- The focused unit test passes.
- The old packaged app fails the new sidecar-entitlement check and remains
  unnotarized.

### Task 1.3: Document the hardening decision

Files:

- Add a concise hardening record under
  `nautilus-bot/docs/security/hardening/sidecar-entitlements/`

Contents:

- source revision and evidence;
- observed privilege inheritance;
- desired invariants;
- per-binary entitlement option;
- rejected process-isolation option and tradeoffs;
- validation and rollback plan.

Acceptance:

- The record distinguishes observed, inferred, and proposed claims.
- It does not claim remediation until the packaged sidecar passes validation.

## Phase 2: Make Model Claims Match Runtime Evidence

### Task 2.1: Narrow unsupported language claims

Files:

- Modify `nautilus-bot/src/lib/asr-route-catalog.ts`
- Modify relevant model metadata under
  `nautilus-bot/src/components/models/`
- Modify `nautilus-bot/src/components/models/models-screen.tsx`
- Modify related catalogue and Models tests

Test first:

1. Add a catalogue test that no promoted route displays a broad language count
   without a matching evidence classification.
2. Add a Models test for:
   - English verified;
   - multilingual capability;
   - broader language coverage not yet release-qualified.
3. Confirm current broad copy fails the tests.

Implementation:

1. Separate vendor capability from Plainsong verification.
2. Represent language evidence as:
   - `verified`;
   - `vendor_supported`;
   - `unverified`.
3. Replace the unqualified 25-language Parakeet claim with precise copy.
4. Preserve broad Whisper multilingual information where source and package
   evidence support it.

Commands:

```sh
bun run test -- src/__tests__/asr-route-catalog.test.ts \
  src/__tests__/models-screen.test.tsx
bun run typecheck
```

### Task 2.2: Turn real-model checks into explicit release evidence

Files:

- Modify the Parakeet ignored tests under
  `nautilus-bot/rust-sidecar/src/asr/`
- Modify or add packaged ASR evidence scripts under
  `nautilus-bot/scripts/`
- Modify `nautilus-bot/package.json` only for a new repository script

Steps:

1. Make missing real-model directories report `SKIPPED` with a reason, never a
   misleading pass.
2. Add explicit fixture cases for English and each language Plainsong intends
   to advertise.
3. Require qualitative transcript expectations per fixture.
4. Record model digest, fixture digest, route, transcript, p50, and p95.
5. Exclude a language from public support when its fixture fails.

Commands:

```sh
PLAINSONG_MODELS_ROOT="${HOME}/Library/Application Support/Plainsong/models" \
PLAINSONG_PARAKEET_V3_DIR="${HOME}/Library/Application Support/Plainsong/models/parakeet/parakeet-tdt-0.6b-v3" \
cargo test --locked --manifest-path rust-sidecar/Cargo.toml \
  parakeet_v3 --lib -- --ignored --nocapture

bun run qa:packaged:macos:asr-models
```

Acceptance:

- The promoted model list is backed by a real packaged transcript and timing.
- Unsupported languages are not presented as release-qualified.

### Task 2.3: Make the latency benchmark an operator-grade tool

Files:

- Modify `nautilus-bot/rust-sidecar/src/bin/benchmark-latency.rs`
- Add focused CLI parsing tests
- Update benchmark documentation

Test first:

1. Assert `--help` prints usage and exits without running a benchmark.
2. Assert invalid providers, models, run counts, and fixture paths fail with a
   concrete message.
3. Assert JSON output contains the complete measurement context.

Implementation:

1. Add help and explicit argument validation.
2. Report provider, model, fixture, fixture duration, run count, p50, p95,
   real-time factor, and transcript sample.
3. Preserve the current benchmark path and release optimization.

Commands:

```sh
bun run benchmark:latency -- --help
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
bun run benchmark:latency -- --provider parakeet \
  --model parakeet-tdt-0.6b-v3 --runs 5
```

## Phase 3: Establish One Canonical Readiness Contract

### Task 3.1: Define the shared contract and selectors

Files:

- Add `nautilus-bot/src/features/readiness/product-readiness.ts`
- Add `nautilus-bot/src/features/readiness/product-readiness.test.ts`

Types:

- `ReadinessState`
- `ReadinessCause`
- `ReadinessAction`
- `ReadinessDomain`
- `ProductReadinessSnapshot`

Test first:

1. Cover ready, degraded, needs-action, and blocked states.
2. Cover precedence when several facts are missing.
3. Assert every non-ready state has one actionable cause.
4. Assert stale evidence cannot replace newer evidence.

Implementation:

1. Normalize backend and Electron facts without re-probing.
2. Add selectors for Dictation, Meetings, Setup, Home, Models, and sidebar
   summary.
3. Keep user-facing copy near the selector that owns the state.

### Task 3.2: Make `useSetupStatus` the adapter, not a competing truth

Files:

- Modify `nautilus-bot/src/hooks/use-setup-status.ts`
- Modify `nautilus-bot/src/__tests__/setup-status.test.ts` or the nearest
  existing hook coverage

Steps:

1. Preserve existing backend queries.
2. Convert their results into `ProductReadinessSnapshot`.
3. Remove locally stronger defaults such as treating missing permission data as
   ready.
4. Expose refresh and typed repair actions.

Acceptance:

- The hook reports unknown or degraded when authoritative evidence is absent.
- It never converts an error into a ready state.

### Task 3.3: Move every surface onto canonical selectors

Files:

- Modify `nautilus-bot/src/components/views/setup-view.tsx`
- Modify `nautilus-bot/src/components/views/dashboard-view.tsx`
- Modify `nautilus-bot/src/components/views/dictation-view.tsx`
- Modify `nautilus-bot/src/components/views/recordings-view.tsx`
- Modify `nautilus-bot/src/components/views/settings-view-simple.tsx`
- Modify `nautilus-bot/src/components/models/models-screen.tsx`
- Modify `nautilus-bot/src/components/sidebar.tsx`
- Modify focused tests for each surface

Test first:

1. Feed the same snapshot into all surfaces.
2. Assert they agree on ready, degraded, and blocked state.
3. Assert each surface exposes the same repair destination for the same cause.

Implementation:

1. Replace duplicated readiness calculations with selectors.
2. Keep surface-specific presentation only.
3. Remove obsolete readiness types and copy after all call sites migrate.

Commands:

```sh
bun run test -- src/__tests__/setup-view.test.tsx \
  src/__tests__/dashboard-view.test.tsx \
  src/__tests__/dictation-view.test.tsx \
  src/__tests__/settings-view-simple.test.tsx \
  src/__tests__/models-screen.test.tsx
bun run typecheck
```

Acceptance:

- Identical evidence produces identical state throughout the app.
- No surface reports ready while Setup reports blocked.

## Phase 4: Make Dictation Delivery Recoverable And Mode-Consistent

### Task 4.1: Formalize the renderer dictation lifecycle

Files:

- Modify `nautilus-bot/src/features/dictation/runtime.ts`
- Modify `nautilus-bot/src/hooks/use-recording.tsx`
- Modify relevant dictation runtime tests

Test first:

1. Cover the full lifecycle from preparing through completion.
2. Assert stale session events are ignored.
3. Assert stop and abort are idempotent.
4. Assert helper termination resolves the session to a recoverable error.

Implementation:

1. Add explicit lifecycle states and transition guards.
2. Carry the monotonic session identifier through every state event.
3. Keep overlay state derived from the same lifecycle.

### Task 4.2: Persist recognized text before delivery

Files:

- Modify the narrow dictation result path in
  `nautilus-bot/rust-sidecar/src/lib.rs` only after concurrent ownership is
  resolved
- Modify `nautilus-bot/src/features/dictation/runtime.ts`
- Modify `nautilus-bot/src/components/views/dictation-view.tsx`
- Add focused Rust and renderer tests

Test first:

1. Simulate successful transcription and failed insertion.
2. Assert the raw and cleaned transcript remain retrievable.
3. Assert retry uses the preserved transcript without retranscribing.
4. Assert copy is always available.

Implementation:

1. Commit the result to durable history before native insertion.
2. Store insertion status and target separately from transcript content.
3. Expose Try again, Copy, and Repair insertion access.

Acceptance:

- No insertion failure can destroy recognized text.

### Task 4.3: Close toggle, hold-to-talk, and hands-free parity

Files:

- Modify only the diagnosed runtime path after reproducing the failure
- Modify Electron shortcut tests
- Modify packaged shortcut harnesses:
  - `nautilus-bot/scripts/capture-packaged-macos-dictation-hotkey.mjs`
  - related hold and hands-free scripts

Steps:

1. Reproduce each blocked packaged mode.
2. Capture shortcut registration, key transitions, session identifiers, audio
   callback count, first-sample latency, transcript, insertion result, and
   read-back.
3. Diagnose before editing.
4. Add a failing regression at the owning boundary.
5. Implement the smallest fix that restores the common lifecycle.
6. Re-run all three modes, not only the repaired mode.

Acceptance:

- Toggle, hold-to-talk, and hands-free each complete a real insert and read-back.
- No mode leaves a capture stream, monitor, or overlay active.

### Task 4.4: Close the host-class insertion matrix

Files:

- Modify `nautilus-bot/docs/dictation-app-compatibility-matrix.md`
- Modify `nautilus-bot/docs/dictation-blocked-app-register.md`
- Modify packaged app-matrix scripts only when evidence collection needs repair

Host classes:

- native AppKit text;
- rich native editor;
- browser input;
- browser contenteditable;
- Electron editor;
- IDE or code editor.

Steps:

1. Resolve the exact installed target application for each row.
2. Insert a unique token.
3. Read the target back independently.
4. Restore the target content.
5. Record pass, product failure, permission block, or environment block.
6. Fix product failures at the narrowest insertion boundary.

Acceptance:

- Every supported host class has current packaged evidence.
- Unsupported hosts are named and fail safely.

## Phase 5: Simplify First Run And Daily Work

### Task 5.1: Reduce onboarding to first successful dictation

Files:

- Modify `nautilus-bot/src/components/first-run-wizard.tsx`
- Modify `nautilus-bot/src/__tests__/first-run-wizard.test.tsx`

Test first:

1. Cover local model download and microphone permission.
2. Cover a built-in scratch dictation success.
3. Cover real external insertion verification.
4. Cover permission denial and recovery.
5. Assert meeting setup is optional and follows dictation success.

Implementation:

1. Use three stages: Try dictation here, Use it everywhere, Ready.
2. Request one permission at a time.
3. Keep advanced providers and model catalogues out of first run.
4. Do not mark onboarding complete until the selected completion policy is
   satisfied.

### Task 5.2: Distill Home and Setup

Files:

- Modify `nautilus-bot/src/components/views/dashboard-view.tsx`
- Modify `nautilus-bot/src/components/views/setup-view.tsx`
- Modify their tests

Implementation:

1. Make Dictate and Record a meeting the primary Home actions.
2. Show only the most important recovery action.
3. Demote decorative metrics.
4. Show active blockers first in Setup.
5. Collapse passed checks into a quiet summary.
6. Preserve direct diagnostics access.

### Task 5.3: Distill Dictation and Models

Files:

- Modify `nautilus-bot/src/components/views/dictation-view.tsx`
- Modify `nautilus-bot/src/components/models/models-screen.tsx`
- Modify their tests

Implementation:

1. Preserve the dictation capture hero.
2. Keep latest result and recovery immediately below it.
3. Move profiles, snippets, dictionary, formatting, and diagnostics into clear
   progressive sections.
4. Present presets and four active lanes before the model catalogue.
5. Add the verified language wording from Phase 2.
6. Add Measure on this Mac only if the existing benchmark can be invoked safely
   from the packaged app without blocking the renderer.

### Task 5.4: Keep Meetings capture-first

Files:

- Modify `nautilus-bot/src/components/views/recordings-view.tsx`
- Modify `nautilus-bot/src/components/recording-overlay.tsx`
- Modify meeting and overlay tests

Implementation:

1. Lead the empty state with source, consent, and capture.
2. Reveal notes, summaries, actions, questions, export, and retention after a
   recording exists.
3. Make current capture and processing state unmistakable.
4. Preserve the existing recovery paths.

### Task 5.5: Verify the rendered UX continuously

Procedure:

1. Build and run the current app.
2. Inspect dark and light themes.
3. Test minimum window size and common desktop size.
4. Verify happy, loading, empty, degraded, and error states.
5. Capture screenshots only from real rendered state.
6. Check for console errors after every navigation and action.

Acceptance:

- The primary flow feels faster because fewer decisions are required.
- No functionality is hidden without a clear discovery path.

## Phase 6: Accessibility, Resilience, And Resource Gates

### Task 6.1: Accessibility audit and repair

Files:

- Modify only affected components and shared controls.
- Add accessibility tests near each affected surface.

Checks:

- full keyboard traversal;
- focus visibility;
- focus return after dialogs and popovers;
- accessible names for icon controls;
- VoiceOver reading order;
- status announcements;
- reduced motion;
- forced colors;
- 14 px minimum explanatory copy;
- contrast in both themes;
- long labels and localization stress.

Commands:

```sh
bun run test
bun run typecheck
```

Runtime proof:

- keyboard-only walkthrough;
- VoiceOver walkthrough of first run, Dictation, Meetings, and recovery;
- reduced-motion launch and active capture.

### Task 6.2: Reliability and resource regression

Files:

- Modify existing QA scripts only when they cannot collect required evidence.

Checks:

- cold start;
- idle CPU;
- idle memory;
- repeated dictation soak;
- meeting soak;
- sidecar restart;
- helper termination;
- interrupted model download;
- interrupted recording recovery;
- sleep and wake;
- app quit and relaunch;
- backup and restore;
- retention maintenance.

Acceptance:

- No product lifecycle leaves orphan processes, stale overlays, or lost user
  content.

## Phase 7: Full Source And Security Verification

### Task 7.1: Run the complete source gate

Commands:

```sh
bun run lint
bun run test
bun run test:rust
bun run build:renderer
bun run build:electron
bun run gate:ipc-contract
bun run gate:dead-code
git diff --check
```

Steps:

1. Run from a stable worktree.
2. Investigate every failure.
3. Do not waive failures caused by owned code.
4. Record environment-only failures separately.

### Task 7.2: Run current-revision security validation

Scope:

- Electron renderer and preload boundary;
- IPC allowlist and argument handling;
- provider secrets;
- encrypted storage and temporary plaintext;
- exports and CSV handling;
- model downloads and integrity;
- updater trust;
- native helper entitlements;
- destructive data operations.

Steps:

1. Run Codex Security against the current working diff and full relevant
   boundaries.
2. Triage findings against source and runtime evidence.
3. Fix validated findings.
4. Re-run the original finding path.
5. Preserve a source revision and validation receipt.

Acceptance:

- No validated high or medium launch finding remains.
- Lower-severity residual risks are explicit and proportionate.

## Phase 8: Build And Verify The Exact Release

### Task 8.1: Re-establish a release-owned source state

Steps:

1. Confirm every tracked change belongs to the completed release.
2. Confirm no generated release artifact is tracked accidentally.
3. Confirm the exact revision and clean-tree state.
4. Run Phase 7 again immediately before packaging.

Do not stage or commit without explicit user authorization.

### Task 8.2: Build fresh arm64 artifacts

Generated outputs:

- `nautilus-bot/release/mac-arm64/Plainsong.app`
- `nautilus-bot/release/Plainsong-1.0.0-arm64.dmg`
- `nautilus-bot/release/Plainsong-1.0.0-arm64-mac.zip`
- ZIP blockmap;
- `latest-mac.yml`.

Commands:

```sh
bun run release:mac
bun run qa:packaged:macos:update-metadata
bun run gate:size
```

Acceptance:

- Artifacts come from the recorded source state.
- App, ZIP, DMG, blockmap, and manifest versions agree.

### Task 8.3: Run non-interactive package gates

Checks:

- bundle structure;
- main and nested architectures;
- bundle identifier and version;
- TCC strings;
- deep signatures;
- team identity;
- hardened runtime;
- secure timestamps;
- specialized entitlements;
- Electron fuses;
- sidecar and helper smoke;
- update metadata;
- size and cold start.

Expected before notarization:

- all source-controlled checks pass;
- notarization, stapling, and Gatekeeper remain pending.

### Task 8.4: Run real packaged product QA

Run the Phase 4, Phase 5, and Phase 6 runtime proof against the fresh package,
not the development build.

Acceptance:

- Every claimed flow has exact-package evidence.
- Screenshots and receipts name the package revision and timestamp.

## Phase 9: Apple Credential And Distribution Gates

### Task 9.1: Create the Plainsong Keychain profile

Profile:

```text
plainsong-notary
```

User-present action:

1. Generate or select the Plainsong app-specific Apple password.
2. Run:

   ```sh
   xcrun notarytool store-credentials "plainsong-notary"
   ```

3. Hand keyboard control to the user for Apple ID, team `AJ9VWBRNZN`, and
   password entry.
4. Do not echo, log, transcribe, or save the password outside Keychain.
5. Validate:

   ```sh
   xcrun notarytool history --keychain-profile "plainsong-notary"
   ```

Acceptance:

- The new profile authenticates.
- Inkling and Waves profiles are unchanged.
- Documentation records only the profile name and recovery instructions.

### Task 9.2: Build the notarized application and update ZIP

Environment:

```sh
APPLE_KEYCHAIN=login.keychain
APPLE_KEYCHAIN_PROFILE=plainsong-notary
APPLE_TEAM_ID=AJ9VWBRNZN
```

Steps:

1. Run the release credential preflight.
2. Build with publishing disabled.
3. Require Electron Builder notarization success.
4. Validate the application ticket and Gatekeeper.
5. Verify the ZIP contains the stapled application.
6. Reconcile ZIP update metadata after final bytes are stable.

Commands:

```sh
bun run gate:release-credentials:preflight
xcrun stapler validate "release/mac-arm64/Plainsong.app"
spctl -a -vv "release/mac-arm64/Plainsong.app"
```

Acceptance:

- The exact application is Apple accepted and stapled.
- Gatekeeper reports `source=Notarized Developer ID`.

### Task 9.3: Notarize and staple the signed DMG

Steps:

1. Submit the exact DMG:

   ```sh
   xcrun notarytool submit "release/Plainsong-1.0.0-arm64.dmg" \
     --keychain-profile "plainsong-notary" \
     --wait
   ```

2. Require `status: Accepted`.
3. Fetch the log for any rejection and fix the product or package rather than
   resubmitting unchanged.
4. Staple and validate:

   ```sh
   xcrun stapler staple "release/Plainsong-1.0.0-arm64.dmg"
   xcrun stapler validate "release/Plainsong-1.0.0-arm64.dmg"
   spctl -a -t open --context context:primary-signature -vv \
     "release/Plainsong-1.0.0-arm64.dmg"
   ```

Acceptance:

- The exact DMG is Apple accepted, stapled, and Gatekeeper approved.

### Task 9.4: Run the final release trust gate

Command:

```sh
APPLE_TEAM_ID=AJ9VWBRNZN bun run gate:release:macos:trust
```

Acceptance:

- Every app, ZIP, DMG, signature, entitlement, fuse, architecture, team,
  stapler, Gatekeeper, and metadata check passes.

## Phase 10: Clean Install And Updater Proof

### Task 10.1: Clean-install acceptance

Target:

- A fresh macOS user or a separate clean machine.

Steps:

1. Transfer or download the exact notarized DMG.
2. Confirm quarantine and Gatekeeper behavior.
3. Install to `/Applications`.
4. Complete first run.
5. Exercise real permissions, model download, dictation, insertion, meetings,
   relaunch, and retained settings.
6. Capture results without including private transcript content.

Acceptance:

- The clean install needs no undocumented workaround.

### Task 10.2: Signed N-to-N+1 updater acceptance

Steps:

1. Prepare two signed and notarized versions with compatible update metadata.
2. Install version N.
3. Point it at a controlled release feed that matches production format.
4. Detect, download, verify, install, and relaunch into N+1.
5. Confirm bundle version changed.
6. Confirm settings, history, recordings, models, and security state survived.
7. Exercise rollback or failed-update recovery.

Publication boundary:

- Use a local or draft-controlled feed unless the user explicitly authorizes a
  public GitHub release.

Acceptance:

- Updater proof covers installation, not metadata alone.

## Phase 11: Launch Truth, Website, And Final Receipt

### Task 11.1: Update canonical release documentation

Files:

- Modify `LAUNCH.md`
- Modify `README.md`
- Modify `nautilus-bot/README.md`
- Modify `nautilus-bot/docs/CODE_SIGNING.md`
- Modify `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md`
- Modify `nautilus-bot/docs/qa/feature-user-stories.csv`
- Update launch checklist and compatibility matrix

Steps:

1. Replace stale counts and package claims.
2. Record exact source revision and artifact hashes.
3. Record Apple accepted status, submission identifiers, stapler, and
   Gatekeeper results.
4. Record clean-install and updater evidence.
5. Separate GitHub account state and publication decisions from product
   correctness.

### Task 11.2: Prepare the website locally

Repository:

- `/Users/jonathanreed/Downloads/NautilusBot-site`

Steps:

1. Inspect its branch, dirty state, instructions, and hosting configuration.
2. Replace planned-release copy with exact verified macOS support.
3. Use authentic packaged-app images.
4. Link only to repository and release destinations that actually exist.
5. Run Bun lint, typecheck, tests, and build.
6. Do not deploy without explicit authorization.

### Task 11.3: Produce the immutable release receipt

Receipt contains:

- source revision and clean-tree state;
- build timestamp;
- app, ZIP, DMG, blockmap, and manifest hashes;
- version and bundle metadata;
- signature and entitlement inventory;
- Apple submission identifiers and accepted status;
- stapler and Gatekeeper output;
- source, package, real-device, accessibility, security, clean-install, and
  updater evidence;
- explicit external publication or account blockers.

### Task 11.4: Final completion audit

Audit every acceptance criterion in the design against:

- current source;
- current package;
- current runtime;
- current Apple state;
- current updater state;
- current launch documentation.

Classify each as:

- proved;
- contradicted;
- incomplete;
- indirect;
- missing.

Continue implementation for every repository-controlled incomplete item.

The goal may be marked complete only when every required item is proved and no
required work remains.

## Final Verification Command Set

```sh
bun run lint
bun run test
bun run test:rust
bun run build:renderer
bun run build:electron
bun run gate:ipc-contract
bun run gate:dead-code
bun run release:mac
bun run qa:packaged:macos:update-metadata
bun run gate:size
APPLE_TEAM_ID=AJ9VWBRNZN bun run gate:release:macos:trust
git diff --check
```

Additional required proof:

- rendered first-run and daily UX;
- toggle, hold, and hands-free insertion;
- host-class matrix;
- mic and system-audio meetings;
- security revalidation;
- accessibility walkthrough;
- clean install;
- N-to-N+1 updater;
- Apple accepted, stapled, Gatekeeper-approved app and DMG;
- final release receipt.
