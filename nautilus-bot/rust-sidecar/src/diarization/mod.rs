//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// The ONNX embedding + clustering backend. Gated because it is the only part
/// of this module that needs `ndarray` and `ort`, both of which are optional
/// dependencies pulled in by the `diarization` feature; the module's types,
/// readiness rules and transcript merge are feature-independent and stay
/// compiled in so every call site keeps one shape. Same pattern as
/// `asr::whisper` / `asr::whisper_stub`.
#[cfg(feature = "diarization")]
mod embedder;
#[cfg(all(test, target_os = "macos", feature = "diarization"))]
#[path = "../asr/speech_survey.rs"]
mod speech_survey;
pub mod voiceprints;
mod word_activity;
pub use word_activity::SpeakerActivity;
mod word_owner;

/// pyannote community-1, ported to Rust on ONNX Runtime.
#[cfg(feature = "diarization")]
pub(crate) mod community1;

/// Optional experimental Nemotron 3 Diarization backend.
#[cfg(feature = "diarization-nemotron")]
mod nemotron_backend;

/// Turn normalization shared by the end-to-end backends above.
#[cfg(any(test, feature = "diarization"))]
mod turns;

/// Per-model ONNX session policy and input-length guard for the embedders.
/// See `artifacts/qa/campplus-divergence-2026-09-02.md`.
#[cfg(feature = "diarization")]
mod embedding_window;

/// Where the embedding windows are cut. See
/// `artifacts/qa/diarization-segmentation-2026-09-02.md`.
pub mod segmentation;

/// Test-only reproduction of the CAM++ Rust-vs-Python ONNX Runtime divergence.
/// See `artifacts/qa/campplus-divergence-2026-09-02.md`.
#[cfg(all(test, feature = "diarization"))]
mod ort_parity;

/// Test-only: Silero VAD and ECAPA-TDNN on the ONNX Runtime build with and
/// without the Core ML execution provider linked.
#[cfg(all(test, feature = "diarization"))]
mod ort_build_equivalence;

#[cfg(feature = "diarization")]
pub use embedder::{
    generate_segments, EmbeddingClusterer, MIN_SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS,
    SEGMENT_SECONDS,
};

#[cfg(feature = "diarization")]
use ndarray::Array1;

/// A speaker segment with timing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub speaker_id: String,
    pub confidence: f64,
}

/// Speaker information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub name: Option<String>,
    pub color: String,
    pub sample_count: usize,
}

/// Diarization result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationResult {
    pub segments: Vec<SpeakerSegment>,
    pub speakers: Vec<Speaker>,
    pub duration: f64,
    pub method: DiarizationMethod,
    /// One unit-length voice signature per speaker cluster, keyed by the same
    /// `speaker_id` the segments carry.
    ///
    /// `#[serde(skip)]` on purpose: this is the only place the embeddings the
    /// pipeline computes survive at all, and it must not travel to the
    /// renderer, an export, or an RPC reply. The caller either hands it to the
    /// voiceprint store (when the user turned remembering on) or drops it when
    /// the result goes out of scope.
    #[serde(skip)]
    pub cluster_centroids: HashMap<String, Vec<f32>>,
    /// Raw activity never leaves the local in-memory diarization pass.
    #[serde(skip)]
    pub word_activity: Option<SpeakerActivity>,
}

/// Diarization method used
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationMethod {
    Embedding,
    Model,
    /// The speaker turns came back with the transcript from a cloud ASR
    /// provider that diarizes; no local embedding model ran.
    Provider,
}

/// How the embedding windows are cut.
///
/// A field rather than a constant so the evaluation harness can run the same
/// pipeline both ways in one process and compare, instead of the product
/// reading an environment variable it has no business reading. The window
/// length is **not** part of this choice -- see `segmentation`'s module docs
/// for why it cannot be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SegmentationMode {
    /// A window every `SEGMENT_OVERLAP_SECONDS` from 0 to the end of the
    /// recording, whatever is in it. The shipped rule, and the one every
    /// voiceprint threshold was calibrated at.
    FixedGrid,
    /// Windows cut inside Silero's speech regions, starting at each onset and
    /// hopping by `hop_seconds`. Falls back to `FixedGrid` when the VAD model
    /// is not downloaded or will not load.
    ///
    /// **Measured, and still not shipped.** Lane C8 found it cut frame error
    /// from 15.5% to 5.5% on a 5-minute two-speaker fixture with 0.8 s gaps
    /// and produced *no speakers at all* on the same fixture with 3-second
    /// turns, because `smooth_segments` deleted every run: VAD-aligned runs
    /// are bounded by their speech region, and the region was under the
    /// then-5-second floor.
    ///
    /// That floor is now 3.0 s (`embedder::MIN_TURN_SECONDS`), and
    /// re-measuring the whole 24-fixture sweep puts VAD alignment ahead:
    /// better on 21 of 48 runs, identical on 22, worse on 5 — four of which are
    /// 2-second-turn fixtures whose speech regions cannot clear any useful
    /// floor. Runs that find no speakers at all fell from 16 of 48 to 4.
    /// Adopting it is still a separate decision with its own receipt, because
    /// it changes where windows are cut and so what the calibrated voiceprint
    /// thresholds describe; until someone makes it, `DEFAULT_SEGMENTATION`
    /// stays `FixedGrid` and this variant is constructed only by the eval
    /// harness. Numbers:
    /// `artifacts/qa/diarization-segmentation-2026-09-02.md` and
    /// `artifacts/qa/diarization-turn-floor-2026-09-03.md`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "measured alternative segmentation, kept so the receipts' numbers stay reproducible; adoption is its own decision because it moves the embedding windows, see artifacts/qa/diarization-turn-floor-2026-09-03.md"
        )
    )]
    VadAligned { hop_seconds: f64 },
}

/// The segmentation the product runs.
///
/// Set from the measurement in
/// `artifacts/qa/diarization-segmentation-2026-09-02.md`, not from
/// preference: the adoption rule for that lane was that VAD alignment had to
/// improve frame error *without* moving the calibrated voiceprint thresholds
/// by more than 0.02. It failed the first half then because of the turn floor;
/// with the floor corrected it passes, and the second half has not been
/// re-checked. See `artifacts/qa/diarization-turn-floor-2026-09-03.md`.
pub const DEFAULT_SEGMENTATION: SegmentationMode = SegmentationMode::FixedGrid;

/// A refinement to the embedding pipeline's clustering, measured on real
/// meetings (`artifacts/continuation-2026-10-20/opus-meeting/scores/`). It
/// does not move a window or change what an embedding is, so the voiceprint
/// thresholds still describe every window that is embedded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClusterRefinement {
    /// Fold clusters holding less than this share of the embedded windows
    /// into the nearest larger one.
    pub minor_cluster_share: Option<f64>,
    /// ...but never call a cluster of this many windows or more small,
    /// however long the meeting.
    pub minor_cluster_max_windows: usize,
    /// ...and fold one of `minor_cluster_min_voice_windows` or more only
    /// when its centroid is within this cosine distance of an established
    /// voice. `None` folds every small cluster.
    pub minor_cluster_fold_distance: Option<f32>,
    /// Smaller clusters than this are folded whatever their distance.
    pub minor_cluster_min_voice_windows: usize,
}

#[cfg(test)]
mod refinement_default_tests {
    #[test]
    fn the_product_folds_clusters_under_one_percent_of_windows() {
        assert_eq!(
            super::DEFAULT_CLUSTER_REFINEMENT.minor_cluster_share,
            Some(0.01)
        );
    }

    #[test]
    fn the_product_keeps_a_distinct_voice_of_ten_windows_or_three_far_ones() {
        let refinement = super::DEFAULT_CLUSTER_REFINEMENT;
        assert_eq!(refinement.minor_cluster_max_windows, 10);
        assert_eq!(refinement.minor_cluster_min_voice_windows, 3);
        assert_eq!(refinement.minor_cluster_fold_distance, Some(0.70));
    }
}

/// The refinement the product runs: clusters under 1% of the embedded
/// windows join the nearest larger one.
///
/// Measured on five AMI meetings (14-39 min, four people), headset mix and
/// one far-field microphone, with GGUF Parakeet word timings: the shipped
/// clusterer reported 60-283 speakers per meeting; folding at 1% leaves 3-6.
/// The share of transcript words carrying the right speaker rose from 77.8%
/// to 89.0% (headset) and 51.1% to 85.8% (far field), cpWER fell from 52.6%
/// to 34.2% and 92.5% to 41.4%, and words left without a speaker fell from
/// 9.7% to 6.4% and 18.9% to 7.4%. 2% was no better and 5% started merging
/// real people. On the synthetic two- and three-speaker fixtures confusion
/// stays at zero; the cost is windows of silence that the turn floor used to
/// drop now carrying a label (mean false alarm 25.8% to 29.1%), which no
/// transcript word sits in. Per-meeting scores:
/// `artifacts/continuation-2026-10-20/opus-meeting/scores/` (`da.*` shipped,
/// `dabs1.*` 1%, `dabs.*` 2%, `dabs5.*` 5%, `syn_*` synthetic).
///
/// The share alone also folded a real brief speaker: in a 75-minute meeting
/// 1% is about 45 windows, so a guest's 10-second sentence (9 windows,
/// 0.75 from every other voice) became one of the hosts. Two limits keep such
/// a voice. A cluster of 10 windows or more is never small, and a small one of
/// 3 windows or more folds only when its centroid is within 0.70 of an
/// established voice; one or two windows always fold, because a fifth of that
/// tail sits further than 0.70 from everyone and sparing it brought back the
/// dozens of speakers. With both limits the inserted 10- and 15-second guests
/// (`derived/GUEST10`, `GUEST15`) keep their own label on every word, and the
/// AMI means barely move: right speaker 89.0 -> 89.1% (headset) and 85.8 ->
/// 85.7% (far field), cpWER 34.2 -> 34.3% and 41.4 -> 41.5%, speakers found
/// 3-6 as before (`p12new.*` against `dfinal.*`).
pub const DEFAULT_CLUSTER_REFINEMENT: ClusterRefinement = ClusterRefinement {
    minor_cluster_share: Some(0.01),
    minor_cluster_max_windows: 10,
    minor_cluster_fold_distance: Some(0.70),
    minor_cluster_min_voice_windows: 3,
};

/// Speaker diarization engine
pub struct DiarizationEngine {
    speakers: HashMap<String, Speaker>,
    model_id: String,
    segmentation: SegmentationMode,
    refinement: ClusterRefinement,
}

impl DiarizationEngine {
    pub fn new() -> Self {
        Self::with_model("ecapa_tdnn_speaker")
    }

    /// Create an engine that uses a specific diarization model.
    pub fn with_model(model_id: &str) -> Self {
        Self {
            speakers: HashMap::new(),
            model_id: model_id.to_string(),
            segmentation: DEFAULT_SEGMENTATION,
            refinement: DEFAULT_CLUSTER_REFINEMENT,
        }
    }

    /// Override the cluster refinements. The meeting evaluation harness uses
    /// this to compare them on the same audio; the product takes
    /// [`DEFAULT_CLUSTER_REFINEMENT`].
    pub fn with_refinement(mut self, refinement: ClusterRefinement) -> Self {
        self.refinement = refinement;
        self
    }

    /// Override how windows are cut. Only the evaluation harness uses this;
    /// the product takes [`DEFAULT_SEGMENTATION`].
    #[cfg(test)]
    pub(crate) fn with_segmentation(mut self, segmentation: SegmentationMode) -> Self {
        self.segmentation = segmentation;
        self
    }

    /// Run diarization on audio file
    pub async fn diarize(&mut self, audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
        tracing::info!("Running speaker diarization for {:.1}s audio", duration);
        self.diarize_real(audio_path, duration).await
    }

    /// Without the `diarization` feature there is no ONNX runtime to embed with
    /// and no clusterer compiled in. Say that, rather than running an empty
    /// pipeline to the same conclusion by a longer route.
    #[cfg(not(feature = "diarization"))]
    async fn diarize_real(
        &mut self,
        _audio_path: &Path,
        _duration: f64,
    ) -> Result<DiarizationResult> {
        Err(anyhow::anyhow!(
            "Speaker diarization is not compiled into this build (the `diarization` feature is off)."
        ))
    }

