//! Dictation during a recorded meeting: asides.
//!
//! While a meeting records, the dictation shortcut can start an *aside*: a
//! dictation fed from the meeting's own microphone frames, delivered exactly
//! like standalone dictation, and kept out of the meeting's text.
//!
//! - **One capture owner.** The meeting keeps the microphone. An aside attaches
//!   a dictation sink to the meeting's [`MeetingMicTap`], and the capture
//!   worker hands that sink the same microphone frames it writes to the Me
//!   track. Nothing opens the device a second time.
//! - **Exact bounds.** The tap counts Me-track frames as the worker writes
//!   them, so an [`AsideSpan`] names the first and one-past-last frame of the
//!   track that the dictation took. Frames the meeting did not write (a pause)
//!   still reach the dictation, but not the span.
//! - **Kept out by construction.** Dictation checkpoints its own capture for
//!   crash recovery, including pauses and a different dictation microphone.
//!   Every reader that turns the Me track into meeting text silences the span first
//!   ([`silence_aside_frames`]); the combined track and the live transcript
//!   carry only the far side for those frames; the rows of each aside's own
//!   decode are kept beside the transcript ([`MeetingAside`]), never in it, so
//!   notes, search and Ask cannot read them. The system-audio track is never
//!   touched.
//!
//! Nothing here opens a device, so all of it is testable without one.

use crate::models::{Transcript, TranscriptSegment};
use serde::{Deserialize, Serialize};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Enabled after the paired latency, meeting privacy and crash-recovery gates
/// passed. Spans are journaled before audio reaches disk and remain excluded
/// from meeting transcripts, notes and search.
pub(crate) const MEETING_ASIDES_ENABLED: bool = true;

/// What a dictation start says while a meeting holds the microphone and
/// asides are off. Unchanged from before asides existed.
pub(crate) const MEETING_RECORDING_REFUSAL: &str = "A meeting is recording. Stop it to dictate.";

/// The meeting is saving its audio and will release the microphone shortly.
pub(crate) const MEETING_STOPPING_REFUSAL: &str =
    "The meeting is still saving. Dictate again in a moment.";

/// A meeting started or stopped between the start's first look and the
/// moment capture opened. The pill had already said which kind of dictation
/// this was, so the start is refused rather than quietly switched.
pub(crate) const MEETING_CHANGED_DURING_START: &str =
    "The meeting started or stopped while dictation was starting. Try again.";

/// Hands-free listening is off while a meeting records, so only a start that
/// raced the meeting's own start can arrive here. Every word the user says to
/// the call would otherwise start a dictation into the focused app.
pub(crate) const HANDS_FREE_DURING_MEETING_REFUSAL: &str =
    "Hands-free dictation pauses while a meeting records. Use the dictation shortcut instead.";

/// Whether the meeting capture that holds the microphone right now could
/// feed a dictation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingMicrophone {
    /// No meeting is recording.
    Idle,
    Recording {
        /// The meeting writes a Me track. A system-audio-only meeting leaves
        /// the microphone free for an ordinary dictation.
        captures_microphone: bool,
        /// Stop has begun; the tap no longer takes new asides.
        stopping: bool,
    },
}

/// How a dictation start gets its audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DictationAudioRoute {
    /// Open the dictation's own input stream, as without a meeting.
    Standalone,
    /// Take the meeting's microphone frames and mark the span on its Me track.
    MeetingAside,
    /// Do not start; tell the user why.
    Refuse(&'static str),
}

/// Decide where a starting dictation's audio comes from.
pub(crate) fn dictation_audio_route(
    meeting: MeetingMicrophone,
    asides_enabled: bool,
    hands_free_trigger: bool,
) -> DictationAudioRoute {
    match meeting {
        MeetingMicrophone::Idle => DictationAudioRoute::Standalone,
        MeetingMicrophone::Recording { .. } if !asides_enabled => {
            DictationAudioRoute::Refuse(MEETING_RECORDING_REFUSAL)
        }
        MeetingMicrophone::Recording { .. } if hands_free_trigger => {
            DictationAudioRoute::Refuse(HANDS_FREE_DURING_MEETING_REFUSAL)
        }
        MeetingMicrophone::Recording { stopping: true, .. } => {
            DictationAudioRoute::Refuse(MEETING_STOPPING_REFUSAL)
        }
        MeetingMicrophone::Recording {
            captures_microphone: false,
            ..
        } => DictationAudioRoute::Standalone,
        MeetingMicrophone::Recording {
            captures_microphone: true,
            ..
        } => DictationAudioRoute::MeetingAside,
    }
}

/// One aside, in frames of the meeting's Me track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideSpan {
    pub aside_id: String,
    pub dictation_session_id: u64,
    /// Rate of the track the frames count, so a span can be placed on a copy
    /// of the track stored at another rate.
    pub sample_rate: u32,
    /// First Me-track frame the dictation took.
    pub start_frame: u64,
    /// One past the last Me-track frame it took. `None` only for a span that
    /// was still open when it was read: one journaled mid-aside, or left
    /// behind by a crash. Readers treat it as running to the end of the track.
    pub end_frame: Option<u64>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    /// Frames the dictation took while the meeting was paused. They are in
    /// the dictation and nowhere on the track.
    #[serde(default)]
    pub paused_frames: u64,
}

