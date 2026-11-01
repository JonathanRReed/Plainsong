//! In-memory activity evidence for recovering an uncovered, measured word.
//! Does not create turns, infer timestamps, or introduce speaker identities.

#[derive(Debug, Clone)]
pub struct SpeakerActivity {
    probabilities: Vec<[f32; 8]>,
    speaker_ids: [Option<String>; 8],
    duration_seconds: f64,
}

impl SpeakerActivity {
    #[cfg(any(test, feature = "diarization-nemotron"))]
    pub(crate) fn new(
        probabilities: Vec<[f32; 8]>,
        speaker_ids: [Option<String>; 8],
        duration_seconds: f64,
    ) -> Self {
        Self {
            probabilities,
            speaker_ids,
            duration_seconds,
        }
    }

    /// Only used after an explicit measured-word timing check and an uncovered
    /// midpoint. The interval and identity remain those of the original data.
    pub(crate) fn recover(&self, start: f64, end: f64) -> Option<&str> {
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end <= start
            || end - start > 2.0
            || !self.duration_seconds.is_finite()
            || end > self.duration_seconds
        {
            return None;
        }
        let from = (start * 100.0).ceil() as usize;
        let to = (end * 100.0).ceil() as usize;
        let frames = self.probabilities.get(from..to)?;
        if frames.is_empty() {
            return None;
        }
        let mut means = [0.0_f64; 8];
        for frame in frames {
            for (slot, &value) in frame.iter().enumerate() {
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    return None;
                }
                means[slot] += f64::from(value);
            }
        }
        for value in &mut means {
            *value /= frames.len() as f64;
        }
        let mut order = [0, 1, 2, 3, 4, 5, 6, 7];
        order.sort_by(|&a, &b| means[b].total_cmp(&means[a]));
        // Public-meeting qualification receipt. No global activity or
        // voiceprint threshold is changed by these recovery-only bounds.
        if means[order[0]] < 0.40 || means[order[0]] - means[order[1]] < 0.10 {
            return None;
        }
        self.speaker_ids[order[0]].as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn activity(frames: Vec<[f32; 8]>) -> SpeakerActivity {
        SpeakerActivity::new(
            frames,
            std::array::from_fn(|i| Some(format!("S{}", i + 1))),
            1.0,
        )
    }
    #[test]
    fn word_activity_uses_the_whole_word_without_changing_its_identity() {
        let mut frames = vec![[0.0; 8]; 100];
        for (i, frame) in frames.iter_mut().enumerate().take(40) {
            frame[2] = if i == 20 { 0.0 } else { 0.8 };
            frame[0] = 0.1;
        }
        assert_eq!(activity(frames).recover(0.0, 0.4), Some("S3"));
    }
    #[test]
    fn word_activity_refuses_silence_ties_invalid_intervals_and_unmapped_slots() {
        assert_eq!(activity(vec![[0.0; 8]; 100]).recover(0.0, 0.4), None);
        let mut tied = [0.0; 8];
        tied[0] = 0.8;
        tied[1] = 0.75;
        assert_eq!(activity(vec![tied; 100]).recover(0.0, 0.4), None);
        let mut frame = [0.0; 8];
        frame[7] = 0.9;
        let mut evidence = activity(vec![frame; 100]);
        evidence.speaker_ids[7] = None;
        assert_eq!(evidence.recover(0.0, 0.4), None);
        for (start, end) in [(f64::NAN, 0.4), (-0.1, 0.4), (0.4, 0.4), (0.5, 1.1)] {
            assert_eq!(evidence.recover(start, end), None);
        }
        let mut invalid = [0.0; 8];
        invalid[0] = f32::NAN;
        assert_eq!(activity(vec![invalid; 100]).recover(0.0, 0.4), None);
    }
}
