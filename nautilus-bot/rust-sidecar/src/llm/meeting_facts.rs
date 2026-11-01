//! Numbers, dates and decisions read straight from meeting text, with no
//! model involved.
//!
//! Two passes use them. Before a long meeting's parts are combined,
//! [`key_details`] lists the lines that state a number, a date, a name or a
//! decision, so the combining step cannot quietly lose them. After notes are
//! written, [`MeetingFacts::unknown_in`] lists the numbers and calendar words
//! in a statement that the meeting never said, in digits or in words.

use std::collections::HashSet;
use std::sync::LazyLock;

/// Values, as canonical decimal strings, and calendar words the meeting
/// mentions anywhere.
#[derive(Debug, Default)]
pub(super) struct MeetingFacts {
    numbers: HashSet<String>,
    calendar: HashSet<String>,
    clocks: HashSet<String>,
    dates: HashSet<String>,
    speaker_labels: HashSet<String>,
}

impl MeetingFacts {
    pub(super) fn from_texts<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut facts = Self::default();
        for text in texts {
            facts.dates.extend(dates_in(text));
            for value in numbers_in(text) {
                facts.numbers.extend(value.variants());
            }
            facts
                .clocks
                .extend(CLOCK.find_iter(text).map(|found| clock_key(found.as_str())));
            for spoken in SPOKEN_CLOCK.captures_iter(text) {
                for number in spelled_numbers_in(&spoken[1]) {
                    let value = number.value as u64;
                    if (100..=2359).contains(&value) && value % 100 < 60 {
                        facts.clocks.insert(value.to_string());
                    }
                }
            }
            for word in calendar_words_in(text) {
                facts.calendar.insert(word);
            }
        }
        facts
    }

    pub(super) fn with_speaker_labels<'a>(
        mut self,
        labels: impl IntoIterator<Item = &'a str>,
    ) -> Self {
        self.speaker_labels.extend(
            labels
                .into_iter()
                .filter(|label| {
                    SPEAKER_LABEL
                        .find(label)
                        .is_some_and(|found| found.start() == 0 && found.end() == label.len())
                })
                .map(normalized_label),
        );
        self
    }

    /// The numbers and calendar words in `statement` that never occur in the
    /// meeting. Changed counts are checked even when they are small.
    pub(super) fn unknown_in(&self, statement: &str) -> Vec<String> {
        let mut unknown = Vec::new();
        let mut seen = HashSet::new();
        let without_labels =
            SPEAKER_LABEL.replace_all(statement, |capture: &regex::Captures<'_>| {
                if self.speaker_labels.contains(&normalized_label(&capture[0])) {
                    String::new()
                } else {
                    capture[0].to_owned()
                }
            });
        for value in numbers_in(&without_labels) {
            if !value.is_material() || !seen.insert(value.written.clone()) {
                continue;
            }
            if !value
                .variants()
                .iter()
                .any(|variant| self.numbers.contains(variant))
            {
                unknown.push(value.written);
            }
        }
        for date in dates_in(statement) {
            if !self.dates.contains(&date) {
                unknown.push(date);
            }
        }
        for clock in CLOCK.find_iter(statement) {
            if !self.clocks.contains(&clock_key(clock.as_str())) {
                unknown.push(clock.as_str().to_owned());
            }
        }
        for word in calendar_words_in(statement) {
            let key = word.to_lowercase();
            if seen.insert(key.clone()) && !self.calendar.contains(&key) {
                unknown.push(word);
            }
        }
        unknown
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Number {
    value: f64,
    /// The text as it appeared, for reports.
    written: String,
    exact: Option<String>,
}

impl Number {
    fn is_material(&self) -> bool {
        self.exact.is_some() || self.value.is_finite()
    }

    /// The value, and the forms a faithful recap may use for it: "40k" for
    /// "forty thousand", "1.5 million" for "1,500,000".
    fn variants(&self) -> Vec<String> {
        vec![self.exact.clone().unwrap_or_else(|| canonical(self.value))]
    }
}

fn canonical(value: f64) -> String {
    value.to_string()
}

fn clock_key(text: &str) -> String {
    let value = text
        .split(':')
        .filter_map(|part| part.parse::<u64>().ok())
        .fold(0, |acc, part| acc * 100 + part);
    value.to_string()
}

