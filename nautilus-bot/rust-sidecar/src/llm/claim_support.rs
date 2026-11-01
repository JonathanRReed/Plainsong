//! Deterministic checks for narrow, high-confidence grounding failures.

use super::Citation;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const CURRENCY_REASON: &str = "currency_amount_not_cited";
const CURRENCY_RELATION_REASON: &str = "currency_relation_not_cited";
const PRICE_RECOMMENDATION_REASON: &str = "price_recommendation_not_cited";
const FINANCIAL_CERTAINTY_REASON: &str = "financial_uncertainty_lost";
const NEGATED_PREDICATE_REASON: &str = "negated_predicate_not_cited";
const NEGATED_IDENTITY_REASON: &str = "negated_identity_asserted";
const AGREEMENT_REASON: &str = "agreement_not_cited";
const TIME_REASON: &str = "clock_time_not_cited";
const CONDITIONAL_POLARITY_REASON: &str = "conditional_polarity_not_cited";

/// Conservatively require explicit prohibitions with conditions to survive intact.
/// This is a lexical coverage check, not a general entailment proof.
pub(crate) fn missing_blocking_details<'a>(
    summary: &str,
    mut sources: impl Iterator<Item = &'a str>,
) -> bool {
    static BLOCKER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:do\s+not|don['’]t|must\s+not|should\s+not|will\s+not|won['’]t|cannot|can['’]t)\b(?:[^.!?;\n]|\.[0-9])*?\b(?:if|unless|until)\s+(?:[^.!?;\n]|\.[0-9])+").expect("blocking condition pattern is valid")
    });
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?u)[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]")
            .expect("blocking token pattern is valid")
    });
    fn words(text: &str) -> Vec<String> {
        TOKEN
            .find_iter(text)
            .map(|word| word.as_str().to_lowercase())
            .filter(|word| !matches!(word.as_str(), "a" | "an" | "the"))
            .collect()
    }
    let summary = crate::text::itn::inverse_text_normalize(summary);
    let summary_words = words(&summary);
    sources.any(|source| {
        let source = crate::text::itn::inverse_text_normalize(source);
        BLOCKER.find_iter(&source).any(|blocker| {
            let tokens = words(blocker.as_str());
            !summary_words
                .windows(tokens.len())
                .any(|window| window == tokens)
        })
    })
}

/// Require explicit offline, account and upload constraints in a full recap.
/// Keep the complete source clause so qualifiers and conditions cannot be lost.
/// This deliberately does not select arbitrary negated or mandatory statements.
pub(crate) fn missing_privacy_requirements<'a>(
    summary: &str,
    mut sources: impl Iterator<Item = &'a str>,
) -> bool {
    static REQUIREMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
            r"(?iu)\b(?:",
            r"must\s+(?:work|run|operate|function)\b[^.!?;\n]*?\b(?:offline|without\s+(?:(?:an?|the)\s+)?account)\b",
            r"|must\s+not\s+require\s+(?:(?:an?|the)\s+)?account\b",
            r"|no\s+account\s+(?:is\s+)?required\b",
            r"|must\s+not\s+(?:automatically\s+)?upload\s+(?:recordings?|audio|transcripts?|data)\b",
            r")"
        )).expect("privacy requirement pattern is valid")
    });
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?u)[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]")
            .expect("privacy requirement token pattern is valid")
    });
    static REJECTED_PROPOSAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:rejected|discarded|(?:did\s+not|didn['’]t)\s+adopt)\s+(?:(?:the|a|an|this|that)\s+)?(?:proposal|idea|suggestion|recommendation)\s+that\b")
            .expect("rejected privacy proposal pattern is valid")
    });
    static PROPOSAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:proposal|idea|suggestion|recommendation)\s+that\b")
            .expect("privacy proposal pattern is valid")
    });
    static REJECTED_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:was|is|has\s+been)\s+(?:rejected|discarded|not\s+adopted)\b")
            .expect("rejected privacy proposal suffix is valid")
    });
    static NEW_ASSERTION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:but|so|instead|however)\b")
            .expect("privacy assertion boundary is valid")
    });
    static NEGATED_REJECTION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:not|never)\s+(?:(?:yet|actually|explicitly)\s+)?$")
            .expect("negated privacy rejection pattern is valid")
    });
    fn rejected_proposal(clause: &str, requirement: regex::Match<'_>) -> bool {
        if NEW_ASSERTION.is_match(requirement.as_str()) {
            return false;
        }
        let prefix = &clause[..requirement.start()];
        if REJECTED_PROPOSAL.find_iter(prefix).any(|rejection| {
            !NEGATED_REJECTION.is_match(&prefix[..rejection.start()])
                && !NEW_ASSERTION.is_match(&prefix[rejection.end()..])
        }) {
            return true;
        }
        // A passive rejection applies only to the same reported proposal.
        let suffix = &clause[requirement.end()..];
        PROPOSAL.find_iter(prefix).any(|proposal| {
            !NEW_ASSERTION.is_match(&prefix[proposal.end()..])
                && REJECTED_SUFFIX
                    .find_iter(suffix)
                    .any(|rejection| !NEW_ASSERTION.is_match(&suffix[..rejection.start()]))
        })
    }
    fn words(text: &str) -> Vec<String> {
        TOKEN
            .find_iter(text)
            .map(|word| word.as_str().to_lowercase())
            .filter(|word| !matches!(word.as_str(), "a" | "an" | "the"))
            .collect()
    }
    fn clauses(text: &str) -> impl Iterator<Item = &str> {
        let bytes = text.as_bytes();
        let mut offset = 0;
        text.split(move |character: char| {
            let index = offset;
            offset += character.len_utf8();
            let decimal_point = character == '.'
                && index > 0
                && bytes[index - 1].is_ascii_digit()
                && bytes.get(index + 1).is_some_and(u8::is_ascii_digit);
            matches!(character, '.' | '!' | '?' | ';' | '\n') && !decimal_point
        })
    }
    let summary = crate::text::itn::inverse_text_normalize(summary);
    let summary_clauses: Vec<_> = clauses(&summary)
        .map(|clause| words(clause.trim_start().trim_start_matches(['-', '*', '•'])))
        .collect();
    sources.any(|source| {
        let source = crate::text::itn::inverse_text_normalize(source);
        let missing = clauses(&source).any(|clause| {
            if !REQUIREMENT
                .find_iter(clause)
                .any(|requirement| !rejected_proposal(clause, requirement))
            {
                return false;
            }
            let tokens = words(clause);
            !summary_clauses
                .iter()
                .any(|summary_clause| summary_clause == &tokens)
        });
        missing
    })
}

fn reverses_negated_unless(claim: &str, citations: &[Citation]) -> bool {
    static UNLESS_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\s+unless\s+").expect("unless boundary pattern is valid")
    });
    static CONDITION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?u)[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]")
            .expect("condition token pattern is valid")
    });
    fn words(text: &str) -> Vec<String> {
        TOKEN_RE
            .find_iter(text)
            .map(|word| word.as_str().to_lowercase())
            .filter(|word| !matches!(word.as_str(), "a" | "an" | "the"))
            .collect()
    }
    fn condition_tokens(text: &str) -> Vec<String> {
        CONDITION_TOKEN_RE
            .find_iter(text)
            .map(|token| token.as_str().to_lowercase())
            .filter(|token| !matches!(token.as_str(), "a" | "an" | "the"))
            .collect()
    }
    fn clauses(text: &str) -> Vec<(&str, &str)> {
        let bytes = text.as_bytes();
        let mut offset = 0;
        text.split(|character: char| {
            let index = offset;
            offset += character.len_utf8();
            let decimal_point = character == '.'
                && index > 0
                && bytes[index - 1].is_ascii_digit()
                && bytes.get(index + 1).is_some_and(u8::is_ascii_digit);
            matches!(character, '.' | '!' | '?' | ';' | '\n') && !decimal_point
        })
        .filter_map(|clause| {
            let boundary = UNLESS_RE.find(clause)?;
            Some((&clause[..boundary.start()], &clause[boundary.end()..]))
        })
        .collect()
    }
    for (action, condition) in clauses(claim) {
        if !negated_predicates(action).is_empty() {
            continue;
        }
        let action_words = words(action);
        let condition_words = condition_tokens(condition);
        for citation in citations {
            let source = crate::text::itn::inverse_text_normalize(&citation.text);
            for (source_action, source_condition) in clauses(&source) {
                if condition_words != condition_tokens(source_condition) {
                    continue;
                }
                for negated_action in negated_predicates(source_action) {
                    let predicate = words(&negated_action);
                    if !predicate.is_empty()
                        && action_words
                            .windows(predicate.len())
                            .any(|window| window == predicate)
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn clock_times(text: &str) -> HashSet<(u8, u8, String)> {
    static CLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(?:^|[^\p{N}])(?P<hour>\d{1,2}):(?P<minute>\d{2})(?:\s*(?P<period>am|pm)\b)?(?:$|[^\p{N}])")
            .expect("clock time pattern is valid")
    });
    static SPACED_CLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(?:at|by|before|after)\s+(?P<hour>\d{1,2})[\t ]+(?P<minute>\d{2})(?:[\t ]*(?P<period>am|pm)\b)?[\t ]*(?:$|[.,!?;\n])")
            .expect("contextual spaced clock pattern is valid")
    });
    let mut times = HashSet::new();
    for pattern in [&*CLOCK_RE, &*SPACED_CLOCK_RE] {
        let mut offset = 0;
        while let Some(capture) = pattern.captures_at(text, offset) {
            // Keep the closing separator available as the next match's
            // opening boundary, including both endpoints of 3:30-4:30.
            offset = capture
                .name("period")
                .unwrap_or_else(|| capture.name("minute").unwrap())
                .end();
            let (Ok(hour), Ok(minute)) = (
                capture["hour"].parse::<u8>(),
                capture["minute"].parse::<u8>(),
            ) else {
                continue;
            };
            let period = capture
                .name("period")
                .map_or_else(String::new, |part| part.as_str().to_ascii_lowercase());
            if hour < 24 && minute < 60 && (period.is_empty() || (1..=12).contains(&hour)) {
                times.insert((hour, minute, period));
            }
        }
    }
    times
}

static AGREEMENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?iu)\b(?:(?P<speaker>speaker\s+[a-z0-9]+)\s+(?:agreed|decided|resolved)[,:]?|(?:we|they|(?:the\s+)?(?:group|team|participants|everyone))\s+(?:(?:all\s+)?(?:agreed|decided|resolved)|reached\s+(?:agreement|consensus))|it\s+was\s+(?:agreed|decided)|(?:a\s+)?consensus\s+was\s+reached|(?:the\s+)?(?:agreement|decision)\s+was\s+made\s+to)\s+(?P<action>[^.!?;\n]+)",
    )
    .expect("agreement pattern is valid")
});

static SYMBOL_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?x)(^|[^\p{{L}}\p{{N}}])(?P<unit>[$€£])\s*(?P<amount>{})(?P<after>$|[^\p{{L}}\p{{N}}])",
        NUMBER_PATTERN
    ))
    .expect("currency symbol prefix pattern is valid")
});
static SYMBOL_SUFFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?x)(^|[^\p{{L}}\p{{N}}])(?P<amount>{})\s*(?P<unit>[$€£])(?P<after>$|[^\p{{L}}\p{{N}}])",
        NUMBER_PATTERN
    ))
    .expect("currency symbol suffix pattern is valid")
});
static WORD_SUFFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?ix)(^|[^\p{{L}}\p{{N}}])(?P<amount>{}|a|an)\s+(?P<unit>dollars?|euros?|pounds?|usd|eur|gbp)(?P<after>$|[^\p{{L}}\p{{N}}])",
        NUMBER_PATTERN
    ))
    .expect("currency word suffix pattern is valid")
});
static CODE_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?ix)(^|[^\p{{L}}\p{{N}}])(?P<unit>usd|eur|gbp)\s+(?P<amount>{})(?P<after>$|[^\p{{L}}\p{{N}}])",
        NUMBER_PATTERN
    ))
    .expect("currency code prefix pattern is valid")
});
static WORD_COPULA_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?ix)(^|[^\p{{L}}\p{{N}}])(?:(?P<context>equivalent|price|cost|amount|total|value)[\t\x20]+in[\t\x20]+)?(?P<unit>dollars?|euros?|pounds?|usd|eur|gbp)[\t\x20]+(?:is|are|was|were)[\t\x20]+(?:(?:about|around|approximately|roughly)[\t\x20]+)?(?P<amount>{})(?P<after>$|[^\p{{L}}\p{{N}}])",
        NUMBER_PATTERN
    ))
    .expect("currency word copula prefix pattern is valid")
});
static MONETARY_CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?iu)(?:[$€£]|\b(?:currency|finance|financial|money|monetary|price|cost|dollars?|euros?|usd|eur|gbp)\b)",
    )
    .expect("monetary context pattern is valid")
});
static MASS_CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?iu)\b(?:mass|weight|weigh|weighs|weighed|kilogram|kilograms|kg|kgs|ounce|ounces|oz|stone)\b",
    )
    .expect("mass context pattern is valid")
});
static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?u)\p{L}[\p{L}\p{M}'’\-]*").expect("word token pattern is valid")
});
// Apostrophes and hyphens join word parts; closing quote marks are delimiters.
// Keep this scoped to negative phrases instead of changing other claim checks.
static NEGATION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?u)\p{L}[\p{L}\p{M}]*(?:['’\-][\p{L}\p{M}]+)*")
        .expect("negative word token pattern is valid")
});
static NEGATED_AUXILIARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?iu)\b(is|are|was|were|do|does|did|has|have|had|could|should|would|will|must)n['’]?t\b",
    )
    .expect("negated auxiliary pattern is valid")
});
static IRREGULAR_NEGATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?iu)\b(?:can['’]t|cannot|won['’]t)\b")
        .expect("irregular negation pattern is valid")
});

// Deliberately accepts only separators whose role is unambiguous. In
// particular, a malformed value such as `1,2,3` produces no claim to check.
const NUMBER_PATTERN: &str = r"(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)";

static CURRENCY_RELATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    let unit = r"(?:dollars?|euros?|pounds?|usd|eur|gbp)";
    let amount = format!(
        r"(?:[$€£][\t\x20]*{NUMBER_PATTERN}|{NUMBER_PATTERN}[\t\x20]*[$€£]|(?:{NUMBER_PATTERN}|a|an)[\t\x20]+{unit}|(?:usd|eur|gbp)[\t\x20]+{NUMBER_PATTERN})"
    );
    Regex::new(&format!(
        r"(?ix)(?:^|[^\p{{L}}\p{{N}}])(?P<left>{amount})[\t\x20]*(?:per|for[\t\x20]+each|would[\t\x20]+make|makes?|making|equals?|is|was|=)[\t\x20]*(?:(?:about|around|roughly|approximately)[\t\x20]+)?(?P<right>{amount}|{unit})(?:$|[^\p{{L}}\p{{N}}])"
    )).expect("currency relation pattern is valid")
});

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CurrencyAmount {
    unit: &'static str,
    amount: String,
}

