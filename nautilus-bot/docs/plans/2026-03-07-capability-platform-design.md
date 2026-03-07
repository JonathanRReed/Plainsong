# Capability Platform Design

Date: 2026-03-07

## Goal

Turn NautilusBot into a long-term capability platform that can beat SuperWhisper on dictation and Granola on meeting workflows without splitting into two separate products.

This design prioritizes:

- durable architecture over fast feature accretion
- shared platform capabilities over duplicated dictation and meeting logic
- local-first speed, trust, and inspectability
- packaged reliability and verification as product requirements

## Product Direction

Nautilus should be built as one runtime platform with two primary product surfaces:

- Dictation
- Meetings

Both surfaces should compose the same underlying capabilities instead of carrying separate business logic stacks.

The design rule is simple:

- If a behavior is reusable across surfaces, it must live in a platform capability.
- UI should orchestrate and explain state, not own policy or workflow truth.

## Capability Platform

The platform should be organized around seven capabilities.

### Capture

Owns:

- microphone capture
- system audio capture
- hotkeys and push-to-talk
- silence detection
- streaming queues
- permission probes
- packaged runtime diagnostics

### Context

Owns:

- frontmost app detection
- bundle id or process resolution
- selected text capture
- clipboard context capture
- window title metadata
- calendar and meeting hints
- future CRM and document context

### Insertion

Owns:

- paste at cursor
- inline replacement
- clipboard-only fallback
- undo and rollback
- snippet expansion
- command execution
- app-specific insertion policy

### Transcription Intelligence

Owns:

- ASR provider routing
- model resolution
- streaming and final transcription orchestration
- diarization
- transcript normalization
- quality scoring
- latency and route telemetry

### Meeting Workflows

Owns:

- live meeting state
- transcript streaming state
- summaries
- action items
- decisions
- deadlines
- Ask or Chat with meeting
- reusable templates
- post-meeting regeneration

### Integrations

Owns:

- calendar integration
- backup and sync
- export connectors
- future Slack, Notion, Linear, and CRM hooks
- platform-specific system integrations

### Evidence And Governance

Owns:

- retention
- transcript-only storage mode
- audit logs
- export verification
- privacy controls
- policy enforcement
- license gating
- release QA evidence

## Product Surfaces

The product surfaces should be thin orchestration layers on top of the capabilities.

### Dictation Surface

Composes:

- Capture
- Context
- Insertion
- Transcription Intelligence
- Evidence And Governance

### Meeting Surface

Composes:

- Capture
- Context
- Transcription Intelligence
- Meeting Workflows
- Integrations
- Evidence And Governance

### Settings And Diagnostics Surface

Composes:

- capability configuration
- permissions
- diagnostics
- benchmarking
- governance and policy controls

## Internal Data Model

The runtime should revolve around durable entities plus a first-class event stream.

### Core Entities

#### CaptureSession

Represents any live dictation or meeting capture.

Fields:

- `id`
- `surface`
- `state`
- `started_at`
- `stopped_at`
- `audio_sources`
- `target_app`
- `context_snapshot_id`
- `policy_snapshot_id`
- `provider_plan_id`

#### ContextSnapshot

Immutable context resolved when the user triggers capture.

Fields:

- frontmost app
- bundle id or process id
- window title
- selected text
- clipboard text
- meeting or calendar hint
- active mode

#### TranscriptArtifact

Canonical transcript output.

Fields:

- raw segments
- normalized segments
- diarization labels
- provider and model lineage
- quality metadata
- latency metrics

#### InsertionAction

Record of every dictation insertion attempt.

Fields:

- requested insertion mode
- actual insertion mode
- pasted or copied or failed state
- undo token
- command applied
- snippets applied
- error details

#### MeetingArtifact

Structured meeting outputs.

Fields:

- title
- summary
- action items
- decisions
- deadlines
- template id
- regeneration history

#### KnowledgeArtifact

Shared search and retrieval object for transcript memory, citations, and future chat.

#### PolicySnapshot

Resolved runtime policy at session start.

Fields:

- retention mode
- storage mode
- provider policy
- AI policy
- insertion rules
- export constraints

### Event Model

Every capability should emit typed internal events. Persist material events.

Core events:

- `capture.started`
- `capture.audio_chunk_received`
- `capture.stopped`
- `context.resolved`
- `transcription.started`
- `transcription.partial_emitted`
- `transcription.completed`
- `transcription.failed`
- `diarization.completed`
- `insertion.requested`
- `insertion.completed`
- `insertion.failed`
- `meeting.analysis.generated`
- `meeting.analysis.regenerated`
- `retention.applied`
- `export.generated`
- `integration.sync.completed`

