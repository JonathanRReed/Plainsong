# Meeting, Dictation, And Setup Doctor Design

Date: 2026-03-09

## Goals

- Make meetings reliable enough to compete with Granola-class desktop capture.
- Make dictation feel instant and predictable enough to compete with Superwhisper-class dictation UX.
- Turn Setup into a real control plane for permissions, models, runtimes, and meeting viability.

## Principles

- Prefer local by default, but let the user opt into best-available quality.
- Separate dictation and meetings as different product engines with different optimization goals.
- Fail fast with explicit setup reasons instead of recording and producing low-trust output.
- Keep the first-pass live meeting transcript pragmatic, then enrich it after capture.

## Architecture

### 1. Source-Aware Meeting Engine

- Record microphone and system audio as distinct sources when both exist.
- Persist:
  - `mic.wav`
  - `system.wav`
  - mixed convenience track for playback/export
- Expose live capture state:
  - `Mic: active/inactive`
  - `System audio: active/inactive`
  - `Mode: mic-only` or `mic + system audio`
- Use source-aware attribution in the first pass:
  - microphone -> `Me`
  - system audio -> `Them`
- If system audio is unavailable:
  - let the user continue mic-only or cancel and fix setup

### 2. Dictation Lifecycle

- Formal lifecycle:
  - `idle`
  - `primed`
  - `recording`
  - `processing`
  - `delivering`
  - `done`
- Add keep-warm behavior for dictation engines.
- Popup behavior:
  - appear immediately
  - reset per session
  - never reuse elapsed time from prior sessions
  - never show misleading warmup when capture is already live
- Delivery becomes an explicit subsystem:
  - insert at cursor
  - paste
  - clipboard only

### 3. Setup Doctor

- Keep `Setup` as a top-level workspace.
- Add explicit doctor states per route:
  - ready for dictation
  - ready for meetings
  - model missing
  - runtime missing
  - key/account missing
  - unsupported for meetings
  - system audio unavailable
- Guided verification actions:
  - test dictation
  - test meeting route
  - check system audio
  - repair permissions
  - verify models
- Meeting policy:
  - prefer local
  - best available

### 4. Post-Call Enrichment

- Keep live transcript pragmatic and source-aware.
- After capture, run enrichment:
  - segment cleanup
  - diarization / speaker labeling
  - speaker rename suggestions
  - title / summary / action items

## Implementation Order

1. Source-aware meeting engine
2. Dictation lifecycle / keep-warm / popup cleanup
3. Setup doctor expansion
4. Post-call enrichment
5. Verification and packaging

## Verification

- Rust tests:
  - meeting route resolution
  - source-aware capture logic
  - policy-based route selection
- Frontend tests:
  - popup lifecycle
  - setup doctor states
  - source-aware meeting status surfaces
- Packaged build verification:
  - app build
  - signed app bundle
  - dmg bundle

