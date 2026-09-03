# The diarizer's turn floor: 5.0 s was measured wrong, 3.0 s is measured right

Lane M1. Measured 2026-09-03, 08:07–08:40 UTC (03:07–03:40 CDT).

Lane C8 found that `EmbeddingClusterer::smooth_segments` discards any merged
run shorter than `min_segment_duration` = 5.0 s, and that on a five-minute
two-speaker conversation with 3-second turns this costs 58.7% frame error and
121 of 300 seconds left unattributed
(`artifacts/qa/diarization-segmentation-2026-09-02.md`). It did not measure
what the floor should be.

**It should be 3.0 seconds.** Swept over 24 fixtures and two embedders, 3.0 s
is better than 5.0 s on 28 of 48 runs, identical on 19, and worse on exactly
one, by 0.0007. Mean frame error falls from **0.3807 to 0.1683**, mean
unattributed reference speech from **85.6 s of 300 to 3.5 s**, and the number
of runs that report the right number of speakers rises from **33 of 48 to 45
of 48**. That is the change, and it is the whole change: `SEGMENT_SECONDS`,
`MIN_SEGMENT_SECONDS`, the clustering threshold and every calibrated
voiceprint threshold are untouched.

The floor is not removed, because removing it is worse. That is the second
finding, and it is the more interesting one.

---

## What was measured

- **Machine.** Apple M4 Pro, 14 logical CPUs, shared with other parity lanes.
  1-minute load average ran between 13 and 32 for the whole session. **Every
  frame-error number below is deterministic** — the sweep runs embedding and
  clustering once per fixture and then re-runs only the smoothing step, so
  nothing in these tables depends on load. No latency claim is made from this
  session, and the `wallSeconds` field the harness prints is the shared
  embed-and-cluster pass repeated on every row, not a per-row timing.
- **Fixtures.** 24, from `scripts/make-diarization-eval-fixture.mjs`: turn
  lengths 2, 3, 4, 5, 6 and 8 seconds × 2 and 3 speakers × 0 s and 0.8 s gaps.
  Each is 300 s. Ground truth is exact because the turn grid is generated.
- **Embedders.** ECAPA-TDNN (the default) and CAM++ (post-lane-C7 fix). 48
  runs, 10 floors each, 2 smoothing policies each: 960 scored rows.
- **Segmentation.** The shipped fixed grid, 2 s windows on a 1 s hop.
  `DEFAULT_SEGMENTATION` is unchanged. A VAD-aligned sweep is reported at the
  end because lane C8 is blocked on this decision, not because anything about
  it is adopted here.
- **Scoring.** `scripts/score-diarization-eval.mjs`, unchanged in definition.
  Its speaker-mapping search had to be reimplemented — see "The scorer could
  not score a low floor" below.
- **Harness.** `diarization::eval_tests::eval_turn_floor_sweep`, `#[ignore]`d.

The caveat from every diarization receipt in this tree still applies:
`frameErrorRate` is DER-*style* accounting on synthetic fixtures with no
overlapped speech, whose voices are pitch-shifted copies of one talker. It is
not a published DER and these numbers are not comparable to VoxConverse.

## The curve

Mean over all 48 runs (24 fixtures × 2 embedders), `discard` policy — the
shipped rule, with only the floor varied:

| floor (s) | mean frame error | mean unattributed | right speaker count | mean speakers predicted | reference boundaries within 0.5 s |
|---|---|---|---|---|---|
| 0.5 | 0.2055 | 0.0 s | 0/48 | 13.4 | 99.3% |
| 1.0 | 0.2055 | 0.0 s | 0/48 | 13.4 | 99.3% |
| 1.5 | 0.2055 | 0.0 s | 0/48 | 13.4 | 99.3% |
| 2.0 | 0.2055 | 0.0 s | 0/48 | 13.4 | 99.3% |
| 2.5 | **0.1683** | 3.5 s | **45/48** | 2.5 | 84.5% |
| **3.0** | **0.1683** | **3.5 s** | **45/48** | **2.5** | 84.5% |
| 3.5 | 0.2383 | 26.8 s | 42/48 | 2.3 | 67.4% |
| 4.0 | 0.2383 | 26.8 s | 42/48 | 2.3 | 67.4% |
| 4.5 | 0.3807 | 85.6 s | 33/48 | 2.0 | 46.2% |
| 5.0 (shipped before) | 0.3807 | 85.6 s | 33/48 | 2.0 | 46.2% |

