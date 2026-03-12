# Dictation Blocked-App Register

Date: 2026-03-12

This register tracks target apps that are in the launch matrix but are not yet proven to meet the dictation parity bar.

Status values:

- `OPEN`
- `INVESTIGATING`
- `MITIGATED`
- `CLOSED`

## Active Entries

| ID | Platform | App | Current Mode | Status | Risk | Blocker | Required Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DA-001 | macOS | VS Code | `clipboard_only` | `OPEN` | High | Direct insertion path is not yet trusted for code-editor workflows. | Packaged QA showing command mode and long utterances with stable recovery. |
| DA-002 | macOS | Cursor | `clipboard_only` | `OPEN` | High | Need proof that commands and snippets coexist without bad edits or focus loss. | Packaged QA plus benchmark rows covering snippet and command overlap. |
| DA-003 | macOS | HubSpot (Chrome) | `clipboard_only` | `OPEN` | High | Rich-text CRM fields are a launch-critical sales workflow and likely focus-sensitive. | Packaged QA in CRM note/email fields with documented fallback behavior. |
| DA-004 | Windows | Word | `clipboard_only` | `OPEN` | High | Formatting retention and paragraph behavior are not yet benchmarked. | Packaged QA showing insertion fidelity for dictation and formatting cases. |
| DA-005 | Windows | Outlook | `clipboard_only` | `OPEN` | High | Rich-text compose fields are likely to be focus-sensitive and formatting-sensitive. | Packaged QA in email compose with fallback evidence and recovery notes. |
| DA-006 | Windows | Cursor | `clipboard_only` | `OPEN` | Medium | Command mode behavior in Windows editor environments is not yet evidenced. | Packaged QA and benchmark rows for command-mode fixtures. |

## Exit Rule

An entry closes only when:

- the app has a documented `SUPPORTED` or `PARTIAL` status in `docs/dictation-app-compatibility-matrix.md`
- the required packaged evidence exists
- any workaround is documented clearly enough to support a launch claim
