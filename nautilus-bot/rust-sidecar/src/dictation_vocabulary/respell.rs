//! How an English recognizer writes a name it hears: accent folding and
//! respellings by the name's own spelling rules.
//!
//! Parakeet writes "Simon" for Szymon and "Neve" for Niamh because it spells
//! the sound in English. Comparing that with the term's letters misses the
//! match; comparing it with an English respelling ("shimon", "neev") finds
//! it. The respellings are sent to the speech helper as extra spoken forms,
//! so the vocabulary model scores the sound rather than the letters, and
//! their sound keys let the sidecar trust a user's own term a little more.
//!
//! Each family of rules runs only when the word carries that orthography's
//! marks (Polish "sz" or "ł", Irish "bh" or "ao", Vietnamese tone marks), so
//! an English name gets no respelling at all.

use unicode_normalization::UnicodeNormalization;

/// At most this many respellings per term.
pub(crate) const MAX_RESPELLINGS: usize = 3;

/// Lowercase ASCII letters with single spaces between words: accents and
/// tone marks dropped, letters without a decomposition mapped ("ł" to "l",
/// "đ" to "d", "ø" to "o", "ß" to "ss"), digits and punctuation removed.
pub(crate) fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.nfd().flat_map(char::to_lowercase) {
        let mapped: &str = match ch {
            'a'..='z' => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.push(ch);
                continue;
            }
            ' ' | '-' | '\t' | '\n' => {
                space = true;
                continue;
            }
            'ł' => "l",
            'đ' | 'ð' => "d",
            'ø' => "o",
            'æ' => "ae",
            'œ' => "oe",
            'ß' => "ss",
            'þ' => "th",
            'ı' => "i",
            'ŋ' => "ng",
            _ => continue,
        };
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push_str(mapped);
    }
    out
}

