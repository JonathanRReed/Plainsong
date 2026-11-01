//! Sound-alike correction for the user's own dictionary terms.
//!
//! Parakeet, the default recognizer, has no vocabulary-hint input, so an
//! uncommon name or product comes back phonetically spelled: "Superbase" for
//! Supabase, "Alema" for Ollama, "Druve" for Dhruv. An exact dictionary rule
//! only fixes a misspelling the user predicted. This stage replaces a single
//! word with one of the user's dictionary terms when the two sound the same
//! and look alike.
//!
//! Guards, all required:
//! - only terms the user put in the dictionary, five letters or longer, one word;
//! - only single transcript words that are not real English words, checked in
//!   base form too ("notes" is "note", "parked" is "park") and against modern
//!   words the system list predates ("email", "website"), and not English pet
//!   forms of names it knows ("Lindy" for Linda); without a word list the
//!   stage does nothing;
//! - never a word with an apostrophe: contractions and possessives ("we'll",
//!   "Marcus's") are real speech, not misspellings;
//! - a lowercase word must sound exactly like the term, since recognizers
//!   usually capitalize what they think is a name;
//! - matching consonant skeletons with high spelling similarity, or identical
//!   skeletons with moderate similarity;
//! - nothing inside quotes or backticks.

use std::collections::HashMap;

const MIN_TERM_LETTERS: usize = 5;
const MIN_SKELETON_FOR_LOOSE_MATCH: usize = 3;
const LOOSE_SIMILARITY: f64 = 0.55;
const STRICT_SIMILARITY: f64 = 0.78;
const LOWERCASE_SIMILARITY: f64 = 0.80;

/// Everyday words newer than the 1934 system word list.
const MODERN_WORDS: &[&str] = &[
    "app",
    "apps",
    "backend",
    "blog",
    "blogs",
    "bluetooth",
    "browser",
    "chatbot",
    "chatbots",
    "checkout",
    "codebase",
    "cyber",
    "dashboard",
    "dashboards",
    "database",
    "databases",
    "desktop",
    "download",
    "downloads",
    "dropdown",
    "frontend",
    "homepage",
    "plugin",
    "plugins",
    "popup",
    "sidebar",
    "spreadsheet",
    "spreadsheets",
    "toolbar",
    "voicemail",
    "ebook",
    "email",
    "emailed",
    "emailing",
    "emails",
    "emoji",
    "emojis",
    "fintech",
    "hashtag",
    "hashtags",
    "inbox",
    "internet",
    "laptop",
    "laptops",
    "livestream",
    "login",
    "logins",
    "logout",
    "malware",
    "meme",
    "memes",
    "metadata",
    "online",
    "offline",
    "onboarding",
    "password",
    "passwords",
    "playlist",
    "podcast",
    "podcasts",
    "reboot",
    "screenshot",
    "screenshots",
    "selfie",
    "signup",
    "smartphone",
    "smartwatch",
    "software",
    "spam",
    "startup",
    "startups",
    "streaming",
    "tablet",
    "texting",
    "timeline",
    "touchscreen",
    "tweet",
    "tweets",
    "unsubscribe",
    "upload",
    "uploads",
    "username",
    "usernames",
    "webcam",
    "webinar",
    "webinars",
    "website",
    "websites",
    "wifi",
    "workflow",
    "workflows",
    "wireless",
    "okay",
    "gonna",
    "wanna",
    "gotta",
    "yeah",
];

/// A lowercase entry: an ordinary word.
const ORDINARY: u8 = 1;
/// A capitalized entry: a name ("Donna"), possibly also an ordinary word.
const NAME: u8 = 2;

/// Case-folded words with [`ORDINARY`] and [`NAME`] flags. Keys borrow the
/// shared folded text instead of allocating each word again.
fn parse_system_words<'a>(text: &str, folded: &'a str) -> HashMap<&'a str, u8> {
    let mut words = HashMap::with_capacity(text.lines().count());
    for (word, lower) in text.lines().zip(folded.lines()) {
        let flag = if word.chars().next().is_some_and(char::is_uppercase) {
            NAME
        } else {
            ORDINARY
        };
        *words.entry(lower.trim()).or_insert(0) |= flag;
    }
    words
}

