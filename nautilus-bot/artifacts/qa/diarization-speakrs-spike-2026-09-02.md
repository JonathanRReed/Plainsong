# speakrs diarization spike (pyannote community-1)

Date: 2026-09-02 · Host: Apple M4 Pro (14 cores), macOS 27.0 (Darwin 27.0.0),
rustc 1.93.0, Apple clang 17.0.0 · Branch: `worktree-agent-ac5daa425b21e7a5b`
(cut from `main`, merged with `parity-waves`)

**Every latency number below was taken on a heavily loaded shared machine
(1-minute load average 54–108 on 14 cores). They are provisional and should be
read as upper bounds.** The accuracy numbers do not depend on machine load.
Raw turns, per-run load averages and scores: `artifacts/qa/diarization-speakrs/results-2026-09-02.json`.

## 1. Does it build? Yes — with one machine-level prerequisite

`speakrs` 0.5.0 is on crates.io (Apache-2.0), pinned in `rust-sidecar/Cargo.toml`
as an optional dependency behind the new `diarization-speakrs` feature, off by
default and **not** in the shipped feature list
(`scripts/sidecar-cargo-features.mjs`).

Dependency check against `Cargo.lock`, which the July research flagged as the
risk:

| speakrs needs | Plainsong has | Verdict |
|---|---|---|
| `ort ^2.0.0-rc.12` (feature `ndarray`) | `ort 2.0.0-rc.13` | Unified. **No second `ort` in the lock.** |
| `ndarray ^0.17.2` | `ndarray 0.17.2` | Unified, unchanged. |
| `ndarray-linalg 0.18.1` (a BLAS/LAPACK backend, mandatory) | — | New. This is the whole problem; see below. |

`speakrs = { version = "0.5.0", default-features = false, features = ["default-linalg"] }`.
`default-features = false` deliberately drops speakrs's `online` feature, which
pulls `hf-hub` and would fetch model weights outside Plainsong's pinned-hash
download manager.

### Build attempts, in order

**Attempt 1 — `default-linalg` (statically built OpenBLAS), first run: FAILED.**

```
cargo build --locked --features diarization-speakrs --bins
...
ld: -lto_library library filename must be 'libLTO.dylib'
clang: error: linker command failed with exit code 1
make[1]: *** [xscblat1] Error 1
make: *** [tests] Error 2
thread 'main' panicked at openblas-src-0.10.16/build.rs:248:13:
  OpenBLAS build failed: Subprocess returns with non-zero status: 2
```

Root cause, traced to the line:

1. OpenBLAS 0.3.32's `c_check` builds `CEXTRALIB` by scanning the compiler's
   link line for `-l*` tokens. Apple clang 17 emits `-lto_library <path>`; the
   `-l*` arm matches `-lto_library`, and the path argument that follows is
   dropped. `Makefile.conf` ends up with a bare
   `CEXTRALIB= -L/usr/local/lib -lto_library -lSystem …`, and Apple's `ld`
   rejects `-lto_library` unless the next token is literally `libLTO.dylib`.
2. OpenBLAS has a workaround for exactly this (`Makefile.system` line 445,
   clearing `CEXTRALIB` when the Xcode/CLT major version is ≥ 16), but it is
   gated on `pkgutil --pkg-info=com.apple.pkg.Xcode` /
   `com.apple.pkg.CLTools_Executables`. **This machine has neither receipt** —
   `pkgutil --pkgs` lists 65 packages and none of them is the Command Line
   Tools — so `XCVER` is empty, the guard's `[ -ge 16 ]` errors with
   `unary operator expected`, and the workaround never runs.
3. Only OpenBLAS's own CBLAS **test** binaries (`ctest/xscblat1` etc.) fail to
   link. `libopenblas.a` itself was built and contains LAPACK
   (`nm -g libopenblas.a | grep -c 'T _dsyev_'` → 2). `openblas-build` hardcodes
   `make all`, which includes `tests`, and offers no knob to skip it.

