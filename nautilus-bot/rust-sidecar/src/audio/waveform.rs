//! Audio waveform visualization and generation
//!
//! Generates waveform data for display and export.
use anyhow::Result;

/// Waveform data structure
#[derive(Debug, Clone)]
#[expect(
    dead_code,
    reason = "waveform metadata is part of the exported waveform data shape"
)]
pub struct WaveformData {
    /// Sample points (normalized 0.0 to 1.0)
    pub samples: Vec<f32>,
    /// Duration in seconds
    pub duration: f64,
    /// Sample rate
    pub sample_rate: u32,
    /// Number of channels
    pub channels: u16,
}

/// Generate waveform from audio samples
pub fn generate_waveform(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    max_points: usize,
) -> WaveformData {
    let duration = samples.len() as f64 / (sample_rate as f64 * channels as f64);

    // Downsample to max_points
    let samples_per_point = samples.len().max(1) / max_points.max(1);
    let mut waveform_samples = Vec::with_capacity(max_points);

    for i in 0..max_points {
        let start = i * samples_per_point;
        let end = ((i + 1) * samples_per_point).min(samples.len());

        if start < samples.len() {
            // Calculate RMS for this chunk
            let chunk = &samples[start..end];
            let rms = if chunk.is_empty() {
                0.0
            } else {
                let sum_squares: f32 = chunk.iter().map(|s| s * s).sum();
                (sum_squares / chunk.len() as f32).sqrt()
            };
            waveform_samples.push(rms.min(1.0));
        }
    }

    WaveformData {
        samples: waveform_samples,
        duration,
        sample_rate,
        channels,
    }
}

/// Generate waveform from audio file
pub fn generate_waveform_from_file(path: &str, max_points: usize) -> Result<WaveformData> {
    use crate::audio::utils::load_audio_file;
    use std::path::PathBuf;

    let path_buf = PathBuf::from(path);
    let samples = load_audio_file(&path_buf)?;
    Ok(generate_waveform(&samples, 16000, 1, max_points))
}

/// Export waveform as SVG
pub fn export_waveform_svg(data: &WaveformData, width: u32, height: u32, color: &str) -> String {
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}" width="{}" height="{}">"#,
        width, height, width, height
    );

    // Background
    svg.push_str(&format!(
        r#"<rect width="{}" height="{}" fill="transparent"/>"#,
        width, height
    ));

    // Draw waveform bars
    let bar_width = width as f32 / data.samples.len() as f32;
    let center_y = height as f32 / 2.0;

    for (i, &amplitude) in data.samples.iter().enumerate() {
        let x = i as f32 * bar_width;
        let bar_height = amplitude * height as f32 * 0.9; // 90% of height max
        let y = center_y - bar_height / 2.0;

        svg.push_str(&format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}" rx="1"/>"#,
            x,
            y,
            bar_width.max(1.0),
            bar_height,
            color
        ));
    }

    svg.push_str("</svg>");
    svg
}
