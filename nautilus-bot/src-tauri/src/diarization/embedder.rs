//! Real speaker diarization using ONNX speaker embedding models
//!
//! Uses a speaker embedding model (e.g., ResNet, ECAPA-TDNN) via ONNX Runtime
//! followed by spectral clustering to identify unique speakers.

use anyhow::Result;
#[cfg(feature = "diarization")]
use anyhow::{anyhow, Context};
use ndarray::{Array1, Array2};
#[cfg(feature = "diarization")]
use ndarray::{ArrayViewD, IxDyn};
#[cfg(feature = "diarization")]
use ort::{
    session::{builder::GraphOptimizationLevel, Session, SessionOutputs},
    value::{Tensor, ValueType},
};
use std::path::PathBuf;

// Re-export Array1 for use in mod.rs

/// Speaker embedding extractor using ONNX
#[cfg(feature = "diarization")]
pub struct SpeakerEmbeddingExtractor {
    model_path: PathBuf,
    sample_rate: u32,
}

#[cfg(feature = "diarization")]
impl SpeakerEmbeddingExtractor {
    /// Create a new embedding extractor
    pub fn new() -> Result<Self> {
        let models_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nautilus")
            .join("models")
            .join("diarization");

        // ECAPA-TDNN based speaker embedding model (lightweight ~14MB)
        let model_path = models_dir.join("ecapa_tdnn_speaker.onnx");

        Ok(Self {
            model_path,
            sample_rate: 16000,
        })
    }

    /// Check if the embedding model is available
    pub fn is_model_available(&self) -> bool {
        self.model_path.exists()
    }

    /// Extract embeddings from audio segments
    ///
    /// Returns a vector of (start_time, end_time, embedding) tuples
    pub async fn extract_embeddings(
        &self,
        audio_path: &PathBuf,
        segments: &[(f64, f64)], // (start_sec, end_sec) chunks
    ) -> Result<Vec<(f64, f64, Array1<f32>)>> {
        // Load audio
        let samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for diarization")?;

        let model_path = self.model_path.clone();
        let segments = segments.to_vec();
        let sample_rate = self.sample_rate;

        tokio::task::spawn_blocking(move || -> Result<Vec<(f64, f64, Array1<f32>)>> {
            let mut session = load_embedding_session(&model_path)?;
            let mut embeddings = Vec::new();

            for (start_sec, end_sec) in segments {
                let start_sample = (start_sec * sample_rate as f64) as usize;
                let end_sample = (end_sec * sample_rate as f64) as usize;

                if start_sample >= samples.len() || end_sample > samples.len() {
                    continue;
                }

                let segment_samples = &samples[start_sample..end_sample];
                if segment_samples.is_empty() {
                    continue;
                }

                match run_embedding_inference(&mut session, segment_samples) {
                    Ok(embedding) => embeddings.push((start_sec, end_sec, embedding)),
                    Err(e) => tracing::warn!(
                        "Failed to extract embedding for segment {}-{}: {}",
                        start_sec,
                        end_sec,
                        e
                    ),
                }
            }

            Ok(embeddings)
        })
        .await
        .context("Failed to join diarization inference task")?
    }
}

#[cfg(feature = "diarization")]
fn load_embedding_session(model_path: &PathBuf) -> Result<Session> {
    if !model_path.exists() {
        return Err(anyhow!(
            "Diarization model file not found: {}",
            model_path.display()
        ));
    }

    Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .context("Failed to configure ONNX optimization level")?
        .with_intra_threads(1)
        .context("Failed to configure ONNX intra-op threads")?
        .commit_from_file(model_path)
        .with_context(|| {
            format!(
                "Failed to load diarization model from {}",
                model_path.display()
            )
        })
}

#[cfg(feature = "diarization")]
fn run_embedding_inference(session: &mut Session, samples: &[f32]) -> Result<Array1<f32>> {
    let input = session
        .inputs()
        .first()
        .ok_or_else(|| anyhow!("Diarization model has no input tensors"))?;
    let input_shape = infer_input_shape(input.dtype(), samples.len())?;

    // This implementation supports raw waveform models only (single waveform channel).
    let feature_multiplier = input_shape[..input_shape.len() - 1]
        .iter()
        .copied()
        .product::<usize>();
    if feature_multiplier != 1 {
        return Err(anyhow!(
            "Unsupported diarization input shape {:?}; expected raw waveform input",
            input_shape
        ));
    }

    let target_samples = *input_shape
        .last()
        .ok_or_else(|| anyhow!("Invalid diarization input shape"))?;
    let prepared = pad_or_trim(samples, target_samples);
    let input_array = ndarray::Array::from_shape_vec(IxDyn(&input_shape), prepared)
        .context("Failed to shape diarization input tensor")?;

    let input_tensor = Tensor::from_array(input_array)
        .context("Failed to create ONNX input tensor for diarization")?;
    let outputs = session
        .run(ort::inputs![input_tensor])
        .context("ONNX diarization model inference failed")?;

    extract_embedding_from_outputs(&outputs)
}

