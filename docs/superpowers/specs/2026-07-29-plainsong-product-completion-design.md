# Plainsong Product Completion Design

Date: 2026-07-29

## Objective

Make Plainsong fully operational, competitively excellent, and ready for direct
macOS distribution. Completion covers product functionality, first-run and
daily UX, reliability, security, packaging, real packaged runtime proof,
notarization, stapling, Gatekeeper acceptance, and update readiness.

The definition of done is the behavior of the exact packaged release, not the
existence of source code, a passing unit test, a Developer ID identity, or an
older accepted Apple submission.

## Product Contract

Plainsong is a precise macOS speech instrument for people who want fast
dictation, trustworthy insertion, and bot-free meeting capture without routing
every workflow through hosted infrastructure.

Dictation is the hero surface. Meetings are the second surface. When the two
compete for attention, latency, screen space, or onboarding time, dictation
wins unless the meeting path would become unsafe or unusable.

At launch:

- A new user can reach a successful local dictation without understanding
  providers, routes, models, or internal architecture.
- Hold-to-talk, toggle, and hands-free modes preserve one consistent capture,
  transcription, insertion, and recovery contract.
- Recognized text survives every insertion failure.
- Local processing is the default. Cloud processing is optional, named, and
  never selected silently.
- Status surfaces say what is happening, why it is happening, and what the user
  can do next.
- Power features remain discoverable without turning primary workflows into an
  operator console.
- Public claims describe behavior proved by the packaged release.

## Selected Approach

Use proof-driven vertical slices.

Each product promise is completed from user intent through native integration,
backend execution, rendered feedback, recovery, packaged behavior, and durable
evidence. Targeted UI and architecture improvements occur inside the slice
whose behavior they clarify.

This approach is preferred over:

- a UI-first redesign, which could improve appearance while leaving insertion
  or permissions unreliable;
- an architecture-first rewrite, which would expand regression surface before
  producing a user-visible result.

## Current Baseline

The live baseline inspected for this design was:

- repository root: `/Users/jonathanreed/Downloads/NautilusBot`;
- application root: `nautilus-bot/`;
- branch: `main`;
- inspected revision: `18cd7389f29ea9221174ad88b799a65292864bc3`;
- current package version: `1.0.0`;
- bundle identifier: `com.plainsong.app`;
- architecture: arm64;
- signing team: `AJ9VWBRNZN`;
- current app and DMG: valid Developer ID signatures, hardened runtime, secure
  timestamps, but no notarization ticket;
- Gatekeeper result: `source=Unnotarized Developer ID`;
- frontend verification: 58 files and 606 tests passed;
- Rust verification: 611 passed, 5 ignored, 0 failed;
- update metadata: ZIP SHA-512, size, blockmap, and manifest agree;
- real 44-second local latency measurement:
  - Whisper `base.en`: 571 ms p50, 587 ms p95;
  - Parakeet TDT 0.6B v3: 986 ms p50, 1124 ms p95.

The worktree became dirty after the initial baseline due to concurrent Rust
changes outside this design document. Those changes must be treated as
user-owned until their provenance and acceptance are resolved. No release
candidate may be built from an unreviewed or dirty tree.

## Competitive Quality Bar

### Dictation

Plainsong must match the best category products on:

- one shortcut that works predictably;
- hold-to-talk and hands-free behavior;
- fast local transcription;
- target-aware insertion;
- profiles, snippets, and dictionary behavior;
- clear last-result recovery;
- honest offline and cloud routing;
- preserved transcripts after delivery failure.

Plainsong should exceed competitors through:

- local-first default behavior;
- visible insertion truth instead of optimistic success;
- explicit target, route, fallback, and recovery information;
- user-owned provider choices;
- packaged evidence for every promoted model and host class.

### Meetings

Plainsong must provide:

- bot-free microphone and system-audio capture;
- explicit consent before capture;
- interruption-safe recording;
- transcript-first review;
- practical notes, summaries, action items, and follow-up drafts;
- grounded questions over meeting content;
- export, retention, backup, and restore;
- clear local or cloud route disclosure.

Meetings deepen the product but do not take over first run or the primary
navigation hierarchy.

## Canonical Product State

### Ownership

The process that owns a fact remains authoritative for that fact.

- Rust owns microphone and system-audio capability, model readiness,
  transcription, recording state, encrypted storage, and durable result data.
- Electron owns shortcut registration, overlay windows, native insertion
  helper health, top-level windows, and updater state.
- The renderer presents those facts and sends user intent. It must not infer a
  stronger state from partial local checks.

### Shared readiness contract

Introduce a single versioned `ProductReadinessSnapshot` that combines
authoritative facts into these domains:

