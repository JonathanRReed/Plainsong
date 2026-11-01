//! Ephemeral vocabulary from the original dictation window. No model or storage.
#[cfg(target_os = "macos")]
use std::collections::{BTreeMap, HashSet, VecDeque};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
pub(crate) const MAX_ELEMENTS: usize = 64;
#[cfg(target_os = "macos")]
pub(crate) const MAX_CHARS: usize = 4000;
#[cfg(target_os = "macos")]
pub(crate) const READ_BUDGET: Duration = Duration::from_millis(30);
#[cfg(target_os = "macos")]
const MAX_TERMS: usize = 50;

/// Implementations must bound each native call by `deadline`, limit returned
/// children and strings, and refuse hidden/secure nodes before reading values.
#[cfg(target_os = "macos")]
pub(crate) trait NearbyTextReader {
    type Node;
    fn roots(&mut self, deadline: Instant) -> Vec<Self::Node>;
    fn visible_text(
        &mut self,
        node: &Self::Node,
        remaining: usize,
        deadline: Instant,
    ) -> Option<String>;
    fn children(&mut self, node: &Self::Node, limit: usize, deadline: Instant) -> Vec<Self::Node>;
}

#[cfg(target_os = "macos")]
pub(crate) fn read_vocabulary(reader: &mut impl NearbyTextReader, deadline: Instant) -> Vocabulary {
    let mut queue: VecDeque<_> = reader
        .roots(deadline)
        .into_iter()
        .take(MAX_ELEMENTS)
        .collect();
    let mut text = String::new();
    let mut remaining = MAX_CHARS;
    let mut visited = 0;
    while let Some(node) = queue.pop_front() {
        if visited >= MAX_ELEMENTS || remaining == 0 || Instant::now() >= deadline {
            break;
        }
        visited += 1;
        // None also refuses traversal of sensitive or unreadable subtrees.
        let Some(value) = reader.visible_text(&node, remaining, deadline) else {
            continue;
        };
        if Instant::now() >= deadline {
            break;
        }
        let value: String = value.chars().take(remaining).collect();
        remaining -= value.chars().count();
        text.push_str(&value);
        if remaining > 0 {
            text.push('\n');
            remaining -= 1;
        }
        if Instant::now() < deadline && remaining > 0 {
            let limit = MAX_ELEMENTS - visited - queue.len();
            queue.extend(
                reader
                    .children(&node, limit, deadline)
                    .into_iter()
                    .take(limit),
            );
        }
    }
    extract(&text)
}

#[cfg(target_os = "macos")]
pub(crate) fn denied_app(name: Option<&str>, bundle: Option<&str>) -> bool {
    let identity = format!(
        "{} {}",
        name.unwrap_or_default(),
        bundle.unwrap_or_default()
    )
    .to_lowercase();
    [
        "1password",
        "onepassword",
        "bitwarden",
        "lastpass",
        "dashlane",
        "keepass",
        "keeper",
        "enpass",
        "protonpass",
        "proton pass",
        "nordpass",
        "roboform",
        "strongbox",
        "keychain",
        "passwords",
        "securityagent",
        "authenticator",
    ]
    .iter()
    .any(|needle| identity.contains(needle))
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct Vocabulary(Vec<String>);

impl Vocabulary {
    /// The terms, best first. Read only for the session's own dictation.
    pub(crate) fn terms(&self) -> &[String] {
        &self.0
    }
}

impl std::fmt::Debug for Vocabulary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vocabulary({} terms)", self.0.len())
    }
}

#[cfg(target_os = "macos")]
fn identifier(word: &str) -> bool {
    !word.contains(char::is_whitespace)
        && (word.contains('_') || word.chars().skip(1).any(char::is_uppercase))
}

#[cfg(target_os = "macos")]
fn letter(ch: char) -> bool {
    ch.is_alphabetic() || matches!(ch, '\u{0300}'..='\u{036f}')
}

#[cfg(target_os = "macos")]
fn name(word: &str) -> bool {
    word.chars().next().is_some_and(char::is_uppercase)
        && word
            .chars()
            .all(|ch| letter(ch) || matches!(ch, '-' | '\'' | '\u{2019}'))
}

