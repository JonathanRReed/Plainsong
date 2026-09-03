use super::PlatformEngine;
use crate::asr::TranscriptSegment;
use anyhow::{Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// How much silence `stage_macos_speech_input` prepends before handing audio
/// to the macOS Speech helper. Segment timestamps come back relative to the
/// staged file, so this is subtracted before they are reported.
const PREPENDED_SILENCE_MS: u32 = 750;

/// The frames of silence to prepend at one sample rate, and the seconds that
/// many frames actually last.
///
/// Both come from here so they cannot disagree. They used to be computed
/// separately: the frame count floored to at least one frame, while the
/// reported offset was always `PREPENDED_SILENCE_MS`, so below about 1334 Hz
/// the staged file held a single frame and every segment was shifted back by
/// three quarters of a second that was never there.
fn prepended_silence(sample_rate: u32) -> (usize, f64) {
    let frames = ((sample_rate as u64 * PREPENDED_SILENCE_MS as u64) / 1000).max(1) as usize;
    let seconds = if sample_rate == 0 {
        0.0
    } else {
        frames as f64 / sample_rate as f64
    };
    (frames, seconds)
}

#[derive(Debug, Clone)]
pub struct PlatformTranscription {
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub processing_time_ms: u64,
    /// Which engine inside the platform route actually ran, when the route
    /// has more than one (Apple Speech: SpeechAnalyzer or SFSpeechRecognizer).
    pub engine: Option<String>,
    /// Per-segment timestamps, when the engine returns them. Empty for
    /// SFSpeechRecognizer and for the Windows dictation route.
    pub segments: Vec<TranscriptSegment>,
    /// Vocabulary-hint terms the native engine reports it actually took.
    /// Always zero on routes that have no bias list at all.
    pub vocabulary_hint_terms_applied: usize,
}

#[derive(Debug)]
struct ManagedAudioPath {
    path: PathBuf,
    remove_on_drop: bool,
    /// Silence prepended to this file relative to the caller's audio, so
    /// timestamps the engine reports can be shifted back onto the original.
    prepended_silence_seconds: f64,
}

impl ManagedAudioPath {
    fn borrowed(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            remove_on_drop: false,
            prepended_silence_seconds: 0.0,
        }
    }

    fn temporary(path: PathBuf) -> Self {
        Self {
            path,
            remove_on_drop: true,
            prepended_silence_seconds: 0.0,
        }
    }

    fn with_prepended_silence(mut self, seconds: f64) -> Self {
        self.prepended_silence_seconds = seconds;
        self
    }
}

impl Drop for ManagedAudioPath {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Per-request constraints a native route has to honour.
///
/// `apple_speech_required_engine` is how a caller whose correctness depends on
/// one of Apple's two engines (the meeting route needs SpeechAnalyzer's timed
/// segments) names it instead of letting the route re-decide.
///
/// `contextual_strings` is the recognizer vocabulary bias for this request,
/// already normalized and capped by
/// `macos_speech::contextual_strings_for_helper`.
#[derive(Debug, Clone, Default)]
pub struct PlatformTranscriptionOptions {
    pub apple_speech_required_engine: Option<super::macos_speech::AppleSpeechEngine>,
    pub contextual_strings: Vec<String>,
}

pub fn transcribe_with_engine(
    engine: PlatformEngine,
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
) -> Result<PlatformTranscription> {
    transcribe_with_engine_options(
        engine,
        file_path,
        audio_data,
        PlatformTranscriptionOptions::default(),
    )
}

pub fn transcribe_with_engine_options(
    engine: PlatformEngine,
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
    options: PlatformTranscriptionOptions,
) -> Result<PlatformTranscription> {
    transcribe_with_engine_in_temp_dir(
        engine,
        file_path,
        audio_data,
        &std::env::temp_dir(),
        options,
    )
}

fn transcribe_with_engine_in_temp_dir(
    engine: PlatformEngine,
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
    temp_dir: &Path,
    options: PlatformTranscriptionOptions,
) -> Result<PlatformTranscription> {
    let resolved_audio = resolve_audio_path(file_path, audio_data, temp_dir)?;
    let engine_audio = prepare_audio_for_engine(engine, &resolved_audio.path, temp_dir)?;
    let started = Instant::now();

    match engine {
        PlatformEngine::MacosAppleSpeech => {
            let transcript = super::macos_speech::transcribe_file(
                &engine_audio.path,
                options.apple_speech_required_engine,
                &options.contextual_strings,
            )?;
            let offset = engine_audio.prepended_silence_seconds;
            Ok(PlatformTranscription {
                text: transcript.text,
                language: transcript.language,
                confidence: transcript.confidence,
                processing_time_ms: started.elapsed().as_millis() as u64,
                engine: transcript.engine,
                vocabulary_hint_terms_applied: transcript.vocabulary_hint_terms_applied,
                segments: transcript
                    .segments
                    .into_iter()
                    .map(|segment| TranscriptSegment {
                        start_time: (segment.start_seconds - offset).max(0.0),
                        end_time: (segment.end_seconds - offset).max(0.0),
                        text: segment.text,
                        confidence: segment.confidence,
                    })
                    .collect(),
            })
        }
        PlatformEngine::WindowsSdkDictation => {
            let (text, language, confidence) =
                super::windows_sdk_dictation::transcribe_file(&engine_audio.path)?;
            Ok(PlatformTranscription {
                text,
                language,
                confidence,
                processing_time_ms: started.elapsed().as_millis() as u64,
                engine: None,
                vocabulary_hint_terms_applied: 0,
                segments: Vec::new(),
            })
        }
        _ => Err(anyhow::anyhow!(
            "Engine '{}' does not expose a native transcription path",
            engine.id()
        )),
    }
}

fn prepare_audio_for_engine(
    engine: PlatformEngine,
    audio_path: &Path,
    temp_dir: &Path,
) -> Result<ManagedAudioPath> {
    match engine {
        PlatformEngine::MacosAppleSpeech => stage_macos_speech_input(audio_path, temp_dir),
        _ => Ok(ManagedAudioPath::borrowed(audio_path)),
    }
}

fn stage_macos_speech_input(audio_path: &Path, temp_dir: &Path) -> Result<ManagedAudioPath> {
    let staged_path = temp_dir.join(format!(
        "nautilus-macos-speech-staged-{}.wav",
        uuid::Uuid::new_v4()
    ));
    stage_macos_speech_input_at(audio_path, staged_path)
}

fn stage_macos_speech_input_at(
    audio_path: &Path,
    staged_path: PathBuf,
) -> Result<ManagedAudioPath> {
    let mut reader = hound::WavReader::open(audio_path).with_context(|| {
        format!(
            "Failed to open '{}' for macOS Speech input staging",
            audio_path.display()
        )
    })?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Ok(ManagedAudioPath::borrowed(audio_path));
    }
    if !matches!(
        (spec.sample_format, spec.bits_per_sample),
        (hound::SampleFormat::Int, 16) | (hound::SampleFormat::Float, 32)
    ) {
        return Ok(ManagedAudioPath::borrowed(audio_path));
    }

