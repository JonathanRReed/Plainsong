//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

mod embedder;

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
        let smoothed = tokio::task::spawn_blocking(move || {
            let clusterer = EmbeddingClusterer::new();
            let labels = clusterer.cluster(&embeddings);
            clusterer.smooth_segments(&segments_for_clustering, &labels)
        })
        .await
        .context("Failed to join diarization clustering task")?;

        let mut speaker_segments = Vec::new();
        for (start, end, label) in smoothed {
            let speaker_id = format!("S{}", label + 1);
            if !self.speakers.contains_key(&speaker_id) {
                self.speakers
                    .insert(speaker_id.clone(), self.create_speaker(&speaker_id, label));
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
