//! Incremental/streaming transcription support
//!
//! Produces a running preview of a transcript while audio is still being
//! captured: the live stream is cut at speech/silence boundaries and each cut
//! span is decoded with the configured ASR provider as soon as it is complete.
//!
//! # This is a delayed preview, not live captioning
//!
//! Every provider behind [`crate::asr::AsrProvider`] exposes whole-buffer entry
//! points only (`transcribe` / `transcribe_bytes`); none of them can emit words
//! for speech that is still being spoken. So the honest shape of this module is
//! "decode a finished span as soon as it is finished", not "sub-second live
//! captions". Every emitted [`StreamingResult`] therefore carries
//! [`StreamingResult::delayed_preview`] and [`StreamingResult::lag_seconds`] so
//! the UI can state how far behind the preview is running instead of implying
//! it is live. [`provider_decodes_incrementally`] is the seam that flips the
//! flag if a genuinely streaming provider is ever added.
//!
//! # What bounds the lag
//!
//! Chunks are cut at the first confirmed silence at least [`MIN_CHUNK_SECONDS`]
//! after the previous cut, and at [`MAX_CHUNK_SECONDS`] regardless if nobody
//! pauses. Decoding a span of that length costs less than the span itself on
//! every supported local model, so the cursor keeps up with real time instead
//! of falling progressively further behind — which is what the previous 0.25s
//! chunking did, since a 0.25s span was padded up to 1.1s before a beam search
//! ever ran on it.
//!
//! # What happens when it cannot keep up anyway
//!
//! The ring buffer holds [`RING_BUFFER_SECONDS`] of audio. If the undecoded
//! backlog ever approaches that (a stalled cloud provider, a machine under
//! load), the oldest undecoded samples are about to be overwritten by newer
//! ones. Rather than reading whatever now sits at those indices — which decodes
//! into fluent, plausible text belonging to a completely different minute of
//! the meeting — the cursor jumps to the live edge and a [`StreamingSegmentKind::Gap`]
//! result is emitted for the span that was lost. A visible hole is honest;
//! silent garbage is not.
//!
//! # What a consumer receives
//!
//! Every [`StreamingResult`] carries the whole preview transcript so far in
//! [`StreamingResult::text`] *and* only this segment's new words in
//! [`StreamingResult::segment_text`], so a consumer that replaces its view on
//! every event and one that appends are both correct without either having to
//! know which it is. [`StreamingResult::is_partial`] describes `text`: it is
//! superseded by the next event's longer transcript until the closing event,
//! which is the only one with [`StreamingResult::is_final`] set. `segment_text`
//! is never revised.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::audio::vad::{calculate_energy_db, StreamingVadGate, VadConfig, VadEdge};

/// Shortest span handed to the decoder.
///
/// The previous value was 0.25s, which sits below the 1.1s floor
/// `WhisperProvider::transcribe` pads up to, so every inference decoded mostly
/// synthetic silence and still paid for a full beam search. A batch model needs
/// several seconds of real context to be worth asking at all.
const MIN_CHUNK_SECONDS: f64 = 5.0;

/// Longest span the cutter waits for a silence boundary before cutting anyway.
/// Bounds how far behind the live edge the preview can drift while somebody
/// talks without pausing.
const MAX_CHUNK_SECONDS: f64 = 10.0;

/// How far back a chunk reaches when the *previous* cut had to be forced.
///
/// A forced cut can land mid-word; replaying a little audio gives the decoder
/// the whole word back. The words the lookback duplicates are stripped from the
/// emitted text by [`strip_duplicated_prefix`], so the overlap is decoded twice
/// but never written down twice — the bug the old fixed 0.125s overlap had,
/// which appended the overlap's text to the transcript on both sides of every
/// cut.
const FORCED_CUT_LOOKBACK_SECONDS: f64 = 0.5;

/// Depth of the ring buffer holding captured audio awaiting decode.
const RING_BUFFER_SECONDS: usize = 300;

/// Fraction of the ring the undecoded backlog may reach before the session
/// gives up on the oldest audio and reports a gap. Deliberately well below 1.0:
/// at exactly 1.0 the oldest undecoded sample is already being overwritten as
/// it is read.
const STALE_BACKLOG_FRACTION: f64 = 0.75;

/// VAD analysis frame length. Shorter than `VadConfig::default`'s 30ms so a
/// pause of [`CUT_MIN_SILENCE_SECONDS`] resolves to a useful number of frames
/// rather than six and a half.
const VAD_FRAME_SECONDS: f64 = 0.02;

/// How long quiet must hold before the cutter records a boundary there.
///
/// Deliberately *not* `VadConfig::default`'s 0.3s: that value is tuned for
/// dictation auto-stop, where the question is "has the user finished
/// speaking?", and it is longer than the inter-sentence pauses in ordinary
/// conversation — measured against the 44s speech fixture, the longest pause is
/// about 0.32s, so at 0.3s almost every chunk ended up cut at the maximum
/// instead of at a pause. The question here is only "is this a safe place to
/// cut?", and 0.2s of quiet is comfortably longer than a stop-consonant
/// closure while still landing between sentences.
const CUT_MIN_SILENCE_SECONDS: f32 = 0.2;

/// Upper bound on remembered silence boundaries. Boundaries behind the read
/// cursor are discarded on every plan, so this only trips if nothing is
/// draining the session at all.
const MAX_TRACKED_BOUNDARIES: usize = 4_096;

/// Longest run of words compared when stripping a forced-cut lookback's
/// duplicated text.
const MAX_DEDUPE_WORDS: usize = 24;

/// Whether `provider` can decode audio incrementally, i.e. produce text for
/// speech that is still being spoken.
///
/// Every provider behind `AsrProvider` today exposes only whole-file /
/// whole-buffer entry points, so this is `false` for all of them and the live
/// meeting transcript is necessarily a delayed preview. This exists as the one
/// place to change when a provider grows a real incremental API; the value
/// rides on every emitted segment as [`StreamingResult::delayed_preview`] so
/// the UI never has to guess.
fn provider_decodes_incrementally(_provider: crate::asr::AsrProviderType) -> bool {
    false
}

/// Streaming transcription session
pub struct StreamingSession {
    /// Session ID
    #[expect(
        dead_code,
        reason = "session id is retained in the handle for stream diagnostics"
    )]
    pub id: String,
    /// Ring buffer, VAD cutter and read cursor for this session.
    chunker: Arc<Mutex<StreamingChunker>>,
    /// Transcription results sender
    result_tx: mpsc::Sender<StreamingResult>,
    /// Current accumulated transcript
    transcript: Arc<Mutex<String>>,
    /// Provider type to use
    provider_type: crate::asr::AsrProviderType,
    /// Model to use when the provider supports model selection
    selected_model_id: String,
    /// Held for the whole of a decode pass, so only ever one pass at a time
    /// advances the read cursor, appends to `transcript` and emits.
    ///
    /// Chunk decodes run on spawned tasks while capture keeps feeding, and the
    /// session's finalize has to take the tail out from under whichever decode
    /// is in flight. Two passes running at once would interleave their
    /// `transcript` appends (the meeting reads out of order), emit a speech
    /// segment after the closing marker, and deduplicate a forced cut's
    /// lookback against a transcript tail that does not contain the words it
    /// overlaps.
    decode_lock: Arc<Mutex<()>>,
    /// Sample rate
    sample_rate: u32,
    /// Whether the configured provider only decodes whole buffers, making every
    /// emitted segment a delayed preview rather than a live caption.
    delayed_preview: bool,
}

