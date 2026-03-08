use super::PlatformEngine;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct PlatformTranscription {
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub processing_time_ms: u64,
}

pub fn transcribe_with_engine(
    engine: PlatformEngine,
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
) -> Result<PlatformTranscription> {
    let (resolved_audio_path, is_temp_file) = resolve_audio_path(file_path, audio_data)?;
    let (engine_audio_path, is_engine_temp_file) =
        prepare_audio_for_engine(engine, &resolved_audio_path)?;
    let started = Instant::now();

    let result = match engine {
        PlatformEngine::MacosAppleSpeech => {
            super::macos_speech::transcribe_file(&engine_audio_path)
        }
        PlatformEngine::WindowsSdkDictation => {
            super::windows_sdk_dictation::transcribe_file(&engine_audio_path)
        }
        _ => Err(anyhow::anyhow!(
            "Engine '{}' does not expose a native transcription path",
            engine.id()
        )),
    };

    if is_engine_temp_file {
        let _ = std::fs::remove_file(&engine_audio_path);
    }
    if is_temp_file {
        let _ = std::fs::remove_file(&resolved_audio_path);
    }

    let (text, language, confidence) = result?;
    Ok(PlatformTranscription {
        text,
        language,
        confidence,
        processing_time_ms: started.elapsed().as_millis() as u64,
    })
}

fn prepare_audio_for_engine(engine: PlatformEngine, audio_path: &Path) -> Result<(PathBuf, bool)> {
    match engine {
        PlatformEngine::MacosAppleSpeech => stage_macos_speech_input(audio_path),
        _ => Ok((audio_path.to_path_buf(), false)),
    }
}

fn stage_macos_speech_input(audio_path: &Path) -> Result<(PathBuf, bool)> {
    const PREPENDED_SILENCE_MS: u32 = 750;

    let mut reader = hound::WavReader::open(audio_path).with_context(|| {
        format!(
            "Failed to open '{}' for macOS Speech input staging",
            audio_path.display()
        )
    })?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Ok((audio_path.to_path_buf(), false));
    }

    let staged_path =
        std::env::temp_dir().join(format!("nautilus-macos-speech-staged-{}.wav", uuid::Uuid::new_v4()));
    let mut writer = hound::WavWriter::create(&staged_path, spec).with_context(|| {
        format!(
            "Failed to create staged macOS Speech audio file '{}'",
            staged_path.display()
        )
    })?;

    let prepended_frames =
        ((spec.sample_rate as u64 * PREPENDED_SILENCE_MS as u64) / 1000).max(1) as usize;
    let prepended_samples = prepended_frames * spec.channels as usize;

    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => {
            for _ in 0..prepended_samples {
                writer
                    .write_sample(0_i16)
                    .with_context(|| "Failed to write staged macOS Speech silence".to_string())?;
            }
            for sample in reader.samples::<i16>() {
                writer
                    .write_sample(sample.with_context(|| {
                        format!(
                            "Failed reading sample from '{}' while staging macOS Speech input",
                            audio_path.display()
                        )
                    })?)
                    .with_context(|| {
                        format!(
                            "Failed writing sample to staged macOS Speech file '{}'",
                            staged_path.display()
                        )
                    })?;
            }
        }
        (hound::SampleFormat::Float, 32) => {
            for _ in 0..prepended_samples {
                writer
                    .write_sample(0.0_f32)
                    .with_context(|| "Failed to write staged macOS Speech silence".to_string())?;
            }
            for sample in reader.samples::<f32>() {
                writer
                    .write_sample(sample.with_context(|| {
                        format!(
                            "Failed reading sample from '{}' while staging macOS Speech input",
                            audio_path.display()
                        )
                    })?)
                    .with_context(|| {
                        format!(
                            "Failed writing sample to staged macOS Speech file '{}'",
                            staged_path.display()
                        )
                    })?;
            }
        }
        _ => {
            return Ok((audio_path.to_path_buf(), false));
        }
    }

    writer.finalize().with_context(|| {
        format!(
            "Failed to finalize staged macOS Speech audio file '{}'",
            staged_path.display()
        )
    })?;

    Ok((staged_path, true))
}

fn resolve_audio_path(
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
) -> Result<(PathBuf, bool)> {
    match (file_path, audio_data) {
        (Some(path), None) => Ok((path.to_path_buf(), false)),
        (None, Some(bytes)) => {
            let path = std::env::temp_dir()
                .join(format!("nautilus-native-asr-{}.wav", uuid::Uuid::new_v4()));
            std::fs::write(&path, bytes).with_context(|| {
                format!(
                    "Failed to materialize native-engine audio bytes to '{}'",
                    path.display()
                )
            })?;
            Ok((path, true))
        }
        _ => Err(anyhow::anyhow!(
            "Invalid native-engine input: exactly one of file_path or audio_data is required"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::stage_macos_speech_input;

    #[test]
    fn stage_macos_speech_input_prepends_silence() {
        let input_path =
            std::env::temp_dir().join(format!("nautilus-stage-input-{}.wav", uuid::Uuid::new_v4()));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&input_path, spec).unwrap();
        for _ in 0..spec.sample_rate {
            writer.write_sample(1200_i16).unwrap();
        }
        writer.finalize().unwrap();

        let (staged_path, cleanup) = stage_macos_speech_input(&input_path).unwrap();
        assert!(cleanup);

        let mut reader = hound::WavReader::open(&staged_path).unwrap();
        let samples: Vec<i16> = reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
        let prepended = (spec.sample_rate as usize * 750) / 1000;
        assert!(samples.iter().take(prepended).all(|sample| *sample == 0));
        assert!(samples.iter().skip(prepended).take(32).all(|sample| *sample == 1200));

        let _ = std::fs::remove_file(input_path);
        let _ = std::fs::remove_file(staged_path);
    }
}
