# Dictation App Matrix Evidence

Generated: 2026-04-09T16:08:48.649Z

This rollup compares the frozen launch app matrix with the current local benchmark corpus and blocked-app register. It does not replace packaged QA, but it shows where the local corpus already exercises insertion behavior and where gaps remain.

## macOS matrix

| App | Matrix status | Mode | Local corpus | Scenario IDs | Notes |
| --- | --- | --- | --- | --- | --- |
| Apple Notes | PENDING | auto | covered | basic-notes | Core native text-field baseline for solo-professional dictation. |
| Google Docs (Chrome) | PENDING | auto | covered | command-newline, command-paragraph, it-google-docs-brief | High-value browser editor; validate cursor focus recovery after hotkey release. |
| Slack | PENDING | auto | covered | command-rewrite-shorter, snippet-positive-slack, nl-slack-check-in | High-frequency chat target; validate snippet expansions and punctuation consistency. |
| Notion | PENDING | auto | covered | snippet-negative-notion, ja-notion-brief | High-frequency notes workspace; validate multiline insert behavior. |
| VS Code | PENDING | clipboard_only | covered | command-delete-last-sentence, command-bulletize-selection, zh-vscode-checklist | High-value operator/founder target; direct insert remains lower confidence today. |
| Cursor | PENDING | clipboard_only | covered | command-undo, command-rewrite-professional, ko-cursor-comment | AI editor target; validate command mode and snippet coexistence. |
| Messages | PENDING | auto | covered | safety-no-command-center | Short-utterance chat baseline. |
| HubSpot (Chrome) | PENDING | clipboard_only | covered | de-hubspot-call-log | Launch-problematic CRM target for sales workflows; capture rich-text field limitations. |

## Windows matrix

| App | Matrix status | Mode | Local corpus | Scenario IDs | Notes |
| --- | --- | --- | --- | --- | --- |
| Notepad | PENDING | clipboard_only | covered | fr-notepad-quick-note | Low-complexity text field baseline; current runtime defaults to clipboard fallback. |
| Word | PENDING | clipboard_only | covered | es-word-follow-up | High-value document target; validate formatting retention. |
| Google Docs (Edge/Chrome) | PENDING | clipboard_only | covered | command-newline, command-paragraph, it-google-docs-brief | Browser editor baseline; validate focus and paste behavior. |
| Slack | PENDING | clipboard_only | covered | command-rewrite-shorter, snippet-positive-slack, nl-slack-check-in | High-frequency chat target; validate snippet triggers and punctuation. |
| Notion | PENDING | clipboard_only | covered | snippet-negative-notion, ja-notion-brief | High-frequency notes workspace; validate multiline behavior. |
| VS Code | PENDING | clipboard_only | covered | command-delete-last-sentence, command-bulletize-selection, zh-vscode-checklist | High-value operator/founder target; validate long utterances. |
| Cursor | PENDING | clipboard_only | covered | command-undo, command-rewrite-professional, ko-cursor-comment | AI editor target; validate command handling behavior. |
| Outlook | PENDING | clipboard_only | covered | pt-outlook-follow-up | Launch-problematic sales target; capture rich-text compose limitations. |

## Open blocked apps

| ID | Platform | App | Status | Risk | Blocker |
| --- | --- | --- | --- | --- | --- |
| DA-001 | macOS | VS Code | `OPEN` | High | Direct insertion path is not yet trusted for code-editor workflows. |
| DA-002 | macOS | Cursor | `OPEN` | High | Need proof that commands and snippets coexist without bad edits or focus loss. |
| DA-003 | macOS | HubSpot (Chrome) | `OPEN` | High | Rich-text CRM fields are a launch-critical sales workflow and likely focus-sensitive. |
| DA-004 | Windows | Word | `OPEN` | High | Formatting retention and paragraph behavior are not yet benchmarked. |
| DA-005 | Windows | Outlook | `OPEN` | High | Rich-text compose fields are likely to be focus-sensitive and formatting-sensitive. |
| DA-006 | Windows | Cursor | `OPEN` | Medium | Command mode behavior in Windows editor environments is not yet evidenced. |
