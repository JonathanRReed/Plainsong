# Cohere Transcribe 03-2026, run locally on ONNX Runtime

Lane C8, Part A. Measured 2026-09-03 06:07–06:12 UTC (late 2026-09-02 local).

`docs/model-inventory-2026-09.md` §5(b) called this "the single highest-value
local model work left", and §5(a) set the rule it had to clear to become more
than an experiment:

> **Cohere Transcribe 03-2026 (local, ONNX)** — replace the *model* if its
> measured Apple-Silicon latency on the 5 s fixture lands within ~1.5× of
> Parakeet's.

**It does not clear it. On a quiet machine it is 5.1× Parakeet on the 5.3 s
fixture and 7.3× on the 44 s fixture, so it ships as an experimental route and
Parakeet TDT 0.6B v3 stays the default.** The rest of this file is the
evidence.

---

## The quiet-machine run

Taken 2026-09-03 07:10 UTC, after the sibling lanes finished, at a 1-minute
load average of **26 falling to 22** on 14 cores. Three timed runs after a
warm-up, same binary and fixtures as everything below.

| Route | 5.3 s p50 | 5.3 s runs | 44 s p50 | 44 s runs | cold load | first inference |
|---|---|---|---|---|---|---|
| `parakeet` (shipped default) | **131 ms** | 139, 127, 131 | **1023 ms** | 986, 1023, 1036 | 870 ms | 140 ms |
| `cohere_local` | **673 ms** | 675, 672, 673 | **7462 ms** | 7282, 7462, 7790 | 2258 ms | 3692 ms |
| ratio | **5.14×** | | **7.29×** | | 2.6× | 26× |

Two things to take from this rather than from the loaded run below.

1. **The measurement is now tight.** Cohere's three runs span 3 ms and
   Parakeet's span 12 ms, against a 1150 ms spread on the loaded machine. These
   are the numbers to quote.
2. **Quiet made the ratio worse, not better.** 5.14× against 3.76× under load:
   Parakeet gains more from an idle machine than Cohere does, because Cohere's
   1.9B-parameter encoder is compute-bound in a way Parakeet's 0.6B one is not.
   Anyone hoping the loaded measurement was unfair to this route should read
   this row and stop hoping.

The 1.5× rule is missed by a factor of three. **Verdict: experimental,
non-default, not offered for meetings.**

---

## The loaded runs, kept for the comparison they support

**The machine was not quiet.** Every measurement here was taken on a shared
M4 Pro running four other parity lanes, at a 1-minute load average between
**115 and 147** on 14 logical cores. The load is recorded per run below. Two
consequences:

- The absolute numbers are upper bounds, not the model's speed.
- The *ratio* is the load-robust part, because Cohere and Parakeet were
  measured on the same machine within the same three minutes, at load averages
  that differed by less than 5.

The spread inside one configuration is larger than most effects anyone would
want to measure: four separate single-run measurements of the same 5.3 s
fixture came back at 1429, 1452, 1603 and 2579 ms. Anything below is a p50 of
three timed runs after a warm-up unless it says otherwise.

## What was measured

| | |
|---|---|
| Hardware | Apple M4 Pro, 14 logical CPUs, 24 GiB, macOS |
| Binary | `benchmark-latency`, release profile, `--features candle-metal` (`scripts/cargo-sidecar.mjs`) |
| Fixtures | `scripts/fixtures/local-quality-gate.wav` (5.32 s) and `scripts/fixtures/real-speech-44s.wav` (43.97 s) |
| Scope | `provider_transcription_only` — audio already in memory, no capture, no formatting, no insertion |
| Model | `onnx-community/cohere-transcribe-03-2026-ONNX` @ `31b1c6211c9000d76b077ddd23b74c9090badeba`, int4 encoder + int4 merged decoder |
| Command | `benchmark-latency --provider <p> --runs 3 --print-transcript` |

## Latency

Cohere run at load average 121.6 → 124.2; Parakeet at 120.7 → 118.9.

| Route | 5.3 s p50 | 5.3 s p95 | 5.3 s runs | 44 s p50 | 44 s p95 | 44 s runs |
|---|---|---|---|---|---|---|
| `parakeet` / parakeet-tdt-0.6b-v3 (shipped default) | **266 ms** | 324 ms | 324, 239, 266 | **1631 ms** | 1968 ms | 1621, 1968, 1631 |
| `cohere_local` / cohere-transcribe-03-2026-q4 | **1001 ms** | 1328 ms | 1328, 1001, 992 | **11 555 ms** | 13 002 ms | 13 002, 10 172, 11 555 |
| ratio | **3.76×** | 4.10× | | **7.08×** | 6.61× | |

