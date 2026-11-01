//! Line-break layout for dictation into fields that take multi-line text.
//!
//! Email, notes and worklog destinations get the structure people expect
//! from a polished dictation app: a spoken enumeration becomes a numbered
//! list, a spoken "new paragraph" / "new line" that stands as its own clause
//! becomes a break, long prose is split into paragraphs (at the existing
//! length thresholds, and earlier at an explicit topic shift such as "Also,"
//! or "One more thing"), and an email greeting and sign-off get their own
//! lines.
//!
//! The rules only add line breaks, list numbers and boundary punctuation.
//! The only words they remove are the spoken markers a list number replaces
//! ("first", "number two", "and third") and a spoken break command. Anything
//! ambiguous is left exactly as it came in. Chat and unknown apps get only
//! an explicit numbered list (see `announced_list_block` and
//! `explicit_list_block`). AI prompts, code editors, terminals, single-line
//! fields and fields whose accessibility role could not be read never get
//! synthesized line breaks (see `smart_format_dictation_text_with_layout`).

use super::format::DictationAppCategory;
use regex::Regex;
use std::sync::LazyLock;

/// Whether the focused control takes added line breaks. Single-line
/// controls (subject lines, search boxes, address fields) do not: a line
/// break there either disappears or submits. When the accessibility read
/// gave no role the field could be one of those, so layout stays off.
/// Other roles defer to the destination category.
pub fn field_role_allows_line_breaks(role: Option<&str>) -> bool {
    match role.map(str::trim) {
        None | Some("") => false,
        Some(role) => !matches!(
            role,
            "AXTextField" | "AXSearchField" | "AXComboBox" | "AXSecureTextField"
        ),
    }
}

/// Destinations whose compose fields take multi-line text and where a list
/// or paragraph is the expected shape. "messages" mode is an explicit ask
/// for chat-style text, so it never gets layout.
pub(crate) fn category_supports_layout(mode_preset: &str, category: DictationAppCategory) -> bool {
    mode_preset != "messages"
        && matches!(
            category,
            DictationAppCategory::Email
                | DictationAppCategory::Notes
                | DictationAppCategory::Worklog
        )
}

#[derive(Debug, Clone)]
struct Word {
    start: usize,
    end: usize,
    /// Alphanumeric core, lowercased: "First," -> "first", "1." -> "1".
    core_lower: String,
    /// Punctuation after the core: "," for "First,".
    trail: String,
    text: String,
}

impl Word {
    fn trail_has(&self, set: &[char]) -> bool {
        self.trail.contains(set)
    }

    /// Whether this word ends a sentence, given the word after it. A period
    /// after an abbreviation is not a sentence end ("9 a.m. tomorrow"),
    /// except that one which can close a sentence ("at 3 p.m. Then we")
    /// does when the next word is capitalized.
    fn ends_sentence_before(&self, next: Option<&Word>) -> bool {
        if !self.trail_has(&['.', '!', '?']) {
            return false;
        }
        if self.trail_has(&['!', '?']) || !is_abbreviation(&self.core_lower) {
            return true;
        }
        // "No. 5" and "item no. five" are numbers; "Hi Sam, no. Respectfully,
        // Jordan." is an answer.
        if self.core_lower == "no" {
            return next.is_none_or(|next| next.text.starts_with(char::is_uppercase));
        }
        abbreviation_can_close_sentence(&self.core_lower)
            && next.is_none_or(|next| next.text.starts_with(|ch: char| ch.is_uppercase()))
    }

    fn is_boundary_before(&self, next: Option<&Word>) -> bool {
        self.trail_has(&[',', ';', ':']) || self.ends_sentence_before(next)
    }
}

