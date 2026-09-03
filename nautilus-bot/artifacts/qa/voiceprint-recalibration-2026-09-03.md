# Voiceprint threshold recalibration on the fixed CAM++ session — measurement receipt

**Date:** 2026-09-03
**Machine:** Apple M4 Pro, macOS 27.0 (Darwin 27.0.0), shared
**Supersedes:** `artifacts/qa/voiceprint-calibration-2026-09-02.md`
**Because of:** `artifacts/qa/campplus-divergence-2026-09-02.md`

Lane C7 established that every CAM++ embedding this app had ever produced was
computed by a graph ONNX Runtime 1.28 rewrites incorrectly, and fixed it by
building that one model's session with `GraphOptimizationLevel::Disable`. The
CAM++ thresholds in the 2026-09-02 calibration were therefore measured on
corrupted vectors. This receipt re-derives the operating points for **all four**
embedders on the fixed code path — not only CAM++, because the fix touches
`load_embedding_session`, which every model goes through, and "the other three
are unaffected" was an expectation to check rather than a result to assume.

## Headline

- **No threshold moved.** All four `accept` / `auto_apply` pairs in
  `rust-sidecar/src/diarization/voiceprints.rs` are exactly what they were.
- **The three unaffected models are bit-identical**, vector by vector, across
  the two builds: cosine 1.0000 at all 36 fixtures for ECAPA-TDNN, ResNet34 and
  ERes2NetV2. The shared code path perturbed nothing.
- **Stored CAM++ voiceprints keep matching.** A profile enrolled by a pre-fix
  build scores 0.8930 at worst against post-fix embeddings of the same voice,
  against an accept threshold of 0.57. No migration, no namespace bump.
- **CAM++ still has the best frame error** in the two-speaker diarization eval
  (2.2%), and that claim now rests on the correct embeddings.

## Method

Identical to the 2026-09-02 receipt, and deliberately so — same harness, same
36 fixtures, same 90 same-speaker / 540 different-speaker pairing, same
zero-false-accept rule for `accept`, same `accept + 0.05` for `auto_apply`,
same 0.05 `margin` design rule. Read that receipt for what the method does and
does not establish; nothing about it changed here.

The fixtures were **not** re-synthesized. The 36 WAVs and the four staged model
files from the 2026-09-02 run were still on disk in this session's scratch area
and were reused, with all four digests re-verified against the values pinned in
`rust-sidecar/src/download/mod.rs` before use:

```
d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0  ecapa_tdnn_speaker.onnx
1068e4ac3a76bb9c769e6816ef30bf89363f6e966f1d938210cb8ed4038f8e93  campplus_speaker.onnx
7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068  resnet34_speaker.onnx
be6b162137d8b08854268a97763c007e49882f221e02950242923d40d2be157e  eres2netv2_speaker.onnx
```

Reusing the fixtures is what makes the before/after comparison meaningful: a
freshly synthesized set would have confounded the ONNX Runtime change with new
audio. Models are staged under a scratch `PLAINSONG_DATA_DIR`, never in the
user's real models directory, and are not committed.

### Two runs, one variable

Everything below is two runs of the same harness on the same inputs, differing
in exactly one line:

| run | `graph_optimization_level_for("campplus_speaker")` |
|---|---|
| **old** (control) | `GraphOptimizationLevel::Level3` — the pre-C7 behaviour, restored locally for this measurement only |
| **new** (shipped) | `GraphOptimizationLevel::Disable` — what is on the branch |

The old run is a control, and it earns its keep: **it reproduced the
2026-09-02 receipt exactly** — every distribution figure, every accept
threshold, and every frame error. That is what licenses reading the deltas
below as the effect of the fix rather than as drift in the fixtures, the
machine or the harness.

### Commands

```
PLAINSONG_DATA_DIR=<scratch>/data \
PLAINSONG_VOICEPRINT_FIXTURES=<scratch>/fixtures \
PLAINSONG_TWO_SPEAKER_FIXTURE=<scratch>/twospeaker \
PLAINSONG_VOICEPRINT_DUMP=<scratch>/<run>/sig \
PLAINSONG_VOICEPRINT_CALIBRATION=1 \
cargo test --release --locked --manifest-path rust-sidecar/Cargo.toml --lib \
  voiceprint_threshold_calibration -- --ignored --nocapture

… same environment …
cargo test --release --locked --manifest-path rust-sidecar/Cargo.toml --lib \
  diarization_cluster_eval -- --ignored --nocapture
```

