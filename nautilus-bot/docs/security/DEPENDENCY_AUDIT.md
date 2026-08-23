# Release dependency audit

Plainsong does not suppress JavaScript or Rust vulnerability findings. The
release gates inspect the installed Bun graph, the exact packaged application,
and the locked Rust graph.

## Current state

- `bun audit --json` reports no advisories across 564 checked packages.
- Every `brace-expansion` copy in `bun.lock` is at its patched floor or newer.
- `cargo audit --json --no-fetch --file rust-sidecar/Cargo.lock` reports zero
  vulnerabilities across 506 locked dependencies.
- Cargo Audit reports one informational maintenance warning for the transitive
  `paste 1.0.15` crate used below the local ML dependency graph. It is
  unmaintained, not a published vulnerability, and has no direct replacement
  controlled by this repository.
- No dependency exception is accepted by the release gate.

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
