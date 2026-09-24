//! Local, deterministic disfluency cleanup for dictation, on by default.
//!
//! Removes the three things people notice first in raw speech-to-text, and
//! only in forms that cannot change what the speaker meant:
//!
//! 1. Hesitation sounds: um, umm, uh, uhh, uhm, erm. Never "ah" (a real
//!    interjection), never ER (an acronym), never a quoted or all-caps word.
//! 2. Stutters: an immediately repeated function word with no punctuation
//!    between ("the the", "I I"). Content words and real doubles ("had had",
//!    "that that") and repeated answers ("Agreed. Agreed.") are kept.
//! 3. Typed self-corrections: `<A> <cue> <B>` where A and B are the same kind
//!    of thing (weekday, month, number, time of day) and the cue is a repair
//!    phrase ("no wait", "sorry", "I mean", "actually", "or rather", "make
//!    that"). "Tuesday, no wait, Wednesday" becomes "Wednesday". When the two
//!    sides are not the same kind, nothing changes: an ambiguous repair stays
//!    visible rather than being guessed.
//!
//! Anything more ambitious (untyped repairs, dropping "you know") belongs to
//! the optional AI pass, whose output `dictation_fidelity::validate_cleanup`
//! still checks word by word.

/// Hesitation sounds with no other reading. Matched case-sensitively in
/// lowercase or sentence-case form so an all-caps "UM" is left alone.
const HESITATIONS: &[&str] = &["um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "erm"];

/// Function words whose immediate repetition is a stutter, never grammar.
/// Deliberately excludes "that", "had", "is", "do" and every content word.
const STUTTER_WORDS: &[&str] = &[
    "a", "an", "the", "to", "of", "for", "with", "and", "or", "but", "i", "we", "you", "they",
    "he", "she", "it", "my", "our", "your", "in", "on", "at", "so", "if", "can", "will",
];

/// Repair cues, longest first. `weak` cues are ordinary words too, so they
/// count only when the speaker paused (a comma) right before them.
const REPAIR_CUES: &[(&[&str], bool)] = &[
    (&["no", "wait"], false),
    (&["wait", "no"], false),
    (&["or", "rather"], false),
    (&["make", "that"], false),
    (&["i", "mean"], false),
    (&["sorry"], false),
    (&["actually"], true),
    (&["no"], true),
];

const WEEKDAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
const MONTHS: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const DAYPARTS: &[&str] = &[
    "today",
    "tomorrow",
    "tonight",
    "yesterday",
    "morning",
    "afternoon",
    "evening",
    "noon",
    "midnight",
];
const NUMBER_WORDS: &[&str] = &[
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
];

#[derive(Debug, Clone, PartialEq)]
struct Piece {
    lead: String,
    core: String,
    punct: String,
    ws: String,
}

impl Piece {
    fn lower(&self) -> String {
        self.core.to_lowercase()
    }

    fn ends_sentence(&self) -> bool {
        self.punct.contains(['.', '!', '?']) || self.ws.contains('\n')
    }
}

fn split_pieces(text: &str) -> (String, Vec<Piece>) {
    let leading_ws: String = text.chars().take_while(|ch| ch.is_whitespace()).collect();
    let mut pieces = Vec::new();
    let mut rest = &text[leading_ws.len()..];
    while !rest.is_empty() {
        let token_len = rest
            .char_indices()
            .find(|(_, ch)| ch.is_whitespace())
            .map_or(rest.len(), |(index, _)| index);
        let token = &rest[..token_len];
        let after = &rest[token_len..];
        let ws_len = after
            .char_indices()
            .find(|(_, ch)| !ch.is_whitespace())
            .map_or(after.len(), |(index, _)| index);
        let lead_len = token
            .char_indices()
            .find(|(_, ch)| ch.is_alphanumeric())
            .map_or(token.len(), |(index, _)| index);
        let body = &token[lead_len..];
        let core_len = body
            .char_indices()
            .rev()
            .find(|(_, ch)| ch.is_alphanumeric())
            .map_or(0, |(index, ch)| index + ch.len_utf8());
        pieces.push(Piece {
            lead: token[..lead_len].to_string(),
            core: body[..core_len].to_string(),
            punct: body[core_len..].to_string(),
            ws: after[..ws_len].to_string(),
        });
        rest = &after[ws_len..];
    }
    (leading_ws, pieces)
}

fn join_pieces(leading_ws: &str, pieces: &[Piece]) -> String {
    let mut out = leading_ws.to_string();
    for piece in pieces {
        out.push_str(&piece.lead);
        out.push_str(&piece.core);
        out.push_str(&piece.punct);
        out.push_str(&piece.ws);
    }
    out
}

fn is_hesitation(piece: &Piece) -> bool {
    if !piece.lead.is_empty() || piece.core.is_empty() {
        return false;
    }
    let lower = piece.lower();
    if !HESITATIONS.contains(&lower.as_str()) {
        return false;
    }
    // Lowercase or sentence case only: "UM" may be an acronym.
    let mut chars = piece.core.chars();
    let first = chars.next();
    first.is_some_and(|ch| ch.is_lowercase() || ch.is_uppercase()) && chars.all(char::is_lowercase)
}

fn capitalize_first(word: &mut String) {
    let mut chars = word.chars();
    if let Some(first) = chars.next() {
        if first.is_lowercase() {
            *word = first.to_uppercase().collect::<String>() + chars.as_str();
        }
    }
}

fn remove_hesitations(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::with_capacity(pieces.len());
    let mut capitalize_next = false;
    for piece in pieces {
        if !is_hesitation(&piece) {
            let mut piece = piece;
            if capitalize_next && piece.lead.is_empty() {
                capitalize_first(&mut piece.core);
            }
            capitalize_next = false;
            out.push(piece);
            continue;
        }
        let at_sentence_start = out.last().is_none_or(Piece::ends_sentence);
        let terminal: String = piece
            .punct
            .chars()
            .filter(|ch| matches!(ch, '.' | '!' | '?'))
            .collect();
        let newlines: String = piece.ws.chars().filter(|ch| *ch == '\n').collect();
        if let Some(previous) = out.last_mut() {
            if !terminal.is_empty() {
                // "we went there uh." keeps its full stop.
                let trimmed = previous.punct.trim_end_matches(',').to_string();
                previous.punct = if trimmed.contains(['.', '!', '?']) {
                    trimmed
                } else {
                    trimmed + &terminal
                };
            } else if piece.punct.contains(',') && previous.punct.ends_with(',') {
                // "we should, uh, meet" -> "we should meet", but a comma after
                // an opening word ("Yes, uh, I agree") stays.
                let previous_is_opener = out.len() == 1
                    || out
                        .get(out.len().wrapping_sub(2))
                        .is_some_and(Piece::ends_sentence);
                if !previous_is_opener {
                    let previous = out.last_mut().expect("checked above");
                    previous.punct.pop();
                }
            }
            if !newlines.is_empty() {
                let previous = out.last_mut().expect("checked above");
                previous.ws = newlines;
            }
        }
        let first_is_upper = piece.core.chars().next().is_some_and(char::is_uppercase);
        if at_sentence_start && (first_is_upper || !terminal.is_empty()) {
            capitalize_next = true;
        }
        if !terminal.is_empty() && out.last().is_some() {
            capitalize_next = true;
        }
    }
    out
}

fn collapse_stutters(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::with_capacity(pieces.len());
    for piece in pieces {
        if let Some(previous) = out.last_mut() {
            let lower = piece.lower();
            if previous.punct.is_empty()
                && !previous.ws.contains('\n')
                && previous.lead.is_empty()
                && piece.lead.is_empty()
                && previous.lower() == lower
                && STUTTER_WORDS.contains(&lower.as_str())
            {
                previous.punct = piece.punct;
                previous.ws = piece.ws;
                continue;
            }
        }
        out.push(piece);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TypedClass {
    Weekday,
    Month,
    Number,
    Daypart,
}

fn typed_class(piece: &Piece) -> Option<TypedClass> {
    if piece.core.is_empty() {
        return None;
    }
    let lower = piece.lower();
    if WEEKDAYS.contains(&lower.as_str()) {
        return Some(TypedClass::Weekday);
    }
    // Months only when capitalized: "may", "march" and "august" are words.
    if MONTHS.contains(&lower.as_str()) && piece.core.starts_with(char::is_uppercase) {
        return Some(TypedClass::Month);
    }
    if DAYPARTS.contains(&lower.as_str()) {
        return Some(TypedClass::Daypart);
    }
    if piece.core.starts_with(|ch: char| ch.is_ascii_digit())
        || NUMBER_WORDS.contains(&lower.as_str())
    {
        return Some(TypedClass::Number);
    }
    None
}

/// Returns (cue length) when a repair cue starts at `index`.
fn cue_at(pieces: &[Piece], index: usize, reparandum: &Piece) -> Option<usize> {
    REPAIR_CUES.iter().find_map(|(words, weak)| {
        let slice = pieces.get(index..index + words.len())?;
        let matches = slice
            .iter()
            .zip(words.iter())
            .all(|(piece, word)| piece.lead.is_empty() && piece.lower() == *word);
        // Only the last cue word may carry punctuation other than a comma.
        let inner_clean = slice[..slice.len() - 1]
            .iter()
            .all(|piece| piece.punct.is_empty() || piece.punct == ",");
        let paused = reparandum.punct == ",";
        (matches && inner_clean && (!weak || paused)).then_some(words.len())
    })
}

fn resolve_typed_repairs(mut pieces: Vec<Piece>) -> Vec<Piece> {
    let mut index = 0;
    while index < pieces.len() {
        let Some(class) = typed_class(&pieces[index]) else {
            index += 1;
            continue;
        };
        if !matches!(pieces[index].punct.as_str(), "" | ",") {
            index += 1;
            continue;
        }
        let Some(cue_len) = cue_at(&pieces, index + 1, &pieces[index]) else {
            index += 1;
            continue;
        };
        let repair_index = index + 1 + cue_len;
        let cue_last_punct_ok = matches!(pieces[repair_index - 1].punct.as_str(), "" | ",");
        let Some(repair) = pieces.get(repair_index) else {
            index += 1;
            continue;
        };
        if !cue_last_punct_ok || !repair.lead.is_empty() || typed_class(repair) != Some(class) {
            index += 1;
            continue;
        }
        let reparandum = pieces[index].clone();
        let at_sentence_start = index == 0 || pieces[index - 1].ends_sentence();
        pieces.drain(index..repair_index);
        let repair = &mut pieces[index];
        repair.lead = reparandum.lead;
        if at_sentence_start && reparandum.core.starts_with(char::is_uppercase) {
            capitalize_first(&mut repair.core);
        }
        // Re-check from the kept word: "Monday, no, Tuesday, sorry, Friday".
    }
    pieces
}

/// The default local cleanup. Idempotent, and a no-op on text that has no
/// hesitation, stutter or typed repair in it.
pub(crate) fn clean_disfluencies(text: &str) -> String {
    let (leading_ws, pieces) = split_pieces(text);
    let pieces = remove_hesitations(pieces);
    let pieces = collapse_stutters(pieces);
    let pieces = resolve_typed_repairs(pieces);
    let joined = join_pieces(&leading_ws, &pieces);
    if text.trim_end().len() < text.len() {
        joined
    } else {
        joined.trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::clean_disfluencies as clean;

    #[test]
    fn cleans_the_typical_messy_sentence_punctuated_or_not() {
        assert_eq!(
            clean("Um, so I think we should, uh, meet on Tuesday, no wait, Wednesday at 3 and bring the the slides."),
            "So I think we should meet on Wednesday at 3 and bring the slides."
        );
        assert_eq!(
            clean("um so I think we should uh meet on Tuesday no wait Wednesday at 3 and bring the the slides"),
            "so I think we should meet on Wednesday at 3 and bring the slides"
        );
    }

    #[test]
    fn hesitations_go_but_real_words_acronyms_and_quotes_stay() {
        assert_eq!(clean("Yes, uh, I agree."), "Yes, I agree.");
        assert_eq!(clean("We went there uh."), "We went there.");
        assert_eq!(clean("Um. Let's go."), "Let's go.");
        assert_eq!(
            clean("First point, um\nsecond point"),
            "First point,\nsecond point"
        );
        for kept in [
            "Ah, now I see.",
            "UM and ER are acronyms.",
            "Say 'um' out loud.",
            "I, like, agree.",
            "The ER, yellow ward.",
            "Humble umbrella.",
        ] {
            assert_eq!(clean(kept), kept);
        }
    }

    #[test]
    fn stutters_collapse_only_for_function_words_with_no_pause() {
        assert_eq!(clean("Bring the the slides"), "Bring the slides");
        assert_eq!(clean("I I think so"), "I think so");
        assert_eq!(clean("to to to the store"), "to the store");
        for kept in [
            "He had had enough.",
            "I know that that works.",
            "Agreed. Agreed.",
            "A. A. A.",
            "No no no.",
            "the, the thing",
            "very very good",
        ] {
            assert_eq!(clean(kept), kept);
        }
    }

    #[test]
    fn typed_repairs_replace_only_like_for_like() {
        assert_eq!(
            clean("Meet on Tuesday, sorry, Wednesday."),
            "Meet on Wednesday."
        );
        assert_eq!(
            clean("It costs 5, actually 6 dollars."),
            "It costs 6 dollars."
        );
        assert_eq!(
            clean("Call me tomorrow, I mean tonight."),
            "Call me tonight."
        );
        assert_eq!(
            clean("Ship it in March, or rather April."),
            "Ship it in April."
        );
        assert_eq!(
            clean("Monday, no, Tuesday, sorry, Friday works"),
            "Friday works"
        );
        assert_eq!(clean("at three no wait four"), "at four");
        assert_eq!(clean("Tuesday no wait Wednesday"), "Wednesday");
        for kept in [
            "Tuesday or Wednesday",
            "No problem on Tuesday.",
            "I said no to Tuesday.",
            "5 no 6",
            "I work Monday, actually I work Tuesday.",
            "Monday, actually.",
            "We may, actually, June works",
            "Tuesday, no wait, the meeting moved.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn is_idempotent_and_keeps_whitespace_shape() {
        let once = clean("Um, so, uh, the the plan is Friday, no wait, Monday.\nThanks");
        assert_eq!(clean(&once), once);
        assert_eq!(once, "So, the plan is Monday.\nThanks");
        assert_eq!(clean(""), "");
        assert_eq!(clean("   "), "   ");
    }
}
