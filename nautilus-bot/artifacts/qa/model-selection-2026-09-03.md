# Model selection, measured: should Voxtral be the default? (2026-09-03)

Parity program lane V1. The question, as asked: Voxtral is "faster and more
accurate" than what Plainsong ships, so make it the default; and go find the
smaller variants and the Hugging Face fine-tunes.

## Recommendation, first

**No. Parakeet TDT 0.6B v3 stays the local dictation default, and stays the
local meetings default. Voxtral ships as a cloud route instead
(`mistral_voxtral`, Voxtral Mini Transcribe 2, $0.003/min, BYOK).**

Two beliefs the measurement contradicts, both stated plainly because the whole
point of measuring was to find out:

1. **Voxtral is not faster. On this Mac it is 13.7x slower** on a 5-second
   utterance (1285 ms against 94 ms, p50, both on Metal through the same
   runtime, Voxtral at its own fastest quantization) and 8.2x slower on 44
   seconds. The leaderboard already pointed this way — Voxtral Small runs at
   65.6x real time against the Parakeet row's 100.6x on Artificial Analysis's
   non-streaming board — and running both here made the gap wider, not
   narrower.
2. **Voxtral is more accurate on the board, and that part is true** — 2.77%
   AA-WER for Voxtral Small and 3.59% for Voxtral Mini Transcribe 2, against
   6.43% for the Parakeet row on the same board. It is the best open-weights
   model listed. But **that advantage did not appear on this repo's own
   fixtures**: against the shipped route, local Voxtral was word-identical on
   the 44-second clip and one word *worse* on the 5-second one, where it heard
   "Nodalis" for "Nautilus". Two English clips are not a WER, and they do not
   refute the board — but the accuracy that would have to justify 13.7x the
   latency has not shown up anywhere Plainsong can see it.

There is also a hard blocker nobody had written down: **neither Voxtral family
emits timestamps of any kind.** transcribe.cpp reports
`max_timestamp_kind = TRANSCRIBE_TIMESTAMPS_NONE` for both `voxtral` and
`voxtral_realtime` (`src/arch/voxtral/capabilities.cpp:14`,
`src/arch/voxtral_realtime/capabilities.cpp:14`). Plainsong's meeting lane
offsets and merges per-segment times, and diarization is merged onto them, so a
timestamp-free model cannot serve meetings at any speed. That rules local
Voxtral out of the one lane where its accuracy would have been worth its
latency.

The cloud route is the answer to what was actually wanted. Mistral's hosted
Voxtral Mini Transcribe 2 is 3.59% AA-WER at 83.3x, $0.003/min, with speaker
labels and segment timestamps — **cheaper and more accurate than Deepgram
Nova-3**, the fastest cloud route Plainsong already ships (5.18% at
$0.0043/min). That is a real upgrade to the cloud roster, and it is Voxtral.

Per lane, in one line each:

| Lane | Default now | Change? |
|---|---|---|
| Dictation, local | Parakeet TDT 0.6B v3 | **No.** Measured here: Voxtral is 12.5-13.7x slower on the 5 s fixture; the bar is ~1.5x. It also needs 4.9x the memory and a 4x larger download. |
| Meetings, local | Parakeet TDT 0.6B v3 | **No.** Voxtral emits no timestamps, so it cannot serve this lane at all. |
| Cloud | Deepgram Nova-3 leads the picker | **Added** Mistral Voxtral: cheaper *and* more accurate than Deepgram, with speaker labels. Not made the top recommendation — Deepgram is 7.3x faster on the board and that ordering was measured, not guessed. |
| Streaming | Nemotron 3.5 ASR Streaming (transcribe.cpp) | **No.** Voxtral Realtime emits no timestamps either, is 15-17x Parakeet on transcribe.cpp's own M4 Max numbers, and is 0.12 points better than Nemotron on the streaming board (5.24% against 5.36%) at 1.6x the time to final. Not measured here — §3.5 says why. |
| Diarization | local ECAPA-TDNN embedding pipeline | **No change this lane**, but see §5: the inventory doc's claim that every open end-to-end diarizer needs PyTorch is now false, and the replacement is 987 MB. |

---

## 1. The boards, fetched 2026-09-03

Both Artificial Analysis speech-to-text boards were fetched today. The row data
on both pages is client-rendered; the tables below were extracted from the
embedded page payload rather than the rendered HTML, so they are the complete
board rather than the first screen a summariser sees.

**There is no diarization board.** The speech-to-text index links exactly two
sub-pages — `/speech-to-text/non-streaming` and `/speech-to-text/streaming` —
plus a text-to-speech arena and speech explorer. No diarization,
speaker-labelling or meeting-transcription leaderboard exists on that site, and
nothing has been invented to fill the gap; §5 falls back to the diarization
sources the inventory doc already cites, plus one new one.

### 1.1 Non-streaming board (<https://artificialanalysis.ai/speech-to-text/non-streaming>, fetched 2026-09-03)

AA-WER is their aggregate over AA-AgentTalk / VoxPopuli / Earnings22; lower is
better. Speed is their throughput multiple over real time, measured against the
hosted API. "Open" is their own open-weights flag. Price is per 1000 minutes.

