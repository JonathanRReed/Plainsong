//! Post-insert correction capture.
//!
//! Plainsong already learns from corrections the user types back into its own
//! result box. Almost nobody does that: the dictated text lands in Slack, Gmail
//! or an editor, the user fixes the one wrong word *there*, and Plainsong never
//! finds out. This module is the other half — it reads the destination field
//! back a few seconds after an insertion, works out which words the user
//! changed, and queues those as *low-confidence suggestions* the user has to
//! approve by hand.
//!
//! Because it reads text out of another application's field, it is off by
//! default and every step here is written to fail closed:
//!
//! - the caller must have the setting on (`should_attempt_readback`);
//! - the readback must land on the *same* app and the *same* focused element
//!   the insertion targeted (`FocusedFieldFingerprint::matches_insertion`);
//! - the inserted text must still be locatable in the field
//!   (`locate_inserted_span`) — if the user rewrote the message rather than
//!   corrected it, the anchor confidence gate rejects the whole readback;
//! - each word-level candidate must clear `candidate_is_acceptable`;
//! - and nothing is ever applied. The output is a queue entry, full stop.
//!
//! Everything in this file is pure except `FocusedFieldReader`, which is the
//! single seam where the real macOS Accessibility call lives. Tests drive the
//! whole flow through a fake reader.

use std::collections::HashSet;

/// How long after an insertion Plainsong is still willing to read the
/// destination field back.
///
/// Eight seconds is the window in which a correction is still plausibly a
/// *correction*. Users who spot a wrong word do it as the text appears —
/// they fix it in the first few seconds and move on. Read back much earlier
/// and the fix has not happened yet; read back much later and the field has
/// filled with new sentences the user is composing, which is a rewrite, not a
/// correction, and is exactly the content this feature must not be reading.
/// A short window is also the privacy story: Plainsong looks once, briefly,
/// at a field it just wrote into, and never again.
pub const POST_INSERT_READBACK_WINDOW_SECS: i64 = 8;

/// How long a queued suggestion survives without being approved or dismissed.
/// A week is long enough to cover "I'll deal with this on Monday" and short
/// enough that the inbox does not become an archive of text pulled out of
/// other people's apps.
pub const CORRECTION_SUGGESTION_MAX_AGE_DAYS: i64 = 7;

/// Hard cap on the queued-suggestion table. Past this the oldest entries are
/// dropped: the queue is a review inbox, not a log.
pub const CORRECTION_SUGGESTION_QUEUE_CAP: usize = 60;

/// Most word-level candidates one readback may contribute. A genuine
/// correction pass is one or two fixed words; more than this and the diff is
/// describing an edit, not a correction.
pub const MAX_CANDIDATES_PER_READBACK: usize = 3;

/// If the raw word alignment produces more distinct replacements than this,
/// the whole readback is discarded rather than trimmed — a diff that busy
/// means the user rewrote the text.
const MAX_RAW_REPLACEMENTS_BEFORE_BAIL: usize = 5;

/// Fraction of the inserted words that must still be present, in order, in the
/// read-back field for the inserted span to count as "located". Below this the
/// text on screen is no longer recognisably what Plainsong typed.
const MIN_SPAN_ANCHOR_CONFIDENCE: f64 = 0.6;

/// Longest field value the readback will consider, in characters. A field far
/// larger than the insertion is a document, and Plainsong has no business
/// diffing a document.
pub const MAX_READBACK_CHARS: usize = 4000;

/// Word ceiling on either side of the alignment. The subsequence table below is
/// quadratic, and this runs on a background thread after every insertion, so
/// the worst case has to be a number rather than "whatever the user pasted
/// into". Six hundred words is far past any dictation that could still be
/// called a correction; past it the readback is abandoned rather than trimmed.
const MAX_ALIGNMENT_WORDS: usize = 600;

/// Word/char bounds on either side of a candidate. Mirrors
/// `dictation_parity::looks_like_auto_learning_safe_phrase`, which guards the
/// in-app learning path, so both paths learn the same shape of thing.
const MAX_CANDIDATE_WORDS: usize = 4;
const MAX_CANDIDATE_CHARS: usize = 48;

/// A candidate correction is thrown away when the two sides differ by more
/// than this fraction of the longer side. At that point the user replaced the
/// phrase rather than corrected it, and learning it would teach the dictionary
/// a substitution that has nothing to do with what was misheard.
const MAX_EDIT_DISTANCE_RATIO: f64 = 0.6;

/// Longest a candidate may be when it is written in a script that does not put
/// spaces between words.
///
/// The word bounds above are counted with `split_whitespace`, which is a lie in
/// Japanese, Chinese, Thai, Lao, Khmer and Burmese: a whole clause arrives as
/// one "word", so `MAX_CANDIDATE_WORDS` never bites and 48 characters is most
/// of a sentence. For an unsegmented run the character count is the only
/// available proxy for length, and eight of them is a term or a name — which is
/// what "word-level only" is supposed to mean.
const MAX_UNSEGMENTED_CANDIDATE_CHARS: usize = 8;

/// Shortest run of the insertion that must have survived, verbatim and
/// contiguous, for the field to count as still holding what Plainsong typed.
///
/// Order-preserving overlap alone is too easy to hit by accident: a search box
/// containing "the report" shares words with half of everything. Two adjacent
/// words in the same order is a much less likely coincidence, and every real
/// correction leaves far more than that behind.
const MIN_INSERTION_REMNANT_RUN_WORDS: usize = 2;

/// How many of the insertion's own words, adjacent and in order, have to turn
/// up twice in the field before Plainsong calls the anchor ambiguous.
///
/// Same number as the remnant run above and for the same reason — two adjacent
/// words in the same order is the smallest thing in this module that is
/// evidence rather than coincidence — but a separate constant, because the two
/// rules answer different questions and could want to diverge.
const MIN_AMBIGUOUS_REPEAT_RUN_WORDS: usize = 2;

/// The identity of a focused text field, captured without holding on to any
/// Accessibility pointer.
///
/// The readback runs seconds after the insertion, on a different thread, so a
/// retained `AXUIElementRef` would be both unsound to move and stale by the
/// time it is read. Instead both sides record the same cheap, comparable
/// facts, and the readback refuses to proceed unless they agree.
/// Where a focused element sits on screen, in whole points.
///
/// This is the discriminator that actually separates *sibling* fields. An
/// Electron or Chromium app typically publishes no `AXIdentifier` and no
/// `AXTitle` on its text inputs, so a message composer and a search box in the
/// same window agree on pid, role, identifier, title, window and application —
/// everything except where they are. Rounded to points because AX hands back
/// floats and two reads of a stationary element must compare equal.
///
/// A field that moves between the insertion and the readback (the user scrolled
/// or resized) reads as a different field and the readback is abandoned. That
/// is the safe direction to be wrong in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FocusedFieldFrame {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FocusedFieldFingerprint {
    /// Owning process id of the focused element.
    pub pid: Option<i32>,
    /// `AXRole`, e.g. `AXTextArea`.
    pub role: Option<String>,
    /// `AXIdentifier` when the app publishes one.
    pub identifier: Option<String>,
    /// `AXTitle` when the app publishes one.
    pub title: Option<String>,
    /// `AXTitle` of the element's `AXWindow`, when there is one.
    pub window_title: Option<String>,
    /// `AXIdentifier` of the element's `AXWindow`, when the app publishes one.
    pub window_identifier: Option<String>,
    /// Screen rectangle of the element itself. See `FocusedFieldFrame`.
    pub frame: Option<FocusedFieldFrame>,
    /// Bundle id of the frontmost application at the time of capture.
    pub frontmost_bundle_id: Option<String>,
    /// Localized name of the frontmost application at the time of capture.
    pub frontmost_app_name: Option<String>,
}

fn optional_eq_ignore_case(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        (None, None) => true,
        _ => false,
    }
}