- dictation capture;
- cursor insertion;
- meetings;
- speech models;
- AI lanes;
- storage protection;
- updates.

Each domain exposes:

- `state`: `ready`, `degraded`, `needs_action`, or `blocked`;
- `cause`: a stable machine-readable reason;
- `message`: short user-facing copy;
- `action`: zero or one typed next action;
- `observedAt`: timestamp;
- source evidence needed to reject stale events.

Setup, Home, Dictation, Meetings, Settings, Models, and the sidebar consume
selectors from this contract rather than recomputing readiness independently.

### Dictation state machine

Dictation follows an explicit lifecycle:

```text
idle
  -> preparing
  -> listening
  -> transcribing
  -> inserting
  -> completed
```

Every active state carries a monotonic session identifier. Events from an older
session cannot change a newer session.

Recoverable branches include:

- permission required;
- model required;
- audio capture failed;
- no speech detected;
- transcription failed;
- target unavailable;
- insertion failed;
- cleanup or formatting failed.

The raw recognized transcript is durable before insertion begins. Reformatting
or cleanup never replaces the only recoverable copy.

### Meeting state machine

Meeting capture uses the same ownership rules:

```text
idle
  -> consent
  -> preparing
  -> recording
  -> stopping
  -> processing
  -> ready
```

Interrupted sessions are recoverable on the next launch. Partial audio,
transcript segments, and metadata have explicit retention and cleanup
behavior.

## First-Run Experience

First run is progressive, not a wall of readiness checks.

### Step 1: Try dictation here

- Explain the local-first default in one sentence.
- Download the default local model with real progress and disk cost.
- Explain and request microphone permission.
- Let the user speak into a built-in scratch field.
- Show the recognized text and measured completion state.

### Step 2: Use it everywhere

- Explain why cursor insertion requires additional macOS access.
- Request only the required permission.
- Guide one shortcut-driven insertion into a real target application.
- Confirm delivery using the target application or read-back evidence rather
  than assuming that a paste command succeeded.

### Step 3: Ready

- Show the active shortcut and selected local model.
- Explain where failed or previous dictations can be recovered.
- Offer meeting setup as the next optional capability.
- Move advanced models, cloud providers, and diagnostics out of the main path.

Skipping an optional step must not create a false ready state.

## Daily Product UX

### Home

Home prioritizes:

- Dictate;
- Record a meeting;
- the single most important active recovery action;
- recent work when it helps the user resume.

Decorative metrics and card collections that do not change the next action are
removed or demoted.

### Dictation

The primary area contains:

- one dominant state-aware action;
- active shortcut and mode;
- listening and transcription feedback;
- target application when known;
- the latest recognized text;
- insertion result;
- direct recovery actions.

Profiles, snippets, dictionaries, formatting, and detailed diagnostics use
progressive disclosure below the core path.

### Meetings

Before a recording exists, Meetings focuses on source choice, consent, and
capture. After a recording exists, it reveals transcript, notes, questions,
actions, export, retention, and backup.

### Setup

Setup shows active blockers first. Completed checks collapse into a quiet
summary. Each blocker has one primary repair action.

### Models

Models begins with task-oriented presets and the four active lanes:

- speech for dictation;
- speech for meetings;
- AI for dictation cleanup;
- AI for meeting work.

The full catalogue remains available but collapsed. Every model states:

- download status;
- disk size;
- verified language scope;
- expected use;
- meaningful downside.

No language count is promoted beyond packaged fixture evidence. The current
Parakeet Spanish result prevents an unqualified 25-language product claim.

### Visual and interaction rules

Preserve the existing Plainsong design system:

- dark candle-lit folio by default, with vellum light mode;
- one gold primary action per surface;
- rust only for real action-needed states;
- Newsreader for headings and manuscript content, not controls;
- IBM Plex Sans for product copy;
- IBM Plex Mono for apparatus and genuine metadata;
- one page-level rubric;
- 14 px minimum for explanatory sentences;
- flattened sections rather than nested cards;
- functional 150 to 250 ms state transitions;
- reduced-motion alternatives for every motion;
- visible focus, VoiceOver labels, forced-colors support, and full keyboard
  operation.

## Recovery Contract

Every failure surface must expose:

- current state;
- cause;
- preserved user data;
- exactly one recommended next step;
- safe secondary actions when useful.

For dictation insertion failure, the actions are:

- Try again;
- Copy;
- Repair insertion access.

For recording interruption, the actions are:

- Resume or recover when safe;
- Preserve partial recording;
- Discard only after explicit confirmation.

