//! Whether the English-only dictation stages apply to a transcript.
//!
//! Several local dictation stages are English rules: hesitation removal
//! deletes "um", spoken-repair cues read "er", number words become digits,
//! and a lone "i" becomes "I". In German "um" means "in order to" or "at", in
//! Portuguese it is the article "a", and in Italian "i" is the plural "the".
//! On real FLEURS speech recognized by Parakeet v3 (2026-10-21), 13 of 40
//! Portuguese and 5 of 40 German dictations lost a word to the filler rule,
//! and 6 of 40 Italian ones had an article capitalized.
//!
//! The decision is made once per dictation, on the recognizer's text, and
//! every English-only stage (local cleanup, number ITN, pronoun "I", and the
//! AI cleanup prompt and validator) follows it. A language the user chose,
//! or one the recognizer reported, decides first: English keeps the rules,
//! any other language turns them off. Only an automatic setting with a
//! recognizer that reports nothing (the multilingual Parakeet default) falls
//! back to reading the text.
//!
//! The text test is deliberately one-sided. It counts lowercase function
//! words that are common in German, Spanish, French, Italian or Portuguese
//! and are not English words. Words English shares ("a", "in",
//! "no", "die", "was", "per", "um", "mit", "al", "el", "den", "con", "pour",
//! "dove", "ma", "os", "da", "e", "y" ...) are left out, a capitalized word
//! counts only at the start of a sentence (so "Al Gore", "El Al" and "Las
//! Vegas" are names), and all-capital acronyms ("MIT", "ALS", "DOS") never
//! count. Words carrying Latin diacritics only corroborate function words
//! and never outnumber them, so a run of names or dishes ("Zoë, Chloé,
//! Renée", "crème fraîche") cannot flip the decision. Only clear evidence,
//! at least two such words and more than twice the English function words,
//! turns the English rules off.

const GERMAN: &[&str] = &[
    "der", "das", "und", "ist", "nicht", "ein", "eine", "einen", "einem", "einer", "zu", "von",
    "für", "auf", "dem", "sich", "auch", "wie", "wurde", "werden", "sind", "ich", "wir", "sie",
    "aber", "oder", "noch", "nach", "bei", "aus", "durch", "über", "wenn", "dass", "kann", "haben",
    "nur", "sehr", "schon", "diese", "dieser", "zum", "zur", "vom", "beim", "ihre", "ihr", "sein",
    "seine", "seinen", "uns", "mich", "dich", "doch",
];
const SPANISH: &[&str] = &[
    "los", "las", "del", "que", "una", "por", "para", "es", "se", "nos", "como", "más", "pero",
    "su", "sus", "muy", "este", "esta", "fue", "ser", "está", "también", "porque", "cuando",
    "donde", "sobre", "entre", "desde", "hasta", "fueron", "otro", "otra", "puede", "tiene",
    "cada", "aunque",
];
const FRENCH: &[&str] = &[
    "le", "les", "un", "une", "est", "qui", "dans", "sur", "avec", "ce", "il", "elle", "je",
    "nous", "vous", "sont", "ont", "mais", "cette", "ces", "été", "être", "leur", "très", "aussi",
    "comme", "lui", "ne", "peut", "fait", "depuis", "selon",
];
const ITALIAN: &[&str] = &[
    "il", "gli", "di", "che", "è", "della", "delle", "dei", "degli", "nel", "nella", "sono",
    "anche", "questo", "questa", "più", "ho", "alla", "alle", "tra", "cui", "essere", "molto",
    "perché", "sul", "dal", "dalla", "loro", "stato", "stati", "nello", "non", "si", "chi",
    "hanno",
];
const PORTUGUESE: &[&str] = &[
    "é", "não", "mais", "mas", "pelo", "pela", "são", "foi", "também", "ao", "aos", "seu", "sua",
    "muito", "isso", "isto", "você", "ele", "ela", "quando", "onde", "uma", "num", "numa", "dele",
    "dela", "eles", "elas", "foram", "estão", "pode", "ainda", "depois", "seus", "suas", "desse",
    "dessa", "desses", "dessas", "deste", "desta", "outros", "outras", "quase", "todos", "todas",
    "eram", "pelos", "pelas", "nas",
];
const OTHER_LANGUAGE_FUNCTION_WORDS: [&[&str]; 5] = [GERMAN, SPANISH, FRENCH, ITALIAN, PORTUGUESE];

