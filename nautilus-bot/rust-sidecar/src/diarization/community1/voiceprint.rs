//! One voice signature per community-1 speaker, for Plainsong's remembered
//! voices.
//!
//! community-1 already computes a WeSpeaker ResNet34 embedding for every
//! (10 s window, local speaker) and clusters the clean ones in PLDA space.
//! A signature is a summary of the embeddings of one cluster, so remembering
//! a voice costs no extra inference. The spaces below were compared on AMI;
//! [`PRODUCT_SPACE`] names the one the product stores.

use super::pipeline::{Clustering, LOCAL_SPEAKERS};
use super::plda::{Plda, EMBEDDING_DIM, LDA_DIM};

/// Where a cluster's embeddings are averaged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignatureSpace {
    /// pyannote's own cluster centroid: the VBx-responsibility-weighted mean
    /// of the raw 256-d embeddings.
    Raw,
    /// Mean of the length-normalized 256-d embeddings assigned to the cluster.
    Unit,
    /// VBx-weighted mean of the 128-d PLDA features (x-vector transform, LDA,
    /// length normalization, PLDA whitening).
    Plda,
    /// As `Plda`, each dimension scaled by the square root of its
    /// between-speaker variance, so directions that do not separate speakers
    /// count for little.
    PldaWeighted,
}

impl SignatureSpace {
    pub(crate) const ALL: [SignatureSpace; 4] = [
        SignatureSpace::Raw,
        SignatureSpace::Unit,
        SignatureSpace::Plda,
        SignatureSpace::PldaWeighted,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            SignatureSpace::Raw => "raw",
            SignatureSpace::Unit => "unit",
            SignatureSpace::Plda => "plda",
            SignatureSpace::PldaWeighted => "pldaw",
        }
    }
}

/// The space remembered voices are stored and matched in.
///
/// pyannote's own centroid separated AMI speakers best of the four: at the
/// operating point with no false accepts over 3,254 different-speaker pairs it
/// kept 89.5% of same-speaker pairs, against 86.6% for unit-length means and
/// 82.6-87.2% for the PLDA means
/// (`artifacts/qa/voiceprint-community1-2026-10-21.md`).
pub(crate) const PRODUCT_SPACE: SignatureSpace = SignatureSpace::Raw;

/// One clustered speaker's signature (`None` when nothing could be
/// averaged) and its clean-window count.
pub(super) type ClusterSignature = (Option<Vec<f32>>, usize);

/// Signatures of every clustered speaker, indexed like `clustering.centroids`
/// (the cluster ids in `clustering.hard`), each unit length; `None` for a
/// speaker none of whose embeddings could be averaged. Also the number of
/// clean windows assigned to each speaker.
pub(super) fn cluster_signatures(
    space: SignatureSpace,
    clustering: &Clustering,
    embeddings: &[f32],
    plda: &Plda,
) -> Vec<ClusterSignature> {
    let emb = |c: usize, s: usize| -> &[f32] {
        let at = (c * LOCAL_SPEAKERS + s) * EMBEDDING_DIM;
        &embeddings[at..at + EMBEDDING_DIM]
    };
    let speakers = clustering.centroids.len();
    let assigned = |row: usize| -> Option<usize> {
        let (c, s) = clustering.train[row];
        usize::try_from(clustering.hard[c * LOCAL_SPEAKERS + s])
            .ok()
            .filter(|&k| k < speakers)
    };
    let mut windows = vec![0usize; speakers];
    for row in 0..clustering.train.len() {
        if let Some(k) = assigned(row) {
            windows[k] += 1;
        }
    }
    let projected: Vec<Vec<f64>> = match space {
        SignatureSpace::Plda | SignatureSpace::PldaWeighted => clustering
            .train
            .iter()
            .map(|&(c, s)| plda.project(emb(c, s)))
            .collect(),
        _ => Vec::new(),
    };

    (0..speakers)
        .map(|k| {
            let sum: Vec<f64> = match space {
                SignatureSpace::Raw => clustering.centroids[k].clone(),
                SignatureSpace::Unit => {
                    let mut sum = vec![0.0f64; EMBEDDING_DIM];
                    for row in (0..clustering.train.len()).filter(|&r| assigned(r) == Some(k)) {
                        let (c, s) = clustering.train[row];
                        let e = emb(c, s);
                        let norm = e
                            .iter()
                            .map(|&v| f64::from(v) * f64::from(v))
                            .sum::<f64>()
                            .sqrt();
                        if norm > 0.0 && norm.is_finite() {
                            for (out, &v) in sum.iter_mut().zip(e) {
                                *out += f64::from(v) / norm;
                            }
                        }
                    }
                    sum
                }
                SignatureSpace::Plda | SignatureSpace::PldaWeighted => {
                    let mut sum = vec![0.0f64; LDA_DIM];
                    if let Some(gamma) = &clustering.vbx_gamma {
                        let column = clustering.kept[k];
                        for (row, features) in projected.iter().enumerate() {
                            let weight = gamma[[row, column]];
                            for (out, &v) in sum.iter_mut().zip(features) {
                                *out += weight * v;
                            }
                        }
                    }
                    if space == SignatureSpace::PldaWeighted {
                        for (out, &phi) in sum.iter_mut().zip(&plda.phi) {
                            *out *= phi.max(0.0).sqrt();
                        }
                    }
                    sum
                }
            };
            (unit_f32(&sum), windows[k])
        })
        .collect()
}

fn unit_f32(values: &[f64]) -> Option<Vec<f32>> {
    let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
    (norm.is_finite() && norm > 1e-12).then(|| values.iter().map(|v| (v / norm) as f32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_vectors_are_normalized_and_degenerate_ones_refused() {
        let v = unit_f32(&[3.0, 4.0]).unwrap();
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        assert!(unit_f32(&[0.0, 0.0]).is_none());
        assert!(unit_f32(&[f64::NAN, 1.0]).is_none());
    }
}
