//! One bounded, consent-gated correction sample from the original AX field.
use super::dictation_correction_capture::{FocusedFieldFingerprint, FocusedFieldSnapshot};
use std::time::{Duration, Instant};

// Allow brief deletion/retyping pauses while leaving room for more probes in eight seconds.
const DEBOUNCE: Duration = Duration::from_millis(800);
const LIFETIME: Duration = Duration::from_secs(8);
// Delayed insertion notifications can cause no-op probes. Never read more than
// three values, and return at most one changed snapshot. Every probe needs an event.
const MAX_VALUE_PROBES: usize = 3;

static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct Slot<'a>(&'a std::sync::atomic::AtomicBool);
impl<'a> Slot<'a> {
    fn claim(active: &'a std::sync::atomic::AtomicBool) -> Option<Self> {
        use std::sync::atomic::Ordering;
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        Some(Self(active))
    }
}
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// One owner across notification setup, watching, fallback, and evaluation.
pub(crate) struct CorrectionCaptureSession {
    _slot: Slot<'static>,
}
impl CorrectionCaptureSession {
    pub(crate) fn claim() -> Option<Self> {
        Slot::claim(&ACTIVE).map(|slot| Self { _slot: slot })
    }
}

pub(crate) fn correction_fallback_wait(elapsed: Duration) -> Option<Duration> {
    (elapsed < LIFETIME).then(|| Duration::from_secs(4).saturating_sub(elapsed))
}

pub(crate) enum CorrectionWatchOutcome {
    Sample(Box<FocusedFieldSnapshot>),
    Unsupported(Option<u64>),
    Aborted,
}

fn with_value_read_authority<A, T>(
    acquire: impl FnOnce() -> Option<A>,
    read: impl FnOnce() -> Option<T>,
) -> Option<T> {
    let authority = acquire()?;
    let value = read();
    drop(authority);
    value
}

#[derive(Default)]
struct WatchPolicy {
    last_value: Option<Duration>,
    stopped: bool,
    cancelled: bool,
    probes: usize,
    event_generation: usize,
    probe_generation: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum WatchAction {
    Wait,
    Sample,
    Abort,
}

impl WatchPolicy {
    fn value_changed(&mut self, elapsed: Duration) {
        if !self.stopped {
            self.last_value = Some(elapsed);
            self.event_generation = self.event_generation.saturating_add(1);
        }
    }

    fn cancel(&mut self) {
        self.stopped = true;
        self.cancelled = true;
    }

