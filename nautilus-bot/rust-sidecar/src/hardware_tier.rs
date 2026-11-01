//! The one place that decides how much of this Mac Plainsong may use.
//!
//! Plainsong runs beside the apps people already have open: a call app, a
//! browser, chat. On an 8 GB Mac that leaves roughly 1.5-2 GB for everything
//! Plainsong does, so model choices, warm-keeping and admission all start from
//! the tier here instead of from whatever happens to be free at the moment.
//!
//! The budgets are the packaged app's total `phys_footprint` (every process)
//! in each state. `qa:packaged:macos:footprint` fails a candidate that exceeds
//! them, so they are release limits, not hints.

/// Simulates a smaller Mac for QA: the physical memory, in GB, that tiering
/// and memory admission see instead of `hw.memsize`. Lets an 8 GB MacBook be
/// exercised on a larger development Mac.
pub const SIMULATED_PHYSICAL_MEMORY_ENV: &str = "PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB";

/// Simulates the other apps on that smaller Mac for QA: the free memory, in
/// GB, that a call app, browser and chat leave when the sidecar starts.
/// Honoured only beside [`SIMULATED_PHYSICAL_MEMORY_ENV`], so it cannot change
/// a real Mac's admission on its own.
pub const SIMULATED_AVAILABLE_MEMORY_ENV: &str = "PLAINSONG_SIMULATE_AVAILABLE_GB";

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HardwareTier {
    /// 8 GB Macs (MacBook Neo and older 8 GB models).
    Light,
    /// 16 GB Macs.
    Balanced,
    /// 24 GB and up.
    Best,
}

/// Total app memory allowed in each state, for every process together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierBudget {
    pub idle_bytes: u64,
    pub dictation_bytes: u64,
    pub meeting_bytes: u64,
    pub notes_bytes: u64,
}

impl HardwareTier {
    /// Below 12 GiB is an 8 GB Mac; below 20 GiB a 16 GB Mac.
    pub fn for_physical_bytes(physical_bytes: u64) -> Self {
        if physical_bytes < 12 * GIB {
            Self::Light
        } else if physical_bytes < 20 * GIB {
            Self::Balanced
        } else {
            Self::Best
        }
    }

    /// Default speech timeout before route-specific residency adjustments.
    /// `asr::speech_residency` extends Light-tier CPU Core ML to 30 minutes.
    /// Explicit choices in "Keep speech model ready for" override both.
    pub fn speech_model_idle_release(self) -> std::time::Duration {
        let minutes = match self {
            Self::Light => 2,
            Self::Balanced => 5,
            Self::Best => 10,
        };
        std::time::Duration::from_secs(minutes * 60)
    }

    pub fn budget(self) -> TierBudget {
        match self {
            Self::Light => TierBudget {
                idle_bytes: 300 * MIB,
                dictation_bytes: GIB,
                meeting_bytes: 3 * GIB / 2,
                notes_bytes: 5 * GIB / 2,
            },
            Self::Balanced => TierBudget {
                idle_bytes: 400 * MIB,
                dictation_bytes: 3 * GIB / 2,
                meeting_bytes: 2 * GIB,
                notes_bytes: 4 * GIB,
            },
            Self::Best => TierBudget {
                idle_bytes: 500 * MIB,
                dictation_bytes: 2 * GIB,
                meeting_bytes: 3 * GIB,
                notes_bytes: 7 * GIB,
            },
        }
    }

    /// Whether one background model claiming `background_bytes` may keep
    /// running beside live speech: the speech state's whole budget plus the
    /// background claim must stay inside the notes budget, the largest this
    /// tier allows. Otherwise the background work yields to speech.
    pub fn background_fits_beside_speech(self, speech: SpeechUse, background_bytes: u64) -> bool {
        let budget = self.budget();
        let speech_bytes = match speech {
            SpeechUse::Dictation => budget.dictation_bytes,
            SpeechUse::Meeting => budget.meeting_bytes,
        };
        speech_bytes
            .checked_add(background_bytes)
            .is_some_and(|total| total <= budget.notes_bytes)
    }
}

