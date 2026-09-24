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

/// Prior for one pre-insert AI pass. Bundled cleanup measured ~414 ms p50 on
/// Metal; remote passes are budgeted up to 2.5 s.
const POLISH_PRIOR_MS: f64 = 700.0;

/// Clamp so a pathological sample (a cold model load, a stalled network)
/// cannot make the next bar crawl for a minute.
const MIN_EXPECTED_MS: u64 = 150;
const MAX_EXPECTED_MS: u64 = 30_000;

#[derive(Default)]
struct Estimator {
    asr_ms_per_second: HashMap<String, f64>,
    polish_ms: Option<f64>,
}

static ESTIMATOR: LazyLock<Mutex<Estimator>> = LazyLock::new(|| Mutex::new(Estimator::default()));

fn blend(previous: Option<f64>, sample: f64) -> f64 {
    match previous {
        Some(previous) => previous + EWMA_ALPHA * (sample - previous),
        None => sample,
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
        .unwrap_or(if is_cloud {
            CLOUD_ASR_PRIOR_MS_PER_SECOND
        } else {
            LOCAL_ASR_PRIOR_MS_PER_SECOND
        });
    clamp_ms(rate * (audio_seconds.max(0.0) + ASR_OVERHEAD_SECONDS))
}

pub(crate) fn record_transcribe_ms(route_key: &str, audio_seconds: f64, measured_ms: u64) {
    let sample = measured_ms as f64 / (audio_seconds.max(0.0) + ASR_OVERHEAD_SECONDS);
    if let Ok(mut estimator) = ESTIMATOR.lock() {
        let previous = estimator.asr_ms_per_second.get(route_key).copied();
        estimator
            .asr_ms_per_second
            .insert(route_key.to_string(), blend(previous, sample));
    }
}

/// Expected time for one pre-insert AI pass.
pub(crate) fn expected_polish_ms() -> u64 {
    let learned = ESTIMATOR
        .lock()
        .ok()
        .and_then(|estimator| estimator.polish_ms);
    clamp_ms(learned.unwrap_or(POLISH_PRIOR_MS))
}

pub(crate) fn record_polish_ms(measured_ms: u64) {
    if let Ok(mut estimator) = ESTIMATOR.lock() {
        estimator.polish_ms = Some(blend(estimator.polish_ms, measured_ms as f64));
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
    fn a_measurement_replaces_the_prior_and_later_ones_blend() {
        let key = "test-learn:model";
        record_transcribe_ms(key, 9.0, 1000);
        assert_eq!(expected_transcribe_ms(key, false, 9.0), 1000);
        record_transcribe_ms(key, 9.0, 2000);
        // 100 ms/s blended 35% toward 200 ms/s = 135 ms/s over 10 s.
        assert_eq!(expected_transcribe_ms(key, false, 9.0), 1350);
    }

    #[test]
    fn estimates_stay_inside_the_clamp() {
        let key = "test-clamp:model";
        record_transcribe_ms(key, 0.0, 10_000_000);
        assert_eq!(expected_transcribe_ms(key, false, 600.0), MAX_EXPECTED_MS);
        assert_eq!(
            expected_transcribe_ms("test-clamp:tiny", false, 0.0),
            MIN_EXPECTED_MS
        );
    }
}
