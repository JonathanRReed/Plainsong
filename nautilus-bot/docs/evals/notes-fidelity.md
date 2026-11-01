# Local notes fidelity

`notes-fidelity-fixtures.json` contains twelve synthetic English meetings and 27
expected commitments. The original four retain their 13 commitments; the new
museum-access and garden-sensor meetings add four. The conditional beta fixture repeats the fictional
shipping sentence used by the existing notes probe. It reproduces its meaning,
including the unnamed shipping group, conditional date and Priya's review.
It is not an exact replay of captured word rows.

`packaged-b21-16gb` preserves all 322 word rows from the synthetic b21 QA
capture, including track labels, overlaps and partial phrases. The probe groups
`transcriptSegments` through production analysis code. Its regression check
matches the 13 expected passages in `segments`, which the scorer audits.
The original receipt path and SHA-256 are stored with the fixture.

`b24-full-16gb` preserves all 339 word rows from the b24 Full 16 GB packaged
receipt, including their original IDs, track labels, times and incomplete ending.
Production grouping must reproduce its 14 passages. This differs from b23's
12 passages and includes a final partial commitment to replace the passage.

`b25-full-16gb` preserves all 409 word rows from the b25 Full 16 GB receipt.
Production grouping gives 15 passages, including Me and Them copies and
truncated endings such as "if the memory gate". `notes-variants.md` describes
the variant eval built on these fixtures.

Run `bun run notes:fidelity:test` for scorer checks. To run both installed
models, first check memory pressure and free disk, then use the repository's
shared build-slot guard to run:

```sh
python3 scripts/evaluate-notes-fidelity.py run --models /owned/models --out /new/receipts
```

The runner invokes `nice -n 10 env CARGO_BUILD_JOBS=4 bun scripts/cargo-sidecar.ts`
with the ignored native notes probe. It uses native admission and production
prompts, grouping, validation and output budgets. Model and license hashes must
match the runtime pins. The text helper must already be present. It never
installs dependencies or downloads weights. `--resume` preserves completed
receipts and archives failed receipts before retrying. Check the refusal and
current resources before retrying. When a summary completed but the immediate
action reload was refused, resume runs only actions in a fresh process. The
combined receipt sets `separateStageProcesses`; the original attempt and the
action-stage receipt remain separate. Compare these as isolated stages, not
as an end-to-end handoff measurement.

Each action must contain its task's required words, including conditions.
Owner and due-date recall use fields on that same item. Full recall requires
all fields. An absent owner or deadline in the source requires null. Names and
numbers use word boundaries across the delivered summary and action fields.
These are conservative lexical checks. Paraphrases can fail; extra action
items need a source audit. Fixture source-line numbers describe the original
rows, before production grouping.

Summary grounding requires a separate audit against the source. Score a
receipt with `bun run notes:fidelity score /receipt.json --audit /audit.json`.
Use a `delivered` array with one entry per generated sentence and a `pruned`
array with one entry per removed candidate, both in receipt order. Each entry
has `text`, a boolean `supported`, original fixture `sourceLines`, and a reason.
Mark a faithful rejected paraphrase with `paraphrase: true`. The scorer requires
an exact sentence match and checks source excerpts against the fixture.
Without a matching audit, support counts are null and `auditComplete` is false.
Count unsupported action claims, wrong owners and invented facts in that audit
too. The pipeline's `grounded` flag never substitutes for this audit.

`summaryMetrics` reports generated sentences retained, audited supported and
unsupported sentences, paraphrase false rejections, pruned candidates, excerpt
fallback, sentence count and quote-free readability. A readable result needs
at least one verified generated sentence and `noRawQuotes: true`. Report the original
13-action subtotal separately from the four added commitments.

Receipts retain synthetic prompts and generated text, token counts, model ID,
source hashes, memory samples and per-stage latency. Helper footprint excludes
mapped weights. Use peak resident bytes for the model memory budget, and report
process-tree footprint separately. Physical memory is simulated only to select
the tier; available memory and pressure remain measured. A shared 24 GiB host
run does not qualify an 8 GB or 16 GB Mac. A single run per case describes
observed latency and supplies no speedup claim.

Use `--fixture` and `--model` to run one case. Compile before sampling. The
current sampler counts the native test process and its text helper, excluding
Cargo, Bun and compiler processes. It records peak resident memory as well as
physical footprint. Early receipts without this scope may include compilation
in their process-tree footprint; use their helper-reported resident peak for
model comparisons.

