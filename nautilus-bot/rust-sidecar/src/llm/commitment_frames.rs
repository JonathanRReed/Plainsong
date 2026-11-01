//! Structural commitments in source passages, robust to ASR wording.
//!
//! A frame is one source clause: its subject, modal, verb, object, date and
//! condition, read after removing fillers and stutters. Frames from repeated,
//! split or partial passages are consolidated. They serve three purposes:
//!
//! - A summary or action claim may attach a condition, date, owner or negation
//!   to a commitment only when the same source clause does.
//! - Key decisions (agreements and conditional commitments) must appear in
//!   prose with their condition and date.
//! - Stated commitments must appear as actions.
//!
//! Coverage text is built only from one source clause's own fields. Ambiguous
//! or conflicting source clauses produce no text and no condition judgment.

use super::grounded::TrustedLine;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum FrameKind {
    Agreement,
    Commitment,
    Requirement,
    /// "I can explain the setup": checked, never stated as a commitment.
    Possibility,
}

#[derive(Clone, Debug)]
pub(super) struct SourceFrame {
    pub kind: FrameKind,
    /// Source subject wording: "We", a person, or a requirement noun phrase.
    pub subject: String,
    /// The responsible person. `None` for a group or a requirement.
    pub owner: Option<String>,
    pub negated: bool,
    /// Predicate wording without its date or condition, e.g. "ship the beta".
    pub core: String,
    pub date: Option<String>,
    pub condition: Option<String>,
    /// A following "It must ..." sentence that constrains the same task.
    pub constraint: Option<String>,
    pub recording_id: String,
    pub line_ids: Vec<String>,
    /// The clause ended inside its passage; truncated fragments are evidence
    /// for identity only.
    pub complete: bool,
    /// The clause follows another commitment after a leading condition, so
    /// the condition's scope is unclear.
    pub ambiguous: bool,
    /// Repeated clauses disagree on date or condition without a correction.
    pub conflict: bool,
    verb: String,
    objects: HashSet<String>,
    date_key: Option<String>,
    condition_key: Vec<String>,
    correction: bool,
    first_person: bool,
    plan: bool,
    /// The condition came from a separate sentence; trusted only alone.
    detached: bool,
    order: usize,
    /// The source sentence (index into the parsed units) holding the clause.
    pub unit: usize,
    /// Other sentences the clause depends on, in source order: a detached
    /// condition, a constraint, a date correction or a retraction.
    pub extra_units: Vec<usize>,
    /// A later sentence withdraws the clause ("scratch that").
    pub retracted: bool,
    /// The separate sentence that states a detached condition.
    pub condition_unit: Option<usize>,
    /// A heading colon inside the task or condition: the clause ran into a
    /// spoken heading ("unless the notice arrives late editor's desk: we'll").
    pub heading_inside: bool,
    /// Every complete sentence that states this clause clearly, including
    /// repeats that consolidation merged into it.
    pub member_units: Vec<usize>,
}

#[derive(Clone, Debug)]
pub(super) struct Tok {
    pub(super) text: String,
    pub(super) lower: String,
    pub(super) comma: bool,
    pub(super) end: bool,
    pub(super) question: bool,
    /// A heading colon: "Pricing: the student plan is $9".
    pub(super) colon: bool,
    pub(super) line: usize,
    /// The spoken contraction this token opens ("I'll", "won't"), shown
    /// instead of its expanded parts.
    pub(super) whole: Option<String>,
    /// The second part of a split contraction.
    pub(super) joined: bool,
    /// Words removed for parsing that carry meaning when shown: a mid-sentence
    /// "so", "like," or "I mean,". Display puts them back after this token.
    pub(super) restored: Vec<String>,
}

const FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm",
];

fn split_word(raw: &str, line: usize, out: &mut Vec<Tok>) {
    let raw = raw.trim_matches(|ch: char| matches!(ch, '"' | '“' | '”' | '(' | ')' | '[' | ']'));
    let mut body = raw;
    let mut comma = false;
    let mut colon = false;
    let mut end = false;
    let mut question = false;
    while let Some(last) = body.chars().last() {
        if matches!(last, ',' | ':') {
            comma = true;
            colon |= last == ':';
        } else if matches!(last, '.' | '!' | ';') {
            end = true;
        } else if last == '?' {
            end = true;
            question = true;
        } else {
            break;
        }
        body = &body[..body.len() - last.len_utf8()];
    }
    if body.is_empty() {
        if let Some(previous) = out.last_mut() {
            previous.comma |= comma;
            previous.colon |= colon;
            previous.end |= end;
            previous.question |= question;
        }
        return;
    }
    let body = body.replace('’', "'");
    let lower = body.to_lowercase();
    // `part`: 0 for a whole word, 1 for a contraction's first part, 2 for
    // its second part.
    let mut push = |text: &str, lower: &str, part: u8| {
        let last = part != 1;
        out.push(Tok {
            text: text.to_string(),
            lower: lower.to_string(),
            comma: last && comma,
            colon: last && colon,
            end: last && end,
            question: last && question,
            line,
            whole: (part == 1).then(|| body.clone()),
            joined: part == 2,
            restored: Vec::new(),
        })
    };
    if let Some(stem) = lower.strip_suffix("n't") {
        let base = match stem {
            "wo" | "won" => "will",
            "ca" | "can" => "can",
            other => other,
        };
        let surface = if base == stem {
            &body[..stem.len()]
        } else {
            base
        };
        push(surface, base, 1);
        push("not", "not", 2);
    } else if let Some(stem) = lower.strip_suffix("'ll") {
        push(&body[..stem.len()], stem, 1);
        push("will", "will", 2);
    } else if let Some(stem) = lower.strip_suffix("'re") {
        push(&body[..stem.len()], stem, 1);
        push("are", "are", 2);
    } else if let Some(stem) = lower.strip_suffix("'ve") {
        push(&body[..stem.len()], stem, 1);
        push("have", "have", 2);
    } else if lower == "i'm" {
        push("I", "i", 1);
        push("am", "am", 2);
    } else {
        push(&body, &lower, 0);
    }
}

pub(super) fn tokens(text: &str, line: usize) -> Vec<Tok> {
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        split_word(raw, line, &mut out);
    }
    without_disfluencies(out)
}

/// Remove fillers and immediate stutters. Neither carries meaning, and both
/// break exact clause comparison on fresh captures.
pub(super) fn without_disfluencies(input: Vec<Tok>) -> Vec<Tok> {
    let mut out: Vec<Tok> = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let token = &input[index];
        let next = input.get(index + 1);
        let filler = FILLERS.contains(&token.lower.as_str())
            || token.lower == "like" && token.comma
            || token.lower == "so"
                && (!next.is_some_and(|next| {
                    matches!(
                        next.lower.as_str(),
                        "that" | "far" | "much" | "many" | "long"
                    )
                }) || out.last().is_some_and(|last| last.lower == "as"))
            || token.lower == "okay" && next.is_some_and(|next| next.lower == "so");
        let pair = (token.lower == "you" && next.is_some_and(|next| next.lower == "know")
            || token.lower == "i" && next.is_some_and(|next| next.lower == "mean"))
            && (next.is_some_and(|next| next.comma) || out.last().is_some_and(|last| last.comma));
        if filler || pair {
            let skipped = if pair { 2 } else { 1 };
            let last = &input[index + skipped - 1];
            // Inside a sentence, "so", "like," and "I mean," can carry
            // meaning (a reason, an estimate, a correction). Parsing skips
            // them; display puts them back. Hesitations, "you know" and a
            // sentence-opening "so" or "okay" carry none.
            // "like," means "about" only before a quantity ("like, 40
            // people"); elsewhere it is a filler.
            let estimate = token.lower != "like"
                || input
                    .get(index + skipped)
                    .is_some_and(|next| number_key(&next.lower).is_some());
            let meaningful = !(FILLERS.contains(&token.lower.as_str())
                || token.lower == "you" && pair
                || token.lower == "okay" && !pair
                || !estimate
                || inside_phrase(out.last(), input.get(index + skipped)));
            if let Some(previous) = out.last_mut() {
                if meaningful && !previous.end {
                    let mut words = input[index..index + skipped]
                        .iter()
                        .map(|token| token.text.clone())
                        .collect::<Vec<_>>()
                        .join(" ");
                    if last.comma {
                        words.push(if last.colon { ':' } else { ',' });
                    }
                    previous.restored.push(words);
                }
                previous.end |= last.end;
                previous.question |= last.question;
            }
            index += skipped;
            continue;
        }
        out.push(token.clone());
        index += 1;
    }
    loop {
        let mut changed = false;
        'scan: for size in (1..=4).rev() {
            for at in 0..out.len().saturating_sub(2 * size - 1) {
                if out[at..at + size].iter().any(|token| token.end) {
                    continue;
                }
                if (0..size).all(|k| out[at + k].lower == out[at + size + k].lower)
                    && !(size == 1 && out[at].lower.chars().any(|ch| ch.is_ascii_digit()))
                {
                    // Words restored inside a stutter ("orders so orders")
                    // go with the dropped copy.
                    out.drain(at..at + size);
                    changed = true;
                    break 'scan;
                }
            }
        }
        if !changed {
            return out;
        }
    }
}

/// Whether a removed word sat inside a fixed phrase, where it cannot carry
/// meaning and showing it would split the phrase: a condition cue ("as long
/// as", "only if", "provided that") or a date ("the 9th of October").
fn inside_phrase(previous: Option<&Tok>, next: Option<&Tok>) -> bool {
    let (Some(previous), Some(next)) = (previous, next) else {
        return false;
    };
    if previous.comma || previous.end {
        return false;
    }
    let (before, after) = (previous.lower.as_str(), next.lower.as_str());
    let day = |word: &str| {
        number_key(word).is_some_and(|key| key.parse::<u32>().is_ok_and(|n| (1..=31).contains(&n)))
    };
    matches!(
        (before, after),
        ("long", "as") | ("as", "long") | ("provided" | "providing", "that")
    ) || before == "only" && matches!(after, "if" | "when" | "after" | "once")
        || matches!(before, "if" | "unless" | "until" | "provided" | "once")
        || before == "the" && day(after)
        || day(before) && (after == "of" || MONTHS.contains(&after))
        || before == "of" && MONTHS.contains(&after)
        || MONTHS.contains(&before) && (after == "the" || day(after))
}

/// Source text without fillers or stutters, for wording comparisons.
pub(super) fn cleaned_text(text: &str) -> String {
    let mut out = String::new();
    let mut raw: Vec<Tok> = Vec::new();
    for word in text.split_whitespace() {
        let trimmed = word.trim_end_matches([',', '.', '!', '?', ';', ':']);
        let bare = trimmed.to_lowercase().replace('’', "'");
        raw.push(Tok {
            text: word.to_string(),
            lower: bare,
            comma: word.ends_with([',', ':']),
            end: word.ends_with(['.', '!', '?', ';']),
            question: word.ends_with('?'),
            colon: word.ends_with(':'),
            line: 0,
            whole: None,
            joined: false,
            restored: Vec::new(),
        });
    }
    for token in without_disfluencies(raw) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&token.text);
    }
    out
}

pub(super) fn lemma(word: &str) -> String {
    let word = word.trim_end_matches("'s").to_lowercase();
    let irregular = match word.as_str() {
        "sent" | "sending" => Some("send"),
        "took" | "taken" | "taking" => Some("take"),
        "wrote" | "written" | "writing" => Some("write"),
        "made" | "making" => Some("make"),
        "kept" | "keeping" => Some("keep"),
        "met" | "meeting" => Some("meet"),
        "ran" | "running" => Some("run"),
        "brought" | "bringing" => Some("bring"),
        "shipment" | "shipments" | "shipping" | "shipped" | "ships" => Some("ship"),
        "approval" | "approvals" => Some("approve"),
        "delivery" | "deliveries" => Some("deliver"),
        "notification" | "notifications" | "notifies" | "notified" => Some("notify"),
        "renewal" | "renewals" => Some("renew"),
        "expansion" => Some("expand"),
        "migration" | "migrations" => Some("migrate"),
        "replacement" => Some("replace"),
        "booking" | "bookings" => Some("book"),
        "release" | "releases" | "released" | "releasing" => Some("release"),
        "remain" | "remains" | "remained" | "stays" | "stayed" | "staying" => Some("stay"),
        "data" => Some("data"),
        _ => None,
    };
    if let Some(base) = irregular {
        return base.into();
    }
    let mut stem = word.clone();
    for suffix in ["ings", "ing", "ers", "ed", "es", "s"] {
        // "orders" is "order", not "ord"; "readers" is still "read".
        let minimum = suffix.len() + if suffix == "ers" { 3 } else { 2 };
        if stem.len() > minimum && stem.ends_with(suffix) && !stem.ends_with("ss") {
            stem.truncate(stem.len() - suffix.len());
            break;
        }
    }
    let bytes = stem.as_bytes();
    if bytes.len() > 3
        && bytes[bytes.len() - 1] == bytes[bytes.len() - 2]
        && !matches!(bytes[bytes.len() - 1], b's' | b'l' | b'e' | b'o')
    {
        stem.pop();
    }
    if stem.len() > 3 && stem.ends_with('e') {
        stem.pop();
    }
    stem
}

pub(super) fn same_lemma(first: &str, second: &str) -> bool {
    first == second
        || first.len() >= 4
            && second.len() >= 4
            && (first.starts_with(second) || second.starts_with(first))
            && first.len().abs_diff(second.len()) <= 3
}

const DISCOURSE: &[&str] = &["yes", "yeah", "okay", "right", "sure", "well", "oh"];

pub(super) const STOPWORDS: &[&str] = &[
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "will", "would", "if", "only",
    "unless", "until", "provided", "that", "once", "after", "when", "as", "long", "to", "of",
    "for", "on", "by", "in", "at", "and", "or", "it", "its", "this", "these", "those", "still",
    "any", "all", "then", "also", "just", "i", "we", "he", "she", "they", "you", "me", "us", "our",
    "their", "his", "her", "my", "your", "them", "with", "from", "into", "both", "some", "has",
    "have", "had", "do", "does", "not", "no", "can", "could", "should", "must", "up", "so",
    "there", "here", "what", "which", "who", "every", "each", "very", "now", "yet",
];

pub(super) fn content(words: &[&Tok]) -> Vec<String> {
    let mut seen = HashSet::new();
    words
        .iter()
        .filter(|token| !STOPWORDS.contains(&token.lower.as_str()))
        .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
        .filter(|word| !word.is_empty() && seen.insert(word.clone()))
        .collect()
}

const ORDINALS: &[&str] = &[
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
    "twentieth",
];
const CARDINALS: &[&str] = &[
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];
pub(super) const WEEKDAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
pub(super) const MONTHS: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Digits for a spoken or written count or ordinal, e.g. "fourteenth" or "14th".
pub(super) fn number_key(word: &str) -> Option<String> {
    let word = word.trim_start_matches('$');
    if let Some(at) = ORDINALS.iter().position(|w| *w == word) {
        return Some((at + 1).to_string());
    }
    if let Some(at) = CARDINALS.iter().position(|w| *w == word) {
        return Some((at + 1).to_string());
    }
    if word == "thirtieth" {
        return Some("30".into());
    }
    // "by the thirty": a spoken day.
    if word == "thirty" {
        return Some("30".into());
    }
    for (tens, value) in [("twenty", 20), ("thirty", 30)] {
        if let Some(rest) = word
            .strip_prefix(tens)
            .and_then(|rest| rest.strip_prefix('-'))
        {
            if let Some(at) = ORDINALS.iter().take(9).position(|w| *w == rest) {
                return Some((value + at + 1).to_string());
            }
            if let Some(at) = CARDINALS.iter().take(9).position(|w| *w == rest) {
                return Some((value + at + 1).to_string());
            }
        }
    }
    let digits = word
        .strip_suffix("st")
        .or_else(|| word.strip_suffix("nd"))
        .or_else(|| word.strip_suffix("rd"))
        .or_else(|| word.strip_suffix("th"))
        .unwrap_or(word)
        .replace(',', "");
    (!digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit() || ch == '.'))
        .then_some(digits)
}

/// A spoken self-correction inside a sentence starts at `at`: "wait",
/// "sorry", "actually", "make that", "make it the 19th", "or rather", "X,
/// no, Y", "Thursday no Friday", "I mean" (removed for parsing, restored for
/// display), "let me correct that" or "scratch that".
fn in_sentence_correction(tokens: &[&Tok], at: usize) -> bool {
    let word = |k: usize| tokens.get(k).map(|token| token.lower.as_str());
    // "by the 26th, I mean the 28th": parsing removed "I mean," after the
    // previous word. Only between two dates is it a correction; elsewhere
    // ("If the export looks clean, I mean, I'll ...") it is discourse.
    if at > 0
        && tokens[at - 1]
            .restored
            .iter()
            .any(|words| words.to_lowercase().starts_with("i mean"))
        && date_at(tokens, at).is_some()
        && (at.saturating_sub(4)..at)
            .any(|start| date_at(tokens, start).is_some_and(|(end, _)| end == at))
    {
        return true;
    }
    match tokens[at].lower.as_str() {
        "wait" | "sorry" | "actually" => true,
        "make" if word(at + 1) == Some("it") => date_at(tokens, at + 2).is_some(),
        "make" | "scratch" => word(at + 1) == Some("that"),
        "rather" => at > 0 && word(at - 1) == Some("or"),
        // "by Friday, no, Monday": a bare "no" between commas, or between
        // two dates ("on Thursday no Friday").
        "no" => {
            at > 0
                && (tokens[at - 1].comma && tokens[at].comma
                    || date_at(tokens, at - 1).is_some_and(|(end, _)| end == at)
                        && date_at(tokens, at + 1).is_some())
        }
        "let" => {
            word(at + 1) == Some("me") && word(at + 2).is_some_and(|w| w.starts_with("correct"))
        }
        _ => false,
    }
}

/// Whether two date keys can name the same day: equal, or a bare day ("9")
/// and a month day with that day ("october 9").
pub(super) fn same_date(first: &str, second: &str) -> bool {
    let day = |key: &str| {
        key.split_once(' ')
            .filter(|(month, _)| MONTHS.contains(month))
            .map(|(_, day)| day.to_string())
    };
    let bare = |key: &str| key.chars().all(|ch| ch.is_ascii_digit());
    first == second
        || bare(first) && day(second).as_deref() == Some(first)
        || bare(second) && day(first).as_deref() == Some(second)
}

fn has_date(dates: &[String], key: &str) -> bool {
    dates.iter().any(|date| same_date(date, key))
}

