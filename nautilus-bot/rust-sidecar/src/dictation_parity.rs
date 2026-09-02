use serde::{Deserialize, Serialize};

use crate::asr::VocabularyHint;
use crate::text::format::DictationAppCategory;

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
    /// Optional dictation-destination-app category key (one of the
    /// `dictation_app_category_to_key`/`from_key` strings in `settings.rs`:
    /// other/messaging/email/notes/worklog/ai_chat/code_editor). When set,
    /// this rule only applies if the current destination app resolves to the
    /// same category. When `None` (the default), the rule applies regardless
    /// of category, exactly as before this field existed.
    #[serde(default)]
    pub category_scope: Option<String>,
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
    /// See `DictionaryRule::category_scope`.
    #[serde(default)]
    pub category_scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearnedCorrectionCandidate {
    pub spoken_form: String,
    pub replacement: String,
}

fn default_true() -> bool {
    true
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

/// Mirrors `snippet_app_scope_matches`'s blank-matches-everything convention:
/// a missing/blank `category_scope` always matches (i.e. the rule is not
/// category-scoped and applies regardless of destination-app category). When
/// a category is set, it must match the resolved `destination_category`
/// (via `dictation_app_category_to_key`) exactly. An unrecognized scope
/// (e.g. a typo'd CSV value that predates import validation) matches
/// nothing, rather than silently mapping to `Other` and firing in every
/// unclassified app.
fn category_scope_matches(
    category_scope: Option<&str>,
    destination_category: DictationAppCategory,
) -> bool {
    let Some(scope) = category_scope
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    crate::settings::dictation_app_category_from_key_strict(scope)
        .is_some_and(|category| category == destination_category)
}

fn is_dictionary_word_boundary(ch: char) -> bool {
    !(ch.is_ascii_alphanumeric() || ch == '_')
}

/// Word-boundary replacement via zero-width boundary checks around each raw
/// needle match, instead of a regex whose boundary groups consume the
/// separator character (which makes adjacent occurrences like "jon jon jon"
/// skip every other match).
fn replace_dictionary_word_bounded_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
    case_insensitive: bool,
) -> (String, usize) {
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        return (haystack.to_string(), 0);
    }

    let escaped = regex::escape(trimmed);
    let Ok(re) = regex::RegexBuilder::new(&escaped)
        .case_insensitive(case_insensitive)
        .build()
    else {
        return (haystack.to_string(), 0);
    };

    let mut output = String::with_capacity(haystack.len());
    let mut last_end = 0usize;
    let mut applied = 0usize;
    for found in re.find_iter(haystack) {
        let boundary_before = haystack[..found.start()]
            .chars()
            .next_back()
            .is_none_or(is_dictionary_word_boundary);
        let boundary_after = haystack[found.end()..]
            .chars()
            .next()
            .is_none_or(is_dictionary_word_boundary);
        if !(boundary_before && boundary_after) {
            continue;
        }
        output.push_str(&haystack[last_end..found.start()]);
        output.push_str(replacement);
        last_end = found.end();
        applied += 1;
    }

    if applied == 0 {
        return (haystack.to_string(), 0);
    }
    output.push_str(&haystack[last_end..]);
    (output, applied)
}

fn replace_dictionary_case_sensitive_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> (String, usize) {
    replace_dictionary_word_bounded_all(haystack, needle, replacement, false)
}

