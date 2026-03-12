# Dictation Parity Launch Design

Date: 2026-03-12

## Goal

Define the launch bar for Nautilus as a local-first product with two parts:

- first-class dictation
- meeting recording, transcription, and notes

Dictation is the launch blocker. Meetings remain part of the product, but launch does not proceed until dictation reaches parity or better against Wispr Flow on packaged macOS and Windows builds.

## Product Positioning

Nautilus launches as:

- a local-first dictation app that works everywhere
- with meeting notes built in for the same solo user

The launch audience is:

- solo professionals
- founders
- operators
- sales people

Nautilus is not launching as:

- an enterprise admin product
- a team controls product
- a meeting-bot platform

## Competitive Benchmark

Benchmark date: 2026-03-12

Wispr Flow defines the relevant dictation parity bar in these areas:

- dictation in every app
- strong insertion reliability and graceful fallback behavior
- push-to-talk and hands-free operation
- smart formatting and correction behavior
- context awareness and app-specific style handling
- dictionary and snippet support
- broad multilingual support

Nautilus does not need to match Wispr Flow on breadth first. It must beat or match it on trust, insertion stability, and day-to-day usefulness for the highest-value language set.

## Launch Rules

- Dictation parity is a hard launch gate.
- macOS and Windows ship at the same time.
- Nautilus remains local-first.
- Cloud transcription may exist as an option, but not as the primary product identity.
- Existing insertion reliability must not regress while newer dictation features land.
- Meeting features cannot consume latency, QA, or architectural budget needed for dictation parity.
- Team and enterprise controls are out of scope.

## Launch Definition

Launch is approved only when Nautilus is credible on the following claim:

`The best local-first dictation app for solo professionals, with meetings included.`

This claim requires:

- reliable dictation in real desktop apps
- predictable text insertion and recovery
- smart text cleanup that improves output without surprising the user
- high-quality support for the top 10 to 20 languages
- snippets, dictionary, and correction features users can trust
- hands-free dictation that feels first-class

## Product Hierarchy

### Primary Pillar

Dictation is the primary product surface.

It must feel:

- fast
- dependable
- low-friction
- invisible when working correctly

### Secondary Pillar

Meetings are the second pillar.

They should reinforce the same product story:

- capture what you say
- preserve what happened
- help you turn speech into usable work

Meetings add value, but do not set launch sequencing.

## Scope

### Launch-Critical

- packaged macOS and Windows dictation with stable global hotkey behavior
- push-to-talk
- hands-free mode
- deterministic insertion strategies with fallback telemetry
- user dictionary with replacements and protected terms
- snippets with app scope and deterministic precedence
- smart formatting for punctuation, capitalization, lists, links, emails, and common business writing patterns
- backtrack and self-correction for a narrow explicit command set
- top 10 to 20 languages certified as GA
- app-aware styles for a small set of high-value targets
- benchmark and QA evidence for parity claims

### Launch-Allowed But Not Headline

- experimental language coverage outside the GA set
- advanced rewrite presets
- broader app-style support beyond the initial app matrix
- deeper meeting analysis features

### Out Of Scope

- team administration
- enterprise policy features
- broad workflow automation unrelated to dictation parity
- claiming 100-plus languages as launch-grade support

## Architecture

Dictation should be implemented as four layers with strict separation.

### 1. Capture And Insertion Core

Owns:

- global hotkey handling
- push-to-talk and hands-free session control
- audio capture lifecycle
- insertion mode selection
- OS permissions and trust checks
- clipboard and paste fallback paths
- remote desktop and blocked-insert fallback behavior

Rules:

- this layer stays boring and stable
- no smart feature can make capture or delivery less reliable
- every insertion outcome must emit telemetry

### 2. Recognition And Language Layer

Owns:

- ASR route selection
- model selection
- top-language mapping
- language override behavior
- auto-detect policy
- keep-warm and startup latency policy

Rules:

- launch benchmarks are built around an explicit GA language set
- the app should tell the truth about what is GA versus experimental
- language quality is measured per provider-model pair, not assumed globally

### 3. Text Intelligence Layer

Owns the deterministic post-transcription pipeline:

`raw transcript -> dictionary normalization -> command/backtrack parsing -> snippet expansion -> smart formatting -> insertion-safe text`

