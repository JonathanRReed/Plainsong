# Speech model inventory — September 2026

Researched 2026-09-02. Every claim below is either a link to a vendor or
leaderboard page fetched on that date, or a measurement taken in this repo
(marked as such). Nothing here is a Plainsong qualification unless it says
"verified in Plainsong".

Two standing caveats:

- **Leaderboard WER is not your WER.** Artificial Analysis and the Open ASR
  Leaderboard both average over corpora that are not meeting audio recorded
  through a Mac's system-audio tap. Treat the ordering as a shortlist, not a
  ranking for this product.
- **Latency numbers taken in this repo are provisional** unless the receipt
  says the machine was quiet. Several parity lanes share one M4 Pro and one
  cargo target directory; load average during the receipts cited below ran
  16–45.

---

## 1. Speech-to-text: what leads, and what Plainsong ships

### 1.1 Cloud / hosted

From <https://artificialanalysis.ai/speech-to-text> (fetched 2026-09-02).
"AA-WER" is their own aggregate; lower is better. "Speed factor" is their
throughput multiple over real time.

| Model | Vendor | AA-WER | Speed | In Plainsong? |
|---|---|---|---|---|
| Fun-Realtime-ASR-preview | — | 1.7% | — | no (preview, realtime-only) |
| Scribe v2 | ElevenLabs | 2.2% | — | **yes** (`elevenlabs_scribe`) |
| MAI-Transcribe-1.5 | Microsoft AI | 2.4% | — | no |
| Pulse Pro | Smallest AI | 2.4% | — | no |
| **Gemini 3.5 Transcribe** | Google | **2.6%** | — | **added this lane** |
| Voxtral Small | Mistral | 2.8% (best open weights) | — | no |
| Nova-3 | Deepgram | — | **607.7× real time** (fastest listed) | **added this lane** |

Deepgram's Nova-3 is the speed leader on that page by a wide margin and is not
in the accuracy top five; Gemini 3.5 Transcribe is in the accuracy top five and
is the only one of them that also returns diarization and word timestamps from
a documented public API at a published per-minute price. Those two are the ones
this lane implemented; §2 says why the others were left out.

Already shipped in Plainsong before this lane: OpenAI `gpt-transcribe` /
`whisper-1` / `gpt-4o(-mini)-transcribe`, Groq `whisper-large-v3(-turbo)`,
ElevenLabs `scribe_v2`, Cohere `cohere-transcribe-03-2026`.

### 1.2 Local / open-weights

Open ASR Leaderboard figures as summarised on
<https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/>
(fetched 2026-09-02; the HF Space itself renders its table client-side and
could not be read by fetch). RTFx is the leaderboard's own throughput metric on
their reference hardware — **not** Apple Silicon, and not comparable to the
wall-clock numbers this repo measures.

| Model | Params | WER | Languages | RTFx | License | Apple Silicon runtime | In Plainsong? |
|---|---|---|---|---|---|---|---|
| ARK-ASR-3B | 3B | 5.04% | — | — | Apache-2.0 | none published | no |
| MOSS-Transcribe-preview-2B | 2B | ~5.0% | 50+ | — | Apache-2.0 | none published | no |
| Granite Speech 4.1 2B | 2B | 5.33% | 6 | 231 | Apache-2.0 | none published | no |
| **Cohere Transcribe 03-2026** | 2B | **5.42%** | 14 | — | **Apache-2.0** | **ONNX** (`onnx-community/cohere-transcribe-03-2026-ONNX`) and GGUF (`cstr/…-GGUF`) | cloud only today |
| Canary-Qwen-2.5B | 2.5B | 5.63% | 1 (en) | 418 | CC-BY-4.0 | NeMo only | no |
| Qwen3-ASR-1.7B | 1.7B | 5.76% | 52 | — | Apache-2.0 | ONNX exists for 0.6B | 0.6B only |
| **Parakeet TDT 0.6B v3** | 0.6B | 6.32% | 25 | **3332** | CC-BY-4.0 | ONNX (shipped), GGUF via transcribe.cpp | **yes, default** |
| Kyutai STT | 1–2.6B | 6.40% | 2 | — | CC-BY-4.0 | none published | no |
| Whisper large-v3 | 1.55B | — | 99 | 68 | MIT | whisper.cpp (shipped), Candle (shipped) | **yes** |
| Meta Omnilingual ASR | 0.3–7B | varies | 1600+ | — | Apache-2.0 | none published | no |