fn replace_dictionary_case_insensitive_all(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> (String, usize) {
    replace_dictionary_word_bounded_all(haystack, needle, replacement, true)
}

pub fn apply_dictation_dictionary(
    input: &str,
    rules: &[DictionaryRule],
    app_target: Option<&str>,
) -> (String, usize) {
    apply_dictation_dictionary_for_category(input, rules, app_target, DictationAppCategory::Other)
}

/// Same as `apply_dictation_dictionary`, but additionally scopes rules whose
/// `category_scope` is set to only apply when `destination_category` matches.
/// Rules with `category_scope: None` are unaffected by `destination_category`
/// and always apply (subject to the existing `app_scope`/`enabled` checks) —
/// this preserves `apply_dictation_dictionary`'s exact prior behavior for
/// every existing entry.
pub fn apply_dictation_dictionary_for_category(
    input: &str,
    rules: &[DictionaryRule],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize) {
    if input.trim().is_empty() || rules.is_empty() {
        return (input.to_string(), 0);
    }

    let mut output = input.to_string();
    let mut applied_total = 0usize;
    let mut ordered = rules.to_vec();
    ordered.sort_by_key(|rule| std::cmp::Reverse(rule.spoken_form.len()));

    for rule in ordered {
        if !rule.enabled {
            continue;
        }
        if !snippet_app_scope_matches(rule.app_scope.as_deref(), app_target) {
            continue;
        }
        if !category_scope_matches(rule.category_scope.as_deref(), destination_category) {
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
    apply_dictation_snippets_for_category(input, snippets, app_target, DictationAppCategory::Other)
}

/// Same as `apply_dictation_snippets`, but additionally scopes snippets whose
/// `category_scope` is set to only apply when `destination_category` matches.
/// Snippets with `category_scope: None` are unaffected by
/// `destination_category` and always apply (subject to the existing
/// `app_scope`/`enabled` checks) — this preserves `apply_dictation_snippets`'s
/// exact prior behavior for every existing entry.
pub fn apply_dictation_snippets_for_category(
    input: &str,
    snippets: &[SnippetRule],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> (String, usize) {
    if input.trim().is_empty() || snippets.is_empty() {
        return (input.to_string(), 0);
    }

    let mut output = input.to_string();
    let mut applied_total = 0usize;
    let mut ordered = snippets.to_vec();
    ordered.sort_by_key(|snippet| std::cmp::Reverse(snippet.trigger.len()));

    for snippet in ordered {
        if !snippet.enabled {
            continue;
        }
        if !snippet_app_scope_matches(snippet.app_scope.as_deref(), app_target) {
            continue;
        }
        if !category_scope_matches(snippet.category_scope.as_deref(), destination_category) {
            continue;
        }
        if snippet.trigger.trim().is_empty() {
            continue;
        }

        // Word-bounded, exactly like dictionary entries. A bare substring
        // replace fired on any trigger that happened to sit inside a longer
        // dictated word, so a "brb" snippet rewrote the middle of "brbecue".
        let (next, applied) = replace_dictionary_word_bounded_all(
            output.as_str(),
            snippet.trigger.as_str(),
            snippet.expansion.as_str(),
            !snippet.case_sensitive,
        );
        if applied > 0 {
            output = next;
            applied_total += applied;
        }
    }

    (output, applied_total)
}

/// Cap on the recognizer vocabulary hint, terms first, then characters of
/// the whole prompt (`VocabularyHint::as_prompt`, frame included) — whichever
/// is reached first. whisper's prompt window is half its 448-token text
/// context; ~600 characters of short terms stays well inside it and leaves
/// the first decode window room for speech.
pub const VOCABULARY_HINT_MAX_TERMS: usize = 60;
pub const VOCABULARY_HINT_MAX_CHARS: usize = 600;
/// Estimated-token cap on the framed prompt, under whisper's 224-token
/// prompt window with room to spare. Characters alone do not bound tokens —
/// rare proper nouns tokenize into many short pieces — so the builder also
/// stops when `VocabularyHint::estimate_prompt_tokens` would exceed this.
pub const VOCABULARY_HINT_MAX_TOKENS: usize = 200;

/// Longest single term worth sending: anything longer is a sentence, not a
/// vocabulary item, and ElevenLabs' keyterm limit is the same number.
const VOCABULARY_TERM_MAX_CHARS: usize = 50;
const VOCABULARY_PLAIN_WORD_MAX_CHARS: usize = 32;

/// Where a vocabulary candidate came from, which decides how strict the
/// term filter is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VocabularyTermKind {
    /// A dictionary entry's written form (its *replacement*), the spelling
    /// the recognizer should prefer. Multi-word replacements are fine.
    DictionaryReplacement,
    /// A snippet trigger. Only a plain single word qualifies — "brb", not
    /// "my address" — and the expansion is never a candidate at all.
    SnippetTrigger,
}

/// One candidate for the recognizer vocabulary hint, carrying the same
/// app/category scoping the post-transcription replacement honors and a
/// recency so newer entries win the cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabularyTermCandidate {
    pub term: String,
    pub app_scope: Option<String>,
    pub category_scope: Option<String>,
    pub enabled: bool,
    /// Most recent add/edit, epoch milliseconds. Higher is newer.
    pub recency_ms: i64,
    pub kind: VocabularyTermKind,
}

/// Builds the vocabulary hint for one dictation from the candidates that
/// apply to `app_target` / `destination_category` — the exact scoping
/// `apply_dictation_dictionary_for_category` and
/// `apply_dictation_snippets_for_category` use afterwards, so the recognizer
/// is only ever biased toward spellings the text pass would also enforce.
///
/// Newest first (ties keep input order, so the result is stable for a given
/// list), deduplicated case-insensitively keeping the first occurrence, and
/// cut at `VOCABULARY_HINT_MAX_TERMS` / `VOCABULARY_HINT_MAX_CHARS`,
/// whichever comes first. `None` when nothing applies.
pub fn build_vocabulary_hint(
    candidates: &[VocabularyTermCandidate],
    app_target: Option<&str>,
    destination_category: DictationAppCategory,
) -> Option<VocabularyHint> {
    let mut eligible: Vec<(i64, usize, String)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.enabled)
        .filter(|(_, candidate)| {
            snippet_app_scope_matches(candidate.app_scope.as_deref(), app_target)
        })
        .filter(|(_, candidate)| {
            category_scope_matches(candidate.category_scope.as_deref(), destination_category)
        })
        .filter_map(|(index, candidate)| {
            let term = normalize_vocabulary_term(&candidate.term)?;
            if candidate.kind == VocabularyTermKind::SnippetTrigger
                && !is_plain_vocabulary_word(&term)
            {
                return None;
            }
            Some((candidate.recency_ms, index, term))
        })
        .collect();
    eligible.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut seen = std::collections::HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    let mut prompt_chars = VocabularyHint::PROMPT_FRAME_CHARS;
    let mut prompt = String::new();
    for (_, _, term) in eligible {
        if !seen.insert(term.to_lowercase()) {
            continue;
        }
        let separator = if terms.is_empty() { 0 } else { 2 };
        let added = term.chars().count() + separator;
        // The exact prompt the next term would produce, for the token
        // estimate (frame, separators and the trailing period included).
        let candidate_prompt = if terms.is_empty() {
            format!("Vocabulary: {term}.")
        } else {
            format!("{}, {term}.", &prompt[..prompt.len() - 1])
        };
        if terms.len() >= VOCABULARY_HINT_MAX_TERMS
            || prompt_chars + added > VOCABULARY_HINT_MAX_CHARS
            || VocabularyHint::estimate_prompt_tokens(&candidate_prompt)
                > VOCABULARY_HINT_MAX_TOKENS
        {
            break;
        }
        prompt_chars += added;
        prompt = candidate_prompt;
        terms.push(term);
    }

    VocabularyHint::new(terms)
}

/// Trims, collapses internal whitespace, and rejects anything that is not a
/// term: empty, no letter or digit, control characters, a length that makes
/// it a sentence, or the bracket/backslash characters no provider accepts.
fn normalize_vocabulary_term(raw: &str) -> Option<String> {
    let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if term.is_empty()
        || !term.chars().any(char::is_alphanumeric)
        || term.chars().any(char::is_control)
        || term.chars().count() > VOCABULARY_TERM_MAX_CHARS
        || term
            .chars()
            .any(|ch| matches!(ch, '<' | '>' | '{' | '}' | '[' | ']' | '\\'))
    {
        return None;
    }
    Some(term)
}

/// A single token made of letters, digits, apostrophes or hyphens, with at
/// least one letter — the shape of a snippet trigger that is also a word a
/// recognizer could plausibly mis-hear ("brb", "ttyl", "e-mail").
fn is_plain_vocabulary_word(term: &str) -> bool {
    term.chars().count() >= 2
        && term.chars().count() <= VOCABULARY_PLAIN_WORD_MAX_CHARS
        && term.chars().any(char::is_alphabetic)
        && term
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '\'' | '-'))
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

