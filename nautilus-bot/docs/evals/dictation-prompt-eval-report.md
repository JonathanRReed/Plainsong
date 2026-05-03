# Dictation Prompt Eval Report

Generated: 2026-05-03T15:52:29.660Z

This report promotes the dictation prompt and text-shaping fixture path into an explicit regression harness. It is the repo-owned answer to prompt-eval drift: command grammar, formatting output, and correction behavior must stay reproducible.

## Summary

- Command grammar: 100%
- Formatting and mode transforms: 100%
- Correction and rewrite helpers: 100%
- Overall: PASS

## Command grammar

| ID | Label | Expected | Actual | Pass |
| --- | --- | --- | --- | --- |
| basic-notes | Basic dictation in notes | no command | none | PASS |
| command-newline | Insert newline by command | newline | newline | PASS |
| command-paragraph | Insert paragraph break by command | paragraph | paragraph | PASS |
| command-undo | Undo the last insert by voice | undo_last_insert | undo_last_insert | PASS |
| command-delete-last-sentence | Delete the last sentence by voice | delete_last_sentence | delete_last_sentence | PASS |
| command-rewrite-shorter | Rewrite shorter command | rewrite_shorter | rewrite_shorter | PASS |
| command-rewrite-professional | Rewrite professional command | rewrite_professional | rewrite_professional | PASS |
| command-bulletize-selection | Bulletize selection command | bulletize_selection | bulletize_selection | PASS |
| snippet-positive-slack | App-scoped snippet expands in Slack | no command | none | PASS |
| snippet-negative-notion | App-scoped snippet stays off in Notion | no command | none | PASS |
| safety-no-command-center | Command prefix inside normal speech stays plain text | no command | none | PASS |
| es-word-follow-up | Spanish follow-up in Word | no command | none | PASS |
| pt-outlook-follow-up | Portuguese follow-up in Outlook | no command | none | PASS |
| fr-notepad-quick-note | French quick note in Notepad | no command | none | PASS |
| de-hubspot-call-log | German call log in HubSpot | no command | none | PASS |
| it-google-docs-brief | Italian brief in Google Docs | no command | none | PASS |
| nl-slack-check-in | Dutch check-in in Slack | no command | none | PASS |
| ja-notion-brief | Japanese brief in Notion | no command | none | PASS |
| ko-cursor-comment | Korean comment in Cursor | no command | none | PASS |
| zh-vscode-checklist | Mandarin checklist in VS Code | no command | none | PASS |

## Formatting and mode transforms

| ID | Label | Expected | Actual | Pass |
| --- | --- | --- | --- | --- |
| fmt-spoken-punctuation | Spoken punctuation tokens become structured prose | Hello, this is jon.

I will follow up? | Hello, this is jon.

I will follow up? | PASS |
| fmt-chat-lightweight | Chat mode keeps line breaks lightweight | Hi there
I can send that over tomorrow | Hi there
I can send that over tomorrow | PASS |
| fmt-email-style | Email hints preserve direct punctuation | Hi jonathan can you review the launch plan? | Hi jonathan can you review the launch plan? | PASS |
| fmt-document-style | Document apps keep paragraph structure | First section.

Second section. | First section.

Second section. | PASS |
| fmt-symbols | Quotes and symbols survive formatting | "Launch ready" @ team/ops | "Launch ready" @ team/ops | PASS |

## Correction and rewrite helpers

| ID | Label | Expected | Actual | Pass |
| --- | --- | --- | --- | --- |
| corr-replace-phrase | Case-insensitive phrase replacement edits all matches | launch plan review for the launch plan team | launch plan review for the launch plan team | PASS |
| corr-replace-target | Replace phrase works for repeated product terms | Please send the launch plan update after the launch plan review. | Please send the launch plan update after the launch plan review. | PASS |