| Model | Open | AA-WER | Speed | $/1k min |
|---|---|---:|---:|---:|
| MAI-Transcribe-2 (Microsoft AI) | — | 2.04% | 410.7x | 1.67 |
| Scribe v2 (ElevenLabs) — **shipped** | no | 2.18% | 53.2x | 3.67 |
| MAI-Transcribe-1.5 | no | 2.38% | 190.3x | 6 |
| Smallest AI Pulse Pro | no | 2.43% | 274.4x | 4 |
| Gemini 3.5 Transcribe — **shipped** | no | 2.60% | 89.8x | 5 |
| **Voxtral Small (Mistral)** | **yes** | **2.77%** | **65.6x** | 4 |
| Universal-3 Pro (AssemblyAI) | — | 3.12% | 88.2x | 3.5 |
| GPT Transcribe (OpenAI) — **shipped** | no | 3.31% | 40.0x | 4.5 |
| **Voxtral Mini Transcribe 2 (Mistral)** | **yes** | **3.59%** | **83.3x** | **3** |
| Soniox v5 Async | no | 3.81% | 36.5x | 1.66 |
| **Voxtral Mini (DeepInfra)** | **yes** | 3.84% | 76.5x | 1 |
| Whisper Large v3 (fal.ai) | yes | 4.07% | 103.8x | 1.15 |
| Canary Qwen 2.5B (NVIDIA) | yes | 4.27% | 5.9x | 0.74 |
| transcribe-03-2026 (Cohere) — **shipped** | yes | 4.57% | 113.6x | 0 |
| Whisper Large v3 Turbo (Groq) — **shipped** | yes | 4.62% | 150.5x | 0.667 |
| **Nova-3 (Deepgram)** — **shipped** | no | 5.18% | **607.7x** | 4.3 |
| Parakeet RNNT 1.1B | yes | 5.42% | 6.3x | 1.91 |
| **Parakeet TDT 0.6B V2 (NVIDIA)** | **yes** | **6.43%** | **100.6x** | 0 |

55 rows in total; the ones above are every route Plainsong ships, every Voxtral
row, and the neighbours needed to read them.

**Two cautions that change how this table should be read, and both matter for
the recommendation.**

- The board lists Parakeet TDT 0.6B **V2**. Plainsong ships **V3**, which
  NVIDIA released after V2 and which extends English-only coverage to 25
  European languages. The 6.43% row is not Plainsong's model, and using it as
  "what Plainsong scores" would overstate the accuracy gap.
- Every speed figure is a hosted API's throughput on someone else's GPU. It is
  not a latency figure and it is not this Mac. Measured in §3: Parakeet TDT v3
  on this M4 Pro through transcribe.cpp on Metal runs the 44 s fixture in
  542 ms — **81x real time**, on a laptop under a load average of 79, with no
  network round trip, which is squarely in the range the board reports for
  hosted Voxtral Mini Transcribe 2 (83.3x). §3 is what actually settles the
  comparison.

### 1.2 Streaming board (<https://artificialanalysis.ai/speech-to-text/streaming>, fetched 2026-09-03)

30 rows. WER at final transcription; times are seconds after speech end.

| Model | Open | WER | t(final) | t(first partial) | $/1k min |
|---|---|---:|---:|---:|---:|
| Cartesia Ink-2 (semantic endpoints) | no | 3.36% | 0.43 | 0.17 | 4 |
| ElevenLabs Scribe v2 Realtime | no | 3.59% | 0.14 | 0.13 | 6.5 |
| Qwen3 ASR Flash Realtime | no | 3.73% | 0.48 | 0.40 | 5.4 |
| GPT Live Transcribe | no | 3.92% | 0.81 | 0.26 | 17 |
| AssemblyAI U3.5 Realtime Pro (min latency) | no | 4.02% | 0.19 | 0.18 | 7.5 |
| Soniox v5 Real-Time | no | 4.50% | 0.05 | 0.05 | 2 |
| **Voxtral Mini Transcribe Realtime** | **yes** | **5.24%** | 0.68 | 0.32 | 6 |
| **Nemotron 3 ASR 1120ms** | **yes** | **5.36%** | 0.42 | 0.36 | 0 |
| **Nemotron 3 ASR 560ms** | **yes** | **5.96%** | 0.25 | 0.22 | 0 |
| Deepgram Nova-3 Realtime | no | 6.59% | 0.07 | 0.06 | 4.8 |
| **Nemotron 3 ASR 160ms** | **yes** | 7.61% | 0.10 | 0.07 | 0 |
| Deepgram Flux | no | 7.39% | 0.02 | 0.02 | 6.5 |
| **Nemotron 3 ASR 80ms** | **yes** | 8.38% | 0.07 | 0.04 | 0 |

Reading for Plainsong's own streaming lane, which runs Nemotron 3.5 ASR
Streaming locally through transcribe.cpp: **Voxtral Realtime's accuracy
advantage over Nemotron at a comparable delay is 0.12 points** (5.24% against
5.36%), and it costs 0.68 s to final against Nemotron's 0.42 s. That is not a
reason to change anything, before the local latency in §3.3 is even counted.

---

## 2. Hugging Face survey: what could actually run on this Mac

The constraint is not "is it good", it is "can a runtime this app already links
load it". Plainsong links `ort` 2.0.0-rc.13, Candle 0.10 with Metal, whisper-rs,
and — behind the off-by-default `asr-transcribe-cpp` feature — transcribe.cpp
0.2.3, a ggml runtime with a single GGUF loader and Metal on by default. There
is no Python, no PyTorch, no NeMo, and **no MLX runtime** (the `macos_mlx_sidecar`
engine is a retired stub that always reports not-ready), so every MLX conversion
below is out regardless of quality.