static SPEAKER_LABEL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\b(?:speaker|participant)\s+\d+\b").unwrap());
fn normalized_label(label: &str) -> String {
    label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

static DATE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
    r"(?i)\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b"
).unwrap()
});

fn dates_in(text: &str) -> Vec<String> {
    let normalized = crate::text::itn::inverse_text_normalize(text);
    DATE.captures_iter(&normalized)
        .flat_map(|capture| {
            let month = capture[1].to_lowercase();
            let day = capture[2].parse::<u32>().unwrap_or(0);
            let short = format!("{month} {day}");
            match capture.get(3) {
                Some(year) => vec![format!("{short} {}", year.as_str()), short],
                None => vec![short],
            }
        })
        .collect()
}

static DIGITS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(?P<sign>[-−+]?)(?P<lead>[$€£¥]?)(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?P<suffix>%|st\b|nd\b|rd\b|th\b|k\b|m\b|bn\b)?(?:\s*(?P<scale>thousand|million|billion|percent|per cent)\b)?",
    )
    .unwrap()
});

/// Clock times and timestamps. They are checked against the cited lines
/// elsewhere, and the minutes of "at 12:34" are not an amount.
static CLOCK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b\d{1,2}:\d{2}(?::\d{2})?\b").unwrap());

static SPOKEN_CLOCK: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\b(?:at|around|before|after)\s+([a-z -]{1,60})").unwrap()
});

fn numbers_in(text: &str) -> Vec<Number> {
    let without_clocks = CLOCK.replace_all(text, " ");
    let text = without_clocks.as_ref();
    let mut found = Vec::new();
    for capture in DIGITS.captures_iter(text) {
        let whole = capture.get(0).expect("match");
        // "Q3", "v2" and "L12" are labels, not quantities.
        if text[..whole.start()]
            .chars()
            .next_back()
            .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
        {
            continue;
        }
        let Ok(mut value) = capture["num"].replace(',', "").parse::<f64>() else {
            continue;
        };
        let suffix = capture.name("suffix").map(|m| m.as_str().to_lowercase());
        let scale = capture.name("scale").map(|m| m.as_str().to_lowercase());
        match suffix.as_deref() {
            Some("k") => value *= 1_000.0,
            Some("m") => value *= 1_000_000.0,
            Some("bn") => value *= 1_000_000_000.0,
            _ => {}
        }
        match scale.as_deref() {
            Some("thousand") => value *= 1_000.0,
            Some("million") => value *= 1_000_000.0,
            Some("billion") => value *= 1_000_000_000.0,
            _ => {}
        }
        let negative = matches!(&capture["sign"], "-" | "−");
        if negative {
            value = -value;
        }
        let power = match suffix.as_deref() {
            Some("k") => 3,
            Some("m") => 6,
            Some("bn") => 9,
            _ => 0,
        } + match scale.as_deref() {
            Some("thousand") => 3,
            Some("million") => 6,
            Some("billion") => 9,
            _ => 0,
        };
        found.push(Number {
            value,
            written: whole.as_str().trim().to_string(),
            exact: Some(decimal_key(&capture["num"], power, negative)),
        });
    }
    found.extend(spelled_numbers_in(text));
    found
}

// Keep digit values exact even above f64's integer precision or range.
fn decimal_key(raw: &str, power: usize, negative: bool) -> String {
    let raw = raw.replace(',', "");
    let (whole, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    let mut digits = format!("{whole}{fraction}");
    let point = whole.len() + power;
    if point > digits.len() {
        digits.extend(std::iter::repeat_n('0', point - digits.len()));
    }
    let (whole, fraction) = digits.split_at(point);
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.trim_end_matches('0');
    let mut value = if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    };
    if negative && value != "0" {
        value.insert(0, '-');
    }
    value
}

fn unit_word(word: &str) -> Option<f64> {
    const UNITS: [&str; 20] = [
        "zero",
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
    ];
    const ORDINALS: [&str; 20] = [
        "zeroth",
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
    ];
    UNITS
        .iter()
        .position(|unit| *unit == word)
        .or_else(|| ORDINALS.iter().position(|unit| *unit == word))
        .map(|index| index as f64)
        .or_else(|| (word == "dozen").then_some(12.0))
}