/// Whether `action` still needs selected/clipboard text to do anything.
///
/// Actions that carry their own spoken payload ("command rewrite shorter make
/// this snappy") answer `false`, because `resolve_contextual_command_input`
/// prefers the spoken text over any captured context. Used by the stop path to
/// decide whether it is worth capturing the frontmost app's selection at
/// execution time — capturing on every dictation would fire a synthetic copy
/// into the target app and clobber the clipboard for no reason.
pub fn dictation_command_action_needs_context(action: &DictationCommandAction) -> bool {
    match action {
        DictationCommandAction::InsertText(_)
        | DictationCommandAction::UndoLastInsert
        | DictationCommandAction::DeleteLastSentence
        | DictationCommandAction::DeleteSelection => false,
        DictationCommandAction::ReplaceEntireSelection(payload)
        | DictationCommandAction::RewriteShorter(payload)
        | DictationCommandAction::RewriteProfessional(payload)
        | DictationCommandAction::Bulletize(payload) => payload.trim().is_empty(),
        DictationCommandAction::ReplaceSelection { .. }
        | DictationCommandAction::AppendToSelection(_)
        | DictationCommandAction::PrependToSelection(_)
        | DictationCommandAction::DeletePhrase(_)
        | DictationCommandAction::UppercaseSelection
        | DictationCommandAction::LowercaseSelection
        | DictationCommandAction::TitleCaseSelection
        | DictationCommandAction::SentenceCaseSelection => true,
    }
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
            "{} needs selected text, but Plainsong could not capture any selected text from the frontmost app.",
            action_label
        ),
        "clipboard" => format!(
            "{} needs clipboard text, but the clipboard was empty when dictation started.",
            action_label
        ),
        "application_context" => format!(
            "{} needs app context, but Plainsong could not capture useful text from the frontmost app.",
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
        "proofread_text" => Some(
            "Proofread the user's text. Correct spelling, grammar, punctuation, and \
            capitalization while preserving meaning, tone, structure, and wording as much as \
            possible. Return only the corrected text.",
        ),
        "rewrite_shorter" => Some(
            "Rewrite the user's text to be shorter while preserving intent. \
            Keep the same language and tone. Return only the rewritten text.",
        ),
        "expand_text" => Some(
            "Expand the user's text with useful context, clearer connective tissue, and \
            concrete detail while preserving intent and avoiding unsupported assumptions. \
            Return only the expanded text.",
        ),
        "continue_writing" => Some(
            "Continue the user's text with the next useful sentence or paragraph while \
            preserving style, facts, and direction. Do not repeat the original text unless \
            needed for continuity. Return only the continued text.",
        ),
        "simplify_language" => Some(
            "Rewrite the user's text in clear, plain language while preserving meaning, facts, \
            and important nuance. Prefer shorter sentences and familiar words. Return only the \
            simplified text.",
        ),
        "rewrite_professional" => Some(
            "Rewrite the user's text in a professional tone while preserving meaning. \
            Keep it clear and concise. Return only the rewritten text.",
        ),
        "rewrite_friendly" => Some(
            "Rewrite the user's text in a friendly, warm tone while preserving meaning and \
            avoiding extra enthusiasm. Keep it clear and concise. Return only the rewritten \
            text.",
        ),
        "rewrite_casual" => Some(
            "Rewrite the user's text in a casual, conversational tone while preserving meaning \
            and avoiding slang, filler, or extra enthusiasm. Return only the rewritten text.",
        ),
        "summarize_text" => Some(
            "Summarize the user's text into the shortest useful summary while preserving key \
            decisions, facts, and action items. Return only the summary.",
        ),
        "translate_english" => Some(
            "Translate the user's text into clear, natural English while preserving names, \
            product terms, code, URLs, and formatting. Return only the translated English \
            text.",
        ),
        "explain_text" => Some(
            "Explain the user's text in plain language for a competent reader who lacks the \
            original context. Preserve important details. Return only the explanation.",
        ),
        "find_bugs" => Some(
            "Review the user's selected code, instructions, or plan for concrete bugs, \
            contradictions, edge cases, and missing checks. Return only concise findings. If \
            no bugs are found, say No concrete bugs found.",
        ),
        "bulletize_selection" => Some(
            "Convert the user's text into concise bullet points. \
            Use one bullet per idea. Return only the bullet list.",
        ),
        "numbered_list_selection" => Some(
            "Convert the user's text into a concise numbered list. Use one numbered item per \
            step, idea, or decision. Return only the numbered list.",
        ),
        "polish_text" => Some(
            "Improve the user's writing for clarity, flow, and concision while preserving \
            meaning, voice, and important details. Return only the improved text.",
        ),
        "prompt_engineer" => Some(
            "Rewrite the user's text as a clear, well-structured AI prompt. Include objective, \
            context, constraints, output format, and success criteria when they are implied. \
            Return only the prompt.",
        ),
        _ => None,
    }
}

