# NautilusBot Whole Codebase Audit

Date: 2026-05-05

Scope: current Electron renderer, Electron shell, Rust sidecar, release scripts, launch evidence, and docs under `/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot`.

Current launch state: `NO-GO`. The local code gates are healthy, but packaged evidence and release readiness remain incomplete.

## Follow-Up Fix Status

The first implementation pass after this audit fixed or guarded several local risks:

| Finding | Status | Evidence |
| --- | --- | --- |
| `AUD-001` | Fixed | `DictationStartOptions` now keeps requested and actual provider/model fields separate, and dictation stop uses actual route fields for transcription. |
| `AUD-002` | Guarded | `bun run gate:ipc-contract` validates the Electron renderer allowlist against Rust sidecar dispatch. |
| `AUD-004` | Partial | Secondary Settings loaders now have section-level timeout guards. Packaged cold Settings timing evidence is still needed. |
| `AUD-008` | Partial | React popup code no longer hides or shows its own window. Full stale-event lifecycle coverage is still needed. |
| `AUD-010` | Fixed | Audio dictation callback elapsed-time access now uses poison-safe lock handling. |
| `AUD-011` | Partial | IPC commands now use timeout classes, including fast, default, long, and extended windows. Operation cancellation remains future work. |
| `AUD-012` | Fixed | Sidecar spawn now uses an explicit environment allowlist instead of inheriting the full Electron environment. |
| `AUD-014` | Fixed | Linux targets were removed from the GA Electron packaging config and signing guidance. |
| `AUD-015` | Mitigated | `DownloadManager::default()` now falls back to a temp model directory instead of panicking during setup. |

These fixes do not change the launch certification state. Packaged macOS app-matrix evidence, Windows packaged QA, live cloud ASR, live license activation, and signing evidence are still required before release.

## Executive Read

NautilusBot is in a stronger place than a typical prototype. The frontend, Electron shell, Rust sidecar, and evidence gates compile and test cleanly in the current local state. The product also has real depth in dictation profiles, local and cloud ASR routing, meeting memory, backup, retention, licensing, and release evidence generation.

The main risk is not a broken compiler state. The main risk is product complexity outrunning module boundaries and packaged evidence. The codebase has large central files that mix unrelated responsibilities, broad string-based IPC, duplicated command contracts, and several lifecycle surfaces where multiple layers own the same state. These are the places most likely to recreate the bugs you just saw: slow first load, unclear provider fallback, overlay close issues, and UI regressions.

## Verification Run

Commands run during this audit:

