# Dual-Surface Core Implementation Plan

Date: 2026-03-19

Note: the `writing-plans` skill referenced by the brainstorming workflow is not available in this session, so this implementation plan is written directly.

## Phase 1: Dictation Hero

### 1. Dictation lifecycle contract

- identify the current runtime and popup phases
- normalize them into one surface contract
- update popup and main Dictation view to use the same product states
- verify transitions for start, stop, processing, delivery, and error

### 2. Hero modes and app-aware defaults

- audit built-in dictation modes
- reduce visible defaults to the hero set
- add or refine a meeting follow-up mode
- strengthen default app matchers and rewrite prompts
- ensure persisted preferences and reprocess flows stay intact

### 3. Delivery and correction loop

- improve latest-result review messaging
- make reprocess easier to discover and faster to run
- keep fallback text visible on insert failures

## Phase 2: Good Meeting Mode

### 1. Capture state clarity

- make mic/system capture state explicit in meeting UI
- preserve the current reliable capture path
- avoid new complexity in capture routing

### 2. Clean review loop

- tighten summary, action items, transcript, notes, and follow-up layout
- promote the winning path after stop:
  - review
  - copy
  - send or act

### 3. Processing trust

- ensure immediate processing state on stop
- keep review state auto-refresh behavior obvious
- preserve transcript usability when enrichment fails

## Verification

- frontend tests for settings, hero modes, and surface behavior
- Rust tests for lifecycle and route behavior where applicable
- build verification for web and Tauri
- packaged QA still required separately before release claims

## First Work Slice For This Turn

- inspect current dictation runtime lifecycle usage
- inspect built-in mode definitions and app-aware defaults
- implement one coherent dictation-hero slice that improves visible product behavior without destabilizing capture
