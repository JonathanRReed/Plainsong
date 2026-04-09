//! Intelligent punctuation and formatting for transcripts
//!
//! Adds proper punctuation, capitalization, and paragraph breaks
//! to raw ASR output for better readability.

use regex::RegexBuilder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationAppStyle {
    Generic,
    Chat,
    Email,
    Document,
    Worklog,
}

/// Punctuation configuration
#[derive(Debug, Clone)]
pub struct PunctuationConfig {
    /// Auto-capitalize sentences
    pub capitalize_sentences: bool,
    /// Add periods at pauses
    pub add_periods: bool,
    /// Add commas at short pauses
    pub add_commas: bool,
    /// Add question marks for questions
    pub detect_questions: bool,
    /// Break into paragraphs
    pub paragraph_breaks: bool,
    /// Words per paragraph
    pub words_per_paragraph: usize,
    /// Format numbers
    pub format_numbers: bool,
    /// Expand contractions
    pub expand_contractions: bool,
}

impl Default for PunctuationConfig {
    fn default() -> Self {
        Self {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 50,
            format_numbers: true,
            expand_contractions: false,
        }
    }
}

/// Intelligent punctuator
pub struct IntelligentPunctuator {
    config: PunctuationConfig,
}

impl IntelligentPunctuator {
    pub fn new(config: PunctuationConfig) -> Self {
        Self { config }
    }

    /// Process raw transcript text and add punctuation
    pub fn punctuate(&self, text: &str) -> String {
        if text.is_empty() {
            return text.to_string();
        }

        let mut result = text.to_string();

        // Expand contractions first
        if self.config.expand_contractions {
            result = self.expand_contractions(&result);
        }

        // Add sentence boundaries based on context
        if self.config.add_periods {
            result = self.add_sentence_boundaries(&result);
        }

        // Detect and mark questions
        if self.config.detect_questions {
            result = self.detect_questions(&result);
        }

        // Capitalize sentences
        if self.config.capitalize_sentences {
            result = self.capitalize_sentences(&result);
        }

        // Add commas for natural pauses
        if self.config.add_commas {
            result = self.add_commas(&result);
        }

        // Format numbers
        if self.config.format_numbers {
            result = self.format_numbers(&result);
        }

        // Add paragraph breaks
        if self.config.paragraph_breaks {
            result = self.add_paragraph_breaks(&result);
        }

        result
    }

    /// Add sentence boundaries based on conjunctions and pauses
    fn add_sentence_boundaries(&self, text: &str) -> String {
        let sentence_starters = vec![
            "however",
            "therefore",
            "furthermore",
            "moreover",
            "consequently",
            "nevertheless",
            "meanwhile",
            "additionally",
            "specifically",
            "basically",
            "essentially",
            "technically",
            "realistically",
            "first",
            "second",
            "third",
            "next",
            "finally",
            "lastly",
            "so",
            "but",
            "and",
            "or",
            "yet",
            "still",
            "anyway",
        ];

        let mut result = text.to_string();

        // Add period before sentence starters if preceded by content
        for starter in sentence_starters {
            let pattern = format!(" {} ", starter);
            let replacement = format!(". {} ", self.capitalize_word(starter));
            result = result.replace(&pattern, &replacement);
        }

        // Ensure there's a space after periods
        result = result.replace(".", ". ");
        result = result.replace("  ", " ");

        result
    }

    /// Detect question patterns and add question marks
    fn detect_questions(&self, text: &str) -> String {
        let question_words = vec![
            "what", "when", "where", "who", "whom", "whose", "why", "how", "which", "whether",
            "can", "could", "would", "should", "will", "shall", "may", "might", "is", "are", "was",
            "were", "do", "does", "did", "have", "has", "had", "am",
        ];

        let mut result = text.to_string();

        // Check for question patterns at start
        let lowercase = result.to_lowercase();
        for word in question_words {
            if lowercase.starts_with(&format!("{} ", word)) || lowercase.starts_with(word) {
                // Find the end of the sentence
                if let Some(end_pos) = result.find(['.', '!'].as_ref()) {
                    result.replace_range(end_pos..end_pos + 1, "?");
                } else {
                    result.push('?');
                }
                break;
            }
        }

        result
    }

