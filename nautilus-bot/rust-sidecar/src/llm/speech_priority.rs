//! Live speech comes before background model work.
//!
//! A dictation session and a meeting capture register here for as long as
//! they run, and every background text request (a meeting's notes) registers
//! for as long as it talks to its helper. Speech never waits on that work:
//!
//! - When the tier's budgets say speech plus the background model do not fit
//!   (`HardwareTier::background_fits_beside_speech`), the background request
//!   is stopped the moment speech starts, and new ones are refused until it
//!   ends. Notes see the refusal as a memory wait and are written afterwards.
//! - When they do fit, both run; if speech admission is still refused for
//!   memory, speech stops the background requests and asks once more.
//!
//! Stopping kills the helper (no graceful cancel), so its memory claim is
//! returned within one 50 ms poll plus process exit.

use super::bundled_local::CancelFlag;
use crate::hardware_tier::{HardwareTier, SpeechUse};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// How long speech admission waits for stopped background requests to give
/// their memory back before asking again.
pub(crate) const PREEMPT_RELEASE_WAIT: Duration = Duration::from_millis(500);

pub(crate) struct Precedence {
    dictation: AtomicBool,
    user_waiting: AtomicUsize,
    meetings: AtomicUsize,
    background: Mutex<Vec<Registered>>,
    released: Condvar,
    next_id: AtomicU64,
    tier: fn() -> HardwareTier,
}

struct Registered {
    id: u64,
    claim_bytes: u64,
    stop: CancelFlag,
}

impl Precedence {
    pub(crate) const fn new(tier: fn() -> HardwareTier) -> Self {
        Self {
            dictation: AtomicBool::new(false),
            user_waiting: AtomicUsize::new(0),
            meetings: AtomicUsize::new(0),
            background: Mutex::new(Vec::new()),
            released: Condvar::new(),
            next_id: AtomicU64::new(0),
            tier,
        }
    }

    fn speech(&self) -> Option<SpeechUse> {
        if self.meetings.load(Ordering::SeqCst) > 0 {
            Some(SpeechUse::Meeting)
        } else if self.dictation.load(Ordering::SeqCst) {
            Some(SpeechUse::Dictation)
        } else {
            None
        }
    }

    pub(crate) fn speech_active(&self) -> bool {
        self.speech().is_some()
    }

    /// A dictation runs while a meeting records: an aside, or an ordinary
    /// dictation beside a system-audio-only meeting.
    pub(crate) fn dictation_beside_meeting(&self) -> bool {
        self.dictation.load(Ordering::SeqCst) && self.meetings.load(Ordering::SeqCst) > 0
    }

    /// Whether background work claiming `claim_bytes` may run right now.
    pub(crate) fn background_fits(&self, claim_bytes: u64) -> bool {
        !self.user_waiting()
            && self.speech().is_none_or(|speech| {
                (self.tier)().background_fits_beside_speech(speech, claim_bytes)
            })
    }

    pub(crate) fn user_waiting(&self) -> bool {
        self.user_waiting.load(Ordering::Acquire) > 0
    }

    pub(crate) fn begin_user_waiting(&self) {
        self.user_waiting.fetch_add(1, Ordering::AcqRel);
        self.stop_all();
    }

    pub(crate) fn end_user_waiting(&self) {
        self.user_waiting.fetch_sub(1, Ordering::AcqRel);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Registered>> {
        self.background.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn set_dictation(&self, active: bool) {
        let was = self.dictation.swap(active, Ordering::SeqCst);
        if active && !was {
            self.stop_unfitting();
        }
    }

    pub(crate) fn begin_meeting(&self) {
        self.meetings.fetch_add(1, Ordering::SeqCst);
        self.stop_unfitting();
    }

    pub(crate) fn end_meeting(&self) {
        let _ = self
            .meetings
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                Some(count.saturating_sub(1))
            });
    }

    /// Register one background request that `stop` can end. `None` means it
    /// must not start: speech is running and the two do not fit.
    pub(crate) fn begin_background(
        &self,
        claim_bytes: u64,
        stop: &CancelFlag,
    ) -> Option<BackgroundRequest<'_>> {
        // The check and the push share the lock with `stop_unfitting`, so a
        // request admitted just before speech starts is still stopped.
        let mut registered = self.lock();
        if !self.background_fits(claim_bytes) {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        registered.push(Registered {
            id,
            claim_bytes,
            stop: stop.clone(),
        });
        Some(BackgroundRequest {
            owner: self,
            id,
            stop: stop.clone(),
        })
    }