/// Live speech that takes precedence over background model work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechUse {
    Dictation,
    Meeting,
}

/// The simulated size from the environment, if set to a positive number.
fn simulated_physical_bytes(value: Option<&str>) -> Option<u64> {
    let gb: f64 = value?.trim().parse().ok()?;
    (gb.is_finite() && gb > 0.0).then_some((gb * GIB as f64) as u64)
}

#[cfg(target_os = "macos")]
fn measured_physical_bytes() -> Option<u64> {
    let mut value = 0_u64;
    let mut size = std::mem::size_of::<u64>();
    // The static name is NUL-terminated. Only correctly sized local storage
    // is writable, and no new sysctl value is supplied.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
}

#[cfg(not(target_os = "macos"))]
fn measured_physical_bytes() -> Option<u64> {
    None
}

/// Physical memory as Plainsong should plan for it: the QA simulation when
/// set, otherwise the machine's own.
pub fn physical_memory_bytes() -> Option<u64> {
    simulated_physical_bytes(std::env::var(SIMULATED_PHYSICAL_MEMORY_ENV).ok().as_deref())
        .or_else(measured_physical_bytes)
}

/// The simulated starting free memory, only when a smaller Mac is simulated
/// too, and never more than that Mac's physical memory.
fn simulated_available_start(physical: Option<&str>, available: Option<&str>) -> Option<u64> {
    let physical = simulated_physical_bytes(physical)?;
    Some(simulated_physical_bytes(available)?.min(physical))
}

/// Free memory under the available-memory simulation. `start` is the
/// simulated free memory, `baseline` what this Mac really had free at the
/// first reading, and `measured` what it has free now. Whatever Plainsong
/// has taken since the first reading comes out of the simulated figure, so
/// a loaded model shrinks it as it would on the smaller Mac; memory this Mac
/// frees never lifts it above the start, and it never exceeds what is truly
/// free.
fn simulated_available_bytes(start: u64, baseline: u64, measured: u64) -> u64 {
    start
        .saturating_sub(baseline.saturating_sub(measured))
        .min(measured)
}

fn simulated_available_start_from_env() -> Option<u64> {
    simulated_available_start(
        std::env::var(SIMULATED_PHYSICAL_MEMORY_ENV).ok().as_deref(),
        std::env::var(SIMULATED_AVAILABLE_MEMORY_ENV)
            .ok()
            .as_deref(),
    )
}

/// Whether the QA available-memory simulation is in effect.
pub fn available_memory_simulated() -> bool {
    simulated_available_start_from_env().is_some()
}

/// Carries the sidecar's baseline to helper processes it starts, so their
/// readings also count what the sidecar loaded before they began.
pub const SIMULATED_AVAILABLE_BASELINE_ENV: &str = "PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES";

static AVAILABLE_BASELINE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

/// Applies the QA available-memory simulation, if set, to a reading of this
/// Mac's free memory. The baseline is the parent sidecar's, when it passed
/// one, or else the first reading in this process.
pub fn simulate_available_memory(measured: u64) -> u64 {
    let Some(start) = simulated_available_start_from_env() else {
        return measured;
    };
    let baseline = *AVAILABLE_BASELINE.get_or_init(|| {
        std::env::var(SIMULATED_AVAILABLE_BASELINE_ENV)
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(measured)
    });
    simulated_available_bytes(start, baseline, measured)
}

/// The baseline a helper process should inherit, once one has been taken.
pub fn available_memory_simulation_baseline() -> Option<u64> {
    available_memory_simulated()
        .then(|| AVAILABLE_BASELINE.get().copied())
        .flatten()
}

