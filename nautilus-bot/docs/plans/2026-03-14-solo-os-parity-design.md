# Solo OS Parity Design

Date: 2026-03-14

## Goal

Define Nautilus as a solo-user voice operating system that matches the highest-value product outcomes of Wispr Flow and Granola without inheriting their team and collaboration surface area.

Nautilus should launch a clear product claim:

`A private voice workspace for solo professionals: dictate anywhere, capture meetings without bots, and turn speech into usable follow-through.`

## Product Positioning

Nautilus is:

- a local-first dictation product for daily work
- a bot-free meeting memory product for one person
- a private memory layer that helps users recall people, commitments, and follow-ups

Nautilus is not:

- a team collaboration suite
- a workspace admin product
- a meeting bot platform
- a shared CRM or team knowledge base

## Benchmark

Benchmark date: 2026-03-14

### Wispr Flow parity bar

Wispr Flow is the relevant parity bar for dictation in these areas:

- app-aware dictation
- command and transform behavior
- dictionary quality and correction learning
- snippets and bulk import
- smart formatting and backtrack
- hands-free operation
- multi-language support
- personal sync and stats

Reference sources used in design validation:

- https://docs.wisprflow.ai/articles/4678293671-feature-context-awareness
- https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode
- https://docs.wisprflow.ai/articles/4108368778-style-your-dictation-with-flow-styles
- https://docs.wisprflow.ai/articles/4052411709-teach-flow-your-words-with-the-dictionary
- https://docs.wisprflow.ai/articles/8955301725-how-do-i-bulk-import-for-dictionary-and-snippets
- https://docs.wisprflow.ai/articles/4297638257-smart-formatting-and-backtrack-in-wispr-flow
- https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free
- https://docs.wisprflow.ai/articles/3191899797-use-flow-with-multiple-languages
- https://docs.wisprflow.ai/articles/5284722493-sync-flow-across-your-devices
- https://docs.wisprflow.ai/articles/4035125515-voice-profile-your-personalized-dictation-insights

### Granola parity bar

Granola is the relevant parity bar for meetings in these areas:

- bot-free meeting capture
- raw notes plus enhanced notes
- meeting chat grounded in transcript context
- custom templates
- calendar context
- people and company memory

Reference sources used in design validation:

- https://help.granola.ai/article/transcription
- https://help.granola.ai/article/ai-enhanced-notes
- https://help.granola.ai/article/chatting-with-your-meetings
- https://help.granola.ai/article/customise-notes-with-templates
- https://help.granola.ai/article/signing-in-and-connecting-your-calendar
- https://help.granola.ai/article/people-and-companies

## Current Nautilus Position

Nautilus already contains many of the right raw parts:

- dictation modes, prompts, routing, insertion, and app/domain activation
- dictionary entries with auto-learn support
- snippets with app scope
- prefix-based command mode
- meeting templates
- editable notes plus enhanced notes
- meeting chat
- summaries and action items
- transcript preview, transcript editing, and diarization
- relationship memory

The product problem is not missing fundamentals. The problem is that the experience still feels like a flexible power-user tool rather than a coherent solo-user operating layer.

## Product Thesis

Solo OS should unify Nautilus around one simple loop:

`Capture -> Understand -> Follow through -> Recall`

This loop has two pillars:

### Pillar 1: Dictation OS

The user should be able to speak naturally in any app and trust Nautilus to:

- hear the right words
- format them correctly
- adapt to the current app
- recover from self-corrections cleanly
- remember personal vocabulary and writing habits

### Pillar 2: Meeting OS

The user should be able to capture a meeting privately and trust Nautilus to:

- preserve what happened
- keep raw notes and generated notes distinct
- surface decisions and follow-ups
- remember prior context about people and companies
- help draft the next action without sharing data with a team system

## Solo Replacements For Team Features

The product should intentionally replace collaboration concepts with solo equivalents:

- shared snippets -> personal snippet packs
- shared dictionary -> personal synced dictionary
- team styles -> personal flow profiles
- workspace admin -> private profile and device sync
- CRM memory -> relationship memory
- team templates -> personal playbooks
- shared follow-up workflows -> private follow-up center

## User Experience Model

Nautilus should expose four top-level concepts.

### 1. Flows

Flows are app-aware personal dictation profiles.

