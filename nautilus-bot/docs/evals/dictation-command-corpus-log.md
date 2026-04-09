# Dictation Command Corpus Log

Generated: 2026-04-09T16:08:48.649Z

Local benchmark command checks currently pass at 100%. This corpus proves command parsing and no-command safety in the local fixture path. Packaged validation is still required for launch claims.

| ID | Label | App | Language | Expected | Actual | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| basic-notes | Basic dictation in notes | Apple Notes | en | no command | none | PASS |
| command-newline | Insert newline by command | Google Docs | en | newline | newline | PASS |
| command-paragraph | Insert paragraph break by command | Google Docs | en | paragraph | paragraph | PASS |
| command-undo | Undo the last insert by voice | Cursor | en | undo_last_insert | undo_last_insert | PASS |
| command-delete-last-sentence | Delete the last sentence by voice | VS Code | en | delete_last_sentence | delete_last_sentence | PASS |
| command-rewrite-shorter | Rewrite shorter command | Slack | en | rewrite_shorter | rewrite_shorter | PASS |
| command-rewrite-professional | Rewrite professional command | Cursor | en | rewrite_professional | rewrite_professional | PASS |
| command-bulletize-selection | Bulletize selection command | VS Code | en | bulletize_selection | bulletize_selection | PASS |
| snippet-positive-slack | App-scoped snippet expands in Slack | Slack | en | no command | none | PASS |
| snippet-negative-notion | App-scoped snippet stays off in Notion | Notion | en | no command | none | PASS |
| safety-no-command-center | Command prefix inside normal speech stays plain text | Messages | en | no command | none | PASS |
| es-word-follow-up | Spanish follow-up in Word | Word | es | no command | none | PASS |
| pt-outlook-follow-up | Portuguese follow-up in Outlook | Outlook | pt | no command | none | PASS |
| fr-notepad-quick-note | French quick note in Notepad | Notepad | fr | no command | none | PASS |
| de-hubspot-call-log | German call log in HubSpot | HubSpot | de | no command | none | PASS |
| it-google-docs-brief | Italian brief in Google Docs | Google Docs | it | no command | none | PASS |
| nl-slack-check-in | Dutch check-in in Slack | Slack | nl | no command | none | PASS |
| ja-notion-brief | Japanese brief in Notion | Notion | ja | no command | none | PASS |
| ko-cursor-comment | Korean comment in Cursor | Cursor | ko | no command | none | PASS |
| zh-vscode-checklist | Mandarin checklist in VS Code | VS Code | zh | no command | none | PASS |
