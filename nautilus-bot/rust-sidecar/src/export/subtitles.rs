//! SRT and WebVTT subtitles from transcript segments.
//!
//! Cues are built once and rendered twice: the two formats differ only in the
//! timestamp separator (`,` vs `.`), the `WEBVTT` header, and VTT's need to
//! escape markup. Building is pure so wrapping, merging, and numbering can be
//! tested without a recording.

use std::collections::HashMap;

use crate::models::TranscriptSegment;

/// Broadcast-style line budget: at most this many characters per line.
pub const MAX_LINE_CHARS: usize = 42;
/// And at most this many lines per cue; longer text becomes more cues.
pub const MAX_LINES_PER_CUE: usize = 2;
/// A segment shorter than this is merged into a neighbour: a 200 ms cue
/// flashes past before it can be read.
pub const MIN_CUE_SECONDS: f64 = 0.5;

#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleCue {
    pub start: f64,
    pub end: f64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleFormat {
    Srt,
    Vtt,
}

/// Display name for a speaker id, matching what the transcript viewer shows:
/// the alias when one was set, `Me`/`Them` for the two capture sides, and the
/// raw id otherwise. Nothing is invented for an unknown id.
pub fn speaker_label(speaker_id: &str, speaker_names: &HashMap<String, String>) -> Option<String> {
    let id = speaker_id.trim();
    if id.is_empty() {
        return None;
    }
    if let Some(name) = speaker_names
        .get(id)
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
    {
        return Some(name.to_string());
    }
    Some(match id.to_ascii_lowercase().as_str() {
        "me" => "Me".to_string(),
        "them" => "Them".to_string(),
        _ => id.to_string(),
    })
}

struct Unit {
    start: f64,
    end: f64,
    speaker: Option<String>,
    text: String,
}

/// Build cues from segments already redacted by the caller.
///
/// `include_speakers` prefixes each cue's first line with `Speaker: `; the
/// continuation cues of a split segment carry no prefix, the usual convention.
pub fn build_cues(
    segments: &[TranscriptSegment],
    include_speakers: bool,
    speaker_names: &HashMap<String, String>,
) -> Vec<SubtitleCue> {
    let mut units: Vec<Unit> = segments
        .iter()
        .filter_map(|segment| {
            let text = normalize_whitespace(&segment.text);
            if text.is_empty() || !segment.start_time.is_finite() || !segment.end_time.is_finite() {
                return None;
            }
            let start = segment.start_time.max(0.0);
            let end = segment.end_time.max(start);
            let speaker = if include_speakers {
                segment
                    .speaker_id
                    .as_deref()
                    .and_then(|id| speaker_label(id, speaker_names))
            } else {
                None
            };
            Some(Unit {
                start,
                end,
                speaker,
                text,
            })
        })
        .collect();
    units.sort_by(|a, b| a.start.total_cmp(&b.start));

    let merged = merge_short_units(units);

    let mut cues = Vec::new();
    for unit in merged {
        let prefixed = match &unit.speaker {
            Some(speaker) => format!("{}: {}", speaker, unit.text),
            None => unit.text.clone(),
        };
        let lines = wrap_lines(&prefixed, MAX_LINE_CHARS);
        let chunks: Vec<&[String]> = lines.chunks(MAX_LINES_PER_CUE).collect();
        if chunks.len() <= 1 {
            cues.push(SubtitleCue {
                start: unit.start,
                end: unit.end,
                lines,
            });
            continue;
        }
        // Several cues for one segment: time is shared out by how much text
        // each cue carries, so a long clause stays on screen longer.
        let total_chars: usize = chunks
            .iter()
            .map(|chunk| chunk.iter().map(|line| line.chars().count()).sum::<usize>())
            .sum::<usize>()
            .max(1);
        let span = unit.end - unit.start;
        let mut cursor = unit.start;
        for (index, chunk) in chunks.iter().enumerate() {
            let chars: usize = chunk.iter().map(|line| line.chars().count()).sum();
            let end = if index == chunks.len() - 1 {
                unit.end
            } else {
                cursor + span * (chars as f64 / total_chars as f64)
            };
            cues.push(SubtitleCue {
                start: cursor,
                end,
                lines: chunk.to_vec(),
            });
            cursor = end;
        }
    }
    cues
}

