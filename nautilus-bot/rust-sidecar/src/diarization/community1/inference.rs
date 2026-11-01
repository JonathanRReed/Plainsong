//! ONNX Runtime side of community-1: the sliding 10 s windows, the powerset
//! segmentation network and the WeSpeaker ResNet34 embedding network, as
//! pyannote.audio 4.0's `Inference.slide` and `SpeakerDiarization.get_embeddings`
//! drive them.

use anyhow::{anyhow, Context, Result};
use ndarray::{Array2, Array3};
use ort::{session::Session, value::Tensor};
use std::path::Path;

use super::fbank::{self, KaldiFbank, NUM_MEL_BINS};
use super::pipeline::{Segmentation, FRAMES_PER_CHUNK, LOCAL_SPEAKERS};
use super::plda::EMBEDDING_DIM;

pub(super) const SAMPLE_RATE: usize = 16_000;
pub(super) const CHUNK_SAMPLES: usize = 160_000;
pub(super) const STEP_SAMPLES: usize = 16_000;
const POWERSET_CLASSES: usize = 7;
/// `Powerset(3, 2).mapping`: classes {}, {0}, {1}, {2}, {0,1}, {0,2}, {1,2}.
const POWERSET: [[u8; LOCAL_SPEAKERS]; POWERSET_CLASSES] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [1, 0, 1],
    [0, 1, 1],
];
/// fbank frames of one 10 s chunk.
const FBANK_FRAMES: usize = 998;
/// ResNet34 output frames of one chunk (998 / 8, rounded up).
const POOL_FRAMES: usize = 125;
/// `PyannoteAudioPretrainedSpeakerEmbedding.min_num_samples` for this model
/// (binary search in pyannote; 400 = one 25 ms fbank window).
const MIN_NUM_SAMPLES: usize = 400;
const SEGMENTATION_BATCH: usize = 8;
/// Windows per embedding call. Every call is padded to this size so the
/// Core ML program sees one static shape and is compiled once.
const EMBEDDING_BATCH: usize = 8;

/// Number of 10 s windows `Inference.slide` cuts from `samples` samples,
/// including the zero-padded last one.
pub(super) fn chunk_count(samples: usize) -> usize {
    let full = if samples >= CHUNK_SAMPLES {
        (samples - CHUNK_SAMPLES) / STEP_SAMPLES + 1
    } else {
        0
    };
    let has_last =
        samples < CHUNK_SAMPLES || !(samples - CHUNK_SAMPLES).is_multiple_of(STEP_SAMPLES);
    full + usize::from(has_last)
}

/// Window `chunk`, zero-padded past the end of the recording.
fn chunk_audio(samples: &[f32], chunk: usize, out: &mut [f32]) {
    let start = chunk * STEP_SAMPLES;
    let end = (start + CHUNK_SAMPLES).min(samples.len());
    out.fill(0.0);
    if start < end {
        out[..end - start].copy_from_slice(&samples[start..end]);
    }
}

pub(super) struct Networks {
    segmentation: Session,
    embedding: Session,
    /// Where the embedding network runs: `"coreml-gpu"` or `"cpu"`.
    pub embedding_device: &'static str,
    /// Kept to rebuild the embedding session on the CPU if Core ML fails
    /// while running rather than while loading.
    embedding_path: std::path::PathBuf,
    threads: usize,
    fbank: KaldiFbank,
    pool_index: Vec<usize>,
    _qa_residency: Option<crate::memory_pressure::QaResidency>,
}

/// Without ONNX Runtime's CPU arena and memory patterns: the arena keeps the
/// largest activation set ever seen for the life of the session, which for
/// ten-second windows is most of the pass's footprint, and the windows are
/// the same size every call so the patterns save little.
fn lean_cpu(
    builder: ort::session::builder::SessionBuilder,
    threads: usize,
) -> Result<ort::session::builder::SessionBuilder> {
    builder
        .with_intra_threads(threads)
        .map_err(|error| anyhow!("Failed to set ONNX intra-op threads: {error}"))?
        .with_memory_pattern(false)
        .map_err(|error| anyhow!("Failed to disable ONNX memory patterns: {error}"))
}

fn cpu_ep() -> ort::ep::ExecutionProviderDispatch {
    ort::ep::CPU::default().with_arena_allocator(false).build()
}

/// `path` from the bundle, verified against its pin for this session.
fn verified_network(path: &Path) -> Result<crate::download::VerifiedModelArtifact> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    crate::download::open_verified_model_artifact(path, super::bundle_pin(file_name)?)
}