/// English function words that do not double as a common word in the
/// languages above.
const ENGLISH_FUNCTION_WORDS: &[&str] = &[
    "the", "and", "of", "to", "is", "are", "were", "you", "that", "this", "with", "for", "have",
    "has", "it", "she", "they", "we", "my", "your", "not", "be", "at", "but", "or", "just", "what",
    "if", "can", "would", "there", "their", "our", "from", "by", "about", "like", "yeah", "okay",
    "i'm", "it's", "don't", "we're", "you're", "that's", "been", "them", "then", "these", "those",
    "which", "who", "how", "when", "where", "why", "because",
];

fn has_other_latin_diacritic(word: &str) -> bool {
    word.chars()
        .any(|ch| "äöüßàâçèéêëîïôùûãõáíóúñìò".contains(ch))
}

/// The spoken language for one dictation, as far as anything states it: the
/// transcript was translated to English, the user picked a language, or the
/// recognizer reported one. `None` when the setting is automatic and the
/// recognizer reported nothing, so `english_rules_apply` reads the text.
pub fn dictation_spoken_language<'a>(
    setting: Option<&'a str>,
    reported: Option<&'a str>,
    translated_to_english: bool,
) -> Option<&'a str> {
    if translated_to_english {
        return Some("en");
    }
    setting
        .filter(|tag| language_is_english(Some(tag)).is_some())
        .or_else(|| reported.filter(|tag| language_is_english(Some(tag)).is_some()))
}

/// `Some(true)` for English, `Some(false)` for any other named language,
/// `None` for automatic, empty or unknown.
fn language_is_english(tag: Option<&str>) -> Option<bool> {
    let tag = tag?.trim().to_ascii_lowercase();
    let base = tag.split(['-', '_']).next().unwrap_or_default();
    if matches!(
        base,
        "" | "auto" | "und" | "unknown" | "detect" | "multi" | "mul"
    ) {
        return None;
    }
    if matches!(base, "en" | "eng" | "english") {
        return Some(true);
    }
    // A language tag ("de", "pt-BR", "deu") or a name a cloud recognizer
    // writes out ("german").
    let is_tag = (2..=3).contains(&base.len()) && base.chars().all(|ch| ch.is_ascii_alphabetic());
    let is_name = matches!(
        base,
        "german"
            | "spanish"
            | "french"
            | "italian"
            | "portuguese"
            | "dutch"
            | "polish"
            | "russian"
            | "ukrainian"
            | "swedish"
            | "danish"
            | "norwegian"
            | "finnish"
            | "czech"
            | "slovak"
            | "romanian"
            | "hungarian"
            | "greek"
            | "turkish"
            | "catalan"
            | "japanese"
            | "chinese"
            | "korean"
            | "arabic"
            | "hindi"
            | "hebrew"
    );
    (is_tag || is_name).then_some(false)
}

/// Whether the English-only stages apply. `spoken_language` comes from
/// `dictation_spoken_language`; without one, the transcript decides.
pub fn english_rules_apply(spoken_language: Option<&str>, text: &str) -> bool {
    language_is_english(spoken_language).unwrap_or_else(|| !reads_as_non_english(text))
}

/// Spelling recognizer digits introduces English words. With no reported
/// language, even a short foreign sentence needs protection if it contains
/// a foreign function word and no English function words.
pub(crate) fn english_number_words_apply(spoken_language: Option<&str>, text: &str) -> bool {
    language_is_english(spoken_language).unwrap_or_else(|| {
        let counts = count_language_words(text);
        !reads_as_non_english(text) && (counts.function_words == 0 || counts.english > 0)
    })
}

/// True when `text` clearly reads as German, Spanish, French, Italian or
/// Portuguese rather than English. See the module notes for the rule.
pub(crate) fn reads_as_non_english(text: &str) -> bool {
    let counts = count_language_words(text);
    let other = counts.function_words + counts.diacritic_words.min(counts.function_words);
    other >= 2 && other > 2 * counts.english
}

