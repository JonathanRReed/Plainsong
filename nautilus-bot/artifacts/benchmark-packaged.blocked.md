# Packaged Dictation Benchmark Evidence (Blocked)

Status: BLOCKED
Generated: 2026-05-05T15:17:06.616Z

## Current Local Observation
- `docs/evals/benchmark-run-baseline.json` exists, but it is still tagged as a local baseline artifact.
- `docs/evals/benchmark-run-latest-macos.json` exists and the local macOS benchmark gate passes.
- `docs/evals/benchmark-run-latest-windows.json` exists and the local Windows benchmark gate passes.

## Current Packaged Observation
- `docs/evals/benchmark-run-packaged-macos.json` exists with run id `dictation-parity-packaged-macos-1777753026537`.
- `artifacts/benchmark-packaged-macos.json` passes.
- `artifacts/benchmark-gates-packaged-macos.json` passes.
- `docs/evals/benchmark-run-packaged-windows.json` is missing.
- `artifacts/benchmark-packaged-windows.json` is missing or blocked.
- `artifacts/benchmark-gates-packaged-windows.json` is missing or blocked.

## Blocking Detail
- Baseline artifact run id: `dictation-parity-local-baseline`
- macOS artifact run id: `dictation-parity-local-macos`
- Windows artifact run id: `dictation-parity-local-windows-fixture`
- macOS packaged benchmark artifact run id: `dictation-parity-packaged-macos-1777753026537`
- Windows packaged benchmark artifact run id: `missing`
- Launch still requires packaged benchmark evidence on both platforms plus app-matrix validation before dictation parity claims are ship-ready.
- Windows packaged capture command: `bun run benchmark:dictation:packaged:windows`.
