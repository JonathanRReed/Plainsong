//! Expected durations for the dictation finishing bar.
//!
//! After the user stops speaking the HUD shows a progress bar that fills
//! toward the expected finish time, slows as it gets close, and only reaches
//! the end when the text actually lands. This module supplies the expected
//! times. It never decides when a stage is done; the real stage events do.
//!
//! Estimates are a moving average of what this Mac actually measured, keyed
//! by ASR route, so the bar learns each engine's speed after a few
//! dictations. Before there is a measurement it falls back to a conservative
//! prior. Nothing is persisted: a fresh launch relearns within a few
//! dictations, and there is no timing history on disk to explain.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Weight of the newest sample. High enough that a model switch settles in
/// three or four dictations, low enough that one slow outlier does not undo
/// a stable average.
const EWMA_ALPHA: f64 = 0.35;

/// ASR cost is modeled as `rate * (audio_seconds + 1)`. The extra second
/// stands in for fixed overhead (model call, feature extraction, network
/// round trip), which dominates short utterances.
const ASR_OVERHEAD_SECONDS: f64 = 1.0;

/// Priors in milliseconds per (audio second + overhead). Local Parakeet on
/// Apple Silicon decodes 5 s of speech in roughly 100-200 ms; cloud routes
/// add upload and queueing.
const LOCAL_ASR_PRIOR_MS_PER_SECOND: f64 = 60.0;
const CLOUD_ASR_PRIOR_MS_PER_SECOND: f64 = 220.0;

/// Priors for the pre-insert AI stage. Bundled cleanup measured ~414 ms p50
/// on Metal; remote passes add a network round trip and are budgeted up to
/// 2.5 s.
const LOCAL_POLISH_PRIOR_MS: f64 = 600.0;
const REMOTE_POLISH_PRIOR_MS: f64 = 1100.0;

/// Clamp so a pathological sample (a cold model load, a stalled network)
/// cannot make the next bar crawl for a minute.
const MIN_EXPECTED_MS: u64 = 150;
const MAX_EXPECTED_MS: u64 = 30_000;

#[derive(Default)]
struct Estimator {
    asr_ms_per_second: HashMap<String, f64>,
    /// Keyed by whether the AI provider is remote: a local and a cloud model
    /// differ by far more than one average can describe.
    polish_ms: HashMap<bool, f64>,
}

static ESTIMATOR: LazyLock<Mutex<Estimator>> = LazyLock::new(|| Mutex::new(Estimator::default()));

/// The prior counts as the first observation, so one cold model load or
/// network stall moves the estimate part of the way, not all of it.
fn blend(previous: f64, sample: f64) -> f64 {
    previous + EWMA_ALPHA * (sample - previous)
}

fn asr_prior(is_cloud: bool) -> f64 {
    if is_cloud {
        CLOUD_ASR_PRIOR_MS_PER_SECOND
    } else {
        LOCAL_ASR_PRIOR_MS_PER_SECOND
    }
}

fn polish_prior(remote: bool) -> f64 {
    if remote {
        REMOTE_POLISH_PRIOR_MS
    } else {
        LOCAL_POLISH_PRIOR_MS
    }
}

fn clamp_ms(value: f64) -> u64 {
    if !value.is_finite() {
        return MIN_EXPECTED_MS;
    }
    (value.round().max(0.0) as u64).clamp(MIN_EXPECTED_MS, MAX_EXPECTED_MS)
}

pub(crate) fn asr_route_key(provider: &str, model_id: Option<&str>) -> String {
    format!("{}:{}", provider, model_id.unwrap_or(""))
}

/// Expected ASR time for `audio_seconds` of speech on `route_key`.
pub(crate) fn expected_transcribe_ms(route_key: &str, is_cloud: bool, audio_seconds: f64) -> u64 {
    let rate = ESTIMATOR
        .lock()
        .ok()
        .and_then(|estimator| estimator.asr_ms_per_second.get(route_key).copied())
        .unwrap_or_else(|| asr_prior(is_cloud));
    clamp_ms(rate * (audio_seconds.max(0.0) + ASR_OVERHEAD_SECONDS))
}

pub(crate) fn record_transcribe_ms(
    route_key: &str,
    is_cloud: bool,
    audio_seconds: f64,
    measured_ms: u64,
) {
    let sample = measured_ms as f64 / (audio_seconds.max(0.0) + ASR_OVERHEAD_SECONDS);
    if let Ok(mut estimator) = ESTIMATOR.lock() {
        let previous = estimator
            .asr_ms_per_second
            .get(route_key)
            .copied()
            .unwrap_or_else(|| asr_prior(is_cloud));
        estimator
            .asr_ms_per_second
            .insert(route_key.to_string(), blend(previous, sample));
    }
}

/// Expected time for the pre-insert AI stage on a local or remote provider.
pub(crate) fn expected_polish_ms(remote: bool) -> u64 {
    let learned = ESTIMATOR
        .lock()
        .ok()
        .and_then(|estimator| estimator.polish_ms.get(&remote).copied());
    clamp_ms(learned.unwrap_or_else(|| polish_prior(remote)))
}

pub(crate) fn record_polish_ms(remote: bool, measured_ms: u64) {
    if let Ok(mut estimator) = ESTIMATOR.lock() {
        let previous = estimator
            .polish_ms
            .get(&remote)
            .copied()
            .unwrap_or_else(|| polish_prior(remote));
        estimator
            .polish_ms
            .insert(remote, blend(previous, measured_ms as f64));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmeasured_routes_use_the_local_or_cloud_prior() {
        let local = expected_transcribe_ms("test-prior:local", false, 4.0);
        let cloud = expected_transcribe_ms("test-prior:cloud", true, 4.0);
        assert_eq!(local, 300);
        assert_eq!(cloud, 1100);
    }

    #[test]
    fn measurements_blend_from_the_prior_so_one_outlier_moves_it_partway() {
        let key = "test-learn:model";
        record_transcribe_ms(key, false, 9.0, 1000);
        // Prior 60 ms/s blended 35% toward 100 ms/s = 74 ms/s over 10 s.
        assert_eq!(expected_transcribe_ms(key, false, 9.0), 740);
        record_transcribe_ms(key, false, 9.0, 2000);
        // 74 blended 35% toward 200 = 118.1 ms/s.
        assert_eq!(expected_transcribe_ms(key, false, 9.0), 1181);
    }

    #[test]
    fn local_and_remote_polish_estimates_are_kept_apart() {
        assert_eq!(expected_polish_ms(true), 1100);
        record_polish_ms(false, 400);
        assert_eq!(expected_polish_ms(false), 530);
        assert_eq!(expected_polish_ms(true), 1100);
    }

    #[test]
    fn estimates_stay_inside_the_clamp() {
        let key = "test-clamp:model";
        for _ in 0..40 {
            record_transcribe_ms(key, false, 0.0, 10_000_000);
        }
        assert_eq!(expected_transcribe_ms(key, false, 600.0), MAX_EXPECTED_MS);
        assert_eq!(
            expected_transcribe_ms("test-clamp:tiny", false, 0.0),
            MIN_EXPECTED_MS
        );
    }
}
