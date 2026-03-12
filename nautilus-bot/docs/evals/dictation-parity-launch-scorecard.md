# Dictation Parity Launch Scorecard

Date: 2026-03-12
Owner: Nautilus engineering

## Goal

Define the launch-blocking scorecard for Nautilus dictation parity against the current Wispr Flow bar, using evidence that can be reproduced from packaged macOS and Windows builds.

This scorecard is product-facing. It is not satisfied by code existence alone.

## Benchmark Scope

Platforms:

- macOS packaged build
- Windows packaged build

Core product claim:

- dictation works in every app that matters to the launch audience
- insertion is reliable and recoverable
- smart dictation features improve output without reducing trust
- top 10 to 20 languages are truthfully supported

## Evidence Sources

- `docs/evals/benchmark-run-baseline.json`
- `docs/evals/benchmark-run-latest-macos.json`
- `docs/evals/benchmark-run-latest-windows.json`
- `docs/evals/wispr-vs-nautilus-scorecard-template.csv`
- `docs/evals/dictation-parity-fixture.json`
- `docs/dictation-app-compatibility-matrix.md`
- `docs/dictation-blocked-app-register.md`
- `artifacts/qa/macos/capture-dictation-hotkey.md`
- `artifacts/qa/windows/capture-dictation-hotkey.md`
- `artifacts/benchmark-gates-macos.json`
- `artifacts/benchmark-gates-windows.json`

## Gate Definitions

Status values:

- `PASS`
- `FAIL`
- `PARTIAL`
- `BLOCKED`
- `PENDING`

| ID | Capability | Current Baseline | Pass Criteria | Evidence |
| --- | --- | --- | --- | --- |
| DP-01 | Packaged dictation start and stop | `BLOCKED` | Dictation hotkey succeeds 10/10 on macOS and Windows packaged builds with no stuck overlay or silent failure. | packaged QA rows + short capture video |
| DP-02 | Insertion reliability in launch app matrix | `PENDING` | Insertion success or graceful recovery is `>= 98%` across the launch app matrix. | benchmark run JSON + QA notes |
| DP-03 | Provider-integrity telemetry | `PARTIAL` | `requestedProvider`, `actualProvider`, `isFallback`, `insertionModeUsed`, `commandApplied`, `snippetAppliedCount`, and `endToEndMs` are present for benchmark rows. | benchmark schema validation + event sample |
| DP-04 | Command mode v1 | `PARTIAL` | Launch command set achieves `>= 95%` intent success on fixture corpus. | benchmark gate output + command corpus log |
| DP-05 | Snippets v1 | `PARTIAL` | Snippet expansion achieves `>= 99%` success, including app-scoped snippets. | benchmark gate output + snippet fixture list |
| DP-06 | Dictionary v1 | `BLOCKED` | Protected terms and replacements persist correctly across supported apps and GA languages. | dictionary fixture report + packaged QA |
| DP-07 | Smart formatting and correction | `BLOCKED` | Formatting and bounded correction measurably improve output without unacceptable false edits. | formatter benchmark report + QA notes |
| DP-08 | Hands-free mode | `BLOCKED` | Hands-free can start, stop, and recover reliably with visible cues and low false-trigger rate. | long-session QA notes + video |
| DP-09 | Context-aware styles | `BLOCKED` | App-aware style transforms improve output in the approved launch app matrix and never block dictation. | style benchmark rows + QA notes |
| DP-10 | GA language certification | `BLOCKED` | Top 10 to 20 languages have documented provider-model guidance and benchmark evidence. | language certification matrix + benchmark artifacts |
| DP-11 | Latency parity trend | `BLOCKED` | Candidate p50 `end_to_end_ms` improves by `>= 25%` versus established baseline. | `verify-benchmark-gates.mjs` output |
| DP-12 | Trust and recovery UX | `PARTIAL` | Users can see recording, processing, fallback, and delivery states and recover from failure quickly. | packaged QA notes + event samples |

## Launch App Matrix

The default launch matrix is:

- Apple Notes
- Google Docs
- Slack desktop
- Notion desktop
- VS Code
- Cursor
- Messages or iMessage
- HubSpot in Chrome on macOS
- Outlook on Windows

Rationale:

- it covers native notes, browser docs, chat, knowledge tools, code editors, messaging, CRM, and email composition
- it matches the launch audience of solo professionals, founders, operators, and sales people
- it keeps the matrix small enough to benchmark honestly

Owner split:

- Product owns the matrix definition
- Engineering owns insertion behavior and telemetry
- QA owns packaged evidence capture

This matrix may grow later, but launch claims must be limited to the verified set and tracked in `docs/dictation-app-compatibility-matrix.md`.

## Launch Language Matrix

Phase 0 must lock a GA candidate set of 10 to 20 languages.

Minimum required launch candidates:

- English
- Spanish

Suggested next candidates:

- Portuguese
- French
- German
- Italian
- Dutch
- Japanese
- Korean
- Mandarin Chinese

Initial freeze rationale:

- these languages cover the highest-probability mainstream launch use cases
- they balance Western business usage with globally important high-demand languages
- they are narrow enough to benchmark honestly before broadening support

Owner split:

- Product owns the final GA language list
- Engineering owns provider-model guidance
- QA owns certification evidence

Additional languages should be added only if the benchmark and insertion evidence exists.

## Current Baseline Reading

What the current codebase already supports:

- command mode and telemetry fields
- snippet expansion and app-scoped snippet behavior
- insertion mode telemetry and end-to-end timing
- language override plumbing
- context source plumbing
- keep-warm policy controls
- benchmark generation and verification scripts

What is still missing or not launch-certified:

- benchmark run JSON artifacts
- packaged app evidence for current dictation claims
- dictionary product surface
- hands-free product surface
- launch-grade smart formatting and correction evidence
- GA language certification evidence
- context-aware styles limited to a verified app matrix

## Phase 0 Deliverables

- real `benchmark-run-baseline.json`
- real `benchmark-run-latest-macos.json`
- real `benchmark-run-latest-windows.json`
- launch app matrix owner list
- launch language candidate list
- baseline CSV populated from current runs
- blocked-app register for insertion issues

## Commands

Baseline generation path:

```bash
npm run build
node scripts/generate-dictation-benchmark.mjs --fixtures docs/evals/dictation-parity-fixture.json --out artifacts/evals/dictation-benchmark-baseline-dev.json
node scripts/verify-benchmark-gates.mjs --schema docs/evals/benchmark-run.schema.json --baseline docs/evals/benchmark-run-baseline.json --candidate docs/evals/benchmark-run-latest-macos.json --out artifacts/benchmark-gates-macos.json
node scripts/verify-benchmark-gates.mjs --schema docs/evals/benchmark-run.schema.json --baseline docs/evals/benchmark-run-baseline.json --candidate docs/evals/benchmark-run-latest-windows.json --out artifacts/benchmark-gates-windows.json
```

The generated dev artifact is useful for tooling validation, but it does not replace packaged baseline evidence.

## Exit Rule

Launch recommendation is `NO-GO` if any `DP-*` gate is not `PASS`.
