//! Fitting a dictation to the text already around the cursor.
//!
//! Dictating into the middle of a sentence ("I think |we should go") must not
//! paste "I thinkWe should go." with a capital, no space and a full stop in
//! the middle. Wispr Flow matches casing and spacing to the surrounding text;
//! this does the same from the characters right before and after the caret,
//! which the macOS insertion path reads through Accessibility and never
//! stores.
//!
//! Conservative by design: it only adds a separating space, lowercases the
//! first word when it is a common function word (the, we, and, but, ...)
//! and the sentence is still going, and drops a trailing full stop when more
//! of the sentence follows. Any other capitalized word may be a name
//! ("Sarah", "Monday", "Paris"), so it keeps its capital.

/// Characters after which a word needs no space before it.
const NO_SPACE_AFTER: &[char] = &[
    '(', '[', '{', '"', '\'', '\u{201C}', '\u{2018}', '/', '-', '\u{2014}', '@', '#',
];

/// Closing quotes and brackets, looked through to find how the text before
/// them ended: after `He said "Done." ` a new sentence starts.
const CLOSERS: &[char] = &['"', '\'', ')', ']', '}', '\u{201D}', '\u{2019}'];

/// Punctuation inside a sentence. Anything else that is not a letter or
/// digit (a full stop, "!", "?", ":", an emoji, a symbol) could end a
/// sentence, so nothing is lowercased after it.
const MID_SENTENCE_PUNCT: &[char] = &[
    ',', ';', '(', '[', '{', '\u{201C}', '\u{2018}', '-', '\u{2013}', '\u{2014}', '/', '&',
    '\u{3001}', '\u{FF0C}',
];

/// The only words lowercased mid-sentence: function words and common
/// openers that are never names ("will" is left out: Will is a name). A closed list, because the recognizer
/// capitalizes names too and nothing here can tell them apart.
const LOWERCASE_WHEN_CONTINUING: &[&str] = &[
    "a", "about", "actually", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be",
    "because", "before", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had",
    "has", "have", "he", "her", "here", "his", "how", "if", "in", "into", "is", "it", "its",
    "just", "let's", "like", "maybe", "me", "my", "no", "not", "now", "of", "on", "or", "our",
    "please", "probably", "really", "she", "should", "so", "some", "soon", "still", "than", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too",
    "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "why", "with", "would", "yes", "you", "your",
];

pub fn fit_to_cursor(text: &str, before: &str, after: &str) -> String {
    let body = text.trim();
    if body.is_empty() {
        return text.to_string();
    }
    let Some(previous) = before.chars().last() else {
        // Start of the field: nothing to fit to.
        return text.to_string();
    };
    let last_visible = before
        .chars()
        .rev()
        .filter(|ch| !ch.is_whitespace())
        .find(|ch| !CLOSERS.contains(ch));
    let mid_sentence = matches!(
        last_visible,
        Some(ch) if ch.is_alphanumeric() || MID_SENTENCE_PUNCT.contains(&ch)
    ) && !before.ends_with('\n');

    let mut fitted = body.to_string();
    if mid_sentence {
        fitted = lowercase_first_word(&fitted);
    }

    // The caret often sits before a space ("I think| we should go") or a
    // comma, so look past spaces on this line for what follows.
    let next = after.chars().next();
    let next_visible = after.chars().find(|ch| *ch == '\n' || !ch.is_whitespace());
    let sentence_continues = matches!(
        next_visible,
        Some(ch) if ch.is_alphanumeric() || matches!(ch, ',' | ';' | ':' | '.' | '!' | '?' | ')')
    );
    if sentence_continues && mid_sentence && fitted.ends_with('.') && !fitted.ends_with("..") {
        fitted.pop();
    }

    // Chinese, Japanese and Thai put no spaces between words.
    let first = fitted.chars().next();
    let starts_with_word = first.is_some_and(char::is_alphanumeric);
    if starts_with_word
        && !previous.is_whitespace()
        && !NO_SPACE_AFTER.contains(&previous)
        && !is_spaceless_script(previous)
        && !first.is_some_and(is_spaceless_script)
    {
        fitted.insert(0, ' ');
    }
    let more_follows = matches!(next, Some(ch) if ch.is_alphanumeric());
    let last = fitted.chars().last();
    if more_follows
        && !fitted.ends_with(char::is_whitespace)
        && !next.is_some_and(is_spaceless_script)
        && !last.is_some_and(is_spaceless_script)
    {
        fitted.push(' ');
    }
    fitted
}

fn is_spaceless_script(ch: char) -> bool {
    matches!(
        ch as u32,
        0x0E00..=0x0E7F // Thai
            | 0x3000..=0x30FF // CJK punctuation, Hiragana, Katakana
            | 0x3400..=0x4DBF // CJK Extension A
            | 0x4E00..=0x9FFF // CJK Unified Ideographs
            | 0xF900..=0xFAFF // CJK Compatibility Ideographs
            | 0xFF00..=0xFFEF // Full-width forms
    )
}

