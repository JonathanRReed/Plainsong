//! EXPERIMENTAL Nemotron 3 Diarization backend (NVIDIA Sortformer v3).
//!
//! Compiled only with the `diarization-nemotron` Cargo feature, which is off
//! by default and not in the shipped feature list. It is a measurement spike:
//! nothing in the product can select it, and it has no pinned download yet.
//! The eval harness in [`super::eval_tests`] runs it against the same fixture
//! as the ECAPA and speakrs backends. See
//! `docs/typeless-parity-and-model-refresh-2026-09.md` §4.
//!
//! What it does differently from the default pipeline: one ~100M-parameter
//! end-to-end model predicts per-frame activity for up to eight speakers,
//! overlap included. No fixed windows, no embeddings, no clustering threshold.
//! It runs through `parakeet-rs`, which pins the same `ort` and `ndarray`
//! versions this crate already uses, so no second runtime is linked.
//!
//! Output contract is the shared one in [`super::turns`]: `S1..Sn` by first
//! appearance, uncovered audio left unattributed.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use super::turns::{normalize_turns, speakers_for, uncovered_spans, RawTurn, MIN_TURN_SECONDS};
use super::{DiarizationMethod, DiarizationResult, SpeakerSegment};

/// File name of the community ONNX export
/// (`altunenes/parakeet-rs`, `nemotron-3-diarization/nemotron3_diar_v3.onnx`).
/// The `-preview` checkpoint is evaluation-only and must not be used.
pub(crate) const MODEL_FILE_NAME: &str = "nemotron3_diar_v3.onnx";

/// Overrides the model location for the eval harness, so the spike can run
/// before the file has a pinned, receipted download.
pub(crate) const MODEL_PATH_ENV_VAR: &str = "PLAINSONG_NEMOTRON_DIAR_ONNX";

/// Samples per second of the offsets `parakeet-rs` reports.
const SEGMENT_SAMPLE_RATE: f64 = 16_000.0;

pub(crate) fn model_path() -> PathBuf {
    std::env::var_os(MODEL_PATH_ENV_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| super::diarization_models_dir().join(MODEL_FILE_NAME))
}

/// Maps Sortformer's sample-offset segments onto the shared raw-turn shape.
/// Pure so the conversion is testable without ONNX Runtime or a model.
pub(crate) fn raw_turns_from_sample_offsets(
    segments: impl IntoIterator<Item = (u64, u64, usize)>,
) -> Vec<RawTurn> {
    segments
        .into_iter()
        .map(|(start, end, speaker)| RawTurn {
            start: start as f64 / SEGMENT_SAMPLE_RATE,
            end: end as f64 / SEGMENT_SAMPLE_RATE,
            speaker: format!("nemotron-{speaker}"),
        })
        .collect()
}

/// Run Nemotron 3 Diarization over a recording in its offline profile
/// (30.4 s context, NVIDIA's most accurate setting).
pub(crate) async fn run(
    audio_path: &Path,
    duration: f64,
    model_path: PathBuf,
) -> Result<DiarizationResult> {
    if !model_path.is_file() {
        return Err(anyhow::anyhow!(
            "Nemotron 3 Diarization model not found at {}",
            model_path.display()
        ));
    }
    let audio_path = audio_path.to_path_buf();

    // ONNX Runtime inference is blocking CPU work.
    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<SpeakerSegment>> {
        let samples = crate::audio::utils::load_audio_file(&audio_path)
            .context("Failed to load audio for Nemotron diarization")?;
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let mut diarizer = parakeet_rs::sortformer::Sortformer::new(&model_path)
            .map_err(|error| anyhow::anyhow!("Failed to load Nemotron 3 Diarization: {error}"))?;
        let raw = diarizer
            .diarize(samples, 16_000, 1)
            .map_err(|error| anyhow::anyhow!("Nemotron diarization failed: {error}"))?;
        let turns = raw_turns_from_sample_offsets(
            raw.iter()
                .map(|segment| (segment.start, segment.end, segment.speaker_id)),
        );
        Ok(normalize_turns(&turns, duration))
    })
    .await
    .context("Failed to join the Nemotron diarization task")??;

    let gaps = uncovered_spans(&segments, duration, MIN_TURN_SECONDS);
    let unattributed: f64 = gaps.iter().map(|(start, end)| end - start).sum();
    let speakers = speakers_for(&segments);
    tracing::info!(
        "Nemotron diarization complete: {} speakers, {} turns, {:.1}s of {:.1}s unattributed",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_offsets_become_seconds_with_opaque_labels() {
        let turns = raw_turns_from_sample_offsets([(16_000, 48_000, 3), (0, 8_000, 0)]);
        assert_eq!(turns[0].start, 1.0);
        assert_eq!(turns[0].end, 3.0);
        assert_eq!(turns[0].speaker, "nemotron-3");
        assert_eq!(turns[1].end, 0.5);
    }

    #[test]
    fn model_numbering_does_not_leak_into_speaker_ids() {
        // Sortformer's slot 3 speaking first must still be S1.
        let turns = raw_turns_from_sample_offsets([(0, 32_000, 3), (40_000, 80_000, 0)]);
        let segments = normalize_turns(&turns, 10.0);
        assert_eq!(segments[0].speaker_id, "S1");
        assert_eq!(segments[1].speaker_id, "S2");
    }
}
