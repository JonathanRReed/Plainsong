# Dual-Surface Rebuild Design

Date: 2026-04-14

## Summary

Nautilus will be rebuilt as a focused two-surface desktop product:

- Dictation is the hero product.
- Meeting capture and review is the second surface.
- Cloud features are optional, not the default path.
- macOS and Windows are first-class targets from day one.

The rebuild will not be a full greenfield rewrite. It will be a new core inside the existing repo, keeping Electron plus Rust while replacing the current oversized product surfaces with narrower domain contracts.

## Why Rebuild This Way

The current app passes basic engineering checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

The main issue is not baseline build health. The main issue is product and architecture sprawl:

- core behavior is concentrated in oversized files
- too much surface area is flowing through a flat renderer bridge
- dictation, meetings, AI analysis, sync, licensing, updates, and parity evidence are coupled into the same product pass
- launch claims and launch evidence are out of balance

The rebuild must narrow the product, split ownership boundaries, and make the app easier to ship honestly on macOS and Windows.

## Product Direction

### Primary Promise

The fastest trustworthy dictation app in the category, with built-in bot-free meeting capture and review.

### Product Priorities

1. Dictation-first daily use
2. Meeting capture and review as the second surface
3. Local-first by default
4. Optional cloud enhancements only after explicit setup
5. Cross-platform parity across macOS and Windows

### Out of Scope for This Rebuild

These are intentionally not first-class rebuild goals:

- team collaboration features
- broad sync as a core product promise
- provider breadth as a marketed differentiator
- deep export permutations
- speculative launch claims not backed by packaged evidence
- broad enterprise governance work

## Reference Product Baseline

The target shape is informed by:

- Wispr Flow for hotkey-first dictation, app-aware modes, formatting, and low-friction daily use
- Granola for bot-free meeting capture, clear consent, and review-oriented post-meeting flow
- OpenOats for transcript-first meeting memory, retrieval, and practical local meeting workflows

Nautilus should not clone any single competitor. It should combine:

- Wispr-style speed and confidence in dictation
- Granola-style trust and meeting review clarity
- OpenOats-style transcript-first memory depth where it serves the single-user workflow

## Product Scope

### Surface 1: Dictation Hero

Dictation is the main product and receives the largest engineering and UX investment.

Required outcomes:

- fast global trigger on macOS and Windows
- clear session lifecycle
- live partial preview
- app-aware modes
- trustworthy insertion with visible fallback behavior
- recent history and reprocess
- transparent provider and route behavior

### Surface 2: Meeting Capture and Review

Meetings are the second surface. They must feel trustworthy and fast, but narrower than the dictation hero path.

Required outcomes:

- bot-free capture
- explicit consent flow
- mic-only and mic-plus-system capture where supported
- immediate processing state after stop
- transcript-first review
- summary, action items, and follow-up draft
- usable review even when AI enrichment fails

## Recommended Rebuild Strategy

Use a new core inside the same repo.

### Why Not a Full Greenfield Rewrite

A greenfield rewrite would create the cleanest architecture, but it would also discard working platform behavior, test coverage, and the existing desktop split that already compiles and passes checks.

### Why Not a Pure In-Place Refactor

A pure in-place refactor would be faster at first, but it would preserve too much of the current sprawl and make it harder to enforce clean product boundaries.

### Chosen Strategy

Preserve:

- Electron as the desktop shell
- Rust as the runtime and systems layer
- existing low-level code that still fits the new product contract

Replace or quarantine:

- oversized view logic
- flat renderer bridge APIs
- legacy flows that do not fit the new product story
- launch-only or parity-only complexity that blocks product clarity

## Architecture

The rebuilt app is organized around domain contracts rather than giant app-level files.

### 1. Desktop Shell

Responsibilities:

- window lifecycle
- overlays
- global shortcuts
- updater hooks
- permissions bridge
- app launch and tray integration

Technology:

- Electron main process

Rules:

- desktop shell does not own product logic
- it only routes events, platform state, and window behavior into narrower domain APIs

### 2. Dictation Core

Responsibilities:

- dictation session lifecycle
- route resolution
- partial and final transcription flow
- insertion policy
- history persistence
- reprocess actions

Rules:

- one explicit session state model
- one delivery pipeline
- one source of truth for dictation state consumed by overlay and main UI

### 3. Meeting Core

Responsibilities:

- capture session lifecycle
- audio source handling
- recording stop to processing transition
- transcript persistence
- review state

Rules:

- transcript persists before enrichment
- review is built around transcript, summary, action items, and follow-up
- meeting capture stays narrow and reliable

### 4. AI Services

Responsibilities:

- optional summarization
- optional rewriting
- optional action extraction
- provider adapters

Rules:

- local-first behavior by default
- cloud providers only after explicit user setup
- failure in AI enrichment never blocks transcript completion

### 5. Storage Core

Responsibilities:

- recordings
- transcripts
- settings
- audit events
- lightweight migrations

Rules:

