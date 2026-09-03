# Voiceprint threshold calibration — measurement receipt

> **Superseded by
> [`voiceprint-recalibration-2026-09-03.md`](voiceprint-recalibration-2026-09-03.md).**
> Every CAM++ number below was measured through the corrupted ONNX Runtime
> graph that `campplus-divergence-2026-09-02.md` diagnosed and fixed. The
> harness was re-run for all four embedders on the fixed code path — on these
> same 36 fixtures — and the 2026-09-03 receipt carries the numbers the app
> actually ships. Everything here is kept as the record of what was measured
> before the fix, and is still the origin of the method (fixtures, pairing,
> the zero-false-accept rule, the `auto_apply` and `margin` design rules).
> The CAM++ rows in the distribution, operating-point and frame-error tables
> below are marked where the re-run moved them.

**Date:** 2026-09-02
**Machine:** Apple M4 Pro, macOS 27.0 (Darwin 27.0.0)
**Harness:** the opt-in `voiceprint_threshold_calibration` test
(`rust-sidecar/src/diarization/mod.rs`), release profile, run as

```
PLAINSONG_DATA_DIR=<staging>/data \
PLAINSONG_VOICEPRINT_FIXTURES=<staging>/fixtures \
PLAINSONG_VOICEPRINT_CALIBRATION=1 \
cargo test --release --locked --lib voiceprint_threshold_calibration -- --ignored --nocapture
```

The harness runs the app's **own** embedder (`diarization/embedder.rs`: FBank
front end with per-utterance cepstral mean normalization, ONNX Runtime session,
L2-normalized pooled output) at the app's **own** segmentation
(`generate_segments(duration, 2.0, 1.0)`, pooled by `centroid_of`) — not a
re-implementation of either. The numbers below therefore describe the objects
Plainsong actually compares.

## What was measured

| | |
|---|---|
| Voices | 6 macOS `say` voices: Samantha (en-US), Daniel (en-GB), Fred, Kathy, Rocko (en-US), Shelley (en-US) |
| Utterances | 6 per voice — distinct meeting-shaped sentences, 6.6–10.6 s each |
| Fixtures | 36 files, 16 kHz mono Int16 WAV via `say -o … .aiff` then `afconvert -f WAVE -d LEI16@16000 -c 1` |
| Signature per fixture | the 2 s / 1 s-overlap windows the pipeline cuts, embedded and averaged exactly as a diarization cluster is |
| Same-speaker pairs | 6 voices × C(6,2) = **90** |
| Different-speaker pairs | C(6,2) voice pairs × 36 utterance pairs = **540** |
| Models | all four the app ships, each verified against the SHA-256 pinned in `download/mod.rs` before use |

Model files were fetched from the exact immutable URLs pinned in
`rust-sidecar/src/download/mod.rs`, and every digest matched:

```
d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0  ecapa_tdnn_speaker.onnx
1068e4ac3a76bb9c769e6816ef30bf89363f6e966f1d938210cb8ed4038f8e93  campplus_speaker.onnx
7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068  resnet34_speaker.onnx
be6b162137d8b08854268a97763c007e49882f221e02950242923d40d2be157e  eres2netv2_speaker.onnx
```

They were staged under a scratch `PLAINSONG_DATA_DIR`, never in the user's real
models directory, and are not committed.

## Load caveat

`uptime` reported 1-minute load averages between **31.9** and **104.6** across
the runs; this is a shared machine. Load does not affect anything claimed here:
cosine similarities between ONNX outputs are deterministic, and no latency
figure appears in this receipt. Recorded because the lane protocol requires it.

## How the thresholds were chosen

- **`accept`** — the smallest 0.01 step with **zero** false accepts across the
  540 different-speaker pairs. Stricter than the ≤ 1% asked for, and free: at
  that step every model still recognizes 100% of same-speaker pairs.
- **`auto_apply`** — `accept + 0.05`. Applying a name unasked must demand
  measurably more evidence than offering to. Every model is already at 0% FAR /
  100% TAR well below this, so the extra 0.05 buys headroom against real audio
  rather than costing recall on the fixtures.
- **`margin`** — 0.05 on every model, and deliberately **not** calibrated here.
  It is a rule about two *remembered voices* being distinguishable from each
  other; 36 fixtures from 6 clearly different voices contain no near-twin pair
  that would calibrate it. 0.05 is about a quarter of the smallest measured gap
  between the same-speaker minimum and the different-speaker maximum (0.202,
  ECAPA-TDNN), so on these fixtures it never blocked a true match.

## Distributions

Cosine similarity; higher is more similar.