// Repeated teen/tens words remain literal in the source transcript. For
// currency evidence, at least three identical amounts before a unit support
// that same amount; it must not become a sum, digit string, or different unit.
fn repeated_spoken_currency_amounts(text: &str) -> Vec<CurrencyAmount> {
    static REPEATED_AMOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)(?:^|[^\p{L}\p{N}])(?P<words>(?:\p{L}+[\t\x20]+){2,}?)(?P<unit>dollars?|euros?|pounds?|usd|eur|gbp)\b")
            .expect("repeated currency pattern is valid")
    });
    let mut amounts = Vec::new();
    for capture in REPEATED_AMOUNT_RE.captures_iter(text) {
        let words: Vec<_> = capture["words"].split_whitespace().collect();
        let Some(word) = words.last() else {
            continue;
        };
        if !matches!(
            word.to_ascii_lowercase().as_str(),
            "ten"
                | "eleven"
                | "twelve"
                | "thirteen"
                | "fourteen"
                | "fifteen"
                | "sixteen"
                | "seventeen"
                | "eighteen"
                | "nineteen"
                | "twenty"
                | "thirty"
                | "forty"
                | "fifty"
                | "sixty"
                | "seventy"
                | "eighty"
                | "ninety"
        ) {
            continue;
        }
        if words.len() < 2 || !words[words.len() - 2].eq_ignore_ascii_case(word) {
            continue;
        }
        let repeated_count = words
            .iter()
            .rev()
            .take_while(|candidate| candidate.eq_ignore_ascii_case(word))
            .count();
        if repeated_count < 3 {
            continue;
        }
        let unit = &capture["unit"];
        let prefix_conflicts = |prefix: &str| {
            if let Some(prefix_unit) = currency_unit(prefix) {
                return Some(prefix_unit) != currency_unit(unit);
            }
            let prefix_phrase =
                crate::text::itn::inverse_text_normalize(&format!("{} {}", prefix, unit));
            !currency_amounts(&prefix_phrase).is_empty()
                || matches!(
                    prefix.to_ascii_lowercase().as_str(),
                    "hundred" | "thousand" | "million" | "billion" | "point" | "and"
                )
        };
        if repeated_count < words.len() && prefix_conflicts(words[words.len() - repeated_count - 1])
        {
            continue;
        }
        let words_start = capture.name("words").expect("word span exists").start();
        let prefix_text = text[..words_start]
            .rsplit(['\n', '\r', '.', ',', '?', '!', ';'])
            .next()
            .unwrap_or("");
        if prefix_text
            .split_whitespace()
            .last()
            .is_some_and(prefix_conflicts)
        {
            continue;
        }
        let unit_end = capture.name("unit").expect("currency unit exists").end();
        if currency_unit(unit) == Some("GBP")
            && (following_word_is_of(text, unit_end)
                || pound_amount_has_mass_prefix(&format!(
                    "{} {}",
                    prefix_text,
                    words[..words.len() - repeated_count].join(" ")
                )))
        {
            continue;
        }
        let phrase =
            crate::text::itn::inverse_text_normalize(&format!("{} {}", word, &capture["unit"]));
        amounts.extend(currency_amounts(&phrase));
    }
    amounts
}

fn cited_currency_amounts(citations: &[Citation]) -> HashSet<CurrencyAmount> {
    let normalized: Vec<_> = citations
        .iter()
        .map(|c| crate::text::itn::inverse_text_normalize(&c.text))
        .collect();
    let mut amounts: HashSet<_> = normalized
        .iter()
        .flat_map(|text| currency_amounts(text))
        .collect();
    for citation in citations {
        amounts.extend(repeated_spoken_currency_amounts(&citation.text));
    }
    let line_number = |citation: &Citation| {
        citation
            .line_id
            .as_deref()?
            .strip_prefix('L')?
            .parse::<usize>()
            .ok()
    };
    let mut by_line = std::collections::HashMap::new();
    for (index, citation) in citations.iter().enumerate() {
        if let (Some(recording), Some(line)) =
            (citation.recording_id.as_ref(), line_number(citation))
        {
            let entry = by_line
                .entry((recording.clone(), line))
                .or_insert(Some(index));
            if *entry != Some(index) {
                *entry = None;
            }
        }
    }
    for (index, amount) in citations.iter().enumerate() {
        let (Some(recording), Some(line)) = (&amount.recording_id, line_number(amount)) else {
            continue;
        };
        if recording.is_empty() || by_line.get(&(recording.clone(), line)) != Some(&Some(index)) {
            continue;
        }
        let Some(next_line) = line.checked_add(1) else {
            continue;
        };
        let Some(Some(next)) = by_line.get(&(recording.clone(), next_line)) else {
            continue;
        };
        let unit = &citations[*next];
        let (Some(start), Some(end), Some(unit_start), Some(unit_end)) = (
            amount.start_time,
            amount.end_time,
            unit.start_time,
            unit.end_time,
        ) else {
            continue;
        };
        if ![start, end, unit_start, unit_end]
            .iter()
            .all(|value| value.is_finite())
            || end <= start
            || unit_end <= unit_start
            || unit_start < end
            || unit_start - end > 0.5
        {
            continue;
        }
        let unit_word = normalized[*next].trim().trim_end_matches([',', '.', ';']);
        if currency_unit(unit_word).is_none() || !currency_amounts(&normalized[index]).is_empty() {
            continue;
        }
        amounts.extend(currency_amounts(&crate::text::itn::inverse_text_normalize(
            &format!("{} {}", amount.text, unit_word),
        )));
    }
    amounts
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FinancialValue {
    Amount(CurrencyAmount),
    Rate(CurrencyAmount, CurrencyAmount),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FinancialRole {
    Unknown,
    Price,
    Fee,
    Budget,
    Estimate,
}

#[derive(Debug)]
struct FinancialFact {
    value: FinancialValue,
    role: FinancialRole,
    estimated: bool,
    questioned: bool,
}

impl FinancialFact {
    fn uncertain(&self) -> bool {
        self.estimated || self.questioned
    }
}

pub(crate) fn is_short_financial_confirmation(text: &str) -> bool {
    matches!(
        text.trim()
            .trim_end_matches(['.', '!'])
            .to_ascii_lowercase()
            .as_str(),
        "yes" | "correct" | "that's right" | "that is right" | "that's correct" | "confirmed"
    )
}

fn financial_role(prefix: &str) -> FinancialRole {
    TOKEN_RE
        .find_iter(prefix)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find_map(|token| match token.as_str().to_ascii_lowercase().as_str() {
            "price" | "selling" => Some(FinancialRole::Price),
            "fee" | "fees" | "charge" => Some(FinancialRole::Fee),
            "budget" => Some(FinancialRole::Budget),
            "estimate" | "estimated" | "equivalent" | "conversion" => Some(FinancialRole::Estimate),
            _ => None,
        })
        .unwrap_or(FinancialRole::Unknown)
}

fn financial_qualifier(text: &str) -> bool {
    static QUALIFIER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?iu)\b(?:approximately|approximate|roughly|rough|estimated?|tentative|suggested|maybe|perhaps|guess|uncertain|unsure|possibly)\b|\b(?:something\s+like|or\s+something|i\s+think|i\s+don['’]t\s+know)\b"
    ).expect("financial qualifier pattern is valid")
    });
    let words: Vec<_> = TOKEN_RE
        .find_iter(text)
        .map(|word| word.as_str().to_ascii_lowercase())
        .collect();
    let near_approximation = words
        .last()
        .is_some_and(|word| matches!(word.as_str(), "about" | "around"))
        && !words.iter().rev().nth(1).is_some_and(|word| {
            matches!(
                word.as_str(),
                "talk" | "talked" | "talking" | "discussion" | "information" | "notes"
            )
        });
    QUALIFIER.is_match(text) || near_approximation
}

// Split statements without cutting decimal amounts. Commas and conjunctions
// remain inside a statement so an amount keeps a trailing 'or something'.
fn financial_statements(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut offset = 0;
    text.split_inclusive(|character: char| {
        let index = offset;
        offset += character.len_utf8();
        let decimal = character == '.'
            && index > 0
            && bytes[index - 1].is_ascii_digit()
            && bytes.get(index + 1).is_some_and(u8::is_ascii_digit);
        matches!(character, '.' | '!' | '?' | ';' | '\n') && !decimal
    })
    .collect()
}

fn financial_question_prefix(prefix: &str) -> bool {
    TOKEN_RE
        .find_iter(prefix)
        .map(|word| word.as_str().to_ascii_lowercase())
        .find(|word| !matches!(word.as_str(), "and" | "but" | "or"))
        .is_some_and(|word| {
            matches!(
                word.as_str(),
                "is" | "are"
                    | "was"
                    | "were"
                    | "can"
                    | "could"
                    | "would"
                    | "should"
                    | "will"
                    | "what"
                    | "how"
                    | "does"
                    | "did"
                    | "do"
            )
        })
}

fn financial_postfix_prefix(text: &str) -> Option<usize> {
    static POSTFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?iu)^\s*,?\s*(?:or\s+something(?:\s+like\s+that)?|or\s+so|i\s+think|i\s+guess|maybe|perhaps|approximately|roughly)\s*,\s*(?:(?:and|but|while)\b\s*)?"
    ).expect("financial postfix pattern is valid")
    });
    POSTFIX.find(text).map(|matched| matched.end())
}

fn financial_facts(raw: &str) -> Vec<FinancialFact> {
    let mut facts = Vec::<FinancialFact>::new();
    let mut question_facts: Option<std::ops::Range<usize>> = None;
    for statement in financial_statements(raw) {
        if is_short_financial_confirmation(statement) {
            if let Some(range) = question_facts.take() {
                for fact in &mut facts[range] {
                    fact.questioned = false;
                }
            }
            continue;
        }
        question_facts = None;
        let statement_start = facts.len();
        let text = crate::text::itn::inverse_text_normalize(statement);
        let relations = currency_relation_spans(&text);
        let mut spans: Vec<_> = relations
            .iter()
            .map(|span| {
                (
                    span.range.clone(),
                    FinancialValue::Rate(span.relation.0.clone(), span.relation.1.clone()),
                )
            })
            .collect();
        spans.extend(
            currency_amount_spans(&text)
                .into_iter()
                .filter(|span| {
                    !relations.iter().any(|rate| {
                        rate.range.start <= span.range.start && rate.range.end >= span.range.end
                    })
                })
                .map(|span| (span.range, FinancialValue::Amount(span.amount))),
        );
        spans.sort_by_key(|(range, _)| (range.start, range.end));
        for (index, (range, value)) in spans.iter().enumerate() {
            let prefix_start = index
                .checked_sub(1)
                .map_or(0, |previous| spans[previous].0.end.min(range.start));
            let mut prefix = &text[prefix_start..range.start];
            if index > 0 {
                if let Some(end) = financial_postfix_prefix(prefix) {
                    prefix = &prefix[end..];
                }
            }
            let suffix_end = spans
                .get(index + 1)
                .map_or(text.len(), |next| next.0.start.max(range.end));
            let suffix = text[range.end..suffix_end].trim_start_matches(|character: char| {
                character == ',' || character.is_whitespace()
            });
            // General prefix hedges belong to the following fact. Only an
            // immediate trailing hedge or question qualifies the preceding one.
            let inherited_hedge = index.checked_sub(1).is_some_and(|previous| {
                spans[previous].0.end > range.start
                    && facts
                        .last()
                        .is_some_and(|fact: &FinancialFact| fact.estimated)
            });
            let postfix = suffix.trim().trim_end_matches(['.', '!', '?', ';']).trim();
            let trailing_hedge = financial_postfix_prefix(suffix).is_some()
                || postfix.to_ascii_lowercase().starts_with("or something")
                || postfix.to_ascii_lowercase().starts_with("or so")
                || index + 1 == spans.len()
                    && matches!(
                        postfix.to_ascii_lowercase().as_str(),
                        "maybe" | "perhaps" | "approximately" | "roughly" | "i think" | "i guess"
                    );
            facts.push(FinancialFact {
                value: value.clone(),
                role: financial_role(prefix),
                estimated: financial_qualifier(prefix) || inherited_hedge || trailing_hedge,
                questioned: text.trim_end().ends_with('?')
                    && (spans.len() == 1
                        || spans.first().is_some_and(|first| {
                            financial_question_prefix(&text[..first.0.start])
                        })
                        || financial_question_prefix(prefix)),
            });
        }
        for amount in repeated_spoken_currency_amounts(statement) {
            if !facts[statement_start..]
                .iter()
                .any(|fact| fact.value == FinancialValue::Amount(amount.clone()))
            {
                facts.push(FinancialFact {
                    value: FinancialValue::Amount(amount),
                    role: financial_role(statement),
                    estimated: financial_qualifier(statement)
                        || statement.split_whitespace().any(|word| {
                            matches!(
                                word.trim_matches([',', '.']).to_ascii_lowercase().as_str(),
                                "about" | "around"
                            )
                        }),
                    questioned: statement.trim_end().ends_with('?'),
                });
            }
        }
        if statement.trim_end().ends_with('?') && facts.len() > statement_start {
            question_facts = Some(statement_start..facts.len());
        }
    }
    facts
}

/// Refuse promotion of an estimate or question into a firm monetary fact.
/// Compare rate pairs separately from independent prices and fees. A clearly
/// identified firm fee may support that fee even when an equal estimate exists.
fn lost_financial_uncertainty<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> Vec<FinancialValue> {
    let source_facts: Vec<_> = sources.flat_map(financial_facts).collect();
    let mut lost = Vec::new();
    for claim in financial_facts(claim)
        .into_iter()
        .filter(|fact| !fact.uncertain())
    {
        let matching: Vec<_> = source_facts
            .iter()
            .filter(|source| source.value == claim.value)
            .collect();
        if matching.iter().any(|source| source.uncertain())
            && !matching.iter().any(|source| {
                !source.uncertain()
                    && (matches!(claim.value, FinancialValue::Rate(_, _))
                        || claim.role != FinancialRole::Unknown && source.role == claim.role)
            })
            && !lost.contains(&claim.value)
        {
            lost.push(claim.value);
        }
    }
    lost
}

pub(crate) fn financial_uncertainty_lost<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> bool {
    !lost_financial_uncertainty(claim, sources).is_empty()
}

pub(crate) fn financial_uncertainty_repair_preserves_values<'a>(
    original: &str,
    repaired: &str,
    sources: impl Iterator<Item = &'a str>,
) -> bool {
    if missing_financial_details(repaired, std::iter::once(original)) {
        return false;
    }
    let values = lost_financial_uncertainty(original, sources);
    let repaired_facts = financial_facts(repaired);
    values.iter().all(|value| {
        repaired_facts
            .iter()
            .any(|fact| fact.value == *value && fact.uncertain())
    })
}

pub(crate) fn financial_uncertainty_repair_hints<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    lost_financial_uncertainty(claim, sources).into_iter().map(|value| match value {
        FinancialValue::Amount(amount) => format!("{} {} is an estimate or unanswered monetary question. Keep this figure explicitly approximate, for example about {} {}, unless the original source explicitly confirms it. Qualify every mention; a separate approximate sentence does not fix an earlier firm restatement.", amount.unit, amount.amount, amount.unit, amount.amount),
        FinancialValue::Rate(left, right) => format!("The relationship between {} {} and {} {} is tentative. Keep it a suggested or rough rate, with the same currency values; do not calculate a conversion.", left.unit, left.amount, right.unit, right.amount),
    }).collect()
}

fn pricing_proposals(raw: &str) -> HashSet<(CurrencyAmount, String)> {
    static AFTER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?iu)^\s+should\s+be\s+(?:(?:the|our|a)\s+)?(?P<role>(?:selling\s+)?price|fee|budget)\b"
    ).expect("price proposal suffix is valid")
    });
    static BEFORE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?iu)\b(?P<role>(?:selling\s+)?price|fee|budget)\s+should\s+be\s+(?:(?:about|around|roughly|approximately)\s+)?$"
    ).expect("price proposal prefix is valid")
    });
    static PROPOSAL_VERB: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?:suggest(?:s|ed)?|recommend(?:s|ed)?|propose(?:s|d)?)\s+(?:(?:about|around|roughly|approximately)\s+)?$").unwrap()
    });
    static PURPOSE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)^\s+(?:as|for)\s+(?:(?:the|our|a)\s+)?(?P<role>(?:selling\s+)?price|fee|budget)\b").unwrap()
    });
    static PASSIVE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)^\s+(?:was|is)\s+(?:suggested|recommended|proposed)\s+(?:as|for)\s+(?:(?:the|our|a)\s+)?(?P<role>(?:selling\s+)?price|fee|budget)\b").unwrap()
    });
    let mut proposals = HashSet::new();
    for statement in financial_statements(raw) {
        if statement.trim_end().ends_with('?') {
            continue;
        }
        let text = crate::text::itn::inverse_text_normalize(statement);
        for span in currency_amount_spans(&text) {
            let before = &text[..span.range.start];
            let after = &text[span.range.end..];
            let proposal = AFTER
                .captures(after)
                .or_else(|| BEFORE.captures(before))
                .or_else(|| {
                    if PROPOSAL_VERB.is_match(before) {
                        PURPOSE.captures(after)
                    } else {
                        None
                    }
                })
                .or_else(|| PASSIVE.captures(after));
            let Some(captures) = proposal else {
                continue;
            };
            let words = identity_tokens(before);
            if words.iter().any(|word| {
                matches!(
                    word.as_str(),
                    "if" | "whether"
                        | "hypothetical"
                        | "not"
                        | "never"
                        | "didn't"
                        | "didn’t"
                        | "doesn't"
                        | "doesn’t"
                        | "don't"
                        | "don’t"
                        | "can't"
                        | "can’t"
                        | "equivalent"
                        | "conversion"
                        | "converted"
                        | "exchange"
                )
            }) {
                continue;
            }
            let role = captures["role"].to_ascii_lowercase();
            proposals.insert((
                span.amount,
                if role.ends_with("price") {
                    "price".into()
                } else {
                    role
                },
            ));
        }
    }
    proposals
}