    /// Capitalize sentences properly
    fn capitalize_sentences(&self, text: &str) -> String {
        let mut result = String::new();
        let mut capitalize_next = true;

        for c in text.chars() {
            if capitalize_next && c.is_ascii_lowercase() {
                result.push(c.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                result.push(c);
                if c == '.' || c == '!' || c == '?' {
                    capitalize_next = true;
                } else if c.is_alphanumeric() {
                    capitalize_next = false;
                }
            }
        }

        result
    }

    /// Add commas for natural pauses and lists
    fn add_commas(&self, text: &str) -> String {
        let mut result = text.to_string();

        // Add comma before coordinating conjunctions in middle of sentence
        let conjunctions = vec![" and ", " but ", " or ", " yet ", " so ", " for ", " nor "];

        for conj in conjunctions {
            // Only add comma if there's no comma before and it looks like a compound sentence
            if result.contains(conj) && !result.contains(&format!(",{}", conj)) {
                // Simple heuristic: if there's a verb before the conjunction, it's likely compound
                if let Some(pos) = result.find(conj) {
                    let before = &result[..pos];
                    // Check if previous words suggest a compound sentence
                    if before.contains("ed ")
                        || before.contains("ing ")
                        || before.contains(" is ")
                        || before.contains(" was ")
                        || before.contains(" are ")
                        || before.contains(" were ")
                    {
                        result.insert(pos, ',');
                    }
                }
            }
        }

        // Add comma after introductory phrases
        let intro_words = vec![
            "well",
            "so",
            "now",
            "then",
            "however",
            "therefore",
            "anyway",
        ];
        for word in intro_words {
            let pattern = format!("{} ", self.capitalize_word(word));
            if let Some(pos) = result.find(&pattern) {
                let after_pos = pos + pattern.len();
                // Check if there's no comma after
                if after_pos < result.len() && !result[after_pos..].starts_with(',') {
                    // Check if next word isn't already the main verb
                    let rest = &result[after_pos..];
                    if !rest.starts_with("I ")
                        && !rest.starts_with("you ")
                        && !rest.starts_with("we ")
                    {
                        result.insert(after_pos - 1, ',');
                    }
                }
            }
        }

        result
    }

    /// Format numbers with proper separators
    fn format_numbers(&self, text: &str) -> String {
        // Simple number formatting - spell out small numbers
        let number_words: Vec<(&str, &str)> = vec![
            (" 1 ", " one "),
            (" 2 ", " two "),
            (" 3 ", " three "),
            (" 4 ", " four "),
            (" 5 ", " five "),
            (" 6 ", " six "),
            (" 7 ", " seven "),
            (" 8 ", " eight "),
            (" 9 ", " nine "),
            (" 10 ", " ten "),
        ];

        let mut result = text.to_string();

        for (num, word) in number_words {
            result = result.replace(num, word);
        }

        // Format large numbers with commas
        // This is a simple implementation - more complex regex would be better
        result
    }

    /// Add paragraph breaks for readability
    fn add_paragraph_breaks(&self, text: &str) -> String {
        let words: Vec<&str> = text.split_whitespace().collect();
        let mut result = String::new();
        let mut word_count = 0;

        for (i, word) in words.iter().enumerate() {
            result.push_str(word);
            word_count += 1;

            // Add paragraph break every N words
            if word_count >= self.config.words_per_paragraph {
                // Check if this is a natural break point
                if word.ends_with('.') || word.ends_with('!') || word.ends_with('?') {
                    result.push('\n');
                    result.push('\n');
                    word_count = 0;
                }
            } else if i < words.len() - 1 {
                result.push(' ');
            }
        }

        result
    }

    /// Expand common contractions
    fn expand_contractions(&self, text: &str) -> String {
        let contractions: Vec<(&str, &str)> = vec![
            ("'m", " am"),
            ("'re", " are"),
            ("'s", " is"),
            ("'ll", " will"),
            ("'ve", " have"),
            ("'d", " would"),
            ("can't", "cannot"),
            ("won't", "will not"),
            ("n't", " not"),
            ("'d", " would"),
        ];

        let mut result = text.to_string();

        for (contraction, expansion) in contractions {
            result = result.replace(contraction, expansion);
        }

        result
    }

    /// Helper to capitalize a word
    fn capitalize_word(&self, word: &str) -> String {
        let mut chars = word.chars();
        match chars.next() {
            None => String::new(),
            Some(first) => {
                first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase()
            }
        }
    }
}

impl Default for IntelligentPunctuator {
    fn default() -> Self {
        Self::new(PunctuationConfig::default())
    }
}

fn replace_spoken_token(input: &str, phrase: &str, replacement: &str) -> String {
    let escaped = regex::escape(phrase);
    let pattern = format!(r"(^|[\s])({})([\s]|$)", escaped);
    let Ok(re) = RegexBuilder::new(&pattern).case_insensitive(true).build() else {
        return input.to_string();
    };

    re.replace_all(input, |captures: &regex::Captures<'_>| {
        format!("{}{}{}", &captures[1], replacement, &captures[3])
    })
    .to_string()
}