    let staged_audio = ManagedAudioPath::temporary(staged_path);
    let staged_file = create_private_file(&staged_audio.path).with_context(|| {
        format!(
            "Failed to create staged macOS Speech audio file '{}'",
            staged_audio.path.display()
        )
    })?;
    let mut writer = hound::WavWriter::new(staged_file, spec).with_context(|| {
        format!(
            "Failed to initialize staged macOS Speech audio file '{}'",
            staged_audio.path.display()
        )
    })?;

    let (prepended_frames, prepended_seconds) = prepended_silence(spec.sample_rate);
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
                            staged_audio.path.display()
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
                            staged_audio.path.display()
                        )
                    })?;
            }
        }
        _ => unreachable!("unsupported formats return before staged file creation"),
    }

    writer.finalize().with_context(|| {
        format!(
            "Failed to finalize staged macOS Speech audio file '{}'",
            staged_audio.path.display()
        )
    })?;

    Ok(staged_audio.with_prepended_silence(prepended_seconds))
}

fn resolve_audio_path(
    file_path: Option<&Path>,
    audio_data: Option<&[u8]>,
    temp_dir: &Path,
) -> Result<ManagedAudioPath> {
    match (file_path, audio_data) {
        (Some(path), None) => Ok(ManagedAudioPath::borrowed(path)),
        (None, Some(bytes)) => {
            let audio = ManagedAudioPath::temporary(
                temp_dir.join(format!("nautilus-native-asr-{}.wav", uuid::Uuid::new_v4())),
            );
            let mut file = create_private_file(&audio.path).with_context(|| {
                format!(
                    "Failed to create native-engine audio file '{}'",
                    audio.path.display()
                )
            })?;
            file.write_all(bytes).with_context(|| {
                format!(
                    "Failed to materialize native-engine audio bytes to '{}'",
                    audio.path.display()
                )
            })?;
            Ok(audio)
        }
        _ => Err(anyhow::anyhow!(
            "Invalid native-engine input: exactly one of file_path or audio_data is required"
        )),
    }
}

fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::{
        prepended_silence, stage_macos_speech_input, stage_macos_speech_input_at,
        transcribe_with_engine_in_temp_dir, PlatformTranscriptionOptions, PREPENDED_SILENCE_MS,
    };
    use crate::asr::platform::PlatformEngine;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("nautilus-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create test temp directory");
        root
    }

    /// The staged file the macOS Speech helper reads starts with silence, so
    /// every timestamp SpeechAnalyzer reports is shifted by that much. The
    /// staged path carries the offset so `transcribe_with_engine` can shift
    /// segments back onto the caller's audio; without it a meeting transcript
    /// would be 750 ms late on every chunk.
    #[test]
    fn staged_macos_speech_input_reports_the_silence_it_prepended() {
        let root = temp_root("stage-offset");
        let input_path = root.join("input.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&input_path, spec).expect("write test wav");
        for _ in 0..16_000 {
            writer.write_sample(0_i16).expect("write sample");
        }
        writer.finalize().expect("finalize test wav");

        let staged = stage_macos_speech_input_at(&input_path, root.join("staged.wav"))
            .expect("stage macOS Speech input");
        assert!(
            (staged.prepended_silence_seconds - PREPENDED_SILENCE_MS as f64 / 1000.0).abs() < 1e-9
        );

        // A file that is passed through untouched carries no offset.
        let borrowed = super::ManagedAudioPath::borrowed(&input_path);
        assert_eq!(borrowed.prepended_silence_seconds, 0.0);

        let _ = std::fs::remove_dir_all(root);
    }

    /// The frames written and the offset reported have to describe the same
    /// silence.
    ///
    /// They were computed apart: the frame count floored the integer division
    /// `sample_rate * 750 / 1000` up to at least one frame, while the reported
    /// offset was always the nominal 750 ms. Wherever that division is not
    /// exact -- any rate that is not a multiple of 4, and the floor at the
    /// bottom of the range -- the transcript was shifted by silence the staged
    /// file did not contain.
    #[test]
    fn prepended_silence_frames_and_seconds_describe_the_same_gap() {
        for sample_rate in [1_u32, 100, 1_333, 8_000, 11_025, 22_050, 44_100, 48_000] {
            let (frames, seconds) = prepended_silence(sample_rate);

            // The single invariant: the offset is the duration of the frames
            // actually written, at every rate.
            assert!(
                (seconds - frames as f64 / sample_rate as f64).abs() < 1e-12,
                "{sample_rate} Hz wrote {frames} frames but reported {seconds}s"
            );
            assert_eq!(
                frames,
                ((sample_rate as usize * 750) / 1000).max(1),
                "{sample_rate} Hz frame count"
            );
            assert!(frames >= 1, "{sample_rate} Hz must prepend some silence");
        }

        // Where the division is exact, the offset is still the nominal window.
        for sample_rate in [8_000_u32, 16_000, 44_100, 48_000] {
            let (_, seconds) = prepended_silence(sample_rate);
            assert!((seconds - PREPENDED_SILENCE_MS as f64 / 1000.0).abs() < 1e-9);
        }

        // Where it is not, the offset follows the file rather than the
        // nominal window. 22_050 truncates a half frame; at 1 Hz the floor
        // writes a whole second of silence and has to say so.
        assert!(prepended_silence(22_050).1 < PREPENDED_SILENCE_MS as f64 / 1000.0);
        assert_eq!(prepended_silence(1), (1, 1.0));

        // A malformed spec never reaches the writer, but the arithmetic must
        // not divide by zero on the way to finding that out.
        assert_eq!(prepended_silence(0), (1, 0.0));
    }

    #[test]
    fn stage_macos_speech_input_prepends_silence_and_cleans_up_on_drop() {
        let root = temp_root("stage-input");
        let input_path = root.join("input.wav");
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

        let staged_audio = stage_macos_speech_input(&input_path, &root).unwrap();
        let staged_path = staged_audio.path.clone();

        let mut reader = hound::WavReader::open(&staged_path).unwrap();
        let samples: Vec<i16> = reader
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect();
        let prepended = (spec.sample_rate as usize * 750) / 1000;
        assert!(samples.iter().take(prepended).all(|sample| *sample == 0));
        assert!(samples
            .iter()
            .skip(prepended)
            .take(32)
            .all(|sample| *sample == 1200));

        drop(reader);
        drop(staged_audio);
        assert!(!staged_path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn truncated_wav_removes_staged_file_after_copy_failure() {
        let root = temp_root("truncated-stage");
        let input_path = root.join("truncated.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&40_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&32_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4_u32.to_le_bytes());
        wav.extend_from_slice(&1200_i16.to_le_bytes());
        std::fs::write(&input_path, wav).expect("write truncated WAV");

        stage_macos_speech_input(&input_path, &root)
            .expect_err("truncated sample data must fail during staging");
        let remaining = std::fs::read_dir(&root)
            .expect("read staging directory")
            .map(|entry| entry.expect("read staging entry").path())
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec![input_path]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_audio_bytes_leave_no_materialized_or_staged_files() {
        let root = temp_root("malformed-native-asr");
        let error = transcribe_with_engine_in_temp_dir(
            PlatformEngine::MacosAppleSpeech,
            None,
            Some(b"not a wave file"),
            &root,
            PlatformTranscriptionOptions::default(),
        )
        .expect_err("malformed WAV bytes must fail before helper execution");
        assert!(error.to_string().contains("for macOS Speech input staging"));
        assert_eq!(
            std::fs::read_dir(&root)
                .expect("read test temp directory")
                .count(),
            0,
            "temporary raw audio must be removed on staging errors"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
