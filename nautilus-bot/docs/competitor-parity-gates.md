# Competitor Parity Gates (Superwhisper + Granola Baseline)

This document defines launch-blocking parity checks so Nautilus ships at parity-or-better against:

- Superwhisper-style fast dictation UX (local-first, low friction)
- Granola-style meeting UX (bot-free capture, transcript-centric behavior, clear consent)

Benchmark date: 2026-02-24.

## External Baseline References

- Superwhisper: [Changelog](https://superwhisper.com/changelog), [Voice Mode](https://superwhisper.com/docs/getting-started/voice-mode)
- Granola: [Transcription Help](https://docs.granola.ai/help-center/taking-notes/transcription), [Participant Consent](https://docs.granola.ai/help-center/taking-notes/participant-consent)
- Otter: [Bot-free meeting notes](https://otter.ai/blog/meeting-bot-free)

## Gate Scorecard

Status values: `PASS` / `FAIL` / `BLOCKED` / `PENDING`

| ID | Capability | Pass Criteria (Parity-or-Better) | Evidence Target |
| --- | --- | --- | --- |
| CP-01 | Dictation responsiveness | Dictation starts reliably and returns text without UI stall in 10/10 attempts on macOS + Windows packaged builds. | QA matrix rows + short screen recording |
| CP-02 | Meeting processing state UX | On stop, meeting status changes to `processing` immediately, list/detail show spinner, and detail auto-refreshes transcript when completed without reopening modal. | QA matrix rows + event/log note |
| CP-03 | Transcript-only storage | With `meetingAudioStorageMode=transcript_only`, audio file is deleted after successful transcript save and transcript remains viewable/exportable/searchable. | QA matrix row + filesystem proof |
| CP-04 | Retention controls | `1m/2m/3m/custom/never` and delete mode `audio_only` + `audio_and_transcript` work as configured. | QA matrix rows + audit log snippet |
| CP-05 | 3h+ reliability | 3h mic+system recording (YouTube loop permitted) completes end-to-end: no crash, no stuck stop, transcript saved. | QA matrix row + duration screenshot/log |
| CP-06 | Consent + bot-free flow | User-visible consent/start flow is shown before meeting capture and recording indicator is present while active. | QA matrix rows + screenshots |
| CP-07 | Onboarding tracks | Normal and Power onboarding both complete successfully; Power persists advanced meeting retention/storage settings; Normal leaves advanced defaults unchanged. | QA matrix rows + settings diff |
| CP-08 | Cloud storage path | At least one cloud backup provider setup validates and a cloud sync/restore cycle succeeds. | QA matrix rows + backup evidence |
| CP-09 | License tier gating | Trial/basic/pro/friends-club licensing states unlock and gate correct features across restart. | QA matrix rows + entitlement snapshots |
| CP-10 | 30-day lockout | Trial expiration and pro lockout behavior trigger at boundary with expected nags/restrictions. | QA matrix row + timestamped test notes |
| CP-11 | Signed updates | Updater check/download/install path succeeds on signed macOS and Windows builds. | QA matrix rows + updater logs |
| CP-12 | Size + efficiency | `Nautilus.app <= 35 MB`; cold start and idle CPU meet release thresholds in prelaunch checklist. | `release-gate-evidence.md` entries |
| CP-13 | Command mode v1 | Prefix-based commands (`newline`, `paragraph`, `undo last insert`, `delete last sentence`, `bulletize selection`, `rewrite shorter`, `rewrite professional`) execute with >=95% intent success on benchmark set. | Scorecard CSV + command test log |
| CP-14 | Snippets v1 | Snippet trigger expansion (with app scope support) succeeds >=99% on benchmark set. | Scorecard CSV + snippet fixture list |
| CP-15 | End-to-end latency | `end_to_end_ms` telemetry emitted and p50 improves >=25% vs baseline in benchmark corpus. | Baseline + follow-up benchmark reports |

## Required Commands

Run these before manual packaged QA:

```bash
bun test
cargo check
bun run build
bun run gate:size
node scripts/cold-start-gate.mjs --threshold-ms 2500 -- <packaged-launch-command>
```

## Manual Test Runbook

1. CP-02 Meeting processing UX
   - Start a meeting, record 15-30 seconds, then stop.
   - Confirm status flips to `processing` immediately.
   - Open detail view before transcript exists.
   - Confirm spinner text shows and transcript appears automatically when complete.

2. CP-03 Transcript-only storage
   - Set meeting storage mode to transcript-only.
   - Record and complete one meeting.
   - Confirm transcript exists and plays in transcript UI.
   - Confirm `audioPath` is cleared and underlying audio file no longer exists.

3. CP-04 Retention controls
   - Create two expired test meetings.
   - Run app startup/background retention pass.
   - Validate `audio_only` clears audio files/paths but preserves transcript rows.
   - Validate `audio_and_transcript` removes recording + transcript entities.

4. CP-05 3h soak
   - Record with mic + system audio for at least 3 hours (YouTube loop acceptable).
   - Stop recording and verify completion to transcript.
   - Capture diagnostics (dropped chunks counter if non-zero) and final transcript save success.

5. CP-07 Onboarding tracks
   - Fresh profile: complete Normal track and verify only baseline settings changed.
   - Fresh profile: complete Power track and verify meeting storage + retention settings persisted.

6. CP-08 Cloud storage
   - Configure one provider (for example OneDrive).
   - Run setup report/check.
   - Create backup, sync to cloud, and restore from that backup.

7. CP-09 / CP-10 Licensing
   - Verify trial active -> expired boundary behavior with controlled test clock/state fixtures.
   - Validate pro/friends-club feature access matrix and lockout behavior after expiry.

8. CP-11 Signed updates
   - Install prior signed build.
   - Publish signed newer build on channel.
   - Validate check, download, install, restart on macOS and Windows.

9. CP-13 Command mode v1
   - Enable command mode and run command benchmark utterances.
   - Validate command telemetry fields (`commandApplied`, `endToEndMs`, `insertionModeUsed`).
   - Validate no accidental command activation without prefix.

10. CP-14 Snippets v1
   - Configure at least five snippets (including one app-scoped snippet).
   - Verify expansion in target apps and verify disabled snippets do not expand.

11. CP-15 End-to-end latency
   - Run benchmark corpus baseline and follow-up pass.
   - Confirm p50 `end_to_end_ms` improvement target and record in scorecard.

## Exit Criteria

Launch recommendation is `NO-GO` if any CP gate is not `PASS`.