#[cfg(feature = "diarization")]
fn infer_input_shape(dtype: &ValueType, sample_len: usize) -> Result<Vec<usize>> {
    let ValueType::Tensor { shape, .. } = dtype else {
        return Err(anyhow!("Diarization model input is not a tensor"));
    };

    let dims: Vec<i64> = shape.iter().copied().collect();
    if dims.is_empty() {
        return Err(anyhow!("Diarization model input has empty shape"));
    }
    if dims.len() > 3 {
        return Err(anyhow!(
            "Unsupported diarization input rank {} (shape {:?})",
            dims.len(),
            dims
        ));
    }

    let last = dims.len() - 1;
    let mut resolved = Vec::with_capacity(dims.len());
    for (idx, dim) in dims.iter().enumerate() {
        if *dim > 0 {
            resolved.push(*dim as usize);
        } else if idx == last {
            resolved.push(sample_len.max(1));
        } else {
            resolved.push(1);
        }
    }
    Ok(resolved)
}

#[cfg(feature = "diarization")]
fn pad_or_trim(samples: &[f32], target_len: usize) -> Vec<f32> {
    if samples.len() == target_len {
        return samples.to_vec();
    }
    if samples.len() > target_len {
        return samples[..target_len].to_vec();
    }

    let mut out = Vec::with_capacity(target_len);
    out.extend_from_slice(samples);
    out.resize(target_len, 0.0);
    out
}

#[cfg(feature = "diarization")]
fn extract_embedding_from_outputs(outputs: &SessionOutputs<'_>) -> Result<Array1<f32>> {
    for (_, output) in outputs.iter() {
        if let Ok(array) = output.try_extract_array::<f32>() {
            return finalize_embedding(array);
        }
        if let Ok(array) = output.try_extract_array::<f64>() {
            let converted = array.mapv(|v| v as f32);
            return finalize_embedding(converted.view());
        }
    }

    Err(anyhow!(
        "Diarization model output does not contain a float tensor embedding"
    ))
}

#[cfg(feature = "diarization")]
fn finalize_embedding(array: ArrayViewD<'_, f32>) -> Result<Array1<f32>> {
    let shape = array.shape().to_vec();
    let flat: Vec<f32> = array.iter().copied().collect();
    if flat.is_empty() {
        return Err(anyhow!("Diarization model returned an empty embedding"));
    }

    let embedding = if shape.len() <= 1 {
        flat
    } else {
        let embedding_len = *shape
            .last()
            .ok_or_else(|| anyhow!("Invalid diarization output shape"))?;
        if embedding_len == 0 {
            return Err(anyhow!("Diarization model returned zero-length embedding"));
        }
        if flat.len() % embedding_len != 0 {
            flat
        } else {
            let chunks = flat.len() / embedding_len;
            let mut pooled = vec![0.0f32; embedding_len];
            for chunk in flat.chunks(embedding_len) {
                for (idx, value) in chunk.iter().enumerate() {
                    pooled[idx] += *value;
                }
            }
            if chunks > 1 {
                for value in &mut pooled {
                    *value /= chunks as f32;
                }
            }
            pooled
        }
    };

    let norm = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= 1e-6 {
        return Err(anyhow!("Diarization embedding norm is too close to zero"));
    }

    let normalized: Vec<f32> = embedding.into_iter().map(|v| v / norm).collect();
    Ok(Array1::from(normalized))
}

#[cfg(not(feature = "diarization"))]
pub struct SpeakerEmbeddingExtractor;

#[cfg(not(feature = "diarization"))]
impl SpeakerEmbeddingExtractor {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }

    pub fn is_model_available(&self) -> bool {
        false
    }

    pub async fn extract_embeddings(
        &self,
        _audio_path: &PathBuf,
        _segments: &[(f64, f64)],
    ) -> Result<Vec<(f64, f64, Array1<f32>)>> {
        Ok(Vec::new())
    }
}

/// Cluster embeddings to identify unique speakers
pub struct EmbeddingClusterer {
    /// Threshold for clustering (cosine similarity)
    threshold: f32,
    /// Minimum segment duration (seconds)
    min_segment_duration: f64,
}

