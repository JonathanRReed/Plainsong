# Solo OS Parity Implementation Plan

Date: 2026-03-14
Depends on: `docs/plans/2026-03-14-solo-os-parity-design.md`

## Goal

Turn Nautilus into a coherent solo-user voice operating system in a way that preserves current working functionality while tightening the product around Wispr Flow parity for dictation and Granola parity for solo meetings.

## Principles

- Dictation trust comes first.
- Deterministic text behavior beats clever but surprising behavior.
- Solo replacements should remove collaboration language rather than mimic it.
- Meeting intelligence should build on the same private memory layer as dictation.
- New model support is only valuable if it improves a concrete product outcome.
- Product claims must be backed by packaged-build evidence.

## Workstreams

### W1. Solo OS Product Framing

Scope:

- rename top-level concepts around flows, actions, memory, and insights
- remove or replace collaboration-oriented language
- define new navigation and onboarding structure

Deliverables:

- product terminology map
- UI copy updates
- updated onboarding path for solo users
- navigation proposal for dictation, meetings, memory, and insights

Success checks:

- no primary UI copy implies teams or workspace administration
- users can understand the product in one sentence

### W2. Flow Profiles

Scope:

- refactor current dictation presets and custom modes into flow profiles
- preserve app matching, context, insertion, and prompt behavior
- add curated default flows

Deliverables:

- flow profile data model
- migration from current custom modes
- launch set of default flows
- flow management UI

Success checks:

- existing custom mode users do not lose data
- app-aware behavior remains stable after migration

### W3. Dictation Intelligence Pipeline

Scope:

- formalize the deterministic pipeline stages
- centralize dictionary, backtrack, command, snippet, and formatting stages
- expose pipeline metadata for debugging and QA

Deliverables:

- pipeline module and stage contracts
- stage ordering tests
- event payload fields for applied actions
- debug surface in dictation history details

Success checks:

- every user-visible text change can be attributed to a stage
- stage precedence is stable and testable

### W4. Backtrack Engine

Scope:

- implement a bounded correction language
- operate over recent utterance and insertion state
- separate backtrack from open-ended rewrite actions

Deliverables:

- correction grammar and parser
- recent-buffer state contract
- benchmark utterance set for correction intents
- UI explanation of supported phrases

Success checks:

- supported correction commands meet internal intent accuracy targets
- corrections do not unexpectedly rewrite older inserted content

### W5. Dictionary Studio

Scope:

- evolve the current dictionary into vocabulary, correction pairs, and auto-learn review
- add CSV import and export
- support global, app, and optional flow scope

Deliverables:

- expanded dictionary data model
- migration strategy from current entries
- auto-learn review queue
- CSV import and export path
- precedence rules documentation

Success checks:

- users can protect brand names and capitalization reliably
- learned corrections are reviewable before permanent save
- imported dictionaries behave the same as manually created entries

### W6. Smart Formatting

Scope:

- implement bounded formatting rules
- support punctuation, paragraphs, bullets, URLs, emails, and common business text cleanup
- keep formatting distinct from rewrite features

Deliverables:

- formatting rules engine
- benchmark utterance corpus
- opt-in or confidence-gated behavior where needed
- visibility into formatting transforms

Success checks:

- formatting improves readability without surprising structure changes
- formatting can be disabled or limited without breaking dictation

### W7. Hands-Free And Language UX

Scope:

- productize hands-free mode
- add active language sets and session auto-detect rules
- define GA versus experimental language labels

Deliverables:

- hands-free session policy
- language set UI
- provider-language recommendation table
- packaged QA fixtures for long sessions and multilingual usage

Success checks:

- hands-free has clear start, stop, and recovery behavior
- multilingual users can predict which languages are active
- product claims about language coverage are evidence-backed

### W8. Personal Sync And Insights

Scope:

- sync flows, dictionary, snippets, shortcuts, and preferences
- expose voice profile and usage stats
- keep the default posture private-first

Deliverables:

- sync data contract
- merge and conflict policy
- insights dashboard
- voice profile metrics definitions

Success checks:

- a user can switch devices without rebuilding their setup
- insights surface produces clear daily-use value without feeling invasive

### W9. Meeting Prep And Playbooks

Scope:

