//! Deterministic safeguards for automatic dictation cleanup.
//! Explicit rewrite commands and translation use their own paths.

pub(crate) const CLEANUP_INSTRUCTION: &str =
    "Preserve the speaker's words and their order. Keep numbered-list labels and item breaks, \
     including lists starting above one. Do not renumber or summarize.";

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
    Ok(())
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
}