    /// Real diarization using speaker embeddings and clustering
    #[cfg(feature = "diarization")]
    async fn diarize_real(
        &mut self,
        audio_path: &Path,
        duration: f64,
    ) -> Result<DiarizationResult> {
        let segments = self.segments_for(audio_path, duration);
        if segments.is_empty() {
            return Ok(DiarizationResult {
                segments: Vec::new(),
                speakers: Vec::new(),
                duration,
                method: DiarizationMethod::Embedding,
                cluster_centroids: HashMap::new(),
                word_activity: None,
            });
        }

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(&self.model_id)
            .context("Failed to create embedding extractor")?;

        let embeddings: Vec<(f64, f64, Array1<f32>)> =
            extractor.extract_embeddings(audio_path, &segments).await?;

        if embeddings.is_empty() {
            return Err(anyhow::anyhow!(
                "No usable speech embeddings; cannot infer speakers."
            ));
        }

        let segments_for_clustering: Vec<(f64, f64)> = embeddings
            .iter()
            .map(|(start_time, end_time, _)| (*start_time, *end_time))
            .collect();
        // The per-segment embeddings die with this closure. Only the per
        // cluster mean survives, and only in memory: whether any of it is
        // written down is the caller's decision, gated on the opt-in setting.
        let refinement = self.refinement;
        let (smoothed, label_centroids) = tokio::task::spawn_blocking(move || {
            let clusterer = EmbeddingClusterer::new();
            let mut labels = clusterer.cluster(&embeddings);
            let mut moved = vec![false; labels.len()];
            if let Some(share) = refinement.minor_cluster_share {
                (labels, moved) = clusterer.absorb_minor_clusters(
                    &embeddings,
                    &labels,
                    embedder::MinorClusterFold {
                        min_share: share,
                        max_windows: refinement.minor_cluster_max_windows,
                        max_distance: refinement.minor_cluster_fold_distance,
                        min_voice_windows: refinement.minor_cluster_min_voice_windows,
                    },
                );
            }
            // A voiceprint describes a voice by the windows that clustered
            // with it on their own; windows folded in from a minor cluster
            // carry a speaker label but stay out of its centroid.
            let mut grouped: HashMap<usize, Vec<Vec<f32>>> = HashMap::new();
            for ((label, (_, _, embedding)), moved) in
                labels.iter().zip(embeddings.iter()).zip(moved.iter())
            {
                if *moved {
                    continue;
                }
                grouped
                    .entry(*label)
                    .or_default()
                    .push(embedding.iter().copied().collect());
            }
            let centroids: HashMap<usize, Vec<f32>> = grouped
                .into_iter()
                .filter_map(|(label, samples)| {
                    voiceprints::centroid_of(&samples).map(|centroid| (label, centroid))
                })
                .collect();
            let smoothed = clusterer.smooth_segments(&segments_for_clustering, &labels);
            (smoothed, centroids)
        })
        .await
        .context("Failed to join diarization clustering task")?;

        let mut cluster_centroids: HashMap<String, Vec<f32>> = HashMap::new();
        let mut speaker_segments = Vec::new();
        for (start, end, label) in smoothed {
            let speaker_id = format!("S{}", label + 1);
            if !self.speakers.contains_key(&speaker_id) {
                self.speakers
                    .insert(speaker_id.clone(), self.create_speaker(&speaker_id, label));
            }
            if let Some(centroid) = label_centroids.get(&label) {
                cluster_centroids
                    .entry(speaker_id.clone())
                    .or_insert_with(|| centroid.clone());
            }

            speaker_segments.push(SpeakerSegment {
                start_time: start,
                end_time: end,
                speaker_id: speaker_id.clone(),
                confidence: 0.90,
            });
        }

        let mut speakers: Vec<Speaker> = Vec::new();
        for segment in &speaker_segments {
            if speakers
                .iter()
                .any(|speaker| speaker.id == segment.speaker_id)
            {
                continue;
            }
            if let Some(speaker) = self.speakers.get(&segment.speaker_id) {
                speakers.push(speaker.clone());
            }
        }

        tracing::info!(
            "Diarization complete: {} speakers, {} segments",
            speakers.len(),
            speaker_segments.len()
        );

        Ok(DiarizationResult {
            segments: speaker_segments,
            speakers,
            duration,
            method: DiarizationMethod::Embedding,
            cluster_centroids,
            word_activity: None,
        })
    }

    /// The embedding windows for one recording, under this engine's
    /// [`SegmentationMode`].
    ///
    /// VAD alignment degrades to the fixed grid rather than failing: the
    /// Silero model is an optional download, and a meeting must not stop
    /// because an accuracy refinement's prerequisite is missing. It also
    /// degrades when the VAD found no speech at all, because "embed nothing"
    /// is a worse answer than "embed the metronome" for a recording the user
    /// can plainly hear.
    #[cfg(feature = "diarization")]
    fn segments_for(&self, audio_path: &Path, duration: f64) -> Vec<(f64, f64)> {
        let fixed = || generate_segments(duration, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS);
        let SegmentationMode::VadAligned { hop_seconds } = self.segmentation else {
            return fixed();
        };

        let Ok(manager) = crate::download::DownloadManager::new() else {
            return fixed();
        };
        let Some(regions) =
            segmentation::speech_regions_for_file(audio_path, &manager.silero_vad_model_path())
        else {
            return fixed();
        };
        let segments = segmentation::generate_vad_aligned_segments(
            &regions,
            SEGMENT_SECONDS,
            hop_seconds,
            MIN_SEGMENT_SECONDS,
        );
        if segments.is_empty() {
            tracing::warn!(
                "Diarization: Silero found no speech in {:.1}s of audio; falling back to the \
                 fixed-window segmentation rather than returning no speakers",
                duration
            );
            return fixed();
        }
        tracing::info!(
            "Diarization: {} VAD-aligned windows over {} speech regions ({:.1}s of {:.1}s), \
             against {} on the fixed grid",
            segments.len(),
            regions.len(),
            segmentation::covered_seconds(&segments),
            duration,
            fixed().len(),
        );
        segments
    }

    /// Merge diarization results with transcript segments.
    /// Splits multi-word segments at diarization boundaries while keeping any
    /// uncovered speech explicitly anonymous (`speaker_id: None`). A
    /// single-word row keeps its text and interval and gets the speaker that
    /// owns its midpoint (`word_owner::owner_at`).
    pub fn merge_with_transcript(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
    ) {
        self.merge_internal(diarization, transcript_segments, false);
    }

    /// As [`Self::merge_with_transcript`], and a measured word whose midpoint
    /// falls between turns may take its speaker from the turns or activity
    /// evidence around it (`word_owner::uncovered_word_speaker`).
    pub fn merge_with_measured_words(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
    ) {
        self.merge_internal(diarization, transcript_segments, true);
    }

    fn merge_internal(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
        measured_words: bool,
    ) {
        tracing::debug!(
            "Merging {} diarization segments with {} transcript segments",
            diarization.segments.len(),
            transcript_segments.len()
        );

        if transcript_segments.is_empty() {
            return;
        }

        let mut sorted_diarization = diarization.segments.clone();
        sorted_diarization.retain(|segment| {
            segment.start_time.is_finite()
                && segment.end_time.is_finite()
                && segment.end_time > segment.start_time
        });
        sorted_diarization.sort_by(|left, right| {
            left.start_time
                .total_cmp(&right.start_time)
                .then_with(|| left.end_time.total_cmp(&right.end_time))
                .then_with(|| left.speaker_id.cmp(&right.speaker_id))
        });

        let mut new_segments: Vec<crate::models::TranscriptSegment> = Vec::new();
        for transcript_segment in transcript_segments.iter() {
            let words: Vec<&str> = transcript_segment.text.split_whitespace().collect();
            let total_duration = transcript_segment.end_time - transcript_segment.start_time;
            if words.is_empty() || !total_duration.is_finite() || total_duration <= 0.0 {
                let mut preserved = transcript_segment.clone();
                preserved.speaker_id = None;
                new_segments.push(preserved);
                continue;
            }

            // A single aligned word is already an atomic timed row. Speaker
            // boundaries must not replace its source identity or measured
            // interval; only its speaker is decided, by `word_owner`.
            if words.len() == 1 {
                let midpoint = transcript_segment.start_time + total_duration / 2.0;
                let covered = sorted_diarization
                    .iter()
                    .any(|segment| segment.start_time <= midpoint && midpoint < segment.end_time);
                let speaker = if covered || !measured_words {
                    word_owner::owner_at(&sorted_diarization, midpoint)
                } else {
                    word_owner::uncovered_word_speaker(
                        &sorted_diarization,
                        diarization.word_activity.as_ref(),
                        transcript_segment.start_time,
                        transcript_segment.end_time,
                    )
                };
                let mut preserved = transcript_segment.clone();
                preserved.speaker_id = speaker.map(str::to_owned);
                new_segments.push(preserved);
                continue;
            }

            let mut boundaries = vec![transcript_segment.start_time, transcript_segment.end_time];
            for diarization_segment in &sorted_diarization {
                if diarization_segment.start_time < transcript_segment.end_time
                    && diarization_segment.end_time > transcript_segment.start_time
                {
                    boundaries.push(
                        diarization_segment
                            .start_time
                            .max(transcript_segment.start_time),
                    );
                    boundaries.push(
                        diarization_segment
                            .end_time
                            .min(transcript_segment.end_time),
                    );
                }
            }
            boundaries.sort_by(f64::total_cmp);
            boundaries.dedup_by(|left, right| (*left - *right).abs() < 0.001);

            let total_words = words.len();
            for window in boundaries.windows(2) {
                let segment_start = window[0];
                let segment_end = window[1];
                if segment_end <= segment_start {
                    continue;
                }

                let word_start = ((segment_start - transcript_segment.start_time) / total_duration
                    * total_words as f64)
                    .round() as usize;
                let word_end = ((segment_end - transcript_segment.start_time) / total_duration
                    * total_words as f64)
                    .round() as usize;
                let word_start = word_start.min(total_words);
                let word_end = word_end.min(total_words);
                if word_start >= word_end {
                    continue;
                }

                let mut speaker_id = None;
                let mut best_overlap = 0.0f64;
                for diarization_segment in &sorted_diarization {
                    let overlap = segment_end.min(diarization_segment.end_time)
                        - segment_start.max(diarization_segment.start_time);
                    if overlap > best_overlap {
                        best_overlap = overlap;
                        speaker_id = Some(diarization_segment.speaker_id.clone());
                    }
                }

                let sub_text = words[word_start..word_end].join(" ");
                let id = if boundaries.len() == 2 {
                    transcript_segment.id.clone()
                } else {
                    uuid::Uuid::new_v4().to_string()
                };
                new_segments.push(crate::models::TranscriptSegment {
                    id,
                    start_time: segment_start,
                    end_time: segment_end,
                    text: sub_text,
                    speaker_id,
                    confidence: transcript_segment.confidence,
                });
            }
        }

        *transcript_segments = new_segments;
        tracing::debug!(
            "Merge complete: {} segments after splitting",
            transcript_segments.len()
        );
    }

    fn create_speaker(&self, id: &str, index: usize) -> Speaker {
        speaker_for_index(id, index)
    }
}

/// The default record for the Nth distinct speaker found in a recording.
///
/// Shared rather than duplicated so a transcript whose speakers came from a
/// cloud provider and one whose speakers came from Plainsong's own embedding
/// pipeline are named and coloured identically -- the reader should not be
/// able to tell which diarizer ran from the way the badges look, only from the
/// line that says so.
pub fn speaker_for_index(id: &str, index: usize) -> Speaker {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899",
    ];
    Speaker {
        id: id.to_string(),
        name: Some(format!("Speaker {}", index + 1)),
        color: COLORS[index % COLORS.len()].to_string(),
        sample_count: 0,
    }
}

impl Default for DiarizationEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// The embedding model every install starts on and every fallback lands on.
pub const DEFAULT_EMBEDDING_MODEL_ID: &str = "ecapa_tdnn_speaker";

/// ERes2NetV2 is turned off while its license is unresolved: the mirror its
/// file is pinned to declares none (`scripts/model-weights-manifest.mjs`). It
/// is not offered, downloaded or run, even when an earlier download is still
/// on disk; Settings > Meetings > Speaker model offers to remove that file.
pub(crate) const LICENSE_BLOCKED_SPEAKER_MODEL_ID: &str = "eres2netv2_speaker";

/// Label for a diarization model, as the picker names it.
///
/// One table so the picker, the readiness probe and the fallback notice cannot
/// name the same model three different ways. An id this build does not know is
/// returned as-is rather than given an invented name.
pub fn model_label(model_id: &str) -> &str {
    match model_id {
        crate::download::COMMUNITY1_MODEL_ID => "pyannote community-1",
        crate::download::NEMOTRON_DIARIZATION_MODEL_ID => "Nemotron 3 Diarization (experimental)",
        "ecapa_tdnn_speaker" => "ECAPA-TDNN 512",
        "resnet34_speaker" => "ResNet34",
        "campplus_speaker" => "CAM++",
        "eres2netv2_speaker" => "ERes2NetV2",
        other => other,
    }
}

