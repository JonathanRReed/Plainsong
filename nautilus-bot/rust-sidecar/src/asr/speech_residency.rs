//! Route-aware speech residency. CPU Core ML stays ready for 30 minutes on
//! Light-tier Macs; other routes retain their tier defaults. Explicit timers
//! override Automatic, but idle models always yield to memory pressure and
//! heavy native work. A runtime's lock protects every load and decode.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use crate::hardware_tier::{self, HardwareTier};
use crate::memory_pressure::MemoryPressure;

/// Seconds; `u64::MAX` means Always, `0` means Automatic.
static KEEP_READY_SECS: AtomicU64 = AtomicU64::new(0);
const ALWAYS: u64 = u64::MAX;

pub const KEEP_READY_CHOICES: [&str; 7] = ["auto", "2m", "5m", "10m", "30m", "1h", "always"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SpeechRoute {
    CoreMlCpu,
    Other,
}

/// These models use this timer rather than the older dictation keep-warm switch.
pub(crate) fn manages_route(provider: super::AsrProviderType, model_id: &str) -> bool {
    if provider == super::AsrProviderType::Parakeet {
        return matches!(model_id, "parakeet-tdt-0.6b-v2" | "parakeet-tdt-0.6b-v3");
    }
    #[cfg(feature = "asr-transcribe-cpp")]
    if provider == super::AsrProviderType::TranscribeCpp {
        return model_id == super::transcribe_cpp::PARAKEET_GGUF_MODEL_ID;
    }
    false
}

pub fn normalize_keep_ready(value: &str) -> String {
    let trimmed = value.trim();
    if KEEP_READY_CHOICES.contains(&trimmed) {
        trimmed.to_string()
    } else {
        "auto".to_string()
    }
}

fn parse_secs(value: &str) -> u64 {
    match normalize_keep_ready(value).as_str() {
        "2m" => 2 * 60,
        "5m" => 5 * 60,
        "10m" => 10 * 60,
        "30m" => 30 * 60,
        "1h" => 60 * 60,
        "always" => ALWAYS,
        _ => 0,
    }
}

/// Apply a changed timer without waiting for the next periodic check. Saving
/// an unrelated preference does not disturb a resident model.
pub fn set_keep_ready(value: &str) {
    let secs = parse_secs(value);
    if KEEP_READY_SECS.swap(secs, Ordering::AcqRel) != secs {
        crate::model_residency::wake();
    }
}

fn keep_ready_for(secs: u64, tier: HardwareTier, route: SpeechRoute) -> Option<Duration> {
    match secs {
        ALWAYS => None,
        0 if tier == HardwareTier::Light && route == SpeechRoute::CoreMlCpu => {
            Some(Duration::from_secs(30 * 60))
        }
        0 => Some(tier.speech_model_idle_release()),
        secs => Some(Duration::from_secs(secs)),
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ReleasePolicy {
    secs: u64,
    tier: HardwareTier,
    pressure: MemoryPressure,
}

impl ReleasePolicy {
    pub(crate) fn current(pressure: MemoryPressure) -> Self {
        Self {
            secs: KEEP_READY_SECS.load(Ordering::Acquire),
            tier: hardware_tier::current(),
            pressure,
        }
    }

    /// Pressure overrides even Always. At warning, recently used models get
    /// a minute; critical releases as soon as their request lock is free.
    pub(crate) fn release_after(self, route: SpeechRoute) -> Option<Duration> {
        let keep = keep_ready_for(self.secs, self.tier, route);
        match self.pressure {
            MemoryPressure::Normal => keep,
            MemoryPressure::Warning => {
                Some(keep.unwrap_or(Duration::MAX).min(Duration::from_secs(60)))
            }
            MemoryPressure::Critical => Some(Duration::ZERO),
        }
    }
}

/// Automatic loads on demand. Only Always prewarms at startup.
pub fn startup_prewarm_allowed() -> bool {
    KEEP_READY_SECS.load(Ordering::Acquire) == ALWAYS
}

pub fn ensure_idle_release() {
    static REGISTRATION: OnceLock<std::sync::Arc<crate::model_residency::IdleModel>> =
        OnceLock::new();
    REGISTRATION.get_or_init(|| {
        crate::model_residency::register(1536 * 1024 * 1024, |policy| {
            release_idle_runtimes(ReleasePolicy::current(policy.pressure));
        })
    });
}

fn release_idle_runtimes(policy: ReleasePolicy) {
    if let Some(keep) = policy.release_after(SpeechRoute::Other) {
        if super::parakeet::release_tdt_runtime_if_idle(keep) {
            tracing::info!("Released the unused speech model");
        }
        #[cfg(feature = "asr-transcribe-cpp")]
        if super::transcribe_cpp::release_parakeet_runtime_if_idle(keep) {
            tracing::info!("Released the unused speech model");
        }
    }
    #[cfg(feature = "asr-transcribe-cpp")]
    if super::neural_engine::release_if_idle(policy) {
        tracing::info!("Released the unused speech helper");
    }
}

/// Before notes, cleanup, search or speaker-model admission, discard unused
/// speech regardless of the timer. Busy speech keeps its lock and is left
/// alone; native admission still checks the heavy job's remaining headroom.
pub(crate) fn release_for_heavy_work() {
    if crate::llm::speech_priority::speech_active() {
        return;
    }
    release_idle_runtimes(ReleasePolicy::current(MemoryPressure::Critical));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_values_follow_auto() {
        assert_eq!(normalize_keep_ready("forever"), "auto");
        assert_eq!(normalize_keep_ready(" 5m "), "5m");
        assert_eq!(normalize_keep_ready("always"), "always");
    }

    #[test]
    fn light_auto_keeps_cpu_speech_for_thirty_minutes() {
        assert_eq!(
            keep_ready_for(0, HardwareTier::Light, SpeechRoute::CoreMlCpu),
            Some(Duration::from_secs(1800))
        );
    }

    #[test]
    fn route_setting_tier_matrix_preserves_other_routes_and_explicit_choices() {
        for (tier, default) in [
            (HardwareTier::Light, 120),
            (HardwareTier::Balanced, 300),
            (HardwareTier::Best, 600),
        ] {
            for route in [SpeechRoute::CoreMlCpu, SpeechRoute::Other] {
                for (choice, secs) in [
                    ("2m", 120),
                    ("5m", 300),
                    ("10m", 600),
                    ("30m", 1800),
                    ("1h", 3600),
                ] {
                    assert_eq!(
                        keep_ready_for(parse_secs(choice), tier, route),
                        Some(Duration::from_secs(secs))
                    );
                }
                assert_eq!(keep_ready_for(ALWAYS, tier, route), None);
                let expected = if tier == HardwareTier::Light && route == SpeechRoute::CoreMlCpu {
                    1800
                } else {
                    default
                };
                assert_eq!(
                    keep_ready_for(0, tier, route),
                    Some(Duration::from_secs(expected))
                );
            }
        }
    }

    #[test]
    fn pressure_overrides_every_setting_and_recovers_without_losing_it() {
        for tier in [
            HardwareTier::Light,
            HardwareTier::Balanced,
            HardwareTier::Best,
        ] {
            for route in [SpeechRoute::CoreMlCpu, SpeechRoute::Other] {
                for choice in KEEP_READY_CHOICES {
                    let mut policy = ReleasePolicy {
                        secs: parse_secs(choice),
                        tier,
                        pressure: MemoryPressure::Normal,
                    };
                    let normal = policy.release_after(route);
                    policy.pressure = MemoryPressure::Warning;
                    assert_eq!(policy.release_after(route), Some(Duration::from_secs(60)));
                    policy.pressure = MemoryPressure::Critical;
                    assert_eq!(policy.release_after(route), Some(Duration::ZERO));
                    policy.pressure = MemoryPressure::Normal;
                    assert_eq!(policy.release_after(route), normal);
                }
            }
        }
    }
}
