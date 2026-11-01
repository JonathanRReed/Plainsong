//! Turning a finished meeting recording into a transcript.
//!
//! Chunked transcription and the provider-cleanup warnings it collects, the
//! whole-file limits some providers impose, diarizer selection and the
//! conversion of provider speaker turns, benchmark persistence, and the
//! assembly of the stored transcript -- including the source-aware form that
//! keeps microphone and system audio distinguishable.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn meeting_transcription_chunk_seconds(provider: asr::AsrProviderType) -> usize {
    match provider {
        // Candle Whisper flattens every mel tensor into the architecture's
        // fixed 30-second N_FRAMES input. Feeding a longer chunk silently
        // drops the tail, so meeting chunking must enforce that same window.
        asr::AsrProviderType::WhisperCandle | asr::AsrProviderType::DistilWhisper => 30,
        _ => 90,
    }
}

fn meeting_float_chunk(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut writer = hound::WavWriter::new(
        &mut cursor,
        hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .map_err(|e| e.to_string())?;
    for sample in samples {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn transcribe_recording_in_chunks(
    app: &impl crate::sidecar_handle::AppEmitter,
    asr_manager: Arc<asr::AsrManager>,
    recording_id: &str,
    audio_path: &Path,
    provider: asr::AsrProviderType,
    model_id: String,
    wait_budget: &MeetingWaitBudget,
    aside_spans: &[crate::meeting_asides::AsideSpan],
) -> Result<asr::TranscriptionResult, String> {
    if wait_budget.memory_deferred() {
        return Err(MEETING_TRANSCRIPTION_PENDING_NOTICE.to_string());
    }
    let mut reader = hound::WavReader::open(audio_path).map_err(|error| {
        format!(
            "Failed to open recording '{}' for chunked transcription: {}",
            audio_path.display(),
            error
        )
    })?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err("Chunked transcription requires a valid WAV sample rate/channels".to_string());
    }

    // Dictations taken from this track during the meeting are silenced before
    // any chunk is decoded, so none of their words can reach the transcript.
    let aside_ranges = crate::meeting_asides::aside_frame_ranges(
        aside_spans,
        spec.sample_rate,
        u64::from(reader.duration()),
    );
    let aside_ranges = &aside_ranges;

    let chunk_seconds = meeting_transcription_chunk_seconds(provider);
    let chunk_size_frames =
        (spec.sample_rate as usize * chunk_seconds).max(spec.sample_rate as usize);
    let total_duration_seconds =
        compute_wav_duration_seconds(audio_path.to_string_lossy().as_ref()).max(0) as f64;

    let started = std::time::Instant::now();
    let mut chunk_samples: Vec<f32> = Vec::with_capacity(chunk_size_frames);
    let mut channel_accumulator: Vec<f32> = Vec::with_capacity(spec.channels as usize);
    let mut current_frame_start = 0usize;
    let mut processed_frames = 0usize;
    let mut chunk_count = 0usize;

    let mut merged_text = String::new();
    // The `recording-transcription-stream` contract wants the whole preview so
    // far in `text`, so the chunk-by-chunk emitter keeps its own running copy;
    // `merged_text` is only assembled once a chunk has come back successfully,
    // which is after the event for that chunk has already gone out.
    let streamed_preview = Arc::new(tokio::sync::Mutex::new(String::new()));
    let mut merged_segments: Vec<asr::TranscriptSegment> = Vec::new();
    // Provider speaker labels, offset onto the recording's timeline. Only
    // usable when the whole recording went out in one request -- see
    // `provider_speaker_turns_survive_chunking`.
    let mut merged_speaker_turns: Vec<asr::SpeakerTurn> = Vec::new();
    let mut successful_chunks = 0usize;
    let mut language = String::new();
    let mut model_name = String::new();
    let mut requested_provider = provider;
    let mut actual_provider = provider;
    let mut requested_engine: Option<String> = None;
    let mut actual_engine: Option<String> = None;
    let mut optimization_applied = false;
    let mut measured_word_timestamps = true;
    let mut fallback_reason: Option<String> = None;
    let mut weighted_confidence_sum = 0.0_f64;
    let mut weighted_confidence_count = 0.0_f64;
    // A transient failure on one chunk (e.g. a cloud-ASR hiccup at minute 100
    // of a 2h meeting) must not discard everything transcribed so far; failed
    // chunks are skipped and reported so the transcript is saved as partial.
    let mut failed_chunks = 0usize;
    let mut last_chunk_error: Option<String> = None;

    let process_chunk = |chunk: Vec<f32>,
                         chunk_start_frame: usize,
                         processed: usize,
                         chunk_idx: usize|
     -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<asr::TranscriptionResult, String>> + Send + '_>,
    > {
        let asr_manager = Arc::clone(&asr_manager);
        let model_id = model_id.clone();
        let streamed_preview = Arc::clone(&streamed_preview);
        Box::pin(async move {
            if wait_budget.memory_deferred() {
                return Err(MEETING_TRANSCRIPTION_PENDING_NOTICE.to_string());
            }
            let chunk_start_seconds = chunk_start_frame as f64 / spec.sample_rate as f64;
            let chunk_end_seconds =
                (chunk_start_frame + chunk.len()) as f64 / spec.sample_rate as f64;
            let chunk_progress = if total_duration_seconds > 0.0 {
                (chunk_start_seconds / total_duration_seconds).clamp(0.0, 1.0)
            } else {
                0.0
            };
            app.emit_event(
                "recording-transcription-progress",
                serde_json::json!({
                    "recordingId": recording_id,
                    "chunkIndex": chunk_idx + 1,
                    "progress": chunk_progress,
                    "stage": "chunk_started",
                    "startTime": chunk_start_seconds,
                    "endTime": chunk_end_seconds,
                }),
            );
            let mut chunk = chunk;
            crate::meeting_asides::silence_aside_frames(
                &mut chunk,
                chunk_start_frame as u64,
                aside_ranges,
            );
            let wav_chunk =
                if spec.sample_format == hound::SampleFormat::Int && spec.bits_per_sample == 24 {
                    // Keep stored recognition samples through the provider's WAV
                    // boundary. The local reader skips resampling at 16 kHz.
                    meeting_float_chunk(&chunk, spec.sample_rate)?
                } else {
                    mono_samples_to_wav_bytes(&chunk, spec.sample_rate)?
                };
            let mut headroom_retries = 0u32;
            let mut busy_retries = 0u32;
            let result = loop {
                let error = match asr_manager
                    .transcribe_bytes_for_meeting(provider, &wav_chunk, Some(model_id.as_str()))
                    .await
                {
                    Ok(result) => break result,
                    Err(error) => error,
                };
                let message = format!("{error:#}");
                let Some(wait) = wait_budget.retry_after_failure(
                    provider,
                    &message,
                    headroom_retries,
                    busy_retries,
                ) else {
                    return Err(format!(
                        "Chunk {} failed at {:.1}s: {}",
                        chunk_idx + 1,
                        chunk_start_frame as f64 / spec.sample_rate as f64,
                        message
                    ));
                };
                match wait.reason {
                    MeetingWaitReason::MemoryHeadroom => headroom_retries += 1,
                    MeetingWaitReason::RuntimeBusy => busy_retries += 1,
                }
                tracing::warn!(
                    "Chunk {} of {} could not start ({}); trying again in {:.1}s: {}",
                    chunk_idx + 1,
                    recording_id,
                    wait.reason.describe(),
                    wait.delay.as_secs_f64(),
                    error
                );
                // Say so: without this the meeting sits on "Transcribing an
                // audio segment" for up to a minute at a time.
                emit_recording_status(
                    app,
                    recording_id,
                    "processing",
                    Some(wait.reason.status_message()),
                    Some(chunk_progress),
                );
                // Do not hold a cached ONNX model (about 2 GB for Parakeet)
                // through a long wait for memory: it is part of what the
                // machine is short of, and the retry loads it again.
                // Never one dictation is using or keeping warm, though: see
                // `MeetingWaitBudget::release_model_for_wait`.
                if wait.reason == MeetingWaitReason::MemoryHeadroom
                    && wait.delay >= MEETING_WAIT_RELEASE_MODEL_AFTER
                    && asr_manager
                        .supports_short_keep_warm(provider, model_id.as_str())
                        .await
                {
                    wait_budget
                        .release_model_for_wait(&asr_manager, provider, model_id.as_str())
                        .await;
                }
                wait_budget.spend(wait.delay);
                tokio::time::sleep(wait.delay).await;
                emit_recording_status(
                    app,
                    recording_id,
                    "processing",
                    Some("Transcribing an audio segment"),
                    Some(chunk_progress),
                );
            };

            let segment_text = result.text.trim();
            let preview_text = {
                let mut preview = streamed_preview.lock().await;
                if !segment_text.is_empty() {
                    if !preview.is_empty() {
                        preview.push(' ');
                    }
                    preview.push_str(segment_text);
                }
                preview.clone()
            };
            app.emit_event(
                "recording-transcription-stream",
                serde_json::json!({
                    "recordingId": recording_id,
                    // The transcript is still growing; only the live session
                    // ever sends a closing marker.
                    "isPartial": true,
                    "isFinal": false,
                    "text": preview_text,
                    "segmentText": segment_text,
                    "startTime": chunk_start_seconds,
                    "endTime": chunk_end_seconds,
                    "confidence": result.confidence,
                    // Same field set as the live path so one renderer handles
                    // both. This is the real transcription arriving chunk by
                    // chunk after capture, not a preview trailing a speaker.
                    "kind": streaming::StreamingSegmentKind::Speech.as_event_str(),
                    "delayedPreview": false,
                    "lagSeconds": 0.0,
                }),
            );
            if total_duration_seconds > 0.0 {
                let progress = (processed as f64
                    / (total_duration_seconds * spec.sample_rate as f64))
                    .clamp(0.0, 1.0);
                app.emit_event(
                    "recording-transcription-progress",
                    serde_json::json!({
                        "recordingId": recording_id,
                        "chunkIndex": chunk_idx + 1,
                        "progress": progress,
                    }),
                );
                emit_recording_status(
                    app,
                    recording_id,
                    "processing",
                    Some("Processing transcript"),
                    Some(progress),
                );
            }

            Ok(result)
        })
    };

    if spec.sample_format == hound::SampleFormat::Float {
        for sample in reader.samples::<f32>() {
            let sample = sample.map_err(|error| format!("Failed to read wav sample: {}", error))?;
            channel_accumulator.push(sample);
            if channel_accumulator.len() < spec.channels as usize {
                continue;
            }
            let mono = channel_accumulator.iter().copied().sum::<f32>() / spec.channels as f32;
            channel_accumulator.clear();
            chunk_samples.push(mono);
            processed_frames += 1;

            if chunk_samples.len() >= chunk_size_frames {
                // Cut in a pause when the tail of the accumulated chunk offers
                // one; whatever follows the cut opens the next chunk.
                let chunk = take_vad_aligned_chunk(&mut chunk_samples, spec.sample_rate);
                let result = match process_chunk(
                    chunk.clone(),
                    current_frame_start,
                    processed_frames,
                    chunk_count,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        tracing::warn!(
                            "Transcription chunk {} failed for {}; continuing with remaining chunks: {}",
                            chunk_count + 1,
                            recording_id,
                            error
                        );
                        failed_chunks += 1;
                        last_chunk_error = Some(error);
                        current_frame_start += chunk.len();
                        chunk_count += 1;
                        continue;
                    }
                };

                let offset_seconds = current_frame_start as f64 / spec.sample_rate as f64;
                if !result.text.trim().is_empty() {
                    if !merged_text.is_empty() {
                        merged_text.push(' ');
                    }
                    merged_text.push_str(result.text.trim());
                }
                // A chunk with no words (trailing silence) says nothing about
                // timing, so it must not mark the whole meeting untimed.
                if !result.segments.is_empty() || !result.text.trim().is_empty() {
                    measured_word_timestamps &= result.measured_word_timestamps;
                }
                for mut segment in result.segments {
                    segment.start_time += offset_seconds;
                    segment.end_time += offset_seconds;
                    merged_segments.push(segment);
                }
                for mut turn in result.speaker_turns {
                    turn.start_time += offset_seconds;
                    turn.end_time += offset_seconds;
                    merged_speaker_turns.push(turn);
                }
                successful_chunks += 1;
                if language.is_empty() {
                    language = result.language.clone();
                }
                if model_name.is_empty() {
                    model_name = result.model_name.clone();
                }
                requested_provider = result.requested_provider;
                actual_provider = result.actual_provider;
                if requested_engine.is_none() {
                    requested_engine = result.requested_engine.clone();
                }
                actual_engine = result.actual_engine.clone();
                optimization_applied |= result.optimization_applied;
                if fallback_reason.is_none() {
                    fallback_reason = result.fallback_reason.clone();
                }
                let weight = result.text.chars().count().max(1) as f64;
                weighted_confidence_sum += result.confidence * weight;
                weighted_confidence_count += weight;

                current_frame_start += chunk.len();
                chunk_count += 1;
            }
        }
    } else {
        // Keep the existing PCM16 normalization and quantization unchanged.
        let scale = if spec.bits_per_sample <= 16 {
            i16::MAX as f32
        } else {
            (1_u64 << (spec.bits_per_sample - 1)) as f32
        };
        for sample in reader.samples::<i32>() {
            let sample = sample.map_err(|error| format!("Failed to read wav sample: {}", error))?;
            channel_accumulator.push(sample as f32 / scale);
            if channel_accumulator.len() < spec.channels as usize {
                continue;
            }
            let mono = channel_accumulator.iter().copied().sum::<f32>() / spec.channels as f32;
            channel_accumulator.clear();
            chunk_samples.push(mono);
            processed_frames += 1;

            if chunk_samples.len() >= chunk_size_frames {
                // Cut in a pause when the tail of the accumulated chunk offers
                // one; whatever follows the cut opens the next chunk.
                let chunk = take_vad_aligned_chunk(&mut chunk_samples, spec.sample_rate);
                let result = match process_chunk(
                    chunk.clone(),
                    current_frame_start,
                    processed_frames,
                    chunk_count,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        tracing::warn!(
                            "Transcription chunk {} failed for {}; continuing with remaining chunks: {}",
                            chunk_count + 1,
                            recording_id,
                            error
                        );
                        failed_chunks += 1;
                        last_chunk_error = Some(error);
                        current_frame_start += chunk.len();
                        chunk_count += 1;
                        continue;
                    }
                };

                let offset_seconds = current_frame_start as f64 / spec.sample_rate as f64;
                if !result.text.trim().is_empty() {
                    if !merged_text.is_empty() {
                        merged_text.push(' ');
                    }
                    merged_text.push_str(result.text.trim());
                }
                // A chunk with no words (trailing silence) says nothing about
                // timing, so it must not mark the whole meeting untimed.
                if !result.segments.is_empty() || !result.text.trim().is_empty() {
                    measured_word_timestamps &= result.measured_word_timestamps;
                }
                for mut segment in result.segments {
                    segment.start_time += offset_seconds;
                    segment.end_time += offset_seconds;
                    merged_segments.push(segment);
                }
                for mut turn in result.speaker_turns {
                    turn.start_time += offset_seconds;
                    turn.end_time += offset_seconds;
                    merged_speaker_turns.push(turn);
                }
                successful_chunks += 1;
                if language.is_empty() {
                    language = result.language.clone();
                }
                if model_name.is_empty() {
                    model_name = result.model_name.clone();
                }
                requested_provider = result.requested_provider;
                actual_provider = result.actual_provider;
                if requested_engine.is_none() {
                    requested_engine = result.requested_engine.clone();
                }
                actual_engine = result.actual_engine.clone();
                optimization_applied |= result.optimization_applied;
                if fallback_reason.is_none() {
                    fallback_reason = result.fallback_reason.clone();
                }
                let weight = result.text.chars().count().max(1) as f64;
                weighted_confidence_sum += result.confidence * weight;
                weighted_confidence_count += weight;

                current_frame_start += chunk.len();
                chunk_count += 1;
            }
        }
    }

    if !chunk_samples.is_empty() {
        let chunk = std::mem::take(&mut chunk_samples);
        match process_chunk(
            chunk.clone(),
            current_frame_start,
            processed_frames,
            chunk_count,
        )
        .await
        {
            Ok(result) => {
                let offset_seconds = current_frame_start as f64 / spec.sample_rate as f64;
                if !result.text.trim().is_empty() {
                    if !merged_text.is_empty() {
                        merged_text.push(' ');
                    }
                    merged_text.push_str(result.text.trim());
                }
                // A chunk with no words (trailing silence) says nothing about
                // timing, so it must not mark the whole meeting untimed.
                if !result.segments.is_empty() || !result.text.trim().is_empty() {
                    measured_word_timestamps &= result.measured_word_timestamps;
                }
                for mut segment in result.segments {
                    segment.start_time += offset_seconds;
                    segment.end_time += offset_seconds;
                    merged_segments.push(segment);
                }
                for mut turn in result.speaker_turns {
                    turn.start_time += offset_seconds;
                    turn.end_time += offset_seconds;
                    merged_speaker_turns.push(turn);
                }
                successful_chunks += 1;
                if language.is_empty() {
                    language = result.language.clone();
                }
                if model_name.is_empty() {
                    model_name = result.model_name.clone();
                }
                requested_provider = result.requested_provider;
                actual_provider = result.actual_provider;
                if requested_engine.is_none() {
                    requested_engine = result.requested_engine.clone();
                }
                actual_engine = result.actual_engine.clone();
                optimization_applied |= result.optimization_applied;
                if fallback_reason.is_none() {
                    fallback_reason = result.fallback_reason.clone();
                }
                let weight = result.text.chars().count().max(1) as f64;
                weighted_confidence_sum += result.confidence * weight;
                weighted_confidence_count += weight;
                chunk_count += 1;
            }
            Err(error) => {
                tracing::warn!(
                    "Transcription chunk {} failed for {}: {}",
                    chunk_count + 1,
                    recording_id,
                    error
                );
                failed_chunks += 1;
                last_chunk_error = Some(error);
                chunk_count += 1;
            }
        }
    }

    if chunk_count == 0 {
        return Err("No chunks were processed for transcription".to_string());
    }

    // If nothing at all transcribed and at least one chunk errored, this is a
    // hard failure; otherwise degrade gracefully and record the gap.
    if failed_chunks > 0 {
        if merged_segments.is_empty() && merged_text.trim().is_empty() {
            return Err(format!(
                "Transcription failed: all {} chunk(s) failed (last error: {})",
                failed_chunks,
                last_chunk_error.unwrap_or_else(|| "unknown".to_string())
            ));
        }
        let note = format!(
            "{} of {} transcription chunk(s) failed; transcript may be incomplete",
            failed_chunks, chunk_count
        );
        tracing::warn!("Recording {}: {}", recording_id, note);
        fallback_reason = Some(match fallback_reason {
            Some(existing) => format!("{}; {}", existing, note),
            None => note,
        });
    }

    app.emit_event(
        "recording-transcription-progress",
        serde_json::json!({
            "recordingId": recording_id,
            "chunkIndex": chunk_count,
            "progress": 1.0,
        }),
    );
    emit_recording_status(
        app,
        recording_id,
        "processing",
        Some("Processing transcript"),
        Some(1.0),
    );

    if !merged_speaker_turns.is_empty()
        && !provider_speaker_turns_survive_chunking(successful_chunks)
    {
        tracing::info!(
            "Recording {}: discarding provider speaker labels from {} separate requests; \
             speaker numbering is scoped to one request, so Plainsong's own diarizer runs instead",
            recording_id,
            successful_chunks
        );
        merged_speaker_turns.clear();
    }

    Ok(asr::TranscriptionResult {
        text: merged_text,
        segments: merged_segments,
        measured_word_timestamps: measured_word_timestamps
            && successful_chunks > 0
            && failed_chunks == 0,
        language: if language.is_empty() {
            "en".to_string()
        } else {
            language
        },
        confidence: if weighted_confidence_count > 0.0 {
            weighted_confidence_sum / weighted_confidence_count
        } else {
            0.0
        },
        processing_time_ms: started.elapsed().as_millis() as u64,
        model_name: if model_name.is_empty() {
            provider.display_name().to_string()
        } else {
            model_name
        },
        model_id,
        requested_provider,
        actual_provider,
        requested_engine,
        actual_engine,
        optimization_applied,
        fallback_reason,
        vocabulary_hint_terms_applied: 0,
        speaker_turns: merged_speaker_turns,
        vocabulary_candidates: Vec::new(),
    })
}

