//! Local, deterministic disfluency cleanup for dictation, on by default.
//!
//! Removes the three things people notice first in raw speech-to-text, and
//! only in forms that cannot change what the speaker meant:
//!
//! 1. Hesitation sounds: um, umm, uh, uhh, uhm, and hm/hmm/hmmm where it
//!    opens a clause and is followed by a pause. Never "ah" (a real
//!    interjection), never ER (an acronym), never a quoted or all-caps word,
//!    and never lexical phrases such as "uh huh", "uh oh" or "uh uh",
//!    or er/err/erm, which are repair cues ("John, erm, Jim") that
//!    `dictation_fidelity::resolve_spoken_repairs` handles.
//! 2. Stutters: an immediately repeated function word with no punctuation
//!    between ("the the", "I I"). Content words and real doubles ("had had",
//!    "that that") and repeated answers ("Agreed. Agreed.") are kept.
//! 3. Typed self-corrections: `<A> <cue> <B>` where A and B are the same kind
//!    of thing (weekday, month, number, time of day) and the cue is a repair
//!    phrase ("no wait", "sorry", "I mean", "actually", "or rather", "make
//!    that"). "Tuesday, no wait, Wednesday" becomes "Wednesday". When the two
//!    sides are not the same kind, nothing changes: an ambiguous repair stays
//!    visible rather than being guessed.
//! 4. Parallel self-corrections: after a pause and a strong cue, a phrase of
//!    two to five words that restates the same number of words just before
//!    the cue, starting with the same word and closing its clause: "config
//!    underscore v2.yaml, no wait, config underscore v3.yaml" keeps v3, "send
//!    it to Mark, no wait, to Priya" keeps "to Priya". Anything that does not
//!    line up, or that continues past the restatement, stays.
//!
//! Anything more ambitious (untyped repairs, dropping "you know") belongs to
//! the optional AI pass, whose output `dictation_fidelity::validate_cleanup`
//! still checks word by word.

/// Hesitation sounds with no other reading. Matched case-sensitively in
/// lowercase or sentence-case form so an all-caps "UM" is left alone.
/// "mhm" and "mm-hmm" mean yes, so they stay.
const HESITATIONS: &[&str] = &[
    "um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "hm", "hmm", "hmmm",
];

/// Thinking sounds that are also quoted or mentioned as words ("He said hmm
/// and left", "Type hmm in the box"). They count as a hesitation only where
/// one opens a clause and is followed by a pause: "Hmm, I'm not sure". Not
/// after a colon ("I texted her: hmm.") or a speech verb ("He said, hmm,
/// interesting."), and a dictation that is nothing but "Hmm?" is the
/// message.
const THINKING_SOUNDS: &[&str] = &["hm", "hmm", "hmmm"];

/// Answers and negations. A filler between two of them sits between clauses:
/// "I said no, um, never" keeps one comma, "I'm not, um, sure" none.
const CLAUSE_CLOSERS: &[&str] = &[
    "no", "not", "never", "nope", "nah", "yes", "yeah", "yep", "okay", "ok",
];

/// Subjects that open a new clause: "It's not, hmm, it is fine".
const CLAUSE_OPENERS: &[&str] = &[
    "i", "i'm", "i'll", "i'd", "i've", "you", "you're", "you'll", "you'd", "you've", "he", "he's",
    "he'll", "he'd", "she", "she's", "she'll", "she'd", "it", "it's", "it'll", "we", "we're",
    "we'll", "we'd", "we've", "they", "they're", "they'll", "they'd", "they've", "there",
    "there's",
];

/// Openers that are just as often objects ("I gave, um, it to Sam"): they
/// open a clause only before one of [`SUBJECT_VERBS`].
const OBJECT_OR_SUBJECT: &[&str] = &["it", "you"];

/// Auxiliaries and verbs that show "it" or "you" is a subject: "It's not,
/// hmm, it is fine".
const SUBJECT_VERBS: &[&str] = &[
    "is", "was", "'s", "will", "can", "should", "would", "might", "must", "has", "have", "had",
    "does", "did", "do", "are", "were", "'re", "'ll", "'d", "need", "needs", "works", "worked",
    "looks", "seems",
];

/// Verbs that introduce what someone said or wrote: after "said," a "hmm"
/// is being reported.
const SPEECH_VERBS: &[&str] = &[
    "say",
    "says",
    "said",
    "saying",
    "ask",
    "asks",
    "asked",
    "reply",
    "replies",
    "replied",
    "answer",
    "answers",
    "answered",
    "respond",
    "responds",
    "responded",
    "write",
    "writes",
    "wrote",
    "text",
    "texts",
    "texted",
    "type",
    "types",
    "typed",
    "message",
    "messaged",
    "go",
    "goes",
    "went",
    "add",
    "adds",
    "added",
    "mutter",
    "muttered",
    "whisper",
    "whispered",
    "sigh",
    "sighed",
];

/// Function words whose immediate repetition is a stutter, never grammar.
/// Deliberately excludes "that", "had", "is", "do" and every content word,
/// and words that double in real speech: "told you you were", "turn it on
/// on Monday", "come in in ten", "look at at least", "so so sorry", "will"
/// (also a name), "can" and "it".
const STUTTER_WORDS: &[&str] = &[
    "a", "an", "the", "to", "of", "for", "with", "and", "or", "but", "i", "we", "they", "he",
    "she", "my", "our", "your", "if",
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
    literal: bool,
    /// A hesitation sound used as a word: mentioned ("the word um"), reported
    /// ("she said uh, no") or another language's "um". Never removed.
    spoken_word: bool,
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
    let mut literal = None;
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
            literal: token_is_literal(token, lead_len, after, &mut literal),
            spoken_word: false,
        });
        rest = &after[ws_len..];
    }
    (leading_ws, pieces)
}

// Track whole quoted/code spans, including tokens that do not touch a marker.
// An unmatched opener protects the remainder rather than guessing its end.
fn token_is_literal(
    token: &str,
    lead_len: usize,
    after: &str,
    state: &mut Option<(char, usize)>,
) -> bool {
    let mut protected = state.is_some();
    let mut chars = token.char_indices().peekable();
    let mut backslashes = 0;
    let mut following_quote = [None, None];
    while let Some((index, ch)) = chars.next() {
        let escaped = backslashes % 2 == 1;
        backslashes = if ch == '\\' { backslashes + 1 } else { 0 };
        if escaped {
            continue;
        }
        let mut count = 1;
        if ch == '`' {
            while chars.peek().is_some_and(|(_, next)| *next == '`') {
                chars.next();
                count += 1;
            }
        }
        let closes = state.is_some_and(|(closing, opening_count)| {
            ch == closing
                && (count == opening_count
                    || (ch == '`' && opening_count >= 3 && count >= opening_count))
        });
        let previous = token[..index].chars().next_back();
        let apostrophe_in_word = closes
            && matches!(ch, '\'' | '’')
            && previous.is_some_and(char::is_alphanumeric)
            && (chars.peek().is_some_and(|(_, next)| next.is_alphanumeric())
                || (matches!(previous, Some('s' | 'S')) && {
                    let slot = usize::from(ch == '’');
                    *following_quote[slot].get_or_insert_with(|| next_quote_is_closer(after, ch))
                }));
        if closes && !apostrophe_in_word {
            protected = true;
            *state = None;
        } else if state.is_none()
            && (index < lead_len
                || ch == '`'
                || previous.is_some_and(|ch| matches!(ch, '=' | ':' | '(' | '[' | '{')))
        {
            let closing = match ch {
                '"' | '\'' | '`' => Some(ch),
                '“' => Some('”'),
                '‘' => Some('’'),
                _ => None,
            };
            if let Some(closing) = closing {
                protected = true;
                *state = Some((closing, count));
            }
        }
    }
    protected
}