/// Human-readable label for a dictation command when it is applied to text
/// that already exists somewhere on screen (an explicit selection, or a
/// focused field for Quick-Fix-style commands), as opposed to freshly
/// dictated text. Used by the selected-text transform feature to phrase
/// status/error messages (e.g. "Rewrite Shorter Selected Text result is
/// empty.").
///
/// Covers every selected-text command exposed by the renderer's
/// `SELECTED_TEXT_ACTIONS`/command palette (see
/// `src/lib/selected-text-actions.ts`): the AI-backed rewrite/transform
/// commands (each with a matching `default_dictation_command_prompt` entry
/// above) and the four local-only case-transform commands.
pub fn dictation_command_selected_text_label(command_key: &str) -> Option<&'static str> {
    match command_key {
        "proofread_text" => Some("Quick Fix Selected Text"),
        "rewrite_shorter" => Some("Rewrite Shorter Selected Text"),
        "expand_text" => Some("Expand Selected Text"),
        "continue_writing" => Some("Continue Writing Selected Text"),
        "simplify_language" => Some("Simplify Language Selected Text"),
        "rewrite_professional" => Some("Rewrite Professional Selected Text"),
        "rewrite_friendly" => Some("Friendly Tone Selected Text"),
        "rewrite_casual" => Some("Casual Tone Selected Text"),
        "summarize_text" => Some("Summarize Selected Text"),
        "translate_english" => Some("Translate Selected Text"),
        "explain_text" => Some("Explain Selected Text"),
        "find_bugs" => Some("Find Bugs in Selected Text"),
        "bulletize_selection" => Some("Bulletize Selected Text"),
        "numbered_list_selection" => Some("Numbered List Selected Text"),
        "polish_text" => Some("Polish Selected Text"),
        "prompt_engineer" => Some("Prompt Engineer Selected Text"),
        "uppercase_selection" => Some("Uppercase Selected Text"),
        "lowercase_selection" => Some("Lowercase Selected Text"),
        "title_case_selection" => Some("Title Case Selected Text"),
        "sentence_case_selection" => Some("Sentence Case Selected Text"),
        _ => None,
    }
}

/// Whether a command key is resolved purely with local Rust logic (no LLM
/// call, no fallback needed) — currently the four case-transform commands.
pub fn is_local_only_selected_text_command(command_key: &str) -> bool {
    matches!(
        command_key,
        "uppercase_selection"
            | "lowercase_selection"
            | "title_case_selection"
            | "sentence_case_selection"
    )
}