Two things to read off it.

**The curve is a step function with four steps, not ten points.** On the fixed
grid a merged run of `k` windows spans exactly `2.0 + (k - 1) × 1.0` seconds,
so the only run lengths that exist are 2.0, 3.0, 4.0, 5.0 … and every floor in
`(2.0, 3.0]` is the same rule. Sweeping at 0.5 s resolution was still worth
doing: it is what proves the quantisation rather than assuming it, and the
quantisation is what makes the chosen number defensible.

**The curve is U-shaped, with its minimum at 3.0 s.** Frame error gets worse in
*both* directions. That is not what "the floor deletes real turns" alone
predicts, and it is the answer to why the floor exists at all.

## Why the floor exists

At any floor of 2.0 s or below, the only additional runs admitted are runs of a
**single window**, and a single window's label is uncorroborated. The
clusterer emits a great many of those: on the 24 fixtures it produces a mean of
**13.4 distinct speaker labels** where the truth is 2 or 3, and as many as 30.

| fixture (ECAPA) | distinct clusters | speakers reported at floor 2.0 | at floor 3.0 | truth |
|---|---|---|---|---|
| 2 s turns, 2 speakers, 0.8 s gaps | 16 | 16 | 2 | 2 |
| 3 s turns, 2 speakers, 0.8 s gaps | 22 | 22 | 2 | 2 |
| 3 s turns, 3 speakers, 0.8 s gaps | 28 | 28 | 3 | 3 |
| 5 s turns, 3 speakers, 0.8 s gaps | 21 | 21 | 3 | 3 |

Dropping the floor to 2.0 s buys total coverage — 0.0 s unattributed, 99.3% of
reference boundaries within half a second — and pays for it by reporting a
two-person meeting as sixteen speakers. Frame error is worse (0.2055 against
0.1683) because every spurious speaker's frames are errors under the optimal
one-to-one mapping, and the transcript would be worse than the number says: a
speaker list nobody can use.

So the floor is a **corroboration rule written in seconds**. 3.0 s is exactly
the span of two consecutive windows, and the rule it encodes is "a turn has to
be agreed on by at least two windows before it is reported". 5.0 s was four
windows, which is not a rule anyone stated; it is a number that was never
measured. This is now pinned by
`embedder::tests::the_turn_floor_is_the_span_of_two_consecutive_windows`.

## Per-fixture, 3.0 s against the shipped 5.0 s

`fer` is frame error; `pred` is speakers reported at floor 5.0 / 3.0 / 2.0
against the truth; boundaries are reference turn boundaries with a predicted
boundary within 0.5 s.