**Attempt 2 — same configuration with the receipt simulated: PASSED.**

Confirmed the diagnosis in isolation first:

```
make -C ctest all              # ld: -lto_library library filename must be 'libLTO.dylib' (×12)
make XCVER=17 -C ctest all     # every binary links, no errors
```

then end to end, with `MAKEFLAGS=XCVER=17` in the environment (GNU make treats
`MAKEFLAGS` contents as command-line variables, which override the makefile's
own `XCVER = $(shell pkgutil …)`), after deleting the stale `Makefile.conf`:

```
MAKEFLAGS=XCVER=17 cargo build --locked --features diarization-speakrs --bins
  Finished `dev` profile [optimized + debuginfo] target(s) in 3m 42s
```

**This is a machine defect, not a repo one.** On a Mac whose Command Line Tools
were installed through the normal installer, `pkgutil` has the receipt,
OpenBLAS's own workaround fires and the build is green with no environment
variable at all. `MAKEFLAGS=XCVER=17` is how this spike simulated that machine;
it is not proposed as a build convention. The permanent fix here is to
reinstall the Command Line Tools so the receipt exists.

Also worth knowing: `openblas-build` 0.10.16 returns early if a `Makefile.conf`
already exists in its out-dir, **without running `make`**. So on this machine a
second `cargo build` after the failed first one "succeeds" while the OpenBLAS
tests were never built. That is a false green in CI waiting to happen, and it
is why the build above was re-run from a cleared `Makefile.conf`.

**Attempts not made, and why.** speakrs offers no Accelerate backend, and
neither does `ndarray-linalg` 0.18.1 — its only backends are `openblas*`,
`netlib*` and `intel-mkl*` (crates.io index, verified). `intel-mkl` is refused
at compile time on this target by speakrs itself
(`src/linalg.rs`: `the 'intel-mkl' feature is only supported on x86_64 targets`),
and it would mean downloading an Intel MKL blob at build time through `ocipkg`.
`openblas-system` needs a Homebrew `libopenblas`, which is not installed and
could not be linked into a notarized `.app` anyway. Dropping the BLAS backend
entirely is refused by speakrs:
`speakrs requires a BLAS backend; enable default features or choose exactly one of 'intel-mkl', 'openblas-static', or 'openblas-system'`.
speakrs's `coreml` feature is orthogonal — it selects the inference backend and
does not remove the linalg requirement.

### Cost to `Cargo.lock`

Enabling the feature added **55 packages**, including a second `sha2` (0.10
alongside our 0.11), a second `zip` (6.0 alongside 8.6), a second `ureq`, a
second `rand`/`rand_chacha`, plus `ocipkg`, `oci-spec`, `tar`, `xattr`,
`filetime` and `intel-mkl-tool` — the last group pulled in because `Cargo.lock`
records every optional dependency of `ndarray-linalg` regardless of target.
`cargo audit` (`gate:release:rust-dependencies`) and the third-party notices
both read the lock, so this footprint is paid even though nothing ships.
`Cargo.lock` is `--locked`-clean for both feature sets.

The audit cost turned out to be nil, which is worth recording because it was
the specific thing to fear: `cargo audit --no-fetch` reports **0
vulnerabilities** on the expanded lock and exactly the same two warnings as the
lock at the merge base `060c27aa` (`paste 1.0.15` unmaintained,
RUSTSEC-2024-0436; `chacha20 0.10.0` yanked). The 55 new packages add no
advisory. The third-party notices are unaffected because
`generate-third-party-notices.mjs` runs `cargo metadata` with the shipped
feature set, which does not include `diarization-speakrs`.

## 2. What was implemented

