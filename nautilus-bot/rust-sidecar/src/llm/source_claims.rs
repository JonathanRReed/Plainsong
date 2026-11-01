//! Claims checked against the source's structure rather than its commitments.
//!
//! - Commentary: a recap describes the meeting, not the transcript, the
//!   recording or how clearly something was said.
//! - Labels: a spoken heading or capture label names the recording or an
//!   agenda section. Words used only inside one name no product, owner or
//!   party, so a claim cannot use them.
//! - Actors: a person is the subject of a claim only for what that person
//!   says, does or commits to in the source, and a speech act ("proposes",
//!   "asked") only for what that person said.
//! - Numbers: a quantity keeps the words of its own source clause and any
//!   restriction attached to it ("$29 ... only with an annual contract").

use super::commitment_frames::{
    self as frames, condition_cue, content, date_at, is_subject, lemma, number_key, same_lemma,
    same_owner, tokens, without_disfluencies, Tok, MONTHS, STOPWORDS, WEEKDAYS,
};
use super::grounded::TrustedLine;
use std::collections::HashSet;

/// Words that describe the source, the process or its quality. A claim may
/// use one only when the source itself does.
const COMMENTARY: &[&str] = &[
    // The medium.
    "transcript",
    "transcripts",
    "transcription",
    "recording",
    "recordings",
    "recorded",
    "audio",
    "source",
    "sources",
    "passage",
    "passages",
    "excerpt",
    "excerpts",
    "line",
    "lines",
    "phrase",
    "phrases",
    "wording",
    "worded",
    "mention",
    "mentions",
    "reference",
    "references",
    "referenced",
    "repetition",
    "repetitions",
    "instance",
    "instances",
    "occurrence",
    "occurrences",
    "segment",
    "segments",
    "speaker",
    "speakers",
    "snippet",
    "verbatim",
    // The process.
    "reiterated",
    "reiterates",
    "restated",
    "restates",
    "repeated",
    "repeatedly",
    "repeats",
    "emphasized",
    "emphasised",
    "emphasizes",
    "highlighted",
    "highlights",
    "underscored",
    "stressed",
    "indicated",
    "indicates",
    "indicating",
    "outlined",
    "outlines",
    "documented",
    "discussed",
    "discusses",
    "discussion",
    "discussions",
    "conversation",
    "covered",
    "addressed",
    "touched",
    "focused",
    "focuses",
    "summarized",
    "summary",
    "recap",
    "overview",
    // Evaluation.
    "clearly",
    "clear",
    "explicitly",
    "explicit",
    "implicitly",
    "consistently",
    "consistent",
    "notably",
    "importantly",
    "significantly",
    "successfully",
    "effectively",
    "efficiently",
    "productive",
    "constructive",
    "well-defined",
    "defined",
    "sole",
    "solely",
    "criterion",
    "criteria",
    "resolution",
    "unresolved",
    "alternative",
    "alternatives",
    "overall",
    "key",
    "main",
    "primary",
    "crucial",
    "critical",
    "important",
    "essential",
    "various",
    "several",
    "multiple",
    "numerous",
    "responsibilities",
    "accountability",
];

/// Verbs that report speech. With a person as subject, the person must have
/// said the reported content.
const SPEECH: &[&str] = &[
    "say",
    "said",
    "says",
    "tell",
    "told",
    "tells",
    "ask",
    "asked",
    "asks",
    "propose",
    "proposed",
    "proposes",
    "suggest",
    "suggested",
    "suggests",
    "mention",
    "mentioned",
    "mentions",
    "note",
    "noted",
    "notes",
    "raise",
    "raised",
    "raises",
    "recommend",
    "recommended",
    "recommends",
    "request",
    "requested",
    "requests",
    "question",
    "questioned",
    "explain",
    "explained",
    "explains",
    "confirm",
    "confirmed",
    "confirms",
    "report",
    "reported",
    "reports",
    "state",
    "stated",
    "states",
    "wonder",
    "wondered",
    "wonders",
    "want",
    "wanted",
    "wants",
    "prefer",
    "preferred",
    "prefers",
    "think",
    "thinks",
    "thought",
    "believe",
    "believes",
    "believed",
    "argue",
    "argued",
    "argues",
    "express",
    "expressed",
    "expresses",
    "point",
    "pointed",
    "points",
    "clarify",
    "clarified",
    "clarifies",
    "correct",
    "corrected",
    "corrects",
    "warn",
    "warned",
    "warns",
    "insist",
    "insisted",
    "insists",
    "offer",
    "offered",
    "offers",
    "volunteer",
    "volunteered",
    "volunteers",
];

/// Words between a subject and its verb that carry no action of their own.
const AUXILIARY: &[&str] = &[
    "will",
    "would",
    "shall",
    "should",
    "must",
    "can",
    "could",
    "may",
    "might",
    "is",
    "are",
    "was",
    "were",
    "am",
    "be",
    "been",
    "being",
    "has",
    "have",
    "had",
    "do",
    "does",
    "did",
    "not",
    "never",
    "also",
    "still",
    "already",
    "then",
    "now",
    "just",
    "to",
    "going",
    "plans",
    "planned",
    "planning",
    "agreed",
    "agrees",
    "decided",
    "committed",
    "commits",
    "promised",
    "responsible",
    "for",
    "in",
    "charge",
    "of",
    "tasked",
    "with",
    "assigned",
    "expected",
    "supposed",
    "scheduled",
    "and",
    "personally",
    "first",
];

/// Prepositions before a name that make it an object, not a subject.
const OBJECT_MARKERS: &[&str] = &[
    "to",
    "by",
    "from",
    "with",
    "for",
    "of",
    "than",
    "about",
    "at",
    "on",
    "in",
    "between",
    "including",
    "like",
    "as",
    "via",
    "through",
    "toward",
    "towards",
];

const DETERMINERS: &[&str] = &[
    "the", "a", "an", "our", "my", "your", "their", "his", "her", "its", "this", "that", "these",
    "those", "all", "no", "every", "each", "any", "both",
];

const FINITE: &[&str] = &[
    "is", "are", "was", "were", "has", "have", "had", "will", "would", "must", "can", "could",
    "should", "may", "might", "shall", "stays", "stay", "remains", "remain", "ends", "end",
    "starts", "needs", "costs", "cost", "includes", "gets", "goes", "passed", "failed", "does",
    "do", "did", "am",
];

const PRONOUNS: &[&str] = &[
    "we", "i", "they", "he", "she", "it", "you", "there", "this", "that",
];

const OPENERS: &[&str] = &[
    "yes",
    "yeah",
    "okay",
    "so",
    "and",
    "but",
    "right",
    "sure",
    "correction",
    "actually",
    "well",
    "oh",
    "also",
    "then",
    "now",
    "please",
    "great",
    "thanks",
    "alright",
];

/// Does a clause start at `at`: a pronoun or name with an auxiliary, a
/// determiner phrase with a finite verb, a condition cue or an imperative.
fn clause_start(words: &[&Tok], at: usize) -> bool {
    let word = words[at].lower.as_str();
    let next = words.get(at + 1).map(|token| token.lower.as_str());
    let auxiliary = next.is_some_and(|next| FINITE.contains(&next) || next == "agreed");
    if (PRONOUNS.contains(&word) || is_subject(words[at])) && auxiliary {
        return true;
    }
    // "we need", "Cleo counted": a personal pronoun, or a name with a
    // past-tense verb, starts a clause.
    let past = next.is_some_and(|next| next.len() > 3 && next.ends_with("ed"));
    if words.get(at + 1).is_some()
        && (matches!(word, "we" | "i" | "they" | "he" | "she") || is_subject(words[at]) && past)
    {
        return true;
    }
    if DETERMINERS.contains(&word) {
        for length in 1..=3 {
            let verb = at + 1 + length;
            let Some(token) = words.get(verb) else {
                break;
            };
            let noun_phrase = words[at + 1..verb].iter().all(|token| {
                !STOPWORDS.contains(&token.lower.as_str())
                    && !token.end
                    && !token.comma
                    && !FINITE.contains(&token.lower.as_str())
            });
            if !noun_phrase {
                break;
            }
            if FINITE.contains(&token.lower.as_str()) {
                return true;
            }
        }
    }
    condition_cue(words, at).is_some() || matches!(word, "do" | "don't" | "let's")
}

