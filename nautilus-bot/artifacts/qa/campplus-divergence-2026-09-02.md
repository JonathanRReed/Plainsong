# CAM++ ONNX Runtime divergence — measurement receipt

**Date:** 2026-09-02
**Machine:** Apple M4 Pro, macOS 27.0 (Darwin 27.0.0), shared
**Runtimes:**

| | |
|---|---|
| Rust | `ort` 2.0.0-rc.13, which links **ONNX Runtime 1.28.0** |
| Python (reference) | `onnxruntime` **1.19.2**, NumPy 2.0.2, Python 3.9.6 |
| Python (control) | `onnxruntime` **1.29.0**, NumPy 2.5.2, Python 3.13 |
| Sidecar features | default + `candle-metal` (`scripts/sidecar-cargo-features.mjs`); `ort-coreml` is **not** shipped, so every session below is the CPU EP |

Both Python environments were created in a scratch directory with
`python3 -m venv` and are not part of the repo's dependencies.

## Load caveat

`uptime` reported 1-minute load averages between **25.2 and 50.2** during this
work; this is a shared machine running several lanes. Load does not affect any
correctness claim here — every cosine similarity between ONNX outputs is
deterministic and was reproduced across runs. It does affect the two latency
numbers in "Cost of the fix", which are therefore marked provisional; the
comparison between them was taken inside a single process, back to back.

## Summary

The finding this lane inherited (from
`artifacts/qa/voiceprint-calibration-2026-09-02.md`) was that CAM++ diverges
between the Rust and Python runtimes **on long inputs**. That framing is wrong
in the way that matters:

- It is not a long-input problem. It is a problem at **almost every** input
  length, including the 198-frame window the app feeds today.
- It is not a Rust-versus-Python problem. It is an **ONNX Runtime 1.28
  regression**, reproduced from Python on 1.29's optimizer and absent in both
  1.19.2 and 1.29.0's end-to-end result.
- It is not latent. Every CAM++ embedding this app has produced was computed by
  a corrupted graph. The error at 198 frames happens to be small (cosine 0.991
  against the correct answer), which is why nothing looked broken.

Fixed by building the CAM++ session with `GraphOptimizationLevel::Disable`,
which restores bit-level agreement at every length tested, for a measured 5%
inference cost on that one model.

## 1. Reproduction

`rust-sidecar/src/diarization/ort_parity.rs` (test-only, `#[ignore]`d) computes
fbank features with the app's **own** front end
(`embedder::compute_fbank_features`), dumps the input tensor and each model's
raw output as little-endian `f32`, and a Python script runs the identical bytes.
Nothing about feature extraction can differ between the two runtimes because
both consume the same file.

```
PLAINSONG_ORT_PARITY_MODELS=<staged models> \
PLAINSONG_ORT_PARITY_WAV=<16 kHz mono wav> \
PLAINSONG_ORT_PARITY_OUT=<dump dir> \
PLAINSONG_ORT_PARITY_FRAMES=100,198,200,... \
node scripts/cargo-sidecar.mjs test --locked --lib ort_parity -- --ignored --nocapture
```

Fixture: one macOS `say -v Samantha` utterance, 8.28 s, converted with
`afconvert -f WAVE -d LEI16@16000 -c 1`, giving 826 frames — enough to slice any
length up to 826 without re-synthesizing.

Model files were the four pinned in `rust-sidecar/src/download/mod.rs`, staged
outside the repo and **verified against the pinned SHA-256 before use**:

```
1068e4ac3a76bb9c769e6816ef30bf89363f6e966f1d938210cb8ed4038f8e93  campplus_speaker.onnx
d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0  ecapa_tdnn_speaker.onnx
7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068  resnet34_speaker.onnx
be6b162137d8b08854268a97763c007e49882f221e02950242923d40d2be157e  eres2netv2_speaker.onnx
```

### Cosine(Rust ORT 1.28, Python onnxruntime 1.19.2) on a byte-identical tensor

`GraphOptimizationLevel::Disable` — all four models, every length 96–826:
**1.000000 everywhere.**

`Level1`, `Level2` and `Level3` are identical to each other and differ only for
CAM++:

