# Notes variant robustness

Single-fixture fixes kept regressing on fresh captures, so this eval runs the
notes pipeline on many ASR-style variants of every notes-fidelity fixture.

## Variants

`scripts/evaluate-notes-variants.py generate` builds 30 deterministic variants
per fixture from a seed (default `plainsong-notes-variants-v1`). Variant 0 is
the exact fixture rows, as the existing native probe builds them. The others
regroup the fixture into passages using the production analysis rule. Each
then combines seeded transforms:

- ordinal and month-day forms ("14th", "fourteenth", "the 14", "March sixth")
  and spelled small counts;
- dropped or added punctuation, run-on joins and comma-to-period breaks;
- lowercased sentence starts or whole passages, except names;
- fillers ("um", "you know,", "okay so") and one- to three-word stutters;
- swapped coordinated clauses, split coordinations and fronted conditions;
- passages split into separate rows, truncated repeats of a passage head and
  backchannels from another speaker;
- word, phrase or sentence rows.

Transforms never split a number, a date or "only if". They keep stutters
within a sentence and avoid bare joins that would make a condition's scope
ambiguous. Aside gaps stay empty. Text stays synthetic.

## Meaning annotations

`notes-variants-gold.json` lists each fixture's commitments by hand: owner,
verb and object prefixes, condition terms, dates, polarity, and whether it is
a key decision or an expected action. It also lists the only status statements
the source makes, and:

- `labels`: spoken headings or capture labels that name no person, deliverable
  or product;
- `numbers`: each quantity (not a calendar date) with the word prefixes of its
  own clause, and any restriction a restatement must keep;
- `actors`: for each person, the verb prefixes the source makes that person
  the subject of.

These annotations are independent of the Rust verifier.

A key decision is an agreement or a commitment with a condition. Prose covers
it when one clause states the decision, its condition and its date. Actions use
the fixture's existing expectations, with date forms normalized.

## Detectors

`score` checks every delivered sentence and action item for:

- condition-scope transfer: a condition attached to a commitment whose own
  clause has another condition or none;
- dropped or invented conditions;
- conditions extended beyond the source condition's own words ("and Priya's
  review", "and other conditions");
