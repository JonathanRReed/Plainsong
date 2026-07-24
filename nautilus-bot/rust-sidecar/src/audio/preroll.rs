//! Pre-roll: the last couple of seconds of microphone audio, kept so a
//! dictation session can start with the words the user already said.
//!
//! The hands-free idle monitor (`AudioCapture::start_hands_free_monitor`)
//! downmixes every frame it receives purely to decide whether speech started,
//! and then throws the samples away. By the time it has the
//! `DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS` of sustained speech it needs, has
//! round-tripped a `hands_free_start` signal through Electron, and a fresh
//! capture stream has opened, roughly a second of the user's opening words has
//! already been spoken into a buffer nobody kept. This ring keeps them.
//!
//! It is deliberately small, fixed-size, and only ever written while the
//! monitor the user opted into is actually running — it is not a background
//! recording, and `clear` zeroes the storage rather than just resetting the
//! indices.

use std::time::Instant;

/// How much audio the ring keeps. The monitor needs ~0.5s of sustained speech
/// before it signals and the signal then round-trips through Electron, so two
/// seconds covers the gap with margin without holding meaningful history.
pub const PRE_ROLL_SECONDS: f32 = 2.0;

/// A pre-roll older than this is never handed to a session: splicing audio from
/// a monitor that stopped a while ago onto the front of a new dictation would
/// put words the user did not just say into their transcript.
pub const PRE_ROLL_MAX_AGE_MS: u128 = 2_500;

/// How much audio is kept *ahead* of a marked speech onset. The gate only
/// latches once speech has been sustained for
/// `DICTATION_AUTO_STOP_MIN_SPEECH_SECONDS`, and the level has to climb before
/// that window even opens, so a little lead-in keeps the first consonant rather
/// than clipping it.
pub const PRE_ROLL_SPEECH_LEAD_SECONDS: f32 = 0.25;

/// Fixed-size ring of mono samples, oldest-first on read.
pub struct PreRollBuffer {
    samples: Vec<f32>,
    /// Index the next sample is written to.
    write: usize,
    /// How many of `samples` currently hold real audio (< capacity until the
    /// ring has wrapped once).
    filled: usize,
    /// Total samples ever pushed. This is the absolute index space
    /// `speech_onset` lives in, so a mark survives the writes that keep
    /// arriving between the VAD edge and the session actually opening.
    written: u64,
    /// Absolute index of the most recently marked speech onset, if any.
    speech_onset: Option<u64>,
    sample_rate: u32,
    last_write: Option<Instant>,
}