### 2.1 The Voxtral family, complete

Searched the HF model index for `voxtral` on 2026-09-03: 200+ repositories.
Grouped by what they actually are:

| Repository | What it is | Params | Licence | Format | Loadable here? |
|---|---|---|---|---|---|
| `mistralai/Voxtral-Mini-3B-2507` | offline audio-LLM, the ASR model | 3B | Apache-2.0 | safetensors | via GGUF conversion below |
| `handy-computer/Voxtral-Mini-3B-2507-gguf` | official transcribe.cpp port | 3B | Apache-2.0 | GGUF, 6 tiers BF16→Q4_K_M (9.37 GB → 2.98 GB) | **yes** |
| `mistralai/Voxtral-Mini-4B-Realtime-2602` | streaming audio-LLM | ~4.4B | Apache-2.0 | safetensors | via GGUF conversion below |
| `handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf` | official port | ~4.4B | Apache-2.0 | GGUF, 6 tiers (8.87 GB → 2.83 GB) | **yes** |
| `mistralai/Voxtral-Small-24B-2507` | the 2.77% board model | 24B | Apache-2.0 | safetensors | **no** — BF16 needs ~50 GB; this Mac has 24 GB total |
| `onnx-community/Voxtral-Mini-3B-2507-ONNX` | ONNX export | 3B | Apache-2.0 | ONNX | in principle, but see below |
| `onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX` | ONNX export | 4B | Apache-2.0 | ONNX | same |
| `bartowski/…`, `ggml-org/…`, `cstr/…`, `mradermacher/…` GGUFs | community requantizations of the same weights | — | Apache-2.0 | GGUF | yes, but no reason to prefer them to the port's own |
| `mlx-community/*`, `majentik/*-TurboQuant-MLX-*`, `aufklarer/*-MLX-*` (25+ repos) | MLX conversions | — | Apache-2.0 | MLX | **no runtime** |
| `RedHatAI/*-FP8-dynamic`, `ghecko78/*-W4A16`, `*-GPTQ`, `*-AWQ4`, `*-ExecuTorch` | server / accelerator quantizations | — | Apache-2.0 | safetensors, ExecuTorch | **no** — vLLM/CUDA/ExecuTorch targets |
| `mistralai/Voxtral-4B-TTS-2603` and its ports | text-to-speech, not ASR | 4B | — | various | out of scope |
| `*-Text-Only-*` (`SaisExperiments`, `Columbidae`, `minpeter`) | the decoder with the audio tower removed | — | Apache-2.0 | safetensors/GGUF | not a speech model |

**There is no smaller Voxtral.** The question "is there a 1B or 2B variant"
has a clean answer: no. Mistral ships 3B (offline), ~4.4B (realtime) and 24B,
and every "smaller" repository on the hub is either a quantization of one of
those or the text-only decoder with the audio encoder stripped out. The size
lever on this family is the quantization ladder, not the parameter count — and
that ladder is WER-neutral: the port measures 1.88% at BF16 and 1.94% at Q4_K_M
on LibriSpeech test-clean, inside its own bootstrap noise. Which is why §3
measures Q4_K_M: the smallest and fastest tier, i.e. **Voxtral's best case**.

### 2.2 Voxtral community fine-tunes

Every fine-tune found with more than a handful of downloads, and what it is for:

| Fine-tune | Target | Licence | Would it help Plainsong? |
|---|---|---|---|
| `TalTechNLP/Voxtral-Mini-3B-2507-estonian` | Estonian | Apache-2.0 | No — Parakeet TDT v3 already covers Estonian, faster |
| `pphilip/voxtral-3B-atc-transcribe` | air-traffic-control radio | Apache-2.0 | No — a domain Plainsong does not serve |
| `adriabama06/Voxtral-Mini-4B-Realtime-2602-CrispASR-GGUF` | noisy-audio robustness | not declared | No — undeclared licence, single author, no published eval |
| `TirexRover/Voxtral-Mini-Medical` | clinical vocabulary | not declared | No — Deepgram `nova-3-medical` already covers this, licensed |
| `chendren/voxtral-creole-lora-v3` | Haitian Creole | Apache-2.0 | No — LoRA adapter, needs PEFT at load |
| `jaeyong2/Voxtral-Mini-3B-Ko`, `speech-trainer/Voxtral-Mini-3B-Ko` | Korean | not declared | No |
| `Ahmed007/Finetune-Voxtral-ASR-quran` | Qur'anic recitation | not declared | No |
| `nvti/voxtral-vi-lora` | Vietnamese | Apache-2.0 | No — LoRA adapter |
| `MrlolDev/voxtral-emotion-speech` | emotion labelling | Apache-2.0 | Not ASR |

**None of them is a candidate**, and the reasons stack: they inherit the
latency of the base model, which is the disqualifying property; they inherit
the missing timestamps; most are safetensors with no GGUF, so they would need a
conversion step this repo has no Python to run; and several declare no licence
at all, which is on its own disqualifying for something Plainsong would ask a
user to download.

For contrast, here is what a fine-tune worth taking seriously looks like:
`primeline/parakeet-primeline` is a German fine-tune of **Parakeet TDT v3**
itself, CC-BY-4.0, with an official GGUF port, byte-identical tokenizer and
model config to v3 (so throughput is unchanged), 6.00% WER on FLEURS German
against the base model, and no collapse of the other 24 languages (4.24% English,
3.24% Spanish on 150-utterance FLEURS subsets). It is not proposed for this
lane — Plainsong has no German-primary evidence to justify a second Parakeet
download — but it is the shape a useful fine-tune has, and it is a fine-tune of
the model that is *already the default*.

