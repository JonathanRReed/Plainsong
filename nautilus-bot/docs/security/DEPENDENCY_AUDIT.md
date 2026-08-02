# Release dependency audit

Plainsong does not suppress `bun audit` findings globally. The release gate
reviews the exact packaged app and permits one narrow exception while upstream
build tools still depend on affected `brace-expansion` versions.

## Current exception

- Advisory: `GHSA-mh99-v99m-4gvg`, Bun advisory id `1124334`
- Affected package: `brace-expansion` versions through `5.0.7`
- Patched top-level package: `5.0.8`
- Remaining affected copies: transitive copies below Electron packaging and
  development utilities
- Product exposure: none in the packaged ASAR or its unpacked resources

The affected code receives trusted repository build patterns. It is not
reachable from dictation audio, transcripts, settings, IPC, exports, updater
metadata, or another shipped user-input surface. Pull request workflows already
execute contributor-controlled repository code, so a contributor can stop
their own build without relying on brace expansion.

## Enforced release conditions

Run:

```sh
bun run gate:release:dependencies
```

The gate fails if:

- Bun reports any advisory other than the reviewed brace-expansion advisory
- an affected brace-expansion copy appears outside the reviewed lockfile paths
- the top-level brace-expansion version regresses below `5.0.8`
- brace-expansion, minimatch, glob, Electron Builder, or its ASAR utilities
  enter the packaged application

Remove the exception as soon as the Electron packaging dependency tree no
longer contains affected copies. A clean `bun audit` remains the target state.
