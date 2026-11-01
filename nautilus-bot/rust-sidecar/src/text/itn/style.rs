//! Number preferences apply to recognizer digits as well as spoken words.

use super::*;

// People and other prose nouns deliberately do not count as units. Keep this
// list bounded: an unknown noun is not evidence for changing a small number.
const DATA_UNITS: &[&str] = &[
    "percent",
    "percentage",
    "dollar",
    "dollars",
    "euro",
    "euros",
    "cent",
    "cents",
    "pound",
    "pounds",
    "pence",
    "meter",
    "meters",
    "metre",
    "metres",
    "kilometer",
    "kilometers",
    "kilometre",
    "kilometres",
    "centimeter",
    "centimeters",
    "millimeter",
    "millimeters",
    "mile",
    "miles",
    "foot",
    "feet",
    "inch",
    "inches",
    "gram",
    "grams",
    "kilogram",
    "kilograms",
    "ounce",
    "ounces",
    "liter",
    "liters",
    "litre",
    "litres",
    "milliliter",
    "milliliters",
    "degree",
    "degrees",
    "second",
    "seconds",
    "minute",
    "minutes",
    "hour",
    "hours",
    "day",
    "days",
    "week",
    "weeks",
    "month",
    "months",
    "year",
    "years",
    "byte",
    "bytes",
    "kilobyte",
    "kilobytes",
    "megabyte",
    "megabytes",
    "gigabyte",
    "gigabytes",
    "hertz",
    "watts",
    "volt",
    "volts",
    "mg",
    "kg",
    "km",
    "cm",
    "mm",
    "ml",
    "gb",
    "mb",
    "ms",
    "hz",
    "mph",
    "laptop",
    "laptops",
    "server",
    "servers",
    "file",
    "files",
    "record",
    "records",
    "row",
    "rows",
];

fn joined_word(tokens: &[Token], from: usize, at: usize) -> Option<&str> {
    let token = tokens.get(at)?;
    (!token.protected && span_is_contiguous(tokens, from.min(at), from.max(at) + 1))
        .then_some(token.core_lower.as_str())
}

pub(super) fn small_number_is_data(tokens: &[Token], start: usize, end: usize) -> bool {
    if is_list_label(tokens, start) {
        return true;
    }
    if tokens
        .get(end)
        .is_some_and(|next| is_meridiem(&next.core_lower))
        && span_is_contiguous(tokens, start, end + 1)
    {
        return true;
    }
    if let Some(next) = joined_word(tokens, start, end) {
        if DATA_UNITS.contains(&next) || is_meridiem(next) || next == "o'clock" {
            return true;
        }
    }
    // A list shares its final unit: "1, 2, or 3 dollars" is all data.
    let mut at = end;
    while at < tokens.len() && at < end + 6 {
        let next = &tokens[at];
        if next.protected
            || !next.lead.is_empty()
            || next.space_before.contains(['\n', '\r'])
            || !matches!(tokens[at - 1].trail.as_str(), "" | ",")
        {
            break;
        }
        if DATA_UNITS.contains(&next.core_lower.as_str()) {
            return true;
        }
        if !matches!(next.core_lower.as_str(), "and" | "or" | "to")
            && unit_value(&next.core_lower).is_none()
            && next.core.parse::<u64>().is_err()
        {
            break;
        }
        at += 1;
    }
    if let Some(previous) = start
        .checked_sub(1)
        .and_then(|at| joined_word(tokens, start, at))
    {
        if month_index(previous).is_some()
            || matches!(previous, "version" | "chapter" | "room" | "flight")
        {
            return true;
        }
        // An isolated hour after a time preposition, never "at two people".
        if matches!(previous, "at" | "until" | "till")
            && tokens.get(end).is_none_or(|next| {
                next.core.is_empty()
                    || !tokens[end - 1].trail.is_empty()
                    || matches!(
                        next.core_lower.as_str(),
                        "today" | "tomorrow" | "tonight" | "sharp" | "and" | "or" | "unless" | "if"
                    )
            })
        {
            return true;
        }
    }
    false
}

