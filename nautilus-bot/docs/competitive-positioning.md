# Competitive positioning and roadmap

Last reviewed: 2026-07-27

This document keeps product claims tied to current, first-party evidence. It is
not launch copy and it should not be used as a substitute for release QA.

## Current market facts

- Free, local, open-source dictation is a crowded category. Handy is MIT,
  cross-platform, and added streaming model support in
  [v0.9.0](https://github.com/cjpais/Handy/releases/tag/v0.9.0) on 2026-07-01.
- Local dictation plus local meeting capture is not unique. Muesli describes
  local dictation, simultaneous microphone and system-audio meeting capture,
  live transcripts, diarization, and local model support in its
  [public MIT repository](https://github.com/pHequals7/muesli).
- Superwhisper offers both voice typing and device-side
  [meeting transcription](https://superwhisper.com/meeting-transcription),
  including optional speaker separation.
- Granola is a useful contrast for privacy positioning, but claims must remain
  precise. Granola's own [security page](https://www.granola.ai/security) says
  it uses transcription providers such as Deepgram and AssemblyAI and AI
  providers such as OpenAI and Anthropic.
- Anarlog remains open source, MIT-licensed, and maintained. Its
  [repository](https://github.com/fastrepl/anarlog) says the team is primarily
  building Char while keeping Anarlog available as the local-first meeting
  notetaker.

Do not use star counts, fundraising estimates, review scores, legal allegations,
or competitor incident claims in public copy unless they are re-verified from a
primary source during the release review.

## Plainsong's defensible position

Plainsong should compete on a complete local workflow, not on an exclusivity
claim that the market has already invalidated:

1. Local dictation and bot-free meeting capture in one auditable MIT codebase.
2. No account required for local use.
3. Local transcription by default, with remote processing disabled until the
   user explicitly enables and configures it.
4. User-controlled storage, retention, export, backup, and reset behavior.
5. Provider choice for optional analysis, including local Ollama.
6. Honest release evidence for signing, notarization, permissions, insertion,
   capture, recovery, and update behavior.

The product loses credibility if any one of those claims is represented by a
placeholder control, a source-only test, or an unverified package.

## What the product should lead with

The near-term story is:

> Private dictation and meeting transcription that stay under your control.
> Use local models, keep your data on your Mac, and inspect the MIT source.

Streaming alone is not a moat now that Handy and Muesli publicly ship streaming
paths. It remains valuable product behavior, but it should be evaluated against
reliability, model size, language coverage, power use, and final transcript
quality before it becomes a launch claim.

The strongest demo is an end-to-end workflow:

1. Hold the dictation shortcut and insert text into the intended app.
2. Capture microphone and system audio without a meeting bot.
3. Persist a transcript before optional diarization or analysis begins.
4. Review, correct, search, export, back up, and delete the result locally.
5. Show that remote processing is optional and visibly controlled.

## Release priorities

### 1. Package trust

Ship a Developer ID signed, notarized, stapled, Gatekeeper-approved build.
Verify every bundled native helper has only its intended entitlements. Test the
updater from an installed prior version to the candidate version.

### 2. Real workflow proof

Run packaged-app checks for first launch, permissions, dictation insertion,
meeting capture, transcript persistence, retention, backup and restore, reset,
and error recovery. Source tests are necessary but do not prove these flows.

### 3. Meeting correctness

The unlabelled transcript must become durable and visible before best-effort
diarization. Uncovered speech must stay unattributed instead of being assigned
to a named speaker. Native system-audio capture should be preferred where the
supported macOS and CPAL path is proven, with virtual loopback retained only as
an explicit compatibility fallback.

### 4. Analysis integrity

Summaries and action items must cover the full transcript, preserve provider and
model provenance, distinguish provider policy blocks from transport failures,
and expose degraded results instead of silently truncating or inventing
coverage.

### 5. Public claims

Every claim in the README, website, screenshots, and release notes must match
the packaged candidate. Do not claim notarization, native capture, real-time
behavior, local-only processing, or cross-app insertion from source inspection
alone.

## Deliberately deferred

- Cross-meeting agent memory and MCP access, until local search and transcript
  review are proven useful and an explicit read-only boundary is designed.
- A Tauri migration, until it is justified by a supported-platform plan and
  measured product constraints.
- Persistent speaker voiceprints, until opt-in storage, deletion, consent, and
  model-specific thresholds are designed and tested.
- A hosted sync business, until the local backup and bring-your-own-cloud
  workflow is reliable and the privacy boundary is documented.
- Broad automation or computer-control claims.

Deferred work is not a broken promise. It becomes one only if the UI or public
copy presents it as available.

## Sustainability

The local core should remain useful without an account, subscription, or hosted
service. Plausible funding paths include GitHub Sponsors, paid support, and
optional hosted convenience services that do not reduce the local feature set.

Do not promise "free forever" or a hosted tier before there is an explicit
maintainer commitment and an operating plan. The durable promise today is
narrower: the repository is MIT-licensed, the local workflow is the product,
and optional remote services must remain opt-in.

## Review cadence

Recheck competitor capabilities and links before each public release. Record the
review date at the top of this file. Prefer product documentation, release
notes, and source repositories over commentary or social posts.
