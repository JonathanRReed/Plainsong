//! Conservative recall of explicit commitments. Keep source wording intact;
//! membership, owner and deadline still pass the production relationship checks.
use super::action_support::{deadline_supported, owner_supported, task_needs_review, Source};
use std::sync::LazyLock;

pub(super) struct Commitment {
    pub task: String,
    pub owner: Option<String>,
    pub deadline: Option<String>,
}

pub(super) fn commitments(text: &str, speaker: Option<&str>) -> Vec<Commitment> {
    static START: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|[.!?;]\s+|,?\s+and\s+|^Yes[,!.]\s+|^Sure[,!.]\s+)(?:Correction:\s+)?(?P<subject>I|We|[\p{Lu}][\p{L}\p{M}]+(?:\s+[\p{Lu}][\p{L}\p{M}]+)?)(?:['’]ll|\s+won['’]t|\s+will|\s+agreed\s+to)\s+").unwrap()
    });
    static DUE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:by|on)\s+((?:next\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[0-9]{1,2}(?:st|nd|rd|th)?|[0-9]{4}-[0-9]{2}-[0-9]{2}|(?:the\s+)?(?:[12][0-9]|3[01]|[1-9])(?:st|nd|rd|th)|the\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|(?:twenty|thirty)[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)))\b|\b(today|tomorrow)\b").unwrap()
    });
    // Quoted examples and source code are data, not the current speaker's
    // promise. Leave their interpretation to the model and review path.
    if text.contains(['"', '“', '”', '`']) {
        return Vec::new();
    }
    if has_retraction(text) {
        return Vec::new();
    }
    let starts: Vec<_> = START.captures_iter(text).collect();
    let sources = [Source {
        text,
        speaker,
        cited: true,
    }];
    let mut result = Vec::new();
    for (index, capture) in starts.iter().enumerate() {
        let subject = &capture["subject"];
        if matches!(subject, "They" | "He" | "She" | "It" | "You") {
            continue;
        }
        let subject_start = capture.name("subject").unwrap().start();
        let start = capture.get(0).unwrap().end();
        // A sentence boundary must not split decimal version/amount values.
        let end = text[start..]
            .char_indices()
            .find_map(|(at, ch)| {
                let decimal = ch == '.'
                    && at > 0
                    && text.as_bytes()[start + at - 1].is_ascii_digit()
                    && text
                        .as_bytes()
                        .get(start + at + 1)
                        .is_some_and(u8::is_ascii_digit);
                (matches!(ch, '.' | '!' | '?' | ';' | '\n') && !decimal)
                    .then_some(start + at + ch.len_utf8())
            })
            .unwrap_or(text.len());
        let sentence_start = text[..subject_start]
            .rfind(['.', '!', '?', ';', '\n'])
            .map_or(0, |at| at + 1);
        let prefix = text[sentence_start..subject_start].trim().to_lowercase();
        if ["if ", "unless ", "when ", "provided "]
            .iter()
            .any(|word| prefix.starts_with(word))
        {
            continue;
        }
        let end = starts
            .get(index + 1)
            .map_or(end, |next| next.get(0).unwrap().start().min(end));
        let mut task = text[start..end]
            .trim()
            .trim_end_matches(',')
            .trim()
            .to_string();
        let tail = text[end..].trim_start();
        if ["It must ", "It needs ", "This must ", "This needs "]
            .iter()
            .any(|prefix| tail.starts_with(prefix))
        {
            let constraint = tail.split_inclusive(['.', '!', '?']).next().unwrap_or(tail);
            task.push(' ');
            task.push_str(constraint);
        }
        if capture.get(0).unwrap().as_str().contains("won't")
            || capture.get(0).unwrap().as_str().contains("won’t")
        {
            task = format!("Do not {task}");
        }
        if task_needs_review(&task, &sources) {
            continue;
        }
        let owner = if subject == "I" {
            speaker
        } else if subject == "We" {
            None
        } else {
            Some(subject)
        }
        .filter(|name| owner_supported(&task, name, &sources))
        .map(str::to_string);
        // Do not attach a speaker to an ambiguous first-person line.
        let deadline = DUE
            .captures_iter(&task)
            .filter_map(|found| found.get(1).or_else(|| found.get(2)).map(|v| v.as_str()))
            .find(|date| deadline_supported(&task, date, &sources))
            .map(str::to_string);
        if DUE.is_match(&task) && deadline.is_none() {
            continue;
        }
        if !result
            .iter()
            .any(|item: &Commitment| item.task == task && item.owner == owner)
        {
            result.push(Commitment {
                task,
                owner,
                deadline,
            });
        }
    }
    result
}

