//! Mel-spectrogram extraction for ASR preprocessing.
//!
//! Implements a power-of-two Cooley-Tukey FFT → mel filterbank pipeline
//! compatible with NVIDIA NeMo / HuggingFace ASR models.
//!
//! Default parameters match Parakeet TDT 0.6B:
//!   n_fft=512, hop_length=160, win_length=400, n_mels=80, sr=16000

use std::f32::consts::PI;

/// Mel-spectrogram extractor
pub struct MelSpectrogram {
    n_fft: usize,
    hop_length: usize,
    win_length: usize,
    n_mels: usize,
    window: Vec<f32>,
    mel_filters: Vec<Vec<f32>>,
    log_offset: f32,
    /// true = natural log (NeMo/Parakeet/Moonshine), false = log10 (Whisper)
    log_base_e: bool,
}

impl MelSpectrogram {
    /// Create with NeMo/Parakeet TDT 0.6B defaults.
    /// Uses natural log (ln) and 1e-5 offset as per NeMo preprocessing.
    /// Mel filterbank: low_freq=20, high_freq=Nyquist-400 (matches sherpa-onnx).
    pub fn parakeet_defaults() -> Self {
        let sample_rate = 16000u32;
        let high_freq = sample_rate as f32 / 2.0 - 400.0; // Nyquist - 400 Hz (sherpa-onnx convention)
        let mut mel = Self::new(512, 160, 400, 80, sample_rate).with_nemo_log();
        // Override mel filters with correct low/high freq
        mel.mel_filters = compute_mel_filters(80, 512, sample_rate, 20.0, high_freq);
        mel
    }

    /// Switch to natural-log mode (NeMo/Parakeet/Moonshine style).
    pub fn with_nemo_log(mut self) -> Self {
        self.log_base_e = true;
        self.log_offset = 1e-5;
        self
    }

    pub fn new(
        n_fft: usize,
        hop_length: usize,
        win_length: usize,
        n_mels: usize,
        sample_rate: u32,
    ) -> Self {
        let window = hann_window(win_length);
        let mel_filters =
            compute_mel_filters(n_mels, n_fft, sample_rate, 0.0, sample_rate as f32 / 2.0);
        Self {
            n_fft,
            hop_length,
            win_length,
            n_mels,
            window,
            mel_filters,
            log_offset: 1e-6,
            log_base_e: false,
        }
    }

    /// Compute mel spectrogram.
    ///
    /// Returns shape `[n_mels][n_frames]`, matching NeMo `processed_signal` after transposing to [n_mels, T].
    /// Uses snip_edges=False style frame calculation (centered frames, matches sherpa-onnx).
    pub fn compute(&self, samples: &[f32]) -> Vec<Vec<f32>> {
        // snip_edges=False: frames are centered, not snipped at edges
        // This matches sherpa-onnx/NeMo behavior
        let n_frames = if samples.len() >= self.hop_length {
            1 + (samples.len() - 1) / self.hop_length
        } else {
            1
        };

        if samples.is_empty() {
            return vec![vec![]; self.n_mels];
        }

        let n_bins = self.n_fft / 2 + 1;
        let mut power_frames: Vec<Vec<f32>> = Vec::with_capacity(n_frames);

        for frame_idx in 0..n_frames {
            // Center the frame: start at frame_idx * hop_length - n_fft/2
            let center = frame_idx * self.hop_length;
            let start = center.saturating_sub(self.n_fft / 2);
            let frame_end = (center + self.n_fft / 2 + 1).min(samples.len());

            let mut frame = vec![0.0f32; self.n_fft];
            let offset = self.n_fft / 2 - (center - start);
            let actual_len = (frame_end - start).min(self.win_length);

            for i in 0..actual_len {
                if offset + i < self.n_fft && offset + i < self.win_length {
                    frame[offset + i] = samples[start + i] * self.window[offset + i];
                }
            }

            let spectrum = rfft(&frame);
            let power: Vec<f32> = spectrum[..n_bins]
                .iter()
                .map(|(re, im)| re * re + im * im)
                .collect();
            power_frames.push(power);
        }

        // Apply mel filterbank per frame → [n_mels][n_frames]
        let mut mel_spec = vec![Vec::with_capacity(n_frames); self.n_mels];
        for frame in &power_frames {
            for (mel_idx, filter) in self.mel_filters.iter().enumerate() {
                let energy: f32 = filter.iter().zip(frame.iter()).map(|(w, p)| w * p).sum();
                let log_val = if self.log_base_e {
                    (energy + self.log_offset).ln()
                } else {
                    (energy + self.log_offset).log10()
                };
                mel_spec[mel_idx].push(log_val);
            }
        }

        mel_spec
    }

