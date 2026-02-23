pub mod enhance;
pub mod mel;
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DICTATION_STOP_CAPTURE_TAIL_MS: u64 = 120;

pub struct AudioCapture {
    is_dictating: Arc<AtomicBool>,
    dictation_buffer: Arc<crossbeam::queue::SegQueue<f32>>,
    /// Streaming queue for real-time partial transcription during dictation
    dictation_stream_queue: Arc<crossbeam::queue::SegQueue<Vec<f32>>>,
    dictation_thread: Option<JoinHandle<()>>,
    dictation_sample_rate: u32,
    dictation_channels: u16,
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
    /// Current audio level (0.0 to 1.0) for visualization
    dictation_audio_level: Arc<std::sync::atomic::AtomicU32>,
    /// Last speech detection timestamp (milliseconds since start) for auto-stop
    last_speech_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Dictation start instant for timing
    dictation_start: Arc<std::sync::Mutex<Option<Instant>>>,
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
    /// Shared queue for streaming preview: capture threads push chunks here
    pub streaming_queue: Arc<crossbeam::queue::SegQueue<Vec<f32>>>,
    /// Sample rate used by this recording
    pub sample_rate: u32,
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

        let default_vad_config = VadConfig::default();
        let preprocessor = AudioPreprocessor::new(16000);
        let vad = VoiceActivityDetector::new(default_vad_config);

