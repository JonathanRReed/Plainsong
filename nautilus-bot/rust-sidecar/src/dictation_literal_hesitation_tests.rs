use super::*;

#[test]
fn hesitation_stripping_keeps_words_inside_quoted_and_unclosed_text() {
    for text in [
        "The caption reads \"pause um here\" before the demo.",
        "Maya wrote “call uh before noon” in the note.",
        "The draft begins \"leave um in the final paragraph",
    ] {
        assert_eq!(strip_optional_disfluencies(text), text, "{text}");
    }
}

#[test]
fn hesitation_stripping_keeps_words_inside_inline_and_fenced_code() {
    for text in [
        "Use `deploy um staging` in the rehearsal script.",
        "The runbook contains:\n```shell\nuh deploy staging\n```\nReview it first.",
    ] {
        assert_eq!(strip_optional_disfluencies(text), text, "{text}");
    }
}

#[test]
fn cleanup_rejects_dropping_hesitations_from_unmarked_literal_text() {
    for (source, candidate) in [
        (
            "The transcript says \"press um now\" before the chime.",
            "The transcript says \"press now\" before the chime.",
        ),
        (
            "Maya wrote “call uh before noon” in the note.",
            "Maya wrote “call before noon” in the note.",
        ),
        (
            "Use `deploy um staging` in the rehearsal script.",
            "Use `deploy staging` in the rehearsal script.",
        ),
        (
            "The draft begins \"leave uh in the final paragraph",
            "The draft begins \"leave in the final paragraph",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn hesitation_only_cleanup_leaves_stutters_and_spoken_corrections_visible() {
    let source = "Um, bring the the deck Tuesday, no wait, Wednesday. Uh, confirm with Maya.";
    let expected = "Bring the the deck Tuesday, no wait, Wednesday. Confirm with Maya.";

    assert_eq!(
        crate::dictation_cleanup::strip_hesitations_only(source),
        expected
    );
    assert!(validate_cleanup(source, expected).is_ok());
}
