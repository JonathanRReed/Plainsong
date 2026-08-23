use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationKind {
    Capture,
    PostProcess,
    Backup,
    Restore,
    VaultMigration,
    VaultLock,
    RuntimeAudio,
}

impl OperationKind {
    fn label(self) -> &'static str {
        match self {
            Self::Capture => "meeting capture",
            Self::PostProcess => "meeting post-processing",
            Self::Backup => "backup",
            Self::Restore => "restore",
            Self::VaultMigration => "vault migration",
            Self::VaultLock => "vault lock",
            Self::RuntimeAudio => "decrypted audio playback",
        }
    }
}

#[derive(Default)]
struct CoordinatorState {
    capture: usize,
    post_process: usize,
    backup: usize,
    restore: usize,
    vault_migration: usize,
    vault_lock: usize,
    runtime_audio: usize,
}

impl CoordinatorState {
    fn count(&self, kind: OperationKind) -> usize {
        match kind {
            OperationKind::Capture => self.capture,
            OperationKind::PostProcess => self.post_process,
            OperationKind::Backup => self.backup,
            OperationKind::Restore => self.restore,
            OperationKind::VaultMigration => self.vault_migration,
            OperationKind::VaultLock => self.vault_lock,
            OperationKind::RuntimeAudio => self.runtime_audio,
        }
    }

    fn increment(&mut self, kind: OperationKind) {
        match kind {
            OperationKind::Capture => self.capture += 1,
            OperationKind::PostProcess => self.post_process += 1,
            OperationKind::Backup => self.backup += 1,
            OperationKind::Restore => self.restore += 1,
            OperationKind::VaultMigration => self.vault_migration += 1,
            OperationKind::VaultLock => self.vault_lock += 1,
            OperationKind::RuntimeAudio => self.runtime_audio += 1,
        }
    }

    fn decrement(&mut self, kind: OperationKind) {
        let count = match kind {
            OperationKind::Capture => &mut self.capture,
            OperationKind::PostProcess => &mut self.post_process,
            OperationKind::Backup => &mut self.backup,
            OperationKind::Restore => &mut self.restore,
            OperationKind::VaultMigration => &mut self.vault_migration,
            OperationKind::VaultLock => &mut self.vault_lock,
            OperationKind::RuntimeAudio => &mut self.runtime_audio,
        };
        *count = count.saturating_sub(1);
    }
}

pub(crate) struct OperationCoordinator {
    state: Mutex<CoordinatorState>,
    runtime_audio_generation: watch::Sender<u64>,
}

impl OperationCoordinator {
    pub(crate) fn new() -> Arc<Self> {
        let (runtime_audio_generation, _) = watch::channel(0);
        Arc::new(Self {
            state: Mutex::new(CoordinatorState::default()),
            runtime_audio_generation,
        })
    }

    pub(crate) fn try_acquire(
        self: &Arc<Self>,
        kind: OperationKind,
    ) -> Result<OperationLease, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
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
        state.increment(kind);
        drop(state);

        Ok(OperationLease {
            coordinator: Arc::clone(self),
            kind,
            runtime_audio_generation,
        })
    }

    fn blockers(state: &CoordinatorState, requested: OperationKind) -> Vec<&'static str> {
        let candidates: &[OperationKind] = match requested {
            OperationKind::Capture => &[
                OperationKind::Capture,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::PostProcess => &[
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::Backup => &[
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::Restore => &[
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::RuntimeAudio,
            ],
            OperationKind::VaultMigration => &[
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
                OperationKind::RuntimeAudio,
            ],
            // Runtime audio is revoked by vault lock instead of blocking it.
            OperationKind::VaultLock => &[
                OperationKind::Capture,
                OperationKind::PostProcess,
                OperationKind::Backup,
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
            OperationKind::RuntimeAudio => &[
                OperationKind::Restore,
                OperationKind::VaultMigration,
                OperationKind::VaultLock,
            ],
        };

        candidates
            .iter()
            .copied()
            .filter(|kind| state.count(*kind) > 0)
            .map(OperationKind::label)
            .collect()
    }
}

pub(crate) struct OperationLease {
    coordinator: Arc<OperationCoordinator>,
    kind: OperationKind,
    runtime_audio_generation: Option<watch::Receiver<u64>>,
}

impl OperationLease {
    pub(crate) async fn cancelled(&mut self) {
        let Some(generation) = self.runtime_audio_generation.as_mut() else {
            std::future::pending::<()>().await;
            return;
        };
        let _ = generation.changed().await;
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        self.coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .decrement(self.kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
    fn capture_and_existing_post_process_can_coexist() {
        let coordinator = OperationCoordinator::new();
        let _post_process = coordinator
            .try_acquire(OperationKind::PostProcess)
            .expect("post-process lease");
        coordinator
            .try_acquire(OperationKind::Capture)
            .expect("a previous meeting should not block a new capture");
    }
}
