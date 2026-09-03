# Dictation Command Corpus Log

Generated: 2026-05-03T15:52:13.163Z

Local benchmark command checks currently pass at 100%. This corpus proves command parsing and no-command safety in the local fixture path. Packaged validation is still required for launch claims.

| ID | Label | App | Language | Expected | Actual | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| basic-notes | Basic dictation in notes | Apple Notes | en | no command | none | PASS |
| command-newline | Insert newline by command | Google Docs | en | newline | newline | PASS |
| command-paragraph | Insert paragraph break by command | Google Docs | en | paragraph | paragraph | PASS |
| command-undo | Undo the last insert by voice | Cursor | en | undo_last_insert | undo_last_insert | PASS |
| command-delete-last-sentence | Delete the last sentence by voice | VS Code | en | delete_last_sentence | delete_last_sentence | PASS |
| command-rewrite-shorter | Rewrite shorter command | Slack | en | rewrite_shorter | rewrite_shorter | PASS |
| command-rewrite-professional | Rewrite professional command | Cursor | en | rewrite_professional | rewrite_professional | PASS |
| command-bulletize-selection | Bulletize selection command | VS Code | en | bulletize_selection | bulletize_selection | PASS |
| snippet-positive-slack | App-scoped snippet expands in Slack | Slack | en | no command | none | PASS |
| snippet-negative-notion | App-scoped snippet stays off in Notion | Notion | en | no command | none | PASS |
| safety-no-command-center | Command prefix inside normal speech stays plain text | Messages | en | no command | none | PASS |
| es-word-follow-up | Spanish follow-up in Word | Word | es | no command | none | PASS |
| pt-outlook-follow-up | Portuguese follow-up in Outlook | Outlook | pt | no command | none | PASS |
| fr-notepad-quick-note | French quick note in Notepad | Notepad | fr | no command | none | PASS |
| de-hubspot-call-log | German call log in HubSpot | HubSpot | de | no command | none | PASS |
| it-google-docs-brief | Italian brief in Google Docs | Google Docs | it | no command | none | PASS |
| nl-slack-check-in | Dutch check-in in Slack | Slack | nl | no command | none | PASS |
| ja-notion-brief | Japanese brief in Notion | Notion | ja | no command | none | PASS |
| ko-cursor-comment | Korean comment in Cursor | Cursor | ko | no command | none | PASS |
| zh-vscode-checklist | Mandarin checklist in VS Code | VS Code | zh | no command | none | PASS |
| number-invoice-amount | Spoken currency becomes a written amount | Slack | en | no command | none | PASS |
| number-date-and-time | Spoken date and clock time become written form | Gmail | en | no command | none | PASS |
| number-phone-run | A run of spoken digits becomes a phone number | Messages | en | no command | none | PASS |
| number-ambiguous-stays-words | Ambiguous number words are left as spoken | Apple Notes | en | no command | none | PASS |

## Inverse text normalization (numbers as digits)

Added 2026-09-02. The stage lives in `rust-sidecar/src/text/itn.rs` and runs
in `apply_dictation_pipeline` after command handling and before snippet
expansion. It is off for the plain Voice preset and on for Messages, Email,
Notes and Meeting Follow-up (`dictationNumbersAsDigits` per profile).

Evidence is regenerated from the fixtures themselves, not retyped:

- `cargo test --lib fixture_evals -- --nocapture` runs
  `docs/evals/dictation-parity-fixture.json` and
  `docs/evals/dictation-quality-fixtures.json` through the real pipeline.
- `fixture_evals::report_before_and_after` prints before/after for every
  fixture line.

### Before/after on the existing fixtures

All 20 pre-existing parity scenarios and all 5 formatting cases come out of
the stage **byte-identical** — none of them contains a spoken number, so
there was nothing to normalize and nothing regressed. The dictionary cases
also produce their existing `expectedOutput` and applied count with the stage
switched on. `quality_formatting_fixtures_do_not_regress` asserts each
formatting case twice, with the stage off and on.

### Before/after on the lines that do contain spoken numbers

| Fixture line | Before | After |
| --- | --- | --- |
| number-invoice-amount | the invoice came to twelve dollars fifty | the invoice came to $12.50 |
| number-date-and-time | let us meet march third at three thirty pm | let us meet March 3 at 3:30 pm |
| number-phone-run | call me at five five five one two three four five six seven | call me at 555-123-4567 |
| number-ambiguous-stays-words | one of them is broken and a couple of others need a second look | *(unchanged)* |
| num-cardinal | we shipped one hundred twenty three builds | we shipped 123 builds |
| num-year-composed | the contract renews two thousand and twenty six | the contract renews 2026 |
| num-year-pair-without-date | twenty twenty six is the target | *(unchanged)* |
| num-year-pair-in-date | the release ships in march twenty twenty six | the release ships in March 2026 |
| num-time-without-context | three thirty | *(unchanged)* |
| num-time-with-at | let us sync at three thirty | let us sync at 3:30 |
| num-time-with-meridiem | march third at three thirty pm | March 3 at 3:30 pm |
| num-currency-bare-cents | twelve dollars fifty | $12.50 |
| num-currency-explicit-cents | twelve dollars and fifty cents | $12.50 |
| num-currency-euro-pound | it costs three pounds fifty or five euros | it costs £3.50 or €5 |
| num-currency-weight-guard | three pounds of flour | 3 pounds of flour |
| num-decimal | the load average is three point five | the load average is 3.5 |
| num-decimal-guard | the point is simple | *(unchanged)* |
| num-percent | twenty percent off | 20% off |
| num-ordinal-in-date | the first of may | the 1st of May |
| num-ordinal-guard | give me a second | *(unchanged)* |
| num-one-of-them | one of them is broken | *(unchanged)* |
| num-couple-of | a couple of things | *(unchanged)* |
| num-for-four | this is for the team and for four people | this is for the team and for 4 people |
| num-to-two | send it to the team in two places | send it to the team in 2 places |
| num-phone | call me at five five five one two three four five six seven | call me at 555-123-4567 |
| num-units-keep-the-word | twenty five kilometers | 25 kilometers |
| num-adjacent-non-composing | seven eighty eight | *(unchanged)* |
| num-idempotent | 232 already numeric 3:30 pm $12.50 January 5, 2025 | *(unchanged)* |
| num-url-untouched | the file is at https://example.com/two/three | *(unchanged)* |

The parity fixture's `itnOutput` field records the stage's output for a
profile that has numbers as digits **on**; the scenario's `expectedOutput`
stays the profile-off result, which is what the plain Voice preset produces.

### Cost

`fixture_evals::stage_cost_on_two_hundred_words`: 228 words, 200 runs,
**61.4 µs per run** (2026-09-02, debug build, machine load average ~78 with
other builds running, so treat the number as provisional and an upper bound).
Against the 6 s dictation budget that is ~0.001%.

### Bounds

Deliberate limits, each with a test in `rust-sidecar/src/text/itn.rs`:

- A bare "one" is never a digit ("one of them", "one drive is full").
- Two number groups that do not compose stay as words ("two thirty",
  "twenty twenty six", "seven eighty eight") unless a time or date rule
  claims them.
- "three thirty" is a clock time only with am/pm or an at-style preposition.
- "twenty twenty six" is a year only after a month name.
- "point" starts a decimal only after a number.
- Simple ordinals ("first" .. "tenth") convert only in a date context.
- Units keep the user's word: "25 kilometers", never "25 km".
- Large values are written without thousands separators ("3400000").
- "one eight hundred" phone prefixes are not recognized; only runs of
  individually spoken digits are.
- Bare "fifty cents" (no amount) is not converted to "$0.50".