Rules:

- order is explicit and testable
- dictionary and snippet behavior must be deterministic
- only formatting and rewrite stages may use probabilistic behavior
- users must be able to understand why text changed

### 4. Context And Style Layer

Owns:

- app detection
- frontmost window and target metadata
- selected text and clipboard context
- app-specific style rules
- dictation mode presets

Rules:

- context is additive, not required
- if context capture fails, dictation still succeeds
- style rules should improve output, never block output

## Feature Design

### Dictionary

Dictionary v1 should support:

- custom spoken-to-written replacements
- protected capitalization and spelling
- product names, people names, and domain terms
- optional app scoping
- import and export

Dictionary rules must run before snippets and before smart formatting.

### Snippets

Snippets v1 should support:

- trigger phrase expansion
- deterministic longest-match precedence
- app-scoped snippets
- enable and disable controls
- clear auditability in telemetry and debug views

Snippets must remain literal and predictable. They are not AI features.

### Smart Formatting

Smart formatting v1 should focus on high-frequency wins:

- punctuation
- capitalization
- paragraphing
- bullets
- emails
- URLs
- phone numbers
- common business phrasing cleanup

It should prefer bounded transforms over open-ended rewriting. The goal is better default dictation text, not style-heavy generation.

### Backtrack And Self-Correction

Backtrack and self-correction should ship with a narrow, explicit set of supported commands such as:

- undo last insert
- delete last sentence
- replace previous phrase
- restart final clause

Launch quality depends on command intent precision, not command breadth.

### Hands-Free

Hands-free mode should feel equivalent in quality to push-to-talk.

It requires:

- clear start and stop cues
- false-trigger controls
- silence and endpoint tuning
- explicit user-visible recording state
- fast cancel and recovery paths

Hands-free does not launch if it feels experimental.

### Context-Aware Styles

Context-aware styles should launch narrowly.

Support only a high-value initial app matrix such as:

- Gmail
- Slack
- Notion
- Google Docs
- CRM text fields

Initial style outcomes should be constrained and obvious, for example:

- message tone
- email structure
- note formatting
- follow-up formatting

## Language Program

Launch does not attempt broad parity on sheer language count.

Instead, Nautilus certifies a top 10 to 20 language set as GA. Each language must be validated for:

- transcription quality
- insertion safety
- smart formatting behavior
- dictionary compatibility
- snippet compatibility
- hands-free usability

Languages outside that set may exist, but must be labeled experimental until benchmarked.

## Release Gates

### Reliability Gate

- insertion succeeds or degrades gracefully across the packaged app matrix
- failure modes are visible and recoverable
- newer dictation features do not regress current insertion behavior

### Quality Gate

- GA languages hit internal transcription and formatting targets
- smart formatting improves output on the benchmark set
- correction features do not introduce unacceptable false edits

### Control Gate

- dictionary, snippets, and backtrack commands behave deterministically on fixtures
- app-scoped behavior resolves consistently
- precedence rules are documented and tested

### Latency Gate

- startup, transcription, insertion, and end-to-end timing are recorded
- keep-warm behavior improves repeated dictation sessions
- smart features do not make the common path feel slow

### Trust Gate

- users can tell when dictation is recording, processing, or delivering
- users can understand when a route fell back
- users can recover from bad insertion or bad formatting quickly

## QA Matrix

The parity matrix should cover:

- macOS packaged builds
- Windows packaged builds
- target app matrix for insertion
- top-language matrix
- snippet and dictionary fixtures
- command and correction fixtures
- hands-free long-session behavior

The parity claim is not accepted based on unit tests alone. It requires packaged-build evidence.

## Success Criteria

Nautilus is ready to launch when:

- dictation is visibly stronger than prior builds in the everyday app matrix
- the top-language program is truthfully benchmarked and documented
- smart formatting and self-correction improve output without creating distrust
- snippets and dictionary feel first-class, not bolted on
- hands-free passes the same trust bar as push-to-talk
- meetings remain strong without slowing dictation execution

## Non-Goals For This Pass

- enterprise features
- team admin controls
- broad AI writing assistant positioning
- language-count marketing disconnected from quality evidence
- using meetings as the primary launch story