| model | turn | spk | gap | fer @5.0 | fer @3.0 | Δ | pred @5/@3/@2 | unattributed | boundaries @5→@3 |
|---|---|---|---|---|---|---|---|---|---|
| ecapa | 2 s | 2 | 0 | 1.0000 | 0.4800 | −0.5200 | 0/2/7 of 2 | 300 s → 21 s | 0 → 26 of 149 |
| ecapa | 2 s | 2 | 0.8 | 0.7053 | 0.3440 | −0.3613 | 1/2/16 of 2 | 190.6 s → 1 s | 0 → 186 of 214 |
| ecapa | 2 s | 3 | 0 | 1.0000 | 0.5967 | −0.4033 | 0/2/12 of 3 | 300 s → 107 s | 0 → 72 of 149 |
| ecapa | 2 s | 3 | 0.8 | 0.7147 | 0.3273 | −0.3874 | 0/3/30 of 3 | 214.4 s → 0 s | 0 → 191 of 214 |
| ecapa | 3 s | 2 | 0 | 0.5900 | 0.1567 | −0.4333 | 2/2/7 of 2 | 95 s → 0 s | 0 → 99 of 99 |
| ecapa | 3 s | 2 | 0.8 | **0.5873** | **0.2393** | −0.3480 | 2/2/22 of 2 | **121 s → 0 s** | 68 → 143 of 157 |
| ecapa | 3 s | 3 | 0 | 0.9800 | 0.1100 | −0.8700 | 1/3/15 of 3 | 290 s → 0 s | 0 → 99 of 99 |
| ecapa | 3 s | 3 | 0.8 | 0.6033 | 0.2393 | −0.3640 | 3/3/28 of 3 | 127.4 s → 0 s | 61 → 137 of 157 |
| ecapa | 4 s | 2 | 0 | 0.9600 | 0.0000 | −0.9600 | 1/2/6 of 2 | 285 s → 0 s | 3 → 74 of 74 |
| ecapa | 4 s | 2 | 0.8 | 0.1893 | 0.1833 | −0.0060 | 2/2/11 of 2 | 2.4 s → 0 s | 111 → 111 of 124 |
| ecapa | 4 s | 3 | 0 | 0.6200 | 0.1000 | −0.5200 | 2/3/12 of 3 | 156 s → 0 s | 30 → 74 of 74 |
| ecapa | 4 s | 3 | 0.8 | 0.1840 | 0.1780 | −0.0060 | 3/3/29 of 3 | 2.4 s → 0 s | 106 → 106 of 124 |
| ecapa | 5 s | 2 | 0 | 0.0000 | 0.0000 | 0 | 2/2/7 of 2 | 0 s → 0 s | 59 → 59 of 59 |
| ecapa | 5 s | 2 | 0.8 | 0.1560 | 0.1560 | 0 | 2/2/15 of 2 | 0 s → 0 s | 93 → 93 of 102 |
| ecapa | 5 s | 3 | 0 | 0.0700 | 0.0700 | 0 | 3/3/5 of 3 | 0 s → 0 s | 59 → 59 of 59 |
| ecapa | 5 s | 3 | 0.8 | 0.1527 | 0.1527 | 0 | 3/3/21 of 3 | 0 s → 0 s | 92 → 92 of 102 |
| ecapa | 6 s | 2 | 0 | 0.0667 | 0.0667 | 0 | 2/2/7 of 2 | 0 s → 0 s | 49 → 49 of 49 |
| ecapa | 6 s | 2 | 0.8 | 0.1313 | 0.1313 | 0 | 2/2/16 of 2 | 0.8 s → 0.8 s | 79 → 79 of 88 |
| ecapa | 6 s | 3 | 0 | 0.0733 | 0.0733 | 0 | 3/3/14 of 3 | 0 s → 0 s | 49 → 49 of 49 |
| ecapa | 6 s | 3 | 0.8 | 0.1360 | 0.1360 | 0 | 3/3/19 of 3 | 0.8 s → 0.8 s | 78 → 78 of 88 |
| ecapa | 8 s | 2 | 0 | 0.0467 | 0.0367 | −0.0100 | 2/2/8 of 2 | 3 s → 0 s | 36 → 37 of 37 |
| ecapa | 8 s | 2 | 0.8 | 0.1027 | 0.1027 | 0 | 2/2/15 of 2 | 0.8 s → 0.8 s | 57 → 57 of 68 |
| ecapa | 8 s | 3 | 0 | 0.0533 | 0.0400 | −0.0133 | 3/3/12 of 3 | 4 s → 0 s | 37 → 37 of 37 |
| ecapa | 8 s | 3 | 0.8 | 0.1000 | 0.1000 | 0 | 3/3/18 of 3 | 0.8 s → 0.8 s | 59 → 59 of 68 |
| campplus | 2 s | 2 | 0 | 1.0000 | 0.5000 | −0.5000 | 0/1/6 of 2 | 300 s → 15 s | 0 → 14 of 149 |
| campplus | 2 s | 2 | 0.8 | 0.7080 | 0.3427 | −0.3653 | 1/2/8 of 2 | 197.4 s → 0.4 s | 2 → 197 of 214 |
| campplus | 2 s | 3 | 0 | 1.0000 | 0.4967 | −0.5033 | 0/3/9 of 3 | 300 s → 14 s | 0 → 65 of 149 |
| campplus | 2 s | 3 | 0.8 | 0.7133 | 0.3167 | −0.3966 | 1/3/26 of 3 | 211 s → 0 s | 0 → 189 of 214 |
| campplus | 3 s | 2 | 0 | 0.5600 | 0.1600 | −0.4000 | 1/2/7 of 2 | 80 s → 0 s | 0 → 99 of 99 |
| campplus | 3 s | 2 | 0.8 | 0.5053 | 0.2580 | −0.2473 | 2/2/14 of 2 | 75 s → 0 s | 84 → 147 of 157 |
| campplus | 3 s | 3 | 0 | 0.9600 | 0.2800 | −0.6800 | 1/3/14 of 3 | 280 s → 2 s | 0 → 97 of 99 |
| campplus | 3 s | 3 | 0.8 | 0.5860 | 0.2473 | −0.3387 | 3/3/29 of 3 | 117.2 s → 0.6 s | 64 → 138 of 157 |
| campplus | 4 s | 2 | 0 | 0.9600 | 0.0000 | −0.9600 | 1/2/3 of 2 | 285 s → 0 s | 3 → 74 of 74 |
| campplus | 4 s | 2 | 0.8 | 0.2067 | 0.2000 | −0.0067 | 2/2/10 of 2 | 2 s → 0 s | 114 → 115 of 124 |
| campplus | 4 s | 3 | 0 | 0.6267 | 0.0733 | −0.5534 | 2/3/8 of 3 | 147 s → 0 s | 17 → 74 of 74 |
| campplus | 4 s | 3 | 0.8 | 0.2113 | 0.1927 | −0.0186 | 3/3/19 of 3 | 5.8 s → 0 s | 114 → 115 of 124 |
| campplus | 5 s | 2 | 0 | 0.0067 | 0.0067 | 0 | 2/2/4 of 2 | 0 s → 0 s | 59 → 59 of 59 |
| campplus | 5 s | 2 | 0.8 | 0.1547 | 0.1547 | 0 | 2/2/17 of 2 | 0 s → 0 s | 88 → 88 of 102 |
| campplus | 5 s | 3 | 0 | 0.1133 | 0.1133 | 0 | 3/3/9 of 3 | 0 s → 0 s | 59 → 59 of 59 |
| campplus | 5 s | 3 | 0.8 | 0.1520 | 0.1527 | **+0.0007** | 3/**4**/21 of 3 | 0.6 s → 0 s | 89 → 89 of 102 |
| campplus | 6 s | 2 | 0 | 0.0100 | 0.0100 | 0 | 2/2/4 of 2 | 0 s → 0 s | 49 → 49 of 49 |
| campplus | 6 s | 2 | 0.8 | 0.1293 | 0.1293 | 0 | 2/2/18 of 2 | 0.8 s → 0.8 s | 74 → 74 of 88 |
| campplus | 6 s | 3 | 0 | 0.0867 | 0.0867 | 0 | 3/3/7 of 3 | 0 s → 0 s | 49 → 49 of 49 |
| campplus | 6 s | 3 | 0.8 | 0.1307 | 0.1307 | 0 | 3/3/21 of 3 | 0.8 s → 0.8 s | 75 → 75 of 88 |
| campplus | 8 s | 2 | 0 | 0.0133 | 0.0000 | −0.0133 | 2/2/4 of 2 | 4 s → 0 s | 37 → 37 of 37 |
| campplus | 8 s | 2 | 0.8 | 0.1027 | 0.1027 | 0 | 2/2/13 of 2 | 0.8 s → 0.8 s | 57 → 57 of 68 |
| campplus | 8 s | 3 | 0 | 0.0167 | 0.0033 | −0.0134 | 3/3/6 of 3 | 4 s → 0 s | 37 → 37 of 37 |
| campplus | 8 s | 3 | 0.8 | 0.1000 | 0.1000 | 0 | 3/3/16 of 3 | 0.8 s → 0.8 s | 59 → 59 of 68 |

