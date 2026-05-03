# Dual-Surface Rebuild Implementation Plan

Date: 2026-04-14
Spec: `docs/superpowers/specs/2026-04-14-dual-surface-rebuild-design.md`

## Goal

Rebuild Nautilus into a dictation-first desktop app with meeting capture and review as the second surface, while preserving first-class macOS and Windows support and keeping cloud features optional.

This plan assumes the approved product and architecture direction from the design spec:

- new core inside the existing repo
- Electron plus Rust retained
- dictation hero path first
- meeting capture and review second
- local-first by default
- cloud optional

## Non-Goals

This implementation plan does not optimize for:

- broad provider expansion
- collaboration features
- launch marketing breadth
- sync as a primary product promise
- major release-signing work until product contracts stabilize

## Working Rules

- Do not add new production dependencies without explicit approval.
- Run `bun run lint` before proposing code changes.
- Run `bun run typecheck` after modifying TypeScript files.
- Run tests that cover each modified area.
- Keep macOS and Windows behavior aligned at the contract layer.
- Prefer migration by replacement over expanding legacy surfaces.

## Current Constraints

Current repo facts that shape this plan:

- the repo already passes `bun run lint`, `bun run typecheck`, and `bun run test`
- the worktree is dirty, so changes must be isolated and intentional
- several core files are oversized and should be treated as migration sources, not growth targets
- the app is already on an Electron plus Rust split, so platform replacement is not needed

## Phase 0: Lock Product Contracts

Objective:

- turn the design spec into implementation boundaries that code can target

Deliverables:

- final dictation session state contract
- final meeting session state contract
- final renderer bridge domain boundaries
- final migration map from legacy files to new modules

Tasks:

1. Define dictation session states and event payloads.
2. Define meeting session states and review artifact lifecycle.
3. Define renderer contract namespaces:
   - `dictation`
   - `meetings`
   - `settings`
   - `platform`
4. Define which existing APIs are legacy and which remain reusable.
5. Define the initial feature flags or migration toggles needed to land slices safely.

Exit criteria:

- each domain has a clear API surface
- no new work is planned against oversized legacy files without a migration reason

## Phase 1: Extract the Renderer Contract

Objective:

- stop growing the flat backend bridge and create narrow typed entry points

Primary legacy source:

- `src/lib/backend.ts`

Target structure:

- `src/lib/backend/dictation.ts`
- `src/lib/backend/meetings.ts`
- `src/lib/backend/settings.ts`
- `src/lib/backend/platform.ts`
- `src/lib/backend/index.ts`

Tasks:

1. Split type definitions by domain.
2. Split invoke wrappers by domain.
3. Keep existing runtime commands stable while introducing new import paths.
4. Update UI code to import only what each surface uses.
5. Add tests for the new typed wrappers where practical.

Exit criteria:

- no new feature work lands in the old flat bridge
- dictation and meetings no longer depend on the entire backend surface

## Phase 2: Build the New Dictation Core

Objective:

- create a single source of truth for dictation lifecycle and delivery behavior

Primary legacy sources:

- `rust-sidecar/src/lib.rs`
- `src/components/views/dictation-view.tsx`
- `src/components/popups/dictation-popup.tsx`
- `src/hooks/use-recording.tsx`

Target structure:

- Rust:
  - `rust-sidecar/src/dictation/mod.rs`
  - `rust-sidecar/src/dictation/session.rs`
  - `rust-sidecar/src/dictation/route.rs`
  - `rust-sidecar/src/dictation/delivery.rs`
  - `rust-sidecar/src/dictation/history.rs`
- TypeScript:
  - `src/features/dictation/state/`
  - `src/features/dictation/hooks/`
  - `src/features/dictation/components/`
  - `src/features/dictation/views/`

Tasks:

1. Define explicit runtime states:
   - `idle`
   - `primed`
   - `recording`
   - `transcribing`
   - `delivering`
   - `done`
   - `error`
2. Move state transitions behind one dictation controller.
3. Separate route resolution from UI concerns.
4. Separate insertion and fallback handling from transcription concerns.
5. Persist result metadata:
   - requested route
   - actual route
   - fallback reason
   - target app
   - startup latency
   - transcription latency
   - insert latency
   - end-to-end latency
6. Create a slimmer dictation view on top of the new contract.
7. Rewire overlay and popup to consume the same state model.

Exit criteria:

- dictation state comes from one contract
- overlay, popup, and main view stay synchronized
- fallback behavior is explicit and testable

## Phase 3: Rebuild Dictation History and Reprocess

Objective:

- make history a product feature built on artifacts, not transient UI state

Primary legacy sources:

- `src/components/views/dictation-view.tsx`
- dictation-related persistence code in `rust-sidecar/src/lib.rs`

Target structure:

- Rust:
  - `rust-sidecar/src/dictation/history.rs`
  - `rust-sidecar/src/dictation/reprocess.rs`
- TypeScript:
  - `src/features/dictation-history/`

Tasks:

1. Define the dictation artifact schema used for history.
2. Persist enough information for trustworthy reprocess.
3. Build recent-history UI separate from the live dictation controller.
4. Expose reprocess as a first-class action with route transparency.
5. Add tests for artifact-backed reprocess.

Exit criteria:

- dictation history no longer depends on live component state
- recent result review and reprocess are reliable

## Phase 4: Build the New Meeting Core

Objective:

- rebuild meetings as a narrow bot-free capture and review flow

