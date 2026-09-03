//! EXPERIMENTAL speakrs diarization backend (pyannote community-1).
//!
//! Compiled only with the `diarization-speakrs` Cargo feature, which is off by
//! default and is not in the shipped feature list
//! (`scripts/sidecar-cargo-features.mjs`). The default embedding + AHC pipeline
//! in [`super`] stays the product default; this module exists so the swap can
//! be measured on real audio rather than argued about.
//!
//! What it does differently: instead of slicing the recording into fixed 2 s
//! windows, embedding each one and clustering the embeddings, speakrs runs the
//! full pyannote `community-1` pipeline — a powerset segmentation model that
//! decodes speaker activity per frame (including overlap), overlap-add
//! aggregation, binarization, WeSpeaker ResNet34 embeddings over the decoded
//! regions, then PLDA + VBx clustering.
//!
//! Output contract, matching [`super::run_diarization_with_model`]: speaker turns with
//! `start_time`/`end_time` and stable `S1..Sn` ids assigned by first
//! appearance. Spans no turn covers are left **uncovered**, which is how the
//! rest of the app already represents "unattributed" — `merge_with_transcript`
//! maps an uncovered span to `speaker_id: None`. Emitting a turn for a gap, or
//! widening a neighbouring turn across it, would attribute silence or unscored
//! audio to a speaker; `S1` in particular is what a naive backend defaults to,
//! and [`normalize_turns`] never does.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use super::{DiarizationMethod, DiarizationResult, Speaker, SpeakerSegment};

/// speakrs reports confidence nowhere: the pipeline's output is a hard
/// cluster assignment per frame, not a posterior. Reporting a made-up number
/// per segment would be a capability claim the code cannot back, so every
/// segment carries the same neutral marker and the UI has nothing to rank by.
const SPEAKRS_SEGMENT_CONFIDENCE: f64 = 0.0;

/// Two turns of the same speaker separated by less than this are one turn.
/// speakrs emits frame-resolution turns (~16 ms at the default 1 s
/// segmentation step), so a speaker who pauses for breath comes back as two
/// turns a few tens of milliseconds apart. Merging under a third of a second
/// keeps genuine back-and-forth intact — the shortest real turn exchange in a
/// meeting is on the order of a second — while collapsing breath gaps.
const TURN_MERGE_GAP_SECONDS: f64 = 0.3;

/// Turns shorter than this are dropped rather than emitted. Below ~200 ms a
/// "turn" is a segmentation flicker, and attributing a word to it would move
/// text to the wrong speaker in `merge_with_transcript`, which assigns by
/// maximum overlap.
const MIN_TURN_SECONDS: f64 = 0.2;

/// A speaker turn exactly as speakrs reports it, before this module imposes
/// Plainsong's id scheme and merging rules. Separate from
/// [`SpeakerSegment`] so [`normalize_turns`] is a pure function that can be
/// tested without ONNX Runtime, a model bundle, or audio.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawTurn {
    pub(crate) start: f64,
    pub(crate) end: f64,
    /// speakrs's own label, e.g. `SPEAKER_00`. Opaque here: only its identity
    /// across turns matters, never its numbering.
    pub(crate) speaker: String,
}

/// Directory the pinned speakrs model bundle is downloaded to.
fn bundle_dir() -> PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("diarization")
        .join(crate::download::SPEAKRS_BUNDLE_DIR)
}

/// True when every file of the bundle is present *and* carries a Plainsong
/// integrity receipt matching its pinned hash. Bundle-wide, because speakrs
/// builds all three models up front: a bundle missing one PLDA array fails at
/// pipeline construction, after the UI has already promised diarization.
pub(crate) fn is_available() -> bool {
    crate::download::is_speakrs_bundle_trusted(&bundle_dir())
}

