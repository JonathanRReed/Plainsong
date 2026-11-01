//! Everything community-1 does after the two networks have run: speaker
//! counting, embedding filtering, AHC + PLDA + VBx clustering, constrained
//! assignment, reconstruction and binarization. Ported line by line from
//! pyannote.audio 4.0 (`pipelines/speaker_diarization.py`,
//! `pipelines/clustering.py::VBxClustering`, `pipelines/utils/diarization.py`,
//! `core/inference.py::aggregate`, `utils/signal.py::Binarize`), with the
//! arithmetic kept in the same precision (`float32` aggregation, `float64`
//! clustering) so the integer decisions land where the reference's do.

use ndarray::Array2;

use super::ahc::{centroid_linkage, flat_clusters};
use super::plda::{Plda, EMBEDDING_DIM, LDA_DIM};
use super::vbx::cluster_vbx;

/// Output frames per 10 s segmentation chunk.
pub(super) const FRAMES_PER_CHUNK: usize = 589;
/// Local speakers per chunk (powerset over 3 speakers, at most 2 at once).
pub(super) const LOCAL_SPEAKERS: usize = 3;
/// The segmentation model's receptive field, from `Model.receptive_field`.
pub(super) const FRAME_STEP_SECONDS: f64 = 0.016875;
pub(super) const FRAME_DURATION_SECONDS: f64 = 0.0619375;
pub(super) const CHUNK_SECONDS: f64 = 10.0;
pub(super) const CHUNK_STEP_SECONDS: f64 = 1.0;

/// community-1 `config.yaml` clustering parameters.
pub(super) const AHC_THRESHOLD: f64 = 0.6;
pub(super) const VBX_FA: f64 = 0.07;
pub(super) const VBX_FB: f64 = 0.8;
const VBX_MAX_ITERS: usize = 20;
const VBX_INIT_SMOOTHING: f64 = 7.0;
/// `filter_embeddings(min_active_ratio=0.2)`.
const MIN_ACTIVE_RATIO: f64 = 0.2;
/// `cluster_vbx` keeps speakers whose prior exceeds this.
const MIN_SPEAKER_PRIOR: f64 = 1e-7;

/// Binarized powerset segmentation, `chunks x FRAMES_PER_CHUNK x LOCAL_SPEAKERS`.
#[derive(Debug, Clone)]
pub(super) struct Segmentation {
    pub chunks: usize,
    pub data: Vec<u8>,
}

impl Segmentation {
    #[inline]
    pub(super) fn at(&self, chunk: usize, frame: usize, speaker: usize) -> u8 {
        self.data[(chunk * FRAMES_PER_CHUNK + frame) * LOCAL_SPEAKERS + speaker]
    }

    fn active_frames(&self, chunk: usize, speaker: usize) -> usize {
        (0..FRAMES_PER_CHUNK)
            .filter(|&f| self.at(chunk, f, speaker) != 0)
            .count()
    }

    pub(super) fn is_active(&self, chunk: usize, speaker: usize) -> bool {
        self.active_frames(chunk, speaker) > 0
    }
}

/// `SlidingWindow.closest_frame` for the frame grid re-based at 0.
fn closest_frame(t: f64) -> i64 {
    ((t - 0.0 - 0.5 * FRAME_DURATION_SECONDS) / FRAME_STEP_SECONDS).round_ties_even() as i64
}

/// Number of frames `Inference.aggregate` allocates for `chunks` chunks.
pub(super) fn aggregated_frames(chunks: usize) -> usize {
    let t = 0.0
        + CHUNK_SECONDS
        + (chunks as f64 - 1.0) * CHUNK_STEP_SECONDS
        + 0.5 * FRAME_DURATION_SECONDS;
    (closest_frame(t) + 1) as usize
}

/// First aggregated frame of chunk `chunk`.
fn chunk_start_frame(chunk: usize) -> usize {
    let start = 0.0 + chunk as f64 * CHUNK_STEP_SECONDS;
    closest_frame(start + 0.5 * FRAME_DURATION_SECONDS) as usize
}

