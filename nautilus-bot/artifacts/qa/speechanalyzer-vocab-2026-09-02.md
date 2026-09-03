# Apple Speech vocabulary hints: does `contextualStrings` do anything? (2026-09-02)

Parity program item C5b. Lane C5 found that `AnalysisContext.contextualStrings`
exists in the macOS 26.2 SDK, contradicting the earlier note that SpeechAnalyzer
has no custom-vocabulary API. Lane A3 had already built `VocabularyHint` from
the user's personal dictionary, which whisper.cpp, OpenAI, Groq and ElevenLabs
consume and Apple Speech ignored. Question: wire the hint into the Apple route
and find out, by measurement, whether either engine acts on it.

## Answer

| Engine | Accepts the terms? | Changes the transcript? |
| --- | --- | --- |
| `SFSpeechRecognizer` (`SFSpeechRecognitionRequest.contextualStrings`) | Yes | **Yes.** 5.93% → **2.96%** WER on the repo's 44 s fixture with a three-term hint; the proper noun the reference spells "Plainsong" went from "Play song"/"Plain song" to "Plainsong" every time. |
| `SpeechAnalyzer` (`AnalysisContext.contextualStrings[.general]`) | Yes — the context reads back with the terms in it | **No.** Byte-identical transcripts and identical confidences with and without the hint, on two fixtures, batch and live. Marked **sent, effect unverified**. |

The plumbing is kept for both. `vocabulary_hint_terms_applied` reports terms
*handed to the recognizer*, which is 3 on both engines above; whether the
recognizer acted on them is this document, not a runtime signal, and the Rust
test that carries both captures says so in as many words.

## Environment

- Hardware: Apple M4 Pro, 14 logical CPUs, 24 GB.
- OS: macOS 27.0 (build 26A5406e). SDK: macosx 26.2. Swift 6.2.3
  (swiftlang-6.2.3.3.21).
- **Machine state: shared with other parity lanes.** The 1-minute load average
  is recorded with every timing below; 14 cores, so anything above ~14 is
  oversubscribed. Every measurement here was taken between load 33 and load 67.
  The wall times are an upper bound, not a benchmark. The *transcripts* are not
  load-sensitive: every run below was repeated three times and every repeat was
  character-identical.
- Measurements were taken 2026-09-03 00:16–00:31 local, in the session that
  began 2026-09-02; the filename keeps the lane's date.

### The binaries these numbers came from

Two scratch builds, neither committed and neither shipped:

| Build | sha256 | Difference from the committed source |
| --- | --- | --- |
| `helper-ungated` | `c4b9a49e…10b6` | the two `requireSpeechAuthorization()` calls at the `--transcribe-file` / `--live` entry points replaced by a bare status read |
| `helper-ungated-sf` | `905b3d98…ac76` | the above, plus the same call inside `recognitionContext` |

Both were compiled exactly as `build.rs` does (`xcrun swiftc -O -target
arm64-apple-macosx13.0`, `MACOSX_DEPLOYMENT_TARGET=13.0`, the helper Info.plist
linked into `__TEXT,__info_plist`) and ad-hoc signed with
`macos_speech_helper.entitlements.plist`.

**Why:** Speech Recognition permission on this Mac is still `not_determined`,
and lane C5's fix-up added an authorization gate that now refuses every
transcription path before it can choose an engine. Deciding that permission is a
user-present step nobody was present for. The gate is unchanged in the committed
source, and the committed helper
(`69bc94c5…1751`) refuses these commands exactly as it should.

### Fixtures

- `real-speech-44s.wav` (repo, 43.97 s, 16 kHz mono): the same fixture and the
  same reference (`REAL_SPEECH_44S_REFERENCE` in `rust-sidecar/src/asr/qwen3_asr.rs`)
  lane C5 used, so the numbers are comparable to its receipt. Neither repo
  fixture ships a human transcript; the reference is Parakeet TDT 0.6B v3
  cross-checked against whisper.cpp `base.en`.
- A short synthesized fixture, not committed (a generated `say` output is a
  binary, and the command reproduces it):

  ```sh
  say -v Samantha -o vocab-fixture.aiff \
    "Plainsong exports every neume to Obsidian before the standup."
  afconvert -f WAVE -d LEI16@16000 -c 1 vocab-fixture.aiff vocab-fixture.wav
  ```

  3.56 s, sha256 `53650edd…7cad` as generated here. Three uncommon words, one of
  them a proper noun the reference for the 44 s fixture also contains.

- Hint sent for the synthesized fixture: `["Plainsong", "neume", "Obsidian"]`.
  Hint sent for the 44 s fixture: `["Plainsong", "Nautilus", "neume"]`.

## Batch transcription

Synthesized fixture, `--transcribe-file`, three runs each, load 66-67:

| Engine | Hint | Transcript | p50 wall |
| --- | --- | --- | --- |
| SpeechAnalyzer | — | `Plain song exports every new to obsidian before the stand-up.` | 0.254 s |
| SpeechAnalyzer | 3 terms | `Plain song exports every new to obsidian before the stand-up.` | 0.251 s |
| SFSpeechRecognizer | — | `Play song exports every new to obsidian before the standup` | 0.380 s |
| SFSpeechRecognizer | 3 terms | `Plainsong exports every new to Obsidian before the stand-up` | 0.330 s |

Two of the three hinted terms landed on the older engine: "Play song" became
"Plainsong", and "obsidian" became "Obsidian". "neume" was heard as "new" either
way — a hint biases the recognizer, it does not force a word in. Mean confidence
rose with it, 0.763 → 0.845.

The SpeechAnalyzer rows are character-identical *and* carry the same confidence
to every reported digit (0.8326), which is what rules out "it helped a little".

44 s fixture, `--transcribe-file`, WER by the same normalized word-level edit
distance the repo's evals use (135 reference words):

| Engine | Hint | Edits | WER |
| --- | --- | --- | --- |
| SFSpeechRecognizer | — | 8 | 5.93% |
| SFSpeechRecognizer | 3 terms | 4 | **2.96%** |
| SpeechAnalyzer | — | 6 | 4.44% |
| SpeechAnalyzer | 3 terms | 6 | 4.44% |

The only word-level difference between the two SFSpeechRecognizer runs is
`plain song → plainsong`, twice — exactly the four edits the WER drop accounts
for. The SpeechAnalyzer 4.44% reproduces lane C5's figure for the same fixture,
which is a useful cross-check that nothing else in this lane moved.

## Live streaming

Same fixture fed as Float32 PCM on stdin, `--live`:

| Engine | Hint | Closing `final` text | Confidence |
| --- | --- | --- | --- |
| SpeechAnalyzer | — | `Plain song exports every new to obsidian before the stand-up.` | 0.8306 |
| SpeechAnalyzer | 3 terms | `Plain song exports every new to obsidian before the stand-up.` | 0.8306 |
| SFSpeechRecognizer | — | `Play song exports every new to obsidian before the standup` | 0.7647 |
| SFSpeechRecognizer | 3 terms | `Plainsong exports every new to Obsidian before the stand-up` | 0.8427 |

The live path reaches SpeechAnalyzer through the `analysisContext:` initializer
rather than `setContext`, so both ways of attaching the context were exercised
and both produced no change.

## Was the context actually set?

That mattered enough to check outside the helper. A 50-line scratch program
(not committed) set `AnalysisContext.contextualStrings[.general]` two ways and
read it back:

```
read back after setContext:  [ContextualStringsTag(rawValue: "general"): ["Plainsong", "neume", "Obsidian"]]
inputAudioFile-init text:    Plain song exports every new to obsidian before the stand-up.
read back 2:                 [ContextualStringsTag(rawValue: "general"): ["Plainsong", "neume", "Obsidian"]]
```

So the framework stores the terms, returns them, raises no error, and does not
use them — on this OS build, for `en_US`, with `SpeechTranscriber`. That is the
whole basis for "sent, effect unverified". It may change in a later macOS, and
if it does, this route needs no code change to benefit.

## Caps and refusals

The helper applies the same caps as the whisper prompt
(`VOCABULARY_HINT_MAX_TERMS` 60, `VOCABULARY_HINT_MAX_CHARS` 600), because it is
a separate binary and should not trust the caller to have trimmed. Measured on
the committed protocol:

| Sent | `contextual_strings_applied` |
| --- | --- |
| 80 terms | 60 |
| 20 terms × 50 characters (1000 chars) | 12 |
| `["  ", "Plainsong", "", "   Obsidian  "]` | 2, and the transcript improved |
| `{"protocol_version": 2, …}` | refused, `malformed_request` |
| not JSON | refused, `malformed_request` |
| a path that does not exist | refused, `malformed_request` |

The terms never appear in an argument list: they are the user's own dictionary
entries, and `ps` is readable by every process on the machine. Rust writes them
to a `0600` temp file that is deleted when the request ends, and passes only the
path. `verify-macos-speech-helper.mjs` checks both halves of that, checks the
helper's caps against the Rust constants so the two copies cannot drift, and
exercises the new argument-parsing refusals at runtime.

## What this does not show

- **The packaged, Developer-ID-signed helper was not measured.** These are
  ad-hoc-signed scratch builds run from a temp directory.
- **Nothing here was measured with Speech Recognition permission granted.** The
  finding that `SFSpeechRecognizer` transcribes on-device with the app's own
  gate removed and permission `not_determined` is new — lane C5 reported that
  engine refusing, but that refusal came from Plainsong's own check, not from
  the framework. It is recorded, not spent: the gate stays exactly where it is
  (see the consent section of `docs/beta/KNOWN-LIMITATIONS.md`).
- **One locale, one voice, one speaker.** `en_US`, the `say` voice Samantha, and
  one human recording. Whether SpeechAnalyzer honours contextual strings in
  another locale is unmeasured.
- **No latency claim.** The wall times above were taken at load 66-67 on a
  14-core machine shared with other lanes.
