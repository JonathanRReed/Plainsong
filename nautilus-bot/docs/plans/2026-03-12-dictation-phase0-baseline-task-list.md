# Dictation Phase 0 Baseline Task List

Date: 2026-03-12
Depends on:

- `docs/plans/2026-03-12-dictation-parity-launch-design.md`
- `docs/plans/2026-03-12-dictation-parity-launch-implementation-plan.md`
- `docs/evals/dictation-parity-launch-scorecard.md`

## Goal

Establish an honest dictation baseline before shipping new parity features. Phase 0 does not claim parity. It records the current state so future improvements can be measured against real artifacts.

## Current Implementation Snapshot

Already present in code:

- command mode with telemetry fields
- snippet expansion with app scope support
- insertion telemetry including `end_to_end_ms` and `insertion_mode_used`
- language override in dictation modes
- context-source selection
- keep-warm controls
- benchmark fixture and benchmark verification tooling

Not yet evidenced or not yet fully surfaced:

- packaged baseline benchmark JSON files
- launch app matrix results
- dictionary v1
- hands-free mode
- launch-grade smart formatting and correction
- GA language certification set
- launch-bounded context-aware styles

## Task List

### T1. Freeze The Baseline App Matrix

Define the exact apps that count toward the launch claim:

- Apple Notes
- Google Docs
- Slack desktop
- Notion desktop
- VS Code
- Cursor
- Messages or iMessage
- one problematic macOS app
- one problematic Windows app

Output:

- append owner and rationale to `docs/evals/dictation-parity-launch-scorecard.md`
- keep live app-level status in `docs/dictation-app-compatibility-matrix.md`
- track blocked targets in `docs/dictation-blocked-app-register.md`

### T2. Freeze The Baseline Language Candidate Set

Choose the first 10 to 20 languages to benchmark and certify later.

Minimum:

- English
- Spanish

Output:

- language candidate list with owner in `docs/evals/dictation-parity-launch-scorecard.md`
- note any platform-specific risk by language

### T3. Record Current Packaged macOS Baseline

Run the current packaged app and collect:

- hotkey success
- insertion success by app
- command mode samples
- snippet samples
- fallback events
- latency fields

Output:

- `docs/evals/benchmark-run-latest-macos.json`
- updated `artifacts/qa/macos/capture-dictation-hotkey.md`
- baseline rows in the CSV scorecard template

### T4. Record Current Packaged Windows Baseline

Run the current packaged app and collect the same evidence as macOS.

Output:

- `docs/evals/benchmark-run-latest-windows.json`
- updated `artifacts/qa/windows/capture-dictation-hotkey.md`
- baseline rows in the CSV scorecard template

### T5. Create The Real Shared Baseline Artifact

After the first platform runs are captured, choose the agreed comparison baseline and store it at:

- `docs/evals/benchmark-run-baseline.json`

Rules:

- this file must represent a real recorded run
- do not synthesize or hand-edit performance fields to satisfy gate scripts
- if macOS and Windows diverge, document which baseline is canonical and why

### T6. Verify Existing Telemetry Coverage

Confirm current runs include:

- `requestedProvider`
- `actualProvider`
- `isFallback`
- `transcriptionLatencyMs`
- `endToEndMs`
- `insertionModeUsed`
- `commandApplied`
- `snippetAppliedCount`

Output:

- sample event payload or benchmark row attached to the Phase 0 log
- issue list for any missing field or inconsistent naming

### T7. Build The Current-State Dictation Register

Classify every launch-critical dictation capability as one of:

- shipped and evidenced
- shipped but not evidenced
- partial
- missing

The initial expected classification is:

- insertion reliability: shipped but not evidenced
- command mode: partial
- snippets: partial
- dictionary: missing
- smart formatting and correction: partial
- hands-free: missing
- context-aware styles: partial
- GA language support: missing

Output:

- one table added to the running scorecard or an attached artifact

### T8. Re-Run Benchmark Gates

Once the real baseline and candidate files exist, run:

```bash
node scripts/verify-benchmark-gates.mjs --schema docs/evals/benchmark-run.schema.json --baseline docs/evals/benchmark-run-baseline.json --candidate docs/evals/benchmark-run-latest-macos.json --out artifacts/benchmark-gates-macos.json
node scripts/verify-benchmark-gates.mjs --schema docs/evals/benchmark-run.schema.json --baseline docs/evals/benchmark-run-baseline.json --candidate docs/evals/benchmark-run-latest-windows.json --out artifacts/benchmark-gates-windows.json
```

If macOS and Windows ultimately require separate comparison baselines, document that explicitly and adjust the package scripts to match. The important rule is to stop leaving the benchmark gate blocked on missing files.

### T9. Publish Phase 0 Outcome

Summarize:

- what is already real
- what is merely configured in code
- what is blocked on benchmark evidence
- which features are definitely missing

Output:

- one short go or no-go baseline note in `docs/prelaunch-readiness.md`
- updated blocker status in `docs/prelaunch-action-checklist.md`

## Immediate Ownership Recommendations

- Product/owner: freeze the launch app matrix and language candidate set
- Engineering: produce packaged benchmark JSON artifacts
- QA: capture hotkey and insertion evidence in the launch app matrix

## Phase 0 Exit Criteria

Phase 0 is complete when:

- baseline benchmark files exist and validate against schema
- macOS and Windows packaged dictation evidence exists
- the launch app matrix is frozen
- the launch language candidate set is frozen
- the dictation scorecard is updated from assumptions to evidence

Until then, all parity work should be treated as `PENDING` or `BLOCKED`, not launch-ready.
