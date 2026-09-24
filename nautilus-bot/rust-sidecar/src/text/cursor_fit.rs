//! Fitting a dictation to the text already around the cursor.
//!
//! Dictating into the middle of a sentence ("I think |we should go") must not
//! paste "I thinkWe should go." with a capital, no space and a full stop in
//! the middle. Wispr Flow matches casing and spacing to the surrounding text;
//! this does the same from the characters right before and after the caret,
//! which the macOS insertion path reads through Accessibility and never
//! stores.
//!
//! Conservative by design: it only adds a separating space, lowercases a
//! plainly capitalized first word when the sentence is still going, and drops
//! a trailing full stop when more of the sentence follows. "I", acronyms and
//! mixed-case words (iPhone, McDonald) keep their casing.

/// Characters after which a word needs no space before it.
const NO_SPACE_AFTER: &[char] = &[
    '(', '[', '{', '"', '\'', '\u{201C}', '\u{2018}', '/', '-', '\u{2014}', '@', '#',
];

/// Characters that end a sentence, so what follows starts one.
const SENTENCE_END: &[char] = &['.', '!', '?', ':', '\u{2026}'];

const KEEP_CAPITALIZED: &[&str] = &[
    "I",
    "I'm",
    "I've",
    "I'll",
    "I'd",
    "I\u{2019}m",
    "I\u{2019}ve",
    "I\u{2019}ll",
    "I\u{2019}d",
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
    let bare = word.trim_end_matches(|ch: char| !ch.is_alphanumeric());
    if KEEP_CAPITALIZED.contains(&bare) {
        return text.to_string();
    }
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return text.to_string();
    };
    // Only a plainly capitalized word: an uppercase letter followed by
    // lowercase letters. Acronyms (NASA) and mixed case (iPhone, McDonald)
    // are names, and keep their casing.
    let tail_plain = chars
        .clone()
        .filter(|ch| ch.is_alphabetic())
        .all(|ch| ch.is_lowercase());
    let has_tail = chars.clone().any(|ch| ch.is_alphabetic());
    if !first.is_uppercase() || !has_tail || !tail_plain {
        return text.to_string();
    }
    format!("{}{}{}", first.to_lowercase(), chars.as_str(), rest)
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
        assert_eq!(fit_to_cursor("See above.", "note (", ")"), "see above.");
        assert_eq!(fit_to_cursor("Hello", "he said \u{201C}", ""), "hello");
    }

    #[test]
    fn keeps_an_ellipsis_and_empty_text() {
        assert_eq!(fit_to_cursor("Wait...", "and ", "then"), "wait... ");
        assert_eq!(fit_to_cursor("   ", "and ", ""), "   ");
    }
}