/// Fold a sub-half-second unit into the neighbour that shares its speaker
/// (next first, then previous); with no such neighbour it is held on screen
/// for the minimum instead, never dropped.
fn merge_short_units(units: Vec<Unit>) -> Vec<Unit> {
    let mut out: Vec<Unit> = Vec::with_capacity(units.len());
    let mut iter = units.into_iter().peekable();
    while let Some(mut unit) = iter.next() {
        let is_short = unit.end - unit.start < MIN_CUE_SECONDS;
        if is_short {
            let next_matches = iter.peek().is_some_and(|next| next.speaker == unit.speaker);
            if next_matches {
                let next = iter.next().expect("peeked");
                unit = Unit {
                    start: unit.start,
                    end: next.end.max(unit.end),
                    speaker: unit.speaker,
                    text: format!("{} {}", unit.text, next.text),
                };
                out.push(unit);
                continue;
            }
            if let Some(previous) = out.last_mut().filter(|prev| prev.speaker == unit.speaker) {
                previous.end = previous.end.max(unit.end);
                previous.text = format!("{} {}", previous.text, unit.text);
                continue;
            }
            unit.end = unit.start + MIN_CUE_SECONDS;
        }
        out.push(unit);
    }
    out
}

fn normalize_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Greedy word wrap. A single word longer than the budget keeps its own line
/// rather than being cut mid-word.
pub fn wrap_lines(text: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_len = 0usize;
    for word in text.split_whitespace() {
        let word_len = word.chars().count();
        if current.is_empty() {
            current.push_str(word);
            current_len = word_len;
        } else if current_len + 1 + word_len <= max_chars {
            current.push(' ');
            current.push_str(word);
            current_len += 1 + word_len;
        } else {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
            current_len = word_len;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
pub fn format_timestamp(seconds: f64, format: SubtitleFormat) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let millis = total_ms % 1000;
    let separator = match format {
        SubtitleFormat::Srt => ',',
        SubtitleFormat::Vtt => '.',
    };
    format!("{hours:02}:{minutes:02}:{secs:02}{separator}{millis:03}")
}

pub fn render(cues: &[SubtitleCue], format: SubtitleFormat) -> String {
    let mut output = String::new();
    if format == SubtitleFormat::Vtt {
        output.push_str("WEBVTT\n\n");
    }
    for (index, cue) in cues.iter().enumerate() {
        output.push_str(&(index + 1).to_string());
        output.push('\n');
        output.push_str(&format_timestamp(cue.start, format));
        output.push_str(" --> ");
        output.push_str(&format_timestamp(cue.end, format));
        output.push('\n');
        for line in &cue.lines {
            let line = match format {
                SubtitleFormat::Srt => line.clone(),
                SubtitleFormat::Vtt => escape_vtt(line),
            };
            output.push_str(&line);
            output.push('\n');
        }
        output.push('\n');
    }
    output
}

/// VTT cue text is markup: `&`, `<`, `>` are escaped, and the arrow that
/// separates timings must not appear inside a payload line.
fn escape_vtt(line: &str) -> String {
    let mut escaped = String::with_capacity(line.len());
    for character in line.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped.replace("--&gt;", "-- &gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(
        id: &str,
        start: f64,
        end: f64,
        speaker: Option<&str>,
        text: &str,
    ) -> TranscriptSegment {
        TranscriptSegment {
            id: id.to_string(),
            start_time: start,
            end_time: end,
            text: text.to_string(),
            speaker_id: speaker.map(str::to_string),
            confidence: 0.9,
        }
    }

    #[test]
    fn timestamps_use_the_format_separator_and_roll_into_hours() {
        assert_eq!(format_timestamp(0.0, SubtitleFormat::Srt), "00:00:00,000");
        assert_eq!(format_timestamp(65.5, SubtitleFormat::Srt), "00:01:05,500");
        assert_eq!(format_timestamp(65.5, SubtitleFormat::Vtt), "00:01:05.500");
        assert_eq!(
            format_timestamp(3725.004, SubtitleFormat::Vtt),
            "01:02:05.004"
        );
        assert_eq!(format_timestamp(-3.0, SubtitleFormat::Srt), "00:00:00,000");
    }

    #[test]
    fn srt_numbers_cues_and_prefixes_speakers() {
        let mut names = HashMap::new();
        names.insert("them".to_string(), "Priya".to_string());
        let cues = build_cues(
            &[
                segment("a", 0.0, 2.0, Some("me"), "Let's start."),
                segment("b", 2.0, 4.5, Some("them"), "Sounds good."),
                segment("c", 5.0, 6.0, None, "Unattributed line."),
            ],
            true,
            &names,
        );
        let srt = render(&cues, SubtitleFormat::Srt);
        assert_eq!(
            srt,
            "1\n00:00:00,000 --> 00:00:02,000\nMe: Let's start.\n\n\
             2\n00:00:02,000 --> 00:00:04,500\nPriya: Sounds good.\n\n\
             3\n00:00:05,000 --> 00:00:06,000\nUnattributed line.\n\n"
        );
    }

    #[test]
    fn speaker_prefix_is_optional() {
        let cues = build_cues(
            &[segment("a", 0.0, 2.0, Some("me"), "Let's start.")],
            false,
            &HashMap::new(),
        );
        assert_eq!(cues[0].lines, vec!["Let's start.".to_string()]);
    }

    #[test]
    fn vtt_has_the_header_and_escapes_markup() {
        let cues = build_cues(
            &[segment(
                "a",
                1.0,
                2.0,
                None,
                "Fish & chips <b>now</b> --> later",
            )],
            false,
            &HashMap::new(),
        );
        let vtt = render(&cues, SubtitleFormat::Vtt);
        assert!(vtt.starts_with("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n"));
        assert!(vtt.contains("Fish &amp; chips &lt;b&gt;now&lt;/b&gt; -- &gt; later"));
        assert_eq!(render(&[], SubtitleFormat::Vtt), "WEBVTT\n\n");
        assert_eq!(render(&[], SubtitleFormat::Srt), "");
    }

    #[test]
    fn long_text_wraps_at_42_and_splits_into_two_line_cues_by_text_share() {
        let text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two";
        let cues = build_cues(
            &[segment("a", 10.0, 20.0, None, text)],
            false,
            &HashMap::new(),
        );
        assert!(cues.len() >= 2, "long text becomes several cues: {cues:?}");
        for cue in &cues {
            assert!(cue.lines.len() <= MAX_LINES_PER_CUE);
            for line in &cue.lines {
                assert!(line.chars().count() <= MAX_LINE_CHARS, "{line}");
            }
        }
        assert_eq!(cues.first().unwrap().start, 10.0);
        assert_eq!(cues.last().unwrap().end, 20.0);
        for pair in cues.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "cues are contiguous");
            assert!(pair[0].end > pair[0].start);
        }
        // Every word survives, in order.
        let rejoined = cues
            .iter()
            .flat_map(|cue| cue.lines.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn a_word_longer_than_the_budget_keeps_its_own_line() {
        let lines = wrap_lines(
            "short averyveryveryveryveryveryveryveryveryverylongword next",
            10,
        );
        assert_eq!(
            lines,
            vec![
                "short".to_string(),
                "averyveryveryveryveryveryveryveryveryverylongword".to_string(),
                "next".to_string()
            ]
        );
    }

    #[test]
    fn sub_half_second_segments_merge_into_a_same_speaker_neighbour() {
        let cues = build_cues(
            &[
                segment("a", 0.0, 0.2, Some("me"), "Um"),
                segment("b", 0.2, 3.0, Some("me"), "so the plan is set."),
                segment("c", 3.0, 3.1, Some("them"), "Yes."),
                segment("d", 3.1, 5.0, Some("me"), "Good."),
            ],
            true,
            &HashMap::new(),
        );
        assert_eq!(cues.len(), 3, "{cues:?}");
        assert_eq!(
            cues[0].lines,
            vec!["Me: Um so the plan is set.".to_string()]
        );
        assert_eq!((cues[0].start, cues[0].end), (0.0, 3.0));
        // No same-speaker neighbour: held for the minimum instead of dropped.
        assert_eq!(cues[1].lines, vec!["Them: Yes.".to_string()]);
        assert!((cues[1].end - cues[1].start - MIN_CUE_SECONDS).abs() < 1e-9);
        assert_eq!(cues[2].lines, vec!["Me: Good.".to_string()]);
    }

    #[test]
    fn a_trailing_short_segment_folds_into_the_previous_turn() {
        let cues = build_cues(
            &[
                segment("a", 0.0, 2.0, Some("me"), "First."),
                segment("b", 2.0, 2.3, Some("me"), "Second."),
            ],
            true,
            &HashMap::new(),
        );
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].lines, vec!["Me: First. Second.".to_string()]);
        assert_eq!(cues[0].end, 2.3);
    }

    #[test]
    fn empty_and_malformed_segments_are_skipped_and_order_is_by_start() {
        let cues = build_cues(
            &[
                segment("late", 5.0, 6.0, None, "Later."),
                segment("blank", 1.0, 2.0, None, "   "),
                segment("nan", f64::NAN, 2.0, None, "Broken."),
                segment("early", 0.0, 1.0, None, "Earlier."),
            ],
            false,
            &HashMap::new(),
        );
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].lines, vec!["Earlier.".to_string()]);
        assert_eq!(cues[1].lines, vec!["Later.".to_string()]);
    }
}