Each flow defines:

- base intent such as chat, email, notes, document, coding, or meeting follow-up
- insertion behavior
- context source
- language preferences
- app or domain activation rules
- optional rewrite or cleanup style

Flows replace the current mix of presets and custom modes as the primary product language.

### 2. Actions

Actions are voice-driven text operations that happen during or immediately after dictation.

They include:

- punctuation and formatting
- backtrack and self-correction
- rewrite shorter
- rewrite professional
- bulletize
- send or submit in hands-free mode

Actions should feel deterministic when they affect insertion behavior and bounded when they affect style.

### 3. Memory

Memory is the user’s private voice knowledge layer.

It includes:

- dictionary entries
- correction pairs
- snippets
- learned corrections
- recent dictation context
- relationship memory across meetings

### 4. Insights

Insights turns usage and history into private product feedback.

It includes:

- dictation speed and latency
- top apps and top flows
- correction rate
- snippet and command usage
- language mix
- time saved estimate
- a private voice profile

## Dictation Design

Dictation is the primary product surface and the primary launch gate.

### Flow Profiles

Nautilus should ship opinionated default flows:

- Work Chat
- Personal Chat
- Email
- Notes
- Long-form Writing
- Coding
- Meeting Follow-up

Each flow should support:

- app and domain targeting
- local or cloud route preference
- insertion mode
- context source
- live preview
- optional language override

### Backtrack Engine

Backtrack must be a first-class deterministic layer, not a side effect of generic rewriting.

Supported launch behaviors:

- `scratch that`
- `actually`
- `no, say`
- `replace X with Y`
- `new line`
- `new paragraph`
- spoken punctuation
- list cues such as numbered list and bullet list

The engine should operate over the recent utterance buffer and recent insertion state.

Rules:

- it should be narrow and explicit at launch
- it should never silently rewrite older content outside the active correction window
- it should produce debuggable applied-action metadata

### Dictionary Studio

The current dictionary surface should evolve into a richer personal vocabulary product.

It should support:

- vocabulary entries
- correction pairs
- capitalization protection
- app-scoped rules
- optional flow-scoped rules
- auto-learn review queue
- bulk CSV import and export

Pipeline precedence must be explicit:

`raw transcript -> dictionary normalization -> backtrack and command parsing -> snippet expansion -> smart formatting -> insertion-safe text`

### Smart Formatting

Smart formatting should focus on high-frequency trust-building wins:

- punctuation
- capitalization
- paragraphing
- bullets and numbered lists
- email addresses
- URLs
- phone numbers
- common business phrasing cleanup

Formatting should be bounded and inspectable. It is not open-ended generative editing.

### Hands-Free

Hands-free mode should become a productized mode rather than a hidden setting.

It should support:

- visible active-state feedback
- silence-based end detection
- voice submit actions such as `press enter`
- fast stop and recovery behavior

### Language Model

Language UX should move from a single generic language selector to a personal language model:

- active language set per flow
- session auto-detect within a chosen set
- truthfully labeled GA versus experimental languages
- per-language provider recommendations

### Sync

Nautilus should add personal profile sync for:

- flows
- dictionary
- snippets
- shortcuts
- recent notes and preferences

Sync is a solo convenience feature, not a collaboration feature.

### Voice Profile And Stats

Nautilus should expose a private insights surface inspired by Wispr Flow’s recent voice profile direction.

It should show:

- words dictated
- sessions per day
- top target apps
- top flows
- correction rate
- snippet usage
- command usage
- estimated time saved
- language distribution

This should remain private-first and local-first in storage and defaults.

## Meeting Design

Meetings are the secondary pillar and should reinforce the same solo story.

### Meeting Lifecycle

The meeting product should be organized into:

- Prepare
- Capture
- Shape
- Resolve
- Recall

### Prepare

Before a meeting, Nautilus should show:

- calendar title and attendees
- previous meeting recap
- relationship memory
- active commitments
- suggested template or playbook
- optional agenda draft

### Capture

Capture remains bot-free and consent-forward.

During capture Nautilus should show:

- active recording state
- capture mode
- consent status
- transcript preview
- editable raw notes

### Shape

Raw notes and enhanced notes should remain distinct artifacts.

Product rule:

- generated notes never silently overwrite raw notes

