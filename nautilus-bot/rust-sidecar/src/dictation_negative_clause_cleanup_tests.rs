use super::*;

#[test]
fn repeated_boundary_positions_preserve_identity_and_expose_role_changes() {
    let source = "Ask Mr. ’ ! Smith for the records.";
    assert!(validate_cleanup(source, source).is_ok());
    assert!(validate_cleanup(source, "Ask Mr! ’ ! Smith for the records.").is_err());
    assert!(validate_cleanup("Ask Mr! ’ ! Smith for the records.", source).is_err());
    assert!(validate_cleanup(source, "Ask Mr. ’ ; Smith for the records.").is_ok());
    for (source, candidate) in [
        ("Ask Mr. ’ Smith", "Ask Mr. ’ ! Smith"),
        ("Ask Mr. ’ ! Smith", "Ask Mr ’ ! Smith"),
    ] {
        assert!(validate_cleanup(source, candidate).is_err());
        assert!(validate_cleanup(candidate, source).is_err());
    }
}

#[test]
fn ambiguous_single_letter_separator_roles_retain_the_source() {
    for (source, candidate) in [
        ("Option A: buy it", "Option A. Buy it."),
        ("Plan B; then review", "Plan B. Then review."),
    ] {
        assert!(validate_cleanup(source, candidate).is_err());
        assert!(validate_cleanup(candidate, source).is_err());
    }
}