impl AsideSpan {
    /// The frames this span covers on a track `track_frames` long at
    /// `track_rate`, clamped to it; `None` when that leaves nothing. A span
    /// counted at another rate is moved onto this one rounding outward, so a
    /// conversion never uncovers a frame. An open span runs to the end.
    pub fn frames_on_track(&self, track_rate: u32, track_frames: u64) -> Option<Range<u64>> {
        let end = self.end_frame.unwrap_or(u64::MAX);
        let (start, end) = if self.sample_rate == 0 || self.sample_rate == track_rate {
            (self.start_frame, end)
        } else {
            let to_track = |frame: u64, round_up: bool| -> u64 {
                if frame == u64::MAX {
                    return u64::MAX;
                }
                let scaled = u128::from(frame) * u128::from(track_rate);
                let rate = u128::from(self.sample_rate);
                let frames = if round_up {
                    scaled.div_ceil(rate)
                } else {
                    scaled / rate
                };
                u64::try_from(frames).unwrap_or(u64::MAX)
            };
            (to_track(self.start_frame, false), to_track(end, true))
        };
        let range = start.min(track_frames)..end.min(track_frames);
        (!range.is_empty()).then_some(range)
    }
}

/// Where an aside's dictation receives the meeting's microphone frames.
pub(crate) trait AsideSink: Send + Sync {
    /// Mono frames at the meeting's track rate, in capture order.
    fn push_frames(&self, frames: &[f32]);
    /// The meeting's microphone delivered nothing for a while and the gap was
    /// filled with silence, or the meeting ended under the dictation. The
    /// dictation reports an interrupted capture, as a failed stream would.
    fn source_dropped(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AsideTapError {
    /// The meeting is stopping and takes no new aside.
    Closed,
    /// Another dictation already takes the meeting's frames.
    Busy,
    Journal(String),
}

/// What the start path journals before the first aside frame is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AsideTicket {
    pub aside_id: String,
    /// Me-track frames accepted by the writer when the aside attached.
    /// Offered frames can still be dropped, so the journal uses this lower
    /// bound until the exact first aside frame is known.
    pub attached_at_frame: u64,
    pub attached_at_ms: i64,
}

struct Attachment {
    aside_id: String,
    dictation_session_id: u64,
    sample_rate: u32,
    sink: Arc<dyn AsideSink>,
    attached_at_ms: i64,
    start_frame: Option<u64>,
    end_frame: u64,
    paused_frames: u64,
}

impl Attachment {
    fn span(&self, ended_at_ms: Option<i64>) -> Option<AsideSpan> {
        let start_frame = self.start_frame?;
        Some(AsideSpan {
            aside_id: self.aside_id.clone(),
            dictation_session_id: self.dictation_session_id,
            sample_rate: self.sample_rate,
            start_frame,
            end_frame: ended_at_ms.map(|_| self.end_frame),
            started_at_ms: self.attached_at_ms,
            ended_at_ms,
            paused_frames: self.paused_frames,
        })
    }
}

#[derive(Default)]
struct TapState {
    attachment: Option<Attachment>,
    spans: Vec<AsideSpan>,
}

/// The meeting's microphone frames, offered to at most one aside at a time.
///
/// The capture worker calls [`MeetingMicTap::forward`] for every block of
/// microphone frames it drains, written or not. With nothing attached that is
/// one relaxed add and one acquire load; the lock is taken only while an aside
/// is attached.
#[derive(Default)]
pub(crate) struct MeetingMicTap {
    attached: AtomicBool,
    closed: AtomicBool,
    /// Frames written to the Me track so far, net of chunks the writer
    /// dropped: the track position of the next written frame.
    written_frames: AtomicU64,
    accepted_frames: AtomicU64,
    /// Capture clock, independent of the Me-track writer and its dropped chunks.
    forwarded_frames: AtomicU64,
    state: Mutex<TapState>,
}

impl MeetingMicTap {
    fn lock(&self) -> MutexGuard<'_, TapState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether an aside takes the frames right now. Lock-free, so the
    /// realtime callback may ask.
    pub(crate) fn is_attached(&self) -> bool {
        self.attached.load(Ordering::Acquire)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Start giving the meeting's microphone frames to `sink`.
    #[cfg(test)]
    pub(crate) fn attach(
        &self,
        dictation_session_id: u64,
        sample_rate: u32,
        sink: Arc<dyn AsideSink>,
        now_ms: i64,
    ) -> Result<AsideTicket, AsideTapError> {
        self.attach_journaled(dictation_session_id, sample_rate, sink, now_ms, |_| Ok(()))
    }

    pub(crate) fn attach_journaled(
        &self,
        dictation_session_id: u64,
        sample_rate: u32,
        sink: Arc<dyn AsideSink>,
        now_ms: i64,
        journal: impl FnOnce(&AsideTicket) -> Result<(), String>,
    ) -> Result<AsideTicket, AsideTapError> {
        let mut state = self.lock();
        if self.is_closed() {
            return Err(AsideTapError::Closed);
        }
        if state.attachment.is_some() {
            return Err(AsideTapError::Busy);
        }
        let ticket = AsideTicket {
            aside_id: uuid::Uuid::new_v4().to_string(),
            attached_at_frame: self.accepted_frames.load(Ordering::Acquire),
            attached_at_ms: now_ms,
        };
        journal(&ticket).map_err(AsideTapError::Journal)?;
        state.attachment = Some(Attachment {
            aside_id: ticket.aside_id.clone(),
            dictation_session_id,
            sample_rate,
            sink,
            attached_at_ms: now_ms,
            start_frame: None,
            end_frame: ticket.attached_at_frame,
            paused_frames: 0,
        });
        self.attached.store(true, Ordering::Release);
        Ok(ticket)
    }

    /// Hand one drained block of microphone frames to the attached aside.
    ///
    /// `written` says whether the meeting writes this block to its tracks
    /// (false while it is paused). `dropout` says the mixer filled part of the
    /// block with silence because the microphone delivered nothing. Returns
    /// true when the block belongs to an aside, so the caller leaves the
    /// microphone out of the combined track and the live transcript for it.
    pub(crate) fn forward(&self, frames: &[f32], written: bool, dropout: bool) -> bool {
        let count = frames.len() as u64;
        let start = if written {
            self.written_frames.fetch_add(count, Ordering::AcqRel)
        } else {
            self.written_frames.load(Ordering::Acquire)
        };
        if !self.is_attached() || frames.is_empty() {
            return false;
        }
        let mut state = self.lock();
        let Some(attachment) = state.attachment.as_mut() else {
            return false;
        };
        attachment.sink.push_frames(frames);
        self.forwarded_frames.fetch_add(count, Ordering::Release);
        if dropout {
            attachment.sink.source_dropped();
        }
        if written {
            attachment.start_frame.get_or_insert(start);
            attachment.end_frame = start + count;
        } else {
            attachment.paused_frames += count;
        }
        true
    }

    pub(crate) fn forwarded_frames(&self) -> u64 {
        self.forwarded_frames.load(Ordering::Acquire)
    }

    /// Frames accepted by the writer queue. A journal uses this lower bound,
    /// since an offered block can still be dropped after an attachment starts.
    pub(crate) fn writer_accepted(&self, frames: u64) {
        self.accepted_frames.fetch_add(frames, Ordering::AcqRel);
    }

    /// The writer dropped a chunk it had been handed: the track is that much
    /// shorter than the frames forwarded, and later frames land earlier.
    pub(crate) fn writer_dropped(&self, frames: u64) {
        let mut state = self.lock();
        let _ = self
            .written_frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |written| {
                Some(written.saturating_sub(frames))
            });
        let written = self.written_frames.load(Ordering::Acquire);
        let clamp = |span: &mut AsideSpan| {
            span.start_frame = span.start_frame.min(written);
            span.end_frame = span.end_frame.map(|end| end.min(written));
        };
        for span in &mut state.spans {
            clamp(span);
        }
        if let Some(attachment) = state.attachment.as_mut() {
            attachment.start_frame = attachment.start_frame.map(|start| start.min(written));
            attachment.end_frame = attachment.end_frame.min(written);
        }
    }