### Resolve

After a meeting, Nautilus should produce editable outputs:

- summary
- decisions
- action items
- follow-up drafts
- next-meeting agenda
- personal task list

### Recall

Every meeting should become part of a searchable private memory system.

Recall should answer:

- what was decided
- what did I promise
- what objections came up
- what changed since the last meeting
- what follow-up is still open

## Relationship Memory

Relationship memory should be promoted from a dashboard extra to a core solo-user feature.

It should aggregate:

- people
- companies
- recent snippets
- dates seen
- prior commitments
- relevant meeting history

The product framing should be:

`Remember everyone you talk to without maintaining a CRM.`

## Personal Playbooks

Meeting templates should evolve into personal playbooks.

Launch playbooks:

- 1:1
- Standup
- Sales
- Interview
- Brainstorm
- Coaching
- Research call
- Doctor
- Legal
- Personal admin

Each playbook should define:

- note sections
- summary prompt
- action item framing
- follow-up output presets

## MLX Audio Strategy

Nautilus should treat `mlx-audio` as an Apple Silicon acceleration lane, not as the product story.

Verified public surface for `mlx-audio 0.4.1` on 2026-03-14 includes support for:

- Granite Speech
- Canary
- Moonshine
- MMS

Reference sources:

- https://pypi.org/project/mlx-audio/
- https://github.com/Blaizzy/mlx-audio

Model role recommendations:

- Moonshine: fast dictation candidate
- Granite Speech: general dictation and multilingual candidate
- Canary: meeting-grade multilingual candidate
- MMS: long-tail language coverage candidate

Rules:

- model expansion should support product parity goals
- do not expose model sprawl as the primary UI
- group these under an Apple Silicon MLX provider family
- benchmark per use case instead of marketing every model equally

User-reported additional models such as FireRedASR2-AED, SenseVoice, and Fish Audio S2 Pro should be treated as future evaluation candidates unless independently verified in public release material.

## Architecture

Solo OS should be implemented as six layers.

### 1. Capture And Delivery Core

Owns:

- hotkeys
- push-to-talk
- hands-free session state
- audio capture lifecycle
- insertion strategies
- permission and fallback handling

### 2. Recognition And Routing Layer

Owns:

- provider selection
- model selection
- keep-warm policy
- GA language routing
- MLX route selection on Apple Silicon

### 3. Dictation Intelligence Pipeline

Owns:

- dictionary
- backtrack
- command parsing
- snippets
- smart formatting
- action metadata

### 4. Context And Flow Layer

Owns:

- app detection
- selected text and clipboard context
- flow matching
- style behavior

### 5. Meeting Memory Layer

Owns:

- notes
- enhanced notes
- summaries
- action items
- transcript chat
- relationship memory

### 6. Insights And Sync Layer

Owns:

- voice profile
- usage analytics
- personal sync
- user-facing trust and diagnostics

## Scope

### Launch-Critical

- Wispr-grade dictation trust for solo users
- backtrack and smart formatting
- richer dictionary system with import and auto-learn review
- app-aware flows
- hands-free mode
- truthful multilingual launch support
- Granola-grade bot-free meeting workflow for one person
- raw notes plus enhanced notes split
- meeting chat and follow-up drafting
- relationship memory

### Launch-Allowed But Not Headline

- broader long-tail language support outside the GA set
- experimental MLX models beyond the verified set
- deeper cross-device sync polish
- deeper TTS workflows

### Out Of Scope

- team workspaces
- multi-user collaboration
- enterprise admin controls
- meeting bot attendance
- shared CRM integrations as a primary product identity

## Sequencing

The product should ship in this order:

1. Wispr-grade dictation parity
2. Granola-grade solo meeting parity
3. MLX model expansion in support of those product goals
4. Voice profile and cross-meeting memory differentiation

This order preserves daily-use frequency first, then expands the memory and follow-up layer, then adds differentiated model depth.

## Success Criteria

Nautilus is ready for this product position when:

- dictation feels trustworthy enough to replace keyboard-first writing in daily work
- backtrack and dictionary behavior are predictable and explainable
- meetings produce better follow-through without requiring a bot or team workspace
- users can recover prior context about people, companies, and commitments quickly
- model choice improves product outcomes without increasing user confusion