    fn stop_where(&self, predicate: impl Fn(&Registered) -> bool) -> usize {
        let registered = self.lock();
        let mut stopped = 0;
        for entry in registered.iter().filter(|entry| predicate(entry)) {
            entry.stop.stop_now();
            stopped += 1;
        }
        stopped
    }

    fn stop_unfitting(&self) -> usize {
        self.stop_where(|entry| !self.background_fits(entry.claim_bytes))
    }

    /// Stop every background request, whatever the tier says.
    pub(crate) fn stop_all(&self) -> usize {
        self.stop_where(|_| true)
    }

    /// Wait until every stopped request has ended, or `bound` passes.
    pub(crate) fn wait_for_stopped(&self, bound: Duration) -> bool {
        let registered = self.lock();
        let (_registered, timeout) = self
            .released
            .wait_timeout_while(registered, bound, |registered| {
                registered.iter().any(|entry| entry.stop.must_stop_now())
            })
            .unwrap_or_else(|e| e.into_inner());
        !timeout.timed_out()
    }

    #[cfg(test)]
    pub(crate) fn background_count(&self) -> usize {
        self.lock().len()
    }
}

/// A registered background request. Dropping it, after its helper has
/// exited, wakes speech waiting for the memory.
pub(crate) struct BackgroundRequest<'a> {
    owner: &'a Precedence,
    id: u64,
    stop: CancelFlag,
}

impl BackgroundRequest<'_> {
    /// Whether speech stopped this request.
    pub(crate) fn yielded(&self) -> bool {
        self.stop.must_stop_now()
    }
}

impl Drop for BackgroundRequest<'_> {
    fn drop(&mut self) {
        self.owner.lock().retain(|entry| entry.id != self.id);
        self.owner.released.notify_all();
    }
}

pub(crate) static PRECEDENCE: Precedence = Precedence::new(crate::hardware_tier::current);

/// Dictation started or ended. Called on every transition of the session
/// state, so a stuck flag cannot outlive the session.
pub(crate) fn set_dictation_active(active: bool) {
    PRECEDENCE.set_dictation(active);
    if active {
        release_idle_background_soon();
    }
}

/// Ending a helper waits for its process to exit, so it runs off the
/// caller's thread (dictation start holds its session locks here).
fn release_idle_background_soon() {
    let _ = std::thread::Builder::new()
        .name("speech-release-notes".into())
        .spawn(|| {
            release_idle_background();
        });
}

/// Held for as long as a meeting is captured and transcribed live.
pub(crate) struct MeetingSpeech(());

impl Drop for MeetingSpeech {
    fn drop(&mut self) {
        PRECEDENCE.end_meeting();
    }
}

pub(crate) fn meeting_speech() -> MeetingSpeech {
    PRECEDENCE.begin_meeting();
    release_idle_background_soon();
    MeetingSpeech(())
}

pub(crate) fn speech_active() -> bool {
    PRECEDENCE.speech_active()
}

/// See [`Precedence::dictation_beside_meeting`].
pub(crate) fn dictation_beside_meeting() -> bool {
    PRECEDENCE.dictation_beside_meeting()
}

/// End an idle notes helper whose memory does not fit beside the speech now
/// running. A helper in the middle of a request is stopped through its
/// registration instead.
pub(crate) fn release_idle_background() -> bool {
    super::native_text::end_idle_helper_unless(|claim| PRECEDENCE.background_fits(claim))
}

tokio::task_local! {
    static BACKGROUND_TEXT: bool;
}

/// Run `work` as background text work: its built-in text requests yield to
/// live speech. Only the meeting notes pass uses this; Ask and dictation
/// cleanup are what the person is waiting on.
pub(crate) async fn as_background_text<F: std::future::Future>(work: F) -> F::Output {
    if in_background_text() {
        return work.await;
    }
    // Light keeps one claim across summary and actions. Closing and reloading
    // between stages can lose the narrow away window to a headroom change.
    struct EndNotes(bool);
    impl Drop for EndNotes {
        fn drop(&mut self) {
            if self.0 {
                super::native_text::end_job();
            }
        }
    }
    let keep = crate::hardware_tier::current() == HardwareTier::Light;
    BACKGROUND_TEXT
        .scope(keep, async {
            let _end = EndNotes(keep);
            work.await
        })
        .await
}

pub(crate) fn keep_helper_for_job() -> bool {
    BACKGROUND_TEXT.try_with(|keep| *keep).unwrap_or(false)
}