| Model | dim | same min | same p05 | same p50 | same p95 | diff p50 | diff p95 | diff p99 | diff max | gap (same min − diff max) |
|---|---|---|---|---|---|---|---|---|---|---|
| ECAPA-TDNN 512 | 192 | 0.8115 | 0.8648 | 0.9165 | 0.9439 | 0.2031 | 0.5073 | 0.5816 | 0.6096 | **+0.202** |
| CAM++ *(superseded)* | 512 | 0.8219 | 0.8373 | 0.8908 | 0.9314 | 0.2116 | 0.4720 | 0.5373 | 0.5642 | **+0.258** |
| ResNet34 | 256 | 0.8545 | 0.8751 | 0.9123 | 0.9395 | 0.1716 | 0.4966 | 0.6034 | 0.6471 | **+0.207** |
| ERes2NetV2 (int8) | 192 | 0.9146 | 0.9294 | 0.9535 | 0.9699 | 0.3972 | 0.5639 | 0.6014 | 0.6201 | **+0.295** |

All four separate cleanly: no different-speaker pair scores as high as the
weakest same-speaker pair, on any model.

> **CAM++ row superseded.** Those figures come from the corrupted ONNX Runtime
> graph. On the fixed path the same fixtures give 0.8226 / 0.8404 / 0.8999 /
> 0.9402 same-speaker and 0.2057 / 0.4575 / 0.5259 / 0.5673 different-speaker,
> a +0.255 gap — see `voiceprint-recalibration-2026-09-03.md` §1. The other
> three rows were re-measured on the fixed build and are unchanged to the last
> digit.

## Operating points

### ECAPA-TDNN — shipped `accept` 0.61, `auto_apply` 0.66

| threshold | false accepts | FAR | true accepts | TAR |
|---|---|---|---|---|
| 0.58 | 6/540 | 1.11% | 90/90 | 100.0% |
| 0.59 | 4/540 | 0.74% | 90/90 | 100.0% |
| 0.60 | 3/540 | 0.56% | 90/90 | 100.0% |
| **0.61** | **0/540** | **0.00%** | **90/90** | **100.0%** |
| **0.66** | **0/540** | **0.00%** | **90/90** | **100.0%** |

### CAM++ — shipped `accept` 0.57, `auto_apply` 0.62

*Superseded: measured on the corrupted graph. Re-measured on the fixed path the
thresholds are the same and the approach is strictly cleaner (2/540 at 0.55,
1/540 at 0.56) — `voiceprint-recalibration-2026-09-03.md` §2.*

| threshold | false accepts | FAR | true accepts | TAR |
|---|---|---|---|---|
| 0.55 | 4/540 | 0.74% | 90/90 | 100.0% |
| 0.56 | 2/540 | 0.37% | 90/90 | 100.0% |
| **0.57** | **0/540** | **0.00%** | **90/90** | **100.0%** |
| **0.62** | **0/540** | **0.00%** | **90/90** | **100.0%** |

### ResNet34 — shipped `accept` 0.65, `auto_apply` 0.70

| threshold | false accepts | FAR | true accepts | TAR |
|---|---|---|---|---|
| 0.59 | 6/540 | 1.11% | 90/90 | 100.0% |
| 0.61 | 3/540 | 0.56% | 90/90 | 100.0% |
| 0.62–0.64 | 2/540 | 0.37% | 90/90 | 100.0% |
| **0.65** | **0/540** | **0.00%** | **90/90** | **100.0%** |
| **0.70** | **0/540** | **0.00%** | **90/90** | **100.0%** |

ResNet34 has the fattest different-speaker tail of the four (p99 0.6034, max
0.6471), which is why its accept threshold is the highest.

### ERes2NetV2 (int8) — shipped `accept` 0.63, `auto_apply` 0.68

| threshold | false accepts | FAR | true accepts | TAR |
|---|---|---|---|---|
| 0.59 | 9/540 | 1.67% | 90/90 | 100.0% |
| 0.61 | 2/540 | 0.37% | 90/90 | 100.0% |
| 0.62 | 1/540 | 0.19% | 90/90 | 100.0% |
| **0.63** | **0/540** | **0.00%** | **90/90** | **100.0%** |
| **0.68** | **0/540** | **0.00%** | **90/90** | **100.0%** |

## Diarization accuracy on the same models

Run separately by the `diarization_cluster_eval` harness in the same file
(`PLAINSONG_TWO_SPEAKER_FIXTURE` names the directory) against a 59.0 s
two-speaker fixture: six alternating turns from Samantha and Fred concatenated
at 16 kHz, with a ground-truth turn list. The whole embed → cluster → smooth
path runs; frames are scored at 0.1 s resolution under the label permutation
that favours the model.