`PLAINSONG_VOICEPRINT_DUMP` is new in this lane. It makes the harness write
each fixture's pooled signature out as little-endian `f32`, which is the only
way to compare two builds vector by vector rather than only through their
summary statistics. Unset in a normal run.

## Load caveat

`uptime` 1-minute load averages, recorded at each step:

| run | before calibration | after calibration | after cluster eval |
|---|---|---|---|
| old (control) | **68.16** | 67.02 | 66.34 |
| new (shipped) | **67.52** | 69.94 | 77.45 |

The lane protocol asks for a load average below about 6 before measuring. **It
was never below 6.** This is a shared machine running several lanes; load sat
between 34 and 78 for the entire window this lane had, and polling for a quiet
minute did not produce one.

That is stated plainly rather than worked around, and here is why it does not
undermine the numbers: **this receipt contains no latency measurement.** Every
figure in it is a cosine similarity between ONNX outputs, or a frame count
derived from them. Those are deterministic — the same inputs give the same bits
regardless of what else the CPU is doing, which the control run demonstrates by
reproducing the previous day's numbers to four decimal places under a
completely different load. If a future revision of this document adds a timing
figure, that figure will need a quiet machine; nothing here does.

## 1. Distributions, old vs new

Cosine similarity; higher is more similar. Rows in **bold** moved.

| Model | dim | same min | same p05 | same p50 | same p95 | diff p50 | diff p95 | diff p99 | diff max | gap |
|---|---|---|---|---|---|---|---|---|---|---|
| ECAPA-TDNN 512 | 192 | 0.8115 | 0.8648 | 0.9165 | 0.9439 | 0.2031 | 0.5073 | 0.5816 | 0.6096 | +0.202 |
| **CAM++ (old)** | 512 | 0.8219 | 0.8373 | 0.8908 | 0.9314 | 0.2116 | 0.4720 | 0.5373 | 0.5642 | +0.258 |
| **CAM++ (new)** | 512 | **0.8226** | **0.8404** | **0.8999** | **0.9402** | **0.2057** | **0.4575** | **0.5259** | **0.5673** | **+0.255** |
| ResNet34 | 256 | 0.8545 | 0.8751 | 0.9123 | 0.9395 | 0.1716 | 0.4966 | 0.6034 | 0.6471 | +0.207 |
| ERes2NetV2 (int8) | 192 | 0.9146 | 0.9294 | 0.9535 | 0.9699 | 0.3972 | 0.5639 | 0.6014 | 0.6201 | +0.295 |

ECAPA-TDNN, ResNet34 and ERes2NetV2 are shown once because the old and new runs
produced **the same digits in every column**. That is not rounding: the dumped
signature vectors are bit-identical, checked in §3.

CAM++ moved a little, and mostly in the direction you would want. Same-speaker
similarity is up across the distribution (p50 0.8908 → 0.8999, p95 0.9314 →
0.9402) and the different-speaker tail is down (p95 0.4720 → 0.4575, p99 0.5373
→ 0.5259). The two figures that set the threshold barely moved and went in
opposite directions — same-speaker minimum up 0.0007, different-speaker maximum
up 0.0031 — so the headline gap narrows by 0.003 while the bulk of both
distributions separates better. On 630 pairs from six synthetic voices, a
0.003 change in a single extreme value is noise, not a finding.

## 2. Operating points and the delta from what ships

`accept` is the smallest 0.01 step with zero false accepts across the 540
different-speaker pairs; `auto_apply` is `accept + 0.05`. Both were re-derived
from the new run, not carried over.

| Model | same min | diff max | gap | `accept` (new) | shipped | Δ | `auto_apply` (new) | shipped | Δ |
|---|---|---|---|---|---|---|---|---|---|
| ECAPA-TDNN 512 | 0.8115 | 0.6096 | +0.202 | **0.61** | 0.61 | **0.00** | **0.66** | 0.66 | **0.00** |
| CAM++ | 0.8226 | 0.5673 | +0.255 | **0.57** | 0.57 | **0.00** | **0.62** | 0.62 | **0.00** |
| ResNet34 | 0.8545 | 0.6471 | +0.207 | **0.65** | 0.65 | **0.00** | **0.70** | 0.70 | **0.00** |
| ERes2NetV2 (int8) | 0.9146 | 0.6201 | +0.295 | **0.63** | 0.63 | **0.00** | **0.68** | 0.68 | **0.00** |

