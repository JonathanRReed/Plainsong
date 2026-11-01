//! Private, device-owned output mute sessions. No application state is initialized here.
pub const PROTOCOL_MARKER: &str = "PLAINSONG_MEDIA_MUTE_WORKER_PROTOCOL_V1";

#[cfg(unix)]
pub use unix::private_entry;

#[cfg(not(unix))]
pub fn private_entry(args: &[std::ffi::OsString]) -> Option<u8> {
    let mode = args.get(1)?;
    if mode != "--media-mute-session" && mode != "--media-mute-recover" {
        return None;
    }
    use std::io::Write;
    let _ = writeln!(
        std::io::stdout(),
        "{}",
        serde_json::json!({
            "protocol": PROTOCOL_MARKER, "type": "error", "message": "Output mute requires macOS"
        })
    );
    Some(1)
}

#[cfg(unix)]
mod unix {
    use super::PROTOCOL_MARKER;
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, BufRead, Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::path::{Path, PathBuf};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Receipt {
        version: u32,
        device_uid: String,
        original_muted: bool,
    }
    trait Devices {
        fn default_uid(&mut self) -> Result<String, &'static str>;
        fn muted(&mut self, uid: &str) -> Result<Option<bool>, &'static str>;
        fn set(&mut self, uid: &str, muted: bool) -> Result<(), &'static str>;
    }
    struct Journal {
        path: PathBuf,
        _lock: File,
    }
    impl Journal {
        fn open(path: &Path) -> Result<Self, &'static str> {
            let mut lock_path = path.as_os_str().to_owned();
            lock_path.push(".lock");
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(lock_path)
                .map_err(|_| "Cannot open mute lock")?;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("Another mute session is active");
            }
            Ok(Self {
                path: path.to_owned(),
                _lock: lock,
            })
        }
        fn read(&self) -> Result<Option<Receipt>, &'static str> {
            let file = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&self.path)
            {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("Cannot read mute receipt"),
            };
            if file
                .metadata()
                .map_err(|_| "Cannot inspect mute receipt")?
                .len()
                > 16384
            {
                return Err("Unrecognized mute receipt preserved");
            }
            let receipt: Receipt =
                serde_json::from_reader(file).map_err(|_| "Unrecognized mute receipt preserved")?;
            if receipt.version != 1 || receipt.device_uid.is_empty() {
                return Err("Unrecognized mute receipt preserved");
            }
            Ok(Some(receipt))
        }
        fn persist(&self, receipt: &Receipt) -> Result<(), &'static str> {
            let mut temp = self.path.as_os_str().to_owned();
            temp.push(format!(".{}.tmp", std::process::id()));
            let temp = PathBuf::from(temp);
            let mut created = false;
            let result = (|| {
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temp)
                    .map_err(|_| "Cannot persist mute receipt")?;
                created = true;
                serde_json::to_writer(&mut f, receipt)
                    .map_err(|_| "Cannot persist mute receipt")?;
                f.write_all(b"\n")
                    .and_then(|_| f.sync_all())
                    .map_err(|_| "Cannot sync mute receipt")?;
                fs::rename(&temp, &self.path).map_err(|_| "Cannot commit mute receipt")?;
                self.sync_parent()
            })();
            if result.is_err() && created {
                let _ = fs::remove_file(temp);
            }
            result
        }
        fn sync_parent(&self) -> Result<(), &'static str> {
            File::open(
                self.path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new(".")),
            )
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync mute receipt directory")
        }
        fn clear(&self) -> Result<(), &'static str> {
            fs::remove_file(&self.path).map_err(|_| "Cannot clear mute receipt")?;
            self.sync_parent()
        }
    }
    fn restore(devices: &mut impl Devices, journal: &Journal) -> Result<bool, &'static str> {
        let Some(r) = journal.read()? else {
            return Ok(false);
        };
        devices.set(&r.device_uid, r.original_muted)?;
        journal.clear()?;
        Ok(true)
    }
    fn emit(mut value: serde_json::Value) -> Result<(), &'static str> {
        value["protocol"] = json!(PROTOCOL_MARKER);
        let mut out = io::stdout().lock();
        serde_json::to_writer(&mut out, &value).map_err(|_| "Mute protocol output closed")?;
        out.write_all(b"\n")
            .and_then(|_| out.flush())
            .map_err(|_| "Mute protocol output closed")
    }
    fn finish(outcome: &str, reason: Option<&str>) -> Result<(), &'static str> {
        let mut v = json!({"type":"finished", "outcome":outcome});
        if let Some(reason) = reason {
            v["reason"] = json!(reason);
        }
        emit(v)
    }
    struct Watchdog {
        stage: Arc<AtomicU64>,
        epoch: Instant,
    }
    impl Watchdog {
        fn new() -> Self {
            let stage = Arc::new(AtomicU64::new(1));
            let copy = stage.clone();
            let epoch = Instant::now();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(100));
                let deadline = copy.load(Ordering::SeqCst);
                if deadline == u64::MAX {
                    break;
                }
                if deadline != 0 && epoch.elapsed().as_millis() as u64 >= deadline {
                    // A blocked stdout pipe must not defeat the operation deadline.
                    let payload = format!("{{\"protocol\":\"{}\",\"type\":\"error\",\"message\":\"Native mute operation timed out; recovery receipt preserved\"}}\n", PROTOCOL_MARKER);
                    unsafe {
                        let flags = libc::fcntl(libc::STDOUT_FILENO, libc::F_GETFL);
                        if flags >= 0 {
                            libc::fcntl(
                                libc::STDOUT_FILENO,
                                libc::F_SETFL,
                                flags | libc::O_NONBLOCK,
                            );
                            libc::write(
                                libc::STDOUT_FILENO,
                                payload.as_ptr().cast(),
                                payload.len(),
                            );
                        }
                    }
                    std::process::exit(1);
                }
            });
            let w = Self { stage, epoch };
            w.arm();
            w
        }
        fn arm(&self) {
            self.stage.store(
                self.epoch.elapsed().as_millis() as u64 + 15000,
                Ordering::SeqCst,
            );
        }
        fn wait(&self) {
            self.stage.store(0, Ordering::SeqCst);
        }
    }
    impl Drop for Watchdog {
        fn drop(&mut self) {
            self.stage.store(u64::MAX, Ordering::SeqCst);
        }
    }
    fn session(
        devices: &mut impl Devices,
        journal: &Journal,
        recovery: bool,
        watchdog: &Watchdog,
        input: &mut impl BufRead,
    ) -> Result<(), &'static str> {
        match restore(devices, journal) {
            Err(reason) => return finish("deferred", Some(reason)),
            Ok(restored) if recovery => {
                return finish(if restored { "restored" } else { "skipped" }, None)
            }
            _ => {}
        }
        let uid = devices.default_uid()?;
        match devices.muted(&uid)? {
            None => return finish("skipped", Some("Output master mute is unavailable")),
            Some(true) => return finish("skipped", Some("Output is already muted")),
            Some(false) => {}
        }
        emit(json!({"type":"ready","deviceUid":uid}))?;
        let mut active = false;
        loop {
            watchdog.wait();
            let mut command = String::new();
            // Commands are tiny; a bounded read also prevents an untrusted pipe from allocating indefinitely.
            let read = Read::by_ref(input).take(64).read_line(&mut command);
            watchdog.arm();
            let end = match read {
                Ok(0) => true,
                Ok(_) => command.ends_with('\n') && command.trim() == "restore",
                Err(_) => {
                    if active {
                        let _ = restore(devices, journal);
                    }
                    return Err("Native mute command input failed");
                }
            };
            if end {
                return if active {
                    match restore(devices, journal) {
                        Ok(_) => finish("restored", None),
                        Err(reason) => finish("deferred", Some(reason)),
                    }
                } else {
                    finish("skipped", None)
                };
            }
            if !command.ends_with('\n') || !matches!(command.trim(), "mute" | "restore") {
                if active {
                    let _ = restore(devices, journal);
                }
                return Err("Invalid native mute command");
            }
            if active {
                continue;
            }
            let receipt = Receipt {
                version: 1,
                device_uid: uid.clone(),
                original_muted: false,
            };
            // Recheck the captured UID immediately before journaling; never select a new default.
            if devices.muted(&uid)? != Some(false) {
                return finish("skipped", Some("Output mute state changed"));
            }
            journal.persist(&receipt)?;
            active = true;
            if let Err(message) = devices
                .set(&uid, true)
                .and_then(|_| emit(json!({"type":"muted"})))
            {
                let _ = restore(devices, journal);
                return Err(message);
            }
        }
    }
    #[derive(Default)]
    struct PipeInput {
        byte: [u8; 1],
        available: bool,
    }
    impl Read for PipeInput {
        fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
            if target.is_empty() {
                return Ok(0);
            }
            let bytes = self.fill_buf()?;
            if bytes.is_empty() {
                return Ok(0);
            }
            target[0] = bytes[0];
            self.consume(1);
            Ok(1)
        }
    }
    impl BufRead for PipeInput {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            if self.available {
                return Ok(&self.byte);
            }
            loop {
                let mut fds = [
                    libc::pollfd {
                        fd: libc::STDIN_FILENO,
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: libc::STDOUT_FILENO,
                        events: 0,
                        revents: 0,
                    },
                ];
                let status = unsafe { libc::poll(fds.as_mut_ptr(), 2, 100) };
                if status < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                if fds[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "Mute protocol output closed",
                    ));
                }
                if fds[0].revents != 0 {
                    let count =
                        unsafe { libc::read(libc::STDIN_FILENO, self.byte.as_mut_ptr().cast(), 1) };
                    if count == 0 {
                        return Ok(&[]);
                    }
                    if count < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    self.available = true;
                    return Ok(&self.byte);
                }
            }
        }
        fn consume(&mut self, count: usize) {
            if count > 0 {
                self.available = false;
            }
        }
    }
    /// Returns Some(exit status) only for the two private sidecar entry modes.
    pub fn private_entry(args: &[std::ffi::OsString]) -> Option<u8> {
        let mode = args.get(1)?;
        if mode != "--media-mute-session" && mode != "--media-mute-recover" {
            return None;
        }
        // Protocol frames are small. A stalled consumer must trigger restoration,
        // rather than strand the owned mute behind a blocking write.
        unsafe {
            let flags = libc::fcntl(libc::STDOUT_FILENO, libc::F_GETFL);
            if flags >= 0 {
                libc::fcntl(libc::STDOUT_FILENO, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
        let watchdog = Watchdog::new();
        let result = if args.len() != 3 {
            Err("Invalid native mute arguments")
        } else {
            Journal::open(Path::new(&args[2])).and_then(|journal| {
                #[cfg(target_os = "macos")]
                {
                    session(
                        &mut macos::CoreAudio,
                        &journal,
                        mode == "--media-mute-recover",
                        &watchdog,
                        &mut PipeInput::default(),
                    )
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = journal;
                    Err("Output mute requires macOS")
                }
            })
        };
        Some(match result {
            Ok(()) => 0,
            Err(message) => {
                let _ = emit(json!({"type":"error","message":message}));
                1
            }
        })
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::Devices;
        use core_foundation::{base::TCFType, string::CFString};
        use core_foundation_sys::string::CFStringRef;
        use std::{ffi::c_void, ptr};
        #[repr(C)]
        struct Address {
            selector: u32,
            scope: u32,
            element: u32,
        }
        #[link(name = "CoreAudio", kind = "framework")]
        unsafe extern "C" {
            fn AudioObjectHasProperty(id: u32, address: *const Address) -> u8;
            fn AudioObjectIsPropertySettable(
                id: u32,
                address: *const Address,
                settable: *mut u8,
            ) -> i32;
            fn AudioObjectGetPropertyDataSize(
                id: u32,
                address: *const Address,
                q: u32,
                qualifier: *const c_void,
                size: *mut u32,
            ) -> i32;
            fn AudioObjectGetPropertyData(
                id: u32,
                address: *const Address,
                q: u32,
                qualifier: *const c_void,
                size: *mut u32,
                data: *mut c_void,
            ) -> i32;
            fn AudioObjectSetPropertyData(
                id: u32,
                address: *const Address,
                q: u32,
                qualifier: *const c_void,
                size: u32,
                data: *const c_void,
            ) -> i32;
        }
        fn address(selector: [u8; 4], output: bool) -> Address {
            Address {
                selector: u32::from_be_bytes(selector),
                scope: u32::from_be_bytes(if output { *b"outp" } else { *b"glob" }),
                element: 0,
            }
        }
        fn read<T: Default>(id: u32, a: &Address) -> Result<T, &'static str> {
            let mut v = T::default();
            let mut size = std::mem::size_of::<T>() as u32;
            if unsafe {
                AudioObjectGetPropertyData(
                    id,
                    a,
                    0,
                    ptr::null(),
                    &mut size,
                    (&mut v as *mut T).cast(),
                )
            } != 0
                || size as usize != std::mem::size_of::<T>()
            {
                return Err("Cannot read output device property");
            }
            Ok(v)
        }
        fn uid(id: u32) -> Result<String, &'static str> {
            let value: CFStringRef = read(id, &address(*b"uid ", false))?;
            if value.is_null() {
                return Err("Cannot identify output device");
            }
            Ok(unsafe { CFString::wrap_under_create_rule(value) }.to_string())
        }
        fn resolve(expected: &str) -> Result<u32, &'static str> {
            let a = address(*b"dev#", false);
            let mut size = 0;
            if unsafe { AudioObjectGetPropertyDataSize(1, &a, 0, ptr::null(), &mut size) } != 0
                || size > 1024 * 1024
                || size % 4 != 0
            {
                return Err("Cannot enumerate output devices");
            }
            let mut ids = vec![0u32; size as usize / 4];
            if unsafe {
                AudioObjectGetPropertyData(
                    1,
                    &a,
                    0,
                    ptr::null(),
                    &mut size,
                    ids.as_mut_ptr().cast(),
                )
            } != 0
            {
                return Err("Cannot enumerate output devices");
            }
            ids.truncate(size as usize / 4);
            ids.into_iter()
                .find(|id| uid(*id).ok().as_deref() == Some(expected))
                .ok_or("Original output device is unavailable")
        }
        fn supported(id: u32) -> bool {
            let a = address(*b"mute", true);
            let mut settable = 0;
            unsafe {
                AudioObjectHasProperty(id, &a) != 0
                    && AudioObjectIsPropertySettable(id, &a, &mut settable) == 0
                    && settable != 0
            }
        }
        pub(super) struct CoreAudio;
        impl Devices for CoreAudio {
            fn default_uid(&mut self) -> Result<String, &'static str> {
                uid(read(1, &address(*b"dOut", false))?)
            }
            fn muted(&mut self, expected: &str) -> Result<Option<bool>, &'static str> {
                let id = resolve(expected)?;
                if !supported(id) {
                    return Ok(None);
                }
                Ok(Some(read::<u32>(id, &address(*b"mute", true))? != 0))
            }
            fn set(&mut self, expected: &str, muted: bool) -> Result<(), &'static str> {
                let id = resolve(expected)?;
                if !supported(id) || uid(id)? != expected {
                    return Err("Original output device cannot be changed");
                }
                let value = u32::from(muted);
                let a = address(*b"mute", true);
                if unsafe {
                    AudioObjectSetPropertyData(
                        id,
                        &a,
                        0,
                        ptr::null(),
                        4,
                        (&value as *const u32).cast(),
                    )
                } != 0
                {
                    return Err("Output mute write failed");
                }
                if uid(id)? != expected || read::<u32>(id, &a)? != value {
                    return Err("Output mute verification failed");
                }
                Ok(())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::collections::HashMap;
        struct Fake {
            default: String,
            states: HashMap<String, Option<bool>>,
            writes: Vec<(String, bool)>,
            fail: bool,
        }
        impl Fake {
            fn new() -> Self {
                Self {
                    default: "A".into(),
                    states: HashMap::from([("A".into(), Some(false)), ("B".into(), Some(true))]),
                    writes: vec![],
                    fail: false,
                }
            }
        }
        impl Devices for Fake {
            fn default_uid(&mut self) -> Result<String, &'static str> {
                Ok(self.default.clone())
            }
            fn muted(&mut self, uid: &str) -> Result<Option<bool>, &'static str> {
                self.states
                    .get(uid)
                    .copied()
                    .ok_or("Original output device is unavailable")
            }
            fn set(&mut self, uid: &str, muted: bool) -> Result<(), &'static str> {
                if self.fail || !matches!(self.states.get(uid), Some(Some(_))) {
                    return Err("Restore failed");
                }
                self.writes.push((uid.into(), muted));
                self.states.insert(uid.into(), Some(muted));
                Ok(())
            }
        }
        struct Temp(PathBuf);
        impl Temp {
            fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let p = std::env::temp_dir().join(format!(
                    "plainsong-mute-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::SeqCst)
                ));
                fs::create_dir(&p).unwrap();
                Self(p)
            }
            fn journal(&self) -> Journal {
                Journal::open(&self.0.join("receipt")).unwrap()
            }
        }
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        fn record(j: &Journal) {
            j.persist(&Receipt {
                version: 1,
                device_uid: "A".into(),
                original_muted: false,
            })
            .unwrap();
        }
        #[test]
        fn stale_receipt_restores_original_uid_after_default_switch() {
            let t = Temp::new();
            let j = t.journal();
            record(&j);
            let mut d = Fake::new();
            d.default = "B".into();
            assert!(restore(&mut d, &j).unwrap());
            assert_eq!(d.writes, vec![("A".into(), false)]);
            assert_eq!(d.states["B"], Some(true));
            assert!(j.read().unwrap().is_none());
        }
        #[test]
        fn failed_restore_and_missing_original_keep_receipt() {
            let t = Temp::new();
            let j = t.journal();
            record(&j);
            let mut d = Fake::new();
            d.fail = true;
            assert!(restore(&mut d, &j).is_err());
            assert!(j.read().unwrap().is_some());
            d.fail = false;
            d.states.remove("A");
            assert!(restore(&mut d, &j).is_err());
            assert!(j.read().unwrap().is_some());
            assert!(d.writes.is_empty());
        }
        #[test]
        fn eof_and_restore_before_mute_do_not_write() {
            for input in ["", "restore\n"] {
                let t = Temp::new();
                let j = t.journal();
                let mut d = Fake::new();
                session(
                    &mut d,
                    &j,
                    false,
                    &Watchdog::new(),
                    &mut io::Cursor::new(input),
                )
                .unwrap();
                assert!(d.writes.is_empty());
                assert!(!j.path.exists());
            }
        }
        #[test]
        fn muted_and_unsupported_outputs_are_skipped() {
            for state in [Some(true), None] {
                let t = Temp::new();
                let j = t.journal();
                let mut d = Fake::new();
                d.states.insert("A".into(), state);
                session(
                    &mut d,
                    &j,
                    false,
                    &Watchdog::new(),
                    &mut io::Cursor::new("mute\n"),
                )
                .unwrap();
                assert!(d.writes.is_empty());
                assert!(!j.path.exists());
            }
        }
        #[test]
        fn persist_failure_prevents_audio_write() {
            let t = Temp::new();
            let j = t.journal();
            fs::create_dir(&j.path).unwrap();
            let mut d = Fake::new();
            assert!(session(
                &mut d,
                &j,
                false,
                &Watchdog::new(),
                &mut io::Cursor::new("mute\n")
            )
            .is_ok());
            assert!(d.writes.is_empty());
            fs::remove_dir(&j.path).unwrap();
            let mut temp = j.path.as_os_str().to_owned();
            temp.push(format!(".{}.tmp", std::process::id()));
            fs::write(temp, b"occupied").unwrap();
            assert!(session(
                &mut d,
                &j,
                false,
                &Watchdog::new(),
                &mut io::Cursor::new("mute\n")
            )
            .is_err());
            assert!(d.writes.is_empty());
        }
        #[test]
        fn legacy_empty_and_future_receipts_remain_intact() {
            for bytes in [
                b"".as_slice(),
                br#"{"version":2,"deviceUid":"A","originalMuted":false}"#,
            ] {
                let t = Temp::new();
                let j = t.journal();
                fs::write(&j.path, bytes).unwrap();
                let mut d = Fake::new();
                assert!(restore(&mut d, &j).is_err());
                assert_eq!(fs::read(&j.path).unwrap(), bytes);
                assert!(d.writes.is_empty());
            }
        }
        #[test]
        fn invalid_or_truncated_commands_restore_owned_mute() {
            for command in [
                "unknown\n",
                "restore",
                "mute",
                "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxmute\n",
            ] {
                let t = Temp::new();
                let j = t.journal();
                let mut d = Fake::new();
                let input = format!("mute\n{}", command);
                assert!(session(
                    &mut d,
                    &j,
                    false,
                    &Watchdog::new(),
                    &mut io::Cursor::new(input)
                )
                .is_err());
                assert_eq!(d.writes, vec![("A".into(), true), ("A".into(), false)]);
                assert!(!j.path.exists());
            }
        }
        #[test]
        fn mute_then_eof_restores_and_clears_receipt() {
            let t = Temp::new();
            let j = t.journal();
            let mut d = Fake::new();
            session(
                &mut d,
                &j,
                false,
                &Watchdog::new(),
                &mut io::Cursor::new("mute\n"),
            )
            .unwrap();
            assert_eq!(d.writes, vec![("A".into(), true), ("A".into(), false)]);
            assert!(!j.path.exists());
        }
    }
}
