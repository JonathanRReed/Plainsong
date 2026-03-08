//! Voice Activity Detection (VAD) for automatic speech segmentation
//!
//! Uses energy-based detection with adaptive thresholds
//! to identify speech vs silence segments.
#![allow(dead_code)]

/// VAD configuration
#[derive(Debug, Clone)]
pub struct VadConfig {
    /// Frame size in samples (typically 10-30ms)
    pub frame_size: usize,
    /// Sample rate
    pub sample_rate: u32,
    /// Energy threshold for speech (adaptive if None)
    pub threshold_db: Option<f32>,
    /// Minimum speech duration in seconds
    pub min_speech_duration: f32,
    /// Minimum silence duration to split segments
    pub min_silence_duration: f32,
    /// Padding at start/end of segments in seconds
    pub padding_seconds: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            frame_size: 480, // 30ms at 16kHz
            sample_rate: 16000,
            threshold_db: None, // Auto-detect
            min_speech_duration: 0.5,
            min_silence_duration: 0.3,
            padding_seconds: 0.1,
        }
    }
}

/// A detected speech segment
#[derive(Debug, Clone)]
pub struct SpeechSegment {
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Average energy in dB
    pub avg_energy_db: f32,
    /// Confidence (0.0-1.0)
    pub confidence: f32,
}

/// Voice Activity Detector
pub struct VoiceActivityDetector {
    config: VadConfig,
    /// Running energy history for adaptive threshold
    energy_history: Vec<f32>,
    /// Current adaptive threshold
    adaptive_threshold: f32,
}

impl VoiceActivityDetector {
    pub fn new(config: VadConfig) -> Self {
        Self {
            config,
            energy_history: Vec::with_capacity(1000),
            adaptive_threshold: -40.0, // Default -40dB
        }
    }

    /// Process audio and detect speech segments
    pub fn detect_speech(&mut self, samples: &[f32]) -> Vec<SpeechSegment> {
        let frame_size = self.config.frame_size;
        let sample_rate = self.config.sample_rate as f32;

        // Calculate frame energies
        let mut frames: Vec<(usize, f32)> = Vec::new();
        for (i, chunk) in samples.chunks(frame_size).enumerate() {
            let energy = calculate_energy_db(chunk);
            frames.push((i, energy));

            // Update adaptive threshold
            self.energy_history.push(energy);
            if self.energy_history.len() > 1000 {
                self.energy_history.remove(0);
            }
        }

        // Update adaptive threshold based on energy history
        if self.config.threshold_db.is_none() && !self.energy_history.is_empty() {
            let noise_floor = percentile(&self.energy_history, 0.1);
            self.adaptive_threshold = noise_floor + 15.0; // 15dB above noise floor
        } else if let Some(threshold) = self.config.threshold_db {
            self.adaptive_threshold = threshold;
        }

        // Find speech segments
        let threshold = self.adaptive_threshold;
        let min_speech_frames =
            (self.config.min_speech_duration * sample_rate / frame_size as f32).ceil() as usize;
        let min_silence_frames =
            (self.config.min_silence_duration * sample_rate / frame_size as f32).ceil() as usize;
        let padding_frames =
            (self.config.padding_seconds * sample_rate / frame_size as f32).ceil() as usize;

        let mut segments = Vec::new();
        let mut in_speech = false;
        let mut speech_start = 0;
        let mut silence_count = 0;
        let mut segment_energies = Vec::new();

        for (i, energy) in frames.iter() {
            if *energy > threshold {
                if !in_speech {
                    // Start of speech
                    in_speech = true;
                    speech_start = i.saturating_sub(padding_frames);
                    segment_energies.clear();
                }
                segment_energies.push(*energy);
                silence_count = 0;
            } else if in_speech {
                silence_count += 1;
                if silence_count >= min_silence_frames {
                    // End of speech
                    let speech_end = (i - silence_count + 1 + padding_frames).min(frames.len() - 1);
                    let speech_duration = speech_end.saturating_sub(speech_start);

                    if speech_duration >= min_speech_frames {
                        let avg_energy = if !segment_energies.is_empty() {
                            segment_energies.iter().sum::<f32>() / segment_energies.len() as f32
                        } else {
                            threshold
                        };

                        segments.push(SpeechSegment {
                            start: speech_start as f64 * frame_size as f64 / sample_rate as f64,
                            end: speech_end as f64 * frame_size as f64 / sample_rate as f64,
                            avg_energy_db: avg_energy,
                            confidence: ((avg_energy - threshold) / 20.0).clamp(0.0, 1.0),
                        });
                    }

                    in_speech = false;
                    segment_energies.clear();
                }
            }
        }

        // Handle trailing speech
        if in_speech {
            let speech_end = frames.len() - 1;
            let speech_duration = speech_end.saturating_sub(speech_start);

            if speech_duration >= min_speech_frames {
                let avg_energy = if !segment_energies.is_empty() {
                    segment_energies.iter().sum::<f32>() / segment_energies.len() as f32
                } else {
                    threshold
                };

                segments.push(SpeechSegment {
                    start: speech_start as f64 * frame_size as f64 / sample_rate as f64,
                    end: speech_end as f64 * frame_size as f64 / sample_rate as f64,
                    avg_energy_db: avg_energy,
                    confidence: ((avg_energy - threshold) / 20.0).clamp(0.0, 1.0),
                });
            }
        }

        segments
    }