#[test]
fn lexical_abbreviation_dots_cannot_become_statement_separators() {
    for (source, candidate) in [
        (
            "Do not delete Mr. Smith's records you will need.",
            "Do not delete Mr! Smith's records you will need.",
        ),
        (
            "If Dr. Smith approves keep the records.",
            "If Dr; Smith approves keep the records.",
        ),
        (
            "Maybe Dr. Smith approves the prototype tomorrow.",
            "Maybe Dr: Smith approves the prototype tomorrow.",
        ),
        (
            "Ask Mr. Smith for the records.",
            "Ask Mr! Smith for the records.",
        ),
        (
            "Do not delete the 9 a.m. recordings you will need.",
            "Do not delete the 9 a.m! recordings you will need.",
        ),
        (
            "Do not release U.S. records until review.",
            "Do not release U.S! records until review.",
        ),
        (
            "Do not delete Mr. Smith's records you will need.",
            "Do not delete Mr.! Smith's records you will need.",
        ),
        (
            "Ask Mr. Smith for the records.",
            "Ask Mr.. Smith for the records.",
        ),
        (
            "Ask Mr. Smith for the records.",
            "Ask Mr.\nSmith for the records.",
        ),
        (
            "Ask Mr. Smith for the records.",
            "Ask Mr.! Smith for the records.",
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
        assert!(
            finish_cleanup(source, candidate).is_err(),
            "finish: {source} -> {candidate}"
        );
    }
}

#[test]
fn lexical_boundary_roles_keep_ordinary_cleanup_editable() {
    for (source, candidate) in [
        (
            "ask dr. smith and mr. jones for the u.s. records at 9 a.m. tomorrow",
            "Ask Dr. Smith and Mr. Jones for the U.S. records at 9 a.m. tomorrow.",
        ),
        (
            "Ask Mr. Smith. keep the records",
            "Ask Mr. Smith! Keep the records.",
        ),
        ("Call the Dr.", "Call the Dr!"),
        (
            "Review the records at 9 a.m.",
            "Review the records at 9 a.m!",
        ),
        (
            "Ask Mr. Smith for the records.",
            "Ask Mr Smith for the records.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
        assert!(
            validate_cleanup(candidate, source).is_ok(),
            "{candidate} -> {source}"
        );
    }
}

#[test]
fn suppressed_abbreviation_endpoints_keep_unpunctuated_qualifiers_protected() {
    for (source, candidate) in [
        (
            "If Smith approves keep the records for Dr. Jones tomorrow",
            "If Smith approves. Keep the records for Dr. Jones tomorrow",
        ),
        (
            "If the build passes ship the 9 a.m. release",
            "If the build passes. Ship the 9 a.m. release",
        ),
        (
            "Maybe we will approve plan B. call me",
            "Maybe we will approve. Plan B. call me",
        ),
        (
            "If Smith approves keep the records for Dr. Jones tomorrow",
            "If Smith approves keep the records for Dr. Jones. Tomorrow",
        ),
        (
            "Keep the records if Dr. Smith approves the prototype tomorrow",
            "Keep the records if Dr. Smith approves the prototype. Tomorrow",
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
fn word_tails_are_not_abbreviation_initials() {
    for (source, candidate) in [
        (
            "Do not delete Jones's. send the report then call me",
            "Do not delete Jones's. Send the report. Then call me.",
        ),
        (
            "Do not say can't. send the report then call me",
            "Do not say can't. Send the report. Then call me.",
        ),
        (
            "Do not alter 3b. send the report then call me",
            "Do not alter 3b. Send the report. Then call me.",
        ),
        (
            "Do not alter Straße. send the report then call me",
            "Do not alter Straße. Send the report. Then call me.",
        ),
        (
            "Do not alter São. send the report then call me",
            "Do not alter São. Send the report. Then call me.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
        assert!(
            validate_cleanup(candidate, source).is_ok(),
            "{candidate} -> {source}"
        );
    }
}

#[test]
fn abbreviation_periods_do_not_end_negative_scope() {
    for (source, candidate) in [
        (
            "Do not delete Mr. Smith's records you will need.",
            "Do not delete Mr. Smith's records. You will need.",
        ),
        (
            "Delete Mr. Smith's records you don't need.",
            "Delete. Mr. Smith's records you don't need.",
        ),
        (
            "Do not delete A. Smith's records you will need.",
            "Do not delete A. Smith's records. You will need.",
        ),
        (
            "Do not delete the 9 a.m. recordings you will need.",
            "Do not delete the 9 a.m. recordings. You will need.",
        ),
        (
            "Do not delete U.S. reports you will need.",
            "Do not delete U.S. reports. You will need.",
        ),
        (
            "Do not delete Mr.Smith's records you will need.",
            "Do not delete Mr.Smith's records. You will need.",
        ),
        (
            "Do not delete U.S.reports you will need.",
            "Do not delete U.S.reports. You will need.",
        ),
        (
            "Do not delete the logs, configs, etc. you will need.",
            "Do not delete the logs, configs, etc. you will. Need.",
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
fn abbreviation_periods_do_not_detach_leading_conditions() {
    for (source, candidate) in [
        (
            "If Dr. Smith approves the prototype keep the records.",
            "If Dr. Smith approves the prototype. Keep the records.",
        ),
        (
            "If Dr.Smith approves the prototype keep the records.",
            "If Dr.Smith approves the prototype. Keep the records.",
        ),
        (
            "Unless the 9 a.m. review approves the prototype keep the records.",
            "Unless the 9 a.m. review approves the prototype. Keep the records.",
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
fn unchanged_abbreviation_punctuation_keeps_cleanup_editable() {
    for (source, candidate) in [
        (
            "if smith approves keep the records for dr. jones tomorrow",
            "If Smith approves, keep the records for Dr. Jones tomorrow.",
        ),
        (
            "keep the records if dr. smith approves the prototype tomorrow",
            "Keep the records if Dr. Smith approves the prototype tomorrow.",
        ),
        (
            "do not delete mr. smith's records you will need.",
            "Do not delete Mr. Smith's records, you will need.",
        ),
        (
            "if dr. smith approves the prototype keep the records.",
            "If Dr. Smith approves the prototype, keep the records.",
        ),
        (
            "do not delete a. smith's u.s. reports at 9 a.m.",
            "Do not delete A. Smith's U.S. reports at 9 a.m.",
        ),
        (
            "Do not delete Mr. Smith's records. keep the backup",
            "Do not delete Mr. Smith's records. Keep the backup.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
        assert!(
            validate_cleanup(candidate, source).is_ok(),
            "{candidate} -> {source}"
        );
    }
}

#[test]
fn abbreviation_dots_remain_visible_to_protected_scope_audits() {
    for (source, candidate) in [
        (
            "Do not delete Mr Smith's records you will need.",
            "Do not delete Mr. Smith's records you will need.",
        ),
        (
            "Do not delete A Smith's records you will need.",
            "Do not delete A. Smith's records you will need.",
        ),
        (
            "Do not delete U S reports you will need.",
            "Do not delete U.S. reports you will need.",
        ),
        (
            "Do not delete the 9 a m recordings you will need.",
            "Do not delete the 9 a.m. recordings you will need.",
        ),
        (
            "If Dr Smith approves the prototype keep the records.",
            "If Dr. Smith approves the prototype keep the records.",
        ),
        (
            "If I approve the prototype keep the records.",
            "If I. approve the prototype keep the records.",
        ),
        (
            "If the prototype passes keep the records for Dr.",
            "If the prototype passes. Keep the records for Dr.",
        ),
        (
            "Maybe Dr. Smith approves the prototype tomorrow.",
            "Maybe Dr. Smith approves the prototype. Tomorrow.",
        ),
        (
            "I think that Dr. Smith approves the prototype tomorrow.",
            "I think that Dr. Smith approves the prototype. Tomorrow.",
        ),
        (
            "Do not delete \"Mr. Smith's records you will need\".",
            "Do not delete \"Mr. Smith's records. You will need\".",
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
fn rejects_breaks_inside_negative_predicate_clauses() {
    for (source, candidate) in [
        (
            "I don’t think we should ship.",
            "I don’t think. We should ship.",
        ),
        (
            "I don't think we should ship.",
            "I don't think. We should ship.",
        ),
        (
            "I don't think we should ship.",
            "I don't think; we should ship.",
        ),
        (
            "I don't think we should ship.",
            "I don't think: We should ship.",
        ),
        (
            "I don't believe we should ship.",
            "I don't believe\nwe should ship.",
        ),
        (
            "I don't believe we should ship.",
            "I don't believe\rWe should ship.",
        ),
        (
            "I don’t think. We should ship.",
            "I don’t think we should ship.",
        ),
        (
            "We must not approve payment tomorrow.",
            "We must not approve payment. Tomorrow.",
        ),
        (
            "We must not approve payment. Tomorrow.",
            "We must not approve payment tomorrow.",
        ),
        (
            "Never approve this transfer tomorrow.",
            "Never approve this transfer. Tomorrow.",
        ),
        (
            "Never approve this transfer. Tomorrow.",
            "Never approve this transfer tomorrow.",
        ),
        (
            "Do not pay $10.50 tomorrow.",
            "Do not pay $10.50. Tomorrow.",
        ),
        (
            "Do not pay $10.50. Tomorrow.",
            "Do not pay $10.50 tomorrow.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn allows_complete_negative_clauses_and_decimal_amounts() {
    for (source, candidate) in [
        (
            "i don't think we should ship",
            "I don’t think we should ship!",
        ),
        (
            "We must not approve payment tomorrow. We should review it Friday.",
            "We must not approve payment tomorrow! We should review it Friday.",
        ),
        (
            "I don't think the total is $10.50. We should check it tomorrow.",
            "I don’t think the total is $10.50; we should check it tomorrow.",
        ),
        (
            "Do not ship unless legal approves. we should review the budget.",
            "Do not ship unless legal approves! We should review the budget.",
        ),
        (
            "Unless legal approves, do not ship. we should review the budget.",
            "Unless legal approves, do not ship! We should review the budget.",
        ),
        (
            "Do not cancel Friday. the budget is twenty five euros.",
            "Do not cancel Friday! The budget is twenty five euros.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn ignores_literal_negation_but_preserves_literal_words() {
    for (source, candidate) in [
        (
            "She wrote \"I don't think we should ship\" before lunch.",
            "She wrote \"I don't think we should ship\". Before lunch.",
        ),
        (
            "Use `I don't believe we should ship` in the example.",
            "Use `I don't believe we should ship`. In the example.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }

    for (source, candidate) in [
        (
            "She wrote \"I don't think we should ship\" before lunch.",
            "She wrote \"I don't think we should launch\" before lunch.",
        ),
        (
            "Use `I don't believe we should ship` in the example.",
            "Use `I don't believe we should launch` in the example.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn rejects_detaching_negative_objects_relative_clauses() {
    for (source, candidate) in [
        (
            "Do not delete reports you will need.",
            "Do not delete reports. You will need.",
        ),
        (
            "Do not publish the results they can dispute.",
            "Do not publish the results. They can dispute.",
        ),
        (
            "Do not approve the loan the bank is rejecting.",
            "Do not approve the loan. The bank is rejecting.",
        ),
        (
            "Do not delete the reports and backups.",
            "Do not delete the reports. And backups.",
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
fn preserves_unpunctuated_negative_and_conditional_statement_scope() {
    for (source, candidate) in [
        (
            "Do not ship unless legal approves we should review the budget.",
            "Do not ship unless legal approves. We should review the budget.",
        ),
        (
            "Do not ship unless legal approves we should review the budget",
            "Do not ship unless legal approves. We should review the budget.",
        ),
        (
            "Unless legal approves, do not ship we should review the budget.",
            "Unless legal approves, do not ship. We should review the budget.",
        ),
        (
            "Unless legal approves, do not ship we should review the budget",
            "Unless legal approves, do not ship. We should review the budget.",
        ),
        (
            "Do not cancel Friday the budget is twenty five euros.",
            "Do not cancel Friday. The budget is twenty five euros.",
        ),
        (
            "Do not ship unless legal agrees we should waive the review.",
            "Do not ship unless legal agrees. We should waive the review.",
        ),
        (
            "Do not release unless the report says the budget is approved.",
            "Do not release unless the report says. The budget is approved.",
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
fn rejects_detaching_negative_relative_clauses_before_negation() {
    for (source, candidate) in [
        (
            "Delete the files you don't need.",
            "Delete the files. You don't need.",
        ),
        (
            "Approve only reports the team will not dispute.",
            "Approve only reports. The team will not dispute.",
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
fn added_quotes_cannot_hide_a_negative_scope_break() {
    for (source, candidate) in [
        (
            "Do not delete reports you will need.",
            "Do not delete \"reports.\" You will need.",
        ),
        (
            "Do not delete reports you will need and label them \"draft\".",
            "Do not delete \"reports.\" You will need and label them draft.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_err(),
            "{source} -> {candidate}"
        );
    }
    assert!(validate_cleanup(
        "Do not delete reports you will need.",
        "Do not delete \"reports\" you will need.",
    )
    .is_ok());
}

#[test]
fn existing_negative_scope_and_literal_endpoints_remain_editable() {
    for (source, candidate) in [
        (
            "we should ship tomorrow. do not wait",
            "We should ship tomorrow! Do not wait.",
        ),
        (
            "Do not delete reports. we will need backups",
            "Do not delete reports! We will need backups.",
        ),
        (
            "Do not delete \"reports\". You will need them.",
            "Do not delete \"reports.\" You will need them.",
        ),
        (
            "Do not ship and do not delete reports.",
            "Do not ship, and do not delete reports!",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
}

#[test]
fn quoted_negative_statements_keep_internal_scope_and_literal_status() {
    for (source, candidate) in [
        (
            "She wrote \"I don't think we should ship\" before lunch.",
            "She wrote \"I don't think. We should ship\" before lunch.",
        ),
        (
            "Use `I don't believe we should ship` in the example.",
            "Use `I don't believe. We should ship` in the example.",
        ),
        (
            "She wrote \"Do not ship\" before lunch.",
            "She wrote Do not ship before lunch.",
        ),
        ("Do not ship until review.", "\"Do not ship\" until review."),
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
fn single_quoted_negative_literals_keep_their_own_container() {
    for (source, candidate) in [
        (
            "She used 'never delete reports' before lunch.",
            "She used 'never delete reports'. Before lunch.",
        ),
        (
            "Refer to 'not approved' in the example.",
            "Refer to 'not approved'. In the example.",
        ),
    ] {
        assert!(
            validate_cleanup(source, candidate).is_ok(),
            "{source} -> {candidate}"
        );
    }
    assert!(validate_cleanup(
        "She used 'never delete reports' before lunch.",
        "She used never delete reports before lunch.",
    )
    .is_err());
}

#[test]
fn clock_separators_do_not_end_negative_statement_scope() {
    for (source, candidate) in [
        (
            "Do not delete the 3:30 recordings you will need.",
            "Do not delete the 3:30 recordings. You will need.",
        ),
        (
            "Do not delete recordings at three thirty am you will need.",
            "Do not delete recordings at 3:30 am. You will need.",
        ),
        (
            "Use \"Do not delete the 3:30 recordings you will need\" in the example.",
            "Use \"Do not delete the 3:30 recordings. You will need\" in the example.",
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
fn negative_scope_keeps_numeric_delimiters_and_overlapping_constraints() {
    for (source, candidate) in [
        ("Do not pay $3.30.", "Do not pay $3:30."),
        (
            "Do not delete reports I would not review.",
            "Do not delete reports. I would not review.",
        ),
        (
            "we should ship tomorrow do not wait",
            "We should ship tomorrow. Do not wait.",
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
    assert!(validate_cleanup(
        "Use 'never delete reports'. Do not change files.",
        "Use 'never delete reports'! Do not change files.",
    )
    .is_ok());
}
