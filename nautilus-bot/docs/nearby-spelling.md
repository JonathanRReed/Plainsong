# Nearby spelling

Enable **Spell names from nearby text** in Settings > Dictation to use nearby
visible text for spelling on macOS. It is off by default and requires
Accessibility permission. The setting is separate from clipboard, selected-text
and application context, which can supply text to AI formatting.

At dictation start, a background reader checks the original focused field and
window. It visits the closest container first, then visible window children,
including labels, recipient fields and titles. For document fields it requests
only the accessible visible character range. Unreadable, hidden and secure
subtrees are skipped. Password managers and system password windows are denied.
There are no screenshots, OCR, clipboard reads or background polling.

The read has a 30 ms deadline and stops at 64 elements or 4,000 characters.
Native calls use the remaining deadline as their timeout. macOS scheduling and
an unresponsive application can exceed a requested timeout. The task never gates
microphone startup or insertion, and late results are ignored. The extracted
vocabulary has at most 50 terms, ranked by repeated occurrences, identifiers,
email-derived names and capitalized names. Raw text is dropped in the reader.
Only this session's vocabulary reaches the local spelling step. It is not
persisted and never reaches a cloud speech or cleanup provider. On the local
Parakeet route, the same terms are also scored against this dictation's audio
on this Mac (see [name and term spelling](dictation-fidelity.md#name-and-term-spelling-from-the-audio)).

The deterministic spelling step follows the user's dictionary and local text
formatting, before AI cleanup. A changed word needs at least five letters and a
single Unicode character edit. Ordinary English words, quoted text, numbers,
negation, conditions and ambiguous matches are protected. In code editors, exact spoken words
can join into a visible camelCase or snake_case identifier. This does not guess
abbreviations or add missing name components. For example, "Jonathon Reed" can
become "Jonathan Reed"; "Jon Reid" stays unchanged. "Will" and "Mark" are never
inferred from ordinary words. Missing system word lists disable fuzzy matches.
Explicit dictionary replacements take precedence, and snippet or voice-command
outputs bypass nearby spelling.

Applied spellings enter the existing dictionary fidelity protection before AI
cleanup. The original recognizer transcript remains the change-review baseline,
so users can undo corrections. No raw screen text or unused vocabulary enters
history. A corrected transcript follows the usual history and provider choices.
Stop drains the vocabulary; cancellation and reset drop it. Session identity,
original field identity and a consent revision reject stale reads and settings
that were turned off and back on.

## Verification

Unit tests cover extraction, ranking, Unicode, accents, common words, short
names, ambiguous matches, protected dictionary output, negation and numbers.
A fake Accessibility reader checks bounds, deadlines and sensitive subtrees.
Session tests cover cancellation, stale targets, expiry and serialization.
Native Accessibility behavior and installed-app permissions need separate
candidate-bound checks. Source tests do not establish Mail or editor coverage.