impl FocusedFieldFingerprint {
    /// Whether this (readback-time) fingerprint still describes the element the
    /// insertion wrote into.
    ///
    /// Every field has to agree, including the ones that are `None` on both
    /// sides: an app that published an `AXIdentifier` at insertion time and
    /// stopped publishing one is not the same field as far as this check is
    /// concerned. Erring towards "not the same" costs a suggestion; erring the
    /// other way reads a stranger's field.
    ///
    /// None of this is airtight on its own, and it is not asked to be. An app
    /// that publishes nothing distinguishing leaves two `None`s comparing equal
    /// — which is why identity is never the last gate. `evaluate_post_insert_readback`
    /// runs `readback_holds_insertion_remnant` immediately after this and
    /// refuses to diff a field that does not still visibly hold the text
    /// Plainsong typed, whatever the fingerprint said.
    pub fn matches_insertion(&self, insertion: &FocusedFieldFingerprint) -> bool {
        self.pid == insertion.pid
            && self.frame == insertion.frame
            && optional_eq_ignore_case(self.role.as_deref(), insertion.role.as_deref())
            && optional_eq_ignore_case(self.identifier.as_deref(), insertion.identifier.as_deref())
            && optional_eq_ignore_case(self.title.as_deref(), insertion.title.as_deref())
            && optional_eq_ignore_case(
                self.window_title.as_deref(),
                insertion.window_title.as_deref(),
            )
            && optional_eq_ignore_case(
                self.window_identifier.as_deref(),
                insertion.window_identifier.as_deref(),
            )
            && optional_eq_ignore_case(
                self.frontmost_bundle_id.as_deref(),
                insertion.frontmost_bundle_id.as_deref(),
            )
            && optional_eq_ignore_case(
                self.frontmost_app_name.as_deref(),
                insertion.frontmost_app_name.as_deref(),
            )
    }
}

/// What the reader saw: the field's current text plus who owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusedFieldSnapshot {
    pub text: String,
    pub fingerprint: FocusedFieldFingerprint,
}

/// The one hardware-bound seam in this feature.
///
/// The real implementation talks to macOS Accessibility and therefore cannot
/// run on CI or in `cargo test` without a granted, interactive session. Every
/// decision *around* the call — whether to call it at all, whether to trust
/// what came back, what to do with it — lives in pure functions below and is
/// tested through a fake implementation of this trait.
pub trait FocusedFieldReader {
    /// Reads the currently focused text field without activating, focusing or
    /// otherwise disturbing anything.
    ///
    /// `Ok(None)` means "nothing focused / nothing readable", which is a
    /// silent abort rather than an error.
    fn read_focused_field(&self) -> Result<Option<FocusedFieldSnapshot>, String>;
}

/// Whether the field a reader just looked at is plausibly the one Plainsong
/// wrote into, judged by whether the inserted text is actually sitting in it.
///
/// This is what makes the anchor trustworthy rather than assumed. Plainsong
/// inserts either by setting an Accessibility attribute or by dispatching a
/// paste; in the second case it never learns which element took the keystrokes.
/// Reading the focused field once, immediately, and finding the inserted text
/// there is direct evidence — and if it is not there, no anchor is recorded and
/// no readback is ever scheduled.
///
/// Compared on whitespace-normalized text, because destination apps reflow what
/// they are given (a chat box turns a newline into a send, an editor
/// re-indents).
pub fn anchor_snapshot_contains_insertion(snapshot_text: &str, inserted_text: &str) -> bool {
    let inserted = tokenize_words(inserted_text).join(" ");
    if inserted.is_empty() {
        return false;
    }
    tokenize_words(snapshot_text).join(" ").contains(&inserted)
}

/// Records which field an insertion landed in, immediately after it lands.
///
/// Returns `None` — meaning "do not follow this insertion up" — whenever the
/// evidence is not there: the read failed, nothing is focused, the field
/// exposes no text, the text Plainsong just inserted is not in it, or the app
/// actually in front is Plainsong itself.
///
/// `frontmost_is_self` is asked `(app_name, bundle_id)` about the app the
/// reader observed in front *now*, not the app the dictation was aimed at when
/// it started. Those differ whenever reactivation quietly failed and the paste
/// landed back in Plainsong's own window; the label recorded at session start
/// would still say Slack. Since the readback will only ever proceed against a
/// fingerprint recorded here, refusing here is enough to keep Plainsong's own
/// result box out of the other-apps path entirely.
pub fn capture_insertion_anchor(
    reader: &dyn FocusedFieldReader,
    inserted_text: &str,
    frontmost_is_self: &dyn Fn(Option<&str>, Option<&str>) -> bool,
) -> Option<FocusedFieldFingerprint> {
    let snapshot = match reader.read_focused_field() {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return None,
        Err(error) => {
            tracing::debug!("Post-insert anchor read failed: {}", error);
            return None;
        }
    };

    if frontmost_is_self(
        snapshot.fingerprint.frontmost_app_name.as_deref(),
        snapshot.fingerprint.frontmost_bundle_id.as_deref(),
    ) {
        return None;
    }

    if !anchor_snapshot_contains_insertion(&snapshot.text, inserted_text) {
        return None;
    }
    Some(snapshot.fingerprint)
}

/// A single original → corrected word-level pair, ready to be queued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadbackCorrectionCandidate {
    pub spoken_form: String,
    pub replacement: String,
}

/// Why a readback produced nothing. Every variant is a silent abort — none of
/// these reach the user, they only reach the logs and the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadbackAbort {
    /// The "learn from corrections in other apps" setting is off.
    SettingDisabled,
    /// The insertion never landed, or was undone.
    NoInsertionToCompare,
    /// More than `POST_INSERT_READBACK_WINDOW_SECS` has passed.
    WindowExpired,
    /// A newer dictation replaced the one being followed up.
    DeliverySuperseded,
    /// The Accessibility read failed.
    ReadbackFailed(String),
    /// Nothing is focused, or the field exposes no readable text.
    ReadbackEmpty,
    /// The field on screen is not the field that was written to.
    FocusChanged,
    /// The field is far larger than anything Plainsong should be diffing.
    ReadbackTooLarge,
    /// The field no longer visibly holds what Plainsong typed, so whatever it
    /// holds is not this insertion — however well the fingerprint matched.
    InsertionRemnantMissing,
    /// The field still holds exactly what was inserted.
    NoChange,
    /// The inserted text could not be found in the field with confidence, or
    /// could be found in more than one place and Plainsong cannot tell which
    /// one the user edited.
    SpanNotLocated,
    /// A diff was found, but nothing in it survived the filters.
    NoAcceptableCandidates,
}

/// The outcome of one post-insert readback. `Candidates` is the only variant
/// that queues anything, and even then the caller queues *suggestions* — this
/// type has no way to express "apply".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadbackOutcome {
    Aborted(ReadbackAbort),
    Candidates(Vec<ReadbackCorrectionCandidate>),
}

/// Everything the readback needs to know about the insertion it is following
/// up, gathered at insertion time.
#[derive(Debug, Clone)]
pub struct PostInsertReadbackRequest {
    /// Whether the user turned the feature on. Checked here rather than at the
    /// call site so "setting off" is a tested branch of the same function.
    pub enabled: bool,
    /// The text Plainsong actually inserted.
    pub inserted_text: String,
    /// Field identity recorded at insertion time.
    pub insertion_fingerprint: FocusedFieldFingerprint,
    /// Seconds between the insertion and this readback.
    pub elapsed_secs: i64,
    /// False when a newer dictation has since been delivered.
    pub delivery_is_current: bool,
    /// Lowercased spoken forms already in the dictionary. Used only by the
    /// case-only filter, which lets a casing fix through when the dictionary
    /// already has an opinion about that word.
    pub known_dictionary_spoken_forms: HashSet<String>,
}

/// Whether a readback should even be attempted, given the setting, the clock
/// and whether the delivery is still the current one.
///
/// Split out from `evaluate_post_insert_readback` so the "do not touch another
/// app's field" preconditions can be asserted on their own, without a reader.
pub fn should_attempt_readback(request: &PostInsertReadbackRequest) -> Result<(), ReadbackAbort> {
    if !request.enabled {
        return Err(ReadbackAbort::SettingDisabled);
    }
    if request.inserted_text.trim().is_empty() {
        return Err(ReadbackAbort::NoInsertionToCompare);
    }
    if !request.delivery_is_current {
        return Err(ReadbackAbort::DeliverySuperseded);
    }
    if request.elapsed_secs < 0 || request.elapsed_secs > POST_INSERT_READBACK_WINDOW_SECS {
        return Err(ReadbackAbort::WindowExpired);
    }
    Ok(())
}

