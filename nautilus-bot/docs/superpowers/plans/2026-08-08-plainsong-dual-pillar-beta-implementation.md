# Plainsong Dual-Pillar Beta Implementation Plan

> Required workflow: execute this plan one task at a time with red-green tests, close each tranche before starting the next, and run fresh verification before any completion claim. Do not commit, push, deploy, publish, or distribute without explicit user approval.

**Goal:** Deliver a signed, notarized, pre-1.0 invite beta in which Dictation and Meetings are both first-class, security boundaries are closed, latency and lifecycle gates are enforced, onboarding is honest, and the exact packaged artifact is proven through clean-install and beta-update journeys.

**Architecture:** Preserve Rust as the authoritative owner of Dictation and Meeting runtime state. Electron owns trusted OS input, window identity, pickers, updater policy, and renderer-to-sidecar admission. The renderer owns presentation state only. Reuse the existing readiness collector and normalizer rather than introducing a second state system.

**Stack:** Bun 1.3.14, React 19, TypeScript 7, Electron 43, electron-builder 26.15.3, electron-updater 6.8.9, Rust 1.93, Tokio, Vitest, existing packaged macOS QA scripts.

**Approved design:** `docs/superpowers/specs/2026-08-08-plainsong-dual-pillar-beta-design.md`

## Authority and execution rules

- Repository edits, tests, builds, local packaging, and reversible isolated QA are approved.
- Do not add a production dependency without asking.
- Do not delete user data or modify real credentials, Apple configuration, GitHub settings, hosting, or production state.
- Do not commit, push, create a pull request, deploy, publish, or invite testers without asking.
- Preserve unrelated user changes. Stop if the worktree changes outside the files owned by the active task.
- Every bug or security boundary starts with a failing test or realistic reproducer.
- Every security test includes a malicious case and a legitimate control.
- A task that changes packaged behavior is not complete on source tests alone.

## Tranche 1: Privileged boundaries and lifecycle foundation

### Task 1: Privileged export and backup destinations

**Findings closed:** renderer-controlled export root, renderer-controlled backup destination.

**Files:**

- Create: `electron/privileged-storage-locations.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc-bridge.ts`
- Create: `rust-sidecar/src/approved_locations.rs`
- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/backup.rs`
- Modify: `rust-sidecar/src/settings.rs`
- Modify: `src/lib/backend.ts`
- Modify: `src/components/views/settings-view-simple.tsx`
- Test: `src/__tests__/electron-ipc-bridge.test.ts`
- Test: `src/__tests__/settings-view-simple.test.tsx`
- Test: `src/__tests__/settings-wire-contract.test.ts`
- Test in place: `rust-sidecar/src/lib.rs`
- Test in place: `rust-sidecar/src/backup.rs`

**Design:**

- Add dedicated Electron IPC methods that open a native directory picker for export and backup locations.
- Electron calls an internal-only sidecar command with the picker result. The internal approval command is never present in the renderer command allowlist.
- Persist an opaque location identifier, canonical path, purpose, and safe display label in privileged sidecar state.
- Renderer settings store only the opaque identifier and display label.
- Export, backup, restore, iCloud, and rclone sinks resolve and revalidate the approved location at use time.
- Treat legacy absolute paths as unapproved. Preserve the data, mark the setting invalid, and require reselection. Do not silently migrate renderer-controlled paths into the approved registry.

**Red step:**

1. Add Rust tests that reject home, shell-profile, LaunchAgents, symlink-escape, and restored unapproved destinations.
2. Add a legitimate test for a picker-approved temporary directory.
3. Add Electron tests proving the renderer cannot pass a raw path or invoke the internal approval command.
4. Add renderer tests proving an invalid legacy location displays a reselection action instead of saving on blur.

Run and confirm failure:

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml approved_location
cargo test --locked --manifest-path rust-sidecar/Cargo.toml export_root
cargo test --locked --manifest-path rust-sidecar/Cargo.toml backup_dir
bun test src/__tests__/electron-ipc-bridge.test.ts src/__tests__/settings-view-simple.test.tsx src/__tests__/settings-wire-contract.test.ts
```

**Green step:** Implement the picker, internal approval command, registry, migration state, and sink validation with existing path-canonicalization helpers.

