//! Deterministic safeguards for automatic dictation cleanup.
//! Explicit rewrite commands and translation use their own paths.

pub(crate) const CLEANUP_INSTRUCTION: &str =
    "Preserve the speaker's words and their order. Keep numbered-list labels and item breaks, \
     including lists starting above one. Do not renumber or summarize. Never drop, add, or move \
     negation (not, never, haven't), conditions, technical terms, or short answers. Only change \
     punctuation, capitalization, and unambiguous contraction spelling. Explicit rewrite commands \
     are separate from automatic cleanup. Keep intentional 'like' and ambiguous er/err/erm \
     repair cues. Only isolated um/uh hesitation sounds may be removed; keep quoted words and acronyms.";

pub(crate) fn numbered_list_markers(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let digits = line.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            let mut suffix = line[digits..].chars();
            (matches!(suffix.next(), Some('.' | ')'))
                && suffix.next().is_some_and(char::is_whitespace))
            .then_some(&line[..digits])
        })
        .collect()
}

/// Fail closed to the pre-AI pipeline text, never to a guessed repair.
/// Error messages contain no transcript or dictionary content.
pub(crate) fn validate_cleanup(source: &str, candidate: &str) -> Result<(), String> {
    if numbered_list_markers(source) != numbered_list_markers(candidate) {
        return Err("AI cleanup changed numbered-list labels or item breaks".to_string());
    }
    if content_tokens(source) != content_tokens(candidate) {
        return Err("AI cleanup changed, added, reordered, or omitted dictated words".to_string());
    }
    Ok(())
}

/// Compare ordered words, not a word-count ratio or a bag of negations: moving
/// "not" to another clause is just as dangerous as dropping it. This is a
/// conservative cleanup contract, not a semantic-equivalence classifier.
fn content_tokens(text: &str) -> Vec<String> {
    let normalized = strip_optional_disfluencies(text)
        .replace(['’', '‘'], "'")
        .to_lowercase();
    normalized
        .split(|ch: char| !ch.is_alphanumeric() && ch != '\'' && ch != '_')
        .map(|word| word.trim_matches('\''))
        .filter(|word| !word.is_empty())
        .flat_map(|word| {
            let expansion = match word {
                "can't" | "cannot" => "can not",
                "won't" => "will not",
                "shan't" => "shall not",
                "isn't" => "is not",
                "aren't" => "are not",
                "wasn't" => "was not",
                "weren't" => "were not",
                "don't" => "do not",
                "doesn't" => "does not",
                "didn't" => "did not",
                "haven't" => "have not",
                "hasn't" => "has not",
                "hadn't" => "had not",
                "couldn't" => "could not",
                "wouldn't" => "would not",
                "shouldn't" => "should not",
                "mustn't" => "must not",
                "needn't" => "need not",
                _ => word,
            };
            if expansion != word {
                return expansion
                    .split_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>();
            }
            for (suffix, expanded) in [
                ("'m", "am"),
                ("'re", "are"),
                ("'ve", "have"),
                ("'ll", "will"),
            ] {
                if let Some(subject) = word
                    .strip_suffix(suffix)
                    .filter(|subject| !subject.is_empty())
                {
                    return vec![subject.to_string(), expanded.to_string()];
                }
            }
            vec![word.to_string()]
        })
        .collect()
}

/// Optional hesitation cleanup, not a stop-word list. Preserve discourse words
/// (especially "like"), repair cues, acronyms, quoted words and line breaks.
pub(crate) fn strip_optional_disfluencies(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for piece in text.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end().trim_end_matches([',', '.', '!', '?']);
        if matches!(
            word,
            "um" | "Um" | "umm" | "Umm" | "uh" | "Uh" | "uhh" | "Uhh"
        ) {
            output.extend(piece.chars().filter(|ch| matches!(ch, '\n' | '\r')));
        } else {
            output.push_str(piece);
        }
    }
    output.trim().to_string()
}