/// Runs one post-insert readback end to end, in this order and no other:
/// guard, read, verify identity, **verify the field still holds the
/// insertion**, locate, diff, filter.
///
/// The remnant check sits between identity and the diff deliberately. A
/// fingerprint can only ever say "this looks like the same element", and on an
/// app that publishes no identifying attributes on its text inputs it says that
/// about sibling fields too. Nothing is diffed until the field itself shows
/// that Plainsong's words are in it.
///
/// The `reader` is the only impure argument; in tests it is a fake, in
/// production it is the macOS Accessibility implementation in `lib.rs`.
pub fn evaluate_post_insert_readback(
    reader: &dyn FocusedFieldReader,
    request: &PostInsertReadbackRequest,
) -> ReadbackOutcome {
    if let Err(abort) = should_attempt_readback(request) {
        return ReadbackOutcome::Aborted(abort);
    }

    let snapshot = match reader.read_focused_field() {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return ReadbackOutcome::Aborted(ReadbackAbort::ReadbackEmpty),
        Err(error) => return ReadbackOutcome::Aborted(ReadbackAbort::ReadbackFailed(error)),
    };

    if !snapshot
        .fingerprint
        .matches_insertion(&request.insertion_fingerprint)
    {
        return ReadbackOutcome::Aborted(ReadbackAbort::FocusChanged);
    }

    if snapshot.text.trim().is_empty() {
        return ReadbackOutcome::Aborted(ReadbackAbort::ReadbackEmpty);
    }

    if snapshot.text.chars().count() > MAX_READBACK_CHARS {
        return ReadbackOutcome::Aborted(ReadbackAbort::ReadbackTooLarge);
    }

    match derive_readback_candidates(
        &request.inserted_text,
        &snapshot.text,
        &request.known_dictionary_spoken_forms,
    ) {
        Ok(candidates) => ReadbackOutcome::Candidates(candidates),
        Err(abort) => ReadbackOutcome::Aborted(abort),
    }
}

/// The pure half: given what was inserted and what the field now holds, work
/// out which words the user corrected.
pub fn derive_readback_candidates(
    inserted_text: &str,
    readback_text: &str,
    known_dictionary_spoken_forms: &HashSet<String>,
) -> Result<Vec<ReadbackCorrectionCandidate>, ReadbackAbort> {
    let inserted_words = tokenize_words(inserted_text);
    if inserted_words.is_empty() {
        return Err(ReadbackAbort::NoInsertionToCompare);
    }
    let readback_words = tokenize_words(readback_text);
    if readback_words.is_empty() {
        return Err(ReadbackAbort::ReadbackEmpty);
    }
    if inserted_words.len() > MAX_ALIGNMENT_WORDS || readback_words.len() > MAX_ALIGNMENT_WORDS {
        return Err(ReadbackAbort::ReadbackTooLarge);
    }

    // Hard prerequisite, ahead of every other judgement about this text: the
    // field has to still hold the insertion. Whatever the fingerprint agreed
    // about, a field that does not is not the one Plainsong wrote to.
    if !readback_holds_insertion_remnant(&inserted_words, &readback_words) {
        return Err(ReadbackAbort::InsertionRemnantMissing);
    }

    let span = locate_inserted_span(&inserted_words, &readback_words)
        .ok_or(ReadbackAbort::SpanNotLocated)?;
    let span_words = &readback_words[span.start..span.end];

    if inserted_words == span_words {
        return Err(ReadbackAbort::NoChange);
    }

    let replacements = align_word_replacements(&inserted_words, span_words);
    if replacements.is_empty() {
        return Err(ReadbackAbort::NoChange);
    }
    if replacements.len() > MAX_RAW_REPLACEMENTS_BEFORE_BAIL {
        return Err(ReadbackAbort::SpanNotLocated);
    }

    let mut candidates = Vec::new();
    for (original, corrected) in replacements {
        let Some(candidate) = build_candidate(&original, &corrected, known_dictionary_spoken_forms)
        else {
            continue;
        };
        if candidates.contains(&candidate) {
            continue;
        }
        candidates.push(candidate);
        if candidates.len() == MAX_CANDIDATES_PER_READBACK {
            break;
        }
    }

    if candidates.is_empty() {
        return Err(ReadbackAbort::NoAcceptableCandidates);
    }
    Ok(candidates)
}

/// Half-open word-index range into the read-back field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsertedSpan {
    pub start: usize,
    pub end: usize,
}

fn tokenize_words(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>()
}

/// Finds where the inserted text lives inside the read-back field.
///
/// The field usually holds more than the insertion — a greeting above it, a
/// signature below, whatever the user typed next. Anchoring works off the
/// longest-common-subsequence of *words*: the inserted words that survived the
/// user's edit, in order, pin the span's ends, and the unmatched inserted words
/// on either side extend it back out to the insertion's own length.
///
/// Returns `None` when too few inserted words survive
/// (`MIN_SPAN_ANCHOR_CONFIDENCE`), which is the "user rewrote it, bail" case,
/// and also when the insertion could equally be *somewhere else* in the same
/// field — see `anchor_is_ambiguous`.
pub fn locate_inserted_span(
    inserted_words: &[String],
    readback_words: &[String],
) -> Option<InsertedSpan> {
    if inserted_words.is_empty() || readback_words.is_empty() {
        return None;
    }

    let matches = longest_common_subsequence_pairs(inserted_words, readback_words);
    if !meets_anchor_confidence(matches.len(), inserted_words.len()) {
        return None;
    }

    let (first_inserted, first_readback) = *matches.first()?;
    let (last_inserted, last_readback) = *matches.last()?;

    let start = first_readback.saturating_sub(first_inserted);
    let trailing_slack = inserted_words.len().saturating_sub(last_inserted + 1);
    let end = (last_readback + 1 + trailing_slack).min(readback_words.len());
    if end <= start {
        return None;
    }

    let span = InsertedSpan { start, end };
    if anchor_is_ambiguous(inserted_words, readback_words, span) {
        return None;
    }

    Some(span)
}

fn meets_anchor_confidence(matched_words: usize, inserted_words: usize) -> bool {
    inserted_words > 0
        && (matched_words as f64 / inserted_words as f64) >= MIN_SPAN_ANCHOR_CONFIDENCE
}

/// Whether some *other* part of the field would anchor the insertion just as
/// well as the span that was chosen.
///
/// The subsequence match is global and picks the longest run of agreement
/// anywhere in the field, which is the wrong answer whenever the same phrase
/// appears twice — a quoted reply, a chat backlog, a signature, a draft pasted
/// above the one being written. The chosen anchor can then land on the *older*
/// copy while the user's actual edit is in the newer one, and the diff reports
/// the difference between two things Plainsong never wrote, in the wrong
/// direction. That is not hypothetical: inserting "call the vendor tomorrow"
/// into a field that already quoted "call the vendor tomorow" produced a
/// suggestion teaching the typo.
///
/// Two questions are asked, because a repeat can hide from either one alone.
///
/// **Does the field say my words twice?** — `insertion_repeats_inside_readback`,
/// which looks at the whole field and cares nothing for where the span landed.
/// This is the one that catches a repeat the span has *swallowed*. The span
/// extends past its matched words by however many inserted words went
/// unmatched at each end, and that extension is clamped to the field's edges;
/// when it reaches an edge, the leftover region on that side is empty and a
/// region-based check has nothing left to look at. Reviewers found exactly
/// that: inserting "alpha bravo charlie delta" into a field reading
/// "alpha bravo zulu yankee alpha bravo charlie delka" produced a span
/// covering the entire field and a queued `delta -> delka` — a typo learned
/// off a stray earlier copy of "alpha bravo".
///
/// **Would some other part of the field anchor just as well?** — the region
/// test below. A second occurrence can clear the confidence bar on scattered,
/// non-adjacent words that the first question never sees, so it stays.
///
/// The two regions are checked separately rather than joined so that a match
/// cannot be manufactured out of the join between them.
fn anchor_is_ambiguous(
    inserted_words: &[String],
    readback_words: &[String],
    span: InsertedSpan,
) -> bool {
    if insertion_repeats_inside_readback(inserted_words, readback_words) {
        return true;
    }

    [
        &readback_words[..span.start],
        &readback_words[span.end.min(readback_words.len())..],
    ]
    .into_iter()
    .any(|region| {
        !region.is_empty()
            && meets_anchor_confidence(
                longest_common_subsequence_pairs(inserted_words, region).len(),
                inserted_words.len(),
            )
    })
}