- negation flips, owner changes and date changes;
- invented numbers and entities;
- status or completion claims the source does not make;
- commentary on the transcript, the recording or the process ("stated
  across multiple lines", quoted phrases, "clearly defined");
- words found only inside an annotated label;
- a person as the subject of a verb the annotations do not give them, or a
  reported statement whose content that person did not say;
- a quantity stated with another quantity's or a commitment's words, or
  without its restriction.

Sentences without a detector hit still need a source audit before a
zero-unsupported claim. `audit-pack` writes those sentences, grouped by
meeting with only the meeting's source text, for a reviewer who sees no
pipeline or detector output:

```sh
python3 scripts/evaluate-notes-variants.py audit-pack \
  --set /run/dir docs/evals/notes-fidelity-fixtures.json docs/evals/notes-variants-gold.json \
  --out /run/dir/audit-pack.json
```

Pass `--audit` to `score` with a file of `{"sentences": [{"text",
"supported"}]}` verdicts.

## Runs

Check `memory_pressure` and free disk, then run under the build-slot guard:

```sh
python3 scripts/evaluate-notes-variants.py run --models /owned/models --out /new/dir
python3 scripts/evaluate-notes-variants.py score /new/dir --out /new/dir/scores.json
```

The ignored `native_notes_variant_probe` runs every variant in one process
with production prompts, orchestration, grouping and native admission. A
refused admission waits and retries; the reserve is never lowered. Existing
receipts are kept, so an interrupted run resumes. `--test-binary` runs a
prebuilt `--no-run` test binary, so no cargo build occurs during generation.

`native_notes_variant_replay` replays recorded native responses through the
current verifier for identical prompts. A prompt the native run never made
counts as a miss; such receipts need a native run. `variant_frames_dump`
writes the commitments and coverage text the source alone supports, without
a model.

`notes-variants-holdout-fixtures.json` and its gold file hold meetings that
are not used by Rust tests. Use `--fixtures` and `--gold` to run them. They
were tuned on after their first run. The `-r2` to `-r4` sets were written
blind by a separate reviewer for round 2 and were tuned on during that
round. The `-r5` set was scored blind in the extractive round, then read
and tuned on in its second round. The `-r6` set was written blind for that
second round by a separate writer who never saw the verifier, and was read
and tuned on in the third round. The `-r7` set was written blind for the
third round the same way; score it and report only the aggregate numbers the
scorer prints.

## Quoted recaps

Recaps quote whole source sentences (see `rust-sidecar/src/llm/extractive_recap.rs`).
Each bullet is `- Speaker (m:ss): “sentence”`, `- m:ss: “sentence”` or
`- Your notes: “sentence”` under a closed list of headings, with an optional
`Topics:` line. The scorer reads each quote as one claim, with first-person
singular words resolved to the attributed speaker, and runs the same
detectors on it. A detector hit on a quote flags the source's own wording:
a superseded date followed by its correction, or a run-on that joins two
clauses. Such hits are reported separately from model claims.

Two scorer changes apply to every pipeline: a leading condition may follow
discourse words ("Yes, if Noah sends it, ..."), and a leading condition
without a comma ends where the commitment's subject and modal begin. For
quoted recaps only, a key decision also counts as covered when one quote
states it with its condition and one of the next two quotes states its
corrected date, not the superseded one ("show both in order"). The score
records the stricter single-sentence count as `strictCovered`.

The proof that nothing shown is unsupported is mechanical. Run
`llm::extractive_recap` tests for the property test over every development
and held-out meeting, clean and with ASR noise, under random model picks.
`variant_extractive_dump` checks a generated variants file and writes
source-only receipts (model `source-only`) for the scorer;
`native_receipts_proof` checks delivered native receipts. Both print only
counts, so a blind set can be checked without reading it:

```sh
NOTES_VARIANTS=/run/variants.json NOTES_DUMP_DIR=/run/source-only \
  <test binary> llm::notes_probe::variant_extractive_dump --ignored --exact --nocapture
NOTES_RECEIPTS=/run/native <test binary> llm::notes_probe::native_receipts_proof --ignored --exact --nocapture
```

## Quoted action items

An extractive action item's `task` is its source sentences, and its
`evidence` is the same sentences one per line, each attributed as a recap
quote is (`Speaker (m:ss): “…”`). The scorer reads such an item sentence by
sentence, with first-person words resolved to each sentence's own speaker,
and runs the same detectors. A hit counts as explained, and is reported
separately, only when the item itself shows the answer in order:

- a stale date, when a later sentence of the item, or the rest of the same
  sentence after a self-correction cue ("or rather", "sorry", "I mean",
  "make that", "no", "wait", "actually", "correction", "instead"), states the
  commitment's own date;
- a dropped condition, when an earlier sentence of the item states the
  commitment with that condition (a correction that restates it briefly).

- an owner change, when a later sentence of the item makes the
  commitment's own owner the subject of its verb ("so Lindiwe should upload
  it").

The table's last flagged count, in parentheses, is the unexplained items.
Items marked `unclear` (a commitment whose owner or restated value the
meeting leaves in doubt, listed with its owner withheld when disputed) are
scored like any other item; the scorer prints how many there are
(`unclearItems`).

Date reading: "the 9th of October", "9 October" and "October the ninth" are
one date, and a date replaced by a self-correction in the same sentence
counts as rejected, like "Wednesday, not Monday". Clause reading: a condition
that opens a later clause ("…, and unless the inspection slips, Aksel will
…") leads that clause; commas before a named subject and modal, colons, and
an unpunctuated named subject with a modal start clauses; "I mean" is
discourse; a heading opening a quoted sentence is not a claim; days of dates
are not quantities. The show-both coverage rule also reads a bare "the 28th"
in a short correction as a date. Strict coverage is printed beside it.

Third-round readings: gold condition, verb and object terms are compared in
the scorer's canonical form ("second" reads as "2", as in sentences); a
quantity's restriction is checked against the annotated quantity whose terms
the clause uses when two share a value ("12 pounds for students", "at least
12 singers"); a day after "the" that no quantity word follows ("Not the 8th,
the 15th.") is not a quantity; a possessive name ("Lindiwe's file") is not a
subject at that occurrence. The generator fronts a trailing condition only
over a sentence with one commitment, since fronting it over two ("…by
Tuesday, but I won't pay the invoice until …") moves it onto the wrong one.
