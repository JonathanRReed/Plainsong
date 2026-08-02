# Dictation Blocked-App Register

Date: 2026-03-12

This register tracks compatibility gaps that are not yet proven to meet the dictation parity bar. A row gates v1 only when the compatibility matrix marks it `REQUIRED`.

**v1 scope: macOS only.** DA-004, DA-005, and DA-006 are Windows entries and do
not gate the macOS v1 release; they stay open against a future Windows build.
See the scope note in `docs/dictation-app-compatibility-matrix.md`.

Status values:

- `OPEN`
- `INVESTIGATING`
- `MITIGATED`
- `CLOSED`
- `DEFERRED`

## Active Entries

| ID | Platform | App | Current Mode | Status | Risk | Blocker | Required Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DA-001 | macOS | VS Code | `clipboard_only` | `DEFERRED` | Low | Optional code-editor compatibility is outside the v1 release gate. | Revisit only if editor compatibility becomes a product requirement. |
| DA-002 | macOS | Cursor | `clipboard_only` | `DEFERRED` | Low | Removed from the required launch target set. | No v1 evidence required. |
| DA-003 | macOS | HubSpot (Chrome) | `clipboard_only` | `DEFERRED` | Low | Optional CRM compatibility requires a user-present signed-in workspace. | Revisit only if CRM compatibility becomes a product requirement. |
| DA-004 | Windows | Word | `clipboard_only` | `OPEN` | High | Formatting retention and paragraph behavior are not yet benchmarked. | Packaged QA showing insertion fidelity for dictation and formatting cases. |
| DA-005 | Windows | Outlook | `clipboard_only` | `OPEN` | High | Rich-text compose fields are likely to be focus-sensitive and formatting-sensitive. | Packaged QA in email compose with fallback evidence and recovery notes. |
| DA-006 | Windows | Cursor | `clipboard_only` | `OPEN` | Medium | Command mode behavior in Windows editor environments is not yet evidenced. | Packaged QA and benchmark rows for command-mode fixtures. |

## Exit Rule

An entry closes only when:

- the app has a documented `SUPPORTED` or `PARTIAL` status in `docs/dictation-app-compatibility-matrix.md`
- the required packaged evidence exists
- any workaround is documented clearly enough to support a launch claim

`DEFERRED` entries may remain open as backlog without blocking v1.