### The one regression, stated plainly

CAM++ on 5-second turns, 3 speakers, 0.8 s gaps: frame error rises from 0.1520
to 0.1527 — 21 frames of 30,000 — and the run reports a fourth speaker that is
not there. A 3.4-second run that the 5-second floor deleted now survives and
carries a label of its own. It is the only run of 48 that gets worse, the cost
is 0.0007, and it is exactly the kind of thing a lower floor is expected to do
occasionally. It does not outweigh 28 improvements, four of which are worth
more than half a frame-error point.

### Where 3.0 s still is not good

At 2-second turns nothing here is usable: 0.32 to 0.60 frame error on every
fixture, and the two gapless 2-second fixtures are the only ones where a floor
of 2.0 s would score better than 3.0 s (0.26 against 0.48 for ECAPA) — by
covering all the audio with seven to sixteen speakers. Two-second turns are
below what a 2-second window can resolve, and the honest fix for them is a
different segmentation, not a different floor.

## The alternative that was measured and rejected

Lane M1's brief offered a second option: instead of discarding a short run,
merge it into the neighbouring run its embedding most resembles by cosine.
That was implemented (`eval_tests::absorb_short_runs`) and swept alongside:

| floor (s) | discard: mean frame error | absorb: mean frame error | discard: right speaker count | absorb: right speaker count |
|---|---|---|---|---|
| 2.0 | 0.2055 | 0.2055 | 0/48 | 0/48 |
| 3.0 | **0.1683** | 0.1983 | **45/48** | 41/48 |
| 4.0 | 0.2383 | 0.2400 | 42/48 | 34/48 |
| 5.0 | 0.3807 | **0.2983** | 33/48 | 27/48 |

