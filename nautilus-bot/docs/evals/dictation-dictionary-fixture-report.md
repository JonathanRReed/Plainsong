# Dictation Dictionary Fixture Report

Generated: 2026-04-09T17:28:42.960Z

Dictionary fixtures pass at 100%. This report verifies longest-match handling and app-scoped replacements in the current local code path.

| ID | Label | Language | App | Expected | Actual | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| dict-openai | Brand terms prefer the longest matching phrase | en | Slack | please email OpenAI today and reopen the task | please email OpenAI today and reopen the task | PASS |
| dict-app-scope | Dictionary scope applies only in the matching app | en | Gmail | follow-up tomorrow | follow-up tomorrow | PASS |
