//! Which speaker a single timed word belongs to.
//!
//! Diarizers report turns that can overlap: the embedding backend's turns are
//! unions of two-second windows on a one-second hop, so neighbouring speakers'
//! turns share about a second at every change, and Nemotron marks real
//! overlapped speech. Turns can also leave gaps a word falls into. Before this
//! rule a word whose midpoint sat in an overlap or a gap had no speaker, which
//! on AMI meetings was 6-20% of all words.
//!
//! The rule, measured on 16 AMI test meetings (11 of them held out from the
//! meetings it was designed on):
//!
//! - A midpoint inside turns of several speakers goes to the turn it is deepest
//!   inside: the largest distance to that turn's nearer edge, then the longer
//!   turn. Two partly overlapping turns therefore split their overlap at its
//!   middle, and a short turn nested in a long one loses to the long one. An
//!   exact tie between two speakers leaves the word anonymous.
//! - A measured word whose midpoint no turn covers takes the speaker of the
//!   turns that overlap the word, if exactly one speaker's turns do. If none
//!   do, Nemotron's activity evidence may still name one; if two speakers'
//!   turns touch the word it stays anonymous.
//!
//! Only the speaker id is decided here. The word's text, interval and row
//! identity are never touched.

use super::{SpeakerActivity, SpeakerSegment};

/// How far inside `turn` the instant `at` lies, in seconds.
fn depth(turn: &SpeakerSegment, at: f64) -> f64 {
    (at - turn.start_time).min(turn.end_time - at)
}

/// The speaker that owns the instant `at`, or `None` when no turn covers it or
/// two speakers' turns tie exactly.
pub(super) fn owner_at(turns: &[SpeakerSegment], at: f64) -> Option<&str> {
    let mut covering = turns
        .iter()
        .filter(|turn| turn.start_time <= at && at < turn.end_time);
    let mut best = covering.next()?;
    // Whether a different speaker's turn matches `best` exactly; cleared when
    // a strictly better turn takes over.
    let mut tied = false;
    for turn in covering {
        let order = depth(turn, at).total_cmp(&depth(best, at)).then_with(|| {
            (turn.end_time - turn.start_time).total_cmp(&(best.end_time - best.start_time))
        });
        match order {
            std::cmp::Ordering::Greater => {
                best = turn;
                tied = false;
            }
            std::cmp::Ordering::Equal if turn.speaker_id != best.speaker_id => tied = true,
            _ => {}
        }
    }
    (!tied).then_some(best.speaker_id.as_str())
}