Plainsong's local roster today: whisper.cpp (tiny…large-v3-turbo),
Parakeet TDT 0.6B v3 + legacy TDT-CTC 110M, Distil-Whisper large-v3.5,
Whisper large-v3-turbo via Candle, Moonshine tiny/base, Qwen3-ASR 0.6B,
Apple Speech (on-device), Windows SDK dictation.

**The one clear gap is Cohere Transcribe 03-2026 as a *local* route.** Plainsong
already calls it as a cloud API; the same weights are Apache-2.0 with a
community ONNX export, and ONNX Runtime is already linked into this sidecar. It
is the highest-WER-ranked open model with a runtime this app can already load.
That is a download-and-wire-up job, not a new runtime — see §5(b).

Everything else near the top of the open list (ARK, MOSS, Granite, Canary-Qwen,
Kyutai, Omnilingual) needs PyTorch/NeMo. Plainsong ships no Python, so those are
out until someone exports them.

---

## 2. Cloud providers missing from Plainsong

Fetched 2026-09-02. Prices are list pay-as-you-go and change.

### 2.1 Deepgram Nova-3 — **implemented in this lane**

| | |
|---|---|
| Endpoint | `POST https://api.deepgram.com/v1/listen` (<https://developers.deepgram.com/docs/pre-recorded-audio>) |
| Auth | `Authorization: Token <key>` |
| Upload | raw request body with the audio's own `Content-Type` (e.g. `audio/wav`) — **not** multipart |
| Models | `nova-3`, `nova-3-medical`; `language=multi` for code-switching |
| Diarization | `diarize=true` (documented, still supported; routes to the v1 diarizer). `diarize_model=latest\|v1\|v2` is the newer selector, v2 batch-only. Word objects carry `speaker` (integer) and `speaker_confidence`. <https://developers.deepgram.com/docs/diarization> |
| Keyterms | `keyterm=<term>` repeated per term, Nova-3 only, 500 tokens per request max. <https://developers.deepgram.com/docs/keyterm> |
| Timestamps | word-level `start`/`end` in seconds; `utterances=true` adds turn-level objects; `smart_format=true` for punctuation/formatting |
| Price | $0.0043/min Nova-3 monolingual, $0.0052/min multilingual. **Diarization is included at no extra cost for pre-recorded audio.** Keyterm prompting carries a $0.0013/min surcharge on *streaming* — the pricing page lists no batch surcharge. <https://deepgram.com/pricing> |
| Limits | 2 GB upload; a request that takes over ~10 minutes to *process* returns 504 (at 600× real time that is many hours of audio) |
| Data terms | **Requires an explicit opt-out.** Deepgram's Model Improvement Partnership Program is the only path by which customer audio enters training, and it is turned off per request with `mip_opt_out=true`; opted-out data "is retained only for the duration necessary to process the request". The docs describe participation as voluntary while third-party summaries describe standard pricing as assuming participation — the two readings disagree, so **Plainsong sends `mip_opt_out=true` on every request unconditionally** and does not rely on the account default. <https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program> |

### 2.2 Google Gemini 3.5 Transcribe — **implemented in this lane**

| | |
|---|---|
| Announced | 2026-08-26, public preview in the Gemini API; successor to Chirp 3 |
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/interactions` |
| Models | `gemini-3.5-transcribe` (files), `gemini-3.5-transcribe-live` (websocket, no diarization — not used here) |
| Upload | **Files API only.** The transcription guide documents no inline-audio form: resumable upload to `POST /upload/v1beta/files` (`X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start` → an upload URL in the `x-goog-upload-url` response header → `upload, finalize`), poll `GET /v1beta/{name}` until `state` is `ACTIVE`, then pass the `uri`. <https://ai.google.dev/gemini-api/docs/files> |
| Request | `{"model":…, "input":[{"type":"audio","uri":…, "mime_type":"audio/wav"}], "generation_config":{"transcription_config":{"language_codes":[…], "custom_vocabulary":[…], "mode":{"type":"verbatim","diarization_mode":"speaker","timestamp_granularities":["word"]}}}}` |
| Response | transcript at `interaction.output_text`; per-word detail in `steps[].content[].annotations[]` entries of `"type":"word_info"` with `text`, `speaker` (`"spk_1"`), `start_offset`/`end_offset` (`"0.100s"` duration strings) |
| Diarization | up to 8 speakers; "attribution for 3 or more speakers is experimental" |
| **Mutual exclusion** | `custom_vocabulary` **cannot** be combined with `diarization_mode` or `timestamp_granularities`. Confirmed by Google staff on 2026-09-01 in <https://discuss.ai.google.dev/t/gemini-3-5-transcribe-documented-custom-vocabulary-diarization-timestamps-configuration-is-rejected-by-the-interactions-api/180240> — HTTP 400 `custom_vocabulary is incompatible with timestamps.` / `… with diarization.` The docs are being corrected, not the API. |
| Limits | 1 hour per request; **30 minutes** when diarization or word timestamps are on |
| Price | $0.005/min file, $0.009/min live |
| Data terms | **Tier-dependent.** Paid tier: "Google doesn't use your prompts … or responses to improve our products", 30-day security logging only. Free tier: content is used "to provide, improve, and develop Google products" and "human reviewers may read, annotate, and process your API input and output". <https://ai.google.dev/gemini-api/terms>. Plainsong cannot tell which tier a BYOK key is on, so the picker says so in words. |

Consequence for Plainsong, and it is not cosmetic: **the meeting lane needs
timestamps, so a Gemini meeting request cannot carry the user's personal
dictionary.** Dictation, which needs no timestamps, can. The provider
implements exactly that split and the audit log reports how many hint terms
actually went out (0 for a meeting request).

### 2.3 AssemblyAI Universal — **researched, deliberately not implemented**

Endpoint shape is a three-step async flow: `POST /v2/upload` → `POST /v2/transcript`
with `speaker_labels: true`, `keyterms_prompt: […]`, `speech_models: ["universal-3-5-pro"]`
→ poll `GET /v2/transcript/{id}` until `status: "completed"`; `utterances[]` then
carry `speaker`, `text`, `start`, `end` (milliseconds).
Price $0.21/hr async Universal-3.5 Pro, $0.15/hr Universal-2, diarization +$0.02/hr.

**Skipped on data terms.** Model-improvement data sharing is on by default, and
the opt-out is an account-level toggle in the AssemblyAI dashboard available to
**paid customers only** — "free users do not have the ability to opt out of the
model improvement program", and changes are "forward-looking only".
<https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program>

There is no per-request parameter Plainsong could send to guarantee the opt-out,
and no API surface that reports whether a given key's account has it set. The
brief's rule is to skip a provider that trains on user data by default without a
zero-data-retention option Plainsong can actually rely on; a dashboard toggle on
someone else's account, unavailable on the free tier, is not that. Deepgram
passes the same test only because `mip_opt_out=true` is per request and
Plainsong always sends it. **Revisit if AssemblyAI ships a per-request opt-out.**

### 2.4 Soniox — not implemented

`stt-async-v5`, ~$0.10/hr async, diarization + language ID + smart formatting
bundled at no surcharge, 60+ languages, speaker labels in the same response.
<https://soniox.com/pricing>. This is the cheapest diarizing option found and
worth a future lane; it lost this round only to Deepgram (speed leader, cheaper
still per minute at Nova-3 mono, and a much simpler one-shot HTTP shape) and
Gemini (accuracy leader). Its published data-retention terms were not verified
in this pass, which must happen before it is added.

### 2.5 Mistral Voxtral API — not implemented

`POST https://api.mistral.ai/v1/audio/transcriptions`, `voxtral-mini-transcribe`
(V2, 26-02 card), $0.003/min, ~4% WER on FLEURS, returns speaker labels and
start/end times. <https://mistral.ai/news/voxtral-transcribe-2/>. Attractive on
price and it is the vendor of the best open-weights model on the AA board
(Voxtral Small, 2.8%). Not added this lane purely on budget; it is the next
cloud provider to add, ahead of Soniox, because Plainsong already registers a
`mistral` credential slot.

---

## 3. Diarization

### 3.1 What Plainsong runs today

An embedding-and-cluster pipeline in `rust-sidecar/src/diarization/`: fixed 2 s
windows hopped 1 s, a speaker-embedding ONNX model per window, agglomerative
hierarchical clustering with centroid linkage, then boundary smoothing and a
word-proportional merge onto the transcript. Four selectable embedders:
`ecapa_tdnn_speaker` (default), `campplus_speaker`, `resnet34_speaker`,
`eres2netv2_speaker`. No overlap handling, no VAD-driven segmentation, no
end-to-end diarizer.

### 3.2 Open diarization models worth knowing about

| Model | What it is | License | Runtime | Notes |
|---|---|---|---|---|
| pyannote **community-1** | full pipeline (segmentation + embedding + clustering), pyannote.audio 4.0 | CC-BY-4.0 | PyTorch | the open baseline everyone benchmarks against; includes transcript/diarization timestamp reconciliation |
| pyannote **precision-2** | hosted premium pipeline | commercial API | pyannoteAI | vendor claims 28% more accurate than community-1 |
| NVIDIA **Streaming Sortformer 4spk v2** | end-to-end neural diarizer, arrival-order speaker cache | CC-BY-4.0 | NeMo (PyTorch) | 13.24 DER on DIHARD III eval (1–4 spk, no collar); **max 4 speakers**, degrades at 5+ |
| 3D-Speaker / WeSpeaker embedders | embedding extractors only, not pipelines | Apache-2.0 | ONNX exports exist | this is the family Plainsong already ships (CAM++, ERes2NetV2, ResNet34) |

Sources: <https://huggingface.co/pyannote/speaker-diarization-community-1>,
<https://www.pyannote.ai/blog/community-1>,
<https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2>.

The honest summary: **every end-to-end open diarizer that would be a real
upgrade over Plainsong's embedding pipeline needs PyTorch.** Sortformer is NeMo.
community-1 is pyannote.audio. Neither has a maintained ONNX export of the whole
pipeline. Swapping embedders (which is what Plainsong can do today) changes the
embedding quality but not the segmentation, and segmentation — fixed 2 s windows
with no overlap handling — is where this pipeline actually loses.

### 3.3 Lane C2 / C3 / C6 findings

**Not verifiable in this worktree.** `artifacts/qa/` here contains only
`acceleration-receipt-2026-09-01.md` and `bundled-cleanup-receipt-2026-09-02.md`;
`diarization-speakrs-spike-2026-09-02.md`, `transcribe-cpp-spike-2026-09-02.md`
and the C6 calibration receipt are not merged into `parity-waves` at
`83714b5f`, and `speakrs` / `transcribe.cpp` appear nowhere in the tree. Their
results are reported here second-hand and must be re-read from the receipts
before anything is decided on them:

- **C3 / speakrs (pyannote community-1 in Rust):** better accuracy, 10–14×
  slower, distributed as an unlicensed mirror. Reported, not seen.
- **C2 / transcribe.cpp (Parakeet GGUF on Metal):** 96 ms / 561 ms on the 5.3 s
  and 44 s fixtures, versus 196 ms / 1335 ms for the shipped ONNX-Runtime CPU
  path, taken under load. Reported, not seen.

### 3.4 Cloud diarization

| Provider | Speaker labels | Where they appear | Extra cost |
|---|---|---|---|
| Deepgram Nova-3 | yes, `diarize=true` | per **word**: `speaker` int + `speaker_confidence` | none for pre-recorded |
| Gemini 3.5 Transcribe | yes, `diarization_mode:"speaker"`, ≤8 speakers | per word: `speaker: "spk_N"` | none, but excludes custom vocabulary |
| AssemblyAI Universal | yes, `speaker_labels: true` | `utterances[]` with `speaker` | +$0.02/hr |
| Soniox | yes | same response as the transcript | none |
| Mistral Voxtral | yes | speaker labels with start/end | not stated |
| OpenAI / Groq / ElevenLabs / Cohere (already shipped) | **no** | — | — |

None of the four cloud providers Plainsong already shipped return speaker
labels. That is the actual reason a "provider diarization" feature needed a new
provider first.

---

## 4. What this lane changed

1. `deepgram` provider (`nova-3`, `nova-3-medical`) — batch upload, `diarize`,
   `keyterm`, `smart_format`, `utterances`, word timestamps, unconditional
   `mip_opt_out=true`.
2. `gemini_transcribe` provider (`gemini-3.5-transcribe`) — Files API upload,
   word timestamps, diarization, custom vocabulary on the dictation path only,
   and the upload deleted again after each transcription.
3. Provider speaker labels are carried through the meeting transcript contract
   as ordinary `speaker_id` values (`S1`, `S2`, …), so the existing rename/alias
   flow works on them unchanged, and the meeting header names which diarizer
   produced them.
4. Settings → API keys now lists the transcription services. It had entries
   only for the language-model providers, while every cloud speech route's
   setup text said to add a key there — and since the packaged app strips API
   keys out of the sidecar's environment, the keychain was the only route and
   it was unreachable. ElevenLabs, Groq and Cohere were affected as well.

**The limitation to know about.** The meeting lane transcribes in 90-second
chunks, and a provider's speaker numbering is scoped to one request — "speaker
0" in chunk 4 is not necessarily "speaker 0" in chunk 1. So provider labels are
only used when the whole recording went out in **one** request. To make that
the normal case rather than a curiosity, a single-source meeting now goes to a
diarizing provider whole, within that provider's own documented ceiling:
Deepgram up to two hours, Gemini up to thirty minutes. Both recordings are
streamed off disk rather than buffered in memory. The Gemini figure is
Google's own cap for a request that asks for diarization or word timestamps.
The Deepgram figure is Plainsong's, not Deepgram's: Deepgram documents no
duration cap, only a 2 GB request size and a ten-minute processing ceiling
(HTTP 504). Two hours of the app's meeting WAV (mono 16-bit PCM at the capture
rate) is 230 MB at 16 kHz and 691 MB at 48 kHz, inside Plainsong's own 1 GiB
request cap and well inside Deepgram's 2 GB; processing it costs about
12 seconds at the 607.7x real time published for Nova-3. Past the ceiling, or when the
single request fails, the meeting falls back to 90-second chunks with
Plainsong's own diarizer, and both the audit log and the meeting header say
which one ran.

