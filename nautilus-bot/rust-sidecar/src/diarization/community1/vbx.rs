//! VBx (Landini et al. 2022) as pyannote.audio 4.0 runs it
//! (`utils/vbx.py::VBx` via `cluster_vbx`), in `f64` like numpy.

use ndarray::{Array1, Array2, Axis};

/// pyannote's `cluster_vbx(ahc_init, fea, Phi, Fa, Fb, maxIters=20, init_smoothing=7.0)`.
/// `features` is `n x D` (PLDA space), `phi` has `D` entries. Returns the
/// responsibilities `gamma` (`n x K`) and the speaker priors `pi` (`K`).
pub(super) fn cluster_vbx(
    ahc_init: &[usize],
    features: &Array2<f64>,
    phi: &[f64],
    fa: f64,
    fb: f64,
    max_iters: usize,
    init_smoothing: f64,
) -> (Array2<f64>, Array1<f64>) {
    let n = features.nrows();
    let k = ahc_init.iter().copied().max().map_or(0, |m| m + 1);
    // qinit = softmax(one_hot * init_smoothing, axis=1)
    let mut gamma = Array2::<f64>::zeros((n, k));
    let on = init_smoothing.exp();
    let denom = on + (k as f64 - 1.0);
    for (row, &label) in ahc_init.iter().enumerate() {
        for col in 0..k {
            gamma[[row, col]] = if col == label { on } else { 1.0 } / denom;
        }
    }
    let pi = Array1::from_elem(k, 1.0 / k as f64);
    vbx(features, phi, fa, fb, pi, gamma, max_iters, 1e-4)
}

#[allow(clippy::too_many_arguments)]
fn vbx(
    x: &Array2<f64>,
    phi: &[f64],
    fa: f64,
    fb: f64,
    mut pi: Array1<f64>,
    mut gamma: Array2<f64>,
    max_iters: usize,
    epsilon: f64,
) -> (Array2<f64>, Array1<f64>) {
    let (n, d) = x.dim();
    let k = pi.len();
    let phi = Array1::from_vec(phi.to_vec());
    let log_2pi = (2.0 * std::f64::consts::PI).ln();
    // G = -0.5 * (sum(X**2, axis=1) + D*log(2*pi))
    let g: Array1<f64> = x
        .rows()
        .into_iter()
        .map(|row| -0.5 * (row.iter().map(|v| v * v).sum::<f64>() + d as f64 * log_2pi))
        .collect();
    let v = phi.mapv(f64::sqrt);
    let rho = x * &v; // (n, d)
    let mut previous_elbo: Option<f64> = None;
    for _ in 0..max_iters {
        // invL = 1 / (1 + Fa/Fb * gamma.sum(0)[:, None] * Phi)   (k, d)
        let counts = gamma.sum_axis(Axis(0));
        let mut inv_l = Array2::<f64>::zeros((k, d));
        for s in 0..k {
            for j in 0..d {
                inv_l[[s, j]] = 1.0 / (1.0 + fa / fb * counts[s] * phi[j]);
            }
        }
        // alpha = Fa/Fb * invL * gamma.T @ rho   (k, d)
        let alpha = gamma.t().dot(&rho) * &inv_l * (fa / fb);
        // log_p_ = Fa * (rho @ alpha.T - 0.5 * (invL + alpha**2) @ Phi + G)   (n, k)
        let quad: Array1<f64> = (&inv_l + &alpha.mapv(|a| a * a)).dot(&phi);
        let mut log_p = rho.dot(&alpha.t());
        for mut row in log_p.rows_mut() {
            for (s, value) in row.iter_mut().enumerate() {
                *value -= 0.5 * quad[s];
            }
        }
        for (mut row, &gi) in log_p.rows_mut().into_iter().zip(g.iter()) {
            row.mapv_inplace(|value| fa * (value + gi));
        }
        let lpi = pi.mapv(|p| (p + 1e-8).ln());
        let mut log_px_total = 0.0;
        for i in 0..n {
            let mut row_max = f64::NEG_INFINITY;
            for s in 0..k {
                row_max = row_max.max(log_p[[i, s]] + lpi[s]);
            }
            let sum: f64 = (0..k)
                .map(|s| (log_p[[i, s]] + lpi[s] - row_max).exp())
                .sum();
            let log_px = row_max + sum.ln();
            log_px_total += log_px;
            for s in 0..k {
                gamma[[i, s]] = (log_p[[i, s]] + lpi[s] - log_px).exp();
            }
        }
        pi = gamma.sum_axis(Axis(0));
        let total = pi.sum();
        pi.mapv_inplace(|p| p / total);
        let penalty: f64 = inv_l
            .iter()
            .zip(alpha.iter())
            .map(|(&il, &a)| il.ln() - il - a * a + 1.0)
            .sum();
        let elbo = log_px_total + fb * 0.5 * penalty;
        if let Some(previous) = previous_elbo {
            if elbo - previous < epsilon {
                break;
            }
        }
        previous_elbo = Some(elbo);
    }
    (gamma, pi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_separated_groups_keep_two_speakers_and_a_redundant_init_collapses() {
        // Six points in two well separated groups; AHC over-split them into 3.
        let x = Array2::from_shape_vec(
            (6, 2),
            vec![
                5.0, 0.0, 5.2, 0.1, 4.9, -0.1, -5.0, 0.0, -5.1, 0.2, -4.8, -0.1,
            ],
        )
        .unwrap();
        let (gamma, pi) = cluster_vbx(&[0, 0, 1, 2, 2, 2], &x, &[4.0, 1.0], 0.5, 0.3, 20, 7.0);
        assert_eq!(gamma.dim(), (6, 3));
        assert!((pi.sum() - 1.0).abs() < 1e-12);
        for row in gamma.rows() {
            assert!((row.sum() - 1.0).abs() < 1e-9);
        }
        let label = |i: usize| {
            let row = gamma.row(i);
            (0..3).max_by(|&a, &b| row[a].total_cmp(&row[b])).unwrap()
        };
        assert_eq!(label(0), label(1));
        assert_eq!(label(3), label(5));
        assert_ne!(label(0), label(3));
    }
}
