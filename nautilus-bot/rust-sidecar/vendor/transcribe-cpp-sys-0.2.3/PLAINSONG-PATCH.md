This is the crates.io `transcribe-cpp-sys` 0.2.3 archive, with local Qwen
generation-budget and Moonshine streaming upload patches. The Rust wrapper stays on `transcribe-cpp` 0.2.3.

Upstream repository: https://github.com/handy-computer/transcribe.cpp

Upstream revision: `63a44d9239d610b3908e8a66b384924cd4a77217`, recorded in
the unchanged `.cargo_vcs_info.json`.

Archive SHA-256: `00e81030804f0ce2dd83761ba18e90e0c0c0c2794d68ca008e24245ed6d2702e`.
The cached archive matches the original Cargo.lock checksum. It contains
1,529 files and 24,535,718 uncompressed bytes. This copy excludes registry
cache markers and contains no build output, weights, or Git metadata.

Upstream source changes are `src/arch/qwen3_asr/model.cpp` and
`src/arch/moonshine_streaming/{model.cpp,decoder.cpp,decoder.h}`. The local additions are this note and
`src/arch/qwen3_asr/decode-budget.h`. All four upstream license files remain
unchanged: `LICENSE`, `ggml/LICENSE`, `src/third_party/miniz/LICENSE`, and
`bindings/rust/sys/LICENSE`.

The header sets one 2,048-token generation budget for both Qwen 0.6B and
1.7B. The model handler uses it for single and batch input validation, KV
allocation, decode graph width, loop termination, and capability reservation.
The representative 48-token prompt reserve also has one definition. That Qwen change does not alter the C ABI, dependency version, encoder,
or build options.
EOS still ends decoding. Exhausting the budget still returns
`TRANSCRIBE_ERR_OUTPUT_TRUNCATED`.

The source patch is selected by the parent Cargo.toml `[patch.crates-io]`.
Upstream's `TRANSCRIBE_DIR` override bypasses source compilation. Leave it
unset for qualification, or use a separately verified install built from
these patched sources.

The standalone arithmetic test is `../../tests/qwen-decode-budget.cpp`.
When compiler resources are available, run from `rust-sidecar`:

```sh
c++ -std=c++17 -fsyntax-only tests/qwen-decode-budget.cpp
```

This checks the actual helper used by native code, without linking ggml or
loading a model. The preparation task did not run a compiler. The app also
tests truncation, cancellation, and deadline error mapping through
`qwen_native_result_rejects_truncated_and_cancelled_partials`.

The larger budget is an evaluation hypothesis. Parent qualification still
needs the patched native build, actual ASR on 5 to 60-second and 180-second
English clips, completeness checks, cancellation, elapsed time, and peak KV
memory. No default, meeting, timestamp, language, or memory-reserve promotion
is part of this patch.

Moonshine streaming uploads retained host cross K/V through one decoder layer
and at most 256 frames per graph. Destination offsets retain the original
layer-major full-utterance layout. The graph still uses ggml_cpy for F32 and
F16 caches, so conversion stays in the existing backend. Input scratch is
bounded by slice size instead of utterance length. Host K/V and the persistent
decoder cache still grow with audio duration. No segmentation, context eviction
or transcript stitching is part of this change. Parent qualification must
check cache bytes, final transcript fidelity and peak physical footprint through
finalize on the 179-second recording. No compiler or model ran in the edit lane.

The model-free control in `rust-sidecar/tests/moonshine-cross-kv-slices.cpp` checks the patched graph against exact F32 and F16 cache bytes across three layers, full slices and a final partial slice. Trailing guard elements detect overruns. It must link against this patched native library.
