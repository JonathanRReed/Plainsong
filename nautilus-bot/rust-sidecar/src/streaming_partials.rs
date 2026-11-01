//! Live preview decoding: when to decode, and where to cut.
//!
//! The adaptive scheduler that decides whether a partial decode is worth
//! running, the speech probes it consults, WAV framing for a snapshot, the
//! VAD-aligned cut point that keeps a chunk boundary off a word, and the
//! streaming event payload the renderer receives. `streaming_event_contract_tests`
//! and `chunk_boundary_tests` move with the code they cover.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

/// Adaptive live-preview scheduler. A real speech onset can produce its first
/// preview well before the old fixed 1.2-second floor, while later work is
/// gated on both new audio and a short cadence. The decoder itself is still
/// sequential, so ticks coalesce onto the newest snapshot rather than forming
/// a queue of stale partial jobs.
pub(crate) const DICTATION_PARTIAL_POLL_MS: u64 = 120;
pub(crate) const DICTATION_PARTIAL_INITIAL_SECONDS: f32 = 0.35;
pub(crate) const DICTATION_PARTIAL_GROWTH_SECONDS: f32 = 0.28;
pub(crate) const DICTATION_PARTIAL_FAST_INTERVAL_MS: u64 = 220;
pub(crate) const DICTATION_PARTIAL_LONG_INTERVAL_MS: u64 = 420;
pub(crate) const DICTATION_PARTIAL_LONG_UTTERANCE_SECONDS: f32 = 8.0;
pub(crate) const DICTATION_PARTIAL_RECENT_SPEECH_SECONDS: f32 = 0.45;

/// Speech energy the preview requires before decoding, in dBFS.
///
/// Matches the threshold `transcribe_blocking` trims against, so the preview
/// stops asking the decoder questions whose answer is already known to be
/// `[BLANK_AUDIO]`.
pub(crate) const DICTATION_PARTIAL_MIN_SPEECH_DB: f32 = -40.0;

/// Quieter speech still gets a preview when it stands this far above the
/// session's own noise floor: a whisper sits near -50 dBFS, under the fixed
/// threshold above, and would otherwise never show live text.
const DICTATION_PARTIAL_FLOOR_MARGIN_DB: f32 = 10.0;

/// Nothing quieter than this triggers a preview decode, however quiet the
/// room, so silence never costs a decode.
const DICTATION_PARTIAL_ABSOLUTE_MIN_SPEECH_DB: f32 = -60.0;

/// Frame length and percentile for the noise floor: the quietest tenth of the
/// buffered audio's 30 ms frames is the room between words.
const DICTATION_PARTIAL_FLOOR_FRAME_SECONDS: f32 = 0.03;
const DICTATION_PARTIAL_FLOOR_PERCENTILE: f32 = 0.1;

pub(crate) fn partial_should_decode(
    total_samples: u64,
    last_decoded_total_samples: u64,
    sample_rate: u32,
    elapsed_since_decode_ms: u64,
) -> bool {
    let sample_rate = u64::from(sample_rate.max(1));
    let initial_samples = (sample_rate as f32 * DICTATION_PARTIAL_INITIAL_SECONDS).round() as u64;
    if total_samples < initial_samples {
        return false;
    }

    let required_growth = if last_decoded_total_samples == 0 {
        initial_samples
    } else {
        (sample_rate as f32 * DICTATION_PARTIAL_GROWTH_SECONDS).round() as u64
    };
    if total_samples.saturating_sub(last_decoded_total_samples) < required_growth {
        return false;
    }

    if last_decoded_total_samples == 0 {
        return true;
    }
    let utterance_seconds = total_samples as f32 / sample_rate as f32;
    let interval_ms = if utterance_seconds >= DICTATION_PARTIAL_LONG_UTTERANCE_SECONDS {
        DICTATION_PARTIAL_LONG_INTERVAL_MS
    } else {
        DICTATION_PARTIAL_FAST_INTERVAL_MS
    };
    elapsed_since_decode_ms >= interval_ms
}

/// Whether a preview snapshot carries enough speech to be worth decoding.
///
/// The length gate alone is not enough: 1.2s of near-silence trims back below
/// the pad floor and lands in the same wasted decode. Checking energy first
/// costs one pass over a buffer the tick already cloned.
pub(crate) fn partial_snapshot_has_speech(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return false;
    }
    crate::audio::vad::calculate_energy_db(samples) > DICTATION_PARTIAL_MIN_SPEECH_DB
}

