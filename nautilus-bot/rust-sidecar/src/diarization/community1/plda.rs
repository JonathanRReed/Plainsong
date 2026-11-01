//! community-1's x-vector transform and PLDA, ported from pyannote.audio 4.0
//! `utils/vbx.py::vbx_setup` and `core/plda.py`.
//!
//! The two archives hold upstream's bytes unchanged. The one piece of linear
//! algebra pyannote does at load time, `scipy.linalg.eigh(B, W)`, is solved
//! here by Cholesky reduction plus cyclic Jacobi in `f64` (no BLAS/LAPACK).
//! Eigenvector signs are free in any solver; VBx is invariant to them because
//! its prior is a zero-mean diagonal Gaussian, so the clustering does not
//! depend on which sign either solver picks.

use anyhow::{bail, Result};
use std::path::Path;

use super::npy::read_npz;

/// Embedding dimension of the WeSpeaker ResNet34 head.
pub(super) const EMBEDDING_DIM: usize = 256;
/// PLDA / LDA dimension (`PLDA.lda_dimension`).
pub(super) const LDA_DIM: usize = 128;

#[derive(Debug, Clone)]
pub(super) struct Plda {
    mean1: Vec<f64>,
    mean2: Vec<f64>,
    /// `lda`, `EMBEDDING_DIM x LDA_DIM`, row-major.
    lda: Vec<f64>,
    mu: Vec<f64>,
    /// Rows are the generalized eigenvectors in descending eigenvalue order
    /// (`wccn.T[::-1]`), `LDA_DIM x LDA_DIM`.
    transform: Vec<f64>,
    /// Between-class variances in PLDA space, descending (`plda.phi`).
    pub phi: Vec<f64>,
}

impl Plda {
    pub(super) fn load(xvec_transform: &Path, plda: &Path) -> Result<Self> {
        let x = read_npz(
            xvec_transform,
            super::bundle_pin(super::XVEC_TRANSFORM_FILE)?,
            &["mean1", "mean2", "lda"],
        )?;
        let p = read_npz(
            plda,
            super::bundle_pin(super::PLDA_FILE)?,
            &["mu", "tr", "psi"],
        )?;
        let (mean1, mean2, lda) = (&x[0], &x[1], &x[2]);
        let (mu, tr, psi) = (&p[0], &p[1], &p[2]);
        if mean1.shape != [EMBEDDING_DIM]
            || mean2.shape != [LDA_DIM]
            || lda.shape != [EMBEDDING_DIM, LDA_DIM]
            || mu.shape != [LDA_DIM]
            || tr.shape != [LDA_DIM, LDA_DIM]
            || psi.shape != [LDA_DIM]
        {
            bail!("community-1 PLDA arrays have unexpected shapes");
        }
        Self::from_parts(
            mean1.data.clone(),
            mean2.data.clone(),
            lda.data.clone(),
            mu.data.clone(),
            &tr.data,
            &psi.data,
        )
    }

    fn from_parts(
        mean1: Vec<f64>,
        mean2: Vec<f64>,
        lda: Vec<f64>,
        mu: Vec<f64>,
        tr: &[f64],
        psi: &[f64],
    ) -> Result<Self> {
        let n = LDA_DIM;
        if psi.iter().any(|v| !(v.is_finite() && *v > 0.0)) {
            bail!("community-1 PLDA psi must be positive");
        }
        // W = inv(tr.T @ tr); B = inv((tr.T / psi) @ tr)
        let mut trt_tr = vec![0.0; n * n];
        let mut trt_psi_tr = vec![0.0; n * n];
        for i in 0..n {
            for k in 0..n {
                let (mut a, mut b) = (0.0, 0.0);
                for j in 0..n {
                    let t = tr[j * n + i] * tr[j * n + k];
                    a += t;
                    b += t / psi[j];
                }
                trt_tr[i * n + k] = a;
                trt_psi_tr[i * n + k] = b;
            }
        }
        let w = invert(&trt_tr, n)?;
        let b = invert(&trt_psi_tr, n)?;
        let (values, vectors) = generalized_eigh(&b, &w, n)?;
        // eigh returns ascending order; pyannote reverses both.
        let mut transform = vec![0.0; n * n];
        let mut phi = vec![0.0; n];
        for row in 0..n {
            let column = n - 1 - row;
            phi[row] = values[column];
            for j in 0..n {
                transform[row * n + j] = vectors[j * n + column];
            }
        }
        Ok(Self {
            mean1,
            mean2,
            lda,
            mu,
            transform,
            phi,
        })
    }