| Check | Result |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun run test` | PASS, 29 files, 182 tests |
| `bun run lint` | PASS |
| `bun run gate:dead-code` | PASS |
| `bun run gate:secret-safe-artifacts` | PASS, 265 files scanned |
| `bun run gate:launch-claims` | PASS, 0 findings |
| `cargo test --manifest-path rust-sidecar/Cargo.toml` | PASS, 258 Rust tests |

Local gate health is good. The audit findings below are about release risk, maintainability, runtime polish, and evidence gaps rather than current compile failures.

## Known Release Blockers

These are already tracked by launch docs and should not be double-counted as new code defects:

| Blocker | Evidence | Current impact |
| --- | --- | --- |
| Dictation app matrix incomplete | `docs/dictation-app-compatibility-matrix.md`, `docs/launch-readiness-dashboard.md` | 1 of 16 launch app rows are verified. Broad system-wide insertion claims are not certifiable yet. |
| Windows packaged QA incomplete | `docs/packaged-app-qa-matrix.md`, `docs/windows-packaged-qa-handoff.md` | Windows GA is blocked across install, onboarding, capture, meetings, export, backup, license, and signing rows. |
| Cloud ASR smoke blocked | `artifacts/cloud-asr-smoke.blocked.md` | Live cloud ASR claims need secret-backed smoke evidence. |
| Live license and external signing blocked | `docs/launch-completion-audit.md`, `docs/CODE_SIGNING.md` | License activation, notarization, Gatekeeper, Authenticode, and SmartScreen evidence are not complete. |

## Highest Priority Findings

### AUD-001, Requested dictation route is overwritten after fallback

Severity: `P1`

Evidence:

- `rust-sidecar/src/lib.rs:12669` resolves the requested dictation provider and model.
- `rust-sidecar/src/lib.rs:12680` resolves the ready actual provider and model.
- `rust-sidecar/src/lib.rs:12691` stores the actual provider in `options.requested_provider`.

Impact:

Fallback reporting can become internally inconsistent. The overlay currently emits requested and actual values from local variables in some phases, but the persisted start options are renamed to the actual route before later stop and history work. That can hide the originally selected provider in transcript history and make provider failures harder to explain.

Recommended fix:

Keep requested and actual route fields separate in `DictationStartOptions`, runtime events, transcript artifacts, and history details. Use actual fields for transcribe execution. Use requested fields only for user intent and fallback reporting.

Regression guard:

Add a Rust test for Moonshine selected, fallback enabled, Moonshine unavailable, MLX or Parakeet actual route, and history showing requested Moonshine plus actual fallback.

### AUD-002, IPC command contract is duplicated and stringly typed

Severity: `P1`

Evidence:

- `electron/ipc-bridge.ts:40` owns renderer allowlist strings.
- `src/lib/electron.ts:18` exposes generic `invoke(cmd: string)`.
- `rust-sidecar/src/lib.rs:17115` handles unknown commands in a separate Rust match.

Impact:

Command drift can ship without TypeScript or Rust catching it. This is especially risky during the Electron migration because commands now exist across renderer wrappers, Electron allowlists, and sidecar dispatch.

Recommended fix:

Create a single command catalog with command name, exposure, params, result type, and timeout class. Use it to validate the Electron allowlist and generate or test frontend wrappers.

Regression guard:

Add a contract test that every renderer-exposed command exists in the sidecar and every sidecar command is either wrapped or marked internal.

### AUD-003, Rust sidecar `lib.rs` carries too many runtime domains

Severity: `P1`

Evidence:

- `rust-sidecar/src/lib.rs` is 17,117 lines.
- `rust-sidecar/src/lib.rs:66` defines broad app state.
- `rust-sidecar/src/lib.rs:12658` starts dictation.
- `rust-sidecar/src/lib.rs:14013` stops meetings.
- `rust-sidecar/src/lib.rs:14452` begins a large command dispatcher region.

Impact:

Unrelated fixes share one massive module. That makes it easy for dictation, meeting, license, IPC, and settings changes to collide or regress each other.

Recommended fix:

Extract command modules by domain, then move dictation and meeting lifecycle logic into focused services. Keep `lib.rs` as app composition and dispatch only.

Regression guard:

Move existing Rust tests with the extracted code and add a command registration test.

### AUD-004, Settings still starts too much first-load work

Severity: `P1`

Evidence:

- `src/components/views/settings-view-simple.tsx:731` loads core settings.
- `src/components/views/settings-view-simple.tsx:757` loads backup config after settings.
- `src/components/views/settings-view-simple.tsx:791` checks provider secrets.
- `src/components/views/settings-view-simple.tsx:814` loads permission diagnostics.
- `src/components/views/settings-view-simple.tsx:897` validates license.
- `src/components/views/settings-view-simple.tsx:987` checks diarization availability.

Impact:

The recent first-load fix reduced blocking, but first open can still feel heavy because secondary probes start early and compete for IPC, keychain, filesystem, and model runtime work.

Recommended fix:

Make the Settings critical path strictly `getSettings()`. Move permission, license, keychain, diarization, backup, models, security, and storage checks behind visible section loaders with independent loading and error states.

Regression guard:

Keep the current settings render test and add a timed test with delayed secondary loaders, plus a packaged cold Settings timing artifact.

### AUD-005, Dictation and Meetings views are oversized state containers

Severity: `P1`

Evidence:

- `src/components/views/dictation-view.tsx` is 7,017 lines.
- `src/components/views/dictation-view.tsx:1075` starts a large local state block.
- `src/components/views/dictation-view.tsx:2059` persists dictation settings from inside the view.
- `src/components/views/recordings-view.tsx` is 4,241 lines.
- `src/components/views/recordings-view.tsx:700` starts a large meeting state block.
- `src/components/views/recordings-view.tsx:797` starts relationship memory loading inside the view.

Impact:

These views are now product surfaces, not screens. Keeping persistence, async effects, view rendering, and product policy in one component makes profile, routing, meeting, and export changes fragile.

Recommended fix:

Extract domain hooks and presentational sections. Prioritize dictation profile state, route controls, dictionary and snippets, meeting detail persistence, meeting AI actions, and export status.

Regression guard:

Create focused tests for extracted hooks and keep full-view smoke tests for user workflows.

## Additional Findings

The full finding table is in `docs/audits/codebase-audit-findings-2026-05-05.csv`.

Key additional risks:

- Overlay visibility still has multiple owners across Rust state, Electron window commands, and React `window.hide`.
- Meeting overlay hides immediately after the app enters background processing, which weakens trust UX.
- Audio callback locks use `unwrap()` in production capture paths.
- All IPC commands share one fixed 60 second timeout.
- The sidecar inherits the full Electron environment.
- Verification scripts can write artifacts, so gates can dirty the worktree.
- Linux targets remain in `electron-builder.yml` even though GA scope is macOS and Windows.
- `DownloadManager::default()` can panic during setup.
- Settings has broad `any` event handlers.
- Frontend domain modules still re-export from the legacy backend facade.

## Architecture Opportunities

The strongest next cleanup is a contract-first boundary:

1. Define command catalog.
2. Generate or validate Electron allowlist.
3. Move renderer wrappers into domain modules.
4. Split Rust dispatch by domain.
5. Add per-command timeout and exposure policy.

This would reduce repeated work across future bug sweeps. It also creates a natural place for validation, telemetry fields, cancellation, and user-facing error normalization.

## Product Opportunities

The app can compete well if the next implementation pass focuses on reliability rather than broad new features:

- Treat dictation route transparency as a first-class product feature.
- Make profile install and custom profile CRUD a small state machine instead of scattered view state.
- Keep Settings fast by making secondary work visibly lazy.
- Make meeting processing states obvious and resumable.
- Turn packaged app insertion evidence into a release gate, not a doc chore.

## Release Readiness Read

Current state is not ready for public release beyond local testing. It is close enough to justify focused release hardening, but not close enough to sign and publish.

The highest-leverage release path is:

1. Fix AUD-001 through AUD-005.
2. Re-run local gates.
3. Rebuild the macOS DMG.
4. Dogfood the reported workflows.
5. Complete macOS app-matrix insertion evidence.
6. Complete Windows packaged QA on a Windows host.
7. Run cloud ASR and license live evidence with secrets.
8. Only then start signing and notarization.