/// The `.onnx` artifact an embedding-model id actually loads.
///
/// Unknown ids resolve to [`DEFAULT_EMBEDDING_MODEL_ID`], which is what
/// [`embedder::SpeakerEmbeddingExtractor::with_model`] has always done with a
/// filename it does not recognise. Readiness has to agree with the file the run
/// will open, or the picker promises a model the run cannot load.
pub fn embedding_model_artifact_id(model_id: &str) -> &'static str {
    match model_id {
        "resnet34_speaker" => "resnet34_speaker",
        "campplus_speaker" => "campplus_speaker",
        "eres2netv2_speaker" => "eres2netv2_speaker",
        _ => DEFAULT_EMBEDDING_MODEL_ID,
    }
}

/// Directory the single-file embedding models are downloaded to.
pub(crate) fn diarization_models_dir() -> std::path::PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("diarization")
}

/// Readiness of one embedding model inside an explicit directory.
///
/// Takes the directory so the rule is testable against a fixture instead of the
/// user's own data directory.
pub(crate) fn is_embedding_model_available_in(models_dir: &Path, model_id: &str) -> bool {
    if model_id == LICENSE_BLOCKED_SPEAKER_MODEL_ID {
        return false;
    }
    let artifact_id = embedding_model_artifact_id(model_id);
    crate::download::is_diarization_model_artifact_installed(
        artifact_id,
        &models_dir.join(format!("{artifact_id}.onnx")),
    )
}

/// Whether the diarization model the user selected can actually run right now.
///
/// Per-model because the backends have different readiness conditions: the
/// embedding backend needs one verified `.onnx`, pyannote community-1 needs
/// its six-file bundle. Callers that gate an automatic pass on
/// "is diarization available" must ask about the model they are about to run,
/// not about the default one -- this used to probe ECAPA-TDNN whatever the
/// argument said, so a user who picked CAM++ without downloading it passed the
/// gate and then lost speaker labels on every meeting.
pub fn is_model_available(model_id: &str) -> bool {
    if model_id == crate::download::NEMOTRON_DIARIZATION_MODEL_ID {
        #[cfg(feature = "diarization-nemotron")]
        return nemotron_backend::is_available();
        #[cfg(not(feature = "diarization-nemotron"))]
        return false;
    }
    if model_id == crate::download::COMMUNITY1_MODEL_ID {
        #[cfg(feature = "diarization")]
        return community1::is_available();
        #[cfg(not(feature = "diarization"))]
        return false;
    }
    // `cfg!` rather than `#[cfg]`: a build without the feature has no ONNX
    // runtime and no clusterer compiled in, so nothing it finds on disk can
    // actually run and readiness has to be false -- but the rule itself stays
    // compiled either way, so there is one function to test instead of two.
    cfg!(feature = "diarization")
        && is_embedding_model_available_in(&diarization_models_dir(), model_id)
}

/// The model a run will actually use, and what to tell the user when that is
/// not the one they picked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDiarizationModel {
    /// The id to hand to [`run_diarization_with_model`].
    pub model_id: String,
    /// Copy for the meeting when the picked model was not on disk and another
    /// downloaded one ran in its place. `None` when the picked model ran.
    pub fallback_notice: Option<String>,
}

/// Where the user downloads or changes the speaker model, named the way the
/// Settings window labels it.
pub const SPEAKER_MODEL_SETTINGS_PATH: &str = "Settings > Meetings > Speaker model";

/// The order in which already-downloaded models stand in for a picked one
/// that is not on disk: community-1 first, then the long-standing default,
/// then the other embedders, and the experimental Nemotron last because it
/// computes no voice signatures. Nothing in this list is ever downloaded to
/// fill the gap -- a meeting reaches the network only when the user asks.
const FALLBACK_ORDER: [&str; 5] = [
    crate::download::COMMUNITY1_MODEL_ID,
    DEFAULT_EMBEDDING_MODEL_ID,
    "resnet34_speaker",
    "campplus_speaker",
    crate::download::NEMOTRON_DIARIZATION_MODEL_ID,
];

/// The download size of a speaker model, as Finder would show it (decimal
/// MB), for the buttons that offer the download. `None` for an id this build
/// does not offer.
pub fn model_download_size(model_id: &str) -> Option<&'static str> {
    match model_id {
        // Six pinned release files total 32,753,512 bytes (decimal MB).
        // See docs/evals/beta7-evidence.md for the staged-file calculation.
        crate::download::COMMUNITY1_MODEL_ID => Some("33 MB"),
        crate::download::NEMOTRON_DIARIZATION_MODEL_ID => Some("400 MB"),
        "ecapa_tdnn_speaker" => Some("25 MB"),
        "resnet34_speaker" => Some("30 MB"),
        "campplus_speaker" => Some("29 MB"),
        _ => None,
    }
}

/// Copy for the case where the picked model is not downloaded and another
/// downloaded one ran instead: one sentence for what happened, one for what
/// to do. A meeting says "the speaker model", as its download button does;
/// the models' own names belong to the Settings picker, and the meeting
/// records which one ran (`plainsong:<id>`).
pub fn model_fallback_notice(requested_id: &str) -> String {
    if requested_id == LICENSE_BLOCKED_SPEAKER_MODEL_ID {
        format!(
            "ERes2NetV2 is turned off while its license is unresolved, so this meeting used another speaker model on this Mac. Choose one in {}.",
            SPEAKER_MODEL_SETTINGS_PATH
        )
    } else if known_diarization_model_id(requested_id) {
        format!(
            "The speaker model you chose isn't downloaded, so this meeting used another one on this Mac. Download it in {}.",
            SPEAKER_MODEL_SETTINGS_PATH
        )
    } else {
        format!(
            "The speaker model you chose isn't part of this version of Plainsong, so this meeting used another one on this Mac. Choose a speaker model in {}.",
            SPEAKER_MODEL_SETTINGS_PATH
        )
    }
}

/// Copy for a meeting saved without speaker labels because no speaker model
/// is on this Mac at all. The meeting itself offers the download.
pub fn no_speaker_model_notice(requested_id: &str) -> String {
    let offered = if known_diarization_model_id(requested_id) {
        requested_id
    } else {
        DEFAULT_EMBEDDING_MODEL_ID
    };
    let size = model_download_size(offered)
        .map(|size| format!(" ({size})"))
        .unwrap_or_default();
    format!(
        "No speaker model is downloaded, so this meeting was saved without speaker labels. Open the meeting to download the speaker model{size}, then label the speakers."
    )
}

/// Pick the model a run should use given what is on disk. Never downloads.
///
/// `None` means nothing can run: neither the picked model nor any other
/// speaker model is downloaded, so the caller must not claim speaker labels at
/// all. A substitution is always reported -- a silent swap would be a
/// capability claim the user never agreed to.
pub fn resolve_model_for_run(requested_id: &str) -> Option<ResolvedDiarizationModel> {
    resolve_model_for_run_with(requested_id, is_model_available)
}

/// The rule behind [`resolve_model_for_run`], with readiness passed in so the
/// policy is testable without a models directory or ONNX Runtime.
fn resolve_model_for_run_with(
    requested_id: &str,
    is_available: impl Fn(&str) -> bool,
) -> Option<ResolvedDiarizationModel> {
    // Availability follows the artifact the extractor would open, so an
    // unknown id answers for ECAPA-TDNN. Do not let that implementation detail
    // make an unknown selection look as though it ran unchanged: only ids this
    // build actually offers may take the no-substitution branch.
    if known_diarization_model_id(requested_id) && is_available(requested_id) {
        return Some(ResolvedDiarizationModel {
            model_id: requested_id.to_string(),
            fallback_notice: None,
        });
    }
    FALLBACK_ORDER
        .iter()
        .copied()
        .filter(|candidate| *candidate != requested_id)
        .find(|candidate| known_diarization_model_id(candidate) && is_available(candidate))
        .map(|ran| ResolvedDiarizationModel {
            model_id: ran.to_string(),
            fallback_notice: Some(model_fallback_notice(requested_id)),
        })
}

fn known_diarization_model_id(model_id: &str) -> bool {
    if model_id == LICENSE_BLOCKED_SPEAKER_MODEL_ID {
        return false;
    }
    if model_id == crate::download::NEMOTRON_DIARIZATION_MODEL_ID {
        return cfg!(feature = "diarization-nemotron");
    }
    if model_id == crate::download::COMMUNITY1_MODEL_ID {
        return cfg!(feature = "diarization");
    }
    embedding_model_artifact_id(model_id) == model_id
}

/// Run diarization with a specific speaker embedding model.
pub async fn run_diarization_with_model(
    audio_path: &Path,
    model_id: &str,
) -> Result<DiarizationResult> {
    run_diarization_with_model_refined(audio_path, model_id, DEFAULT_CLUSTER_REFINEMENT).await
}

/// [`run_diarization_with_model`] with explicit cluster refinements; they
/// apply to the embedding backends only.
pub async fn run_diarization_with_model_refined(
    audio_path: &Path,
    model_id: &str,
    refinement: ClusterRefinement,
) -> Result<DiarizationResult> {
    if model_id == crate::download::NEMOTRON_DIARIZATION_MODEL_ID {
        #[cfg(feature = "diarization-nemotron")]
        {
            if !nemotron_backend::is_available() {
                return Err(anyhow::anyhow!(
                    "Nemotron diarization is not downloaded and verified."
                ));
            }
            let duration = get_audio_duration(audio_path).await?;
            return nemotron_backend::run(audio_path, duration, nemotron_backend::model_path())
                .await;
        }
        #[cfg(not(feature = "diarization-nemotron"))]
        return Err(anyhow::anyhow!(
            "Nemotron diarization is not compiled into this build."
        ));
    }
    if model_id == crate::download::COMMUNITY1_MODEL_ID {
        #[cfg(feature = "diarization")]
        {
            let duration = get_audio_duration(audio_path).await?;
            return community1::run(audio_path, duration).await;
        }
        #[cfg(not(feature = "diarization"))]
        return Err(anyhow::anyhow!(
            "pyannote community-1 is not compiled into this build."
        ));
    }

    if !is_model_available(model_id) {
        return Err(anyhow::anyhow!(
            "Real diarization model is not available: {} is not downloaded. Install/configure diarization models first.",
            model_label(model_id)
        ));
    }

    let duration = get_audio_duration(audio_path).await?;
    let mut engine = DiarizationEngine::with_model(model_id).with_refinement(refinement);
    engine.diarize(audio_path, duration).await
}