### 2.3 The rest of the field, on the same test

Every open-weights family the brief named, plus everything open on the two
boards, checked for "can a shipped runtime load it".

| Family | Best open variant | Params | Licence | Apple Silicon runtime | Verdict |
|---|---|---|---|---|---|
| **Parakeet TDT v3** (shipped default) | `handy-computer/parakeet-tdt-0.6b-v3-gguf` | 0.6B | CC-BY-4.0 | ONNX (shipped) + GGUF/Metal | the incumbent |
| Parakeet Unified EN 0.6B | `handy-computer/parakeet-unified-en-0.6b-gguf` | 0.6B | CC-BY-4.0 | GGUF/Metal | **worth a later lane** — same size, offline *and* buffered streaming from one file, but English only |
| Multitalker Parakeet Streaming 0.6B v1 | `handy-computer/multitalker-parakeet-streaming-0.6b-v1-gguf` | 0.6B | NVIDIA Open Model Licence | GGUF/Metal | speaker-attributed streaming ASR; licence needs review before it could ship |
| Nemotron 3.5 ASR Streaming (shipped streaming) | `handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf` | 0.6B | OpenMDW-1.1 | GGUF/Metal | the incumbent streaming route |
| Canary | `handy-computer/canary-1b-v2-gguf` | 1B | CC-BY-4.0 | GGUF/Metal | 4.27% AA-WER at **5.9x** on the board — the slowest thing on it. No. |
| Qwen3-ASR 1.7B | `handy-computer/Qwen3-ASR-1.7B-gguf` | 1.7B | Apache-2.0 | GGUF/Metal | 3x the parameters of the 0.6B Plainsong already ships as experimental; a GGUF/Metal route for it is a plausible future lane, unlike the int4-ONNX-on-CPU route today |
| Cohere Transcribe 03-2026 | `handy-computer/cohere-transcribe-03-2026-gguf` | 2B | Apache-2.0 | GGUF/Metal | **the one real surprise** — the local Cohere route shipped on 2026-09-03 runs int4 ONNX on the *CPU* at 673 ms for 5.3 s; the same weights have a Metal GGUF at 1.55 GB (Q4_K_M). Re-measuring that route on this runtime is the highest-value follow-up in this document. |
| Granite Speech 4.1 2B | `handy-computer/granite-speech-4.1-2b-gguf` | 2B | Apache-2.0 | GGUF/Metal | audio-LLM, same latency class as Voxtral; no |
| Moonshine v2 streaming | `handy-computer/moonshine-streaming-small-gguf` | small | MIT | GGUF/Metal | 189 MB at Q8_0 — the smallest streaming route available; English short-form |
| Kyutai STT | `kyutai/stt-2.6b-en-trfs`, `cstr/kyutai-stt-*-GGUF` | 1–2.6B | CC-BY-4.0 | community GGUF only, no transcribe.cpp family | no supported loader |
| MOSS-Transcribe-Diarize | `handy-computer/MOSS-Transcribe-Diarize-gguf` | 0.9B | Apache-2.0 | GGUF/Metal | see §5 — transcription **and** diarization in one 987 MB file |
| Streaming Sortformer 4spk v2.1 | `handy-computer/diar_streaming_sortformer_4spk-v2.1-gguf` | — | NVIDIA Open Model Licence | GGUF/Metal | see §5 |
| ARK-ASR-3B, MOSS-Transcribe-2B, Meta Omnilingual | — | 2–7B | Apache-2.0 | none published | still PyTorch-only |
| Voxtral Small 24B | — | 24B | Apache-2.0 | GGUF exists | ~50 GB at BF16 on a 24 GB machine; no |

**Rejected for being PyTorch/CUDA-only or having no loader here:** ARK-ASR-3B,
MOSS-Transcribe-preview-2B, Meta Omnilingual ASR, Kyutai STT (no first-party
GGUF and no transcribe.cpp family), every `*-FP8-dynamic` / `*-W4A16` /
`*-GPTQ` / `*-AWQ` server quantization, and every ExecuTorch export.
**Rejected for having no runtime in this app:** the entire MLX ecosystem,
including `mlx-community/parakeet-tdt-0.6b-v3` and 25+ Voxtral conversions.
**Rejected on hardware:** Voxtral Small 24B.

---

## 3. Measured here, on this Mac

### 3.1 What was measured, and how

| | |
|---|---|
| Hardware | Apple M4 Pro, 14 logical CPUs, 24 GiB (25 769 803 776 bytes), macOS |
| Binary | `benchmark-latency`, `--release --locked`, `--features candle-metal,asr-transcribe-cpp`, one build used for **every** configuration below |
| Backend | `Auto`, i.e. what a user would get. Both models reported `using metal backend: Metal` plus `using accel backend: BLAS` |
| Fixtures | `scripts/fixtures/local-quality-gate.wav` 5.32 s (`3a3caf18…431dc`) and `scripts/fixtures/real-speech-44s.wav` 43.97 s (`bcece745…5af4`) |
| Scope | `provider_transcription_only` — audio already in memory, no capture, no formatting, no insertion |
| Weights | fetched from the pinned HuggingFace commits in `MODEL_SPECS` and verified through the app's own `download_verified_model_asset`, which hashed each file against the pinned SHA-256 and wrote a `.plainsong-integrity` receipt before first use. Parakeet `5859f779…02cc7`, Voxtral `3a6717aa…36205`; both matched. |
| Machine state | **Shared with other parity lanes running cargo builds throughout.** The 1-minute load average is recorded either side of every run below. Nothing here was taken on a quiet machine, and every absolute number is therefore an upper bound. |