**Task verification:**

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml approved_location
cargo test --locked --manifest-path rust-sidecar/Cargo.toml export_root
cargo test --locked --manifest-path rust-sidecar/Cargo.toml backup_dir
bun test src/__tests__/electron-ipc-bridge.test.ts src/__tests__/settings-view-simple.test.tsx src/__tests__/settings-wire-contract.test.ts
bun run gate:ipc-contract
bun run lint
git diff --check
```

### Task 2: Trusted capture admission

**Finding closed:** trusted renderer can start capture without a privileged user-action capability.

**Files:**

- Create: `electron/capture-admission.ts`
- Modify: `electron/main.ts`
- Modify: `electron/windows.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc-bridge.ts`
- Modify: `rust-sidecar/src/models.rs`
- Modify: `rust-sidecar/src/lib.rs`
- Modify: `src/lib/backend.ts`
- Modify: `src/components/views/recordings-view.tsx`
- Test: `src/__tests__/electron-ipc-bridge.test.ts`
- Test: `src/__tests__/electron-renderer-protocol.test.ts`
- Test: `src/__tests__/recordings-view.test.tsx`
- Test: `src/__tests__/recording-popup.test.tsx`
- Test in place: `rust-sidecar/src/lib.rs`

**Design:**

- Remove `start_recording` from the generic renderer-to-sidecar allowlist.
- Add a dedicated Electron meeting-start handler bound to the main application window.
- Accept starts only after Electron observes a recent real keyboard or pointer input for that window. Global shortcuts remain trusted because Electron owns them directly.
- Mint a short-lived, route-bound, window-bound, single-use nonce and consume it in the same privileged start sequence.
- Derive consent state in privileged code. Remove renderer ownership of `consentPromptShown` as an authorization fact.
- Leave `stop_recording` available only through the dedicated meeting lifecycle bridge and bind it to the active recording identifier.

**Red step:** Add tests for missing capability, expired capability, replay, wrong window, wrong route, renderer-supplied consent, and a legitimate one-time start.

Run and confirm failure:

```bash
bun test src/__tests__/electron-ipc-bridge.test.ts src/__tests__/electron-renderer-protocol.test.ts src/__tests__/recordings-view.test.tsx src/__tests__/recording-popup.test.tsx
cargo test --locked --manifest-path rust-sidecar/Cargo.toml meeting_consent
cargo test --locked --manifest-path rust-sidecar/Cargo.toml start_recording
```

**Green step:** Implement the dedicated bridge and remove generic capture admission without changing supported meeting options.

**Task verification:**

```bash
bun test src/__tests__/electron-ipc-bridge.test.ts src/__tests__/electron-renderer-protocol.test.ts src/__tests__/recordings-view.test.tsx src/__tests__/recording-popup.test.tsx
cargo test --locked --manifest-path rust-sidecar/Cargo.toml meeting_consent
cargo test --locked --manifest-path rust-sidecar/Cargo.toml start_recording
bun run gate:ipc-contract
bun run lint
git diff --check
```

### Task 3: Central remote-processing consent and cancellation

**Findings closed:** remote revocation gaps, provider contact while remote processing is disabled.

**Files:**

- Create: `rust-sidecar/src/remote_processing.rs`
- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/streaming.rs`
- Modify: `rust-sidecar/src/asr/mod.rs`
- Modify only traced remote provider clients under: `rust-sidecar/src/asr/`
- Modify: `rust-sidecar/src/llm/transport.rs`
- Modify: `rust-sidecar/src/settings.rs`
- Modify: `src/components/views/settings-view-simple.tsx`
- Modify: `src/lib/backend.ts`
- Test: `src/__tests__/settings-view-simple.test.tsx`
- Test: `src/__tests__/meeting-transcript-stream.test.ts`
- Test in place: `rust-sidecar/src/remote_processing.rs`
- Test in place: `rust-sidecar/src/lib.rs`

**Design:**

- Implement a privileged consent generation and cancellation signal using existing Tokio primitives.
- Every remote request obtains a generation guard and rechecks it immediately before sending bytes.
- Streaming requests select between provider work and revocation so revocation terminates an in-flight upload or preview.
- All direct Dictation LLM formatting and Meeting remote-preview paths use the same guard.
- Settings page load returns saved provider configuration without listing models or probing endpoints.
- Provider validation occurs only after an explicit Test Connection action or while that provider is enabled for remote processing.

**Red step:** Add tests that revoke immediately before send, revoke during a stream, block direct Dictation formatting after revocation, block remote Meeting preview after revocation, and open AI settings with zero remote calls. Include enabled-provider controls.

Run and confirm failure:

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml remote_processing
cargo test --locked --manifest-path rust-sidecar/Cargo.toml streaming
bun test src/__tests__/settings-view-simple.test.tsx src/__tests__/meeting-transcript-stream.test.ts
```

**Green step:** Route every traced remote sink through the guard, then perform a sibling sink review with `rg` for direct HTTP send calls.

**Task verification:**

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml remote_processing
cargo test --locked --manifest-path rust-sidecar/Cargo.toml streaming
bun test src/__tests__/settings-view-simple.test.tsx src/__tests__/meeting-transcript-stream.test.ts
rg -n '\.send\(\)|send_request|execute\(' rust-sidecar/src/asr rust-sidecar/src/llm rust-sidecar/src/streaming.rs
bun run test:rust
bun run lint
git diff --check
```

### Task 4: Vault identity, operation coordination, and decrypted-audio cleanup

