# Implementation Plan: Per-Binary Entitlement Override

## Selected Design And Constraints

The selected design gives `plainsong-sidecar` a dedicated empty entitlement
file and adds a release check that rejects inherited, audio, Apple Events, JIT,
unsigned executable memory, disabled library validation, and Speech
Recognition privileges.

Runtime topology, IPC, capture code, and stored data remain unchanged.

## Source Revision And Drift Check

- Baseline revision: `18cd7389f29ea9221174ad88b799a65292864bc3`
- Source drift: present
- Reason: this implementation and unrelated concurrent Rust work are
  uncommitted

Refresh the diff and rerun tests before package construction.

## Affected Components

- `build-resources/entitlements.mac.sidecar.plist`
- `scripts/sign-macos.mjs`
- `scripts/verify-macos-release-trust.mjs`
- `src/__tests__/macos-apple-speech-helper.test.ts`
- `src/__tests__/macos-release-trust-script.test.ts`

## Ordered Work Packages

1. Add the sidecar policy and signing route.
2. Add sidecar-specific trust diagnostics and fail-closed checks.
3. Add regression fixtures for every forbidden privilege.
4. Build a new signed package.
5. Run exact-package entitlement and runtime acceptance.

## Compatibility And Migration

There is no data or protocol migration. The compatibility question is whether
the separately signed sidecar requires a narrow audio entitlement on the
supported macOS versions.

## Tactical Protections During Migration

- Keep the new trust check enabled.
- Do not publish any package that fails it.
- If capture fails, test the minimum audio entitlement explicitly.
- Do not restore the inherited Electron policy.

## Tests And Security Validation

- Focused signing and trust tests.
- TypeScript checks.
- Plist validation.
- Exact app and ZIP entitlement inspection.
- Real microphone, system-audio, shortcut, and Speech flows.

## Performance And Resource Benchmarks

Compare dictation p50, p95, first-sample latency, idle CPU, and idle memory with
the current baseline. No material change is expected because signing policy
does not change runtime topology.

## Rollout And Rollback

Roll out in one local package. Roll back only if exact-package evidence proves
a required privilege, then replace the empty file with that one narrow
entitlement and keep the forbidden set for every other privilege.

## Acceptance Criteria

- Source tests pass.
- The new sidecar has no forbidden privilege in the app or ZIP.
- Packaged microphone, system audio, shortcuts, and Speech pass.
- The release trust gate remains blocked only on genuine remaining Apple or
  distribution gates.

## Open Decisions

- Whether one audio entitlement is required by the packaged sidecar.