/// A date phrase starting at `at`: returns (end, key).
pub(super) fn date_at(tokens: &[&Tok], at: usize) -> Option<(usize, String)> {
    let word = |k: usize| tokens.get(k).map(|token| token.lower.as_str());
    let mut k = at;
    if matches!(word(k), Some("next" | "this" | "coming")) {
        k += 1;
    }
    let first = word(k)?;
    if WEEKDAYS.contains(&first) {
        return Some((k + 1, first.into()));
    }
    if matches!(
        first,
        "today" | "tomorrow" | "noon" | "midnight" | "tonight"
    ) {
        return Some((k + 1, first.into()));
    }
    if k > at && matches!(first, "week" | "month" | "year" | "quarter") {
        return Some((k + 1, format!("{} {first}", tokens[k - 1].lower)));
    }
    // Clock times: "10:30", "3 pm".
    let clock = first.split_once(':').is_some_and(|(h, m)| {
        !h.is_empty()
            && h.len() <= 2
            && h.chars().all(|c| c.is_ascii_digit())
            && m.len() == 2
            && m.chars().all(|c| c.is_ascii_digit())
    });
    let meridiem = word(k + 1).is_some_and(|next| matches!(next, "am" | "pm" | "a.m" | "p.m"));
    if clock || meridiem && first.chars().all(|c| c.is_ascii_digit()) {
        let end = k + 1 + usize::from(meridiem);
        return Some((
            end,
            tokens[k..end]
                .iter()
                .map(|t| t.lower.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ));
    }
    // A day of the month, as a key: "9", "9th", "ninth" or "twenty-first".
    let day_of = |k: usize| {
        word(k)
            .and_then(number_key)
            .filter(|day| day.parse::<u32>().is_ok_and(|day| (1..=31).contains(&day)))
    };
    let month_at = |k: usize| word(k).filter(|month| MONTHS.contains(month));
    // "October the ninth".
    if MONTHS.contains(&first) && word(k + 1) == Some("the") {
        if let Some(day) = day_of(k + 2) {
            return Some((k + 3, format!("{first} {day}")));
        }
    }
    if MONTHS.contains(&first) && first != "may"
        || first == "may" && word(k + 1).and_then(number_key).is_some()
    {
        if let Some(day) = word(k + 1).and_then(number_key) {
            return Some((k + 2, format!("{first} {day}")));
        }
        return Some((k + 1, first.into()));
    }
    // "the 9th of October" and "the ninth October" name one date.
    if first == "the" {
        if let Some(day) = day_of(k + 1) {
            if word(k + 2) == Some("of") {
                if let Some(month) = month_at(k + 3) {
                    return Some((k + 4, format!("{month} {day}")));
                }
            } else if let Some(month) = month_at(k + 2) {
                return Some((k + 3, format!("{month} {day}")));
            }
        }
    }
    // "9th of October", "9 October": a day before its month.
    if let Some(day) = day_of(k) {
        if word(k + 1) == Some("of") {
            if let Some(month) = month_at(k + 2) {
                return Some((k + 3, format!("{month} {day}")));
            }
        } else if let Some(month) = month_at(k + 1) {
            return Some((k + 2, format!("{month} {day}")));
        }
    }
    if first == "the" {
        let day = word(k + 1).and_then(number_key)?;
        let value: u32 = day.parse().ok()?;
        if (1..=31).contains(&value)
            && !word(k + 2).is_some_and(|next| {
                !STOPWORDS.contains(&next)
                    && !matches!(next, "if" | "unless" | "until")
                    && tokens[k + 1].comma.eq(&false)
                    && !tokens[k + 1].end
            })
        {
            return Some((k + 2, day));
        }
    }
    if matches!(first, "end") && word(k + 1) == Some("of") {
        return Some((k + 3, format!("end of {}", word(k + 2).unwrap_or(""))));
    }
    None
}

pub(super) fn condition_cue(tokens: &[&Tok], at: usize) -> Option<usize> {
    let word = tokens[at].lower.as_str();
    match word {
        "if" | "unless" | "until" | "provided" | "once" | "after" | "when" => Some(1),
        "only"
            if tokens.get(at + 1).is_some_and(|next| {
                matches!(next.lower.as_str(), "if" | "after" | "when" | "once")
            }) =>
        {
            Some(2)
        }
        "as" | "so"
            if tokens.get(at + 1).is_some_and(|next| next.lower == "long")
                && tokens.get(at + 2).is_some_and(|next| next.lower == "as") =>
        {
            Some(3)
        }
        _ => None,
    }
}

const NOT_SUBJECTS: &[&str] = &[
    "the",
    "this",
    "that",
    "it",
    "if",
    "and",
    "but",
    "so",
    "yes",
    "no",
    "okay",
    "correction",
    "actually",
    "then",
    "they",
    "he",
    "she",
    "you",
    "there",
    "here",
    "what",
    "when",
    "who",
    "why",
    "how",
    "a",
    "an",
    "do",
    "please",
    "also",
    "now",
    "meeting",
    "plainsong",
    "until",
    "unless",
    "once",
    "after",
    "only",
    "maybe",
    "monthly",
    "visitors",
    "everyone",
    "nobody",
];

pub(super) fn is_subject(token: &Tok) -> bool {
    if matches!(token.lower.as_str(), "we" | "i") {
        return true;
    }
    let mut chars = token.text.chars();
    chars.next().is_some_and(char::is_uppercase)
        && token.text.chars().all(char::is_alphabetic)
        && token.text.chars().count() >= 2
        && !NOT_SUBJECTS.contains(&token.lower.as_str())
        && !WEEKDAYS.contains(&token.lower.as_str())
        && !MONTHS.contains(&token.lower.as_str())
}

/// The modal after a subject: (kind, negated, first predicate token).
fn modal_at(tokens: &[&Tok], at: usize, subject_we: bool) -> Option<(FrameKind, bool, usize)> {
    let word = |k: usize| tokens.get(k).map(|token| token.lower.as_str());
    let mut k = at;
    let mut kind = None;
    let mut negated = false;
    match word(k)? {
        "will" => {
            k += 1;
            if word(k) == Some("not") {
                negated = true;
                k += 1;
            }
            kind = Some(FrameKind::Commitment);
        }
        "have" | "has" if matches!(word(k + 1), Some("agreed" | "decided")) => k += 1,
        "are" | "is" | "am" if word(k + 1) == Some("going") && word(k + 2) == Some("to") => {
            k += 3;
            kind = Some(FrameKind::Commitment);
        }
        // "I'm not going to book the coach until ...".
        "are" | "is" | "am"
            if word(k + 1) == Some("not")
                && word(k + 2) == Some("going")
                && word(k + 3) == Some("to") =>
        {
            k += 4;
            negated = true;
            kind = Some(FrameKind::Commitment);
        }
        // "We are not expanding it" states a plan. It is checked, never copied.
        "are" | "is" | "am" => {
            let negative = word(k + 1) == Some("not");
            let verb = k + 1 + usize::from(negative);
            if word(verb).is_some_and(|w| w.len() > 5 && w.ends_with("ing") && w != "going") {
                negated = negative;
                k = verb;
                kind = Some(FrameKind::Commitment);
            }
        }
        "must" => {
            k += 1;
            if word(k) == Some("not") {
                negated = true;
                k += 1;
            }
            kind = Some(FrameKind::Requirement);
        }
        // "I can confirm that X will" introduces X's commitment.
        "can" | "could" | "might" | "may"
            if word(k + 1) == Some("confirm") && word(k + 2) == Some("that") =>
        {
            return None;
        }
        "can" | "could" | "might" | "may" => {
            k += 1;
            if word(k) == Some("not") {
                negated = true;
                k += 1;
            }
            kind = Some(FrameKind::Possibility);
        }
        _ => {}
    }
    if kind.is_none() && matches!(word(k), Some("agreed" | "decided")) {
        k += 1;
        if word(k) == Some("not") {
            negated = true;
            k += 1;
        }
        if word(k) != Some("to") {
            return None;
        }
        k += 1;
        kind = Some(FrameKind::Agreement);
    }
    let kind = kind?;
    // "we agreed to / will review": a predicate never opens with a modal; the
    // row join crossed two clauses.
    if matches!(
        word(k),
        Some("will" | "would" | "must" | "can" | "could" | "should" | "shall" | "might")
    ) {
        return None;
    }
    if kind == FrameKind::Requirement && subject_we {
        return None;
    }
    if kind == FrameKind::Possibility
        && matches!(word(k), Some("you" | "we" | "i" | "they" | "he" | "she"))
    {
        return None;
    }
    while matches!(word(k), Some("also" | "then" | "now" | "definitely")) {
        k += 1;
    }
    // Possibility and uncertainty are not commitments.
    if matches!(
        word(k),
        Some("probably" | "maybe" | "possibly" | "try" | "be" | "have")
    ) {
        return None;
    }
    word(k).map(|_| (kind, negated, k))
}

/// A new clause: a pronoun or name followed by an auxiliary, outside a cue.
fn clause_boundary(tokens: &[&Tok], at: usize) -> bool {
    let Some(next) = tokens.get(at + 1) else {
        return false;
    };
    let pronoun = matches!(
        tokens[at].lower.as_str(),
        "we" | "i" | "they" | "he" | "she" | "it" | "there" | "this"
    );
    let subject = pronoun || is_subject(tokens[at]);
    subject
        && (matches!(
            next.lower.as_str(),
            "have"
                | "has"
                | "had"
                | "is"
                | "are"
                | "was"
                | "were"
                | "do"
                | "does"
                | "did"
                | "can"
                | "could"
                | "should"
                | "might"
                | "may"
                | "would"
                | "am"
                | "need"
                | "needs"
                | "think"
                | "said"
                | "told"
                | "asked"
                | "want"
                | "wants"
        ) || pronoun && matches!(next.lower.as_str(), "must" | "will"))
        && !(at > 0
            && (condition_cue(tokens, at - 1).is_some()
                || matches!(tokens[at - 1].lower.as_str(), "that" | "whether")))
}

fn reported_before(tokens: &[&Tok], subject: usize) -> bool {
    // "I can confirm that Rafe will cover ...": the speaker asserts it.
    let confirmed = subject >= 2
        && tokens[subject - 1].lower == "that"
        && matches!(tokens[subject - 2].lower.as_str(), "confirm" | "confirmed")
        && tokens[..subject - 2]
            .iter()
            .rev()
            .take(2)
            .any(|token| matches!(token.lower.as_str(), "i" | "we"));
    !confirmed
        && subject > 0
        && matches!(
            tokens[subject - 1].lower.as_str(),
            "said"
                | "says"
                | "told"
                | "asked"
                | "thinks"
                | "think"
                | "hopes"
                | "whether"
                | "that"
                | "if"
                | "unless"
                | "when"
                | "until"
                | "once"
                | "after"
                | "wonder"
                | "suggested"
        )
}

struct Sentence<'a> {
    tokens: Vec<&'a Tok>,
}

fn sentences(tokens: &[Tok]) -> Vec<Sentence<'_>> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    for token in tokens {
        current.push(token);
        if token.end {
            out.push(Sentence {
                tokens: std::mem::take(&mut current),
            });
        }
    }
    if !current.is_empty() {
        out.push(Sentence { tokens: current });
    }
    out
}

fn join(tokens: &[&Tok]) -> String {
    let mut out = String::new();
    for (index, token) in tokens.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&token.text);
        if token.comma && index + 1 < tokens.len() {
            out.push(',');
        }
    }
    out
}

fn trim_joiners<'a>(mut tokens: &'a [&'a Tok]) -> &'a [&'a Tok] {
    while let Some(last) = tokens.last() {
        if matches!(last.lower.as_str(), "and" | "but" | "or" | "then" | "while") {
            tokens = &tokens[..tokens.len() - 1];
        } else {
            break;
        }
    }
    tokens
}

/// A predicate's core words, its (date phrase, date key), its condition, and
/// whether another clause runs on after it without punctuation.
type PredicateParts<'a> = (
    Vec<&'a Tok>,
    Option<(String, String)>,
    Option<Vec<&'a Tok>>,
    bool,
);