/// Whether the last [`DICTATION_PARTIAL_RECENT_SPEECH_SECONDS`] of `samples`
/// (the session's buffered preview audio) carry speech: either above the fixed
/// threshold, or clearly above the floor the rest of the buffer shows.
pub(crate) fn partial_recent_window_has_speech(samples: &[f32], sample_rate: u32) -> bool {
    let recent_samples =
        (sample_rate.max(1) as f32 * DICTATION_PARTIAL_RECENT_SPEECH_SECONDS).round() as usize;
    let start = samples.len().saturating_sub(recent_samples.max(1));
    let recent = &samples[start..];
    if partial_snapshot_has_speech(recent) {
        return true;
    }
    let recent_db = crate::audio::vad::calculate_energy_db(recent);
    recent_db > DICTATION_PARTIAL_ABSOLUTE_MIN_SPEECH_DB
        && recent_db
            >= partial_noise_floor_db(samples, sample_rate) + DICTATION_PARTIAL_FLOOR_MARGIN_DB
}

fn partial_noise_floor_db(samples: &[f32], sample_rate: u32) -> f32 {
    let frame = ((sample_rate.max(1) as f32 * DICTATION_PARTIAL_FLOOR_FRAME_SECONDS).round()
        as usize)
        .max(1);
    let mut energies: Vec<f32> = samples
        .chunks(frame)
        .map(crate::audio::vad::calculate_energy_db)
        .collect();
    if energies.is_empty() {
        return crate::audio::vad::calculate_energy_db(&[]);
    }
    energies.sort_by(f32::total_cmp);
    energies[((energies.len() - 1) as f32 * DICTATION_PARTIAL_FLOOR_PERCENTILE) as usize]
}

pub(crate) fn mono_samples_to_wav_bytes(
    samples: &[f32],
    sample_rate: u32,
) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut cursor, spec)
        .map_err(|error| format!("Failed to create chunk wav writer: {}", error))?;
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = (clamped * i16::MAX as f32).round() as i16;
        writer
            .write_sample(value)
            .map_err(|error| format!("Failed to write chunk sample: {}", error))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("Failed to finalize chunk wav bytes: {}", error))?;
    Ok(cursor.into_inner())
}

/// Find a frame index inside `samples` that sits in a pause, searching
/// backwards from the end over the last [`CHUNK_CUT_SEARCH_SECONDS`].
///
/// Returns `samples.len()` when nothing in the search window is quiet enough,
/// i.e. the speaker genuinely talked straight through the nominal boundary and
/// there is no better place to cut.
///
/// The noise floor is derived the same way [`audio::vad::VoiceActivityDetector`]
/// derives its adaptive threshold: the 10th percentile of the chunk's frame
/// energies plus a 15 dB margin, so a loud room and a quiet one both get a
/// sensible cut rather than a fixed dBFS number that only suits one of them.
pub(crate) fn vad_aligned_cut_point(samples: &[f32], sample_rate: u32) -> usize {
    let total = samples.len();
    if sample_rate == 0 || total == 0 {
        return total;
    }

    let frame_size = ((sample_rate as f64 * CHUNK_CUT_FRAME_SECONDS).round() as usize).max(1);
    let silence_frames =
        ((CHUNK_CUT_SILENCE_SECONDS / CHUNK_CUT_FRAME_SECONDS).round() as usize).max(1);
    let search_frames =
        ((CHUNK_CUT_SEARCH_SECONDS / CHUNK_CUT_FRAME_SECONDS).round() as usize).max(silence_frames);

    let energies: Vec<f32> = samples
        .chunks(frame_size)
        .map(audio::vad::calculate_energy_db)
        .collect();
    if energies.len() < silence_frames * 2 {
        return total;
    }

    // "Quiet" is measured against how loud *this* chunk's speech is, not
    // against its floor: a chunk that is almost entirely speech has a high
    // 10th-percentile frame energy, and a floor-relative threshold would then
    // call every frame quiet and cut mid-word. Taking the 90th percentile as
    // the speech level and dropping a fixed amount below it inverts that
    // failure into the safe one — when a chunk has no real contrast, nothing
    // clears the threshold and the nominal boundary is used.
    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let loud_index = (((sorted.len() - 1) as f32) * 0.9) as usize;
    let loud_db = sorted[loud_index.min(sorted.len() - 1)];
    let threshold = (loud_db - CHUNK_CUT_SILENCE_DROP_DB).max(CHUNK_CUT_ABSOLUTE_SILENCE_DB);

    // Walk backwards so the cut lands as close to the nominal boundary as a
    // pause allows, keeping chunks near their target length.
    let search_start = energies.len().saturating_sub(search_frames);
    let mut run_end = energies.len();
    let mut run_length = 0usize;
    let mut index = energies.len();
    while index > search_start {
        index -= 1;
        if energies[index] <= threshold {
            if run_length == 0 {
                run_end = index + 1;
            }
            run_length += 1;
            if run_length >= silence_frames {
                let middle = index + (run_end - index) / 2;
                let cut = (middle * frame_size).min(total);
                if cut > 0 && cut < total {
                    return cut;
                }
                return total;
            }
        } else {
            run_length = 0;
        }
    }

    total
}

