# Launch Claim Scope

Date: 2026-04-09
Status: active

This file defines what Nautilus may and may not claim publicly from the current repo evidence.

## Source Of Truth

- Technical proof boundary: `docs/technical-proof-boundaries.md`
- Launch dashboard: `docs/launch-readiness-dashboard.md`
- Machine-readable launch state: `artifacts/launch-readiness-report.json`
- Frozen app matrix: `docs/dictation-app-compatibility-matrix.md`
- Frozen language matrix: `docs/evals/dictation-language-certification-matrix.md`
- QA bundle: `artifacts/packaged-qa-evidence-bundle.json`
- Dictation parity scorecard: `docs/evals/dictation-parity-launch-scorecard.md`

## Current Allowed Claims

- Nautilus implements dictation and meeting capture workflows in the current codebase.
- Nautilus is local-first by default.
- Nautilus also supports optional bring-your-own-key cloud transcription and analysis providers.
- Nautilus includes optional bring-your-own-cloud backup and sync paths.
- The launch app matrix and launch language set are frozen in the linked evidence files.
- Internal repo-side dictation benchmark and parity fixtures currently pass.

## Current Disallowed Claims

- Do not claim that Nautilus works in every app.
- Do not claim that Nautilus is launch-certified for any app until packaged evidence exists.
- Do not claim broader language support than the frozen certification matrix.
- Do not claim that cloud-backed workflows are fully local.
- Do not claim hosted Nautilus cloud storage.
- Do not claim signed update reliability on macOS or Windows until signed packaged evidence exists.
- Do not claim packaged meeting reliability until the packaged QA rows pass.

## Public Wording Rules

- Prefer `implemented` when referring to code that exists.
- Prefer `certified` only when packaged evidence exists.
- Prefer `local-first` over `fully local`.
- Prefer `optional BYOK cloud providers` over generic cloud-language.
- Prefer `bring-your-own-cloud sync` over hosted-sync language.

## Launch App Matrix Policy

- The launch app matrix is frozen in `docs/dictation-app-compatibility-matrix.md`.
- App-specific public claims must stay inside that matrix.
- Apps remain out of public launch claims until their matrix status is `SUPPORTED` or `PARTIAL` with a documented workaround.

## Launch Language Policy

- The launch language set is frozen in `docs/evals/dictation-language-certification-matrix.md`.
- Languages remain out of public launch claims until packaged evidence exists for them.
- The current repo does not justify a broad public language-count claim.

## Repo Copy Rule

README and launch-facing docs must separate:

- implemented product surface
- launch-certified scope

If those diverge, the certified scope wins.