/// A clause start in a run-on, including a bare noun phrase with a finite
/// verb: "... only with an annual contract monthly billing stays at $32".
fn run_on_clause_start(words: &[&Tok], at: usize) -> bool {
    clause_start(words, at)
        || (1..=2).any(|length| {
            let verb = at + length;
            words.get(verb).is_some_and(|token| {
                FINITE.contains(&token.lower.as_str())
                    && words[at..verb].iter().all(|token| {
                        let word = token.lower.as_str();
                        !STOPWORDS.contains(&word)
                            && !FINITE.contains(&word)
                            && !token.end
                            && !token.comma
                            && token_numbers(token).0.is_none()
                    })
            })
        })
}

fn has_finite(words: &[&Tok]) -> bool {
    words.iter().any(|token| {
        FINITE.contains(&token.lower.as_str())
            || matches!(token.lower.as_str(), "agreed" | "decided")
    })
}

/// One passage chain's cleaned tokens with the lines they came from.
struct Chain<'a> {
    tokens: Vec<Tok>,
    lines: Vec<&'a TrustedLine>,
    /// The chain opens after the same speaker's unfinished row.
    continues: bool,
}

fn chains<'a>(lines: &'a [TrustedLine], skip: &[bool]) -> Vec<Chain<'a>> {
    frames::passage_chains(lines, skip)
        .into_iter()
        .map(|chain| {
            let chained: Vec<&TrustedLine> = chain.iter().map(|at| &lines[*at]).collect();
            let mut words = Vec::new();
            for (index, line) in chained.iter().enumerate() {
                words.extend(tokens(&line.text, index));
            }
            let first = chain[0];
            let continues = (0..first)
                .rev()
                .find(|at| {
                    lines[*at].recording_id == lines[first].recording_id
                        && lines[*at].speaker_id == lines[first].speaker_id
                        && lines[*at].speaker_name == lines[first].speaker_name
                        && !frames::backchannel(&lines[*at].text)
                })
                .is_some_and(|at| !lines[at].text.trim_end().ends_with(['.', '!', '?']));
            Chain {
                tokens: without_disfluencies(words),
                lines: chained,
                continues,
            }
        })
        .collect()
}

fn sentence_ranges(words: &[&Tok]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (at, token) in words.iter().enumerate() {
        if token.end {
            out.push((start, at + 1));
            start = at + 1;
        }
    }
    if start < words.len() {
        out.push((start, words.len()));
    }
    out
}

