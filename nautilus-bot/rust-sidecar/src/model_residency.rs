//! One pressure subscriber for idle native models. Teardown runs outside the
//! publisher and registry locks, largest reservation first. Each owner checks
//! its request lock and keeps that lock until teardown finishes.

use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{watch, Notify};

use crate::hardware_tier::{self, HardwareTier};
use crate::memory_pressure::MemoryPressure;

const INTERVAL: Duration = Duration::from_secs(2);
static CHANGED: Notify = Notify::const_new();

#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub pressure: MemoryPressure,
    pub tier: HardwareTier,
}

impl Policy {
    pub fn release_idle(self) -> bool {
        self.pressure == MemoryPressure::Critical
            || (self.tier == HardwareTier::Light && self.pressure == MemoryPressure::Warning)
    }
}

pub(crate) struct IdleModel {
    bytes: std::sync::atomic::AtomicU64,
    release: Box<dyn Fn(Policy) + Send + Sync>,
}

impl IdleModel {
    pub(crate) fn set_bytes(&self, bytes: u64) {
        self.bytes
            .store(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    pub(crate) fn check(&self, policy: Policy) {
        (self.release)(policy);
    }
}

#[derive(Default)]
struct Registry(Mutex<Vec<Weak<IdleModel>>>);

impl Registry {
    fn register(
        &self,
        bytes: u64,
        release: impl Fn(Policy) + Send + Sync + 'static,
    ) -> Arc<IdleModel> {
        let entry = Arc::new(IdleModel {
            bytes: std::sync::atomic::AtomicU64::new(bytes),
            release: Box::new(release),
        });
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::downgrade(&entry));
        entry
    }

    fn release(&self, policy: Policy) {
        let mut entries = {
            let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let entries: Vec<_> = slots.iter().filter_map(Weak::upgrade).collect();
            slots.retain(|slot| slot.strong_count() > 0);
            entries
        };
        entries.sort_by_cached_key(|entry| {
            std::cmp::Reverse(entry.bytes.load(std::sync::atomic::Ordering::Relaxed))
        });
        for entry in entries {
            entry.check(policy);
        }
    }
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

pub(crate) fn wake() {
    CHANGED.notify_one();
}

/// Keep this registration with the owner. The reaper never extends a job's
/// lifetime. `bytes` is its reservation or conservative size estimate, used
/// only for ordering, never for admission.
pub(crate) fn register(
    bytes: u64,
    release: impl Fn(Policy) + Send + Sync + 'static,
) -> Arc<IdleModel> {
    let entry = registry().register(bytes, release);
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        if !crate::memory_pressure::start_monitor() && cfg!(target_os = "macos") {
            tracing::warn!("Idle models could not start memory-pressure monitoring");
        }
        if let Err(error) = std::thread::Builder::new()
            .name("model-idle-release".into())
            .spawn(|| {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                {
                    Ok(runtime) => runtime.block_on(release_loop(
                        crate::memory_pressure::events().subscribe(),
                        &CHANGED,
                        |pressure| {
                            registry().release(Policy {
                                pressure,
                                tier: hardware_tier::current(),
                            })
                        },
                    )),
                    Err(error) => tracing::warn!("Could not start model idle checks: {error}"),
                }
            })
        {
            tracing::warn!("Could not start model idle release: {error}");
        }
    });
    wake();
    entry
}

/// A static cache owns one registration. Its mutex covers construction and
/// inference as well as destruction, so admission and lazy reload stay in the
/// existing request path.
#[cfg(any(
    feature = "local-embeddings",
    feature = "asr-parakeet",
    feature = "asr-canary",
    feature = "asr-transcribe-cpp"
))]
pub(crate) fn watch_cache<T: Send + 'static>(
    registration: &'static OnceLock<Arc<IdleModel>>,
    bytes: u64,
    cache: &'static Mutex<Option<T>>,
) {
    registration.get_or_init(|| {
        register(bytes, move |policy| {
            if policy.release_idle() {
                release_cache(cache);
            }
        })
    });
}

