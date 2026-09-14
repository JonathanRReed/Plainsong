# Dictation fidelity

Automatic cleanup should format dictation, not silently rewrite it. This applies
both to live insertion and to the automatic formatting part of Process Again.

## Six regression cases

1. **Resumed lists:** `5. Review` / `6. Ship` stay 5 and 6. Notes mode preserves
   existing numbered lists rather than splitting their comma-separated content
   into new bullets. AI cleanup must retain the original labels and item breaks.
2. **Uncommon words:** the existing user dictionary supplies preferred spellings
   to supported recognizers and applies explicit, scoped replacements afterwards.
   A long candidate that exceeds the remaining hint budget no longer prevents a
   shorter later term such as `auth` from fitting. Add an app/category-scoped
   `off` -> `auth` rule only where that substitution is wanted; an unscoped rule
   also changes legitimate uses of "off". This patch adds no automatic global rule.
3. **Spoken repairs:** with local smart formatting enabled, `orange, err, yellow.`
   becomes `yellow.`. Lowercase `er`, `err`, and `erm` are recognized only between
   commas, with a single alphabetic replacement ending the clause. The edit runs
   before the dictionary and never undoes a prior insertion. Real "or", uppercase
   ER, unpunctuated and multi-word ambiguities remain unchanged. Literal mode
   leaves the cue visible.
4. **Negation and other words:** automatic AI output must conserve the ordered
   word sequence. The check allows capitalization, punctuation, and a small set of
   unambiguous contraction expansions, but rejects missing, added, substituted,
   or moved words. Counting negations alone would miss a "not" moved to a different
   clause. Failed validation keeps the immediate pre-AI pipeline text, including
   dictionary corrections, snippets, and any completed translation.
5. **Intentional filler:** "like", ambiguous repair cues, quoted words, ER/UM
   acronyms, and paragraph breaks survive the local fallback. Only isolated
   lowercase/titlecase um/uh hesitation variants can be removed.
6. **Long or repetitive answers:** no text-only repetition filter runs on raw or
   final dictation. All occurrences of "A" and "agreed" remain. The AI guard also
   rejects a missing middle, truncated tail, or collapsed repeated answer, even
   when the overall output-length change is tiny.

## Deliberate boundaries

These are text-stage safeguards, not a new recognition model. They cannot recover
"never" that the recognizer never emitted, distinguish audio already decoded as
"orange or yellow", or reconstruct uncaptured audio. Dictionary hints are bounded
and provider-dependent; they are not a recognition guarantee. The existing
10-minute capture ceiling and its stop warning are unchanged.

The conservative AI check may keep local wording instead of a grammatical
paraphrase. Automatic email/message/custom formatting follows this same contract,
including Power Rewrite sessions. Explicit selected-text/voice rewrite commands
and translation still use their separate transform paths. The validator compares
against the translated text only when a subsequent cleanup pass runs; it does not
claim to validate translation fidelity. Meeting transcript cleanup is unchanged.

No extra audio retention, network request, telemetry, or cloud fallback is added.
The existing history/audio-retention settings continue to control recovery data.

## Verification

Regression tests live in `dictation_fidelity.rs`, `dictation_pipeline.rs`,
`dictation_parity.rs`, `tests.rs`, and `dictation-history-labels.test.ts`.
Run the normal source gates from `nautilus-bot`:

```sh
bun run typecheck
bun run test
bun run lint:rust
bun run test:rust
```

Real microphone/provider acceptance remains a separate check. Dictate each case
above with the selected local or BYOK recognizer; compare raw history and final
output. Repeat with AI formatting on/off and Process Again. Record a multi-minute
questionnaire with repeated short answers, long pauses, and numbered continuation;
check every answer against the audio where retention is enabled. Verify the
maximum-duration warning at the existing capture ceiling. Check that explicit
translation and selected-text rewrite commands still work. Synthetic text tests
are not evidence of microphone capture or acoustic accuracy.