#[cfg(target_os = "macos")]
pub(crate) fn extract(text: &str) -> Vocabulary {
    let bounded: String = text.chars().take(MAX_CHARS).collect();
    let mut ranked: BTreeMap<String, usize> = BTreeMap::new();
    let mut add = |term: &str, weight: usize| {
        let len = term.chars().count();
        if (5..=64).contains(&len) && !term.chars().any(char::is_numeric) {
            *ranked.entry(term.to_string()).or_default() += weight;
        }
    };
    for line in bounded.lines() {
        let tokens: Vec<_> = line
            .split(|ch: char| {
                !(ch.is_alphanumeric()
                    || letter(ch)
                    || matches!(ch, '_' | '-' | '\'' | '\u{2019}' | '@' | '.'))
            })
            .map(|word| word.trim_matches('.'))
            .filter(|word| !word.is_empty())
            .collect();
        for token in &tokens {
            if let Some((local, domain)) = token.split_once('@') {
                if domain.contains('.') {
                    let parts: Vec<String> = local
                        .split(['.', '_', '-'])
                        .filter(|part| {
                            part.chars().count() >= 3 && part.chars().all(char::is_alphabetic)
                        })
                        .map(|part| {
                            let mut chars = part.chars();
                            format!(
                                "{}{}",
                                chars.next().unwrap().to_uppercase(),
                                chars.as_str().to_lowercase()
                            )
                        })
                        .collect();
                    if parts.len() >= 2 {
                        add(&parts.join(" "), 6);
                    }
                    for part in parts {
                        add(&part, 3);
                    }
                }
            } else if identifier(token) && token.chars().all(|ch| letter(ch) || ch == '_') {
                add(token, 5);
            } else if name(token) && !crate::dictation_sounds_like::is_common_screen_word(token) {
                add(token, 2);
            }
        }
        for pair in tokens.windows(2) {
            if pair.iter().all(|word| name(word)) {
                add(&pair.join(" "), 4);
            }
        }
    }
    let mut terms: Vec<_> = ranked.into_iter().collect();
    terms.sort_by(|(a, aw), (b, bw)| bw.cmp(aw).then_with(|| a.cmp(b)));
    Vocabulary(
        terms
            .into_iter()
            .take(MAX_TERMS)
            .map(|(term, _)| term)
            .collect(),
    )
}

#[cfg(target_os = "macos")]
fn words(text: &str) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        if ch.is_alphanumeric()
            || matches!(ch, '_' | '\'' | '\u{2019}' | '-' | '\u{0300}'..='\u{036f}')
        {
            start.get_or_insert(index);
        } else if let Some(start) = start.take() {
            result.push((start, index));
        }
    }
    if let Some(start) = start {
        result.push((start, text.len()));
    }
    result
}

#[cfg(target_os = "macos")]
fn spoken_form(term: &str) -> String {
    let mut result = String::new();
    let mut previous_lower = false;
    for ch in term.chars() {
        if ch == '_' {
            result.push(' ');
            previous_lower = false;
            continue;
        }
        if previous_lower && ch.is_uppercase() {
            result.push(' ');
        }
        result.extend(ch.to_lowercase());
        previous_lower = ch.is_lowercase();
    }
    result
}

#[cfg(target_os = "macos")]
const PROTECTED_COMPONENTS: &[&str] = &[
    "not",
    "no",
    "never",
    "without",
    "unless",
    "if",
    "only",
    "neither",
    "nor",
    "none",
    "nothing",
    "nobody",
    "nowhere",
    "cannot",
    "i",
    "we",
    "you",
    "he",
    "she",
    "they",
    "it",
    "will",
    "would",
    "can",
    "could",
    "should",
    "may",
    "must",
    "might",
    "shall",
    "hardly",
    "scarcely",
    "when",
    "while",
    "until",
    "before",
    "after",
    "except",
    "provided",
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "hundred",
    "thousand",
    "million",
    "billion",
];

