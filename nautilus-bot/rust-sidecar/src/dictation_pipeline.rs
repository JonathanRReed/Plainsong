use crate::dictation_parity::{
    apply_contextual_phrase_replacement, category_scope_matches, snippet_app_scope_matches,
    DictionaryRule, SnippetRule, VocabularyTermCandidate, VocabularyTermKind,
};
use crate::models::{DictationDictionaryEntry, DictationSnippet};
use crate::text::format::DictationAppCategory;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictationPipelineResult {
    pub text: String,
    pub command_applied: Option<String>,
    pub dictionary_applied_count: usize,
    pub applied_dictionary_replacements: Vec<String>,
    pub snippet_applied_count: usize,
    pub formatting_applied: bool,
    pub recent_insert_reused: bool,
    pub pipeline_stage_keys: Vec<String>,
    pub undo_previous_insert: bool,
    /// Whether the English-only stages applied (see `text::language`). The
    /// AI cleanup that may follow uses the same decision, so a model is not
    /// allowed to drop the German or Portuguese "um" the local stages kept.
    pub english_rules: bool,
}

pub struct DictationPipelineInput<'a> {
    pub text: &'a str,
    pub dictionary_entries: &'a [DictationDictionaryEntry],
    pub snippets: &'a [DictationSnippet],
    pub app_target: Option<&'a str>,
    pub mode_preset: &'a str,
    pub smart_formatting_enabled: bool,
    /// Local disfluency cleanup (`dictation_cleanup`): hesitations, stutters
    /// and like-for-like spoken corrections. The user's
    /// `dictation_remove_disfluencies` setting on the live path.
    pub clean_disfluencies: bool,
    /// Number style: format spoken numbers as digits, or recognizer digits
    /// as words. Voice keeps small prose numbers as words in digits mode.
    /// Resolved per dictation profile
    /// (`resolve_dictation_numbers_as_digits` in `lib.rs`), which is why it
    /// arrives as a plain bool rather than being read from settings here.
    pub numbers_as_digits: bool,
    pub recent_inserted_text: Option<&'a str>,
    /// Backtrack phrases are destructive commands and must follow the user's
    /// command-mode policy rather than being recognized as ordinary text.
    pub command_mode_enabled: bool,
    /// Resolved destination-app category (via `resolve_dictation_app_category`
    /// or the settings-aware `resolve_dictation_app_category_with_overrides`),
    /// used both to scope dictionary/snippet entries whose `category_scope`
    /// is set and to pick the local smart-formatting style, so all pipeline
    /// stages agree on one category. Defaults to
    /// `DictationAppCategory::Other` when not provided, which never matches
    /// a set `category_scope`, so category-scoped entries simply won't apply
    /// unless the caller resolves and passes the real category here.
    pub destination_category: DictationAppCategory,
    /// Allow line-break layout (numbered lists, paragraphs, email greeting
    /// and sign-off lines) in local smart formatting. True only when the
    /// user kept destination-aware formatting on and the focused field is
    /// not a single-line control; the formatter further limits it to email,
    /// notes and worklog destinations.
    pub structured_layout: bool,
    /// The language the dictation was spoken in, when anything states it
    /// (`text::language::dictation_spoken_language`: translation to English,
    /// the language setting, or the recognizer's report). `None` lets the
    /// transcript decide whether the English-only stages apply.
    pub spoken_language: Option<&'a str>,
}