/// Waits before asking a local model again for a chunk it refused for memory
/// headroom: 5, 10, 20, 40, then 60 seconds until the recording's budget ends.
const MEETING_CHUNK_HEADROOM_RETRY_SECONDS: [u64; 5] = [5, 10, 20, 40, 60];

/// Waits before asking again when the native runtime was busy with another
/// local operation (a cleanup or a dictation decode): short, because that
/// work finishes in seconds, and bounded, because it is still the same
/// recording's budget.
const MEETING_CHUNK_BUSY_RETRY_MILLIS: [u64; 7] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/// The most one recording may spend waiting, across its microphone and
/// system-audio tracks, every chunk, and speaker separation. Transcription
/// then stays pending for the user to retry from saved audio.
const MEETING_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// A memory wait at least this long first releases the cached model of a
/// route that keeps one, so the wait does not hold it -- unless dictation is
/// using or keeping warm the same model (`release_meeting_route_for_memory_wait`).
const MEETING_WAIT_RELEASE_MODEL_AFTER: std::time::Duration = std::time::Duration::from_secs(20);

/// Time one recording has spent waiting for memory or the native runtime.
/// Shared by both tracks of a dual-source meeting and by its diarization, so
/// the budget is the recording's, not each track's.
#[derive(Default)]
pub(crate) struct MeetingWaitBudget {
    waited_ms: Arc<std::sync::atomic::AtomicU64>,
    memory_deferred: std::sync::atomic::AtomicBool,
    /// The app whose dictation lane shares the native runtime with this
    /// meeting. `None` only in a process with no dictation (meeting-eval).
    dictation: Option<Arc<AppState>>,
}

