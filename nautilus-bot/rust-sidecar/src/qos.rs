//! Scheduling policy shared by capture, native inference, and command workers.

use crate::hardware_tier::HardwareTier;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkClass {
    Interactive,
    Background,
}

pub fn is_interactive_command(command: &str) -> bool {
    matches!(
        command,
        "start_dictation" | "stop_dictation" | "force_stop_dictation"
    )
}

pub fn background_threads(cores: usize, tier: HardwareTier) -> usize {
    let limit = match tier {
        HardwareTier::Light => 1,
        HardwareTier::Balanced | HardwareTier::Best => 2,
    };
    cores.saturating_sub(2).clamp(1, limit)
}

pub fn inference_threads() -> usize {
    background_threads(
        std::thread::available_parallelism().map_or(2, usize::from),
        crate::hardware_tier::current(),
    )
}

pub fn background_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/sbin/taskpolicy");
        command.arg("-b").arg(program);
        command
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::process::Command::new(program)
    }
}

/// A synchronous background job may run on a pool also used by foreground
/// callers. Restore the caller's QoS before the pool reuses this thread.
pub fn run_background<T>(job: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    struct Restore(u32, i32);
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn pthread_get_qos_class_np(
            thread: libc::pthread_t,
            class: *mut u32,
            priority: *mut i32,
        ) -> i32;
        fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
    }
    #[cfg(target_os = "macos")]
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = unsafe { pthread_set_qos_class_self_np(self.0, self.1) };
        }
    }
    #[cfg(target_os = "macos")]
    let _restore = {
        let mut priority = 0;
        let mut previous = 0;
        let status =
            unsafe { pthread_get_qos_class_np(libc::pthread_self(), &mut previous, &mut priority) };
        // An unspecified class cannot be set by pthread_set_qos_class_self_np.
        // Leave that caller alone rather than permanently changing its policy.
        if status == 0 && previous != 0 && WorkClass::Background.apply_to_current_thread().is_ok() {
            Some(Restore(previous, priority))
        } else {
            None
        }
    };
    job()
}

impl WorkClass {
    /// Set only on a dedicated thread or in a synchronous worker closure.
    /// Async tasks must not change a shared worker's QoS across an await.
    pub fn apply_to_current_thread(self) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn pthread_set_qos_class_self_np(class: u32, relative_priority: i32) -> i32;
            }
            let class = match self {
                Self::Interactive => 0x19, // QOS_CLASS_USER_INITIATED
                Self::Background => 0x11,  // QOS_CLASS_UTILITY
            };
            // The API returns an errno value rather than setting errno.
            let error = unsafe { pthread_set_qos_class_self_np(class, 0) };
            if error != 0 {
                return Err(std::io::Error::from_raw_os_error(error));
            }
        }
        Ok(())
    }
}

/// Separate pools keep synchronous export/search handlers from occupying the
/// threads that poll dictation requests. Native engines still need their own
/// admission and thread limits.
pub fn command_runtime(class: WorkClass) -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(match class {
            WorkClass::Interactive => 4,
            WorkClass::Background => 2,
        })
        .thread_name(match class {
            WorkClass::Interactive => "dictation-command",
            WorkClass::Background => "sidecar-command",
        })
        .on_thread_start(move || {
            if let Err(error) = class.apply_to_current_thread() {
                tracing::warn!(?class, %error, "Could not set worker QoS");
            }
        })
        .enable_all()
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_inference_reserves_cores_on_small_machines() {
        for cores in 1..=32 {
            for tier in [
                HardwareTier::Light,
                HardwareTier::Balanced,
                HardwareTier::Best,
            ] {
                let threads = background_threads(cores, tier);
                assert!((1..=2).contains(&threads));
                if cores > 1 {
                    assert!(threads < cores);
                }
            }
        }
        assert_eq!(background_threads(6, HardwareTier::Light), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn background_child_runs_with_taskpolicy() {
        assert!(background_command("/usr/bin/true")
            .status()
            .unwrap()
            .success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn synchronous_background_work_restores_foreground_qos() {
        std::thread::spawn(|| {
            unsafe extern "C" {
                fn qos_class_self() -> u32;
            }
            WorkClass::Interactive.apply_to_current_thread().unwrap();
            assert_eq!(unsafe { qos_class_self() }, 0x19);
            run_background(|| assert_eq!(unsafe { qos_class_self() }, 0x11));
            assert_eq!(unsafe { qos_class_self() }, 0x19);
        })
        .join()
        .unwrap();
    }
}