---

## 5. Ranked recommendations

### (a) Best local model for quick, accurate dictation on Apple Silicon

Ranked on end-of-utterance latency for a short (~5 s) utterance first, WER
second, because for dictation a model that is 0.5% better and 1.4 s slower is
worse.

| Rank | Route | 5.3 s fixture | 44 s fixture | WER rank | Runtime |
|---|---|---|---|---|---|
| 1 | **Parakeet TDT 0.6B v3, ONNX Runtime CPU** (shipped default) | 196 ms † | 1335 ms † | 6.32% | ORT CPU |
| 1= | Parakeet TDT 0.6B v3 via transcribe.cpp Metal | 96 ms † | 561 ms † | same weights | **not in this tree** |
| 3 | whisper.cpp `base.en` | — | — | worse than Parakeet on this repo's own fixtures | whisper.cpp |
| 4 | Moonshine base | 1.7 s p50 on the 44 s fixture (CPU) | — | short-form only | ORT CPU |
| 5 | Distil-Whisper large-v3.5 | 0.96 s p50 Metal / 32.8 s CPU | 2.6 s / 55.5 s | English only, 2.9 GiB | Candle Metal |
| 6 | Qwen3-ASR 0.6B | 0.8–1.7 s | 11–59 s | experimental | ORT CPU, int4 decoders |