impl MeetingWaitBudget {
    /// A budget for a process with no dictation lane to protect.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// A budget for a meeting in the app, where dictation may be using -- or
    /// keeping warm -- the same speech model.
    pub(crate) fn sharing_runtime_with(state: Arc<AppState>) -> Self {
        Self {
            waited_ms: Default::default(),
            memory_deferred: Default::default(),
            dictation: Some(state),
        }
    }

    /// Drop the route's cached model before a long memory wait. In the app
    /// this goes through the dictation release checks, so a model a dictation
    /// session, warmup or keep-warm relies on stays loaded.
    async fn release_model_for_wait(
        &self,
        asr_manager: &asr::AsrManager,
        provider: asr::AsrProviderType,
        model_id: &str,
    ) {
        match &self.dictation {
            Some(state) => {
                release_meeting_route_for_memory_wait(state, provider, model_id).await;
            }
            None => asr_manager.cool_down_local_route(provider, model_id).await,
        }
    }

    fn retry_after_failure(
        &self,
        provider: asr::AsrProviderType,
        error: &str,
        headroom_retries: u32,
        busy_retries: u32,
    ) -> Option<MeetingWait> {
        let wait = meeting_local_retry_wait(
            provider,
            error,
            headroom_retries,
            busy_retries,
            self.waited(),
        );
        if wait.is_none()
            && !provider.is_remote()
            && crate::llm::local_model_load::is_headroom_refusal(error)
        {
            self.memory_deferred
                .store(true, std::sync::atomic::Ordering::Release);
        }
        wait
    }

    pub(crate) fn memory_deferred(&self) -> bool {
        self.memory_deferred
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn waited(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.waited_ms.load(std::sync::atomic::Ordering::Acquire))
    }

    pub(crate) fn spend(&self, delay: std::time::Duration) {
        self.waited_ms.fetch_add(
            delay.as_millis() as u64,
            std::sync::atomic::Ordering::AcqRel,
        );
        crate::llm::local_model_load::notify_background_waiters();
    }
}

/// Why a meeting step is waiting rather than failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingWaitReason {
    /// Admission refused the allocation for lack of memory headroom.
    MemoryHeadroom,
    /// Another local operation held the native runtime.
    RuntimeBusy,
}

impl MeetingWaitReason {
    fn describe(self) -> &'static str {
        match self {
            MeetingWaitReason::MemoryHeadroom => "not enough free memory",
            MeetingWaitReason::RuntimeBusy => "another local operation is running",
        }
    }

    /// What the meeting's processing line says while it waits.
    pub(crate) fn status_message(self) -> &'static str {
        match self {
            MeetingWaitReason::MemoryHeadroom => "Waiting for memory to free up\u{2026}",
            MeetingWaitReason::RuntimeBusy => "Waiting for another local task to finish\u{2026}",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MeetingWait {
    pub(crate) delay: std::time::Duration,
    pub(crate) reason: MeetingWaitReason,
}

/// How long to wait before running a local meeting step again, or `None` to
/// give up on it and record the gap.
///
/// Two failures are about the moment rather than the audio. Admission refuses
/// while memory pressure is raised or other applications hold the headroom,
/// and it answers in milliseconds, so without a wait every chunk queued behind
/// the first refusal failed too: on a 17-minute AMI meeting under a pressure
/// warning, 11 of 12 chunks failed inside half a second and the meeting was
/// saved with 90 seconds of transcript. And the native runtime runs one local
/// operation at a time, so a chunk that arrives during a cleanup or a
/// dictation decode is told it is busy. Both are retried, on their own
/// schedules (`MEETING_CHUNK_HEADROOM_RETRY_SECONDS`,
/// `MEETING_CHUNK_BUSY_RETRY_MILLIS`), within one budget per recording
/// (`MEETING_WAIT_BUDGET`). Each retry asks admission again; nothing here
/// bypasses it. A cloud error, a corrupt model or bad audio fails as before.
pub(crate) fn meeting_local_retry_wait(
    provider: asr::AsrProviderType,
    error: &str,
    headroom_retries: u32,
    busy_retries: u32,
    waited_so_far: std::time::Duration,
) -> Option<MeetingWait> {
    if provider.is_remote() {
        return None;
    }
    meeting_retry_wait(error, headroom_retries, busy_retries, waited_so_far)
}

/// [`meeting_local_retry_wait`] without the provider check, for local work
/// that is not a transcription route (speaker separation).
pub(crate) fn meeting_retry_wait(
    error: &str,
    headroom_retries: u32,
    busy_retries: u32,
    waited_so_far: std::time::Duration,
) -> Option<MeetingWait> {
    let wait = if crate::llm::local_model_load::is_headroom_refusal(error) {
        MeetingWait {
            delay: std::time::Duration::from_secs(
                MEETING_CHUNK_HEADROOM_RETRY_SECONDS[(headroom_retries as usize)
                    .min(MEETING_CHUNK_HEADROOM_RETRY_SECONDS.len() - 1)],
            ),
            reason: MeetingWaitReason::MemoryHeadroom,
        }
    } else if crate::llm::native_runtime_is_busy(error) {
        MeetingWait {
            delay: std::time::Duration::from_millis(
                *MEETING_CHUNK_BUSY_RETRY_MILLIS.get(busy_retries as usize)?,
            ),
            reason: MeetingWaitReason::RuntimeBusy,
        }
    } else {
        return None;
    };
    (waited_so_far + wait.delay <= MEETING_WAIT_BUDGET).then_some(wait)
}

/// Run the local diarizer for a finished meeting, waiting out memory-headroom
/// refusals and a busy native runtime on the recording's own budget, exactly
/// as its transcription chunks do.
///
/// Speaker separation runs after the transcript is saved, usually right after
/// the speech model has finished with the memory it needed, so the first
/// admission check can land in the same squeeze the chunks waited through.
/// Without a wait the meeting was saved without speakers and only a log line
/// said why.
pub(crate) async fn run_meeting_diarization_with_waits(
    audio_path: &Path,
    model_id: &str,
    recording_id: &str,
    wait_budget: &MeetingWaitBudget,
) -> anyhow::Result<diarization::DiarizationResult> {
    let (mut headroom_retries, mut busy_retries) = (0u32, 0u32);
    loop {
        let error = match crate::llm::local_model_load::with_background_wait_budget(
            Arc::clone(&wait_budget.waited_ms),
            MEETING_WAIT_BUDGET,
            diarization::run_diarization_with_model(audio_path, model_id),
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        let Some(wait) = meeting_retry_wait(
            &format!("{error:#}"),
            headroom_retries,
            busy_retries,
            wait_budget.waited(),
        ) else {
            return Err(error);
        };
        match wait.reason {
            MeetingWaitReason::MemoryHeadroom => headroom_retries += 1,
            MeetingWaitReason::RuntimeBusy => busy_retries += 1,
        }
        tracing::warn!(
            "Speaker separation for {} could not start ({}); trying again in {:.1}s: {:#}",
            recording_id,
            wait.reason.describe(),
            wait.delay.as_secs_f64(),
            error
        );
        wait_budget.spend(wait.delay);
        tokio::time::sleep(wait.delay).await;
    }
}

/// The note a finished meeting carries when speaker separation failed, so the
/// reader learns why the transcript has no speakers and how to try again.
pub(crate) fn meeting_diarization_failure_notice(error: &str) -> String {
    let cause = diarization_failure_cause(error);
    format!(
        "Speakers were not labelled because {cause}. The transcript is saved; choose Label the speakers to try again."
    )
}

/// What the reader sees when they chose Label the speakers and it failed. The
/// raw error (which can name model internals) stays in the log.
pub(crate) fn manual_diarization_failure_message(error: &str) -> String {
    let cause = diarization_failure_cause(error);
    format!(
        "Speakers were not labelled because {cause}. Nothing was changed; try again in a moment."
    )
}

fn diarization_failure_cause(error: &str) -> &'static str {
    if crate::llm::local_model_load::is_headroom_refusal(error) {
        "there was not enough free memory"
    } else if crate::llm::native_runtime_is_busy(error)
        || crate::llm::local_model_load::is_background_wait_exhausted(error)
    {
        "another task on this Mac was using the speech model"
    } else {
        "the speaker model could not run"
    }
}

/// Turn any cleanup warnings a provider raised into a record the user can act
/// on: an audit entry, and -- when there is a recording to attach it to -- a
/// note on the finished recording.
///
/// Cleanup here means work a provider does outside the transcript. Today that
/// is the Gemini route's delete of the audio it uploaded to Google's Files API:
/// the transcript is fine either way, but "your meeting is still sitting in a
/// third-party store" is not something to leave in a log line.
pub(crate) async fn report_provider_cleanup_warnings(
    state: &AppState,
    app: Option<(&impl crate::sidecar_handle::AppEmitter, &str)>,
) {
    let warnings = asr::take_provider_cleanup_warnings();
    if warnings.is_empty() {
        return;
    }
    let mut db = state.db.lock().await;
    for warning in &warnings {
        if let Err(error) = db.log_audit_event(
            "provider_cleanup_incomplete",
            Some(serde_json::json!({
                "recording_id": app.map(|(_, recording_id)| recording_id),
                "detail": warning,
            })),
            "warning",
        ) {
            tracing::warn!("Failed to log a provider cleanup warning: {}", error);
        }
    }
    drop(db);

    if let Some((app, recording_id)) = app {
        for warning in warnings {
            // The completed event has already gone out, so this rides the same
            // "a finished meeting can still carry a note" path the degraded
            // transcript and the diarizer substitution use.
            app.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": recording_id,
                    "status": "completed",
                    "message": warning,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
        }
    }
}

/// Whether speaker labels collected across `successful_chunks` provider
/// requests can be trusted as one speaker space.
///
/// They cannot, past one. Every diarizing provider numbers speakers per
/// request: Deepgram's `speaker: 0` in the fourth ninety-second chunk is not
/// promised to be the same person as `speaker: 0` in the first, and nothing in
/// either response says whether it is. Stitching them anyway would silently
/// merge strangers and split one speaker into a new person every ninety
/// seconds -- worse than not diarizing at all, and invisible to the reader.
///
/// Zero is also false: no chunk succeeded, so there is nothing to trust.
pub(crate) fn provider_speaker_turns_survive_chunking(successful_chunks: usize) -> bool {
    successful_chunks == 1
}

/// The ceiling under which a provider will take a whole recording in one
/// request, so its speaker numbering covers the entire meeting.
///
/// Each provider's own documented limits, pulled in on 2026-09-02 (see
/// `docs/model-inventory-2026-09.md`), reduced where a documented limit is far
/// above anything Plainsong should send in one go -- or, where a provider
/// documents no limit of that shape at all, replaced by a Plainsong ceiling
/// with the arithmetic behind it written down. Which is which is stated per
/// provider below, because a self-imposed number described as the provider's
/// is a claim about someone else's API that nobody can check.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WholeFileMeetingLimits {
    pub(crate) max_seconds: f64,
    pub(crate) max_bytes: u64,
}

