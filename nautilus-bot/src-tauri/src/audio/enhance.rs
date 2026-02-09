//! Noise suppression and audio enhancement
//!
//! Provides spectral subtraction and basic noise gating
//! to improve transcription quality.
#![allow(dead_code)]

use anyhow::Result;

/// Noise suppressor configuration
#[derive(Debug, Clone)]
pub struct NoiseSuppressionConfig {
    /// Sample rate
    pub sample_rate: u32,
    /// FFT size for spectral processing
    pub fft_size: usize,
    /// Overlap factor (0.0-1.0)
    pub overlap: f32,
    /// Noise reduction strength (0.0-1.0)
    pub strength: f32,
    /// Voice activity threshold (0.0-1.0)
    pub voice_threshold: f32,
    /// Attack time in seconds
    pub attack_time: f32,
    /// Release time in seconds
    pub release_time: f32,
}

impl Default for NoiseSuppressionConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            fft_size: 512,
            overlap: 0.5,
            strength: 0.7,
            voice_threshold: 0.3,
            attack_time: 0.01,
            release_time: 0.1,
        }
    }
}

/// Simple noise gate with attack/release
pub struct NoiseGate {
    config: NoiseSuppressionConfig,
    /// Current gain reduction (0.0 = fully open, 1.0 = fully closed)
    gain_reduction: f32,
    /// Attack coefficient
    attack_coef: f32,
    /// Release coefficient
    release_coef: f32,
    /// Noise floor estimate
    noise_floor: f32,
    /// Voice detection history
    voice_history: Vec<bool>,
}

impl NoiseGate {
    pub fn new(config: NoiseSuppressionConfig) -> Self {
        let attack_coef = (-1.0 / (config.sample_rate as f32 * config.attack_time)).exp();
        let release_coef = (-1.0 / (config.sample_rate as f32 * config.release_time)).exp();

        Self {
            config,
            gain_reduction: 0.0,
            attack_coef,
            release_coef,
            noise_floor: -60.0, // Default -60dB
            voice_history: Vec::with_capacity(10),
        }
    }

    /// Process audio through noise gate
    pub fn process(&mut self, samples: &mut [f32]) {
        let threshold_linear = 10.0f32.powf(self.noise_floor / 20.0);

        for sample in samples.iter_mut() {
            let level = sample.abs();
            let is_voice = level > threshold_linear * self.config.voice_threshold;

            // Update voice history
            self.voice_history.push(is_voice);
            if self.voice_history.len() > 10 {
                self.voice_history.remove(0);
            }

            // Voice detection with hysteresis
            let voice_detected = self.voice_history.iter().filter(|&&v| v).count() >= 3;

            // Apply attack/release
            if voice_detected {
                // Attack - reduce gain reduction (open gate)
                self.gain_reduction *= self.attack_coef;
            } else {
                // Release - increase gain reduction (close gate)
                self.gain_reduction =
                    self.gain_reduction * (1.0 - self.release_coef) + self.release_coef;
            }

            // Apply gain reduction
            let gain = 1.0 - self.gain_reduction * self.config.strength;
            *sample *= gain.max(0.01); // Never fully silence
        }
    }

    /// Set noise floor from calibration
    pub fn calibrate(&mut self, noise_samples: &[f32]) {
        let sum_squares: f32 = noise_samples.iter().map(|s| s * s).sum();
        let rms = (sum_squares / noise_samples.len().max(1) as f32).sqrt();

        if rms > 0.0 {
            self.noise_floor = 20.0 * rms.log10();
        }
    }
}

/// Simple spectral subtraction noise reducer
pub struct SpectralNoiseReducer {
    config: NoiseSuppressionConfig,
    /// Noise spectrum estimate
    noise_spectrum: Vec<f32>,
    /// Previous overlap buffer
    overlap_buffer: Vec<f32>,
    /// Smoothing factor for noise estimation
    alpha: f32,
    /// Frame counter for noise estimation
    frame_count: usize,
}

impl SpectralNoiseReducer {
    pub fn new(config: NoiseSuppressionConfig) -> Self {
        let fft_size = config.fft_size;
        let overlap = config.overlap;

        Self {
            config,
            noise_spectrum: vec![0.0; fft_size / 2 + 1],
            overlap_buffer: vec![0.0; (fft_size as f32 * overlap) as usize],
            alpha: 0.9,
            frame_count: 0,
        }
    }