† transcribe.cpp and ORT-CPU numbers as reported by lane C2, under load, not
reproduced in this worktree. Distil/Qwen numbers from
`artifacts/qa/acceleration-receipt-2026-09-01.md` and
`docs/model-inventory-upgrades.md`, also under load.

**Parakeet TDT 0.6B v3 should stay the default.** It is the fastest thing here
with a real language list, it is a transducer so it stays silent through pauses
(the single most visible dictation property), and it is already shipped and
verified.

Replace it only when one of these is true, with a receipt:

- **transcribe.cpp Metal** — replace the *runtime*, not the model, once (i) the
  spike is merged and re-measured on a quiet machine, (ii) its licence and
  provenance are clean enough to vendor, and (iii) it survives the same
  fixture set. A 2× latency win on the same weights is worth a runtime swap;
  a number taken under load average 30 is not.
- **Cohere Transcribe 03-2026 (local, ONNX)** — replace the *model* if its
  measured Apple-Silicon latency on the 5 s fixture lands within ~1.5× of
  Parakeet's. It is 0.9 WER points better and Apache-2.0. It is 2B parameters
  against Parakeet's 0.6B, so the plausible outcome is that it wins on
  meetings and loses on dictation. Measure before deciding.
- **Nemotron ASR GGUF** — no. The coordinator's brief names it; nothing in this
  research found a Nemotron ASR release that beats Parakeet TDT v3 on the Open
  ASR Leaderboard with a runtime this app can load. Do not swap on the strength
  of a name.