    /// Compute mel spectrogram with per-feature normalization (sherpa-onnx/NeMo style).
    /// Normalizes each mel band by its mean and stddev across all frames.
    pub fn compute_normalized(&self, samples: &[f32]) -> Vec<Vec<f32>> {
        let mel_spec = self.compute(samples);
        if mel_spec.is_empty() || mel_spec[0].is_empty() {
            return mel_spec;
        }

        let n_mels = mel_spec.len();
        let n_frames = mel_spec[0].len();

        // Per-feature normalization: mean/std per mel band
        let mut normalized = vec![vec![0.0f32; n_frames]; n_mels];

        for mel_idx in 0..n_mels {
            let band = &mel_spec[mel_idx];

            // Compute mean
            let mean: f32 = band.iter().sum::<f32>() / n_frames as f32;

            // Compute stddev
            let variance: f32 =
                band.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n_frames as f32;
            let stddev = variance.sqrt() + 1e-5; // epsilon for numerical stability

            // Normalize
            for frame_idx in 0..n_frames {
                normalized[mel_idx][frame_idx] = (band[frame_idx] - mean) / stddev;
            }
        }

        normalized
    }

    /// Compute Whisper-style mel spectrogram with max-normalization.
    ///
    /// Applies: `log10 → clamp(max-8) → (x+4)/4` as per OpenAI Whisper.
    /// Use this for Whisper-based models (Canary, DistilWhisper).
    pub fn compute_whisper_normalized(&self, samples: &[f32]) -> Vec<Vec<f32>> {
        let raw = self.compute(samples);
        if raw.is_empty() || raw[0].is_empty() {
            return raw;
        }
        let max_val = raw
            .iter()
            .flat_map(|row| row.iter().copied())
            .fold(f32::NEG_INFINITY, f32::max);
        raw.into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|v| ((v.max(max_val - 8.0)) + 4.0) / 4.0)
                    .collect()
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Hann window
// ---------------------------------------------------------------------------
fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (size - 1) as f32).cos()))
        .collect()
}

// ---------------------------------------------------------------------------
// Mel filterbank
// ---------------------------------------------------------------------------
fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0)
}

fn compute_mel_filters(
    n_mels: usize,
    n_fft: usize,
    sample_rate: u32,
    f_min: f32,
    f_max: f32,
) -> Vec<Vec<f32>> {
    let n_bins = n_fft / 2 + 1;
    let mel_min = hz_to_mel(f_min);
    let mel_max = hz_to_mel(f_max);

    // n_mels + 2 evenly-spaced mel points
    let n_points = n_mels + 2;
    let mel_points: Vec<f32> = (0..n_points)
        .map(|i| mel_min + (mel_max - mel_min) * i as f32 / (n_points - 1) as f32)
        .collect();
    let hz_points: Vec<f32> = mel_points.iter().map(|&m| mel_to_hz(m)).collect();

    // Convert Hz → bin index
    let bin_points: Vec<usize> = hz_points
        .iter()
        .map(|&hz| ((n_fft + 1) as f32 * hz / sample_rate as f32).floor() as usize)
        .collect();

    let mut filters = vec![vec![0.0f32; n_bins]; n_mels];
    for m in 0..n_mels {
        let f_m_minus = bin_points[m];
        let f_m = bin_points[m + 1];
        let f_m_plus = bin_points[m + 2];

        for (k, weight) in filters[m].iter_mut().enumerate().take(f_m).skip(f_m_minus) {
            if k < n_bins && f_m > f_m_minus {
                *weight = (k - f_m_minus) as f32 / (f_m - f_m_minus) as f32;
            }
        }
        for (k, weight) in filters[m].iter_mut().enumerate().take(f_m_plus).skip(f_m) {
            if k < n_bins && f_m_plus > f_m {
                *weight = (f_m_plus - k) as f32 / (f_m_plus - f_m) as f32;
            }
        }
    }

    filters
}