**Findings closed:** renderer-controlled vault metadata, restore races active work, vault lock retains decrypted runtime audio.

**Files:**

- Create: `rust-sidecar/src/operation_coordinator.rs`
- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/settings.rs`
- Modify: `rust-sidecar/src/backup.rs`
- Modify: `rust-sidecar/src/audio.rs`
- Modify: `rust-sidecar/src/recording_audio.rs`
- Modify: `src/lib/backend.ts`
- Modify: `src/components/views/settings-view-simple.tsx`
- Test: `src/__tests__/settings-wire-contract.test.ts`
- Test: `src/__tests__/settings-view-simple.test.tsx`
- Test in place: `rust-sidecar/src/lib.rs`
- Test in place: `rust-sidecar/src/backup.rs`
- Test in place: `rust-sidecar/src/recording_audio.rs`

**Design:**

- Preserve vault identity, salt, initialization, and database-encryption metadata across every renderer settings save.
- Reject restore payloads that attempt to replace privileged vault identity.
- Add an operation coordinator with explicit capture, post-process, backup, restore, vault migration, and vault lock leases.
- Restore fails closed with a useful reason while capture, encryption, or post-processing is active.
- Vault lock cancels decrypted playback or runtime-audio leases, removes decrypted temporary material, zeroizes keys, then reports locked.

**Red step:** Add tests for malicious vault metadata save, restore during recording, restore during post-process, concurrent vault migration, lock during decrypted playback, and legitimate settings or restore when idle.

Run and confirm failure:

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml vault
cargo test --locked --manifest-path rust-sidecar/Cargo.toml restore
cargo test --locked --manifest-path rust-sidecar/Cargo.toml operation_coordinator
bun test src/__tests__/settings-wire-contract.test.ts src/__tests__/settings-view-simple.test.tsx
```

**Green step:** Implement the coordinator and privileged-field preservation, then route every matching command through a lease.

**Task verification:**

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml vault
cargo test --locked --manifest-path rust-sidecar/Cargo.toml restore
cargo test --locked --manifest-path rust-sidecar/Cargo.toml operation_coordinator
bun test src/__tests__/settings-wire-contract.test.ts src/__tests__/settings-view-simple.test.tsx
bun run test:rust
bun run lint
git diff --check
```

### Task 5: Privileged work and download resource bounds

**Findings closed:** unbounded privileged task fanout and benchmark bytes, model downloads without a hard streaming ceiling.

**Files:**

- Create: `rust-sidecar/src/admission.rs`
- Modify: `rust-sidecar/src/bin/sidecar.rs`
- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/download/mod.rs`
- Modify: `rust-sidecar/src/models.rs`
- Modify: `electron/ipc-command-policy.ts`
- Test: `src/__tests__/electron-ipc-bridge-lifecycle.test.ts`
- Test in place: `rust-sidecar/src/admission.rs`
- Test in place: `rust-sidecar/src/bin/sidecar.rs`
- Test in place: `rust-sidecar/src/download/mod.rs`

**Design:**

- Bound JSON-RPC line length before deserializing large requests.
- Add command classes with semaphores and duplicate-work keys for downloads, benchmarks, analyses, backup sync, and capture.
- Reject oversized `benchmark_asr_providers_bytes` before allocation or temp-file creation.
- Define pinned artifact byte ceilings next to pinned model metadata.
- Enforce each ceiling against both `Content-Length` and observed streaming bytes, deleting the partial file on failure.
- Return stable busy, duplicate, and size-limit errors that the renderer can recover from.

**Red step:** Add concurrency saturation, duplicate model download, oversized benchmark, omitted `Content-Length`, and legitimate bounded workload tests.

Run and confirm failure:

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml admission
cargo test --locked --manifest-path rust-sidecar/Cargo.toml download
cargo test --locked --manifest-path rust-sidecar/Cargo.toml benchmark_asr_providers_bytes
bun test src/__tests__/electron-ipc-bridge-lifecycle.test.ts
```

**Green step:** Implement admission and streaming ceilings without reducing existing integrity checks.

**Task verification:**

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml admission
cargo test --locked --manifest-path rust-sidecar/Cargo.toml download
cargo test --locked --manifest-path rust-sidecar/Cargo.toml benchmark_asr_providers_bytes
bun test src/__tests__/electron-ipc-bridge-lifecycle.test.ts
bun run test:rust
bun run lint
git diff --check
```

### Task 6: Rollback-resistant beta updater policy

**Finding closed:** beta update mode permits signed rollback.

**Files:**

- Modify: `electron/main.ts`
- Modify: `electron/updater-channel.ts`
- Test: `src/__tests__/electron-updater-channel.test.ts`
- Test: `src/__tests__/update-components.test.tsx`
- Test: `src/__tests__/packaged-update-metadata-script.test.ts`

**Design:**