fn split_words(text: &str) -> Vec<Word> {
    let mut words = Vec::new();
    let mut start = None;
    for (index, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if ch.is_whitespace() {
            if let Some(begin) = start.take() {
                let token = &text[begin..index];
                let without_trail = token.trim_end_matches(|c: char| !c.is_alphanumeric());
                let trail = &token[without_trail.len()..];
                let core = without_trail.trim_start_matches(|c: char| !c.is_alphanumeric());
                words.push(Word {
                    start: begin,
                    end: index,
                    core_lower: core.to_lowercase(),
                    trail: trail.to_string(),
                    text: token.to_string(),
                });
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    words
}

/// A period after these is not, by itself, a sentence end.
fn is_abbreviation(core_lower: &str) -> bool {
    matches!(
        core_lower,
        "mr" | "mrs"
            | "ms"
            | "dr"
            | "prof"
            | "st"
            | "jr"
            | "sr"
            | "vs"
            | "etc"
            | "e.g"
            | "i.e"
            | "approx"
            | "no"
            | "inc"
            | "ltd"
            | "co"
            | "a.m"
            | "p.m"
            | "u.s"
            | "u.k"
    )
}

/// Abbreviations that often end a sentence ("We met at 9 a.m."). They end
/// one only when a capitalized word follows; titles such as "Dr." and "e.g."
/// never do.
fn abbreviation_can_close_sentence(core_lower: &str) -> bool {
    matches!(
        core_lower,
        "a.m" | "p.m" | "u.s" | "u.k" | "etc" | "inc" | "ltd" | "co" | "jr" | "sr"
    )
}

// ---------------------------------------------------------------------------
// Spoken line breaks
// ---------------------------------------------------------------------------

/// Words right after "new paragraph" that show it is a noun phrase in prose
/// ("the new paragraph is clearer", "new line items") rather than a command.
const SPOKEN_BREAK_NOUN_FOLLOWERS: &[&str] = &[
    "is",
    "was",
    "are",
    "were",
    "will",
    "would",
    "should",
    "can",
    "could",
    "needs",
    "about",
    "of",
    "for",
    "that",
    "which",
    "here",
    "there",
    "goes",
    "text",
    "break",
    "breaks",
    "item",
    "items",
    "character",
    "characters",
    "manager",
];

/// Converts a spoken "new paragraph" / "new line" / "newline" into a break,
/// but only where it cannot be prose. The command has to follow sentence or
/// clause punctuation (or open the text), have words after it, and stand as
/// its own clause: punctuation right after it ("Done. New paragraph. Next")
/// or, when the speaker is dictating punctuation (`dictated_punctuation`,
/// "first section period new paragraph second section"), a lowercase "new
/// paragraph"/"new line" whose next word does not make it a noun. Without
/// that, "New line cooks start Monday" and "Newline handling is broken" are
/// ordinary sentences and stay as spoken. When `drop_at_start` is set (an
/// email body after its greeting line) a command that opens the text is
/// removed, because the greeting already ends a paragraph.
pub(crate) fn convert_spoken_breaks(
    text: &str,
    drop_at_start: bool,
    dictated_punctuation: bool,
) -> String {
    let words = split_words(text);
    let mut output = String::with_capacity(text.len());
    let mut copied_to = 0usize;
    let mut index = 0usize;
    while index < words.len() {
        let word = &words[index];
        let (len, paragraph) = match word.core_lower.as_str() {
            "newline" => (1, false),
            "new" if word.trail.is_empty() => {
                match words.get(index + 1).map(|w| w.core_lower.as_str()) {
                    Some("paragraph") => (2, true),
                    Some("line") => (2, false),
                    _ => {
                        index += 1;
                        continue;
                    }
                }
            }
            _ => {
                index += 1;
                continue;
            }
        };
        let last = &words[index + len - 1];
        let leading_ok = word.text.chars().next().is_some_and(char::is_alphanumeric);
        let has_after = index + len < words.len();
        let at_start = index == 0;
        let boundary_before = !at_start && words[index - 1].is_boundary_before(Some(&words[index]));
        let closed = !last.trail.is_empty() && last.trail.chars().all(|ch| ".,;:!".contains(ch));
        let dictated_command = dictated_punctuation
            && len == 2
            && last.trail.is_empty()
            && word.text.starts_with(|ch: char| ch.is_lowercase())
            && !words.get(index + len).is_some_and(|next| {
                SPOKEN_BREAK_NOUN_FOLLOWERS.contains(&next.core_lower.as_str())
            });
        if !(leading_ok && has_after && (closed || dictated_command)) {
            index += 1;
            continue;
        }
        if at_start && drop_at_start {
            copied_to = words[index + len].start;
            index += len;
            continue;
        }
        if !boundary_before {
            index += 1;
            continue;
        }
        let mut before = text[copied_to..word.start].trim_end().to_string();
        // A paragraph that ended on a pause comma gets a full stop, unless
        // it is a short salutation ("Hi Sam,").
        let paragraph_words = before
            .rsplit('\n')
            .next()
            .map(|line| line.split_whitespace().count())
            .unwrap_or(0);
        if paragraph && (before.ends_with(',') || before.ends_with(';')) && paragraph_words > 4 {
            before.pop();
            before.push('.');
        }
        output.push_str(&before);
        output.push_str(if paragraph { "\n\n" } else { "\n" });
        copied_to = words[index + len].start;
        index += len;
    }
    output.push_str(&text[copied_to..]);
    output
}

// ---------------------------------------------------------------------------
// Numbered lists
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    /// first, second, third ... (and "finally"/"lastly" to close)
    Ordinal,
    /// number one, number two ...
    Number,
    /// one, two, three ... / 1, 2, 3 ... (always with punctuation after)
    Cardinal,
}

const LAST: u32 = u32::MAX;

#[derive(Debug, Clone)]
struct Marker {
    /// First word of the "and"/"then" connector before the marker, or the
    /// marker itself when there is none.
    connector_start: usize,
    first: usize,
    /// Word index just past the marker.
    end: usize,
    family: Family,
    value: u32,
    separated: bool,
}

fn ordinal_value(word: &str) -> Option<u32> {
    Some(match word {
        "first" | "firstly" => 1,
        "second" | "secondly" => 2,
        "third" | "thirdly" => 3,
        "fourth" | "fourthly" => 4,
        "fifth" | "fifthly" => 5,
        "sixth" => 6,
        "seventh" => 7,
        "eighth" => 8,
        "ninth" => 9,
        "tenth" => 10,
        "finally" | "lastly" => LAST,
        _ => return None,
    })
}

fn cardinal_value(word: &str) -> Option<u32> {
    Some(match word {
        "one" | "1" => 1,
        "two" | "2" => 2,
        "three" | "3" => 3,
        "four" | "4" => 4,
        "five" | "5" => 5,
        "six" | "6" => 6,
        "seven" | "7" => 7,
        "eight" | "8" => 8,
        "nine" | "9" => 9,
        "ten" | "10" => 10,
        _ => return None,
    })
}

/// Nouns an ordinal or "number N" commonly modifies. "First quarter results
/// were strong" and "Number one priority" are not list markers.
const MARKER_MODIFIED_NOUNS: &[&str] = &[
    "place",
    "prize",
    "quarter",
    "half",
    "time",
    "times",
    "round",
    "floor",
    "step",
    "steps",
    "day",
    "week",
    "month",
    "year",
    "person",
    "class",
    "draft",
    "version",
    "phase",
    "item",
    "thing",
    "things",
    "one",
    "ones",
    "priority",
    "option",
    "choice",
    "rate",
    "hand",
    "grade",
    "edition",
    "generation",
    "period",
    "game",
    "set",
    "line",
    "row",
    "page",
    "chapter",
    "level",
    "stage",
    "tier",
    "team",
    "degree",
    "party",
    "gear",
    "wave",
    "term",
    "impression",
    "sight",
    "attempt",
    "try",
    "pass",
    "batch",
    "slide",
    "section",
    "point",
    "paragraph",
    "sentence",
    "question",
    "issue",
    "part",
    "piece",
    "reason",
    "goal",
    "fan",
    "seller",
    "of",
    "and",
    "or",
    "to",
    "in",
    "is",
    "was",
    "on",
    "at",
];

fn parse_marker(words: &[Word], index: usize) -> Option<(Family, u32, usize)> {
    let word = &words[index];
    // The marker must be the whole token apart from trailing punctuation:
    // "(1)" and "first-class" are not markers.
    if !word.text.starts_with(|ch: char| ch.is_alphanumeric()) {
        return None;
    }
    if word.core_lower == "number" && word.trail.is_empty() {
        let next = words.get(index + 1)?;
        return cardinal_value(&next.core_lower).map(|value| (Family::Number, value, 2));
    }
    if word.core_lower == "first"
        && word.trail.is_empty()
        && words
            .get(index + 1)
            .is_some_and(|next| next.core_lower == "of" && next.trail.is_empty())
        && words
            .get(index + 2)
            .is_some_and(|next| next.core_lower == "all")
    {
        return Some((Family::Ordinal, 1, 3));
    }
    if let Some(value) = ordinal_value(&word.core_lower) {
        return Some((Family::Ordinal, value, 1));
    }
    cardinal_value(&word.core_lower).map(|value| (Family::Cardinal, value, 1))
}

fn collect_markers(words: &[Word]) -> Vec<Marker> {
    let mut markers = Vec::new();
    for index in 0..words.len() {
        let Some((family, value, len)) = parse_marker(words, index) else {
            continue;
        };
        if index + len >= words.len() {
            continue;
        }
        let mut connector_start = index;
        while connector_start > 0
            && index - connector_start < 2
            && words[connector_start - 1].trail.is_empty()
            && matches!(
                words[connector_start - 1].core_lower.as_str(),
                "and" | "then"
            )
        {
            connector_start -= 1;
        }
        let boundary = connector_start == 0
            || connector_start < index
            || words[connector_start - 1].is_boundary_before(Some(&words[connector_start]));
        if !boundary {
            continue;
        }
        let last = &words[index + len - 1];
        let separated = last.trail.starts_with([',', ':', '.', ')']);
        // Inner marker words must run together: "number, one" is not "number one".
        if len > 1
            && words[index..index + len - 1]
                .iter()
                .any(|w| !w.trail.is_empty())
        {
            continue;
        }
        if (family == Family::Cardinal || value == LAST) && !separated {
            continue;
        }
        markers.push(Marker {
            connector_start,
            first: index,
            end: index + len,
            family,
            value,
            separated,
        });
    }
    markers
}

/// Count announced by the words before the list ("three things", "the
/// following"). `Some(None)` is an announcement without a number.
fn list_announcement(lead: &str) -> Option<Option<usize>> {
    static COUNTED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)\b(two|three|four|five|six|seven|eight|nine|ten|[2-9]|10|a few|a couple of|a couple|several|some|few|these|multiple)\s+(?:[a-z'-]+\s+){0,2}?(things|items|points|steps|reasons|questions|options|ideas|tasks|priorities|issues|changes|updates|goals|topics|parts|requests|notes|concerns|takeaways|action items|next steps|todos|to-dos|errands|bugs|fixes)\b",
        )
        .expect("list announcement pattern")
    });
    static FOLLOWING: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(the following|as follows)\s*[:,.]?\s*$").expect("following pattern")
    });
    if let Some(captures) = COUNTED.captures_iter(lead).last() {
        let count = match captures[1].to_ascii_lowercase().as_str() {
            "two" | "2" => Some(2),
            "three" | "3" => Some(3),
            "four" | "4" => Some(4),
            "five" | "5" => Some(5),
            "six" | "6" => Some(6),
            "seven" | "7" => Some(7),
            "eight" | "8" => Some(8),
            "nine" | "9" => Some(9),
            "ten" | "10" => Some(10),
            _ => None,
        };
        return Some(count);
    }
    FOLLOWING.is_match(lead).then_some(None)
}