fn cpu_session(path: &Path, threads: usize) -> Result<Session> {
    let model = verified_network(path)?;
    crate::ort_utils::build_verified_session_no_coreml(&model, move |builder| {
        lean_cpu(builder, threads)?
            .with_execution_providers([cpu_ep()])
            .map_err(|error| anyhow!("Failed to configure the CPU execution provider: {error}"))
    })
}

/// The ResNet34 is nearly all of the pipeline's arithmetic. On a Mac it runs
/// through Core ML on the GPU as an ML Program in float32 (160 of its 164 ONNX
/// nodes; pooling stays on the CPU): about 9 ms per 10 s window against
/// 150-290 ms on the CPU, with outputs within 3e-7 of the CPU's. The Neural
/// Engine is not used because it computes in float16. Anything that keeps
/// Core ML from loading the model falls back to the CPU.
fn embedding_session(path: &Path, threads: usize) -> Result<(Session, &'static str)> {
    #[cfg(all(target_os = "macos", feature = "ort-coreml-ep"))]
    {
        use ort::ep::coreml::{ComputeUnits, CoreML, ModelFormat};
        let model = verified_network(path)?;
        let attempt = crate::ort_utils::build_verified_session_no_coreml(&model, move |builder| {
            lean_cpu(builder, threads)?
                .with_execution_providers([
                    CoreML::default()
                        .with_model_format(ModelFormat::MLProgram)
                        .with_compute_units(ComputeUnits::CPUAndGPU)
                        .build()
                        .error_on_failure(),
                    cpu_ep(),
                ])
                .map_err(|error| {
                    anyhow!("Failed to register the Core ML execution provider: {error}")
                })
        });
        match attempt {
            Ok(session) => return Ok((session, "coreml-gpu")),
            Err(error) => {
                tracing::warn!("pyannote community-1 embeddings fall back to the CPU: {error:#}")
            }
        }
    }
    Ok((cpu_session(path, threads)?, "cpu"))
}

impl Networks {
    pub(super) fn load(segmentation: &Path, embedding: &Path, threads: usize) -> Result<Self> {
        let (embedding_session, embedding_device) = embedding_session(embedding, threads)?;
        Ok(Self {
            // The segmentation network is mostly an LSTM, which Core ML does
            // not take; it stays on the CPU.
            segmentation: cpu_session(segmentation, threads)?,
            embedding: embedding_session,
            embedding_device,
            embedding_path: embedding.to_path_buf(),
            threads,
            fbank: KaldiFbank::new(),
            pool_index: fbank::nearest_index(FRAMES_PER_CHUNK, POOL_FRAMES),
            _qa_residency: crate::memory_pressure::QaResidency::loaded(
                "speaker",
                std::process::id(),
            ),
        })
    }

    /// Run the segmentation network over every window and decode the powerset
    /// to per-speaker activity. With `keep_log_probs`, also return the raw
    /// network output (`chunks x 589 x 7`) for the parity harness.
    /// `between_batches` runs after every batch but the last.
    pub(super) fn segment(
        &mut self,
        samples: &[f32],
        keep_log_probs: bool,
        between_batches: &mut dyn FnMut() -> Result<()>,
    ) -> Result<(Segmentation, Option<Vec<f32>>)> {
        let chunks = chunk_count(samples.len());
        let mut data = vec![0u8; chunks * FRAMES_PER_CHUNK * LOCAL_SPEAKERS];
        let mut raw = keep_log_probs
            .then(|| Vec::with_capacity(chunks * FRAMES_PER_CHUNK * POWERSET_CLASSES));
        let mut start = 0;
        while start < chunks {
            let batch = SEGMENTATION_BATCH.min(chunks - start);
            let mut input = Array3::<f32>::zeros((batch, 1, CHUNK_SAMPLES));
            for b in 0..batch {
                let row = input
                    .slice_mut(ndarray::s![b, 0, ..])
                    .into_slice()
                    .expect("contiguous");
                chunk_audio(samples, start + b, row);
            }
            let tensor = Tensor::from_array(input).context("segmentation input tensor")?;
            let outputs = self
                .segmentation
                .run(ort::inputs!["waveform" => tensor])
                .map_err(|error| anyhow!("Segmentation inference failed: {error}"))?;
            let log_probs = outputs[0]
                .try_extract_array::<f32>()
                .context("segmentation output")?;
            let shape = log_probs.shape().to_vec();
            if shape != [batch, FRAMES_PER_CHUNK, POWERSET_CLASSES] {
                return Err(anyhow!("Unexpected segmentation output shape {shape:?}"));
            }
            for b in 0..batch {
                for f in 0..FRAMES_PER_CHUNK {
                    let mut best = 0;
                    for class in 1..POWERSET_CLASSES {
                        if log_probs[[b, f, class]] > log_probs[[b, f, best]] {
                            best = class;
                        }
                    }
                    let at = ((start + b) * FRAMES_PER_CHUNK + f) * LOCAL_SPEAKERS;
                    data[at..at + LOCAL_SPEAKERS].copy_from_slice(&POWERSET[best]);
                    if let Some(raw) = raw.as_mut() {
                        raw.extend((0..POWERSET_CLASSES).map(|class| log_probs[[b, f, class]]));
                    }
                }
            }
            start += batch;
            if start < chunks {
                between_batches()?;
            }
        }
        Ok((Segmentation { chunks, data }, raw))
    }