| Model | speakers found (truth 2) | frame error |
|---|---|---|
| ECAPA-TDNN 512 | 2 | 2.5% |
| CAM++ | 2 | 2.2% |
| ResNet34 | 2 | 4.2% |
| ERes2NetV2 (int8) | 2 | 4.2% |

> **Re-run on the fixed CAM++ session: every figure in this table is
> unchanged**, CAM++ included
> (`voiceprint-recalibration-2026-09-03.md` §4). The CAM++ number was measured
> here on corrupted embeddings and so was not yet earned; it now is.

## A methodology correction worth recording

The first version of this harness embedded each fixture as **one long
utterance** (6.6–10.6 s) rather than as the 2 s windows the pipeline uses.
Three models were largely unaffected, but CAM++ inverted completely under that
measurement: same-speaker median 0.4297 against a different-speaker 95th
percentile of 0.8415, with no threshold in a 0.40–0.95 sweep reaching zero
false accepts. On that evidence CAM++ was briefly given no thresholds at all.

That conclusion was wrong, and the reason is worth keeping:

- Re-measured at the pipeline's own 2 s segmentation, CAM++ separates cleanly
  (gap +0.258, the second widest of the four) and scores the **best** frame
  error in the two-speaker diarization eval. *(Both halves of that sentence
  were measured on the corrupted graph. Re-run after the ONNX Runtime fix the
  gap is +0.255 and the frame error is still 2.2%, still the best of the four:
  `voiceprint-recalibration-2026-09-03.md`.)*
- The divergence is real but length-dependent and lives in the runtime, not the
  features. **Reported, not reproduced here.** Feeding an identical 300-frame
  input tensor to `campplus.onnx` through the Rust `ort` 2.0.0-rc.13 crate and
  through Python `onnxruntime` 1.19.2 produced completely different embeddings,
  while ECAPA-TDNN agreed between them to six decimal places on the same input.
  What this receipt does **not** carry is the script, the exact input, or the
  cosine between the two runs, so treat the claim as an observation rather than
  a measurement you can check from here. The reproduction is lane C7's
  deliverable and lands with it as
  `artifacts/qa/campplus-divergence-2026-09-02.md`; until that file exists in
  the tree, nothing in this document depends on the claim. The circumstantial
  part that *is* checkable from the model files: CAM++ is the only one of the
  four whose graph is built from `Pad`/`AveragePool`/`Slice`-heavy D-TDNN
  context blocks (209 `Pad`, 208 `AveragePool`, 726 `Slice` versus zero, zero
  and zero for ECAPA-TDNN).
- The app never feeds sequences that long: `generate_segments(duration,
  SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS)` caps every window at 2 s
  (98–198 FBank frames), which is where all four models behave.

Two things follow. First, **a calibration harness has to measure the object the
product compares**, and this one now does. Second, the CAM++ / long-input
divergence is a latent hazard: any future change that lengthens the diarization
window would walk into it. It is not exploited today and is not fixed here.

The window is now named rather than written down twice —
`SEGMENT_SECONDS` / `SEGMENT_OVERLAP_SECONDS` / `MIN_SEGMENT_SECONDS` in
`rust-sidecar/src/diarization/embedder.rs`, used by both `diarize_real` and
this harness — and the embedder warns (and trips a `debug_assert!`) when a
window arrives outside the 98–198 FBank frames those constants imply. That is
the tripwire for the hazard above: a longer window now announces itself instead
of quietly being compared against thresholds that were never measured for it.

**Not the cause, checked:** `compute_fbank_features` already applies
per-utterance cepstral mean normalization (subtracting the per-bin mean across
frames, `rust-sidecar/src/diarization/embedder.rs`). Adding CMN was the first
hypothesis for the CAM++ result and it was already there; a Python replica of
the front end with and without int16 waveform scaling, a Povey window and
per-frame DC removal moved every model's gap by less than 0.05 and did not
change CAM++'s behaviour at either sequence length.

## What this receipt does not prove

- **Synthetic speech only.** `say` voices have no room, no microphone, no
  channel, no overlapping talk and no emotional range. Real meetings will score
  lower on same-speaker pairs and higher on different-speaker pairs. Treat 100%
  TAR / 0% FAR as an upper bound, never as a claim about a user's Mac.
  `docs/beta/KNOWN-LIMITATIONS.md` says this where users can read it.
- **Single-microphone assumption.** Every fixture is one clean voice on one
  channel. A recording where two people share a microphone produces a cluster
  centroid that describes neither.
- **The `margin` is a design rule, not a measurement.** See above.
- **No non-English voices, no children, no whispering, no accents beyond
  en-US/en-GB.** Six voices establishes that the distributions separate. It is
  not a demographic evaluation.
- **The diarization eval is one 59 s two-speaker fixture.** It is enough to
  rule out "this model cannot separate two people"; it is not a DER benchmark.
