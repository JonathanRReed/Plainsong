//! Real speaker diarization using ONNX speaker embedding models
//!
//! Uses a speaker embedding model (e.g., ResNet, ECAPA-TDNN) via ONNX Runtime
//! followed by spectral clustering to identify unique speakers.
#![allow(clippy::needless_range_loop)]

use anyhow::Result;
#[cfg(feature = "diarization")]
use anyhow::{anyhow, Context};
use ndarray::Array1;
#[cfg(feature = "diarization")]
use ndarray::{ArrayViewD, IxDyn};
#[cfg(feature = "diarization")]
use ort::{
    session::{Session, SessionOutputs},
    value::{Tensor, ValueType},
};
#[cfg(feature = "diarization")]
use rustfft::FftPlanner;
#[cfg(feature = "diarization")]
use std::f32::consts::PI;
use std::path::Path;
#[cfg(feature = "diarization")]
use std::path::PathBuf;

// Re-export Array1 for use in mod.rs

// ── The segmentation everything downstream was measured at ───────────────
//
// Two callers must not drift: `diarize_real` produces the embeddings the
// product compares, and the voiceprint calibration harness measures the same
// object to pick the thresholds in `voiceprints.rs`. They were literals in
// both places, which is exactly the kind of duplication that goes quietly
// wrong — and it is not a harmless number. CAM++ separates speakers cleanly
// at 2-second windows and not at all at 8-second ones, so changing these
// invalidates every threshold in `voiceprints.rs` until they are re-measured.
// Receipt: `artifacts/qa/voiceprint-recalibration-2026-09-03.md`.

/// Length of one embedding window, in seconds.
pub const SEGMENT_SECONDS: f64 = 2.0;
/// How much each window overlaps the previous one, in seconds — a 1-second
/// hop at the 2-second window above.
pub const SEGMENT_OVERLAP_SECONDS: f64 = 1.0;
/// The shortest window worth embedding. The tail of a recording is clipped to
/// what is left, and below this there is not enough voice to describe.
pub const MIN_SEGMENT_SECONDS: f64 = 1.0;

/// Sample rate every diarization window is resampled to before features.
pub const EMBEDDING_SAMPLE_RATE: usize = 16000;

/// Speaker embedding extractor using ONNX
#[cfg(feature = "diarization")]
pub struct SpeakerEmbeddingExtractor {
    model_path: PathBuf,
    model_id: String,
    sample_rate: u32,
}

#[cfg(feature = "diarization")]
impl SpeakerEmbeddingExtractor {
    /// Create an embedding extractor with a specific model
    ///
    /// The id is normalised through [`super::embedding_model_artifact_id`], so
    /// the file this opens and the pin its integrity is checked against are
    /// always the same model. They were not: an id outside the known four
    /// loaded ECAPA's file but verified it against an unknown id's pin, which
    /// no lookup could satisfy, so the extractor refused a model it had in
    /// fact found.
    pub fn with_model(model_id: &str) -> Result<Self> {
        let artifact_id = super::embedding_model_artifact_id(model_id);
        let model_path = super::diarization_models_dir().join(format!("{artifact_id}.onnx"));

        tracing::info!("Diarization model path: {:?}", model_path);
        tracing::info!("Model exists: {}", model_path.exists());

        Ok(Self {
            model_path,
            model_id: artifact_id.to_string(),
            sample_rate: 16000,
        })
    }

    /// Check if the embedding model is available
    pub fn is_model_available(&self) -> bool {
        let exists = crate::download::is_diarization_model_artifact_trusted(
            &self.model_id,
            &self.model_path,
        );
        tracing::info!(
            "is_model_available: path={:?}, exists={}",
            self.model_path,
            exists
        );
        exists
    }

