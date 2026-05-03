# Final Ship Checklist

Date: 2026-05-02
Status: `NO-GO`
Audience: product, engineering, QA, founder

This is the final launch checklist for NautilusBot against the practical bar set by:

- Wispr Flow for dictation polish and cross-app trust
- FreeFlow for low-friction, context-aware dictation credibility
- Granola for bot-free meeting capture and note quality
- OpenOats for local-first privacy and hidden-in-meeting trust

Primary references:

- [Wispr Flow](https://wisprflow.ai/)
- [Granola](https://www.granola.ai/)
- [FreeFlow README](https://github.com/zachlatta/freeflow/blob/main/README.md)
- [OpenOats README](https://github.com/yazinsai/OpenOats/blob/main/README.md)

Repo control surface:

- `docs/launch-readiness-dashboard.md`
- `artifacts/launch-readiness-report.json`
- `docs/launch-completion-audit.md`
- `docs/strict-release-blocker-register.md`

## Current Artifact Summary

- Launch readiness: `NO-GO`
- Packaged QA matrix: `21 PASS / 31 BLOCKED / 0 PENDING`
  - macOS packaged QA: `21 PASS / 6 BLOCKED / 0 PENDING`
  - Windows packaged QA: `0 PASS / 25 BLOCKED / 0 PENDING`
- Local build, typecheck, lint, tests, and `bun run gate:dead-code`: `PASS`
- Rust dead-code cleanup: latest pass removed dormant dictation, meeting-title, recording encryption, waveform, crypto session-manager, and audio helper paths; `bun run gate:dead-code` now blocks broad `allow(dead_code)` suppressions from returning.
- macOS packaged dictation benchmark: `PASS`
- Windows packaged dictation benchmark: `BLOCKED`
- Frozen app matrix: `1/16` ready, `15` pending, `15` missing insertion evidence
- Language certification: `10/10` macOS packaged pass, Windows packaged evidence missing
- macOS idle CPU baseline: `PASS`
- macOS update metadata: `PASS`, signed update install still blocked
- Meeting soak: strict 3-hour packaged mic plus system-audio run passes on macOS

## Dictation

Goal:
Nautilus must feel reliable, fast, and deliberate in the exact apps people use all day.

### Launch-critical checks

- [ ] Packaged dictation hotkey succeeds 10 out of 10 times on macOS and Windows.
- [ ] Dictation start, stop, and insert flows complete without stuck overlays or silent failure across the launch app matrix.
- [ ] Launch app matrix is verified on packaged builds:
  - Apple Notes
  - Google Docs
  - Slack desktop
  - Notion desktop
  - VS Code
  - Cursor
  - Messages
  - HubSpot in Chrome on macOS
  - Outlook on Windows
- [ ] Any app that does not pass the launch bar is removed from launch claims.
- [ ] Insertion reliability is at least 98 percent across the frozen launch app matrix.
- [ ] End-to-end latency is captured in packaged benchmark artifacts and reviewed against the current baseline on macOS and Windows.
- [x] Command mode v1 reaches at least 95 percent intent success on the local frozen benchmark set.
- [x] Snippets v1 reach at least 99 percent success, including app-scoped snippets, on the local frozen benchmark set.
- [ ] Dictionary behavior is validated in packaged builds across the frozen launch language set.
- [ ] Smart formatting and bounded correction are packaged-tested in the launch app matrix.
- [ ] Hands-free mode is packaged-tested for false-trigger rate, recovery, and visual state clarity.
- [ ] App-aware styles are only marketed for apps where packaged evidence exists.

### What “best possible” means here

- Dictation is faster than typing in real use, not only in a benchmark script.
- Users trust the app to either insert correctly or fail clearly and recoverably.
- Context-aware behavior helps, but never makes the user feel out of control.

## Meetings

Goal:
Nautilus must feel safe and high-trust for bot-free meeting capture, not just feature-rich.

### Launch-critical checks

- [x] Meeting processing state flips immediately on stop and remains visible until the transcript is ready on packaged macOS evidence.
- [x] Detail view refreshes automatically when transcript processing completes on packaged macOS evidence.
- [x] Transcript-only mode deletes audio after successful transcript persistence and leaves transcript features intact on packaged macOS evidence.
- [ ] Retention presets `1m`, `2m`, `3m`, `custom`, and `never` are packaged-tested across target platforms.
- [x] Retention delete modes `audio_only` and `audio_and_transcript` behave exactly as configured on packaged macOS evidence.
- [x] Consent flow is visible before capture starts and a recording indicator stays visible while active on packaged macOS evidence.
- [x] A 3-hour mic plus system-audio soak test completes without crash, stuck stop, or transcript loss on packaged macOS evidence.
- [x] At least one cloud backup provider completes setup, sync, and restore successfully on packaged macOS evidence.
- [ ] Meeting templates and post-meeting outputs are validated on packaged builds across target platforms, PARTIAL (macOS packaged export and template evidence passes; Windows remains blocked).
- [ ] Meeting exports are tested from real packaged recordings, not just local artifacts, PARTIAL (macOS packaged fixture evidence passes; Windows remains blocked).

Current meeting evidence:

- `artifacts/qa/macos/capture-processing-ux.md`
- `artifacts/qa/macos/retention-transcript-only.md`
- `artifacts/qa/macos/retention-audio-only.md`
- `artifacts/qa/macos/retention-audio-and-transcript.md`
- `artifacts/qa/macos/backup-cloud-sync.md`
- `artifacts/qa/macos/capture-soak-preflight.md`
- `artifacts/qa/macos/capture-soak-3h.md`

### What “best possible” means here

- The app behaves like a trusted notepad that also captures the meeting.
- The user never wonders whether the transcript is still processing, lost, or half-saved.
- Post-meeting outputs are good enough that people reuse them immediately.

## Trust

Goal:
Nautilus must earn trust on data safety, privacy, and paid-product integrity.

### Launch-critical checks

- [x] Raw license key material is not exposed to the renderer.
- [x] License secrets live in OS secure storage, not plaintext JSON.
- [x] Trial anchor and device identity are no longer resettable by deleting the cache file alone.
- [x] Backup restore is staged and rollback-safe.
- [x] iCloud sync is non-destructive and swap-based.
- [x] Renderer commands are explicitly allowlisted at the Electron bridge.
- [x] Packaged macOS update metadata is internally consistent.
- [ ] Cloud ASR smoke passes with real release credentials.
- [ ] Signed update flow works on signed macOS and Windows builds.
- [ ] Fresh install and upgrade paths are executed on signed builds.
- [ ] Release bundle signing and notarization evidence exists for macOS.
- [ ] Release bundle signing evidence exists for Windows.
- [x] The remaining Bun-reported local-dev `esbuild` advisory remains documented until the upstream tooling path stops flagging it.

### What “best possible” means here

- Users do not lose notes, recordings, or license state due to ordinary failure modes.
- Privacy claims are narrow, accurate, and verifiable.
- Anything security-sensitive is either fixed or explicitly documented.

## Launch Claims

Goal:
Every public claim must map to evidence that is already in the repo.

### Launch-critical checks

- [x] Freeze the launch app matrix and do not expand it without packaged evidence.
- [x] Freeze the launch language set and do not claim broader support without benchmark evidence.
- [x] Publish only the workflows that are verified in repo-facing launch copy:
  - dictation
  - meetings
  - memory and follow-up
  - privacy
- [x] Remove any language suggesting “works everywhere” unless the packaged app matrix actually proves it.
- [x] Remove any language suggesting “fully local” for workflows that still depend on cloud providers.
- [x] Separate “available” from “certified” in product copy.
- [x] Ensure pricing and entitlement copy matches the actual tier unlock matrix.
- [x] Ensure backup and privacy copy matches the implemented storage behavior.

### What “best possible” means here

- Fewer claims, each stronger.
- No gap between marketing language and the QA bundle.
- Users find the product more trustworthy because it is precise.

## Go Or No-Go

### Must be `PASS` before launch

- [ ] `LX-03` release secrets and signing
- [ ] `LX-04` packaged QA matrix
- [ ] `LX-05` packaged dictation parity evidence
- [ ] `LX-08` packaged meeting reliability evidence
- [x] launch claim freeze against verified scope

### Automatic `NO-GO`

- [x] Any signed installer path is still blocked
- [x] Any packaged QA blocker remains unresolved in a launch-critical flow
- [x] Any launch app matrix entry is still only locally assumed, not packaged-verified
- [ ] Any launch language claim exceeds the benchmark-backed certified set
- [ ] Any privacy or reliability claim is broader than the evidence bundle

## Recommendation

The repo is now in a stronger technical state, but the remaining gap to Wispr Flow, FreeFlow, Granola, and OpenOats is launch proof, not missing code.

The next best move is not more feature work.

The next best move is:

1. complete signing and release credentials
2. execute packaged QA and packaged benchmarks
3. freeze claims to the verified scope

That is the shortest path to being the best version of Nautilus that users will actually believe.