pub(crate) fn whole_file_meeting_limits(
    provider: asr::AsrProviderType,
) -> Option<WholeFileMeetingLimits> {
    match provider {
        // Deepgram documents no duration cap at all. What it does document is
        // a 2 GB request size and a ten-minute *processing* ceiling that
        // answers 504. Both numbers are Deepgram's; the two below are
        // Plainsong's, and here is the arithmetic behind them.
        //
        // A meeting is mono 16-bit PCM at the capture device's own rate, so
        // one second is 32 kB at 16 kHz and 96 kB at 48 kHz.
        //
        // - 1 GiB is well inside Deepgram's 2 GB, and is the point past which
        //   the upload itself is the risk rather than the transcription.
        // - Two hours is 230 MB at 16 kHz and 691 MB at 48 kHz, so it stays
        //   inside that byte cap at every rate a capture device offers.
        //   Processing it costs about 12 seconds at the 607.7x real time
        //   Artificial Analysis publishes for Nova-3, nowhere near the
        //   ten-minute ceiling, and 691 MB fits the client's own fifteen-minute
        //   whole-file timeout at about 6 Mbit/s of upload.
        //
        // The previous ceiling here was four hours, described as Deepgram's.
        // It was neither: Deepgram documents no such limit, and four hours at
        // 48 kHz is 1.38 GB, so the byte cap bound first and the stated figure
        // was never reachable on a normally-captured meeting anyway.
        asr::AsrProviderType::Deepgram => Some(WholeFileMeetingLimits {
            max_seconds: 2.0 * 60.0 * 60.0,
            max_bytes: 1024 * 1024 * 1024,
        }),
        // Gemini's own cap: one hour per request, dropping to thirty minutes
        // when diarization or word timestamps are on -- which is exactly what
        // the meeting lane asks for. Thirty minutes of the app's own meeting
        // WAV (mono 16-bit PCM at the capture device's rate) is 57.6 MB at
        // 16 kHz, 172.8 MB at 48 kHz and 345.6 MB at 96 kHz, so the duration
        // ceiling binds first at every rate a capture device offers; the byte
        // cap is a backstop against a file that is not what we think it is,
        // well under the Files API's own 2 GB.
        asr::AsrProviderType::GeminiTranscribe => Some(WholeFileMeetingLimits {
            max_seconds: 30.0 * 60.0,
            max_bytes: 512 * 1024 * 1024,
        }),
        // Mistral publishes both numbers: "recordings up to 3 hours per
        // request" and audio files "up to 1GB each" (docs.mistral.ai, fetched
        // 2026-09-03). The byte cap below is Mistral's. The duration ceiling
        // is Plainsong's, and lower than Mistral's, for the same reason
        // Deepgram's is: three hours of the app's meeting WAV (mono 16-bit
        // PCM) is 1.04 GB at 48 kHz, past Mistral's own 1 GB, so a stated
        // three-hour ceiling would be unreachable on a 48 kHz capture and the
        // byte cap would silently bind instead. Two hours is 230 MB at 16 kHz
        // and 691 MB at 48 kHz, inside the byte cap at every rate a capture
        // device offers, so the number written here is the number that
        // applies. A recording past either falls back to ninety-second chunks
        // with Plainsong's own diarizer.
        asr::AsrProviderType::MistralVoxtral => Some(WholeFileMeetingLimits {
            max_seconds: 2.0 * 60.0 * 60.0,
            max_bytes: 1_000_000_000,
        }),
        _ => None,
    }
}

/// Whether the meeting lane should send this recording to the provider in one
/// request instead of ninety-second chunks.
///
/// The only reason to do so is to get one consistent speaker space out of a
/// provider that diarizes -- see `provider_speaker_turns_survive_chunking` --
/// so the answer is no whenever speaker separation is off at all, no when the
/// user prefers Plainsong's own diarizer, and no for every provider that does
/// not return speaker labels. A recording past the provider's documented
/// ceiling also gets a no: chunked transcription with Plainsong's own diarizer
/// is a worse answer than provider labels, but a far better one than a
/// rejected request.
///
/// `enable_diarization` is the master switch and is checked here rather than
/// only downstream. It used to be checked only by `resolve_meeting_diarizer`,
/// after the request had already gone out: a user with speaker separation
/// turned off still had the whole meeting uploaded as a single diarized
/// request, paid for the speaker analysis they had declined, and then had the
/// labels thrown away on arrival.
pub(crate) fn should_request_whole_file_meeting(
    provider: asr::AsrProviderType,
    enable_diarization: bool,
    prefer_provider_diarization: bool,
    duration_seconds: f64,
    byte_len: u64,
) -> bool {
    if !enable_diarization || !prefer_provider_diarization {
        return false;
    }
    let Some(limits) = whole_file_meeting_limits(provider) else {
        return false;
    };
    if byte_len == 0 || byte_len > limits.max_bytes {
        return false;
    }
    // A duration we could not measure is not a duration under the limit.
    duration_seconds > 0.0 && duration_seconds <= limits.max_seconds
}

/// Which diarizer, if any, should label the speakers on a finished meeting.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MeetingDiarizer {
    /// Nothing runs: diarization is off, the capture already knows who is
    /// speaking, or no diarizer is available.
    None,
    /// Keep the labels the ASR provider returned with the transcript.
    Provider(asr::AsrProviderType),
    /// Run Plainsong's own embedding pipeline over the audio.
    Local,
}

