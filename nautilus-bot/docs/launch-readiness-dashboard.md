# Launch Readiness Dashboard

Generated: 2026-04-09T22:43:47.521Z
Overall status: `NO-GO`

This dashboard is the single repo-side control surface for launch readiness against the practical bar set by Wispr Flow, FreeFlow, Granola, and OpenOats.

## Area Status

| Area | Status | Current read |
| --- | --- | --- |
| Dictation | `BLOCKED` | Local benchmark gates pass on macOS and Windows, but the launch app matrix is still 16 pending and 0 clipboard-only. |
| Meetings | `BLOCKED` | Packaged meeting QA remains 22 blocked rows out of 22. |
| Trust | `BLOCKED` | Internal hardening is in place, but release credentials and packaged trust evidence are still incomplete. |
| Launch claims | `BLOCKED` | App and language claims still exceed the packaged evidence currently checked into the repo. |

## Dictation

- macOS benchmark gate: `PASS`
- Windows benchmark gate: `PASS`
- Dictation parity fixtures: `PASS`
- Prompt regression fixtures: `PASS`
- Launch app matrix: 0 supported, 0 partial, 0 clipboard-only, 16 pending

## Meetings

- Packaged QA rows in meeting-critical areas: 22
- Blocked rows in meeting-critical areas: 22
- Passed rows in meeting-critical areas: 0

## Trust

- Local release path: `PASS`
- Cloud smoke ready: `BLOCKED`
- Apple release signing ready: `BLOCKED`
- Windows release signing ready: `BLOCKED`

## Launch Claims

- Verified launch apps ready for marketing: 0 of 16
- Languages with packaged evidence: 0 of 10

## Active Blockers

- `cloud-asr-smoke`: Missing required live cloud ASR secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY (artifacts/cloud-asr-smoke.blocked.md)
- `benchmark-gates-packaged`: Benchmark gate artifacts are still local or fixture-tagged runs; packaged dictation benchmark evidence is still missing. (artifacts/benchmark-packaged.blocked.md)
- `apple-release-signing`: Gatekeeper still rejects the local dev-signed app; release signing and notarization are not configured. (artifacts/qa/macos/security-gatekeeper.md)
- `windows-release-signing`: Windows signing and SmartScreen validation have not been executed from a Windows release host. (artifacts/qa/windows/security-authenticode.md)
- `packaged-qa-matrix`: Packaged QA matrix remains 49 BLOCKED / 0 PASS. (artifacts/packaged-qa-evidence-bundle.json)

## Next Actions

1. Provision Apple signing and notarization credentials, then execute the macOS packaged QA rows.
2. Provision the Windows signing certificate, then execute the Windows packaged QA rows.
3. Capture packaged dictation benchmark evidence and update the launch app matrix from PENDING to verified statuses.
4. Freeze public launch claims to the verified app and language set only.
