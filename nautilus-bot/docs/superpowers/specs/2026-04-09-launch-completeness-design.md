# Launch Completeness Design

Date: 2026-04-09
Owner: Nautilus engineering

## Goal

Define the hard launch-completeness standard for Nautilus as a dictation-first desktop product that competes credibly with Wispr Flow on dictation trust and speed, and with Granola on meeting capture and transcript-driven follow-up.

This spec defines when the app is allowed to launch. It does not define a relaxed beta bar.

## Product Priority Order

Launch work is ordered by business priority:

1. Dictation first
2. Meetings second
3. Privacy third

Later priorities cannot be used to justify shipping while earlier priorities are incomplete.

## Launch Scope

The launch target is:

- macOS packaged Electron build
- Windows packaged Electron build

The release is blocked until both platforms satisfy the same launch gates for the required feature set.

Linux is explicitly out of GA scope for this launch.

## Definition of Done

Nautilus is feature-complete and production-complete only when all of the following are true:

- dictation parity gates required for launch are `PASS`
- competitor parity gates required for launch are `PASS`
- packaged QA rows required for macOS are `PASS`
- packaged QA rows required for Windows are `PASS`
- signed install and update paths are validated on both platforms
- TypeScript checks are green
- Rust compile and quality checks are green
- Vitest is green in the supported toolchain
- launch-facing docs match the actual shipped state
- `docs/prelaunch-readiness.md` changes from `NO-GO` to `GO`

Code existence alone does not satisfy launch completeness.

## Gate Model

### 1. Product Gate

Dictation is the primary launch gate. The app does not qualify for launch if dictation still fails on:

- packaged start and stop reliability
- insertion reliability in the launch app matrix
- provider-integrity telemetry
- command mode success rate
- snippets success rate
- dictionary persistence and correctness
- smart formatting and correction trust
- hands-free reliability
- context-aware style behavior
- latency trend targets
- trust and recovery UX

The controlling source of truth is `docs/evals/dictation-parity-launch-scorecard.md`.

### 2. Packaged QA Gate

The app must pass packaged QA on both platforms for:

- install and upgrade
- permission flows
- onboarding
- capture flows
- retention and transcript-only behavior
- transcription
- AI analysis
- backup and restore
- updates
- licensing

The controlling source of truth is `docs/packaged-app-qa-matrix.md`.

### 3. Release Engineering Gate

The Electron release path must be production-valid, not just locally buildable. Required outcomes:

- macOS package builds through the supported Electron flow
- macOS signing and notarization are valid
- Windows installer is signed and installable
- updater path works on signed builds
- platform evidence is attached to the release docs

The controlling source of truth is `docs/release-gate-evidence.md`.

### 4. Automation Gate

The repo must be green enough to trust release candidates:

- `bun run test` passes
- `bunx tsc --noEmit -p tsconfig.json` passes
- `bunx tsc --noEmit -p tsconfig.electron.json` passes
- Rust checks pass for the sidecar

Broken test harnesses count as launch blockers because they reduce confidence in regression detection.

## Workstreams

### Workstream A: Dictation Completion

This is the first and highest-priority stream.

Required outcomes:

- packaged dictation hotkey succeeds reliably on macOS and Windows
- insertion succeeds or recovers gracefully across the launch app matrix
- command mode benchmark passes launch threshold
- snippets benchmark passes launch threshold
- dictionary behavior is stable across verified apps
- formatting and correction improve output without unacceptable false edits
- hands-free mode is reliable enough to ship
- context-aware styles are verified only where they are actually trustworthy
- provider telemetry is present in benchmark artifacts
- end-to-end latency trend passes the gate

Primary docs:

- `docs/evals/dictation-parity-launch-scorecard.md`
- `docs/dictation-app-compatibility-matrix.md`
- `docs/dictation-blocked-app-register.md`
- `docs/competitor-parity-gates.md`

### Workstream B: Meeting Completion

