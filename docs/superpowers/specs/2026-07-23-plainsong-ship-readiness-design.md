# Plainsong Ship-Readiness Design

Date: 2026-07-23

## Objective

Bring the current Plainsong checkout to a repository-controlled launch-candidate state. At completion, every change, check, artifact, and instruction that can be prepared locally will be ready for the notarization and public-launch sequence.

The remaining handoff must be limited to credentials, permissioned hardware validation, GitHub account state, and deliberate production publication actions.

## Current Baseline

- The Git worktree is clean on `main` and matches `origin/main`.
- TypeScript checks, Rust formatting, Rust Clippy, the renderer build, 327 Vitest tests, and 367 Rust tests pass. One real-model Silero VAD test is intentionally ignored because its model is not installed.
- IPC contract, dead-code hygiene, packaged-app size, and update-metadata checks pass locally.
- `release/mac-arm64/Plainsong.app` exists, is within the 450 MB size cap, and carries a valid Developer ID Application signature.
- Gatekeeper rejects the current app because it is not notarized and has no stapled ticket.
- The canonical feature tracker still describes the packaged app and QA evidence as absent, so it is stale.
- The CI package job builds an unpacked `--dir` target while expecting update metadata associated with a distributable macOS target. Its failure reporter can throw a secondary error and hide the original cause.
- GitHub Actions is currently unable to start new jobs because of account billing or spending-limit state.
- The GitHub repository is private, has no published release, and the live website still presents preview and Windows claims that do not match the macOS arm64 v1 release.

## Scope

### 1. CI and packaging closure

- Change the macOS package-verification job to build a ZIP target with publishing disabled.
- Run the full packaged update-metadata verifier against the ZIP, blockmap, `latest-mac.yml`, and packaged `app-update.yml`.
- Make the verifier's failure artifact and Markdown report safe for partially constructed results, preserving the original exception.
- Add a regression test that invokes the verifier with a missing package and proves the original failure is reported without a secondary exception.
- Verify the packaged sidecar, native shortcut helper, bundle architecture, bundle identifier, TCC usage strings, hardened runtime, signature integrity, size gate, and update-channel agreement.

### 2. Notarization readiness

- Reconcile `electron-builder.yml`, the release workflow, credential preflight, and signing documentation against the installed electron-builder version and current notarization behavior.
- Make the official tag or manual release workflow fail closed when required certificate or Apple notarization inputs are missing. Local developer packaging may remain unsigned when it is explicitly identified as non-release output.
- Keep credential checks secret-safe. Record only input presence, identity counts, and pass or fail state.
- Add an explicit pre-notarization command sequence and a post-notarization verification sequence for:
  - Developer ID signature verification
  - hardened runtime and entitlement inspection
  - notarization submission result
  - stapled ticket validation
  - Gatekeeper assessment
  - ZIP and DMG checksum and update-manifest agreement
- Do not submit to Apple during this pass.

### 3. Canonical launch truth

- Update `docs/qa/feature-user-stories.csv` so US-058 reflects the package and evidence that now exist, the checks that pass, and the permissioned or notarization checks that remain blocked.
- Update `LAUNCH.md`, signing documentation, and relevant README sections to describe the current launch state without stale test counts or unsupported readiness claims.
- Record the GitHub Actions billing or spending-limit blocker separately from code quality.
- Produce one ordered launch-day checklist covering credentials, CI recovery, notarization, real-device validation, repository visibility, tag creation, draft review, release publication, website deployment, and Homebrew follow-up.

### 4. Packaged application QA

Use an isolated application-data directory where the existing harness supports it.

- Run non-interactive packaged checks first.
- Launch the packaged app and verify that it reaches a usable window without a sidecar startup failure.
- Verify the principal non-permission flows: first-run rendering, navigation, Dictation, Meetings, Projects, Exports, Setup, Settings, loading states, and recoverable error states.
- Do not grant Microphone, Accessibility, Speech Recognition, or system-audio permissions.
- If macOS presents a permission prompt, stop that flow and record it as a launch-day gate.
- Capture authentic screenshots only from the running product. Do not simulate product state or use unsupported claims.

