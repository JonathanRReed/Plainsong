//! Narrow English checks for the relationships inside an extracted task.

use std::collections::HashSet;
use std::sync::LazyLock;

pub(super) struct Source<'a> {
    pub text: &'a str,
    pub speaker: Option<&'a str>,
    pub cited: bool,
}

struct Action {
    verb: String,
    objects: HashSet<String>,
}

#[derive(Clone)]
struct Clause<'a> {
    words: Vec<String>,
    action_at: usize,
    literal_words: Vec<bool>,
    speaker: Option<&'a str>,
    cited: bool,
    question: bool,
    repaired_deadline: Option<(usize, Vec<String>)>,
}

fn token_pattern() -> &'static regex::Regex {
    static TOKEN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}|[\p{L}\p{M}\p{N}]+(?:\.[\p{N}]+)?|[<>]=?|[≤≥=,:]",
        )
        .expect("action token pattern is valid")
    });
    &TOKEN
}

fn words(text: &str) -> Vec<String> {
    token_pattern()
        .find_iter(text)
        .map(|word| word.as_str().to_lowercase())
        .collect()
}

fn clauses(text: &str) -> impl Iterator<Item = &str> {
    let bytes = text.as_bytes();
    let mut offset = 0;
    text.split_inclusive(move |ch: char| {
        let at = offset;
        offset += ch.len_utf8();
        let decimal = ch == '.'
            && at > 0
            && bytes[at - 1].is_ascii_digit()
            && bytes.get(at + 1).is_some_and(u8::is_ascii_digit);
        matches!(ch, '.' | '!' | '?' | ';' | '\n') && !decimal
    })
}

fn verb(word: &str) -> String {
    let known = match word {
        "send" | "sends" | "sending" | "sent" => Some("send"),
        "share" | "shares" | "sharing" | "shared" => Some("share"),
        "put" | "puts" | "putting" => Some("put"),
        "upload" | "uploads" | "uploading" | "uploaded" => Some("upload"),
        "review" | "reviews" | "reviewing" | "reviewed" => Some("review"),
        "book" | "books" | "booking" | "booked" => Some("book"),
        "schedule" | "schedules" | "scheduling" | "scheduled" => Some("schedule"),
        "deliver" | "delivers" | "delivering" | "delivered" => Some("deliver"),
        "deploy" | "deploys" | "deploying" | "deployed" => Some("deploy"),
        "approve" | "approves" | "approving" | "approved" => Some("approve"),
        "finish" | "finishes" | "finishing" | "finished" => Some("finish"),
        "complete" | "completes" | "completing" | "completed" => Some("complete"),
        "provide" | "provides" | "providing" | "provided" => Some("provide"),
        "prepare" | "prepares" | "preparing" | "prepared" => Some("prepare"),
        "write" | "writes" | "writing" | "wrote" => Some("write"),
        "take" | "takes" | "taking" | "took" => Some("take"),
        _ => None,
    };
    if let Some(known) = known {
        return known.into();
    }
    // Infinitives in tasks need to match ordinary finite verbs in speech,
    // including actions outside the common-verb examples above.
    if word.len() > 4
        && ["ches", "shes", "xes", "zes", "ses", "oes"]
            .iter()
            .any(|ending| word.ends_with(ending))
    {
        return word[..word.len() - 2].into();
    }
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        return word[..word.len() - 1].into();
    }
    word.into()
}

fn auxiliary(word: &str) -> bool {
    matches!(
        word,
        "will"
            | "ll"
            | "can"
            | "could"
            | "might"
            | "may"
            | "should"
            | "would"
            | "must"
            | "do"
            | "does"
    )
}

fn action_start(tokens: &[String]) -> Option<usize> {
    let end = tokens
        .iter()
        .position(|word| condition_word(word))
        .unwrap_or(tokens.len())
        .min(5);
    let auxiliary_at = tokens[..end].iter().position(|word| auxiliary(word));
    let agreement_at = tokens[..end]
        .windows(2)
        .position(|pair| matches!(pair[0].as_str(), "agreed" | "decided") && pair[1] == "to");
    let mut at = auxiliary_at
        .map(|at| at + 1)
        .or_else(|| agreement_at.map(|at| at + 2))
        .unwrap_or(0);
    while tokens.get(at).is_some_and(|word| {
        matches!(
            word.as_str(),
            "not" | "t" | "to" | "please" | "be" | "able" | "only"
        )
    }) {
        at += 1;
    }
    tokens.get(at).map(|_| at)
}

fn condition_word(word: &str) -> bool {
    matches!(
        word,
        "if" | "unless" | "until" | "provided" | "when" | "after" | "before"
    )
}

fn object_words(words: &[String]) -> HashSet<String> {
    words
        .iter()
        .take_while(|word| {
            !condition_word(word)
                && !matches!(
                    word.as_str(),
                    "by" | "on" | "to" | "and" | "or" | "but" | "then"
                )
        })
        .filter(|word| {
            word.len() > 2
                && !matches!(
                    word.as_str(),
                    "the"
                        | "and"
                        | "that"
                        | "this"
                        | "our"
                        | "your"
                        | "their"
                        | "them"
                        | "into"
                        | "with"
                        | "something"
                        | "only"
                        | "monday"
                        | "tuesday"
                        | "wednesday"
                        | "thursday"
                        | "friday"
                        | "saturday"
                        | "sunday"
                        | "tomorrow"
                        | "today"
                        | "next"
                        | "later"
                )
        })
        .cloned()
        .collect()
}

fn action(task: &str) -> Option<Action> {
    // A passive nominal recap still claims the underlying task, so its
    // condition cannot disappear merely because "review" precedes "will".
    static NOMINAL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:the )?(review|shipment|delivery|approval) of (.+?) (?:will be|is|was) (?:conducted|scheduled|planned|completed|done)\b").unwrap()
    });
    if let Some(found) = NOMINAL.captures(task) {
        let verb = match &found[1].to_lowercase()[..] {
            "shipment" => "ship",
            "delivery" => "deliver",
            "approval" => "approve",
            _ => "review",
        };
        let objects = object_words(&words(&found[2]));
        return (!objects.is_empty()).then(|| Action {
            verb: verb.into(),
            objects,
        });
    }
    static DEPENDENT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(?:will determine|determines) whether [\p{L}\p{M}]+ ([\p{L}\p{M}]+) (.+)",
        )
        .unwrap()
    });
    if let Some(found) = DEPENDENT.captures(task) {
        let objects = object_words(&words(&found[2]));
        return (!objects.is_empty()).then(|| Action {
            verb: verb(&found[1].to_lowercase()),
            objects,
        });
    }
    let tokens = words(clauses(task).next()?);
    let at = action_start(&tokens)?;
    let objects = object_words(&tokens[at + 1..]);
    (!objects.is_empty()).then(|| Action {
        verb: verb(&tokens[at]),
        objects,
    })
}

