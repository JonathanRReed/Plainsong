//! Per-statement checks for generated meeting summaries.
//!
//! Citation validation proves that cited IDs exist and that the whole draft
//! shares words with them. It cannot tell which sentence of a long recap says
//! something the meeting never mentioned. This module checks each statement
//! on its own, in two ways.
//!
//! Names: a proper name or acronym that occurs nowhere in the meeting
//! (transcript lines, written notes, speaker names, and supplied meeting context)
//! almost always means the model invented a person, product or organization.
//!
//! Support: most of a statement's content words must occur in its best one to
//! three source lines. Faithful summaries paraphrase, so this is a lexical
//! screen, not entailment: it catches a sentence about a subject the meeting
//! never discussed, and leaves numbers, negation and qualifiers to the
//! specific claim checks.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::LazyLock;

/// Why a summary statement needs review. Saved provenance written before the
/// support check existed has no kind and only ever recorded invented names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnverifiedStatementKind {
    #[default]
    InventedName,
    /// A number, amount, percentage, weekday or month the meeting never says.
    UnknownFact,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnverifiedStatement {
    pub statement: String,
    #[serde(default)]
    pub kind: UnverifiedStatementKind,
    /// Proper names or acronyms that never occur in the meeting. Empty for
    /// statements whose content words no source line supports.
    #[serde(default)]
    pub unknown_names: Vec<String>,
    /// Numbers and calendar words, as the statement writes them, that never
    /// occur in the meeting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown_facts: Vec<String>,
}

pub(super) struct MeetingVocabulary {
    stems: HashSet<String>,
    prefixes: HashSet<String>,
}

const PREFIX_LEN: usize = 6;

impl MeetingVocabulary {
    pub(super) fn from_texts<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut stems = HashSet::new();
        let mut prefixes = HashSet::new();
        for text in texts {
            for word in words(text) {
                let stem = stem(&word.to_lowercase());
                if let Some(prefix) = prefix(&stem) {
                    prefixes.insert(prefix);
                }
                stems.insert(stem);
            }
        }
        Self { stems, prefixes }
    }

    fn knows(&self, word: &str) -> bool {
        let stem = stem(&word.to_lowercase());
        self.knows_content(&ContentWord {
            prefix: prefix(&stem),
            stem,
        })
    }

    fn knows_content(&self, word: &ContentWord) -> bool {
        self.stems.contains(&word.stem)
            || word
                .prefix
                .as_ref()
                .is_some_and(|prefix| self.prefixes.contains(prefix))
    }
}

fn prefix(stem: &str) -> Option<String> {
    (stem.chars().count() >= PREFIX_LEN).then(|| stem.chars().take(PREFIX_LEN).collect())
}

/// Words of three or more letters. Tokens with digits are left to the numeric
/// and financial checks, which understand units and ranges.
fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|ch: char| !(ch.is_alphanumeric() || ch == '\'' || ch == '’'))
        .map(|word| word.trim_matches(|ch| ch == '\'' || ch == '’'))
        .filter(|word| word.chars().count() >= 3)
        .filter(|word| !word.chars().any(|ch| ch.is_ascii_digit()))
}

pub(super) fn stem(word: &str) -> String {
    let word = word
        .strip_suffix("'s")
        .or_else(|| word.strip_suffix("’s"))
        .unwrap_or(word);
    let word = irregular_base(word).unwrap_or(word);
    let mut stem = word.to_string();
    for (suffix, replacement) in [
        ("ments", ""),
        ("ment", ""),
        ("ings", ""),
        ("ing", ""),
        ("ions", ""),
        ("ion", ""),
        ("ness", ""),
        ("ences", ""),
        ("ence", ""),
        ("ances", ""),
        ("ance", ""),
        ("ies", "y"),
        ("ied", "y"),
        ("ers", ""),
        ("er", ""),
        ("ed", ""),
        ("es", ""),
        ("ly", ""),
        ("als", ""),
        ("al", ""),
        ("s", ""),
    ] {
        // "refer", "order" and "finance" are whole words, not "ref" + "er".
        let shortest_base = if matches!(suffix, "ers" | "er" | "ences" | "ence" | "ances" | "ance")
        {
            4
        } else {
            3
        };
        if let Some(base) = word.strip_suffix(suffix) {
            if base.chars().count() >= shortest_base {
                stem = format!("{base}{replacement}");
                break;
            }
        }
    }
    if stem.chars().count() > 3 && stem.ends_with('e') {
        stem.pop();
    }
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() > 3 {
        let (last, previous) = (chars[chars.len() - 1], chars[chars.len() - 2]);
        if last == previous && !"aeiou".contains(last) {
            stem.pop();
        }
    }
    stem
}

/// Recaps report in the past tense, so "they drew" must match "we'll draw".
fn irregular_base(word: &str) -> Option<&'static str> {
    const FORMS: &[(&str, &str)] = &[
        ("drew", "draw"),
        ("drawn", "draw"),
        ("chose", "choose"),
        ("chosen", "choose"),
        ("took", "take"),
        ("taken", "take"),
        ("gave", "give"),
        ("given", "give"),
        ("went", "go"),
        ("wrote", "write"),
        ("written", "write"),
        ("spoke", "speak"),
        ("spoken", "speak"),
        ("thought", "think"),
        ("bought", "buy"),
        ("sold", "sell"),
        ("brought", "bring"),
        ("began", "begin"),
        ("begun", "begin"),
        ("ran", "run"),
        ("met", "meet"),
        ("built", "build"),
        ("sent", "send"),
        ("spent", "spend"),
        ("found", "find"),
        ("held", "hold"),
        ("told", "tell"),
        ("came", "come"),
        ("became", "become"),
        ("knew", "know"),
        ("known", "know"),
        ("saw", "see"),
        ("seen", "see"),
        ("kept", "keep"),
        ("paid", "pay"),
        ("said", "say"),
        ("made", "make"),
        ("got", "get"),
        ("gotten", "get"),
    ];
    FORMS
        .iter()
        .find(|(form, _)| *form == word)
        .map(|(_, base)| *base)
}

