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
    /// Inverse text normalization: turn spoken numbers into written form
    /// ("twelve dollars fifty" -> "$12.50"). Resolved per dictation profile
    /// (`resolve_dictation_numbers_as_digits` in `lib.rs`), which is why it
    /// arrives as a plain bool rather than being read from settings here.
    pub numbers_as_digits: bool,
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

    // Inverse text normalization sits between command handling and snippet
    // expansion. After commands, because "replace two with three" is an
    // instruction whose operands must still match the words in the previous
    // insert. Before snippets, because a snippet expansion is a block of text
    // the user typed once and must come out exactly as written -- running ITN
    // first is what guarantees the stage can never reach inside one.
    //
    // The dictionary stage necessarily runs earlier (a phrase-swap command
    // matches against an already-corrected previous insert, see
    // `pipeline_applies_dictionary_before_scratch_that_replacement`), so the
    // same guarantee for dictionary output is bought explicitly: every
    // enabled entry's replacement text is handed to the stage as a protected
    // phrase and is never rewritten.
    if input.numbers_as_digits && !text.trim().is_empty() {
        let protected_phrases = dictionary_replacement_phrases(input.dictionary_entries);
        let normalized_numbers =
            crate::text::itn::inverse_text_normalize_protecting(text.as_str(), &protected_phrases);
        if normalized_numbers != text {
            pipeline_stage_keys.push("itn".to_string());
            text = normalized_numbers;
        }
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

/// The replacement text of every enabled dictionary entry, handed to the ITN
/// stage as a protected phrase. Scope is deliberately ignored: over-
/// protecting a phrase only ever leaves the user's own words alone, while
/// under-protecting one would let the stage rewrite a correction the user
/// asked for.
fn dictionary_replacement_phrases(entries: &[DictationDictionaryEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.replacement.trim().to_string())
        .filter(|replacement| !replacement.is_empty())
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
            numbers_as_digits: false,
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
    fn pipeline_normalizes_numbers_when_the_profile_asks_for_digits() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "the invoice came to twelve dollars fifty",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(result.text, "the invoice came to $12.50");
        assert_eq!(result.pipeline_stage_keys, vec!["itn"]);
    }

    #[test]
    fn pipeline_leaves_numbers_as_words_when_the_profile_does_not() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "the invoice came to twelve dollars fifty",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(result.text, "the invoice came to twelve dollars fifty");
        assert!(result.pipeline_stage_keys.is_empty());
    }

    /// Stage order: dictionary, then ITN, then snippets. The snippet
    /// expansion is a block of text the user typed once, so it has to reach
    /// the destination exactly as written -- which is only guaranteed if ITN
    /// has already run by the time it is substituted in.
    #[test]
    fn pipeline_runs_itn_between_the_dictionary_and_snippet_stages() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "open ai eta twenty five minutes",
            dictionary_entries: &[dictionary_entry("open ai", "OpenAI")],
            snippets: &[snippet("eta", "back in one two three minutes")],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(
            result.pipeline_stage_keys,
            vec!["dictionary", "itn", "snippets"]
        );
        assert_eq!(
            result.text, "OpenAI back in one two three minutes 25 minutes",
            "the snippet expansion must arrive verbatim"
        );
    }

    /// A dictionary replacement is the user's own spelling. Even though the
    /// dictionary stage necessarily runs first, ITN must not reach inside
    /// what it produced.
    #[test]
    fn pipeline_never_rewrites_inside_a_dictionary_replacement() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "take the old highway for twenty miles",
            dictionary_entries: &[dictionary_entry("the old highway", "Route sixty six")],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(result.text, "take Route sixty six for 20 miles");
        assert_eq!(result.pipeline_stage_keys, vec!["dictionary", "itn"]);
    }

    /// Command handling comes first, so the operands of a phrase swap are
    /// still the words the user said and still match the previous insert.
    #[test]
    fn pipeline_resolves_a_phrase_swap_before_normalizing_numbers() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "replace two with three",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: true,
            recent_inserted_text: Some("we need two servers"),
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_phrase")
        );
        assert_eq!(result.text, "we need 3 servers");
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack", "itn"]);
    }

    /// The undo command produces no text, so the stage has nothing to do and
    /// must not announce itself.
    #[test]
    fn pipeline_skips_itn_when_a_command_swallowed_the_utterance() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "scratch that",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            numbers_as_digits: true,
            recent_inserted_text: Some("we need twenty five servers"),
            destination_category: DictationAppCategory::Other,
        });

        assert!(result.text.is_empty());
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
    }

    #[test]
    fn pipeline_composes_itn_with_smart_formatting() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            text: "we shipped one hundred twenty three builds",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            numbers_as_digits: true,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        });

        assert_eq!(result.text, "We shipped 123 builds");
        assert_eq!(result.pipeline_stage_keys, vec!["itn", "smart_formatting"]);
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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
            numbers_as_digits: false,
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

