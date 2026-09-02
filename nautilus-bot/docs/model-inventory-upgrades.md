# Local Model Inventory Upgrades

Status log for the 2025-2026 model inventory upgrade initiative.

## Completed

### Silero VAD v6.2.1 (item 2)
Already on latest. Pinned commit `76e3dc40` (July 2026) is post-v6.2.1.
SHA256 `1a153a22...` matches the `v6.2.1` release binary.

### AHC diarization clustering (item 3)
Replaced UnionFind single-linkage connected-components clustering with
agglomerative hierarchical clustering (AHC) using centroid linkage.
All 742 tests pass.

### Candle Metal (item 4)
Added `candle-metal` Cargo feature. `select_best_device()` tries Metal
first with CPU fallback. Not in `default` or `asr-all`; since 2026-09-01
the macOS release build enables it through
`scripts/sidecar-cargo-features.mjs`, the one list shared by
`build-rust-sidecar.mjs`, `lint:rust` / `test:rust` / `benchmark:latency`,
CI, and the third-party notices generator. Measured on an M4 Pro with
distil-large-v3.5: 0.96 s p50 on Metal vs 32.8 s on CPU F32 for a 5.3 s
utterance, 2.6 s vs 55.5 s for 44 s of audio. Receipt:
`artifacts/qa/acceleration-receipt-2026-09-01.md`.

### ONNX Runtime CoreML EP (item 5)
Added `ort-coreml` Cargo feature and `ort_utils::build_session` helper
with CoreML EP + CPU fallback. Applied to Silero VAD, diarization
embedder, and Moonshine. NOT applied to Parakeet (known unstable with
CoreML EP). **Not shipped.** Measured 2026-09-01 on Moonshine base it is
a regression: ~24 s of CoreML model compilation on first load (4.5 s on
later launches vs 0.7 s CPU), the encoder split into 75 CoreML partitions,
the merged decoder rejected by CoreML entirely (a single `If` node), and a
slower steady state than plain CPU (1.7 s p50 CPU vs 2.1 s p50 / 5.6 s p95
CoreML on the 44 s fixture). `scripts/sidecar-cargo-features.mjs` leaves it
out of the release build; details and the Silero VAD numbers are in the
receipt above.

### Qwen3-ASR 0.6B (item 7)
New ONNX-based ASR provider. Encoder-decoder architecture with
autoregressive LLM decoder. Supports 30+ languages with automatic
language detection. Uses `andrewleech/qwen3-asr-0.6b-onnx` HF repo.

**Status: Implemented (gated for testing).** The full autoregressive
decoder loop with KV cache threading is implemented. The provider
remains gated from active transcription via `is_provider_transcription_enabled`
and `ensure_asr_route_ready` until validated with real audio.
Mel spectrogram uses 128 bins (matching `config.json`), fmin=0, fmax=8000,
float16 embeddings. All 7 model files have pinned SHA-256 hashes for
tamper detection. The int4 decoders use `build_session_no_coreml` to
avoid CoreML EP dispatch overhead for unsupported int4 matmul ops.

### ERes2NetV2 speaker embeddings (item 8)
Added `eres2netv2_speaker` model — int8 quantized, 28 MB, 192-dim
embeddings from `phoenix124/kept-models` (Apache-2.0, derived from
3D-Speaker `iic/speech_eres2netv2_sv_zh-cn_16k-common`). SHA256
pinned: `be6b1621...`. Wired into diarization model registry, embedder,
UI/IPC, integrity verification, and `list_downloaded_models`. The
diarization engine now accepts a model ID via `with_model()` and
`run_diarization_with_model()`.

### ReCasePunct / ML punctuation (item 9)
ReCasePunct 1 Flash (`MihaiPopa-1/ReCasePunct-1-Flash`) has no ONNX
export — only Safetensors with a custom ALBERT architecture. Used
alternative `punct_cap_seg_en.onnx` from `1-800-BAD-CODE` which has
ONNX + SentencePiece. SHA256 pinned for both ONNX
(`dd922d45...`) and tokenizer (`9e86d026...`).

**Status: Implemented.** Download infrastructure, integrity migration,
and ONNX inference pipeline are complete. The inference pipeline
tokenizes input text with SentencePiece (`sentencepiece-rs` crate,
pure Rust), segments long text with 16-token overlap, runs the ONNX
model, and reassembles text with restored punctuation, capitalization,
and sentence boundaries following the reference `punctuators` Python
implementation. Gated behind the `text-recasepunct` Cargo feature.
Graceful fallback returns input unchanged when the feature is not
enabled or the model is unavailable.

### Apple SpeechAnalyzer detection (item 10)
Added `speech_analyzer_available` and `operating_system_version` fields
to the Apple Speech probe protocol. The Swift helper uses
`if #available(macOS 26, *)` for runtime detection. Updated Rust probe
parsing, TypeScript types, and verify script.

**Status: Detection + UI surfacing.** Full SpeechAnalyzer migration
requires rewriting the Swift helper to use `SpeechAnalyzer` +
`SpeechTranscriber` instead of `SFSpeechRecognizer`. The
`speech_analyzer_available` flag is now consumed in the UI:
- The ASR provider manager shows a "SpeechAnalyzer API detected" note
  with the OS version when the newer framework is available.
- The route catalog appends "SpeechAnalyzer API available" to the
  readiness detail string, so the route picker surfaces it to users.

## Not implemented

### Parakeet via whisper.cpp Metal (item 1)
**Viable but not implemented.** Pre-converted ggml model available at
`ggml-org/parakeet-GGUF`. Metal acceleration confirmed. Requires custom
FFI bindings to `parakeet.h` and a `whisper-rs-sys` fork. Estimated
1-2 week effort. Documented as a strategic future direction.

### Moonshine v2 streaming models (item 6)
**Blocked.** Moonshine v2 streaming models are only published in
Safetensors format (Transformers). No ONNX exports exist upstream.
The streaming architecture is fundamentally different from v1 — it
requires cached encoder state for incremental processing, which cannot
be retrofitted onto the existing ONNX inference path. Waiting for
upstream ONNX exports from UsefulSensors.
