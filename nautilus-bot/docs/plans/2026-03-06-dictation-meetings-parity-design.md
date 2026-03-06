# Dictation And Meetings Parity Design

Date: 2026-03-06

## Goal

Make Nautilus the best single-user, local-first option on both primary product surfaces:

- Dictation should beat Superwhisper on local-first flexibility, speed, and trust.
- Meetings should beat Granola on local-first speed, grounded analysis, and polished note-taking workflow.
- This plan explicitly does not target team admin or collaboration parity in the near term.

This pass is not a cosmetic sweep. It corrects misleading product behavior first, then closes parity gaps, then raises the finish level.

## Research Inputs

### Competitor references

- Superwhisper public docs and changelog emphasize:
  - mode-first dictation
  - selected text, clipboard, and application context
  - recording window / mini controller
  - menu bar driven workflow
  - richer mode customization and activation
  - history inspection and reprocessing
- Granola public docs and updates emphasize:
  - note-first meeting workflow
  - templates and recipes
  - chat with notes
  - folders/workspaces
  - transcript editing improvements
  - polished meeting review flow

### Open-source references

These are implementation references, not products to copy directly:

- whisper.cpp
  - local-first inference patterns
  - fast-start transcription and streaming-oriented ergonomics
- OpenAI Whisper
  - transcript structure and segment-oriented editing assumptions
- OpenWhispr / Vocorize class of open-source dictation wrappers
  - push-to-talk UX, overlay/mini-controller patterns, insert-at-cursor handling
- Vexa / self-hosted meeting transcription projects
  - live transcript streaming, post-meeting analysis, meeting-specific retrieval patterns

We should borrow implementation lessons from them while keeping Nautilus opinionated around local-first speed and a premium shell.

## Product Truth First

The first pass must remove product lies and dead-feeling behavior:

- Meeting Notes must become real persisted data.
- Meeting Notes must be used in summaries, actions, and meeting-specific chat.
- Any UI that implies saved or reused state must be backed by persisted data.
- Dictation popup sizing and state transitions must stop clipping or feeling unstable.

## Architecture Direction

### Dictation

Dictation becomes a mode-driven writing product with three layers:

1. Modes
   - built-in presets
   - reusable custom modes
   - richer per-mode routing and activation
2. Quick controller
   - popup and tray are first-class entry points
   - quick start/stop, mode switch, history, settings
3. History and transforms
   - transcript
   - inserted result
   - prompt/context
   - rerun with another mode

### Meetings

Meetings becomes a note-first workspace with four layers:

1. Notes
   - editable note canvas
   - live notes during capture
   - template/recipe-aware structure
2. Transcript
   - searchable
   - editable
   - speaker operations
   - remove segment/range support
3. Ask
   - chat with this meeting only
   - uses transcript and notes together
   - citations required
4. Assets
   - audio
   - exports
   - metadata

## Phase Plan

### Phase 1: Correctness And Data Integrity

Ship these first:

- Persist `meeting_notes` with the recording.
- Thread meeting notes through recording start, detail view, summaries, action items, and meeting chat.
- Add meeting-level note/template metadata storage.
- Fix dictation popup sizing to be content-safe instead of fixed-height buckets.
- Remove stale copy or controls that still imply broken preview/streaming behavior.

### Phase 2: Dictation Parity With Superwhisper

- Fast-start dictation path:
  - reduce hotkey press-to-capture delay
  - reduce release-to-insert delay
  - instrument timings for capture start, transcript ready, and insert complete
- Strengthen quick controller:
  - no clipping
  - cleaner idle/recording/transcribing states
  - stable mode switch and quick actions
- Expand mode depth:
  - provider/model snapshots
  - AI route/model snapshots
  - app activation rules
  - next step: site/domain activation rules
- Improve transform UX:
  - selected text
  - clipboard
  - application context
  - clearer rewrite/reply/shorten/bulletize flows

### Phase 3: Meetings Parity With Granola

- Replace transcript-first detail view with note-first meeting workspace.
- Surface template/recipe choice in the meeting workflow, not only as a start option.
- Add meeting-specific chat tab that uses only the current meeting plus meeting notes.
- Promote summary and actions into editable note blocks.
- Add transcript delete/remove operations, not just text overwrite.
- Improve post-meeting review flow and reduce tool-like framing.

### Phase 4: Premium Finish

- Rebalance navigation so Dictation and Meetings stay obviously primary.
- Tighten copy, status language, and defaults across popups, tray, and settings.
- Reduce technical phrasing for normal users while keeping power-user controls visible.
- Audit latency and startup behavior across local routes to choose better defaults.

## Single-User Scope

The product target for this plan is a single-user local-first workflow:

- fast personal dictation
- private local meeting capture
- strong review and follow-up
- premium interface without enterprise overhead

Out of scope for this phase:

- team workspace administration
- collaboration permissions
- shared folders or org governance
- enterprise billing/SSO parity

Those features would increase product surface area without improving the primary comparison against Superwhisper and Granola for an individual buyer.

## Remaining Competitive Focus

### Phase A: Dictation controller and mode depth

- make the popup feel like a primary dictation controller
- expose clear mode summaries and overrides
- improve raw transcript vs final-output inspection
- keep latency instrumentation visible enough to tune

### Phase B: Meeting workspace quality

- strengthen the note editor beyond a plain textarea
- make regenerate workflows explicit for summary, actions, and title
- make meeting chat feel native instead of like a generic analysis panel
- surface template/recipe shaping on the meeting page itself

## Data Model Changes

### New or expanded meeting fields

- `meeting_notes`
- `meeting_template_id`
- `meeting_recipe_id` or equivalent recipe identifier
- `notes_updated_at`
- optional `meeting_chat_threads` or meeting-scoped chat history

### Dictation mode expansion

Current custom modes already persist:

- dictation provider/model
- AI provider/model
- app matcher

Next additions:

- optional site/domain matcher
- explicit language override
- optional insertion override
- optional transform preset override

## UX Rules

### Dictation

- Normal users should succeed without touching lower controls.
- Popup and tray must feel safe to use as the primary product shell.
- History must explain what happened without debug language.
- Modes should be understandable by outcome, not architecture.

### Meetings

- The first thing the user sees after capture should feel like notes, not raw infrastructure.
- Notes, transcript, and AI outputs should reinforce each other instead of living in separate silos.
- Citations stay visible whenever AI claims something factual about a meeting.

## Error Handling

- Never silently downgrade important product behavior.
- If context capture fails, say which source failed and continue with a safe fallback.
- If a mode auto-activates, show why.
- If meeting analysis excludes notes because they were unavailable, show that explicitly.
- If local-first routes are not ready, fail clearly and offer the next best supported route.

## Testing Strategy

### Automated

- Settings persistence tests for new mode and meeting-note fields
- dictation popup regression tests for state and sizing logic
- meeting detail tests for note persistence and tab behavior
- transcript edit and remove tests
- provider timing instrumentation tests where practical

### Manual

- Dictation:
  - hotkey press-to-start
  - release-to-insert
  - popup idle/recording/error states
  - context capture across native and Electron apps
- Meetings:
  - type notes during recording
  - confirm notes persist after close/reopen
  - rerun summary/actions after note edits
  - meeting chat answers with transcript citations

## Success Criteria

We should not call this done until:

- Meeting Notes are real and influence downstream behavior.
- Dictation start and insert latency feel clearly competitive.
- Popup and tray no longer feel fragile or clipped.
- Meeting detail feels like a note workspace, not a transcript utility.
- The app can honestly claim:
  - better local-first dictation flexibility than Superwhisper
  - better local-first meeting intelligence and evidence than Granola