/// Whether any `MIN_AMBIGUOUS_REPEAT_RUN_WORDS` adjacent words of the insertion
/// occur at two places in the field that do not overlap.
///
/// Deliberately position-blind. The bug this closes was that every earlier
/// check reasoned about *where* the span was, and a span pinned to a field
/// boundary leaves nowhere to look; asking about the field as a whole cannot be
/// dodged by a span that grew to cover everything. Occurrences are taken
/// greedily left to right, so the first one found is the earliest possible and
/// any later non-overlapping hit is a genuine second copy.
///
/// This is deliberately quick to trigger. An insertion that contains a phrase
/// the surrounding text also uses — or that repeats a phrase itself — will stop
/// producing suggestions in that field. That is a suggestion not made, which
/// costs the user nothing; the alternative is a suggestion built out of two
/// different pieces of text, which teaches the dictionary something nobody
/// said.
fn insertion_repeats_inside_readback(inserted_words: &[String], readback_words: &[String]) -> bool {
    let run = MIN_AMBIGUOUS_REPEAT_RUN_WORDS;
    if run == 0 || inserted_words.len() < run || readback_words.len() < run * 2 {
        return false;
    }

    for window in inserted_words.windows(run) {
        let mut first_occurrence_end: Option<usize> = None;
        for (start, candidate) in readback_words.windows(run).enumerate() {
            if !window
                .iter()
                .zip(candidate)
                .all(|(left, right)| left.eq_ignore_ascii_case(right))
            {
                continue;
            }
            match first_occurrence_end {
                // Overlaps the copy already counted, so it is the same words
                // seen again at a shifted offset, not a second copy.
                Some(end) if start < end => continue,
                Some(_) => return true,
                None => first_occurrence_end = Some(start + run),
            }
        }
    }

    false
}

/// Whether the field still visibly holds the text Plainsong typed.
///
/// Two independent things have to be true, because either alone is cheap to
/// satisfy by accident:
///
/// - most of the inserted words are still there in order
///   (`MIN_SPAN_ANCHOR_CONFIDENCE`), and
/// - at least `MIN_INSERTION_REMNANT_RUN_WORDS` of them survive *adjacent and
///   in order*, which scattered coincidental overlap does not give you.
///
/// This is the gate that stands between a fingerprint collision — two sibling
/// text fields in one Chromium window that publish nothing to tell them apart —
/// and diffing a field Plainsong never wrote to.
pub fn readback_holds_insertion_remnant(
    inserted_words: &[String],
    readback_words: &[String],
) -> bool {
    if inserted_words.is_empty() || readback_words.is_empty() {
        return false;
    }
    if !meets_anchor_confidence(
        longest_common_subsequence_pairs(inserted_words, readback_words).len(),
        inserted_words.len(),
    ) {
        return false;
    }

    let required_run = MIN_INSERTION_REMNANT_RUN_WORDS.min(inserted_words.len());
    longest_common_contiguous_run(inserted_words, readback_words) >= required_run
}

