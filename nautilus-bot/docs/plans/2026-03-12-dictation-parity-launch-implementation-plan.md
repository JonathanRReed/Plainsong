# Dictation Parity Launch Implementation Plan

Date: 2026-03-12
Depends on: `docs/plans/2026-03-12-dictation-parity-launch-design.md`

## Goal

Execute the dictation parity launch program without regressing existing insertion reliability, while keeping meetings functional as the secondary product pillar.

This plan assumes:

- launch can wait for quality
- macOS and Windows ship together
- dictation parity is the release blocker
- Nautilus remains local-first with optional cloud paths

## Principles

- Protect current insertion behavior before expanding smart features.
- Keep dictation core and dictation intelligence separate.
- Certify a narrow GA language set instead of over-claiming breadth.
- Prefer deterministic text transformations over open-ended AI behavior.
- Packaged-build evidence is required for launch decisions.
- Meetings can advance in parallel only if they do not compete with dictation parity work.

## Workstreams

### W1. Dictation Core Hardening

Scope:

- preserve current insertion behavior
- centralize insertion strategy selection
- harden fallback behavior
- improve telemetry for paste, inline, and clipboard-only outcomes
- expand packaged smoke coverage

Deliverables:

- explicit insertion outcome contract
- platform-specific regression fixtures
- packaged app matrix for core dictation paths
- failure-state UI and diagnostics polish

Success checks:

- no regression in existing insert flows
- packaged dictation succeeds in the target app matrix
- telemetry captures insertion mode used and failure reason

### W2. Text Intelligence Pipeline

Scope:

- formalize the post-transcription pipeline
- centralize dictionary, command, snippet, and formatting stages
- document stage precedence
- expose per-stage metrics and debug fields

Deliverables:

- shared dictation pipeline module
- pipeline stage result types
- deterministic fixture suite for stage ordering
- event payload fields for pipeline effects

Success checks:

- raw transcript, transformed transcript, and applied actions are inspectable
- snippet and command behavior survives pipeline extraction unchanged
- smart formatting can be enabled without destabilizing core delivery

### W3. Dictionary v1

Scope:

- replacement rules
- protected spellings and capitalization
- app-scoped entries
- import and export
- conflict policy and precedence

Deliverables:

- dictionary data model and CRUD surfaces
- normalization engine integrated into the pipeline
- dictionary fixtures for product, person, and brand terms
- migration or defaults strategy if needed

Success checks:

- protected terms persist exactly through dictation
- dictionary entries do not conflict unpredictably with snippets
- user-visible management is simple and trustworthy

### W4. Snippets v1 Hardening

Scope:

- verify current snippet behavior under the formal pipeline
- strengthen app-scope matching
- add benchmark fixtures across target apps
- improve observability

Deliverables:

- snippet precedence and matching spec
- app-scope normalization rules
- benchmark corpus for literal expansions
- UI polish for high-volume snippet management

Success checks:

- longest-match precedence remains deterministic
- app-scoped behavior is stable on macOS and Windows
- snippets feel instant and literal in real use

### W5. Smart Formatting And Correction v1

Scope:

- implement bounded formatting transforms
- define supported self-correction and backtrack commands
- separate formatting from open-ended rewrite behavior
- benchmark quality improvements

Deliverables:

- formatting rules engine or bounded formatter layer
- explicit correction command parser and actions
- benchmark utterance corpus for punctuation and correction
- opt-in controls where probabilistic behavior exists

Success checks:

- formatting improves readability on benchmark utterances
- correction commands meet internal intent accuracy targets
- false edits remain below the agreed launch threshold

### W6. Language GA Program

Scope:

- choose 10 to 20 launch languages
- map each language to supported provider-model routes
- validate formatting, snippets, and dictionary behavior per language
- mark non-certified languages experimental

Deliverables:

- GA language list
- provider-model recommendation table
- benchmark corpus per launch language
- UI labeling for GA versus experimental language support

Success checks:

- each GA language has evidence-backed routing guidance
- product copy reflects actual certified support
- multilingual dictation behaves consistently in the certified set

### W7. Hands-Free Mode

Scope:

- endpointing and silence behavior
- false-trigger mitigation
- visible recording and stop cues
- recovery behavior when hands-free fails

Deliverables:

- hands-free session policy
- endpoint tuning and diagnostics
- long-session QA fixtures
- onboarding and settings clarity for mode selection

Success checks:

- hands-free passes the same trust bar as push-to-talk
- false triggers and stuck sessions are rare and diagnosable
- users can always stop or recover quickly

### W8. Context-Aware Styles v1

Scope:

- choose a narrow app matrix
- define explicit style transforms per app class
- ensure context capture is additive only
- add fallbacks when context is unavailable