- Keep `allowPrerelease = true` for beta discovery.
- Keep `allowDowngrade = false` for every normal channel.
- Reject a candidate lower than the running version before download or install.
- Do not enable electron-builder's all-channel generation mode because its documented behavior also enables downgrade semantics. Generate and publish the current prerelease channel manifest explicitly.
- A future recovery rollback must be a separate explicit, user-confirmed flow and is outside this beta.

**Red step:** Add tests that beta discovers a higher prerelease, refuses older stable and older prerelease versions, and still accepts a legitimate beta upgrade.

Run and confirm failure:

```bash
bun test src/__tests__/electron-updater-channel.test.ts src/__tests__/update-components.test.tsx src/__tests__/packaged-update-metadata-script.test.ts
```

**Green step:** Change updater policy and centralize monotonic version acceptance.

**Task verification:**

```bash
bun test src/__tests__/electron-updater-channel.test.ts src/__tests__/update-components.test.tsx src/__tests__/packaged-update-metadata-script.test.ts
bun run build:electron
bun run lint
git diff --check
```

### Tranche 1 closure gate

```bash
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
git diff --check
```

Re-run the eleven original malicious conditions and their legitimate controls. Record any unexercised runtime path as blocked, not fixed.

## Tranche 2: Readiness, Dictation performance, and insertion reliability

### Task 7: Honest readiness and first-run state

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/hooks/use-setup-status.ts`
- Modify: `src/features/readiness/product-readiness.ts`
- Modify: `src/features/readiness/product-readiness-context.tsx`
- Modify: `src/components/first-run-wizard.tsx`
- Modify: `src/components/views/setup-view.tsx`
- Modify: `src/components/views/dictation-view.tsx`
- Modify: `src/components/views/recordings-view.tsx`
- Test: `src/__tests__/first-run-wizard.test.tsx`
- Test: `src/__tests__/setup-view.test.tsx`
- Test: `src/features/readiness/product-readiness.test.ts`
- Test: `src/hooks/use-setup-status.test.ts`
- Test: `src/hooks/use-setup-status-live.test.tsx`

**Design:**

- Add an explicit unresolved onboarding state so no workspace shell renders before first-run state is known.
- Keep the existing readiness collector, pure normalizer, and provider.
- Add live refresh events for permission and sidecar-runtime changes instead of relying only on focus and settings changes.
- Replace platform-marker optimism with actual provider and model readiness.
- Skip enters limited mode with visible setup actions. It never makes Dictation or Meetings appear ready.
- Gate both primary actions with cause and direct repair action.

**Red step:** Add tests for fresh-launch shell flash, skipped setup, permission change while open, sidecar loss, missing Dictation model, missing Meeting model, and legitimate ready states.

Run and confirm failure:

```bash
bun test src/__tests__/first-run-wizard.test.tsx src/__tests__/setup-view.test.tsx src/features/readiness/product-readiness.test.ts src/hooks/use-setup-status.test.ts src/hooks/use-setup-status-live.test.tsx
```

**Green step:** Implement the loading gate and live readiness events without adding another status owner.

**Task verification:**

```bash
bun test src/__tests__/first-run-wizard.test.tsx src/__tests__/setup-view.test.tsx src/features/readiness/product-readiness.test.ts src/hooks/use-setup-status.test.ts src/hooks/use-setup-status-live.test.tsx
bun run build:renderer
bun run lint
git diff --check
```

### Task 8: Dictation readiness handshake and bounded recovery

**Files:**

- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/audio.rs`
- Modify: `electron/ipc-bridge.ts`
- Modify: `electron/sidecar-recovery-policy.ts`
- Modify: `electron/dictation-shortcut-controller.ts`
- Modify: `src/features/dictation/runtime.ts`
- Modify: `src/components/views/dictation-view.tsx`
- Test: `src/__tests__/electron-dictation-shortcut-controller.test.ts`
- Test: `src/__tests__/electron-ipc-bridge.test.ts`
- Test: `src/__tests__/dictation-popup.test.tsx`
- Test: `src/__tests__/dictation-view.test.tsx`
- Test in place: `rust-sidecar/src/lib.rs`
- Test in place: `rust-sidecar/src/audio.rs`

**Design:**

- Replace detached prewarm with an observable model-readiness handshake.
- Do not publish ready until the selected local model is actually warm.
- Make `primed` authoritative and visible before the first audio tick so a rapid release cannot disappear between start acknowledgement and recording.
- Bound microphone startup and allow at most one sidecar recycle.
- Bound the combined failure path rather than stacking the 1.5-second audio timeout and 10-second restart timeout repeatedly.
- Preserve a stable recovery message and the captured text or session state.

**Red step:** Add rapid press-release, cold model, failed warmup, mic stall, one-recycle maximum, and legitimate warm start tests.

Run and confirm failure:

```bash
bun test src/__tests__/electron-dictation-shortcut-controller.test.ts src/__tests__/electron-ipc-bridge.test.ts src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx
cargo test --locked --manifest-path rust-sidecar/Cargo.toml dictation
cargo test --locked --manifest-path rust-sidecar/Cargo.toml audio
```

**Green step:** Implement the readiness acknowledgement and bounded recovery using the existing Rust session tracker and Electron mirror.

**Task verification:**

```bash
bun test src/__tests__/electron-dictation-shortcut-controller.test.ts src/__tests__/electron-ipc-bridge.test.ts src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx
cargo test --locked --manifest-path rust-sidecar/Cargo.toml dictation
cargo test --locked --manifest-path rust-sidecar/Cargo.toml audio
bun run lint
git diff --check
```

### Task 9: Adaptive partial decode and coalescing

**Files:**

- Modify: `rust-sidecar/src/lib.rs`
- Modify if reuse is appropriate: `rust-sidecar/src/streaming.rs`
- Modify: `src/components/views/dictation/dictation-capture-hero.tsx`
- Test: `src/__tests__/dictation-popup.test.tsx`
- Test: `src/__tests__/dictation-view.test.tsx`
- Test in place: `rust-sidecar/src/lib.rs`

**Design:**

- Replace the fixed 1.2-second minimum and 700-millisecond polling floor with a voice-activity and audio-growth scheduler.
- Keep a small VAD floor so silence and tiny buffers do not trigger work.
- Coalesce pending partial work by session generation and audio watermark.
- Never decode unchanged audio or emit duplicate partial text.
- Cancel stale partial work when final transcription begins.

**Red step:** Add tests for early real speech, silence suppression, unchanged-buffer suppression, stale-session cancellation, duplicate partial suppression, and legitimate longer utterances.