/// Split a predicate into core, date and condition.
fn predicate_parts<'a>(predicate: &'a [&'a Tok]) -> PredicateParts<'a> {
    let cue = (0..predicate.len()).find(|at| condition_cue(predicate, *at).is_some());
    let (before, condition) = match cue {
        Some(at) => (&predicate[..at], Some(predicate[at..].to_vec())),
        None => (predicate, None),
    };
    let mut core = Vec::new();
    let mut date = None;
    let mut run_on = false;
    // Core length when the date phrase ended.
    let mut core_at_date: Option<usize> = None;
    let mut at = 0;
    while at < before.len() {
        let word = before[at].lower.as_str();
        // "for the 9th" schedules a day; "for Friday" too.
        let scheduled = word == "for"
            && date_at(before, at + 1).is_some_and(|(_, key)| {
                key.chars().all(|c| c.is_ascii_digit())
                    || WEEKDAYS.contains(&key.as_str())
                    || key.contains(' ')
            });
        // "starting Saturday" is the commitment's date.
        let starting = matches!(word, "starting" | "beginning" | "from" | "to")
            && date_at(before, at + 1)
                .is_some_and(|(_, key)| WEEKDAYS.contains(&key.as_str()) || key.contains(' '));
        if matches!(word, "by" | "on" | "before") || scheduled || starting {
            // "by the nineteenth wait, the twenty-first": an ordinal after
            // "by the" names a day whatever follows it.
            if let Some((end, key)) = date_at(before, at + 1).or_else(|| {
                (before.get(at + 1).is_some_and(|token| token.lower == "the"))
                    .then(|| rejected_date(before, at + 1))
                    .flatten()
            }) {
                if date.is_none() {
                    date = Some((join(&before[at..end]), key));
                    core_at_date = Some(core.len());
                }
                at = end;
                continue;
            }
        }
        if word == "not" && date_at(before, at + 1).is_some() {
            // "by Wednesday, not Monday" rejects the other date.
            at = date_at(before, at + 1).unwrap().0;
            continue;
        }
        // "the Friday rota" names a thing, not a deadline.
        let modifier = at > 0
            && matches!(
                before[at - 1].lower.as_str(),
                "the" | "a" | "an" | "our" | "my" | "your" | "their" | "his" | "her" | "its"
            );
        if date.is_none() && !modifier {
            if let Some((end, key)) = date_at(before, at).filter(|(_, key)| {
                WEEKDAYS.contains(&key.as_str())
                    || key.contains(' ')
                    || key.contains(':')
                    || matches!(key.as_str(), "today" | "tomorrow")
            }) {
                if at > 0 && matches!(before[at - 1].lower.as_str(), "this" | "next") {
                    date = Some((join(&before[at - 1..end]), key));
                    core.pop();
                } else {
                    date = Some((join(&before[at..end]), key));
                }
                core_at_date = Some(core.len());
                at = end;
                continue;
            }
        }
        // "update the seat count right now we use 48 seats": an object never
        // holds a subject pronoun; a run-on started the next clause.
        // So does a self-correction: "by the nineteenth wait, the 21st".
        let correction = in_sentence_correction(before, at);
        let pronoun = matches!(word, "we" | "i" | "they" | "he" | "she");
        if at > 0 && (pronoun || correction) {
            // "by Friday right now we use 48 seats": a run-on, not a
            // self-correction.
            run_on = pronoun && !correction && !before[at - 1].comma;
            if let Some(length) = core_at_date {
                core.truncate(length);
            }
            break;
        }
        core.push(before[at]);
        at += 1;
    }
    let kept = trim_joiners(&core).len();
    core.truncate(kept);
    (core, date, condition, run_on)
}

struct RawFrame {
    frame: SourceFrame,
    sentence: usize,
}

fn frames_in(
    tokens: &[Tok],
    lines: &[&TrustedLine],
    first_order: usize,
    first_unit: usize,
) -> Vec<SourceFrame> {
    let mut frames: Vec<RawFrame> = Vec::new();
    let sentences = sentences(tokens);
    let mut dangling: Vec<(usize, Vec<&Tok>, bool)> = Vec::new();
    for (s_index, sentence) in sentences.iter().enumerate() {
        let words = &sentence.tokens;
        if words.iter().any(|token| token.question) {
            continue;
        }
        let mut starts = Vec::new();
        for at in 0..words.len() {
            if !is_subject(words[at]) || reported_before(words, at) {
                continue;
            }
            let we = words[at].lower == "we";
            if let Some((kind, negated, predicate)) = modal_at(words, at + 1, we) {
                starts.push((at, at, kind, negated, predicate));
            }
        }
        // Requirements with a noun-phrase subject: "The data must stay ...".
        for at in 1..words.len() {
            if words[at].lower != "must" || starts.iter().any(|start| start.0 + 1 == at) {
                continue;
            }
            let begin = (0..at)
                .rev()
                .find(|k| words[*k].comma || matches!(words[*k].lower.as_str(), "and" | "but"))
                .map_or(0, |k| k + 1);
            let mut subject: Vec<_> = words[begin..at]
                .iter()
                .copied()
                .skip_while(|token| {
                    matches!(token.lower.as_str(), "the" | "and" | "but" | "yes" | "okay")
                })
                .collect();
            // In a run-on ("by March 7 the data must", "passes irrigation
            // must") the subject is a determiner and noun, or one noun.
            let mut begin = begin;
            if subject.len() > 3
                || subject
                    .first()
                    .is_some_and(|t| condition_cue(&subject, 0).is_some() || t.lower == "only")
            {
                let determiner = at >= 2
                    && matches!(
                        words[at - 2].lower.as_str(),
                        "the" | "a" | "an" | "our" | "this" | "that" | "all"
                    );
                let noun = !STOPWORDS.contains(&words[at - 1].lower.as_str())
                    && number_key(&words[at - 1].lower).is_none();
                if !noun {
                    continue;
                }
                begin = if determiner { at - 2 } else { at - 1 };
                subject = words[begin..at].to_vec();
            }
            if subject.is_empty()
                || subject.len() > 3
                || subject.iter().any(|token| {
                    matches!(
                        token.lower.as_str(),
                        "it" | "this" | "that" | "you" | "we" | "i" | "they"
                    )
                })
            {
                continue;
            }
            if let Some((kind, negated, predicate)) = modal_at(words, at, false) {
                let first = at - subject.len();
                starts.push((first, begin, kind, negated, predicate));
            }
        }
        starts.sort_by_key(|start| start.0);
        if starts.is_empty() {
            if let Some(lead) = leading_cue(words) {
                // "and if C." starts a clause whose commitment was cut off;
                // "But only if C." restricts the sentence before it.
                let conjunction = words[..lead]
                    .iter()
                    .any(|token| matches!(token.lower.as_str(), "and" | "but" | "so" | "then"))
                    && !(lead > 0 && words[lead - 1].lower == "but" && words[lead].lower == "only");
                dangling.push((s_index, words[lead..].to_vec(), conjunction));
            }
            // "It must show both billing options." constrains the previous task.
            if matches!(words.first().map(|t| t.lower.as_str()), Some("it" | "this"))
                && matches!(
                    words.get(1).map(|t| t.lower.as_str()),
                    Some("must" | "needs")
                )
            {
                if let Some(previous) = frames.last_mut().filter(|raw| raw.sentence + 1 == s_index)
                {
                    previous.frame.constraint = Some(join(words) + ".");
                    previous.frame.extra_units.push(first_unit + s_index);
                }
            }
            continue;
        }
        // Each predicate ends at the next commitment, at a comma followed by a
        // conjunction, or where another subject and auxiliary start a clause.
        let ends: Vec<(usize, bool)> = starts
            .iter()
            .enumerate()
            .map(|(index, &(_, _, _, _, predicate_at))| {
                let limit = starts
                    .get(index + 1)
                    .map_or(words.len(), |next| next.1.min(next.0).max(predicate_at));
                let mut end = (predicate_at + 1..limit)
                    .find(|k| {
                        words[*k - 1].comma
                            && matches!(words[*k].lower.as_str(), "and" | "but" | "while" | "then")
                            || clause_boundary(words, *k)
                    })
                    .unwrap_or(limit);
                let mut joined = end < limit;
                if end == limit && index + 1 < starts.len() {
                    if let Some(joiner) = (predicate_at + 1..limit)
                        .rev()
                        .find(|k| matches!(words[*k].lower.as_str(), "and" | "but"))
                    {
                        end = joiner;
                        joined = true;
                    }
                }
                (end, joined)
            })
            .collect();
        // "X if C we agreed to Y": with no conjunction after C, the condition
        // may close X or open Y.
        let unjoined: Vec<bool> = (0..starts.len())
            .map(|index| {
                let open = |i: usize| {
                    let (end, joined) = ends[i];
                    i + 1 < starts.len()
                        && !joined
                        && (starts[i].4..end).any(|k| condition_cue(words, k).is_some())
                };
                // "I'll review the report by June 13 irrigation must stay
                // off until the test passes": with no comma or conjunction
                // between the clauses, a reader cannot tell which one the
                // next clause's condition closes either.
                let run_on = |i: usize| {
                    let (end, joined) = ends[i];
                    i + 1 < starts.len()
                        && !joined
                        && end > 0
                        && !words[end - 1].comma
                        && (starts[i + 1].4..ends[i + 1].0)
                            .any(|k| condition_cue(words, k).is_some())
                };
                open(index) || index > 0 && open(index - 1) || run_on(index)
            })
            .collect();
        for (index, &(subject_at, region_start, kind, negated, predicate_at)) in
            starts.iter().enumerate()
        {
            let _ = region_start;
            let clause_end = ends[index].0;
            let lead_from = if index == 0 {
                0
            } else {
                ends[index - 1].0.min(subject_at)
            };
            let lead: Vec<&Tok> = words[lead_from..subject_at]
                .iter()
                .copied()
                .skip_while(|token| {
                    matches!(
                        token.lower.as_str(),
                        "yes"
                            | "okay"
                            | "and"
                            | "right"
                            | "sure"
                            | "correction"
                            | "actually"
                            | "but"
                            | "then"
                    )
                })
                .collect();
            let correction = words[..subject_at]
                .iter()
                .rev()
                .take(3)
                .any(|token| matches!(token.lower.as_str(), "correction" | "actually"));
            // Between clauses, a cue starts this clause's leading condition even
            // after an unrecognized label: "Meeting record, and if ...".
            let leading_condition = leading_cue(&lead).map(|at| lead[at..].to_vec());
            let predicate_end = clause_end.max(predicate_at);
            let predicate = trim_joiners(&words[predicate_at..predicate_end]);
            let (core, date, trailing, run_on) = predicate_parts(predicate);
            // "we agreed to / the 14": a predicate opens with its verb.
            if core.is_empty() || STOPWORDS.contains(&core[0].lower.as_str()) {
                continue;
            }
            let condition = trailing.or(leading_condition.clone());
            let heading_inside = core.iter().any(|token| token.colon)
                || condition
                    .as_ref()
                    .is_some_and(|condition| condition.iter().any(|token| token.colon));
            // A condition holding another modal joins two clauses; its scope
            // cannot be read from the words.
            let modal = |token: &&Tok| {
                matches!(
                    token.lower.as_str(),
                    "must" | "will" | "agreed" | "should" | "shall" | "can" | "could" | "decided"
                )
            };
            // So does one holding another clause: "Until the build is
            // approved, we haven't approved the build yet, so I won't ...".
            // "only if Cosima can find a hygienist": "can" or "could" right
            // after the condition's own subject is its verb, not a clause.
            let own_verb = |condition: &[&Tok], k: usize| {
                let skip = condition_cue(condition, 0).unwrap_or(1);
                matches!(condition[k].lower.as_str(), "can" | "could")
                    && k > skip
                    && k <= skip + 3
                    && !condition[skip..k]
                        .iter()
                        .any(|token| modal(token) || token.comma)
            };
            let tangled = condition.as_ref().is_some_and(|condition| {
                (1..condition.len()).any(|k| modal(&condition[k]) && !own_verb(condition, k))
                    || (2..condition.len()).any(|k| clause_boundary(condition, k))
            }) || core.iter().skip(1).any(modal);
            let subject_tokens: Vec<&Tok> = words[subject_at..]
                .iter()
                .copied()
                .take_while(|token| {
                    !matches!(
                        token.lower.as_str(),
                        "will"
                            | "must"
                            | "agreed"
                            | "decided"
                            | "have"
                            | "has"
                            | "are"
                            | "is"
                            | "am"
                    )
                })
                .collect();
            let subject = join(&subject_tokens);
            let first_person = words[subject_at].lower == "i";
            let line = &lines[words[subject_at].line];
            let owner = match (kind, words[subject_at].lower.as_str()) {
                (FrameKind::Requirement, _) => None,
                (_, "we") => None,
                (_, "i") => line.speaker_name.clone(),
                _ => Some(subject.clone()),
            };
            let verb = lemma(&core[0].lower);
            let objects: HashSet<String> = content(&core[1..]).into_iter().collect();
            let mut objects = objects;
            if kind == FrameKind::Requirement {
                objects.extend(content(&subject_tokens));
            }
            let complete =
                predicate_end < words.len() || words.last().is_some_and(|token| token.end);
            let mut line_ids: Vec<String> = Vec::new();
            for token in words[lead_from.min(subject_at)..predicate_end].iter() {
                let id = &lines[token.line].line_id;
                if !line_ids.contains(id) {
                    line_ids.push(id.clone());
                }
            }
            let condition_key: Vec<String> = condition
                .as_ref()
                .map(|condition| {
                    let skip = condition_cue(condition, 0).unwrap_or(0);
                    content(&condition[skip..])
                })
                .unwrap_or_default()
                .into_iter()
                .filter(|word| !DISCOURSE.contains(&word.as_str()))
                .collect();
            // A cue followed only by discourse words is a broken fragment.
            let broken = condition.is_some() && condition_key.is_empty();
            let condition = condition.filter(|_| !broken);
            let complete = complete && !broken;
            // "..., and it must show both billing options" constrains this task.
            let rest_end = starts
                .get(index + 1)
                .map_or(words.len(), |next| next.1.min(next.0));
            let rest: Vec<&Tok> = words[clause_end.min(rest_end)..rest_end]
                .iter()
                .copied()
                .skip_while(|token| matches!(token.lower.as_str(), "and" | "but" | "so"))
                .collect();
            let constraint = (rest.len() > 2
                && matches!(rest[0].lower.as_str(), "it" | "this")
                && matches!(rest[1].lower.as_str(), "must" | "needs"))
            .then(|| upper_first(&join(&rest)) + ".");
            frames.push(RawFrame {
                sentence: s_index,
                frame: SourceFrame {
                    kind,
                    subject,
                    owner,
                    negated,
                    core: join(&core),
                    date: date.as_ref().map(|(text, _)| text.clone()),
                    condition: condition.as_ref().map(|condition| join(condition)),
                    constraint,
                    recording_id: line.recording_id.clone(),
                    line_ids,
                    complete,
                    ambiguous: tangled
                        || run_on
                        || unjoined[index]
                        || index > 0 && leading_condition_of_sentence(words, &starts),
                    conflict: false,
                    verb,
                    objects,
                    date_key: date.map(|(_, key)| key),
                    condition_key,
                    correction,
                    first_person,
                    plan: matches!(
                        words.get(subject_at + 1).map(|t| t.lower.as_str()),
                        Some("are" | "is" | "am")
                    ) && core[0].lower.ends_with("ing"),
                    detached: false,
                    order: first_order + frames.len(),
                    unit: first_unit + s_index,
                    extra_units: Vec::new(),
                    retracted: false,
                    condition_unit: None,
                    heading_inside,
                    member_units: Vec::new(),
                },
            });
        }
    }
    // A detached condition sentence belongs to the only adjacent commitment
    // that has no condition of its own. Otherwise its scope is unknown.
    for (s_index, condition, conjunction) in dangling {
        let condition_unit = first_unit + s_index;
        let before: Vec<usize> = frames
            .iter()
            .enumerate()
            .filter(|(_, raw)| raw.sentence + 1 == s_index)
            .map(|(at, _)| at)
            .collect();
        let after: Vec<usize> = frames
            .iter()
            .enumerate()
            .filter(|(_, raw)| raw.sentence == s_index + 1)
            .map(|(at, _)| at)
            .take(1)
            .collect();
        // A detached condition holding another clause cannot be scoped.
        if (2..condition.len()).any(|k| clause_boundary(&condition, k)) {
            for at in before.iter().chain(&after) {
                frames[*at].frame.ambiguous = true;
            }
            continue;
        }
        let previous = before
            .last()
            .copied()
            .filter(|at| frames[*at].frame.condition.is_none() && !conjunction);
        let next = after
            .first()
            .copied()
            .filter(|at| frames[*at].frame.condition.is_none());
        match (previous, next) {
            // "I'll send it by Tuesday. After I rerun the checks." or a turn
            // opening "If the release is still planned. I'll notify support."
            (Some(at), None) | (None, Some(at)) => {
                let skip = condition_cue(&condition, 0).unwrap_or(0);
                let frame = &mut frames[at].frame;
                frame.condition_key = content(&condition[skip..]);
                frame.condition = Some(join(&condition));
                frame.detached = true;
                frame.extra_units.push(condition_unit);
                frame.condition_unit = Some(condition_unit);
                for token in &condition {
                    let id = &lines[token.line].line_id;
                    if !frame.line_ids.contains(id) {
                        frame.line_ids.push(id.clone());
                    }
                }
            }
            (Some(first), Some(second)) => {
                frames[first].frame.ambiguous = true;
                frames[second].frame.ambiguous = true;
            }
            (None, None) => {}
        }
    }
    frames.into_iter().map(|raw| raw.frame).collect()
}

/// Where a leading condition starts: at a cue that opens the lead or follows a
/// comma or conjunction, with no conjunction after it. In "agreed to ship
/// ... if the gate passes, and Priya will", the condition closes the earlier
/// words instead.
fn leading_cue(lead: &[&Tok]) -> Option<usize> {
    let at = (0..lead.len()).find(|at| condition_cue(lead, *at).is_some())?;
    let opens = at == 0
        || lead[at - 1].comma
        || matches!(
            lead[at - 1].lower.as_str(),
            "and" | "but" | "so" | "yes" | "okay" | "then"
        );
    // "by then" ends a condition; it joins nothing.
    let closes_earlier = lead[at..].iter().enumerate().any(|(k, token)| {
        matches!(token.lower.as_str(), "and" | "but" | "so")
            || token.lower == "then"
                && !(k > 0 && matches!(lead[at + k - 1].lower.as_str(), "by" | "until" | "since"))
    });
    (opens && !closes_earlier).then_some(at)
}

/// A leading condition before several commitments in one sentence.
fn leading_condition_of_sentence(
    words: &[&Tok],
    starts: &[(usize, usize, FrameKind, bool, usize)],
) -> bool {
    let first = starts.first().map_or(0, |start| start.0);
    let lead: Vec<&Tok> = words[..first]
        .iter()
        .copied()
        .skip_while(|token| {
            matches!(
                token.lower.as_str(),
                "yes" | "okay" | "and" | "right" | "sure"
            )
        })
        .collect();
    starts.len() > 1 && !lead.is_empty() && condition_cue(&lead, 0).is_some()
}

fn compatible_condition(first: &[String], second: &[String]) -> bool {
    let a: HashSet<_> = first.iter().collect();
    let b: HashSet<_> = second.iter().collect();
    a.is_subset(&b) || b.is_subset(&a)
}

fn same_identity(a: &SourceFrame, b: &SourceFrame) -> bool {
    let kind = |frame: &SourceFrame| match frame.kind {
        FrameKind::Requirement => 1,
        FrameKind::Possibility => 2,
        _ => 0,
    };
    a.recording_id == b.recording_id
        && kind(a) == kind(b)
        && a.negated == b.negated
        && same_lemma(&a.verb, &b.verb)
        && (a.objects.is_subset(&b.objects) || b.objects.is_subset(&a.objects))
        && !a.objects.is_empty()
        && !b.objects.is_empty()
        && match (&a.owner, &b.owner) {
            (None, None) => {
                a.first_person == b.first_person
                    && (a.kind != FrameKind::Requirement
                        || a.subject.eq_ignore_ascii_case(&b.subject)
                        || a.objects == b.objects)
            }
            (Some(x), Some(y)) => same_owner(x, y),
            _ => false,
        }
}

impl SourceFrame {
    /// "I will ..." whose speaker has no name: a person, not the group.
    pub(super) fn first_person_singular(&self) -> bool {
        self.first_person
    }

    /// The task verb's lemma: "book", "upload".
    pub(super) fn verb_lemma(&self) -> &str {
        &self.verb
    }

    /// The object is only a pronoun: "I'll upload it by Tuesday."
    pub(super) fn pronoun_object(&self) -> bool {
        self.objects.is_empty()
            && self.core.split_whitespace().nth(1).is_some_and(|word| {
                matches!(
                    word.to_lowercase()
                        .trim_matches(|ch: char| !ch.is_alphanumeric()),
                    "it" | "them" | "that" | "this"
                )
            })
    }

    /// A sentence names one of this clause's object words.
    pub(super) fn names_object(&self, text: &str) -> bool {
        let words = tokens(text, 0);
        let refs: Vec<&Tok> = words.iter().collect();
        content(&refs)
            .iter()
            .any(|word| self.objects.iter().any(|object| same_lemma(word, object)))
    }
}

pub(super) fn same_owner(first: &str, second: &str) -> bool {
    first.eq_ignore_ascii_case(second)
        || super::grounded::observed_owner_variant(first, second)
        || super::grounded::observed_owner_variant(second, first)
}

/// Consolidate clauses from every passage. Lines are in context order.
pub(super) fn source_frames(lines: &[TrustedLine]) -> Vec<SourceFrame> {
    parse_source(lines, false).0
}

/// One whole source sentence as an extractive recap shows it: fillers and
/// stutters removed, contractions and meaningful discourse words kept.
#[derive(Clone, Debug)]
pub(super) struct SourceUnit {
    pub text: String,
    pub speaker: Option<String>,
    pub written_note: bool,
    pub recording_id: String,
    pub line_ids: Vec<String>,
    pub start_time: f64,
    pub question: bool,
    /// Lowercase parsed words, for repeat detection.
    pub words: Vec<String>,
    /// The sentence withdraws or corrects what came before it.
    pub revises: bool,
    /// Passage index, so sentences of one turn stay together.
    pub chain: usize,
}

/// Frames and the whole sentences they came from. Unlike [`source_frames`],
/// a retraction withdraws only the clauses it follows or names, because the
/// sentences themselves are shown and the retraction is shown with them.
pub(super) fn source_frames_and_units(
    lines: &[TrustedLine],
) -> (Vec<SourceFrame>, Vec<SourceUnit>) {
    parse_source(lines, true)
}

fn parse_source(lines: &[TrustedLine], extractive: bool) -> (Vec<SourceFrame>, Vec<SourceUnit>) {
    let retracted: HashSet<&str> = lines
        .iter()
        .filter(|line| !extractive && retracts(&line.text))
        .map(|line| line.recording_id.as_str())
        .collect();
    let labels = label_patterns(lines, extractive);
    let skip: Vec<bool> = lines
        .iter()
        .map(|line| line.written_note || retracted.contains(line.recording_id.as_str()))
        .collect();
    let headings = super::source_claims::strong_headings(lines);
    let mut raw = Vec::new();
    let mut corrections = Vec::new();
    let mut units: Vec<SourceUnit> = Vec::new();
    let mut unit_tokens: Vec<Vec<Tok>> = Vec::new();
    for (chain_index, chain) in passage_chains(lines, &skip).into_iter().enumerate() {
        let chained: Vec<&TrustedLine> = chain.iter().map(|at| &lines[*at]).collect();
        let mut tokens = Vec::new();
        for (index, line) in chained.iter().enumerate() {
            tokens.extend(self::tokens(&without_labels(&line.text, &labels), index));
        }
        let mut tokens = without_disfluencies(tokens);
        cut_headings(&mut tokens, &headings, extractive);
        let first_unit = units.len();
        if extractive {
            let parsed = sentences(&tokens);
            let count = parsed.len();
            for (index, sentence) in parsed.into_iter().enumerate() {
                let words = &sentence.tokens;
                let first = &chained[words[0].line];
                // Unpunctuated speech is common; only a sentence that stops
                // on a word that needs more after it was cut off.
                let complete = index + 1 < count
                    || words.last().is_some_and(|token| {
                        token.end || !DANGLING.contains(&token.lower.as_str())
                    });
                let mut line_ids: Vec<String> = Vec::new();
                for token in words {
                    let id = &chained[token.line].line_id;
                    if !line_ids.contains(id) {
                        line_ids.push(id.clone());
                    }
                }
                units.push(SourceUnit {
                    text: display_sentence(words, complete),
                    speaker: first.speaker_name.clone(),
                    written_note: false,
                    recording_id: first.recording_id.clone(),
                    line_ids,
                    start_time: first.start_time,
                    question: words.iter().any(|token| token.question),
                    words: words.iter().map(|token| token.lower.clone()).collect(),
                    revises: revises(words),
                    chain: chain_index,
                });
                unit_tokens.push(words.iter().map(|token| (*token).clone()).collect());
            }
        }
        raw.extend(frames_in(&tokens, &chained, raw.len(), first_unit));
        corrections.extend(date_corrections(&tokens, &chained, raw.len(), first_unit));
    }
    let mut frames = consolidate(raw);
    apply_date_corrections(&mut frames, &corrections);
    if extractive {
        withdraw_retracted(&mut frames, &units, &unit_tokens);
        // Written notes are the user's own words: shown, never parsed.
        let chains = units.last().map_or(0, |unit| unit.chain + 1);
        for (offset, line) in lines.iter().filter(|line| line.written_note).enumerate() {
            let words = self::tokens(&line.text, 0);
            let refs: Vec<&Tok> = words.iter().collect();
            if refs.is_empty() {
                continue;
            }
            units.push(SourceUnit {
                text: display_sentence(&refs, true),
                speaker: None,
                written_note: true,
                recording_id: line.recording_id.clone(),
                line_ids: vec![line.line_id.clone()],
                start_time: line.start_time,
                question: refs.iter().any(|token| token.question),
                words: refs.iter().map(|token| token.lower.clone()).collect(),
                revises: false,
                chain: chains + offset,
            });
        }
    }
    (frames, units)
}

/// Words a finished sentence does not end on.
const DANGLING: &[&str] = &[
    "the", "a", "an", "to", "of", "and", "or", "but", "by", "at", "for", "with", "if", "unless",
    "until", "once", "because", "our", "my", "your", "their", "than",
];

/// Capture labels removed before parsing: labels that repeat across the
/// meeting. Shown sentences (`extractive`) lose a label only where it opens a
/// statement: a label detected from ordinary words ("the beta on the") must
/// never be cut from inside a sentence. Group 1 is what stays before it.
pub(super) fn label_patterns(lines: &[TrustedLine], extractive: bool) -> Vec<regex::Regex> {
    super::summary_verification::source_labels(&lines.iter().collect::<Vec<_>>())
        .iter()
        .filter(|label| {
            // A capture label repeats; a split-row fragment does not.
            let needle = label.to_lowercase();
            lines
                .iter()
                .map(|line| line.text.to_lowercase().matches(needle.as_str()).count())
                .sum::<usize>()
                >= 2
        })
        .filter_map(|label| {
            // ", and <label>" opens a statement too.
            let opening = if extractive {
                r"(^\s*|[.!?;:,]\s*|,\s*(?:and|but)\s+)"
            } else {
                "()"
            };
            regex::Regex::new(&format!(
                r"(?i){opening}\b{}\b[,.:;]?",
                regex::escape(label)
            ))
            .ok()
        })
        .collect()
}

/// A sentence that withdraws or corrects what was just said.
fn revises(words: &[&Tok]) -> bool {
    let text = words
        .iter()
        .map(|token| token.lower.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let opening = words.first().map(|token| token.lower.as_str());
    retracts(&text)
        || matches!(
            opening,
            Some("correction" | "actually" | "sorry" | "wait" | "no" | "instead")
        )
        || text.starts_with("make that")
        || text.starts_with("i mean")
        || text.starts_with("not ")
        || words
            .iter()
            .any(|token| matches!(token.lower.as_str(), "correction" | "instead"))
}

/// A clause is withdrawn by a later retraction in the same recording that
/// follows it within two sentences or names its verb and object.
fn withdraw_retracted(frames: &mut [SourceFrame], units: &[SourceUnit], unit_tokens: &[Vec<Tok>]) {
    for (at, unit) in units.iter().enumerate() {
        let text = unit.words.join(" ");
        if !retracts(&text) {
            continue;
        }
        let refs: Vec<&Tok> = unit_tokens[at].iter().collect();
        for frame in frames.iter_mut() {
            if frame.recording_id != unit.recording_id || frame.unit >= at {
                continue;
            }
            let near = at - frame.unit <= 2 && units[frame.unit].chain + 1 >= unit.chain;
            if near || mentioned_at(frame, &refs).is_some() {
                frame.retracted = true;
                if !frame.extra_units.contains(&at) {
                    frame.extra_units.push(at);
                }
            }
        }
    }
}

/// Parsed words back as a readable sentence. Only display changes: the
/// first letter is capitalised, end punctuation is normalised, contractions
/// are shown as spoken and meaningful discourse words return.
pub(super) fn display_sentence(words: &[&Tok], complete: bool) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < words.len() {
        let token = words[at];
        let pair = token.whole.is_some()
            && words
                .get(at + 1)
                .is_some_and(|next| next.joined && next.line == token.line);
        let last = if pair { at + 1 } else { at };
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(if pair {
            token.whole.as_deref().unwrap_or(&token.text)
        } else {
            &token.text
        });
        if last + 1 < words.len() {
            if words[last].colon {
                out.push(':');
            } else if words[last].comma {
                out.push(',');
            }
        }
        for restored in words[at..=last].iter().flat_map(|token| &token.restored) {
            out.push(' ');
            out.push_str(restored);
        }
        at = last + 1;
    }
    while out.ends_with([',', ':']) {
        out.pop();
    }
    let ending = words.last().copied();
    // A sentence stopped on "and" or "the" was cut off, whatever
    // punctuation the recorder or a removed heading left after it.
    let dangling = ending.is_some_and(|token| DANGLING.contains(&token.lower.as_str()));
    if ending.is_some_and(|token| token.question) {
        out.push('?');
    } else if complete && !dangling {
        out.push('.');
    } else {
        out.push('…');
    }
    upper_first(&out)
}

/// "Scratch that" or "never mind, cancel that" withdraws what was said; a
/// task verb ("once we cancel Dexter") does not.
fn retracts(text: &str) -> bool {
    static RETRACTION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(?:retract|scratch that|never mind|cancel (?:that|this|it)\b|forget (?:that|it)\b|no longer)\b",
        )
        .unwrap()
    });
    RETRACTION.is_match(text)
}

