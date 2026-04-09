use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use nautilus_bot_lib::dictation_parity::{
    apply_contextual_phrase_replacement, apply_dictation_dictionary, apply_dictation_snippets,
    parse_dictation_command, DictationBenchmarkFixture, DictionaryRule, DEFAULT_COMMAND_PREFIX,
};
use nautilus_bot_lib::text::format::smart_format_dictation_text_for_app;
use serde::{Deserialize, Serialize};

fn value_for(args: &[String], name: &str, fallback: Option<&str>) -> Option<String> {
    args.windows(2)
        .find_map(|window| (window[0] == name).then(|| window[1].clone()))
        .or_else(|| fallback.map(ToString::to_string))
}

fn required_value(args: &[String], name: &str) -> Result<String> {
    value_for(args, name, None).with_context(|| format!("missing required argument: {name}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DictationParityEvidenceFixture {
    #[serde(default)]
    dictionary_cases: Vec<DictionaryFixtureCase>,
    #[serde(default)]
    formatting_cases: Vec<FormattingFixtureCase>,
    #[serde(default)]
    correction_cases: Vec<CorrectionFixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryFixtureCase {
    id: String,
    label: String,
    language: String,
    app_target: Option<String>,
    input_text: String,
    rules: Vec<DictionaryRule>,
    expected_output: String,
    expected_applied_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormattingFixtureCase {
    id: String,
    label: String,
    mode_preset: String,
    formatting_hint: Option<String>,
    input_text: String,
    expected_output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorrectionFixtureCase {
    id: String,
    label: String,
    input_text: String,
    target: String,
    replacement: String,
    expected_output: String,
    expected_applied_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationParityEvidenceReport {
    generated_at: String,
    command_cases: Vec<CommandEvidenceCase>,
    snippet_cases: Vec<SnippetEvidenceCase>,
    dictionary_cases: Vec<DictionaryEvidenceCase>,
    formatting_cases: Vec<FormattingEvidenceCase>,
    correction_cases: Vec<CorrectionEvidenceCase>,
    summary: DictationParityEvidenceSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandEvidenceCase {
    id: String,
    label: String,
    app_target: String,
    language: Option<String>,
    input_text: String,
    expected_command: Option<String>,
    expect_no_command: bool,
    actual_command: Option<String>,
    pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnippetEvidenceCase {
    id: String,
    label: String,
    app_target: String,
    language: Option<String>,
    input_text: String,
    expected_snippet_applied_count: Option<usize>,
    actual_snippet_applied_count: usize,
    expected_output: Option<String>,
    actual_output: String,
    pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryEvidenceCase {
    id: String,
    label: String,
    language: String,
    app_target: Option<String>,
    input_text: String,
    expected_output: String,
    actual_output: String,
    expected_applied_count: usize,
    actual_applied_count: usize,
    pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormattingEvidenceCase {
    id: String,
    label: String,
    mode_preset: String,
    formatting_hint: Option<String>,
    input_text: String,
    expected_output: String,
    actual_output: String,
    pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorrectionEvidenceCase {
    id: String,
    label: String,
    input_text: String,
    target: String,
    replacement: String,
    expected_output: String,
    actual_output: String,
    expected_applied_count: usize,
    actual_applied_count: usize,
    pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationParityEvidenceSummary {
    command_success_rate: f64,
    snippet_success_rate: f64,
    dictionary_success_rate: f64,
    formatting_success_rate: f64,
    correction_success_rate: f64,
    all_pass: bool,
}

fn success_rate(pass_count: usize, total: usize) -> f64 {
    if total == 0 {
        1.0
    } else {
        pass_count as f64 / total as f64
    }
}

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    let benchmark_fixture_path = PathBuf::from(required_value(&args, "--benchmark-fixtures")?);
    let evidence_fixture_path = PathBuf::from(required_value(&args, "--evidence-fixtures")?);
    let output_path = PathBuf::from(required_value(&args, "--out")?);
    let generated_at = required_value(&args, "--generated-at")?;

    let benchmark_fixture = serde_json::from_slice::<DictationBenchmarkFixture>(
        &fs::read(&benchmark_fixture_path).with_context(|| {
            format!(
                "failed to read benchmark fixture file {}",
                benchmark_fixture_path.display()
            )
        })?,
    )
    .with_context(|| {
        format!(
            "failed to parse benchmark fixture file {}",
            benchmark_fixture_path.display()
        )
    })?;

    let evidence_fixture = serde_json::from_slice::<DictationParityEvidenceFixture>(
        &fs::read(&evidence_fixture_path).with_context(|| {
            format!(
                "failed to read evidence fixture file {}",
                evidence_fixture_path.display()
            )
        })?,
    )
    .with_context(|| {
        format!(
            "failed to parse evidence fixture file {}",
            evidence_fixture_path.display()
        )
    })?;

    let command_cases = benchmark_fixture
        .scenarios
        .iter()
        .enumerate()
        .filter(|(_, scenario)| {
            scenario.expected_command_applied.is_some() || scenario.expect_no_command
        })
        .map(|(index, scenario)| {
            let prefix = scenario
                .command_prefix
                .as_deref()
                .unwrap_or(DEFAULT_COMMAND_PREFIX);
            let parsed = parse_dictation_command(&scenario.input_text, prefix);
            let actual_command = parsed.as_ref().map(|(command_key, _)| command_key.clone());
            let pass = if scenario.expect_no_command {
                actual_command.is_none()
            } else {
                actual_command.as_deref() == scenario.expected_command_applied.as_deref()
            };

            CommandEvidenceCase {
                id: scenario
                    .scenario_id
                    .clone()
                    .unwrap_or_else(|| format!("command-case-{}", index + 1)),
                label: scenario
                    .scenario_label
                    .clone()
                    .unwrap_or_else(|| scenario.input_text.clone()),
                app_target: scenario.app_target.clone(),
                language: scenario.language.clone(),
                input_text: scenario.input_text.clone(),
                expected_command: scenario.expected_command_applied.clone(),
                expect_no_command: scenario.expect_no_command,
                actual_command,
                pass,
            }
        })
        .collect::<Vec<_>>();

    let snippet_cases = benchmark_fixture
        .scenarios
        .iter()
        .enumerate()
        .filter(|(_, scenario)| {
            !scenario.snippets.is_empty() || scenario.expected_snippet_applied_count.is_some()
        })
        .map(|(index, scenario)| {
            let (actual_output, actual_snippet_applied_count) = apply_dictation_snippets(
                &scenario.input_text,
                &scenario.snippets,
                Some(scenario.app_target.as_str()),
            );
            let pass = scenario
                .expected_snippet_applied_count
                .map(|expected| expected == actual_snippet_applied_count)
                .unwrap_or(true)
                && scenario
                    .expected_output
                    .as_deref()
                    .map(|expected| expected == actual_output)
                    .unwrap_or(true);

            SnippetEvidenceCase {
                id: scenario
                    .scenario_id
                    .clone()
                    .unwrap_or_else(|| format!("snippet-case-{}", index + 1)),
                label: scenario
                    .scenario_label
                    .clone()
                    .unwrap_or_else(|| scenario.input_text.clone()),
                app_target: scenario.app_target.clone(),
                language: scenario.language.clone(),
                input_text: scenario.input_text.clone(),
                expected_snippet_applied_count: scenario.expected_snippet_applied_count,
                actual_snippet_applied_count,
                expected_output: scenario.expected_output.clone(),
                actual_output,
                pass,
            }
        })
        .collect::<Vec<_>>();

    let dictionary_cases = evidence_fixture
        .dictionary_cases
        .iter()
        .map(|fixture| {
            let (actual_output, actual_applied_count) = apply_dictation_dictionary(
                &fixture.input_text,
                &fixture.rules,
                fixture.app_target.as_deref(),
            );
            let pass = actual_output == fixture.expected_output
                && actual_applied_count == fixture.expected_applied_count;

            DictionaryEvidenceCase {
                id: fixture.id.clone(),
                label: fixture.label.clone(),
                language: fixture.language.clone(),
                app_target: fixture.app_target.clone(),
                input_text: fixture.input_text.clone(),
                expected_output: fixture.expected_output.clone(),
                actual_output,
                expected_applied_count: fixture.expected_applied_count,
                actual_applied_count,
                pass,
            }
        })
        .collect::<Vec<_>>();

    let formatting_cases = evidence_fixture
        .formatting_cases
        .iter()
        .map(|fixture| {
            let actual_output = smart_format_dictation_text_for_app(
                &fixture.input_text,
                &fixture.mode_preset,
                fixture.formatting_hint.as_deref(),
            );
            let pass = actual_output == fixture.expected_output;

            FormattingEvidenceCase {
                id: fixture.id.clone(),
                label: fixture.label.clone(),
                mode_preset: fixture.mode_preset.clone(),
                formatting_hint: fixture.formatting_hint.clone(),
                input_text: fixture.input_text.clone(),
                expected_output: fixture.expected_output.clone(),
                actual_output,
                pass,
            }
        })
        .collect::<Vec<_>>();

    let correction_cases = evidence_fixture
        .correction_cases
        .iter()
        .map(|fixture| {
            let (actual_output, actual_applied_count) = apply_contextual_phrase_replacement(
                &fixture.input_text,
                &fixture.target,
                &fixture.replacement,
            )
            .unwrap_or_else(|_| (fixture.input_text.clone(), 0));
            let pass = actual_output == fixture.expected_output
                && actual_applied_count == fixture.expected_applied_count;

            CorrectionEvidenceCase {
                id: fixture.id.clone(),
                label: fixture.label.clone(),
                input_text: fixture.input_text.clone(),
                target: fixture.target.clone(),
                replacement: fixture.replacement.clone(),
                expected_output: fixture.expected_output.clone(),
                actual_output,
                expected_applied_count: fixture.expected_applied_count,
                actual_applied_count,
                pass,
            }
        })
        .collect::<Vec<_>>();

    let command_pass_count = command_cases.iter().filter(|item| item.pass).count();
    let snippet_pass_count = snippet_cases.iter().filter(|item| item.pass).count();
    let dictionary_pass_count = dictionary_cases.iter().filter(|item| item.pass).count();
    let formatting_pass_count = formatting_cases.iter().filter(|item| item.pass).count();
    let correction_pass_count = correction_cases.iter().filter(|item| item.pass).count();
    let command_case_count = report_case_len(&command_cases);
    let snippet_case_count = report_case_len(&snippet_cases);
    let dictionary_case_count = report_case_len(&dictionary_cases);
    let formatting_case_count = report_case_len(&formatting_cases);
    let correction_case_count = report_case_len(&correction_cases);
    let all_pass = command_cases.iter().all(|item| item.pass)
        && snippet_cases.iter().all(|item| item.pass)
        && dictionary_cases.iter().all(|item| item.pass)
        && formatting_cases.iter().all(|item| item.pass)
        && correction_cases.iter().all(|item| item.pass);

    let report = DictationParityEvidenceReport {
        generated_at,
        command_cases,
        snippet_cases,
        dictionary_cases,
        formatting_cases,
        correction_cases,
        summary: DictationParityEvidenceSummary {
            command_success_rate: success_rate(command_pass_count, command_case_count),
            snippet_success_rate: success_rate(snippet_pass_count, snippet_case_count),
            dictionary_success_rate: success_rate(dictionary_pass_count, dictionary_case_count),
            formatting_success_rate: success_rate(formatting_pass_count, formatting_case_count),
            correction_success_rate: success_rate(correction_pass_count, correction_case_count),
            all_pass,
        },
    };

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }

    fs::write(
        &output_path,
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )
    .with_context(|| format!("failed to write output file {}", output_path.display()))?;

    println!("{}", output_path.display());
    Ok(())
}

fn report_case_len<T>(cases: &[T]) -> usize {
    cases.len()
}
