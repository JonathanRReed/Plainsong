//! Inverse text normalization (ITN) for dictation.
//!
//! Turns spoken numbers into written form -- "twelve dollars fifty" into
//! "$12.50", "march third at three thirty pm" into "March 3 at 3:30 pm",
//! "one hundred twenty three" into "123". Parakeet TDT v3 and the LLM
//! decoders mostly emit numerals already; whisper tiny/base, Moonshine and
//! several cloud outputs do not, and every engine is inconsistent about
//! currency, dates and times. This stage makes the local pipeline agree with
//! itself regardless of which engine produced the words.
//!
//! Deliberately *not* the mirror image of
//! `IntelligentPunctuator::format_numbers`, which spells small digits back
//! out as words and is off in every dictation config.
//!
//! ## Why this is hand-written rather than a crate
//!
//! `text-processing-rs` 0.2.2 (FluidInference, Apache-2.0, one non-optional
//! dependency -- `lazy_static`, already in this lockfile) was evaluated
//! first; see the commit that added this file for the full transcript. It
//! fails several of the ambiguities dictation has to survive: "one of them"
//! became "1 of them", "seven eighty eight" became "95" (7 + 88), a ten-digit
//! phone run became "5551 2345 06:07", "the first of may" became "1 may",
//! "three thirty" became "03:30" with no time context at all, and it rewrites
//! spoken punctuation itself ("comma" -> " , ") in a way that collides with
//! `normalize_spoken_punctuation`. The rules below are narrower on purpose:
//! anything ambiguous stays as the user said it.
//!
//! ## Bounds (documented, tested)
//!
//! - A bare "one" is never converted -- "one of them", "one drive is full".
//! - Two number groups that do not compose ("two thirty", "twenty twenty
//!   six", "nineteen eighty four") stay as words unless a time or date rule
//!   claims them.
//! - Simple ordinals ("first" .. "tenth") convert only in a date context.
//! - A number followed by "first" .. "tenth" ("three hundred and twenty
//!   second graders", "a thirty second timer") is one ordinal only where
//!   nothing can follow it as a noun: the end of the phrase, "of", or a
//!   short list of ordinal nouns ("century", "floor", "birthday"). Otherwise
//!   the whole phrase stays as words: neither "322nd graders" nor "320
//!   second graders" is safe to write.
//! - "<number> oh <digit>" is written only as a clock time, a year or an
//!   identifier, each with its own context ("it's ten oh five" -> "10:05",
//!   "in nineteen oh five" -> "1905", "flight fifteen oh eight" -> "flight
//!   1508"), and stays words otherwise.
//! - Units keep the user's word: "twenty five kilometers" -> "25 kilometers",
//!   never "25 km".
//! - All-or-nothing per phrase: a number phrase no single rule can finish
//!   stays entirely as words rather than coming out half-written. "ten to one
//!   odds", "point five" and an eight-digit spoken run are all left alone,
//!   because "10 to one odds", "point 5" and "1234 five six seven" are worse
//!   than the words the user said. A run containing a spoken "oh" is written
//!   whole ("room two oh one" -> "room 201") for the same reason: nothing
//!   else can consume the "oh". Likewise the tail of a number whose head
//!   stays a word is never written alone: "thousand two hundred forty
//!   dollars" (a lost "one") is not "thousand $240".
//! - Currency amounts read "a hundred"/"a thousand" as one hundred/thousand
//!   at the start of a sentence or after a word that introduces an amount
//!   ("costs", "came to", "about"), never in "half a million" or "like a
//!   million dollars". A recognizer's comma after "thousand"/"million" inside
//!   an amount ("one thousand, two hundred dollars") is a thousands
//!   separator, except after a time preposition ("In two thousand, five
//!   hundred dollars was a lot"), where the first number may be a year.
//! - Thousands separators are written the way the number would be typed:
//!   cardinals from 10,000 up ("75,000"), currency from 1,000 up ("$1,200"),
//!   years never. Whole millions and billions of money keep their word
//!   ("$3 million", "$3.2 million"); an amount spoken in full stays in full.
//! - A range whose head is a bare number shares the tail's scale and
//!   currency ("two to three million dollars" -> "$2 million to $3 million")
//!   or, when the head could mean either, stays words whole.
//! - Running the stage over already-numeric text is a no-op (idempotence).

use std::sync::LazyLock;

mod style;
pub use style::{numbers_as_words_protecting, voice_numbers_as_digits_protecting};

/// One whitespace-delimited chunk of the input, split into the punctuation
/// that brackets it and the word itself, so a rule can rewrite the word
/// without eating the comma after it.
#[derive(Debug, Clone)]
struct Token {
    space_before: String,
    lead: String,
    core: String,
    core_lower: String,
    trail: String,
    /// Inside a dictionary replacement, a URL/email/path, or otherwise
    /// opaque. Never rewritten, and never part of a numeric span.
    protected: bool,
}

impl Token {
    fn render(&self) -> String {
        format!(
            "{}{}{}{}",
            self.space_before, self.lead, self.core, self.trail
        )
    }
}

const LEAD_PUNCTUATION: &[char] = &['"', '\'', '(', '[', '{', '\u{201c}', '\u{2018}', '-'];
const TRAIL_PUNCTUATION: &[char] = &[
    '.', ',', '!', '?', ';', ':', ')', ']', '}', '"', '\'', '\u{201d}', '\u{2019}',
];

// ITN is a synchronous, allocation-heavy convenience pass, not a suitable
// parser for an arbitrarily large cloud response. Normal dictation is far
// smaller than this; leave unusually large transcripts untouched so a
// provider cannot monopolize the sidecar worker.
const MAX_ITN_INPUT_BYTES: usize = 64 * 1024;

/// A token that must never be rewritten and must never be crossed by a
/// numeric span: URLs, emails, file paths, hosts, and anything else carrying
/// an internal dot next to letters (`a.m.`, `docs.google.com`).
fn token_is_opaque(core: &str) -> bool {
    if core.contains("://") || core.contains('@') || core.contains('/') || core.contains('\\') {
        return true;
    }
    core.contains('.') && core.chars().any(|ch| ch.is_ascii_alphabetic())
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut pending_space = String::new();
    let mut current = String::new();

    let push = |tokens: &mut Vec<Token>, chunk: &str, space_before: &str| {
        if chunk.is_empty() {
            return;
        }
        let lead: String = chunk
            .chars()
            .take_while(|ch| LEAD_PUNCTUATION.contains(ch))
            .collect();
        let rest = &chunk[lead.len()..];
        let trail_len = rest
            .chars()
            .rev()
            .take_while(|ch| TRAIL_PUNCTUATION.contains(ch))
            .map(char::len_utf8)
            .sum::<usize>();
        let (core, trail) = rest.split_at(rest.len() - trail_len);
        let core_lower = core.to_lowercase();
        tokens.push(Token {
            space_before: space_before.to_string(),
            lead,
            core: core.to_string(),
            core_lower,
            trail: trail.to_string(),
            protected: token_is_opaque(core),
        });
    };

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !current.is_empty() {
                push(&mut tokens, &current, &pending_space);
                current.clear();
                pending_space.clear();
            }
            pending_space.push(ch);
        } else {
            current.push(ch);
        }
    }
    if current.is_empty() {
        if !pending_space.is_empty() {
            // Trailing whitespace is preserved by attaching it to an empty
            // sentinel token so `render` round-trips the original string.
            tokens.push(Token {
                space_before: pending_space.clone(),
                lead: String::new(),
                core: String::new(),
                core_lower: String::new(),
                trail: String::new(),
                protected: true,
            });
        }
    } else {
        push(&mut tokens, &current, &pending_space);
    }

    tokens
}

/// Marks every token overlapping an occurrence of one of `phrases` as
/// protected. Used for dictionary replacements and snippet triggers, whose
/// text is the user's own and must survive this stage verbatim.
///
/// A match only counts when it starts and ends on a token boundary. Without
/// that anchor a short replacement splits a word it merely appears inside --
/// a one-letter entry like "v" matched the middle of "five" and protected
/// that token alone, so "twenty five servers" came out "20 five servers".
/// Both the core and the outer (punctuation-inclusive) edges are accepted, so
/// a replacement that carries its own punctuation ("U.S.") still anchors.
fn mark_protected_phrases(text: &str, tokens: &mut [Token], phrases: &[String]) {
    mark_protected_phrases_matching(text, tokens, phrases, false);
}

fn mark_protected_phrases_matching(
    text: &str,
    tokens: &mut [Token],
    phrases: &[String],
    case_insensitive: bool,
) {
    if phrases.is_empty() {
        return;
    }

    // Recompute token byte ranges over the rendered string, which is
    // byte-identical to `text` by construction.
    let mut ranges = Vec::with_capacity(tokens.len());
    let mut boundary_starts = Vec::with_capacity(tokens.len() * 2);
    let mut boundary_ends = Vec::with_capacity(tokens.len() * 2);
    let mut cursor = 0usize;
    for token in tokens.iter() {
        let outer_start = cursor + token.space_before.len();
        let start = outer_start + token.lead.len();
        let end = start + token.core.len();
        let outer_end = end + token.trail.len();
        cursor = outer_end;
        ranges.push((start, end));
        boundary_starts.push(outer_start);
        boundary_starts.push(start);
        boundary_ends.push(end);
        boundary_ends.push(outer_end);
    }

    for phrase in phrases {
        let needle = phrase.trim();
        if needle.is_empty() {
            continue;
        }
        let pattern = if case_insensitive {
            match regex::RegexBuilder::new(&regex::escape(needle))
                .case_insensitive(true)
                .build()
            {
                Ok(pattern) => Some(pattern),
                Err(_) => {
                    // If protection cannot be checked, leave the text alone.
                    for token in tokens.iter_mut() {
                        token.protected = true;
                    }
                    return;
                }
            }
        } else {
            None
        };
        let mut from = 0usize;
        while from <= text.len() {
            let found = match &pattern {
                Some(pattern) => pattern
                    .find(&text[from..])
                    .map(|found| (from + found.start(), from + found.end())),
                None => text[from..]
                    .find(needle)
                    .map(|found| (from + found, from + found + needle.len())),
            };
            let Some((start, end)) = found else {
                break;
            };
            if boundary_starts.binary_search(&start).is_ok()
                && boundary_ends.binary_search(&end).is_ok()
            {
                // Ranges are ordered. Start at the first token whose core
                // ends after the match starts, then visit only overlapping
                // tokens instead of rescanning the complete transcript for
                // every occurrence.
                let first = ranges.partition_point(|(_, token_end)| *token_end <= start);
                for (offset, (token_start, _)) in ranges[first..].iter().enumerate() {
                    if *token_start >= end {
                        break;
                    }
                    tokens[first + offset].protected = true;
                }
                from = end;
            } else {
                // Step past this false match by one character rather than by
                // the whole needle, so a real match that overlaps it is still
                // found. `start` and the character length keep `from` on a
                // char boundary.
                from = start + text[start..].chars().next().map_or(1, char::len_utf8);
            }
            if from >= text.len() {
                break;
            }
        }
    }
}

fn unit_value(word: &str) -> Option<u64> {
    Some(match word {
        "zero" => 0,
        "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        _ => return None,
    })
}

fn teen_value(word: &str) -> Option<u64> {
    Some(match word {
        "ten" => 10,
        "eleven" => 11,
        "twelve" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        _ => return None,
    })
}

fn tens_value(word: &str) -> Option<u64> {
    Some(match word {
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fourty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    })
}

fn scale_value(word: &str) -> Option<u64> {
    Some(match word {
        "thousand" => 1_000,
        "million" => 1_000_000,
        "billion" => 1_000_000_000,
        _ => return None,
    })
}

fn ordinal_value(word: &str) -> Option<u64> {
    Some(match word {
        "first" => 1,
        "second" => 2,
        "third" => 3,
        "fourth" => 4,
        "fifth" => 5,
        "sixth" => 6,
        "seventh" => 7,
        "eighth" => 8,
        "ninth" => 9,
        "tenth" => 10,
        "eleventh" => 11,
        "twelfth" => 12,
        "thirteenth" => 13,
        "fourteenth" => 14,
        "fifteenth" => 15,
        "sixteenth" => 16,
        "seventeenth" => 17,
        "eighteenth" => 18,
        "nineteenth" => 19,
        "twentieth" => 20,
        "thirtieth" => 30,
        "fortieth" => 40,
        "fiftieth" => 50,
        "sixtieth" => 60,
        "seventieth" => 70,
        "eightieth" => 80,
        "ninetieth" => 90,
        "hundredth" => 100,
        "thousandth" => 1_000,
        "millionth" => 1_000_000,
        _ => return None,
    })
}

/// The hyphens a decoder puts inside a spoken compound: ASCII hyphen-minus
/// and the non-breaking hyphen U+2011 that several cloud decoders emit.
const COMPOUND_HYPHENS: &[char] = &['-', '\u{2011}'];

/// Splits "twenty-one" / "twenty\u{2011}one" into its two halves.
fn split_compound(word: &str) -> Option<(&str, &str)> {
    let index = word.find(COMPOUND_HYPHENS)?;
    let (head, rest) = word.split_at(index);
    let tail = &rest[rest.chars().next()?.len_utf8()..];
    Some((head, tail))
}

/// A hyphenated tens-and-unit cardinal arriving as one token ("twenty-one").
/// The ordinal form ("twenty-first") has always been handled in
/// `parse_ordinal`; the cardinal form was not, so "twenty-one servers" came
/// out unchanged while "twenty one servers" became "21 servers".
fn hyphenated_tens_unit(word: &str) -> Option<u64> {
    let (head, tail) = split_compound(word)?;
    let tens = tens_value(head)?;
    let unit = unit_value(tail)?;
    if unit == 0 {
        return None;
    }
    Some(tens + unit)
}

fn is_number_word(word: &str) -> bool {
    unit_value(word).is_some()
        || teen_value(word).is_some()
        || tens_value(word).is_some()
        || scale_value(word).is_some()
        || hyphenated_tens_unit(word).is_some()
        || word == "hundred"
}

/// Digits with thousands separators, the way the number would be typed.
fn group_digits(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (offset, digit) in digits.chars().enumerate() {
        if offset > 0 && (digits.len() - offset).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// A standalone cardinal. Separators start at 10,000: a four-digit number
/// spoken as a cardinal reads as a year or a build number ("two thousand and
/// twenty six") at least as often as it does a quantity, and "2,026" would be
/// wrong for those. Years never reach here -- `try_date` formats them itself.
fn format_cardinal(value: u64) -> String {
    if value >= 10_000 {
        group_digits(value)
    } else {
        value.to_string()
    }
}

/// A currency amount. Money is written with separators from four digits up
/// ("$1,200"), where the year reading that holds bare cardinals back does not
/// apply.
fn format_currency_amount(value: u64) -> String {
    if value >= 1_000 {
        group_digits(value)
    } else {
        value.to_string()
    }
}

fn month_index(word: &str) -> Option<(usize, &'static str)> {
    let months = [
        ("january", "January"),
        ("february", "February"),
        ("march", "March"),
        ("april", "April"),
        ("may", "May"),
        ("june", "June"),
        ("july", "July"),
        ("august", "August"),
        ("september", "September"),
        ("october", "October"),
        ("november", "November"),
        ("december", "December"),
    ];
    months
        .iter()
        .position(|(lower, _)| *lower == word)
        .map(|index| (index + 1, months[index].1))
}

/// Month names that are also ordinary English words, so a date rule needs a
/// stronger signal than "month followed by a number" before it fires.
const MONTHS_THAT_ARE_ALSO_WORDS: &[&str] = &["march", "may", "august"];

/// Words that make a following month name a date rather than a verb or an
/// auxiliary: the prepositions that take a date, plus "the" ("the may fifth
/// deadline"). Deliberately short -- anything not listed leaves an
/// ordinary-word month needing one of the other signals in `try_date`.
const DATE_CONTEXT_WORDS: &[&str] = &[
    "on", "by", "until", "till", "since", "from", "before", "after", "in", "through", "the",
];

/// Ordinals that keep an ordinary-word reading straight after an
/// ordinary-word month even at the head of a phrase: "May first, we ship" and
/// "March second!" are sentences, "March third" is a date.
fn ordinal_doubles_as_an_ordinary_word(value: u64) -> bool {
    value == 1 || value == 2
}

/// True when `index` opens the phrase: the first token, or the first after
/// sentence or clause punctuation. A month at the head of a phrase is far
/// likelier to be a date than a verb -- "March third" against "we march
/// third".
fn at_phrase_start(tokens: &[Token], index: usize) -> bool {
    match index
        .checked_sub(1)
        .and_then(|previous| tokens.get(previous))
    {
        None => true,
        Some(previous) => {
            previous.core.is_empty()
                || previous
                    .trail
                    .chars()
                    .any(|ch| matches!(ch, '.' | ',' | '!' | '?' | ';' | ':'))
        }
    }
}

fn ordinal_suffix(value: u64) -> &'static str {
    match (value % 100, value % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    }
}

fn is_meridiem(word: &str) -> bool {
    matches!(word, "am" | "pm" | "a.m" | "p.m" | "a.m." | "p.m.")
}

/// Recognizers write a spoken clock time as bare digits: "move the call from
/// 445 to 315". Only with strong evidence does this become "4:45 to 3:15": a
/// time preposition before the number, a valid hour (1-12) and minute, and
/// either am/pm or a scheduling word elsewhere in the sentence, and nothing
/// after it but punctuation or a word that can follow a time, so "at 445 Main
/// Street" and "445 attendees at 315 tables" stay as written.
pub fn render_clock_digits(text: &str) -> String {
    static RANGE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(from|between)\s+(\d{3,4})\s+(to|and|until|till)\s+(\d{3,4})\b")
            .expect("clock range pattern")
    });
    static SINGLE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(at|by|until|till|around)\s+(\d{3,4})\b(\s*(?:a\.?m\.?|p\.?m\.?)\b)?",
        )
        .expect("clock single pattern")
    });
    static SCHEDULING: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(call|calls|meeting|meetings|meet|appointment|standup|stand-up|sync|lunch|dinner|breakfast|flight|train|class|interview|demo|o'clock|tomorrow|today|tonight|morning|afternoon|evening)\b")
            .expect("scheduling pattern")
    });
    let clock = |digits: &str| -> Option<String> {
        let value: u32 = digits.parse().ok()?;
        let (hour, minute) = (value / 100, value % 100);
        ((1..=12).contains(&hour) && minute < 60).then(|| format!("{hour}:{minute:02}"))
    };
    let mut output = String::with_capacity(text.len());
    for sentence in text.split_inclusive(['.', '!', '?', '\n']) {
        let scheduled = SCHEDULING.is_match(sentence);
        let ranged = RANGE.replace_all(sentence, |captures: &regex::Captures<'_>| {
            let end = captures.get(0).map_or(0, |m| m.end());
            match (scheduled, clock(&captures[2]), clock(&captures[4])) {
                (true, Some(from), Some(to)) if !clock_blocked_after(&sentence[end..]) => {
                    format!("{} {from} {} {to}", &captures[1], &captures[3])
                }
                _ => captures[0].to_string(),
            }
        });
        let ranged = ranged.into_owned();
        let single = SINGLE.replace_all(&ranged, |captures: &regex::Captures<'_>| {
            let end = captures.get(0).map_or(0, |m| m.end());
            let meridiem = captures.get(3).map(|m| m.as_str());
            // "by 150" and "around 1215" are as often amounts and years as
            // times, so those two prepositions need am/pm.
            let needs_meridiem = matches!(captures[1].to_lowercase().as_str(), "by" | "around");
            match clock(&captures[2]) {
                Some(time)
                    if (meridiem.is_some() || (scheduled && !needs_meridiem))
                        && !clock_blocked_after(&ranged[end..]) =>
                {
                    format!("{} {time}{}", &captures[1], meridiem.unwrap_or(""))
                }
                _ => captures[0].to_string(),
            }
        });
        output.push_str(&single);
    }
    render_clock_digits_in_context(&output)
}

/// [`render_clock_digits`] for recognizer text that may hold dictionary
/// output or snippet triggers. A protected phrase with a digit in it leaves
/// the whole dictation's bare digits as written.
pub fn render_clock_digits_protecting(text: &str, protected_phrases: &[String]) -> String {
    match protected_ranges(text, protected_phrases) {
        Some(ranges)
            if !ranges.iter().any(|range| {
                text[range.clone()]
                    .bytes()
                    .any(|byte| byte.is_ascii_digit())
            }) =>
        {
            render_clock_digits(text)
        }
        _ => text.to_string(),
    }
}

/// The two weaker readings of bare clock digits, in a dictation that
/// mentions no quantity: a weekday right before the preposition ("by Friday
/// at 445, not Thursday") with round minutes, and a spelled-out zone after
/// the number when the sentence already paired an am/pm time with one
/// ("9:30 a.m. Pacific, which is 1230 Eastern").
fn render_clock_digits_in_context(text: &str) -> String {
    static WEEKDAY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+(?:morning|afternoon|evening|night))?\s+(?:at|by|until|till)\s+(\d{3,4})\b")
            .expect("weekday clock pattern")
    });
    static ZONED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\b(\d{3,4})[ \t]+(?:Eastern|Pacific|Central|Mountain)\b")
            .expect("zoned clock pattern")
    });
    // A second number joined to the first ("at 445 to 515") is a range this
    // rule does not decide.
    static PARTNER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^[ \t]*(?:(?:to|and|or|until|till|through)[ \t]+|[-–][ \t]*)\d")
            .expect("clock partner pattern")
    });
    let clock = |digits: &str| -> Option<(u32, String)> {
        let value: u32 = digits.parse().ok()?;
        let (hour, minute) = (value / 100, value % 100);
        ((1..=12).contains(&hour) && minute < 60).then(|| (minute, format!("{hour}:{minute:02}")))
    };
    if text.len() > MAX_ITN_INPUT_BYTES || mentions_a_quantity(text) {
        return text.to_string();
    }
    let mut output = String::with_capacity(text.len());
    for sentence in split_clock_sentences(text) {
        let mut rewrites: Vec<(std::ops::Range<usize>, String)> = Vec::new();
        for captures in WEEKDAY.captures_iter(sentence) {
            let digits = captures.get(1).expect("digits");
            let rest = &sentence[digits.end()..];
            if let Some((minute, time)) = clock(digits.as_str()) {
                if minute % 5 == 0 && weekday_time_ends_phrase(rest) && !PARTNER.is_match(rest) {
                    rewrites.push((digits.range(), time));
                }
            }
        }
        if zone_conversion_anchor(sentence) {
            for captures in ZONED.captures_iter(sentence) {
                let (whole, digits) = (
                    captures.get(0).expect("match"),
                    captures.get(1).expect("digits"),
                );
                let continues_before = sentence[..digits.start()]
                    .chars()
                    .next_back()
                    .is_some_and(|ch| matches!(ch, '$' | '€' | '£' | '.' | ',' | '-' | '/' | '#'));
                if continues_before
                    || follows_an_identifier_noun(&sentence[..digits.start()])
                    || dotted_clock_blocked_after(&sentence[whole.end()..])
                {
                    continue;
                }
                if let Some((_, time)) = clock(digits.as_str()) {
                    if !rewrites
                        .iter()
                        .any(|(range, _)| range.start == digits.start())
                    {
                        rewrites.push((digits.range(), time));
                    }
                }
            }
        }
        rewrites.sort_by_key(|(range, _)| range.start);
        let mut copied = 0;
        for (range, time) in rewrites {
            output.push_str(&sentence[copied..range.start]);
            output.push_str(&time);
            copied = range.end;
        }
        output.push_str(&sentence[copied..]);
    }
    output
}

