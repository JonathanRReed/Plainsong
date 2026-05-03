# Launch Unblocker Pack

Status: BLOCKED
Generated: 2026-05-03T15:53:35.490Z

This pack is generated from the current completion audit and preflight artifacts. It lists only the inputs that still require credentials, safe manual targets, or a Windows release host.

## Source Evidence

- Completion audit: `artifacts/launch-completion-audit.json`
- Launch readiness report: `artifacts/launch-readiness-report.json`
- QA evidence bundle: `artifacts/packaged-qa-evidence-bundle.json`
- Input template: `docs/launch-inputs.template.env`
- Cloud preflight: `artifacts/cloud-asr-preflight.json`
- License preflight: `artifacts/qa/macos/licensing-activate-deactivate-live.json`
- App matrix gate: `artifacts/dictation-app-matrix-gate.json`
- macOS app matrix preflight: `artifacts/qa/macos/app-matrix-preflight.json`
- Windows handoff: `artifacts/windows-packaged-qa-handoff.json`
- Windows runner: `scripts/windows-packaged-qa-runner.ps1`

## Active Product Blockers

- `cloud-asr-smoke`
- `benchmark-gates-packaged`
- `dictation-app-matrix`
- `packaged-qa-matrix`

## External Signing And Publishing Blockers

- `apple-release-signing`
- `windows-release-signing`

## Cloud ASR Secrets

| Env var | Present |
| --- | --- |
| OPENAI_API_KEY | no |
| ELEVENLABS_API_KEY | no |
| MISTRAL_API_KEY | no |

## License Secret

| Env var | Present |
| --- | --- |
| NAUTILUS_QA_LICENSE_KEY | no |

## Packaged QA Summary

- macOS packaged QA: 21 PASS / 6 BLOCKED / 0 PENDING
- Windows packaged QA: 0 PASS / 25 BLOCKED / 0 PENDING
- Evidence integrity: 0 missing files, 0 mismatched statuses, 0 missing platforms

## macOS Safe Scratch Targets

Use these only with disposable scratch targets. Do not paste into real customer, private, or production conversations.

| App | Mode | Env var | Installed path | Command |
| --- | --- | --- | --- | --- |
| Google Docs (Chrome) | auto | `NAUTILUS_QA_SCRATCH_GOOGLE_DOCS` | /Applications/Google Chrome.app | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Google Docs (Chrome)" --scratch-target "$NAUTILUS_QA_SCRATCH_GOOGLE_DOCS"` |
| Slack | auto | `NAUTILUS_QA_SCRATCH_SLACK` | /Applications/Slack.app | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Slack" --scratch-target "$NAUTILUS_QA_SCRATCH_SLACK"` |
| Messages | auto | `NAUTILUS_QA_SCRATCH_MESSAGES` | /System/Applications/Messages.app | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Messages" --scratch-target "$NAUTILUS_QA_SCRATCH_MESSAGES"` |

## macOS App Matrix Remaining Rows

This table keeps every unresolved macOS app row visible, including rows that cannot be safely captured yet.

| App | Status | Installed | Blocked entries | Required action | Command |
| --- | --- | --- | --- | --- | --- |
| Google Docs (Chrome) | PENDING | /Applications/Google Chrome.app | none | Capture packaged insertion evidence in a disposable scratch target. | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Google Docs (Chrome)" --scratch-target "$NAUTILUS_QA_SCRATCH_GOOGLE_DOCS"` |
| Slack | PENDING | /Applications/Slack.app | none | Capture packaged insertion evidence in a disposable scratch target. | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Slack" --scratch-target "$NAUTILUS_QA_SCRATCH_SLACK"` |
| Notion | PENDING | no | none | Install the target app or use the Windows handoff where applicable. | not ready |
| VS Code | PENDING | no | DA-001 | Resolve blocked-app register entry before marking launch-ready. | not ready |
| Cursor | PENDING | no | DA-002 | Resolve blocked-app register entry before marking launch-ready. | not ready |
| Messages | PENDING | /System/Applications/Messages.app | none | Capture packaged insertion evidence in a disposable scratch target. | `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Messages" --scratch-target "$NAUTILUS_QA_SCRATCH_MESSAGES"` |
| HubSpot (Chrome) | PENDING | /Applications/Google Chrome.app | DA-003 | Resolve blocked-app register entry before marking launch-ready. | not ready |

## Rejected macOS Insertion Evidence

