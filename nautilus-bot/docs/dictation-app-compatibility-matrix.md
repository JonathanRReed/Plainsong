# Dictation App Compatibility Matrix (macOS + Windows)

Frozen Phase 0 launch matrix as of 2026-03-12.

Status values:
- `PENDING`: not yet validated in packaged QA.
- `SUPPORTED`: direct paste path is reliable.
- `PARTIAL`: works with caveats (permission/app focus/format quirks).
- `CLIPBOARD_ONLY`: copy path works, direct paste is blocked/unreliable.
- `UNSUPPORTED`: neither mode is acceptable for GA.

This matrix is the default source of truth for DP-02 in `docs/evals/dictation-parity-launch-scorecard.md`.

## macOS

| App | Status | Mode Used | Notes |
| --- | --- | --- | --- |
| Apple Notes | SUPPORTED | auto | Packaged insertion verified in `artifacts/qa/macos/app-matrix-insertion-apple-notes.md`. |
| Google Docs (Chrome) | PENDING | auto | High-value browser editor; validate cursor focus recovery after hotkey release. |
| Slack | PENDING | auto | High-frequency chat target; validate snippet expansions and punctuation consistency. |
| Notion | PENDING | auto | High-frequency notes workspace; validate multiline insert behavior. |
| VS Code | PENDING | clipboard_only | High-value operator/founder target; direct insert remains lower confidence today. |
| Cursor | PENDING | clipboard_only | AI editor target; validate command mode and snippet coexistence. |
| Messages | PENDING | auto | Short-utterance chat baseline. |
| HubSpot (Chrome) | PENDING | clipboard_only | Launch-problematic CRM target for sales workflows; capture rich-text field limitations. |

## Windows

| App | Status | Mode Used | Notes |
| --- | --- | --- | --- |
| Notepad | PENDING | clipboard_only | Low-complexity text field baseline; current runtime defaults to clipboard fallback. |
| Word | PENDING | clipboard_only | High-value document target; validate formatting retention. |
| Google Docs (Edge/Chrome) | PENDING | clipboard_only | Browser editor baseline; validate focus and paste behavior. |
| Slack | PENDING | clipboard_only | High-frequency chat target; validate snippet triggers and punctuation. |
| Notion | PENDING | clipboard_only | High-frequency notes workspace; validate multiline behavior. |
| VS Code | PENDING | clipboard_only | High-value operator/founder target; validate long utterances. |
| Cursor | PENDING | clipboard_only | AI editor target; validate command handling behavior. |
| Outlook | PENDING | clipboard_only | Launch-problematic sales target; capture rich-text compose limitations. |

## Exit Gate
- Mark launch-ready only when all target apps are `SUPPORTED` or `PARTIAL` with documented workaround.