/// Remove spoken headings before parsing. A heading ends whatever came
/// before it, so a run-on cannot carry a condition across it. A one-word
/// heading is removed only where it keeps its colon. For shown sentences
/// (`opening_only`), a heading is removed only where it opens a statement,
/// so no words are cut from inside a sentence.
fn cut_headings(tokens: &mut Vec<Tok>, headings: &[(Vec<String>, bool)], opening_only: bool) {
    let mut at = 0;
    while at < tokens.len() {
        let opens = at == 0 || tokens[at - 1].end || tokens[at - 1].comma;
        let found = headings.iter().find(|(phrase, single)| {
            (opens || !opening_only)
                && at + phrase.len() <= tokens.len()
                && phrase
                    .iter()
                    .enumerate()
                    .all(|(k, word)| tokens[at + k].lower == *word)
                && (!single || tokens[at].colon)
        });
        match found {
            Some((phrase, _)) => {
                if at > 0 {
                    tokens[at - 1].end = true;
                }
                tokens.drain(at..at + phrase.len());
            }
            None => at += 1,
        }
    }
}

/// "Correction: Thursday, not Tuesday.", "Lior submits the report on
/// Thursday, not Tuesday." or "Kofi orders the chairs by the 16th instead":
/// a sentence that replaces a commitment's date.
struct DateCorrection {
    recording_id: String,
    /// `None` for a correction that names only the new date ("instead").
    rejected: Option<String>,
    corrected: String,
    corrected_text: String,
    /// The new date follows the correction cue ("make it the 19th").
    cued: bool,
    /// Frames parsed before this position precede the correction.
    after: usize,
    words: Vec<Tok>,
    line_ids: Vec<String>,
    /// The source sentences that state the correction.
    units: Vec<usize>,
}

/// A rejected date after "not": "not Tuesday", "not the 9th", and "not the
/// ninth Aksel", where an ordinal names a day whatever follows it.
fn rejected_date(words: &[&Tok], at: usize) -> Option<(usize, String)> {
    if let Some(found) = date_at(words, at) {
        return Some(found);
    }
    let day = if words.get(at).is_some_and(|token| token.lower == "the") {
        at + 1
    } else {
        at
    };
    let token = words.get(day)?;
    // "by the 16 instead", "not the 9": a bare day after "the" and a date
    // preposition or "not".
    let bare_day = day == at + 1
        && at > 0
        && matches!(
            words[at - 1].lower.as_str(),
            "by" | "on" | "before" | "until" | "for" | "not"
        )
        && (token.lower.chars().all(|c| c.is_ascii_digit())
            || CARDINALS.contains(&token.lower.as_str())
            || token.lower.starts_with("twenty-")
            || token.lower.starts_with("thirty-"))
        && number_key(&token.lower)
            .and_then(|day| day.parse::<u32>().ok())
            .is_some_and(|day| (1..=31).contains(&day));
    let ordinal = bare_day
        || ORDINALS.contains(&token.lower.as_str())
        || ["st", "nd", "rd", "th"].iter().any(|suffix| {
            token.lower.strip_suffix(suffix).is_some_and(|digits| {
                !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
            })
        });
    let key = number_key(&token.lower).filter(|_| ordinal)?;
    Some((day + 1, key))
}

fn date_corrections(
    tokens: &[Tok],
    lines: &[&TrustedLine],
    after: usize,
    first_unit: usize,
) -> Vec<DateCorrection> {
    let mut out = Vec::new();
    let all = sentences(tokens);
    for (index, sentence) in all.iter().enumerate() {
        // "... by the 8th. Not the 9th, Aksel.": the rejection opens its own
        // sentence; the previous sentence names the new date and the task.
        let opens_with_not = sentence
            .tokens
            .first()
            .is_some_and(|token| token.lower == "not");
        let joined: Vec<&Tok>;
        let words = if opens_with_not && index > 0 {
            joined = all[index - 1]
                .tokens
                .iter()
                .chain(&sentence.tokens)
                .copied()
                .collect();
            &joined
        } else {
            &sentence.tokens
        };
        let rejected: Vec<(usize, String)> = (1..words.len())
            .filter(|at| words[*at - 1].lower == "not")
            .filter(|at| !opens_with_not || *at >= words.len() - sentence.tokens.len())
            .filter_map(|at| rejected_date(words, at).map(|(_, key)| (at, key)))
            .collect();
        // "One correction ... Kofi orders the chairs by the 16th instead."
        let cue_at = (0..words.len()).rev().find(|at| {
            matches!(
                words[*at].lower.as_str(),
                "correction" | "instead" | "correct"
            ) || in_sentence_correction(words, *at)
                || words[*at].lower == "mean" && *at > 0 && words[at - 1].lower == "i"
        });
        let cue = cue_at.is_some();
        let (rejected_at, rejected) = match rejected.as_slice() {
            [(at, key)] => (Some(*at), Some(key.clone())),
            [] if cue => (None, None),
            _ => continue,
        };
        let mut corrected = None;
        let mut at = 0;
        while at < words.len() {
            if Some(at) == rejected_at {
                at = rejected_date(words, at).map_or(at + 1, |(end, _)| end);
                continue;
            }
            // Only a weekday, month day or "the 9th" names a date here.
            let preposition = at > 0
                && matches!(
                    words[at - 1].lower.as_str(),
                    "on" | "by" | "for" | "before" | "to" | "until" | "correction"
                );
            // "the sixth form added a class": an ordinal before a noun names
            // a thing, not a day.
            let names_thing = date_at(words, at).is_none()
                && rejected_date(words, at).is_some_and(|(end, _)| {
                    words.get(end).is_some_and(|next| {
                        !STOPWORDS.contains(&next.lower.as_str())
                            && !matches!(
                                next.lower.as_str(),
                                "instead" | "please" | "works" | "latest" | "again" | "too"
                            )
                            && !words[end - 1].comma
                            && !words[end - 1].end
                    })
                });
            match rejected_date(words, at) {
                Some((end, key))
                    if !names_thing
                        && (WEEKDAYS.contains(&key.as_str())
                            || key.contains(' ')
                            || preposition
                            || words[at].lower == "the")
                        && Some(&key) != rejected.as_ref() =>
                {
                    // After a cue ("make that Friday, because the van is in
                    // the shop on Thursday"), the first later date is the
                    // new one; elsewhere a second date leaves it unclear.
                    // A restored "I mean" marks the new date's own first word.
                    let after_cue = cue_at.is_some_and(|cue| at >= cue);
                    match &corrected {
                        Some((_, _, true)) => {}
                        Some(_) if after_cue => {
                            corrected = Some((key, join(&words[at..end]), true))
                        }
                        Some(_) => {
                            corrected = None;
                            break;
                        }
                        None => corrected = Some((key, join(&words[at..end]), after_cue)),
                    }
                    at = end;
                }
                _ => at += 1,
            }
        }
        let mut units = Vec::new();
        if opens_with_not && index > 0 {
            units.push(first_unit + index - 1);
        }
        units.push(first_unit + index);
        let same_sentence = corrected.is_some();
        // "Wait, not the 19th. The 21st.": the new date is the next sentence.
        let corrected = corrected.or_else(|| {
            rejected.as_ref()?;
            let next = all.get(index + 1)?;
            let words = &next.tokens;
            let start = usize::from(
                words
                    .first()
                    .is_some_and(|token| matches!(token.lower.as_str(), "so" | "make" | "it")),
            );
            let (end, key) = rejected_date(words, start)?;
            (end + 1 >= words.len() && Some(&key) != rejected.as_ref())
                .then(|| (key, join(&words[start..end]), true))
        });
        if !same_sentence {
            units.push(first_unit + index + 1);
        }
        if let Some((key, text, cued)) = corrected {
            let mut line_ids: Vec<String> = Vec::new();
            for token in words {
                let id = &lines[token.line].line_id;
                if !line_ids.contains(id) {
                    line_ids.push(id.clone());
                }
            }
            out.push(DateCorrection {
                recording_id: lines[0].recording_id.clone(),
                rejected,
                corrected: key,
                corrected_text: text,
                cued,
                after,
                words: words.iter().map(|token| (*token).clone()).collect(),
                line_ids,
                units,
            });
        }
    }
    out
}

/// Move a commitment to its corrected date. A correction that names a
/// commitment's verb or object applies to that commitment; one that rejects
/// a date and names none applies to the only earlier commitment with that
/// date. A correction that fits several commitments makes them conflicting,
/// and the new date is cited from the correction's own rows.
fn apply_date_corrections(frames: &mut [SourceFrame], corrections: &[DateCorrection]) {
    for correction in corrections {
        let refs: Vec<&Tok> = correction.words.iter().collect();
        let candidates: Vec<usize> = (0..frames.len())
            .filter(|at| {
                let frame = &frames[*at];
                frame.recording_id == correction.recording_id
                    && frame.order < correction.after
                    && match &correction.rejected {
                        Some(rejected) => frame
                            .date_key
                            .as_ref()
                            .is_some_and(|date| same_date(date, rejected)),
                        None => frame
                            .date_key
                            .as_ref()
                            .is_some_and(|date| !same_date(date, &correction.corrected)),
                    }
            })
            .collect();
        // "Let me correct that: ... so we send it on the 11th": the verb with
        // a pronoun object names the commitment too.
        let pronoun = refs
            .iter()
            .any(|token| matches!(token.lower.as_str(), "it" | "that" | "them" | "this"));
        let named: Vec<usize> = candidates
            .iter()
            .copied()
            .filter(|at| {
                mentioned_at(&frames[*at], &refs).is_some()
                    || pronoun
                        && refs
                            .iter()
                            .any(|token| same_lemma(&lemma(&token.lower), &frames[*at].verb))
            })
            .collect();
        let target = match (named.as_slice(), candidates.as_slice()) {
            ([one], _) => Some(*one),
            ([], [one]) if correction.rejected.is_some() => Some(*one),
            // "Actually, make that Friday": a self-correction in the same
            // turn applies to that turn's latest earlier commitment. Another
            // speaker's ("Lorcan will send the trailer by the 12th." /
            // "Sorry, make it the 19th.") applies to the commitment in the
            // sentence just before it.
            ([], _) if correction.rejected.is_none() => candidates
                .iter()
                .copied()
                .filter(|at| {
                    frames[*at]
                        .line_ids
                        .iter()
                        .any(|id| correction.line_ids.contains(id))
                })
                .max_by_key(|at| frames[*at].order)
                .or_else(|| {
                    // Only a correction naming its new date after the cue,
                    // in a sentence with no commitment of its own.
                    let own = frames
                        .iter()
                        .any(|frame| correction.units.contains(&frame.unit));
                    if !correction.cued || own {
                        return None;
                    }
                    let adjacent: Vec<usize> = candidates
                        .iter()
                        .copied()
                        .filter(|at| {
                            correction
                                .units
                                .first()
                                .is_some_and(|first| frames[*at].unit + 1 == *first)
                        })
                        .collect();
                    match adjacent.as_slice() {
                        [one] => Some(*one),
                        _ => None,
                    }
                }),
            ([], []) => None,
            _ => {
                let fitting = if named.is_empty() {
                    &candidates
                } else {
                    &named
                };
                for at in fitting {
                    frames[*at].conflict = true;
                }
                None
            }
        };
        if let Some(at) = target {
            let frame = &mut frames[at];
            let preposition = frame
                .date
                .as_deref()
                .and_then(|date| date.split_whitespace().next())
                .filter(|word| {
                    matches!(word.to_lowercase().as_str(), "on" | "by" | "for" | "before")
                })
                .map(str::to_string);
            let text = correction.corrected_text.trim().to_string();
            frame.date = Some(match preposition {
                Some(word) => format!("{word} {text}"),
                None => text,
            });
            frame.date_key = Some(correction.corrected.clone());
            frame.correction = true;
            for unit in &correction.units {
                if *unit != frame.unit && !frame.extra_units.contains(unit) {
                    frame.extra_units.push(*unit);
                }
            }
            for id in &correction.line_ids {
                if !frame.line_ids.contains(id) {
                    frame.line_ids.push(id.clone());
                }
            }
        }
    }
}

/// Passages in context order, rejoined where the recorder split a sentence:
/// the same speaker's next passage within two seconds continues an
/// unterminated one. Skipped lines start no chain and continue none.
pub(super) fn passage_chains(lines: &[TrustedLine], skip: &[bool]) -> Vec<Vec<usize>> {
    let mut chains = Vec::new();
    let mut used = skip.to_vec();
    for start in 0..lines.len() {
        if used[start] {
            continue;
        }
        let mut chain = vec![start];
        let mut current = start;
        loop {
            // A finished row continues only into the same speaker's row that
            // opens with a condition: "... by the 27th." + "After Benedikt has
            // checked them."
            let finished = lines[current].text.trim_end().ends_with(['.', '!', '?']);
            let next = (current + 1..lines.len()).find(|at| {
                !used[*at]
                    && !backchannel(&lines[*at].text)
                    && lines[*at].recording_id == lines[current].recording_id
                    && lines[*at].speaker_id == lines[current].speaker_id
                    && lines[*at].speaker_name == lines[current].speaker_name
            });
            // A passage that restarts with the same words repeats the clause;
            // it does not continue it.
            let opening = |text: &str| {
                cleaned_text(text)
                    .split_whitespace()
                    .take(3)
                    .map(|word| {
                        word.trim_matches(|c: char| !c.is_alphanumeric())
                            .to_lowercase()
                    })
                    .collect::<Vec<_>>()
            };
            let restart =
                next.is_some_and(|at| opening(&lines[at].text) == opening(&lines[current].text));
            let condition_row = next.is_some_and(|at| {
                let words = tokens(&lines[at].text, 0);
                let refs: Vec<&Tok> = words.iter().collect();
                // "But only if Cosima can find a hygienist." restricts it too.
                let skip = usize::from(
                    refs.len() > 2 && refs[0].lower == "but" && refs[1].lower == "only",
                );
                refs.len() > skip && condition_cue(&refs, skip).is_some()
            });
            if finished && !condition_row {
                break;
            }
            match next {
                Some(at)
                    if !restart
                        && lines[at].start_time - lines[current].end_time <= 2.0
                        && lines[at].start_time >= lines[current].end_time - 0.05 =>
                {
                    chain.push(at);
                    current = at;
                }
                _ => break,
            }
        }
        for at in &chain {
            used[*at] = true;
        }
        chains.push(chain);
    }
    chains
}

pub(super) fn backchannel(text: &str) -> bool {
    text.split_whitespace().all(|word| {
        matches!(
            word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
                .to_lowercase()
                .as_str(),
            "mm-hmm" | "mm" | "mhm" | "uh-huh" | "right" | "okay" | "yeah" | "yes" | "sure" | "hmm"
        )
    })
}

fn without_labels(text: &str, labels: &[regex::Regex]) -> String {
    let mut text = text.to_string();
    for label in labels {
        text = label.replace_all(&text, "${1} ").into_owned();
    }
    text
}