/// Longest run of words present in both, adjacent and in order, compared
/// case-insensitively so a casing fix does not break the run.
fn longest_common_contiguous_run(left: &[String], right: &[String]) -> usize {
    if left.is_empty() || right.is_empty() {
        return 0;
    }

    let mut previous = vec![0usize; right.len() + 1];
    let mut current = vec![0usize; right.len() + 1];
    let mut longest = 0usize;
    for left_word in left {
        for (column, right_word) in right.iter().enumerate() {
            current[column + 1] = if left_word.eq_ignore_ascii_case(right_word) {
                previous[column] + 1
            } else {
                0
            };
            longest = longest.max(current[column + 1]);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    longest
}

/// Matched `(left_index, right_index)` pairs of a word-level LCS, compared
/// case-insensitively so a casing fix still anchors the span it sits in.
///
/// Both sides are bounded by the callers (`MAX_READBACK_CHARS` on the field,
/// and the insertion is one dictation), so the quadratic table is small.
fn longest_common_subsequence_pairs(left: &[String], right: &[String]) -> Vec<(usize, usize)> {
    let rows = left.len();
    let columns = right.len();
    let mut table = vec![vec![0usize; columns + 1]; rows + 1];
    for row in (0..rows).rev() {
        for column in (0..columns).rev() {
            table[row][column] = if left[row].eq_ignore_ascii_case(&right[column]) {
                table[row + 1][column + 1] + 1
            } else {
                table[row + 1][column].max(table[row][column + 1])
            };
        }
    }

    let mut pairs = Vec::new();
    let (mut row, mut column) = (0usize, 0usize);
    while row < rows && column < columns {
        if left[row].eq_ignore_ascii_case(&right[column]) {
            pairs.push((row, column));
            row += 1;
            column += 1;
        } else if table[row + 1][column] >= table[row][column + 1] {
            row += 1;
        } else {
            column += 1;
        }
    }
    pairs
}

/// Turns the word alignment between the inserted span and its corrected form
/// into `(original phrase, corrected phrase)` pairs.
///
/// Only *replacements* count. A run where one side is empty is a pure
/// insertion or deletion — the user added a sentence or deleted one — and
/// teaches the dictionary nothing about what was misheard, so it is dropped
/// here rather than filtered later.
pub fn align_word_replacements(
    inserted_words: &[String],
    corrected_words: &[String],
) -> Vec<(String, String)> {
    let matches = longest_common_subsequence_pairs(inserted_words, corrected_words);

    let mut replacements = Vec::new();
    let mut inserted_cursor = 0usize;
    let mut corrected_cursor = 0usize;

    fn push_gap(
        replacements: &mut Vec<(String, String)>,
        inserted_gap: &[String],
        corrected_gap: &[String],
    ) {
        if inserted_gap.is_empty() || corrected_gap.is_empty() {
            return;
        }
        replacements.push((inserted_gap.join(" "), corrected_gap.join(" ")));
    }

    for (inserted_index, corrected_index) in matches {
        push_gap(
            &mut replacements,
            &inserted_words[inserted_cursor..inserted_index],
            &corrected_words[corrected_cursor..corrected_index],
        );
        // A matched pair is only "the same word" case-insensitively; a casing
        // fix on an anchor word is still a correction the user made.
        if inserted_words[inserted_index] != corrected_words[corrected_index] {
            replacements.push((
                inserted_words[inserted_index].clone(),
                corrected_words[corrected_index].clone(),
            ));
        }
        inserted_cursor = inserted_index + 1;
        corrected_cursor = corrected_index + 1;
    }

    push_gap(
        &mut replacements,
        &inserted_words[inserted_cursor..],
        &corrected_words[corrected_cursor..],
    );

    replacements
}

fn trim_phrase_edges(value: &str) -> String {
    value
        .trim_matches(|ch: char| !(ch.is_alphanumeric() || ch == '\'' || ch == '-'))
        .trim()
        .to_string()
}

fn contains_alphanumeric(value: &str) -> bool {
    value.chars().any(char::is_alphanumeric)
}

fn is_case_only_difference(original: &str, corrected: &str) -> bool {
    original != corrected && original.eq_ignore_ascii_case(corrected)
}

/// Whether a character belongs to a script that is written without spaces
/// between words: Han (both common blocks), the Japanese kana, Thai, Lao,
/// Khmer and Burmese. Hangul is left out on purpose — Korean does space its
/// eojeol, so the word counts above already mean something there.
fn is_unsegmented_script_char(ch: char) -> bool {
    matches!(ch as u32,
        0x3040..=0x30FF   // Hiragana + Katakana
        | 0x3400..=0x4DBF // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        | 0x0E00..=0x0E7F // Thai
        | 0x0E80..=0x0EFF // Lao
        | 0x1000..=0x109F // Myanmar
        | 0x1780..=0x17FF // Khmer
    )
}

/// Whether a phrase is a single unsegmented run that has outgrown what
/// "word-level" can mean.
///
/// Only applies when there is no whitespace to count words by *and* most of the
/// letters are from a no-space script — a Latin word with one kanji in it keeps
/// the ordinary 48-character ceiling.
fn exceeds_unsegmented_length(value: &str) -> bool {
    if value.split_whitespace().count() > 1 {
        return false;
    }
    let letters = value.chars().filter(|ch| ch.is_alphanumeric()).count();
    if letters == 0 {
        return false;
    }
    let unsegmented = value
        .chars()
        .filter(|ch| is_unsegmented_script_char(*ch))
        .count();
    unsegmented * 2 > letters && value.chars().count() > MAX_UNSEGMENTED_CANDIDATE_CHARS
}

/// Word-level Levenshtein over characters, used only to reject pairs whose two
/// sides have nothing to do with each other.
fn edit_distance(left: &str, right: &str) -> usize {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }

    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right.len() + 1];
    for (row, left_char) in left.iter().enumerate() {
        current[0] = row + 1;
        for (column, right_char) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != right_char);
            current[column + 1] = substitution
                .min(previous[column + 1] + 1)
                .min(current[column] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

/// Every filter a raw `(original, corrected)` pair has to clear, in one place.
///
/// `known_dictionary_spoken_forms` must be lowercased; it is only consulted by
/// the case-only rule, which otherwise rejects casing fixes outright (they are
/// usually the destination app's autocapitalisation, not the user's opinion).
pub fn candidate_is_acceptable(
    original: &str,
    corrected: &str,
    known_dictionary_spoken_forms: &HashSet<String>,
) -> bool {
    if original.trim().is_empty() || corrected.trim().is_empty() {
        return false;
    }
    if original == corrected {
        return false;
    }
    if !contains_alphanumeric(original) || !contains_alphanumeric(corrected) {
        return false;
    }

    let original_words = original.split_whitespace().count();
    let corrected_words = corrected.split_whitespace().count();
    if original_words == 0 || corrected_words == 0 {
        return false;
    }
    if original_words > MAX_CANDIDATE_WORDS || corrected_words > MAX_CANDIDATE_WORDS {
        return false;
    }
    if original.chars().count() > MAX_CANDIDATE_CHARS
        || corrected.chars().count() > MAX_CANDIDATE_CHARS
    {
        return false;
    }
    // The word counts above were produced by `split_whitespace`, which reports
    // "one word" for a whole Japanese, Chinese, Thai, Lao, Khmer or Burmese
    // clause. Where that is what happened, characters are the only honest
    // measure of length left.
    if exceeds_unsegmented_length(original) || exceeds_unsegmented_length(corrected) {
        return false;
    }

    if is_case_only_difference(original, corrected)
        && !known_dictionary_spoken_forms.contains(&original.to_lowercase())
    {
        return false;
    }

    let distance = edit_distance(original, corrected);
    let longest = original.chars().count().max(corrected.chars().count());
    if longest == 0 {
        return false;
    }
    if (distance as f64) > MAX_EDIT_DISTANCE_RATIO * longest as f64 {
        return false;
    }

    true
}

fn build_candidate(
    original: &str,
    corrected: &str,
    known_dictionary_spoken_forms: &HashSet<String>,
) -> Option<ReadbackCorrectionCandidate> {
    let original = trim_phrase_edges(original);
    let corrected = trim_phrase_edges(corrected);
    if !candidate_is_acceptable(&original, &corrected, known_dictionary_spoken_forms) {
        return None;
    }
    Some(ReadbackCorrectionCandidate {
        spoken_form: original,
        replacement: corrected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(value: &str) -> Vec<String> {
        value.split_whitespace().map(str::to_string).collect()
    }

    fn no_dictionary() -> HashSet<String> {
        HashSet::new()
    }

    fn fingerprint() -> FocusedFieldFingerprint {
        FocusedFieldFingerprint {
            pid: Some(742),
            role: Some("AXTextArea".to_string()),
            identifier: Some("message-input".to_string()),
            title: None,
            window_title: Some("general — Acme".to_string()),
            window_identifier: None,
            frame: Some(FocusedFieldFrame {
                x: 120,
                y: 880,
                width: 640,
                height: 72,
            }),
            frontmost_bundle_id: Some("com.tinyspeck.slackmacgap".to_string()),
            frontmost_app_name: Some("Slack".to_string()),
        }
    }

    /// Two text inputs in one Chromium window, as those apps really present
    /// them: same process, same role, same window, and nothing published on
    /// either one to tell them apart — only their place on screen.
    fn anonymous_sibling_field(y: i64) -> FocusedFieldFingerprint {
        FocusedFieldFingerprint {
            pid: Some(742),
            role: Some("AXTextArea".to_string()),
            identifier: None,
            title: None,
            window_title: Some("general — Acme".to_string()),
            window_identifier: None,
            frame: Some(FocusedFieldFrame {
                x: 120,
                y,
                width: 640,
                height: 72,
            }),
            frontmost_bundle_id: Some("com.tinyspeck.slackmacgap".to_string()),
            frontmost_app_name: Some("Slack".to_string()),
        }
    }

    struct FakeReader(Result<Option<FocusedFieldSnapshot>, String>);

    impl FocusedFieldReader for FakeReader {
        fn read_focused_field(&self) -> Result<Option<FocusedFieldSnapshot>, String> {
            self.0.clone()
        }
    }

    /// Stands in for `is_self_activation_target`, which lives in `lib.rs`.
    fn frontmost_is_plainsong(name: Option<&str>, bundle_id: Option<&str>) -> bool {
        name.map(|value| value.eq_ignore_ascii_case("Plainsong"))
            .unwrap_or(false)
            || bundle_id == Some("com.plainsong.app")
    }

    fn never_self(_: Option<&str>, _: Option<&str>) -> bool {
        false
    }

    fn request(inserted: &str) -> PostInsertReadbackRequest {
        PostInsertReadbackRequest {
            enabled: true,
            inserted_text: inserted.to_string(),
            insertion_fingerprint: fingerprint(),
            elapsed_secs: 3,
            delivery_is_current: true,
            known_dictionary_spoken_forms: no_dictionary(),
        }
    }

    fn reader_returning(text: &str) -> FakeReader {
        FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: text.to_string(),
            fingerprint: fingerprint(),
        })))
    }

    // ── Span anchoring ──────────────────────────────────────────────────────

    #[test]
    fn locates_an_insertion_surrounded_by_the_users_own_text() {
        let inserted = words("please review the kubernetes manifest");
        let readback = words("Hey team please review the kubernetes manifest thanks");
        let span = locate_inserted_span(&inserted, &readback).expect("span");
        assert_eq!(readback[span.start..span.end].join(" "), inserted.join(" "));
    }

    #[test]
    fn locates_a_span_whose_first_word_was_corrected() {
        // The anchor cannot be the leading word, so the span has to be
        // extended back out from the first surviving match.
        let inserted = words("kubernetes manifest looks fine to me");
        let readback = words("Kubernetes manifests look fine to me");
        let span = locate_inserted_span(&inserted, &readback).expect("span");
        assert_eq!(span.start, 0);
        assert_eq!(span.end, readback.len());
    }

    #[test]
    fn refuses_to_locate_a_span_when_the_user_rewrote_the_message() {
        let inserted = words("please review the kubernetes manifest before friday");
        let readback = words("actually let us talk about this in standup tomorrow");
        assert!(locate_inserted_span(&inserted, &readback).is_none());
    }

    #[test]
    fn refuses_to_locate_a_span_in_an_empty_field() {
        assert!(locate_inserted_span(&words("anything at all"), &[]).is_none());
        assert!(locate_inserted_span(&[], &words("anything at all")).is_none());
    }

    #[test]
    fn locates_a_span_that_gained_trailing_words() {
        let inserted = words("ship the release notes");
        let readback = words("ship the release notes and then tell marketing");
        let span = locate_inserted_span(&inserted, &readback).expect("span");
        assert_eq!(span.start, 0);
        assert_eq!(readback[span.start..span.end].join(" "), inserted.join(" "));
    }

    // ── Word alignment ──────────────────────────────────────────────────────

    #[test]
    fn aligns_a_single_corrected_word() {
        assert_eq!(
            align_word_replacements(
                &words("send it to cuban netties"),
                &words("send it to kubernetes"),
            ),
            vec![("cuban netties".to_string(), "kubernetes".to_string())]
        );
    }

    #[test]
    fn aligns_a_casing_fix_on_an_otherwise_matching_word() {
        assert_eq!(
            align_word_replacements(&words("ping jonathan today"), &words("ping Jonathan today")),
            vec![("jonathan".to_string(), "Jonathan".to_string())]
        );
    }

    #[test]
    fn ignores_pure_insertions_and_pure_deletions() {
        assert!(align_word_replacements(
            &words("ship the notes"),
            &words("ship the notes tomorrow"),
        )
        .is_empty());
        assert!(align_word_replacements(
            &words("ship the notes tomorrow"),
            &words("ship the notes"),
        )
        .is_empty());
    }

    #[test]
    fn aligns_two_separate_corrections_in_one_pass() {
        assert_eq!(
            align_word_replacements(
                &words("email raphael about the sequel query"),
                &words("email Rafael about the SQL query"),
            ),
            vec![
                ("raphael".to_string(), "Rafael".to_string()),
                ("sequel".to_string(), "SQL".to_string()),
            ]
        );
    }

    // ── Filters ─────────────────────────────────────────────────────────────

    #[test]
    fn rejects_whitespace_only_and_punctuation_only_candidates() {
        assert!(!candidate_is_acceptable(
            "  ",
            "kubernetes",
            &no_dictionary()
        ));
        assert!(!candidate_is_acceptable(
            "kubernetes",
            "   ",
            &no_dictionary()
        ));
        assert!(!candidate_is_acceptable("--", "—", &no_dictionary()));
    }

    #[test]
    fn rejects_a_case_only_change_with_no_dictionary_precedent() {
        assert!(!candidate_is_acceptable(
            "jonathan",
            "Jonathan",
            &no_dictionary()
        ));
    }

    #[test]
    fn accepts_a_case_only_change_the_dictionary_already_has_an_opinion_about() {
        let known = HashSet::from(["jonathan".to_string()]);
        assert!(candidate_is_acceptable("jonathan", "Jonathan", &known));
    }

    #[test]
    fn rejects_a_candidate_longer_than_the_safe_window() {
        assert!(!candidate_is_acceptable(
            "one two three four five",
            "six seven eight nine ten",
            &no_dictionary(),
        ));
        assert!(!candidate_is_acceptable(
            "a phrase that is well beyond the forty eight character ceiling",
            "short",
            &no_dictionary(),
        ));
    }

    #[test]
    fn rejects_a_pair_whose_two_sides_are_unrelated() {
        // A rewrite dressed up as a word swap: nothing in common, so learning
        // it would teach the dictionary a substitution nobody asked for.
        assert!(!candidate_is_acceptable(
            "tomorrow",
            "kubernetes",
            &no_dictionary()
        ));
    }

    #[test]
    fn accepts_a_plausible_mishearing() {
        assert!(candidate_is_acceptable(
            "kuberentes",
            "kubernetes",
            &no_dictionary()
        ));
        assert!(candidate_is_acceptable(
            "cuban netties",
            "kubernetes",
            &no_dictionary()
        ));
    }

    #[test]
    fn rejects_an_identical_pair() {
        assert!(!candidate_is_acceptable(
            "kubernetes",
            "kubernetes",
            &no_dictionary()
        ));
    }

    // ── Guards ──────────────────────────────────────────────────────────────

    #[test]
    fn refuses_to_read_back_when_the_setting_is_off() {
        let mut request = request("send it to cuban netties");
        request.enabled = false;
        assert_eq!(
            should_attempt_readback(&request),
            Err(ReadbackAbort::SettingDisabled)
        );
        assert_eq!(
            evaluate_post_insert_readback(&reader_returning("send it to kubernetes"), &request),
            ReadbackOutcome::Aborted(ReadbackAbort::SettingDisabled)
        );
    }

    #[test]
    fn refuses_to_read_back_after_the_window_closes() {
        let mut request = request("send it to cuban netties");
        request.elapsed_secs = POST_INSERT_READBACK_WINDOW_SECS + 1;
        assert_eq!(
            should_attempt_readback(&request),
            Err(ReadbackAbort::WindowExpired)
        );
    }

    #[test]
    fn reads_back_at_the_last_second_of_the_window() {
        let mut request = request("send it to cuban netties");
        request.elapsed_secs = POST_INSERT_READBACK_WINDOW_SECS;
        assert_eq!(should_attempt_readback(&request), Ok(()));
    }

    #[test]
    fn refuses_to_read_back_for_a_superseded_delivery() {
        let mut request = request("send it to cuban netties");
        request.delivery_is_current = false;
        assert_eq!(
            should_attempt_readback(&request),
            Err(ReadbackAbort::DeliverySuperseded)
        );
    }

    #[test]
    fn aborts_when_the_focused_element_changed() {
        let mut moved = fingerprint();
        moved.identifier = Some("search-box".to_string());
        let reader = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "send it to kubernetes".to_string(),
            fingerprint: moved,
        })));
        assert_eq!(
            evaluate_post_insert_readback(&reader, &request("send it to cuban netties")),
            ReadbackOutcome::Aborted(ReadbackAbort::FocusChanged)
        );
    }

    #[test]
    fn aborts_when_the_frontmost_app_changed() {
        let mut moved = fingerprint();
        moved.frontmost_bundle_id = Some("com.apple.mail".to_string());
        moved.frontmost_app_name = Some("Mail".to_string());
        let reader = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "send it to kubernetes".to_string(),
            fingerprint: moved,
        })));
        assert_eq!(
            evaluate_post_insert_readback(&reader, &request("send it to cuban netties")),
            ReadbackOutcome::Aborted(ReadbackAbort::FocusChanged)
        );
    }

    #[test]
    fn aborts_when_the_process_owning_the_field_changed() {
        let mut moved = fingerprint();
        moved.pid = Some(9999);
        let reader = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "send it to kubernetes".to_string(),
            fingerprint: moved,
        })));
        assert_eq!(
            evaluate_post_insert_readback(&reader, &request("send it to cuban netties")),
            ReadbackOutcome::Aborted(ReadbackAbort::FocusChanged)
        );
    }

    #[test]
    fn aborts_on_an_empty_readback() {
        assert_eq!(
            evaluate_post_insert_readback(
                &FakeReader(Ok(None)),
                &request("send it to cuban netties")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::ReadbackEmpty)
        );
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("    "),
                &request("send it to cuban netties")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::ReadbackEmpty)
        );
    }

    #[test]
    fn aborts_when_the_accessibility_read_fails() {
        let reader = FakeReader(Err("Accessibility read failed.".to_string()));
        assert_eq!(
            evaluate_post_insert_readback(&reader, &request("send it to cuban netties")),
            ReadbackOutcome::Aborted(ReadbackAbort::ReadbackFailed(
                "Accessibility read failed.".to_string()
            ))
        );
    }

    #[test]
    fn refuses_to_align_more_words_than_the_bound_allows() {
        // The alignment table is quadratic and this runs after every insert,
        // so the worst case has to be a number rather than an assumption.
        let long = "word ".repeat(MAX_ALIGNMENT_WORDS + 1);
        assert_eq!(
            derive_readback_candidates(&long, "word word", &no_dictionary()),
            Err(ReadbackAbort::ReadbackTooLarge)
        );
        assert_eq!(
            derive_readback_candidates("word word", &long, &no_dictionary()),
            Err(ReadbackAbort::ReadbackTooLarge)
        );
    }

    #[test]
    fn aborts_on_a_field_far_larger_than_the_insertion() {
        let huge = "word ".repeat(MAX_READBACK_CHARS);
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning(&huge),
                &request("send it to cuban netties")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::ReadbackTooLarge)
        );
    }

    #[test]
    fn aborts_when_the_field_still_holds_exactly_what_was_inserted() {
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("send it to cuban netties"),
                &request("send it to cuban netties")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::NoChange)
        );
    }

    #[test]
    fn aborts_when_the_user_rewrote_the_message_instead_of_correcting_it() {
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("actually let us talk about this in standup tomorrow"),
                &request("please review the kubernetes manifest before friday")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::InsertionRemnantMissing)
        );
    }

    // ── Sibling-field collision, and what stops it ──────────────────────────

    #[test]
    fn aborts_when_a_sibling_field_differs_only_in_where_it_sits() {
        // Chromium apps publish no identifier and no title on their text
        // inputs, so the composer and the search box agree on everything the
        // fingerprint used to carry. Their frames do not.
        let composer = anonymous_sibling_field(880);
        let search_box = anonymous_sibling_field(48);
        assert!(!search_box.matches_insertion(&composer));
        assert!(composer.matches_insertion(&composer));

        let reader = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "quarterly report".to_string(),
            fingerprint: search_box,
        })));
        let mut request = request("send it to cuban netties");
        request.insertion_fingerprint = composer;

        assert_eq!(
            evaluate_post_insert_readback(&reader, &request),
            ReadbackOutcome::Aborted(ReadbackAbort::FocusChanged)
        );
    }

    #[test]
    fn refuses_to_diff_a_field_that_no_longer_holds_the_insertion_however_well_it_matched() {
        // The last line of defence, tested with the fingerprint deliberately
        // made useless: both reads publish nothing distinguishing and agree on
        // every remaining field, so identity says "same element". The content
        // is what refuses — and it refuses before anything is diffed.
        let indistinguishable = FocusedFieldFingerprint {
            pid: Some(742),
            role: None,
            identifier: None,
            title: None,
            window_title: None,
            window_identifier: None,
            frame: None,
            frontmost_bundle_id: Some("com.tinyspeck.slackmacgap".to_string()),
            frontmost_app_name: Some("Slack".to_string()),
        };
        let reader = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "quarterly report to the board".to_string(),
            fingerprint: indistinguishable.clone(),
        })));
        let mut request = request("send it to cuban netties");
        request.insertion_fingerprint = indistinguishable;

        assert_eq!(
            evaluate_post_insert_readback(&reader, &request),
            ReadbackOutcome::Aborted(ReadbackAbort::InsertionRemnantMissing)
        );
    }

    #[test]
    fn scattered_word_overlap_is_not_a_surviving_insertion() {
        // "to" and "it" turn up everywhere; they are not evidence that this is
        // the field Plainsong wrote to. Two adjacent surviving words are.
        assert!(!readback_holds_insertion_remnant(
            &words("send it to cuban netties"),
            &words("it is over to you now for the netties review"),
        ));
        assert!(readback_holds_insertion_remnant(
            &words("send it to cuban netties"),
            &words("Hey team send it to kubernetes thanks"),
        ));
    }

    // ── Repeated phrases: the same words twice in one field ─────────────────

    #[test]
    fn refuses_a_correction_when_an_older_copy_of_the_phrase_sits_above_it() {
        // Reproduction from review. Re-run against this code with the guard
        // removed, it queues `"tomorrow" -> "tomorow"`: the field already
        // quoted "call the vendor tomorow", Plainsong inserted "call the
        // vendor tomorrow" below it, and the user edited the real insertion.
        // The subsequence match is global, so it anchored on the *quoted* copy
        // and learned a typo out of text the user never wrote. Two independent
        // anchors now means no anchor.
        assert_eq!(
            derive_readback_candidates(
                "call the vendor tomorrow",
                "call the vendor tomorow call the vendor Tuesday",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn refuses_a_correction_when_an_older_copy_of_the_phrase_sits_below_it() {
        // The same ambiguity in the other order: Plainsong's insertion is
        // first and the stale copy is quoted underneath. Without the guard
        // this queued "vendor" -> "vendors", which happens to be the edit the
        // user really made — but only by luck of which copy the global match
        // reached first. Giving up a right answer that was a coin toss is the
        // price of never queueing the wrong one.
        assert_eq!(
            derive_readback_candidates(
                "call the vendor tomorrow",
                "call the vendors tomorrow call the vender tomorrow",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn refuses_a_repeat_the_span_swallowed_at_the_end_of_the_field() {
        // Reviewer's construction. The span extends past its last matched word
        // by the inserted words left unmatched, hits the end of the field, and
        // ends up covering all eight words — so both leftover regions are
        // empty and the region test had nothing to inspect. Run with the guard
        // removed this queues `delta -> delka`, a typo taken off the earlier
        // stray "alpha bravo" rather than off anything Plainsong wrote.
        assert_eq!(
            derive_readback_candidates(
                "alpha bravo charlie delta",
                "alpha bravo zulu yankee alpha bravo charlie delka",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn refuses_a_repeat_the_span_swallowed_at_the_start_of_the_field() {
        // The mirror: the leading extension is clamped at index 0, so the
        // prefix region is empty instead of the suffix one. Same blind spot,
        // other edge.
        assert_eq!(
            derive_readback_candidates(
                "alpha bravo charlie delta",
                "delka alpha bravo yankee zulu alpha bravo charlie",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn refuses_a_partial_repeat_the_confidence_bar_was_too_high_to_see() {
        // Neither swallowed nor whole: the second copy sits outside the span
        // but carries only two of the four inserted words, so it never cleared
        // the confidence bar the region test applies. It is still enough for
        // the alignment to have stitched across, and it too queued
        // `delta -> delka` before this guard.
        assert_eq!(
            derive_readback_candidates(
                "alpha bravo charlie delta",
                "alpha bravo charlie delka yankee zulu alpha bravo",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn a_long_single_occurrence_correction_against_a_field_edge_still_anchors() {
        // The guard must not fire just because a span reaches a boundary. Here
        // the insertion starts at the very first word of the field and its
        // correction is at the very last, so both extensions clamp — but the
        // field says these words once, so there is nothing ambiguous about it.
        assert_eq!(
            derive_readback_candidates(
                "please review the quarterly infrastructure budget kuberentes",
                "please review the quarterly infrastructure budget kubernetes",
                &no_dictionary(),
            ),
            Ok(vec![ReadbackCorrectionCandidate {
                spoken_form: "kuberentes".to_string(),
                replacement: "kubernetes".to_string(),
            }])
        );
    }

    #[test]
    fn a_phrase_the_field_uses_once_is_not_a_repeat() {
        assert!(!insertion_repeats_inside_readback(
            &words("call the vendor tomorrow"),
            &words("Hey team call the vendors tomorrow thanks"),
        ));
        // Two words adjacent and in order, twice over, in a field long enough
        // to hold both.
        assert!(insertion_repeats_inside_readback(
            &words("call the vendor tomorrow"),
            &words("call the vendor tomorow call the vendor Tuesday"),
        ));
    }

    #[test]
    fn overlapping_hits_on_the_same_words_are_one_occurrence() {
        // "alpha alpha alpha" contains the pair "alpha alpha" starting at both
        // index 0 and index 1, but that is one stretch of text seen twice at a
        // shifted offset, not two copies of it.
        assert!(!insertion_repeats_inside_readback(
            &words("alpha alpha charlie"),
            &words("alpha alpha alpha charlie"),
        ));
    }

    #[test]
    fn one_copy_of_the_phrase_still_anchors_normally() {
        // The guard above must not fire on ordinary surrounding text — the
        // greeting and the sign-off are not second copies of the insertion.
        assert_eq!(
            derive_readback_candidates(
                "call the vendor tomorrow",
                "Hey team call the vendors tomorrow thanks",
                &no_dictionary(),
            ),
            Ok(vec![ReadbackCorrectionCandidate {
                spoken_form: "vendor".to_string(),
                replacement: "vendors".to_string(),
            }])
        );
    }

    // ── Scripts written without spaces ──────────────────────────────────────

    #[test]
    fn bounds_a_correction_written_without_word_spaces() {
        // `split_whitespace` calls a whole Japanese clause one word, so the
        // word ceiling never bites and 48 characters is most of a sentence.
        assert!(candidate_is_acceptable(
            "東京事務所",
            "東京事務局",
            &no_dictionary()
        ));
        assert!(!candidate_is_acceptable(
            "東京事務所会議資料原稿案",
            "東京事務局会議資料原稿案",
            &no_dictionary(),
        ));
        assert!(!candidate_is_acceptable(
            "ประชุมสำนักงานโตเกียว",
            "ประชุมสำนักงานเกียวโต",
            &no_dictionary(),
        ));
    }

    #[test]
    fn an_over_long_unsegmented_span_never_reaches_the_queue() {
        assert_eq!(
            derive_readback_candidates(
                "the 東京事務所会議資料原稿案 report is ready for review",
                "the 東京事務局会議資料原稿案 report is ready for review",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::NoAcceptableCandidates)
        );
    }

    #[test]
    fn the_character_ceiling_only_tightens_for_scripts_that_need_it() {
        // A Latin word longer than the unsegmented ceiling keeps the ordinary
        // 48-character allowance; the tighter rule is not a global one.
        assert!(candidate_is_acceptable(
            "kuberentes",
            "kubernetes",
            &no_dictionary()
        ));
    }

    #[test]
    fn aborts_when_every_candidate_is_filtered_out() {
        // Autocapitalisation of a word the dictionary has never heard of.
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("ping jonathan Today"),
                &request("ping jonathan today")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::NoAcceptableCandidates)
        );
    }

    // ── Anchoring the insertion to a field ──────────────────────────────────

    #[test]
    fn anchors_an_insertion_to_the_field_that_actually_holds_it() {
        assert_eq!(
            capture_insertion_anchor(
                &reader_returning("Hey team send it to cuban netties thanks"),
                "send it to cuban netties",
                &never_self,
            ),
            Some(fingerprint())
        );
    }

    #[test]
    fn refuses_to_anchor_to_a_field_that_does_not_hold_the_insertion() {
        // The paste went somewhere else, or nowhere. Without evidence that
        // this is the right field, no readback may be scheduled against it.
        assert!(capture_insertion_anchor(
            &reader_returning("a completely unrelated draft"),
            "send it to cuban netties",
            &never_self,
        )
        .is_none());
    }

    #[test]
    fn refuses_to_anchor_when_nothing_is_readable() {
        assert!(capture_insertion_anchor(
            &FakeReader(Ok(None)),
            "send it to cuban netties",
            &never_self
        )
        .is_none());
        assert!(capture_insertion_anchor(
            &FakeReader(Err("Accessibility read failed.".to_string())),
            "send it to cuban netties",
            &never_self,
        )
        .is_none());
    }

    #[test]
    fn refuses_to_anchor_when_the_text_actually_landed_back_in_plainsong() {
        // The dictation was aimed at Slack and labelled Slack at session
        // start, but reactivation quietly failed and the paste went into
        // Plainsong's own result box. The stale label is not evidence; the app
        // observed in front at the moment of the read is.
        let landed_in_plainsong = FakeReader(Ok(Some(FocusedFieldSnapshot {
            text: "send it to cuban netties".to_string(),
            fingerprint: FocusedFieldFingerprint {
                frontmost_bundle_id: Some("com.plainsong.app".to_string()),
                frontmost_app_name: Some("Plainsong".to_string()),
                ..fingerprint()
            },
        })));

        assert!(capture_insertion_anchor(
            &landed_in_plainsong,
            "send it to cuban netties",
            &frontmost_is_plainsong,
        )
        .is_none());
        // The same field, with the same text, is anchored normally when the
        // app in front is not us — so the refusal is the self check and not
        // something incidental about the fixture.
        assert!(capture_insertion_anchor(
            &landed_in_plainsong,
            "send it to cuban netties",
            &never_self,
        )
        .is_some());
    }

    #[test]
    fn anchor_matching_survives_the_destination_apps_reflow() {
        assert!(anchor_snapshot_contains_insertion(
            "Hey team\n  send it   to cuban netties\nthanks",
            "send it to cuban netties",
        ));
    }

    #[test]
    fn anchor_matching_rejects_empty_text_on_either_side() {
        assert!(!anchor_snapshot_contains_insertion(
            "some field text",
            "   "
        ));
        assert!(!anchor_snapshot_contains_insertion(
            "",
            "send it to cuban netties"
        ));
    }

    // ── End to end ──────────────────────────────────────────────────────────

    #[test]
    fn derives_a_correction_the_user_made_inside_another_apps_field() {
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("Hey team please review the kubernetes manifest before friday"),
                &request("please review the kuberentes manifest before friday")
            ),
            ReadbackOutcome::Candidates(vec![ReadbackCorrectionCandidate {
                spoken_form: "kuberentes".to_string(),
                replacement: "kubernetes".to_string(),
            }])
        );
    }

    #[test]
    fn ignores_the_users_own_text_typed_around_the_insertion() {
        // "Hey team" above and "thanks" below are the user's, not Plainsong's.
        // Neither may become a candidate.
        let candidates = derive_readback_candidates(
            "please review the kuberentes manifest before friday",
            "Hey team please review the kubernetes manifest before friday thanks",
            &no_dictionary(),
        )
        .expect("candidates");
        assert_eq!(
            candidates,
            vec![ReadbackCorrectionCandidate {
                spoken_form: "kuberentes".to_string(),
                replacement: "kubernetes".to_string(),
            }]
        );
    }

    #[test]
    fn caps_how_many_candidates_one_readback_contributes() {
        let candidates = derive_readback_candidates(
            "meet the alfa brovo team about charly and delda tomorrow",
            "meet the alfa bravo team about charlie and delta tomorrow",
            &no_dictionary(),
        )
        .expect("candidates");
        assert_eq!(candidates.len(), MAX_CANDIDATES_PER_READBACK);
    }

    #[test]
    fn drops_a_diff_busy_enough_to_be_a_rewrite() {
        // Six separate word swaps inside one insertion: enough words survive
        // for the span to anchor, but this is an edit pass, not a correction.
        assert_eq!(
            derive_readback_candidates(
                "we will meet the alfa brovo and charly and delda and ecko and foxtrat and hotal team",
                "we will meet the alfa bravo and charlie and delta and echo and foxtrot and hotel team",
                &no_dictionary(),
            ),
            Err(ReadbackAbort::SpanNotLocated)
        );
    }

    #[test]
    fn never_reports_anything_a_caller_could_read_as_apply() {
        // The outcome type has exactly two shapes, and the one carrying data
        // carries suggestions. If someone adds an "apply" variant, this fails.
        let outcome = evaluate_post_insert_readback(
            &reader_returning("Hey team please review the kubernetes manifest before friday"),
            &request("please review the kuberentes manifest before friday"),
        );
        match outcome {
            ReadbackOutcome::Candidates(candidates) => {
                assert!(!candidates.is_empty());
            }
            ReadbackOutcome::Aborted(abort) => panic!("unexpected abort: {:?}", abort),
        }
    }

    #[test]
    fn deduplicates_the_same_correction_repeated_in_one_field() {
        let candidates = derive_readback_candidates(
            "ship kuberentes now and then kuberentes again",
            "ship kubernetes now and then kubernetes again",
            &no_dictionary(),
        )
        .expect("candidates");
        assert_eq!(
            candidates,
            vec![ReadbackCorrectionCandidate {
                spoken_form: "kuberentes".to_string(),
                replacement: "kubernetes".to_string(),
            }]
        );
    }

    #[test]
    fn refuses_a_correction_it_cannot_separate_from_text_typed_after_it() {
        // The wrong word was the last one Plainsong typed and the user kept
        // typing past it, so the trailing region is genuinely ambiguous.
        // Bailing is the required behavior — a guess here would teach the
        // dictionary the user's next word.
        assert_eq!(
            evaluate_post_insert_readback(
                &reader_returning("Hey team send it to kubernetes thanks"),
                &request("send it to cuban netties")
            ),
            ReadbackOutcome::Aborted(ReadbackAbort::NoAcceptableCandidates)
        );
    }

    #[test]
    fn refuses_a_short_insertion_with_too_few_surviving_anchors() {
        // Two words, one of them wrong: nothing distinguishes this from the
        // user having replaced the whole thing. Nothing of the insertion is
        // left in the field, so it fails the remnant prerequisite first.
        assert_eq!(
            derive_readback_candidates("cuban netties", "kubernetes", &no_dictionary()),
            Err(ReadbackAbort::InsertionRemnantMissing)
        );
    }

    #[test]
    fn fingerprint_equality_is_case_insensitive_on_app_identity() {
        let mut readback = fingerprint();
        readback.frontmost_bundle_id = Some("COM.TINYSPECK.SLACKMACGAP".to_string());
        assert!(readback.matches_insertion(&fingerprint()));
    }

    #[test]
    fn fingerprint_equality_rejects_an_identifier_that_appeared_or_vanished() {
        let mut readback = fingerprint();
        readback.identifier = None;
        assert!(!readback.matches_insertion(&fingerprint()));
    }
}
