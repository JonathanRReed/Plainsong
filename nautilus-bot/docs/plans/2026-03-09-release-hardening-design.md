# 2026-03-09 Release Hardening Design

## Goal

Ship a publish-ready Nautilus build that is strong in both core product modes:

- dictation should feel close to Superwhisper-class responsiveness and reliability
- meetings should be trustworthy and robust enough for real use, without allowing weak or native-only transcription paths to degrade results

This pass excludes external release steps such as paid Apple Developer signing and notarization setup, but it should leave the app technically ready for that final packaging layer.

## Product Decisions

### Dictation

- Keep Apple Native and Windows Native available for dictation.
- Keep fast local routes available for dictation.
- Optimize for immediate perceived readiness, correct per-session state, reliable insertion, and clean overlay lifecycle.

### Meetings

- Meetings are permanently separate from dictation-grade routes.
- Apple Native, Windows Native, Moonshine, and general Whisper family routes are dictation-only.
- Meetings must use meeting-grade ASR only.
- Meeting start must fail fast when the selected route or audio path is not actually viable.

## Architecture Changes

### 1. Meeting Audio Capture Reliability

Current risk:

- mixed capture assumes a fixed output sample rate
- live meeting streaming depends on a queue that mixed capture does not populate
- system audio depends on a fragile loopback discovery path

Required changes:

- make mixed capture explicitly report the sample rate it is actually producing
- ensure mixed capture feeds both the WAV writer and the live streaming queue
- preserve mic-only behavior without regression
- tighten diagnostics so dropped audio or unavailable loopback shows up as a direct user-facing failure reason

### 2. Meeting Route Validation

- enforce meeting-grade providers and models in both backend and frontend
- normalize old settings automatically
- reject unsupported meeting routes before capture starts

### 3. Dictation Startup And Popup State

- reduce misleading startup UI when capture is already effectively live
- keep popup state event-driven
- reset timer and lifecycle state strictly per session
- avoid final flash/reopen behavior after completion

### 4. macOS Window And App Lifecycle

- harden Dock reopen behavior
- avoid hide/fullscreen black-screen traps
- ensure main window restore logic reflects actual visibility/minimized/fullscreen state

## UX Requirements

### Dictation

- popup appears quickly and predictably
- elapsed time is per session, never cumulative
- startup wording matches actual state
- completion state does not flash stale transcript UI

### Meetings

- if capture starts, transcript pipeline should receive the same audio path that the file writer receives
- transcript tabs should stay usable in non-fullscreen windows
- bad model selection should produce a clear setup error, not a garbage transcript

## Testing And Release Gates

The release pass is complete only when:

- frontend tests pass
- Rust tests pass
- release build packages successfully
- dictation, meetings, popup lifecycle, window restore, and provider normalization have regression coverage where practical
- remaining publish blockers are only external operational steps, not product/runtime defects

## Out Of Scope

- paid Apple Developer enrollment
- notarization service setup
- marketing, onboarding copy polish beyond changes needed to remove misleading behavior