/// Audio buffer for streaming
struct AudioBuffer {
    data: Vec<f32>,
    write_pos: usize,
    total_written: usize,
}

impl AudioBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            data: vec![0.0; capacity.max(1)],
            write_pos: 0,
            total_written: 0,
        }
    }

    /// Write audio samples to buffer (circular)
    fn write(&mut self, samples: &[f32]) {
        for sample in samples {
            self.data[self.write_pos] = *sample;
            self.write_pos = (self.write_pos + 1) % self.data.len();
            self.total_written += 1;
        }
    }

    /// Absolute index of the oldest sample still resident in the ring.
    fn oldest_resident(&self) -> usize {
        self.total_written.saturating_sub(self.data.len())
    }

    /// Read `count` samples starting at absolute index `start`.
    ///
    /// Returns `None` when the requested span is not (or is no longer)
    /// resident: either it runs past what has been written, or the ring has
    /// already wrapped over it. Modulo arithmetic alone would happily return
    /// the *newer* audio now occupying those indices, which decodes into
    /// fluent text attributed to a span it does not belong to — an error the
    /// caller cannot detect from the text.
    fn get_samples(&self, start: usize, count: usize) -> Option<Vec<f32>> {
        if count == 0 {
            return Some(Vec::new());
        }
        if start < self.oldest_resident() {
            return None;
        }
        if start.checked_add(count)? > self.total_written {
            return None;
        }

        let capacity = self.data.len();
        let actual_start = start % capacity;
        Some(
            (0..count)
                .map(|i| self.data[(actual_start + i) % capacity])
                .collect(),
        )
    }

    /// Get total samples written
    fn total_written(&self) -> usize {
        self.total_written
    }
}

/// Tracks where the incoming stream may be cut without slicing a word in half.
///
/// Every captured sample is framed and pushed through the same O(1),
/// allocation-free [`StreamingVadGate`] the dictation auto-stop uses; the
/// absolute sample index of each confirmed silence edge is remembered so the
/// chunker can prefer cutting there.
struct ChunkCutter {
    gate: StreamingVadGate,
    frame_size: usize,
    /// Samples accumulated towards the next full frame. `StreamingVadGate`
    /// converts its hysteresis durations to frame counts assuming every
    /// `push_frame` represents exactly `frame_size` samples, so a partial
    /// buffer has to be carried across calls rather than counted as a frame.
    pending: Vec<f32>,
    /// Absolute count of samples already folded into whole frames.
    framed: usize,
    /// Absolute indices of confirmed silence edges, ascending.
    boundaries: VecDeque<usize>,
}

impl ChunkCutter {
    fn new(sample_rate: u32) -> Self {
        let frame_size = ((sample_rate as f64 * VAD_FRAME_SECONDS).round() as usize).max(1);
        let config = VadConfig {
            frame_size,
            sample_rate,
            min_silence_duration: CUT_MIN_SILENCE_SECONDS,
            ..VadConfig::default()
        };
        Self {
            gate: StreamingVadGate::new(&config),
            frame_size,
            pending: Vec::with_capacity(frame_size),
            framed: 0,
            boundaries: VecDeque::new(),
        }
    }

    fn feed(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        let mut frame_start = 0;
        while self.pending.len() - frame_start >= self.frame_size {
            let frame_end = frame_start + self.frame_size;
            let energy_db = calculate_energy_db(&self.pending[frame_start..frame_end]);
            self.framed += self.frame_size;
            if self.gate.push_frame(energy_db) == VadEdge::SilenceStarted {
                self.boundaries.push_back(self.framed);
                while self.boundaries.len() > MAX_TRACKED_BOUNDARIES {
                    self.boundaries.pop_front();
                }
            }
            frame_start = frame_end;
        }
        if frame_start > 0 {
            self.pending.drain(0..frame_start);
        }
    }

    /// Take the latest confirmed silence boundary inside `[lowest, highest]`,
    /// discarding every boundary at or below it. Boundaries below `lowest` are
    /// behind the earliest legal cut and are dropped either way.
    fn take_boundary_in(&mut self, lowest: usize, highest: usize) -> Option<usize> {
        while self
            .boundaries
            .front()
            .is_some_and(|boundary| *boundary < lowest)
        {
            self.boundaries.pop_front();
        }

        let mut chosen = None;
        while self
            .boundaries
            .front()
            .is_some_and(|boundary| *boundary <= highest)
        {
            chosen = self.boundaries.pop_front();
        }
        chosen
    }

    /// Forget boundaries the read cursor has already skipped past.
    fn forget_boundaries_before(&mut self, position: usize) {
        while self
            .boundaries
            .front()
            .is_some_and(|boundary| *boundary < position)
        {
            self.boundaries.pop_front();
        }
    }
}

/// One span of audio ready to be decoded.
struct DecodeSpan {
    /// Samples to feed the decoder. Reaches back before `start` when
    /// `has_lookback` is set.
    samples: Vec<f32>,
    /// Absolute sample index this span's *text* is attributed from.
    start: usize,
    /// Absolute sample index this span's text is attributed to (exclusive).
    end: usize,
    /// Whether `samples` replays audio the previous span already produced text
    /// for, so the decoded text needs its duplicated prefix stripped.
    has_lookback: bool,
}

/// What the chunker wants done next.
enum ChunkPlan {
    /// Not enough new audio, or no acceptable cut point yet.
    Wait,
    /// Decode this span.
    Decode(DecodeSpan),
    /// `[start, end)` was overwritten before it could be decoded and is gone.
    Gap { start: usize, end: usize },
}

/// The lock-step half of a streaming session: the ring buffer, the VAD gate
/// that decides where chunks may be cut, and the read cursor.
///
/// Deliberately synchronous and provider-free so the whole cut/backlog/staleness
/// policy can be exercised end-to-end against a fixture WAV without an ASR
/// model present.
struct StreamingChunker {
    buffer: AudioBuffer,
    cutter: ChunkCutter,
    /// Absolute index of the first sample not yet attributed to a result.
    read_pos: usize,
    min_chunk_size: usize,
    max_chunk_size: usize,
    lookback_size: usize,
    stale_backlog_samples: usize,
    /// Whether the previous cut had to be forced (and so may have split a word).
    last_cut_forced: bool,
}