**Absorbing loses at the floor that matters.** Run by run, at the shipped
3.0 s floor it is worse than discarding on **44 of 48** runs and better on 4.
It is only competitive at floors high enough that discarding is deleting real
turns — at 5.0 s it wins on 20 runs of 48 and its mean is much the better of
the two, which is why it looked promising — and that advantage disappears
entirely once the floor is right.

The reason is visible in the speaker column: absorbing never removes a spurious
label, it only moves a short run onto a neighbour, so single-window noise gets
laundered into a named speaker (mean 5.6 speakers at floor 5.0, against 2.0 for
discard). Discarding is the honest operation here: it declines to attribute
audio it cannot corroborate, and `merge_with_transcript` already renders that
as text with no speaker.

`absorb_short_runs` is kept in the harness, not in the product, so this
comparison stays reproducible.

## What was *not* changed

- `SEGMENT_SECONDS` (2.0), `SEGMENT_OVERLAP_SECONDS` (1.0) and
  `MIN_SEGMENT_SECONDS` (1.0) are untouched, so **every embedding window this
  pipeline produces is byte-identical to before**. The floor is applied after
  clustering, to a list of `(start, end, label)` tuples, and can no more move an
  FBank frame count than it can move the audio.
- Therefore the calibrated voiceprint thresholds in `voiceprints.rs` still
  describe the shipped pipeline exactly, and
  `voiceprints::tests::the_shipped_thresholds_are_the_ones_that_were_measured`
  is unmodified. The calibration harness was not re-run and does not need to be.
- The clustering distance threshold (0.35) is untouched. It is the cause of the
  13.4-mean spurious cluster count above and it is the obvious next lane, but
  changing it is a different measurement with a different receipt.
- `SpeakerSegment::confidence` is still the flat 0.90 it has always been.
  Grading it by how many windows corroborate a turn was considered and not
  done: nothing in the renderer reads that field, so it would be an invented
  number with no reader.

## The scorer could not score a low floor

`scripts/score-diarization-eval.mjs` found its optimal speaker mapping by
enumerating every permutation of the reference speakers. At two or three
speakers that is free. At the 22 speakers a floor of 2.0 s produces, it is not:
the first attempt to score one exhausted Node's heap and aborted.

The metric is unchanged — the optimal one-to-one speaker map is the classic
assignment problem, and enumeration was only ever a slow way to solve it — but
`bestMapping` now builds the frame-agreement matrix and solves it with the
Hungarian algorithm in O(n²m). Verified by reproduction: scoring the shipped
5.0-second floor on the 3-second-turn fixture through the new code returns
**0.5873 frame error, 121 s unattributed, 2 of 2 speakers**, which is lane C8's
published row for that fixture to four decimal places.

One behavioural difference worth writing down: where several mappings tie, the
enumeration returned the first one it found and this returns whichever the
assignment solver settles on. The error count is identical; the
`speakerMapping` field may name a different equally-good pairing.

## Segmentation: is lane C8 unblocked?

C8 measured VAD-aligned segmentation, found it a 65% relative improvement on
one fixture and a catastrophe on two others, and traced the catastrophe to this
floor: VAD-aligned runs are bounded by their speech region, so on short turns
every run fell under 5.0 s and was deleted. It left `DEFAULT_SEGMENTATION =
FixedGrid` and wrote down that the turn minimum had to be fixed first.

**Mostly, and not entirely.** The whole sweep was repeated with
`PLAINSONG_DIAR_EVAL_SEGMENTATION=vad1.0` — same 24 fixtures, same two
embedders, same 10 floors, still without changing `DEFAULT_SEGMENTATION`:

| floor (s) | mean frame error | mean unattributed | right speaker count | mean speakers | runs finding **no** speakers |
|---|---|---|---|---|---|
| 2.0 | 0.1219 | 1.5 s | 24/48 | 5.1 | 0/48 |
| **3.0** | **0.1474** | 22.1 s | **42/48** | 2.3 | **4/48** |
| 4.0 | 0.2497 | 55.2 s | 35/48 | 1.9 | 8/48 |
| 5.0 (before) | 0.4273 | 116.6 s | 25/48 | 1.5 | **16/48** |

