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
}