Primary legacy sources:

- `src/components/views/recordings-view.tsx`
- `src/hooks/use-recordings.ts`
- `src/hooks/use-recording-detail.ts`
- meeting-related code in `rust-sidecar/src/lib.rs`

Target structure:

- Rust:
  - `rust-sidecar/src/meetings/mod.rs`
  - `rust-sidecar/src/meetings/session.rs`
  - `rust-sidecar/src/meetings/processing.rs`
  - `rust-sidecar/src/meetings/transcript.rs`
  - `rust-sidecar/src/meetings/review.rs`
- TypeScript:
  - `src/features/meetings/state/`
  - `src/features/meetings/hooks/`
  - `src/features/meetings/components/`
  - `src/features/meetings/views/`

Tasks:

1. Define explicit meeting states:
   - `idle`
   - `recording`
   - `processing`
   - `ready`
   - `error`
2. Move consent handling into the capture start contract.
3. Enforce immediate `processing` transition after stop.
4. Persist transcript before any enrichment work.
5. Build compact review sections:
   - transcript
   - summary
   - action items
   - follow-up
6. Add auto-refresh behavior as enrichment artifacts complete.

Exit criteria:

- meeting stop-to-processing is deterministic
- transcript-first persistence is enforced
- review is usable without enrichment

## Phase 5: Optional AI Enrichment

Objective:

- add AI-generated value without making it part of the core reliability path

Primary legacy sources:

- `src/components/ai-analysis-panel.tsx`
- `rust-sidecar/src/llm/`

Target structure:

- Rust:
  - `rust-sidecar/src/ai/mod.rs`
  - `rust-sidecar/src/ai/summary.rs`
  - `rust-sidecar/src/ai/action_items.rs`
  - `rust-sidecar/src/ai/follow_up.rs`
- TypeScript:
  - `src/features/ai/`

Tasks:

1. Define a shared enrichment job model.
2. Keep local-first provider selection as the default.
3. Expose cloud providers only after explicit setup.
4. Ensure transcript review does not block on enrichment.
5. Add failure states that degrade gracefully in UI.

Exit criteria:

- enrichment enhances the product without owning the critical path

## Phase 6: Platform Adapter Cleanup

Objective:

- isolate macOS and Windows differences behind clear adapter boundaries

Primary legacy sources:

- platform-specific code in `rust-sidecar/src/lib.rs`
- `electron/main.ts`
- platform helper files under `rust-sidecar/src/asr/platform/`

Target structure:

- Rust:
  - `rust-sidecar/src/platform/mod.rs`
  - `rust-sidecar/src/platform/macos/`
  - `rust-sidecar/src/platform/windows/`
- TypeScript:
  - `src/features/platform/`

Tasks:

1. Extract insertion readiness logic.
2. Extract permission diagnostics.
3. Extract target app detection and app-context helpers.
4. Extract audio-source capability checks.
5. Keep shared product behavior above the adapter layer.

Exit criteria:

- macOS and Windows differences are isolated
- product-state logic is platform-agnostic above adapters

## Phase 7: Deletion and Quarantine

Objective:

- stop legacy surfaces from continuing to shape the product

Tasks:

1. Identify code paths replaced by new domain modules.
2. Delete or quarantine obsolete view logic.
3. Delete unused backend wrappers.
4. Delete dead session state paths.
5. Remove hidden or misleading UI controls that are no longer part of v1.

Exit criteria:

- the new product path is the only path receiving active development

## Recommended Delivery Order

Implementation should follow this order:

1. renderer contract extraction
2. dictation core
3. dictation history and reprocess
4. meeting core
5. optional AI enrichment
6. platform adapter cleanup
7. legacy deletion

This order maximizes visible user value early and prevents meeting work from blocking the dictation hero path.

## Testing Plan

### Mandatory Per Slice

- `bun run lint`
- `bun run typecheck`
- `bun run test`

### Dictation-Specific

- lifecycle transition tests
- insertion fallback tests
- route transparency tests
- overlay and main-view synchronization tests

### Meeting-Specific

- capture state tests
- stop-to-processing tests
- transcript-first persistence tests
- review refresh tests

### Cross-Platform

- macOS insertion readiness
- Windows insertion readiness
- macOS capture mode support
- Windows capture mode support

### Packaged QA After Surface Stabilization

- packaged dictation QA on macOS
- packaged dictation QA on Windows
- packaged meetings QA on macOS
- packaged meetings QA on Windows

## Risks and Controls

### Risk: Legacy Expansion Continues During Migration

Control:

- no new feature work lands in oversized legacy files unless required to unblock migration

### Risk: Cross-Platform Divergence

Control:

- shared contracts are defined before adapter extraction
- adapter-specific behavior stays below domain logic

### Risk: AI Work Bloats the Core Path

Control:

- transcript-first persistence is enforced
- enrichment remains optional and non-blocking

### Risk: Dirty Worktree Causes Regressions

Control:

- keep rebuild changes narrowly scoped
- avoid reverting unrelated user work
- verify touched areas aggressively

## Definition of Done

The rebuild plan is complete when:

- the dictation hero path runs on the new core
- history and reprocess use persistent artifacts
- meetings use transcript-first capture and review contracts
- AI enrichment is optional and non-blocking
- macOS and Windows are supported through isolated adapters
- oversized legacy files stop growing and begin shrinking
- packaged QA can truthfully measure the new product against its reduced scope
