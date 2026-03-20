# ASR Model Workflow Design

## Goal

Clean up Nautilus's ASR / STT model UI so it feels fast, understandable, and clearly aligned to user outcomes instead of internal engine taxonomy.

Primary product goals:

- make model choice feel simple for normal users
- separate `dictation`, `meetings`, and `shared` use cases cleanly
- stop surfacing incompatible models in the wrong places
- improve perceived and actual loading speed
- keep deeper provider/runtime controls available, but out of the main path

## Problems In The Current UI

- The current ASR surface mixes provider, model, hosting, runtime state, and route eligibility in the same layer.
- Dictation-only providers and meeting-capable providers are shown together, then explained afterward.
- The user often has to think in raw provider names before they understand what those providers are good at.
- The main model surface is slower than it should be because it loads a heavyweight provider payload up front.
- The app has overlapping surfaces for provider selection and model downloads, which creates duplication and drift.

## External Product Patterns

The redesign follows the strongest patterns from adjacent tools:

- Superwhisper organizes around workflows and modes instead of raw engine taxonomy.
- Deepgram and AssemblyAI frame model choice around use case and tradeoffs like speed, conversation fit, and accuracy.
- MacWhisper keeps model management in a dedicated surface and explicitly sets expectations for first-load cost.

## Design

### 1. Workflow-First Information Architecture

The main ASR surface should organize around three lanes:

- `Dictation`
- `Meetings`
- `Shared`

Each lane should show:

- the current selection
- one recommended option
- a small set of alternatives
- plain-language badges like `Local`, `Cloud`, `Fast`, `Meeting-ready`, `Needs download`

Rules:

- Dictation-only models never appear in the meeting lane.
- Meeting-incompatible models never appear as shared recommendations.
- Shared only shows models that are genuinely reasonable for both use cases.

### 2. Split Fast Inventory From Deep Diagnostics

The first screen should use a lightweight inventory payload only.

Fast inventory should include:

- provider id
- name
- description
- selected model id
- model options
- download status
- inference enabled
- basic availability

Deep diagnostics should load only when needed:

- runtime diagnostics
- engine diagnostics
- setup actions
- provider-specific repair details

This keeps the first paint fast and pushes heavier runtime inspection behind deliberate user intent.

### 3. Main Surface Behavior

The primary screen should focus on route selection:

- a simple `Shared` vs `Split routes` control
- if shared: show only the shared lane
- if split: show dictation and meeting lanes separately

Each lane should render compact option cards:

- one recommended option pinned first
- alternative options below
- one-click select action
- current route clearly marked

The user should not need to pick provider first and model second in the common path.

### 4. Advanced And Downloads

The raw provider cards, compatibility tools, diagnostics, and repair tools move into a secondary area:

- `Downloads`
- `Advanced`
- `Benchmark`

Those areas should lazy-load the heavier provider data only when opened.

### 5. Performance Changes

Implementation changes:

- add a lightweight backend inventory endpoint
- keep the current full provider endpoint for advanced tools
- load inventory first on the ASR page
- only load full provider diagnostics when advanced sections are expanded
- avoid duplicate provider fetches where a lighter inventory payload is sufficient

## Implementation Plan

### Phase 1

- add `get_asr_provider_inventory` to the backend
- add frontend inventory types and Tauri wrapper
- refactor the ASR manager main screen to use workflow lanes and inventory data

### Phase 2

- move downloads and raw provider cards behind lazy advanced sections
- keep benchmark separate

### Phase 3

- reuse inventory where appropriate in onboarding and other light ASR summaries
- keep full diagnostics only in places that truly need them

## Validation

- frontend tests for the workflow-first lane rendering
- tests for lane eligibility and recommended ordering
- backend tests for inventory payload shape and compatibility classification
- full `npm test`
- `npm run build`
- `cargo test --lib`
- `cargo clippy --all-targets -- -D warnings`
