//! Acoustic vocabulary: spelling names and terms from what was said.
//!
//! Parakeet writes an unfamiliar name the way it sounds ("Shivan" for
//! Siobhan, "Superbase" for Supabase). On the Neural Engine route the speech
//! helper scores a list of terms against the audio itself with a small CTC
//! model (as in NeMo's CTC word spotting, arXiv:2406.07096) and reports, for
//! each stretch of words spelled like a term, how well the term and the
//! words themselves fit the same audio. This module builds that list and
//! decides which of the helper's candidates to apply.
//!
//! The list, best first, capped at [`MAX_TERMS`]:
//! 1. the user's dictionary (replacement spellings, scoped like the dictionary
//!    pass; learned corrections land there once the user approves them), with
//!    a spoken form when the entry has one, and for these and the next two
//!    sources, English respellings of a name spelled by another language's
//!    rules ("shimon" for Szymon, "neev" for Niamh) as further spoken forms;
//! 2. opt-in calendar names, at most 150, then Contacts names, at most 250,
//!    both held in memory only;
//! 3. words read near the cursor, when nearby spelling is on;
//! 4. the built-in list in `gazetteer.txt`: developer tools and services, and
//!    names whose spelling does not follow English pronunciation.
//!
//! A candidate is applied only when all of these hold:
//! - the term is in this request's list;
//! - every heard word is unknown to the system word list, or a name it knows
//!   only capitalized ("Donna") with a clearly better acoustic score; never an
//!   ordinary word, a number, a negation or a contraction;
//! - the recognizer's spelling similarity and acoustic margin clear
//!   [`FLOORS`]; a built-in term needs a closer spelling, audio that prefers
//!   it, and never replaces a name the word list knows; a user's term the
//!   heard words sound like, by its own spelling rules (`respell.rs`:
//!   "Simon" for Szymon, "Ifa" for Aoife) or with the rest of a multi-word
//!   name heard exactly, needs less spelling similarity and, over a known
//!   name, only audio that does not prefer the heard name;
//! - no longer stretch of words matches the term better;
//! - the heard words are found exactly once in the text being delivered and
//!   do not overlap a dictionary correction.
//!
//! The recognizer's own text stays the change-review original, so every
//! applied spelling is visible there and can be restored.

use crate::asr::{AcousticVocabularyTerm, VocabularyCandidate};
#[doc(hidden)]
pub use crate::models::DictationDictionaryEntry;

/// At most this many terms per dictation. The helper accepts 512; fewer keeps
/// the per-request scoring well under a millisecond per term.
pub(crate) const MAX_TERMS: usize = 500;

/// Contacts names per dictation, of [`MAX_TERMS`].
const MAX_CONTACT_TERMS: usize = 250;
const MAX_CALENDAR_TERMS: usize = 150;

/// What the app sends at most; the Contacts helper stops at 2,000 as well.
pub(crate) const MAX_CONTACT_NAMES: usize = 2_000;

/// The evidence a candidate needs. Margins are how much better the term
/// fits the audio than the heard words, in per-frame CTC log-likelihood.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Floors {
    /// Spelling similarity the helper measured between the heard words and
    /// the term (or its spoken form), for the user's own terms.
    pub similarity: f32,
    pub margin: f32,
    /// A heard word the word list knows as a name ("Donna") may well be what
    /// the speaker said.
    pub margin_known_name: f32,
    /// Built-in terms: the speaker never asked for these, so they need a
    /// closer spelling and a clearer margin.
    pub built_in_similarity: f32,
    pub built_in_margin: f32,
    /// Whether a built-in term may replace a known name at all.
    pub built_in_known_name: bool,
    /// A user's term the heard words sound like (see [`sounds_like_term`])
    /// needs only this spelling similarity.
    pub sound_similarity: f32,
    /// And this margin over a heard word the word list knows as a name.
    pub sound_margin_known_name: f32,
}

impl Default for Floors {
    fn default() -> Self {
        FLOORS
    }
}

/// User terms require positive acoustic evidence over the original span.
/// Weak spelling proposals need a larger margin in `accept`. The frozen
/// development and control comparisons are recorded in the vocabulary report;
/// these scores are relative CTC log-likelihoods, not calibrated probabilities.
pub(crate) const FLOORS: Floors = Floors {
    similarity: 0.59,
    margin: 0.1,
    margin_known_name: 1.0,
    built_in_similarity: 0.7,
    built_in_margin: 0.2,
    built_in_known_name: false,
    sound_similarity: 0.35,
    sound_margin_known_name: 0.1,
};