/// Recognizers trained on British text write a spoken clock time with a dot:
/// "the meeting from 3.15 to 4.30", "9.30am". Read in US English that is a
/// decimal, so the dot becomes a colon and nothing else changes. A version,
/// price, rate, dose, lab value or race time looks exactly the same, and the
/// words around it ("Friday at", "the call at", "lunch at") are no reliable
/// guide, so a dotted number becomes a time only with explicit evidence right
/// next to it. A missed conversion leaves what the recognizer wrote; a wrong
/// one changes the meaning.
///
/// - am/pm directly after it. Glued ("9.30am") or dotted ("4.45 p.m.", any
///   case) always counts. A spaced "am"/"pm" counts only before the end,
///   punctuation, a time zone or a lowercase word that can follow a time
///   ("tomorrow", "on", "sharp"), and never in a dictation that mentions a
///   quantity: German "3.11 am Montag" is "on Monday" and "4.50 am
///   höchsten" is "at the highest".
/// - an unambiguous zone abbreviation directly after it ("4.45 EST", "14.30
///   UTC"), in a dictation that mentions no quantity. "BST", "MT", "CT" and
///   the spelled-out zones are units and street names too ("2.50 MT of
///   steel", "9.30 Central Avenue").
/// - a meeting noun directly before a time preposition: "the meeting from",
///   "the interview is at", "our sync's at". Only meeting, appointment,
///   interview, standup, sync, demo, kickoff, webinar, lecture and class;
///   "call" is also an option, "session" a market, and meals, "free",
///   "available" and day words are said beside prices and lab values just as
///   often. The minutes must be a multiple of five and the dictation must
///   not mention a quantity.
///
/// Zones and meeting nouns also need the number to end its phrase ("at 4.45
/// Main Street" is an address, "at 12.50 a head" a price). Numbers joined as
/// a range or list ("from 3.15 to 4.30", "4.45-5.15", "1.15, 1.30 and 1.45")
/// are decided as one unit: all convert or none does. A group converts when a
/// meeting noun introduces it, or when its last member has am/pm or a zone
/// that the earlier ones share ("from 3.15 to 4.30pm"). Hours run 1-12 (0-23
/// before a zone) and minutes 00-59, a number that continues ("4.45.2",
/// "$4.45", "v3.15") is never touched, and neither is a protected phrase (a
/// dictionary replacement or snippet trigger). Runs with smart formatting
/// whether or not numbers are written as digits: the recognizer already
/// wrote digits.
pub fn render_dotted_clock_times(text: &str) -> String {
    render_dotted_clock_times_protecting(text, &[])
}

/// [`render_dotted_clock_times`], leaving every occurrence of a protected
/// phrase (matched case-insensitively) exactly as written.
pub fn render_dotted_clock_times_protecting(text: &str, protected_phrases: &[String]) -> String {
    static CANDIDATE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\b(\d{1,2})\.(\d{2})").expect("dotted clock pattern"));
    static ZONE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\s+(?:EST|EDT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|CET|CEST)\b")
            .expect("zone pattern")
    });
    // A meeting noun, then "is", "was" or "'s", then the preposition.
    static MEETING_BEFORE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:meeting|appointment|interview|standup|stand-up|sync|demo|kickoff|webinar|lecture|class)(?:['’]s|\s+is|\s+was)?\s+(?:at|from|until|by|to)\s+$")
            .expect("meeting context pattern")
    });
    // A spelled-out zone right after the number: "12.30 Eastern".
    static SPELLED_ZONE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[ \t]+(?:Eastern|Pacific|Central|Mountain)\b")
            .expect("spelled zone pattern")
    });
    // An am/pm or zone right after a range or list member ("3.15 pm to
    // 4.30"), skipped when deciding whether two numbers are joined.
    static MEMBER_MARK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[ \t]*(?:(?i:a\.m\.?|p\.m\.?|am|pm)|EST|EDT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|CET|CEST)\b\.?")
            .expect("member mark pattern")
    });
    // Between two numbers decided as one unit: a range, a list or a
    // contrast ("4.15, not 4.30").
    static JOIN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^(?:\s+(?:to|and|or|until|till|through)\s+|\s*,\s*(?:(?:and|or|not)\s+)?|\s*[-–]\s*)$",
        )
        .expect("join pattern")
    });

    if text.len() > MAX_ITN_INPUT_BYTES {
        return text.to_string();
    }
    let Some(protected) = protected_ranges(text, protected_phrases) else {
        return text.to_string();
    };
    // One mention of a price, version, rate or reading anywhere makes every
    // zone, spaced am/pm and meeting-noun reading suspect: "Version 3.11 is
    // out. The demo is at 3.15."
    let quantity_talk = mentions_a_quantity(text);

    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Meridiem,
        Zone,
    }

    struct Candidate {
        start: usize,
        end: usize,
        hour: u32,
        minute: u32,
        /// "0.30" is a decimal even before a zone; "00.30 UTC" is a time.
        single_zero: bool,
        valid: bool,
        /// A dash right before ("-5.15"): only a range's second end.
        dash_before: bool,
        /// A dash and a digit right after ("4.45-5"): only a range's first end.
        dash_after: bool,
    }

    let mut output = String::with_capacity(text.len());
    for sentence in split_clock_sentences(text) {
        let offset = sentence.as_ptr() as usize - text.as_ptr() as usize;
        let candidates: Vec<Candidate> = CANDIDATE
            .captures_iter(sentence)
            .map(|captures| {
                let whole = captures.get(0).expect("whole match");
                let before = &sentence[..whole.start()];
                let after = &sentence[whole.end()..];
                let (hour, minute) = (
                    captures[1].parse::<u32>().unwrap_or(99),
                    captures[2].parse::<u32>().unwrap_or(60),
                );
                let mut before_chars = before.chars().rev();
                let (previous, before_previous) = (before_chars.next(), before_chars.next());
                let dash_before = matches!(previous, Some('-' | '–'))
                    && before_previous.is_some_and(|ch| ch.is_ascii_digit());
                let continues_before = !dash_before
                    && previous.is_some_and(|ch| {
                        ch.is_alphanumeric()
                            || matches!(ch, '$' | '€' | '£' | '.' | ',' | '-' | '–' | '/')
                    });
                let mut after_chars = after.chars();
                let (next, after_next) = (after_chars.next(), after_chars.next());
                let continues_after = match (next, after_next) {
                    (Some(ch), _)
                        if ch.is_alphanumeric() && !matches!(ch, 'a' | 'p' | 'A' | 'P') =>
                    {
                        true
                    }
                    (Some('.' | ',' | ':'), Some(next)) => next.is_ascii_digit(),
                    (Some('%'), _) => true,
                    _ => false,
                };
                let dash_after = matches!(next, Some('-' | '–'))
                    && after_next.is_some_and(|ch| ch.is_ascii_digit());
                let (start, end) = (offset + whole.start(), offset + whole.end());
                let shielded = protected
                    .iter()
                    .any(|range| range.start < end && start < range.end);
                Candidate {
                    start: whole.start(),
                    end: whole.end(),
                    hour,
                    minute,
                    single_zero: &captures[1] == "0",
                    valid: hour <= 23
                        && minute <= 59
                        && !continues_before
                        && !continues_after
                        && !shielded,
                    dash_before,
                    dash_after,
                }
            })
            .collect();

        // am/pm or a zone directly after a number.
        let mark_after = |end: usize| {
            let after = &sentence[end..];
            if dotted_meridiem_follows(after, quantity_talk) {
                return Some(Mark::Meridiem);
            }
            ZONE.find(after)
                .filter(|zone| !quantity_talk && !dotted_clock_blocked_after(&after[zone.end()..]))
                .map(|_| Mark::Zone)
        };
        let hour_fits = |member: &Candidate, mark: Option<Mark>| match mark {
            Some(Mark::Zone) => !member.single_zero,
            _ => (1..=12).contains(&member.hour),
        };

        let mut converted = Vec::new();
        let mut index = 0;
        while index < candidates.len() {
            let mut last = index;
            while candidates.get(last + 1).is_some_and(|next| {
                let gap = &sentence[candidates[last].end..next.start];
                let gap = MEMBER_MARK.find(gap).map_or(gap, |mark| &gap[mark.end()..]);
                JOIN.is_match(gap)
            }) {
                last += 1;
            }
            let group = &candidates[index..=last];
            let (first, final_member) = (&group[0], &group[group.len() - 1]);
            let joined = group.iter().all(|member| member.valid)
                && !first.dash_before
                && !final_member.dash_after;
            // The last member's am/pm or zone covers the members without
            // their own: "from 3.15 to 4.30pm".
            let shared = mark_after(final_member.end);
            let marked = shared.is_some()
                && group
                    .iter()
                    .all(|member| hour_fits(member, mark_after(member.end).or(shared)));
            let round_hours = group
                .iter()
                .all(|member| member.minute % 5 == 0 && hour_fits(member, None));
            let introduced = !quantity_talk
                && MEETING_BEFORE.is_match(&sentence[..first.start])
                && round_hours
                && !dotted_clock_blocked_after(&sentence[final_member.end..]);
            let scheduled_on_a_day = !quantity_talk
                && weekday_introduces_a_time(&sentence[..first.start])
                && round_hours
                && weekday_time_ends_phrase(&sentence[final_member.end..]);
            let zoned = !quantity_talk
                && zone_conversion_anchor(sentence)
                && !follows_an_identifier_noun(&sentence[..first.start])
                && SPELLED_ZONE
                    .find(&sentence[final_member.end..])
                    .is_some_and(|zone| {
                        !dotted_clock_blocked_after(&sentence[final_member.end + zone.end()..])
                    })
                && group.iter().all(|member| hour_fits(member, None));
            if joined && (marked || introduced || scheduled_on_a_day || zoned) {
                converted.extend(group);
            }
            index = last + 1;
        }

        let mut copied = 0;
        for candidate in converted {
            let dotted = &sentence[candidate.start..candidate.end];
            output.push_str(&sentence[copied..candidate.start]);
            output.push_str(&dotted.replacen('.', ":", 1));
            copied = candidate.end;
        }
        output.push_str(&sentence[copied..]);
    }
    output
}

/// am/pm right after a dotted number. Glued ("9.30am") or dotted ("4.45
/// p.m.") always counts. Spaced ("4.45 pm") is also German "am" (on), so it
/// counts only where an English meridiem would: before the end, punctuation,
/// a zone or a lowercase word, and not in a dictation about a quantity.
/// "Python 3.11 am Montag" and "12.30 am I right" stay.
fn dotted_meridiem_follows(after: &str, quantity_talk: bool) -> bool {
    static GLUED: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^(?i:am|pm)\b").expect("glued meridiem pattern"));
    static DOTTED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[ \t]*(?i:a\.m|p\.m)\b").expect("dotted meridiem pattern")
    });
    static SPACED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[ \t]+(?i:am|pm)\b").expect("spaced meridiem pattern")
    });
    static ZONE_WORD: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^(?:EST|EDT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|BST|CET|CEST|ET|PT|CT|MT|Eastern|Pacific|Central|Mountain)\b")
            .expect("zone word pattern")
    });
    if GLUED.is_match(after) || DOTTED.is_match(after) {
        return true;
    }
    let Some(spaced) = SPACED.find(after) else {
        return false;
    };
    if quantity_talk {
        return false;
    }
    let rest = after[spaced.end()..].trim_start_matches([' ', '\t']);
    match rest.chars().next() {
        None => true,
        Some(ch) if ch.is_lowercase() => !dotted_clock_blocked_after(rest),
        Some(ch) if ch.is_alphanumeric() => ZONE_WORD.is_match(rest),
        Some(_) => true,
    }
}

/// A dotted time ends its phrase. Anything else after the digits ("tables",
/// "Main Street", "a head", "am Montag") means they were a quantity, an
/// address or not English. Unlike [`clock_blocked_after`], a bare "a"/"p" or
/// "am"/"pm" is no exception here: a real am/pm is found before this check.
fn dotted_clock_blocked_after(rest: &str) -> bool {
    let next = rest.trim_start();
    let word: String = next
        .chars()
        .take_while(|ch| ch.is_alphabetic() || *ch == '\'')
        .collect();
    if word.is_empty() {
        return next.starts_with(['%', '$']) || next.starts_with(char::is_numeric);
    }
    !matches!(
        word.to_lowercase().as_str(),
        "today"
            | "tomorrow"
            | "tonight"
            | "on"
            | "with"
            | "for"
            | "and"
            | "or"
            | "then"
            | "sharp"
            | "instead"
            | "works"
            | "is"
            | "please"
            | "if"
            | "so"
            | "but"
            | "to"
            | "until"
            | "till"
    )
}

/// A day of the week directly before a time preposition: "by Friday at",
/// "Monday morning from", "Tuesday until". "Today", "tomorrow" and "tonight"
/// are left out on purpose: lab values and quotes are read out "today at" as
/// often as meetings are set ("Free T4 today at 1.10").
fn weekday_introduces_a_time(before: &str) -> bool {
    static WEEKDAY_BEFORE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+(?:morning|afternoon|evening|night))?\s+(?:at|by|from|until|till)\s+$")
            .expect("weekday context pattern")
    });
    WEEKDAY_BEFORE.is_match(before)
}

/// What may follow a time a weekday introduced. Stricter than
/// [`dotted_clock_blocked_after`]: "with tip", "on Kindle" or ", 2 people"
/// after "Friday at 1.15" read as a price or a count.
fn weekday_time_ends_phrase(rest: &str) -> bool {
    let next = rest.trim_start_matches([' ', '\t']);
    let Some(first) = next.chars().next() else {
        return true;
    };
    if first == ',' {
        let after_comma = next[1..].trim_start();
        return !after_comma.starts_with(|ch: char| ch.is_ascii_digit() || ch == '$');
    }
    if matches!(first, '.' | '!' | '?' | ';' | ')' | '\n') {
        return true;
    }
    let word: String = next
        .chars()
        .take_while(|ch| ch.is_alphabetic() || *ch == '\'')
        .collect();
    matches!(
        word.to_lowercase().as_str(),
        "not"
            | "and"
            | "or"
            | "then"
            | "sharp"
            | "instead"
            | "to"
            | "until"
            | "till"
            | "if"
            | "so"
            | "but"
            | "please"
            | "works"
    )
}

fn starts_with_spelled_zone(text: &str) -> bool {
    let rest = text.trim_start_matches([' ', '\t']);
    ["Eastern", "Pacific", "Central", "Mountain"]
        .iter()
        .any(|zone| {
            rest.strip_prefix(zone)
                .is_some_and(|after| !after.starts_with(char::is_alphanumeric))
        })
}

/// A number that labels something: "chapter 12.30", "room 1230".
fn follows_an_identifier_noun(before: &str) -> bool {
    let previous = before
        .trim_end()
        .rsplit(|ch: char| !ch.is_alphabetic())
        .next()
        .unwrap_or("")
        .to_lowercase();
    IDENTIFIER_NOUNS.contains(&previous.as_str())
        || matches!(
            previous.as_str(),
            "chapter"
                | "section"
                | "verse"
                | "figure"
                | "table"
                | "step"
                | "item"
                | "no"
                | "platform"
                | "track"
                | "exit"
                | "line"
        )
}

/// A sentence that already gives one time with am/pm and a spelled-out zone
/// ("9.30am Pacific", "9:30 a.m. Pacific"). Only then is a spelled-out zone
/// after another number a time zone too: "which is 12.30 Eastern". On its own
/// "Central" or "Pacific" is as often a street, a region or a team.
fn zone_conversion_anchor(sentence: &str) -> bool {
    static ANCHOR: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\b(?:\d{1,2}[:.]\d{2}|\d{1,4})[ \t]*(?i:a\.m\.?|p\.m\.?|am\b|pm\b)[ \t]*(?:Eastern|Pacific|Central|Mountain)\b")
            .expect("zone anchor pattern")
    });
    ANCHOR.is_match(sentence)
}

/// Whether a dictation mentions a price, version, rate, trade, result, dose
/// or unit anywhere. Such a dictation gives no weaker clock evidence (a zone
/// word, a spaced am/pm, a meeting noun or a weekday) any weight.
fn mentions_a_quantity(text: &str) -> bool {
    static QUANTITY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)[$€£¥%]|\b(?:dollars?|bucks|cents?|pounds?|euros?|sterling|percent|per cent|per|prices?|priced|pricing|prix|preis|kurs|costs?|costing|paid|pay|payment|invoice|bill|fees?|rates?|shares?|stocks?|bonds?|yields?|index|opened|closed|closing|traded|trades?|trading|mortgage|odds|put|puts|strike|options?|buy|buying|bought|sell|selling|sold|roll|rolled|rolling|premiums?|contracts?|expiry|expiration|expires?|expired|expiring|bid|bids|ask|asks|eps|revenue|earnings|came in|came back|won|wins|winning|finished|placed|ranked|topped|clocked|fares?|economy|business class|first class|scores?|scored|points?|rating|grade|gpa|versions?|python|node|swift|rust|golang|ruby|ios|macos|kubernetes|k8s|release[sd]?|upgrade[sd]?|upgrading|downgrade[sd]?|downgrading|rollback|roll back|rolled back|migrate[sd]?|migrating|migration|deploy|deploys|deployed|deploying|builds?|patch|patches|patched|bump|api|sdk|cluster|gas|ratio|dose|doses|dosage|mg|ml|multiplier|inflation|eggs|tickets?|kg|km|lbs?|miles?|meters?|tons?|seconds?|minutes?|hours?|degrees?|weight|weighed|weighs|temperature|average|a head|a person|a gallon)\b")
            .expect("quantity pattern")
    });
    // "long" and "short" are positions unless a meeting word follows ("a
    // short meeting at 3.30").
    static POSITION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:long|short)\b(?:\s+(\w+))?").expect("position pattern")
    });
    QUANTITY.is_match(text)
        || POSITION.captures_iter(text).any(|captures| {
            !captures.get(1).is_some_and(|next| {
                matches!(
                    next.as_str().to_lowercase().as_str(),
                    "meeting"
                        | "meetings"
                        | "sync"
                        | "chat"
                        | "break"
                        | "session"
                        | "walk"
                        | "lunch"
                        | "notice"
                        | "trip"
                        | "flight"
                        | "drive"
                        | "ride"
                        | "day"
                        | "night"
                        | "week"
                        | "weekend"
                        | "time"
                        | "stand"
                )
            })
        })
}

/// Byte ranges of every case-insensitive occurrence of a protected phrase,
/// or `None` when one cannot be searched for (then nothing is touched).
fn protected_ranges(text: &str, phrases: &[String]) -> Option<Vec<std::ops::Range<usize>>> {
    let mut ranges = Vec::new();
    for phrase in phrases {
        let needle = phrase.trim();
        if needle.is_empty() {
            continue;
        }
        let pattern = regex::RegexBuilder::new(&regex::escape(needle))
            .case_insensitive(true)
            .build()
            .ok()?;
        ranges.extend(pattern.find_iter(text).map(|found| found.range()));
    }
    Some(ranges)
}

