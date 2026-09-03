# Diarization segmentation: VAD-aligned windows, measured and not adopted

Lane C8, Part B. Measured 2026-09-03 06:28–06:52 UTC (late 2026-09-02 local).

`docs/model-inventory-2026-09.md` §5(d) ranks this first among local
diarization improvements:

> **Fix segmentation before swapping embedders.** Fixed 2 s / 1 s windows with
> no VAD and no overlap handling is the dominant error source; a better
> embedding on a badly-placed window is still a badly-placed window.

That is right about the segmentation, and it is not the binding constraint.
**VAD alignment was implemented, measured, and is not adopted** — the shipped
`DEFAULT_SEGMENTATION` stays `FixedGrid`. The reason is a defect it exposed
somewhere else, and that defect is the more important finding in this file.

---

## Headline: the shipped diarizer cannot emit a turn shorter than 5 seconds

`EmbeddingClusterer::smooth_segments` merges consecutive same-label windows
into a turn and then **discards any turn shorter than `min_segment_duration`,
which is 5.0 seconds**. Nothing in this repo had measured what that costs.

On a five-minute two-speaker fixture with 3-second turns and 0.8-second gaps —
ordinary conversational turn-taking — the *shipped* segmentation scores:

| | frame error | speakers found | reference speech left unattributed |
|---|---|---|---|
| fixed grid, 1.0 s hop (shipped) | **58.7%** | 2 of 2 | 121 s of 300 |

58.7% frame error is worse than assigning every frame to one speaker. The
pipeline does not fail; it returns a confident, wrong answer, and drops 40% of
the audio on the floor. The fixed grid partly hides this at longer turn
lengths because its windows overlap across turn boundaries, so a same-label run
bleeds past the true turn and clears the 5-second bar — the 4.7-second-turn
fixture below is scored against 6-second predicted turns.

This is a property of the shipped build, not of anything this lane changed. It
is now written into `docs/beta/KNOWN-LIMITATIONS.md`.

## What was measured

- **Machine.** Apple M4 Pro, 14 logical CPUs, shared with other parity lanes.
  1-minute load average is given per table; it fell from 87 to 22 over the
  session as siblings finished. Wall times are therefore comparable *within* a
  table and not between them; the frame-error numbers are deterministic and do
  not depend on load at all.
- **Fixtures.** `scripts/make-diarization-eval-fixture.mjs`, extended in this
  lane with `--speakers` (2–4 voices) and `--gap-seconds` (silence between
  turns). Every fixture is 300 s, synthesised from `real-speech-44s.wav` with
  pitch/formant-shifted copies as the other voices. Ground truth is exact
  because the turn grid is generated, not labelled.
- **Scoring.** `scripts/score-diarization-eval.mjs`. `frameErrorRate` is a
  DER-style confusion+miss+false-alarm rate over 10 ms frames under the best
  one-to-one speaker mapping. **It is not a published DER**: these fixtures have
  no overlapped speech and their voices share one talker's prosody.
- **Harness.** `diarization::eval_tests::eval_segmentation_modes`, `#[ignore]`d,
  runs all three modes in one process against one fixture and prints a
  `DIAR-EVAL` line each plus a `DIAR-SEG` line describing what the VAD saw.

### Why `--gap-seconds` had to be added first

The pre-existing fixtures are wall-to-wall speech with butt-joined turns. On
those, Silero correctly reports **one** speech region covering the whole file,
so VAD alignment degrades to exactly the fixed grid. Measured, on
`two-speaker-300s` (5.3 s turns, no gaps, ECAPA-TDNN, load 34 → 28):

| segmentation | frame error | speakers | boundaries within 0.5 s | wall |
|---|---|---|---|---|
| fixed grid, 1.0 s hop | 0.1053 | 2/2 | 56/56 | 4.85 s |
| VAD-aligned, 1.0 s hop | **0.1053** | 2/2 | 56/56 | 5.50 s |
| VAD-aligned, 0.5 s hop | 0.0833 | 2/2 | 55/56 | 20.65 s |

The first two rows are not merely close, they are the identical turn list. A
fixture with no silence in it cannot evaluate a silence-driven segmentation,
which is why every result below uses 0.8-second gaps.

## Results

### Two speakers, 5.3-second turns, 0.8-second gaps — the case it is for

ECAPA-TDNN (default embedder), load 87 → 87:

| segmentation | frame error | speakers | boundaries within 0.5 s | boundary MAE | unattributed | wall |
|---|---|---|---|---|---|---|
| fixed grid, 1.0 s hop | 0.1550 | 2/2 | 90/98 | 0.290 s | 1.5 s | 6.72 s |
| **VAD-aligned, 1.0 s hop** | **0.0546** | 2/2 | 95/98 | 0.123 s | 7.18 s | 5.75 s |
| VAD-aligned, 0.5 s hop | 0.0535 | 2/2 | 95/98 | 0.120 s | 6.77 s | 14.32 s |

CAM++ (post-lane-C7 fix), same fixture, load 27 → 23:

| segmentation | frame error | speakers | boundaries within 0.5 s | boundary MAE | unattributed | wall |
|---|---|---|---|---|---|---|
| fixed grid, 1.0 s hop | 0.1573 | 2/2 | 92/98 | 0.280 s | 1.0 s | 10.49 s |
| **VAD-aligned, 1.0 s hop** | **0.0535** | 2/2 | 95/98 | 0.120 s | 6.77 s | 7.71 s |
| VAD-aligned, 0.5 s hop | 0.0535 | 2/2 | 95/98 | 0.120 s | 6.77 s | 22.22 s |

A 65% relative reduction in frame error, boundary error less than half, on both
embedders — **and faster**, because dropping silence means embedding fewer
windows (219 against 299 on the 3-speaker fixture). The cost is honest and
visible: unattributed reference speech rises from 1.5 s to 7.2 s, which is the
audio the VAD decided was not speech.

**The 0.5-second hop is not worth it.** It moves frame error by 0.001 for 2.5×
the wall time on ECAPA and by nothing at all on CAM++. Whatever this
segmentation is losing, it is not losing it to hop resolution.

### Three speakers, 4.7-second turns, 0.8-second gaps — where it breaks

ECAPA-TDNN, load 75 → 64:

| segmentation | frame error | speakers | boundaries within 0.5 s | unattributed | wall |
|---|---|---|---|---|---|
| fixed grid, 1.0 s hop | 0.1673 | 3/3 | 105/108 | 3.0 s | 6.17 s |
| VAD-aligned, 1.0 s hop | **0.8413** | **1/3** | 2/108 | 252.1 s | 4.44 s |
| VAD-aligned, 0.5 s hop | 0.8413 | 1/3 | 2/108 | 252.1 s | 10.19 s |

### Two speakers, 3.0-second turns, 0.8-second gaps — where both break

ECAPA-TDNN, load 43 → 39:

| segmentation | frame error | speakers | boundaries within 0.5 s | unattributed | wall |
|---|---|---|---|---|---|
| fixed grid, 1.0 s hop | 0.5873 | 2/2 | 68/157 | 121.0 s | 5.29 s |
| VAD-aligned, 1.0 s hop | 0.7900 | **0/2** | 0/157 | 237.0 s | 4.15 s |
| VAD-aligned, 0.5 s hop | 0.7900 | 0/2 | 0/157 | 237.0 s | 6.82 s |

## The cause, exactly

The VAD is not the problem. On the 3-speaker fixture the harness printed:

```
DIAR-SEG {"durationSeconds":300.0,"speechRegions":55,"speechSeconds":267.3,
          "windows":{"fixedGrid":299,"vadHop1.0":219,"vadHop0.5":382},
          "firstRegions":[[0.0,4.804],[5.404,10.34],[10.908,15.812], …]}
```

55 speech regions against 55 ground-truth turns, onsets within 0.1 s, 267 s of
speech found in 300 s. The segmentation is correct.

What comes out the other end is **one turn, 247.39 s to 252.39 s** — exactly
5.000 seconds long. That is `min_segment_duration`. Every VAD-aligned run is
bounded by its speech region (4.9 s here), so every one of them falls under the
5-second bar and is discarded; the single survivor is the one region the
padding happened to push over it. The fixed grid escapes because its runs are
not bounded by anything: consecutive windows merge across turn boundaries until
the label changes, so a run is always at least one hop longer than the turn.

So the shipped pipeline's apparent tolerance of short turns is an artefact of
the very over-merging that VAD alignment removes. Fixing the segmentation
without fixing the smoother makes the output strictly worse.

## Decision

The adoption rule for this lane was: adopt only if frame error improves
*without* moving the calibrated voiceprint thresholds by more than 0.02.

**Not adopted.** It fails the first half of the rule on two of four fixtures,
and fails it by 0.67 and 0.20 frame-error points rather than marginally. The
work is kept, not deleted, because the numbers above have to stay reproducible
and because the change is one bug away from being a large win:

- `rust-sidecar/src/diarization/segmentation.rs` — the pure functions and the
  whole-file Silero pass.