fn tens_word(word: &str) -> Option<f64> {
    const TENS: [&str; 8] = [
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    const TENS_ORDINAL: [&str; 8] = [
        "twentieth",
        "thirtieth",
        "fortieth",
        "fiftieth",
        "sixtieth",
        "seventieth",
        "eightieth",
        "ninetieth",
    ];
    TENS.iter()
        .position(|tens| *tens == word)
        .or_else(|| TENS_ORDINAL.iter().position(|tens| *tens == word))
        .map(|index| (index as f64 + 2.0) * 10.0)
}

fn scale_word(word: &str) -> Option<f64> {
    match word {
        "hundred" => Some(100.0),
        "thousand" => Some(1_000.0),
        "million" => Some(1_000_000.0),
        "billion" => Some(1_000_000_000.0),
        _ => None,
    }
}

/// "twenty five", "one hundred and twenty", "two point five million",
/// "a thousand", "one and a half million". Two numbers said back to back,
/// as in "ten thirty" or "twenty twenty-six", also count as the clock time
/// or year they read as.
fn spelled_numbers_in(text: &str) -> Vec<Number> {
    let lower = text.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let second_unit = |at: usize| {
        tokens.get(at) == Some(&"second")
            && at
                .checked_sub(1)
                .and_then(|previous| tokens.get(previous))
                .is_some_and(|previous| {
                    previous.chars().all(|ch| ch.is_ascii_digit()) || unit_word(previous).is_some()
                })
    };
    let starts = |at: usize| {
        if second_unit(at) {
            return false;
        }
        tokens
            .get(at)
            .is_some_and(|token| unit_word(token).is_some() || tens_word(token).is_some())
            || (tokens.get(at) == Some(&"a")
                && tokens
                    .get(at + 1)
                    .and_then(|next| scale_word(next))
                    .is_some())
    };
    // (number, first token, one past the last token)
    let mut spans: Vec<(Number, usize, usize)> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !starts(index) {
            index += 1;
            continue;
        }
        let start = index;
        let mut total = 0.0;
        let mut current: f64 = 0.0;
        let mut words = 0;
        while let Some(token) = tokens.get(index) {
            if second_unit(index) {
                break;
            }
            let below_hundred = current % 100.0;
            if *token == "a" && words == 0 {
                current = 1.0;
            } else if let Some(unit) = unit_word(token) {
                // "twenty five" continues; "five six" starts a new number.
                let continues = below_hundred == 0.0
                    || (below_hundred >= 20.0 && below_hundred % 10.0 == 0.0 && unit < 10.0);
                if !continues || (words > 0 && unit == 0.0) {
                    break;
                }
                current += unit;
            } else if let Some(tens) = tens_word(token) {
                if below_hundred != 0.0 {
                    break;
                }
                current += tens;
            } else if let Some(scale) = scale_word(token) {
                if current == 0.0 {
                    current = 1.0;
                }
                if scale == 100.0 {
                    current *= scale;
                } else {
                    total += current * scale;
                    current = 0.0;
                }
            } else if *token == "and"
                && words > 0
                && tokens.get(index + 1) == Some(&"a")
                && tokens.get(index + 2) == Some(&"half")
                && tokens
                    .get(index + 3)
                    .and_then(|next| scale_word(next))
                    .is_some()
            {
                current += 0.5;
                index += 3;
                words += 1;
                continue;
            } else if *token == "and"
                && words > 0
                && current % 100.0 == 0.0
                && current > 0.0
                && tokens
                    .get(index + 1)
                    .is_some_and(|next| unit_word(next).is_some() || tens_word(next).is_some())
            {
                // "one hundred and twenty"
            } else if *token == "point" && words > 0 {
                let mut decimals = String::new();
                let mut next = index + 1;
                while let Some(digit) = tokens.get(next).and_then(|token| unit_word(token)) {
                    if digit >= 10.0 {
                        break;
                    }
                    decimals.push_str(&format!("{}", digit as i64));
                    next += 1;
                }
                if decimals.is_empty() {
                    break;
                }
                current += format!("0.{decimals}").parse::<f64>().unwrap_or(0.0);
                index = next;
                words += 1;
                continue;
            } else {
                break;
            }
            words += 1;
            index += 1;
        }
        let end = index.max(start + 1);
        // A bare "one" or "a" is an article as often as a number.
        let negative = start > 0 && matches!(tokens[start - 1], "minus" | "negative");
        let lone_article =
            words == 1 && matches!(tokens[start], "one" | "a") && !negative && !second_unit(end);
        if words > 0 && !lone_article {
            spans.push((
                Number {
                    value: (total + current) * if negative { -1.0 } else { 1.0 },
                    written: tokens[start..end].join(" "),
                    exact: None,
                },
                start,
                end,
            ));
        }
        index = end;
    }
    let pairs: Vec<Number> = spans
        .windows(2)
        .filter(|pair| pair[0].2 == pair[1].1)
        .filter_map(|pair| {
            let (first, second) = (pair[0].0.value, pair[1].0.value);
            ((1.0..=99.0).contains(&first)
                && (0.0..=99.0).contains(&second)
                && first.fract() == 0.0
                && second.fract() == 0.0)
                .then(|| Number {
                    value: first * 100.0 + second,
                    written: format!("{} {}", pair[0].0.written, pair[1].0.written),
                    exact: None,
                })
        })
        .collect();
    spans
        .into_iter()
        .map(|(number, _, _)| number)
        .chain(pairs)
        .collect()
}

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
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