/// Sentences for the clock rules. A full stop between two digits ("4.45") or
/// inside "a.m." does not end one.
fn split_clock_sentences(text: &str) -> Vec<&str> {
    let mut sentences = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (index, ch) in text.char_indices() {
        if !matches!(ch, '.' | '!' | '?' | '\n') {
            continue;
        }
        if ch == '.' {
            let previous = index.checked_sub(1).map(|at| bytes[at]);
            let next = bytes.get(index + 1).copied();
            if previous.is_some_and(|byte| byte.is_ascii_digit())
                && next.is_some_and(|byte| byte.is_ascii_digit())
            {
                continue;
            }
            if next.is_some_and(|byte| byte.is_ascii_alphabetic())
                || previous.is_some_and(|byte| matches!(byte, b'a' | b'p' | b'A' | b'P'))
                    && next.is_some_and(|byte| matches!(byte, b'm' | b'M'))
            {
                continue;
            }
            // "9:30 a.m. Pacific" goes on: the zone belongs to the time.
            if previous.is_some_and(|byte| matches!(byte, b'm' | b'M'))
                && index >= 2
                && bytes[index - 2] == b'.'
                && starts_with_spelled_zone(&text[index + 1..])
            {
                continue;
            }
        }
        sentences.push(&text[start..index + ch.len_utf8()]);
        start = index + ch.len_utf8();
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    sentences
}

/// A time ends its phrase. Anything else after the digits ("tables",
/// "Main Street", "dollars") means they were a quantity or an address.
fn clock_blocked_after(rest: &str) -> bool {
    let next = rest.trim_start();
    let word: String = next
        .chars()
        .take_while(|ch| ch.is_alphabetic() || *ch == '\'')
        .collect();
    if word.is_empty() {
        return next.starts_with(['%', '$']) || next.starts_with(char::is_numeric);
    }
    !matches!(
        word.to_lowercase().as_str(),
        "today"
            | "tomorrow"
            | "tonight"
            | "on"
            | "with"
            | "for"
            | "and"
            | "or"
            | "then"
            | "sharp"
            | "instead"
            | "works"
            | "is"
            | "please"
            | "if"
            | "so"
            | "but"
            | "to"
            | "until"
            | "till"
            | "am"
            | "pm"
            | "a"
            | "p"
    )
}

/// Prepositions that make a bare "three thirty" a clock time rather than two
/// numbers. Deliberately short: without one of these (or an am/pm marker),
/// "three thirty" stays as words.
const TIME_CONTEXT_WORDS: &[&str] = &["at", "around", "by", "until", "till"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Piece {
    None,
    Unit,
    Teen,
    Tens,
    Hundred,
    Scale,
}

/// True when the span may extend from `index - 1` to `index`: punctuation
/// or a line break between the two words ends the number, so "twenty, thirty" is two numbers
/// and "twenty (five" is never merged into one.
fn span_continues(tokens: &[Token], start: usize, index: usize) -> bool {
    if index <= start {
        return true;
    }
    match (tokens.get(index - 1), tokens.get(index)) {
        (Some(previous), Some(current)) => {
            previous.trail.is_empty()
                && current.lead.is_empty()
                && !current.space_before.contains(['\n', '\r'])
        }
        _ => false,
    }
}

/// Every token a rewrite consumes has to be joined to the next without
/// intervening punctuation. `emit_rewrite` keeps only the first token's lead
/// and the last token's trail, so anything between them would be silently
/// dropped -- "ten per (cent" became "10%" and lost the paren. Each rule
/// checks its own boundaries; this is the backstop that holds the invariant
/// for rules added later.
fn span_is_contiguous(tokens: &[Token], start: usize, end: usize) -> bool {
    (start + 1..end).all(|index| span_continues(tokens, start, index))
}

/// Parses one English cardinal starting at `start`.
///
/// Returns the value and the index just past the last consumed token, or
/// `None` when `start` does not begin a number. The grammar is strict on
/// purpose: a unit may not be followed by a tens word ("seven eighty" is two
/// numbers, not 95), and a tens word may not be followed by another tens word
/// ("twenty twenty" is two numbers, not a year -- unless the date rule says
/// otherwise).
/// Number of words in the first spoken cardinal, excluding adjacent numbers
/// that do not compose into the same value. Used to bound spoken corrections.
pub(crate) fn spoken_cardinal_prefix_len(text: &str) -> Option<usize> {
    parse_cardinal(&tokenize(text), 0).map(|(_, end)| end)
}

fn parse_cardinal(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
    parse_cardinal_from(tokens, start, false)
}

/// "a hundred and fifty", "a thousand two hundred": the article stands for
/// "one", but only directly before "hundred" or a scale word. Used for
/// currency amounts only, where the unit makes the reading unambiguous;
/// elsewhere "a hundred people" and "thanks a million" stay as words. The
/// article must also open the sentence or follow a word that introduces an
/// amount (`introduces_an_amount`): "half a million dollars", "a quarter of
/// a million dollars" and "feel like a million dollars" are not one million.
fn parse_cardinal_with_article(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
    let article_allowed = tokens
        .get(start)
        .is_some_and(|token| token.core_lower != "a")
        || start == 0
        || tokens.get(start - 1).is_some_and(|previous| {
            if !span_continues(tokens, start - 1, start) {
                // Only a sentence end before the article; "half, a million"
                // and "(a million" are not clear amounts.
                return previous.trail.ends_with(['.', '!', '?', ':'])
                    && tokens[start].lead.is_empty();
            }
            !previous.protected && introduces_an_amount(&previous.core_lower)
        });
    parse_cardinal_from(tokens, start, article_allowed)
}

/// Words after which "a hundred"/"a thousand"/"a million" is a stated amount
/// rather than part of a fraction ("half a million") or an idiom ("like a
/// million dollars").
fn introduces_an_amount(word: &str) -> bool {
    matches!(
        word,
        "paid"
            | "pay"
            | "pays"
            | "paying"
            | "cost"
            | "costs"
            | "costing"
            | "raised"
            | "raise"
            | "spent"
            | "spend"
            | "charged"
            | "charge"
            | "charges"
            | "earned"
            | "owe"
            | "owes"
            | "owed"
            | "saved"
            | "budgeted"
            | "is"
            | "was"
            | "be"
            | "to"
            | "for"
            | "about"
            | "around"
            | "nearly"
            | "almost"
            | "over"
            | "under"
            | "roughly"
            | "approximately"
            | "exactly"
            | "just"
            | "only"
            | "than"
    )
}

fn is_scale_or_hundred(word: &str) -> bool {
    word == "hundred" || scale_value(word).is_some()
}

fn parse_cardinal_from(
    tokens: &[Token],
    start: usize,
    article_counts_as_one: bool,
) -> Option<(u64, usize)> {
    let mut total: u64 = 0;
    let mut current: u64 = 0;
    let mut last = Piece::None;
    let mut last_scale = u64::MAX;
    let mut index = start;
    let mut end = start;

    while index < tokens.len() {
        let token = &tokens[index];
        if token.protected || token.core.is_empty() {
            break;
        }
        if !span_continues(tokens, start, index) {
            break;
        }
        let word = token.core_lower.as_str();

        if article_counts_as_one
            && index == start
            && word == "a"
            && span_continues(tokens, start, start + 1)
            && tokens
                .get(start + 1)
                .is_some_and(|next| !next.protected && is_scale_or_hundred(&next.core_lower))
        {
            current = 1;
            last = Piece::Unit;
            index += 1;
            end = index;
            continue;
        }

        if word == "and" {
            if end == start || !matches!(last, Piece::Hundred | Piece::Scale) {
                break;
            }
            index += 1;
            continue;
        }

        if let Some(value) = unit_value(word) {
            match last {
                Piece::None => {
                    current = value;
                    last = Piece::Unit;
                }
                Piece::Tens if current.is_multiple_of(10) && value >= 1 => {
                    current += value;
                    last = Piece::Unit;
                }
                Piece::Hundred | Piece::Scale => {
                    current += value;
                    last = Piece::Unit;
                }
                _ => break,
            }
        } else if let Some(value) = teen_value(word) {
            match last {
                Piece::None => {
                    current = value;
                    last = Piece::Teen;
                }
                Piece::Hundred | Piece::Scale => {
                    current += value;
                    last = Piece::Teen;
                }
                _ => break,
            }
        } else if let Some(value) = tens_value(word) {
            match last {
                Piece::None => {
                    current = value;
                    last = Piece::Tens;
                }
                Piece::Hundred | Piece::Scale => {
                    current += value;
                    last = Piece::Tens;
                }
                _ => break,
            }
        } else if let Some(value) = hyphenated_tens_unit(word) {
            // "twenty-one" is one token but two pieces; it closes on a unit,
            // so "twenty-one five" stays two numbers exactly as "twenty one
            // five" does.
            match last {
                Piece::None => {
                    current = value;
                    last = Piece::Unit;
                }
                Piece::Hundred | Piece::Scale => {
                    current += value;
                    last = Piece::Unit;
                }
                _ => break,
            }
        } else if word == "hundred" {
            match last {
                Piece::Unit | Piece::Teen | Piece::Tens if current > 0 => {
                    current *= 100;
                    last = Piece::Hundred;
                }
                _ => break,
            }
        } else if let Some(scale) = scale_value(word) {
            if end == start || current == 0 || scale >= last_scale {
                break;
            }
            total += current * scale;
            current = 0;
            last_scale = scale;
            last = Piece::Scale;
        } else {
            break;
        }

        index += 1;
        end = index;
    }

    if end == start {
        return None;
    }
    Some((total + current, end))
}

/// A cardinal that occupies exactly the token range it was asked for, used
/// where a rule needs "one word" or "at most two words" (clock minutes,
/// year halves) rather than an arbitrary-length number.
fn parse_cardinal_bounded(
    tokens: &[Token],
    start: usize,
    max_tokens: usize,
) -> Option<(u64, usize)> {
    let (value, end) = parse_cardinal(tokens, start)?;
    if end - start > max_tokens {
        return None;
    }
    Some((value, end))
}

/// "oh five" / "o five" -> 5, the spoken form for a leading zero in clock
/// times and years.
fn parse_oh_digit(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
    let first = tokens.get(start)?;
    if first.protected || !matches!(first.core_lower.as_str(), "oh" | "o") {
        return None;
    }
    if !span_continues(tokens, start, start + 1) {
        return None;
    }
    let second = tokens.get(start + 1)?;
    if second.protected {
        return None;
    }
    let value = unit_value(&second.core_lower)?;
    Some((value, start + 2))
}

/// Digits spoken one at a time ("five five five one two three ...").
fn single_digit_run(tokens: &[Token], start: usize) -> (String, usize) {
    let mut digits = String::new();
    let mut index = start;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.protected || !span_continues(tokens, start, index) {
            break;
        }
        let chunk: Option<String> = token
            .core_lower
            .split('-')
            .map(|word| match word {
                "oh" => Some('0'),
                other => unit_value(other).and_then(|value| char::from_digit(value as u32, 10)),
            })
            .collect();
        let Some(chunk) = chunk else { break };
        digits.push_str(&chunk);
        index += 1;
    }
    (digits, index)
}

struct Rewrite {
    text: String,
    end: usize,
}

/// A phone-number-shaped run of individually spoken digits. Seven digits is
/// the shortest run that is far more likely to be a number than a count.
///
/// Only the three lengths that have a written phone shape are claimed: local
/// (7), national (10) and national with a leading country code (11). Any
/// other length -- 8, 9, 12 -- is not a phone number in any format this stage
/// knows, and collapsing it into an unseparated blob was a guess, so those
/// runs are left as the words the user said.
fn try_phone(tokens: &[Token], start: usize) -> Option<Rewrite> {
    let (digits, end) = single_digit_run(tokens, start);
    let formatted = match digits.len() {
        7 => format!("{}-{}", &digits[..3], &digits[3..]),
        10 => format!("{}-{}-{}", &digits[..3], &digits[3..6], &digits[6..]),
        11 if digits.starts_with('1') => format!(
            "{}-{}-{}-{}",
            &digits[..1],
            &digits[1..4],
            &digits[4..7],
            &digits[7..]
        ),
        _ => return None,
    };
    Some(Rewrite {
        text: formatted,
        end,
    })
}

/// A short run of individually spoken digits containing a spoken zero: "room
/// two oh one" is room 201.
///
/// "oh" only means zero inside a digit string, so a run that contains one is
/// a digit string and is written whole -- the alternative was the half-
/// converted "room 2 oh one", since no other rule can consume an "oh". A
/// leading "oh" is excluded because that one is the interjection. Bounded to
/// 3..=6 digits: `try_phone` runs first and owns the phone lengths, and a run
/// of any other length stays as words.
fn try_digit_string(tokens: &[Token], start: usize) -> Option<Rewrite> {
    let (digits, end) = single_digit_run(tokens, start);
    if !(3..=6).contains(&digits.len()) {
        return None;
    }
    if tokens[start].core_lower == "oh" {
        return None;
    }
    if !tokens[start..end]
        .iter()
        .any(|token| token.core_lower == "oh")
    {
        return None;
    }
    Some(Rewrite { text: digits, end })
}

/// A four-digit year, either composed ("two thousand and twenty six") or
/// spoken as two halves ("twenty twenty six", "nineteen eighty four").
fn parse_year(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
    if let Some((value, end)) = parse_cardinal(tokens, start) {
        if (1000..=2999).contains(&value) && end - start >= 2 {
            return Some((value, end));
        }
    }

    let (high, after_high) = parse_cardinal_bounded(tokens, start, 1)?;
    if !(10..=29).contains(&high) {
        return None;
    }
    if !span_continues(tokens, start, after_high) {
        return None;
    }
    if let Some((low, end)) = parse_oh_digit(tokens, after_high) {
        return Some((high * 100 + low, end));
    }
    let (low, end) = parse_cardinal_bounded(tokens, after_high, 2)?;
    // The second half of a spoken year reads as a two-digit number:
    // "twenty twenty six" is 2026, but "march twenty five" is a day, not
    // 2005. Anything under ten only reaches a year through the "oh" form
    // handled above.
    if !(10..=99).contains(&low) {
        return None;
    }
    Some((high * 100 + low, end))
}

/// `<month> [the] [day] [year]` and `[the] <ordinal> of <month> [year]`.
fn try_date(tokens: &[Token], start: usize) -> Option<Rewrite> {
    if let Some(rewrite) = try_ordinal_of_month(tokens, start) {
        return Some(rewrite);
    }

    let token = tokens.get(start)?;
    if token.protected {
        return None;
    }
    let (_, month_label) = month_index(&token.core_lower)?;
    // May, March and August are also ordinary English words, so "month
    // followed by a number" is not evidence enough on its own: "i may second
    // that motion", "we may first go", "i march second in the parade" and "we
    // march five miles" are not dates. Such a month takes a day only with one
    // of these signals, and the guard covers the ordinal branch as well as the
    // cardinal one (it used to sit on the cardinal branch alone, which is how
    // "i may second that motion" became "i May 2 that motion"):
    //
    //   * a year after the day          -- "march five twenty twenty six"
    //   * a date word before the month  -- "on may fifth", "by march third"
    //   * an explicit "the" before the day -- "may the fourth"
    //   * a clock time after the day    -- "meet march third at three thirty pm"
    //   * the month opens the phrase    -- "march third"
    //
    // The last of those is not enough for "first" and "second", which keep
    // their ordinary reading at the head of a phrase ("May first, we ship").
    // A *cardinal* day after such a month always needs the year: "we march
    // five miles" has no second signal available to tell it from a date.
    let month_is_also_an_ordinary_word =
        MONTHS_THAT_ARE_ALSO_WORDS.contains(&token.core_lower.as_str());
    let preceded_by_a_date_word = start
        .checked_sub(1)
        .and_then(|previous| tokens.get(previous))
        .is_some_and(|previous| {
            !previous.protected && DATE_CONTEXT_WORDS.contains(&previous.core_lower.as_str())
        });
    let month_opens_the_phrase = at_phrase_start(tokens, start);

    let mut index = start + 1;
    let mut day: Option<u64> = None;
    let mut year: Option<u64> = None;

    // The year is tried first, because the two readings of the words right
    // after a month overlap: in "march twenty twenty six" the "twenty" opens
    // a year, in "march twenty five" it opens a day. Only a well-formed year
    // ("twenty twenty six", "nineteen eighty four", "two thousand and twenty
    // six") wins that race; everything else falls through to the day.
    if span_continues(tokens, start, index) {
        if let Some((value, end)) = parse_year(tokens, index) {
            year = Some(value);
            index = end;
        }
    }

    if year.is_none() && span_continues(tokens, start, index) {
        let mut day_start = index;
        let mut explicit_the = false;
        if tokens
            .get(day_start)
            .is_some_and(|next| !next.protected && next.core_lower == "the")
            && span_continues(tokens, start, day_start + 1)
        {
            day_start += 1;
            explicit_the = true;
        }
        let parsed_day = parse_ordinal(tokens, day_start)
            .filter(|(value, _)| (1..=31).contains(value))
            .filter(|(value, end)| {
                if !month_is_also_an_ordinary_word || explicit_the || preceded_by_a_date_word {
                    return true;
                }
                if parse_year(tokens, *end).is_some() || followed_by_a_clock_time(tokens, *end) {
                    return true;
                }
                month_opens_the_phrase && !ordinal_doubles_as_an_ordinary_word(*value)
            })
            .or_else(|| {
                parse_cardinal_bounded(tokens, day_start, 2)
                    .filter(|(value, _)| (1..=31).contains(value))
                    // "i may one day get to it" is not the 1st of May, and "we
                    // march five miles" is not the 5th of March. A bare
                    // cardinal day after a month word that is also an ordinary
                    // English word needs a year behind it, full stop: unlike an
                    // ordinal it carries no shape of its own to lean on.
                    .filter(|(_, end)| {
                        !month_is_also_an_ordinary_word || parse_year(tokens, *end).is_some()
                    })
            });
        if let Some((value, end)) = parsed_day {
            day = Some(value);
            index = end;
        }

        if day.is_some() && span_continues(tokens, start, index) {
            if let Some((value, end)) = parse_year(tokens, index) {
                year = Some(value);
                index = end;
            }
        }
    }

    let text = match (day, year) {
        (Some(day), Some(year)) => format!("{} {}, {}", month_label, day, year),
        (Some(day), None) => format!("{} {}", month_label, day),
        (None, Some(year)) => format!("{} {}", month_label, year),
        (None, None) => return None,
    };

    Some(Rewrite { text, end: index })
}

/// "the first of may" -> "the 1st of May". Written out because it is the one
/// place a simple ordinal ("first" .. "tenth") is unambiguous enough to
/// convert.
fn try_ordinal_of_month(tokens: &[Token], start: usize) -> Option<Rewrite> {
    let (value, after_ordinal) = parse_ordinal(tokens, start)?;
    if !(1..=31).contains(&value) {
        return None;
    }
    if !span_continues(tokens, start, after_ordinal) {
        return None;
    }
    let of_token = tokens.get(after_ordinal)?;
    if of_token.protected || of_token.core_lower != "of" || !of_token.trail.is_empty() {
        return None;
    }
    // Punctuation between "of" and the month ends the phrase: "the first of
    // (May" must keep its paren, which a rewrite spanning the boundary would
    // drop.
    if !span_continues(tokens, start, after_ordinal + 1) {
        return None;
    }
    let month_token = tokens.get(after_ordinal + 1)?;
    if month_token.protected {
        return None;
    }
    let (_, month_label) = month_index(&month_token.core_lower)?;

    let mut index = after_ordinal + 2;
    let mut suffix = String::new();
    if month_token.trail.is_empty() && span_continues(tokens, start, index) {
        if let Some((year, end)) = parse_year(tokens, index) {
            suffix = format!(" {}", year);
            index = end;
        }
    }

    Some(Rewrite {
        text: format!(
            "{}{} of {}{}",
            value,
            ordinal_suffix(value),
            month_label,
            suffix
        ),
        end: index,
    })
}

/// A clock time straight after the day ("march third at three thirty pm") is
/// a date signal on its own: nothing but a date puts a time there, which is
/// what tells "let us meet march third at three thirty pm" from "i march
/// second in the parade".
fn followed_by_a_clock_time(tokens: &[Token], end: usize) -> bool {
    let after_a_preposition = tokens.get(end).is_some_and(|next| {
        !next.protected && TIME_CONTEXT_WORDS.contains(&next.core_lower.as_str())
    }) && try_time(tokens, end + 1, true).is_some();
    // The second form needs no preposition because it carries a meridiem.
    after_a_preposition || try_time(tokens, end, false).is_some()
}

/// Simple ("third"), tens ("twentieth") and compound ("twenty first")
/// ordinals. Returns the value and the index past the last token.
fn parse_ordinal(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
    let token = tokens.get(start)?;
    if token.protected {
        return None;
    }
    if let Some(tens) = tens_value(&token.core_lower) {
        if span_continues(tokens, start, start + 1) {
            if let Some(next) = tokens.get(start + 1) {
                if !next.protected {
                    if let Some(unit) = ordinal_value(&next.core_lower) {
                        if unit < 10 {
                            return Some((tens + unit, start + 2));
                        }
                    }
                }
            }
        }
        return None;
    }
    // Hyphenated compounds ("twenty-first") arrive as one token, with either
    // hyphen character (see `COMPOUND_HYPHENS`).
    if let Some((head, tail)) = split_compound(&token.core_lower) {
        if let (Some(tens), Some(unit)) = (tens_value(head), ordinal_value(tail)) {
            if unit < 10 {
                return Some((tens + unit, start + 1));
            }
        }
    }
    ordinal_value(&token.core_lower).map(|value| (value, start + 1))
}

/// The cardinal word an ordinal word stands for: "third" -> "three",
/// "twentieth" -> "twenty", "hundredth" -> "hundred", and a hyphenated
/// "sixty-third" -> "sixty-three".
fn ordinal_as_cardinal_word(word: &str) -> Option<String> {
    if let Some((head, tail)) = split_compound(word) {
        tens_value(head)?;
        let unit = ordinal_as_cardinal_word(tail)?;
        unit_value(&unit).filter(|value| *value > 0)?;
        return Some(format!("{head}-{unit}"));
    }
    let cardinal = match word {
        "first" => "one",
        "second" => "two",
        "third" => "three",
        "fourth" => "four",
        "fifth" => "five",
        "sixth" => "six",
        "seventh" => "seven",
        "eighth" => "eight",
        "ninth" => "nine",
        "tenth" => "ten",
        "eleventh" => "eleven",
        "twelfth" => "twelve",
        "thirteenth" => "thirteen",
        "fourteenth" => "fourteen",
        "fifteenth" => "fifteen",
        "sixteenth" => "sixteen",
        "seventeenth" => "seventeen",
        "eighteenth" => "eighteen",
        "nineteenth" => "nineteen",
        "twentieth" => "twenty",
        "thirtieth" => "thirty",
        "fortieth" => "forty",
        "fiftieth" => "fifty",
        "sixtieth" => "sixty",
        "seventieth" => "seventy",
        "eightieth" => "eighty",
        "ninetieth" => "ninety",
        "hundredth" => "hundred",
        "thousandth" => "thousand",
        "millionth" => "million",
        _ => return None,
    };
    Some(cardinal.to_string())
}

/// Nouns that take an ordinal and almost never a count followed by an
/// ordinal adjective, so "<tens> <first..ninth> <noun>" reads as one ordinal:
/// "the twenty first century", "his thirty second birthday", "the forty
/// second floor", "Forty Second Street", "the ninety ninth percentile".
///
/// Deliberately short. Left out on purpose because the count reading is
/// common: "time" ("two hundred and fifty first time buyers"), "place"
/// ("one hundred and fifty second place finishes"), "round", "row" ("twenty
/// first row seats"), "year" ("twenty first year students"), "grade",
/// "quarter", "half", "hand", "party", "class", "rate", and the duration
/// nouns that follow "second" ("a thirty second timer", "a sixty second
/// spot"). Plurals are left out for the same reason ("five hundred first
/// editions").
const ORDINAL_NOUNS: &[&str] = &[
    "century",
    "birthday",
    "anniversary",
    "floor",
    "street",
    "avenue",
    "amendment",
    "edition",
    "day",
    "week",
    "month",
    "night",
    "percentile",
];

/// True when nothing after the ordinal ending at `end` can make its last word
/// an adjective of its own: the ordinal ends the phrase (punctuation, a line
/// break or the end of the text), "of" follows ("the twenty first of May"),
/// or a noun from `ORDINAL_NOUNS` does.
fn ordinal_reading_is_settled(tokens: &[Token], end: usize) -> bool {
    let Some(next) = tokens.get(end) else {
        return true;
    };
    if next.core.is_empty() || !span_continues(tokens, end - 1, end) {
        return true;
    }
    !next.protected
        && (next.core_lower == "of" || ORDINAL_NOUNS.contains(&next.core_lower.as_str()))
}

/// What the main loop should do with an ordinal-shaped span.
enum OrdinalOutcome {
    /// Write the ordinal: `value` followed by its suffix, through `end`.
    Convert { value: u64, end: usize },
    /// The span is ambiguous and every written form asserts one reading
    /// ("three hundred and twenty second graders" is neither "322nd
    /// graders" nor "320 second graders" for sure): keep the words spoken.
    KeepWords { end: usize },
    /// Not an ordinal-shaped span; the other rules may take it.
    Decline,
}

/// Ordinals in running text: compound ones ("five hundred and sixty third",
/// "twenty first", "the one hundred twelfth floor"), single words above
/// tenth ("fifteenth") and hyphenated ones ("twenty-first").
///
/// A cardinal followed by an ordinal word has two readings when that word is
/// "first" .. "tenth": "three hundred and twenty second graders" is 320
/// second graders and "five hundred and sixty third night" the 563rd night.
/// Writing either one may change the meaning, so the merged reading is
/// taken only when nothing can follow the ordinal as a noun (see
/// `ordinal_reading_is_settled`), and otherwise the whole phrase stays as
/// the words spoken: a count in digits followed by the ordinal word ("320
/// second graders", "the 20 first item") asserts the other reading just as
/// firmly. The same holds for a teen or tens ordinal straight after
/// "hundred" or a scale ("two hundred twelfth graders"). With "and" in
/// between, a teen or tens tail ("seven hundred and eighteenth") has no
/// count reading and is always one ordinal. A "first" .. "tenth" word right
/// after "hundred" or a scale is never merged and stays words: "five hundred
/// first editions", "nineteen hundred Fifth Avenue". "hundredth", "thousandth" and "millionth" complete the cardinal
/// before them ("the five hundredth customer") except before "of", where the
/// phrase is a fraction ("one thousandth of an inch").
fn classify_ordinal(tokens: &[Token], start: usize) -> OrdinalOutcome {
    if let Some(outcome) = classify_compound_ordinal(tokens, start) {
        return outcome;
    }
    let Some(token) = tokens.get(start).filter(|token| !token.protected) else {
        return OrdinalOutcome::Decline;
    };
    // One hyphenated token ("twenty-first"). The hyphen rules out the count
    // reading for every tail but "second", which is also the duration noun:
    // "a thirty-second spot".
    if let Some((head, tail)) = split_compound(&token.core_lower) {
        if let (Some(tens), Some(unit)) = (tens_value(head), ordinal_value(tail)) {
            if unit < 10 {
                let end = start + 1;
                if tail == "second" && !ordinal_reading_is_settled(tokens, end) {
                    return OrdinalOutcome::KeepWords { end };
                }
                return OrdinalOutcome::Convert {
                    value: tens + unit,
                    end,
                };
            }
        }
        return OrdinalOutcome::Decline;
    }
    match ordinal_value(&token.core_lower) {
        Some(value) if standalone_ordinal_is_convertible(value) => OrdinalOutcome::Convert {
            value,
            end: start + 1,
        },
        _ => OrdinalOutcome::Decline,
    }
}

/// `<cardinal> [and] <ordinal word>` where the ordinal word completes the
/// cardinal. Returns `None` when the span does not have that shape.
fn classify_compound_ordinal(tokens: &[Token], start: usize) -> Option<OrdinalOutcome> {
    let (_, cardinal_end) = parse_cardinal(tokens, start)?;
    let joined_by_and = tokens
        .get(cardinal_end)
        .is_some_and(|token| !token.protected && token.core_lower == "and");
    let tail_index = cardinal_end + usize::from(joined_by_and);
    let tail = tokens.get(tail_index).filter(|token| !token.protected)?;
    let tail_cardinal = ordinal_as_cardinal_word(&tail.core_lower)?;
    let end = tail_index + 1;
    if !span_is_contiguous(tokens, start, end) {
        return None;
    }
    // Read the span with the ordinal word as its cardinal: the ordinal
    // belongs to the number only if that parses as one cardinal to the end.
    let mut probe = tokens[start..end].to_vec();
    probe.last_mut()?.core_lower = tail_cardinal;
    let (value, probe_end) = parse_cardinal(&probe, 0)?;
    if probe_end != probe.len() {
        return None;
    }

    let before_tail = tokens[cardinal_end - 1].core_lower.as_str();
    let after_multiplier = !joined_by_and && is_scale_or_hundred(before_tail);
    let tail_value = ordinal_value(&tail.core_lower);
    let settled = ordinal_reading_is_settled(tokens, end);
    let convert = OrdinalOutcome::Convert { value, end };
    // Neither reading may be written when the phrase is ambiguous: "322nd
    // graders" and "320 second graders" each assert one of them. The words
    // spoken carry both.
    let keep_words = OrdinalOutcome::KeepWords { end };
    Some(match tail_value {
        Some(100 | 1_000 | 1_000_000) => {
            let fraction = tokens
                .get(end)
                .is_some_and(|next| !next.protected && next.core_lower == "of");
            if fraction {
                OrdinalOutcome::KeepWords { end }
            } else {
                convert
            }
        }
        Some(11..=99) if joined_by_and => convert,
        Some(1..=10) if after_multiplier => keep_words,
        _ if settled => convert,
        _ => keep_words,
    })
}

/// Nouns that take an identifier number: "flight fifteen oh eight".
const IDENTIFIER_NOUNS: &[&str] = &[
    "flight",
    "room",
    "extension",
    "ext",
    "model",
    "version",
    "page",
    "suite",
    "route",
    "gate",
    "apartment",
    "unit",
    "bus",
    "train",
    "highway",
    "number",
];
/// Words before a spoken year: "in nineteen oh five".
const YEAR_CONTEXT_WORDS: &[&str] = &["in", "since", "circa", "year"];
/// Words before a clock time that `TIME_CONTEXT_WORDS` does not cover.
const CLOCK_WORDS_BEFORE: &[&str] = &[
    "at", "around", "by", "until", "till", "from", "before", "after", "now", "it's", "its",
];
/// Words after a clock time: "ten oh five tomorrow".
const CLOCK_WORDS_AFTER: &[&str] = &[
    "o'clock",
    "o’clock",
    "morning",
    "afternoon",
    "evening",
    "tonight",
    "tomorrow",
    "today",
    "sharp",
];

enum OhNumberOutcome {
    Convert(Rewrite),
    KeepWords { end: usize },
}

/// A spoken "<hour> oh <digit>" partner after "to"/"until"/"till" makes the
/// first one a time too: "ten oh five to ten thirty".
fn followed_by_a_range_partner_time(tokens: &[Token], end: usize) -> bool {
    tokens.get(end).is_some_and(|bridge| {
        !bridge.protected
            && matches!(
                bridge.core_lower.as_str(),
                "to" | "until" | "till" | "through"
            )
            && span_continues(tokens, end - 1, end)
            && span_continues(tokens, end, end + 1)
    }) && (try_time(tokens, end + 1, true).is_some()
        || parse_cardinal_bounded(tokens, end + 1, 1)
            .is_some_and(|(hour, after)| (1..=12).contains(&hour) && is_meridiem_at(tokens, after)))
}

/// "pm", "a.m." or the two-token "a m" / "p m" a recognizer writes.
fn is_meridiem_at(tokens: &[Token], index: usize) -> bool {
    let Some(token) = tokens.get(index).filter(|token| !token.protected) else {
        return false;
    };
    if is_meridiem(&token.core_lower) {
        return true;
    }
    matches!(token.core_lower.as_str(), "a" | "p")
        && span_continues(tokens, index, index + 1)
        && tokens
            .get(index + 1)
            .is_some_and(|next| !next.protected && next.core_lower == "m")
}

/// `<number> oh <digit>` read as a clock time, a year or an identifier.
///
/// The same words are all three: "it's ten oh five" is 10:05, "in nineteen
/// oh five" the year 1905, "flight fifteen oh eight" a flight number, and "I
/// said fifteen oh eight more" none of them. Writing the wrong one changes
/// the number, so each needs its own evidence:
///
/// - a clock time (head one to twelve, spoken "oh") needs a time word
///   around it: a time preposition or "it's"/"now" before it, a meridiem,
///   "o'clock" or a day word after it, or a second time after "to";
/// - an identifier (any head from ten up) needs a noun before it that
///   takes a number ("flight", "room", "version", ...);
/// - a year (head ten to twenty) needs "in", "since", "circa" or "year"
///   before it.
///
/// With none of these, or when more number words follow ("fifteen oh eight
/// thousand", "point five", "percent"), the phrase stays as words: half of
/// it written ("15 oh eight") is the form all-or-nothing forbids. A head of
/// one to nine without a clock word is left to `try_digit_string` ("room
/// two oh one" -> "room 201").
fn try_oh_number(
    tokens: &[Token],
    start: usize,
    time_context_open: bool,
) -> Option<OhNumberOutcome> {
    let head = tokens.get(start).filter(|token| !token.protected)?;
    let head_value = unit_value(&head.core_lower)
        .filter(|value| *value > 0)
        .or_else(|| teen_value(&head.core_lower))
        .or_else(|| tens_value(&head.core_lower))?;
    let oh = tokens.get(start + 1).filter(|token| !token.protected)?;
    let spoken_oh = oh.core_lower == "oh";
    let (digit, end) = parse_oh_digit(tokens, start + 1)?;
    if !span_is_contiguous(tokens, start, end) {
        return None;
    }

    // Further number words make this a longer phrase this rule cannot
    // finish; it stays words through the last of them.
    let mut words_end = end;
    while tokens.get(words_end).is_some_and(|next| {
        !next.protected
            && span_continues(tokens, start, words_end)
            && (is_number_word(&next.core_lower)
                || next.core_lower.starts_with(|ch: char| ch.is_ascii_digit())
                || matches!(
                    next.core_lower.as_str(),
                    "oh" | "o" | "point" | "percent" | "per"
                ))
    }) {
        words_end += 1;
    }
    let continues = words_end > end || tokens[end - 1].trail.contains('%');

    let previous = start
        .checked_sub(1)
        .and_then(|index| tokens.get(index))
        .filter(|previous| {
            !previous.protected && !previous.trail.contains(['.', '!', '?', ';', ':'])
        })
        .map(|previous| previous.core_lower.replace('’', "'"));
    let previous = previous.as_deref().unwrap_or("");

    let is_unit_head = head_value < 10;
    if continues {
        return if is_unit_head {
            None
        } else {
            Some(OhNumberOutcome::KeepWords { end: words_end })
        };
    }

    let clock_context = spoken_oh
        && (time_context_open
            || CLOCK_WORDS_BEFORE.contains(&previous)
            || is_meridiem_at(tokens, end)
            || tokens.get(end).is_some_and(|next| {
                !next.protected && CLOCK_WORDS_AFTER.contains(&next.core_lower.as_str())
            })
            || followed_by_a_range_partner_time(tokens, end));
    let identifier = IDENTIFIER_NOUNS.contains(&previous);
    let year = YEAR_CONTEXT_WORDS.contains(&previous);

    let number = |text: String| Some(OhNumberOutcome::Convert(Rewrite { text, end }));
    if identifier && !is_unit_head {
        return number(format!("{}", head_value * 100 + digit));
    }
    if clock_context && (1..=12).contains(&head_value) {
        return number(format!("{head_value}:{digit:02}"));
    }
    if year && (10..=20).contains(&head_value) {
        return number(format!("{}", head_value * 100 + digit));
    }
    if is_unit_head {
        None
    } else {
        Some(OhNumberOutcome::KeepWords { end })
    }
}

/// A one-word ordinal is only safe to convert when it cannot be an ordinary
/// English word: "give me a second", "first, let's ship" and "the third
/// option" all have to survive. Compound ordinals are `classify_ordinal`'s.
fn standalone_ordinal_is_convertible(value: u64) -> bool {
    value > 10
}

fn currency_symbol(word: &str) -> Option<&'static str> {
    Some(match word {
        "dollar" | "dollars" => "$",
        "euro" | "euros" => "\u{20ac}",
        "pound" | "pounds" => "\u{a3}",
        _ => return None,
    })
}