const NEGATIONS: &[&str] = &[
    "no", "not", "never", "none", "nor", "neither", "nothing", "nobody", "nowhere", "cannot",
];

/// Terms in rank order, de-duplicated without regard to case.
#[derive(Default)]
struct RankedTerms {
    terms: Vec<AcousticVocabularyTerm>,
    index: std::collections::HashMap<String, usize>,
}

impl RankedTerms {
    /// Add a term, or merge its spoken forms into the same term added
    /// earlier (which keeps that term's source). `checked` skips
    /// [`eligible`] for lists filtered in advance.
    fn push(&mut self, text: &str, spoken: &[String], checked: bool, built_in: bool) {
        let text = text.trim();
        let key = text.to_lowercase();
        if let Some(&existing) = self.index.get(&key) {
            let existing = &mut self.terms[existing];
            for form in spoken {
                if existing.spoken.len() < 4 && !existing.spoken.contains(form) {
                    existing.spoken.push(form.clone());
                }
            }
            return;
        }
        // Sources arrive best first, so a full list only takes merges.
        if self.terms.len() >= MAX_TERMS || !(checked || eligible(text)) {
            return;
        }
        let mut forms: Vec<String> = spoken.iter().take(4).cloned().collect();
        // The user's own terms also get respellings by their spelling rules,
        // leaving the last slot for a built-in spoken form merged later.
        if !built_in {
            for form in respell::respellings(text) {
                if forms.len() >= 3 {
                    break;
                }
                if !forms.contains(&form) {
                    forms.push(form);
                }
            }
        }
        self.index.insert(key, self.terms.len());
        self.terms.push(AcousticVocabularyTerm {
            text: text.to_string(),
            spoken: forms,
            built_in,
        });
    }

    fn contains(&self, text: &str) -> bool {
        self.index.contains_key(&text.trim().to_lowercase())
    }
}

const GAZETTEER: &str = include_str!("gazetteer.txt");

/// The built-in list's version, from its header.
#[cfg(test)]
pub(crate) fn gazetteer_version() -> u32 {
    GAZETTEER
        .lines()
        .find_map(|line| {
            line.split("version ")
                .nth(1)?
                .split(|ch: char| !ch.is_ascii_digit())
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(0)
}

fn parse_gazetteer(text: &str) -> Vec<(String, Vec<String>)> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let mut parts = line.splitn(2, '|');
            let term = parts.next()?.trim().to_string();
            let spoken = parts
                .next()
                .map(|forms| {
                    forms
                        .split(',')
                        .map(|form| form.trim().to_string())
                        .filter(|form| !form.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            (!term.is_empty()).then_some((term, spoken))
        })
        .collect()
}

/// The built-in list, parsed once and already filtered by [`eligible`].
fn gazetteer() -> &'static [(String, Vec<String>)] {
    static PARSED: std::sync::OnceLock<Vec<(String, Vec<String>)>> = std::sync::OnceLock::new();
    PARSED.get_or_init(|| {
        parse_gazetteer(GAZETTEER)
            .into_iter()
            .filter(|(term, _)| eligible(term))
            .collect()
    })
}

/// Names read from Contacts while the user has that turned on. Memory only:
/// never written to disk, history or logs, and cleared when turned off.
static CONTACT_NAMES: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

fn clean_names(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| {
            !name.is_empty()
                && name.chars().count() <= 64
                && !name.contains(['@', '\n', '\r'])
                && seen.insert(name.to_lowercase())
        })
        .take(MAX_CONTACT_NAMES)
        .collect()
}

pub(crate) fn set_contact_names(names: Vec<String>) {
    if let Ok(mut stored) = CONTACT_NAMES.write() {
        *stored = clean_names(names);
    }
}

pub(crate) fn contact_name_count() -> usize {
    CONTACT_NAMES.read().map(|names| names.len()).unwrap_or(0)
}

#[derive(Default)]
struct CalendarNames {
    dictation: Vec<String>,
    meeting: Vec<String>,
}
static CALENDAR_NAMES: std::sync::RwLock<CalendarNames> = std::sync::RwLock::new(CalendarNames {
    dictation: Vec::new(),
    meeting: Vec::new(),
});