fn calendar_words_in(text: &str) -> impl Iterator<Item = String> + '_ {
    let lower = text.to_lowercase();
    text.split(|ch: char| !ch.is_alphabetic())
        .filter_map(move |word| {
            let lowered = word.to_lowercase();
            let full = expand_calendar_abbreviation(&lowered)
                .unwrap_or(&lowered)
                .to_string();
            let ambiguous = matches!(full.as_str(), "may" | "march");
            let date_context = [
                "in", "on", "by", "until", "during", "before", "after", "of", "from", "through",
                "for",
            ]
            .iter()
            .any(|prefix| lower.contains(&format!("{prefix} {full}")))
                || lower.contains(&format!("{full} 0"))
                || (1..=9).any(|digit| lower.contains(&format!("{full} {digit}")));
            (CALENDAR.contains(&full.as_str())
                && (!ambiguous
                    || date_context
                    || word.chars().next().is_some_and(char::is_uppercase)))
            .then_some(full)
        })
}

fn expand_calendar_abbreviation(word: &str) -> Option<&'static str> {
    Some(match word {
        "mon" => "monday",
        "tue" | "tues" => "tuesday",
        "wed" => "wednesday",
        "thu" | "thur" | "thurs" => "thursday",
        "fri" => "friday",
        "sat" => "saturday",
        "sun" => "sunday",
        "jan" => "january",
        "feb" => "february",
        "mar" => "march",
        "apr" => "april",
        "jun" => "june",
        "jul" => "july",
        "aug" => "august",
        "sep" | "sept" => "september",
        "oct" => "october",
        "nov" => "november",
        "dec" => "december",
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum KeyDetailKind {
    Decision,
    Number,
    Date,
    Name,
}

/// One source line that states something a recap must keep.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct KeyDetail {
    pub kind: KeyDetailKind,
    pub line_id: String,
    pub start_time: f64,
    /// The complete source line, including its conditions and qualifiers.
    pub excerpt: String,
}

static DECISION: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(?:we(?:'ve| have)? decided|decided to|decision is|the decision|we agreed|agreed (?:to|that|on)|let'?s go with|we(?:'ll| will) go with|we're going with|final answer|it's settled|we are going to|we're going to|(?:i|we)(?:'ll| will)|action item|assigned to)\b",
    )
    .unwrap()
});

static ACTION: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(?:action item|assigned to|to-do|follow up|follow-up)\b|\b(?:i|we)(?:'ll| will)\b[^.?!]{0,80}\bby\b|(?:'ll|\bwill) have\b[^.?!]{0,60}\b(?:done|ready|finished|out|sent)\b|(?:'ll|\bwill|\bneeds? to|\bhas to|\bhave to|\bis going to|\bare going to)\s+(?:also\s+|then\s+)?(?:send|share|follow|draft|write|review|schedule|set up|own|take|book|update|prepare|check|call|email|get|run|look into|finish|ship|reach out|circle back|put together|confirm|sync|loop in|talk to|fix|test|file|post|order|hire|invite)\b",
    )
    .unwrap()
});