fn consolidate(mut raw: Vec<SourceFrame>) -> Vec<SourceFrame> {
    // A detached condition that repeats another commitment's own condition is
    // more likely an echo of that clause than a second condition.
    let attached: Vec<(usize, Vec<String>)> = raw
        .iter()
        .enumerate()
        .filter(|(_, frame)| !frame.detached && !frame.condition_key.is_empty())
        .map(|(at, frame)| (at, frame.condition_key.clone()))
        .collect();
    for at in 0..raw.len() {
        if raw[at].detached
            && attached.iter().any(|(other, key)| {
                !same_identity(&raw[*other], &raw[at])
                    && compatible_condition(key, &raw[at].condition_key)
            })
        {
            raw[at].ambiguous = true;
        }
    }
    let mut groups: Vec<Vec<SourceFrame>> = Vec::new();
    for frame in raw {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.iter().any(|member| same_identity(member, &frame)))
        {
            group.push(frame);
        } else {
            groups.push(vec![frame]);
        }
    }
    let mut out = Vec::new();
    for group in groups {
        let solid = group
            .iter()
            .any(|frame| frame.complete && !frame.ambiguous && !frame.detached);
        let complete: Vec<&SourceFrame> = group
            .iter()
            .filter(|frame| frame.complete && !frame.ambiguous && !(solid && frame.detached))
            .collect();
        let pool: Vec<&SourceFrame> = if complete.is_empty() {
            group.iter().collect()
        } else {
            complete.clone()
        };
        let mut conflict = false;
        // Compatible conditions differ only by truncation or run-on words;
        // the most repeated wording represents them. Others conflict.
        let mut conditions: Vec<Vec<(&Vec<String>, usize)>> = Vec::new();
        for frame in &pool {
            if frame.condition_key.is_empty() {
                continue;
            }
            let cluster = conditions.iter_mut().find(|cluster| {
                cluster
                    .iter()
                    .any(|(known, _)| compatible_condition(known, &frame.condition_key))
            });
            match cluster {
                Some(cluster) => match cluster
                    .iter_mut()
                    .find(|(known, _)| **known == frame.condition_key)
                {
                    Some(entry) => entry.1 += 1,
                    None => cluster.push((&frame.condition_key, 1)),
                },
                None => conditions.push(vec![(&frame.condition_key, 1)]),
            }
        }
        // A lone garbled repeat among many clean ones is noise, not a second
        // condition: a rival needs two occurrences and a third of the total.
        let total: usize = conditions.iter().flatten().map(|(_, count)| count).sum();
        conditions.sort_by_key(|cluster| {
            std::cmp::Reverse(cluster.iter().map(|(_, c)| c).sum::<usize>())
        });
        conflict |= conditions.iter().skip(1).any(|cluster| {
            let count: usize = cluster.iter().map(|(_, c)| c).sum();
            count >= 2 && count * 3 >= total || total < 3
        });
        let conditions: Vec<&Vec<String>> = conditions
            .iter()
            .map(|cluster| {
                cluster
                    .iter()
                    .max_by_key(|(key, count)| (*count, usize::MAX - key.len()))
                    .unwrap()
                    .0
            })
            .collect();
        let corrected = pool
            .iter()
            .filter(|frame| frame.correction && frame.date_key.is_some())
            .max_by_key(|frame| frame.order);
        let mut dates: Vec<(&String, usize)> = Vec::new();
        for date in pool.iter().filter_map(|frame| frame.date_key.as_ref()) {
            match dates.iter_mut().find(|(known, _)| same_date(known, date)) {
                // The fuller form names the day: "october 9", not "9".
                Some(entry) => {
                    entry.1 += 1;
                    if date.len() > entry.0.len() {
                        entry.0 = date;
                    }
                }
                None => dates.push((date, 1)),
            }
        }
        dates.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        let total: usize = dates.iter().map(|(_, count)| count).sum();
        let date_key = match corrected {
            Some(frame) => frame.date_key.clone(),
            None if dates
                .iter()
                .skip(1)
                .any(|(_, count)| *count >= 2 && count * 3 >= total || total < 3) =>
            {
                conflict = true;
                None
            }
            None => dates.first().map(|(date, _)| (*date).clone()),
        };
        let condition_key = conditions
            .first()
            .map(|key| (*key).clone())
            .unwrap_or_default();
        // The representative clause states the consolidated fields itself.
        let best = pool
            .iter()
            .filter(|frame| {
                let dated = match (&frame.date_key, &date_key) {
                    (Some(first), Some(second)) => same_date(first, second),
                    (first, second) => first == second,
                };
                dated && (condition_key.is_empty() || frame.condition_key == condition_key)
            })
            .max_by_key(|frame| {
                // The most repeated wording; run-on copies are rarer.
                let core = frame.core.to_lowercase();
                let repeats = pool
                    .iter()
                    .filter(|other| other.core.to_lowercase() == core)
                    .count();
                (
                    frame
                        .owner
                        .as_ref()
                        .is_some_and(|owner| owner.chars().skip(1).any(char::is_lowercase)),
                    repeats,
                    frame.constraint.is_some(),
                    usize::MAX - frame.core.len(),
                    usize::MAX - frame.order,
                )
            })
            .copied()
            .or_else(|| pool.first().copied())
            .unwrap();
        let mut frame = best.clone();
        frame.conflict = conflict;
        frame.ambiguous = group.iter().all(|member| member.ambiguous);
        frame.complete = !complete.is_empty() && best.complete;
        frame.date_key = date_key;
        frame.condition_key = condition_key;
        if frame
            .owner
            .as_ref()
            .is_some_and(|owner| owner.chars().all(|ch| ch.is_uppercase()))
        {
            let canonical: HashSet<&String> = group
                .iter()
                .filter_map(|member| member.owner.as_ref())
                .filter(|owner| owner.chars().skip(1).any(char::is_lowercase))
                .collect();
            if let [only] = canonical.into_iter().collect::<Vec<_>>().as_slice() {
                frame.owner = Some((*only).clone());
            }
        }
        for member in group.iter().filter(|member| member.complete) {
            for id in &member.line_ids {
                if !frame.line_ids.contains(id) {
                    frame.line_ids.push(id.clone());
                }
            }
            if !member.ambiguous && !frame.member_units.contains(&member.unit) {
                frame.member_units.push(member.unit);
            }
        }
        frame.member_units.sort_unstable();
        out.push(frame);
    }
    out
}

// ---------------------------------------------------------------- claims

struct ClaimClause<'a> {
    scope: Vec<&'a Tok>,
    condition: Vec<&'a Tok>,
    cue: bool,
    strong_cue: bool,
}

pub(super) const FORWARD_CUES: &[&str] = &[
    "if",
    "unless",
    "until",
    "provided",
    "once",
    "after",
    "when",
    "conditional",
    "contingent",
    "dependent",
    "depends",
    "depend",
    "depending",
    "hinges",
    "hinge",
    "pending",
    "requires",
    "require",
    "relies",
    "rely",
    "subject",
    "upon",
];
pub(super) const REVERSED_CUES: &[&str] = &[
    "determines",
    "determine",
    "decides",
    "governs",
    "controls",
    "gates",
    "prerequisite",
    "precondition",
];
const STRONG_CUES: &[&str] = &[
    "if",
    "unless",
    "until",
    "provided",
    "conditional",
    "contingent",
    "dependent",
    "depends",
    "depend",
    "depending",
    "hinges",
    "hinge",
    "subject",
    "determines",
    "determine",
    "prerequisite",
    "precondition",
];

fn claim_clauses(words: &[Tok]) -> Vec<ClaimClause<'_>> {
    let refs: Vec<&Tok> = words.iter().collect();
    let lead = (refs
        .first()
        .is_some_and(|_| condition_cue(&refs, 0).is_some()))
    .then(|| refs.iter().position(|token| token.comma))
    .flatten();
    let body_start = lead.map_or(0, |at| at + 1);
    let mut bounds = vec![body_start];
    for at in body_start + 1..refs.len() {
        // "..., we have not approved the build": a comma and a new subject.
        let joiner = matches!(refs[at].lower.as_str(), "and" | "but" | "while" | "whereas")
            || refs[at - 1].end
            || refs[at - 1].comma
                && matches!(refs[at].lower.as_str(), "we" | "i" | "they" | "he" | "she");
        if !joiner {
            continue;
        }
        let ahead = &refs[at + 1..refs.len().min(at + 6)];
        if ahead.iter().any(|token| {
            matches!(
                token.lower.as_str(),
                "will" | "must" | "agreed" | "decided" | "needs" | "is" | "are" | "has" | "have"
            )
        }) {
            let conjunction =
                matches!(refs[at].lower.as_str(), "and" | "but" | "while" | "whereas");
            bounds.push(if conjunction && !refs[at - 1].end {
                at + 1
            } else {
                at
            });
        }
    }
    bounds.push(refs.len());
    let lead_tokens: Vec<&Tok> = lead.map(|at| refs[..=at].to_vec()).unwrap_or_default();
    bounds
        .windows(2)
        .filter(|range| range[0] < range[1])
        .map(|range| {
            let clause = &refs[range[0]..range[1]];
            if !lead_tokens.is_empty() {
                return ClaimClause {
                    scope: clause.to_vec(),
                    condition: lead_tokens.clone(),
                    cue: true,
                    strong_cue: STRONG_CUES.contains(&lead_tokens[0].lower.as_str())
                        || lead_tokens[0].lower == "only",
                };
            }
            // "as long as" and "so long as" are cues too.
            let forward = (0..clause.len()).find(|at| {
                FORWARD_CUES.contains(&clause[*at].lower.as_str())
                    || condition_cue(clause, *at).is_some()
            });
            let reversed = clause
                .iter()
                .position(|token| REVERSED_CUES.contains(&token.lower.as_str()));
            // "The entry count will determine when medals will be ordered":
            // an earlier reversed cue governs the clause.
            let forward = forward.filter(|at| reversed.is_none_or(|reversed| *at < reversed));
            match (forward, reversed) {
                (Some(at), _) => ClaimClause {
                    scope: clause[..at].to_vec(),
                    condition: clause[at..].to_vec(),
                    cue: true,
                    strong_cue: STRONG_CUES.contains(&clause[at].lower.as_str())
                        || condition_cue(clause, at).is_some_and(|width| width > 1),
                },
                (None, Some(at)) => ClaimClause {
                    scope: clause[at + 1..].to_vec(),
                    condition: clause[..at].to_vec(),
                    cue: true,
                    strong_cue: true,
                },
                (None, None) => ClaimClause {
                    scope: clause.to_vec(),
                    condition: Vec::new(),
                    cue: false,
                    strong_cue: false,
                },
            }
        })
        .collect()
}

fn mentioned_at(frame: &SourceFrame, scope: &[&Tok]) -> Option<usize> {
    let lemmas: Vec<String> = scope.iter().map(|token| lemma(&token.lower)).collect();
    let verb = lemmas
        .iter()
        .position(|word| same_lemma(word, &frame.verb))?;
    // A requirement is about its subject: "the data must stay", not "the
    // appendix must stay".
    if frame.kind == FrameKind::Requirement {
        let subject = tokens(&frame.subject, 0);
        let refs: Vec<&Tok> = subject.iter().collect();
        if !content(&refs)
            .iter()
            .any(|word| lemmas.iter().any(|candidate| same_lemma(candidate, word)))
        {
            return None;
        }
    }
    let objects = scope
        .iter()
        .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
        .enumerate()
        .any(|(at, word)| {
            at != verb
                && frame
                    .objects
                    .iter()
                    .any(|object| same_lemma(object, &word) || *object == word)
        });
    // "The deadline for shipping is the 14th" names the commitment by its
    // date, when no other thing is named instead.
    const META: &[&str] = &[
        "deadline",
        "date",
        "schedul",
        "set",
        "plan",
        "commitment",
        "decision",
        "agreement",
        "target",
        "due",
        "day",
        "time",
        "timing",
    ];
    let dated = frame
        .date_key
        .as_ref()
        .is_some_and(|date| has_date(&dates_in(scope), date))
        && scope.iter().enumerate().all(|(at, token)| {
            let word = lemma(&token.lower);
            at == verb
                || STOPWORDS.contains(&token.lower.as_str())
                || number_key(&token.lower).is_some()
                || WEEKDAYS.contains(&token.lower.as_str())
                || MONTHS.contains(&token.lower.as_str())
                || META.iter().any(|meta| word.starts_with(meta))
                || frame.date.as_deref().is_some_and(|date| {
                    date.to_lowercase()
                        .split_whitespace()
                        .any(|w| w == token.lower)
                })
        });
    (objects || dated).then_some(verb)
}

fn condition_matches(key: &[String], condition: &[&Tok]) -> bool {
    if key.is_empty() {
        return false;
    }
    let words: Vec<String> = condition
        .iter()
        .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
        .collect();
    let matched = key
        .iter()
        .filter(|word| words.iter().any(|candidate| same_lemma(candidate, word)))
        .count();
    matched * 2 >= key.len() && (matched >= 2 || key.len() == 1)
}

/// The verbs of a source condition: words after its subject ("after I rerun")
/// and inflected words after a noun ("the gate passes").
fn condition_verbs(frame: &SourceFrame) -> Vec<String> {
    let words = tokens(frame.condition.as_deref().unwrap_or(""), 0);
    let skip = {
        let refs: Vec<&Tok> = words.iter().collect();
        if refs.is_empty() {
            0
        } else {
            condition_cue(&refs, 0).unwrap_or(0)
        }
    };
    let body = &words[skip.min(words.len())..];
    let mut verbs = Vec::new();
    for at in 1..body.len() {
        let previous = body[at - 1].lower.as_str();
        let word = body[at].lower.as_str();
        let after_subject = matches!(previous, "i" | "we" | "he" | "she" | "they" | "it")
            || body[at - 1]
                .text
                .chars()
                .next()
                .is_some_and(char::is_uppercase)
                && !STOPWORDS.contains(&previous);
        let inflected = word.len() > 3
            && (word.ends_with("ed") || word.ends_with('s') && !word.ends_with("ss"))
            && !STOPWORDS.contains(&previous)
            && number_key(previous).is_none()
            && at + 1 < body.len() + 1;
        if (after_subject || inflected) && !STOPWORDS.contains(&word) && number_key(word).is_none()
        {
            verbs.push(lemma(word));
            if after_subject {
                break;
            }
        }
    }
    verbs.truncate(1);
    verbs
}

/// A claim condition states this commitment's own condition, including its
/// verb: "after fixing the checks" is not "after I rerun the checks".
fn condition_holds(frame: &SourceFrame, condition: &[&Tok]) -> bool {
    if !condition_matches(&frame.condition_key, condition) {
        return false;
    }
    let verbs = condition_verbs(frame);
    // Every non-verb word of the source condition is named: "once the test
    // passes" does not state "once the payment test passes". A nominal
    // paraphrase may omit the verb ("subject to the memory gate").
    let words: Vec<String> = condition
        .iter()
        .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
        .collect();
    if !frame
        .condition_key
        .iter()
        .filter(|key| !verbs.iter().any(|verb| same_lemma(verb, key)))
        .all(|key| words.iter().any(|word| same_lemma(word, key)))
    {
        return false;
    }
    let has = |verb: &String| {
        condition
            .iter()
            .any(|token| same_lemma(&lemma(&token.lower), verb))
    };
    // A nominal paraphrase ("subject to the memory gate") names no action;
    // a different verb ("after fixing") names another one.
    verbs.iter().all(has)
        || !condition.iter().skip(1).any(|token| {
            let word = token.lower.as_str();
            word.len() > 4
                && (word.ends_with("ing") || word.ends_with("ed"))
                && !frame
                    .condition_key
                    .iter()
                    .any(|key| same_lemma(key, &lemma(word)))
        })
}

/// Words a condition span may hold besides the source condition's own: cues,
/// generic event words and the owner for a first-person source condition.
const CONDITION_FRAME_WORDS: &[&str] = &[
    "condition",
    "conditions",
    "conditional",
    "conditioned",
    "contingent",
    "dependent",
    "depends",
    "depend",
    "depending",
    "hinges",
    "hinge",
    "subject",
    "upon",
    "pending",
    "requires",
    "require",
    "required",
    "relies",
    "rely",
    "prerequisite",
    "precondition",
    "determines",
    "determine",
    "decides",
    "governs",
    "controls",
    "outcome",
    "result",
    "tied",
    "linked",
    "connected",
    "attached",
    "based",
    "results",
    "met",
    "meet",
    "meets",
    "satisfied",
    "successfully",
    "successful",
    "being",
    "whether",
    "first",
];

const NEGATORS: &[&str] = &["not", "no", "never", "without", "fail", "fails", "failed"];

/// A claim condition that names more than its commitment's own condition, or
/// flips its polarity.
fn condition_extended(
    frame: &SourceFrame,
    condition: &[&Tok],
    owners: &[String],
) -> Option<&'static str> {
    let source = tokens(frame.condition.as_deref().unwrap_or(""), 0);
    let source_refs: Vec<&Tok> = source.iter().collect();
    let own = content(&source_refs);
    let first_person = source
        .iter()
        .any(|token| matches!(token.lower.as_str(), "i" | "we" | "me" | "my"));
    let negations = |words: &[&Tok]| {
        words
            .iter()
            .filter(|token| NEGATORS.contains(&token.lower.as_str()))
            .count()
            % 2
    };
    if negations(condition) != negations(&source_refs) {
        return Some("negation_changed");
    }
    let extra = condition.iter().any(|token| {
        let word = token.lower.as_str();
        if STOPWORDS.contains(&word)
            || number_key(word).is_some()
            || WEEKDAYS.contains(&word)
            || MONTHS.contains(&word)
            || FORWARD_CUES.contains(&word)
            || REVERSED_CUES.contains(&word)
            || CONDITION_FRAME_WORDS.contains(&word)
            || DISCOURSE.contains(&word)
            || NEGATORS.contains(&word)
        {
            return false;
        }
        let bare = token.text.trim_end_matches("'s");
        if first_person
            && frame
                .owner
                .as_ref()
                .is_some_and(|owner| same_owner(owner, bare))
            && owners.iter().any(|name| same_owner(name, bare))
        {
            return false;
        }
        let word = lemma(word);
        !own.iter().any(|known| same_lemma(known, &word))
    });
    extra.then_some("condition_not_supported")
}

fn named_actor(
    frame: &SourceFrame,
    scope: &[&Tok],
    verb_at: usize,
    names: &[String],
) -> Option<String> {
    for (at, token) in scope.iter().enumerate().take(verb_at) {
        let bare = token.text.trim_end_matches("'s");
        let Some(name) = names.iter().find(|name| same_owner(name, bare)) else {
            continue;
        };
        if at > 0
            && matches!(
                scope[at - 1].lower.as_str(),
                "to" | "by"
                    | "from"
                    | "with"
                    | "for"
                    | "if"
                    | "until"
                    | "unless"
                    | "when"
                    | "after"
                    | "of"
            )
        {
            continue;
        }
        let between = &scope[at + 1..verb_at];
        // "Ben said the team might grow" reports someone else's plan.
        if between.len() <= 5
            && !between.iter().any(|t| {
                names
                    .iter()
                    .any(|name| same_owner(name, t.text.trim_end_matches("'s")))
                    || matches!(
                        t.lower.as_str(),
                        "and"
                            | "but"
                            | "said"
                            | "says"
                            | "told"
                            | "asked"
                            | "noted"
                            | "mentioned"
                            | "explained"
                            | "suggested"
                            | "reported"
                            | "confirmed"
                            | "stated"
                    )
            })
        {
            return Some(name.clone());
        }
    }
    let _ = frame;
    None
}

