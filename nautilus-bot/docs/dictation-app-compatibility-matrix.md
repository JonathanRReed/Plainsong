# Dictation App Compatibility Matrix (macOS + Windows)

Status values:
- `SUPPORTED`: direct paste path is reliable.
- `PARTIAL`: works with caveats (permission/app focus/format quirks).
- `CLIPBOARD_ONLY`: copy path works, direct paste is blocked/unreliable.
- `UNSUPPORTED`: neither mode is acceptable for GA.

## macOS

| App | Status | Mode Used | Notes |
| --- | --- | --- | --- |
| Apple Notes | PENDING | auto | Validate paragraph/newline command behavior. |
| Google Docs (Chrome) | PENDING | auto | Validate cursor focus recovery after hotkey release. |
| Slack | PENDING | auto | Validate snippet expansions and punctuation consistency. |
| Notion | PENDING | auto | Validate multiline insert behavior. |
| VS Code | PENDING | clipboard_only | Validate command mode payload rewrites. |
| Cursor | PENDING | clipboard_only | Validate command mode + snippet coexistence. |
| Messages | PENDING | auto | Validate short utterance handling. |
| One problematic app | PENDING | clipboard_only | Capture exact limitation and remediation. |

## Windows

| App | Status | Mode Used | Notes |
| --- | --- | --- | --- |
| Notepad | PENDING | clipboard_only | Current runtime defaults to clipboard fallback. |
| Word | PENDING | clipboard_only | Validate formatting retention. |
| Google Docs (Edge/Chrome) | PENDING | clipboard_only | Validate browser focus behavior. |
| Slack | PENDING | clipboard_only | Validate snippet triggers and punctuation. |
| Notion | PENDING | clipboard_only | Validate multiline behavior. |
| VS Code | PENDING | clipboard_only | Validate long utterances. |
| Cursor | PENDING | clipboard_only | Validate command handling behavior. |
| One problematic app | PENDING | clipboard_only | Capture exact limitation and remediation. |

## Exit Gate
- Mark launch-ready only when all target apps are `SUPPORTED` or `PARTIAL` with documented workaround.