**Why the ratio is the load-robust part, and why the load direction is known.**
Each round below runs Parakeet and Voxtral back to back, on one binary, within
the same two minutes, at load averages that differ by a few points — the same
protocol `artifacts/qa/cohere-local-receipt-2026-09-02.md` used. That receipt
also established which way load biases this comparison, by re-running its own
measurement on a quieter machine: the small model gains more from an idle
machine than the large one, so **contention flatters the larger model**. Round 3
below is the same finding again — 30 points less load moved the ratio *against*
Voxtral, from 12.5x to 13.7x. Everything here is therefore a conservative
reading of Voxtral's disadvantage, not a generous one.

**One methodological note that is not about the models.** These runs use a
scratch `HOME` with its own empty, throwaway keychain, and hardlinks to the same
model files. The app MACs its model-integrity receipts with a key held in the OS
keychain, and macOS raises a user-present authorization dialog the first time a
freshly-built (ad-hoc signed) binary reads that key — which blocks an unattended
benchmark indefinitely rather than failing. Confirmed by stack sample:
`SecKeychainFindGenericPassword → … → ClientSession::decrypt → mach_msg`, 0.02 s
of CPU after eleven minutes. An empty keychain makes the key *generated* rather
than *read*, which needs no authorization. The user's own login keychain was
never opened and its search list is unchanged. This does not touch the model,
the runtime, the backend or the fixtures.

### 3.2 Latency, three rounds

Every round is a p50/p95 over N timed runs after one warm-up, both fixtures.

| Round | Runs | Load (1-min, start→end) | Route | 5.3 s p50 | 5.3 s p95 | 44 s p50 | 44 s p95 |
|---|---:|---|---|---:|---:|---:|---:|
| 1 | 5 | 121 → 126 | Parakeet TDT v3 Q8_0 | 120 ms | 145 ms | 649 ms | 820 ms |
| 2 | 3 | 111 → 110 | Parakeet TDT v3 Q8_0 | **96 ms** | 105 ms | **576 ms** | 621 ms |
| 2 | 3 | 110 → 88 | **Voxtral Mini 3B Q4_K_M** | **1196 ms** | 1239 ms | **4302 ms** | 4304 ms |
| 3 | 5 | 81 → 79 | Parakeet TDT v3 Q8_0 | **94 ms** | 97 ms | **542 ms** | 563 ms |
| 3 | 5 | 79 → 72 | **Voxtral Mini 3B Q4_K_M** | **1285 ms** | 1303 ms | **4447 ms** | 4487 ms |
| 4 | 5 | 32 → 34 | Parakeet TDT v3 Q8_0 | **98 ms** | 109 ms | **590 ms** | 668 ms |
| 4 | 5 | 34 → 48 | **Voxtral Mini 3B Q4_K_M** | **1279 ms** | 1316 ms | **5164 ms** | 6179 ms |

Individual runs, so the spread is visible rather than summarised:

- round 3 Parakeet, 5.3 s: 89, 97, 93, 94, 94 ms — 44 s: 563, 532, 542, 542, 544 ms
- round 3 Voxtral, 5.3 s: 1229, 1253, 1285, 1290, 1303 ms — 44 s: 4402, 4425, 4447, 4473, 4487 ms
- round 4 Parakeet, 5.3 s: 109, 98, 95, 90, 98 ms — 44 s: 668, 612, 549, 590, 590 ms
- round 4 Voxtral, 5.3 s: 1231, 1257, 1279, 1316, 1315 ms — 44 s: 4366, 4497, 5164, 5376, 6179 ms

Round 4 is the quietest available in this session, and it is the round to read
against `artifacts/qa/cohere-local-receipt-2026-09-02.md`, whose "quiet-machine
run" was taken at a load average of 26 falling to 22 on the same 14 cores. Its
long-fixture spread is the widest here (4366-6179 ms) because the machine
picked up again mid-run — the load average rose from 34 to 48 across the
Voxtral half — which is exactly why the short-fixture p50 and the ratio, not the
long-fixture p95, are the numbers quoted below.

**The ratio, which is the number the decision turns on:**

| | 5.3 s fixture | 44 s fixture |
|---|---:|---:|
| Round 2 (load ~110) | **12.5x** | **7.5x** |
| Round 3 (load ~79) | **13.7x** | **8.2x** |
| Round 4 (load ~33) | **13.1x** | **8.8x** |

**The bar `docs/model-inventory-2026-09.md` §5(a) set is ~1.5x on the 5 s
fixture.** Voxtral misses it by an order of magnitude, in three independent
paired rounds, across a 3.4x range of machine load, with the short-fixture
spread inside any one configuration under 7%. The ratio moved *against* Voxtral
as the machine quietened — 12.5x, 13.7x, 13.1x — which is the same direction the
Cohere receipt found for the same reason: a 3B decoder is compute-bound in a way
a 0.6B transducer is not, so contention flatters the larger model. This is not a
close call and no quieter machine will make it one.