/// Qualifiers and reporting words that frame a claim without adding content.
/// Uncertainty itself is checked separately by the claim checks.
const FRAMING: &[&str] = &[
    "approximate",
    "approximately",
    "roughly",
    "exact",
    "exactly",
    "estimate",
    "estimated",
    "tentative",
    "tentatively",
    "though",
    "unconfirmed",
    "clear",
    "clearly",
    "explicit",
    "explicitly",
    "brief",
    "briefly",
    "session",
    "contain",
    "contains",
    "involve",
    "involves",
    "involved",
    // Durations are checked as numbers; "a time limit of 25 minutes" claims
    // nothing beyond the minutes themselves.
    "time",
    "limit",
    "duration",
    "timeframe",
    "item",
    "items",
    "pending",
    "assigned",
    "owner",
    "owners",
    "deadline",
    "deadlines",
    "recorded",
    "identified",
    "specified",
    "themselves",
    "ourselves",
    "himself",
    "herself",
    "myself",
    "yourself",
    "everyone",
    "everybody",
    "group",
    "members",
    "member",
    "person",
    "people",
    "something",
    "anything",
    "nothing",
    "there's",
    "it's",
    "that's",
    "they're",
    "we're",
    "isn't",
    "aren't",
    "wasn't",
    "weren't",
    "don't",
    "doesn't",
    "didn't",
    "won't",
    "can't",
    "cannot",
    "someone",
    "somebody",
    "anyone",
    "anybody",
    "per",
    "etc",
    "formal",
    "formally",
    "future",
    "everything",
    "else",
    "line",
    "lines",
];

/// Words a recap may use without the meeting saying them: summary framing,
/// function words and common verbs of reporting.
fn generic_words() -> &'static [&'static str] {
    const GENERIC: &[&str] = &[
        "about",
        "according",
        "action",
        "actions",
        "additional",
        "address",
        "after",
        "agenda",
        "agree",
        "agreed",
        "agreement",
        "all",
        "already",
        "also",
        "although",
        "and",
        "another",
        "answer",
        "any",
        "approach",
        "are",
        "around",
        "ask",
        "asked",
        "attendee",
        "attendees",
        "based",
        "because",
        "been",
        "before",
        "being",
        "between",
        "both",
        "but",
        "can",
        "clarify",
        "concern",
        "concerns",
        "confirm",
        "confirmed",
        "consider",
        "considered",
        "could",
        "current",
        "currently",
        "decide",
        "decided",
        "decision",
        "decisions",
        "describe",
        "described",
        "detail",
        "details",
        "did",
        "different",
        "discuss",
        "discussed",
        "discussion",
        "does",
        "done",
        "during",
        "each",
        "either",
        "emphasize",
        "emphasized",
        "explain",
        "explained",
        "express",
        "expressed",
        "few",
        "first",
        "focus",
        "follow",
        "following",
        "for",
        "from",
        "further",
        "general",
        "goal",
        "goals",
        "had",
        "has",
        "have",
        "her",
        "here",
        "highlight",
        "highlighted",
        "him",
        "his",
        "how",
        "however",
        "idea",
        "ideas",
        "include",
        "included",
        "including",
        "instead",
        "into",
        "issue",
        "issues",
        "its",
        "itself",
        "key",
        "later",
        "likely",
        "made",
        "main",
        "make",
        "many",
        "may",
        "meeting",
        "mention",
        "mentioned",
        "might",
        "more",
        "most",
        "must",
        "need",
        "needed",
        "needs",
        "new",
        "next",
        "not",
        "note",
        "noted",
        "notes",
        "now",
        "one",
        "only",
        "open",
        "option",
        "options",
        "other",
        "others",
        "our",
        "outcome",
        "outcomes",
        "over",
        "overall",
        "overview",
        "own",
        "participant",
        "participants",
        "plan",
        "planned",
        "plans",
        "point",
        "points",
        "possible",
        "possibly",
        "potential",
        "potentially",
        "priority",
        "progress",
        "propose",
        "proposed",
        "proposal",
        "question",
        "questions",
        "raise",
        "raised",
        "rather",
        "regarding",
        "remain",
        "remains",
        "request",
        "requested",
        "requirement",
        "requirements",
        "review",
        "reviewed",
        "said",
        "same",
        "second",
        "several",
        "shall",
        "share",
        "shared",
        "she",
        "should",
        "some",
        "speaker",
        "speakers",
        "specific",
        "state",
        "stated",
        "status",
        "step",
        "steps",
        "still",
        "such",
        "suggest",
        "suggested",
        "suggestion",
        "summary",
        "team",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "third",
        "this",
        "those",
        "three",
        "through",
        "timeline",
        "too",
        "topic",
        "topics",
        "two",
        "under",
        "unclear",
        "until",
        "update",
        "upon",
        "use",
        "used",
        "very",
        "want",
        "wanted",
        "was",
        "way",
        "well",
        "were",
        "what",
        "when",
        "where",
        "whether",
        "which",
        "while",
        "who",
        "whom",
        "whose",
        "why",
        "will",
        "with",
        "within",
        "without",
        "would",
        "yet",
        "you",
        "your",
        "build",
        "call",
        "check",
        "come",
        "complete",
        "create",
        "email",
        "find",
        "finish",
        "fix",
        "get",
        "give",
        "going",
        "handle",
        "help",
        "keep",
        "know",
        "look",
        "meet",
        "move",
        "prepare",
        "put",
        "read",
        "run",
        "see",
        "send",
        "set",
        "start",
        "take",
        "think",
        "try",
        "work",
        "write",
    ];
    GENERIC
}

fn is_generic(word: &str) -> bool {
    generic_words().contains(&word.to_lowercase().as_str())
}