- storage APIs reflect domain concepts, not UI screens
- transcript-first persistence is a hard rule for meetings

### 6. Platform Adapters

Responsibilities:

- cursor insertion
- permissions
- platform audio behavior
- target app detection
- OS-specific integration differences

Rules:

- macOS and Windows differences are isolated here
- product contract remains shared above this layer

### 7. Renderer Contract

Responsibilities:

- narrow typed bridge between renderer and runtime

Rules:

- replace broad flat RPC exposure with domain-scoped contracts
- UI should call use-case APIs, not a long unstructured command list

## Surface Contracts

### Dictation Contract

Lifecycle:

`idle -> primed -> recording -> transcribing -> delivering -> done | error`

Required behaviors:

- global hotkey entry
- partial preview
- clear route resolution
- insertion policy with explicit fallback
- recent result preservation
- history and reprocess
- app-aware mode activation

User-visible guarantees:

- if insertion fails, text is preserved
- if route changes or falls back, that is visible
- if cloud is required, the app says so explicitly rather than silently switching expectations

### Meeting Contract

Lifecycle:

`idle -> recording -> processing -> ready | error`

Required behaviors:

- explicit capture mode selection
- explicit consent acknowledgment before start
- immediate state change to `processing` after stop
- transcript-first persistence
- auto-refresh review when enrichment completes

User-visible guarantees:

- transcript remains accessible even if summary generation fails
- consent and capture state are always visible
- system-audio limitations are explained before recording when possible

## Data Flow

### Dictation Flow

1. Global shortcut or UI action starts dictation.
2. Desktop shell asks platform adapter for permission and target readiness.
3. Dictation core creates a session and emits lifecycle state.
4. Route resolution chooses local by default, cloud only if user configured and selected.
5. Partial text streams to overlay and renderer.
6. Final text moves through formatting and insertion policy.
7. Delivery result, route metadata, latency, and fallback info are persisted.

### Meeting Flow

1. User selects meeting capture mode.
2. Consent flow completes before recording starts.
3. Meeting core starts capture and persists recording metadata.
4. User stops recording.
5. Session moves immediately to `processing`.
6. Transcript persists first.
7. Optional enrichment jobs generate summary, action items, and follow-up.
8. Review surface refreshes as each artifact becomes ready.

## Failure Handling

### Dictation

- direct insertion failure falls back visibly to safer delivery
- text is preserved even on delivery failure
- route not ready returns a precise explanation
- local-first promise must never be broken by hidden cloud fallback
- app surfaces must not imply behavior that is not fully wired

### Meetings

- if system audio is unavailable, user can continue with mic-only or cancel
- if enrichment is delayed or fails, transcript review still works
- if consent prerequisites are missing, capture does not start silently

## UX Principles

### Dictation

- the fast path should feel almost frictionless
- mode choice should be simple and opinionated
- advanced controls should be demoted out of the main path
- delivery state should be more visible than implementation detail

### Meetings

- review should be compact and note-first
- transcript, summary, action items, and follow-up should be the core tabs or sections
- collaboration theater should be avoided

## Migration Strategy

The rebuild should proceed in slices while the old app still exists.

### Slice 1: New Dictation Core

Build:

- new dictation session state model
- new typed renderer contract for dictation
- new overlay contract
- new insertion pipeline contract
- slimmed dictation view on top of the new core

Keep:

- existing low-level code that already satisfies the new contract

Quarantine:

- legacy dictation view logic that does not fit the new lifecycle

### Slice 2: History and Reprocess

Build:

- dictation artifact persistence aligned to the new core
- recent history view and reprocess actions

### Slice 3: Meeting Capture and Review

Build:

- narrow meeting session contract
- immediate processing state
- transcript-first persistence
- compact review surface

### Slice 4: Optional AI Enrichment

Build:

- summary
- action items
- follow-up draft

Rules:

- local-first
- cloud optional
- transcript always remains primary

### Slice 5: Cleanup and Deletion

- remove or isolate legacy APIs and oversized view paths that are no longer part of the product contract
- tighten launch claims to only what is packaged and verified

## Testing Bar

Required on every implementation slice:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

Additional required coverage:

- dictation lifecycle tests
- insertion fallback tests
- route transparency tests
- meeting processing-state tests
- transcript-first persistence tests
- platform adapter tests for macOS and Windows differences

Packaged validation required before launch claims:

- packaged dictation QA on macOS
- packaged dictation QA on Windows
- packaged meeting QA on macOS
- packaged meeting QA on Windows

## Success Criteria

The rebuild succeeds when:

- dictation feels materially faster and simpler than the current app
- meeting review is compact, trustworthy, and transcript-first
- macOS and Windows behave as one product with isolated adapter differences
- optional cloud does not block the core experience
- the codebase stops accumulating product logic in giant files
- launch messaging can be reduced to claims that have packaged proof

## Decision Record

Final approved direction:

- dictation-first product
- meeting capture and review second
- cloud optional
- macOS and Windows first-class from day one
- new core inside the same repo
