# Dictation Benchmark Corpus Template (Wispr Parity)

Date: 2026-02-25  
Owner: Nautilus engineering

## Goal
- Measure dictation quality and speed consistently across releases.
- Track `transcription latency` and `end_to_end_ms` (stop/release -> inserted/copy-ready text).

## Corpus Shape
- `100` short utterances (2-8 words)
- `20` long utterances (20-80 words)
- Languages:
  - English (required)
  - Spanish (required)
  - One additional language relevant to target users (optional)

## Command Mode Set (v1)
- `command newline`
- `command paragraph`
- `command undo last insert`
- `command delete last sentence`
- `command bulletize selection <payload>`
- `command rewrite shorter <payload>`
- `command rewrite professional <payload>`

## Snippet Set (v1)
- `brb -> be right back`
- `omw -> on my way`
- `fup -> following up on`
- `addr -> 123 Main Street, Springfield`
- Add app-scoped snippets for one messaging app and one editor app.

## App Matrix (8 targets)
- Apple Notes
- Google Docs (browser)
- Slack desktop
- Notion desktop
- VS Code
- Cursor
- iMessage / Messages
- One known problematic app from QA history

## Required Metrics
- `transcription_latency_ms`: ASR completion timing from backend event payload.
- `end_to_end_ms`: insertion-ready timing from backend event payload.
- `insertion_mode_used`: `paste` / `clipboard_only` / `command_only` / `none`.
- `command_applied`: command id when command mode is triggered.
- `snippet_applied_count`: number of snippet expansions applied.
- `requested_provider`, `actual_provider`, `is_fallback`: provider-integrity telemetry.

## Pass/Fail Targets
- Supported app insertion success `>= 98%`
- Command intent success `>= 95%`
- Snippet expansion success `>= 99%`
- p50 `end_to_end_ms` improved by `>= 25%` from baseline

## Logging Fields (capture per run)
- build version
- OS + version
- app target
- command/snippet configuration
- provider/model
- requested provider vs actual provider
- fallback reason + `is_fallback` flag
- transcription latency
- end-to-end latency
- insertion outcome
- error text (if present)

## Artifact Format
- Validate benchmark run artifacts against:
  - `docs/evals/benchmark-run.schema.json`
