# Capability Platform Implementation Plan

Date: 2026-03-07
Depends on: `docs/plans/2026-03-07-capability-platform-design.md`

## Goal

Execute the capability-platform redesign without freezing product progress, breaking packaged behavior, or regressing current dictation and meeting workflows.

This plan assumes the end state is a durable shared runtime with two primary surfaces:

- Dictation
- Meetings

The implementation strategy is progressive extraction, not a rewrite.

## Principles

- Preserve shipping behavior while extracting capability seams.
- Move logic from views into workflows and capabilities before adding major new features.
- Introduce durable state and event persistence before depending on new automation features.
- Keep old and new paths interoperable during migration.
- Every major refactor step must leave the app releasable.

## Workstreams

### W1. Runtime Foundations

Scope:

- typed internal event model
- event persistence
- capability-aligned backend module layout
- artifact and projection tables

Deliverables:

- `rust-sidecar/src/events/`
- `rust-sidecar/src/store/`
- initial event types and persistence layer
- SQLite migrations for events and artifacts

Success checks:

- backend compiles with the new module structure
- event writes are covered by tests
- existing dictation and meeting flows can emit events without changing UI behavior

### W2. Capture Capability

Scope:

- audio capture orchestration
- hotkey start and stop
- streaming queues
- silence timeout
- permission diagnostics
- packaged runtime capture checks

Deliverables:

- `rust-sidecar/src/capture/`
- extracted dictation and meeting capture controllers
- shared permission and environment diagnostics

Success checks:

- current dictation and meeting start and stop flows still pass
- capture logic is callable through workflow modules instead of giant `lib.rs` branches
- manual packaged checks remain possible on macOS and Windows

### W3. Context Capability

Scope:

- app detection
- bundle or process resolution
- selected text capture
- clipboard capture
- window title capture
- future calendar hook seam

Deliverables:

- `rust-sidecar/src/context/`
- immutable `ContextSnapshot`
- context capture policy resolution

Success checks:

- dictation modes use context snapshots instead of ad hoc values
- macOS and Windows context providers expose a common interface
- selected-text and application-context failures become explicit capability errors

### W4. Insertion Capability

Scope:

- paste dispatch
- inline insertion
- clipboard-only fallback
- undo and rollback
- snippet engine
- command engine
- app-specific insertion policies

Deliverables:

- `rust-sidecar/src/insertion/`
- reusable insertion outcome types
- insertion policy resolver
- snippet and command services extracted from orchestration code

Success checks:

- dictation insertion telemetry is generated from capability events
- macOS and Windows insertion paths share the same contract
- snippet and command behavior remains benchmarkable

### W5. Transcription Intelligence Capability

Scope:

- provider routing
- model resolution
- transcription streaming
- transcript normalization
- diarization
- quality scoring
- latency metrics

Deliverables:

- `rust-sidecar/src/transcription/`
- provider plan resolver
- transcript artifact builder
- shared partial/final transcription event emitters

Success checks:

- dictation and meetings both use the same provider-plan contract
- transcript lineage and latency fields are written through one path
- fallback and policy decisions are explicit and testable

### W6. Meeting Workflows Capability

Scope:

- live meeting session orchestration
- note-first meeting workspace data model
- summaries, actions, decisions, deadlines
- Ask or Chat with meeting
- template-aware regeneration

Deliverables:

- `rust-sidecar/src/workflows/meetings/`
- `MeetingArtifact`
- meeting-scoped knowledge and analysis services
- note and transcript regeneration rules

Success checks:

- meeting notes are first-class inputs everywhere
- transcript processing and analysis are reconstructable from artifacts and events
- meeting detail UI can move to note-first projections without backend rewrites

### W7. Frontend Feature Reorganization

Scope:

- move business logic out of views
- introduce feature-based frontend folders
- add runtime projections and event subscribers
- reduce direct backend coupling in UI components

Deliverables:

- `src/features/dictation/`
- `src/features/meetings/`
- `src/features/settings/`
- `src/features/shared-runtime/`

Success checks:

- views become mostly declarative
- shared runtime state does not depend on view-local effects
- existing tests are migrated or replaced without coverage loss

### W8. Integrations And Governance

Scope:

- backup and sync
- exports
- calendar seam
- retention
- transcript-only storage
- audit logging
- release evidence bundle hooks

Deliverables:

- `rust-sidecar/src/integrations/`
- `rust-sidecar/src/governance/`
- policy snapshot enforcement

Success checks:

- retention and transcript-only behavior run through governance services
- export and backup flows consume artifacts instead of raw UI state
- release evidence generation becomes less manual

## Sequenced Phases

### Phase 0: Stabilize Current Product

Objective:

- land current high-confidence parity fixes
- avoid starting architectural extraction on known-broken product flows

Tasks:

- finish current dictation insertion parity fixes
- keep meeting processing and dictation history fixes tested
- confirm current automated suite stays green

Exit criteria:

- `bun run test`
- `bun run build`
- `cargo check --all-targets`

### Phase 1: Extract Runtime Foundations

Objective:

- create the shared event and artifact substrate

Tasks:

- add event types and persistence tables
- add `CaptureSession`, `ContextSnapshot`, `TranscriptArtifact`, `InsertionAction`, `MeetingArtifact`, `PolicySnapshot`
- add repository layer in `store/`
- create thin projection helpers for current UI to consume

Exit criteria:

- migrations succeed on a fresh database
- old flows still operate while writing the new records
- unit tests for event persistence and artifact storage pass

### Phase 2: Extract Capture And Context

Objective:

- remove OS capture and context logic from monolithic orchestration code