fn negated_before(scope: &[&Tok], verb_at: usize) -> bool {
    scope[verb_at.saturating_sub(4)..verb_at]
        .iter()
        .any(|token| matches!(token.lower.as_str(), "not" | "no" | "never" | "without"))
}

fn dates_in(scope: &[&Tok]) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < scope.len() {
        if scope[at].lower == "not" {
            if let Some((end, _)) = date_at(scope, at + 1) {
                at = end;
                continue;
            }
        }
        let after_preposition = at > 0
            && matches!(
                scope[at - 1].lower.as_str(),
                "by" | "on" | "before" | "for" | "until"
            );
        let modifier = at > 0
            && matches!(
                scope[at - 1].lower.as_str(),
                "the" | "a" | "an" | "our" | "my" | "your" | "their" | "his" | "her" | "its"
            )
            && scope
                .get(at)
                .is_none_or(|token| number_key(&token.lower).is_none());
        if let Some((end, key)) = date_at(scope, at).filter(|_| !modifier) {
            if after_preposition
                || WEEKDAYS.contains(&key.as_str())
                || key.contains(' ')
                || key.contains(':')
            {
                out.push(key);
                at = end;
                continue;
            }
        }
        at += 1;
    }
    out
}

fn usable(frame: &SourceFrame) -> bool {
    !frame.conflict && !frame.ambiguous
}

/// A recap sentence about a commitment whose source clauses are ambiguous or
/// conflicting cannot be checked, so it is not stated. Action recall keeps
/// such items for review instead.
pub(super) fn unverifiable_commitment(text: &str, frames: &[SourceFrame]) -> Option<&'static str> {
    let words = tokens(text, 0);
    claim_clauses(&words)
        .iter()
        .any(|clause| {
            !frames
                .iter()
                .any(|frame| usable(frame) && mentioned_at(frame, &clause.scope).is_some())
                && frames.iter().any(|frame| {
                    !usable(frame)
                        && matches!(frame.kind, FrameKind::Commitment | FrameKind::Agreement)
                        && mentioned_at(frame, &clause.scope).is_some()
                })
        })
        .then_some("commitment_not_verifiable")
}

/// Reject a summary or action claim that attaches a source commitment to a
/// condition, date, owner or polarity that its own source clause lacks.
pub(super) fn claim_violation(
    text: &str,
    frames: &[SourceFrame],
    names: &[String],
) -> Option<&'static str> {
    let words = tokens(text, 0);
    let clauses = claim_clauses(&words);
    let conditions: Vec<&SourceFrame> = frames
        .iter()
        .filter(|frame| !frame.condition_key.is_empty() && usable(frame))
        .collect();
    let mut owners: Vec<String> = names.to_vec();
    owners.extend(frames.iter().filter_map(|frame| frame.owner.clone()));
    for clause in &clauses {
        let mentioned: Vec<(&SourceFrame, usize)> = frames
            .iter()
            .filter(|frame| usable(frame))
            .filter_map(|frame| mentioned_at(frame, &clause.scope).map(|at| (frame, at)))
            .collect();

        let attached: Vec<&&SourceFrame> = conditions
            .iter()
            .filter(|frame| {
                clause.cue && condition_matches(&frame.condition_key, &clause.condition)
            })
            .collect();
        let clause_dates = dates_in(&clause.scope);
        // One commitment's verb with another commitment's object.
        if mentioned.is_empty() {
            let lemmas: Vec<String> = clause
                .scope
                .iter()
                .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
                .collect();
            let by_verb: Vec<&SourceFrame> = frames
                .iter()
                .filter(|frame| {
                    usable(frame) && lemmas.iter().any(|word| same_lemma(word, &frame.verb))
                })
                .collect();
            let by_object = frames.iter().filter(|frame| usable(frame)).any(|frame| {
                !by_verb.iter().any(|other| std::ptr::eq(*other, frame))
                    && lemmas.iter().any(|word| {
                        !by_verb.iter().any(|other| same_lemma(word, &other.verb))
                            && frame
                                .objects
                                .iter()
                                .any(|object| object.len() > 2 && same_lemma(object, word))
                    })
            });
            if !by_verb.is_empty() && by_object {
                return Some("commitment_mixed");
            }
        }
        let asserts = clause.scope.iter().any(|token| {
            matches!(
                token.lower.as_str(),
                "will"
                    | "must"
                    | "agreed"
                    | "committed"
                    | "commit"
                    | "commits"
                    | "shall"
                    | "going"
                    | "promised"
            )
        });
        // "The setup will be explained by Noah" from "I can explain it".
        if asserts
            && !mentioned.is_empty()
            && mentioned
                .iter()
                .all(|(frame, _)| frame.kind == FrameKind::Possibility)
        {
            return Some("possibility_as_commitment");
        }
        // "Ben will confirm the seat count" from "if procurement confirms the
        // seat count": another commitment's prerequisite is nobody's task.
        // Stated without its cue, it is also not a fact: "Omar approves the
        // east entrance route" from "only if Omar approves the route".
        if (asserts || !clause.cue)
            && mentioned
                .iter()
                .all(|(frame, _)| frame.kind == FrameKind::Possibility)
        {
            let lemmas: Vec<String> = clause
                .scope
                .iter()
                .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
                .collect();
            let event = frames.iter().filter(|frame| usable(frame)).any(|frame| {
                let Some(condition) = &frame.condition else {
                    return false;
                };
                let words = tokens(condition, 0);
                let verbs: Vec<String> = words
                    .iter()
                    .skip(1)
                    .filter(|token| {
                        token.lower.len() > 3
                            && (token.lower.ends_with('s') || token.lower.ends_with("ed"))
                            && !token.lower.ends_with("ss")
                    })
                    .map(|token| lemma(&token.lower))
                    .collect();
                let hits = frame
                    .condition_key
                    .iter()
                    .filter(|word| lemmas.iter().any(|candidate| same_lemma(candidate, word)))
                    .count();
                // Only the condition's own words, plus who and when.
                let only_condition = clause.scope.iter().all(|token| {
                    let word = number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower));
                    STOPWORDS.contains(&token.lower.as_str())
                        || matches!(
                            token.lower.as_str(),
                            "will"
                                | "must"
                                | "agreed"
                                | "committed"
                                | "commit"
                                | "shall"
                                | "going"
                                | "promised"
                                | "by"
                                | "on"
                        )
                        || owners
                            .iter()
                            .any(|name| same_owner(name, token.text.trim_end_matches("'s")))
                        || WEEKDAYS.contains(&token.lower.as_str())
                        || MONTHS.contains(&token.lower.as_str())
                        || number_key(&token.lower).is_some()
                        || frame.condition_key.iter().any(|key| same_lemma(key, &word))
                        || verbs.iter().any(|verb| same_lemma(verb, &word))
                });
                hits >= 2
                    && only_condition
                    && verbs
                        .iter()
                        .any(|verb| lemmas.iter().any(|candidate| same_lemma(candidate, verb)))
            });
            if event {
                return Some("condition_as_commitment");
            }
            // 3. A commitment verb with an object no commitment has: "The
            // release will be notified" from "I'll notify support".
            if asserts && mentioned.is_empty() {
                let verb_at = clause.scope.iter().position(|token| {
                    let word = lemma(&token.lower);
                    frames.iter().any(|frame| {
                        usable(frame)
                            && frame.kind != FrameKind::Possibility
                            && same_lemma(&word, &frame.verb)
                    })
                });
                if let Some(verb_at) = verb_at {
                    let refs: Vec<&Tok> = clause
                        .scope
                        .iter()
                        .enumerate()
                        .filter(|(at, token)| {
                            *at != verb_at
                                && !owners
                                    .iter()
                                    .any(|name| same_owner(name, token.text.trim_end_matches("'s")))
                                && token.text.chars().next().is_some_and(char::is_lowercase)
                                && !WEEKDAYS.contains(&token.lower.as_str())
                                && !MONTHS.contains(&token.lower.as_str())
                                && !matches!(
                                    token.lower.as_str(),
                                    "team"
                                        | "group"
                                        | "meeting"
                                        | "it"
                                        | "them"
                                        | "this"
                                        | "that"
                                        | "everyone"
                                        | "be"
                                        | "been"
                                )
                        })
                        .map(|(_, token)| *token)
                        .collect();
                    if !content(&refs).iter().all(|word| number_key(word).is_some()) {
                        return Some("commitment_object_changed");
                    }
                }
            }
        }
        let condition_dates = dates_in(&clause.condition);
        for (frame, verb_at) in &mentioned {
            let own = condition_holds(frame, &clause.condition) && clause.cue;
            if own && !condition_dates.is_empty() {
                let source = tokens(frame.condition.as_deref().unwrap_or(""), 0);
                let refs: Vec<&Tok> = source.iter().collect();
                let known = dates_in(&refs);
                if condition_dates.iter().any(|date| !has_date(&known, date)) {
                    return Some("date_changed");
                }
            }
            // The claim's condition is a subset of the clause's own: no added
            // prerequisite ("and Priya's review"), no "other conditions" and
            // no flipped polarity.
            if own {
                if let Some(reason) = condition_extended(frame, &clause.condition, &owners) {
                    return Some(reason);
                }
            }
            if !own
                && attached
                    .iter()
                    .any(|other| other.condition_key != frame.condition_key)
            {
                return Some("condition_scope_transfer");
            }
            if !own
                && clause.strong_cue
                && frame.condition_key.is_empty()
                && content(&clause.condition).len() >= 2
                && attached.is_empty()
            {
                return Some("condition_not_supported");
            }
            if !own && !frame.condition_key.is_empty() {
                return Some("condition_dropped");
            }
            if negated_before(&clause.scope, *verb_at) != frame.negated {
                return Some("negation_changed");
            }
            // "Nina reviewed the export report" from "I'll review it".
            let verb = clause.scope[*verb_at].lower.as_str();
            let past = verb.ends_with("ed")
                || matches!(
                    verb,
                    "sent" | "took" | "wrote" | "made" | "kept" | "ran" | "brought" | "met"
                );
            let pending = clause.scope[verb_at.saturating_sub(4)..*verb_at]
                .iter()
                .any(|token| {
                    matches!(
                        token.lower.as_str(),
                        "will"
                            | "to"
                            | "be"
                            | "must"
                            | "should"
                            | "would"
                            | "going"
                            | "if"
                            | "once"
                            | "until"
                            | "unless"
                    )
                });
            if past
                && !pending
                && frame.kind != FrameKind::Requirement
                && frame.kind != FrameKind::Possibility
            {
                return Some("completion_not_stated");
            }
            if let Some(actor) = named_actor(frame, &clause.scope, *verb_at, &owners) {
                if !frame
                    .owner
                    .as_ref()
                    .is_some_and(|owner| same_owner(owner, &actor))
                {
                    return Some("owner_changed");
                }
            }
            // "Priya and the team will ship the beta": every person in the
            // clause owns a mentioned commitment or is named in its task.
            if clause.scope.iter().enumerate().any(|(at, token)| {
                let bare = token.text.trim_end_matches("'s");
                // "Ben said the team might grow" reports; it assigns nothing.
                let reporter = clause.scope.get(at + 1).is_some_and(|next| {
                    matches!(
                        next.lower.as_str(),
                        "said"
                            | "says"
                            | "told"
                            | "asked"
                            | "noted"
                            | "mentioned"
                            | "explained"
                            | "suggested"
                            | "reported"
                            | "confirmed"
                            | "stated"
                    )
                });
                !reporter
                    && owners.iter().any(|name| same_owner(name, bare))
                    && !mentioned.iter().any(|(other, _)| {
                        other
                            .owner
                            .as_ref()
                            .is_some_and(|owner| same_owner(owner, bare))
                            || other.objects.contains(&lemma(bare))
                            || other.subject.eq_ignore_ascii_case(bare)
                    })
            }) {
                return Some("owner_changed");
            }
            let allowed: Vec<&String> = mentioned
                .iter()
                .filter_map(|(other, _)| other.date_key.as_ref())
                .collect();
            if clause_dates
                .iter()
                .any(|date| !allowed.iter().any(|known| same_date(known, date)))
                || frame.date_key.as_ref().is_some_and(|date| {
                    !clause_dates.is_empty()
                        && mentioned.len() == 1
                        && !has_date(&clause_dates, date)
                })
            {
                return Some("date_changed");
            }
        }
    }
    None
}

/// Status-like qualifiers such as "initial" or "tentative" need source words,
/// follow-up work needs a source step, and a present count stays present.
/// Number attachment and restrictions are in `source_claims`.
pub(super) fn qualifier_violation(text: &str, lines: &[TrustedLine]) -> Option<&'static str> {
    const QUALIFIERS: &[&str] = &[
        "initial",
        "initially",
        "original",
        "originally",
        "preliminary",
        "estimated",
        "estimate",
        "approximate",
        "approximately",
        "roughly",
        "tentative",
        "tentatively",
        "provisional",
        "provisionally",
        "temporary",
        "temporarily",
        "revised",
        "draft",
        "future",
        "eventually",
        "upcoming",
    ];
    let claim = tokens(text, 0);
    let source: Vec<Vec<Tok>> = lines.iter().map(|line| tokens(&line.text, 0)).collect();
    let in_source = |word: &str| source.iter().flatten().any(|token| token.lower == word);
    if claim
        .iter()
        .any(|token| QUALIFIERS.contains(&token.lower.as_str()) && !in_source(&token.lower))
    {
        return Some("qualifier_not_supported");
    }
    // Invented follow-up work: "the next step is to monitor the gate".
    let phrase = |words: &[&str], text: &[Tok]| {
        text.windows(words.len())
            .any(|w| w.iter().zip(words).all(|(t, word)| t.lower == *word))
    };
    for words in [
        &["next", "step"][..],
        &["next", "steps"],
        &["follow", "up"],
        &["monitor"],
        &["track"],
    ] {
        if phrase(words, &claim) && !source.iter().any(|line| phrase(words, line)) {
            return Some("next_step_not_stated");
        }
    }
    // "The trial will have 12 guides" from "The trial has 12 guides".
    for at in 0..claim.len().saturating_sub(2) {
        if claim[at].lower == "will"
            && matches!(claim[at + 1].lower.as_str(), "have" | "be" | "include")
        {
            let numbers: Vec<String> = claim[at + 2..claim.len().min(at + 5)]
                .iter()
                .filter_map(|t| number_key(&t.lower))
                .collect();
            for number in numbers {
                let present = source.iter().any(|line| {
                    (0..line.len()).any(|k| {
                        number_key(&line[k].lower).as_ref() == Some(&number)
                            && line[k.saturating_sub(3)..k]
                                .iter()
                                .any(|t| matches!(t.lower.as_str(), "has" | "have" | "is" | "are"))
                            && !line[k.saturating_sub(3)..k]
                                .iter()
                                .any(|t| t.lower == "will")
                    })
                });
                if present {
                    return Some("tense_changed");
                }
            }
        }
    }
    None
}

/// Whether a claim states this commitment with its own condition, date,
/// owner and polarity.
pub(super) fn covers(text: &str, frame: &SourceFrame, names: &[String]) -> bool {
    let words = tokens(text, 0);
    claim_clauses(&words).iter().any(|clause| {
        let Some(verb_at) = mentioned_at(frame, &clause.scope) else {
            return false;
        };
        (frame.condition_key.is_empty() || clause.cue && condition_holds(frame, &clause.condition))
            && frame
                .date_key
                .as_ref()
                .is_none_or(|date| has_date(&dates_in(&clause.scope), date))
            && negated_before(&clause.scope, verb_at) == frame.negated
            && match &frame.owner {
                Some(owner) => named_actor(frame, &clause.scope, verb_at, names)
                    .is_some_and(|actor| same_owner(owner, &actor)),
                None => true,
            }
    })
}

/// Whether a claim concerns only this commitment and adds nothing beyond
/// its source wording, so a complete restatement can replace it.
pub(super) fn restates_only(text: &str, frame: &SourceFrame, frames: &[SourceFrame]) -> bool {
    let words = tokens(text, 0);
    let clauses = claim_clauses(&words);
    let mentions_frame = clauses
        .iter()
        .any(|clause| mentioned_at(frame, &clause.scope).is_some());
    let mentions_other = frames
        .iter()
        .filter(|other| !std::ptr::eq(*other, frame))
        .any(|other| {
            clauses
                .iter()
                .any(|clause| mentioned_at(other, &clause.scope).is_some())
        });
    if !mentions_frame || mentions_other {
        return false;
    }
    let allowed: HashSet<String> = tokens(
        &format!(
            "{} {} {} {} {}",
            frame.subject,
            frame.core,
            frame.date.as_deref().unwrap_or(""),
            frame.condition.as_deref().unwrap_or(""),
            frame.constraint.as_deref().unwrap_or("")
        ),
        0,
    )
    .iter()
    .map(|token| number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower)))
    .collect();
    const META: &[&str] = &[
        "commitment",
        "plan",
        "decision",
        "agreement",
        "condition",
        "conditional",
        "contingent",
        "dependent",
        "depend",
        "outcome",
        "result",
        "team",
        "group",
        "meeting",
        "agre",
        "decid",
        "scheduled",
        "schedul",
        "planned",
        "plann",
        "set",
        "due",
        "date",
        "pass",
        "passing",
        "clear",
        "success",
        "successful",
        "approve",
        "approval",
        "upon",
        "subject",
        "pending",
        "require",
        "requir",
        "status",
        "original",
        "contingen",
        "determin",
        "both",
        "whether",
    ];
    words.iter().all(|token| {
        let word = number_key(&token.lower).unwrap_or_else(|| lemma(&token.lower));
        STOPWORDS.contains(&token.lower.as_str())
            || allowed.iter().any(|known| same_lemma(known, &word))
            || META
                .iter()
                .any(|meta| same_lemma(meta, &word) || word.starts_with(meta))
    })
}

/// First-person source wording in third-person text: "after I rerun" becomes
/// "after Leo reruns". Anything else first-person abstains.
fn third_person(text: &str, owner: Option<&str>) -> Option<String> {
    let mut out = Vec::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut at = 0;
    while at < words.len() {
        let word = words[at];
        let bare = word.trim_end_matches([',', '.']);
        let lower = bare.to_lowercase();
        // "sends me the invoice list" is "sends Fen the invoice list" when
        // Fen is the speaker who owns the commitment.
        if matches!(lower.as_str(), "me" | "my") {
            let owner = owner?;
            let tail = &word[bare.len()..];
            out.push(if lower == "me" {
                format!("{owner}{tail}")
            } else {
                format!("{owner}'s{tail}")
            });
            at += 1;
            continue;
        }
        if matches!(lower.as_str(), "mine" | "myself" | "we" | "us" | "our") {
            return None;
        }
        if lower == "i" || lower == "i'll" || lower == "i'm" || lower == "i've" {
            let owner = owner?;
            match lower.as_str() {
                "i'll" => out.push(format!("{owner} will")),
                "i'm" => out.push(format!("{owner} is")),
                "i've" => out.push(format!("{owner} has")),
                _ => {
                    out.push(owner.to_string());
                    if let Some(next) = words.get(at + 1) {
                        let verb = next.trim_end_matches([',', '.']);
                        let tail = &next[verb.len()..];
                        let conjugated = match verb.to_lowercase().as_str() {
                            "am" => "is".to_string(),
                            "have" => "has".to_string(),
                            "do" => "does".to_string(),
                            "will" | "can" | "must" | "should" | "would" | "could" | "might" => {
                                verb.to_string()
                            }
                            other
                                if other.ends_with(['s', 'x', 'z'])
                                    || other.ends_with("ch")
                                    || other.ends_with("sh")
                                    || other.ends_with('o') =>
                            {
                                format!("{verb}es")
                            }
                            other
                                if other.ends_with('y')
                                    && !other.ends_with("ay")
                                    && !other.ends_with("ey")
                                    && !other.ends_with("oy") =>
                            {
                                format!("{}ies", &verb[..verb.len() - 1])
                            }
                            _ => format!("{verb}s"),
                        };
                        out.push(format!("{conjugated}{tail}"));
                        at += 2;
                        continue;
                    }
                }
            }
            at += 1;
            continue;
        }
        out.push(word.to_string());
        at += 1;
    }
    Some(out.join(" "))
}

