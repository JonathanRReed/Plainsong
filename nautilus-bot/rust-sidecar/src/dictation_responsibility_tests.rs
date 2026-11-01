use super::validate_responsibility_promotions as validate;

#[test]
fn rejects_local_promotions_without_borrowing_authority() {
    for (source, candidate) in [
        (
            "I handle user interface design.",
            "I manage user interface design.",
        ),
        (
            "I manage the team and handle user interface design.",
            "I manage the team and manage user interface design.",
        ),
        (
            "Alice manages user interface design. I handle user interface design.",
            "I manage user interface design.",
        ),
        (
            "I am a manager. I review user interface design.",
            "I manage user interface design.",
        ),
        (
            "\"I manage user interface design\". I handle user interface design.",
            "I manage user interface design.",
        ),
        (
            "I manage user interface design, no wait, review user interface design.",
            "I manage user interface design.",
        ),
    ] {
        assert!(
            validate(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn retains_existing_authority_and_allows_unpromoted_duties() {
    for (source, candidate) in [
        (
            "I manage the team and handle user interface design.",
            "I manage the team and handle user interface design.",
        ),
        (
            "I manage the user interface design and review user interface design.",
            "I manage user interface design and review user interface design.",
        ),
        (
            "I deal with user interface design.",
            "My work includes user interface design.",
        ),
        (
            "I can manage the team and handle user interface design.",
            "I can manage the team and handle user interface design.",
        ),
        (
            "Would I handle user interface design?",
            "Would I handle user interface design?",
        ),
    ] {
        assert!(
            validate(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn frozen_designer_output_rejects_managing_and_retains_dealing() {
    let source = "Yeah, I'm Janvi. I'm my role is industrial designer, and my responsibilities are. Uh, deal with the technical functional designs and specifications of user interface and dealing with user interface design.";
    let promoted = "I am Janvi, an industrial designer. My responsibilities include handling the technical functional designs and specifications for the user interface, as well as managing user interface design.";
    let retained = "I am Jan V. My role is an industrial designer, and my responsibilities are to deal with the technical functional designs and specifications of the user interface and to deal with user interface design.";
    assert!(validate(source, promoted).is_err());
    assert!(validate(source, retained).is_ok());
}

#[test]
fn binds_possessive_owners_before_authorizing_existing_authority() {
    assert!(validate(
        "My responsibilities include reviewing user interface design. Her responsibilities include managing user interface design.",
        "My responsibilities include managing user interface design."
    ).is_err());
    assert!(validate(
        "My responsibilities include reviewing user interface design. My responsibilities include managing the user interface design.",
        "My responsibilities include reviewing user interface design. My responsibilities include managing user interface design."
    ).is_ok());
}

#[test]
fn preserves_exact_identity_with_a_correction_cue() {
    let source = "I manage user interface design, no wait, review user interface design.";
    assert!(validate(source, source).is_ok());
}

#[test]
fn does_not_carry_ownership_through_an_unparsed_clause() {
    assert!(validate(
        "I manage the team and Alice is responsible for UI design and manages UI design. I handle UI design.",
        "I manage UI design."
    ).is_err());
}

#[test]
fn preserves_negative_authority_without_authorizing_a_positive_claim() {
    let source = "I review UI design. I do not manage UI design.";
    assert!(validate(source, "I review the UI design. I do not manage UI design.").is_ok());
    assert!(validate(source, "I manage UI design.").is_err());
}

#[test]
fn preserves_explicit_named_clauses_without_borrowing_their_authority() {
    let source = "Alice manages UI design. I review UI design.";
    assert!(validate(source, "Alice manages the UI design. I review UI design.").is_ok());
    assert!(validate(source, "I manage UI design.").is_err());
}

#[test]
fn does_not_authorize_assertions_from_questions() {
    assert!(validate(
        "I review UI design. My responsibilities include managing UI design?",
        "My responsibilities include managing UI design."
    )
    .is_err());
}

#[test]
fn resolves_only_adjacent_same_owner_same_object_corrections() {
    for separator in [", no wait, ", " no wait "] {
        let forward = format!("I review UI design{separator}manage UI design.");
        let reverse = format!("I manage UI design{separator}review UI design.");
        assert!(validate(&forward, "I manage UI design.").is_ok());
        assert!(validate(&reverse, "I manage UI design.").is_err());
    }
    for source in [
        "I review UI design, no wait, manage the team.",
        "I review UI design no wait she manages UI design.",
        "I review UI design, no wait, Alice is responsible for design and manages UI design.",
    ] {
        assert!(validate(source, "I manage UI design.").is_err());
    }
}

#[test]
fn canonicalizes_negative_contractions_without_lending_positive_authority() {
    let source = "I review UI design. I don't manage UI design.";
    assert!(validate(source, "I review the UI design. I do not manage UI design.").is_ok());
    assert!(validate(source, "I manage UI design.").is_err());
}
