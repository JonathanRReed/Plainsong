# transcribe.cpp spike receipt: one ggml runtime for Parakeet on Metal (2026-09-02)

Parity program lane C2. Question: Plainsong links three inference stacks
(whisper-rs/ggml with Metal, ONNX Runtime on the CPU for the default Parakeet
TDT 0.6B v3 int8 route, Candle with Metal for the Whisper-derived models), and
the default dictation engine is the one that never touches the GPU.
`docs/model-inventory-upgrades.md` item 1 costed "Parakeet via Metal" at 1-2
weeks of custom FFI plus a `whisper-rs-sys` fork. Does
[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) turn that
into a dependency instead — and can it link at all next to whisper-rs, which
vendors its own ggml?

**This receipt changes no default.** The provider is behind a new Cargo feature
`asr-transcribe-cpp` that is off in `default`, absent from
`scripts/sidecar-cargo-features.mjs`, and therefore in no binary any user gets.

## Recommendation

**Adopt as optional — keep the feature, keep it off — and plan to *replace*,
not to *add*.**

The blocking risk did not materialize: it links alongside whisper-rs, it runs
on Metal, and it transcribes correctly. On the least-contended run of each
configuration it beat the shipped ORT CPU route on both fixtures (96 ms vs
196 ms p50 on 5.3 s of speech; 561 ms vs 1335 ms on 44 s) at roughly 40% less
peak RSS, for +1.33 MiB of sidecar binary. Word error against the shipped
route was 0.00% on the short fixture and 0.74% on the long one — one word, and
transcribe.cpp is the one that got it right.

It should nonetheless **not** ship as an extra user-facing route. Offering it
beside the ORT Parakeet route means shipping a second ggml runtime and asking
users to download a second 740 MB copy of weights they already have, for a
route the catalog will never recommend. The decision this spike actually
informs is the streaming lane: transcribe.cpp is the only runtime evaluated
here with cache-aware streaming models (Nemotron 3.5 ASR Streaming loaded and
decoded here in 522 ms / 143 ms — see below), and Moonshine v2 (item 6) is
blocked on exactly the same runtime gap. If Plainsong commits to streaming ASR,
transcribe.cpp should *replace* the ORT Parakeet route, not sit next to it.

Do not promote on these numbers alone. Every measurement below was taken on a
machine shared with other build lanes at 1-minute load averages of 56-135 on 14
cores; repeated runs of the same configuration varied by up to 6x, and one
round even inverted the ORT-vs-Metal ordering on the short fixture. A
quiet-machine re-run is owed before any default moves.

## What was built

| Piece | Where |
| --- | --- |
| Cargo feature `asr-transcribe-cpp` (optional, not in `default`, not in the release feature list) | `rust-sidecar/Cargo.toml` |
| Git dependency, pinned to the **v0.2.3 release commit** `63a44d9239d610b3908e8a66b384924cd4a77217` (not a branch), `default-features = false, features = ["metal"]` | `rust-sidecar/Cargo.toml` |
| Provider implementing `AsrProvider` | `rust-sidecar/src/asr/transcribe_cpp.rs` |
| Route: `transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0`, experimental, never recommended | `src/lib/asr-route-catalog.ts`, `src/lib/asr-capabilities.ts` |
| Benchmark provider + opt-in `--ensure-model` flag | `rust-sidecar/src/bin/benchmark-latency.rs` |

License: transcribe.cpp is MIT, the same as this crate. Its vendored `ggml/` is
MIT. Recorded in the commit body.

## Environment

- Hardware: Apple M4 Pro, 14 logical CPUs, 24 GB (25 769 803 776 bytes).
- OS: macOS 27.0 (build 26A5406e).
- Toolchain: rustc 1.93.0 (254b59607 2026-01-19), cargo 1.93.0.
- Source: `parity-waves` at `060c27aa`, merged into the lane branch, plus the
  working tree in this commit.
- Crates: `transcribe-cpp` / `transcribe-cpp-sys` 0.2.3 (git, rev above);
  `whisper-rs` 0.16.0; `ort` 2.0.0-rc.13.
- **Machine state: shared with other parity lanes running cargo builds and
  benchmarks throughout.** The 1-minute load average at each run's start is
  recorded with every number. Anything above ~14 is oversubscribed; nothing
  below was taken under 55. Treat every absolute latency here as provisional.
