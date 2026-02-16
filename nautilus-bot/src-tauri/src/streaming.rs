//! Incremental/streaming transcription support
//!
//! Provides real-time transcription as audio is recorded,
//! processing audio chunks incrementally and emitting partial results.
#![allow(dead_code)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

/// Streaming transcription session
pub struct StreamingSession {
    /// Session ID
    pub id: String,
    /// Audio buffer (circular/ring buffer for continuous recording)
    buffer: Arc<Mutex<AudioBuffer>>,
    /// Transcription results sender
    result_tx: mpsc::Sender<StreamingResult>,
    /// Current accumulated transcript
    transcript: Arc<Mutex<String>>,
    /// Provider type to use
    provider_type: crate::asr::AsrProviderType,
    /// Model to use when the provider supports model selection
    selected_model_id: String,
    /// Last processed position in buffer
    last_processed_pos: Arc<Mutex<usize>>,
    /// Minimum chunk size for transcription (in samples)
    min_chunk_size: usize,
    /// Overlap between chunks (in samples)
    overlap_size: usize,
    /// Sample rate
    sample_rate: u32,
}

/// Audio buffer for streaming
struct AudioBuffer {
    data: Vec<f32>,
    write_pos: usize,
    total_written: usize,
}

impl AudioBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            data: vec![0.0; capacity],
            write_pos: 0,
            total_written: 0,
        }
    }

    /// Write audio samples to buffer (circular)
    fn write(&mut self, samples: &[f32]) {
        for sample in samples {
            self.data[self.write_pos] = *sample;
            self.write_pos = (self.write_pos + 1) % self.data.len();
            self.total_written += 1;
        }
    }

    /// Get samples from a specific position
    fn get_samples(&self, start: usize, count: usize) -> Vec<f32> {
        let capacity = self.data.len();
        let actual_start = start % capacity;

        (0..count)
            .map(|i| self.data[(actual_start + i) % capacity])
            .collect()
    }

    /// Get total samples written
    fn total_written(&self) -> usize {
        self.total_written
    }
}

/// Streaming transcription result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamingResult {
    /// Whether this is a partial (interim) result
    pub is_partial: bool,
    /// Transcribed text
    pub text: String,
    /// Segment start time
    pub start_time: f64,
    /// Segment end time
    pub end_time: f64,
    /// Confidence score
    pub confidence: f64,
    /// Whether this is the final result
    pub is_final: bool,
}

/// Streaming transcriber for real-time transcription
pub struct StreamingTranscriber {
    /// Active sessions
    sessions: Arc<Mutex<std::collections::HashMap<String, StreamingSessionHandle>>>,
    /// ASR manager reference
    asr_manager: Arc<crate::asr::AsrManager>,
}

impl StreamingTranscriber {
    pub fn new(asr_manager: Arc<crate::asr::AsrManager>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            asr_manager,
        }
    }

    /// Start a new streaming session
    pub async fn start_session(
        &self,
        provider_type: crate::asr::AsrProviderType,
        sample_rate: u32,
        selected_model_id: String,
    ) -> Result<(String, mpsc::Receiver<StreamingResult>)> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let (result_tx, result_rx) = mpsc::channel::<StreamingResult>(100);

        let normalized_sample_rate = sample_rate.max(8_000);
        let min_chunk_size = (normalized_sample_rate as usize) * 2; // 2 seconds
        let overlap_size = (normalized_sample_rate as usize) / 2; // 0.5 second overlap
        let buffer_capacity = (normalized_sample_rate as usize) * 60 * 5; // 5-minute ring buffer

        let session = StreamingSession {
            id: session_id.clone(),
            buffer: Arc::new(Mutex::new(AudioBuffer::new(buffer_capacity))),
            result_tx,
            transcript: Arc::new(Mutex::new(String::new())),
            provider_type,
            selected_model_id,
            last_processed_pos: Arc::new(Mutex::new(0)),
            min_chunk_size,
            overlap_size,
            sample_rate: normalized_sample_rate,
        };

        let handle = StreamingSessionHandle {
            session: Arc::new(session),
            is_active: Arc::new(Mutex::new(true)),
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), handle);

        tracing::info!("Started streaming session: {}", session_id);
        Ok((session_id, result_rx))
    }

    /// Feed audio to a streaming session
    pub async fn feed_audio(&self, session_id: &str, samples: &[f32]) -> Result<()> {
        let sessions = self.sessions.lock().await;

        if let Some(handle) = sessions.get(session_id) {
            let session = handle.session.clone();
            let mut buffer = session.buffer.lock().await;
            buffer.write(samples);
            drop(buffer);

            // Check if we have enough new audio to transcribe
            let last_pos = *session.last_processed_pos.lock().await;
            let buffer_total = session.buffer.lock().await.total_written();
            let new_samples = buffer_total.saturating_sub(last_pos);

            if new_samples >= session.min_chunk_size {
                // Clone session handle for background task
                let session_clone = session.clone();
                let asr_manager = self.asr_manager.clone();

                // Spawn transcription task
                tokio::spawn(async move {
                    if let Err(e) = process_chunk(&session_clone, &asr_manager).await {
                        tracing::warn!("Transcription error: {}", e);
                    }
                });
            }

            Ok(())
        } else {
            Err(anyhow::anyhow!("Session not found: {}", session_id))
        }
    }

    /// Finalize a streaming session and get the final transcript
    pub async fn finalize_session(&self, session_id: &str) -> Result<String> {
        let mut sessions = self.sessions.lock().await;

        if let Some(handle) = sessions.remove(session_id) {
            *handle.is_active.lock().await = false;

            // Get remaining audio and transcribe
            let session = handle.session.clone();
            let last_pos = *session.last_processed_pos.lock().await;
            let buffer = session.buffer.lock().await;
            let total = buffer.total_written();
            let remaining = total.saturating_sub(last_pos);

            if remaining > 0 {
                let samples = buffer.get_samples(last_pos, remaining);
                drop(buffer);

                // Convert samples to WAV bytes
                let wav_bytes = samples_to_wav(&samples, session.sample_rate);

                let final_result = self
                    .asr_manager
                    .transcribe_bytes_with_provider(
                        session.provider_type,
                        &wav_bytes,
                        Some(session.selected_model_id.as_str()),
                    )
                    .await;

                match final_result {
                    Ok(result) => {
                        let mut transcript = session.transcript.lock().await;
                        if !transcript.is_empty() && !result.text.is_empty() {
                            transcript.push(' ');
                        }
                        transcript.push_str(&result.text);

                        // Send final result
                        let _ = session
                            .result_tx
                            .send(StreamingResult {
                                is_partial: false,
                                text: result.text,
                                start_time: last_pos as f64 / session.sample_rate as f64,
                                end_time: total as f64 / session.sample_rate as f64,
                                confidence: result.confidence,
                                is_final: true,
                            })
                            .await;

                        return Ok(transcript.clone());
                    }
                    Err(e) => {
                        tracing::warn!("Final transcription failed: {}", e);
                    }
                }
            }

            let transcript = session.transcript.lock().await.clone();
            Ok(transcript)
        } else {
            Err(anyhow::anyhow!("Session not found: {}", session_id))
        }
    }

    /// Stop a streaming session without finalizing
    pub async fn stop_session(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;

        if let Some(handle) = sessions.remove(session_id) {
            *handle.is_active.lock().await = false;
            tracing::info!("Stopped streaming session: {}", session_id);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Session not found: {}", session_id))
        }
    }

    /// Check if a session is active
    pub async fn is_session_active(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.contains_key(session_id)
    }
}