    /// Extract embeddings from audio segments
    ///
    /// Returns a vector of (start_time, end_time, embedding) tuples
    pub async fn extract_embeddings(
        &self,
        audio_path: &Path,
        segments: &[(f64, f64)], // (start_sec, end_sec) chunks
    ) -> Result<Vec<(f64, f64, Array1<f32>)>> {
        if !self.is_model_available() {
            return Err(anyhow!(
                "Diarization model '{}' has not passed Plainsong integrity verification. Re-download it from Settings.",
                self.model_id
            ));
        }
        let audio_path = audio_path.to_path_buf();
        let model_path = self.model_path.clone();
        let model_id = self.model_id.clone();
        let segments = segments.to_vec();
        let sample_rate = self.sample_rate;

        tokio::task::spawn_blocking(move || -> Result<Vec<(f64, f64, Array1<f32>)>> {
            // WAV loading, channel conversion, and resampling are CPU/blocking work.
            let samples = crate::audio::utils::load_audio_file(&audio_path)
                .context("Failed to load audio for diarization")?;
            let mut session = load_embedding_session(&model_path, &model_id)?;
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

                match run_embedding_inference(&mut session, segment_samples, &model_id) {
                    Ok(embedding) => {
                        // Log embedding stats for debugging
                        let norm: f32 = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
                        let mean: f32 = embedding.iter().sum::<f32>() / embedding.len() as f32;
                        let min_val = embedding.iter().cloned().fold(f32::INFINITY, f32::min);
                        let max_val = embedding.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                        tracing::debug!(
                            "Embedding {}-{}s: len={}, norm={:.4}, mean={:.4}, min={:.4}, max={:.4}",
                            start_sec, end_sec, embedding.len(), norm, mean, min_val, max_val
                        );
                        embeddings.push((start_sec, end_sec, embedding))
                    },
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
pub(super) fn load_embedding_session(model_path: &Path, artifact_id: &str) -> Result<Session> {
    if !model_path.exists() {
        return Err(anyhow!(
            "Diarization model file not found: {}",
            model_path.display()
        ));
    }

    tracing::debug!("Loading diarization model from: {}", model_path.display());

    // Per-model graph optimization level. CAM++ is built without it because the
    // ONNX Runtime 1.28 that `ort` 2.0.0-rc.13 links rewrites its 52 no-op
    // `Pad` + `AveragePool(ceil_mode=1)` pairs into pools with
    // `count_include_pad=1` and then counts the ceil-mode padding, which
    // corrupts the embedding at every input length whose pooled length is not a
    // multiple of 100 -- including the 198-frame window this app feeds.
    // Measured in artifacts/qa/campplus-divergence-2026-09-02.md.
    let level = super::embedding_window::graph_optimization_level_for(artifact_id);
    let session = crate::ort_utils::build_session_with(model_path, move |builder| {
        builder
            .with_intra_threads(1)
            .map_err(|error| anyhow!("Failed to configure ONNX intra-op threads: {}", error))?
            .with_optimization_level(level)
            .map_err(|error| anyhow!("Failed to set ONNX graph optimization level: {}", error))
    })?;

    // Log model input/output info
    tracing::debug!(
        "Model loaded. Inputs: {} outputs: {}",
        session.inputs().len(),
        session.outputs().len()
    );
    for (i, input) in session.inputs().iter().enumerate() {
        tracing::debug!(
            "Input {}: name={}, shape={:?}",
            i,
            input.name(),
            input.dtype()
        );
    }
    for (i, output) in session.outputs().iter().enumerate() {
        tracing::debug!(
            "Output {}: name={}, shape={:?}",
            i,
            output.name(),
            output.dtype()
        );
    }

    Ok(session)
}

#[cfg(feature = "diarization")]
pub(super) fn run_embedding_inference(
    session: &mut Session,
    samples: &[f32],
    artifact_id: &str,
) -> Result<Array1<f32>> {
    let input = session
        .inputs()
        .first()
        .ok_or_else(|| anyhow!("Diarization model has no input tensors"))?;

    // Check if model expects FBank features (shape [..., 80])
    let ValueType::Tensor { shape, .. } = input.dtype() else {
        return Err(anyhow!("Diarization model input is not a tensor"));
    };
    let dims: Vec<i64> = shape.iter().copied().collect();

    // Last dimension should be 80 for FBank features
    let expects_fbank = dims.last().copied().unwrap_or(-1) == 80;

    if expects_fbank {
        // Compute FBank features
        let fbank_features = compute_fbank_features(samples, 16000, 80)?;

        let num_frames = fbank_features.len() / 80;
        if num_frames == 0 {
            return Err(anyhow!("FBank front end produced no frames"));
        }

        // The thresholds in `voiceprints.rs` were measured on tensors this
        // shape, produced by the windows above. A window outside the verified
        // range is a different object under the same name, and comparing it
        // with a stored centroid would be arithmetic with no calibration
        // behind it. A warning and a debug assertion rather than an error:
        // this is a bug in a caller, and a meeting should not fail for it.
        let verified = verified_fbank_frame_range();
        if !verified.contains(&num_frames) {
            tracing::warn!(
                "Diarization window produced {} FBank frames, outside the verified {}-{} \
                 (from {}-{}s windows). Voiceprint thresholds were not calibrated here.",
                num_frames,
                verified.start(),
                verified.end(),
                MIN_SEGMENT_SECONDS,
                SEGMENT_SECONDS,
            );
        }
        debug_assert!(
            verified.contains(&num_frames),
            "diarization window produced {num_frames} FBank frames, outside the verified \
             {}-{}",
            verified.start(),
            verified.end(),
        );

        tracing::debug!("Feeding FBank features: {} frames", num_frames);

        // Never feed a model more frames in one shot than were verified for it.
        // CAM++ is wrong under this ONNX Runtime at lengths whose pooled length
        // is not a multiple of 100, and the error grows with the size of the
        // partial pooling window, so a long input is split into near-equal
        // windows and the per-window embeddings averaged -- the same thing the
        // clusterer does across segments. Today nothing reaches this branch
        // (`generate_segments(duration, 2.0, 1.0)` caps a window at 198
        // frames); it exists so a future change to the segmentation cannot
        // silently walk past what was measured.
        let window = super::embedding_window::verified_frame_window(artifact_id)
            .unwrap_or(usize::MAX)
            .max(1);
        let plan = super::embedding_window::split_into_windows(num_frames, window);
        if plan.len() > 1 {
            tracing::warn!(
                "Diarization model '{}' was handed {} frames but is only verified to {}; \
                 splitting into {} windows and averaging.",
                artifact_id,
                num_frames,
                window,
                plan.len()
            );
        }

        let mut pooled: Option<Array1<f32>> = None;
        for (start, len) in &plan {
            let slice = fbank_features[start * 80..(start + len) * 80].to_vec();
            let input_array = ndarray::Array::from_shape_vec(IxDyn(&[1, *len, 80]), slice)
                .context("Failed to shape FBank input tensor")?;
            let input_tensor = Tensor::from_array(input_array)
                .context("Failed to create ONNX input tensor for FBank")?;
            let outputs = session
                .run(ort::inputs![input_tensor])
                .context("ONNX diarization model inference failed")?;
            let embedding = extract_embedding_from_outputs(&outputs)?;
            pooled = Some(match pooled {
                None => embedding,
                Some(mut acc) => {
                    if acc.len() != embedding.len() {
                        return Err(anyhow!(
                            "Diarization model returned embeddings of different lengths \
                             ({} then {}) across split windows",
                            acc.len(),
                            embedding.len()
                        ));
                    }
                    acc += &embedding;
                    acc
                }
            });
        }

        let summed = pooled.ok_or_else(|| anyhow!("Diarization produced no embedding windows"))?;
        // Each window's embedding is already L2-normalized by
        // `finalize_embedding`; re-normalize the sum so the mean of the windows
        // is a unit vector again.
        let norm = summed.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm <= 1e-6 {
            return Err(anyhow!("Diarization embedding norm is too close to zero"));
        }
        Ok(summed.mapv(|value| value / norm))
    } else {
        // Fallback for raw waveform models
        let input_shape = infer_input_shape(input.dtype(), samples.len())?;
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
}

/// Compute log Mel filterbank features from audio samples
#[cfg(feature = "diarization")]
pub(super) fn compute_fbank_features(
    samples: &[f32],
    sample_rate: u32,
    num_mel_bins: usize,
) -> Result<Vec<f32>> {
    // Parameters for FBank extraction
    let frame_size = FBANK_FRAME_SIZE;
    let frame_shift = FBANK_FRAME_SHIFT;
    let fft_size = 512;

    // Apply pre-emphasis
    let pre_emphasis = 0.97;
    let mut emphasized: Vec<f32> = Vec::with_capacity(samples.len());
    emphasized.push(samples[0]);
    for i in 1..samples.len() {
        emphasized.push(samples[i] - pre_emphasis * samples[i - 1]);
    }

    // Compute number of frames
    let num_frames = if emphasized.len() < frame_size {
        1
    } else {
        (emphasized.len() - frame_size) / frame_shift + 1
    };

    // Create Mel filterbank
    let mel_bank = create_mel_filterbank(fft_size, sample_rate as f32, num_mel_bins);

    let mut all_features = Vec::with_capacity(num_frames * num_mel_bins);

    for frame_idx in 0..num_frames {
        let start = frame_idx * frame_shift;
        let end = (start + frame_size).min(emphasized.len());

        // Extract frame and apply Hamming window
        let mut frame = vec![0.0f64; fft_size];
        for i in 0..(end - start) {
            let window = 0.54 - 0.46 * (2.0 * PI * i as f32 / (frame_size - 1) as f32).cos();
            frame[i] = emphasized[start + i] as f64 * window as f64;
        }

        // Compute FFT
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        let mut buffer: Vec<rustfft::num_complex::Complex<f64>> = frame
            .iter()
            .map(|&x| rustfft::num_complex::Complex::new(x, 0.0))
            .collect();
        fft.process(&mut buffer);

        // Compute power spectrum (magnitude squared)
        let power_spectrum: Vec<f64> = buffer[..fft_size / 2 + 1]
            .iter()
            .map(|c| (c.norm_sqr() / fft_size as f64).max(1e-10))
            .collect();

        // Apply Mel filterbank
        for mel_idx in 0..num_mel_bins {
            let mut mel_energy = 0.0f64;
            for (bin_idx, &weight) in mel_bank[mel_idx].iter().enumerate() {
                if bin_idx < power_spectrum.len() {
                    mel_energy += power_spectrum[bin_idx] * weight;
                }
            }
            // Log filterbank
            let log_mel = (mel_energy + 1e-10).ln();
            all_features.push(log_mel as f32);
        }
    }

    // Apply mean normalization (CMVN)
    let num_features = all_features.len() / num_mel_bins;
    if num_features > 0 {
        let mut means = vec![0.0f32; num_mel_bins];
        for frame_idx in 0..num_features {
            for mel_idx in 0..num_mel_bins {
                means[mel_idx] += all_features[frame_idx * num_mel_bins + mel_idx];
            }
        }
        for mel_idx in 0..num_mel_bins {
            means[mel_idx] /= num_features as f32;
        }
        for frame_idx in 0..num_features {
            for mel_idx in 0..num_mel_bins {
                all_features[frame_idx * num_mel_bins + mel_idx] -= means[mel_idx];
            }
        }
    }

    Ok(all_features)
}

/// Create Mel filterbank matrix using the shared ln-based filterbank.
/// Diarization uses fmin=20 Hz, fmax=Nyquist (sample_rate/2).
#[cfg(feature = "diarization")]
fn create_mel_filterbank(fft_size: usize, sample_rate: f32, num_mel_bins: usize) -> Vec<Vec<f64>> {
    crate::audio::mel::create_mel_filterbank_ln(
        fft_size,
        sample_rate,
        num_mel_bins,
        20.0,
        sample_rate / 2.0,
    )
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
            // Cosine distance threshold. Lower is stricter and helps avoid speaker over-merging.
            threshold: 0.35,
            min_segment_duration: 5.0,
        }
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "test and tuning entry point for diarization clustering threshold"
        )
    )]
    pub fn with_threshold(mut self, threshold: f32) -> Self {
        self.threshold = threshold;
        self
    }

    /// Cluster embeddings using agglomerative hierarchical clustering (AHC)
    /// with centroid linkage under the fixed cosine-distance threshold.
    ///
    /// Unlike single-linkage (connected-components), AHC merges clusters based
    /// on the distance between their **centroids** rather than the minimum
    /// pairwise distance between members. This makes it more robust to
    /// "chaining" — the tendency of single-linkage to over-merge speakers
    /// through a transitive chain of acoustically similar but distinct voices.
    ///
    /// This mirrors the approach used by pyannote.audio 3.1 (the industry
    /// standard for embedding-based diarization), which uses agglomerative
    /// clustering with centroid linkage.
    ///
    /// Returns speaker assignments labeled by first occurrence.
    pub fn cluster(&self, embeddings: &[(f64, f64, Array1<f32>)]) -> Vec<usize> {
        if embeddings.is_empty() {
            return Vec::new();
        }

        if embeddings.len() == 1 {
            return vec![0];
        }

        let n = embeddings.len();

        // Collect pairwise distance statistics for debugging.
        let mut min_d = f32::INFINITY;
        let mut max_d = 0.0f32;
        let mut sum_d = 0.0f32;
        let mut count = 0usize;
        for i in 0..n {
            for j in (i + 1)..n {
                let distance = cosine_distance(&embeddings[i].2, &embeddings[j].2);
                min_d = min_d.min(distance);
                max_d = max_d.max(distance);
                sum_d += distance;
                count += 1;
            }
        }
        let avg_d = sum_d / count as f32;
        tracing::debug!(
            "Clustering {} embeddings with threshold {} (AHC centroid linkage). \
             Distance stats: min={:.4}, max={:.4}, avg={:.4}",
            n,
            self.threshold,
            min_d,
            max_d,
            avg_d
        );

        // Each embedding starts as its own cluster.
        let mut cluster_members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
        let mut cluster_centroids: Vec<Array1<f32>> =
            embeddings.iter().map(|(_, _, e)| e.clone()).collect();
        let mut active = vec![true; n];
        let mut num_active = n;

        // Agglomerative merge loop: repeatedly find the closest pair of active
        // clusters and merge them if their centroid distance is within threshold.
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
                    let d = cosine_distance(&cluster_centroids[i], &cluster_centroids[j]);
                    if d < min_dist {
                        min_dist = d;
                        merge_i = i;
                        merge_j = j;
                    }
                }
            }

            if min_dist > self.threshold {
                break;
            }

            // Merge cluster j into cluster i.
            let moved = std::mem::take(&mut cluster_members[merge_j]);
            cluster_members[merge_i].extend(moved);
            active[merge_j] = false;
            num_active -= 1;

            // Recompute the centroid of the merged cluster as the
            // L2-normalized mean of all member embeddings.
            let embedding_len = cluster_centroids[merge_i].len();
            let mut new_centroid = vec![0.0f32; embedding_len];
            for &member_idx in &cluster_members[merge_i] {
                for (k, &val) in embeddings[member_idx].2.iter().enumerate() {
                    new_centroid[k] += val;
                }
            }
            let norm: f32 = new_centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 1e-6 {
                for val in &mut new_centroid {
                    *val /= norm;
                }
            }
            cluster_centroids[merge_i] = Array1::from(new_centroid);
        }