At the old floor, 16 of 48 VAD-aligned runs returned **no speakers at all** —
that is the failure C8 hit. At 3.0 s it is 4 of 48, and all four are the
2-second-turn-with-gaps fixtures, where the speech regions themselves are about
two seconds and no run can reach the floor.

Compared like for like at floor 3.0, VAD-aligned segmentation is now **better on
21 of 48 runs, identical on 22, and worse on 5** — and four of those five are
the 2-second fixtures just named. Mean frame error is 0.1474 against 0.1683 for
the fixed grid, and on the gapped fixtures with turns of 3 seconds or more it
wins by 0.08 to 0.19 points every time (ECAPA, 3 s turns, 3 speakers, gaps:
0.2393 → 0.0530). The gapless fixtures are byte-identical between the two, for
the reason C8 gave: with no silence, Silero returns one region.

**This lane does not adopt it.** Changing where windows are cut changes what the
embedder is fed, which is the thing lane M1 was told to stop at rather than
ship. The numbers are here so that C8's successor can re-run its own adoption
rule against a pipeline where the floor no longer deletes its output, and so
that the two-second case is on the record as still broken.

## Reproducing

```sh
# fixtures: 6 turn lengths x 2 speaker counts x 2 gap settings
for turn in 2 3 4 5 6 8; do for spk in 2 3; do for gap in 0 0.8; do
  node scripts/make-diarization-eval-fixture.mjs --out-dir <dir> \
    --turn-seconds $turn --speakers $spk --gap-seconds $gap \
    --label "t$turn-s$spk-g${gap/./}"
done; done; done

# one embed+cluster pass per fixture, every floor scored off it
PLAINSONG_DIAR_EVAL_AUDIO=<dir>/t3-s2-g08-300s.wav \
PLAINSONG_DIAR_EVAL_MODEL=ecapa_tdnn_speaker \
PLAINSONG_DIAR_EVAL_SEGMENTATION=fixed \
  node scripts/cargo-sidecar.mjs test --locked --lib \
  diarization::eval_tests::eval_turn_floor_sweep -- --ignored --nocapture \
  | grep -E '^DIAR-(EVAL|LABELS) ' > run.txt

node scripts/score-diarization-eval.mjs \
  --ground-truth <dir>/t3-s2-g08-300s.ground-truth.json --result run.txt
```

`PLAINSONG_DIAR_EVAL_FLOORS` overrides the swept floors and
`PLAINSONG_DIAR_EVAL_SEGMENTATION` takes `fixed`, `vad1.0` or `vad0.5`. The
WAVs are gitignored; the ground-truth JSON is deterministic from the flags.

The `DIAR-LABELS` line the harness prints is the raw window/label list. One of
them is committed as
`rust-sidecar/src/diarization/fixtures/turn-floor-three-second-turns.json` so
the frame-error result can be regression-tested with no ONNX runtime at all.

## Tests

In `rust-sidecar/src/diarization/embedder.rs`:

- `the_turn_floor_is_the_span_of_two_consecutive_windows` — pins 3.0 s to the
  window geometry rather than to a preference.
- `the_turn_floor_cites_a_receipt_that_exists` — `include_str!`s this file, so
  deleting or renaming it fails the build.
- `a_run_of_one_window_is_dropped_and_a_run_of_two_survives` — the boundary
  condition, from both sides.
- `a_dropped_run_leaves_a_gap_rather_than_extending_its_neighbours` — the
  discard semantics the transcript merge depends on.
- `a_recording_whose_every_window_disagrees_reports_no_turns`
- `a_clipped_tail_run_is_judged_on_its_real_length` — the last window of a
  recording is clipped, so the tail run breaks the quantisation.
- `an_empty_clustering_smooths_to_nothing`
- `the_turn_floor_is_worth_a_third_of_the_frames_on_a_short_turn_fixture` —
  the regression test. Scores the committed fixture at 3.0 s (7,179 frame
  errors of 30,000), at 5.0 s (17,619, which is C8's 0.5873) and at 0.5 s
  (22 speakers, and worse than 3.0 s), so the floor cannot move in either
  direction without a failure.

`merge_keeps_short_runs_removed_by_smoothing_anonymous` in `diarization/mod.rs`
is deliberately untouched and still passes: its 2-second interloper is under
the new floor as it was under the old one.
