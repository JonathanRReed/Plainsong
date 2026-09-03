# Competitive positioning and roadmap

Last reviewed: 2026-08-27

This document keeps product claims tied to current, first-party evidence. It is
not launch copy and it should not be used as a substitute for release QA.
Competitor facts below are attributed research, not first-party verification —
this repository cannot confirm what another product ships. Recheck them from
primary sources before any public claim relies on them.

## Current market facts

- Free, local, open-source dictation is a crowded category. Handy is MIT,
  cross-platform, and added streaming model support in
  [v0.9.0](https://github.com/cjpais/Handy/releases/tag/v0.9.0) on 2026-07-01.
- Local dictation plus local meeting capture is not unique, and the field
  contesting it has widened. Muesli describes local dictation, simultaneous
  microphone and system-audio meeting capture, live transcripts, diarization,
  and local model support in its
  [public MIT repository](https://github.com/Muesli-HQ/muesli). Its own
  one-line description is "local meeting transcription + dictation for macOS
  (Granola + WisprFlow alternative)" — the same sentence we would write about
  ourselves. As of Aug 2026 research, Handy and VoiceInk are also each
  reported to have moved toward covering both dictation and meeting-style
  capture, not just dictation alone. **Do not claim Plainsong is the only
  free, open-source, local-first app doing both pillars** — that claim was
  already weakening before this review and should be treated as retired
  until independently re-verified against each project's current README and
  releases immediately before any public copy ships.
- Superwhisper offers both voice typing and device-side
  [meeting transcription](https://superwhisper.com/meeting-transcription),
  including optional speaker separation.
- Granola is a useful contrast for privacy positioning, but claims must remain
  precise. Granola's own [security page](https://www.granola.ai/security) says
  it uses transcription providers such as Deepgram and AssemblyAI and AI
  providers such as OpenAI and Anthropic. As of Aug 2026 research, Granola has
  pivoted toward enterprise positioning and now caps its free tier at 25
  notes — a meaningful contrast with Plainsong's retention model, which
  defaults every recording and dictation history entry to "never delete"
  (`dictation_retention_preset` / `meeting_retention_preset` both default to
  `"never"` in `rust-sidecar/src/settings.rs`) until the user chooses
  otherwise. There is no note count, recording count, or history-length cap
  anywhere in this codebase. This is a verifiable, repo-grounded contrast —
  Granola's cap is attributed research and should be re-verified before it
  appears in public copy, but Plainsong's absence of any cap is a first-party
  fact.
- As of Aug 2026 research, destination-app-aware AI formatting (dictation
  cleanup that adapts to the app being dictated into) is now table stakes
  across this category, not a differentiator. Plainsong has this
  (`src/lib/dictation-profiles.ts`'s per-app style presets), but so, by this
  research, do multiple competitors — do not lead with it as unique.
- Anarlog remains open source, MIT-licensed, and maintained. Its
  [repository](https://github.com/fastrepl/anarlog) says the team is primarily
  building Char while keeping Anarlog available as the local-first meeting
  notetaker.

Do not use star counts, fundraising estimates, review scores, legal allegations,
or competitor incident claims in public copy unless they are re-verified from a
primary source during the release review.

## Install size

Competitor figures read from the GitHub releases API on 2026-07-28, exact
bytes, not vendor marketing. Ours is `bun run gate:size` plus a `hdiutil`
measurement of the disk image.

| Product | Download | Note |
| --- | --- | --- |
| Handy `v0.9.4` aarch64 | 17 MB | MIT, Tauri, also Intel/Windows/Linux |
| VoiceInk `v2.1` | 30 MB | closest architectural comparison: macOS-only, Apple Silicon, local-first |
| Muesli `v0.8.0` | 90 MB | does both surfaces, as we do |
| Plainsong `0.9.0-beta.1` candidate | 136 MB | 352 MB installed — superseded, kept for the trend |
| **Plainsong at `parity-waves`, 2026-09-02** | **123 MB** | **297 MB installed**; unsigned pack build, and the download figure is `hdiutil` on that bundle (129,218,471 bytes), not a release artifact |

The 2026-09-02 numbers are an **unsigned `electron:pack` build** measured on an
M4 Pro running macOS 27.0; a signed, notarized `release:mac` adds signatures
and a notary ticket and will read slightly larger. Receipt, with the
per-directory before/after:
`artifacts/qa/shell-size-receipt-2026-09-02.md`.

87 MB came off the installed application in one afternoon by removing two
things nothing could reach: Chromium's UI translations for 54 languages the
product has never been translated into (46 MB) and a second, unreachable copy
of every renderer dependency inside `app.asar` (41 MB). The download fell by a
further 3 MB from switching the disk image to lzfse. None of that changes the
shape of the problem.

There is still no architecture defence: **227 MB of the 297 MB installed is the
Electron framework** — 183 MB of Chromium binary, 24 MB of its graphics
libraries, 19 MB of framework resources — 39 MB of what is left is the Rust
sidecar, and 19 MB is the Chromium licence file we are required to distribute.
Everything Plainsong itself wrote is now 4 MB, and it was 4 MB before. The
remaining trims are Electron's to give, which is the case for the Tauri
migration rather than against it: the ceiling on this approach is roughly where
we now stand. Every
competitor above also ships a small-model option (Handy's Moonshine V2 Tiny is
~31 MB against our 148 MB `base.en`), so their realistic floor is far below
ours.

The "1.9 MB idle RSS on the sidecar, 0.45% average idle CPU" this section used
to claim is **withdrawn until it is re-measured.** The 2026-09-02 attempt could
not reproduce it — the sidecar read 10–15 MB RSS across ten runs — and the
machine was swapping too hard for any of those runs to settle the question
either. Do not use an idle-memory figure in copy until a quiet-machine
measurement exists. It was never a comparison we won in any case: nobody else
publishes one.

**Do not publish a comparison table.** Even at 297 MB we lose most rows, and
the table invites exactly the diff that embarrasses us.


## Plainsong's defensible position

Plainsong should compete on a complete local workflow, not on an exclusivity
claim that the market has already invalidated. The durable wedge, in order of
how well this repository can currently back it, is: **local-only, no-account,
unlimited history, and honest engineering** — not "the only app that does
both pillars," which is no longer defensible per the research above.

1. Local dictation and bot-free meeting capture in one auditable MIT codebase
   (shared with other projects now — a workflow claim, not an exclusivity
   claim).
2. No account required for local use.
3. Local transcription by default, with remote processing disabled until the
   user explicitly enables and configures it.
4. Unlimited local history by default: no note cap, no recording cap, and no
   forced deletion — retention is user-controlled and off by default (see the
   Granola contrast above). This is a claim this repository can back directly.
5. User-controlled storage, retention, export, backup, and reset behavior.
6. Provider choice for optional analysis, including local Ollama.
7. Honest release evidence for signing, notarization, permissions, insertion,
   capture, recovery, and update behavior.

The product loses credibility if any one of those claims is represented by a
placeholder control, a source-only test, or an unverified package.

### Claims that must not be made

- **Do not claim to be the only free, open-source, local-first app that does
  both dictation and meeting capture.** Muesli, and per Aug 2026 research
  Handy and VoiceInk, each contest this.
- **Do not lead with context-aware/destination-app-aware formatting as a
  differentiator.** Per Aug 2026 research it is now table stakes in this
  category.
- **Do not claim Granola feature parity**, and do not cite Granola's free-tier
  cap, pricing, or enterprise positioning as current fact in public copy
  without re-verifying it from Granola's own site immediately beforehand —
  it is attributed research here, not first-party evidence.
- **Do not claim Whisperflow or Raycast speed parity** without a controlled,
  same-hardware comparison (see `LAUNCH.md`).
- **Do not claim unlimited history is unique in the category.** This
  repository can verify Plainsong imposes no cap; it cannot verify that no
  competitor does the same.

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
