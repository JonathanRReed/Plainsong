# Plainsong Full Dual-Pillar Beta Design

Status: Approved
Date: 2026-08-08
Target release: `0.9.0-beta.1`
Audience: A limited, invite-only beta group

## Objective and completion boundary

Plainsong's first proper beta will ship Dictation and Meetings as fully supported, first-class product pillars. Dictation remains the default route and the fastest path through the app, while Meetings receives the same release-quality bar for capture, transcription, recovery, privacy, and packaged runtime behavior.

The beta is ready only when an invited tester can:

1. Install a signed and notarized build on a clean Apple silicon Mac.
2. Complete setup without entering a dead or misleading state.
3. Dictate into representative native, browser, Electron, and editor text fields with measured, competitive latency.
4. Capture and finish a real meeting using microphone and system audio, then review the transcript, notes, and follow-up material.
5. Understand whether each operation is local, cloud-enabled, unavailable, or waiting for permission.
6. Quit, relaunch, recover from interrupted work, export or back up data, and update to the next beta without losing data or weakening security.

This design covers product behavior, security boundaries, UX, performance, testing, packaging, and invite-beta support. It does not authorize deployment, tester distribution, production configuration changes, commits, pushes, or dependency additions.

## Product decisions

- Dictation and Meetings both ship in `0.9.0-beta.1`. Meetings is not hidden and is not labeled Experimental.
- Dictation stays the initial route because speed of daily capture is Plainsong's sharpest competitive edge.
- Local processing is the default. Every remote provider is named, separately enabled, and revocable.
- The limited beta controls audience size, not application security. A copied installer must not expose a weaker security boundary.
- Release claims follow packaged measurements. Plainsong will not claim to be faster, private, offline, or meeting-ready beyond the evidence the release candidate can produce.
- The existing Plainsong product and visual system remains authoritative. The app stays a calm desktop instrument, using the current vellum, ink, gold, rust, Newsreader, and IBM Plex system.
- No new production dependency is part of this design. A dependency may be proposed later only if repository-native implementation cannot meet a required invariant.

## Non-goals for the first beta

- Windows support.
- A public general-availability launch.
- Team accounts, shared workspaces, or hosted transcript storage.
- A new cloud analytics stack.
- Provider parity for its own sake. The supported provider set must be reliable and clearly described.
- Visual rebranding or replacement of the existing design system.

## Core architecture and invariants

### One readiness model

The existing renderer readiness layer owns one presentation snapshot assembled from privileged backend facts:

- microphone permission;
- accessibility or insertion permission;
- system-audio permission and capability;
- sidecar process health;
- dictation model installed and warmed;
- meeting-grade model installed and ready;
- vault state;
- local database health;
- remote-processing consent and provider configuration;
- update availability.

`use-setup-status.ts` remains the only evidence collector, `product-readiness.ts` remains the pure normalizer, and `ProductReadinessProvider` remains the only renderer fanout mechanism. Electron and Rust remain authoritative for every permission, consent, capture, storage, vault, and network decision. The presentation snapshot never authorizes an operation.

The renderer does not infer readiness from platform markers, optimistic defaults, or the existence of configuration values.

Every primary action has four required states: available, preparing, blocked with a recovery action, and failed with a recovery action. Disabled controls remain visible when they teach the user how to become ready.

### Explicit state machines

Dictation uses an explicit lifecycle:

`idle -> preparing -> listening -> transcribing -> inserting -> complete`

Any active state may enter `error` or `cancelled`, with a recorded reason and a bounded recovery path.

Meetings use an explicit lifecycle:

`idle -> preparing -> recording -> stopping -> processing -> ready`

Any active state may enter `error`, `cancelled`, or `recoverable`. The recording identifier is created once and remains authoritative across Electron, Rust, renderer events, persistence, and recovery.

State transitions are idempotent. Duplicate Stop, Cancel, event replay, relaunch recovery, or renderer remount must not lose the recording identifier or reset an error before it is displayed.

### Privileged user-action capabilities

Sensitive capture can begin only from:

- a global shortcut handled by Electron main; or
- a one-time, short-lived capability bound to the owning window and a recent trusted input event.

Capabilities are single-use and route-specific. Renderer-supplied consent booleans are display data, not authorization.

