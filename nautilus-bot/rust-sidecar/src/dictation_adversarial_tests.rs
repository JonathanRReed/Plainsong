use crate::dictation_fidelity::finish_cleanup_with_disfluencies;
use crate::dictation_parity::{apply_dictation_dictionary, DictionaryRule};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../docs/evals/dictation-quality-fixtures.json"
    ))
    .unwrap()
}

#[test]
fn adversarial_dictionary_fixtures() {
    let mut failures = Vec::new();
    for case in fixtures()["dictionaryCases"].as_array().unwrap() {
        let rules: Vec<DictionaryRule> = serde_json::from_value(case["rules"].clone()).unwrap();
        let actual = apply_dictation_dictionary(
            case["inputText"].as_str().unwrap(),
            &rules,
            case["appTarget"].as_str(),
        );
        let expected = (
            case["expectedOutput"].as_str().unwrap().to_string(),
            case["expectedAppliedCount"].as_u64().unwrap() as usize,
        );
        if actual != expected {
            failures.push(format!("{}: {actual:?} != {expected:?}", case["id"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn adversarial_replacement_fixtures() {
    for case in fixtures()["correctionCases"].as_array().unwrap() {
        let actual = crate::dictation_parity::apply_contextual_phrase_replacement(
            case["inputText"].as_str().unwrap(),
            case["target"].as_str().unwrap(),
            case["replacement"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            actual,
            (
                case["expectedOutput"].as_str().unwrap().to_string(),
                case["expectedAppliedCount"].as_u64().unwrap() as usize,
            ),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn adversarial_rule_cleanup_fixtures() {
    let mut failures = Vec::new();
    for case in fixtures()["ruleCleanupCases"].as_array().unwrap() {
        let actual =
            crate::dictation_cleanup::clean_disfluencies(case["inputText"].as_str().unwrap());
        let expected = case["expectedOutput"].as_str().unwrap();
        if actual != expected {
            failures.push(format!("{}: {actual:?} != {expected:?}", case["id"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn adversarial_full_pipeline_fixtures() {
    use crate::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
    use crate::text::format::DictationAppCategory;
    let mut failures = Vec::new();
    for case in fixtures()["pipelineCases"].as_array().unwrap() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: case["inputText"].as_str().unwrap(),
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: case["smartFormatting"].as_bool().unwrap(),
            clean_disfluencies: case["cleanDisfluencies"].as_bool().unwrap(),
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: if case["category"] == "code_editor" {
                DictationAppCategory::CodeEditor
            } else {
                DictationAppCategory::Other
            },
            structured_layout: true,
            spoken_language: case["language"].as_str(),
        });
        let expected = case["expectedOutput"].as_str().unwrap();
        if result.text != expected {
            failures.push(format!("{}: {:?} != {expected:?}", case["id"], result.text));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn adversarial_cleanup_failure_keeps_the_pre_ai_text() {
    use crate::dictation_timing::{resolve_dictation_format_attempt, DictationFormatAttempt};
    let source = "Do not email Zoë unless 12.5% is paid.\n\nשלום 👋";
    for attempt in [
        DictationFormatAttempt::TimedOut,
        DictationFormatAttempt::Failed,
    ] {
        let result = resolve_dictation_format_attempt(attempt, source);
        assert_eq!(result.final_text, source);
    }
    assert!(finish_cleanup_with_disfluencies("um do not send", "Do not send.", false).is_err());
}

#[test]
fn adversarial_production_cleanup_guard_fixtures() {
    let mut failures = Vec::new();
    for case in fixtures()["cleanupValidationCases"].as_array().unwrap() {
        let result = finish_cleanup_with_disfluencies(
            case["inputText"].as_str().unwrap(),
            case["candidateText"].as_str().unwrap(),
            true,
        );
        if result.is_ok() != case["expectedAccepted"].as_bool().unwrap() {
            failures.push(format!("{}: {result:?}", case["id"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(target_os = "macos")]
#[test]
fn adversarial_insertion_preserves_multiline_long_unicode_and_rejects_split_surrogates() {
    use crate::text_insert::replace_utf16_range;
    use core_foundation::base::CFRange;

    let text = "Don't change 12.5%: café 👩🏽‍💻\n\nשלום مرحبا\t<&> $1 \\ foo_bar\0".repeat(2000);
    let (inserted, caret) = replace_utf16_range(
        "A😀Z",
        CFRange {
            location: 1,
            length: 2,
        },
        &text,
    )
    .unwrap();
    assert_eq!(inserted, format!("A{text}Z"));
    assert_eq!(caret.location as usize, 1 + text.encode_utf16().count());
    assert_eq!(caret.length, 0);
    for range in [
        CFRange {
            location: 2,
            length: 0,
        },
        CFRange {
            location: 1,
            length: 1,
        },
        CFRange {
            location: -1,
            length: 1,
        },
        CFRange {
            location: 4,
            length: 1,
        },
    ] {
        assert!(replace_utf16_range("A😀Z", range, "safe").is_none());
    }
}

#[test]
fn adversarial_cleanup_never_loses_a_long_middle_or_repeated_answer() {
    let source = format!(
        "{}Never send 12 boxes unless Zoë agrees. {}",
        "Agreed. ".repeat(200),
        "A. ".repeat(200)
    );
    for candidate in [
        source.replacen("Never ", "", 1),
        source.replacen("Agreed. ", "", 1),
        source.replacen("Zoë", "Zoe", 1),
    ] {
        assert!(finish_cleanup_with_disfluencies(&source, &candidate, true).is_err());
    }
    assert_eq!(
        finish_cleanup_with_disfluencies(&source, &source, true).unwrap(),
        source
    );
}
