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

/// Characters that end a sentence, so what follows starts one.
const SENTENCE_END: &[char] = &['.', '!', '?', ':', '\u{2026}'];

/// The only words lowercased mid-sentence: function words and common
/// openers that are never names. A closed list, because the recognizer
/// capitalizes names too and nothing here can tell them apart.
const LOWERCASE_WHEN_CONTINUING: &[&str] = &[
    "a", "about", "actually", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be",
    "because", "before", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had",
    "has", "have", "he", "her", "here", "his", "how", "if", "in", "into", "is", "it", "its",
    "just", "let's", "like", "maybe", "me", "my", "no", "not", "now", "of", "on", "or", "our",
    "please", "probably", "really", "she", "should", "so", "some", "soon", "still", "than", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too",
    "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "why", "will", "with", "would", "yes", "you", "your",
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
    let last_visible = before.chars().rev().find(|ch| !ch.is_whitespace());
    let mid_sentence =
        matches!(last_visible, Some(ch) if !SENTENCE_END.contains(&ch)) && !before.ends_with('\n');

    let mut fitted = body.to_string();
    if mid_sentence {
        fitted = lowercase_first_word(&fitted);
    }

    let next = after.chars().next();
    let more_follows = matches!(next, Some(ch) if ch.is_alphanumeric());
    if more_follows && mid_sentence && fitted.ends_with('.') && !fitted.ends_with("..") {
        fitted.pop();
    }

    let starts_with_word = fitted.chars().next().is_some_and(|ch| ch.is_alphanumeric());
    if starts_with_word && !previous.is_whitespace() && !NO_SPACE_AFTER.contains(&previous) {
        fitted.insert(0, ' ');
    }
    if more_follows && !fitted.ends_with(char::is_whitespace) {
        fitted.push(' ');
    }
    fitted
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
            "the one above."
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
    fn keeps_an_ellipsis_and_empty_text() {
        assert_eq!(fit_to_cursor("Wait...", "and ", "then"), "Wait... ");
        assert_eq!(fit_to_cursor("   ", "and ", ""), "   ");
    }
}
