#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const DEFAULT_COMMAND_PREFIX: &str = "command";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationCommandAction {
    InsertText(String),
    UndoLastInsert,
    DeleteLastSentence,
    ReplaceEntireSelection(String),
    ReplaceSelection { target: String, replacement: String },
    AppendToSelection(String),
    PrependToSelection(String),
    DeletePhrase(String),
    DeleteSelection,
    UppercaseSelection,
    LowercaseSelection,
    TitleCaseSelection,
    SentenceCaseSelection,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearnedCorrectionCandidate {
    pub spoken_form: String,
    pub replacement: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenario_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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

fn normalize_correction_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_phrase_edges(value: &str) -> String {
    value
        .trim_matches(|ch: char| !(ch.is_alphanumeric() || ch == '\'' || ch == '-'))
        .trim()
        .to_string()
}

fn contains_alpha_numeric(value: &str) -> bool {
    value.chars().any(|ch| ch.is_alphanumeric())
}

fn looks_like_auto_learning_safe_phrase(value: &str) -> bool {
    let words = value.split_whitespace().count();
    !value.is_empty() && words <= 4 && value.chars().count() <= 48 && contains_alpha_numeric(value)
}

fn auto_learning_guard_rejects_apostrophe_phrase(value: &str) -> bool {
    value.contains('\'') && !value.chars().any(|ch| ch.is_uppercase())
}

pub fn infer_learned_correction(
    original_text: &str,
    corrected_text: &str,
    force: bool,
) -> Result<LearnedCorrectionCandidate, String> {
    let original = normalize_correction_text(original_text);
    let corrected = normalize_correction_text(corrected_text);

    if original.is_empty() || corrected.is_empty() {
        return Err("Correction text cannot be empty".to_string());
    }

    if original == corrected {
        return Err("No correction detected".to_string());
    }

    let original_tokens = original.split_whitespace().collect::<Vec<_>>();
    let corrected_tokens = corrected.split_whitespace().collect::<Vec<_>>();

    let mut prefix_len = 0usize;
    while prefix_len < original_tokens.len()
        && prefix_len < corrected_tokens.len()
        && original_tokens[prefix_len].eq_ignore_ascii_case(corrected_tokens[prefix_len])
    {
        prefix_len += 1;
    }

    let mut original_suffix_len = original_tokens.len();
    let mut corrected_suffix_len = corrected_tokens.len();
    while original_suffix_len > prefix_len
        && corrected_suffix_len > prefix_len
        && original_tokens[original_suffix_len - 1]
            .eq_ignore_ascii_case(corrected_tokens[corrected_suffix_len - 1])
    {
        original_suffix_len -= 1;
        corrected_suffix_len -= 1;
    }

    if prefix_len > 0 {
        let previous_original = original_tokens[prefix_len - 1];
        let previous_corrected = corrected_tokens[prefix_len - 1];
        let case_only_match = previous_original.eq_ignore_ascii_case(previous_corrected)
            && previous_original != previous_corrected;
        let looks_like_named_phrase = previous_original
            .chars()
            .chain(previous_corrected.chars())
            .any(|ch| ch.is_uppercase());
        if case_only_match && looks_like_named_phrase {
            prefix_len -= 1;
        }
    }

    let original_middle =
        trim_phrase_edges(&original_tokens[prefix_len..original_suffix_len].join(" "));
    let corrected_middle =
        trim_phrase_edges(&corrected_tokens[prefix_len..corrected_suffix_len].join(" "));

    if original_middle.is_empty() || corrected_middle.is_empty() {
        return Err("Correction did not resolve to a safe replacement span".to_string());
    }

    if !looks_like_auto_learning_safe_phrase(&original_middle)
        || !looks_like_auto_learning_safe_phrase(&corrected_middle)
    {
        return Err("Correction was larger than the safe auto-learn window".to_string());
    }

    if !force && auto_learning_guard_rejects_apostrophe_phrase(&corrected_middle) {
        return Err("Skipping contraction or possessive correction for auto-learn".to_string());
    }

    if original_middle.eq_ignore_ascii_case(&corrected_middle)
        && original_middle == corrected_middle
    {
        return Err("No correction detected".to_string());
    }

    Ok(LearnedCorrectionCandidate {
        spoken_form: original_middle,
        replacement: corrected_middle,
    })
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

fn trim_command_value(raw: &str) -> &str {
    raw.trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`'))
        .trim()
}

fn join_with_spacing(left: &str, right: &str) -> String {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() {
        return right.to_string();
    }
    if right.is_empty() {
        return left.to_string();
    }

    let needs_space = left
        .chars()
        .last()
        .map(|ch| ch.is_alphanumeric())
        .unwrap_or(false)
        && right
            .chars()
            .next()
            .map(|ch| ch.is_alphanumeric())
            .unwrap_or(false);

    if needs_space {
        format!("{} {}", left, right)
    } else {
        format!("{}{}", left, right)
    }
}

fn parse_phrase_swap_command(raw: &str, verb: &str, joiner: &str) -> Option<(String, String)> {
    let payload = command_payload(raw, verb)?;
    let normalized = payload.to_ascii_lowercase();
    let delimiter = format!(" {} ", joiner);
    let boundary = normalized.find(&delimiter)?;
    let target = trim_command_value(payload.get(..boundary)?);
    let replacement = trim_command_value(payload.get(boundary + delimiter.len()..)?);
    if target.is_empty() || replacement.is_empty() {
        return None;
    }
    Some((target.to_string(), replacement.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionCaseTransform {
    Uppercase,
    Lowercase,
    TitleCase,
    SentenceCase,
}

fn apply_selection_case_transform(
    input: &str,
    transform: SelectionCaseTransform,
) -> Result<String, String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Change Case needs some text to work with.".to_string());
    }

    Ok(match transform {
        SelectionCaseTransform::Uppercase => source.to_uppercase(),
        SelectionCaseTransform::Lowercase => source.to_lowercase(),
        SelectionCaseTransform::TitleCase => title_case_text(source),
        SelectionCaseTransform::SentenceCase => sentence_case_text(source),
    })
}

fn title_case_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut start_of_word = true;

    for ch in input.chars() {
        if ch.is_alphanumeric() {
            if start_of_word {
                output.extend(ch.to_uppercase());
                start_of_word = false;
            } else {
                output.extend(ch.to_lowercase());
            }
            continue;
        }

        output.push(ch);
        start_of_word = ch != '\'';
    }

    output
}

fn sentence_case_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut capitalize_next = true;

    for ch in input.chars() {
        if ch.is_alphabetic() {
            if capitalize_next {
                output.extend(ch.to_uppercase());
                capitalize_next = false;
            } else {
                output.extend(ch.to_lowercase());
            }
            continue;
        }

        output.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n') {
            capitalize_next = true;
        }
    }

    output
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
    if remainder.eq_ignore_ascii_case("undo that")
        || remainder.eq_ignore_ascii_case("undo it")
        || remainder.eq_ignore_ascii_case("scratch that")
        || remainder.eq_ignore_ascii_case("never mind")
    {
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
    if let Some(payload) = command_payload(&remainder, "replace selection with") {
        return Some((
            "replace_selection_text".to_string(),
            DictationCommandAction::ReplaceEntireSelection(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "replace that with") {
        return Some((
            "replace_selection_text".to_string(),
            DictationCommandAction::ReplaceEntireSelection(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "change that to") {
        return Some((
            "replace_selection_text".to_string(),
            DictationCommandAction::ReplaceEntireSelection(payload.to_string()),
        ));
    }
    if let Some((target, replacement)) = parse_phrase_swap_command(&remainder, "replace", "with") {
        return Some((
            "replace_selection".to_string(),
            DictationCommandAction::ReplaceSelection {
                target,
                replacement,
            },
        ));
    }
    if let Some((target, replacement)) = parse_phrase_swap_command(&remainder, "change", "to") {
        return Some((
            "replace_selection".to_string(),
            DictationCommandAction::ReplaceSelection {
                target,
                replacement,
            },
        ));
    }
    if let Some(payload) = command_payload(&remainder, "append") {
        return Some((
            "append_to_selection".to_string(),
            DictationCommandAction::AppendToSelection(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "prepend") {
        return Some((
            "prepend_to_selection".to_string(),
            DictationCommandAction::PrependToSelection(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "delete phrase") {
        return Some((
            "delete_phrase".to_string(),
            DictationCommandAction::DeletePhrase(payload.to_string()),
        ));
    }
    if let Some(payload) = command_payload(&remainder, "remove phrase") {
        return Some((
            "delete_phrase".to_string(),
            DictationCommandAction::DeletePhrase(payload.to_string()),
        ));
    }
    if remainder.eq_ignore_ascii_case("delete selection")
        || remainder.eq_ignore_ascii_case("clear selection")
    {
        return Some((
            "delete_selection".to_string(),
            DictationCommandAction::DeleteSelection,
        ));
    }
    if remainder.eq_ignore_ascii_case("uppercase selection")
        || remainder.eq_ignore_ascii_case("make that uppercase")
    {
        return Some((
            "uppercase_selection".to_string(),
            DictationCommandAction::UppercaseSelection,
        ));
    }
    if remainder.eq_ignore_ascii_case("lowercase selection")
        || remainder.eq_ignore_ascii_case("make that lowercase")
    {
        return Some((
            "lowercase_selection".to_string(),
            DictationCommandAction::LowercaseSelection,
        ));
    }
    if remainder.eq_ignore_ascii_case("title case selection")
        || remainder.eq_ignore_ascii_case("make that title case")
    {
        return Some((
            "title_case_selection".to_string(),
            DictationCommandAction::TitleCaseSelection,
        ));
    }
    if remainder.eq_ignore_ascii_case("sentence case selection")
        || remainder.eq_ignore_ascii_case("make that sentence case")
    {
        return Some((
            "sentence_case_selection".to_string(),
            DictationCommandAction::SentenceCaseSelection,
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

pub fn apply_contextual_phrase_replacement(
    input: &str,
    target: &str,
    replacement: &str,
) -> Result<(String, usize), String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Replace Text needs some text to work with.".to_string());
    }

    let trimmed_target = trim_command_value(target);
    if trimmed_target.is_empty() {
        return Err("Replace Text needs a phrase to replace.".to_string());
    }

    let trimmed_replacement = trim_command_value(replacement);
    if trimmed_replacement.is_empty() {
        return Err("Replace Text needs replacement text.".to_string());
    }

    let (output, applied) =
        replace_case_insensitive_all(source, trimmed_target, trimmed_replacement);
    if applied == 0 {
        return Err(format!(
            "Replace Text could not find '{}' in the current text.",
            trimmed_target
        ));
    }

    Ok((output, applied))
}

pub fn replace_context_selection(input: &str, replacement: &str) -> Result<String, String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Replace Text needs some text to work with.".to_string());
    }

    let replacement = trim_command_value(replacement);
    if replacement.is_empty() {
        return Err("Replace Text needs replacement text.".to_string());
    }

    Ok(replacement.to_string())
}

pub fn append_to_context_selection(input: &str, suffix: &str) -> Result<String, String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Append Text needs some text to work with.".to_string());
    }

    let suffix = trim_command_value(suffix);
    if suffix.is_empty() {
        return Err("Append Text needs the text to append.".to_string());
    }

    Ok(join_with_spacing(source, suffix))
}

pub fn prepend_to_context_selection(input: &str, prefix: &str) -> Result<String, String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Prepend Text needs some text to work with.".to_string());
    }

    let prefix = trim_command_value(prefix);
    if prefix.is_empty() {
        return Err("Prepend Text needs the text to prepend.".to_string());
    }

    Ok(join_with_spacing(prefix, source))
}

pub fn delete_phrase_from_context(input: &str, target: &str) -> Result<(String, usize), String> {
    let source = input.trim();
    if source.is_empty() {
        return Err("Delete Phrase needs some text to work with.".to_string());
    }

    let target = trim_command_value(target);
    if target.is_empty() {
        return Err("Delete Phrase needs a phrase to remove.".to_string());
    }

    let (output, applied) = replace_case_insensitive_all(source, target, "");
    if applied == 0 {
        return Err(format!(
            "Delete Phrase could not find '{}' in the current text.",
            target
        ));
    }

    let normalized = regex::Regex::new(r"\s+([,.;:!?])")
        .expect("valid punctuation whitespace regex")
        .replace_all(&output, "$1")
        .to_string();
    let normalized = regex::Regex::new(r"[ \t]{2,}")
        .expect("valid repeated spaces regex")
        .replace_all(&normalized, " ")
        .to_string();

    Ok((normalized.trim().to_string(), applied))
}

pub fn uppercase_context_selection(input: &str) -> Result<String, String> {
    apply_selection_case_transform(input, SelectionCaseTransform::Uppercase)
}

pub fn lowercase_context_selection(input: &str) -> Result<String, String> {
    apply_selection_case_transform(input, SelectionCaseTransform::Lowercase)
}

pub fn title_case_context_selection(input: &str) -> Result<String, String> {
    apply_selection_case_transform(input, SelectionCaseTransform::TitleCase)
}

pub fn sentence_case_context_selection(input: &str) -> Result<String, String> {
    apply_selection_case_transform(input, SelectionCaseTransform::SentenceCase)
}

fn command_output(action: &DictationCommandAction, original_input: &str) -> String {
    match action {
        DictationCommandAction::InsertText(text) => text.clone(),
        DictationCommandAction::UndoLastInsert | DictationCommandAction::DeleteLastSentence => {
            String::new()
        }
        DictationCommandAction::ReplaceEntireSelection(_)
        | DictationCommandAction::ReplaceSelection { .. }
        | DictationCommandAction::AppendToSelection(_)
        | DictationCommandAction::PrependToSelection(_)
        | DictationCommandAction::DeletePhrase(_)
        | DictationCommandAction::DeleteSelection
        | DictationCommandAction::UppercaseSelection
        | DictationCommandAction::LowercaseSelection
        | DictationCommandAction::TitleCaseSelection
        | DictationCommandAction::SentenceCaseSelection => original_input.to_string(),
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
        Some("undo_last_insert") | Some("delete_last_sentence") => "command_only".to_string(),
        _ => "paste".to_string(),
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
            scenario_id: scenario.scenario_id.clone(),
            scenario_label: scenario.scenario_label.clone(),
            language: scenario.language.clone(),
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
                    scenario_id: Some("command-newline".to_string()),
                    scenario_label: Some("Command newline".to_string()),
                    language: Some("en".to_string()),
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
                    scenario_id: Some("snippet-slack".to_string()),
                    scenario_label: Some("Slack snippet expansion".to_string()),
                    language: Some("en".to_string()),
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

    #[test]
    fn parse_dictation_command_supports_undo_synonyms() {
        let (command, action) =
            parse_dictation_command("command scratch that", DEFAULT_COMMAND_PREFIX)
                .expect("parses synonym");
        assert_eq!(command, "undo_last_insert");
        assert_eq!(action, DictationCommandAction::UndoLastInsert);
    }

    #[test]
    fn parse_dictation_command_supports_replace_selection() {
        let (command, action) = parse_dictation_command(
            "command replace roadmap with launch plan",
            DEFAULT_COMMAND_PREFIX,
        )
        .expect("parses replace command");
        assert_eq!(command, "replace_selection");
        assert_eq!(
            action,
            DictationCommandAction::ReplaceSelection {
                target: "roadmap".to_string(),
                replacement: "launch plan".to_string(),
            }
        );
    }

    #[test]
    fn parse_dictation_command_supports_replace_entire_selection() {
        let (command, action) = parse_dictation_command(
            "command replace selection with approved launch plan",
            DEFAULT_COMMAND_PREFIX,
        )
        .expect("parses replace selection text command");
        assert_eq!(command, "replace_selection_text");
        assert_eq!(
            action,
            DictationCommandAction::ReplaceEntireSelection("approved launch plan".to_string())
        );
    }

    #[test]
    fn parse_dictation_command_supports_append_prepend_and_delete_phrase() {
        let (append_command, append_action) =
            parse_dictation_command("command append thanks", DEFAULT_COMMAND_PREFIX)
                .expect("parses append");
        assert_eq!(append_command, "append_to_selection");
        assert_eq!(
            append_action,
            DictationCommandAction::AppendToSelection("thanks".to_string())
        );

        let (prepend_command, prepend_action) =
            parse_dictation_command("command prepend please", DEFAULT_COMMAND_PREFIX)
                .expect("parses prepend");
        assert_eq!(prepend_command, "prepend_to_selection");
        assert_eq!(
            prepend_action,
            DictationCommandAction::PrependToSelection("please".to_string())
        );

        let (delete_command, delete_action) =
            parse_dictation_command("command delete phrase roadmap", DEFAULT_COMMAND_PREFIX)
                .expect("parses delete phrase");
        assert_eq!(delete_command, "delete_phrase");
        assert_eq!(
            delete_action,
            DictationCommandAction::DeletePhrase("roadmap".to_string())
        );
    }

    #[test]
    fn parse_dictation_command_supports_case_transform_commands() {
        let (uppercase_command, uppercase_action) =
            parse_dictation_command("command uppercase selection", DEFAULT_COMMAND_PREFIX)
                .expect("parses uppercase selection");
        assert_eq!(uppercase_command, "uppercase_selection");
        assert_eq!(uppercase_action, DictationCommandAction::UppercaseSelection);

        let (title_case_command, title_case_action) =
            parse_dictation_command("command make that title case", DEFAULT_COMMAND_PREFIX)
                .expect("parses title case synonym");
        assert_eq!(title_case_command, "title_case_selection");
        assert_eq!(
            title_case_action,
            DictationCommandAction::TitleCaseSelection
        );

        let (sentence_case_command, sentence_case_action) =
            parse_dictation_command("command sentence case selection", DEFAULT_COMMAND_PREFIX)
                .expect("parses sentence case selection");
        assert_eq!(sentence_case_command, "sentence_case_selection");
        assert_eq!(
            sentence_case_action,
            DictationCommandAction::SentenceCaseSelection
        );
    }

    #[test]
    fn apply_contextual_phrase_replacement_is_case_insensitive() {
        let (output, applied) = apply_contextual_phrase_replacement(
            "Roadmap review for the roadmap team",
            "roadmap",
            "launch plan",
        )
        .expect("replacement succeeds");
        assert_eq!(output, "launch plan review for the launch plan team");
        assert_eq!(applied, 2);
    }

    #[test]
    fn append_and_prepend_context_selection_keep_spacing_clean() {
        let appended =
            append_to_context_selection("approved plan", "today").expect("append succeeds");
        assert_eq!(appended, "approved plan today");

        let prepended =
            prepend_to_context_selection("approved plan", "Please").expect("prepend succeeds");
        assert_eq!(prepended, "Please approved plan");
    }

    #[test]
    fn delete_phrase_from_context_removes_matches_and_cleans_spacing() {
        let (output, applied) = delete_phrase_from_context(
            "Please remove roadmap, then share the roadmap update.",
            "roadmap",
        )
        .expect("delete phrase succeeds");
        assert_eq!(output, "Please remove, then share the update.");
        assert_eq!(applied, 2);
    }

    #[test]
    fn selection_case_transforms_apply_deterministically() {
        let uppercase = uppercase_context_selection("launch update").expect("uppercase succeeds");
        assert_eq!(uppercase, "LAUNCH UPDATE");

        let lowercase = lowercase_context_selection("Launch UPDATE").expect("lowercase succeeds");
        assert_eq!(lowercase, "launch update");

        let title_case = title_case_context_selection("follow-up for o'neil and ACME")
            .expect("title case succeeds");
        assert_eq!(title_case, "Follow-Up For O'neil And Acme");

        let sentence_case = sentence_case_context_selection("SHIP IT. please REVIEW this!")
            .expect("sentence case succeeds");
        assert_eq!(sentence_case, "Ship it. Please review this!");
    }

    #[test]
    fn infer_learned_correction_extracts_single_word_fix() {
        let candidate = infer_learned_correction(
            "please email jon tomorrow",
            "please email John tomorrow",
            false,
        )
        .expect("infers proper-name correction");
        assert_eq!(candidate.spoken_form, "jon");
        assert_eq!(candidate.replacement, "John");
    }

    #[test]
    fn infer_learned_correction_extracts_short_phrase_fix() {
        let candidate = infer_learned_correction(
            "send to launch pad account",
            "send to Launch Plan account",
            false,
        )
        .expect("infers short phrase correction");
        assert_eq!(candidate.spoken_form, "launch pad");
        assert_eq!(candidate.replacement, "Launch Plan");
    }

    #[test]
    fn infer_learned_correction_rejects_large_rewrites() {
        let error = infer_learned_correction(
            "quick status update for the roadmap",
            "Here is a concise project update with next steps and blockers",
            false,
        )
        .expect_err("rejects rewrite");
        assert!(error.contains("safe auto-learn window"));
    }

    #[test]
    fn infer_learned_correction_rejects_contractions_for_auto_learn() {
        let error =
            infer_learned_correction("we are", "we're", false).expect_err("rejects contraction");
        assert!(error.contains("Skipping contraction"));

        let forced =
            infer_learned_correction("we are", "we're", true).expect("manual learn can force");
        assert_eq!(forced.spoken_form, "we are");
        assert_eq!(forced.replacement, "we're");
    }
}
