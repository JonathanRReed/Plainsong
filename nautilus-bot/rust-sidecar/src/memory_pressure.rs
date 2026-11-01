//! Process-wide memory-pressure events. Subscribers pause between bounded jobs;
//! the dispatch callback never locks models or walks caches.

use std::sync::OnceLock;
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPressure {
    Normal,
    Warning,
    Critical,
}

pub struct PressureEvents {
    sender: watch::Sender<MemoryPressure>,
    // Serialize native and QA updates so recovery cannot mask host pressure.
    #[cfg(any(target_os = "macos", test))]
    sources: std::sync::Mutex<[MemoryPressure; 2]>,
}

impl Default for PressureEvents {
    fn default() -> Self {
        Self {
            sender: watch::channel(MemoryPressure::Normal).0,
            #[cfg(any(target_os = "macos", test))]
            sources: std::sync::Mutex::new([MemoryPressure::Normal; 2]),
        }
    }
}

impl PressureEvents {
    pub fn current(&self) -> MemoryPressure {
        *self.sender.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<MemoryPressure> {
        self.sender.subscribe()
    }

    #[cfg(any(target_os = "macos", test))]
    fn publish(&self, pressure: MemoryPressure) {
        self.publish_source(0, pressure);
    }

    #[cfg(any(target_os = "macos", test))]
    fn publish_source(&self, source: usize, pressure: MemoryPressure) {
        let mut sources = self.sources.lock().unwrap_or_else(|e| e.into_inner());
        sources[source] = pressure;
        let effective = sources[0].max(sources[1]);
        let changed = self.sender.send_if_modified(|current| {
            if *current == effective {
                false
            } else {
                *current = effective;
                true
            }
        });
        if changed {
            crate::llm::local_model_load::notify_background_waiters();
        }
    }
}

pub fn events() -> &'static PressureEvents {
    static EVENTS: OnceLock<PressureEvents> = OnceLock::new();
    EVENTS.get_or_init(PressureEvents::default)
}

pub fn background_allowed() -> bool {
    events().current() == MemoryPressure::Normal
}

#[cfg(any(target_os = "macos", test))]
fn from_dispatch_flags(flags: usize) -> Option<MemoryPressure> {
    // Conservative fallback when the current kernel state cannot be read.
    if flags & 4 != 0 {
        Some(MemoryPressure::Critical)
    } else if flags & 2 != 0 {
        Some(MemoryPressure::Warning)
    } else if flags & 1 != 0 {
        Some(MemoryPressure::Normal)
    } else {
        None
    }
}

#[cfg(any(target_os = "macos", test))]
fn notification_pressure(flags: usize, current: Option<MemoryPressure>) -> Option<MemoryPressure> {
    // Dispatch ORs coalesced flags. A warning followed by recovery can arrive
    // together, so choosing the worst flag alone could leave jobs paused.
    current.or_else(|| from_dispatch_flags(flags))
}

#[cfg(target_os = "macos")]
fn current_kernel_pressure() -> Option<MemoryPressure> {
    let mut value = 0_u32;
    let mut size = std::mem::size_of::<u32>();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_vm_pressure_level".as_ptr(),
            (&mut value as *mut u32).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || size != std::mem::size_of::<u32>() {
        return None;
    }
    match value {
        1 => Some(MemoryPressure::Normal),
        2 => Some(MemoryPressure::Warning),
        4 => Some(MemoryPressure::Critical),
        _ => None,
    }
}

/// Like the memory-size simulations, this is a launch-only QA environment
/// setting. No command or renderer API can enable it or change the path.
#[cfg(any(target_os = "macos", test))]
fn qa_pressure_path(qa_mode: Option<&str>, path: Option<&str>) -> Option<std::path::PathBuf> {
    if qa_mode != Some("1") {
        return None;
    }
    let path = std::path::PathBuf::from(path?);
    path.is_absolute().then_some(path)
}

