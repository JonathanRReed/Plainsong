//! System audio capture for macOS and Windows loopback devices.

use super::to_f32_sample;
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam::channel::TrySendError;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

fn device_name(device: &cpal::Device) -> Result<String, cpal::Error> {
    Ok(device.description()?.name().to_string())
}

fn push_normalized_samples<T>(
    data: &[T],
    buffer: &crossbeam::queue::ArrayQueue<f32>,
    dropped_samples: &AtomicU64,
) where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    for &sample in data {
        let normalized = to_f32_sample(sample);
        if buffer.push(normalized).is_err() {
            let _ = buffer.pop();
            let _ = buffer.push(normalized);
            dropped_samples.fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct LoopbackDeviceSelection {
    device: cpal::Device,
    display_name: String,
    stream_config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
}

const LOOPBACK_KEYWORDS: [&str; 7] = [
    "blackhole",
    "loopback",
    "vb-cable",
    "vb-audio",
    "virtual audio cable",
    "soundflower",
    "stereo mix",
];

fn normalized_audio_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_loopback_identifier(value: &str) -> bool {
    let normalized = normalized_audio_label(value);
    LOOPBACK_KEYWORDS.iter().any(|keyword| {
        let normalized_keyword = normalized_audio_label(keyword);
        normalized.contains(&normalized_keyword)
    })
}

fn device_lookup_label(device: &cpal::Device) -> Option<String> {
    device_name(device).ok()
}

/// System audio capture session helper
pub struct SystemAudioCapture {
    host: cpal::Host,
}

/// Mixed audio capture (microphone + system audio)
pub struct MixedAudioCapture {
    is_capturing: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    dropped_mic_samples: Arc<AtomicU64>,
    dropped_system_samples: Arc<AtomicU64>,
    dropped_mixed_chunks: Arc<AtomicU64>,
}

pub struct MixedAudioCaptureStart {
    pub mixed_receiver: crossbeam::channel::Receiver<Vec<f32>>,
    pub mic_receiver: Option<crossbeam::channel::Receiver<Vec<f32>>>,
    pub system_receiver: Option<crossbeam::channel::Receiver<Vec<f32>>>,
    pub sample_rate: u32,
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        Self {
            host: cpal::default_host(),
        }
    }

    /// Check if system audio capture is available.
    pub fn is_available(&self) -> bool {
        self.find_loopback_device().ok().flatten().is_some()
    }

    fn find_loopback_device(&self) -> Result<Option<LoopbackDeviceSelection>> {
        // CPAL's macOS `input_devices()` filter probes every device's supported
        // input formats. Some CoreAudio devices can block indefinitely during
        // that probe. Enumerate names without filtering, then validate only a
        // matched virtual loopback device with the direct default-config query.
        #[cfg(target_os = "macos")]
        let devices = self
            .host
            .devices()
            .context("Failed to enumerate audio devices")?;

        #[cfg(not(target_os = "macos"))]
        let devices = self
            .host
            .input_devices()
            .context("Failed to enumerate input devices")?;

        for device in devices {
            let Some(label) = device_lookup_label(&device) else {
                continue;
            };
            if !is_loopback_identifier(&label) {
                continue;
            }

            let supported_config = match device.default_input_config() {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!(
                        "Ignoring loopback device without a usable input configuration: {} ({})",
                        label,
                        error
                    );
                    continue;
                }
            };
            let sample_format = supported_config.sample_format();
            let stream_config = supported_config.config();

            tracing::info!("Found loopback device: {}", label);
            return Ok(Some(LoopbackDeviceSelection {
                device,
                display_name: label,
                stream_config,
                sample_format,
            }));
        }

        Ok(None)
    }

    pub fn get_loopback_device_name(&self) -> Result<Option<String>> {
        match self.find_loopback_device()? {
            Some(selection) => Ok(Some(selection.display_name)),
            None => Ok(None),
        }
    }
}