/// Turn speakrs's raw turns into Plainsong speaker segments.
///
/// Pure so the rules below are testable without hardware:
/// - non-finite, empty, and inverted turns are dropped;
/// - turns are clamped into `[0, duration]`;
/// - adjacent turns of the same speaker within [`TURN_MERGE_GAP_SECONDS`]
///   merge;
/// - turns shorter than [`MIN_TURN_SECONDS`] are dropped *after* merging, so
///   a speaker who is split across two sub-threshold turns is not lost;
/// - ids are `S1..Sn` assigned by **first appearance in time among the turns
///   that survived**, so the same audio always produces the same ids
///   regardless of how speakrs numbered its clusters, and a discarded flicker
///   at the head of a recording does not push the only real speaker to `S2`;
/// - gaps are left alone. Nothing is stretched to cover them and no
///   placeholder turn is invented, so uncovered audio stays unattributed.
pub(crate) fn normalize_turns(turns: &[RawTurn], duration: f64) -> Vec<SpeakerSegment> {
    if !duration.is_finite() || duration <= 0.0 {
        return Vec::new();
    }

    let mut clamped: Vec<RawTurn> = turns
        .iter()
        .filter_map(|turn| {
            if !turn.start.is_finite() || !turn.end.is_finite() {
                return None;
            }
            let start = turn.start.max(0.0).min(duration);
            let end = turn.end.max(0.0).min(duration);
            if end <= start {
                return None;
            }
            Some(RawTurn {
                start,
                end,
                speaker: turn.speaker.clone(),
            })
        })
        .collect();

    clamped.sort_by(|left, right| {
        left.start
            .total_cmp(&right.start)
            .then_with(|| left.end.total_cmp(&right.end))
            .then_with(|| left.speaker.cmp(&right.speaker))
    });

    // Merge on speakrs's own label, against the most recent turn of that
    // speaker wherever it sits -- not only the last turn emitted. pyannote's
    // powerset decoding reports overlapping speech, so A-B-A with A's two turns
    // overlapping is ordinary output; considering only the last turn left two
    // overlapping A segments, and `merge_with_transcript` assigns text by
    // maximum overlap, so a word could land in either of two spans that claim
    // the same speaker at the same time.
    //
    // What is merged across an interleaved speaker is narrower than what is
    // merged against the immediately preceding turn: a breath gap closes only
    // when nothing was emitted in between, because bridging one across another
    // speaker would swallow their turn. Turns that overlap or exactly touch are
    // merged wherever they sit -- the span that closes was already inside the
    // earlier turn, so nothing new is claimed.
    let mut merged: Vec<RawTurn> = Vec::new();
    for turn in clamped {
        if let Some(index) = merged
            .iter()
            .rposition(|existing| existing.speaker == turn.speaker)
        {
            // `clamped` is sorted by start, so `turn` never begins earlier.
            let gap = turn.start - merged[index].end;
            let is_previous_turn = index + 1 == merged.len();
            let limit = if is_previous_turn {
                TURN_MERGE_GAP_SECONDS
            } else {
                0.0
            };
            if gap <= limit {
                merged[index].end = merged[index].end.max(turn.end);
                continue;
            }
        }
        merged.push(turn);
    }
    merged.retain(|turn| turn.end - turn.start >= MIN_TURN_SECONDS);

    // Stable ids by first appearance among the survivors. `Vec` rather than a
    // map because a recording has a handful of speakers and insertion order
    // *is* the answer.
    let mut order: Vec<String> = Vec::new();
    merged
        .into_iter()
        .map(|turn| {
            let index = match order.iter().position(|label| label == &turn.speaker) {
                Some(index) => index,
                None => {
                    order.push(turn.speaker.clone());
                    order.len() - 1
                }
            };
            SpeakerSegment {
                start_time: turn.start,
                end_time: turn.end,
                speaker_id: format!("S{}", index + 1),
                confidence: SPEAKRS_SEGMENT_CONFIDENCE,
            }
        })
        .collect()
}

/// Spans of `[0, duration]` that no segment covers — the audio the pipeline
/// scored as nobody speaking, or scored too briefly to keep.
///
/// Returned rather than filled: the caller logs the total so an operator can
/// see how much of a recording went unattributed, and the transcript merge
/// leaves those spans `speaker_id: None`. `min_span` suppresses
/// floating-point slivers between abutting turns.
pub(crate) fn uncovered_spans(
    segments: &[SpeakerSegment],
    duration: f64,
    min_span: f64,
) -> Vec<(f64, f64)> {
    if !duration.is_finite() || duration <= 0.0 {
        return Vec::new();
    }

    let mut sorted: Vec<(f64, f64)> = segments
        .iter()
        .map(|segment| (segment.start_time, segment.end_time))
        .collect();
    sorted.sort_by(|left, right| left.0.total_cmp(&right.0));

    let mut gaps = Vec::new();
    let mut cursor = 0.0f64;
    for (start, end) in sorted {
        if start - cursor >= min_span {
            gaps.push((cursor, start));
        }
        cursor = cursor.max(end);
    }
    if duration - cursor >= min_span {
        gaps.push((cursor, duration));
    }
    gaps
}

