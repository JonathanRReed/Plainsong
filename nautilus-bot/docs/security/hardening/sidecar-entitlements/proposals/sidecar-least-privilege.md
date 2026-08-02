# Security Hardening Proposal: Sidecar Least Privilege

## Decision

Select the per-binary entitlement override for the Plainsong v1 launch path.
Keep process isolation as a later option, not as a prerequisite for launch.

## Executive Recommendation

We considered two options.

1. **Per-binary entitlement override** gives the Rust sidecar a dedicated
   signing policy and makes release verification reject forbidden privileges.
2. **Isolated capability services** splits privileged work into independently
   sandboxed services with narrow protocols.

I recommend Option 1 under the current evidence and latency constraints.

## Evidence

I inspected the baseline source and the exact existing package. The most
important observation is that the package reproduces the source-level concern:
the sidecar actually ships with the broad inherited set.

| Evidence | Finding or document | What it establishes |
| --- | --- | --- |
| `E001` | Broad inherited child entitlements | `entitlements.mac.inherit.plist` grants JIT, unsigned executable memory, disabled library validation, audio, microphone, and Apple Events. |
| `E002` | Incomplete sidecar trust enforcement | The baseline verifier checks only that the sidecar lacks Speech Recognition. |
| `E003` | Packaged sidecar privilege evidence | The signed sidecar carries the broad inherited privileges, including `com.apple.security.inherit`. |
| `E004` | Existing per-helper signing pattern | Shortcut and Speech helpers already receive specialized policies through `optionsForSignedFile`. |

The observed facts support an inference: sidecar policy is currently an
accidental consequence of signing defaults rather than an owned capability
decision.

## Current Design And Failure Mode

Electron Builder provides one inherited child entitlement file. The signing
callback overrides that file for the shortcut and Speech helpers, but not for
`plainsong-sidecar`. The native Rust process therefore receives execution and
automation authority intended for Electron descendants.

This does not prove an exploitable sidecar vulnerability. It does increase the
capability available after any sidecar compromise and makes future privilege
drift easy to miss.

## Desired Invariants

- The sidecar has no JIT, unsigned executable memory, disabled library
  validation, Apple Events, or inherited-authority entitlement.
- The sidecar receives audio authority only when exact-package testing proves
  it is required.
- The release app and update ZIP are checked independently.
- A forbidden privilege fails the release with a named diagnostic.

## Constraints And Non-Goals

- Preserve current JSON-RPC and runtime topology.
- Preserve capture, Speech, shortcut, and meeting behavior.
- Add no production dependency.
- Do not treat this change as a general sandbox redesign.
- Do not claim the finding closed before exact-package proof.

## Before Architecture

The current signing boundary is shown in
[the before diagram](../diagrams/sidecar-least-privilege-before.mmd).

The decision-relevant edge is the inherited policy flowing into the sidecar
without a component-specific review.

## Options

### Option 1: Per-binary entitlement override

The attractive part of this option is that it makes policy ownership explicit
without changing runtime architecture. `optionsForSignedFile` recognizes the
sidecar basename and supplies an empty or demonstrated-minimal entitlement
file. The verifier carries a sidecar-specific forbidden list.

Security improves because Electron-only execution privileges and Apple Events
no longer exist in the sidecar signature. Residual risk remains in the Electron
main process and in any entitlement that packaged tests prove the sidecar must
retain.

Performance and memory should remain neutral because the change affects
signing, not execution. Reliability is the only meaningful uncertainty. Audio
capture might depend on a privilege that was inherited accidentally, so the
package must prove microphone and system audio before acceptance.

The
[Option 1 diagram](../diagrams/sidecar-least-privilege-per-binary-entitlements-after.mmd)
shows the sidecar policy becoming an explicit branch of the existing signing
callback.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Sidecar signing | Broad inherited policy | Dedicated minimal policy | Removes ambient execution and automation authority | One plist and callback branch |
| Release gate | Speech-only sidecar check | Full forbidden sidecar set | Future privilege drift fails closed | Small report and test expansion |
| Runtime | Existing sidecar | Unchanged | No new trust boundary | Packaged regression required |

Rollout is one package build. Rollback is source-level and reversible. If audio
fails, we add only the entitlement demonstrated necessary rather than restoring
the broad inherited file.

### Option 2: Isolated capability services

This option makes the strongest containment case. Capture, secrets, and other
privileged actions would run in separate services behind narrow protocols. A
compromise in one service would not automatically inherit every sidecar
capability.

What gives me pause is the mismatch between that cost and the current evidence.
Plainsong would add processes, serialization, lifecycle coordination, signing
targets, and partial-failure recovery to latency-sensitive paths. Memory and
operational cost rise immediately, while the existing package remains
overprivileged throughout migration.

The
[Option 2 diagram](../diagrams/sidecar-least-privilege-isolated-capability-services-after.mmd)
shows the additional broker and service boundaries.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Privileged work | One Rust sidecar | Capability-limited services | Stronger compromise containment | New processes and protocols |
| Failure handling | One sidecar lifecycle | Partial service failure and restart | Narrower failure domains | More coordination and recovery |
| Release | One native sidecar plus helpers | Several signed services | Per-service authority can be explicit | Larger packaging and verification surface |

Adoption would require a versioned dual path and rollback until every service
has packaged parity. This is a credible later design if new findings justify
the cost, but not a launch prerequisite.

## Comparison

| Dimension | Option 1: Per-binary override | Option 2: Capability services |
| --- | --- | --- |
| Security | Removes observed excess authority | Strongest potential containment |
| Performance | No runtime change | Adds hops and serialization |
| Memory | Neutral | More processes and buffers |
| Reliability | Package entitlement compatibility must be proved | Better isolation, more partial-failure modes |
| Operability | Small explicit signing and report change | Larger signing, logging, and release surface |
| Migration | One reversible package change | Staged architecture migration |

## Recommendation

I recommend Option 1. It directly addresses `E001` to `E003`, reuses the
existing `E004` signing boundary, and preserves the product's hot path.

Option 2 should win only if later source or runtime evidence shows that
sidecar-level compromise is a recurring high-impact risk that per-binary
authority cannot contain.

## Evidence Coverage And Residual Risk

| Evidence | Effect under Option 1 | Residual risk |
| --- | --- | --- |
| `E001`, Broad inherited policy | Addressed | Electron descendants still require their policy |
| `E002`, Incomplete sidecar check | Addressed | The verifier itself remains trusted release code |
| `E003`, Packaged broad privileges | Pending exact-package replacement | Old package remains overprivileged |
| `E004`, Existing helper pattern | Extended | Basename routing must remain covered |

## Migration And Rollout

1. Add the dedicated policy and callback route.
2. Add failing trust-gate fixtures for every forbidden entitlement.
3. Build a newly signed package.
4. Inspect the sidecar in the app and extracted ZIP.
5. Run microphone, system-audio, shortcut, and Speech acceptance.
6. Keep the change only when runtime behavior and least privilege both pass.

## Validation Plan

- `plutil -lint` on the new policy.
- Focused signing and trust tests.
- TypeScript checks.
- Exact-package codesign entitlement inspection.
- Trust gate against app, ZIP, and DMG.
- Real microphone dictation.
- Real microphone and system-audio meeting capture.
- Native shortcut and Apple Speech QA.
- Latency and idle-resource comparison.

## Implementation Work Packages

- Signing policy and routing.
- Release-verifier and regression coverage.
- Exact-package runtime and distribution validation.

## Open Questions

- Does macOS require one narrowly scoped audio entitlement on the separately
  signed sidecar for microphone or system-audio capture?
