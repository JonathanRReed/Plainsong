# Launch Completeness Implementation Plan

Date: 2026-04-09
Spec: `docs/superpowers/specs/2026-04-09-launch-completeness-design.md`
Owner: Nautilus engineering

## Objective

Execute the launch-completeness spec in strict priority order:

1. Dictation first
2. Meetings second
3. Privacy third
4. Platform release completion
5. Evidence and automation completion

The release remains blocked until all required gates are `PASS` on macOS and Windows.

## Planning Rules

- No launch-quality workstream may claim completion without packaged evidence.
- Later workstreams do not override earlier failures.
- Dictation is the primary product gate.
- Windows is a required GA platform, not a follow-up platform.
- Broken test infrastructure counts as launch debt and must be fixed before release signoff.

## Current Starting State

Known starting blockers from the repo:

- `docs/prelaunch-readiness.md` is `NO-GO`
- packaged QA matrix is fully `BLOCKED`
- dictation parity scorecard still has `BLOCKED` and `PARTIAL` gates
- release evidence still lacks signed production validation
- `bun run test` is green; bare `bun test` is not the supported repo entrypoint because it invokes Bun's native runner instead of Vitest

## Phase 0: Baseline Lock And Triage

Goal:

Freeze the launch target and convert the current repo state into a single tracked execution baseline.

Tasks:

1. Confirm the source-of-truth launch docs:
   - `docs/prelaunch-readiness.md`
   - `docs/release-gate-evidence.md`
   - `docs/competitor-parity-gates.md`
   - `docs/evals/dictation-parity-launch-scorecard.md`
   - `docs/packaged-app-qa-matrix.md`
2. Normalize commands and toolchain references to `bun` where the docs still use stale package-manager wording.
3. Capture the current `bun run test` baseline and classify failures into:
   - test harness failures
   - environment setup failures
   - actual product regressions
4. Verify current green checks:
   - `bunx tsc --noEmit -p tsconfig.json`
   - `bunx tsc --noEmit -p tsconfig.electron.json`
   - `cargo check --manifest-path rust-sidecar/Cargo.toml --bin nautilus-sidecar`
5. Freeze the launch app matrix and launch language candidate list as the only allowed public claims until expanded with evidence.

Primary files:

- `package.json`
- `README.md`
- `docs/prelaunch-readiness.md`
- `docs/release-gate-evidence.md`
- `docs/evals/dictation-parity-launch-scorecard.md`

Exit criteria:

- current blockers are categorized, not just listed
- docs no longer disagree on package manager and supported release path
- the team can point to one active launch baseline

## Phase 1: Dictation Completion

Goal:

Make Nautilus launch-grade as a dictation product on macOS and Windows.

### Workstream 1A: Automation And Harness For Dictation

Tasks:

1. Fix the Vitest environment so frontend tests can run reliably:
   - restore or replace missing `vi.hoisted`
   - restore or replace missing `vi.mocked`
   - restore or replace missing `vi.stubGlobal`
   - ensure DOM globals exist where React Testing Library expects them
2. Split test fixes into:
   - global test setup
   - test file compatibility updates
   - actual component or hook regressions
3. Re-enable green coverage for dictation-adjacent tests first:
   - popup
   - hotkey flow
   - dictation view
   - setup and onboarding where dictation paths are configured

Primary files:

- `src/__tests__/setup.ts`
- `src/__tests__/dictation-view.test.tsx`
- `src/__tests__/dictation-popup.test.tsx`
- `src/__tests__/first-run-wizard.test.tsx`
- `src/__tests__/platform-optimization-settings.test.tsx`
- `vitest` config surface if present in the repo

Exit criteria:

- dictation-related frontend tests pass under `bun run test`
- remaining failures, if any, are outside dictation-critical scope and explicitly tracked

### Workstream 1B: Packaged Dictation Start, Stop, And Overlay Trust

Tasks:

1. Validate packaged dictation hotkey on macOS and Windows 10/10 times.
2. Ensure no stuck overlay, silent stop, or invisible failure mode remains.
3. Verify state transitions are visible and correct:
   - primed
   - recording
   - stopping
   - transcribing
   - done
   - idle
4. Ensure failure states are actionable and user-facing, not backend dumps.

Primary files:

- `electron/main.ts`
- `src/components/popups/dictation-popup.tsx`
- `src/components/views/dictation-view.tsx`
- `rust-sidecar/src/lib.rs`
- `src/lib/electron.ts`
- `src/lib/backend.ts`

Exit criteria:

- `DP-01` passes
- packaged QA dictation hotkey rows pass on macOS and Windows

### Workstream 1C: Insertion Reliability In Launch App Matrix

Tasks:

1. Validate insertion behavior in:
   - Apple Notes
   - Google Docs
   - Slack
   - Notion
   - VS Code
   - Cursor
   - Messages
   - HubSpot in Chrome on macOS
   - Outlook on Windows
2. Measure success, graceful recovery, and visible fallbacks.
3. Tighten insertion mode selection and fallback messaging.
4. Track blocked apps separately instead of broadening claims.

Primary files:

- `docs/dictation-app-compatibility-matrix.md`
- `docs/dictation-blocked-app-register.md`
- `src/lib/shortcuts.ts`
- `src/hooks/use-setup-status.ts`
- `rust-sidecar/src/lib.rs`

Exit criteria:

- `DP-02` passes at `>= 98%`
- blocked apps are explicit and excluded from launch claims

### Workstream 1D: Command Mode, Snippets, Dictionary, And Formatting