pub(crate) fn in_background_text() -> bool {
    BACKGROUND_TEXT.try_with(|_| ()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn light() -> HardwareTier {
        HardwareTier::Light
    }

    fn best() -> HardwareTier {
        HardwareTier::Best
    }

    const LIGHT_NOTES: u64 = 1_927_364_608;
    const BEST_NOTES: u64 = 3_902_210_048;

    #[test]
    fn user_waiting_dictation_stops_notes_even_when_tier_budgets_fit() {
        let precedence = Precedence::new(best);
        let request = precedence
            .begin_background(BEST_NOTES, &CancelFlag::new())
            .unwrap();
        precedence.begin_user_waiting();
        assert!(request.yielded());
        assert!(precedence.begin_background(1, &CancelFlag::new()).is_none());
        precedence.begin_user_waiting();
        precedence.end_user_waiting();
        assert!(!precedence.background_fits(1));
        precedence.end_user_waiting();
        assert!(precedence.background_fits(1));
    }

    #[test]
    fn a_dictation_is_beside_a_meeting_only_while_both_run() {
        let precedence = Precedence::new(best);
        assert!(!precedence.dictation_beside_meeting());
        precedence.set_dictation(true);
        assert!(!precedence.dictation_beside_meeting());
        precedence.begin_meeting();
        assert!(precedence.dictation_beside_meeting());
        precedence.set_dictation(false);
        assert!(!precedence.dictation_beside_meeting());
        precedence.set_dictation(true);
        precedence.end_meeting();
        assert!(!precedence.dictation_beside_meeting());
    }

    #[test]
    fn on_light_dictation_stops_a_running_notes_request_and_refuses_new_ones() {
        let precedence = Precedence::new(light);
        let stop = CancelFlag::new();
        let request = precedence.begin_background(LIGHT_NOTES, &stop).unwrap();
        assert!(!request.yielded());
        precedence.set_dictation(true);
        assert!(request.yielded(), "the running request is stopped at once");
        assert!(stop.is_cancelled());
        assert!(precedence
            .begin_background(LIGHT_NOTES, &CancelFlag::new())
            .is_none());
        drop(request);
        precedence.set_dictation(false);
        assert!(precedence
            .begin_background(LIGHT_NOTES, &CancelFlag::new())
            .is_some());
    }

    #[test]
    fn on_best_notes_keep_running_beside_dictation_and_a_meeting() {
        let precedence = Precedence::new(best);
        let stop = CancelFlag::new();
        let request = precedence.begin_background(BEST_NOTES, &stop).unwrap();
        precedence.set_dictation(true);
        precedence.begin_meeting();
        assert!(!request.yielded());
        assert!(precedence
            .begin_background(BEST_NOTES, &CancelFlag::new())
            .is_some());
        assert_eq!(precedence.stop_all(), 1);
        assert!(request.yielded());
    }

    #[test]
    fn a_meeting_capture_stops_notes_that_do_not_fit_and_ending_it_admits_them() {
        let precedence = Precedence::new(light);
        let stop = CancelFlag::new();
        let request = precedence.begin_background(LIGHT_NOTES, &stop).unwrap();
        precedence.begin_meeting();
        assert!(request.yielded());
        drop(request);
        precedence.end_meeting();
        precedence.end_meeting();
        assert!(!precedence.speech_active(), "the count never underflows");
        assert!(precedence
            .begin_background(LIGHT_NOTES, &CancelFlag::new())
            .is_some());
    }

    #[test]
    fn speech_waits_only_until_stopped_requests_have_ended() {
        let precedence = Precedence::new(light);
        let stop = CancelFlag::new();
        let request = precedence.begin_background(LIGHT_NOTES, &stop).unwrap();
        assert!(
            precedence.wait_for_stopped(Duration::from_millis(1)),
            "nothing stopped, nothing to wait for"
        );
        precedence.set_dictation(true);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(20));
                drop(request);
            });
            let started = std::time::Instant::now();
            assert!(precedence.wait_for_stopped(Duration::from_secs(5)));
            assert!(started.elapsed() < Duration::from_secs(1));
        });
        assert_eq!(precedence.background_count(), 0);
        let stuck = precedence.stop_all();
        assert_eq!(stuck, 0);
    }

    #[test]
    fn a_request_that_never_ends_bounds_the_wait() {
        let precedence = Precedence::new(light);
        let stop = CancelFlag::new();
        let _request = precedence.begin_background(LIGHT_NOTES, &stop).unwrap();
        precedence.set_dictation(true);
        let started = std::time::Instant::now();
        assert!(!precedence.wait_for_stopped(Duration::from_millis(30)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn only_work_inside_the_scope_is_background_text() {
        assert!(!in_background_text());
        assert!(as_background_text(async { in_background_text() }).await);
        assert!(!in_background_text());
    }
}