        Self {
            is_dictating: Arc::new(AtomicBool::new(false)),
            dictation_buffer: Arc::new(crossbeam::queue::SegQueue::new()),
            dictation_stream_queue: Arc::new(crossbeam::queue::SegQueue::new()),
            dictation_thread: None,
            dictation_sample_rate: 16000,
            dictation_channels: 1,
            recordings_dir,
            host,
            active_recording: None,
            vad: Some(vad),
            preprocessor: Some(preprocessor),
            vad_enabled: true,
            noise_suppression_enabled: true,
            dictation_audio_level: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            last_speech_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            dictation_start: Arc::new(std::sync::Mutex::new(None)),
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

        while self.dictation_buffer.pop().is_some() {}
        while self.dictation_stream_queue.pop().is_some() {}

        let device = self
            .host
            .default_input_device()
            .context("No input device available")?;

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        self.dictation_sample_rate = sample_rate;
        self.dictation_channels = channels;

        tracing::info!(
            "Starting dictation capture: {} channels, {} Hz, format: {:?}",
            channels,
            sample_rate,
            config.sample_format()
        );

        self.is_dictating.store(true, Ordering::SeqCst);

        // Reset speech tracking
        self.last_speech_ms.store(0, Ordering::SeqCst);
        *self.dictation_start.lock().unwrap() = Some(Instant::now());

        let is_dictating = Arc::clone(&self.is_dictating);
        let buffer = Arc::clone(&self.dictation_buffer);
        let _stream_queue = Arc::clone(&self.dictation_stream_queue);
        let stream_ready = Arc::new(AtomicBool::new(false));
        let stream_ready_signal = Arc::clone(&stream_ready);
        let audio_level = Arc::clone(&self.dictation_audio_level);
        let last_speech_ms = Arc::clone(&self.last_speech_ms);
        let dictation_start = Arc::clone(&self.dictation_start);

        let capture_handle = std::thread::spawn(move || {
            let capture_flag = Arc::clone(&is_dictating);
            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(device) => device,
                None => {
                    tracing::error!("No input device available for dictation capture thread");
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
            let num_channels = config.channels() as usize;
            let err_fn = |err| tracing::error!("Dictation stream error: {}", err);
            let is_dictating_f32 = Arc::clone(&is_dictating);
            let is_dictating_i16 = Arc::clone(&is_dictating);
            let is_dictating_u8 = Arc::clone(&is_dictating);
            let audio_level_f32 = Arc::clone(&audio_level);
            let audio_level_i16 = Arc::clone(&audio_level);
            let audio_level_u8 = Arc::clone(&audio_level);
            let last_speech_f32 = Arc::clone(&last_speech_ms);
            let last_speech_i16 = Arc::clone(&last_speech_ms);
            let last_speech_u8 = Arc::clone(&last_speech_ms);
            let dictation_start_f32 = Arc::clone(&dictation_start);
            let dictation_start_i16 = Arc::clone(&dictation_start);
            let dictation_start_u8 = Arc::clone(&dictation_start);
            const SPEECH_THRESHOLD: f32 = 0.02;

            let stream_result = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if is_dictating_f32.load(Ordering::SeqCst) {
                            let mut sum_sq: f64 = 0.0;
                            if num_channels == 1 {
                                for &sample in data {
                                    buffer.push(sample);
                                    sum_sq += (sample as f64) * (sample as f64);
                                }
                            } else {
                                for chunk in data.chunks_exact(num_channels) {
                                    let mono: f32 = chunk.iter().sum::<f32>() / num_channels as f32;
                                    buffer.push(mono);
                                    sum_sq += (mono as f64) * (mono as f64);
                                }
                            }
                            let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                            let level = (rms.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
                            audio_level_f32.store(level, Ordering::SeqCst);
                            if rms > SPEECH_THRESHOLD {
                                if let Some(start) = dictation_start_f32.lock().unwrap().as_ref() {
                                    let elapsed_ms = start.elapsed().as_millis() as u64;
                                    last_speech_f32.store(elapsed_ms, Ordering::SeqCst);
                                }
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
                            let mut sum_sq: f64 = 0.0;
                            if num_channels == 1 {
                                for &sample in data {
                                    let f = sample as f32 / i16::MAX as f32;
                                    buffer.push(f);
                                    sum_sq += (f as f64) * (f as f64);
                                }
                            } else {
                                for chunk in data.chunks_exact(num_channels) {
                                    let mono: f32 = chunk
                                        .iter()
                                        .map(|&s| s as f32 / i16::MAX as f32)
                                        .sum::<f32>()
                                        / num_channels as f32;
                                    buffer.push(mono);
                                    sum_sq += (mono as f64) * (mono as f64);
                                }
                            }
                            let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                            let level = (rms.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
                            audio_level_i16.store(level, Ordering::SeqCst);
                            if rms > SPEECH_THRESHOLD {
                                if let Some(start) = dictation_start_i16.lock().unwrap().as_ref() {
                                    let elapsed_ms = start.elapsed().as_millis() as u64;
                                    last_speech_i16.store(elapsed_ms, Ordering::SeqCst);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U8 => device.build_input_stream(
                    &config.into(),
                    move |data: &[u8], _: &cpal::InputCallbackInfo| {
                        if is_dictating_u8.load(Ordering::SeqCst) {
                            let mut sum_sq: f64 = 0.0;
                            if num_channels == 1 {
                                for &sample in data {
                                    let f = (sample as f32 - 128.0) / 128.0;
                                    buffer.push(f);
                                    sum_sq += (f as f64) * (f as f64);
                                }
                            } else {
                                for chunk in data.chunks_exact(num_channels) {
                                    let mono: f32 = chunk
                                        .iter()
                                        .map(|&s| (s as f32 - 128.0) / 128.0)
                                        .sum::<f32>()
                                        / num_channels as f32;
                                    buffer.push(mono);
                                    sum_sq += (mono as f64) * (mono as f64);
                                }
                            }
                            let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                            let level = (rms.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
                            audio_level_u8.store(level, Ordering::SeqCst);
                            if rms > SPEECH_THRESHOLD {
                                if let Some(start) = dictation_start_u8.lock().unwrap().as_ref() {
                                    let elapsed_ms = start.elapsed().as_millis() as u64;
                                    last_speech_u8.store(elapsed_ms, Ordering::SeqCst);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                format => {
                    tracing::error!("Unsupported sample format for dictation: {:?}", format);
                    return;
                }
            };

            let Ok(stream) = stream_result else {
                tracing::error!("Failed to build dictation stream");
                return;
            };

            if let Err(e) = stream.play() {
                tracing::error!("Failed to start dictation stream: {}", e);
                return;
            }

            // Signal that the audio stream is now live
            stream_ready_signal.store(true, Ordering::SeqCst);
            tracing::info!("Dictation audio stream started successfully");

            while capture_flag.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            tracing::info!("Dictation audio stream stopping");
            drop(stream);
        });
        self.dictation_thread = Some(capture_handle);

        // Wait for the audio stream to actually start (up to 500ms)
        let deadline = Instant::now() + Duration::from_millis(500);
        while !stream_ready.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if stream_ready.load(Ordering::SeqCst) {
            tracing::info!("Dictation started (stream confirmed live)");
        } else {
            tracing::warn!("Dictation started but stream-ready signal timed out after 500ms");
        }

        Ok(())
    }

    pub fn stop_dictation(&mut self) -> Result<Vec<u8>> {
        if !self.is_dictating.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("No dictation in progress"));
        }

        tracing::info!("Stopping dictation capture...");
        std::thread::sleep(Duration::from_millis(DICTATION_STOP_CAPTURE_TAIL_MS));
        self.is_dictating.store(false, Ordering::SeqCst);

        if let Some(handle) = self.dictation_thread.take() {
            let (done_tx, done_rx) = bounded::<()>(1);
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Dictation thread join error: {:?}", e);
                }
                let _ = done_tx.send(());
            });
            if done_rx.recv_timeout(Duration::from_millis(500)).is_err() {
                tracing::warn!(
                    "Timed out waiting for dictation capture thread to join; continuing stop path"
                );
            }
        }

        let mut samples = Vec::new();
        while let Some(sample) = self.dictation_buffer.pop() {
            samples.push(sample);
        }

        tracing::info!(
            "Collected {} samples from dictation buffer (sample rate: {} Hz)",
            samples.len(),
            self.dictation_sample_rate
        );

        if samples.is_empty() {
            tracing::warn!("No audio samples captured during dictation!");
            return Err(anyhow::anyhow!(
                "No audio was captured. Please check microphone permissions."
            ));
        }

        // Log audio statistics for debugging
        let peak = samples.iter().fold(0.0_f32, |p, s| p.max(s.abs()));
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        tracing::info!(
            "Audio stats: peak={}, rms={}, duration={}ms",
            peak,
            rms,
            (samples.len() as f64 / self.dictation_sample_rate as f64 * 1000.0) as i64
        );

        // Apply noise suppression before encoding if enabled
        if self.noise_suppression_enabled {
            if let Some(preprocessor) = &mut self.preprocessor {
                preprocessor.auto_calibrate(&samples, self.dictation_sample_rate);
                if let Err(e) = preprocessor.process(&mut samples) {
                    tracing::warn!("Noise suppression failed, using raw audio: {}", e);
                }
            }
        }

        boost_quiet_audio(&mut samples);
        ensure_min_duration(&mut samples, self.dictation_sample_rate, 1.1);

        tracing::info!(
            "Dictation stopped: {} mono samples at {} Hz (after processing)",
            samples.len(),
            self.dictation_sample_rate
        );

        let wav_data = encode_wav(&samples, self.dictation_sample_rate, 1)?;

        tracing::info!("WAV data size: {} bytes", wav_data.len());

        Ok(wav_data)
    }

    pub fn abort_dictation(&mut self) {
        self.is_dictating.store(false, Ordering::SeqCst);

        if let Some(handle) = self.dictation_thread.take() {
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Dictation thread join error during abort: {:?}", e);
                }
            });
        }

        while self.dictation_buffer.pop().is_some() {}
    }

    /// Get the current audio level for dictation (0.0 to 1.0)
    /// Uses power scaling to make normal speech levels more visible
    pub fn get_dictation_audio_level(&self) -> f32 {
        let level = self.dictation_audio_level.load(Ordering::SeqCst);
        let raw = level as f32 / u32::MAX as f32;
        // Apply power curve: sqrt makes low levels more visible
        // Normal speech RMS ~0.01-0.15, after sqrt: 0.1-0.39
        // Louder speech RMS ~0.1-0.5, after sqrt: 0.32-0.71
        raw.sqrt()
    }

    /// Get the current silence duration in seconds (time since last speech detected)
    pub fn get_silence_duration_seconds(&self) -> f32 {
        let start_guard = self.dictation_start.lock().unwrap();
        let start = match start_guard.as_ref() {
            Some(s) => s,
            None => return 0.0,
        };
        let current_ms = start.elapsed().as_millis() as u64;
        let last_speech_ms = self.last_speech_ms.load(Ordering::SeqCst);
        drop(start_guard);

        if last_speech_ms == 0 {
            return 0.0;
        }

        if current_ms > last_speech_ms {
            (current_ms - last_speech_ms) as f32 / 1000.0
        } else {
            0.0
        }
    }

    /// Check if silence timeout has been exceeded and auto-stop should trigger
    pub fn should_auto_stop_on_silence(&self, timeout_seconds: f32) -> bool {
        if timeout_seconds <= 0.0 {
            return false;
        }
        self.get_silence_duration_seconds() >= timeout_seconds
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

        let streaming_queue: Arc<crossbeam::queue::SegQueue<Vec<f32>>> =
            Arc::new(crossbeam::queue::SegQueue::new());

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
                streaming_queue,
                sample_rate: 44100,
            });
        } else {
            // Standard microphone-only recording
            let (samples_sender, samples_receiver) = bounded::<Vec<f32>>(100);
            let wf_buffer = Arc::clone(&waveform_buffer);
            let audio_path_clone = audio_path.clone();
            let capture_stop_flag = Arc::new(AtomicBool::new(true));
            let capture_flag = Arc::clone(&capture_stop_flag);

            let stream_queue_clone = Arc::clone(&streaming_queue);
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

                let sq_f32 = Arc::clone(&stream_queue_clone);
                let sq_i16 = Arc::clone(&stream_queue_clone);
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

                            sq_f32.push(chunk.clone());
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

                            sq_i16.push(chunk.clone());
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
                streaming_queue,
                sample_rate,
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
        
        // Don't block on thread joins - spawn background task to wait
        if let Some(handle) = session.capture_handle.take() {
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Capture thread join error: {:?}", e);
                }
            });
        }
        if let Some(mut mixed_capture) = session.mixed_capture.take() {
            mixed_capture.stop();
        }

