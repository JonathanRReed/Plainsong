#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const DEFAULT_COMMAND_PREFIX: &str = "command";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationCommandAction {
    InsertText(String),
    UndoLastInsert,
    DeleteLastSentence,
    RewriteShorter(String),
    RewriteProfessional(String),
    Bulletize(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryRule {
    pub spoken_form: String,
    pub replacement: String,
    pub app_scope: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRule {
    pub trigger: String,
    pub expansion: String,
    pub app_scope: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkFixture {
    #[serde(default = "default_fixture_schema_version")]
    pub schema_version: String,
    pub scenarios: Vec<DictationBenchmarkScenario>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkScenario {
    pub app_target: String,
    pub requested_provider: String,
    pub actual_provider: String,
    #[serde(default)]
    pub is_fallback: bool,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    pub transcription_latency_ms: f64,
    pub end_to_end_ms: f64,
    pub input_text: String,
    #[serde(default)]
    pub command_prefix: Option<String>,
    #[serde(default)]
    pub snippets: Vec<SnippetRule>,
    #[serde(default)]
    pub expected_command_applied: Option<String>,
    #[serde(default)]
    pub expect_no_command: bool,
    #[serde(default)]
    pub expected_snippet_applied_count: Option<usize>,
    #[serde(default)]
    pub expected_output: Option<String>,
    #[serde(default)]
    pub insertion_outcome: Option<String>,
    #[serde(default)]
    pub insertion_mode_used: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DictationBenchmarkContext {
    pub run_id: String,
    pub generated_at: String,
    pub build_version: String,
    pub build_commit: String,
    pub platform_os: String,
    pub platform_os_version: String,
    pub device: String,
    pub latency_scale: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkRun {
    pub schema_version: String,
    pub run_id: String,
    pub generated_at: String,
    pub build: DictationBenchmarkBuild,
    pub platform: DictationBenchmarkPlatform,
    pub rows: Vec<DictationBenchmarkRow>,
    pub summary: DictationBenchmarkSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkBuild {
    pub version: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkPlatform {
    pub os: String,
    pub os_version: String,
    pub device: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkRow {
    pub timestamp: String,
    pub app_target: String,
    pub requested_provider: String,
    pub actual_provider: String,
    pub is_fallback: bool,
    pub fallback_reason: Option<String>,
    pub transcription_latency_ms: f64,
    pub end_to_end_ms: f64,
    pub insertion_outcome: String,
    pub insertion_mode_used: String,
    pub command_applied: Option<String>,
    pub snippet_applied_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkSummary {
    pub sample_count: usize,
    pub insertion_success_rate: f64,
    pub command_success_rate: f64,
    pub snippet_success_rate: f64,
    pub p50_end_to_end_ms: f64,
    pub p95_end_to_end_ms: f64,
}

fn default_true() -> bool {
    true
}

fn default_fixture_schema_version() -> String {
    "1.0".to_string()
}

fn replace_case_insensitive_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> (String, usize) {
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        return (haystack.to_string(), 0);
    }

    let escaped = regex::escape(trimmed);
    let Ok(re) = regex::RegexBuilder::new(&escaped)
        .case_insensitive(true)
        .build()
    else {
        return (haystack.to_string(), 0);
    };

    let applied = re.find_iter(haystack).count();
    if applied == 0 {
        return (haystack.to_string(), 0);
    }
    (re.replace_all(haystack, replacement).to_string(), applied)
}

fn snippet_app_scope_matches(snippet_scope: Option<&str>, app_target: Option<&str>) -> bool {
    let Some(scope) = snippet_scope
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    let Some(app_name) = app_target else {
        return false;
    };
    app_name.to_lowercase().contains(&scope.to_lowercase())
}

fn replace_dictionary_case_sensitive_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> (String, usize) {
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        return (haystack.to_string(), 0);
    }

    let escaped = regex::escape(trimmed);
    let pattern = format!(r"(^|[^A-Za-z0-9_])({})([^A-Za-z0-9_]|$)", escaped);
    let Ok(re) = regex::Regex::new(&pattern) else {
        return (haystack.to_string(), 0);
    };

    let applied = re.find_iter(haystack).count();
    if applied == 0 {
        return (haystack.to_string(), 0);
    }

    (
        re.replace_all(haystack, |captures: &regex::Captures<'_>| {
            format!("{}{}{}", &captures[1], replacement, &captures[3])
        })
        .to_string(),
        applied,
    )
}

fn replace_dictionary_case_insensitive_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> (String, usize) {
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        return (haystack.to_string(), 0);
    }

    let escaped = regex::escape(trimmed);
    let pattern = format!(r"(^|[^A-Za-z0-9_])({})([^A-Za-z0-9_]|$)", escaped);
    let Ok(re) = regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
    else {
        return (haystack.to_string(), 0);
    };

    let applied = re.find_iter(haystack).count();
    if applied == 0 {
        return (haystack.to_string(), 0);
    }

    (
        re.replace_all(haystack, |captures: &regex::Captures<'_>| {
            format!("{}{}{}", &captures[1], replacement, &captures[3])
        })
        .to_string(),
        applied,
    )
}

pub fn apply_dictation_dictionary(
    input: &str,
    rules: &[DictionaryRule],
    app_target: Option<&str>,
) -> (String, usize) {
    if input.trim().is_empty() || rules.is_empty() {
        return (input.to_string(), 0);
    }

    let mut output = input.to_string();
    let mut applied_total = 0usize;
    let mut ordered = rules.to_vec();
    ordered.sort_by(|a, b| b.spoken_form.len().cmp(&a.spoken_form.len()));

    for rule in ordered {
        if !rule.enabled {
            continue;
        }
        if !snippet_app_scope_matches(rule.app_scope.as_deref(), app_target) {
            continue;
        }
        if rule.spoken_form.trim().is_empty() {
            continue;
        }

        let (next, applied) = if rule.case_sensitive {
            replace_dictionary_case_sensitive_all(
                output.as_str(),
                rule.spoken_form.as_str(),
                rule.replacement.as_str(),
            )
        } else {
            replace_dictionary_case_insensitive_all(
                output.as_str(),
                rule.spoken_form.as_str(),
                rule.replacement.as_str(),
            )
        };
        if applied > 0 {
            output = next;
            applied_total += applied;
        }
    }

    (output, applied_total)
}

pub fn apply_dictation_snippets(
    input: &str,
    snippets: &[SnippetRule],
    app_target: Option<&str>,
) -> (String, usize) {
    if input.trim().is_empty() || snippets.is_empty() {
        return (input.to_string(), 0);
    }

    let mut output = input.to_string();
    let mut applied_total = 0usize;
    let mut ordered = snippets.to_vec();
    ordered.sort_by(|a, b| b.trigger.len().cmp(&a.trigger.len()));

    for snippet in ordered {
        if !snippet.enabled {
            continue;
        }
        if !snippet_app_scope_matches(snippet.app_scope.as_deref(), app_target) {
            continue;
        }
        if snippet.trigger.trim().is_empty() {
            continue;
        }

        if snippet.case_sensitive {
            let matches = output.matches(snippet.trigger.as_str()).count();
            if matches > 0 {
                output = output.replace(snippet.trigger.as_str(), snippet.expansion.as_str());
                applied_total += matches;
            }
        } else {
            let (next, applied) = replace_case_insensitive_all(
                output.as_str(),
                snippet.trigger.as_str(),
                snippet.expansion.as_str(),
            );
            if applied > 0 {
                output = next;
                applied_total += applied;
            }
        }
    }

    (output, applied_total)
}

fn command_payload<'a>(raw: &'a str, phrase: &str) -> Option<&'a str> {
    let head = raw.get(..phrase.len())?;
    let tail = raw.get(phrase.len()..)?;
    if !head.eq_ignore_ascii_case(phrase) {
        return None;
    }
    Some(tail.trim_start_matches([' ', ':', ',']).trim())
}

fn normalize_command_prefix(prefix: &str) -> &str {
    let trimmed = prefix.trim();
    if trimmed.is_empty() {
        DEFAULT_COMMAND_PREFIX
    } else {
        trimmed
    }
}

pub fn parse_dictation_command(
    raw_text: &str,
    prefix: &str,
) -> Option<(String, DictationCommandAction)> {
    let text = raw_text.trim();
    if text.is_empty() {
        return None;
    }

    let normalized_prefix = normalize_command_prefix(prefix);
    let mut words = text.split_whitespace();
    let first = words.next()?;
    let first_normalized = first.trim_end_matches([':', ',']);
    if !first_normalized.eq_ignore_ascii_case(normalized_prefix) {
        return None;
    }

    let remainder = words.collect::<Vec<_>>().join(" ");
    if remainder.is_empty() {
        return None;
    }

    if remainder.eq_ignore_ascii_case("newline") {
        return Some((
            "newline".to_string(),
            DictationCommandAction::InsertText("\n".to_string()),
        ));
    }
    if remainder.eq_ignore_ascii_case("paragraph") {
        return Some((
            "paragraph".to_string(),
            DictationCommandAction::InsertText("\n\n".to_string()),
        ));
    }
    if remainder.eq_ignore_ascii_case("undo last insert") {
        return Some((
            "undo_last_insert".to_string(),
            DictationCommandAction::UndoLastInsert,
        ));
    }
    if remainder.eq_ignore_ascii_case("delete last sentence") {
        return Some((
            "delete_last_sentence".to_string(),
            DictationCommandAction::DeleteLastSentence,
        ));
    }
    if let Some(payload) = command_payload(&remainder, "rewrite shorter") {
        return Some((
            "rewrite_shorter".to_string(),
            DictationCommandAction::RewriteShorter(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "rewrite professional") {
        return Some((
            "rewrite_professional".to_string(),
            DictationCommandAction::RewriteProfessional(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "bulletize selection") {
        return Some((
            "bulletize_selection".to_string(),
            DictationCommandAction::Bulletize(payload.to_string()),
        ));
    }

    None
}

pub fn resolve_contextual_command_input(
    spoken_payload: &str,
    captured_context_text: Option<&str>,
    context_source: &str,
    action_label: &str,
) -> Result<String, String> {
    let spoken = spoken_payload.trim();
    if !spoken.is_empty() {
        return Ok(spoken.to_string());
    }

    if let Some(context) = captured_context_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(context.to_string());
    }

    Err(match context_source {
        "selected_text" => format!(
            "{} needs selected text, but Nautilus could not capture any selected text from the frontmost app.",
            action_label
        ),
        "clipboard" => format!(
            "{} needs clipboard text, but the clipboard was empty when dictation started.",
            action_label
        ),
        "application_context" => format!(
            "{} needs app context, but Nautilus could not capture useful text from the frontmost app.",
            action_label
        ),
        _ => format!(
            "{} needs some text to work with. Speak the text after the command or Enable Text context from clipboard or selection.",
            action_label
        ),
    })
}

pub fn default_dictation_command_prompt(command_key: &str) -> Option<&'static str> {
    match command_key {
        "rewrite_shorter" => Some(
            "Rewrite the user's text to be shorter while preserving intent. \
            Keep the same language and tone. Return only the rewritten text.",
        ),
        "rewrite_professional" => Some(
            "Rewrite the user's text in a professional tone while preserving meaning. \
            Keep it clear and concise. Return only the rewritten text.",
        ),
        "bulletize_selection" => Some(
            "Convert the user's text into concise bullet points. \
            Use one bullet per idea. Return only the bullet list.",
        ),
        _ => None,
    }
}

fn command_output(action: &DictationCommandAction, original_input: &str) -> String {
    match action {
        DictationCommandAction::InsertText(text) => text.clone(),
        DictationCommandAction::UndoLastInsert | DictationCommandAction::DeleteLastSentence => {
            String::new()
        }
        DictationCommandAction::RewriteShorter(text)
        | DictationCommandAction::RewriteProfessional(text)
        | DictationCommandAction::Bulletize(text) => {
            if text.trim().is_empty() {
                original_input.to_string()
            } else {
                text.clone()
            }
        }
    }
}

fn percentile(mut values: Vec<f64>, percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((percentile / 100.0) * values.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(values.len() - 1);
    values[index]
}

fn default_insertion_outcome(command_applied: Option<&str>) -> String {
    match command_applied {
        Some("undo_last_insert") | Some("delete_last_sentence") => "command_only".to_string(),
        _ => "pasted".to_string(),
    }
}

fn default_insertion_mode(command_applied: Option<&str>) -> String {
    match command_applied {
        Some(_) => "command_only".to_string(),
        None => "paste".to_string(),
    }
}

pub fn generate_dictation_benchmark_run(
    fixture: &DictationBenchmarkFixture,
    context: &DictationBenchmarkContext,
) -> DictationBenchmarkRun {
    let mut rows = Vec::with_capacity(fixture.scenarios.len());
    let mut insertion_successes = 0usize;
    let mut command_successes = 0usize;
    let mut command_cases = 0usize;
    let mut snippet_successes = 0usize;
    let mut snippet_cases = 0usize;

    for scenario in &fixture.scenarios {
        let prefix = scenario
            .command_prefix
            .as_deref()
            .unwrap_or(DEFAULT_COMMAND_PREFIX);
        let parsed_command = parse_dictation_command(&scenario.input_text, prefix);
        let command_applied = parsed_command
            .as_ref()
            .map(|(command_key, _)| command_key.clone());
        let command_output = parsed_command
            .as_ref()
            .map(|(_, action)| command_output(action, &scenario.input_text))
            .unwrap_or_else(|| scenario.input_text.clone());
        let (snippet_output, snippet_applied_count) = apply_dictation_snippets(
            &command_output,
            &scenario.snippets,
            Some(scenario.app_target.as_str()),
        );

        let expected_command = scenario.expected_command_applied.as_deref();
        let should_check_command = expected_command.is_some() || scenario.expect_no_command;
        if should_check_command {
            command_cases += 1;
            let matched = if scenario.expect_no_command {
                command_applied.is_none()
            } else {
                command_applied.as_deref() == expected_command
            };
            if matched {
                command_successes += 1;
            }
        }

        let should_check_snippet =
            scenario.expected_snippet_applied_count.is_some() || scenario.expected_output.is_some();
        let snippet_matches = scenario
            .expected_snippet_applied_count
            .map(|expected| expected == snippet_applied_count)
            .unwrap_or(true)
            && scenario
                .expected_output
                .as_deref()
                .map(|expected| expected == snippet_output)
                .unwrap_or(true);
        if should_check_snippet {
            snippet_cases += 1;
            if snippet_matches {
                snippet_successes += 1;
            }
        }

        let insertion_matches = scenario
            .expected_output
            .as_deref()
            .map(|expected| expected == snippet_output)
            .unwrap_or_else(|| {
                if scenario.expect_no_command {
                    command_applied.is_none()
                } else if expected_command.is_some() {
                    command_applied.as_deref() == expected_command
                } else if let Some(expected_count) = scenario.expected_snippet_applied_count {
                    expected_count == snippet_applied_count
                } else {
                    true
                }
            });
        if insertion_matches {
            insertion_successes += 1;
        }

        let scaled_transcription_latency =
            scenario.transcription_latency_ms * context.latency_scale;
        let scaled_end_to_end = scenario.end_to_end_ms * context.latency_scale;

        rows.push(DictationBenchmarkRow {
            timestamp: scenario
                .timestamp
                .clone()
                .unwrap_or_else(|| context.generated_at.clone()),
            app_target: scenario.app_target.clone(),
            requested_provider: scenario.requested_provider.clone(),
            actual_provider: scenario.actual_provider.clone(),
            is_fallback: scenario.is_fallback,
            fallback_reason: scenario.fallback_reason.clone(),
            transcription_latency_ms: scaled_transcription_latency,
            end_to_end_ms: scaled_end_to_end,
            insertion_outcome: scenario
                .insertion_outcome
                .clone()
                .unwrap_or_else(|| default_insertion_outcome(command_applied.as_deref())),
            insertion_mode_used: scenario
                .insertion_mode_used
                .clone()
                .unwrap_or_else(|| default_insertion_mode(command_applied.as_deref())),
            command_applied,
            snippet_applied_count,
        });
    }

    let end_to_end_values = rows.iter().map(|row| row.end_to_end_ms).collect::<Vec<_>>();
    let sample_count = rows.len();

    DictationBenchmarkRun {
        schema_version: "1.0".to_string(),
        run_id: context.run_id.clone(),
        generated_at: context.generated_at.clone(),
        build: DictationBenchmarkBuild {
            version: context.build_version.clone(),
            commit: context.build_commit.clone(),
        },
        platform: DictationBenchmarkPlatform {
            os: context.platform_os.clone(),
            os_version: context.platform_os_version.clone(),
            device: context.device.clone(),
        },
        rows,
        summary: DictationBenchmarkSummary {
            sample_count,
            insertion_success_rate: if sample_count == 0 {
                0.0
            } else {
                insertion_successes as f64 / sample_count as f64
            },
            command_success_rate: if command_cases == 0 {
                1.0
            } else {
                command_successes as f64 / command_cases as f64
            },
            snippet_success_rate: if snippet_cases == 0 {
                1.0
            } else {
                snippet_successes as f64 / snippet_cases as f64
            },
            p50_end_to_end_ms: percentile(end_to_end_values.clone(), 50.0),
            p95_end_to_end_ms: percentile(end_to_end_values, 95.0),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_replacements_respect_word_boundaries_and_longest_match() {
        let rules = vec![
            DictionaryRule {
                spoken_form: "open".to_string(),
                replacement: "OPEN".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
            },
            DictionaryRule {
                spoken_form: "open ai".to_string(),
                replacement: "OpenAI".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
            },
        ];

        let (output, applied) = apply_dictation_dictionary(
            "please email open ai today and reopen the task",
            &rules,
            None,
        );
        assert_eq!(output, "please email OpenAI today and reopen the task");
        assert_eq!(applied, 1);
    }

    #[test]
    fn dictionary_replacements_respect_app_scope_matching() {
        let rules = vec![DictionaryRule {
            spoken_form: "follow up".to_string(),
            replacement: "follow-up".to_string(),
            app_scope: Some("gmail".to_string()),
            case_sensitive: false,
            enabled: true,
        }];

        let (non_matching, non_matching_count) =
            apply_dictation_dictionary("follow up tomorrow", &rules, Some("Slack"));
        assert_eq!(non_matching, "follow up tomorrow");
        assert_eq!(non_matching_count, 0);

        let (matching, matching_count) =
            apply_dictation_dictionary("follow up tomorrow", &rules, Some("Gmail"));
        assert_eq!(matching, "follow-up tomorrow");
        assert_eq!(matching_count, 1);
    }

    #[test]
    fn fixture_benchmark_run_summarizes_command_and_snippet_success() {
        let fixture = DictationBenchmarkFixture {
            schema_version: "1.0".to_string(),
            scenarios: vec![
                DictationBenchmarkScenario {
                    app_target: "Apple Notes".to_string(),
                    requested_provider: "distil_whisper".to_string(),
                    actual_provider: "distil_whisper".to_string(),
                    is_fallback: false,
                    fallback_reason: None,
                    transcription_latency_ms: 120.0,
                    end_to_end_ms: 220.0,
                    input_text: "command newline".to_string(),
                    command_prefix: None,
                    snippets: Vec::new(),
                    expected_command_applied: Some("newline".to_string()),
                    expect_no_command: false,
                    expected_snippet_applied_count: None,
                    expected_output: Some("\n".to_string()),
                    insertion_outcome: None,
                    insertion_mode_used: None,
                    timestamp: None,
                },
                DictationBenchmarkScenario {
                    app_target: "Slack".to_string(),
                    requested_provider: "voxtral".to_string(),
                    actual_provider: "distil_whisper".to_string(),
                    is_fallback: true,
                    fallback_reason: Some("provider_unavailable".to_string()),
                    transcription_latency_ms: 160.0,
                    end_to_end_ms: 280.0,
                    input_text: "brb".to_string(),
                    command_prefix: None,
                    snippets: vec![SnippetRule {
                        trigger: "brb".to_string(),
                        expansion: "be right back".to_string(),
                        app_scope: Some("slack".to_string()),
                        case_sensitive: false,
                        enabled: true,
                    }],
                    expected_command_applied: None,
                    expect_no_command: true,
                    expected_snippet_applied_count: Some(1),
                    expected_output: Some("be right back".to_string()),
                    insertion_outcome: None,
                    insertion_mode_used: None,
                    timestamp: None,
                },
            ],
        };

        let context = DictationBenchmarkContext {
            run_id: "fixture-run".to_string(),
            generated_at: "2026-03-06T12:00:00Z".to_string(),
            build_version: "nautilus-dev".to_string(),
            build_commit: "abcdef1".to_string(),
            platform_os: "macOS".to_string(),
            platform_os_version: "14.0".to_string(),
            device: "Fixture Device".to_string(),
            latency_scale: 1.0,
        };

        let run = generate_dictation_benchmark_run(&fixture, &context);
        assert_eq!(run.summary.sample_count, 2);
        assert_eq!(run.summary.command_success_rate, 1.0);
        assert_eq!(run.summary.snippet_success_rate, 1.0);
        assert_eq!(run.rows[0].command_applied.as_deref(), Some("newline"));
        assert_eq!(run.rows[1].snippet_applied_count, 1);
        assert_eq!(run.rows[1].actual_provider, "distil_whisper");
        assert!(run.rows[1].is_fallback);
    }
}
