//! EXPERIMENTAL speakrs diarization backend (pyannote community-1).
//!
//! Compiled only with the `diarization-speakrs` Cargo feature, which is off by
//! default and is not in the shipped feature list
//! (`scripts/sidecar-cargo-features.mjs`). The default embedding + AHC pipeline
//! in [`super`] stays the product default; this module exists so the swap can
//! be measured on real audio rather than argued about.
//!
//! What it does differently: instead of slicing the recording into fixed 2 s
//! windows, embedding each one and clustering the embeddings, speakrs runs the
//! full pyannote `community-1` pipeline — a powerset segmentation model that
//! decodes speaker activity per frame (including overlap), overlap-add
//! aggregation, binarization, WeSpeaker ResNet34 embeddings over the decoded
//! regions, then PLDA + VBx clustering.
//!
//! Output contract, matching [`super::run_diarization_with_model`]: speaker turns with
//! `start_time`/`end_time` and stable `S1..Sn` ids assigned by first
//! appearance. Spans no turn covers are left **uncovered**, which is how the
//! rest of the app already represents "unattributed" — `merge_with_transcript`
//! maps an uncovered span to `speaker_id: None`. Emitting a turn for a gap, or
//! widening a neighbouring turn across it, would attribute silence or unscored
//! audio to a speaker; `S1` in particular is what a naive backend defaults to,
//! and [`normalize_turns`] never does.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use super::turns::{normalize_turns, speakers_for, uncovered_spans, RawTurn, MIN_TURN_SECONDS};
use super::{DiarizationMethod, DiarizationResult, SpeakerSegment};

/// Directory the pinned speakrs model bundle is downloaded to.
fn bundle_dir() -> PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("diarization")
        .join(crate::download::SPEAKRS_BUNDLE_DIR)
}

/// True when every file of the bundle is present *and* carries a Plainsong
/// integrity receipt matching its pinned hash. Bundle-wide, because speakrs
/// builds all three models up front: a bundle missing one PLDA array fails at
/// pipeline construction, after the UI has already promised diarization.
pub(crate) fn is_available() -> bool {
    crate::download::is_speakrs_bundle_trusted(&bundle_dir())
}

/// Run the speakrs pipeline over a recording.
///
/// `ExecutionMode::Cpu` is the only mode wired: the CoreML modes need ~60 more
/// model files (`.mlmodelc` bundles per batch size), each of which would need
/// its own pinned hash and integrity receipt, and the `coreml` Cargo feature
/// on top. See the spike receipt before adding them.
pub(crate) async fn run(audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
    if !is_available() {
        return Err(anyhow::anyhow!(
            "The experimental pyannote community-1 (speakrs) model bundle has not passed Plainsong integrity verification. Download it again from Settings."
        ));
    }

    let audio_path = audio_path.to_path_buf();
    let models_dir = bundle_dir();

    // ONNX Runtime inference and BLAS clustering are blocking CPU work; the
    // whole pipeline is synchronous inside speakrs.
    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<SpeakerSegment>> {
        let samples = crate::audio::utils::load_audio_file(&audio_path)
            .context("Failed to load audio for speakrs diarization")?;
        if samples.is_empty() {
            return Ok(Vec::new());
        }

        let mut pipeline =
            speakrs::OwnedDiarizationPipeline::from_dir(&models_dir, speakrs::ExecutionMode::Cpu)
                .map_err(|error| anyhow::anyhow!("Failed to load the speakrs pipeline: {error}"))?;

        let result = pipeline
            .run(&samples)
            .map_err(|error| anyhow::anyhow!("speakrs diarization failed: {error}"))?;

        let turns: Vec<RawTurn> = result
            .segments
            .iter()
            .map(|segment| RawTurn {
                start: segment.start,
                end: segment.end,
                speaker: segment.speaker.clone(),
            })
            .collect();

        Ok(normalize_turns(&turns, duration))
    })
    .await
    .context("Failed to join the speakrs diarization task")??;

    let gaps = uncovered_spans(&segments, duration, MIN_TURN_SECONDS);
    let unattributed: f64 = gaps.iter().map(|(start, end)| end - start).sum();
    let speakers = speakers_for(&segments);
    tracing::info!(
        "speakrs diarization complete: {} speakers, {} turns, {:.1}s of {:.1}s unattributed",
        speakers.len(),
        segments.len(),
        unattributed,
        duration
    );

    Ok(DiarizationResult {
        segments,
        speakers,
        duration,
        method: DiarizationMethod::Model,
        cluster_centroids: std::collections::HashMap::new(),
    })
}
