//! Check explicit introduction roles without joining identities across citations.

use super::Citation;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static INTRODUCTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i:\bmy\s+name\s+is\s+)(?P<declared>[\p{L}\p{M}'’-]+(?:[\t ]+[\p{L}\p{M}'’-]+){0,2})",
        r"|(?i:\bi(?:['’]m|\s+am)\s+)(?P<bare>[\p{Lu}][\p{L}\p{M}'’-]*(?:[\t ]+[\p{Lu}][\p{L}\p{M}'’-]*){0,2})"
    ))
    .expect("introduction pattern is valid")
});

static ROLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:my\s+role\s+is\s+(?:(?:a|an|the)\s+)?",
        r"|i(?:['’]m|\s+am)\s+(?:a|an|the)\s+)",
        r"(?P<role>[^.!?;\n]+)"
    ))
    .expect("introduction role pattern is valid")
});

static QUOTED_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|[^\p{L}\p{N}_])(?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|‘[^’\n]*’|“[^”\n]*”)"#)
        .expect("quoted statement pattern is valid")
});

fn title(text: &str) -> Option<String> {
    let mut words = Vec::new();
    for word in text.split([',', ':']).next()?.split_whitespace() {
        let word = word.trim_matches(|character: char| !character.is_alphabetic());
        if matches!(
            word.to_lowercase().as_str(),
            "and"
                | "but"
                | "for"
                | "with"
                | "to"
                | "who"
                | "responsible"
                | "today"
                | "now"
                | "currently"
        ) {
            break;
        }
        if word.is_empty() {
            break;
        }
        words.push(word.to_lowercase());
        if words.len() > 4 {
            return None;
        }
    }
    (!words.is_empty()).then(|| words.join(" "))
}

fn introduced_name(captures: &regex::Captures<'_>) -> Option<(String, usize)> {
    let matched = captures
        .name("declared")
        .or_else(|| captures.name("bare"))?;
    let mut name = Vec::new();
    let mut offset = 0;
    for word in matched.as_str().split_whitespace() {
        if matches!(
            word.to_lowercase().as_str(),
            "and" | "i" | "i'm" | "i’m" | "my" | "a" | "an" | "the" | "not"
        ) {
            break;
        }
        name.push(word.to_lowercase());
        offset += matched.as_str()[offset..].find(word).unwrap() + word.len();
    }
    (!name.is_empty()).then(|| (name.join(" "), matched.start() + offset))
}