fn normalize_spoken_punctuation(text: &str) -> String {
    let replacements = [
        ("new paragraph", "\n\n"),
        ("new line", "\n"),
        ("newline", "\n"),
        ("bullet point", "\n- "),
        ("bullet", "\n- "),
        ("dash", " - "),
        ("open parenthesis", "("),
        ("close parenthesis", ")"),
        ("open paren", "("),
        ("close paren", ")"),
        ("open quote", "\""),
        ("close quote", "\""),
        ("quote", "\""),
        ("at sign", "@"),
        ("forward slash", "/"),
        ("slash", "/"),
        ("question mark", "?"),
        ("exclamation point", "!"),
        ("exclamation mark", "!"),
        ("full stop", "."),
        ("comma", ","),
        ("period", "."),
        ("colon", ":"),
        ("semicolon", ";"),
    ];

    replacements
        .iter()
        .fold(text.to_string(), |current, (phrase, replacement)| {
            replace_spoken_token(&current, phrase, replacement)
        })
}

fn normalize_spacing_around_punctuation(text: &str) -> String {
    let mut output = text.replace("\r\n", "\n");
    let replacements = [
        (" ,", ","),
        (" .", "."),
        (" !", "!"),
        (" ?", "?"),
        (" :", ":"),
        (" ;", ";"),
        (",,", ","),
        ("..", "."),
        ("!!", "!"),
        ("??", "?"),
    ];
    for (needle, replacement) in replacements {
        output = output.replace(needle, replacement);
    }

    let Ok(space_re) = RegexBuilder::new(r"[ \t]{2,}").build() else {
        return output;
    };
    let output = space_re.replace_all(&output, " ").to_string();
    output
        .replace("\n\n\n", "\n\n")
        .replace(" \n", "\n")
        .replace("\n ", "\n")
}