Run and confirm failure:

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml partial_should_decode
cargo test --locked --manifest-path rust-sidecar/Cargo.toml dictation_partial
bun test src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx
```

**Green step:** Implement the scheduler with monotonic watermarks and existing VAD evidence.

**Task verification:**

```bash
cargo test --locked --manifest-path rust-sidecar/Cargo.toml partial_should_decode
cargo test --locked --manifest-path rust-sidecar/Cargo.toml dictation_partial
bun test src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx
bun run test:rust
bun run lint
git diff --check
```

### Task 10: Latency instrumentation, UI truth, and release gate

**Files:**

- Modify: `rust-sidecar/src/lib.rs`
- Modify: `rust-sidecar/src/bin/benchmark-latency.rs`
- Modify: `src/features/dictation/runtime.ts`
- Modify: `src/components/views/dictation-view.tsx`
- Modify: `src/components/views/dictation/dictation-capture-hero.tsx`
- Modify: `scripts/capture-source-gates.mjs`
- Create: `scripts/verify-dictation-latency.mjs`
- Modify: `package.json`
- Test: `src/__tests__/dictation-popup.test.tsx`
- Test: `src/__tests__/dictation-view.test.tsx`
- Test: `src/__tests__/reproducibility-config.test.ts`
- Create test: `src/__tests__/dictation-latency-gate.test.ts`

**Design:**

- Record acknowledgement, capture-ready, first-stable-partial, final transcript, insertion, and end-to-end timestamps.
- Emit benchmark JSON with hardware, model, fixture, warm or cold state, P50, P95, and sample count.
- Add a verifier for the approved beta budgets.
- Add the verifier to local release and source-gate evidence, while keeping cold app startup separate.
- Make `primed` visibly active and replace `--:--` with truthful preparation feedback.

**Red step:** Add tests for all timing fields, primed copy, JSON schema, threshold failure, threshold success, and release-gate inclusion.

Run and confirm failure:

```bash
bun test src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx src/__tests__/reproducibility-config.test.ts src/__tests__/dictation-latency-gate.test.ts
```

**Green step:** Implement the metrics and verifier. Keep the hardware-dependent benchmark command separate from ordinary developer unit tests, but mandatory for the beta artifact receipt.

**Task verification:**

```bash
bun test src/__tests__/dictation-popup.test.tsx src/__tests__/dictation-view.test.tsx src/__tests__/reproducibility-config.test.ts src/__tests__/dictation-latency-gate.test.ts
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
bun run qa:source-gates
bun run lint
git diff --check
```

### Tranche 2 closure gate

```bash
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
bun run benchmark:latency -- --provider whisper --model base.en --runs 5
git diff --check
```

Packaged verification required after building the active candidate:

```bash
bun run gate:cold-start
bun run qa:packaged:macos:dictation-hotkey
bun run qa:packaged:macos:dictation-hotkey:hold
bun run qa:packaged:macos:dictation-hotkey:hands-free
bun run qa:packaged:macos:app-matrix:insertion
```

## Tranche 3: Meeting lifecycle, recovery, and product UX

### Task 11: Authoritative Meeting lifecycle and renderer reconciliation

**Files:**

- Modify: `rust-sidecar/src/lib.rs`
- Modify: `electron/main.ts`
- Modify: `src/hooks/use-recording.tsx`
- Modify: `src/hooks/use-recordings.ts`
- Modify: `src/components/popups/recording-popup.tsx`
- Modify: `src/components/recording-overlay.tsx`
- Modify: `src/components/views/recordings-view.tsx`
- Test: `src/__tests__/recording-popup.test.tsx`
- Test: `src/__tests__/recording-overlay.test.tsx`
- Test: `src/__tests__/recordings-view.test.tsx`
- Test: `src/__tests__/use-recording.test.ts`
- Test: `src/__tests__/use-recordings.test.ts`
- Test: `src/__tests__/electron-ipc-bridge-lifecycle.test.ts`
- Test in place: `rust-sidecar/src/lib.rs`

**Design:**

- Preserve one recording identifier from Rust creation through Stop and terminal persistence.
- Electron's active identifier is a lifecycle mirror only. Never clear it before confirmed terminal state.
- Quit finalization sends the identifier and blocks boundedly for confirmation or a persisted recoverable state.
- Represent preparing, recording, stopping, processing, ready, error, cancelled, and recoverable explicitly.
- Popup and overlay retain error and recovery text until the user acts.
- Recording lists refresh on every Meeting state event and reconcile against persistence after reconnect.
- Duplicate Stop and event replay are idempotent.

**Red step:** Add tests for Stop with missing ID, stop failure, duplicate Stop, error event persistence, list refresh after failure, renderer remount, quit finalization, and legitimate completion.

Run and confirm failure:

```bash
bun test src/__tests__/recording-popup.test.tsx src/__tests__/recording-overlay.test.tsx src/__tests__/recordings-view.test.tsx src/__tests__/use-recording.test.ts src/__tests__/use-recordings.test.ts src/__tests__/electron-ipc-bridge-lifecycle.test.ts
cargo test --locked --manifest-path rust-sidecar/Cargo.toml recording
```

**Green step:** Fix identifier ownership and transition handling without moving authority into Electron or React.

**Task verification:**

```bash
bun test src/__tests__/recording-popup.test.tsx src/__tests__/recording-overlay.test.tsx src/__tests__/recordings-view.test.tsx src/__tests__/use-recording.test.ts src/__tests__/use-recordings.test.ts src/__tests__/electron-ipc-bridge-lifecycle.test.ts
cargo test --locked --manifest-path rust-sidecar/Cargo.toml recording
bun run lint
git diff --check
```

### Task 12: Strong Meeting transcript and packaged lifecycle proof

**Files:**

- Modify: `scripts/lib/spoken-fixture-match.mjs`
- Modify: `scripts/capture-packaged-macos-meeting-soak.mjs`
- Modify: `scripts/capture-packaged-macos-meeting-mic.mjs`
- Create: `scripts/capture-packaged-macos-meeting-lifecycle.mjs`
- Modify: `scripts/capture-packaged-macos-release-audit.mjs`
- Modify: `package.json`
- Test: `src/__tests__/meeting-soak-fixture-match.test.ts`
- Create test: `src/__tests__/packaged-meeting-lifecycle-script.test.ts`

**Design:**

- Replace the three-token pass rule with ordered coverage and minimum distinctive-token ratio.
- Report omissions, order violations, coverage, and transcript length.
- Add a packaged lifecycle artifact for microphone, system audio, combined capture, normal Stop, duplicate Stop, quit-mid-meeting, sidecar fault, relaunch reconciliation, transcript, notes, actions, follow-up, export, and deletion.
- Separate automatable checks from manual real-device steps, but require both for beta signoff.

**Red step:** Add false-positive transcript tests, truncated and reordered cases, legitimate recognition-tolerance cases, and release-audit tests requiring the lifecycle artifact.

Run and confirm failure:

```bash
bun test src/__tests__/meeting-soak-fixture-match.test.ts src/__tests__/packaged-meeting-lifecycle-script.test.ts
```

**Green step:** Implement stricter matching and the lifecycle artifact schema.

**Task verification:**

```bash
bun test src/__tests__/meeting-soak-fixture-match.test.ts src/__tests__/packaged-meeting-lifecycle-script.test.ts
bun run qa:packaged:macos:meeting:mic
bun run qa:packaged:macos:meeting:system
bun run qa:packaged:macos:meeting:soak
bun run qa:packaged:macos:system-audio:test
bun run lint
git diff --check
```

### Task 13: Dual-pillar onboarding and daily-state polish

**Files:**

- Modify: `src/components/first-run-wizard.tsx`
- Modify: `src/components/views/setup-view.tsx`
- Modify: `src/components/views/dictation-view.tsx`
- Modify: `src/components/views/dictation/dictation-capture-hero.tsx`
- Modify: `src/components/views/recordings-view.tsx`
- Modify: `src/components/popups/recording-popup.tsx`
- Modify: `src/components/sidebar.tsx`
- Modify only if hierarchy needs it: `src/components/views/dashboard-view.tsx`
- Test: `src/__tests__/first-run-wizard.test.tsx`
- Test: `src/__tests__/setup-view.test.tsx`
- Test: `src/__tests__/dictation-view.test.tsx`
- Test: `src/__tests__/recordings-view.test.tsx`
- Test: `src/__tests__/recording-popup.test.tsx`
- Test: `src/__tests__/navigation-readiness.test.ts`

**Design:**

- Both pillars are first-class and fully supported, while Dictation remains the default route.
- Keep the primary Dictation hero first, folding readiness into its state rather than stacking duplicate alerts above it.
- Meetings Start remains visible but disabled with one cause and one direct repair action when unavailable.
- Remove duplicate model or permission alerts.
- Use existing semantic tokens, neumes, focus rings, type scale, and reduced-motion rules.
- Verify default, hover, focus, active, disabled, loading, empty, error, and recovery states.

**Red step:** Add rendered tests for one-error behavior, action hierarchy, unavailable Meeting state, ready Meeting state, keyboard focus, accessible labels, reduced motion, and both themes.

Run and confirm failure:

```bash
bun test src/__tests__/first-run-wizard.test.tsx src/__tests__/setup-view.test.tsx src/__tests__/dictation-view.test.tsx src/__tests__/recordings-view.test.tsx src/__tests__/recording-popup.test.tsx src/__tests__/navigation-readiness.test.ts
```

**Green step:** Implement behavior and copy before visual refinement. Do not add a new palette, font, or component dependency.

**Task verification:**

```bash
bun test src/__tests__/first-run-wizard.test.tsx src/__tests__/setup-view.test.tsx src/__tests__/dictation-view.test.tsx src/__tests__/recordings-view.test.tsx src/__tests__/recording-popup.test.tsx src/__tests__/navigation-readiness.test.ts
bun run build:renderer
bun run lint
git diff --check
```

Then run the packaged application in an isolated profile and visually verify first run, skipped setup, ready Dictation, blocked Dictation, ready Meetings, blocked Meetings, error recovery, keyboard navigation, light theme, dark theme, and reduced motion.

### Tranche 3 closure gate

```bash
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
git diff --check
```

The exact packaged candidate must also complete the full real-device Meeting matrix before this tranche is called complete.

## Tranche 4: Pre-1.0 release, packaged proof, and invite kit

### Task 14: Pre-1.0 version and beta feed wiring

**Files:**

- Modify: `package.json`
- Modify: `electron-builder.yml`
- Modify if it contains the package version: `rust-sidecar/Cargo.toml`
- Modify: `electron/main.ts`
- Modify: `electron/updater-channel.ts`
- Modify: `scripts/verify-packaged-macos-update-metadata.mjs`
- Modify: `scripts/capture-packaged-macos-release-audit.mjs`
- Modify: `../.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `../README.md`
- Modify: `../LAUNCH.md`
- Regenerate: `THIRD-PARTY-NOTICES.txt`
- Test: `src/__tests__/electron-updater-channel.test.ts`
- Test: `src/__tests__/packaged-update-metadata-script.test.ts`
- Test: `src/__tests__/reproducibility-config.test.ts`

