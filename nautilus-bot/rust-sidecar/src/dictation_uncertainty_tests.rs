use super::validate_cleanup;

#[test]
fn rejects_detached_or_joined_uncertainty_qualifiers() {
    for (source, candidate) in [
        ("Maybe we ship Friday.", "Maybe. We ship Friday."),
        ("Perhaps we ship Friday.", "Perhaps! We ship Friday."),
        ("Probably we ship Friday.", "Probably; we ship Friday."),
        ("Possibly we ship Friday.", "Possibly\nwe ship Friday."),
        ("Maybe. We ship Friday.", "Maybe we ship Friday."),
        ("Perhaps! We ship Friday.", "Perhaps we ship Friday."),
        ("Probably; we ship Friday.", "Probably we ship Friday."),
        ("Possibly\nwe ship Friday.", "Possibly we ship Friday."),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn rejects_strong_split_inside_comma_linked_uncertainty_qualifier() {
    for marker in ["Maybe", "Perhaps", "Probably", "Possibly"] {
        let source = format!("{marker} legal, finance and ops approve, we ship Friday.");
        let candidate = format!("{marker} legal, finance. And ops approve, we ship Friday.");
        assert!(
            validate_cleanup(&source, &candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn allows_uncertainty_capitalization_commas_and_independent_punctuation() {
    for (source, candidate) in [
        ("maybe we ship Friday", "Maybe we ship Friday."),
        ("perhaps we ship Friday", "Perhaps, we ship Friday."),
        (
            "probably we ship Friday we should review the budget",
            "Probably we ship Friday. We should review the budget.",
        ),
        (
            "possibly, we ship Friday we should review the budget",
            "Possibly, we ship Friday. We should review the budget!",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn ignores_quoted_uncertainty_words_for_boundary_checks() {
    for marker in ["maybe", "perhaps", "probably", "possibly"] {
        let source = format!("Say \"{marker}\" then wait.");
        let candidate = format!("Say \"{marker}\". Then wait.");
        assert!(
            validate_cleanup(&source, &candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn preserves_explicit_first_person_hedge_clause_boundaries() {
    for (source, candidate) in [
        (
            "I think we should send the checklist on Friday.",
            "I think. We should send the checklist on Friday.",
        ),
        (
            "I think Dana will send the checklist.",
            "I think. Dana will send the checklist.",
        ),
        (
            "We guess Dana will send the checklist.",
            "We. Guess Dana will send the checklist.",
        ),
        ("I think about the budget.", "I think. About the budget."),
        (
            "I guess we should send the checklist on Friday.",
            "I guess; we should send the checklist on Friday.",
        ),
        (
            "We think the checklist is ready.",
            "We. Think the checklist is ready.",
        ),
        (
            "We guess that it will cost 2.5 dollars.",
            "We guess that it will cost. 2.5 dollars.",
        ),
        (
            "I think we should send the checklist on Friday.",
            "I think we should send. The checklist on Friday.",
        ),
        (
            "I think, we should send the checklist on Friday.",
            "I think\nwe should send the checklist on Friday.",
        ),
        (
            "I think that legal, finance and ops approve, we ship Friday.",
            "I think that legal, finance. And ops approve, we ship Friday.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
        assert!(
            validate_cleanup(candidate, source).is_err(),
            "{candidate} -> {source}"
        );
    }
}

#[test]
fn allows_first_person_hedge_cleanup_and_unrelated_thinking() {
    for (source, candidate) in [
        (
            "We can test tomorrow I think we should ship Friday",
            "We can test tomorrow. I think we should ship Friday.",
        ),
        (
            "We can test tomorrow I think we should ship Friday.",
            "We can test tomorrow. I think we should ship Friday.",
        ),
        (
            "Say \"ready\" I think we should ship Friday.",
            "Say \"ready\". I think we should ship Friday.",
        ),
        (
            "i think we should send the checklist",
            "I think, we should send the checklist.",
        ),
        (
            "I guess it will cost 2.5 dollars.",
            "I guess, it will cost 2.5 dollars!",
        ),
        (
            "I think. Dana will send the checklist.",
            "I think. Dana will send the checklist!",
        ),
        (
            "I think. We should send the checklist.",
            "I think. We should send the checklist!",
        ),
        (
            "I think we should send the checklist. We can test tomorrow we can share results",
            "I think we should send the checklist. We can test tomorrow. We can share results.",
        ),
        (
            "i think we ship Friday we should review the budget",
            "I think we ship Friday. We should review the budget.",
        ),
        (
            "Think carefully then send the checklist.",
            "Think carefully. Then send the checklist.",
        ),
        (
            "I think about the budget then take a walk.",
            "I think about the budget. Then take a walk.",
        ),
        (
            "Say \"I think we ship Friday\" then wait.",
            "Say \"I think we ship Friday\". Then wait.",
        ),
        (
            "Type `we guess that it works` then wait.",
            "Type `we guess that it works`. Then wait.",
        ),
        (
            "I think we need twenty five copies.",
            "I think we need twenty-five copies.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}