pub(crate) fn set_calendar_names(dictation: Vec<String>, meeting: Vec<String>) {
    if let Ok(mut stored) = CALENDAR_NAMES.write() {
        *stored = CalendarNames {
            dictation: clean_names(dictation),
            meeting: clean_names(meeting),
        };
    }
}

pub(crate) fn calendar_name_count() -> usize {
    CALENDAR_NAMES
        .read()
        .map(|names| names.dictation.len())
        .unwrap_or(0)
}

/// Meeting hints use the current/next event first. Never sent as provider prompts.
pub(crate) fn for_meeting() -> Vec<AcousticVocabularyTerm> {
    let calendar = CALENDAR_NAMES
        .read()
        .map(|names| names.meeting.clone())
        .unwrap_or_default();
    let contacts = CONTACT_NAMES
        .read()
        .map(|names| names.clone())
        .unwrap_or_default();
    build(&Inputs {
        dictionary: &[],
        app_target: None,
        category: crate::text::format::DictationAppCategory::Other,
        calendar_names: &calendar,
        contact_names: &contacts,
        screen_terms: &[],
        built_in: false,
    })
}

/// The list for a live dictation.
pub(crate) fn for_dictation(
    dictionary: &[DictationDictionaryEntry],
    app_target: Option<&str>,
    category: crate::text::format::DictationAppCategory,
    screen_terms: &[String],
) -> Vec<AcousticVocabularyTerm> {
    let contacts = CONTACT_NAMES
        .read()
        .map(|names| names.clone())
        .unwrap_or_default();
    let calendar = CALENDAR_NAMES
        .read()
        .map(|names| names.dictation.clone())
        .unwrap_or_default();
    build(&Inputs {
        dictionary,
        calendar_names: &calendar,
        app_target,
        category,
        contact_names: &contacts,
        screen_terms,
        built_in: true,
    })
}

/// `asr-eval-batch`: dictionary entries for (written, spoken) pairs.
#[doc(hidden)]
pub fn dictionary_for_eval(terms: &[(String, String)]) -> Vec<DictationDictionaryEntry> {
    let now = chrono::Utc::now();
    terms
        .iter()
        .map(|(text, spoken)| DictationDictionaryEntry {
            id: text.clone(),
            spoken_form: spoken.clone(),
            replacement: text.clone(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: now,
            updated_at: now,
        })
        .collect()
}

/// `asr-eval-batch`: the list a dictation with this dictionary would send,
/// with or without the built-in list. `exclude` drops built-in terms (not
/// dictionary ones), to measure the list on names it does not contain.
#[doc(hidden)]
pub fn list_with_names_for_eval(
    dictionary: &[DictationDictionaryEntry],
    built_in: bool,
    exclude: &[String],
    calendar_names: &[String],
    contact_names: &[String],
) -> Vec<AcousticVocabularyTerm> {
    let user = build(&Inputs {
        dictionary,
        app_target: None,
        category: crate::text::format::DictationAppCategory::Other,
        calendar_names,
        contact_names,
        screen_terms: &[],
        built_in: false,
    });
    let excluded: std::collections::HashSet<String> = exclude
        .iter()
        .map(|term| term.trim().to_lowercase())
        .collect();
    let mut ranked = RankedTerms::default();
    for term in &user {
        ranked.push(&term.text, &term.spoken, true, term.built_in);
    }
    if built_in {
        for (text, spoken) in gazetteer() {
            if !excluded.contains(&text.to_lowercase()) {
                ranked.push(text, spoken, true, true);
            }
        }
    }
    ranked.terms
}

/// `asr-eval-batch`: the dictation stage on a pipeline result, with the
/// shipped floors or others to compare.
#[doc(hidden)]
pub fn apply_for_eval(
    result: &mut crate::dictation_pipeline::DictationPipelineResult,
    raw: &str,
    candidates: &[VocabularyCandidate],
    requested: &[AcousticVocabularyTerm],
    floors: Option<&Floors>,
) {
    apply_with_floors(
        result,
        raw,
        candidates,
        requested,
        floors.unwrap_or(&FLOORS),
    );
}

/// What one dictation's list is built from.
pub(crate) struct Inputs<'a> {
    pub(crate) dictionary: &'a [DictationDictionaryEntry],
    pub(crate) app_target: Option<&'a str>,
    pub(crate) category: crate::text::format::DictationAppCategory,
    pub(crate) calendar_names: &'a [String],
    pub(crate) contact_names: &'a [String],
    pub(crate) screen_terms: &'a [String],
    pub(crate) built_in: bool,
}