fn system_words() -> Option<&'static HashMap<&'static str, u8>> {
    static FOLDED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    static WORDS: std::sync::OnceLock<Option<HashMap<&'static str, u8>>> =
        std::sync::OnceLock::new();
    WORDS
        .get_or_init(|| {
            let text = std::fs::read_to_string("/usr/share/dict/words").ok()?;
            let folded = FOLDED.get_or_init(|| text.to_lowercase());
            Some(parse_system_words(&text, folded))
        })
        .as_ref()
}

/// Replace sound-alike words with dictionary terms. Returns the text and the
/// terms that were applied.
pub(crate) fn correct_sound_alike_terms(text: &str, terms: &[&str]) -> (String, Vec<String>) {
    match system_words() {
        Some(words) => correct_with_words(
            text,
            terms,
            |word| words.contains_key(word),
            |word| is_listed_name(words, word),
        ),
        None => (text.to_string(), Vec::new()),
    }
}

fn is_listed_name(words: &HashMap<&str, u8>, word: &str) -> bool {
    words.get(word).is_some_and(|flags| flags & NAME != 0)
}

/// Whether `word` (lowercase) is an English pet form of a name the list
/// knows: the name's stem with -y, -ie or -ey ("lindy" for Linda, "robbie"
/// for Rob, "ellie" for Ella). The 1934 list has many of these ("Cindy")
/// but not all, and a recognizer writing one heard an English name, not a
/// foreign dictionary term that shares its consonants ("Lindiwe").
pub(crate) fn is_pet_form_of_name(word: &str, is_name: &impl Fn(&str) -> bool) -> bool {
    for suffix in ["ie", "ey", "y"] {
        let Some(stem) = word.strip_suffix(suffix) else {
            continue;
        };
        let chars: Vec<char> = stem.chars().collect();
        if chars.len() < 3 || !chars.iter().all(char::is_ascii_lowercase) {
            continue;
        }
        let doubled = chars[chars.len() - 1] == chars[chars.len() - 2];
        let undoubled: String = chars[..chars.len() - 1].iter().collect();
        let stems = std::iter::once(stem).chain(doubled.then_some(undoubled.as_str()));
        for base in stems {
            if is_name(base)
                || ["a", "e", "o"]
                    .iter()
                    .any(|end| is_name(&format!("{base}{end}")))
            {
                return true;
            }
        }
    }
    false
}

/// Whether a capitalized word read from a field is an ordinary English word
/// ("There", "Would", "Email") rather than a name. Unknown without a list.
pub(crate) fn is_common_word(word: &str) -> bool {
    system_words().is_none_or(|words| {
        is_english_word(&word.to_lowercase(), &|candidate| {
            words.contains_key(candidate)
        })
    })
}

/// Screen vocabulary may contain proper names from the system dictionary.
/// Keep ordinary lowercase words protected, including words such as Will/Mark
/// that also have a capitalized entry. Missing word lists still fail closed.
#[cfg(target_os = "macos")]
pub(crate) fn is_common_screen_word(word: &str) -> bool {
    system_words().is_none_or(|words| {
        is_english_word(&word.to_lowercase(), &|candidate| {
            words
                .get(candidate)
                .is_some_and(|flags| flags & ORDINARY != 0)
        })
    })
}

/// Whether `word` is an ordinary English word (a lowercase entry in the word
/// list, or a regular inflection of one), as opposed to a name the list knows
/// only capitalized ("Donna") or a word it does not know at all. Unknown
/// without a list, which counts as ordinary so callers fail closed.
pub(crate) fn is_ordinary_word(word: &str) -> bool {
    system_words().is_none_or(|words| {
        is_english_word(&word.to_lowercase(), &|candidate| {
            words
                .get(candidate)
                .is_some_and(|flags| flags & ORDINARY != 0)
        })
    })
}