    /// Process audio through spectral subtraction
    pub fn process(&mut self, samples: &mut [f32]) -> Result<()> {
        // For now, implement a simple time-domain noise reducer
        // Full spectral subtraction would require FFT (complex for this scope)

        let hop_size = (self.config.fft_size as f32 * (1.0 - self.config.overlap)) as usize;

        for chunk in samples.chunks_mut(hop_size) {
            self.process_frame(chunk);
        }

        Ok(())
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        // Calculate frame energy
        let energy: f32 = frame.iter().map(|s| s * s).sum();

        // Simple noise gating based on energy
        let noise_gate_threshold = 10.0f32.powf(self.noise_floor() / 10.0) * 2.0;

        if energy < noise_gate_threshold && self.frame_count > 10 {
            // Likely noise - reduce level
            let reduction = self.config.strength;
            for sample in frame.iter_mut() {
                *sample *= 1.0 - reduction;
            }
        }

        // Update noise estimate during low energy frames
        if energy < noise_gate_threshold {
            let current_noise = energy.sqrt();
            self.noise_spectrum[0] =
                self.alpha * self.noise_spectrum[0] + (1.0 - self.alpha) * current_noise;
        }

        self.frame_count += 1;
    }

    fn noise_floor(&self) -> f32 {
        if self.noise_spectrum[0] > 0.0 {
            20.0 * self.noise_spectrum[0].log10()
        } else {
            -60.0
        }
    }

    /// Calibrate noise spectrum from silence/noise samples
    pub fn calibrate(&mut self, noise_samples: &[f32]) {
        let sum_squares: f32 = noise_samples.iter().map(|s| s * s).sum();
        let rms = (sum_squares / noise_samples.len().max(1) as f32).sqrt();

        self.noise_spectrum[0] = rms;
        self.frame_count = 100; // Skip initial calibration period
    }
}

/// Audio preprocessor with both noise gate and spectral reduction
pub struct AudioPreprocessor {
    noise_gate: NoiseGate,
    spectral_reducer: SpectralNoiseReducer,
    enabled: bool,
}

impl AudioPreprocessor {
    pub fn new(sample_rate: u32) -> Self {
        let config = NoiseSuppressionConfig {
            sample_rate,
            ..Default::default()
        };

        Self {
            noise_gate: NoiseGate::new(config.clone()),
            spectral_reducer: SpectralNoiseReducer::new(config),
            enabled: true,
        }
    }

    /// Enable/disable processing
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Process audio samples
    pub fn process(&mut self, samples: &mut [f32]) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }

        // Apply noise gate
        self.noise_gate.process(samples);

        // Apply spectral reduction
        self.spectral_reducer.process(samples)?;

        // Normalize output
        normalize_audio(samples);

        Ok(())
    }

    /// Calibrate from silence/noise samples
    pub fn calibrate(&mut self, noise_samples: &[f32]) {
        self.noise_gate.calibrate(noise_samples);
        self.spectral_reducer.calibrate(noise_samples);
    }

    /// Auto-calibrate from first 0.5 seconds assuming it contains only noise
    pub fn auto_calibrate(&mut self, samples: &[f32], sample_rate: u32) {
        let calibration_samples = (0.5 * sample_rate as f32) as usize;
        if samples.len() >= calibration_samples {
            self.calibrate(&samples[..calibration_samples]);
        }
    }
}

/// Normalize audio to -1dB peak
fn normalize_audio(samples: &mut [f32]) {
    let max_peak: f32 = samples.iter().map(|s| s.abs()).fold(0.0, f32::max);

    if max_peak > 0.0 {
        let target_peak = 0.89; // -1dB
        let gain = target_peak / max_peak;

        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }
}

/// Apply high-pass filter to remove low-frequency noise
pub fn highpass_filter(samples: &mut [f32], sample_rate: u32, cutoff_hz: f32) {
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let dt = 1.0 / sample_rate as f32;
    let alpha = rc / (rc + dt);

    let mut prev_output = 0.0f32;
    let mut prev_input = 0.0f32;

    for sample in samples.iter_mut() {
        let input = *sample;
        let output = alpha * (prev_output + input - prev_input);

        prev_input = input;
        prev_output = output;
        *sample = output;
    }
}

/// Apply low-pass filter to remove high-frequency noise
pub fn lowpass_filter(samples: &mut [f32], sample_rate: u32, cutoff_hz: f32) {
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let dt = 1.0 / sample_rate as f32;
    let alpha = dt / (rc + dt);

    let mut prev_output = 0.0f32;

    for sample in samples.iter_mut() {
        let input = *sample;
        let output = prev_output + alpha * (input - prev_output);

        prev_output = output;
        *sample = output;
    }
}

/// Full audio enhancement pipeline
pub fn enhance_audio(samples: &mut [f32], sample_rate: u32) -> Result<()> {
    // Remove DC offset and rumble
    highpass_filter(samples, sample_rate, 80.0);

    // Reduce high-frequency hiss
    lowpass_filter(samples, sample_rate, 8000.0);

    // Apply noise suppression
    let mut preprocessor = AudioPreprocessor::new(sample_rate);
    preprocessor.auto_calibrate(samples, sample_rate);
    preprocessor.process(samples)?;

    Ok(())
}