    /// One embedding per (chunk, local speaker), `chunks x 3 x 256`, following
    /// `get_embeddings(exclude_overlap=True)`: each speaker's mask drops
    /// overlapped frames unless fewer than `min_num_frames` clean frames remain.
    /// Chunks with no active speaker are skipped (their rows stay zero): the
    /// reference computes them but never reads them. `between_batches` runs
    /// after every batch but the last.
    pub(super) fn embed(
        &mut self,
        samples: &[f32],
        seg: &Segmentation,
        between_batches: &mut dyn FnMut() -> Result<()>,
    ) -> Result<Vec<f32>> {
        let chunks = seg.chunks;
        let mut embeddings = vec![0f32; chunks * LOCAL_SPEAKERS * EMBEDDING_DIM];
        // math.ceil(num_frames * min_num_samples / (duration * sample_rate))
        let min_num_frames = (FRAMES_PER_CHUNK as f64 * MIN_NUM_SAMPLES as f64
            / CHUNK_SAMPLES as f64)
            .ceil() as usize;
        let wanted: Vec<usize> = (0..chunks)
            .filter(|&c| (0..LOCAL_SPEAKERS).any(|s| seg.is_active(c, s)))
            .collect();
        let mut audio = vec![0f32; CHUNK_SAMPLES];
        for (index, batch) in wanted.chunks(EMBEDDING_BATCH).enumerate() {
            if index > 0 {
                between_batches()?;
            }
            // Padded to EMBEDDING_BATCH with silent rows whose outputs are dropped.
            let mut features = Array3::<f32>::zeros((EMBEDDING_BATCH, FBANK_FRAMES, NUM_MEL_BINS));
            let mut weights = Array3::<f32>::zeros((EMBEDDING_BATCH, LOCAL_SPEAKERS, POOL_FRAMES));
            for (b, &chunk) in batch.iter().enumerate() {
                chunk_audio(samples, chunk, &mut audio);
                let fb = self.fbank.compute(&audio);
                debug_assert_eq!(fb.len(), FBANK_FRAMES * NUM_MEL_BINS);
                features
                    .slice_mut(ndarray::s![b, .., ..])
                    .as_slice_mut()
                    .expect("contiguous")
                    .copy_from_slice(&fb);
                let mask = speaker_masks(seg, chunk, min_num_frames);
                for s in 0..LOCAL_SPEAKERS {
                    for (j, &frame) in self.pool_index.iter().enumerate() {
                        weights[[b, s, j]] = mask[[s, frame]];
                    }
                }
            }
            let out = self.embed_batch(features, weights)?;
            for (b, &chunk) in batch.iter().enumerate() {
                let from = b * LOCAL_SPEAKERS * EMBEDDING_DIM;
                let at = chunk * LOCAL_SPEAKERS * EMBEDDING_DIM;
                embeddings[at..at + LOCAL_SPEAKERS * EMBEDDING_DIM]
                    .copy_from_slice(&out[from..from + LOCAL_SPEAKERS * EMBEDDING_DIM]);
            }
        }
        Ok(embeddings)
    }