The default local notes path can recover explicit English commitments from
source passages after validation. Default local summaries request one to six sentences and verify up to twelve
candidates against original passages using the same loaded model. Each yes
needs valid passage citations and still passes entity, number, qualifier and
commitment checks. A lexical overlap failure alone cannot reject a verified
paraphrase. Retained sentences keep their generated wording. Any pruning keeps
review status. No surviving sentences triggers cited excerpt
fallback. Invalid verifier output, a refused request or an input that cannot
fit the existing budget also fails closed. No new model or larger context is
loaded for verification. Report how often fallback was used. Source excerpts
do not establish abstractive summary quality.

Custom summary instructions keep the existing validation and repair path.
The new sentence-selection eval uses the default meeting summary.

Source passages are parsed into commitment frames: subject, modal, verb,
object, date, condition and polarity. Fillers and stutters are removed first,
split rows are rejoined and repeated or truncated copies are consolidated. A
clause whose condition could belong to either of two commitments, or whose
copies disagree, yields no coverage text and no condition judgment.

A summary sentence or action item may attach a condition, date, owner or
polarity to a commitment only when that commitment's own clause does. A
condition moved from another commitment, a dropped condition, a possibility
stated as a commitment, a prerequisite stated as a task or fact, one
commitment's verb with another's object, a dropped "only with" qualifier and
an unstated "initial" or "next step" are all rejected.

After sentence selection, each agreement or conditional commitment missing
from verified prose is stated from its own clause's fields, for example "We
agreed to ship the beta on the 14th if the memory gate passes." A retained
sentence that only partly restates it is replaced. Coverage text cites the
clause's passages and still checks names and numbers. Receipts record it as
`supported_source_agreement` or `supported_source_commitment`. Native default
action lists get the same coverage; an item for exactly one commitment is
restated from that commitment's fields.

A verifier yes also needs a content anchor in at most three cited passages.
Checks distinguish group statements from a named speaker, requirements from
predictions, and completed sending from a claim that no further action exists.
Commitment comparisons normalize articles and spoken numbers; delivered text
stays unchanged. Named commitments also check corrected deadlines.

Saved summary provenance includes `summaryDiagnostics`. It records the selected
draft, repair outcome, verifier status, rejection counts and fallback reason.
The supported count is measured before the prose threshold; the retained
count is measured after it. A failed request records its error kind. Invalid
payloads and inputs that exceed the verifier budget have separate statuses.
Logs contain these same outcomes and counts, without source text or generated
candidates. Older provenance has no diagnostics field.

If a completed verification retains fewer than two sentences, the default
playbook tries one new draft from the original source to recover missing facts.
One verified sentence remains sufficient if the retry adds nothing supported. Supported sentences keep
their wording and citations. Only new sentences receive another verification
pass. Repeated sentences are omitted. Unavailable or failed verification still
falls back to source excerpts when no checked sentences remain.

Task conditions are checked against the original passages, including later
qualifications outside the selected citations. Unattributed first-person
sentences are excluded.

Independent tasks cannot inherit each other's conditions. A conditional
shipment does not make the agreement itself tentative. Capture labels are not
deliverables, and source commentary does not count toward the prose threshold.

The retry writer receives a copy with detected capture-label prefixes removed.
The verifier receives selectable original passages. Stored transcript text and
line IDs are unchanged.

The verifier's citation choices prefer complete passages over redundant partial
copies. Only selectable passages appear in its prompt; unique partial evidence
stays selectable. This prevents a repeated fragment from hiding its subject.

The b23 fixtures preserve public synthetic word rows from Full 16 GB, Normal
asides and Light asides. Their expected passages use production grouping.
Aside ranges remain gaps in recording time. No aside text is included.
Owner variants resolve only when an identical grounded task in the same
recording independently supplies one canonical spelling. Distinct owners,
dates and conditions remain separate.

`notes-grounding-regressions.json` includes the unsupported workshop completion
and Normal-aside pending status from the native receipts. It varies status
words, subjects, negation, questions, quotations and conditions.
`notes-summary-round2-replays.json` preserves the failing sentences and the
conditional shipping recovery for deterministic replay with verifier yes votes.

Status words and past passive activity claims need a matching original source
sentence after article and number normalization. This deliberately rejects
some faithful status paraphrases. A prerequisite, question, quotation or nearby
completed task cannot establish another task's status. The one-sentence
acceptance minimum remains independent of the writing prompt.

Summary owner variants deduplicate only after both sentences pass verification.
Their full task wording and source identities must match. Ambiguous spellings,
separate speakers, recordings and source kinds remain separate. Numeric ordinal
deadlines such as "the 14th" pass the existing task/date relationship check.