Errors never instruct a local provider user to replace an API key that the
provider does not use. Permission errors name the exact macOS permission and
settings destination.

## Security and Privacy

### Existing controls to preserve

- sandboxed Electron renderers;
- context isolation;
- disabled renderer Node integration;
- blocked webviews and guarded navigation;
- explicit renderer command allowlist;
- hardened Electron fuses;
- Keychain-backed provider and internal secrets;
- guarded legacy-secret migration;
- encrypted database and recording support;
- truthful encryption coverage reporting;
- specialized shortcut and Speech-helper entitlements.

### Per-binary least privilege

Use a dedicated entitlement file for the Rust sidecar.

The sidecar must not receive:

- `com.apple.security.cs.allow-jit`;
- `com.apple.security.cs.allow-unsigned-executable-memory`;
- `com.apple.security.cs.disable-library-validation`;
- Apple Events authority.

Microphone or audio-input authority remains only if packaged tests prove that
the native capture process requires it.

The release trust verifier fails if:

- any executable contains a forbidden entitlement;
- a helper receives an entitlement owned by another helper;
- any nested executable lacks the expected Developer ID team;
- hardened runtime or secure timestamp is absent;
- an Electron fuse regresses.

### Data invariants

- Renderer code never receives a stored provider secret.
- Logs and release artifacts do not contain provider keys, passwords,
  transcripts, or direct identifiers.
- Decrypted temporary recording files are scoped, cleaned after use, and
  discoverable for crash recovery.
- `encrypted` means the database and all stored recording files are encrypted.
- Cloud use is explicit and named at the point it becomes relevant.
- Reset, retention, restore, and deletion resolve exact targets and request
  confirmation before destructive effects.

### Security validation

Run a current-revision security scan after implementation, then verify each
validated finding against the resulting source and package. A proposal or
clean scan summary does not close a finding by itself.

## Reliability and Performance

### Runtime reliability

- stale dictation and meeting events cannot mutate the active session;
- capture stop and abort are idempotent;
- helper death produces a bounded error and restart path;
- sidecar termination rejects pending commands instead of leaving the renderer
  indefinitely loading;
- downloads are resumable or safely restartable;
- incomplete model artifacts never report ready;
- backup and restore preserve database and recording consistency;
- updater failure leaves the installed version runnable.

### Performance targets

Preserve or improve the measured release baseline:

- first audio sample starts without losing the initial word;
- local dictation completes comfortably faster than real time;
- the UI remains responsive during model load and transcription;
- idle CPU and memory remain inside the existing release gates;
- no new process boundary is introduced on the dictation hot path without a
  measured reason.

`benchmark:latency` must provide usable help, explicit fixtures, model route,
run count, p50, p95, real-time factor, and machine context.

## Packaged Runtime Proof

Source tests are necessary but insufficient.

### Source gates

- `bun run lint`;
- `bun run test`;
- `bun run test:rust`;
- TypeScript checks;
- renderer and Electron builds;
- Rust formatting and Clippy;
- IPC contract;
- dead-code gate;
- security validation;
- `git diff --check`.

### Package gates

From one reviewed revision:

- build the arm64 app, ZIP, DMG, blockmap, and update manifest;
- verify package version and bundle version;
- verify arm64 for all native executables;
- verify nested signatures and expected team;
- verify hardened runtime and secure timestamps;
- verify least-privilege entitlements;
- verify Electron fuses;
- verify TCC usage strings;
- verify package size;
- verify ZIP hash, size, blockmap, manifest, and packaged update configuration;
- smoke test the packaged sidecar and native helpers.

### Real packaged dictation

Exercise:

- toggle mode;
- hold-to-talk;
- hands-free;
- auto-stop;
- cancel;
- paste last;
- copy last;
- retry insertion;
- recovery after helper or target failure.

Verify real insertion and read-back across host classes:

- native AppKit text field;
- Apple Notes or equivalent rich native editor;
- browser text input;
- browser contenteditable editor;
- Electron editor;
- IDE or code editor.

Named applications are spot checks. Launch support requires coverage of the
host classes the product claims to support.

### Real packaged meetings

Exercise:

- microphone only;
- microphone plus system audio;
- source switching;
- consent;
- recording stop;
- interruption recovery;
- transcript freshness;
- summary and grounded questions;
- export;
- retention;
- backup and restore;
- soak behavior.

### Accessibility and rendered QA

Inspect the running package in dark and light themes for:

- first-run and returning-user states;
- all primary navigation;
- loading, empty, degraded, and error states;
- keyboard focus order;
- VoiceOver names and reading order;
- reduced motion;
- forced colors where available;
- minimum supported window size;
- long labels and localized-length stress.