Every model is at 0 false accepts / 100% true accepts at its `accept` step, and
still at 100% true accepts at `auto_apply`.

**No constant in `voiceprints.rs` changed.** The comments attached to them did:
CAM++'s cited figures are now the post-fix ones (0.8226 / 0.5673, and 1/540
false accepts at 0.56 rather than 2/540), and all five constants now name this
receipt.

### CAM++ approach to the threshold, old vs new

The only model whose sweep changed at all:

| threshold | old false accepts | new false accepts | TAR (both) |
|---|---|---|---|
| 0.53 | 7/540 | 5/540 | 90/90 |
| 0.54 | 4/540 | 2/540 | 90/90 |
| 0.55 | 4/540 | 2/540 | 90/90 |
| 0.56 | 2/540 | 1/540 | 90/90 |
| **0.57** | **0/540** | **0/540** | **90/90** |
| **0.62** | **0/540** | **0/540** | **90/90** |

The fixed embeddings reach zero false accepts at the same step and have
strictly fewer false accepts at every step below it. Recall holds slightly
longer too: both runs keep 100% true accepts through 0.82, and at 0.83 the
fixed path is at 89/90 against 87/90 pre-fix. None of that changes the chosen
operating point, which is set by the first zero-false-accept step.

## 3. Compatibility: does a stored voiceprint still match?

This is the question that decides whether `embedding_model_id` needs a new
namespace. A stored profile's centroid is `centroid_of` over its kept
per-cluster signatures; matching compares that against a new cluster centroid.
So the test is: build a profile the way the database stores one, using **old**
(pre-fix) signatures, and match it against **new** (post-fix) signatures of the
same voice.

Three measurements per model, over all 36 fixtures and all 6 voices:

| Model | same-utterance cos(old, new): min / median | OLD profile (5 utts) vs NEW held-out utterance, min | OLD profile vs NEW *different* speaker, max | accept |
|---|---|---|---|---|
| ECAPA-TDNN 512 | 1.0000 / 1.0000 | 0.9238 | 0.5940 | 0.61 |
| **CAM++** | **0.9604 / 0.9756** | **0.8930** | **0.5532** | **0.57** |
| ResNet34 | 1.0000 / 1.0000 | 0.9440 | 0.6255 | 0.65 |
| ERes2NetV2 (int8) | 1.0000 / 1.0000 | 0.9721 | 0.6173 | 0.63 |

**Verdict: stored profiles keep matching on every model, and no
`embedding_model_id` namespace needs to change.** The worst case anywhere is
CAM++ at 0.8930 against a 0.57 threshold — 0.32 of headroom. Nor does the
change introduce a false accept in the other direction: the highest score an
old profile gets against a *different* speaker's new embeddings is 0.5532 for
CAM++, still below its 0.57 accept threshold, and every model's cross-speaker
maximum stays under its own threshold.

### The control that makes those numbers readable

The "OLD profile vs NEW held-out utterance" column is 0.89–0.97, not 1.0, and
that is easy to misread as build drift. Most of it is not: matching a
five-utterance profile against a *held-out sixth utterance* is a hard case by
construction, and it scores about the same inside a single build. Running the
identical arithmetic entirely within the new build:

| Model | new profile → new held-out | old profile → new held-out | difference |
|---|---|---|---|
| ECAPA-TDNN 512 | 0.9238 | 0.9238 | **0.0000** |
| CAM++ | 0.9240 | 0.8930 | −0.0309 |
| ResNet34 | 0.9440 | 0.9440 | **0.0000** |
| ERes2NetV2 (int8) | 0.9721 | 0.9721 | **0.0000** |

For three of the four models, crossing builds costs *exactly nothing* — the
signatures are the same bits. For CAM++ it costs 0.031 of a 0.36 margin. That
is the entire practical footprint of the defect on stored data.

### What this does not cover