/// A leading condition placed after its commitment starts in lowercase.
fn following_condition(condition: &str) -> String {
    let first = condition.split_whitespace().next().unwrap_or("");
    if matches!(
        first.to_lowercase().as_str(),
        "if" | "unless" | "until" | "provided" | "once" | "after" | "when" | "only" | "as"
    ) {
        let mut chars = condition.chars();
        chars
            .next()
            .map(|c| c.to_lowercase().collect::<String>() + chars.as_str())
            .unwrap_or_default()
    } else {
        condition.to_string()
    }
}

fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

/// Two clauses about the same task: one recording, the same verb and
/// polarity, and the same objects apart from quantities. Owners, dates and
/// quantities may differ.
pub(super) fn same_task(first: &SourceFrame, second: &SourceFrame) -> bool {
    let words = |frame: &SourceFrame| -> HashSet<String> {
        frame
            .objects
            .iter()
            .filter(|word| !word.chars().any(|ch| ch.is_ascii_digit()))
            .cloned()
            .collect()
    };
    let (a, b) = (words(first), words(second));
    first.recording_id == second.recording_id
        && first.negated == second.negated
        && same_lemma(&first.verb, &second.verb)
        && !a.is_empty()
        && !b.is_empty()
        && (a.is_subset(&b) || b.is_subset(&a))
}

/// Quantities in a clause's object: "order 40 chairs" gives "40".
pub(super) fn object_numbers(frame: &SourceFrame) -> Vec<String> {
    let mut out: Vec<String> = frame
        .objects
        .iter()
        .filter(|word| word.chars().any(|ch| ch.is_ascii_digit()))
        .cloned()
        .collect();
    out.sort();
    out
}

/// Whether a sentence names this commitment's verb and object.
pub(super) fn restates(frame: &SourceFrame, text: &str) -> bool {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    mentioned_at(frame, &refs).is_some()
}

/// Whether a sentence keeps every content word of this commitment's
/// condition, so showing it alone drops no condition.
pub(super) fn keeps_condition(frame: &SourceFrame, text: &str) -> bool {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    let found = content(&refs);
    frame
        .condition_key
        .iter()
        .all(|word| found.iter().any(|candidate| same_lemma(candidate, word)))
}

/// Date keys a sentence rejects: "not the 21st", "not Monday".
pub(super) fn rejected_dates(text: &str) -> Vec<String> {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    (1..refs.len())
        .filter(|at| refs[*at - 1].lower == "not")
        .filter_map(|at| rejected_date(&refs, at).map(|(_, key)| key))
        .collect()
}

/// Date keys a sentence states, without dates it rejects ("not Monday").
pub(super) fn text_dates(text: &str) -> Vec<String> {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    let mut found = dates_in(&refs);
    // A bare "the 28th" names a day in a short correction ("The 28th then").
    for at in 0..refs.len() {
        if refs[at].lower == "the" && (at == 0 || refs[at - 1].lower != "not") {
            if let Some((_, key)) = rejected_date(&refs, at) {
                if !has_date(&found, &key) {
                    found.push(key);
                }
            }
        }
    }
    found
}

/// Words of a sentence that are neither dates, discourse nor stopwords:
/// "Fine, April 16." and "The 28th then." have none.
pub(super) fn only_dates(text: &str) -> bool {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    let mut at = 0;
    let mut other = 0;
    while at < refs.len() {
        if let Some((end, _)) = date_at(&refs, at).or_else(|| rejected_date(&refs, at)) {
            at = end;
            continue;
        }
        let word = refs[at].lower.as_str();
        if !STOPWORDS.contains(&word)
            && !DISCOURSE.contains(&word)
            && !matches!(
                word,
                "fine"
                    | "fair"
                    | "enough"
                    | "then"
                    | "good"
                    | "great"
                    | "agreed"
                    | "noted"
                    | "got"
                    | "that's"
                    | "is"
                    | "it"
                    | "it's"
                    | "works"
                    | "deal"
                    | "perfect"
            )
        {
            other += 1;
        }
        at += 1;
    }
    other == 0
}

/// Quantities a sentence states outside its date phrases: "40 chairs" gives
/// "40"; "by the 9th" gives nothing.
pub(super) fn text_numbers(text: &str) -> Vec<String> {
    let words = tokens(text, 0);
    let refs: Vec<&Tok> = words.iter().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < refs.len() {
        if let Some((end, _)) = date_at(&refs, at).or_else(|| rejected_date(&refs, at)) {
            at = end;
            continue;
        }
        let word = refs[at].lower.as_str();
        let numeric = word.chars().any(|ch| ch.is_ascii_digit())
            || CARDINALS.contains(&word) && word != "one";
        if let Some(key) = number_key(word).filter(|_| numeric) {
            if !out.contains(&key) {
                out.push(key);
            }
        }
        at += 1;
    }
    out
}

/// The commitment's date key: "october 9", "friday", "14".
pub(super) fn date_key(frame: &SourceFrame) -> Option<&str> {
    frame.date_key.as_deref()
}

/// Whether coverage may build text or an action from this clause.
pub(super) fn templatable(frame: &SourceFrame) -> bool {
    usable(frame)
        && frame.complete
        && !frame.plan
        && frame.kind != FrameKind::Possibility
        && (frame.owner.is_some() || !frame.first_person)
        && frame.core.split_whitespace().count() >= 2
}

/// A commitment worth listing even when its scope, date or owner is unclear:
/// a whole task (verb and object), not a plan or possibility, with an owner
/// or a group subject. Ambiguous, conflicting and cut clauses qualify; they
/// are listed as quoted unclear items.
pub(super) fn listable(frame: &SourceFrame) -> bool {
    matches!(frame.kind, FrameKind::Commitment | FrameKind::Agreement)
        && !frame.plan
        && !frame.retracted
        && (frame.owner.is_some() || !frame.first_person)
        && frame.core.split_whitespace().count() >= 2
}

/// A decision or conditional commitment that the recap must state.
pub(super) fn key_decision(frame: &SourceFrame) -> bool {
    templatable(frame) && (frame.kind == FrameKind::Agreement || frame.condition.is_some())
}

/// Recap sentence from one clause's own fields, in source order.
pub(super) fn prose(frame: &SourceFrame) -> Option<String> {
    let owner = frame.owner.as_deref();
    let subject = match (frame.kind, owner) {
        (FrameKind::Requirement, _) => upper_first(&frame.subject),
        (_, Some(owner)) => owner.to_string(),
        (_, None) => "We".into(),
    };
    let modal = match (frame.kind, frame.negated) {
        (FrameKind::Agreement, false) => "agreed to",
        (FrameKind::Agreement, true) => "agreed not to",
        (FrameKind::Commitment, false) => "will",
        (FrameKind::Commitment, true) => "will not",
        (FrameKind::Requirement, false) => "must",
        (FrameKind::Requirement, true) => "must not",
        (FrameKind::Possibility, _) => return None,
    };
    let mut body = frame.core.clone();
    if let Some(date) = &frame.date {
        body.push(' ');
        body.push_str(date);
    }
    if let Some(condition) = &frame.condition {
        body.push(' ');
        body.push_str(&following_condition(condition));
    }
    // First-person words in the clause belong to its speaker, who is the
    // owner only for a first-person commitment.
    let body = third_person(&body, owner.filter(|_| frame.first_person))?;
    let body = body.trim_end_matches([',', '.']);
    Some(format!("{subject} {modal} {body}."))
}

/// Action task and deadline from one clause's own fields.
pub(super) fn action(frame: &SourceFrame) -> Option<(String, Option<String>)> {
    if frame.kind == FrameKind::Requirement {
        return None;
    }
    let mut task = frame.core.clone();
    if let Some(date) = &frame.date {
        task.push(' ');
        task.push_str(date);
    }
    if let Some(condition) = &frame.condition {
        task.push(' ');
        task.push_str(&following_condition(condition));
    }
    let mut task = task.trim_end_matches([',', '.']).to_string();
    if frame.negated {
        task = format!("Do not {task}");
    }
    task.push('.');
    if let Some(constraint) = &frame.constraint {
        task.push(' ');
        task.push_str(constraint);
    }
    let deadline = frame.date.as_ref().map(|date| {
        let words: Vec<&str> = date.split_whitespace().collect();
        let start = usize::from(matches!(
            words.first().map(|w| w.to_lowercase()).as_deref(),
            Some("by" | "on" | "before" | "for")
        ));
        words[start..].join(" ")
    });
    Some((task, deadline))
}

/// Whether an action item covers a commitment: same task, owner, deadline,
/// condition and polarity.
pub(super) fn action_covers(
    item: &super::grounded::GroundedActionItemOutput,
    frame: &SourceFrame,
    names: &[String],
) -> bool {
    covers(&action_claim(item), frame, names)
}

/// The claim an action item makes, as one sentence.
pub(super) fn action_claim(item: &super::grounded::GroundedActionItemOutput) -> String {
    let task = item.task.trim().trim_end_matches('.');
    let (negated, task) = match task.split_once(' ') {
        Some((first, rest))
            if first.eq_ignore_ascii_case("do") && rest.to_lowercase().starts_with("not ") =>
        {
            (true, &rest[4..])
        }
        Some((first, rest)) if first.eq_ignore_ascii_case("don't") => (true, rest),
        _ => (false, task),
    };
    let owner = item.assignee.as_deref().unwrap_or("We");
    let mut claim = format!("{owner} will {}{task}", if negated { "not " } else { "" });
    if let Some(deadline) = &item.deadline {
        let words = tokens(&claim, 0);
        let refs: Vec<&Tok> = words.iter().collect();
        let deadline_words = tokens(&format!("by {deadline}"), 0);
        // A deadline field adds its date only when the task text lacks one.
        let deadline_refs: Vec<&Tok> = deadline_words.iter().collect();
        let known = dates_in(&refs);
        if dates_in(&deadline_refs)
            .iter()
            .any(|date| !has_date(&known, date))
        {
            claim.push_str(&format!(" by {deadline}"));
        }
    }
    claim.push('.');
    claim
}

/// Indices of the commitments a claim mentions.
pub(super) fn mentioned_frames(text: &str, frames: &[SourceFrame]) -> Vec<usize> {
    let words = tokens(text, 0);
    let clauses = claim_clauses(&words);
    (0..frames.len())
        .filter(|at| usable(&frames[*at]))
        .filter(|at| {
            clauses
                .iter()
                .any(|clause| mentioned_at(&frames[*at], &clause.scope).is_some())
        })
        .collect()
}

/// Whether an action's deadline field names this commitment's own date.
pub(super) fn deadline_matches(frame: &SourceFrame, deadline: Option<&str>) -> bool {
    let Some(deadline) = deadline else {
        return true;
    };
    let words = tokens(&format!("by {deadline}"), 0);
    let refs: Vec<&Tok> = words.iter().collect();
    let found = dates_in(&refs);
    match &frame.date_key {
        Some(date) => found.is_empty() || has_date(&found, date),
        None => found.is_empty(),
    }
}

/// Whether a task starts with a source commitment's verb.
pub(super) fn known_verb(task: &str, frames: &[SourceFrame]) -> bool {
    let words = tokens(task, 0);
    words
        .iter()
        .find(|token| !STOPWORDS.contains(&token.lower.as_str()))
        .is_some_and(|token| {
            let word = lemma(&token.lower);
            frames
                .iter()
                .any(|frame| usable(frame) && same_lemma(&word, &frame.verb))
        })
}

/// A task cut off mid-phrase, or without two content words.
pub(super) fn fragment(task: &str) -> bool {
    let words = tokens(task, 0);
    let last = words.last().map(|token| token.lower.as_str()).unwrap_or("");
    let refs: Vec<&Tok> = words.iter().collect();
    content(&refs).len() < 2
        || matches!(
            last,
            "the"
                | "a"
                | "an"
                | "to"
                | "of"
                | "and"
                | "or"
                | "but"
                | "by"
                | "on"
                | "at"
                | "in"
                | "for"
                | "with"
                | "if"
                | "unless"
                | "until"
                | "after"
                | "will"
                | "would"
                | "i"
                | "we"
                | "you"
                | "my"
                | "your"
                | "our"
                | "is"
                | "are"
        )
}

pub(super) fn frame_names(frames: &[SourceFrame], lines: &[TrustedLine]) -> Vec<String> {
    let mut names: Vec<String> = frames
        .iter()
        .filter_map(|frame| frame.owner.clone())
        .collect();
    names.extend(lines.iter().filter_map(|line| line.speaker_name.clone()));
    let mut seen = HashSet::new();
    names.retain(|name| seen.insert(name.to_lowercase()));
    names
}