    /// `plda_tf(xvec_tf(x))` for one raw embedding.
    pub(super) fn project(&self, embedding: &[f32]) -> Vec<f64> {
        let mut centred: Vec<f64> = embedding
            .iter()
            .zip(&self.mean1)
            .map(|(&x, &m)| f64::from(x) - m)
            .collect();
        scale_to_norm(&mut centred, (EMBEDDING_DIM as f64).sqrt());
        let mut reduced = vec![0.0; LDA_DIM];
        for (i, &value) in centred.iter().enumerate() {
            let row = &self.lda[i * LDA_DIM..(i + 1) * LDA_DIM];
            for (out, &weight) in reduced.iter_mut().zip(row) {
                *out += weight * value;
            }
        }
        for (value, mean) in reduced.iter_mut().zip(&self.mean2) {
            *value -= mean;
        }
        scale_to_norm(&mut reduced, (LDA_DIM as f64).sqrt());
        for (value, mean) in reduced.iter_mut().zip(&self.mu) {
            *value -= mean;
        }
        (0..LDA_DIM)
            .map(|row| {
                self.transform[row * LDA_DIM..(row + 1) * LDA_DIM]
                    .iter()
                    .zip(&reduced)
                    .map(|(a, b)| a * b)
                    .sum()
            })
            .collect()
    }
}

/// `scale * v / ||v||`.
fn scale_to_norm(values: &mut [f64], scale: f64) {
    let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
    for value in values {
        *value = scale * *value / norm;
    }
}

/// Inverse by Gauss-Jordan elimination with partial pivoting.
pub(super) fn invert(matrix: &[f64], n: usize) -> Result<Vec<f64>> {
    let mut a = matrix.to_vec();
    let mut inv = vec![0.0; n * n];
    for i in 0..n {
        inv[i * n + i] = 1.0;
    }
    for col in 0..n {
        let pivot = (col..n)
            .max_by(|&x, &y| a[x * n + col].abs().total_cmp(&a[y * n + col].abs()))
            .expect("non-empty range");
        if a[pivot * n + col].abs() < 1e-300 {
            bail!("singular matrix");
        }
        if pivot != col {
            for j in 0..n {
                a.swap(pivot * n + j, col * n + j);
                inv.swap(pivot * n + j, col * n + j);
            }
        }
        let d = a[col * n + col];
        for j in 0..n {
            a[col * n + j] /= d;
            inv[col * n + j] /= d;
        }
        for row in 0..n {
            if row == col {
                continue;
            }
            let f = a[row * n + col];
            if f == 0.0 {
                continue;
            }
            for j in 0..n {
                a[row * n + j] -= f * a[col * n + j];
                inv[row * n + j] -= f * inv[col * n + j];
            }
        }
    }
    Ok(inv)
}

/// Solve `B v = λ W v` for symmetric `B` and symmetric positive-definite `W`.
/// Returns ascending eigenvalues and the eigenvectors as columns of a
/// row-major `n x n` matrix, normalized so `Vᵀ W V = I` (scipy's convention).
pub(super) fn generalized_eigh(b: &[f64], w: &[f64], n: usize) -> Result<(Vec<f64>, Vec<f64>)> {
    // W = L Lᵀ
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut sum = (w[i * n + j] + w[j * n + i]) / 2.0;
            for k in 0..j {
                sum -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if sum <= 0.0 {
                    bail!("matrix is not positive definite");
                }
                l[i * n + i] = sum.sqrt();
            } else {
                l[i * n + j] = sum / l[j * n + j];
            }
        }
    }
    let l_inv = lower_inverse(&l, n);
    // C = L⁻¹ B L⁻ᵀ
    let mut tmp = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..n {
            tmp[i * n + j] = (0..=i).map(|k| l_inv[i * n + k] * b[k * n + j]).sum();
        }
    }
    let mut c = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..n {
            c[i * n + j] = (0..=j).map(|k| tmp[i * n + k] * l_inv[j * n + k]).sum();
        }
    }
    for i in 0..n {
        for j in 0..i {
            let mean = (c[i * n + j] + c[j * n + i]) / 2.0;
            c[i * n + j] = mean;
            c[j * n + i] = mean;
        }
    }
    let (values, v) = jacobi_eigh(c, n);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| values[x].total_cmp(&values[y]));
    let mut sorted_values = vec![0.0; n];
    let mut vectors = vec![0.0; n * n];
    for (out_col, &col) in order.iter().enumerate() {
        sorted_values[out_col] = values[col];
        // x = L⁻ᵀ v
        for i in 0..n {
            vectors[i * n + out_col] = (i..n).map(|k| l_inv[k * n + i] * v[k * n + col]).sum();
        }
    }
    Ok((sorted_values, vectors))
}