/// Whether `command_key` is allowed to fall back to the whole focused-field
/// contents (via `capture_focused_field_text_via_accessibility`) when no
/// explicit text selection could be captured, rather than surfacing a
/// "select some text" error immediately.
///
/// This matches the renderer's own metadata
/// (`SELECTED_TEXT_TARGET_POLICY_LABELS` in
/// src/lib/selected-text-actions.ts): only `proofread_text` (Quick Fix) is
/// `prefer_selection`/fallback-eligible; every other command is
/// `selection_required` and must error instead of silently transforming —
/// and overwriting — the entire focused field (e.g. summarizing a whole
/// email draft because the caret happened to sit in it with nothing
/// selected).
pub fn allows_focused_field_fallback(command_key: &str) -> bool {
    command_key == "proofread_text"
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
                category_scope: None,
            },
            DictionaryRule {
                spoken_form: "open ai".to_string(),
                replacement: "OpenAI".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
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
    fn dictionary_replacements_cover_adjacent_occurrences() {
        // Regression: the old boundary groups consumed the separating space,
        // so "jon jon jon" only replaced the first and third occurrence.
        let rules = vec![DictionaryRule {
            spoken_form: "jon".to_string(),
            replacement: "John".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        }];

        let (output, applied) = apply_dictation_dictionary("jon jon jon", &rules, None);
        assert_eq!(output, "John John John");
        assert_eq!(applied, 3);
    }

    #[test]
    fn dictionary_unknown_category_scope_matches_nothing() {
        // A typo'd scope ("ai chat" instead of "ai_chat") must never fire —
        // previously it mapped to Other and applied in every unclassified app.
        let rules = vec![DictionaryRule {
            spoken_form: "brb".to_string(),
            replacement: "be right back".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("ai chat".to_string()),
        }];

        for category in [
            DictationAppCategory::Other,
            DictationAppCategory::AiChat,
            DictationAppCategory::Messaging,
        ] {
            let (output, applied) =
                apply_dictation_dictionary_for_category("brb everyone", &rules, None, category);
            assert_eq!(output, "brb everyone", "scope must not match {category:?}");
            assert_eq!(applied, 0);
        }
    }

    #[test]
    fn dictionary_replacements_respect_app_scope_matching() {
        let rules = vec![DictionaryRule {
            spoken_form: "follow up".to_string(),
            replacement: "follow-up".to_string(),
            app_scope: Some("gmail".to_string()),
            case_sensitive: false,
            enabled: true,
            category_scope: None,
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
    fn dictionary_category_scoped_entry_applies_only_when_category_matches() {
        let rules = vec![DictionaryRule {
            spoken_form: "brb".to_string(),
            replacement: "be right back".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
        }];

        let (matching, matching_count) = apply_dictation_dictionary_for_category(
            "brb everyone",
            &rules,
            Some("Slack"),
            DictationAppCategory::Messaging,
        );
        assert_eq!(matching, "be right back everyone");
        assert_eq!(matching_count, 1);
    }

    #[test]
    fn dictionary_category_scoped_entry_is_skipped_for_non_matching_category() {
        let rules = vec![DictionaryRule {
            spoken_form: "brb".to_string(),
            replacement: "be right back".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
        }];

        let (output, applied) = apply_dictation_dictionary_for_category(
            "brb everyone",
            &rules,
            Some("Gmail"),
            DictationAppCategory::Email,
        );
        assert_eq!(output, "brb everyone");
        assert_eq!(applied, 0);
    }

    #[test]
    fn dictionary_entry_without_category_scope_applies_regardless_of_category() {
        // Regression-safety: entries with no category_scope must apply exactly
        // as before this feature existed, no matter what destination category
        // is passed in.
        let rules = vec![DictionaryRule {
            spoken_form: "open ai".to_string(),
            replacement: "OpenAI".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        }];

        for category in [
            DictationAppCategory::Other,
            DictationAppCategory::Messaging,
            DictationAppCategory::Email,
            DictationAppCategory::Notes,
            DictationAppCategory::Worklog,
            DictationAppCategory::AiChat,
            DictationAppCategory::CodeEditor,
        ] {
            let (output, applied) = apply_dictation_dictionary_for_category(
                "please email open ai today",
                &rules,
                None,
                category,
            );
            assert_eq!(output, "please email OpenAI today");
            assert_eq!(
                applied, 1,
                "expected match regardless of category {category:?}"
            );
        }

        // The plain (non-category-aware) entry point must also behave
        // identically, since it defaults to Other internally.
        let (output, applied) =
            apply_dictation_dictionary("please email open ai today", &rules, None);
        assert_eq!(output, "please email OpenAI today");
        assert_eq!(applied, 1);
    }

    #[test]
    fn snippet_replacements_respect_word_boundaries() {
        // Regression: snippets used a bare substring replace, so a "brb"
        // snippet rewrote the middle of "brbecue" and any longer word that
        // happened to contain the trigger.
        let snippets = vec![
            SnippetRule {
                trigger: "brb".to_string(),
                expansion: "be right back".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            },
            SnippetRule {
                trigger: "IRL".to_string(),
                expansion: "in real life".to_string(),
                app_scope: None,
                case_sensitive: true,
                enabled: true,
                category_scope: None,
            },
        ];

        let (output, applied) =
            apply_dictation_snippets("brb, the brbecue is IRL not IRLish", &snippets, None);
        assert_eq!(
            output,
            "be right back, the brbecue is in real life not IRLish"
        );
        assert_eq!(applied, 2);
    }

    #[test]
    fn command_actions_only_need_context_when_no_spoken_payload_carries_it() {
        assert!(dictation_command_action_needs_context(
            &DictationCommandAction::UppercaseSelection
        ));
        assert!(dictation_command_action_needs_context(
            &DictationCommandAction::RewriteShorter(String::new())
        ));
        assert!(!dictation_command_action_needs_context(
            &DictationCommandAction::RewriteShorter("make this snappy".to_string())
        ));
        assert!(!dictation_command_action_needs_context(
            &DictationCommandAction::InsertText("\n".to_string())
        ));
        assert!(!dictation_command_action_needs_context(
            &DictationCommandAction::UndoLastInsert
        ));
    }

    #[test]
    fn snippet_category_scoped_entry_applies_only_when_category_matches() {
        let snippets = vec![SnippetRule {
            trigger: "omw".to_string(),
            expansion: "on my way".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
        }];

        let (matching, matching_count) = apply_dictation_snippets_for_category(
            "omw now",
            &snippets,
            Some("Slack"),
            DictationAppCategory::Messaging,
        );
        assert_eq!(matching, "on my way now");
        assert_eq!(matching_count, 1);
    }

    #[test]
    fn snippet_category_scoped_entry_is_skipped_for_non_matching_category() {
        let snippets = vec![SnippetRule {
            trigger: "omw".to_string(),
            expansion: "on my way".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
        }];

        let (output, applied) = apply_dictation_snippets_for_category(
            "omw now",
            &snippets,
            Some("Notion"),
            DictationAppCategory::Notes,
        );
        assert_eq!(output, "omw now");
        assert_eq!(applied, 0);
    }

    #[test]
    fn snippet_without_category_scope_applies_regardless_of_category() {
        // Regression-safety: snippets with no category_scope must apply
        // exactly as before this feature existed, no matter what destination
        // category is passed in.
        let snippets = vec![SnippetRule {
            trigger: "brb".to_string(),
            expansion: "be right back".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        }];

        for category in [
            DictationAppCategory::Other,
            DictationAppCategory::Messaging,
            DictationAppCategory::Email,
            DictationAppCategory::Notes,
            DictationAppCategory::Worklog,
            DictationAppCategory::AiChat,
            DictationAppCategory::CodeEditor,
        ] {
            let (output, applied) =
                apply_dictation_snippets_for_category("brb team", &snippets, None, category);
            assert_eq!(output, "be right back team");
            assert_eq!(
                applied, 1,
                "expected match regardless of category {category:?}"
            );
        }

        let (output, applied) = apply_dictation_snippets("brb team", &snippets, None);
        assert_eq!(output, "be right back team");
        assert_eq!(applied, 1);
    }

    #[test]
    fn category_scoped_dictionary_entry_applies_via_resolver_even_when_ai_formatting_toggle_is_off()
    {
        // Regression test: a user with a category-scoped dictionary entry
        // (e.g. a medical term that should only expand in an EHR/notes app)
        // expects that scoping to work regardless of whether they've
        // separately disabled AI-category-formatting. That toggle only
        // governs the LLM dictation-formatting prompt fragment; it must not
        // affect dictionary/snippet category-scope matching, which depends
        // on `resolve_dictation_app_category_with_overrides` always
        // returning the real resolved category.
        let transcription = crate::settings::TranscriptionSettings {
            dictation_category_formatting_enabled: false,
            dictation_app_category_overrides: vec![crate::settings::DictationAppCategoryOverride {
                id: "1".to_string(),
                app_matcher: "epic".to_string(),
                category: "notes".to_string(),
                enabled: true,
            }],
            ..crate::settings::TranscriptionSettings::default()
        };

        let destination_category = crate::settings::resolve_dictation_app_category_with_overrides(
            &transcription,
            Some("Epic EHR"),
            None,
        );
        assert_eq!(destination_category, DictationAppCategory::Notes);

        let rules = vec![DictionaryRule {
            spoken_form: "htn".to_string(),
            replacement: "hypertension".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("notes".to_string()),
        }];

        let (output, applied) = apply_dictation_dictionary_for_category(
            "patient has htn",
            &rules,
            Some("Epic EHR"),
            destination_category,
        );
        assert_eq!(output, "patient has hypertension");
        assert_eq!(
            applied, 1,
            "category-scoped dictionary entry must apply even when \
             dictation_category_formatting_enabled is false"
        );
    }

    #[test]
    fn category_scoped_snippet_entry_applies_via_resolver_even_when_ai_formatting_toggle_is_off() {
        // Same regression as above, for snippets rather than dictionary
        // entries.
        let transcription = crate::settings::TranscriptionSettings {
            dictation_category_formatting_enabled: false,
            ..crate::settings::TranscriptionSettings::default()
        };

        // No override configured; relies on the built-in bundle-id/name
        // classifier falling through correctly even with the toggle off.
        let destination_category = crate::settings::resolve_dictation_app_category_with_overrides(
            &transcription,
            Some("Slack"),
            None,
        );
        assert_eq!(destination_category, DictationAppCategory::Messaging);

        let snippets = vec![SnippetRule {
            trigger: "omw".to_string(),
            expansion: "on my way".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
        }];

        let (output, applied) = apply_dictation_snippets_for_category(
            "omw now",
            &snippets,
            Some("Slack"),
            destination_category,
        );
        assert_eq!(output, "on my way now");
        assert_eq!(
            applied, 1,
            "category-scoped snippet must apply even when \
             dictation_category_formatting_enabled is false"
        );
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

    /// Every selected-text command key the renderer's `SELECTED_TEXT_ACTIONS`
    /// table (src/lib/selected-text-actions.ts) can send to
    /// `transform_selected_text`/`transform_dictation_text`, i.e. the full
    /// `SelectedTextTransformCommand` union in src/lib/backend.ts. Kept as a
    /// single list so the "every renderer command has Rust support" tests
    /// below stay in sync with each other.
    const ALL_SELECTED_TEXT_TRANSFORM_COMMANDS: &[&str] = &[
        "proofread_text",
        "rewrite_shorter",
        "expand_text",
        "continue_writing",
        "simplify_language",
        "rewrite_professional",
        "rewrite_friendly",
        "rewrite_casual",
        "summarize_text",
        "translate_english",
        "explain_text",
        "find_bugs",
        "bulletize_selection",
        "numbered_list_selection",
        "polish_text",
        "prompt_engineer",
        "uppercase_selection",
        "lowercase_selection",
        "title_case_selection",
        "sentence_case_selection",
    ];

    #[test]
    fn dictation_command_selected_text_label_covers_supported_commands() {
        assert_eq!(
            dictation_command_selected_text_label("proofread_text"),
            Some("Quick Fix Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("rewrite_shorter"),
            Some("Rewrite Shorter Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("expand_text"),
            Some("Expand Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("continue_writing"),
            Some("Continue Writing Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("simplify_language"),
            Some("Simplify Language Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("rewrite_professional"),
            Some("Rewrite Professional Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("rewrite_friendly"),
            Some("Friendly Tone Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("rewrite_casual"),
            Some("Casual Tone Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("summarize_text"),
            Some("Summarize Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("translate_english"),
            Some("Translate Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("explain_text"),
            Some("Explain Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("find_bugs"),
            Some("Find Bugs in Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("bulletize_selection"),
            Some("Bulletize Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("numbered_list_selection"),
            Some("Numbered List Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("polish_text"),
            Some("Polish Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("prompt_engineer"),
            Some("Prompt Engineer Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("uppercase_selection"),
            Some("Uppercase Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("lowercase_selection"),
            Some("Lowercase Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("title_case_selection"),
            Some("Title Case Selected Text")
        );
        assert_eq!(
            dictation_command_selected_text_label("sentence_case_selection"),
            Some("Sentence Case Selected Text")
        );
    }

    #[test]
    fn dictation_command_selected_text_label_rejects_unknown_commands() {
        assert_eq!(dictation_command_selected_text_label("delete_phrase"), None);
        assert_eq!(dictation_command_selected_text_label("not_a_command"), None);
    }

    #[test]
    fn every_renderer_selected_text_command_has_a_selected_text_label() {
        // Regression guard for the "renderer exposes a command the Rust
        // dispatch table doesn't recognize" class of bug: every command key
        // in `SelectedTextTransformCommand`/`SELECTED_TEXT_ACTIONS` must
        // resolve to a label here, or `transform_selected_text_impl` will
        // hard-error with "Unsupported selected-text transform: <key>" the
        // moment it is invoked from the command palette or a quick action.
        for command_key in ALL_SELECTED_TEXT_TRANSFORM_COMMANDS {
            assert!(
                dictation_command_selected_text_label(command_key).is_some(),
                "expected '{}' (exposed by SELECTED_TEXT_ACTIONS) to have a selected-text label",
                command_key
            );
        }
    }

    #[test]
    fn every_ai_backed_renderer_selected_text_command_has_a_default_prompt() {
        // Companion regression guard: every command that isn't purely local
        // (the four case-transform commands) must resolve to a default
        // prompt, or `resolve_dictation_command_prompt` will error with
        // "Unknown command key" once a user without a custom preset runs it.
        for command_key in ALL_SELECTED_TEXT_TRANSFORM_COMMANDS {
            if is_local_only_selected_text_command(command_key) {
                continue;
            }
            assert!(
                default_dictation_command_prompt(command_key).is_some(),
                "expected AI-backed command '{}' to have a default prompt",
                command_key
            );
        }
    }

    #[test]
    fn is_local_only_selected_text_command_matches_case_transforms_only() {
        for local_only in [
            "uppercase_selection",
            "lowercase_selection",
            "title_case_selection",
            "sentence_case_selection",
        ] {
            assert!(
                is_local_only_selected_text_command(local_only),
                "expected '{}' to be local-only",
                local_only
            );
        }

        for ai_backed in [
            "proofread_text",
            "rewrite_shorter",
            "expand_text",
            "continue_writing",
            "simplify_language",
            "rewrite_professional",
            "rewrite_friendly",
            "rewrite_casual",
            "summarize_text",
            "translate_english",
            "explain_text",
            "find_bugs",
            "bulletize_selection",
            "numbered_list_selection",
            "polish_text",
            "prompt_engineer",
        ] {
            assert!(
                !is_local_only_selected_text_command(ai_backed),
                "expected '{}' to require AI dispatch",
                ai_backed
            );
        }
    }
}

#[cfg(test)]
mod vocabulary_hint_tests {
    use super::*;

    fn candidate(term: &str, recency_ms: i64) -> VocabularyTermCandidate {
        VocabularyTermCandidate {
            term: term.to_string(),
            app_scope: None,
            category_scope: None,
            enabled: true,
            recency_ms,
            kind: VocabularyTermKind::DictionaryReplacement,
        }
    }

    fn terms(hint: Option<VocabularyHint>) -> Vec<String> {
        hint.map(|hint| hint.terms().to_vec()).unwrap_or_default()
    }

    #[test]
    fn empty_or_fully_filtered_input_yields_no_hint_at_all() {
        assert_eq!(
            build_vocabulary_hint(&[], None, DictationAppCategory::Other),
            None
        );

        let disabled = VocabularyTermCandidate {
            enabled: false,
            ..candidate("Plainsong", 1)
        };
        let blank = candidate("   ", 2);
        let punctuation = candidate("...", 3);
        assert_eq!(
            build_vocabulary_hint(
                &[disabled, blank, punctuation],
                None,
                DictationAppCategory::Other
            ),
            None,
            "a hint with nothing in it must be None, never Some(empty)"
        );
    }

    #[test]
    fn app_and_category_scoping_match_the_post_transcription_replacement() {
        let everywhere = candidate("Plainsong", 1);
        let slack_only = VocabularyTermCandidate {
            app_scope: Some("Slack".to_string()),
            ..candidate("standup", 2)
        };
        let email_only = VocabularyTermCandidate {
            category_scope: Some("email".to_string()),
            ..candidate("Regards", 3)
        };
        let candidates = [everywhere, slack_only, email_only];

        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                Some("Slack"),
                DictationAppCategory::Messaging
            )),
            vec!["standup", "Plainsong"]
        );
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                Some("Mail"),
                DictationAppCategory::Email
            )),
            vec!["Regards", "Plainsong"]
        );
        // No app in front: app-scoped entries do not apply (same convention
        // as `snippet_app_scope_matches`), unscoped ones still do.
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                None,
                DictationAppCategory::Other
            )),
            vec!["Plainsong"]
        );
    }

    #[test]
    fn newest_entries_come_first_and_ties_keep_input_order() {
        let candidates = [
            candidate("older", 10),
            candidate("newest", 30),
            candidate("tie-a", 20),
            candidate("tie-b", 20),
        ];
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                None,
                DictationAppCategory::Other
            )),
            vec!["newest", "tie-a", "tie-b", "older"]
        );
        // Stable: the same input always yields the same list.
        let again = build_vocabulary_hint(&candidates, None, DictationAppCategory::Other);
        assert_eq!(terms(again), vec!["newest", "tie-a", "tie-b", "older"]);
    }

    #[test]
    fn duplicates_collapse_case_insensitively_keeping_the_newest_spelling() {
        let candidates = [
            candidate("openai", 1),
            candidate("OpenAI", 5),
            candidate("  OpenAI ", 3),
        ];
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                None,
                DictationAppCategory::Other
            )),
            vec!["OpenAI"]
        );
    }

    #[test]
    fn the_term_cap_is_applied_after_ordering() {
        // Two-to-three-character terms keep the token estimate well under
        // its cap, so the term cap is the one that binds here.
        let candidates: Vec<VocabularyTermCandidate> = (0..(VOCABULARY_HINT_MAX_TERMS + 15))
            .map(|index| candidate(&format!("t{index}"), index as i64))
            .collect();
        let hint = terms(build_vocabulary_hint(
            &candidates,
            None,
            DictationAppCategory::Other,
        ));
        assert_eq!(hint.len(), VOCABULARY_HINT_MAX_TERMS);
        assert_eq!(hint[0], format!("t{}", VOCABULARY_HINT_MAX_TERMS + 14));
        assert!(
            !hint.contains(&"t0".to_string()),
            "the oldest term is the one cut"
        );
    }

    #[test]
    fn the_character_and_token_caps_stop_before_the_prompt_overflows() {
        // 20 terms of 40 chars would be 20*40 + 19*2 = 838 characters. The
        // 600-character cap alone (frame counted) would admit 14; the token
        // estimate (chars/3 + separators) binds first at 13, since
        // 13 + 13*40 + 12*2 = 557 chars -> 186 + 14 separators = 200 tokens
        // and a 14th term would push it to 215.
        let candidates: Vec<VocabularyTermCandidate> = (0..20)
            .map(|index| {
                candidate(
                    &format!("{index:0>40}a").replace('a', ""),
                    20 - index as i64,
                )
            })
            .collect();
        let hint = build_vocabulary_hint(&candidates, None, DictationAppCategory::Other)
            .expect("some terms fit");
        assert_eq!(hint.terms().len(), 13);
        assert!(hint.as_prompt().chars().count() <= VOCABULARY_HINT_MAX_CHARS);
        assert!(hint.estimated_prompt_tokens() <= VOCABULARY_HINT_MAX_TOKENS);
    }

    #[test]
    fn the_token_estimate_binds_before_the_term_cap_for_short_uncommon_terms() {
        // 60 eight-character terms fit the character cap but not whisper's
        // prompt window once each is counted at a token per three
        // characters: the estimate passes 200 before the 60th term.
        let candidates: Vec<VocabularyTermCandidate> = (0..VOCABULARY_HINT_MAX_TERMS)
            .map(|index| candidate(&format!("word{index:0>4}"), 100 - index as i64))
            .collect();
        let hint =
            build_vocabulary_hint(&candidates, None, DictationAppCategory::Other).expect("hint");
        assert!(hint.terms().len() < VOCABULARY_HINT_MAX_TERMS);
        assert!(hint.estimated_prompt_tokens() <= VOCABULARY_HINT_MAX_TOKENS);
        let prompt = hint.as_prompt();
        assert!(
            VocabularyHint::estimate_prompt_tokens(&format!(
                "{}, word9999.",
                &prompt[..prompt.len() - 1]
            )) > VOCABULARY_HINT_MAX_TOKENS,
            "one more term would have overflowed the estimate"
        );
    }

    #[test]
    fn snippet_triggers_only_qualify_as_plain_words() {
        let snippet = |term: &str| VocabularyTermCandidate {
            kind: VocabularyTermKind::SnippetTrigger,
            ..candidate(term, 1)
        };
        let candidates = [
            snippet("brb"),
            snippet("e-mail"),
            snippet("my address"),
            snippet("sig!"),
            snippet("x"),
            snippet("123"),
        ];
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                None,
                DictationAppCategory::Other
            )),
            vec!["brb", "e-mail"]
        );
    }

    #[test]
    fn dictionary_replacements_may_be_phrases_but_not_sentences_or_markup() {
        let candidates = [
            candidate("Plainsong Labs", 5),
            candidate(
                "a replacement that runs on far too long to be a single vocabulary term",
                4,
            ),
            candidate("<b>bold</b>", 3),
            candidate("line\nbreak", 2),
        ];
        assert_eq!(
            terms(build_vocabulary_hint(
                &candidates,
                None,
                DictationAppCategory::Other
            )),
            vec!["Plainsong Labs", "line break"],
            "a newline collapses to a space; markup and sentences are dropped"
        );
    }

    #[test]
    fn prompt_form_is_one_framed_sentence() {
        // Not a bare list: see `VocabularyHint::as_prompt` for the fixture
        // evidence behind the frame and the trailing period.
        let hint = build_vocabulary_hint(
            &[candidate("Plainsong", 2), candidate("Kubernetes", 1)],
            None,
            DictationAppCategory::Other,
        )
        .expect("hint");
        assert_eq!(hint.as_prompt(), "Vocabulary: Plainsong, Kubernetes.");
        assert_eq!(hint.terms(), ["Plainsong", "Kubernetes"]);
    }
}
