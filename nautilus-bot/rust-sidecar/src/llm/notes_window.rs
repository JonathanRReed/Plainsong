//! Light-tier notes may borrow a smaller reserve while the person is away.
//! Unknown idle or power counters never authorize that reserve.
use super::bundled_local::CancelFlag;
use crate::{hardware_tier::HardwareTier, memory_pressure::MemoryPressure};
use std::cell::Cell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
#[cfg(any(target_os = "macos", test))]
use std::time::Instant;

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
pub(crate) const AWAY_RESERVE: u64 = 512 * 1024 * 1024;
const IDLE_SECONDS: u64 = 180;
const SAMPLE_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    all(not(target_os = "macos"), not(test)),
    expect(dead_code, reason = "Only macOS supplies idle and power counters.")
)]
pub(crate) enum Power {
    Ac,
    Battery { percent: u8, low_power: bool },
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Conditions {
    pub idle_seconds: Option<u64>,
    pub power: Option<Power>,
}

impl Conditions {
    pub(crate) fn away(self, tier: HardwareTier, pressure: MemoryPressure, speech: bool) -> bool {
        tier == HardwareTier::Light
            && pressure == MemoryPressure::Normal
            && !speech
            && self
                .idle_seconds
                .is_some_and(|seconds| seconds >= IDLE_SECONDS)
            && matches!(
                self.power,
                Some(
                    Power::Ac
                        | Power::Battery {
                            percent: 50..=100,
                            low_power: false
                        }
                )
            )
    }
}

pub(crate) fn pressure_stops(tier: HardwareTier, pressure: MemoryPressure) -> bool {
    pressure == MemoryPressure::Critical
        || (tier == HardwareTier::Light && pressure == MemoryPressure::Warning)
}

pub(crate) fn conditions() -> Conditions {
    #[cfg(test)]
    if let Some(conditions) = *PROBE_CONDITIONS.lock().unwrap() {
        return conditions;
    }
    #[cfg(target_os = "macos")]
    {
        native::conditions()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Conditions {
            idle_seconds: None,
            power: None,
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn power() -> Option<Power> {
    native::power()
}

#[cfg(test)]
pub(crate) static PROBE_CONDITIONS: std::sync::Mutex<Option<Conditions>> =
    std::sync::Mutex::new(None);

pub(crate) fn away() -> bool {
    let tier = crate::hardware_tier::current();
    tier == HardwareTier::Light
        && conditions().away(
            tier,
            crate::memory_pressure::events().current(),
            super::speech_priority::speech_active()
                || super::speech_priority::PRECEDENCE.user_waiting(),
        )
}

thread_local! { static AWAY_ADMISSION: Cell<bool> = const { Cell::new(false) }; }

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
pub(crate) fn admission_active() -> bool {
    AWAY_ADMISSION.get()
}

pub(crate) fn with_admission<T>(away: bool, work: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            AWAY_ADMISSION.set(self.0);
        }
    }
    let _restore = Restore(AWAY_ADMISSION.replace(away));
    work()
}

/// Watches only background requests. Pressure is an in-process counter. HID
/// is read every 250 ms so a return does not wait for the 10 s power sample.
/// The helper acknowledges cancel at a token boundary, with its existing
/// bounded kill fallback if it stops answering.
pub(crate) struct Watch {
    stop: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    waiting: Arc<AtomicBool>,
}

impl Watch {
    pub(crate) fn start(away: bool, cancel: &CancelFlag) -> std::io::Result<Self> {
        Self::start_with(away, cancel, crate::hardware_tier::current(), move || {
            (
                if away {
                    conditions()
                } else {
                    Conditions {
                        idle_seconds: None,
                        power: None,
                    }
                },
                crate::memory_pressure::events().current(),
            )
        })
    }

    fn start_with(
        away: bool,
        cancel: &CancelFlag,
        tier: HardwareTier,
        source: impl Fn() -> (Conditions, MemoryPressure) + Send + 'static,
    ) -> std::io::Result<Self> {
        let (stop, done) = std::sync::mpsc::channel();
        let waiting = Arc::new(AtomicBool::new(false));
        let flag = waiting.clone();
        let cancel = cancel.clone();
        let thread = std::thread::Builder::new()
            .name("notes-window".into())
            .spawn(move || {
                loop {
                    let (sample, pressure) = source();
                    let mut stop = pressure_stops(tier, pressure);
                    if away {
                        // Power is already cached for 10 s. Check its latest
                        // value now rather than adding another sampling delay.
                        stop |= !sample.away(tier, pressure, false);
                    }
                    if stop {
                        flag.store(true, Ordering::Release);
                        cancel.cancel();
                        break;
                    }
                    if done.recv_timeout(Duration::from_millis(250))
                        != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    {
                        break;
                    }
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
            waiting,
        })
    }
    pub(crate) fn waiting(&self) -> bool {
        self.waiting.load(Ordering::Acquire)
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::{c_char, c_void};
    type Cf = *const c_void;
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(entry: u32, key: Cf, allocator: Cf, options: u32) -> Cf;
        fn IOObjectRelease(object: u32) -> i32;
        fn IOPSCopyPowerSourcesInfo() -> Cf;
        fn IOPSGetProvidingPowerSourceType(info: Cf) -> Cf;
        fn IOPSCopyPowerSourcesList(info: Cf) -> Cf;
        fn IOPSGetPowerSourceDescription(info: Cf, source: Cf) -> Cf;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: Cf, text: *const c_char, encoding: u32) -> Cf;
        fn CFRelease(value: Cf);
        fn CFEqual(a: Cf, b: Cf) -> u8;
        fn CFGetTypeID(value: Cf) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(value: Cf, kind: i32, output: *mut i64) -> u8;
        fn CFDictionaryGetValue(dict: Cf, key: Cf) -> Cf;
        fn CFArrayGetCount(array: Cf) -> isize;
        fn CFArrayGetValueAtIndex(array: Cf, index: isize) -> Cf;
    }
    struct Owned(Cf);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    fn owned(value: Cf) -> Option<Owned> {
        (!value.is_null()).then_some(Owned(value))
    }
    fn key(text: &std::ffi::CStr) -> Option<Owned> {
        owned(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100) })
    }
    fn number(value: Cf) -> Option<i64> {
        if value.is_null() || unsafe { CFGetTypeID(value) != CFNumberGetTypeID() } {
            return None;
        }
        let mut output = 0;
        (unsafe { CFNumberGetValue(value, 4, &mut output) } != 0).then_some(output)
    }
    fn idle_seconds() -> Option<u64> {
        let service =
            unsafe { IOServiceGetMatchingService(0, IOServiceMatching(c"IOHIDSystem".as_ptr())) };
        if service == 0 {
            return None;
        }
        let key = key(c"HIDIdleTime");
        let value = key.and_then(|key| {
            owned(unsafe { IORegistryEntryCreateCFProperty(service, key.0, std::ptr::null(), 0) })
        });
        unsafe {
            IOObjectRelease(service);
        }
        let ns = number(value?.0)?;
        u64::try_from(ns).ok().map(|ns| ns / 1_000_000_000)
    }
    pub(super) fn power() -> Option<Power> {
        let info = owned(unsafe { IOPSCopyPowerSourcesInfo() })?;
        let source = unsafe { IOPSGetProvidingPowerSourceType(info.0) };
        if source.is_null() {
            return None;
        }
        if unsafe { CFEqual(source, key(c"AC Power")?.0) } != 0 {
            return Some(Power::Ac);
        }
        if unsafe { CFEqual(source, key(c"Battery Power")?.0) } == 0 {
            return None;
        }
        let sources = owned(unsafe { IOPSCopyPowerSourcesList(info.0) })?;
        for index in 0..unsafe { CFArrayGetCount(sources.0) } {
            let description = unsafe {
                IOPSGetPowerSourceDescription(info.0, CFArrayGetValueAtIndex(sources.0, index))
            };
            if description.is_null() {
                continue;
            }
            let current =
                number(unsafe { CFDictionaryGetValue(description, key(c"Current Capacity")?.0) })?;
            let max =
                number(unsafe { CFDictionaryGetValue(description, key(c"Max Capacity")?.0) })?;
            if max <= 0 || current < 0 || current > max {
                return None;
            }
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let low_power = unsafe {
                let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
                if info.is_null() {
                    return None;
                }
                msg_send![info, isLowPowerModeEnabled]
            };
            return Some(Power::Battery {
                percent: (current * 100 / max) as u8,
                low_power,
            });
        }
        None
    }
    pub(super) fn conditions() -> Conditions {
        static POWER: std::sync::Mutex<Option<(Instant, Option<Power>)>> =
            std::sync::Mutex::new(None);
        let mut cache = POWER.lock().unwrap_or_else(|error| error.into_inner());
        if cache.is_none_or(|(at, _)| at.elapsed() >= SAMPLE_INTERVAL) {
            *cache = Some((Instant::now(), power()));
        }
        Conditions {
            idle_seconds: idle_seconds(),
            power: cache.and_then(|(_, power)| power),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_matrix() {
        for tier in [
            HardwareTier::Light,
            HardwareTier::Balanced,
            HardwareTier::Best,
        ] {
            for pressure in [
                MemoryPressure::Normal,
                MemoryPressure::Warning,
                MemoryPressure::Critical,
            ] {
                for idle in [None, Some(0), Some(179), Some(180), Some(600)] {
                    for power in [
                        None,
                        Some(Power::Ac),
                        Some(Power::Battery {
                            percent: 49,
                            low_power: false,
                        }),
                        Some(Power::Battery {
                            percent: 50,
                            low_power: false,
                        }),
                        Some(Power::Battery {
                            percent: 100,
                            low_power: true,
                        }),
                    ] {
                        for speech in [false, true] {
                            let expected = tier == HardwareTier::Light
                                && pressure == MemoryPressure::Normal
                                && idle.is_some_and(|s| s >= 180)
                                && !speech
                                && matches!(
                                    power,
                                    Some(
                                        Power::Ac
                                            | Power::Battery {
                                                percent: 50,
                                                low_power: false
                                            }
                                    )
                                );
                            assert_eq!(
                                Conditions {
                                    idle_seconds: idle,
                                    power
                                }
                                .away(tier, pressure, speech),
                                expected,
                                "{tier:?} {pressure:?} {idle:?} {power:?} {speech}"
                            );
                        }
                    }
                }
                assert_eq!(
                    pressure_stops(tier, pressure),
                    pressure == MemoryPressure::Critical
                        || tier == HardwareTier::Light && pressure == MemoryPressure::Warning
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "reads host idle and power counters"]
    fn native_counters_are_available_without_app_permissions() {
        let sample = native::conditions();
        println!("IOKit counters: {sample:?}");
        assert!(sample.idle_seconds.is_some());
        assert!(sample.power.is_some());
    }

    #[test]
    fn admission_is_scoped_and_restored() {
        assert!(!admission_active());
        with_admission(true, || {
            assert!(admission_active());
            with_admission(false, || assert!(!admission_active()));
            assert!(admission_active());
        });
        assert!(!admission_active());
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;
    #[test]
    fn fake_pressure_and_return_stop_at_a_token_boundary_without_speech_yield() {
        for away in [false, true] {
            let sample = Arc::new(std::sync::Mutex::new((
                Conditions {
                    idle_seconds: Some(300),
                    power: Some(Power::Ac),
                },
                MemoryPressure::Normal,
            )));
            let source = sample.clone();
            let cancel = CancelFlag::new();
            let watch = Watch::start_with(away, &cancel, HardwareTier::Light, move || {
                *source.lock().unwrap()
            })
            .unwrap();
            if away {
                sample.lock().unwrap().0.idle_seconds = Some(0);
            } else {
                sample.lock().unwrap().1 = MemoryPressure::Warning;
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while !cancel.is_cancelled() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(watch.waiting());
            assert!(cancel.is_cancelled());
            assert!(
                !cancel.must_stop_now(),
                "speech's immediate-kill path is distinct"
            );
        }
    }
    #[test]
    fn power_change_ends_the_away_window_without_a_second_sampling_delay() {
        let sample = Arc::new(std::sync::Mutex::new(Conditions {
            idle_seconds: Some(300),
            power: Some(Power::Ac),
        }));
        let source = sample.clone();
        let (ready, started) = std::sync::mpsc::channel();
        let cancel = CancelFlag::new();
        let watch = Watch::start_with(true, &cancel, HardwareTier::Light, move || {
            let value = *source.lock().unwrap();
            let _ = ready.send(());
            (value, MemoryPressure::Normal)
        })
        .unwrap();
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        sample.lock().unwrap().power = Some(Power::Battery {
            percent: 49,
            low_power: false,
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            watch.waiting(),
            "a fresh unsafe power counter must end the window without another 10 second timer"
        );
        assert!(!cancel.must_stop_now());
    }

    #[test]
    fn balanced_warning_keeps_running_but_critical_stops() {
        let pressure = Arc::new(std::sync::Mutex::new(MemoryPressure::Warning));
        let source = pressure.clone();
        let cancel = CancelFlag::new();
        let watch = Watch::start_with(false, &cancel, HardwareTier::Balanced, move || {
            (
                Conditions {
                    idle_seconds: None,
                    power: None,
                },
                *source.lock().unwrap(),
            )
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!cancel.is_cancelled());
        *pressure.lock().unwrap() = MemoryPressure::Critical;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(watch.waiting());
    }
}