/// Take the next chunk out of `accumulated`, cut at a pause where one is
/// available; samples after the cut stay behind and open the next chunk.
///
/// Post-capture chunking used to cut at a fixed frame count, which severs a
/// sentence roughly once per chunk — around 80 times in a two-hour meeting —
/// and each severed half is then decoded with `set_no_context(true)`, so
/// neither side can recover the other's words. Cutting in a pause costs nothing
/// and keeps sentences whole.
pub(crate) fn take_vad_aligned_chunk(accumulated: &mut Vec<f32>, sample_rate: u32) -> Vec<f32> {
    let cut = vad_aligned_cut_point(accumulated, sample_rate);
    if cut >= accumulated.len() {
        return std::mem::take(accumulated);
    }
    accumulated.drain(0..cut).collect()
}

/// Build the `recording-transcription-stream` payload for one live segment.
///
/// Shared by the live meeting session and the post-capture preview so both
/// carry identical fields. `text` is the whole preview transcript so far and
/// `segmentText` only the words this segment added, so a consumer that replaces
/// its view on every event and one that appends are both right without knowing
/// which the other is. `delayedPreview`/`lagSeconds` state how far behind the
/// speaker the preview is running, because no ASR provider wired here decodes
/// incrementally.
pub(crate) fn streaming_stream_event_payload(
    recording_id: &str,
    result: &streaming::StreamingResult,
) -> serde_json::Value {
    serde_json::json!({
        "recordingId": recording_id,
        "isPartial": result.is_partial,
        "isFinal": result.is_final,
        "text": result.text,
        "segmentText": result.segment_text,
        "startTime": result.start_time,
        "endTime": result.end_time,
        "confidence": result.confidence,
        "kind": result.kind.as_event_str(),
        "delayedPreview": result.delayed_preview,
        "lagSeconds": result.lag_seconds,
    })
}

/// Whether a streaming result is worth forwarding to the UI.
///
/// Judged on the segment's own words, not on `text`: once anything has been
/// said, `text` is non-empty forever, so testing it would forward every segment
/// that decoded to nothing. A gap marker and the session's closing marker both
/// carry meaning even when their segment is empty, so neither may be filtered
/// out by an emptiness check.
pub(crate) fn should_emit_streaming_result(result: &streaming::StreamingResult) -> bool {
    !result.segment_text.trim().is_empty()
        || result.is_final
        || result.kind == streaming::StreamingSegmentKind::Gap
}

#[cfg(test)]
mod preview_speech_gate_tests {
    use super::partial_recent_window_has_speech;

    const RATE: u32 = 16_000;

    /// A tone whose RMS sits at `db` dBFS.
    fn tone(db: f32, seconds: f32) -> Vec<f32> {
        let amplitude = 10f32.powf(db / 20.0) * std::f32::consts::SQRT_2;
        (0..(RATE as f32 * seconds) as usize)
            .map(|i| amplitude * (std::f32::consts::TAU * 220.0 * i as f32 / RATE as f32).sin())
            .collect()
    }

    fn then(mut head: Vec<f32>, tail: Vec<f32>) -> Vec<f32> {
        head.extend(tail);
        head
    }

    #[test]
    fn a_whisper_over_a_quiet_room_is_previewed() {
        let whisper = then(tone(-72.0, 2.0), tone(-50.0, 0.6));
        assert!(partial_recent_window_has_speech(&whisper, RATE));
    }

    #[test]
    fn a_whisper_too_close_to_the_room_is_not() {
        let near_floor = then(tone(-56.0, 2.0), tone(-50.0, 0.6));
        assert!(!partial_recent_window_has_speech(&near_floor, RATE));
    }

