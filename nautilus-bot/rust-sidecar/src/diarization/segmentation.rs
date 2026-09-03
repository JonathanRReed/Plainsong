//! Where the diarizer cuts its embedding windows.
//!
//! The shipped rule (`embedder::generate_segments`) is a metronome: a 2-second
//! window every 1 second from 0 to the end of the recording, whatever is in
//! the audio. `docs/model-inventory-2026-09.md` §5(d) names that as the
//! dominant error source in the local diarizer — "a better embedding on a
//! badly-placed window is still a badly-placed window" — and the cheapest
//! available accuracy win, because it needs no new model.
//!
//! Two things go wrong with a metronome:
//!
//! 1. **Silence gets embedded.** A window that is mostly room tone still
//!    produces a 192-dimensional vector, and the clusterer has no way to know
//!    it means nothing. It joins whichever centroid it lands nearest.
//! 2. **Turns are straddled.** A speaker change at 7.4 s falls in the middle
//!    of the windows starting at 6 and 7, so both carry two voices and both
//!    embed to somewhere between them.
//!
//! This module fixes both by cutting inside speech regions instead of across
//! the whole recording: windows start at a speech onset and stop at the end of
//! the same speech region.
//!
//! # What must not change, and why
//!
//! The window *length* stays [`embedder::SEGMENT_SECONDS`] and the floor stays
//! [`embedder::MIN_SEGMENT_SECONDS`]. Those two numbers set the FBank frame
//! count the embedders are fed — 198 and 98 frames respectively — and:
//!
//! - `embedding_window::verified_frame_window` caps CAM++ at 220 frames
//!   because ONNX Runtime rewrites its pooling incorrectly at most other
//!   lengths (`artifacts/qa/campplus-divergence-2026-09-02.md`);
//! - every voiceprint threshold in `voiceprints.rs` was calibrated on windows
//!   of exactly this length (`artifacts/qa/voiceprint-calibration-2026-09-02.md`).
//!
//! So this module only changes *where* windows start and *which* are emitted.
//! Every window it produces is still between 1.0 s and 2.0 s long, which is
//! still 98–198 frames, which is still inside both guards. A change here that
//! moved the length would invalidate both, and
//! `windows_stay_inside_the_verified_frame_range` fails if one ever does.

/// A contiguous stretch of speech, in seconds from the start of the recording.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeechRegion {
    pub start: f64,
    pub end: f64,
}

