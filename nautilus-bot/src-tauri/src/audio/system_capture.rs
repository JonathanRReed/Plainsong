//! System audio capture for macOS and Windows loopback devices.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

/// System audio capture session helper
pub struct SystemAudioCapture {
    host: cpal::Host,
}

/// Mixed audio capture (microphone + system audio)
pub struct MixedAudioCapture {
    is_capturing: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
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
            if let Ok(name) = device.name() {
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
            Some(device) => Ok(Some(device.name()?)),
            None => Ok(None),
        }
    }
}

impl MixedAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
        }
    }

    pub fn start(
        &mut self,
        capture_mic: bool,
        capture_system: bool,
        waveform_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    ) -> Result<crossbeam::channel::Receiver<Vec<f32>>> {
        if !capture_mic && !capture_system {
            return Err(anyhow::anyhow!("Must capture at least one audio source"));
        }

        if self.is_capturing.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Mixed capture already in progress"));
        }

        self.is_capturing.store(true, Ordering::SeqCst);

        let (sender, receiver) = crossbeam::channel::bounded::<Vec<f32>>(100);
        let is_capturing = Arc::clone(&self.is_capturing);

        self.capture_thread = Some(std::thread::spawn(move || {
            let host = cpal::default_host();
            let mic_buffer: Arc<crossbeam::queue::SegQueue<f32>> =
                Arc::new(crossbeam::queue::SegQueue::new());
            let system_buffer: Arc<crossbeam::queue::SegQueue<f32>> =
                Arc::new(crossbeam::queue::SegQueue::new());

            let mut _mic_stream = None;
            let mut _sys_stream = None;

            if capture_mic {
                let setup = || -> Result<cpal::Stream> {
                    let device = host
                        .default_input_device()
                        .context("No microphone available")?;
                    let config = device.default_input_config()?;
                    let mic_buf = Arc::clone(&mic_buffer);
                    let is_cap = Arc::clone(&is_capturing);

                    let stream = match config.sample_format() {
                        cpal::SampleFormat::F32 => device.build_input_stream(
                            &config.into(),
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        mic_buf.push(sample);
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
                                        mic_buf.push(sample as f32 / i16::MAX as f32);
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
                        tracing::error!("Failed to start microphone stream: {}", e);
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            if capture_system {
                let setup = || -> Result<cpal::Stream> {
                    let sys_capture = SystemAudioCapture::new();
                    let loopback_device = sys_capture
                        .find_loopback_device()?
                        .ok_or_else(|| anyhow::anyhow!("Loopback device not found"))?;

                    let config = loopback_device.default_input_config()?;
                    let sys_buf = Arc::clone(&system_buffer);
                    let is_cap = Arc::clone(&is_capturing);

                    let stream = match config.sample_format() {
                        cpal::SampleFormat::F32 => loopback_device.build_input_stream(
                            &config.into(),
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                if is_cap.load(Ordering::SeqCst) {
                                    for &sample in data {
                                        sys_buf.push(sample);
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
                                        sys_buf.push(sample as f32 / i16::MAX as f32);
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
                        tracing::error!("Failed to start system stream: {}", e);
                        is_capturing.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            let mut output = Vec::with_capacity(512);
            while is_capturing.load(Ordering::SeqCst) {
                let mut made_progress = false;

                while let Some(mic_sample) = mic_buffer.pop() {
                    let sys_sample = system_buffer.pop().unwrap_or(0.0);
                    let mixed = ((mic_sample * 0.7) + (sys_sample * 0.7)).clamp(-1.0, 1.0);
                    output.push(mixed);
                    made_progress = true;

                    if let Ok(mut waveform) = waveform_buffer.lock() {
                        waveform.push(mixed);
                        if waveform.len() > 4410 {
                            let drop_count = waveform.len() - 4410;
                            waveform.drain(0..drop_count);
                        }
                    }

                    if output.len() >= 512 {
                        if sender.send(output.clone()).is_err() {
                            is_capturing.store(false, Ordering::SeqCst);
                            break;
                        }
                        output.clear();
                    }
                }

                if capture_system && !capture_mic {
                    while let Some(sys_sample) = system_buffer.pop() {
                        output.push(sys_sample);
                        made_progress = true;

                        if let Ok(mut waveform) = waveform_buffer.lock() {
                            waveform.push(sys_sample);
                            if waveform.len() > 4410 {
                                let drop_count = waveform.len() - 4410;
                                waveform.drain(0..drop_count);
                            }
                        }

                        if output.len() >= 512 {
                            if sender.send(output.clone()).is_err() {
                                is_capturing.store(false, Ordering::SeqCst);
                                break;
                            }
                            output.clear();
                        }
                    }
                }

                if !made_progress {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }

            if !output.is_empty() {
                let _ = sender.send(output);
            }
        }));

        tracing::info!(
            "Mixed audio capture started (mic: {}, system: {})",
            capture_mic,
            capture_system
        );
        Ok(receiver)
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        // Don't block on join - let the thread clean up in background
        // The thread will exit when it sees is_capturing is false
        if let Some(handle) = self.capture_thread.take() {
            // Drop the handle without joining - thread will self-terminate
            std::thread::spawn(move || {
                let _ = handle.join();
            });
        }
        tracing::info!("Mixed audio capture stopped");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_audio_available() {
        let capture = SystemAudioCapture::new();
        let available = capture.is_available();
        tracing::info!("System audio available: {}", available);
    }
}