/// Catch an explicitly tentative integer duration becoming an exact duration.
/// This does not infer uncertainty from unrelated facts in the same paragraph.
fn duration_facts(text: &str) -> Vec<(String, String, bool)> {
    static DURATION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)\b(?P<value>[0-9]+)\s+(?P<unit>seconds?|minutes?|hours?)\b").unwrap()
    });
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?iu)\b(?:about|around|roughly|approximately|maybe|perhaps|estimated?|tentative)\s+$",
        )
        .unwrap()
    });
    static SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)^\s*(?:,\s*)?(?:or\s+so|(?:to\s+do\s+that\s+)?as\s+far\s+as\s+i\s+(?:can\s+)?understand|i\s+think)\b").unwrap()
    });

    let text = crate::text::itn::inverse_text_normalize(text);
    DURATION
        .captures_iter(&text)
        .filter_map(|m| {
            let span = m.get(0).unwrap();
            if text[..span.start()].ends_with('.') {
                return None;
            }
            let prefix = &text[..span.start()];
            let suffix = &text[span.end()..];
            Some((
                m["value"].to_string(),
                m["unit"].to_lowercase().trim_end_matches('s').to_string(),
                PREFIX.is_match(prefix) || SUFFIX.is_match(suffix),
            ))
        })
        .collect()
}

fn lost_duration_values<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> Vec<(String, String)> {
    let source_facts: Vec<_> = sources.flat_map(duration_facts).collect();
    let mut lost = Vec::new();
    for (value, unit, tentative) in duration_facts(claim) {
        if !tentative
            && source_facts
                .iter()
                .any(|(v, u, t)| *v == value && *u == unit && *t)
            && !source_facts
                .iter()
                .any(|(v, u, t)| *v == value && *u == unit && !t)
            && !lost.contains(&(value.clone(), unit.clone()))
        {
            lost.push((value, unit));
        }
    }
    lost
}

pub(crate) fn duration_uncertainty_lost<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> bool {
    !lost_duration_values(claim, sources).is_empty()
}

pub(crate) fn has_financial_values(text: &str) -> bool {
    !financial_facts(text).is_empty()
}

pub(crate) fn duration_patch_preserves_values<'a>(
    before: &str,
    after: &str,
    sources: impl Iterator<Item = &'a str>,
) -> bool {
    static STRONG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(?:exactly|precisely|confirmed|fixed|strict)\b").unwrap()
    });
    let values = |text: &str| {
        duration_facts(text)
            .into_iter()
            .map(|(value, unit, _)| (value, unit))
            .collect::<HashSet<_>>()
    };
    let original = values(before);
    !original.is_empty()
        && original == values(after)
        && !duration_uncertainty_lost(after, sources)
        && !has_financial_values(after)
        && !STRONG.is_match(after)
}

pub(crate) fn duration_uncertainty_repair_hints<'a>(
    claim: &str,
    sources: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let sources: Vec<_> = sources.collect();
    lost_duration_values(claim, sources.iter().copied()).into_iter().map(|(value, unit)| {
        let suffix = if value == "1" { "" } else { "s" };
        let duration = format!("{value} {unit}{suffix}");
        let qualified_wording = format!("about {duration}");
        let source = sources.iter().copied().find(|source| {
            source.len() <= 320 && duration_uncertainty_lost(&duration, std::iter::once(*source))
        });
        let anchor = serde_json::json!({
            "duration": duration,
            "certainty": "tentative",
            "supported_wording": qualified_wording,
            "source_excerpt": source,
        });
        format!("Source-supported duration anchor: {anchor}. Qualify every mention using the supported wording. Preserve its value and units. A separate tentative sentence does not fix a firm restatement. Do not invent an exact time limit.")
    }).collect()
}

/// Detect a narrow English promotion from capability or an offer to a firm
/// future action. Matching an action and object is not an ownership proof.
pub(crate) fn future_commitment_inflated<'a>(
    summary: &str,
    sources: impl Iterator<Item = &'a str>,
) -> bool {
    static MODAL_ACTION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?iu)(?:\b(?P<ability>can|could|might|may|offer(?:ed|s)?\s+to|will\s+be\s+able\s+to)|['’]ll\s+be\s+able\s+to)\s+(?P<possible>[^.!?;\n]+)|(?:\bwill|['’]ll)\s+(?P<firm>[^.!?;\n]+)").expect("future action pattern is valid")
    });
    fn actions(text: &str) -> Vec<(bool, String, HashSet<String>)> {
        MODAL_ACTION
            .captures_iter(text)
            .filter_map(|capture| {
                let action = capture.name("possible").or_else(|| capture.name("firm"))?;
                let matched = capture.get(0)?;
                let sentence_start = text[..matched.start()]
                    .rfind(['.', '!', '?', ';', '\n'])
                    .map_or(0, |at| at + 1);
                let sentence_end = text[matched.end()..].chars().next();
                if sentence_end == Some('?') {
                    return None;
                }
                let prefix = identity_tokens(&text[sentence_start..matched.start()]);
                if prefix
                    .iter()
                    .rev()
                    .take(8)
                    .any(|word| matches!(word.as_str(), "if" | "maybe" | "perhaps" | "whether"))
                {
                    return None;
                }
                let words: Vec<_> = identity_tokens(action.as_str())
                    .into_iter()
                    .filter(|word| !matches!(word.as_str(), "um" | "uh" | "to"))
                    .collect();
                let verb = words.first()?;
                if !matches!(
                    verb.as_str(),
                    "send"
                        | "share"
                        | "put"
                        | "upload"
                        | "review"
                        | "book"
                        | "schedule"
                        | "deliver"
                        | "deploy"
                        | "approve"
                        | "finish"
                        | "complete"
                        | "provide"
                        | "prepare"
                        | "write"
                        | "take"
                ) {
                    return None;
                }
                let objects = words
                    .iter()
                    .skip(1)
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
                                    | "information"
                                    | "into"
                                    | "with"
                                    | "something"
                                    | "instead"
                                    | "only"
                                    | "when"
                                    | "after"
                                    | "before"
                                    | "monday"
                                    | "tuesday"
                                    | "wednesday"
                                    | "thursday"
                                    | "friday"
                                    | "saturday"
                                    | "sunday"
                                    | "tomorrow"
                                    | "today"
                                    | "later"
                            )
                    })
                    .cloned()
                    .collect::<HashSet<_>>();
                if objects.is_empty() {
                    return None;
                }
                Some((capture.name("possible").is_some(), verb.clone(), objects))
            })
            .collect()
    }
    let evidence: Vec<_> = sources.flat_map(actions).collect();
    actions(summary)
        .iter()
        .filter(|action| !action.0)
        .any(|claim| {
            let matches = |source: &(bool, String, HashSet<String>)| {
                source.1 == claim.1 && !source.2.is_disjoint(&claim.2)
            };
            evidence.iter().any(|source| source.0 && matches(source))
                && !evidence.iter().any(|source| !source.0 && matches(source))
        })
}

pub(crate) fn unsupported_claims(claim: &str, citations: &[Citation]) -> Vec<String> {
    let normalized_claim = crate::text::itn::inverse_text_normalize(claim);
    let normalized_evidence = citations
        .iter()
        .map(|citation| crate::text::itn::inverse_text_normalize(&citation.text))
        .collect::<Vec<_>>()
        .join("\n");
    let claim_amounts = currency_amounts(&normalized_claim);
    let evidence_amounts = cited_currency_amounts(citations);

    let mut reasons = Vec::with_capacity(2);
    if super::named_role_support::unsupported_named_role(claim, citations) {
        reasons.push("named_role_not_cited".to_string());
    }
    let supported_proposals: HashSet<_> = citations
        .iter()
        .flat_map(|citation| pricing_proposals(&citation.text))
        .collect();
    if pricing_proposals(claim)
        .iter()
        .any(|proposal| !supported_proposals.contains(proposal))
    {
        reasons.push(PRICE_RECOMMENDATION_REASON.to_string());
    }
    if duration_uncertainty_lost(
        claim,
        citations.iter().map(|citation| citation.text.as_str()),
    ) {
        reasons.push("duration_uncertainty_lost".to_string());
    }
    if financial_uncertainty_lost(
        claim,
        citations.iter().map(|citation| citation.text.as_str()),
    ) {
        reasons.push(FINANCIAL_CERTAINTY_REASON.to_string());
    }
    if reverses_negated_unless(&normalized_claim, citations) {
        reasons.push(CONDITIONAL_POLARITY_REASON.to_string());
    }
    let evidence_times: HashSet<_> = citations
        .iter()
        .flat_map(|citation| clock_times(&crate::text::itn::inverse_text_normalize(&citation.text)))
        .collect();
    if clock_times(&normalized_claim)
        .iter()
        .any(|time| !evidence_times.contains(time))
    {
        reasons.push(TIME_REASON.to_string());
    }
    if claim_amounts
        .iter()
        .any(|amount| !evidence_amounts.contains(amount))
    {
        reasons.push(CURRENCY_REASON.to_string());
    }
    let evidence_relations: HashSet<_> = citations
        .iter()
        .flat_map(|citation| {
            currency_relations(&crate::text::itn::inverse_text_normalize(&citation.text))
        })
        .collect();
    if currency_relations(&normalized_claim)
        .iter()
        .any(|relation| !evidence_relations.contains(relation))
    {
        reasons.push(CURRENCY_RELATION_REASON.to_string());
    }

    let evidence_predicates: HashSet<_> = citations
        .iter()
        .flat_map(|citation| {
            negated_predicates(&crate::text::itn::inverse_text_normalize(&citation.text))
        })
        .collect();
    if negated_predicates(&normalized_claim)
        .iter()
        .any(|predicate| !evidence_predicates.contains(predicate))
    {
        reasons.push(NEGATED_PREDICATE_REASON.to_string());
    }
    if negated_identities(&normalized_evidence)
        .iter()
        .any(|entity| {
            asserts_identity(&normalized_claim, entity)
                && !citations
                    .iter()
                    .any(|citation| asserts_identity(&citation.text, entity))
        })
    {
        reasons.push(NEGATED_IDENTITY_REASON.to_string());
    }

    let cited_agreements: Vec<_> = citations
        .iter()
        .flat_map(|citation| asserted_agreements(&citation.text))
        .collect();
    if asserted_agreements(claim).iter().any(|agreement| {
        !cited_agreements.iter().any(|cited| {
            agreement.0 == cited.0
                && agreement.1.is_subset(&cited.1)
                && agreement.2 == cited.2
                && agreement
                    .1
                    .iter()
                    .find(|topic| topic.starts_with("speaker:"))
                    == cited.1.iter().find(|topic| topic.starts_with("speaker:"))
        })
    }) {
        reasons.push(AGREEMENT_REASON.to_string());
    }

    reasons
}

/// Default meeting notes explicitly retain financial details. Check each
/// original line independently so adjoining fragments cannot create a rate.
pub(crate) fn missing_financial_details<'a>(
    summary: &str,
    mut source_lines: impl Iterator<Item = &'a str>,
) -> bool {
    let normalized = crate::text::itn::inverse_text_normalize(summary);
    let summary_relations = currency_relation_spans(&normalized);
    let amounts: HashSet<_> = currency_amounts_outside_relations(&normalized, &summary_relations)
        .into_iter()
        .collect();
    let relations: HashSet<_> = summary_relations
        .into_iter()
        .map(|span| span.relation)
        .collect();
    source_lines.any(|source| {
        let line = crate::text::itn::inverse_text_normalize(source);
        let source_relations = currency_relation_spans(&line);
        source_relations
            .iter()
            .any(|span| !relations.contains(&span.relation))
            || currency_amounts_outside_relations(&line, &source_relations)
                .iter()
                .any(|amount| !amounts.contains(amount))
    })
}

// Rate operands must not satisfy an independent price, estimate, or fee.
// Use the same span exclusion on source and summary, without joining gaps.
fn currency_amounts_outside_relations(
    text: &str,
    relations: &[CurrencyRelationSpan],
) -> Vec<CurrencyAmount> {
    let mut parts = Vec::new();
    let mut cursor = 0;
    for span in relations {
        if span.range.start > cursor {
            parts.push(&text[cursor..span.range.start]);
        }
        cursor = cursor.max(span.range.end);
    }
    parts.push(&text[cursor..]);
    parts
        .into_iter()
        .flat_map(|part| {
            currency_amounts(part)
                .into_iter()
                .chain(repeated_spoken_currency_amounts(part))
        })
        .collect()
}

// An explicit claim of group or labeled-speaker agreement needs agreement in
// its own cited lines. A suggestion, individual promise, or question does
// not establish group consent. This is a conservative review check, not a
// general entailment model; unrelated agreement topics cannot support it.
fn asserted_agreements(text: &str) -> Vec<(bool, HashSet<String>, HashSet<String>)> {
    static AGREEMENT_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?u)[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*")
            .expect("agreement token pattern is valid")
    });
    static INDEPENDENT_COMMITMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\s+(?:and|but)\s+(?:[\p{L}\p{M}]+\s+){1,3}(?:will|won['’]t|can|could|may|might|should)\b").unwrap()
    });
    let mut agreements = Vec::new();
    let normalized = crate::text::itn::inverse_text_normalize(text);
    for sentence in normalized.split_inclusive(['.', '!', '?', ';', '\n']) {
        if sentence.trim_end().ends_with('?') {
            continue;
        }
        for captures in AGREEMENT_RE.captures_iter(sentence) {
            let matched = captures.get(0).expect("agreement match exists");
            let prefix = identity_tokens(&sentence[..matched.start()]);
            if prefix.iter().rev().take(4).any(|word| {
                matches!(
                    word.as_str(),
                    "if" | "whether"
                        | "maybe"
                        | "perhaps"
                        | "not"
                        | "think"
                        | "seem"
                        | "seems"
                        | "probably"
                        | "possibly"
                        | "apparently"
                )
            }) {
                continue;
            }
            let action = captures.name("action").expect("agreement action exists");
            // A separate person's promise is not part of this agreement.
            let action = action.as_str();
            let end = INDEPENDENT_COMMITMENT
                .find(action)
                .map_or(action.len(), |found| found.start());
            let expanded = NEGATED_AUXILIARY_RE.replace_all(&action[..end], "$1 not");
            let mut tokens: Vec<_> = AGREEMENT_TOKEN
                .find_iter(&expanded)
                .map(|word| word.as_str().trim_matches(['\'', '’']).to_lowercase())
                .collect();
            if let Some(end) = tokens
                .iter()
                .position(|word| matches!(word.as_str(), "maybe" | "perhaps" | "however" | "but"))
            {
                tokens.truncate(end);
            }
            let negated = tokens.iter().enumerate().any(|(index, word)| {
                word == "not" && tokens.get(index + 1).is_none_or(|next| next != "only")
            });
            let qualifiers = tokens
                .iter()
                .filter(|word| {
                    matches!(
                        word.as_str(),
                        "might"
                            | "may"
                            | "could"
                            | "if"
                            | "unless"
                            | "until"
                            | "when"
                            | "provided"
                            | "conditional"
                            | "subject"
                            | "only"
                            | "without"
                            | "before"
                            | "after"
                    )
                })
                .cloned()
                .collect();
            let mut topics: HashSet<_> = tokens
                .into_iter()
                .map(|word| match word.as_str() {
                    "taken" | "taking" => "take".to_string(),
                    _ => word,
                })
                .filter(|word| {
                    (word.len() > 3 || word.chars().any(|character| character.is_ascii_digit()))
                        && !matches!(
                            word.as_str(),
                            "that"
                                | "this"
                                | "with"
                                | "from"
                                | "their"
                                | "there"
                                | "they"
                                | "will"
                                | "would"
                                | "should"
                                | "could"
                                | "have"
                                | "been"
                                | "were"
                                | "when"
                                | "then"
                                | "also"
                                | "about"
                                | "later"
                                | "information"
                                | "reference"
                                | "upon"
                        )
                })
                .collect();
            if !topics.is_empty() {
                if let Some(speaker) = captures.name("speaker") {
                    topics.insert(format!(
                        "speaker:{}",
                        identity_tokens(speaker.as_str()).join(" ")
                    ));
                }
                agreements.push((negated, topics, qualifiers));
            }
        }
    }
    agreements
}