impl SpeechRegion {
    pub fn seconds(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

/// Speech-probability threshold above which a Silero chunk counts as speech.
///
/// The same 0.5 Silero's own wrapper recommends and `audio::silero_vad`
/// already uses for the dictation gate; picking a different number here would
/// mean two parts of the app disagreeing about what speech is.
pub const VAD_SPEECH_PROBABILITY_THRESHOLD: f32 = 0.5;

/// How much speech a region must hold to be worth embedding at all.
///
/// Equal to `MIN_SEGMENT_SECONDS`: below it there is not enough voice to
/// describe, and a shorter window would also fall out of the verified FBank
/// frame range.
pub const VAD_MIN_SPEECH_SECONDS: f64 = 1.0;

/// A gap shorter than this does not end a speech region.
///
/// Between-word and between-clause pauses are routinely 150–250 ms. Splitting
/// on those would shatter one sentence into a dozen sub-second fragments, each
/// too short to embed, and the pipeline would end up seeing *less* speech than
/// the metronome does. 0.4 s is long enough to survive normal articulation and
/// short enough to catch a real turn boundary.
pub const VAD_MIN_SILENCE_SECONDS: f64 = 0.4;

/// Pad every speech region by this much on each side before cutting windows.
///
/// Silero's onsets sit slightly inside the speech — it needs a few frames of
/// evidence before it commits — and clipping a window exactly at the reported
/// onset shaves the leading consonant. A 100 ms collar restores it without
/// reaching into the neighbouring turn (the minimum gap is four times this).
pub const VAD_REGION_PADDING_SECONDS: f64 = 0.1;

/// Merge per-chunk Silero probabilities into speech regions.
///
/// `chunk_seconds` is the audio each probability covers (512 samples at
/// 16 kHz = 32 ms). Regions are padded by [`VAD_REGION_PADDING_SECONDS`],
/// clamped to `[0, duration]`, merged where padding makes them touch, and then
/// anything shorter than [`VAD_MIN_SPEECH_SECONDS`] is dropped.
pub fn speech_regions_from_probabilities(
    probabilities: &[f32],
    chunk_seconds: f64,
    duration: f64,
) -> Vec<SpeechRegion> {
    if probabilities.is_empty() || chunk_seconds <= 0.0 || duration <= 0.0 {
        return Vec::new();
    }

    // Pass 1: raw runs of above-threshold chunks.
    let mut raw: Vec<(usize, usize)> = Vec::new();
    let mut run_start: Option<usize> = None;
    for (index, probability) in probabilities.iter().enumerate() {
        if *probability >= VAD_SPEECH_PROBABILITY_THRESHOLD {
            run_start.get_or_insert(index);
        } else if let Some(start) = run_start.take() {
            raw.push((start, index));
        }
    }
    if let Some(start) = run_start {
        raw.push((start, probabilities.len()));
    }

    // Pass 2: bridge gaps shorter than the minimum silence.
    let min_silence_chunks = (VAD_MIN_SILENCE_SECONDS / chunk_seconds).round() as usize;
    let mut bridged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in raw {
        match bridged.last_mut() {
            Some((_, previous_end)) if start - *previous_end < min_silence_chunks => {
                *previous_end = end;
            }
            _ => bridged.push((start, end)),
        }
    }

    // Pass 3: to seconds, padded and clamped, then merged again where the
    // padding closed a gap, then filtered by length.
    let mut regions: Vec<SpeechRegion> = Vec::with_capacity(bridged.len());
    for (start, end) in bridged {
        let start_seconds =
            (start as f64 * chunk_seconds - VAD_REGION_PADDING_SECONDS).clamp(0.0, duration);
        let end_seconds =
            (end as f64 * chunk_seconds + VAD_REGION_PADDING_SECONDS).clamp(0.0, duration);
        match regions.last_mut() {
            Some(previous) if start_seconds <= previous.end => {
                previous.end = previous.end.max(end_seconds);
            }
            _ => regions.push(SpeechRegion {
                start: start_seconds,
                end: end_seconds,
            }),
        }
    }
    regions.retain(|region| region.seconds() >= VAD_MIN_SPEECH_SECONDS);
    regions
}

/// Cut embedding windows inside speech regions.
///
/// Each region gets windows of `window` seconds starting at its onset and
/// hopping by `hop`, each clipped to the region's end. A window shorter than
/// `min_window` is dropped rather than embedded — except that a region which
/// is itself between `min_window` and `window` long yields exactly one window
/// covering it, because a whole short turn is worth an embedding even though
/// it cannot fill the window.
///
/// The result is sorted and non-overlapping *across* regions (regions do not
/// overlap), and overlapping *within* a region exactly as the shipped
/// segmentation overlaps.
pub fn generate_vad_aligned_segments(
    regions: &[SpeechRegion],
    window: f64,
    hop: f64,
    min_window: f64,
) -> Vec<(f64, f64)> {
    if window <= 0.0 || hop <= 0.0 {
        return Vec::new();
    }
    let mut segments = Vec::new();
    for region in regions {
        let span = region.seconds();
        if span < min_window {
            continue;
        }
        if span <= window {
            segments.push((region.start, region.end));
            continue;
        }
        let mut start = region.start;
        while start < region.end {
            let end = (start + window).min(region.end);
            if end - start >= min_window {
                segments.push((start, end));
            }
            if end >= region.end {
                break;
            }
            start += hop;
        }
    }
    segments
}

/// How much of the recording the emitted windows cover, in seconds, counting
/// overlapped audio once. Reported by the evaluation harness so a segmentation
/// that improves frame error by simply refusing to answer is visible as such.
pub fn covered_seconds(segments: &[(f64, f64)]) -> f64 {
    if segments.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<(f64, f64)> = segments.to_vec();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut covered = 0.0;
    let mut cursor = f64::NEG_INFINITY;
    for (start, end) in sorted {
        let from = start.max(cursor);
        if end > from {
            covered += end - from;
            cursor = end;
        }
    }
    covered
}

/// Run Silero VAD over a whole file and return its speech regions.
///
/// Offline, not streaming: the diarizer already has the finished recording, so
/// there is no latency to trade and the detector is simply walked over the
/// file in its native 512-sample chunks. Returns `None` — never an error —
/// when the VAD model is not on disk or will not load, so a missing optional
/// download degrades the diarizer to its old segmentation instead of failing
/// the meeting.
#[cfg(feature = "diarization")]
pub fn speech_regions_for_file(
    audio_path: &std::path::Path,
    vad_model_path: &std::path::Path,
) -> Option<Vec<SpeechRegion>> {
    use crate::audio::silero_vad::{
        SileroVadDetector, SILERO_VAD_CHUNK_SAMPLES, SILERO_VAD_MODEL_SAMPLE_RATE,
    };

    if !vad_model_path.is_file() {
        tracing::info!(
            "Diarization: no Silero VAD model at {}; keeping the fixed-window segmentation",
            vad_model_path.display()
        );
        return None;
    }
    let samples = match crate::audio::utils::load_audio_file(audio_path) {
        Ok(samples) => samples,
        Err(error) => {
            tracing::warn!("Diarization: could not load audio for VAD ({error})");
            return None;
        }
    };
    if samples.is_empty() {
        return Some(Vec::new());
    }
    let mut detector = match SileroVadDetector::load(vad_model_path) {
        Ok(detector) => detector,
        Err(error) => {
            tracing::warn!(
                "Diarization: Silero VAD did not load ({error}); keeping the fixed-window \
                 segmentation"
            );
            return None;
        }
    };

    let duration = samples.len() as f64 / f64::from(SILERO_VAD_MODEL_SAMPLE_RATE);
    let mut probabilities = Vec::with_capacity(samples.len() / SILERO_VAD_CHUNK_SAMPLES + 1);
    let mut chunk = vec![0.0f32; SILERO_VAD_CHUNK_SAMPLES];
    for offset in (0..samples.len()).step_by(SILERO_VAD_CHUNK_SAMPLES) {
        let available = (samples.len() - offset).min(SILERO_VAD_CHUNK_SAMPLES);
        chunk[..available].copy_from_slice(&samples[offset..offset + available]);
        // The detector's contract is an exact chunk; the file's tail is
        // zero-padded up to it rather than dropped, so the last words of a
        // recording are still seen.
        chunk[available..].iter_mut().for_each(|value| *value = 0.0);
        match detector.detect_speech_probability(&chunk) {
            Ok(probability) => probabilities.push(probability),
            Err(error) => {
                tracing::warn!(
                    "Diarization: Silero VAD failed mid-file ({error}); keeping the fixed-window \
                     segmentation"
                );
                return None;
            }
        }
    }

    let chunk_seconds = SILERO_VAD_CHUNK_SAMPLES as f64 / f64::from(SILERO_VAD_MODEL_SAMPLE_RATE);
    Some(speech_regions_from_probabilities(
        &probabilities,
        chunk_seconds,
        duration,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 512 samples at 16 kHz.
    const CHUNK_SECONDS: f64 = 512.0 / 16_000.0;

    fn probabilities_for(speech_spans: &[(f64, f64)], duration: f64) -> Vec<f32> {
        let chunks = (duration / CHUNK_SECONDS).ceil() as usize;
        (0..chunks)
            .map(|index| {
                let time = index as f64 * CHUNK_SECONDS;
                if speech_spans
                    .iter()
                    .any(|(start, end)| time >= *start && time < *end)
                {
                    0.9
                } else {
                    0.05
                }
            })
            .collect()
    }

    #[test]
    fn a_silent_recording_has_no_speech_regions_and_so_no_windows() {
        let probabilities = probabilities_for(&[], 10.0);
        let regions = speech_regions_from_probabilities(&probabilities, CHUNK_SECONDS, 10.0);
        assert!(regions.is_empty());
        assert!(generate_vad_aligned_segments(&regions, 2.0, 1.0, 1.0).is_empty());
    }

    #[test]
    fn short_pauses_are_bridged_and_real_gaps_are_not() {
        // Two sentences with a 200 ms breath inside the first and a 1.5 s gap
        // between them. The breath must not split a region; the gap must.
        let probabilities = probabilities_for(&[(0.0, 3.0), (3.2, 6.0), (7.5, 11.0)], 12.0);
        let regions = speech_regions_from_probabilities(&probabilities, CHUNK_SECONDS, 12.0);
        assert_eq!(regions.len(), 2, "{regions:?}");
        assert!(regions[0].start < 0.05, "{:?}", regions[0]);
        assert!((regions[0].end - 6.1).abs() < 0.1, "{:?}", regions[0]);
        assert!((regions[1].start - 7.4).abs() < 0.1, "{:?}", regions[1]);
        assert!((regions[1].end - 11.1).abs() < 0.1, "{:?}", regions[1]);
    }

    #[test]
    fn a_region_too_short_to_describe_is_dropped_rather_than_embedded() {
        // 0.6 s of speech is below MIN_SEGMENT_SECONDS even after padding.
        let probabilities = probabilities_for(&[(4.0, 4.6)], 10.0);
        let regions = speech_regions_from_probabilities(&probabilities, CHUNK_SECONDS, 10.0);
        assert!(regions.is_empty(), "{regions:?}");
    }

    #[test]
    fn windows_start_at_the_onset_and_stop_at_the_region_end() {
        let regions = [SpeechRegion {
            start: 4.0,
            end: 9.5,
        }];
        let segments = generate_vad_aligned_segments(&regions, 2.0, 1.0, 1.0);
        assert_eq!(
            segments,
            vec![(4.0, 6.0), (5.0, 7.0), (6.0, 8.0), (7.0, 9.0), (8.0, 9.5),]
        );
        // Nothing before the onset or past the region.
        assert!(segments
            .iter()
            .all(|(start, end)| *start >= 4.0 && *end <= 9.5));
    }

    #[test]
    fn a_half_second_hop_doubles_the_windows_without_changing_their_length() {
        let regions = [SpeechRegion {
            start: 0.0,
            end: 6.0,
        }];
        let coarse = generate_vad_aligned_segments(&regions, 2.0, 1.0, 1.0);
        let fine = generate_vad_aligned_segments(&regions, 2.0, 0.5, 1.0);
        assert!(fine.len() > coarse.len());
        for (start, end) in fine {
            assert!(
                end - start <= 2.0 + 1e-9,
                "a hop change must not change window length: {start}-{end}"
            );
        }
    }

    #[test]
    fn a_turn_shorter_than_the_window_still_gets_exactly_one_embedding() {
        let regions = [SpeechRegion {
            start: 2.0,
            end: 3.4,
        }];
        assert_eq!(
            generate_vad_aligned_segments(&regions, 2.0, 1.0, 1.0),
            vec![(2.0, 3.4)]
        );
    }

    /// The guard the whole module exists under: every window it can emit is
    /// still a length the embedders were verified and calibrated at.
    #[cfg(feature = "diarization")]
    #[test]
    fn windows_stay_inside_the_verified_frame_range() {
        use crate::diarization::embedder::{
            fbank_frames_for_seconds, verified_fbank_frame_range, MIN_SEGMENT_SECONDS,
            SEGMENT_OVERLAP_SECONDS, SEGMENT_SECONDS,
        };

        let verified = verified_fbank_frame_range();
        let regions: Vec<SpeechRegion> = [(0.0, 1.3), (2.0, 9.5), (12.0, 14.0), (20.0, 41.7)]
            .into_iter()
            .map(|(start, end)| SpeechRegion { start, end })
            .collect();
        for hop in [SEGMENT_OVERLAP_SECONDS, 0.5] {
            let segments =
                generate_vad_aligned_segments(&regions, SEGMENT_SECONDS, hop, MIN_SEGMENT_SECONDS);
            assert!(!segments.is_empty());
            for (start, end) in segments {
                let frames = fbank_frames_for_seconds(end - start);
                assert!(
                    verified.contains(&frames),
                    "window {start:.2}-{end:.2}s is {frames} frames, outside {verified:?}"
                );
            }
        }
    }

    #[test]
    fn coverage_counts_overlapped_audio_once() {
        assert_eq!(covered_seconds(&[]), 0.0);
        assert!((covered_seconds(&[(0.0, 2.0), (1.0, 3.0)]) - 3.0).abs() < 1e-9);
        assert!((covered_seconds(&[(5.0, 6.0), (0.0, 1.0)]) - 2.0).abs() < 1e-9);
    }
}
