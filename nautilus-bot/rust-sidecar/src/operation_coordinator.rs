use std::sync::{Arc, Mutex};
use tokio::sync::{watch, Notify};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationKind {
    Command,
    Capture,
    PostProcess,
    Backup,
    Restore,
    VaultMigration,
    VaultLock,
    RuntimeAudio,
    ModelRelease,
    /// A retention or transcript-only storage sweep.
    ///
    /// These hold the audio storage gate for as long as it takes to delete
    /// every eligible meeting's audio. Nothing stopped one from starting during
    /// a meeting, and stopping that meeting then blocked on the gate — with the
    /// microphone still running — until the sweep finished. Excluding it against
    /// `Capture` the way `Backup`/`Restore` already are is what keeps the stop
    /// path's gate wait short in the first place.
    StorageMaintenance,
    /// One batch of background meaning-search indexing: reading a transcript,
    /// embedding a few windows and writing them. Short, so restore and vault
    /// work wait at most one batch, and it never starts while they run.
    SemanticIndex,
    NotePublish,
    HeavyPostCall,
}

impl OperationKind {
    fn label(self) -> &'static str {
        match self {
            Self::Command => "application command",
            Self::Capture => "meeting capture",
            Self::PostProcess => "meeting post-processing",
            Self::Backup => "backup",
            Self::Restore => "restore",
            Self::VaultMigration => "vault migration",
            Self::VaultLock => "vault lock",
            Self::RuntimeAudio => "decrypted audio playback",
            Self::ModelRelease => "native speech model release",
            Self::StorageMaintenance => "recording storage maintenance",
            Self::SemanticIndex => "search indexing",
            Self::NotePublish => "saving meeting notes",
            Self::HeavyPostCall => "meeting processing",
        }
    }
}

#[derive(Default)]
struct CoordinatorState {
    owners: Vec<(OperationKind, &'static str)>,
    /// Restores and vault migrations queued behind an indexing batch.
    library_replacement_pending: Vec<OperationKind>,
    restore_recovery_failure: Option<String>,
}

impl CoordinatorState {
    fn count(&self, kind: OperationKind) -> usize {
        self.owners
            .iter()
            .filter(|(owner, _)| *owner == kind)
            .count()
    }
}

pub(crate) struct OperationCoordinator {
    state: Mutex<CoordinatorState>,
    runtime_audio_generation: watch::Sender<u64>,
    changes: Arc<Notify>,
    indexing_changes: Arc<Notify>,
}

pub(crate) const DICTATION_ACTIVE_CAPTURE_ERROR: &str =
    "Dictation is running. Finish it, then try again.";

tokio::task_local! {
    static POST_CALL_SCOPE: ();
}

impl OperationCoordinator {
    /// Queue complete post-call jobs without loading their models. Nested
    /// analysis stages in the same task share the outer job's lease.
    pub(crate) async fn run_post_call<F: std::future::Future>(
        self: &Arc<Self>,
        label: &'static str,
        work: F,
    ) -> F::Output {
        if POST_CALL_SCOPE.try_with(|_| ()).is_ok() {
            return work.await;
        }
        let _lease = loop {
            let notified = self.changes.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Ok(lease) = self.try_acquire_named(OperationKind::HeavyPostCall, label) {
                break lease;
            }
            notified.await;
        };
        POST_CALL_SCOPE.scope((), work).await
    }

    /// A new meeting starts at once, even beside a post-call job or an
    /// indexing batch: those wait for capture, never the other way round.
    /// Dictation is checked again after the lease is granted.
    pub(crate) async fn acquire_capture<F, Fut>(
        self: &Arc<Self>,
        mut dictation_idle: F,
    ) -> Result<OperationLease, String>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        if !dictation_idle().await {
            return Err(DICTATION_ACTIVE_CAPTURE_ERROR.to_string());
        }
        let mut lease = self.try_acquire(OperationKind::Capture)?;
        if !dictation_idle().await {
            return Err(DICTATION_ACTIVE_CAPTURE_ERROR.to_string());
        }
        // Background notes yield to the live transcript for as long as the
        // capture lease lives, however the capture ends.
        lease.meeting_speech = Some(crate::llm::speech_priority::meeting_speech());
        Ok(lease)
    }

    pub(crate) fn new() -> Arc<Self> {
        let (runtime_audio_generation, _) = watch::channel(0);
        Arc::new(Self {
            state: Mutex::new(CoordinatorState::default()),
            runtime_audio_generation,
            changes: Arc::new(Notify::new()),
            indexing_changes: Arc::new(Notify::new()),
        })
    }

    pub(crate) fn changes(&self) -> Arc<Notify> {
        Arc::clone(&self.changes)
    }