- Fixtures (repo, sha256): `scripts/fixtures/local-quality-gate.wav` 5.32 s
  `3a3caf18…431dc`; `scripts/fixtures/real-speech-44s.wav` 43.97 s
  `bcece745…5af4`.
- Binary under test: one `--release --locked` build of `benchmark-latency` with
  `--features candle-metal,asr-transcribe-cpp`, used for **all** configurations
  including the ORT baseline, so the comparison is not confounded by two
  different builds. The feature is additive; it changes no code the ORT route
  executes.

## Does it link next to whisper-rs? Yes, and here is why

This was the stated blocking risk: whisper-rs statically links its own
`libggml*.a`, transcribe.cpp statically links another, and both define the
whole ggml C API. It linked on the first attempt, with the binding's default
options (static, Metal), no `--no-default-features`, no shared-library
fallback, and no linker flags.

The mechanism, read out of the two archives:

```
$ nm -m .../transcribe-cpp-sys-*/out/lib/libggml-base.a | grep ' _ggml_init$'
00000000000018f4 (__TEXT,__text) private external _ggml_init
$ nm -m .../whisper-rs-sys-*/out/lib/libggml-base.a  | grep ' _ggml_init$'
0000000000001844 (__TEXT,__text) external         _ggml_init
```

transcribe.cpp's root `CMakeLists.txt` sets `CMAKE_C_VISIBILITY_PRESET hidden`
/ `CMAKE_CXX_VISIBILITY_PRESET hidden`, which on Mach-O emits every one of its
ggml symbols as `private external` (`N_PEXT`). Those do not collide with
whisper-rs's plain `external` definitions. Nothing in this repo had to be
changed to make that work — and nothing in this repo controls it either, which
is why it is listed as a residual risk below.

Runtime evidence, not just link evidence:

- transcribe.cpp initialized its own Metal device and ran Parakeet:
  `ggml_metal_device_init: GPU name: Apple M4 Pro`, `parakeet: using metal
  backend: Metal`.
- **whisper.cpp still works in the same binary.** whisper `base.en` on the same
  build: `whisper_backend_init_gpu: using Metal backend`, 96 ms p50 / 99 ms p95
  on the 5.3 s fixture (55.4x real time), 681 ms p50 on the 44 s fixture,
  401 MiB peak RSS, normal transcript. No fallback warnings.