fn is_common_acronym(word: &str) -> bool {
    const COMMON: &[&str] = &[
        "AM", "PM", "OK", "US", "UK", "EU", "AI", "ETA", "FYI", "ASAP", "TBD", "EUR", "USD", "GBP",
        "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "MVP", "KPI", "KPIS", "ROI", "CEO", "CTO", "CFO",
        "COO", "OKR", "OKRS", "QA", "UX", "UI", "API", "APIS", "SDK", "PR", "PRS", "HR", "SLA",
        "B2B", "SAAS", "CRM", "FAQ", "Q1", "Q2", "Q3", "Q4", "EOD", "EOW", "ARR", "MRR",
    ];
    COMMON.contains(&word.to_uppercase().as_str())
}

fn is_calendar_word(word: &str) -> bool {
    const CALENDAR: &[&str] = &[
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "january",
        "february",
        "march",
        "april",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "today",
        "tomorrow",
        "yesterday",
    ];
    CALENDAR.contains(&word.to_lowercase().as_str())
}

/// A capitalized word that is not the first word of its sentence, or an
/// acronym. Headings and leading bold labels are formatting, not claims.
fn is_name_like(word: &str, sentence_initial: bool) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let acronym = word.chars().count() >= 2
        && word
            .chars()
            .all(|ch| ch.is_uppercase() || ch == '\'' || ch == '’');
    acronym || (first.is_uppercase() && !sentence_initial)
}

fn starts_upper(word: &str) -> bool {
    word.chars().next().is_some_and(char::is_uppercase)
}

/// Verbs that make a sentence-initial word read as the person doing something,
/// as in "Marcus will review it" or "Dana said the build is ready".
fn is_person_verb(word: &str) -> bool {
    const VERBS: &[&str] = &[
        "will",
        "said",
        "says",
        "asked",
        "agreed",
        "suggested",
        "proposed",
        "mentioned",
        "noted",
        "confirmed",
        "offered",
        "explained",
        "raised",
        "shared",
        "owns",
        "leads",
        "presented",
        "volunteered",
        "committed",
        "promised",
        "reported",
        "stated",
        "recommended",
        "requested",
        "thinks",
        "believes",
        "wants",
        "plans",
        "joined",
    ];
    VERBS.contains(&word.to_lowercase().as_str())
}

/// Subjects that act in a recap without being anyone's name.
fn is_group_subject(word: &str) -> bool {
    const GROUPS: &[&str] = &[
        "everyone",
        "everybody",
        "someone",
        "somebody",
        "nobody",
        "anyone",
        "engineering",
        "design",
        "marketing",
        "sales",
        "product",
        "leadership",
        "management",
        "legal",
        "finance",
        "support",
        "operations",
        "research",
        "security",
        "attendees",
        "stakeholders",
        "customers",
        "clients",
        "users",
        "developers",
        "designers",
        "managers",
        "both",
    ];
    GROUPS.contains(&word.to_lowercase().as_str())
}

fn is_heading(line: &str) -> bool {
    let trimmed = line.trim();
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    // "Key Takeaways", "Next Steps": a short title-case line with no ending.
    let title_case = !words.is_empty()
        && words.len() <= 5
        && !trimmed.ends_with(['.', '!', '?'])
        && words
            .iter()
            .all(|word| word.chars().next().is_some_and(|ch| !ch.is_lowercase()));
    title_case
        || trimmed.starts_with('#')
        || (trimmed.ends_with(':') && trimmed.split_whitespace().count() <= 6)
        || (trimmed.starts_with("**") && trimmed.ends_with("**"))
}

/// Strip list markers and a leading bold label such as "- **Budget:**".
fn statement_body(line: &str) -> &str {
    let mut body = line.trim_start();
    // Strip list markers, but not the "**" that opens a bold label.
    while let Some(rest) = body
        .strip_prefix(['-', '+', '>', '•'])
        .or_else(|| body.strip_prefix('*').filter(|rest| !rest.starts_with('*')))
    {
        body = rest.trim_start();
    }
    let digits = body.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && body[digits..].starts_with(['.', ')'])
        && body[digits + 1..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
    {
        body = body[digits + 1..].trim_start();
    }
    if let Some(rest) = body.strip_prefix("**") {
        if let Some(end) = rest.find("**") {
            let label = &rest[..end];
            if label.split_whitespace().count() <= 6 {
                body = rest[end + 2..].trim_start_matches([':', ' ']);
            }
        }
    }
    body
}

fn sentences(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes: Vec<(usize, char)> = body.char_indices().collect();
    for (position, &(index, ch)) in bytes.iter().enumerate() {
        let prefix = body[start..index].trim();
        let title = ch == '.'
            && matches!(
                prefix.split_whitespace().next_back(),
                Some("Dr" | "Mr" | "Mrs" | "Ms" | "Prof")
            );
        if matches!(ch, '.' | '!' | '?')
            && !title
            && bytes
                .get(position + 1)
                .is_none_or(|(_, next)| next.is_whitespace())
        {
            let end = index + ch.len_utf8();
            let sentence = body[start..end].trim();
            if !sentence.is_empty() {
                out.push(sentence);
            }
            start = end;
        }
    }
    let rest = body[start..].trim();
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

/// Every claim-bearing sentence of a summary. Headings, list markers and
/// leading bold labels are formatting, not claims.
pub(super) fn statements(summary: &str) -> impl Iterator<Item = &str> {
    summary
        .lines()
        .filter(|line| !line.trim().is_empty() && !is_heading(line))
        .flat_map(|line| sentences(statement_body(line)))
}

/// Independent clauses carry separate claims, so "The sensor is compact and
/// its casing is waterproof" cannot let the second clause borrow the first
/// clause's support. Split at semicolons and at "and"/"but" before a new
/// pronoun subject; a list such as "original, trendy, and not bulky" stays whole.
fn clauses(sentence: &str) -> Vec<&str> {
    static NEW_SUBJECT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i),?\s+(?:and|but)\s+(?:it|its|it's|they|their|he|his|she|her|we|our)\b",
        )
        .unwrap()
    });
    sentence
        .split(';')
        .flat_map(|part| {
            let mut pieces = Vec::new();
            let mut start = 0;
            for found in NEW_SUBJECT.find_iter(part) {
                pieces.push(&part[start..found.start()]);
                start = found.start();
            }
            pieces.push(&part[start..]);
            pieces
        })
        .filter(|clause| !clause.trim().is_empty())
        .collect()
}

