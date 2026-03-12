# Strict Release Blocker Register

Generated during blocker-first execution on 2026-03-05.

## Overall State

- Strict readiness: **NO-GO**
- Priority mode: strict-only blocker-first

## Active Blockers

| ID | Blocker | Severity | Evidence | Unblock Action |
| --- | --- | --- | --- | --- |
| BR-001 | Cloud ASR smoke gate cannot run (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY` missing) | High | `artifacts/cloud-asr-smoke.blocked.md` | Provide required cloud API secrets and re-run `scripts/live-cloud-asr-smoke.mjs`. |
| BR-002 | CP benchmark gate artifacts missing (`docs/evals/benchmark-run-baseline.json`, `docs/evals/benchmark-run-latest-macos.json`, `docs/evals/benchmark-run-latest-windows.json`) and DP Phase 0 remains unevidenced | High | `artifacts/benchmark-gates-macos.blocked.md`, `artifacts/benchmark-gates-windows.blocked.md`, `docs/evals/dictation-parity-launch-scorecard.md` | Produce benchmark run JSON artifacts, update `docs/dictation-app-compatibility-matrix.md`, close blocked apps in `docs/dictation-blocked-app-register.md`, and re-run `scripts/verify-benchmark-gates.mjs` for macOS and Windows. |
| BR-003 | Apple paid signing/notarization setup unavailable | High | `docs/packaged-app-qa-matrix.md` security/install rows marked `BLOCKED` | Complete Apple signing/notarization setup and execute signed DMG + Gatekeeper + notarization validation. |
| BR-004 | Windows code-signing certificate unavailable | High | `docs/packaged-app-qa-matrix.md` Windows security/install rows marked `BLOCKED` | Provision Windows signing cert and execute Authenticode/SmartScreen validation. |
| BR-005 | Packaged QA matrix lacks executed PASS evidence | High | `docs/packaged-app-qa-matrix.md` (`49 BLOCKED / 0 PASS`) and `artifacts/qa/**` | Replace blocked stubs with executed PASS/FAIL evidence from packaged app runs. |

## Artifacts Produced In This Pass

- `artifacts/asr-preflight-macos.json`
- `artifacts/packaged-qa-evidence-bundle.json`
- `artifacts/release-blockers.json`
- `artifacts/cloud-asr-smoke.blocked.md`
- `artifacts/benchmark-gates-macos.blocked.md`
- `artifacts/benchmark-gates-windows.blocked.md`
- `artifacts/qa/macos/*.md` (25 blocker evidence files)
- `artifacts/qa/windows/*.md` (24 blocker evidence files)