/// This Mac's tier. Unknown memory plans for the smallest Mac.
pub fn current() -> HardwareTier {
    physical_memory_bytes().map_or(HardwareTier::Light, HardwareTier::for_physical_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_sizes_map_to_tiers() {
        assert_eq!(
            HardwareTier::for_physical_bytes(8 * GIB),
            HardwareTier::Light
        );
        assert_eq!(
            HardwareTier::for_physical_bytes(16 * GIB),
            HardwareTier::Balanced
        );
        assert_eq!(
            HardwareTier::for_physical_bytes(18 * GIB),
            HardwareTier::Balanced
        );
        assert_eq!(
            HardwareTier::for_physical_bytes(24 * GIB),
            HardwareTier::Best
        );
        assert_eq!(
            HardwareTier::for_physical_bytes(36 * GIB),
            HardwareTier::Best
        );
    }

    #[test]
    fn simulation_accepts_positive_sizes_only() {
        assert_eq!(simulated_physical_bytes(Some("8")), Some(8 * GIB));
        assert_eq!(simulated_physical_bytes(Some(" 16 ")), Some(16 * GIB));
        assert_eq!(simulated_physical_bytes(Some("0")), None);
        assert_eq!(simulated_physical_bytes(Some("-8")), None);
        assert_eq!(simulated_physical_bytes(Some("lots")), None);
        assert_eq!(simulated_physical_bytes(None), None);
    }

    #[test]
    fn available_simulation_needs_a_simulated_mac() {
        assert_eq!(simulated_available_start(None, Some("2.5")), None);
        assert_eq!(simulated_available_start(Some("lots"), Some("2.5")), None);
        assert_eq!(simulated_available_start(Some("8"), None), None);
        assert_eq!(simulated_available_start(Some("8"), Some("0")), None);
        assert_eq!(
            simulated_available_start(Some("8"), Some("2.5")),
            Some(5 * GIB / 2)
        );
        assert_eq!(
            simulated_available_start(Some("8"), Some("12")),
            Some(8 * GIB)
        );
    }

    #[test]
    fn simulated_available_memory_falls_with_what_plainsong_loads() {
        let start = 5 * GIB / 2;
        let baseline = 40 * GIB;
        assert_eq!(simulated_available_bytes(start, baseline, baseline), start);
        // A 1 GiB speech model loaded on the real Mac leaves 1.5 GiB on the
        // simulated one.
        assert_eq!(
            simulated_available_bytes(start, baseline, baseline - GIB),
            3 * GIB / 2
        );
        // Memory the real Mac frees never lifts the simulated figure.
        assert_eq!(
            simulated_available_bytes(start, baseline, baseline + 8 * GIB),
            start
        );
        assert_eq!(
            simulated_available_bytes(start, baseline, baseline - 30 * GIB),
            0
        );
        // Never more than the real Mac truly has free.
        assert_eq!(simulated_available_bytes(start, 2 * GIB, GIB), GIB);
    }

    #[test]
    fn light_budgets_fit_an_8_gb_mac_beside_a_call() {
        let light = HardwareTier::Light.budget();
        assert_eq!(light.idle_bytes, 300 * MIB);
        assert_eq!(light.dictation_bytes, GIB);
        assert_eq!(light.meeting_bytes, 3 * GIB / 2);
        assert_eq!(light.notes_bytes, 5 * GIB / 2);
        for tier in [
            HardwareTier::Light,
            HardwareTier::Balanced,
            HardwareTier::Best,
        ] {
            let budget = tier.budget();
            assert!(budget.idle_bytes < budget.dictation_bytes);
            assert!(budget.dictation_bytes < budget.meeting_bytes);
            assert!(budget.meeting_bytes < budget.notes_bytes);
        }
    }

    #[test]
    fn only_the_largest_tier_keeps_notes_running_beside_speech() {
        // Measured notes helper claims (`native_text::requirement_bytes`).
        let light_notes = 1_927_364_608;
        let balanced_notes = 3_173_662_720;
        let best_notes = 3_902_210_048;
        for speech in [SpeechUse::Dictation, SpeechUse::Meeting] {
            assert!(!HardwareTier::Light.background_fits_beside_speech(speech, light_notes));
            assert!(!HardwareTier::Balanced.background_fits_beside_speech(speech, balanced_notes));
            assert!(HardwareTier::Best.background_fits_beside_speech(speech, best_notes));
        }
        assert!(!HardwareTier::Best.background_fits_beside_speech(SpeechUse::Meeting, u64::MAX));
    }
}