/// Words that place a spoken "pounds" in the same sentence on a scale:
/// "The patient weighs one hundred and five pounds", "lost twelve pounds",
/// "seven pounds five ounces".
const POUND_WEIGHT_CUES: &[&str] = &[
    "weigh",
    "weighs",
    "weighed",
    "weighing",
    "weight",
    "weights",
    "heavy",
    "heavier",
    "lighter",
    "lost",
    "lose",
    "loses",
    "losing",
    "gained",
    "gain",
    "gains",
    "gaining",
    "ounce",
    "ounces",
    "oz",
    "lb",
    "lbs",
    "stone",
    "kilo",
    "kilos",
    "kilogram",
    "kilograms",
    "kg",
    "gram",
    "grams",
    "born",
    "baby",
    "newborn",
    "patient",
    "dumbbell",
    "dumbbells",
    "lift",
    "lifts",
    "lifted",
    "lifting",
    "scale",
    "scales",
    "bench",
    "squat",
    "deadlift",
];

/// Words that make a spoken "pounds" in the same sentence an amount of
/// money: "The price is five pounds", "I owe five pounds".
const POUND_MONEY_CUES: &[&str] = &[
    "cost", "costs", "costing", "costed", "price", "prices", "priced", "pricing", "pay", "pays",
    "paid", "paying", "payment", "spend", "spends", "spent", "spending", "owe", "owes", "owed",
    "owing", "budget", "fee", "fees", "fare", "fares", "charge", "charges", "charged", "bill",
    "billed", "invoice", "invoiced", "refund", "refunded", "earn", "earns", "earned", "salary",
    "wage", "wages", "rent", "tip", "buy", "buys", "bought", "sell", "sells", "sold", "cash",
    "money", "deposit", "donate", "donated", "donation", "afford", "ticket", "tickets", "quid",
    "pence", "penny", "sterling", "currency", "exchange",
];

/// The words of the sentence around `tokens[start..end]`, bounded by a full
/// stop, question or exclamation mark, semicolon or line break.
fn sentence_words(tokens: &[Token], start: usize, end: usize) -> impl Iterator<Item = &Token> {
    let breaks = |token: &Token| token.trail.contains(['.', '!', '?', ';']);
    let mut first = start;
    while first > 0 && !breaks(&tokens[first - 1]) && !tokens[first].space_before.contains('\n') {
        first -= 1;
    }
    let mut last = end.min(tokens.len());
    while last > first
        && last < tokens.len()
        && !breaks(&tokens[last - 1])
        && !tokens[last].space_before.contains('\n')
    {
        last += 1;
    }
    tokens[first..last].iter().filter(|token| !token.protected)
}

/// "Pounds" is a weight as often as it is money. An amount of pounds
/// becomes "£" only with money in the same sentence ("costs", "paid",
/// "pence", "sterling") and nothing that weighs. Without either the words
/// stay, because "He weighs £2" changes what was said.
fn pounds_mean_money(tokens: &[Token], start: usize, unit: usize) -> bool {
    if tokens
        .get(unit + 1)
        .is_some_and(|next| next.core_lower == "of")
    {
        return false;
    }
    let mut money = false;
    for token in sentence_words(tokens, start, unit + 1) {
        let word = token.core_lower.as_str();
        if POUND_WEIGHT_CUES.contains(&word) {
            return false;
        }
        money |= POUND_MONEY_CUES.contains(&word);
    }
    money
}

/// The spoken word for the hundredth part of `symbol`.
fn is_minor_unit(symbol: &str, word: &str) -> bool {
    match symbol {
        "\u{a3}" => matches!(word, "pence" | "penny" | "p"),
        _ => matches!(word, "cent" | "cents"),
    }
}

fn currency_price_boundary(tokens: &[Token], start: usize, end: usize) -> bool {
    !tokens[end - 1].trail.is_empty()
        || tokens
            .get(end)
            .is_none_or(|next| next.core.is_empty() || next.space_before.contains(['\n', '\r']))
        || (span_continues(tokens, start, end)
            && tokens.get(end).is_some_and(|next| {
                !next.protected && matches!(next.core_lower.as_str(), "per" | "each")
            }))
}

fn explicit_currency_alternative(tokens: &[Token], start: usize) -> bool {
    let Some(conjunction) = tokens.get(start) else {
        return false;
    };
    if conjunction.protected
        || conjunction.core_lower != "or"
        || !span_continues(tokens, start, start + 1)
    {
        return false;
    }
    let Some((_, after_amount)) = parse_cardinal(tokens, start + 1) else {
        return false;
    };
    if !span_continues(tokens, start + 1, after_amount) {
        return false;
    }
    let Some(unit) = tokens.get(after_amount) else {
        return false;
    };
    if unit.protected
        || currency_symbol(&unit.core_lower).is_none()
        || (unit.core_lower.starts_with("pound")
            && !pounds_mean_money(tokens, start + 1, after_amount))
    {
        return false;
    }
    currency_price_boundary(tokens, start + 1, after_amount + 1)
}

/// A spoken amount before a currency unit: a cardinal ("twelve hundred"), or
/// a decimal with an optional scale word after it ("three point two
/// million", "two point five").
struct SpokenAmount {
    whole: u64,
    /// The digits spoken after "point".
    fraction: Option<String>,
    /// The scale word after a decimal's digits and its multiplier.
    decimal_scale: Option<(u64, &'static str)>,
    end: usize,
}

fn scale_word(word: &str) -> Option<(u64, &'static str)> {
    Some(match word {
        "thousand" => (1_000, "thousand"),
        "million" => (1_000_000, "million"),
        "billion" => (1_000_000_000, "billion"),
        _ => return None,
    })
}

fn parse_spoken_amount(tokens: &[Token], start: usize, with_article: bool) -> Option<SpokenAmount> {
    let (whole, after_whole) = if with_article {
        parse_cardinal_with_article(tokens, start)?
    } else {
        parse_cardinal(tokens, start)?
    };
    if !span_continues(tokens, start, after_whole) {
        return None;
    }
    let plain = SpokenAmount {
        whole,
        fraction: None,
        decimal_scale: None,
        end: after_whole,
    };
    let Some(point) = tokens.get(after_whole) else {
        return Some(plain);
    };
    if point.protected
        || point.core_lower != "point"
        || !point.trail.is_empty()
        || !span_continues(tokens, start, after_whole + 1)
    {
        return Some(plain);
    }
    let (digits, digits_end) = single_digit_run(tokens, after_whole + 1);
    if digits.is_empty() {
        return Some(plain);
    }
    let mut end = digits_end;
    let mut decimal_scale = None;
    if span_continues(tokens, start, end) {
        if let Some(next) = tokens.get(end).filter(|next| !next.protected) {
            if let Some(scale) = scale_word(&next.core_lower) {
                // "one thousand point five million" is not an amount anyone
                // says; only a small number takes a scale after its decimals.
                if whole >= 1_000 {
                    return None;
                }
                decimal_scale = Some(scale);
                end += 1;
            } else if is_number_word(&next.core_lower) {
                // "three point one eleven": the digits stop before more of
                // the spoken number.
                return None;
            }
        }
    }
    Some(SpokenAmount {
        whole,
        fraction: Some(digits),
        decimal_scale,
        end,
    })
}

impl SpokenAmount {
    /// The scale word the amount ends on and its multiplier, when the amount
    /// is a small number of that scale: "fifteen thousand" (15 x 1,000),
    /// "three point two million" (3.2 x 1,000,000), "three hundred". A range
    /// head such as "two to" shares it. "Three million four hundred
    /// thousand" ends on "thousand" but is not a count of thousands that a
    /// smaller head could share, so it has none.
    fn trailing_scale(&self, tokens: &[Token]) -> Option<(u64, &'static str)> {
        if self.fraction.is_some() {
            return self.decimal_scale;
        }
        let last = tokens[self.end - 1].core_lower.as_str();
        let scale = if last == "hundred" {
            (100, "hundred")
        } else {
            scale_word(last)?
        };
        let count = self.whole / scale.0;
        (self.whole.is_multiple_of(scale.0) && count > 0 && count < 1_000).then_some(scale)
    }

    /// The amount's value in whole units, when it has one: "one point five
    /// thousand" is 1,500, "one point two five" is not whole.
    fn value(&self) -> f64 {
        let fraction = self.fraction.as_deref().map_or(0.0, |digits| {
            format!("0.{digits}").parse::<f64>().unwrap_or(0.0)
        });
        let multiplier = self.decimal_scale.map_or(1, |(value, _)| value);
        (self.whole as f64 + fraction) * multiplier as f64
    }

    /// Written after `symbol`, without cents: "$1,200", "$2.50", "$3.2
    /// million", "$3 million". Millions and billions keep their word, the way
    /// money is typed ("$3.2 million", not "$3,200,000"); thousands become
    /// digits ("$1,500").
    fn render(&self, tokens: &[Token], symbol: &str) -> String {
        match (&self.fraction, self.decimal_scale) {
            (Some(digits), Some((multiplier, word))) => {
                if multiplier >= 1_000_000 || digits.len() > 3 {
                    return format!("{symbol}{}.{digits} {word}", self.whole);
                }
                // "one point five thousand" is exactly 1,500; integer
                // arithmetic keeps "two point three" from becoming 2,299.
                let thousandths = format!("{digits:0<3}").parse::<u64>().unwrap_or(0);
                format!(
                    "{symbol}{}",
                    format_currency_amount(self.whole * 1_000 + thousandths)
                )
            }
            (Some(digits), None) if digits.len() == 1 => {
                format!("{symbol}{}.{digits}0", format_currency_amount(self.whole))
            }
            (Some(digits), None) => {
                format!("{symbol}{}.{digits}", format_currency_amount(self.whole))
            }
            (None, _) => match self.trailing_scale(tokens) {
                Some((multiplier, word)) if multiplier >= 1_000_000 => {
                    format!("{symbol}{} {word}", self.whole / multiplier)
                }
                _ => format!("{symbol}{}", format_currency_amount(self.whole)),
            },
        }
    }
}

/// A currency amount and what a range head before it may share.
struct CurrencyAmount {
    rewrite: Rewrite,
    symbol: &'static str,
    value: f64,
    /// See `SpokenAmount::trailing_scale`; `None` once cents are spoken.
    trailing_scale: Option<(u64, &'static str)>,
}

/// `<amount> dollars|euros|pounds [and] [<cents> [cents]]`.
fn try_currency(tokens: &[Token], start: usize) -> Option<Rewrite> {
    parse_currency(tokens, start).map(|amount| amount.rewrite)
}

fn parse_currency(tokens: &[Token], start: usize) -> Option<CurrencyAmount> {
    let amount = parse_spoken_amount(tokens, start, true)?;
    let after_amount = amount.end;
    if !span_continues(tokens, start, after_amount) {
        return None;
    }
    let unit_token = tokens.get(after_amount)?;
    if unit_token.protected {
        return None;
    }
    let symbol = currency_symbol(&unit_token.core_lower)?;
    // "three pounds of flour" and "He weighs two pounds" are weights, not GBP.
    let mut unit_end = after_amount + 1;
    if unit_token.core_lower.starts_with("pound") {
        if !pounds_mean_money(tokens, start, after_amount) {
            return None;
        }
        // "six pounds sterling" is £6.
        if span_continues(tokens, start, unit_end)
            && tokens
                .get(unit_end)
                .is_some_and(|next| !next.protected && next.core_lower == "sterling")
        {
            unit_end += 1;
        }
    }
    let unit_token = &tokens[unit_end - 1];

    let mut index = unit_end;
    let mut cents: Option<u64> = None;

    // Every step past the currency word has to stay inside one unpunctuated
    // run, because the rewrite replaces the whole span and keeps only its
    // outer punctuation: "twelve dollars and fifty (cents" must not swallow
    // the paren. "Two point five dollars fifty" has its cents already.
    if amount.fraction.is_none()
        && unit_token.trail.is_empty()
        && span_continues(tokens, start, index)
    {
        let mut cents_start = index;
        let mut boundary_holds = true;
        let has_conjunction = tokens
            .get(cents_start)
            .is_some_and(|next| !next.protected && next.core_lower == "and");
        if has_conjunction {
            boundary_holds = span_continues(tokens, start, cents_start + 1);
            cents_start += 1;
        }
        if boundary_holds {
            if let Some((value, end)) = parse_cardinal_bounded(tokens, cents_start, 2) {
                if value <= 99 {
                    let explicit = span_continues(tokens, start, end)
                        && tokens.get(end).is_some_and(|next| {
                            !next.protected && is_minor_unit(symbol, &next.core_lower)
                        });
                    if explicit {
                        cents = Some(value);
                        index = end + 1;
                    } else if value >= 10 && !has_conjunction {
                        let price_boundary = currency_price_boundary(tokens, start, end)
                            || (span_continues(tokens, start, end)
                                && explicit_currency_alternative(tokens, end));
                        if price_boundary {
                            cents = Some(value);
                            index = end;
                        }
                    }
                }
            }
        }
    }

    let (text, trailing_scale) = match cents {
        Some(cents) => (
            format!(
                "{}{}.{:02}",
                symbol,
                format_currency_amount(amount.whole),
                cents
            ),
            None,
        ),
        None => (amount.render(tokens, symbol), amount.trailing_scale(tokens)),
    };
    Some(CurrencyAmount {
        rewrite: Rewrite { text, end: index },
        symbol,
        value: amount.value() + cents.map_or(0.0, |cents| cents as f64 / 100.0),
        trailing_scale,
    })
}

enum RangeOutcome {
    Convert(Rewrite),
    KeepWords { end: usize },
}

/// The word joining the two ends of a spoken range at `index`: "to", "or",
/// "through", or "and" after "between".
fn range_bridge(tokens: &[Token], start: usize, index: usize) -> Option<&Token> {
    let bridge = tokens.get(index).filter(|bridge| !bridge.protected)?;
    if !span_continues(tokens, start, index) || !span_continues(tokens, start, index + 1) {
        return None;
    }
    let after_between = start > 0
        && !tokens[start - 1].protected
        && tokens[start - 1].core_lower == "between"
        && span_continues(tokens, start - 1, start);
    match bridge.core_lower.as_str() {
        "to" | "or" | "through" => Some(bridge),
        "and" if after_between => Some(bridge),
        _ => None,
    }
}

/// A range whose head has no unit of its own: "two to three million
/// dollars", "between ten and fifteen thousand euros", "five to ten
/// dollars". The head shares the tail's currency and, when it is a bare
/// small number, the tail's scale: "$2 million to $3 million", "$10,000 and
/// $15,000". Converting only the tail ("2 to $3,000,000") states a
/// different range, so a range whose head cannot be read for certain
/// ("five to three hundred dollars": $5 or $500?) stays words whole.
///
/// Without a currency, a bare head before a scaled tail is the same
/// question ("two to three million people", "two to three hundred
/// people"), and that range stays words too.
fn try_spoken_range(tokens: &[Token], start: usize) -> Option<RangeOutcome> {
    // "twelve dollars (and) fifty or five euros": a number after an amount
    // may be its cents, not the head of a range.
    if start > 0 && span_continues(tokens, start - 1, start) {
        let previous = tokens[start - 1].core_lower.as_str();
        if matches!(previous, "and" | "point")
            || currency_symbol(previous).is_some()
            || previous.starts_with(['$', '€', '£'])
        {
            return None;
        }
    }
    let head = parse_spoken_amount(tokens, start, false)?;
    let bridge = range_bridge(tokens, start, head.end)?;
    let tail_start = head.end + 1;
    let ordered = bridge.core_lower != "or";
    // A bare head: no hundred or scale word of its own, so "two" in "two to
    // three million" may mean two million.
    let bare = head.decimal_scale.is_none()
        && head.whole < 100
        && !is_scale_or_hundred(&tokens[head.end - 1].core_lower);

    let Some(tail) = parse_currency(tokens, tail_start) else {
        let tail = parse_spoken_amount(tokens, tail_start, false)?;
        let (multiplier, _) = tail.trailing_scale(tokens)?;
        let ambiguous = bare
            && (head.fraction.is_some() && multiplier >= 1_000
                || (head.whole as f64) < tail.value() / multiplier as f64);
        return ambiguous.then_some(RangeOutcome::KeepWords { end: tail.end });
    };
    let keep_words = RangeOutcome::KeepWords {
        end: tail.rewrite.end,
    };
    // "nine hundred to two million dollars": $900 or $900,000?
    if !bare
        && head.decimal_scale.is_none()
        && head.whole < 1_000
        && tail
            .trailing_scale
            .is_some_and(|(multiplier, _)| multiplier >= 1_000)
    {
        return Some(keep_words);
    }
    let head_text = match tail.trailing_scale.filter(|_| bare) {
        Some((multiplier, word)) => {
            let tail_count = tail.value / multiplier as f64;
            let head_count = head.value();
            if multiplier == 100 {
                // "two to three hundred" is $200 to $300, "fifty to a hundred"
                // is $50 to $100; "five to three hundred" could be either.
                if head.fraction.is_some() {
                    return Some(keep_words);
                }
                if head_count < tail_count {
                    format!(
                        "{}{}",
                        tail.symbol,
                        format_currency_amount(head.whole * 100)
                    )
                } else if head.whole >= 10 && head_count < tail.value {
                    format!("{}{}", tail.symbol, format_currency_amount(head.whole))
                } else {
                    return Some(keep_words);
                }
            } else {
                if ordered && head_count >= tail_count {
                    return Some(keep_words);
                }
                match head.fraction {
                    None if multiplier >= 1_000_000 => {
                        format!("{}{} {word}", tail.symbol, head.whole)
                    }
                    None => format!(
                        "{}{}",
                        tail.symbol,
                        format_currency_amount(head.whole * multiplier)
                    ),
                    Some(_) => SpokenAmount {
                        decimal_scale: Some((multiplier, word)),
                        ..head
                    }
                    .render(tokens, tail.symbol),
                }
            }
        }
        None => {
            if ordered && head.value() > tail.value {
                return Some(keep_words);
            }
            head.render(tokens, tail.symbol)
        }
    };
    if !span_is_contiguous(tokens, start, tail.rewrite.end) {
        return None;
    }
    Some(RangeOutcome::Convert(Rewrite {
        text: format!("{head_text} {} {}", bridge.core, tail.rewrite.text),
        end: tail.rewrite.end,
    }))
}

/// A recognizer's digits before a spoken scale and currency: "3.2 million
/// dollars" -> "$3.2 million", "5 billion euros" -> "€5 billion".
fn try_written_scaled_amount(tokens: &[Token], start: usize) -> Option<Rewrite> {
    static SMALL_NUMBER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[0-9]{1,3}(?:\.[0-9]+)?$")
            .expect("small written number pattern is valid")
    });
    let number = tokens.get(start)?;
    if !SMALL_NUMBER.is_match(&number.core) {
        return None;
    }
    let scale = tokens.get(start + 1).filter(|token| !token.protected)?;
    let (multiplier, word) = scale_word(&scale.core_lower)?;
    let unit = tokens.get(start + 2).filter(|token| !token.protected)?;
    let symbol = currency_symbol(&unit.core_lower)?;
    if multiplier < 1_000_000
        || number.protected
        || !span_is_contiguous(tokens, start, start + 3)
        || (unit.core_lower.starts_with("pound") && !pounds_mean_money(tokens, start, start + 2))
    {
        return None;
    }
    Some(Rewrite {
        text: format!("{symbol}{} {word}", number.core),
        end: start + 3,
    })
}