/// Picks the marker sequence: values 1, 2, 3 ... of one family, in order.
/// A skipped or repeated number rejects the whole thing; a new "1" after a
/// complete list ends it.
fn marker_sequence(markers: &[Marker]) -> Option<Vec<Marker>> {
    let start = markers.iter().position(|marker| marker.value == 1)?;
    let family = markers[start].family;
    let mut sequence = vec![markers[start].clone()];
    let mut expected = 2;
    for marker in &markers[start + 1..] {
        if marker.family != family || marker.first < sequence.last()?.end {
            continue;
        }
        if marker.value == expected {
            sequence.push(marker.clone());
            expected += 1;
        } else if marker.value == LAST && sequence.len() >= 2 {
            sequence.push(marker.clone());
            break;
        } else if marker.value == 1 {
            break;
        } else {
            return None;
        }
    }
    Some(sequence)
}

struct ListParts {
    lead: String,
    items: Vec<String>,
    tail: String,
    /// The lead announced the list ("three things:", "the following").
    announced: bool,
    /// Every marker was "number N" ("number one, ..., number two, ...").
    numbered_aloud: bool,
}

fn strip_item_edges(item: &str) -> String {
    let item = item
        .trim()
        .trim_start_matches(['-', '\u{2013}', '\u{2014}', ':', ','])
        .trim_start();
    item.trim_end_matches(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | '-'))
        .to_string()
}

/// Capitalizes an item's first letter unless its first word is mixed-case
/// ("iPhone", "eBay").
fn capitalize_item(item: &str) -> String {
    let first_word = item.split_whitespace().next().unwrap_or_default();
    if first_word.chars().skip(1).any(char::is_uppercase) {
        item.to_string()
    } else {
        capitalize_first(item)
    }
}

