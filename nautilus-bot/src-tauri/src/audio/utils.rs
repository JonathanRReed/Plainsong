//! Audio preprocessing utilities for ASR models
//!
//! All ASR models require 16kHz mono f32 audio input.
//! This module handles resampling, format conversion, and normalization.

use anyhow::{Context, Result};
use hound::{WavReader, WavSpec};
use std::path::PathBuf;

/// Load and preprocess audio file for ASR
///
/// Performs:
/// - Read WAV/PCM file
/// - Convert to mono
/// - Resample to 16kHz
/// - Convert to f32 samples
/// - Normalize to [-1.0, 1.0]
pub fn load_audio_file(path: &PathBuf) -> Result<Vec<f32>> {
    tracing::info!("Loading audio file: {:?}", path);

    // Check file extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "wav" => load_wav_file(path),
        "pcm" | "raw" => load_raw_pcm(path),
        _ => Err(anyhow::anyhow!("Unsupported audio format: {}", ext)),
    }
}

/// Load WAV file and preprocess
fn load_wav_file(path: &PathBuf) -> Result<Vec<f32>> {
    let reader = WavReader::open(path).context("Failed to open WAV file")?;

    let spec = reader.spec();
    tracing::info!("WAV spec: {:?}", spec);

    // Read samples based on format
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => match spec.bits_per_sample {
            16 => read_i16_samples(reader),
            24 => read_i24_samples(reader),
            32 => read_i32_samples(reader),
            _ => Err(anyhow::anyhow!(
                "Unsupported bit depth: {}",
                spec.bits_per_sample
            )),
        },
        hound::SampleFormat::Float => read_f32_samples(reader),
    }?;

    // Convert to mono if stereo
    let samples = if spec.channels == 2 {
        stereo_to_mono(&samples)
    } else {
        samples
    };

    // Resample to 16kHz if needed
    let samples = if spec.sample_rate != 16000 {
        resample(&samples, spec.sample_rate, 16000).context("Failed to resample audio")?
    } else {
        samples
    };

    tracing::info!("Loaded {} samples at 16kHz", samples.len());

    Ok(samples)
}

/// Load raw PCM file (assumes 16-bit signed, 16kHz, mono)
fn load_raw_pcm(path: &PathBuf) -> Result<Vec<f32>> {
    let data = std::fs::read(path).context("Failed to read PCM file")?;

    // Convert bytes to i16 samples
    let samples: Vec<f32> = data
        .chunks_exact(2)
        .map(|chunk| {
            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            sample as f32 / 32768.0
        })
        .collect();

    Ok(samples)
}

/// Read 16-bit signed integer samples
fn read_i16_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0)
        .collect();
    Ok(samples)
}

/// Read 24-bit signed integer samples
fn read_i24_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i32>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 8388608.0) // 2^23
        .collect();
    Ok(samples)
}

/// Read 32-bit signed integer samples
fn read_i32_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<i32>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 2147483648.0) // 2^31
        .collect();
    Ok(samples)
}

/// Read 32-bit float samples
fn read_f32_samples(reader: WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>> {
    let samples: Vec<f32> = reader
        .into_samples::<f32>()
        .filter_map(|s| s.ok())
        .collect();
    Ok(samples)
}

/// Convert stereo to mono by averaging channels
fn stereo_to_mono(stereo: &[f32]) -> Vec<f32> {
    stereo
        .chunks_exact(2)
        .map(|chunk| (chunk[0] + chunk[1]) / 2.0)
        .collect()
}

/// Simple linear resampling
///
/// For production, consider using rubato crate for higher quality resampling
fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(input.to_vec());
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let output_len = (input.len() as f64 * ratio) as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let input_pos = i as f64 / ratio;
        let index = input_pos as usize;
        let frac = input_pos - index as f64;

        if index + 1 < input.len() {
            let sample = input[index] * (1.0 - frac as f32) + input[index + 1] * frac as f32;
            output.push(sample);
        } else if index < input.len() {
            output.push(input[index]);
        }
    }

    Ok(output)
}

/// Save audio data to WAV file
#[allow(dead_code)]
pub fn save_wav_file(path: &PathBuf, samples: &[f32], sample_rate: u32) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::create(path, spec).context("Failed to create WAV writer")?;

    for sample in samples {
        let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer
            .write_sample(int_sample)
            .context("Failed to write sample")?;
    }

    writer.finalize().context("Failed to finalize WAV file")?;

    Ok(())
}

/// Normalize audio to target dB level
#[allow(dead_code)]
pub fn normalize(samples: &mut [f32], target_db: f32) {
    if samples.is_empty() {
        return;
    }

    // Find current RMS
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / samples.len() as f32).sqrt();

    if rms > 0.0 {
        let target_linear = 10f32.powf(target_db / 20.0);
        let gain = target_linear / rms;

        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }
}

/// Apply pre-emphasis filter (high-pass)
/// Helps with ASR accuracy by boosting high frequencies
#[allow(dead_code)]
pub fn pre_emphasis(samples: &mut [f32], coeff: f32) {
    if samples.len() < 2 {
        return;
    }

    for i in (1..samples.len()).rev() {
        samples[i] = samples[i] - coeff * samples[i - 1];
    }
}

/// Remove silence from audio (simple energy-based)
#[allow(dead_code)]
pub fn remove_silence(
    samples: &[f32],
    threshold: f32,
    min_silence_ms: u32,
    sample_rate: u32,
) -> Vec<f32> {
    let min_silence_samples = (min_silence_ms as usize * sample_rate as usize) / 1000;
    let mut result = Vec::with_capacity(samples.len());
    let mut silence_count = 0;

    for &sample in samples {
        if sample.abs() < threshold {
            silence_count += 1;
            if silence_count <= min_silence_samples {
                result.push(sample);
            }
        } else {
            silence_count = 0;
            result.push(sample);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stereo_to_mono() {
        let stereo = vec![0.5, 0.3, 0.7, 0.2];
        let mono = stereo_to_mono(&stereo);
        assert_eq!(mono, vec![0.4, 0.45]);
    }

    #[test]
    fn test_resample() {
        let input = vec![0.0, 0.5, 1.0, 0.5];
        let output = resample(&input, 16000, 8000).unwrap();
        assert_eq!(output.len(), 2);
    }

    #[test]
    fn test_normalize() {
        let mut samples = vec![0.1, 0.2, 0.3];
        normalize(&mut samples, -20.0);
        // Just verify it doesn't panic
        assert!(!samples.is_empty());
    }
}