/// Get audio file duration
async fn get_audio_duration(audio_path: &Path) -> Result<f64> {
    let audio_path = audio_path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<f64> {
        let reader = hound::WavReader::open(audio_path)?;
        let duration = reader.duration() as f64 / reader.spec().sample_rate as f64;
        Ok(duration)
    })
    .await
    .context("Failed to join diarization WAV duration task")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "diarization-nemotron")]
    #[test]
    fn ready_nemotron_selection_keeps_its_own_route() {
        let id = crate::download::NEMOTRON_DIARIZATION_MODEL_ID;
        let resolved = resolve_model_for_run_with(id, |candidate| candidate == id)
            .expect("ready selected route");
        assert_eq!(resolved.model_id, id);
        assert_eq!(resolved.fallback_notice, None);
    }
    use std::path::PathBuf;

    /// Install `model_id` into `models_dir` the way a completed download leaves
    /// it: the artifact, remembered as verified against its pinned digest for
    /// this session. The bytes are a stand-in, so nothing hashes megabytes
    /// here.
    async fn install_embedding_model(models_dir: &Path, model_id: &str) {
        let sha256 = crate::download::diarization_model_expected_sha256(model_id)
            .expect("a pinned diarization model");
        let path = models_dir.join(format!("{model_id}.onnx"));
        tokio::fs::create_dir_all(models_dir).await.expect("dir");
        tokio::fs::write(&path, format!("fixture-{model_id}"))
            .await
            .expect("write model");
        crate::download::mark_model_verified_for_tests(&path, sha256)
            .await
            .expect("mark test model verified");
    }

    fn scratch_models_dir(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(name)
            .join(uuid::Uuid::new_v4().to_string())
    }

    /// The regression: readiness used to probe ECAPA-TDNN whatever it was asked
    /// about, so a user who selected CAM++ without downloading it passed the
    /// gate on the automatic pass and then got no speaker labels at all.
    #[tokio::test]
    async fn readiness_answers_about_the_selected_model_not_the_default() {
        let models_dir = scratch_models_dir("plainsong-diarization-readiness");
        tokio::fs::create_dir_all(&models_dir).await.expect("dir");

        for model_id in [
            "ecapa_tdnn_speaker",
            "resnet34_speaker",
            "campplus_speaker",
            "eres2netv2_speaker",
        ] {
            assert!(
                !is_embedding_model_available_in(&models_dir, model_id),
                "{model_id} is not downloaded yet"
            );
        }

        install_embedding_model(&models_dir, "ecapa_tdnn_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "ecapa_tdnn_speaker"
        ));
        for missing in ["resnet34_speaker", "campplus_speaker", "eres2netv2_speaker"] {
            assert!(
                !is_embedding_model_available_in(&models_dir, missing),
                "{missing} must not be reported available because ECAPA-TDNN is"
            );
        }

        install_embedding_model(&models_dir, "campplus_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "campplus_speaker"
        ));
        assert!(!is_embedding_model_available_in(
            &models_dir,
            "resnet34_speaker"
        ));

        tokio::fs::remove_dir_all(&models_dir).await.ok();
    }

    /// An id outside the four is what `SpeakerEmbeddingExtractor::with_model`
    /// loads ECAPA-TDNN for, so readiness has to answer for ECAPA-TDNN too --
    /// otherwise the probe and the run disagree about the same settings value.
    #[tokio::test]
    async fn an_unknown_model_id_reads_the_default_artifact() {
        assert_eq!(
            embedding_model_artifact_id("not_a_real_model"),
            DEFAULT_EMBEDDING_MODEL_ID
        );
        assert_eq!(
            embedding_model_artifact_id("campplus_speaker"),
            "campplus_speaker"
        );

        let models_dir = scratch_models_dir("plainsong-diarization-unknown-id");
        tokio::fs::create_dir_all(&models_dir).await.expect("dir");
        assert!(!is_embedding_model_available_in(
            &models_dir,
            "not_a_real_model"
        ));

        install_embedding_model(&models_dir, "ecapa_tdnn_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "not_a_real_model"
        ));

        tokio::fs::remove_dir_all(&models_dir).await.ok();
    }

    #[test]
    fn license_blocked_model_never_runs_even_when_downloaded() {
        let blocked = LICENSE_BLOCKED_SPEAKER_MODEL_ID;
        assert!(resolve_model_for_run_with(blocked, |id| id == blocked).is_none());
        assert!(resolve_model_for_run_with("campplus_speaker", |id| id == blocked).is_none());
        let resolved = resolve_model_for_run_with(blocked, |id| {
            id == blocked || id == DEFAULT_EMBEDDING_MODEL_ID
        })
        .expect("downloaded ECAPA replaces the blocked model");
        assert_eq!(resolved.model_id, DEFAULT_EMBEDDING_MODEL_ID);
        assert_eq!(
            resolved.fallback_notice.as_deref(),
            Some("ERes2NetV2 is turned off while its license is unresolved, so this meeting used another speaker model on this Mac. Choose one in Settings > Meetings > Speaker model.")
        );
        #[cfg(feature = "diarization")]
        assert_eq!(
            resolve_model_for_run_with(blocked, |_| true)
                .unwrap()
                .model_id,
            crate::download::COMMUNITY1_MODEL_ID
        );
        assert_eq!(model_download_size(blocked), None);
        assert_eq!(
            no_speaker_model_notice(blocked),
            no_speaker_model_notice(DEFAULT_EMBEDDING_MODEL_ID)
        );
        assert_ne!(
            crate::permissions::diarization_model_plan(blocked).selected_model_id,
            blocked
        );
        assert!(!crate::permissions::list_diarization_models()
            .iter()
            .any(|model| model.id == blocked));
    }

    #[test]
    fn a_missing_selected_model_runs_a_downloaded_one_and_says_so() {
        let only_default = |id: &str| id == DEFAULT_EMBEDDING_MODEL_ID;

        let resolved = resolve_model_for_run_with("campplus_speaker", only_default)
            .expect("the default can still run");
        assert_eq!(resolved.model_id, DEFAULT_EMBEDDING_MODEL_ID);
        assert_eq!(
            resolved.fallback_notice.as_deref(),
            Some(
                "The speaker model you chose isn't downloaded, so this meeting used another one \
                 on this Mac. Download it in Settings > Meetings > Speaker model."
            )
        );
    }

    #[test]
    fn the_selected_model_runs_unannounced_when_it_is_downloaded() {
        let resolved = resolve_model_for_run_with("campplus_speaker", |_| true)
            .expect("the selected model can run");
        assert_eq!(resolved.model_id, "campplus_speaker");
        assert_eq!(resolved.fallback_notice, None);
    }

    #[test]
    fn an_unknown_model_id_runs_a_downloaded_one_and_says_so() {
        let only_default = |id: &str| id == DEFAULT_EMBEDDING_MODEL_ID;
        let resolved = resolve_model_for_run_with("retired_speaker_model", only_default)
            .expect("the default can still run");
        assert_eq!(resolved.model_id, DEFAULT_EMBEDDING_MODEL_ID);
        let notice = resolved
            .fallback_notice
            .expect("normalizing an unknown id is a reported substitution");
        assert!(
            notice.starts_with(
                "The speaker model you chose isn't part of this version of Plainsong, so this meeting used another one on this Mac."
            ),
            "{notice}"
        );
    }

    /// community-1 first, then ECAPA, then whatever else is on disk; never the
    /// picked model itself, and never a model that is not downloaded.
    #[test]
    fn fallback_prefers_community1_then_ecapa_then_any_downloaded_model() {
        let on_disk = |ids: &'static [&'static str]| move |id: &str| ids.contains(&id);

        #[cfg(feature = "diarization")]
        {
            let resolved = resolve_model_for_run_with(
                "campplus_speaker",
                on_disk(&[
                    DEFAULT_EMBEDDING_MODEL_ID,
                    crate::download::COMMUNITY1_MODEL_ID,
                ]),
            )
            .unwrap();
            assert_eq!(resolved.model_id, crate::download::COMMUNITY1_MODEL_ID);
        }

        let resolved = resolve_model_for_run_with(
            crate::download::COMMUNITY1_MODEL_ID,
            on_disk(&["resnet34_speaker", DEFAULT_EMBEDDING_MODEL_ID]),
        )
        .unwrap();
        assert_eq!(resolved.model_id, DEFAULT_EMBEDDING_MODEL_ID);

        let resolved = resolve_model_for_run_with(
            crate::download::COMMUNITY1_MODEL_ID,
            on_disk(&["resnet34_speaker"]),
        )
        .unwrap();
        assert_eq!(resolved.model_id, "resnet34_speaker");
        #[cfg(feature = "diarization")]
        assert_eq!(
            resolved.fallback_notice.as_deref(),
            Some(
                "The speaker model you chose isn't downloaded, so this meeting used another one \
                 on this Mac. Download it in Settings > Meetings > Speaker model."
            )
        );
    }

    /// The note a meeting saved without speakers carries offers the picked
    /// model's download by its size, or the default's for an id this build
    /// lacks, and calls it "the speaker model" as the meeting's button does.
    #[test]
    fn no_speaker_model_notice_offers_the_speaker_model_by_size() {
        assert_eq!(
            no_speaker_model_notice(DEFAULT_EMBEDDING_MODEL_ID),
            "No speaker model is downloaded, so this meeting was saved without speaker labels. \
             Open the meeting to download the speaker model (25 MB), then label the speakers."
        );
        assert!(no_speaker_model_notice("retired_speaker_model").contains("speaker model (25 MB)"));
        #[cfg(feature = "diarization")]
        assert!(
            no_speaker_model_notice(crate::download::COMMUNITY1_MODEL_ID)
                .contains("the speaker model (33 MB)")
        );
    }

    /// Resolving never reaches the network: there is no download hook to call,
    /// and a meeting with nothing on disk resolves to `None` on its own.
    #[test]
    fn resolving_for_a_meeting_never_downloads() {
        let asked = std::cell::RefCell::new(Vec::<String>::new());
        let probe = |id: &str| {
            asked.borrow_mut().push(id.to_string());
            false
        };
        assert_eq!(
            resolve_model_for_run_with(crate::download::COMMUNITY1_MODEL_ID, probe),
            None
        );
        // Every probe is a disk check of a model this build offers.
        assert!(asked
            .borrow()
            .iter()
            .all(|id| known_diarization_model_id(id)));
    }

    /// The automatic meeting pass has no path to the network for speaker
    /// models: downloads happen only from Settings, the first-run meeting
    /// step and the meeting's own Download button, each a click.
    #[test]
    fn the_meeting_pipeline_never_downloads_a_speaker_model() {
        let pipeline = include_str!("../meeting_pipeline.rs");
        for forbidden in [
            "DownloadManager",
            "download_diarization_model_by_id",
            "download_community1_bundle",
        ] {
            assert!(
                !pipeline.contains(forbidden),
                "meeting_pipeline.rs uses {forbidden}"
            );
        }
    }

    /// Nothing downloaded means no speaker labels, not a quiet substitution of
    /// a model that is not there either.
    #[test]
    fn nothing_runs_when_neither_the_selection_nor_the_default_is_downloaded() {
        assert_eq!(
            resolve_model_for_run_with("campplus_speaker", |_| false),
            None
        );
        assert_eq!(
            resolve_model_for_run_with(DEFAULT_EMBEDDING_MODEL_ID, |_| false),
            None
        );
    }

    /// The picker, the readiness probe and the fallback notice all read the
    /// same table, so a meeting cannot be told a model ran under a name the
    /// picker never showed.
    #[test]
    fn model_labels_match_the_picker() {
        assert_eq!(model_label("ecapa_tdnn_speaker"), "ECAPA-TDNN 512");
        assert_eq!(model_label("resnet34_speaker"), "ResNet34");
        assert_eq!(model_label("campplus_speaker"), "CAM++");
        assert_eq!(model_label("eres2netv2_speaker"), "ERes2NetV2");
        // No invented name for an id this build does not know.
        assert_eq!(model_label("not_a_real_model"), "not_a_real_model");
    }

    #[tokio::test]
    async fn test_diarization_requires_real_model() {
        if is_model_available(DEFAULT_EMBEDDING_MODEL_ID) {
            return;
        }

        let result =
            run_diarization_with_model(&PathBuf::from("test.wav"), "ecapa_tdnn_speaker").await;
        assert!(result.is_err());
        let message = result.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(message.contains("Real diarization model is not available"));
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn test_embedding_clusterer() {
        use ndarray::array;

        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.9, 0.1, 0.0]),
            (4.0, 6.0, array![0.0, 1.0, 0.0]),
            (6.0, 8.0, array![0.1, 0.9, 0.0]),
        ];

        let clusterer = EmbeddingClusterer::new();
        let labels = clusterer.cluster(&embeddings);

        assert_eq!(labels.len(), 4);
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[2], labels[3]);
        assert_ne!(labels[0], labels[2]);
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn test_ahc_centroid_linkage_prevents_transitive_merge() {
        use ndarray::array;

        // A-B and B-C are close (~0.2 cosine distance), while A-C is far (0.72).
        // Single-linkage (connected-components) would chain-merge A/B/C into
        // one cluster via the transitive link through B. AHC centroid linkage
        // should NOT: it merges the single closest pair, then the centroid of
        // that pair is too far from the third embedding for a further merge.
        // This is the key improvement over single-linkage — it prevents
        // speaker over-merging through acoustic similarity chains.
        //
        // Due to f32 precision, d(B,C) ≈ 0.19999993 is slightly less than
        // d(A,B) ≈ 0.19999998, so B and C merge first. After merging, the
        // centroid of {B,C} is ~0.43 from A — well above the 0.25 threshold.
        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.8, 0.6, 0.0]),
            (4.0, 6.0, array![0.28, 0.96, 0.0]),
            (6.0, 8.0, array![0.0, 0.0, 1.0]),
        ];

        let clusterer = EmbeddingClusterer::new().with_threshold(0.25);
        let labels = clusterer.cluster(&embeddings);

        assert_eq!(labels.len(), 4);
        // B and C merge (closest pair, dist ≈ 0.2 ≤ 0.25)
        assert_eq!(labels[1], labels[2]);
        // A does NOT merge with {B,C} (centroid distance ≈ 0.43 > 0.25)
        assert_ne!(labels[0], labels[1]);
        // D is its own cluster
        assert_ne!(labels[0], labels[3]);
        assert_ne!(labels[1], labels[3]);
        // 3 distinct speakers (A, {B,C}, D)
        let unique: std::collections::HashSet<_> = labels.iter().copied().collect();
        assert_eq!(unique.len(), 3);
    }

    #[cfg(feature = "diarization")]
    fn reference_ahc_centroid_linkage(
        embeddings: &[(f64, f64, ndarray::Array1<f32>)],
        threshold: f32,
    ) -> Vec<usize> {
        fn cosine_distance(left: &ndarray::Array1<f32>, right: &ndarray::Array1<f32>) -> f32 {
            let dot = left
                .iter()
                .zip(right.iter())
                .map(|(a, b)| a * b)
                .sum::<f32>();
            let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
            let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
            if left_norm == 0.0 || right_norm == 0.0 {
                return 1.0;
            }
            (1.0 - dot / (left_norm * right_norm)).max(0.0)
        }

        let n = embeddings.len();
        let mut clusters: Vec<Vec<usize>> = (0..n).map(|index| vec![index]).collect();
        let mut centroids: Vec<ndarray::Array1<f32>> =
            embeddings.iter().map(|(_, _, e)| e.clone()).collect();
        let mut active = vec![true; n];
        let mut num_active = n;

        while num_active > 1 {
            let mut min_dist = f32::INFINITY;
            let mut merge_i = 0;
            let mut merge_j = 0;
            for i in 0..n {
                if !active[i] {
                    continue;
                }
                for j in (i + 1)..n {
                    if !active[j] {
                        continue;
                    }
                    let d = cosine_distance(&centroids[i], &centroids[j]);
                    if d < min_dist {
                        min_dist = d;
                        merge_i = i;
                        merge_j = j;
                    }
                }
            }
            if min_dist > threshold {
                break;
            }
            let moved = std::mem::take(&mut clusters[merge_j]);
            clusters[merge_i].extend(moved);
            active[merge_j] = false;
            num_active -= 1;

            // Recompute centroid
            let len = centroids[merge_i].len();
            let mut new_centroid = vec![0.0f32; len];
            for &member in &clusters[merge_i] {
                for (k, &val) in embeddings[member].2.iter().enumerate() {
                    new_centroid[k] += val;
                }
            }
            let norm: f32 = new_centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 1e-6 {
                for val in &mut new_centroid {
                    *val /= norm;
                }
            }
            centroids[merge_i] = ndarray::Array1::from(new_centroid);
        }

        // Build embedding → cluster mapping and assign labels by first occurrence
        let mut emb_to_cluster = vec![0usize; n];
        for (idx, members) in clusters.iter().enumerate() {
            if active[idx] {
                for &m in members {
                    emb_to_cluster[m] = idx;
                }
            }
        }
        let mut labels = vec![0; n];
        let mut label_map: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        let mut next_label = 0;
        for i in 0..n {
            let cluster = emb_to_cluster[i];
            let label = *label_map.entry(cluster).or_insert_with(|| {
                let l = next_label;
                next_label += 1;
                l
            });
            labels[i] = label;
        }
        labels
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn ahc_clustering_matches_reference_and_is_deterministic() {
        use ndarray::array;

        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.0, 1.0, 0.0]),
            (4.0, 6.0, array![0.92, 0.08, 0.0]),
            (6.0, 8.0, array![0.0, 0.0, 1.0]),
            (8.0, 10.0, array![0.08, 0.92, 0.0]),
        ];
        let threshold = 0.25;
        let expected = reference_ahc_centroid_linkage(&embeddings, threshold);
        let clusterer = EmbeddingClusterer::new().with_threshold(threshold);

        for _ in 0..10 {
            assert_eq!(clusterer.cluster(&embeddings), expected);
        }
        // AHC centroid linkage produces the same result as single-linkage
        // for this case because the close pairs (0,2) and (1,4) are
        // well-separated and merge independently.
        assert_eq!(expected, vec![0, 1, 0, 2, 1]);
    }

    #[test]
    fn merge_preserves_single_word_bounds_and_source_identity() {
        let diarization = DiarizationResult {
            segments: vec![SpeakerSegment {
                start_time: 1.2,
                end_time: 1.8,
                speaker_id: "S1".into(),
                confidence: 0.9,
            }],
            speakers: Vec::new(),
            duration: 3.0,
            method: DiarizationMethod::Model,
            cluster_centroids: HashMap::new(),
            word_activity: None,
        };
        let original = crate::models::TranscriptSegment {
            id: "measured-word".into(),
            start_time: 1.0,
            end_time: 2.0,
            text: "twenty".into(),
            speaker_id: None,
            confidence: 0.88,
        };
        let mut transcript = vec![original.clone()];
        DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0].id, original.id);
        assert_eq!(transcript[0].start_time, original.start_time);
        assert_eq!(transcript[0].end_time, original.end_time);
        assert_eq!(transcript[0].text, original.text);
        assert_eq!(transcript[0].confidence, original.confidence);
        assert_eq!(transcript[0].speaker_id.as_deref(), Some("S1"));
    }

    #[test]
    fn merge_gives_a_contested_word_to_the_deeper_turn_and_leaves_a_contested_gap_anonymous() {
        for (turns, expected, measured) in [
            // Midpoint 1.5 is 0.5 s inside S1's turn and 0.3 s inside S2's.
            (vec![(1.0, 2.0, "S1"), (1.2, 1.8, "S2")], Some("S1"), false),
            (vec![(1.0, 2.0, "S1"), (1.2, 1.8, "S2")], Some("S1"), true),
            // Identical turns of two speakers: an exact tie.
            (vec![(0.5, 2.5, "S1"), (0.5, 2.5, "S2")], None, true),
            // Midpoint in a gap the word shares with two speakers' turns.
            (vec![(1.0, 1.4, "S1"), (1.6, 2.0, "S2")], None, false),
            (vec![(1.0, 1.4, "S1"), (1.6, 2.0, "S2")], None, true),
        ] {
            let diarization = DiarizationResult {
                segments: turns
                    .into_iter()
                    .map(|(start_time, end_time, id)| SpeakerSegment {
                        start_time,
                        end_time,
                        speaker_id: id.into(),
                        confidence: 0.9,
                    })
                    .collect(),
                speakers: Vec::new(),
                duration: 3.0,
                method: DiarizationMethod::Model,
                cluster_centroids: HashMap::new(),
                word_activity: None,
            };
            let mut transcript = vec![crate::models::TranscriptSegment {
                id: "word".into(),
                start_time: 1.0,
                end_time: 2.0,
                text: "twenty".into(),
                speaker_id: Some("old".into()),
                confidence: 0.88,
            }];
            if measured {
                DiarizationEngine::new().merge_with_measured_words(&diarization, &mut transcript);
            } else {
                DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);
            }
            assert_eq!(transcript.len(), 1);
            assert_eq!(transcript[0].id, "word");
            assert_eq!(transcript[0].text, "twenty");
            assert_eq!(transcript[0].start_time, 1.0);
            assert_eq!(transcript[0].end_time, 2.0);
            assert_eq!(transcript[0].confidence, 0.88);
            assert_eq!(transcript[0].speaker_id.as_deref(), expected);
        }
    }

    #[test]
    fn a_measured_word_between_turns_takes_the_one_speaker_beside_it() {
        let diarization = DiarizationResult {
            segments: vec![
                SpeakerSegment {
                    start_time: 0.0,
                    end_time: 1.0,
                    speaker_id: "S1".into(),
                    confidence: 0.9,
                },
                SpeakerSegment {
                    start_time: 3.0,
                    end_time: 4.0,
                    speaker_id: "S2".into(),
                    confidence: 0.9,
                },
            ],
            speakers: Vec::new(),
            duration: 4.0,
            method: DiarizationMethod::Embedding,
            cluster_centroids: HashMap::new(),
            word_activity: None,
        };
        let words = [
            (0.8, 1.4, "after"),
            (1.6, 2.4, "alone"),
            (2.7, 3.1, "before"),
        ];
        let source: Vec<crate::models::TranscriptSegment> = words
            .iter()
            .map(
                |&(start_time, end_time, text)| crate::models::TranscriptSegment {
                    id: text.into(),
                    start_time,
                    end_time,
                    text: text.into(),
                    speaker_id: None,
                    confidence: 0.7,
                },
            )
            .collect();
        let mut rows = source.clone();
        DiarizationEngine::new().merge_with_measured_words(&diarization, &mut rows);
        assert_eq!(
            rows.iter()
                .map(|row| row.speaker_id.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("S1"), None, Some("S2")]
        );
        // Only the speaker changed.
        for (row, original) in rows.iter().zip(&source) {
            assert_eq!(row.id, original.id);
            assert_eq!(row.text, original.text);
            assert_eq!(row.start_time, original.start_time);
            assert_eq!(row.end_time, original.end_time);
            assert_eq!(row.confidence, original.confidence);
        }
        // Without measured timings the gap is not filled.
        let mut rows = source.clone();
        DiarizationEngine::new().merge_with_transcript(&diarization, &mut rows);
        assert!(rows.iter().all(|row| row.speaker_id.is_none()));
    }

    #[test]
    fn merge_preserves_uncovered_prefix_gaps_and_suffix_as_none() {
        let diarization = DiarizationResult {
            segments: vec![
                SpeakerSegment {
                    start_time: 2.0,
                    end_time: 4.0,
                    speaker_id: "S1".to_string(),
                    confidence: 0.9,
                },
                SpeakerSegment {
                    start_time: 6.0,
                    end_time: 8.0,
                    speaker_id: "S2".to_string(),
                    confidence: 0.9,
                },
            ],
            speakers: Vec::new(),
            duration: 10.0,
            method: DiarizationMethod::Embedding,
            cluster_centroids: HashMap::new(),
            word_activity: None,
        };
        let original_text = "one two three four five six seven eight nine ten";
        let mut transcript = vec![crate::models::TranscriptSegment {
            id: "segment-1".to_string(),
            start_time: 0.0,
            end_time: 10.0,
            text: original_text.to_string(),
            speaker_id: None,
            confidence: 0.9,
        }];

        DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);

        assert_eq!(
            transcript
                .iter()
                .map(|segment| segment.speaker_id.as_deref())
                .collect::<Vec<_>>(),
            vec![None, Some("S1"), None, Some("S2"), None]
        );
        assert_eq!(
            transcript
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            original_text
        );
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn merge_keeps_short_runs_removed_by_smoothing_anonymous() {
        let clusterer = EmbeddingClusterer::new();
        let smoothed =
            clusterer.smooth_segments(&[(0.0, 6.0), (6.0, 8.0), (8.0, 14.0)], &[0, 1, 0]);
        assert_eq!(smoothed, vec![(0.0, 6.0, 0), (8.0, 14.0, 0)]);
        let diarization = DiarizationResult {
            segments: smoothed
                .into_iter()
                .map(|(start_time, end_time, label)| SpeakerSegment {
                    start_time,
                    end_time,
                    speaker_id: format!("S{}", label + 1),
                    confidence: 0.9,
                })
                .collect(),
            speakers: Vec::new(),
            duration: 14.0,
            method: DiarizationMethod::Embedding,
            cluster_centroids: HashMap::new(),
            word_activity: None,
        };
        let mut transcript = vec![crate::models::TranscriptSegment {
            id: "segment-1".to_string(),
            start_time: 0.0,
            end_time: 14.0,
            text:
                "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
                    .to_string(),
            speaker_id: None,
            confidence: 0.9,
        }];

        DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);

        assert_eq!(transcript.len(), 3);
        assert_eq!(transcript[0].speaker_id.as_deref(), Some("S1"));
        assert_eq!(transcript[1].speaker_id, None);
        assert_eq!(transcript[1].start_time, 6.0);
        assert_eq!(transcript[1].end_time, 8.0);
        assert_eq!(transcript[2].speaker_id.as_deref(), Some("S1"));
    }
    #[test]
    fn measured_word_recovery_keeps_source_rows_and_requires_explicit_provenance() {
        let activity = SpeakerActivity::new(
            vec![[0.8, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]; 100],
            std::array::from_fn(|i| if i == 0 { Some("S1".into()) } else { None }),
            1.0,
        );
        let result = DiarizationResult {
            segments: vec![],
            speakers: vec![],
            duration: 1.0,
            method: DiarizationMethod::Model,
            cluster_centroids: HashMap::new(),
            word_activity: Some(activity),
        };
        let source = crate::models::TranscriptSegment {
            id: "source-word".into(),
            start_time: 0.3,
            end_time: 0.7,
            text: "Francina".into(),
            speaker_id: None,
            confidence: 0.88,
        };
        let mut rows = vec![source.clone()];
        DiarizationEngine::new().merge_with_transcript(&result, &mut rows);
        assert_eq!(rows[0].speaker_id, None);
        DiarizationEngine::new().merge_with_measured_words(&result, &mut rows);
        assert_eq!(rows[0].speaker_id.as_deref(), Some("S1"));
        assert_eq!(rows[0].id, source.id);
        assert_eq!(rows[0].text, source.text);
        assert_eq!(rows[0].start_time, source.start_time);
        assert_eq!(rows[0].end_time, source.end_time);
        assert_eq!(rows[0].confidence, source.confidence);
        let serialized = serde_json::to_value(&result).unwrap();
        assert!(serialized.get("wordActivity").is_none());
    }

    #[test]
    fn measured_word_turns_outrank_activity_and_two_speakers_keep_a_word_anonymous() {
        let mut result = DiarizationResult {
            segments: vec![SpeakerSegment {
                start_time: 0.0,
                end_time: 1.0,
                speaker_id: "S2".into(),
                confidence: 0.0,
            }],
            speakers: vec![],
            duration: 1.0,
            method: DiarizationMethod::Model,
            cluster_centroids: HashMap::new(),
            word_activity: Some(SpeakerActivity::new(
                vec![[0.9, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]; 100],
                std::array::from_fn(|i| Some(format!("S{}", i + 1))),
                1.0,
            )),
        };
        let source = crate::models::TranscriptSegment {
            id: "word".into(),
            start_time: 0.0,
            end_time: 0.8,
            text: "name".into(),
            speaker_id: None,
            confidence: 0.88,
        };
        let mut rows = vec![source.clone()];
        DiarizationEngine::new().merge_with_measured_words(&result, &mut rows);
        assert_eq!(rows[0].speaker_id.as_deref(), Some("S2"));
        result.segments.push(SpeakerSegment {
            start_time: 0.0,
            end_time: 1.0,
            speaker_id: "S3".into(),
            confidence: 0.0,
        });
        rows = vec![source.clone()];
        DiarizationEngine::new().merge_with_measured_words(&result, &mut rows);
        assert_eq!(rows[0].speaker_id, None);
        for s in &mut result.segments {
            s.end_time = 0.2;
        }
        rows = vec![source];
        DiarizationEngine::new().merge_with_measured_words(&result, &mut rows);
        assert_eq!(rows[0].speaker_id, None);
        // One speaker's turn touches the uncovered word: it wins over the
        // activity evidence, which names S1.
        result.segments.truncate(1);
        DiarizationEngine::new().merge_with_measured_words(&result, &mut rows);
        assert_eq!(rows[0].speaker_id.as_deref(), Some("S2"));
    }
}