/// Whether the word list has `word` as a name ("Donna", "Mark"), whether or
/// not it is also an ordinary word. Unknown without a list.
pub(crate) fn is_name_word(word: &str) -> bool {
    system_words().is_none_or(|words| {
        words
            .get(word.to_lowercase().as_str())
            .is_some_and(|flags| flags & NAME != 0)
    })
}

/// Whether the word list knows `word` at all, as a word or as a name,
/// counting English pet forms of its names ("Lindy").
pub(crate) fn is_listed_word(word: &str) -> bool {
    system_words().is_none_or(|words| {
        let lower = word.to_lowercase();
        is_english_word(&lower, &|candidate| words.contains_key(candidate))
            || is_pet_form_of_name(&lower, &|candidate| is_listed_name(words, candidate))
    })
}

fn correct_with_words(
    text: &str,
    terms: &[&str],
    in_word_list: impl Fn(&str) -> bool,
    is_name: impl Fn(&str) -> bool,
) -> (String, Vec<String>) {
    // Each term with its folded spelling and its respellings by its own
    // spelling rules ("shimon" for Szymon), each with its sound skeleton.
    let candidates: Vec<(&str, Vec<(String, String)>)> = terms
        .iter()
        .filter(|term| {
            term.chars().count() >= MIN_TERM_LETTERS && term.chars().all(|ch| ch.is_alphabetic())
        })
        .map(|term| {
            let respelled = crate::dictation_vocabulary::respell::respellings(term);
            // Foreign spelling is not an English pronunciation. Its written
            // consonants can match a different name even when its sound does not.
            let forms = if respelled.is_empty() {
                vec![crate::dictation_vocabulary::respell::fold(term)]
            } else {
                respelled
            }
            .into_iter()
            .map(|form| {
                let key = sound_skeleton(&form);
                (form, key)
            })
            .collect();
            (*term, forms)
        })
        .collect();
    if candidates.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let is_word =
        |word: &str| is_english_word(word, &in_word_list) || is_pet_form_of_name(word, &is_name);
    let mut output = String::with_capacity(text.len());
    let mut applied = Vec::new();
    let mut quoted = false;
    let mut word_start: Option<usize> = None;
    let flush = |output: &mut String, applied: &mut Vec<String>, word: &str, quoted: bool| {
        let replacement = (!quoted)
            .then(|| best_term(word, &candidates, &is_word))
            .flatten();
        match replacement {
            Some(term) => {
                if !applied.iter().any(|existing: &String| existing == term) {
                    applied.push(term.to_string());
                }
                output.push_str(term);
            }
            None => output.push_str(word),
        }
    };
    for (index, ch) in text.char_indices() {
        if ch.is_alphabetic() || (ch == '\'' && word_start.is_some()) {
            word_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = word_start.take() {
            flush(&mut output, &mut applied, &text[start..index], quoted);
        }
        if matches!(ch, '"' | '`' | '\u{201C}' | '\u{201D}') {
            quoted = !quoted;
        }
        output.push(ch);
    }
    if let Some(start) = word_start {
        flush(&mut output, &mut applied, &text[start..], quoted);
    }
    (output, applied)
}

fn best_term<'a>(
    word: &str,
    candidates: &'a [(&'a str, Vec<(String, String)>)],
    is_word: &impl Fn(&str) -> bool,
) -> Option<&'a str> {
    if word.contains(['\'', '\u{2019}']) || word.chars().all(char::is_uppercase) {
        return None;
    }
    let letters = word;
    if letters.chars().count() < 3 || is_word(&letters.to_lowercase()) {
        return None;
    }
    let capitalized = letters.chars().next().is_some_and(char::is_uppercase);
    let word_skeleton = sound_skeleton(letters);
    let folded = crate::dictation_vocabulary::respell::fold(letters);
    candidates
        .iter()
        .filter(|(term, _)| !term.eq_ignore_ascii_case(letters))
        .flat_map(|(term, forms)| forms.iter().map(move |form| (*term, form)))
        .filter_map(|(term, (form, term_skeleton))| {
            let similarity = jaro_winkler(&folded, form);
            let distance = levenshtein(&word_skeleton, term_skeleton);
            let accepted = if capitalized {
                (distance == 0
                    && term_skeleton.chars().count() >= MIN_SKELETON_FOR_LOOSE_MATCH
                    && similarity >= LOOSE_SIMILARITY)
                    || (distance == 1 && similarity >= STRICT_SIMILARITY)
            } else {
                distance == 0 && similarity >= LOWERCASE_SIMILARITY
            };
            accepted.then_some((term, similarity))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(term, _)| term)
}

