# Dictation App Compatibility Matrix (macOS + Windows)

Phase 0 compatibility catalog, updated for the macOS v1 launch gate on 2026-07-30.

**v1 scope: macOS only.** v1 ships an Apple Silicon macOS build; the Windows
release leg was removed. The Windows table below is retained as the plan for a
later release and is not a v1 gate — read the exit gate at the bottom as
applying to the macOS table alone. `scripts/capture-packaged-macos-app-matrix-preflight.mjs`
already behaves this way: it skips every row whose platform heading is not
`macOS`.

Status values:
- `PENDING`: not yet validated in packaged QA.
- `SUPPORTED`: direct paste path is reliable.
- `PARTIAL`: works with caveats (permission/app focus/format quirks).
- `CLIPBOARD_ONLY`: copy path works, direct paste is blocked/unreliable.
- `UNSUPPORTED`: neither mode is acceptable for GA.
- `DEFERRED`: optional compatibility work that is outside the v1 release gate.

Launch-gate values:
- `REQUIRED`: verifier-clean packaged evidence is required for v1.
- `DEFERRED`: the row remains useful compatibility backlog, but does not block v1.

This matrix is the default source of truth for DP-02 in `docs/evals/dictation-parity-launch-scorecard.md`.

## macOS

| App | Status | Mode Used | Launch Gate | Notes |
| --- | --- | --- | --- | --- |
| Apple Notes | PARTIAL | auto | REQUIRED | Packaged insertion verified in `release-launch-candidate-clean-20260730/qa/app-matrix-insertion-apple-notes.md`. In a brand-new empty note, click the body once to establish the insertion caret before dictating. |
| Google Docs (Chrome) | SUPPORTED | auto | REQUIRED | Packaged insertion verified in `release-launch-candidate-clean-20260730/qa/app-matrix-insertion-google-docs-chrome.md`. |
| Slack | SUPPORTED | auto | REQUIRED | Packaged insertion verified in `release-launch-candidate-clean-20260730/qa/app-matrix-insertion-slack.md`. |
| Notion | DEFERRED | auto | DEFERRED | Optional notes-workspace compatibility. No installation or packaged QA is required for v1. |
| VS Code | DEFERRED | clipboard_only | DEFERRED | Optional editor compatibility. Existing evidence may inform future work, but no further host-app QA is required for v1. |
| Cursor | DEFERRED | clipboard_only | DEFERRED | Removed from the required launch target set. No installation or packaged QA is required. |
| Messages | SUPPORTED | auto | REQUIRED | Packaged insertion verified in `release-launch-candidate-clean-20260730/qa/app-matrix-insertion-messages.md`. |
| HubSpot (Chrome) | DEFERRED | clipboard_only | DEFERRED | Optional CRM compatibility that requires a user-present signed-in workspace. It does not block v1. |

## Windows

| App | Status | Mode Used | Launch Gate | Notes |
| --- | --- | --- | --- | --- |
| Notepad | PENDING | clipboard_only | DEFERRED | Low-complexity text field baseline; current runtime defaults to clipboard fallback. |
| Word | PENDING | clipboard_only | DEFERRED | High-value document target; validate formatting retention. |
| Google Docs (Edge/Chrome) | PENDING | clipboard_only | DEFERRED | Browser editor baseline; validate focus and paste behavior. |
| Slack | PENDING | clipboard_only | DEFERRED | High-frequency chat target; validate snippet triggers and punctuation. |
| Notion | PENDING | clipboard_only | DEFERRED | High-frequency notes workspace; validate multiline behavior. |
| VS Code | PENDING | clipboard_only | DEFERRED | High-value operator/founder target; validate long utterances. |
| Cursor | PENDING | clipboard_only | DEFERRED | Optional future Windows editor compatibility. |
| Outlook | PENDING | clipboard_only | DEFERRED | Launch-problematic sales target; capture rich-text compose limitations. |

## Exit Gate
- Mark launch-ready only when every `REQUIRED` macOS row is `SUPPORTED` or `PARTIAL`, has verifier-clean packaged evidence, and has any workaround documented.
- `DEFERRED` rows remain compatibility backlog and do not block v1.
- The Windows table is out of scope until a Windows build ships.