    /// Get current adaptive threshold
    pub fn current_threshold(&self) -> f32 {
        self.adaptive_threshold
    }

    /// Reset adaptive threshold
    pub fn reset(&mut self) {
        self.energy_history.clear();
        self.adaptive_threshold = -40.0;
    }
}

/// Calculate energy in dB for a frame
fn calculate_energy_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -100.0;
    }

    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / samples.len() as f32).sqrt();

    if rms < 1e-10 {
        -100.0
    } else {
        20.0 * rms.log10()
    }
}

/// Calculate percentile of a slice
fn percentile(data: &[f32], p: f32) -> f32 {
    if data.is_empty() {
        return -100.0;
    }

    let mut sorted = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let index = ((sorted.len() - 1) as f32 * p) as usize;
    sorted[index.min(sorted.len() - 1)]
}

/// Pre-process audio with VAD to trim silence
pub fn trim_silence(samples: &[f32], sample_rate: u32, threshold_db: f32) -> Vec<f32> {
    let mut vad = VoiceActivityDetector::new(VadConfig {
        sample_rate,
        threshold_db: Some(threshold_db),
        min_speech_duration: 0.1, // Very short for trimming
        min_silence_duration: 0.05,
        padding_seconds: 0.05,
        ..Default::default()
    });

    let segments = vad.detect_speech(samples);

    if segments.is_empty() {
        return samples.to_vec();
    }

    let Some(first_segment) = segments.first() else {
        return samples.to_vec();
    };
    let Some(last_segment) = segments.last() else {
        return samples.to_vec();
    };

    let start_sample = ((first_segment.start * sample_rate as f64).floor() as usize).min(samples.len());
    let end_sample = ((last_segment.end * sample_rate as f64).ceil() as usize).min(samples.len());

    if end_sample <= start_sample {
        return samples.to_vec();
    }

    let retained_len = end_sample.saturating_sub(start_sample);
    if retained_len == 0 {
        return samples.to_vec();
    }

    let original_len = samples.len().max(1);
    let kept_ratio = retained_len as f32 / original_len as f32;
    let leading_trim_seconds = start_sample as f32 / sample_rate as f32;
    let trailing_trim_seconds =
        (samples.len().saturating_sub(end_sample)) as f32 / sample_rate as f32;

    // If VAD wants to throw away a large chunk from the front, it likely missed a quiet
    // opening speaker. In that case keep the original audio instead of being destructive.
    if leading_trim_seconds > 0.75
        && leading_trim_seconds > (trailing_trim_seconds * 2.0)
        && kept_ratio < 0.8
    {
        return samples.to_vec();
    }

    samples[start_sample..end_sample].to_vec()
}

/// Split audio into speech chunks based on silence
pub fn split_on_silence(
    samples: &[f32],
    sample_rate: u32,
    min_chunk_duration: f32,
    silence_threshold_db: f32,
) -> Vec<Vec<f32>> {
    let mut vad = VoiceActivityDetector::new(VadConfig {
        sample_rate,
        threshold_db: Some(silence_threshold_db),
        min_speech_duration: min_chunk_duration,
        min_silence_duration: 0.5, // Split on 0.5s silence
        padding_seconds: 0.1,
        ..Default::default()
    });

    let segments = vad.detect_speech(samples);

    segments
        .into_iter()
        .filter_map(|segment| {
            let start_sample = (segment.start * sample_rate as f64) as usize;
            let end_sample = (segment.end * sample_rate as f64) as usize;

            if end_sample > start_sample && end_sample <= samples.len() {
                Some(samples[start_sample..end_sample].to_vec())
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::trim_silence;

    fn repeated_sample(amplitude: f32, sample_rate: u32, seconds: usize) -> Vec<f32> {
        vec![amplitude; sample_rate as usize * seconds]
    }

    #[test]
    fn trim_silence_keeps_quiet_opening_when_vad_would_trim_too_much() {
        let sample_rate = 16_000;
        let mut samples = repeated_sample(0.003, sample_rate, 6);
        samples.extend(repeated_sample(0.05, sample_rate, 4));

        let trimmed = trim_silence(&samples, sample_rate, -40.0);

        assert_eq!(trimmed.len(), samples.len());
    }

    #[test]
    fn trim_silence_still_removes_clear_leading_and_trailing_dead_air() {
        let sample_rate = 16_000;
        let mut samples = repeated_sample(0.0, sample_rate, 1);
        samples.extend(repeated_sample(0.06, sample_rate, 2));
        samples.extend(repeated_sample(0.0, sample_rate, 1));

        let trimmed = trim_silence(&samples, sample_rate, -40.0);

        assert!(trimmed.len() < samples.len());
        assert!(trimmed.len() > sample_rate as usize);
    }
}