/// A word or one of its regular inflections is in the word list.
pub(crate) fn is_english_word(word: &str, in_list: &impl Fn(&str) -> bool) -> bool {
    if in_list(word) || MODERN_WORDS.contains(&word) {
        return true;
    }
    const SUFFIXES: &[(&str, &str)] = &[
        ("ies", "y"),
        ("es", ""),
        ("s", ""),
        ("ed", ""),
        ("ed", "e"),
        ("ing", ""),
        ("ing", "e"),
        ("ers", ""),
        ("er", ""),
        ("ly", ""),
    ];
    for (suffix, replacement) in SUFFIXES {
        if let Some(base) = word.strip_suffix(suffix) {
            if base.chars().count() >= 3 && in_list(&format!("{base}{replacement}")) {
                return true;
            }
        }
    }
    // "planned" -> "plan", "running" -> "run".
    for suffix in ["ed", "ing"] {
        if let Some(base) = word.strip_suffix(suffix) {
            let chars: Vec<char> = base.chars().collect();
            if chars.len() >= 4 && chars[chars.len() - 1] == chars[chars.len() - 2] {
                let undoubled: String = chars[..chars.len() - 1].iter().collect();
                if in_list(&undoubled) {
                    return true;
                }
            }
        }
    }
    false
}

/// A consonant sound skeleton: spelling variants that sound alike map to the
/// same letters, vowels after the first sound are dropped, repeats collapse.
pub(crate) fn sound_skeleton(word: &str) -> String {
    let letters: Vec<char> = word
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    let mut sounds = Vec::with_capacity(letters.len());
    let mut index = 0;
    while index < letters.len() {
        let next = letters.get(index + 1).copied();
        let soft = matches!(next, Some('e' | 'i' | 'y'));
        let (sound, width): (&[char], usize) = match (letters[index], next) {
            ('p', Some('h')) => (&['f'], 2),
            ('c', Some('k')) => (&['k'], 2),
            ('s' | 'c', Some('h')) => (&['x'], 2),
            ('t', Some('h')) => (&['0'], 2),
            ('w', Some('h')) => (&['w'], 2),
            ('d', Some('g')) => (&['j'], 2),
            ('b', Some('h')) => (&['f'], 2),
            ('q', Some('u')) => (&['k'], 2),
            ('q', _) => (&['k'], 1),
            ('x', _) => (&['k', 's'], 1),
            ('c', _) if soft => (&['s'], 1),
            ('c', _) => (&['k'], 1),
            ('g', _) if soft => (&['j'], 1),
            ('z', _) => (&['s'], 1),
            ('v', _) => (&['f'], 1),
            _ => (std::slice::from_ref(&letters[index]), 1),
        };
        sounds.extend_from_slice(sound);
        index += width;
    }
    let mut out = String::new();
    for (position, sound) in sounds.iter().enumerate() {
        let vowel = matches!(sound, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
        let kept = if position == 0 {
            Some(if vowel { 'a' } else { *sound })
        } else if vowel || matches!(sound, 'h' | 'w') {
            None
        } else {
            Some(*sound)
        };
        if let Some(sound) = kept {
            if !out.ends_with(sound) {
                out.push(sound);
            }
        }
    }
    out
}

pub(crate) fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous + usize::from(ca != *cb);
            previous = row[j + 1];
            row[j + 1] = substitution.min(row[j] + 1).min(row[j + 1] + 1);
        }
    }
    row[b.len()]
}