Screenshots must come from the real packaged application.

## Apple Distribution

### Credential profile

Create a new local `notarytool` Keychain profile:

```text
plainsong-notary
```

The profile is Plainsong-specific. Inkling and Waves credentials are not used
or modified.

The app-specific password is entered directly into the Apple credential flow
and stored only by macOS Keychain. Documentation records the profile name and
recovery procedure, never the password.

Before release packaging:

```sh
xcrun notarytool history --keychain-profile "plainsong-notary"
```

must authenticate successfully.

### Exact release sequence

1. Start from one reviewed source revision.
2. Build and sign every executable with Developer ID Application team
   `AJ9VWBRNZN`.
3. Have Electron Builder notarize and staple the application before producing
   the distributable ZIP.
4. Verify the stapled application.
5. Create and sign the DMG.
6. Submit the exact DMG with `notarytool`.
7. Require Apple `status: Accepted`.
8. Staple and validate the DMG.
9. Verify Gatekeeper acceptance for the application and DMG.
10. Reconcile final artifact hashes and update metadata.

ZIP archives are not stapled. The application inside the ZIP must contain its
ticket and pass Gatekeeper.

### Clean-install and updater proof

Install the exact DMG under a clean macOS user or clean machine and verify:

- Gatekeeper launch;
- first-run permission prompts;
- model download;
- dictation insertion;
- meeting capture;
- relaunch and retained settings.

Prove a signed N-to-N+1 update:

- detect update;
- download;
- verify signature and metadata;
- install;
- relaunch;
- confirm target version;
- preserve settings, history, recordings, and model selection.

## Release Receipt

The final release receipt binds:

- source revision;
- clean-tree status;
- build timestamp;
- app, ZIP, and DMG hashes and sizes;
- bundle and package versions;
- signing team and nested code inventory;
- entitlement and fuse results;
- Apple submission identifiers and accepted status;
- stapler and Gatekeeper results;
- source, package, real-device, accessibility, and updater evidence;
- known external blockers or deliberate publication decisions.

Generated receipts and QA artifacts do not replace raw command output or
current-state checks.

## Error Classification

Release reporting distinguishes:

- source or test failure;
- packaging failure;
- signing failure;
- missing credential capability;
- notarization rejection;
- stapling failure;
- Gatekeeper failure;
- permission-gated runtime failure;
- product behavior failure;
- updater failure;
- publication or provider-account failure.

One category cannot be used to hide another. A CI billing failure is not a code
failure. A Developer ID signature is not notarization. An older accepted Apple
history entry is not evidence for the current artifact.

## Implementation Order

1. Reconcile concurrent worktree changes and re-establish an owned baseline.
2. Fix sidecar entitlement scope and release-trust enforcement.
3. Close unsupported language claims and real-model evidence.
4. Complete the canonical product-readiness contract.
5. Make dictation lifecycle and transcript recovery explicit.
6. Close hold-to-talk, hands-free, and host-class insertion gaps.
7. Simplify first run, Home, Setup, Dictation, Meetings, and Models.
8. Complete accessibility and rendered-state verification.
9. Re-run security validation and fix validated findings.
10. Build a fresh signed release.
11. Create and validate `plainsong-notary`.
12. Notarize, staple, and verify exact artifacts.
13. Run clean-install and updater acceptance.
14. Produce the final release receipt and launch audit.

## Acceptance Criteria

The work is complete only when:

- no known source-controlled product, UX, reliability, security, packaging, or
  release defect remains;
- dictation succeeds end to end in every supported mode and host class;
- insertion failure preserves recognized text and provides recovery;
- meeting capture, processing, retrieval, export, retention, and backup work
  from the packaged app;
- all primary surfaces consume canonical readiness;
- no public capability claim exceeds packaged evidence;
- all validated security findings are fixed and revalidated;
- every executable carries only its required authority;
- all source and package gates pass from a reviewed revision;
- the exact app and DMG are Apple accepted, stapled, and Gatekeeper approved;
- a clean install and first-run permission flow pass;
- a signed N-to-N+1 updater flow passes;
- the final receipt binds every claim to current evidence.

## Change Boundaries

- Do not discard, overwrite, stage, commit, or publish concurrent user changes.
- Do not add production dependencies without approval.
- Do not expose or store credentials in source, logs, shell history, or
  plaintext documents.
- Do not use Inkling or Waves signing profiles for Plainsong.
- Do not commit, push, tag, publish a release, change repository visibility,
  deploy the website, or mutate provider production settings without explicit
  authorization.
- Preserve unrelated user data and settings during package and updater tests.
- Prefer reversible migration and repair paths.