| frames | ECAPA-TDNN | **CAM++** | ResNet34 | ERes2NetV2 |
|---|---|---|---|---|
| 96 | 1.000000 | **0.065452** | 1.000000 | 1.000000 |
| 100 | 1.000000 | **0.062326** | 1.000000 | 1.000000 |
| 148 | 1.000000 | **0.113424** | 1.000000 | 1.000000 |
| 150 | 1.000000 | **0.152309** | 1.000000 | 1.000000 |
| **198** (what the app feeds) | 1.000000 | **0.990960** | 1.000000 | 1.000000 |
| 199 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| 200 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| 201 | 1.000000 | **0.121590** | 1.000000 | 1.000000 |
| 220 | 1.000000 | **0.175013** | 1.000000 | 1.000000 |
| 250 | 1.000000 | **0.211674** | 1.000000 | 1.000000 |
| 300 | 1.000000 | **0.094283** | 1.000000 | 1.000000 |
| 350 | 1.000000 | **0.256664** | 1.000000 | 1.000000 |
| 400 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| 401 | 1.000000 | **0.149176** | 1.000000 | 1.000000 |
| 500 | 1.000000 | **0.061638** | 1.000000 | 1.000000 |
| 600 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| 700 | 1.000000 | **0.161332** | 1.000000 | 1.000000 |
| 800 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| 826 | 1.000000 | **0.246149** | 1.000000 | 1.000000 |

### It is not a cliff, and it is not about length

A sweep of every even length from 96 to 420 (163 lengths) found **160
diverging** and 3 agreeing: 200, 398 and 400. Widening the sweep to 826 frames
gives the exact rule — agreement iff

```
ceil(T / 2) mod 100 == 0
```

which holds at T ∈ {199, 200, 399, 400, 599, 600, 799, 800} and nowhere else.
398 and 396 were near-misses (0.9992, 0.9966), not exceptions.

The app's own segmentation is `generate_segments(duration, 2.0, 1.0)`, so every
full window is 2.0 s = 32000 samples, and
`(32000 - 400) / 160 + 1 = **198** frames`, not 200. `ceil(198/2) = 99`. The
app has been on the wrong side of this rule the entire time. It got away with it
because 99 is one short of 100, so only a single pooling window is affected and
the error is small; at 201 or 300 frames the same defect costs everything.

## 2. Diagnosis

### Where it lives

`campplus.onnx` is the only one of the four with any `Pad` or `AveragePool`:

| model | opset | producer | nodes | Pad | AveragePool | Slice | Expand |
|---|---|---|---|---|---|---|---|
| **campplus_speaker** | 14 | pytorch 1.12.1 | 3207 | **52** | **52** | **52** | **52** |
| ecapa_tdnn_speaker | 14 | pytorch 1.12.1 | 185 | 0 | 0 | 0 | 2 |
| resnet34_speaker | 14 | pytorch 1.10 | 110 | 0 | 0 | 0 | 0 |
| eres2netv2_speaker | 13 | onnx.quantize 0.1.0 | 663 | 0 | 0 | 0 | 0 |

All 52 `AveragePool` nodes are identical:
`kernel_shape=[100]`, `strides=[100]`, `pads=[0,0]`, **`ceil_mode=1`** — the
CAM (context-aware masking) segment pooling, `seg_len=100`. All 52 `Pad` nodes
are `mode=constant` with a `pads` constant of **`(0,0,0,0,0,0)`**: they are
literal no-ops that the PyTorch 1.12 exporter emitted.

### What ORT 1.28 does to it

Serializing the post-optimization graph (`with_optimized_model_path`) and
diffing op histograms against the original:

| Rust session | nodes | Pad | AveragePool attributes |
|---|---|---|---|
| `Disable` | 2412 | 52 | `ceil_mode=1, kernel=[100], strides=[100]` (no `count_include_pad`) |
| `Level1` | 1789 | **0** | `ceil_mode=1, …, ` **`count_include_pad=1`** |
| `Level3` | 1625 | **0** | `ceil_mode=1, …, ` **`count_include_pad=1`** |

Python `onnxruntime` 1.19.2 removes the same 52 `Pad` nodes at Level1 and
Level3 but leaves **`count_include_pad=0`**.

Absorbing a pad of zero must not change that flag. With `ceil_mode=1` the flag
does double duty: it also decides whether the padding the *ceiling* introduces
for the final, partial window lands in that window's denominator. Flipping it
therefore changes the arithmetic of exactly one window — which is why the error
is invisible when the pooled length divides by 100 (there is no partial window),
tiny at 198 frames (the single window is 99/100 full), and catastrophic at 300
frames (the second window is 50/100 full).

