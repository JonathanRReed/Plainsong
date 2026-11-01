//! Measurement probe for "early window decoding": could the 30 s windows a
//! long dictation is decoded in be decoded while recording continues, and
//! reused at stop by exact-sample match?
//!
//! The answer depends on whether a finished window's samples are already
//! final before stop. This probe runs the real stop transform
//! (`encode_dictation_recognition_wav`) and the real window reader on growing
//! prefixes of a simulated 48 kHz capture and counts the windows whose samples
//! a prefix already produced bit for bit. With a model it also times the warm
//! final decode and checks that per-window decodes join to the batch text.
//!
//! Ignored by default. Point it at a copy of the models root (an APFS clone
//! works; nothing is written beside the models):
//!
//! ```text
//! PLAINSONG_EARLY_WINDOW_MODELS_ROOT=/tmp/models \
//!   bun scripts/cargo-sidecar.ts test --lib early_window_probe -- --ignored --nocapture
//! ```
//! Without the variable only the sample-identity half runs.

use super::*;
use crate::audio::utils::{AudioWindowReader, ASR_SAMPLE_RATE};
use sha2::{Digest, Sha256};
use std::time::Instant;

const CAPTURE_RATE: u32 = 48_000;

fn fixture(name: &str) -> Vec<f32> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/fixtures")
        .join(name);
    crate::audio::utils::load_audio_file(&path).expect("fixture loads")
}