- `SegmentationMode` on `DiarizationEngine`, with `DEFAULT_SEGMENTATION =
  FixedGrid`. The `VadAligned` variant is constructed only by the harness and
  carries a reasoned `expect(dead_code)` pointing here.
- `eval_segmentation_modes` and the fixture generator's `--speakers` /
  `--gap-seconds`.

### What has to happen first

`EmbeddingClusterer::min_segment_duration` needs to stop deleting short turns.
That is a change to shipped diarization behaviour on every recording, not just
on VAD-aligned ones — the 3-second-turn table above shows the shipped path
losing 121 s of 300 to it today — so it belongs in its own lane with its own
before/after. Once a turn shorter than 5 seconds can survive, this
segmentation should be re-measured on all four fixtures; the two where it wins
today suggest it will win on all of them.

## Effect on the voiceprint thresholds (lane C6 / C7b)

**Predicted, not measured — and the prediction is "no effect".** Stated here so
lane C7b, which is re-running the calibration on the fixed CAM++ embeddings,
can check it rather than inherit it.

1. **Window length is unchanged, by construction.** `SEGMENT_SECONDS` (2.0) and
   `MIN_SEGMENT_SECONDS` (1.0) are untouched, and
   `generate_vad_aligned_segments` clips windows to speech regions rather than
   resizing them. Every window it can emit is between 1.0 s and 2.0 s, which is
   **98 to 198 FBank frames** — exactly the range
   `embedder::verified_fbank_frame_range()` already covers and well inside
   CAM++'s 220-frame `verified_frame_window` from lane C7. The unit test
   `segmentation::tests::windows_stay_inside_the_verified_frame_range` asserts
   this over four regions at both hops and fails if a future change moves it.
   Empirically, the CAM++ run above executed ~660 VAD-aligned embeddings in a
   debug build without tripping `run_embedding_inference`'s
   `debug_assert!(verified.contains(&num_frames))`.
2. **The 0.5-second hop was not adopted either**, so window *count* per second
   of speech is unchanged too.
3. **On the calibration fixtures specifically, the two segmentations are the
   same object.** The voiceprint harness embeds single-speaker utterances of
   continuous speech; the `two-speaker-300s` result above shows that on
   gapless speech Silero returns one region and VAD alignment produces a
   byte-identical window list. The thresholds are computed from cosine
   similarities between centroids of those windows, so identical windows give
   identical similarities.

**What was not done:** the calibration harness
(`voiceprint_threshold_calibration`) was **not** re-run. It needs
`PLAINSONG_VOICEPRINT_FIXTURES`, a directory of per-voice WAVs that is not in
this worktree and is not committed. Nothing in `voiceprints.rs` was edited.
Since the default segmentation did not change, the shipped thresholds describe
the shipped pipeline exactly as they did before this lane.

## Reproducing

```sh
node scripts/make-diarization-eval-fixture.mjs --out-dir <dir> \
  --turn-seconds 5.3 --gap-seconds 0.8 --label two-speaker-gapped
node scripts/make-diarization-eval-fixture.mjs --out-dir <dir> \
  --turn-seconds 4.7 --gap-seconds 0.8 --speakers 3 --label three-speaker-gapped
node scripts/make-diarization-eval-fixture.mjs --out-dir <dir> \
  --turn-seconds 3.0 --gap-seconds 0.8 --label two-speaker-short

PLAINSONG_DIAR_EVAL_AUDIO=<dir>/two-speaker-gapped-300s.wav \
PLAINSONG_DIAR_EVAL_MODEL=ecapa_tdnn_speaker \
  node scripts/cargo-sidecar.mjs test --locked --lib \
  diarization::eval_tests::eval_segmentation_modes -- --ignored --nocapture \
  | grep '^DIAR-EVAL ' > run.txt

node scripts/score-diarization-eval.mjs \
  --ground-truth <dir>/two-speaker-gapped-300s.ground-truth.json --result run.txt
```

The WAVs are gitignored (raw audio is not tracked); the `.ground-truth.json`
files are deterministic from the flags above.

## Tests added

In `rust-sidecar/src/diarization/segmentation.rs`:

- `a_silent_recording_has_no_speech_regions_and_so_no_windows`
- `short_pauses_are_bridged_and_real_gaps_are_not`
- `a_region_too_short_to_describe_is_dropped_rather_than_embedded`
- `windows_start_at_the_onset_and_stop_at_the_region_end`
- `a_half_second_hop_doubles_the_windows_without_changing_their_length`
- `a_turn_shorter_than_the_window_still_gets_exactly_one_embedding`
- `windows_stay_inside_the_verified_frame_range` — the C7 coordination guard
- `coverage_counts_overlapped_audio_once`