- add a meeting prep surface
- expand templates into personal playbooks
- connect prep to calendar and relationship memory

Deliverables:

- pre-meeting briefing UI
- playbook data model
- default solo-user playbooks
- playbook-aware summary and follow-up prompts

Success checks:

- users can enter a meeting with prior context visible
- playbooks improve note structure without forcing a rigid workflow

### W10. Solo Meeting Resolve Layer

Scope:

- preserve raw notes plus enhanced notes split
- improve follow-up drafting outputs
- organize summary, decisions, action items, and next steps cleanly

Deliverables:

- follow-up center
- output presets for email, DM, task list, and next agenda
- editing and regeneration rules
- trust copy around generated outputs

Success checks:

- generated notes never overwrite raw notes automatically
- follow-up drafting reduces post-meeting work for solo users

### W11. Relationship Memory

Scope:

- elevate people and company memory into a core feature
- improve commitment and change tracking across meetings
- integrate with search and follow-up

Deliverables:

- relationship memory product surface
- commitment extraction rules
- cross-meeting query flows
- memory relevance ranking

Success checks:

- users can quickly answer who, what, when, and next-step questions across past meetings
- relationship memory feels like a solo CRM replacement without CRM overhead

### W12. MLX Model Program

Scope:

- add verified `mlx-audio 0.4.1` model support where it improves product outcomes
- benchmark verified models against specific dictation and meeting jobs
- keep model choice simple in UI

Deliverables:

- Apple Silicon MLX provider family
- benchmark matrix for Moonshine, Granite Speech, Canary, and MMS
- routing recommendations by use case
- experimental evaluation queue for user-reported additional models

Success checks:

- MLX routes measurably improve latency or accuracy on Apple Silicon
- model expansion does not create provider sprawl in the main UI

## Sequenced Phases

### Phase 0: Baseline And Product Contract

Objective:

- lock current behavior and define the Solo OS product contract

Tasks:

- capture current dictation and meeting baselines
- document terminology replacements
- define success metrics for dictation trust and meeting usefulness

Exit criteria:

- baseline evidence exists
- product terminology and scope are locked

### Phase 1: Wispr Parity Foundation

Objective:

- make daily dictation feel first-class

Tasks:

- ship flow profiles
- extract the dictation pipeline
- add backtrack engine v1
- ship dictionary studio v1
- expand smart formatting

Exit criteria:

- dictation quality and recovery behavior are materially improved
- users can manage vocabulary and corrections with confidence

### Phase 2: Wispr Parity Productization

Objective:

- close the gap on hands-free, language UX, sync, and insights

Tasks:

- productize hands-free mode
- add active language sets and truthful language labeling
- add personal sync
- add voice profile and stats

Exit criteria:

- Nautilus has a credible solo-user dictation product story against Wispr Flow

### Phase 3: Granola Solo Meeting Parity

Objective:

- make meetings a strong second pillar

Tasks:

- ship meeting prep
- expand templates into personal playbooks
- add follow-up center
- strengthen relationship memory

Exit criteria:

- Nautilus has a credible solo-meeting memory story against Granola

### Phase 4: MLX Expansion And Differentiation

Objective:

- improve Apple Silicon performance and build differentiated private memory value

Tasks:

- add MLX provider family and benchmarks
- integrate best-fit verified models
- deepen cross-meeting memory and commitment recall

Exit criteria:

- model additions improve concrete user outcomes
- Nautilus moves beyond parity into product differentiation

## Verification

Every phase should end with:

- packaged-build QA on macOS and Windows where applicable
- benchmark artifacts for latency and behavior claims
- explicit regression checks for insertion and meeting-note integrity
- product review against the Solo OS positioning statement

## Risks

- expanding smart behavior without a strict pipeline can regress trust
- adding many models too early can fragment QA and confuse users
- shipping meeting polish before dictation trust is fixed will dilute the product
- retaining old workspace-oriented language will weaken the solo-user story

## Recommended First Implementation Slice

Start with the narrowest slice that materially changes perceived product quality:

1. extract the dictation intelligence pipeline
2. ship backtrack engine v1
3. ship dictionary studio v1 with bulk import
4. migrate custom modes into flow profiles

That slice directly addresses the strongest Wispr Flow gaps while preserving the rest of the existing product.