### Central remote-processing consent

All remote dictation, remote meeting preview, post-processing, summaries, follow-up generation, provider validation, and streaming uploads pass through one privileged consent gate.

Consent has a generation number. Revocation increments the generation, aborts in-flight work, and causes every pending request to recheck immediately before network transmission. Opening a settings page never contacts a provider unless the user explicitly requests a connection test or remote processing is already enabled for that provider.

### Privileged storage destinations

Renderer values never authorize arbitrary filesystem or cloud destinations.

Exports and backups use locations approved by a privileged picker and stored in privileged state. The renderer receives an opaque location identifier and a safe display label. Every write, restore, and sync operation revalidates its resolved destination at the sink. Restored settings cannot introduce a new approved destination.

## Dictation design

### Responsiveness contract

The app will measure distinct latency segments rather than one blended duration:

- input to visible acknowledgement;
- input to audio capture ready;
- speech start to first stable partial;
- speech end to final transcript;
- final transcript to insertion;
- complete end-to-end turn time.

Initial beta budgets on the supported reference tier, Apple silicon with at least 16 GB memory, are:

| Metric | Gate |
|---|---:|
| Hotkey to visible acknowledgement | P95 at or below 100 ms |
| Hotkey to capture ready | P95 at or below 300 ms |
| Speech start to first stable partial, warm local model | P50 at or below 1.25 s, P95 at or below 2.0 s |
| Speech end to inserted final, warm local model | P50 at or below 1.2 s, P95 at or below 2.0 s |

The benchmark records model, hardware, host application, utterance duration, and cold or warm state. The app does not report Ready until the selected model has completed its readiness handshake. A cold model path is measured separately and may not silently masquerade as a warm path.

### Decode and insertion behavior

- Replace timer-dominated startup with readiness-driven scheduling.
- Coalesce partial-decode work so stale partials cannot queue behind current audio.
- Avoid parallel decodes for the same utterance unless the model implementation explicitly supports them.
- Make the initial partial window adaptive to voice activity rather than a fixed long minimum.
- Bound audio startup, sidecar restart, insertion fallback, and retry time independently.
- Preserve dictated text when insertion fails, then show the target, attempted insertion route, failure reason, copy fallback, and repair action.
- Keep the overlay responsive even while model work occurs.

### Dictation proof matrix

The packaged candidate must cover:

- native AppKit text controls;
- Chromium browser fields and contenteditable surfaces;
- Electron applications;
- IDE and code-editor surfaces;
- messaging applications;
- multiline editors;
- password or secure fields, which must refuse insertion when appropriate;
- empty, short, long, command-mode, correction, cancellation, and rapid-repeat utterances.

## Meetings design

### Start and readiness

The Meetings surface is a first-class destination, but Start is available only when the selected capture route is genuinely ready. A blocked Start control explains the missing permission, model, vault action, or device capability and offers the direct repair action.

Starting a meeting:

1. Validates the trusted user-action capability.
2. Captures an immutable readiness snapshot.
3. Creates and persists one recording identifier.
4. Starts requested sources transactionally.
5. Emits a renderer event containing the authoritative identifier and state.
6. Rolls back partial startup if any required source fails.

### Stop, processing, and recovery

- Stop always sends the authoritative recording identifier.
- The renderer does not clear the identifier until the backend confirms a terminal state.
- Processing progress and transcript freshness remain visible.
- Errors remain visible until acknowledged or retried.
- Recording lists subscribe to meeting state events and reconcile with persistence after reconnect or remount.
- A crash or relaunch identifies incomplete recordings and offers deterministic Recover, Discard, or Resume Processing actions when supported.
- Vault restore, lock, capture, and post-processing are serialized through an operation coordinator.

### Meeting proof matrix

At least one real-device packaged run is required for every supported capture route:

- microphone only;
- system audio only on supported macOS versions;
- microphone plus system audio;
- permission denied and permission revoked during setup;
- missing or unavailable meeting model;
- remote preview enabled, disabled, and revoked midstream;
- normal Stop;
- duplicate Stop;
- Cancel;
- source interruption;
- sleep or display lock during recording;
- quit or crash recovery;
- transcript, notes, action items, follow-up draft, export, retention, and deletion.

## Onboarding and product UX