- `rust-sidecar/src/diarization/speakrs_backend.rs` — the backend, behind
  `#[cfg(feature = "diarization-speakrs")]`. Loads audio through the existing
  `audio::utils::load_audio_file` (16 kHz mono f32), runs
  `OwnedDiarizationPipeline::from_dir(dir, ExecutionMode::Cpu)`, and maps
  speakrs turns onto `run_diarization_with_model`'s contract.
- `normalize_turns` / `uncovered_spans` are pure functions with unit tests:
  clamping, merging same-speaker turns across a ≤ 0.3 s breath gap, never
  merging across an interleaved speaker, dropping < 0.2 s flickers **after**
  merging, and assigning `S1..Sn` by first appearance **among survivors** — a
  bug the first draft had, where a discarded 50 ms flicker at the head of a
  recording renamed the only real speaker to `S2`.
- Uncovered spans stay uncovered. Nothing is stretched across a gap and no
  placeholder turn is emitted, so `merge_with_transcript` renders those spans
  as `speaker_id: None` — which is how the rest of the app already represents
  "unattributed". Test: `leaves_uncovered_audio_unattributed_instead_of_defaulting_to_s1`.
- Model bundle in the pinned-hash download manager (`download/mod.rs`): ten
  files, each pinned to the immutable revision
  `a785ebdbe6313868088c36c93d9efa71c470bd34` of `avencera/speakrs-models`, with
  SHA-256, size bounds and the same integrity receipts as every other model.
  Each hash was verified by downloading the file and hashing it locally, and
  each matches the LFS object id the Hugging Face tree API reports.
  All-or-nothing readiness: a partial bundle reads as not installed.
- Picker entry, compiled in only with the feature, labelled
  "pyannote community-1 (experimental)"; the default ECAPA-TDNN option stays
  first. Tests assert the default build does **not** list it and that the copy
  claims no accuracy it cannot back.
- Fixed in passing: the automatic post-meeting diarization pass hardcoded
  ECAPA-TDNN and ignored the model the user picked in Settings. It now runs the
  selected model, and asks readiness per model.

## 3. Licensing — the brief's premise was wrong, and it matters

The brief said "pyannote community-1 weights are MIT per the HF card". Verified
against the Hugging Face API:

| Repo | License | Gated |
|---|---|---|
| `avencera/speakrs-models` (what speakrs actually downloads) | **none declared** | no |
| `pyannote/speaker-diarization-community-1` (upstream pipeline) | **CC-BY-4.0** | yes (`auto`) |
| `pyannote/segmentation-3.0` (the segmentation component) | MIT | yes (`auto`) |
| `pyannote/wespeaker-voxceleb-resnet34-LM` (the embedder) | CC-BY-4.0 | no |

MIT is the *segmentation component's* licence, not community-1's. The
redistribution repo Plainsong would fetch from grants nothing itself and says
"users are responsible for complying with the licenses and terms of the
upstream models" — while the upstream pipeline is gated behind accepting
conditions that a Plainsong user would never see. Shipping this as a default
needs a licensing decision (CC-BY attribution in THIRD-PARTY-NOTICES at
minimum), not just an engineering one.

## 4. Evaluation

`scripts/fixtures/` holds only single-speaker audio, so two-speaker fixtures
were synthesised by `scripts/make-diarization-eval-fixture.mjs`: the existing
`real-speech-44s.wav` is speaker A, an ffmpeg pitch/formant-shifted copy
(`asetrate` + `atempo`, ≈ −3.4 semitones) is speaker B, and turns alternate on a
fixed grid, which makes the ground truth exact. Scored by
`scripts/score-diarization-eval.mjs` at 10 ms frames with an optimal 1:1
speaker mapping and a 0 ms collar.

**The first fixture set was biased and the bias reversed the result.** A 6 s
turn grid is an exact multiple of the embedding backend's 1 s window hop, so
its boundaries land on the reference boundaries for free. A second set at 5.3 s
turns removes that.

