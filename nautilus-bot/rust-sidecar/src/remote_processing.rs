//! Central revocation gate for every remote provider request.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::watch;

#[derive(Debug)]
pub struct RemoteProcessingGate {
    allowed: AtomicBool,
    generation: AtomicU64,
    generation_tx: watch::Sender<u64>,
}

impl RemoteProcessingGate {
    pub fn new(allowed: bool) -> Self {
        let (generation_tx, _) = watch::channel(0);
        Self {
            allowed: AtomicBool::new(allowed),
            generation: AtomicU64::new(0),
            generation_tx,
        }
    }

    pub fn is_allowed(&self) -> bool {
        self.allowed.load(Ordering::SeqCst)
    }

    pub fn set_allowed(&self, allowed: bool) {
        let previous = self.allowed.swap(allowed, Ordering::SeqCst);
        if previous != allowed {
            let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            self.generation_tx.send_replace(generation);
        }
    }

    pub fn grant(&self) -> Result<RemoteProcessingGrant<'_>, String> {
        if !self.is_allowed() {
            return Err("Remote processing is disabled".to_string());
        }
        Ok(RemoteProcessingGrant {
            generation: self.generation.load(Ordering::SeqCst),
            allowed: &self.allowed,
            current_generation: &self.generation,
            generation_rx: self.generation_tx.subscribe(),
        })
    }
}

pub struct RemoteProcessingGrant<'a> {
    generation: u64,
    allowed: &'a AtomicBool,
    current_generation: &'a AtomicU64,
    generation_rx: watch::Receiver<u64>,
}

impl RemoteProcessingGrant<'_> {
    pub fn check(&self) -> Result<(), String> {
        if !self.allowed.load(Ordering::SeqCst)
            || self.current_generation.load(Ordering::SeqCst) != self.generation
        {
            return Err("Remote processing was revoked while the request was active".to_string());
        }
        Ok(())
    }

    pub async fn cancelled(&mut self) {
        while self.check().is_ok() {
            if self.generation_rx.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remote_processing_revoke_cancels_old_generation_even_after_reenable() {
        let gate = RemoteProcessingGate::new(true);
        let mut old_grant = gate.grant().expect("initial grant");
        gate.set_allowed(false);
        gate.set_allowed(true);

        old_grant.cancelled().await;
        assert!(old_grant.check().is_err());
        assert!(gate.grant().expect("new generation grant").check().is_ok());
    }

    #[test]
    fn remote_processing_disabled_rejects_new_grants() {
        let gate = RemoteProcessingGate::new(false);
        assert!(gate.grant().is_err());
    }
}