    fn action(&mut self, elapsed: Duration, allowed: bool) -> WatchAction {
        if self.stopped || !allowed || elapsed >= LIFETIME || self.probes >= MAX_VALUE_PROBES {
            self.stopped = true;
            return WatchAction::Abort;
        }
        if self
            .last_value
            .is_some_and(|at| elapsed.saturating_sub(at) >= DEBOUNCE)
        {
            self.probes += 1;
            self.probe_generation = self.event_generation;
            return WatchAction::Sample;
        }
        WatchAction::Wait
    }
    fn finish_probe(
        &mut self,
        unchanged_or_rejected: bool,
        elapsed: Duration,
        allowed: bool,
    ) -> WatchAction {
        if self.cancelled || !allowed || elapsed >= LIFETIME {
            self.cancel();
            return WatchAction::Abort;
        }
        if !unchanged_or_rejected && self.event_generation == self.probe_generation {
            self.stopped = true;
            return WatchAction::Sample;
        }
        // Consume the event that caused this probe, preserving events that
        // arrived while native validation or the value read was running.
        if self.event_generation == self.probe_generation {
            self.last_value = None;
        }
        if self.probes >= MAX_VALUE_PROBES {
            self.stopped = true;
            return WatchAction::Abort;
        }
        WatchAction::Wait
    }
}

#[cfg(target_os = "macos")]
pub(super) fn original_application_identity(pid: i32) -> Option<(Option<String>, Option<String>)> {
    objc2::rc::autoreleasepool(|_| {
        let application =
            objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        Some((
            application
                .bundleIdentifier()
                .map(|value| value.to_string()),
            application.localizedName().map(|value| value.to_string()),
        ))
    })
}

#[cfg(target_os = "macos")]
pub(super) fn read_current_field(
    expected: &FocusedFieldFingerprint,
) -> Option<FocusedFieldSnapshot> {
    native::read_once(
        expected,
        expected.native_element_hash,
        Instant::now() + Duration::from_millis(250),
        || Some(()),
    )
}

#[cfg(target_os = "macos")]
pub(super) fn read_initial_field(
    reader: &super::MacosFocusedFieldReader,
) -> Option<FocusedFieldSnapshot> {
    native::read_initial(reader)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn observe_post_insert_correction<A>(
    _session: &CorrectionCaptureSession,
    _expected: &FocusedFieldFingerprint,
    _inserted_text: &str,
    _end: Instant,
    _acquire_read: impl Fn() -> Option<A>,
    _accept_sample: impl Fn(&str) -> bool,
) -> CorrectionWatchOutcome {
    CorrectionWatchOutcome::Unsupported(None)
}

#[cfg(target_os = "macos")]
mod native {
    use super::super::selected_context_read::{messaging_timeout, AxObject};
    use super::super::*;
    use super::*;
    use core_foundation_sys::runloop::{
        kCFRunLoopDefaultMode, kCFRunLoopRunHandledSource, kCFRunLoopRunTimedOut,
        CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRemoveSource,
        CFRunLoopRunInMode, CFRunLoopSourceRef,
    };
    use std::cell::RefCell;
    struct SourceGuard {
        run_loop: CFRunLoopRef,
        source: CFRunLoopSourceRef,
    }
    impl Drop for SourceGuard {
        fn drop(&mut self) {
            unsafe {
                CFRunLoopRemoveSource(self.run_loop, self.source, kCFRunLoopDefaultMode);
            }
        }
    }

    struct CallbackState {
        started: Instant,
        policy: RefCell<WatchPolicy>,
    }

    extern "C" fn changed(
        _observer: CFTypeRef,
        _element: AXUIElementRef,
        notification: CFStringRef,
        context: *mut std::ffi::c_void,
    ) {
        if context.is_null() {
            return;
        }
        // Both the callback and state belong to this worker's run loop.
        let state = unsafe { &*context.cast::<CallbackState>() };
        let Ok(mut policy) = state.policy.try_borrow_mut() else {
            return;
        };
        let value_notification = CFString::new("AXValueChanged");
        if unsafe {
            core_foundation_sys::base::CFEqual(
                notification.cast(),
                value_notification.as_concrete_TypeRef().cast(),
            )
        } != 0
        {
            policy.value_changed(state.started.elapsed());
        } else {
            policy.cancel();
        }
    }

    fn attribute(
        element: AXUIElementRef,
        name: &str,
        end: Instant,
    ) -> Result<Option<AxObject>, ()> {
        if !messaging_timeout(element, end) {
            return Err(());
        }
        let value = ax_copy_attribute_value(element, name)
            .map_err(|_| ())?
            .map(AxObject);
        if Instant::now() >= end {
            return Err(());
        }
        Ok(value)
    }

    fn string(value: CFTypeRef) -> Result<String, ()> {
        use core_foundation_sys::string::{CFStringGetCharacters, CFStringGetLength};
        if unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
            return Err(());
        }
        let length = unsafe { CFStringGetLength(value.cast()) };
        // Never allocate or copy an entire large document.
        if !(0..=8_000).contains(&length) {
            return Err(());
        }
        let mut units = vec![0_u16; length as usize];
        unsafe {
            CFStringGetCharacters(
                value.cast(),
                CFRange {
                    location: 0,
                    length,
                },
                units.as_mut_ptr(),
            );
        }
        String::from_utf16(&units).map_err(|_| ())
    }

    fn optional_string(
        element: AXUIElementRef,
        name: &str,
        end: Instant,
    ) -> Result<Option<String>, ()> {
        attribute(element, name, end)?
            .map(|value| string(value.0))
            .transpose()
    }

    fn pair(
        element: AXUIElementRef,
        name: &str,
        kind: u32,
        end: Instant,
    ) -> Result<Option<(f64, f64)>, ()> {
        let Some(value) = attribute(element, name, end)? else {
            return Ok(None);
        };
        if unsafe { AXValueGetType(value.0) } != kind {
            return Err(());
        }
        let mut pair = [0.0_f64; 2];
        if unsafe { AXValueGetValue(value.0, kind, pair.as_mut_ptr().cast()) } == 0
            || !pair.iter().all(|value| value.is_finite())
        {
            return Err(());
        }
        Ok(Some((pair[0], pair[1])))
    }

    fn safe_to_read(field: AXUIElementRef, end: Instant) -> bool {
        if !check_accessibility_permission() || secure_event_input_enabled() {
            return false;
        }
        let Ok(Some(role)) = optional_string(field, "AXRole", end) else {
            return false;
        };
        let Ok(subrole) = optional_string(field, "AXSubrole", end) else {
            return false;
        };
        Instant::now() < end
            && dictation_secure_field::classify_secure_field(
                Some(&role),
                subrole.as_deref(),
                secure_event_input_enabled(),
            )
            .is_none()
    }

    fn metadata(
        app: &AxObject,
        pid: i32,
        expected: Option<&FocusedFieldFingerprint>,
        expected_hash: Option<u64>,
        end: Instant,
    ) -> Result<(AxObject, FocusedFieldFingerprint, u64), ()> {
        if !check_accessibility_permission() || secure_event_input_enabled() {
            return Err(());
        }
        let frontmost = attribute(app.0, "AXFrontmost", end)?.ok_or(())?;
        if unsafe {
            CFGetTypeID(frontmost.0) != CFBoolean::type_id()
                || !core_foundation_sys::number::CFBooleanGetValue(frontmost.0.cast())
        } {
            return Err(());
        }
        let focused = attribute(app.0, "AXFocusedUIElement", end)?.ok_or(())?;
        if ax_element_pid(focused.0) != Some(pid) {
            return Err(());
        }
        let hash = unsafe { core_foundation_sys::base::CFHash(focused.0) } as u64;
        if expected_hash.is_some_and(|expected| expected != hash) {
            return Err(());
        }
        let role = optional_string(focused.0, "AXRole", end)?.ok_or(())?;
        let subrole = optional_string(focused.0, "AXSubrole", end)?;
        if dictation_secure_field::classify_secure_field(
            Some(&role),
            subrole.as_deref(),
            secure_event_input_enabled(),
        )
        .is_some()
        {
            return Err(());
        }
        let identifier = optional_string(focused.0, "AXIdentifier", end)?;
        let title = optional_string(focused.0, "AXTitle", end)?;
        let window = attribute(focused.0, "AXWindow", end)?;
        let (window_title, window_identifier) = match window {
            Some(window) => (
                optional_string(window.0, "AXTitle", end)?,
                optional_string(window.0, "AXIdentifier", end)?,
            ),
            None => (None, None),
        };
        let position = pair(focused.0, "AXPosition", AX_VALUE_CG_POINT_TYPE, end)?;
        let size = pair(focused.0, "AXSize", AX_VALUE_CG_SIZE_TYPE, end)?;
        let frame = position.zip(size).map(|(position, size)| {
            dictation_correction_capture::FocusedFieldFrame {
                x: position.0.round() as i64,
                y: position.1.round() as i64,
                width: size.0.round() as i64,
                height: size.1.round() as i64,
            }
        });
        let (frontmost_bundle_id, frontmost_app_name) =
            original_application_identity(pid).ok_or(())?;
        let fingerprint = FocusedFieldFingerprint {
            pid: Some(pid),
            native_element_hash: Some(hash),
            role: Some(role),
            identifier,
            title,
            window_title,
            window_identifier,
            frame,
            frontmost_bundle_id,
            frontmost_app_name,
        };
        if Instant::now() >= end
            || expected.is_some_and(|expected| !fingerprint.matches_insertion(expected))
        {
            return Err(());
        }
        Ok((focused, fingerprint, hash))
    }

    fn drain() -> bool {
        for _ in 0..32 {
            let status = unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 1) };
            if status == kCFRunLoopRunTimedOut {
                return true;
            }
            if status != kCFRunLoopRunHandledSource {
                return false;
            }
        }
        false
    }

    pub(super) fn read_initial(reader: &MacosFocusedFieldReader) -> Option<FocusedFieldSnapshot> {
        let end = Instant::now() + Duration::from_millis(250);
        let pid = reader.original.pid?;
        let hash = reader.original.element_hash?;
        let app = AxObject(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            return None;
        }
        let (field, fingerprint, _) = metadata(&app, pid, None, Some(hash), end).ok()?;
        let text = reader.read_original_value(&fingerprint, || {
            if !safe_to_read(field.0, end) {
                return None;
            }
            string(attribute(field.0, "AXValue", end).ok()??.0).ok()
        })?;
        metadata(&app, pid, Some(&fingerprint), Some(hash), end).ok()?;
        if Instant::now() >= end {
            return None;
        }
        Some(FocusedFieldSnapshot { text, fingerprint })
    }

    pub(super) fn read_once<A>(
        expected: &FocusedFieldFingerprint,
        expected_hash: Option<u64>,
        end: Instant,
        acquire_read: impl Fn() -> Option<A>,
    ) -> Option<FocusedFieldSnapshot> {
        let may_read = || acquire_read().is_some();
        if !may_read() || Instant::now() >= end {
            return None;
        }
        let read_end = end.min(Instant::now() + Duration::from_millis(250));
        let pid = expected.pid?;
        let app = AxObject(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            return None;
        }
        let (field, fingerprint, hash) =
            metadata(&app, pid, Some(expected), expected_hash, read_end).ok()?;
        if !may_read() || !safe_to_read(field.0, read_end) || Instant::now() >= read_end {
            return None;
        }
        let text = with_value_read_authority(&acquire_read, || {
            string(attribute(field.0, "AXValue", read_end).ok()??.0).ok()
        })?;
        metadata(&app, pid, Some(expected), Some(hash), read_end).ok()?;
        if !may_read() || Instant::now() >= read_end {
            return None;
        }
        Some(FocusedFieldSnapshot { text, fingerprint })
    }

    pub(super) fn observe<A>(
        expected: &FocusedFieldFingerprint,
        inserted_text: &str,
        end: Instant,
        acquire_read: impl Fn() -> Option<A>,
        accept_sample: impl Fn(&str) -> bool,
    ) -> CorrectionWatchOutcome {
        let may_read = || acquire_read().is_some();
        if !may_read()
            || Instant::now() >= end
            || !check_accessibility_permission()
            || secure_event_input_enabled()
        {
            return CorrectionWatchOutcome::Aborted;
        }
        let started = Instant::now();
        let end = end.min(started + LIFETIME);
        let setup_end = end.min(started + Duration::from_millis(250));
        let Some(pid) = expected.pid else {
            return CorrectionWatchOutcome::Aborted;
        };
        let app = AxObject(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            return CorrectionWatchOutcome::Aborted;
        }
        let Ok((field, _, hash)) = metadata(&app, pid, Some(expected), None, setup_end) else {
            return CorrectionWatchOutcome::Aborted;
        };
        let state = CallbackState {
            started,
            policy: RefCell::new(WatchPolicy::default()),
        };
        let context = (&state as *const CallbackState).cast_mut().cast();
        let mut raw = std::ptr::null();
        if unsafe { AXObserverCreate(pid, changed, &mut raw) } != AX_ERROR_SUCCESS || raw.is_null()
        {
            return CorrectionWatchOutcome::Unsupported(Some(hash));
        }
        let observer = AxObject(raw);
        for (element, name) in [
            (field.0, "AXValueChanged"),
            (app.0, "AXFocusedUIElementChanged"),
            (app.0, "AXFocusedWindowChanged"),
            (app.0, "AXApplicationDeactivated"),
        ] {
            let notification = CFString::new(name);
            if !messaging_timeout(element, setup_end) {
                return CorrectionWatchOutcome::Aborted;
            }
            if unsafe {
                AXObserverAddNotification(
                    observer.0,
                    element,
                    notification.as_concrete_TypeRef(),
                    context,
                )
            } != AX_ERROR_SUCCESS
            {
                return CorrectionWatchOutcome::Unsupported(Some(hash));
            }
        }
        let source = unsafe { AXObserverGetRunLoopSource(observer.0) };
        if source.is_null() {
            return CorrectionWatchOutcome::Unsupported(Some(hash));
        }
        let run_loop = unsafe { CFRunLoopGetCurrent() };
        unsafe {
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
        }
        let _source = SourceGuard { run_loop, source };
        if metadata(&app, pid, Some(expected), Some(hash), setup_end).is_err() || !drain() {
            return CorrectionWatchOutcome::Aborted;
        }
        loop {
            if Instant::now() >= end
                || !check_accessibility_permission()
                || secure_event_input_enabled()
            {
                return CorrectionWatchOutcome::Aborted;
            }
            let action = state
                .policy
                .borrow_mut()
                .action(started.elapsed(), may_read());
            match action {
                WatchAction::Abort => return CorrectionWatchOutcome::Aborted,
                WatchAction::Wait => {}
                WatchAction::Sample => {
                    let read_end = end.min(Instant::now() + Duration::from_millis(250));
                    let Ok((current, fingerprint, _)) =
                        metadata(&app, pid, Some(expected), Some(hash), read_end)
                    else {
                        return CorrectionWatchOutcome::Aborted;
                    };
                    // Process pending cancellation before reading any field value.
                    if !drain() || !may_read() || Instant::now() >= read_end {
                        return CorrectionWatchOutcome::Aborted;
                    }
                    // A cancellation during metadata checks must discard this probe.
                    let cancelled = state.policy.borrow().cancelled;
                    if cancelled || !safe_to_read(current.0, read_end) {
                        return CorrectionWatchOutcome::Aborted;
                    }
                    let Some(text) = with_value_read_authority(&acquire_read, || {
                        string(attribute(current.0, "AXValue", read_end).ok()??.0).ok()
                    }) else {
                        return CorrectionWatchOutcome::Aborted;
                    };
                    if metadata(&app, pid, Some(expected), Some(hash), read_end).is_err()
                        || !drain()
                        || state.policy.borrow().cancelled
                        || !may_read()
                        || Instant::now() >= read_end
                    {
                        return CorrectionWatchOutcome::Aborted;
                    }
                    let unchanged =
                        dictation_correction_capture::anchor_snapshot_contains_insertion(
                            &text,
                            inserted_text,
                        );
                    let acceptable = !unchanged && accept_sample(&text);
                    if !drain() {
                        return CorrectionWatchOutcome::Aborted;
                    }
                    let completion = state.policy.borrow_mut().finish_probe(
                        !acceptable,
                        started.elapsed(),
                        may_read(),
                    );
                    match completion {
                        WatchAction::Sample => {
                            return CorrectionWatchOutcome::Sample(Box::new(FocusedFieldSnapshot {
                                text,
                                fingerprint,
                            }))
                        }
                        WatchAction::Abort => return CorrectionWatchOutcome::Aborted,
                        WatchAction::Wait => continue,
                    }
                }
            }
            let duration = end
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(20));
            let status =
                unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, duration.as_secs_f64(), 1) };
            if status != kCFRunLoopRunHandledSource && status != kCFRunLoopRunTimedOut {
                return CorrectionWatchOutcome::Aborted;
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn observe_post_insert_correction<A>(
    _session: &CorrectionCaptureSession,
    expected: &FocusedFieldFingerprint,
    inserted_text: &str,
    end: Instant,
    acquire_read: impl Fn() -> Option<A>,
    accept_sample: impl Fn(&str) -> bool,
) -> CorrectionWatchOutcome {
    objc2::rc::autoreleasepool(|_| {
        native::observe(expected, inserted_text, end, acquire_read, accept_sample)
    })
}

/// Bounded one-shot fallback when this application cannot publish notifications.
pub(crate) fn read_post_insert_correction_once<A>(
    _session: &CorrectionCaptureSession,
    expected: &FocusedFieldFingerprint,
    expected_hash: Option<u64>,
    end: Instant,
    acquire_read: impl Fn() -> Option<A>,
) -> Option<FocusedFieldSnapshot> {
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| {
            native::read_once(expected, expected_hash, end, acquire_read)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (expected, expected_hash, end, acquire_read);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictation_correction_capture;

    #[test]
    fn deletion_pause_then_retyping_only_proposes_the_completed_word() {
        let inserted = "please review the kuberentes manifest before friday";
        let known = std::collections::HashSet::new();
        for (completed_at, partial, cancel_at, expected_reads) in [
            (1400, "kuber", None, 2),
            (2000, "ku", None, 3),
            (1400, "kuber", Some(1200), 1),
        ] {
            let mut policy = WatchPolicy::default();
            let mut proposed = Vec::new();
            let mut value = "";
            // Fake clock and field values, with a deletion pause longer than 150 ms.
            for millis in (0..=3000).step_by(100) {
                match millis {
                    0 => value = "please review the manifest before friday",
                    1000 => {
                        value = if partial == "kuber" {
                            "please review the kuber manifest before friday"
                        } else {
                            "please review the ku manifest before friday"
                        };
                    }
                    at if at == completed_at => {
                        value = "please review the kubernetes manifest before friday";
                    }
                    _ => {}
                }
                let at = Duration::from_millis(millis);
                if matches!(millis, 0 | 1000) || millis == completed_at {
                    policy.value_changed(at);
                }
                if cancel_at == Some(millis) {
                    policy.cancel();
                }
                let action = policy.action(at, true);
                if millis == 200 {
                    assert_eq!(action, WatchAction::Wait);
                }
                match action {
                    WatchAction::Wait => {}
                    WatchAction::Abort => break,
                    WatchAction::Sample => {
                        let candidates = dictation_correction_capture::derive_readback_candidates(
                            inserted, value, &known,
                        );
                        let acceptable = candidates.as_ref().is_ok_and(|pairs| !pairs.is_empty());
                        if policy.finish_probe(!acceptable, at, true) == WatchAction::Sample {
                            proposed.extend(candidates.unwrap());
                            break;
                        }
                    }
                }
            }
            if cancel_at.is_some() {
                assert!(proposed.is_empty());
                assert_eq!(policy.probes, expected_reads);
                continue;
            }
            assert_eq!(
                proposed,
                vec![dictation_correction_capture::ReadbackCorrectionCandidate {
                    spoken_form: "kuberentes".into(),
                    replacement: "kubernetes".into(),
                }]
            );
            assert_eq!(policy.probes, expected_reads);
            assert!(policy.probes <= MAX_VALUE_PROBES);
        }
    }

    #[test]
    fn revoked_value_read_authority_never_reads() {
        let result = with_value_read_authority(
            || None::<()>,
            || panic!("revoked authority must not read the field"),
        );
        assert_eq!(result, None::<()>);
    }

    #[test]
    fn value_read_authority_is_held_until_read_returns() {
        let authority = std::sync::Mutex::new(());
        for value in [Some("sample"), None] {
            let result = with_value_read_authority(
                || authority.try_lock().ok(),
                || {
                    assert!(authority.try_lock().is_err());
                    value
                },
            );
            assert_eq!(result, value);
            assert!(authority.try_lock().is_ok());
        }
    }

    #[test]
    fn revocation_acknowledgment_waits_for_the_value_read() {
        use std::sync::{mpsc, Arc, Mutex};
        let enabled = Arc::new(Mutex::new(true));
        let revocation = Arc::clone(&enabled);
        let (attempted_tx, attempted_rx) = mpsc::channel();
        let (acknowledged_tx, acknowledged_rx) = mpsc::channel();
        let mut revoker = None;
        let result = with_value_read_authority(
            || enabled.try_lock().ok().filter(|guard| **guard),
            || {
                revoker = Some(std::thread::spawn(move || {
                    assert!(revocation.try_lock().is_err());
                    attempted_tx.send(()).unwrap();
                    *revocation.lock().unwrap() = false;
                    acknowledged_tx.send(()).unwrap();
                }));
                attempted_rx.recv().unwrap();
                assert!(matches!(
                    acknowledged_rx.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
                Some("sample")
            },
        );
        assert_eq!(result, Some("sample"));
        acknowledged_rx.recv().unwrap();
        revoker.unwrap().join().unwrap();
        let next = with_value_read_authority(
            || enabled.try_lock().ok().filter(|guard| **guard),
            || panic!("acknowledged revocation must prevent a new read"),
        );
        assert_eq!(next, None::<()>);
    }

    #[test]
    fn value_event_samples_once_after_debounce() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::from_millis(60));
        assert_eq!(
            policy.action(Duration::from_millis(600), true),
            WatchAction::Wait
        );
        assert_eq!(
            policy.action(Duration::from_millis(960), true),
            WatchAction::Sample
        );
        assert_eq!(
            policy.finish_probe(false, Duration::from_millis(1020), true),
            WatchAction::Sample
        );
        assert_eq!(
            policy.action(Duration::from_millis(1200), true),
            WatchAction::Abort
        );
    }

    #[test]
    fn another_value_event_restarts_the_debounce() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        policy.value_changed(Duration::from_millis(600));
        assert_eq!(
            policy.action(Duration::from_millis(960), true),
            WatchAction::Wait
        );
        assert_eq!(
            policy.action(Duration::from_millis(1500), true),
            WatchAction::Sample
        );
    }

    #[test]
    fn focus_cancellation_is_permanent() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        policy.cancel();
        policy.value_changed(Duration::from_millis(60));
        assert_eq!(
            policy.action(Duration::from_millis(960), true),
            WatchAction::Abort
        );
    }

    #[test]
    fn expiry_precedes_an_edit_sample() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::from_secs(7));
        assert_eq!(policy.action(LIFETIME, true), WatchAction::Abort);
    }

    #[test]
    fn busy_or_revoked_consent_stops_tracking() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        assert_eq!(
            policy.action(Duration::from_millis(960), false),
            WatchAction::Abort
        );
        assert_eq!(
            policy.action(Duration::from_millis(1200), true),
            WatchAction::Abort
        );
    }
    #[test]
    fn busy_slot_aborts_and_teardown_releases_it() {
        let active = std::sync::atomic::AtomicBool::new(false);
        let owner = Slot::claim(&active).expect("first session owns slot");
        assert!(Slot::claim(&active).is_none());
        drop(owner);
        assert!(Slot::claim(&active).is_some());
    }

    #[test]
    fn unsupported_registration_falls_back_at_absolute_four_seconds() {
        assert_eq!(
            correction_fallback_wait(Duration::from_millis(250)),
            Some(Duration::from_millis(3750))
        );
        assert_eq!(
            correction_fallback_wait(Duration::from_secs(5)),
            Some(Duration::ZERO)
        );
        assert_eq!(correction_fallback_wait(LIFETIME), None);
    }

    #[test]
    fn cancellation_between_debounce_and_read_is_visible() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        assert_eq!(policy.action(DEBOUNCE, true), WatchAction::Sample);
        policy.cancel();
        assert!(policy.cancelled);
    }

    #[test]
    fn no_op_probe_keeps_watching_for_a_later_correction() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        assert_eq!(policy.action(DEBOUNCE, true), WatchAction::Sample);
        assert_eq!(policy.finish_probe(true, DEBOUNCE, true), WatchAction::Wait);
        assert_eq!(
            policy.action(Duration::from_millis(1800), true),
            WatchAction::Wait
        );
        policy.value_changed(Duration::from_millis(2400));
        assert_eq!(
            policy.action(Duration::from_millis(3300), true),
            WatchAction::Sample
        );
        assert_eq!(
            policy.finish_probe(false, Duration::from_millis(3300), true),
            WatchAction::Sample
        );
        assert_eq!(
            policy.action(Duration::from_millis(3600), true),
            WatchAction::Abort
        );
    }

    #[test]
    fn no_op_probes_stop_at_the_physical_read_budget() {
        let mut policy = WatchPolicy::default();
        for probe in 0..MAX_VALUE_PROBES {
            let event = Duration::from_millis(probe as u64 * 1800);
            policy.value_changed(event);
            assert_eq!(policy.action(event + DEBOUNCE, true), WatchAction::Sample);
            let expected = if probe + 1 == MAX_VALUE_PROBES {
                WatchAction::Abort
            } else {
                WatchAction::Wait
            };
            assert_eq!(policy.finish_probe(true, event + DEBOUNCE, true), expected);
        }
        policy.value_changed(Duration::from_secs(2));
        assert_eq!(
            policy.action(Duration::from_secs(3), true),
            WatchAction::Abort
        );
    }

    #[test]
    fn no_op_probe_never_revives_cancelled_tracking() {
        let mut policy = WatchPolicy::default();
        policy.value_changed(Duration::ZERO);
        assert_eq!(policy.action(DEBOUNCE, true), WatchAction::Sample);
        policy.cancel();
        assert_eq!(
            policy.finish_probe(true, DEBOUNCE, true),
            WatchAction::Abort
        );
        policy.value_changed(Duration::from_secs(1));
        assert_eq!(
            policy.action(Duration::from_secs(2), true),
            WatchAction::Abort
        );
    }

    #[test]
    fn event_during_probe_waits_for_latest_edit() {
        for unchanged in [true, false] {
            let mut policy = WatchPolicy::default();
            policy.value_changed(Duration::ZERO);
            assert_eq!(policy.action(DEBOUNCE, true), WatchAction::Sample);
            policy.value_changed(Duration::from_millis(960));
            assert_eq!(
                policy.finish_probe(unchanged, Duration::from_millis(1020), true),
                WatchAction::Wait
            );
            assert_eq!(
                policy.action(Duration::from_millis(1200), true),
                WatchAction::Wait
            );
            assert_eq!(
                policy.action(Duration::from_millis(1860), true),
                WatchAction::Sample
            );
            assert_eq!(
                policy.finish_probe(false, Duration::from_millis(1920), true),
                WatchAction::Sample
            );
        }
    }
}