fn unknown_names(sentence: &str, vocabulary: &MeetingVocabulary) -> Vec<String> {
    let mut unknown_names = Vec::new();
    let mut sentence_initial = true;
    let mut seen = HashSet::new();
    let mut cursor = 0;
    let tokens: Vec<&str> = words(sentence).collect();
    for (index, word) in tokens.iter().copied().enumerate() {
        let offset = sentence[cursor..]
            .find(word)
            .map_or(cursor, |at| cursor + at);
        let between = &sentence[cursor..offset];
        if between.contains([':', ';', '(', '"', '“']) {
            sentence_initial = true;
        }
        cursor = offset + word.len();
        let initial = sentence_initial;
        sentence_initial = false;
        let key = word.to_lowercase();
        if !seen.insert(key)
            || vocabulary.knows(word)
            || is_calendar_word(word)
            || is_common_acronym(word)
            || is_generic(word)
        {
            continue;
        }
        let acts = tokens
            .get(index + 1)
            .is_some_and(|next| is_person_verb(next))
            && !is_group_subject(word);
        if is_name_like(word, initial) || (initial && acts && starts_upper(word)) {
            unknown_names.push(word.to_string());
        }
    }
    unknown_names
}

pub(super) fn source_names(text: &str) -> Vec<String> {
    static EMPTY: LazyLock<MeetingVocabulary> =
        LazyLock::new(|| MeetingVocabulary::from_texts(std::iter::empty()));
    unknown_names(text, &EMPTY)
}

/// A statement may combine a few source lines, as when a recap joins a
/// fragmented requirement, but not borrow words from across the meeting.
/// A comma-separated list may take each item from its own line.
const MAX_SUPPORT_LINES: usize = 3;

/// One normalized content word of a statement.
struct ContentWord {
    stem: String,
    prefix: Option<String>,
}

/// Everything the meeting supplied, indexed for per-statement checks.
pub(super) struct StatementSupport {
    /// All meeting text, for the name check.
    vocabulary: MeetingVocabulary,
    /// Every number and calendar word the meeting says.
    facts: super::meeting_facts::MeetingFacts,
    /// The summary instruction: words the user asked the recap to use.
    framing: MeetingVocabulary,
    lines: Vec<(String, MeetingVocabulary)>,
    /// Supplied non-citable notes, one source per line.
    notes: Vec<MeetingVocabulary>,
}

impl StatementSupport {
    /// `lines` are (line ID, text, speaker name) for every context line.
    pub(super) fn new<'a>(
        lines: impl IntoIterator<Item = (&'a str, &'a str, Option<&'a str>)>,
        instruction: &str,
        notes: Option<&str>,
    ) -> Self {
        let lines: Vec<_> = lines.into_iter().collect();
        let all_texts = || {
            lines
                .iter()
                .flat_map(|(_, text, speaker)| [Some(*text), *speaker])
                .flatten()
                .chain(notes)
        };
        Self {
            vocabulary: MeetingVocabulary::from_texts(all_texts()),
            facts: super::meeting_facts::MeetingFacts::from_texts(
                lines.iter().map(|(_, text, _)| *text),
            )
            .with_speaker_labels(lines.iter().filter_map(|(_, _, speaker)| *speaker)),
            framing: MeetingVocabulary::from_texts([instruction]),
            lines: lines
                .iter()
                .map(|(id, text, speaker)| {
                    let texts = [Some(*text), *speaker].into_iter().flatten();
                    (id.to_string(), MeetingVocabulary::from_texts(texts))
                })
                .collect(),
            notes: notes
                .into_iter()
                .flat_map(str::lines)
                .filter(|line| !line.trim().is_empty())
                .map(|line| MeetingVocabulary::from_texts([line]))
                .collect(),
        }
    }

    /// Statements naming something the meeting never mentions, then
    /// statements whose content words no one to three source lines support.
    /// Support is sought first in `cited` lines, then in any `allowed` line
    /// or supplied note, because models often cite one fragment of a passage.
    pub(super) fn check(
        &self,
        summary: &str,
        cited: &HashSet<String>,
        allowed: &HashSet<String>,
    ) -> Vec<UnverifiedStatement> {
        let mut results: Vec<UnverifiedStatement> = Vec::new();
        for sentence in statements(summary) {
            if results.iter().any(|entry| entry.statement == sentence) {
                continue;
            }
            let unknown_names = unknown_names(sentence, &self.vocabulary);
            let unknown_facts = self.facts.unknown_in(sentence);
            let kind = if !unknown_names.is_empty() {
                UnverifiedStatementKind::InventedName
            } else if !unknown_facts.is_empty() {
                UnverifiedStatementKind::UnknownFact
            } else if clauses(sentence)
                .into_iter()
                .any(|clause| !self.supported(clause, cited, allowed))
            {
                UnverifiedStatementKind::Unsupported
            } else {
                continue;
            };
            results.push(UnverifiedStatement {
                statement: sentence.to_string(),
                kind,
                unknown_names,
                unknown_facts,
            });
        }
        results
    }

    /// A semantic verdict still needs a content anchor in its own citations.
    /// This is weaker than lexical support, so synonyms can pass, but a verdict
    /// cannot cite an unrelated passage as evidence for a different topic.
    pub(super) fn has_content_anchor(&self, statement: &str, cited: &HashSet<String>) -> bool {
        let content = self.content_words(statement);
        !content.is_empty()
            && self.lines.iter().any(|(id, source)| {
                cited.contains(id) && content.iter().any(|word| source.knows_content(word))
            })
    }