fn compact_structural_symbol_spacing(text: &str) -> String {
    let mut output = text.to_string();

    let replacements = [
        ("( ", "("),
        (" )", ")"),
        ("[ ", "["),
        (" ]", "]"),
        ("{ ", "{"),
        (" }", "}"),
    ];
    for (needle, replacement) in replacements {
        output = output.replace(needle, replacement);
    }

    let regex_replacements = [
        (r#""\s+([A-Za-z0-9])"#, r#""$1"#),
        (r#"([A-Za-z0-9.,!?])\s+""#, r#"$1""#),
        (r"([A-Za-z0-9])\(", r"$1 ("),
        (r"([A-Za-z0-9])\s*/\s*([A-Za-z0-9])", r"$1/$2"),
        (r"(?m)^-\s*([A-Za-z0-9])", r"- $1"),
        (r"(?m)\n-\s*([A-Za-z0-9])", "\n- $1"),
    ];

    for (pattern, replacement) in regex_replacements {
        let Ok(re) = RegexBuilder::new(pattern).build() else {
            continue;
        };
        output = re.replace_all(&output, replacement).to_string();
    }

    output
}

fn restore_structural_breaks(text: &str) -> String {
    text.replace(" \n\n ", "\n\n")
        .replace(" \n ", "\n")
        .replace("\n ", "\n")
        .replace(" \n", "\n")
}

fn preserve_structural_break_tokens(text: &str) -> String {
    text.replace("\n\n", " __NAUTILUS_PARAGRAPH_BREAK__ ")
        .replace('\n', " __NAUTILUS_LINE_BREAK__ ")
}

fn restore_structural_break_tokens(text: &str) -> String {
    text.replace("__NAUTILUS_PARAGRAPH_BREAK__", "\n\n")
        .replace("__NAUTILUS_LINE_BREAK__", "\n")
}

fn capitalize_standalone_i(text: &str) -> String {
    let Ok(re) = RegexBuilder::new(r"(^|[^A-Za-z])i($|[^A-Za-z])").build() else {
        return text.to_string();
    };
    re.replace_all(text, |captures: &regex::Captures<'_>| {
        format!("{}I{}", &captures[1], &captures[2])
    })
    .to_string()
}

fn capitalize_after_line_breaks(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut capitalize_next = true;

    for ch in text.chars() {
        if capitalize_next && ch.is_ascii_lowercase() {
            output.push(ch.to_ascii_uppercase());
            capitalize_next = false;
        } else {
            output.push(ch);
            if ch == '\n' {
                capitalize_next = true;
            } else if !ch.is_whitespace() {
                capitalize_next = false;
            }
        }
    }

    output
}

fn capitalize_after_bullet_markers(text: &str) -> String {
    let Ok(re) = RegexBuilder::new(r"(?m)(^|\n)-\s+([a-z])").build() else {
        return text.to_string();
    };
    re.replace_all(text, |captures: &regex::Captures<'_>| {
        format!("{}- {}", &captures[1], captures[2].to_ascii_uppercase())
    })
    .to_string()
}

fn resolve_dictation_app_style(app_target: Option<&str>) -> DictationAppStyle {
    let normalized = app_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    let Some(app_name) = normalized.as_deref() else {
        return DictationAppStyle::Generic;
    };

    if ["slack", "messages", "imessage", "discord", "teams"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppStyle::Chat;
    }

    if ["gmail", "outlook", "mail", "superhuman"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppStyle::Email;
    }

    if ["google docs", "docs", "notion", "word", "notes", "obsidian"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppStyle::Document;
    }

    if ["linear", "hubspot", "salesforce", "jira"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppStyle::Worklog;
    }

    DictationAppStyle::Generic
}

fn ensure_terminal_punctuation(text: &str, punctuation: char) -> String {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with(['.', '!', '?', ':']) {
        return trimmed.to_string();
    }
    format!("{}{}", trimmed, punctuation)
}

fn trim_chatty_terminal_period(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.contains('\n') || trimmed.ends_with(['?', '!']) {
        return trimmed.to_string();
    }
    trimmed.strip_suffix('.').unwrap_or(trimmed).to_string()
}

fn merge_inline_conjunction_sentences(text: &str) -> String {
    [
        (". And ", " and "),
        (". But ", " but "),
        (". So ", " so "),
        (". Then ", " then "),
    ]
    .into_iter()
    .fold(text.to_string(), |output, (needle, replacement)| {
        output.replace(needle, replacement)
    })
}

