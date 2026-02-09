//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

#![allow(dead_code)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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
}

impl DiarizationEngine {
    pub fn new() -> Self {
        Self {
            speakers: HashMap::new(),
        }
    }

    /// Check if real diarization is available
    pub fn is_real_available() -> bool {
        #[cfg(feature = "diarization")]
        {
            let extractor = embedder::SpeakerEmbeddingExtractor::new();
            extractor.map(|e| e.is_model_available()).unwrap_or(false)
        }
        #[cfg(not(feature = "diarization"))]
        {
            false
        }
    }

    /// Run diarization on audio file
    pub async fn diarize(
        &mut self,
        audio_path: &PathBuf,
        duration: f64,
    ) -> Result<DiarizationResult> {
        tracing::info!("Running speaker diarization for {:.1}s audio", duration);
        self.diarize_real(audio_path, duration).await
    }

    /// Real diarization using speaker embeddings and clustering
    async fn diarize_real(
        &mut self,
        audio_path: &PathBuf,
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

        let extractor = embedder::SpeakerEmbeddingExtractor::new()
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

        let clusterer = EmbeddingClusterer::new();
        let labels = clusterer.cluster(&embeddings);
        let smoothed = clusterer.smooth_segments(&segments, &labels);

        let mut speaker_segments = Vec::new();
        let mut unique_labels: Vec<usize> = labels.to_vec();
        unique_labels.sort();
        unique_labels.dedup();

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

        let speakers: Vec<Speaker> = self.speakers.values().cloned().collect();

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

    /// Merge diarization results with transcript segments
    pub fn merge_with_transcript(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut [crate::models::TranscriptSegment],
    ) {
        for transcript_seg in transcript_segments.iter_mut() {
            if let Some(speaker_seg) = diarization.segments.iter().find(|s| {
                s.start_time <= transcript_seg.end_time && s.end_time >= transcript_seg.start_time
            }) {
                transcript_seg.speaker_id = Some(speaker_seg.speaker_id.clone());
            }
        }
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
pub async fn run_diarization(audio_path: &PathBuf) -> Result<DiarizationResult> {
    if !DiarizationEngine::is_real_available() {
        return Err(anyhow::anyhow!(
            "Real diarization model is not available. Install/configure diarization models first."
        ));
    }

    let duration = get_audio_duration(audio_path).await?;
    let mut engine = DiarizationEngine::new();
    engine.diarize(audio_path, duration).await
}

/// Get audio file duration
async fn get_audio_duration(audio_path: &PathBuf) -> Result<f64> {
    use hound::WavReader;

    let reader = WavReader::open(audio_path)?;
    let duration = reader.duration() as f64 / reader.spec().sample_rate as f64;
    Ok(duration)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