    /// Stop giving frames to the aside of `dictation_session_id` and close its
    /// span. `None` when another session owns the tap, or when the aside took
    /// no written frame at all (it began and ended during a pause).
    pub(crate) fn detach(&self, dictation_session_id: u64, now_ms: i64) -> Option<AsideSpan> {
        let mut state = self.lock();
        let attachment = state
            .attachment
            .take_if(|attachment| attachment.dictation_session_id == dictation_session_id)?;
        self.attached.store(false, Ordering::Release);
        let span = attachment.span(Some(now_ms))?;
        state.spans.push(span.clone());
        Some(span)
    }

    /// The meeting has begun to stop: take no new aside. One already attached
    /// keeps its frames until it ends or [`MeetingMicTap::close`] runs.
    pub(crate) fn refuse_new(&self) {
        self.closed.store(true, Ordering::Release);
    }

    /// The dictation session taking the frames right now, if any.
    pub(crate) fn attached_session(&self) -> Option<u64> {
        if !self.is_attached() {
            return None;
        }
        self.lock()
            .attachment
            .as_ref()
            .map(|attachment| attachment.dictation_session_id)
    }

    /// The meeting is stopping: take no new aside, and end one still attached
    /// at the last frame it took. Returns the dictation session cut short, if
    /// any, so its capture can be reported as interrupted.
    pub(crate) fn close(&self, now_ms: i64) -> Option<u64> {
        let mut state = self.lock();
        self.closed.store(true, Ordering::Release);
        let attachment = state.attachment.take()?;
        self.attached.store(false, Ordering::Release);
        attachment.sink.source_dropped();
        if let Some(span) = attachment.span(Some(now_ms)) {
            state.spans.push(span);
        }
        Some(attachment.dictation_session_id)
    }