        // Build embedding_index → cluster_index mapping, then assign labels
        // by first occurrence so labels are contiguous starting at 0.
        let mut embedding_to_cluster = vec![0usize; n];
        for (cluster_idx, members) in cluster_members.iter().enumerate() {
            if active[cluster_idx] {
                for &member in members {
                    embedding_to_cluster[member] = cluster_idx;
                }
            }
        }

        let mut labels = vec![0usize; n];
        let mut label_map: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        let mut next_label = 0;
        for i in 0..n {
            let cluster = embedding_to_cluster[i];
            let label = *label_map.entry(cluster).or_insert_with(|| {
                let l = next_label;
                next_label += 1;
                l
            });
            labels[i] = label;
        }

        labels
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

/// FBank analysis window, in samples: 25 ms at 16 kHz.
#[cfg(feature = "diarization")]
const FBANK_FRAME_SIZE: usize = 400;
/// FBank hop, in samples: 10 ms at 16 kHz.
#[cfg(feature = "diarization")]
const FBANK_FRAME_SHIFT: usize = 160;

/// How many FBank frames `compute_fbank_features` produces for `seconds` of
/// audio at [`EMBEDDING_SAMPLE_RATE`].
///
/// Split out from the loop so the verified range below is derived from the
/// segmentation constants rather than written down twice.
#[cfg(feature = "diarization")]
pub fn fbank_frames_for_seconds(seconds: f64) -> usize {
    let samples = (seconds * EMBEDDING_SAMPLE_RATE as f64).round() as usize;
    if samples < FBANK_FRAME_SIZE {
        1
    } else {
        (samples - FBANK_FRAME_SIZE) / FBANK_FRAME_SHIFT + 1
    }
}

/// The FBank frame counts the shipped segmentation can produce, inclusive.
///
/// Generic on purpose: every embedder in this build is fed the same windows,
/// so the range is a property of the segmentation rather than of one model. A
/// model-specific bound belongs beside the model.
#[cfg(feature = "diarization")]
pub fn verified_fbank_frame_range() -> std::ops::RangeInclusive<usize> {
    fbank_frames_for_seconds(MIN_SEGMENT_SECONDS)..=fbank_frames_for_seconds(SEGMENT_SECONDS)
}

/// Generate overlapping segments for embedding extraction
pub fn generate_segments(duration: f64, segment_duration: f64, overlap: f64) -> Vec<(f64, f64)> {
    let mut segments = Vec::new();
    let mut start = 0.0;
    let step = segment_duration - overlap;

    while start < duration {
        let end = (start + segment_duration).min(duration);
        if end - start >= MIN_SEGMENT_SECONDS {
            segments.push((start, end));
        }
        start += step;

        if end >= duration {
            break;
        }
    }

    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two numbers the voiceprint thresholds were measured at. A change
    /// here invalidates
    /// `artifacts/qa/voiceprint-recalibration-2026-09-03.md`, so it should
    /// fail a test rather than pass quietly.
    #[test]
    fn the_shipped_segmentation_is_two_second_windows_on_a_one_second_hop() {
        assert_eq!(SEGMENT_SECONDS, 2.0);
        assert_eq!(SEGMENT_OVERLAP_SECONDS, 1.0);
        assert_eq!(MIN_SEGMENT_SECONDS, 1.0);
        assert_eq!(EMBEDDING_SAMPLE_RATE, 16000);
    }

    #[test]
    fn generate_segments_hops_by_the_shipped_step_and_drops_a_short_tail() {
        let segments = generate_segments(5.5, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS);
        assert_eq!(
            segments,
            vec![(0.0, 2.0), (1.0, 3.0), (2.0, 4.0), (3.0, 5.0), (4.0, 5.5)]
        );
        // 0.5 s of audio is below `MIN_SEGMENT_SECONDS`, so nothing is emitted.
        assert!(generate_segments(0.5, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS).is_empty());
    }

    #[test]
    fn the_verified_frame_range_matches_the_shipped_windows() {
        // 1.0 s -> (16000 - 400) / 160 + 1 = 98 frames.
        // 2.0 s -> (32000 - 400) / 160 + 1 = 198 frames.
        assert_eq!(fbank_frames_for_seconds(MIN_SEGMENT_SECONDS), 98);
        assert_eq!(fbank_frames_for_seconds(SEGMENT_SECONDS), 198);
        let verified = verified_fbank_frame_range();
        assert_eq!(verified, 98..=198);
        assert!(verified.contains(&fbank_frames_for_seconds(1.5)));
        assert!(
            !verified.contains(&fbank_frames_for_seconds(8.0)),
            "an 8-second window is outside what was calibrated"
        );
    }
}