Tasks:

- move audio and hotkey orchestration into `capture/`
- move app, selection, clipboard, and window capture into `context/`
- create platform-specific provider implementations
- ensure workflows consume context snapshots rather than directly querying helpers

Exit criteria:

- dictation and meeting start paths compile through new modules
- context capture works through a shared interface on macOS and Windows
- no direct UI calls depend on old helper functions

### Phase 3: Extract Insertion And Transcript Intelligence

Objective:

- isolate the two most critical parity capabilities

Tasks:

- move paste, inline, clipboard, undo, snippets, and commands into `insertion/`
- move provider routing, transcript normalization, diarization, and latency telemetry into `transcription/`
- replace ad hoc dictation outcome payload building with capability outputs

Exit criteria:

- insertion outcomes are generated from the new capability
- dictation command and snippet telemetry remain intact
- transcript artifacts replace scattered transcript persistence logic

### Phase 4: Rebuild Meeting Workflows

Objective:

- make meetings a note-first workspace on top of shared capabilities

Tasks:

- create `workflows/meetings/`
- persist meeting artifacts and regeneration history
- add meeting-scoped Ask or Chat service contract
- thread template-aware analysis through artifacts and projections

Exit criteria:

- meetings use first-class notes and artifacts
- meeting detail UI can render from projections
- summary and action regeneration depends on artifacts, not ad hoc view logic

### Phase 5: Reorganize Frontend Features

Objective:

- make the frontend reflect platform boundaries

Tasks:

- create `src/features/*`
- migrate dictation and meeting state into projections and feature hooks
- reduce view-local event subscriptions
- keep UI components presentational

Exit criteria:

- main feature views are feature-owned and thinner
- cross-surface runtime state is shared through projections
- tests are updated to match the new structure

### Phase 6: Add Competitor-Inspired Features On Clean Seams

Objective:

- absorb the best ideas only after the foundation supports them

Tasks:

- richer app-scoped and future domain-scoped dictation modes
- stronger command and transform UX
- note-first meeting review workspace
- Ask or Chat with meeting
- template-aware meeting outputs
- future calendar and automation triggers

Exit criteria:

- new features land mostly in workflows and capabilities
- no new monolithic orchestration branches are introduced

## Database Migration Plan

### Additive Migrations First

Start with additive tables and nullable columns:

- `events`
- `capture_sessions`
- `context_snapshots`
- `transcript_artifacts`
- `insertion_actions`
- `meeting_artifacts`
- `policy_snapshots`

Rules:

- do not delete legacy columns in the first migration wave
- dual-write when necessary
- add backfill utilities only after reads can prefer the new model

### Read Transition

Sequence:

1. write to old + new structures
2. read from old, verify new
3. read from new with fallback to old
4. remove fallback after a full QA cycle

## File-Level Refactor Plan

### Backend

Start by shrinking:

- `rust-sidecar/src/lib.rs`

Extract into:

- `rust-sidecar/src/events/mod.rs`
- `rust-sidecar/src/store/mod.rs`
- `rust-sidecar/src/capture/mod.rs`
- `rust-sidecar/src/context/mod.rs`
- `rust-sidecar/src/insertion/mod.rs`
- `rust-sidecar/src/transcription/mod.rs`
- `rust-sidecar/src/workflows/dictation/mod.rs`
- `rust-sidecar/src/workflows/meetings/mod.rs`
- `rust-sidecar/src/governance/mod.rs`

Keep `lib.rs` as:

- backend command registration
- state wiring
- thin orchestration entry points

### Frontend

Current areas to progressively migrate:

- `src/components/views/dictation-view.tsx`
- `src/components/views/recordings-view.tsx`
- `src/hooks/use-recording.tsx`
- `src/hooks/use-recordings.ts`
- popup components

Target:

- feature folders with dedicated projection hooks
- shared runtime state detached from specific screens

## Verification Plan

### Automated Checks Per Phase

Always run:

- `bun run test`
- `bun run build`
- `cargo check --all-targets`

Add per capability:

- store and event persistence tests
- insertion capability tests
- context capability tests
- transcript artifact tests
- workflow orchestration tests

### Manual Checks Per Phase

Phase 2 and Phase 3:

- hotkey dictation in real target apps
- selected-text capture
- app-context capture
- macOS and Windows insertion behavior

Phase 4 and Phase 5:

- live meeting notes persistence
- transcript processing self-refresh
- note-aware summary regeneration
- Ask or Chat with meeting citations

### Release Gates

Do not mark parity complete until:

- insertion success is proven in target apps and packaged builds
- meeting workflows are artifact-backed and note-first
- benchmark evidence exists for latency, command success, and snippet precision
- blocked packaged QA rows have real evidence

## Risks And Mitigations

### Risk: The refactor stalls feature work

Mitigation:

- ship by phase
- preserve old UI contracts while extracting backend capabilities

### Risk: Dual-write data paths drift

Mitigation:

- make dual-write explicit and temporary
- test old/new consistency in repository tests

### Risk: UI rewrites regress product behavior

Mitigation:

- move backend seams first
- keep UI mostly stable until projections exist

### Risk: Packaged behavior diverges from dev behavior

Mitigation:

- keep packaged QA as a standing gate
- do not trust browser-only or dev-only verification for insertion and permissions

## Definition Of Done

This implementation plan is complete only when:

- the backend is capability-organized
- the frontend is feature-organized
- dictation and meetings share durable runtime primitives
- new competitor-inspired features land on clean seams
- packaged reliability is verified rather than assumed

At that point Nautilus can keep compounding product quality instead of accumulating product glue.