/// Speaker roster for the ids [`normalize_turns`] produced, in first-appearance
/// order. Colors come from the same palette the embedding backend uses so the
/// two backends do not paint the same recording differently.
fn speakers_for(segments: &[SpeakerSegment]) -> Vec<Speaker> {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899",
    ];
    let mut speakers: Vec<Speaker> = Vec::new();
    for segment in segments {
        if speakers.iter().any(|s| s.id == segment.speaker_id) {
            continue;
        }
        let index = speakers.len();
        speakers.push(Speaker {
            id: segment.speaker_id.clone(),
            name: Some(format!("Speaker {}", index + 1)),
            color: COLORS[index % COLORS.len()].to_string(),
            sample_count: 0,
        });
    }
    speakers
}

/// Run the speakrs pipeline over a recording.
///
/// `ExecutionMode::Cpu` is the only mode wired: the CoreML modes need ~60 more
/// model files (`.mlmodelc` bundles per batch size), each of which would need
/// its own pinned hash and integrity receipt, and the `coreml` Cargo feature
/// on top. See the spike receipt before adding them.
pub(crate) async fn run(audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
    if !is_available() {
        return Err(anyhow::anyhow!(
            "The experimental pyannote community-1 (speakrs) model bundle has not passed Plainsong integrity verification. Download it again from Settings."
        ));
    }

    let audio_path = audio_path.to_path_buf();
    let models_dir = bundle_dir();

    // ONNX Runtime inference and BLAS clustering are blocking CPU work; the
    // whole pipeline is synchronous inside speakrs.
    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<SpeakerSegment>> {
        let samples = crate::audio::utils::load_audio_file(&audio_path)
            .context("Failed to load audio for speakrs diarization")?;
        if samples.is_empty() {
            return Ok(Vec::new());
        }

        let mut pipeline =
            speakrs::OwnedDiarizationPipeline::from_dir(&models_dir, speakrs::ExecutionMode::Cpu)
                .map_err(|error| anyhow::anyhow!("Failed to load the speakrs pipeline: {error}"))?;

        let result = pipeline
            .run(&samples)
            .map_err(|error| anyhow::anyhow!("speakrs diarization failed: {error}"))?;

        let turns: Vec<RawTurn> = result
            .segments
            .iter()
            .map(|segment| RawTurn {
                start: segment.start,
                end: segment.end,
                speaker: segment.speaker.clone(),
            })
            .collect();

        Ok(normalize_turns(&turns, duration))
    })
    .await
    .context("Failed to join the speakrs diarization task")??;

    let gaps = uncovered_spans(&segments, duration, MIN_TURN_SECONDS);
    let unattributed: f64 = gaps.iter().map(|(start, end)| end - start).sum();
    let speakers = speakers_for(&segments);
    tracing::info!(
        "speakrs diarization complete: {} speakers, {} turns, {:.1}s of {:.1}s unattributed",
        speakers.len(),
        segments.len(),
        unattributed,
        duration
    );

    Ok(DiarizationResult {
        segments,
        speakers,
        duration,
        method: DiarizationMethod::Model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start: f64, end: f64, speaker: &str) -> RawTurn {
        RawTurn {
            start,
            end,
            speaker: speaker.to_string(),
        }
    }

    #[test]
    fn assigns_stable_ids_by_first_appearance_not_by_speakrs_numbering() {
        // speakrs numbers clusters by internal index, so the speaker who talks
        // first can be SPEAKER_01. Plainsong's S1 must still be the first
        // voice heard, or the same recording renames its speakers between runs.
        let turns = vec![
            turn(0.0, 4.0, "SPEAKER_01"),
            turn(5.0, 9.0, "SPEAKER_00"),
            turn(10.0, 14.0, "SPEAKER_01"),
        ];
        let segments = normalize_turns(&turns, 20.0);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].speaker_id, "S1");
        assert_eq!(segments[1].speaker_id, "S2");
        assert_eq!(segments[2].speaker_id, "S1");
    }

    #[test]
    fn merges_same_speaker_turns_across_a_breath_gap_only() {
        let turns = vec![
            turn(0.0, 2.0, "SPEAKER_00"),
            // 0.1s gap: one turn.
            turn(2.1, 4.0, "SPEAKER_00"),
            // 1.5s gap: two turns.
            turn(5.5, 7.0, "SPEAKER_00"),
        ];
        let segments = normalize_turns(&turns, 10.0);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_time, 0.0);
        assert_eq!(segments[0].end_time, 4.0);
        assert_eq!(segments[1].start_time, 5.5);
    }

    #[test]
    fn never_merges_across_an_interleaved_speaker() {
        let turns = vec![
            turn(0.0, 2.0, "SPEAKER_00"),
            turn(2.05, 4.0, "SPEAKER_01"),
            turn(4.05, 6.0, "SPEAKER_00"),
        ];
        let segments = normalize_turns(&turns, 10.0);
        assert_eq!(segments.len(), 3);
        assert_eq!(
            segments
                .iter()
                .map(|s| s.speaker_id.as_str())
                .collect::<Vec<_>>(),
            vec!["S1", "S2", "S1"]
        );
    }

    /// pyannote reports overlapping speech, so A-B-A where A's two turns
    /// overlap is ordinary output. Merging only into the last emitted turn left
    /// two A segments claiming the same speaker over the same seconds, and
    /// `merge_with_transcript` assigns text by maximum overlap -- so a word in
    /// the shared span could land in either.
    #[test]
    fn merges_overlapping_turns_of_one_speaker_across_an_interleaved_speaker() {
        let turns = vec![
            turn(0.0, 5.0, "SPEAKER_00"),
            turn(2.0, 3.0, "SPEAKER_01"),
            turn(4.0, 8.0, "SPEAKER_00"),
        ];
        let segments = normalize_turns(&turns, 10.0);

        let speaker_00: Vec<&SpeakerSegment> = segments
            .iter()
            .filter(|segment| segment.speaker_id == "S1")
            .collect();
        assert_eq!(speaker_00.len(), 1, "one turn, not two overlapping: {segments:?}");
        assert_eq!(speaker_00[0].start_time, 0.0);
        assert_eq!(speaker_00[0].end_time, 8.0);
        // The interleaved speaker is still there; the merge covers their span
        // only because the earlier turn already did.
        assert_eq!(segments.len(), 2);
        assert!(segments.iter().any(|segment| segment.speaker_id == "S2"));
    }

    /// Turns that end exactly where the next begins are one turn, whatever was
    /// emitted between them.
    #[test]
    fn merges_touching_turns_of_one_speaker_across_an_interleaved_speaker() {
        let turns = vec![
            turn(0.0, 4.0, "SPEAKER_00"),
            turn(1.0, 2.0, "SPEAKER_01"),
            turn(4.0, 6.0, "SPEAKER_00"),
        ];
        let segments = normalize_turns(&turns, 10.0);
        assert_eq!(segments.len(), 2);
        let merged = segments
            .iter()
            .find(|segment| segment.speaker_id == "S1")
            .expect("the first speaker");
        assert_eq!((merged.start_time, merged.end_time), (0.0, 6.0));
    }

    /// The narrower half of the rule: a breath gap is not bridged across
    /// another speaker's turn, because doing so would swallow it.
    #[test]
    fn a_breath_gap_does_not_bridge_an_interleaved_speaker() {
        let turns = vec![
            turn(0.0, 1.0, "SPEAKER_00"),
            turn(1.05, 1.3, "SPEAKER_01"),
            // 0.05s after the interleaved turn, well inside the breath-gap
            // threshold -- but merging would cover SPEAKER_01 entirely.
            turn(1.35, 3.0, "SPEAKER_00"),
        ];
        let segments = normalize_turns(&turns, 5.0);
        assert_eq!(segments.len(), 3);
        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.speaker_id.as_str())
                .collect::<Vec<_>>(),
            vec!["S1", "S2", "S1"]
        );
    }

    #[test]
    fn drops_flicker_turns_and_rejects_invalid_input() {
        let turns = vec![
            turn(0.0, 0.05, "SPEAKER_00"),
            turn(1.0, 1.0, "SPEAKER_00"),
            turn(3.0, 2.0, "SPEAKER_01"),
            turn(f64::NAN, 5.0, "SPEAKER_01"),
            turn(6.0, f64::INFINITY, "SPEAKER_02"),
            turn(8.0, 12.0, "SPEAKER_03"),
        ];
        let segments = normalize_turns(&turns, 10.0);
        assert_eq!(segments.len(), 1);
        // The 0.05s flicker at the head is dropped *before* ids are assigned,
        // so the only surviving speaker is S1 and not S2.
        assert_eq!(segments[0].speaker_id, "S1");
        // Clamped to the recording, not extended past its end.
        assert_eq!(segments[0].end_time, 10.0);
    }

    #[test]
    fn merging_rescues_a_speaker_split_across_two_sub_threshold_turns() {
        // Neither turn clears MIN_TURN_SECONDS alone; together they are 0.35s
        // of real speech, so dropping first and merging second would lose the
        // speaker entirely.
        let turns = vec![turn(1.0, 1.15, "SPEAKER_00"), turn(1.2, 1.35, "SPEAKER_00")];
        let segments = normalize_turns(&turns, 5.0);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].speaker_id, "S1");
        assert!((segments[0].end_time - 1.35).abs() < 1e-9);
    }

    #[test]
    fn leaves_uncovered_audio_unattributed_instead_of_defaulting_to_s1() {
        let turns = vec![turn(2.0, 4.0, "SPEAKER_00"), turn(8.0, 9.0, "SPEAKER_01")];
        let segments = normalize_turns(&turns, 12.0);

        // No turn was invented for the silence, and nothing was stretched.
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_time, 2.0);
        assert_eq!(segments[1].end_time, 9.0);
        assert!(segments.iter().all(|s| s.end_time <= 9.0));

        let gaps = uncovered_spans(&segments, 12.0, MIN_TURN_SECONDS);
        assert_eq!(gaps, vec![(0.0, 2.0), (4.0, 8.0), (9.0, 12.0)]);
    }

    #[test]
    fn uncovered_spans_ignore_slivers_and_overlapping_turns() {
        let segments = vec![
            SpeakerSegment {
                start_time: 0.0,
                end_time: 5.0,
                speaker_id: "S1".to_string(),
                confidence: SPEAKRS_SEGMENT_CONFIDENCE,
            },
            // Overlapping (both speakers active) must not read as a gap.
            SpeakerSegment {
                start_time: 4.0,
                end_time: 9.0,
                speaker_id: "S2".to_string(),
                confidence: SPEAKRS_SEGMENT_CONFIDENCE,
            },
            // 0.01s sliver, below min_span.
            SpeakerSegment {
                start_time: 9.01,
                end_time: 10.0,
                speaker_id: "S1".to_string(),
                confidence: SPEAKRS_SEGMENT_CONFIDENCE,
            },
        ];
        assert_eq!(uncovered_spans(&segments, 10.0, MIN_TURN_SECONDS), vec![]);
    }

    #[test]
    fn speaker_roster_follows_the_segment_ids() {
        let turns = vec![
            turn(0.0, 2.0, "SPEAKER_02"),
            turn(3.0, 5.0, "SPEAKER_00"),
            turn(6.0, 8.0, "SPEAKER_02"),
        ];
        let segments = normalize_turns(&turns, 10.0);
        let speakers = speakers_for(&segments);
        assert_eq!(
            speakers.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["S1", "S2"]
        );
        assert_eq!(speakers[0].name.as_deref(), Some("Speaker 1"));
    }

    #[test]
    fn empty_or_degenerate_input_produces_no_segments() {
        assert!(normalize_turns(&[], 10.0).is_empty());
        assert!(normalize_turns(&[turn(0.0, 1.0, "SPEAKER_00")], 0.0).is_empty());
        assert!(normalize_turns(&[turn(0.0, 1.0, "SPEAKER_00")], f64::NAN).is_empty());
    }
}
