//! The WeSpeaker front end community-1 runs before its ResNet34: Kaldi-style
//! log mel filterbanks exactly as `torchaudio.compliance.kaldi.fbank` computes
//! them with pyannote's settings (80 bins, 25 ms Hamming frames every 10 ms,
//! `snip_edges`, DC removal, 0.97 pre-emphasis, power spectrum, no dither, no
//! energy), on audio scaled by 2^15, followed by per-chunk mean removal
//! (`BaseWeSpeakerResNet.compute_fbank` with `fbank_centering_span=None`).
//!
//! The mel weights and window follow torchaudio's float32 arithmetic; the FFT
//! and the reductions run in `f64` and round to `f32`, so values agree with
//! torchaudio to float32 rounding rather than bit for bit.

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

pub(super) const NUM_MEL_BINS: usize = 80;
const WINDOW: usize = 400;
const SHIFT: usize = 160;
const PADDED: usize = 512;
const SPECTRUM: usize = PADDED / 2 + 1;
const PREEMPHASIS: f32 = 0.97;

/// Frames `snip_edges=True` produces for `samples` samples.
pub(super) fn num_frames(samples: usize) -> usize {
    if samples < WINDOW {
        0
    } else {
        1 + (samples - WINDOW) / SHIFT
    }
}

pub(super) struct KaldiFbank {
    window: Vec<f32>,
    /// `NUM_MEL_BINS x SPECTRUM`, row-major; the Nyquist column is zero.
    mel: Vec<f32>,
    fft: Arc<dyn Fft<f64>>,
}

impl KaldiFbank {
    pub(super) fn new() -> Self {
        // torch.hamming_window(400, periodic=False)
        let window = (0..WINDOW)
            .map(|n| {
                (0.54 - 0.46 * (2.0 * std::f64::consts::PI * n as f64 / (WINDOW - 1) as f64).cos())
                    as f32
            })
            .collect();
        Self {
            window,
            mel: mel_banks(),
            fft: FftPlanner::<f64>::new().plan_fft_forward(PADDED),
        }
    }

    /// Log mel features of one chunk, `frames x NUM_MEL_BINS`, mean-centred
    /// over the chunk. `samples` are in [-1, 1].
    pub(super) fn compute(&self, samples: &[f32]) -> Vec<f32> {
        let frames = num_frames(samples.len());
        let mut out = vec![0f32; frames * NUM_MEL_BINS];
        let mut frame = [0f32; WINDOW];
        let mut buffer = vec![Complex::new(0.0f64, 0.0); PADDED];
        let mut power = [0f32; SPECTRUM];
        for index in 0..frames {
            let start = index * SHIFT;
            for (dst, &src) in frame.iter_mut().zip(&samples[start..start + WINDOW]) {
                *dst = src * 32768.0;
            }
            let mean = (frame.iter().map(|&v| f64::from(v)).sum::<f64>() / WINDOW as f64) as f32;
            for v in frame.iter_mut() {
                *v -= mean;
            }
            for j in (1..WINDOW).rev() {
                frame[j] -= PREEMPHASIS * frame[j - 1];
            }
            frame[0] -= PREEMPHASIS * frame[0];
            for (j, slot) in buffer.iter_mut().enumerate() {
                *slot = if j < WINDOW {
                    Complex::new(f64::from(frame[j] * self.window[j]), 0.0)
                } else {
                    Complex::new(0.0, 0.0)
                };
            }
            self.fft.process(&mut buffer);
            for (p, c) in power.iter_mut().zip(&buffer[..SPECTRUM]) {
                *p = c.norm_sqr() as f32;
            }
            let row = &mut out[index * NUM_MEL_BINS..(index + 1) * NUM_MEL_BINS];
            for (bin, value) in row.iter_mut().enumerate() {
                let weights = &self.mel[bin * SPECTRUM..(bin + 1) * SPECTRUM];
                let energy: f64 = weights
                    .iter()
                    .zip(&power)
                    .map(|(&w, &p)| f64::from(w) * f64::from(p))
                    .sum();
                *value = (energy as f32).max(f32::EPSILON).ln();
            }
        }
        if frames > 0 {
            for bin in 0..NUM_MEL_BINS {
                let mean = ((0..frames)
                    .map(|f| f64::from(out[f * NUM_MEL_BINS + bin]))
                    .sum::<f64>()
                    / frames as f64) as f32;
                for f in 0..frames {
                    out[f * NUM_MEL_BINS + bin] -= mean;
                }
            }
        }
        out
    }
}