    pub(crate) fn indexing_changes(&self) -> Arc<Notify> {
        Arc::clone(&self.indexing_changes)
    }

    pub(crate) fn quarantine_after_restore_failure(&self, reason: String) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.restore_recovery_failure.is_none() {
            state.restore_recovery_failure = Some(reason);
        }
        drop(state);
        self.changes.notify_waiters();
    }

    /// Acquire a restore or vault migration lease. Search indexing holds its
    /// lease for nearly all of a long first pass, one short batch at a time,
    /// so a single attempt would almost always fail. When indexing is the only
    /// blocker, this stops new batches and waits up to ten seconds for the
    /// running one to end. Any other blocker fails at once, as before.
    pub(crate) async fn acquire_library_replacement(
        self: &Arc<Self>,
        kind: OperationKind,
    ) -> Result<OperationLease, String> {
        struct Pending<'a>(&'a OperationCoordinator, OperationKind);
        impl Drop for Pending<'_> {
            fn drop(&mut self) {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if let Some(index) = state
                    .library_replacement_pending
                    .iter()
                    .position(|kind| *kind == self.1)
                {
                    state.library_replacement_pending.swap_remove(index);
                }
                drop(state);
                self.0.changes.notify_waiters();
                self.0.indexing_changes.notify_waiters();
            }
        }
        debug_assert!(matches!(
            kind,
            OperationKind::Restore | OperationKind::VaultMigration
        ));
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .library_replacement_pending
            .push(kind);
        let _pending = Pending(self, kind);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let notified = self.changes.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.try_acquire(kind) {
                Ok(lease) => return Ok(lease),
                Err(error) => {
                    let only_indexing = {
                        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                        state.restore_recovery_failure.is_none()
                            && Self::blockers(&state, kind)
                                == [OperationKind::SemanticIndex.label()]
                    };
                    if !only_indexing || tokio::time::Instant::now() >= deadline {
                        return Err(error);
                    }
                }
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(250), notified).await;
        }
    }

    /// Whether any operation of `kind` holds a lease right now.
    pub(crate) fn is_active(&self, kind: OperationKind) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .count(kind)
            > 0
    }

    pub(crate) fn try_acquire(
        self: &Arc<Self>,
        kind: OperationKind,
    ) -> Result<OperationLease, String> {
        self.try_acquire_with_pressure(kind, crate::memory_pressure::events().current())
    }

    pub(crate) fn try_acquire_named(
        self: &Arc<Self>,
        kind: OperationKind,
        label: &'static str,
    ) -> Result<OperationLease, String> {
        self.try_acquire_labelled(kind, crate::memory_pressure::events().current(), label)
    }

    pub(crate) fn try_acquire_with_pressure(
        self: &Arc<Self>,
        kind: OperationKind,
        pressure: crate::memory_pressure::MemoryPressure,
    ) -> Result<OperationLease, String> {
        self.try_acquire_labelled(kind, pressure, kind.label())
    }

    fn try_acquire_labelled(
        self: &Arc<Self>,
        kind: OperationKind,
        pressure: crate::memory_pressure::MemoryPressure,
        label: &'static str,
    ) -> Result<OperationLease, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(reason) = &state.restore_recovery_failure {
            return Err(format!(
                "Cannot start {}. Backup restore recovery is required: {}. Preserve the recovery copies and complete recovery before restarting Plainsong.",
                kind.label(), reason
            ));
        }
        if matches!(
            kind,
            OperationKind::SemanticIndex | OperationKind::NotePublish
        ) && !state.library_replacement_pending.is_empty()
        {
            return Err(format!(
                "Cannot start {} while {} {} waiting.",
                kind.label(),
                state
                    .library_replacement_pending
                    .iter()
                    .map(|kind| kind.label())
                    .collect::<Vec<_>>()
                    .join(", "),
                if state.library_replacement_pending.len() == 1 {
                    "is"
                } else {
                    "are"
                }
            ));
        }
        if kind == OperationKind::SemanticIndex
            && pressure != crate::memory_pressure::MemoryPressure::Normal
        {
            return Err(format!("Cannot start search indexing while memory pressure is {pressure:?}. Normal pressure is required."));
        }
        let blockers = Self::blockers(&state, kind);
        if !blockers.is_empty() {
            return Err(format!(
                "Cannot start {} while {} {} active.",
                kind.label(),
                blockers.join(", "),
                if blockers.len() == 1 { "is" } else { "are" }
            ));
        }

        if kind == OperationKind::VaultLock {
            let next = self.runtime_audio_generation.borrow().wrapping_add(1);
            self.runtime_audio_generation.send_replace(next);
        }
        let runtime_audio_generation = (kind == OperationKind::RuntimeAudio)
            .then(|| self.runtime_audio_generation.subscribe());
        state.owners.push((kind, label));
        drop(state);

        Ok(OperationLease {
            coordinator: Arc::clone(self),
            kind,
            label,
            runtime_audio_generation,
            meeting_speech: None,
        })
    }

    fn blockers(state: &CoordinatorState, requested: OperationKind) -> Vec<&'static str> {
        let candidates: &[OperationKind] = match requested {
            OperationKind::Command => &[OperationKind::Restore],
            // A meeting never waits for the last one's processing: losing the
            // start of a call costs more than a short memory peak. New post-call
            // jobs and indexing wait for capture instead (see their entries).
            OperationKind::Capture => &[
                OperationKind::Capture,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::StorageMaintenance,
                OperationKind::ModelRelease,
            ],
            // Post-processing is deliberately not excluded against storage
            // maintenance in either direction: the transcript-only sweep runs
            // from inside the post-processing pipeline, so excluding them would
            // make that pipeline unable to run its own cleanup.
            OperationKind::PostProcess => &[
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::ModelRelease,
            ],
            OperationKind::Backup => &[
                OperationKind::HeavyPostCall,
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::StorageMaintenance,
            ],
            OperationKind::Restore => &[
                OperationKind::HeavyPostCall,
                OperationKind::Command,
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::RuntimeAudio,
                OperationKind::StorageMaintenance,
                OperationKind::SemanticIndex,
                OperationKind::NotePublish,
            ],
            OperationKind::VaultMigration => &[
                OperationKind::HeavyPostCall,
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::RuntimeAudio,
                OperationKind::StorageMaintenance,
                OperationKind::SemanticIndex,
                OperationKind::NotePublish,
            ],
            // Runtime audio is revoked by vault lock instead of blocking it.
            OperationKind::VaultLock => &[
                OperationKind::NotePublish,
                OperationKind::HeavyPostCall,
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::StorageMaintenance,
            ],
            OperationKind::RuntimeAudio => &[
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::ModelRelease => &[OperationKind::Capture, OperationKind::PostProcess],
            OperationKind::StorageMaintenance => &[
                OperationKind::Capture,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::StorageMaintenance,
            ],
            // An indexing batch holds its lease for a fraction of a second, so
            // only the operations that replace the library wait on it (restore
            // and vault migration fail fast and can be retried); backup and
            // vault lock never do.
            OperationKind::NotePublish => &[
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::HeavyPostCall => &[
                OperationKind::Capture,
                OperationKind::HeavyPostCall,
                OperationKind::SemanticIndex,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::SemanticIndex => &[
                OperationKind::Capture,
                OperationKind::HeavyPostCall,
                OperationKind::PostProcess,
                OperationKind::SemanticIndex,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
        };

        candidates
            .iter()
            .copied()
            .flat_map(|kind| {
                state
                    .owners
                    .iter()
                    .filter_map(move |(owner, label)| (*owner == kind).then_some(*label))
            })
            .fold(Vec::new(), |mut blockers, label| {
                if !blockers.contains(&label) {
                    blockers.push(label);
                }
                blockers
            })
    }
}

pub(crate) struct OperationLease {
    coordinator: Arc<OperationCoordinator>,
    kind: OperationKind,
    label: &'static str,
    runtime_audio_generation: Option<watch::Receiver<u64>>,
    meeting_speech: Option<crate::llm::speech_priority::MeetingSpeech>,
}

impl OperationLease {
    pub(crate) fn into_restore_attempt(self) -> Result<RestoreAttempt, String> {
        if self.kind != OperationKind::Restore {
            return Err("A restore attempt requires a restore lease".to_string());
        }
        Ok(RestoreAttempt {
            lease: self,
            resolved: false,
        })
    }

    pub(crate) async fn cancelled(&mut self) {
        let Some(generation) = self.runtime_audio_generation.as_mut() else {
            std::future::pending::<()>().await;
            return;
        };
        let _ = generation.changed().await;
    }
}

pub(crate) struct RestoreAttempt {
    lease: OperationLease,
    resolved: bool,
}

impl RestoreAttempt {
    pub(crate) fn resolve(&mut self) {
        self.resolved = true;
    }
}

impl Drop for RestoreAttempt {
    fn drop(&mut self) {
        if !self.resolved {
            self.lease.coordinator.quarantine_after_restore_failure(
                "Backup restore was interrupted before runtime acceptance. Preserve recovery copies and complete recovery before restarting Plainsong.".to_string(),
            );
        }
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        {
            let mut state = self
                .coordinator
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let was_blocked =
                !OperationCoordinator::blockers(&state, OperationKind::SemanticIndex).is_empty();
            if let Some(owner) = state
                .owners
                .iter()
                .position(|entry| *entry == (self.kind, self.label))
            {
                state.owners.swap_remove(owner);
            }
            if was_blocked
                && OperationCoordinator::blockers(&state, OperationKind::SemanticIndex).is_empty()
            {
                self.coordinator.indexing_changes.notify_waiters();
            }
        }
        self.coordinator.changes.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn pressure_refusal_identifies_pressure_without_inventing_a_lease_owner() {
        use crate::memory_pressure::MemoryPressure;
        let coordinator = OperationCoordinator::new();
        for pressure in [MemoryPressure::Warning, MemoryPressure::Critical] {
            let error = coordinator
                .try_acquire_with_pressure(OperationKind::SemanticIndex, pressure)
                .err()
                .unwrap();
            assert!(error.contains(&format!("{pressure:?}")), "{error}");
            assert!(!error.contains("backup"), "{error}");
            assert!(!coordinator.is_active(OperationKind::SemanticIndex));
        }
        assert!(coordinator
            .try_acquire_with_pressure(OperationKind::SemanticIndex, MemoryPressure::Normal)
            .is_ok());
    }

    #[test]
    fn named_owners_drop_independently() {
        let coordinator = OperationCoordinator::new();
        let transcript = coordinator
            .try_acquire_named(OperationKind::PostProcess, "meeting transcript")
            .unwrap();
        let conversion = coordinator
            .try_acquire_named(OperationKind::PostProcess, "idle meeting audio conversion")
            .unwrap();
        let blocked = || {
            coordinator
                .try_acquire_with_pressure(
                    OperationKind::SemanticIndex,
                    crate::memory_pressure::MemoryPressure::Normal,
                )
                .err()
                .unwrap()
        };
        assert!(blocked().contains("meeting transcript"));
        assert!(blocked().contains("idle meeting audio conversion"));
        drop(transcript);
        assert!(!blocked().contains("meeting transcript"));
        assert!(blocked().contains("idle meeting audio conversion"));
        drop(conversion);
        assert!(coordinator
            .try_acquire_with_pressure(
                OperationKind::SemanticIndex,
                crate::memory_pressure::MemoryPressure::Normal
            )
            .is_ok());
    }

    #[tokio::test]
    async fn queued_library_replacement_names_its_kind_and_cancellation_releases_it() {
        use crate::memory_pressure::MemoryPressure;
        for kind in [OperationKind::Restore, OperationKind::VaultMigration] {
            let coordinator = OperationCoordinator::new();
            let index = coordinator
                .try_acquire_with_pressure(OperationKind::SemanticIndex, MemoryPressure::Normal)
                .unwrap();
            {
                let waiting = coordinator.acquire_library_replacement(kind);
                tokio::pin!(waiting);
                assert!(futures_util::poll!(&mut waiting).is_pending());
                let error = coordinator
                    .try_acquire_with_pressure(OperationKind::SemanticIndex, MemoryPressure::Normal)
                    .err()
                    .unwrap();
                assert!(
                    error.contains(&format!("{} is waiting", kind.label())),
                    "{error}"
                );
                // Cancelling the request drops its pending owner.
            }
            drop(index);
            assert!(coordinator
                .try_acquire_with_pressure(OperationKind::SemanticIndex, MemoryPressure::Normal)
                .is_ok());
        }
    }

    #[test]
    fn text_only_postcall_work_does_not_pin_the_speech_cache() {
        let coordinator = OperationCoordinator::new();
        let _text = coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .unwrap();
        assert!(
            coordinator.try_acquire(OperationKind::ModelRelease).is_ok(),
            "text-only post-call work must not pin the speech cache"
        );
        let _speech = coordinator.try_acquire(OperationKind::PostProcess).unwrap();
        assert!(
            coordinator
                .try_acquire(OperationKind::ModelRelease)
                .is_err(),
            "speech post-processing still protects its active model"
        );
    }

    #[tokio::test]
    async fn capture_rechecks_dictation_after_its_lease_is_granted() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let coordinator = OperationCoordinator::new();
        let checks = AtomicUsize::new(0);
        let result = coordinator
            .acquire_capture(|| std::future::ready(checks.fetch_add(1, Ordering::AcqRel) == 0))
            .await;
        assert_eq!(result.err().unwrap(), DICTATION_ACTIVE_CAPTURE_ERROR);
        assert!(!coordinator.is_active(OperationKind::Capture));
    }

    #[tokio::test]
    async fn a_meeting_starts_at_once_beside_post_call_work() {
        let coordinator = OperationCoordinator::new();
        let heavy = coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .unwrap();
        let Err(batch) = coordinator.try_acquire(OperationKind::SemanticIndex) else {
            panic!("indexing must wait for post-call work");
        };
        assert!(batch.contains("meeting processing"));
        let capture = tokio::time::timeout(
            Duration::from_millis(50),
            coordinator.acquire_capture(|| std::future::ready(true)),
        )
        .await
        .expect("a meeting must not wait for the previous one's processing")
        .unwrap();
        drop(heavy);
        // New heavy work and indexing wait while the meeting records.
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_err());
        assert!(coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .is_err());
        drop(capture);
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_ok());
    }

    #[tokio::test]
    async fn a_meeting_that_starts_during_notes_stops_them_without_waiting_for_them() {
        use crate::llm::speech_priority;
        let coordinator = OperationCoordinator::new();
        let (writing, written) = tokio::sync::oneshot::channel();
        let notes = {
            let coordinator = Arc::clone(&coordinator);
            tokio::spawn(async move {
                coordinator
                    .run_post_call(
                        "meeting processing",
                        speech_priority::as_background_text(async {
                            let _text = crate::llm::native_runtime_gate::TEXT_RUNTIME
                                .acquire_when_available()
                                .await
                                .unwrap();
                            // Stands in for a notes request on its helper. This
                            // claim fits beside speech on no tier.
                            tokio::task::spawn_blocking(move || {
                                let stop = crate::llm::bundled_local::CancelFlag::new();
                                let request = speech_priority::PRECEDENCE
                                    .begin_background(u64::MAX / 2, &stop);
                                let _ = writing.send(());
                                let Some(request) = request else {
                                    return true;
                                };
                                let give_up = std::time::Instant::now() + Duration::from_secs(1);
                                while !request.yielded() && std::time::Instant::now() < give_up {
                                    std::thread::sleep(Duration::from_millis(5));
                                }
                                request.yielded()
                            })
                            .await
                            .unwrap()
                        }),
                    )
                    .await
            })
        };
        written.await.unwrap();
        let capture = tokio::time::timeout(
            Duration::from_millis(50),
            coordinator.acquire_capture(|| std::future::ready(true)),
        )
        .await
        .expect("capture never waits for post-call notes")
        .unwrap();
        assert!(
            notes.await.unwrap(),
            "the capture stopped the notes request"
        );
        // The notes retry is post-call work: it waits for the capture.
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_err());
        drop(capture);
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_ok());
    }

    #[tokio::test]
    async fn post_call_jobs_wait_for_capture_and_run_one_at_a_time() {
        let coordinator = OperationCoordinator::new();
        let capture = coordinator.try_acquire(OperationKind::Capture).unwrap();
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let coordinator = Arc::clone(&coordinator);
            let active = Arc::clone(&active);
            let completed = Arc::clone(&completed);
            tasks.push(tokio::spawn(async move {
                coordinator
                    .run_post_call("meeting processing", async {
                        assert_eq!(active.fetch_add(1, std::sync::atomic::Ordering::SeqCst), 0);
                        // Same-task nested analysis must not deadlock.
                        coordinator
                            .run_post_call("meeting processing", async {
                                tokio::task::yield_now().await
                            })
                            .await;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    })
                    .await;
            }));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(completed.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(capture);
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(completed.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_cancelled_post_call_job_releases_its_lease() {
        let coordinator = OperationCoordinator::new();
        let (started, ready) = tokio::sync::oneshot::channel();
        let job = {
            let coordinator = Arc::clone(&coordinator);
            tokio::spawn(async move {
                coordinator
                    .run_post_call("meeting processing", async {
                        let _ = started.send(());
                        std::future::pending::<()>().await;
                    })
                    .await;
            })
        };
        ready.await.unwrap();
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_err());
        job.abort();
        let _ = job.await;
        assert!(coordinator
            .try_acquire(OperationKind::HeavyPostCall)
            .is_ok());
    }

    #[tokio::test]
    async fn a_restore_waits_out_an_indexing_batch_and_blocks_the_next() {
        let coordinator = OperationCoordinator::new();
        let batch = coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .unwrap();
        let waiting = {
            let coordinator = Arc::clone(&coordinator);
            tokio::spawn(async move {
                coordinator
                    .acquire_library_replacement(OperationKind::Restore)
                    .await
                    .map(|_lease| ())
            })
        };
        // While the restore waits, no new indexing batch may start.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .is_err());
        drop(batch);
        waiting.await.unwrap().unwrap();
        // Once the restore is done, indexing may resume.
        drop(
            coordinator
                .try_acquire(OperationKind::SemanticIndex)
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn a_restore_still_fails_at_once_for_other_blockers() {
        let coordinator = OperationCoordinator::new();
        let _capture = coordinator.try_acquire(OperationKind::Capture).unwrap();
        let started = std::time::Instant::now();
        assert!(coordinator
            .acquire_library_replacement(OperationKind::Restore)
            .await
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn search_indexing_and_library_replacement_exclude_each_other_but_not_backup() {
        let coordinator = OperationCoordinator::new();
        let indexing = coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .unwrap();
        assert!(coordinator.is_active(OperationKind::SemanticIndex));
        assert!(coordinator.try_acquire(OperationKind::Restore).is_err());
        assert!(coordinator
            .try_acquire(OperationKind::VaultMigration)
            .is_err());
        drop(coordinator.try_acquire(OperationKind::Backup).unwrap());
        drop(coordinator.try_acquire(OperationKind::VaultLock).unwrap());
        drop(indexing);
        let restore = coordinator.try_acquire(OperationKind::Restore).unwrap();
        assert!(coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .is_err());
        drop(restore);
        let backup = coordinator.try_acquire(OperationKind::Backup).unwrap();
        assert!(coordinator
            .try_acquire(OperationKind::SemanticIndex)
            .is_err());
        drop(backup);
        assert!(!coordinator.is_active(OperationKind::SemanticIndex));
    }

    #[test]
    fn interrupted_restore_attempt_quarantines_before_releasing_lease() {
        let coordinator = OperationCoordinator::new();
        let attempt = coordinator
            .try_acquire(OperationKind::Restore)
            .unwrap()
            .into_restore_attempt()
            .expect("restore attempt");
        drop(attempt);
        let error = coordinator
            .try_acquire(OperationKind::Command)
            .err()
            .unwrap();
        assert!(error.contains("interrupted before runtime acceptance"));
        assert!(coordinator.try_acquire(OperationKind::Restore).is_err());
    }

    #[test]
    fn resolved_restore_attempt_releases_without_quarantine() {
        let coordinator = OperationCoordinator::new();
        let mut attempt = coordinator
            .try_acquire(OperationKind::Restore)
            .unwrap()
            .into_restore_attempt()
            .expect("restore attempt");
        attempt.resolve();
        assert!(coordinator.try_acquire(OperationKind::Command).is_err());
        drop(attempt);
        coordinator.try_acquire(OperationKind::Command).unwrap();
        coordinator.try_acquire(OperationKind::Restore).unwrap();
    }

    #[test]
    fn wrong_kind_restore_attempt_conversion_releases_without_quarantine() {
        let coordinator = OperationCoordinator::new();
        let command = coordinator.try_acquire(OperationKind::Command).unwrap();
        assert!(command.into_restore_attempt().is_err());
        coordinator.try_acquire(OperationKind::Restore).unwrap();
        coordinator.try_acquire(OperationKind::Command).unwrap();
    }

    #[test]
    fn commands_coexist_with_commands_and_normal_operations() {
        for kind in [
            OperationKind::Capture,
            OperationKind::PostProcess,
            OperationKind::Backup,
            OperationKind::VaultMigration,
            OperationKind::VaultLock,
            OperationKind::RuntimeAudio,
            OperationKind::ModelRelease,
            OperationKind::StorageMaintenance,
        ] {
            let coordinator = OperationCoordinator::new();
            let _first = coordinator.try_acquire(OperationKind::Command).unwrap();
            let _second = coordinator.try_acquire(OperationKind::Command).unwrap();
            let _nested = coordinator.try_acquire(kind).unwrap();
            let _third = coordinator.try_acquire(OperationKind::Command).unwrap();
        }
    }

    #[test]
    fn command_and_restore_exclude_each_other_until_lease_drop() {
        let coordinator = OperationCoordinator::new();
        let first = coordinator.try_acquire(OperationKind::Command).unwrap();
        let second = coordinator.try_acquire(OperationKind::Command).unwrap();
        assert!(coordinator.try_acquire(OperationKind::Restore).is_err());
        drop(first);
        assert!(coordinator.try_acquire(OperationKind::Restore).is_err());
        drop(second);
        let restore = coordinator.try_acquire(OperationKind::Restore).unwrap();
        assert!(coordinator.try_acquire(OperationKind::Command).is_err());
        drop(restore);
        coordinator.try_acquire(OperationKind::Command).unwrap();
    }

    #[test]
    fn restore_failure_quarantine_survives_restore_lease_drop() {
        let coordinator = OperationCoordinator::new();
        let restore = coordinator.try_acquire(OperationKind::Restore).unwrap();
        coordinator.quarantine_after_restore_failure("Recovery copy: /fixture/recovery".into());
        coordinator.quarantine_after_restore_failure("Later failure".into());
        drop(restore);
        for kind in [
            OperationKind::Command,
            OperationKind::Capture,
            OperationKind::PostProcess,
            OperationKind::Backup,
            OperationKind::Restore,
            OperationKind::VaultMigration,
            OperationKind::VaultLock,
            OperationKind::RuntimeAudio,
            OperationKind::ModelRelease,
            OperationKind::StorageMaintenance,
        ] {
            let error = coordinator
                .try_acquire(kind)
                .err()
                .expect("quarantine blocks every operation");
            assert!(error.contains("recovery is required"));
            assert!(error.contains("/fixture/recovery"));
            assert!(!error.contains("Later failure"));
        }
    }

    #[tokio::test]
    async fn restore_failure_quarantine_notifies_waiters() {
        let coordinator = OperationCoordinator::new();
        let changes = coordinator.changes();
        let changed = changes.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        coordinator.quarantine_after_restore_failure("Recovery required".into());
        tokio::time::timeout(Duration::from_millis(100), changed)
            .await
            .expect("quarantine must notify waiters");
    }

    #[test]
    fn restore_fails_closed_during_capture_or_post_process() {
        let coordinator = OperationCoordinator::new();
        let capture = coordinator
            .try_acquire(OperationKind::Capture)
            .expect("capture lease");
        let error = coordinator
            .try_acquire(OperationKind::Restore)
            .err()
            .expect("restore must be blocked");
        assert!(error.contains("meeting capture"));
        drop(capture);

        let post_process = coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("post-process lease");
        let error = coordinator
            .try_acquire(OperationKind::Restore)
            .err()
            .expect("restore must be blocked");
        assert!(error.contains("meeting post-processing"));
        drop(post_process);

        coordinator
            .try_acquire(OperationKind::Restore)
            .expect("idle restore must be allowed");
    }

    #[test]
    fn concurrent_vault_migration_is_rejected() {
        let coordinator = OperationCoordinator::new();
        let migration = coordinator
            .try_acquire(OperationKind::VaultMigration)
            .expect("first migration lease");
        let error = coordinator
            .try_acquire(OperationKind::VaultMigration)
            .err()
            .expect("second migration must be blocked");
        assert!(error.contains("vault migration"));
        drop(migration);
    }

    #[tokio::test]
    async fn vault_lock_revokes_decrypted_runtime_audio() {
        let coordinator = OperationCoordinator::new();
        let mut playback = coordinator
            .try_acquire(OperationKind::RuntimeAudio)
            .expect("runtime audio lease");
        let lock = coordinator
            .try_acquire(OperationKind::VaultLock)
            .expect("vault lock preempts runtime audio");

        tokio::time::timeout(Duration::from_millis(100), playback.cancelled())
            .await
            .expect("runtime audio lease must be cancelled");
        drop(playback);
        drop(lock);
    }

    #[test]
    fn storage_maintenance_and_capture_exclude_each_other() {
        let coordinator = OperationCoordinator::new();
        let capture = coordinator
            .try_acquire(OperationKind::Capture)
            .expect("capture lease");
        // The regression this exists for: a retention or transcript-only sweep
        // starting mid-meeting takes the audio storage gate for as long as the
        // sweep runs, and stopping that meeting then waited behind it with the
        // microphone still live.
        let error = coordinator
            .try_acquire(OperationKind::StorageMaintenance)
            .err()
            .expect("storage maintenance must not start during a capture");
        assert!(error.contains("meeting capture"));
        drop(capture);

        let maintenance = coordinator
            .try_acquire(OperationKind::StorageMaintenance)
            .expect("idle storage maintenance must be allowed");
        let error = coordinator
            .try_acquire(OperationKind::Capture)
            .err()
            .expect("a capture must not start on top of a running sweep");
        assert!(error.contains("recording storage maintenance"));
        assert!(
            coordinator
                .try_acquire(OperationKind::StorageMaintenance)
                .is_err(),
            "two concurrent sweeps would fight over the same audio storage gate"
        );
        drop(maintenance);
    }

    #[test]
    fn storage_maintenance_can_run_inside_meeting_post_processing() {
        // The transcript-only sweep is invoked by the post-processing pipeline
        // itself, so excluding these two would make that pipeline unable to run
        // its own storage policy.
        let coordinator = OperationCoordinator::new();
        let post_process = coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("post-process lease");
        let maintenance = coordinator
            .try_acquire(OperationKind::StorageMaintenance)
            .expect("post-processing must be able to run its own cleanup");
        coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("a sweep must not block another meeting's post-processing");
        drop(maintenance);
        drop(post_process);
    }

    #[test]
    fn capture_and_existing_post_process_can_coexist() {
        let coordinator = OperationCoordinator::new();
        let _post_process = coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("post-process lease");
        coordinator
            .try_acquire(OperationKind::Capture)
            .expect("a previous meeting should not block a new capture");
    }

    #[test]
    fn model_release_and_capture_exclude_each_other() {
        let coordinator = OperationCoordinator::new();
        let capture = coordinator
            .try_acquire(OperationKind::Capture)
            .expect("capture lease");
        let error = coordinator
            .try_acquire(OperationKind::ModelRelease)
            .err()
            .expect("model release must not start during capture");
        assert!(error.contains("meeting capture"));
        drop(capture);

        let release = coordinator
            .try_acquire(OperationKind::ModelRelease)
            .expect("idle model release must be allowed");
        let error = coordinator
            .try_acquire(OperationKind::Capture)
            .err()
            .expect("capture must not start during model release");
        assert!(error.contains("native speech model release"));
        drop(release);
    }

    #[test]
    fn model_release_and_post_process_exclude_each_other() {
        let coordinator = OperationCoordinator::new();
        let post_process = coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("post-process lease");
        let error = coordinator
            .try_acquire(OperationKind::ModelRelease)
            .err()
            .expect("model release must not start during post-processing");
        assert!(error.contains("meeting post-processing"));
        drop(post_process);

        let release = coordinator
            .try_acquire(OperationKind::ModelRelease)
            .expect("idle model release must be allowed");
        let error = coordinator
            .try_acquire(OperationKind::PostProcess)
            .err()
            .expect("post-processing must not start during model release");
        assert!(error.contains("native speech model release"));
        drop(release);
    }

    #[tokio::test]
    async fn lease_release_notifies_waiters() {
        let coordinator = OperationCoordinator::new();
        let release = coordinator
            .try_acquire(OperationKind::ModelRelease)
            .expect("model release lease");
        let changes = coordinator.changes();
        let changed = changes.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();

        drop(release);

        tokio::time::timeout(Duration::from_millis(100), changed)
            .await
            .expect("lease release must notify waiters");
    }

    #[test]
    fn model_release_preserves_unrelated_operation_behavior() {
        let unrelated = [
            OperationKind::Backup,
            OperationKind::Restore,
            OperationKind::VaultMigration,
            OperationKind::VaultLock,
            OperationKind::RuntimeAudio,
            OperationKind::StorageMaintenance,
        ];

        for kind in unrelated {
            let coordinator = OperationCoordinator::new();
            let operation = coordinator
                .try_acquire(kind)
                .expect("unrelated operation lease");
            let release = coordinator
                .try_acquire(OperationKind::ModelRelease)
                .expect("unrelated operation must not block model release");
            drop(release);
            drop(operation);

            let release = coordinator
                .try_acquire(OperationKind::ModelRelease)
                .expect("model release lease");
            coordinator
                .try_acquire(kind)
                .expect("model release must not block unrelated operation");
            drop(release);
        }
    }
}

#[cfg(test)]
mod note_publishing_tests {
    use super::*;
    #[test]
    fn publishing_protects_library_replacement_without_blocking_capture() {
        let coordinator = OperationCoordinator::new();
        let publish = coordinator.try_acquire(OperationKind::NotePublish).unwrap();
        assert!(coordinator.try_acquire(OperationKind::Restore).is_err());
        assert!(coordinator
            .try_acquire(OperationKind::VaultMigration)
            .is_err());
        assert!(coordinator.try_acquire(OperationKind::VaultLock).is_err());
        let capture = coordinator.try_acquire(OperationKind::Capture).unwrap();
        drop(capture);
        drop(publish);
        let restore = coordinator.try_acquire(OperationKind::Restore).unwrap();
        assert!(coordinator.try_acquire(OperationKind::NotePublish).is_err());
        drop(restore);
    }
}

#[cfg(test)]
mod responsiveness_pressure_tests {
    use super::*;
    use crate::memory_pressure::MemoryPressure;

    #[test]
    fn memory_pressure_defers_new_batches_and_recovery_reopens_them() {
        let coordinator = OperationCoordinator::new();
        for pressure in [MemoryPressure::Warning, MemoryPressure::Critical] {
            assert!(coordinator
                .try_acquire_with_pressure(OperationKind::SemanticIndex, pressure)
                .is_err());
            assert!(coordinator
                .try_acquire_with_pressure(OperationKind::PostProcess, pressure)
                .is_ok());
            assert!(coordinator
                .try_acquire_with_pressure(OperationKind::Capture, pressure)
                .is_ok());
        }
        assert!(coordinator
            .try_acquire_with_pressure(OperationKind::SemanticIndex, MemoryPressure::Normal)
            .is_ok());
    }
}
