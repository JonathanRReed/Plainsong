//! System audio capture for macOS and Windows loopback devices.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam::channel::TrySendError;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

fn device_name(device: &cpal::Device) -> Result<String, cpal::DeviceNameError> {
    Ok(device.description()?.name().to_string())
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

    fn find_loopback_device(&self) -> Result<Option<cpal::Device>> {
        let devices = self
            .host
            .input_devices()
            .context("Failed to enumerate input devices")?;

        let loopback_keywords = [
            "blackhole",
            "loopback",
            "vb-cable",
            "virtual",
            "soundflower",
            "stereo mix",
        ];

        for device in devices {
            if let Ok(name) = device_name(&device) {
                let name_lower = name.to_lowercase();
                if loopback_keywords.iter().any(|&kw| name_lower.contains(kw)) {
                    tracing::info!("Found loopback device: {}", name);
                    return Ok(Some(device));
                }
            }
        }

        Ok(None)
    }

    pub fn get_loopback_device_name(&self) -> Result<Option<String>> {
        match self.find_loopback_device()? {
            Some(device) => Ok(Some(device_name(&device)?)),
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
                    let mic_buf = Arc::clone(&mic_buffer);
                    let is_cap = Arc::clone(&is_capturing);
                    let dropped_samples_f32 = Arc::clone(&dropped_mic_samples);
                    let dropped_samples_i16 = Arc::clone(&dropped_mic_samples);

                    let stream = match config.sample_format() {
                        cpal::SampleFormat::F32 => device.build_input_stream(
                            &config.into(),
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        if mic_buf.push(sample).is_err() {
                                            let _ = mic_buf.pop();
                                            let _ = mic_buf.push(sample);
                                            dropped_samples_f32.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            },
                            |err| tracing::error!("Mic stream error: {}", err),
                            None,
                        ),
                        cpal::SampleFormat::I16 => device.build_input_stream(
                            &config.into(),
                            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        let normalized = sample as f32 / i16::MAX as f32;
                                        if mic_buf.push(normalized).is_err() {
                                            let _ = mic_buf.pop();
                                            let _ = mic_buf.push(normalized);
                                            dropped_samples_i16.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            },
                            |err| tracing::error!("Mic stream error: {}", err),
                            None,
                        ),
                        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
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
                    let loopback_device = sys_capture
                        .find_loopback_device()?
                        .ok_or_else(|| anyhow::anyhow!("Loopback device not found"))?;

                    let config = loopback_device.default_input_config()?;
                    system_sample_rate = Some(config.sample_rate());
                    let sys_buf = Arc::clone(&system_buffer);
                    let is_cap = Arc::clone(&is_capturing);
                    let dropped_samples_f32 = Arc::clone(&dropped_system_samples);
                    let dropped_samples_i16 = Arc::clone(&dropped_system_samples);

                    let stream = match config.sample_format() {
                        cpal::SampleFormat::F32 => loopback_device.build_input_stream(
                            &config.into(),
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        if sys_buf.push(sample).is_err() {
                                            let _ = sys_buf.pop();
                                            let _ = sys_buf.push(sample);
                                            dropped_samples_f32.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            },
                            |err| tracing::error!("System stream error: {}", err),
                            None,
                        ),
                        cpal::SampleFormat::I16 => loopback_device.build_input_stream(
                            &config.into(),
                            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        let normalized = sample as f32 / i16::MAX as f32;
                                        if sys_buf.push(normalized).is_err() {
                                            let _ = sys_buf.pop();
                                            let _ = sys_buf.push(normalized);
                                            dropped_samples_i16.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            },
                            |err| tracing::error!("System stream error: {}", err),
                            None,
                        ),
                        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
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

    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
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
    fn test_system_audio_available() {
        let capture = SystemAudioCapture::new();
        let available = capture.is_available();
        tracing::info!("System audio available: {}", available);
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