fn is_list_label(tokens: &[Token], index: usize) -> bool {
    let token = &tokens[index];
    (index == 0 || token.space_before.contains(['\n', '\r']))
        && token.core.bytes().all(|b| b.is_ascii_digit())
        && matches!(token.trail.as_str(), "." | ")")
        && tokens
            .get(index + 1)
            .is_some_and(|next| !next.space_before.contains(['\n', '\r']))
}

/// Explicit versions and calendar years need a different grammar from decimals.
/// "Python three point eleven" remains ambiguous without the word "version".
pub(super) fn try_data_number(tokens: &[Token], start: usize) -> Option<Rewrite> {
    if tokens[start].core_lower == "plus" {
        let (digits, end) = single_digit_run(tokens, start + 1);
        if (7..=15).contains(&digits.len()) && span_is_contiguous(tokens, start, end) {
            let text = match digits.len() {
                8 if digits.starts_with('1') => format!("+1 {}-{}", &digits[1..4], &digits[4..]),
                11 if digits.starts_with('1') => {
                    format!("+1 {}-{}-{}", &digits[1..4], &digits[4..7], &digits[7..])
                }
                _ => format!("+{digits}"),
            };
            return Some(Rewrite { text, end });
        }
        return None;
    }
    let previous = start
        .checked_sub(1)
        .and_then(|at| joined_word(tokens, start, at))?;
    if matches!(previous, "in" | "since" | "during" | "year") {
        let (year, end) = parse_year(tokens, start)?;
        return Some(Rewrite {
            text: year.to_string(),
            end,
        });
    }
    if !matches!(previous, "version" | "release") {
        return None;
    }
    let (head, mut end) = parse_cardinal_bounded(tokens, start, 2)?;
    let mut groups = vec![head.to_string()];
    while joined_word(tokens, start, end) == Some("point") {
        let group_start = end + 1;
        let (digits, run_end) = single_digit_run(tokens, group_start);
        let (group, next) = if digits.len() > 1 {
            (digits, run_end)
        } else {
            let (value, next) = parse_cardinal_bounded(tokens, group_start, 2)?;
            if value > 999 {
                return None;
            }
            (value.to_string(), next)
        };
        if !span_is_contiguous(tokens, start, next) {
            return None;
        }
        groups.push(group);
        end = next;
    }
    (groups.len() > 1).then(|| Rewrite {
        text: groups.join("."),
        end,
    })
}

pub fn voice_numbers_as_digits_protecting(
    text: &str,
    protected: &[String],
    spell_small_digits: bool,
) -> String {
    let normalized = normalize_with_observer(text, protected, true, |_, _, _| {});
    if spell_small_digits {
        rewrite_digits(&normalized, protected, true)
    } else {
        normalized
    }
}

pub fn numbers_as_words_protecting(text: &str, protected: &[String]) -> String {
    rewrite_digits(text, protected, false)
}

