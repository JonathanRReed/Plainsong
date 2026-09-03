# Acceleration receipt: `candle-metal` and `ort-coreml` in the macOS sidecar (2026-09-01)

Parity program item A1. Question: the release sidecar was built with
`cargo build --locked --release --bin plainsong-sidecar` and no `--features`,
so the opt-in Cargo features `candle-metal` (Candle Metal backend for
Whisper large-v3-turbo / Distil-Whisper) and `ort-coreml` (ONNX Runtime CoreML
execution provider for Silero VAD, diarization embedders, Moonshine, the Qwen3
encoder) never shipped. Compile them, measure them, decide per feature.

## Decision

| Feature | Decision | Why (measured, this machine) |
| --- | --- | --- |
| `candle-metal` | **Ship on macOS** | Distil-Whisper distil-large-v3.5, measured with the combined `candle-metal,ort-coreml` dev binary on a loaded shared machine: 5.3 s utterance 32.8 s p50 on CPU F32 vs 0.96 s p50 on Metal; 44 s fixture 55.5 s vs 2.6 s. Two usable Metal processes (a third was paged out and is discarded); no fallback warnings in any. The as-shipped `candle-metal`-only binary was not re-measured (keychain prompt, see below); a quiet-machine re-run is owed. |
| `ort-coreml` | **Leave off** | Moonshine base regresses: ~24 s CoreML compile on first load (4.5 s on later launches vs 0.7 s CPU), encoder split into 75 CoreML partitions (393/743 nodes), decoder rejected outright (0/1 nodes: a single `If`), steady state slower and erratic (44 s fixture 1.7 s p50 CPU vs 2.1 s p50 / 5.6 s p95 CoreML). Silero VAD: CoreML supports 0/2 nodes, runs on CPU either way, ~6% per-chunk overhead with the EP registered. |

The list now lives in `scripts/sidecar-cargo-features.mjs`
(`MACOS_SIDECAR_CARGO_FEATURES = ["candle-metal"]`) and is consumed by
`scripts/build-rust-sidecar.mjs` (release binary), `scripts/cargo-sidecar.mjs`
(`lint:rust`, `test:rust`, `benchmark:latency`, and `.github/workflows/ci.yml`),
and `scripts/generate-third-party-notices.mjs` (`cargo metadata`), so the
benchmark bin, CI, the notices, and the shipped sidecar resolve the same
feature set on macOS. Non-Darwin hosts get no extra features. Cargo.toml's
`default` set is unchanged.

## Environment

- Hardware: Apple M4 Pro, 14 logical CPUs, 24 GB (25 769 803 776 bytes).
- OS: macOS 27.0 (build 26A5406e).
- Toolchain: rustc 1.93.0 (254b59607 2026-01-19), cargo 1.93.0.
- Crates: `ort`/`ort-sys` 2.0.0-rc.13 (pyke prebuilt ONNX Runtime, CoreML EP
  present: `CoreML::is_available()` returned true), `candle-core` 0.10.2,
  `whisper-rs` 0.16.0.
- Source: commit `daee45bc` (`main` == `parity-waves`) plus the uncommitted
  A1 working tree at build time (build/CI/test script changes, which do not
  affect the binaries, and a `tracing_subscriber::fmt()` init in
  `rust-sidecar/src/bin/benchmark-latency.rs` so provider log lines reach
  stderr; the committed version adds an `EnvFilter` default of
  `info,ort::logging=warn` that the measured binaries did not have).
- Machine state: **shared with other parity lanes running cargo builds and
  tests throughout.** 1-minute load average at each run start is recorded
  below (14 cores; anything above ~14 is oversubscribed). One Distil-Whisper
  run was taken while the machine had ~100 MB free / 15.5 GB wired and load
  81; it is reported and marked invalid, not averaged in.
- Data dir: every run used an isolated `PLAINSONG_DATA_DIR` under the session
  scratchpad, with the already-downloaded `whisper`, `distil_whisper`, and
  `parakeet` model directories symlinked from
  `~/Library/Application Support/Plainsong/models`. Nothing in the user's real
  data dir was touched.
