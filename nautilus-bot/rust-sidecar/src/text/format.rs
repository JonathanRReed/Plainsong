//! Intelligent punctuation and formatting for transcripts
//!
//! Adds proper punctuation, capitalization, and paragraph breaks
//! to raw ASR output for better readability.

use regex::RegexBuilder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationAppCategory {
    Other,
    Messaging,
    Email,
    Notes,
    Worklog,
    AiChat,
    CodeEditor,
}

/// Short LLM-prompt instruction fragment for a dictation destination-app
/// category. Returns `None` for `Other`, which falls through to the
/// existing generic dictation-formatting instructions unchanged.
pub fn dictation_category_prompt_fragment(category: DictationAppCategory) -> Option<&'static str> {
    match category {
        DictationAppCategory::Email => Some(
            "This is an email client. Use a formal, professional tone: full sentences, \
             standard grammar, and minimal contractions.",
        ),
        DictationAppCategory::Messaging => Some(
            "This is a messaging app. Keep the tone casual and conversational, and keep it \
             brief, like a text message.",
        ),
        DictationAppCategory::AiChat => Some(
            "This is an AI chat/assistant app. The user is composing a prompt or question - \
             do not answer the question, do not add conversational filler, and preserve code \
             blocks/technical syntax exactly as dictated.",
        ),
        DictationAppCategory::CodeEditor => Some(
            "This is a code editor or terminal - preserve code identifiers, file paths, CLI \
             flags, and technical casing exactly; prefer minimal literal transcription over \
             prose polish.",
        ),
        DictationAppCategory::Notes => Some(
            "This is a notes app. Preserve the existing structure and only clean up grammar \
             and punctuation; do not force a tone rewrite.",
        ),
        DictationAppCategory::Worklog => Some(
            "This is a worklog/project-tracking app. Keep status, blockers, and next-steps \
             explicit and concise.",
        ),
        DictationAppCategory::Other => None,
    }
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

    /// Add sentence boundaries before formal discourse markers that almost
    /// always begin a new sentence. Coordinating conjunctions ("and", "but",
    /// "so", "or", "yet") and bare ordinals ("first", "next") are deliberately
    /// excluded: inserting a period before them mangles ordinary compound
    /// speech ("I went to the store and bought milk").
    fn add_sentence_boundaries(&self, text: &str) -> String {
        let sentence_starters = vec![
            "however",
            "therefore",
            "furthermore",
            "moreover",
            "consequently",
            "nevertheless",
            "additionally",
        ];

        let mut result = text.to_string();

        // Add period before sentence starters if preceded by content
        for starter in sentence_starters {
            let pattern = format!(" {} ", starter);
            let replacement = format!(". {} ", self.capitalize_word(starter));
            result = result.replace(&pattern, &replacement);
        }

        // Ensure there's a space after sentence-ending periods. Only split
        // a lowercase-letter '.' uppercase-letter join ("done.Next"): this
        // deliberately leaves decimals ("3.14"), versions ("2.5"), domains
        // and hosts ("linear.app", "docs.google.com"), and acronyms
        // ("U.S.A.") intact, which a blanket `.` -> `. ` replace mangles.
        if let Ok(re) = RegexBuilder::new(r"([a-z])\.([A-Z])").build() {
            result = re.replace_all(&result, "$1. $2").to_string();
        }
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

        // Check for question patterns at start. Whole-word matches only:
        // "Whatever"/"Islands"/"Cannot" must not count as question starters
        // just because they begin with "what"/"is"/"can".
        let lowercase = result.to_lowercase();
        for word in question_words {
            let is_bare_question_word =
                lowercase.trim_end().trim_end_matches(['.', '!', '?']) == word;
            if lowercase.starts_with(&format!("{} ", word)) || is_bare_question_word {
                // Rewrite the terminator of the first sentence only, and
                // only where it truly ends a sentence (followed by
                // whitespace or end-of-text) so a '.' inside "3.14" or
                // "linear.app" is never turned into '?'.
                let end_pos = result.char_indices().find_map(|(index, ch)| {
                    let ends_sentence = matches!(ch, '.' | '!')
                        && result[index + ch.len_utf8()..]
                            .chars()
                            .next()
                            .is_none_or(char::is_whitespace);
                    ends_sentence.then_some(index)
                });
                if let Some(end_pos) = end_pos {
                    result.replace_range(end_pos..end_pos + 1, "?");
                } else {
                    result.push('?');
                }
                break;
            }
        }

        result
    }

    /// Capitalize sentences properly. A terminator only starts a new
    /// sentence when followed by whitespace, so "linear.app", "3.14", or
    /// "v2.5beta" never get a letter uppercased mid-token.
    fn capitalize_sentences(&self, text: &str) -> String {
        let mut result = String::new();
        let mut capitalize_next = true;
        let mut boundary_pending = false;

        for c in text.chars() {
            if boundary_pending {
                boundary_pending = false;
                if c.is_whitespace() {
                    capitalize_next = true;
                }
            }
            if capitalize_next && c.is_ascii_lowercase() {
                result.push(c.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                result.push(c);
                if c == '.' || c == '!' || c == '?' {
                    boundary_pending = true;
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
            if word_count >= self.config.words_per_paragraph
                && (word.ends_with('.') || word.ends_with('!') || word.ends_with('?'))
            {
                result.push('\n');
                result.push('\n');
                word_count = 0;
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

/// Spoken-punctuation tokens that are also common English nouns/verbs
/// ("the trial period", "a dash of", "the colon", "a quote from"). These
/// only convert to symbols when the surrounding words don't look like
/// ordinary prose (see `spoken_token_guard_rejects`); the unambiguous forms
/// ("full stop", "question mark", "new paragraph", ...) are always
/// converted.
fn spoken_token_is_ambiguous(phrase: &str) -> bool {
    matches!(
        phrase,
        "bullet" | "dash" | "quote" | "comma" | "period" | "colon" | "semicolon"
    )
}

/// Determiners/possessives that mark the token as a noun phrase ("a dash",
/// "the colon", "my quote") rather than dictated punctuation. Deliberately
/// excludes "one"/"no": "one dash two" and "the answer is no period" are
/// ordinary dictation.
const SPOKEN_TOKEN_PRECEDING_GUARDS: &[&str] = &[
    "a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our",
    "their", "each", "every", "any", "some",
];

/// Verbs/prepositions that are strong noun-sense signals ("period is over",
/// "dash of trouble") AND weak clause openers. Common prepositions like
/// in/on/at/for/to/with/from are excluded on purpose: they routinely open a
/// clause right after dictated punctuation ("period In fact...", "comma at
/// noon"), so guarding on them silently broke bread-and-butter dictation.
const SPOKEN_TOKEN_FOLLOWING_GUARDS: &[&str] = &[
    "is", "was", "are", "were", "of", "ends", "ended", "between", "during", "lasts", "lasted",
];

/// Per-token following-word guards. "comma" is the highest-frequency dictated
/// token and its noun sense is nearly always determiner-marked ("the comma"),
/// which the preceding-word guard already covers — so it gets no
/// following-word guard at all ("comma of course" must convert).
fn spoken_token_following_guards(phrase: &str) -> &'static [&'static str] {
    match phrase {
        "comma" => &[],
        _ => SPOKEN_TOKEN_FOLLOWING_GUARDS,
    }
}

fn normalize_guard_word(word: &str) -> String {
    word.trim_matches(|ch: char| !ch.is_alphanumeric())
        .to_ascii_lowercase()
}

fn spoken_token_guard_rejects(
    input: &str,
    phrase: &str,
    match_start: usize,
    match_end: usize,
) -> bool {
    let preceding_word = input[..match_start].split_whitespace().next_back();
    if let Some(word) = preceding_word {
        if SPOKEN_TOKEN_PRECEDING_GUARDS.contains(&normalize_guard_word(word).as_str()) {
            return true;
        }
    }
    let following_word = input[match_end..].split_whitespace().next();
    if let Some(word) = following_word {
        if spoken_token_following_guards(phrase).contains(&normalize_guard_word(word).as_str()) {
            return true;
        }
    }
    false
}

fn replace_spoken_token(input: &str, phrase: &str, replacement: &str) -> String {
    let escaped = regex::escape(phrase);
    let Ok(re) = RegexBuilder::new(&escaped).case_insensitive(true).build() else {
        return input.to_string();
    };
    let ambiguous = spoken_token_is_ambiguous(phrase);

    // Manual scan with zero-width boundary checks instead of a regex that
    // consumes the surrounding whitespace: a consuming pattern skips every
    // other occurrence in runs like "comma comma".
    let mut output = String::with_capacity(input.len());
    let mut last_end = 0usize;
    for found in re.find_iter(input) {
        let boundary_before = input[..found.start()]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let boundary_after = input[found.end()..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace);
        if !(boundary_before && boundary_after) {
            continue;
        }
        if ambiguous && spoken_token_guard_rejects(input, phrase, found.start(), found.end()) {
            continue;
        }
        output.push_str(&input[last_end..found.start()]);
        output.push_str(replacement);
        last_end = found.end();
    }
    output.push_str(&input[last_end..]);
    output
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

/// Collapses `word..` into `word.` while leaving ellipses and relative paths
/// alone. Dictation genuinely does produce a doubled period (the speaker says
/// "period" after a sentence that already ended in one), so the rule is worth
/// keeping — it just has to be narrower than a global `replace("..", ".")`.
fn collapse_duplicated_sentence_period(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;

    while index < chars.len() {
        let current = chars[index];
        if current != '.' {
            output.push(current);
            index += 1;
            continue;
        }

        // Measure the whole run of dots so `...` is never partially rewritten.
        let mut run_end = index;
        while run_end < chars.len() && chars[run_end] == '.' {
            run_end += 1;
        }
        let run_len = run_end - index;

        let previous = output.chars().next_back();
        let next = chars.get(run_end).copied();

        // Exactly two dots, directly after a word character, and not the start
        // of a path segment (`../`, `..\`) or a range (`1..5`).
        let is_doubled_sentence_period = run_len == 2
            && previous.is_some_and(|c| c.is_alphanumeric())
            && !matches!(next, Some('/') | Some('\\'))
            && !next.is_some_and(|c| c.is_alphanumeric());

        if is_doubled_sentence_period {
            output.push('.');
        } else {
            for _ in 0..run_len {
                output.push('.');
            }
        }
        index = run_end;
    }

    output
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
        ("!!", "!"),
        ("??", "?"),
    ];
    for (needle, replacement) in replacements {
        output = output.replace(needle, replacement);
    }

    // `..` is deliberately NOT in the table above. A blanket collapse turned
    // `cd ../src` into `cd ./src` and ate the middle dot of an ellipsis, and it
    // runs before the CodeEditor passthrough so no destination was safe from
    // it. Only collapse a duplicated sentence period: one that follows a word
    // character and is not part of a longer run (`...`) or a relative path
    // (`../`, `./`).
    output = collapse_duplicated_sentence_period(&output);

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
    text.replace("\n\n", " __PLAINSONG_PARAGRAPH_BREAK__ ")
        .replace('\n', " __PLAINSONG_LINE_BREAK__ ")
}

fn restore_structural_break_tokens(text: &str) -> String {
    text.replace("__PLAINSONG_PARAGRAPH_BREAK__", "\n\n")
        .replace("__PLAINSONG_LINE_BREAK__", "\n")
}

fn capitalize_standalone_i(text: &str) -> String {
    // Char-walk with lookaround-style checks (rather than a regex that
    // consumes the neighboring characters) so back-to-back standalones like
    // "i i i" are all capitalized.
    let chars: Vec<char> = text.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(index, &ch)| {
            let standalone = ch == 'i'
                && (index == 0 || !chars[index - 1].is_ascii_alphabetic())
                && chars
                    .get(index + 1)
                    .is_none_or(|next| !next.is_ascii_alphabetic());
            if standalone {
                'I'
            } else {
                ch
            }
        })
        .collect()
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

/// Bundle ids are the stable, locale-independent signal for app identity, so
/// they are checked first whenever one is available. Name/domain substring
/// matching remains as a fallback for apps we don't have a bundle id for
/// (e.g. web apps identified only by a browser domain hint).
fn resolve_dictation_app_category_from_bundle_id(bundle_id: &str) -> Option<DictationAppCategory> {
    let bundle_id = bundle_id.to_ascii_lowercase();

    let messaging_bundle_ids = [
        "com.tdesktop.telegram",             // Telegram
        "net.whatsapp.whatsapp",             // WhatsApp
        "org.whispersystems.signal-desktop", // Signal
    ];
    if messaging_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::Messaging);
    }

    let ai_chat_bundle_ids = [
        "com.openai.chat",         // ChatGPT desktop
        "com.anthropic.claude",    // Claude desktop
        "ai.perplexity.mac",       // Perplexity desktop
        "com.google.geminimacos",  // Gemini desktop
        "ai.elementlabs.lmstudio", // LM Studio
    ];
    if ai_chat_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::AiChat);
    }

    let code_editor_bundle_ids = [
        "com.microsoft.vscode",          // VS Code
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.exafunction.windsurf",      // Windsurf
        "com.google.antigravity",        // Antigravity
        "dev.zed.zed",                   // Zed
        "com.apple.dt.xcode",            // Xcode
        "com.jetbrains.pycharm",         // PyCharm
        "com.jetbrains.intellij",        // IntelliJ IDEA
        "com.jetbrains.webstorm",        // WebStorm
        "com.apple.terminal",            // Terminal.app
        "com.googlecode.iterm2",         // iTerm2
        "com.mitchellh.ghostty",         // Ghostty
        "dev.warp.warp-stable",          // Warp
    ];
    if code_editor_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::CodeEditor);
    }

    None
}

