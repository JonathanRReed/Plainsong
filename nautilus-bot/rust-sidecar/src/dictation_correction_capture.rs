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
/// diffing a document. Also bounds the alignment DP below.
pub const MAX_READBACK_CHARS: usize = 4000;

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

/// The identity of a focused text field, captured without holding on to any
/// Accessibility pointer.
///
/// The readback runs seconds after the insertion, on a different thread, so a
/// retained `AXUIElementRef` would be both unsound to move and stale by the
/// time it is read. Instead both sides record the same cheap, comparable
/// facts, and the readback refuses to proceed unless they agree.
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
    pub fn matches_insertion(&self, insertion: &FocusedFieldFingerprint) -> bool {
        self.pid == insertion.pid
            && optional_eq_ignore_case(self.role.as_deref(), insertion.role.as_deref())
            && optional_eq_ignore_case(self.identifier.as_deref(), insertion.identifier.as_deref())
            && optional_eq_ignore_case(self.title.as_deref(), insertion.title.as_deref())
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
/// exposes no text, or the text Plainsong just inserted is not in it.
pub fn capture_insertion_anchor(
    reader: &dyn FocusedFieldReader,
    inserted_text: &str,
) -> Option<FocusedFieldFingerprint> {
    let snapshot = match reader.read_focused_field() {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return None,
        Err(error) => {
            tracing::debug!("Post-insert anchor read failed: {}", error);
            return None;
        }
    };

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
    /// The field still holds exactly what was inserted.
    NoChange,
    /// The inserted text could not be found in the field with confidence.
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

/// Runs one post-insert readback end to end: guard, read, verify identity,
/// locate, diff, filter.
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
/// (`MIN_SPAN_ANCHOR_CONFIDENCE`), which is the "user rewrote it, bail" case.
pub fn locate_inserted_span(
    inserted_words: &[String],
    readback_words: &[String],
) -> Option<InsertedSpan> {
    if inserted_words.is_empty() || readback_words.is_empty() {
        return None;
    }

    let matches = longest_common_subsequence_pairs(inserted_words, readback_words);
    let confidence = matches.len() as f64 / inserted_words.len() as f64;
    if confidence < MIN_SPAN_ANCHOR_CONFIDENCE {
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

    Some(InsertedSpan { start, end })
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
            ReadbackOutcome::Aborted(ReadbackAbort::SpanNotLocated)
        );
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
        )
        .is_none());
    }

    #[test]
    fn refuses_to_anchor_when_nothing_is_readable() {
        assert!(
            capture_insertion_anchor(&FakeReader(Ok(None)), "send it to cuban netties").is_none()
        );
        assert!(capture_insertion_anchor(
            &FakeReader(Err("Accessibility read failed.".to_string())),
            "send it to cuban netties",
        )
        .is_none());
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
        // user having replaced the whole thing.
        assert_eq!(
            derive_readback_candidates("cuban netties", "kubernetes", &no_dictionary()),
            Err(ReadbackAbort::SpanNotLocated)
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