fn normalize_for_app_style(
    text: String,
    mode_preset: &str,
    app_style: DictationAppStyle,
) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    match app_style {
        DictationAppStyle::Chat => {
            if mode_preset == "messages" || mode_preset == "voice" {
                trim_chatty_terminal_period(trimmed)
            } else {
                trimmed.to_string()
            }
        }
        DictationAppStyle::Email => {
            if mode_preset == "messages" {
                trim_chatty_terminal_period(trimmed)
            } else {
                ensure_terminal_punctuation(trimmed, '.')
            }
        }
        DictationAppStyle::Document => trimmed.replace("\n\n\n", "\n\n").trim().to_string(),
        DictationAppStyle::Worklog => {
            let merged = merge_inline_conjunction_sentences(trimmed);
            if mode_preset == "messages" {
                trim_chatty_terminal_period(&merged)
            } else {
                ensure_terminal_punctuation(&merged, '.')
            }
        }
        DictationAppStyle::Generic => trimmed.to_string(),
    }
}

pub fn smart_format_dictation_text_for_app(
    text: &str,
    mode_preset: &str,
    app_target: Option<&str>,
) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let normalized = normalize_spoken_punctuation(trimmed);
    let normalized = capitalize_standalone_i(&normalized);
    let normalized = restore_structural_breaks(&compact_structural_symbol_spacing(
        &normalize_spacing_around_punctuation(&normalized),
    ));
    let normalized = preserve_structural_break_tokens(&normalized);
    let app_style = resolve_dictation_app_style(app_target);

    if normalized.contains("__NAUTILUS_LINE_BREAK__")
        || normalized.contains("__NAUTILUS_PARAGRAPH_BREAK__")
    {
        let structured = compact_structural_symbol_spacing(&capitalize_after_bullet_markers(
            &capitalize_after_line_breaks(&restore_structural_breaks(
                &restore_structural_break_tokens(&normalized),
            )),
        ));
        return normalize_for_app_style(structured, mode_preset, app_style);
    }

    let config = match (mode_preset, app_style) {
        ("messages", _) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: false,
            add_commas: false,
            detect_questions: false,
            paragraph_breaks: false,
            words_per_paragraph: 1000,
            format_numbers: false,
            expand_contractions: false,
        },
        ("notes", DictationAppStyle::Document) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: false,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 28,
            format_numbers: false,
            expand_contractions: false,
        },
        ("notes", _) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: false,
            add_commas: false,
            detect_questions: false,
            paragraph_breaks: false,
            words_per_paragraph: 1000,
            format_numbers: false,
            expand_contractions: false,
        },
        ("email", _) | ("meeting_follow_up", _) | (_, DictationAppStyle::Email) => {
            PunctuationConfig {
                capitalize_sentences: true,
                add_periods: true,
                add_commas: true,
                detect_questions: true,
                paragraph_breaks: true,
                words_per_paragraph: 36,
                format_numbers: false,
                expand_contractions: false,
            }
        }
        (_, DictationAppStyle::Document) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 40,
            format_numbers: false,
            expand_contractions: false,
        },
        (_, DictationAppStyle::Worklog) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: false,
            detect_questions: true,
            paragraph_breaks: false,
            words_per_paragraph: 1000,
            format_numbers: false,
            expand_contractions: false,
        },
        _ => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: false,
            detect_questions: true,
            paragraph_breaks: false,
            words_per_paragraph: 1000,
            format_numbers: false,
            expand_contractions: false,
        },
    };

    normalize_for_app_style(
        compact_structural_symbol_spacing(&capitalize_after_bullet_markers(
            &capitalize_after_line_breaks(&restore_structural_breaks(
                &restore_structural_break_tokens(&capitalize_after_line_breaks(
                    &restore_structural_breaks(
                        IntelligentPunctuator::new(config)
                            .punctuate(&normalized)
                            .trim(),
                    ),
                )),
            )),
        )),
        mode_preset,
        app_style,
    )
}