impl EmbeddingClusterer {
    pub fn new() -> Self {
        Self {
            threshold: 0.25, // Cosine distance threshold (0.25 = ~97% similarity)
            min_segment_duration: 1.0,
        }
    }

    /// Set clustering threshold
    pub fn with_threshold(mut self, threshold: f32) -> Self {
        self.threshold = threshold;
        self
    }

    /// Cluster embeddings using agglomerative clustering
    ///
    /// Returns speaker assignments for each embedding
    pub fn cluster(&self, embeddings: &[(f64, f64, Array1<f32>)]) -> Vec<usize> {
        if embeddings.is_empty() {
            return Vec::new();
        }

        if embeddings.len() == 1 {
            return vec![0];
        }

        // Compute pairwise distances
        let n = embeddings.len();
        let mut distances = Array2::zeros((n, n));

        for i in 0..n {
            for j in (i + 1)..n {
                let dist = cosine_distance(&embeddings[i].2, &embeddings[j].2);
                distances[[i, j]] = dist;
                distances[[j, i]] = dist;
            }
        }

        // Agglomerative clustering
        self.agglomerative_cluster(&distances, n)
    }

    /// Agglomerative clustering with single linkage
    fn agglomerative_cluster(&self, distances: &Array2<f32>, n: usize) -> Vec<usize> {
        // Each point starts as its own cluster
        let mut cluster_labels: Vec<usize> = (0..n).collect();
        let mut cluster_count = n;

        // Track which clusters are active
        let mut active: Vec<bool> = vec![true; n];

        // Merge closest clusters until threshold reached
        loop {
            // Find closest pair of clusters
            let mut min_dist = f32::INFINITY;
            let mut closest_pair: Option<(usize, usize)> = None;

            for i in 0..n {
                if !active[i] {
                    continue;
                }
                for j in (i + 1)..n {
                    if !active[j] {
                        continue;
                    }

                    let dist = distances[[i, j]];
                    if dist < min_dist {
                        min_dist = dist;
                        closest_pair = Some((i, j));
                    }
                }
            }

            // Stop if no pair found or distance exceeds threshold
            if closest_pair.is_none() || min_dist > self.threshold {
                break;
            }

            let Some((i, j)) = closest_pair else {
                break;
            };

            // Merge cluster j into i
            for label in cluster_labels.iter_mut().take(n) {
                if *label == j {
                    *label = i;
                }
            }

            active[j] = false;
            cluster_count -= 1;

            if cluster_count <= 1 {
                break;
            }
        }

        // Renumber clusters to be contiguous
        let mut label_map: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        let mut next_label = 0;

        for label in &cluster_labels {
            if !label_map.contains_key(label) {
                label_map.insert(*label, next_label);
                next_label += 1;
            }
        }

        cluster_labels
            .into_iter()
            .map(|l| label_map.get(&l).copied().unwrap_or_default())
            .collect()
    }

    /// Refine segments using Viterbi-like smoothing
    pub fn smooth_segments(
        &self,
        segments: &[(f64, f64)],
        labels: &[usize],
    ) -> Vec<(f64, f64, usize)> {
        let mut smoothed = Vec::new();
        let mut i = 0;

        while i < segments.len() {
            let (start, end) = segments[i];
            let label = labels[i];
            let mut current_end = end;

            // Merge consecutive segments with same label
            let mut j = i + 1;
            while j < segments.len() && labels[j] == label {
                current_end = segments[j].1;
                j += 1;
            }

            // Only keep segments above minimum duration
            if current_end - start >= self.min_segment_duration {
                smoothed.push((start, current_end, label));
            }

            i = j;
        }

        smoothed
    }
}

impl Default for EmbeddingClusterer {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute cosine distance between two vectors
fn cosine_distance(a: &Array1<f32>, b: &Array1<f32>) -> f32 {
    let dot_product = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f32>();
    let norm_a = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 1.0;
    }

    // Convert similarity to distance
    let similarity = dot_product / (norm_a * norm_b);
    (1.0 - similarity).max(0.0)
}

/// Generate overlapping segments for embedding extraction
pub fn generate_segments(duration: f64, segment_duration: f64, overlap: f64) -> Vec<(f64, f64)> {
    let mut segments = Vec::new();
    let mut start = 0.0;
    let step = segment_duration - overlap;

    while start < duration {
        let end = (start + segment_duration).min(duration);
        if end - start >= 1.0 {
            // Minimum 1 second
            segments.push((start, end));
        }
        start += step;

        if end >= duration {
            break;
        }
    }

    segments
}