// Preserve explicitly stated currency relationships, not just a bag of values.
// Equality is symmetric, so £1 = €1.4 and €1.4 per £1 share one key.
struct CurrencyRelationSpan {
    range: std::ops::Range<usize>,
    relation: (CurrencyAmount, CurrencyAmount),
}

fn currency_relations(text: &str) -> Vec<(CurrencyAmount, CurrencyAmount)> {
    currency_relation_spans(text)
        .into_iter()
        .map(|span| span.relation)
        .collect()
}

fn currency_relation_spans(text: &str) -> Vec<CurrencyRelationSpan> {
    let lower = text.to_lowercase();
    let conversion_context = lower.contains("exchange") || lower.contains("conversion");
    let mut relations = Vec::new();
    let mut search_start = 0;
    while let Some(captures) = CURRENCY_RELATION_RE.captures_at(text, search_start) {
        let left = captures.name("left").expect("left operand exists");
        let right = captures.name("right").expect("right operand exists");
        // Reuse the shared boundary and operand in A=B;C=D and A=B=C.
        search_start = left.end();
        let Some(mut a) = currency_amounts(left.as_str()).into_iter().next() else {
            continue;
        };
        let Some(mut b) = currency_amounts(right.as_str())
            .into_iter()
            .next()
            .or_else(|| {
                let unit = currency_unit(right.as_str())?;
                if unit == "GBP" && !conversion_context {
                    return None;
                }
                Some(CurrencyAmount {
                    unit,
                    amount: "1".to_string(),
                })
            })
        else {
            continue;
        };
        if a.unit == b.unit
            || (a.unit == "GBP"
                && left.as_str().to_lowercase().contains("pound")
                && (following_word_is_of(text, left.end())
                    || pound_amount_has_mass_prefix(&text[..left.start()])))
            || (b.unit == "GBP"
                && right.as_str().to_lowercase().contains("pound")
                && (following_word_is_of(text, right.end())
                    || pound_amount_has_mass_prefix(&text[..right.start()])))
        {
            continue;
        }
        if a.unit > b.unit {
            std::mem::swap(&mut a, &mut b);
        }
        relations.push(CurrencyRelationSpan {
            range: left.start()..right.end(),
            relation: (a, b),
        });
    }
    relations
}

fn identity_tokens(text: &str) -> Vec<String> {
    let expanded = NEGATED_AUXILIARY_RE.replace_all(text, "$1 not");
    TOKEN_RE
        .find_iter(&expanded)
        .map(|word| word.as_str().trim_matches(['\'', '’']).to_lowercase())
        .collect()
}

fn negated_identities(text: &str) -> Vec<Vec<String>> {
    let mut entities = Vec::new();
    for clause in text.split([',', '.', ';', ':', '!', '?', '\n']) {
        let tokens = identity_tokens(clause);
        for (index, pair) in tokens.windows(2).enumerate() {
            if pair[0] != "not" || !matches!(pair[1].as_str(), "a" | "an") {
                continue;
            }
            let remainder = &tokens[index + 2..];
            let end = remainder
                .iter()
                .position(|token| {
                    matches!(
                        token.as_str(),
                        "and"
                            | "but"
                            | "because"
                            | "honestly"
                            | "actually"
                            | "which"
                            | "that"
                            | "i"
                            | "it"
                    )
                })
                .unwrap_or(remainder.len());
            // Longer phrases need grammatical analysis; this check declines
            // them rather than guessing which words form the identity.
            if (1..=4).contains(&end) {
                entities.push(remainder[..end].to_vec());
            }
        }
    }
    entities
}

fn asserts_identity(text: &str, entity: &[String]) -> bool {
    if entity.is_empty() {
        return false;
    }
    text.split(['.', ';', '!', '?', '\n']).any(|sentence| {
        let tokens = identity_tokens(sentence);
        tokens
            .windows(entity.len())
            .enumerate()
            .any(|(index, words)| {
                if words != entity {
                    return false;
                }
                let prefix = &tokens[..index];
                if prefix.iter().rev().take(4).any(|token| token == "not") {
                    return false;
                }
                if prefix.iter().rev().take(8).any(|token| {
                    matches!(
                        token.as_str(),
                        "if" | "maybe" | "perhaps" | "might" | "could" | "would"
                    )
                }) {
                    return false;
                }
                let identity = prefix.ends_with(&["is".into(), "a".into()])
                    || prefix.ends_with(&["was".into(), "a".into()])
                    || prefix.ends_with(&["is".into(), "an".into()])
                    || prefix.ends_with(&["was".into(), "an".into()]);
                let drawing = prefix
                    .iter()
                    .enumerate()
                    .rev()
                    .take(24)
                    .any(|(position, token)| {
                        matches!(
                            token.as_str(),
                            "draw" | "draws" | "drew" | "depicts" | "depicted"
                        ) && !prefix[..position]
                            .iter()
                            .rev()
                            .take(3)
                            .any(|token| token == "not")
                    });
                identity || drawing
            })
    })
}

#[derive(Debug, Clone)]
struct CurrencyAmountSpan {
    range: std::ops::Range<usize>,
    amount: CurrencyAmount,
}

fn currency_amounts(text: &str) -> Vec<CurrencyAmount> {
    let mut amounts: Vec<_> = currency_amount_spans(text)
        .into_iter()
        .map(|span| span.amount)
        .collect();
    amounts.sort_by(|left, right| {
        left.unit
            .cmp(right.unit)
            .then_with(|| left.amount.cmp(&right.amount))
    });
    amounts.dedup();
    amounts
}

fn currency_amount_spans(text: &str) -> Vec<CurrencyAmountSpan> {
    let mut amounts = Vec::new();
    collect_currency_matches(text, &SYMBOL_PREFIX_RE, false, false, &mut amounts);
    collect_currency_matches(text, &SYMBOL_SUFFIX_RE, false, false, &mut amounts);
    collect_currency_matches(text, &WORD_SUFFIX_RE, false, false, &mut amounts);
    collect_currency_matches(text, &CODE_PREFIX_RE, false, false, &mut amounts);
    let has_monetary_context = MONETARY_CONTEXT_RE.is_match(text);
    collect_currency_matches(
        text,
        &WORD_COPULA_PREFIX_RE,
        true,
        has_monetary_context,
        &mut amounts,
    );
    amounts.sort_by_key(|span| (span.range.start, span.range.end));
    amounts.dedup_by(|left, right| left.range == right.range && left.amount == right.amount);
    amounts
}

fn collect_currency_matches(
    text: &str,
    pattern: &Regex,
    is_word_copula_prefix: bool,
    has_monetary_context: bool,
    output: &mut Vec<CurrencyAmountSpan>,
) {
    let mut search_start = 0;
    while search_start < text.len() {
        let Some(captures) = pattern.captures_at(text, search_start) else {
            break;
        };
        let next_search_start = captures
            .name("after")
            .map_or(text.len(), |after| after.start());
        let ends_before_more_digits = captures.name("after").is_some_and(|after| {
            matches!(after.as_str(), "." | ",")
                && text[after.end()..]
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
        });
        if !ends_before_more_digits {
            let parsed = captures
                .name("unit")
                .and_then(|value| currency_unit(value.as_str()))
                .zip(captures.name("amount"));
            if let Some((unit, raw_amount)) = parsed {
                let raw_unit = captures.name("unit").map_or("", |value| value.as_str());
                let has_currency_prefix_context = pound_prefix_has_currency_context(
                    text,
                    &captures,
                    raw_unit,
                    has_monetary_context,
                );
                let is_word_pound = raw_unit.eq_ignore_ascii_case("pound")
                    || raw_unit.eq_ignore_ascii_case("pounds");
                let is_weight = unit == "GBP"
                    && (following_word_is_of(text, captures.get(0).map_or(0, |value| value.end()))
                        || is_word_pound
                            && pound_amount_has_mass_prefix(&text[..raw_amount.start()]));
                if !preceded_by_digit_and_space(text, raw_amount.start())
                    && !is_weight
                    && (!is_word_copula_prefix || has_currency_prefix_context)
                {
                    if let Some(amount) = canonical_amount(raw_amount.as_str()) {
                        let unit_span = captures.name("unit").expect("currency unit exists");
                        output.push(CurrencyAmountSpan {
                            range: raw_amount.start().min(unit_span.start())
                                ..raw_amount.end().max(unit_span.end()),
                            amount: CurrencyAmount { unit, amount },
                        });
                    }
                }
            }
        }

        if next_search_start >= text.len() {
            break;
        }
        search_start = if next_search_start > search_start {
            next_search_start
        } else {
            text[search_start..]
                .chars()
                .next()
                .map_or(text.len(), |character| search_start + character.len_utf8())
        };
    }
}

pub(crate) fn pound_amount_has_mass_prefix(prefix: &str) -> bool {
    let statement = financial_statements(prefix)
        .last()
        .copied()
        .unwrap_or(prefix);
    TOKEN_RE
        .find_iter(statement)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find_map(|word| match word.as_str().to_ascii_lowercase().as_str() {
            "mass" | "weight" | "weigh" | "weighs" | "weighed" | "weighing" | "kg"
            | "kilograms" => Some(true),
            "price" | "cost" | "costs" | "fee" | "budget" | "currency" | "exchange" | "money"
            | "equivalent" => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}

fn pound_prefix_has_currency_context(
    text: &str,
    captures: &regex::Captures<'_>,
    raw_unit: &str,
    has_monetary_context: bool,
) -> bool {
    if !raw_unit.eq_ignore_ascii_case("pound") && !raw_unit.eq_ignore_ascii_case("pounds") {
        return true;
    }

    let Some(context) = captures.name("context") else {
        return false;
    };
    if matches!(context.as_str().to_lowercase().as_str(), "price" | "cost") {
        return true;
    }

    let sentence_start = text[..context.start()]
        .rfind(['.', '?', '!', ';', '\n', '\r'])
        .map_or(0, |index| index + 1);
    has_monetary_context && !MASS_CONTEXT_RE.is_match(&text[sentence_start..context.start()])
}

fn currency_unit(raw: &str) -> Option<&'static str> {
    match raw.to_lowercase().as_str() {
        "$" | "dollar" | "dollars" | "usd" => Some("USD"),
        "€" | "euro" | "euros" | "eur" => Some("EUR"),
        "£" | "pound" | "pounds" | "gbp" => Some("GBP"),
        _ => None,
    }
}

fn canonical_amount(raw: &str) -> Option<String> {
    if matches!(raw.to_lowercase().as_str(), "a" | "an") {
        return Some("1".to_string());
    }
    if !raw
        .chars()
        .all(|character| character.is_ascii_digit() || matches!(character, '.' | ','))
    {
        return None;
    }

    let separators: Vec<_> = raw
        .char_indices()
        .filter(|(_, character)| matches!(character, '.' | ','))
        .collect();
    let (integer, fraction) = match separators.as_slice() {
        [] => (raw.to_string(), None),
        [(index, separator)] => {
            let trailing = &raw[index + 1..];
            if trailing.len() == 3 && *separator == ',' {
                (raw[..*index].to_string() + trailing, None)
            } else if matches!(trailing.len(), 1 | 2) {
                (raw[..*index].to_string(), Some(trailing.to_string()))
            } else {
                return None;
            }
        }
        _ => {
            let (last_index, last_separator) = *separators.last()?;
            let trailing = &raw[last_index + 1..];
            let has_mixed_separators = separators
                .iter()
                .any(|(_, separator)| *separator != separators[0].1);
            if has_mixed_separators && matches!(trailing.len(), 1 | 2) {
                let grouping_separator = separators[0].1;
                if grouping_separator == last_separator
                    || separators[..separators.len() - 1]
                        .iter()
                        .any(|(_, separator)| *separator != grouping_separator)
                {
                    return None;
                }
                let groups: Vec<_> = raw[..last_index].split(grouping_separator).collect();
                if groups
                    .first()
                    .is_none_or(|group| group.is_empty() || group.len() > 3)
                    || groups.iter().skip(1).any(|group| group.len() != 3)
                {
                    return None;
                }
                (groups.concat(), Some(trailing.to_string()))
            } else {
                let separator = separators[0].1;
                if separators.iter().any(|(_, current)| *current != separator) {
                    return None;
                }
                let groups: Vec<_> = raw.split(separator).collect();
                if groups
                    .first()
                    .is_none_or(|group| group.is_empty() || group.len() > 3)
                    || groups.iter().skip(1).any(|group| group.len() != 3)
                {
                    return None;
                }
                (groups.concat(), None)
            }
        }
    };
    if integer.is_empty() || !integer.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }

    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let fraction = fraction.map(|value| value.trim_end_matches('0').to_string());
    match fraction.as_deref() {
        Some("") | None => Some(integer.to_string()),
        Some(value) => Some(format!("{integer}.{value}")),
    }
}

fn preceded_by_digit_and_space(text: &str, amount_start: usize) -> bool {
    let prefix = &text[..amount_start];
    let without_space = prefix.trim_end_matches(char::is_whitespace);
    without_space.len() < prefix.len()
        && without_space
            .chars()
            .next_back()
            .is_some_and(|character| character.is_ascii_digit())
}

fn following_word_is_of(text: &str, start: usize) -> bool {
    TOKEN_RE.find(&text[start..]).is_some_and(|word| {
        word.start()
            == text[start..]
                .find(|character: char| character.is_alphabetic())
                .unwrap_or(usize::MAX)
            && word.as_str().eq_ignore_ascii_case("of")
    })
}

pub(crate) fn negative_predicates_for_repair(text: &str) -> Vec<String> {
    negated_predicates(&crate::text::itn::inverse_text_normalize(text))
}