#[derive(Clone, Copy)]
enum At {
    Any,
    Start,
    End,
    /// Followed by one of these letters.
    Before(&'static str),
    /// At the end, after a consonant.
    EndAfterConsonant,
}

struct Rule(&'static str, &'static str, At);

const VOWELS: &str = "aeiouyàáâäãåèéêëìíîïòóôöõùúûüýąęőű";

fn rewrite(word: &str, rules: &[Rule]) -> String {
    let mut out = String::with_capacity(word.len() + 4);
    let mut index = 0;
    'next: while index < word.len() {
        let rest = &word[index..];
        for Rule(from, to, at) in rules {
            if !rest.starts_with(from) {
                continue;
            }
            let after = &rest[from.len()..];
            let fits = match at {
                At::Any => true,
                At::Start => index == 0,
                At::End => after.is_empty(),
                At::Before(set) => after.chars().next().is_some_and(|ch| set.contains(ch)),
                At::EndAfterConsonant => {
                    after.is_empty()
                        && word[..index]
                            .chars()
                            .next_back()
                            .is_some_and(|ch| ch.is_alphabetic() && !VOWELS.contains(ch))
                }
            };
            if fits {
                out.push_str(to);
                index += from.len();
                continue 'next;
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn has_any(word: &str, chars: &str) -> bool {
    word.chars().any(|ch| chars.contains(ch))
}

fn has_any_of(word: &str, parts: &[&str]) -> bool {
    parts.iter().any(|part| word.contains(part))
}

const POLISH: &[Rule] = &[
    Rule("szcz", "shch", At::Any),
    Rule("prz", "psh", At::Any),
    Rule("trz", "tsh", At::Any),
    Rule("krz", "ksh", At::Any),
    Rule("sz", "sh", At::Any),
    Rule("cz", "ch", At::Any),
    Rule("rz", "zh", At::Any),
    Rule("dż", "j", At::Any),
    Rule("dź", "j", At::Any),
    Rule("dzi", "j", At::Before(VOWELS)),
    Rule("ci", "ch", At::Before(VOWELS)),
    Rule("si", "sh", At::Before(VOWELS)),
    Rule("zi", "zh", At::Before(VOWELS)),
    Rule("ni", "ny", At::Before(VOWELS)),
    Rule("ch", "h", At::Any),
    Rule("ł", "w", At::Any),
    Rule("ż", "zh", At::Any),
    Rule("ź", "zh", At::Any),
    Rule("ś", "sh", At::Any),
    Rule("ć", "ch", At::Any),
    Rule("ń", "n", At::Any),
    Rule("ą", "on", At::Any),
    Rule("ę", "en", At::Any),
    Rule("ó", "u", At::Any),
    Rule("w", "v", At::Any),
    Rule("j", "y", At::Any),
    Rule("c", "ts", At::Any),
    Rule("y", "i", At::Any),
];

fn is_polish(word: &str) -> bool {
    has_any(word, "łżźśćńąę") || has_any_of(word, &["sz", "cz", "rz", "wicz", "wski", "wska"])
}

/// Irish and Scottish Gaelic.
const GAELIC: &[Rule] = &[
    Rule("aoi", "ee", At::Any),
    Rule("ao", "ee", At::Any),
    Rule("iamh", "eev", At::Any),
    Rule("aith", "a", At::End),
    Rule("idh", "ee", At::End),
    Rule("uai", "oo", At::Any),
    Rule("mh", "v", At::Any),
    Rule("bh", "v", At::Any),
    Rule("dh", "", At::Any),
    Rule("fh", "", At::Any),
    Rule("gh", "", At::Any),
    Rule("th", "h", At::Any),
    Rule("ch", "kh", At::Any),
    Rule("s", "sh", At::Before("eiéí")),
    Rule("io", "i", At::Any),
    Rule("ea", "a", At::Any),
    Rule("ei", "ay", At::Any),
    Rule("ái", "aw", At::Any),
    Rule("á", "aw", At::Any),
    Rule("é", "ay", At::Any),
    Rule("í", "ee", At::Any),
    Rule("ú", "oo", At::Any),
    Rule("c", "k", At::Any),
    Rule("e", "a", At::EndAfterConsonant),
];

/// Irish and Gaelic spelling has no j, k, q, v, w, x, y or z, which rules
/// out pinyin ("Xiao", "Zhao") and most Indian names ("Vaibhav"). A
/// lenited consonant alone is not enough ("Siddharth", "Abhishek", "Madhu"):
/// it needs a Gaelic vowel pair, a long vowel mark or a Gaelic ending too.
fn is_gaelic(word: &str) -> bool {
    if has_any(word, "jkqvwxyz") {
        return false;
    }
    let lenited = has_any_of(word, &["bh", "mh", "dh", "fh"]);
    let vowels = has_any_of(word, &["ea", "io", "ia", "ui", "ua", "ei", "oi"])
        || has_any(word, "áéíóú")
        || ["bh", "mh", "dhg", "idh"]
            .iter()
            .any(|end| word.ends_with(end));
    // "ao" before "i" or a consonant: Aoife, Saoirse, Caoimhe, Aodh.
    let broad_ao = word.match_indices("ao").any(|(at, _)| {
        word[at + 2..]
            .chars()
            .next()
            .is_some_and(|ch| ch == 'i' || !VOWELS.contains(ch))
    });
    (lenited && vowels)
        || broad_ao
        || ["agh", "aigh", "aith"]
            .iter()
            .any(|end| word.ends_with(end))
        || ["cia", "cio", "ciu"]
            .iter()
            .any(|start| word.starts_with(start))
}

const WELSH: &[Rule] = &[
    Rule("dd", "th", At::Any),
    Rule("ff", "f", At::Any),
    Rule("f", "v", At::Any),
    Rule("si", "sh", At::Before("aâ")),
    Rule("â", "aa", At::Any),
    Rule("ŵ", "oo", At::Any),
    Rule("ŷ", "ee", At::Any),
    Rule("u", "i", At::Any),
];

/// Not a bare "dd", which English names have too ("Freddie", "Todd").
fn is_welsh(word: &str) -> bool {
    has_any(word, "ŵŷâ")
        || has_any_of(word, &["ydd", "udd", "ddyn"])
        || ["ff", "ll", "rh"]
            .iter()
            .any(|start| word.starts_with(start))
}

const VIETNAMESE: &[Rule] = &[
    Rule("quy", "qui", At::Any),
    Rule("uy", "wee", At::End),
    Rule("nh", "n", At::End),
    Rule("ph", "f", At::Any),
    Rule("tr", "ch", At::Start),
    Rule("th", "t", At::Start),
    Rule("x", "s", At::Start),
];

fn is_vietnamese(word: &str) -> bool {
    word.chars()
        .any(|ch| matches!(ch, 'đ' | 'ơ' | 'ư' | 'ă' | '\u{1EA0}'..='\u{1EF9}'))
        || (word.ends_with("nh") && word.chars().count() <= 6)
}

/// Yoruba, Igbo, and other West and East African spellings.
const WEST_AFRICAN: &[Rule] = &[
    Rule("ṣ", "sh", At::Any),
    Rule("gb", "b", At::Start),
    Rule("kp", "p", At::Start),
];

fn is_west_african(word: &str) -> bool {
    word.contains('ṣ') || word.starts_with("gb") || word.starts_with("kp")
}

/// A syllabic nasal before a consonant at the start ("Nkechi", "Ngozi",
/// "Mbali"), which an English speaker voices with a vowel in front.
fn syllabic_nasal(word: &str) -> Option<String> {
    // Vietnamese "Nguyen" and "Nghiem" are not said with a vowel first.
    if word.starts_with("nguy") || word.starts_with("ngh") {
        return None;
    }
    let mut chars = word.chars();
    let first = chars.next()?;
    let second = chars.next()?;
    let opens = match first {
        'n' => "kgndtzjc".contains(second),
        'm' => "bpfvm".contains(second),
        _ => false,
    };
    (opens && chars.next().is_some_and(|ch| ch.is_alphabetic())).then(|| format!("e{word}"))
}

const HUNGARIAN: &[Rule] = &[
    Rule("sz", "s", At::Any),
    Rule("zs", "zh", At::Any),
    Rule("cs", "ch", At::Any),
    Rule("gy", "dj", At::Any),
    Rule("ly", "y", At::Any),
    Rule("s", "sh", At::Any),
    Rule("j", "y", At::Any),
];

fn is_hungarian(word: &str) -> bool {
    has_any(word, "őű") || (has_any_of(word, &["gy", "zs", "cs"]) && !is_polish(word))
}

const SPANISH_BASQUE: &[Rule] = &[
    Rule("ñ", "ny", At::Any),
    Rule("tx", "ch", At::Any),
    Rule("tz", "ts", At::Any),
    Rule("j", "h", At::Any),
];

fn is_spanish_basque(word: &str) -> bool {
    word.contains('ñ') || has_any_of(word, &["tx", "tz"])
}

/// Dutch, German and Nordic spellings.
const GERMANIC: &[Rule] = &[
    Rule("sch", "sh", At::Any),
    Rule("sj", "sh", At::Start),
    Rule("oe", "oo", At::Any),
    Rule("ij", "ay", At::Any),
    Rule("j", "y", At::Start),
    Rule("w", "v", At::Start),
];

fn is_germanic(word: &str) -> bool {
    has_any(word, "äöüåøæ") || word.starts_with("sj") || has_any_of(word, &["aa", "kk", "ij"])
}

/// English respellings of `term`, folded, each different from the folded
/// term and from each other, best first.
pub(crate) fn respellings(term: &str) -> Vec<String> {
    let lower: String = term.nfc().flat_map(char::to_lowercase).collect();
    let words: Vec<&str> = lower.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    // (detects, rules, fold accents before the rules). Vietnamese rules read
    // the letters under the tone marks.
    type Family = (fn(&str) -> bool, &'static [Rule], bool);
    let families: [Family; 8] = [
        (is_polish, POLISH, false),
        (is_gaelic, GAELIC, false),
        (is_welsh, WELSH, false),
        (is_vietnamese, VIETNAMESE, true),
        (is_west_african, WEST_AFRICAN, false),
        (is_hungarian, HUNGARIAN, false),
        (is_spanish_basque, SPANISH_BASQUE, false),
        (is_germanic, GERMANIC, false),
    ];
    let plain = fold(term);
    let mut out: Vec<String> = Vec::new();
    let mut push = |candidate: String| {
        if !candidate.is_empty()
            && candidate != plain
            && !out.contains(&candidate)
            && out.len() < MAX_RESPELLINGS
        {
            out.push(candidate);
        }
    };
    for (applies, rules, fold_first) in &families {
        if !words.iter().any(|word| applies(word)) {
            continue;
        }
        let respelled: Vec<String> = words
            .iter()
            .map(|word| match (applies(word), fold_first) {
                (true, true) => fold(&rewrite(&fold(word), rules)),
                (true, false) => fold(&rewrite(word, rules)),
                (false, _) => fold(word),
            })
            .collect();
        push(respelled.join(" "));
    }
    let nasal: Vec<String> = words
        .iter()
        .map(|word| syllabic_nasal(&fold(word)).unwrap_or_else(|| fold(word)))
        .collect();
    push(nasal.join(" "));
    out
}

/// A sound key: the consonant skeleton of the folded text, with all words
/// run together.
pub(crate) fn sound_key(text: &str) -> String {
    crate::dictation_sounds_like::sound_skeleton(&fold(text).replace(' ', ""))
}

/// Runs of vowels in the folded text ("y" counts as a vowel): about the
/// number of syllables.
pub(crate) fn vowel_groups(text: &str) -> usize {
    let mut groups = 0;
    let mut in_vowel = false;
    for ch in fold(text).chars() {
        let vowel = matches!(ch, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
        if vowel && !in_vowel {
            groups += 1;
        }
        in_vowel = vowel;
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_accents_tone_marks_and_special_letters() {
        assert_eq!(fold("Quỳnh"), "quynh");
        assert_eq!(fold("Đà Nẵng"), "da nang");
        assert_eq!(fold("Łukasz"), "lukasz");
        assert_eq!(fold("Søren"), "soren");
        assert_eq!(fold("Adébáyọ̀"), "adebayo");
        assert_eq!(fold("Obiọma Nwankwọ"), "obioma nwankwo");
        assert_eq!(fold("Strauß"), "strauss");
        assert_eq!(fold("Jean-Luc O'Neill"), "jean luc oneill");
    }

    #[test]
    fn polish_respells_digraphs_and_special_letters() {
        assert_eq!(respellings("Szymon"), ["shimon"]);
        assert_eq!(respellings("Przemek"), ["pshemek"]);
        assert_eq!(respellings("Krzysztof"), ["kshishtof"]);
        assert_eq!(respellings("Łukasz"), ["wukash"]);
        assert_eq!(respellings("Wojciech Kowalczyk"), ["wojciech kovalchik"]);
    }

    #[test]
    fn gaelic_respells_lenition_and_broad_vowels() {
        assert_eq!(respellings("Niamh"), ["neev"]);
        assert_eq!(respellings("Aoife"), ["eefa"]);
        assert_eq!(respellings("Caoimhe"), ["keeva"]);
        assert_eq!(respellings("Saoirse"), ["seersha"]);
        assert_eq!(respellings("Siobhán"), ["shivawn"]);
        assert_eq!(respellings("Orlaith"), ["orla"]);
        assert_eq!(respellings("Darragh"), ["darra"]);
        assert_eq!(respellings("Ciarán"), ["kiarawn"]);
    }

    #[test]
    fn vietnamese_african_and_other_families_respell() {
        assert_eq!(respellings("Quỳnh"), ["quin"]);
        assert_eq!(respellings("Linh"), ["lin"]);
        assert_eq!(respellings("Thủy"), ["twee"]);
        assert_eq!(respellings("Phương"), ["fuong"]);
        assert_eq!(respellings("Nkechi"), ["enkechi"]);
        assert_eq!(respellings("Gbenga"), ["benga"]);
        assert_eq!(respellings("Olúwaṣeun"), ["oluwasheun"]);
        assert_eq!(respellings("Zsófia"), ["zhofia"]);
        assert_eq!(respellings("Iñaki"), ["inyaki"]);
        assert_eq!(respellings("Sjoerd"), ["shoord"]);
        assert_eq!(respellings("Eilidh"), ["aylee"]);
        assert_eq!(respellings("Dafydd"), ["davyth"]);
    }

    #[test]
    fn english_names_get_no_respelling() {
        for name in [
            "Simon",
            "Jonathan",
            "Priya",
            "Michael",
            "Dana",
            "Carla",
            "Supabase",
            "Kubernetes",
            "Vercel",
            "Shannon",
            "Ashley",
            "Matthew",
            "Chris",
            "Siddharth",
            "Abhishek",
            "Vaibhav",
            "Madhu",
            "Anirudh",
            "Xiao",
            "Zhao",
            "Freddie",
            "Todd",
            "Nguyen",
            "Aaron",
        ] {
            assert!(
                respellings(name).is_empty(),
                "{name}: {:?}",
                respellings(name)
            );
        }
    }

    #[test]
    fn sound_keys_match_across_transliteration() {
        assert_eq!(sound_key("Simon"), sound_key("Szymon"));
        assert_eq!(sound_key("Neve"), sound_key("neev"));
        assert_eq!(sound_key("Eva"), sound_key("eefa"));
        assert_eq!(sound_key("Quinn"), sound_key("quin"));
        assert_eq!(sound_key("Kieran"), sound_key("kiarawn"));
        assert_ne!(sound_key("Simon"), sound_key("Samuel"));
    }
}