    /// Every aside so far, closed ones first and the attached one, if it has
    /// taken a written frame, last with no end. What a journal persists.
    pub(crate) fn spans(&self) -> Vec<AsideSpan> {
        let state = self.lock();
        let mut spans = state.spans.clone();
        spans.extend(
            state
                .attachment
                .as_ref()
                .and_then(|attachment| attachment.span(None)),
        );
        spans
    }
}

/// The aside frames of a track `track_frames` long at `track_rate`: each
/// span's [`AsideSpan::frames_on_track`], sorted and merged.
pub fn aside_frame_ranges(
    spans: &[AsideSpan],
    track_rate: u32,
    track_frames: u64,
) -> Vec<Range<u64>> {
    let mut ranges: Vec<Range<u64>> = spans
        .iter()
        .filter_map(|span| span.frames_on_track(track_rate, track_frames))
        .collect();
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<Range<u64>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

/// Replace the aside frames of one block of a track with silence before the
/// block is decoded. `block_start` is the block's first frame on the track;
/// `ranges` come from [`aside_frame_ranges`]. Returns the frames silenced.
pub fn silence_aside_frames(samples: &mut [f32], block_start: u64, ranges: &[Range<u64>]) -> usize {
    let block_end = block_start.saturating_add(samples.len() as u64);
    let mut silenced = 0;
    for range in ranges {
        let start = range.start.max(block_start);
        let end = range.end.min(block_end);
        if start >= end {
            continue;
        }
        let from = (start - block_start) as usize;
        let to = (end - block_start) as usize;
        samples[from..to].fill(0.0);
        silenced += to - from;
    }
    silenced
}

/// An aside on a track's timeline, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// One range of frames in seconds of a track at `track_rate`; `None` for a
/// track with no rate.
pub fn aside_seconds(range: &Range<u64>, track_rate: u32) -> Option<AsideRange> {
    let rate = f64::from(track_rate);
    (track_rate > 0).then(|| AsideRange {
        start_seconds: range.start as f64 / rate,
        end_seconds: range.end as f64 / rate,
    })
}

/// [`aside_frame_ranges`] in seconds of a track at `track_rate`.
pub fn aside_second_ranges(ranges: &[Range<u64>], track_rate: u32) -> Vec<AsideRange> {
    ranges
        .iter()
        .filter_map(|range| aside_seconds(range, track_rate))
        .collect()
}

/// Which rows of a stored transcript came from audio that held asides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsideRowScope {
    /// A Me + Them meeting: only rows labelled with the microphone's speaker.
    /// Them rows came from the untouched system track.
    Speaker(&'static str),
    /// A microphone-only meeting: every row came from the Me track.
    AllRows,
    /// Text decoded from the combined track of a Me + Them meeting, which
    /// carries only the far side during an aside.
    None,
}

/// A row wholly inside a masked aside can only be invented speech. A row
/// crossing an edge may contain meeting words, even when its midpoint falls
/// in silence, so keep it. Untimed rows cannot be placed.
pub fn row_is_inside_aside(row: &TranscriptSegment, ranges: &[AsideRange]) -> bool {
    let (start, end) = (row.start_time, row.end_time);
    if !start.is_finite() || !end.is_finite() || end < start || (start == 0.0 && end == 0.0) {
        return false;
    }
    ranges
        .iter()
        .any(|range| start >= range.start_seconds && end <= range.end_seconds)
}

/// Drop the rows of `transcript` that sit inside an aside, from the
/// transcript and from the rows set aside as heard through the speakers, and
/// rebuild the full text the way the transcript builder does. Returns the
/// rows dropped.
///
/// The aside audio is silenced before decoding, so a row left inside one can
/// only be words the recognizer invented over silence. Dropping it keeps the
/// rule simple to state: no row from inside an aside reaches the meeting.
pub fn drop_rows_inside_asides(
    transcript: &mut Transcript,
    ranges: &[AsideRange],
    scope: AsideRowScope,
) -> usize {
    if ranges.is_empty() || scope == AsideRowScope::None {
        return 0;
    }
    let in_scope = |row: &TranscriptSegment| match scope {
        AsideRowScope::Speaker(speaker) => row.speaker_id.as_deref() == Some(speaker),
        AsideRowScope::AllRows => true,
        AsideRowScope::None => false,
    };
    let before = transcript.segments.len() + transcript.heard_through_speakers.len();
    transcript
        .segments
        .retain(|row| !(in_scope(row) && row_is_inside_aside(row, ranges)));
    transcript
        .heard_through_speakers
        .retain(|row| !(in_scope(row) && row_is_inside_aside(row, ranges)));
    let dropped = before - transcript.segments.len() - transcript.heard_through_speakers.len();
    if dropped > 0 {
        transcript.full_text = transcript
            .segments
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
    }
    dropped
}

/// One aside as the meeting keeps it: its own decode, on the recording's
/// timeline, stored beside the transcript and shown only on request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAside {
    pub aside_id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub rows: Vec<TranscriptSegment>,
}

/// Place the decode of one aside's audio, cut from the Me track at `range`,
/// on the recording's timeline.
pub fn place_aside_decode(
    aside_id: &str,
    range: AsideRange,
    speaker_id: Option<&str>,
    result: &crate::asr::TranscriptionResult,
) -> MeetingAside {
    let row = |start_time: f64, end_time: f64, text: &str, confidence: f64| TranscriptSegment {
        id: uuid::Uuid::new_v4().to_string(),
        start_time,
        end_time,
        text: text.trim().to_string(),
        speaker_id: speaker_id.map(str::to_string),
        confidence,
    };
    let mut rows: Vec<TranscriptSegment> = result
        .segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .map(|segment| {
            row(
                range.start_seconds + segment.start_time.max(0.0),
                (range.start_seconds + segment.end_time.max(0.0)).min(range.end_seconds),
                &segment.text,
                segment.confidence,
            )
        })
        .collect();
    if rows.is_empty() && !result.text.trim().is_empty() {
        rows.push(row(
            range.start_seconds,
            range.end_seconds,
            &result.text,
            result.confidence,
        ));
    }
    MeetingAside {
        aside_id: aside_id.to_string(),
        start_time: range.start_seconds,
        end_time: range.end_seconds,
        rows,
    }
}

/// Every occurrence of a canary word in `text`, for the headless leak check:
/// a synthetic aside uses words the meeting never says, and the transcript
/// and notes input must contain none of them. Whole words, case-insensitive.
pub fn canary_hits(text: &str, canaries: &[&str]) -> Vec<(String, usize)> {
    let words: Vec<String> = text
        .split(|character: char| !character.is_alphanumeric() && character != '\'')
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect();
    canaries
        .iter()
        .filter_map(|canary| {
            let canary = canary.trim().to_lowercase();
            let count = words.iter().filter(|word| **word == canary).count();
            (count > 0).then_some((canary, count))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        frames: Mutex<Vec<f32>>,
        dropouts: AtomicU64,
    }

    impl AsideSink for RecordingSink {
        fn push_frames(&self, frames: &[f32]) {
            self.frames.lock().unwrap().extend_from_slice(frames);
        }
        fn source_dropped(&self) {
            self.dropouts.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn capture_tail_clock_keeps_advancing_across_writer_drops_and_pauses() {
        let tap = MeetingMicTap::default();
        let sink = Arc::new(RecordingSink::default());
        tap.attach(1, 48_000, sink, 0).unwrap();
        tap.forward(&[0.1; 4800], true, false);
        let stop = tap.forwarded_frames();
        tap.writer_dropped(4800);
        tap.forward(&[0.1; 2880], true, false);
        tap.forward(&[0.1; 2880], false, false);
        assert_eq!(tap.forwarded_frames() - stop, 5760);
        // Tail polling never waits for the capture worker's checkpoint I/O.
        let _worker_lock = tap.lock();
        assert_eq!(tap.forwarded_frames(), 10560);
    }

    fn written(tap: &MeetingMicTap) -> u64 {
        tap.written_frames.load(Ordering::Acquire)
    }

    fn block(start: usize, len: usize) -> Vec<f32> {
        (start..start + len).map(|index| index as f32).collect()
    }

    fn span(start: u64, end: Option<u64>, rate: u32) -> AsideSpan {
        AsideSpan {
            aside_id: format!("aside-{start}"),
            dictation_session_id: 1,
            sample_rate: rate,
            start_frame: start,
            end_frame: end,
            started_at_ms: 0,
            ended_at_ms: end.map(|_| 1),
            paused_frames: 0,
        }
    }

    fn row(start: f64, end: f64, text: &str, speaker: Option<&str>) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("{start}-{text}"),
            start_time: start,
            end_time: end,
            text: text.to_string(),
            speaker_id: speaker.map(str::to_string),
            confidence: 0.9,
        }
    }

    fn decode(
        text: &str,
        segments: &[(f64, f64, &str, f64)],
        confidence: f64,
    ) -> crate::asr::TranscriptionResult {
        crate::asr::TranscriptionResult {
            text: text.to_string(),
            segments: segments
                .iter()
                .map(
                    |(start, end, text, confidence)| crate::asr::TranscriptSegment {
                        start_time: *start,
                        end_time: *end,
                        text: text.to_string(),
                        confidence: *confidence,
                    },
                )
                .collect(),
            language: "en".to_string(),
            confidence,
            processing_time_ms: 1,
            model_name: "Parakeet".to_string(),
            model_id: "parakeet-tdt-0.6b-v3".to_string(),
            requested_provider: crate::asr::AsrProviderType::Parakeet,
            actual_provider: crate::asr::AsrProviderType::Parakeet,
            requested_engine: None,
            actual_engine: None,
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            measured_word_timestamps: true,
            speaker_turns: Vec::new(),
            vocabulary_candidates: Vec::new(),
        }
    }

    fn transcript(segments: Vec<TranscriptSegment>) -> Transcript {
        let full_text = segments
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        Transcript {
            id: "t".to_string(),
            recording_id: "r".to_string(),
            segments,
            full_text,
            language: "en".to_string(),
            confidence: 0.9,
            model: "m".to_string(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: true,
            created_at: chrono::Utc::now(),
            heard_through_speakers: Vec::new(),
        }
    }

    #[test]
    fn the_route_refuses_exactly_as_before_while_asides_are_off() {
        let recording = MeetingMicrophone::Recording {
            captures_microphone: true,
            stopping: false,
        };
        assert_eq!(
            dictation_audio_route(recording, false, false),
            DictationAudioRoute::Refuse("A meeting is recording. Stop it to dictate.")
        );
        assert_eq!(
            dictation_audio_route(MeetingMicrophone::Idle, false, false),
            DictationAudioRoute::Standalone
        );
    }

    #[test]
    fn the_shipped_route_allows_asides_during_microphone_meetings() {
        assert_eq!(
            dictation_audio_route(
                MeetingMicrophone::Recording {
                    captures_microphone: true,
                    stopping: false,
                },
                MEETING_ASIDES_ENABLED,
                false,
            ),
            DictationAudioRoute::MeetingAside
        );
    }

    #[test]
    fn the_route_shares_the_meeting_microphone_only_when_the_meeting_has_one() {
        let with_mic = MeetingMicrophone::Recording {
            captures_microphone: true,
            stopping: false,
        };
        let system_only = MeetingMicrophone::Recording {
            captures_microphone: false,
            stopping: false,
        };
        assert_eq!(
            dictation_audio_route(with_mic, true, false),
            DictationAudioRoute::MeetingAside
        );
        assert_eq!(
            dictation_audio_route(system_only, true, false),
            DictationAudioRoute::Standalone
        );
        assert_eq!(
            dictation_audio_route(MeetingMicrophone::Idle, true, true),
            DictationAudioRoute::Standalone
        );
    }

    #[test]
    fn the_route_never_starts_an_aside_from_hands_free_or_a_stopping_meeting() {
        let stopping = MeetingMicrophone::Recording {
            captures_microphone: true,
            stopping: true,
        };
        let recording = MeetingMicrophone::Recording {
            captures_microphone: true,
            stopping: false,
        };
        assert_eq!(
            dictation_audio_route(recording, true, true),
            DictationAudioRoute::Refuse(HANDS_FREE_DURING_MEETING_REFUSAL)
        );
        assert_eq!(
            dictation_audio_route(stopping, true, false),
            DictationAudioRoute::Refuse(MEETING_STOPPING_REFUSAL)
        );
    }

    #[test]
    fn a_tap_with_nothing_attached_only_counts_the_track() {
        let tap = MeetingMicTap::default();
        assert!(!tap.forward(&block(0, 480), true, false));
        assert!(!tap.forward(&block(480, 480), false, false));
        assert_eq!(written(&tap), 480);
        assert!(tap.spans().is_empty());
    }

    #[test]
    fn an_aside_takes_exactly_the_frames_its_span_names() {
        let tap = MeetingMicTap::default();
        tap.forward(&block(0, 1_000), true, false);
        tap.writer_accepted(1_000);
        let sink = Arc::new(RecordingSink::default());
        let ticket = tap.attach(7, 48_000, sink.clone(), 100).expect("attach");
        assert_eq!(ticket.attached_at_frame, 1_000);
        assert!(tap.forward(&block(1_000, 480), true, false));
        assert!(tap.forward(&block(1_480, 520), true, false));
        let span = tap.detach(7, 200).expect("span");
        assert!(!tap.forward(&block(2_000, 480), true, false));

        assert_eq!(span.start_frame, 1_000);
        assert_eq!(span.end_frame, Some(2_000));
        assert_eq!(span.sample_rate, 48_000);
        assert_eq!(span.aside_id, ticket.aside_id);
        assert_eq!((span.started_at_ms, span.ended_at_ms), (100, Some(200)));
        // The dictation received the track's own frames for that span, in order.
        assert_eq!(*sink.frames.lock().unwrap(), block(1_000, 1_000));
        assert_eq!(tap.spans(), vec![span]);
        assert_eq!(written(&tap), 2_480);
    }

    #[test]
    fn a_pause_feeds_the_dictation_but_not_the_span() {
        let tap = MeetingMicTap::default();
        tap.forward(&block(0, 100), true, false);
        let sink = Arc::new(RecordingSink::default());
        tap.attach(3, 16_000, sink.clone(), 0).expect("attach");
        assert!(tap.forward(&block(100, 50), true, false));
        // Paused: the meeting writes nothing, the dictation keeps listening.
        assert!(tap.forward(&[9.0; 30], false, false));
        assert!(tap.forward(&block(150, 50), true, false));
        let span = tap.detach(3, 1).expect("span");

        // The track skips the pause, so the span is contiguous on it.
        assert_eq!((span.start_frame, span.end_frame), (100, Some(200)));
        assert_eq!(span.paused_frames, 30);
        assert_eq!(sink.frames.lock().unwrap().len(), 130);
    }

    #[test]
    fn an_aside_entirely_inside_a_pause_leaves_no_span() {
        let tap = MeetingMicTap::default();
        tap.forward(&block(0, 100), true, false);
        let sink = Arc::new(RecordingSink::default());
        tap.attach(4, 16_000, sink.clone(), 0).expect("attach");
        assert!(tap.forward(&[0.5; 64], false, false));
        assert_eq!(tap.detach(4, 1), None);
        assert!(tap.spans().is_empty());
        assert_eq!(sink.frames.lock().unwrap().len(), 64);
    }

    #[test]
    fn an_open_aside_is_journaled_without_an_end() {
        let tap = MeetingMicTap::default();
        let sink = Arc::new(RecordingSink::default());
        tap.attach(5, 48_000, sink, 10).expect("attach");
        // Not journaled before it has taken a written frame...
        assert!(tap.spans().is_empty());
        tap.forward(&block(0, 480), true, false);
        // ...then journaled as open, which readers run to the end of the track.
        let open = tap.spans();
        assert_eq!(open.len(), 1);
        assert_eq!((open[0].start_frame, open[0].end_frame), (0, None));
        assert_eq!(open[0].frames_on_track(48_000, 9_000), Some(0..9_000));
        assert_eq!(open[0].frames_on_track(16_000, 9_000), Some(0..9_000));
    }

    #[test]
    fn only_one_aside_attaches_and_a_closed_tap_takes_none() {
        let tap = MeetingMicTap::default();
        tap.attach(1, 48_000, Arc::new(RecordingSink::default()), 0)
            .expect("first");
        assert_eq!(
            tap.attach(2, 48_000, Arc::new(RecordingSink::default()), 0),
            Err(AsideTapError::Busy)
        );
        // A stale session cannot detach the live one.
        assert_eq!(tap.detach(2, 0), None);
        assert!(tap.is_attached());
        assert_eq!(tap.close(5), Some(1));
        assert!(!tap.is_attached());
        assert_eq!(
            tap.attach(3, 48_000, Arc::new(RecordingSink::default()), 0),
            Err(AsideTapError::Closed)
        );
    }

    #[test]
    fn a_stopping_meeting_keeps_its_aside_but_takes_no_new_one() {
        let tap = MeetingMicTap::default();
        tap.attach(6, 48_000, Arc::new(RecordingSink::default()), 0)
            .expect("attach");
        assert_eq!(tap.attached_session(), Some(6));
        tap.refuse_new();
        assert!(tap.is_closed());
        // The attached aside keeps taking frames until it ends.
        assert!(tap.forward(&block(0, 480), true, false));
        assert_eq!(tap.detach(6, 1).expect("span").end_frame, Some(480));
        assert_eq!(tap.attached_session(), None);
        assert_eq!(
            tap.attach(7, 48_000, Arc::new(RecordingSink::default()), 0),
            Err(AsideTapError::Closed)
        );
    }

    #[test]
    fn closing_the_meeting_under_an_aside_ends_its_span_and_reports_the_dropout() {
        let tap = MeetingMicTap::default();
        let sink = Arc::new(RecordingSink::default());
        tap.attach(9, 48_000, sink.clone(), 0).expect("attach");
        tap.forward(&block(0, 960), true, false);
        assert_eq!(tap.close(42), Some(9));
        assert_eq!(sink.dropouts.load(Ordering::SeqCst), 1);
        let spans = tap.spans();
        assert_eq!(spans.len(), 1);
        assert_eq!(
            (spans[0].end_frame, spans[0].ended_at_ms),
            (Some(960), Some(42))
        );
        // The dictation's own stop finds nothing left to detach.
        assert_eq!(tap.detach(9, 50), None);
    }

    #[test]
    fn a_padded_microphone_gap_reaches_the_dictation_as_a_dropout() {
        let tap = MeetingMicTap::default();
        let sink = Arc::new(RecordingSink::default());
        tap.attach(2, 48_000, sink.clone(), 0).expect("attach");
        tap.forward(&[0.0; 480], true, true);
        assert_eq!(sink.dropouts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_dropped_writer_chunk_moves_later_frames_back() {
        let tap = MeetingMicTap::default();
        tap.forward(&block(0, 1_024), true, false);
        tap.writer_dropped(1_024);
        assert_eq!(written(&tap), 0);
        let sink = Arc::new(RecordingSink::default());
        tap.attach(1, 48_000, sink, 0).expect("attach");
        tap.forward(&block(0, 512), true, false);
        assert_eq!(tap.detach(1, 0).expect("span").start_frame, 0);
        tap.writer_dropped(u64::MAX);
        assert_eq!(written(&tap), 0);
    }

    #[test]
    fn ranges_merge_clamp_and_run_open_spans_to_the_end_of_the_track() {
        let spans = vec![
            span(500, Some(900), 48_000),
            span(100, Some(300), 48_000),
            span(250, Some(400), 48_000),
            span(2_000, None, 48_000),
            span(950, Some(950), 48_000),
        ];
        assert_eq!(
            aside_frame_ranges(&spans, 48_000, 2_500),
            vec![100..400, 500..900, 2_000..2_500]
        );
        // A span past the end of a shorter copy of the track is clamped away.
        assert_eq!(aside_frame_ranges(&spans, 48_000, 450), vec![100..400]);
    }

    #[test]
    fn a_span_moved_to_another_rate_rounds_outward() {
        // 48 kHz frames 1..47_999 cover 1/48000 s to 47_999/48_000 s; at 16 kHz
        // that is frame 0 up to (but not including) 16_000.
        let spans = vec![span(1, Some(47_999), 48_000)];
        assert_eq!(aside_frame_ranges(&spans, 16_000, 32_000), vec![0..16_000]);
        let seconds = aside_second_ranges(&aside_frame_ranges(&spans, 16_000, 32_000), 16_000);
        assert_eq!(
            seconds,
            vec![AsideRange {
                start_seconds: 0.0,
                end_seconds: 1.0
            }]
        );
    }

    #[test]
    fn silencing_touches_only_the_aside_frames_of_a_block() {
        let ranges = vec![10..20, 95..130];
        let mut samples = vec![1.0_f32; 100];
        // The block covers track frames 0..100.
        assert_eq!(silence_aside_frames(&mut samples, 0, &ranges), 15);
        assert!(samples[..10].iter().all(|sample| *sample == 1.0));
        assert!(samples[10..20].iter().all(|sample| *sample == 0.0));
        assert!(samples[20..95].iter().all(|sample| *sample == 1.0));
        assert!(samples[95..].iter().all(|sample| *sample == 0.0));
        // A later block covering 100..150 picks up the rest of the second range.
        let mut next = vec![1.0_f32; 50];
        assert_eq!(silence_aside_frames(&mut next, 100, &ranges), 30);
        assert!(next[..30].iter().all(|sample| *sample == 0.0));
        assert!(next[30..].iter().all(|sample| *sample == 1.0));
        // No ranges, no change.
        let mut untouched = vec![1.0_f32; 8];
        assert_eq!(silence_aside_frames(&mut untouched, 0, &[]), 0);
    }

    #[test]
    fn meeting_words_in_a_row_spanning_an_aside_are_kept() {
        let ranges = [AsideRange {
            start_seconds: 6.0,
            end_seconds: 17.1,
        }];
        let mut stored = transcript(vec![row(
            0.45,
            17.77,
            "Please loop in Chavon and Xavier",
            Some("me"),
        )]);
        assert_eq!(
            drop_rows_inside_asides(&mut stored, &ranges, AsideRowScope::AllRows),
            0
        );
        assert_eq!(stored.full_text, "Please loop in Chavon and Xavier");
    }

    #[test]
    fn rows_inside_an_aside_are_dropped_from_the_microphone_side_only() {
        let ranges = vec![AsideRange {
            start_seconds: 10.0,
            end_seconds: 20.0,
        }];
        let mut stored = transcript(vec![
            row(2.0, 4.0, "before the aside", Some("me")),
            row(11.0, 12.0, "thank you", Some("me")),
            row(12.0, 14.0, "the far side keeps talking", Some("them")),
            // Straddles the start, but its middle (9.5 s) is outside.
            row(8.0, 11.0, "my last meeting words", Some("me")),
            row(19.0, 23.0, "back to the meeting", Some("me")),
            // Untimed rows cannot be placed and are kept.
            row(0.0, 0.0, "untimed", Some("me")),
        ]);
        stored.heard_through_speakers = vec![row(15.0, 16.0, "echo", Some("me"))];

        let dropped = drop_rows_inside_asides(&mut stored, &ranges, AsideRowScope::Speaker("me"));
        assert_eq!(dropped, 2);
        let texts: Vec<&str> = stored
            .segments
            .iter()
            .map(|row| row.text.as_str())
            .collect();
        assert_eq!(
            texts,
            vec![
                "before the aside",
                "the far side keeps talking",
                "my last meeting words",
                "back to the meeting",
                "untimed"
            ]
        );
        assert!(stored.heard_through_speakers.is_empty());
        assert_eq!(
            stored.full_text,
            "before the aside the far side keeps talking my last meeting words back to the meeting untimed"
        );
    }

    #[test]
    fn a_microphone_only_meeting_drops_any_row_inside_an_aside_and_the_mix_drops_none() {
        let ranges = vec![AsideRange {
            start_seconds: 1.0,
            end_seconds: 2.0,
        }];
        let mut mic_only = transcript(vec![
            row(1.2, 1.6, "invented", None),
            row(3.0, 4.0, "kept", None),
        ]);
        assert_eq!(
            drop_rows_inside_asides(&mut mic_only, &ranges, AsideRowScope::AllRows),
            1
        );
        assert_eq!(mic_only.full_text, "kept");

        let mut mixed = transcript(vec![row(1.2, 1.6, "far side", None)]);
        assert_eq!(
            drop_rows_inside_asides(&mut mixed, &ranges, AsideRowScope::None),
            0
        );
        assert_eq!(mixed.full_text, "far side");
    }

    #[test]
    fn an_aside_decode_lands_on_the_recording_timeline() {
        let result = decode(
            "send the deck to Priya",
            &[
                (0.2, 1.0, " send the deck ", 0.8),
                (1.0, 9.0, "to Priya", 0.7),
                (2.0, 2.5, "  ", 0.1),
            ],
            0.75,
        );
        let range = AsideRange {
            start_seconds: 30.0,
            end_seconds: 32.0,
        };
        let aside = place_aside_decode("a1", range, Some("me"), &result);
        assert_eq!((aside.start_time, aside.end_time), (30.0, 32.0));
        assert_eq!(aside.rows.len(), 2);
        assert_eq!(aside.rows[0].text, "send the deck");
        assert_eq!(
            (aside.rows[0].start_time, aside.rows[0].end_time),
            (30.2, 31.0)
        );
        // Clamped to the aside's own end.
        assert_eq!(aside.rows[1].end_time, 32.0);
        assert_eq!(aside.rows[1].speaker_id.as_deref(), Some("me"));

        let text_only = decode(" reply later ", &[], 0.6);
        let aside = place_aside_decode("a2", range, None, &text_only);
        assert_eq!(aside.rows.len(), 1);
        assert_eq!(aside.rows[0].text, "reply later");
        assert_eq!(
            (aside.rows[0].start_time, aside.rows[0].end_time),
            (30.0, 32.0)
        );
    }

    #[test]
    fn a_pending_journal_masks_an_aside_after_an_offered_block_is_dropped() {
        let tap = MeetingMicTap::default();
        tap.forward(&[0.1; 100], true, false);
        tap.writer_accepted(100);
        tap.forward(&[0.1; 20], true, false);
        let sink = Arc::new(RecordingSink::default());
        let ticket = tap.attach(1, 100, sink, 0).unwrap();
        tap.writer_dropped(20);
        tap.forward(&[0.2; 30], true, false);
        let span = tap.detach(1, 1).unwrap();
        assert_eq!(ticket.attached_at_frame, 100);
        assert!(ticket.attached_at_frame <= span.start_frame);
        assert_eq!(span.start_frame, 100);
    }

    #[test]
    fn canary_hits_count_whole_words_only() {
        let text = "Zebracorn launch is Friday. The zebracorns, ZEBRACORN! pomegranate?";
        assert_eq!(
            canary_hits(text, &["zebracorn", "pomegranate", "kumquat"]),
            vec![("zebracorn".to_string(), 2), ("pomegranate".to_string(), 1)]
        );
        assert!(canary_hits("", &["zebracorn"]).is_empty());
    }

    #[test]
    fn spans_serialize_camel_case_and_old_journals_without_paused_frames_load() {
        let span = span(10, Some(20), 48_000);
        let json = serde_json::to_value(&span).expect("serialize");
        assert_eq!(json["startFrame"], 10);
        assert_eq!(json["endFrame"], 20);
        assert_eq!(json["dictationSessionId"], 1);
        let mut legacy = json.clone();
        legacy.as_object_mut().unwrap().remove("pausedFrames");
        let back: AsideSpan = serde_json::from_value(legacy).expect("deserialize");
        assert_eq!(back, span);
    }
}