/// A recognizer that writes the dollars but says the cents: "$1,240 and 75
/// cents" or "$12 and seventy-five cents" -> "$1,240.75". The amount must be
/// whole (no decimals yet) and the cents word must be spoken.
fn try_written_amount_with_cents(tokens: &[Token], start: usize) -> Option<Rewrite> {
    static WHOLE_AMOUNT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[€£$](?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$")
            .expect("whole written currency amount pattern is valid")
    });
    let amount = tokens.get(start)?;
    if !WHOLE_AMOUNT.is_match(&amount.core) {
        return None;
    }
    let conjunction = tokens.get(start + 1)?;
    if conjunction.protected || conjunction.core_lower != "and" {
        return None;
    }
    let cents_start = start + 2;
    let digits = tokens.get(cents_start).filter(|token| {
        !token.protected
            && (1..=2).contains(&token.core.len())
            && token.core.chars().all(|ch| ch.is_ascii_digit())
    });
    let (cents, cents_end) = match digits {
        Some(token) => (token.core.parse::<u64>().ok()?, cents_start + 1),
        None => parse_cardinal_bounded(tokens, cents_start, 2)?,
    };
    let unit = tokens.get(cents_end)?;
    if cents > 99
        || unit.protected
        || !matches!(unit.core_lower.as_str(), "cent" | "cents")
        || !span_is_contiguous(tokens, start, cents_end + 1)
    {
        return None;
    }
    Some(Rewrite {
        text: format!("{}.{:02}", amount.core, cents),
        end: cents_end + 1,
    })
}

/// `<hour> <minutes> [am|pm]`, gated on an open time context (an "at"-style
/// preposition, see `time_context_survives`) or an explicit meridiem, so
/// "three thirty" alone stays as words.
fn try_time(tokens: &[Token], start: usize, time_context_open: bool) -> Option<Rewrite> {
    let (hour, after_hour) = parse_cardinal_bounded(tokens, start, 1)?;
    if !(1..=12).contains(&hour) {
        return None;
    }
    if !span_continues(tokens, start, after_hour) {
        return None;
    }

    let (minute, end) = if let Some((value, end)) = parse_oh_digit(tokens, after_hour) {
        (value, end)
    } else {
        let (value, end) = parse_cardinal_bounded(tokens, after_hour, 2)?;
        let token_count = end - after_hour;
        // Minutes are spoken as a teen ("three fifteen"), a tens word
        // ("three thirty") or tens plus unit ("three forty five"). A bare
        // unit ("at six six") is not a time.
        let shaped_like_minutes = token_count == 2
            || teen_value(&tokens[after_hour].core_lower).is_some()
            || tens_value(&tokens[after_hour].core_lower).is_some();
        if !shaped_like_minutes || value > 59 {
            return None;
        }
        (value, end)
    };

    let has_meridiem = tokens
        .get(end)
        .is_some_and(|next| !next.protected && is_meridiem(&next.core_lower));
    if !has_meridiem && !time_context_open {
        return None;
    }

    Some(Rewrite {
        text: format!("{}:{:02}", hour, minute),
        end,
    })
}

/// `<number> point <digit> [<digit> ...]`. "point" only counts after a
/// number, so "the point is simple" is untouched.
fn parse_decimal(tokens: &[Token], start: usize) -> Option<(String, usize)> {
    let (integer, after_integer) = parse_cardinal(tokens, start)?;
    if !span_continues(tokens, start, after_integer) {
        return None;
    }
    let point = tokens.get(after_integer)?;
    if point.protected || point.core_lower != "point" || !point.trail.is_empty() {
        return None;
    }
    if !span_continues(tokens, start, after_integer + 1) {
        return None;
    }
    let (digits, end) = single_digit_run(tokens, after_integer + 1);
    if digits.is_empty() {
        return None;
    }
    // "three point one eleven": the digits stop before more of the spoken
    // number, so "3.1 11" would split it. A scale word ("one point two
    // billion") still belongs to the decimal.
    if span_continues(tokens, start, end)
        && tokens.get(end).is_some_and(|next| {
            !next.protected
                && is_number_word(&next.core_lower)
                && !is_scale_or_hundred(&next.core_lower)
        })
    {
        return None;
    }
    Some((format!("{}.{}", format_cardinal(integer), digits), end))
}

/// Denominators of a spoken fraction: "two thirds", "three quarters".
fn is_fraction_word(word: &str) -> bool {
    matches!(
        word,
        "half"
            | "halves"
            | "third"
            | "thirds"
            | "quarter"
            | "quarters"
            | "fourths"
            | "fifths"
            | "sixths"
            | "sevenths"
            | "eighths"
            | "ninths"
            | "tenths"
            | "twelfths"
            | "sixteenths"
            | "hundredths"
            | "thousandths"
    )
}

/// The end of the spoken number words from `start` on, each joined to the
/// word before it (`tokens[start - 1]` for the first) without punctuation or
/// a line break.
fn number_words_end(tokens: &[Token], start: usize) -> usize {
    let mut end = start;
    while end > 0
        && tokens.get(end).is_some_and(|token| {
            !token.protected && (is_number_word(&token.core_lower) || token.core_lower == "oh")
        })
        && span_continues(tokens, end - 1, end)
    {
        end += 1;
    }
    end
}

/// A cardinal at `tokens[start..end]` that is only part of a spoken number
/// no rule can write: a fraction ("two thirds of a cup", "two and a half
/// cups"), a decimal whose tail is not a digit run ("Python three point
/// eleven", "three point fifty"), or an "oh" before a non-digit ("ten oh
/// fifteen"). Converting the head alone gives "2 thirds", "3 point eleven"
/// and "10 oh 15", so the whole phrase stays as words. Returns its end.
fn unwritable_number_phrase_end(tokens: &[Token], start: usize, end: usize) -> Option<usize> {
    let joined = |at: usize| {
        span_continues(tokens, start, at) && tokens.get(at).is_some_and(|token| !token.protected)
    };
    if !joined(end) {
        return None;
    }
    let next = tokens[end].core_lower.as_str();
    if is_fraction_word(next) {
        return Some(end + 1);
    }
    if next == "and" && joined(end + 1) {
        let after = tokens[end + 1].core_lower.as_str();
        let denominator = if matches!(after, "a" | "an") {
            end + 2
        } else {
            number_words_end(tokens, end + 1)
        };
        if denominator > end + 1
            && joined(denominator)
            && is_fraction_word(&tokens[denominator].core_lower)
        {
            return Some(denominator + 1);
        }
        return None;
    }
    if (next == "point" && tokens[end].trail.is_empty()) || next == "oh" {
        let tail_end = number_words_end(tokens, end + 1);
        if tail_end > end + 1 {
            return Some(tail_end);
        }
    }
    None
}

/// The second half of "one twenty over eighty", "one or two" or "one to
/// five" when the first half stayed words: "one twenty over 80" and "one or
/// 2" split one reading.
fn partner_of_unwritten_number(
    tokens: &[Token],
    index: usize,
    last_rewrite_end: Option<usize>,
) -> bool {
    index >= 2
        && last_rewrite_end != Some(index - 1)
        && span_continues(tokens, index - 2, index)
        && matches!(tokens[index - 1].core_lower.as_str(), "over" | "to" | "or")
        && !tokens[index - 1].protected
        && !tokens[index - 2].protected
        && is_number_word(&tokens[index - 2].core_lower)
}

/// `<number|decimal> percent` (and the two-word "per cent").
fn try_percent(tokens: &[Token], start: usize) -> Option<Rewrite> {
    let (value, after_value) = match parse_decimal(tokens, start) {
        Some((text, end)) => (text, end),
        None => {
            let (value, end) = parse_cardinal(tokens, start)?;
            (format_cardinal(value), end)
        }
    };
    if !span_continues(tokens, start, after_value) {
        return None;
    }
    let next = tokens.get(after_value)?;
    if next.protected {
        return None;
    }
    let end = if next.core_lower == "percent" {
        after_value + 1
    } else if next.core_lower == "per"
        && next.trail.is_empty()
        // "ten per (cent" is not a percentage: a rewrite spanning that
        // boundary would drop the paren.
        && span_continues(tokens, start, after_value + 1)
        && tokens
            .get(after_value + 1)
            .is_some_and(|word| !word.protected && word.core_lower == "cent")
    {
        after_value + 2
    } else {
        return None;
    };

    Some(Rewrite {
        text: format!("{}%", value),
        end,
    })
}

/// Whether the clock-time context is still open after `tokens[start..end]`.
///
/// A time preposition opens it, and it survives the glue that separates items
/// in a list -- "at three fifteen, three thirty and three forty five" is
/// three times, not one time and two loose number pairs. Any other word, or
/// the end of a sentence, closes it.
fn time_context_survives(
    open: bool,
    tokens: &[Token],
    start: usize,
    end: usize,
    consumed_a_number: bool,
) -> bool {
    let mut open = open;
    for token in &tokens[start..end] {
        let word = token.core_lower.as_str();
        if TIME_CONTEXT_WORDS.contains(&word) {
            open = true;
        } else if !consumed_a_number
            && !matches!(word, "and" | "or" | "oh")
            && !is_meridiem(word)
            && !is_number_word(word)
        {
            open = false;
        }
    }
    if tokens[end - 1]
        .trail
        .chars()
        .any(|ch| matches!(ch, '.' | '!' | '?' | ';'))
    {
        open = false;
    }
    open
}

/// True when the number at `start` is only the head of a ratio or range whose
/// other half will not convert ("ten to one odds", "twenty to one"). Writing
/// one side as a digit and leaving the other as a word is the half-converted
/// form the all-or-nothing rule exists to prevent, so the head stays a word
/// too.
fn ratio_partner_stays_a_word(tokens: &[Token], end: usize) -> bool {
    let Some(bridge) = tokens.get(end) else {
        return false;
    };
    if bridge.protected || !matches!(bridge.core_lower.as_str(), "to" | "or" | "over") {
        return false;
    }
    if !span_continues(tokens, end - 1, end) || !span_continues(tokens, end, end + 1) {
        return false;
    }
    let Some((value, partner_end)) = parse_cardinal(tokens, end + 1) else {
        return false;
    };
    // A bare "one" is the only cardinal that never converts on its own.
    partner_end == end + 2 && value == 1
}

/// The full extent of a chain of number groups that sit next to each other
/// without composing ("two thirty", "twenty twenty six", "seven eighty
/// eight"). Everything in the chain is left as words.
fn ambiguous_adjacency_end(tokens: &[Token], start: usize) -> Option<usize> {
    let (_, mut end) = parse_cardinal(tokens, start)?;
    let mut adjacent = false;
    loop {
        if !span_continues(tokens, start, end) {
            break;
        }
        let Some(next) = tokens.get(end) else { break };
        if next.protected || !is_number_word(&next.core_lower) {
            break;
        }
        let Some((_, next_end)) = parse_cardinal(tokens, end) else {
            break;
        };
        adjacent = true;
        end = next_end;
    }
    if adjacent {
        Some(end)
    } else {
        None
    }
}

/// True when `index` continues a spoken number whose head stayed as words:
/// "thousand two hundred forty dollars" after the recognizer lost "one", or
/// "a thousand two hundred people". Writing only the tail would show a
/// different, smaller number ("Thousand $240.75"), so the tail stays as words
/// too. A head that a rewrite already consumed does not count.
fn continues_unwritten_number(
    tokens: &[Token],
    index: usize,
    last_rewrite_end: Option<usize>,
) -> bool {
    if index == 0 || last_rewrite_end == Some(index) {
        return false;
    }
    let joined_to_previous =
        |at: usize| at > 0 && !tokens[at - 1].protected && span_continues(tokens, at - 1, at);
    if !joined_to_previous(index) {
        return false;
    }
    let previous = tokens[index - 1].core_lower.as_str();
    if is_scale_or_hundred(previous) {
        return true;
    }
    previous == "and"
        && index >= 2
        && last_rewrite_end != Some(index - 1)
        && joined_to_previous(index - 1)
        && is_scale_or_hundred(&tokens[index - 2].core_lower)
}

/// A cardinal directly followed by a scale word it could not absorb, such as
/// "four thousand hundred" from a garbled recognition, is not a number the
/// speaker said. Writing "4000 hundred" would invent one.
fn followed_by_unabsorbed_scale(tokens: &[Token], start: usize, end: usize) -> bool {
    span_continues(tokens, start, end)
        && tokens
            .get(end)
            .is_some_and(|next| !next.protected && is_scale_or_hundred(&next.core_lower))
}

/// Recognizers sometimes punctuate a spoken amount at its scale word: "one
/// thousand, two hundred forty dollars". Read literally, the comma splits it
/// into "1000, $240". When the words after the comma form a smaller group that
/// ends in a currency unit, the comma is a thousands separator: drop it so
/// the amount parses whole. Only applied when the currency rule then consumes
/// the joined amount; otherwise the comma is restored.
fn join_scale_separated_amounts(tokens: &mut [Token]) {
    for index in 1..tokens.len().saturating_sub(1) {
        let scale_token = &tokens[index];
        let Some(scale) = scale_value(&scale_token.core_lower) else {
            continue;
        };
        if scale_token.protected || scale_token.trail != "," {
            continue;
        }
        let previous = &tokens[index - 1];
        if previous.protected
            || !span_continues(tokens, index - 1, index)
            || !(is_number_word(&previous.core_lower) || previous.core_lower == "a")
        {
            continue;
        }
        let next = &tokens[index + 1];
        if next.protected || !next.lead.is_empty() || next.space_before.contains(['\n', '\r']) {
            continue;
        }
        let Some((rest, rest_end)) = parse_cardinal(tokens, index + 1) else {
            continue;
        };
        if rest == 0 || rest >= scale || !span_continues(tokens, index + 1, rest_end) {
            continue;
        }
        if !tokens
            .get(rest_end)
            .is_some_and(|unit| !unit.protected && currency_symbol(&unit.core_lower).is_some())
        {
            continue;
        }
        // Walk back to the first word of the amount.
        let mut start = index - 1;
        while start > 0
            && !tokens[start - 1].protected
            && span_continues(tokens, start - 1, start)
            && (is_number_word(&tokens[start - 1].core_lower)
                || matches!(tokens[start - 1].core_lower.as_str(), "a" | "and"))
        {
            start -= 1;
        }
        while tokens[start].core_lower == "and" && start < index - 1 {
            start += 1;
        }
        // "In two thousand, five hundred dollars was a lot": after a
        // preposition of time the first number may be a year, and the comma
        // ends it. Leave the two numbers separate.
        if start > 0
            && span_continues(tokens, start - 1, start)
            && matches!(
                tokens[start - 1].core_lower.as_str(),
                "in" | "by" | "since" | "until" | "till" | "from" | "before" | "after" | "during"
            )
        {
            continue;
        }
        tokens[index].trail.clear();
        let consumed = try_currency(tokens, start).is_some_and(|rewrite| rewrite.end > rest_end);
        if !consumed {
            tokens[index].trail.push(',');
        }
    }
}

/// Convert spoken numbers in `text` to written form.
pub fn inverse_text_normalize(text: &str) -> String {
    inverse_text_normalize_protecting(text, &[])
}

/// Remove only a currency word repeated after an already written amount.
/// Keep the amount's exact spelling, symbol, sign, and punctuation.
pub fn normalize_repeated_currency_units(
    text: &str,
    protected_phrases: &[String],
    case_insensitive_phrases: &[String],
) -> String {
    if text.len() > MAX_ITN_INPUT_BYTES {
        return text.to_string();
    }
    static AMOUNT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^[€£$][+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$")
            .expect("written currency amount pattern is valid")
    });
    let mut tokens = tokenize(text);
    mark_protected_phrases(text, &mut tokens, protected_phrases);
    mark_protected_phrases_matching(text, &mut tokens, case_insensitive_phrases, true);
    let mut literal = None;
    for token in &mut tokens {
        let mut quoted = literal.is_some();
        let mut markers = token
            .lead
            .chars()
            .map(|ch| (ch, true, 1))
            .collect::<Vec<_>>();
        let mut core = token.core.chars().peekable();
        while let Some(ch) = core.next() {
            if ch == '`' {
                let mut count = 1;
                while core.peek() == Some(&'`') {
                    core.next();
                    count += 1;
                }
                markers.push((ch, true, count));
            }
        }
        let escaped_trailing_quote = token
            .core
            .chars()
            .rev()
            .take_while(|ch| *ch == '\\')
            .count()
            % 2
            == 1;
        markers.extend(
            token
                .trail
                .chars()
                .enumerate()
                .filter(|(index, ch)| {
                    !(*index == 0 && escaped_trailing_quote && matches!(ch, '"' | '\''))
                })
                .map(|(_, ch)| (ch, false, 1)),
        );
        for (ch, leading, count) in markers {
            if literal == Some((ch, count)) {
                quoted = true;
                literal = None;
            } else if literal.is_none() && leading {
                let closing = match ch {
                    '"' | '\'' | '`' => Some(ch),
                    '“' => Some('”'),
                    '‘' => Some('’'),
                    _ => None,
                };
                if let Some(closing) = closing {
                    quoted = true;
                    literal = Some((closing, count));
                }
            }
        }
        token.protected |= quoted;
    }
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < tokens.len() {
        let first = &tokens[index];
        let unit = tokens.get(index + 1);
        let starts_number = |index: usize| {
            tokens.get(index).is_some_and(|token| {
                unit_value(&token.core_lower).is_some()
                    || teen_value(&token.core_lower).is_some()
                    || tens_value(&token.core_lower).is_some()
                    || token
                        .core
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_ascii_digit())
                    || matches!(
                        token.core_lower.as_str(),
                        "hundred" | "thousand" | "million" | "billion"
                    )
            })
        };
        // "$3.2 million dollars": the scale word stays, the unit goes.
        let scale = unit.filter(|scale| {
            !scale.protected
                && scale_word(&scale.core_lower).is_some_and(|(value, _)| value >= 1_000_000)
        });
        let (unit, unit_index) = match scale {
            Some(_) => (tokens.get(index + 2), index + 2),
            None => (unit, index + 1),
        };
        let has_cents = starts_number(unit_index + 1)
            || (tokens
                .get(unit_index + 1)
                .is_some_and(|token| token.core_lower == "and")
                && starts_number(unit_index + 2));
        if !first.protected
            && first.trail.is_empty()
            && AMOUNT.is_match(&first.core)
            && !has_cents
            && span_is_contiguous(&tokens, index, unit_index + 1)
            && unit.is_some_and(|unit| {
                !unit.protected
                    && !unit.space_before.contains(['\n', '\r'])
                    && currency_symbol(&unit.core_lower)
                        .is_some_and(|symbol| first.core.starts_with(symbol))
            })
        {
            let text = match scale {
                Some(scale) => format!("{} {}", first.core, scale.core),
                None => first.core.clone(),
            };
            emit_rewrite(
                &mut output,
                &tokens,
                index,
                &Rewrite {
                    text,
                    end: unit_index + 1,
                },
            );
            index = unit_index + 1;
        } else {
            output.push_str(&first.render());
            index += 1;
        }
    }
    output
}

/// Same, but never rewrites inside an occurrence of one of
/// `protected_phrases` -- the dictionary replacements already applied to this
/// text. URLs, emails and paths are protected unconditionally.
pub fn inverse_text_normalize_protecting(text: &str, protected_phrases: &[String]) -> String {
    normalize_with_observer(text, protected_phrases, false, |_, _, _| {})
}