/// True when `text` has even one function word that only another of these
/// languages uses ("wir", "está", "não"). Too weak to turn the English rules
/// off, but enough to read a bare "um" as German "at" or Portuguese "a"
/// rather than a hesitation ("Wir kommen um elf", "Um carro está na rua").
/// A word with a diacritic alone does not count: English borrows "café" and
/// "résumé", and "The café um opens at nine" still has a hesitation.
pub(crate) fn has_non_english_word(text: &str) -> bool {
    count_language_words(text).function_words > 0
}

/// A word that follows the German or Portuguese "um" and is not English:
/// German numbers and pronouns ("um zehn Uhr", "um sich"), Portuguese
/// numbers and common nouns ("um carro", "um dia"). After one of these, a
/// bare "um" is the word, not a hesitation.
pub(crate) fn follows_german_or_portuguese_um(word: &str) -> bool {
    const WORDS: &[&str] = &[
        // German: "um acht", "um halb neun", "um Mitternacht", "um sich".
        "eins",
        "zwei",
        "drei",
        "vier",
        "fünf",
        "sechs",
        "sieben",
        "acht",
        "neun",
        "zehn",
        "zwölf",
        "halb",
        "viertel",
        "mitternacht",
        "sich",
        "mich",
        "dich",
        "uns",
        "euch",
        "ihn",
        "einen",
        "einem",
        "eine",
        "ein",
        "jeden",
        "jede",
        "jeder",
        "wieviel",
        "wie",
        "welche",
        "das",
        "der",
        "zu",
        // Portuguese: "um dois três", "um carro", "um pouco".
        "dois",
        "três",
        "quatro",
        "cinco",
        "seis",
        "sete",
        "oito",
        "nove",
        "dez",
        "cem",
        "pouco",
        "bom",
        "dia",
        "carro",
        "homem",
        "ano",
        "mês",
        "momento",
        "lugar",
        "livro",
        "novo",
        "certo",
        "tipo",
        "copo",
        "quilo",
        "telefone",
        "problema",
        "projeto",
        "pedido",
        "minuto",
        "segundo",
        "milhão",
        "pequeno",
        "filho",
        "irmão",
        "menino",
        "cachorro",
        "gato",
        "jogo",
        "trabalho",
        "nome",
        "país",
        "mundo",
        "lado",
        "caso",
        "ponto",
        "texto",
    ];
    WORDS.contains(&word.to_lowercase().as_str())
}

struct LanguageWordCounts {
    function_words: usize,
    diacritic_words: usize,
    english: usize,
}

fn count_language_words(text: &str) -> LanguageWordCounts {
    let mut function_words = 0usize;
    let mut diacritic_words = 0usize;
    let mut english = 0usize;
    let mut sentence_start = true;
    for raw in text.split_whitespace() {
        let core = raw
            .trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '\'' && ch != '’')
            .trim_matches(['\'', '’'])
            .replace('’', "'");
        let at_sentence_start = sentence_start;
        sentence_start = raw.ends_with(['.', '!', '?', ':']);
        if core.is_empty() {
            continue;
        }
        let word = core.to_lowercase();
        let lowercase = core == word;
        let acronym = core.chars().filter(|ch| ch.is_alphabetic()).count() >= 2
            && !core.chars().any(char::is_lowercase);
        if acronym {
            continue;
        }
        let function_word = OTHER_LANGUAGE_FUNCTION_WORDS
            .iter()
            .any(|words| words.contains(&word.as_str()));
        if function_word && (lowercase || at_sentence_start) {
            function_words += 1;
        } else if has_other_latin_diacritic(&word) {
            diacritic_words += 1;
        } else if ENGLISH_FUNCTION_WORDS.contains(&word.as_str()) {
            english += 1;
        }
    }
    LanguageWordCounts {
        function_words,
        diacritic_words,
        english,
    }
}

#[cfg(test)]
mod tests {
    use super::{dictation_spoken_language, english_rules_apply, reads_as_non_english};