    /// One padded batch through the embedding network, `EMBEDDING_BATCH x 3 x
    /// 256` flattened. A Core ML failure at run time (the GPU lost, the
    /// compiled program evicted) moves the rest of the pass to the CPU instead
    /// of failing the meeting's speaker labels.
    fn embed_batch(&mut self, features: Array3<f32>, weights: Array3<f32>) -> Result<Vec<f32>> {
        if self.embedding_device == "cpu" {
            return run_embedding(&mut self.embedding, features, weights);
        }
        match run_embedding(&mut self.embedding, features.clone(), weights.clone()) {
            Ok(out) => Ok(out),
            Err(error) => {
                tracing::warn!(
                    "pyannote community-1 embeddings move to the CPU after a Core ML failure: {error:#}"
                );
                self.embedding = cpu_session(&self.embedding_path, self.threads)?;
                self.embedding_device = "cpu";
                run_embedding(&mut self.embedding, features, weights)
            }
        }
    }
}

fn run_embedding(
    session: &mut Session,
    features: Array3<f32>,
    weights: Array3<f32>,
) -> Result<Vec<f32>> {
    let fbank_tensor = Tensor::from_array(features).context("embedding fbank tensor")?;
    let weight_tensor = Tensor::from_array(weights).context("embedding weight tensor")?;
    let outputs = session
        .run(ort::inputs!["fbank" => fbank_tensor, "weights" => weight_tensor])
        .map_err(|error| anyhow!("Embedding inference failed: {error}"))?;
    let out = outputs[0]
        .try_extract_array::<f32>()
        .context("embedding output")?;
    if out.shape() != [EMBEDDING_BATCH, LOCAL_SPEAKERS, EMBEDDING_DIM] {
        return Err(anyhow!(
            "Unexpected embedding output shape {:?}",
            out.shape()
        ));
    }
    Ok(out.iter().copied().collect())
}

/// The per-speaker frame masks `get_embeddings` feeds the pooling layer.
fn speaker_masks(seg: &Segmentation, chunk: usize, min_num_frames: usize) -> Array2<f32> {
    let mut masks = Array2::<f32>::zeros((LOCAL_SPEAKERS, FRAMES_PER_CHUNK));
    for s in 0..LOCAL_SPEAKERS {
        let clean: usize = (0..FRAMES_PER_CHUNK)
            .filter(|&f| {
                seg.at(chunk, f, s) != 0
                    && (0..LOCAL_SPEAKERS).map(|o| seg.at(chunk, f, o)).sum::<u8>() < 2
            })
            .count();
        let use_clean = clean > min_num_frames;
        for f in 0..FRAMES_PER_CHUNK {
            let active = seg.at(chunk, f, s) != 0;
            let overlapped = (0..LOCAL_SPEAKERS).map(|o| seg.at(chunk, f, o)).sum::<u8>() >= 2;
            masks[[s, f]] = f32::from(u8::from(active && !(use_clean && overlapped)));
        }
    }
    masks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_match_inference_slide() {
        assert_eq!(chunk_count(0), 1);
        assert_eq!(chunk_count(CHUNK_SAMPLES - 1), 1);
        assert_eq!(chunk_count(CHUNK_SAMPLES), 1);
        assert_eq!(chunk_count(CHUNK_SAMPLES + 1), 2);
        assert_eq!(chunk_count(CHUNK_SAMPLES + STEP_SAMPLES), 2);
        // 120 s: 111 full windows, none left over.
        assert_eq!(chunk_count(120 * SAMPLE_RATE), 111);
        assert_eq!(chunk_count(120 * SAMPLE_RATE + 5), 112);
    }

    #[test]
    fn overlap_is_excluded_only_when_enough_clean_frames_remain() {
        // Speaker 0 active everywhere; speaker 1 overlaps it on frames 0..587.
        let mut data = vec![0u8; FRAMES_PER_CHUNK * LOCAL_SPEAKERS];
        for f in 0..FRAMES_PER_CHUNK {
            data[f * LOCAL_SPEAKERS] = 1;
            if f < 587 {
                data[f * LOCAL_SPEAKERS + 1] = 1;
            }
        }
        let seg = Segmentation { chunks: 1, data };
        let masks = speaker_masks(&seg, 0, 2);
        // speaker 0 has exactly 2 clean frames: not > 2, so the full mask is used.
        assert_eq!(masks.row(0).sum(), FRAMES_PER_CHUNK as f32);
        // speaker 1 has no clean frames: full mask.
        assert_eq!(masks.row(1).sum(), 587.0);
        let masks = speaker_masks(&seg, 0, 1);
        assert_eq!(masks.row(0).sum(), 2.0);
    }
}