/// `SpeakerDiarizationMixin.speaker_count(..., warm_up=(0, 0))`.
pub(super) fn speaker_count(seg: &Segmentation) -> Vec<u8> {
    let frames = aggregated_frames(seg.chunks);
    let mut sum = vec![0f32; frames];
    let mut covered = vec![0f32; frames];
    for chunk in 0..seg.chunks {
        let start = chunk_start_frame(chunk);
        for f in 0..FRAMES_PER_CHUNK {
            let active: u8 = (0..LOCAL_SPEAKERS).map(|s| seg.at(chunk, f, s)).sum();
            sum[start + f] += f32::from(active);
            covered[start + f] += 1.0;
        }
    }
    sum.iter()
        .zip(&covered)
        .map(|(&total, &n)| {
            if n == 0.0 {
                0
            } else {
                (total / n.max(1e-12)).round_ties_even() as u8
            }
        })
        .collect()
}

/// `(chunk, speaker)` pairs used to train the clustering
/// (`BaseClustering.filter_embeddings`), in `np.where` order.
pub(super) fn training_pairs(seg: &Segmentation) -> Vec<(usize, usize)> {
    let min_clean = MIN_ACTIVE_RATIO * FRAMES_PER_CHUNK as f64;
    let mut pairs = Vec::new();
    for chunk in 0..seg.chunks {
        let mut clean = [0usize; LOCAL_SPEAKERS];
        for f in 0..FRAMES_PER_CHUNK {
            let active: Vec<usize> = (0..LOCAL_SPEAKERS)
                .filter(|&s| seg.at(chunk, f, s) != 0)
                .collect();
            if active.len() == 1 {
                clean[active[0]] += 1;
            }
        }
        for (speaker, &n) in clean.iter().enumerate() {
            if n as f64 >= min_clean {
                pairs.push((chunk, speaker));
            }
        }
    }
    pairs
}

/// Everything the clustering step decided, kept for the parity harness.
#[derive(Debug, Clone)]
pub(super) struct Clustering {
    pub train: Vec<(usize, usize)>,
    pub ahc_labels: Vec<usize>,
    pub vbx_gamma: Option<Array2<f64>>,
    pub vbx_pi: Vec<f64>,
    pub centroids: Vec<Vec<f64>>,
    /// The VBx speaker (column of `vbx_gamma`) behind each of `centroids`.
    pub kept: Vec<usize>,
    /// `chunks x LOCAL_SPEAKERS`; `-2` = not assigned / inactive.
    pub hard: Vec<i32>,
}

