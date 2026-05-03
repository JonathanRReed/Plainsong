# macOS Dictation App Matrix Preflight

Status: BLOCKED
Generated: 2026-05-03T15:52:36.281Z

This is a packaged-evidence preflight only. It does not certify app support and must not be used to move any app out of `PENDING`.

## Summary

- Matrix rows: 8
- Installed target apps found: 5
- Rows covered by packaged benchmark fixtures: 8
- Open blocked-app entries: 3
- Manual capture candidates: 3
- Launch-ready rows certified by this artifact: 0

## Rows

| App | Mode | Installed | Packaged benchmark scenarios | Open blocked entries | Scratch target env | Capture command | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Apple Notes | auto | yes | basic-notes | none | not ready | not ready | resolve blocked entry or scenario gap |
| Google Docs (Chrome) | auto | yes | command-newline, command-paragraph, it-google-docs-brief | none | `NAUTILUS_QA_SCRATCH_GOOGLE_DOCS` | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Google Docs (Chrome)" --scratch-target "$NAUTILUS_QA_SCRATCH_GOOGLE_DOCS"` | capture real packaged insertion |
| Slack | auto | yes | command-rewrite-shorter, snippet-positive-slack, nl-slack-check-in | none | `NAUTILUS_QA_SCRATCH_SLACK` | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Slack" --scratch-target "$NAUTILUS_QA_SCRATCH_SLACK"` | capture real packaged insertion |
| Notion | auto | no | snippet-negative-notion, ja-notion-brief | none | not ready | not ready | install target app before capture |
| VS Code | clipboard_only | no | command-delete-last-sentence, command-bulletize-selection, zh-vscode-checklist | DA-001 | not ready | not ready | install target app before capture |
| Cursor | clipboard_only | no | command-undo, command-rewrite-professional, ko-cursor-comment | DA-002 | not ready | not ready | install target app before capture |
| Messages | auto | yes | safety-no-command-center | none | `NAUTILUS_QA_SCRATCH_MESSAGES` | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Messages" --scratch-target "$NAUTILUS_QA_SCRATCH_MESSAGES"` | capture real packaged insertion |
| HubSpot (Chrome) | clipboard_only | yes | de-hubspot-call-log | DA-003 | not ready | not ready | resolve blocked entry or scenario gap |

## Required Follow-Up

- Capture real packaged insertion behavior in each target editor.
- Use the per-row capture command for every manual capture candidate.
- Update `docs/dictation-app-compatibility-matrix.md` only after real insertion evidence exists.
- Close blocked-app register entries only after their required evidence is attached.
