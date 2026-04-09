# Dictation Command Surface Design

Date: 2026-03-20

## Goal

Make Nautilus feel faster and more native than lightweight dictation competitors while keeping meetings as a strong bonus. The primary judged surface is the dictation popup, not the full app.

## Competitive Context

- Dictar positions around one hotkey, live overlay, local-only privacy, and simple autopaste.
- Dictar already markets hotkey capture, live transcription, local models, and custom vocabulary on [dictar.app](https://dictar.app/).
- Raycast is the interaction benchmark for a desktop command surface: strong hierarchy, minimal chrome, high readability, and obvious next actions. Reference: [Raycast fresh look and feel](https://www.raycast.com/blog/a-fresh-look-and-feel).

Nautilus already exceeds Dictar on spoken editing, snippets, history, reprocess, and meeting review. The gap is not raw capability. The gap is immediacy, polish, and clarity.

## Product Shape

- Dictation is the hero product promise.
- Meetings remain visible as a meaningful bonus and a differentiator.
- The popup becomes the primary dictation surface.
- The full app becomes the secondary control and review surface for history, meetings, settings, vocabulary, and deeper tools.

## Surface Design

### Popup

The popup should behave like a compact native command surface rather than a status bubble.

Structure:

- top bar with mode, target app, route, and minimal window controls
- center pane with live transcript or final result
- bottom action bar with the next few high-value actions

States:

- `recording`: large transcript preview, calmer chrome, strong stop affordance
- `transcribing`: preserve preview text, avoid empty waiting states
- `done`: show the result, what happened, and direct recovery actions
- `error`: narrow to honest retry and settings actions

Actions in the `done` state:

- Copy
- Start Again
- History
- Read Aloud
- Open App when useful

### Main App

The app stays simpler and quieter than the popup.

- Keep dictation history and reprocess as the main reuse surfaces.
- Add read-aloud to latest-result and history flows.
- Keep meetings strong, but do not let them compete with dictation for top-level attention.

## Dictar-Parity Sweep

Roadmap or marketed items we should at least match in the user-facing experience:

- live overlay
- hotkey flow
- custom vocabulary
- easy clipboard/history recovery
- lightweight read-aloud

Items Nautilus already exceeds:

- voice commands
- spoken backtrack/editing
- richer history and reprocess
- meeting notes and review
- diarization-backed meeting workflows

## Implementation Slice

### Slice 1

- refresh popup hierarchy and action bar
- add shared read-aloud support
- expose read-aloud from popup and dictation history/latest-result
- tighten popup wording and result feedback

### Explicitly Deferred

- full scratchpad surface
- broad meeting UI redesign
- collaboration/integration platform work
- large settings information architecture rewrite

## Validation

- popup tests for the refreshed action bar and read-aloud
- dictation view/history tests for read-aloud entry points
- full `bun run test`
- `bun run build`
- rerun Rust tests only if backend APIs change

## Success Bar

- popup feels calmer, faster, and more intentional
- user can copy, retry, inspect history, or read aloud without leaving the popup flow
- app still feels strong for meetings and settings without becoming the dictation hero surface