/// Repeated public fixture speech with short pauses and a quiet noise floor,
/// upsampled to the 48 kHz a built-in microphone delivers, scaled so the
/// speech frames sit at `speech_dbfs`.
fn simulated_capture(seconds: usize, speech_dbfs: f32) -> Vec<f32> {
    let speech = [
        fixture("real-speech-44s.wav"),
        fixture("local-perf-30s.wav"),
    ];
    let pause = vec![0.0f32; 16_000 * 6 / 10];
    let mut at_16k = Vec::new();
    'fill: loop {
        for clip in &speech {
            at_16k.extend_from_slice(clip);
            at_16k.extend_from_slice(&pause);
            if at_16k.len() >= seconds * 16_000 {
                break 'fill;
            }
        }
    }
    at_16k.truncate(seconds * 16_000);
    let mut capture = Vec::with_capacity(at_16k.len() * 3);
    for (index, sample) in at_16k.iter().enumerate() {
        let next = at_16k.get(index + 1).copied().unwrap_or(*sample);
        for step in 0..3 {
            capture.push(sample + (next - sample) * step as f32 / 3.0);
        }
    }
    let gain = 10f32.powf(speech_dbfs / 20.0) / speech_frame_rms(&capture);
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    for sample in &mut capture {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let noise =
            ((seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 2.0 * 10f32.powf(-66.0 / 20.0);
        *sample = *sample * gain + noise;
    }
    capture
}

/// RMS over the 20 ms frames `normalize_dictation_loudness` counts as speech.
fn speech_frame_rms(samples: &[f32]) -> f32 {
    let (mut energy, mut count) = (0.0f64, 0usize);
    for frame in samples.chunks(960) {
        let e: f64 = frame.iter().map(|s| f64::from(*s).powi(2)).sum();
        if (e / frame.len() as f64).sqrt() >= 0.003 {
            energy += e;
            count += frame.len();
        }
    }
    (energy / count.max(1) as f64).sqrt() as f32
}

fn recognition_wav(capture: &[f32], dir: &Path, label: &str) -> PathBuf {
    let mut samples = capture.to_vec();
    let bytes =
        crate::audio::encode_dictation_recognition_wav(&mut samples, CAPTURE_RATE).expect("encode");
    let path = dir.join(format!("{label}.wav"));
    std::fs::write(&path, bytes).expect("write wav");
    path
}

/// Every window the final decode would see, with its end in capture frames.
fn windows(path: &Path) -> Vec<(Vec<f32>, usize)> {
    let mut reader = AudioWindowReader::open(path).expect("open");
    let mut out = Vec::new();
    let mut end = 0usize;
    while reader.has_more() {
        let window = reader.next_window().expect("window");
        end += window.len();
        out.push((
            window,
            end * CAPTURE_RATE as usize / ASR_SAMPLE_RATE as usize,
        ));
    }
    out
}

fn digest(samples: &[f32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for sample in samples {
        hasher.update(sample.to_bits().to_le_bytes());
    }
    hasher.finalize().into()
}

/// A mono WAV; `float` selects 32-bit float, otherwise 16-bit PCM.
fn write_mono_wav<S: hound::Sample>(
    path: &Path,
    sample_rate: u32,
    float: bool,
    samples: impl Iterator<Item = S>,
) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: if float { 32 } else { 16 },
        sample_format: if float {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        },
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("writer");
    for sample in samples {
        writer.write_sample(sample).expect("sample");
    }
    writer.finalize().expect("finalize");
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "plainsong-early-window-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// For each completed final window, the earliest probed prefix that already
/// produced it bit for bit, in seconds of capture, or `None`.
fn early_availability(capture: &[f32], dir: &Path) -> Vec<Option<f32>> {
    let final_windows = windows(&recognition_wav(capture, dir, "final"));
    let completed = &final_windows[..final_windows.len() - 1];
    completed
        .iter()
        .map(|(window, end)| {
            let target = digest(window);
            // Just past the window, a few seconds later, and the last moment
            // before stop.
            [
                *end + 4_800,
                *end + 3 * CAPTURE_RATE as usize,
                capture.len() - 4_800,
            ]
            .into_iter()
            .filter(|prefix| *prefix < capture.len())
            .find(|prefix| {
                let path = recognition_wav(&capture[..*prefix], dir, "prefix");
                windows(&path)
                    .iter()
                    .any(|(candidate, _)| digest(candidate) == target)
            })
            .map(|prefix| prefix as f32 / CAPTURE_RATE as f32)
        })
        .collect()
}

#[test]
#[ignore = "measurement probe; see the module comment"]
fn early_window_probe() {
    let dir = temp_dir("probe");
    for seconds in [60usize, 120] {
        for speech_dbfs in [-12.0f32, -18.0, -24.0, -30.0, -36.0, -44.0] {
            let capture = simulated_capture(seconds, speech_dbfs);
            let gain = (0.1 / speech_frame_rms(&capture)).clamp(1.0, 10.0);
            let available = early_availability(&capture, &dir);
            let hits = available.iter().filter(|seen| seen.is_some()).count();
            eprintln!(
                "{seconds:>4}s speech {speech_dbfs:>6.1} dBFS gain {gain:>6.3}: {hits}/{} completed windows final before stop; earliest {:?}",
                available.len(),
                available
            );
        }
    }

    let Ok(root) = std::env::var("PLAINSONG_EARLY_WINDOW_MODELS_ROOT") else {
        eprintln!("PLAINSONG_EARLY_WINDOW_MODELS_ROOT not set; skipping decode timing");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    };
    let model_dir = PathBuf::from(root)
        .join("parakeet")
        .join(PARAKEET_V3_MODEL_ID);
    let warm = run_parakeet_tdt(&model_dir, &model_dir.join("test_wavs/en.wav"), PARAKEET_V3)
        .expect("warm decode");
    eprintln!("warm-up: {warm}");

    for seconds in [60usize, 120] {
        let capture = simulated_capture(seconds, -30.0);
        let final_path = recognition_wav(&capture, &dir, "final");
        let final_windows = windows(&final_path);

        let mut full_ms = Vec::new();
        let mut texts = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            texts.push(run_parakeet_tdt(&model_dir, &final_path, PARAKEET_V3).expect("full"));
            full_ms.push(started.elapsed().as_millis());
        }
        assert!(
            texts.windows(2).all(|pair| pair[0] == pair[1]),
            "repeated decodes of the same audio differ"
        );

        // Each window decoded alone, from a 16 kHz float WAV the reader
        // passes through unchanged, joined the way process_audio_windows
        // joins them.
        let mut joined = String::new();
        let mut window_ms = Vec::new();
        for (index, (window, _)) in final_windows.iter().enumerate() {
            let path = dir.join(format!("window-{index}.wav"));
            write_mono_wav(&path, ASR_SAMPLE_RATE as u32, true, window.iter().copied());
            assert_eq!(
                windows(&path)
                    .into_iter()
                    .map(|(samples, _)| samples)
                    .collect::<Vec<_>>(),
                vec![window.clone()],
                "a 16 kHz float window must reach the decoder unchanged"
            );
            let started = Instant::now();
            let text = run_parakeet_tdt(&model_dir, &path, PARAKEET_V3).expect("window");
            window_ms.push(started.elapsed().as_millis());
            let text = text.trim();
            if !text.is_empty() {
                if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(text);
            }
        }
        assert_eq!(
            joined, texts[0],
            "per-window decodes must join to the batch text"
        );

        // What a causal transform would cost in fidelity, crudely: the same
        // capture with no loudness gain at all. Reported, not asserted.
        let ungained = dir.join("ungained.wav");
        write_mono_wav(
            &ungained,
            CAPTURE_RATE,
            false,
            capture
                .iter()
                .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16),
        );
        let ungained_text = run_parakeet_tdt(&model_dir, &ungained, PARAKEET_V3).expect("ungained");
        if ungained_text == texts[0] {
            eprintln!("{seconds:>4}s without loudness gain: text identical");
        } else {
            eprintln!("{seconds:>4}s without loudness gain: text differs");
            eprintln!("  gained:   {}\n  ungained: {}", texts[0], ungained_text);
        }
        eprintln!(
            "{seconds:>4}s at -30 dBFS: {} windows {:?} samples; full warm decode ms {:?}; per-window ms {:?}; last window alone {} ms",
            final_windows.len(),
            final_windows.iter().map(|(w, _)| w.len()).collect::<Vec<_>>(),
            full_ms,
            window_ms,
            window_ms.last().copied().unwrap_or_default()
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}
