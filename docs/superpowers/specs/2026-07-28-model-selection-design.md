# Model selection design

Date: 2026-07-28

Let users choose the speech model and the AI models Plainsong uses, with honest
guidance about what each choice costs and buys. Curated few by default, full
catalogue for people who want it.

## Why

Two gaps, found by reading the code rather than the roadmap.

**The LLM side never got lanes.** ASR already models per-task choice —
`asr-route-catalog.ts` carries a `lane` of `shared | dictation | meeting`, and
`AsrProviderManager` persists `defaultModelId`, `dictationModelId`, and
`meetingModelId` separately. The LLM side has exactly one global pair,
`privacy.llm_provider` + `privacy.llm_model_id` (settings.rs:437-439), and that
single choice drives dictation cleanup, meeting summaries, action items, and
meeting Q&A. Dictation cleanup runs on every capture behind a 6s timeout;
summarization is batch work that can afford a bigger model. One setting cannot
serve both.

**Nothing surfaces the language dimension.** `asr-capabilities.ts` has no
language field at all. The download manager already offers 11 Whisper models,
six of which are multilingual (`tiny`, `base`, `small`, `medium`, `large-v3`,
`large-v3-turbo`) — but a user cannot tell those apart from the `.en` builds
anywhere in the UI. We were not missing multilingual models. We were failing to
say which models had languages.

**And the Parakeet we advertise does not work.** `parakeet-tdt-0.6b-v3` is in
the default feature set and resolves `nvidia/parakeet-tdt-0.6b-v3` — raw NeMo
checkpoints that require a managed Python venv with torch and transformers
(`asr/python_runtime.rs`, `has_required_files()` gating on
`python_marker_path()`). It has zero tests and appears in no QA artifact. This
is the same shape as the CoreML encoder removed earlier today: a capability the
build advertises and no user can reach.

## Model choice, and why these

Three promoted options, chosen because they fail differently. A user whose
accent one model mishears should have a genuinely different engine to try, not
a different size of the same one.

| Model | Size | Languages | Engine | Why pick it |
| --- | --- | --- | --- | --- |
| Whisper `base.en` | 148 MB | English | encoder-decoder, GGML | Smallest, proven, current default |
| Parakeet TDT 0.6B v3 | ~639 MB | 25 | TDT transducer, ONNX | Fastest; does not hallucinate in pauses |
| Whisper `large-v3-turbo` | ~1.6 GB | ~100 | encoder-decoder, GGML | Widest language and accent coverage |

Everything else the download manager already knows — `tiny`, `tiny.en`, `base`,
`small`, `small.en`, `medium`, `medium.en`, `large-v3` — moves into a "More
models" drawer, collapsed by default.

The Parakeet case is worth stating plainly because it is the reason to do this
work at all. Whisper is an encoder-decoder: the decoder always wants to emit
text, so it invents words during long pauses. A transducer emits silence during
silence. For dictation, where people stop mid-thought constantly, that matters
more than the leaderboard gap between them. Published figures put Parakeet TDT
v3 at roughly 3,333x real-time on Apple Silicon against Whisper Large V3's ~146x,
at 6.32% WER against 7.44% — faster *and* more accurate. Those are third-party
claims, not our measurements, and the spec does not depend on them: we will
measure on this Mac with `bun run benchmark:latency` before promoting anything.

We are not chasing leaderboard rank. The top of the Open ASR Leaderboard is
separated by under one WER point, so license, language coverage, size, and
pause behaviour are the variables that actually differ.

## The hard part: TDT decoding

This is the one genuinely novel piece of engineering, and it is not the URL
swap it looks like.

Our working ONNX route is **CTC**: one `model.onnx`, argmax over logits, blank
is the last vocab entry (parakeet.rs:485-486). Parakeet v3 is a **TDT
transducer** and ships as three files from
`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` — the same publisher as
the 110M build we already use:

- `encoder.int8.onnx` — 622 MB
- `decoder.int8.onnx` — 11 MB (prediction network, carries state)
- `joiner.int8.onnx` — 6 MB
- `tokens.txt`

Decoding is a stateful greedy loop, not an argmax: run the encoder once over the
features, then per frame run decoder + joiner, emit tokens, and advance the
frame cursor by the *duration* the TDT head predicts. Getting the blank handling
or the duration advance wrong produces plausible-looking text that is subtly
wrong, so this needs its own tests against a known fixture, not just "it
returned a string".

If TDT decoding does not work correctly, the promoted trio falls back to
`base.en` plus the two Whisper sizes, and the drawer carries the rest. The rest
of this spec does not depend on Parakeet landing.

## Architecture