impl MeetingDiarizer {
    /// The value written to `transcripts.diarizer` and to the audit log. Stable
    /// and machine-readable; the UI turns it into a sentence.
    pub(crate) fn record_value(&self, local_model_id: &str) -> Option<String> {
        match self {
            MeetingDiarizer::None => None,
            MeetingDiarizer::Provider(provider) => {
                Some(asr_provider_to_settings_value(*provider).to_string())
            }
            MeetingDiarizer::Local => Some(format!("plainsong:{local_model_id}")),
        }
    }
}

/// Pure decision so the policy is testable without audio, a key, or a model.
///
/// Order matters and is deliberate:
///
/// 1. Diarization off means nothing runs, whatever came back.
/// 2. A dual-source capture already knows who is speaking -- the microphone is
///    "Me" and the system tap is "Them" -- and that is better evidence than any
///    diarizer, so nothing overwrites it.
/// 3. Provider labels win over the local pipeline when the user prefers them
///    and the provider actually returned some. The audio has already been sent
///    and paid for at that point.
/// 4. Otherwise the local pipeline runs, if it can.
pub(crate) fn resolve_meeting_diarizer(
    enable_diarization: bool,
    prefer_provider_diarization: bool,
    has_source_aware_speakers: bool,
    actual_provider: asr::AsrProviderType,
    provider_turn_count: usize,
    local_diarizer_available: bool,
) -> MeetingDiarizer {
    if !enable_diarization || has_source_aware_speakers {
        return MeetingDiarizer::None;
    }
    if prefer_provider_diarization && provider_turn_count > 0 {
        return MeetingDiarizer::Provider(actual_provider);
    }
    if local_diarizer_available {
        return MeetingDiarizer::Local;
    }
    MeetingDiarizer::None
}

/// Provider speaker turns as a `DiarizationResult`, so they go through exactly
/// the same merge, speaker list and enrichment path as the local diarizer's
/// output. Nothing downstream can tell the two apart, which is the point: the
/// transcript contract does not fork.
pub(crate) fn diarization_result_from_provider_turns(
    turns: &[asr::SpeakerTurn],
    duration: f64,
) -> diarization::DiarizationResult {
    let mut segments = Vec::with_capacity(turns.len());
    let mut speakers: Vec<diarization::Speaker> = Vec::new();
    for turn in turns {
        if !turn.start_time.is_finite()
            || !turn.end_time.is_finite()
            || turn.end_time <= turn.start_time
        {
            continue;
        }
        segments.push(diarization::SpeakerSegment {
            start_time: turn.start_time,
            end_time: turn.end_time,
            speaker_id: turn.speaker_id.clone(),
            confidence: turn.confidence,
        });
        match speakers
            .iter_mut()
            .find(|speaker| speaker.id == turn.speaker_id)
        {
            Some(speaker) => speaker.sample_count += 1,
            None => {
                let index = speakers.len();
                let mut speaker = diarization::speaker_for_index(&turn.speaker_id, index);
                speaker.sample_count = 1;
                speakers.push(speaker);
            }
        }
    }
    diarization::DiarizationResult {
        segments,
        speakers,
        duration,
        method: diarization::DiarizationMethod::Provider,
        // A provider returns labels, not embeddings, so there is nothing to
        // remember a voice by. Voiceprints are a local-diarizer feature.
        cluster_centroids: std::collections::HashMap::new(),
        word_activity: None,
    }
}

pub(crate) fn default_source_speaker_name(speaker_id: &str) -> Option<&'static str> {
    match speaker_id.trim().to_ascii_lowercase().as_str() {
        "me" => Some("Me"),
        "them" => Some("Them"),
        _ => None,
    }
}

pub(crate) fn transcript_has_source_aware_speakers(segments: &[models::TranscriptSegment]) -> bool {
    segments.iter().any(|segment| {
        segment
            .speaker_id
            .as_deref()
            .and_then(default_source_speaker_name)
            .is_some()
    })
}

#[cfg(test)]
pub(crate) fn source_aware_speaker_aliases_from_segments(
    segments: &[models::TranscriptSegment],
) -> std::collections::HashMap<String, String> {
    let mut aliases = std::collections::HashMap::new();
    for segment in segments {
        if let Some(speaker_id) = segment.speaker_id.as_deref() {
            if let Some(name) = default_source_speaker_name(speaker_id) {
                aliases.insert(speaker_id.to_string(), name.to_string());
            }
        }
    }
    aliases
}

fn benchmark_entry_from_result(
    result: &asr::BenchmarkResult,
    id: String,
    created_at: chrono::DateTime<chrono::Utc>,
) -> models::AsrBenchmarkEntry {
    models::AsrBenchmarkEntry {
        id,
        provider_type: asr_provider_to_settings_value(result.provider_type).to_string(),
        provider_name: result.provider_name.clone(),
        model_id: result.model_id.clone(),
        runtime_status: runtime_status_to_db_value(&result.runtime_status).to_string(),
        non_empty_transcript: result.non_empty_transcript,
        processing_time_ms: result.processing_time_ms as i64,
        confidence: result.confidence,
        created_at,
    }
}

pub(crate) async fn persist_benchmark_results(state: &AppState, results: &[asr::BenchmarkResult]) {
    if results.is_empty() {
        return;
    }

    let entries = results
        .iter()
        .map(|result| {
            benchmark_entry_from_result(
                result,
                uuid::Uuid::new_v4().to_string(),
                chrono::Utc::now(),
            )
        })
        .collect::<Vec<_>>();

    let mut db = state.db.lock().await;
    for entry in entries {
        if let Err(error) = db.save_asr_benchmark(&entry) {
            tracing::warn!("Failed to persist ASR benchmark entry: {}", error);
        }
    }
}

pub(crate) fn benchmark_audio_bytes_from_params(
    params: &serde_json::Value,
) -> Result<Vec<u8>, String> {
    let audio_bytes = params
        .get("audioBytes")
        .and_then(serde_json::Value::as_array)
        .ok_or("audioBytes must be an array of bytes")?;
    validate_benchmark_audio_len(audio_bytes.len())?;
    serde_json::from_value(serde_json::Value::Array(audio_bytes.clone()))
        .map_err(|error| format!("Invalid benchmark audio bytes: {error}"))
}

pub(crate) fn validate_benchmark_audio_len(len: usize) -> Result<(), String> {
    if len > MAX_BENCHMARK_AUDIO_BYTES {
        return Err(format!(
            "SIDECAR_SIZE_LIMIT: benchmark audio exceeds {} bytes.",
            MAX_BENCHMARK_AUDIO_BYTES
        ));
    }
    Ok(())
}

pub(crate) fn build_models_transcript_from_asr_result(
    recording_id: &str,
    result: asr::TranscriptionResult,
) -> models::Transcript {
    let fallback_text = result.text.trim().to_string();
    let segments: Vec<models::TranscriptSegment> = result
        .segments
        .into_iter()
        .map(|s| models::TranscriptSegment {
            id: uuid::Uuid::new_v4().to_string(),
            start_time: s.start_time,
            end_time: s.end_time,
            text: s.text,
            speaker_id: None,
            confidence: s.confidence,
        })
        .collect();
    let segments = if segments.is_empty() && !fallback_text.is_empty() {
        vec![models::TranscriptSegment {
            id: uuid::Uuid::new_v4().to_string(),
            start_time: 0.0,
            end_time: 0.0,
            text: fallback_text.clone(),
            speaker_id: None,
            confidence: result.confidence,
        }]
    } else {
        segments
    };

    models::Transcript {
        heard_through_speakers: Vec::new(),
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.to_string(),
        segments,
        full_text: result.text,
        language: result.language,
        confidence: result.confidence,
        model: result.model_name,
        model_id: Some(result.model_id),
        requested_provider: Some(
            asr_provider_to_settings_value(result.requested_provider).to_string(),
        ),
        actual_provider: Some(asr_provider_to_settings_value(result.actual_provider).to_string()),
        measured_word_timestamps: result.measured_word_timestamps,
        created_at: chrono::Utc::now(),
    }
}

#[expect(
    dead_code,
    reason = "provider routing metadata is retained for transcription diagnostics and QA evidence"
)]
pub(crate) struct MeetingTranscriptionOutput {
    pub(crate) transcript: models::Transcript,
    /// Speaker turns the ASR provider itself reported, already on the
    /// recording's timeline. Empty for every local route and for any cloud
    /// route whose labels could not survive chunking.
    pub(crate) speaker_turns: Vec<asr::SpeakerTurn>,
    pub(crate) requested_provider: asr::AsrProviderType,
    pub(crate) actual_provider: asr::AsrProviderType,
    pub(crate) requested_engine: Option<String>,
    pub(crate) actual_engine: Option<String>,
    pub(crate) optimization_applied: bool,
    pub(crate) fallback_reason: Option<String>,
    /// Dictations taken from the microphone during the meeting, decoded on
    /// their own and kept beside the transcript, never in it.
    pub(crate) asides: Vec<crate::meeting_asides::MeetingAside>,
}

/// The aside frames of `track` and its rate, read from its header. An
/// unreadable header places nothing; transcription reports that file itself.
fn aside_ranges_on_track(
    track: &Path,
    aside_spans: &[crate::meeting_asides::AsideSpan],
) -> Option<(Vec<std::ops::Range<u64>>, u32)> {
    if aside_spans.is_empty() {
        return None;
    }
    let (rate, frames) = track_rate_and_frames(track)?;
    let ranges = crate::meeting_asides::aside_frame_ranges(aside_spans, rate, frames);
    Some((ranges, rate))
}

