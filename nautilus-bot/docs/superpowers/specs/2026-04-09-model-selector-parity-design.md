# Model Selector And Parity Design

Date: 2026-04-09
Status: draft for review
Owner: Nautilus engineering

## Goal

Turn Nautilus ASR selection from a provider-first settings panel into a launch-grade route selector that feels competitive with Wispr Flow on dictation clarity, competitive with Granola on meeting-route confidence, and clearer than FreeFlow and OpenOats on local-first model choice.

This spec does not add a new meeting product or a broad ASR platform rewrite. It focuses on:

- model and provider curation
- selector UX
- download and readiness UX
- onboarding and settings consistency

## Problem

The repo already supports a wide range of local, cloud, and platform-native ASR routes:

- Whisper
- Distil-Whisper
- Parakeet
- Moonshine
- Voxtral local and cloud
- OpenAI Cloud
- Groq
- ElevenLabs Scribe
- Cohere Transcribe
- macOS Apple Speech
- Windows SDK Dictation

The product still feels behind competitors because the current UX exposes that inventory as internal machinery:

- selection is provider-first instead of job-first
- route quality is not curated enough by workflow
- download actions are separate from route choice
- onboarding and settings do not present the same recommendations
- local, cloud, experimental, and meeting-grade distinctions are not obvious enough

The result is complexity without confidence.

## Product Decision

Adopt a lane-first selector with curated recommendations and inline readiness actions.

The primary user choices become:

- `Shared`
- `Dictation`
- `Meetings`

Each lane shows only routes that are compatible with that workflow. The user sees recommended routes first, expert options second, and download or setup actions in context.

## Why This Approach

### Rejected approach: labels-only patch

Improve current provider labels and descriptions without changing the structure.

Why rejected:

- leaves the interaction model provider-first
- still feels like an internal admin panel
- does not improve onboarding parity
- will not materially change competitor perception

### Rejected approach: onboarding-only wizard upgrade

Make first-run route choice smart, but keep Settings mostly as-is.

Why rejected:

- creates drift between first-run and ongoing configuration
- forces future fixes to be duplicated
- does not improve daily model switching or troubleshooting

### Chosen approach: lane-first selector across onboarding and settings

Why chosen:

- makes the route choice understandable in product terms
- reuses the existing backend inventory
- keeps expert control available without overwhelming default users
- improves parity where users actually judge the product

## UX Design

### 1. Top-level structure

The route UI is split into three tabs:

- `Shared`
- `Dictation`
- `Meetings`

Use shadcn `Tabs` for this structure.

The selected lane controls:

- which routes are shown
- which routes are recommended
- which routes are selectable
- which warnings and download actions appear

### 2. Selector primitive

Use shadcn `Combobox` for searchable route selection.

Reason:

- route lists are large enough that search matters
- options are object-backed, not simple strings
- each option needs badges, status text, and inline metadata

Use shadcn `Select` only for small secondary controls where search is not needed.

Use:

- `Combobox`
- `Popover`
- `Badge`
- `Card`
- `Alert`
- `Progress`

This follows the current shadcn guidance for searchable object selection and keeps the picker aligned with the project's existing base-nova shadcn setup.

### 3. Route row anatomy

Each model row must show:

- model label
- provider name
- hosting badge: `Local`, `Cloud`, or `Platform`
- capability badge: `Best for dictation`, `Best for meetings`, `Shared`
- readiness badge: `Downloaded`, `Needs download`, `Ready`, `Fix setup`, `BYOK required`
- optional badge: `Experimental`
- optional badge: `Apple Silicon accel`
- one-line recommendation text

Rows should sort by:

1. recommended routes for the current lane
2. ready routes
3. downloadable local routes
4. cloud routes requiring keys
5. experimental routes

### 4. Recommendation cards

Each lane shows a recommendation card above the combobox.

The card answers:

- what Nautilus recommends now
- why
- what tradeoff the route makes

Initial recommendation policy:

- `Dictation`: prefer the fastest trustworthy local route that is ready on this machine
- `Meetings`: prefer the strongest meeting-grade route that is ready on this machine
- `Shared`: prefer a route that is valid for both dictation and meetings

If the recommended route is missing local assets, the recommendation card includes the download CTA.

### 5. Expert mode

Expert controls remain available, but not as the default experience.

Expose them through a collapsed advanced section:

- manual provider route details
- raw runtime diagnostics
- engine notes
- MLX acceleration toggles where valid
- cloud model variants

This preserves the current power-user depth without making the default path look unfinished.

### 6. Download flow

Model download and setup actions move into the route picker flow.

Rules:

- local downloadable route missing assets: show `Download`
- runtime missing but not downloadable: show `Fix setup`
- cloud route missing secret: show `Connect API key`
- platform-native route unavailable: show `Open system setup`

Progress should render inline in the lane panel with shadcn `Progress`.

The standalone downloader can remain temporarily, but its role becomes secondary. The primary path is selection-first, not download-first.

### 7. Onboarding alignment

The first-run wizard and the settings route selector must use the same recommendation and compatibility logic.

That means:

- same route catalog
- same lane badges
- same recommendation ordering
- same readiness messages

Onboarding becomes a guided version of the same route system, not a different system.

## Data Model

Introduce a normalized frontend route catalog type built from the existing provider inventory.

Suggested shape:

```ts
type AsrRouteLane = "shared" | "dictation" | "meeting";

type AsrRouteCatalogEntry = {
  routeId: string;
  providerType: AsrProviderType;
  modelId: string;
  label: string;
  providerLabel: string;
  laneCompatibility: {
    shared: boolean;
    dictation: boolean;
    meeting: boolean;
  };
  hosting: "local" | "cloud" | "platform";
  readiness: "ready" | "needs_download" | "missing_runtime" | "requires_key" | "error";
  downloadable: boolean;
  experimental: boolean;
  recommendedRank: {
    shared: number | null;
    dictation: number | null;
    meeting: number | null;
  };
  badges: string[];
  summary: string;
  actionLabel: string | null;
}
```

The important change is to stop treating `provider + selected model` as only backend state and start treating each route as a product-facing option.

## Recommendation Policy

The first version should be deterministic and transparent.

### Dictation lane

Recommendation order:

1. ready local route, non-experimental, dictation-first
2. ready platform-native route
3. ready cloud dictation route
4. downloadable local dictation route
5. experimental dictation route

Initial route intent:

- Distil-Whisper should likely anchor fast general local dictation
- Moonshine should remain the low-footprint edge option
- Whisper and Whisper Candle remain power-user options
- platform-native routes remain visible as convenience paths, not launch-story defaults

### Meeting lane

Recommendation order:

1. ready local or cloud meeting-grade route
2. downloadable local meeting-grade route
3. cloud route requiring a key

Initial route intent:

- Parakeet and Distil-Whisper should be treated as primary meeting-grade defaults where available
- Voxtral, OpenAI, ElevenLabs, Groq, and Cohere remain strong alternatives, but their setup and hosting tradeoffs must be obvious
- dictation-only providers should never appear as selectable meeting routes

### Shared lane

Recommendation order:

1. ready route valid for both dictation and meetings
2. downloadable shared-compatible route
3. cloud shared-compatible route

The shared lane exists for users who want one sane default instead of two specialized routes.

## Backend And Frontend Boundary

The backend inventory already exposes most of the needed information:

- provider type
- selected model
- model options
- download status
- runtime status
- runtime details
- engine diagnostics

This work should keep that backend contract mostly stable.

Frontend responsibilities:

- normalize provider inventory into route catalog entries
- compute lane compatibility and recommendation ordering
- render route badges and action states
- map route actions to existing backend commands

Only add backend work if the current contract is missing critical route metadata for the curated UX.

## Error Handling

Trust rules:

- never show a route as recommended if it is not actionable
- never show a meeting-incompatible route in the meeting selector
- never hide whether a route is cloud-backed
- never hide whether a route is experimental
- never force download workflows to live outside the selection context

Failure behavior:

- missing local assets: stay selectable, but action is `Download`
- missing runtime: stay visible with `Fix setup`
- missing API key: stay visible with `Connect API key`
- invalid current selection: preserve visible state, show warning, and recommend the nearest healthy route

## Testing

### Frontend tests

Add targeted tests for:

- route catalog normalization
- lane filtering rules
- recommendation ordering
- combobox search behavior
- badge rendering for local, cloud, downloaded, experimental, and lane labels
- inline action rendering for download, setup, and BYOK states
- onboarding and settings using the same route recommendation logic

### Existing test updates

Update tests that currently assume:

- provider-first labels only
- legacy default selections
- isolated downloader behavior

### Regression protection

Add regression checks for:

- meeting lane never exposing dictation-only providers
- shared lane only exposing meeting-compatible routes
- current selection surviving inventory refresh
- local missing-model states showing download CTA instead of generic failure

## Implementation Boundaries

This spec includes:

- route catalog normalization
- lane-first selector UI in settings
- onboarding alignment
- inline download and setup actions
- route recommendation badges and summaries

This spec does not include:

- adding new ASR providers
- changing launch app matrix policy
- new packaged QA claims
- broad meeting UX redesign outside the selector and onboarding surfaces

## Success Criteria

The selector redesign succeeds when:

- first-run users can choose a dictation route and a meeting route without understanding internal provider details
- power users can still access expert controls
- the UI makes local, cloud, platform, experimental, and meeting-grade distinctions explicit
- downloads happen in context
- onboarding and settings recommendations do not diverge
- the route chooser feels curated rather than overloaded

## Files Likely Affected

- `src/components/asr-provider-manager.tsx`
- `src/components/model-downloader.tsx`
- `src/components/first-run-wizard.tsx`
- `src/lib/asr-capabilities.ts`
- `src/lib/asr-route-selection.ts`
- `src/lib/asr-models.ts`
- `src/types/asr.ts`
- `src/components/ui/command.tsx`
- `src/components/ui/popover.tsx`
- `src/components/ui/tabs.tsx`
- tests covering settings, onboarding, and route selection

## Open Choices Already Resolved

- selector scope: settings plus onboarding
- UX default: curated lanes first, expert control second
- selector primitive: shadcn combobox composition, not plain select

## Launch Interaction With Competitor Parity

This work does not claim parity by itself.

What it does:

- removes avoidable selector friction relative to Wispr Flow
- makes meeting-route choice clearer relative to Granola
- makes local-first tradeoffs more legible relative to FreeFlow and OpenOats

What it does not do:

- replace packaged QA evidence
- prove launch app insertion parity
- prove meeting reliability parity

It is a product-clarity improvement that makes the existing model stack feel deliberate instead of fragmented.