**Design:**

- Set the first beta candidate to `0.9.0-beta.1` everywhere the version is authoritative or user-visible.
- Require tag `v0.9.0-beta.1` when a release is eventually authorized.
- Confirm electron-builder emits the current prerelease channel manifest, `beta-mac.yml`.
- Stage the beta manifest and matching ZIP, blockmap, DMG, and checksums in the draft-release workflow.
- Keep the installed updater credential-free. Do not rely on a private GitHub release API as the client feed.
- Keep release drafts human-reviewed and refuse to modify a published release.
- Correct stale launch documentation and generated-notice whitespace.

**Red step:** Add tests for version alignment, `beta-mac.yml`, asset staging, monotonic update policy, and missing-manifest failure.

Run and confirm failure:

```bash
bun test src/__tests__/electron-updater-channel.test.ts src/__tests__/packaged-update-metadata-script.test.ts src/__tests__/reproducibility-config.test.ts
```

**Green step:** Apply version and workflow changes. Use Context7-verified electron-builder channel behavior and the installed package versions.

**Task verification:**

```bash
bun test src/__tests__/electron-updater-channel.test.ts src/__tests__/packaged-update-metadata-script.test.ts src/__tests__/reproducibility-config.test.ts
bun run licenses:generate
bun run lint
git diff --check
```

### Task 15: Clean-install, beta-update, diagnostics, and invite evidence

**Files:**