/// Spoken labels: a short verbless phrase that opens a sentence before its
/// clause, or stands alone as a finished sentence. "Plainsong footprint
/// fixture, we agreed ..." and "Meeting record." are labels; "For Birch
/// Studio the plan is ..." opens with a preposition, and an unfinished
/// "The Alder desktop" row is a split clause.
fn label_phrases(chains: &[Chain<'_>], frames: &[frames::SourceFrame]) -> Vec<Vec<String>> {
    // (phrase, times detected, capitalized at least once)
    let mut found: Vec<(Vec<String>, usize, bool)> = Vec::new();
    for (phrase, capital) in heading_candidates(chains) {
        match found.iter_mut().find(|(known, _, _)| *known == phrase) {
            Some(entry) => {
                entry.1 += 1;
                entry.2 |= capital;
            }
            None => found.push((phrase, 1, capital)),
        }
    }
    // A heading that repeats, opens with a capital or ends in a colon stays a
    // heading even where a run-on swallowed it into a clause. A one-off
    // lowercase span may instead be a cut-off clause: inside a parsed
    // condition ("if the memory gate passes") it is not a heading.
    let conditions: Vec<Vec<Tok>> = frames
        .iter()
        .filter_map(|frame| frame.condition.as_deref())
        .map(|condition| tokens(condition, 0))
        .collect();
    found
        .into_iter()
        .filter(|(phrase, count, capital)| {
            *count >= 2
                || *capital
                || !conditions.iter().any(|condition| {
                    // Part of the clause ("if the memory gate passes"), not
                    // set off by a comma ("the set changes, rehearsal
                    // schedule, again").
                    (0..condition.len().saturating_sub(phrase.len() - 1)).any(|at| {
                        (0..phrase.len()).all(|k| condition[at + k].lower == phrase[k])
                            && (at == 0 || !condition[at - 1].comma)
                    })
                })
        })
        .map(|(phrase, _, _)| phrase)
        .collect()
}

/// Every heading-shaped span: (lowercase words, capitalized or colon).
fn heading_candidates(chains: &[Chain<'_>]) -> Vec<(Vec<String>, bool)> {
    let mut out = Vec::new();
    for chain in chains {
        let words: Vec<&Tok> = chain.tokens.iter().collect();
        let ranges = sentence_ranges(&words);
        for (index, &(start, end)) in ranges.iter().enumerate() {
            let sentence = &words[start..end];
            if sentence.iter().any(|token| token.question) {
                continue;
            }
            let open = sentence
                .iter()
                .take_while(|token| OPENERS.contains(&token.lower.as_str()))
                .count();
            let clause = (open..sentence.len()).find(|at| clause_start(sentence, *at));
            // "Pricing review, the quote from Fenwick ...": a heading may also
            // end at the first comma.
            let comma = (open..clause.unwrap_or(sentence.len()))
                .find(|at| sentence[*at].comma && *at + 1 < sentence.len())
                .map(|at| at + 1);
            // "Pricing review the quote from Fenwick.": a capitalized heading
            // with no punctuation ends where a determiner opens the next phrase.
            let determiner = sentence
                .get(open)
                .filter(|token| token.text.starts_with(char::is_uppercase))
                .and_then(|_| {
                    (open + 2..clause.unwrap_or(sentence.len())).find(|at| {
                        matches!(sentence[*at].lower.as_str(), "the" | "a" | "an" | "our")
                    })
                });
            let ends = std::iter::once(clause)
                .chain(comma.filter(|at| Some(*at) != clause).map(Some))
                .chain(
                    determiner
                        .filter(|at| Some(*at) != clause && Some(*at) != comma)
                        .map(Some),
                );
            for clause in ends {
                let span = &sentence[open..clause.unwrap_or(sentence.len())];
                let finished = clause.is_some()
                    || sentence
                        .last()
                        .is_some_and(|token| token.end || token.comma)
                    || index + 1 < ranges.len();
                // An item number may close a heading ("Agenda item two,
                // staffing"); a count before its noun ("60 seats") may not.
                let verbless = span.iter().enumerate().all(|(at, token)| {
                    let word = token.lower.as_str();
                    let item_number = number_key(word).is_some()
                        && at > 0
                        && (token.comma || at + 1 == span.len());
                    (!STOPWORDS.contains(&word) || word == "of")
                        && (number_key(word).is_none()
                            && !word.chars().any(|ch| ch.is_ascii_digit())
                            || item_number)
                        && !WEEKDAYS.contains(&word)
                        && !MONTHS.contains(&word)
                        && !FINITE.contains(&word)
                        && !SPEECH.contains(&word)
                });
                let first_is_noun = span
                    .first()
                    .is_some_and(|token| !STOPWORDS.contains(&token.lower.as_str()));
                // "gate passes." opening a row after an unfinished one ends a
                // clause; it is not a heading.
                let continuation = index == 0
                    && chain.continues
                    && span
                        .first()
                        .is_some_and(|token| !token.text.starts_with(char::is_uppercase));
                // One word is a heading only before a colon and a clause.
                let heading_word =
                    span.len() == 1 && span[0].colon && clause.is_some_and(|at| at > open);
                if !continuation
                    && ((2..=6).contains(&span.len()) || heading_word)
                    && finished
                    && verbless
                    && first_is_noun
                {
                    let phrase: Vec<String> =
                        span.iter().map(|token| token.lower.clone()).collect();
                    let capital = span[0].text.starts_with(char::is_uppercase)
                        || span.last().is_some_and(|token| token.colon);
                    out.push((phrase, capital));
                }
            }
        }
    }
    out
}

/// Headings certain without parsed clauses: repeated, capitalized or ending
/// in a colon. Clause parsing cuts at them, so a run-on cannot fold a
/// heading into a condition ("until Yusuf finishes the set changes
/// rehearsal schedule").
pub(super) fn strong_headings(lines: &[TrustedLine]) -> Vec<(Vec<String>, bool)> {
    let skip: Vec<bool> = lines.iter().map(|line| line.written_note).collect();
    let all = chains(lines, &skip);
    let mut found: Vec<(Vec<String>, usize, bool)> = Vec::new();
    for (phrase, capital) in heading_candidates(&all) {
        match found.iter_mut().find(|(known, _, _)| *known == phrase) {
            Some(entry) => {
                entry.1 += 1;
                entry.2 |= capital;
            }
            None => found.push((phrase, 1, capital)),
        }
    }
    found
        .into_iter()
        .filter(|(_, count, capital)| *count >= 2 || *capital)
        .map(|(phrase, _, _)| {
            let single = phrase.len() == 1;
            (phrase, single)
        })
        .collect()
}

/// A number-bearing claim or source unit: one clause's content words.
#[derive(Debug)]
struct Unit {
    words: Vec<String>,
    numbers: Vec<String>,
    /// The unit refers back with a pronoun or ends on a bare count ("the
    /// south bed has 2"); the previous unit is its context.
    pronoun: bool,
}

/// Number keys in a token, including "80-seat" style compounds.
fn token_numbers(token: &Tok) -> (Option<String>, Vec<String>) {
    if let Some(number) = number_key(&token.lower) {
        return (Some(number), Vec::new());
    }
    let mut parts = token.lower.split(['-', '/']);
    let first = parts.next().unwrap_or("");
    match number_key(first).filter(|_| first.chars().any(|ch| ch.is_ascii_digit())) {
        Some(number) => (Some(number), parts.map(lemma).collect()),
        None => (None, Vec::new()),
    }
}

/// Tokens inside a date phrase ("on the 14th", "March 6", "Friday").
fn date_mask(words: &[&Tok]) -> Vec<bool> {
    let mut mask = vec![false; words.len()];
    let mut at = 0;
    while at < words.len() {
        let preposition = at > 0
            && matches!(
                words[at - 1].lower.as_str(),
                "by" | "on" | "before" | "for" | "until" | "after" | "from" | "of"
            );
        // "on the 14 depends ..." and "on 14th": a day after a date
        // preposition is a date even where `date_at` reads a count.
        let day = |k: usize| {
            words.get(k).is_some_and(|token| {
                number_key(&token.lower)
                    .and_then(|n| n.parse::<u32>().ok())
                    .is_some_and(|n| (1..=31).contains(&n))
                    && (token.lower.ends_with("st")
                        || token.lower.ends_with("nd")
                        || token.lower.ends_with("rd")
                        || token.lower.ends_with("th")
                        || k > 0 && words[k - 1].lower == "the")
            })
        };
        match date_at(words, at) {
            Some((end, key))
                if preposition
                    || key.contains(' ')
                    || WEEKDAYS.contains(&key.as_str())
                    || words[at].lower == "the" =>
            {
                for flag in &mut mask[at..end.min(words.len())] {
                    *flag = true;
                }
                at = end;
            }
            _ if preposition && day(at) => {
                mask[at] = true;
                at += 1;
            }
            _ if preposition && words[at].lower == "the" && day(at + 1) => {
                mask[at] = true;
                mask[at + 1] = true;
                at += 2;
            }
            _ => at += 1,
        }
    }
    mask
}

/// Split tokens into clause units at sentence ends, commas, coordinators,
/// condition cues and new clauses. A verbless unit without a number (a
/// fronted "For Birch Studio" or a cut-off "The north") joins the next.
fn units(words: &[&Tok], names: &[String]) -> Vec<Unit> {
    let dates = date_mask(words);
    let mut bounds = vec![0];
    // Where the current clause began: a sentence end or a new clause.
    let mut clause = 0;
    for at in 1..words.len() {
        let previous = &words[at - 1];
        let word = words[at].lower.as_str();
        if previous.end {
            clause = at;
        }
        let restart =
            at > clause && run_on_clause_start(words, at) && has_finite(&words[clause..at]);
        if restart {
            clause = at;
        }
        let split = previous.end
            || previous.comma
            || matches!(word, "and" | "but" | "while" | "whereas" | "with" | "plus")
            || condition_cue(words, at).is_some()
            || restart;
        if split {
            bounds.push(at);
        }
    }
    bounds.push(words.len());
    let mut raw: Vec<(Vec<&Tok>, Vec<bool>)> = bounds
        .windows(2)
        .filter(|range| range[0] < range[1])
        .map(|range| {
            (
                words[range[0]..range[1]].to_vec(),
                dates[range[0]..range[1]].to_vec(),
            )
        })
        .collect();
    let mut merged: Vec<(Vec<&Tok>, Vec<bool>)> = Vec::new();
    let mut carry: Option<(Vec<&Tok>, Vec<bool>)> = None;
    for (tokens, mask) in raw.drain(..) {
        let (mut tokens, mut mask) = match carry.take() {
            Some((mut first, mut first_mask)) => {
                first.extend(tokens);
                first_mask.extend(mask);
                (first, first_mask)
            }
            None => (tokens, mask),
        };
        let numbered = tokens
            .iter()
            .zip(&mask)
            .any(|(token, date)| !date && token_numbers(token).0.is_some());
        if !numbered && !has_finite(&tokens) && !tokens.iter().any(|t| t.lower.ends_with("ed")) {
            // A fragment inside a sentence ("... $29 per seat with an annual
            // contract, and ...") closes the previous unit; one that opens a
            // sentence ("For Birch Studio, the plan is ...") opens the next.
            if let Some((last, last_mask)) = merged
                .last_mut()
                .filter(|(last, _)| last.last().is_some_and(|token| !token.end))
            {
                last.extend(tokens);
                last_mask.extend(mask);
                continue;
            }
            carry = Some((std::mem::take(&mut tokens), std::mem::take(&mut mask)));
            continue;
        }
        merged.push((tokens, mask));
    }
    if let Some(rest) = carry {
        merged.push(rest);
    }
    merged
        .into_iter()
        .map(|(tokens, mask)| {
            let mut numbers = Vec::new();
            let mut words = Vec::new();
            for (token, date) in tokens.iter().zip(&mask) {
                let (number, parts) = token_numbers(token);
                match number {
                    Some(number) if !date => {
                        numbers.push(number);
                        words.extend(parts);
                    }
                    Some(_) => {}
                    None => {
                        let lower = token.lower.as_str();
                        let bare = token.text.trim_end_matches("'s");
                        if *date
                            || STOPWORDS.contains(&lower)
                            || WEEKDAYS.contains(&lower)
                            || MONTHS.contains(&lower)
                            || names.iter().any(|name| same_owner(name, bare))
                        {
                            continue;
                        }
                        words.push(lemma(lower));
                    }
                }
            }
            let last = tokens
                .iter()
                .rposition(|token| !STOPWORDS.contains(&token.lower.as_str()));
            let elliptical = last.is_some_and(|at| {
                at > 0
                    && token_numbers(tokens[at]).0.is_some()
                    && !tokens[at].text.starts_with('$')
                    && matches!(
                        tokens[at - 1].lower.as_str(),
                        "has" | "have" | "had" | "is" | "are" | "was" | "were" | "got" | "gets"
                    )
            });
            Unit {
                pronoun: elliptical
                    || tokens.iter().any(|token| {
                        matches!(token.lower.as_str(), "it" | "they" | "them" | "its")
                    }),
                words,
                numbers,
            }
        })
        .collect()
}

/// Words a number claim may add without moving a fact: units and frames.
const NUMBER_GENERIC: &[&str] = &[
    "per",
    "total",
    "each",
    "about",
    "around",
    "currently",
    "current",
    "number",
    "count",
    "amount",
    "figure",
    "quantity",
    "price",
    "cost",
    "set",
    "stand",
    "listed",
    "budget",
];

/// Words that restate how a quantity is stated, not what it qualifies.
const QUANTITY_FRAME: &[&str] = &[
    "cost", "pric", "charg", "fee", "rate", "stay", "remain", "sit", "total", "overall", "apiece",
    "each", "per", "includ", "consist", "list", "record", "count", "tally", "number", "amount",
    "figur", "sum", "come", "add", "reach", "hav", "us", "exist", "current", "now", "new",
    "standard", "regular", "full", "base", "basic", "plan", "option",
];

/// A source clause restricting a quantity: "$29 per seat per month only with
/// an annual contract" restricts 29 to "annual contract".
struct Restriction {
    number: String,
    context: Vec<String>,
    terms: Vec<String>,
}

fn restrictions(chains: &[Chain<'_>]) -> Vec<Restriction> {
    let mut out = Vec::new();
    for chain in chains {
        let words: Vec<&Tok> = chain.tokens.iter().collect();
        let dates = date_mask(&words);
        // Clauses: sentence ends and new clauses after a finite verb.
        let mut bounds = vec![0];
        for at in 1..words.len() {
            let since = &words[*bounds.last().unwrap()..at];
            // The restriction runs to the next clause: "... only with an
            // annual contract monthly billing stays at $32".
            let restart = run_on_clause_start(&words, at)
                && has_finite(since)
                && !words[at - 1].lower.eq("only")
                && !since
                    .last()
                    .is_some_and(|t| STOPWORDS.contains(&t.lower.as_str()));
            if words[at - 1].end || restart {
                bounds.push(at);
            }
        }
        bounds.push(words.len());
        for range in bounds.windows(2) {
            let clause = &words[range[0]..range[1]];
            let mask = &dates[range[0]..range[1]];
            for at in 0..clause.len() {
                let word = clause[at].lower.as_str();
                let restrictive = word == "only"
                    && clause.get(at + 1).is_some_and(|next| {
                        matches!(
                            next.lower.as_str(),
                            "with"
                                | "for"
                                | "on"
                                | "in"
                                | "during"
                                | "under"
                                | "if"
                                | "when"
                                | "after"
                                | "at"
                                | "through"
                                | "until"
                                | "while"
                        )
                    })
                    || matches!(word, "except" | "excluding" | "unless" | "provided")
                    || word == "as" && clause.get(at + 1).is_some_and(|next| next.lower == "long");
                if !restrictive {
                    continue;
                }
                let end = (at + 1..clause.len())
                    .find(|k| clause[*k - 1].comma)
                    .unwrap_or(clause.len());
                let terms: Vec<String> = content(&clause[at + 1..end])
                    .into_iter()
                    .filter(|word| number_key(word).is_none() && word != "long")
                    .collect();
                if terms.is_empty() {
                    continue;
                }
                // The restriction follows the quantity it limits: "$29 per
                // seat per month only with ..." limits 29, not "80-seat".
                let context = content(&clause[..at]);
                let nearest = clause[..at]
                    .iter()
                    .zip(&mask[..at])
                    .rev()
                    .find_map(|(token, date)| (!date).then(|| token_numbers(token).0).flatten());
                if let Some(number) = nearest {
                    out.push(Restriction {
                        number,
                        context,
                        terms,
                    });
                }
            }
        }
    }
    out
}

fn refs_of(words: &[Tok]) -> Vec<&Tok> {
    words.iter().collect()
}

/// The source structures one summary or action claim is checked against.
pub(super) struct SourceClaims<'a> {
    lines: &'a [TrustedLine],
    names: Vec<String>,
    vocabulary: HashSet<String>,
    label_only: HashSet<String>,
    /// (person, lemmas of clauses the person is the subject of).
    actions: Vec<(String, HashSet<String>)>,
    /// (speaker, lemmas the speaker said).
    said: Vec<(String, HashSet<String>)>,
    units: Vec<Unit>,
    restrictions: Vec<Restriction>,
    /// Content lemmas of commitment predicates.
    tasks: HashSet<String>,
    /// Lemmas the source uses outside questions and suggestions.
    asserted: HashSet<String>,
    /// "We haven't approved the fog machine": (verb, object lemmas).
    negated: Vec<(String, Vec<String>)>,
    /// Lemmas the source uses inside a question or suggestion.
    tentative: HashSet<String>,
}

/// A question, a "whether" clause or a suggestion proposes; it commits to
/// nothing: "Could we also add offline search?", "I want to ask whether we
/// should mention the van", "I suggest we try standing desks".
fn tentative_sentence(words: &[&Tok]) -> bool {
    const MARKERS: &[&str] = &[
        "whether",
        "suggest",
        "suggests",
        "suggested",
        "suggestion",
        "idea",
        "wonder",
        "wondering",
        "asking",
        "question",
        "maybe",
        "perhaps",
    ];
    let open = words
        .iter()
        .take_while(|token| OPENERS.contains(&token.lower.as_str()))
        .count();
    words
        .iter()
        .any(|token| token.question || MARKERS.contains(&token.lower.as_str()))
        || words.get(open).is_some_and(|token| {
            matches!(
                token.lower.as_str(),
                "could" | "can" | "should" | "would" | "shall"
            )
        }) && words.get(open + 1).is_some_and(|token| {
            matches!(
                token.lower.as_str(),
                "we" | "you" | "i" | "someone" | "anyone"
            )
        })
}

impl<'a> SourceClaims<'a> {
    pub(super) fn new(
        lines: &'a [TrustedLine],
        frames: &[frames::SourceFrame],
        names: &[String],
    ) -> Self {
        let mut names = names.to_vec();
        for line in lines {
            if let Some(name) = &line.speaker_name {
                if !names.iter().any(|known| same_owner(known, name)) {
                    names.push(name.clone());
                }
            }
        }
        let skip: Vec<bool> = lines.iter().map(|line| line.written_note).collect();
        let all = chains(lines, &skip);
        // People the source makes subjects: "Tobias told me he called the
        // sponsors" names Tobias even though he never speaks.
        for chain in &all {
            let words: Vec<&Tok> = chain.tokens.iter().collect();
            for (at, token) in words.iter().enumerate() {
                let next = words[at + 1..]
                    .iter()
                    .find(|next| !matches!(next.lower.as_str(), "already" | "also" | "just"));
                let acts = next.is_some_and(|next| {
                    SPEECH.contains(&next.lower.as_str())
                        || next.lower.len() > 4 && next.lower.ends_with("ed")
                }) && !token.comma;
                if acts
                    && is_subject(token)
                    && !names.iter().any(|known| same_owner(known, &token.text))
                {
                    names.push(token.text.clone());
                }
            }
        }
        let vocabulary: HashSet<String> = all
            .iter()
            .flat_map(|chain| chain.tokens.iter())
            .flat_map(|token| [token.lower.clone(), lemma(&token.lower)])
            .collect();
        // Label words: every occurrence of a label phrase, or of two of its
        // words in order, is a label occurrence. A word used elsewhere is
        // not label-only.
        let phrases = label_phrases(&all, frames);
        let mut in_label: HashSet<String> = HashSet::new();
        let mut outside: HashSet<String> = HashSet::new();
        for chain in &all {
            let words = &chain.tokens;
            let mut label = vec![false; words.len()];
            for phrase in &phrases {
                // A one-word heading is a label where it keeps its colon.
                if let [word] = phrase.as_slice() {
                    for (at, token) in words.iter().enumerate() {
                        if token.colon && token.lower == *word {
                            label[at] = true;
                        }
                    }
                }
                for size in (2..=phrase.len()).rev() {
                    for part in phrase.windows(size) {
                        for at in 0..words.len().saturating_sub(size - 1) {
                            if (0..size).all(|k| words[at + k].lower == part[k]) {
                                for flag in &mut label[at..at + size] {
                                    *flag = true;
                                }
                            }
                        }
                    }
                }
            }
            for (token, labelled) in words.iter().zip(&label) {
                if STOPWORDS.contains(&token.lower.as_str()) {
                    continue;
                }
                let word = lemma(&token.lower);
                if *labelled {
                    in_label.insert(word);
                } else {
                    outside.insert(word);
                }
            }
        }
        // Words a parsed commitment uses name its task, never only a label,
        // unless the parsed clause itself swallowed the label.
        let committed: HashSet<String> = frames
            .iter()
            .flat_map(|frame| {
                [
                    frame.subject.as_str(),
                    frame.core.as_str(),
                    frame.condition.as_deref().unwrap_or(""),
                ]
            })
            .map(|text| tokens(text, 0))
            .filter(|words| {
                !phrases.iter().any(|phrase| {
                    phrase.windows(2).any(|pair| {
                        words
                            .windows(2)
                            .any(|window| window[0].lower == pair[0] && window[1].lower == pair[1])
                    })
                })
            })
            .flatten()
            .map(|token| lemma(&token.lower))
            .collect();
        let label_only: HashSet<String> = in_label
            .into_iter()
            .filter(|word| !outside.contains(word) && !committed.contains(word))
            .filter(|word| !names.iter().any(|name| name.eq_ignore_ascii_case(word)))
            .collect();
        // Actions: clauses whose subject is a named person, or "I" spoken by
        // a named speaker. The predicate ends at a cue or a new clause.
        let mut actions: Vec<(String, HashSet<String>)> = Vec::new();
        let mut said: Vec<(String, HashSet<String>)> = Vec::new();
        for chain in &all {
            let words: Vec<&Tok> = chain.tokens.iter().collect();
            for (at, token) in words.iter().enumerate() {
                if let Some(speaker) = &chain.lines[token.line].speaker_name {
                    let word = lemma(&token.lower);
                    match said.iter_mut().find(|entry| same_owner(&entry.0, speaker)) {
                        Some((_, set)) => {
                            set.insert(word);
                        }
                        None => said.push((speaker.clone(), HashSet::from([word]))),
                    }
                }
                let bare = token.text.trim_end_matches("'s");
                let person = if token.lower == "i" {
                    chain.lines[token.line].speaker_name.clone()
                } else if token.text.ends_with("'s")
                    || at > 0 && OBJECT_MARKERS.contains(&words[at - 1].lower.as_str())
                {
                    None
                } else {
                    names
                        .iter()
                        .find(|name| same_owner(name.as_str(), bare))
                        .cloned()
                };
                let Some(person) = person else {
                    continue;
                };
                // The main verb after auxiliaries, and an infinitive it
                // takes: "agreed to ship", "not committing to bring".
                let mut predicate = HashSet::new();
                let mut k = at + 1;
                while k < words.len()
                    && !words[k - 1].end
                    && (AUXILIARY.contains(&words[k].lower.as_str())
                        || words[k].lower.ends_with("ly"))
                {
                    k += 1;
                }
                if k < words.len()
                    && !words[k - 1].end
                    && !STOPWORDS.contains(&words[k].lower.as_str())
                {
                    predicate.insert(lemma(&words[k].lower));
                    if words.get(k + 1).is_some_and(|next| next.lower == "to") {
                        if let Some(next) = words.get(k + 2) {
                            predicate.insert(lemma(&next.lower));
                        }
                    }
                }
                match actions
                    .iter_mut()
                    .find(|entry| same_owner(&entry.0, &person))
                {
                    Some((_, set)) => set.extend(predicate),
                    None => actions.push((person, predicate)),
                }
            }
        }
        // Number units. A chain cut off mid-phrase ("... 16 sensors the
        // north") drops the trailing determiner phrase it never finished.
        let number_chains = chains(lines, &skip);
        let units: Vec<Unit> = number_chains
            .iter()
            .flat_map(|chain| {
                let mut words: Vec<&Tok> = chain.tokens.iter().collect();
                if words.last().is_some_and(|token| !token.end) {
                    let tail = words
                        .iter()
                        .rev()
                        .take(3)
                        .position(|token| DETERMINERS.contains(&token.lower.as_str()));
                    if let Some(back) = tail {
                        let at = words.len() - 1 - back;
                        let fragment = &words[at..];
                        if at > 0
                            && !words[at - 1].end
                            && !has_finite(fragment)
                            && !fragment
                                .iter()
                                .any(|token| token_numbers(token).0.is_some())
                        {
                            words.truncate(at);
                        }
                    }
                }
                units(&words, &names)
            })
            .collect();
        let restrictions = restrictions(&number_chains);
        let tasks: HashSet<String> = frames
            .iter()
            .filter(|frame| {
                matches!(
                    frame.kind,
                    frames::FrameKind::Commitment | frames::FrameKind::Agreement
                ) && frame.complete
                    && !frame.ambiguous
                    && !frame.conflict
            })
            .flat_map(|frame| tokens(&frame.core, 0))
            .filter(|token| !STOPWORDS.contains(&token.lower.as_str()))
            .map(|token| lemma(&token.lower))
            .collect();
        let mut asserted = HashSet::new();
        let mut tentative = HashSet::new();
        for chain in &all {
            let words: Vec<&Tok> = chain.tokens.iter().collect();
            for (start, end) in sentence_ranges(&words) {
                let sentence = &words[start..end];
                let target = if tentative_sentence(sentence) {
                    &mut tentative
                } else {
                    &mut asserted
                };
                target.extend(sentence.iter().map(|token| lemma(&token.lower)));
            }
        }
        let mut negated = Vec::new();
        for chain in &all {
            let words: Vec<&Tok> = chain.tokens.iter().collect();
            for at in 1..words.len().saturating_sub(1) {
                let negation = words[at].lower == "not" || words[at].lower == "never";
                let auxiliary = matches!(
                    words[at - 1].lower.as_str(),
                    "have" | "has" | "had" | "did" | "do" | "does" | "is" | "are" | "was" | "were"
                );
                if !(negation && auxiliary) {
                    continue;
                }
                let verb = words[at + 1].lower.as_str();
                if STOPWORDS.contains(&verb) || !(verb.ends_with("ed") || verb.ends_with('s')) {
                    continue;
                }
                let end = (at + 2..words.len())
                    .find(|k| words[*k - 1].end || words[*k - 1].comma || clause_start(&words, *k))
                    .unwrap_or(words.len());
                let objects = content(&words[at + 2..end]);
                if !objects.is_empty() {
                    negated.push((lemma(verb), objects));
                }
            }
        }
        Self {
            tasks,
            negated,
            asserted,
            tentative,
            lines,
            names,
            vocabulary,
            label_only,
            actions,
            said,
            units,
            restrictions,
        }
    }

    #[cfg(test)]
    pub(super) fn debug(&self) -> serde_json::Value {
        let mut labels: Vec<&String> = self.label_only.iter().collect();
        labels.sort();
        let mut tasks: Vec<&String> = self.tasks.iter().collect();
        tasks.sort();
        serde_json::json!({
            "labelOnly": labels,
            "actions": self.actions.iter().map(|(name, set)| {
                let mut words: Vec<&String> = set.iter().collect();
                words.sort();
                serde_json::json!({"name": name, "words": words})
            }).collect::<Vec<_>>(),
            "units": self.units.iter().map(|unit| serde_json::json!({
                "numbers": unit.numbers, "words": unit.words, "pronoun": unit.pronoun,
            })).collect::<Vec<_>>(),
            "tasks": tasks,
            "restrictions": self.restrictions.iter().map(|r| serde_json::json!({
                "number": r.number, "context": r.context, "terms": r.terms,
            })).collect::<Vec<_>>(),
        })
    }

    pub(super) fn violation(&self, text: &str) -> Option<&'static str> {
        self.commentary(text)
            .or_else(|| self.negation_dropped(text))
            .or_else(|| self.suggestion_as_commitment(text))
            .or_else(|| self.vague_condition(text))
            .or_else(|| self.label(text))
            .or_else(|| self.actor(text))
            .or_else(|| self.number(text))
    }

    fn commentary(&self, text: &str) -> Option<&'static str> {
        // A quoted phrase quotes the source: "The phrase 'the 14th' ...".
        static QUOTED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r#"(?:^|[\s(])['‘"“][^'’"”]{2,}['’"”](?:$|[\s.,;:!?)])"#).unwrap()
        });
        if QUOTED.is_match(text) {
            return Some("source_commentary");
        }
        let words = tokens(text, 0);
        words
            .iter()
            .any(|token| {
                COMMENTARY.contains(&token.lower.as_str())
                    && !self.vocabulary.contains(&token.lower)
            })
            .then_some("source_commentary")
    }

    /// "Celeste asked about approving the fog machine" from "we haven't
    /// approved the fog machine": a negated statement keeps its negation.
    fn negation_dropped(&self, text: &str) -> Option<&'static str> {
        let words = tokens(text, 0);
        let refs: Vec<&Tok> = words.iter().collect();
        let mut start = 0;
        for at in 0..=refs.len() {
            let boundary = at == refs.len()
                || at > start && (refs[at - 1].end || refs[at - 1].comma)
                || matches!(refs[at].lower.as_str(), "and" | "but");
            if !boundary {
                continue;
            }
            let clause = &refs[start..at];
            start = at;
            // "until the tablet build is approved" names a prerequisite; it
            // asserts nothing.
            let clause = match (0..clause.len()).find(|k| condition_cue(clause, *k).is_some()) {
                Some(cue) => &clause[..cue],
                None => clause,
            };
            let lemmas: Vec<String> = clause.iter().map(|token| lemma(&token.lower)).collect();
            let negative = clause.iter().any(|token| {
                matches!(
                    token.lower.as_str(),
                    "not" | "no" | "never" | "without" | "pending" | "unapproved" | "yet"
                )
            });
            if negative {
                continue;
            }
            if self.negated.iter().any(|(verb, objects)| {
                lemmas.iter().any(|word| same_lemma(word, verb))
                    && objects
                        .iter()
                        .all(|object| lemmas.iter().any(|word| same_lemma(word, object)))
            }) {
                return Some("negation_changed");
            }
        }
        None
    }

    /// "The van will be mentioned in the report" from "should we mention the
    /// van in the report?": the verb was only ever proposed.
    fn suggestion_as_commitment(&self, text: &str) -> Option<&'static str> {
        let words = tokens(text, 0);
        for (at, token) in words.iter().enumerate() {
            let assertion = matches!(
                token.lower.as_str(),
                "will" | "must" | "shall" | "agreed" | "decided" | "committed" | "promised"
            ) || token.lower == "going"
                && words.get(at + 1).is_some_and(|next| next.lower == "to");
            if !assertion {
                continue;
            }
            let verb = words[at + 1..].iter().find(|next| {
                !matches!(
                    next.lower.as_str(),
                    "to" | "be" | "been" | "not" | "also" | "then" | "now" | "still" | "first"
                ) && !next.lower.ends_with("ly")
            });
            let Some(verb) = verb else {
                continue;
            };
            let word = lemma(&verb.lower);
            if STOPWORDS.contains(&verb.lower.as_str()) {
                continue;
            }
            if self.tentative.contains(&word) && !self.asserted.contains(&word) {
                return Some("suggestion_as_commitment");
            }
        }
        None
    }

    /// "the memory gate and other conditions": an unnamed extra condition.
    fn vague_condition(&self, text: &str) -> Option<&'static str> {
        const VAGUE: &[&str] = &[
            "other",
            "additional",
            "further",
            "extra",
            "remaining",
            "certain",
        ];
        const CONDITIONS: &[&str] = &[
            "condition",
            "conditions",
            "requirement",
            "requirements",
            "criteria",
            "factors",
            "prerequisites",
            "approvals",
            "checks",
            "dependencies",
            "considerations",
            "steps",
            "factor",
        ];
        let words = tokens(text, 0);
        words
            .windows(3)
            .any(|window| {
                VAGUE.contains(&window[0].lower.as_str())
                    && window[1..]
                        .iter()
                        .any(|token| CONDITIONS.contains(&token.lower.as_str()))
                    && !self.vocabulary.contains(&window[0].lower)
            })
            .then_some("condition_not_supported")
    }

    fn label(&self, text: &str) -> Option<&'static str> {
        tokens(text, 0)
            .iter()
            .any(|token| {
                !STOPWORDS.contains(&token.lower.as_str())
                    && !self
                        .names
                        .iter()
                        .any(|name| same_owner(name, token.text.trim_end_matches("'s")))
                    && self.label_only.contains(&lemma(&token.lower))
            })
            .then_some("label_relationship_not_supported")
    }

    fn actor(&self, text: &str) -> Option<&'static str> {
        let words = tokens(text, 0);
        for (at, token) in words.iter().enumerate() {
            let bare = token.text.trim_end_matches("'s");
            let Some(person) = self.names.iter().find(|name| same_owner(name, bare)) else {
                continue;
            };
            if token.text.ends_with("'s")
                || at > 0 && OBJECT_MARKERS.contains(&words[at - 1].lower.as_str())
            {
                continue;
            }
            let mut verb = None;
            let mut passive = false;
            // "Wren agrees to the adjusted date": with no verb after it, the
            // agreement is the act.
            let mut act = None;
            for (k, next) in words.iter().enumerate().skip(at + 1).take(7) {
                let word = next.lower.as_str();
                if matches!(
                    word,
                    "agreed" | "agrees" | "decided" | "committed" | "commits" | "promised"
                ) {
                    act = Some(k);
                }
                let name = self
                    .names
                    .iter()
                    .any(|name| same_owner(name, next.text.trim_end_matches("'s")));
                if matches!(
                    word,
                    "is" | "are" | "was" | "were" | "be" | "been" | "being"
                ) {
                    passive = true;
                    continue;
                }
                if AUXILIARY.contains(&word) || name || word.ends_with("ly") {
                    continue;
                }
                verb = Some(k);
                break;
            }
            let Some(mut verb) = verb else {
                continue;
            };
            if STOPWORDS.contains(&words[verb].lower.as_str()) {
                match act {
                    Some(at) => verb = at,
                    None => continue,
                }
            }
            let word = words[verb].lower.as_str();
            if number_key(word).is_some()
                || words[verb]
                    .text
                    .chars()
                    .next()
                    .is_some_and(char::is_uppercase)
            {
                continue;
            }
            // "Leo was asked to send": a passive names no act of Leo's.
            let participle = word.ends_with("ed")
                || matches!(word, "sent" | "told" | "given" | "taken" | "made" | "asked");
            if passive && participle {
                continue;
            }
            let lemma_word = lemma(word);
            // "until Kai confirms the restore test" names an event, not a
            // report of what Kai said.
            let hypothetical = at > 0 && condition_cue(&refs_of(&words), at - 1).is_some();
            if SPEECH.contains(&word) && !hypothetical {
                let said = self
                    .said
                    .iter()
                    .find(|(name, _)| same_owner(name, person))
                    .map(|(_, set)| set);
                let reported: Vec<String> = words[verb + 1..words.len().min(verb + 10)]
                    .iter()
                    .filter(|token| {
                        !STOPWORDS.contains(&token.lower.as_str())
                            && !matches!(
                                token.lower.as_str(),
                                "about" | "whether" | "possibility" | "regarding"
                            )
                            && !SPEECH.contains(&token.lower.as_str())
                            && !self
                                .names
                                .iter()
                                .any(|name| same_owner(name, token.text.trim_end_matches("'s")))
                    })
                    .map(|token| lemma(&token.lower))
                    .collect();
                let kept = reported
                    .iter()
                    .filter(|word| {
                        said.is_some_and(|set| set.iter().any(|known| same_lemma(known, word)))
                    })
                    .count();
                // A speech act needs what the person said, even when the
                // person made some other suggestion ("Tobias suggests an oven
                // repair" from his suggestion about another mill).
                if !reported.is_empty() && (kept == 0 || kept * 2 < reported.len()) {
                    return Some("speaker_not_supported");
                }
                continue;
            }
            let acts = self
                .actions
                .iter()
                .find(|(name, _)| same_owner(name, person))
                .map(|(_, set)| set);
            if !acts.is_some_and(|set| set.iter().any(|known| same_lemma(known, &lemma_word))) {
                return Some("actor_not_supported");
            }
        }
        None
    }

    /// Words of a "for / with / only / except" phrase after `number` that
    /// the source never uses.
    fn invented_restriction(&self, words: &[&Tok], number: &str) -> bool {
        let dates = date_mask(words);
        (0..words.len()).any(|at| {
            if dates[at] || token_numbers(words[at]).0.as_deref() != Some(number) {
                return false;
            }
            let Some(cue) = (at + 1..words.len().min(at + 5)).find(|k| {
                matches!(
                    words[*k].lower.as_str(),
                    "for" | "with" | "only" | "except" | "excluding"
                )
            }) else {
                return false;
            };
            words[cue + 1..]
                .iter()
                .take_while(|token| !token.comma && !token.end)
                .chain(words.get(cue + 1).filter(|token| token.comma || token.end))
                .filter(|token| !STOPWORDS.contains(&token.lower.as_str()))
                .filter(|token| token_numbers(token).0.is_none())
                .map(|token| lemma(&token.lower))
                .any(|word| {
                    !QUANTITY_FRAME.contains(&word.as_str())
                        && !self.vocabulary.iter().any(|known| same_lemma(known, &word))
                })
        })
    }

    fn number(&self, text: &str) -> Option<&'static str> {
        let words = tokens(text, 0);
        let refs: Vec<&Tok> = words.iter().collect();
        let claim_words: Vec<String> = content(&refs);
        let parts = units(&refs, &self.names);
        for part in &parts {
            for number in &part.numbers {
                let own: Vec<usize> = (0..self.units.len())
                    .filter(|at| self.units[*at].numbers.contains(number))
                    .collect();
                if own.is_empty() {
                    continue;
                }
                // A unit's context includes the unit it refers back to, and a
                // following unit that refers back to it ("It must show ...").
                let in_own = |word: &String| {
                    own.iter().any(|at| {
                        let context = std::iter::once(*at)
                            .chain((self.units[*at].pronoun && *at > 0).then(|| at - 1))
                            .chain(
                                self.units
                                    .get(at + 1)
                                    .is_some_and(|next| next.pronoun && next.numbers.is_empty())
                                    .then(|| at + 1),
                            );
                        context.into_iter().any(|unit| {
                            self.units[unit]
                                .words
                                .iter()
                                .any(|known| same_lemma(known, word))
                        })
                    })
                };
                // Borrowed: from another quantity's clause, or from a
                // commitment's task ("the budget for the room plan").
                let elsewhere = |word: &String| {
                    self.tasks.iter().any(|known| same_lemma(known, word))
                        || self.units.iter().enumerate().any(|(at, unit)| {
                            !own.contains(&at)
                                && !unit.numbers.is_empty()
                                && unit.words.iter().any(|known| same_lemma(known, word))
                        })
                };
                if part.words.iter().any(|word| {
                    !NUMBER_GENERIC.contains(&word.as_str())
                        && !COMMENTARY.contains(&word.as_str())
                        && !in_own(word)
                        && elsewhere(word)
                }) {
                    return Some("number_relation_not_supported");
                }
                // "drop to 10 pounds for the next period" from "... for anyone
                // over seventy": a restricting phrase after a quantity comes
                // from the source.
                if self.invented_restriction(&refs, number) {
                    return Some("qualifier_not_supported");
                }
                // A restricted quantity keeps its restriction, unless the
                // claim matches an unrestricted use of the same number.
                let overlap = |context: &[String]| {
                    context
                        .iter()
                        .filter(|word| part.words.iter().any(|w| same_lemma(w, word)))
                        .count()
                };
                let restricted: Vec<&Restriction> = self
                    .restrictions
                    .iter()
                    .filter(|r| &r.number == number)
                    .collect();
                let Some(best) = restricted.iter().max_by_key(|r| overlap(&r.context)) else {
                    continue;
                };
                let unrestricted = own.iter().any(|at| {
                    let unit = &self.units[*at];
                    !restricted.iter().any(|r| {
                        r.context
                            .iter()
                            .filter(|word| unit.words.contains(word))
                            .count()
                            * 2
                            >= unit.words.len().max(1)
                    }) && unit
                        .words
                        .iter()
                        .filter(|word| part.words.iter().any(|w| same_lemma(w, word)))
                        .count()
                        > overlap(&best.context)
                });
                if unrestricted {
                    continue;
                }
                let kept = best
                    .terms
                    .iter()
                    .filter(|term| claim_words.iter().any(|word| same_lemma(word, term)))
                    .count();
                if kept == 0 || kept * 2 < best.terms.len() {
                    return Some("qualifier_dropped");
                }
            }
        }
        let _ = self.lines;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(rows: &[(&str, &str)]) -> Vec<TrustedLine> {
        rows.iter()
            .enumerate()
            .map(|(at, (text, speaker))| TrustedLine {
                written_note: false,
                speaker_name: (!speaker.is_empty()).then(|| speaker.to_string()),
                speaker_id: (!speaker.is_empty()).then(|| format!("voice_{speaker}")),
                line_id: format!("L{}", at + 1),
                recording_id: "r".into(),
                segment_id: format!("s{at}"),
                text: text.to_string(),
                start_time: at as f64 * 10.0,
                end_time: at as f64 * 10.0 + 8.0,
            })
            .collect()
    }

    fn check(rows: &[(&str, &str)], claims: &[(&str, Option<&str>)]) {
        let lines = lines(rows);
        let frames = frames::source_frames(&lines);
        let names = frames::frame_names(&frames, &lines);
        let source = SourceClaims::new(&lines, &frames, &names);
        for (claim, expected) in claims {
            assert_eq!(
                source.violation(claim),
                *expected,
                "{claim}\n{}",
                serde_json::to_string_pretty(&source.debug()).unwrap()
            );
        }
    }

    const RENEWAL: &[(&str, &str)] = &[
        ("For Birch Studio the current plan is 60 seats at $32 per seat per month.", "Asha"),
        ("We might grow to 80 seats, but procurement has not approved the increase.", "Ben"),
        ("The proposed 80-seat price is $29 per seat per month only with an annual contract. Monthly billing stays at $32.", "Asha"),
        ("I'll send the 80-seat quote to Ben by March 6. It must show both billing options.", "Dev"),
        ("I'll review the quote by March 8 if procurement confirms the seat count.", "Ben"),
    ];

    #[test]
    fn numbers_keep_their_own_clause_and_restriction() {
        check(
            RENEWAL,
            &[
                ("Birch Studio's current plan is 60 seats at $32 per seat per month.", None),
                ("Procurement has not approved an increase to 80 seats.", None),
                ("The proposed 80-seat price is $29 per seat per month only with an annual contract.", None),
                ("The 80-seat price is $29 per seat per month with an annual contract.", None),
                ("Monthly billing stays at $32.", None),
                ("A proposed expansion to 80 seats is under consideration, but procurement has not approved the increase.", None),
                ("Dev will send the 80-seat quote to Ben by March 6.", None),
                ("Dev will send the 80-seat quote to Ben by March 6, including both billing options.", None),
                ("The proposed 80-seat price is $29 per seat with an annual contract, and monthly billing stays at $32.", None),
                ("Monthly billing for the proposed annual contract stays at $32.", Some("number_relation_not_supported")),
                // The restriction is dropped and monthly billing borrowed.
                ("The 80-seat price is $29 per seat per month with monthly billing at $32.", Some("qualifier_dropped")),
                ("The proposed price is $29 per seat per month.", Some("qualifier_dropped")),
            ],
        );
        check(
            &[(
                "The proposed 80-seat price is $29 per seat per month only with an annual contract monthly billing stays at $32.",
                "Asha",
            )],
            &[
                ("The proposed 80-seat price is $29 per seat per month with an annual contract.", None),
                ("Monthly billing stays at $32.", None),
                ("The 80-seat price is $29 per seat per month with monthly billing at $32.", Some("qualifier_dropped")),
                ("Monthly billing with an annual contract stays at $32.", Some("number_relation_not_supported")),
            ],
        );
        let garden = &[
            ("The Elm garden has 16 sensors the north bed has 5 dry sensors; the south bed has 2.", "Tessa"),
            ("I'll send the sensor report by June 12 if the north bed readings are confirmed.", "Tessa"),
        ];
        check(
            &[
                ("The Elm garden has 16 sensors the north", "Tessa"),
                (
                    "The Elm garden has 16 sensors the north bed has 5 dry sensors; the",
                    "Tessa",
                ),
                ("south bed has 2.", "Tessa"),
            ],
            &[
                (
                    "The Elm garden has 16 sensors in the north bed.",
                    Some("number_relation_not_supported"),
                ),
                ("The north bed has 5 dry sensors.", None),
            ],
        );
        check(
            &[
                ("the Elm garden has 16 sensors. The north bed has", "Tessa"),
                ("the Elm garden has 16 sensors. The north bed", "Tessa"),
                ("has 5 dry sensors; the south bed has 2.", "Tessa"),
            ],
            &[("The north bed has 5 dry sensors.", None)],
        );
        check(
            garden,
            &[
                ("The Elm garden has 16 sensors.", None),
                ("The north bed has 5 dry sensors, and the south bed has 2.", None),
                ("The south bed has 2 dry sensors.", None),
                ("Tessa confirmed the Elm garden has 16 sensors, the north bed has 5 dry sensors, and the south bed has 2.", None),
                ("The Elm garden has 16 sensors: 5 dry sensors in the north bed and 2 in the south bed.", None),
                ("The Elm garden has 16 sensors in the north bed.", Some("number_relation_not_supported")),
                ("The north bed has 16 sensors.", Some("number_relation_not_supported")),
            ],
        );
        let workshop = &[
            (
                "The Cedar workshop has 18 attendees and 2 rooms the budget is $900, not $1,900.",
                "Iris",
            ),
            ("I'll send the room plan by Wednesday.", "Noah"),
        ];
        check(
            workshop,
            &[
                ("The budget is $900, not $1,900.", None),
                ("The Cedar workshop has 18 attendees and 2 rooms.", None),
                (
                    "The budget for the room plan is $900, not $1,900.",
                    Some("number_relation_not_supported"),
                ),
            ],
        );
    }

    const HANDOFF: &[(&str, &str)] = &[
        (
            "The Alder desktop pilot has 24 seats. We are not expanding it to 40 seats this month.",
            "Mara",
        ),
        (
            "Yes. I'll send the export report by Tuesday, after I rerun the 3 failing checks.",
            "Leo",
        ),
        (
            "I'll review the export report by Wednesday. I am not the shipping owner.",
            "Nina",
        ),
        (
            "I will ship version 2.8 on Friday only if Nina approves the export report.",
            "Mara",
        ),
        (
            "Could we also add offline search? That is a suggestion, not a task for this release.",
            "Nina",
        ),
    ];

    #[test]
    fn people_do_and_say_only_what_the_source_gives_them() {
        check(
            HANDOFF,
            &[
                ("Leo will send the export report by Tuesday after Leo reruns the 3 failing checks.", None),
                ("Nina suggested adding offline search, but it is not a task.", None),
                ("Mara will ship version 2.8 on Friday only if Nina approves the export report.", None),
                ("Nina is responsible for reviewing the export report.", None),
                ("The team is not expanding the Alder desktop pilot to 40 seats this month.", None),
                ("Mara proposes adding offline search as a suggestion, not a task.", Some("speaker_not_supported")),
                ("Mara is piloting a system with 24 seats.", Some("actor_not_supported")),
                ("The Alder desktop pilot has 24 seats for the next quarter.", Some("qualifier_not_supported")),
                ("The team is not expanding the Alder desktop pilot to 40 seats this month.", None),
                ("The Alder desktop pilot currently has 24 seats.", None),
                ("Nina will ship version 2.8 on Friday.", Some("actor_not_supported")),
                ("Leo was asked to send the export report by Tuesday.", None),
                ("Mara will ship version 2.8 on Friday only if Nina confirms the export report.", Some("actor_not_supported")),
                ("Nina will add offline search to this release.", Some("suggestion_as_commitment")),
                ("Leo agrees to the Friday ship date.", Some("actor_not_supported")),
            ],
        );
        check(
            &[
                ("I want to ask whether we should mention the new van in the report. It's only a question, not a task.", "Ivo"),
                ("I'll submit the grant report on Tuesday.", "Lior"),
                ("Space planning call. I'll set up Odette by Wednesday.", "Hiro"),
                ("Sponsor round-up: Tobias told me he called both sponsors yesterday, and they have renewed.", "Wren"),
            ],
            &[
                ("The van will be mentioned in the report.", Some("suggestion_as_commitment")),
                ("Ivo asked whether the new van should be mentioned in the report.", None),
                ("Hiro will set up Odette by Wednesday.", None),
                ("Lior will set up Odette by Wednesday.", Some("actor_not_supported")),
                ("Tobias renewed his sponsorship.", Some("actor_not_supported")),
            ],
        );
    }

    #[test]
    fn labels_and_commentary_are_not_meeting_content() {
        let rows = &[
            ("Plainsong footprint fixture. We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.", ""),
            ("plainsong footprint um, fixture, we agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes", ""),
            ("We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes plainsong footprint fixture.", ""),
        ];
        check(
            rows,
            &[
                ("We agreed to ship the beta on the 14th if the memory gate passes.", None),
                ("Priya will review the notes.", None),
                ("The owner is Plainsong, and the deadline is the 14th.", Some("label_relationship_not_supported")),
                ("The commitment is to ship the fixture beta on the 14th if the memory gate passes.", Some("label_relationship_not_supported")),
                ("Plainsong footprint fixture agreed to ship beta on the fourteenth if memory gate passes.", Some("label_relationship_not_supported")),
                ("The memory gate pass condition is explicitly stated across multiple lines.", Some("source_commentary")),
                ("The phrase 'the 14th' is consistently referenced as the shipment date.", Some("source_commentary")),
                ("The owners and responsibilities are clearly defined, with Priya responsible for reviewing the notes.", Some("source_commentary")),
                ("The beta will be shipped on the 14th if the memory gate and other conditions are met.", Some("condition_not_supported")),
            ],
        );
        // A heading in a real meeting is a label too; its words are not an
        // owner or a product, while words the meeting itself uses stay usable.
        check(
            &[
                ("Hiring sync. Ana will post the role by Friday.", "Ana"),
                ("Hiring sync, I'll review the shortlist on Monday.", "Raj"),
                ("The audio transcript export is broken.", "Raj"),
            ],
            &[
                ("Ana will post the role by Friday.", None),
                ("Raj will review the shortlist on Monday.", None),
                ("The audio transcript export is broken.", None),
                (
                    "The sync owner is Ana.",
                    Some("label_relationship_not_supported"),
                ),
                (
                    "Raj will review the hiring shortlist on Monday.",
                    Some("label_relationship_not_supported"),
                ),
            ],
        );
        // Item numbers and one-word colon headings are headings too.
        check(
            &[
                (
                    "Agenda item one, inventory: Cleo counted 340 pallets.",
                    "Bram",
                ),
                (
                    "Agenda item two, staffing: we need 6 extra pickers.",
                    "Cleo",
                ),
                (
                    "Logistics: each stall gets 2 power outlets. The pricing page is live.",
                    "Theo",
                ),
            ],
            &[
                ("Cleo counted 340 pallets.", None),
                (
                    "Inventory: Cleo counted 340 pallets.",
                    Some("label_relationship_not_supported"),
                ),
                (
                    "The staffing plan needs 6 extra pickers.",
                    Some("label_relationship_not_supported"),
                ),
                (
                    "The logistics include 2 power outlets per stall.",
                    Some("label_relationship_not_supported"),
                ),
                ("The pricing page is live.", None),
            ],
        );
        check(
            &[("Pricing: the student plan is $9 a month only with a school email address. The standard plan is $15 a month.", "Tali")],
            &[
                ("The student plan is $9/month only with a school email address.", None),
                ("The student plan is $9/month and the standard plan is $15/month.", Some("qualifier_dropped")),
            ],
        );
        // Lowercase one-off headings, and negated decisions.
        check(
            &[
                ("supplier check-in. Harlan now charges $27 a sack of flour.", "Mireille"),
                ("pricing: the Pro tier costs $6 a month.", "Emeka"),
                ("Can I ask whether the matinee could use the smaller hall? Also, we haven't approved the fog machine.", "Celeste"),
            ],
            &[
                ("Harlan charges $27 a sack of flour.", None),
                ("The supplier charges $27 a sack of flour.", Some("label_relationship_not_supported")),
                ("The Pro tier pricing is $6 a month.", Some("label_relationship_not_supported")),
                                ("The fog machine has not been approved.", None),
                ("Celeste will wait until the fog machine is approved.", Some("actor_not_supported")),
                ("The matinee waits until the fog machine is approved.", None),
                ("Celeste asked about using the smaller hall and approving the fog machine.", Some("negation_changed")),
            ],
        );
        // Headings before a comma, and one set off by commas inside a
        // garbled condition.
        check(
            &[
                ("Pricing review, the quote from Fenwick is twelve dollars per seat.", "Odile"),
                ("rehearsal schedule. The cast has fourteen actors.", "Celeste"),
                ("until Yusuf finishes the set changes, rehearsal schedule, again: I won't lock the lighting cues", "Imke"),
            ],
            &[
                                ("The quote from Fenwick is twelve dollars per seat.", None),
                ("Pricing review the quote from Fenwick is twelve dollars.", Some("label_relationship_not_supported")),
                ("The pricing review is twelve dollars per seat.", Some("label_relationship_not_supported")),
                ("The rehearsal schedule includes fourteen actors.", Some("label_relationship_not_supported")),
            ],
        );
        // A row that completes an unfinished one is not a heading.
        check(
            &[
                ("We agreed to ship the beta if the memory", ""),
                ("gate passes. Priya will review the notes.", ""),
            ],
            &[(
                "We agreed to ship the beta if the memory gate passes.",
                None,
            )],
        );
    }
}
