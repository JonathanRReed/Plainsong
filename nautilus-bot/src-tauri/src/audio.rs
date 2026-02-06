pub mod enhance;
pub mod system_capture;
pub mod utils;
pub mod vad;
pub mod waveform;

use crate::audio::enhance::AudioPreprocessor;
use crate::audio::system_capture::MixedAudioCapture;
use crate::audio::vad::{VadConfig, VoiceActivityDetector};
use crate::models::RecordingOptions;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam::channel::{bounded, Receiver, Sender};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct AudioCapture {
    is_dictating: Arc<AtomicBool>,
    dictation_buffer: Arc<crossbeam::queue::SegQueue<f32>>,
    dictation_thread: Option<JoinHandle<()>>,
    dictation_sample_rate: u32,
    recordings_dir: PathBuf,
    host: cpal::Host,
    active_recording: Option<ActiveRecordingSession>,
    /// Voice Activity Detector for auto-stop on silence
    vad: Option<VoiceActivityDetector>,
    /// Audio preprocessor for noise suppression
    preprocessor: Option<AudioPreprocessor>,
    /// Enable VAD auto-stop
    vad_enabled: bool,
    /// Enable noise suppression
    noise_suppression_enabled: bool,
}

#[allow(dead_code)]
pub struct RecordingSession {
    pub id: String,
    pub started_at: Instant,
    pub audio_path: PathBuf,
    pub options: RecordingOptions,
    pub stop_sender: Sender<()>,
    pub samples_sender: Sender<Vec<f32>>,
    pub samples_receiver: Receiver<Vec<f32>>,
    pub waveform_buffer: Arc<crossbeam::queue::SegQueue<f32>>,
}

struct ActiveRecordingSession {
    id: String,
    audio_path: PathBuf,
    stop_sender: Sender<()>,
    writer_handle: Option<JoinHandle<()>>,
    capture_stop_flag: Arc<AtomicBool>,
    capture_handle: Option<JoinHandle<()>>,
    mixed_capture: Option<MixedAudioCapture>,
    waveform_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
}

#[allow(dead_code)]
pub struct WaveformData {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl AudioCapture {
    pub fn new() -> Self {
        let recordings_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("recordings");

        std::fs::create_dir_all(&recordings_dir).ok();

        let host = cpal::default_host();

        Self {
            is_dictating: Arc::new(AtomicBool::new(false)),
            dictation_buffer: Arc::new(crossbeam::queue::SegQueue::new()),
            dictation_thread: None,
            dictation_sample_rate: 16000,
            recordings_dir,
            host,
            active_recording: None,
            vad: None,
            preprocessor: None,
            vad_enabled: true,
            noise_suppression_enabled: true,
        }
    }

    /// Check if system audio capture is available
    pub fn is_system_audio_available(&self) -> bool {
        let sys_capture = system_capture::SystemAudioCapture::new();
        sys_capture.is_available()
    }

    /// Get the name of the detected loopback device
    pub fn get_loopback_device_name(&self) -> Option<String> {
        let sys_capture = system_capture::SystemAudioCapture::new();
        sys_capture.get_loopback_device_name().ok().flatten()
    }

    pub fn start_dictation(&mut self) -> Result<()> {
        if self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Dictation already in progress"));
        }

        // Clear previous buffer
        while self.dictation_buffer.pop().is_some() {}

        self.is_dictating.store(true, Ordering::SeqCst);

        let sample_rate = self
            .host
            .default_input_device()
            .context("No input device available")?
            .default_input_config()?
            .sample_rate()
            .0;
        self.dictation_sample_rate = sample_rate;
        tracing::info!("Starting dictation");

        let is_dictating = Arc::clone(&self.is_dictating);
        let buffer = Arc::clone(&self.dictation_buffer);

