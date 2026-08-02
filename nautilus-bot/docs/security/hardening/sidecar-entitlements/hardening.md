# Security Hardening Review: Plainsong Sidecar Entitlements

## Evidence Basis

I inspected the baseline signing callback, inherited entitlement policy, release
trust verifier, and the signed 2026-07-29 package. The package confirms that
the native Rust sidecar receives Electron-only execution and Apple Events
privileges. The evidence is source and package specific, not a generic Electron
recommendation.

## Constraints

We must preserve packaged dictation, microphone and system-audio meetings,
shortcuts, Speech, latency, and current release tooling. We should not introduce
a new process boundary without a measured need.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Give the Rust sidecar a least-privilege signing policy | Broad inherited policy, incomplete baseline trust check, and live packaged entitlement output (`E001` to `E004`) | Per-binary override; isolated capability services | Use the per-binary override for launch | [Review the complete proposal](proposals/sidecar-least-privilege.md) |

## Recommendation Summary

I recommend the per-binary entitlement override. It extends a pattern already
used for the shortcut and Speech helpers, adds no runtime hop, and is reversible.
The trust gate must reject privilege drift in both the release app and the app
inside the update ZIP.

Service isolation could provide stronger containment, but the current evidence
does not justify its latency, memory, lifecycle, and migration cost. It becomes
preferable if later findings show recurring unsafe authority inside the sidecar.

The source implementation and regression tests are not sufficient to close the
finding. Closure requires a newly signed package whose sidecar has the minimal
policy while real dictation, meeting audio, shortcuts, and Speech still pass.

## Next Decisions

- Build a new signed package after the concurrent Rust tranche stabilizes.
- Run package entitlement inspection.
- Run microphone, system-audio, shortcut, and Speech acceptance.
- Add a narrowly scoped audio entitlement only if those tests prove it is
  required.

