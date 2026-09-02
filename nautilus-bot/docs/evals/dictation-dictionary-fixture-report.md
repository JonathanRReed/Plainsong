# Dictation Dictionary Fixture Report

Generated: 2026-05-03T15:52:13.163Z

Dictionary fixtures pass at 100%. This report verifies longest-match handling and app-scoped replacements in the current local code path.

| ID | Label | Language | App | Expected | Actual | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| dict-openai | Brand terms prefer the longest matching phrase | en | Slack | please email OpenAI today and reopen the task | please email OpenAI today and reopen the task | PASS |
| dict-app-scope | Dictionary scope applies only in the matching app | en | Gmail | follow-up tomorrow | follow-up tomorrow | PASS |

## Recognizer vocabulary hint (added 2026-09-01)

Until this change the dictionary and snippets were applied only *after*
transcription, as text replacements over whatever the recognizer produced. A
word the model had never seen ("Plainsong") had to be mis-transcribed first
and then rescued by a `spoken_form → replacement` entry, which only works when
the mishearing is stable enough to write a rule for.

The dictionary now also reaches the recognizer. Each dictation builds a
vocabulary hint (`dictation_parity::build_vocabulary_hint`) from the entries
that apply to the app in front — the same `app_scope` / `category_scope` /
`enabled` checks the replacement pass uses — and hands it to the provider
with the audio through `AsrProvider::transcribe_bytes_with_options`:

| Provider | How the hint is sent | Notes |
| --- | --- | --- |
| whisper.cpp (`whisper-rs`) | `FullParams::set_initial_prompt`, one framed sentence: `Vocabulary: term, term.` | Seeds the first 30 s decode window; `no_context` does not discard it. Control characters are stripped (a NUL would panic inside whisper-rs). The frame is not decoration — see the prompt-shape table below. The prompt is withheld when the VAD-trimmed audio is under 0.5 s or below an RMS of 0.004 (a silent hotkey tap must not type "Vocabulary:"), and an output that consists only of hint words on quiet (RMS < 0.012) or sub-second audio is dropped as prompt echo. |
| OpenAI transcription | multipart `prompt` field, same framed sentence | whisper-1 and the gpt-4o transcribe models both read it. |
| Groq | multipart `prompt` field, same framed sentence | OpenAI-compatible endpoint. |
| ElevenLabs Scribe | one multipart `keyterms` field per term | Terms over 50 chars / 5 words or containing `<>{}[]\` are dropped. **ElevenLabs bills a 20% surcharge on any request carrying keyterms**, so a non-empty applicable dictionary costs 20% more per Scribe dictation. |
| Cohere | not sent | Cohere's OpenAI-compatible audio endpoint documents `prompt` under "unsupported parameters". |
| Parakeet, Moonshine, whisper-candle, Distil-Whisper, Qwen3, Apple Speech, Windows SDK | not sent | No prompt/vocabulary input in these runtimes' current wrappers. Apple Speech's `SFSpeechRecognitionRequest.contextualStrings` exists, but the helper protocol passes only audio today (future work). |

What goes into the hint, and what never does:

- Dictionary entries contribute their **replacement** (the spelling to
  prefer). The misheard `spoken_form` is never sent: biasing the model toward
  "open a i" would defeat the entry.
- Snippets contribute their **trigger** only, and only when it is a plain
  single word (`brb`, `e-mail`; not `my address`). Expansions never leave
  the pipeline: a snippet that expands `sig` into a four-line signature must
  not teach the recognizer the signature.
- Newest entries first (`updated_at`), deduplicated case-insensitively,
  capped at 60 terms, 600 characters of prompt (frame included), or an
  estimated 200 prompt tokens (one per three characters plus one per
  separator — conservative for proper nouns) under whisper's 224-token
  window, whichever comes first.
- The audit log records `vocabulary_hint_terms_built` and
  `vocabulary_hint_terms_applied` separately; only the second means the
  route that ran actually attached the terms.
- Nothing is attached when nothing applies. There is no separate on/off
  switch for the dictionary (entries have always applied unconditionally);
  disabling or deleting entries removes them from the hint, and snippet
  triggers follow the existing "Snippets" toggle.
- The live partial-preview decodes during a session do not carry the hint;
  only the final decode does.

The post-transcription replacement pass is unchanged and still runs on the
result, so the fixtures above behave exactly as before.

### Benchmark evidence (whisper.cpp `base.en`, `scripts/fixtures/real-speech-44s.wav`)

`benchmark-latency` gained `--vocabulary <terms>` so the same fixture can be
decoded with and without a hint through the exact code path dictation uses.
Run 2026-09-01 on the Apple Silicon dev machine, release build, default
features (Metal), 5 timed runs after one warm-up, hint
`Plainsong, hotkey, Slack, Nautilus` (sent as
`Vocabulary: Plainsong, hotkey, Slack, Nautilus.`). Both runs back to back
with the GPU otherwise idle; receipts in the session scratchpad, not
committed (see `artifacts/qa/.gitignore`).

| Run | 44 s fixture p50 / p95 | 5.3 s fixture p50 / p95 | 44 s transcript | 5.3 s transcript |
| --- | --- | --- | --- | --- |
| no hint | 675 ms / 752 ms | 113 ms / 116 ms | "**Plain Song** is a free and open source dictation app … and **Plain Song** will adapt its formatting …" | "This is a Nautilus local quality gate sample, with enough spoken words for verification." |
| hint | 679 ms / 831 ms | 126 ms / 143 ms | identical except "**Plainsong**" both times | identical except the comma after "sample" |

Latency is within run-to-run noise (+4 ms at p50 on 44 s of audio; the
p95 spread is the same order as between two un-hinted runs on this shared
machine). The transcript is unchanged except for the two spellings the hint
was there to fix. "press a hot" (the speaker says "hotkey") is still wrong
with `hotkey` in the hint — a prompt biases, it does not force.

The prompt *shape* was not a free choice. Three shapes were tried on the
same fixtures before settling on the framed sentence:

| Prompt sent to whisper | 44 s fixture | 5.3 s fixture |
| --- | --- | --- |
| `Plainsong, hotkey, Slack, Nautilus` (bare list) | "Plainsong" fixed ×2, but "search later. The goal" became "serve. Search Later, the goal" | "Nautilus" became "not-a-list" |
| `Plainsong, hotkey, Slack, Nautilus.` (trailing period) | all words right, but every sentence boundary became a comma | correct |
| `Vocabulary: Plainsong, hotkey, Slack, Nautilus.` (framed, shipped) | identical to baseline except "Plainsong" ×2 | correct |

whisper reads the prompt as *prior transcript*, so a bare noun list reads
like odd previous speech and its punctuation style leaks into the output.
`VocabularyHint::as_prompt` therefore always emits the framed sentence, and
`build_vocabulary_hint` counts the 13-character frame inside the 600
character cap.