const ONES: &[&str] = &[
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
const TENS: &[&str] = &[
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

fn cardinal(value: u64) -> String {
    match value {
        0..=19 => ONES[value as usize].to_string(),
        20..=99 => {
            let tens = TENS[(value / 10) as usize];
            if value.is_multiple_of(10) {
                tens.to_string()
            } else {
                format!("{tens} {}", ONES[(value % 10) as usize])
            }
        }
        _ => {
            let (scale, name) = [
                (1_000_000_000_000_000_000, "quintillion"),
                (1_000_000_000_000_000, "quadrillion"),
                (1_000_000_000_000, "trillion"),
                (1_000_000_000, "billion"),
                (1_000_000, "million"),
                (1000, "thousand"),
                (100, "hundred"),
            ]
            .into_iter()
            .find(|(scale, _)| value >= *scale)
            .unwrap();
            let head = format!("{} {name}", cardinal(value / scale));
            if value.is_multiple_of(scale) {
                head
            } else {
                format!("{head} {}", cardinal(value % scale))
            }
        }
    }
}

fn digit_words(digits: &str) -> Option<String> {
    digits
        .chars()
        .map(|ch| ch.to_digit(10).map(|digit| ONES[digit as usize]))
        .collect::<Option<Vec<_>>>()
        .map(|words| words.join(" "))
}

fn integer_words(digits: &str) -> Option<String> {
    static INTEGER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$").unwrap());
    if !INTEGER.is_match(digits) {
        return None;
    }
    let digits = digits.replace(',', "");
    if digits.len() > 1 && digits.starts_with('0') {
        digit_words(&digits)
    } else {
        digits.parse().ok().map(cardinal)
    }
}

fn decimal_words(number: &str, version: bool) -> Option<String> {
    let groups: Vec<_> = number.split('.').collect();
    let mut words = vec![integer_words(groups[0])?];
    if groups.len() > 2 && !version {
        return None;
    }
    for group in &groups[1..] {
        words.push(if version {
            integer_words(group)?
        } else {
            digit_words(group)?
        });
    }
    Some(words.join(" point "))
}

fn ordinal_words(number: &str) -> Option<String> {
    let suffix = number.get(number.len().checked_sub(2)?..)?;
    if !matches!(suffix, "st" | "nd" | "rd" | "th") {
        return None;
    }
    let value = number[..number.len() - 2].parse::<u64>().ok()?;
    if suffix != ordinal_suffix(value) {
        return None;
    }
    let words = cardinal(value);
    let (head, last) = words.rsplit_once(' ').unwrap_or(("", &words));
    let ordinal = match last {
        "zero" => "zeroth".to_string(),
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        word if word.ends_with('y') => format!("{}ieth", &word[..word.len() - 1]),
        word => format!("{word}th"),
    };
    Some(if head.is_empty() {
        ordinal
    } else {
        format!("{head} {ordinal}")
    })
}

fn numeric_words(core: &str, version: bool) -> Option<String> {
    if let Some(ordinal) = ordinal_words(core) {
        return Some(ordinal);
    }
    let (sign, core) = if let Some(rest) = core.strip_prefix('+') {
        ("plus ", rest)
    } else if let Some(rest) = core.strip_prefix('-') {
        ("minus ", rest)
    } else {
        ("", core)
    };
    if core.contains('/') {
        let groups: Vec<_> = core.split('/').collect();
        if groups.len() == 3
            && groups
                .iter()
                .all(|group| !group.is_empty() && group.bytes().all(|b| b.is_ascii_digit()))
            && ((groups[0].len() <= 2 && groups[1].len() <= 2 && groups[2].len() == 4)
                || (groups[0].len() == 4 && groups[1].len() <= 2 && groups[2].len() <= 2))
        {
            return Some(
                groups
                    .iter()
                    .map(|g| integer_words(g))
                    .collect::<Option<Vec<_>>>()?
                    .join(" slash "),
            );
        }
        return None;
    }
    if core.contains(':') {
        let (hour, minute) = core.split_once(':')?;
        if minute.len() != 2 {
            return None;
        }
        let hour = hour.parse::<u64>().ok()?;
        let minute = minute.parse::<u64>().ok()?;
        if hour > 23 || minute > 59 {
            return None;
        }
        let minute = match minute {
            0 if hour > 12 => "hundred".to_string(),
            0 => "o'clock".to_string(),
            1..=9 => format!("oh {}", cardinal(minute)),
            _ => cardinal(minute),
        };
        return Some(format!("{sign}{} {minute}", cardinal(hour)));
    }
    if core.contains('-') {
        let groups: Vec<_> = core.split('-').collect();
        let lengths: Vec<_> = groups.iter().map(|g| g.len()).collect();
        if matches!(lengths.as_slice(), [3, 4] | [3, 3, 4] | [1, 3, 3, 4])
            && groups
                .iter()
                .all(|group| group.bytes().all(|b| b.is_ascii_digit()))
        {
            return Some(format!("{sign}{}", digit_words(&groups.concat())?));
        }
        if lengths == [4, 2, 2] {
            return Some(
                groups
                    .iter()
                    .map(|g| integer_words(g))
                    .collect::<Option<Vec<_>>>()?
                    .join("-"),
            );
        }
        if groups.len() == 2 {
            return Some(format!(
                "{sign}{}-{}",
                decimal_words(groups[0], version)?,
                decimal_words(groups[1], version)?
            ));
        }
        return None;
    }
    if let Some(value) = core.strip_suffix('%') {
        return Some(format!("{sign}{} percent", decimal_words(value, false)?));
    }
    let suffix_start = core.find(|ch: char| !ch.is_ascii_digit() && ch != '.' && ch != ',');
    if let Some(at) = suffix_start.filter(|at| *at > 0) {
        let (number, unit) = core.split_at(at);
        if DATA_UNITS.contains(&unit.to_lowercase().as_str()) {
            return Some(format!("{sign}{} {unit}", decimal_words(number, false)?));
        }
    }
    Some(format!("{sign}{}", decimal_words(core, version)?))
}

fn money_words(amount: &str, scale: Option<&str>) -> Option<String> {
    let symbol = amount.chars().next()?;
    let (singular, plural, penny, pennies) = match symbol {
        '$' => ("dollar", "dollars", "cent", "cents"),
        '€' => ("euro", "euros", "cent", "cents"),
        '£' => ("pound", "pounds", "penny", "pence"),
        _ => return None,
    };
    let amount = &amount[symbol.len_utf8()..];
    if let Some(scale) = scale {
        return Some(format!(
            "{} {scale} {plural}",
            numeric_words(amount, false)?
        ));
    }
    let (whole, fraction) = amount
        .split_once('.')
        .map_or((amount, None), |(w, f)| (w, Some(f)));
    let words = numeric_words(whole, false)?;
    let unit = if whole == "1" { singular } else { plural };
    match fraction {
        None => Some(format!("{words} {unit}")),
        Some(fraction)
            if fraction.len() <= 2
                && !fraction.is_empty()
                && fraction.bytes().all(|b| b.is_ascii_digit()) =>
        {
            let cents = fraction.parse::<u64>().ok()? * if fraction.len() == 1 { 10 } else { 1 };
            if cents == 0 {
                Some(format!("{words} {unit}"))
            } else {
                Some(format!(
                    "{words} {unit} and {} {}",
                    cardinal(cents),
                    if cents == 1 { penny } else { pennies }
                ))
            }
        }
        Some(_) => Some(format!("{} {plural}", numeric_words(amount, false)?)),
    }
}

fn requested_clock(tokens: &[Token], index: usize) -> Option<String> {
    let start = index.checked_sub(3)?;
    if tokens[index + 1..]
        .iter()
        .any(|token| !token.core.is_empty())
        || !span_is_contiguous(tokens, start, index + 1)
        || tokens[start..=index].iter().any(|token| token.protected)
        || tokens[start].core_lower != "call"
        || tokens[start + 1].core_lower != "me"
        || tokens[start + 2].core_lower != "at"
    {
        return None;
    }
    let (hour, minute) = tokens[index].core.split_once('.')?;
    if minute.len() != 2 {
        return None;
    }
    let hour: u64 = hour.parse().ok()?;
    let minute: u64 = minute.parse().ok()?;
    ((1..=12).contains(&hour) && minute < 60).then(|| format!("{hour}:{minute:02}"))
}

fn rewrite_digits(text: &str, protected: &[String], small_prose_only: bool) -> String {
    if text.len() > MAX_ITN_INPUT_BYTES {
        return text.to_string();
    }
    let mut tokens = tokenize(text);
    for token in &mut tokens {
        if token.protected && numeric_words(&token.core, false).is_some() {
            token.protected = false;
        }
    }
    mark_protected_phrases(text, &mut tokens, protected);
    let clock_allowed = !mentions_a_quantity(text);
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.protected || token.core.is_empty() || is_list_label(&tokens, index) {
            output.push_str(&token.render());
            index += 1;
            continue;
        }
        let clock = clock_allowed
            .then(|| requested_clock(&tokens, index))
            .flatten();
        if small_prose_only {
            if let Some(clock) = clock {
                emit_rewrite(
                    &mut output,
                    &tokens,
                    index,
                    &Rewrite {
                        text: clock,
                        end: index + 1,
                    },
                );
                index += 1;
                continue;
            }
            let small = token
                .core
                .parse::<u64>()
                .ok()
                .filter(|v| *v < 10 && token.core.len() == 1)
                .map(cardinal)
                .or_else(|| {
                    let head = token.core.get(..token.core.len().checked_sub(2)?)?;
                    (head.parse::<u64>().ok()? < 10)
                        .then(|| ordinal_words(&token.core))
                        .flatten()
                });
            if let Some(words) = small.filter(|_| {
                !token.lead.ends_with('-') && !small_number_is_data(&tokens, index, index + 1)
            }) {
                emit_rewrite(
                    &mut output,
                    &tokens,
                    index,
                    &Rewrite {
                        text: words,
                        end: index + 1,
                    },
                );
            } else {
                output.push_str(&token.render());
            }
            index += 1;
            continue;
        }
        let version = index
            .checked_sub(1)
            .and_then(|at| joined_word(&tokens, index, at))
            .is_some_and(|word| matches!(word, "version" | "release"));
        let scale = tokens.get(index + 1).filter(|next| {
            !next.protected
                && token.trail.is_empty()
                && joined_word(&tokens, index, index + 1).is_some()
                && matches!(next.core_lower.as_str(), "million" | "billion" | "trillion")
        });
        let money = money_words(&token.core, scale.map(|s| s.core.as_str()));
        let mut end = index + 1 + usize::from(money.is_some() && scale.is_some());
        let mut replacement =
            money.or_else(|| numeric_words(clock.as_deref().unwrap_or(&token.core), version));
        // Recognizers often glue am/pm to the clock. Preserve the marker.
        if replacement.is_none() {
            for meridiem in ["am", "pm"] {
                if let Some(clock) = token.core_lower.strip_suffix(meridiem) {
                    replacement =
                        numeric_words(clock, false).map(|words| format!("{words} {meridiem}"));
                }
            }
        }
        // An explicit '+' starts an international digit string. Keep leading
        // zeroes in every following group rather than reading them as counts.
        if token.core.starts_with('+') && token.core[1..].bytes().all(|b| b.is_ascii_digit()) {
            let mut digits = token.core[1..].to_string();
            while joined_word(&tokens, index, end).is_some_and(|word| {
                word.bytes().all(|b| b.is_ascii_digit() || b == b'-')
                    && word.bytes().any(|b| b.is_ascii_digit())
            }) {
                digits.push_str(&tokens[end].core.replace('-', ""));
                end += 1;
            }
            if (7..=15).contains(&digits.len()) {
                replacement = digit_words(&digits).map(|words| format!("plus {words}"));
            } else {
                end = index + 1;
            }
        }
        if let Some(mut words) = replacement {
            let mut first = token.clone();
            if first.lead.ends_with('-') {
                first.lead.pop();
                words = format!("minus {words}");
            }
            output.push_str(&first.space_before);
            output.push_str(&first.lead);
            output.push_str(&words);
            output.push_str(&tokens[end - 1].trail);
            index = end;
        } else {
            output.push_str(&token.render());
            index += 1;
        }
    }
    output
}