impl StreamingChunker {
    fn new(sample_rate: u32, ring_seconds: usize) -> Self {
        let rate = sample_rate.max(1) as f64;
        let min_chunk_size = ((rate * MIN_CHUNK_SECONDS).round() as usize).max(1);
        let max_chunk_size = ((rate * MAX_CHUNK_SECONDS).round() as usize).max(min_chunk_size);
        let lookback_size = (rate * FORCED_CUT_LOOKBACK_SECONDS).round() as usize;
        // The ring must comfortably exceed one maximum chunk, or a session
        // could go stale before it has ever had enough audio to cut.
        let capacity =
            ((sample_rate.max(1) as usize) * ring_seconds.max(1)).max(max_chunk_size * 4);
        let stale_backlog_samples = ((capacity as f64) * STALE_BACKLOG_FRACTION) as usize;

        Self {
            buffer: AudioBuffer::new(capacity),
            cutter: ChunkCutter::new(sample_rate.max(1)),
            read_pos: 0,
            min_chunk_size,
            max_chunk_size,
            lookback_size,
            stale_backlog_samples,
            last_cut_forced: false,
        }
    }

    fn write(&mut self, samples: &[f32]) {
        self.buffer.write(samples);
        self.cutter.feed(samples);
    }

    fn total_written(&self) -> usize {
        self.buffer.total_written()
    }

    /// Whether it is worth waking the decoder at all.
    fn has_work(&self) -> bool {
        self.buffer
            .total_written()
            .saturating_sub(self.read_pos)
            .checked_sub(self.min_chunk_size)
            .is_some()
    }

    fn next_plan(&mut self) -> ChunkPlan {
        let total = self.buffer.total_written();
        let backlog = total.saturating_sub(self.read_pos);

        // Staleness guard. Once the backlog approaches the ring's depth the
        // oldest undecoded samples are about to be (or already have been)
        // overwritten, so decoding from the cursor would transcribe newer audio
        // under an older timestamp. Skip to the live edge and say so.
        if backlog > self.stale_backlog_samples {
            let dropped_from = self.read_pos;
            let resume_at = total
                .saturating_sub(self.max_chunk_size)
                .max(self.read_pos + 1);
            self.read_pos = resume_at;
            self.cutter.forget_boundaries_before(resume_at);
            // The resume point is arbitrary rather than a split word, and the
            // audio just before it has been declared lost, so a lookback there
            // would replay nothing the transcript can be deduplicated against.
            self.last_cut_forced = false;
            return ChunkPlan::Gap {
                start: dropped_from,
                end: resume_at,
            };
        }

        if backlog < self.min_chunk_size {
            return ChunkPlan::Wait;
        }

        let earliest_cut = self.read_pos + self.min_chunk_size;
        let latest_cut = (self.read_pos + self.max_chunk_size).min(total);
        let (end, forced) = match self.cutter.take_boundary_in(earliest_cut, latest_cut) {
            Some(boundary) => (boundary, false),
            None if backlog >= self.max_chunk_size => (self.read_pos + self.max_chunk_size, true),
            // Still inside the window where a pause may yet arrive.
            None => return ChunkPlan::Wait,
        };

        let lookback = if self.last_cut_forced {
            self.lookback_size
        } else {
            0
        };
        let decode_start = self
            .read_pos
            .saturating_sub(lookback)
            .max(self.buffer.oldest_resident());

        let Some(samples) = self.buffer.get_samples(decode_start, end - decode_start) else {
            // Went stale between the backlog check and the read. Report the
            // hole rather than handing the decoder whatever now sits there.
            let dropped_from = self.read_pos;
            self.read_pos = end;
            self.cutter.forget_boundaries_before(end);
            self.last_cut_forced = false;
            return ChunkPlan::Gap {
                start: dropped_from,
                end,
            };
        };

        let start = self.read_pos;
        self.read_pos = end;
        self.last_cut_forced = forced;
        ChunkPlan::Decode(DecodeSpan {
            samples,
            start,
            end,
            has_lookback: decode_start < start,
        })
    }

    /// Everything left over at the end of the session, however short.
    fn take_tail(&mut self) -> Option<DecodeSpan> {
        let total = self.buffer.total_written();
        if total <= self.read_pos {
            return None;
        }

        let lookback = if self.last_cut_forced {
            self.lookback_size
        } else {
            0
        };
        let decode_start = self
            .read_pos
            .saturating_sub(lookback)
            .max(self.buffer.oldest_resident());
        let samples = self
            .buffer
            .get_samples(decode_start, total - decode_start)?;

        let start = self.read_pos;
        self.read_pos = total;
        self.last_cut_forced = false;
        Some(DecodeSpan {
            samples,
            start,
            end: total,
            has_lookback: decode_start < start,
        })
    }
}

/// What one [`StreamingResult`] describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamingSegmentKind {
    /// Decoded speech covering `[start_time, end_time)`.
    Speech,
    /// Audio covering `[start_time, end_time)` was overwritten before it could
    /// be decoded. Nothing was transcribed for that span and nothing ever will
    /// be; the span is reported so the transcript can show the hole instead of
    /// quietly closing over it.
    Gap,
}

impl StreamingSegmentKind {
    /// Stable wire value for the JSON-RPC event payload.
    pub fn as_event_str(self) -> &'static str {
        match self {
            StreamingSegmentKind::Speech => "speech",
            StreamingSegmentKind::Gap => "gap",
        }
    }
}

/// Streaming transcription result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamingResult {
    /// Whether [`Self::text`] is still going to grow.
    ///
    /// `true` on every segment except the closing one. It describes the running
    /// transcript, not the segment: a batch decoder never revises a span it has
    /// already read, so [`Self::segment_text`] is final the moment it is
    /// emitted, while `text` is superseded by the next event.
    pub is_partial: bool,
    /// The whole preview transcript so far, this segment included.
    ///
    /// Carried on every segment because the live consumer is a
    /// replace-on-event preview: handing it this segment's words alone makes it
    /// paint the last few seconds of the meeting and discard the rest. A
    /// consumer that would rather append has [`Self::segment_text`].
    pub text: String,
    /// Only the words this segment added (or the gap marker it stands for).
    pub segment_text: String,
    /// Segment start time
    pub start_time: f64,
    /// Segment end time
    pub end_time: f64,
    /// Confidence score
    pub confidence: f64,
    /// Whether this is the final result
    pub is_final: bool,
    /// Whether this segment carries decoded speech or reports lost audio.
    pub kind: StreamingSegmentKind,
    /// Whether the provider only decodes whole buffers, making this a preview
    /// that necessarily trails the speaker rather than a live caption.
    pub delayed_preview: bool,
    /// How far behind the live capture edge `end_time` was when this segment
    /// was emitted, in seconds.
    pub lag_seconds: f64,
}