fn lower_inverse(l: &[f64], n: usize) -> Vec<f64> {
    let mut inv = vec![0.0; n * n];
    for i in 0..n {
        inv[i * n + i] = 1.0 / l[i * n + i];
        for j in 0..i {
            let sum: f64 = (j..i).map(|k| l[i * n + k] * inv[k * n + j]).sum();
            inv[i * n + j] = -sum / l[i * n + i];
        }
    }
    inv
}

/// Cyclic Jacobi eigen-decomposition of a symmetric matrix. Returns the
/// eigenvalues (unordered) and the eigenvectors as columns.
fn jacobi_eigh(mut a: Vec<f64>, n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    for _sweep in 0..100 {
        let off: f64 = (0..n)
            .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| a[i * n + j] * a[i * n + j])
            .sum();
        let scale: f64 = (0..n).map(|i| a[i * n + i] * a[i * n + i]).sum();
        if off <= 1e-30 * scale.max(1e-300) {
            break;
        }
        for p in 0..n {
            for q in (p + 1)..n {
                let apq = a[p * n + q];
                if apq == 0.0 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let akp = a[k * n + p];
                    let akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let apk = a[p * n + k];
                    let aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for k in 0..n {
                    let vkp = v[k * n + p];
                    let vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    ((0..n).map(|i| a[i * n + i]).collect(), v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matmul(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
        let mut out = vec![0.0; n * n];
        for i in 0..n {
            for j in 0..n {
                out[i * n + j] = (0..n).map(|k| a[i * n + k] * b[k * n + j]).sum();
            }
        }
        out
    }

    fn pseudo_random(n: usize, seed: u64) -> Vec<f64> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((state >> 11) as f64 / (1u64 << 53) as f64) - 0.5
            })
            .collect()
    }

    #[test]
    fn inverse_times_matrix_is_identity() {
        let n = 12;
        let mut m = pseudo_random(n * n, 3);
        for i in 0..n {
            m[i * n + i] += 3.0;
        }
        let product = matmul(&m, &invert(&m, n).unwrap(), n);
        for i in 0..n {
            for j in 0..n {
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!((product[i * n + j] - expected).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn generalized_eigh_solves_the_pencil_with_w_orthonormal_vectors() {
        let n = 9;
        let r = pseudo_random(n * n, 7);
        let s = pseudo_random(n * n, 11);
        // B = R Rᵀ (symmetric), W = S Sᵀ + I (SPD)
        let mut b = vec![0.0; n * n];
        let mut w = vec![0.0; n * n];
        for i in 0..n {
            for j in 0..n {
                b[i * n + j] = (0..n).map(|k| r[i * n + k] * r[j * n + k]).sum();
                w[i * n + j] = (0..n).map(|k| s[i * n + k] * s[j * n + k]).sum::<f64>()
                    + if i == j { 1.0 } else { 0.0 };
            }
        }
        let (values, vectors) = generalized_eigh(&b, &w, n).unwrap();
        assert!(values.windows(2).all(|p| p[0] <= p[1]));
        for col in 0..n {
            let x: Vec<f64> = (0..n).map(|i| vectors[i * n + col]).collect();
            for i in 0..n {
                let bx: f64 = (0..n).map(|k| b[i * n + k] * x[k]).sum();
                let wx: f64 = (0..n).map(|k| w[i * n + k] * x[k]).sum();
                assert!(
                    (bx - values[col] * wx).abs() < 1e-10,
                    "column {col} row {i}"
                );
            }
            for other in 0..n {
                let y: Vec<f64> = (0..n).map(|i| vectors[i * n + other]).collect();
                let xwy: f64 = (0..n)
                    .map(|i| x[i] * (0..n).map(|k| w[i * n + k] * y[k]).sum::<f64>())
                    .sum();
                let expected = if other == col { 1.0 } else { 0.0 };
                assert!((xwy - expected).abs() < 1e-10);
            }
        }
    }
}
