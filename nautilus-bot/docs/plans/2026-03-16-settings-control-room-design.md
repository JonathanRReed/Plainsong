# Settings Control Room Design

Date: 2026-03-16

## Goal

Turn Nautilus settings from a long utility form into a launch-ready control room that makes capture, transcription, and device health obvious at a glance.

This redesign must also solve three product problems at the same time:

- users need reliable microphone selection, not implicit default-device behavior
- dictation and ASR route choices need to feel deterministic on first try
- advanced warnings and internal runtime noise need to stop leaking into normal user flows

## Approved Direction

The approved direction is a maximal redesign.

Settings should feel like an editorial-industrial studio console rather than a default preferences page. The interface should use a strong visual hierarchy, a left-side command rail, dense but readable control panels, and status surfaces that feel operational instead of noisy.

The memorable idea is:

`Nautilus settings should feel like the control room for a private voice workspace.`

## Design Principles

- make capture readiness visible before the user starts dictating
- make the active microphone and active transcription routes explicit
- move warning-heavy content out of the main path unless action is required
- prefer status summaries and advisory language over amber wall-of-text warnings
- keep advanced diagnostics available, but visually secondary
- preserve power-user depth without forcing normal users to parse it

## Information Architecture

Replace the current flat top-tab experience with a two-column shell.

### Left Rail

The left rail is sticky and always visible on desktop. It contains:

- product title and short settings subtitle
- save/sync state
- readiness chips for microphone, insertion, speech, and storage
- primary navigation sections
- a compact footer for version/update context

Sections:

- Capture
- Transcription
- Workspace
- Privacy
- Storage
- AI
- Updates
- License

### Right Stage

The right side is the active content area. Each section opens with:

- a strong section heading
- a one-line operational summary
- a quick status strip
- one or more large panels with grouped controls

## Visual Direction

### Tone

Editorial-industrial with warm metal accents.

### Characteristics

- dark ink surfaces with layered charcoal panels
- amber and brass accents for live and active states
- strong cream or fog typography for labels and body text
- oversized headings with sharper, more editorial spacing
- subtle mesh or grain textures behind major section panels
- restrained motion for page-load reveals and status transitions

### UI Language

- primary controls look like instruments, not plain forms
- status chips feel like console indicators
- warnings use quieter advisory panels unless they block a workflow
- inputs and selects remain fully accessible and keyboard-friendly

## Capture Architecture

Capture becomes a first-class section rather than a secondary audio subsection.

### Microphone Preference Model

Approved device model:

- one app-wide preferred microphone
- optional dictation microphone override
- optional meeting microphone override

Resolution order:

1. per-mode override if enabled and available
2. app-wide preferred microphone if available
3. current system default microphone as fallback

### Stored Metadata

Each saved microphone preference should include enough information to recover cleanly when hardware changes.

Preferred stored fields:

- device id or stable host identifier when available
- display name snapshot
- transport hint if detectable

If a saved device disappears, Nautilus should fall back once and show a clean advisory rather than fail hard.

### Device Inventory API

The backend should expose a list of available input devices with metadata suitable for UI display.

UI-facing fields should include:

- id
- name
- isDefault
- isAvailable
- transportType when inferable
- isBluetoothLike
- channel count when known
- sample rate when known

### Capture Section UI

The Capture section should include:

- app-wide microphone card
- dictation override card
- meeting override card
- live input level meter
- microphone test tools
- capture quality guidance
- permission and fallback status

### Bluetooth / AirPods Handling

Bluetooth headset microphones should not be blocked.

Instead, Nautilus should:

- detect likely Bluetooth or headset inputs when possible
- show a non-blocking advisory about degraded playback quality during capture
- suggest switching to built-in or USB microphones for better monitoring quality

## Transcription Architecture

The Transcription section should keep full routing power while simplifying the primary flow.

### Main Path

The main path should only ask the user to decide:

- dictation route
- meeting route
- required models
- language behavior

### Advanced Path

Move these lower in the section inside advanced panels or collapsible drawers:

- runtime diagnostics
- cache repair
- platform-specific notes
- insertion repair tools
- low-level engine details

### Route Clarity

The UI must always show:

- requested dictation provider and model
- requested meeting provider and model
- whether MLX is actually active for each route
- whether the route is local or cloud-backed

The route shown in the UI must match the route actually persisted and used at runtime.

## Reliability Fixes Bundled With The Redesign

### Moonshine Persistence

The ASR provider manager currently has too much shared-versus-split selection complexity.

This work should simplify route persistence logic so that switching to Moonshine or any dictation provider applies on the first try and survives refreshes without hidden route drift.

### Raw Runtime Output Sanitization

Internal Python or MLX runtime output such as raw `STTOutput(...)` text must never be surfaced to end users.

Requirements:

- parse failures should produce clean app-level error messages
- raw stdout or stderr snippets belong in logs or diagnostics only
- frontend surfaces should show actionable copy, not backend internals

### Warning Cleanup

Current warning density is too high.

Refactor warnings into three classes:

- blocking: user cannot complete the workflow
- advisory: quality or setup recommendation
- diagnostic: advanced detail behind disclosure

Only blocking issues should dominate the primary UI.

## Backend Changes

### Settings Model

Add audio input preference fields to persisted settings.

Recommended fields:

- app-wide preferred input device
- dictation input override enabled + selected device
- meeting input override enabled + selected device

### Backend Commands

Add commands to:

- list input devices
- get active resolved input device state if needed for display

### Audio Capture

Update dictation and microphone-based meeting capture so they select a resolved device instead of always using `default_input_device()`.

Shared helper logic should:

- enumerate devices
- resolve a preferred device when possible
- fall back to default input device when needed
- attach clean warnings when fallback occurs

## Frontend Changes

### Settings Shell

Rebuild `src/components/views/settings-view-simple.tsx` into a new shell with:

- left navigation rail
- right content stage
- stronger section headers
- reusable panel and status-row patterns

### Capture Section

Add reusable device cards and override toggles.

Microphone selection controls should support:

- readable device list
- explicit active indicator
- default/fallback explanation
- Bluetooth advisory copy

### Transcription Section

Wrap `AsrProviderManager` in a stronger layout and likely refactor parts of it so the main route flow reads clearly inside the new design system.

## Error Handling

- if a saved mic device disappears, keep the session operable via fallback and explain what happened
- if no microphone exists, show a clear blocking state with system-settings guidance
- if dictation startup fails, tie the error to the selected device and route when possible
- if model/runtime parsing fails, sanitize the message before it reaches the UI

## Testing

### Rust

- settings serialization and migration for new mic preference fields
- device resolution tests
- fallback behavior tests
- sanitized Python runtime output tests

### Frontend

- settings shell navigation rendering
- microphone picker and override behavior
- unavailable-device fallback state
- reduced warning noise in the transcription section

### Validation

- targeted test runs for touched files first
- `bun run test`
- `cargo test --lib`
- `bun run build`

## Non-Goals

- full rewrite of dictation view itself
- deep redesign of all non-settings screens in this pass
- blocking Bluetooth microphones outright
- replacing every advanced control with a simplified abstraction

## Implementation Notes

- prefer migration-safe settings additions with sane defaults
- keep existing commands and types backward compatible where practical
- avoid destructive changes to unrelated settings behavior
- stage the work so backend device support lands before the full UI redesign consumes it