/// Streaming transcriber for real-time transcription
pub struct StreamingTranscriber {
    /// Active sessions
    sessions: Arc<Mutex<std::collections::HashMap<String, StreamingSessionHandle>>>,
    /// ASR manager reference
    asr_manager: Arc<crate::asr::AsrManager>,
}

impl StreamingTranscriber {
    pub fn new(asr_manager: Arc<crate::asr::AsrManager>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            asr_manager,
        }
    }

    /// Start a new streaming session
    pub async fn start_session(
        &self,
        provider_type: crate::asr::AsrProviderType,
        sample_rate: u32,
        selected_model_id: String,
    ) -> Result<(String, mpsc::Receiver<StreamingResult>)> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let (result_tx, result_rx) = mpsc::channel::<StreamingResult>(100);

        let normalized_sample_rate = sample_rate.max(8_000);

        let session = StreamingSession {
            id: session_id.clone(),
            chunker: Arc::new(Mutex::new(StreamingChunker::new(
                normalized_sample_rate,
                RING_BUFFER_SECONDS,
            ))),
            result_tx,
            transcript: Arc::new(Mutex::new(String::new())),
            provider_type,
            selected_model_id,
            decode_lock: Arc::new(Mutex::new(())),
            sample_rate: normalized_sample_rate,
            delayed_preview: !provider_decodes_incrementally(provider_type),
        };

        let handle = StreamingSessionHandle {
            session: Arc::new(session),
            is_active: Arc::new(Mutex::new(true)),
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), handle);

        tracing::info!(
            "Started streaming session: {} ({:.0}-{:.0}s VAD-aligned chunks, delayed preview)",
            session_id,
            MIN_CHUNK_SECONDS,
            MAX_CHUNK_SECONDS
        );
        Ok((session_id, result_rx))
    }

    /// Feed audio to a streaming session
    pub async fn feed_audio(&self, session_id: &str, samples: &[f32]) -> Result<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                Some(handle) => handle.session.clone(),
                None => return Err(anyhow::anyhow!("Session not found: {}", session_id)),
            }
        };

        let has_work = {
            let mut chunker = session.chunker.lock().await;
            chunker.write(samples);
            chunker.has_work()
        };

        // A decode pass already running will pick this audio up on its next
        // loop, so failing to take the lock means there is nothing to do.
        if has_work {
            if let Ok(decoding) = Arc::clone(&session.decode_lock).try_lock_owned() {
                let session_clone = session.clone();
                let asr_manager = self.asr_manager.clone();

                tokio::spawn(async move {
                    let _decoding = decoding;
                    drive_session(&session_clone, &asr_manager).await;
                });
            }
        }

        Ok(())
    }

    /// Finalize a streaming session and get the final transcript
    pub async fn finalize_session(&self, session_id: &str) -> Result<String> {
        let handle = self.sessions.lock().await.remove(session_id);
        let Some(handle) = handle else {
            return Err(anyhow::anyhow!("Session not found: {}", session_id));
        };
        *handle.is_active.lock().await = false;

        let session = handle.session.clone();
        // Wait for the in-flight decode rather than giving it a fixed budget.
        // A chunk is 5-10s of audio and a local model spends a good fraction of
        // that decoding it, so any fixed budget short enough to be worth having
        // expires routinely — and proceeding anyway put two passes on the same
        // session, which reorders the transcript and emits speech after the
        // closing marker. The wait is unbounded because the only thing it waits
        // on is a provider call finalize would otherwise be making itself: a
        // provider that hangs hangs this either way.
        let _decoding = Arc::clone(&session.decode_lock).lock_owned().await;

        // Drain whatever whole chunks are still queued, then the short tail.
        drive_session(&session, &self.asr_manager).await;

        let tail = session.chunker.lock().await.take_tail();
        match tail {
            Some(span) => decode_and_emit(&session, &self.asr_manager, span, true).await,
            None => {
                // Still tell the listener the session closed, so a preview that
                // ended exactly on a chunk boundary isn't left looking live.
                let end = session.chunker.lock().await.total_written();
                record_and_emit(
                    &session,
                    StreamingSegmentKind::Speech,
                    String::new(),
                    end,
                    end,
                    0.0,
                    true,
                )
                .await;
            }
        }

        let transcript = session.transcript.lock().await.clone();
        Ok(transcript)
    }

    /// Stop a streaming session without finalizing
    #[expect(
        dead_code,
        reason = "explicit stop remains part of the streaming session control surface"
    )]
    pub async fn stop_session(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;

        if let Some(handle) = sessions.remove(session_id) {
            *handle.is_active.lock().await = false;
            tracing::info!("Stopped streaming session: {}", session_id);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Session not found: {}", session_id))
        }
    }

    /// Check if a session is active
    #[expect(
        dead_code,
        reason = "activity query remains part of the streaming session control surface"
    )]
    pub async fn is_session_active(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.contains_key(session_id)
    }
}

/// Handle for managing a streaming session
struct StreamingSessionHandle {
    session: Arc<StreamingSession>,
    is_active: Arc<Mutex<bool>>,
}

/// Decode every chunk the session currently has ready, oldest first.
async fn drive_session(session: &Arc<StreamingSession>, asr_manager: &crate::asr::AsrManager) {
    loop {
        let plan = session.chunker.lock().await.next_plan();
        match plan {
            ChunkPlan::Wait => return,
            ChunkPlan::Gap { start, end } => emit_gap(session, start, end).await,
            ChunkPlan::Decode(span) => decode_and_emit(session, asr_manager, span, false).await,
        }
    }
}

/// Report a span of audio that was overwritten before it could be decoded.
async fn emit_gap(session: &Arc<StreamingSession>, start: usize, end: usize) {
    let rate = session.sample_rate as f64;
    let start_time = start as f64 / rate;
    let end_time = end as f64 / rate;
    let dropped_seconds = (end_time - start_time).max(0.0);

    tracing::warn!(
        "Streaming transcription fell {:.0}s behind the ring buffer; \
         {:.0}s of audio between {:.1}s and {:.1}s was not transcribed",
        dropped_seconds,
        dropped_seconds,
        start_time,
        end_time
    );

    record_and_emit(
        session,
        StreamingSegmentKind::Gap,
        gap_marker_text(dropped_seconds),
        start,
        end,
        0.0,
        false,
    )
    .await;
}