        let capture_handle = std::thread::spawn(move || {
            let capture_flag = Arc::clone(&is_dictating);
            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(device) => device,
                None => {
                    tracing::error!("No input device available for dictation");
                    return;
                }
            };
            let config = match device.default_input_config() {
                Ok(config) => config,
                Err(e) => {
                    tracing::error!("Failed to fetch dictation input config: {}", e);
                    return;
                }
            };
            let err_fn = |err| tracing::error!("Dictation stream error: {}", err);
            let is_dictating_f32 = Arc::clone(&is_dictating);
            let is_dictating_i16 = Arc::clone(&is_dictating);

            let stream_result = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if is_dictating_f32.load(Ordering::SeqCst) {
                            for &sample in data {
                                buffer.push(sample);
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if is_dictating_i16.load(Ordering::SeqCst) {
                            for &sample in data {
                                buffer.push(sample as f32 / i16::MAX as f32);
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
            };

            let Ok(stream) = stream_result else {
                tracing::error!("Failed to build dictation stream");
                return;
            };

            if let Err(e) = stream.play() {
                tracing::error!("Failed to play dictation stream: {}", e);
                return;
            }

            while capture_flag.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            drop(stream);
        });
        self.dictation_thread = Some(capture_handle);

        tracing::info!("Dictation started");
        Ok(())
    }

    pub fn stop_dictation(&mut self) -> Result<Vec<u8>> {
        if !self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("No dictation in progress"));
        }

        self.is_dictating.store(false, Ordering::SeqCst);
        if let Some(handle) = self.dictation_thread.take() {
            let _ = handle.join();
        }

        // Collect samples from buffer
        let mut samples = Vec::new();
        while let Some(sample) = self.dictation_buffer.pop() {
            samples.push(sample);
        }

        tracing::info!("Dictation stopped, captured {} samples", samples.len());

        // Convert to WAV format
        let wav_data = encode_wav(&samples, self.dictation_sample_rate, 1)?;

        Ok(wav_data)
    }

    pub fn start_recording(&mut self, options: RecordingOptions) -> Result<String> {
        if self.active_recording.is_some() {
            return Err(anyhow::anyhow!("A recording session is already active"));
        }
        if !options.mic && !options.system_audio {
            return Err(anyhow::anyhow!(
                "Must enable microphone or system audio capture"
            ));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let filename = format!("recording_{}_{}.wav", timestamp, &id[..8]);
        let audio_path = self.recordings_dir.join(&filename);
        let (stop_sender, stop_receiver) = bounded::<()>(1);
        let waveform_buffer = Arc::new(std::sync::Mutex::new(Vec::with_capacity(4410)));

        tracing::info!(
            "Starting recording {} (mic: {}, system: {})",
            id,
            options.mic,
            options.system_audio
        );

        // Use MixedAudioCapture if system audio is requested
        if options.system_audio {
            let mut mixed_capture = MixedAudioCapture::new();
            let receiver = mixed_capture
                .start(
                    options.mic,
                    options.system_audio,
                    Arc::clone(&waveform_buffer),
                )
                .context("Failed to start mixed audio capture")?;

            // Spawn writer thread for mixed audio
            let audio_path_clone = audio_path.clone();
            let writer_handle = std::thread::spawn(move || {
                if let Err(e) = write_wav_file(&audio_path_clone, receiver, stop_receiver, 44100) {
                    tracing::error!("Failed to write WAV file: {}", e);
                }
            });

            self.active_recording = Some(ActiveRecordingSession {
                id: id.clone(),
                audio_path,
                stop_sender,
                writer_handle: Some(writer_handle),
                capture_stop_flag: Arc::new(AtomicBool::new(false)),
                capture_handle: None,
                mixed_capture: Some(mixed_capture),
                waveform_buffer,
            });
        } else {
            // Standard microphone-only recording
            let (samples_sender, samples_receiver) = bounded::<Vec<f32>>(100);
            let wf_buffer = Arc::clone(&waveform_buffer);
            let audio_path_clone = audio_path.clone();
            let capture_stop_flag = Arc::new(AtomicBool::new(true));
            let capture_flag = Arc::clone(&capture_stop_flag);

            let capture_handle = std::thread::spawn(move || {
                let host = cpal::default_host();
                let Some(device) = host.default_input_device() else {
                    tracing::error!("No input device available");
                    return;
                };
                let Ok(config) = device.default_input_config() else {
                    tracing::error!("Failed to read input config");
                    return;
                };

                let err_fn = |err| tracing::error!("Stream error: {}", err);
                let stream_result = match config.sample_format() {
                    cpal::SampleFormat::F32 => device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            let chunk: Vec<f32> = data.to_vec();

                            if let Ok(mut waveform) = wf_buffer.lock() {
                                for &sample in data.iter().step_by(data.len() / 100 + 1).take(100) {
                                    waveform.push(sample);
                                }
                                if waveform.len() > 4410 {
                                    let drop_count = waveform.len() - 4410;
                                    waveform.drain(0..drop_count);
                                }
                            }

                            let _ = samples_sender.send(chunk);
                        },
                        err_fn,
                        None,
                    ),
                    cpal::SampleFormat::I16 => device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            let chunk: Vec<f32> =
                                data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();

                            if let Ok(mut waveform) = wf_buffer.lock() {
                                for &sample in chunk.iter().step_by(chunk.len() / 100 + 1).take(100)
                                {
                                    waveform.push(sample);
                                }
                                if waveform.len() > 4410 {
                                    let drop_count = waveform.len() - 4410;
                                    waveform.drain(0..drop_count);
                                }
                            }

                            let _ = samples_sender.send(chunk);
                        },
                        err_fn,
                        None,
                    ),
                    _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
                };

                let Ok(stream) = stream_result else {
                    tracing::error!("Failed to build microphone input stream");
                    return;
                };

                if let Err(e) = stream.play() {
                    tracing::error!("Failed to play microphone stream: {}", e);
                    return;
                }

                while capture_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }

                drop(stream);
            });

            let sample_rate = self
                .host
                .default_input_device()
                .context("No input device available")?
                .default_input_config()?
                .sample_rate()
                .0;

            // Spawn writer thread
            let writer_handle = std::thread::spawn(move || {
                if let Err(e) = write_wav_file(
                    &audio_path_clone,
                    samples_receiver,
                    stop_receiver,
                    sample_rate,
                ) {
                    tracing::error!("Failed to write WAV file: {}", e);
                }
            });

            self.active_recording = Some(ActiveRecordingSession {
                id: id.clone(),
                audio_path,
                stop_sender,
                writer_handle: Some(writer_handle),
                capture_stop_flag,
                capture_handle: Some(capture_handle),
                mixed_capture: None,
                waveform_buffer,
            });
        }

        tracing::info!("Recording started: {}", id);
        Ok(id)
    }

    pub fn stop_recording(&mut self, recording_id: &str) -> Result<(String, String)> {
        tracing::info!("Stopping recording: {}", recording_id);

        let mut session = self
            .active_recording
            .take()
            .ok_or_else(|| anyhow::anyhow!("No active recording session"))?;

        if session.id != recording_id {
            self.active_recording = Some(session);
            return Err(anyhow::anyhow!(
                "Recording ID mismatch: active={}, requested={}",
                self.active_recording
                    .as_ref()
                    .map(|s| s.id.as_str())
                    .unwrap_or("unknown"),
                recording_id
            ));
        }

        let _ = session.stop_sender.send(());
        session.capture_stop_flag.store(false, Ordering::SeqCst);
        if let Some(handle) = session.capture_handle.take() {
            let _ = handle.join();
        }
        if let Some(mut mixed_capture) = session.mixed_capture.take() {
            mixed_capture.stop();
        }

        if let Some(handle) = session.writer_handle.take() {
            let _ = handle.join();
        }

        let path = session.audio_path;
        tracing::info!("Recording saved to: {:?}", path);

        let hash = compute_file_hash(&path)?;
        tracing::info!("Recording SHA256: {}", hash);

        Ok((path.to_string_lossy().to_string(), hash))
    }

    pub fn get_waveform_data(&self, recording_id: &str) -> Option<Vec<f32>> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        session
            .waveform_buffer
            .lock()
            .ok()
            .map(|buffer| buffer.clone())
    }

    /// Enable or disable VAD for auto-stop on silence
    pub fn set_vad_enabled(&mut self, enabled: bool) {
        self.vad_enabled = enabled;
        if enabled && self.vad.is_none() {
            self.vad = Some(VoiceActivityDetector::new(VadConfig::default()));
        }
        tracing::info!(
            "VAD auto-stop {}",
            if enabled { "enabled" } else { "disabled" }
        );
    }

    /// Enable or disable noise suppression
    pub fn set_noise_suppression_enabled(&mut self, enabled: bool) {
        self.noise_suppression_enabled = enabled;
        if enabled && self.preprocessor.is_none() {
            self.preprocessor = Some(AudioPreprocessor::new(16000));
        }
        tracing::info!(
            "Noise suppression {}",
            if enabled { "enabled" } else { "disabled" }
        );
    }

    /// Get VAD status
    pub fn is_vad_enabled(&self) -> bool {
        self.vad_enabled
    }

    /// Get noise suppression status
    pub fn is_noise_suppression_enabled(&self) -> bool {
        self.noise_suppression_enabled
    }

    /// Generate waveform for a recording file
    #[allow(dead_code)]
    pub fn generate_waveform(&self, recording_path: &str) -> Result<waveform::WaveformData> {
        waveform::generate_waveform_from_file(recording_path, 200)
    }

    #[allow(dead_code)]
    pub fn is_dictating(&self) -> bool {
        self.is_dictating.load(Ordering::SeqCst)
    }
}

fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();

    let num_samples = samples.len();
    let byte_rate = sample_rate * channels as u32 * 2;
    let data_size = num_samples * 2;

    // RIFF header
    buffer.extend_from_slice(b"RIFF");
    buffer.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    buffer.extend_from_slice(b"WAVE");

    // fmt chunk
    buffer.extend_from_slice(b"fmt ");
    buffer.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size
    buffer.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat (PCM)
    buffer.extend_from_slice(&channels.to_le_bytes());
    buffer.extend_from_slice(&sample_rate.to_le_bytes());
    buffer.extend_from_slice(&byte_rate.to_le_bytes());
    buffer.extend_from_slice(&(channels * 2).to_le_bytes()); // BlockAlign
    buffer.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample

    // data chunk
    buffer.extend_from_slice(b"data");
    buffer.extend_from_slice(&(data_size as u32).to_le_bytes());

    // Convert f32 samples to i16
    for sample in samples {
        let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        buffer.extend_from_slice(&int_sample.to_le_bytes());
    }

    Ok(buffer)
}

fn write_wav_file(
    path: &PathBuf,
    receiver: Receiver<Vec<f32>>,
    stop_receiver: Receiver<()>,
    sample_rate: u32,
) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    use std::fs::File;
    use std::io::BufWriter;

    let file = File::create(path)?;
    let writer = BufWriter::new(file);
    let mut wav_writer = hound::WavWriter::new(writer, spec)?;

    loop {
        crossbeam::select! {
            recv(receiver) -> msg => {
                match msg {
                    Ok(samples) => {
                        for sample in samples {
                            wav_writer.write_sample((sample * 32767.0) as i16)?;
                        }
                    }
                    Err(_) => break,
                }
            }
            recv(stop_receiver) -> _ => {
                break;
            }
        }
    }

    wav_writer.finalize()?;
    tracing::info!("WAV file written: {:?}", path);

    Ok(())
}

/// Compute SHA256 hash of a file
fn compute_file_hash(path: &PathBuf) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}