### Rewrite or kernel? Both halves, and they only line up in 1.28

Replaying the graph ORT 1.28 serialized (the one with `count_include_pad=1`)
under Python with optimization **off**, at T=300:

| | vs correct answer | vs Rust Level3 output |
|---|---|---|
| onnxruntime **1.19.2** runs the rewritten graph | 0.09428254 | **1.00000000** |
| onnxruntime **1.29.0** runs the rewritten graph | **1.00000000** | 0.09428278 |

And running the *original* graph at `ORT_ENABLE_ALL`:

| | vs correct answer |
|---|---|
| onnxruntime 1.19.2 | 1.00000000 |
| onnxruntime 1.29.0 | 1.00000000 |

So there are two independent behaviours:

1. **The rewrite.** 1.19.2 does not produce `count_include_pad=1`; 1.28 and 1.29
   do. (1.29's optimized graph shows `Pad=0, count_include_pad=1` for all 52
   pools, exactly like 1.28's.)
2. **The kernel.** 1.19.2's `AveragePool` counts the ceil-mode padding when
   `count_include_pad=1`; 1.29's does not.

1.19.2 is safe because it never creates the flag. 1.29 is safe because it
handles the flag correctly. **1.28 — the build `ort` 2.0.0-rc.13 links — is the
one release where both halves line up**, and it is the one the app ships.

### The surgical fix does not exist

`optimization.disable_specified_optimizers` (`with_disabled_optimizers` in
`ort`) was the first thing tried, since disabling one transformer is cheaper
than disabling all of them. It does not work. With `PadFusion`, and with
`PadFusion,NopElimination`, `ConstantFolding`, and
`PadFusion,ConvAddFusion,ConvMulFusion`, the serialized graph still had
`Pad=0, count_include_pad=1` on all 52 pools and the output was bit-identical to
the unfiltered run — under ORT 1.28 (Rust) and 1.29 (Python) alike. The probe
keeps a `level3-nopadfusion` configuration so this dead end stays reproducible.

## 3. Fix

`diarization::embedding_window::graph_optimization_level_for` returns
`GraphOptimizationLevel::Disable` for `campplus_speaker` and `Level3` for
everything else; `embedder::load_embedding_session` applies it.

### Result

Cosine(Rust post-fix, Python `onnxruntime` 1.19.2 at `ORT_ENABLE_ALL`), all four
models at 96, 100, 148, 150, 198, 199, 200, 201, 220, 240, 250, 260, 280, 300,
350, 400, 401, 500, 600, 700, 800, 826 frames:

**1.000000 at every cell.**

### Cost of the fix

M4 Pro, release profile, 198 frames, 40 iterations after a warm-up, one process.
**Provisional** — load averages 25.2 (start) to 43.6 (end).

| model | session | build | infer p50 | infer p95 |
|---|---|---|---|---|
| CAM++ | `Level3` | 147.2 ms | 11.67 ms | 12.07 ms |
| CAM++ | **`Disable`** | **254.1 ms** | **12.30 ms** | **13.17 ms** |
| ECAPA-TDNN | `Level3` | 11.4 ms | 4.48 ms | 5.17 ms |
| ECAPA-TDNN | `Disable` | 37.6 ms | 4.56 ms | 5.39 ms |

+5.4% per inference and +107 ms once per session, on one model. The other three
keep `Level3`.

### Guard

Independently of the session option, `embedder::run_embedding_inference` now
refuses to hand a model more frames in one shot than were verified for it.
`verified_frame_window("campplus_speaker") == 220`; the other three are
uncapped. A longer input is split by `split_into_windows` into near-equal
consecutive windows, each embedded and L2-normalized, then averaged and
re-normalized — the same pooling the clusterer already does across segments —
with a `tracing::warn!` naming the model, the frame count and the cap.

This is inert today (198 < 220, verified by
`the_apps_own_two_second_window_is_not_split`). It exists so that a future
change to `generate_segments` cannot silently walk a model past what was
measured, and it survives an `ort` upgrade that renames or re-enables the
transformer.

### Tests

| test | what it proves |
|---|---|
| `embedding_window::tests::only_campplus_loses_graph_optimization` | the workaround is scoped to CAM++; the other three keep Level 3 |
| `embedding_window::tests::campplus_is_the_only_capped_model` | only CAM++ is capped |
| `embedding_window::tests::the_apps_own_two_second_window_is_not_split` | 198 and 220 frames pass through untouched — the guard does not change shipped behaviour |
| `embedding_window::tests::long_inputs_split_into_near_equal_windows` | 300→150+150, 221→111+110, 1000→5×200 |
| `embedding_window::tests::every_plan_covers_every_frame_exactly_once` | 3600 (frames, window) combinations: no gaps, no overlaps, no window over the cap |
| `embedding_window::tests::empty_input_produces_no_windows` | zero frames yields no plan rather than a zero-length run |
| `ort_parity::campplus_matches_the_agreeing_runtime` | **the regression guard**: a fixed 300-frame tensor through the app's real session path still matches a committed reference vector taken from onnxruntime 1.19.2 |

The regression guard is `#[ignore]`d and needs `PLAINSONG_ORT_PARITY_MODELS`,
because `campplus_speaker.onnx` is 29 MB and is downloaded at runtime — no build
of this crate has it, so it cannot run in CI. It hard-fails rather than skipping
when the staging directory is set but the file is missing. Its input tensor is
generated in code by a fixed LCG (`deterministic_fbank`) rather than committed;
a NumPy transcription of that loop was verified to produce **bit-identical**
bytes (max abs diff 0.0), and the reference vector it is checked against came
from Python `onnxruntime` 1.19.2 running the original graph on those bytes.

**Negative control.** With `graph_optimization_level_for` reverted to `Level3`
for CAM++, `campplus_matches_the_agreeing_runtime` fails with cosine
**-0.01811053**. It is a real guard, not a tautology.

## 4. What changes for users, and what this does not prove

CAM++ embeddings change. At the app's own 198-frame window the change is small —
old and new embeddings of the same utterance:

| fixture | cosine(pre-fix, post-fix) |
|---|---|
| samantha_1 | 0.9949 |
| daniel_1 | 0.9943 |
| fred_1 | 0.9712 |

and different-speaker separation is essentially unmoved (samantha/daniel
0.1405 → 0.1554, samantha/fred −0.0870 → −0.0846, daniel/fred 0.2340 → 0.2269).
Two consequences:

- **Stored CAM++ voiceprints keep working.** A profile enrolled by a pre-fix
  build is 0.97–0.99 similar to what a post-fix build computes for the same
  audio, far above the 0.57 accept threshold. No migration is needed.
- **The CAM++ thresholds in `voiceprint-calibration-2026-09-02.md` were
  calibrated against the corrupted embeddings** (accept 0.57, auto_apply 0.62).
  The shift is small and in the safe direction on these three fixtures, but the
  calibration should be re-run on the fixed embeddings before those numbers are
  treated as measured. That harness lives in lane C6 and was not re-run here.

Not proven here:

- **One synthetic utterance for the sweep.** The divergence is a property of the
  graph and the input length, not of the audio, and it reproduced on four
  separate fixtures; but every number above comes from macOS `say` voices.
- **No claim about ORT versions between 1.19.2 and 1.28**, or about 1.28 exactly
  — 1.28 was reached only through `ort` 2.0.0-rc.13, and no standalone 1.28
  Python wheel was tested. The bracketing is 1.19.2 (safe), 1.28 via Rust
  (broken), 1.29.0 (safe).
- **The other three models were checked for *agreement*, not for correctness.**
  They match between runtimes at every length; nothing here says their
  embeddings are good.
- **`ort-coreml` is not covered.** Every session measured is the CPU EP, which
  is what ships. A CoreML build partitions the graph differently and would need
  its own measurement.

## 5. Recommendation on CAM++

**Keep it, do not re-export, do not retire it.** The model file is fine — it
produces the correct answer under three of the four runtime/optimizer
combinations tested, including the unoptimized graph in the shipped runtime. The
defect is entirely in ORT 1.28's optimizer plus its `AveragePool` kernel, and
the app already controls that with one line.

Two follow-ups, neither blocking:

1. **When `ort` moves past the build that links ONNX Runtime 1.28**, re-run
   `ort_parity_dump` at `level3`. If 1.29's kernel fix is in, delete the
   `Disable` special case and take the 5% back. The regression guard will catch
   it either way.
2. **Re-run lane C6's CAM++ threshold calibration** on the fixed embeddings.
