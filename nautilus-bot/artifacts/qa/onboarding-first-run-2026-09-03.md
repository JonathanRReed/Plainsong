# First-run setup on the packaged app: the stale flag no longer decides

Lane U1. Captured 2026-09-03 against `release/mac-arm64/Plainsong.app`, built
from this branch with `bun run electron:pack`.

A reader installed the signed DMG and **onboarding never appeared**, so they
had to find and grant every macOS permission themselves. The cause was
`nautilus_onboarding_complete` in the renderer's localStorage: that store lives
in the Electron user-data directory, every development build shares it with the
packaged app, and on that Mac it had said `true` since June. The installed copy
read "already onboarded" off months of dev runs and skipped the wizard in
silence.

This receipt is the proof that it no longer can, taken from the real packaged
app rather than from a test double.

---

## What was run

`scripts/capture-packaged-macos-onboarding-first-run.mjs` (npm script
`qa:packaged:macos:onboarding-first-run`) launches the packaged binary four
times against **one** isolated profile root — `PLAINSONG_DATA_DIR`,
`PLAINSONG_CONFIG_DIR`, `PLAINSONG_QA_MODE=1` and a private
`--user-data-dir` — attaches to the renderer over the Chrome DevTools Protocol,
and reads the real DOM. Nothing touches the reader's own Plainsong data.

- **Machine.** Apple M4 Pro, 14 logical CPUs, macOS 27.0. Shared with other
  parity lanes: the 1-minute load average ran between 40 and 113 across the
  session, and about 40 during the run recorded here. **No timing claim is made
  from this run.** Every check below is a state assertion (is the wizard on
  screen; what does settings.json say), not a measurement, so none of it
  depends on load. Load did change one thing, and it is written up under
  "What load changed" below, because it changed the code.
- **Machine JSON.** `artifacts/qa/macos/onboarding-first-run.json` — the four
  launches, the DOM observation from each, the `[onboarding]` decision line
  each one logged, and the settings record left behind.

## The four launches

| # | Profile state | Expected | Result |
|---|---|---|---|
| 1 | fresh: nothing recorded anywhere | wizard appears | **PASS** — opened on "Dictation model" |
| 2 | the same profile, `nautilus_onboarding_complete = "true"` | wizard **still** appears | **PASS** |
| 3 | `settings.json` says setup completed 2026-06-19 | wizard **still** appears | **PASS** |
| 4 | reader presses "Skip setup for now" | a durable deferral in settings.json | **PASS** |

Launch 2 is the reported bug, reproduced in the shape it was reported and
failing to reproduce its symptom. The flag was verifiably present in that
launch's renderer (`nautilus_onboarding_complete=true`, read back over CDP), and
the wizard opened anyway, because the gate asks whether this Mac can dictate
rather than what a boolean claims.

Launch 3 is the same question asked of the *new* record: a completed record does
not override a Mac that cannot dictate now. This is what makes the fix
future-proof rather than a one-off migration — the June/September case in the
brief ("completed onboarding in June, revoked Accessibility in September") is
this row.

Each launch logs one line saying why, which is what a support bundle will
carry. Verbatim, from launches 2 and 3:

```
[onboarding] show: Setup has not been completed on this install: No dictation
model is ready on this Mac.
[onboarding] show: Setup was completed before, but dictation cannot run now: No
dictation model is ready on this Mac.
```

## What load changed

The first full capture ran with the machine at load ~110, and launches 2 and 3
passed for the *wrong reason*: their decision line was "The install's
onboarding record could not be read", not the readiness sentence above.
Settings had not answered within the six seconds the launch was willing to wait
for readiness, so the gate fell through to its no-answer branch.

That is a defect, and it is one only a packaged run on a busy Mac would have
found. Six seconds was a guess. The launch now waits twenty, which is past
`get_settings`'s own 15-second IPC timeout: a sidecar that genuinely cannot
answer reports an *error* first, and the gate decides on that, so the timer
only backstops the case where neither an answer nor an error ever arrives. Left
at six seconds, a reader who was already set up on a loaded Mac would have been
shown a first-run wizard for the two seconds it took settings to arrive.

The run recorded above is after that change, and the reasons are the readiness
ones. The harness needed a fix of its own in the same pass: it had been waiting
for "the splash is gone", which is also true in the moment before React mounts,
so it could observe an empty page and call it a missing wizard. It now waits
for a decided screen — wizard or workspace.

## The record, written by the packaged app

Launch 4 drove the real "Skip setup for now" button and then read
`<config>/Plainsong/settings.json` off disk:

```json
"onboarding": {
  "completedAt": "2026-06-19T10:04:00Z",
  "completedVersion": "0.9.0-beta.1",
  "grantedAtCompletion": { "microphone": true, "accessibility": true },
  "deferredAt": "2026-09-03T16:21:30.912311+00:00",
  "deferredUnmet": ["dictation_model"]
}
```

The June completion in that record is the one launch 3 wrote in by hand, and it
survived: the deferral is added beside it rather than over it. That is the
whole round trip on the packaged build — renderer button →
`record_onboarding_state` over the IPC bridge → `settings.rs` → disk — and it
shows the deferral is specific. Only `dictation_model` was unmet, so the next
launch stays quiet about the missing model and still opens if a permission is
revoked.

Note on why only `dictation_model` was unmet: these launches exec the packaged
binary from a terminal, so macOS attributes TCC to the launching process and the
app inherits its microphone and Accessibility grants. That is an artefact of the
harness, not of the app, and it does not weaken the three checks above — the
wizard opened in all three cases regardless.

## What this run does not prove

**The "record present, Mac genuinely ready, wizard correctly stays shut" case.**
Proving it on a packaged build needs a granted microphone *and* a downloaded
dictation model for that exact bundle, which is a user-present, on-device step:
the model is a 640 MB download and the grant needs someone to answer a system
dialog. The decision itself is covered exhaustively as a pure function in
`src/__tests__/onboarding-gate.test.ts` (17 cases, including that one and the
legacy-flag adoption that goes with it), and the write path it depends on is
proved end to end by launch 4 above.

**Notifications.** macOS does not report the notification authorization back to
an app, so the permissions step says it cannot read that one rather than
guessing. There is nothing to capture here; the row's honesty is asserted in
`src/__tests__/onboarding-permission-rows.test.tsx`.

## Reproducing

```
bun run electron:pack
bun run qa:packaged:macos:onboarding-first-run
```

The script exits non-zero if any check fails, and writes
`artifacts/qa/macos/onboarding-first-run.json` either way.