pub(crate) fn jaro_winkler(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut a_matched = vec![false; a.len()];
    let mut b_matched = vec![false; b.len()];
    let mut matches = 0usize;
    for (i, ca) in a.iter().enumerate() {
        let start = i.saturating_sub(window);
        let end = (i + window + 1).min(b.len());
        for j in start..end {
            if !b_matched[j] && b[j] == *ca {
                a_matched[i] = true;
                b_matched[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let a_order = a
        .iter()
        .zip(&a_matched)
        .filter(|(_, m)| **m)
        .map(|(c, _)| c);
    let b_order = b
        .iter()
        .zip(&b_matched)
        .filter(|(_, m)| **m)
        .map(|(c, _)| c);
    let transpositions = a_order.zip(b_order).filter(|(x, y)| x != y).count() as f64 / 2.0;
    let m = matches as f64;
    let jaro = (m / a.len() as f64 + m / b.len() as f64 + (m - transpositions) / m) / 3.0;
    let prefix = a.iter().zip(&b).take(4).take_while(|(x, y)| x == y).count() as f64;
    jaro + prefix * 0.1 * (1.0 - jaro)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERMS: &[&str] = &[
        "Kubernetes",
        "Supabase",
        "Anjali",
        "Nemotron",
        "Parakeet",
        "Grafana",
        "Ollama",
        "Dhruv",
        "Theresa",
        "Wells",
        "Dante",
        "Emily",
        "Siobhan",
        "Notion",
        "Typeless",
        "Linear",
        "Marcus",
        "Denver",
        "Swift",
    ];

    /// The ordinary words used below, standing in for the system word list.
    const WORDS: &[&str] = &[
        "we", "store", "the", "session", "in", "for", "now", "send", "draft", "to", "and",
        "tomorrow", "compare", "parakeet", "with", "on", "long", "clip", "run", "model", "through",
        "weight", "will", "review", "pull", "request", "release", "note", "are", "ready", "vessel",
        "was", "park", "near", "marquee", "type", "less", "bold", "header", "tutor", "trust",
        "vendor", "rust", "gate", "swift", "move", "notion", "graft", "plant", "linear", "angle",
        "our", "ignore", "need", "rest", "before", "of", "i", "drive", "fail", "is", "fine", "but",
        "super", "base", "camp", "open", "at", "noon", "plain", "song", "should", "paste", "into",
        "slack", "quin", "superb", "layer", "setting", "send", "it", "sure", "mind", "ask",
        "about", "limit", "you", "as", "typed", "write", "exactly",
    ];

    /// Names the word list knows only capitalized, standing in for its names.
    const NAMES: &[&str] = &["linda", "rob", "ella", "christopher", "priya"];

    fn correct_with(text: &str, terms: &[&str]) -> String {
        correct_with_words(
            text,
            terms,
            |word| WORDS.contains(&word) || NAMES.contains(&word),
            |word| NAMES.contains(&word),
        )
        .0
    }

    fn correct(text: &str) -> String {
        correct_with(text, TERMS)
    }

    #[test]
    fn an_english_pet_form_of_a_known_name_is_left_alone() {
        // A trap clip: "…to Linda yet?" heard as "Lindy It?". Lindiwe shares
        // its consonants, but "Lindy" is how English writes a pet form of
        // Linda, so the speaker said an English name.
        let text = "Did Christopher send a contract to Lindy It?";
        assert_eq!(correct_with(text, &["Lindiwe"]), text);
        assert_eq!(
            correct_with("Ask Robbie and Ellie about it.", &["Robiya", "Elliot"]),
            "Ask Robbie and Ellie about it."
        );
        // A heard word that is no pet form of a known name is still spelled.
        assert_eq!(
            correct_with("Did Christopher send a contract to Lindiwi?", &["Lindiwe"]),
            "Did Christopher send a contract to Lindiwe?"
        );
    }

    #[test]
    fn pet_forms_need_a_known_name_behind_them() {
        let is_name = |word: &str| NAMES.contains(&word);
        for pet in ["lindy", "robbie", "robby", "ellie", "ella"] {
            assert_eq!(is_pet_form_of_name(pet, &is_name), pet != "ella", "{pet}");
        }
        for word in ["gwenley", "druve", "kriya", "ly", "aly", "tampy"] {
            assert!(!is_pet_form_of_name(word, &is_name), "{word}");
        }
    }

    #[test]
    fn the_system_word_list_knows_pet_forms_of_its_names() {
        if system_words().is_none() {
            return;
        }
        let text = "Did Christopher send a contract to Lindy It?";
        assert_eq!(correct_sound_alike_terms(text, &["Lindiwe"]).0, text);
        assert!(is_listed_word("Lindy"));
        assert!(!is_ordinary_word("Lindy"));
        assert_eq!(
            correct_sound_alike_terms("We store it in Superbase.", &["Supabase"]).0,
            "We store it in Supabase."
        );
    }

    #[test]
    fn foreign_spelling_does_not_supply_an_english_pronunciation() {
        for text in ["Zimina told us about it.", "Ask Zimina tomorrow."] {
            assert_eq!(correct_with(text, &["Szymon"]), text);
        }
        assert_eq!(
            correct_with("Ask Shimon tomorrow.", &["Szymon"]),
            "Ask Szymon tomorrow."
        );
    }

    #[test]
    fn phonetic_matching_keeps_recognized_acronyms() {
        let text = "Use SQL in the report.";
        let (output, applied) = correct_with_words(text, &["SQLite"], |_| false, |_| false);
        assert_eq!(output, text);
        assert!(applied.is_empty());
    }

    #[test]
    fn phonetic_misspellings_of_dictionary_terms_are_corrected() {
        for (heard, expected) in [
            (
                "We store the sessions in Superbase for now.",
                "We store the sessions in Supabase for now.",
            ),
            (
                "Send the draft to Priya and Angeli tomorrow.",
                "Send the draft to Priya and Anjali tomorrow.",
            ),
            (
                "Compare parakeet with nemetrine on the long clip.",
                "Compare parakeet with Nemotron on the long clip.",
            ),
            (
                "Run the model through Alema with the Quin weights.",
                "Run the model through Ollama with the Quin weights.",
            ),
            (
                "Druve will review the pull request.",
                "Dhruv will review the pull request.",
            ),
        ] {
            assert_eq!(correct(heard), expected, "{heard}");
        }
    }

    #[test]
    fn ordinary_words_quotes_and_short_terms_are_never_rewritten() {
        for text in [
            "Release notes are ready.",
            "The vessel was parked near the marquee.",
            "Make the type less bold in the header.",
            "The tutors trusted the vendors.",
            "Rusted gates and swiftly moving notions.",
            "Our linear model ignores the angle.",
            "I need to rest before the swift review of the notion.",
            "Super base camp opens at noon.",
            "Plain song should paste into Slack.",
            "Write \"Superbase\" exactly.",
            "Run `Alema` as typed.",
            "We'll send it; they're sure we don't mind.",
            "Ask about Marcus's laptop and Supabase's limits.",
            "I'll email you the website and the emails.",
        ] {
            assert_eq!(correct(text), text, "{text}");
        }
    }

    #[test]
    fn applied_terms_are_reported_once() {
        let (_, applied) = correct_with_words(
            "Superbase and superbase again, then Alema.",
            TERMS,
            |word| WORDS.contains(&word),
            |_| false,
        );
        assert_eq!(applied, ["Supabase", "Ollama"]);
    }

    #[test]
    fn a_word_the_list_knows_is_left_alone() {
        let (text, applied) = correct_with_words("Superbase", TERMS, |_| true, |_| false);
        assert_eq!(text, "Superbase");
        assert!(applied.is_empty());
    }

    #[test]
    fn shared_word_list_keeps_common_aliases_and_proper_only_names_distinct() {
        let text = "Will\nwill\nmark\nMark\nBill\nbill\nJonathan\nReed";
        let folded = text.to_lowercase();
        let words = parse_system_words(text, &folded);
        for word in ["will", "mark", "bill"] {
            assert_eq!(words.get(word), Some(&(ORDINARY | NAME)));
        }
        for name in ["jonathan", "reed"] {
            assert_eq!(words.get(name), Some(&NAME));
        }
    }
}