- Modify: `scripts/capture-packaged-macos-onboarding-settings.mjs`
- Modify: `scripts/capture-packaged-macos-smoke.mjs`
- Create: `scripts/capture-packaged-macos-beta-update.mjs`
- Create: `scripts/capture-support-bundle.mjs`
- Modify: `scripts/capture-packaged-macos-release-audit.mjs`
- Modify: `package.json`
- Modify: `docs/qa/feature-user-stories.csv`
- Create: `docs/beta/WELCOME.md`
- Create: `docs/beta/PRIVACY-AND-CLOUD.md`
- Create: `docs/beta/TEST-MISSIONS.md`
- Create: `docs/beta/SUPPORT-BUNDLE.md`
- Create: `docs/beta/UNINSTALL-AND-ROLLBACK.md`
- Create: `docs/beta/ISSUE-TEMPLATE.md`
- Create test: `src/__tests__/packaged-beta-update-script.test.ts`
- Create test: `src/__tests__/support-bundle-script.test.ts`

**Design:**

- Capture a clean-install artifact with exact app digest, isolated or fresh account identity, permissions, onboarding states, first Dictation, first Meeting, and relaunch.
- Capture a real signed `beta.1` to `beta.2` update with before and after version, artifact digests, updater events, relaunch, and data-preservation assertions.
- Generate a previewable support bundle excluding audio, dictated text, transcripts, keys, tokens, and full user paths.
- Prepare concise invite materials with hardware floor, permissions, local and cloud disclosure, missions for both pillars, known limitations, support, and uninstall.

**Red step:** Add schema, redaction, path-removal, missing-evidence, and legitimate bundle tests.

Run and confirm failure:

```bash
bun test src/__tests__/packaged-beta-update-script.test.ts src/__tests__/support-bundle-script.test.ts
```

**Green step:** Implement the harnesses and documentation without publishing or distributing anything.

**Task verification:**

```bash
bun test src/__tests__/packaged-beta-update-script.test.ts src/__tests__/support-bundle-script.test.ts
bun run qa:packaged:macos:onboarding
bun run qa:packaged:macos:smoke
bun run qa:packaged:macos:release-audit
bun run lint
git diff --check
```

The real signed update cannot be marked passed until two authorized, signed candidate artifacts exist. Record it as blocked if signing credentials or release hosting are unavailable.

### Task 16: Exact-candidate release gate

**Files:**

- Modify only as required by failed gates: `scripts/capture-source-gates.mjs`
- Modify only as required by failed gates: `scripts/capture-packaged-macos-release-audit.mjs`
- Update evidence: `docs/qa/feature-user-stories.csv`
- Generate evidence under: `artifacts/qa/macos/`
- Generate trust evidence under: `artifacts/release/`

**Source verification:**

```bash
bun install --frozen-lockfile
bun run lint
bun run test
bun run test:rust
bun run gate:ipc-contract
bun run gate:dead-code
bun run build:renderer
bun run build:electron
bun run gate:release:dependencies
bun run qa:source-gates
git diff --check
```

**Candidate build and trust verification:**

```bash
bun run gate:release-credentials:preflight
bun run release:mac
bun run gate:packaged:macos:native
bun run gate:size
bun run gate:release:licenses
bun run gate:release:macos:trust
bun run qa:packaged:macos:update-metadata
bun run gate:cold-start
```

**Packaged behavior verification:**

```bash
bun run qa:packaged:macos:smoke
bun run qa:packaged:macos:onboarding
bun run qa:packaged:macos:backup
bun run qa:packaged:macos:whisper
bun run qa:packaged:macos:dictation-hotkey
bun run qa:packaged:macos:dictation-hotkey:hold
bun run qa:packaged:macos:dictation-hotkey:hands-free
bun run qa:packaged:macos:app-matrix:equivalence
bun run qa:packaged:macos:app-matrix:preflight
bun run qa:packaged:macos:app-matrix:insertion
bun run qa:packaged:macos:meeting:mic
bun run qa:packaged:macos:meeting:system
bun run qa:packaged:macos:meeting:soak
bun run qa:packaged:macos:system-audio:test
bun run qa:packaged:macos:retention
bun run qa:packaged:macos:exports
bun run qa:packaged:macos:idle-cpu
bun run qa:packaged:macos:release-audit
```

**Manual required receipts:**

- clean install under a fresh macOS user or equivalent isolated environment;
- both themes, keyboard, screen reader, and reduced-motion UI pass;
- supported-hardware Dictation latency receipt;
- microphone-only, system-audio-only, and combined Meeting receipt;
- quit, crash, relaunch, and recovery receipt;
- signed `0.9.0-beta.1` to `0.9.0-beta.2` updater receipt;
- final DMG and ZIP SHA-256 digests tied to every recorded packaged result.

## Completion rule

The repository may be called source-ready only when all source gates pass. It may be called beta-candidate-ready only when the exact signed artifact passes trust, packaged Dictation, packaged Meetings, clean-install, and updater gates. It may be called launched only after the user separately authorizes distribution and the invite group can access the tested artifact.