### Storage Strategy

Keep SQLite as the durable store, but add explicit tables for:

- events
- sessions
- context snapshots
- transcript artifacts
- insertion actions
- meeting artifacts
- policy snapshots
- projections

The system should be reconstructable from persisted artifacts and event history.

## Workflow Design

### Dictation Workflow

1. User triggers hotkey or tray action.
2. Capture starts immediately on the fastest valid route.
3. Context resolves in parallel.
4. Insertion policy is selected before transcription completes.
5. Transcription Intelligence emits partials and final transcript.
6. Insertion applies snippets, commands, transforms, and rollback if needed.
7. Evidence records route, latency, insertion result, and failure state.

Best ideas to absorb from competitors:

- instant-feeling hotkey flow
- minimal overlay friction
- selection-aware rewrite and edit commands
- app-scoped custom modes
- explicit insertion policy per mode and per app
- stable history with explainable outcomes

### Meeting Workflow

1. User starts meeting manually or from future calendar-aware suggestions.
2. Capture creates a meeting session with source, consent, and policy state.
3. Transcription Intelligence streams partial transcript into the UI.
4. Meeting Workflows generate title, summary, actions, decisions, deadlines, and template outputs.
5. KnowledgeArtifact indexes transcript and notes for meeting-specific Ask or Chat.
6. Integrations export or sync based on policy.
7. Evidence applies retention, transcript-only deletion, and audit logging.

Best ideas to absorb from competitors:

- transcript-centric meeting record
- note-first workspace
- reusable summary templates
- Ask or Chat with meeting only
- diarization-aware review
- background and tray workflow where appropriate

### Automation Workflow

Automation should be capability-driven, not bolted on.

Possible triggers:

- app match
- meeting hint
- calendar hint
- hotkey mode
- template selection

Possible actions:

- preselect provider and model
- preselect context source
- choose insertion policy
- trigger post-processing automatically
- route output to integrations only when policy allows

## Module Boundaries

### Backend Target Structure

- `src-tauri/src/capture/`
- `src-tauri/src/context/`
- `src-tauri/src/insertion/`
- `src-tauri/src/transcription/`
- `src-tauri/src/workflows/dictation/`
- `src-tauri/src/workflows/meetings/`
- `src-tauri/src/integrations/`
- `src-tauri/src/governance/`
- `src-tauri/src/events/`
- `src-tauri/src/store/`

### Frontend Target Structure

- `src/features/dictation/`
- `src/features/meetings/`
- `src/features/settings/`
- `src/features/shared-runtime/`
- `src/components/ui/`
- `src/lib/tauri/`

### Boundary Rules

- Views do not decide product policy.
- Workflows orchestrate; capabilities execute.
- Capabilities do not import UI concepts.
- Shared runtime state should come from backend projections and events.
- New features should attach to an existing capability whenever possible.

## Quality Gates

### Testing Pyramid

- capability unit tests
- workflow integration tests
- OS-specific platform behavior tests
- packaged app QA
- benchmark gates

### Release Scorecard

Track at least:

- dictation start success rate
- insertion success by app and OS
- end-to-end latency p50 and p95
- command intent success
- snippet precision
- meeting streaming stability
- transcript completion success
- summary and action quality review
- 3h soak reliability
- recovery after permission or provider failure

### Non-Negotiable No-Go Conditions

Release stays `NO-GO` if any of these are unproven:

- dictation insertion on target OS and apps
- self-refreshing meeting transcript processing
- retention and storage policies
- packaged permission and update flows
- benchmark artifacts
- operational understanding that still depends on tribal knowledge

## Phased Rollout

### Phase 1: Capability Refactor

- extract capability seams in the backend
- reduce workflow logic inside UI components
- add event and artifact persistence

### Phase 2: Dictation Parity Release

- insertion reliability
- context capture
- custom modes
- app-specific behavior
- command and snippet precision

### Phase 3: Meeting Parity Release

- note-first meeting workspace
- transcript review quality
- Ask or Chat with meeting
- template-aware analysis
- stronger exports and retention behavior

### Phase 4: Automation And Integrations

- calendar awareness
- external connectors
- policy-driven automation
- memory graph improvements

### Phase 5: Enterprise-Grade Evidence

- release evidence
- stronger auditability
- compliance-oriented controls
- benchmark governance

## Success Criteria

This design is successful only when Nautilus is:

- fast enough to feel invisible
- reliable enough to trust daily
- inspectable enough to debug
- structured enough to improve without architectural rework

Perfect does not mean shipping everything at once.
Perfect means building the system so every major feature lands on durable foundations instead of temporary product glue.