/// A WAV track's sample rate and length in frames, from its header.
fn track_rate_and_frames(track: &Path) -> Option<(u32, u64)> {
    let reader = hound::WavReader::open(track).ok()?;
    Some((reader.spec().sample_rate, u64::from(reader.duration())))
}

/// Keep rows invented over a silenced aside out of the stored transcript.
fn drop_transcript_rows_inside_asides(
    transcript: &mut models::Transcript,
    me_track: &Path,
    aside_spans: &[crate::meeting_asides::AsideSpan],
    scope: crate::meeting_asides::AsideRowScope,
) {
    let Some((ranges, rate)) = aside_ranges_on_track(me_track, aside_spans) else {
        return;
    };
    let seconds = crate::meeting_asides::aside_second_ranges(&ranges, rate);
    let dropped = crate::meeting_asides::drop_rows_inside_asides(transcript, &seconds, scope);
    if dropped > 0 {
        tracing::info!(
            "Dropped {dropped} row(s) the recognizer produced over silenced asides in {}",
            transcript.recording_id
        );
    }
}

/// Mono samples of `track` from frame `range.start` to `range.end`.
pub(crate) fn read_track_frames(
    track: &Path,
    range: &std::ops::Range<u64>,
) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(track).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let start = u32::try_from(range.start).map_err(|error| error.to_string())?;
    reader.seek(start).map_err(|error| error.to_string())?;
    let frames = usize::try_from(
        range
            .end
            .min(u64::from(reader.duration()))
            .saturating_sub(range.start),
    )
    .unwrap_or(usize::MAX);
    let wanted = frames.saturating_mul(channels);
    let interleaved: Vec<f32> = if spec.sample_format == hound::SampleFormat::Float {
        reader
            .samples::<f32>()
            .take(wanted)
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    } else {
        reader
            .samples::<i16>()
            .take(wanted)
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };
    let mono = interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