- Fixtures (repo, sha256): `scripts/fixtures/local-quality-gate.wav` 5.32 s
  `3a3caf18…431dc`; `scripts/fixtures/real-speech-44s.wav` 43.97 s
  `bcece745…5af4` (same fixture as `artifacts/qa/dictation-latency.json`).

## Builds (all `--locked`, `MACOSX_DEPLOYMENT_TARGET=13.0`, shared `CARGO_TARGET_DIR`)

| Label | Command | Result |
| --- | --- | --- |
| features on | `cargo build --locked --release --features candle-metal,ort-coreml --bin plainsong-sidecar --bin benchmark-latency --manifest-path rust-sidecar/Cargo.toml` | Linked in 15 m 56 s (first full build with these features). `plainsong-sidecar` 38 996 656 B (vs 38 269 824 B for the previous default-feature binary), sha256 `f9995f98…24c5`; `benchmark-latency` (rebuilt 2 m 26 s later with the tracing init) sha256 `a3666bd0…ff61`. |
| features off | `cargo build --locked --release --bin benchmark-latency --manifest-path rust-sidecar/Cargo.toml` | 4 m 11 s (incremental). sha256 `18b4b927…ba2e`. Default features only (`asr-all`, `sqlcipher`, `whisper-gpu`), i.e. what shipped before A1. |
| as shipped | `node scripts/build-rust-sidecar.mjs` (now `--features candle-metal` on Darwin) then `node scripts/cargo-sidecar.mjs build --locked --release --bin benchmark-latency` | See "As-shipped verification" below. |