/// Opt-in threshold calibration for [`voiceprints`].
///
/// Not a gate test and not run by `cargo test`: it needs the four speaker
/// embedding ONNX models on disk and a directory of fixture WAVs, and it
/// exists to produce the numbers in
/// `artifacts/qa/voiceprint-recalibration-2026-09-03.md` (which supersedes
/// `artifacts/qa/voiceprint-calibration-2026-09-02.md`, measured before the
/// CAM++ ONNX Runtime fix). It is kept in the tree rather than in a scratch
/// script so the thresholds shipped in `voiceprints.rs` can be re-derived by
/// anyone, with the app's own embedder rather than a re-implementation of it.
///
/// Environment:
///
/// - `PLAINSONG_VOICEPRINT_CALIBRATION=1` — required, or both tests skip.
/// - `PLAINSONG_DATA_DIR` — where the four models are staged.
/// - `PLAINSONG_VOICEPRINT_FIXTURES` — a directory of `<voice>_<n>.wav`.
/// - `PLAINSONG_TWO_SPEAKER_FIXTURE` — the cluster eval's fixture directory.
/// - `PLAINSONG_VOICEPRINT_DUMP` — optional; write each fixture's pooled
///   signature out as little-endian `f32` so two builds of this crate can be
///   compared vector by vector. That is how the 2026-09-03 receipt showed that
///   a voiceprint stored by a pre-fix build still matches a post-fix one.
#[cfg(all(test, feature = "diarization"))]
mod calibration {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /// Fixture naming: `<voice>_<index>.wav`, 16 kHz mono.
    fn voice_of(file_name: &str) -> Option<String> {
        let stem = file_name.strip_suffix(".wav")?;
        let (voice, _) = stem.rsplit_once('_')?;
        Some(voice.to_string())
    }

