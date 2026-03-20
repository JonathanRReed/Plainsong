# Dual-Surface Core Design

Date: 2026-03-19

## Goal

Make Nautilus the strongest single-user local-first product in the category by sharpening two surfaces:

- Dictation is the hero product and must feel faster, more predictable, and more polished than today.
- Meetings remain first-class, but the target is a trustworthy bot-free meeting mode with reliable capture and a clean review loop, not broad collaboration parity.

## Product Position

Primary product promise:

- The fastest local dictation app with a trustworthy built-in meeting mode.

This pass is intentionally not a platform-everything expansion. It narrows the story so the product is easier to win with.

## Product Scope

### Dictation Hero

Dictation is the flagship surface.

Required outcomes:

- faster-feeling hotkey flow
- explicit and stable session lifecycle
- strong built-in app-aware modes
- clear delivery state from capture to insert
- better correction, history, and reprocess flow
- fewer dormant or misleading controls in the main path

### Good Meeting Mode

Meetings stay strong but focused.

Required outcomes:

- reliable bot-free capture
- clear mic-only vs mic-plus-system behavior
- transcript trust is visible
- fast stop-to-review flow
- summary, action items, and follow-up are easy to act on

### Explicitly Out Of Scope

This pass does not optimize for:

- team workspace administration
- large integration platforms
- CRM automation as a primary deliverable
- broad enterprise governance features

## Recommended Product Direction

Use a dual-surface core:

- Dictation gets the largest UX and performance investment.
- Meetings get one opinionated, polished path instead of a wide set of half-finished workflows.

## Feature Set

### Dictation

- Make the popup and controller lifecycle explicit: `idle -> primed -> recording -> processing -> delivering -> done -> error`
- Promote a smaller set of hero modes:
  - General
  - Slack
  - Notes
  - Email
  - Coding
  - Meeting follow-up
- Strengthen app-aware activation and defaults
- Show one clear delivery path status: capture, transcribe, insert
- Improve latest-result review and one-click reprocess
- Tune keep-warm and startup behavior for repeated captures
- Demote power-user controls that add friction to the main path

### Meeting Mode

- Keep one strong capture path: mic-only or mic-plus-system
- Make post-call review compact and note-first:
  - summary
  - action items
  - follow-up draft
  - transcript
  - notes
- Keep transcript trust visible with source-aware wording and explicit processing states
- Optimize for the winning loop:
  - stop capture
  - review result
  - copy or send follow-up

## Architecture

Use one shared runtime with two sharpened product surfaces.

### Shared Runtime

- capture, ASR route resolution, insertion, meeting processing, and settings persistence remain shared
- UI should read from stable surface contracts instead of scattered flags
- telemetry is product infrastructure:
  - startup latency
  - transcript-ready latency
  - insert latency
  - stop-to-summary latency

### Dictation Surface

- Dictation should be driven by a first-class lifecycle contract
- Popup, tray entry, and main Dictation view should consume the same state model
- Modes are a product layer, not just loose settings
- Reprocess and history operate on saved dictation artifacts

### Meeting Surface

- Capture remains narrow and reliable
- Review becomes the dominant product step after stop
- Meeting mode should optimize trust and speed, not collaboration breadth

## Data Flow

### Dictation

1. User triggers hotkey or popup action.
2. Session enters `primed`, then `recording`.
3. Runtime resolves dictation route, mode, and insertion policy.
4. Partial/final transcription advances lifecycle into `processing`.
5. Delivery path advances lifecycle into `delivering`.
6. Insert, paste, or clipboard completion resolves into `done` or `error`.
7. Final artifact is saved for history and optional reprocess.

### Meetings

1. User starts mic-only or mic-plus-system capture.
2. Live surface shows capture state and source availability.
3. Stop immediately transitions recording into `processing`.
4. Transcript and enrichment complete in background.
5. Review surface promotes summary, action items, and follow-up above raw transcript.

## Failure Handling

### Dictation

- Route not ready: fail with precise setup language
- Insert failure: show fallback status clearly, preserve latest text
- Low-information or hallucination-like output: prefer suppression or explicit warning over silent bad insertion
- No visible control should imply runtime behavior that is not actually wired

### Meetings

- System audio unavailable: allow mic-only or cancel-and-fix
- Processing delay: keep status visible and auto-refresh review state
- Summary/action generation failure: transcript remains usable and review still works

## Testing Bar

### Dictation

- lifecycle transitions are deterministic
- popup/controller state stays synchronized with runtime session state
- built-in hero modes and app-aware defaults persist correctly
- history and reprocess use saved artifacts, not transient UI state

### Meetings

- stop transitions immediately to processing
- review view refreshes when transcript and analysis arrive
- summary, action items, and follow-up flows remain usable even if one enrichment step fails

### Release Proof

- packaged QA must replace blocked evidence rows
- benchmark and latency artifacts must be captured from packaged execution
- signed update path and size gate must pass before any leadership claim is credible

## First Implementation Slice

Start with the dictation hero path while preserving meeting quality:

1. tighten dictation lifecycle/state presentation
2. promote and clean up hero modes with stronger app-aware defaults
3. tighten meeting review around summary, action items, and follow-up

## Success Criteria

This pass succeeds when:

- dictation feels materially faster and more predictable to use
- meeting mode feels trustworthy enough for real solo use
- the product story is sharper than a generic meeting-notes app
- no user-visible surface makes claims the runtime does not back up
