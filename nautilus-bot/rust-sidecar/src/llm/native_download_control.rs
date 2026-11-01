//! Atomically register a download before accepting cancellation.
use std::sync::Mutex;

#[derive(Default)]
struct State {
    active: bool,
    cancelled: bool,
}
pub(crate) struct DownloadControl(Mutex<State>);
pub(crate) struct DownloadLease<'a>(&'a DownloadControl);
impl DownloadControl {
    pub(crate) const fn new() -> Self {
        Self(Mutex::new(State {
            active: false,
            cancelled: false,
        }))
    }
    pub(crate) fn begin(
        &self,
        clear_previous_notification: impl FnOnce(),
    ) -> Result<DownloadLease<'_>, &'static str> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.active {
            return Err("A native model download or deletion is already running");
        }
        clear_previous_notification();
        state.cancelled = false;
        state.active = true;
        Ok(DownloadLease(self))
    }
    pub(crate) fn cancel(&self, notify: impl FnOnce()) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.active {
            state.cancelled = true;
            notify();
        }
    }
    pub(crate) fn cancelled(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancelled
    }
}
impl Drop for DownloadLease<'_> {
    fn drop(&mut self) {
        self.0
             .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active = false;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_after_registration_is_not_reset_by_a_competing_start() {
        let control = DownloadControl::new();
        let lease = control.begin(|| {}).unwrap();
        control.cancel(|| {});
        assert!(control.cancelled());
        assert!(control
            .begin(|| panic!("must not clear another operation's cancellation"))
            .is_err());
        assert!(control.cancelled());
        drop(lease);
    }
    #[test]
    fn a_completed_cancelled_operation_does_not_cancel_the_next_one() {
        let control = DownloadControl::new();
        let lease = control.begin(|| {}).unwrap();
        control.cancel(|| {});
        drop(lease);
        let _next = control.begin(|| {}).unwrap();
        assert!(!control.cancelled());
    }
    #[test]
    fn cancellation_while_idle_does_not_notify_or_poison_a_future_start() {
        let control = DownloadControl::new();
        control.cancel(|| panic!("idle cancellation must not notify"));
        let _lease = control.begin(|| {}).unwrap();
        assert!(!control.cancelled());
    }
}