Tasks:

1. Finish and benchmark command mode v1 against the locked command corpus.
2. Finish and benchmark snippets, including app-scoped snippets.
3. Verify dictionary behavior across launch apps and launch languages.
4. Verify smart formatting and correction quality with bounded false-edit rates.
5. Ensure command mode never activates accidentally without the prefix.

Primary files:

- `docs/evals/dictation-parity-fixture.json`
- `scripts/generate-dictation-benchmark.mjs`
- `scripts/verify-benchmark-gates.mjs`
- `src/components/views/dictation-view.tsx`
- `rust-sidecar/src/lib.rs`
- dictionary-related backend and frontend files

Exit criteria:

- `DP-03`, `DP-04`, `DP-05`, `DP-06`, and `DP-07` pass
- provider telemetry fields are present in benchmark artifacts

### Workstream 1E: Hands-Free, Context-Aware Styles, And Latency

Tasks:

1. Validate hands-free mode in real long-session packaged runs.
2. Limit context-aware styles to verified app contexts only.
3. Generate real benchmark artifacts for:
   - baseline
   - latest macOS
   - latest Windows
4. Pass latency trend gate with truthful provider-integrity data.

Primary files:

- `docs/evals/dictation-parity-launch-scorecard.md`
- `docs/evals/benchmark-run-baseline.json`
- `docs/evals/benchmark-run-latest-macos.json`
- `docs/evals/benchmark-run-latest-windows.json`
- `artifacts/benchmark-gates-macos.json`
- `artifacts/benchmark-gates-windows.json`

Exit criteria:

- `DP-08`, `DP-09`, `DP-11`, and `DP-12` pass
- dictation workstream is green enough to be called launch-grade

## Phase 2: Meeting Completion

Goal:

Make Nautilus launch-grade as a meeting capture and transcript product after dictation is green.

Tasks:

1. Validate mic-only and system-audio meeting capture on both platforms where supported.
2. Verify immediate `processing` state and transcript detail auto-refresh.
3. Validate long meeting soak reliability.
4. Validate consent UX and recording indicators.
5. Validate transcript save, transcript search, speaker labeling, and AI follow-up flow.

Primary files:

- `src/components/popups/recording-popup.tsx`
- `src/components/views/recordings-view.tsx`
- `src/hooks/use-recording-detail.ts`
- `src/components/ai-analysis-panel.tsx`
- `rust-sidecar/src/lib.rs`
- `docs/competitor-parity-gates.md`

Exit criteria:

- packaged meeting rows pass on both platforms
- `CP-02`, `CP-05`, and `CP-06` are `PASS`

## Phase 3: Privacy Completion

Goal:

Ensure privacy claims are precise, verified, and supported by actual shipped behavior.

Tasks:

1. Validate transcript-only storage mode and retention delete modes.
2. Validate secrets handling and local-first defaults.
3. Validate backup and restore flows.
4. Validate at least one cloud sync provider end to end.
5. Audit README and in-product wording so privacy claims do not exceed evidence.

Primary files:

- privacy and storage sections in `rust-sidecar/src/lib.rs`
- backup and restore code paths
- `src/components/views/settings-view-simple.tsx`
- `docs/prelaunch-readiness.md`
- `docs/packaged-app-qa-matrix.md`

Exit criteria:

- `CP-03`, `CP-04`, and `CP-08` pass
- privacy-related packaged QA rows pass

## Phase 4: Platform Release Completion

Goal:

Convert the app from locally packageable to production shippable on macOS and Windows.

Tasks:

1. Validate the Electron release path as the only supported path.
2. Finish macOS signing and notarization.
3. Finish Windows installer signing and validation.
4. Validate stable update flow on signed builds.
5. Ensure build scripts reflect supported cross-platform release behavior and do not hide platform gaps.

Primary files:

- `electron-builder.yml`
- `package.json`
- `scripts/build-dmg.mjs`
- `docs/CODE_SIGNING.md`
- `docs/APPLE_DEVELOPER_SETUP.md`
- platform release workflows if added to the repo

Exit criteria:

- packaged install and update rows pass on both platforms
- `CP-11` passes
- release evidence shows signed production artifacts, not just local dev identity checks

## Phase 5: Evidence And Launch Signoff Completion

Goal:

Turn the now-working product into a release candidate with truthful, complete evidence.

Tasks:

1. Move all required packaged QA rows from `BLOCKED` to `PASS`.
2. Attach benchmark artifacts and QA evidence.
3. Update:
   - `docs/prelaunch-readiness.md`
   - `docs/release-gate-evidence.md`
   - `README.md`
4. Remove stale success claims and stale blockers.
5. Run final signoff sequence:
   - engineering
   - QA
   - product or owner

Exit criteria:

- required docs show `GO`
- README matches the actual supported and verified state
- launch evidence can be reviewed without private tribal knowledge

## Verification Commands

Core automation commands:

```bash
bun run test
bunx tsc --noEmit -p tsconfig.json
bunx tsc --noEmit -p tsconfig.electron.json
cargo check --manifest-path rust-sidecar/Cargo.toml --bin nautilus-sidecar
```

Packaging and benchmark commands:

```bash
bun run electron:build:dmg
bun run gate:size
bun run benchmark:dictation:macos
bun run benchmark:dictation:windows
bun run gate:benchmark:macos
bun run gate:benchmark:windows
```

## Completion Rule

The implementation plan is complete only when all phases are complete in order.

No phase may be skipped.
No launch may proceed while any required gate remains non-`PASS`.