/// Append one segment to the session's running transcript and send it.
///
/// The single place the wire shape is decided, so a gap marker, a decoded chunk
/// and the closing marker cannot drift apart: `segment_text` is what this
/// segment added, `text` is everything set down so far including it, and
/// `is_partial` says whether `text` will grow again.
async fn record_and_emit(
    session: &Arc<StreamingSession>,
    kind: StreamingSegmentKind,
    segment_text: String,
    start: usize,
    end: usize,
    confidence: f64,
    is_final: bool,
) {
    let rate = session.sample_rate as f64;
    let transcript = {
        let mut transcript = session.transcript.lock().await;
        if !segment_text.is_empty() {
            if !transcript.is_empty() {
                transcript.push(' ');
            }
            transcript.push_str(&segment_text);
        }
        transcript.clone()
    };

    // A chunk that decoded to nothing is not worth an event, but the closing
    // marker is: it is how a consumer learns the preview stopped being live.
    if segment_text.is_empty() && !is_final {
        return;
    }

    let total = session.chunker.lock().await.total_written();
    emit(
        session,
        StreamingResult {
            is_partial: !is_final,
            text: transcript,
            segment_text,
            start_time: start as f64 / rate,
            end_time: end as f64 / rate,
            confidence,
            is_final,
            kind,
            delayed_preview: session.delayed_preview,
            lag_seconds: (total.saturating_sub(end)) as f64 / rate,
        },
    )
    .await;
}

/// Plain-language stand-in, written into the running transcript in the place
/// the lost audio would have occupied, so even a renderer that only shows
/// `text` tells the truth about the hole. A renderer that understands
/// [`StreamingSegmentKind::Gap`] should present the span its own way instead.
fn gap_marker_text(dropped_seconds: f64) -> String {
    format!(
        "[{:.0}s not transcribed: the live preview fell behind]",
        dropped_seconds.max(0.0)
    )
}

/// Decode one span and emit its text.
async fn decode_and_emit(
    session: &Arc<StreamingSession>,
    asr_manager: &crate::asr::AsrManager,
    span: DecodeSpan,
    is_final: bool,
) {
    let wav_bytes = samples_to_wav(&span.samples, session.sample_rate);

    let (decoded_text, confidence) = if wav_bytes.is_empty() {
        (String::new(), 0.0)
    } else {
        match asr_manager
            .transcribe_bytes_with_provider(
                session.provider_type,
                &wav_bytes,
                Some(session.selected_model_id.as_str()),
            )
            .await
        {
            Ok(result) => (result.text, result.confidence),
            Err(error) => {
                // The cursor has already advanced, so a transient provider
                // failure costs one chunk rather than wedging the session.
                tracing::warn!("Streaming chunk transcription failed: {}", error);
                (String::new(), 0.0)
            }
        }
    };

    // Reading the transcript here and appending to it in `record_and_emit` is
    // only safe because `decode_lock` is held for the whole pass: nothing else
    // can slip words in between the two.
    let segment_text = if span.has_lookback {
        let transcript = session.transcript.lock().await;
        strip_duplicated_prefix(dedupe_tail(&transcript), &decoded_text)
    } else {
        decoded_text.trim().to_string()
    };

    record_and_emit(
        session,
        StreamingSegmentKind::Speech,
        segment_text,
        span.start,
        span.end,
        confidence,
        is_final,
    )
    .await;
}

async fn emit(session: &Arc<StreamingSession>, result: StreamingResult) {
    if session.result_tx.send(result).await.is_err() {
        tracing::debug!("Streaming result receiver dropped; discarding segment");
    }
}

/// Tail of the accumulated transcript long enough to cover
/// [`MAX_DEDUPE_WORDS`], so the duplicate check costs the same on the last
/// chunk of a two-hour meeting as on the first instead of rescanning
/// everything written so far.
fn dedupe_tail(transcript: &str) -> &str {
    /// Comfortably more than `MAX_DEDUPE_WORDS` words at any plausible word
    /// length, in any script.
    const TAIL_BYTES: usize = 512;

    if transcript.len() <= TAIL_BYTES {
        return transcript;
    }
    let mut start = transcript.len() - TAIL_BYTES;
    while start < transcript.len() && !transcript.is_char_boundary(start) {
        start += 1;
    }
    &transcript[start..]
}

/// Drop the leading words of `incoming` that merely repeat the tail of
/// `previous`.
///
/// A forced cut (no silence found within [`MAX_CHUNK_SECONDS`]) can land in the
/// middle of a word, so the next span is decoded with a short lookback to give
/// the decoder the whole word back. That lookback is audio the previous span
/// already produced text for, so without this its words would be written down
/// twice.
fn strip_duplicated_prefix(previous: &str, incoming: &str) -> String {
    let previous_words = normalized_words(previous);
    let incoming_words = normalized_words(incoming);
    if previous_words.is_empty() || incoming_words.is_empty() {
        return incoming.trim().to_string();
    }

    let max_overlap = previous_words
        .len()
        .min(incoming_words.len())
        .min(MAX_DEDUPE_WORDS);
    for overlap in (1..=max_overlap).rev() {
        let previous_tail = &previous_words[previous_words.len() - overlap..];
        let incoming_head = &incoming_words[..overlap];
        let matches = previous_tail
            .iter()
            .zip(incoming_head.iter())
            .all(|((_, left), (_, right))| left == right);
        if matches {
            return match incoming_words.get(overlap) {
                Some((offset, _)) => incoming[*offset..].trim().to_string(),
                None => String::new(),
            };
        }
    }

    incoming.trim().to_string()
}

/// Split `text` into `(byte offset, comparison form)` pairs, one per word.
fn normalized_words(text: &str) -> Vec<(usize, String)> {
    let mut words: Vec<(usize, String)> = Vec::new();
    let mut word_start: Option<usize> = None;

    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            if let Some(start) = word_start.take() {
                words.push((start, normalize_word(&text[start..index])));
            }
        } else if word_start.is_none() {
            word_start = Some(index);
        }
    }
    if let Some(start) = word_start {
        words.push((start, normalize_word(&text[start..])));
    }

    words.retain(|(_, word)| !word.is_empty());
    words
}