    #[test]
    fn silence_never_triggers_a_decode_however_quiet_the_room() {
        assert!(!partial_recent_window_has_speech(
            &vec![0.0; RATE as usize * 2],
            RATE
        ));
        let room_then_quieter_hum = then(vec![0.0; RATE as usize * 2], tone(-62.0, 0.6));
        assert!(!partial_recent_window_has_speech(
            &room_then_quieter_hum,
            RATE
        ));
    }

    #[test]
    fn normal_speech_needs_no_floor_contrast() {
        assert!(partial_recent_window_has_speech(&tone(-30.0, 0.4), RATE));
    }
}

#[cfg(test)]
mod streaming_event_contract_tests {
    use super::{should_emit_streaming_result, streaming, streaming_stream_event_payload};

    fn result(segment_text: &str, text: &str) -> streaming::StreamingResult {
        streaming::StreamingResult {
            is_partial: true,
            text: text.to_string(),
            segment_text: segment_text.to_string(),
            start_time: 10.0,
            end_time: 20.0,
            confidence: 0.9,
            is_final: false,
            kind: streaming::StreamingSegmentKind::Speech,
            delayed_preview: true,
            lag_seconds: 1.5,
        }
    }

    /// The always-mounted live consumer replaces its preview with `text`, so
    /// sending it the segment alone made it discard everything said earlier.
    /// Both readings have to be on the wire.
    #[test]
    fn the_payload_carries_the_running_transcript_and_the_new_words_separately() {
        let payload = streaming_stream_event_payload(
            "rec-1",
            &result(
                "before Friday",
                "we should ship the parity push before Friday",
            ),
        );

        assert_eq!(payload["recordingId"], "rec-1");
        assert_eq!(
            payload["text"],
            "we should ship the parity push before Friday"
        );
        assert_eq!(payload["segmentText"], "before Friday");
        assert_eq!(payload["isPartial"], true);
        assert_eq!(payload["isFinal"], false);
        assert_eq!(payload["kind"], "speech");
        assert_eq!(payload["delayedPreview"], true);
        assert_eq!(payload["lagSeconds"], 1.5);
    }

    /// Once anything has been said `text` is non-empty forever, so the "is this
    /// worth forwarding?" question has to be asked of the segment.
    #[test]
    fn emptiness_is_judged_on_the_segment_not_on_the_running_transcript() {
        let silent_chunk = result("   ", "we should ship the parity push");
        assert!(
            !should_emit_streaming_result(&silent_chunk),
            "a chunk that decoded to nothing is not an event"
        );

        assert!(should_emit_streaming_result(&result(
            "before Friday",
            "we should ship the parity push before Friday"
        )));

        let mut gap = result("", "we should ship the parity push");
        gap.kind = streaming::StreamingSegmentKind::Gap;
        assert!(
            should_emit_streaming_result(&gap),
            "a lost span is reported even if it somehow carries no marker text"
        );

        let mut closing = result("", "we should ship the parity push");
        closing.is_final = true;
        closing.is_partial = false;
        assert!(
            should_emit_streaming_result(&closing),
            "the closing marker is how a consumer learns the preview stopped"
        );
    }
}

#[cfg(test)]
mod chunk_boundary_tests {
    use super::{take_vad_aligned_chunk, vad_aligned_cut_point, CHUNK_CUT_SEARCH_SECONDS};

    const SAMPLE_RATE: u32 = 16_000;

    fn samples(seconds: f64) -> usize {
        (SAMPLE_RATE as f64 * seconds) as usize
    }

    fn speech(count: usize) -> Vec<f32> {
        (0..count)
            .map(|index| {
                (std::f32::consts::TAU * 180.0 * index as f32 / SAMPLE_RATE as f32).sin() * 0.35
            })
            .collect()
    }

    /// The regression: a 90-second chunk used to be cut at exactly 90 seconds,
    /// severing whatever sentence was in progress — roughly 80 times in a
    /// two-hour meeting, with `set_no_context(true)` on both sides so neither
    /// half can recover the other's words.
    #[test]
    fn chunk_boundary_snaps_to_a_pause_near_the_nominal_length() {
        let mut buffer = speech(samples(15.0));
        buffer.extend(vec![0.0; samples(0.6)]);
        buffer.extend(speech(samples(4.4)));

        let cut = vad_aligned_cut_point(&buffer, SAMPLE_RATE);
        assert!(
            cut >= samples(15.0) && cut <= samples(15.6),
            "cut at {:.2}s is not inside the 15.0-15.6s pause",
            cut as f64 / SAMPLE_RATE as f64
        );
    }

