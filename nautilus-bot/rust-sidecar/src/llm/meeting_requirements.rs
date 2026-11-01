//! Select connected requirements under explicit project context. This is a
//! bounded English coverage check, not a general entailment classifier.
use super::grounded::TrustedLine;
use regex::Regex;
use std::sync::LazyLock;

const MAX_SPAN_FOLLOWING_ROWS: usize = 15;
const MAX_SPAN_SECONDS: f64 = 60.0;

static PROJECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:we(?:'re|’re| are)|(?:our|the) team is)\s+(?:developing|designing|building|planning)\b|\b(?:the purpose|(?:project|meeting) (?:purpose|goal)) is to\b"
).unwrap()
});
static REQUIREMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\bwe\s+(?:(?:might|may|could)\s+)?(?:want|need)\s+(?:it|this|the\b)|\b(?:it|this|the\s+[\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,3})\s+(?:must|should|could|might|needs? to)\b|\bwe\s+(?:could|might)\b|\b(?:could|might|should|must)\s+(?:we|it|this)\b|\brequirements?\s+(?:are|include)\b"
).unwrap()
});
static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\bfor (?:the|this|our) (?:[\p{L}-]+\s+){0,4}(?:exercise|icebreaker)\b|\b(?:please|do not)\b[^,.!?]*\b(?:meeting room|in this room)\b|\b(?:moving on|on to the next|first is|next is|let's (?:move|switch)|let’s (?:move|switch))\b"
).unwrap()
});
static REJECTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:rejected|dropped|decided against|no longer (?:want|need)|(?:don't|do not|didn't|did not) (?:want|need))\b"
).unwrap()
});
static NEGATIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:not|never|without|no)\b[^,.!?;]*").unwrap());
static NEGATIVE_CONTINUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:(?:and|but)\s+)?(?:not|never|without|no)\b").unwrap());
static CONDITIONAL_CONTINUATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:only (?:when|if)|if|unless|until|provided that|as long as)\b").unwrap()
});
static RETRACTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:rejected|dropped|decided against|no longer (?:want|need)|ignore|drop|remove)\s+(?:that|this|the)\s+(?:requirement|restriction|constraint|idea|proposal)\b|\b(?:scratch|drop)\s+that\s*(?:[.!?,;]|$)|\b(?:actually[, ]+)?that(?:[’']s| is)\s+optional\b"
).unwrap()
});
static QUALIFIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\?|\b(?:maybe|perhaps|could|might)\b|\bwe\s+may\s+(?:want|need)\b|\b(?:if|unless|until|only when|provided that|as long as)\b"
).unwrap()
});

#[derive(Debug)]
pub(super) struct RequirementSpan {
    pub lines: Vec<TrustedLine>,
    pub constraints: Vec<String>,
    // For tentative or conditional requirements, require the original passage.
    // Quoting it is safe; lexical overlap alone cannot prove a paraphrase kept
    // the qualifier attached to the restriction.
    pub qualified_source: Option<String>,
}

fn continuous(previous: &TrustedLine, next: &TrustedLine, speaker: Option<&str>) -> bool {
    !previous.written_note && !next.written_note
        && previous.recording_id == next.recording_id
        && previous.start_time.is_finite() && previous.end_time.is_finite()
        && next.start_time.is_finite() && next.end_time.is_finite()
        && previous.end_time >= previous.start_time && next.end_time >= next.start_time
        && next.start_time >= previous.start_time
        // Diarization can leave short overlapping filler rows. Keep their
        // original IDs without merging the underlying transcript or speakers.
        && next.start_time - previous.end_time >= -0.5
        && next.start_time - previous.end_time <= 2.0
        && speaker.is_none_or(|name| next.speaker_id.as_deref().is_none_or(|next| name == next))
}