| Fixture | Backend | Frame error | Boundaries ≤0.5 s | Mean bdy err | Unattributed | Wall (loaded) | Peak RSS |
|---|---|---|---|---|---|---|---|
| 44 s, 6 s grid | embedding ECAPA | **4.6 %** | 6/7 | 0.14 s | 1.0 s | 0.56 s (78× RT) | 106 MB |
| 44 s, 6 s grid | speakrs | 5.7 % | 4/7 | 0.35 s | 0.03 s | 7.9 s (5.6× RT) | 251 MB |
| 300 s, 6 s grid | embedding ECAPA | **0.0 %** | 49/49 | 0.00 s | 0 s | 6.1 s (49× RT) | 122 MB |
| 300 s, 6 s grid | speakrs | 7.1 % | 32/49 | 0.43 s | 0.03 s | 69.4 s (4.3× RT) | 262 MB |
| 44 s, 5.3 s off-grid | embedding ECAPA | 11.4 % | 8/8 | 0.28 s | 2.0 s | 0.63 s (70× RT) | 106 MB |
| 44 s, 5.3 s off-grid | speakrs | **10.3 %** | 6/8 | 0.56 s | 0.03 s | 6.8 s (6.5× RT) | 250 MB |
| 300 s, 5.3 s off-grid | embedding ECAPA | 10.8 % | 55/56 | 0.26 s | 3.0 s | 5.5 s (55× RT) | 121 MB |
| 300 s, 5.3 s off-grid | speakrs | **7.5 %** | 39/56 | 0.39 s | 0.25 s | 53.2 s (5.6× RT) | 252 MB |

Both backends found exactly 2 speakers on all four fixtures and never mixed
them up: the optimal mapping was a clean bijection every time, and neither
backend ever attributed a turn to a third speaker.

Read this carefully:

- **The 0.0 % row is the fixture, not the pipeline.** Once the grid alignment
  is removed, the embedding backend goes from 0.0 % to 10.8 % on the same
  audio, and speakrs beats it (7.5 %).
- **"Boundaries within 0.5 s" flatters the embedding backend for the same
  reason.** It snaps every boundary to a 1 s grid, so its error can never
  exceed 0.5 s by construction. Its mean boundary error is genuinely lower;
  its *worst* case is bounded by the grid, not by accuracy.
- **These are not DERs.** Two speakers, no overlapped speech at all, both
  voices derived from one recording (shared prosody and phonetics, an easier
  separation problem than two real people), clean studio audio. Overlap
  handling is the main thing the pyannote pipeline exists for and this fixture
  cannot test it. speakrs's published 7.1 % on VoxConverse dev is a different
  measurement; nothing here confirms or refutes it.
- **Latency ratios are more trustworthy than the absolute numbers**, since both
  backends ran under comparable load: speakrs is **10–14× slower** and uses
  **~2.1× the peak RSS**. The crate's headline 529× realtime is its CoreML
  path, not the CPU path measured here.
- speakrs leaves almost nothing unattributed (0.03–0.25 s per file) where the
  embedding backend leaves 1–3 s, mostly at the tail.
- Noted in passing: the embedding backend reports 2 speakers but labels them
  `S1` and `S3` on three of the four fixtures — its ids come from raw cluster
  indices with no compaction. Pre-existing, not touched here.

## 5. Recommendation: **keep optional; do not make it the default; revisit for CoreML**

Reasons, in order of weight:

1. **The build is not reproducible enough to ship.** A statically compiled
   OpenBLAS in the dependency graph means every developer and CI runner builds
   a Fortran-less LAPACK from source, and a machine-state difference invisible
   to `cargo` (a missing `pkgutil` receipt) turns that into a hard failure with
   an error message that names neither speakrs nor Plainsong. `openblas-build`
   silently short-circuiting on a stale `Makefile.conf` makes it worse. This is
   the blocker, and it is upstream of the accuracy question.