/// `VBxClustering.__call__` followed by the pipeline's `hard[inactive] = -2`.
/// `embeddings` is `chunks x LOCAL_SPEAKERS x EMBEDDING_DIM`; rows of chunks
/// with no active speaker may be anything (they are never read).
pub(super) fn cluster(seg: &Segmentation, embeddings: &[f32], plda: &Plda) -> Clustering {
    let chunks = seg.chunks;
    let emb = |c: usize, s: usize| -> &[f32] {
        let at = (c * LOCAL_SPEAKERS + s) * EMBEDDING_DIM;
        &embeddings[at..at + EMBEDDING_DIM]
    };
    let train = training_pairs(seg);
    let inactive: Vec<bool> = (0..chunks)
        .flat_map(|c| (0..LOCAL_SPEAKERS).map(move |s| (c, s)))
        .map(|(c, s)| !seg.is_active(c, s))
        .collect();

    if train.len() < 2 {
        let hard = inactive
            .iter()
            .map(|&off| if off { -2 } else { 0 })
            .collect();
        return Clustering {
            train,
            ahc_labels: Vec::new(),
            vbx_gamma: None,
            vbx_pi: vec![1.0],
            centroids: Vec::new(),
            kept: Vec::new(),
            hard,
        };
    }

    // AHC on L2-normalized embeddings (normalized in float32 like numpy).
    let mut normed = Vec::with_capacity(train.len() * EMBEDDING_DIM);
    for &(c, s) in &train {
        let e = emb(c, s);
        let norm = e.iter().map(|v| v * v).sum::<f32>().sqrt();
        normed.extend(e.iter().map(|&v| f64::from(v / norm)));
    }
    let merges = centroid_linkage(&normed, EMBEDDING_DIM);
    drop(normed);
    let ahc_labels = flat_clusters(&merges, train.len(), AHC_THRESHOLD);

    // VBx in PLDA space.
    let mut features = Array2::<f64>::zeros((train.len(), LDA_DIM));
    for (row, &(c, s)) in train.iter().enumerate() {
        for (j, value) in plda.project(emb(c, s)).into_iter().enumerate() {
            features[[row, j]] = value;
        }
    }
    let (gamma, pi) = cluster_vbx(
        &ahc_labels,
        &features,
        &plda.phi,
        VBX_FA,
        VBX_FB,
        VBX_MAX_ITERS,
        VBX_INIT_SMOOTHING,
    );

    // Centroids of the speakers VBx kept, from the raw embeddings.
    let kept: Vec<usize> = (0..pi.len())
        .filter(|&k| pi[k] > MIN_SPEAKER_PRIOR)
        .collect();
    let centroids: Vec<Vec<f64>> = kept
        .iter()
        .map(|&k| {
            let mut centroid = vec![0.0f64; EMBEDDING_DIM];
            let mut weight = 0.0f64;
            for (row, &(c, s)) in train.iter().enumerate() {
                let w = gamma[[row, k]];
                weight += w;
                for (out, &v) in centroid.iter_mut().zip(emb(c, s)) {
                    *out += w * f64::from(v);
                }
            }
            centroid.iter_mut().for_each(|v| *v /= weight);
            centroid
        })
        .collect();

    // soft = 2 - cosine distance; inactive speakers get a score below all others.
    let k = centroids.len();
    let centroid_norms: Vec<f64> = centroids
        .iter()
        .map(|c| c.iter().map(|v| v * v).sum::<f64>().sqrt())
        .collect();
    let mut soft = vec![0.0f64; chunks * LOCAL_SPEAKERS * k];
    let mut min_score = f64::INFINITY;
    for c in 0..chunks {
        for s in 0..LOCAL_SPEAKERS {
            if inactive[c * LOCAL_SPEAKERS + s] {
                continue;
            }
            let e = emb(c, s);
            let norm = e
                .iter()
                .map(|&v| f64::from(v) * f64::from(v))
                .sum::<f64>()
                .sqrt();
            for (j, centroid) in centroids.iter().enumerate() {
                let dot: f64 = centroid.iter().zip(e).map(|(a, &b)| a * f64::from(b)).sum();
                let score = 2.0 - (1.0 - dot / (norm * centroid_norms[j]));
                soft[(c * LOCAL_SPEAKERS + s) * k + j] = score;
                min_score = min_score.min(score);
            }
        }
    }
    let floor = if min_score.is_finite() {
        min_score - 1.0
    } else {
        -1.0
    };
    let mut hard = vec![-2i32; chunks * LOCAL_SPEAKERS];
    for c in 0..chunks {
        let mut rows: Vec<Vec<f64>> = Vec::with_capacity(LOCAL_SPEAKERS);
        for s in 0..LOCAL_SPEAKERS {
            let row: Vec<f64> = if inactive[c * LOCAL_SPEAKERS + s] {
                vec![floor; k]
            } else {
                soft[(c * LOCAL_SPEAKERS + s) * k..(c * LOCAL_SPEAKERS + s + 1) * k].to_vec()
            };
            rows.push(row);
        }
        for (s, cluster) in max_assignment(&rows, k).into_iter().enumerate() {
            if let Some(cluster) = cluster {
                hard[c * LOCAL_SPEAKERS + s] = cluster as i32;
            }
        }
    }
    for (slot, &off) in hard.iter_mut().zip(&inactive) {
        if off {
            *slot = -2;
        }
    }
    Clustering {
        train,
        ahc_labels,
        vbx_gamma: Some(gamma),
        vbx_pi: pi.to_vec(),
        centroids,
        kept,
        hard,
    }
}