/// Keep the complete spoken passage, including tentative wording and filler.
/// A project anchor alone never makes subsequent negation a requirement.
pub(super) fn connected_requirements(lines: &[TrustedLine]) -> Vec<RequirementSpan> {
    let mut selected = Vec::new();
    let mut project = None;
    let mut speaker = None;
    let mut index = 0;
    while index < lines.len() {
        let line = &lines[index];
        if line.written_note
            || BOUNDARY.is_match(&line.text)
            || index
                .checked_sub(1)
                .is_some_and(|previous| !continuous(&lines[previous], line, speaker))
        {
            project = None;
            speaker = None;
        }
        if !line.written_note && PROJECT.is_match(&line.text) && !REJECTED.is_match(&line.text) {
            project = Some(index);
            speaker = line.speaker_id.as_deref();
        }
        let in_project = project.is_some_and(|start| {
            index - start <= 12 && line.start_time - lines[start].start_time <= 90.0
        });
        if !in_project
            || !REQUIREMENT.is_match(&line.text)
            || BOUNDARY.is_match(&line.text)
            || REJECTED.is_match(&line.text)
        {
            if speaker.is_none() {
                speaker = line.speaker_id.as_deref();
            }
            index += 1;
            continue;
        }
        let start = index;
        let mut text = line.text.clone();
        let mut span_speaker = speaker.or(line.speaker_id.as_deref());
        while index + 1 < lines.len() && index - start < MAX_SPAN_FOLLOWING_ROWS {
            let next = &lines[index + 1];
            if (lines[index].text.trim_end().ends_with(['.', '!', '?', ';'])
                && !NEGATIVE_CONTINUATION.is_match(&next.text)
                && !CONDITIONAL_CONTINUATION.is_match(&next.text))
                || !continuous(&lines[index], next, span_speaker)
                || next.end_time - lines[start].start_time > MAX_SPAN_SECONDS
                || text.len() + 1 + next.text.len() > 800
                || PROJECT.is_match(&next.text)
                || (REQUIREMENT.is_match(&next.text)
                    && !NEGATIVE_CONTINUATION.is_match(&next.text)
                    && !CONDITIONAL_CONTINUATION.is_match(&next.text))
                || BOUNDARY.is_match(&next.text)
                || REJECTED.is_match(&next.text)
                || RETRACTION.is_match(&next.text)
            {
                break;
            }
            text.push(' ');
            text.push_str(&next.text);
            if span_speaker.is_none() {
                span_speaker = next.speaker_id.as_deref();
            }
            index += 1;
        }
        let retracted = lines[index + 1..]
            .iter()
            .take(MAX_SPAN_FOLLOWING_ROWS.saturating_sub(index - start))
            .take_while(|next| {
                !next.written_note
                    && next.recording_id == lines[start].recording_id
                    && next.start_time.is_finite()
                    && next.end_time.is_finite()
                    && next.start_time >= lines[start].start_time
                    && next.end_time >= next.start_time
                    && next.end_time - lines[start].start_time <= MAX_SPAN_SECONDS
                    && !PROJECT.is_match(&next.text)
                    && !BOUNDARY.is_match(&next.text)
                    && !REQUIREMENT.is_match(&next.text)
            })
            .any(|next| RETRACTION.is_match(&next.text));
        let mut constraints = Vec::new();
        let mut remaining = text.as_str();
        while let Some(part) = NEGATIVE.find(remaining) {
            let restriction = part.as_str().trim();
            if restriction.to_lowercase().starts_with("not only ") {
                // Skip the idiom's marker without losing later restrictions.
                remaining = &remaining[part.start() + "not".len()..];
            } else {
                if words(restriction).len() >= 2 {
                    constraints.push(restriction.to_string());
                }
                remaining = &remaining[part.end()..];
            }
        }
        if !retracted && !constraints.is_empty() {
            let qualified_source = QUALIFIED.is_match(&text).then_some(text);
            selected.push(RequirementSpan {
                lines: lines[start..=index].to_vec(),
                constraints,
                qualified_source,
            });
        }
        speaker = span_speaker;
        index += 1;
    }
    selected
}

fn words(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '\'' && ch != '’')
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .filter(|word| !matches!(word.as_str(), "a" | "an" | "the" | "um" | "uh"))
        .collect()
}

fn qualified_words(text: &str) -> Vec<String> {
    text.split_inclusive('?')
        .flat_map(|part| {
            let mut tokens = words(part);
            if part.ends_with('?') {
                tokens.push("?".to_string());
            }
            tokens
        })
        .collect()
}