Load cost, one-off per process: cold model preparation 3949 ms against
Parakeet's 2400 ms, and the first (untimed) inference 5608 ms against
Parakeet's 356 ms. The first inference is where ONNX Runtime pages in the
2.0 GiB weight file.

### The decision rule

The rule is ~1.5× on the 5 s fixture. Measured 3.76× here and 5.14× on the
quiet machine above. Even taking the most favourable reading anywhere in this
file — Cohere's best loaded run (992 ms) against Parakeet's worst (324 ms) —
the ratio is 3.06×. There is no reading of this data under which the rule is
met.

This section was written before the quiet re-run and predicted that a quiet
machine "would speed both routes up" without changing the verdict. It did, and
it moved the ratio the wrong way for this route. The prediction is left here
rather than tidied away.

## Memory

`/usr/bin/time -l` around one whole `benchmark-latency` process (so it includes
the harness, both fixtures and the model load, not the model alone):

| Route | max resident set size | peak memory footprint |
|---|---|---|
| `parakeet` | 1 614 200 832 B (1.50 GiB) | 2 097 286 288 B (1.95 GiB) |
| `cohere_local` | 2 464 317 440 B (2.29 GiB) | 1 447 431 480 B (1.35 GiB) |

The two columns invert between the routes and that is not a mistake: Cohere's
weights are memory-mapped from the 2.0 GiB `encoder_model_q4.onnx_data` file,
so they are clean file-backed pages — counted in RSS, evictable under pressure,
and excluded from macOS's "footprint". Read the RSS column as "how much of this
machine it will use if it can" and the footprint column as "how much it will
still need when the machine is short".

## Accuracy

There is no committed ground-truth transcript for either fixture, so this is a
**comparison against the shipped default**, not a WER. Both routes were given
the same two files in the same session.

On the 5.3 s fixture the two agree exactly:

> This is a Nautilus local quality gate sample with enough spoken words for
> verification.

On the 44 s fixture they differ in four places. Cohere is better in three of
them and the fourth is a sentence boundary:

| | Parakeet TDT v3 | Cohere Transcribe (local) |
|---|---|---|
| ~0:06 | "when you press a hot," | "when you press a hot button," |
| ~0:18 | "a commit message in your **journal**" | "a commit message in your **terminal**" |
| ~0:22 | "and **PlainSong** will adapt" | "and **Plainsong** will adapt" |
| ~0:36 | "The goal is simple, voice input everywhere, with no account… and no cloud in the middle. This recording exists…" | "The goal is simple voice input everywhere. With no account… and no cloud in the middle, this recording exists…" |