fn resolve_dictation_app_category_from_name(app_name: &str) -> DictationAppCategory {
    if [
        "slack", "messages", "imessage", "discord", "teams", "telegram", "whatsapp", "signal",
    ]
    .iter()
    .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::Messaging;
    }

    if ["gmail", "outlook", "mail", "superhuman"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::Email;
    }

    if ["google docs", "docs", "notion", "word", "notes", "obsidian"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::Notes;
    }

    if ["linear", "hubspot", "salesforce", "jira"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::Worklog;
    }

    if ["chatgpt", "claude", "perplexity", "gemini", "lm studio"]
        .iter()
        .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::AiChat;
    }

    if [
        "code",
        "cursor",
        "xcode",
        "terminal",
        "iterm",
        "pycharm",
        "intellij",
        "webstorm",
        "ghostty",
        "zed",
        "warp",
        "windsurf",
        "antigravity",
    ]
    .iter()
    .any(|candidate| app_name.contains(candidate))
    {
        return DictationAppCategory::CodeEditor;
    }

    DictationAppCategory::Other
}

pub fn resolve_dictation_app_category(
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
) -> DictationAppCategory {
    let normalized_bundle_id = app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(bundle_id) = normalized_bundle_id {
        if let Some(category) = resolve_dictation_app_category_from_bundle_id(bundle_id) {
            return category;
        }
    }

    let normalized = app_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    let Some(app_name) = normalized.as_deref() else {
        return DictationAppCategory::Other;
    };

    resolve_dictation_app_category_from_name(app_name)
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
    app_style: DictationAppCategory,
) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    match app_style {
        DictationAppCategory::Messaging => {
            if mode_preset == "messages" || mode_preset == "voice" {
                trim_chatty_terminal_period(trimmed)
            } else {
                trimmed.to_string()
            }
        }
        DictationAppCategory::Email => {
            if mode_preset == "messages" {
                trim_chatty_terminal_period(trimmed)
            } else {
                ensure_terminal_punctuation(trimmed, '.')
            }
        }
        DictationAppCategory::Notes => trimmed.replace("\n\n\n", "\n\n").trim().to_string(),
        DictationAppCategory::Worklog => {
            let merged = merge_inline_conjunction_sentences(trimmed);
            if mode_preset == "messages" {
                trim_chatty_terminal_period(&merged)
            } else {
                ensure_terminal_punctuation(&merged, '.')
            }
        }
        // AiChat and CodeEditor are passthrough for local punctuation formatting.
        // These categories exist so a later step can attach LLM-prompt-level
        // instructions; no local reformatting rules apply here.
        DictationAppCategory::AiChat
        | DictationAppCategory::CodeEditor
        | DictationAppCategory::Other => trimmed.to_string(),
    }
}