    fn percentile(sorted: &[f32], fraction: f64) -> f32 {
        if sorted.is_empty() {
            return f32::NAN;
        }
        let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
        sorted[index]
    }

    /// Build one voice signature per fixture, for one model, **exactly the way
    /// the product does**: the same 2-second/1-second-overlap segmentation
    /// `diarize_real` uses, pooled with the same `centroid_of`.
    ///
    /// An earlier version of this harness embedded each fixture as one long
    /// utterance instead. That measured a different object than the one the
    /// app compares, and it mattered: CAM++ separated speakers cleanly at
    /// 2-second windows and not at all at 8-second ones.
    async fn embed_fixtures(
        model_id: &str,
        fixtures: &[PathBuf],
    ) -> BTreeMap<String, Vec<Vec<f32>>> {
        let models_dir = crate::paths::data_dir()
            .expect("PLAINSONG_DATA_DIR must point at the staged models")
            .join("Plainsong")
            .join("models")
            .join("diarization");
        let model_path = models_dir.join(format!("{model_id}.onnx"));
        let sha = crate::download::diarization_model_expected_sha256(model_id)
            .expect("every calibrated model must be a known diarization model");
        crate::download::mark_model_verified_for_tests(&model_path, sha)
            .await
            .expect("the staged model file must match this build's pinned digest");

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(model_id)
            .expect("extractor construction");
        assert!(
            extractor.is_model_available(),
            "{model_id}: staged model did not pass integrity verification"
        );

        // Optional: write each fixture's signature out as little-endian f32 so
        // two builds of this crate can be compared against each other. Used by
        // `artifacts/qa/voiceprint-recalibration-2026-09-03.md` to check that a
        // voiceprint stored by a pre-fix build still matches embeddings from a
        // post-fix one. Unset in every normal run.
        let dump_dir = std::env::var("PLAINSONG_VOICEPRINT_DUMP")
            .ok()
            .map(PathBuf::from);
        if let Some(dir) = dump_dir.as_ref() {
            std::fs::create_dir_all(dir.join(model_id)).expect("dump directory");
        }

        let mut by_voice: BTreeMap<String, Vec<Vec<f32>>> = BTreeMap::new();
        for fixture in fixtures {
            let file_name = fixture.file_name().unwrap().to_string_lossy().to_string();
            let voice = voice_of(&file_name).expect("fixture names are <voice>_<index>.wav");
            let duration = super::get_audio_duration(fixture)
                .await
                .expect("fixture duration");
            let segments = generate_segments(duration, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS);
            let embeddings = extractor
                .extract_embeddings(fixture, &segments)
                .await
                .expect("fixture embedding");
            let samples: Vec<Vec<f32>> = embeddings
                .into_iter()
                .map(|(_, _, embedding)| embedding.iter().copied().collect())
                .collect();
            let centroid = voiceprints::centroid_of(&samples)
                .expect("a fixture utterance must produce a usable embedding");
            if let Some(dir) = dump_dir.as_ref() {
                let stem = file_name.strip_suffix(".wav").unwrap();
                let mut bytes = Vec::with_capacity(centroid.len() * 4);
                for value in &centroid {
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
                std::fs::write(dir.join(model_id).join(format!("{stem}.f32")), &bytes)
                    .expect("dump signature");
            }
            by_voice.entry(voice).or_default().push(centroid);
        }
        by_voice
    }

    /// Opt-in diarization accuracy check on a two-speaker fixture.
    ///
    /// Runs the whole embed → cluster → smooth path a real meeting runs and
    /// scores it against a ground-truth turn list, so a claim about one
    /// embedder being better than another has a number behind it. This is what
    /// established that CAM++ does not merely fail voiceprint matching in this
    /// build but cannot separate two speakers at all.
    ///
    /// Fixture: `<PLAINSONG_VOICEPRINT_FIXTURES>/../twospeaker/twospeaker.wav`
    /// plus `twospeaker.json` (`{"duration":…, "turns":[{speaker,start,end}]}`).
    #[tokio::test]
    #[ignore = "needs the speaker embedding models and a two-speaker fixture on disk; opt in with PLAINSONG_VOICEPRINT_CALIBRATION=1"]
    async fn diarization_cluster_eval() {
        if std::env::var("PLAINSONG_VOICEPRINT_CALIBRATION").as_deref() != Ok("1") {
            eprintln!("skipped: set PLAINSONG_VOICEPRINT_CALIBRATION=1 to run");
            return;
        }
        let fixture_dir = PathBuf::from(
            std::env::var("PLAINSONG_TWO_SPEAKER_FIXTURE")
                .expect("PLAINSONG_TWO_SPEAKER_FIXTURE must name the fixture directory"),
        );
        let audio = fixture_dir.join("twospeaker.wav");
        let truth: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture_dir.join("twospeaker.json")).expect("truth file"),
        )
        .expect("truth json");
        let turns: Vec<(String, f64, f64)> = truth["turns"]
            .as_array()
            .expect("turns array")
            .iter()
            .map(|turn| {
                (
                    turn["speaker"].as_str().unwrap().to_string(),
                    turn["start"].as_f64().unwrap(),
                    turn["end"].as_f64().unwrap(),
                )
            })
            .collect();
        let duration = truth["duration"].as_f64().unwrap();

        for model_id in [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            let models_dir = crate::paths::data_dir()
                .expect("PLAINSONG_DATA_DIR must point at the staged models")
                .join("Plainsong")
                .join("models")
                .join("diarization");
            let model_path = models_dir.join(format!("{model_id}.onnx"));
            let sha = crate::download::diarization_model_expected_sha256(model_id).unwrap();
            crate::download::mark_model_verified_for_tests(&model_path, sha)
                .await
                .expect("mark test model verified");

            let mut engine = DiarizationEngine::with_model(model_id);
            let result = engine
                .diarize(&audio, duration)
                .await
                .expect("diarization must run");

            // Score at 0.1 s resolution over the fixture, under the label
            // permutation that favours the model — a diarizer is not asked to
            // guess which speaker is called what.
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut step = 0.0f64;
            while step < duration {
                let truth_speaker = turns
                    .iter()
                    .find(|(_, start, end)| step >= *start && step < *end)
                    .map(|(speaker, _, _)| speaker.clone());
                let predicted = result
                    .segments
                    .iter()
                    .find(|segment| step >= segment.start_time && step < segment.end_time)
                    .map(|segment| segment.speaker_id.clone());
                if let (Some(truth_speaker), Some(predicted)) = (truth_speaker, predicted) {
                    pairs.push((truth_speaker, predicted));
                }
                step += 0.1;
            }
            let truth_labels: std::collections::BTreeSet<&String> =
                pairs.iter().map(|(t, _)| t).collect();
            let predicted_labels: std::collections::BTreeSet<&String> =
                pairs.iter().map(|(_, p)| p).collect();
            // Two ground-truth speakers, so the only permutations are identity
            // and swap; score both and keep the better one.
            let truth_vec: Vec<&String> = truth_labels.into_iter().collect();
            let predicted_vec: Vec<&String> = predicted_labels.into_iter().collect();
            let mut best_correct = 0usize;
            for assignment in [true, false] {
                let correct = pairs
                    .iter()
                    .filter(|(truth_label, predicted_label)| {
                        let truth_index = truth_vec.iter().position(|t| *t == truth_label).unwrap();
                        let mapped = if assignment {
                            predicted_vec.get(truth_index)
                        } else {
                            predicted_vec.get(predicted_vec.len().saturating_sub(1 + truth_index))
                        };
                        mapped.is_some_and(|m| *m == predicted_label)
                    })
                    .count();
                best_correct = best_correct.max(correct);
            }
            let frame_error = if pairs.is_empty() {
                1.0
            } else {
                1.0 - best_correct as f64 / pairs.len() as f64
            };
            println!(
                "{model_id}: speakers={} (truth 2)  scored_frames={}  frame_error={:.1}%",
                result.speakers.len(),
                pairs.len(),
                frame_error * 100.0
            );
        }
    }

    #[tokio::test]
    #[ignore = "needs the speaker embedding models and say-voice fixtures on disk; opt in with PLAINSONG_VOICEPRINT_CALIBRATION=1"]
    async fn voiceprint_threshold_calibration() {
        if std::env::var("PLAINSONG_VOICEPRINT_CALIBRATION").as_deref() != Ok("1") {
            eprintln!("skipped: set PLAINSONG_VOICEPRINT_CALIBRATION=1 to run");
            return;
        }
        let fixtures_dir = PathBuf::from(
            std::env::var("PLAINSONG_VOICEPRINT_FIXTURES")
                .expect("PLAINSONG_VOICEPRINT_FIXTURES must name the fixture directory"),
        );
        let mut fixtures: Vec<PathBuf> = std::fs::read_dir(&fixtures_dir)
            .expect("fixture directory")
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
            .collect();
        fixtures.sort();
        assert!(!fixtures.is_empty(), "no fixtures found");

        for model_id in [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            let by_voice = embed_fixtures(model_id, &fixtures).await;
            let dimension = by_voice.values().next().unwrap()[0].len();

            let mut same: Vec<f32> = Vec::new();
            let mut different: Vec<f32> = Vec::new();
            let voices: Vec<&String> = by_voice.keys().collect();
            for (i, left_voice) in voices.iter().enumerate() {
                let left = &by_voice[*left_voice];
                for a in 0..left.len() {
                    for b in (a + 1)..left.len() {
                        same.push(voiceprints::cosine_similarity(&left[a], &left[b]).unwrap());
                    }
                }
                for right_voice in voices.iter().skip(i + 1) {
                    let right = &by_voice[*right_voice];
                    for left_sample in left {
                        for right_sample in right {
                            different.push(
                                voiceprints::cosine_similarity(left_sample, right_sample).unwrap(),
                            );
                        }
                    }
                }
            }
            same.sort_by(|a, b| a.partial_cmp(b).unwrap());
            different.sort_by(|a, b| a.partial_cmp(b).unwrap());

            println!("=== {model_id} (dim {dimension}) ===");
            println!("voices: {}", voices.len());
            println!(
                "same-speaker  n={:<4} min={:.4} p05={:.4} p50={:.4} p95={:.4} max={:.4}",
                same.len(),
                same[0],
                percentile(&same, 0.05),
                percentile(&same, 0.50),
                percentile(&same, 0.95),
                same[same.len() - 1]
            );
            println!(
                "diff-speaker  n={:<4} min={:.4} p50={:.4} p95={:.4} p99={:.4} max={:.4}",
                different.len(),
                different[0],
                percentile(&different, 0.50),
                percentile(&different, 0.95),
                percentile(&different, 0.99),
                different[different.len() - 1]
            );
            for step in 40..=95 {
                let threshold = step as f32 / 100.0;
                let false_accepts = different.iter().filter(|s| **s >= threshold).count();
                let true_accepts = same.iter().filter(|s| **s >= threshold).count();
                let far = false_accepts as f64 / different.len() as f64;
                let tar = true_accepts as f64 / same.len() as f64;
                println!(
                    "  t={threshold:.2} FAR={far:.4} ({false_accepts}/{}) TAR={tar:.4} ({true_accepts}/{})",
                    different.len(),
                    same.len()
                );
            }
        }
    }
}