fn negated_predicates(text: &str) -> Vec<String> {
    let expanded = NEGATED_AUXILIARY_RE.replace_all(text, "$1 not");
    let expanded =
        IRREGULAR_NEGATION_RE.replace_all(&expanded, |captures: &regex::Captures<'_>| {
            if captures[0].to_lowercase().starts_with("won") {
                "will not"
            } else {
                "can not"
            }
        });
    let mut result = Vec::new();
    for clause in expanded.split(['.', '!', '?', ';', ',', '\n']) {
        let tokens: Vec<_> = NEGATION_TOKEN_RE
            .find_iter(clause)
            .map(|word| word.as_str().to_lowercase())
            .collect();
        for (i, token) in tokens.iter().enumerate() {
            if token != "not"
                || (i > 0 && tokens[i - 1] == "not")
                || tokens.get(i + 1).is_some_and(|next| next == "not")
            {
                continue;
            }
            let mut next = i + 1;
            while tokens
                .get(next)
                .is_some_and(|word| matches!(word.as_str(), "be" | "a" | "an" | "the"))
            {
                next += 1;
            }
            if tokens.get(next).is_some_and(|word| {
                matches!(word.as_str(), "actually" | "really" | "currently" | "yet")
            }) && tokens
                .get(next + 1)
                .is_some_and(|word| matches!(word.as_str(), "know" | "knowing"))
            {
                next += 1;
            }
            if let Some(predicate) = tokens.get(next).filter(|word| meaningful_predicate(word)) {
                if matches!(predicate.as_str(), "know" | "knowing") {
                    // Keep the previously qualified knowledge paraphrase.
                    // This does not establish the object of that knowledge.
                    result.push("know".into());
                    continue;
                }
                let phrase = tokens[next..negated_predicate_end(&tokens, next)]
                    .iter()
                    .take_while(|word| {
                        !matches!(
                            word.as_str(),
                            "and" | "but" | "however" | "although" | "which" | "who"
                        )
                    })
                    .filter(|word| !matches!(word.as_str(), "a" | "an" | "the"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ");
                result.push(phrase);
            }
        }
    }
    result
}

// ASR can omit the period between an action and a new subject. Only recognize
// a simple determiner + subject + copula after an existing object. Scope
// qualifiers inhibit that inference, so a condition cannot disappear from
// the evidence merely because another subject follows it.
fn negated_predicate_end(tokens: &[String], start: usize) -> usize {
    if tokens[start + 1..].iter().any(|token| {
        matches!(
            token.as_str(),
            "if" | "when"
                | "until"
                | "unless"
                | "while"
                | "because"
                | "after"
                | "before"
                | "during"
                | "only"
                | "except"
                | "provided"
                | "assuming"
                | "whether"
                | "as"
                | "since"
                | "with"
                | "without"
                | "for"
                | "in"
                | "on"
                | "at"
                | "of"
                | "to"
                | "about"
                | "not"
        )
    }) {
        return tokens.len();
    }
    for index in start + 2..tokens.len() {
        if tokens[index] == "the"
            && tokens.get(index + 1).is_some_and(|subject| {
                !matches!(subject.as_str(), "way" | "same" | "other" | "one" | "not")
            })
            && tokens.get(index + 2).is_some_and(|verb| {
                matches!(
                    verb.as_str(),
                    "is" | "are" | "was" | "were"
                )
            })
            // Perfect, progressive and passive clauses can restrict the
            // preceding object: "the meeting the client has requested" or
            // "the meeting the team is planning" must remain attached.
            && tokens.get(index + 3).is_some_and(|predicate| {
                !predicate.ends_with("ing")
                    && !predicate.ends_with("ed")
                    && !matches!(predicate.as_str(), "made" | "built" | "given" | "done"
                        | "written" | "taken" | "held" | "run" | "read" | "put" | "set"
                        | "sent" | "seen" | "heard" | "chosen")
            })
        {
            return index;
        }
    }
    tokens.len()
}

fn meaningful_predicate(token: &str) -> bool {
    token.len() > 2
        && !matches!(
            token,
            "any"
                | "agree"
                | "agreed"
                | "decision"
                | "decisions"
                | "pending"
                | "task"
                | "tasks"
                | "action"
                | "actions"
                | "settled"
                | "settle"
                | "decided"
                | "decide"
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn b23_agreements_normalize_digits_without_borrowing_another_tasks_negation() {
        for original in [
            "We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.",
            "We agreed to ship the beta on the 14th if the memory gate passes, and Priya will not publish the notes.",
        ] {
            let sources = [citation(original)];
            assert!(unsupported_claims("The team agreed to ship the beta on the fourteenth if the memory gate passes.", &sources).is_empty());
            for claim in [
                "The team agreed to ship the beta on the fifteenth if the memory gate passes.",
                "The team agreed to ship the beta on the fourteenth.",
                "The team agreed to ship the beta on the fourteenth if the memory gate fails.",
            ] {
                assert!(!unsupported_claims(claim, &sources).is_empty(), "{claim}");
            }
        }
    }

    #[test]
    fn nominalized_agreements_cannot_drop_their_conditions() {
        let sources = [citation("We agreed to ship the beta on the 18th if the memory check passes, and Kim will review the notes.")];
        assert!(unsupported_claims("The agreement was made to ship the beta on the 18th, and the review is scheduled for later.", &sources).contains(&AGREEMENT_REASON.to_string()));
        assert!(unsupported_claims(
            "The agreement was made to ship the beta on the 18th if the memory check passes.",
            &sources
        )
        .is_empty());
    }

    #[test]
    #[ignore = "requires an explicitly selected public claim fixture"]
    fn public_negated_claim_trace() {
        let path = std::env::var("PLAINSONG_NEGATED_CLAIM_TRACE").unwrap();
        let input: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let claim = input["claim"].as_str().unwrap();
        let citations: Vec<Citation> = serde_json::from_value(input["citations"].clone()).unwrap();
        let candidate = negated_predicates(&crate::text::itn::inverse_text_normalize(claim));
        let supported: std::collections::HashSet<_> = citations
            .iter()
            .flat_map(|citation| {
                negated_predicates(&crate::text::itn::inverse_text_normalize(&citation.text))
            })
            .collect();
        let unsupported: Vec<_> = candidate
            .iter()
            .filter(|phrase| !supported.contains(*phrase))
            .cloned()
            .collect();
        let output = serde_json::json!({"candidatePredicates":candidate,"supportedPredicates":supported,"unsupportedPredicates":unsupported,"issues":unsupported_claims(claim,&citations)});
        std::fs::write(
            format!("{path}.trace.json"),
            serde_json::to_vec_pretty(&output).unwrap(),
        )
        .unwrap();
    }
    use super::*;

    #[test]
    fn tentative_durations_cannot_become_exact_limits() {
        let source = "We've got twenty five minutes to do that as far as I can understand.";
        assert!(duration_uncertainty_lost(
            "The agenda has a time limit of 25 minutes.",
            std::iter::once(source)
        ));
        assert!(!duration_uncertainty_lost(
            "The agenda has roughly 25 minutes.",
            std::iter::once(source)
        ));
        assert!(duration_uncertainty_lost(
            "The exercise lasts 2 hours.",
            std::iter::once("The exercise lasts about 2 hours.")
        ));
        assert!(!duration_uncertainty_lost(
            "The exercise lasts 2 hours.",
            [
                "The estimate is about 2 hours.",
                "The confirmed limit is 2 hours."
            ]
            .into_iter()
        ));
        assert!(!duration_uncertainty_lost(
            "The exercise lasts 2 hours.",
            std::iter::once("The exercise lasts 2 hours. The cost is about 25 euros.")
        ));
        assert!(!duration_uncertainty_lost(
            "The exercise lasts 25 minutes.",
            std::iter::once("The exercise lasts about 25 hours.")
        ));
        let hints = duration_uncertainty_repair_hints(
            "The agenda has 25 minutes. The session has 25 minutes.",
            std::iter::once(source),
        );
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("about 25 minutes"));
        assert!(duration_uncertainty_repair_hints(
            "The agenda has about 25 minutes.",
            std::iter::once(source)
        )
        .is_empty());
        assert!(!duration_uncertainty_lost(
            "The exercise lasts 1.5 hours.",
            std::iter::once("The estimate is about 5 hours.")
        ));
        assert!(unsupported_claims(
            "The agenda has a time limit of 25 minutes.",
            &[citation(source)]
        )
        .contains(&"duration_uncertainty_lost".to_string()));
    }

    #[test]
    fn duration_repair_anchor_retains_the_qualified_source() {
        let source = "We've got twenty five minutes to do that as far as I can understand.";
        let hints = duration_uncertainty_repair_hints(
            "The allotted time is twenty five minutes.",
            std::iter::once(source),
        );
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains(source));
        assert!(hints[0].contains("about 25 minutes"));
        assert!(duration_uncertainty_repair_hints(
            "The allotted time is 25 minutes.",
            [source, "The confirmed limit is 25 minutes."].into_iter(),
        )
        .is_empty());
        let long_source = format!("{} {source}", "Other context.".repeat(40));
        let hints = duration_uncertainty_repair_hints(
            "The allotted time is 25 minutes.",
            std::iter::once(long_source.as_str()),
        );
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("about 25 minutes"));
        assert!(!hints[0].contains("Other context."));
    }

    #[test]
    fn explicit_privacy_requirements_must_survive_with_their_qualifiers() {
        for source in [
            "The recorder must work offline without an account.",
            "It must not upload recordings automatically.",
            "The application must not require an account.",
            "No account is required.",
            "The drawing workshop must not require an account.",
        ] {
            assert!(missing_privacy_requirements(
                "The project is planned.",
                [source].into_iter()
            ));
            assert!(!missing_privacy_requirements(source, [source].into_iter()));
        }
        let source = "The recorder must work offline without an account.";
        assert!(!missing_privacy_requirements(
            "## Privacy\n- The recorder must work offline without an account.",
            [source].into_iter(),
        ));
        for incomplete in [
            "The recorder must work offline.",
            "The recorder must work without an account.",
            "The recorder must work online with an account.",
        ] {
            assert!(missing_privacy_requirements(
                incomplete,
                [source].into_iter()
            ));
        }
        let source = "It must not upload recordings automatically.";
        for altered in [
            "It must upload recordings automatically.",
            "It must not upload recordings.",
            "It must not upload recordings automatically unless Dana approves.",
        ] {
            assert!(missing_privacy_requirements(altered, [source].into_iter()));
        }
        let source =
            "If the customer selects private mode, it must not upload recordings automatically.";
        assert!(!missing_privacy_requirements(source, [source].into_iter()));
        assert!(missing_privacy_requirements(
            "It must not upload recordings automatically.",
            [source].into_iter(),
        ));
        assert!(missing_privacy_requirements(
            "Unless the customer selects private mode, it must not upload recordings automatically.",
            [source].into_iter(),
        ));
        let source = "It must not upload recordings if version is 1.4 or earlier.";
        assert!(!missing_privacy_requirements(source, [source].into_iter()));
        assert!(missing_privacy_requirements(
            "It must not upload recordings if version is 1.",
            [source].into_iter(),
        ));
    }

    #[test]
    fn privacy_coverage_does_not_select_incidental_negation_or_proposals() {
        for source in [
            "Please do not turn the room lights off.",
            "For the introductory drawing exercise, do not draw a cat.",
            "The workshop must include practice with pens.",
            "Participants should draw their favourite animal.",
            "The recorder might work offline without an account.",
            "The recorder should work offline without an account.",
            "It must upload recordings automatically.",
            "An account was discussed.",
        ] {
            assert!(
                !missing_privacy_requirements("", [source].into_iter()),
                "{source}"
            );
        }
    }

    #[test]
    fn privacy_coverage_ignores_explicitly_rejected_proposals() {
        for source in [
            "We rejected the proposal that the recorder must work offline without an account.",
            "We discarded the idea that the recorder must work offline without an account.",
            "We did not adopt the suggestion that it must not upload recordings automatically.",
            "We didn't adopt the proposal that no account is required.",
            "The proposal that the recorder must work offline without an account was rejected.",
            "The idea that it must not require an account was discarded.",
            "The recommendation that no account is required was not adopted.",
        ] {
            assert!(
                !missing_privacy_requirements("", [source].into_iter()),
                "{source}"
            );
        }
    }

    #[test]
    fn rejecting_another_option_does_not_hide_current_privacy_requirements() {
        for source in [
            "We rejected cloud storage, so the recorder must work offline without an account.",
            "We rejected the proposal that cloud storage is required, so the recorder must work offline without an account.",
            "We discarded the suggestion that the recorder must work offline, but it must not upload recordings automatically.",
            "We rejected the proposal that the recorder must work online, but the recorder must work offline without an account.",
            "The idea that the recorder must work offline was rejected, but it must not require an account.",
            "We have not rejected the proposal that the recorder must work offline without an account.",
            "We never rejected the proposal that it must not upload recordings automatically.",
        ] {
            assert!(missing_privacy_requirements("", [source].into_iter()), "{source}");
            assert!(!missing_privacy_requirements(source, [source].into_iter()), "{source}");
        }
    }

    #[test]
    fn blocking_conditions_must_survive_in_one_summary_clause() {
        let source = "Do not send it if the customer declines the revised price.";
        for summary in [
            "Mara will send after legal approves. The customer has not approved yet.",
            "The customer declines another offer. The revised price is pending.",
        ] {
            assert!(missing_blocking_details(summary, std::iter::once(source)));
        }
        assert!(!missing_blocking_details(source, std::iter::once(source)));
        assert!(!missing_blocking_details(
            "Do not send it if customer declines revised price.",
            std::iter::once(source)
        ));
        for operator in ["≤", "≥", "≠", "-", "+"] {
            let source = format!("Do not deploy if balance is {operator}€1.5");
            assert!(missing_blocking_details(
                "Do not deploy if balance is €1.5",
                std::iter::once(source.as_str())
            ));
            assert!(!missing_blocking_details(
                &source,
                std::iter::once(source.as_str())
            ));
        }
        assert!(missing_blocking_details(
            "Send it if customer declines revised price.",
            std::iter::once(source)
        ));
        assert!(missing_blocking_details(
            "Do not deploy if customer declines revised price.",
            std::iter::once(source)
        ));
        // Numeric thresholds retain their blocker, units and decimal punctuation.
        assert!(missing_blocking_details(
            "",
            std::iter::once("Do not deploy if error rate exceeds 5 percent.")
        ));
        assert!(missing_blocking_details(
            "Do not deploy if cost exceeds €1.5",
            std::iter::once("Do not deploy if cost exceeds €1.4")
        ));
        assert!(!missing_blocking_details(
            "Do not deploy if cost exceeds €1.4",
            std::iter::once("Do not deploy if cost exceeds €1.4")
        ));
        assert!(!missing_blocking_details(
            "",
            std::iter::once("Do not cancel Friday's meeting.")
        ));
    }

    #[test]
    fn decimal_amounts_before_blocking_conditions_must_survive() {
        for amount in ["€1.4", "$1.40"] {
            for condition in [
                "if finance rejects",
                "unless finance approves",
                "until finance approves",
            ] {
                let source = format!("Do not pay {amount} {condition}.");
                let summary = format!("The payment amount is {amount}.");
                assert!(
                    missing_blocking_details(&summary, std::iter::once(source.as_str())),
                    "{source}"
                );
                assert!(
                    !missing_blocking_details(&source, std::iter::once(source.as_str())),
                    "{source}"
                );
            }
        }
    }

    #[test]
    fn decimal_amounts_do_not_join_a_blocker_to_an_unrelated_condition() {
        for amount in ["€1.4", "$1.40"] {
            for boundary in [". ", "! ", "? ", "; ", "\n"] {
                let source = format!(
                    "Do not pay {amount}{boundary}Discuss the schedule unless finance approves."
                );
                assert!(
                    !missing_blocking_details("", std::iter::once(source.as_str())),
                    "{source}"
                );
            }
        }
    }

    #[test]
    fn an_affirmative_unless_cannot_reverse_a_cited_prohibition() {
        let evidence = citation("Do not send the invoice unless finance approves the cost.");
        assert!(unsupported_claims(
            "Noah will send the invoice by Monday, unless finance approves the cost.",
            std::slice::from_ref(&evidence)
        )
        .contains(&CONDITIONAL_POLARITY_REASON.to_string()));
        assert!(unsupported_claims(
            "Send the invoice only if finance approves the cost.",
            std::slice::from_ref(&evidence)
        )
        .is_empty());
        assert!(unsupported_claims(
            "Do not send the invoice unless finance approves the cost.",
            &[evidence]
        )
        .is_empty());
    }

    #[test]
    fn unless_boundaries_preserve_unicode_and_distinct_numeric_conditions() {
        assert!(unsupported_claims(
            "Send the invoice unless cost is less than 10.",
            &[citation(
                "Do not send the invoice unless cost is less than ten."
            )]
        )
        .contains(&CONDITIONAL_POLARITY_REASON.to_string()));
        assert!(reverses_negated_unless(
            "İbrahim will send the invoice unless finance approves the cost.",
            &[citation(
                "Do not send the invoice unless finance approves the cost."
            )]
        ));
        for condition in ["cost >= 10", "cost < 20", "cost ≤ 10", "cost < 10.5"] {
            assert!(!reverses_negated_unless(
                &format!("Send the invoice unless {condition}."),
                &[citation("Do not send the invoice unless cost < 10.")]
            ));
        }
        assert!(reverses_negated_unless(
            "Send the invoice unless cost < 10.",
            &[citation("Do not send the invoice unless cost < 10.")]
        ));
    }

    /// Claim support reads spoken numbers through the dictation ITN: "ten
    /// oh five" supports 10:05 and nothing else, and an ambiguous ordinal
    /// phrase is supported only by its words.
    #[test]
    fn spoken_oh_times_and_ordinal_counts_support_only_their_own_reading() {
        let source = citation("It's ten oh five, so the call starts now.");
        assert!(
            unsupported_claims("The call starts at 10:05.", std::slice::from_ref(&source))
                .is_empty()
        );
        assert!(
            unsupported_claims("The call starts at 10:50.", std::slice::from_ref(&source))
                .contains(&TIME_REASON.to_string())
        );
        // No twenty-four-hour or four-digit guess backs a claimed time.
        assert!(unsupported_claims(
            "The call starts at 20:05.",
            &[citation("The call starts at twenty oh five.")]
        )
        .contains(&TIME_REASON.to_string()));

        let blocking = "Don't open enrollment unless it's ten oh five and we have three hundred and twenty second graders for the twenty first item.";
        assert!(!missing_blocking_details(
            "Don't open enrollment unless it's 10:05 and we have three hundred and twenty second graders for the twenty first item.",
            std::iter::once(blocking)
        ));
        for summary in [
            "Don't open enrollment unless it's 1005 and we have three hundred and twenty second graders for the twenty first item.",
            "Don't open enrollment unless it's 10:05 and we have 320 second graders for the twenty first item.",
            "Don't open enrollment unless it's 10:05 and we have 322nd graders for the twenty first item.",
            "Don't open enrollment unless it's 10:05 and we have three hundred and twenty second graders for the 20 first item.",
        ] {
            assert!(
                missing_blocking_details(summary, std::iter::once(blocking)),
                "{summary}"
            );
        }
    }

    #[test]
    fn clock_claims_require_cited_time_without_guessing_ambiguous_digits() {
        assert!(unsupported_claims(
            "Meet from 3:30-4:30.",
            &[citation("Start at 3:30 and finish at 4:30.")]
        )
        .is_empty());
        for source in [
            "Meet Wednesday at 3:30.",
            "Meet Wednesday at 3 30.",
            "Meet Wednesday at three thirty.",
        ] {
            assert!(
                unsupported_claims("Meet Wednesday at 3:30.", &[citation(source)]).is_empty(),
                "{source}"
            );
        }
        for (claim, source) in [
            ("Meet Wednesday at 3:30.", "Meet Wednesday at 330."),
            ("Meet Wednesday at 3:30.", "Meet Wednesday at 3:50."),
            ("Meet Wednesday at 3:30 pm.", "Meet Wednesday at 3:30 am."),
            ("Meet Wednesday at 3:30.", "Keep 3 boxes and 30 folders."),
            ("Meet Wednesday at 3:30.", "Buy them at 3 30 euros each."),
            (
                "The meeting runs from 3:30-4:30.",
                "The meeting starts at 3:30.",
            ),
            ("Meet at 3:30/4:30.", "Meet at 3:30."),
        ] {
            assert!(
                unsupported_claims(claim, &[citation(source)]).contains(&TIME_REASON.to_string()),
                "{source}"
            );
        }
    }

    #[test]
    fn supported_not_knowing_paraphrase_keeps_financial_repair() {
        let text = "One speaker noted not knowing what this amount is in Pounds. Another speaker suggested one point four Euro would make a pound, or something like that.";
        let citations = [
            citation("Which I don't actually know what that is in Pounds at all"),
            citation("one point four Euro would make a pound or something"),
        ];
        assert!(
            unsupported_claims(text, &citations).is_empty(),
            "{:?}",
            unsupported_claims(text, &citations)
        );
        assert_eq!(
            unsupported_claims("The speaker said not charging in Pounds.", &citations),
            vec![NEGATED_PREDICATE_REASON.to_string()]
        );
        for claim in [
            "The speaker is not knowing the price.",
            "The speaker does not know the price.",
        ] {
            assert!(unsupported_claims(claim, &[citation("I know the price.")])
                .contains(&NEGATED_PREDICATE_REASON.to_string()));
        }
    }

    fn citation(text: &str) -> Citation {
        Citation {
            text: text.to_string(),
            source_kind: None,
            line_id: Some("L1".to_string()),
            segment_id: Some("segment-1".to_string()),
            start_time: Some(0.0),
            end_time: Some(1.0),
            recording_id: Some("recording-1".to_string()),
            certainty: Some(1.0),
        }
    }

    #[test]
    fn reported_offer_is_not_a_confirmed_conditional_commitment() {
        let source = "Robin offered to prepare a backup if the customer approves the migration.";
        assert!(future_commitment_inflated(
            "Robin will prepare a backup if the customer approves the migration.",
            [source].into_iter()
        ));
        assert!(!future_commitment_inflated(source, [source].into_iter()));
        assert!(!future_commitment_inflated(
            "Robin will prepare a backup if the customer approves the migration.",
            [
                source,
                "Robin will prepare a backup if the customer approves the migration."
            ]
            .into_iter()
        ));
    }

    #[test]
    fn capability_and_offers_do_not_establish_firm_follow_up() {
        for source in [
            "I'll be able to um put it up or shared folder or so.",
            "I could put the notes in the shared folder.",
            "We can share the report.",
            "Priya might send the invoice.",
        ] {
            let candidate = if source.contains("folder") {
                "Speaker 1 stated they will put the information in a shared folder."
            } else if source.contains("report") {
                "They will share the report."
            } else {
                "Priya will send the invoice."
            };
            assert!(
                future_commitment_inflated(candidate, std::iter::once(source)),
                "{source}"
            );
        }
        for candidate in [
            "Speaker 1 could put notes in the shared folder.",
            "Speaker 1 will be able to put notes in the shared folder.",
            "Did Speaker 1 say they will put notes in the shared folder?",
            "If approved, Speaker 1 will put notes in the shared folder.",
        ] {
            assert!(
                !future_commitment_inflated(
                    candidate,
                    std::iter::once("I could put notes in the shared folder.")
                ),
                "{candidate}"
            );
        }
        assert!(!future_commitment_inflated(
            "I will send the invoice.",
            std::iter::once("I could send the report.")
        ));
        assert!(!future_commitment_inflated(
            "I will send the invoice Friday.",
            std::iter::once("I could send the report Friday.")
        ));
        assert!(!future_commitment_inflated(
            "I will share the report.",
            ["I could share the report.", "I will share the report."].into_iter()
        ));
        assert!(!future_commitment_inflated(
            "We won't share the report.",
            std::iter::once("We can share the report.")
        ));
    }

    #[test]
    fn proposals_and_individual_promises_do_not_establish_group_agreement() {
        for evidence in [
            "Maybe we should take notes of the financial information.",
            "I will take notes of the financial information.",
            "Have we agreed to take notes of the financial information?",
            "If the group agreed to take notes, we could share them.",
        ] {
            assert!(unsupported_claims(
                "The group agreed that notes should be taken of the financial information for later reference.",
                &[citation(evidence)],
            ).contains(&AGREEMENT_REASON.to_string()), "{evidence}");
        }
    }

    #[test]
    fn labeled_speaker_agreement_needs_matching_affirmative_evidence() {
        assert!(unsupported_claims(
            "Speaker B agreed, suggesting the notes could be put in the shared folder.",
            &[citation("I think so, I think so, I'll be able to pull it up, or I could put it in the shared folder or something.")],
        ).contains(&AGREEMENT_REASON.to_string()));
        for source in [
            "Speaker B: I could put it in the shared folder or something.",
            "Speaker C agreed to put notes in the shared folder.",
            "Speaker B agreed to put notes in the shared folder only after approval.",
            "Did Speaker B agree to put notes in the shared folder?",
        ] {
            assert!(
                unsupported_claims(
                    "Speaker B agreed to put notes in the shared folder.",
                    &[citation(source)],
                )
                .contains(&AGREEMENT_REASON.to_string()),
                "{source}"
            );
        }
        for claim in [
            "Speaker B suggested putting notes in the shared folder.",
            "If Speaker B agreed to put notes in the shared folder, they could share them.",
            "Did Speaker B agree to put notes in the shared folder?",
        ] {
            assert!(!unsupported_claims(
                claim,
                &[citation("Speaker B: I could put it in the shared folder.")]
            )
            .contains(&AGREEMENT_REASON.to_string()));
        }
        assert!(unsupported_claims(
            "The group agreed to put notes in the shared folder.",
            &[citation(
                "Speaker B agreed to put notes in the shared folder."
            )],
        )
        .contains(&AGREEMENT_REASON.to_string()));
        assert!(!unsupported_claims(
            "Speaker B agreed to put notes in the shared folder.",
            &[citation(
                "Speaker B agreed to put notes in the shared folder."
            )],
        )
        .contains(&AGREEMENT_REASON.to_string()));
    }

    #[test]
    fn supported_agreement_and_tentative_summary_remain_allowed() {
        assert!(unsupported_claims(
            "The group agreed to take notes.",
            &[citation("We agreed that notes should be taken.")],
        )
        .is_empty());
        for claim in [
            "Taking notes was suggested.",
            "The group discussed whether to take notes.",
            "If the group agreed to take notes, they could share them.",
            "Did the group agree to take notes?",
            "No concrete pending action was agreed upon.",
        ] {
            assert!(
                unsupported_claims(claim, &[citation("Maybe we should take notes.")]).is_empty(),
                "{claim}"
            );
        }
    }

    #[test]
    fn unrelated_or_opposite_agreement_cannot_support_the_claim() {
        for evidence in [
            "We agreed to cancel Friday's meeting. Maybe we should take notes.",
            "We agreed to cancel Friday's meeting, but maybe we should take notes.",
            "We agreed to take a break. Maybe we should take notes.",
            "The team agreed not to take notes.",
        ] {
            assert!(
                unsupported_claims("The group agreed to take notes.", &[citation(evidence)],)
                    .contains(&AGREEMENT_REASON.to_string()),
                "{evidence}"
            );
        }
        assert!(unsupported_claims(
            "The group agreed to take notes.",
            &[
                citation("Maybe we should take notes."),
                citation("We agreed to take notes.")
            ],
        )
        .is_empty());
    }

    #[test]
    fn agreement_actions_and_qualifiers_are_not_interchangeable() {
        assert!(unsupported_claims(
            "The group agreed to approve the product launch.",
            &[citation(
                "We agreed to discuss postponing the product launch."
            )],
        )
        .contains(&AGREEMENT_REASON.to_string()));
        for evidence in [
            "I think we agreed to launch the product.",
            "It seems the team decided to launch the product.",
        ] {
            assert!(
                unsupported_claims(
                    "The group agreed to launch the product.",
                    &[citation(evidence)],
                )
                .contains(&AGREEMENT_REASON.to_string()),
                "{evidence}"
            );
        }
        for claim in [
            "Consensus was reached to launch the product.",
            "It was agreed that we would launch the product.",
            "The team reached agreement to launch the product.",
        ] {
            assert!(
                unsupported_claims(claim, &[citation("Maybe we should launch the product.")])
                    .contains(&AGREEMENT_REASON.to_string()),
                "{claim}"
            );
            assert!(
                unsupported_claims(claim, &[citation("We agreed to launch the product.")])
                    .is_empty(),
                "{claim}"
            );
        }
        for evidence in [
            "We agreed that we might launch the product.",
            "We agreed to launch the product if financing comes through.",
            "We agreed that after legal review we would not launch the product.",
        ] {
            assert!(
                unsupported_claims(
                    "The group agreed to launch the product.",
                    &[citation(evidence)],
                )
                .contains(&AGREEMENT_REASON.to_string()),
                "{evidence}"
            );
            assert!(
                unsupported_claims(evidence, &[citation(evidence)]).is_empty(),
                "{evidence}"
            );
        }
    }

    #[test]
    fn accepts_supported_spoken_currency_paraphrases() {
        let evidence = citation(
            "The selling price is twenty five Euros. One point four Euro would make a Pound, and the other bundle is about seventeen Pounds.",
        );

        assert!(unsupported_claims(
            "The selling price is €25; €1.4 makes £1 and the bundle is roughly £17.",
            &[evidence],
        )
        .is_empty());
    }

    #[test]
    fn rejects_reversed_currency_conversion_without_disclosing_claim_text() {
        let evidence = citation(
            "The selling price is twenty five Euros. One point four Euro would make a Pound, and the other bundle is about seventeen Pounds.",
        );

        let reasons = unsupported_claims("One Euro is about 1.4 Pounds.", &[evidence]);

        assert_eq!(
            reasons,
            ["currency_amount_not_cited", "currency_relation_not_cited"]
        );
        assert!(!reasons[0].contains("Euro"));
        assert!(!reasons[0].contains("1.4"));
    }

    #[test]
    fn currency_values_elsewhere_do_not_support_a_reversed_conversion() {
        let evidence = citation(
            "The exchange rate is €1.4 per £1. Separately, the fee is €1 and a sample costs £1.4.",
        );
        assert!(
            unsupported_claims("The exchange rate is £1.4 per €1.", &[evidence])
                .contains(&"currency_relation_not_cited".to_string())
        );
    }

    #[test]
    fn preserves_supported_relation_direction_and_declines_uncited_links() {
        let evidence =
            citation("The exchange rate is €1.4 per £1. The fee is €1 and a sample costs £1.4.");
        for claim in [
            "The exchange rate is €1.4 per £1.",
            "£1 equals €1.4.",
            "€1.4 would make a Pound.",
            "The exchange rate is 1.4 EUR per GBP 1.",
        ] {
            assert!(
                unsupported_claims(claim, std::slice::from_ref(&evidence)).is_empty(),
                "{claim}"
            );
        }
        for claim in [
            "The exchange rate is £1.4 per €1.",
            "The exchange rate is £1.4 per Euro.",
            "€1 equals £1.4.",
        ] {
            assert!(
                unsupported_claims(claim, std::slice::from_ref(&evidence))
                    .contains(&CURRENCY_RELATION_REASON.to_string()),
                "{claim}"
            );
        }
        assert!(unsupported_claims(
            "The exchange rate is €1.4 per £1.",
            &[
                citation("The fee is €1.4."),
                citation("The sample costs £1.")
            ]
        )
        .contains(&CURRENCY_RELATION_REASON.to_string()));
        assert!(
            unsupported_claims("The sample costs €1.4. The fee is £1.", &[evidence]).is_empty()
        );
    }

    #[test]
    fn a_currency_word_must_belong_to_the_adjacent_amount_fragment() {
        let amount = citation("selling price is twenty five");
        let mut unit = citation("Euros");
        unit.line_id = Some("L2".into());
        unit.start_time = Some(1.0);
        unit.end_time = Some(2.0);
        assert!(
            unsupported_claims("The price is €25.", &[amount.clone(), unit.clone()]).is_empty()
        );
        assert!(
            unsupported_claims("The price is €25.", &[unit.clone(), amount.clone()]).is_empty()
        );
        let mut dollar_after_euro = unit.clone();
        dollar_after_euro.text = "USD".into();
        assert!(unsupported_claims(
            "The price is $25.",
            &[citation("selling price is €25"), dollar_after_euro]
        )
        .contains(&CURRENCY_REASON.to_string()));
        let mut standalone = citation("The price is €25.");
        standalone.recording_id = None;
        standalone.line_id = None;
        standalone.start_time = None;
        standalone.end_time = None;
        assert!(unsupported_claims("The price is €25.", &[standalone]).is_empty());
        let mut dollar = unit.clone();
        dollar.text = "dollar".into();
        assert!(unsupported_claims(
            "The price is $1.",
            &[citation("selling price is one"), dollar]
        )
        .is_empty());
        for kind in [
            "distant",
            "other-recording",
            "skipped-line",
            "question",
            "overlapping",
            "missing-time",
            "nonfinite-time",
        ] {
            let mut unrelated = unit.clone();
            match kind {
                "distant" => {
                    unrelated.start_time = Some(10.0);
                    unrelated.end_time = Some(11.0);
                }
                "other-recording" => unrelated.recording_id = Some("other-recording".into()),
                "skipped-line" => unrelated.line_id = Some("L3".into()),
                "question" => unrelated.text = "Euros?".into(),
                "overlapping" => unrelated.start_time = Some(0.5),
                "missing-time" => unrelated.start_time = None,
                "nonfinite-time" => unrelated.start_time = Some(f64::NAN),
                _ => unreachable!(),
            }
            assert!(
                unsupported_claims("The price is €25.", &[amount.clone(), unrelated])
                    .contains(&CURRENCY_REASON.to_string()),
                "{kind}"
            );
        }
    }

    #[test]
    fn monetary_context_cannot_turn_mass_pounds_into_a_fee() {
        assert!(currency_relations("The package weighs 17 pounds equals €5.").is_empty());
        for source in [
            "The package weighs 17 pounds.",
            "The package weighs seventeen seventeen seventeen pounds.",
            "The price is €25 and the package weighs 17 pounds.",
            "The package weighs 17 pounds. The fee is unknown.",
        ] {
            assert!(
                unsupported_claims("The fee is £17.", &[citation(source)])
                    .contains(&CURRENCY_REASON.to_string()),
                "{source}"
            );
        }
        assert!(unsupported_claims(
            "The fee is £17.",
            &[citation(
                "The package weighs 17 pounds and the fee is 17 pounds."
            )]
        )
        .is_empty());
    }

    #[test]
    fn tentative_finance_and_questions_cannot_become_firm_amounts() {
        for source in [
            "About seventeen seventeen seventeen pounds.",
            "An estimate of roughly £17 was mentioned.",
            "Maybe the cost is £17.",
            "Is the fee £17?",
        ] {
            assert!(
                financial_uncertainty_lost("The amount is £17.", std::iter::once(source)),
                "{source}"
            );
            assert!(
                !financial_uncertainty_lost(
                    "A tentative estimate was about £17.",
                    std::iter::once(source)
                ),
                "{source}"
            );
        }
        assert!(financial_uncertainty_lost(
            "The fee is £17.4.",
            std::iter::once("Could the fee be £17.4?")
        ));
        assert!(!financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("Is the fee £17? Yes, the fee is £17.")
        ));
        assert!(!financial_uncertainty_lost(
            "The price is €25.",
            std::iter::once("The selling price is twenty five Euros.")
        ));
        assert!(!financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("We talked about the fee of £17.")
        ));
    }

    #[test]
    fn postfix_uncertainty_and_immediate_answers_keep_their_strength() {
        for source in [
            "The rate is €1.4 per £1, I think.",
            "The fee is £17 maybe.",
            "It was £17, approximately.",
            "The fee was £17,\u{00a0}I think.",
        ] {
            let claim = if source.contains("rate") {
                "The rate is €1.4 per £1."
            } else {
                "The fee is £17."
            };
            assert!(
                financial_uncertainty_lost(claim, std::iter::once(source)),
                "{source}"
            );
        }
        assert!(!financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("Is the fee £17? Yes.")
        ));
        assert!(financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("Is the fee £17? Maybe.")
        ));
        assert!(financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("Is the fee about £17? Yes.")
        ));
        assert!(financial_uncertainty_lost(
            "The fee is £17.",
            std::iter::once("Is the fee £17? We discussed another topic. Yes.")
        ));
        assert!(!financial_uncertainty_lost(
            "The fee is £25.",
            std::iter::once("The fee is £25, could the budget be £17?")
        ));
    }

    #[test]
    fn a_rates_postfix_hedge_cannot_qualify_the_next_bare_estimate() {
        let sources = [
            "The price is €25.",
            "One point four Euro would make a pound or something.",
            "About seventeen seventeen seventeen pounds.",
        ];
        assert!(financial_uncertainty_lost("The price is €25. A speaker suggested €1.4 per £1, or something, and another speaker mentioned £17.", sources.iter().copied()));
        assert!(!financial_uncertainty_lost("The price is €25. A speaker suggested €1.4 per £1, or something, and another speaker mentioned about £17.", sources.iter().copied()));
        assert!(!financial_uncertainty_lost(
            "The price is €25.",
            std::iter::once("The price is €25, roughly £17.")
        ));
        assert!(financial_uncertainty_lost(
            "The amount is £17.",
            std::iter::once("The amount is £17, I think, and the fee is €25.")
        ));
    }

    #[test]
    fn explicit_pricing_verbs_need_the_same_supported_amount_and_role() {
        let conversion = [
            citation("The selling price is twenty five Euros."),
            citation("About seventeen pounds is a tentative conversion estimate."),
        ];
        for claim in [
            "Speaker 4 suggested seventeen pounds for the selling price.",
            "Speaker 4 recommended £17 as the price.",
            "Speaker 4 proposed £17 for the fee.",
            "£17 was suggested as the selling price.",
        ] {
            assert!(
                unsupported_claims(claim, &conversion)
                    .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{claim}"
            );
        }
        let proposal = [citation("Speaker 4 suggested £17 for the selling price.")];
        assert!(!unsupported_claims("The price should be £17.", &proposal)
            .contains(&PRICE_RECOMMENDATION_REASON.to_string()));
        assert!(
            !unsupported_claims("£17 was proposed as the price.", &proposal)
                .contains(&PRICE_RECOMMENDATION_REASON.to_string())
        );
        for source in [
            "Speaker 4 did not suggest £17 for the price.",
            "Speaker 4 didn't recommend £17 as the price.",
            "If Speaker 4 suggested £17 for the price, ask finance.",
            "Did Speaker 4 propose £17 for the price?",
        ] {
            assert!(
                unsupported_claims(
                    "Speaker 4 suggested £17 for the price.",
                    &[citation(source)]
                )
                .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{source}"
            );
        }
        assert!(!unsupported_claims(
            "Speaker 4 suggested about £17 as a conversion estimate.",
            &conversion
        )
        .contains(&PRICE_RECOMMENDATION_REASON.to_string()));
    }

    #[test]
    fn a_conversion_estimate_does_not_support_a_selling_price_proposal() {
        let source = [
            citation("The selling price is twenty five Euros."),
            citation("One point four Euro would make a pound or something."),
            citation("About seventeen pounds."),
        ];
        assert!(unsupported_claims(
            "Speaker S4 suggested that seventeen pounds should be the price.",
            &source
        )
        .contains(&PRICE_RECOMMENDATION_REASON.to_string()));
        assert!(!unsupported_claims(
            "A rough pound estimate of about seventeen pounds was mentioned.",
            &source
        )
        .contains(&PRICE_RECOMMENDATION_REASON.to_string()));
        for claim in [
            "Is £17 what should be the price?",
            "If £17 should be the price, we need approval.",
            "The converted price should be about £17.",
        ] {
            assert!(
                !unsupported_claims(claim, &source)
                    .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{claim}"
            );
        }
    }

    #[test]
    fn stated_pricing_proposals_support_equivalent_word_order_not_other_amounts_or_roles() {
        let source = [citation("The selling price should be about £17.")];
        for claim in [
            "£17 should be the selling price.",
            "The price should be £17.",
        ] {
            assert!(
                !unsupported_claims(claim, &source)
                    .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{claim}"
            );
        }
        for claim in ["£18 should be the price.", "£17 should be the fee."] {
            assert!(
                unsupported_claims(claim, &source)
                    .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{claim}"
            );
        }
        for source in [
            "Should £17 be the price?",
            "If £17 should be the price, ask finance.",
            "£17 should not be the price.",
        ] {
            assert!(
                unsupported_claims("£17 should be the price.", &[citation(source)])
                    .contains(&PRICE_RECOMMENDATION_REASON.to_string()),
                "{source}"
            );
        }
    }

    #[test]
    fn the_saved_public_recap_must_keep_the_pound_amount_tentative() {
        let evidence = [
            citation("our selling price at twenty five Euros"),
            citation("one point four Euro would make a pound or something like that"),
            citation("yeah about seventeen seventeen seventeen pounds"),
        ];
        let saved = "The selling price is twenty five Euros. Speaker 2 suggested that one point four Euro would make a pound. Speaker 4 stated that seventeen pounds should be the amount.";
        assert!(
            unsupported_claims(saved, &evidence).contains(&FINANCIAL_CERTAINTY_REASON.to_string())
        );
        let corrected = "The selling price is twenty five Euros. A suggested exchange rate was one point four Euro per pound. A rough estimate of about seventeen pounds was mentioned.";
        assert!(unsupported_claims(corrected, &evidence).is_empty());
    }

    #[test]
    fn rate_qualifiers_stay_with_rate_pairs_not_independent_prices() {
        let source = "The price is €25. One point four Euro would make a pound or something. About seventeen seventeen seventeen Pounds.";
        assert!(financial_uncertainty_lost(
            "The price is €25. The exchange rate is €1.4 per £1. The equivalent is £17.",
            std::iter::once(source)
        ));
        assert!(!financial_uncertainty_lost(
            "The price is €25. A suggested rate was €1.4 per £1. A tentative estimate was £17.",
            std::iter::once(source)
        ));
        let source = "The selling price is €1.4. Maybe the rate is €1.4 per £1.";
        assert!(!financial_uncertainty_lost(
            "The selling price is €1.4.",
            std::iter::once(source)
        ));
        assert!(financial_uncertainty_lost(
            "The rate is €1.4 per £1.",
            std::iter::once(source)
        ));
    }

    #[test]
    fn a_firm_fee_does_not_erase_a_matching_uncertain_estimate() {
        let source = "The service fee is £17. The estimate is about £17.";
        assert!(!financial_uncertainty_lost(
            "The fee is £17. The estimate is about £17.",
            std::iter::once(source)
        ));
        assert!(financial_uncertainty_lost(
            "The amount is £17.",
            std::iter::once(source)
        ));
        let source = "The service fee is £17, using a suggested rate of €1.4 per £1.";
        assert!(!financial_uncertainty_lost(
            "The service fee is £17.",
            std::iter::once(source)
        ));
        assert!(financial_uncertainty_lost(
            "The rate is €1.4 per £1.",
            std::iter::once(source)
        ));
    }

    #[test]
    fn overlapping_currency_spans_and_decimal_boundaries_do_not_panic() {
        assert!(financial_uncertainty_lost(
            "The rate is £1=$1.",
            std::iter::once("Maybe €1=£1=$1.")
        ));
        assert!(!financial_uncertainty_lost(
            "The price is €25.",
            std::iter::once("The price in euros is 25 euros.")
        ));
        assert!(financial_uncertainty_lost(
            "The fee is €17.4.",
            std::iter::once("Maybe the fee is 17,40 euros. The price is €25.")
        ));
    }

    #[test]
    fn financial_coverage_accepts_an_implicit_rate_unit_and_requires_the_repeated_estimate() {
        let source = [
            "The selling price is twenty five Euros.",
            "One point four Euro would make a pound or something.",
            "About seventeen seventeen seventeen Pounds.",
        ];
        let with_fee = [
            source[0],
            source[1],
            source[2],
            "A separate service fee is £1.",
        ];
        let same_passage = with_fee.join(" ");
        for summary in [
            "The price is €25. A tentative estimate was £17, using a suggested exchange rate of €1.4 per pound.",
            "The price is €25. A tentative estimate was £17, using a suggested exchange rate of €1.4 per £1.",
        ] {
            assert!(!missing_financial_details(summary, source.iter().copied()));
            assert!(missing_financial_details(summary, with_fee.iter().copied()));
            assert!(missing_financial_details(summary, std::iter::once(same_passage.as_str())));
            let fee_summary = format!("{} The service fee is £1.", summary);
            assert!(!missing_financial_details(&fee_summary, with_fee.iter().copied()));
            assert!(!missing_financial_details(&fee_summary, std::iter::once(same_passage.as_str())));
        }
        for summary in [
            "A tentative estimate was £17, using a suggested exchange rate of €1.4 per pound.",
            "The price is €25, using a suggested exchange rate of €1.4 per pound.",
            "The price is €25. A tentative estimate was £17.",
            "The price is €25. A tentative estimate was £17, using a suggested exchange rate of £1.4 per euro.",
            "The price is €25. A tentative estimate was €17, using a suggested exchange rate of €1.4 per pound.",
        ] { assert!(missing_financial_details(summary, source.iter().copied()), "{summary}"); }
    }

    #[test]
    fn repeated_spoken_currency_amount_is_supported_without_rewriting_the_quote() {
        let evidence = citation("yeah about seventeen seventeen seventeen Pounds");
        assert!(unsupported_claims(
            "An estimate of £17 was mentioned.",
            std::slice::from_ref(&evidence)
        )
        .is_empty());
        assert_eq!(
            evidence.text,
            "yeah about seventeen seventeen seventeen Pounds"
        );
        assert!(unsupported_claims(
            "An estimate of €17 was mentioned.",
            std::slice::from_ref(&evidence)
        )
        .contains(&CURRENCY_REASON.to_string()));
        assert!(
            unsupported_claims("An estimate of £18 was mentioned.", &[evidence])
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(unsupported_claims(
            "The price was €20.",
            &[citation("twenty twenty twenty Euros")]
        )
        .is_empty());
    }

    #[test]
    fn repeated_currency_evidence_does_not_join_different_numbers_or_line_fragments() {
        for source in [
            "seventeen eighteen Pounds",
            "seventeen seventeen Pounds",
            "eighteen seventeen seventeen seventeen Pounds",
            "20 seventeen seventeen seventeen Pounds",
            "€ seventeen seventeen seventeen Pounds",
            "EUR seventeen seventeen seventeen Pounds",
            "twenty seventeen seventeen seventeen Pounds",
            "one hundred seventeen seventeen seventeen Pounds",
            "two two Pounds",
            "seventeen\nseventeen\nPounds",
            "later later Euros",
        ] {
            assert!(
                unsupported_claims("An estimate of £17 was mentioned.", &[citation(source)])
                    .contains(&CURRENCY_REASON.to_string()),
                "{source}"
            );
        }
        assert!(unsupported_claims(
            "The price was £20.",
            &[citation("twenty twenty twenty pounds of flour")]
        )
        .contains(&CURRENCY_REASON.to_string()));
        assert!(
            unsupported_claims("The price was €20.", &[citation("twenty twenty Euros")])
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(
            unsupported_claims("The price was £2.", &[citation("two two Pounds")])
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(
            unsupported_claims("The price was €17.", &[citation("later later Euros")])
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(unsupported_claims(
            "The exchange rate was €1.4 per pound.",
            &[citation("seventeen seventeen Pounds")]
        )
        .contains(&CURRENCY_REASON.to_string()));
    }

    #[test]
    fn currency_amounts_do_not_combine_independent_citation_numbers() {
        let first = citation("twenty");
        let mut second = citation("five Euros");
        second.line_id = Some("L2".into());
        second.start_time = Some(10.0);
        second.end_time = Some(11.0);
        assert!(
            unsupported_claims("The price is €25.", &[first.clone(), second.clone()])
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(unsupported_claims("The price is €5.", &[first, second]).is_empty());
        let amount = citation("selling price is twenty five");
        let mut unit = citation("Euros");
        unit.line_id = Some("L2".into());
        unit.start_time = Some(1.0);
        unit.end_time = Some(2.0);
        assert!(unsupported_claims("The price is €25.", &[amount, unit]).is_empty());
    }

    #[test]
    fn currency_relations_do_not_bridge_lines_or_treat_mass_as_a_rate() {
        assert!(currency_relations("€1.4\nper £1").is_empty());
        assert!(currency_relations("Potatoes cost €2 per pound of potatoes.").is_empty());
        assert!(currency_relations("The weight is 3 pounds, and the price is €5.").is_empty());
        assert!(currency_relations("3 pounds of flour equals €5").is_empty());
        assert!(unsupported_claims(
            "£1=€1.4;£2=$3",
            &[citation("£1=€1.4. The fee is £2 and the price is $3.")]
        )
        .contains(&CURRENCY_RELATION_REASON.to_string()));
        assert_eq!(currency_relations("€1=£1=$1").len(), 2);
        assert!(unsupported_claims(
            "€5=£3 of the budget.",
            &[citation("The cost is €5 and the fee is £3.")]
        )
        .contains(&CURRENCY_RELATION_REASON.to_string()));
        assert!(unsupported_claims(
            "EUR 5 equals GBP 3 of the total.",
            &[citation("The cost is EUR 5 and the fee is GBP 3.")]
        )
        .contains(&CURRENCY_RELATION_REASON.to_string()));
    }

    #[test]
    fn rejects_actual_unsupported_pound_prefix_but_accepts_supported_analogue() {
        let evidence = citation(
            "The selling price is twenty-five Euros. Any ideas what that is in pounds? It's about seventeen point four. One point four Euro would make a Pound. Later they said about seventeen Pounds.",
        );
        assert_eq!(
            unsupported_claims(
                "The material stated fact regarding finance is a selling price of twenty-five Euros. One person mentioned that the equivalent in pounds is about seventeen point four.",
                std::slice::from_ref(&evidence),
            ),
            ["currency_amount_not_cited"]
        );
        assert!(unsupported_claims(
            "The finance discussion gave a selling price of twenty-five Euros. The equivalent in pounds is about seventeen.",
            &[evidence],
        )
        .is_empty());
    }

    #[test]
    fn recognizes_iso_and_unambiguous_currency_word_copula_prefixes() {
        let evidence = citation("The approved figures are 17.4 pounds, 25 euros, and 30 dollars.");

        assert!(unsupported_claims(
            "GBP is roughly 17.4, Euro is 25, and USD was about 30.",
            &[evidence],
        )
        .is_empty());
    }

    #[test]
    fn does_not_carry_prefix_currency_across_questions_or_sentences() {
        let evidence = citation(
            "The selling price is 25 euros. What is the equivalent in pounds? It is about 17.4.",
        );

        assert_eq!(
            unsupported_claims(
                "The selling price is 25 euros. The equivalent in pounds is about 17.4.",
                &[evidence],
            ),
            ["currency_amount_not_cited"]
        );
    }

    #[test]
    fn does_not_bind_negated_weight_or_malformed_prefix_amounts() {
        let no_price = citation("No currency amount was given.");

        assert!(unsupported_claims(
            "The weight in pounds is about 17.4.",
            std::slice::from_ref(&no_price)
        )
        .is_empty());
        assert!(
            !unsupported_claims("GBP is not about 17.4.", std::slice::from_ref(&no_price))
                .contains(&CURRENCY_REASON.to_string())
        );
        assert!(
            unsupported_claims("GBP is about 1,2,3.", std::slice::from_ref(&no_price)).is_empty()
        );
        assert!(
            unsupported_claims("Euro is about\n17.4 was a version number.", &[no_price]).is_empty()
        );
    }

    #[test]
    fn does_not_treat_ambiguous_pound_carriers_as_money_in_mass_contexts() {
        let priced_evidence = citation("The price was 25 euros.");

        for claim in [
            "The price was 25 euros. The weight's equivalent in pounds is about 17.4.",
            "The price was 25 euros. The mass total in pounds is about 17.4.",
            "The price was 25 euros. The weight amount in pounds is about 17.4.",
            "The price was 25 euros. The kilogram value in pounds is about 17.4.",
        ] {
            assert!(unsupported_claims(claim, std::slice::from_ref(&priced_evidence)).is_empty());
        }

        assert!(unsupported_claims(
            "The shipment total in pounds is about 17.4.",
            &[citation("No currency amount was given.")],
        )
        .is_empty());
        assert!(unsupported_claims(
            "The weight was 17 pounds. Its equivalent in pounds is about 7.7.",
            &[citation("The weight was 17 pounds.")],
        )
        .is_empty());
        assert_eq!(
            unsupported_claims(
                "The price in pounds is about 17.4.",
                &[citation("No currency amount was given.")],
            ),
            ["currency_amount_not_cited"]
        );
    }

    #[test]
    fn accepts_symbols_grouping_decimal_commas_and_spoken_amounts() {
        let evidence = citation("Budget: $15,000. The quoted unit price was €25,50.");

        assert!(unsupported_claims(
            "The budget is fifteen thousand dollars and the unit price is 25.50 euros.",
            &[evidence],
        )
        .is_empty());
        assert!(unsupported_claims(
            "The budget is $15,000.00.",
            &[citation("The approved budget is fifteen thousand dollars.")],
        )
        .is_empty());
    }

    #[test]
    fn keeps_currency_units_distinct_and_ignores_bare_numbers() {
        let evidence = citation("The estimate was $25 for version 18.");

        assert_eq!(
            unsupported_claims("The estimate was €25.", std::slice::from_ref(&evidence)),
            ["currency_amount_not_cited"]
        );
        assert!(unsupported_claims("This concerns version 17.", &[evidence]).is_empty());
    }

    #[test]
    fn recognizes_currency_next_to_quotes_but_not_inside_words() {
        let quoted = citation("She called it “€25,” after tax.");
        let embedded = citation("The identifier is x€25y.");

        assert!(unsupported_claims("The quoted amount was 25 euros.", &[quoted]).is_empty());
        assert_eq!(
            unsupported_claims("The quoted amount was €25.", &[embedded]),
            ["currency_amount_not_cited"]
        );
    }

    #[test]
    fn checks_each_adjacent_currency_amount_without_losing_the_shared_boundary() {
        let evidence = citation("The options are $25 €30.");

        assert!(unsupported_claims(
            "The euro option is 30 euros.",
            std::slice::from_ref(&evidence)
        )
        .is_empty());
        assert_eq!(
            unsupported_claims("The pound option is £30.", std::slice::from_ref(&evidence)),
            ["currency_amount_not_cited"]
        );
    }

    #[test]
    fn leaves_ambiguous_currency_punctuation_unflagged() {
        let evidence = citation("The draft contains no price yet.");

        assert!(unsupported_claims("The estimate is €1,2,3.", &[evidence]).is_empty());
        assert!(unsupported_claims(
            "The estimate is €1.400.",
            &[citation("No estimate was given.")],
        )
        .is_empty());
        assert!(unsupported_claims(
            "The estimate is 1 000,00 €.",
            &[citation("No estimate was given.")],
        )
        .is_empty());
    }

    #[test]
    fn quote_delimiters_do_not_change_supported_negative_objects() {
        for claim in [
            "The product must not be a 'hunk of metal'.",
            "The product must not be a ‘hunk of metal’.",
            "The product must not be a \"hunk of metal\".",
        ] {
            assert!(
                unsupported_claims(claim, &[citation("not hunk of metal, and user-friendly")])
                    .is_empty(),
                "{claim}"
            );
        }
        assert!(unsupported_claims(
            "Do not approve Dana's expense unless Marcus checks it.",
            &[citation(
                "Do not approve Dana's expense unless Marcus checks it."
            )]
        )
        .is_empty());
        assert!(unsupported_claims(
            "Do not approve Marcus's expense unless Dana checks it.",
            &[citation(
                "Do not approve Dana's expense unless Marcus checks it."
            )]
        )
        .contains(&NEGATED_PREDICATE_REASON.to_string()));
        assert!(unsupported_claims(
            "The product must not be 'metal'.",
            &[citation("The product should not be a hunk of metal.")]
        )
        .contains(&NEGATED_PREDICATE_REASON.to_string()));
    }

    #[test]
    fn rejects_absent_immediate_negated_predicate() {
        let evidence = citation("The case is easy to carry and has rounded corners.");

        assert_eq!(
            unsupported_claims("The case is not bulky or metallic.", &[evidence]),
            ["negated_predicate_not_cited"]
        );
    }

    #[test]
    fn mentioning_a_material_does_not_support_its_exclusion() {
        for source in [
            "The remote should not be a hunk of metal.",
            "The remote uses metal and should not be bulky.",
        ] {
            assert!(
                unsupported_claims("The remote must not be metal.", &[citation(source)])
                    .contains(&NEGATED_PREDICATE_REASON.to_string()),
                "{source}"
            );
        }
        assert!(unsupported_claims(
            "The remote is not metallic.",
            &[citation("The remote is metallic.")]
        )
        .contains(&NEGATED_PREDICATE_REASON.to_string()));
        assert!(unsupported_claims(
            "The remote is not a hunk of metal.",
            &[citation("It should not be a hunk of metal.")]
        )
        .is_empty());
    }

    #[test]
    fn negation_keeps_objects_coordination_and_clause_scope() {
        for (claim, source) in [
            (
                "The remote should not have metal.",
                "The remote should not have sharp edges.",
            ),
            (
                "It should not be a hunk of metal.",
                "It should not be a hunk of plastic.",
            ),
            (
                "The case is not bulky or metallic.",
                "The case is not bulky.",
            ),
            (
                "The case is not metallic.",
                "The case is not bulky and is metallic.",
            ),
            ("They do not know.", "They do not not know."),
            (
                "The case is not bulky.",
                "The case is not bulky when folded.",
            ),
        ] {
            assert!(
                unsupported_claims(claim, &[citation(source)])
                    .contains(&NEGATED_PREDICATE_REASON.to_string()),
                "{claim} / {source}"
            );
        }
        for (claim, source) in [
            (
                "The case is not bulky or metallic.",
                "It is not bulky or metallic.",
            ),
            (
                "They will not cancel the Friday meeting.",
                "They won't cancel Friday meeting.",
            ),
            ("It cannot have metal.", "It can't have metal."),
            (
                "The case is not bulky when folded.",
                "It is not bulky when folded.",
            ),
        ] {
            assert!(
                unsupported_claims(claim, &[citation(source)]).is_empty(),
                "{claim} / {source}"
            );
        }
    }

    #[test]
    fn accepts_negated_predicate_with_contraction_and_unicode_boundaries() {
        let evidence = citation("It isn’t metallic; the café team verified that.");

        assert!(unsupported_claims("The case is not metallic.", &[evidence]).is_empty());
    }

    #[test]
    fn missing_punctuation_does_not_extend_negation_into_a_new_subject() {
        let source = "let's meet on wednesday at 3 30. don't cancel the friday meeting the budget is 25 euros roughly 17 pounds the exchange rate is 1.4";
        assert!(
            unsupported_claims("Do not cancel the Friday meeting.", &[citation(source)]).is_empty()
        );
        assert!(unsupported_claims(
            "The case should not have metal.",
            &[citation(
                "The case should not have metal the coating is plastic."
            )]
        )
        .is_empty());
        for source in [
            "Do not cancel the Friday meeting until Priya confirms the budget is correct.",
            "Do not cancel the Friday meeting if the budget is approved.",
            "Do not cancel the Friday meeting the budget is final unless Priya approves.",
            "Do not cancel the Friday meeting the budget is approved if Priya confirms.",
            "Do not cancel the Friday meeting the client has requested.",
            "Do not cancel the Friday meeting the client has not approved.",
            "Do not cancel the Friday meeting the team is planning.",
            "Do not cancel the Friday meeting the team is required to attend.",
            "The case is not metallic when the coating is removed.",
            "Do not cancel the Friday meeting or the Monday meeting the budget is correct.",
        ] {
            let claim = if source.starts_with("The case") {
                "The case is not metallic."
            } else {
                "Do not cancel the Friday meeting."
            };
            assert!(
                unsupported_claims(claim, &[citation(source)])
                    .contains(&NEGATED_PREDICATE_REASON.to_string()),
                "{source}"
            );
        }
        assert!(
            unsupported_claims("Do not cancel the Monday meeting.", &[citation(source)])
                .contains(&NEGATED_PREDICATE_REASON.to_string())
        );
    }

    #[test]
    fn does_not_treat_empty_meeting_metaclaims_as_predicates() {
        let evidence = citation("We discussed the launch but did not settle anything.");

        assert!(unsupported_claims(
            "There were no agreed decisions and no pending tasks.",
            std::slice::from_ref(&evidence),
        )
        .is_empty());
        assert!(unsupported_claims("No decisions were agreed.", &[evidence]).is_empty());
    }

    #[test]
    fn decision_metaclaims_allow_base_verbs_without_exempting_factual_negation() {
        let evidence = citation("We discussed the launch but did not settle anything.");
        for claim in [
            "The team did not decide on the next steps.",
            "The team did not agree on any pending action.",
            "The team did not settle the open decisions.",
        ] {
            assert!(
                unsupported_claims(claim, std::slice::from_ref(&evidence)).is_empty(),
                "{claim}"
            );
        }
        assert!(
            unsupported_claims("The team did not cancel the launch.", &[evidence])
                .contains(&NEGATED_PREDICATE_REASON.to_string())
        );
    }

    #[test]
    fn rejects_negated_identity_as_a_positive_drawing_list() {
        let evidence = citation("It doesn't look quite like I wanted. It's not a vampire bat, honestly. It's meant to be an eagle.");
        assert!(unsupported_claims(
            "Participants drew a tiger, dog, eagle, and vampire bat.",
            &[evidence]
        )
        .contains(&NEGATED_IDENTITY_REASON.to_string()));
        assert!(unsupported_claims(
            "The drawing was a vampire bat.",
            &[citation("It isn't a vampire bat.")]
        )
        .contains(&NEGATED_IDENTITY_REASON.to_string()));
    }

    #[test]
    fn preserves_negation_and_neutral_identity_mentions() {
        let evidence = citation("It's not a vampire bat, honestly. It's meant to be an eagle.");
        for claim in [
            "The drawing was not a vampire bat.",
            "The group discussed a vampire bat comparison.",
            "Participants drew an eagle.",
        ] {
            assert!(
                !unsupported_claims(claim, std::slice::from_ref(&evidence))
                    .contains(&NEGATED_IDENTITY_REASON.to_string()),
                "{claim}"
            );
        }
    }

    #[test]
    fn accepts_an_independently_supported_positive_drawing() {
        assert!(!unsupported_claims(
            "Someone drew a vampire bat.",
            &[
                citation("My drawing is not a vampire bat."),
                citation("I drew a vampire bat."),
            ]
        )
        .contains(&NEGATED_IDENTITY_REASON.to_string()));
        assert!(!unsupported_claims(
            "Someone drew a vampire bat.",
            &[citation("It is not only a vampire bat, but also an eagle.")]
        )
        .contains(&NEGATED_IDENTITY_REASON.to_string()));
    }

    #[test]
    fn does_not_make_a_positive_claim_from_a_negated_drawing_verb() {
        assert!(!unsupported_claims(
            "They did not draw a vampire bat.",
            &[citation("It's not a vampire bat.")]
        )
        .contains(&NEGATED_IDENTITY_REASON.to_string()));
    }

    #[test]
    fn a_hypothetical_drawing_does_not_override_a_negated_identity() {
        for hypothetical in [
            "I might draw a vampire bat.",
            "If it was a vampire bat, it would have wings.",
        ] {
            assert!(
                unsupported_claims(
                    "Someone drew a vampire bat.",
                    &[
                        citation("My drawing is not a vampire bat."),
                        citation(hypothetical),
                    ]
                )
                .contains(&NEGATED_IDENTITY_REASON.to_string()),
                "{hypothetical}"
            );
        }
    }

    #[test]
    #[ignore = "requires a frozen native meeting result through PLAINSONG_NEGATION_EVAL_JSON"]
    fn frozen_native_summary_negated_identity_is_rejected() {
        let path = std::env::var("PLAINSONG_NEGATION_EVAL_JSON").expect("frozen evaluation path");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let claim = value["recording"]["summary"]
            .as_str()
            .expect("saved summary");
        let sources: Vec<_> = value["recording"]["summaryProvenance"]["citations"]
            .as_array()
            .expect("saved citations")
            .iter()
            .map(|source| citation(source["text"].as_str().expect("source text")))
            .collect();
        assert!(unsupported_claims(claim, &sources).contains(&NEGATED_IDENTITY_REASON.to_string()));
    }
}