/// Comparison form of one word: letters and digits only, lowercased, so
/// punctuation the decoder placed differently on either side of a cut does not
/// hide a duplicate.
fn normalize_word(word: &str) -> String {
    word.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Convert f32 samples to WAV bytes
fn samples_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    use hound::{WavSpec, WavWriter};
    use std::io::Cursor;

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    let result: anyhow::Result<()> = (|| {
        let mut writer = WavWriter::new(&mut cursor, spec)
            .map_err(|e| anyhow::anyhow!("Failed to create WAV writer: {}", e))?;

        for sample in samples {
            let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
            writer
                .write_sample(int_sample)
                .map_err(|e| anyhow::anyhow!("Failed to write sample: {}", e))?;
        }

        writer
            .finalize()
            .map_err(|e| anyhow::anyhow!("Failed to finalize WAV: {}", e))?;
        Ok(())
    })();

    if let Err(e) = result {
        tracing::error!("WAV encoding failed: {}", e);
        return Vec::new();
    }

    cursor.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: u32 = 16_000;

    fn seconds(count: f64) -> usize {
        (SAMPLE_RATE as f64 * count) as usize
    }

    /// A tone loud enough to clear the VAD's adaptive threshold.
    fn speech(count: usize) -> Vec<f32> {
        (0..count)
            .map(|index| {
                (std::f32::consts::TAU * 220.0 * index as f32 / SAMPLE_RATE as f32).sin() * 0.4
            })
            .collect()
    }

    fn silence(count: usize) -> Vec<f32> {
        vec![0.0; count]
    }

    /// A session wired to a channel the test owns, so the emission path can be
    /// exercised without a model on disk.
    fn test_session() -> (Arc<StreamingSession>, mpsc::Receiver<StreamingResult>) {
        let (result_tx, result_rx) = mpsc::channel(64);
        let session = StreamingSession {
            id: "test-session".to_string(),
            chunker: Arc::new(Mutex::new(StreamingChunker::new(SAMPLE_RATE, 60))),
            result_tx,
            transcript: Arc::new(Mutex::new(String::new())),
            provider_type: crate::asr::AsrProviderType::Whisper,
            selected_model_id: String::new(),
            decode_lock: Arc::new(Mutex::new(())),
            sample_rate: SAMPLE_RATE,
            delayed_preview: true,
        };
        (Arc::new(session), result_rx)
    }

    /// Read the 44s mono 16kHz speech fixture as normalized f32 samples.
    fn real_speech_fixture() -> (Vec<f32>, u32) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/real-speech-44s.wav");
        let mut reader = hound::WavReader::open(&path)
            .unwrap_or_else(|error| panic!("open {}: {}", path.display(), error));
        let spec = reader.spec();
        let channels = spec.channels as usize;
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|sample| sample.expect("fixture sample") as f32 / i16::MAX as f32)
            .collect::<Vec<_>>()
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
        (samples, spec.sample_rate)
    }

    #[test]
    fn ring_buffer_refuses_reads_of_overwritten_audio() {
        let capacity = 64;
        let mut buffer = AudioBuffer::new(capacity);

        // Fill exactly once: everything is still resident.
        let first: Vec<f32> = (0..capacity).map(|index| index as f32).collect();
        buffer.write(&first);
        assert_eq!(buffer.get_samples(0, capacity).as_deref(), Some(&first[..]));

        // Reading past the write head is not "zeros", it is unknown.
        assert!(buffer.get_samples(0, capacity + 1).is_none());
        assert!(buffer.get_samples(capacity, 1).is_none());

        // Wrap halfway. The first half has been overwritten; modulo arithmetic
        // alone would return the *newer* samples now sitting at those indices.
        let second: Vec<f32> = (0..capacity / 2)
            .map(|index| 1000.0 + index as f32)
            .collect();
        buffer.write(&second);
        assert_eq!(buffer.oldest_resident(), capacity / 2);
        assert!(
            buffer.get_samples(0, 8).is_none(),
            "overwritten span must not be readable"
        );

        // The still-resident span reads back exactly, and nothing else.
        let resident = buffer
            .get_samples(capacity / 2, capacity)
            .expect("resident span");
        let mut expected: Vec<f32> = first[capacity / 2..].to_vec();
        expected.extend_from_slice(&second);
        assert_eq!(resident, expected);
    }

    #[test]
    fn chunk_is_cut_at_a_pause_rather_than_at_a_fixed_length() {
        let mut chunker = StreamingChunker::new(SAMPLE_RATE, 60);

        // Six seconds of speech, then a clear two-second pause, then more
        // speech. The cut must land inside the pause, not at an arbitrary
        // fixed offset.
        chunker.write(&speech(seconds(6.0)));
        chunker.write(&silence(seconds(2.0)));
        chunker.write(&speech(seconds(1.0)));

        let ChunkPlan::Decode(span) = chunker.next_plan() else {
            panic!("a cut must be available after a pause past the minimum chunk");
        };
        assert_eq!(span.start, 0);
        assert!(
            span.end > seconds(6.0) && span.end <= seconds(8.0),
            "cut at {} samples ({:.2}s) is not inside the pause",
            span.end,
            span.end as f64 / SAMPLE_RATE as f64
        );
        assert!(!span.has_lookback, "a clean cut needs no lookback");
        assert_eq!(span.samples.len(), span.end - span.start);
    }

    #[test]
    fn unbroken_speech_is_cut_at_the_maximum_with_a_lookback() {
        let mut chunker = StreamingChunker::new(SAMPLE_RATE, 60);
        chunker.write(&speech(seconds(25.0)));

        let ChunkPlan::Decode(first) = chunker.next_plan() else {
            panic!("unbroken speech must still be cut at the maximum");
        };
        assert_eq!(first.start, 0);
        assert_eq!(first.end, seconds(MAX_CHUNK_SECONDS));
        assert!(!first.has_lookback);

        // The forced cut may have split a word, so the next span replays a
        // little audio to give the decoder the whole word back.
        let ChunkPlan::Decode(second) = chunker.next_plan() else {
            panic!("second chunk must be available");
        };
        assert_eq!(second.start, first.end);
        assert!(second.has_lookback, "a forced cut must be followed by one");
        assert_eq!(
            second.samples.len(),
            (second.end - second.start) + seconds(FORCED_CUT_LOOKBACK_SECONDS),
            "lookback must extend the decoded span, not the attributed span"
        );
    }

    #[test]
    fn lookback_text_is_not_written_down_twice() {
        // The tail of the previous chunk, re-decoded from the lookback audio,
        // reappears at the head of the next chunk's text.
        assert_eq!(
            strip_duplicated_prefix(
                "we should ship the parity push",
                "the parity push before Friday"
            ),
            "before Friday"
        );
        // Punctuation and casing differ across the cut; still a duplicate.
        assert_eq!(
            strip_duplicated_prefix("...ship the parity push.", "The parity push, before Friday"),
            "before Friday"
        );
        // No overlap: nothing is dropped.
        assert_eq!(
            strip_duplicated_prefix("we should ship it", "on to the next item"),
            "on to the next item"
        );
        // Wholly duplicated chunk collapses to nothing rather than repeating.
        assert_eq!(
            strip_duplicated_prefix("the parity push", "the parity push"),
            ""
        );
        assert_eq!(
            strip_duplicated_prefix("", "anything at all"),
            "anything at all"
        );
    }

    /// The duplicate check must cost the same on the thousandth chunk of a
    /// meeting as on the first, and must never slice a multi-byte character.
    #[test]
    fn dedupe_only_looks_at_the_end_of_a_long_transcript() {
        let long = format!("{} we should ship the parity push", "filler ".repeat(5_000));
        assert!(dedupe_tail(&long).len() <= 512);
        assert!(dedupe_tail(&long).ends_with("we should ship the parity push"));
        assert_eq!(
            strip_duplicated_prefix(dedupe_tail(&long), "the parity push before Friday"),
            "before Friday"
        );

        let unicode = "。".repeat(1_000);
        assert!(dedupe_tail(&unicode).chars().all(|c| c == '。'));
    }

    /// The regression the ring buffer's staleness guard exists for: when the
    /// decoder cannot keep up, the samples it is handed must still be the
    /// samples the timestamps claim. Previously the modulo read silently
    /// returned whatever newer audio had wrapped over the cursor.
    #[test]
    fn a_backlog_past_the_ring_reports_a_gap_instead_of_returning_stale_audio() {
        // Short ring so the backlog can outrun it in a test-sized stream.
        let ring_seconds = 30usize;
        let mut chunker = StreamingChunker::new(SAMPLE_RATE, ring_seconds);

        // Write a stream whose every sample encodes its own absolute index, so
        // any stale read is detectable by value.
        let total = seconds(90.0);
        let stamp = |index: usize| index as f32;
        let mut written = 0usize;
        while written < total {
            let batch: Vec<f32> = (written..(written + seconds(1.0)).min(total))
                .map(stamp)
                .collect();
            written += batch.len();
            chunker.write(&batch);
        }

        let mut gaps = Vec::new();
        let mut decoded = Vec::new();
        loop {
            match chunker.next_plan() {
                ChunkPlan::Wait => break,
                ChunkPlan::Gap { start, end } => gaps.push((start, end)),
                ChunkPlan::Decode(span) => {
                    // Every returned sample must equal the value written at
                    // that absolute index. This is the "no sample is read
                    // after being overwritten" assertion.
                    let decode_start = span.end - span.samples.len();
                    for (offset, sample) in span.samples.iter().enumerate() {
                        assert_eq!(
                            *sample,
                            stamp(decode_start + offset),
                            "sample at absolute index {} was overwritten before it was read",
                            decode_start + offset
                        );
                    }
                    decoded.push((span.start, span.end));
                }
            }
        }

        assert_eq!(
            gaps.len(),
            1,
            "one skip forward expected, got {gaps:?} (decoded {decoded:?})"
        );
        let (gap_start, gap_end) = gaps[0];
        assert_eq!(gap_start, 0);
        assert!(
            gap_end >= total - seconds(MAX_CHUNK_SECONDS),
            "the cursor must resume at the live edge, not just inside the ring"
        );
        assert!(
            !decoded.is_empty(),
            "decoding must resume after the reported gap"
        );
        assert!(
            decoded.iter().all(|(start, _)| *start >= gap_end),
            "no chunk may be attributed to the span already reported as lost"
        );
    }

    /// End-to-end over the real speech fixture at capture cadence, with a
    /// decoder deliberately slower than the old 0.25s design could ever have
    /// kept up with. Asserts the two properties the previous implementation
    /// could not hold: bounded lag, and never reading a sample the ring has
    /// overwritten.
    #[test]
    fn fixture_stream_keeps_lag_bounded_and_never_reads_overwritten_audio() {
        let (fixture, sample_rate) = real_speech_fixture();
        assert!(!fixture.is_empty(), "fixture must contain audio");

        let mut chunker = StreamingChunker::new(sample_rate, RING_BUFFER_SECONDS);

        // Capture cadence: `feed_audio` is driven from a 200ms poll loop.
        let feed_samples = (sample_rate as usize) / 5;
        // Decoder speed relative to real time. 0.6 is pessimistic for a local
        // base.en model on the machines this ships to, and still has to hold.
        let decode_real_time_factor = 0.6_f64;
        // A batch decode is not proportional to the span alone: whisper.cpp
        // pads anything under 1.1s up to 1.1s before running the beam search
        // (`asr/whisper.rs`), and pays a fixed cost per call for state creation
        // and the mel front end whatever the span. Modelling that is what makes
        // this test discriminate between chunk sizes rather than just measuring
        // a ratio.
        const WHISPER_MIN_DECODED_SECONDS: f64 = 1.1;
        const DECODE_FIXED_COST_SECONDS: f64 = 0.25;
        let decode_cost = |span_samples: usize| -> usize {
            let span_seconds = span_samples as f64 / sample_rate as f64;
            let decoded_seconds = span_seconds.max(WHISPER_MIN_DECODED_SECONDS);
            ((DECODE_FIXED_COST_SECONDS + decoded_seconds * decode_real_time_factor)
                * sample_rate as f64) as usize
        };

        // Virtual clock: audio arrives in real time, so the count of samples
        // fed so far *is* the wall-clock time elapsed, in samples.
        let mut clock = 0usize;
        let mut decoder_free_at = 0usize;
        let mut worst_lag_seconds: f64 = 0.0;
        let mut gaps = 0usize;
        let mut chunk_durations: Vec<f64> = Vec::new();

        while clock < fixture.len() {
            let batch_end = (clock + feed_samples).min(fixture.len());
            chunker.write(&fixture[clock..batch_end]);
            clock = batch_end;

            while clock >= decoder_free_at {
                match chunker.next_plan() {
                    ChunkPlan::Wait => break,
                    ChunkPlan::Gap { .. } => gaps += 1,
                    ChunkPlan::Decode(span) => {
                        // No stale reads: the attributed span must match the
                        // fixture byte for byte at those absolute indices.
                        let decode_start = span.end - span.samples.len();
                        assert_eq!(
                            &span.samples[..],
                            &fixture[decode_start..span.end],
                            "chunk [{}, {}) did not read back the audio it claims",
                            decode_start,
                            span.end
                        );

                        let chunk_len = span.end - span.start;
                        chunk_durations.push(chunk_len as f64 / sample_rate as f64);

                        // The decoder is occupied for the cost of this span,
                        // and the text becomes visible when it finishes.
                        let busy_until = decoder_free_at.max(clock) + decode_cost(chunk_len);
                        decoder_free_at = busy_until;
                        let visible_at = busy_until.max(clock);
                        worst_lag_seconds = worst_lag_seconds
                            .max(visible_at.saturating_sub(span.end) as f64 / sample_rate as f64);
                    }
                }
            }
        }

        assert_eq!(gaps, 0, "a 44s stream must never outrun a 5-minute ring");
        assert!(
            chunk_durations.len() >= 3,
            "expected several chunks over 44s, got {}",
            chunk_durations.len()
        );
        // Every chunk must buy more cursor than it costs to decode, or the
        // session cannot converge no matter how the lag bound is written.
        for duration in &chunk_durations {
            let span = (*duration * sample_rate as f64) as usize;
            assert!(
                *duration <= MAX_CHUNK_SECONDS + 0.001,
                "chunk of {duration:.2}s exceeded the maximum"
            );
            assert!(
                decode_cost(span) < span,
                "a {duration:.2}s chunk must decode in less than {duration:.2}s"
            );
        }

        // Conversational speech has pauses and the cutter has to actually find
        // them. Chunks all sitting exactly at the maximum would mean the VAD
        // gate never fired and every boundary was a forced mid-sentence cut --
        // which is what happened with the dictation auto-stop's 0.3s silence
        // hysteresis, longer than the pauses in this fixture.
        let forced = chunk_durations
            .iter()
            .filter(|duration| **duration >= MAX_CHUNK_SECONDS - 0.001)
            .count();
        assert_eq!(
            forced, 0,
            "every boundary was forced; the cutter found no pause in real speech \
             (chunk lengths {chunk_durations:?})"
        );

        // The same cost model applied to the previous design: each inference
        // bought 0.25s of cursor and cost 0.91s of wall clock, so the cursor
        // lost ground on every single chunk and the lag grew for as long as the
        // meeting ran. That is the shape of the bug, not a slow machine.
        let old_chunk = (sample_rate as f64 * 0.25) as usize;
        assert!(
            decode_cost(old_chunk) > old_chunk * 3,
            "the cost model must reproduce why 0.25s chunks fell progressively behind"
        );

        // The bound: one maximum chunk of buffering, plus one decode of it,
        // plus a poll interval.
        let bound =
            MAX_CHUNK_SECONDS * (1.0 + decode_real_time_factor) + DECODE_FIXED_COST_SECONDS + 0.2;
        assert!(
            worst_lag_seconds <= bound,
            "worst lag {worst_lag_seconds:.2}s exceeded the {bound:.2}s bound"
        );
    }

    /// The live consumer replaces its preview with `text` on every event, so a
    /// segment that carried only its own words made a three-minute meeting
    /// render as whatever was said in the last six seconds. Every event has to
    /// carry the meeting so far *and* the new words, so replacing and appending
    /// are both correct.
    #[tokio::test]
    async fn every_segment_carries_the_running_transcript_and_its_own_new_words() {
        let (session, mut results) = test_session();
        session.chunker.lock().await.write(&speech(seconds(30.0)));

        record_and_emit(
            &session,
            StreamingSegmentKind::Speech,
            "we should ship the parity push".to_string(),
            0,
            seconds(10.0),
            0.9,
            false,
        )
        .await;
        record_and_emit(
            &session,
            StreamingSegmentKind::Speech,
            "before Friday".to_string(),
            seconds(10.0),
            seconds(20.0),
            0.9,
            false,
        )
        .await;

        let first = results.recv().await.expect("first segment");
        assert_eq!(first.segment_text, "we should ship the parity push");
        assert_eq!(first.text, "we should ship the parity push");
        assert!(first.is_partial, "the transcript is still growing");
        assert!(!first.is_final);

        let second = results.recv().await.expect("second segment");
        assert_eq!(second.segment_text, "before Friday");
        assert_eq!(
            second.text, "we should ship the parity push before Friday",
            "a consumer that replaces its preview with `text` must see the whole \
             meeting so far, not just the newest few seconds"
        );
    }

    /// The same failure at its worst: a gap marker replacing the entire preview
    /// with "[215s not transcribed]" and losing everything already set down.
    #[tokio::test]
    async fn a_gap_marker_joins_the_running_transcript_instead_of_replacing_it() {
        let (session, mut results) = test_session();
        session.chunker.lock().await.write(&speech(seconds(30.0)));

        record_and_emit(
            &session,
            StreamingSegmentKind::Speech,
            "we should ship the parity push".to_string(),
            0,
            seconds(10.0),
            0.9,
            false,
        )
        .await;
        emit_gap(&session, seconds(10.0), seconds(25.0)).await;

        let _ = results.recv().await.expect("speech segment");
        let gap = results.recv().await.expect("gap segment");
        assert_eq!(gap.kind, StreamingSegmentKind::Gap);
        assert!(
            gap.segment_text.contains("not transcribed"),
            "gap segment text was {:?}",
            gap.segment_text
        );
        assert_eq!(
            gap.text,
            format!("we should ship the parity push {}", gap.segment_text),
            "the hole is reported in place, not instead of the transcript"
        );
    }

    /// Finalizing must not run a second decode pass on top of the one already
    /// in flight. Two passes interleave their transcript appends and let a
    /// speech segment arrive after the closing marker the UI treats as "the
    /// preview stopped here".
    #[tokio::test]
    async fn finalizing_waits_for_an_in_flight_decode_instead_of_racing_it() {
        let transcriber = Arc::new(StreamingTranscriber::new(Arc::new(
            crate::asr::AsrManager::new(),
        )));
        let (session_id, mut results) = transcriber
            .start_session(
                crate::asr::AsrProviderType::Whisper,
                SAMPLE_RATE,
                String::new(),
            )
            .await
            .expect("session starts");
        let session = transcriber
            .sessions
            .lock()
            .await
            .get(&session_id)
            .expect("session is registered")
            .session
            .clone();

        // Stand in for the decode task `feed_audio` spawns: it holds the decode
        // lock for as long as the provider is working, then appends its words.
        let decoding = Arc::clone(&session.decode_lock).lock_owned().await;

        let finalizing = tokio::spawn({
            let transcriber = Arc::clone(&transcriber);
            let session_id = session_id.clone();
            async move { transcriber.finalize_session(&session_id).await }
        });

        // Real elapsed time, because what is being tested is that a wall-clock
        // budget is no longer what decides this: past the 2s the previous fixed
        // wait allowed, and far short of what decoding a 10s chunk costs.
        tokio::time::sleep(std::time::Duration::from_millis(2_500)).await;
        assert!(
            !finalizing.is_finished(),
            "finalize ran while a decode still held the session"
        );
        assert!(
            results.try_recv().is_err(),
            "nothing may be emitted ahead of the in-flight decode's own segment"
        );

        record_and_emit(
            &session,
            StreamingSegmentKind::Speech,
            "the last thing anybody said".to_string(),
            0,
            seconds(10.0),
            0.9,
            false,
        )
        .await;
        drop(decoding);

        let transcript = finalizing
            .await
            .expect("finalize task")
            .expect("finalize succeeds");
        assert_eq!(transcript, "the last thing anybody said");

        let segment = results.recv().await.expect("in-flight segment");
        assert!(!segment.is_final);
        assert_eq!(segment.segment_text, "the last thing anybody said");

        let closing = results.recv().await.expect("closing marker");
        assert!(
            closing.is_final,
            "the closing marker must be last, not overtaken by a decode"
        );
        assert!(!closing.is_partial);
        assert_eq!(
            closing.text, "the last thing anybody said",
            "the closing marker reports the whole transcript, not the empty tail"
        );
        assert!(closing.segment_text.is_empty());
    }

    /// The tail is whatever is left when the user hits stop, however short --
    /// including audio shorter than one minimum chunk, which must not be lost.
    #[test]
    fn finalizing_takes_the_short_tail() {
        let mut chunker = StreamingChunker::new(SAMPLE_RATE, 60);
        chunker.write(&speech(seconds(2.0)));

        assert!(
            matches!(chunker.next_plan(), ChunkPlan::Wait),
            "two seconds is below the minimum chunk"
        );

        let tail = chunker.take_tail().expect("tail must be decodable");
        assert_eq!(tail.start, 0);
        assert_eq!(tail.end, seconds(2.0));
        assert_eq!(tail.samples.len(), seconds(2.0));
        assert!(chunker.take_tail().is_none(), "tail is taken exactly once");
    }
}