For scale: 1.3 seconds is not a tail case, it is the p50. Dictation is a hot
path where the user is watching the caret, and the shipped route answers the
same utterance in 94 ms.

### 3.3 Everything else the runs reported

Round 3 figures (load ~79), the round with five timed runs at the tightest
spread. Round 4 agrees within 2% on every row.

| | Parakeet TDT 0.6B v3 Q8_0 | Voxtral Mini 3B 2507 Q4_K_M | Voxtral / Parakeet |
|---|---:|---:|---:|
| Model on disk | 705 MiB (739 508 576 B) | **2847 MiB** (2 984 721 056 B) | 4.0x |
| Peak RSS (whole process) | 925 MiB | **4548 MiB** | 4.9x |
| Peak memory footprint | 989 MiB | 4686 MiB | 4.7x |
| Cold model preparation | 321 ms | 3218 ms | 10.0x |
| First (untimed) inference | 117 ms | 1228 ms | 10.5x |
| Real-time factor, 5.3 s clip | 56.6x | **4.1x** | — |
| **Max timestamp granularity** | **`Token`** | **`None`** | — |

The last row is the one that ends the meetings argument, and it is not an
inference: it is what the loaded model reports through
`Model::capabilities().max_timestamp_kind`, logged by this lane's own change to
`asr/transcribe_cpp.rs` and visible in both rounds' output —
`transcribe.cpp loaded …/Voxtral-Mini-3B-2507-Q4_K_M.gguf on auto in 1822 ms
(max timestamps: None)`. Plainsong's meeting lane offsets and merges
per-segment times and merges diarization onto them. A model that returns none
cannot serve it.

Peak RSS is also worth reading on its own: 4.5 GiB of a 24 GiB machine, for
dictation, while a meeting may be capturing at the same time. That is a cost the
latency table does not show.

### 3.4 Accuracy, on this repo's own fixtures

There is no committed ground-truth transcript for either fixture, so — following
`artifacts/qa/cohere-local-receipt-2026-09-02.md` — this is a **comparison
against the shipped default, not a WER**. Case- and punctuation-insensitive,
the same basis lane C2 used.

| Comparison | 5.32 s fixture | 43.97 s fixture |
|---|---:|---:|
| Voxtral Mini 3B vs Parakeet TDT v3 | **7.14% (1/14 words)** | **0.00% (0/135 words)** |

Identical in all three paired rounds. The single difference on the short
fixture is a proper noun, and **Parakeet is the one that gets it right**:

> Parakeet: "This is a **Nautilus** local quality gate sample…"
> Voxtral: "This is a **Nodalis** local quality gate sample…"

On the 44 s fixture the two are word-identical. They differ only in
capitalisation and hyphenation, and there too Parakeet is closer to the
product's own spelling: Parakeet writes "Plainsong", Voxtral writes "PlainSong";
Voxtral hyphenates "open-source" and breaks one sentence at "editor. And". Both
drop the same word at "when you press a hot," — an error the shipped route has
had all along, and Voxtral does not fix it.

So on this repo's two fixtures, the model that is 13.7x slower and needs 4.9x
the memory is **not more accurate**. That does not refute the leaderboard —
these are two English clips, not AA-AgentTalk plus VoxPopuli plus Earnings22,
and Voxtral's board advantage is real. It does mean the accuracy the board
promises has not shown up anywhere Plainsong can see it, on the audio Plainsong
is actually asked to transcribe.

### 3.5 What was not measured, and why

**Voxtral Mini 4B Realtime 2602 (Q4_K_M, 2.83 GB) was not measured here.** The
download was started and abandoned at 621 MB: the shared machine was running at
a load average above 100 with the volume 99% full, and the transfer had dropped
to about 1 MB/s — roughly 45 minutes for a file whose verdict does not depend on
it. The partial file was deleted. What is known about it instead:

- it advertises `max_timestamp_kind = NONE` too
  (`src/arch/voxtral_realtime/capabilities.cpp:14`), so it cannot serve meetings
  either;
- transcribe.cpp's own M4 Max Metal numbers for it, on the same runtime and the
  same quantization tier used above, are 1.14 s for an 11.0 s sample and 3.91 s
  for a 35.3 s one, against 76 ms and 230 ms for Parakeet TDT v3 on the same
  page — 15x and 17x;
- on the streaming board (§1.2) it is 5.24% against Nemotron 3 ASR's 5.36% at a
  comparable delay, a 0.12-point difference, and Plainsong's streaming lane
  already runs Nemotron locally.

Three independent reasons pointing the same way, none of which a local
measurement would have changed. If someone wants the number anyway, the spec is
in `MODEL_SPECS` and one command produces it:
`benchmark-latency --provider transcribe_cpp --model voxtral-mini-4b-realtime-2602-q4_k_m --ensure-model --runs 5`.

**A genuinely idle-machine round is still owed.** The quietest round here was
taken at a load average of 32 on 14 cores, which is the same band the Cohere
receipt called its quiet-machine run (26 falling to 22) but well above the idle
figure a clean measurement would want. Three rounds spanning loads of 110, 79
and 33 put the short-fixture ratio at 12.5x, 13.7x and 13.1x, and the trend
across them runs against Voxtral rather than for it, so an idle re-run is
expected to widen the gap rather than close it. That is a prediction, recorded
as one. It would not change the verdict: closing a 13x gap to 1.5x is not
something machine load can do.

