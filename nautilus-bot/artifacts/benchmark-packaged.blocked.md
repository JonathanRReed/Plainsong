# Packaged Dictation Benchmark Evidence (Blocked)

Status: BLOCKED
Generated: 2026-04-09T16:08:53.831Z

## Current Local Observation
- `docs/evals/benchmark-run-baseline.json` exists, but it is still tagged as a local baseline artifact.
- `docs/evals/benchmark-run-latest-macos.json` exists and the local macOS benchmark gate passes.
- `docs/evals/benchmark-run-latest-windows.json` exists and the local Windows benchmark gate passes.
- These artifacts are still local or fixture-tagged benchmark runs, not packaged-app evidence captured from signed release builds.

## Blocking Detail
- Baseline artifact run id: `dictation-parity-local-baseline`
- macOS artifact run id: `dictation-parity-local-macos`
- Windows artifact run id: `dictation-parity-local-windows-fixture`
- Launch requires packaged benchmark evidence for both macOS and Windows, plus app-matrix validation, before dictation parity claims are ship-ready.
