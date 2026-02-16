# Packaged App QA Matrix (macOS + Windows)

Date: 2026-02-16

## Scope
- Dictation reliability and fallback behavior parity.
- Meeting recording pipeline reliability.
- Security controls: remote-processing policy, vault behavior, export boundary checks, integrity verification.

## Automated Gate Snapshot (this run)
- `npm test`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `cargo fmt --check`: pass
- `cargo clippy --all-targets -- -D warnings`: pass
- `cargo check --all-targets`: pass
- `cargo test --lib`: pass
- `cargo test --tests`: pass
- `cargo audit -f src-tauri/Cargo.lock`: pass (warnings only)

## Manual Matrix
| OS | Area | Scenario | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| macOS | Dictation hotkey | Hold and release hotkey in focused external editor | Ends within 500 ms; text pasted or copied with explicit outcome | Pending | Not executed in this run |
| macOS | Provider fallback transparency | Break selected runtime with fallback disabled/enabled | No silent fallback; metadata fields explicit | Pending | Not executed in this run |
| macOS | Vault runtime | Lock vault and open encrypted recording | Access denied until unlock | Pending | Not executed in this run |
| macOS | Export boundary | Export to path outside configured `exportRoot` | Backend rejects target path | Pending | Not executed in this run |
| Windows | Dictation copy fallback | Dictation into app where simulated paste unavailable | `copied=true` and user-visible copied-only status | Pending | Not executed in this run |
| Windows | Recording-to-transcript | Start/stop recording and wait for transcript completion | Recording status reaches `completed` with transcript | Pending | Not executed in this run |
| Windows | Remote policy | Select remote provider while `remoteProcessingEnabled=false` | Backend hard deny with policy error | Pending | Not executed in this run |
| Windows | Integrity check | Verify tampered evidence bundle/model artifact | Verification fails deterministically | Pending | Not executed in this run |

## Release target for completion
- Required for launch “beat” claim: all matrix rows pass on dedicated macOS + Windows test machines.

## Artifact Capture Policy
- Capture one screen recording per matrix row showing the full scenario and result.
- Attach one screenshot for terminal/app logs that includes timestamp and OS version.
- Attach one exported artifact sample for export/integrity scenarios (bundle path + verification output).
- Store artifacts under `qa-evidence/<YYYY-MM-DD>/<os>/<scenario-id>/` with a short `notes.md`.
