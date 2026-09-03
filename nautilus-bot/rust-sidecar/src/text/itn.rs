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
//! - Units keep the user's word: "twenty five kilometers" -> "25 kilometers",
//!   never "25 km".
//! - All-or-nothing per phrase: a number phrase no single rule can finish
//!   stays entirely as words rather than coming out half-written. "ten to one
//!   odds", "point five" and an eight-digit spoken run are all left alone,
//!   because "10 to one odds", "point 5" and "1234 five six seven" are worse
//!   than the words the user said. A run containing a spoken "oh" is written
//!   whole ("room two oh one" -> "room 201") for the same reason: nothing
//!   else can consume the "oh".
//! - Thousands separators are written the way the number would be typed:
//!   cardinals from 10,000 up ("75,000"), currency from 1,000 up ("$1,200"),
//!   years never.
//! - Running the stage over already-numeric text is a no-op (idempotence).

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
        let mut from = 0usize;
        while from <= text.len() {
            let Some(found) = text[from..].find(needle) else {
                break;
            };
            let start = from + found;
            let end = start + needle.len();
            if boundary_starts.contains(&start) && boundary_ends.contains(&end) {
                for (index, (token_start, token_end)) in ranges.iter().enumerate() {
                    if *token_start < end && start < *token_end {
                        tokens[index].protected = true;
                    }
                }
                from = end;
            } else {
                // Step past this false match by one character rather than by
                // the whole needle, so a real match that overlaps it is still
                // found. `start` and the character length keep `from` on a
                // char boundary.
                from = start + needle.chars().next().map_or(1, char::len_utf8);
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
        if offset > 0 && (digits.len() - offset) % 3 == 0 {
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
/// between the two words ends the number, so "twenty, thirty" is two numbers
/// and "twenty (five" is never merged into one.
fn span_continues(tokens: &[Token], start: usize, index: usize) -> bool {
    if index <= start {
        return true;
    }
    match (tokens.get(index - 1), tokens.get(index)) {
        (Some(previous), Some(current)) => previous.trail.is_empty() && current.lead.is_empty(),
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
fn parse_cardinal(tokens: &[Token], start: usize) -> Option<(u64, usize)> {
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
                Piece::Tens if current % 10 == 0 && value >= 1 => {
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
        let value = match token.core_lower.as_str() {
            "oh" => Some(0),
            other => unit_value(other),
        };
        let Some(value) = value else { break };
        digits.push_str(&value.to_string());
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
    let month_is_also_an_ordinary_word =
        MONTHS_THAT_ARE_ALSO_WORDS.contains(&token.core_lower.as_str());

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
        if tokens
            .get(day_start)
            .is_some_and(|next| next.core_lower == "the")
        {
            day_start += 1;
        }
        let parsed_day = parse_ordinal(tokens, day_start)
            .filter(|(value, _)| (1..=31).contains(value))
            .or_else(|| {
                parse_cardinal_bounded(tokens, day_start, 2)
                    .filter(|(value, _)| (1..=31).contains(value))
                    // "i may one day get to it" is not the 1st of May. A bare
                    // cardinal day after a month word that is also an ordinary
                    // English word needs a year behind it before this reads as
                    // a date; an ordinal day ("may fifth") never has the other
                    // reading.
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

/// A standalone ordinal is only safe to convert when it cannot be an ordinary
/// English word: "give me a second", "first, let's ship" and "the third
/// option" all have to survive. Compound and larger ordinals have no such
/// reading.
fn standalone_ordinal_is_convertible(value: u64, token_count: usize) -> bool {
    token_count > 1 || value > 10
}

fn currency_symbol(word: &str) -> Option<&'static str> {
    Some(match word {
        "dollar" | "dollars" => "$",
        "euro" | "euros" => "\u{20ac}",
        "pound" | "pounds" => "\u{a3}",
        _ => return None,
    })
}

/// `<amount> dollars|euros|pounds [and] [<cents> [cents]]`.
fn try_currency(tokens: &[Token], start: usize) -> Option<Rewrite> {
    let (amount, after_amount) = parse_cardinal(tokens, start)?;
    if !span_continues(tokens, start, after_amount) {
        return None;
    }
    let unit_token = tokens.get(after_amount)?;
    if unit_token.protected {
        return None;
    }
    let symbol = currency_symbol(&unit_token.core_lower)?;
    // "three pounds of flour" is a weight, not GBP.
    if unit_token.core_lower.starts_with("pound")
        && tokens
            .get(after_amount + 1)
            .is_some_and(|next| next.core_lower == "of")
    {
        return None;
    }

    let mut index = after_amount + 1;
    let mut cents: Option<u64> = None;

    // Every step past the currency word has to stay inside one unpunctuated
    // run, because the rewrite replaces the whole span and keeps only its
    // outer punctuation: "twelve dollars and fifty (cents" must not swallow
    // the paren.
    if unit_token.trail.is_empty() && span_continues(tokens, start, index) {
        let mut cents_start = index;
        let mut boundary_holds = true;
        if tokens
            .get(cents_start)
            .is_some_and(|next| !next.protected && next.core_lower == "and")
        {
            boundary_holds = span_continues(tokens, start, cents_start + 1);
            cents_start += 1;
        }
        if boundary_holds {
            if let Some((value, end)) = parse_cardinal_bounded(tokens, cents_start, 2) {
                if value <= 99 {
                    let explicit = span_continues(tokens, start, end)
                        && tokens.get(end).is_some_and(|next| {
                            !next.protected && matches!(next.core_lower.as_str(), "cent" | "cents")
                        });
                    if explicit {
                        cents = Some(value);
                        index = end + 1;
                    } else if value >= 10 {
                        // A bare trailing number is only cents when it reads as
                        // a two-digit one ("twelve dollars fifty"). "twelve
                        // dollars five" could be $12.05 or twelve dollars and
                        // five of something, so it is left alone.
                        cents = Some(value);
                        index = end;
                    }
                }
            }
        }
    }

    let amount = format_currency_amount(amount);
    let text = match cents {
        Some(cents) => format!("{}{}.{:02}", symbol, amount, cents),
        None => format!("{}{}", symbol, amount),
    };
    Some(Rewrite { text, end: index })
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
    Some((format!("{}.{}", format_cardinal(integer), digits), end))
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
    if bridge.protected || !matches!(bridge.core_lower.as_str(), "to" | "or") {
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

/// Convert spoken numbers in `text` to written form.
pub fn inverse_text_normalize(text: &str) -> String {
    inverse_text_normalize_protecting(text, &[])
}

/// Same, but never rewrites inside an occurrence of one of
/// `protected_phrases` -- the dictionary replacements already applied to this
/// text. URLs, emails and paths are protected unconditionally.
pub fn inverse_text_normalize_protecting(text: &str, protected_phrases: &[String]) -> String {
    if text.is_empty() {
        return String::new();
    }

    let mut tokens = tokenize(text);
    if tokens.is_empty() {
        return text.to_string();
    }
    mark_protected_phrases(text, &mut tokens, protected_phrases);

    let mut output = String::with_capacity(text.len());
    let mut index = 0usize;
    let mut time_context_open = false;

    while index < tokens.len() {
        let token = &tokens[index];
        if token.protected || token.core.is_empty() {
            output.push_str(&token.render());
            time_context_open = false;
            index += 1;
            continue;
        }

        let rewrite = try_phone(&tokens, index)
            .or_else(|| try_date(&tokens, index))
            .or_else(|| try_time(&tokens, index, time_context_open))
            .or_else(|| try_digit_string(&tokens, index))
            .or_else(|| try_currency(&tokens, index))
            .or_else(|| try_percent(&tokens, index))
            .or_else(|| parse_decimal(&tokens, index).map(|(text, end)| Rewrite { text, end }))
            // Backstop for the invariant `emit_rewrite` relies on; each rule
            // also checks its own boundaries.
            .filter(|rewrite| span_is_contiguous(&tokens, index, rewrite.end));

        if let Some(rewrite) = rewrite {
            emit_rewrite(&mut output, &tokens, index, &rewrite);
            time_context_open =
                time_context_survives(time_context_open, &tokens, index, rewrite.end, true);
            index = rewrite.end;
            continue;
        }

        // Ordinals are tried before cardinals so "twenty first" is 21st
        // rather than "20 first".
        if let Some((value, end)) = parse_ordinal(&tokens, index) {
            if standalone_ordinal_is_convertible(value, end - index)
                && span_is_contiguous(&tokens, index, end)
            {
                emit_rewrite(
                    &mut output,
                    &tokens,
                    index,
                    &Rewrite {
                        text: format!("{}{}", value, ordinal_suffix(value)),
                        end,
                    },
                );
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
                continue;
            }
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
            // A bare "one" is a determiner as often as it is a count.
            let bare_one = end - index == 1 && value == 1;
            // The tail of a decimal whose integer half never arrived: "point
            // five" is 0.5 spoken loosely, and "point 5" is neither form.
            let orphaned_decimal_tail = index
                .checked_sub(1)
                .and_then(|previous| tokens.get(previous))
                .is_some_and(|previous| !previous.protected && previous.core_lower == "point")
                && span_continues(&tokens, index - 1, index);
            if !bare_one
                && !orphaned_decimal_tail
                && !ratio_partner_stays_a_word(&tokens, end)
                && span_is_contiguous(&tokens, index, end)
            {
                emit_rewrite(
                    &mut output,
                    &tokens,
                    index,
                    &Rewrite {
                        text: format_cardinal(value),
                        end,
                    },
                );
                time_context_open =
                    time_context_survives(time_context_open, &tokens, index, end, true);
                index = end;
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
        // An ordinal, or a year, is signal enough.
        assert_eq!(itn("may fifth"), "May 5");
        assert_eq!(itn("march five twenty twenty six"), "March 5, 2026");
        // An unambiguous month name takes a bare cardinal day.
        assert_eq!(itn("january five"), "January 5");
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

    #[test]
    fn simple_ordinals_stay_words_outside_a_date() {
        assert_eq!(itn("give me a second"), "give me a second");
        assert_eq!(itn("first let's ship it"), "first let's ship it");
        assert_eq!(itn("the third option"), "the third option");
        assert_eq!(itn("the twenty first item"), "the 21st item");
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
            "$12.50 (cents",
            "the amount still converts; the paren must survive"
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
        // A phrase that does land on token boundaries still protects.
        assert_eq!(
            inverse_text_normalize_protecting("one hundred twenty three", &["one".to_string()]),
            "one hundred 23"
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
