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

pub(crate) async fn transcribe_recording_in_chunks(
    app: &impl crate::sidecar_handle::AppEmitter,
    asr_manager: Arc<asr::AsrManager>,
    recording_id: &str,
    audio_path: &Path,
    provider: asr::AsrProviderType,
    model_id: String,
) -> Result<asr::TranscriptionResult, String> {
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
            let chunk_start_seconds = chunk_start_frame as f64 / spec.sample_rate as f64;
            let chunk_end_seconds =
                (chunk_start_frame + chunk.len()) as f64 / spec.sample_rate as f64;
            app.emit_event(
                "recording-transcription-progress",
                serde_json::json!({
                    "recordingId": recording_id,
                    "chunkIndex": chunk_idx + 1,
                    "progress": if total_duration_seconds > 0.0 {
                        (chunk_start_seconds / total_duration_seconds).clamp(0.0, 1.0)
                    } else {
                        0.0
                    },
                    "stage": "chunk_started",
                    "startTime": chunk_start_seconds,
                    "endTime": chunk_end_seconds,
                }),
            );
            let wav_chunk = mono_samples_to_wav_bytes(&chunk, spec.sample_rate)?;
            let result = asr_manager
                .transcribe_bytes_for_meeting(provider, &wav_chunk, Some(model_id.as_str()))
                .await
                .map_err(|error| {
                    format!(
                        "Chunk {} failed at {:.1}s: {}",
                        chunk_idx + 1,
                        chunk_start_frame as f64 / spec.sample_rate as f64,
                        error
                    )
                })?;

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
        for sample in reader.samples::<i16>() {
            let sample = sample.map_err(|error| format!("Failed to read wav sample: {}", error))?;
            channel_accumulator.push(sample as f32 / i16::MAX as f32);
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
    })
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

pub(crate) async fn persist_benchmark_results(state: &AppState, results: &[asr::BenchmarkResult]) {
    if results.is_empty() {
        return;
    }

    let mut entries = Vec::new();
    for result in results {
        let model_id = state
            .asr_manager
            .provider_model_id(result.provider_type)
            .await;
        entries.push(models::AsrBenchmarkEntry {
            id: uuid::Uuid::new_v4().to_string(),
            provider_type: asr_provider_to_settings_value(result.provider_type).to_string(),
            provider_name: result.provider_name.clone(),
            model_id,
            runtime_status: runtime_status_to_db_value(&result.runtime_status).to_string(),
            non_empty_transcript: result.non_empty_transcript,
            processing_time_ms: result.processing_time_ms as i64,
            confidence: result.confidence,
            created_at: chrono::Utc::now(),
        });
    }

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
}

pub(crate) fn build_source_aware_models_transcript(
    recording_id: &str,
    provider: asr::AsrProviderType,
    model_id: &str,
    mut source_transcripts: Vec<(&str, asr::TranscriptionResult)>,
) -> models::Transcript {
    let mut segments: Vec<models::TranscriptSegment> = Vec::new();
    let mut full_text_parts: Vec<(f64, String)> = Vec::new();
    let mut language = "en".to_string();
    let mut model_name = provider.display_name().to_string();
    let mut requested_provider = provider;
    let mut actual_provider = provider;
    let mut weighted_confidence_sum = 0.0_f64;
    let mut weighted_confidence_count = 0.0_f64;

    for (speaker_id, result) in source_transcripts.drain(..) {
        if language == "en" && !result.language.trim().is_empty() {
            language = result.language.clone();
        }
        if model_name == provider.display_name() && !result.model_name.trim().is_empty() {
            model_name = result.model_name.clone();
        }
        requested_provider = result.requested_provider;
        actual_provider = result.actual_provider;

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
            full_text_parts.push((segment.start_time, text.clone()));
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
            full_text_parts.push((0.0, fallback_text.clone()));
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

    segments.sort_by(|left, right| {
        left.start_time
            .partial_cmp(&right.start_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    full_text_parts.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let full_text = full_text_parts
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join(" ");

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
        created_at: chrono::Utc::now(),
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
) -> Result<asr::TranscriptionResult, String> {
    let byte_len = tokio::fs::metadata(audio_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let duration_seconds =
        compute_wav_duration_seconds(audio_path.to_string_lossy().as_ref()).max(0) as f64;

    if should_request_whole_file_meeting(
        provider,
        enable_diarization,
        prefer_provider_diarization,
        duration_seconds,
        byte_len,
    ) {
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
    )
    .await
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
) -> Result<MeetingTranscriptionOutput, String> {
    let mic_path = mic_audio_path.filter(|path| path.exists());
    let system_path = system_audio_path.filter(|path| path.exists());

    if mic_path.is_none() || system_path.is_none() {
        let result = transcribe_single_source_meeting(
            app,
            Arc::clone(&asr_manager),
            recording_id,
            mixed_audio_path,
            provider,
            model_id,
            enable_diarization,
            prefer_provider_diarization,
        )
        .await?;
        let requested_provider = result.requested_provider;
        let actual_provider = result.actual_provider;
        let requested_engine = result.requested_engine.clone();
        let actual_engine = result.actual_engine.clone();
        let optimization_applied = result.optimization_applied;
        let fallback_reason = result.fallback_reason.clone();
        let speaker_turns = result.speaker_turns.clone();
        return Ok(MeetingTranscriptionOutput {
            transcript: build_models_transcript_from_asr_result(recording_id, result),
            speaker_turns,
            requested_provider,
            actual_provider,
            requested_engine,
            actual_engine,
            optimization_applied,
            fallback_reason,
        });
    }

    let mic_result = transcribe_recording_in_chunks(
        app,
        Arc::clone(&asr_manager),
        recording_id,
        mic_path.as_ref().expect("checked above"),
        provider,
        model_id.clone(),
    )
    .await;
    let system_result = transcribe_recording_in_chunks(
        app,
        Arc::clone(&asr_manager),
        recording_id,
        system_path.as_ref().expect("checked above"),
        provider,
        model_id.clone(),
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
            model_id,
            enable_diarization,
            prefer_provider_diarization,
        )
        .await?;
        let requested_provider = result.requested_provider;
        let actual_provider = result.actual_provider;
        let requested_engine = result.requested_engine.clone();
        let actual_engine = result.actual_engine.clone();
        let optimization_applied = result.optimization_applied;
        let fallback_reason = result.fallback_reason.clone();
        let speaker_turns = result.speaker_turns.clone();
        return Ok(MeetingTranscriptionOutput {
            transcript: build_models_transcript_from_asr_result(recording_id, result),
            speaker_turns,
            requested_provider,
            actual_provider,
            requested_engine,
            actual_engine,
            optimization_applied,
            fallback_reason,
        });
    }

    let transcript =
        build_source_aware_models_transcript(recording_id, provider, &model_id, source_results);

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
    })
}