### 5. Launch assets and website handoff

- Replace the root README launch-image placeholders with authentic product imagery produced by the packaged-app QA pass.
- Locate the local website source. If available, prepare a local-only patch that changes preview and Windows claims to the v1 macOS Apple Silicon launch position, adds accurate repository and release links, and uses the new product imagery.
- If the website source cannot be accessed, record the verified live drift and produce exact replacement copy, links, and asset paths as the launch handoff.
- Do not deploy the website.
- Do not make the repository public, create or push a release tag, publish a GitHub release, or submit a Homebrew cask.

## Architecture and Data Flow

The repository remains the source of truth.

1. Source and workflow configuration produce a macOS arm64 distributable.
2. The distributable produces the app bundle, ZIP, blockmap, and update manifest.
3. Verification scripts inspect those outputs and write ignored local QA artifacts.
4. The canonical CSV and launch checklist summarize only verified evidence.
5. The launch-day checklist consumes that evidence and identifies the remaining user-authorized steps.

Generated release and QA artifacts remain ignored. Documentation must name the source commit and generation time when referring to a local package so later rebuilds cannot silently inherit stale proof.

## Error Handling

- Verification scripts must emit a readable failure artifact even when input files are absent or malformed.
- CI must retain the first meaningful failure instead of masking it with report-generation errors.
- Release workflows must distinguish:
  - source or build failure
  - missing credential capability
  - signing failure
  - notarization failure
  - Gatekeeper failure
  - publication failure
- Permission-sensitive QA must be marked blocked when permission is unavailable. It must never be converted to a pass based on source inspection.
- A signed but unnotarized app must never be described as publicly distributable.

## Verification Strategy

### Automated source checks

- `bun run lint`
- `bun run test`
- `bun run test:rust`
- `bun run build:renderer`
- `bun run build:electron`
- `bun run gate:ipc-contract`
- `bun run gate:dead-code`
- `git diff --check`

### Automated package checks

- Fresh macOS ZIP build with `--publish never`
- Packaged update-metadata verification
- Native binary presence and arm64 architecture
- TCC usage strings
- Bundle identifier and version
- Deep code-signature verification
- Hardened runtime and entitlement inspection
- Size gate
- Packaged sidecar smoke test

### Rendered application checks

- Window launch
- first-run and returning-user states
- navigation among all primary views
- loading and empty states
- recoverable renderer error state
- non-permission setup and settings flows
- screenshots from real rendered state

### Deferred launch-day checks

- notarization submission and stapling
- Gatekeeper acceptance of the notarized artifact
- clean-machine first-run model download
- Microphone and Accessibility permission flow
- real dictation and insertion into target apps
- meeting microphone and system-audio capture
- updater behavior against a published draft or release

## Acceptance Criteria

The pass is complete only when:

- The checkout contains no known repository-controlled source, CI, packaging, documentation, or non-permission QA blocker.
- All source and non-interactive package gates pass from a fresh build.
- The CI package workflow is logically aligned with the artifacts it verifies and has regression coverage for its prior masked-error path.
- The packaged app launches and its principal non-permission UI paths are rendered and checked.
- The canonical tracker and launch documentation match current evidence.
- Authentic README launch imagery is present.
- A launch-day checklist contains exact notarization, validation, publication, website, and Homebrew steps.
- Remaining blockers are limited to:
  - Apple or GitHub credentials
  - GitHub billing or spending-limit recovery
  - permissioned real-device validation
  - making the repository public
  - pushing the release tag
  - reviewing and publishing the draft release
  - deploying the website
  - optional Homebrew submission and legal or account actions

## Change Boundaries

- No new production dependencies.
- No destructive data changes.
- No credential changes or secret output.
- No commit, push, tag, release, repository-visibility change, notarization submission, website deployment, or Homebrew submission without explicit authorization.
- Preserve unrelated user changes if the worktree becomes dirty.
