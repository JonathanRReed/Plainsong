# Typeless parity and model refresh (2026-09-24)

Research pass plus the first round of changes, prompted by Typeless
(typeless.com) and the NVIDIA Nemotron 3 Diarization release. Decisions taken
with Jonathan on 2026-09-24:

- Local models stay the default. Cloud routes stay bring-your-own-key. A paid
  hosted tier is a later idea, not part of this work.
- The finishing animation is an estimated progress bar that eases out and
  only completes when the text lands.
- There are no real users yet, so defaults may move once a change is built.
  Anything that needs Apple Silicon to measure is built and left for a Mac
  run before a default flips.

## 1. What Typeless actually does

Sources are listed inline. Most comparison pages are written by competing
dictation apps, so vendor claims are marked as such.

- **Cloud only.** Audio goes to AWS, is transcribed, rewritten by a
  third-party LLM, and discarded. There is no offline mode
  ([data controls](https://www.typeless.com/data-controls),
  [Spokenly review](https://spokenly.app/blog/typeless-review)). Independent
  reverse engineering found no local model in the app
  ([kocpc](https://en.kocpc.com.tw/archives/5421)).
- **Batch, not live.** Text appears after the hotkey is released. The app
  shows a voice bar while listening and a thinking state afterwards.
- **No source confirms an animation that slows near the end.** It may exist;
  confirming it needs a screen recording of the app.
- **"More accurate than Wispr Flow" is a vendor claim.** Typeless's own blog
  calls the raw accuracy difference "negligible"
  ([Typeless blog](https://www.typeless.com/blog/typeless-vs-wispr-flow)).
  The one comparison with a stated setup (identical audio, June 2026) found
  Typeless's rewrite adds words that were not said, which puts its WER well
  above Wispr Flow's ([voice-list.com](https://voice-list.com/compare/typeless-vs-wispr-flow/)).
- **Wispr Flow** targets 700 ms from end of speech to formatted text: under
  200 ms each for ASR, LLM and network, with fine-tuned Llama models on
  Baseten ([Wispr engineering post](https://wisprflow.ai/post/technical-challenges)).

What this means for Plainsong: Typeless's perceived quality comes from an
aggressive LLM rewrite and a calm finishing state, not from a better
recognizer. Plainsong can match the feel (the finishing bar below) and beat
it on the measurable part: verbatim accuracy, because `dictation_fidelity`
already rejects cleanup that changes the user's words, plus local
processing that Typeless cannot offer at all.

## 2. What changed in this round

### Finishing bar (on for everyone, no setting)

After the user stops speaking the HUD shows **Finishing, then Transcribing,
then Polishing** (Polishing only when an AI pass runs), with a thin bar in
both the full card and the minimal pill.

- The sidecar sends `expectedTranscribeMs` and `expectedPolishMs` with the
  `transcribing` event, and a `processingStage: "polishing"` event just before
  the first pre-insert AI pass (`rust-sidecar/src/dictation_session.rs`).
- Estimates are a moving average of what this Mac measured, per ASR route,
  with conservative priors for the first dictation
  (`rust-sidecar/src/dictation_progress.rs`). Nothing is written to disk.
- The bar eases toward the estimate: at the expected time a stage is about
  86% through its span, then it creeps. It stops at 94% on its own and only
  the `done` phase fills it (`src/lib/dictation-progress.ts`). It can run
  late, and it can never claim the text is ready before it is.
- Motion follows `DESIGN.md`: the fill moves by `transform`, not width, in
  the quiet bronze (`bg-gold-ambient`), and reduced motion swaps the
  per-frame animation for a slow step. Screen readers hear the stage name, not
  a made-up percentage.

### Accuracy harness

`bun run eval:asr-wer` scores ASR routes by word error rate against human
references (`scripts/eval-asr-wer.mjs`, scorer in `scripts/lib/asr-wer.mjs`).
Until now every WER figure in this repo was measured against another model's
output, so no claim about beating anyone could be backed.

- `docs/evals/asr-wer/prompts.json`: 24 dictation-style prompts covering
  messages, email, technical terms, names, numbers, spoken repairs and long
  run-ons.
- Record yourself reading them as `artifacts/asr-wer-audio/<id>.wav`, or run
  `node scripts/eval-asr-wer.mjs synthesize` for a quick synthetic set with
  macOS `say`. Synthetic audio flatters every model; quote real recordings.
- `node scripts/eval-asr-wer.mjs run --route parakeet --route whisper:large-v3-turbo`
  runs each clip through the release `benchmark-latency` binary and writes
  `artifacts/qa/asr-wer-<date>.json`.

The same set can score a Typeless or Wispr Flow transcript: paste each app's
output into a report by hand and use `scoreUtterance`. That is the only way
to make a "more accurate than Wispr Flow" claim that holds up.

### Sidecar builds on Linux again

`cargo check` and `cargo test` failed on Linux on five small cfg gaps
(`PendingDictationTarget`, the osascript fallback, a test-only `CFRange`, an
inferred `None`, and the Apple Speech helper parser). They are fixed, so the
sidecar compiles and its tests run on Linux hosts such as cloud sessions. Build with
`--no-default-features --features asr-all,sqlcipher,local-llm` (Metal is
macOS-only) and point `ORT_LIB_LOCATION` at an ONNX Runtime 1.28 library.
On Linux, 1,705 of 1,706 library tests pass; the one failure
(`apple_speech_diagnostics_reuse_supplied_readiness`) expects the Apple
Speech engine to be available, which is true only on macOS.

### xAI Grok speech-to-text (bring your own key)

A new dictation route, `xai_stt` (`rust-sidecar/src/asr/xai_stt.rs`), posts
to `https://api.x.ai/v1/stt` with the personal dictionary as `keyterm` fields.
The request and reply shapes come from `@ai-sdk/xai` 5.0.7 (Vercel's client
for the same endpoint) because docs.x.ai was blocked here; check them against
xAI's docs before calling the route qualified. It is dictation only: meetings
need xAI's per-request size and duration limits, which are not confirmed.
The key goes in Settings, API Keys, as "xAI Grok (transcription)".

### Model pin helper

`node scripts/pin-hf-artifact.mjs <repo> <file>` prints the commit, SHA-256
and size a model spec needs. The download manager re-hashes every file, so a
wrong pin fails closed.

## 3. Speech-to-text models, September 2026

Numbers are from the transcribe.cpp catalog (M4 Max, Metal, Q8_0, measured
2026-09-14) and the Artificial Analysis leaderboard. Neither has been
reproduced on Plainsong's own audio yet; the harness above is how to do it.

### Local

| Model | License | Size (Q8) | LibriSpeech clean | FLEURS en | Speed (Metal) | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Parakeet TDT 0.6B v3 (current default) | CC-BY-4.0 | 740 MB | 1.94% | 4.83% | 180-215x | 25 EU languages, timestamps |
| **Granite Speech 5.0 TurboCTC 470M** | Apache-2.0 | 506 MB | **1.33%** | **4.61%** | 300-410x | English only, no timestamps |
| **Qwen3-ASR 1.7B** | Apache-2.0 | 2.19 GB | 1.62% | 3.23% | 37-53x | 30 languages + auto-detect, no timestamps |
| Qwen3-ASR 0.6B | Apache-2.0 | 850 MB | 2.11% | n/a | faster | same languages |
| Cohere Transcribe 03-2026 | Apache-2.0 | 2.41 GB | 1.27% | 5.08% | 72-76x | 14 languages, needs a language hint |
| Nemotron 3.5 ASR Streaming 0.6B | OpenMDW-1.1 | 751 MB | 3.2-3.6% | n/a | 138-144x | the live-preview candidate already spiked |
| Voxtral Small 24B | Apache-2.0 | ~25 GB | AA-WER 2.8% | n/a | too slow | best open model on AA, not practical locally |

Recommendation:

1. **English dictation: Granite Speech 5.0 TurboCTC** becomes the default
   once the harness confirms it on real recordings. It beats Parakeet on both
   benchmarks and is smaller and faster. Dictation never uses timestamps.
2. **Other languages: Qwen3-ASR 1.7B** as the accurate option, Parakeet v3
   as the fast one. At ~40x a 10 s dictation decodes in about 250 ms.
3. **Meetings stay on Parakeet v3**, because meeting merge and diarization
   need timestamps and neither new model emits them.
4. Both new models run through transcribe.cpp, which the Sept 2 spike showed
   links next to whisper-rs, runs on Metal, and beat the ORT route. That spike
   recommended transcribe.cpp *replace* the ORT Parakeet route if it ships,
   not sit beside it. Granite 5 needs transcribe.cpp newer than 0.2.3, the
   latest on crates.io.

### Cloud (bring your own key)

Already shipped: OpenAI GPT Transcribe, ElevenLabs Scribe v2, Gemini 3.5
Transcribe, Mistral Voxtral, Deepgram Nova-3, Groq, Cohere.

From the Artificial Analysis non-streaming board:

| Model | AA-WER | Price | Status |
| --- | ---: | --- | --- |
| Grok Voice Transcribe 2.0 (xAI) | 2.3% | $0.10/h batch, $0.20/h streaming (reported) | **Added** as `xai_stt`, dictation only |
| MAI-Transcribe-2 (Microsoft, Azure) | 2.0% | $0.10/h promo to end of 2026 (reported) | Deferred: Azure's transcription SDK (`@azure/ai-speech-transcription` 1.0.0) exposes Fast Transcription and an LLM "enhanced mode" but no way to select MAI-Transcribe-2, and learn.microsoft.com was blocked |

StepAudio 3 ASR and Alibaba Fun-Realtime-ASR lead at 1.7% but are
China-hosted; worth a note in the provider picker, not a default slot.

## 4. Diarization: is Nemotron 3 the right move?

**Mostly yes, as the default for meetings of up to eight speakers, with the
current embedding pipeline kept as the fallback.**

For:

- End to end: one ~100M-parameter model replaces fixed 2 s windows, ECAPA
  embeddings and threshold clustering, which is where today's wrong speaker
  counts come from (`artifacts/qa/diarization-turn-floor-2026-09-03.md`).
- Handles overlapping speech, which the current pipeline cannot represent.
- Reported DER against NVIDIA's previous Sortformer: AMI SDM 11.1 vs 21.4,
  DIHARD III 12.7 vs 19.1, CALLHOME 9.1 vs 10.3
  ([NVIDIA blog](https://huggingface.co/blog/nvidia/nemotron-diarization),
  [Baseten](https://www.baseten.co/blog/nvidia-nemotron-3-diarization/)).
- Runs from Rust today: `parakeet-rs` 0.3.8 (MIT or Apache-2.0) ships it as
  `Sortformer` with offline and streaming modes, and pins the **same**
  `ort 2.0.0-rc.13` and `ndarray 0.17` Plainsong already uses. No second
  runtime, unlike speakrs, which needed OpenBLAS and failed to link.
- Streaming mode opens live speaker labels later, when streaming ASR lands.

Against:

- **Hard cap of eight speakers.** The current pipeline and speakrs have no
  cap. Large meetings need the fallback.
- pyannote community-1 (the speakrs spike) still wins on AMI far-field
  audio, per Baseten.
- The community ONNX export has not been scored against NVIDIA's numbers.
- License is OpenMDW-1.1. Commercial use is reported as allowed; the terms
  have not been read here. Do not use `Nemotron-3-Diarization-preview`, which
  is evaluation-only.

Built in this round:

- `rust-sidecar/src/diarization/nemotron_backend.rs` behind the
  `diarization-nemotron` Cargo feature (off by default, not shipped). It adds
  three crates to `Cargo.lock` (`parakeet-rs`, `eyre`, `indenter`) and no
  second ONNX Runtime.
- The turn rules speakrs used (stable `S1..Sn`, breath-gap merge, flicker
  drop, uncovered audio left unattributed) moved to `diarization/turns.rs`,
  so both end-to-end backends share one tested implementation.
- An ignored eval test, `eval_nemotron_backend`, next to the ECAPA and
  speakrs ones.

To score it on the Mac:

```bash
# 1. Fixture (writes artifacts/qa/diarization-speakrs/two-speaker-44s.wav and ground truth)
node scripts/make-diarization-eval-fixture.mjs
# 2. Download nemotron3_diar_v3.onnx from
#    https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-3-diarization
# 3. Run it
PLAINSONG_DIAR_EVAL_AUDIO=artifacts/qa/diarization-speakrs/two-speaker-44s.wav \
PLAINSONG_NEMOTRON_DIAR_ONNX=~/Downloads/nemotron3_diar_v3.onnx \
  node scripts/cargo-sidecar.mjs test --features diarization-nemotron --lib \
  diarization::eval_tests::eval_nemotron_backend -- --ignored --nocapture > nemotron.txt
# 4. Score against the same ground truth ECAPA (10.8%) and speakrs (7.5%) used
node scripts/score-diarization-eval.mjs \
  --ground-truth artifacts/qa/diarization-speakrs/two-speaker-44s.ground-truth.json \
  --result nemotron.txt
```

If it wins: pin the ONNX with `pin-hf-artifact.mjs`, add it to the
diarization picker, make it the default, and fall back to ECAPA when a
meeting needs more than eight speakers or the model is missing.

## 5. Blocked in this session

This cloud session's network policy denies the hosts below, so these items
are researched but not built:

| Item | Needs | Why |
| --- | --- | --- |
| Qwen3-ASR 1.7B and Granite 5 routes | `huggingface.co` | Every model spec pins a repo commit and SHA-256 |
| Granite 5 | `github.com` | Support is only on transcribe.cpp main, not the crates.io 0.2.3 release |
| Nemotron diarization as a user-facing option | `huggingface.co` | Pin for the ONNX export (the eval spike is built) |
| MAI-Transcribe-2 | `learn.microsoft.com` | How to select the model on Azure's API is not in any reachable source |
| Qualifying the xAI route | `docs.x.ai` | Built from Vercel's client; confirm against xAI's docs and add meeting limits |

## 6. Recommended next defaults

- **Smart Format on by default**, gated on the bundled cleanup model being
  downloaded and warm. Without that gate every dictation would carry an
  "AI formatting was unavailable" warning. This is the part of Typeless
  people notice, and Plainsong's version keeps the user's words.
- **Granite 5 as the English dictation default** after the WER run.
- **Nemotron 3 diarization as the meeting default** after the frame-error run.

## 7. Adversarial pass against Typeless (round 2)

Three read-only audits (feature parity, a bug hunt on round 1, and a HUD
review with screenshots of every state in both themes) found that the
biggest gap was not the models or the animation: **a fresh install removed
nothing from messy speech.** "Um so I think we should uh meet on Tuesday no
wait Wednesday at 3 and bring the the slides" went in verbatim, and turning
on AI formatting did not help, because the fidelity check rejected every
edit Typeless is known for, including edits the Apple on-device model was
told to make.

### Parity after this round

| Typeless feature | Plainsong now | Where |
| --- | --- | --- |
| Removes um/uh | **On by default**, on this Mac | `dictation_cleanup.rs` |
| Removes stutters ("the the") | **On by default**, function words only | `dictation_cleanup.rs` |
| Keeps the final version of a correction | **On by default** for days, months, numbers and times, including "Tuesday. No wait, Wednesday." Untyped restarts go to the AI pass. | `dictation_cleanup.rs` |
| AI polish | Optional; now allowed to make the same safe edits and write "three thirty" as "3:30", still rejects changed words and dropped negations | `dictation_fidelity.rs` |
| Voice bar with Listening / Thinking | Pill by default: Listening trace, then Finishing, Transcribing, Polishing with a progress bar, then Inserted | `dictation-popup.tsx`, `dictation-hud-status.ts` |
| Honest failure states | Better than Typeless: "Not inserted", "No speech", "Mic blocked" instead of a generic state | `dictation-hud-status.ts` |
| Tone per app | Local punctuation per app category, now with whole-word matching and bundle ids for the common apps; full tone rewrite needs the AI pass | `text/format.rs` |
| Spoken lists | Notes mode splits sentences and short item lists, no longer every comma | `dictation_text.rs` |
| Works offline, audio stays local | Plainsong only | |
| 100+ languages, auto-detect | Parakeet covers 25; Whisper and cloud routes cover more. Qwen3-ASR 1.7B is the planned local answer | §3 |
| Whisper / quiet mode | Not built | next |
| Free-form voice edit on a selection ("make this friendlier"), "Help me write" | Fixed command phrases only | next |

Every cleanup rule was written against the existing fidelity promises and
their tests: "Ah", "ER", quoted words, intentional "like", real doubles
("had had", "that that") and repeated answers ("Agreed. Agreed.") are all
kept, and a dictation of only "um" is never emptied.

### Bugs fixed from the round 1 review

- Pill showed a full gold bar and "Ready" after a secure-field refusal, an
  empty result or an undo.
- WER scorer counted a correct transcript that wrote "555-1234", "$4,250",
  "8.2%" or "14th" as several errors, which would have ranked routes wrong.
- A HUD reopened mid-session lost its stage and could stick at 94%.
- The timing estimate let one cold start set it outright and mixed local
  and remote AI times.
- xAI ignored the language setting, mislabelled every result as English,
  and failed on a reply with no text.
- The waveform restarted its draw loop and blanked the canvas on every
  level sample, a visible flicker.

### Next, by expected user impact

1. Free-form voice edits on a selection, plus "Help me write" on an empty
   one: the transform path already exists (`run_custom_dictation_transform_*`)
   and skips the word-by-word check by design.
2. Quiet-speech mode: normalize dictation audio gain before ASR, with a cap.
3. Smart Format on by default once the cleanup model is downloaded (§6).