/// A term worth scoring: something a recognizer could misspell, not a word
/// it already writes correctly.
fn eligible(text: &str) -> bool {
    let letters = text.chars().filter(|ch| ch.is_alphabetic()).count();
    let chars = text.chars().count();
    if !(3..=64).contains(&chars) || letters < 3 {
        return false;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() > 4 {
        return false;
    }
    // A phrase of ordinary words ("Hugging Face") still has a spelling to
    // get right; a single ordinary word is left to the recognizer.
    !(words.len() == 1 && crate::dictation_sounds_like::is_ordinary_word(text))
}

fn spoken_form_from_entry(entry: &DictationDictionaryEntry) -> Option<String> {
    let spoken = entry.spoken_form.trim();
    let usable = !spoken.is_empty()
        && !spoken.eq_ignore_ascii_case(entry.replacement.trim())
        && spoken.chars().count() <= 64
        && spoken
            .chars()
            .all(|ch| ch.is_alphabetic() || ch == ' ' || ch == '-' || ch == '\'');
    usable.then(|| spoken.to_lowercase())
}

/// The ranked, de-duplicated list for one dictation.
pub(crate) fn build(inputs: &Inputs<'_>) -> Vec<AcousticVocabularyTerm> {
    let mut ranked = RankedTerms::default();
    let mut dictionary: Vec<&DictationDictionaryEntry> = inputs
        .dictionary
        .iter()
        .filter(|entry| {
            entry.enabled
                && crate::dictation_parity::snippet_app_scope_matches(
                    entry.app_scope.as_deref(),
                    inputs.app_target,
                )
                && crate::dictation_parity::category_scope_matches(
                    entry.category_scope.as_deref(),
                    inputs.category,
                )
        })
        .collect();
    // Newest first, as the recognizer hint ranks them.
    dictionary.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    for entry in dictionary {
        let spoken: Vec<String> = spoken_form_from_entry(entry).into_iter().collect();
        ranked.push(&entry.replacement, &spoken, false, false);
    }
    let calendar_end = (ranked.terms.len() + MAX_CALENDAR_TERMS).min(MAX_TERMS);
    for name in inputs.calendar_names {
        if ranked.terms.len() >= calendar_end {
            break;
        }
        ranked.push(name, &[], false, false);
    }
    // A name the word list does not know ("Siobhan") is the one the
    // recognizer misspells; "Michael" it already writes. Those go first, and
    // the cap leaves room for the words on screen and the built-in list.
    let (unusual, familiar): (Vec<&String>, Vec<&String>) = inputs
        .contact_names
        .iter()
        .partition(|name| !crate::dictation_sounds_like::is_listed_word(name));
    let contacts_end = (ranked.terms.len() + MAX_CONTACT_TERMS).min(MAX_TERMS);
    for name in unusual.into_iter().chain(familiar) {
        if ranked.terms.len() >= contacts_end {
            break;
        }
        ranked.push(name, &[], false, false);
    }
    for term in inputs.screen_terms {
        ranked.push(term, &[], false, false);
    }
    // With the built-in list off it still lends its spoken forms to a term
    // the user added.
    for (text, spoken) in gazetteer() {
        if inputs.built_in || ranked.contains(text) {
            ranked.push(text, spoken, true, true);
        }
    }
    ranked.terms
}

/// Apply local meeting hints to both the transcript and timed segments. A hint
/// crossing segment boundaries stays unchanged, so text and timing agree.
pub(crate) fn apply_to_meeting_result(
    result: &mut crate::asr::TranscriptionResult,
    requested: &[AcousticVocabularyTerm],
) {
    if !result.language.eq_ignore_ascii_case("en") && !result.language.starts_with("en-") {
        return;
    }
    let mut accepted = preferred_spellings(&result.text, requested);
    accepted.extend(accept(
        &result.text,
        &result.vocabulary_candidates,
        requested,
        &FLOORS,
    ));
    if !result.segments.is_empty() {
        accepted.retain(|item| {
            result
                .segments
                .iter()
                .filter(|segment| occurrences(&segment.text, &item.heard).len() == 1)
                .count()
                == 1
        });
    }
    let (text, applied) = apply(&result.text, &accepted, &[]);
    accepted.retain(|item| applied.contains(&item.term));
    for segment in &mut result.segments {
        let text = apply(&segment.text, &accepted, &[]).0;
        if text.split_whitespace().count() != segment.text.split_whitespace().count() {
            result.measured_word_timestamps = false;
        }
        segment.text = text;
    }
    result.text = text;
}

/// A word as the recognizer wrote it, without surrounding punctuation.
fn bare(word: &str) -> &str {
    word.trim_matches(|ch: char| !(ch.is_alphanumeric() || ch == '\'' || ch == '\u{2019}'))
}

/// Whether a heard word may be replaced, and how much evidence that needs.
/// `name_position`: written capitalized where a sentence does not start, so
/// the recognizer itself took it for a name ("call Donna").
fn heard_word_allowed(word: &str, name_position: bool) -> Option<HeardKind> {
    use crate::dictation_sounds_like::{is_listed_word, is_name_word, is_ordinary_word};
    let acronym = word.chars().count() >= 2 && word.chars().all(|ch| ch.is_uppercase());
    if word.is_empty()
        || acronym
        || word.chars().any(|ch| ch.is_numeric())
        || word.contains(['\'', '\u{2019}'])
        || NEGATIONS.contains(&word.to_lowercase().as_str())
    {
        return None;
    }
    if is_ordinary_word(word) {
        let capitalized = word.chars().next().is_some_and(char::is_uppercase);
        return (name_position && capitalized && is_name_word(word))
            .then_some(HeardKind::KnownName);
    }
    Some(if is_listed_word(word) {
        HeardKind::KnownName
    } else {
        HeardKind::Unknown
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum HeardKind {
    Unknown,
    KnownName,
}

fn similarity(a: &str, b: &str) -> f64 {
    crate::dictation_sounds_like::jaro_winkler(&respell::fold(a), &respell::fold(b))
}

/// Keys shorter than this ("n" for "Ann") match too much to mean anything.
const MIN_SOUND_KEY: usize = 2;

/// Whether the heard words say a user's term the way an English speaker
/// would write it: the same consonant key and the same number of vowel
/// groups as the term or one of its forms. Only for a term spelled by another
/// language's rules ("Simon" for Szymon, "Ifa" for Aoife) or a multi-word
/// name whose other words were heard exactly ("Lu Yang" for Liu Yang); an
/// English spelling that merely shares consonants ("Lindy" for Lindiwe) is
/// left to the ordinary floors.
fn sounds_like_term(
    window: &[&str],
    term: &AcousticVocabularyTerm,
    respelled: &[String],
    partner_heard: bool,
) -> bool {
    if respelled.is_empty() && term.spoken.is_empty() && !partner_heard {
        return false;
    }
    let heard_text = window.join(" ");
    let heard = respell::sound_key(&heard_text);
    if heard.chars().count() < MIN_SOUND_KEY {
        return false;
    }
    let syllables = respell::vowel_groups(&heard_text);
    std::iter::once(&term.text)
        .chain(respelled)
        .chain(&term.spoken)
        .any(|form| {
            let key = respell::sound_key(form);
            let close = key == heard
                || (key.len() >= 3
                    && heard.len() >= 3
                    && crate::dictation_sounds_like::levenshtein(&key, &heard) == 1);
            close && respell::vowel_groups(form) == syllables
        })
}

/// Which words of the heard span stand for the term, as (offset, length):
/// all of them when the counts match, otherwise the closest run of the
/// term's length (the recognizer sometimes includes a neighbouring "and" or
/// "from"), unless the whole span run together is closer still ("Mel
/// Gorzata" for Malgorzata).
fn heard_window(heard: &[&str], term: &str, spoken: Option<&str>) -> (usize, usize) {
    let want = term.split_whitespace().count().max(1);
    if heard.len() <= want {
        return (0, heard.len());
    }
    let closeness = |words: &[&str]| {
        let joined = words.join(" ");
        let compact = words.concat();
        [joined.as_str(), compact.as_str()]
            .into_iter()
            .map(|text| {
                similarity(text, term).max(spoken.map_or(0.0, |form| similarity(text, form)))
            })
            .fold(0.0, f64::max)
    };
    let best = (0..=heard.len() - want)
        .max_by(|a, b| {
            closeness(&heard[*a..*a + want]).total_cmp(&closeness(&heard[*b..*b + want]))
        })
        .unwrap_or(0);
    if closeness(heard) > closeness(&heard[best..best + want]) {
        return (0, heard.len());
    }
    (best, want)
}

/// Whether word `index` of the recognizer's text starts a sentence. Unknown
/// positions count as sentence starts, which gives no name evidence.
fn starts_sentence(raw_words: &[&str], index: usize) -> bool {
    index == 0
        || raw_words
            .get(index - 1)
            .is_none_or(|previous| previous.ends_with(['.', '?', '!', ':', ';', '"', '\u{201D}']))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Accepted {
    pub(crate) heard: String,
    pub(crate) term: String,
}

/// The candidates that pass every guard. Word positions are only used to
/// resolve overlapping candidates; the heard phrase itself is what gets
/// replaced, so a later stage that rewrote those words leaves them alone.
pub(crate) fn accept(
    raw: &str,
    candidates: &[VocabularyCandidate],
    requested: &[AcousticVocabularyTerm],
    floors: &Floors,
) -> Vec<Accepted> {
    let raw_words: Vec<&str> = raw.split_whitespace().collect();
    let mut accepted: Vec<(Accepted, usize, usize, f32)> = Vec::new();
    for candidate in candidates {
        let Some(requested_term) = requested.iter().find(|term| term.text == candidate.term) else {
            continue;
        };
        let built_in = requested_term.built_in;
        // A looser user-term floor must not select a worse spelling over a
        // better acoustic match that failed the stricter built-in floor.
        if candidates.iter().any(|other| {
            other.term != candidate.term
                && other.word_start == candidate.word_start
                && other.word_end == candidate.word_end
                && other.heard == candidate.heard
                && other.similarity >= candidate.similarity
                && other
                    .term_score
                    .zip(candidate.term_score)
                    .is_some_and(|(better, score)| better > score)
                && requested.iter().any(|term| term.text == other.term)
        }) {
            continue;
        }
        // Below the lowest floor any term could get.
        if candidate.similarity < floors.similarity.min(floors.sound_similarity) {
            continue;
        }
        // Part of a longer stretch that matches the term better ("Gorzata"
        // inside "Mel Gorzata"): replacing only the part would leave the
        // rest of the name behind.
        if candidates.iter().any(|other| {
            other.term == candidate.term
                && other.word_start <= candidate.word_start
                && other.word_end >= candidate.word_end
                && other.word_end - other.word_start > candidate.word_end - candidate.word_start
                && other.similarity > candidate.similarity
        }) {
            continue;
        }
        let span: Vec<&str> = candidate
            .heard
            .split_whitespace()
            .map(bare)
            .filter(|word| !word.is_empty())
            .collect();
        let (offset, length) =
            heard_window(&span, &candidate.term, candidate.spoken_form.as_deref());
        // User terms must beat exactly the words being replaced. A score
        // over neighbouring words cannot justify changing just part of them.
        if !built_in && (offset != 0 || length != span.len()) {
            continue;
        }
        let window = &span[offset..offset + length];
        if window.is_empty() {
            continue;
        }
        let heard = window.join(" ");
        // Positions are trusted only when they still point at these words.
        let positioned = raw_words
            .get(candidate.word_start..candidate.word_end)
            .is_some_and(|words| words.iter().map(|word| bare(word)).eq(span.iter().copied()));
        // A heard word that is itself a listed term was most likely said.
        if requested.iter().any(|term| {
            term.text.eq_ignore_ascii_case(&heard)
                || window
                    .iter()
                    .any(|word| term.text.eq_ignore_ascii_case(word))
        }) {
            continue;
        }
        // In a multi-word name, a heard word that already is the term's word
        // ("Yang" in "Lu Yang" for Liu Yang) stays as it is, so it is not
        // checked as a word being replaced.
        let term_words: Vec<String> = respell::fold(&requested_term.text)
            .split(' ')
            .map(str::to_string)
            .collect();
        let kept: Vec<bool> = window
            .iter()
            .enumerate()
            .map(|(at, word)| {
                !built_in
                    && term_words.len() > 1
                    && window.len() == term_words.len()
                    && respell::fold(word) == term_words[at]
            })
            .collect();
        if kept.iter().all(|kept| *kept) {
            continue;
        }
        let kinds: Option<Vec<HeardKind>> = window
            .iter()
            .enumerate()
            .filter(|(at, _)| !kept[*at])
            .map(|(at, word)| {
                let index = candidate.word_start + offset + at;
                heard_word_allowed(word, positioned && !starts_sentence(&raw_words, index))
            })
            .collect();
        let Some(kinds) = kinds else { continue };
        let sounds = !built_in && {
            let respelled = respell::respellings(&requested_term.text);
            sounds_like_term(window, requested_term, &respelled, kept.contains(&true))
        };
        let min_similarity = match (built_in, sounds) {
            (true, _) => floors.built_in_similarity,
            (false, false) => floors.similarity,
            (false, true) => floors.similarity.min(floors.sound_similarity),
        };
        if candidate.similarity < min_similarity {
            continue;
        }
        let margin = match (candidate.term_score, candidate.heard_score) {
            (Some(term), Some(heard)) => term - heard,
            _ => continue,
        };
        let known_name = kinds.contains(&HeardKind::KnownName);
        if built_in && known_name && !floors.built_in_known_name {
            continue;
        }
        let floor = match (known_name, built_in) {
            (true, false) if sounds => floors.margin_known_name.min(floors.sound_margin_known_name),
            (true, false) => floors.margin_known_name,
            (true, true) => floors.margin_known_name.max(floors.built_in_margin),
            (false, false) => floors.margin,
            (false, true) => floors.built_in_margin,
        };
        let floor = if candidate.similarity < 0.5 {
            floor.max(0.5)
        } else {
            floor
        };
        if !margin.is_finite() || margin < floor {
            continue;
        }
        let start = candidate.word_start + offset;
        let end = start + window.len();
        // Two candidates for overlapping words: the better margin wins.
        if let Some(index) = accepted
            .iter()
            .position(|(_, s, e, _)| start < *e && *s < end)
        {
            if accepted[index].3 >= margin {
                continue;
            }
            accepted.remove(index);
        }
        accepted.push((
            Accepted {
                heard,
                term: candidate.term.clone(),
            },
            start,
            end,
            margin,
        ));
    }
    accepted.sort_by_key(|(_, start, _, _)| *start);
    accepted
        .into_iter()
        .map(|(accepted, _, _, _)| accepted)
        .collect()
}

/// Byte ranges of whole-word, case-insensitive occurrences of `phrase` (its
/// words separated by any whitespace) in `text`.
fn occurrences(text: &str, phrase: &str) -> Vec<(usize, usize)> {
    let pattern = phrase
        .split_whitespace()
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(r"\s+");
    if pattern.is_empty() {
        return Vec::new();
    }
    let Ok(regex) = regex::Regex::new(&format!(
        r"(?i)(?:^|[^\w'\x{{2019}}-])({pattern})(?:$|[^\w'\x{{2019}}-])"
    )) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(captures) = regex.captures_at(text, from) {
        let Some(matched) = captures.get(1) else {
            break;
        };
        found.push((matched.start(), matched.end()));
        from = matched.end();
    }
    found
}

/// Apply accepted spellings to `text`, the words about to be delivered. A
/// heard phrase found anywhere but exactly once (rewritten by an earlier
/// stage, or repeated) is left alone, as is one overlapping a protected
/// dictionary output. Returns the text and the terms applied.
pub(crate) fn apply(
    text: &str,
    accepted: &[Accepted],
    protected: &[String],
) -> (String, Vec<String>) {
    let protected_ranges: Vec<(usize, usize)> = protected
        .iter()
        .flat_map(|term| occurrences(text, term))
        .collect();
    let mut edits: Vec<(usize, usize, &str)> = Vec::new();
    for item in accepted {
        let found = occurrences(text, &item.heard);
        let [(start, end)] = found.as_slice() else {
            continue;
        };
        let overlaps = |(s, e): &(usize, usize)| *start < *e && *s < *end;
        if protected_ranges.iter().any(overlaps)
            || edits.iter().any(|(s, e, _)| overlaps(&(*s, *e)))
        {
            continue;
        }
        edits.push((*start, *end, item.term.as_str()));
    }
    edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    let mut output = text.to_string();
    let mut applied = Vec::new();
    for (start, end, term) in edits {
        output.replace_range(start..end, term);
        if !applied.iter().any(|existing: &String| existing == term) {
            applied.push(term.to_string());
        }
    }
    applied.reverse();
    (output, applied)
}

/// Restore a user's exact preferred spelling, including spaces only at camel-case
/// boundaries. This needs no acoustic guess: every letter and punctuation mark
/// must already be present. Ordinary words and built-in terms stay unchanged.
fn preferred_spellings(raw: &str, requested: &[AcousticVocabularyTerm]) -> Vec<Accepted> {
    if requested.iter().all(|term| term.built_in) {
        return Vec::new();
    }
    let words: Vec<&str> = raw.split_whitespace().map(bare).collect();
    let mut accepted = Vec::new();
    for term in requested.iter().filter(|term| !term.built_in) {
        let mut compact = String::new();
        let mut allowed_breaks = Vec::new();
        let mut required_breaks = Vec::new();
        let mut previous = None;
        for ch in term.text.chars() {
            if ch.is_whitespace() {
                required_breaks.push(compact.len());
                allowed_breaks.push(compact.len());
                previous = None;
                continue;
            }
            if ch.is_uppercase() && previous.is_some_and(char::is_lowercase) {
                allowed_breaks.push(compact.len());
            }
            compact.push(ch);
            previous = Some(ch);
        }
        for start in 0..words.len() {
            let mut joined = String::new();
            let mut breaks = Vec::new();
            for end in start..words.len().min(start + 4) {
                if end > start {
                    breaks.push(joined.len());
                    if !allowed_breaks.contains(&joined.len()) {
                        break;
                    }
                }
                joined.push_str(words[end]);
                if !compact
                    .get(..joined.len())
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&joined))
                {
                    break;
                }
                if joined.len() != compact.len()
                    || !required_breaks.iter().all(|at| breaks.contains(at))
                {
                    continue;
                }
                let window = &words[start..=end];
                if end > start
                    && (window
                        .iter()
                        .all(|word| crate::dictation_sounds_like::is_ordinary_word(word))
                        || window.iter().any(|word| {
                            word.chars().count() < 2
                                || word.chars().any(|ch| ch.is_numeric())
                                || word.contains(['\'', '\u{2019}'])
                                || NEGATIONS.contains(&word.to_lowercase().as_str())
                        }))
                {
                    continue;
                }
                let heard = window.join(" ");
                if requested
                    .iter()
                    .any(|other| other.text != term.text && other.text.eq_ignore_ascii_case(&heard))
                {
                    continue;
                }
                let found = occurrences(raw, &heard);
                if heard != term.text
                    && found.len() == 1
                    && !raw[found[0].0..found[0].1].contains(['\n', '\r'])
                {
                    accepted.push(Accepted {
                        heard,
                        term: term.text.clone(),
                    });
                }
                break;
            }
        }
    }
    accepted
}

/// The dictation stage: apply the recognizer's accepted candidates to the
/// local pipeline's result, as dictionary-guarded spellings.
pub(crate) fn apply_to_pipeline_result(
    result: &mut crate::dictation_pipeline::DictationPipelineResult,
    raw: &str,
    candidates: &[VocabularyCandidate],
    requested: &[AcousticVocabularyTerm],
) {
    apply_with_floors(result, raw, candidates, requested, &FLOORS);
}

fn apply_with_floors(
    result: &mut crate::dictation_pipeline::DictationPipelineResult,
    raw: &str,
    candidates: &[VocabularyCandidate],
    requested: &[AcousticVocabularyTerm],
    floors: &Floors,
) {
    if !result.english_rules {
        return;
    }
    let mut accepted = preferred_spellings(raw, requested);
    accepted.extend(accept(raw, candidates, requested, floors));
    if accepted.is_empty() {
        return;
    }
    let (text, applied) = apply(
        &result.text,
        &accepted,
        &result.applied_dictionary_replacements,
    );
    if applied.is_empty() {
        return;
    }
    result.text = text;
    result.dictionary_applied_count += applied.len();
    for term in applied {
        if !result.applied_dictionary_replacements.contains(&term) {
            result.applied_dictionary_replacements.push(term);
        }
    }
    result
        .pipeline_stage_keys
        .push("vocabulary_spelling".to_string());
}

pub(crate) mod respell;

#[cfg(test)]
mod tests;