#[cfg(any(
    feature = "local-embeddings",
    feature = "asr-parakeet",
    feature = "asr-canary",
    feature = "asr-transcribe-cpp",
    test
))]
pub(crate) fn release_cache<T>(cache: &Mutex<Option<T>>) -> bool {
    let mut slot = match cache.try_lock() {
        Ok(slot) => slot,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    let model = slot.take();
    let released = model.is_some();
    // An owned value in the tail expression can outlive the mutex guard.
    // Finish teardown explicitly before a request can take the cold slot.
    drop(model);
    released
}

#[cfg(any(all(target_os = "macos", feature = "local-embeddings"), test))]
pub(crate) fn watch_owned_cache<T: Send + 'static>(
    bytes: u64,
    cache: &Arc<Mutex<Option<T>>>,
) -> Arc<IdleModel> {
    let cache = Arc::downgrade(cache);
    register(bytes, move |policy| {
        if policy.release_idle() {
            if let Some(cache) = cache.upgrade() {
                release_cache(&cache);
            }
        }
    })
}

#[cfg(feature = "asr-whisper")]
pub(crate) fn release_shared_cache<K: Eq + std::hash::Hash, T>(
    cache: &Mutex<std::collections::HashMap<K, Arc<T>>>,
) {
    let mut slot = match cache.try_lock() {
        Ok(slot) => slot,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    // Cloning for a request and dropping the final cached reference both
    // happen under this lock. Active request references keep their model.
    slot.retain(|_, model| Arc::strong_count(model) > 1);
}

async fn release_loop(
    mut pressure: watch::Receiver<MemoryPressure>,
    changed: &Notify,
    mut release: impl FnMut(MemoryPressure),
) {
    let mut ticks = tokio::time::interval(INTERVAL);
    loop {
        // Drop the watch borrow before touching a model.
        let current = *pressure.borrow_and_update();
        release(current);
        tokio::select! {
            _ = ticks.tick() => {},
            event = pressure.changed() => { if event.is_err() { return; } },
            _ = changed.notified() => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warning_releases_light_and_critical_releases_every_tier() {
        for tier in [
            HardwareTier::Light,
            HardwareTier::Balanced,
            HardwareTier::Best,
        ] {
            for pressure in [
                MemoryPressure::Normal,
                MemoryPressure::Warning,
                MemoryPressure::Critical,
            ] {
                assert_eq!(
                    Policy { tier, pressure }.release_idle(),
                    pressure == MemoryPressure::Critical
                        || (tier == HardwareTier::Light && pressure == MemoryPressure::Warning)
                );
            }
        }
    }

    #[test]
    fn owned_search_slot_releases_reloads_and_does_not_keep_the_job_alive() {
        let slot = Arc::new(Mutex::new(Some(1)));
        let registration = watch_owned_cache(1, &slot);
        let warning = Policy {
            tier: HardwareTier::Light,
            pressure: MemoryPressure::Warning,
        };
        {
            let request = slot.lock().unwrap();
            (registration.release)(warning);
            assert_eq!(*request, Some(1));
        }
        (registration.release)(warning);
        assert!(slot.lock().unwrap().is_none());
        // The same job, including its clones, must be able to load again.
        let clone = slot.clone();
        *clone.lock().unwrap() = Some(2);
        (registration.release)(Policy {
            tier: HardwareTier::Best,
            pressure: MemoryPressure::Warning,
        });
        assert_eq!(*slot.lock().unwrap(), Some(2));
        (registration.release)(Policy {
            tier: HardwareTier::Best,
            pressure: MemoryPressure::Critical,
        });
        assert!(slot.lock().unwrap().is_none());
        drop(clone);
        let weak = Arc::downgrade(&slot);
        drop(slot);
        assert!(weak.upgrade().is_none());
        (registration.release)(warning);
    }

    #[cfg(feature = "asr-whisper")]
    #[test]
    fn whisper_cache_keeps_active_requests_and_releases_idle_models() {
        let active = Arc::new(1);
        let cache = Mutex::new(std::collections::HashMap::from([
            ("active", active.clone()),
            ("idle", Arc::new(2)),
        ]));
        release_shared_cache(&cache);
        assert_eq!(cache.lock().unwrap().len(), 1);
        assert_eq!(*active, 1);
        drop(active);
        release_shared_cache(&cache);
        assert!(cache.lock().unwrap().is_empty());
        cache.lock().unwrap().insert("reloaded", Arc::new(3));
        assert_eq!(**cache.lock().unwrap().get("reloaded").unwrap(), 3);
    }

    #[test]
    fn abandoned_owners_leave_no_registry_entries_or_models() {
        let registry = Registry::default();
        let model = Arc::new(Mutex::new(Some(1)));
        let slot = model.clone();
        let registration = registry.register(1, move |_| {
            release_cache(&slot);
        });
        drop(registration);
        registry.release(Policy {
            tier: HardwareTier::Light,
            pressure: MemoryPressure::Critical,
        });
        assert!(registry.0.lock().unwrap().is_empty());
        assert_eq!(Arc::strong_count(&model), 1);
    }

    #[tokio::test(start_paused = true)]
    #[expect(
        clippy::await_holding_lock,
        reason = "The held lock represents a busy model while pressure is published"
    )]
    async fn fake_pressure_wakes_release_and_retries_busy_models_in_size_order() {
        let registry = Arc::new(Registry::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut registrations = Vec::new();
        let mut caches = Vec::new();
        for bytes in [1, 3, 2] {
            let cache = Arc::new(Mutex::new(Some(bytes)));
            let slot = cache.clone();
            let order = order.clone();
            registrations.push(registry.register(bytes, move |policy| {
                if policy.release_idle() && release_cache(&slot) {
                    order.lock().unwrap().push(bytes);
                }
            }));
            caches.push(cache);
        }
        let (source, pressure) = watch::channel(MemoryPressure::Normal);
        let changed = Arc::new(Notify::new());
        let signal = changed.clone();
        let task = tokio::spawn(async move {
            release_loop(pressure, &signal, |pressure| {
                registry.release(Policy {
                    tier: HardwareTier::Light,
                    pressure,
                })
            })
            .await;
        });
        tokio::task::yield_now().await;
        let busy = caches[0].lock().unwrap();
        source.send(MemoryPressure::Warning).unwrap();
        tokio::task::yield_now().await;
        assert_eq!(*order.lock().unwrap(), [3, 2]);
        assert_eq!(*busy, Some(1));
        drop(busy);
        tokio::time::advance(INTERVAL).await;
        tokio::task::yield_now().await;
        assert_eq!(*order.lock().unwrap(), [3, 2, 1]);
        source.send(MemoryPressure::Normal).unwrap();
        tokio::task::yield_now().await;
        *caches[0].lock().unwrap() = Some(1);
        changed.notify_one();
        tokio::task::yield_now().await;
        assert!(caches[0].lock().unwrap().is_some());
        source.send(MemoryPressure::Critical).unwrap();
        tokio::task::yield_now().await;
        assert!(caches[0].lock().unwrap().is_none());
        task.abort();
        let _ = task.await;
    }

    #[test]
    fn a_request_arriving_during_teardown_waits_then_reloads() {
        struct Model {
            id: u64,
            teardown: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
        }
        impl Drop for Model {
            fn drop(&mut self) {
                if let Some((entered, finish)) = &self.teardown {
                    entered.send(()).unwrap();
                    finish.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            }
        }
        let (entered, teardown) = std::sync::mpsc::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let cache = Arc::new(Mutex::new(Some(Model {
            id: 1,
            teardown: Some((entered, wait)),
        })));
        std::thread::scope(|scope| {
            let cache = &cache;
            let release = scope.spawn(move || assert!(release_cache(cache)));
            teardown.recv_timeout(Duration::from_secs(5)).unwrap();
            let teardown_holds_lock = cache.try_lock().is_err();
            let request = scope.spawn(move || {
                let mut slot = cache.lock().unwrap();
                assert!(
                    slot.is_none(),
                    "the next request must take the cold admission path"
                );
                *slot = Some(Model {
                    id: 2,
                    teardown: None,
                });
            });
            finish.send(()).unwrap();
            release.join().unwrap();
            request.join().unwrap();
            assert!(teardown_holds_lock, "teardown must retain the request lock");
        });
        assert_eq!(cache.lock().unwrap().as_ref().unwrap().id, 2);
        assert!(release_cache(&cache));
    }
}