### (b) Best local model for meetings (long-form, multilingual, timestamps)

1. **Parakeet TDT 0.6B v3** for the 25 languages it covers — fastest long-form
   route by a wide margin, per-segment timestamps, already the meeting default.
2. **whisper.cpp `large-v3-turbo`** for everything Parakeet cannot hear
   (Mandarin, Hindi, Arabic, and ~75 more). Slower, 1.6 GiB, but it is the only
   local route to those languages with timestamps. Already shipped and already
   gated to multilingual `small`+ models for meetings.
3. **Cohere Transcribe 03-2026 (ONNX) — the upgrade to go get.** 5.42% WER, 14
   languages, Apache-2.0, an existing community ONNX export, and ONNX Runtime is
   already linked. It would sit between the two above: better WER than Parakeet,
   far fewer languages than Whisper, and unknown Apple-Silicon speed. This is
   the single highest-value local model work left.
4. Not Distil-Whisper (English only, 2.9 GiB), not Qwen3-ASR (slower than real
   time on CPU — a meeting can take longer to transcribe than it took to hold).

### (c) Best cloud models

**Dictation** (latency dominates; no timestamps needed; vocabulary hints matter):

1. **Deepgram Nova-3** — 607× real time, $0.0043/min, keyterm prompting,
   per-request training opt-out. Fastest and cheapest of everything shipped.
