# Dictation Formatter Benchmark Report

Generated: 2026-04-09T16:08:48.649Z

Formatting and correction fixtures now have reproducible local evidence. Smart formatting passes at 100%, and correction cases pass at 100%. Packaged QA is still required before launch claims move beyond local evidence.

## Formatting

| ID | Label | Mode | Hint | Pass |
| --- | --- | --- | --- | --- |
| fmt-spoken-punctuation | Spoken punctuation tokens become structured prose | voice | none | PASS |
| fmt-chat-lightweight | Chat mode keeps line breaks lightweight | messages | none | PASS |
| fmt-email-style | Email hints preserve direct punctuation | voice | Gmail | PASS |
| fmt-document-style | Document apps keep paragraph structure | voice | Notion | PASS |
| fmt-symbols | Quotes and symbols survive formatting | messages | Slack | PASS |

## Corrections

| ID | Label | Target | Replacement | Pass |
| --- | --- | --- | --- | --- |
| corr-replace-phrase | Case-insensitive phrase replacement edits all matches | roadmap | launch plan | PASS |
| corr-replace-target | Replace phrase works for repeated product terms | roadmap | launch plan | PASS |
