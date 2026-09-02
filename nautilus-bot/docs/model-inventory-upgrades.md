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
| `real-speech-44s.wav` (44.0 s) | 3.7% vs Parakeet (0.0% vs whisper.cpp base.en; the two references disagree with each other by 3.7%) | 11-59 s | 0.26-1.3× (provisional) | English |
| `local-quality-gate.wav` (5.3 s) | 0.0% vs both | 0.8-1.7 s | 0.15-0.3× | English |
| `real-speech-44s.wav` twice, 1 s gap (89 s; exercises the chunked path) | 5.2% vs the doubled reference | 99 s | 1.1× | English (2 chunks) |

Latency is provisional: the timed runs ranged from a quiet machine to
one shared with other lanes' builds and benchmarks (load average 16-32
during the receipt). The `benchmark-latency` receipt's 3-run p50 for the
44 s fixture was 58.7 s (samples 35.7 s, 220.6 s, 58.7 s); eval-test
runs of the same fixture took 25.6 s and, on a quieter machine, 11.4 s
(3.7 generated tokens per second of audio). Re-measure with a receipt on
a quiet machine before quoting a single number; the route copy states
the range.

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
**Superseded by a measured spike; still not shipped.** The original plan --
custom FFI bindings to `parakeet.h` plus a `whisper-rs-sys` fork, 1-2 weeks --
is no longer the cheapest route. transcribe.cpp
(https://github.com/handy-computer/transcribe.cpp, MIT) ships a maintained
Rust binding that loads Parakeet TDT 0.6B v3 from a single GGUF onto Metal, and
lane C2 built and measured it on 2026-09-02 behind the off-by-default Cargo
feature `asr-transcribe-cpp`. Receipt:
`artifacts/qa/transcribe-cpp-spike-2026-09-02.md`.

What the spike settled:

- **It links.** The feared blocker -- whisper-rs vendors its own ggml, so a
  second vendored ggml should collide at link time -- did not happen.
  transcribe.cpp compiles its tree with hidden visibility, so on Mach-O its
  ggml symbols are `private external` and whisper-rs's stay `external`. No
  fork, no `--no-default-features`, no linker flags. whisper.cpp still runs on
  Metal in the same binary, and a unit test now calls into both native
  libraries from one process so a future upstream bump fails in CI instead.
- **Metal works and is faster on long-form audio.** On the 44 s fixture,
  transcribe.cpp on Metal beat both its own strict-CPU path (2.0-5.3x) and the
  shipped ORT CPU int8 route (1.3-3.8x) in all three rounds. Best observed
  p50: 561 ms vs 1335 ms for ORT. On the 5.3 s fixture, two of three rounds
  favour Metal (96 ms vs 196 ms best) and one does not; that comparison is not
  settled.
- **Transcripts match.** 0.00% WER against the shipped route on the 5.3 s
  fixture and 0.74% on the 44 s one (one word, which transcribe.cpp got right).
  Metal and CPU outputs are byte-identical.
- **It is cheaper in memory and binary size.** Peak RSS 859-915 MiB vs
  1188-2144 MiB for the ORT route; the sidecar grows 1 394 224 B (+3.5%).
- **The streaming families load.** Nemotron 3.5 ASR Streaming 0.6B loaded in
  522 ms and batch-decoded both fixtures through the same provider code.

**Decision: adopt as optional (the feature stays, and stays off); plan to
replace, not to add.** Shipping it as a second user-facing route would mean a
second ggml runtime plus a second 740 MB copy of weights users already have,
for a route the catalog would never recommend. The real decision belongs to the
streaming work: transcribe.cpp is the only runtime here with cache-aware
streaming models, and item 6 below is blocked on the same gap. If Plainsong
commits to streaming ASR, this should replace the ORT Parakeet route outright.

Open before any default moves: a quiet-machine re-measurement (every number
above was taken at load averages of 56-135 on 14 cores, and repeats of the same
configuration varied by up to 6x), the pre-1.0 ABI churn of a 0.2.x upstream,
the "one in-flight compute per model" limit against Plainsong's
dictation-during-a-meeting case, the absence of any CoreML/ANE path, and a
migration story for users who already downloaded the ONNX export.

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

Update (2026-09-02): lane C2's spike (item 1 above) linked transcribe.cpp into
the sidecar behind an off-by-default feature and measured it, so "a different
runtime from anything this sidecar links today" is now one build flag away
rather than an unknown. Moonshine v2 is still not implemented, and there is
still no ONNX export; it now waits on the same adopt/replace decision as
item 1 rather than on an export appearing.
