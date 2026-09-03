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

### Bundled zero-setup dictation cleanup: S1-mini (item 11)

New LLM provider `bundled_local`, and the first route that makes Smart
Format work on a fresh install with nothing installed and no key pasted.

**Model.** `superwhisper/s1-mini-GGUF` at `Q4_K_M` (462 MiB), a 0.6B
fine-tune of `Qwen/Qwen3-0.6B` trained for exactly one transformation:
raw ASR transcript in, clean written text out. Apache-2.0 plus a naming
clause requiring the exact strings "S1-mini" and "Superwhisper" wherever
the model is used; `LICENSE` and `NOTICE` are downloaded alongside the
weights so the retention obligation is met on disk. Four pinned files
(GGUF, `tokenizer.json`, `LICENSE`, `NOTICE`), 473 MiB total, each with a
SHA-256 in `llm/bundled_local.rs` and an immutable commit revision in the
URL. Readiness is "every file carries a trusted MAC'd integrity receipt",
not "the files exist": `artifacts_trusted` gates the load, and the
startup migration re-verifies them with the ASR weights.

**Runtime.** Candle, not llama.cpp.
`candle_transformers::models::quantized_qwen3::ModelWeights` reads the
GGUF and runs it with a KV cache; `candle-core`/`-nn`/`-transformers`
0.10 and `tokenizers` were already dependencies (`asr-canary`), and
`candle-metal` already ships on macOS. llama.cpp would have added a C++
toolchain to build, sign and audit for a model the existing crates run
unmodified. One resident model behind a `Mutex`, warmed at startup when
the lane selects it and keep-warm is on. Metal with CPU fallback.

**Prompt.** The literal ChatML the card documents, including the empty
`<think>\n\n</think>` block (omitting it is the documented way to get
blank output). Greedy, temperature 0. The system prompt is a fixed
literal and the only steering is a three-axis control line drawn from a
closed set, mapped from the destination-app category the pipeline already
resolves. The consequence worth naming: the captured-context blob and the
dictionary vocabulary hint have *no* path into this model, because its
input format has no slot for them.

**What it deliberately does not do.** The card is explicit that S1-mini
"is not a chat model and will not follow general instructions", so the
provider refuses `CompletionPurpose` other than `Generic`, is filtered
out of the meetings picker, and refuses free-text custom-mode and
dictation-command transforms (those fall back to Plainsong's own
deterministic transforms). Offering it for meeting summaries would have
produced normalized instructions presented as a summary.

**Measured** on an Apple M4 Pro, 5 runs per fixture after a warmup
generation, on a machine under load average 34-45 (provisional; a
quiet-machine re-run is owed). Full receipt with raw output:
`artifacts/qa/bundled-cleanup-receipt-2026-09-02.md`.

| Fixture | Metal p50 / p95 | CPU p50 / p95 |
|---|---|---|
| 59 words | 414 ms / 430 ms | 4.85 s / 5.08 s |
| 199 words | 1.82 s / 1.92 s | 11.26 s / 13.42 s |

Two findings worth carrying forward:

1. **Metal is load-bearing, not an optimization.** On CPU a 200-word
   dictation takes 11-13 s against a 6 s pre-insert budget, so every long
   capture would time out and insert unformatted text. The macOS release
   binary always compiles `candle-metal`; CPU is only reached when
   `Device::new_metal(0)` fails, and that is logged.
2. **The warmup has to generate, not just load.** Candle defers the Metal
   shader compile to the first matmul, so a loaded-but-never-run model
   still spent 7.5 s on its first real cleanup (and 0.44 s on every one
   after) — blowing the budget once per launch, on the user's first
   dictation. `prewarm()` runs a two-token throwaway generation.

### Apple Foundation Models on macOS 26+ (item 12)

New LLM provider `apple_language_model`, dictation lane only. A Swift
helper (`scripts/native-macos-language-model-helper.swift`, built by
`language-model-helper:build` into
`dist-native/plainsong-native-language-model-helper`) reads one JSON
request on stdin, checks `SystemLanguageModel.default.availability`, runs
a `LanguageModelSession` with greedy sampling, and prints one JSON line.
Guarded with `#if canImport(FoundationModels)` and
`@available(macOS 26.0, *)` so it compiles and runs on the macOS 13
support floor, answering `available: false` there. Built against SDK 26.2
(`xcrun --sdk macosx --show-sdk-version`) with an
`arm64-apple-macosx13.0` deployment target; signed with an empty
entitlement set, packaged into
`Contents/Resources/language-model-helper/`, and checked by
`verify-packaged-native-helpers.mjs`.

Availability is probed once at sidecar startup and cached; the Models
screen can force a re-probe. The instructions string is ours and the
transcript is passed as the prompt, never concatenated into it. Dictation
lane only: the session's 4,096-token window is shared between prompt and
response, which is smaller than one meeting chunk plus its summary.

**Not validated end to end on this machine.** The probe, the protocol and
the error paths were exercised against the real helper on macOS 27.0, but
Apple Intelligence had not finished downloading its model
(`model_not_ready`), so no generation has run. That step needs a Mac with
Apple Intelligence enabled and its model downloaded.

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

## Next (from the 2026-09-02 model inventory)

Full research, with prices, licences, endpoints and sources:
`docs/model-inventory-2026-09.md`. Ordered by value, highest first.

1. **Cohere Transcribe 03-2026 as a local ONNX route.** 5.42% WER (better than
   Parakeet TDT v3's 6.32%), 14 languages, Apache-2.0, community ONNX export at
   `onnx-community/cohere-transcribe-03-2026-ONNX`, and ONNX Runtime is already
   linked into this sidecar. Plainsong already calls the same model as a cloud
   API. This is the highest-value local model work outstanding. Measure the 5 s
   fixture before promoting it over Parakeet for dictation — it is 2B against
   0.6B, so it may well win meetings and lose dictation.
2. **Fix diarization segmentation before swapping embedders.** The pipeline uses
   fixed 2 s windows hopped 1 s with no VAD and no overlap handling; that is the
   dominant error source, and no better embedding model fixes a badly-placed
   window. Needs no new model or download.
3. **Mistral Voxtral (`voxtral-mini-transcribe`) as a cloud provider.**
   $0.003/min, ~4% WER on FLEURS, speaker labels and timestamps, an
   OpenAI-shaped `/v1/audio/transcriptions` endpoint, and the `mistral`
   credential slot is already registered. Cheapest diarizing option after Soniox
   and the least new code.
4. **Soniox `stt-async-v5`.** ~$0.10/hr with diarization, language ID and smart
   formatting bundled, 60+ languages. Verify its data-retention terms first —
   the 2026-09-02 pass did not.
5. **Provider diarization past the single-request ceiling.** A provider
   numbers speakers per request, so its labels are only used when the whole
   meeting went out in one — Deepgram to four hours, Gemini to thirty minutes.
   A longer meeting falls back to Plainsong's own diarizer. Closing that gap
   means matching speakers across requests (a voiceprint carried between
   chunks), which is a real piece of work and not a config change.
6. **Sortformer 4spk v2** (`nvidia/diar_streaming_sortformer_4spk-v2`,
   CC-BY-4.0, 13.24 DER on DIHARD III) only if someone exports it to ONNX. Hard
   cap of 4 speakers.
7. **AssemblyAI Universal — do not add** until it ships a per-request
   model-improvement opt-out. Today the opt-out is an account-level dashboard
   toggle, paid tier only, with no API surface reporting its state.