/// Only named positive role assertions are checked. Anonymous summaries and
/// names absent from explicit source introductions stay outside this check.
pub(crate) fn unsupported_named_role(claim: &str, citations: &[Citation]) -> bool {
    let mut roles = HashSet::new();
    let mut people: HashMap<String, HashSet<String>> = HashMap::new();
    for citation in citations {
        for role in ROLE.captures_iter(&citation.text) {
            if let Some(role) = title(&role["role"]) {
                roles.insert(role);
            }
        }
        for introduction in INTRODUCTION.captures_iter(&citation.text) {
            let Some((name, end)) = introduced_name(&introduction) else {
                continue;
            };
            let supported = people.entry(name).or_default();
            let following = &citation.text[end..];
            let Some(role) = ROLE.captures(following) else {
                continue;
            };
            if following[role.get(0).unwrap().end()..].starts_with('?') {
                continue;
            }
            let prefix = following[..role.get(0).unwrap().start()].trim();
            // A separate self-introduction or intervening statement breaks
            // the link, even when both appear in one grouped source row.
            if !matches!(
                prefix.to_lowercase().as_str(),
                "" | "and" | "." | "," | ", and"
            ) {
                continue;
            }
            if let Some(role) = title(&role["role"]) {
                supported.insert(role);
            }
        }
    }
    for (name, supported) in people {
        let assertion = Regex::new(&format!(
            concat!(
                r"(?i)\b{}\b\s+(?:",
                r"(?:is|was)\s+",
                r"|(?:stated|said|explained)\s+(?:(?:her|his|their)\s+)?role\s+is\s+",
                r"|introduced\s+(?:herself|himself|themselves),?\s+(?:stating|saying)\s+(?:(?:her|his|their)\s+)?role\s+is\s+",
                r")(?:(?:a|an|the)\s+)?(?P<role>[^.!?;\n]+)"
            ),
            regex::escape(&name)
        ))
        .expect("named role assertion pattern is valid");
        for assertion in assertion.captures_iter(claim) {
            let start = assertion.get(0).unwrap().start();
            if QUOTED_TEXT
                .find_iter(claim)
                .any(|quoted| quoted.range().contains(&start))
            {
                continue;
            }
            if claim[assertion.get(0).unwrap().end()..].starts_with('?') {
                continue;
            }
            let Some(asserted) = title(&assertion["role"]) else {
                continue;
            };
            if roles.contains(&asserted) && !supported.contains(&asserted) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn citation(text: &str) -> Citation {
        Citation {
            text: text.into(),
            source_kind: None,
            line_id: None,
            segment_id: None,
            start_time: None,
            end_time: None,
            recording_id: None,
            certainty: None,
        }
    }

    const FRANCINE: &str = "Yeah, my name is Francine and I'm a user interface. My role is, the main responsibility is user interface. And my role is to design a television remote control. Okay. And I'm a marketing person. I want to figure out how to sell them.";
    const JANAVIE: &str = "And your name is? My name is Eileen. Okay. I'm Janavie. My role is industrial designer and my responsibilities are to deal with the technical functional designs and specifications of user interface and dealing with user interface design.";

    #[test]
    fn rejects_the_public_ami_swapped_role_claim() {
        let sources = [citation(FRANCINE), citation(JANAVIE)];
        let claim = "Francine stated her role is user interface. Eileen introduced herself, stating her role is industrial designer, responsible for technical functional designs and specifications of user interface and dealing with user interface design.";
        assert!(unsupported_named_role(claim, &sources));
        assert!(
            super::super::claim_support::unsupported_claims(claim, &sources)
                .contains(&"named_role_not_cited".to_string())
        );
    }

    #[test]
    fn preserves_each_explicit_source_role() {
        let sources = [
            citation(FRANCINE),
            citation(JANAVIE),
            citation("I'm Betsy. I'm the project manager for today."),
        ];
        for claim in [
            "Francine is a user interface.",
            "Janavie is the industrial designer.",
            "Betsy is the project manager.",
        ] {
            assert!(!unsupported_named_role(claim, &sources), "{claim}");
        }
    }

    #[test]
    fn source_word_aggregation_does_not_prove_a_swapped_pair() {
        let sources = [
            citation("My name is Alice and I'm the project manager."),
            citation("My name is Bob and I'm the industrial designer."),
        ];
        assert!(unsupported_named_role(
            "Alice is the industrial designer.",
            &sources
        ));
        assert!(unsupported_named_role(
            "Bob is the project manager.",
            &sources
        ));
        assert!(!unsupported_named_role(
            "Alice is the project manager. Bob is the industrial designer.",
            &sources
        ));
    }

    #[test]
    fn a_new_introduction_breaks_first_person_continuity() {
        let sources = [citation(
            "My name is Eileen. I'm Janavie. My role is industrial designer.",
        )];
        assert!(unsupported_named_role(
            "Eileen is the industrial designer.",
            &sources
        ));
        assert!(!unsupported_named_role(
            "Janavie is the industrial designer.",
            &sources
        ));
    }

    #[test]
    fn an_unlabeled_first_person_role_does_not_name_its_owner() {
        let sources = [citation(FRANCINE)];
        assert!(unsupported_named_role(
            "Francine is a marketing person.",
            &sources
        ));
        assert!(!unsupported_named_role(
            "A speaker is a marketing person.",
            &sources
        ));
        assert!(!unsupported_named_role(
            "Speaker 3 discussed marketing.",
            &sources
        ));
    }

    #[test]
    fn separate_citations_do_not_carry_an_introduced_identity() {
        let sources = [
            citation("My name is Alice."),
            citation("I'm the project manager."),
        ];
        assert!(unsupported_named_role(
            "Alice is the project manager.",
            &sources
        ));
        assert!(!unsupported_named_role(
            "A speaker is the project manager.",
            &sources
        ));
    }

    #[test]
    fn keeps_anonymous_roles_and_role_topics_outside_the_check() {
        let sources = [citation(FRANCINE), citation(JANAVIE)];
        for claim in [
            "The introductions mentioned user interface, marketing and industrial design.",
            "Eileen discussed the industrial designer's specifications.",
            "A speaker said, 'I'm the industrial designer.'",
        ] {
            assert!(!unsupported_named_role(claim, &sources), "{claim}");
        }
    }

    #[test]
    fn does_not_convert_uncertain_or_negated_roles_to_positive_evidence() {
        for source in [
            "My name is Alice. I'm not the project manager.",
            "My name is Alice. Am I the project manager?",
            "My name is Alice. I'm the project manager?",
            "My name is Alice. I might be the project manager.",
        ] {
            let sources = [
                citation(source),
                citation("I'm Bob. I'm the project manager."),
            ];
            assert!(
                unsupported_named_role("Alice is the project manager.", &sources),
                "{source}"
            );
            assert!(!unsupported_named_role(
                "Alice is the project manager?",
                &sources
            ));
        }
    }

    #[test]
    fn preserves_source_spelling_without_guessing_reference_names() {
        let sources = [
            citation(JANAVIE),
            citation("I'm Betsy. I'm the project manager for today."),
        ];
        assert!(!unsupported_named_role(
            "JANAVIE is the industrial designer. Betsy is the project manager.",
            &sources
        ));
        // Reference spellings are not introduced in these ASR citations.
        // This bounded check leaves them to existing name/claim validation.
        assert!(!unsupported_named_role(
            "Jeanne-Oui is the industrial designer. Betty is the project manager.",
            &sources
        ));
    }

    #[test]
    fn a_comma_before_and_preserves_an_inline_introduction_link() {
        let sources = [citation("My name is Alice, and I'm the project manager.")];
        assert!(!unsupported_named_role(
            "Alice is the project manager.",
            &sources
        ));
    }

    #[test]
    fn quoted_rejected_roles_do_not_become_positive_assertions() {
        let sources = [
            citation("My name is Alice and I'm the project manager."),
            citation("My name is Bob and I'm the industrial designer."),
        ];
        for claim in [
            "Bob rejected the statement 'Alice is the industrial designer'.",
            "Bob rejected the statement \"Alice is the industrial designer\".",
            "Bob rejected the statement `Alice is the industrial designer`.",
            "Bob rejected the statement ‘Alice is the industrial designer’.",
        ] {
            assert!(!unsupported_named_role(claim, &sources), "{claim}");
        }
        assert!(unsupported_named_role(
            "Bob rejected the statement 'Alice is the industrial designer'. Alice is the industrial designer.",
            &sources,
        ));
    }

    #[test]
    fn a_time_suffix_cannot_hide_a_swapped_role() {
        let sources = [
            citation("My name is Alice and I'm the project manager."),
            citation("My name is Bob and I'm the industrial designer."),
        ];
        for suffix in ["today", "now", "currently"] {
            assert!(unsupported_named_role(
                &format!("Alice is the industrial designer {suffix}."),
                &sources,
            ));
            assert!(!unsupported_named_role(
                &format!("Alice is the project manager {suffix}."),
                &sources,
            ));
        }
        for claim in [
            "Alice is the industrial designer's assistant.",
            "Alice discussed the industrial designer's specifications today.",
            "An anonymous speaker is the industrial designer today.",
        ] {
            assert!(!unsupported_named_role(claim, &sources), "{claim}");
        }
    }
}
