use crate::dictation_parity::{apply_contextual_phrase_replacement, DictionaryRule, SnippetRule};
use crate::models::{DictationDictionaryEntry, DictationSnippet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictationPipelineResult {
    pub text: String,
    pub command_applied: Option<String>,
    pub dictionary_applied_count: usize,
    pub snippet_applied_count: usize,
    pub formatting_applied: bool,
    pub recent_insert_reused: bool,
    pub pipeline_stage_keys: Vec<String>,
    pub undo_previous_insert: bool,
}

pub struct DictationPipelineInput<'a> {
    pub text: &'a str,
    pub dictionary_entries: &'a [DictationDictionaryEntry],
    pub snippets: &'a [DictationSnippet],
    pub app_target: Option<&'a str>,
    pub mode_preset: &'a str,
    pub formatting_hint: Option<&'a str>,
    pub smart_formatting_enabled: bool,
    pub recent_inserted_text: Option<&'a str>,
}

pub fn apply_dictation_pipeline(input: DictationPipelineInput<'_>) -> DictationPipelineResult {
    let mut text = input.text.trim().to_string();
    let mut command_applied = None;
    let mut dictionary_applied_count = 0usize;
    let mut snippet_applied_count = 0usize;
    let mut formatting_applied = false;
    let mut recent_insert_reused = false;
    let mut pipeline_stage_keys = Vec::new();
    let mut undo_previous_insert = false;

    if text.is_empty() {
        return DictationPipelineResult {
            text,
            command_applied,
            dictionary_applied_count,
            snippet_applied_count,
            formatting_applied,
            recent_insert_reused,
            pipeline_stage_keys,
            undo_previous_insert,
        };
    }

    let (normalized_text, dictionary_applied) =
        apply_dictionary_entries(text.as_str(), input.dictionary_entries, input.app_target);
    if dictionary_applied > 0 {
        dictionary_applied_count = dictionary_applied;
        pipeline_stage_keys.push("dictionary".to_string());
        text = normalized_text;
    }

    if let Some(backtrack_resolution) =
        resolve_backtrack_command(text.as_str(), input.recent_inserted_text)
    {
        command_applied = Some(backtrack_resolution.command_key.to_string());
        pipeline_stage_keys.push("backtrack".to_string());
        text = backtrack_resolution.text;
        recent_insert_reused = backtrack_resolution.used_recent_insert;
        undo_previous_insert = backtrack_resolution.undo_previous_insert;
    }

    if command_applied.is_none() && !text.trim().is_empty() {
        let (expanded_text, applied) =
            apply_snippets(text.as_str(), input.snippets, input.app_target);
        text = expanded_text;
        snippet_applied_count = applied;
        if applied > 0 {
            pipeline_stage_keys.push("snippets".to_string());
        }
    }

    if input.smart_formatting_enabled && command_applied.is_none() && !text.trim().is_empty() {
        let formatted_text = crate::text::format::smart_format_dictation_text_for_app(
            text.as_str(),
            input.mode_preset,
            input.formatting_hint,
        );
        formatting_applied = formatted_text != text;
        if formatting_applied {
            pipeline_stage_keys.push("smart_formatting".to_string());
        }
        text = formatted_text;
    }

    DictationPipelineResult {
        text,
        command_applied,
        dictionary_applied_count,
        snippet_applied_count,
        formatting_applied,
        recent_insert_reused,
        pipeline_stage_keys,
        undo_previous_insert,
    }
}

struct BacktrackResolution {
    command_key: &'static str,
    text: String,
    undo_previous_insert: bool,
    used_recent_insert: bool,
}

fn normalize_backtrack_replacement_phrase(value: &str) -> String {
    let mut replacement = value.trim();
    for prefix in [
        "actually ",
        "actually, ",
        "no, actually ",
        "no actually ",
        "no comma actually ",
        "no, say ",
        "no say ",
        "no comma say ",
    ] {
        if let Some(stripped) = strip_prefix_ignore_case(replacement, prefix) {
            replacement = stripped.trim();
            break;
        }
    }
    replacement.to_string()
}