fn lowercase_first_word(text: &str) -> String {
    let end = text
        .char_indices()
        .find(|(_, ch)| ch.is_whitespace())
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    let (word, rest) = text.split_at(end);
    let bare = word
        .trim_end_matches(|ch: char| !ch.is_alphanumeric())
        .replace('\u{2019}', "'");
    // Only a plainly capitalized common word: "We", not "WE" or "Sarah".
    let mut chars = bare.chars();
    let plainly_capitalized = chars.next().is_some_and(char::is_uppercase)
        && chars.all(|ch| !ch.is_alphabetic() || ch.is_lowercase());
    if !plainly_capitalized || !LOWERCASE_WHEN_CONTINUING.contains(&bare.to_lowercase().as_str()) {
        return text.to_string();
    }
    let mut first = word.chars();
    let head = first
        .next()
        .map(|ch| ch.to_lowercase().to_string())
        .unwrap_or_default();
    format!("{}{}{}", head, first.as_str(), rest)
}

#[cfg(test)]
mod tests {
    use super::fit_to_cursor;

    #[test]
    fn continues_a_sentence_in_place() {
        assert_eq!(
            fit_to_cursor("We should go.", "I think", ""),
            " we should go."
        );
        assert_eq!(
            fit_to_cursor("We should go.", "I think ", ""),
            "we should go."
        );
        assert_eq!(
            fit_to_cursor("Really soon.", "we should ", "go to lunch"),
            "really soon "
        );
    }

    #[test]
    fn leaves_a_new_sentence_or_an_empty_field_alone() {
        assert_eq!(fit_to_cursor("We should go.", "", ""), "We should go.");
        assert_eq!(
            fit_to_cursor("We should go.", "Done.", ""),
            " We should go."
        );
        assert_eq!(
            fit_to_cursor("We should go.", "Done. ", ""),
            "We should go."
        );
        assert_eq!(fit_to_cursor("We should go.", "Hi,\n", ""), "We should go.");
    }

    #[test]
    fn keeps_names_acronyms_and_i() {
        assert_eq!(fit_to_cursor("I agree.", "honestly", ""), " I agree.");
        assert_eq!(fit_to_cursor("I'm in.", "ok ", ""), "I'm in.");
        assert_eq!(fit_to_cursor("NASA called.", "so ", ""), "NASA called.");
        assert_eq!(fit_to_cursor("iPhone sales.", "the ", ""), "iPhone sales.");
    }

    #[test]
    fn needs_no_space_after_an_opening_bracket_or_quote() {
        assert_eq!(
            fit_to_cursor("The one above.", "note (", ")"),
            "the one above"
        );
        // Not a common word, so it keeps its capital.
        assert_eq!(fit_to_cursor("Hello", "he said \u{201C}", ""), "Hello");
    }

    #[test]
    fn keeps_names_weekdays_and_places_capitalized() {
        assert_eq!(
            fit_to_cursor("Sarah tomorrow.", "I'll send it to ", ""),
            "Sarah tomorrow."
        );
        assert_eq!(fit_to_cursor("Monday works.", "so ", ""), "Monday works.");
        assert_eq!(
            fit_to_cursor("Paris next week.", "we fly to ", ""),
            "Paris next week."
        );
    }

    #[test]
    fn keeps_will_capitalized_as_a_name() {
        assert_eq!(
            fit_to_cursor("Will is coming.", "and ", ""),
            "Will is coming."
        );
    }

    #[test]
    fn looks_past_a_space_or_comma_after_the_caret() {
        assert_eq!(
            fit_to_cursor("Really soon.", "I think", " we should go"),
            " really soon"
        );
        assert_eq!(
            fit_to_cursor("We should go.", "if ", ", then"),
            "we should go"
        );
        // A new line after the caret ends the sentence.
        assert_eq!(fit_to_cursor("We go.", "so ", "\nNext"), "we go.");
    }

    #[test]
    fn a_closing_quote_or_emoji_does_not_continue_a_sentence() {
        assert_eq!(
            fit_to_cursor("We start.", "He said \"Done.\" ", ""),
            "We start."
        );
        assert_eq!(fit_to_cursor("We start.", "(see above.) ", ""), "We start.");
        assert_eq!(fit_to_cursor("We won.", "Great \u{1F389} ", ""), "We won.");
        assert_eq!(fit_to_cursor("The rest.", "(see above) ", ""), "the rest.");
    }

    #[test]
    fn adds_no_spaces_between_chinese_or_japanese_words() {
        assert_eq!(fit_to_cursor("你好", "我喜欢", "朋友"), "你好");
        assert_eq!(fit_to_cursor("ありがとう", "本当に", ""), "ありがとう");
        assert_eq!(fit_to_cursor("你好", "我说。", ""), "你好");
    }

    #[test]
    fn keeps_an_ellipsis_and_empty_text() {
        assert_eq!(fit_to_cursor("Wait...", "and ", "then"), "Wait... ");
        assert_eq!(fit_to_cursor("   ", "and ", ""), "   ");
    }
}