/// Decode each aside's own audio from the Me track, so the meeting can show
/// it on request. An aside that cannot be read or decoded is skipped: its
/// words stay out of the meeting either way, and its dictation kept them.
pub(crate) async fn transcribe_meeting_asides(
    asr_manager: &asr::AsrManager,
    me_track: &Path,
    aside_spans: &[crate::meeting_asides::AsideSpan],
    provider: asr::AsrProviderType,
    model_id: &str,
    speaker_id: Option<&str>,
) -> Vec<crate::meeting_asides::MeetingAside> {
    if aside_spans.is_empty() {
        return Vec::new();
    }
    let Some((rate, track_frames)) = track_rate_and_frames(me_track) else {
        return Vec::new();
    };
    let mut asides = Vec::new();
    for span in aside_spans {
        let Some(range) = span.frames_on_track(rate, track_frames) else {
            continue;
        };
        let Some(seconds) = crate::meeting_asides::aside_seconds(&range, rate) else {
            continue;
        };
        let decoded = match read_track_frames(me_track, &range) {
            Ok((samples, sample_rate)) => match mono_samples_to_wav_bytes(&samples, sample_rate) {
                Ok(wav) => asr_manager
                    .transcribe_bytes_for_meeting(provider, &wav, Some(model_id))
                    .await
                    .map_err(|error| format!("{error:#}")),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match decoded {
            Ok(result) => asides.push(crate::meeting_asides::place_aside_decode(
                &span.aside_id,
                seconds,
                speaker_id,
                &result,
            )),
            Err(error) => tracing::warn!(
                "Aside {} could not be decoded for the meeting view: {error}",
                span.aside_id
            ),
        }
    }
    asides
}

/// Move the far side heard through the speakers out of the transcript.
///
/// Returns the moved rows, in their original order, for
/// [`models::Transcript::heard_through_speakers`]. What counts as bleed, and
/// why every doubt keeps the user's words, is in [`crate::meeting_bleed`].
/// Untimed rows and single-source transcripts are never touched.
pub(crate) fn separate_far_side_bleed(
    segments: &mut Vec<models::TranscriptSegment>,
    acoustics: Option<&crate::meeting_bleed::BleedAcoustics>,
) -> Vec<models::TranscriptSegment> {
    let bleed = crate::meeting_bleed::far_side_bleed_rows(segments, acoustics);
    if bleed.is_empty() {
        return Vec::new();
    }
    let mut kept = Vec::with_capacity(segments.len() - bleed.len());
    let mut moved = Vec::with_capacity(bleed.len());
    for (row, segment) in segments.drain(..).enumerate() {
        if bleed.contains(&row) {
            moved.push(segment);
        } else {
            kept.push(segment);
        }
    }
    *segments = kept;
    moved
}

pub(crate) fn build_source_aware_models_transcript(
    recording_id: &str,
    provider: asr::AsrProviderType,
    model_id: &str,
    mut source_transcripts: Vec<(&str, asr::TranscriptionResult)>,
    acoustics: Option<&crate::meeting_bleed::BleedAcoustics>,
) -> models::Transcript {
    let mut segments: Vec<models::TranscriptSegment> = Vec::new();
    let mut language = "en".to_string();
    let mut model_name = provider.display_name().to_string();
    let mut requested_provider = provider;
    let mut actual_provider = provider;
    let mut weighted_confidence_sum = 0.0_f64;
    let mut weighted_confidence_count = 0.0_f64;
    let mut measured_word_timestamps = true;

    for (speaker_id, result) in source_transcripts.drain(..) {
        if language == "en" && !result.language.trim().is_empty() {
            language = result.language.clone();
        }
        if model_name == provider.display_name() && !result.model_name.trim().is_empty() {
            model_name = result.model_name.clone();
        }
        requested_provider = result.requested_provider;
        actual_provider = result.actual_provider;
        // A chunk with no words (trailing silence) says nothing about
        // timing, so it must not mark the whole meeting untimed.
        if !result.segments.is_empty() || !result.text.trim().is_empty() {
            measured_word_timestamps &= result.measured_word_timestamps;
        }

        let text_weight = result.text.chars().count().max(1) as f64;
        weighted_confidence_sum += result.confidence * text_weight;
        weighted_confidence_count += text_weight;

        let fallback_text = result.text.trim().to_string();
        let mut inserted_source_segment = false;
        for segment in result.segments {
            let text = segment.text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            inserted_source_segment = true;
            segments.push(models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: segment.start_time,
                end_time: segment.end_time,
                text,
                speaker_id: Some(speaker_id.to_string()),
                confidence: segment.confidence,
            });
        }
        if !inserted_source_segment && !fallback_text.is_empty() {
            segments.push(models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: 0.0,
                end_time: 0.0,
                text: fallback_text,
                speaker_id: Some(speaker_id.to_string()),
                confidence: result.confidence,
            });
        }
    }

    let mut heard_through_speakers = separate_far_side_bleed(&mut segments, acoustics);
    if !heard_through_speakers.is_empty() {
        tracing::info!(
            "Set aside {} microphone row(s) that repeated the far side through the speakers for {recording_id} (acoustic check: {})",
            heard_through_speakers.len(),
            if acoustics.is_some() { "used" } else { "unavailable" }
        );
    }
    heard_through_speakers.sort_by(|left, right| left.start_time.total_cmp(&right.start_time));

    segments.sort_by(|left, right| {
        left.start_time
            .partial_cmp(&right.start_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let full_text = segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let measured_word_timestamps = measured_word_timestamps && !segments.is_empty();

    models::Transcript {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.to_string(),
        segments,
        full_text,
        language,
        confidence: if weighted_confidence_count > 0.0 {
            weighted_confidence_sum / weighted_confidence_count
        } else {
            0.0
        },
        model: model_name,
        model_id: Some(model_id.to_string()),
        requested_provider: Some(asr_provider_to_settings_value(requested_provider).to_string()),
        actual_provider: Some(asr_provider_to_settings_value(actual_provider).to_string()),
        measured_word_timestamps,
        created_at: chrono::Utc::now(),
        heard_through_speakers,
    }
}

/// Builds a single human-readable note describing every way a dual-source
/// (mic + system audio) meeting transcription pass came out degraded: a
/// whole side failing outright, or a side succeeding but still carrying its
/// own chunk-level `fallback_reason` from `transcribe_recording_in_chunks`.
/// Returns `None` when both sides transcribed cleanly.
pub(crate) fn describe_dual_source_transcription_degradation(
    mic_result: &Result<asr::TranscriptionResult, String>,
    system_result: &Result<asr::TranscriptionResult, String>,
) -> Option<String> {
    let mut notes: Vec<String> = Vec::new();
    for (label, result) in [("microphone", mic_result), ("system", system_result)] {
        match result {
            Ok(result) => {
                if let Some(reason) = result
                    .fallback_reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|reason| !reason.is_empty())
                {
                    notes.push(format!("{} audio: {}", label, reason));
                }
            }
            Err(error) => notes.push(format!("{} audio failed to transcribe: {}", label, error)),
        }
    }
    if notes.is_empty() {
        None
    } else {
        Some(notes.join("; "))
    }
}

/// One single-source meeting transcription, taking the whole recording in one
/// provider request when that provider can carry it and the user prefers
/// provider diarization, and falling back to the ninety-second chunked path
/// otherwise.
///
/// A whole-file attempt that fails does not fail the meeting: the chunked path
/// runs afterwards, the user gets a transcript, and the labels are Plainsong's
/// own. Losing an hour of audio to get nicer speaker badges would be a bad
/// trade.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn transcribe_single_source_meeting(
    app: &impl crate::sidecar_handle::AppEmitter,
    asr_manager: Arc<asr::AsrManager>,
    recording_id: &str,
    audio_path: &Path,
    provider: asr::AsrProviderType,
    model_id: String,
    enable_diarization: bool,
    prefer_provider_diarization: bool,
    wait_budget: &MeetingWaitBudget,
    aside_spans: &[crate::meeting_asides::AsideSpan],
) -> Result<asr::TranscriptionResult, String> {
    let byte_len = tokio::fs::metadata(audio_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let duration_seconds =
        compute_wav_duration_seconds(audio_path.to_string_lossy().as_ref()).max(0) as f64;

    // A whole-file request sends the file as it is; asides on it have to be
    // silenced chunk by chunk first.
    if aside_spans.is_empty()
        && should_request_whole_file_meeting(
            provider,
            enable_diarization,
            prefer_provider_diarization,
            duration_seconds,
            byte_len,
        )
    {
        // No chunk-level progress is available on this route, so say the
        // transcription started rather than leaving the meeting looking
        // stalled for the length of one upload.
        emit_recording_status(
            app,
            recording_id,
            "processing",
            Some("Processing transcript"),
            Some(0.0),
        );
        match asr_manager
            .transcribe_path_for_meeting(provider, audio_path, Some(model_id.as_str()))
            .await
        {
            Ok(result) => {
                emit_recording_status(
                    app,
                    recording_id,
                    "processing",
                    Some("Processing transcript"),
                    Some(1.0),
                );
                return Ok(result);
            }
            Err(error) => tracing::warn!(
                "Whole-recording {} transcription failed for {}; falling back to chunked \
                 transcription and local diarization: {}",
                provider.display_name(),
                recording_id,
                error
            ),
        }
    }

    transcribe_recording_in_chunks(
        app,
        asr_manager,
        recording_id,
        audio_path,
        provider,
        model_id,
        wait_budget,
        aside_spans,
    )
    .await
}

/// Whether the separate Me and Them tracks run as long as the combined
/// recording. All three are written sample-aligned, so a separate track that
/// is shorter stopped saving partway through, and transcribing it would drop
/// everything that side said afterwards. Unreadable headers answer yes and
/// leave the decision to the transcription itself, as before.
pub(crate) fn separate_tracks_cover_the_mix(mixed: &Path, mic: &Path, system: &Path) -> bool {
    let frames = |path: &Path| {
        hound::WavReader::open(path)
            .ok()
            .map(|reader| (u64::from(reader.duration()), reader.spec().sample_rate))
    };
    let (Some((mixed_frames, sample_rate)), Some((mic_frames, _)), Some((system_frames, _))) =
        (frames(mixed), frames(mic), frames(system))
    else {
        return true;
    };
    // One second of slack: the tracks end together, but a stop can land a
    // partial chunk differently on each.
    let slack = u64::from(sample_rate);
    mic_frames + slack >= mixed_frames && system_frames + slack >= mixed_frames
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn transcribe_meeting_recording(
    app: &impl crate::sidecar_handle::AppEmitter,
    asr_manager: Arc<asr::AsrManager>,
    recording_id: &str,
    mixed_audio_path: &Path,
    mic_audio_path: Option<&Path>,
    system_audio_path: Option<&Path>,
    provider: asr::AsrProviderType,
    model_id: String,
    enable_diarization: bool,
    prefer_provider_diarization: bool,
    wait_budget: &MeetingWaitBudget,
    aside_spans: &[crate::meeting_asides::AsideSpan],
) -> Result<MeetingTranscriptionOutput, String> {
    // Without separate tracks the recording is microphone-only, and its one
    // track is the Me track. A Me + Them recording's combined track already
    // carries only the far side during an aside.
    let primary_is_me_track = mic_audio_path.is_none() && system_audio_path.is_none();
    let primary_aside_spans = if primary_is_me_track {
        aside_spans
    } else {
        &[]
    };
    let mic_path = mic_audio_path.filter(|path| path.exists());
    let system_path = system_audio_path.filter(|path| path.exists());
    let (mic_path, system_path) = match (mic_path, system_path) {
        (Some(mic), Some(system))
            if !separate_tracks_cover_the_mix(mixed_audio_path, mic, system) =>
        {
            tracing::warn!(
                "A separate track of {} stopped saving early; transcribing the combined recording",
                recording_id
            );
            (None, None)
        }
        paths => paths,
    };

    if mic_path.is_none() || system_path.is_none() {
        let result = transcribe_single_source_meeting(
            app,
            Arc::clone(&asr_manager),
            recording_id,
            mixed_audio_path,
            provider,
            model_id.clone(),
            enable_diarization,
            prefer_provider_diarization,
            wait_budget,
            primary_aside_spans,
        )
        .await?;
        return Ok(single_source_meeting_output(
            &asr_manager,
            recording_id,
            mixed_audio_path,
            primary_aside_spans,
            provider,
            &model_id,
            result,
        )
        .await);
    }

    let mic_result = transcribe_recording_in_chunks(
        app,
        Arc::clone(&asr_manager),
        recording_id,
        mic_path.as_ref().expect("checked above"),
        provider,
        model_id.clone(),
        wait_budget,
        aside_spans,
    )
    .await;
    // The system track is never touched: during an aside the far side kept
    // talking, and every word of it belongs to the meeting.
    let system_result = transcribe_recording_in_chunks(
        app,
        Arc::clone(&asr_manager),
        recording_id,
        system_path.as_ref().expect("checked above"),
        provider,
        model_id.clone(),
        wait_budget,
        &[],
    )
    .await;

    // Capture a human-readable degradation note before consuming the results
    // below: an entire side failing outright, or a side succeeding but still
    // carrying its own chunk-level fallback_reason from
    // transcribe_recording_in_chunks. Unlike the single-file path below,
    // nothing else threads this through, so it must be captured here or it's
    // lost for good.
    let fallback_reason =
        describe_dual_source_transcription_degradation(&mic_result, &system_result);

    let mut source_results = Vec::new();
    match mic_result {
        Ok(result) => source_results.push(("me", result)),
        Err(error) => tracing::warn!(
            "Microphone-side meeting transcription failed for {}: {}",
            recording_id,
            error
        ),
    }
    match system_result {
        Ok(result) => source_results.push(("them", result)),
        Err(error) => tracing::warn!(
            "System-audio-side meeting transcription failed for {}: {}",
            recording_id,
            error
        ),
    }

    if source_results.is_empty() {
        let result = transcribe_single_source_meeting(
            app,
            Arc::clone(&asr_manager),
            recording_id,
            mixed_audio_path,
            provider,
            model_id.clone(),
            enable_diarization,
            prefer_provider_diarization,
            wait_budget,
            &[],
        )
        .await?;
        let mut output = single_source_meeting_output(
            &asr_manager,
            recording_id,
            mixed_audio_path,
            &[],
            provider,
            &model_id,
            result,
        )
        .await;
        // The combined track holds no aside; the Me track still has them.
        if let Some(mic) = mic_path {
            output.asides = transcribe_meeting_asides(
                &asr_manager,
                mic,
                aside_spans,
                provider,
                &model_id,
                Some("me"),
            )
            .await;
        }
        return Ok(output);
    }

    // The two tracks' loudness, so bleed is only set aside where the
    // microphone actually followed the far side. Reading two long WAVs is
    // blocking work; an unreadable file leaves the text and timing rules to
    // decide alone.
    let acoustics = {
        let mic = mic_path.map(Path::to_path_buf);
        let system = system_path.map(Path::to_path_buf);
        tokio::task::spawn_blocking(move || {
            crate::meeting_bleed::BleedAcoustics::from_wav_files(
                mic.as_deref()?,
                system.as_deref()?,
            )
        })
        .await
        .ok()
        .flatten()
    };
    let mut transcript = build_source_aware_models_transcript(
        recording_id,
        provider,
        &model_id,
        source_results,
        acoustics.as_ref(),
    );
    let me_track = mic_path.expect("checked above");
    drop_transcript_rows_inside_asides(
        &mut transcript,
        me_track,
        aside_spans,
        crate::meeting_asides::AsideRowScope::Speaker("me"),
    );
    let asides = transcribe_meeting_asides(
        &asr_manager,
        me_track,
        aside_spans,
        provider,
        &model_id,
        Some("me"),
    )
    .await;

    Ok(MeetingTranscriptionOutput {
        transcript,
        // A dual-source capture labels its own speakers ("Me" from the
        // microphone, "Them" from the system tap), which is better evidence
        // than any diarizer -- provider labels are neither needed nor used.
        speaker_turns: Vec::new(),
        requested_provider: provider,
        actual_provider: provider,
        requested_engine: None,
        actual_engine: None,
        optimization_applied: false,
        fallback_reason,
        asides,
    })
}

/// The output of a meeting transcribed from one track. When that track is
/// the Me track (`aside_spans` non-empty), rows over its silenced asides are
/// dropped and each aside is decoded on its own.
pub(crate) async fn single_source_meeting_output(
    asr_manager: &asr::AsrManager,
    recording_id: &str,
    track: &Path,
    aside_spans: &[crate::meeting_asides::AsideSpan],
    provider: asr::AsrProviderType,
    model_id: &str,
    result: asr::TranscriptionResult,
) -> MeetingTranscriptionOutput {
    let requested_provider = result.requested_provider;
    let actual_provider = result.actual_provider;
    let requested_engine = result.requested_engine.clone();
    let actual_engine = result.actual_engine.clone();
    let optimization_applied = result.optimization_applied;
    let fallback_reason = result.fallback_reason.clone();
    let speaker_turns = result.speaker_turns.clone();
    let mut transcript = build_models_transcript_from_asr_result(recording_id, result);
    drop_transcript_rows_inside_asides(
        &mut transcript,
        track,
        aside_spans,
        crate::meeting_asides::AsideRowScope::AllRows,
    );
    let asides =
        transcribe_meeting_asides(asr_manager, track, aside_spans, provider, model_id, None).await;
    MeetingTranscriptionOutput {
        transcript,
        speaker_turns,
        requested_provider,
        actual_provider,
        requested_engine,
        actual_engine,
        optimization_applied,
        fallback_reason,
        asides,
    }
}

#[cfg(test)]
mod separate_track_coverage_tests {
    use super::separate_tracks_cover_the_mix;

    fn wav(path: &std::path::Path, seconds: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..16_000 * seconds {
            writer.write_sample(0_i16).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn a_separate_track_that_stopped_early_sends_transcription_to_the_mix() {
        let dir = crate::test_fs::TempDir::new("track-coverage");
        let (mixed, mic, system) = (
            dir.path().join("m.wav"),
            dir.path().join("mic.wav"),
            dir.path().join("sys.wav"),
        );
        wav(&mixed, 6);
        wav(&mic, 6);
        wav(&system, 6);
        assert!(separate_tracks_cover_the_mix(&mixed, &mic, &system));

        wav(&dir.path().join("short.wav"), 2);
        assert!(!separate_tracks_cover_the_mix(
            &mixed,
            &dir.path().join("short.wav"),
            &system
        ));
        // An unreadable header leaves the decision to transcription, as before.
        std::fs::write(dir.path().join("junk.wav"), b"junk").unwrap();
        assert!(separate_tracks_cover_the_mix(
            &mixed,
            &dir.path().join("junk.wav"),
            &system
        ));
    }
}

#[cfg(test)]
mod chunk_headroom_retry_tests {
    use super::*;
    use std::time::Duration;

    const REFUSED: &str = "NVIDIA Parakeet failed: Could not verify native memory headroom";
    const BUSY: &str =
        "NVIDIA Parakeet failed: Another local text operation is running. Try again after it finishes.";

    fn delays(error: &str, busy: bool) -> Vec<Option<(Duration, MeetingWaitReason)>> {
        (0..9)
            .map(|retry| {
                let (headroom, busy_retries) = if busy { (0, retry) } else { (retry, 0) };
                meeting_local_retry_wait(
                    asr::AsrProviderType::Parakeet,
                    error,
                    headroom,
                    busy_retries,
                    Duration::ZERO,
                )
                .map(|wait| (wait.delay, wait.reason))
            })
            .collect()
    }

    #[test]
    fn a_local_headroom_refusal_keeps_retrying_at_sixty_seconds_within_the_budget() {
        let expected: Vec<_> = [5, 10, 20, 40, 60, 60, 60, 60, 60]
            .map(|seconds| {
                Some((
                    Duration::from_secs(seconds),
                    MeetingWaitReason::MemoryHeadroom,
                ))
            })
            .into_iter()
            .collect();
        assert_eq!(delays(REFUSED, false), expected);
    }

    #[test]
    fn exhausted_memory_admission_defers_the_recording_but_other_failures_do_not() {
        let local = asr::AsrProviderType::Parakeet;
        let budget = MeetingWaitBudget::new();
        let mut retries = 0;
        while let Some(wait) = budget.retry_after_failure(local, REFUSED, retries, 0) {
            assert!(!budget.memory_deferred());
            budget.spend(wait.delay);
            retries += 1;
        }
        assert!(
            retries > 5,
            "retries continue after the first minute-long delay"
        );
        assert!(budget.waited() <= MEETING_WAIT_BUDGET);
        assert!(budget.memory_deferred());
        for (provider, error) in [
            (local, "corrupt model"),
            (asr::AsrProviderType::Deepgram, REFUSED),
            (local, BUSY),
        ] {
            let budget = MeetingWaitBudget::new();
            budget.spend(MEETING_WAIT_BUDGET);
            assert!(budget.retry_after_failure(provider, error, 0, 0).is_none());
            assert!(!budget.memory_deferred());
        }
    }

    #[test]
    fn a_busy_native_runtime_is_retried_on_a_short_schedule() {
        let expected: Vec<_> = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
            .map(|millis| {
                Some((
                    Duration::from_millis(millis),
                    MeetingWaitReason::RuntimeBusy,
                ))
            })
            .into_iter()
            .chain([None, None])
            .collect();
        assert_eq!(delays(BUSY, true), expected);
    }

    #[test]
    fn other_failures_and_cloud_routes_are_not_retried() {
        let local = asr::AsrProviderType::Parakeet;
        assert_eq!(
            meeting_local_retry_wait(
                local,
                "Parakeet model files failed their integrity check.",
                0,
                0,
                Duration::ZERO
            ),
            None
        );
        for error in [REFUSED, BUSY] {
            assert_eq!(
                meeting_local_retry_wait(
                    asr::AsrProviderType::Deepgram,
                    error,
                    0,
                    0,
                    Duration::ZERO
                ),
                None
            );
        }
    }

    #[test]
    fn a_recording_stops_waiting_once_its_budget_is_spent() {
        let local = asr::AsrProviderType::Parakeet;
        let wait = |waited| {
            meeting_local_retry_wait(local, REFUSED, 0, 0, Duration::from_secs(waited))
                .map(|wait| wait.delay)
        };
        assert_eq!(wait(594), Some(Duration::from_secs(5)));
        assert_eq!(wait(596), None);
    }

    /// The microphone and system-audio tracks, and speaker separation after
    /// them, draw on one budget: what one track waited is gone for the next.
    #[test]
    fn every_step_of_one_recording_shares_its_wait_budget() {
        let budget = MeetingWaitBudget::new();
        // The microphone track waits out most of the budget...
        for _ in 0..9 {
            budget.spend(Duration::from_secs(60));
        }
        budget.spend(Duration::from_secs(58));
        // ...so the system track's first refusal (5 s) no longer fits.
        assert_eq!(
            meeting_local_retry_wait(
                asr::AsrProviderType::Parakeet,
                REFUSED,
                0,
                0,
                budget.waited()
            ),
            None
        );
        // A busy runtime still gets its half-second retry.
        assert!(meeting_retry_wait(BUSY, 0, 0, budget.waited()).is_some());
    }

    #[test]
    fn a_failed_diarization_note_names_the_cause_and_the_way_back() {
        let memory = meeting_diarization_failure_notice(
            "Failed to create embedding extractor: Not enough verified memory headroom for native inference working buffers alongside other applications.",
        );
        assert!(memory.contains("not enough free memory"), "{memory}");
        assert!(memory.contains("Label the speakers"), "{memory}");
        let busy = meeting_diarization_failure_notice(BUSY);
        assert!(busy.contains("was using the speech model"), "{busy}");
        // A pass that waited out the recording's budget behind foreground
        // work was kept busy; the model itself did not fail.
        let exhausted = meeting_diarization_failure_notice(
            "Meeting wait budget exhausted during speaker separation",
        );
        assert!(
            exhausted.contains("was using the speech model"),
            "{exhausted}"
        );
        assert!(!exhausted.contains("could not run"), "{exhausted}");
        let other = meeting_diarization_failure_notice("No usable speech embeddings");
        assert!(other.contains("could not run"), "{other}");
        let manual = manual_diarization_failure_message(
            "Failed to create embedding extractor: ONNX diarization model inference failed",
        );
        assert!(manual.contains("could not run"), "{manual}");
        for note in [memory, busy, other, manual] {
            let lower = note.to_ascii_lowercase();
            for banned in [
                "runtime",
                "headroom",
                "onnx",
                "embedd",
                "extractor",
                "admission",
            ] {
                assert!(!lower.contains(banned), "{banned} in {note}");
            }
        }
    }

    #[test]
    fn the_meeting_lane_creates_one_wait_budget_per_recording() {
        const SOURCE: &str = include_str!("meeting_pipeline.rs");
        assert_eq!(
            SOURCE.matches("MeetingWaitBudget::").count(),
            1,
            "one budget for the whole recording, shared by transcription and diarization"
        );
        assert_eq!(
            SOURCE
                .matches("MeetingWaitBudget::sharing_runtime_with(")
                .count(),
            1,
            "a model release during a meeting's wait must respect dictation"
        );
        const TRANSCRIBE: &str = include_str!("meeting_transcribe.rs");
        let body = &TRANSCRIBE[TRANSCRIBE
            .find("pub(crate) async fn transcribe_meeting_recording(")
            .expect("transcribe_meeting_recording")..];
        let body = &body[..body.find("\n}\n").expect("function end")];
        assert!(
            !body.contains("MeetingWaitBudget::new()"),
            "the tracks must not get budgets of their own"
        );
    }
}

#[cfg(test)]
mod benchmark_persistence_tests {
    use super::*;

    #[test]
    fn persistence_uses_the_model_snapshot_from_the_result() {
        let result = asr::BenchmarkResult {
            provider_type: asr::AsrProviderType::Whisper,
            provider_name: "Whisper".to_string(),
            model_id: "selected-a".to_string(),
            runtime_status: crate::RuntimeStatus::Ready,
            non_empty_transcript: true,
            processing_time_ms: 42,
            transcription: "hello".to_string(),
            confidence: 0.9,
            error_message: None,
        };

        let entry = benchmark_entry_from_result(&result, "id".to_string(), chrono::Utc::now());

        assert_eq!(entry.model_id, "selected-a");
        assert_ne!(entry.model_id, "current-b");
    }
}

#[cfg(test)]
mod stored_audio_precision_tests {
    #[test]
    fn pcm24_chunks_reach_the_provider_without_pcm16_quantization() {
        let samples = [-1.0, -0.123456, 0.0, 0.123456, 8_388_607.0 / 8_388_608.0];
        let bytes = super::meeting_float_chunk(&samples, 16_000).unwrap();
        let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().sample_format, hound::SampleFormat::Float);
        assert_eq!(
            reader
                .samples::<f32>()
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            samples
        );
    }
}