### First-run contract

- The application shell waits until onboarding state is loaded, eliminating first-run shell flash.
- Setup detects actual privileged readiness rather than inferred platform support.
- Skip does not enter a dead product. It enters a clearly limited mode with persistent setup actions and unavailable primary controls.
- Dictation and Meetings each have a readiness section, while shared permissions and models are explained once.
- A problem produces one primary error surface. Secondary surfaces may link to it but do not duplicate the same alert.
- Setup survives quit and relaunch without repeating completed work or skipping failed work.

### Daily-use hierarchy

- Dictation opens by default and has one obvious primary action.
- Meetings is equally supported in navigation and release testing.
- Status always states what is happening now and what the user can do next.
- Local and cloud state use text plus the existing neume vocabulary, never color alone.
- Focus order, visible focus rings, keyboard operation, screen-reader labels, contrast, and reduced motion are verified in both themes.
- Loading, empty, disabled, success, and error states are implemented for every changed component.

## Security remediation scope

All eleven validated findings are release blockers:

| Finding | Required security invariant |
|---|---|
| Renderer-controlled export root | Only privileged, user-approved destinations can receive exports. |
| Capture without a privileged capability | Audio capture requires a fresh trusted user action and single-use authorization. |
| Renderer-controlled backup destination | Backups and cloud sync can target only privileged, user-approved destinations. |
| Remote revocation gaps | Revocation aborts and prevents all later remote transmission. |
| Renderer-controlled vault metadata | Renderer input cannot replace privileged vault identity or lock the user out. |
| Unbounded privileged work | RPC concurrency, input sizes, benchmark buffers, and expensive task fanout are bounded. |
| Restore racing active work | Restore, capture, encryption, vault mutation, and post-processing cannot overlap unsafely. |
| Settings page provider contact | Viewing settings causes no remote traffic while remote processing is disabled. |
| Beta updater downgrade | Update policy rejects version rollback. |
| Unbounded model stream | Model downloads enforce a hard byte ceiling even without `Content-Length`. |
| Decrypted audio after vault lock | Lock immediately cancels and removes decrypted runtime audio. |

Each security change requires a regression test that demonstrates the malicious case is rejected and a legitimate control remains supported. A finding is not considered fixed through code inspection alone when an executable boundary test is feasible.

## Diagnostics and beta support

Plainsong will generate local structured diagnostics for performance and lifecycle debugging. Default diagnostics exclude audio, dictated text, transcripts, API keys, tokens, and full user paths.

The user can generate a support bundle, preview its contents, and explicitly choose to share it. The bundle includes:

- app version and build identity;
- macOS and hardware tier;
- permission and readiness states;
- redacted lifecycle transitions;
- latency segment timings;
- sidecar health and bounded error codes;
- model identifiers and integrity status;
- signing and update-channel metadata.

No new hosted analytics service is required for the first beta.

## Release and distribution design

### Versioning and update channel

- Reset the application version from `1.0.0` to `0.9.0-beta.1` across package, Electron, Rust, workflow, artifact naming, and user-visible surfaces.
- Publish the `beta-mac.yml` manifest and a separate beta artifact set that matches the channel the packaged updater requests.
- Do not use a private repository release API as the client update feed. The chosen feed must be reachable by an installed beta build without embedding repository credentials.
- Keep downgrade disabled.
- Verify `0.9.0-beta.1` to `0.9.0-beta.2` using the actual packaged update path before inviting testers.
- Treat the beta feed as client-reachable distribution infrastructure. Invite control governs who receives the initial link and support, not whether the artifact is safe if copied.

### Candidate trust gates

The exact candidate must pass:

- lint, TypeScript typecheck, unit and integration tests;
- Rust tests and benchmark suites;
- IPC exposure and dead-code gates;
- renderer and Electron production builds;
- dependency, license, secret, and security regression checks;
- whitespace and generated-notice validation;
- arm64 architecture validation;
- Developer ID signing validation;
- notarization, stapling, and Gatekeeper assessment;
- clean-install first run using a fresh macOS account or equivalent isolated environment;
- packaged Dictation and Meetings real-device journeys;
- beta update from the immediately previous candidate;
- final artifact digest recorded against the tested installer.

### Invite package

Before distribution, prepare:

