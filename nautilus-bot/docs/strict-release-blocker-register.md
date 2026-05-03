# Strict Release Blocker Register

Generated during blocker-first execution on 2026-03-05 and refreshed for the Electron release path on 2026-05-02.

## Overall State

- Strict readiness: **NO-GO**
- Priority mode: strict-only blocker-first
- Machine-readable report: `artifacts/launch-readiness-report.json`
- Dashboard: `docs/launch-readiness-dashboard.md`

## Active Blockers

| ID | Blocker | Severity | Evidence | Unblock Action |
| --- | --- | --- | --- | --- |
| BR-001 | Cloud ASR smoke gate cannot run because `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and `MISTRAL_API_KEY` are missing | High | `artifacts/cloud-asr-smoke.blocked.md` | Provide required cloud API secrets and re-run `bun run qa:cloud-asr:smoke`. |
| BR-002 | Packaged dictation benchmark evidence is not complete across target platforms | High | `artifacts/benchmark-packaged.blocked.md`, `artifacts/benchmark-gates-packaged-macos.json`, `docs/evals/benchmark-run-packaged-macos.json`, `scripts/capture-packaged-windows-dictation-benchmark.mjs` | Run `bun run benchmark:dictation:packaged:windows` on a Windows packaged build, then refresh blockers. |
| BR-003 | Frozen dictation app matrix is not launch-ready | High | `artifacts/dictation-app-matrix-gate.json`, `artifacts/qa/macos/app-matrix-preflight.md`, `artifacts/qa/macos/app-matrix-insertion-apple-notes.md`, `docs/dictation-app-compatibility-matrix.md`, `docs/dictation-blocked-app-register.md` | Continue using the preflight capture queue, capture real packaged insertion evidence only in safe scratch targets, then update app statuses to `SUPPORTED` or `PARTIAL` and close blocked-app register entries. |
| BR-004 | Apple paid signing and notarization setup is unavailable | High | `artifacts/qa/macos/security-gatekeeper.md`, `artifacts/qa/macos/security-notarization.md` | Complete Apple signing/notarization setup, then execute signed DMG, Gatekeeper, notarization, and update-flow validation. |
| BR-005 | Windows code-signing certificate and Windows release host evidence are unavailable | High | `artifacts/qa/windows/security-authenticode.md`, `artifacts/qa/windows/security-smartscreen.md` | Provision Windows signing cert and execute Authenticode, SmartScreen, packaged QA, and Windows packaged benchmark validation. |
| BR-006 | Packaged QA matrix still has blocked rows | High | `docs/packaged-app-qa-matrix.md`, `artifacts/packaged-qa-evidence-bundle.json` (`21 PASS / 31 BLOCKED / 0 PENDING`; non-external `21 PASS / 21 BLOCKED / 0 PENDING`; external distribution `0 PASS / 10 BLOCKED / 0 PENDING`; macOS `21 PASS / 6 BLOCKED / 0 PENDING`; Windows `0 PASS / 25 BLOCKED / 0 PENDING`) | Replace remaining non-external blocked rows with executed PASS/FAIL evidence from packaged app runs. Keep signing and publishing rows tracked as external distribution blockers. |

## Artifacts Produced In This Pass

- `artifacts/launch-readiness-report.json`
- `docs/launch-readiness-dashboard.md`
- `artifacts/packaged-qa-evidence-bundle.json`
- `artifacts/release-blockers.json`
- `artifacts/cloud-asr-smoke.blocked.md`
- `artifacts/benchmark-packaged.blocked.md`
- `artifacts/dictation-app-matrix-gate.json`
- `artifacts/qa/macos/app-matrix-preflight.md`
- `artifacts/qa/macos/app-matrix-insertion-apple-notes.md`
- `artifacts/qa/macos/idle-cpu-baseline.md`
- `artifacts/qa/macos/update-metadata.md`
- `artifacts/qa/macos/exports.md`
- `artifacts/qa/macos/capture-soak-3h.md`
