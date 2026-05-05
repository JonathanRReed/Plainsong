# NautilusBot Codebase Audit Action Plan

Date: 2026-05-05

Source audit:

- `docs/audits/codebase-audit-2026-05-05.md`
- `docs/audits/codebase-audit-findings-2026-05-05.csv`

## Summary

Local gates are green, but the app should not move to signing yet. The next implementation pass should reduce regression risk in the exact areas that caused the recent bugs: dictation routing, overlay lifecycle, Settings load behavior, profiles, and large UI state containers.

## Implementation Status, 2026-05-05

Completed in the first follow-up pass:

- `AUD-001`: fixed requested versus actual dictation route storage and execution. Start options now preserve user intent separately from the resolved route, and stop/transcription uses the actual route explicitly.
- `AUD-002`: added `bun run gate:ipc-contract` so renderer command allowlist drift is caught against Rust sidecar dispatch.
- `AUD-004`: added timeout-safe secondary Settings loaders so backup, secret, permission, security, storage, license, and diarization checks cannot hold section loading forever.
- `AUD-008`: removed React-owned popup window show/hide calls. The popup now requests dismiss and lets the Electron/window layer own visibility.
- `AUD-010`: replaced production audio callback unwraps with poison-safe lock handling.
- `AUD-011`: added command timeout policy classes for fast reads, default commands, long work, and extended downloads or analysis.
- `AUD-012`: replaced full sidecar environment inheritance with an explicit allowlist, including only documented provider keys and runtime variables.
- `AUD-014`: removed Linux from the GA Electron packaging config and signing guidance.
- `AUD-015`: changed `DownloadManager::default()` from panic-on-setup to a temp-directory fallback.

Still open or partial:

- `AUD-003`, `AUD-005`, `AUD-016`, and `AUD-017` require larger module and view decomposition.
- `AUD-006`, `AUD-007`, cloud ASR, live license, and signing remain external evidence blockers, not local compile blockers.
- `AUD-009` still needs meeting processing UX work.
- `AUD-013` still needs generate versus verify script separation.

## Phase 1, Release-Critical Fixes

Target findings: `AUD-001`, `AUD-004`, `AUD-008`

Changes:

- Preserve requested and actual dictation route fields end to end.
- Make Settings initial render depend only on `getSettings()`.
- Move permission, license, keychain, backup, storage, model, and diarization work behind section-level loaders.
- Make Electron the only owner of overlay window visibility.
- Keep React popups as state renderers that request dismiss, start again, or open main app.

Acceptance:

- Moonshine selected with unavailable runtime reports requested Moonshine and actual fallback honestly.
- Cold Settings shell is visible and usable within 2 seconds on packaged macOS.
- Dictation popup close works in recording, transcribing, done, and error phases.

Current status:

- Requested and actual route fields are split and compile cleanly.
- Settings secondary loaders have timeout guards, but packaged cold timing evidence is still required.
- React no longer hides or shows the popup window directly, but stale-event lifecycle tests still need to be expanded.

Tests:

- `bun run typecheck`
- `bun run test`
- `bun run lint`
- Rust unit tests for dictation route fallback metadata.
- Component tests for Settings delayed secondary loaders and popup dismiss paths.

## Phase 2, Contract And Module Boundaries

Target findings: `AUD-002`, `AUD-003`, `AUD-011`, `AUD-017`

Changes:

- Add a command catalog for renderer-exposed commands.
- Validate Electron allowlist against sidecar command registration.
- Move command wrappers from the legacy backend facade into domain modules.
- Split Rust command handling into domain modules without behavior changes.
- Add per-command timeout policy.

Acceptance:

- Every renderer-exposed command has a catalog entry.
- Every catalog entry has params, result, exposure, and timeout class.
- Unknown command failures remain clear and typed.
- No new frontend imports are added from the legacy backend facade.

Current status:

- The IPC allowlist is now validated against sidecar dispatch with `bun run gate:ipc-contract`.
- Per-command timeout policy exists, but the full generated command catalog and wrapper migration are still open.

Tests:

- IPC contract test.
- Import-boundary test.
- Existing Rust and Vitest suites unchanged or stronger.

## Phase 3, Product Surface Decomposition

Target findings: `AUD-005`, `AUD-009`, `AUD-016`

Changes:

- Extract dictation profile, route, dictionary, snippet, and history logic into focused hooks and sections.
- Extract meeting detail persistence, chat, recall, export, and processing state into focused hooks and sections.
- Replace broad `any` settings handlers with typed setting controls.
- Keep current dark UI direction and visual hierarchy, with no decorative redesign.

Acceptance:

- Built-in profiles stay distinct.
- Custom profile create, edit, duplicate, delete, apply, and restart persistence remain covered.
- Meeting processing state is visible and refreshable after stop.
- Typed controls remove repeated event casts from changed settings sections.

Current status:

- No broad view decomposition was completed in this follow-up pass. This remains the next high-leverage cleanup after release-critical runtime fixes.

Tests:

- Focused hook tests for dictation profile persistence.
- Focused meeting detail persistence tests.
- Existing full-view smoke tests.

## Phase 4, Reliability And Release Hygiene

Target findings: `AUD-006`, `AUD-007`, `AUD-010`, `AUD-012`, `AUD-013`, `AUD-014`, `AUD-015`

Changes:

- Replace production audio callback unwraps with recoverable lock handling.
- Spawn the sidecar with an environment allowlist.
- Split write-capable artifact generation from read-only verification.
- Remove Linux from default GA build flow or mark it experimental behind explicit scripts.
- Replace fallible `Default` construction on download manager with typed setup errors.
- Capture macOS app-matrix insertion evidence and Windows packaged QA evidence.

Acceptance:

- Gate commands used for verification do not dirty the worktree.
- Sidecar startup failures surface as user-facing setup errors, not panics.
- GA build commands produce only macOS and Windows artifacts.
- App matrix and Windows QA move from known blockers to evidence-backed pass or fail rows.

Current status:

- Audio callback lock handling, sidecar environment allowlisting, Linux GA scope cleanup, IPC timeout policy, and DownloadManager startup mitigation are implemented.
- Packaged macOS app-matrix evidence and Windows packaged QA still require dogfooding on the target hosts.

Tests:

- `bun run gate:dead-code`
- `bun run gate:secret-safe-artifacts`
- `bun run gate:launch-claims`
- `bun run gate:doc-command-hygiene`
- Packaged macOS smoke and app-matrix capture.
- Windows packaged QA runner on a Windows host.

## Default Fix Order

1. Fix `AUD-001`.
2. Fix `AUD-008`.
3. Finish Settings loader hardening in `AUD-004`.
4. Rebuild and dogfood macOS DMG.
5. Start IPC catalog work.
6. Decompose dictation and meetings views.
7. Complete release hygiene and packaged evidence.

## Assumptions

- No new production dependencies are added without approval.
- Current dirty worktree is preserved.
- Existing launch status remains `NO-GO` until evidence changes.
- Signing and publishing stay out of scope until product and packaged QA gates are green.