impl MixedAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            dropped_mic_samples: Arc::new(AtomicU64::new(0)),
            dropped_system_samples: Arc::new(AtomicU64::new(0)),
            dropped_mixed_chunks: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn start(
        &mut self,
        capture_mic: bool,
        capture_system: bool,
        mic_device: Option<cpal::Device>,
        waveform_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
        streaming_queue: Option<Arc<crossbeam::queue::ArrayQueue<Vec<f32>>>>,
    ) -> Result<MixedAudioCaptureStart> {
        if !capture_mic && !capture_system {
            return Err(anyhow::anyhow!("Must capture at least one audio source"));
        }

        if self.is_capturing.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Mixed capture already in progress"));
        }

        self.is_capturing.store(true, Ordering::SeqCst);
        self.dropped_mic_samples.store(0, Ordering::SeqCst);
        self.dropped_system_samples.store(0, Ordering::SeqCst);
        self.dropped_mixed_chunks.store(0, Ordering::SeqCst);

        let (mixed_sender, mixed_receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
        let (mic_sender, mic_receiver) = if capture_mic {
            let (sender, receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let (system_sender, system_receiver) = if capture_system {
            let (sender, receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let (ready_tx, ready_rx) =
            crossbeam::channel::bounded::<std::result::Result<u32, String>>(1);
        let is_capturing = Arc::clone(&self.is_capturing);
        let dropped_mic_samples = Arc::clone(&self.dropped_mic_samples);
        let dropped_system_samples = Arc::clone(&self.dropped_system_samples);
        let dropped_mixed_chunks = Arc::clone(&self.dropped_mixed_chunks);

        self.capture_thread = Some(std::thread::spawn(move || {
            const MIXED_BUFFER_CAPACITY: usize = 65_536;
            let host = cpal::default_host();
            let mic_buffer: Arc<crossbeam::queue::ArrayQueue<f32>> =
                Arc::new(crossbeam::queue::ArrayQueue::new(MIXED_BUFFER_CAPACITY));
            let system_buffer: Arc<crossbeam::queue::ArrayQueue<f32>> =
                Arc::new(crossbeam::queue::ArrayQueue::new(MIXED_BUFFER_CAPACITY));

            let mut _mic_stream = None;
            let mut _sys_stream = None;
            let mut mic_sample_rate = None;
            let mut system_sample_rate = None;

            if capture_mic {
                let preferred_mic_device = mic_device.clone();
                let mut setup = || -> Result<cpal::Stream> {
                    let device = preferred_mic_device
                        .clone()
                        .or_else(|| host.default_input_device())
                        .context("No microphone available")?;
                    let config = device.default_input_config()?;
                    mic_sample_rate = Some(config.sample_rate());
                    let sample_format = config.sample_format();
                    let stream_config = config.config();
                    macro_rules! build_mic_stream {
                        ($sample_type:ty) => {{
                            let mic_buffer = Arc::clone(&mic_buffer);
                            let is_capturing = Arc::clone(&is_capturing);
                            let dropped_samples = Arc::clone(&dropped_mic_samples);

                            device.build_input_stream(
                                stream_config.clone(),
                                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                    if is_capturing.load(Ordering::SeqCst) {
                                        push_normalized_samples(
                                            data,
                                            &mic_buffer,
                                            &dropped_samples,
                                        );
                                    }
                                },
                                |err| tracing::error!("Mic stream error: {}", err),
                                None,
                            )
                        }};
                    }

                    let stream = match sample_format {
                        cpal::SampleFormat::I8 => build_mic_stream!(i8),
                        cpal::SampleFormat::I16 => build_mic_stream!(i16),
                        cpal::SampleFormat::I24 => build_mic_stream!(cpal::I24),
                        cpal::SampleFormat::I32 => build_mic_stream!(i32),
                        cpal::SampleFormat::I64 => build_mic_stream!(i64),
                        cpal::SampleFormat::U8 => build_mic_stream!(u8),
                        cpal::SampleFormat::U16 => build_mic_stream!(u16),
                        cpal::SampleFormat::U24 => build_mic_stream!(cpal::U24),
                        cpal::SampleFormat::U32 => build_mic_stream!(u32),
                        cpal::SampleFormat::U64 => build_mic_stream!(u64),
                        cpal::SampleFormat::F32 => build_mic_stream!(f32),
                        cpal::SampleFormat::F64 => build_mic_stream!(f64),
                        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
                    }?;

                    stream.play()?;
                    Ok(stream)
                };

                match setup() {
                    Ok(stream) => _mic_stream = Some(stream),
                    Err(e) => {
                        let message = format!("Failed to start microphone stream: {}", e);
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            if capture_system {
                let mut setup = || -> Result<cpal::Stream> {
                    let sys_capture = SystemAudioCapture::new();
                    let loopback = sys_capture
                        .find_loopback_device()?
                        .ok_or_else(|| anyhow::anyhow!("Loopback device not found"))?;

                    let config = loopback.stream_config;
                    let sample_format = loopback.sample_format;
                    system_sample_rate = Some(config.sample_rate);
                    macro_rules! build_system_stream {
                        ($sample_type:ty) => {{
                            let system_buffer = Arc::clone(&system_buffer);
                            let is_capturing = Arc::clone(&is_capturing);
                            let dropped_samples = Arc::clone(&dropped_system_samples);

                            loopback.device.build_input_stream(
                                config.clone(),
                                move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                                    if is_capturing.load(Ordering::SeqCst) {
                                        push_normalized_samples(
                                            data,
                                            &system_buffer,
                                            &dropped_samples,
                                        );
                                    }
                                },
                                |err| tracing::error!("System stream error: {}", err),
                                None,
                            )
                        }};
                    }

                    let stream = match sample_format {
                        cpal::SampleFormat::I8 => build_system_stream!(i8),
                        cpal::SampleFormat::I16 => build_system_stream!(i16),
                        cpal::SampleFormat::I24 => build_system_stream!(cpal::I24),
                        cpal::SampleFormat::I32 => build_system_stream!(i32),
                        cpal::SampleFormat::I64 => build_system_stream!(i64),
                        cpal::SampleFormat::U8 => build_system_stream!(u8),
                        cpal::SampleFormat::U16 => build_system_stream!(u16),
                        cpal::SampleFormat::U24 => build_system_stream!(cpal::U24),
                        cpal::SampleFormat::U32 => build_system_stream!(u32),
                        cpal::SampleFormat::U64 => build_system_stream!(u64),
                        cpal::SampleFormat::F32 => build_system_stream!(f32),
                        cpal::SampleFormat::F64 => build_system_stream!(f64),
                        _ => Err(cpal::ErrorKind::UnsupportedConfig.into()),
                    }?;

                    stream.play()?;
                    Ok(stream)
                };

                match setup() {
                    Ok(stream) => _sys_stream = Some(stream),
                    Err(e) => {
                        let message = format!("Failed to start system stream: {}", e);
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            let target_sample_rate =
                match resolve_target_sample_rate(mic_sample_rate, system_sample_rate) {
                    Ok(sample_rate) => sample_rate,
                    Err(message) => {
                        tracing::error!("{}", message);
                        let _ = ready_tx.send(Err(message));
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                };

            let _ = ready_tx.send(Ok(target_sample_rate));

            let mut output = Vec::with_capacity(512);
            let mut mic_output = Vec::with_capacity(512);
            let mut system_output = Vec::with_capacity(512);
            while is_capturing.load(Ordering::SeqCst) {
                let mut made_progress = false;

                loop {
                    let mic_sample = if capture_mic { mic_buffer.pop() } else { None };
                    let sys_sample = if capture_system {
                        system_buffer.pop()
                    } else {
                        None
                    };
                    let mic_sample_for_track = mic_sample;
                    let sys_sample_for_track = sys_sample;

                    let mixed_sample = match (mic_sample, sys_sample) {
                        (Some(mic), Some(sys)) => {
                            Some(((mic * 0.7) + (sys * 0.7)).clamp(-1.0, 1.0))
                        }
                        (Some(mic), None) => Some(mic),
                        (None, Some(sys)) => Some(sys),
                        (None, None) => None,
                    };

                    let Some(sample) = mixed_sample else {
                        break;
                    };

                    output.push(sample);
                    if let Some(mic) = mic_sample_for_track {
                        mic_output.push(mic);
                    }
                    if let Some(sys) = sys_sample_for_track {
                        system_output.push(sys);
                    }
                    made_progress = true;

                    if let Ok(mut waveform) = waveform_buffer.lock() {
                        waveform.push(sample);
                        if waveform.len() > 4410 {
                            let drop_count = waveform.len() - 4410;
                            waveform.drain(0..drop_count);
                        }
                    }

                    if output.len() >= 512 {
                        let chunk = std::mem::take(&mut output);
                        if let Some(queue) = streaming_queue.as_ref() {
                            if queue.push(chunk.clone()).is_err() {
                                let _ = queue.pop();
                                let _ = queue.push(chunk.clone());
                            }
                        }
                        match mixed_sender.try_send(chunk) {
                            Ok(()) => {}
                            Err(TrySendError::Disconnected(_)) => {
                                is_capturing.store(false, Ordering::SeqCst);
                                break;
                            }
                            Err(TrySendError::Full(_)) => {
                                dropped_mixed_chunks.fetch_add(1, Ordering::Relaxed);
                            }
                        }

                        if let (Some(sender), false) = (mic_sender.as_ref(), mic_output.is_empty())
                        {
                            let mic_chunk = std::mem::take(&mut mic_output);
                            match sender.try_send(mic_chunk) {
                                Ok(()) => {}
                                Err(TrySendError::Disconnected(_)) => {
                                    is_capturing.store(false, Ordering::SeqCst);
                                    break;
                                }
                                Err(TrySendError::Full(_)) => {
                                    dropped_mixed_chunks.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }

                        if let (Some(sender), false) =
                            (system_sender.as_ref(), system_output.is_empty())
                        {
                            let system_chunk = std::mem::take(&mut system_output);
                            match sender.try_send(system_chunk) {
                                Ok(()) => {}
                                Err(TrySendError::Disconnected(_)) => {
                                    is_capturing.store(false, Ordering::SeqCst);
                                    break;
                                }
                                Err(TrySendError::Full(_)) => {
                                    dropped_mixed_chunks.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                }

                if !made_progress {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }

            if !output.is_empty() {
                if let Some(queue) = streaming_queue.as_ref() {
                    if queue.push(output.clone()).is_err() {
                        let _ = queue.pop();
                        let _ = queue.push(output.clone());
                    }
                }
                match mixed_sender.try_send(output) {
                    Ok(()) => {}
                    Err(TrySendError::Disconnected(_)) => {}
                    Err(TrySendError::Full(_)) => {
                        dropped_mixed_chunks.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }

            if let (Some(sender), false) = (mic_sender.as_ref(), mic_output.is_empty()) {
                let _ = sender.try_send(mic_output);
            }

            if let (Some(sender), false) = (system_sender.as_ref(), system_output.is_empty()) {
                let _ = sender.try_send(system_output);
            }

            let dropped_mic = dropped_mic_samples.load(Ordering::Relaxed);
            let dropped_system = dropped_system_samples.load(Ordering::Relaxed);
            let dropped_chunks = dropped_mixed_chunks.load(Ordering::Relaxed);
            if dropped_mic > 0 || dropped_system > 0 || dropped_chunks > 0 {
                tracing::warn!(
                    "Mixed audio capture dropped samples/chunks (mic={}, system={}, chunks={})",
                    dropped_mic,
                    dropped_system,
                    dropped_chunks
                );
            }
        }));

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(sample_rate)) => {
                tracing::info!(
                    "Mixed audio capture started (mic: {}, system: {}, sample_rate: {} Hz)",
                    capture_mic,
                    capture_system,
                    sample_rate
                );
                Ok(MixedAudioCaptureStart {
                    mixed_receiver,
                    mic_receiver,
                    system_receiver,
                    sample_rate,
                })
            }
            Ok(Err(message)) => {
                self.stop();
                Err(anyhow::anyhow!(message))
            }
            Err(_) => {
                self.stop();
                Err(anyhow::anyhow!(
                    "Timed out waiting for audio capture streams to initialize"
                ))
            }
        }
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let (done_tx, done_rx) = crossbeam::channel::bounded::<()>(1);
            std::thread::spawn(move || {
                let _ = handle.join();
                let _ = done_tx.send(());
            });
            if done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                tracing::warn!("Timed out waiting for mixed capture thread to stop");
            }
        }
        tracing::info!("Mixed audio capture stopped");
    }

    pub fn drop_counts(&self) -> (u64, u64, u64) {
        (
            self.dropped_mic_samples.load(Ordering::Relaxed),
            self.dropped_system_samples.load(Ordering::Relaxed),
            self.dropped_mixed_chunks.load(Ordering::Relaxed),
        )
    }
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for MixedAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_target_sample_rate(
    mic_sample_rate: Option<u32>,
    system_sample_rate: Option<u32>,
) -> std::result::Result<u32, String> {
    match (mic_sample_rate, system_sample_rate) {
        (Some(mic_rate), Some(system_rate)) if mic_rate != system_rate => Err(format!(
            "Microphone and system audio are using different sample rates (mic: {} Hz, system: {} Hz). Align both sources to the same rate before starting a mixed meeting recording.",
            mic_rate, system_rate
        )),
        (Some(mic_rate), Some(_)) => Ok(mic_rate),
        (Some(mic_rate), None) => Ok(mic_rate),
        (None, Some(system_rate)) => Ok(system_rate),
        (None, None) => {
            Err("Unable to determine a sample rate for the requested audio capture sources.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires live CoreAudio device enumeration; covered by the packaged macOS smoke gate"]
    fn live_system_audio_availability_smoke() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let capture = SystemAudioCapture::new();
            let result = capture
                .find_loopback_device()
                .map(|selection| selection.is_some())
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        });

        let available = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("system audio availability must not block setup verification")
            .expect("system audio availability inspection must complete successfully");
        tracing::info!("System audio available: {}", available);
    }

    #[test]
    fn loopback_identifier_matching_covers_supported_virtual_devices() {
        for identifier in [
            "BlackHole2ch_UID",
            "Rogue Amoeba Loopback",
            "VB-CABLE Input",
            "CABLE Output (VB-Audio Virtual Cable)",
            "Soundflower (2ch)",
            "Stereo Mix",
        ] {
            assert!(is_loopback_identifier(identifier), "{identifier}");
        }
        assert!(!is_loopback_identifier("MacBook Pro Microphone"));
        assert!(!is_loopback_identifier("Virtual Microphone"));
    }

    #[test]
    fn normalized_queue_path_keeps_latest_sample_and_counts_overflow() {
        let buffer = crossbeam::queue::ArrayQueue::new(1);
        let dropped_samples = AtomicU64::new(0);

        push_normalized_samples(&[i8::MIN, i8::MAX], &buffer, &dropped_samples);

        assert_eq!(dropped_samples.load(Ordering::Relaxed), 1);
        let latest = buffer.pop().expect("latest normalized sample");
        assert!((latest - 127.0 / 128.0).abs() <= 1.0e-6);
    }

    #[test]
    fn resolve_target_sample_rate_accepts_matching_sources() {
        assert_eq!(
            resolve_target_sample_rate(Some(48_000), Some(48_000)).unwrap(),
            48_000
        );
        assert_eq!(
            resolve_target_sample_rate(Some(44_100), None).unwrap(),
            44_100
        );
        assert_eq!(
            resolve_target_sample_rate(None, Some(48_000)).unwrap(),
            48_000
        );
    }

    #[test]
    fn resolve_target_sample_rate_rejects_mismatched_sources() {
        let error = resolve_target_sample_rate(Some(44_100), Some(48_000)).unwrap_err();
        assert!(error.contains("different sample rates"));
    }
}