#[cfg(any(target_os = "macos", test))]
fn read_qa_pressure(path: &std::path::Path) -> Option<MemoryPressure> {
    use std::io::Read;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // A FIFO must never block the monitor; a symlink is not a control file.
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 32 {
        return None;
    }
    let mut value = String::new();
    file.take(33).read_to_string(&mut value).ok()?;
    match value.trim() {
        "normal" => Some(MemoryPressure::Normal),
        "warning" => Some(MemoryPressure::Warning),
        "critical" => Some(MemoryPressure::Critical),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn start_qa_monitor() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let Some(path) = qa_pressure_path(
            std::env::var("PLAINSONG_QA_MODE").ok().as_deref(),
            std::env::var("PLAINSONG_QA_PRESSURE_FILE").ok().as_deref(),
        ) else {
            return;
        };
        if let Err(error) = std::thread::Builder::new()
            .name("qa-instance-pressure".into())
            .spawn(move || {
                tracing::info!("QA instance pressure monitor enabled");
                let mut previous = None;
                loop {
                    if let Some(pressure) = read_qa_pressure(&path) {
                        if previous != Some(pressure) {
                            // The same watch publication and subscribers as dispatch.
                            events().publish_source(1, pressure);
                            tracing::info!(?pressure, effective = ?events().current(), "QA instance pressure applied");
                            previous = Some(pressure);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            })
        {
            tracing::warn!("Could not start QA instance pressure monitor: {error}");
        }
    });
}

/// Metadata-only load state for the instance pressure driver. The guard lives
/// with the actual model or helper, not with its downloaded files.
pub(crate) struct QaResidency {
    file: std::path::PathBuf,
    id: u64,
    lane: &'static str,
    pid: u32,
}

impl QaResidency {
    pub(crate) fn loaded(lane: &'static str, pid: u32) -> Option<Self> {
        static PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
        let path = PATH
            .get_or_init(|| {
                #[cfg(target_os = "macos")]
                {
                    qa_pressure_path(
                        std::env::var("PLAINSONG_QA_MODE").ok().as_deref(),
                        std::env::var("PLAINSONG_QA_PRESSURE_FILE").ok().as_deref(),
                    )
                }
                #[cfg(not(target_os = "macos"))]
                {
                    None
                }
            })
            .as_ref()?;
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let value = Self {
            file: path.with_extension("models.jsonl"),
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            lane,
            pid,
        };
        value.record(true);
        Some(value)
    }

    fn record(&self, loaded: bool) {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .mode(0o600);
        static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut file) = options.open(&self.file) {
            if file.metadata().is_ok_and(|meta| meta.is_file()) {
                let _ = writeln!(
                    file,
                    "{}",
                    serde_json::json!({
                        "id": self.id, "lane": self.lane, "pid": self.pid, "loaded": loaded,
                    })
                );
            }
        }
    }
}

impl Drop for QaResidency {
    fn drop(&mut self) {
        self.record(false);
    }
}

/// Register once for this process's lifetime. The source and its context are
/// retained together until process exit, so no callback can use freed state.
pub fn start_monitor() -> bool {
    #[cfg(target_os = "macos")]
    {
        start_qa_monitor();
        use std::ffi::c_void;
        unsafe extern "C" {
            #[link_name = "_dispatch_source_type_memorypressure"]
            static MEMORY_PRESSURE_SOURCE: u8;
            fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
            fn dispatch_source_create(
                kind: *const u8,
                handle: usize,
                mask: usize,
                queue: *mut c_void,
            ) -> *mut c_void;
            fn dispatch_set_context(object: *mut c_void, context: *mut c_void);
            fn dispatch_source_set_event_handler_f(
                source: *mut c_void,
                handler: unsafe extern "C" fn(*mut c_void),
            );
            fn dispatch_source_get_data(source: *mut c_void) -> usize;
            fn dispatch_resume(object: *mut c_void);
        }
        unsafe extern "C" fn changed(source: *mut c_void) {
            if let Some(pressure) = notification_pressure(
                unsafe { dispatch_source_get_data(source) },
                current_kernel_pressure(),
            ) {
                events().publish(pressure);
            }
        }
        static SOURCE: OnceLock<Option<usize>> = OnceLock::new();
        SOURCE
            .get_or_init(|| {
                // Initialize publication before registering the callback.
                let _ = events();
                if let Some(pressure) = current_kernel_pressure() {
                    events().publish(pressure);
                }
                unsafe {
                    let queue = dispatch_get_global_queue(0x11, 0);
                    let source = dispatch_source_create(
                        std::ptr::addr_of!(MEMORY_PRESSURE_SOURCE),
                        0,
                        1 | 2 | 4,
                        queue,
                    );
                    if source.is_null() {
                        return None;
                    }
                    dispatch_set_context(source, source);
                    dispatch_source_set_event_handler_f(source, changed);
                    dispatch_resume(source);
                    Some(source as usize)
                }
            })
            .is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_observe_pressure_and_recovery_without_repeated_events() {
        let events = PressureEvents::default();
        let mut subscriber = events.subscribe();
        for pressure in [
            MemoryPressure::Warning,
            MemoryPressure::Critical,
            MemoryPressure::Normal,
        ] {
            events.publish(pressure);
            subscriber.changed().await.unwrap();
            assert_eq!(*subscriber.borrow_and_update(), pressure);
            events.publish(pressure);
            assert!(!subscriber.has_changed().unwrap());
        }
        events.publish(MemoryPressure::Critical);
        assert_eq!(*events.subscribe().borrow(), MemoryPressure::Critical);
    }

    #[test]
    fn qa_injection_requires_explicit_qa_mode_and_an_absolute_launch_path() {
        for mode in [None, Some("0"), Some("true")] {
            assert!(qa_pressure_path(mode, Some("/tmp/qa-pressure")).is_none());
        }
        assert!(qa_pressure_path(Some("1"), None).is_none());
        assert!(qa_pressure_path(Some("1"), Some("")).is_none());
        assert!(qa_pressure_path(Some("1"), Some("relative")).is_none());
        assert!(qa_pressure_path(Some("1"), Some("/tmp/qa-pressure")).is_some());
    }

    #[tokio::test]
    async fn qa_file_drives_the_native_subscribers_and_preserves_host_pressure() {
        let dir = crate::test_fs::TempDir::new("qa-pressure");
        let path = dir.path().join("pressure");
        let events = PressureEvents::default();
        let mut subscriber = events.subscribe();
        for (text, pressure) in [
            ("warning", MemoryPressure::Warning),
            ("normal", MemoryPressure::Normal),
        ] {
            std::fs::write(&path, text).unwrap();
            events.publish_source(1, read_qa_pressure(&path).unwrap());
            subscriber.changed().await.unwrap();
            assert_eq!(*subscriber.borrow_and_update(), pressure);
        }
        let unrelated = PressureEvents::default();
        events.publish_source(1, MemoryPressure::Warning);
        assert_eq!(unrelated.current(), MemoryPressure::Normal);
        events.publish(MemoryPressure::Critical);
        events.publish(MemoryPressure::Normal);
        assert_eq!(events.current(), MemoryPressure::Warning);
        events.publish(MemoryPressure::Critical);
        events.publish_source(1, MemoryPressure::Normal);
        assert_eq!(events.current(), MemoryPressure::Critical);
        events.publish(MemoryPressure::Normal);
        assert_eq!(events.current(), MemoryPressure::Normal);
        for text in ["", "warn", "1", "warning garbage", &"x".repeat(33)] {
            std::fs::write(&path, text).unwrap();
            assert_eq!(read_qa_pressure(&path), None);
        }
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_qa_pressure(&path), None);
        assert_eq!(read_qa_pressure(dir.path()), None);
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            std::fs::write(&path, "warning").unwrap();
            assert_eq!(read_qa_pressure(&link), None);
            use std::os::unix::ffi::OsStrExt;
            let fifo = dir.path().join("fifo");
            let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert_eq!(read_qa_pressure(&fifo), None);
        }
    }

    #[test]
    fn coalesced_notifications_keep_the_most_severe_condition() {
        assert_eq!(from_dispatch_flags(7), Some(MemoryPressure::Critical));
        assert_eq!(from_dispatch_flags(3), Some(MemoryPressure::Warning));
        assert_eq!(from_dispatch_flags(1), Some(MemoryPressure::Normal));
        assert_eq!(from_dispatch_flags(0), None);
        assert_eq!(
            notification_pressure(7, Some(MemoryPressure::Normal)),
            Some(MemoryPressure::Normal)
        );
        assert_eq!(
            notification_pressure(3, None),
            Some(MemoryPressure::Warning)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_source_can_be_registered_more_than_once() {
        assert!(start_monitor());
        assert!(start_monitor());
    }
}