/// Runs the repo's dictation eval fixtures (`docs/evals/`) through the real
/// pipeline so the ITN stage has evidence rather than assertions written from
/// memory: every existing fixture line has to come out of the stage unchanged,
/// and every new number line has to come out the way the fixture says.
///
/// The fixtures are read at test time, so adding a case is a JSON edit with no
/// recompile.
#[cfg(test)]
mod fixture_evals {
    use super::*;
    use crate::text::format::DictationAppCategory;
    use serde_json::Value;

    fn load(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/evals")
            .join(name);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {}", path.display(), error));
        serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("parse {}: {}", path.display(), error))
    }

    fn field<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
        case.get(key).and_then(Value::as_str)
    }

    fn required<'a>(case: &'a Value, key: &str) -> &'a str {
        field(case, key).unwrap_or_else(|| panic!("fixture case missing {key}: {case}"))
    }

    fn run_pipeline(
        input: &str,
        mode_preset: &str,
        numbers_as_digits: bool,
        dictionary_entries: &[DictationDictionaryEntry],
    ) -> DictationPipelineResult {
        apply_dictation_pipeline(DictationPipelineInput {
            text: input,
            dictionary_entries,
            snippets: &[],
            app_target: None,
            mode_preset,
            smart_formatting_enabled: true,
            numbers_as_digits,
            recent_inserted_text: None,
            destination_category: DictationAppCategory::Other,
        })
    }

    /// Every line of the parity fixture, through the ITN stage on its own.
    /// A line with no `itnOutput` must come back byte-identical.
    #[test]
    fn parity_fixture_lines_survive_the_itn_stage() {
        let fixture = load("dictation-parity-fixture.json");
        let scenarios = fixture["scenarios"].as_array().expect("scenarios");
        assert!(!scenarios.is_empty());

        for scenario in scenarios {
            let input = required(scenario, "inputText");
            let expected = field(scenario, "itnOutput").unwrap_or(input);
            let actual = crate::text::itn::inverse_text_normalize(input);
            assert_eq!(
                actual,
                expected,
                "scenario {}",
                required(scenario, "scenarioId")
            );
        }
    }

    /// The formatting fixtures, through the whole local pipeline. With the
    /// stage off they must still produce `expectedOutput`; with it on they
    /// must produce `expectedNumbersAsDigitsOutput`, which defaults to the
    /// same string (i.e. the stage changed nothing).
    #[test]
    fn quality_formatting_fixtures_do_not_regress() {
        let fixture = load("dictation-quality-fixtures.json");
        let cases = fixture["formattingCases"]
            .as_array()
            .expect("formattingCases");
        assert!(!cases.is_empty());

        for case in cases {
            let id = required(case, "id");
            let input = required(case, "inputText");
            let mode_preset = field(case, "modePreset").unwrap_or("voice");
            let expected = required(case, "expectedOutput");

            let without = run_pipeline(input, mode_preset, false, &[]);
            assert_eq!(without.text, expected, "case {id} with numbers off");

            let expected_with = field(case, "expectedNumbersAsDigitsOutput").unwrap_or(expected);
            let with = run_pipeline(input, mode_preset, true, &[]);
            assert_eq!(with.text, expected_with, "case {id} with numbers on");
        }
    }

    /// The dictionary fixtures, with the stage on: a learned correction has to
    /// come out exactly as the user spelled it.
    #[test]
    fn quality_dictionary_fixtures_survive_the_itn_stage() {
        let fixture = load("dictation-quality-fixtures.json");
        let cases = fixture["dictionaryCases"]
            .as_array()
            .expect("dictionaryCases");
        assert!(!cases.is_empty());

        for case in cases {
            let id = required(case, "id");
            let input = required(case, "inputText");
            let expected = required(case, "expectedOutput");
            let app_target = field(case, "appTarget");
            let entries: Vec<DictationDictionaryEntry> = case["rules"]
                .as_array()
                .expect("rules")
                .iter()
                .map(|rule| DictationDictionaryEntry {
                    id: required(rule, "spokenForm").to_string(),
                    spoken_form: required(rule, "spokenForm").to_string(),
                    replacement: required(rule, "replacement").to_string(),
                    app_scope: field(rule, "appScope").map(str::to_string),
                    case_sensitive: rule["caseSensitive"].as_bool().unwrap_or(false),
                    enabled: rule["enabled"].as_bool().unwrap_or(true),
                    category_scope: None,
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                })
                .collect();

            let result = apply_dictation_pipeline(DictationPipelineInput {
                text: input,
                dictionary_entries: &entries,
                snippets: &[],
                app_target,
                mode_preset: "voice",
                smart_formatting_enabled: false,
                numbers_as_digits: true,
                recent_inserted_text: None,
                destination_category: DictationAppCategory::Other,
            });
            assert_eq!(result.text, expected, "case {id}");
            if let Some(expected_count) = case["expectedAppliedCount"].as_u64() {
                assert_eq!(
                    result.dictionary_applied_count as u64, expected_count,
                    "case {id} applied count"
                );
            }
        }
    }

    /// The spoken-number cases added for this stage: the ITN output on its own
    /// and, where the fixture gives one, the full pipeline result.
    #[test]
    fn quality_number_fixtures_match() {
        let fixture = load("dictation-quality-fixtures.json");
        let cases = fixture["numberCases"].as_array().expect("numberCases");
        assert!(!cases.is_empty());

        for case in cases {
            let id = required(case, "id");
            let input = required(case, "inputText");
            let expected_itn = required(case, "expectedItnOutput");
            assert_eq!(
                crate::text::itn::inverse_text_normalize(input),
                expected_itn,
                "case {id} itn"
            );

            if let Some(expected_output) = field(case, "expectedOutput") {
                let mode_preset = field(case, "modePreset").unwrap_or("voice");
                let result = run_pipeline(input, mode_preset, true, &[]);
                assert_eq!(result.text, expected_output, "case {id} pipeline");
            }
        }
    }

    /// Before/after for every fixture line, printed so the eval log can be
    /// regenerated rather than retyped.
    /// `cargo test --lib fixture_evals::report -- --nocapture`
    #[test]
    fn report_before_and_after() {
        for (file, key) in [
            ("dictation-parity-fixture.json", "scenarios"),
            ("dictation-quality-fixtures.json", "formattingCases"),
            ("dictation-quality-fixtures.json", "numberCases"),
        ] {
            let fixture = load(file);
            let Some(cases) = fixture[key].as_array() else {
                continue;
            };
            for case in cases {
                let Some(input) = field(case, "inputText") else {
                    continue;
                };
                let after = crate::text::itn::inverse_text_normalize(input);
                let changed = if after == input { " " } else { "*" };
                println!("{changed} [{key}] {input:?} -> {after:?}");
            }
        }
    }

    /// The stage's cost on a 200-word input, against the 6 s dictation budget.
    /// Printed rather than asserted at a tight bound: this machine is shared,
    /// so the number is provisional -- the assertion is only that the stage is
    /// nowhere near the budget.
    #[test]
    fn stage_cost_on_two_hundred_words() {
        let sentence = "we shipped one hundred twenty three builds and spent twelve dollars \
                        fifty on march third at three thirty pm with twenty percent left over \
                        for the team and one of them still owes me three point five days ";
        let mut input = String::new();
        while input.split_whitespace().count() < 200 {
            input.push_str(sentence);
        }
        let words = input.split_whitespace().count();

        // Warm the code paths before timing.
        let _ = crate::text::itn::inverse_text_normalize(&input);

        let runs = 200;
        let started = std::time::Instant::now();
        for _ in 0..runs {
            let _ = crate::text::itn::inverse_text_normalize(&input);
        }
        let per_run = started.elapsed() / runs;
        println!("itn stage: {words} words, {runs} runs, {per_run:?} per run");
        assert!(
            per_run < std::time::Duration::from_millis(50),
            "ITN on {words} words took {per_run:?}, which is no longer negligible against the 6 s budget"
        );
    }
}
