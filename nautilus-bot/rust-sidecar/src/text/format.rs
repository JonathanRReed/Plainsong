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

/// Explicit styles take precedence over default email/message tone. Keep
/// destination safeguards for prompts and technical text.
pub fn dictation_custom_style_category_fragment(
    category: DictationAppCategory,
) -> Option<&'static str> {
    match category {
        DictationAppCategory::Email | DictationAppCategory::Messaging => None,
        _ => dictation_category_prompt_fragment(category),
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
        result = collapse_horizontal_spaces_outside_quotes(&result);

        result
    }

    /// Detect question patterns and add question marks
    fn detect_questions(&self, text: &str) -> String {
        let is_auxiliary = |word: &str| {
            [
                "is", "are", "was", "were", "do", "does", "did", "have", "has", "had", "can",
                "could", "would", "should", "will", "shall", "may", "might", "am",
            ]
            .contains(&word)
        };
        // A period within a decimal or host is not a sentence boundary.
        let end_pos = text.char_indices().find_map(|(index, ch)| {
            let ends_sentence = matches!(ch, '.' | '!' | '?')
                && text[index + ch.len_utf8()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace);
            ends_sentence.then_some(index)
        });
        let first_sentence = &text[..end_pos.unwrap_or(text.len())];
        let lowercase = first_sentence.to_lowercase();
        let mut words = lowercase.split_whitespace();
        let first = words.next().unwrap_or_default();
        let second = words.next();
        // Pronouns and demonstratives can stand alone as subjects. Definite
        // and possessive determiners need a following noun, and never count
        // after "do"/"have", which also open commands ("Do the dishes",
        // "Have your team review it"). "a" is omitted for the same reason.
        let subject_follows = second.is_some_and(|word| {
            [
                "you", "we", "i", "it", "they", "he", "she", "there", "this", "that", "these",
                "those",
            ]
            .contains(&word)
                || (matches!(word, "your" | "our" | "my" | "the")
                    && !matches!(first, "do" | "have")
                    && words.next().is_some())
        });
        let wh_word = matches!(
            first,
            "what" | "when" | "where" | "who" | "whom" | "whose" | "why" | "how" | "which"
        );
        let tokens: Vec<_> = lowercase.split_whitespace().collect();
        let is_subject_verb = |word: &str| {
            (word.len() > 3 && word.ends_with("ed"))
                || [
                    "broke", "came", "went", "left", "said", "fell", "won", "lost", "works",
                    "knows", "happens", "calls", "costs", "matters", "means", "needs", "wants",
                    "makes", "takes", "gives", "seems", "remains", "changes", "helps",
                ]
                .contains(&word)
        };
        let subject_question =
            matches!(first, "who" | "what") && second.is_some_and(is_subject_verb);
        let phrase_word = |word: &str| {
            word.chars().all(char::is_alphabetic)
                && ![
                    "a", "an", "the", "i", "you", "we", "they", "he", "she", "it", "this", "that",
                ]
                .contains(&word)
                && !is_auxiliary(word)
                && !is_subject_verb(word)
        };
        let phrase_question = matches!(first, "what" | "which" | "whose" | "how")
            && (2..=4).any(|aux| {
                tokens.get(aux).is_some_and(|word| is_auxiliary(word))
                    && tokens.get(aux + 1).is_some()
                    && tokens[1..aux].iter().all(|word| phrase_word(word))
            });
        let which_subject = first == "which"
            && second.is_some_and(phrase_word)
            && tokens.get(2).is_some_and(|word| is_subject_verb(word));
        let strong_question = (is_auxiliary(first) && subject_follows)
            || (wh_word && second.is_none_or(is_auxiliary))
            || subject_question
            || phrase_question
            || which_subject;
        let mut result = text.to_string();
        if strong_question {
            match end_pos {
                Some(index) if text.as_bytes()[index] == b'.' => {
                    result.replace_range(index..index + 1, "?");
                }
                None => result.push('?'),
                _ => {}
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

        for (index, c) in text.char_indices() {
            if boundary_pending {
                boundary_pending = false;
                if c.is_whitespace() {
                    capitalize_next = true;
                }
            }
            if capitalize_next && c.is_ascii_lowercase() {
                if word_is_mixed_case(&text[index..]) {
                    result.push(c);
                } else {
                    result.push(c.to_ascii_uppercase());
                }
                capitalize_next = false;
            } else {
                result.push(c);
                if c == '!' || c == '?' || (c == '.' && !ends_with_abbreviation(&result)) {
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
        let mut result = Self::comma_before_joined_clauses(text);

        // A comma after an introductory word, only where it cannot change
        // the meaning: the word opens the sentence and a personal pronoun
        // follows ("So I think" -> "So, I think"). Before anything else the
        // word may be part of the clause: "Well water is contaminated", "So
        // many people came", "Now that we are done", "Then the board
        // decides". "However" is left out: "However you want" is not
        // "However, you want".
        let intro_words = ["well", "so", "now", "then", "therefore", "anyway"];
        for word in intro_words {
            let pattern = format!("{} ", self.capitalize_word(word));
            if let Some(pos) = result.find(&pattern) {
                let after_pos = pos + pattern.len();
                let opens_sentence = result[..pos]
                    .trim_end()
                    .chars()
                    .next_back()
                    .is_none_or(|ch| matches!(ch, '.' | '!' | '?' | '\n'));
                let next_word = result[after_pos..]
                    .split(|ch: char| ch.is_whitespace())
                    .next()
                    .unwrap_or_default();
                let pronoun_follows =
                    matches!(next_word, "I" | "we" | "you" | "they" | "he" | "she" | "it")
                        && result[after_pos + next_word.len()..].starts_with(' ');
                // Set phrases read wrong with a comma: "So it goes", "Now you
                // see it".
                let third_word = result[after_pos + next_word.len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches(|ch: char| !ch.is_alphanumeric())
                    .to_lowercase();
                let idiom = matches!(
                    (word, next_word, third_word.as_str()),
                    ("so", "it", "goes" | "seems")
                        | ("so", "they", "say")
                        | ("so", "he" | "she", "says")
                        | ("now", "you", "see")
                );
                if opens_sentence && pronoun_follows && !idiom {
                    result.insert(after_pos - 1, ',');
                }
            }
        }

        result
    }

    /// A comma before "and"/"but"/"or"/"so" only where it joins two
    /// independent clauses: a subject pronoun and at least one more word
    /// follow, and the clause before has three or more words including a
    /// clear verb (an auxiliary, a contraction, or a subject pronoun with a
    /// word after it). "The project manager and I agreed" has no verb before
    /// "and", so it stays. Nothing is added after "if", "unless", "when" and
    /// similar words in the same sentence: "unless QA signs off and we have
    /// the docs" is one joint condition, and a comma would split it. The old
    /// rule keyed on any earlier "-ed"/"-ing" word and produced "look good,
    /// so far" and "I waited, for you".
    fn comma_before_joined_clauses(text: &str) -> String {
        let words: Vec<&str> = text.split(' ').collect();
        let mut output = String::with_capacity(text.len() + 8);
        let mut clause_words = 0usize;
        let mut clause_has_verb = false;
        let mut sentence_has_condition = false;
        for (index, word) in words.iter().enumerate() {
            let is_conjunction = matches!(*word, "and" | "but" | "or" | "so");
            let subject_follows = words.get(index + 1).is_some_and(|next| {
                matches!(
                    *next,
                    "I" | "i" | "we" | "you" | "they" | "he" | "she" | "it"
                )
            }) && words
                .get(index + 2)
                .is_some_and(|after| after.starts_with(|ch: char| ch.is_alphabetic()));
            if index > 0 {
                if is_conjunction
                    && subject_follows
                    && clause_words >= 3
                    && clause_has_verb
                    && !sentence_has_condition
                    && output.ends_with(|ch: char| ch.is_alphanumeric())
                {
                    output.push(',');
                }
                output.push(' ');
            }
            output.push_str(word);
            let core = word
                .trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '\'' && ch != '\u{2019}')
                .to_lowercase()
                .replace('\u{2019}', "'");
            if opens_condition(&core, words.get(index + 1).copied()) {
                sentence_has_condition = true;
            }
            if word_is_verb_cue(&core)
                || (is_subject_pronoun(&core)
                    && word.ends_with(|ch: char| ch.is_alphanumeric())
                    && words
                        .get(index + 1)
                        .is_some_and(|next| next.starts_with(|ch: char| ch.is_alphabetic())))
            {
                clause_has_verb = true;
            }
            if word.ends_with([',', '.', ';', ':', '!', '?']) {
                clause_words = 0;
                clause_has_verb = false;
            } else if !word.is_empty() {
                clause_words += 1;
            }
            if word.ends_with(['.', '!', '?']) {
                sentence_has_condition = false;
            }
        }
        output
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
/// ("full stop", "question mark", ...) are always
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
        let after = &input[found.end()..];
        let boundary_after = after.chars().next().is_none_or(|ch| {
            ch.is_whitespace()
                || (",.;:!?)]}".contains(ch)
                    && after[ch.len_utf8()..]
                        .chars()
                        .next()
                        .is_none_or(|next| !next.is_alphanumeric()))
        });
        if !(boundary_before && boundary_after) {
            continue;
        }
        if ambiguous && spoken_token_guard_rejects(input, phrase, found.start(), found.end()) {
            continue;
        }
        output.push_str(&input[last_end..found.start()]);
        if matches!(replacement, "." | "," | "!" | "?" | ":" | ";") {
            // Attach a spoken punctuation mark without rewriting punctuation
            // or whitespace that was already present in the transcript.
            while output.ends_with([' ', '\t']) {
                output.pop();
            }
        }
        output.push_str(replacement);
        last_end = found.end();
    }
    output.push_str(&input[last_end..]);
    output
}

fn render_spoken_quote(content: &str) -> String {
    let content = content.trim();
    if content.len() >= 2
        && ((content.starts_with('"') && content.ends_with('"'))
            || (content.starts_with('“') && content.ends_with('”')))
    {
        content.to_string()
    } else {
        format!("\"{content}\"")
    }
}

fn normalize_spoken_quotes(text: &str) -> String {
    let Ok(explicit) = RegexBuilder::new(r"\bopen\s+quote\s+(.+?)\s+(?:close|end)\s+quote\b")
        .case_insensitive(true)
        .build()
    else {
        return text.to_string();
    };
    let output = explicit
        .replace_all(text, |caps: &regex::Captures<'_>| {
            render_spoken_quote(&caps[1])
        })
        .to_string();
    let Ok(paired) = RegexBuilder::new(r"\bquote\s+(.+?)\s+quote\b")
        .case_insensitive(true)
        .build()
    else {
        return output;
    };
    // Bare "quote" is also a verb and a noun. Only interpret paired markers
    // after a clear introducer, or at the start, with a closing boundary.
    let output = paired
        .replace_all(&output, |caps: &regex::Captures<'_>| {
            let found = caps.get(0).expect("whole match");
            let before = output[..found.start()].trim_end();
            let previous = before
                .split_whitespace()
                .next_back()
                .map(normalize_guard_word);
            let introduced = previous.as_deref().is_none_or(|word| {
                matches!(
                    word,
                    "say"
                        | "says"
                        | "said"
                        | "exactly"
                        | "text"
                        | "label"
                        | "called"
                        | "reads"
                        | "write"
                        | "is"
                )
            });
            let after = output[found.end()..].trim_start();
            let closed = after.is_empty() || after.starts_with(|ch: char| ",.;:!?)]}".contains(ch));
            if introduced && closed {
                render_spoken_quote(&caps[1])
            } else {
                found.as_str().to_string()
            }
        })
        .to_string();
    // Explicit single markers may span separate captures. Ordinary unpaired
    // "quote" remains a word rather than becoming an unmatched delimiter.
    let output = replace_spoken_token(&output, "open quote", "\"");
    replace_spoken_token(&output, "close quote", "\"")
}

fn normalize_spoken_punctuation(text: &str) -> String {
    let replacements = [
        ("dash", " - "),
        ("open parenthesis", "("),
        ("close parenthesis", ")"),
        ("open paren", "("),
        ("close paren", ")"),
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

    replacements.iter().fold(
        normalize_spoken_quotes(text),
        |current, (phrase, replacement)| replace_spoken_token(&current, phrase, replacement),
    )
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
            && !matches!(next, Some('/') | Some('\\') | Some('='))
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

fn collapse_horizontal_spaces_outside_quotes(text: &str) -> String {
    let Ok(re) = RegexBuilder::new(r#""(?:\\.|[^"\\])*"|[ \t]{2,}"#).build() else {
        return text.to_string();
    };
    re.replace_all(text, |caps: &regex::Captures<'_>| {
        let matched = caps.get(0).expect("whole match").as_str();
        if matched.starts_with('"') {
            matched.to_string()
        } else {
            " ".to_string()
        }
    })
    .to_string()
}

fn normalize_spacing_around_punctuation(text: &str) -> String {
    let mut output = text.replace("\r\n", "\n");
    let replacements = [
        (" ,", ","),
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
    // A leading dot can belong to ../src, .env or a decimal, not a sentence.
    if let Ok(dot) = RegexBuilder::new(r" \.($|[ \t\r\n,!?;:)\]}])").build() {
        output = dot.replace_all(&output, ".$1").to_string();
    }

    // `..` is deliberately NOT in the table above. A blanket collapse turned
    // `cd ../src` into `cd ./src` and ate the middle dot of an ellipsis, and it
    // runs before the CodeEditor passthrough so no destination was safe from
    // it. Only collapse a duplicated sentence period: one that follows a word
    // character and is not part of a longer run (`...`) or a relative path
    // (`../`, `./`).
    output = collapse_duplicated_sentence_period(&output);

    let output = collapse_horizontal_spaces_outside_quotes(&output);
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
        (r"([A-Za-z0-9])\(", r"$1 ("),
        (r"(?m)^-\s*([A-Za-z0-9])", r"- $1"),
        (r"(?m)\n-\s*([A-Za-z0-9])", "\n- $1"),
    ];

    for (pattern, replacement) in regex_replacements {
        let Ok(re) = RegexBuilder::new(pattern).build() else {
            continue;
        };
        output = re.replace_all(&output, replacement).to_string();
    }

    compact_path_spacing(&output)
}

fn compact_path_spacing(text: &str) -> String {
    let mut output = text.to_string();
    if let Ok(slash) = RegexBuilder::new(r"([A-Za-z0-9._-]+)\s*/\s*([A-Za-z0-9])").build() {
        output = slash
            .replace_all(&output, |caps: &regex::Captures<'_>| {
                let was_separate = caps.get(0).expect("whole match").as_str()[caps[1].len()..]
                    .starts_with(char::is_whitespace);
                let separator = if was_separate
                    && matches!(
                        caps[1].to_ascii_lowercase().as_str(),
                        "the" | "a" | "an" | "this" | "that"
                    ) {
                    " /"
                } else {
                    "/"
                };
                format!("{}{}{}", &caps[1], separator, &caps[2])
            })
            .to_string();
    }
    if let Ok(root_path) = RegexBuilder::new(r"/\s+([A-Za-z0-9])").build() {
        output = root_path.replace_all(&output, "/$1").to_string();
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

/// True when `text` ends with an abbreviation and its period ("9 a.m.",
/// "Dr.", "e.g."). The word after it is not capitalized: "at 9 a.m.
/// tomorrow" is one sentence. A speaker who ended the sentence there gets
/// the recognizer's own capital on the next word.
fn ends_with_abbreviation(text: &str) -> bool {
    let token = text
        .rsplit(char::is_whitespace)
        .next()
        .unwrap_or_default()
        .trim_start_matches(|ch: char| !ch.is_alphanumeric());
    let Some(core) = token.strip_suffix('.') else {
        return false;
    };
    matches!(
        core.to_lowercase().as_str(),
        "a.m"
            | "p.m"
            | "e.g"
            | "i.e"
            | "etc"
            | "vs"
            | "mr"
            | "mrs"
            | "ms"
            | "dr"
            | "prof"
            | "approx"
    )
}

fn is_subject_pronoun(word: &str) -> bool {
    matches!(word, "i" | "we" | "you" | "they" | "he" | "she" | "it")
}

/// Auxiliaries and contractions that show a clause has a finite verb.
fn word_is_verb_cue(word: &str) -> bool {
    matches!(
        word,
        "is" | "was"
            | "are"
            | "were"
            | "am"
            | "be"
            | "been"
            | "has"
            | "have"
            | "had"
            | "do"
            | "does"
            | "did"
            | "will"
            | "would"
            | "can"
            | "could"
            | "should"
            | "shall"
            | "may"
            | "might"
            | "must"
            | "it's"
            | "that's"
            | "he's"
            | "she's"
            | "there's"
            | "here's"
            | "what's"
            | "let's"
    ) || ["n't", "'re", "'ve", "'ll", "'d", "'m"]
        .iter()
        .any(|suffix| word.ends_with(suffix))
}

/// Words that open a condition or a time clause. "As long as" and "as soon
/// as" are recognized from their second word.
fn opens_condition(word: &str, next: Option<&str>) -> bool {
    matches!(
        word,
        "if" | "unless"
            | "when"
            | "whenever"
            | "whether"
            | "because"
            | "until"
            | "till"
            | "while"
            | "before"
            | "after"
            | "once"
            | "since"
            | "provided"
            | "assuming"
    ) || (word == "as"
        && next.is_some_and(|next| {
            matches!(
                next.trim_matches(|ch: char| !ch.is_alphanumeric())
                    .to_lowercase()
                    .as_str(),
                "long" | "soon"
            )
        }))
}

/// A word written with a capital after its first letter ("eBay", "iPhone",
/// "macOS", "gRPC") is a name whose spelling must not change, even at the
/// start of a sentence or line. `text` starts at the word's first letter.
fn word_is_mixed_case(text: &str) -> bool {
    text.chars()
        .take_while(|ch| ch.is_alphanumeric())
        .skip(1)
        .any(char::is_uppercase)
}

fn capitalize_after_line_breaks(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut capitalize_next = true;

    for (index, ch) in text.char_indices() {
        if capitalize_next && ch.is_ascii_lowercase() {
            if word_is_mixed_case(&text[index..]) {
                output.push(ch);
            } else {
                output.push(ch.to_ascii_uppercase());
            }
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
    let Ok(re) = RegexBuilder::new(r"(?m)(^|\n)-\s+([a-z])(\w*)").build() else {
        return text.to_string();
    };
    re.replace_all(text, |captures: &regex::Captures<'_>| {
        let word = format!("{}{}", &captures[2], &captures[3]);
        let first = if word_is_mixed_case(&word) {
            captures[2].to_string()
        } else {
            captures[2].to_ascii_uppercase()
        };
        format!("{}- {}{}", &captures[1], first, &captures[3])
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
        "com.tinyspeck.slackmacgap",         // Slack
        "com.hnc.discord",                   // Discord
        "com.apple.mobilesms",               // Messages
        "com.microsoft.teams2",              // Microsoft Teams
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

    let email_bundle_ids = [
        "com.apple.mail",          // Mail
        "com.microsoft.outlook",   // Outlook
        "com.superhuman.electron", // Superhuman
    ];
    if email_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::Email);
    }

    // Document editors count as notes: a numbered list or a new paragraph is
    // the expected shape there, as in Word.
    let notes_bundle_ids = [
        "com.apple.notes",       // Notes
        "notion.id",             // Notion
        "com.microsoft.word",    // Word
        "md.obsidian",           // Obsidian
        "com.apple.textedit",    // TextEdit
        "com.apple.iwork.pages", // Pages
    ];
    if notes_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::Notes);
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
        "net.kovidgoyal.kitty",          // kitty
        "org.alacritty",                 // Alacritty
        "com.github.wez.wezterm",        // WezTerm
        "co.zeit.hyper",                 // Hyper
        "org.tabby",                     // Tabby
        "com.raphaelamorim.rio",         // Rio
    ];
    if code_editor_bundle_ids
        .iter()
        .any(|candidate| bundle_id == *candidate || bundle_id.contains(candidate))
    {
        return Some(DictationAppCategory::CodeEditor);
    }

    None
}

/// Whole-word match of `candidate` (one or more words) inside an app name or
/// browser domain hint. Substring matching sent 1Password to Notes ("word")
/// and Mailchimp to Email ("mail"). A trailing version number still matches,
/// so "iTerm2" is "iterm".
fn name_has_word(app_name: &str, candidate: &str) -> bool {
    let words: Vec<&str> = app_name
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let wanted: Vec<&str> = candidate.split_whitespace().collect();
    if wanted.is_empty() || wanted.len() > words.len() {
        return false;
    }
    words.windows(wanted.len()).any(|window| {
        window.iter().zip(&wanted).all(|(word, want)| {
            word == want
                || word.strip_prefix(want).is_some_and(|rest| {
                    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit())
                })
        })
    })
}

fn resolve_dictation_app_category_from_name(app_name: &str) -> DictationAppCategory {
    if [
        "slack", "messages", "imessage", "discord", "teams", "telegram", "whatsapp", "signal",
    ]
    .iter()
    .any(|candidate| name_has_word(app_name, candidate))
    {
        return DictationAppCategory::Messaging;
    }

    if ["gmail", "outlook", "mail", "superhuman"]
        .iter()
        .any(|candidate| name_has_word(app_name, candidate))
    {
        return DictationAppCategory::Email;
    }

    if [
        "google docs",
        "docs",
        "notion",
        "word",
        "notes",
        "obsidian",
        "textedit",
    ]
    .iter()
    .any(|candidate| name_has_word(app_name, candidate))
        // "pages" is also a word in browser hosts ("*.pages.dev"), so only
        // the app name itself counts.
        || app_name == "pages"
    {
        return DictationAppCategory::Notes;
    }

    if ["linear", "hubspot", "salesforce", "jira"]
        .iter()
        .any(|candidate| name_has_word(app_name, candidate))
    {
        return DictationAppCategory::Worklog;
    }

    if ["chatgpt", "claude", "perplexity", "gemini", "lm studio"]
        .iter()
        .any(|candidate| name_has_word(app_name, candidate))
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
        "kitty",
        "alacritty",
        "wezterm",
        "zed",
        "warp",
        "windsurf",
        "antigravity",
    ]
    .iter()
    .any(|candidate| name_has_word(app_name, candidate))
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
            } else if super::layout::final_line_takes_no_period(trimmed) {
                trimmed.to_string()
            } else {
                ensure_terminal_punctuation(trimmed, '.')
            }
        }
        DictationAppCategory::Notes => trimmed.replace("\n\n\n", "\n\n").trim().to_string(),
        DictationAppCategory::Worklog => {
            let merged = merge_inline_conjunction_sentences(trimmed);
            if mode_preset == "messages" {
                trim_chatty_terminal_period(&merged)
            } else if super::layout::final_line_takes_no_period(&merged) {
                merged
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

/// Spoken identifier punctuation: "config underscore v3.yaml" is
/// `config_v3.yaml` and "settings dot json" is `settings.json`. Outside code
/// editors an underscore joins only when one side already looks like code (a
/// digit or an inner dot), so "to underscore this point" stays prose.
fn join_spoken_identifiers(text: &str, code_destination: bool) -> String {
    static UNDERSCORE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s+underscore\s+([a-z0-9][a-z0-9_.]*[a-z0-9]|[a-z0-9])\b",
        )
        .expect("underscore pattern")
    });
    static EXTENSION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b([a-z0-9][a-z0-9_-]*)\s+dot\s+(json|yaml|yml|toml|ts|tsx|js|jsx|mjs|rs|py|md|txt|html|css|sh|env|lock|sql|csv)\b")
            .expect("extension pattern")
    });
    let looks_like_code =
        |word: &str| word.contains(|ch: char| ch.is_ascii_digit() || ch == '.' || ch == '_');
    let mut joined = EXTENSION.replace_all(text, "$1.$2").to_string();
    loop {
        let next = UNDERSCORE
            .replace_all(&joined, |captures: &regex::Captures<'_>| {
                let (left, right) = (&captures[1], &captures[2]);
                if code_destination || looks_like_code(left) || looks_like_code(right) {
                    format!("{left}_{right}")
                } else {
                    captures[0].to_string()
                }
            })
            .to_string();
        if next == joined {
            return joined;
        }
        joined = next;
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
    smart_format_dictation_text_with_layout(text, mode_preset, app_style, false)
}