- A unit test drives **both ggml copies** from one process
  (`asr::transcribe_cpp::tests::both_ggml_copies_serve_their_own_library_in_one_process`),
  so a future upstream bump that reintroduces the collision fails in CI rather
  than in somebody's dictation. It calls
  `transcribe_cpp::devices()`/`device_count()`/`backend_available(Backend::Cpu)`,
  which walk transcribe.cpp's ggml device registry, and `whisper_rs::print_system_info()`
  (which walks whisper.cpp's own `ggml_backend_reg_*` registry) plus
  `whisper_rs::SystemInfo::default()` (`ggml_cpu_has_*`), then re-checks each
  side after the other has run. It needs no model on disk.

  **Correction to the first version of this receipt.** That test originally
  called `transcribe_cpp::version()` and `whisper_rs::get_lang_str`. Neither
  touches ggml, so it could not have detected interposition at all — the whole
  failure mode is one library's ggml answering for the other's. The nm evidence
  above always stood on its own; the test did not, until now.

## Models

Both fetched through the app's own pinned-hash path
(`download::DownloadManager::download_verified_model_asset`), which hashed each
file against the pinned SHA-256 and wrote a `.plainsong-integrity` receipt
before first use. Total 1.42 GiB, inside the lane's 2.5 GB cap. The bytes were
pre-staged with `curl` to overlap with the compile; the install, verification
and receipt are the app's.

| Model | File | Bytes | SHA-256 | License |
| --- | --- | ---: | --- | --- |
| Parakeet TDT 0.6B v3 (the route) | `parakeet-tdt-0.6b-v3-Q8_0.gguf` | 739 508 576 | `5859f779…02cc7` | CC-BY-4.0 |
| Nemotron 3.5 ASR Streaming 0.6B (proof only) | `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf` | 751 094 240 | `b94545b3…8089c` | OpenMDW-1.1 |

Both URLs are pinned to a HuggingFace **commit**, not `main`
(`handy-computer/parakeet-tdt-0.6b-v3-gguf` @ `85ac09ea…`,
`handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf` @ `6d44e540…`). The
Parakeet GGUF repo's own card metadata reports `license: cc-by-4.0`, matching
NVIDIA's source weights; verified 2026-09-02.

Q8_0 was chosen for Parakeet because it is the closest GGUF analogue to the
int8 ONNX export the app already ships (740 MB vs 640 MB across four ONNX
files).

Nemotron is deliberately **not** a route: `model_options()` omits it, so the
picker never offers it. It is namable only from `benchmark-latency`, which is
what the runtime proof needed.

## Measurements

`benchmark-latency`, 5 timed runs after one warm-up, per fixture. Peak RSS is
`/usr/bin/time -l`'s `maximum resident set size` for the whole process. Three
independent rounds per configuration; every round is shown, because the spread
*is* the finding.

### 5.32 s fixture (`local-quality-gate.wav`), provider transcription only

| Configuration | p50 per round (ms) | p95 per round (ms) | best p50 |
| --- | --- | --- | ---: |
| (a) ORT CPU int8 Parakeet — shipped | 196 / 320 / 576 | 197 / 500 / 781 | **196** |
| (b) transcribe.cpp Parakeet, Metal | 683 / 96 / 424 | 864 / 117 / 599 | **96** |
| (c) transcribe.cpp Parakeet, strict CPU | 389 / 261 / 335 | 407 / 318 / 362 | **261** |

### 43.97 s fixture (`real-speech-44s.wav`)

| Configuration | p50 per round (ms) | p95 per round (ms) | best p50 |
| --- | --- | --- | ---: |
| (a) ORT CPU int8 Parakeet — shipped | 1335 / 2147 / 3156 | 1479 / 2315 / 4123 | **1335** |
| (b) transcribe.cpp Parakeet, Metal | 1008 / 561 / 1392 | 1871 / 631 / 7536 | **561** |
| (c) transcribe.cpp Parakeet, strict CPU | 3210 / 2991 / 2760 | 3325 / 3296 / 3359 | **2760** |

1-minute load average at each round's start: (a) 134.7 / 64.6 / 71.7;
(b) 61.7 / 56.0 / 68.9; (c) 120.8 / 58.6 / 72.9.

### Model load and memory

| Configuration | Cold model preparation (ms, best-worst) | Peak RSS (MiB, best-median-worst) |
| --- | --- | --- |
| (a) ORT CPU int8 Parakeet | 1888 - 3458 | 1188 / 1478 / 2144 |
| (b) transcribe.cpp Parakeet, Metal | 518 - 3703 | 859 / 886 / 915 |
| (c) transcribe.cpp Parakeet, strict CPU | 760 - 6598 | 1297 / 1322 / 1421 |

Peak RSS is the one measurement the load noise did not swamp: transcribe.cpp on
Metal was the smallest process in every round, and its spread (859-915 MiB) is
narrower than any other configuration's.

### What holds in every round

1. Metal beats strict CPU on long-form audio inside transcribe.cpp: 2.0x, 5.3x,
   2.0x on the 44 s fixture. That is the acceleration this spike was asked to
   test, and it is real.
2. transcribe.cpp on Metal beat the shipped ORT route on the 44 s fixture in
   all three rounds (1.3x, 3.8x, 2.3x).
3. transcribe.cpp on Metal used less peak RSS than either CPU configuration in
   all three rounds.

### What does not hold

On the 5.32 s fixture the ORT route won round 1 (196 ms vs 683 ms) and lost
rounds 2 and 3 (320 vs 96, 576 vs 424). Round 1's Metal run was the first
process after the download and overlapped a release build. Two of three rounds
favour Metal by 1.4-3.3x; one does not. **This comparison is not settled.**

### Transcript equivalence (WER)

Reference = the shipped ORT CPU int8 Parakeet output. Case- and
punctuation-insensitive word error rate.

| Comparison | 5.32 s fixture | 43.97 s fixture |
| --- | ---: | ---: |
| transcribe.cpp Metal vs ORT | 0.00% (0/14) | 0.74% (1/135) |
| transcribe.cpp CPU vs ORT | 0.00% (0/14) | 0.74% (1/135) |
| transcribe.cpp Metal vs transcribe.cpp CPU | byte-identical | byte-identical |

The single 44 s difference: the ORT int8 export heard "a commit message in your
**journal**"; the GGUF Q8_0 heard "in your **terminal**", which is what the
fixture says. The GGUF also wrote "Plainsong" where the ONNX export wrote
"PlainSong". So the ~0% expectation held, and the one divergence favours the
new route.

Metal and CPU producing byte-identical text is worth stating on its own: the
backend choice is not a quality choice on this family.

## Streaming-capable model: runtime proof

Loaded `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf` (NVIDIA Nemotron 3.5 ASR
Streaming 0.6B, a cache-aware streaming FastConformer with an RNN-T decoder)
through the same provider and ran a **batch** transcription. Streaming API
integration is lane C1; this only proves the model loads and decodes.

| Metric | Value |
| --- | --- |
| Model load | 522 ms (cold model preparation, including one silent decode: 967 ms) |
| 5.32 s fixture | 143 ms p50 / 178 ms p95 (37.2x real time) |
| 43.97 s fixture | 977 ms p50 / 982 ms p95 |
| Peak RSS | 960 MiB |
| 1-min load at run start | 115.5 |
| Backend | `parakeet: using metal backend: Metal`, plus `using accel backend: BLAS` |
| WER vs the ORT Parakeet reference | 0.00% (5.32 s), 4.44% (43.97 s) |

The 4.44% on the long fixture is the model, not the runtime: Nemotron wrote
"Plain song" for "Plainsong" and "a node in your editor" for "a note". It is a
different model with different weights, offered here as no route at all.

The point stands: a streaming-capable family loaded from a single GGUF through
the same six lines of provider code, in half a second.

## Binary size cost

`plainsong-sidecar`, `--release --locked`, both built through
`scripts/cargo-sidecar.mjs` so the macOS release feature set (`candle-metal`)
is identical:

| Build | Bytes |
| --- | ---: |
| Release feature set (as shipped) | 39 639 472 |
| Release feature set + `asr-transcribe-cpp` | 41 033 696 |
| **Delta** | **+1 394 224 (+1.33 MiB, +3.5%)** |

Small, because the vendored ggml is largely the code whisper-rs already links.
The build-time cost is larger: the `-sys` crate drives a CMake build of the
whole C++ tree (~2 minutes from cold on this machine, cached afterwards). CMake
is already a hard requirement for whisper-rs, so no new toolchain dependency.

## Remaining risks

1. **ggml symbol coexistence is an upstream build flag, not a contract.** It
   works because transcribe.cpp compiles with hidden visibility. If upstream
   drops that preset, or a future whisper-rs vendors ggml differently, the link
   breaks. Mitigation available and *not exercised here*: the binding's
   `shared` / `dynamic-backends` features build a shared `libtranscribe` whose
   ggml symbols are never exported — at the cost of shipping and signing a
   dylib next to the sidecar. The one-process unit test added in this commit is
   the tripwire.
2. **No CoreML.** The binding exposes Metal, Vulkan, CUDA and ROCm. There is no
   Apple Neural Engine path. Not a regression (`ort-coreml` measured as a
   regression on 2026-09-01 and is not shipped) but it closes a future door.
3. **Pre-1.0 upstream with a declared ABI break policy.** The crate is 0.2.3 and
   its own docs say the on-disk ABI may break between minor releases; the
   binding enforces a load-time base-version lock. `main` was already two
   commits past the v0.2.3 release when this was pinned. Tracking it is real
   maintenance, and pinning an exact version means missing fixes until someone
   bumps.
4. **One in-flight compute per model.** The 0.x C library serializes
   `run`/`stream` across every session of a model, and the binding enforces
   that with a per-model mutex. Plainsong transcribes dictation while a meeting
   is capturing; that would serialize, or need a second `Model` (and a second
   copy of the weights in memory). Not measured here. What the review *did*
   fix is the shape of that serialization: the provider's own runtime lock is
   no longer taken with an unbounded `lock()`, so a second request waits at
   most its own decode budget and then reports transcribe.cpp's own `Busy`
   ("already transcribing … wait for the current transcription to finish")
   instead of blocking with nothing to show. A decode also carries a
   `CancelToken` and a deadline, so an abandoned request releases the runtime
   at the next decode step rather than at the end of the decode.
5. **Adoption means a second download.** Users who already have the 640 MB ONNX
   Parakeet would need the 740 MB GGUF. A default change needs a migration
   story, not just a feature flip.
6. **No vocabulary hint.** Parakeet has no prompt or keyterm field on this
   runtime either, so the personal dictionary still does not reach the
   recognizer on this route. `vocabulary_hint_terms_applied` is reported as 0,
   which is the truth. No regression, no improvement.
7. **Every latency number here is provisional.** See the load averages.

## Gates

Run from `nautilus-bot/`, with `CARGO_TARGET_DIR` pointed at the shared target
directory. Both feature sets:

```
# Default / release feature set (what ships)
bun run lint:rust
  -> cargo fmt --check + clippy --locked --features candle-metal --all-targets -D warnings: clean
bun run test:rust
  -> 1197 passed; 0 failed; 7 ignored (lib)
     19 passed (benchmark-latency), 0 (plainsong-cli), 4 (sidecar)

# With the spike feature added
cargo fmt --manifest-path rust-sidecar/Cargo.toml --check
node scripts/cargo-sidecar.mjs clippy --locked --features asr-transcribe-cpp --all-targets -- -D warnings
  -> clean
node scripts/cargo-sidecar.mjs test --locked --features asr-transcribe-cpp --lib --bins
  -> 1224 passed; 0 failed; 7 ignored (lib)
     20 passed (benchmark-latency), 0 (plainsong-cli), 4 (sidecar)

# Shared gates
bun run typecheck        -> clean
bun run test             -> 133 files, 1491 tests passed
bun run gate:ipc-contract-> 185 renderer commands, 236 sidecar commands, all reachable
bun run gate:dead-code   -> clean
bun run licenses:generate-> 532 Rust packages, 79 npm; THIRD-PARTY-NOTICES.txt unchanged
```

(Counts above are from the 2026-09-02 review pass, which added 15 tests to the
lib across both feature sets.)

`--locked` passes for both feature sets against the same `Cargo.lock`; the two
`transcribe-cpp*` entries it gained are optional-dependency rows that the
default build resolves but never compiles.

### Offline resolution (added by the 2026-09-02 review)

The first version of this spike took `transcribe-cpp` from a **git** source.
Cargo resolves optional dependencies regardless of feature selection, and a git
source is not resolvable from a cargo cache holding only registry crates — so
`cargo metadata --locked --offline` failed for *every* feature set, including
the default and release ones that compile none of it, taking `lint:rust`,
`test:rust`, `licenses:generate` and `release:mac` with it on an offline box.

The dependency is now the crates.io release. It is the same bytes: both
`transcribe-cpp` 0.2.3 and `transcribe-cpp-sys` 0.2.3 record
`63a44d9239d610b3908e8a66b384924cd4a77217` — the commit this used to pin — in
their `.cargo_vcs_info.json`, and their `Cargo.toml.orig`, Rust sources,
`include/`, `src/`, `cmake/` and vendored `ggml/` trees diff clean against that
git checkout. The lockfile now also carries a SHA-256 for each, which a git
source cannot.

The probe, run against a `CARGO_HOME` that has the registry cache and **no**
`git` directory (which is what makes it a fair test of the failure mode):

```
mkdir -p /tmp/fakecargo && ln -s ~/.cargo/registry /tmp/fakecargo/registry

# release feature set
CARGO_HOME=/tmp/fakecargo cargo metadata --locked --offline \
  --manifest-path rust-sidecar/Cargo.toml --format-version 1 --features candle-metal
# spike feature set
CARGO_HOME=/tmp/fakecargo cargo metadata --locked --offline \
  --manifest-path rust-sidecar/Cargo.toml --format-version 1 --features asr-transcribe-cpp
# spike, no default features
CARGO_HOME=/tmp/fakecargo cargo metadata --locked --offline \
  --manifest-path rust-sidecar/Cargo.toml --format-version 1 \
  --no-default-features --features asr-transcribe-cpp
```

Before: all three failed with `failed to load source for dependency
transcribe-cpp` / `can't checkout from
'https://github.com/handy-computer/transcribe.cpp': you are in the offline mode
(--offline)`. After: all three exit 0.

The backend stays named on the dependency line (`features = ["metal"]`). Moving
it to a `whisper-gpu`-shaped `transcribe-cpp-gpu = ["transcribe-cpp?/metal"]` in
`default` was tried and reverted: a `dep?/feature` reference from an *enabled*
feature pulls the optional crate into the release resolve graph even though
nothing compiles it, and `scripts/generate-third-party-notices.mjs` resolves
that same graph — so the shipped `THIRD-PARTY-NOTICES.txt` grew from 532 to 534
Rust packages, carrying notices for two crates the shipped binary does not
contain. With the backend on the dependency line, `cargo metadata --features
candle-metal` reports 533 nodes and no `transcribe*` package, and the notices
file regenerates byte-identical. A vitest case
(`sidecar cargo feature set > keeps the spike's crates out of the release
build's third-party notices`) holds that.

### Building the spike without whisper (added by the same review)

The module's test block called `whisper_rs::` unconditionally, so a build with
`asr-whisper` off had no such crate and could not compile. The one-process ggml
test is now `#[cfg(feature = "asr-whisper")]` — there is no second ggml to
conflict with in that build anyway — and everything else in the block is
whisper-free. Receipt:

```
cargo check --locked --manifest-path rust-sidecar/Cargo.toml \
  --no-default-features --features asr-transcribe-cpp,diarization --lib --tests
  -> Finished in 1m 18s (dead-code warnings only)
```

`diarization` is in that list only because `src/diarization/` uses `ndarray`
without gating on it; `--no-default-features --features asr-transcribe-cpp`
alone still fails with 14 pre-existing errors, all in `src/diarization/`
(`unresolved import ndarray`, and the type-inference failures that follow), none
of them from this module. That gap is not the spike's and is left alone here.

The dependency is deliberately **not** moved to
`[target.'cfg(target_os = "macos")'.dependencies]`. Features are
target-independent, so `#[cfg(feature = "asr-transcribe-cpp")]` on the module
would still be true on Linux with no crate linked — turning a working
CPU-backend build into a compile error. And it would be gating on a premise that
does not hold: upstream's `bindings/rust/sys/build.rs` forwards
`-DTRANSCRIBE_METAL` only when `CARGO_CFG_TARGET_OS` is `macos`/`ios`, and its
manifest documents `metal` as a no-op off Apple, so `features = ["metal"]` does
not make this dependency Apple-only.

## Reproducing

```
# One release build serves every configuration.
node scripts/cargo-sidecar.mjs build --release --locked \
  --features asr-transcribe-cpp --bin benchmark-latency

BIN=rust-sidecar/target/release/benchmark-latency   # or $CARGO_TARGET_DIR/release/...

# (b) transcribe.cpp on Metal, fetching + verifying the GGUF on the first run
PLAINSONG_TRANSCRIBE_CPP_BACKEND=metal /usr/bin/time -l "$BIN" \
  --provider transcribe_cpp --runs 5 --ensure-model --print-transcript

# (c) the same weights, strict CPU
PLAINSONG_TRANSCRIBE_CPP_BACKEND=cpu   /usr/bin/time -l "$BIN" \
  --provider transcribe_cpp --runs 5 --print-transcript

# (a) the shipped ORT CPU int8 route
/usr/bin/time -l "$BIN" --provider parakeet --runs 5 --print-transcript

# Streaming-family runtime proof
PLAINSONG_TRANSCRIBE_CPP_BACKEND=metal /usr/bin/time -l "$BIN" \
  --provider transcribe_cpp --model nemotron-3.5-asr-streaming-0.6b-q8_0 \
  --runs 5 --ensure-model --print-transcript
```

`PLAINSONG_TRANSCRIBE_CPP_BACKEND` is a spike-only escape hatch (`metal`, `cpu`,
or unset for the automatic policy a user would get). Nothing in the app sets it,
and an unrecognised value falls back to automatic rather than pinning the slow
device.

The two GGUF files land in
`~/Library/Application Support/Plainsong/models/transcribe_cpp/` and are 1.42 GiB
together. They were removed after this receipt was written; `--ensure-model`
re-fetches and re-verifies them.
