//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

#![allow(dead_code)]

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
            match &extractor {
                Ok(e) => {
                    let available = e.is_model_available();
                    available
                }
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
    /// Splits transcript segments at diarization boundaries to assign correct speakers
    pub fn merge_with_transcript(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
    ) {
        println!("[NAUTILUS] Merging {} diarization segments with {} transcript segments", 
            diarization.segments.len(), transcript_segments.len());
        
        if diarization.segments.is_empty() || transcript_segments.is_empty() {
            return;
        }
        
        // Sort diarization segments by start time
        let mut sorted_diarization = diarization.segments.clone();
        sorted_diarization.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap_or(std::cmp::Ordering::Equal));
        
        // Build new segments list by splitting transcript at diarization boundaries
        let mut new_segments: Vec<crate::models::TranscriptSegment> = Vec::new();
        
        for ts in transcript_segments.iter() {
            println!("[NAUTILUS] Processing transcript segment {}-{}s", ts.start_time, ts.end_time);
            
            // Find all diarization segments that overlap with this transcript segment
            let mut split_points: Vec<(f64, String)> = Vec::new();
            
            for ds in &sorted_diarization {
                // Check if diarization segment overlaps with transcript segment
                if ds.start_time < ts.end_time && ds.end_time > ts.start_time {
                    // Add split point at diarization start (clamped to transcript bounds)
                    let split_start = ds.start_time.max(ts.start_time);
                    if split_start > ts.start_time && !split_points.iter().any(|(t, _)| (*t - split_start).abs() < 0.001) {
                        split_points.push((split_start, ds.speaker_id.clone()));
                    }
                    // Add split point at diarization end (clamped to transcript bounds)
                    let split_end = ds.end_time.min(ts.end_time);
                    if split_end < ts.end_time && !split_points.iter().any(|(t, _)| (*t - split_end).abs() < 0.001) {
                        split_points.push((split_end, ds.speaker_id.clone()));
                    }
                }
            }
            
            // Sort split points by time
            split_points.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            
            println!("[NAUTILUS] Split points for segment: {:?}", split_points.iter().map(|(t, _)| t).collect::<Vec<_>>());
            
            // Split text by word boundaries proportional to time
            let words: Vec<&str> = ts.text.split_whitespace().collect();
            let total_duration = ts.end_time - ts.start_time;
            let mut current_start = ts.start_time;
            
            // Build time boundaries list: [(start, end, speaker_id)]
            let mut boundaries: Vec<(f64, f64, String)> = Vec::new();
            let mut prev_time = ts.start_time;
            for (split_time, _) in split_points.iter() {
                let speaker = sorted_diarization.iter()
                    .find(|ds| ds.start_time <= prev_time && ds.end_time > prev_time)
                    .map(|ds| ds.speaker_id.clone())
                    .unwrap_or_else(|| "S1".to_string());
                boundaries.push((prev_time, *split_time, speaker));
                prev_time = *split_time;
            }
            // Final boundary
            let final_speaker = sorted_diarization.iter()
                .find(|ds| ds.start_time <= prev_time && ds.end_time > prev_time)
                .map(|ds| ds.speaker_id.clone())
                .unwrap_or_else(|| "S1".to_string());
            boundaries.push((prev_time, ts.end_time, final_speaker));
            
            // Assign words to boundaries by proportion
            let total_words = words.len();
            for (seg_start, seg_end, speaker) in &boundaries {
                if *seg_end <= *seg_start || total_duration <= 0.0 { continue; }
                let word_start = ((seg_start - ts.start_time) / total_duration * total_words as f64).round() as usize;
                let word_end = ((seg_end - ts.start_time) / total_duration * total_words as f64).round() as usize;
                let word_start = word_start.min(total_words);
                let word_end = word_end.min(total_words);
                if word_start >= word_end { continue; }
                
                let sub_text = words[word_start..word_end].join(" ");
                if sub_text.trim().is_empty() { continue; }
                
                println!("[NAUTILUS] Creating sub-segment {}-{}s speaker={} text='{}'",
                    seg_start, seg_end, speaker, &sub_text.chars().take(30).collect::<String>());
                
                new_segments.push(crate::models::TranscriptSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: *seg_start,
                    end_time: *seg_end,
                    text: sub_text,
                    speaker_id: Some(speaker.clone()),
                    confidence: ts.confidence,
                });
                current_start = *seg_end;
            }
            let _ = current_start;
        }
        
        // Replace original segments with split segments
        *transcript_segments = new_segments;
        
        println!("[NAUTILUS] Merge complete: {} segments after splitting", transcript_segments.len());
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
async fn get_audio_duration(audio_path: &Path) -> Result<f64> {
    use hound::WavReader;

    let reader = WavReader::open(audio_path)?;
    let duration = reader.duration() as f64 / reader.spec().sample_rate as f64;
    Ok(duration)
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
}