/// Screen text has less authority than an explicit dictionary rule. A changed
/// word needs five letters, a single edit, and must not be an English word.
/// Compound identifiers can join only exactly spoken components. Ties abstain.
#[cfg(target_os = "macos")]
pub(crate) fn correct(
    text: &str,
    vocabulary: &Vocabulary,
    protected: &[String],
    code_editor: bool,
) -> (String, Vec<String>) {
    let candidates: Vec<_> = vocabulary
        .0
        .iter()
        .map(|term| {
            let parts: Vec<String> = spoken_form(term)
                .split_whitespace()
                .map(str::to_string)
                .collect();
            (term, parts)
        })
        .collect();
    let protected_ranges: Vec<_> = protected
        .iter()
        .flat_map(|term| {
            text.match_indices(term)
                .map(move |(offset, _)| (offset, offset + term.len()))
        })
        .collect();
    let spans = words(text);
    let mut edits = Vec::new();
    let mut quote_end = None;
    let mut scan = 0;
    let mut index = 0;
    while index < spans.len() {
        let (start, end) = spans[index];
        let mut escaped = false;
        for ch in text[scan..start].chars() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            match quote_end {
                Some(end) if ch == end => quote_end = None,
                None => {
                    quote_end = match ch {
                        '"' | '`' => Some(ch),
                        '\u{201c}' | '\u{201d}' => Some('\u{201d}'),
                        _ => None,
                    };
                }
                _ => {}
            }
        }
        scan = end;
        if quote_end.is_some() {
            index += 1;
            continue;
        }
        let mut matches = BTreeMap::new();
        for (term, parts) in &candidates {
            if parts.is_empty()
                || parts.len() > 4
                || index + parts.len() > spans.len()
                || parts
                    .iter()
                    .any(|word| PROTECTED_COMPONENTS.contains(&word.as_str()))
            {
                continue;
            }
            if parts.len() > 1 && identifier(term) && !code_editor {
                continue;
            }
            let candidate_end = spans[index + parts.len() - 1].1;
            let candidate = &text[start..candidate_end];
            if protected_ranges
                .iter()
                .any(|(a, b)| *a < candidate_end && *b > start)
            {
                continue;
            }
            let mut changed = false;
            let mut valid = true;
            for (offset, target) in parts.iter().enumerate() {
                let (a, b) = spans[index + offset];
                let source = &text[a..b];
                if offset > 0
                    && !text[spans[index + offset - 1].1..a]
                        .chars()
                        .all(|ch| matches!(ch, ' ' | '\t'))
                {
                    valid = false;
                    break;
                }
                let lower = source.to_lowercase();
                if lower == *target {
                    continue;
                }
                if source.chars().count() < 5
                    || target.chars().count() < 5
                    || !source.chars().all(char::is_alphabetic)
                    || crate::dictation_sounds_like::is_common_screen_word(source)
                    || crate::dictation_sounds_like::is_common_screen_word(target)
                    || crate::dictation_sounds_like::levenshtein(&lower, target) != 1
                {
                    valid = false;
                    break;
                }
                changed = true;
            }
            // No automatic casing of ordinary single words such as Will/Mark.
            if valid
                && (changed || (parts.len() > 1 && identifier(term)))
                && candidate != term.as_str()
            {
                let mut edited = text[start..].to_string();
                edited.replace_range(..candidate_end - start, term);
                matches.insert(edited, (*term, candidate_end));
            }
        }
        // Deduplicated edits must agree. Ranking cannot break a spelling tie.
        if matches.len() == 1 {
            let (_, (term, end)) = matches.into_iter().next().unwrap();
            edits.push((start, end, term.clone()));
            while index < spans.len() && spans[index].1 <= end {
                index += 1;
            }
            scan = end;
        } else {
            index += 1;
        }
    }
    let mut output = text.to_string();
    let mut applied = HashSet::new();
    for (start, end, term) in edits.into_iter().rev() {
        output.replace_range(start..end, &term);
        applied.insert(term);
    }
    let mut applied: Vec<_> = applied.into_iter().collect();
    applied.sort();
    (output, applied)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn extracts_names_email_identifiers_and_unicode_with_rank_and_cap() {
        let vocab = extract("To: Jonathan Reed <jonathan.reed@example.test>\nCc: Chloé Nguyễn\nfetchUserProfile user_profile Plainsong\nfetchUserProfile");
        for term in [
            "Jonathan Reed",
            "Jonathan",
            "Chloé",
            "Nguyễn",
            "fetchUserProfile",
            "user_profile",
            "Plainsong",
        ] {
            assert!(vocab.0.iter().any(|value| value == term), "missing {term}");
        }
        assert!(extract("Jose\u{301}phine Łukasz")
            .0
            .contains(&"Jose\u{301}phine".into()));
        assert_eq!(
            correct("Lukasz", &extract("Łukasz"), &[], false).0,
            "Łukasz"
        );
        let repeated = vocab
            .0
            .iter()
            .position(|term| term == "fetchUserProfile")
            .unwrap();
        let once = vocab
            .0
            .iter()
            .position(|term| term == "user_profile")
            .unwrap();
        assert!(repeated < once);
        assert!(!format!("{vocab:?}").contains("Jonathan"));
        let many = (0..100)
            .map(|n| format!("context{}Name", char::from_u32(0x100 + n).unwrap()))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(extract(&many).0.len(), MAX_TERMS);
        assert!(!extract(&format!("{} HiddenName", " ".repeat(MAX_CHARS)))
            .0
            .contains(&"HiddenName".into()));
        assert!(!extract("Version2 token_12")
            .0
            .iter()
            .any(|term| term.contains(char::is_numeric)));
    }

    #[test]
    fn strong_spelling_matches_preserve_negation_numbers_and_other_words() {
        let vocab =
            extract("Jonathan Reed\nPrishma\nChloé\nNguyễn\nfetchUserProfile\nuser_profile");
        for (source, expected) in [
            (
                "Ask Jonathon Reed, not Prishma, for 12 reports.",
                "Ask Jonathan Reed, not Prishma, for 12 reports.",
            ),
            (
                "Ask Chloe and Nguyên, never change 42.",
                "Ask Chloé and Nguyễn, never change 42.",
            ),
            (
                "Do not call fetch user profile or user profile.",
                "Do not call fetchUserProfile or user_profile.",
            ),
        ] {
            assert_eq!(correct(source, &vocab, &[], true).0, expected, "{source}");
        }
    }

    #[test]
    fn refuses_common_words_short_names_ambiguous_candidates_and_unspoken_words() {
        let vocab = extract("Will Mark May Rose Ann Anna Jonathan Reed\nPrishma\nPrishmi\nnotReady\nneverAgain\nuserProfile\ncountTwenty\nifReady\nuntilReady");
        for source in [
            "Will mark the rose in May.",
            "Ann and Ana will meet Jon Reid.",
            "Don't change the market or parks. Send 12 reports, not 21.",
            "Prishme is here.",
            "Jonathan",
            "not ready",
            "never again",
            "count twenty",
            "if ready",
            "until ready",
            "user, profile",
            "user 12 profile",
            "user\nprofile",
            "2Prishma Prishma2",
            "'Prishma'",
        ] {
            assert_eq!(correct(source, &vocab, &[], true).0, source, "{source}");
        }
        let vocab = extract("Prishma");
        for source in [
            "prism",
            "prisms",
            "prison",
            "prisons",
            "privacy",
            "primary",
            "promise",
            "promises",
            "Prishma's",
            "Prishma’s",
            "`Prishme`",
            "\"Prishme\"",
            "“Prishme”",
        ] {
            assert_eq!(correct(source, &vocab, &[], true).0, source, "{source}");
        }
        assert_eq!(
            correct("Ask Prishme.", &vocab, &["Prishme".into()], false).0,
            "Ask Prishme."
        );
    }

    #[test]
    fn screen_identifiers_need_a_code_editor_and_never_consume_a_clause() {
        let vocab = extract("userProfile\nfetchUserProfile\niPhone\nwillMark\ncanSend");
        for source in ["I phone Sam.", "We will mark it.", "I can send it."] {
            assert_eq!(correct(source, &vocab, &[], true).0, source);
        }
        assert_eq!(
            correct("Use the user profile.", &vocab, &[], false).0,
            "Use the user profile."
        );
        assert_eq!(
            correct("Use the user profile.", &vocab, &[], true).0,
            "Use the userProfile."
        );
    }

    #[test]
    fn screen_names_do_not_reinterpret_common_words_or_ambiguous_short_names() {
        let vocab = extract("Will Mark\nBill Mark\nWill\nMark\nBill\nPrishma\nMarkett\nReportt");
        for source in [
            "Will Mark and Bill call?",
            "I will mark the bill, not pay it.",
            "Wille, Marck and Bille are unverified spellings.",
            "The market report is ready, unless Bill says otherwise.",
            "The markets and reports will wait until twelve thirty.",
        ] {
            let (output, applied) = correct(source, &vocab, &[], true);
            assert_eq!(output, source);
            assert!(applied.is_empty());
        }
    }

    #[test]
    fn screen_spelling_keeps_conditions_contractions_and_numeric_forms() {
        let vocab = extract("Prishma\nnotReady\nnoEntry\nonlyIf\ncountTwelve\nzeroCost");
        let source = "Don't call Prishme unless 12 reports cost $1,200.50, not $2,100, at 3:45. Only if twelve arrive, never zero.";
        let (output, applied) = correct(source, &vocab, &[], true);
        assert_eq!(output, source.replace("Prishme", "Prishma"));
        assert_eq!(applied, ["Prishma"]);
        for source in [
            "not ready",
            "no entry",
            "only if",
            "count twelve",
            "zero cost",
        ] {
            assert_eq!(correct(source, &vocab, &[], true).0, source);
        }
    }

    #[test]
    fn screen_spelling_preserves_quotes_with_other_quote_delimiters_inside() {
        let vocab = extract("Prishma");
        for source in [
            "Say \"use `Prishme` here\" exactly.",
            "Say `use \"Prishme\" here` exactly.",
            "Say “use \"Prishme\" here” exactly.",
            "Say \"use \\\"Prishme\\\" here\" exactly.",
        ] {
            let (output, applied) = correct(source, &vocab, &[], true);
            assert_eq!(output, source);
            assert!(applied.is_empty());
        }
        assert_eq!(
            correct("Say \"`Prishme`\", then call Prishme.", &vocab, &[], false).0,
            "Say \"`Prishme`\", then call Prishma."
        );
    }

    #[derive(Clone)]
    struct FakeNode {
        text: String,
        allowed: bool,
        children: Vec<usize>,
    }
    struct Fake {
        nodes: Vec<FakeNode>,
        reads: Vec<usize>,
        deadline: Option<Instant>,
    }
    impl NearbyTextReader for Fake {
        type Node = usize;
        fn roots(&mut self, _: Instant) -> Vec<usize> {
            vec![0]
        }
        fn visible_text(&mut self, node: &usize, _: usize, end: Instant) -> Option<String> {
            self.deadline = Some(end);
            self.reads.push(*node);
            self.nodes[*node]
                .allowed
                .then(|| self.nodes[*node].text.clone())
        }
        fn children(&mut self, node: &usize, limit: usize, _: Instant) -> Vec<usize> {
            self.nodes[*node]
                .children
                .iter()
                .copied()
                .take(limit)
                .collect()
        }
    }
    fn fake() -> Fake {
        Fake {
            nodes: vec![
                FakeNode {
                    text: "Jonathan Reed".into(),
                    allowed: true,
                    children: vec![1, 2],
                },
                FakeNode {
                    text: "SecureSecret".into(),
                    allowed: false,
                    children: vec![3],
                },
                FakeNode {
                    text: "fetchUserProfile".into(),
                    allowed: true,
                    children: vec![],
                },
                FakeNode {
                    text: "HiddenSecret".into(),
                    allowed: true,
                    children: vec![],
                },
            ],
            reads: vec![],
            deadline: None,
        }
    }
    #[test]
    fn reader_refuses_sensitive_subtrees_and_obeys_deadline() {
        let mut reader = fake();
        let deadline = Instant::now() + READ_BUDGET;
        let vocab = read_vocabulary(&mut reader, deadline);
        assert!(vocab.0.contains(&"fetchUserProfile".into()));
        assert!(!vocab.0.iter().any(|term| term.contains("Secret")));
        assert_eq!(reader.reads, [0, 1, 2]);
        assert_eq!(reader.deadline, Some(deadline));
        reader.reads.clear();
        assert_eq!(read_vocabulary(&mut reader, Instant::now()).0.len(), 0);
        assert!(reader.reads.is_empty());
    }
    #[test]
    fn reader_bounds_elements_characters_and_cycles() {
        let mut reader = fake();
        reader.nodes[0].children = vec![0];
        read_vocabulary(&mut reader, Instant::now() + Duration::from_secs(1));
        assert_eq!(reader.reads.len(), MAX_ELEMENTS);
        let mut reader = fake();
        reader.nodes[0].text = format!("{} HiddenSecret", "x".repeat(MAX_CHARS));
        let vocab = read_vocabulary(&mut reader, Instant::now() + Duration::from_secs(1));
        assert_eq!(reader.reads, [0]);
        assert!(!vocab.0.iter().any(|term| term.contains("Secret")));
    }
    #[test]
    fn denies_password_managers_and_system_password_windows() {
        for app in [
            "1Password",
            "Bitwarden",
            "Passwords",
            "Keychain Access",
            "SecurityAgent",
            "KeePassXC",
        ] {
            assert!(denied_app(Some(app), None));
        }
        assert!(denied_app(None, Some("com.agilebits.onepassword7")));
        assert!(!denied_app(Some("Mail"), Some("com.apple.mail")));
    }
}
