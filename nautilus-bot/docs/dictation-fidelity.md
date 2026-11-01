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
3. **Spoken repairs:** with local smart formatting and Remove filler words
   enabled, `orange, err, yellow.` becomes `yellow.`. Lowercase `er`, `err`, and `erm` are recognized only between
   commas, with a single alphabetic replacement ending the clause. The edit runs
   before the dictionary and never undoes a prior insertion. Real "or", uppercase
   ER, unpunctuated and multi-word ambiguities remain unchanged. Literal mode
   leaves the cue visible, as does disabling Remove filler words.
   Strong cues ("no wait", "I mean", "sorry", "or rather", "make that") after
   a comma also resolve a parallel restatement of two to five words that
   starts with the same word: `config underscore v2.yaml, no wait, config
   underscore v3.yaml` keeps v3 and `to Mark, no wait, to Priya` keeps Priya.
   Unaligned repairs ("20 dollars, no wait, I think it's 30") stay visible.
   A restatement that repeats its preposition counts as the same value: "to
   4:30, no wait, to five o'clock" keeps "to five o'clock". A single name
   inside a sentence is corrected only after a comma and a strong cue, and
   only when the new name closes its clause or leads into a preposition:
   "Invite Carlos, I mean Carla, to the review" keeps Carla, while "Carlos,
   actually Carla", "Ask Dana, sorry, Sam knows" and "Carlos Mendez, sorry,
   Carla" stay as spoken. For names the cue must be "I mean", "or rather",
   "no wait", "wait no" or "make that"; "sorry" counts only with a restated
   preposition ("to Mark, sorry, to Priya"), so "I already told Dana, sorry,
   Sam" stays. When a comma follows the new name, the next word must be a
   preposition, a continuation ("and", "then"), a time phrase ("next
   month", "tomorrow") that itself ends the clause or leads into a
   preposition, or another cue, or the sentence must end; "I told Dana, I
   mean Sam, already knew", "Ask Carlos, I mean Carla, if she is free" and
   "Don't blame Dana, I mean, Sam, today was your call" stay as spoken. That comma goes with the aside: "Austin, or rather
   Dallas, next month" becomes "Dallas next month", and "Ask May, I mean
   June, to approve it" becomes "Ask June to approve it".
4. **Negation and other words:** automatic AI output must conserve the ordered
   word sequence. The check allows capitalization, punctuation, and a small set of
   unambiguous contraction expansions, but rejects missing, added, substituted,
   or moved words. Counting negations alone would miss a "not" moved to a different
   clause. Failed validation keeps the immediate pre-AI pipeline text, including
   dictionary corrections, snippets, and any completed translation.
5. **Intentional filler:** "like", ambiguous repair cues, quoted words, ER/UM
   acronyms, and paragraph breaks survive the local fallback. Only isolated
   lowercase/titlecase um/uh hesitation variants can be removed, and hm/hmm
   only where it opens a clause and a pause follows ("Hmm, I'm not sure";
   "He said hmm and left" stays). Not after a colon ("I texted her: hmm."),
   not after a speech verb ("He said, hmm, interesting."), and a dictation
   that is only "Hmm?" stays as it is. "mhm" (yes) stays. A filler between
   two commas takes one comma with it inside a clause ("we should, uh,
   meet" becomes "we should meet"; "It wasn't, um, Dana" becomes "It
   wasn't Dana"), but between clauses one comma stays: before a subject such
   as "I", "we" or "they", before "it" or "you" followed by a verb ("It's
   not, hmm, it is fine" becomes "It's not, it is fine"; "I gave, um, it to
   Sam" becomes "I gave it to Sam"), or between two answers or negations
   ("I said no, um, never" becomes "I said no, never"; "I'm not, um, sure"
   becomes "I'm not sure"). A sound that is being talked about stays: after
   "the word" or a language name ("The word uh is in the poem"), or as the
   whole object of "write", "say", "said", "type", "spell", "remove" or
   "called", where it ends the sentence, is contrasted ("I said um, not
   uh") or runs into "exactly", "here", "from", "on" and the like ("Please
   write um exactly", "Do not remove um from the transcript"). Then every
   sound in that sentence stays. "I said um that we should wait" and "I'll
   write um a summary" still lose the hesitation. A "hmm" after "is," or
   "was," also stays ("The answer was, hmm, maybe"). A bare "um" running into the
   next word is German "at" or Portuguese "a" when that word follows "um"
   only in those languages ("um zehn Uhr", "um carro") or the dictation has
   a German, Spanish, French, Italian or Portuguese function word, even one
   too few to switch the English rules off ("Wir kommen um elf"). A loanword
   with an accent does not count ("The café um opens" loses the "um"). The
   AI check shares this reading, so a model may not drop those words either.
6. **Long or repetitive answers:** no text-only repetition filter runs on raw or
   final dictation. All occurrences of "A" and "agreed" remain. The AI guard also
   rejects a missing middle, truncated tail, or collapsed repeated answer, even
   when the overall output-length change is tiny.

## AI preservation checks

Rewrite validation counts each supported currency amount. When the source attaches
amounts to at least two distinct financial roles, each role must retain its nearest
following amount within the same sentence. Missing or changed associations keep
the pre-AI text. The check never turns `1250` into `12.50`.

With Remove filler words off, conservative AI cleanup keeps hesitations, repeated
words and spoken self-corrections. Its prompt and validator use the same setting.
An explicitly selected rewrite retains its separate editing policy.

Dictionary replacements applied to this transcript must survive AI cleanup and
rewriting with the exact spelling, punctuation and occurrence count present in the
pre-AI text. Unused dictionary entries add no constraint. Live dictation and
Process Again both keep the pre-AI text if this check fails.

## Preferred name and term spellings

The session vocabulary restores exact preferred spellings from the dictionary,
opt-in calendar and Contacts names and opt-in nearby words, even when CTC returns no candidate.
It matches the recognized letters and punctuation and can remove spaces only at
camel-case boundaries, such as `Mc Kenzie` to `McKenzie` or `py torch` to `PyTorch`.
Existing spaces in a preferred name remain required, so `Maryann` does not become
`Mary Ann`. Joining also requires a fragment outside the system word list and
rejects one-letter words, negations, numbers and contractions. `I phone` and
`no SQL` stay as spoken. Built-in terms do not get this text-only treatment.

The match must occur once, stay on one line and avoid an existing dictionary
replacement. This pass follows the English-language guard. It adds no phonetic
replacement, and learned corrections still require approval. Applied spellings
join the existing dictionary-output protection for subsequent AI cleanup.

CTC rescoring rejects a candidate when another requested term for the same
recognized span has at least as close a spelling and a better acoustic score.
This also applies when the better term fails its own acceptance threshold. A
looser dictionary threshold cannot promote a worse candidate in its place.

The text-only phonetic dictionary matcher leaves all-uppercase acronyms alone.
For example, adding SQLite does not authorize changing recognized `SQL` to
`SQLite`. An explicit dictionary replacement still applies normally.

## Spoken numbers

Voice defaults to digits. Money, percentages, clock times, dates, phone
numbers, measurements, explicit versions and counts of ten or more use
digits. Zero to nine stay words in ordinary prose, including recognizer
digits: "2 people" becomes "two people" and "1 of the reasons" becomes
"one of the reasons". A small number before a known unit or data noun uses
digits: "two kilograms" becomes "2 kilograms" and "three laptops" becomes
"3 laptops". The bounded unit list is in `text/itn/style.rs`; an unknown
noun does not make a small number data. Small ordinals stay words outside
dates and labelled data. "Zero chance", "number one priority", "one or
two" and "a hundred percent sure" stay words.

The preference applies to words and digits from the recognizer. Selecting
words spells out written money, percentages, times, dates, phone numbers,
ordinals, ranges, years, explicit versions and decimals. Numbered-list
labels remain digits. Decimal places and phone-number zeroes survive.
Numeric identifiers in URLs, email addresses and file paths remain literal. Dictionary replacements and
snippet triggers remain protected. Voice number formatting skips code,
terminal and AI-prompt destinations. Non-English dictation keeps its own
number forms. With no reported language, a short sentence with a foreign
function word and no English function words keeps its recognizer digits.
Spoken repairs run before number formatting, so "Call me at
five, no wait, six thirty" can resolve before it becomes "Call me at 6:30".
Negation and conditions remain in place.

Settings store only explicit overrides. An absent Voice override inherits
the new digits default. A saved `dictationNumbersAsDigits.voice: false`
keeps words. Custom profiles keep their own override or inherit their base
style, including its saved preference. Live dictation and Process Again
use the same number formatter and default.

A number is written as digits only when the whole spoken phrase can be.
"Two thirds of a cup", "two and a half cups", "one twenty over eighty",
"one or two", "Python three point eleven" and "ten oh fifteen" stay as
words rather than becoming "2 thirds", "one twenty over 80", "one or 2",
"3 point eleven" or "10 oh 15".

"Pounds" becomes "£" only with money in the same sentence (cost, price,
paid, spent, owe, budget, pence, sterling and similar) and no weight cue
(weighs, lost, gained, ounces, baby, patient and similar). "The patient
weighs one hundred and five pounds" becomes "105 pounds", "I paid six
pounds and eight pence" becomes "£6.08", and a sentence with neither keeps
the word "pounds".

Money is written the way it is typed: "three point two million dollars"
becomes "$3.2 million", "a million dollars" "$1 million", "twelve hundred
dollars" "$1,200" and "two point five dollars" "$2.50". An amount spoken in
full stays in full ("three million four hundred thousand dollars" is
"$3,400,000"). A range writes both ends with the shared scale ("two to three
million dollars" is "$2 million to $3 million", never "2 to $3,000,000"),
and stays words when the head could mean either ("five to three hundred
dollars", "nine hundred to two million dollars"). A count range with a
shared scale ("two to three million people") stays words for the same
reason. These money conversions apply when the preset writes digits,
including Voice by default. Selecting words writes "$3.2 million" as
"three point two million dollars" instead.

## Clock times

Recognizers trained on British text write "9.30am" or "the meeting from
3.15 to 4.30". Smart formatting reads supported dotted clock times before
the number preference runs. Digits mode writes a colon; words mode spells
out the time. Versions, prices, rates, doses, lab values and race times look the
same, and many words around them are no reliable guide: "tomorrow at",
"today at", "the call at", "lunch at", "session", "free" and "available"
are said beside readings and prices as often as beside times ("Free T4 today
at 1.10", "Sold the call at 1.20", "Cable sat all session at 1.27"). So a
dotted number becomes a time only with explicit evidence. A missed
conversion leaves what the recognizer wrote; a wrong one changes the
meaning.

- **am/pm directly after it.** Glued ("6.30pm") or dotted ("6.30 p.m.",
  "4.45 P.M.") always counts. A spaced "am"/"pm" counts only before the end,
  punctuation, a zone or a lowercase word that can follow a time
  ("tomorrow", "on", "sharp"), never before another capitalized word ("4.30
  PM Sunak said"), and not in a dictation that mentions a quantity, so
  German "Python 3.11 am Montag" and "4.50 am höchsten" stay.
- **An unambiguous zone abbreviation directly after it**: EST, EDT, PST,
  PDT, CST, CDT, MST, MDT, UTC, GMT, CET, CEST, not BST/MT/CT/PT/ET or a
  spelled-out zone, which are also units and street names ("2.50 MT of
  steel", "9.30 Central Avenue"). Hours may run 0-23 here ("14.30 UTC").
  Not in a dictation that mentions a quantity ("EPS came in at 2.45 EST").
- **A meeting noun directly before the time preposition**: meeting,
  appointment, interview, standup, sync, demo, kickoff, webinar, lecture or
  class, optionally followed by "is", "was" or "'s", then at, from, until,
  by or to ("The meeting is at 10.15 tomorrow", "move the meeting from 3.15
  to 4.30"). The minutes must be a multiple of five, the number must end its
  phrase ("The demo at 2.10 crashed" stays), and the dictation must not
  mention a quantity.
- **A weekday directly before at, by, from, until or till** ("by Friday at
  4.45, not Thursday", "Monday morning until 11.30"). The minutes must be a
  multiple of five, the hour 1-12, and the number must be followed by the
  end of the sentence, punctuation, or "not", "and", "or", "then", "to",
  "until", "sharp", "instead", "please" or "works"; "Friday at 1.15 with
  tip", "Friday at 4.45 on Kindle" and "Friday at 4.45, 2 people" stay.
  "Today", "tomorrow" and "tonight" do not count. Not in a dictation that
  mentions a quantity ("Yields ended Friday at 4.45").
- **A spelled-out zone paired with an am/pm time**: Eastern, Pacific,
  Central or Mountain after the number counts only when the same sentence
  already gives a time with am/pm followed by a spelled-out zone ("9.30am
  Pacific, which is 12.30 Eastern"). The number must not label something
  ("chapter 12.30 Eastern", "room"), must end its phrase after the zone
  ("12.30 Eastern Avenue" stays), and the dictation must not mention a
  quantity. A spelled-out zone alone ("At 9am she said 2.30 Pacific") is no
  evidence.

The same weekday (with at, by, until or till) and paired-zone readings apply
to bare recognizer digits ("by Friday at 445" becomes 4:45, "which is 1230
Eastern" becomes 12:30)
alongside the existing rule for digits after at, until or till in a
sentence about a meeting, call or meal. Like dotted times, they run with
smart formatting whether or not numbers are written as digits, and a
protected phrase that contains a digit leaves every bare number in the
dictation as written. "Room 1230", "1230 people" and "Friday at 445 to 515"
stay.

The quantity check covers prices and currency symbols, versions and release
words, markets and trades (buy, sell, strike, premium, bid, ask, a long or
short position), earnings ("EPS", "revenue", "came in", "came back"), results
("won", "finished", "ranked"), fares ("business class"), rates, doses and
units. Numbers joined as a range, list or contrast ("from 3.15 to 4.30",
"4.45-5.15", "1.15, 1.30 and 1.45", "at 4.15, not 4.30") convert together or
not at all: the group qualifies
when a meeting noun introduces it with every minute round, or when its last
member has am/pm or a zone that the earlier ones share ("from 3.15 to
4.30pm"). "Open from 3.15 pm to 4.30" stays whole. With am/pm or a meeting
noun, hours run 1-12; minutes run 00-59.

Voice also reads a terminal "Call me at 6.30." as "Call me at 6:30." when
the dictation mentions no quantity. A price, version, rate or measurement
anywhere in the dictation blocks this reading. Other presets in digits mode
keep the existing dotted-time rules.

Accepted missed conversion: "Lunch is at 12.30 today." keeps its dot in
digits mode. Spoken words ("six thirty") stay words unless
numbers are written as digits for the mode. Code editors,
terminals and AI prompts are skipped, and dictionary output and snippet
triggers are protected.

## Local layout

With Format for destination app on, local formatting adds line breaks for
email, notes and worklog destinations (`text/layout.rs`). Document editors
(TextEdit, Pages, Word) count as notes. Chat destinations get only a
numbered list the speaker announced ("three things: first ..."), never
paragraphs, spoken breaks or email lines. Apps Plainsong has no category
for get the same, plus a list whose every item was numbered aloud ("number
one, budget review, number two, ..., number three, ..."), still with no
paragraphs, spoken breaks or email lines; unannounced "first, second,
third" stays prose there. Messages mode, AI prompt, code editor and
terminal destinations (including kitty, Alacritty, WezTerm, Hyper, Tabby
and Rio), single-line fields (`AXTextField`, `AXSearchField`,
`AXComboBox`) and fields whose accessibility role could not be read get
none, including paragraph breaks. Text that already contains line breaks
keeps them as it is.

- A spoken enumeration becomes a numbered list only when its markers run
  1, 2, 3 within one family (first/second/third, number one/number two, or
  "one," "two,"), start at a sentence or clause boundary, and either number
  three or more or match an announced count ("two things"). A skipped or
  repeated number, a marker before a modified noun ("first quarter",
  "number one priority") or a two-word lead such as "So" leaves the text
  unchanged. Only the markers and their connecting "and"/"then" are removed.
- "new paragraph", "new line" and "newline" become breaks only right after
  sentence or clause punctuation, with words after them, and only when they
  stand as their own clause: punctuation right after them ("Done. New
  paragraph. Next...", "new line,"). "New line cooks start Monday" and
  "Newline handling is broken" stay as spoken. When the speaker is dictating
  punctuation ("first section period new paragraph second section"), a
  lowercase "new paragraph"/"new line" without punctuation also converts,
  unless the next word makes it a noun ("new line items"); a bare "newline"
  never does.
- The last list item runs past "a.m.", "p.m." and similar abbreviations
  unless the next word is capitalized. A question mark at the end of a list
  whose lead asks the question ("Can you do three things: ...?") stays on
  the lead only; a statement lead leaves it on the item.
- Paragraphs split at the existing length thresholds and at a sentence that
  opens a new topic ("Also,", "One more thing") once the current paragraph
  has two sentences.
- Email greetings ("Hi Sam,") and closing sentences ("Best, Jonathan.") get
  their own lines. A closing that names the person greeted ("Hi Sam, ...
  Thanks, Sam." or "Talk soon, Sam.") stays one line, because it is said to
  Sam. A closing with an exclamation mark ("Cheers, Sam!") also stays whole.
  Only a short line under a real closing ("Best regards,") is left without
  a final period. After a greeting, a one-word body is enough ("Hi Sam,
  approved. Best, Jordan."); without a greeting the body needs three words.
- After a greeting, a signing closing that the recognizer ran into the last
  sentence with a comma ("Let me know what works for you, best, Jordan.")
  is split off the same way, and the comma before it becomes the body's
  full stop, or its question mark when the run ended with one. "good,
  better, best, Jordan" ends a comparative series and stays, and after a
  group greeting ("Hi team,", "Hi everyone,") a run-in "thanks, Priya"
  stays in the body because it may thank Priya.
- Words written with a capital after the first letter ("eBay", "iPhone",
  "macOS") keep their spelling at the start of a line or sentence.
- An opening "Well", "So", "Now", "Then", "Therefore" or "Anyway" gets a
  comma only before a personal pronoun ("So, I booked it"). "Well water",
  "So many people", "Now that we are done" and "Then the board decides"
  stay as spoken, as do "So it goes", "So they say" and "Now you see it".
- A comma is added before "and"/"but"/"or"/"so" only between two clauses
  that each have a verb, and never later in a sentence that opened a
  condition ("unless QA signs off and we have the docs").

## Deterministic voice commands

Fixed editing commands run only when the whole utterance matches the enabled
command grammar with its prefix. With the explicit Voice Edit shortcut, commands
that carry no words of their own, and phrase selection, also run without the
prefix; commands that insert or swap spoken words still need it. Phrase
selection, retained-insertion deletion, cursor movement, selection edits, and
undo use guarded Accessibility operations on macOS, without a text model.
Automatic cleanup never executes instructions. See [voice editing](voice-edit.md)
for the grammar, refusal messages, and retained-state limits.

## Deliberate boundaries

These are text-stage safeguards, not a new recognition model. They cannot recover
"never" that the recognizer never emitted, distinguish audio already decoded as
"orange or yellow", or reconstruct uncaptured audio. Dictionary hints are bounded
and provider-dependent; they are not a recognition guarantee. The existing
10-minute capture ceiling and its stop warning are unchanged.

The conservative AI check may keep local wording instead of a grammatical
paraphrase. Automatic email/message/custom formatting follows this same contract.
An explicitly selected Power Rewrite mode or custom prompt permits a rewrite.
Process Again uses the same distinction. With AI formatting off, it keeps local
formatting unless a rewrite was explicitly selected. Its AI step uses the same
provider and policy deadlines as live dictation; failure or timeout keeps the
immediate pre-AI text unchanged. Explicit selected-text/voice rewrite commands
and translation still use their separate transform paths. The validator compares
against the translated text only when a subsequent cleanup pass runs; it does not
claim to validate translation fidelity. Meeting transcript cleanup is unchanged.

No network request, telemetry, or cloud fallback is added. The existing
history/audio-retention settings continue to control recovery data. The exception
is the post-stop checkpoint (`dictation_checkpoint.rs`). Stopped audio stays in
private storage until the outcome is recorded. A stalled live-preview handoff,
a transcription failure following that handoff, or a native memory-headroom
refusal keeps a separate recovery file for 24 hours, even with History off.
"Recover last dictation" retries recognition and shows words for Copy or
Discard. It never inserts them automatically. A failed retry leaves the audio
available. Copy, Discard or expiry deletes that recovery file.

On Light-tier Macs, trusted Core ML speech files that need CPU preparation are
prepared on the first request, even if GGUF is installed. Dictation shows
"Preparing model" during that first load. CPU preparation may run at warning
pressure when its cold-load claim and reserve fit. ANE compilation still waits
for normal pressure and idle speech. Missing or broken Core ML retains the GGUF
fallback. Its actual engine is recorded, and its separate native constructor
and inference claims must pass admission. This fallback can exceed the Light
1 GiB dictation footprint target; a pending CPU preparation is not a reason to
use it.

A final dictation and an explicit recovery retry hold foreground speech
priority. Notes stop and new background text requests wait. Search batches
already yield to this priority; new local live meeting chunks now wait too.
An in-flight native chunk keeps its ownership until completion. Measured
resident decodes keep their existing margin. Critical pressure or unknown
headroom still refuses unsafe allocations and leaves refused dictation audio
available for recovery.

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

## Nearby spelling

The optional nearby-text spelling step uses a bounded, local, session-only
vocabulary. It follows explicit dictionary corrections and protects their
output. Only single-character changes in non-common words of at least five
letters and, in code editors, exact spoken identifier components qualify. Short names, ordinary
words, ambiguous matches, negation, numbers and conditions stay unchanged.
Applied spellings use the dictionary fidelity guard before AI cleanup, while
the original recognizer text remains available in change review. See
[nearby spelling](nearby-spelling.md) for consent, capture limits and boundaries.

## Name and term spelling from the audio

On the local Parakeet route, the speech helper also scores a short list of
terms against the audio with a small CTC model that runs on the CPU beside the
main recognizer (`rust-sidecar/src/dictation_vocabulary/`). The list, at most
500 terms, ranks the user's dictionary first, opt-in calendar names next
at most 150, then opt-in Contacts names at most 250, nearby words, and built-ins.
Calendar and Contacts are separate switches under "Use names from my calendar
and contacts to spell names". Both default to off and request permission only
when enabled. Their spelling lists stay in memory and never enter a cloud
prompt. Disabling a source clears it; calendar disconnection also clears
calendar names. No spelling attendee list is saved.

Calendar reads the past seven days and next two days. Dictation ranks today's
attendees first, then frequency and recency. Meetings prioritize the current or
next event. Contacts keeps its existing unusual-name priority because its local
reader exposes neither contact frequency nor recency. Both sources share name
sanitization and deduplication, existing acceptance rules, and pronunciation
respellings. They supply spelling hints, never unconditional replacements.
Local meeting transcription applies accepted hints to the transcript and its
timed segments together. A hint crossing segment boundaries stays unchanged.
The built-in list contains developer terms and names whose spelling does not
follow English pronunciation.

Dictionary, calendar, Contacts and nearby terms use one-to-three-word windows. The
helper keeps three spelling candidates and can add three candidates from supplied
pronunciations or the CTC recognizer's spelling. It scores every pronunciation
form of each selected user term over the same audio frames. Spaces used to show
syllables in an alias do not limit the recognized word window. Built-in terms
retain their existing candidate and pronunciation selection.

A user candidate must beat the original words by at least 0.1 per-frame CTC
log-likelihood. A proposal with spelling similarity below 0.5 needs a margin
of at least 0.5. Known names normally need 1.0; a matching pronunciation can
use 0.1. These are local rescoring thresholds, not probabilities of correctness.
The score must cover exactly the words being replaced. A score over a larger
phrase cannot justify changing only part of it.

Ordinary words, acronyms, numbers, negations and contractions remain protected.
A candidate also needs a close spelling or pronunciation, no better competing
term or longer span, and one occurrence of the heard phrase. Built-in terms
retain their stricter spelling and acoustic requirements. An empty dictionary
does not enable the expanded user-term path.

The user's own terms (dictionary, calendar, Contacts and nearby words) that are spelled
by another language's rules also go to the helper as English respellings
("shimon" for Szymon, "neev" for Niamh, "quin" for Quỳnh), from Polish,
Irish and Scottish Gaelic, Welsh, Vietnamese, Yoruba and Igbo, Hungarian,
Spanish and Basque, and Dutch, German and Nordic spelling marks; an English
name gets none. Accents, tone marks and letters such as "ł" and "đ" are
folded on both sides. A pronunciation match needs the same consonants, or one
consonant difference in a key of at least three consonants, and the same number
of vowel groups. This covers a respelling such as "Ifa" for Aoife, or a
multi-word name whose other words were heard exactly ("Lu Yang" for Liu
Yang), the spelling may be less close, and a heard name the word list knows
("Kieran" for Ciarán) is replaced only when the audio prefers the requested
term by the required margin.
"Simon" said in English stays when Szymon is in the dictionary, because the
audio prefers "Simon". The step runs after the dictionary pass,
skips its output, and records a "Name and term spelling" stage, so the
recognizer's text stays the change-review original and each spelling can be
restored.

The user-term margins and pronunciation shortlist were checked on the frozen
development split before the untouched comparison. Changes to `FLOORS` need
before/after audio evaluation, false-introduction checks and an empty-dictionary
control. The report under `opus-loop/vocab-boost` records the limits of that run.

The ACC-02 calendar/Contacts evaluation kept the original dictionary, split,
scorer and 104 WAV hashes. Name flags fell from 37 to 35, both gains on the
development split. The untouched split stayed at 15. This recovers 5.4% of the
baseline name errors and misses the 50% recovery target; both sources remain
opt-in and off by default. There were no false introductions over the inherited
6,184 absent dictionary-term/clip checks or 16,810 optional-name checks. The
42 clips without any fixture name and the distractor-only arm stayed unchanged.
These are repeated term checks over 104 clips, not independent recordings.

Five alternating performance passes measured 30.5 ms added p90 over 40 matched
clip pairs. The sum includes per-clip `vocabulary_build_us`, helper CTC and
rescoring time, and `vocabulary_apply_us`. Per-pass added p90 ranged from 27.5
to 46.9 ms on the shared 24 GB M4 Pro with the 8 GB tier simulated. This is a
headless vocabulary-stage measurement, not stop-to-insertion or packaged-app
qualification. The `opus-loop/calendar-contact-names` report retains the frozen
fixtures, diagnostics and limits. No acoustic acceptance threshold or
pronunciation rule changed for this evaluation.

The helper accepts an optional `vocabularyDiagnostics` list for headless
evaluation. It returns each requested term's per-form scores, word and frame
spans, and shortlist status. This extra scoring runs only when requested and
writes no files. Diagnostic timings do not measure the production path.

The text-only matcher uses generated pronunciation forms alone when a foreign
spelling has them. The written consonants of Szymon are not an English
pronunciation and cannot justify replacing Zimina. Explicit dictionary
replacements remain separate.

Model-free helper scoring checks compile the production Swift code with
`python3 scripts/test-native-asr-vocabulary.py`. They require Command Line Tools,
not XCTest or speech models. Protocol checks use
`python3 scripts/test-native-asr-helper.py <helper-path>` against the built helper.