pub fn smart_format_dictation_text_for_app(
    text: &str,
    mode_preset: &str,
    app_target: Option<&str>,
) -> String {
    smart_format_dictation_text_with_category(
        text,
        mode_preset,
        resolve_dictation_app_category(app_target, None),
    )
}

/// Same as `smart_format_dictation_text_for_app`, but takes an
/// already-resolved destination-app category so callers that resolve the
/// category once (settings overrides + bundle id + browser-domain hint, see
/// `resolve_dictation_app_category_with_overrides`) can reuse it here instead
/// of this function re-deriving a possibly different category from the raw
/// app name.
pub fn smart_format_dictation_text_with_category(
    text: &str,
    mode_preset: &str,
    app_style: DictationAppCategory,
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

    if normalized.contains("__PLAINSONG_LINE_BREAK__")
        || normalized.contains("__PLAINSONG_PARAGRAPH_BREAK__")
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
        ("notes", DictationAppCategory::Notes) => PunctuationConfig {
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
        ("email", _) | ("meeting_follow_up", _) | (_, DictationAppCategory::Email) => {
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
        (_, DictationAppCategory::Notes) => PunctuationConfig {
            capitalize_sentences: true,
            add_periods: true,
            add_commas: true,
            detect_questions: true,
            paragraph_breaks: true,
            words_per_paragraph: 40,
            format_numbers: false,
            expand_contractions: false,
        },
        (_, DictationAppCategory::Worklog) => PunctuationConfig {
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
    fn paragraph_break_threshold_preserves_spaces_until_a_natural_break() {
        let punctuator = IntelligentPunctuator::new(PunctuationConfig {
            capitalize_sentences: false,
            add_periods: false,
            add_commas: false,
            detect_questions: false,
            paragraph_breaks: true,
            words_per_paragraph: 3,
            format_numbers: false,
            expand_contractions: false,
        });

        assert_eq!(
            punctuator.add_paragraph_breaks("one two three four five"),
            "one two three four five"
        );
        assert_eq!(
            punctuator.add_paragraph_breaks("one two three four. five"),
            "one two three four.\n\nfive"
        );
    }

    #[test]
    fn coordinating_conjunctions_do_not_start_new_sentences() {
        // Regression: the punctuator must not turn ordinary compound speech into
        // broken sentences (e.g. "...store and bought milk" -> "...store. And bought milk").
        let punctuator = IntelligentPunctuator::default();
        for input in [
            "i went to the store and bought milk",
            "it was late but i kept working",
            "we can ship today or wait until friday",
            "i finished the draft so i sent it over",
        ] {
            let result = punctuator.punctuate(input);
            assert!(
                !result.contains(". And")
                    && !result.contains(". But")
                    && !result.contains(". Or")
                    && !result.contains(". So"),
                "conjunction was wrongly promoted to a sentence start: {result:?}"
            );
        }
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

    #[test]
    fn smart_format_dictation_preserves_decimals_versions_and_domains() {
        // Regression: a blanket `.` -> `. ` replace plus naive sentence
        // capitalization mangled "3.14" into "3. 14" and "linear.app" into
        // "Linear. App" in the default voice mode.
        assert_eq!(
            smart_format_dictation_text_for_app("the price is 3.14 dollars", "voice", None),
            "The price is 3.14 dollars"
        );
        assert_eq!(
            smart_format_dictation_text_for_app("we shipped version 2.5 today", "voice", None),
            "We shipped version 2.5 today"
        );
        assert_eq!(
            smart_format_dictation_text_for_app(
                "check docs.google.com and linear.app",
                "voice",
                None
            ),
            "Check docs.google.com and linear.app"
        );
    }

    #[test]
    fn detect_questions_requires_a_whole_question_word() {
        // "Whatever"/"Islands"/"Cannot" begin with question-word substrings
        // but must not have their first period rewritten into '?'.
        let punctuator = IntelligentPunctuator::default();
        for input in [
            "whatever you do. keep going",
            "islands are nice. we should go",
            "cannot wait for launch. see you",
        ] {
            let result = punctuator.punctuate(input);
            assert!(
                !result.contains('?'),
                "statement was wrongly marked as question: {result:?}"
            );
        }

        let question = punctuator.punctuate("where should we meet. see you soon");
        assert!(question.starts_with("Where should we meet?"));
    }

    #[test]
    fn spoken_punctuation_handles_adjacent_tokens_and_standalone_i_runs() {
        // Regression: consuming boundary groups skipped every other match in
        // runs like "comma comma" and "i i i".
        assert_eq!(
            smart_format_dictation_text_for_app("hello comma comma world", "messages", None),
            "Hello, world"
        );
        assert_eq!(capitalize_standalone_i("i i i"), "I I I");
    }

    #[test]
    fn spoken_punctuation_leaves_common_noun_senses_alone() {
        assert_eq!(
            smart_format_dictation_text_for_app("the trial period is over", "messages", None),
            "The trial period is over"
        );
        assert_eq!(
            smart_format_dictation_text_for_app("we hit a dash of trouble", "messages", None),
            "We hit a dash of trouble"
        );
        // ...while clearly-dictated punctuation still converts.
        assert_eq!(
            smart_format_dictation_text_for_app("sounds good period", "voice", Some("Slack")),
            "Sounds good"
        );
    }

    #[test]
    fn spoken_punctuation_converts_before_clause_opening_prepositions() {
        // Regression: shared following-word guards ("in", "at", "to", "of",
        // "have", ...) silently kept the literal token in extremely common
        // dictation like "comma of course" / "period in fact".
        assert_eq!(
            smart_format_dictation_text_for_app(
                "i will be there comma of course",
                "messages",
                None
            ),
            "I will be there, of course"
        );
        assert_eq!(
            smart_format_dictation_text_for_app("see you tomorrow comma at noon", "messages", None),
            "See you tomorrow, at noon"
        );
        assert_eq!(
            smart_format_dictation_text_for_app("thanks comma have a great day", "messages", None),
            "Thanks, have a great day"
        );
        let shipped = smart_format_dictation_text_for_app(
            "sounds good period in fact we should ship",
            "voice",
            None,
        );
        assert!(
            shipped.starts_with("Sounds good. In fact"),
            "period before clause-opening preposition must convert: {shipped:?}"
        );
        let final_word = smart_format_dictation_text_for_app(
            "we are done period to be clear this is final",
            "voice",
            None,
        );
        assert!(
            final_word.starts_with("We are done. To be clear"),
            "period before infinitive clause must convert: {final_word:?}"
        );
    }

    #[test]
    fn spoken_punctuation_converts_after_one_and_no() {
        // Regression: "one" and "no" in the preceding-word guard blocked
        // ordinary dictation like "one dash two" and "... is no period".
        assert_eq!(
            smart_format_dictation_text_for_app("one dash two", "messages", None),
            "One - two"
        );
        let answer = smart_format_dictation_text_for_app("the answer is no period", "voice", None);
        assert!(
            answer.starts_with("The answer is no."),
            "trailing 'period' after 'no' must convert: {answer:?}"
        );
    }

    #[test]
    fn smart_format_dictation_with_category_matches_name_based_resolution() {
        let input = "sounds good period";
        assert_eq!(
            smart_format_dictation_text_with_category(
                input,
                "voice",
                DictationAppCategory::Messaging
            ),
            smart_format_dictation_text_for_app(input, "voice", Some("Slack"))
        );
    }

    #[test]
    fn resolve_dictation_app_category_covers_common_desktop_apps() {
        for (bundle_id, expected) in [
            ("com.tdesktop.Telegram", DictationAppCategory::Messaging),
            ("net.whatsapp.WhatsApp", DictationAppCategory::Messaging),
            (
                "org.whispersystems.signal-desktop",
                DictationAppCategory::Messaging,
            ),
            ("com.google.GeminiMacOS", DictationAppCategory::AiChat),
            ("ai.elementlabs.lmstudio", DictationAppCategory::AiChat),
            ("com.mitchellh.ghostty", DictationAppCategory::CodeEditor),
            ("dev.zed.Zed", DictationAppCategory::CodeEditor),
            ("dev.warp.Warp-Stable", DictationAppCategory::CodeEditor),
            ("com.exafunction.windsurf", DictationAppCategory::CodeEditor),
            ("com.google.antigravity", DictationAppCategory::CodeEditor),
        ] {
            assert_eq!(
                resolve_dictation_app_category(None, Some(bundle_id)),
                expected,
                "bundle id {bundle_id:?}"
            );
        }

        for (app_name, expected) in [
            ("Telegram", DictationAppCategory::Messaging),
            ("WhatsApp", DictationAppCategory::Messaging),
            ("Signal", DictationAppCategory::Messaging),
            ("Gemini", DictationAppCategory::AiChat),
            ("Ghostty", DictationAppCategory::CodeEditor),
            ("Zed", DictationAppCategory::CodeEditor),
            ("Warp", DictationAppCategory::CodeEditor),
            ("Windsurf", DictationAppCategory::CodeEditor),
        ] {
            assert_eq!(
                resolve_dictation_app_category(Some(app_name), None),
                expected,
                "app name {app_name:?}"
            );
        }
    }

    #[test]
    fn smart_format_dictation_uses_ai_chat_style_for_bundle_id() {
        for bundle_id in [
            "com.openai.chat",
            "com.anthropic.claude",
            "ai.perplexity.mac",
        ] {
            let category = resolve_dictation_app_category(None, Some(bundle_id));
            assert_eq!(
                category,
                DictationAppCategory::AiChat,
                "expected AiChat for bundle id {bundle_id:?}, got {category:?}"
            );
        }
    }

    #[test]
    fn smart_format_dictation_uses_code_editor_style_for_name() {
        let input = "first section period new paragraph second section period";
        let result =
            smart_format_dictation_text_for_app(input, "voice", Some("Visual Studio Code"));
        // CodeEditor is passthrough for local punctuation formatting: no
        // paragraph-break normalization is applied like it would be for Notes.
        assert_eq!(result, "First section.\n\nSecond section.");
    }

    #[test]
    fn smart_format_dictation_falls_back_to_name_when_bundle_id_unknown() {
        // Bundle id is unrecognized (or absent); category resolution should
        // fall back to substring matching on the app name for both new
        // categories.
        let ai_chat_category =
            resolve_dictation_app_category(Some("ChatGPT"), Some("com.example.unknownapp"));
        assert_eq!(ai_chat_category, DictationAppCategory::AiChat);

        let code_editor_category = resolve_dictation_app_category(Some("Cursor"), None);
        assert_eq!(code_editor_category, DictationAppCategory::CodeEditor);
    }

    #[test]
    fn relative_paths_survive_punctuation_normalization() {
        // `cd ../src` used to come out as `cd ./src`: the blanket ".." -> "."
        // rewrite ran before the CodeEditor passthrough, so a terminal command
        // was corrupted no matter which app the user dictated into.
        assert_eq!(
            collapse_duplicated_sentence_period("cd ../src"),
            "cd ../src"
        );
        assert_eq!(
            collapse_duplicated_sentence_period("cp ../a/b ../../c"),
            "cp ../a/b ../../c"
        );
        assert_eq!(
            collapse_duplicated_sentence_period("import x from '../lib'"),
            "import x from '../lib'"
        );
        assert_eq!(
            collapse_duplicated_sentence_period("cd ..\\src"),
            "cd ..\\src"
        );
    }

    #[test]
    fn ellipses_and_ranges_survive_punctuation_normalization() {
        assert_eq!(
            collapse_duplicated_sentence_period("wait for it..."),
            "wait for it..."
        );
        assert_eq!(
            collapse_duplicated_sentence_period("range 1..5"),
            "range 1..5"
        );
    }

    #[test]
    fn a_doubled_sentence_period_is_still_collapsed() {
        // The rule this narrowing preserves: a speaker who says "period" after
        // a sentence that already ended in one should not get two.
        assert_eq!(
            collapse_duplicated_sentence_period("That is done.."),
            "That is done."
        );
        assert_eq!(
            collapse_duplicated_sentence_period("One.. Two.."),
            "One. Two."
        );
    }

    #[test]
    fn code_editor_dictation_preserves_technical_text() {
        let formatted = smart_format_dictation_text_with_category(
            "cd ../src",
            "voice",
            DictationAppCategory::CodeEditor,
        );
        assert!(
            formatted.contains("../src"),
            "code editor formatting corrupted a relative path: {formatted}"
        );
    }
}