2. **Groq whisper-large-v3-turbo** (already shipped) — the incumbent speed
   option; Deepgram beats it on price and on vocabulary biasing.
3. **Gemini 3.5 Transcribe** — best accuracy of the group and it accepts
   `custom_vocabulary` when timestamps are off, which is exactly the dictation
   case. Held back only by the free-tier training terms.
4. OpenAI `gpt-transcribe` (already shipped) — fine, no diarization, no
   published WER on these boards.

**Meetings** (timestamps and speaker labels dominate; per-minute price matters
because meetings are long):

1. **Deepgram Nova-3** — diarization free, word timestamps, whole-file upload,
   $0.26/hour. Best cost-per-meeting of anything with speaker labels.
2. **Gemini 3.5 Transcribe** — best WER (2.6%) with diarization and word
   timestamps, $0.30/hour, but capped at 30 minutes per diarized request and it
   cannot take the personal dictionary at the same time.
3. **ElevenLabs Scribe v2** (already shipped) — best WER of the incumbents
   (2.2%) but returns no speaker labels, so meetings still pay for local
   diarization on top.
4. Soniox and Voxtral Mini Transcribe are cheaper than all of the above with
   diarization included; they are the next two to add.

Skipped on terms: **AssemblyAI** (§2.3).

### (d) Best diarization, and what Plainsong should ship