    /// A pause further back than the search window is not worth cutting to —
    /// it would shorten the chunk too much — so the nominal boundary stands.
    #[test]
    fn a_pause_outside_the_search_window_is_ignored() {
        let mut buffer = speech(samples(2.0));
        buffer.extend(vec![0.0; samples(1.0)]);
        buffer.extend(speech(samples(CHUNK_CUT_SEARCH_SECONDS + 5.0)));

        let cut = vad_aligned_cut_point(&buffer, SAMPLE_RATE);
        assert_eq!(cut, buffer.len(), "an out-of-window pause must not be used");
    }

    /// Somebody talking straight through the boundary leaves nowhere better to
    /// cut, and inventing one would be worse than the fixed boundary.
    #[test]
    fn unbroken_speech_falls_back_to_the_nominal_boundary() {
        let buffer = speech(samples(20.0));
        assert_eq!(vad_aligned_cut_point(&buffer, SAMPLE_RATE), buffer.len());
    }

    /// Whatever follows the cut opens the next chunk rather than being dropped
    /// or transcribed twice.
    #[test]
    fn the_remainder_after_a_cut_opens_the_next_chunk() {
        let mut buffer = speech(samples(15.0));
        buffer.extend(vec![0.0; samples(0.6)]);
        buffer.extend(speech(samples(4.4)));
        let original = buffer.clone();

        let chunk = take_vad_aligned_chunk(&mut buffer, SAMPLE_RATE);

        assert!(!chunk.is_empty() && !buffer.is_empty());
        assert_eq!(
            chunk.len() + buffer.len(),
            original.len(),
            "no sample may be lost or duplicated across the cut"
        );
        assert_eq!(&chunk[..], &original[..chunk.len()]);
        assert_eq!(&buffer[..], &original[chunk.len()..]);
    }

    /// Synthetic tone-versus-zeros is an easy case; real speech has breaths,
    /// room tone and consonant tails. Chunk the 44s speech fixture the way the
    /// post-capture path does and require every cut to land somewhere genuinely
    /// quieter than the surrounding speech.
    #[test]
    fn real_speech_cuts_land_in_quiet_audio() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/real-speech-44s.wav");
        let mut reader = hound::WavReader::open(&path)
            .unwrap_or_else(|error| panic!("open {}: {}", path.display(), error));
        let sample_rate = reader.spec().sample_rate;
        let fixture: Vec<f32> = reader
            .samples::<i16>()
            .map(|sample| sample.expect("fixture sample") as f32 / i16::MAX as f32)
            .collect();

        let window = (sample_rate as usize) / 20; // 50ms either side of the cut
        let rms = |span: &[f32]| -> f32 {
            if span.is_empty() {
                return 0.0;
            }
            (span.iter().map(|s| s * s).sum::<f32>() / span.len() as f32).sqrt()
        };
        let overall = rms(&fixture);

        // A 12s nominal chunk gives several boundaries across the fixture.
        let nominal = (sample_rate as usize) * 12;
        let mut accumulated: Vec<f32> = Vec::new();
        let mut consumed = 0usize;
        let mut cuts = 0usize;
        for sample in &fixture {
            accumulated.push(*sample);
            if accumulated.len() < nominal {
                continue;
            }
            let chunk = take_vad_aligned_chunk(&mut accumulated, sample_rate);
            consumed += chunk.len();
            if consumed >= fixture.len() {
                break;
            }
            cuts += 1;

            let low = consumed.saturating_sub(window);
            let high = (consumed + window).min(fixture.len());
            let local = rms(&fixture[low..high]);
            assert!(
                local < overall * 0.5,
                "cut {cuts} at {:.2}s sits at RMS {local:.5}, not meaningfully \
                 quieter than the recording's {overall:.5}",
                consumed as f64 / sample_rate as f64
            );
        }
        assert!(cuts >= 2, "expected several cuts over 44s, got {cuts}");
    }

    /// Buffers too short to analyse must still be handed over whole.
    #[test]
    fn a_short_buffer_is_taken_whole() {
        let mut buffer = speech(samples(0.05));
        let original_len = buffer.len();
        let chunk = take_vad_aligned_chunk(&mut buffer, SAMPLE_RATE);
        assert_eq!(chunk.len(), original_len);
        assert!(buffer.is_empty());
    }
}