/// Same as `smart_format_dictation_text_with_category`, plus line-break
/// layout when `structured_layout` is set: numbered lists for clear spoken
/// enumerations, spoken "new paragraph"/"new line" at sentence boundaries,
/// topic-shift paragraphs, and an email greeting and sign-off on their own
/// lines (see `text::layout`). Callers set it only when the user kept
/// destination-aware formatting on and the focused field is not single-line;
/// even then full layout applies only to email, notes and worklog
/// destinations, and chat and unknown apps get only an explicit list.
pub fn smart_format_dictation_text_with_layout(
    text: &str,
    mode_preset: &str,
    app_style: DictationAppCategory,
    structured_layout: bool,
) -> String {
    smart_format_dictation_text_for_language(
        text,
        mode_preset,
        app_style,
        structured_layout,
        super::language::english_rules_apply(None, text),
    )
}

/// Same as `smart_format_dictation_text_with_layout`, with the dictation's
/// English-rules decision (`text::language::english_rules_apply`) made by
/// the caller on the recognizer's text, so dictionary replacements and
/// snippet expansions added since cannot change it.
pub fn smart_format_dictation_text_for_language(
    text: &str,
    mode_preset: &str,
    app_style: DictationAppCategory,
    structured_layout: bool,
    english_rules: bool,
) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let code_flags = if app_style == DictationAppCategory::CodeEditor {
        RegexBuilder::new(r"\bdash\s+dash\s+([A-Za-z][A-Za-z0-9_-]*)\b")
            .case_insensitive(true)
            .build()
            .map(|flags| flags.replace_all(trimmed, "--$1").to_string())
            .unwrap_or_else(|_| trimmed.to_string())
    } else {
        trimmed.to_string()
    };
    let code_flags =
        join_spoken_identifiers(&code_flags, app_style == DictationAppCategory::CodeEditor);
    let normalized = normalize_spoken_punctuation(&code_flags);
    // The speaker said "period", "comma" and the like, so a spoken "new
    // paragraph" in the same dictation is a command too (see
    // `layout::convert_spoken_breaks`).
    let clause_marks = |text: &str| text.matches(['.', ',', ';', ':', '?', '!']).count();
    let dictated_punctuation = clause_marks(&normalized) > clause_marks(&code_flags);
    if app_style == DictationAppCategory::CodeEditor {
        // Sentence polish must not turn cd into Cd, i into I, or -v into a
        // bullet, collapse operators, or remove indentation.
        return if normalized == trimmed {
            normalized
        } else {
            compact_path_spacing(&normalized)
        };
    }
    // A lone "i" is the English pronoun, but the Italian plural article.
    let normalized = if english_rules {
        capitalize_standalone_i(&normalized)
    } else {
        normalized
    };
    let normalized = restore_structural_breaks(&compact_structural_symbol_spacing(
        &normalize_spacing_around_punctuation(&normalized),
    ));
    let layout = structured_layout
        && super::layout::category_supports_layout(mode_preset, app_style)
        && !normalized.contains('\n');
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

    if structured_layout
        && matches!(
            app_style,
            DictationAppCategory::Messaging | DictationAppCategory::Other
        )
        && mode_preset != "messages"
        && !normalized.contains('\n')
    {
        let punctuator = IntelligentPunctuator::new(PunctuationConfig {
            paragraph_breaks: false,
            ..config.clone()
        });
        let punctuate = |text: &str| punctuator.punctuate(text).trim().to_string();
        let list = if app_style == DictationAppCategory::Messaging {
            super::layout::announced_list_block(&normalized, &punctuate)
        } else {
            super::layout::explicit_list_block(&normalized, &punctuate)
        };
        if let Some(list) = list {
            return normalize_for_app_style(
                compact_structural_symbol_spacing(&capitalize_after_line_breaks(&list)),
                mode_preset,
                app_style,
            );
        }
    }

    if layout {
        let laid_out = lay_out_dictation(&normalized, &config, app_style, dictated_punctuation);
        return normalize_for_app_style(
            compact_structural_symbol_spacing(&capitalize_after_line_breaks(&laid_out)),
            mode_preset,
            app_style,
        );
    }

    normalize_for_app_style(
        compact_structural_symbol_spacing(&capitalize_after_bullet_markers(
            &capitalize_after_line_breaks(&restore_structural_breaks(
                &restore_structural_break_tokens(&capitalize_after_line_breaks(
                    &restore_structural_breaks(
                        // Paragraph breaks are layout: a single-line field,
                        // an unknown field or layout turned off gets none.
                        IntelligentPunctuator::new(PunctuationConfig {
                            paragraph_breaks: false,
                            ..config
                        })
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

/// Layout for single-line dictation going to a multi-line destination.
/// Email splits off its greeting and sign-off first; then spoken breaks
/// divide the body into blocks, and each block is punctuated on its own and
/// given lists and paragraphs.
fn lay_out_dictation(
    text: &str,
    config: &PunctuationConfig,
    app_style: DictationAppCategory,
    dictated_punctuation: bool,
) -> String {
    use super::layout;

    let paragraph_threshold = config
        .paragraph_breaks
        .then_some(config.words_per_paragraph);
    let block_config = PunctuationConfig {
        paragraph_breaks: false,
        ..config.clone()
    };
    let punctuator = IntelligentPunctuator::new(block_config);
    let format_body = |body: &str, after_greeting: bool| -> String {
        let converted = layout::convert_spoken_breaks(body, after_greeting, dictated_punctuation);
        let mut output = String::with_capacity(converted.len() + 16);
        let mut rest = converted.as_str();
        while !rest.is_empty() {
            let (block, separator, next) = match rest.find('\n') {
                Some(index) => {
                    let paragraph = rest[index..].starts_with("\n\n");
                    let skip = if paragraph { 2 } else { 1 };
                    (
                        &rest[..index],
                        if paragraph { "\n\n" } else { "\n" },
                        &rest[index + skip..],
                    )
                }
                None => (rest, "", ""),
            };
            let block = block.trim();
            if !block.is_empty() {
                output.push_str(&layout::structure_block(
                    block,
                    paragraph_threshold,
                    &|text: &str| punctuator.punctuate(text).trim().to_string(),
                ));
            }
            output.push_str(separator);
            rest = next;
        }
        output.trim().to_string()
    };

    if app_style != DictationAppCategory::Email {
        return format_body(text, false);
    }
    let frame = layout::split_email_frame(text);
    let body = format_body(&frame.body, frame.greeting.is_some());
    [frame.greeting, Some(body), frame.sign_off]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
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
        let input = "hello comma this is jon period i will follow up question mark";
        let result = smart_format_dictation_text_for_app(input, "voice", None);
        assert!(result.contains("Hello, this is jon."));
        assert!(result.contains("I will follow up?"));
    }

    #[test]
    fn smart_format_dictation_does_not_synthesize_control_characters() {
        for phrase in [
            "new line",
            "newline",
            "new paragraph",
            "bullet",
            "bullet point",
        ] {
            let input = format!("echo unsafe {phrase} harmless");
            let result = smart_format_dictation_text_for_app(&input, "messages", None);
            assert!(
                result.contains(phrase),
                "spoken phrase was not preserved: {result:?}"
            );
            assert!(
                !result.contains('\r') && !result.contains('\n'),
                "ordinary dictation synthesized a line break: {result:?}"
            );
        }
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
    fn smart_format_dictation_preserves_spoken_structure_for_document_apps() {
        let input = "first section period new paragraph second section period";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("Notion"));
        assert!(result.to_ascii_lowercase().contains("new paragraph"));
        assert!(!result.contains('\n'));
        assert!(result.ends_with('.'));
    }

    #[test]
    fn smart_format_dictation_uses_email_style_for_browser_domain_hints() {
        let input = "hi jonathan can you review the launch plan question mark";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("mail.google.com"));
        assert_eq!(result, "Hi jonathan can you review the launch plan?");
    }

    #[test]
    fn smart_format_dictation_preserves_spoken_structure_for_browser_domain_hints() {
        let input = "first section period new paragraph second section period";
        let result = smart_format_dictation_text_for_app(input, "voice", Some("docs.google.com"));
        assert!(result.to_ascii_lowercase().contains("new paragraph"));
        assert!(!result.contains('\n'));
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
    fn smart_format_dictation_supports_parentheses_without_synthesizing_bullets() {
        let input = "bullet review pricing open paren with finance close paren";
        let result = smart_format_dictation_text_for_app(input, "notes", Some("Notion"));
        assert_eq!(result, "Bullet review pricing (with finance)");
        assert!(!result.contains('\n'));
    }

    #[test]
    fn smart_format_dictation_supports_quotes_and_symbols() {
        let input = "open quote launch ready close quote at sign team slash ops";
        let result = smart_format_dictation_text_for_app(input, "messages", Some("Slack"));
        assert_eq!(result, "\"Launch ready\" @ team/ops");
    }

    #[test]
    fn spoken_quote_pairs_keep_boundaries_and_literal_words() {
        for (input, expected) in [
            (
                "write exactly quote \"do not reset production\" quote.",
                "write exactly \"do not reset production\".",
            ),
            (
                "write exactly open quote \"do not reset production\" close quote.",
                "write exactly \"do not reset production\".",
            ),
        ] {
            assert_eq!(
                smart_format_dictation_text_for_app(input, "voice", Some("Cursor")),
                expected
            );
        }
        assert_eq!(
            smart_format_dictation_text_for_app(
                "The button must say quote Save a copy quote, not Save copy.",
                "voice",
                Some("Notion")
            ),
            "The button must say \"Save a copy\", not Save copy."
        );
        assert_eq!(
            smart_format_dictation_text_for_app(
                "Write exactly quote do not reset production quote.",
                "voice",
                Some("ChatGPT")
            ),
            "Write exactly \"do not reset production\"."
        );
        for text in [
            "Please quote the invoice.",
            "That quote is accurate.",
            "Keep \"  literal spaces  \" here.",
        ] {
            assert_eq!(
                smart_format_dictation_text_for_app(text, "voice", None),
                text
            );
        }
    }

    #[test]
    fn spoken_absolute_paths_keep_the_preceding_article_separate() {
        assert_eq!(
            smart_format_dictation_text_for_app(
                "Keep the slash users endpoint.",
                "voice",
                Some("Cursor")
            ),
            "Keep the /users endpoint."
        );
        assert_eq!(
            smart_format_dictation_text_for_app("slash users slash local", "voice", Some("Cursor")),
            "/users/local"
        );
        assert_eq!(
            smart_format_dictation_text_for_app(
                "keep the /users endpoint",
                "voice",
                Some("Cursor")
            ),
            "keep the /users endpoint"
        );
    }

    #[test]
    fn code_editor_spoken_double_dash_forms_a_command_flag() {
        assert_eq!(
            smart_format_dictation_text_for_app(
                "Run cargo test dash dash locked, not cargo update.",
                "voice",
                Some("Cursor")
            ),
            "Run cargo test --locked, not cargo update."
        );
        assert_eq!(
            smart_format_dictation_text_for_app("git status --short", "voice", Some("Cursor")),
            "git status --short"
        );
    }

    #[test]
    fn a_prohibition_keeps_its_statement_terminator() {
        assert_eq!(
            smart_format_dictation_text_for_app(
                "Do not deploy this tonight.",
                "voice",
                Some("Linear")
            ),
            "Do not deploy this tonight."
        );
        assert_eq!(
            smart_format_dictation_text_for_app(
                "Do you approve the deployment?",
                "voice",
                Some("Linear")
            ),
            "Do you approve the deployment?"
        );
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
    fn spoken_identifiers_join_only_with_code_evidence() {
        for (input, category, expected) in [
            (
                "Rename config underscore v3.yaml then push it",
                DictationAppCategory::Notes,
                "config_v3.yaml",
            ),
            (
                "open settings dot json",
                DictationAppCategory::Email,
                "settings.json",
            ),
            (
                "call get underscore user underscore id",
                DictationAppCategory::CodeEditor,
                "get_user_id",
            ),
        ] {
            let output = smart_format_dictation_text_with_category(input, "voice", category);
            assert!(output.contains(expected), "{input} -> {output}");
        }
        for (input, category) in [
            (
                "I want to underscore this point",
                DictationAppCategory::Notes,
            ),
            (
                "I want to underscore this point",
                DictationAppCategory::Email,
            ),
            ("A polka dot pattern", DictationAppCategory::Notes),
            (
                "I want to underscore how important this is",
                DictationAppCategory::AiChat,
            ),
            (
                "This matters. Underscore that for the team.",
                DictationAppCategory::Notes,
            ),
        ] {
            let output = smart_format_dictation_text_with_category(input, "voice", category);
            assert!(
                !output.contains('_') && !output.contains("dot."),
                "{input} -> {output}"
            );
        }
    }

    #[test]
    fn detect_questions_requires_inversion_and_preserves_exclamations() {
        let punctuator = IntelligentPunctuator::default();
        for input in [
            "Have a good day.",
            "Will Smith called.",
            "May release is delayed.",
            "When I get home, I'll call.",
            "What a day.",
            "What I mean is...",
            "Is.",
            "Is the.",
            "Islands are nice.",
            "Is",
            "Do not deploy.",
            "Can you send it!",
            "Do the dishes.",
            "Have your team review it.",
        ] {
            assert_eq!(punctuator.detect_questions(input), input);
            if input.ends_with('.') {
                for mode in ["voice", "email", "notes"] {
                    assert_eq!(
                        smart_format_dictation_text_for_app(input, mode, None),
                        input
                    );
                }
            }
        }
        for (input, expected) in [
            ("Can you send it.", "Can you send it?"),
            ("Is it ready", "Is it ready?"),
            ("What is the plan.", "What is the plan?"),
            ("How do we ship", "How do we ship?"),
            ("Why?", "Why?"),
            ("Why", "Why?"),
            ("Is the plan ready.", "Is the plan ready?"),
            (
                "Can you open linear.app at 3.14. Next sentence.",
                "Can you open linear.app at 3.14? Next sentence.",
            ),
        ] {
            assert_eq!(punctuator.detect_questions(input), expected);
        }
    }

    #[test]
    fn detect_questions_handles_bounded_subject_and_phrase_questions() {
        let punctuator = IntelligentPunctuator::default();
        for input in [
            "What happened.",
            "Who called.",
            "What broke.",
            "Who knows.",
            "What time is it.",
            "How much does it cost.",
            "Which one works.",
            "Which file did you change.",
        ] {
            let expected = format!("{}?", input.trim_end_matches('.'));
            assert_eq!(punctuator.detect_questions(input), expected);
            for mode in ["voice", "email"] {
                assert_eq!(
                    smart_format_dictation_text_for_app(input, mode, None),
                    expected
                );
            }
        }
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
    fn app_names_match_whole_words_not_substrings() {
        use DictationAppCategory::*;
        for (name, expected) in [
            ("1Password", Other),
            ("Mailchimp", Other),
            ("Codecademy", Other),
            ("Microsoft Word", Notes),
            ("mail.google.com", Email),
            ("docs.google.com", Notes),
            ("TextEdit", Notes),
            ("Pages", Notes),
            // A browser host is not the Pages app.
            ("myapp.pages.dev", Other),
            ("blog.pages.dev", Other),
            ("iTerm2", CodeEditor),
            ("Visual Studio Code", CodeEditor),
            ("Slack", Messaging),
        ] {
            assert_eq!(
                resolve_dictation_app_category(Some(name), None),
                expected,
                "{name}"
            );
        }
        for (bundle, expected) in [
            ("com.tinyspeck.slackmacgap", Messaging),
            ("com.apple.mail", Email),
            ("com.microsoft.Outlook", Email),
            ("notion.id", Notes),
            ("com.apple.Notes", Notes),
            ("com.apple.TextEdit", Notes),
            ("com.apple.iWork.Pages", Notes),
        ] {
            assert_eq!(
                resolve_dictation_app_category(None, Some(bundle)),
                expected,
                "{bundle}"
            );
        }
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
            // Terminals report a multi-line text area, so an uncategorized
            // one would get numbered lists typed at its prompt.
            ("net.kovidgoyal.kitty", DictationAppCategory::CodeEditor),
            ("org.alacritty", DictationAppCategory::CodeEditor),
            ("com.github.wez.wezterm", DictationAppCategory::CodeEditor),
            ("co.zeit.hyper", DictationAppCategory::CodeEditor),
            ("org.tabby", DictationAppCategory::CodeEditor),
            ("com.raphaelamorim.rio", DictationAppCategory::CodeEditor),
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
            ("kitty", DictationAppCategory::CodeEditor),
            ("Alacritty", DictationAppCategory::CodeEditor),
            ("WezTerm", DictationAppCategory::CodeEditor),
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
        assert_eq!(result, "first section. new paragraph second section.");
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
        assert_eq!(formatted, "cd ../src");
        for literal in [
            "fetchUserId",
            "/users/local",
            "git status --short",
            "for i in items",
            "node_ENV",
            "load .env",
            "cp ../a/b ../../c",
            "a/b",
            "-v",
            "-5",
            "value ?? fallback",
            "!!enabled",
            "for i in 1..=5",
            "if ready:\n    return value",
            "a / b",
        ] {
            assert_eq!(
                smart_format_dictation_text_with_category(
                    literal,
                    "voice",
                    DictationAppCategory::CodeEditor
                ),
                literal
            );
        }
    }

    fn laid_out(text: &str, mode: &str, category: DictationAppCategory) -> String {
        smart_format_dictation_text_with_layout(text, mode, category, true)
    }

    #[test]
    fn layout_numbers_spoken_lists_in_notes_email_and_worklog() {
        use DictationAppCategory::*;
        let spoken = "for the launch we need three things comma first comma the pricing page comma second comma the docs comma and third comma the changelog period";
        assert_eq!(
            laid_out(spoken, "voice", Notes),
            "For the launch we need three things:\n1. The pricing page\n2. The docs\n3. The changelog"
        );
        assert_eq!(
            laid_out(spoken, "voice", Worklog),
            "For the launch we need three things:\n1. The pricing page\n2. The docs\n3. The changelog"
        );
        assert_eq!(
            laid_out(
                "Hi Sam, quick update. First, the build is green. Second, the docs are merged. Third, we ship Monday. Thanks, Jonathan.",
                "voice",
                Email
            ),
            "Hi Sam,\n\nQuick update.\n1. The build is green.\n2. The docs are merged.\n3. We ship Monday.\n\nThanks,\nJonathan"
        );
    }

    #[test]
    fn chat_apps_number_only_an_announced_list() {
        use DictationAppCategory::*;
        let announced = "three things for tomorrow comma first comma review the contract comma second comma call Dana comma and third comma book the flights";
        let chat = laid_out(announced, "voice", Messaging);
        assert!(
            chat.ends_with("\n1. Review the contract\n2. Call Dana\n3. Book the flights"),
            "{chat:?}"
        );
        assert!(!chat.contains("\n\n"), "{chat:?}");
        // No list without the layout flag (setting off, single-line or
        // unknown field), in "messages" mode, or in AI prompts and code.
        assert!(
            !smart_format_dictation_text_with_layout(announced, "voice", Messaging, false)
                .contains('\n')
        );
        assert!(!laid_out(announced, "messages", Messaging).contains('\n'));
        for category in [AiChat, CodeEditor] {
            assert!(!laid_out(announced, "voice", category).contains('\n'));
        }
        // Chat still gets no paragraphs or spoken breaks.
        let long = "first comma the pricing page comma second comma the docs comma third comma the changelog period new paragraph thanks";
        assert!(!laid_out(long, "voice", Messaging).contains('\n'));
    }

    #[test]
    fn unknown_apps_number_only_an_explicit_list() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "Three things for tomorrow. First, review the contract. Second, call Dana. Third, book the flights.",
                "voice",
                Other
            ),
            "Three things for tomorrow.\n1. Review the contract.\n2. Call Dana.\n3. Book the flights."
        );
        assert_eq!(
            laid_out(
                "Agenda for today, number 1, budget review, number 2, hiring update, number 3, the Q4 roadmap.",
                "voice",
                Other
            ),
            "Agenda for today:\n1. Budget review\n2. Hiring update\n3. The Q4 roadmap"
        );
        assert_eq!(
            laid_out(
                "Agenda for today. Number one, budget review. Number two, hiring update. Number three, the Q4 roadmap.",
                "voice",
                Other
            ),
            "Agenda for today.\n1. Budget review.\n2. Hiring update.\n3. The Q4 roadmap."
        );
        for prose in [
            // Unannounced ordinals are prose there, as are paragraph and
            // spoken-break cues.
            "First, the build is green. Second, the docs are merged. Third, we ship Monday.",
            "Done. New paragraph. Next we review the budget.",
            // A "number one" that modifies a noun is not a marker, and two
            // numbered items without an announcement are not enough.
            "Number one priority is hiring, number two priority is budget, number three priority is the roadmap.",
            "Number one, budget review. Number two, hiring update.",
            "We ranked number 1, number 2 and number 3 in the region.",
        ] {
            let output = laid_out(prose, "voice", Other);
            assert!(!output.contains('\n'), "{prose:?} became {output:?}");
        }
        // Single-line, unknown-role fields and the setting off pass no layout
        // flag at all.
        assert!(!smart_format_dictation_text_with_layout(
            "Agenda for today, number 1, budget review, number 2, hiring update, number 3, the Q4 roadmap.",
            "voice",
            Other,
            false
        )
        .contains('\n'));
        // "messages" mode is an explicit ask for chat-style text.
        assert!(!laid_out(
            "Agenda for today, number 1, budget review, number 2, hiring update, number 3, the Q4 roadmap.",
            "messages",
            Other
        )
        .contains('\n'));
    }

    #[test]
    fn layout_never_adds_line_breaks_to_chat_code_or_unknown_apps() {
        use DictationAppCategory::*;
        let spoken = "first, the pricing page. second, the docs. third, the changelog. new paragraph, thanks.";
        for category in [Messaging, AiChat, CodeEditor, Other] {
            let output = laid_out(spoken, "voice", category);
            assert!(!output.contains('\n'), "{category:?}: {output:?}");
        }
        // "messages" mode asks for chat-style text even in a notes app.
        assert!(!laid_out(spoken, "messages", Notes).contains('\n'));
        // Without the layout flag (setting off or single-line field) the
        // formatter behaves exactly as before.
        for category in [Email, Notes, Worklog] {
            assert_eq!(
                smart_format_dictation_text_with_layout(spoken, "voice", category, false),
                smart_format_dictation_text_with_category(spoken, "voice", category)
            );
        }
    }

    #[test]
    fn paragraph_breaks_need_layout() {
        use DictationAppCategory::*;
        // 56 words, enough for a paragraph break in Notes.
        let sentence = "We reviewed the launch plan with the whole team today.";
        let spoken = [sentence; 5].join(" ") + " We agree on the next steps.";
        assert_eq!(spoken.split_whitespace().count(), 56);
        for category in [Notes, Email] {
            for mode in ["voice", "notes", "email"] {
                let output =
                    smart_format_dictation_text_with_layout(&spoken, mode, category, false);
                assert!(!output.contains('\n'), "{mode} {category:?}: {output:?}");
            }
        }
        assert!(laid_out(&spoken, "voice", Notes).contains("\n\n"));
    }

    #[test]
    fn intro_words_get_a_comma_only_before_a_pronoun() {
        use DictationAppCategory::*;
        for category in [Notes, Email] {
            for (input, expected) in [
                ("well water is contaminated", "Well water is contaminated."),
                (
                    "so many people came to the party",
                    "So many people came to the party.",
                ),
                (
                    "now that we are done we can go",
                    "Now that we are done we can go.",
                ),
                ("then the board decides", "Then the board decides."),
                (
                    "however you want to do it is fine",
                    "However you want to do it is fine.",
                ),
                ("so I booked the room", "So, I booked the room."),
                ("well we tried", "Well, we tried."),
                ("so it goes", "So it goes."),
                ("so they say", "So they say."),
                ("so it seems", "So it seems."),
                ("so he says he is fine", "So he says he is fine."),
                ("so she says", "So she says."),
                (
                    "now you see it now you don't",
                    "Now you see it now you don't.",
                ),
            ] {
                // Only the words and commas matter here, not the final stop.
                let plain =
                    smart_format_dictation_text_with_layout(input, "voice", category, false);
                let expected = expected.trim_end_matches('.');
                assert_eq!(
                    plain.trim_end_matches('.'),
                    expected,
                    "{category:?}: {input}"
                );
                let structured = laid_out(input, "voice", category);
                assert_eq!(
                    structured.trim_end_matches('.'),
                    expected,
                    "{category:?}: {input}"
                );
            }
        }
    }

    #[test]
    fn layout_keeps_ordinary_sentences_unchanged() {
        use DictationAppCategory::*;
        for (input, category) in [
            ("First, I want to thank you for coming.", Notes),
            ("Our number one priority is speed.", Email),
            ("First quarter results were strong, second quarter results were weak, third quarter is pending.", Notes),
            ("The invoice is $1,250 and the call is at 3:30 pm.", Email),
            ("I'll add a new paragraph about pricing.", Notes),
            ("Thanks for the update.", Email),
            ("Hey, can you check the deploy?", Email),
        ] {
            assert_eq!(
                laid_out(input, "voice", category),
                smart_format_dictation_text_with_category(input, "voice", category),
                "{input}"
            );
        }
    }

    #[test]
    fn layout_honors_spoken_paragraphs_at_sentence_boundaries() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "first section period new paragraph second section period",
                "voice",
                Notes
            ),
            "First section.\n\nSecond section."
        );
        assert_eq!(
            laid_out(
                "hi priya comma new paragraph the contract is signed period new paragraph best comma jonathan",
                "voice",
                Email
            ),
            "Hi priya,\n\nThe contract is signed.\n\nBest, jonathan."
        );
    }

    #[test]
    fn layout_puts_email_greeting_and_sign_off_on_their_own_lines() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "Hi Sam, I reviewed the contract and it looks good. Can you send the signed copy by Friday? Best regards, Jonathan Reed.",
                "voice",
                Email
            ),
            "Hi Sam,\n\nI reviewed the contract, and it looks good. Can you send the signed copy by Friday?\n\nBest regards,\nJonathan Reed"
        );
        // Thanking the person greeted stays one line.
        assert_eq!(
            laid_out(
                "Hi Sam, the contract is signed. Thanks, Sam.",
                "voice",
                Email
            ),
            "Hi Sam,\n\nThe contract is signed.\n\nThanks, Sam."
        );
        // Greeting and sign-off layout is email-only.
        assert!(!laid_out(
            "Hi Sam, the contract is signed and filed. Best, Jonathan.",
            "voice",
            Notes
        )
        .contains('\n'));
    }

    #[test]
    fn layout_breaks_long_dictation_at_topic_shifts() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "The launch went well. Everyone liked the demo and the numbers look good so far. Also, I need the invoice by Friday.",
                "voice",
                Notes
            ),
            "The launch went well. Everyone liked the demo and the numbers look good so far.\n\nAlso, I need the invoice by Friday."
        );
    }

    #[test]
    fn layout_leaves_existing_line_breaks_to_the_structured_path() {
        use DictationAppCategory::*;
        let resumed = "5. Review\n6. Ship";
        assert_eq!(laid_out(resumed, "voice", Notes), resumed);
    }

    #[test]
    fn conjunction_commas_only_join_independent_clauses() {
        for (input, expected) in [
            (
                "I reviewed the contract and it looks good",
                "I reviewed the contract, and it looks good",
            ),
            (
                "The numbers look good so far",
                "The numbers look good so far",
            ),
            (
                "I waited for you at the station",
                "I waited for you at the station",
            ),
            ("We tested Tom and Jerry", "We tested Tom and Jerry"),
            ("Sam and I are going", "Sam and I are going"),
            ("I fixed it, and it works", "I fixed it, and it works"),
            ("It was between you and I", "It was between you and I"),
        ] {
            assert_eq!(
                IntelligentPunctuator::comma_before_joined_clauses(input),
                expected
            );
        }
    }

    #[test]
    fn conjunction_commas_need_a_verb_before_and_no_open_condition() {
        for text in [
            "The project manager and I agreed on the scope",
            "Our new designer and I will present on Friday",
            "Don't merge it unless QA signs off and we have the docs.",
            "If it rains and we cancel the trip we lose the deposit",
            "We ship when the tests pass and we have sign-off",
            "Wait until Sam replies and we have the numbers",
        ] {
            assert_eq!(
                IntelligentPunctuator::comma_before_joined_clauses(text),
                text,
                "{text}"
            );
        }
        // The condition covers the rest of its sentence, so no comma is
        // added after it; the next sentence is free again.
        assert_eq!(
            IntelligentPunctuator::comma_before_joined_clauses(
                "If it rains, we will stay in and we will play cards. I checked the forecast and it looks clear"
            ),
            "If it rains, we will stay in and we will play cards. I checked the forecast, and it looks clear"
        );
    }

    #[test]
    fn layout_does_not_add_commas_that_change_a_condition() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "Don't merge it unless QA signs off and we have the docs.",
                "voice",
                Email
            ),
            "Don't merge it unless QA signs off and we have the docs."
        );
        assert_eq!(
            laid_out(
                "The project manager and I agreed on the scope.",
                "voice",
                Notes
            ),
            "The project manager and I agreed on the scope."
        );
    }

    #[test]
    fn line_breaks_keep_mixed_case_words() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out(
                "Hi Sam, eBay sent the refund today. Thanks, Jon.",
                "voice",
                Email
            ),
            "Hi Sam,\n\neBay sent the refund today.\n\nThanks,\nJon"
        );
        assert_eq!(
            laid_out(
                "Three things: first, iPhone testing, second, macOS builds, and third, gRPC docs.",
                "voice",
                Notes
            ),
            "Three things:\n1. iPhone testing\n2. macOS builds\n3. gRPC docs"
        );
        assert_eq!(
            capitalize_after_line_breaks("iOS\neBay\nmail"),
            "iOS\neBay\nMail"
        );
        let punctuator = IntelligentPunctuator::new(PunctuationConfig {
            paragraph_breaks: false,
            ..PunctuationConfig::default()
        });
        assert_eq!(
            punctuator.capitalize_sentences("done. iPhone ships. eBay too. ok"),
            "Done. iPhone ships. eBay too. Ok"
        );
    }

    #[test]
    fn a_task_line_after_a_comma_still_gets_its_period() {
        use DictationAppCategory::*;
        assert_eq!(
            laid_out("Done, new line, next item here", "voice", Worklog),
            "Done,\nNext item here."
        );
    }

    #[test]
    fn layout_keeps_a_question_on_the_line_that_asks_it() {
        assert_eq!(
            laid_out(
                "can you handle three things comma first comma the invoice comma second comma the contract comma and third comma the badge",
                "voice",
                DictationAppCategory::Notes
            ),
            "Can you handle three things?\n1. The invoice\n2. The contract\n3. The badge"
        );
    }
}