/// Handle for managing a streaming session
#[allow(dead_code)]
struct StreamingSessionHandle {
    session: Arc<StreamingSession>,
    is_active: Arc<Mutex<bool>>,
}

/// Process a chunk of audio for transcription
#[allow(dead_code)]
async fn process_chunk(
    session: &Arc<StreamingSession>,
    asr_manager: &crate::asr::AsrManager,
) -> Result<()> {
    let last_pos = *session.last_processed_pos.lock().await;
    let chunk_size = session.min_chunk_size;
    let overlap = session.overlap_size;

    // Calculate actual processing range
    let actual_chunk_size = chunk_size + overlap; // Include overlap
    let buffer = session.buffer.lock().await;
    let total = buffer.total_written();
    let available = total.saturating_sub(last_pos);

    if available < chunk_size {
        return Ok(()); // Not enough data
    }

    let process_size = actual_chunk_size.min(available);
    let samples = buffer.get_samples(last_pos, process_size);
    drop(buffer);

    let wav_bytes = samples_to_wav(&samples, session.sample_rate);

    let chunk_result = asr_manager
        .transcribe_bytes_with_provider(
            session.provider_type,
            &wav_bytes,
            Some(session.selected_model_id.as_str()),
        )
        .await;

    match chunk_result {
        Ok(result) => {
            if !result.text.is_empty() {
                let mut transcript = session.transcript.lock().await;
                if !transcript.is_empty() {
                    transcript.push(' ');
                }
                transcript.push_str(&result.text);
                drop(transcript);

                // Update position (minus overlap for next chunk)
                let new_pos = last_pos + chunk_size;
                *session.last_processed_pos.lock().await = new_pos;

                // Send partial result
                let _ = session
                    .result_tx
                    .send(StreamingResult {
                        is_partial: true,
                        text: result.text,
                        start_time: last_pos as f64 / session.sample_rate as f64,
                        end_time: new_pos as f64 / session.sample_rate as f64,
                        confidence: result.confidence,
                        is_final: false,
                    })
                    .await;
            } else {
                // No speech detected, advance position
                let new_pos = last_pos + chunk_size;
                *session.last_processed_pos.lock().await = new_pos;
            }
        }
        Err(e) => {
            tracing::warn!("Chunk transcription failed: {}", e);
            // Still advance to avoid getting stuck
            let new_pos = last_pos + chunk_size;
            *session.last_processed_pos.lock().await = new_pos;
        }
    }

    Ok(())
}

/// Convert f32 samples to WAV bytes
#[allow(dead_code)]
fn samples_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    use hound::{WavSpec, WavWriter};
    use std::io::Cursor;

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    let result: anyhow::Result<()> = (|| {
        let mut writer = WavWriter::new(&mut cursor, spec)
            .map_err(|e| anyhow::anyhow!("Failed to create WAV writer: {}", e))?;

        for sample in samples {
            let int_sample = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
            writer
                .write_sample(int_sample)
                .map_err(|e| anyhow::anyhow!("Failed to write sample: {}", e))?;
        }

        writer
            .finalize()
            .map_err(|e| anyhow::anyhow!("Failed to finalize WAV: {}", e))?;
        Ok(())
    })();

    if let Err(e) = result {
        tracing::error!("WAV encoding failed: {}", e);
        return Vec::new();
    }

    cursor.into_inner()
}