/// Whether a source line commits someone to a task.
pub(super) fn states_an_action(text: &str) -> bool {
    ACTION.is_match(text)
}

static TASK_WORDING: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(?:i|we|you)(?:'ll|\s+will|\s+shall|'m\s+going\s+to|\s+am\s+going\s+to|'re\s+going\s+to|\s+are\s+going\s+to|\s+need\s+to|\s+have\s+to)\b|\b(?:need|want|ask|asking)\s+you\s+to\b|\b(?:can|could|would)\s+you\b|\blet\s+me\b|\bby\s+(?:the\s+)?(?:end\s+of|next|this|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d)",
    )
    .unwrap()
});

/// Whether a source line might state, ask for or recap a task: broader than
/// [`states_an_action`], for choosing the lines a task list reads.
pub(super) fn may_state_a_task(text: &str) -> bool {
    ACTION.is_match(text) || TASK_WORDING.is_match(text)
}

static TASK_REQUEST: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\b(?:need|want|ask|asking)\s+you\s+to\b|\b(?:can|could|would)\s+you\b")
        .unwrap()
});

/// Whether a source line asks someone to take on a task, so the reply that
/// follows says whether they did.
pub(super) fn asks_for_a_task(text: &str) -> bool {
    TASK_REQUEST.is_match(text)
}

fn excerpt(text: &str) -> String {
    text.trim().to_string()
}

