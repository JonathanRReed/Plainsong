//! Audio waveform visualization and generation
//!
//! Generates waveform data for display and export.
use anyhow::Result;

const MAX_WAVEFORM_POINTS: usize = 20_000;

/// Waveform data structure
#[derive(Debug, Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "waveform metadata is part of the exported waveform data shape"
    )
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

/// Generate waveform from audio file.
///
/// Streams the file and accumulates directly into the requested number of
/// buckets. The previous implementation called `load_audio_file`, which decodes
/// and resamples the whole recording into one `Vec<f32>` first — for a
/// three-hour meeting that is gigabytes of allocation to produce a few hundred
/// display points, and the peak landed on whoever opened the recording detail.
pub fn generate_waveform_from_file(path: &str, max_points: usize) -> Result<WaveformData> {
    if max_points > MAX_WAVEFORM_POINTS {
        anyhow::bail!(
            "Waveform point count exceeds the maximum {}",
            MAX_WAVEFORM_POINTS
        );
    }
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = spec.channels.max(1);
    let sample_rate = spec.sample_rate.max(1);

    let total_frames = (reader.len() as usize) / channels as usize;
    let duration = total_frames as f64 / sample_rate as f64;

    let buckets = max_points.max(1);
    let frames_per_bucket = total_frames.div_ceil(buckets).max(1);

    let mut waveform_samples: Vec<f32> = Vec::with_capacity(buckets);
    let mut sum_squares = 0f64;
    let mut frames_in_bucket = 0usize;
    let mut channel_accumulator = 0f32;
    let mut channel_index = 0u16;

    // One pass, one frame at a time: nothing beyond the current frame and the
    // running bucket total is ever held.
    let push_frame =
        |frame: f32, sum_squares: &mut f64, frames_in_bucket: &mut usize, out: &mut Vec<f32>| {
            *sum_squares += f64::from(frame) * f64::from(frame);
            *frames_in_bucket += 1;
            if *frames_in_bucket >= frames_per_bucket {
                let rms = (*sum_squares / *frames_in_bucket as f64).sqrt() as f32;
                out.push(rms.min(1.0));
                *sum_squares = 0.0;
                *frames_in_bucket = 0;
            }
        };

    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                let value = sample?;
                channel_accumulator += value;
                channel_index += 1;
                if channel_index >= channels {
                    let frame = channel_accumulator / f32::from(channels);
                    push_frame(
                        frame,
                        &mut sum_squares,
                        &mut frames_in_bucket,
                        &mut waveform_samples,
                    );
                    channel_accumulator = 0.0;
                    channel_index = 0;
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = match spec.bits_per_sample {
                8 => 128.0,
                16 => 32_768.0,
                24 => 8_388_608.0,
                _ => 2_147_483_648.0,
            };
            for sample in reader.samples::<i32>() {
                let value = sample? as f32 / scale;
                channel_accumulator += value;
                channel_index += 1;
                if channel_index >= channels {
                    let frame = channel_accumulator / f32::from(channels);
                    push_frame(
                        frame,
                        &mut sum_squares,
                        &mut frames_in_bucket,
                        &mut waveform_samples,
                    );
                    channel_accumulator = 0.0;
                    channel_index = 0;
                }
            }
        }
    }

    // Flush a partial final bucket so short files still produce a last point.
    if frames_in_bucket > 0 {
        let rms = (sum_squares / frames_in_bucket as f64).sqrt() as f32;
        waveform_samples.push(rms.min(1.0));
    }

    Ok(WaveformData {
        samples: waveform_samples,
        duration,
        sample_rate,
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &std::path::Path, frames: usize, amplitude: i16, channels: u16) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for _ in 0..frames {
            for _ in 0..channels {
                writer.write_sample(amplitude).expect("write sample");
            }
        }
        writer.finalize().expect("finalize wav");
    }

    #[test]
    fn streams_a_file_into_the_requested_number_of_points() {
        let dir = std::env::temp_dir().join(format!("plainsong-waveform-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("tone.wav");
        // 16k frames = 1 second at 16 kHz.
        write_test_wav(&path, 16_000, 16_384, 1);

        let waveform =
            generate_waveform_from_file(path.to_str().unwrap(), 100).expect("waveform generated");

        assert_eq!(waveform.sample_rate, 16_000);
        assert_eq!(waveform.channels, 1);
        assert!(
            (waveform.duration - 1.0).abs() < 0.01,
            "duration {}",
            waveform.duration
        );
        assert!(
            waveform.samples.len() <= 101,
            "expected about 100 points, got {}",
            waveform.samples.len()
        );
        // A constant half-scale tone should land near 0.5 RMS.
        let first = waveform.samples.first().copied().unwrap_or_default();
        assert!((first - 0.5).abs() < 0.05, "unexpected rms {first}");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn downmixes_multichannel_frames() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-waveform-stereo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("stereo.wav");
        write_test_wav(&path, 8_000, 16_384, 2);

        let waveform =
            generate_waveform_from_file(path.to_str().unwrap(), 50).expect("waveform generated");

        assert_eq!(waveform.channels, 2);
        // 8k stereo frames at 16 kHz is half a second of audio.
        assert!(
            (waveform.duration - 0.5).abs() < 0.01,
            "duration {}",
            waveform.duration
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_short_file_still_yields_a_final_point() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-waveform-short-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("short.wav");
        write_test_wav(&path, 10, 16_384, 1);

        let waveform =
            generate_waveform_from_file(path.to_str().unwrap(), 500).expect("waveform generated");

        assert!(
            !waveform.samples.is_empty(),
            "short file produced no points"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_excessive_point_counts_before_opening_or_allocating() {
        let error = generate_waveform_from_file("/path/that/does/not/exist.wav", 20_001)
            .expect_err("oversized waveform requests must fail at the input boundary");

        assert!(
            error.to_string().contains("maximum 20000"),
            "unexpected error: {error}"
        );
    }
}
