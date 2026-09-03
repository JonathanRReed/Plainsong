//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

mod embedder;
pub mod voiceprints;

pub use embedder::{generate_segments, EmbeddingClusterer};

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
}

/// Diarization method used
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationMethod {
    Embedding,
    Model,
}

/// Speaker diarization engine
pub struct DiarizationEngine {
    speakers: HashMap<String, Speaker>,
    model_id: String,
}

impl DiarizationEngine {
    pub fn new() -> Self {
        Self {
            speakers: HashMap::new(),
            model_id: "ecapa_tdnn_speaker".to_string(),
        }
    }

    /// Create an engine that uses a specific diarization model.
    pub fn with_model(model_id: &str) -> Self {
        Self {
            speakers: HashMap::new(),
            model_id: model_id.to_string(),
        }
    }

    /// Check if real diarization is available
    pub fn is_real_available() -> bool {
        #[cfg(feature = "diarization")]
        {
            let extractor = embedder::SpeakerEmbeddingExtractor::new();
            match &extractor {
                Ok(e) => e.is_model_available(),
                Err(err) => {
                    tracing::warn!("Failed to create embedding extractor: {}", err);
                    false
                }
            }
        }
        #[cfg(not(feature = "diarization"))]
        {
            tracing::warn!("Diarization feature not compiled in");
            false
        }
    }

    /// Run diarization on audio file
    pub async fn diarize(&mut self, audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
        tracing::info!("Running speaker diarization for {:.1}s audio", duration);
        self.diarize_real(audio_path, duration).await
    }

    /// Real diarization using speaker embeddings and clustering
    async fn diarize_real(
        &mut self,
        audio_path: &Path,
        duration: f64,
    ) -> Result<DiarizationResult> {
        let segments = generate_segments(duration, 2.0, 1.0);
        if segments.is_empty() {
            return Ok(DiarizationResult {
                segments: Vec::new(),
                speakers: Vec::new(),
                duration,
                method: DiarizationMethod::Embedding,
                cluster_centroids: HashMap::new(),
            });
        }

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(&self.model_id)
            .context("Failed to create embedding extractor")?;

        #[cfg(feature = "diarization")]
        let embeddings: Vec<(f64, f64, Array1<f32>)> =
            extractor.extract_embeddings(audio_path, &segments).await?;

        #[cfg(not(feature = "diarization"))]
        let embeddings = extractor.extract_embeddings(audio_path, &segments).await?;

        if embeddings.is_empty() {
            return Err(anyhow::anyhow!(
                "Diarization model returned no embeddings; cannot infer speakers."
            ));
        }

        let segments_for_clustering: Vec<(f64, f64)> = embeddings
            .iter()
            .map(|(start_time, end_time, _)| (*start_time, *end_time))
            .collect();
        // The per-segment embeddings die with this closure. Only the per
        // cluster mean survives, and only in memory: whether any of it is
        // written down is the caller's decision, gated on the opt-in setting.
        let (smoothed, label_centroids) = tokio::task::spawn_blocking(move || {
            let clusterer = EmbeddingClusterer::new();
            let labels = clusterer.cluster(&embeddings);
            let mut grouped: HashMap<usize, Vec<Vec<f32>>> = HashMap::new();
            for (label, (_, _, embedding)) in labels.iter().zip(embeddings.iter()) {
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
            (
                clusterer.smooth_segments(&segments_for_clustering, &labels),
                centroids,
            )
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
        })
    }

    /// Merge diarization results with transcript segments.
    /// Splits transcript segments at diarization boundaries while keeping any
    /// uncovered speech explicitly anonymous (`speaker_id: None`).
    pub fn merge_with_transcript(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
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
        let colors = [
            "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899",
        ];
        Speaker {
            id: id.to_string(),
            name: Some(format!("Speaker {}", index + 1)),
            color: colors[index % colors.len()].to_string(),
            sample_count: 0,
        }
    }
}

impl Default for DiarizationEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Run diarization with strict real-model requirement.
pub async fn run_diarization(audio_path: &Path) -> Result<DiarizationResult> {
    run_diarization_with_model(audio_path, "ecapa_tdnn_speaker").await
}

/// Run diarization with a specific speaker embedding model.
pub async fn run_diarization_with_model(
    audio_path: &Path,
    model_id: &str,
) -> Result<DiarizationResult> {
    if !DiarizationEngine::is_real_available() {
        return Err(anyhow::anyhow!(
            "Real diarization model is not available. Install/configure diarization models first."
        ));
    }

    let duration = get_audio_duration(audio_path).await?;
    let mut engine = DiarizationEngine::with_model(model_id);
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
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_diarization_requires_real_model() {
        if DiarizationEngine::is_real_available() {
            return;
        }

        let result = run_diarization(&PathBuf::from("test.wav")).await;
        assert!(result.is_err());
        let message = result.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(message.contains("Real diarization model is not available"));
    }

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
}

/// Opt-in threshold calibration for [`voiceprints`].
///
/// Not a gate test and not run by `cargo test`: it needs the four speaker
/// embedding ONNX models on disk and a directory of fixture WAVs, and it
/// exists to produce the numbers in
/// `artifacts/qa/voiceprint-calibration-2026-09-02.md`. It is kept in the tree
/// rather than in a scratch script so the thresholds shipped in
/// `voiceprints.rs` can be re-derived by anyone, with the app's own embedder
/// rather than a re-implementation of it.
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
        let sha = crate::download::diarization_model_sha256_for_tests(model_id)
            .expect("every calibrated model must be a known diarization model");
        crate::download::record_model_integrity_receipt_for_tests(&model_path, sha)
            .await
            .expect("the staged model file must match this build's pinned digest");

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(model_id)
            .expect("extractor construction");
        assert!(
            extractor.is_model_available(),
            "{model_id}: staged model did not pass integrity verification"
        );

        let mut by_voice: BTreeMap<String, Vec<Vec<f32>>> = BTreeMap::new();
        for fixture in fixtures {
            let voice = voice_of(&fixture.file_name().unwrap().to_string_lossy())
                .expect("fixture names are <voice>_<index>.wav");
            let duration = super::get_audio_duration(fixture)
                .await
                .expect("fixture duration");
            let segments = generate_segments(duration, 2.0, 1.0);
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
            let sha = crate::download::diarization_model_sha256_for_tests(model_id).unwrap();
            crate::download::record_model_integrity_receipt_for_tests(&model_path, sha)
                .await
                .expect("integrity receipt");

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