impl PreRollBuffer {
    pub fn new(sample_rate: u32, seconds: f32) -> Self {
        let capacity = ((sample_rate as f32) * seconds.max(0.0)).round().max(0.0) as usize;
        Self {
            samples: vec![0.0; capacity],
            write: 0,
            filled: 0,
            written: 0,
            speech_onset: None,
            sample_rate,
            last_write: None,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn len(&self) -> usize {
        self.filled
    }

    pub fn is_empty(&self) -> bool {
        self.filled == 0
    }

    /// Milliseconds since the most recent sample was written, or `None` if the
    /// ring has never been written to (or was cleared).
    pub fn age_ms(&self) -> Option<u128> {
        self.last_write.map(|at| at.elapsed().as_millis())
    }

    /// Append mono samples, overwriting the oldest audio once full. A chunk
    /// longer than the ring keeps only its newest `capacity` samples rather
    /// than writing samples it is about to overwrite.
    pub fn push(&mut self, mono: &[f32]) {
        let capacity = self.samples.len();
        if capacity == 0 || mono.is_empty() {
            return;
        }

        let start = mono.len().saturating_sub(capacity);
        for &sample in &mono[start..] {
            self.samples[self.write] = sample;
            self.write = (self.write + 1) % capacity;
            if self.filled < capacity {
                self.filled += 1;
            }
        }
        self.written = self.written.saturating_add(mono.len() as u64);
        self.last_write = Some(Instant::now());
    }

    /// Record that speech began `samples_before_end` samples before the most
    /// recent write.
    ///
    /// Called when the monitor's VAD gate reports `SpeechStarted`, which it only
    /// does after speech has already been sustained for a while — so without
    /// this the hand-off would be the whole ring, i.e. seconds of whatever the
    /// user happened to be saying (or a colleague was) before they meant to
    /// start dictating.
    ///
    /// The latest mark wins: it belongs to the edge that is about to trigger a
    /// session, whereas an older one belongs to a burst nothing acted on.
    pub fn mark_speech_onset(&mut self, samples_before_end: usize) {
        self.speech_onset = Some(self.written.saturating_sub(samples_before_end as u64));
    }

    /// Drain the ring and reset it, oldest-first from the marked speech onset
    /// (or from the oldest retained sample when nothing was marked, or when the
    /// mark has already aged out of the ring).
    ///
    /// This is the hand-off to a dictation session: the samples become the head
    /// of that session's capture, so they must never be returned twice.
    pub fn take(&mut self) -> Vec<f32> {
        let capacity = self.samples.len();
        if capacity == 0 || self.filled == 0 {
            self.clear();
            return Vec::new();
        }

        let oldest_retained = self.written.saturating_sub(self.filled as u64);
        let from = self
            .speech_onset
            .map(|onset| onset.max(oldest_retained))
            .unwrap_or(oldest_retained);
        let skip = (from - oldest_retained) as usize;
        let start = (self.write + capacity - self.filled + skip) % capacity;
        let keep = self.filled - skip;

        let mut drained = Vec::with_capacity(keep);
        for offset in 0..keep {
            drained.push(self.samples[(start + offset) % capacity]);
        }
        self.clear();
        drained
    }

    /// Drop everything, zeroing the backing storage so no captured audio is
    /// left resident once the monitor that produced it is gone.
    pub fn clear(&mut self) {
        self.samples.fill(0.0);
        self.write = 0;
        self.filled = 0;
        self.written = 0;
        self.speech_onset = None;
        self.last_write = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_samples_oldest_first_before_it_wraps() {
        let mut ring = PreRollBuffer::new(8, 1.0);
        ring.push(&[0.1, 0.2, 0.3]);

        assert_eq!(ring.len(), 3);
        assert_eq!(ring.take(), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn keeps_only_the_newest_samples_once_it_wraps() {
        // Capacity 4 (4 Hz * 1s). Pushing six samples must keep the last four,
        // still oldest-first — this is the case that decides whether the user's
        // most recent words or their oldest ones reach the transcript.
        let mut ring = PreRollBuffer::new(4, 1.0);
        ring.push(&[1.0, 2.0]);
        ring.push(&[3.0, 4.0, 5.0, 6.0]);

        assert_eq!(ring.len(), 4);
        assert_eq!(ring.take(), vec![3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn a_chunk_longer_than_the_ring_keeps_its_tail() {
        let mut ring = PreRollBuffer::new(4, 1.0);
        ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);

        assert_eq!(ring.take(), vec![6.0, 7.0, 8.0, 9.0]);
    }

    #[test]
    fn many_small_pushes_across_the_boundary_stay_in_order() {
        let mut ring = PreRollBuffer::new(5, 1.0);
        for index in 0..13 {
            ring.push(&[index as f32]);
        }

        assert_eq!(ring.take(), vec![8.0, 9.0, 10.0, 11.0, 12.0]);
    }

    #[test]
    fn take_hands_off_once_and_leaves_nothing_behind() {
        let mut ring = PreRollBuffer::new(4, 1.0);
        ring.push(&[1.0, 2.0, 3.0]);

        assert_eq!(ring.take(), vec![1.0, 2.0, 3.0]);
        // A second session must not be seeded with the first session's audio.
        assert!(ring.take().is_empty());
        assert!(ring.is_empty());
        assert_eq!(ring.age_ms(), None);
    }

    #[test]
    fn tracks_write_age_so_a_stale_ring_can_be_rejected() {
        let mut ring = PreRollBuffer::new(4, 1.0);
        assert_eq!(ring.age_ms(), None);

        ring.push(&[1.0]);
        assert!(ring.age_ms().is_some_and(|age| age < PRE_ROLL_MAX_AGE_MS));

        ring.clear();
        assert_eq!(ring.age_ms(), None);
        assert!(ring.is_empty());
    }

    /// Without a mark the hand-off is the whole two-second window, i.e. up to
    /// ~1.5s of whatever preceded the user's first word gets prepended to their
    /// transcript. The mark is what makes the pre-roll "the opening words"
    /// rather than "the last two seconds of the room".
    #[test]
    fn a_marked_onset_trims_the_audio_that_preceded_speech() {
        let mut ring = PreRollBuffer::new(8, 1.0);
        ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        // The gate latched two samples ago.
        ring.mark_speech_onset(2);

        assert_eq!(ring.take(), vec![5.0, 6.0]);
    }

    #[test]
    fn frames_arriving_after_the_mark_are_still_handed_over() {
        // The gate fires, then the signal round-trips through Electron while
        // the user keeps talking; those samples must reach the session too.
        let mut ring = PreRollBuffer::new(8, 1.0);
        ring.push(&[1.0, 2.0, 3.0, 4.0]);
        ring.mark_speech_onset(2);
        ring.push(&[5.0, 6.0]);

        assert_eq!(ring.take(), vec![3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn the_latest_onset_wins_and_a_take_clears_it() {
        let mut ring = PreRollBuffer::new(8, 1.0);
        ring.push(&[1.0, 2.0, 3.0, 4.0]);
        ring.mark_speech_onset(4);
        ring.push(&[5.0, 6.0]);
        // A second burst: this is the edge whose signal starts the session.
        ring.mark_speech_onset(1);

        assert_eq!(ring.take(), vec![6.0]);

        // The next session must not inherit the previous one's mark.
        ring.push(&[7.0, 8.0]);
        assert_eq!(ring.take(), vec![7.0, 8.0]);
    }

    #[test]
    fn an_onset_that_aged_out_of_the_ring_falls_back_to_what_is_left() {
        let mut ring = PreRollBuffer::new(4, 1.0);
        ring.push(&[1.0, 2.0]);
        ring.mark_speech_onset(2);
        // The signal was never acted on and the ring wrapped past the mark.
        ring.push(&[3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);

        assert_eq!(ring.take(), vec![5.0, 6.0, 7.0, 8.0]);
    }

    #[test]
    fn an_onset_further_back_than_the_ring_holds_is_clamped_not_underflowed() {
        let mut ring = PreRollBuffer::new(4, 1.0);
        ring.push(&[1.0, 2.0]);
        ring.mark_speech_onset(usize::MAX);

        assert_eq!(ring.take(), vec![1.0, 2.0]);
    }

    #[test]
    fn a_zero_length_ring_is_inert_rather_than_panicking() {
        // `PreRollBuffer::new` derives capacity from the device sample rate,
        // which a misbehaving device can report as 0.
        let mut ring = PreRollBuffer::new(0, PRE_ROLL_SECONDS);
        ring.push(&[1.0, 2.0, 3.0]);

        assert!(ring.is_empty());
        assert!(ring.take().is_empty());
    }
}