/// The speaker of a measured word whose midpoint no turn covers: the one
/// speaker whose turns overlap the word, else what the activity evidence
/// names when no turn touches the word at all.
pub(super) fn uncovered_word_speaker<'a>(
    turns: &'a [SpeakerSegment],
    activity: Option<&'a SpeakerActivity>,
    start: f64,
    end: f64,
) -> Option<&'a str> {
    let mut touching = turns
        .iter()
        .filter(|turn| turn.start_time < end && turn.end_time > start)
        .map(|turn| turn.speaker_id.as_str());
    match touching.next() {
        Some(first) => touching.all(|id| id == first).then_some(first),
        None => activity.and_then(|evidence| evidence.recover(start, end)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start_time: f64, end_time: f64, id: &str) -> SpeakerSegment {
        SpeakerSegment {
            start_time,
            end_time,
            speaker_id: id.into(),
            confidence: 0.9,
        }
    }

    #[test]
    fn partly_overlapping_turns_split_the_overlap_at_its_middle() {
        let turns = [turn(0.0, 11.0, "S1"), turn(10.0, 16.0, "S2")];
        assert_eq!(owner_at(&turns, 10.2), Some("S1"));
        assert_eq!(owner_at(&turns, 10.4), Some("S1"));
        assert_eq!(owner_at(&turns, 10.6), Some("S2"));
        assert_eq!(owner_at(&turns, 10.9), Some("S2"));
        // Outside the overlap each turn owns its own time.
        assert_eq!(owner_at(&turns, 5.0), Some("S1"));
        assert_eq!(owner_at(&turns, 13.0), Some("S2"));
    }

    #[test]
    fn a_short_turn_nested_in_a_long_one_loses_to_the_long_one() {
        let turns = [turn(0.0, 20.0, "S1"), turn(9.0, 10.0, "S2")];
        assert_eq!(owner_at(&turns, 9.5), Some("S1"));
    }

    #[test]
    fn equal_depth_goes_to_the_longer_turn_and_an_exact_tie_to_nobody() {
        // At 4.0 both turns are 1 s deep; S2's turn is longer.
        let turns = [turn(3.0, 5.0, "S1"), turn(3.0, 9.0, "S2")];
        assert_eq!(owner_at(&turns, 4.0), Some("S2"));
        // Mirror-image turns: same depth, same length at the overlap's middle.
        let turns = [turn(0.0, 4.0, "S1"), turn(2.0, 6.0, "S2")];
        assert_eq!(owner_at(&turns, 3.0), None);
        assert_eq!(owner_at(&turns, 2.9), Some("S1"));
        assert_eq!(owner_at(&turns, 3.1), Some("S2"));
        // Identical turns of two speakers.
        let turns = [turn(0.0, 1.0, "S2"), turn(0.0, 1.0, "S3")];
        assert_eq!(owner_at(&turns, 0.4), None);
        // A deeper third speaker settles a tie between the other two.
        let turns = [
            turn(0.0, 4.0, "S1"),
            turn(2.0, 6.0, "S2"),
            turn(1.0, 5.0, "S3"),
        ];
        assert_eq!(owner_at(&turns, 3.0), Some("S3"));
    }

    #[test]
    fn one_speakers_overlapping_turns_are_not_a_contest() {
        let turns = [turn(0.0, 4.0, "S1"), turn(2.0, 6.0, "S1")];
        assert_eq!(owner_at(&turns, 3.0), Some("S1"));
        // A deep turn of the first speaker is not hidden behind its shallow one.
        let turns = [
            turn(2.5, 3.5, "S1"),
            turn(1.0, 5.0, "S2"),
            turn(0.0, 6.0, "S1"),
        ];
        assert_eq!(owner_at(&turns, 3.0), Some("S1"));
        assert_eq!(owner_at(&turns, 6.0), None);
        assert_eq!(owner_at(&[], 1.0), None);
    }

    #[test]
    fn an_uncovered_word_takes_the_one_speaker_whose_turns_touch_it() {
        let turns = [turn(0.0, 1.0, "S1"), turn(1.5, 3.0, "S2")];
        // Touches only S1's turn.
        assert_eq!(uncovered_word_speaker(&turns, None, 0.9, 1.4), Some("S1"));
        // Touches both speakers: stays anonymous.
        assert_eq!(uncovered_word_speaker(&turns, None, 0.9, 1.6), None);
        // Touches nothing and there is no activity evidence.
        assert_eq!(uncovered_word_speaker(&turns, None, 1.1, 1.4), None);
        // Two turns of the same speaker around the word.
        let same = [turn(0.0, 1.0, "S1"), turn(1.5, 3.0, "S1")];
        assert_eq!(uncovered_word_speaker(&same, None, 0.9, 1.6), Some("S1"));
    }

    #[test]
    fn activity_evidence_only_speaks_when_no_turn_touches_the_word() {
        let mut frame = [0.0_f32; 8];
        frame[2] = 0.9;
        let activity = SpeakerActivity::new(
            vec![frame; 300],
            std::array::from_fn(|i| Some(format!("S{}", i + 1))),
            3.0,
        );
        let turns = [turn(0.0, 1.0, "S1"), turn(2.0, 3.0, "S2")];
        assert_eq!(
            uncovered_word_speaker(&turns, Some(&activity), 1.2, 1.6),
            Some("S3")
        );
        // A turn touching the word outranks the activity evidence.
        assert_eq!(
            uncovered_word_speaker(&turns, Some(&activity), 0.9, 1.4),
            Some("S1")
        );
        assert_eq!(
            uncovered_word_speaker(&turns, Some(&activity), 0.9, 2.1),
            None
        );
    }
}