Deliverables:

- app-style rule registry
- target app detection normalization
- style benchmarks for email, chat, notes, and CRM entry
- UI copy that explains what style mode changes

Success checks:

- context-aware behavior improves output in the launch app matrix
- missing context never blocks dictation
- app-style rules are transparent enough to debug

### W9. Dictation Parity Evidence Program

Scope:

- expand parity docs into a dictation-specific scorecard
- automate benchmark verification where possible
- require packaged proof for launch claims

Deliverables:

- dictation parity scorecard
- benchmark schema and artifact locations
- packaged QA runbook for macOS and Windows
- launch review checklist tied to release gates

Success checks:

- parity claims are backed by artifacts, not anecdotes
- regression reviews can compare before and after benchmark runs
- launch recommendation is a simple pass or no-go decision

## Sequenced Phases

### Phase 0: Lock Current Baseline

Objective:

- freeze a trustworthy baseline before major dictation-intelligence changes

Tasks:

- record current insertion behavior and app matrix results
- capture baseline telemetry and benchmark artifacts
- identify current known-good paths by platform

Exit criteria:

- baseline packaged smoke evidence exists for macOS and Windows
- current dictation insertion paths are documented

### Phase 1: Harden Dictation Core

Objective:

- make the current dictation path safer to evolve

Tasks:

- consolidate insertion outcome contracts
- improve fallback reporting
- add regression tests for delivery modes
- add more packaged checks for real apps

Exit criteria:

- core insert path is benchmarked and stable
- fallback behavior is explicit and measurable

### Phase 2: Build The Formal Text Pipeline

Objective:

- stop scattering text transformations across orchestration code

Tasks:

- extract the ordered dictation pipeline
- move current command and snippet behavior into the new pipeline
- add stage-level telemetry and fixtures

Exit criteria:

- pipeline stage ordering is code-level and test-level truth
- old and new paths produce equivalent results for existing features

### Phase 3: Ship Dictionary And Snippet Hardening

Objective:

- make user-controlled text transformations first class

Tasks:

- implement dictionary v1
- harden snippet scoping and precedence
- add management polish and fixture coverage

Exit criteria:

- dictionary and snippet behaviors are deterministic
- user-managed text rules feel dependable in real apps

### Phase 4: Ship Smart Formatting And Correction

Objective:

- improve default dictation output without turning Nautilus into a rewrite toy

Tasks:

- add bounded formatter rules
- implement the launch correction command set
- benchmark formatting and correction quality

Exit criteria:

- benchmark corpora show better readability with acceptable error rates
- correction commands are trustworthy enough for daily use

### Phase 5: Certify Launch Languages

Objective:

- turn multilingual support into an evidence-backed launch strength

Tasks:

- choose GA languages
- map routes and recommendations
- run per-language benchmarks and fix failures
- label non-GA languages experimental

Exit criteria:

- each GA language is documented and benchmarked
- language support claims are truthful

### Phase 6: Finish Hands-Free And Context Styles

Objective:

- finish the two higher-risk polish features after the core is stable

Tasks:

- tune hands-free session behavior
- launch the initial app-style matrix
- add recovery polish and diagnostics

Exit criteria:

- hands-free feels first-class
- context-aware styles improve output in the initial app set

### Phase 7: Launch Readiness

Objective:

- convert engineering progress into a go or no-go launch decision

Tasks:

- run full parity scorecard
- validate packaged builds on both platforms
- confirm meetings remain solid without dictation regressions
- update product copy to match the certified capability set

Exit criteria:

- all dictation launch gates pass
- packaged QA evidence is complete
- launch recommendation is `GO`

## Testing Strategy

Automated coverage:

- pipeline ordering and precedence tests
- dictionary fixtures
- snippet fixtures
- correction command fixtures
- route and language resolution tests
- telemetry payload validation

Packaged manual coverage:

- insertion app matrix
- hands-free smoke and long-session tests
- language certification passes
- clipboard and fallback recovery
- target app style tests

Benchmark coverage:

- latency benchmarks
- formatting quality benchmarks
- correction intent benchmarks
- multilingual benchmark corpus

## Risks

- smart features can silently regress insertion trust if they are not isolated
- multilingual work can sprawl if GA languages are not locked early
- hands-free may consume disproportionate tuning effort
- app-aware styles can become brittle if the app matrix is too broad at launch
- meetings can distract the team if launch scope is not enforced

## Decisions To Preserve

- dictation is the release blocker
- local-first remains the product identity
- macOS and Windows launch together
- top 10 to 20 languages are GA, not broad unsupported marketing claims
- team and enterprise controls stay out of scope