This stream starts only after dictation is at launch quality.

Required outcomes:

- meeting recording works mic-only and with system audio where supported
- stop transitions immediately into visible processing state
- transcript detail view refreshes without reopening
- transcript-only retention behaves correctly
- long-duration meeting reliability is proven
- consent and recording indicators are clear
- transcript search, speaker data, and AI follow-up flows are stable

Primary docs:

- `docs/competitor-parity-gates.md`
- `docs/packaged-app-qa-matrix.md`

### Workstream C: Privacy Completion

Privacy work follows product reliability.

Required outcomes:

- local-first behavior is truthful
- secrets storage is correct
- transcript-only storage and deletion behavior is verified
- retention and cleanup policies work exactly as configured
- backup, restore, and at least one cloud sync path are validated
- public product claims do not exceed verified provider, language, or storage behavior

Primary docs:

- `docs/prelaunch-readiness.md`
- `docs/packaged-app-qa-matrix.md`

### Workstream D: Platform and Release Completion

This stream makes the product shippable on both target platforms.

Required outcomes:

- macOS DMG path is signed and notarized
- Windows installer path is signed and validated
- update install flow works on signed builds
- packaged app QA evidence is recorded for both platforms
- default build and release scripts reflect the supported release path

Primary docs:

- `docs/release-gate-evidence.md`
- `docs/CODE_SIGNING.md`
- `docs/APPLE_DEVELOPER_SETUP.md`

### Workstream E: Evidence and Automation Completion

This stream converts internal claims into verified evidence.

Required outcomes:

- benchmark artifacts exist for baseline and both target platforms
- packaged QA evidence is attached
- release docs no longer contain stale success claims
- README and launch docs describe the actual supported state
- automated test and compile checks are green

## Launch App Matrix

The launch app matrix is intentionally narrow and must remain evidence-backed:

- Apple Notes
- Google Docs
- Slack desktop
- Notion desktop
- VS Code
- Cursor
- Messages or iMessage
- HubSpot in Chrome on macOS
- Outlook on Windows

Launch claims must be limited to verified apps in this matrix.

## Launch Language Policy

Nautilus may only make language claims backed by benchmark evidence and provider guidance.

Minimum launch certification target:

- English
- Spanish

Candidate expansion languages may be added only after evidence exists for:

- benchmark behavior
- insertion reliability
- model guidance
- user-facing correctness

## Error Handling and Trust Rules

The product must favor user trust over optimistic behavior.

Required trust rules:

- no hidden fallback claims in launch messaging
- no unsupported app or language claims without evidence
- explicit processing and failure states for dictation and meetings
- recoverable user paths for insertion failures
- no shipping with known broken signed-install or update flows

## Testing Strategy

### Automated

- Vitest for frontend regression coverage
- TypeScript checks for renderer and Electron code
- Rust compile and quality checks for the sidecar
- benchmark gate scripts for latency, command mode, snippets, and provider telemetry

### Manual Packaged

- install and upgrade on macOS and Windows
- permission flow validation
- launch app matrix dictation validation
- meeting processing and retention validation
- long-session recording checks
- licensing and update validation

Manual packaged evidence is required. Local dev-only validation is insufficient.

## Exit Criteria

The release is `NO-GO` if any required launch gate remains `BLOCKED`, `PARTIAL`, `FAIL`, or `PENDING`.

The release is `GO` only when:

- Workstream A is complete
- Workstream B is complete
- Workstream C is complete
- Workstream D is complete
- Workstream E is complete
- release docs are updated to reflect that completed state

## Non-Goals

This spec does not include:

- Linux GA support
- feature expansion beyond launch-critical parity and trust
- speculative collaboration features not required for the current launch
- softening the gate definitions to accelerate release

## Immediate Next Step

After this spec is approved, create a concrete implementation plan that sequences work in the same order:

1. Dictation completion
2. Meeting completion
3. Privacy completion
4. Platform and release completion
5. Evidence and automation completion