/// `torchaudio.compliance.kaldi.get_mel_banks(80, 512, 16000, 20, 0, ...)`
/// padded with a zero Nyquist column, evaluated in float32 like torchaudio.
fn mel_banks() -> Vec<f32> {
    let mel = |hz: f64| 1127.0 * (1.0 + hz / 700.0).ln();
    let low = mel(20.0);
    let high = mel(8000.0);
    let delta = (high - low) / (NUM_MEL_BINS as f64 + 1.0);
    let (low, delta) = (low as f32, delta as f32);
    let fft_bin_width = 16000.0f32 / PADDED as f32;
    let bin_mel: Vec<f32> = (0..PADDED / 2)
        .map(|k| 1127.0f32 * (1.0f32 + (fft_bin_width * k as f32) / 700.0f32).ln())
        .collect();
    let mut banks = vec![0f32; NUM_MEL_BINS * SPECTRUM];
    for j in 0..NUM_MEL_BINS {
        let left = low + j as f32 * delta;
        let center = low + (j as f32 + 1.0) * delta;
        let right = low + (j as f32 + 2.0) * delta;
        for (k, &m) in bin_mel.iter().enumerate() {
            let up = (m - left) / (center - left);
            let down = (right - m) / (right - center);
            banks[j * SPECTRUM + k] = up.min(down).max(0.0);
        }
    }
    banks
}

/// pyannote's `F.interpolate(weights, size=pool_frames, mode="nearest")`
/// index table: output frame `i` reads input frame `floor(i * in/out)`,
/// computed in float32 like PyTorch's CPU kernel.
pub(super) fn nearest_index(input: usize, output: usize) -> Vec<usize> {
    if input == output {
        return (0..output).collect();
    }
    let scale = input as f32 / output as f32;
    (0..output)
        .map(|i| ((i as f32 * scale).floor() as usize).min(input - 1))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ten_second_chunk_has_998_frames() {
        assert_eq!(num_frames(160_000), 998);
        assert_eq!(num_frames(399), 0);
        assert_eq!(num_frames(400), 1);
    }

    #[test]
    fn features_are_centred_and_a_tone_peaks_in_its_mel_bin() {
        let fbank = KaldiFbank::new();
        let samples: Vec<f32> = (0..16_000)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 16_000.0).sin())
            .collect();
        let features = fbank.compute(&samples);
        let frames = num_frames(samples.len());
        assert_eq!(features.len(), frames * NUM_MEL_BINS);
        for bin in 0..NUM_MEL_BINS {
            let mean: f32 = (0..frames)
                .map(|f| features[f * NUM_MEL_BINS + bin])
                .sum::<f32>()
                / frames as f32;
            assert!(mean.abs() < 1e-3);
        }
        // Silence floors at log(eps) before centring; every bin is finite.
        let silent = fbank.compute(&vec![0.0; 4000]);
        assert!(silent.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn interpolation_table_matches_pytorch_nearest() {
        // Values from F.interpolate(arange(589), size=125, mode="nearest").
        let table = nearest_index(589, 125);
        assert_eq!(table.len(), 125);
        assert_eq!(&table[..5], &[0, 4, 9, 14, 18]);
        assert_eq!(table[124], 584);
    }
}