These artifacts are ignored by the app-matrix gate until they are replaced by passing evidence.

| App | Status | Pass | Artifact | Reason | Required action |
| --- | --- | --- | --- | --- | --- |
| Slack | BLOCKED | false | `artifacts/qa/macos/app-matrix-insertion-slack.json` | pass is not true, status is BLOCKED, sidecar command did not complete, frontmost app did not match target, paste was not reported, manual observation was not accepted, scratch target is a placeholder, manual observation result is missing | Replace this artifact by rerunning the packaged insertion capture with a real disposable scratch target, or delete it before recapturing. |

## Windows Release Host

- Product-only command: `pwsh scripts/windows-packaged-qa-runner.ps1 -ProductOnly`
- Full command: `pwsh scripts/windows-packaged-qa-runner.ps1`
- Benchmark command: `bun run benchmark:dictation:packaged:windows`

### Required Return Artifacts

- `docs/evals/benchmark-run-packaged-windows.json`
- `artifacts/benchmark-packaged-windows.json`
- `artifacts/benchmark-gates-packaged-windows.json`
- `artifacts/dictation-app-matrix-gate.json`
- `artifacts/packaged-qa-evidence-bundle.json`

### Blocked Product Rows

| Area | Test case | Status | Evidence |
| --- | --- | --- | --- |
| Permissions | Microphone permission flow | BLOCKED | `artifacts/qa/windows/permissions-microphone.md` |
| Onboarding | Normal user onboarding completes and persists baseline settings | BLOCKED | `artifacts/qa/windows/onboarding-normal.md` |
| Onboarding | Power user onboarding completes and persists advanced storage/retention settings | BLOCKED | `artifacts/qa/windows/onboarding-power.md` |
| Capture | Dictation hotkey end-to-end | BLOCKED | `artifacts/qa/windows/capture-dictation-hotkey.md` |
| Capture | Meeting recording mic-only | BLOCKED | `artifacts/qa/windows/capture-meeting-mic.md` |
| Capture | Meeting recording with loopback/system audio | BLOCKED | `artifacts/qa/windows/capture-meeting-system-audio.md` |
| Capture | Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh | BLOCKED | `artifacts/qa/windows/capture-processing-ux.md` |
| Capture | 3h+ meeting soak (mic + system audio) completes transcript end-to-end | BLOCKED | `artifacts/qa/windows/capture-soak-3h.md` |
| Retention | Transcript-only storage deletes audio and keeps transcript accessible | BLOCKED | `artifacts/qa/windows/retention-transcript-only.md` |
| Retention | Meeting retention `audio_only` clears file/path but keeps transcript | BLOCKED | `artifacts/qa/windows/retention-audio-only.md` |
| Retention | Meeting retention `audio_and_transcript` deletes full entity | BLOCKED | `artifacts/qa/windows/retention-audio-and-transcript.md` |
| Transcription | Whisper transcription end-to-end | BLOCKED | `artifacts/qa/windows/transcription-whisper-e2e.md` |
| AI | Local/remote analysis configured paths | BLOCKED | `artifacts/qa/windows/ai-analysis-paths.md` |
| Export | Standard exports, signed evidence bundle, and built-in templates | BLOCKED | `artifacts/qa/windows/exports.md` |
| Backup | Create backup / restore backup | BLOCKED | `artifacts/qa/windows/backup-create-restore.md` |
| Backup | Cloud provider setup + sync + restore (at least one provider) | BLOCKED | `artifacts/qa/windows/backup-cloud-sync.md` |
| Licensing | Trial expiry + nag behavior | BLOCKED | `artifacts/qa/windows/licensing-trial-expiry.md` |
| Licensing | License activation/deactivation | BLOCKED | `artifacts/qa/windows/licensing-activate-deactivate.md` |
| Licensing | License tiers unlock correct features (basic/pro/friends-club) | BLOCKED | `artifacts/qa/windows/licensing-tier-matrix.md` |
| Licensing | 30-day pro lockout behavior verified | BLOCKED | `artifacts/qa/windows/licensing-30-day-lockout.md` |

## After Inputs

- `bun run gate:cloud-asr:preflight`
- `bun run qa:cloud-asr:smoke`
- `bun run gate:license-live:preflight`
- `bun run qa:packaged:macos:license-live`
- `bun run gate:blockers:refresh`
- `bun run gate:completion-audit`

## Secret Policy

Only required secret names and boolean presence are recorded. Secret values and license values must never be written to repo artifacts.