Real enrolled profiles are averages of real meeting audio, not of six `say`
utterances, and a real profile may hold up to 20 samples rather than 5. The
mechanism is the same and the margin is enormous, but the number 0.8930 is a
property of these fixtures.

## 4. Diarization cluster evaluation

Re-run for all four models on the same 59.0 s two-speaker fixture the
2026-09-02 receipt used (six alternating turns, Samantha and Fred, exact
ground-truth turn list; frames scored at 0.1 s under the label permutation that
favours the model). 590 frames scored per model.

| Model | speakers found (truth 2) | frame error (old) | frame error (new) |
|---|---|---|---|
| ECAPA-TDNN 512 | 2 | 2.5% | 2.5% |
| **CAM++** | 2 | 2.2% | **2.2%** |
| ResNet34 | 2 | 4.2% | 4.2% |
| ERes2NetV2 (int8) | 2 | 4.2% | 4.2% |

Unchanged, including CAM++. The 2026-09-02 receipt's claim that CAM++ scores
the best frame error of the four was measured on corrupted embeddings and was
therefore not yet earned; it is now measured on the correct ones and holds.

Read it for no more than it is worth: one 59 s fixture, two synthetic voices,
no overlapped speech. It distinguishes 2.2% from 4.2%; it does not establish
that CAM++ is the better model for real meetings, and Plainsong still defaults
to ECAPA-TDNN.

## 5. What changed in the tree

- `rust-sidecar/src/diarization/voiceprints.rs` — **no constant changed.** The
  comment on each of the five threshold constants now names this receipt, and
  the CAM++ comment carries post-fix figures (0.8226 / 0.5673, 1/540 false
  accepts at 0.56).
- `rust-sidecar/src/diarization/mod.rs` — the calibration harness gained
  `PLAINSONG_VOICEPRINT_DUMP`, and its module docs name this receipt and list
  every environment variable it reads.
- `rust-sidecar/src/diarization/embedder.rs` — the segmentation constants and
  their pinning test cite this receipt, since it is now the run their values
  would invalidate.
- `artifacts/qa/voiceprint-calibration-2026-09-02.md` — marked superseded, with
  the CAM++ distribution, operating-point and frame-error rows annotated.
- `artifacts/qa/campplus-divergence-2026-09-02.md` — its two open follow-ups on
  compatibility and recalibration are closed against this receipt.
- `docs/model-inventory-upgrades.md`, `docs/beta/KNOWN-LIMITATIONS.md`,
  `docs/beta/PRIVACY-AND-CLOUD.md`, `CHANGELOG.md` — recommendation restated as
  unchanged, and the receipt citations point here rather than at the superseded
  run.

Tests:

| test | what it holds |
|---|---|
| `voiceprints::tests::the_shipped_thresholds_are_the_ones_that_were_measured` | all twelve numbers pinned to what this receipt derived, so an edit of 0.05 fails instead of passing the shape checks |
| `voiceprints::tests::every_shipped_threshold_constant_cites_its_receipt` | each of the five constants' own doc comment names a receipt, and the receipts are `include_str!`-ed so a renamed or deleted file breaks the build |

The second test was checked against a negative control: deleting the citation
line from `ERES2NETV2_THRESHOLDS` makes it fail with
`ERES2NETV2_THRESHOLDS's comment names no measurement receipt`. It is a real
guard, not a tautology.

## 6. What this receipt does not prove

Everything the 2026-09-02 receipt disclaims still applies unchanged and is not
repeated here: synthetic speech only, single-microphone, no overlap, six
en-US/en-GB voices, `margin` a design rule rather than a measurement, and the
100% TAR / 0% FAR figures an upper bound rather than a promise about a user's
Mac. In addition:

- **The load average was never low.** See the caveat above. Correctness claims
  are unaffected; there are no timing claims.
- **The fixtures were reused, not regenerated.** That is a deliberate choice
  for comparability, and it means this run inherits any peculiarity of that
  particular fixture set rather than averaging over a second one.
- **The compatibility test simulates a stored profile; it does not read one.**
  No profile written by a released build was available to test against, and
  Plainsong ships no CAM++ profile of its own.
- **CPU execution provider only.** `ort-coreml` is not shipped and was not
  measured, as in lane C7.
