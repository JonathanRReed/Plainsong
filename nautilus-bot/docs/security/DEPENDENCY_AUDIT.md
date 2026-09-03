# Release dependency audit

Plainsong does not suppress JavaScript or Rust vulnerability findings. The
release gates inspect the installed Bun graph, the exact packaged application,
and the locked Rust graph.

## Current state

Last re-run 2026-09-03 on `bun@1.4.0`.

- `bun audit --json` reports no advisories across 564 checked packages.
- Every `brace-expansion` copy in `bun.lock` is at its patched floor or newer.
- `cargo audit --json --no-fetch --file rust-sidecar/Cargo.lock` reports zero
  vulnerabilities across 590 locked dependencies, against a 1,226-advisory
  database.
- Cargo Audit reports two informational warnings, neither a published
  vulnerability:
  - `paste 1.0.15` (RUSTSEC-2024-0436) is unmaintained. It is transitive under
    the local ML dependency graph and has no direct replacement controlled by
    this repository.
  - `chacha20 0.10.0` has been yanked from crates.io. It arrives through the
    direct `rand 0.10.2` dependency, which is the only crate in the lock that
    asks for it. A yank is not an advisory and does not fail the gate; the
    replacement belongs with whatever moves `rand`, not here.
- No dependency exception is accepted by the release gate.

## Overrides held above their dependents' requests

`package.json` `overrides` pins a few transitive packages above what their
dependents ask for. Each one exists to clear a published advisory, and each is
re-checked whenever `bun audit` runs:

- `@xmldom/xmldom` at `^0.8.15`. Below 0.8.15 the 0.8 line carries
  GHSA-6gmq-8vp8-gcm6 (moderate: XML fragment injection through an invalid
  `EntityReference.nodeName` during `requireWellFormed` serialization). The
  pin also holds `plist` 3.1.1, which asks for `^0.9.10`, on the 0.8 line so
  Electron Builder's two `plist` copies resolve to one package; 0.8.15 is a
  patch release on the version this repository has always built against.
- `fast-uri` at `^3.1.6` (resolves 3.1.7). Below 3.1.6 it carries four high
  advisories — GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf
  and GHSA-jqff-g426-hqxp (host confusion and two server-side request forgery
  paths). It reaches the tree only through Ajv, which asks for `^3.0.1`.

Neither package is in the packaged `app.asar`: both are build-time only, and
`gate:release:dependencies` reports zero affected packaged entries. They are
still pinned because the gate fails on any advisory in the installed graph, not
only on ones that ship.

## Enforced release conditions

Run:

```sh
bun run gate:release:dependencies
bun run gate:release:rust-dependencies
```

The gates fail if:

- Bun reports any advisory
- any `brace-expansion` copy regresses below its patched version-family floor
- brace-expansion, minimatch, glob, Electron Builder, or its ASAR utilities
  enter the packaged application
- Cargo Audit reports a Rust vulnerability

The exact packaged-app check still runs because a clean development audit does
not prove which packages were included in `app.asar`.
