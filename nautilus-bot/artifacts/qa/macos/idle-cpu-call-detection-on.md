# Performance: Idle CPU Baseline -- call detection ON (meetings.callDetectionEnabled = true)

Status: PASS
Owner: qa-macos
Generated: 2026-09-03T07:43:18.711Z

## Command

`bun run qa:packaged:macos:idle-cpu -- --profile-root <scratch> --samples 60`

## Result

- Average total CPU: 0.07%
- Peak total CPU: 2.7%
- P95 total CPU: 0.2%
- Threshold: average total CPU <= 1%
- Samples: 60
- Warmup: 30000 ms
- Sample interval: 1000 ms

## Process Tree

- 91466
- 91468
- 91469
- 91470
- 91473
- 91475
- 91476
- 91477


## Provenance

- Commit: `dcad928b (plus the uncommitted B12 doc updates in this tree)`
- App: `release/mac-arm64/Plainsong.app`, unsigned local pack, ad-hoc
  linker-signed (see `artifacts/qa/receipts-2026-09-02.md` for why an
  unsigned pack is what there is).
- Setting under test: call detection ON (meetings.callDetectionEnabled = true)
- 1-minute load average at start: **11.97** on 14 cores. That is above
  the ~6 ceiling the parity brief asked for; the machine was shared with
  other lanes all session. Read the ON/OFF comparison, not the absolute
  value.
- Profile: an isolated `--profile-root` whose `models/` directory was
  pre-created empty, so `createPackagedQaProfile` would not clone the
  operator's real model tree. Call detection needs no model, and an empty
  tree keeps the run off the keychain-backed integrity-receipt path that
  blocked this session's ASR benchmarks.
- The 160 KB per-sample JSON this run also produced was not committed: it
  is 60 snapshots of a pid list, and the summary above is the receipt.