fn detect_list(text: &str) -> Option<ListParts> {
    let words = split_words(text);
    let markers = collect_markers(&words);
    let sequence = marker_sequence(&markers)?;
    let first = sequence.first()?;

    let lead = text[..words[first.connector_start].start].trim();
    let announcement = list_announcement(lead);
    let enough = match announcement {
        Some(Some(count)) => count == sequence.len() && sequence.len() >= 2,
        Some(None) => sequence.len() >= 2,
        None => sequence.len() >= 3,
    };
    if !enough || sequence.len() > 10 {
        return None;
    }

    // An unpunctuated ordinal that modifies a noun ("First quarter results")
    // is not a marker.
    if sequence
        .iter()
        .filter(|marker| !marker.separated)
        .any(|marker| {
            words.get(marker.end).is_none_or(|follower| {
                MARKER_MODIFIED_NOUNS.contains(&follower.core_lower.as_str())
            })
        })
    {
        return None;
    }

    // Without an announced list ("three things:"), a bare ordinal or number
    // with no pause after it is ordinary prose ("First prototype failed.
    // Second prototype worked."); only "number one" style stays explicit.
    if announcement.is_none()
        && sequence
            .iter()
            .any(|marker| !marker.separated && marker.family != Family::Number)
    {
        return None;
    }

    // The last item runs to the end of its first sentence.
    let last = sequence.last()?;
    let last_end = (last.end..words.len())
        .find(|&index| words[index].ends_sentence_before(words.get(index + 1)))
        .map(|index| index + 1)
        .unwrap_or(words.len());

    let mut items = Vec::with_capacity(sequence.len());
    for (position, marker) in sequence.iter().enumerate() {
        let end = sequence
            .get(position + 1)
            .map(|next| next.connector_start)
            .unwrap_or(last_end);
        if end <= marker.end {
            return None;
        }
        let item = strip_item_edges(&text[words[marker.end].start..words[end - 1].end]);
        if !item.chars().any(char::is_alphabetic) {
            return None;
        }
        items.push(item);
    }

    // A short lead with no punctuation ("So first, ...") is filler that
    // would read oddly as a heading; leave such text alone.
    if !lead.is_empty()
        && !lead.ends_with(['.', '!', '?', ':'])
        && lead.split_whitespace().count() < 3
        && announcement.is_none()
    {
        return None;
    }
    // Pause punctuation before the first marker is replaced by the colon
    // `introduce_list` adds after punctuation.
    let lead = lead
        .trim_end_matches(|ch: char| {
            ch.is_whitespace() || matches!(ch, ',' | ';' | ':' | '-' | '\u{2013}' | '\u{2014}')
        })
        .to_string();

    let tail = if last_end < words.len() {
        text[words[last_end].start..].trim().to_string()
    } else {
        String::new()
    };

    Some(ListParts {
        lead,
        items,
        tail,
        announced: announcement.is_some(),
        numbered_aloud: sequence
            .iter()
            .all(|marker| marker.family == Family::Number),
    })
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

/// Sentence openers that change the subject.
const TOPIC_SHIFT_OPENERS: &[&str] = &[
    "also",
    "separately",
    "on another note",
    "on a different note",
    "on a separate note",
    "on an unrelated note",
    "moving on",
    "one more thing",
    "another thing",
    "by the way",
    "in other news",
    "switching gears",
    "changing topics",
    "anyway",
    "unrelated",
];

fn opens_new_topic(sentence: &str) -> bool {
    let lower = sentence.trim_start().to_lowercase();
    TOPIC_SHIFT_OPENERS.iter().any(|opener| {
        lower.starts_with(opener)
            && lower[opener.len()..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_alphanumeric())
    })
}

/// Sentence spans as word-index ranges. A sentence ends at terminal
/// punctuation followed by a capitalized word, a digit or a quote, so
/// "e.g. this" and "3.14" never split.
fn sentence_ranges(words: &[Word]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for index in 0..words.len() {
        let next_opens = words.get(index + 1).is_some_and(|next| {
            next.text
                .chars()
                .find(|ch| !matches!(ch, '"' | '\u{201C}' | '(' | '\''))
                .is_some_and(|ch| ch.is_uppercase() || ch.is_ascii_digit())
        });
        if words[index].ends_sentence_before(words.get(index + 1)) && next_opens {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < words.len() {
        ranges.push((start, words.len()));
    }
    ranges
}

/// Groups sentences into paragraphs: a new one once the current paragraph
/// reaches `threshold` words (the same length rule the formatter has always
/// used), or earlier when a sentence opens a new topic and the current
/// paragraph already has at least two sentences and twelve words.
fn paragraphize(text: &str, threshold: Option<usize>) -> String {
    let Some(threshold) = threshold else {
        return text.to_string();
    };
    let words = split_words(text);
    let sentences = sentence_ranges(&words);
    if sentences.len() < 2 {
        return text.to_string();
    }
    let mut paragraphs: Vec<(usize, usize)> = Vec::new();
    let (mut para_start, mut para_words, mut para_sentences) = (0usize, 0usize, 0usize);
    for &(start, end) in &sentences {
        let sentence_text = &text[words[start].start..words[end - 1].end];
        let breaks = para_sentences > 0
            && (para_words >= threshold
                || (opens_new_topic(sentence_text) && para_sentences >= 2 && para_words >= 12));
        if breaks {
            paragraphs.push((para_start, start));
            para_start = start;
            para_words = 0;
            para_sentences = 0;
        }
        para_words += end - start;
        para_sentences += 1;
    }
    paragraphs.push((para_start, words.len()));
    paragraphs
        .iter()
        .map(|&(start, end)| &text[words[start].start..words[end - 1].end])
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The line above a list ends with a colon unless it already ends a
/// sentence or a question.
fn introduce_list(lead: &str) -> String {
    if lead.ends_with(['.', '!', '?', ':']) {
        lead.to_string()
    } else {
        format!("{lead}:")
    }
}

/// Items that are all full sentences keep their full stops; fragments read
/// best without them. Question and exclamation marks always stay.
fn harmonize_item_endings(items: &mut [String]) {
    if items.iter().all(|item| item.ends_with(['.', '!', '?'])) {
        return;
    }
    for item in items {
        let keeps_period = item.split_whitespace().next_back().is_some_and(|word| {
            is_abbreviation(
                &word
                    .trim_end_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase(),
            ) || word.ends_with("..")
        });
        if item.ends_with('.') && !keeps_period {
            item.pop();
        }
    }
}

/// Chat compose boxes send on Return, so they get no paragraphs or email
/// lines, but a list the speaker announced ("three things: first ...,
/// second ..., third ...") reads better numbered, and a pasted multi-line
/// message stays one message. `None` leaves the text to ordinary prose.
pub(crate) fn announced_list_block(
    text: &str,
    punctuate: &dyn Fn(&str) -> String,
) -> Option<String> {
    if !detect_list(text)?.announced {
        return None;
    }
    Some(structure_block(text, None, punctuate))
}

/// An app Plainsong has no category for, in a multi-line field, gets a
/// numbered list only when the speaker made the list explicit: announced it
/// ("three things: first ...") or numbered every item aloud ("number one
/// ..., number two ..., number three ..."). No paragraphs or email lines.
pub(crate) fn explicit_list_block(
    text: &str,
    punctuate: &dyn Fn(&str) -> String,
) -> Option<String> {
    let list = detect_list(text)?;
    if !(list.announced || list.numbered_aloud) {
        return None;
    }
    Some(structure_block(text, None, punctuate))
}

/// Lays out one block of single-line prose: a numbered list where the
/// speaker clearly enumerated, paragraphs elsewhere. The list is found on
/// the unpunctuated block so a question about the list ("Can you do three
/// things: ...") keeps its question mark on the lead, not the last item;
/// `punctuate` then runs on the lead, each item and the tail separately.
pub(crate) fn structure_block(
    text: &str,
    paragraph_threshold: Option<usize>,
    punctuate: &dyn Fn(&str) -> String,
) -> String {
    let Some(list) = detect_list(text) else {
        return paragraphize(&punctuate(text), paragraph_threshold);
    };
    let mut output = String::new();
    let mut lead_asks = false;
    if !list.lead.is_empty() {
        let lead = introduce_list(punctuate(&list.lead).trim());
        // The lead became a question here ("Can you do three things?"), so
        // a question mark the speaker put at the very end asked it.
        lead_asks = lead.ends_with('?') && !list.lead.ends_with('?');
        output.push_str(&paragraphize(&lead, paragraph_threshold));
        output.push('\n');
    }
    let mut items: Vec<String> = list
        .items
        .iter()
        .map(|item| capitalize_item(&strip_item_edges(&punctuate(item))))
        .collect();
    let questions = items.iter().filter(|item| item.ends_with('?')).count();
    let spoken_at_end = list.items.last().is_some_and(|raw| raw.ends_with('?'));
    if lead_asks && questions == 1 && spoken_at_end {
        if let Some(last) = items.last_mut().filter(|item| item.ends_with('?')) {
            last.pop();
        }
    }
    harmonize_item_endings(&mut items);
    let numbered: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(index, item)| format!("{}. {}", index + 1, item))
        .collect();
    output.push_str(&numbered.join("\n"));
    if !list.tail.is_empty() {
        output.push_str("\n\n");
        output.push_str(&structure_block(&list.tail, paragraph_threshold, punctuate));
    }
    output
}

// ---------------------------------------------------------------------------
// Email greeting and sign-off
// ---------------------------------------------------------------------------

pub(crate) struct EmailFrame {
    pub greeting: Option<String>,
    pub body: String,
    pub sign_off: Option<String>,
}

const GREETING_GROUP_WORDS: &[&str] = &[
    "all",
    "everyone",
    "everybody",
    "team",
    "there",
    "folks",
    "guys",
    "y'all",
    "both",
    "again",
];

fn name_like(word: &Word) -> bool {
    let core = word
        .text
        .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '.');
    core.chars().next().is_some_and(char::is_uppercase)
        && core != "I"
        && core
            .chars()
            .all(|ch| ch.is_alphabetic() || matches!(ch, '-' | '\'' | '.'))
}

fn join_words(words: &[Word]) -> String {
    words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalize_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// "Hi Sam," / "Hello," / "Good morning, team." at the start of an email,
/// followed by at least three words of body. Returns the greeting text, the
/// lowercase names it addresses, and the word index where the body starts.
fn parse_greeting(words: &[Word]) -> Option<(String, Vec<String>, usize)> {
    let first = words.first()?;
    let (opener_len, needs_name) = match first.core_lower.as_str() {
        "hi" | "hello" | "greetings" => (1, false),
        "hey" | "dear" => (1, true),
        "good"
            if first.trail.is_empty()
                && words.get(1).is_some_and(|next| {
                    matches!(
                        next.core_lower.as_str(),
                        "morning" | "afternoon" | "evening"
                    )
                }) =>
        {
            (2, false)
        }
        _ => return None,
    };
    if words[..opener_len - 1].iter().any(|w| !w.trail.is_empty()) {
        return None;
    }
    // The salutation ends at its first punctuation, at most three words in.
    let end = (opener_len - 1..(opener_len + 3).min(words.len())).find(|&index| {
        words[index].trail_has(&[',', ':', '!'])
            || (words[index].trail.contains('.') && !is_abbreviation(&words[index].core_lower))
    })?;
    let names = &words[opener_len.min(end + 1)..=end];
    if names.is_empty() && needs_name {
        return None;
    }
    if !names
        .iter()
        .all(|word| name_like(word) || GREETING_GROUP_WORDS.contains(&word.core_lower.as_str()))
    {
        return None;
    }
    if words.len() - (end + 1) < 3 {
        return None;
    }
    let mut greeting = join_words(&words[..=end]);
    if greeting.ends_with('.') {
        greeting.pop();
        greeting.push(',');
    }
    let addressed = names
        .iter()
        .map(|word| word.core_lower.clone())
        .collect::<Vec<_>>();
    Some((capitalize_first(&greeting), addressed, end + 1))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ValedictionKind {
    /// Thanks-style closings can also thank the person named after them.
    Thanks,
    /// Closings that are never addressed to someone ("Best", "Regards").
    Signature,
}

const VALEDICTIONS: &[(&[&str], ValedictionKind)] = &[
    (&["thank", "you", "so", "much"], ValedictionKind::Thanks),
    (&["thanks", "so", "much"], ValedictionKind::Thanks),
    (&["thanks", "in", "advance"], ValedictionKind::Thanks),
    (&["thank", "you", "again"], ValedictionKind::Thanks),
    (&["thanks", "again"], ValedictionKind::Thanks),
    (&["many", "thanks"], ValedictionKind::Thanks),
    (&["thank", "you"], ValedictionKind::Thanks),
    (&["thanks"], ValedictionKind::Thanks),
    (&["all", "the", "best"], ValedictionKind::Signature),
    (&["best", "regards"], ValedictionKind::Signature),
    (&["kind", "regards"], ValedictionKind::Signature),
    (&["warm", "regards"], ValedictionKind::Signature),
    (&["warmest", "regards"], ValedictionKind::Signature),
    (&["best", "wishes"], ValedictionKind::Signature),
    (&["yours", "truly"], ValedictionKind::Signature),
    (&["talk", "soon"], ValedictionKind::Signature),
    (&["take", "care"], ValedictionKind::Signature),
    (&["regards"], ValedictionKind::Signature),
    (&["best"], ValedictionKind::Signature),
    (&["cheers"], ValedictionKind::Signature),
    (&["sincerely"], ValedictionKind::Signature),
    (&["warmly"], ValedictionKind::Signature),
    (&["respectfully"], ValedictionKind::Signature),
];

/// A closing that is the whole final sentence: a valediction, then up to
/// three capitalized name words. "Thanks for the update." and "Best regards
/// to your family." are ordinary sentences.
fn parse_sign_off(words: &[Word], start: usize, addressed: Option<&[String]>) -> Option<String> {
    let rest = &words[start..];
    let (phrase, kind) = VALEDICTIONS.iter().find(|(phrase, _)| {
        phrase.len() <= rest.len()
            && phrase
                .iter()
                .zip(rest)
                .all(|(want, word)| *want == word.core_lower)
            && rest[..phrase.len() - 1].iter().all(|w| w.trail.is_empty())
    })?;
    let valediction = &rest[..phrase.len()];
    let names = &rest[phrase.len()..];
    let closing_trail = &valediction.last()?.trail;
    if !closing_trail.chars().all(|ch| ",.!".contains(ch)) {
        return None;
    }
    if names.len() > 3 {
        return None;
    }
    let closing = capitalize_first(&join_words(valediction));
    if names.is_empty() {
        // "Best." reads as "Best," above a signature; "Thanks." stays.
        if *kind == ValedictionKind::Signature && closing.ends_with('.') {
            return Some(format!("{},", closing.trim_end_matches('.')));
        }
        return Some(closing);
    }
    if !names.iter().all(name_like)
        || names[..names.len() - 1].iter().any(|w| !w.trail.is_empty())
        || !names.last()?.trail.chars().all(|ch| ".!".contains(ch))
    {
        return None;
    }
    let name = join_words(names);
    let name = name.trim_end_matches('.');
    let names_greeted = addressed.is_some_and(|addressed| {
        names
            .iter()
            .any(|word| addressed.contains(&word.core_lower))
    });
    // "Talk soon, Sam." after "Hi Sam," is said to Sam, not signed by Sam,
    // whatever the closing. An exclamation mark ("Cheers, Sam!", "Thanks!
    // Jonathan.") is kept by keeping the sentence whole.
    let exclaims = closing_trail.contains('!') || name.ends_with('!');
    let signs = !names_greeted
        && !exclaims
        && match kind {
            ValedictionKind::Signature => true,
            // "Thanks, Priya." with no greeting is ambiguous, so it stays one
            // line.
            ValedictionKind::Thanks => addressed.is_some(),
        };
    if signs {
        let bare = closing.trim_end_matches([',', '.', '!']);
        Some(format!("{bare},\n{name}"))
    } else {
        let sentence = join_words(rest);
        Some(capitalize_first(&sentence))
    }
}

/// Splits an email dictation into greeting line, body and sign-off. Each
/// part is only split off when it is unambiguous; otherwise everything is
/// body.
pub(crate) fn split_email_frame(text: &str) -> EmailFrame {
    let words = split_words(text);
    let greeting = parse_greeting(&words);
    let body_start = greeting.as_ref().map(|(_, _, start)| *start).unwrap_or(0);
    let addressed = greeting.as_ref().map(|(_, names, _)| names.as_slice());

    // The sign-off must follow a sentence end and leave some body: after a
    // greeting a one-word reply is a whole email ("Hi Sam, approved. Best,
    // Jordan."); without one, at least three words.
    let min_body_words = if greeting.is_some() { 1 } else { 3 };
    let sign_off = (body_start + min_body_words..words.len())
        .rev()
        .filter(|&index| words[index - 1].ends_sentence_before(words.get(index)))
        .find_map(|index| parse_sign_off(&words, index, addressed).map(|text| (index, text)));

    // Speech-to-text often runs the closing into the last sentence with a
    // comma: "Let me know what works for you, best, Jordan." or "Could you
    // send them by Thursday, thanks, Jonathan?". After a greeting, a final
    // "<closing>, <name>" that signs the email is split off the same way, and
    // the comma before it becomes the body's own full stop or question mark.
    let comma_sign_off = sign_off
        .is_none()
        .then(|| comma_joined_sign_off(&words, body_start, addressed))
        .flatten();

    let body_end = sign_off
        .as_ref()
        .map(|(index, _)| words[index - 1].end)
        .or(comma_sign_off
            .as_ref()
            .map(|split| words[split.index - 1].end))
        .unwrap_or(text.len());
    let body_begin = words.get(body_start).map(|w| w.start).unwrap_or(text.len());
    let mut body = text[body_begin.min(body_end)..body_end].trim().to_string();
    if let Some(split) = &comma_sign_off {
        body.truncate(body.trim_end_matches(',').len());
        body.push(split.body_terminal);
    }
    EmailFrame {
        greeting: greeting.map(|(text, _, _)| text),
        body,
        sign_off: sign_off
            .map(|(_, text)| text)
            .or(comma_sign_off.map(|split| split.sign_off)),
    }
}

struct CommaSignOff {
    index: usize,
    sign_off: String,
    body_terminal: char,
}

/// Greeting words that address a group rather than one person.
const GROUP_ADDRESSEES: &[&str] = &[
    "team",
    "all",
    "everyone",
    "everybody",
    "folks",
    "guys",
    "y'all",
];

/// The closing at the very end of a greeted email, joined to the last
/// sentence by a comma. Only a closing that signs ("Best,\nJordan") counts:
/// one said to the person greeted, or a bare "thanks", stays in the sentence.
fn comma_joined_sign_off(
    words: &[Word],
    body_start: usize,
    addressed: Option<&[String]>,
) -> Option<CommaSignOff> {
    let addressed_group = addressed?
        .iter()
        .any(|name| GROUP_ADDRESSEES.contains(&name.as_str()));
    let last = words.len().checked_sub(1)?;
    let body_terminal = if words[last].trail == "?" { '?' } else { '.' };
    if !matches!(words[last].trail.as_str(), "." | "?" | "") {
        return None;
    }
    let mut closing_words = words.to_vec();
    let signature = &mut closing_words[last];
    signature.text = format!("{}.", signature.text.trim_end_matches(['.', '?']));
    signature.trail = ".".to_string();
    // A closing is one or two words and a signature at most three: the
    // closing starts within the last five words.
    // "good, better, best, Jordan" ends a comparative series, not the email.
    (last.saturating_sub(4).max(body_start + 3)..last)
        .rev()
        .filter(|&index| words[index - 1].trail == ",")
        .filter(|&index| {
            !(words[index].core_lower == "best" && words[index - 1].core_lower == "better")
        })
        // To a group, "..., thanks, Priya." may thank Priya in front of
        // everyone: it stays in the body.
        .filter(|&index| {
            !(addressed_group
                && matches!(
                    words[index].core_lower.as_str(),
                    "thanks" | "thank" | "many"
                ))
        })
        .find_map(|index| {
            let sign_off = parse_sign_off(&closing_words, index, addressed)?;
            sign_off.contains('\n').then_some(CommaSignOff {
                index,
                sign_off,
                body_terminal,
            })
        })
}

/// Email and worklog text normally gets a closing full stop. A layout that
/// ends in a list item, a sign-off comma or a signature name must not.
pub(crate) fn final_line_takes_no_period(text: &str) -> bool {
    static LIST_ITEM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d{1,2}\. \S").expect("list item pattern"));
    let trimmed = text.trim_end();
    if trimmed.ends_with(',') {
        return true;
    }
    let mut lines = trimmed.rsplit('\n');
    let last = lines.next().unwrap_or_default().trim();
    if LIST_ITEM.is_match(last) {
        return true;
    }
    // A signature name under a closing line ("Best regards,\nJonathan").
    // Any other short line after a comma ("Done,\nNext item here") is
    // ordinary text and keeps its period.
    lines.next().is_some_and(|previous| {
        is_closing_line(previous)
            && (1..=3).contains(&last.split_whitespace().count())
            && !last.ends_with(['.', '!', '?'])
    })
}

/// "Best regards," / "Thanks," on a line of its own, as `parse_sign_off`
/// writes it above a signature.
fn is_closing_line(line: &str) -> bool {
    let Some(closing) = line.trim().strip_suffix(',') else {
        return false;
    };
    let closing = closing.to_lowercase();
    let words: Vec<&str> = closing.split_whitespace().collect();
    VALEDICTIONS.iter().any(|(phrase, _)| {
        phrase.len() == words.len() && phrase.iter().zip(&words).all(|(a, b)| a == b)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn single_line_roles_block_line_breaks() {
        for role in ["AXTextField", "AXSearchField", "AXComboBox"] {
            assert!(!field_role_allows_line_breaks(Some(role)), "{role}");
        }
        for role in [Some("AXTextArea"), Some("AXWebArea")] {
            assert!(field_role_allows_line_breaks(role), "{role:?}");
        }
    }

    #[test]
    fn an_unknown_field_role_gets_no_added_line_breaks() {
        // The accessibility read failed: the field may be a subject line.
        for role in [None, Some(""), Some("  ")] {
            assert!(!field_role_allows_line_breaks(role), "{role:?}");
        }
    }

    #[test]
    fn layout_is_limited_to_multi_line_destinations() {
        use DictationAppCategory::*;
        for category in [Email, Notes, Worklog] {
            assert!(category_supports_layout("voice", category));
            assert!(!category_supports_layout("messages", category));
        }
        for category in [Messaging, AiChat, CodeEditor, Other] {
            assert!(!category_supports_layout("voice", category));
            assert!(!category_supports_layout("notes", category));
        }
    }

    #[test]
    fn spoken_breaks_convert_only_at_boundaries() {
        assert_eq!(
            convert_spoken_breaks(
                "First section. New paragraph. Second section.",
                false,
                false
            ),
            "First section.\n\nSecond section."
        );
        assert_eq!(
            convert_spoken_breaks("Item one, new line, item two", false, false),
            "Item one,\nitem two"
        );
        assert_eq!(
            convert_spoken_breaks(
                "We covered the launch plan in detail, new paragraph, then pricing",
                false,
                false
            ),
            "We covered the launch plan in detail.\n\nthen pricing"
        );
        for prose in [
            "I'll add a new paragraph about pricing.",
            "Add a new line item for travel.",
            "Done. New paragraph text goes here.",
            "The intro is done. New paragraph.",
            "New paragraph about pricing.",
        ] {
            assert_eq!(convert_spoken_breaks(prose, false, false), prose);
            assert_eq!(convert_spoken_breaks(prose, false, true), prose);
        }
        assert_eq!(
            convert_spoken_breaks("New paragraph, I wanted to follow up.", true, false),
            "I wanted to follow up."
        );
    }

    #[test]
    fn spoken_break_words_that_start_a_noun_phrase_stay_words() {
        for prose in [
            "We hired more staff. New line cooks start Monday.",
            "Fixed the parser. Newline handling is still broken in the export.",
            "The deck is done. New paragraph styles are in the template.",
            "Sales are flat. New line launches in May.",
            "Also, new line items were added.",
        ] {
            assert_eq!(convert_spoken_breaks(prose, false, false), prose, "{prose}");
            assert_eq!(convert_spoken_breaks(prose, true, false), prose, "{prose}");
        }
        // A command that stands as its own clause still converts.
        assert_eq!(
            convert_spoken_breaks(
                "We hired more staff. New line. Cooks start Monday.",
                false,
                false
            ),
            "We hired more staff.\nCooks start Monday."
        );
        assert_eq!(
            convert_spoken_breaks(
                "Fixed the parser, newline, the export is next",
                false,
                false
            ),
            "Fixed the parser,\nthe export is next"
        );
    }

    #[test]
    fn unpunctuated_spoken_breaks_need_dictated_punctuation() {
        // "first section period new paragraph second section period": the
        // speaker is dictating punctuation, so the bare command is a command.
        assert_eq!(
            convert_spoken_breaks("first section. new paragraph second section.", false, true),
            "first section.\n\nsecond section."
        );
        // The same words from a recognizer that punctuates on its own stay.
        let prose = "First section. New paragraph styles are in the template.";
        assert_eq!(convert_spoken_breaks(prose, false, false), prose);
        // A bare "newline" token is never a command without punctuation.
        let token = "the parser. newline handling is broken.";
        assert_eq!(convert_spoken_breaks(token, false, true), token);
        // Noun followers still win in dictated-punctuation mode.
        let noun = "done. new line items are listed.";
        assert_eq!(convert_spoken_breaks(noun, false, true), noun);
    }

    #[test]
    fn spoken_enumerations_become_numbered_lists() {
        assert_eq!(
            structure_block(
                "I need three things: first, the budget, second, the timeline, and third, the owner.",
                None,
                &plain
            ),
            "I need three things:\n1. The budget\n2. The timeline\n3. The owner"
        );
        // Unpunctuated ordinals count once the list is announced.
        assert_eq!(
            structure_block(
                "Three steps. First back up the database. Second rotate the key. Third restart the worker.",
                None,
                &plain
            ),
            "Three steps.\n1. Back up the database.\n2. Rotate the key.\n3. Restart the worker."
        );
        assert_eq!(
            structure_block(
                "Here are the steps. Number one, open settings. Number two, pick a model. Number three, start dictating. Let me know if it works.",
                None,
                &plain
            ),
            "Here are the steps.\n1. Open settings.\n2. Pick a model.\n3. Start dictating.\n\nLet me know if it works."
        );
        assert_eq!(
            structure_block("Two things. One, ship it. Two, tell Sam.", None, &plain),
            "Two things.\n1. Ship it.\n2. Tell Sam."
        );
        assert_eq!(
            structure_block(
                "We agreed on a few things, first we keep the price, second we hire Ana, and finally, we ship Monday.",
                None,
                &plain
            ),
            "We agreed on a few things:\n1. We keep the price\n2. We hire Ana\n3. We ship Monday"
        );
    }

    #[test]
    fn ordinary_sentences_with_ordinals_and_numbers_are_not_lists() {
        for text in [
            "First, I want to thank you for coming.",
            "First, I want to thank you. Second, I want to welcome Ana.",
            "Our number one priority is speed.",
            "Number one priority is speed. Number two priority is cost. Number three priority is scope.",
            "First quarter results were strong, second quarter results were weak, third quarter is pending.",
            "First place went to Sam, second place went to Lee, and third place went to Ana.",
            "It costs 1, 2, or 3 dollars depending on size.",
            "Options: 1, 2, 3.",
            "We meet at 1. 2 people will join, and 3 will dial in.",
            "One, two, three, four.",
            "First, X. Third, Y. Fourth, Z.",
            "Give me a second, I'll find the first one and the third one.",
            "The total is $1,250 and the meeting is at 3:30 pm.",
            "First, second, and third place winners were announced.",
            "So first, call Sam, second, email Ana, third, book the room.",
            "First prototype failed. Second prototype worked. Third prototype shipped.",
            "First we eat. Second we talk. Third we leave.",
        ] {
            assert_eq!(structure_block(text, None, &plain), text, "{text}");
        }
    }

    #[test]
    fn the_last_item_runs_past_dotted_abbreviations() {
        assert_eq!(
            structure_block(
                "Three things: first, call Sam at 9 a.m. tomorrow. Second, email Ana. Third, book the room at 3 p.m. on Friday.",
                None,
                &plain
            ),
            "Three things:\n1. Call Sam at 9 a.m. tomorrow.\n2. Email Ana.\n3. Book the room at 3 p.m. on Friday."
        );
        // A dotted abbreviation followed by a capitalized word still ends the
        // item, so a following sentence is not swallowed.
        assert_eq!(
            structure_block(
                "Three things: first, call Sam. Second, email Ana. Third, book the room at 3 p.m. Then we celebrate.",
                None,
                &plain
            ),
            "Three things:\n1. Call Sam.\n2. Email Ana.\n3. Book the room at 3 p.m.\n\nThen we celebrate."
        );
    }

    #[test]
    fn a_question_about_the_list_keeps_one_question_mark_on_the_lead() {
        let question = |text: &str| {
            if text.starts_with("Can you") && !text.ends_with('?') {
                format!("{}?", text.trim_end_matches(['.', ',']))
            } else {
                text.to_string()
            }
        };
        assert_eq!(
            structure_block(
                "Can you do three things: first, call Sam, second, email Ana, and third, book the room?",
                None,
                &question
            ),
            "Can you do three things?\n1. Call Sam\n2. Email Ana\n3. Book the room"
        );
        // When the lead is a statement the question belongs to the item.
        assert_eq!(
            structure_block(
                "I need three things: first, the budget, second, the timeline, and third, the owner?",
                None,
                &question
            ),
            "I need three things:\n1. The budget\n2. The timeline\n3. The owner?"
        );
        // A lead that was already a question keeps every item's question.
        assert_eq!(
            structure_block(
                "Three questions? First, who is coming? Second, when? Third, where?",
                None,
                &question
            ),
            "Three questions?\n1. Who is coming?\n2. When?\n3. Where?"
        );
    }

    #[test]
    fn existing_numbering_and_counted_mismatch_stay() {
        // A count that does not match the markers is not a clear list.
        let text = "I have two things: first, the budget, second, the timeline, third, the owner.";
        assert_eq!(structure_block(text, None, &plain), text);
    }

    #[test]
    fn paragraphs_split_at_length_and_topic_shifts() {
        let text = "The launch went well. Everyone liked the demo and the numbers look good so far. Also, I need the invoice by Friday. Can you send it?";
        assert_eq!(
            paragraphize(text, Some(40)),
            "The launch went well. Everyone liked the demo and the numbers look good so far.\n\nAlso, I need the invoice by Friday. Can you send it?"
        );
        // One short sentence before the shift is not a paragraph yet.
        let short = "Thanks. Also, send it Friday.";
        assert_eq!(paragraphize(short, Some(40)), short);
        // Abbreviations and decimals never end a sentence.
        let dotted = "Dr. Patel shipped 3.14 today. e.g. this stays.";
        assert_eq!(paragraphize(dotted, Some(2)), dotted);
        assert_eq!(
            paragraphize("One two. Three four.", Some(2)),
            "One two.\n\nThree four."
        );
        assert_eq!(
            paragraphize("One two. Three four.", None),
            "One two. Three four."
        );
    }

    #[test]
    fn short_email_bodies_still_have_signatures() {
        for (input, body, signature) in [
            (
                "Hi Sam, approved. Best, Jordan.",
                "approved.",
                "Best,\nJordan",
            ),
            (
                "Hi Sam, please review. Best, Jordan.",
                "please review.",
                "Best,\nJordan",
            ),
            (
                "Hi team, approved. Best, Priya.",
                "approved.",
                "Best,\nPriya",
            ),
            (
                "Hi team, please review. Thanks, Priya.",
                "please review.",
                "Thanks,\nPriya",
            ),
            (
                "Hi everyone, please review. Best, Priya.",
                "please review.",
                "Best,\nPriya",
            ),
            (
                "Hi Sam, approved. Thanks, Jordan.",
                "approved.",
                "Thanks,\nJordan",
            ),
            (
                "Hi Sam, yes. Best regards, Jordan.",
                "yes.",
                "Best regards,\nJordan",
            ),
            (
                "Hi Sam, I agree. Regards, Jordan.",
                "I agree.",
                "Regards,\nJordan",
            ),
            (
                "Hi Sam, no. Respectfully, Jordan.",
                "no.",
                "Respectfully,\nJordan",
            ),
        ] {
            let frame = split_email_frame(input);
            assert!(frame.greeting.is_some(), "{input}");
            assert_eq!(frame.body, body, "{input}");
            assert_eq!(frame.sign_off.as_deref(), Some(signature), "{input}");
        }
    }

    #[test]
    fn email_frame_splits_greeting_and_sign_off() {
        let frame = split_email_frame(
            "Hi Sam, the report is ready for review. Let me know what you think. Best, Jonathan.",
        );
        assert_eq!(frame.greeting.as_deref(), Some("Hi Sam,"));
        assert_eq!(
            frame.body,
            "the report is ready for review. Let me know what you think."
        );
        assert_eq!(frame.sign_off.as_deref(), Some("Best,\nJonathan"));

        let frame = split_email_frame("Hi team, the build is green. Thanks, Priya.");
        assert_eq!(frame.sign_off.as_deref(), Some("Thanks,\nPriya"));

        // Thanking the person greeted is not a signature.
        let frame = split_email_frame("Hi Sam, the build is green. Thanks, Sam.");
        assert_eq!(frame.sign_off.as_deref(), Some("Thanks, Sam."));

        let frame = split_email_frame("Hello, I wanted to follow up on the contract. Thanks!");
        assert_eq!(frame.greeting.as_deref(), Some("Hello,"));
        assert_eq!(frame.sign_off.as_deref(), Some("Thanks!"));

        let frame =
            split_email_frame("Dear Dr. Patel, please find the results attached. Kind regards.");
        assert_eq!(frame.greeting.as_deref(), Some("Dear Dr. Patel,"));
        assert_eq!(frame.sign_off.as_deref(), Some("Kind regards,"));
    }

    #[test]
    fn a_closing_that_names_the_person_greeted_is_not_a_signature() {
        for (text, closing) in [
            (
                "Hi Sam, the build is green. Talk soon, Sam.",
                "Talk soon, Sam.",
            ),
            (
                "Hi Sam, the build is green. Take care, Sam.",
                "Take care, Sam.",
            ),
            ("Hi Sam, the build is green. Best, Sam.", "Best, Sam."),
            ("Hi Sam, the build is green. Cheers, Sam!", "Cheers, Sam!"),
        ] {
            let frame = split_email_frame(text);
            assert_eq!(frame.greeting.as_deref(), Some("Hi Sam,"), "{text}");
            assert_eq!(frame.body, "the build is green.", "{text}");
            assert_eq!(frame.sign_off.as_deref(), Some(closing), "{text}");
        }
        // A different name after the closing is still the signature.
        let frame = split_email_frame("Hi Sam, the build is green. Talk soon, Jonathan.");
        assert_eq!(frame.sign_off.as_deref(), Some("Talk soon,\nJonathan"));
    }

    #[test]
    fn a_sign_off_never_drops_an_exclamation_or_question_mark() {
        for text in [
            "Hi team, the build is green. Cheers, Sam!",
            "The build is green. Cheers, Sam!",
            "The build is green. Thanks! Sam.",
        ] {
            let frame = split_email_frame(text);
            let rebuilt = format!(
                "{} {}",
                frame.body,
                frame.sign_off.clone().unwrap_or_default()
            );
            assert_eq!(rebuilt.matches('!').count(), 1, "{text} -> {rebuilt:?}");
        }
        let frame = split_email_frame("Hi team, the build is green. Cheers, Sam?");
        assert!(frame.sign_off.is_none());
        assert!(frame.body.ends_with("Cheers, Sam?"));
    }

    #[test]
    fn a_closing_run_into_the_last_sentence_still_signs_the_email() {
        for (text, body, sign_off) in [
            (
                "Hi Alex, the migration is done. Let me know what works for you, best, Jordan.",
                "the migration is done. Let me know what works for you.",
                "Best,\nJordan",
            ),
            (
                "Hi Maria, could you send me the updated numbers by Thursday, thanks, Jonathan?",
                "could you send me the updated numbers by Thursday?",
                "Thanks,\nJonathan",
            ),
            (
                "Hi Priya, legal still needs to review it, so please don't sign anything yet, thanks, Jonathan.",
                "legal still needs to review it, so please don't sign anything yet.",
                "Thanks,\nJonathan",
            ),
        ] {
            let frame = split_email_frame(text);
            assert!(frame.greeting.is_some(), "{text}");
            assert_eq!(frame.body, body, "{text}");
            assert_eq!(frame.sign_off.as_deref(), Some(sign_off), "{text}");
        }
        for text in [
            // Said to the person greeted, or no greeting at all.
            "Hi Sam, the build is green, thanks, Sam.",
            "The build is green and the tests pass, best, Jordan.",
            "Hi team, we picked the one we liked best, Jordan.",
            "Hi team, thanks, Sam, for the help.",
            "Hi team, the build is green, cheers, Sam!",
            // Thanks to someone, said to a group.
            "Hi team, the release went out on time, thanks, Priya.",
            "Hi team, great job on the launch, thanks, Priya.",
            "Hi everyone, we shipped it, thanks, Priya.",
            "Hey folks, the doc is updated, thank you, Priya.",
            // The end of a comparative series.
            "Hi team, we ranked the drafts good, better, best, Jordan.",
        ] {
            let frame = split_email_frame(text);
            assert!(frame.sign_off.is_none(), "{text}");
        }
    }

    #[test]
    fn email_frame_leaves_ordinary_sentences_alone() {
        for text in [
            "Hey, can you check this?",
            "Hey can you check, the deploy failed again today.",
            "Hi Sam",
            "Thanks for the update. I will review it tomorrow.",
            "The deploy failed. Thanks for the update.",
            "The deploy failed. Best regards to your family.",
            "The deploy failed, thanks Sam.",
            "Hello there friend of mine, how are you?",
            "Sincerely, I don't know what happened.",
        ] {
            let frame = split_email_frame(text);
            assert!(frame.greeting.is_none(), "{text}");
            assert!(frame.sign_off.is_none(), "{text}");
            assert_eq!(frame.body, text);
        }
    }

    #[test]
    fn closing_period_rules_follow_the_last_line() {
        assert!(final_line_takes_no_period("Intro:\n1. A\n2. B"));
        assert!(final_line_takes_no_period("Body.\n\nBest,\nJonathan"));
        assert!(final_line_takes_no_period("Body.\n\nBest,"));
        assert!(!final_line_takes_no_period("Body is here"));
        assert!(!final_line_takes_no_period(
            "First line\nsecond line here and more"
        ));
        assert!(final_line_takes_no_period(
            "Body.\n\nBest regards,\nJonathan Reed"
        ));
        assert!(final_line_takes_no_period("Body.\n\nThanks,\nPriya"));
    }

    #[test]
    fn only_a_real_sign_off_keeps_a_short_last_line_without_a_period() {
        // "Done, new line, next item here" in a task app.
        assert!(!final_line_takes_no_period("Done,\nNext item here"));
        assert!(!final_line_takes_no_period("Step one,\nShip it"));
    }
}
