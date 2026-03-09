# Dictation And Meeting Parity Architecture Design

Date: 2026-03-09

## Goal

Bring Nautilus to parity or better against Superwhisper for dictation and Granola-class products for meetings.

This design assumes launch can be delayed in favor of a stronger architecture.

## Product Rules

- Dictation optimizes for speed, insertion reliability, and low-friction recovery.
- Meetings optimize for transcript trust, source-aware capture, and explicit setup.
- Native speech remains dictation-only.
- Weak or fast models remain dictation-only.
- Meeting route selection is stricter than dictation route selection.
- Meeting policy is user-configurable, but defaults to `prefer local`.

## User Policy

Meetings get an explicit policy:
- `prefer local`
- `best available`

`prefer local` is the default.

Behavior:
- if a meeting-grade local route is ready, use it
- if not, and cloud fallback is allowed and configured, use the best cloud route
- otherwise fail fast with a precise setup error

## Meeting Engine

Meetings should stop treating all capture as a single mixed blob when separate sources are available.

### Capture Model

When possible, capture:
- mic source
- system audio source
- mixed convenience track

These should be persisted as distinct artifacts where available.

### Live UX

The live meeting surface should explicitly show:
- mic active / inactive
- system audio active / inactive
- mode: `mic-only` or `mic + system audio`

If system audio is unavailable, the user should be able to:
- continue mic-only
- cancel and fix setup

### Transcript Model

When separate sources exist, the system should use source-aware attribution first:
- mic as `Me`
- system audio as `Them`

Post-call enrichment can then improve speaker labels and transcript structure.

### Post-call Enrichment

After capture:
- diarization / speaker labeling
- transcript cleanup / segmentation
- title, summary, and action-item generation

## Dictation Engine

Dictation should feel instant and predictable.

### Lifecycle

Use a stricter lifecycle:
- idle
- primed
- recording
- processing
- delivering
- done

The popup should be driven by this lifecycle directly.

### Keep-warm

Add a keep-warm duration for dictation engines:
- off
- short
- long

This improves repeat dictation latency and makes Nautilus feel closer to Superwhisper.

### Delivery Modes

Expose explicit delivery modes:
- insert at cursor
- paste
- clipboard only
- auto-send (future-ready)

Dictation formatting modes should include:
- normal
- code
- literal
- rewrite / clean up

## Setup And Provider Control Plane

Setup becomes the canonical control center for:
- full onboarding
- fix dictation
- set up meetings
- provider/model doctor
- permission repair

### Doctor States

Each route should resolve to a clear state:
- ready for dictation
- ready for meetings
- model missing
- runtime missing
- key/account missing
- setup incomplete
- unsupported for meetings

### Verification

Users should be able to run:
- dictation test
- meeting route test
- system audio test
- model/runtime verification

## Implementation Order

1. Meeting engine policy and source-aware route plumbing
2. Dictation lifecycle and keep-warm improvements
3. Provider/model doctor and setup validation
4. Onboarding and recovery polish
5. Verification, packaging, and release checklist

## Release Bar

Before ship:
- automated tests for route resolution, popup lifecycle, and provider doctor states
- packaged build verification
- manual smoke tests for:
  - first-run dictation
  - external app dictation insert
  - mic-only meeting
  - mic + system audio meeting
  - cloud fallback meeting when enabled

External blockers remain:
- Apple Developer signing
- notarization