/// Evaluation harness for comparing diarization backends on a fixture with
/// known turns. Ignored by default: each test downloads model weights and runs
/// real inference, which is neither hermetic nor fast enough for `bun run
/// test:rust`. One backend per test, run in separate processes, because peak
/// RSS is a process high-water mark and would otherwise be reported as the max
/// of both.
///
///   PLAINSONG_DATA_DIR=<scratch> PLAINSONG_DIAR_EVAL_AUDIO=<wav> \
///     cargo test --lib \
///     diarization::eval_tests::eval_embedding_backend -- --ignored --nocapture
///
/// Each test prints one JSON line prefixed `DIAR-EVAL ` so a scorer can pick
/// it out of cargo's output; `scripts/score-diarization-eval.ts` compares
/// those turns against the fixture's ground truth.
#[cfg(test)]
mod eval_tests {
    use super::*;

    fn eval_audio_path() -> std::path::PathBuf {
        let raw = std::env::var("PLAINSONG_DIAR_EVAL_AUDIO")
            .expect("set PLAINSONG_DIAR_EVAL_AUDIO to the fixture WAV");
        std::path::PathBuf::from(raw)
    }

    /// Peak resident set size of this process so far, in bytes. macOS reports
    /// `ru_maxrss` in bytes (Linux uses kilobytes), and this harness only ever
    /// runs on the macOS dev machine, so no unit conversion is applied.
    fn peak_rss_bytes() -> u64 {
        // SAFETY: `getrusage` only writes into the provided `rusage`, which is
        // zeroed and lives for the whole call.
        unsafe {
            let mut usage: libc::rusage = std::mem::zeroed();
            if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
                return 0;
            }
            usage.ru_maxrss as u64
        }
    }

    /// Compare the fixed grid against VAD-aligned segmentation at two hops,
    /// on one fixture, in one process, with one embedder.
    ///
    /// Ignored like its neighbours: it downloads weights and runs real
    /// inference. Prints one `DIAR-EVAL` line per mode so
    /// `scripts/score-diarization-eval.ts` can score all three against the
    /// same ground truth:
    ///
    /// ```text
    /// PLAINSONG_DATA_DIR=<dir> PLAINSONG_DIAR_EVAL_AUDIO=<wav> \
    ///   cargo test --lib diarization::eval_tests::eval_segmentation_modes \
    ///   -- --ignored --nocapture
    /// ```
    #[cfg(feature = "diarization")]
    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_segmentation_modes() {
        let audio = eval_audio_path();
        let model_id = std::env::var("PLAINSONG_DIAR_EVAL_MODEL")
            .unwrap_or_else(|_| "ecapa_tdnn_speaker".to_string());
        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_diarization_model_by_id(&model_id, |_: crate::download::DownloadProgress| {})
            .await
            .expect("embedding model");
        // VAD alignment silently degrades to the fixed grid without this, so
        // an eval that ran with it missing would report "no difference" and be
        // wrong. Fail loudly instead.
        manager
            .download_silero_vad_model(|_: crate::download::DownloadProgress| {})
            .await
            .expect("Silero VAD model");

        let duration = get_audio_duration(&audio).await.expect("fixture duration");

        // What the VAD actually saw, printed before any embedding runs: a
        // segmentation result is uninterpretable without it, and a fixture
        // with no silence in it makes VAD alignment identical to the grid.
        let regions =
            segmentation::speech_regions_for_file(&audio, &manager.silero_vad_model_path())
                .expect("Silero VAD must run for this comparison to mean anything");
        let speech: f64 = regions.iter().map(|region| region.seconds()).sum();
        println!(
            "DIAR-SEG {}",
            serde_json::json!({
                "audio": audio.to_string_lossy(),
                "durationSeconds": duration,
                "speechRegions": regions.len(),
                "speechSeconds": speech,
                "windows": {
                    "fixedGrid": generate_segments(
                        duration,
                        SEGMENT_SECONDS,
                        SEGMENT_OVERLAP_SECONDS,
                    ).len(),
                    "vadHop1.0": segmentation::generate_vad_aligned_segments(
                        &regions,
                        SEGMENT_SECONDS,
                        1.0,
                        MIN_SEGMENT_SECONDS,
                    ).len(),
                    "vadHop0.5": segmentation::generate_vad_aligned_segments(
                        &regions,
                        SEGMENT_SECONDS,
                        0.5,
                        MIN_SEGMENT_SECONDS,
                    ).len(),
                },
                "firstRegions": regions
                    .iter()
                    .take(6)
                    .map(|region| serde_json::json!([region.start, region.end]))
                    .collect::<Vec<_>>(),
            })
        );

        for (label, mode) in [
            ("fixed-grid-1.0s", SegmentationMode::FixedGrid),
            (
                "vad-aligned-1.0s",
                SegmentationMode::VadAligned { hop_seconds: 1.0 },
            ),
            (
                "vad-aligned-0.5s",
                SegmentationMode::VadAligned { hop_seconds: 0.5 },
            ),
        ] {
            let mut engine = DiarizationEngine::with_model(&model_id).with_segmentation(mode);
            let started = std::time::Instant::now();
            let result = engine
                .diarize(&audio, duration)
                .await
                .expect("diarization must run");
            report(
                &format!("{model_id}/{label}"),
                &audio,
                started.elapsed(),
                &result,
            );
        }
    }

    /// Frame error against `EmbeddingClusterer`'s turn floor, swept in one
    /// process on one fixture.
    ///
    /// The expensive half of diarization — windowing, embedding, clustering —
    /// does not depend on the floor at all, so it runs **once** and every
    /// floor is scored by re-running only `smooth_segments` over the same
    /// labels. That is what makes a ten-point curve on 24 fixtures affordable,
    /// and it also means the points differ by exactly one variable.
    ///
    /// Prints, per fixture:
    /// - one `DIAR-LABELS` line: the raw window/label list, so a hermetic
    ///   regression test can pin the frame error without an ONNX runtime;
    /// - one `DIAR-EVAL` line per floor per policy, for
    ///   `scripts/score-diarization-eval.ts`.
    ///
    /// ```text
    /// PLAINSONG_DIAR_EVAL_AUDIO=<wav> PLAINSONG_DIAR_EVAL_MODEL=<id> \
    ///   bun scripts/cargo-sidecar.ts test --locked --lib \
    ///   diarization::eval_tests::eval_turn_floor_sweep -- --ignored --nocapture
    /// ```
    #[cfg(feature = "diarization")]
    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_turn_floor_sweep() {
        let audio = eval_audio_path();
        let model_id = std::env::var("PLAINSONG_DIAR_EVAL_MODEL")
            .unwrap_or_else(|_| "ecapa_tdnn_speaker".to_string());
        let segmentation = match std::env::var("PLAINSONG_DIAR_EVAL_SEGMENTATION")
            .unwrap_or_else(|_| "fixed".to_string())
            .as_str()
        {
            "fixed" => SegmentationMode::FixedGrid,
            "vad1.0" => SegmentationMode::VadAligned { hop_seconds: 1.0 },
            "vad0.5" => SegmentationMode::VadAligned { hop_seconds: 0.5 },
            other => panic!("unknown PLAINSONG_DIAR_EVAL_SEGMENTATION {other:?}"),
        };
        let floors: Vec<f64> = std::env::var("PLAINSONG_DIAR_EVAL_FLOORS")
            .unwrap_or_else(|_| "0.5,1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0".to_string())
            .split(',')
            .map(|value| value.trim().parse::<f64>().expect("floor must be a number"))
            .collect();

        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_diarization_model_by_id(&model_id, |_: crate::download::DownloadProgress| {})
            .await
            .expect("embedding model");
        if matches!(segmentation, SegmentationMode::VadAligned { .. }) {
            manager
                .download_silero_vad_model(|_: crate::download::DownloadProgress| {})
                .await
                .expect("Silero VAD model");
        }

        let duration = get_audio_duration(&audio).await.expect("fixture duration");
        let engine = DiarizationEngine::with_model(&model_id).with_segmentation(segmentation);
        let segments = engine.segments_for(&audio, duration);
        assert!(
            !segments.is_empty(),
            "fixture produced no embedding windows"
        );

        let started = std::time::Instant::now();
        let extractor =
            embedder::SpeakerEmbeddingExtractor::with_model(&model_id).expect("extractor");
        let embeddings = extractor
            .extract_embeddings(&audio, &segments)
            .await
            .expect("embeddings");
        let windows: Vec<(f64, f64)> = embeddings
            .iter()
            .map(|(start, end, _)| (*start, *end))
            .collect();
        let threshold = std::env::var("PLAINSONG_DIAR_EVAL_THRESHOLD")
            .ok()
            .map(|value| value.parse::<f32>().expect("threshold must be a number"));
        if let Some(threshold) = threshold {
            assert!(
                threshold.is_finite() && (0.0..=1.0).contains(&threshold),
                "threshold must be between zero and one"
            );
        }
        let clusterer = match threshold {
            Some(threshold) => EmbeddingClusterer::new().with_threshold(threshold),
            None => EmbeddingClusterer::new(),
        };
        let labels = clusterer.cluster(&embeddings);
        let shared = started.elapsed();

        println!(
            "DIAR-LABELS {}",
            serde_json::json!({
                "audio": audio.to_string_lossy(),
                "model": model_id,
                "thresholdOverride": threshold,
                "durationSeconds": duration,
                "windows": windows
                    .iter()
                    .zip(labels.iter())
                    .map(|((start, end), label)| serde_json::json!([start, end, label]))
                    .collect::<Vec<_>>(),
            })
        );

        for floor in floors {
            let clusterer = EmbeddingClusterer::new().with_min_segment_duration(floor);
            let established = clusterer.smooth_established_segments(&windows, &labels);
            report_turns(
                &format!("{model_id}/established/threshold-{threshold:?}/anchor-{floor:.1}"),
                &audio,
                duration,
                shared,
                &established,
            );
            let discarded = clusterer.smooth_segments(&windows, &labels);
            report_turns(
                &format!("{model_id}/discard/threshold-{threshold:?}/floor-{floor:.1}"),
                &audio,
                duration,
                shared,
                &discarded,
            );

            let absorbed = absorb_short_runs(&windows, &labels, &embeddings, floor);
            report_turns(
                &format!("{model_id}/absorb/floor-{floor:.1}"),
                &audio,
                duration,
                shared,
                &absorbed,
            );
        }
    }

    /// The candidate alternative to discarding: a merged run shorter than
    /// `floor` is relabelled to whichever *neighbouring* run its mean
    /// embedding is closer to by cosine, then adjacent same-label runs are
    /// merged again. Nothing is dropped, so coverage is total.
    ///
    /// Lives in the harness rather than in `embedder` until the numbers say it
    /// is worth shipping.
    #[cfg(feature = "diarization")]
    fn absorb_short_runs(
        windows: &[(f64, f64)],
        labels: &[usize],
        embeddings: &[(f64, f64, Array1<f32>)],
        floor: f64,
    ) -> Vec<(f64, f64, usize)> {
        // Merge consecutive same-label windows into runs, remembering which
        // windows each run covers so a run's centroid can be recomputed.
        let mut runs: Vec<(f64, f64, usize, std::ops::Range<usize>)> = Vec::new();
        let mut i = 0;
        while i < windows.len() {
            let (start, _) = windows[i];
            let label = labels[i];
            let mut j = i + 1;
            let mut end = windows[i].1;
            while j < windows.len() && labels[j] == label && windows[j].0 <= end + 1e-6 {
                end = end.max(windows[j].1);
                j += 1;
            }
            runs.push((start, end, label, i..j));
            i = j;
        }

        let centroid = |range: &std::ops::Range<usize>| -> Array1<f32> {
            let mut sum = vec![0.0f32; embeddings[range.start].2.len()];
            for index in range.clone() {
                for (k, value) in embeddings[index].2.iter().enumerate() {
                    sum[k] += *value;
                }
            }
            let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 1e-6 {
                for value in &mut sum {
                    *value /= norm;
                }
            }
            Array1::from(sum)
        };

        // Both operands are L2-normalized above, so this is 1 - dot.
        let distance = |a: &Array1<f32>, b: &Array1<f32>| -> f32 {
            (1.0 - a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f32>()).max(0.0)
        };

        let centroids: Vec<Array1<f32>> = runs.iter().map(|run| centroid(&run.3)).collect();
        let mut relabelled: Vec<usize> = runs.iter().map(|run| run.2).collect();
        for index in 0..runs.len() {
            if runs[index].1 - runs[index].0 >= floor {
                continue;
            }
            let previous = index
                .checked_sub(1)
                .filter(|&p| runs[index].0 <= runs[p].1 + 1e-6)
                .map(|p| (relabelled[p], distance(&centroids[index], &centroids[p])));
            let next = runs
                .get(index + 1)
                .filter(|next| next.0 <= runs[index].1 + 1e-6)
                .map(|_| {
                    (
                        relabelled[index + 1],
                        distance(&centroids[index], &centroids[index + 1]),
                    )
                });
            let winner = match (previous, next) {
                (Some(a), Some(b)) => Some(if a.1 <= b.1 { a.0 } else { b.0 }),
                (Some(a), None) => Some(a.0),
                (None, Some(b)) => Some(b.0),
                (None, None) => None,
            };
            if let Some(label) = winner {
                relabelled[index] = label;
            }
        }

        let mut turns: Vec<(f64, f64, usize)> = Vec::new();
        for (index, run) in runs.iter().enumerate() {
            let label = relabelled[index];
            match turns.last_mut() {
                Some(last) if last.2 == label && run.0 <= last.1 + 1e-6 => {
                    last.1 = last.1.max(run.1);
                }
                _ => turns.push((run.0, run.1, label)),
            }
        }
        turns
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn absorption_preserves_silence_gaps_and_isolated_turn_labels() {
        let windows = [(0.0, 2.0), (8.0, 10.0), (16.0, 18.0)];
        let embeddings = windows
            .iter()
            .map(|&(start, end)| (start, end, Array1::from(vec![1.0, 0.0])))
            .collect::<Vec<_>>();
        assert_eq!(
            absorb_short_runs(&windows, &[0, 0, 1], &embeddings, 3.0),
            vec![(0.0, 2.0, 0), (8.0, 10.0, 0), (16.0, 18.0, 1)]
        );
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn absorption_keeps_nested_window_coverage_and_can_merge_touching_runs() {
        let windows = [(0.0, 4.0), (1.0, 2.0), (4.0, 5.0)];
        let embeddings = windows
            .iter()
            .map(|&(start, end)| (start, end, Array1::from(vec![1.0, 0.0])))
            .collect::<Vec<_>>();
        assert_eq!(
            absorb_short_runs(&windows, &[0, 0, 1], &embeddings, 3.0),
            vec![(0.0, 5.0, 0)]
        );
    }

    #[cfg(feature = "diarization")]
    fn report_turns(
        backend: &str,
        audio: &std::path::Path,
        duration: f64,
        elapsed: std::time::Duration,
        turns: &[(f64, f64, usize)],
    ) {
        let mut speakers: Vec<usize> = turns.iter().map(|turn| turn.2).collect();
        speakers.sort_unstable();
        speakers.dedup();
        let line = serde_json::json!({
            "backend": backend,
            "audio": audio.to_string_lossy(),
            "durationSeconds": duration,
            // The shared embed+cluster pass, repeated on every row: the floor
            // does not change it, so this is not a per-row timing.
            "wallSeconds": elapsed.as_secs_f64(),
            "peakRssBytes": peak_rss_bytes(),
            "speakerCount": speakers.len(),
            "turns": turns
                .iter()
                .map(|(start, end, label)| serde_json::json!({
                    "start": start,
                    "end": end,
                    "speaker": format!("S{}", label + 1),
                }))
                .collect::<Vec<_>>(),
        });
        println!("DIAR-EVAL {line}");
    }

    fn report(
        backend: &str,
        audio: &std::path::Path,
        elapsed: std::time::Duration,
        result: &DiarizationResult,
    ) {
        let turns: Vec<serde_json::Value> = result
            .segments
            .iter()
            .map(|segment| {
                serde_json::json!({
                    "start": segment.start_time,
                    "end": segment.end_time,
                    "speaker": segment.speaker_id,
                })
            })
            .collect();
        let line = serde_json::json!({
            "backend": backend,
            "audio": audio.to_string_lossy(),
            "durationSeconds": result.duration,
            "wallSeconds": elapsed.as_secs_f64(),
            "peakRssBytes": peak_rss_bytes(),
            "speakerCount": result.speakers.len(),
            "turns": turns,
        });
        println!("DIAR-EVAL {line}");
    }

    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_embedding_backend() {
        let audio = eval_audio_path();
        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_diarization_model_by_id(
                "ecapa_tdnn_speaker",
                |_: crate::download::DownloadProgress| {},
            )
            .await
            .expect("ECAPA-TDNN model");

        let started = std::time::Instant::now();
        let result = run_diarization_with_model(&audio, "ecapa_tdnn_speaker")
            .await
            .expect("embedding diarization");
        report("embedding-ecapa_tdnn", &audio, started.elapsed(), &result);
    }

    #[cfg(feature = "diarization")]
    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_community1_backend() {
        let audio = eval_audio_path();
        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_community1_bundle(|_: crate::download::DownloadProgress| {})
            .await
            .expect("community-1 bundle");

        let started = std::time::Instant::now();
        let result = run_diarization_with_model(&audio, crate::download::COMMUNITY1_MODEL_ID)
            .await
            .expect("community-1 diarization");
        report("pyannote-community1", &audio, started.elapsed(), &result);
    }

    /// Nemotron has no pinned download yet: point
    /// `PLAINSONG_NEMOTRON_DIAR_ONNX` at `nemotron3_diar_v3.onnx`.
    #[cfg(feature = "diarization-nemotron")]
    #[tokio::test]
    #[ignore = "evaluation harness: needs the model file and runs real inference"]
    async fn eval_nemotron_backend() {
        let audio = eval_audio_path();
        let duration = get_audio_duration(&audio).await.expect("fixture duration");

        let started = std::time::Instant::now();
        let result = nemotron_backend::run(&audio, duration, nemotron_backend::model_path())
            .await
            .expect("Nemotron diarization");
        report("nemotron3-diarization", &audio, started.elapsed(), &result);
    }

    #[cfg(feature = "diarization-nemotron")]
    #[tokio::test]
    #[ignore = "requires public fixture audio, pinned Nemotron weights and explicit output directory"]
    async fn eval_nemotron_activity_probabilities() {
        use parakeet_rs::sortformer::{DiarizationConfig, Sortformer};
        let audio = eval_audio_path();
        let out = std::path::PathBuf::from(
            std::env::var("PLAINSONG_NEMOTRON_PROBE_OUT").expect("explicit output directory"),
        );
        let model = nemotron_backend::model_path();
        assert!(crate::download::verify_or_record_model_integrity(
            &model,
            Some("915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a")
        )
        .await
        .unwrap());
        let samples = crate::audio::utils::load_audio_file(&audio).unwrap();
        let duration = samples.len() as f64 / 16_000.0;
        let mut diarizer = Sortformer::new(&model).unwrap();
        let started = std::time::Instant::now();
        let (predictions, sample_count) = diarizer.predict_raw(samples, 16_000, 1).unwrap();
        let elapsed = started.elapsed();
        assert!(predictions
            .iter()
            .all(|p| p.is_finite() && (0.0..=1.0).contains(p)));
        std::fs::create_dir_all(&out).unwrap();
        let bytes: Vec<u8> = predictions.iter().flat_map(|p| p.to_le_bytes()).collect();
        std::fs::write(out.join("probabilities.f32"), bytes).unwrap();
        std::fs::write(
            out.join("metadata.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "audio": audio, "model": model, "frames": predictions.nrows(),
                "speakers": predictions.ncols(), "sampleCount": sample_count,
                "frameSeconds": 0.01, "durationSeconds": duration,
            }))
            .unwrap(),
        )
        .unwrap();
        for (onset, offset) in [(0.4, 0.4), (0.5, 0.4), (0.5, 0.5), (0.6, 0.6), (0.7, 0.7)] {
            let raw = Sortformer::post_process(
                &DiarizationConfig::custom(onset, offset),
                &predictions,
                sample_count,
            );
            let turns = nemotron_backend::raw_turns_from_sample_offsets(
                raw.iter().map(|s| (s.start, s.end, s.speaker_id)),
            );
            let normalized = turns::normalize_turns(&turns, duration);
            let result = DiarizationResult {
                segments: normalized.clone(),
                speakers: turns::speakers_for(&normalized),
                duration,
                method: DiarizationMethod::Model,
                cluster_centroids: HashMap::new(),
                word_activity: None,
            };
            report(
                &format!("nemotron/onset-{onset}/offset-{offset}"),
                &audio,
                elapsed,
                &result,
            );
        }
    }

    #[cfg(feature = "diarization-nemotron")]
    #[tokio::test]
    #[ignore = "requires measured provider rows, frozen public excerpts and pinned Nemotron weights"]
    async fn measured_words_to_speaker_passages_probe() {
        let root = std::path::PathBuf::from(
            std::env::var("PLAINSONG_QWEN17_EVAL_ROOT").expect("explicit fixture root"),
        );
        let model = nemotron_backend::model_path();
        assert!(crate::download::verify_or_record_model_integrity(
            &model,
            Some("915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a")
        )
        .await
        .unwrap());
        let data: Vec<serde_json::Value> = serde_json::from_slice(
            &std::fs::read(root.join("production-word-alignment.json")).unwrap(),
        )
        .unwrap();
        let mut receipts = Vec::new();
        for row in data {
            let file = row["file"].as_str().unwrap();
            let audio = root.join(file);
            let duration = get_audio_duration(&audio).await.unwrap();
            let diarization = nemotron_backend::run(&audio, duration, model.clone())
                .await
                .unwrap();
            let original: Vec<crate::models::TranscriptSegment> = row["segments"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, s)| crate::models::TranscriptSegment {
                    id: format!("{file}-word-{i}"),
                    start_time: s["startTime"].as_f64().unwrap(),
                    end_time: s["endTime"].as_f64().unwrap(),
                    text: s["text"].as_str().unwrap().into(),
                    speaker_id: None,
                    confidence: s["confidence"].as_f64().unwrap(),
                })
                .collect();
            let mut labeled = original.clone();
            DiarizationEngine::new().merge_with_transcript(&diarization, &mut labeled);
            assert_eq!(labeled.len(), original.len());
            assert!(
                labeled.iter().any(|word| word.speaker_id.is_some()),
                "fixture must produce actual speaker assignments"
            );
            for (after, before) in labeled.iter().zip(&original) {
                assert_eq!(after.id, before.id);
                assert_eq!(after.start_time, before.start_time);
                assert_eq!(after.end_time, before.end_time);
                assert_eq!(after.text, before.text);
                assert_eq!(after.confidence, before.confidence);
            }
            let passages = crate::analysis::group_transcript_segments_for_analysis(file, &labeled);
            for passage in &passages {
                let start = labeled
                    .iter()
                    .position(|word| word.id == passage.segment_id)
                    .unwrap();
                let count = passage.text.split_whitespace().count();
                let members = &labeled[start..start + count];
                assert!(members
                    .iter()
                    .all(|word| word.speaker_id == members[0].speaker_id));
                assert_eq!(passage.start_time, members[0].start_time);
                assert_eq!(passage.end_time, members.last().unwrap().end_time);
            }
            assert_eq!(
                passages
                    .iter()
                    .map(|p| p.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                original
                    .iter()
                    .map(|p| p.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            receipts.push(serde_json::json!({"file":file,"wordRows":labeled,"diarization":diarization,"passages":passages.iter().map(|p|serde_json::json!({"sourceId":p.segment_id,"start":p.start_time,"end":p.end_time,"text":p.text})).collect::<Vec<_>>(),"scope":"Model-assigned anonymous speaker groups; no verified identity or DER claim"}));
        }
        std::fs::write(
            root.join("measured-speaker-passages.json"),
            serde_json::to_vec_pretty(&receipts).unwrap(),
        )
        .unwrap();
    }
}