/// `scipy.optimize.linear_sum_assignment(rows, maximize=True)` for at most
/// three rows: assigns `min(rows, columns)` rows to distinct columns with the
/// largest total. Exhaustive, which for three rows is exact and cheap.
fn max_assignment(rows: &[Vec<f64>], columns: usize) -> Vec<Option<usize>> {
    let r = rows.len();
    let target = r.min(columns);
    let mut best_total = f64::NEG_INFINITY;
    let mut best: Vec<Option<usize>> = vec![None; r];
    let mut current: Vec<Option<usize>> = vec![None; r];
    let mut used = vec![false; columns];

    #[allow(clippy::too_many_arguments)]
    fn search(
        row: usize,
        assigned: usize,
        total: f64,
        rows: &[Vec<f64>],
        target: usize,
        used: &mut [bool],
        current: &mut [Option<usize>],
        best: &mut Vec<Option<usize>>,
        best_total: &mut f64,
    ) {
        if row == rows.len() {
            if assigned == target && total > *best_total {
                *best_total = total;
                best.clone_from_slice(current);
            }
            return;
        }
        let remaining_rows = rows.len() - row - 1;
        for col in 0..used.len() {
            if used[col] {
                continue;
            }
            used[col] = true;
            current[row] = Some(col);
            search(
                row + 1,
                assigned + 1,
                total + rows[row][col],
                rows,
                target,
                used,
                current,
                best,
                best_total,
            );
            used[col] = false;
        }
        current[row] = None;
        if assigned + remaining_rows >= target {
            search(
                row + 1,
                assigned,
                total,
                rows,
                target,
                used,
                current,
                best,
                best_total,
            );
        }
    }

    search(
        0,
        0,
        0.0,
        rows,
        target,
        &mut used,
        &mut current,
        &mut best,
        &mut best_total,
    );
    best
}

/// `SpeakerDiarization.reconstruct` + `to_diarization`: the discrete
/// diarization, `frames x clusters` (row-major), for a given speaker count.
pub(super) fn reconstruct(seg: &Segmentation, hard: &[i32], count: &[u8]) -> (usize, Vec<u8>) {
    let frames = aggregated_frames(seg.chunks);
    let clusters = hard.iter().copied().max().map_or(0, |m| (m + 1).max(0)) as usize;
    let max_count = count.iter().copied().max().unwrap_or(0) as usize;
    let columns = clusters.max(max_count);
    let mut activations = vec![0f32; frames * columns];
    for chunk in 0..seg.chunks {
        let start = chunk_start_frame(chunk);
        for k in 0..clusters {
            let members: Vec<usize> = (0..LOCAL_SPEAKERS)
                .filter(|&s| hard[chunk * LOCAL_SPEAKERS + s] == k as i32)
                .collect();
            if members.is_empty() {
                continue;
            }
            for f in 0..FRAMES_PER_CHUNK {
                let value = members
                    .iter()
                    .map(|&s| seg.at(chunk, f, s))
                    .max()
                    .unwrap_or(0);
                activations[(start + f) * columns + k] += f32::from(value);
            }
        }
    }
    let mut binary = vec![0u8; frames * columns];
    let mut order: Vec<usize> = Vec::with_capacity(columns);
    for t in 0..frames.min(count.len()) {
        let row = &activations[t * columns..(t + 1) * columns];
        order.clear();
        order.extend(0..columns);
        // numpy's argsort(-x) is an insertion sort (stable) for <= 16 columns.
        order.sort_by(|&a, &b| row[b].total_cmp(&row[a]));
        for &k in order.iter().take(count[t] as usize) {
            binary[t * columns + k] = 1;
        }
    }
    (columns, binary)
}

/// One speaker turn on the reconstructed timeline, in cluster indices.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ClusterTurn {
    pub start: f64,
    pub end: f64,
    pub cluster: usize,
}

