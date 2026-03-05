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
    let started = Instant::now();

    let result = match engine {
        PlatformEngine::MacosAppleSpeech => {
            super::macos_speech::transcribe_file(&resolved_audio_path)
        }
        PlatformEngine::WindowsSdkDictation => {
            super::windows_sdk_dictation::transcribe_file(&resolved_audio_path)
        }
        _ => Err(anyhow::anyhow!(
            "Engine '{}' does not expose a native transcription path",
            engine.id()
        )),
    };

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