- a concise welcome and installation guide;
- minimum supported macOS and hardware statement;
- permission and local-model expectations;
- a local-first and cloud-provider disclosure;
- known limitations, without hiding release-blocking defects;
- structured Dictation and Meetings test missions;
- feedback and support-bundle instructions;
- rollback or uninstall instructions;
- a release-specific issue intake template.

## Implementation tranches

### Tranche 1: Privileged boundaries and lifecycle foundation

Close the eleven security findings, establish the readiness snapshot, introduce the operation coordinator, and encode authoritative Dictation and Meetings state contracts.

Required proof: focused red-green security tests, IPC contract tests, Rust tests, renderer tests, lint, typecheck, and builds.

### Tranche 2: Dictation performance and insertion reliability

Implement the model readiness handshake, decode coalescing, adaptive partial scheduling, bounded retries, latency instrumentation, insertion recovery, and enforced benchmark gate.

Required proof: latency corpus results on the supported reference tier, host compatibility matrix, regression tests, and packaged runtime dictation journeys.

### Tranche 3: Meeting capture, processing, recovery, and UX

Repair identifier ownership, state propagation, live list reconciliation, failure persistence, readiness gating, capture rollback, relaunch recovery, and the complete post-meeting workflow. Complete the first-run and daily readiness redesign in the same state model.

Required proof: state-machine tests, renderer integration tests, real-device microphone and system-audio matrix, recovery runs, accessibility review, and packaged UI verification.

### Tranche 4: Release candidate and invite launch package

Apply pre-1.0 versioning, repair beta update metadata, produce the signed candidate, run clean-install and update proofs, and prepare the invite support materials.

Required proof: final release gate, signing and notarization receipts, artifact digest, isolated first-run evidence, `beta.1` to `beta.2` update evidence, and completed invite checklist.

No tranche closes on source tests alone when it changes packaged behavior.

## Acceptance gates

| Gate | Required evidence | Current status |
|---|---|---|
| Functionality | Packaged end-to-end Dictation and Meetings journeys | Not run for new design |
| UX and accessibility | Rendered onboarding, readiness, daily use, errors, keyboard, screen reader, reduced motion, both themes | Not run for new design |
| Runtime and performance | Enforced latency percentiles and real-device meeting matrix | Not run |
| Data integrity | Backup, restore, vault, recovery, export, retention, and deletion tests | Not run |
| Security and privacy | Eleven findings closed with malicious and legitimate controls | Not run |
| Packaging and trust | Exact candidate signed, notarized, stapled, assessed, and digest-recorded | Not run |
| Clean install | Fresh-user setup and first Dictation and Meeting | Not run |
| Update | Actual `beta.1` to `beta.2` update without downgrade or data loss | Not run |
| Invite readiness | Welcome, disclosure, missions, support bundle, intake, uninstall | Not prepared |
| Distribution | Explicit user approval before external distribution | Not authorized |

## Risks and mitigations

- Competitive local latency may vary by model and Apple silicon generation. Measure by tier, keep readiness honest, and block unsupported claims.
- Full dual-pillar scope increases schedule and regression surface. Keep implementation sequential and close every tranche before opening the next.
- System-audio behavior depends on macOS permissions and OS version. Test the exact supported matrix and disable unsupported routes with an explanation.
- An auto-update feed must be reachable by clients. Do not confuse an unlisted link with artifact confidentiality or authorization.
- Local-first support makes debugging harder. Use previewable, redacted, user-shared diagnostics rather than default remote telemetry.
- Security fixes may reveal compatibility assumptions in saved settings. Provide explicit migration and recovery tests rather than silently accepting unsafe legacy values.

## Authority and stop rules

Approved:

- repository edits required by this design;
- test and local build execution;
- local packaged-app testing;
- reversible temporary test data outside user content.

Still requires explicit approval:

- adding a production dependency;
- deleting user data or performing destructive cleanup;
- changing credentials or Apple, GitHub, hosting, or production settings;
- committing, pushing, opening a pull request, deploying, or distributing a beta build;
- spending money or enabling a paid service.

Implementation stops if a required security invariant can only be satisfied by a materially different product policy, or if a real-device or external release gate requires credentials, permissions, hardware, or authority that is not available.