// Distinguish a plural possessive inside a quotation from its closing marker.
fn next_quote_is_closer(text: &str, quote: char) -> bool {
    let mut previous = None;
    let mut slashes = 0;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == quote && slashes % 2 == 0 {
            let word_before = previous.is_some_and(char::is_alphanumeric);
            let word_after = chars.peek().is_some_and(|next| next.is_alphanumeric());
            if !(word_before && word_after) {
                return !word_after;
            }
        }
        slashes = if ch == '\\' { slashes + 1 } else { 0 };
        previous = Some(ch);
    }
    false
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
    if piece.literal || piece.spoken_word || !piece.lead.is_empty() || piece.core.is_empty() {
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

/// Words that name the sound right after them, so it is being talked about
/// rather than a pause: "The word uh is in the poem", "the phrase um carro",
/// "In German um means at".
const MENTION_NOUNS: &[&str] = &[
    "word",
    "words",
    "phrase",
    "term",
    "sound",
    "sounds",
    "syllable",
    "filler",
    "interjection",
    "letters",
    "english",
    "german",
    "portuguese",
    "spanish",
    "french",
    "italian",
    "dutch",
];

/// Verbs that can take the sound itself as their object: "Please write um
/// exactly", "Do not remove um from the transcript". They mark a mention
/// only when nothing else could be the object (see [`AFTER_MENTION`]), so
/// "I said um that we should wait" and "I'll write um a summary" keep their
/// hesitation.
const MENTION_VERBS: &[&str] = &[
    "say",
    "says",
    "said",
    "saying",
    "write",
    "writes",
    "wrote",
    "written",
    "writing",
    "type",
    "types",
    "typed",
    "typing",
    "spell",
    "spells",
    "spelled",
    "spelt",
    "spelling",
    "remove",
    "removes",
    "removed",
    "removing",
    "delete",
    "deletes",
    "deleted",
    "deleting",
    "called",
    "named",
    "transcribe",
    "transcribed",
];

/// One word that may stand between a mention verb and the sound: "write
/// down um", "remove any uh".
const MENTION_BRIDGES: &[&str] = &[
    "down", "out", "any", "every", "each", "all", "just", "only", "also",
];

/// Verbs of position before "with": "The sentence begins with um".
const POSITION_VERBS: &[&str] = &[
    "begins", "begin", "began", "starts", "start", "started", "ends", "end", "ended",
];

/// Words that can follow a sound that is a verb's whole object, but not a
/// hesitation before the real object: "write um exactly", "say um here",
/// "remove um from", "type um on the board".
const AFTER_MENTION: &[&str] = &[
    "exactly",
    "aloud",
    "verbatim",
    "literally",
    "correctly",
    "properly",
    "here",
    "there",
    "again",
    "instead",
    "too",
    "twice",
    "from",
    "into",
    "in",
    "on",
    "as",
];

/// A copula before the comma means the clause is still open: in "The answer
/// was, hmm, maybe" the sound is the answer, not a pause before a new clause.
const OPEN_CLAUSE_VERBS: &[&str] = &["is", "was", "are", "were", "be", "been", "am"];

/// Whether `pieces[index]`, a hesitation sound, is being talked about: it
/// follows a mention noun, or it is the whole object of a mention verb.
fn follows_mention_cue(pieces: &[Piece], index: usize) -> bool {
    let joined = |at: usize| {
        let piece = &pieces[at];
        !piece.literal
            && piece.lead.is_empty()
            && piece.punct.is_empty()
            && !piece.ws.contains('\n')
    };
    let word = |at: usize| pieces[at].lower().replace('’', "'");
    if index == 0 || !joined(index - 1) {
        return false;
    }
    if MENTION_NOUNS.contains(&word(index - 1).as_str()) {
        return true;
    }
    let after_verb = MENTION_VERBS.contains(&word(index - 1).as_str())
        || (index >= 2
            && joined(index - 2)
            && ((MENTION_BRIDGES.contains(&word(index - 1).as_str())
                && MENTION_VERBS.contains(&word(index - 2).as_str()))
                || (word(index - 1) == "with"
                    && POSITION_VERBS.contains(&word(index - 2).as_str()))));
    if !after_verb {
        return false;
    }
    // The sound has to be the whole object: it ends the sentence ("It is
    // called um."), is contrasted ("I said um, not uh") or runs into an
    // adverb or preposition ("write um exactly").
    let sound = &pieces[index];
    let next = pieces
        .get(index + 1)
        .filter(|next| !next.literal && next.lead.is_empty());
    sound.ends_sentence()
        || (sound.punct == "," && next.is_some_and(|next| next.lower() == "not"))
        || (sound.punct.is_empty()
            && next.is_some_and(|next| AFTER_MENTION.contains(&next.lower().as_str())))
}

/// Marks hesitation sounds that are words in this dictation, so no cleanup
/// stage removes them. Two readings:
///
/// - mentioned: after "the word" or a language name, or as the whole
///   object of "write", "say", "remove" and the like ("Please write um
///   exactly", but not "I said um that we should wait"). Once one sound in
///   a sentence is a mention, or a quoted "um" is, every sound in it is
///   ("No, I said um, not uh"; "Say 'um', not uh").
/// - another language's "um": a bare "um" running straight into the next
///   word is German "at" or Portuguese "a" when that word only follows
///   "um" in those languages ("um zehn Uhr", "um carro") or the dictation
///   has any German, Portuguese or other non-English word ("Wir kommen um
///   ..."). "Um, I think" and "Um so if we" stay hesitations.
fn mark_hesitations_used_as_words(pieces: &mut [Piece]) {
    let text = join_pieces("", pieces);
    let non_english = std::cell::OnceCell::new();
    let sound = |piece: &Piece| HESITATIONS.contains(&piece.lower().as_str());
    let mut sentence_start = 0;
    let mut sentence_mentions_a_sound = false;
    for index in 0..pieces.len() {
        let piece = &pieces[index];
        if piece.literal {
            // A sound quoted on its own ("Say 'um', not uh"), not one inside
            // a longer quotation.
            sentence_mentions_a_sound |= sound(piece)
                && !piece.lead.is_empty()
                && !piece.lead.contains('\\')
                && piece.punct.contains(['"', '\'', '”', '’', '`'])
                && (index == 0 || !pieces[index - 1].literal);
        } else if piece.lead.is_empty() && sound(piece) {
            if follows_mention_cue(pieces, index) {
                sentence_mentions_a_sound = true;
            }
            let next = pieces.get(index + 1);
            let other_language_um = piece.lower() == "um"
                && piece.punct.is_empty()
                && !piece.ws.contains('\n')
                && next.is_some_and(|next| {
                    !next.literal
                        && next.lead.is_empty()
                        && next.core.starts_with(char::is_alphabetic)
                        && (crate::text::language::follows_german_or_portuguese_um(&next.core)
                            || *non_english
                                .get_or_init(|| crate::text::language::has_non_english_word(&text)))
                });
            if other_language_um {
                pieces[index].spoken_word = true;
            }
        }
        if pieces[index].ends_sentence() || index + 1 == pieces.len() {
            if sentence_mentions_a_sound {
                for piece in &mut pieces[sentence_start..=index] {
                    if !piece.literal && sound(piece) {
                        piece.spoken_word = true;
                    }
                }
            }
            sentence_start = index + 1;
            sentence_mentions_a_sound = false;
        }
    }
}

fn capitalize_first(word: &mut String) {
    let mut chars = word.chars();
    if let Some(first) = chars.next() {
        if first.is_lowercase() {
            *word = first.to_uppercase().collect::<String>() + chars.as_str();
        }
    }
}

fn remove_hesitations(mut pieces: Vec<Piece>) -> Vec<Piece> {
    mark_hesitations_used_as_words(&mut pieces);
    // "Hmm?" on its own is the whole message.
    if !pieces.is_empty()
        && pieces
            .iter()
            .all(|piece| is_hesitation(piece) && THINKING_SOUNDS.contains(&piece.lower().as_str()))
    {
        return pieces;
    }
    let mut out: Vec<Piece> = Vec::with_capacity(pieces.len());
    let mut capitalize_next = false;
    let mut pieces = pieces.into_iter().peekable();
    while let Some(piece) = pieces.next() {
        let hesitation = is_hesitation(&piece)
            && (!THINKING_SOUNDS.contains(&piece.lower().as_str())
                || (out.last().is_none_or(|previous| {
                    previous.ends_sentence()
                        || previous.punct.ends_with(';')
                        || (previous.punct.ends_with(',')
                            && !SPEECH_VERBS.contains(&previous.lower().as_str())
                            && !OPEN_CLAUSE_VERBS.contains(&previous.lower().as_str()))
                }) && (piece
                    .punct
                    .starts_with([',', ';', '.', '!', '?', '\u{2026}'])
                    || pieces.peek().is_none())));
        // Agreement, alarm and refusal are words, not hesitation sounds.
        let lexical_pair = !piece.literal
            && piece.lower() == "uh"
            && (piece.punct.is_empty() || piece.punct == ",")
            && !piece.ws.contains(['\n', '\r'])
            && pieces.peek().is_some_and(|next| {
                !next.literal
                    && next.lead.is_empty()
                    && matches!(next.lower().as_str(), "huh" | "oh" | "uh")
            });
        if !hesitation || lexical_pair {
            let mut piece = piece;
            if capitalize_next && !piece.literal && piece.lead.is_empty() {
                capitalize_first(&mut piece.core);
            }
            capitalize_next = false;
            out.push(piece);
            if lexical_pair {
                out.push(pieces.next().expect("lexical pair has a second word"));
            }
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
                // "we went there uh." keeps its full stop, and "her: um."
                // does not become "her:.".
                let trimmed = previous.punct.trim_end_matches([',', ';', ':']).to_string();
                previous.punct = if trimmed.contains(['.', '!', '?']) {
                    trimmed
                } else {
                    trimmed + &terminal
                };
            } else if piece.punct.contains(',') && previous.punct.ends_with(',') {
                // "we should, uh, meet" -> "we should meet", but a comma after
                // an opening word ("Yes, uh, I agree") stays, and so does one
                // between clauses: before a new subject ("It's not, hmm, it
                // is fine") or between two answers ("I said no, um, never").
                // "It wasn't, um, Dana" and "I gave, um, it to Sam" lose it.
                let previous_lower = previous.lower().replace('’', "'");
                let previous_is_opener = out.len() == 1
                    || out
                        .get(out.len().wrapping_sub(2))
                        .is_some_and(Piece::ends_sentence);
                let mut ahead = pieces.clone();
                let (next, after_next) = (ahead.next(), ahead.next());
                let between_clauses = next.is_some_and(|next| {
                    let next_lower = next.lower().replace('’', "'");
                    next.lead.is_empty()
                        && ((CLAUSE_OPENERS.contains(&next_lower.as_str())
                            && (!OBJECT_OR_SUBJECT.contains(&next_lower.as_str())
                                || after_next.is_some_and(|after| {
                                    SUBJECT_VERBS
                                        .contains(&after.lower().replace('’', "'").as_str())
                                })))
                            || (CLAUSE_CLOSERS.contains(&previous_lower.as_str())
                                && CLAUSE_CLOSERS.contains(&next_lower.as_str())))
                });
                if !previous_is_opener && !between_clauses {
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
            if !previous.literal
                && !piece.literal
                && previous.punct.is_empty()
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
    /// A capitalized word inside a sentence: a person or a place ("Invite
    /// Carlos, I mean Carla"). See `name_at`.
    Name,
}

fn typed_class(piece: &Piece) -> Option<TypedClass> {
    if piece.literal || piece.core.is_empty() {
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

/// A single proper name: one capitalized, alphabetic word that does not
/// open its sentence (where every word is capitalized) and is not part of a
/// longer name ("Carlos Mendez"), not "I", and not an acronym ("QA").
/// Speech-to-text capitalizes names mid-sentence and little else.
fn name_at(pieces: &[Piece], index: usize) -> bool {
    let piece = &pieces[index];
    let mut chars = piece.core.chars();
    let opens_sentence = |at: usize| at == 0 || pieces[at - 1].ends_sentence();
    // "Carlos Mendez" is one name. A capitalized word that opens the
    // sentence is a name too unless it is a common opener ("Invite Carlos").
    let follows_name = index > 0 && {
        let previous = &pieces[index - 1];
        previous.punct.is_empty()
            && previous.core.starts_with(char::is_uppercase)
            && !(opens_sentence(index - 1) && SENTENCE_OPENERS.contains(&previous.lower().as_str()))
    };
    !piece.literal
        && piece.lead.is_empty()
        && !opens_sentence(index)
        && !follows_name
        && chars.next().is_some_and(char::is_uppercase)
        && piece.core.chars().count() >= 2
        && chars.all(char::is_lowercase)
        && typed_class(piece).is_none()
}

/// Sentence-opening words that are never the first half of a name.
const SENTENCE_OPENERS: &[&str] = &[
    "invite", "ask", "tell", "call", "email", "ping", "message", "text", "cc", "add", "remind",
    "thank", "thanks", "meet", "send", "let's", "visit", "book", "fly", "hi", "hello", "hey",
    "dear", "with", "from", "for", "to", "and", "but", "so", "then", "please", "maybe",
];

fn class_at(pieces: &[Piece], index: usize) -> Option<TypedClass> {
    typed_class(&pieces[index]).or_else(|| name_at(pieces, index).then_some(TypedClass::Name))
}

/// Prepositions a speaker repeats when restating a value: "to 4:30, no wait,
/// to five o'clock".
const RESTATED_PREPOSITIONS: &[&str] = &[
    "at", "on", "in", "by", "to", "from", "for", "until", "till", "around", "before", "after",
];

fn typed_lead_is_safe(piece: &Piece, class: TypedClass) -> bool {
    piece.lead.is_empty()
        || (class == TypedClass::Number
            && piece
                .lead
                .chars()
                .all(|ch| matches!(ch, '$' | '£' | '€' | '¥' | '+' | '-' | '−')))
}

/// Words that may follow a corrected value inside the same clause ("Wednesday
/// at 3"), used only when speech-to-text put a full stop before the cue.
const CONTINUATIONS: &[&str] = &[
    "at", "on", "in", "by", "from", "around", "after", "before", "and", "then", "please",
];

/// Time words that carry a sentence on past a corrected name: "Austin, or
/// rather Dallas, next month".
const NAME_TIME_CONTINUATIONS: &[&str] = &["next", "last", "this", "tomorrow", "today", "tonight"];

/// What "next", "last" and "this" modify in a time phrase.
const TIME_NOUNS: &[&str] = &[
    "week",
    "weekend",
    "month",
    "year",
    "quarter",
    "morning",
    "afternoon",
    "evening",
    "night",
    "time",
    "sprint",
    "spring",
    "summer",
    "fall",
    "autumn",
    "winter",
];

/// A time phrase at `at` that carries the sentence on past a corrected name
/// ("Dallas, next month.", "Sam, tomorrow at 3"). One followed by anything
/// else may open a new clause: in "Dana, I mean, Sam, today was your call"
/// Sam is spoken to, not swapped in.
fn time_phrase_continues(pieces: &[Piece], at: usize) -> bool {
    let plain = |piece: &Piece| !piece.literal && piece.lead.is_empty();
    let Some(first) = pieces.get(at).filter(|piece| plain(piece)) else {
        return false;
    };
    let lower = first.lower();
    if !NAME_TIME_CONTINUATIONS.contains(&lower.as_str()) {
        return false;
    }
    let end = if matches!(lower.as_str(), "next" | "last" | "this") {
        let modifies_time = first.punct.is_empty()
            && pieces.get(at + 1).is_some_and(|noun| {
                let noun_lower = noun.lower();
                plain(noun)
                    && (TIME_NOUNS.contains(&noun_lower.as_str())
                        || WEEKDAYS.contains(&noun_lower.as_str())
                        || MONTHS.contains(&noun_lower.as_str()))
            });
        if !modifies_time {
            return false;
        }
        at + 1
    } else {
        at
    };
    !pieces[end].punct.is_empty()
        || pieces.get(end + 1).is_none_or(|next| {
            let next_lower = next.lower();
            plain(next)
                && (CONTINUATIONS.contains(&next_lower.as_str())
                    || RESTATED_PREPOSITIONS.contains(&next_lower.as_str()))
        })
}

/// Returns (cue length, weak) when a repair cue starts at `index`.
fn cue_at(pieces: &[Piece], index: usize, reparandum: &Piece) -> Option<(usize, bool)> {
    REPAIR_CUES.iter().find_map(|(words, weak)| {
        let slice = pieces.get(index..index + words.len())?;
        let matches = slice
            .iter()
            .zip(words.iter())
            .all(|(piece, word)| !piece.literal && piece.lead.is_empty() && piece.lower() == *word);
        // Only the last cue word may carry punctuation other than a comma.
        let inner_clean = slice[..slice.len() - 1]
            .iter()
            .all(|piece| piece.punct.is_empty() || piece.punct == ",");
        let paused = reparandum.punct == ",";
        (matches && inner_clean && (!weak || paused)).then_some((words.len(), *weak))
    })
}

/// A spoken amount is one value. Replacing only its final word leaves
/// "twelve fifteen thousand" behind after "twelve thousand, sorry, fifteen thousand".
fn typed_value_end(pieces: &[Piece], start: usize, class: TypedClass) -> usize {
    let mut end = start;
    if class == TypedClass::Number {
        while pieces[end].punct.is_empty()
            && !pieces[end].ws.contains('\n')
            && end - start < 15
            && pieces.get(end + 1).is_some_and(|next| {
                next.lead.is_empty() && typed_class(next) == Some(TypedClass::Number)
            })
        {
            end += 1;
        }
        if end > start {
            let spoken = pieces[start..=end]
                .iter()
                .map(|piece| piece.core.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            end = start
                + crate::text::itn::spoken_cardinal_prefix_len(&spoken)
                    .unwrap_or(1)
                    .saturating_sub(1);
        }
    }
    end
}

// A replacement followed by a noun and an unknown tail may start a new
// clause: "at ten, sorry, five people are waiting". Noun modifiers can also
// carry a separate elliptical fact ("five people on hold"). A cue alone cannot
// establish that the old value was withdrawn. Keep ambiguous source wording.
fn replacement_opens_clause(pieces: &[Piece], value_end: usize) -> bool {
    let Some(subject) = pieces.get(value_end + 1) else {
        return false;
    };
    let Some(predicate) = pieces.get(value_end + 2) else {
        return false;
    };
    pieces[value_end].punct.is_empty()
        && !pieces[value_end].ws.contains('\n')
        && !subject.literal
        && subject.lead.is_empty()
        && matches!(subject.punct.as_str(), "" | ",")
        && !subject.ws.contains('\n')
        && subject.core.chars().all(char::is_alphabetic)
        && !CONTINUATIONS.contains(&subject.lower().as_str())
        && !predicate.literal
        && predicate.lead.is_empty()
        && predicate.core.chars().all(char::is_alphabetic)
}

fn resolve_parallel_repairs(mut pieces: Vec<Piece>) -> Vec<Piece> {
    const MAX_WORDS: usize = 5;
    let plain = |piece: &Piece| !piece.literal && !piece.ws.contains(['\n', '\r']);
    let mut cue_index = 1;
    while cue_index < pieces.len() {
        let paused = &pieces[cue_index - 1];
        let Some((cue_len, false)) = cue_at(&pieces, cue_index, paused) else {
            cue_index += 1;
            continue;
        };
        let repair_start = cue_index + cue_len;
        if paused.punct != "," || !matches!(pieces[repair_start - 1].punct.as_str(), "" | ",") {
            cue_index += 1;
            continue;
        }
        // The longest span that lines up word for word on both sides wins.
        let aligned = (2..=MAX_WORDS).rev().find(|&words| {
            let (Some(original), Some(repair)) = (
                cue_index
                    .checked_sub(words)
                    .map(|start| &pieces[start..cue_index]),
                pieces.get(repair_start..repair_start + words),
            ) else {
                return false;
            };
            let same = original
                .iter()
                .zip(repair)
                .filter(|(a, b)| a.lower() == b.lower())
                .count();
            // The restatement must close its clause: "two tables as well"
            // or "the old link was broken" continue past it and are not repairs.
            let closes_clause =
                !repair[words - 1].punct.is_empty() || repair_start + words == pieces.len();
            closes_clause
                && original[..words - 1]
                    .iter()
                    .all(|piece| piece.punct.is_empty())
                && repair[..words - 1]
                    .iter()
                    .all(|piece| piece.punct.is_empty())
                && original.iter().chain(repair).all(plain)
                && original[0].lower() == repair[0].lower()
                && same < words
                && same * 2 >= words
        });
        let Some(words) = aligned else {
            cue_index += 1;
            continue;
        };
        let start = cue_index - words;
        let lead = pieces[start].lead.clone();
        let capitalized = pieces[start].core.starts_with(char::is_uppercase)
            && (start == 0 || pieces[start - 1].ends_sentence());
        pieces.drain(start..repair_start);
        pieces[start].lead = lead;
        if capitalized {
            capitalize_first(&mut pieces[start].core);
        }
        cue_index = start + words;
    }
    pieces
}

fn resolve_typed_repairs(mut pieces: Vec<Piece>) -> Vec<Piece> {
    let mut index = 0;
    while index < pieces.len() {
        let Some(class) = class_at(&pieces, index) else {
            index += 1;
            continue;
        };
        let value_end = typed_value_end(&pieces, index, class);
        let cue_index = value_end + 1;
        // Speech-to-text often ends the sentence at the hesitation:
        // "Tuesday. No wait, Wednesday." A full stop counts as a pause, but
        // only before a strong cue (checked below).
        if !typed_lead_is_safe(&pieces[index], class)
            || !matches!(pieces[value_end].punct.as_str(), "" | "," | ".")
        {
            index = cue_index;
            continue;
        }
        let Some((cue_len, weak_cue)) = cue_at(&pieces, cue_index, &pieces[value_end]) else {
            index = cue_index;
            continue;
        };
        // A name is only replaced after a pause and a strong cue: "Carlos,
        // actually Carla" could be adding Carla, and without the pause the
        // cue may be part of the sentence.
        if class == TypedClass::Name && (weak_cue || pieces[value_end].punct != ",") {
            index = cue_index;
            continue;
        }
        let stopped_before_cue = pieces[value_end].punct == ".";
        if stopped_before_cue && weak_cue {
            index = cue_index;
            continue;
        }
        let repair_index = cue_index + cue_len;
        if pieces[index..repair_index]
            .iter()
            .any(|piece| piece.ws.contains(['\n', '\r']))
        {
            index = cue_index;
            continue;
        }
        let stopped_after_cue = pieces[repair_index - 1].punct == ".";
        let cue_last_punct_ok = matches!(pieces[repair_index - 1].punct.as_str(), "" | ",")
            || (stopped_after_cue
                && !weak_cue
                && !pieces[value_end..repair_index]
                    .iter()
                    .any(|piece| piece.ws.contains('\n')));
        // "to 4:30, no wait, to five o'clock": the restatement repeats the
        // preposition before the value. Both go, and the repeated one stays.
        let restated_preposition = index > 0
            && pieces[index - 1].punct.is_empty()
            && pieces[index - 1].lead.is_empty()
            && !pieces[index - 1].literal
            && RESTATED_PREPOSITIONS.contains(&pieces[index - 1].lower().as_str())
            && pieces.get(repair_index).is_some_and(|word| {
                !word.literal
                    && word.lead.is_empty()
                    && word.punct.is_empty()
                    && word.lower() == pieces[index - 1].lower()
            })
            && pieces
                .get(repair_index + 1)
                .is_some_and(|_| class_at(&pieces, repair_index + 1) == Some(class));
        let (drain_start, value_index) = if restated_preposition {
            (index - 1, repair_index + 1)
        } else {
            (index, repair_index)
        };
        // "sorry" is an apology as often as a repair ("I already told Dana,
        // sorry, Sam"), so it replaces a name only when the speaker restates
        // the preposition too: "to Mark, sorry, to Priya".
        if class == TypedClass::Name
            && cue_len == 1
            && pieces[cue_index].lower() == "sorry"
            && !restated_preposition
        {
            index = cue_index;
            continue;
        }
        let Some(repair) = pieces.get(value_index) else {
            index = cue_index;
            continue;
        };
        if !cue_last_punct_ok
            || !typed_lead_is_safe(repair, class)
            || class_at(&pieces, value_index) != Some(class)
        {
            index = cue_index;
            continue;
        }
        // "We invited ten, no one came": "no one" is a pronoun, not a
        // repair. Only "ten, no, one" (a pause after the cue) corrects.
        let cue = &pieces[repair_index - 1];
        if cue_len == 1 && cue.lower() == "no" && cue.punct.is_empty() && repair.lower() == "one" {
            index = cue_index;
            continue;
        }
        // After a full stop the cue might open an unrelated sentence ("It's
        // due Friday. I mean, Monday we start."), so the corrected value must
        // close its clause or lead straight into "at 3", "on the call", etc.
        let repair_end = typed_value_end(&pieces, value_index, class);
        if replacement_opens_clause(&pieces, repair_end) {
            index = cue_index;
            continue;
        }
        // A replacement name must close its clause or lead into "at 3", "on
        // the call": "Ask Dana, sorry, Sam knows" is two statements.
        if class == TypedClass::Name
            && pieces[repair_end].punct.is_empty()
            && !pieces.get(repair_end + 1).is_none_or(|next| {
                CONTINUATIONS.contains(&next.lower().as_str())
                    || RESTATED_PREPOSITIONS.contains(&next.lower().as_str())
            })
        {
            index = cue_index;
            continue;
        }
        // A comma after the new name closes the aside only when the sentence
        // carries on with a preposition, a time phrase or another cue, or
        // ends: in "I told Dana, I mean Sam, already knew" the name after the
        // cue is the subject of a new clause, and in "Sam, today was your
        // call" it is spoken to.
        if class == TypedClass::Name
            && pieces[repair_end].punct == ","
            && !pieces.get(repair_end + 1).is_none_or(|next| {
                let lower = next.lower();
                !next.literal
                    && next.lead.is_empty()
                    && (CONTINUATIONS.contains(&lower.as_str())
                        || RESTATED_PREPOSITIONS.contains(&lower.as_str())
                        || time_phrase_continues(&pieces, repair_end + 1)
                        || cue_at(&pieces, repair_end + 1, &pieces[repair_end]).is_some())
            })
        {
            index = cue_index;
            continue;
        }
        if (stopped_before_cue || stopped_after_cue)
            && pieces[repair_end].punct.is_empty()
            && !pieces
                .get(repair_end + 1)
                .is_some_and(|next| CONTINUATIONS.contains(&next.lower().as_str()))
        {
            index = cue_index;
            continue;
        }
        let reparandum = pieces[drain_start].clone();
        let paused_before_cue = pieces[value_end].punct == ",";
        let at_sentence_start = drain_start == 0 || pieces[drain_start - 1].ends_sentence();
        pieces.drain(drain_start..repair_index);
        let repair = &mut pieces[drain_start];
        if class != TypedClass::Number || repair.lead.is_empty() {
            repair.lead = reparandum.lead;
        }
        if at_sentence_start && reparandum.core.starts_with(char::is_uppercase) {
            capitalize_first(&mut repair.core);
        }
        // "Invite Carlos, I mean Carla, to the review": the comma after the
        // name closed the aside, so it goes with it when the sentence carries
        // straight on ("to the review", "at noon", "next month"). Before
        // another cue it stays. The same holds for a day or month ("Ask
        // May, I mean June, to approve it"); a number keeps its comma.
        let kept = value_index - (repair_index - drain_start);
        if class != TypedClass::Number && paused_before_cue && pieces[kept].punct == "," {
            let next_continues = pieces.get(kept + 1).is_some_and(|next| {
                let lower = next.lower();
                !next.literal
                    && next.lead.is_empty()
                    && next.core.starts_with(char::is_lowercase)
                    && (CONTINUATIONS.contains(&lower.as_str())
                        || RESTATED_PREPOSITIONS.contains(&lower.as_str())
                        || time_phrase_continues(&pieces, kept + 1))
            });
            if next_continues {
                pieces[kept].punct.clear();
            }
        }
        // Re-check from the kept word: "Monday, no, Tuesday, sorry, Friday".
    }
    pieces
}

/// Original byte ranges of tokens protected by the shared literal parser.
pub(crate) fn literal_token_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let (leading_ws, pieces) = split_pieces(text);
    let mut offset = leading_ws.len();
    let mut ranges = Vec::new();
    for piece in pieces {
        let token_end = offset + piece.lead.len() + piece.core.len() + piece.punct.len();
        if piece.literal {
            ranges.push(offset..token_end);
        }
        offset = token_end + piece.ws.len();
    }
    ranges
}

/// Hide literal spans from semantic checks without joining the surrounding clauses.
pub(crate) fn mask_literal_spans(text: &str) -> String {
    let (leading_ws, mut pieces) = split_pieces(text);
    for piece in &mut pieces {
        if piece.literal {
            piece.lead.clear();
            piece.core.clear();
            piece.punct = ".".into();
        }
    }
    join_pieces(&leading_ws, &pieces)
}

/// Remove hesitation sounds outside literal spans without resolving repairs
/// or collapsing repetitions. Used by source-to-output comparisons.
pub(crate) fn strip_hesitations_only(text: &str) -> String {
    let (leading_ws, pieces) = split_pieces(text);
    join_pieces(&leading_ws, &remove_hesitations(pieces))
        .trim()
        .to_string()
}

/// The default local cleanup. Idempotent, and a no-op on text that has no
/// hesitation, stutter or typed repair in it.
pub(crate) fn clean_disfluencies(text: &str) -> String {
    let (leading_ws, pieces) = split_pieces(text);
    let pieces = remove_hesitations(pieces);
    let pieces = collapse_stutters(pieces);
    let pieces = resolve_typed_repairs(pieces);
    let pieces = resolve_parallel_repairs(pieces);
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
    fn mentioned_and_reported_hesitations_are_words() {
        for input in [
            "Please write um exactly.",
            "Please write down um exactly.",
            "Do not remove any uh from the transcript.",
            "Do not remove um from the transcript.",
            "The word uh is in the poem.",
            "The word uh uh means no.",
            "Please say the word um aloud.",
            "The text should say um here.",
            "In German um zehn means at ten.",
            "The Portuguese phrase um carro means a car.",
            "The sentence begins with um.",
            "Please type um on the board.",
            "Spell uh exactly.",
            "It is called um.",
            "The answer was, hmm, maybe.",
            "No, I said um, not uh.",
            "Say 'um', not uh.",
            "The word um, not uh, is printed.",
        ] {
            assert_eq!(clean(input), input, "{input}");
            assert_eq!(super::strip_hesitations_only(input), input, "{input}");
        }
        assert_eq!(clean("Um, I think we should go."), "I think we should go.");
        // After a mention verb the sound is a hesitation when something else
        // is the object, and a diacritic loanword is still English.
        for (input, expected) in [
            (
                "I said um that we should wait.",
                "I said that we should wait.",
            ),
            (
                "I'll write um a summary tonight.",
                "I'll write a summary tonight.",
            ),
            (
                "Can you remove um the old files?",
                "Can you remove the old files?",
            ),
            ("I called um the office.", "I called the office."),
            ("The patient said uh, no.", "The patient said no."),
            ("The café um opens at nine.", "The café opens at nine."),
            (
                "I sent my résumé um yesterday.",
                "I sent my résumé yesterday.",
            ),
        ] {
            assert_eq!(clean(input), expected, "{input}");
        }
        // A pause after the cue makes the sound a hesitation again.
        assert_eq!(clean("Please write, um, exactly."), "Please write exactly.");
        assert_eq!(
            clean("I said, um, do not sign unless Dana approves."),
            "I said do not sign unless Dana approves."
        );
        assert_eq!(
            clean("It is, um, about five miles."),
            "It is about five miles."
        );
    }

    #[test]
    fn corrected_month_drops_the_aside_comma() {
        assert_eq!(
            clean("Ask May, I mean June, to approve it."),
            "Ask June to approve it."
        );
        assert_eq!(
            clean("We meet in May, I mean June, if it works."),
            "We meet in June, if it works."
        );
    }

    #[test]
    fn quoted_and_code_content_survives_every_cleanup_stage() {
        for literal in [
            "\"please um bring the the slides Tuesday no wait Wednesday\"",
            "'please uh bring the the slides Tuesday no wait Wednesday'",
            "“please um bring the the slides Tuesday no wait Wednesday”",
            "‘please uh bring the the slides Tuesday no wait Wednesday’",
            "`please um bring the the slides Tuesday no wait Wednesday`",
            "``please ` um bring the the slides Tuesday no wait Wednesday``",
            "```please\num bring the the slides Tuesday no wait Wednesday\n```",
            "\"please say \\\"um\\\" uh bring the the slides\"",
        ] {
            let input = format!("Um, write exactly {literal} and bring the the notes.");
            let expected = format!("Write exactly {literal} and bring the notes.");
            assert_eq!(clean(&input), expected, "{literal}");
            assert_eq!(clean(&expected), expected, "idempotence: {literal}");
        }
    }

    #[test]
    fn parallel_phrase_corrections_keep_the_restated_phrase() {
        for (input, expected) in [
            (
                "Rename config underscore v2.yaml, no wait, config underscore v3.yaml, then push it.",
                "Rename config underscore v3.yaml, then push it.",
            ),
            ("Send it to Mark, no wait, to Priya.", "Send it to Priya."),
            ("Use the blue theme, I mean, the green theme.", "Use the green theme."),
        ] {
            assert_eq!(clean(input), expected, "{input}");
            assert_eq!(clean(expected), expected, "idempotence: {input}");
        }
    }

    #[test]
    fn unaligned_or_ambiguous_corrections_stay_visible() {
        for input in [
            "It costs 20 dollars, no wait, I think it's 30.",
            "Go to the store, no wait, stay home.",
            "Use the red car, actually, the blue car.",
            "Send it to Mark no wait to Priya.",
            "Keep \"the red car, sorry, the blue car\" as written.",
            "Use the red car, sorry, the red car.",
            "We need the report by Friday, no wait, a draft is fine for now.",
            "The red button, sorry, the blue button works.",
            "I sent you the old file, sorry, the old link was broken.",
            "We need two chairs, sorry, two tables as well.",
            "We can ship on Monday, I mean, we can ship on Tuesday too if needed.",
        ] {
            assert_eq!(clean(input), input, "{input}");
        }
    }

    #[test]
    fn literal_boundaries_do_not_create_repairs_or_change_apostrophes() {
        for input in [
            "Tuesday 'no wait' Wednesday",
            "Tuesday no wait 'Wednesday'",
            "Tuesday 'ten' no wait Wednesday",
            "Keep \"the the\" the the notes.",
            "I can't tell John's story. It's theirs.",
            "Write \"um the the unfinished quote",
        ] {
            let expected = if input == "Keep \"the the\" the the notes." {
                "Keep \"the the\" the notes."
            } else {
                input
            };
            assert_eq!(clean(input), expected, "{input}");
        }
    }

    #[test]
    fn attached_quotes_possessives_and_longer_fences_are_protected() {
        for (input, expected) in [
            (
                "Write label=\"um the the\" and bring the the notes.",
                "Write label=\"um the the\" and bring the notes.",
            ),
            (
                "Write say:\"um the the\" and bring the the notes.",
                "Write say:\"um the the\" and bring the notes.",
            ),
            (
                "Keep 'the dogs' toys are the the best' and bring the the notes.",
                "Keep 'the dogs' toys are the the best' and bring the notes.",
            ),
            (
                "Keep 'don't um change the the slides' and bring the the notes.",
                "Keep 'don't um change the the slides' and bring the notes.",
            ),
            (
                "Keep 'the slides' and 'um the the names' and bring the the notes.",
                "Keep 'the slides' and 'um the the names' and bring the notes.",
            ),
            (
                "Write ```\num the the\n```` and bring the the notes.",
                "Write ```\num the the\n```` and bring the notes.",
            ),
        ] {
            assert_eq!(clean(input), expected, "{input}");
            assert_eq!(clean(expected), expected, "idempotence: {input}");
        }
    }

    #[test]
    fn possessives_before_punctuated_quote_end_keep_literal_words() {
        for punctuation in [".", "!", "?", ",", ";", " ", "}"] {
            for (open, close) in [("'", "'"), ("‘", "’")] {
                let input = format!("Keep {open}the dogs{close} toys are the the best{punctuation}{close} and bring the the notes.");
                let expected = format!("Keep {open}the dogs{close} toys are the the best{punctuation}{close} and bring the notes.");
                assert_eq!(clean(&input), expected, "{input}");
            }
        }
    }

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
            clean("Hmm, I'm not sure that, uh, that works."),
            "I'm not sure that that works."
        );
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
            "Send it to John, erm, Jim tomorrow.",
            "Mhm, that works.",
            "HMM is the model name.",
        ] {
            assert_eq!(clean(kept), kept);
        }
    }

    /// "hmm" is a hesitation only where it opens a clause before a pause;
    /// otherwise it is being quoted or mentioned.
    #[test]
    fn thinking_sounds_go_only_as_hesitations() {
        for (input, expected) in [
            ("Hmm, I'm not sure.", "I'm not sure."),
            ("Hm, let me check.", "Let me check."),
            ("Hmmm. Let's go.", "Let's go."),
            ("Okay, hmm.", "Okay."),
            ("I texted her: um.", "I texted her."),
        ] {
            assert_eq!(clean(input), expected, "{input}");
        }
        // Mid-sentence, between pauses, it goes exactly as "um" does.
        assert_eq!(
            clean("I think, hmm, we wait."),
            clean("I think, um, we wait.")
        );
        assert!(!clean("I think, hmm, we wait.").contains("hmm"));
        for kept in [
            "He said hmm and left.",
            "Type hmm in the box.",
            "Type hm in the box.",
            "He went hmmm at the end.",
            "Hmm I'm not sure.",
            // The whole dictation is the thinking sound.
            "Hmm.",
            "Hmm?",
            "Hmm!",
            "hmm.",
            // Content after a colon, or reported after a speech verb.
            "I texted her: hmm.",
            "Write: hmm, then a comma.",
            "Reply: hmm.",
            "He said, hmm, interesting.",
            "Type hmm.",
            "Say hmm, then stop.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
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
            // Grammatical doubles.
            "I told you you were right.",
            "Turn it on on Monday.",
            "Come in in ten minutes.",
            "Look at at least three.",
            "I'm so so sorry.",
            "Will will send it.",
            "Can can is a dance.",
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
        // Speech-to-text usually ends the sentence at the hesitation.
        assert_eq!(
            clean("Um, let's meet on Tuesday. No wait, Wednesday."),
            "Let's meet on Wednesday."
        );
        assert_eq!(
            clean("Let's meet on Tuesday. No, wait, Wednesday at 3."),
            "Let's meet on Wednesday at 3."
        );
        assert_eq!(clean("Call at 3. Sorry, 4."), "Call at 4.");
        assert_eq!(clean("We need ten, no, one."), "We need one.");
        for kept in [
            "Tuesday or Wednesday",
            "No problem on Tuesday.",
            "I said no to Tuesday.",
            "5 no 6",
            "I work Monday, actually I work Tuesday.",
            "Monday, actually.",
            "We may, actually, June works",
            "Tuesday, no wait, the meeting moved.",
            "It's due Friday. I mean, Monday we start.",
            "I work Monday. Actually, Tuesday too.",
            "We invited ten, no one came.",
            "At three, no one answered.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn named_people_and_places_are_corrected_after_a_strong_cue() {
        for (input, expected) in [
            (
                "Invite Carlos, I mean Carla, to the review.",
                "Invite Carla to the review.",
            ),
            (
                "Let's meet in Austin, or rather Dallas, next month.",
                "Let's meet in Dallas next month.",
            ),
            (
                "Send the deck to Mark, sorry, to Priya, by Friday.",
                "Send the deck to Priya by Friday.",
            ),
            ("Ask Dana, no wait, Sam at noon.", "Ask Sam at noon."),
            ("We went to Austin, or rather Dallas.", "We went to Dallas."),
            ("Invite Carlos, make that Carla.", "Invite Carla."),
            ("Invite Carlos, wait no, Carla.", "Invite Carla."),
            (
                "Fly to Boston, I mean Denver, then Dallas.",
                "Fly to Denver then Dallas.",
            ),
            (
                "Book Boston, I mean Denver, for Friday.",
                "Book Denver for Friday.",
            ),
            ("Ask Dana, no wait, Sam, no wait, Lee.", "Ask Lee."),
            ("Tell Dana, I mean Sam.", "Tell Sam."),
        ] {
            assert_eq!(clean(input), expected, "{input}");
            assert_eq!(clean(expected), expected, "idempotence: {input}");
        }
        for kept in [
            // A weak cue, or no pause, could be adding a person.
            "Invite Carlos, actually Carla, to the review.",
            "Invite Carlos I mean Carla to the review.",
            // The replacement starts a new statement.
            "Ask Dana, sorry, Sam knows.",
            // Part of a longer name.
            "Invite Carlos Mendez, sorry, Carla, to the review.",
            "Carlos Mendez, sorry, Carla, will join.",
            // Not names.
            "Ask the team, sorry, QA, to check.",
            "Ping Dana, sorry, I was away.",
            "Thanks, sorry, Dana.",
            "Ask Priya, sorry, Monday works.",
            "Tell Mark, no wait, tell Priya to send the invoice.",
            // "sorry" is an apology unless the preposition is restated.
            "Send the deck to Mark, sorry, Priya.",
            "I already told Dana, sorry, Sam.",
            "Thanks, Mark, sorry, Priya, I missed your message.",
            "Hi Mark, sorry Priya, I will get back to you both tomorrow.",
            // After a comma the new name may start the next clause, or be
            // one of a list.
            "I told Dana, I mean Sam, already knew.",
            "I'm not blaming Dana, I mean Sam, was the one who pushed it.",
            "Ask Carlos, I mean Carla, if she is free.",
            "Invite Carlos, I mean Carla, not Dana.",
            "Ask Dana, I mean Sam, whatever works.",
            "Ask Dana, I mean Sam, Lee, and Jo.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn a_restated_preposition_carries_the_corrected_value() {
        for (input, expected) in [
            (
                "Let's move the meeting from 3.15 to 4.30, no wait, to five o'clock.",
                "Let's move the meeting from 3.15 to five o'clock.",
            ),
            (
                "Meet on Tuesday, sorry, on Wednesday.",
                "Meet on Wednesday.",
            ),
            ("Call at 3, no wait, at 4 please.", "Call at 4 please."),
            ("Send it to Mark, sorry, to Priya.", "Send it to Priya."),
        ] {
            assert_eq!(clean(input), expected, "{input}");
            assert_eq!(clean(expected), expected, "idempotence: {input}");
        }
        for kept in [
            "The meeting is at ten, sorry, at five people are waiting.",
            "Meet on Tuesday, sorry, on the call.",
            "We meet at 3, no wait, in the lobby.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn strong_repair_cues_can_be_separate_sentences() {
        assert_eq!(
            clean("Let's meet on Tuesday. No, wait. Wednesday at three thirty."),
            "Let's meet on Wednesday at three thirty."
        );
        assert_eq!(clean("Call at 3. Sorry. 4."), "Call at 4.");
        for kept in [
            "It's due Friday. I mean. Monday we start.",
            "We invited ten. No. One came.",
            "Tuesday. No, wait.\nWednesday at three thirty.",
            "I work Monday. Actually. Tuesday too.",
            "\"Tuesday. No, wait. Wednesday at three thirty.\"",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn typed_repairs_preserve_paragraph_boundaries() {
        for source in [
            "First option Tuesday.\nSorry, Wednesday.",
            "First option Tuesday, sorry,\nWednesday.",
            "First option Tuesday, no\nwait, Wednesday.",
            "Call at 3.\nSorry, 4.",
            "Choose May, sorry,\r\nJune.",
        ] {
            assert_eq!(clean(source), source, "{source}");
        }
        assert_eq!(
            clean("First option Tuesday. Sorry, Wednesday."),
            "First option Wednesday."
        );
    }

    #[test]
    fn repair_cues_do_not_erase_values_before_a_new_subject_clause() {
        for source in [
            "The meeting is at ten, sorry, five people are waiting.",
            "The payment is ten, sorry, five people are waiting.",
            "The meeting is at ten, sorry, five people arrived.",
            "The meeting is at ten, sorry, five people waited.",
            "The meeting is at ten, sorry, five people called.",
            "The meeting is at ten, sorry, five people left.",
            "The meeting is at ten, sorry, five people on hold.",
            "The meeting is at ten, sorry, five people in danger.",
            "It costs twelve thousand, I mean, fifteen thousand people have arrived.",
            "We meet Tuesday, sorry, Wednesday we will leave.",
            "The deadline is Friday, no wait, Monday I can check.",
        ] {
            assert_eq!(clean(source), source, "{source}");
        }
        for (source, expected) in [
            (
                "We need twenty five, no wait, thirty six seats.",
                "We need thirty six seats.",
            ),
            (
                "The meeting is at ten, sorry, five.",
                "The meeting is at five.",
            ),
            (
                "We meet Tuesday, sorry, Wednesday at five.",
                "We meet Wednesday at five.",
            ),
        ] {
            assert_eq!(clean(source), expected, "{source}");
        }
    }

    #[test]
    fn numeric_repairs_replace_the_whole_spoken_amount() {
        for (spoken, expected) in [
            (
                "The budget is twelve thousand, sorry, fifteen thousand dollars.",
                "The budget is fifteen thousand dollars.",
            ),
            (
                "We need twenty five, no wait, thirty six seats.",
                "We need thirty six seats.",
            ),
            (
                "Twelve thousand, make that fifteen thousand, sorry, twenty thousand.",
                "Twenty thousand.",
            ),
            (
                "It costs twelve thousand. Sorry, fifteen thousand.",
                "It costs fifteen thousand.",
            ),
            ("Count five six, no wait seven.", "Count five seven."),
        ] {
            let result = clean(spoken);
            assert_eq!(result, expected, "{spoken}");
            assert_eq!(clean(&result), result);
        }
        for kept in [
            "The budget is twelve thousand dollars, sorry, fifteen thousand dollars.",
            "We invited twenty five, no one came.",
            "We have twelve thousand. I mean, fifteen thousand people live there.",
            "Twelve thousand and fifteen thousand.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn written_currency_repairs_keep_the_replacement_and_surrounding_facts() {
        assert_eq!(
            clean("The approved budget is 12,000, sorry, $15,000. Do not approve the payment until Margas confirms the invoice."),
            "The approved budget is $15,000. Do not approve the payment until Margas confirms the invoice."
        );
        assert_eq!(clean("$12,000. Sorry, $15,000."), "$15,000.");
        assert_eq!(
            clean("The balance is -$12,000, sorry, -$15,000, and invoice 42 is unchanged."),
            "The balance is -$15,000, and invoice 42 is unchanged."
        );
        for (spoken, expected) in [
            ("$12,000, sorry, 15,000.", "$15,000."),
            ("-$12,000, sorry, 15,000.", "-$15,000."),
            ("$12,000, sorry, €15,000.", "€15,000."),
            ("-$12,000, sorry, +$15,000.", "+$15,000."),
            ("12,000, sorry, 15,000.", "15,000."),
        ] {
            assert_eq!(clean(spoken), expected, "{spoken}");
        }

        for kept in [
            "The budget is $12,000 and invoice 15,000 is separate.",
            "$12,000. Sorry, the estimate changed.",
            "Do not approve $12,000 until Margas confirms invoice 15,000.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
    }

    #[test]
    fn a_name_before_a_new_clause_is_not_swapped() {
        for kept in [
            "Don't blame Dana, I mean, Sam, today was your call.",
            "Great job with Dana, I mean, Sam, last night was amazing.",
            "Thanks Dana, I mean, Sam, this is great.",
            "I already invited Dana, sorry Sam, next time.",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
        for (input, expected) in [
            (
                "Let's meet in Austin, or rather Dallas, next month.",
                "Let's meet in Dallas next month.",
            ),
            (
                "Call Dana, I mean, Sam, tomorrow at 3.",
                "Call Sam tomorrow at 3.",
            ),
        ] {
            assert_eq!(clean(input), expected, "{input}");
        }
    }

    #[test]
    fn a_filler_between_clauses_leaves_one_comma() {
        for (input, expected) in [
            ("It's not, hmm, it is fine.", "It's not, it is fine."),
            ("I said no, um, never.", "I said no, never."),
            ("It isn't, uh, we checked.", "It isn't, we checked."),
            ("I think, um, we wait.", "I think, we wait."),
            // Inside a clause the comma still goes.
            ("We should, uh, meet.", "We should meet."),
            // A negation or an answer is not a clause break by itself: the
            // comma goes unless a new subject or another answer follows.
            ("It wasn't, um, Dana.", "It wasn't Dana."),
            ("It's not, uh, Sam's fault.", "It's not Sam's fault."),
            ("I don't, um, know.", "I don't know."),
            ("I'm not, um, sure.", "I'm not sure."),
            ("I'm not, uh, sure.", "I'm not sure."),
            (
                "We shouldn't, um, ship Friday.",
                "We shouldn't ship Friday.",
            ),
            ("Do not, um, email Dana.", "Do not email Dana."),
            ("I never, um, said that.", "I never said that."),
            ("That's okay, um, with me.", "That's okay with me."),
            ("Say yes, um, to the offer.", "Say yes to the offer."),
            // "it" and "you" open a clause only before a verb.
            ("I gave, um, it to Sam.", "I gave it to Sam."),
            ("Talk to, um, you later.", "Talk to you later."),
            ("It's not, uh, it was Sam.", "It's not, it was Sam."),
            (
                "I like it, it's, uh, really clean.",
                "I like it, it's really clean.",
            ),
        ] {
            assert_eq!(clean(input), expected, "{input}");
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
