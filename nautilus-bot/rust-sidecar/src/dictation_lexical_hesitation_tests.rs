use crate::dictation_cleanup::{clean_disfluencies, strip_hesitations_only};
use crate::dictation_fidelity::validate_cleanup;

fn assert_cleanup_preserves(source: &str) {
    assert_eq!(
        clean_disfluencies(source),
        source,
        "full cleanup changed {source:?}"
    );
    assert_eq!(
        strip_hesitations_only(source),
        source,
        "hesitation-only cleanup changed {source:?}",
    );
}

#[test]
fn lexical_hesitation_phrases_keep_their_meaning() {
    for source in [
        "Uh huh, I agree.",
        "Uh oh, the server is down.",
        "Uh uh, I disagree.",
        "Uh uh.",
        "(Uh uh.)",
        "(Uh huh, I agree.)",
        "(Uh oh, the server is down.)",
        "I said uh huh yesterday.",
        "That was uh oh territory.",
        "My answer is uh uh, absolutely not.",
        "Uh-huh, I agree.",
        "Uh-oh, the server is down.",
        "Uh-uh, I disagree.",
    ] {
        assert_cleanup_preserves(source);
    }
}

#[test]
fn an_ordinary_standalone_hesitation_is_still_removed() {
    assert_eq!(clean_disfluencies("Uh, I agree."), "I agree.");
    assert_eq!(strip_hesitations_only("Uh, I agree."), "I agree.");
}

#[test]
fn sentence_and_line_boundaries_do_not_form_lexical_pairs() {
    assert_eq!(clean_disfluencies("Uh. Huh, I agree."), "Huh, I agree.");
    assert_eq!(strip_hesitations_only("Uh. Huh, I agree."), "Huh, I agree.");
    assert_eq!(clean_disfluencies("Uh.\nOh, I see."), "Oh, I see.");
    assert_eq!(strip_hesitations_only("Uh.\nOh, I see."), "Oh, I see.");
    assert_eq!(clean_disfluencies("Uh.\nUh, I disagree."), "I disagree.");
    assert_eq!(
        strip_hesitations_only("Uh.\nUh, I disagree."),
        "I disagree."
    );
}

#[test]
fn fidelity_rejects_dropping_a_lexical_hesitation_phrase() {
    for (source, candidate) in [
        ("Uh huh, I agree.", "Huh, I agree."),
        ("Uh oh, the server is down.", "Oh, the server is down."),
        ("Uh uh, I disagree.", "I disagree."),
        ("Uh uh.", ""),
        ("(Uh uh.)", "(Uh.)"),
    ] {
        assert_eq!(
            validate_cleanup(source, candidate),
            Err("AI cleanup changed, added, reordered, or omitted dictated words".to_string()),
            "fidelity accepted {candidate:?} for {source:?}",
        );
    }
}

#[test]
fn fidelity_accepts_preserved_phrases_and_normal_filler_removal() {
    for source in [
        "Uh huh, I agree.",
        "Uh oh, the server is down.",
        "Uh uh, I disagree.",
        "Uh uh.",
    ] {
        assert_eq!(
            validate_cleanup(source, source),
            Ok(()),
            "rejected {source:?}"
        );
    }
    assert_eq!(validate_cleanup("Uh, I agree.", "I agree."), Ok(()));
}