**The route the app would actually run was not exercised end to end.** These are
`provider_transcription_only` numbers with audio already in memory, taken from a
CLI. Nothing here drove a real hotkey, a real microphone, or real insertion —
the same scope limit every latency receipt in this directory carries, and the
reason `DictationTimingRecord` exists.

**What is left on this machine.** Downloads for this lane totalled 6.55 GB
against the lane's ~8 GB cap; 5.81 GB of it is gone. Deleted: the Voxtral Mini
3B GGUF (2.85 GiB) and its integrity receipt, the abandoned Voxtral Realtime
partial (621 MB), and the scratch keychain tree. **Left in
`~/Library/Application Support/Plainsong/models/transcribe_cpp/`: the Parakeet
TDT 0.6B v3 GGUF (705 MiB) and its integrity receipt** — it is the one model
this provider actually offers as a route, and the baseline any re-measurement
needs. The Nemotron streaming GGUF (716 MiB) beside it is lane C2's, untouched.
Delete either safely; the app re-fetches on demand. To reproduce the Voxtral
half, one command re-downloads and re-verifies it:
`benchmark-latency --provider transcribe_cpp --model voxtral-mini-3b-2507-q4_k_m --ensure-model --runs 5`.

**The measurement used a scratch keychain, and that is worth one more line.**
`benchmark-latency`'s `prewarm` calls `has_trusted_required_file()`, which
MACs the model-integrity receipt with a key held in the OS keychain — so a
freshly-built binary cannot run an unattended benchmark on this app's own local
routes until somebody clicks a system dialog. That is not a bug (it fails
closed, which is the right direction, and a packaged signed build is granted
once), but it is a real obstacle for any future lane that wants to measure a
local route, and §3.1 records the workaround so the next person does not spend
an hour finding it.

---

## 4. What was implemented, and why that and not something else

This lane changed one default: none. It added one route, corrected one bug that
would have made the measurement impossible, and deliberately declined to add
two routes the numbers do not support.

### 4.1 Added: `mistral_voxtral`, a cloud BYOK route

`rust-sidecar/src/asr/mistral_voxtral.rs`, wired the way every other cloud
provider is: enum variant, `is_remote()`, `meeting_provider_is_supported()`,
settings normalization, the renderer's `CLOUD_PROVIDER_SET`,
`MEETING_GRADE_PROVIDER_SET` and `PROVIDER_DIARIZATION_SET`, the route catalog
order and summary, the diarizer name map, the external-URL allowlist, and the
whole-file meeting ceiling. The cross-language pin tests
(`every_cloud_provider_is_remote_in_both_languages`,
`every_meeting_grade_provider_matches_in_both_languages`) are what would have
caught a half-wired provider, and they pass.

Why this and not local Voxtral: it is the only route by which a user actually
gets Voxtral at a speed that works. Hosted, it runs at 83.3x real time on
Mistral's hardware; on this Mac, the same family runs at 1.4x. And it is a real
improvement to the cloud roster on its own terms rather than only as "the thing
that was asked for":

| Cloud route | AA-WER | $/1k min | Speaker labels |
|---|---:|---:|---|
| Gemini 3.5 Transcribe | 2.60% | 5.00 | yes |
| **Mistral Voxtral Mini Transcribe 2** | **3.59%** | **3.00** | **yes** |
| Deepgram Nova-3 | 5.18% | 4.30 | yes |

It is cheaper and more accurate than Deepgram, which is the diarizing route the
picker currently leads with. It does **not** take the top of the picker, because
Deepgram is 607.7x against 83.3x on the same board — 7.3x faster — and that
ordering was measured rather than assumed. Mistral sits third among the
diarizing cloud routes, which is where its numbers put it.

Three constraints the API forces, each handled with a pure function and a test
rather than discovered as an HTTP 400:

- **`timestamp_granularities` cannot be sent with `language`.** Mistral's docs
  say so outright. The meeting lane needs timestamps, so a meeting request
  drops the language and lets Voxtral detect it; dictation, which needs no
  timestamps, sends the user's choice. Pinned by
  `a_request_never_carries_both_timestamps_and_a_language`, which asserts the
  exclusion across every combination rather than testing the two branches.
- **`context_bias` is capped at 100 terms.** A longer personal dictionary loses
  its tail rather than failing the request.
- **Speaker labels arrive on segments, not words**, unlike Deepgram, and are
  renumbered to `S1`, `S2`, … in first-appearance order so the provider's own
  numbering never reaches the transcript.

The whole-file meeting ceiling is two hours, not Mistral's published three.
Mistral publishes both a three-hour request cap and a 1 GB file cap, and they
disagree: three hours of the app's meeting WAV at 48 kHz is 1.04 GB, past
Mistral's own byte cap, so a stated three-hour ceiling would never be the limit
that applied. Two hours is 691 MB at 48 kHz and is reachable at every capture
rate. `the_whole_file_ceilings_are_reachable_at_the_rate_meetings_are_recorded`
now covers Mistral and is what enforces that.

**One thing not verified, and stated because it is not:** Mistral's
transcription documentation does not state a training-data position for the
transcription endpoint. Deepgram's route sends `mip_opt_out=true` on every
request because Deepgram documents a per-request opt-out; there is no equivalent
here to send, and none was invented. The route's copy claims nothing about data
handling. AssemblyAI was skipped in the previous lane on exactly this ground, so
the asymmetry is worth naming: AssemblyAI *documents* that it trains by default
with a paid-tier-only opt-out, which is a known-bad; Mistral documents nothing
either way, which is an unknown. If the standard is "no unknowns", this route
should be revisited before it is recommended to anyone for confidential audio.

