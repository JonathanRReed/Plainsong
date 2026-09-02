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
first with CPU fallback. Not in `default` or `asr-all` — opt-in for
macOS builds.

### ONNX Runtime CoreML EP (item 5)
Added `ort-coreml` Cargo feature and `ort_utils::build_session` helper
with CoreML EP + CPU fallback. Applied to Silero VAD, diarization
embedder, and Moonshine. NOT applied to Parakeet (known unstable with
CoreML EP).

### Qwen3-ASR 0.6B (item 7)
New ONNX-based ASR provider. Encoder-decoder architecture with
autoregressive LLM decoder. Supports 30+ languages with automatic
language detection. Uses `andrewleech/qwen3-asr-0.6b-onnx` HF repo.

**Status: Validated with real audio; gate lifted (2026-09-01).** Offered
as an experimental route for dictation and meetings, not promoted and
not the default. All 7 model files have pinned SHA-256 hashes; the int4
decoders use `build_session_no_coreml`.

The first real-audio run (the opt-in `qwen3_asr_real_audio_eval` test,
which downloads through the app's own verified path) failed in the
encoder: the mel tensor was laid out `[1, T, 128]` where the export takes
`[1, 128, T]`, and the prompt lacked the chat-template prefix the decoder
was traced with. Both were fixed against the export's reference consumer
(`andrewleech/qwen3-asr-onnx`, `src/mel.py` + `src/prompt.py`): Whisper's
mel frontend (centered STFT, Slaney filterbank, `log10`, dynamic-range
floor, `(x+4)/4`), the full
`<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>…`
`<|audio_end|><|im_end|>\n<|im_start|>assistant\n` prompt, and the
`<asr_text>` split that separates the detected language from the text.

Measured on an Apple M4 Pro (CPU, int4 decoders), the repo's own
fixtures, reference = Parakeet TDT 0.6B v3 output cross-checked against
whisper.cpp `base.en`:

| Fixture | WER | Wall time (p50) | RTF | Language tag |
|---|---|---|---|---|
| `real-speech-44s.wav` (44.0 s) | 3.7% vs Parakeet (0.0% vs whisper.cpp base.en; the two references disagree with each other by 3.7%) | 26-59 s | 0.6-1.3× (provisional) | English |
| `local-quality-gate.wav` (5.3 s) | 0.0% vs both | 1.4-1.7 s | 0.3× | English |

Latency is provisional: every timed run shared the M4 Pro's CPU with
other lanes' builds and benchmarks (load average 16-32 during the
receipt). The `benchmark-latency` receipt's 3-run p50 for the 44 s
fixture was 58.7 s (samples 35.7 s, 220.6 s, 58.7 s); the eval test's
earlier run of the same fixture took 25.6 s. Re-measure on a quiet
machine before quoting a single number; the route copy states the
range.

Output is punctuated and cased. Chinese, Japanese and Korean were
spot-checked with macOS TTS clips (language tag and script correct); that
is not a qualification, so the route's evidence lists English only. The
CPU cost is stated in the route's tradeoff copy. Language list: the 30
languages the model card names, mirrored in `settings.rs`
(`QWEN3_ASR_LANGUAGES`) and `asr-capabilities.ts`.

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
export — only Safetensors with a custom ALBERT architecture. An
alternative, `punct_cap_seg_en.onnx` from `1-800-BAD-CODE` (ONNX +
SentencePiece, ~210 MB), was wired up as `text::recasepunct` behind the
`text-recasepunct` Cargo feature.

**Status: Removed (2026-09-01).** `restore_punctuation_and_casing` never
had a caller, and a per-route audit found no shipped ASR route that
emits unpunctuated, uncased text, so there was nothing for it to fix:

| Route | Punctuation and casing in the model output | Evidence |
|---|---|---|
| whisper.cpp (all ggml models) | yes | Whisper decodes punctuated, cased text by design |
| Candle Whisper Large v3 Turbo | yes | same weights as the whisper.cpp large-v3-turbo route |
| Distil-Whisper large-v3.5 | yes | Whisper-family decoder |
| Parakeet TDT 0.6B v3 | yes | NeMo model card (PnC); vocabulary carries `.` `,` `?` `!` and cased pieces |
| Parakeet TDT-CTC 110M (legacy) | yes | `nvidia/parakeet-tdt_ctc-110m` card: "transcribes speech with Punctuations and Capitalizations"; the pinned sherpa-onnx `tokens.txt` carries `. 986`, `, 988`, `? 1002`, `! 1016` and cased pieces |
| Moonshine tiny/base | yes | upstream example transcript is punctuated and cased; route is also not launch-ready (`ensure_asr_route_ready` rejects it) |
| Qwen3-ASR 0.6B | yes | LLM decoder; the real-audio eval in item 7 shows punctuated, cased output |
| Apple Speech (on-device) | yes | `macos_speech_helper.swift` sets `request.addsPunctuation = true` |
| OpenAI, Groq, ElevenLabs, Cohere (cloud) | yes | punctuated transcripts are the service default |

The module, its download entry, integrity artifacts, the
`text-recasepunct` feature, and the `sentencepiece-rs` dependency were
deleted. If a future route ships without punctuation, the decision is
to add the post-step for that route only, at the ASR-manager boundary,
with a test on the dispatch decision.

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
**Blocked on this runtime; to be revisited.** Moonshine v2 streaming
models are published upstream in Safetensors format (Transformers); no
ONNX export exists, so they cannot run on the existing ONNX inference
path. The streaming architecture is also different from v1 — it needs
cached encoder state for incremental processing.

Update (2026-09-01): GGUF conversions of Moonshine v2 now exist in
transcribe.cpp (https://github.com/handy-computer/transcribe.cpp), a
ggml-based runtime. That is a different runtime from anything this
sidecar links today, so it does not unblock the ONNX path; the Wave C
runtime evaluation will revisit Moonshine v2 through that route. There
is still no ONNX export.