/// `Binarize(onset=0.5, offset=0.5, min_duration_on=0, min_duration_off=0)`
/// over a discrete diarization, in pyannote's track order (by start, end).
pub(super) fn binarize(columns: usize, binary: &[u8]) -> Vec<ClusterTurn> {
    if columns == 0 {
        return Vec::new();
    }
    let frames = binary.len() / columns;
    if frames == 0 {
        return Vec::new();
    }
    let middle = |i: usize| {
        let start = 0.0 + i as f64 * FRAME_STEP_SECONDS;
        0.5 * (start + (start + FRAME_DURATION_SECONDS))
    };
    let mut turns = Vec::new();
    // pyannote.core drops segments of 1 µs or less (`Segment.__bool__`).
    let mut push = |start: f64, end: f64, cluster: usize| {
        if end - start > 1e-6 {
            turns.push(ClusterTurn {
                start,
                end,
                cluster,
            });
        }
    };
    for k in 0..columns {
        let mut start = middle(0);
        let mut active = binary[k] != 0;
        let mut last = start;
        for i in 1..frames {
            let t = middle(i);
            last = t;
            let on = binary[i * columns + k] != 0;
            if active && !on {
                push(start, t, k);
                start = t;
                active = false;
            } else if !active && on {
                start = t;
                active = true;
            }
        }
        if active {
            push(start, last, k);
        }
    }
    turns.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    turns
}

/// Exclusive count: `min(count, 1)`.
pub(super) fn exclusive_count(count: &[u8]) -> Vec<u8> {
    count.iter().map(|&c| c.min(1)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg_from(chunks: usize, active: impl Fn(usize, usize, usize) -> bool) -> Segmentation {
        let mut data = vec![0u8; chunks * FRAMES_PER_CHUNK * LOCAL_SPEAKERS];
        for c in 0..chunks {
            for f in 0..FRAMES_PER_CHUNK {
                for s in 0..LOCAL_SPEAKERS {
                    data[(c * FRAMES_PER_CHUNK + f) * LOCAL_SPEAKERS + s] =
                        u8::from(active(c, f, s));
                }
            }
        }
        Segmentation { chunks, data }
    }

    #[test]
    fn frame_grid_matches_pyannote_for_one_and_many_chunks() {
        // pyannote: one 10 s chunk aggregates to 594 frames; chunk c starts at
        // round(c / 0.016875).
        assert_eq!(aggregated_frames(1), 594);
        assert_eq!(chunk_start_frame(1), 59);
        assert_eq!(chunk_start_frame(2), 119);
        assert_eq!(
            aggregated_frames(111),
            closest_frame(120.0 + 0.5 * FRAME_DURATION_SECONDS) as usize + 1
        );
    }

    #[test]
    fn count_rounds_half_to_even_like_numpy() {
        // Two chunks overlap; one says one speaker, the other says none -> 0.5 -> 0.
        let seg = seg_from(2, |c, _, s| c == 0 && s == 0);
        let count = speaker_count(&seg);
        assert_eq!(count[0], 1);
        assert_eq!(count[60], 0);
        assert_eq!(count[count.len() - 1], 0);
    }

    #[test]
    fn assignment_prefers_the_best_distinct_columns() {
        let rows = vec![vec![1.9, 1.8], vec![1.85, 1.2], vec![-1.0, -1.0]];
        assert_eq!(max_assignment(&rows, 2), vec![Some(1), Some(0), None]);
        let rows = vec![
            vec![1.0, 0.5, 0.2],
            vec![0.9, 0.1, 0.3],
            vec![0.0, 0.0, 0.0],
        ];
        assert_eq!(max_assignment(&rows, 3), vec![Some(1), Some(0), Some(2)]);
    }

    #[test]
    fn binarize_closes_regions_at_frame_middles() {
        let binary = [0u8, 1, 1, 0, 1];
        let turns = binarize(1, &binary);
        let m = |i: f64| i * FRAME_STEP_SECONDS + 0.5 * FRAME_DURATION_SECONDS;
        // The last region opens and closes on the final frame: empty, dropped.
        assert_eq!(turns.len(), 1);
        assert!((turns[0].start - m(1.0)).abs() < 1e-12 && (turns[0].end - m(3.0)).abs() < 1e-12);
    }
}