Sidecar launch check (features-on binary): started, printed `[sidecar] ready`
(285 ms on a warm launch; 19 s on the first launch, which included the
sidecar's own Parakeet prewarm), served `is_silero_vad_model_downloaded`,
`download_silero_vad_model`, and `download_asr_models` over stdio JSON-RPC,
and exited with code 0 on `shutdown`. Driver: a 100-line node harness kept in
the session scratchpad (not committed).

Downloads, all through the sidecar's own pinned-hash download code
(`download::DownloadManager`, `.plainsong-integrity` receipts written), 357 MB
total:

- Silero VAD `silero_vad.onnx` 2.3 MB, sha256 `1a153a22…88e3` (matches the
  pinned hash in `docs/model-inventory-upgrades.md`).
- Moonshine tiny 111 MB (`onnx/merged/tiny/float/*` + tokenizer).
- Moonshine base 243 MB (`onnx/merged/base/float/*` + tokenizer), fetched
  because tiny cannot run (see below).
- Whisper large-v3-turbo (1.6 GB) was **not** downloaded: the Candle path it
  uses (`whisper_candle::load_runtime` / `select_best_device`) is the one
  Distil-Whisper (already on disk) goes through, so that model stands in.

## Measurements

Benchmark: `benchmark-latency --provider <p> --model <m> --runs 5` (3 runs for
the Candle-on-CPU case) run from `nautilus-bot/` with `--out`/`--out-e2e`
pointed at the scratchpad. `cold prep` is `coldModelPreparationMs`
(`prewarm()`: integrity re-verification + session/model load, first process
includes any one-time compile); `warmup` is the first real inference; the
percentiles are `transcriptionMsP50/P95` for the 5.3 s fixture and the
`secondaryLongForm.stageBreakdownMs.asr` percentiles for the 44 s fixture.
All times in milliseconds.

### (a) whisper.cpp `base.en` (regression check; Metal via `whisper-gpu` in both)

| Features | cold prep | warmup | 5.3 s p50 / p95 | 44 s p50 / p95 | load |
| --- | --- | --- | --- | --- | --- |
| off | 14 261 | 128 | 94 / 165 `[85, 94, 97, 165, 85]` | 502 / 526 `[501, 502, 504, 497, 526]` | 33 |
| on (`candle-metal,ort-coreml`) | 20 409 | 109 | 89 / 91 `[89, 91, 90, 89, 87]` | 506 / 517 `[517, 506, 504, 506, 504]` | 25 |
| reference: `artifacts/qa/dictation-latency.json` (2026-08-26, same fixture, quiet machine) | 184 | 536 | n/a | 498 / 508 | — |
| reference: Cargo.toml Metal baseline | — | — | 101 | 569 | — |

Neutral: whisper.cpp does not use either feature; both variants log
`whisper_backend_init_gpu: using Metal backend`. The 14–20 s cold prep in
both variants versus 184 ms in the August receipt is not a feature effect
(it appears with the features off too); it was taken at load 25–33 and is
flagged below for a quiet-machine re-run.

### (b) Moonshine (ONNX Runtime; `ort-coreml` on vs off)

`moonshine-tiny` **cannot be measured**: both binaries fail at warm-up with
`Moonshine decoder inference failed at step 0 ... Got invalid dimensions for
input: past_key_values.0.decoder.key`, preceded by `Unexpected Moonshine past
key tensor count: 24`. `moonshine.rs` hard-codes `MOONSHINE_NUM_LAYERS = 8`
(base); the tiny export has 6 layers (24 past-key tensors). Pre-existing
provider bug, unrelated to CoreML; not fixed here.

> **Correction (2026-09-03, parity item B12.3.)** The layer count was not the
> cause. The number of cache tensors was already derived from the decoder's own
> `past_key_values.*` input names, so a six-layer model already got six layers'
> worth; `MOONSHINE_NUM_LAYERS` only fed the warning quoted above. The failing
> dimension is index 3, the head dimension: Base is 8 heads x 52, Tiny is
> 8 x 36, and both were built at 52. With the head dimension read from the
> decoder's declared input shape, Tiny transcribes
> `scripts/fixtures/local-quality-gate.wav`; with it forced back to 52 the same
> message returns with `index: 3 Got: 52 Expected: 36`. Moonshine Tiny is
> therefore now benchmarkable, and the row above is owed a measurement.

`moonshine-base` (provider default), same binaries:

| Features | cold prep | warmup | 5.3 s p50 / p95 | 44 s p50 / p95 | load |
| --- | --- | --- | --- | --- | --- |
| off (CPU EP) | 701 | 213 | 164 / 944 `[944, 324, 94, 164, 103]` | 1 724 / 1 895 `[1814, 1724, 1895, 1682, 1482]` | 22 |
| on, first process (CoreML compile) | **24 292** | 992 | 230 / 250 `[250, 227, 233, 210, 230]` | **93 054 / 148 021** `[24112, 83361, 133463, 148021, 93054]` | 22 → 59 |
| on, second process | 4 494 | 369 | 218 / 2 827 `[218, 122, 120, 532, 2827]` | 2 088 / 5 644 `[5644, 2490, 2088, 1939, 1952]` | 48 |

Log lines with the feature on (both processes):

```
INFO plainsong_lib::ort_utils: Registering CoreML EP for .../moonshine/encoder_model.onnx
INFO ort::ep: Successfully registered `CoreMLExecutionProvider` source=session options
WARN ort::logging: CoreMLExecutionProvider::GetCapability, number of partitions supported by CoreML: 75 number of nodes in the graph: 743 number of nodes supported by CoreML: 301..393
INFO ort::logging: Writing CoreML Model to /var/folders/.../onnxruntime-....model.mlmodel   (x75, every session creation)
INFO plainsong_lib::ort_utils: Registering CoreML EP for .../moonshine/decoder_model_merged.onnx
INFO ort::logging: CoreMLExecutionProvider::GetCapability, number of partitions supported by CoreML: 0 number of nodes in the graph: 1 number of nodes supported by CoreML: 0
```

So the decoder (the autoregressive part) never leaves the CPU, the encoder is
chopped into 75 CoreML sub-models with a CPU round-trip at every boundary, and
those 75 sub-models are compiled again on every launch. The first-process 44 s
numbers were taken while the load average climbed from 22 to 59, so their
absolute size is inflated by contention, but the CPU run at load 22 was 50×
faster on the same fixture; the second-process numbers (still slower than CPU
at p50, 3× worse at p95) confirm the direction. `ort-coreml` is a regression
for Moonshine.

### (c) Silero VAD (ONNX Runtime; `ort-coreml` on vs off)

Measured with a temporary `#[ignore]` unit test appended to
`rust-sidecar/src/audio/silero_vad.rs` for the session (removed before
commit), built with `cargo test --locked [--features candle-metal,ort-coreml]
--lib` (the crate's `test` profile is `optimized + debuginfo`), streaming the
16 kHz fixtures through `SileroVadDetector::detect_speech_probability` in
512-sample chunks, 5 passes after one first-chunk call. Load 17–23.

| Fixture | Features | session load | first chunk | pass p50 / p95 | per-chunk p50 / p95 / max (µs) | speech fraction |
| --- | --- | --- | --- | --- | --- | --- |
| 44 s (1 373 chunks) | off | 43.7 ms | 0.90 ms | 111.7 / 114.8 ms | 77 / 102 / 428 | 0.918 |
| 44 s | on | 46.8 ms | 0.74 ms | 118.3 / 120.0 ms | 83 / 99 / 420 | 0.918 |
| 5.3 s (166 chunks) | off | 37.2 ms | 0.29 ms | 13.0 / 13.4 ms | 75 / 93 / 268 | 0.952 |
| 5.3 s | on | 37.6 ms | 0.31 ms | 14.5 / 15.0 ms | 83 / 107 / 291 | 0.952 |

With the feature on, ORT logs `Registering CoreML EP for .../vad/silero_vad.onnx`
followed by `number of partitions supported by CoreML: 0 number of nodes in
the graph: 2 number of nodes supported by CoreML: 0`: the model is an `If`
over the 8 kHz / 16 kHz subgraphs and the CoreML EP does not descend into
subgraphs by default, so the whole graph runs on the CPU EP in both builds.
Identical probabilities, ~6% more per-chunk time with the EP registered. No
gain; ~370–410× real time either way.

### (d) Candle: Distil-Whisper `distil-large-v3.5` (`candle-metal` on vs off)

| Features | cold prep | warmup | 5.3 s p50 / p95 | 44 s p50 / p95 | load |
| --- | --- | --- | --- | --- | --- |
| off (`Candle using CPU device`), 3 runs | 15 310 | 12 799 | **32 814 / 53 142** `[32814, 53142, 29814]` | **55 542 / 122 871** `[44858, 55542, 122871]` | 57 |
| on (`Candle using Metal GPU device`), first process | 10 809 | 59 392 | 1 220 / 12 436 `[12436, 1143, 1158, 1220, 1456]` | 3 530 / 4 018 `[4018, 3989, 3530, 3057, 2735]` | 32 → 48 |
| on, second process, **invalid** (100 MB free, 15.5 GB wired, load 81; max RSS 495 MB vs 2.3 GB, 47 s sys / 1 s user over 799 s wall: the process was paged out) | 71 627 | 121 308 | 67 766 / 118 762 | 43 435 / 77 049 | 81 |
| on, third process | 9 135 | 1 109 | **960 / 1 020** `[960, 882, 898, 989, 1020]` | **2 587 / 3 660** `[2368, 2220, 3660, 2645, 2587]` | 21 → 70 |

Transcripts identical on both devices (14 words, "This is a Nautilus local
quality gate sample with enough spoken words for verification."). The
first-process Metal warmup (59 s) is the one-time Metal shader compile for
the Candle kernels taken under load; the third process, with the shader cache
warm, needed 1.1 s. Metal wins by 21–34× at steady state. No Metal init
failures or CPU fallbacks were logged in any run.

## Commands (verbatim, from `nautilus-bot/`)

```
export CARGO_TARGET_DIR=/Users/jonathanreed/Downloads/Plainsong/nautilus-bot/rust-sidecar/target
export MACOSX_DEPLOYMENT_TARGET=13.0
cargo build --locked --release --features candle-metal,ort-coreml --bin plainsong-sidecar --bin benchmark-latency --manifest-path rust-sidecar/Cargo.toml
cargo build --locked --release --bin benchmark-latency --manifest-path rust-sidecar/Cargo.toml
# downloads: stdio JSON-RPC to the features-on plainsong-sidecar with PLAINSONG_DATA_DIR=<scratch>
#   {"method":"download_silero_vad_model","params":{}}
#   {"method":"download_asr_models","params":{"providerType":"moonshine","modelId":"moonshine-tiny"}}
#   {"method":"download_asr_models","params":{"providerType":"moonshine","modelId":"moonshine-base"}}
# each measurement (VARIANT in on|off, binaries copied out of target/ after each build):
PLAINSONG_DATA_DIR=<scratch>/data <bin-VARIANT>/benchmark-latency --provider whisper --model base.en --runs 5 --out <scratch>/results/... --out-e2e <scratch>/results/...
PLAINSONG_DATA_DIR=<scratch>/data <bin-VARIANT>/benchmark-latency --provider moonshine --model moonshine-tiny --runs 5 ...   # fails, see (b)
PLAINSONG_DATA_DIR=<scratch>/data <bin-VARIANT>/benchmark-latency --provider moonshine --model moonshine-base --runs 5 ...
PLAINSONG_DATA_DIR=<scratch>/data <bin-VARIANT>/benchmark-latency --provider distil_whisper --model distil-large-v3.5 --runs 5 ...   # 3 runs for off
A1_SILERO_MODEL=<scratch>/data/Plainsong/models/vad/silero_vad.onnx A1_WAV=<abs fixture> A1_PASSES=5 \
  cargo test --locked [--features candle-metal,ort-coreml] --manifest-path rust-sidecar/Cargo.toml --lib a1_silero_vad_timing -- --ignored --nocapture
```

## As-shipped verification

`node scripts/build-rust-sidecar.mjs` (the release pipeline's step, now
`cargo build --locked --release --manifest-path rust-sidecar/Cargo.toml
--features candle-metal --bin plainsong-sidecar` on Darwin) linked in
26 m 33 s at load 17–48 (the shared target dir had to rebuild the dependency
graph for the third distinct feature set of the session). Result:
`plainsong-sidecar` 38 996 624 B, sha256 `ba2a87cc…f2a`. The script's two
post-build audits look for the binary in the worktree-local
`rust-sidecar/target/release/` rather than `CARGO_TARGET_DIR`, so they were
re-run by hand against a copy placed there:

- `scripts/verify-macos-system-audio.mjs`: `{"pass":true,"sourceOnly":false,
  "minimumSystemVersion":"13.0","processTapImports":"dynamic-only"}`
- `scripts/verify-macos-speech-helper.mjs`: `{"pass":true,"sourceOnly":false,
  "deploymentTarget":"13.0","architecture":"arm64", ...}`

Launch check: against a fresh, empty `PLAINSONG_DATA_DIR` the as-shipped
binary printed `[sidecar] ready` after 162 ms, answered
`is_silero_vad_model_downloaded` (`false`), and exited 0 on `shutdown`
173 ms after launch. Against the model-populated scratch data dir it stopped
after `Re-verifying integrity receipts for 45 local model artifact(s)` with
0% CPU (three attempts, up to 26 min), and `pgrep SecurityAgent` showed a
macOS keychain prompt alive since the first attempt: the receipts are HMAC'd
with a key kept in the login keychain (`download::model_integrity_mac_key`
→ `secrets::get_internal_secret` → `keyring`), and a freshly built,
ad-hoc-signed sidecar reading that item blocks on the "wants to use your
confidential information" dialog until a human clicks. The features-on binary
launched against the same populated dir in 733 ms in the same minute, so this
is a per-binary keychain ACL prompt for unsigned dev builds on this machine
(the Developer ID-signed release build carries a stable designated
requirement), not a `candle-metal` effect. The prompt was left for the
machine's owner to dismiss; nothing was clicked by the agent.

Re-measurement with the as-shipped feature set: `benchmark-latency` was built
through the wrapper (`node scripts/cargo-sidecar.mjs build --locked --release
--bin benchmark-latency`, 1 m 50 s, sha256 `0ac57a6e…d2d0`), but its
`prewarm()` reads the same keychain-backed receipt MAC and blocked on the
same prompt, so **no as-shipped latency numbers were captured**. The numbers
that stand for `candle-metal` are the (d) rows above, taken with the
`candle-metal,ort-coreml` dev binary under load (two usable processes); the
Candle code path is the same with `ort-coreml` off (the feature only touches
`ort_utils::build_session`), but that equivalence is by inspection, not by
measurement. A quiet-machine `bun run benchmark:latency --provider
distil_whisper` with the shipped binary is owed before these figures are
quoted as release numbers.

> **Follow-up (2026-09-03, parity item B12.2.)** Attempted and not completed.
> `benchmark-latency` was rebuilt through `scripts/cargo-sidecar.mjs` with the
> shipped feature set (sha256 `974ac43f...02eb`); it built and staged without a
> prompt, but **the blocker above recurred at run time, exactly as described**.
> Pointed at a data dir with the real models symlinked in, the binary sat at
> 0.0% CPU and 7.4 MB RSS for 20 minutes with `pgrep SecurityAgent` showing a
> live keychain dialog. Nothing was clicked; the process was killed and the
> prompt left for the machine's owner. So this is not a one-off: any freshly
> built, ad-hoc-signed binary that has to read the model-integrity MAC key will
> hang here, which makes as-shipped latency unmeasurable by an unattended agent
> on this machine until either the binary is Developer ID signed or the
> integrity path grows a documented offline mode. Worth noting too that
> `coldModelPreparationMs` is measured across exactly this call, so the 14-20 s
> cold-prep figures in table (a) above may be partly keychain wait rather than
> Metal shader compilation. See `artifacts/qa/receipts-2026-09-02.md`.

Gates run through the wrapper with the shipped feature set
(`--features candle-metal`), from `nautilus-bot/`:

- `bun run lint:rust` (`cargo fmt --check` + `clippy --locked --all-targets
  -- -D warnings`): exit 0, 2 m 38 s.
- `bun run test:rust` (`test --locked --lib --bins`): `963 passed; 0 failed;
  5 ignored` (lib), `16 passed` (benchmark-latency), `4 passed` (sidecar).

## Not measured / caveats

- Whisper large-v3-turbo via `whisper_candle`: not downloaded (1.6 GB); the
  Distil-Whisper run exercises the same Candle runtime and device selection.
- Moonshine tiny: broken independently of this change (layer count hard-coded
  for base). Needs its own fix before it can be benchmarked.
- Diarization embedders, ReCasePunct, and the Qwen3 encoder also go through
  `ort_utils::build_session` and would have inherited the CoreML EP; they were
  not benchmarked. Given the Moonshine and Silero results the feature is off
  for all of them.
- All numbers were taken on a machine shared with other build lanes (load
  averages 17–81 on 14 cores). Differences under ~10% (whisper base.en on vs
  off, Silero on vs off) are within that noise; the Candle and Moonshine
  differences are 10–50× and are not.
- whisper `base.en` cold prep of 14–20 s (both variants) versus 184 ms in the
  2026-08-26 receipt is unexplained by this change and deserves a quiet-machine
  re-run of `bun run benchmark:latency`.
- Steady-state Moonshine CoreML numbers would likely improve with
  `ModelCacheDirectory` (skips the 75 per-launch compiles) and
  `EnableOnSubgraphs` (might let the decoder's `If` in), but the encoder
  partition count is structural; re-enabling needs per-session opt-outs and a
  new receipt.