/// Format transcript for specific use cases
pub fn format_for_use_case(text: &str, use_case: &str) -> String {
    let config = match use_case {
        "meeting" => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 30,
            format_numbers: true,
            expand_contractions: false,
        },
        "journal" => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 75,
            format_numbers: true,
            expand_contractions: true,
        },
        "medical" => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: false,
            paragraph_breaks: true,
            words_per_paragraph: 40,
            format_numbers: false, // Keep numbers as digits for precision
            expand_contractions: false,
        },
        "quick" => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: false,
            add_commas: false,
            detect_questions: false,
            paragraph_breaks: false,
            words_per_paragraph: 1000,
            format_numbers: true,
            expand_contractions: false,
        },
        _ => PunctuationConfig::default(),
    };

    let punctuator = IntelligentPunctuator::new(config);
    punctuator.punctuate(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_punctuation() {
        let punctuator = IntelligentPunctuator::default();
        let input = "hello world this is a test";
        let result = punctuator.punctuate(input);
        assert!(result.contains("Hello world"));
    }

    #[test]
    fn test_capitalize_sentences() {
        let punctuator = IntelligentPunctuator::default();
        let input = "first sentence. second sentence";
        let result = punctuator.punctuate(input);
        assert!(result.contains("First sentence"));
        assert!(result.contains("Second sentence"));
    }

    #[test]
    fn test_format_for_meeting() {
        let input = "okay so lets review the agenda first we need to discuss budget";
        let result = format_for_use_case(input, "meeting");
        assert!(!result.is_empty());
    }

    #[test]
    fn smart_format_dictation_replaces_spoken_punctuation_tokens() {
        let input = "hello comma this is jon period new paragraph i will follow up question mark";
        let result = smart_format_dictation_text_for_app(input, "voice", None);
        assert!(result.contains("Hello, this is jon."));
        assert!(result.contains("\n\nI will follow up?"));
    }

    #[test]
    fn smart_format_dictation_keeps_message_mode_lightweight() {
        let input = "hi there new line i can send that over tomorrow";
        let result = smart_format_dictation_text_for_app(input, "messages", None);
        assert_eq!(result, "Hi there\nI can send that over tomorrow");
    }

    #[test]
    fn smart_format_dictation_uses_email_style_for_email_apps() {
        let input = "hi jonathan can you review the launch plan question mark";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("Gmail"));
        assert_eq!(result, "Hi jonathan can you review the launch plan?");
    }

    #[test]
    fn smart_format_dictation_keeps_chat_apps_lightweight() {
        let input = "sounds good period";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("Slack"));
        assert_eq!(result, "Sounds good");
    }

    #[test]
    fn smart_format_dictation_adds_structure_for_document_apps() {
        let input = "first section period new paragraph second section period";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("Notion"));
        assert!(result.contains("\n\n"));
        assert!(result.ends_with('.'));
    }

    #[test]
    fn smart_format_dictation_uses_email_style_for_browser_domain_hints() {
        let input = "hi jonathan can you review the launch plan question mark";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("mail.google.com"));
        assert_eq!(result, "Hi jonathan can you review the launch plan?");
    }

    #[test]
    fn smart_format_dictation_uses_document_style_for_browser_domain_hints() {
        let input = "first section period new paragraph second section period";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("docs.google.com"));
        assert!(result.contains("\n\n"));
        assert!(result.ends_with('.'));
    }

    #[test]
    fn smart_format_dictation_uses_worklog_style_for_browser_domain_hints() {
        let input = "followed up with procurement and sent revised timeline";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("linear.app"));
        assert_eq!(
            result,
            "Followed up with procurement and sent revised timeline."
        );
    }

    #[test]
    fn smart_format_dictation_supports_bullets_and_parentheses() {
        let input = "bullet review pricing open paren with finance close paren new line bullet send follow up";
        let result = smart_format_dictation_text_for_app(input, "notes", Some("Notion"));
        assert!(result.contains("- Review pricing (with finance)"));
        assert!(result.contains("\n- Send follow up"));
    }

    #[test]
    fn smart_format_dictation_supports_quotes_and_symbols() {
        let input = "open quote launch ready close quote at sign team slash ops";
        let result = smart_format_dictation_text_for_app(input, "messages", Some("Slack"));
        assert_eq!(result, "\"Launch ready\" @ team/ops");
    }
}