2. **The accuracy case is not yet made.** speakrs is better than the current
   pipeline on the unbiased fixtures (7.5 % vs 10.8 % on 5 min), which is
   encouraging and consistent with its published DER, but a 2-speaker
   non-overlapping synthetic fixture cannot justify replacing a shipped
   default. The measurement that would justify it is overlapped, multi-speaker,
   real meeting audio — which Plainsong deliberately has none of.
3. **The cost is real and known.** 10–14× slower and 2.1× the memory on the CPU
   path, ~60 MB of extra model downloads across ten files, +55 crates in the
   lock (no new advisories, but a much larger surface to keep current), and an
   unresolved CC-BY-4.0 / undeclared-license question on the weights.
4. **The upside is real too.** Overlap handling, near-zero unattributed audio,
   and the whole pyannote pipeline for roughly 400 lines of glue. The CoreML
   path is where the speed claim lives and it is the version worth re-measuring.

What would change the recommendation, cheapest first: speakrs offering a
pure-Rust or Accelerate linalg path (removing the OpenBLAS build entirely);
then a measurement on real overlapped meeting audio; then the CoreML backend,
which needs the `coreml` Cargo feature plus roughly 60 more model files
(`.mlmodelc` bundles per batch size), each needing its own pinned hash and
integrity receipt — a much bigger download-manager change than the ten CPU
files added here.

### For C6 (opt-in voiceprints)

speakrs exposes what C6 needs. `DiarizationResult` has public
`embeddings: ChunkEmbeddings` (the WeSpeaker ResNet34 embeddings the pipeline
extracted) alongside `hard_clusters` and `discrete_diarization`, so a voiceprint
could be built from the same vectors the clustering used rather than
re-embedding the audio. Three caveats:

- They are **256-dimensional WeSpeaker ResNet34** vectors (confirmed from the
  bundle: `plda_lda.npy` has shape `(256, 128)`), from a different model family
  than any embedder the app ships today. Voiceprints enrolled under one backend
  cannot be matched under the other, so switching backends would invalidate
  stored voiceprints — C6 has to store which backend produced each one.
- They are per *chunk-speaker pair*, not per turn, so C6 would have to pool
  them itself before storing a voiceprint.
- `ChunkEmbeddings` is `pipeline::types::data`'s own type on a crate at 0.5.0
  with no stability promise.

If C6 is meant to work with the shipped default, it should take embeddings from
the existing `SpeakerEmbeddingExtractor` and treat speakrs as a second,
incompatible source rather than a drop-in.

## Reproducing

```sh
cd nautilus-bot
export CARGO_TARGET_DIR=.../rust-sidecar/target
node scripts/make-diarization-eval-fixture.mjs
node scripts/make-diarization-eval-fixture.mjs --turn-seconds 5.3 --label two-speaker-offgrid

# Machines without a com.apple.pkg.CLTools_Executables receipt also need
# MAKEFLAGS=XCVER=17; see §1.
export PLAINSONG_DATA_DIR=/tmp/plainsong-diar-eval
export PLAINSONG_DIAR_EVAL_AUDIO=$PWD/artifacts/qa/diarization-speakrs/two-speaker-offgrid-300s.wav
node scripts/cargo-sidecar.mjs test --locked --lib --features diarization-speakrs \
  diarization::eval_tests::eval_speakrs_backend -- --ignored --nocapture | grep '^DIAR-EVAL' > speakrs.txt
node scripts/cargo-sidecar.mjs test --locked --lib --features diarization-speakrs \
  diarization::eval_tests::eval_embedding_backend -- --ignored --nocapture | grep '^DIAR-EVAL' > embedding.txt
node scripts/score-diarization-eval.mjs \
  --ground-truth artifacts/qa/diarization-speakrs/two-speaker-offgrid-300s.ground-truth.json \
  --result speakrs.txt --result embedding.txt
```

The evaluation runs entirely under `PLAINSONG_DATA_DIR`, so it never touches
the user's real model directory or recordings.