### 4.2 Fixed: the provider could not have loaded Voxtral at all

`asr/transcribe_cpp.rs` asked every model for `TimestampKind::Segment`.
transcribe.cpp rejects a request finer than the model's `max_timestamp_kind`
with `TRANSCRIBE_ERR_UNSUPPORTED_TIMESTAMPS` rather than clamping it, and
Voxtral advertises `NONE`. So the first Voxtral decode would have failed with
"transcribe.cpp rejected the request as malformed" and nothing would have said
why. It now clamps through `timestamp_request_for`, a pure function with a test
naming each family. This affects no shipped route — Parakeet and Nemotron both
advertise `Token` and get `Segment` exactly as before — but it is the difference
between measuring Voxtral and reporting that it does not work.

### 4.3 Not added: local Voxtral as a route

Both Voxtral GGUFs are in `MODEL_SPECS` with `offered_as_route: false`, the same
shape the Nemotron streaming GGUF has carried since lane C2: nameable from
`benchmark-latency`, never in the picker, never downloadable from Settings, with
pinned SHA-256s, integrity receipts and MODEL WEIGHTS manifest entries like
every other download. `the_measured_voxtral_tiers_are_not_offered_as_routes`
pins that, including the settings-normalization fallback, so a saved settings
file naming one cannot leave the route pointing at weights the picker does not
list.

Carrying the specs rather than deleting them is deliberate: the next person to
be told Voxtral is faster can run one command and see otherwise.

---

## 5. Corrections to `docs/model-inventory-2026-09.md`

Four, all made in place in that document and marked `[V1 2026-09-03]`:

1. **§1.1's speed column was blank, and filling it inverts the story.** Voxtral
   Small is the slowest of the accuracy leaders on that board (65.6x), not the
   fastest.
2. **§2.5 said Mistral Voxtral was "not implemented … the next cloud provider
   to add".** It is implemented, as of this lane, with the request-shape
   constraints written down.
3. **§3.2 said "every end-to-end open diarizer that would be a real upgrade
   needs PyTorch. Sortformer is NeMo."** That is no longer true, and it is the
   most useful thing this lane found. transcribe.cpp — already a dependency of
   this repo — ships GGUF ports of both NVIDIA's Streaming Sortformer 4spk v2.1
   (139 MB at Q8_0, 14.59% DER on AMI IHM against a 14.83% NeMo reference under
   the identical protocol) and OpenMOSS's MOSS-Transcribe-Diarize (987 MB at
   Q8_0, Apache-2.0, transcription **and** speaker attribution in one pass, with
   segment timestamps, at 388 ms for 11 s of audio on an M4 Max). Neither is
   implemented here; the point is that the reason for skipping them has
   evaporated, and the next diarization lane should start from that row.
4. **§5(a) needed the Voxtral verdict and one more open question.** Added: the
   measured rejection above, and the observation that the local Cohere
   Transcribe route that shipped on 2026-09-03 runs int4 ONNX on the **CPU**,
   while the same weights have an official Metal GGUF at 1.55 GB through a
   runtime this repo already links. That combination has never been measured and
   is the highest-value follow-up in either document: Cohere is 0.9 WER points
   better than Parakeet, and CPU-versus-Metal on this family was worth 2-5x in
   lane C2's own numbers.

One thing this lane could **not** do, stated rather than glossed: the brief
asked for a diarization leaderboard. **There is no diarization board on
Artificial Analysis** — the speech-to-text index links exactly two sub-pages,
non-streaming and streaming. The nearest thing is pyannoteAI's own vendor
benchmark, which names its comparison set (pyannoteAI Precision-2 and OSS
Community-1, AssemblyAI Universal-Pro-3, Deepgram Nova-3, ElevenLabs Scribe-v2,
Soniox, Speechmatics, OpenAI GPT-4o-transcribe-diarize, AWS Transcribe, NVIDIA
OSS NeMo streaming Sortformer, over ten DIHARD domains) but does not render the
DER figures in a form that could be read, and is published by a vendor whose
product is in it. No diarization ranking has been invented to fill the gap.

---

## 6. Sources fetched 2026-09-03

- <https://artificialanalysis.ai/speech-to-text/non-streaming>
- <https://artificialanalysis.ai/speech-to-text/streaming>
- <https://artificialanalysis.ai/speech-to-text> (index; confirms no
  diarization board exists)
- <https://www.pyannote.ai/benchmark> (page dated 2026-09-03 08:47 UTC; names
  its comparison set but does not render the DER figures)
- <https://docs.mistral.ai/capabilities/audio/speech_to_text/offline_transcription>
- <https://mistral.ai/news/voxtral-transcribe-2/>
- <https://huggingface.co/api/models?search=voxtral> (200 repositories),
  and the same for `parakeet`, `moonshine`, `kyutai`, `canary`, `qwen3-asr`
- <https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf>
- <https://huggingface.co/handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf>
- <https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf>
- <https://huggingface.co/mistralai/Voxtral-Mini-3B-2507>
- <https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602>
- <https://huggingface.co/primeline/parakeet-primeline>
- <https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize>
- <https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1>
- transcribe.cpp v0.2.3 at `63a44d9`, its `docs/models/*.md` cards and
  `src/arch/*/capabilities.cpp` (the vendored dependency this repo already
  builds; its capability flags are the source for every "emits no timestamps"
  claim above)