    #[test]
    fn recognizes_real_sentences_in_the_five_parakeet_languages() {
        for text in [
            "Er war nicht dazu in der Lage, die benötigten Medikamente einzunehmen, um seinen Schmerz zu überwinden.",
            "Die meisten Gebäude wurden wieder aufgebaut, um den Touristen einen besseren Eindruck zu vermitteln.",
            "Um acht Uhr ist das Meeting.",
            "Portanto, o lápis foi um bom amigo para muitas pessoas quando foi lançado.",
            "Um total de 20% de água que vão dos rios do planeta para os oceanos vem da Amazônia.",
            "Sei ostaggi, tra cui i bambini anziani, sono stati liberati subito.",
            "Controllare anticipatamente con i proprietari per decidere un metodo di pagamento.",
            "Entre los deportes que más se practican están el fútbol y el baloncesto.",
            "Presque toutes les plages sont sablonneuses et permettent de se baigner.",
        ] {
            assert!(reads_as_non_english(text), "{text}");
        }
    }

    #[test]
    fn english_dictation_keeps_the_english_rules() {
        for text in [
            "Um, yeah.",
            "Um so if we want to do it that way, yeah.",
            "I mean i think they should have two options.",
            "Let's meet at the café de la Paix at noon.",
            "Send the deck to José and María before the review.",
            "The Ecole des Beaux-Arts deadline is Friday, um, I think.",
            "Can you ask Jürgen if the build is green?",
            "uh",
            "",
            "Je ne sais quoi is what the design needs, and I want it by Monday.",
        ] {
            assert!(!reads_as_non_english(text), "{text}");
        }
    }

    /// Acronyms, names and loanwords that share spelling with a function
    /// word or carry diacritics are English dictation.
    #[test]
    fn english_names_acronyms_and_loanwords_are_not_another_language() {
        for text in [
            "Uh, MIT, um, ALS research.",
            "Um, Al Gore, Al Pacino.",
            "um, El Al flight",
            "Um, Zoë, Chloé, Renée and Noël.",
            "Um, sushi, ramen, pho, crème fraîche.",
            "Um, café au lait.",
            "Um, vis-à-vis, the protégé's exposé.",
            "Um, so the DOS and the OS, um, you know.",
            "Um, Los Angeles to Las Vegas, um, two hundred and seventy miles.",
            "Um, Le Bernardin, two at seven.",
            "um, Les Misérables at eight.",
            "Um, const x = el.value; let y = os.path.",
        ] {
            assert!(!reads_as_non_english(text), "{text}");
        }
    }

    #[test]
    fn a_stated_language_decides_before_the_text() {
        // German and Portuguese "um" and Italian "i" with the language known.
        for (language, text) in [
            ("de", "Er kommt um acht."),
            ("de", "Um acht Uhr."),
            ("pt", "Comprei um carro novo."),
            ("pt-BR", "Um bom dia."),
            ("it", "Ho visto i ragazzi."),
            ("german", "Um acht Uhr."),
        ] {
            assert!(!english_rules_apply(Some(language), text), "{text}");
        }
        // An explicit English setting keeps the rules even on text that
        // reads foreign.
        assert!(english_rules_apply(
            Some("en-US"),
            "Sei ostaggi, tra cui i bambini anziani, sono stati liberati subito."
        ));
        // Automatic or unknown falls back to the text.
        for language in [None, Some(""), Some("auto")] {
            assert!(english_rules_apply(language, "Um, yeah."));
            assert!(!english_rules_apply(
                language,
                "Sei ostaggi, tra cui i bambini anziani, sono stati liberati subito."
            ));
        }
    }

    #[test]
    fn the_spoken_language_comes_from_translation_then_setting_then_recognizer() {
        assert_eq!(
            dictation_spoken_language(Some("de"), Some("de"), true),
            Some("en")
        );
        assert_eq!(
            dictation_spoken_language(Some("pt"), Some("en"), false),
            Some("pt")
        );
        assert_eq!(
            dictation_spoken_language(Some("auto"), Some("it"), false),
            Some("it")
        );
        assert_eq!(dictation_spoken_language(None, Some(""), false), None);
        assert_eq!(dictation_spoken_language(None, None, false), None);
    }
}
