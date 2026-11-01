//! Automatic warm-up must not add weights alongside another application's model.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use anyhow::Context;
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
use anyhow::Result;

pub(super) fn can_prewarm<'a>(requested: &str, resident: impl Iterator<Item = &'a str>) -> bool {
    let resident: Vec<_> = resident.collect();
    resident.is_empty() || resident.contains(&requested)
}

/// Reserve memory for the OS and other applications, plus inference overhead.
/// Unknown size or headroom defers an optional warm-up rather than guessing.
pub(super) fn has_headroom(model_bytes: Option<u64>, available_bytes: Option<u64>) -> bool {
    const GIB: u64 = 1024 * 1024 * 1024;
    match (model_bytes, available_bytes) {
        (Some(size), Some(available)) if size > 0 => {
            available >= size.saturating_add(size / 2).saturating_add(6 * GIB)
        }
        _ => false,
    }
}

pub(super) fn speech_prewarm_has_headroom(model_mib: f64, available_bytes: Option<u64>) -> bool {
    if !model_mib.is_finite() || model_mib <= 0.0 {
        return false;
    }
    let bytes = (model_mib * 1024.0 * 1024.0).ceil();
    if bytes >= u64::MAX as f64 {
        return false;
    }
    let required = (bytes as u64)
        .checked_mul(3)
        .and_then(|value| value.checked_add(6 * 1024 * 1024 * 1024));
    matches!((required, available_bytes), (Some(required), Some(available)) if available >= required)
}