#[cfg(test)]
pub(super) fn debug_frames(
    frames: &[SourceFrame],
) -> Vec<std::collections::HashMap<&'static str, String>> {
    frames
        .iter()
        .map(|frame| {
            std::collections::HashMap::from([
                ("kind", format!("{:?}", frame.kind)),
                ("subject", frame.subject.clone()),
                ("owner", format!("{:?}", frame.owner)),
                ("negated", frame.negated.to_string()),
                ("core", frame.core.clone()),
                ("date", format!("{:?}", frame.date)),
                ("condition", format!("{:?}", frame.condition)),
                ("lines", frame.line_ids.join(",")),
                (
                    "flags",
                    format!(
                        "complete={} ambiguous={} conflict={}",
                        frame.complete, frame.ambiguous, frame.conflict
                    ),
                ),
                (
                    "keys",
                    format!("{:?} {:?}", frame.date_key, frame.condition_key),
                ),
            ])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, text: &str, speaker: Option<&str>) -> TrustedLine {
        TrustedLine {
            written_note: false,
            speaker_name: speaker.map(str::to_string),
            speaker_id: speaker.map(|name| format!("voice_{name}")),
            line_id: id.into(),
            recording_id: "r".into(),
            segment_id: id.into(),
            text: text.into(),
            start_time: 0.0,
            end_time: 1.0,
        }
    }

    fn frames(texts: &[(&str, Option<&str>)]) -> Vec<SourceFrame> {
        let lines: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(at, (text, speaker))| {
                let mut line = line(&format!("L{}", at + 1), text, *speaker);
                line.start_time = at as f64 * 10.0;
                line.end_time = line.start_time + 8.0;
                line
            })
            .collect();
        source_frames(&lines)
    }

    const GATE: &str = "Plainsong footprint fixture, we agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.";

    #[test]
    fn gate_sentence_yields_a_conditional_agreement_and_a_separate_review() {
        let frames = frames(&[(GATE, None)]);
        assert_eq!(frames.len(), 2, "{:?}", debug_frames(&frames));
        let ship = &frames[0];
        assert_eq!(ship.kind, FrameKind::Agreement);
        assert_eq!(ship.core, "ship the beta");
        assert_eq!(ship.date.as_deref(), Some("on the 14th"));
        assert_eq!(ship.condition.as_deref(), Some("if the memory gate passes"));
        assert!(key_decision(ship));
        assert_eq!(
            prose(ship).unwrap(),
            "We agreed to ship the beta on the 14th if the memory gate passes."
        );
        let review = &frames[1];
        assert_eq!(review.owner.as_deref(), Some("Priya"));
        assert!(review.condition.is_none());
        assert!(!key_decision(review));
        assert_eq!(action(review).unwrap(), ("review the notes.".into(), None));
    }

    #[test]
    fn asr_variants_keep_the_same_frames() {
        for text in [
            "plainsong footprint fixture we agreed to um ship the the beta on the fourteenth if the memory gate passes and Priya will review the notes.",
            "Plainsong footprint fixture. Priya will review the notes, and we agreed to ship the beta on the 14 if the memory gate passes.",
            "Plainsong footprint fixture. If the memory gate passes, we agreed to ship the beta on the 14th. Priya will review the notes.",
            "we agreed we agreed to ship the beta on the 14th if the 14th if the memory gate passes, you know, and Priya will will review the notes.",
        ] {
            let found = frames(&[(text, None)]);
            let ship = found.iter().find(|frame| frame.verb == "ship").unwrap_or_else(|| panic!("{text}: {:?}", debug_frames(&found)));
            assert_eq!(ship.date_key.as_deref(), Some("14"), "{text}");
            assert_eq!(ship.condition_key, vec!["memory", "gat", "pass"], "{text}");
            let review = found.iter().find(|frame| frame.verb == "review").unwrap();
            assert!(review.condition.is_none(), "{text}: {:?}", debug_frames(&found));
            assert_eq!(review.owner.as_deref(), Some("Priya"));
        }
    }

    #[test]
    fn truncated_repeats_and_split_passages_do_not_conflict() {
        let found = frames(&[
            (GATE, None),
            ("Plainsong footprint fixture, we agreed to ship the beta on the 14th if the memory gate", None),
            ("Plainsong footprint fixture, we agreed to ship the beta on the 14th", None),
        ]);
        let ship = found.iter().find(|frame| frame.verb == "ship").unwrap();
        assert!(
            !ship.conflict && ship.complete,
            "{:?}",
            debug_frames(&found)
        );
        assert!(key_decision(ship));
        let split = frames(&[
            (
                "Plainsong footprint fixture, we agreed to ship the beta on the 14th",
                None,
            ),
            (
                "if the memory gate passes, and Priya will review the notes.",
                None,
            ),
        ]);
        let ship = split.iter().find(|frame| frame.verb == "ship").unwrap();
        assert_eq!(
            ship.condition.as_deref(),
            Some("if the memory gate passes"),
            "{:?}",
            debug_frames(&split)
        );
        assert_eq!(ship.line_ids, vec!["L1", "L2"]);
    }

    #[test]
    fn claims_cannot_move_a_condition_date_owner_or_polarity() {
        let found = frames(&[(GATE, None)]);
        let names = vec!["Priya".to_string()];
        for (claim, expected) in [
            ("The commitment to review the notes is conditional on the memory gate passing.", Some("condition_scope_transfer")),
            ("The memory gate's outcome determines both the beta shipment and Priya's review of the notes.", Some("condition_scope_transfer")),
            ("If the memory gate passes, the beta will ship on the 14th and Priya will review the notes.", Some("condition_scope_transfer")),
            ("Priya will review the notes if the memory gate passes.", Some("condition_scope_transfer")),
            ("We agreed to ship the beta on the 14th.", Some("condition_dropped")),
            ("We agreed not to ship the beta on the 14th if the memory gate passes.", Some("negation_changed")),
            ("Priya will ship the beta on the 14th if the memory gate passes.", Some("owner_changed")),
            ("Priya will review the notes on the 14th.", Some("date_changed")),
            ("We agreed to ship the beta on the 15th if the memory gate passes.", Some("date_changed")),
            ("Priya will review the notes if the budget is approved.", Some("condition_not_supported")),
            ("We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.", None),
            ("The beta ships on the 14th if the memory gate passes.", None),
            ("Shipping the beta depends on the memory gate.", None),
            ("Priya will review the notes.", None),
            ("Priya reviewed the notes.", Some("completion_not_stated")),
            ("The notes will be reviewed by Priya.", None),
            ("The beta shipped on the 14th after the memory gate passed.", Some("completion_not_stated")),
        ] {
            assert_eq!(claim_violation(claim, &found, &names), expected, "{claim}");
        }
        let ship = &found[0];
        assert!(covers(
            "We agreed to ship the beta on the 14th if the memory gate passes.",
            ship,
            &names
        ));
        assert!(!covers(
            "The commitment to ship the beta is conditional on the memory gate passing.",
            ship,
            &names
        ));
        assert!(restates_only(
            "The commitment to ship the beta is conditional on the memory gate passing.",
            ship,
            &found
        ));
        assert!(!restates_only(
            "Priya will review the notes, and shipping depends on the memory gate.",
            ship,
            &found
        ));
    }

    #[test]
    fn named_first_person_commitments_and_corrections() {
        let found = frames(&[
            ("I'll send the room plan by Monday. Correction: I'll send the room plan by Wednesday, not Monday.", Some("Noah")),
            ("Sam will review the room plan by Thursday.", Some("Iris")),
            ("Yes, I'll review the room plan by Thursday if Noah sends the final version.", Some("Sam")),
            ("If Sam approves the room plan, I'll book the 2 rooms by Friday.", Some("Iris")),
            ("I won't migrate any data until Ben approves the residency appendix.", Some("Dev")),
            ("Yes. I'll send the export report by Tuesday. After I rerun the 3 failing checks.", Some("Leo")),
            ("I'll review the sensor report by June 13. Irrigation must stay off until the leak test passes.", Some("Ravi")),
            ("Leo, can you send the export report by Tuesday?", Some("Mara")),
            ("I can explain the projector setup, but I am not committing to bring equipment.", Some("Noah")),
        ]);
        let by_owner = |owner: &str, verb: &str| {
            found
                .iter()
                .find(|frame| frame.owner.as_deref() == Some(owner) && frame.verb == verb)
                .unwrap_or_else(|| panic!("{owner} {verb}: {:?}", debug_frames(&found)))
        };
        assert_eq!(
            by_owner("Noah", "send").date_key.as_deref(),
            Some("wednesday")
        );
        let review = by_owner("Sam", "review");
        assert!(review
            .condition
            .as_deref()
            .is_some_and(|c| c.contains("Noah sends")));
        assert_eq!(
            prose(review).unwrap(),
            "Sam will review the room plan by Thursday if Noah sends the final version."
        );
        let book = by_owner("Iris", "book");
        assert_eq!(
            prose(book).unwrap(),
            "Iris will book the 2 rooms by Friday if Sam approves the room plan."
        );
        let migrate = by_owner("Dev", "migrat");
        assert!(migrate.negated);
        assert_eq!(
            action(migrate).unwrap().0,
            "Do not migrate any data until Ben approves the residency appendix."
        );
        let send = by_owner("Leo", "send");
        let leo = vec!["Leo".to_string()];
        assert!(covers(
            "Leo will send the export report by Tuesday after rerunning the 3 failing checks.",
            send,
            &leo
        ));
        assert!(!covers(
            "Leo will send the export report by Tuesday after fixing the 3 failing checks.",
            send,
            &leo
        ));
        assert_eq!(
            prose(send).unwrap(),
            "Leo will send the export report by Tuesday after Leo reruns the 3 failing checks."
        );
        let irrigation = found
            .iter()
            .find(|frame| frame.kind == FrameKind::Requirement)
            .unwrap();
        assert_eq!(
            prose(irrigation).unwrap(),
            "Irrigation must stay off until the leak test passes."
        );
        assert!(!found
            .iter()
            .any(|frame| frame.owner.as_deref() == Some("Leo") && frame.line_ids == vec!["L8"]));
        assert!(
            !found
                .iter()
                .any(|frame| templatable(frame)
                    && (frame.verb == "explain" || frame.verb == "commit"))
        );
    }

    #[test]
    fn possibilities_prerequisites_subjects_and_qualifiers_keep_their_roles() {
        let lines: Vec<TrustedLine> = [
            ("I can explain the projector setup, but I am not committing to bring equipment.", "Noah"),
            ("I'll review the quote by March 8 if procurement confirms the seat count.", "Ben"),
            ("Dev will update the residency appendix by March 7. The data must stay in Canada, not the US.", "Asha"),
            ("The proposed 80-seat price is $29 per seat per month only with an annual contract. Monthly billing stays at $32.", "Asha"),
            ("We might grow to 80 seats, but procurement has not approved the increase.", "Ben"),
        ]
        .iter()
        .enumerate()
        .map(|(at, (text, speaker))| line(&format!("L{}", at + 1), text, Some(speaker)))
        .collect();
        let found = source_frames(&lines);
        let names: Vec<String> = ["Noah", "Ben", "Dev", "Asha"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        for (claim, expected) in [
            ("The projector setup will be explained by Noah.", Some("possibility_as_commitment")),
            ("Noah can explain the projector setup.", None),
            ("Noah committed to bringing equipment.", Some("negation_changed")),
            ("The team will grow to 80 seats.", Some("possibility_as_commitment")),
            ("Ben said the team might grow to 80 seats.", None),
            ("Ben will confirm the seat count by March 8th.", Some("condition_as_commitment")),
            ("Procurement will confirm the seat count.", Some("condition_as_commitment")),
            ("Ben will review the quote by March 8 if procurement confirms the seat count.", None),
            ("The residency appendix must remain in Canada, not the US.", Some("commitment_mixed")),
            ("The data must remain in Canada, not the US.", None),
            ("Procurement confirms the seat count.", Some("condition_as_commitment")),
            ("The quote will be reviewed by March 8 if procurement confirms the seat count by Friday.", Some("date_changed")),
            ("The appendix will be updated by March 7.", None),
            ("The contract will be updated by March 7.", Some("commitment_object_changed")),
        ] {
            assert_eq!(claim_violation(claim, &found, &names), expected, "{claim}");
        }
        for (claim, expected) in [
            ("The trial will have 80 seats.", None),
            ("The next step is to monitor procurement.", Some("next_step_not_stated")),
            ("The proposed price will be $29 per seat per month only with an annual contract.", Some("tense_changed")),
            ("The proposed 80-seat option is $29 per seat per month with monthly billing at $32.", Some("qualifier_dropped")),
            ("The proposed 80-seat price is $29 per seat per month with an annual contract.", None),
            ("The workshop has an initial budget of $32.", Some("qualifier_not_supported")),
            ("Monthly billing stays at $32.", None),
            ("The proposed 80-seat price is $29 per seat with an annual contract, and monthly billing stays at $32.", None),
            ("Monthly billing for the proposed annual contract stays at $32.", Some("number_relation_not_supported")),
        ] {
            let source = super::super::source_claims::SourceClaims::new(&lines, &found, &names);
            assert_eq!(
                qualifier_violation(claim, &lines).or_else(|| source.violation(claim)),
                expected,
                "{claim}"
            );
        }
        assert!(!found
            .iter()
            .any(|frame| templatable(frame) && frame.verb == "explain"));
    }

    #[test]
    fn later_corrections_move_the_commitment_date() {
        // A bare correction by the same speaker.
        let found = frames(&[
            (
                "I'll post the picker job ads on Tuesday once Bram approves the budget.",
                Some("Dara"),
            ),
            ("Correction: Thursday, not Tuesday.", Some("Dara")),
        ]);
        let post = found.iter().find(|frame| frame.verb == "post").unwrap();
        assert_eq!(
            post.date_key.as_deref(),
            Some("thursday"),
            "{:?}",
            debug_frames(&found)
        );
        assert_eq!(
            prose(post).unwrap(),
            "Dara will post the picker job ads on Thursday once Bram approves the budget."
        );
        // Another speaker names the commitment.
        let found = frames(&[
            (
                "I'll submit the grant report on Tuesday only if Maren signs the budget page.",
                Some("Lior"),
            ),
            (
                "Correction: Lior submits the report on Thursday, not Tuesday.",
                Some("Maren"),
            ),
        ]);
        let submit = found.iter().find(|frame| frame.verb == "submit").unwrap();
        assert_eq!(submit.date_key.as_deref(), Some("thursday"));
        let names = vec!["Lior".to_string(), "Maren".to_string()];
        assert_eq!(
            claim_violation(
                "Lior will submit the grant report on Tuesday only if Maren signs the budget page.",
                &found,
                &names
            ),
            Some("date_changed")
        );
        // A month day, with the preposition kept.
        let found = frames(&[
            (
                "We agreed to book the stage crew for May 18 if the council grants the permit.",
                Some("Quinn"),
            ),
            (
                "Correction: we book the stage crew for May 19, not May 18.",
                Some("Sami"),
            ),
        ]);
        let book = found.iter().find(|frame| frame.verb == "book").unwrap();
        assert_eq!(
            prose(book).unwrap(),
            "We agreed to book the stage crew for May 19 if the council grants the permit."
        );
        // A correction that fits two commitments decides neither.
        let found = frames(&[
            (
                "I'll send the plan on Tuesday. I'll review the budget on Tuesday.",
                Some("Ana"),
            ),
            ("Correction: Thursday, not Tuesday.", Some("Ana")),
        ]);
        assert!(found
            .iter()
            .filter(|frame| frame.date_key.as_deref() == Some("tuesday"))
            .all(|frame| frame.conflict));
    }

    #[test]
    fn corrections_without_a_comma_or_a_rejected_date_still_apply() {
        let found = frames(&[
            ("I'll send Fenna the route sheet by the 9th.", Some("Aksel")),
            (
                "Deliveries: I need the route sheet by the 8th. Not the 9th, Aksel.",
                Some("Fenna"),
            ),
        ]);
        let send = found.iter().find(|frame| frame.verb == "send").unwrap();
        assert_eq!(
            send.date_key.as_deref(),
            Some("8"),
            "{:?}",
            debug_frames(&found)
        );
        let found = frames(&[
            ("I'll order the new chairs by the 9th.", Some("Kofi")),
            (
                "One correction, so Kofi orders the chairs by the sixteen instead.",
                Some("Wren"),
            ),
        ]);
        let order = found.iter().find(|frame| frame.verb == "order").unwrap();
        assert_eq!(
            order.date_key.as_deref(),
            Some("16"),
            "{:?}",
            debug_frames(&found)
        );
        let found = frames(&[
            (
                "I'll send Fenna the route sheet by the ninth.",
                Some("Aksel"),
            ),
            (
                "Deliveries: I need the route sheet by the eighth not the ninth Aksel.",
                Some("Fenna"),
            ),
        ]);
        let send = found.iter().find(|frame| frame.verb == "send").unwrap();
        assert_eq!(
            send.date_key.as_deref(),
            Some("8"),
            "{:?}",
            debug_frames(&found)
        );
        assert!(send.line_ids.contains(&"L2".to_string()));
        let found = frames(&[
            ("I'll order the new chairs by the 9th.", Some("Kofi")),
            ("Furniture: one correction, the supplier is closed that week, so Kofi orders the chairs by the 16th instead.", Some("Wren")),
            ("Fine, the 16th.", Some("Kofi")),
        ]);
        let order = found.iter().find(|frame| frame.verb == "order").unwrap();
        assert_eq!(
            order.date_key.as_deref(),
            Some("16"),
            "{:?}",
            debug_frames(&found)
        );
    }

    #[test]
    fn r4_corrections_confirmations_and_task_verbs() {
        let found = frames(&[(
            "I'll recruit six timekeepers by the 19th. Wait, not the 19th. The 21st.",
            Some("Kemal"),
        )]);
        assert_eq!(
            found[0].date_key.as_deref(),
            Some("21"),
            "{:?}",
            debug_frames(&found)
        );
        let found = frames(&[
            (
                "I'll send the results to the league secretary by the 27th.",
                Some("Lowri"),
            ),
            ("After Benedikt has checked them.", Some("Lowri")),
        ]);
        assert_eq!(
            found[0].condition.as_deref(),
            Some("After Benedikt has checked them"),
            "{:?}",
            debug_frames(&found)
        );
        let medals = frames(&[(
            "I won't order medals until the entry count is final.",
            Some("Benedikt"),
        )]);
        assert_eq!(
            claim_violation(
                "The entry count will determine when medals will be ordered.",
                &medals,
                &["Benedikt".to_string()]
            ),
            Some("condition_dropped")
        );
        // "cancel" as a task verb does not retract the meeting.
        let found = frames(&[
            ("I'll move the Hartley Street job to Thursday. Actually, make that Friday, because the big van is in the shop on Thursday.", Some("Calla")),
            ("Once we cancel Dexter, I'll switch dispatch to the shared calendar.", Some("Calla")),
        ]);
        let moved = found.iter().find(|frame| frame.verb == "mov").unwrap();
        assert_eq!(
            moved.date_key.as_deref(),
            Some("friday"),
            "{:?}",
            debug_frames(&found)
        );
        assert_eq!(moved.core, "move the Hartley Street job");
        assert!(found
            .iter()
            .any(|frame| frame.verb == "switch" && usable(frame)));
        let found = frames(&[(
            "I'll recruit six timekeepers by the 19th. Wait, not the 19th, the 21st.",
            Some("Kemal"),
        )]);
        assert_eq!(
            found[0].date_key.as_deref(),
            Some("21"),
            "{:?}",
            debug_frames(&found)
        );
        let found = frames(&[(
            "I'll recruit six timekeepers by the nineteenth wait, the twenty-first.",
            Some("Kemal"),
        )]);
        assert_eq!(
            found[0].core,
            "recruit six timekeepers",
            "{:?}",
            debug_frames(&found)
        );
        assert_eq!(found[0].date_key.as_deref(), Some("21"));
        let found = frames(&[
            ("Editor's desk: we'll send the autumn issue to the printer on the 9th unless the council notice arrives late.", Some("Odette")),
            ("Let me correct that: the printer moved our slot, so we send it on the 11th.", Some("Linus")),
        ]);
        assert_eq!(
            found[0].date_key.as_deref(),
            Some("11"),
            "{:?}",
            debug_frames(&found)
        );
        // A speaker's confirmation states the other person's commitment.
        let found = frames(&[(
            "Rota check: I can confirm that Rafe will cover the weekend emergency line starting Saturday until Tullia returns from leave.",
            Some("Imogen"),
        )]);
        let cover = found.iter().find(|frame| frame.verb == "cover").unwrap();
        assert_eq!(
            cover.owner.as_deref(),
            Some("Rafe"),
            "{:?}",
            debug_frames(&found)
        );
        assert_eq!(cover.date_key.as_deref(), Some("saturday"));
        // "sends me" in a first-person condition names the speaker.
        let found = frames(&[(
            "I'll collect the remaining ad payments by Friday, provided that Odette sends me the invoice list.",
            Some("Fen"),
        )]);
        assert_eq!(
            prose(&found[0]).unwrap(),
            "Fen will collect the remaining ad payments by Friday provided that Odette sends Fen the invoice list."
        );
    }

    #[test]
    fn run_on_objects_and_partial_conditions_are_not_the_commitment() {
        let found = frames(&[(
            "I'll update the seat count by Friday right now we use 48 seats.",
            Some("Joren"),
        )]);
        let update = found.iter().find(|frame| frame.verb == "updat").unwrap();
        assert_eq!(update.core, "update the seat count");
        let found = frames(&[(
            "We agreed to release Tobin on the 22nd once the payment test passes.",
            None,
        )]);
        let names = Vec::new();
        assert_eq!(
            claim_violation(
                "Tobin will be released on the 22nd once the test passes.",
                &found,
                &names
            ),
            Some("condition_dropped")
        );
        assert_eq!(
            claim_violation(
                "Tobin will be released on the 22nd once the payment test passes.",
                &found,
                &names
            ),
            None
        );
    }

    #[test]
    fn weekday_modifiers_are_not_deadlines() {
        let found = frames(&[(
            "I'll take the Friday rota if Rosa approves the swap.",
            Some("Hana"),
        )]);
        assert_eq!(found[0].date, None, "{:?}", debug_frames(&found));
        assert_eq!(
            prose(&found[0]).unwrap(),
            "Hana will take the Friday rota if Rosa approves the swap."
        );
        let names = vec!["Hana".to_string(), "Rosa".to_string()];
        assert_eq!(
            claim_violation(
                "Hana will take the Friday rota if Rosa approves the swap.",
                &found,
                &names
            ),
            None
        );
        assert_eq!(
            claim_violation(
                "Hana will take the rota on Friday if Rosa approves the swap.",
                &found,
                &names
            ),
            Some("date_changed")
        );
    }

    #[test]
    fn owner_variants_merge_to_the_observed_spelling() {
        let found = frames(&[
            ("Meeting record. PRIA will review the launch notes on Friday if the memory gate passes.", None),
            ("Meeting record, Priya will review the launch notes on Friday if the memory gate passes.", None),
        ]);
        assert_eq!(found.len(), 1, "{:?}", debug_frames(&found));
        assert_eq!(found[0].owner.as_deref(), Some("Priya"));
        assert_eq!(
            prose(&found[0]).unwrap(),
            "Priya will review the launch notes on Friday if the memory gate passes."
        );
    }

    #[test]
    #[ignore = "debugging aid: FRAMES_DEBUG_LINES is a JSON array of [text, speaker]"]
    fn debug_frames_for_lines() {
        let rows: Vec<(String, Option<String>)> =
            serde_json::from_str(&std::env::var("FRAMES_DEBUG_LINES").unwrap()).unwrap();
        let texts: Vec<(&str, Option<&str>)> = rows
            .iter()
            .map(|(t, s)| (t.as_str(), s.as_deref()))
            .collect();
        let lines: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(at, (t, s))| line(&format!("L{}", at + 1), t, *s))
            .collect();
        println!(
            "labels {:?}",
            super::super::summary_verification::source_labels(&lines.iter().collect::<Vec<_>>())
        );
        for line in &lines {
            println!(
                "tokens {:?}",
                tokens(&line.text, 0)
                    .iter()
                    .map(|t| t.lower.clone())
                    .collect::<Vec<_>>()
            );
        }
        for frame in debug_frames(&frames(&texts)) {
            println!("{frame:?}");
        }
    }

    #[test]
    fn disfluency_cleanup_keeps_meaning_words() {
        assert_eq!(
            cleaned_text("we um agreed to, you know, ship the the beta so on the 14th"),
            "we agreed to, ship the beta on the 14th"
        );
        assert_eq!(
            cleaned_text("I'll send it so that Ben can review"),
            "I'll send it so that Ben can review"
        );
        assert_eq!(cleaned_text("not not ship"), "not ship");
    }
}