pub(super) fn has_retraction(text: &str) -> bool {
    static RETRACTION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(?:cancel|cancelled|canceled|retract|scratch that|never mind|no longer)\b",
        )
        .unwrap()
    });
    RETRACTION.is_match(text)
}

#[cfg(test)]
mod tests {
    use super::commitments;

    #[test]
    fn numeric_ordinal_deadline_keeps_its_shipping_condition() {
        let items = commitments("We agreed to ship the beta on the 14th if the memory gate passes, and Priya will review the notes.", None);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].deadline.as_deref(), Some("the 14th"));
        assert!(items[0].task.contains("if the memory gate passes"));
        assert_eq!(items[1].deadline, None);
    }

    #[test]
    fn negative_first_person_and_following_requirements_are_preserved() {
        let items = commitments(
            "I won't migrate data until Ben approves the residency appendix.",
            Some("Dev"),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].owner.as_deref(), Some("Dev"));
        assert!(items[0]
            .task
            .contains("not migrate data until Ben approves"));
        let items = commitments(
            "I'll send the quote by March 6. It must show both billing options.",
            Some("Dev"),
        );
        assert_eq!(items.len(), 1);
        assert!(items[0].task.contains("It must show both billing options."));
    }

    #[test]
    fn keeps_named_commitments_inside_a_conditional_group_decision() {
        let items = commitments("We agreed to ship the beta on the fourteenth if the memory gate passes, and Priya will review the notes.", None);
        assert_eq!(items.len(), 2);
        assert!(items[0].task.contains("if the memory gate passes"));
        assert_eq!(items[0].deadline.as_deref(), Some("the fourteenth"));
        assert_eq!(items[0].owner, None);
        assert_eq!(items[1].task, "review the notes.");
        assert_eq!(items[1].owner.as_deref(), Some("Priya"));
        assert_eq!(items[1].deadline, None);
    }

    #[test]
    fn keeps_speaker_conditions_dates_and_version_numbers() {
        let items = commitments(
            "I'll ship version 2.8 by Friday only if Nina approves the export report.",
            Some("Mara"),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].task,
            "ship version 2.8 by Friday only if Nina approves the export report."
        );
        assert_eq!(items[0].owner.as_deref(), Some("Mara"));
        assert_eq!(items[0].deadline.as_deref(), Some("Friday"));
    }

    #[test]
    fn ignores_possibilities_reports_quotes_and_past_work() {
        for text in [
            "I can send the report.",
            "Mara might send the report.",
            "Mara said Priya will review the report.",
            "If approved, Priya will review the report.",
            "The example says \"I will send the report.\"",
            "I sent the report yesterday.",
            "Can Priya review the report?",
            "I will send the report. Never mind, cancel that.",
        ] {
            assert!(commitments(text, Some("Nina")).is_empty(), "{text}");
        }
    }

    #[test]
    fn respects_a_deadline_correction_in_the_same_passage() {
        let items = commitments("I'll send the room plan by Monday. Correction: I'll send the room plan by Wednesday, not Monday.", Some("Noah"));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].deadline.as_deref(), Some("Wednesday"));
    }
}