pub(super) fn available_memory() -> Option<u64> {
    measured_available_memory()
        .map(|free| free.saturating_sub(super::local_model_load::reserved_working_bytes()))
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
#[derive(Clone, Copy, Debug)]
pub(super) struct MemorySnapshot {
    pub available_bytes: u64,
    pub physical_bytes: u64,
    pub pressure_level: i32,
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn memory_snapshot(
    actual_physical_bytes: u64,
    physical_bytes: u64,
    available_bytes: u64,
    pressure_level: i32,
) -> MemorySnapshot {
    MemorySnapshot {
        physical_bytes,
        // A QA machine cannot offer more free memory than its simulated RAM.
        available_bytes: if physical_bytes < actual_physical_bytes {
            available_bytes.min(physical_bytes)
        } else {
            available_bytes
        },
        pressure_level,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) fn measured_memory_snapshot() -> Option<MemorySnapshot> {
    verified_memory_snapshot().ok()
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) fn verified_memory_snapshot() -> Result<MemorySnapshot> {
    retry_memory_sample(memory_snapshot_once)
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
fn retry_memory_sample<T>(mut sample: impl FnMut() -> Result<T>) -> Result<T> {
    match sample() {
        Ok(value) => Ok(value),
        Err(first) => sample().map_err(|second| anyhow::anyhow!(
            "Could not verify native memory headroom: two fresh samples failed; first={first:#}; retry={second:#}"
        )),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn memory_snapshot_once() -> Result<MemorySnapshot> {
    fn read_u64(name: &[u8]) -> Option<u64> {
        let mut value = 0_u64;
        let mut size = std::mem::size_of::<u64>();
        // The static name is NUL-terminated. Only correctly sized local storage
        // is writable, and no new sysctl value is supplied.
        let status = unsafe {
            libc::sysctlbyname(
                name.as_ptr().cast(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
    }
    fn read_i32(name: &[u8]) -> Option<i32> {
        let mut value = 0_i32;
        let mut size = std::mem::size_of::<i32>();
        // The pressure sysctl writes an i32, not the u64 used by hw.memsize.
        let status = unsafe {
            libc::sysctlbyname(
                name.as_ptr().cast(),
                (&mut value as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0 && size == std::mem::size_of::<i32>()).then_some(value)
    }
    // This sysctl exports dispatch flags: normal=1, warning=2, critical=4.
    // The internal memorystatus enum has different values, including normal=0.
    let actual_physical_bytes = read_u64(b"hw.memsize\0").context("hw.memsize sysctl failed")?;
    Ok(memory_snapshot(
        actual_physical_bytes,
        // Honors the QA small-Mac simulation, so admission plans for it too.
        crate::hardware_tier::physical_memory_bytes().unwrap_or(actual_physical_bytes),
        measured_available_memory().context("available-memory counters failed")?,
        read_i32(b"kern.memorystatus_vm_pressure_level\0")
            .context("kern.memorystatus_vm_pressure_level sysctl failed")?,
    ))
}

/// Free memory for admission: this Mac's, or the QA simulation of a busier
/// smaller Mac when one is set.
pub(super) fn measured_available_memory() -> Option<u64> {
    system_available_memory().map(crate::hardware_tier::simulate_available_memory)
}

/// Takes the available-memory simulation's baseline reading before anything
/// Plainsong loads can lower it.
pub(crate) fn prime_available_memory_simulation() {
    if crate::hardware_tier::available_memory_simulated() {
        let _ = measured_available_memory();
    }
}

fn system_available_memory() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        // Read the kernel directly on the decode path. vm_stat launches a
        // process and parses text for the same counters, and can fail under
        // host contention. It remains a fresh fallback, never a cached value.
        if let Some(bytes) = mach_available_memory() {
            return Some(bytes);
        }
        let output = std::process::Command::new("/usr/bin/vm_stat")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_available_memory(std::str::from_utf8(&output.stdout).ok()?)
    }
    #[cfg(target_os = "linux")]
    {
        parse_linux_available_memory(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct MemoryStatus {
            length: u32,
            load: u32,
            total_physical: u64,
            available_physical: u64,
            total_pagefile: u64,
            available_pagefile: u64,
            total_virtual: u64,
            available_virtual: u64,
            available_extended_virtual: u64,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
        }
        let mut status = MemoryStatus {
            length: std::mem::size_of::<MemoryStatus>() as u32,
            load: 0,
            total_physical: 0,
            available_physical: 0,
            total_pagefile: 0,
            available_pagefile: 0,
            total_virtual: 0,
            available_virtual: 0,
            available_extended_virtual: 0,
        };
        // The Windows API writes only the initialized, correctly sized structure.
        (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.available_physical)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn mach_available_memory() -> Option<u64> {
    unsafe extern "C" {
        fn mach_host_self() -> libc::mach_port_t;
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            port: libc::mach_port_t,
        ) -> libc::kern_return_t;
        static mach_task_self_: libc::mach_port_t;
    }
    // The host port returned by mach_host_self owns a send right. Balance it
    // even when the statistics call fails; admission samples on every decode.
    let mut stats = std::mem::MaybeUninit::<libc::vm_statistics64_data_t>::zeroed();
    let mut count = libc::HOST_VM_INFO64_COUNT;
    // SAFETY: host_statistics64 receives correctly sized writable storage and
    // its count in integer_t units. Read it only after a successful full reply.
    let status = unsafe {
        let host = mach_host_self();
        let status = libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            stats.as_mut_ptr().cast(),
            &mut count,
        );
        mach_port_deallocate(mach_task_self_, host);
        status
    };
    if status != libc::KERN_SUCCESS || count != libc::HOST_VM_INFO64_COUNT {
        return None;
    }
    // SAFETY: the kernel initialized the entire structure above.
    let stats = unsafe { stats.assume_init() };
    // SAFETY: sysconf reads a process constant and has no memory preconditions.
    let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    // Mach free_count already includes speculative pages. vm_stat subtracts
    // them from its "Pages free" line and prints them separately.
    available_page_bytes(
        u64::from(stats.free_count),
        u64::from(stats.inactive_count),
        page_size,
    )
}

#[cfg(any(target_os = "macos", test))]
fn available_page_bytes(free: u64, inactive: u64, page_size: u64) -> Option<u64> {
    if page_size == 0 {
        return None;
    }
    free.checked_add(inactive)?.checked_mul(page_size)
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_available_memory(text: &str) -> Option<u64> {
    let mut values = text
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?
        .strip_prefix("MemAvailable:")?
        .split_whitespace();
    let kib = values.next()?.parse::<u64>().ok()?;
    if values.next()? != "kB" || values.next().is_some() {
        return None;
    }
    kib.checked_mul(1024)
}

fn parse_available_memory(text: &str) -> Option<u64> {
    let first = text.lines().next()?;
    let page_size = first
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    let mut pages = 0_u64;
    for label in ["Pages free:", "Pages inactive:", "Pages speculative:"] {
        let line = text.lines().find(|line| line.starts_with(label))?;
        let count = line
            .strip_prefix(label)?
            .trim()
            .trim_end_matches('.')
            .parse::<u64>()
            .ok()?;
        pages = pages.checked_add(count)?;
    }
    pages.checked_mul(page_size)
}

#[cfg(test)]
mod tests {
    use super::can_prewarm;

    #[test]
    fn a_transient_sample_failure_retries_without_reusing_an_old_reading() {
        let mut calls = 0;
        let value = super::retry_memory_sample(|| {
            calls += 1;
            if calls == 1 {
                anyhow::bail!("available-memory counters failed");
            }
            Ok(42)
        })
        .unwrap();
        assert_eq!(value, 42);
        assert_eq!(calls, 2);
        let error = super::retry_memory_sample::<u64>(|| anyhow::bail!("pressure sysctl failed"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("two fresh samples failed"));
        assert!(error.contains("pressure sysctl failed"));
        // A previous success never supplies a later unreadable sample.
        assert!(super::retry_memory_sample::<u64>(|| anyhow::bail!("unreadable")).is_err());
    }

    #[test]
    fn simulated_capacity_and_real_warning_pressure_survive_a_sampling_retry() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for available in [3 * GIB / 2, 3 * GIB, 14 * GIB] {
            let mut first = true;
            let snapshot = super::retry_memory_sample(|| {
                if std::mem::take(&mut first) {
                    anyhow::bail!("transient sysctl failure");
                }
                Ok(super::memory_snapshot(24 * GIB, 8 * GIB, available, 2))
            })
            .unwrap();
            assert_eq!(snapshot.physical_bytes, 8 * GIB);
            assert_eq!(snapshot.available_bytes, available.min(8 * GIB));
            assert_eq!(snapshot.pressure_level, 2);
            // Simulating a smaller Mac must never turn the host's warning
            // into normal pressure or admit background model loads.
            assert!(super::super::local_model_load::adaptive_headroom(snapshot).is_err());
        }
    }

    #[test]
    fn native_available_pages_match_vm_stat_without_counting_speculation_twice() {
        // vm_stat prints free=10 and speculative=5 for Mach free_count=15.
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n";
        assert_eq!(
            super::available_page_bytes(15, 20, 16384),
            super::parse_available_memory(text)
        );
        assert_eq!(super::available_page_bytes(u64::MAX, 1, 16384), None);
        assert_eq!(super::available_page_bytes(1, 0, u64::MAX), Some(u64::MAX));
        assert_eq!(super::available_page_bytes(2, 0, u64::MAX), None);
        assert_eq!(super::available_page_bytes(1, 1, 0), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_memory_reader_returns_current_counters() {
        // Some virtual Macs refuse host_statistics64; the reader then falls back to vm_stat.
        let bytes = super::mach_available_memory()
            .or_else(super::available_memory)
            .expect("read host VM counters");
        assert!(bytes > 0);
    }

    #[test]
    fn available_memory_is_capped_to_the_simulated_physical_capacity() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let light = super::memory_snapshot(24 * GIB, 8 * GIB, 14 * GIB, 1);
        assert_eq!(light.available_bytes, 8 * GIB);
        assert_eq!(
            super::super::local_model_load::adaptive_headroom(light).unwrap(),
            (8 * GIB, 2 * GIB)
        );
        let balanced = super::memory_snapshot(24 * GIB, 16 * GIB, 14 * GIB, 1);
        assert_eq!(balanced.available_bytes, 14 * GIB);
        let pressured = super::memory_snapshot(24 * GIB, 8 * GIB, 14 * GIB, 2);
        assert_eq!(pressured.pressure_level, 2);
        assert!(super::super::local_model_load::adaptive_headroom(pressured).is_err());
        let invalid = super::memory_snapshot(24 * GIB, 24 * GIB, 26 * GIB, 1);
        assert!(super::super::local_model_load::adaptive_headroom(invalid).is_err());
    }

    #[test]
    fn speech_warmup_reserves_runtime_overhead_and_other_workloads() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(super::speech_prewarm_has_headroom(600.0, Some(8 * GIB)));
        assert!(!super::speech_prewarm_has_headroom(600.0, Some(4 * GIB)));
        assert!(!super::speech_prewarm_has_headroom(4400.0, Some(12 * GIB)));
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MAX] {
            assert!(!super::speech_prewarm_has_headroom(invalid, Some(u64::MAX)));
        }
        assert!(!super::speech_prewarm_has_headroom(600.0, None));
    }
    #[test]
    fn linux_snapshot_uses_available_physical_memory_and_checks_units() {
        assert_eq!(
            super::parse_linux_available_memory(
                "MemTotal: 9999 kB\nMemAvailable: 1024 kB\nSwapFree: 9999 kB"
            ),
            Some(1024 * 1024)
        );
        assert_eq!(
            super::parse_linux_available_memory("MemFree: 9999 kB"),
            None
        );
        assert_eq!(
            super::parse_linux_available_memory("MemAvailable: 1024 MB"),
            None
        );
        assert_eq!(
            super::parse_linux_available_memory("MemAvailable: 18446744073709551615 kB"),
            None
        );
    }

    #[test]
    fn an_empty_server_can_warm_one_model() {
        assert!(can_prewarm("small:tag", std::iter::empty()));
    }

    #[test]
    fn another_resident_model_prevents_automatic_loading() {
        assert!(!can_prewarm("small:tag", ["other:tag"].into_iter()));
        assert!(!can_prewarm(
            "large:tag",
            ["small:tag", "other:tag"].into_iter()
        ));
    }

    #[test]
    fn an_already_resident_model_needs_no_additional_load() {
        assert!(can_prewarm("small:tag", ["small:tag"].into_iter()));
        assert!(can_prewarm(
            "small:tag",
            ["other:tag", "small:tag"].into_iter()
        ));
    }
    #[test]
    fn memory_budget_counts_other_workloads_and_inference_overhead() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(!super::has_headroom(Some(14 * GIB), Some(18 * GIB)));
        assert!(!super::has_headroom(Some(7 * GIB), Some(10 * GIB)));
        assert!(super::has_headroom(Some(GIB), Some(8 * GIB)));
        assert!(!super::has_headroom(None, Some(32 * GIB)));
        assert!(!super::has_headroom(Some(GIB), None));
    }

    #[test]
    fn mac_snapshot_excludes_active_wired_and_compressed_memory() {
        let snapshot = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages active: 900.\nPages inactive: 20.\nPages speculative: 5.\nPages wired down: 999.\n";
        assert_eq!(super::parse_available_memory(snapshot), Some(35 * 16384));
        assert_eq!(super::parse_available_memory("incomplete"), None);
    }
}