fn resolve_backtrack_command(
    text: &str,
    recent_inserted_text: Option<&str>,
) -> Option<BacktrackResolution> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if matches_undo_phrase(trimmed) {
        return Some(BacktrackResolution {
            command_key: "backtrack_undo_last_insert",
            text: String::new(),
            undo_previous_insert: recent_inserted_text
                .map(str::trim)
                .map(|value| !value.is_empty())
                .unwrap_or(false),
            used_recent_insert: recent_inserted_text
                .map(str::trim)
                .map(|value| !value.is_empty())
                .unwrap_or(false),
        });
    }

    let Some(recent_inserted_text) = recent_inserted_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return None;
    };

    for prefix in [
        "scratch that ",
        "scratch that, ",
        "undo that ",
        "undo that, ",
        "undo it ",
        "undo it, ",
        "never mind ",
        "never mind, ",
    ] {
        if let Some(replacement) = strip_prefix_ignore_case(trimmed, prefix) {
            let replacement = normalize_backtrack_replacement_phrase(replacement);
            if !replacement.is_empty() {
                return Some(BacktrackResolution {
                    command_key: "backtrack_replace_last_insert",
                    text: replacement,
                    undo_previous_insert: true,
                    used_recent_insert: true,
                });
            }
        }
    }

    for prefix in [
        "actually ",
        "actually, ",
        "no, actually ",
        "no actually ",
        "no comma actually ",
        "no, say ",
        "no say ",
        "no comma say ",
    ] {
        if let Some(replacement) = strip_prefix_ignore_case(trimmed, prefix) {
            let replacement = replacement.trim();
            if !replacement.is_empty() {
                return Some(BacktrackResolution {
                    command_key: "backtrack_replace_last_insert",
                    text: replacement.to_string(),
                    undo_previous_insert: true,
                    used_recent_insert: true,
                });
            }
        }
    }

    for (verb, separator) in [("replace", "with"), ("change", "to")] {
        if let Some((target, replacement)) = parse_phrase_swap_command(trimmed, verb, separator) {
            if let Ok((updated_text, _)) =
                apply_contextual_phrase_replacement(recent_inserted_text, &target, &replacement)
            {
                return Some(BacktrackResolution {
                    command_key: "backtrack_replace_phrase",
                    text: updated_text,
                    undo_previous_insert: true,
                    used_recent_insert: true,
                });
            }
        }
    }

    None
}

fn apply_dictionary_entries(
    input: &str,
    entries: &[DictationDictionaryEntry],
    app_target: Option<&str>,
) -> (String, usize) {
    let rules = entries
        .iter()
        .map(|entry| DictionaryRule {
            spoken_form: entry.spoken_form.clone(),
            replacement: entry.replacement.clone(),
            app_scope: entry.app_scope.clone(),
            case_sensitive: entry.case_sensitive,
            enabled: entry.enabled,
        })
        .collect::<Vec<_>>();
    crate::dictation_parity::apply_dictation_dictionary(input, &rules, app_target)
}

fn apply_snippets(
    input: &str,
    snippets: &[DictationSnippet],
    app_target: Option<&str>,
) -> (String, usize) {
    let rules = snippets
        .iter()
        .map(|snippet| SnippetRule {
            trigger: snippet.trigger.clone(),
            expansion: snippet.expansion.clone(),
            app_scope: snippet.app_scope.clone(),
            case_sensitive: snippet.case_sensitive,
            enabled: snippet.enabled,
        })
        .collect::<Vec<_>>();
    crate::dictation_parity::apply_dictation_snippets(input, &rules, app_target)
}

fn matches_undo_phrase(value: &str) -> bool {
    value.eq_ignore_ascii_case("scratch that")
        || value.eq_ignore_ascii_case("undo that")
        || value.eq_ignore_ascii_case("undo it")
        || value.eq_ignore_ascii_case("never mind")
}

fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() < prefix.len() {
        return None;
    }

    if value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

fn parse_phrase_swap_command(input: &str, verb: &str, separator: &str) -> Option<(String, String)> {
    let remainder = strip_prefix_ignore_case(input.trim(), &format!("{} ", verb))?;
    let lowercase = remainder.to_lowercase();
    let marker = format!(" {} ", separator);
    let separator_index = lowercase.find(&marker)?;
    let target = remainder[..separator_index].trim();
    let replacement = remainder[separator_index + marker.len()..].trim();

    if target.is_empty() || replacement.is_empty() {
        return None;
    }

    Some((target.to_string(), replacement.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn dictionary_entry(spoken_form: &str, replacement: &str) -> DictationDictionaryEntry {
        DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: spoken_form.to_string(),
            replacement: replacement.to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn snippet(trigger: &str, expansion: &str) -> DictationSnippet {
        DictationSnippet {
            id: "snippet".to_string(),
            trigger: trigger.to_string(),
            expansion: expansion.to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn pipeline_applies_dictionary_then_snippets() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "open ai brb",
            dictionary_entries: &[dictionary_entry("open ai", "OpenAI")],
            snippets: &[snippet("brb", "be right back")],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: None,
        });

        assert_eq!(result.text, "OpenAI be right back");
        assert_eq!(result.dictionary_applied_count, 1);
        assert_eq!(result.snippet_applied_count, 1);
        assert!(!result.formatting_applied);
        assert!(!result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["dictionary", "snippets"]);
        assert!(result.command_applied.is_none());
    }

    #[test]
    fn pipeline_replaces_last_insert_for_actually_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "actually ship it tomorrow",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it today"),
        });

        assert_eq!(result.text, "ship it tomorrow");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
        assert!(result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(result.undo_previous_insert);
    }

    #[test]
    fn pipeline_replaces_last_insert_for_actually_comma_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "actually, ship it Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it Friday"),
        });

        assert_eq!(result.text, "ship it Monday");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
        assert!(result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(result.undo_previous_insert);
    }

    #[test]
    fn pipeline_replaces_last_insert_for_no_actually_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "no, actually ship it next week",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow"),
        });

        assert_eq!(result.text, "ship it next week");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
        assert!(result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(result.undo_previous_insert);
    }

    #[test]
    fn pipeline_swallows_undo_phrase_even_without_recent_insert() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "scratch that",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: None,
        });

        assert!(result.text.is_empty());
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_undo_last_insert")
        );
        assert!(!result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(!result.undo_previous_insert);
    }

    #[test]
    fn pipeline_replaces_last_insert_for_scratch_that_with_replacement() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "scratch that actually ship it tomorrow",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it today"),
        });

        assert_eq!(result.text, "ship it tomorrow");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
        assert!(result.recent_insert_reused);
        assert!(result.undo_previous_insert);
    }

    #[test]
    fn pipeline_applies_dictionary_before_scratch_that_replacement() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "scratch that jon is ready",
            dictionary_entries: &[dictionary_entry("jon", "John")],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("sam is ready"),
        });

        assert_eq!(result.text, "John is ready");
        assert_eq!(result.dictionary_applied_count, 1);
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
    }

    #[test]
    fn pipeline_rewrites_recent_insert_for_replace_phrase_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "replace tomorrow with Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
        });

        assert_eq!(result.text, "ship it Monday morning");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_phrase")
        );
        assert!(result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(result.undo_previous_insert);
    }

    #[test]
    fn pipeline_rewrites_recent_insert_for_change_phrase_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "change tomorrow to Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            formatting_hint: None,
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
        });

        assert_eq!(result.text, "ship it Monday morning");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_phrase")
        );
        assert!(result.recent_insert_reused);
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
        assert!(result.undo_previous_insert);
    }
}