pub(super) fn missing_requirements(summary: &str, spans: &[RequirementSpan]) -> bool {
    let summary_words = qualified_words(summary);
    let clauses: Vec<_> = summary
        .split(['.', '!', '?', ';', '\n'])
        .map(words)
        .collect();
    spans.iter().any(|span| {
        span.constraints.iter().any(|constraint| {
            let constraint = words(constraint);
            !clauses.iter().any(|clause| {
                clause
                    .windows(constraint.len())
                    .any(|window| window == constraint)
            })
        }) || span.qualified_source.as_ref().is_some_and(|source| {
            // Punctuation is retained as a clause boundary for restrictions, but
            // original quoted passages may contain several source sentences.
            let source = qualified_words(source);
            !summary_words
                .windows(source.len())
                .any(|window| window == source)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[&str]) -> Vec<TrustedLine> {
        text.iter()
            .enumerate()
            .map(|(index, text)| TrustedLine {
                written_note: false,
                speaker_name: Some("Alex".into()),
                speaker_id: Some("s1".into()),
                line_id: format!("L{}", index + 1),
                recording_id: "meeting".into(),
                segment_id: index.to_string(),
                text: text.to_string(),
                start_time: index as f64 * 2.0,
                end_time: index as f64 * 2.0 + 1.0,
            })
            .collect()
    }

    #[test]
    fn connected_requirements_retain_both_frozen_restrictions_and_uncertain_tail() {
        let mut source = lines(&[
            "Now we're developing a remote control which you probably already know, um",
            "we want it to be original, something", "that's",
            "people haven't thought of, that's not out in the shops, um trendy, appealing to a wide market,",
            "but", "you", "know,", "not hunk of metal, and user-friendly, grannies to kids",
            "maybe even put", "able to use", "it,",
            "okay, um first is the functional design, um this is where we all go off and do our individual work",
            "For the icebreaker, draw an animal.", "It should be not a vampire.",
        ]);
        // Measured grouped rows L32-L43 from the frozen public reference.
        // L36 overlaps L35 by 80ms and several filler rows have no speaker.
        let times = [
            (118.64, 122.56),
            (123.12, 125.52),
            (125.76, 125.92),
            (126.56, 132.88),
            (132.80, 132.88),
            (133.92, 134.0),
            (134.0, 134.48),
            (134.64, 138.56),
            (139.92, 140.40),
            (141.04, 141.36),
            (141.44, 143.52),
            (143.52, 149.36),
        ];
        for (index, (start, end)) in times.into_iter().enumerate() {
            source[index].start_time = start;
            source[index].end_time = end;
            source[index].line_id = format!("L{}", index + 32);
            source[index].speaker_name = if [2, 4, 6, 10].contains(&index) {
                None
            } else {
                Some("Speaker 1".into())
            };
        }
        source[12].start_time = 151.0;
        source[12].end_time = 152.0;
        source[13].start_time = 153.0;
        source[13].end_time = 154.0;
        let spans = connected_requirements(&source);
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0].constraints,
            ["not out in the shops", "not hunk of metal"]
        );
        assert_eq!(spans[0].lines.last().unwrap().line_id, "L42");
        assert!(spans[0]
            .lines
            .iter()
            .any(|line| line.text == "maybe even put"));
        assert!(missing_requirements(
            "An original, user-friendly remote.",
            &spans
        ));
        assert!(missing_requirements("Not a hunk of metal.", &spans));
        assert!(missing_requirements(
            "Not out in the shops; not a hunk of metal.",
            &spans
        ));
        assert!(!missing_requirements(
            &spans[0].qualified_source.clone().unwrap(),
            &spans
        ));
    }

    #[test]
    fn connected_requirements_keep_real_restrictions_after_not_only() {
        for (requirement, restriction) in [
            ("It should not only show the time but also not have flashing lights.", "not have flashing lights"),
            ("It should not only be compact but never make a ticking sound.", "never make a ticking sound"),
            ("It should not only be legible but work without a bright backlight.", "without a bright backlight"),
            ("It should not only be compact but not only show the time and have no ticking sound.", "no ticking sound"),
        ] {
            let source = lines(&["We are building a bedside clock.", requirement]);
            let spans = connected_requirements(&source);
            assert_eq!(spans.len(), 1, "Real restriction lost: {requirement}");
            assert_eq!(spans[0].constraints, [restriction]);
            assert!(missing_requirements("The clock should show the time and be compact.", &spans));
            assert!(!missing_requirements(restriction, &spans));
        }
    }

    #[test]
    fn connected_requirements_do_not_promote_not_only_or_incidental_exercises() {
        for source in [
            lines(&[
                "We are building a bedside clock.",
                "It should not only show the time but also be legible.",
            ]),
            lines(&[
                "We are building a bedside clock.",
                "For the drawing exercise, it should not only be a cat but not have stripes.",
            ]),
        ] {
            assert!(connected_requirements(&source).is_empty());
        }
    }

    #[test]
    fn connected_requirements_do_not_depend_on_shops_or_metal() {
        let source = lines(&[
            "We are designing a portable sensor.",
            "It should be compact, not",
            "a wall-mounted unit, and usable outdoors.",
        ]);
        let spans = connected_requirements(&source);
        assert_eq!(spans[0].constraints, ["not a wall-mounted unit"]);
        assert!(missing_requirements("A compact outdoor sensor.", &spans));
        assert!(!missing_requirements(
            "Compact, not a wall-mounted unit.",
            &spans
        ));
    }

    #[test]
    fn connected_requirements_keep_tentative_source_and_skip_rejected_proposal() {
        let source = lines(&[
            "We are building a signup website.",
            "We rejected the proposal: it must not request a phone number.",
            "We might want it to be available without an account, if support approves.",
        ]);
        let spans = connected_requirements(&source);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].lines[0].text, source[2].text);
        assert_eq!(spans[0].constraints, ["without an account"]);
        assert!(missing_requirements(
            "It must be available without an account.",
            &spans
        ));
        assert!(!missing_requirements(&source[2].text, &spans));
    }

    #[test]
    fn connected_requirements_preserve_uncertainty_and_questions() {
        for requirement in [
            "Maybe it should work without a display?",
            "Perhaps it should work without a display.",
            "We could replace the enclosure without a display.",
            "We might migrate the controls without a display.",
            "Should it work without a display?",
            "Could it work without a display?",
            "It should work without a display?",
        ] {
            let source = lines(&["We are building a sensor.", requirement]);
            let spans = connected_requirements(&source);
            assert_eq!(spans.len(), 1, "{requirement}");
            assert!(
                missing_requirements("It must work without a display.", &spans),
                "{requirement}"
            );
            assert!(!missing_requirements(requirement, &spans), "{requirement}");
        }
    }

    #[test]
    fn retraction_only_drops_the_nearest_requirement() {
        for end in [".", ","] {
            let portable = format!("It should be portable, not a desktop unit{end}");
            let source = lines(&[
                "We are building a recorder.",
                &portable,
                "It should work without a touchscreen.",
                "Drop that requirement.",
            ]);
            let spans = connected_requirements(&source);
            assert_eq!(spans.len(), 1);
            assert_eq!(spans[0].constraints, ["not a desktop unit"]);
            assert!(missing_requirements("We are building a recorder.", &spans));
            assert!(!missing_requirements(
                "Portable, not a desktop unit.",
                &spans
            ));
        }
    }

    #[test]
    fn question_only_qualification_stays_attached_to_its_content() {
        let source = lines(&[
            "We are building a sensor.",
            "It should work without a display?",
        ]);
        let spans = connected_requirements(&source);
        assert_eq!(spans.len(), 1);
        assert!(missing_requirements(
            "It should work without a display.",
            &spans
        ));
        assert!(missing_requirements(
            "Is it ready? It should work without a display.",
            &spans
        ));
        assert!(!missing_requirements(
            "It should work without a display?",
            &spans
        ));
    }

    #[test]
    fn connected_requirements_reconcile_a_following_retraction() {
        for end in [",", "."] {
            for retraction in [
                "We rejected that requirement.",
                "Drop that requirement.",
                "Ignore that restriction.",
            ] {
                let requirement = format!("It should be portable, not a desktop unit{end}");
                let source = lines(&[
                    "We are building a recorder.",
                    &requirement,
                    retraction,
                    "It must not use permanent storage.",
                ]);
                let spans = connected_requirements(&source);
                assert_eq!(spans.len(), 1);
                assert_eq!(spans[0].constraints, ["not use permanent storage"]);
            }
        }
    }

    #[test]
    fn connected_requirements_reconcile_delayed_retractions_and_replies() {
        for retraction in [
            "Drop that requirement.",
            "Actually, that's optional.",
            "Scratch that.",
            "Drop that.",
        ] {
            for reply in [false, true] {
                let mut source = lines(&[
                    "We are building a recorder.",
                    "It should be portable, not a desktop unit.",
                    "Let me check the brief.",
                    retraction,
                ]);
                if reply {
                    source[3].speaker_id = Some("s2".into());
                }
                let spans = connected_requirements(&source);
                assert!(spans.is_empty(), "{retraction}, reply={reply}");
                assert!(!missing_requirements("We are building a recorder.", &spans));
            }
        }
    }

    #[test]
    fn connected_requirements_bound_retraction_lookup() {
        for boundary in 0..5 {
            let mut source = lines(&[
                "We are building a recorder.",
                "It should be portable, not a desktop unit.",
                "Let me check the brief.",
                "Drop that.",
            ]);
            match boundary {
                0 => {
                    source[3].start_time = source[1].start_time + MAX_SPAN_SECONDS;
                    source[3].end_time = source[3].start_time + 1.0;
                }
                1 => {
                    let filler = source[2].clone();
                    for _ in 0..MAX_SPAN_FOLLOWING_ROWS {
                        source.insert(3, filler.clone());
                    }
                }
                2 => source[3].recording_id = "other".into(),
                3 => source[2].text = "Moving on to the next topic.".into(),
                _ => source[3].text = "Drop that slide.".into(),
            }
            let spans = connected_requirements(&source);
            assert_eq!(spans.len(), 1, "boundary={boundary}");
            assert!(missing_requirements("We are building a recorder.", &spans));
        }
    }

    #[test]
    fn connected_requirements_keep_conditions_after_punctuated_restrictions() {
        let source = lines(&[
            "We are building a recorder.",
            "It should be portable, not a desktop unit.",
            "Only when customers agree.",
        ]);
        let spans = connected_requirements(&source);
        assert_eq!(spans[0].lines.len(), 2);
        assert!(missing_requirements(
            "It should be portable, not a desktop unit.",
            &spans
        ));
        assert!(!missing_requirements(
            "It should be portable, not a desktop unit. Only when customers agree.",
            &spans
        ));
    }

    #[test]
    fn connected_requirements_join_a_punctuated_negative_continuation() {
        let source = lines(&[
            "We are building a sensor.",
            "We want it compact.",
            "Not a wall-mounted unit.",
        ]);
        let spans = connected_requirements(&source);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].constraints, ["Not a wall-mounted unit"]);
    }

    #[test]
    fn connected_requirements_reject_lost_modality_or_conditions() {
        let source = lines(&[
            "We are building a recorder.",
            "We might want it portable, not a desktop unit, if customers agree.",
        ]);
        let spans = connected_requirements(&source);
        assert!(missing_requirements(
            "It must be portable, not a desktop unit.",
            &spans
        ));
        assert!(missing_requirements(
            "We might want it portable, not a desktop unit.",
            &spans
        ));
        assert!(!missing_requirements(&source[1].text, &spans));
    }

    #[test]
    fn connected_requirements_exclude_incidental_negation_and_require_a_requirement_cue() {
        for source in [
            lines(&["We are designing a recorder.", "That's not a vampire."]),
            lines(&[
                "We are designing a recorder.",
                "For the drawing exercise, it should not be a cat.",
                "It should not be a vampire.",
            ]),
            lines(&[
                "We are designing a recorder.",
                "For the warm-up exercise, it should not be a vampire.",
            ]),
            lines(&[
                "We are designing a recorder.",
                "Please do not dim the lights in this room.",
                "It should not be a dark room.",
            ]),
            lines(&[
                "We rejected the idea: we are building a recorder.",
                "It must not upload recordings.",
            ]),
        ] {
            assert!(connected_requirements(&source).is_empty());
        }
    }

    #[test]
    fn connected_requirements_keep_central_workshop_requirements() {
        let source = lines(&[
            "The purpose is to plan a drawing workshop.",
            "The workshop must use washable pens, not permanent markers.",
        ]);
        assert_eq!(
            connected_requirements(&source)[0].constraints,
            ["not permanent markers"]
        );
    }

    #[test]
    fn connected_requirements_use_ids_independently_of_aliases() {
        for alias in [None, Some("Alex".to_string())] {
            for same_speaker in [false, true] {
                let mut source = lines(&[
                    "We are designing a recorder.",
                    "We want it compact,",
                    "not a desktop unit.",
                ]);
                for line in &mut source {
                    line.speaker_name = alias.clone();
                }
                source[2].speaker_id = Some(if same_speaker { "s1" } else { "s2" }.into());
                let spans = connected_requirements(&source);
                assert_eq!(spans.len(), usize::from(same_speaker));
                if same_speaker {
                    assert_eq!(spans[0].constraints, ["not a desktop unit"]);
                }
            }
        }
    }

    #[test]
    fn connected_requirements_do_not_cross_source_or_speaker_or_time_boundaries() {
        for change in 0..4 {
            let mut source = lines(&[
                "We are designing a recorder.",
                "We want it compact,",
                "not a desktop unit.",
            ]);
            match change {
                0 => source[2].recording_id = "other".into(),
                1 => source[2].speaker_id = Some("s2".into()),
                2 => source[2].written_note = true,
                _ => {
                    source[2].start_time = 90.0;
                    source[2].end_time = 91.0;
                }
            }
            assert!(connected_requirements(&source).is_empty());
        }
    }
}
