use crate::dictation_parity::{
    apply_contextual_phrase_replacement, DictionaryRule, SnippetRule, VocabularyTermCandidate,
    VocabularyTermKind,
};
use crate::models::{DictationDictionaryEntry, DictationSnippet};
use crate::text::format::DictationAppCategory;

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
    pub smart_formatting_enabled: bool,
    pub recent_inserted_text: Option<&'a str>,
    /// Resolved destination-app category (via `resolve_dictation_app_category`
    /// or the settings-aware `resolve_dictation_app_category_with_overrides`),
    /// used both to scope dictionary/snippet entries whose `category_scope`
    /// is set and to pick the local smart-formatting style, so all pipeline
    /// stages agree on one category. Defaults to
    /// `DictationAppCategory::Other` when not provided, which never matches
    /// a set `category_scope`, so category-scoped entries simply won't apply
    /// unless the caller resolves and passes the real category here.
    pub destination_category: DictationAppCategory,
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

    let (normalized_text, dictionary_applied) = apply_dictionary_entries(
        text.as_str(),
        input.dictionary_entries,
        input.app_target,
        input.destination_category,
    );
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
        let (expanded_text, applied) = apply_snippets(
            text.as_str(),
            input.snippets,
            input.app_target,
            input.destination_category,
        );
        text = expanded_text;
        snippet_applied_count = applied;
        if applied > 0 {
            pipeline_stage_keys.push("snippets".to_string());
        }
    }

    if input.smart_formatting_enabled && command_applied.is_none() && !text.trim().is_empty() {
        let formatted_text = crate::text::format::smart_format_dictation_text_with_category(
            text.as_str(),
            input.mode_preset,
            input.destination_category,
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

    let recent_inserted_text = recent_inserted_text
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

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

/// Apply the learned dictionary to a block of transcribed text.
///
/// Public because the dictation pipeline is no longer the only consumer: a term
/// the user taught Plainsong ("Kubernetes", a colleague's name) was corrected on
/// the dictation path and nowhere else, so meeting transcripts re-mangled it in
/// every segment, and every summary and action item derived from them. Meeting
/// post-processing runs this over each segment before persistence so the
/// correction is in place before anything reads the transcript.
///
/// Snippet expansion is deliberately *not* shared this way. A snippet is a
/// typing shortcut bound to a destination app ("sig" -> a signature block);
/// firing one because a meeting participant happened to say the trigger word
/// would rewrite what a person actually said.
pub fn apply_learned_dictionary(
    input: &str,
    entries: &[DictationDictionaryEntry],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize) {
    apply_dictionary_entries(input, entries, app_target, destination_category)
}

/// The recognizer-hint candidates for the same entries the pipeline applies
/// afterwards: each dictionary entry contributes its *replacement* (the
/// spelling to prefer — the misheard `spoken_form` is deliberately not sent,
/// biasing toward it would defeat the entry), and each snippet contributes
/// its trigger only. Expansions never leave this function: a snippet that
/// expands "sig" into a four-line signature must not teach the recognizer
/// the signature. Recency is `updated_at`, the closest thing the entries
/// carry to "most recently used or added".
pub fn vocabulary_candidates_from_entries(
    entries: &[DictationDictionaryEntry],
    snippets: &[DictationSnippet],
) -> Vec<VocabularyTermCandidate> {
    entries
        .iter()
        .map(|entry| VocabularyTermCandidate {
            term: entry.replacement.clone(),
            app_scope: entry.app_scope.clone(),
            category_scope: entry.category_scope.clone(),
            enabled: entry.enabled,
            recency_ms: entry.updated_at.timestamp_millis(),
            kind: VocabularyTermKind::DictionaryReplacement,
        })
        .chain(snippets.iter().map(|snippet| VocabularyTermCandidate {
            term: snippet.trigger.clone(),
            app_scope: snippet.app_scope.clone(),
            category_scope: snippet.category_scope.clone(),
            enabled: snippet.enabled,
            recency_ms: snippet.updated_at.timestamp_millis(),
            kind: VocabularyTermKind::SnippetTrigger,
        }))
        .collect()
}

fn apply_dictionary_entries(
    input: &str,
    entries: &[DictationDictionaryEntry],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize) {
    let rules = entries
        .iter()
        .map(|entry| DictionaryRule {
            spoken_form: entry.spoken_form.clone(),
            replacement: entry.replacement.clone(),
            app_scope: entry.app_scope.clone(),
            case_sensitive: entry.case_sensitive,
            enabled: entry.enabled,
            category_scope: entry.category_scope.clone(),
        })
        .collect::<Vec<_>>();
    crate::dictation_parity::apply_dictation_dictionary_for_category(
        input,
        &rules,
        app_target,
        destination_category,
    )
}

fn apply_snippets(
    input: &str,
    snippets: &[DictationSnippet],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize) {
    let rules = snippets
        .iter()
        .map(|snippet| SnippetRule {
            trigger: snippet.trigger.clone(),
            expansion: snippet.expansion.clone(),
            app_scope: snippet.app_scope.clone(),
            case_sensitive: snippet.case_sensitive,
            enabled: snippet.enabled,
            category_scope: snippet.category_scope.clone(),
        })
        .collect::<Vec<_>>();
    crate::dictation_parity::apply_dictation_snippets_for_category(
        input,
        &rules,
        app_target,
        destination_category,
    )
}

fn matches_undo_phrase(value: &str) -> bool {
    value.eq_ignore_ascii_case("scratch that")
        || value.eq_ignore_ascii_case("undo that")
        || value.eq_ignore_ascii_case("undo it")
        || value.eq_ignore_ascii_case("never mind")
}

fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    // `get` (rather than direct slicing) so a multibyte character straddling
    // `prefix.len()` yields `None` instead of panicking on a non-char
    // boundary (e.g. Japanese/Chinese dictation checked against "scratch
    // that ").
    let head = value.get(..prefix.len())?;
    let tail = value.get(prefix.len()..)?;
    if head.eq_ignore_ascii_case(prefix) {
        Some(tail)
    } else {
        None
    }
}

fn parse_phrase_swap_command(input: &str, verb: &str, separator: &str) -> Option<(String, String)> {
    let remainder = strip_prefix_ignore_case(input.trim(), &format!("{} ", verb))?;
    // ASCII lowercasing is byte-length preserving, so byte indices found in
    // `lowercase` map 1:1 back onto `remainder` (Unicode lowercasing does
    // not, e.g. 'İ' expands from 2 to 3 bytes and would corrupt the slice).
    let lowercase = remainder.to_ascii_lowercase();
    let marker = format!(" {} ", separator);
    let separator_index = lowercase.find(&marker)?;
    let target = remainder.get(..separator_index)?.trim();
    let replacement = remainder.get(separator_index + marker.len()..)?.trim();

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
            category_scope: None,
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
            category_scope: None,
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
            smart_formatting_enabled: false,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it today"),
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it Friday"),
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow"),
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it today"),
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("sam is ready"),
            destination_category: DictationAppCategory::Other,
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
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
            destination_category: DictationAppCategory::Other,
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
    fn pipeline_handles_multibyte_text_after_recent_insert_without_panicking() {
        // Regression: backtrack prefix matching used direct byte slicing and
        // panicked on any utterance where a multibyte char straddled a
        // prefix length (e.g. Japanese text checked against "scratch that ").
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "日本語のテキストです",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            recent_inserted_text: Some("前のテキスト"),
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(result.text, "日本語のテキストです");
        assert!(result.command_applied.is_none());
    }

    #[test]
    fn phrase_swap_parsing_survives_length_changing_case_folds() {
        // Regression: byte indices were computed on the Unicode-lowercased
        // string but applied to the original ('İ' lowercases from 2 bytes to
        // 3, shifting every later index).
        let (target, replacement) =
            parse_phrase_swap_command("replace İstanbul trip with Ankara trip", "replace", "with")
                .expect("phrase swap should parse");
        assert_eq!(target, "İstanbul trip");
        assert_eq!(replacement, "Ankara trip");
    }

    #[test]
    fn pipeline_rewrites_recent_insert_for_change_phrase_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "change tomorrow to Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
            destination_category: DictationAppCategory::Other,
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

#[cfg(test)]
mod vocabulary_candidate_tests {
    use super::*;
    use crate::dictation_parity::build_vocabulary_hint;
    use chrono::{TimeZone, Utc};

    #[test]
    fn dictionary_entries_contribute_replacements_and_snippets_only_their_triggers() {
        let at = |secs: i64| Utc.timestamp_opt(secs, 0).single().expect("timestamp");
        let entries = vec![DictationDictionaryEntry {
            id: "d1".to_string(),
            spoken_form: "open a i".to_string(),
            replacement: "OpenAI".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: at(10),
            updated_at: at(20),
        }];
        let snippets = vec![DictationSnippet {
            id: "s1".to_string(),
            trigger: "sig".to_string(),
            expansion: "Best regards,\nJonathan Reed\nPlainsong".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: at(30),
            updated_at: at(40),
        }];

        let candidates = vocabulary_candidates_from_entries(&entries, &snippets);
        let terms: Vec<&str> = candidates.iter().map(|c| c.term.as_str()).collect();
        assert_eq!(terms, vec!["OpenAI", "sig"]);
        assert!(
            !candidates.iter().any(|c| c.term.contains("Best regards")),
            "snippet expansions must never become recognizer vocabulary"
        );
        assert!(
            !candidates.iter().any(|c| c.term == "open a i"),
            "the misheard spoken form must not be sent either"
        );
        assert_eq!(candidates[0].recency_ms, 20_000);
        assert_eq!(candidates[1].kind, VocabularyTermKind::SnippetTrigger);

        // End to end through the builder: the newer snippet trigger leads.
        let hint =
            build_vocabulary_hint(&candidates, None, DictationAppCategory::Other).expect("hint");
        assert_eq!(hint.as_prompt(), "Vocabulary: sig, OpenAI.");
    }
}