fn normalize_with_observer(
    text: &str,
    protected_phrases: &[String],
    voice_style: bool,
    mut observe: impl FnMut(usize, usize, &str),
) -> String {
    if text.is_empty() {
        return String::new();
    }
    if text.len() > MAX_ITN_INPUT_BYTES {
        return text.to_string();
    }

    let mut tokens = tokenize(text);
    if tokens.is_empty() {
        return text.to_string();
    }
    mark_protected_phrases(text, &mut tokens, protected_phrases);
    join_scale_separated_amounts(&mut tokens);

    let mut output = String::with_capacity(text.len());
    let mut index = 0usize;
    let mut time_context_open = false;
    let mut last_rewrite_end: Option<usize> = None;
    let mut time_context_forced_at: Option<usize> = None;

    while index < tokens.len() {
        let token = &tokens[index];
        if token.protected || token.core.is_empty() {
            output.push_str(&token.render());
            time_context_open = false;
            index += 1;
            continue;
        }

        if continues_unwritten_number(&tokens, index, last_rewrite_end) {
            let end = try_currency(&tokens, index)
                .map(|rewrite| rewrite.end)
                .or_else(|| parse_cardinal(&tokens, index).map(|(_, end)| end));
            if let Some(end) = end {
                for token in &tokens[index..end] {
                    output.push_str(&token.render());
                }
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                continue;
            }
        }

        // A clock time just written opens the time context for its range
        // partner: "ten oh five to ten thirty" is two times.
        let context_open = time_context_open || time_context_forced_at == Some(index);
        let early = voice_style
            .then(|| style::try_data_number(&tokens, index))
            .flatten()
            .or_else(|| try_phone(&tokens, index))
            .or_else(|| try_date(&tokens, index))
            .or_else(|| try_time(&tokens, index, context_open));
        let rewrite = match early {
            Some(rewrite) => Some(rewrite),
            None => match try_oh_number(&tokens, index, context_open) {
                Some(OhNumberOutcome::Convert(rewrite)) => Some(rewrite),
                Some(OhNumberOutcome::KeepWords { end }) => {
                    keep_words(&mut output, &tokens, index, end);
                    time_context_open =
                        time_context_survives(time_context_open, &tokens, index, end, true);
                    index = end;
                    continue;
                }
                None => None,
            },
        };
        let rewrite = match rewrite {
            Some(rewrite) => Some(rewrite),
            None => match try_spoken_range(&tokens, index) {
                Some(RangeOutcome::Convert(rewrite)) => Some(rewrite),
                Some(RangeOutcome::KeepWords { end }) => {
                    keep_words(&mut output, &tokens, index, end);
                    time_context_open =
                        time_context_survives(time_context_open, &tokens, index, end, true);
                    index = end;
                    continue;
                }
                None => None,
            },
        };
        let rewrite = rewrite
            .or_else(|| try_digit_string(&tokens, index))
            .or_else(|| try_written_scaled_amount(&tokens, index))
            .or_else(|| try_currency(&tokens, index))
            .or_else(|| try_written_amount_with_cents(&tokens, index))
            .or_else(|| try_percent(&tokens, index))
            .or_else(|| parse_decimal(&tokens, index).map(|(text, end)| Rewrite { text, end }))
            // Backstop for the invariant `emit_rewrite` relies on; each rule
            // also checks its own boundaries.
            .filter(|rewrite| span_is_contiguous(&tokens, index, rewrite.end));

        if let Some(rewrite) = rewrite {
            observe(index, rewrite.end, &rewrite.text);
            emit_rewrite(&mut output, &tokens, index, &rewrite);
            time_context_open =
                time_context_survives(context_open, &tokens, index, rewrite.end, true);
            if rewrite.text.contains(':') && followed_by_a_range_partner_time(&tokens, rewrite.end)
            {
                time_context_forced_at = Some(rewrite.end + 1);
            }
            index = rewrite.end;
            last_rewrite_end = Some(index);
            continue;
        }

        // Ordinals are tried before cardinals so "twenty first" is 21st
        // rather than "20 first" -- when the ordinal reading is the settled
        // one (see `classify_ordinal`).
        match classify_ordinal(&tokens, index) {
            // "a hundred and twentieth": the head stayed words, so the
            // ordinal tail is not written alone as "20th".
            OrdinalOutcome::Convert { end, .. } | OrdinalOutcome::KeepWords { end }
                if continues_unwritten_number(&tokens, index, last_rewrite_end) =>
            {
                keep_words(&mut output, &tokens, index, end);
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                continue;
            }
            OrdinalOutcome::Convert { value, end } if span_is_contiguous(&tokens, index, end) => {
                let rewrite = Rewrite {
                    text: format!("{}{}", format_cardinal(value), ordinal_suffix(value)),
                    end,
                };
                observe(index, end, &rewrite.text);
                emit_rewrite(&mut output, &tokens, index, &rewrite);
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                last_rewrite_end = Some(index);
                continue;
            }
            OrdinalOutcome::KeepWords { end } => {
                keep_words(&mut output, &tokens, index, end);
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                continue;
            }
            _ => {}
        }

        // A run of spoken digits that no rule above claimed -- an eight- or
        // nine-digit string, or a two-digit "oh five" -- stays whole. No rule
        // can consume the "oh", so converting the digits around it is exactly
        // the half-written form all-or-nothing exists to prevent.
        let (run_digits, run_end) = single_digit_run(&tokens, index);
        if run_digits.len() >= 2
            && tokens[index..run_end]
                .iter()
                .any(|token| token.core_lower == "oh")
        {
            for token in &tokens[index..run_end] {
                output.push_str(&token.render());
            }
            time_context_open =
                time_context_survives(time_context_open, &tokens, index, run_end, true);
            index = run_end;
            continue;
        }

        if let Some(end) = ambiguous_adjacency_end(&tokens, index) {
            for token in &tokens[index..end] {
                output.push_str(&token.render());
            }
            time_context_open = time_context_survives(time_context_open, &tokens, index, end, true);
            index = end;
            continue;
        }

        if let Some((value, end)) = parse_cardinal(&tokens, index) {
            // "two hundred fifteen oh eight": a spoken "oh" and digit after
            // the number belong to it, and no rule can write them, so the
            // whole phrase stays as words rather than "215 oh eight".
            if span_continues(&tokens, index, end) {
                if let Some((_, oh_end)) = parse_oh_digit(&tokens, end) {
                    let (_, run_end) = single_digit_run(&tokens, oh_end);
                    let words_end = run_end.max(oh_end);
                    keep_words(&mut output, &tokens, index, words_end);
                    time_context_open =
                        time_context_survives(time_context_open, &tokens, index, words_end, true);
                    index = words_end;
                    continue;
                }
            }
            let unwritable_end = unwritable_number_phrase_end(&tokens, index, end).or_else(|| {
                partner_of_unwritten_number(&tokens, index, last_rewrite_end).then_some(end)
            });
            if let Some(words_end) = unwritable_end {
                keep_words(&mut output, &tokens, index, words_end);
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, words_end, true);
                index = words_end;
                continue;
            }
            // A bare "one" is a determiner as often as it is a count.
            let bare_one = end - index == 1 && value == 1;
            // The tail of a decimal whose integer half never arrived: "point
            // five" is 0.5 spoken loosely, and "point 5" is neither form.
            let orphaned_decimal_tail = index
                .checked_sub(1)
                .and_then(|previous| tokens.get(previous))
                .is_some_and(|previous| !previous.protected && previous.core_lower == "point")
                && span_continues(&tokens, index - 1, index);
            let small_is_data =
                voice_style && value < 10 && style::small_number_is_data(&tokens, index, end);
            let prose_small = voice_style && value < 10 && !small_is_data;
            if (!bare_one || small_is_data)
                && !prose_small
                && !orphaned_decimal_tail
                && !ratio_partner_stays_a_word(&tokens, end)
                && !followed_by_unabsorbed_scale(&tokens, index, end)
                && span_is_contiguous(&tokens, index, end)
            {
                let rewrite = Rewrite {
                    text: format_cardinal(value),
                    end,
                };
                observe(index, end, &rewrite.text);
                emit_rewrite(&mut output, &tokens, index, &rewrite);
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                last_rewrite_end = Some(index);
                continue;
            }
        }

        output.push_str(&token.render());
        time_context_open =
            time_context_survives(time_context_open, &tokens, index, index + 1, false);
        index += 1;
    }

    output
}

/// Restore proven single-token numeric renderings to their original spoken
/// forms while keeping the candidate's surrounding punctuation and case.
/// Unsupported multi-token formats return None, leaving the caller's literal
/// fallback intact. Matching is positional, so repeated values cannot drift.
pub(crate) fn restore_spoken_number_forms(
    source: &str,
    candidate: &str,
    protected: &[String],
) -> Option<String> {
    let mut changes = Vec::new();
    let canonical = normalize_with_observer(source, protected, false, |start, end, rendered| {
        changes.push((start, end, rendered.to_string()))
    });
    if changes.is_empty() {
        return None;
    }
    let normalized_candidate = inverse_text_normalize_protecting(candidate, protected);
    let canonical_tokens = tokenize(&canonical);
    let candidate_tokens = tokenize(&normalized_candidate);
    if canonical_tokens.len() != candidate_tokens.len()
        || canonical_tokens
            .iter()
            .zip(&candidate_tokens)
            .any(|(left, right)| {
                left.core_lower.replace('’', "'") != right.core_lower.replace('’', "'")
            })
    {
        return None;
    }
    fn core_ranges(tokens: &[Token]) -> Vec<std::ops::Range<usize>> {
        let mut position = 0;
        tokens
            .iter()
            .map(|token| {
                position += token.space_before.len() + token.lead.len();
                let start = position;
                position += token.core.len();
                let end = position;
                position += token.trail.len();
                start..end
            })
            .collect()
    }
    let source_ranges = core_ranges(&tokenize(source));
    let candidate_ranges = core_ranges(&candidate_tokens);
    let mut removed = 0;
    let mut replacements = Vec::new();
    for (start, end, rendered) in changes {
        let key = tokenize(&rendered);
        if key.len() != 1
            || !key[0].lead.is_empty()
            || !key[0].trail.is_empty()
            || key[0].core != rendered
        {
            return None;
        }
        let index = start.checked_sub(removed)?;
        if candidate_tokens.get(index)?.core != rendered {
            return None;
        }
        let original = source
            .get(source_ranges.get(start)?.start..source_ranges.get(end.checked_sub(1)?)?.end)?;
        replacements.push((candidate_ranges.get(index)?.clone(), original));
        removed = removed.checked_add(end.checked_sub(start)?.checked_sub(1)?)?;
    }
    let mut output = normalized_candidate;
    for (range, original) in replacements.into_iter().rev() {
        output.replace_range(range, original);
    }
    Some(output)
}

/// Writes `tokens[start..end]` back unchanged.
fn keep_words(output: &mut String, tokens: &[Token], start: usize, end: usize) {
    for token in &tokens[start..end] {
        output.push_str(&token.render());
    }
}