"terminal" is almost certainly the spoken word ("a commit message in your
terminal" is the only reading that makes sense), "Plainsong" is the product's
own spelling, and Parakeet's "press a hot," drops a word outright. That is
consistent with the leaderboard ordering (5.42% against 6.32%) but it is four
differences on one 44-second file, which is an anecdote, not a rate. **Nothing
in this repo has measured this model's WER, and the route's `model_info` quotes
the upstream leaderboard figure as an upstream figure.**

Languages: English only, on these two fixtures. The other 13 the processor
accepts are an upstream list this build has never exercised, which is what
`asr-capabilities.ts` records as `basis: "upstream_listed"`.

## What the route claims, and why

- **"Experimental, 14 languages, high accuracy, slower."** All four hold above.
- **No language detection.** The decoder prompt carries the language tag twice
  (`CohereAsrProcessor.get_decoder_prompt_ids`), so there is no auto path. A
  request with no language selected is transcribed as English and the route
  copy says so; a request for a language outside the 14 is refused by name
  rather than silently decoded as English.
- **CPU only.** `ort` links ONNX Runtime's CPU provider, and CoreML is not
  registered for either graph: the encoder is int4 (`MatMulNBits`, which CoreML
  does not implement) and the decoder is a merged graph whose control flow
  CoreML rejects — the same two reasons the Qwen3 decoders bypass it
  (`scripts/sidecar-cargo-features.mjs`). There is no Metal path here at all.
- **Not offered for meetings.** The prompt carries `<|notimestamp|>`, so the
  token stream has no time anchors. `apportioned_segments` cuts sentences and
  spreads the clip's duration across them by character count, which is enough
  to read and not enough to seek or to align a diarizer against. `cohere_local`
  is deliberately absent from `MEETING_GRADE_PROVIDER_SET` and from
  `meeting_provider_is_supported_with`.

## Provenance and integrity

- **Export license.** `onnx-community/cohere-transcribe-03-2026-ONNX` declares
  `license: apache-2.0` in its own card metadata, not only by inheritance from
  `CohereLabs/cohere-transcribe-03-2026` (also Apache-2.0). Both were read from
  the HuggingFace API on 2026-09-02. `MODEL_WEIGHTS` in
  `scripts/model-weights-manifest.mjs` records the export repo, and
  `THIRD-PARTY-NOTICES.txt` was regenerated (20 model artifacts).
- **Revision.** Pinned to the commit `31b1c621…`, not to `main`.
- **Digests.** All eight files carry a pinned SHA-256 in
  `cohere_local_repo_files()`. The four large ones are HuggingFace's published
  `lfs.sha256`; the four small ones were hashed locally. Every one was verified
  against the downloaded bytes.
- **Receipts.** `is_available` requires an integrity receipt per file, not
  plausible bytes — `readiness_requires_integrity_receipts_not_just_plausible_files`
  writes eight files of the right shape and asserts the route still refuses
  them.

### Why int4 and not int8

The export publishes fp32, fp16, int8 (`_quantized`) and int4 (`_q4`, `_q4f16`)
variants. Encoder sizes, from the HuggingFace API:

| variant | encoder | decoder | total bundle |
|---|---|---|---|
| fp32 | 7.59 GiB | 676 MB | ~8.2 GiB |
| int8 (`_quantized`) | 2.87 GiB | 196 MB | ~3.07 GiB |
| **int4 (`_q4`)** | **2.02 GiB** | **109 MB** | **2.03 GiB** |
| int4/fp16 (`_q4f16`) | 1.44 GiB | 98 MB | 1.54 GiB |

`_q4` was chosen over the smaller `_q4f16` because fp16 activations have no
fast path on the CPU provider, and over `_quantized` because int8 is 1 GiB
larger for a model that is already the largest download in the app. This is the
same reasoning that put Qwen3-ASR on int4 decoders.

## Divergences from the reference front end, stated

`compute_input_features` is a port of `CohereAsrFeatureExtractor` (pre-emphasis
0.97 → centered STFT, symmetric 400-sample Hann zero-padded to 512, constant
padding → power spectrum → Slaney mel, 128 bins, 0–8 kHz → `log(x + 2^-24)` →
per-bin mean and *sample* variance over the valid frames, trailing pad frame
zeroed). One deliberate difference:

- **Dither is not applied.** The reference adds `1e-5 * randn` seeded from the
  clip length through torch's own generator. Nothing outside torch reproduces
  that stream, and at 1e-5 it is 100 dB below full scale; omitting it is a
  smaller divergence than substituting a different noise stream would be.

The port was not compared against a Python reference tensor — there is no
Python in this repo's toolchain — so its evidence is end-to-end: the model
returns the exactly-correct transcript for the 5.3 s fixture and a coherent one
for the 44 s fixture, which a materially wrong mel front end does not do.

## Tests

In `rust-sidecar/src/asr/cohere_local.rs`:

- `the_pinned_bundle_is_eight_files_at_one_immutable_revision`
- `the_onnx_data_files_keep_the_names_their_graphs_record`
- `language_resolution_accepts_the_fourteen_and_refuses_the_rest`
- `an_unset_language_is_english_and_an_unsupported_one_is_an_error`
- `the_decoder_prompt_is_the_processors_ten_tokens_and_claims_no_timestamps`
- `preemphasis_keeps_the_first_sample_and_filters_the_rest`
- `frame_counts_match_the_reference_masking`
- `short_audio_is_one_chunk_and_long_audio_cuts_at_the_quiet_point`
- `chunk_texts_join_the_way_the_processor_joins_them`
- `sentence_segments_cover_the_clip_and_stay_ordered`
- `the_token_cap_and_budget_scale_with_audio_and_stay_bounded`
- `decode_control_stops_on_cancel_and_on_deadline`
- `a_decode_that_ran_out_of_room_is_an_error_not_a_prefix`
- `dropping_the_cancel_guard_flags_the_decode`
- `the_stft_window_is_a_symmetric_hann_centered_in_the_fft_buffer`
- `readiness_requires_integrity_receipts_not_just_plausible_files`
- `a_missing_artifact_is_named_in_the_diagnostics`

## What is still owed

- A real WER, on a corpus with ground truth, before anyone repeats the
  leaderboard's 5.42% as a Plainsong measurement.
- Any of the other 13 languages, exercised even once.