        if let Some(handle) = session.writer_handle.take() {
            std::thread::spawn(move || {
                if let Err(e) = handle.join() {
                    tracing::warn!("Writer thread join error: {:?}", e);
                }
            });
        }

        let path = session.audio_path;
        tracing::info!("Recording saved to: {:?}", path);

        // Hash computation may fail if file is still being written - that's OK
        let hash = compute_file_hash(&path).unwrap_or_else(|e| {
            tracing::warn!("Could not compute file hash (file may still be writing): {}", e);
            "pending".to_string()
        });
        tracing::info!("Recording SHA256: {}", hash);

        Ok((path.to_string_lossy().to_string(), hash))
    }

    /// Returns the streaming sample queue and sample rate for the active recording.
    /// The caller should drain this queue periodically and feed samples to StreamingTranscriber.
    pub fn get_streaming_queue(
        &self,
        recording_id: &str,
    ) -> Option<(Arc<crossbeam::queue::SegQueue<Vec<f32>>>, u32)> {
        let session = self.active_recording.as_ref()?;
        if session.id != recording_id {
            return None;
        }
        Some((Arc::clone(&session.streaming_queue), session.sample_rate))
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

    pub fn is_recording(&self) -> bool {
        self.active_recording.is_some()
    }

    pub fn has_microphone_input(&self) -> bool {
        self.host.default_input_device().is_some()
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
                        let mut samples = samples;
                        boost_quiet_audio(&mut samples);
                        for sample in samples {
                            wav_writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)?;
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

fn boost_quiet_audio(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }

    let peak = samples.iter().fold(0.0_f32, |current_peak, sample| {
        current_peak.max(sample.abs())
    });

    if peak <= 0.0 || peak >= 0.30 {
        return;
    }

    let gain = (0.45 / peak).clamp(1.0, 2.8);
    for sample in samples.iter_mut() {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
}

fn ensure_min_duration(samples: &mut Vec<f32>, sample_rate: u32, min_seconds: f32) {
    if sample_rate == 0 || min_seconds <= 0.0 {
        return;
    }

    let min_samples = (sample_rate as f32 * min_seconds).ceil() as usize;
    if samples.len() >= min_samples {
        return;
    }

    samples.resize(min_samples, 0.0);
}