    /// Words that carry the clause's claim: not function words, reporting
    /// verbs, qualifiers, dates, numbers or the instruction's own vocabulary.
    fn content_words(&self, clause: &str) -> Vec<ContentWord> {
        static FRAMING_STEMS: LazyLock<HashSet<String>> = LazyLock::new(|| {
            generic_words()
                .iter()
                .chain(FRAMING)
                .map(|word| stem(word))
                .collect()
        });
        static EDITORIAL: LazyLock<regex::Regex> =
            LazyLock::new(|| regex::Regex::new(r"\[[^\]]*\]").unwrap());
        let mut seen = HashSet::new();
        // Square brackets hold source markers and editorial notes such as
        // "[unclear]", not meeting content.
        let clause = EDITORIAL.replace_all(without_label(clause), " ");
        words(&clause)
            .filter(|word| {
                !is_calendar_word(word) && !is_common_acronym(word) && !self.framing.knows(word)
            })
            .map(|word| stem(&word.to_lowercase()))
            .filter(|stem| !FRAMING_STEMS.contains(stem) && seen.insert(stem.clone()))
            .map(|stem| ContentWord {
                prefix: prefix(&stem),
                stem,
            })
            .collect()
    }

    /// Strictly more than half of the content words must occur in the best
    /// one to three lines, or one line per item of a comma-separated list. Half lets a recap paraphrase or add a category
    /// noun ("the product" for "a remote control"); a clause about a subject
    /// the meeting never discussed contributes its own subject and predicate,
    /// which leaves it at or below half.
    ///
    /// A restriction must also name something those lines mention: in "the
    /// charger should not use permanent storage", "charger" must be supported
    /// even though "permanent storage" alone is a majority.
    fn supported(&self, clause: &str, cited: &HashSet<String>, allowed: &HashSet<String>) -> bool {
        let content = self.content_words(clause);
        if content.is_empty() {
            return true;
        }
        let restricted: HashSet<String> = negated_subject(clause)
            .map(|subject| {
                self.content_words(subject)
                    .into_iter()
                    .map(|word| word.stem)
                    .collect()
            })
            .unwrap_or_default();
        let max_lines = MAX_SUPPORT_LINES.max(clause.split(',').count());
        let accepts = |covered: Vec<bool>| {
            covered.iter().filter(|done| **done).count() > content.len() / 2
                && content
                    .iter()
                    .zip(&covered)
                    .all(|(word, done)| *done || !restricted.contains(&word.stem))
        };
        accepts(best_coverage(
            &content,
            self.lines
                .iter()
                .filter(|(id, _)| cited.contains(id))
                .map(|(_, source)| source),
            max_lines,
        )) || accepts(best_coverage(
            &content,
            self.lines
                .iter()
                .filter(|(id, _)| allowed.contains(id))
                .map(|(_, source)| source)
                .chain(&self.notes),
            max_lines,
        ))
    }
}

/// The words just before a clause's first negation, back to the previous
/// clause boundary: what the restriction applies to.
fn negated_subject(clause: &str) -> Option<&str> {
    static NEGATION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:not|no|never|without|nor|cannot)\b|n['’]t\b").unwrap()
    });
    static BOUNDARY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)[,;:(]|\b(?:and|but|or|while|though|although|whereas|that|which|because|if|unless|when|so)\b",
        )
        .unwrap()
    });
    let before = &clause[..NEGATION.find(clause)?.start()];
    let start = BOUNDARY
        .find_iter(before)
        .last()
        .map_or(0, |found| found.end());
    Some(&before[start..])
}

/// "Time allotted: 25 minutes" claims only what follows its short label.
fn without_label(clause: &str) -> &str {
    match clause.split_once(':') {
        Some((label, rest))
            if !rest.trim().is_empty() && (1..=4).contains(&label.split_whitespace().count()) =>
        {
            rest
        }
        _ => clause,
    }
}

/// Greedily choose up to `max_lines` sources that together contain the most
/// content words, and mark the words they contain.
fn best_coverage<'a>(
    content: &[ContentWord],
    sources: impl Iterator<Item = &'a MeetingVocabulary>,
    max_lines: usize,
) -> Vec<bool> {
    let hits: Vec<Vec<bool>> = sources
        .map(|source| {
            content
                .iter()
                .map(|word| source.knows_content(word))
                .collect()
        })
        .filter(|hits: &Vec<bool>| hits.contains(&true))
        .collect();
    let mut covered = vec![false; content.len()];
    for _ in 0..max_lines {
        let gain = |hits: &Vec<bool>| {
            hits.iter()
                .zip(&covered)
                .filter(|(hit, done)| **hit && !**done)
                .count()
        };
        let Some(best) = hits
            .iter()
            .filter(|hits| gain(hits) > 0)
            .max_by_key(|hits| gain(hits))
        else {
            break;
        };
        for (done, hit) in covered.iter_mut().zip(best) {
            *done |= *hit;
        }
    }
    covered
}

#[cfg(test)]
mod tests {
    #[test]
    fn b23_statement_splitting_preserves_leading_decimals_and_name_titles() {
        assert_eq!(
            statements("3.2 million dollars remain.\nDr. Priya will review the notes.")
                .collect::<Vec<_>>(),
            vec![
                "3.2 million dollars remain.",
                "Dr. Priya will review the notes."
            ]
        );
        assert_eq!(
            statements("1. Priya will review the notes.\n2) The beta ships if QA passes.")
                .collect::<Vec<_>>(),
            vec![
                "Priya will review the notes.",
                "The beta ships if QA passes."
            ]
        );
    }

    use super::*;

    fn vocabulary(lines: &[&str]) -> MeetingVocabulary {
        MeetingVocabulary::from_texts(lines.iter().copied())
    }

    fn unverified_statements(
        summary: &str,
        vocabulary: &MeetingVocabulary,
    ) -> Vec<UnverifiedStatement> {
        statements(summary)
            .filter_map(|statement| {
                let unknown_names = unknown_names(statement, vocabulary);
                (!unknown_names.is_empty()).then(|| UnverifiedStatement {
                    statement: statement.to_string(),
                    kind: UnverifiedStatementKind::InventedName,
                    unknown_names,
                    unknown_facts: Vec::new(),
                })
            })
            .collect()
    }

