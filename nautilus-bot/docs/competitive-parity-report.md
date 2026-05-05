# Competitive Parity Report

Generated: 2026-05-05T17:07:13.726Z
Status: `BLOCKED`
Claim decision: `DO_NOT_CLAIM_PARITY_OR_BETTER`

Do not claim parity-or-better yet.

This report checks Nautilus against the current evidence bar set by Wispr Flow, Superwhisper, Granola, and OpenOats. It is intentionally stricter than feature inventory: a capability is competitive only when the repo has packaged or source-backed evidence for the launch scope.

## Current Read

- Competitive matrix rows: 8 PASS / 7 BLOCKED / 15 total
- Launch status: `NO-GO`
- Dictation: `BLOCKED`
- Meetings: `BLOCKED`
- Trust: `BLOCKED`
- Launch claims: `BLOCKED`

## Competitive Gaps To Close

- System-wide dictation: Capture packaged insertion evidence for the frozen app matrix. Current ready count: 1/16.
- Cloud ASR choice: Provide OPENAI_API_KEY, ELEVENLABS_API_KEY, and MISTRAL_API_KEY, then run the cloud ASR smoke gate.
- Cross-platform packaged behavior: Run Windows packaged QA. Current Windows packaged QA: 0 PASS / 25 BLOCKED.
- Meeting transcription: Finish blocked meeting-critical packaged QA rows. Current meeting status: BLOCKED.
- AI meeting notes: Run Windows AI and export QA rows, then refresh the packaged QA evidence bundle.
- Privacy and retention: Run Windows retention QA rows and keep macOS retention evidence green.
- Backup and restore: Run Windows backup and restore QA rows and live license-related trust rows.

## Narrow Differentiators That Are Evidence-Backed

- Local-first ASR: Can support narrow positioning only while launch report remains NO-GO.
- AI cleanup and formatting: Can support narrow positioning only while launch report remains NO-GO.
- Launch claim discipline: Differentiator is trust posture, not a feature parity claim.
- Provider fallback transparency: Internal quality differentiator. Keep it in product proof, not broad public parity copy.
- Overlay lifecycle control: Internal quality differentiator. Keep it in product proof, not broad public parity copy.
- Settings first-load guard: Internal quality differentiator. Keep it in product proof, not broad public parity copy.
- Sidecar trust boundary: Internal quality differentiator. Keep it in product proof, not broad public parity copy.
- IPC drift and timeout guard: Internal quality differentiator. Keep it in product proof, not broad public parity copy.

## Active Product Blockers

- cloud-asr-smoke: Missing required live cloud ASR secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY
- benchmark-gates-packaged: macOS packaged dictation benchmark evidence is present and passing; Windows packaged benchmark evidence is still missing.
- dictation-app-matrix: Frozen app matrix is not launch-ready: 1/16 ready, 15 pending, 8 missing packaged benchmark evidence, 15 missing insertion evidence, 6 open blocked-app entries, 0 rejected insertion evidence artifacts.
- packaged-qa-matrix: Non-external packaged QA remains 21 BLOCKED / 21 PASS. External distribution QA remains 10 BLOCKED / 0 PASS and is tracked separately.

## Source Register

- Wispr Flow: https://wisprflow.ai/features
- Wispr Flow: https://docs.wisprflow.ai/articles/9559327591-flow-plans-and-what-s-included
- Wispr Flow: https://docs.wisprflow.ai/articles/3818554249-enable-hipaa-support-and-zero-data-retention-zdr-in-wispr-flow
- Superwhisper: https://superwhisper.com/docs
- Superwhisper: https://superwhisper.com/models
- Superwhisper: https://superwhisper.com/docs/models/voice
- Superwhisper: https://superwhisper.com/docs/get-started/windows
- Granola: https://docs.granola.ai/help-center/getting-started/granola-101
- Granola: https://docs.granola.ai/article/integrations-with-granola
- Granola: https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates
- Granola: https://docs.granola.ai/help-center/getting-more-from-your-notes/recipes
- Granola: https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs
- OpenOats: https://github.com/yazinsai/OpenOats

## Rule

Nautilus can claim parity-or-better only when this report is `PARITY_OR_BETTER_READY`, `artifacts/launch-readiness-report.json` is `GO`, and `docs/launch-completion-audit.md` has no non-external blocked requirements.
