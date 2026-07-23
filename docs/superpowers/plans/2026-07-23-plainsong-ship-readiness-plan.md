# Plainsong Ship-Readiness Implementation Plan

Design: `docs/superpowers/specs/2026-07-23-plainsong-ship-readiness-design.md`

## Phase 1: Repair package verification with regression coverage

### Task 1.1: Pin the masked-error failure

Files:

- Add `nautilus-bot/src/__tests__/packaged-update-metadata-script.test.ts`
- Modify `nautilus-bot/scripts/verify-packaged-macos-update-metadata.mjs`

Steps:

1. Add an integration-style Vitest test that invokes the script against a missing packaged app with temporary JSON and Markdown output paths.
2. Assert the process exits non-zero.
3. Assert both artifacts are written.
4. Assert the original missing `app-update.yml` error is preserved.
5. Run the focused test and confirm it fails against the current secondary `TypeError`.
6. Make Markdown rendering tolerate incomplete failure artifacts.
7. Re-run the focused test and confirm it passes.

### Task 1.2: Align CI with the metadata it verifies

Files:

- Modify `.github/workflows/ci.yml`

Steps:

1. Replace the unpacked `electron:pack` package step with the macOS ZIP build using `--publish never`.
2. Replace `--pack-only` metadata verification with the full packaged metadata gate.
3. Keep native-binary and TCC assertions after metadata verification.
4. Validate workflow syntax locally.

## Phase 2: Make official releases fail closed and notarization-ready

### Task 2.1: Enable explicit notarization

Files:

- Modify `nautilus-bot/electron-builder.yml`

Steps:

1. Add `mac.notarize: true`.
2. Preserve hardened runtime and the existing entitlement files.
3. Confirm the installed electron-builder configuration accepts the resulting schema.

### Task 2.2: Gate official releases on complete credentials

Files:

- Modify `.github/workflows/release.yml`
- Modify `nautilus-bot/scripts/release-credentials-preflight.mjs` only if testability or reporting needs adjustment
- Add `nautilus-bot/src/__tests__/release-credentials-preflight.test.ts` if the preflight changes

Steps:

1. Remove the workflow's unsigned-release fallback language and behavior.
2. Run the secret-safe credential preflight before the official release build.
3. Pass only secret-presence capability into logs, never secret values.
4. Keep local non-release packaging available without credentials.
5. After electron-builder creates the draft assets, verify:
   - update metadata
   - deep signature validity
   - hardened runtime
   - stapled notarization ticket
   - Gatekeeper acceptance
6. Ensure any verification failure leaves the release unpublished as a draft.
7. Validate workflow syntax locally.

## Phase 3: Rebuild and collect non-interactive package evidence

Files:

- Generated ignored outputs under `nautilus-bot/release/`
- Generated ignored outputs under `nautilus-bot/artifacts/qa/macos/`

Steps:

1. Build a fresh macOS ZIP with publishing disabled.
2. Run update-metadata and size gates.
3. Verify app structure, version, bundle identifier, native binary architectures, TCC strings, entitlements, hardened runtime, and deep signature.
4. Run the packaged sidecar smoke harness.
5. Run other package checks that do not open permission dialogs.
6. Record source commit and generation time with the evidence.
7. Treat expected failures caused only by missing notarization or permission grants as blocked launch-day gates, not product defects.

## Phase 4: Verify the rendered packaged application

Files:

- Add authentic product images under a stable repository asset directory
- Modify `README.md`

Steps:

1. Launch the packaged app with an isolated test data directory when supported.
2. Stop any flow that asks for Microphone, Accessibility, Speech Recognition, or system-audio permission.
3. Verify the first-run shell and returning-user shell.
4. Verify navigation, loading, empty, and recoverable error states for Dictation, Meetings, Projects, Exports, Setup, and Settings.
5. Capture authentic screenshots from the running app.
6. Replace the README image placeholders with the strongest accurate captures and useful alt text.

## Phase 5: Update canonical release truth

Files:

- Modify `nautilus-bot/docs/qa/feature-user-stories.csv`
- Modify `LAUNCH.md`
- Modify `README.md`
- Modify `nautilus-bot/README.md`
- Modify `nautilus-bot/docs/CODE_SIGNING.md`
- Modify `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md`
- Add or update one launch-day checklist under `nautilus-bot/docs/`

Steps:

1. Update US-058 with current package evidence and remaining permission/notarization gates.
2. Remove stale test counts and claims that package artifacts are absent.
3. Separate GitHub billing state from code and CI correctness.
4. Document exact credential names, notarization build command, stapling, Gatekeeper, checksum, draft-release, and updater checks.
5. Order the final human actions by dependency:
   - restore GitHub Actions capacity
   - configure secrets
   - run permissioned device validation
   - trigger signed/notarized draft release
   - inspect artifacts and updater metadata
   - make the repository public
   - publish the draft
   - deploy the website
   - submit Homebrew follow-up

## Phase 6: Prepare the website locally

Repository:

- `/Users/jonathanreed/Downloads/NautilusBot-site`

Steps:

1. Inspect its worktree, project instructions, and current deployment configuration before editing.
2. Replace preview and Windows launch claims with the v1 macOS Apple Silicon position.
3. Add accurate GitHub repository and Releases links, preserving the fact that downloads remain unavailable until publication.
4. Reuse authentic product imagery from the packaged-app QA pass.
5. Run the site's Bun-based lint, typecheck, tests, and build.
6. Do not deploy.

## Phase 7: Final verification and handoff

Commands:

- `bun run lint`
- `bun run test`
- `bun run test:rust`
- `bun run build:renderer`
- `bun run build:electron`
- `bun run gate:ipc-contract`
- `bun run gate:dead-code`
- `bun run electron:build:mac`
- `bun run qa:packaged:macos:update-metadata`
- `bun run gate:size`
- `git diff --check`

Additional checks:

- inspect both worktree diffs
- verify no secrets or generated release artifacts are tracked
- verify no release, tag, visibility, or deployment mutation occurred
- review the implementation for unnecessary complexity
- report exact passed, blocked, and externally gated results

## Change Control

- Use `apply_patch` for edits.
- Use Bun for package commands.
- Add no production dependencies.
- Do not commit, push, tag, notarize, publish, change repository visibility, deploy, or submit Homebrew.