    fn ids(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn support(lines: &[&str], instruction: &str) -> StatementSupport {
        let ids: Vec<String> = (1..=lines.len()).map(|index| format!("L{index}")).collect();
        StatementSupport::new(
            ids.iter()
                .zip(lines)
                .map(|(id, text)| (id.as_str(), *text, None)),
            instruction,
            None,
        )
    }

    fn unsupported(checks: &[UnverifiedStatement]) -> Vec<&str> {
        checks
            .iter()
            .filter(|check| check.kind == UnverifiedStatementKind::Unsupported)
            .map(|check| check.statement.as_str())
            .collect()
    }

    #[test]
    fn a_statement_cannot_borrow_support_from_a_neighbouring_sentence() {
        let source = support(
            &["We are building a sensor.", "The sensor is compact."],
            "Summarize the meeting",
        );
        let all = ids(&["L1", "L2"]);
        for summary in [
            "The sensor is compact. Its casing is waterproof.",
            "The sensor is compact and its casing is waterproof.",
            "The sensor is compact; the casing is waterproof.",
        ] {
            let checks = source.check(summary, &ids(&["L2"]), &all);
            assert_eq!(checks.len(), 1, "{summary}: {checks:?}");
            assert_eq!(checks[0].kind, UnverifiedStatementKind::Unsupported);
            assert!(checks[0].unknown_names.is_empty());
        }
        assert_eq!(
            unsupported(&source.check("The sensor casing is waterproof.", &ids(&["L2"]), &all)),
            ["The sensor casing is waterproof."]
        );
    }

    #[test]
    fn faithful_paraphrase_and_uncited_but_allowed_sources_are_supported() {
        let source = support(
            &[
                "Now we're developing a remote control which you probably already know",
                "we want it to be original, something",
                "people haven't thought of, that's not out in the shops, um trendy",
                "not hunk of metal, and user-friendly, grannies to kids",
                "Practice with the pens, and draw our favourite animal",
            ],
            "Summarize the meeting",
        );
        let checks = source.check(
            "## Project\n- The team is developing a remote control.\n- The product must be original, trendy, user-friendly and not a 'hunk of metal'.\n- Participants drew their favourite animals.",
            &ids(&["L1"]),
            &ids(&["L1", "L2", "L3", "L4", "L5"]),
        );
        assert!(checks.is_empty(), "{checks:?}");
        // Lines outside the stage's allowed set do not support a statement.
        let checks = source.check(
            "Participants drew their favourite animals.",
            &ids(&["L1"]),
            &ids(&["L1"]),
        );
        assert_eq!(
            unsupported(&checks),
            ["Participants drew their favourite animals."]
        );
    }

    #[test]
    fn instruction_words_qualifiers_and_supplied_notes_are_not_unsupported_content() {
        let source = StatementSupport::new(
            [("L1", "our selling price at twenty five Euros", Some("Speaker 1"))],
            "Keep selling prices, tentative converted-price estimates, and exchange rates separate.",
            Some("Attendees: Priya from finance"),
        );
        let all = ids(&["L1"]);
        for summary in [
            "A tentative estimate converts the 25 Euros at an approximate exchange rate.",
            "Speaker 1 set the selling price at 25 Euros.",
            "Priya attended from finance.",
        ] {
            let checks = source.check(summary, &all, &all);
            assert!(checks.is_empty(), "{summary}: {checks:?}");
        }
    }

    #[test]
    fn instructions_do_not_vouch_for_new_names() {
        let source = support(
            &["We will review the pilot."],
            "Summarize what Marcus will review.",
        );
        let all = ids(&["L1"]);
        let checks = source.check("Marcus will review the pilot.", &all, &all);
        assert!(
            checks
                .iter()
                .any(|check| check.kind == UnverifiedStatementKind::InventedName
                    && check.unknown_names == ["Marcus"]),
            "{checks:?}"
        );
    }

    #[test]
    fn a_statement_with_an_invented_name_is_reported_once_as_a_name() {
        let source = support(&["Priya will send the draft"], "Summarize the meeting");
        let checks = source.check(
            "Marcus will audit the warehouse.",
            &ids(&["L1"]),
            &ids(&["L1"]),
        );
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].kind, UnverifiedStatementKind::InventedName);
        assert_eq!(checks[0].unknown_names, ["Marcus"]);
    }

    #[test]
    fn saved_statements_without_a_kind_are_invented_names() {
        let saved: UnverifiedStatement = serde_json::from_str(
            r#"{"statement":"Marcus will check it.","unknownNames":["Marcus"]}"#,
        )
        .unwrap();
        assert_eq!(saved.kind, UnverifiedStatementKind::InventedName);
        let unsupported = UnverifiedStatement {
            statement: "Its casing is waterproof.".into(),
            kind: UnverifiedStatementKind::Unsupported,
            unknown_names: Vec::new(),
            unknown_facts: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(&unsupported).unwrap(),
            serde_json::json!({
                "statement": "Its casing is waterproof.",
                "kind": "unsupported",
                "unknownNames": []
            })
        );
    }

    #[test]
    fn a_statement_with_a_value_or_day_the_meeting_never_said_is_reported() {
        let source = support(
            &[
                "the pilot quote came back at forty thousand",
                "send the contract by Friday",
            ],
            "Summarize the meeting",
        );
        let all = ids(&["L1", "L2"]);
        assert!(source
            .check("The pilot quote came back at $40,000.", &all, &all)
            .is_empty());
        let checks = source.check("The pilot quote came back at $45,000.", &all, &all);
        assert_eq!(checks.len(), 1, "{checks:?}");
        assert_eq!(checks[0].kind, UnverifiedStatementKind::UnknownFact);
        assert_eq!(checks[0].unknown_facts, ["$45,000"]);
        let checks = source.check("Send the contract by Thursday.", &all, &all);
        assert_eq!(checks[0].kind, UnverifiedStatementKind::UnknownFact);
        assert_eq!(
            serde_json::to_value(&checks[0]).unwrap()["kind"],
            "unknown_fact"
        );
    }

    #[test]
    fn paraphrased_ordinary_words_are_not_reported() {
        let vocab = vocabulary(&["We are building a sensor.", "The sensor is compact."]);
        assert!(unverified_statements(
            "The team introduced the sensor. Its casing is waterproof.",
            &vocab
        )
        .is_empty());
    }

    #[test]
    fn invented_names_and_acronyms_fail_but_spoken_names_pass() {
        let vocab = vocabulary(&["priya will send the draft on friday", "we use the api"]);
        let checks = unverified_statements(
            "- Priya will send the draft on Friday.\n- Marcus will check GDPR compliance with the API team.",
            &vocab,
        );
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].unknown_names, ["Marcus", "GDPR"]);
    }

    #[test]
    fn group_subjects_business_acronyms_and_plain_headings_are_not_names() {
        let vocab = vocabulary(&["we reviewed the launch plan and the budget"]);
        for summary in [
            "Everyone agreed the launch plan is ready.",
            "Engineering will review the budget.",
            "Someone will send the launch plan.",
            "The MVP and the KPI targets were reviewed.",
            "Key Takeaways\n- The budget was reviewed.",
        ] {
            assert!(
                unverified_statements(summary, &vocab).is_empty(),
                "{summary}"
            );
        }
    }

    #[test]
    fn headings_labels_and_sentence_initial_words_are_formatting() {
        let vocab = vocabulary(&[
            "the budget is fixed",
            "Summarize the meeting with Decisions and Next steps",
        ]);
        let checks = unverified_statements(
            "## Decisions\n**Key Outcomes:**\n- **Budget:** The budget is fixed.\n1. Budget is fixed.",
            &vocab,
        );
        assert!(checks.is_empty(), "{checks:?}");
    }

    #[test]
    fn inflections_and_reporting_verbs_do_not_count_as_new_content() {
        let vocab = vocabulary(&[
            "they approved the shipping plan",
            "we will migrate tomorrow",
        ]);
        let checks = unverified_statements(
            "The team discussed approval of the shipment plan. Migration is planned for tomorrow.",
            &vocab,
        );
        assert!(checks.is_empty(), "{checks:?}");
    }

    #[test]
    fn digits_are_left_to_numeric_checks() {
        let vocab = vocabulary(&["the fee is twelve fifty"]);
        assert!(unverified_statements("The fee is 12.50 EUR.", &vocab).is_empty());
    }

    #[test]
    fn a_list_may_take_each_item_from_its_own_line() {
        let source = support(
            &[
                "draw our favourite animal",
                "that's supposed to be a tiger",
                "a kind of dog",
                "it can be a crocodile",
                "it's meant to be an eagle",
            ],
            "Summarize the meeting",
        );
        let all = ids(&["L1", "L2", "L3", "L4", "L5"]);
        let checks = source.check(
            "The animals drawn were a tiger, a dog, a crocodile and an eagle.",
            &ids(&["L1"]),
            &all,
        );
        assert!(checks.is_empty(), "{checks:?}");
        let checks = source.check(
            "The animals drawn were a tiger, a dragon, a unicorn and a phoenix.",
            &ids(&["L1"]),
            &all,
        );
        assert_eq!(checks.len(), 1, "{checks:?}");
    }

    #[test]
    fn a_restriction_must_name_something_its_source_mentions() {
        let source = support(
            &[
                "We are building a recorder.",
                "It should not use permanent storage.",
            ],
            "Summarize the meeting",
        );
        let all = ids(&["L1", "L2"]);
        let checks = source.check(
            "The recorder should not use permanent storage.",
            &ids(&["L2"]),
            &all,
        );
        assert!(checks.is_empty(), "{checks:?}");
        // "permanent storage" alone is a majority, but the charger is new.
        let checks = source.check(
            "The team is building a recorder. The charger should not use permanent storage.",
            &ids(&["L1", "L2"]),
            &all,
        );
        assert_eq!(
            unsupported(&checks),
            ["The charger should not use permanent storage."]
        );
    }

    /// Grouped rows from the frozen public AMI reference meeting, with the
    /// Qwen 3.5 9B recap and its repair from the 2026-10-09 salience review.
    #[test]
    fn frozen_public_meeting_recaps_have_no_false_flags() {
        let rows = [
            ("L17", "I'm Sarah, the Project"),
            ("L18", "Manager."),
            ("L19", "And this is our first meeting, surprisingly"),
            ("L20", "enough,"),
            ("L21", "okay this is our agenda"),
            ("L25", "do some stuff, get to know each other a bit better, feel more comfortable with each other, um then we'll go"),
            ("L26", "do tool"),
            ("L27", "training,"),
            ("L28", "talk about the project plan, discuss our own ideas and everything"),
            ("L29", "um"),
            ("L30", "and we've got twenty five minutes to do that as far as I can"),
            ("L31", "understand,"),
            ("L32", "Now we're developing a remote control which you probably already know, um"),
            ("L33", "we want it to be original, something"),
            ("L34", "that's"),
            ("L35", "people haven't thought of, that's not out in the shops, um trendy, appealing to a wide market,"),
            ("L36", "but"),
            ("L37", "you"),
            ("L38", "know,"),
            ("L39", "not hunk of metal, and user-friendly, grannies to kids"),
            ("L40", "maybe even put"),
            ("L41", "able to use"),
            ("L42", "it,"),
            ("L43", "okay, um first is the functional design, um this is where we all go off and do our individual work"),
            ("L44", "um"),
            ("L45", "what needs need to be fulfilled by the product, um what effect the product has to have"),
            ("L49", "um conceptual"),
            ("L50", "design,"),
            ("L57", "Practice with the pens, and draw our favourite animal"),
            ("L58", "on the whiteboard, I'll go first"),
            ("L59", "and"),
            ("L60", "sum up the characteristics"),
            ("L61", "of that animal, so"),
            ("L66", "okay, I'm not gonna ask you to guess, I'm going to tell you that that's supposed to be a"),
            ("L67", "tiger,"),
            ("L68", "and I see them as majestic"),
            ("L69", "and"),
            ("L70", "Independent"),
            ("L71", "and"),
            ("L72", "proud"),
            ("L209", "um finance-wise we've got"),
            ("L210", "our selling price at twenty five Euros"),
            ("L211", "which I don't actually know"),
            ("L212", "what"),
            ("L213", "that is in Pounds at all"),
            ("L214", "any ideas"),
            ("L215", "seventeen"),
            ("L216", "four something"),
            ("L217", "like that"),
            ("L218", "one point four Euro would make a pound"),
            ("L219", "or something"),
            ("L220", "like yeah yeah something like"),
            ("L221", "that"),
            ("L222", "so"),
            ("L223", "yeah"),
            ("L224", "about seventeen seventeen"),
            ("L225", "seventeen pounds"),
        ];
        let source = StatementSupport::new(
            rows.iter().map(|(id, text)| (*id, *text, None)),
            crate::analysis::meeting_template_summary_query(None),
            None,
        );
        let allowed: HashSet<String> = rows.iter().map(|(id, _)| id.to_string()).collect();
        for (summary, cited) in [
            (
                "The team introduced themselves and reviewed the agenda for a 25-minute session on remote control development. The product must be original, trendy, user-friendly (for all ages), and not a 'hunk of metal'. The meeting included functional design exercises where participants drew animals; individual drawings and character traits were discussed but no specific animal was selected as the final concept. Financially, the selling price is set at 25 Euros. A tentative conversion estimate suggests this is approximately 17 Pounds (based on a rate of 1.4 Euro per Pound), though the exact conversion was not confirmed.",
                ids(&["L19", "L32", "L33", "L35", "L39", "L209", "L210", "L218", "L224"]),
            ),
            (
                "The team introduced themselves and reviewed the agenda for a 25-minute session on remote control development. The product must be original, trendy, user-friendly (for all ages), and not a 'hunk of metal'. Financially, the selling price is set at 25 Euros. A tentative conversion estimate suggests this is roughly about 17 Pounds (based on a rate of 1.4 Euro per Pound), though the exact conversion was not confirmed.",
                ids(&["L19", "L30", "L33", "L35", "L39", "L209", "L210", "L215", "L216", "L218", "L224"]),
            ),
        ] {
            let checks = source.check(summary, &cited, &allowed);
            assert!(checks.is_empty(), "{checks:?}");
        }
        let checks = source.check(
            "The remote must be original. Its casing is waterproof.",
            &ids(&["L33"]),
            &allowed,
        );
        assert_eq!(unsupported(&checks), ["Its casing is waterproof."]);
    }

    /// Replays every direct summary draft saved in a frozen native result,
    /// such as artifacts/continuation-2026-10-09/meeting-notes-salience/
    /// native/notes-qwen3.5-9b-reference.json.
    #[test]
    #[ignore = "requires a frozen native meeting result through PLAINSONG_STATEMENT_SUPPORT_EVAL_JSON"]
    fn frozen_native_summaries_have_no_unsupported_statements() {
        let path =
            std::env::var("PLAINSONG_STATEMENT_SUPPORT_EVAL_JSON").expect("frozen evaluation path");
        let result: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        // Repairs see only their repair lines, but a repaired recap is checked
        // against the first request's full context, as in production.
        let mut context: Option<(StatementSupport, HashSet<String>)> = None;
        let mut replayed = 0;
        for response in result["providerResponses"].as_array().unwrap() {
            let prompt = response["request"]["prompt"].as_str().unwrap_or_default();
            if response["purpose"] != "Summary" {
                continue;
            }
            if context.is_none() && !prompt.contains("<draft_data") {
                let Some((_, transcript)) = prompt
                    .split_once("<transcript_data")
                    .and_then(|(_, rest)| rest.split_once('\n'))
                else {
                    continue;
                };
                let instruction = prompt
                    .split("<task_instruction>")
                    .nth(1)
                    .and_then(|rest| rest.split("</task_instruction>").next())
                    .unwrap_or_default()
                    .trim();
                let lines: Vec<(String, String, Option<String>)> = transcript
                    .split("</transcript_data>")
                    .next()
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|row| {
                        let mut parts = row.split('\t');
                        let id = parts.next()?.to_string();
                        let text = serde_json::from_str(parts.next()?).ok()?;
                        let speaker = parts
                            .next()
                            .and_then(|part| part.strip_prefix("SPEAKER "))
                            .and_then(|part| serde_json::from_str(part).ok());
                        Some((id, text, speaker))
                    })
                    .collect();
                let source = StatementSupport::new(
                    lines.iter().map(|(id, text, speaker)| {
                        (id.as_str(), text.as_str(), speaker.as_deref())
                    }),
                    instruction,
                    None,
                );
                context = Some((source, lines.into_iter().map(|(id, _, _)| id).collect()));
            }
            let Some((source, allowed)) = &context else {
                continue;
            };
            let text = response["text"].as_str().unwrap_or_default();
            let Some(payload) = text
                .find('{')
                .zip(text.rfind('}'))
                .and_then(|(start, end)| {
                    serde_json::from_str::<serde_json::Value>(text.get(start..=end)?).ok()
                })
            else {
                continue;
            };
            let Some(summary) = payload["response"].as_str().or(payload["answer"].as_str()) else {
                continue;
            };
            let cited: HashSet<String> = payload["lineIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect();
            let checks = source.check(summary, &cited, allowed);
            assert!(checks.is_empty(), "{summary}\n{checks:?}");
            replayed += 1;
        }
        assert!(
            replayed > 0,
            "no direct summary drafts in the frozen result"
        );
    }
}
