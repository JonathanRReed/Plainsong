//! Headless meeting evaluation: the post-capture meeting path the app runs on a
//! finished single-source recording, without the database, the renderer or a
//! capture device.
//!
//! The steps are the product's own functions in the product's order:
//! `transcribe_single_source_meeting` (ninety-second pause-aligned chunks), or
//! a whole-file request to see how a provider behaves unchunked, then
//! `build_models_transcript_from_asr_result` and `enrich_meeting_transcript`,
//! then the local diarizer and the same measured-word or proportional merge
//! `run_meeting_transcription_pipeline` picks. Nothing is persisted. The
//! `meeting-eval` binary is the only caller; see its usage text.

pub use crate::diarization::{ClusterRefinement, DEFAULT_CLUSTER_REFINEMENT};
use crate::{asr, diarization, models};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// How the recording reaches the recognizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingEvalAsrMode {
    /// What the app does for every local meeting provider.
    MeetingChunks,
    /// One request for the whole file (`transcribe_path_for_meeting`).
    WholeFile,
}

#[derive(Debug, Clone)]
pub struct MeetingEvalOptions {
    pub audio: PathBuf,
    pub provider: asr::AsrProviderType,
    pub model_id: String,
    pub asr_mode: MeetingEvalAsrMode,
    /// `None` skips diarization.
    pub diarization_model_id: Option<String>,
    /// Reuse the transcript of an earlier report instead of running ASR, so
    /// diarizers can be compared on identical text without a second ASR model
    /// resident.
    pub transcript_from: Option<PathBuf>,
    /// Embedding-diarizer refinement; the product default unless overridden.
    pub refinement: ClusterRefinement,
    /// Microphone and system-audio tracks of a "Me + Them" meeting. When set,
    /// `audio` is the mixed track and the run takes the app's source-aware
    /// path (`transcribe_meeting_recording`), which labels rows "me" and
    /// "them" and removes far-side speech the microphone heard through the
    /// speakers.
    pub source_tracks: Option<(PathBuf, PathBuf)>,
    /// Dictations taken from the microphone during the meeting, on its Me
    /// track (the `--mic` track, or `audio` for a microphone-only meeting).
    pub aside_spans: Vec<crate::meeting_asides::AsideSpan>,
    /// Words only the asides say. The transcript and the notes input must
    /// contain none of them.
    pub canaries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalTurn {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEvalReport {
    pub audio: String,
    pub duration_seconds: f64,
    pub provider: String,
    pub model_id: String,
    pub asr_mode: String,
    pub asr_wall_ms: u64,
    pub asr_peak_rss_bytes: u64,
    pub measured_word_timestamps: bool,
    pub fallback_reason: Option<String>,
    /// Where each chunk started and ended, from the progress events the app
    /// would have sent the renderer.
    pub chunks: Vec<[f64; 2]>,
    pub text: String,
    /// Rows exactly as the transcript would be stored before diarization.
    pub segments: Vec<EvalSegment>,
    pub diarization_model_id: Option<String>,
    pub diarization_wall_ms: Option<u64>,
    pub diarization_peak_rss_bytes: Option<u64>,
    /// Peak physical footprint (what admission budgets and Activity Monitor
    /// call memory), which can exceed the resident set.
    pub diarization_peak_footprint_bytes: Option<u64>,
    pub diarization_error: Option<String>,
    pub diarization_turns: Vec<EvalTurn>,
    /// Rows after the diarization merge, as the transcript would read.
    pub merged: Vec<EvalSegment>,
    /// What the far-side bleed check did, on the `--mic`/`--system` path only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_aware: Option<SourceAwareEval>,
    /// Where the asides went, when the run was given any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asides: Option<AsideEval>,
}

/// The aside leak check: every canary hit outside `aside_canary_hits` is a
/// leak, and the kill criteria require there to be none.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideEval {
    pub spans: Vec<crate::meeting_asides::AsideSpan>,
    /// Each aside's own decode, as the meeting's "Show asides" lists it.
    pub asides: Vec<crate::meeting_asides::MeetingAside>,
    /// Canary words in the stored transcript: its text, its rows and the rows
    /// set aside as heard through the speakers.
    pub transcript_canary_hits: Vec<(String, usize)>,
    /// Canary words in what meeting notes, search and Ask are given.
    pub notes_input_canary_hits: Vec<(String, usize)>,
    pub search_canary_hits: Vec<(String, usize)>,
    /// Canary words in the asides' own decode, which shows each aside was
    /// heard at all.
    pub aside_canary_hits: Vec<(String, usize)>,
}

/// Count where the canaries landed once the transcript is built.
fn aside_eval(
    options: &MeetingEvalOptions,
    transcript: &models::Transcript,
    asides: Vec<crate::meeting_asides::MeetingAside>,
) -> anyhow::Result<Option<AsideEval>> {
    if options.aside_spans.is_empty() && options.canaries.is_empty() {
        return Ok(None);
    }
    let canaries: Vec<&str> = options.canaries.iter().map(String::as_str).collect();
    let directory = crate::paths::data_dir()
        .ok_or_else(|| anyhow::anyhow!("Missing isolated data directory"))?
        .join("Plainsong");
    std::fs::create_dir_all(&directory)?;
    let mut db = crate::db::Database::open_at_path(
        &directory.join(format!("aside-eval-{}.db", uuid::Uuid::new_v4())),
        None,
    )?;
    let recording: models::Recording = serde_json::from_value(
        serde_json::json!({"id":transcript.recording_id,"title":"Synthetic meeting","projectId":"default","duration":0,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":options.audio,"status":"completed"}),
    )?;
    db.create_recording(&recording)?;
    for span in &options.aside_spans {
        db.insert_pending_aside(
            &transcript.recording_id,
            &crate::meeting_asides::AsideTicket {
                aside_id: span.aside_id.clone(),
                attached_at_frame: span.start_frame,
                attached_at_ms: span.started_at_ms,
            },
            span.dictation_session_id,
            span.sample_rate,
        )?;
        db.close_aside(&transcript.recording_id, span)?;
    }
    db.set_aside_rows(&transcript.recording_id, &asides)?;
    db.save_meeting_transcript(transcript)?;
    let transcript = db
        .get_transcript(&transcript.recording_id)?
        .ok_or_else(|| anyhow::anyhow!("Missing saved transcript"))?;
    let search_canary_hits = canaries
        .iter()
        .map(|word| {
            db.search_transcripts(word, 100, None).map(|hits| {
                let text = hits
                    .iter()
                    .map(|hit| hit.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let count = crate::meeting_asides::canary_hits(&text, &[*word])
                    .iter()
                    .map(|(_, count)| *count)
                    .sum();
                ((*word).to_string(), count)
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .collect();

    let stored = std::iter::once(transcript.full_text.as_str())
        .chain(transcript.segments.iter().map(|row| row.text.as_str()))
        .chain(
            transcript
                .heard_through_speakers
                .iter()
                .map(|row| row.text.as_str()),
        )
        .collect::<Vec<_>>()
        .join("\n");
    let notes_input = crate::group_transcript_segments_for_analysis(
        &transcript.recording_id,
        &transcript.segments,
    )
    .into_iter()
    .map(|segment| segment.text)
    .collect::<Vec<_>>()
    .join("\n");
    let aside_text = asides
        .iter()
        .flat_map(|aside| aside.rows.iter().map(|row| row.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(AsideEval {
        spans: options.aside_spans.clone(),
        transcript_canary_hits: crate::meeting_asides::canary_hits(&stored, &canaries),
        notes_input_canary_hits: crate::meeting_asides::canary_hits(&notes_input, &canaries),
        search_canary_hits,
        aside_canary_hits: crate::meeting_asides::canary_hits(&aside_text, &canaries),
        asides,
    }))
}

/// The far-side bleed check of a "Me + Them" run, laid out so each
/// microphone word can be traced: every "me" row the recogniser produced is
/// either in `segments_before_cleanup` or in `heard_through_speakers`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAwareEval {
    /// Transcript rows after the bleed check and before meeting cleanup.
    pub segments_before_cleanup: Vec<EvalSegment>,
    /// Rows the product set aside as heard through the speakers.
    pub heard_through_speakers: Vec<EvalSegment>,
    /// Rows the text and timing rules alone would set aside (no acoustic
    /// check), to show what the acoustic check decided.
    pub text_and_timing_matches: Vec<EvalSegment>,
    /// Whether both tracks could be read for the acoustic check.
    pub acoustics_readable: bool,
    /// Whether rerunning the check on the recombined rows with the acoustic
    /// check sets aside exactly the rows the product did.
    pub replay_matches_product: bool,
}

/// Records the chunk boundaries the chunked path reports; drops every other
/// event.
#[derive(Default)]
struct ChunkRecorder {
    chunks: Mutex<Vec<[f64; 2]>>,
}

impl crate::sidecar_handle::AppEmitter for ChunkRecorder {
    fn emit_event<P: Serialize + Clone + Send>(&self, event: &str, payload: P) {
        if event != "recording-transcription-progress" {
            return;
        }
        let Ok(value) = serde_json::to_value(payload) else {
            return;
        };
        if value.get("stage").and_then(|stage| stage.as_str()) != Some("chunk_started") {
            return;
        }
        let start = value.get("startTime").and_then(|v| v.as_f64());
        let end = value.get("endTime").and_then(|v| v.as_f64());
        if let (Some(start), Some(end)) = (start, end) {
            if let Ok(mut chunks) = self.chunks.lock() {
                chunks.push([start, end]);
            }
        }
    }
}

/// Peak resident set size of this process so far, in bytes.
pub fn peak_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage writes a fully initialised struct on success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    // SAFETY: initialised by the successful call above.
    let usage = unsafe { usage.assume_init() };
    // macOS reports bytes, Linux kilobytes.
    if cfg!(target_os = "macos") {
        usage.ru_maxrss as u64
    } else {
        usage.ru_maxrss as u64 * 1024
    }
}

/// Peak physical footprint of this process so far, in bytes: the figure the
/// community-1 admission budget is calibrated against. It counts memory that
/// is not resident (compressed, or mapped by the GPU driver), so on macOS it
/// can exceed [`peak_rss_bytes`]. Falls back to the resident peak elsewhere.
pub fn peak_footprint_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
        // SAFETY: proc_pid_rusage writes a rusage_info_v4 for RUSAGE_INFO_V4
        // into the buffer, which is exactly that size.
        let status = unsafe {
            libc::proc_pid_rusage(
                std::process::id() as libc::c_int,
                libc::RUSAGE_INFO_V4,
                info.as_mut_ptr().cast(),
            )
        };
        if status == 0 {
            // SAFETY: initialised by the successful call above.
            return unsafe { info.assume_init() }.ri_lifetime_max_phys_footprint;
        }
    }
    peak_rss_bytes()
}

/// Re-hash the installed ASR and diarization artifacts in this process so the
/// integrity gates pass, exactly as `asr-eval-batch` does. Nothing is
/// downloaded: a missing artifact is an error naming it, so a run never
/// reaches the network or fills an evaluation profile behind its owner's back.
pub async fn verify_models(options: &MeetingEvalOptions) -> anyhow::Result<()> {
    if options.transcript_from.is_none() {
        verify_asr_model(options).await?;
    }
    if let Some(model_id) = &options.diarization_model_id {
        crate::download::DownloadManager::new()?
            .verify_installed_diarization_model(model_id)
            .await?;
    }
    Ok(())
}

async fn verify_asr_model(options: &MeetingEvalOptions) -> anyhow::Result<()> {
    #[cfg(feature = "asr-transcribe-cpp")]
    let provider: Box<dyn asr::AsrProvider> =
        if options.provider == asr::AsrProviderType::TranscribeCpp {
            Box::new(
                asr::transcribe_cpp::TranscribeCppProvider::for_benchmark(&options.model_id)
                    .map_err(anyhow::Error::msg)?,
            )
        } else {
            asr::AsrProviderFactory::create_with_model(options.provider, Some(&options.model_id))
        };
    #[cfg(not(feature = "asr-transcribe-cpp"))]
    let provider: Box<dyn asr::AsrProvider> =
        asr::AsrProviderFactory::create_with_model(options.provider, Some(&options.model_id));
    // `download_models` only re-hashes files that are all present; with any
    // missing it would fetch them, so stop first.
    if !matches!(provider.download_status(), asr::DownloadStatus::Downloaded) {
        anyhow::bail!(
            "{:?} model {} is not installed in this profile; copy it in (cp -c) rather than downloading",
            options.provider,
            options.model_id
        );
    }
    provider.download_models(Box::new(|_| {})).await
}

fn eval_segments(segments: &[models::TranscriptSegment]) -> Vec<EvalSegment> {
    segments
        .iter()
        .map(|segment| EvalSegment {
            start: segment.start_time,
            end: segment.end_time,
            text: segment.text.clone(),
            speaker: segment.speaker_id.clone(),
        })
        .collect()
}

async fn transcribe(
    options: &MeetingEvalOptions,
) -> anyhow::Result<(MeetingEvalReport, models::Transcript)> {
    let asr_manager = Arc::new(asr::AsrManager::new());
    crate::apply_transcription_settings_to_asr_manager(
        &asr_manager,
        &crate::settings::Settings::default().transcription,
    )
    .await;

    let recorder = ChunkRecorder::default();
    let duration_seconds = hound::WavReader::open(&options.audio)
        .map(|reader| reader.duration() as f64 / reader.spec().sample_rate.max(1) as f64)
        .unwrap_or(0.0);
    let started = Instant::now();
    if let Some((mic, system)) = &options.source_tracks {
        let output = crate::transcribe_meeting_recording(
            &recorder,
            Arc::clone(&asr_manager),
            "meeting-eval",
            &options.audio,
            Some(mic.as_path()),
            Some(system.as_path()),
            options.provider,
            options.model_id.clone(),
            false,
            false,
            &crate::MeetingWaitBudget::new(),
            &options.aside_spans,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let asr_wall_ms = started.elapsed().as_millis() as u64;
        let asides = aside_eval(options, &output.transcript, output.asides)?;
        let mut transcript = output.transcript;
        let source_aware = trace_far_side_bleed(&transcript, mic, system);
        crate::enrich_meeting_transcript(&mut transcript, &[]);
        let report = MeetingEvalReport {
            audio: options.audio.display().to_string(),
            duration_seconds,
            provider: crate::asr_provider_to_settings_value(options.provider).to_string(),
            model_id: options.model_id.clone(),
            asr_mode: "source-aware".to_string(),
            asr_wall_ms,
            asr_peak_rss_bytes: peak_rss_bytes(),
            measured_word_timestamps: transcript.measured_word_timestamps,
            fallback_reason: output.fallback_reason,
            chunks: recorder
                .chunks
                .lock()
                .map(|chunks| chunks.clone())
                .unwrap_or_default(),
            text: transcript.full_text.clone(),
            segments: eval_segments(&transcript.segments),
            diarization_model_id: None,
            diarization_wall_ms: None,
            diarization_peak_rss_bytes: None,
            diarization_peak_footprint_bytes: None,
            diarization_error: None,
            diarization_turns: Vec::new(),
            merged: Vec::new(),
            source_aware: Some(source_aware),
            asides,
        };
        return Ok((report, transcript));
    }
    anyhow::ensure!(
        options.aside_spans.is_empty() || options.asr_mode == MeetingEvalAsrMode::MeetingChunks,
        "asides are silenced chunk by chunk; a whole-file run would send them as they are"
    );
    let result = match options.asr_mode {
        MeetingEvalAsrMode::MeetingChunks => crate::transcribe_single_source_meeting(
            &recorder,
            Arc::clone(&asr_manager),
            "meeting-eval",
            &options.audio,
            options.provider,
            options.model_id.clone(),
            options.diarization_model_id.is_some(),
            false,
            &crate::MeetingWaitBudget::new(),
            &options.aside_spans,
        )
        .await
        .map_err(anyhow::Error::msg)?,
        MeetingEvalAsrMode::WholeFile => {
            asr_manager
                .transcribe_path_for_meeting(
                    options.provider,
                    &options.audio,
                    Some(options.model_id.as_str()),
                )
                .await?
        }
    };
    let asr_wall_ms = started.elapsed().as_millis() as u64;
    let asr_peak_rss_bytes = peak_rss_bytes();
    let fallback_reason = result.fallback_reason.clone();

    let output = crate::single_source_meeting_output(
        &asr_manager,
        "meeting-eval",
        &options.audio,
        &options.aside_spans,
        options.provider,
        &options.model_id,
        result,
    )
    .await;
    let asides = aside_eval(options, &output.transcript, output.asides)?;
    let mut transcript = output.transcript;
    crate::enrich_meeting_transcript(&mut transcript, &[]);
    let report = MeetingEvalReport {
        audio: options.audio.display().to_string(),
        duration_seconds,
        provider: crate::asr_provider_to_settings_value(options.provider).to_string(),
        model_id: options.model_id.clone(),
        asr_mode: match options.asr_mode {
            MeetingEvalAsrMode::MeetingChunks => "meeting-chunks",
            MeetingEvalAsrMode::WholeFile => "whole-file",
        }
        .to_string(),
        asr_wall_ms,
        asr_peak_rss_bytes,
        measured_word_timestamps: transcript.measured_word_timestamps,
        fallback_reason,
        chunks: recorder
            .chunks
            .lock()
            .map(|chunks| chunks.clone())
            .unwrap_or_default(),
        text: transcript.full_text.clone(),
        segments: eval_segments(&transcript.segments),
        diarization_model_id: None,
        diarization_wall_ms: None,
        diarization_peak_rss_bytes: None,
        diarization_peak_footprint_bytes: None,
        diarization_error: None,
        diarization_turns: Vec::new(),
        merged: Vec::new(),
        source_aware: None,
        asides,
    };
    Ok((report, transcript))
}

/// Recombine the kept and set-aside rows of a source-aware transcript, so the
/// bleed check can be traced and replayed outside the product path.
fn trace_far_side_bleed(
    transcript: &models::Transcript,
    mic: &Path,
    system: &Path,
) -> SourceAwareEval {
    let kept = transcript.segments.len();
    let all: Vec<models::TranscriptSegment> = transcript
        .segments
        .iter()
        .chain(&transcript.heard_through_speakers)
        .cloned()
        .collect();
    let rows = |set: &std::collections::HashSet<usize>| {
        let mut picked: Vec<models::TranscriptSegment> =
            set.iter().map(|row| all[*row].clone()).collect();
        picked.sort_by(|left, right| left.start_time.total_cmp(&right.start_time));
        eval_segments(&picked)
    };
    let text_and_timing = crate::meeting_bleed::far_side_bleed_rows(&all, None);
    let acoustics = crate::meeting_bleed::BleedAcoustics::from_wav_files(mic, system);
    let replay = crate::meeting_bleed::far_side_bleed_rows(&all, acoustics.as_ref());
    let product: std::collections::HashSet<usize> = (kept..all.len()).collect();
    SourceAwareEval {
        segments_before_cleanup: eval_segments(&transcript.segments),
        heard_through_speakers: eval_segments(&transcript.heard_through_speakers),
        text_and_timing_matches: rows(&text_and_timing),
        acoustics_readable: acoustics.is_some(),
        replay_matches_product: replay == product,
    }
}

fn reuse_transcript(
    options: &MeetingEvalOptions,
    path: &Path,
) -> anyhow::Result<(MeetingEvalReport, models::Transcript)> {
    let mut report: MeetingEvalReport = serde_json::from_slice(&std::fs::read(path)?)?;
    anyhow::ensure!(
        Path::new(&report.audio) == options.audio,
        "{} was made from {}, not {}",
        path.display(),
        report.audio,
        options.audio.display()
    );
    let transcript = models::Transcript {
        heard_through_speakers: Vec::new(),
        id: "meeting-eval".to_string(),
        recording_id: "meeting-eval".to_string(),
        segments: report
            .segments
            .iter()
            .map(|segment| models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: segment.start,
                end_time: segment.end,
                text: segment.text.clone(),
                speaker_id: None,
                confidence: 0.9,
            })
            .collect(),
        full_text: report.text.clone(),
        language: "en".to_string(),
        confidence: 0.9,
        model: report.model_id.clone(),
        model_id: Some(report.model_id.clone()),
        requested_provider: Some(report.provider.clone()),
        actual_provider: Some(report.provider.clone()),
        measured_word_timestamps: report.measured_word_timestamps,
        created_at: chrono::Utc::now(),
    };
    report.diarization_wall_ms = None;
    report.diarization_peak_rss_bytes = None;
    report.diarization_peak_footprint_bytes = None;
    report.diarization_error = None;
    report.diarization_turns.clear();
    report.merged.clear();
    Ok((report, transcript))
}

/// Rerun the far-side bleed check on the rows of an earlier source-aware
/// report, without the recogniser: the check depends only on those rows and
/// the two tracks, so this reproduces (or, after a change to
/// `meeting_bleed`, re-decides) which rows are set aside.
fn replay_far_side_bleed(
    path: &Path,
    mic: &Path,
    system: &Path,
) -> anyhow::Result<MeetingEvalReport> {
    let mut report: MeetingEvalReport = serde_json::from_slice(&std::fs::read(path)?)?;
    let earlier = report
        .source_aware
        .take()
        .ok_or_else(|| anyhow::anyhow!("{} is not a source-aware report", path.display()))?;
    let rows: Vec<models::TranscriptSegment> = earlier
        .segments_before_cleanup
        .iter()
        .chain(&earlier.heard_through_speakers)
        .map(|segment| models::TranscriptSegment {
            id: uuid::Uuid::new_v4().to_string(),
            start_time: segment.start,
            end_time: segment.end,
            text: segment.text.clone(),
            speaker_id: segment.speaker.clone(),
            confidence: 0.9,
        })
        .collect();
    let mut transcript = models::Transcript {
        heard_through_speakers: Vec::new(),
        id: "meeting-eval".to_string(),
        recording_id: "meeting-eval".to_string(),
        segments: rows,
        full_text: String::new(),
        language: "en".to_string(),
        confidence: 0.9,
        model: report.model_id.clone(),
        model_id: Some(report.model_id.clone()),
        requested_provider: Some(report.provider.clone()),
        actual_provider: Some(report.provider.clone()),
        measured_word_timestamps: report.measured_word_timestamps,
        created_at: chrono::Utc::now(),
    };
    let acoustics = crate::meeting_bleed::BleedAcoustics::from_wav_files(mic, system);
    transcript.heard_through_speakers =
        crate::separate_far_side_bleed(&mut transcript.segments, acoustics.as_ref());
    transcript
        .segments
        .sort_by(|left, right| left.start_time.total_cmp(&right.start_time));
    transcript
        .heard_through_speakers
        .sort_by(|left, right| left.start_time.total_cmp(&right.start_time));
    let source_aware = trace_far_side_bleed(&transcript, mic, system);
    report.segments = source_aware.segments_before_cleanup.clone();
    report.text = transcript
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    report.source_aware = Some(source_aware);
    Ok(report)
}

/// Run one recording through the meeting path and report what came out.
pub async fn run(options: &MeetingEvalOptions) -> anyhow::Result<MeetingEvalReport> {
    if let (Some(path), Some((mic, system))) = (&options.transcript_from, &options.source_tracks) {
        return replay_far_side_bleed(path, mic, system);
    }
    let (mut report, transcript) = match &options.transcript_from {
        Some(path) => reuse_transcript(options, path)?,
        None => transcribe(options).await?,
    };
    report.diarization_model_id = options.diarization_model_id.clone();
    let Some(model_id) = &options.diarization_model_id else {
        return Ok(report);
    };
    let started = Instant::now();
    match diarization::run_diarization_with_model_refined(
        &options.audio,
        model_id,
        options.refinement,
    )
    .await
    {
        Ok(result) => {
            report.diarization_wall_ms = Some(started.elapsed().as_millis() as u64);
            report.diarization_peak_rss_bytes = Some(peak_rss_bytes());
            report.diarization_peak_footprint_bytes = Some(peak_footprint_bytes());
            report.diarization_turns = result
                .segments
                .iter()
                .map(|segment| EvalTurn {
                    start: segment.start_time,
                    end: segment.end_time,
                    speaker: segment.speaker_id.clone(),
                })
                .collect();
            let engine = diarization::DiarizationEngine::new();
            let mut merged = transcript.segments.clone();
            if transcript.measured_word_timestamps {
                engine.merge_with_measured_words(&result, &mut merged);
            } else {
                engine.merge_with_transcript(&result, &mut merged);
            }
            report.merged = eval_segments(&merged);
        }
        Err(error) => {
            report.diarization_wall_ms = Some(started.elapsed().as_millis() as u64);
            report.diarization_error = Some(error.to_string());
        }
    }
    Ok(report)
}

/// Refuse to run against anything but an isolated evaluation profile, since
/// the run downloads and verifies models in that profile; then keep credentials
/// in this process.
pub fn require_isolated_profile() -> anyhow::Result<()> {
    let real_roots = real_profile_roots();
    for variable in ["PLAINSONG_DATA_DIR", "PLAINSONG_CONFIG_DIR"] {
        let Some(value) = std::env::var_os(variable) else {
            anyhow::bail!("{variable} must point at an isolated evaluation profile");
        };
        check_isolated_profile_dir(variable, Path::new(&value), &real_roots)?;
    }
    crate::enable_ephemeral_credentials_for_sidecar();
    Ok(())
}

/// The directories the real application profile lives under, resolved
/// through symlinks so a link into them is caught.
fn real_profile_roots() -> Vec<PathBuf> {
    [dirs::data_dir(), dirs::config_dir()]
        .into_iter()
        .flatten()
        .map(|root| root.canonicalize().unwrap_or(root))
        .collect()
}

/// An evaluation profile directory must already exist, and its resolved path
/// (no `..`, no symlink) must lie outside every real profile root. Comparing
/// the path as typed let `/tmp/x/../../Users/me/Library/Application Support`
/// or a symlink into it through.
fn check_isolated_profile_dir(
    variable: &str,
    path: &Path,
    real_roots: &[PathBuf],
) -> anyhow::Result<()> {
    if !path.is_absolute() {
        anyhow::bail!("{variable} must be absolute");
    }
    let resolved = path.canonicalize().map_err(|error| {
        anyhow::anyhow!(
            "{variable} must name an existing directory ({}: {error})",
            path.display()
        )
    })?;
    if real_roots.iter().any(|real| resolved.starts_with(real)) {
        anyhow::bail!(
            "{variable} resolves to {}, inside the real application data directory",
            resolved.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod isolation_tests {
    use super::*;

    #[test]
    fn a_profile_that_resolves_into_the_real_one_is_refused() {
        let temp = crate::test_fs::TempDir::new("eval-isolation");
        let real = temp.path().join("real");
        let elsewhere = temp.path().join("eval");
        std::fs::create_dir_all(real.join("Plainsong")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let roots = vec![real.canonicalize().unwrap()];

        assert!(check_isolated_profile_dir("X", &elsewhere, &roots).is_ok());
        // `..` that walks into the real directory.
        let dotted = elsewhere.join("..").join("real").join("Plainsong");
        assert!(check_isolated_profile_dir("X", &dotted, &roots).is_err());
        // A symlink into it.
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(real.join("Plainsong"), &link).unwrap();
        assert!(check_isolated_profile_dir("X", &link, &roots).is_err());
        // Relative, or not there at all.
        assert!(check_isolated_profile_dir("X", Path::new("eval"), &roots).is_err());
        assert!(check_isolated_profile_dir("X", &temp.path().join("missing"), &roots).is_err());
    }
}