/// The lines that state a decision, a quoted number, a date or a name
/// that is not a speaker label, in meeting order, at most `limit`, keeping
/// decisions first when there are more. `known_names` are the participants'
/// names; a line naming one of them counts as naming someone.
pub(super) fn key_details<'a>(
    lines: impl IntoIterator<Item = (&'a str, &'a str, f64)>,
    known_names: &[&str],
    limit: usize,
) -> Vec<KeyDetail> {
    // Generated labels such as "Speaker 2" or "You" are not names.
    const LABEL_WORDS: [&str; 9] = [
        "speaker",
        "you",
        "me",
        "them",
        "unknown",
        "remote",
        "local",
        "participant",
        "guest",
    ];
    let names: Vec<String> = known_names
        .iter()
        .flat_map(|name| name.split_whitespace())
        .filter(|part| {
            part.chars().count() >= 3
                && part.chars().next().is_some_and(char::is_uppercase)
                && part.chars().all(char::is_alphabetic)
        })
        .map(str::to_lowercase)
        .filter(|part| !LABEL_WORDS.contains(&part.as_str()))
        .collect();
    let mut details: Vec<KeyDetail> = lines
        .into_iter()
        .filter_map(|(line_id, text, start_time)| {
            let kind = if DECISION.is_match(text) {
                KeyDetailKind::Decision
            } else if numbers_in(text).iter().any(Number::is_material) {
                KeyDetailKind::Number
            } else if calendar_words_in(text).next().is_some() {
                KeyDetailKind::Date
            } else if text
                .split(|ch: char| !ch.is_alphabetic())
                .any(|word| names.contains(&word.to_lowercase()))
                || !super::statement_support::source_names(text).is_empty()
            {
                KeyDetailKind::Name
            } else {
                return None;
            };
            Some(KeyDetail {
                kind,
                line_id: line_id.to_string(),
                start_time,
                excerpt: excerpt(text),
            })
        })
        .collect();
    if details.len() > limit {
        let mut ranked: Vec<usize> = (0..details.len()).collect();
        ranked.sort_by_key(|&index| (details[index].kind, index));
        let keep: HashSet<usize> = ranked.into_iter().take(limit).collect();
        details = details
            .into_iter()
            .enumerate()
            .filter(|(index, _)| keep.contains(index))
            .map(|(_, detail)| detail)
            .collect();
    }
    details
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(lines: &[&str]) -> MeetingFacts {
        MeetingFacts::from_texts(lines.iter().copied())
    }

    #[test]
    fn duration_units_are_not_ordinal_numbers() {
        let meeting = facts(&["Raise the timeout from thirty seconds to ninety seconds."]);
        let short = facts(&["Wait one second."]);
        let date = facts(&["The deadline is May 22."]);
        let failures: Vec<_> = [
            (
                "hyphenated duration",
                !meeting.unknown_in("Use a 90-second timeout.").is_empty(),
            ),
            (
                "spaced duration",
                !meeting.unknown_in("Use a 90 second timeout.").is_empty(),
            ),
            (
                "spoken one second",
                !short.unknown_in("Wait 1 second.").is_empty(),
            ),
            (
                "changed duration",
                short.unknown_in("Wait 2 seconds.").is_empty(),
            ),
            (
                "known ordinal date",
                !date
                    .unknown_in("The deadline is May twenty-second.")
                    .is_empty(),
            ),
            (
                "changed ordinal date",
                date.unknown_in("The deadline is May second.").is_empty(),
            ),
        ]
        .into_iter()
        .filter(|(_, failed)| *failed)
        .map(|(name, _)| name)
        .collect();
        assert!(failures.is_empty(), "{failures:?}");
    }

    #[test]
    fn signs_and_large_integer_values_must_match_exactly() {
        let meeting = facts(&["The change is -5 percent. The reference is 9007199254740992."]);
        let accepted_changes: Vec<_> = [
            "The change is 5 percent.",
            "The reference is 9007199254740993.",
        ]
        .into_iter()
        .filter(|statement| meeting.unknown_in(statement).is_empty())
        .collect();
        assert!(accepted_changes.is_empty(), "{accepted_changes:?}");
        assert!(meeting.unknown_in("The change is -5%.").is_empty());
        let spoken = facts(&["The change is minus five percent. The price is 1.250 million."]);
        assert!(spoken.unknown_in("The change is -5%.").is_empty());
        assert!(!spoken.unknown_in("The change is 5%.").is_empty());
        assert!(spoken.unknown_in("The price is 1250000.").is_empty());
    }

    #[test]
    fn known_speaker_labels_do_not_justify_unspoken_counts_or_unknown_labels() {
        let meeting = facts(&["We reviewed the pilot."]).with_speaker_labels(["Speaker 1"]);
        assert!(meeting
            .unknown_in("Speaker 1 reviewed the pilot.")
            .is_empty());
        assert!(!meeting
            .unknown_in("Speaker 2 reviewed the pilot.")
            .is_empty());
        assert!(!meeting.unknown_in("We reviewed 1 pilot.").is_empty());
    }

    #[test]
    fn changed_scales_counts_may_and_times_are_flagged() {
        let meeting =
            facts(&["The budget is forty thousand. We need two pilots by May 5 at 10:30."]);
        for statement in [
            "The budget is $40.",
            "The budget is $40 million.",
            "We need 3 pilots.",
            "Due by May 6.",
            "Meet at 11:30.",
            "Due in June.",
        ] {
            assert!(!meeting.unknown_in(statement).is_empty(), "{statement}");
        }
        assert!(meeting
            .unknown_in("Two pilots by May 5 at 10:30, budget 40k.")
            .is_empty());
        assert!(!facts(&["It ships in June."])
            .unknown_in("It ships in May.")
            .is_empty());
        assert!(!facts(&["It ships on friday."])
            .unknown_in("It ships on thursday.")
            .is_empty());
        assert!(!facts(&["The target year is twenty twenty six."])
            .unknown_in("Meet at 20:26.")
            .is_empty());
        assert!(!facts(&["Due May 5 or June 6."])
            .unknown_in("Due May 6.")
            .is_empty());
    }

    #[test]
    fn spelled_and_digit_values_match_each_other() {
        let meeting = facts(&[
            "our selling price at twenty five Euros",
            "about one and a half million in the pipeline",
            "it's 40k for the pilot, roughly 12 percent of the budget",
            "the launch is in twenty twenty six, the call is at ten thirty",
            "two point five weeks",
        ]);
        for statement in [
            "The selling price is 25 Euros.",
            "The pipeline is about 1.5 million.",
            "The pilot costs $40,000, 12% of the budget.",
            "The pilot costs 40 thousand.",
            "Launch is planned for 2026; the call is at 10:30.",
            "The work takes 2.5 weeks.",
        ] {
            assert!(meeting.unknown_in(statement).is_empty(), "{statement}");
        }
    }

    #[test]
    fn a_value_or_day_the_meeting_never_said_is_reported() {
        let meeting = facts(&["the pilot is forty thousand dollars", "send it by Friday"]);
        assert_eq!(meeting.unknown_in("The pilot is $45,000."), ["$45,000"]);
        assert_eq!(meeting.unknown_in("Send it by Thursday."), ["thursday"]);
        assert!(meeting.unknown_in("Send it by Friday.").is_empty());
        assert!(meeting.unknown_in("Send it by Fri.").is_empty());
        assert_eq!(meeting.unknown_in("Revenue grew 7.5%."), ["7.5%"]);
        assert_eq!(meeting.unknown_in("At 12:34 the pilot came up."), ["12:34"]);
    }

    #[test]
    fn unsupported_counts_and_months_are_flagged_but_labels_and_verbs_are_not() {
        let meeting = facts(&["we have options"]);
        assert_eq!(meeting.unknown_in("The team weighed 2 options."), ["2"]);
        assert!(meeting
            .unknown_in("Q3 planning and v2 of the app.")
            .is_empty());
        assert!(meeting.unknown_in("They march on.").is_empty());
        assert_eq!(meeting.unknown_in("Planned for May."), ["may"]);
    }

    #[test]
    fn spelled_numbers_cover_scales_points_and_articles() {
        let values = |text: &str| {
            spelled_numbers_in(text)
                .into_iter()
                .map(|number| number.value)
                .collect::<Vec<_>>()
        };
        assert_eq!(values("one hundred and twenty people"), [120.0]);
        assert_eq!(values("a thousand units"), [1_000.0]);
        assert_eq!(values("two point five million"), [2_500_000.0]);
        assert_eq!(values("the twenty first of March"), [21.0]);
        assert!(values("one of them said a word").is_empty());
    }

    #[test]
    fn key_details_list_decisions_numbers_dates_and_names_in_order() {
        let lines = [
            ("L1", "Hi everyone, thanks for joining.", 0.0),
            ("L2", "Priya will own the migration.", 12.0),
            ("L3", "The quote came back at forty thousand.", 30.5),
            ("L4", "We decided to ship the beta first.", 61.0),
            ("L5", "Let's review on Thursday.", 75.0),
            ("L6", "Sounds good.", 80.0),
        ];
        let details = key_details(lines, &["Priya Shah"], 10);
        let kinds: Vec<_> = details
            .iter()
            .map(|detail| (detail.line_id.as_str(), detail.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("L2", KeyDetailKind::Name),
                ("L3", KeyDetailKind::Number),
                ("L4", KeyDetailKind::Decision),
                ("L5", KeyDetailKind::Date),
            ]
        );
        assert_eq!(details[2].start_time, 61.0);
        // Over the limit, decisions are kept first and order is preserved.
        let kept = key_details(lines, &["Priya Shah"], 2);
        let ids: Vec<_> = kept.iter().map(|detail| detail.line_id.as_str()).collect();
        assert_eq!(ids, ["L3", "L4"]);
        // Speaker labels are not names.
        let labelled = key_details(
            [("L1", "I think you and the speaker agree.", 0.0)],
            &["Speaker 2", "You"],
            10,
        );
        assert!(labelled.is_empty());
    }

    #[test]
    fn facts_include_actions_and_names_beyond_the_speaker_labels() {
        let details = key_details(
            [
                (
                    "L1",
                    "I'll add the empty states unless the review changes scope.",
                    15.0,
                ),
                ("L2", "Send the mockups to Acme Robotics.", 25.0),
            ],
            &[],
            10,
        );
        assert_eq!(details.len(), 2);
        assert_eq!(details[0].kind, KeyDetailKind::Decision);
        assert!(details[0]
            .excerpt
            .ends_with("unless the review changes scope."));
        assert_eq!(details[1].kind, KeyDetailKind::Name);
    }

    #[test]
    fn source_quotes_keep_the_full_condition() {
        let line = "word ".repeat(80);
        let details = key_details([("L1", line.as_str(), 0.0)], &[], 5);
        assert!(details.is_empty());
        let line = format!("We decided to {}", "ship ".repeat(80));
        let details = key_details([("L1", line.as_str(), 0.0)], &[], 5);
        assert_eq!(details[0].excerpt, line.trim());
        assert!(!details[0].excerpt.ends_with(' '));
    }
}