**Default: unchanged — Plainsong's local ECAPA-TDNN embedding pipeline.** It is
the only diarizer that works with no key, no upload and no cloud provider, and
the meeting lane's most common route is local. Do not make a cloud diarizer the
default.

**Optional, on by default *when the meeting already ran through a diarizing
cloud provider*: that provider's own labels.** The audio has already been sent
and already been paid for; asking the machine to re-derive speakers from it
locally is strictly worse. `meetings.preferProviderDiarization` (default true)
governs this, and the header names the diarizer either way so the user is never
guessing.

Ranked, cloud:

1. **Deepgram** — per-word labels with per-word confidence, free on pre-recorded,
   no speaker-count ceiling documented, whole-file upload. Best of the four.
2. **Soniox** — bundled free across 60+ languages; not yet implemented.
3. **Gemini** — good, but ≤8 speakers, "3 or more is experimental" by Google's
   own words, 30-minute cap, and it costs you the vocabulary hint.
4. **AssemblyAI** — utterance-level labels are the nicest shape of the four, but
   the data terms rule it out (§2.3).

Ranked, local, if someone wants to improve the offline path:

1. **Fix segmentation before swapping embedders.** Fixed 2 s / 1 s windows with
   no VAD and no overlap handling is the dominant error source; a better
   embedding on a badly-placed window is still a badly-placed window. This is
   the cheapest real accuracy win available and needs no new model.
2. **Sortformer 4spk v2** if someone exports it to ONNX — end-to-end, 13.24 DER,
   CC-BY-4.0, but hard-capped at 4 speakers, which rules out plenty of meetings.
3. **pyannote community-1 via speakrs** only if lane C3's numbers survive
   re-reading *and* the licensing of the mirror is resolved. 10–14× slower for
   better accuracy is a defensible trade for a post-meeting pass that already
   runs in the background — but not on an unlicensed mirror.
4. Keep CAM++ / ResNet34 / ERes2NetV2 as user-selectable alternates. Nothing in
   this research says one of them should become the default; lane C6's
   calibration receipt, when merged, is the evidence that would.

---

## Sources fetched 2026-09-02

- <https://artificialanalysis.ai/speech-to-text>
- <https://huggingface.co/spaces/hf-audio/open_asr_leaderboard> (table not
  server-rendered; figures taken from the summary linked below)
- <https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/>
- <https://developers.deepgram.com/docs/pre-recorded-audio>
- <https://developers.deepgram.com/docs/diarization>
- <https://developers.deepgram.com/docs/keyterm>
- <https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program>
- <https://deepgram.com/pricing>
- <https://ai.google.dev/gemini-api/docs/transcribe>
- <https://ai.google.dev/gemini-api/terms>
- <https://discuss.ai.google.dev/t/gemini-3-5-transcribe-documented-custom-vocabulary-diarization-timestamps-configuration-is-rejected-by-the-interactions-api/180240>
- <https://www.assemblyai.com/docs/api-reference/transcripts/submit>
- <https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program>
- <https://soniox.com/pricing>
- <https://mistral.ai/news/voxtral-transcribe-2/>
- <https://huggingface.co/pyannote/speaker-diarization-community-1>
- <https://www.pyannote.ai/blog/community-1>
- <https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2>
- <https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX>

### Text-to-speech

The user's two links were text-to-speech and were sent by mistake; the TTS
read-back evaluation was cancelled by the coordinator on 2026-09-02 and is not
in this document. For the record, the one fact worth keeping from the partial
pass: Breeze-TTS-2 is 3B parameters, PyTorch/CUDA-only, and its weights are
under a "BreezeBlue Research and Non-Commercial License", so it could not ship
in Plainsong regardless of quality.