pub(super) fn same_task(first: &str, second: &str) -> bool {
    match (action(first), action(second)) {
        (Some(first), Some(second)) => first.verb == second.verb && first.objects == second.objects,
        _ => false,
    }
}

pub(super) fn summary_task_needs_review(statement: &str, sources: &[Source<'_>]) -> bool {
    let task = statement
        .split_once(':')
        .filter(|(label, _)| {
            label
                .chars()
                .all(|ch| ch.is_alphabetic() || ch.is_whitespace())
        })
        .map_or(statement, |(_, task)| task.trim());
    let Some(action) = action(task) else {
        return false;
    };
    let matched = matching_clauses(&action, sources);
    if matched.is_empty() {
        return false;
    }
    let claim = [Source {
        text: task,
        speaker: None,
        cited: true,
    }];
    let claim_words = words(task);
    let added_condition = matching_clauses(&action, &claim)
        .iter()
        .flat_map(conditions)
        .any(|condition| {
            !matched.iter().filter(|source| source.cited).any(|source| {
                conditions(source).iter().any(|original| {
                    original == &condition
                        || blocker(source)
                            && original.first().is_some_and(|word| word == "unless")
                            && condition.first().is_some_and(|word| word == "if")
                            && contains_words(&claim_words, &words("only if"))
                            && original[1..] == condition[1..]
                })
            })
        });
    added_condition || task_needs_review(task, sources)
}

fn matching_clauses<'a>(action: &Action, sources: &'a [Source<'a>]) -> Vec<Clause<'a>> {
    sources
        .iter()
        .flat_map(|source| {
            // Parse the original source once: a literal may cross sentence boundaries.
            let literals = crate::dictation_cleanup::literal_token_ranges(source.text);
            let mut result = Vec::new();
            let mut previous: Option<Clause<'a>> = None;
            for text in clauses(source.text) {
                let question = text.trim_end().ends_with('?');
                let offset = text.as_ptr() as usize - source.text.as_ptr() as usize;
                let matches: Vec<_> = token_pattern().find_iter(text).collect();
                let tokens: Vec<_> = matches
                    .iter()
                    .map(|word| word.as_str().to_lowercase())
                    .collect();
                let literal_words: Vec<_> = matches
                    .iter()
                    .map(|word| {
                        let start = offset + word.start();
                        let end = offset + word.end();
                        literals
                            .iter()
                            .any(|literal| start < literal.end && end > literal.start)
                    })
                    .collect();
                let mut starts = vec![0];
                for (at, word) in tokens.iter().enumerate() {
                    if !matches!(word.as_str(), "and" | "or" | "but" | "then") {
                        continue;
                    }
                    let tail = &tokens[at + 1..];
                    let next_subject = tail.first().is_some_and(|word| {
                        matches!(word.as_str(), "i" | "we" | "you" | "he" | "she" | "they")
                    });
                    let next_auxiliary = tail.iter().take(4).any(|word| auxiliary(word));
                    let finite_verb = tail.get(1).is_some_and(|word| verb(word) != *word);
                    let same_verb = tail.first().is_some_and(|word| verb(word) == action.verb);
                    if next_subject || next_auxiliary || finite_verb || same_verb {
                        starts.push(at + 1);
                    }
                }
                starts.push(tokens.len());
                let current = starts
                    .windows(2)
                    .flat_map(|range| {
                        let end = range[1].saturating_sub(usize::from(range[1] != tokens.len()));
                        let component = &tokens[range[0]..end];
                        component
                            .iter()
                            .enumerate()
                            .filter_map(|(at, word)| {
                                if verb(word) != action.verb {
                                    return None;
                                }
                                let objects = object_words(&component[at + 1..]);
                                action.objects.is_subset(&objects).then_some(Clause {
                                    words: component.to_vec(),
                                    action_at: at,
                                    literal_words: literal_words[range[0]..end].to_vec(),
                                    speaker: source.speaker,
                                    cited: source.cited,
                                    question,
                                    repaired_deadline: None,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                let mut repaired_anchor = None;
                if let (Some(anchor), Some(date)) = (
                    &previous,
                    date_only_repair(&tokens, &literal_words, question),
                ) {
                    let dates = recognized_deadlines(action, anchor);
                    if let [(date_at, _)] = dates.as_slice() {
                        let mut repaired = anchor.clone();
                        repaired.repaired_deadline = Some((*date_at, date));
                        repaired_anchor = Some(repaired.clone());
                        result.push(repaired);
                    }
                }
                previous = repaired_anchor.or_else(|| {
                    if current.len() == 1 && unambiguous_repair_anchor(action, &current[0], &tokens)
                    {
                        Some(current[0].clone())
                    } else {
                        None
                    }
                });
                result.extend(current);
            }
            result
        })
        .collect()
}

fn unambiguous_repair_anchor(action: &Action, clause: &Clause<'_>, sentence: &[String]) -> bool {
    let dates = recognized_deadlines(action, clause);
    let [(date_at, date)] = dates.as_slice() else {
        return false;
    };
    // A terse repair cannot safely retarget a trailing claim, purpose or
    // condition. Keep the original evidence when the anchor is not terminal.
    *date_at + date.len() == clause.words.len()
        && pending(clause)
        && !clause.question
        && !clause.literal_words[..=clause.action_at]
            .iter()
            .any(|literal| *literal)
        && sentence.iter().filter(|word| auxiliary(word)).count() <= 1
        && !sentence.iter().any(|word| {
            matches!(
                word.as_str(),
                "and" | "or" | "but" | "then" | "while" | "also" | "plus" | ","
            )
        })
}

fn date_only_repair(tokens: &[String], literals: &[bool], question: bool) -> Option<Vec<String>> {
    if question
        || literals.iter().any(|literal| *literal)
        || !tokens
            .first()
            .is_some_and(|word| matches!(word.as_str(), "actually" | "correction"))
    {
        return None;
    }
    let mut start = 1;
    if tokens
        .get(start)
        .is_some_and(|word| matches!(word.as_str(), ":" | ","))
    {
        start += 1;
    }
    if tokens
        .get(start)
        .is_some_and(|word| matches!(word.as_str(), "by" | "on"))
    {
        start += 1;
    }
    let date = &tokens[start..];
    let recognized = match date {
        [word] => temporal_word(word),
        [modifier, word] => {
            matches!(modifier.as_str(), "next" | "this" | "coming")
                && (temporal_word(word) || matches!(word.as_str(), "week" | "month" | "year"))
        }
        _ => false,
    };
    recognized.then(|| date.to_vec())
}

fn contains_words(haystack: &[String], needle: &[String]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn possible(clause: &Clause<'_>) -> bool {
    if clause.question {
        return true;
    }
    let prefix = &clause.words[..clause.action_at];
    prefix
        .iter()
        .rev()
        .take(5)
        .find(|word| {
            matches!(
                word.as_str(),
                "will"
                    | "ll"
                    | "can"
                    | "could"
                    | "might"
                    | "may"
                    | "should"
                    | "would"
                    | "able"
                    | "offer"
                    | "offers"
                    | "offered"
                    | "offering"
            )
        })
        .is_some_and(|word| !matches!(word.as_str(), "will" | "ll"))
}

fn past_only(clause: &Clause<'_>) -> bool {
    // Keep the original verb: normalization alone loses the distinction
    // between "sent" and "send". A past omission also supplies no commitment.
    let past = matches!(
        clause.words[clause.action_at].as_str(),
        "sent"
            | "shared"
            | "uploaded"
            | "reviewed"
            | "booked"
            | "scheduled"
            | "delivered"
            | "deployed"
            | "approved"
            | "finished"
            | "completed"
            | "provided"
            | "prepared"
            | "wrote"
            | "took"
    );
    past && !clause.words[..clause.action_at]
        .iter()
        .rev()
        .take(5)
        .any(|word| auxiliary(word) || word == "please")
}

fn pending(clause: &Clause<'_>) -> bool {
    !possible(clause) && !past_only(clause)
}

fn blocker(clause: &Clause<'_>) -> bool {
    clause.words[..clause.action_at]
        .iter()
        .rev()
        .take(4)
        .any(|word| matches!(word.as_str(), "not" | "don" | "won" | "cannot" | "can"))
        && !possible(clause)
}

fn conditions(clause: &Clause<'_>) -> Vec<Vec<String>> {
    let mut result = Vec::new();
    if let Some(at) = clause.words[clause.action_at + 1..]
        .iter()
        .position(|word| condition_word(word))
    {
        result.push(
            clause.words[clause.action_at + 1 + at..]
                .iter()
                .filter(|word| !matches!(word.as_str(), "," | ":"))
                .cloned()
                .collect(),
        );
    }
    // A leading condition ends before the commitment subject and auxiliary.
    if clause
        .words
        .first()
        .is_some_and(|word| condition_word(word))
    {
        if let Some(aux) = clause.words[..clause.action_at]
            .iter()
            .rposition(|word| matches!(word.as_str(), "will" | "ll"))
        {
            if aux > 1 {
                result.push(
                    clause.words[..aux - 1]
                        .iter()
                        .filter(|word| !matches!(word.as_str(), "," | ":"))
                        .cloned()
                        .collect(),
                );
            }
        }
    }
    result
}

pub(super) fn task_needs_review(task: &str, sources: &[Source<'_>]) -> bool {
    let Some(action) = action(task) else {
        return true;
    };
    let clauses = matching_clauses(&action, sources);
    let cited: Vec<_> = clauses.iter().filter(|clause| clause.cited).collect();
    // Membership in this schema claims a pending commitment even when the
    // task itself uses an imperative rather than "will".
    if !cited.iter().any(|clause| pending(clause)) {
        return true;
    }
    let task_words = words(task);
    clauses
        .iter()
        .filter(|clause| pending(clause))
        .any(|clause| {
            let qualifiers = conditions(clause);
            let lost_condition = qualifiers.iter().any(|condition| {
                !(contains_words(&task_words, condition)
                    || blocker(clause)
                        && condition.first().is_some_and(|word| word == "unless")
                        && contains_words(&task_words, &words("only if"))
                        && contains_words(&task_words, &condition[1..]))
            });
            let lost_blocker = blocker(clause)
                && !task_words
                    .iter()
                    .any(|word| matches!(word.as_str(), "not" | "don" | "cannot"))
                && (qualifiers.is_empty() || !contains_words(&task_words, &words("only if")));
            // A passage cut off mid-condition repeats a prefix of the cited
            // condition. That is the same condition, not another one.
            let uncited_condition = !clause.cited
                && !qualifiers.is_empty()
                && qualifiers.iter().any(|condition| {
                    !cited.iter().any(|source| {
                        conditions(source)
                            .iter()
                            .any(|original| original.starts_with(condition))
                    })
                });
            lost_condition || lost_blocker || uncited_condition
        })
}

pub(super) fn owner_supported(task: &str, owner: &str, sources: &[Source<'_>]) -> bool {
    let Some(action) = action(task) else {
        return false;
    };
    let owner = words(owner);
    if owner.is_empty() {
        return false;
    }
    let clauses = matching_clauses(&action, sources);
    clauses.iter().enumerate().any(|(at, clause)| {
        clause.cited
            && pending(clause)
            && clause_names_owner(clause, &owner)
            && !clauses[at + 1..].iter().any(|later| {
                explicit_owner_correction(later)
                    && same_deliverable(clause, later)
                    && !clause_names_owner(later, &owner)
            })
    })
}

fn clause_names_owner(clause: &Clause<'_>, owner: &[String]) -> bool {
    let prefix = &clause.words[..clause.action_at];
    let subject_end = prefix
        .iter()
        .rposition(|word| {
            matches!(
                word.as_str(),
                "will" | "ll" | "won" | "can" | "could" | "might" | "may"
            )
        })
        .unwrap_or(prefix.len());
    let subject = &prefix[..subject_end];
    if subject.last().is_some_and(|word| word == "i") {
        return clause.speaker.is_some_and(|speaker| {
            let name = words(speaker);
            owner.iter().all(|word| name.contains(word))
        });
    }
    // Reporting names precede the actual commitment subject.
    let start = subject
        .iter()
        .rposition(|word| {
            matches!(
                word.as_str(),
                "that"
                    | "and"
                    | "or"
                    | "but"
                    | "said"
                    | "says"
                    | "say"
                    | "tells"
                    | "told"
                    | "reports"
                    | "reported"
                    | "thinks"
                    | "think"
                    | "believes"
                    | "believe"
                    | "agrees"
                    | "agree"
                    | ","
                    | ":"
            )
        })
        .map_or(0, |at| at + 1);
    let subject = &subject[start..];
    subject.ends_with(owner) || (subject.len() <= 2 && subject.starts_with(owner))
}

fn same_deliverable(first: &Clause<'_>, later: &Clause<'_>) -> bool {
    let objects = |clause: &Clause<'_>| {
        let mut objects = object_words(&clause.words[clause.action_at + 1..]);
        objects.remove("instead");
        // ISO dates are deadline metadata, like the weekdays already excluded
        // by object_words, rather than part of the deliverable identity.
        objects.retain(|word| !valid_iso_date(word));
        objects
    };
    objects(first) == objects(later)
}

fn explicit_owner_correction(clause: &Clause<'_>) -> bool {
    if clause.question
        || past_only(clause)
        || blocker(clause)
        || clause.literal_words[clause.action_at]
    {
        return false;
    }
    let prefix = &clause.words[..clause.action_at];
    let cue = prefix.first().is_some_and(|word| {
        !clause.literal_words[0] && matches!(word.as_str(), "correction" | "actually")
    }) || clause.words[clause.action_at + 1..]
        .iter()
        .enumerate()
        .any(|(at, word)| word == "instead" && !clause.literal_words[clause.action_at + 1 + at]);
    if !cue {
        return false;
    }
    let Some(aux) = prefix.iter().rposition(|word| {
        matches!(
            word.as_str(),
            "will" | "ll" | "won" | "can" | "could" | "might" | "may"
        )
    }) else {
        return false;
    };
    let start = prefix[..aux]
        .iter()
        .rposition(|word| matches!(word.as_str(), ":" | "," | "correction" | "actually"))
        .map_or(0, |at| at + 1);
    let subject = &prefix[start..aux];
    if clause.literal_words[start..=aux]
        .iter()
        .any(|literal| *literal)
    {
        return false;
    }
    // Only an explicitly named replacement, or a named first-person speaker,
    // can supersede another owner. Two ordinary commitments remain independent.
    if subject == ["i"] {
        return clause
            .speaker
            .is_some_and(|speaker| !words(speaker).is_empty());
    }
    !subject.is_empty()
        && subject.len() <= 3
        && subject.iter().all(|word| {
            !matches!(
                word.as_str(),
                "we" | "you" | "he" | "she" | "they" | "someone" | "anyone" | "not"
            )
        })
}

fn clause_supports_deadline(action: &Action, clause: &Clause<'_>, date: &[String]) -> bool {
    if date.is_empty() {
        return false;
    }
    if let Some((_, replacement)) = &clause.repaired_deadline {
        return date == replacement;
    }
    let start = clause.action_at + 1;
    let tail = &clause.words[start..];
    let end = tail
        .iter()
        .position(|word| condition_word(word))
        .unwrap_or(tail.len());
    let tail = &tail[..end];
    tail.windows(date.len()).enumerate().any(|(at, window)| {
        if window != date
            || (at > 0 && matches!(tail[at - 1].as_str(), "not" | "never"))
            || (at > 0 && matches!(tail[at - 1].as_str(), "next" | "this" | "coming"))
            || tail.get(at + date.len()).is_some_and(|word| word == "s")
        {
            return false;
        }
        // "Monday's report" and "Monday report" name the object.
        // A date is either introduced explicitly or follows the object.
        let before = &tail[..at];
        before
            .last()
            .is_some_and(|word| matches!(word.as_str(), "by" | "on"))
            || action.objects.iter().all(|object| before.contains(object))
    })
}

fn valid_iso_date(word: &str) -> bool {
    if word.len() != 10
        || word.as_bytes()[4] != b'-'
        || word.as_bytes()[7] != b'-'
        || !word
            .bytes()
            .enumerate()
            .all(|(at, byte)| matches!(at, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = word[..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = word[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = word[8..].parse::<u32>() else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year != 0 && day > 0 && day <= days
}

fn temporal_word(word: &str) -> bool {
    matches!(
        word,
        "monday"
            | "tuesday"
            | "wednesday"
            | "thursday"
            | "friday"
            | "saturday"
            | "sunday"
            | "today"
            | "tomorrow"
            | "tonight"
    ) || valid_iso_date(word)
}

fn recognized_deadlines(action: &Action, clause: &Clause<'_>) -> Vec<(usize, Vec<String>)> {
    if let Some(replacement) = &clause.repaired_deadline {
        return vec![replacement.clone()];
    }
    let mut result = Vec::new();
    let start = clause.action_at + 1;
    let end = clause.words[start..]
        .iter()
        .position(|word| condition_word(word))
        .map_or(clause.words.len(), |at| start + at);
    let mut at = start;
    while at < end {
        let word = &clause.words[at];
        let modifier = matches!(word.as_str(), "next" | "this" | "coming");
        let count = if modifier
            && clause.words.get(at + 1).is_some_and(|word| {
                temporal_word(word) || matches!(word.as_str(), "week" | "month" | "year")
            })
            && at + 1 < end
        {
            2
        } else if temporal_word(word) {
            1
        } else {
            at += 1;
            continue;
        };
        let date = clause.words[at..at + count].to_vec();
        if clause_supports_deadline(action, clause, &date) {
            result.push((at, date));
        }
        at += count;
    }
    result
}

fn deadline_is_superseded(action: &Action, first: &Clause<'_>, later: &Clause<'_>) -> bool {
    if later.repaired_deadline.is_none() && !explicit_owner_correction(later) {
        return false;
    }
    let first_dates = recognized_deadlines(action, first);
    let later_dates = recognized_deadlines(action, later);
    // Missing or ambiguous dates cannot establish a replacement. In particular,
    // an owner-only correction does not silently erase the existing deadline.
    let ([(first_at, first_date)], [(later_at, later_date)]) =
        (first_dates.as_slice(), later_dates.as_slice())
    else {
        return false;
    };
    let objects =
        |clause: &Clause<'_>, end: usize| object_words(&clause.words[clause.action_at + 1..end]);
    first_date != later_date && objects(first, *first_at) == objects(later, *later_at)
}

pub(super) fn deadline_supported(task: &str, deadline: &str, sources: &[Source<'_>]) -> bool {
    let Some(action) = action(task) else {
        return false;
    };
    let date = words(deadline);
    if date.is_empty() {
        return false;
    }
    let clauses = matching_clauses(&action, sources);
    clauses.iter().enumerate().any(|(at, clause)| {
        clause.cited
            && pending(clause)
            && clause_supports_deadline(&action, clause, &date)
            && !clauses[at + 1..]
                .iter()
                .any(|later| deadline_is_superseded(&action, clause, later))
    })
}

#[cfg(test)]
mod tests {
    use super::{deadline_supported, owner_supported, task_needs_review, Source};

    #[test]
    fn summary_does_not_move_a_condition_to_an_independent_task() {
        let sources = [Source {
            text: "We agreed to ship the beta if QA passes, and Kim will review the notes.",
            speaker: None,
            cited: true,
        }];
        assert!(super::summary_task_needs_review(
            "Kim will review the notes if QA passes.",
            &sources
        ));
        assert!(!super::summary_task_needs_review(
            "Kim will review the notes.",
            &sources
        ));
        assert!(!super::summary_task_needs_review(
            "We will ship the beta if QA passes.",
            &sources
        ));
    }

    fn cited(text: &str) -> Source<'_> {
        Source {
            text,
            speaker: None,
            cited: true,
        }
    }

    #[test]
    fn past_work_and_omissions_do_not_support_pending_tasks() {
        for source in [
            "Mara sent the invoice Friday.",
            "Mara has already sent the invoice Friday.",
            "Mara has not sent the invoice Friday.",
            "Mara hasn't sent the invoice Friday.",
            "Mara never sent the invoice Friday.",
        ] {
            let sources = [cited(source)];
            assert!(task_needs_review("Send the invoice", &sources), "{source}");
            assert!(
                !owner_supported("Send the invoice", "Mara", &sources),
                "{source}"
            );
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{source}"
            );
        }
        for (source, task) in [
            ("Mara shared the report Friday.", "Share the report"),
            ("Mara reviewed the report Friday.", "Review the report"),
            ("Mara has written the report Friday.", "Write the report"),
            ("Mara has taken the report Friday.", "Take the report"),
            ("Mara fixed the bug Friday.", "Fix the bug"),
            ("Mara has fixed the bug Friday.", "Fix the bug"),
            (
                "Mara checked the configuration Friday.",
                "Check the configuration",
            ),
            (
                "Mara had checked the configuration Friday.",
                "Check the configuration",
            ),
        ] {
            let sources = [cited(source)];
            assert!(task_needs_review(task, &sources), "{source}");
            assert!(!owner_supported(task, "Mara", &sources), "{source}");
            assert!(!deadline_supported(task, "Friday", &sources), "{source}");
        }
    }

    #[test]
    fn future_commitments_and_requests_remain_pending() {
        for source in [
            "Mara will send the invoice Friday.",
            "Mara will have sent the invoice Friday.",
            "Mara sends the invoice Friday.",
        ] {
            let sources = [cited(source)];
            assert!(!task_needs_review("Send the invoice", &sources), "{source}");
            assert!(
                owner_supported("Send the invoice", "Mara", &sources),
                "{source}"
            );
            assert!(
                deadline_supported("Send the invoice", "Friday", &sources),
                "{source}"
            );
        }
        for source in [
            "Send the invoice Friday.",
            "Please send the invoice Friday.",
        ] {
            let sources = [cited(source)];
            assert!(!task_needs_review("Send the invoice", &sources), "{source}");
            assert!(
                deadline_supported("Send the invoice", "Friday", &sources),
                "{source}"
            );
        }
    }

    #[test]
    fn repeated_task_uses_its_new_cited_commitment() {
        for past in [
            "Mara sent the invoice Friday if legal approved.",
            "Mara has not sent the invoice Friday.",
        ] {
            let sources = [cited(past), cited("Noah will send the invoice Monday.")];
            assert!(!task_needs_review("Send the invoice", &sources), "{past}");
            assert!(
                !owner_supported("Send the invoice", "Mara", &sources),
                "{past}"
            );
            assert!(
                owner_supported("Send the invoice", "Noah", &sources),
                "{past}"
            );
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{past}"
            );
            assert!(
                deadline_supported("Send the invoice", "Monday", &sources),
                "{past}"
            );
        }
        let sources = [
            cited("Mara sent the invoice Friday."),
            Source {
                cited: false,
                ..cited("Noah will send the invoice Monday.")
            },
        ];
        assert!(task_needs_review("Send the invoice", &sources));
        assert!(!owner_supported("Send the invoice", "Noah", &sources));
        assert!(!deadline_supported("Send the invoice", "Monday", &sources));

        let sources = [
            cited("Mara hasn't sent the invoice Friday."),
            cited("Please send the invoice Monday."),
        ];
        assert!(!task_needs_review("Send the invoice", &sources));
        assert!(deadline_supported("Send the invoice", "Monday", &sources));
        assert!(!owner_supported("Send the invoice", "Mara", &sources));

        let sources = [cited(
            "Mara sent the invoice Friday and Noah will send the invoice Monday.",
        )];
        assert!(!task_needs_review("Send the invoice", &sources));
        assert!(owner_supported("Send the invoice", "Noah", &sources));
        assert!(deadline_supported("Send the invoice", "Monday", &sources));
        assert!(!deadline_supported("Send the invoice", "Friday", &sources));
    }

    #[test]
    fn explicit_owner_reassignment_invalidates_old_owner_with_identical_due_date() {
        for correction in [
            "Correction: Noah will send the invoice Friday.",
            "Actually, Noah will send the invoice Friday.",
            "Noah will send the invoice Friday instead.",
        ] {
            let sources = [
                cited("Mara will send the invoice Friday."),
                cited(correction),
            ];
            assert!(
                !owner_supported("Send the invoice", "Mara", &sources),
                "{correction}"
            );
            assert!(
                owner_supported("Send the invoice", "Noah", &sources),
                "{correction}"
            );
        }
    }

    #[test]
    fn replacement_owner_requires_its_correction_citation() {
        let sources = [
            cited("Mara will send the invoice Friday."),
            Source {
                cited: false,
                ..cited("Correction: Noah will send the invoice Friday.")
            },
        ];
        assert!(!owner_supported("Send the invoice", "Mara", &sources));
        assert!(!owner_supported("Send the invoice", "Noah", &sources));
    }

    #[test]
    fn conditional_and_uncertain_owner_corrections_do_not_restore_old_owner() {
        let conditional = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Noah will send the invoice Friday if legal approves."),
        ];
        assert!(!owner_supported("Send the invoice", "Mara", &conditional));
        assert!(owner_supported(
            "Send the invoice if legal approves",
            "Noah",
            &conditional
        ));
        assert!(task_needs_review("Send the invoice", &conditional));
        let uncertain = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Noah might send the invoice Friday instead."),
        ];
        assert!(!owner_supported("Send the invoice", "Mara", &uncertain));
        assert!(!owner_supported("Send the invoice", "Noah", &uncertain));
    }

    #[test]
    fn owner_correction_only_supersedes_earlier_matching_commitments() {
        let reverse = [
            cited("Correction: Noah will send the invoice Friday."),
            cited("Mara will send the invoice Friday."),
        ];
        assert!(owner_supported("Send the invoice", "Mara", &reverse));
        assert!(owner_supported("Send the invoice", "Noah", &reverse));
        let different = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Noah will send the invoice reminder Friday."),
        ];
        assert!(owner_supported("Send the invoice", "Mara", &different));
    }

    #[test]
    fn rejected_literal_owner_corrections_do_not_supersede_commitments() {
        for example in [
            "\"Correction: Noah will send the invoice Friday.\" We rejected that wording.",
            "“Correction: Noah will send the invoice Friday.” We rejected that wording.",
            "`Correction: Noah will send the invoice Friday.` We rejected that wording.",
            "“An example. Correction: Noah will send the invoice Friday. Another sentence.” We rejected that wording.",
            "Préface: \"An example. Correction: Noah will send the invoice Friday.\" We rejected that wording.",
        ] {
            let sources = [cited("Mara will send the invoice Friday."), cited(example)];
            assert!(owner_supported("Send the invoice", "Mara", &sources), "{example}");
        }
    }

    #[test]
    fn literal_correction_cue_subject_or_action_does_not_reassign_owner() {
        for example in [
            "\"Correction\": Noah will send the invoice Friday.",
            "Correction: \"Noah\" will send the invoice Friday.",
            "Correction: Noah will \"send\" the invoice Friday.",
        ] {
            let sources = [cited("Mara will send the invoice Friday."), cited(example)];
            assert!(
                owner_supported("Send the invoice", "Mara", &sources),
                "{example}"
            );
        }
    }

    #[test]
    fn asserted_owner_correction_after_closed_literal_remains_effective() {
        for correction in [
            "“A rejected example. Another sentence.” Correction: Noah will send the invoice Friday.",
            "`A rejected example. Another sentence.` Correction: Noah will send the invoice Friday.",
            "\"A rejected example. Another sentence.\" Correction: Noah will send the invoice Friday.",
            "Correction: Noah will send the \"invoice\" Friday.",
        ] {
            let sources = [cited("Mara will send the invoice Friday."), cited(correction)];
            assert!(!owner_supported("Send the invoice", "Mara", &sources), "{correction}");
            assert!(owner_supported("Send the invoice", "Noah", &sources), "{correction}");
        }
    }

    #[test]
    fn independent_owner_commitments_remain_supported() {
        let sources = [
            cited("Mara will send the invoice Friday."),
            cited("Noah will send the invoice Friday."),
        ];
        assert!(owner_supported("Send the invoice", "Mara", &sources));
        assert!(owner_supported("Send the invoice", "Noah", &sources));
    }

    #[test]
    fn explicit_deadline_correction_invalidates_old_date_and_requires_replacement_citation() {
        let original = cited("Mara will send the invoice Friday.");
        for correction in [
            "Correction: Mara will send the invoice Monday instead.",
            "Actually, Mara will send the invoice by Monday.",
        ] {
            let sources = [
                Source { ..original },
                Source {
                    cited: false,
                    ..cited(correction)
                },
            ];
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{correction}"
            );
            assert!(
                !deadline_supported("Send the invoice", "Monday", &sources),
                "{correction}"
            );
            let sources = [Source { ..original }, cited(correction)];
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{correction}"
            );
            assert!(
                deadline_supported("Send the invoice", "Monday", &sources),
                "{correction}"
            );
        }
    }

    #[test]
    fn deadline_corrections_preserve_owner_only_and_same_date_changes() {
        for correction in [
            "Correction: Noah will send the invoice Friday instead.",
            "Correction: Noah will send the invoice instead.",
            "Correction: Mara will send the invoice carefully instead.",
        ] {
            let sources = [
                cited("Mara will send the invoice Friday."),
                cited(correction),
            ];
            assert!(
                deadline_supported("Send the invoice", "Friday", &sources),
                "{correction}"
            );
        }
    }

    #[test]
    fn conditional_and_uncertain_deadline_corrections_do_not_restore_old_due_date() {
        for correction in [
            "Correction: Mara will send the invoice Monday if legal approves.",
            "Correction: Mara might send the invoice Monday instead.",
        ] {
            let sources = [
                cited("Mara will send the invoice Friday."),
                cited(correction),
            ];
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{correction}"
            );
        }
        let uncertain = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Mara might send the invoice Monday instead."),
        ];
        assert!(!deadline_supported(
            "Send the invoice",
            "Monday",
            &uncertain
        ));
        let conditional = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Mara will send the invoice Monday if legal approves."),
        ];
        assert!(deadline_supported(
            "Send the invoice if legal approves",
            "Monday",
            &conditional
        ));
        assert!(task_needs_review("Send the invoice", &conditional));
    }

    #[test]
    fn deadline_corrections_respect_chronology_and_deliverable_identity() {
        for sources in [
            [
                cited("Correction: Mara will send the invoice Monday instead."),
                cited("Mara will send the invoice Friday."),
            ],
            [
                cited("Mara will send the invoice Friday."),
                cited("Mara will send the invoice Monday."),
            ],
            [
                cited("Mara will send the invoice Friday."),
                cited("Correction: Mara will send the invoice reminder Monday instead."),
            ],
        ] {
            assert!(deadline_supported("Send the invoice", "Friday", &sources));
        }
    }

    #[test]
    fn quoted_deadline_corrections_do_not_supersede_asserted_dates() {
        for example in [
            "\"Correction: Mara will send the invoice Monday instead.\" We rejected that wording.",
            "“Correction: Mara will send the invoice Monday instead.” We rejected that wording.",
            "`Correction: Mara will send the invoice Monday instead.` We rejected that wording.",
            "Préface: “An example. Correction: Mara will send the invoice Monday instead. Another sentence.” We rejected it.",
        ] {
            let sources = [cited("Mara will send the invoice Friday."), cited(example)];
            assert!(deadline_supported("Send the invoice", "Friday", &sources), "{example}");
        }
        let sources = [cited("Mara will send the invoice Friday."), cited("“An example. Another sentence.” Correction: Mara will send the invoice Monday instead.")];
        assert!(!deadline_supported("Send the invoice", "Friday", &sources));
        assert!(deadline_supported("Send the invoice", "Monday", &sources));
    }

    #[test]
    fn quoted_deadline_values_remain_supported_in_asserted_commitments() {
        for source in [
            "Mara will send the invoice by 'Friday'.",
            "Mara will send the invoice by \"Friday\".",
            "Mara will send the invoice by “Friday”.",
        ] {
            assert!(
                deadline_supported("Send the invoice", "Friday", &[cited(source)]),
                "{source}"
            );
        }
        let sources = [
            cited("Mara will send the invoice Friday."),
            cited("Correction: Mara will send the invoice by 'Monday' instead."),
        ];
        assert!(!deadline_supported("Send the invoice", "Friday", &sources));
        assert!(deadline_supported("Send the invoice", "Monday", &sources));
    }

    #[test]
    fn invalid_iso_deadlines_do_not_supersede_existing_dates() {
        for date in [
            "2026-99-88",
            "2026-00-12",
            "2026-10-00",
            "2026-04-31",
            "2026-02-29",
            "1900-02-29",
            "0000-01-01",
        ] {
            let correction = format!("Correction: Mara will send the invoice by {date} instead.");
            let sources = [
                cited("Mara will send the invoice Friday."),
                cited(&correction),
            ];
            assert!(
                deadline_supported("Send the invoice", "Friday", &sources),
                "{date}"
            );
        }
        for date in ["2024-02-29", "2000-02-29", "2026-04-30"] {
            let correction = format!("Correction: Mara will send the invoice by {date} instead.");
            let sources = [
                cited("Mara will send the invoice Friday."),
                cited(&correction),
            ];
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{date}"
            );
            assert!(
                deadline_supported("Send the invoice", date, &sources),
                "{date}"
            );
        }
    }

    #[test]
    fn iso_deadline_changes_preserve_deliverable_identity_for_owner_corrections() {
        let sources = [
            cited("Mara will send the invoice 2026-10-16."),
            cited("Correction: Noah will send the invoice 2026-10-19 instead."),
        ];
        assert!(!owner_supported("Send the invoice", "Mara", &sources));
        assert!(owner_supported("Send the invoice", "Noah", &sources));
        assert!(!deadline_supported(
            "Send the invoice",
            "2026-10-16",
            &sources
        ));
        assert!(deadline_supported(
            "Send the invoice",
            "2026-10-19",
            &sources
        ));
        let different = [
            cited("Mara will send the invoice 2026-10-16."),
            cited("Correction: Noah will send the invoice reminder 2026-10-19 instead."),
        ];
        assert!(owner_supported("Send the invoice", "Mara", &different));
        assert!(deadline_supported(
            "Send the invoice",
            "2026-10-16",
            &different
        ));
    }

    #[test]
    fn deadline_corrections_recognize_iso_dates_and_relative_weekdays() {
        for (first, later, old_date, new_date) in [
            (
                "Mara will send the invoice by 2026-10-16.",
                "Correction: Mara will send the invoice by 2026-10-19 instead.",
                "2026-10-16",
                "2026-10-19",
            ),
            (
                "Mara will send the invoice Monday.",
                "Correction: Mara will send the invoice next Monday instead.",
                "Monday",
                "next Monday",
            ),
            (
                "Mara will send the invoice this Monday.",
                "Correction: Mara will send the invoice next Monday instead.",
                "this Monday",
                "next Monday",
            ),
            (
                "Mara will send the invoice today.",
                "Correction: Mara will send the invoice tomorrow instead.",
                "today",
                "tomorrow",
            ),
        ] {
            let sources = [cited(first), cited(later)];
            assert!(
                !deadline_supported("Send the invoice", old_date, &sources),
                "{first} / {later}"
            );
            assert!(
                deadline_supported("Send the invoice", new_date, &sources),
                "{first} / {later}"
            );
        }
    }

    #[test]
    fn adjacent_same_source_date_only_repair_replaces_the_cited_deadline() {
        for text in [
            "Mara will send the invoice Friday. Actually Monday.",
            "Mara will send the invoice Friday. Correction: by Monday.",
            "Mara will send the invoice Friday. Actually next Monday.",
        ] {
            let date = if text.contains("next Monday") {
                "next Monday"
            } else {
                "Monday"
            };
            assert!(
                !deadline_supported("Send the invoice", "Friday", &[cited(text)]),
                "{text}"
            );
            assert!(
                deadline_supported("Send the invoice", date, &[cited(text)]),
                "{text}"
            );
            assert!(
                owner_supported("Send the invoice", "Mara", &[cited(text)]),
                "{text}"
            );
            let uncited = [Source {
                cited: false,
                ..cited(text)
            }];
            assert!(
                !deadline_supported("Send the invoice", date, &uncited),
                "{text}"
            );
        }
    }

    #[test]
    fn chained_same_source_date_only_repairs_keep_only_the_final_deadline() {
        for (text, intermediate, final_date) in [
            (
                "Mara will send the invoice Friday. Actually Monday. Correction Tuesday.",
                "Monday",
                "Tuesday",
            ),
            (
                "Mara will send the invoice Friday. Actually next Monday. Correction 2026-10-20.",
                "next Monday",
                "2026-10-20",
            ),
            (
                "Mara will send the invoice Friday. Actually 2026-10-20. Correction next Tuesday.",
                "2026-10-20",
                "next Tuesday",
            ),
        ] {
            let sources = [cited(text)];
            assert!(
                !deadline_supported("Send the invoice", "Friday", &sources),
                "{text}"
            );
            assert!(
                !deadline_supported("Send the invoice", intermediate, &sources),
                "{text}"
            );
            assert!(
                deadline_supported("Send the invoice", final_date, &sources),
                "{text}"
            );
            assert!(
                owner_supported("Send the invoice", "Mara", &sources),
                "{text}"
            );
            let uncited = [Source {
                cited: false,
                ..cited(text)
            }];
            assert!(
                !deadline_supported("Send the invoice", final_date, &uncited),
                "{text}"
            );
        }
    }

    #[test]
    fn unrelated_or_rejected_sentences_break_date_only_repair_chains() {
        for text in [
            "Mara will send the invoice Friday. Actually Monday. We discussed lunch. Correction Tuesday.",
            "Mara will send the invoice Friday. Actually Monday. Correction Tuesday? Correction Wednesday.",
            "Mara will send the invoice Friday. Actually Monday. \"Correction Tuesday.\" Correction Wednesday.",
        ] {
            let sources = [cited(text)];
            assert!(!deadline_supported("Send the invoice", "Friday", &sources), "{text}");
            assert!(deadline_supported("Send the invoice", "Monday", &sources), "{text}");
            assert!(!deadline_supported("Send the invoice", "Tuesday", &sources), "{text}");
            assert!(!deadline_supported("Send the invoice", "Wednesday", &sources), "{text}");
        }
        let sources = [
            cited("Mara will send the invoice Friday. Actually Monday."),
            cited("Correction Tuesday."),
        ];
        assert!(deadline_supported("Send the invoice", "Monday", &sources));
        assert!(!deadline_supported("Send the invoice", "Tuesday", &sources));
    }

    #[test]
    fn date_only_repair_declines_literals_questions_invalid_dates_and_extra_claims() {
        for repair in [
            "\"Actually Monday.\"",
            "“Actually Monday.”",
            "`Actually Monday.`",
            "Actually 'Monday'.",
            "Actually Monday?",
            "Actually 2026-99-88.",
            "Actually Monday or Tuesday.",
            "Actually Monday, Noah agreed.",
            "Actually Monday instead of Friday.",
        ] {
            let text = format!("Mara will send the invoice Friday. {repair}");
            assert!(
                deadline_supported("Send the invoice", "Friday", &[cited(&text)]),
                "{text}"
            );
            assert!(
                !deadline_supported("Send the invoice", "Monday", &[cited(&text)]),
                "{text}"
            );
        }
    }

    #[test]
    fn date_only_repair_requires_immediate_unambiguous_same_source_anchor() {
        for text in [
            "Mara will send the invoice Friday. We discussed lunch. Actually Monday.",
            "Mara will send the invoice and the report Friday. Actually Monday.",
            "Mara will send the invoice Friday and Noah will book the room Tuesday. Actually Monday.",
            "Mara will send the invoice Friday, book the room Tuesday. Actually Monday.",
            "Mara will send the invoice Friday while Noah books the room. Actually Monday.",
            "Mara will send the invoice Friday also Noah books the room. Actually Monday.",
            "Mara will send the invoice Friday plus Noah books the room. Actually Monday.",
            "Mara will send the invoice while Noah books the room Friday. Actually Monday.",
            "Mara will send the invoice Friday Noah books the room. Actually Monday.",
            "Mara will send the invoice Friday to remind the customer. Actually Monday.",
            "Mara will send the invoice Friday if legal approves. Actually Monday.",
            "\"Mara will send the invoice Friday.\" Actually Monday.",
        ] {
            assert!(deadline_supported("Send the invoice", "Friday", &[cited(text)]), "{text}");
            assert!(!deadline_supported("Send the invoice", "Monday", &[cited(text)]), "{text}");
        }
        let sources = [
            cited("Mara will send the invoice Friday."),
            cited("Actually Monday."),
        ];
        assert!(deadline_supported("Send the invoice", "Friday", &sources));
        assert!(!deadline_supported("Send the invoice", "Monday", &sources));
        let speakers = [
            Source {
                speaker: Some("Mara"),
                ..cited("I will send the invoice Friday.")
            },
            Source {
                speaker: Some("Noah"),
                ..cited("Actually Monday.")
            },
        ];
        assert!(deadline_supported("Send the invoice", "Friday", &speakers));
        assert!(!deadline_supported("Send the invoice", "Monday", &speakers));
    }

    #[test]
    fn date_only_repair_preserves_unicode_offsets_and_ordinary_quoted_dates() {
        let text = "Zoë will send the invoice by 'Friday'. Actually Monday.";
        assert!(!deadline_supported(
            "Send the invoice",
            "Friday",
            &[cited(text)]
        ));
        assert!(deadline_supported(
            "Send the invoice",
            "Monday",
            &[cited(text)]
        ));
        let literal = "Zoë will send the invoice by 'Friday'. “An example. Actually Monday.”";
        assert!(deadline_supported(
            "Send the invoice",
            "Friday",
            &[cited(literal)]
        ));
        assert!(!deadline_supported(
            "Send the invoice",
            "Monday",
            &[cited(literal)]
        ));
    }

    #[test]
    fn weekday_object_labels_do_not_support_deadlines() {
        for source in [
            "Mara will review Monday's report.",
            "Mara will review Monday’s report.",
            "Mara will review Monday report.",
        ] {
            let sources = [cited(source)];
            assert!(
                !task_needs_review("Review the report", &sources),
                "{source}"
            );
            assert!(
                owner_supported("Review the report", "Mara", &sources),
                "{source}"
            );
            assert!(
                !deadline_supported("Review the report", "Monday", &sources),
                "{source}"
            );
        }
        for source in [
            "Mara will review the report by Monday.",
            "Mara will review the report on Monday.",
            "Mara will review the report Monday.",
            "Mara will review Monday's report by Monday.",
        ] {
            assert!(
                deadline_supported("Review the report", "Monday", &[cited(source)]),
                "{source}"
            );
        }
        let sources = [cited("Mara will review Monday's report by Friday.")];
        assert!(!deadline_supported("Review the report", "Monday", &sources));
        assert!(deadline_supported("Review the report", "Friday", &sources));
        assert!(!deadline_supported("Review the report", "", &sources));

        for (source, date) in [
            ("Mara will review the report next Monday.", "next Monday"),
            ("Mara will review the report by 2026-10-12.", "2026-10-12"),
            ("Mara will review the report on 2026-10-12.", "2026-10-12"),
            ("Mara will review the report 2026-10-12.", "2026-10-12"),
        ] {
            assert!(
                deadline_supported("Review the report", date, &[cited(source)]),
                "{source}"
            );
        }
    }
}
