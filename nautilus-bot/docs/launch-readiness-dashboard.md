# Launch Readiness Dashboard

Generated: 2026-05-05T15:41:12.069Z
Overall status: `NO-GO`

This dashboard is the single repo-side control surface for launch readiness against the practical bar set by Wispr Flow, FreeFlow, Granola, and OpenOats.

## Area Status

| Area | Status | Current read |
| --- | --- | --- |
| Dictation | `BLOCKED` | Local benchmark gates pass on macOS and Windows, packaged benchmark gates are PASS on macOS and BLOCKED on Windows, and the launch app matrix is still 1/16 ready with 15 pending. |
| Meetings | `BLOCKED` | Packaged meeting QA remains 11 blocked rows out of 22. |
| Trust | `BLOCKED` | Internal hardening is in place, but release credentials and packaged trust evidence are still incomplete. |
| Launch claims | `BLOCKED` | App and language claims still exceed the packaged evidence currently checked into the repo. |

## Dictation

- macOS benchmark gate: `PASS`
- Windows benchmark gate: `PASS`
- macOS packaged benchmark gate: `PASS`
- Windows packaged benchmark gate: `BLOCKED`
- Dictation parity fixtures: `PASS`
- Prompt regression fixtures: `PASS`
- App matrix gate: `BLOCKED`
- Launch app matrix: 1/16 ready, 1 supported, 0 partial, 0 clipboard-only, 15 pending
- Missing insertion evidence: 15
- Rejected insertion evidence artifacts: 0
- Missing packaged benchmark evidence: 8
- Invalid app-matrix evidence artifacts: 0

## Meetings

- Packaged QA rows in meeting-critical areas: 22
- Blocked rows in meeting-critical areas: 11
- Passed rows in meeting-critical areas: 11

## Trust

- Local release path: `PASS`
- QA evidence files present: `PASS`
- QA evidence status matches matrix: `PASS`
- QA evidence platform ownership: `PASS`
- macOS packaged QA: 21 PASS / 6 BLOCKED / 0 PENDING
- Windows packaged QA: 0 PASS / 25 BLOCKED / 0 PENDING
- Non-external packaged QA: 21 PASS / 21 BLOCKED / 0 PENDING
- External distribution QA: 0 PASS / 10 BLOCKED / 0 PENDING
- Cloud smoke ready: `BLOCKED`
- Apple release signing ready: `BLOCKED`
- Windows release signing ready: `BLOCKED`

## Launch Claims

- Verified launch apps ready for marketing: 1 of 16
- Languages with packaged evidence: 10 of 10

## Active Blockers

- `cloud-asr-smoke`: Missing required live cloud ASR secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY (artifacts/cloud-asr-smoke.blocked.md)
- `benchmark-gates-packaged`: macOS packaged dictation benchmark evidence is present and passing; Windows packaged benchmark evidence is still missing. (artifacts/benchmark-packaged.blocked.md)
- `dictation-app-matrix`: Frozen app matrix is not launch-ready: 1/16 ready, 15 pending, 8 missing packaged benchmark evidence, 15 missing insertion evidence, 6 open blocked-app entries, 0 rejected insertion evidence artifacts. (artifacts/dictation-app-matrix-gate.json)
- `packaged-qa-matrix`: Non-external packaged QA remains 21 BLOCKED / 21 PASS. External distribution QA remains 10 BLOCKED / 0 PASS and is tracked separately. (artifacts/packaged-qa-evidence-bundle.json)

## Control Artifacts

- Completion audit: `docs/launch-completion-audit.md`
- Launch unblocker pack: `docs/launch-unblocker-pack.md`
- Windows QA handoff: `docs/windows-packaged-qa-handoff.md`

## External Signing And Publishing Blockers

- `apple-release-signing`: Gatekeeper still rejects the local dev-signed app; release signing and notarization are not configured. (artifacts/qa/macos/security-gatekeeper.md)
- `windows-release-signing`: Windows signing and SmartScreen validation have not been executed from a Windows release host. (artifacts/qa/windows/security-authenticode.md)

## Next Actions

1. Execute the remaining non-signing macOS packaged QA rows that require live credentials.
2. Use docs/windows-packaged-qa-handoff.md and scripts/windows-packaged-qa-runner.ps1 on a Windows release host, then execute the Windows packaged QA rows.
3. Capture packaged app-matrix evidence on macOS and Windows, then update the launch app matrix from PENDING to verified statuses.
4. Keep signing and publishing blockers tracked separately until product readiness is green.