pub fn apply_dictation_pipeline(input: DictationPipelineInput<'_>) -> DictationPipelineResult {
    let mut text = input.text.trim().to_string();
    let mut command_applied = None;
    let mut dictionary_applied_count = 0usize;
    let mut applied_dictionary_replacements = Vec::new();
    let mut snippet_applied_count = 0usize;
    let mut formatting_applied = false;
    let mut recent_insert_reused = false;
    let mut pipeline_stage_keys = Vec::new();
    let mut undo_previous_insert = false;
    // Hesitation removal, spoken-repair cues, number words and pronoun "I"
    // are English rules: German "um" ("in order to") and Portuguese "um"
    // ("a") are words, not fillers. Decided once, on the recognizer's text,
    // before the dictionary and snippets can add text of their own.
    let english_rules = crate::text::language::english_rules_apply(input.spoken_language, &text);

    if text.is_empty() {
        return DictationPipelineResult {
            text,
            command_applied,
            dictionary_applied_count,
            applied_dictionary_replacements,
            snippet_applied_count,
            formatting_applied,
            recent_insert_reused,
            pipeline_stage_keys,
            undo_previous_insert,
            english_rules,
        };
    }

    if input.smart_formatting_enabled && input.clean_disfluencies && english_rules {
        let repaired = crate::dictation_fidelity::resolve_spoken_repairs(&text);
        if repaired != text {
            text = repaired;
            formatting_applied = true;
            pipeline_stage_keys.push("spoken_correction".to_string());
        }
    }

    // Before the dictionary and commands, so a stutter or "um" cannot split a
    // dictionary phrase or a command. Never empties the text: a dictation of
    // only "um" stays as spoken rather than inserting nothing silently.
    if input.clean_disfluencies && english_rules {
        let cleaned = crate::dictation_cleanup::clean_disfluencies(&text);
        if cleaned != text && !cleaned.trim().is_empty() {
            text = cleaned;
            formatting_applied = true;
            pipeline_stage_keys.push("disfluency_cleanup".to_string());
        }
    }

    let (normalized_text, dictionary_applied, replacements) = apply_dictionary_entries(
        text.as_str(),
        input.dictionary_entries,
        input.app_target,
        input.destination_category,
    );
    if dictionary_applied > 0 {
        dictionary_applied_count = dictionary_applied;
        applied_dictionary_replacements = replacements;
        pipeline_stage_keys.push("dictionary".to_string());
        text = normalized_text;
    }

    let sound_alike_terms: Vec<&str> = input
        .dictionary_entries
        .iter()
        .filter(|entry| {
            entry.enabled
                && crate::dictation_parity::snippet_app_scope_matches(
                    entry.app_scope.as_deref(),
                    input.app_target,
                )
                && crate::dictation_parity::category_scope_matches(
                    entry.category_scope.as_deref(),
                    input.destination_category,
                )
        })
        .map(|entry| entry.replacement.as_str())
        .collect();
    let (sound_alike_text, sound_alike_applied) =
        crate::dictation_sounds_like::correct_sound_alike_terms(&text, &sound_alike_terms);
    if !sound_alike_applied.is_empty() {
        dictionary_applied_count += sound_alike_applied.len();
        for term in sound_alike_applied {
            if !applied_dictionary_replacements.contains(&term) {
                applied_dictionary_replacements.push(term);
            }
        }
        pipeline_stage_keys.push("dictionary_sounds_like".to_string());
        text = sound_alike_text;
    }

    if let Some(backtrack_resolution) = input
        .command_mode_enabled
        .then(|| resolve_backtrack_command(text.as_str(), input.recent_inserted_text))
        .flatten()
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
    // Gated on `command_applied.is_none()` exactly like the snippet and
    // smart-formatting stages below: when a command ran, the text here is the
    // *previous insert* with an edit applied to it, not something the user
    // just dictated. That text already passed through this stage when it was
    // inserted, so running it again would let "replace two with three" rewrite
    // words elsewhere in the line that the user never touched.
    //
    // The dictionary stage necessarily runs earlier (a phrase-swap command
    // matches against an already-corrected previous insert, see
    // `pipeline_applies_dictionary_before_scratch_that_replacement`), so the
    // same guarantee for dictionary output is bought explicitly: every
    // enabled entry's replacement text is handed to the stage as a protected
    // phrase and is never rewritten. Enabled snippet triggers are protected
    // for a different reason -- ITN runs before `apply_snippets`, so rewriting
    // a number inside a trigger ("two factor auth" -> "2 factor auth") would
    // stop the snippet firing at all.
    if input.smart_formatting_enabled && command_applied.is_none() && !text.trim().is_empty() {
        let protected_phrases = itn_protected_phrases(
            &text,
            input.dictionary_entries,
            input.snippets,
            input.app_target,
            input.destination_category,
        );
        let case_insensitive_phrases = input
            .snippets
            .iter()
            .filter(|snippet| {
                snippet.enabled
                    && !snippet.case_sensitive
                    && snippet_app_scope_matches(snippet.app_scope.as_deref(), input.app_target)
                    && category_scope_matches(
                        snippet.category_scope.as_deref(),
                        input.destination_category,
                    )
            })
            .map(|snippet| snippet.trigger.trim().to_string())
            .filter(|phrase| !phrase.is_empty())
            .collect::<Vec<_>>();
        let normalized = crate::text::itn::normalize_repeated_currency_units(
            &text,
            &protected_phrases,
            &case_insensitive_phrases,
        );
        if normalized != text {
            text = normalized;
            formatting_applied = true;
            pipeline_stage_keys.push("currency_cleanup".to_string());
        }
    }

    // The recognizer's own digits, written the way a US reader expects a
    // time: "9.30am" is "9:30am" and "by Friday at 445" is "by Friday at
    // 4:45" (see `render_dotted_clock_times` and `render_clock_digits`). Not
    // inverse text normalization -- no word becomes a digit -- so it does
    // not wait for `numbers_as_digits`. Code, terminals and AI prompts keep
    // "3.11" as typed, and dictionary output and snippet triggers are
    // protected exactly as in the ITN stage below.
    if input.smart_formatting_enabled
        && english_rules
        && command_applied.is_none()
        && !text.trim().is_empty()
        && !matches!(
            input.destination_category,
            DictationAppCategory::CodeEditor | DictationAppCategory::AiChat
        )
    {
        let protected_phrases = itn_protected_phrases(
            &text,
            input.dictionary_entries,
            input.snippets,
            input.app_target,
            input.destination_category,
        );
        let clocked = crate::text::itn::render_clock_digits_protecting(
            &crate::text::itn::render_dotted_clock_times_protecting(&text, &protected_phrases),
            &protected_phrases,
        );
        if clocked != text {
            text = clocked;
            formatting_applied = true;
            pipeline_stage_keys.push("time_format".to_string());
        }
    }

    if english_rules && command_applied.is_none() && !text.trim().is_empty() {
        let protected_phrases = itn_protected_phrases(
            &text,
            input.dictionary_entries,
            input.snippets,
            input.app_target,
            input.destination_category,
        );
        let protected_destination = matches!(
            input.destination_category,
            DictationAppCategory::CodeEditor | DictationAppCategory::AiChat
        );
        let english_number_words =
            crate::text::language::english_number_words_apply(input.spoken_language, &text);
        let normalized_numbers = if protected_destination
            && (input.mode_preset == "voice" || !input.numbers_as_digits)
        {
            text.clone()
        } else if !input.numbers_as_digits {
            if english_number_words {
                crate::text::itn::numbers_as_words_protecting(&text, &protected_phrases)
            } else {
                text.clone()
            }
        } else if input.mode_preset == "voice" {
            crate::text::itn::render_clock_digits_protecting(
                &crate::text::itn::voice_numbers_as_digits_protecting(
                    &text,
                    &protected_phrases,
                    english_number_words,
                ),
                &protected_phrases,
            )
        } else {
            crate::text::itn::render_clock_digits(
                &crate::text::itn::inverse_text_normalize_protecting(
                    text.as_str(),
                    &protected_phrases,
                ),
            )
        };
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
        let formatted_text = crate::text::format::smart_format_dictation_text_for_language(
            text.as_str(),
            input.mode_preset,
            input.destination_category,
            input.structured_layout,
            english_rules,
        );
        let locally_formatted = formatted_text != text;
        formatting_applied |= locally_formatted;
        if locally_formatted {
            pipeline_stage_keys.push("smart_formatting".to_string());
        }
        text = formatted_text;
    }

    DictationPipelineResult {
        text,
        command_applied,
        dictionary_applied_count,
        applied_dictionary_replacements,
        snippet_applied_count,
        formatting_applied,
        recent_insert_reused,
        pipeline_stage_keys,
        undo_previous_insert,
        english_rules,
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
    let (text, count, _) =
        apply_dictionary_entries(input, entries, app_target, destination_category);
    (text, count)
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

/// The phrases the ITN stage must not rewrite: the replacement text of every
/// enabled dictionary entry, and the trigger of every enabled snippet.
///
/// A dictionary replacement is a correction the user asked for, and the
/// dictionary stage necessarily runs first, so its output has to be fenced
/// off. A snippet trigger has not been substituted yet -- ITN runs before
/// `apply_snippets` -- so a trigger with a spoken number in it ("two factor
/// auth") would be rewritten out of existence and the snippet would never
/// fire.
///
/// Snippet scope must match here exactly as it does during expansion. Otherwise
/// an inapplicable trigger can split a number phrase while never expanding.
fn itn_protected_phrases(
    text: &str,
    entries: &[DictationDictionaryEntry],
    snippets: &[DictationSnippet],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.replacement.trim().to_string())
        .chain(
            snippets
                .iter()
                .filter(|snippet| {
                    snippet.enabled
                        && snippet_app_scope_matches(snippet.app_scope.as_deref(), app_target)
                        && category_scope_matches(
                            snippet.category_scope.as_deref(),
                            destination_category,
                        )
                })
                .flat_map(|snippet| {
                    let trigger = snippet.trigger.trim();
                    let mut phrases = vec![trigger.to_string()];
                    if !snippet.case_sensitive && !trigger.is_empty() {
                        if let Ok(pattern) = regex::RegexBuilder::new(&regex::escape(trigger))
                            .case_insensitive(true)
                            .build()
                        {
                            phrases.extend(pattern.find_iter(text).map(|m| m.as_str().to_string()));
                        }
                    }
                    phrases
                }),
        )
        .filter(|phrase| !phrase.is_empty())
        .collect()
}

fn apply_dictionary_entries(
    input: &str,
    entries: &[DictationDictionaryEntry],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize, Vec<String>) {
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

    #[test]
    fn reports_only_dictionary_replacements_actually_applied() {
        let entries = [
            dictionary_entry("pria", "Priya"),
            dictionary_entry("unused", "Unseen"),
        ];
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "pria and pria",
            dictionary_entries: &entries,
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });
        assert_eq!(result.text, "Priya and Priya");
        assert_eq!(result.applied_dictionary_replacements, vec!["Priya"]);
        assert!(crate::dictation_fidelity::validate_dictionary_replacements(
            &result.text,
            "Priya and Pria",
            &result.applied_dictionary_replacements
        )
        .is_err());
        assert!(crate::dictation_fidelity::validate_dictionary_replacements(
            &result.text,
            &result.text,
            &result.applied_dictionary_replacements
        )
        .is_ok());
    }

    fn voice_defaults(text: &str) -> String {
        voice_defaults_in(None, text, &[])
    }

    fn voice_defaults_in(
        spoken_language: Option<&str>,
        text: &str,
        snippets: &[DictationSnippet],
    ) -> String {
        apply_dictation_pipeline(DictationPipelineInput {
            spoken_language,
            text,
            dictionary_entries: &[],
            snippets,
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: true,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        })
        .text
    }

    /// A short German or Portuguese dictation, or one German or Portuguese
    /// phrase inside an English one, has too little text to turn the English
    /// rules off, but its bare "um" is still a word ("at", "a").
    #[test]
    fn short_or_mixed_dictation_keeps_german_and_portuguese_um() {
        for input in [
            "Um carro está na rua.",
            "Wir kommen um zehn Uhr.",
            "Ich komme um zehn Uhr.",
            "Um carro.",
            "Ich bin um zehn Uhr da.",
            "Um homem chegou.",
            "Um homem não chegou.",
            "Um carro chegou.",
            "Um carro é azul.",
            "Um zwei drei.",
            "I met um carro yesterday.",
            "Com um telefone.",
            "I need um carro by noon.",
            "Please translate um carro.",
        ] {
            assert_eq!(voice_defaults(input), input, "{input}");
        }
        assert_eq!(
            voice_defaults("I bought two um dois pastries."),
            "I bought two um dois pastries."
        );
        assert_eq!(
            voice_defaults("Um, I think we should go."),
            "I think we should go."
        );
        assert_eq!(
            voice_defaults("Um so if we want to do it that way, yeah."),
            "So if we want to do it that way, yeah."
        );
    }

    /// The 2026-10-22 fidelity review, through every local stage: weights
    /// stay pounds, mentioned fillers stay, partial numbers stay words, a
    /// corrected month takes its comma, and a short email keeps its sign-off.
    #[test]
    fn fidelity_review_cases_survive_the_whole_pipeline() {
        for (input, expected) in [
            (
                "The patient weighs one hundred and five pounds.",
                "The patient weighs 105 pounds.",
            ),
            ("He weighs two pounds.", "He weighs 2 pounds."),
            (
                "The patient lost twelve pounds.",
                "The patient lost 12 pounds.",
            ),
            (
                "The baby weighs seven pounds five ounces.",
                "The baby weighs 7 pounds 5 ounces.",
            ),
            ("The price is five pounds.", "The price is £5."),
            ("Please write um exactly.", "Please write um exactly."),
            (
                "Do not remove um from the transcript.",
                "Do not remove um from the transcript.",
            ),
            ("The word uh is in the poem.", "The word uh is in the poem."),
            ("Um, I think we should go.", "I think we should go."),
            ("Add two thirds of a cup.", "Add two thirds of a cup."),
            (
                "The blood pressure was one twenty over eighty.",
                "The blood pressure was one twenty over eighty.",
            ),
            (
                "Use Python three point eleven.",
                "Use Python three point eleven.",
            ),
            (
                "Ask May, I mean June, to approve it.",
                "Ask June to approve it.",
            ),
        ] {
            assert_eq!(voice_defaults(input), expected, "{input}");
        }
        for (input, expected) in [
            (
                "Hi Sam, approved. Best, Jordan.",
                "Hi Sam,\n\nApproved.\n\nBest,\nJordan",
            ),
            (
                "Hi Sam, please review. Best, Jordan.",
                "Hi Sam,\n\nPlease review.\n\nBest,\nJordan",
            ),
        ] {
            let output = apply_dictation_pipeline(DictationPipelineInput {
                spoken_language: None,
                text: input,
                dictionary_entries: &[],
                snippets: &[],
                app_target: Some("Mail"),
                mode_preset: "voice",
                smart_formatting_enabled: true,
                clean_disfluencies: true,
                numbers_as_digits: true,
                recent_inserted_text: None,
                command_mode_enabled: false,
                destination_category: DictationAppCategory::Email,
                // Email layout is the "format for the app" setting.
                structured_layout: true,
            })
            .text;
            assert_eq!(output, expected, "{input}");
        }
    }

    /// Real FLEURS sentences as Parakeet v3 recognized them (2026-10-21).
    /// The English filler rule used to delete German "um" ("in order to")
    /// and Portuguese "um" ("a"), and the pronoun rule capitalized the
    /// Italian article "i".
    #[test]
    fn other_languages_keep_words_the_english_rules_would_remove() {
        for text in [
            "Er war nicht dazu in der Lage, die benötigten Medikamente einzunehmen, um seinen Schmerz zu überwinden, da sie bei den Commonwealth Games verboten sind.",
            "Es gibt natürlich christlich theologische Erklärungen für diese Tradition, aber es könnte sich durchaus auch um ein vorchristliches Frühlings- und Fruchtbarkeitsritual handeln.",
            "Um total de 20% de água que vão dos rios do planeta para os oceanos vem da Amazônia.",
            "Portanto, o lápis foi um bom amigo para muitas pessoas quando foi lançado.",
            "Sei ostaggi, tra cui i bambini anziani, sono stati liberati subito insieme ai fotografi filippini.",
            "Nel 1976 il 30% del sito di Machu Picchu era stato recuperato, ma i lavori di restauro sono tuttora in corso.",
        ] {
            assert_eq!(voice_defaults(text), text);
        }
    }

    #[test]
    fn english_dictation_still_drops_fillers_and_writes_numbers() {
        assert_eq!(
            voice_defaults("Um, so i think we need two options."),
            "So I think we need two options."
        );
        assert_eq!(
            voice_defaults("Let's meet at the café de la Paix, um, at three pm."),
            "Let's meet at the café de la Paix at 3 pm."
        );
    }

    /// A language the user chose or the recognizer reported decides, so
    /// short German, Portuguese and Italian dictations keep their words.
    #[test]
    fn a_stated_language_keeps_words_the_english_rules_would_remove() {
        for (language, text) in [
            ("de", "Er kommt um acht."),
            ("de", "Um acht Uhr."),
            ("pt", "Comprei um carro novo."),
            ("pt", "Um bom dia."),
            ("it", "Ho visto i ragazzi."),
        ] {
            assert_eq!(voice_defaults_in(Some(language), text, &[]), text, "{text}");
        }
        // Explicit English keeps the English rules.
        assert_eq!(
            voice_defaults_in(Some("en"), "Um, so i think we need two options.", &[]),
            "So I think we need two options."
        );
    }

    /// English dictation with names, acronyms and loanwords that look like
    /// another language still gets English cleanup.
    #[test]
    fn english_names_and_loanwords_still_get_english_cleanup() {
        for (spoken, written) in [
            ("Uh, MIT, um, ALS research.", "MIT, ALS research."),
            ("Um, Al Gore, Al Pacino.", "Al Gore, Al Pacino."),
            ("um, El Al flight", "El Al flight"),
            (
                "Um, Zoë, Chloé, Renée and Noël.",
                "Zoë, Chloé, Renée and Noël.",
            ),
            (
                "Um, sushi, ramen, pho, crème fraîche.",
                "Sushi, ramen, pho, crème fraîche.",
            ),
            ("Um, café au lait.", "Café au lait."),
            (
                "Um, vis-à-vis, the protégé's exposé.",
                "Vis-à-vis, the protégé's exposé.",
            ),
        ] {
            assert_eq!(voice_defaults(spoken), written, "{spoken}");
        }
    }

    /// The decision is made on the recognizer's text, before a snippet adds
    /// text of its own: an Italian sign-off does not switch the English
    /// pronoun rule off for the dictation around it.
    #[test]
    fn a_snippet_expansion_does_not_change_the_language_decision() {
        let snippets = [snippet(
            "italian sign off",
            "Cordiali saluti, il team della sede di Milano che sono anche gli amici",
        )];
        let text = voice_defaults_in(None, "so i think we agree italian sign off", &snippets);
        assert!(text.starts_with("So I think we agree"), "{text}");
    }

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

    fn clock_pipeline(
        text: &str,
        entries: &[DictationDictionaryEntry],
        destination_category: DictationAppCategory,
    ) -> DictationPipelineResult {
        apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text,
            dictionary_entries: entries,
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits: crate::settings::default_dictation_numbers_as_digits("voice"),
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category,
            structured_layout: false,
        })
    }

    #[test]
    fn dotted_clock_times_skip_code_and_ai_destinations() {
        let input = "The meeting is at 12.30 today.";
        let messaging = clock_pipeline(input, &[], DictationAppCategory::Messaging);
        assert!(messaging.text.contains("12:30"), "{}", messaging.text);
        for category in [
            DictationAppCategory::CodeEditor,
            DictationAppCategory::AiChat,
        ] {
            let result = clock_pipeline(input, &[], category);
            assert!(
                result.text.contains("12.30"),
                "{category:?}: {}",
                result.text
            );
            assert!(!result
                .pipeline_stage_keys
                .contains(&"time_format".to_string()));
        }
    }

    #[test]
    fn dotted_clock_times_leave_dictionary_output_alone() {
        // A studio named after a time: without protection "9.30am" would
        // become "9:30am".
        let entries = [dictionary_entry("studio niner", "Studio 9.30am")];
        let result = clock_pipeline(
            "Book studio niner, the meeting is at 12.30 today.",
            &entries,
            DictationAppCategory::Messaging,
        );
        assert!(result.text.contains("Studio 9.30am"), "{}", result.text);
        assert!(result.text.contains("12:30"), "{}", result.text);
    }

    #[test]
    fn spoken_repairs_respect_remove_filler_words() {
        for enabled in [false, true] {
            let result = apply_dictation_pipeline(DictationPipelineInput {
                spoken_language: None,
                text: "orange, err, yellow.",
                dictionary_entries: &[],
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: true,
                clean_disfluencies: enabled,
                numbers_as_digits: false,
                recent_inserted_text: None,
                command_mode_enabled: false,
                destination_category: DictationAppCategory::Other,
                structured_layout: false,
            });
            assert_eq!(
                result.text,
                if enabled {
                    "Yellow."
                } else {
                    "Orange, err, yellow."
                }
            );
            assert_eq!(
                result
                    .pipeline_stage_keys
                    .contains(&"spoken_correction".to_string()),
                enabled
            );
        }
    }

    #[test]
    fn inline_repair_precedes_dictionary_and_respects_literal_mode() {
        let entries = [dictionary_entry("yellow", "amber")];
        for smart in [false, true] {
            let result = apply_dictation_pipeline(DictationPipelineInput {
                spoken_language: None,
                text: "I want orange, err, yellow.",
                dictionary_entries: &entries,
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: smart,
                clean_disfluencies: true,
                numbers_as_digits: false,
                recent_inserted_text: Some("Do not touch this previous insertion."),
                command_mode_enabled: false,
                destination_category: DictationAppCategory::Other,
                structured_layout: false,
            });
            assert_eq!(
                result.text,
                if smart {
                    "I want amber."
                } else {
                    "I want orange, err, amber."
                }
            );
            assert_eq!(result.dictionary_applied_count, 1);
            assert_eq!(result.formatting_applied, smart);
            assert!(!result.undo_previous_insert);
            assert_eq!(
                result
                    .pipeline_stage_keys
                    .contains(&"spoken_correction".to_string()),
                smart
            );
        }
    }

    #[test]
    fn technical_homophone_dictionary_is_scoped_and_hints_only_the_preferred_word() {
        let mut entry = dictionary_entry("off", "auth");
        entry.category_scope = Some("code_editor".to_string());
        let entries = [entry];
        let candidates = vocabulary_candidates_from_entries(&entries, &[]);
        let hint = crate::dictation_parity::build_vocabulary_hint(
            &candidates,
            Some("Code"),
            DictationAppCategory::CodeEditor,
        )
        .expect("auth should be hinted");
        assert_eq!(hint.terms(), &["auth"]);
        assert_eq!(
            apply_learned_dictionary(
                "fix off",
                &entries,
                Some("Code"),
                DictationAppCategory::CodeEditor
            ),
            ("fix auth".to_string(), 1)
        );
        assert_eq!(
            apply_learned_dictionary(
                "turn it off",
                &entries,
                Some("Mail"),
                DictationAppCategory::Email
            ),
            ("turn it off".to_string(), 0)
        );
        assert_eq!(
            apply_learned_dictionary(
                "office",
                &entries,
                Some("Code"),
                DictationAppCategory::CodeEditor
            ),
            ("office".to_string(), 0)
        );
    }

    #[test]
    fn pipeline_applies_dictionary_then_snippets() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "open ai brb",
            dictionary_entries: &[dictionary_entry("open ai", "OpenAI")],
            snippets: &[snippet("brb", "be right back")],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "the invoice came to twelve dollars fifty",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "the invoice came to $12.50");
        assert_eq!(result.pipeline_stage_keys, vec!["itn"]);
    }

    #[test]
    fn pipeline_keeps_currency_and_independent_item_counts_separate() {
        for (source, expected) in [
            (
                "The budget is twelve dollars and fifty people volunteered.",
                "The budget is $12 and 50 people volunteered.",
            ),
            (
                "We need twelve dollars and twenty five chairs.",
                "We need $12 and 25 chairs.",
            ),
            (
                "The rate is twelve dollars and fifty cents per person.",
                "The rate is $12.50 per person.",
            ),
        ] {
            let result = apply_dictation_pipeline(DictationPipelineInput {
                spoken_language: None,
                text: source,
                dictionary_entries: &[],
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: false,
                clean_disfluencies: false,
                numbers_as_digits: true,
                recent_inserted_text: None,
                command_mode_enabled: false,
                destination_category: DictationAppCategory::Other,
                structured_layout: false,
            });
            assert_eq!(result.text, expected, "{source}");
            assert_eq!(result.pipeline_stage_keys, vec!["itn"]);
            assert!(result.command_applied.is_none());
        }
    }

    #[test]
    fn pipeline_leaves_numbers_as_words_when_the_profile_does_not() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "the invoice came to twelve dollars fifty",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "the invoice came to twelve dollars fifty");
        assert!(result.pipeline_stage_keys.is_empty());
    }

    #[test]
    fn pipeline_cleans_repeated_currency_in_words_mode() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "Do not cancel Friday. The rate is €1.4 euros per pound.",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });
        assert_eq!(
            result.text,
            "Do not cancel Friday. The rate is one euro and forty cents per pound."
        );
        assert!(result
            .pipeline_stage_keys
            .contains(&"currency_cleanup".to_string()));
    }

    #[test]
    fn currency_cleanup_preserves_case_insensitive_snippet_triggers() {
        let mut entry = snippet("€1.4 euros", "the approved exchange rate");
        entry.case_sensitive = false;
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "Use €1.4 Euros per pound.",
            dictionary_entries: &[],
            snippets: &[entry],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });
        assert_eq!(result.text, "Use the approved exchange rate per pound.");
        assert_eq!(result.snippet_applied_count, 1);
        assert!(!result
            .pipeline_stage_keys
            .contains(&"currency_cleanup".to_string()));
    }

    #[test]
    fn currency_cleanup_does_not_match_a_case_sensitive_trigger_in_another_case() {
        let mut entry = snippet("€1.4 euros", "the approved exchange rate");
        entry.case_sensitive = true;
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "Use €1.4 Euros per pound.",
            dictionary_entries: &[],
            snippets: &[entry],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });
        assert_eq!(result.text, "Use one euro and forty cents per pound.");
        assert_eq!(result.snippet_applied_count, 0);
        assert!(result
            .pipeline_stage_keys
            .contains(&"currency_cleanup".to_string()));
    }

    /// Stage order: dictionary, then ITN, then snippets. The snippet
    /// expansion is a block of text the user typed once, so it has to reach
    /// the destination exactly as written -- which is only guaranteed if ITN
    /// has already run by the time it is substituted in.
    #[test]
    fn pipeline_runs_itn_between_the_dictionary_and_snippet_stages() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "open ai eta twenty five minutes",
            dictionary_entries: &[dictionary_entry("open ai", "OpenAI")],
            snippets: &[snippet("eta", "back in one two three minutes")],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "take the old highway for twenty miles",
            dictionary_entries: &[dictionary_entry("the old highway", "Route sixty six")],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "take Route sixty six for 20 miles");
        assert_eq!(result.pipeline_stage_keys, vec!["dictionary", "itn"]);
    }

    /// Command handling comes first, so the operands of a phrase swap are
    /// still the words the user said and still match the previous insert --
    /// and the result, which is the previous insert with one edit applied, is
    /// then left alone. Running ITN over it would let a command rewrite text
    /// the user never dictated in this utterance.
    #[test]
    fn pipeline_does_not_normalize_numbers_in_the_output_of_a_phrase_swap() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "replace two with three",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: Some("we need two servers"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_phrase")
        );
        assert_eq!(result.text, "we need three servers");
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
    }

    /// The same gate as snippets and smart formatting: a command's output is
    /// already-inserted text, and the words around the edit must survive it.
    #[test]
    fn pipeline_leaves_the_rest_of_a_previous_insert_alone_after_a_command() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "replace servers with nodes",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: Some("we need twenty five servers"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "we need twenty five nodes");
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
    }

    /// ITN runs before `apply_snippets`, so a trigger with a spoken number in
    /// it has to survive the stage or the snippet never fires.
    #[test]
    fn pipeline_never_rewrites_a_snippet_trigger() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "turn on two factor auth for twenty five people",
            dictionary_entries: &[],
            snippets: &[snippet(
                "two factor auth",
                "two-factor authentication (TOTP)",
            )],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(
            result.text,
            "turn on two-factor authentication (TOTP) for 25 people"
        );
        assert_eq!(result.snippet_applied_count, 1);
        assert_eq!(result.pipeline_stage_keys, vec!["itn", "snippets"]);
    }

    /// A disabled snippet is not protected: it will never expand, so its
    /// trigger is just words the user said.
    #[test]
    fn pipeline_does_not_protect_a_disabled_snippet_trigger() {
        let mut disabled = snippet("twenty factor auth", "two-factor authentication");
        disabled.enabled = false;
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "turn on twenty factor auth",
            dictionary_entries: &[],
            snippets: &[disabled],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "turn on 20 factor auth");
        assert_eq!(result.snippet_applied_count, 0);
    }

    #[test]
    fn pipeline_does_not_protect_an_app_scoped_snippet_in_another_app() {
        let mut scoped = snippet("two", "second");
        scoped.app_scope = Some("Firefox".to_string());
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "twenty two people",
            dictionary_entries: &[],
            snippets: &[scoped],
            app_target: Some("Terminal"),
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "22 people");
        assert_eq!(result.snippet_applied_count, 0);
    }

    #[test]
    fn pipeline_does_not_protect_a_category_scoped_snippet_elsewhere() {
        let mut scoped = snippet("two", "second");
        scoped.category_scope = Some("email".to_string());
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "twenty two people",
            dictionary_entries: &[],
            snippets: &[scoped],
            app_target: Some("Notes"),
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Notes,
            structured_layout: false,
        });

        assert_eq!(result.text, "22 people");
        assert_eq!(result.snippet_applied_count, 0);
    }

    /// The undo command produces no text, so the stage has nothing to do and
    /// must not announce itself.
    #[test]
    fn pipeline_skips_itn_when_a_command_swallowed_the_utterance() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "scratch that",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: Some("we need twenty five servers"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert!(result.text.is_empty());
        assert_eq!(result.pipeline_stage_keys, vec!["backtrack"]);
    }

    #[test]
    fn pipeline_composes_itn_with_smart_formatting() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "we shipped one hundred twenty three builds",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "We shipped 123 builds");
        assert_eq!(result.pipeline_stage_keys, vec!["itn", "smart_formatting"]);
    }

    #[test]
    fn pipeline_replaces_last_insert_for_actually_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "actually ship it tomorrow",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it today"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
    fn pipeline_keeps_backtrack_phrase_as_text_when_command_mode_is_disabled() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "scratch that",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it today"),
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "scratch that");
        assert!(result.command_applied.is_none());
        assert!(!result.recent_insert_reused);
        assert!(!result.undo_previous_insert);
    }

    #[test]
    fn pipeline_replaces_last_insert_for_actually_comma_backtrack() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "actually, ship it Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it Friday"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "no, actually ship it next week",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it tomorrow"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "scratch that",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "scratch that actually ship it tomorrow",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it today"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        });

        assert_eq!(result.text, "ship it tomorrow");
        assert_eq!(
            result.command_applied.as_deref(),
            Some("backtrack_replace_last_insert")
        );
        assert!(result.recent_insert_reused);
        assert!(result.undo_previous_insert);
    }

    fn default_path_input(text: &str) -> DictationPipelineInput<'_> {
        // What the live dictation path passes on a fresh install.
        DictationPipelineInput {
            spoken_language: None,
            text,
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: crate::settings::TranscriptionSettings::default()
                .dictation_remove_disfluencies,
            numbers_as_digits: crate::settings::default_dictation_numbers_as_digits("voice"),
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        }
    }

    #[test]
    fn default_path_removes_hesitations_stutters_and_typed_corrections() {
        let result = apply_dictation_pipeline(default_path_input(
            "Um, so I think we should, uh, meet on Tuesday, no wait, Wednesday at 3 and bring the the slides.",
        ));
        assert_eq!(
            result.text,
            "So I think we should meet on Wednesday at 3 and bring the slides."
        );
        assert!(result
            .pipeline_stage_keys
            .iter()
            .any(|key| key == "disfluency_cleanup"));
    }

    #[test]
    fn default_path_preserves_literal_cleanup_words() {
        let result = apply_dictation_pipeline(default_path_input(
            "Um, write exactly \"please um bring the the slides Tuesday no wait Wednesday\" and bring the the notes.",
        ));
        assert_eq!(
            result.text,
            "Write exactly \"please um bring the the slides Tuesday no wait Wednesday\" and bring the notes."
        );
        assert!(result
            .pipeline_stage_keys
            .iter()
            .any(|key| key == "disfluency_cleanup"));
    }

    #[test]
    fn default_path_never_empties_a_dictation_of_only_a_hesitation() {
        let result = apply_dictation_pipeline(default_path_input("Um."));
        assert!(!result.text.trim().is_empty());
    }

    #[test]
    fn pipeline_applies_dictionary_before_scratch_that_replacement() {
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: None,
            text: "scratch that jon is ready",
            dictionary_entries: &[dictionary_entry("jon", "John")],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("sam is ready"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "replace tomorrow with Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "日本語のテキストです",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("前のテキスト"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
            spoken_language: None,
            text: "change tomorrow to Monday",
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: false,
            recent_inserted_text: Some("ship it tomorrow morning"),
            command_mode_enabled: true,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
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
        run_pipeline_for(
            input,
            mode_preset,
            numbers_as_digits,
            dictionary_entries,
            DictationAppCategory::Other,
            false,
        )
    }

    fn run_pipeline_for(
        input: &str,
        mode_preset: &str,
        numbers_as_digits: bool,
        dictionary_entries: &[DictationDictionaryEntry],
        destination_category: DictationAppCategory,
        structured_layout: bool,
    ) -> DictationPipelineResult {
        apply_dictation_pipeline(DictationPipelineInput {
            dictionary_entries,
            ..pipeline_input_for(
                input,
                mode_preset,
                numbers_as_digits,
                destination_category,
                structured_layout,
            )
        })
    }

    fn pipeline_input_for<'a>(
        input: &'a str,
        mode_preset: &'a str,
        numbers_as_digits: bool,
        destination_category: DictationAppCategory,
        structured_layout: bool,
    ) -> DictationPipelineInput<'a> {
        DictationPipelineInput {
            spoken_language: None,
            text: input,
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset,
            smart_formatting_enabled: true,
            clean_disfluencies: false,
            numbers_as_digits,
            recent_inserted_text: None,
            command_mode_enabled: true,
            destination_category,
            structured_layout,
        }
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
    ///
    /// `formattingHint` names the destination app, resolved the way live
    /// dictation resolves an app name. `structuredLayout` defaults to the
    /// production default (destination-aware formatting on, multi-line
    /// field); set it to false to model a single-line field or the setting
    /// turned off.
    #[test]
    fn quality_formatting_fixtures_do_not_regress() {
        let fixture = load("dictation-quality-fixtures.json");
        let cases = fixture["formattingCases"]
            .as_array()
            .expect("formattingCases");
        assert!(!cases.is_empty());
        let mut failures = Vec::new();

        for case in cases {
            let id = required(case, "id");
            let input = required(case, "inputText");
            let mode_preset = field(case, "modePreset").unwrap_or("voice");
            let expected = required(case, "expectedOutput");

            let category = crate::text::format::resolve_dictation_app_category(
                field(case, "formattingHint"),
                None,
            );
            let layout = case["structuredLayout"].as_bool().unwrap_or(true);
            // Remove filler words is on by default; older cases model it off.
            let clean_disfluencies = case["cleanDisfluencies"].as_bool().unwrap_or(false);
            let run = |numbers_as_digits| {
                apply_dictation_pipeline(DictationPipelineInput {
                    clean_disfluencies,
                    ..pipeline_input_for(input, mode_preset, numbers_as_digits, category, layout)
                })
            };

            let without = run(false);
            let expected_words = field(case, "expectedNumbersAsWordsOutput").unwrap_or(expected);
            if without.text != expected_words {
                failures.push(format!(
                    "case {id} words: {:?} != {expected_words:?}",
                    without.text
                ));
            }

            let expected_with = field(case, "expectedNumbersAsDigitsOutput").unwrap_or(expected);
            let with = run(true);
            if with.text != expected_with {
                failures.push(format!(
                    "case {id} digits: {:?} != {expected_with:?}",
                    with.text
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
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
                spoken_language: None,
                text: input,
                dictionary_entries: &entries,
                snippets: &[],
                app_target,
                mode_preset: "voice",
                smart_formatting_enabled: false,
                clean_disfluencies: false,
                numbers_as_digits: true,
                recent_inserted_text: None,
                command_mode_enabled: true,
                destination_category: DictationAppCategory::Other,
                structured_layout: false,
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

    /// Literal words must survive the same validator used after AI cleanup.
    #[test]
    fn quality_cleanup_validation_fixtures_match() {
        let fixture = load("dictation-quality-fixtures.json");
        let cases = fixture["cleanupValidationCases"]
            .as_array()
            .expect("cleanupValidationCases");
        assert!(!cases.is_empty());
        for case in cases {
            let source = required(case, "inputText");
            let candidate = required(case, "candidateText");
            assert_eq!(
                crate::dictation_fidelity::validate_cleanup(source, candidate).is_ok(),
                case["expectedAccepted"]
                    .as_bool()
                    .expect("expectedAccepted"),
                "case {}",
                required(case, "id")
            );
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

    /// Spoken money follows each preset's own words-or-digits default: Voice
    /// keeps what was said as words, the written presets type the amount.
    #[test]
    fn spoken_money_follows_the_presets_numbers_choice() {
        let cases = [
            "the round was three point two million dollars",
            "the laptop was twelve hundred dollars",
            "we ordered twenty laptops",
            "call me at six thirty",
        ];
        let voice = crate::settings::default_dictation_numbers_as_digits("voice");
        let notes = crate::settings::default_dictation_numbers_as_digits("notes");
        assert!(voice && notes);
        let outputs = |preset: &str, digits: bool| {
            cases
                .iter()
                .map(|input| run_pipeline(input, preset, digits, &[]).text)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            outputs("voice", false),
            [
                "The round was three point two million dollars",
                "The laptop was twelve hundred dollars",
                "We ordered twenty laptops",
                "Call me at six thirty",
            ]
        );
        assert_eq!(outputs("voice", voice), outputs("notes", notes));
        assert_eq!(
            outputs("notes", notes),
            [
                "The round was $3.2 million",
                "The laptop was $1,200",
                "We ordered 20 laptops",
                "Call me at 6:30",
            ]
        );
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