fn emit_rewrite(output: &mut String, tokens: &[Token], start: usize, rewrite: &Rewrite) {
    let first = &tokens[start];
    let last = &tokens[rewrite.end - 1];
    output.push_str(&first.space_before);
    output.push_str(&first.lead);
    output.push_str(&rewrite.text);
    output.push_str(&last.trail);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn itn(input: &str) -> String {
        inverse_text_normalize(input)
    }

    #[test]
    fn pounds_need_money_context() {
        for (input, expected) in [
            (
                "The patient weighs one hundred and five pounds.",
                "The patient weighs 105 pounds.",
            ),
            ("He weighs two pounds.", "He weighs 2 pounds."),
            (
                "The patient lost twelve pounds.",
                "The patient lost 12 pounds.",
            ),
            (
                "The baby weighs seven pounds five ounces.",
                "The baby weighs 7 pounds 5 ounces.",
            ),
            (
                "The dumbbell weighs five pounds each.",
                "The dumbbell weighs 5 pounds each.",
            ),
            (
                "Lift two pounds, not five pounds.",
                "Lift 2 pounds, not 5 pounds.",
            ),
            (
                "The parcel is two pounds heavy.",
                "The parcel is 2 pounds heavy.",
            ),
            (
                "The patient gained twelve pounds.",
                "The patient gained 12 pounds.",
            ),
            (
                "The baby was born at six pounds and eight ounces.",
                "The baby was born at 6 pounds and 8 ounces.",
            ),
            ("I have five pounds.", "I have 5 pounds."),
            ("The price is five pounds.", "The price is £5."),
            ("I paid six pounds and eight pence.", "I paid £6.08."),
            ("six pounds sterling", "£6"),
            ("six pounds and eight pence", "£6.08"),
            ("The budget is five pounds.", "The budget is £5."),
            ("I owe five pounds.", "I owe £5."),
            ("I spent five pounds.", "I spent £5."),
            (
                "I paid for a parcel weighing two pounds.",
                "I paid for a parcel weighing 2 pounds.",
            ),
            ("The flour costs five pounds.", "The flour costs £5."),
            ("I paid five pounds of flour.", "I paid 5 pounds of flour."),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn partial_number_phrases_stay_whole() {
        // No rule writes these whole, so no part of them is written.
        for input in [
            "Add two thirds of a cup.",
            "Add two and a half cups.",
            "Add two and three quarters cups.",
            "Use Python three point one eleven.",
            "Use Python three point eleven point two.",
            "The blood pressure was one twenty over eighty.",
            "one twenty over eighty",
            "Python three point eleven",
            "Use Python three point eleven.",
            "two over one",
            "one or two",
            "Count from one to five.",
        ] {
            assert_eq!(itn(input), input, "{input}");
        }
        for (input, expected) in [
            (
                "Buy ten thousand shares at three point fifty.",
                "Buy 10,000 shares at three point fifty.",
            ),
            (
                "Meet at ten oh five, not ten oh fifteen.",
                "Meet at 10:05, not ten oh fifteen.",
            ),
            // Whole phrases still convert.
            (
                "Version two point oh five is stable.",
                "Version 2.05 is stable.",
            ),
            ("The INR was one point two five.", "The INR was 1.25."),
            ("one hundred twenty over eighty", "120 over 80"),
            ("twenty one to seven", "21 to 7"),
            (
                "Revenue was one point two billion.",
                "Revenue was 1.2 billion.",
            ),
            ("two point guards", "2 point guards"),
            // A line break or bracket ends the phrase.
            ("three point (five", "3 point (5"),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn contrasted_dotted_times_convert_together() {
        assert_eq!(
            render_dotted_clock_times("The meeting is at 4.15, not 4.30."),
            "The meeting is at 4:15, not 4:30."
        );
        // 4.32 is not a round meeting time, so neither converts.
        assert_eq!(
            render_dotted_clock_times("The meeting is at 4.15, not 4.32."),
            "The meeting is at 4.15, not 4.32."
        );
    }

    #[test]
    fn cardinals_compose_up_to_millions() {
        assert_eq!(itn("one hundred twenty three"), "123");
        assert_eq!(itn("two thousand and twenty six"), "2026");
        assert_eq!(itn("twenty five kilometers"), "25 kilometers");
        assert_eq!(itn("three million four hundred thousand"), "3,400,000");
        assert_eq!(itn("we need forty two servers"), "we need 42 servers");
    }

    #[test]
    fn units_keep_the_word_the_user_said() {
        // Abbreviating to "25 km" would put words in the user's mouth; the
        // stage only rewrites the number.
        assert_eq!(itn("twenty five kilometers"), "25 kilometers");
        assert_eq!(itn("sixty miles per hour"), "60 miles per hour");
    }

    #[test]
    fn decimals_only_after_a_number() {
        assert_eq!(itn("three point five"), "3.5");
        assert_eq!(itn("version two point five"), "version 2.5");
        assert_eq!(itn("pi is three point one four"), "pi is 3.14");
        assert_eq!(itn("the point is simple"), "the point is simple");
        assert_eq!(itn("that is the point"), "that is the point");
    }

    #[test]
    fn percentages_lose_the_spoken_word() {
        assert_eq!(itn("twenty percent off"), "20% off");
        assert_eq!(itn("three point five percent"), "3.5%");
        assert_eq!(itn("ninety nine per cent sure"), "99% sure");
    }

    #[test]
    fn currency_handles_symbols_and_cents() {
        assert_eq!(itn("twelve dollars fifty"), "$12.50");
        assert_eq!(itn("twelve dollars and fifty cents"), "$12.50");
        assert_eq!(itn("it costs five euros"), "it costs \u{20ac}5");
        assert_eq!(itn("it costs three pounds fifty"), "it costs \u{a3}3.50");
        assert_eq!(itn("twelve dollars and five cents"), "$12.05");
        // A weight, not a currency.
        assert_eq!(itn("three pounds of flour"), "3 pounds of flour");
    }

    #[test]
    fn currency_never_writes_only_the_tail_of_a_larger_amount() {
        for (input, expected) in [
            // The recognizer lost "one": writing "$240.75" would show a
            // plausible, wrong amount. The whole phrase stays as words.
            (
                "thousand two hundred forty dollars and seventy five cents",
                "thousand two hundred forty dollars and seventy five cents",
            ),
            (
                "The invoice comes to thousand two hundred forty dollars.",
                "The invoice comes to thousand two hundred forty dollars.",
            ),
            (
                "a thousand two hundred forty people came",
                "a thousand two hundred forty people came",
            ),
            ("a thousand and one nights", "a thousand and one nights"),
            // A garbled amount is not rewritten into an invented one.
            (
                "the total of four thousand hundred and fifty dollars",
                "the total of four thousand hundred and fifty dollars",
            ),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn written_amounts_take_spoken_cents() {
        assert_eq!(
            itn("The invoice comes to $1,240 and 75 cents."),
            "The invoice comes to $1,240.75."
        );
        assert_eq!(itn("$12 and seventy-five cents"), "$12.75");
        assert_eq!(itn("$12 and seventy five cents each"), "$12.75 each");
        assert_eq!(itn("€5 and five cents"), "€5.05");
        // Not cents, or not a whole amount: unchanged.
        assert_eq!(itn("$12 and 50 people"), "$12 and 50 people");
        assert_eq!(itn("$12.50 and 5 cents"), "$12.50 and 5 cents");
        assert_eq!(itn("$12 and 150 cents"), "$12 and 150 cents");
        assert_eq!(itn("$12, and 50 cents"), "$12, and 50 cents");
    }

    #[test]
    fn currency_reads_an_article_before_a_scale_as_one() {
        assert_eq!(itn("a hundred and fifty dollars"), "$150");
        assert_eq!(itn("a thousand dollars"), "$1,000");
        assert_eq!(
            itn("it comes to a thousand two hundred forty dollars and seventy five cents"),
            "it comes to $1,240.75"
        );
        // Outside an amount the article stays a word.
        assert_eq!(itn("about a hundred people"), "about a hundred people");
        assert_eq!(itn("thanks a million"), "thanks a million");
        assert_eq!(itn("a dollar"), "a dollar");
    }

    #[test]
    fn an_article_after_a_fraction_or_idiom_is_not_one() {
        for text in [
            "we raised half a million dollars last year",
            "I feel like a million dollars",
            "a quarter of a million dollars",
            "a third of a million dollars",
            "it was over half a million dollars",
        ] {
            assert_eq!(itn(text), text, "{text}");
        }
        // After a word that introduces an amount the article is still one.
        for (input, expected) in [
            (
                "the total came to a thousand two hundred forty dollars and seventy five cents",
                "the total came to $1,240.75",
            ),
            ("we paid a thousand dollars", "we paid $1,000"),
            ("it costs a hundred dollars", "it costs $100"),
            ("we raised a million dollars", "we raised $1 million"),
            ("for about a hundred dollars", "for about $100"),
            ("A thousand dollars is plenty.", "$1,000 is plenty."),
            ("Done. A hundred dollars came in.", "Done. $100 came in."),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn spoken_money_is_written_the_way_it_is_typed() {
        for (input, expected) in [
            ("three point two million dollars", "$3.2 million"),
            (
                "The round was three point two million dollars.",
                "The round was $3.2 million.",
            ),
            ("twelve hundred dollars", "$1,200"),
            ("twelve hundred and fifty dollars", "$1,250"),
            ("it cost three million dollars", "it cost $3 million"),
            ("a billion dollars", "$1 billion"),
            ("one point five billion euros", "\u{20ac}1.5 billion"),
            ("one hundred million dollars", "$100 million"),
            // Spoken in full, the amount is written in full.
            ("three million four hundred thousand dollars", "$3,400,000"),
            ("two million, three hundred thousand dollars", "$2,300,000"),
            ("two point three thousand dollars", "$2,300"),
            // Decimals of a unit are cents.
            ("two point five dollars", "$2.50"),
            ("three point one four dollars", "$3.14"),
            ("three point oh five dollars", "$3.05"),
            ("fifteen hundred dollars and fifty cents", "$1,500.50"),
            ("twelve dollars and five cents", "$12.05"),
            // The recognizer wrote the digits but said the scale and unit.
            ("3.2 million dollars", "$3.2 million"),
            ("we paid 5 million pounds", "we paid \u{a3}5 million"),
            (
                "it's 5 million pounds of flour",
                "it's 5 million pounds of flour",
            ),
            ("2,000 million dollars", "2,000 million dollars"),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn spoken_money_leaves_non_amounts_alone() {
        for text in [
            "a million reasons",
            "thanks a million",
            "point three of a second",
            "we raised half a million dollars",
            "I feel like a million dollars",
            "ten to one odds",
            "three point one eleven dollars",
        ] {
            assert_eq!(itn(text), text, "{text}");
        }
        assert_eq!(itn("three point two million people"), "3.2 million people");
        assert_eq!(itn("minus five dollars"), "minus $5");
        assert_eq!(
            itn("negative three point two million dollars"),
            "negative $3.2 million"
        );
        assert_eq!(
            itn("the balance is minus twelve dollars fifty"),
            "the balance is minus $12.50"
        );
    }

    #[test]
    fn a_money_range_writes_both_ends_or_neither() {
        for (input, expected) in [
            ("two to three million dollars", "$2 million to $3 million"),
            (
                "between two and three million dollars.",
                "between $2 million and $3 million.",
            ),
            ("two or three million dollars", "$2 million or $3 million"),
            (
                "one point five to two million dollars",
                "$1.5 million to $2 million",
            ),
            ("ten to fifteen thousand dollars", "$10,000 to $15,000"),
            ("two to three hundred dollars", "$200 to $300"),
            ("fifty to a hundred dollars", "$50 to $100"),
            ("five to ten dollars each", "$5 to $10 each"),
            (
                "five hundred thousand to two million dollars",
                "$500,000 to $2 million",
            ),
            ("twelve dollars fifty or thirteen dollars", "$12.50 or $13"),
            // Which end is meant is unclear: $5 or $500? $900 or $900,000?
            (
                "five to three hundred dollars",
                "five to three hundred dollars",
            ),
            (
                "nine hundred to two million dollars",
                "nine hundred to two million dollars",
            ),
            // Out of order, so the head is not a scaled partner.
            (
                "five to three million dollars",
                "five to three million dollars",
            ),
            ("ten to five dollars", "ten to five dollars"),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn a_count_range_with_a_shared_scale_stays_words() {
        for text in [
            "two to three million people",
            "ten to fifteen thousand people",
            "two point five to three million people",
            "two to three hundred people",
        ] {
            assert_eq!(itn(text), text, "{text}");
        }
        assert_eq!(itn("twenty to three hundred people"), "20 to 300 people");
        assert_eq!(itn("from nine to five"), "from 9 to 5");
        assert_eq!(itn("fifty to sixty people"), "50 to 60 people");
    }

    #[test]
    fn a_repeated_unit_after_a_written_scaled_amount_is_dropped() {
        let normalize = |text: &str| normalize_repeated_currency_units(text, &[], &[]);
        assert_eq!(
            normalize("The budget is $3.2 million dollars."),
            "The budget is $3.2 million."
        );
        assert_eq!(normalize("$5 billion euros"), "$5 billion euros");
        assert_eq!(normalize("€5 billion euros"), "€5 billion");
        assert_eq!(normalize("$5 dollars"), "$5");
        assert_eq!(normalize("$3 thousand dollars"), "$3 thousand dollars");
    }

    #[test]
    fn a_comma_after_a_year_like_number_is_not_a_thousands_separator() {
        for (input, expected) in [
            (
                "In two thousand, five hundred dollars was a lot of money.",
                "In 2000, $500 was a lot of money.",
            ),
            (
                "Since two thousand, five hundred dollars has been the fee.",
                "Since 2000, $500 has been the fee.",
            ),
            (
                "By two thousand, three hundred dollars was the limit.",
                "By 2000, $300 was the limit.",
            ),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
        // After an amount word the comma still joins.
        assert_eq!(
            itn("It costs two thousand, five hundred dollars."),
            "It costs $2,500."
        );
    }

    #[test]
    fn currency_joins_a_recognizer_comma_after_the_scale_word() {
        assert_eq!(
            itn("The invoice comes to one thousand, two hundred forty dollars and seventy-five cents."),
            "The invoice comes to $1,240.75."
        );
        assert_eq!(
            itn("two million, three hundred thousand dollars"),
            "$2,300,000"
        );
        assert_eq!(
            itn("It costs a thousand, two hundred dollars."),
            "It costs $1,200."
        );
        // Without a currency unit the comma may separate two numbers.
        assert_eq!(
            itn("In two thousand, three people moved."),
            "In 2000, 3 people moved."
        );
        assert_eq!(
            itn("we sold one thousand, two hundred units"),
            "we sold 1000, 200 units"
        );
        // A following group as large as the scale is a separate amount.
        assert_eq!(itn("one thousand, two thousand dollars"), "1000, $2,000");
    }

    #[test]
    fn currency_preserves_following_counts() {
        for (input, expected) in [
            (
                "The budget is twelve dollars and fifty people volunteered.",
                "The budget is $12 and 50 people volunteered.",
            ),
            (
                "We need twelve dollars and twenty five chairs.",
                "We need $12 and 25 chairs.",
            ),
            ("twelve dollars fifty people", "$12 50 people"),
            ("twelve dollars and fifty", "$12 and 50"),
            ("twelve dollars and fifty each", "$12 and 50 each"),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn currency_accepts_bare_cents_at_price_boundaries() {
        for (input, expected) in [
            ("twelve dollars fifty.", "$12.50."),
            ("twelve dollars twenty five each", "$12.25 each"),
            ("twelve dollars fifty per ticket", "$12.50 per ticket"),
            (
                "Lunch twelve dollars fifty\nTaxi eight dollars",
                "Lunch $12.50\nTaxi $8",
            ),
            (
                "Lunch twelve dollars fifty\r\nTaxi eight dollars",
                "Lunch $12.50\r\nTaxi $8",
            ),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn currency_accepts_complete_explicit_price_alternatives() {
        for (input, expected) in [
            (
                "it costs three pounds fifty or five euros",
                "it costs £3.50 or €5",
            ),
            ("twelve dollars twenty five or six euros", "$12.25 or €6"),
            ("twelve dollars fifty or five euros.", "$12.50 or €5."),
            (
                "twelve dollars fifty or five euros each",
                "$12.50 or €5 each",
            ),
            (
                "twelve dollars fifty or five euros per ticket",
                "$12.50 or €5 per ticket",
            ),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
    }

    #[test]
    fn currency_alternatives_preserve_counts_and_ambiguous_spans() {
        for (input, expected) in [
            ("twelve dollars fifty or five people", "$12 50 or 5 people"),
            (
                "twelve dollars fifty people or five euros",
                "$12 50 people or €5",
            ),
            ("twelve dollars and fifty or five euros", "$12 and 50 or €5"),
            (
                "twelve dollars fifty or five pounds of flour",
                "$12 50 or 5 pounds of flour",
            ),
            ("twelve dollars fifty or", "$12 50 or"),
            ("twelve dollars fifty or five", "$12 50 or 5"),
            (
                "twelve dollars fifty or five euros more",
                "$12 50 or €5 more",
            ),
            ("twelve dollars fifty or (five euros", "$12 50 or (€5"),
            ("twelve dollars fifty or five (euros", "$12 50 or 5 (euros"),
            ("twelve dollars fifty or\nfive euros", "$12 50 or\n€5"),
            ("twelve dollars fifty or five\neuros", "$12 50 or 5\neuros"),
            ("twelve dollars five or five euros", "$12 5 or €5"),
            ("twelve dollars one hundred or five euros", "$12 100 or €5"),
        ] {
            assert_eq!(itn(input), expected, "{input}");
        }
        assert_eq!(itn("1250"), "1250");
        assert_eq!(itn("twelve fifty"), "twelve fifty");
    }

    #[test]
    fn currency_alternatives_do_not_use_protected_words_as_price_evidence() {
        let input = "twelve dollars fifty or five euros";
        for (phrase, expected) in [
            ("or", "$12 50 or €5"),
            ("five", "$12 50 or five euros"),
            ("euros", "$12 50 or 5 euros"),
            ("five euros", "$12 50 or five euros"),
        ] {
            assert_eq!(
                inverse_text_normalize_protecting(input, &[phrase.to_string()]),
                expected,
                "{phrase}",
            );
        }
    }

    #[test]
    fn repeated_currency_units_preserve_written_amounts_and_literal_regions() {
        for (input, expected) in [
            ("Rate €1.4 euros per pound.", "Rate €1.4 per pound."),
            (
                "Costs $25 dollars, roughly £17 pounds.",
                "Costs $25, roughly £17.",
            ),
            ("(-€1.40 Euros.)", "(-€1.40.)"),
            ("Costs $1,250.00 dollars.", "Costs $1,250.00."),
            (
                "Use `foo`; rate €1.4 euros per pound.",
                "Use `foo`; rate €1.4 per pound.",
            ),
            (
                "Use ``price €25 euros``; pay €2 euros.",
                "Use ``price €25 euros``; pay €2.",
            ),
            (
                "Say \"pay €1.4 euros\" then pay €2 euros.",
                "Say \"pay €1.4 euros\" then pay €2.",
            ),
            (
                "Say 'pay €1.4 euros' then pay €2 euros.",
                "Say 'pay €1.4 euros' then pay €2.",
            ),
            (
                r#"Say "use \"fee\" €25 euros"; pay €2 euros."#,
                r#"Say "use \"fee\" €25 euros"; pay €2."#,
            ),
        ] {
            assert_eq!(normalize_repeated_currency_units(input, &[], &[]), expected);
            assert_eq!(
                normalize_repeated_currency_units(expected, &[], &[]),
                expected
            );
        }
        for input in [
            "€1.4 pounds",
            "$25 euros",
            "€1,4 euros",
            "€25, euros",
            "€25\neuros",
            "$12 dollars fifty",
            "$12 dollars, fifty cents",
            "$12 dollars; fifty cents",
            "$12 dollars and five cents",
            "€25 euros 50 cents",
            "https://example.com/€25 euros",
            "`pay €25 euros`",
            "``price €25 euros``",
            "Say “pay €1.4 euros”",
            "Say ‘pay €1.4 euros’",
        ] {
            assert_eq!(
                normalize_repeated_currency_units(input, &[], &[]),
                input,
                "{input}"
            );
        }
        let phrase = "€1.4 euros".to_string();
        assert_eq!(
            normalize_repeated_currency_units(&phrase, std::slice::from_ref(&phrase), &[]),
            phrase
        );
        assert_eq!(
            normalize_repeated_currency_units("€1.4 Euros", &[], &[phrase]),
            "€1.4 Euros"
        );
    }

    #[test]
    fn clock_digits_need_a_preposition_and_scheduling_evidence() {
        for (input, expected) in [
            (
                "Can you move the call from 445 to 315?",
                "Can you move the call from 4:45 to 3:15?",
            ),
            ("Lunch is at 1230 today.", "Lunch is at 12:30 today."),
            ("I land at 945 pm.", "I land at 9:45 pm."),
            (
                "The meeting runs until 1015.",
                "The meeting runs until 10:15.",
            ),
        ] {
            assert_eq!(render_clock_digits(input), expected, "{input}");
        }
        for input in [
            "We sold 445 units.",
            "Prices went from 445 to 315 dollars.",
            "The call is at 445 Main Street.",
            "Ship at 1275 per crate.",
            "The meeting has 445 attendees at 315 tables.",
            "Room 445 is free at 960.",
            "From 445 to 315 is a big drop.",
            "Move the threshold from 500 to 800.",
            "Can you move the logo up by 150?",
            "Cut the session price by 200 for students.",
            "The meeting ended around 1215, and then we left.",
        ] {
            assert_eq!(render_clock_digits(input), input, "{input}");
        }
    }

    #[test]
    fn dotted_clock_times_become_colons_only_with_explicit_evidence() {
        for (input, expected) in [
            // am/pm right after the number: glued, spaced or dotted, any case.
            ("Call me at 6.30pm.", "Call me at 6:30pm."),
            ("Call me at 6.30 pm.", "Call me at 6:30 pm."),
            (
                "Call me at 6.30 p.m. tomorrow.",
                "Call me at 6:30 p.m. tomorrow.",
            ),
            ("Doors close at 4.45 P.M.", "Doors close at 4:45 P.M."),
            ("Doors close at 9.30am.", "Doors close at 9:30am."),
            ("Meet at 9.30 a.m. sharp.", "Meet at 9:30 a.m. sharp."),
            (
                "I land at 9.45 p.m. on Sunday.",
                "I land at 9:45 p.m. on Sunday.",
            ),
            ("It starts 7.15 PM.", "It starts 7:15 PM."),
            ("Send it at 4.45 pm today.", "Send it at 4:45 pm today."),
            ("Ship it 4.45 pm tomorrow.", "Ship it 4:45 pm tomorrow."),
            // An unambiguous zone abbreviation right after it; 0-23 hours.
            (
                "The webinar starts at 9.30 EST.",
                "The webinar starts at 9:30 EST.",
            ),
            ("Meet at 4.45 GMT.", "Meet at 4:45 GMT."),
            (
                "The window opens at 14.30 UTC.",
                "The window opens at 14:30 UTC.",
            ),
            // A meeting noun right before the preposition, round minutes.
            (
                "Let's move the meeting from 3.15 to 4.30, no wait, to 5 o'clock.",
                "Let's move the meeting from 3:15 to 4:30, no wait, to 5 o'clock.",
            ),
            (
                "Let's move the meeting from 3.15 to five o'clock.",
                "Let's move the meeting from 3:15 to five o'clock.",
            ),
            (
                "The meeting is at 10.15 tomorrow.",
                "The meeting is at 10:15 tomorrow.",
            ),
            ("Our sync's at 2.45.", "Our sync's at 2:45."),
            ("The interview was at 11.00.", "The interview was at 11:00."),
            (
                "Let's have a short meeting at 3.30.",
                "Let's have a short meeting at 3:30.",
            ),
            (
                "The meeting from 3.15 to 4.30 is moved.",
                "The meeting from 3:15 to 4:30 is moved.",
            ),
            // A spelled-out zone counts once the sentence pairs an am/pm time
            // with one.
            (
                "The call is at 9.30am Pacific, which is 12.30 Eastern.",
                "The call is at 9:30am Pacific, which is 12:30 Eastern.",
            ),
            (
                "Interview at 9.30 AM Pacific, 12.30 Eastern is fine.",
                "Interview at 9:30 AM Pacific, 12:30 Eastern is fine.",
            ),
            (
                "The call is at 9:30 a.m. Pacific, which is 12.30 Eastern.",
                "The call is at 9:30 a.m. Pacific, which is 12:30 Eastern.",
            ),
            // A weekday right before the preposition, round minutes, and the
            // number ending its phrase.
            (
                "Can you send the Q3 report to Priya by Friday at 4.45, not Thursday?",
                "Can you send the Q3 report to Priya by Friday at 4:45, not Thursday?",
            ),
            (
                "Stand-up moved to Monday at 10.05.",
                "Stand-up moved to Monday at 10:05.",
            ),
            (
                "Remind me Friday at 4.45 to call Sam.",
                "Remind me Friday at 4:45 to call Sam.",
            ),
            (
                "Tuesday morning until 11.30 works.",
                "Tuesday morning until 11:30 works.",
            ),
            ("Meet Friday at 4.45-5.15.", "Meet Friday at 4:45-5:15."),
            ("Friday at 4.45–5.15.", "Friday at 4:45–5:15."),
            ("Friday at 4.15, not 4.30.", "Friday at 4:15, not 4:30."),
        ] {
            assert_eq!(render_dotted_clock_times(input), expected, "{input}");
        }
    }

    /// Words around a number are no evidence: a missed conversion keeps what
    /// the recognizer wrote, a wrong one turns a reading, price or version
    /// into a time.
    #[test]
    fn dotted_numbers_without_explicit_evidence_stay_decimals() {
        for input in [
            // "Today", "tomorrow", "call", meals, "free" and "available" are
            // said beside prices and readings as often as beside times.
            "Call me at 6.30.",
            "Lunch is at 12.30 today.",
            "We're free tomorrow between 3.15 and 4.30.",
            "The flight at 2.45 is cheaper.",
            "Interview tomorrow at 11.00 with Priya.",
            "Meet at 6.30 or 7.15, whichever works.",
            "Free T4 today at 1.10.",
            "Wrote a covered call at 2.40 on Apple, got filled.",
            "Sold the call at 1.20.",
            "Cable sat all session at 1.27.",
            "Potassium came back today at 5.10 so review the plan.",
            "Back City tonight at 2.10 and send me the slip.",
            "We'll review tomorrow after 2.15 is merged.",
            "The book is available today at 4.49 on Kindle.",
            "Review section 4.15 tomorrow at 4.15.",
            "Her INR this morning was at 2.10, I'll review it with Dr Patel tomorrow.",
            "NPS today at 4.50, review it in the sync.",
            "Back the Lakers tonight at 1.10, talk later.",
            // A meeting noun needs round minutes, an hour of 1-12 and the
            // number ending its phrase.
            "The meeting is at 3.12.",
            "The meeting is at 13.45 on Monday.",
            "The meeting is at 4.75 on Monday.",
            "The meeting is at 4.45 Main Street.",
            "The demo at 2.10 crashed, send logs.",
            "The meeting at 4.15 of the bylaws.",
            // A quantity anywhere vetoes zones, spaced am/pm and meeting
            // nouns, even in another sentence.
            "EPS came in at 2.45 EST.",
            "Revenue for the demo at 4.30 EST.",
            // Results and fares: "class" is also a race or a cabin.
            "He won the class at 2.15.",
            "She finished the class at 3.45.",
            "The class at 1.15 is business class.",
            "The meeting is at 10.15 tomorrow; lunch is $12.",
            "Version 3.15 is out. The demo is at 3.15.",
            "Release v3.15 at the meeting.",
            "We ran 3.15 miles at the meeting.",
            // Zones that are also units, places or spelled out.
            "I compared 3.20 BST and 3.40 AVL.",
            "We shipped 2.50 MT of steel on Monday.",
            "The call is at 9.30 Central Avenue tomorrow.",
            "At 9am she said 2.30 Pacific, which is fine.",
            "Guidance was 1.15 GMT adjusted.",
            "The spread was 0.30 GMT.",
            // A price per unit is not "a.m.", and German "am" is "on".
            "Dinner is at 12.50 a head.",
            "Lunch is at 9.50 a person.",
            "Wir aktualisieren Python 3.11 am Montag.",
            "Der Kurs lag bei 1.25 am Freitag.",
            "Der Preis ist 4.50 am Stand.",
            "Treffen um 9.30 am Montag.",
            "Treffen wir uns 9.30 am besten.",
            "Die Aktie lag bei 4.50 am höchsten.",
            "Er lief 10.45 am schnellsten.",
            "Lunch is at 12.30 am I right.",
            "Is Python 3.11 AM compatible?",
            "Section 3.10 pm notes.",
            "The vote at 4.30 PM Sunak said was close.",
            "Grab the keys at 4.10 pm me when you're there.",
            // As before: versions, prices, rates, doses and trades.
            "The stock closed at 4.45 on Friday.",
            "Upgrade Python from 3.11 to 3.12 on Monday.",
            "Gas was at 3.45 on Monday.",
            "Sold the March calls at 1.20.",
            "We're short the stock at 2.30 tomorrow.",
            "Lunch at 12.30 costs 12.50.",
            "Take 2.5 mg at 8.30 tomorrow.",
            "Upgrade the app at 4.45.2 on Monday.",
            "Pay $4.45 at lunch.",
        ] {
            assert_eq!(render_dotted_clock_times(input), input, "{input}");
        }
    }

    /// Inputs from earlier reviews: prices, versions, rates, readings,
    /// trades, dates and addresses that look like dotted times.
    #[test]
    fn earlier_review_decimals_stay_decimals() {
        for input in [
            "Version 3.15 ships on Friday.",
            "On Tuesday the error rate was at 4.45 percent.",
            "Tomorrow it will be around 4.45 degrees.",
            "At 4.45 the tank was half full.",
            "The call quality scored 4.45 on Friday.",
            "Stand-up moved to Monday at 10.05. Prices rose 4.45 percent.",
            "Upgrade the cluster from 1.29 to 1.30 on Monday.",
            "Keep Python at 3.11 until Monday.",
            "Version 3.11 is out. Upgrade from 3.11 on Monday.",
            "Eggs went from 3.15 to 4.30 on Monday.",
            "Apple closed at 4.45 on Friday.",
            "Coffee at the cafe was around 4.50 on Friday.",
            "Tickets are going for around 9.50 on Friday.",
            "Inflation came in at 3.20 on Tuesday.",
            "The ratio settled at 1.45 on Monday.",
            "Her GPA was at 3.45 on Monday.",
            "Set the multiplier at 2.50 for Friday's demo.",
            "Set the dose at 2.50 tomorrow morning.",
            "The report is due by 3.11, that's a Friday.",
            "Please send it by 1.12 on Monday.",
            "Move it from 3.15 to 4.30 on Friday.",
            "Diesel is expected Monday at 3.45 a gallon.",
            "Happy hour Friday at 4.50 a pint.",
            "Treffen um 9.30 Uhr am Montag.",
            "Le prix est de 4.50 pm.",
            "Upgrade to 3.12 pm build.",
            "Downgrade Kubernetes on Monday from 1.30 to 1.29.",
            "We move Kubernetes on Monday from 1.29 to 1.30.",
            "Freeze Swift on Monday at 5.10.",
            "Yields ended Friday at 4.45.",
            "The ten-year yield ended Friday at 4.45.",
            "The ten-year this morning was at 4.25.",
            "Sterling opened Monday at 1.27.",
            "The baby weighed in Monday at 3.45.",
            "My blood sugar this morning was at 6.20.",
            "Ship it Friday at 1.15 with tip.",
            "The odds tonight at 2.10.",
            "Score tonight at 2.10?",
            "Mortgage hit 6.45 Friday at 6.45.",
            "Friday at 4.45, 2 people.",
            "She runs tomorrow at 5.30 pace.",
            "Train at 1.50 speed tomorrow.",
            "The session at 2.45 GHz tomorrow.",
            "The class at 3.45 GPA minimum.",
            "The March call is at 2.50 and the put is at 1.10.",
            "The flight from 2.45 is $300.",
            "Meet Friday at 9.30! The dose is 2.5mg.",
            "Meet Friday at 9.30\nPrice 4.50",
            "At 9am, the stock was 4.30 Eastern.",
            "At 9am we paid 2.30 Pacific.",
            "Lunch is at 1.15, 13.30 and 1.45.",
            "Meet Friday at 4.45-5.",
            "Meet Friday at 3-4.45.",
            "Potassium this morning was at 3.40, review again tonight.",
            "My blood sugar this morning was at 6.20, I'll send the log to the doctor.",
            "Hemoglobin this morning was at 9.40, we'll review at rounds.",
            "INR on Monday was at 2.10, review Friday.",
            "EUR/USD this morning was at 1.08, send me the update.",
            "The 10-year this morning was at 4.25, let's review before the call.",
            "Unemployment today is at 4.10, review the memo.",
            "Bitcoin today is at 6.45, send it.",
            "Cable this morning was at 1.27, send me a note.",
            "The spread this morning was at 1.25, talk soon.",
            "Sell the calls at 2.50.",
            "Buy the calls at 2.50 tomorrow.",
            "The call is at 1.20, sell it.",
            "Das kostet 4.50 am meisten.",
            "Starts at 9am, team ranked 4.30 Central.",
        ] {
            assert_eq!(render_dotted_clock_times(input), input, "{input}");
        }
    }

    #[test]
    fn a_dotted_time_range_or_list_converts_together_or_not_at_all() {
        for (input, expected) in [
            // Introduced by a meeting noun, every minute round.
            (
                "The meeting is at 1.15, 1.30 and 1.45.",
                "The meeting is at 1:15, 1:30 and 1:45.",
            ),
            ("The demo is at 4.45-5.15.", "The demo is at 4:45-5:15."),
            (
                "The meeting is at 4.45–5.15.",
                "The meeting is at 4:45–5:15.",
            ),
            // The last member's am/pm or zone is shared.
            (
                "Doors are open from 3.15 to 4.30pm.",
                "Doors are open from 3:15 to 4:30pm.",
            ),
            ("Call me at 6.30 or 7.15pm.", "Call me at 6:30 or 7:15pm."),
            (
                "Friday from 4.45 to 5.15 EST.",
                "Friday from 4:45 to 5:15 EST.",
            ),
            // Every member has its own.
            (
                "Open from 9.30am to 12.30pm.",
                "Open from 9:30am to 12:30pm.",
            ),
            (
                "Open from 3.15 pm to 4.30 pm.",
                "Open from 3:15 pm to 4:30 pm.",
            ),
        ] {
            assert_eq!(render_dotted_clock_times(input), expected, "{input}");
        }
        for input in [
            // One member is not a time, so none is.
            "The meeting is at 1.15, 13.30 and 1.45.",
            "The meeting moved from 3.11 to 3.18.",
            "The meeting is from 3.10 to 3.18.",
            "The meeting from 11.30 to 13.30 is moved.",
            "The meeting is at 4.45-5.",
            "The meeting is at 3-4.45.",
            "Friday from 4.45 to 5.15 Main Street.",
            // Only an earlier member is marked: nothing to share forward.
            "Open from 3.15 pm to 4.30.",
            // No evidence at all.
            "Meet tomorrow at 4.45-5.15.",
            "Bump the API from 2.14 to 2.15 by Friday.",
            "Prices went from 3.15 to 4.30 on Monday.",
        ] {
            assert_eq!(render_dotted_clock_times(input), input, "{input}");
        }
    }

    /// The weekday and paired-zone readings are weaker evidence than am/pm,
    /// so money, decimals, versions, scores, units, rooms and chapters around
    /// them stay as written.
    #[test]
    fn weekday_and_paired_zone_times_leave_quantities_alone() {
        for input in [
            "Ship version 4.45 by Friday at 4.45.",
            "Friday at 4.45 kg.",
            "Friday at $4.45.",
            "Friday at 4.45%.",
            "Friday at 4.45 sharp is $20.",
            "Friday at 4.47, not Thursday.",
            "Friday at 13.45, not Thursday.",
            "Friday at 4.45 on Kindle.",
            "Friday at 4.45 with tip.",
            "Friday at 4.45, 2 people.",
            "Friday at 4.45.2 build.",
            "We won Friday at 4.45.",
            "The score Friday at 2.10 held.",
            "Read chapter 12.30 by Friday.",
            "Chapter 12.30 Eastern is due.",
            "Section 4.45 Friday at noon.",
            "At 9am she said 2.30 Pacific, which is fine.",
            "The call is at 9.30 Pacific, which is 12.30 Eastern.",
        ] {
            assert_eq!(render_dotted_clock_times(input), input, "{input}");
        }
        // The am/pm anchor still converts; the labelled or priced number
        // beside it does not.
        for (input, expected) in [
            (
                "At 9.30am Pacific, chapter 12.30 Eastern is due.",
                "At 9:30am Pacific, chapter 12.30 Eastern is due.",
            ),
            (
                "The call is at 9.30am Pacific, which is 12.30 Eastern, priced at $5.",
                "The call is at 9:30am Pacific, which is 12.30 Eastern, priced at $5.",
            ),
            // No zone on the anchor, a street, or the anchor in another
            // sentence.
            (
                "The call is at 9.30am, which is 12.30 Eastern.",
                "The call is at 9:30am, which is 12.30 Eastern.",
            ),
            (
                "The call is at 9.30am Pacific, which is 12.30 Eastern Avenue.",
                "The call is at 9:30am Pacific, which is 12.30 Eastern Avenue.",
            ),
            (
                "The call is at 9.30am Pacific. Then 12.30 Eastern.",
                "The call is at 9:30am Pacific. Then 12.30 Eastern.",
            ),
        ] {
            assert_eq!(render_dotted_clock_times(input), expected, "{input}");
        }
    }

    #[test]
    fn bare_clock_digits_take_a_weekday_or_a_paired_zone() {
        for (input, expected) in [
            (
                "Can you send the Q3 report to Priya by Friday at 445, not Thursday?",
                "Can you send the Q3 report to Priya by Friday at 4:45, not Thursday?",
            ),
            ("Ping me Monday at 1030.", "Ping me Monday at 10:30."),
            (
                "The call is at 9:30 a.m. Pacific, which is 1230 Eastern.",
                "The call is at 9:30 a.m. Pacific, which is 12:30 Eastern.",
            ),
            (
                "The call is at 930am Pacific, which is 1230 Eastern.",
                "The call is at 930am Pacific, which is 12:30 Eastern.",
            ),
        ] {
            assert_eq!(render_clock_digits(input), expected, "{input}");
        }
        for input in [
            "Room 1230 is booked Friday.",
            "Room 1230 on Friday at noon.",
            "We expect 1230 people Friday.",
            "Friday at 1230 people.",
            "Friday at 1230 people, not Thursday.",
            "Friday at 445, 2 people.",
            "Friday at 447, not Thursday.",
            "Friday at 1345, not Thursday.",
            "Friday at 445 to 515.",
            "Sold 445 shares Friday at 315.",
            "Pay $1230 by Friday at 445.",
            "Chapter 1230 Eastern.",
            "At 9am she said 230 Pacific, which is fine.",
            "The call is at 9:30 a.m., which is 1230 Eastern.",
            "The call is at 9:30 a.m. Pacific, which is $1230 Eastern.",
            "The call is at 9:30 a.m. Pacific, which is 1230 Eastern Avenue.",
        ] {
            assert_eq!(render_clock_digits(input), input, "{input}");
        }
    }

    #[test]
    fn protected_digits_keep_bare_clock_digits_as_written() {
        let input = "Send it Friday at 445 to Studio 445.";
        assert_eq!(
            render_clock_digits_protecting(input, &["Studio 445".to_string()]),
            input
        );
        assert_eq!(
            render_clock_digits_protecting("Ping me Monday at 1030.", &["Studio".to_string()]),
            "Ping me Monday at 10:30."
        );
    }

    #[test]
    fn protected_phrases_keep_their_dotted_numbers() {
        let protected = ["Studio 9.30am".to_string()];
        assert_eq!(
            render_dotted_clock_times_protecting(
                "The meeting is at 12.30 today in studio 9.30am.",
                &protected
            ),
            "The meeting is at 12:30 today in studio 9.30am.",
        );
    }

    #[test]
    fn times_need_am_pm_or_an_at() {
        assert_eq!(itn("three thirty"), "three thirty");
        assert_eq!(itn("meet at three thirty"), "meet at 3:30");
        assert_eq!(itn("meet at three thirty pm"), "meet at 3:30 pm");
        assert_eq!(itn("three thirty pm works"), "3:30 pm works");
        assert_eq!(itn("call at three oh five"), "call at 3:05");
        // A bare unit after the hour is not a minute.
        assert_eq!(itn("at six six"), "at six six");
    }

    #[test]
    fn dates_take_month_names_ordinals_and_years() {
        assert_eq!(itn("march third"), "March 3");
        assert_eq!(itn("march third at three thirty pm"), "March 3 at 3:30 pm");
        assert_eq!(
            itn("the release ships in march twenty twenty six"),
            "the release ships in March 2026"
        );
        assert_eq!(itn("january fifth twenty twenty five"), "January 5, 2025");
        assert_eq!(itn("january twenty five"), "January 25");
        assert_eq!(itn("january twenty twenty six"), "January 2026");
        assert_eq!(itn("the first of may"), "the 1st of May");
    }

    #[test]
    fn month_words_that_are_also_ordinary_words_need_a_stronger_signal() {
        assert_eq!(itn("i may one day get to it"), "i may one day get to it");
        assert_eq!(itn("we march five miles"), "we march 5 miles");
        assert_eq!(itn("we march twenty five miles"), "we march 25 miles");
        // At the head of a phrase the month reading wins, so an ordinal day
        // needs nothing more.
        assert_eq!(itn("may fifth"), "May 5");
        assert_eq!(itn("may twenty second"), "May 22");
        assert_eq!(itn("march five twenty twenty six"), "March 5, 2026");
        // An unambiguous month name takes a bare cardinal day.
        assert_eq!(itn("january five"), "January 5");
    }

    /// The guard used to sit on the cardinal branch only, so an ordinal day
    /// after "may"/"march" converted whatever the sentence around it said.
    #[test]
    fn an_ordinal_after_an_ordinary_word_month_needs_date_context_too() {
        assert_eq!(itn("i may second that motion"), "i may second that motion");
        assert_eq!(itn("we may first go"), "we may first go");
        assert_eq!(
            itn("i march second in the parade"),
            "i march second in the parade"
        );
        assert_eq!(itn("we may third the motion"), "we may third the motion");
        // "first"/"second" keep their ordinary reading even at the head of a
        // phrase; every other ordinal is a date there.
        assert_eq!(itn("may first we ship"), "may first we ship");
        assert_eq!(
            itn("march second in the parade"),
            "march second in the parade"
        );
        assert_eq!(itn("march third"), "March 3");
        // A clock time after the day is a date signal on its own, which is
        // what keeps "let us meet march third at three thirty pm" a date
        // while "i march second in the parade" is not.
        assert_eq!(
            itn("let us meet march third at three thirty pm"),
            "let us meet March 3 at 3:30 pm"
        );
        assert_eq!(itn("we march first at dawn"), "we march first at dawn");
        // A date word before the month, an explicit "the", or a year after
        // the day is signal enough for any ordinal.
        assert_eq!(itn("on may first"), "on May 1");
        assert_eq!(itn("by march second"), "by March 2");
        assert_eq!(itn("until august first"), "until August 1");
        assert_eq!(itn("may the fourth"), "May 4");
        assert_eq!(itn("may first twenty twenty six"), "May 1, 2026");
        assert_eq!(itn("on may fifth"), "on May 5");
        // An unambiguous month is unaffected by any of it.
        assert_eq!(
            itn("i january second that motion"),
            "i January 2 that motion"
        );
    }

    #[test]
    fn twenty_twenty_six_is_a_year_only_in_a_date_context() {
        assert_eq!(itn("twenty twenty six"), "twenty twenty six");
        assert_eq!(itn("in march twenty twenty six"), "in March 2026");
        assert_eq!(itn("nineteen eighty four"), "nineteen eighty four");
        assert_eq!(itn("june nineteen eighty four"), "June 1984");
    }

    #[test]
    fn adjacent_numbers_that_do_not_compose_stay_as_words() {
        // The crate this stage replaced turned this into "95" (7 + 88).
        assert_eq!(itn("seven eighty eight"), "seven eighty eight");
        assert_eq!(itn("two thirty"), "two thirty");
        assert_eq!(itn("chapter two section three"), "chapter 2 section 3");
    }

    #[test]
    fn a_bare_one_is_never_a_digit() {
        assert_eq!(itn("one of them is broken"), "one of them is broken");
        assert_eq!(itn("one drive is full"), "one drive is full");
        assert_eq!(itn("he said one thing"), "he said one thing");
        assert_eq!(itn("one hundred"), "100");
    }

    #[test]
    fn a_couple_of_is_untouched() {
        assert_eq!(itn("a couple of things"), "a couple of things");
        assert_eq!(itn("a few more"), "a few more");
    }

    #[test]
    fn homophones_of_number_words_are_untouched() {
        assert_eq!(itn("this is for the team"), "this is for the team");
        assert_eq!(itn("send it to the team"), "send it to the team");
        assert_eq!(itn("for four people"), "for 4 people");
        assert_eq!(itn("to two places"), "to 2 places");
    }

    /// "<number> oh <digit>" is a clock time, a year or an identifier only
    /// with evidence for that reading, and otherwise stays words; it is never
    /// a four-digit number by default and never half written.
    #[test]
    fn a_number_before_oh_and_a_digit_needs_a_reading() {
        let cases = [
            // Clock times: a head of one to twelve and a time word around it.
            ("it's eleven oh five", "it's 11:05"),
            ("it is now twelve oh five", "it is now 12:05"),
            ("ten oh five tomorrow morning", "10:05 tomorrow morning"),
            (
                "the meeting is ten oh five to ten thirty",
                "the meeting is 10:05 to 10:30",
            ),
            ("from ten oh five to eleven", "from 10:05 to 11"),
            ("ten oh five a m", "10:05 a m"),
            ("meet at ten oh five pm", "meet at 10:05 pm"),
            ("it's two oh five", "it's 2:05"),
            ("call at three oh five", "call at 3:05"),
            // No twenty-four-hour clock and no four-digit guess.
            ("at twenty oh five", "at twenty oh five"),
            ("by twenty oh five", "by twenty oh five"),
            ("at fifteen oh eight", "at fifteen oh eight"),
            (
                "I said fifteen oh eight more",
                "I said fifteen oh eight more",
            ),
            ("ten oh five", "ten oh five"),
            ("twelve oh one", "twelve oh one"),
            (
                "the twenty oh eight election",
                "the twenty oh eight election",
            ),
            // LibriSpeech test-other: "15 oh eight" was half written; with
            // no reading it stays words.
            (
                "confectionary, fifteen oh eight.",
                "confectionary, fifteen oh eight.",
            ),
            // Identifiers and years.
            ("flight fifteen oh eight", "flight 1508"),
            ("flight fifteen oh eight lands", "flight 1508 lands"),
            ("flight eleven oh five", "flight 1105"),
            ("page twenty oh eight", "page 2008"),
            ("version fifteen oh eight", "version 1508"),
            ("in fifteen oh eight", "in 1508"),
            ("in nineteen oh five", "in 1905"),
            ("room two oh one", "room 201"),
            // More number words after it: the whole phrase stays words.
            ("fifteen oh eight thousand", "fifteen oh eight thousand"),
            ("twenty oh five million", "twenty oh five million"),
            (
                "flight fifteen oh eight point five",
                "flight fifteen oh eight point five",
            ),
            ("fifteen oh eight percent", "fifteen oh eight percent"),
            ("fifteen oh eight nine", "fifteen oh eight nine"),
            (
                "two hundred fifteen oh eight",
                "two hundred fifteen oh eight",
            ),
            // A pause is not this shape.
            ("fifteen, oh eight", "15, oh eight"),
        ];
        for (spoken, written) in cases {
            assert_eq!(itn(spoken), written, "{spoken}");
        }
    }

    /// A cardinal followed by "first" .. "tenth" is one ordinal only when the
    /// ordinal ends the phrase, takes "of" or takes a noun from
    /// `ORDINAL_NOUNS`. Otherwise both readings are open (322nd graders, or
    /// 320 second graders), and each written form asserts one of them, so
    /// the whole phrase stays as the words spoken.
    #[test]
    fn ordinal_tails_merge_only_when_the_reading_is_settled() {
        // Ambiguous: unchanged words, never "322nd" and never "320 second".
        for spoken in [
            "three hundred and twenty second graders",
            "three hundred twenty second graders",
            "we have three hundred and twenty second graders this year",
            "a two hundred and forty second video",
            "one hundred twenty second timeout",
            "one hundred and forty second chances",
            "three hundred and twenty first responders",
            "two hundred and fifty third party apps",
            "two hundred and fifty first time buyers",
            "one hundred and sixty fourth quarter results",
            "one hundred and fifty second place finishes",
            "five hundred and fifty first round picks",
            "two hundred and first responders",
            "five hundred and second opinions",
            "one hundred and second hand cars",
            "the one hundred and first time",
            "our two thousand and first order",
            "set a thirty second timer",
            "a sixty second spot",
            "give me a twenty second clip",
            "twenty first responders",
            "the twenty first item",
            "the three hundred twenty fifth row",
            "a thirty-second spot",
            "two hundred twelfth graders",
            // A "first" .. "tenth" word right after "hundred" or a scale.
            "we sold five hundred first editions",
            "nineteen hundred fifth avenue",
            // A fraction, and a tail whose head stayed words.
            "one thousandth of an inch",
            "a hundred and twentieth",
        ] {
            assert_eq!(itn(spoken), spoken);
        }
        // Settled: the end of the phrase, "of", or an ordinal noun.
        for (spoken, written) in [
            ("five hundred and sixty third", "563rd"),
            ("the five hundred and sixty third.", "the 563rd."),
            ("the twenty first century", "the 21st century"),
            ("twenty first of May", "21st of May"),
            ("on the twenty first", "on the 21st"),
            ("his thirty second birthday", "his 32nd birthday"),
            ("the ninety ninth percentile", "the 99th percentile"),
            ("one hundred and second street", "102nd street"),
            ("one million and first", "1,000,001st"),
            ("the twenty-first item", "the 21st item"),
            // A teen or tens tail joined by "and" is always one ordinal.
            ("the seven hundred and eighteenth night", "the 718th night"),
            ("two thousand and fifteenth", "2015th"),
            // Without "and", a teen or tens tail also needs the reading.
            ("the one hundred twelfth floor", "the 112th floor"),
            ("five hundred twentieth", "520th"),
            // "hundredth" and the scales complete the number.
            ("the five hundredth customer", "the 500th customer"),
        ] {
            assert_eq!(itn(spoken), written, "{spoken}");
        }
        // Plain cardinals and plurals are not ordinals.
        assert_eq!(itn("three hundred and twenty seconds"), "320 seconds");
    }

    #[test]
    fn ordinals_with_a_hundred_or_scale_head_stay_one_number() {
        assert_eq!(
            itn("when it was the five hundred and sixty third night"),
            "when it was the 563rd night"
        );
        assert_eq!(
            itn("the seven hundred and eighteenth night"),
            "the 718th night"
        );
        assert_eq!(itn("the three hundred twenty fifth"), "the 325th");
        // A pause breaks the phrase.
        assert_eq!(
            itn("we counted five hundred, third time this week"),
            "we counted 500, third time this week"
        );
        // Plain cardinals are unchanged.
        assert_eq!(itn("five hundred and sixty people"), "560 people");
    }

    #[test]
    fn simple_ordinals_stay_words_outside_a_date() {
        assert_eq!(itn("give me a second"), "give me a second");
        assert_eq!(itn("first let's ship it"), "first let's ship it");
        assert_eq!(itn("the third option"), "the third option");
        assert_eq!(itn("the twenty first."), "the 21st.");
        assert_eq!(itn("the fifteenth item"), "the 15th item");
    }

    #[test]
    fn phone_shaped_digit_runs_become_numbers() {
        assert_eq!(
            itn("call me at five five five one two three four five six seven"),
            "call me at 555-123-4567"
        );
        assert_eq!(
            itn("dial five five five one two three four"),
            "dial 555-1234"
        );
        // Short runs are left alone.
        assert_eq!(itn("one two three"), "one two three");
        assert_eq!(
            itn("extension five five five one two three"),
            "extension five five five one two three"
        );
    }

    #[test]
    fn urls_and_emails_are_never_touched() {
        assert_eq!(
            itn("the file is at https://example.com/two/three"),
            "the file is at https://example.com/two/three"
        );
        assert_eq!(
            itn("email me at jon.reed@example.com about two things"),
            "email me at jon.reed@example.com about 2 things"
        );
        assert_eq!(
            itn("open docs.google.com/three"),
            "open docs.google.com/three"
        );
    }

    #[test]
    fn dictionary_replacements_are_protected() {
        let protected = vec!["Route sixty six".to_string()];
        assert_eq!(
            inverse_text_normalize_protecting("take Route sixty six for twenty miles", &protected),
            "take Route sixty six for 20 miles"
        );
    }

    #[test]
    fn punctuation_and_capitalization_survive() {
        assert_eq!(
            itn("we need twenty, thirty people"),
            "we need 20, 30 people"
        );
        assert_eq!(itn("Twenty five people."), "25 people.");
        assert_eq!(itn("\"twenty five\""), "\"25\"");
        assert_eq!(itn("  spaced  twenty five  "), "  spaced  25  ");
    }

    #[test]
    fn spoken_punctuation_tokens_do_not_change_the_result() {
        // ITN runs before `normalize_spoken_punctuation`; the two lexicons
        // are disjoint, so the order is inert.
        assert_eq!(
            itn("we need twenty comma thirty people"),
            "we need 20 comma 30 people"
        );
        assert_eq!(itn("one dash two"), "one dash 2");
    }

    #[test]
    fn numeric_text_passes_through_unchanged() {
        for input in [
            "232 already numeric 3:30 pm $12.50 January 5, 2025",
            "we shipped 2026 releases",
            "20% of 40",
            "call 555-123-4567",
        ] {
            assert_eq!(itn(input), input, "input: {input}");
        }
    }

    #[test]
    fn the_stage_is_idempotent() {
        for input in [
            "twelve dollars fifty",
            "march third at three thirty pm",
            "one hundred twenty three",
            "call me at five five five one two three four five six seven",
            "twenty percent off",
            "three point five percent",
            "the release ships in march twenty twenty six",
        ] {
            let once = itn(input);
            let twice = itn(&once);
            assert_eq!(once, twice, "input: {input}");
        }
    }

    #[test]
    fn number_rewrites_keep_line_boundaries() {
        assert_eq!(inverse_text_normalize("twenty\nfive Euros"), "20\n€5");
        assert_eq!(inverse_text_normalize("twenty\r\nfive Euros"), "20\r\n€5");
        assert_eq!(inverse_text_normalize("twenty five Euros"), "€25");
        assert_eq!(inverse_text_normalize("twenty\u{00a0}five Euros"), "€25");
        assert_eq!(
            inverse_text_normalize("one point\nfour Euros"),
            "one point\n€4"
        );
    }

    #[test]
    fn empty_and_whitespace_inputs_are_safe() {
        assert_eq!(itn(""), "");
        assert_eq!(itn("   "), "   ");
        assert_eq!(itn("\n\n"), "\n\n");
    }

    #[test]
    fn multibyte_text_is_left_alone() {
        assert_eq!(itn("日本語のテキストです"), "日本語のテキストです");
        assert_eq!(itn("caf\u{e9} twenty five"), "caf\u{e9} 25");
    }

    /// A rewrite replaces a whole span and keeps only its outer punctuation,
    /// so no rule may reach across an interior lead or trail: the paren in
    /// each of these used to disappear.
    #[test]
    fn punctuation_inside_a_span_stops_the_rule() {
        assert_eq!(itn("ten per (cent"), "10 per (cent");
        assert_eq!(itn("the first of (May"), "the first of (May");
        assert_eq!(
            itn("twelve dollars and fifty (cents"),
            "$12 and 50 (cents",
            "the conjunction and paren survive when cents is outside the numeric span"
        );
        assert_eq!(itn("three point (five"), "3 point (5");
        assert_eq!(itn("the first of \"May"), "the first of \"May");
        // The unpunctuated forms are unaffected.
        assert_eq!(itn("ten per cent"), "10%");
        assert_eq!(itn("the first of May"), "the 1st of May");
        assert_eq!(itn("twelve dollars and fifty cents"), "$12.50");
    }

    /// A dictionary replacement or snippet trigger only protects the tokens
    /// it actually spans. A one-letter phrase used to match inside a word and
    /// split the number around it.
    #[test]
    fn a_protected_phrase_must_land_on_token_boundaries() {
        let one_letter = vec!["v".to_string()];
        assert_eq!(
            inverse_text_normalize_protecting("twenty five servers", &one_letter),
            "25 servers",
            "the v inside \"five\" is not a phrase match"
        );
        let other_letter = vec!["a".to_string()];
        assert_eq!(
            inverse_text_normalize_protecting("we have twenty five candidates", &other_letter),
            "we have 25 candidates"
        );
        // A phrase that does land on token boundaries still protects. The
        // rest of that number stays as words too: "one hundred 23" would be
        // half written.
        assert_eq!(
            inverse_text_normalize_protecting("one hundred twenty three", &["one".to_string()]),
            "one hundred twenty three"
        );
        assert_eq!(
            inverse_text_normalize_protecting(
                "take Route sixty six for twenty miles",
                &["Route sixty six".to_string()]
            ),
            "take Route sixty six for 20 miles"
        );
        // Punctuation-carrying replacements anchor on the outer edge.
        assert_eq!(
            inverse_text_normalize_protecting(
                "the U.S. twenty five percent tariff",
                &["U.S.".to_string()]
            ),
            "the U.S. 25% tariff"
        );
    }

    #[test]
    fn repeated_protected_phrases_preserve_each_occurrence() {
        let input = "two ".repeat(10_000);
        assert_eq!(
            inverse_text_normalize_protecting(&input, &["two".to_string()]),
            input
        );
    }

    #[test]
    fn oversized_input_skips_synchronous_normalization() {
        let input = format!("twenty five {}", "x".repeat(MAX_ITN_INPUT_BYTES));
        assert_eq!(inverse_text_normalize(&input), input);
    }

    /// Half-written numbers are worse than the words the user said.
    #[test]
    fn a_phrase_no_rule_can_finish_stays_as_words() {
        assert_eq!(itn("ten to one odds"), "ten to one odds");
        assert_eq!(itn("twenty to one"), "twenty to one");
        assert_eq!(itn("point five"), "point five");
        // The same words with a partner that does convert are unaffected.
        assert_eq!(itn("five to ten minutes"), "5 to 10 minutes");
        assert_eq!(itn("three point five"), "3.5");
        assert_eq!(itn("to two places"), "to 2 places");
        // Punctuation breaks the phrase, so the number is on its own again.
        assert_eq!(
            itn("at this point, five people left"),
            "at this point, 5 people left"
        );
    }

    /// "oh" is only ever a zero inside a run of spoken digits, and nothing
    /// else can consume it -- so the run converts whole or not at all.
    #[test]
    fn spoken_oh_is_a_zero_inside_a_digit_run() {
        assert_eq!(itn("room two oh one"), "room 201");
        assert_eq!(itn("take route one oh one"), "take route 101");
        assert_eq!(itn("suite four oh five six"), "suite 4056");
        // A leading "oh" is the interjection, not a digit.
        assert_eq!(itn("oh five more"), "oh five more");
        // A time context still wins: this one is a clock time.
        assert_eq!(itn("call at three oh five"), "call at 3:05");
    }

    /// A time preposition stays in scope across the glue of a list, so the
    /// items do not come out as one time and two loose number pairs.
    #[test]
    fn a_time_context_survives_a_list() {
        assert_eq!(
            itn("the slots are at three fifteen, three thirty and three forty five"),
            "the slots are at 3:15, 3:30 and 3:45"
        );
        // A word that is not list glue closes the context again.
        assert_eq!(
            itn("meet at three thirty tomorrow three forty five works too"),
            "meet at 3:30 tomorrow three forty five works too"
        );
        // A sentence boundary closes it.
        assert_eq!(
            itn("meet at three thirty. three forty five"),
            "meet at 3:30. three forty five"
        );
    }

    #[test]
    fn thousands_separators_follow_how_the_number_is_written() {
        assert_eq!(itn("seventy five thousand dollars"), "$75,000");
        assert_eq!(
            itn("we hired seventy five thousand people"),
            "we hired 75,000 people"
        );
        assert_eq!(itn("two million five hundred thousand"), "2,500,000");
        assert_eq!(itn("one thousand two hundred dollars"), "$1,200");
        // Below the thresholds, and for years, the digits stay bare.
        assert_eq!(itn("nine thousand nine hundred"), "9900");
        assert_eq!(itn("two thousand and twenty six"), "2026");
        assert_eq!(itn("january fifth twenty twenty five"), "January 5, 2025");
        assert_eq!(itn("one hundred dollars"), "$100");
    }

    #[test]
    fn hyphenated_cardinals_convert_like_hyphenated_ordinals() {
        assert_eq!(itn("twenty-one servers"), "21 servers");
        assert_eq!(itn("twenty\u{2011}one servers"), "21 servers");
        assert_eq!(itn("the twenty-first item"), "the 21st item");
        assert_eq!(itn("the twenty\u{2011}first item"), "the 21st item");
        assert_eq!(itn("one hundred twenty-three"), "123");
        assert_eq!(itn("twenty-one thousand"), "21,000");
        // Not every hyphenated word is a number.
        assert_eq!(itn("a well-known issue"), "a well-known issue");
        assert_eq!(itn("the five-ten range"), "the five-ten range");
    }

    #[test]
    fn only_phone_shaped_digit_run_lengths_are_formatted() {
        assert_eq!(
            itn("call one five five five one two three four five six seven"),
            "call 1-555-123-4567"
        );
        // Eight, nine and twelve digits have no written phone shape, so the
        // run stays as words rather than collapsing into a blob.
        assert_eq!(
            itn("code five five five one two three four five"),
            "code five five five one two three four five"
        );
        assert_eq!(
            itn("code five five five one two three four five six"),
            "code five five five one two three four five six"
        );
        assert_eq!(
            itn("code two five five five one two three four five six seven"),
            "code two five five five one two three four five six seven"
        );
    }
}