// ---------------------------------------------------------------------------
// Iterative Cooley-Tukey Radix-2 FFT
// Returns (real, imag) pairs for the full N-point DFT.
// Input length must be power-of-two; zero-pads as needed.
// ---------------------------------------------------------------------------
fn rfft(samples: &[f32]) -> Vec<(f32, f32)> {
    let n = samples.len();
    assert!(n.is_power_of_two(), "FFT requires power-of-two length");

    // Copy into complex buffer
    let mut buf: Vec<(f32, f32)> = samples.iter().map(|&x| (x, 0.0)).collect();

    // Bit-reversal permutation
    let bits = n.trailing_zeros() as usize;
    for i in 0..n {
        let j = bit_reverse(i, bits);
        if j > i {
            buf.swap(i, j);
        }
    }

    // Butterfly stages
    let mut len = 2usize;
    while len <= n {
        let half = len / 2;
        let angle = -2.0 * PI / len as f32;
        let wn = (angle.cos(), angle.sin());

        for i in (0..n).step_by(len) {
            let mut w = (1.0f32, 0.0f32);
            for j in 0..half {
                let u = buf[i + j];
                let v_re = buf[i + j + half].0 * w.0 - buf[i + j + half].1 * w.1;
                let v_im = buf[i + j + half].0 * w.1 + buf[i + j + half].1 * w.0;
                buf[i + j] = (u.0 + v_re, u.1 + v_im);
                buf[i + j + half] = (u.0 - v_re, u.1 - v_im);
                // w *= wn
                let new_re = w.0 * wn.0 - w.1 * wn.1;
                let new_im = w.0 * wn.1 + w.1 * wn.0;
                w = (new_re, new_im);
            }
        }

        len *= 2;
    }

    buf
}

fn bit_reverse(mut x: usize, bits: usize) -> usize {
    let mut result = 0usize;
    for _ in 0..bits {
        result = (result << 1) | (x & 1);
        x >>= 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mel_spec_produces_correct_shape() {
        // 1 second of silence at 16kHz → 80 mel bins × ~101 frames (snip_edges=False)
        let samples = vec![0.0f32; 16000];
        let mel = MelSpectrogram::parakeet_defaults();
        let spec = mel.compute(&samples);
        assert_eq!(spec.len(), 80);
        // snip_edges=False: n_frames = 1 + (n_samples - 1) / hop_length
        let n_frames = 1 + (16000 - 1) / 160;
        for row in &spec {
            assert_eq!(row.len(), n_frames);
        }
    }

    #[test]
    fn test_parakeet_defaults_uses_natural_log() {
        // Silence → floor energy. ln(1e-5) ≈ -11.5; log10(1e-6) = -6.
        // Threshold -8 passes ln but rejects log10, confirming NeMo mode.
        let samples = vec![0.0f32; 16000];
        let mel = MelSpectrogram::parakeet_defaults();
        let spec = mel.compute(&samples);
        // High-frequency bin (79) is always near floor for silent input
        assert!(
            spec[79][0] < -8.0,
            "NeMo ln floor should be < -8.0 (ln(1e-5)≈-11.5), got {}",
            spec[79][0]
        );
    }

    #[test]
    fn test_whisper_normalized_output_range() {
        let samples = vec![0.1f32; 16000];
        let mel = MelSpectrogram::new(512, 160, 400, 80, 16000);
        let spec = mel.compute_whisper_normalized(&samples);
        assert_eq!(spec.len(), 80);
        // After Whisper normalization, values should be in roughly [-1, 1]
        for row in &spec {
            for &v in row {
                assert!(
                    v > -2.0 && v < 2.0,
                    "Whisper normalized value out of range: {}",
                    v
                );
            }
        }
    }

    #[test]
    fn test_fft_dc_component() {
        // Constant signal: FFT[0] should have magnitude N
        let n = 512;
        let samples: Vec<f32> = vec![1.0; n];
        let out = rfft(&samples);
        let mag_dc = (out[0].0 * out[0].0 + out[0].1 * out[0].1).sqrt();
        assert!(
            (mag_dc - n as f32).abs() < 1e-2,
            "DC magnitude mismatch: {}",
            mag_dc
        );
    }
}