/// Resolve only a punctuated, single-word repair within this utterance.
pub(crate) fn resolve_spoken_repairs(text: &str) -> String {
    // Commas on both sides distinguish a repair cue from "to err" or ER.
    // A one-word replacement must end a clause: multi-word/ambiguous repairs
    // remain visible rather than guessing how much earlier text to delete.
    let mut markers: Vec<_> = [", er, ", ", err, ", ", erm, "]
        .into_iter()
        .flat_map(|marker| {
            text.match_indices(marker)
                .map(|(at, value)| (at, value.len()))
        })
        .collect();
    markers.sort_unstable();
    let mut output = String::with_capacity(text.len());
    let mut copied_until = 0;
    for (at, marker_len) in markers {
        let left = &text[..at];
        let word_start = left
            .char_indices()
            .rev()
            .find(|(_, ch)| !ch.is_alphabetic())
            .map_or(0, |(index, ch)| index + ch.len_utf8());
        let replacement_start = at + marker_len;
        let right = &text[replacement_start..];
        let word_end = right
            .char_indices()
            .find(|(_, ch)| !ch.is_alphabetic())
            .map_or(right.len(), |(index, _)| index);
        let terminator = right[word_end..]
            .trim_start_matches([' ', '\t'])
            .chars()
            .next();
        if word_start == at
            || word_end == 0
            || word_start < copied_until
            || !matches!(terminator, None | Some('.' | '!' | '?' | '\n' | '\r'))
        {
            continue;
        }
        // Never repair a suffix of a hyphenated word, identifier, or quotation.
        if word_start > 0 && !text[..word_start].ends_with(char::is_whitespace) {
            continue;
        }
        output.push_str(&text[copied_until..word_start]);
        copied_until = replacement_start;
    }
    output.push_str(&text[copied_until..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_labels_include_resumed_zero_and_nested_lists() {
        assert_eq!(
            numbered_list_markers("5. review\n6. ship\n  0) subitem"),
            vec!["5", "6", "0"]
        );
        assert!(numbered_list_markers("version 3.14\n3.14 seconds").is_empty());
    }

    #[test]
    fn cleanup_rejects_renumbering_and_flattened_list_items() {
        let source = "5. Review.\n6. Ship.";
        assert!(validate_cleanup(source, "1. Review.\n2. Ship.").is_err());
        assert!(validate_cleanup(source, "5. Review. 6. Ship.").is_err());
        assert!(validate_cleanup(source, "5) Review.\n6) Ship.").is_ok());
    }
    #[test]
    fn explicit_er_repairs_replace_the_reparandum_not_with_or() {
        for marker in ["er", "err", "erm"] {
            let input = format!("I want the color to be orange, {marker}, yellow.");
            assert_eq!(
                resolve_spoken_repairs(&input),
                "I want the color to be yellow."
            );
        }
        assert_eq!(resolve_spoken_repairs("orange, err, yellow"), "yellow");
    }

    #[test]
    fn ambiguous_repairs_and_real_alternatives_are_preserved() {
        for text in [
            "orange or yellow",
            "to err is human",
            "the ER, yellow ward",
            "orange, err, pale yellow",
            "orange er yellow",
            "orange, err,",
            "orange, ER, yellow.",
            "say orange, err, yellow again",
        ] {
            assert_eq!(resolve_spoken_repairs(text), text);
        }
    }
    #[test]
    fn cleanup_cannot_drop_add_or_move_negation() {
        for (source, candidate) in [
            ("I'd prefer to never merge this", "I'd prefer to merge this"),
            ("Do not deploy", "Do deploy"),
            ("I haven't approved this", "I have approved this"),
            ("I haven’t approved this", "I have approved this"),
            ("Do merge this", "Do not merge this"),
            (
                "Do not merge this. Do deploy that.",
                "Do merge this. Do not deploy that.",
            ),
            ("Merge only after review", "Merge after review"),
            ("Fix auth", "Fix off"),
        ] {
            assert!(
                validate_cleanup(source, candidate).is_err(),
                "{source} => {candidate}"
            );
        }
    }

    #[test]
    fn cleanup_allows_punctuation_case_and_unambiguous_contractions() {
        for (source, candidate) in [
            ("i haven't approved this", "I have not approved this."),
            ("I haven’t approved this", "I haven't approved this."),
            ("we can't merge", "We cannot merge."),
            ("it won't merge", "It will not merge."),
            ("we're ready", "We are ready."),
            ("hello world", "Hello, world!"),
        ] {
            assert!(
                validate_cleanup(source, candidate).is_ok(),
                "{source} => {candidate}"
            );
        }
    }
    #[test]
    fn cleanup_preserves_like_but_can_remove_isolated_hesitation_sounds() {
        assert!(validate_cleanup("I, like, agree", "I agree").is_err());
        assert!(validate_cleanup("I like it. Like, really.", "I like it, really.").is_err());
        assert!(validate_cleanup("Um, I, like, agree.", "I, like, agree.").is_ok());
        assert!(validate_cleanup("UM and ER", "and ER").is_err());
        assert!(validate_cleanup("Say 'um'", "Say").is_err());
        assert!(validate_cleanup("Ah, now I see", "Now I see").is_err());
    }
    #[test]
    fn cleanup_rejects_missing_middle_tail_and_repeated_answers_at_any_length() {
        let source = (0..150)
            .map(|i| format!("Answer {i}: A. Agreed. Agreed. Keep this context.\n"))
            .collect::<String>();
        assert!(validate_cleanup(&source, &source).is_ok());
        assert!(validate_cleanup(&source, &source[..source.len() / 2]).is_err());
        assert!(validate_cleanup(&source, &source.replacen("Agreed. ", "", 1)).is_err());
        assert!(validate_cleanup("A. A. A.", "A.").is_err());
        assert!(validate_cleanup("Agreed", "").is_err());
        assert!(validate_cleanup("A", "").is_err());
    }
}