Extend what exists; do not rebuild it.

**ASR route metadata.** Add to `AsrRouteCatalogEntry`: `languages` (`"en"` or a
count with a representative list), `sizeMb`, `tier` (`promoted | more`), and
`pauseBehavior` (`transducer | encoder_decoder`). These are the facts the UI
needs to explain a choice, and none of them exist today.

**LLM lanes.** Replace the single `privacy.llm_provider` / `llm_model_id` pair
with two lanes, each `{ provider, modelId }`:

- `dictation` — cleanup and formatting on every capture. Latency-critical.
- `meetings` — summaries, action items, and Q&A. Can be slower and smarter.

Migration copies the existing pair into both lanes, so no behaviour changes on
upgrade. The old keys are removed by the existing `REMOVED_SETTINGS_KEYS`
mechanism.

**Parakeet.** Point `parakeet-tdt-0.6b-v3` at the sherpa-onnx int8 build,
implement TDT decode alongside the existing CTC decode, and delete
`asr/python_runtime.rs`, `Resources/python/asr/runner.py`, and the
`python_marker_path()` gating. The `parakeet-ctc-0.6b` and `parakeet-ctc-1.1b`
NeMo routes go with it — they have the same Python dependency and no ONNX
equivalent wired. Leaving a dormant broken path is the failure mode this project
keeps repeating.

**Structural cleanup in scope.** `asr-provider-manager.tsx` is 2,885 lines and
would grow. Split the catalogue and selection logic out from the per-route
presentation so the new screen composes it.

## The Models screen

Presets first, detail underneath, drawer at the bottom.

1. **Presets** — a small set that sets every lane at once: *Light* (base.en
   everywhere), *Balanced* (Parakeet v3 for speech, local AI), *Most accurate*
   (large-v3-turbo, best available AI), *Multilingual* (Parakeet v3 or
   large-v3-turbo). Each names what it costs in disk and what it buys.
2. **Per-task** — four rows, always visible, showing the current choice: speech
   for dictation, speech for meetings, AI for dictation cleanup, AI for meeting
   notes. Changing one moves the preset to "Custom" rather than silently lying
   about which preset is active.
3. **More models** — collapsed drawer with the remaining eight Whisper builds.

Each model row states size, languages, whether it is downloaded, and one honest
sentence including the downside. "For better or worse" is the instruction: say
that `large-v3-turbo` is 1.6 GB and slower, say that `base.en` will not handle
your Spanish, say that Parakeet covers 25 languages and not 100.

Live on the screen and worth having because almost nobody else does it: a
**"Measure on this Mac"** action per downloaded model, running the existing
benchmark against a fixture and recording a real p50. Our own numbers are the
only measured ones in this market; letting a user generate theirs is both useful
and consistent with how we talk about performance.

## Errors and edge cases

- A model that is selected but not downloaded shows the existing
  `needs_download` readiness and its remediation action; it never silently falls
  back mid-capture.
- Removing a downloaded model that a lane still points at reverts that lane to
  `base.en` and says so.
- Cloud AI lanes with no key show `requires_key` and route to the key screen —
  the existing behaviour, extended per lane rather than globally.
- If Parakeet artifacts are partially downloaded, the existing
  `is_valid_onnx_file` check applies per file; all three must validate before the
  route reports ready.
- Disk: the screen shows total footprint of downloaded models, since the trio at
  full size is ~2.4 GB and users should not discover that by running out of
  space.

## Testing

- **TDT decode** — unit tests over a fixture WAV with a known transcript,
  asserting the decoded text, not merely non-empty output. Plus a test that the
  duration advance cannot loop forever on a pathological input.
- **Migration** — a settings blob with the old single `llm_provider` pair
  migrates to two lanes with identical values, and a blob already carrying lanes
  is untouched.
- **Catalogue metadata** — every promoted route has languages, size, and a
  non-empty rationale; no route claims a language set its model does not have.
- **Lane routing** — dictation cleanup calls the dictation lane's provider and
  meeting summarization calls the meetings lane's, verified at the boundary
  rather than by inspection.
- **Packaged QA** — a new `qa:packaged:macos:asr-models` harness that downloads
  the promoted trio, transcribes the real-speech fixture with each, and records
  measured p50 per model. This is the evidence that the promoted list is real.

## Out of scope

- Streaming/incremental decode. Handy ships it and we do not; that is a separate
  and larger piece of work against the `AsrProvider` trait, which today exposes
  only `transcribe(path)` and `transcribe_bytes()`.
- Cloud ASR provider expansion. The existing cloud routes stay as they are.
- Per-profile model overrides beyond the lanes described here.
