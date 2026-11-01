use tokio::sync::RwLock;

struct CacheState<T> {
    generation: u64,
    value: Option<Vec<T>>,
}

pub(crate) struct ProviderCache<T> {
    state: RwLock<CacheState<T>>,
}

impl<T: Clone> ProviderCache<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: RwLock::new(CacheState {
                generation: 0,
                value: None,
            }),
        }
    }

    pub(crate) async fn snapshot(&self) -> (u64, Option<Vec<T>>) {
        let state = self.state.read().await;
        (state.generation, state.value.clone())
    }

    pub(crate) async fn publish(&self, generation: u64, value: Vec<T>) -> bool {
        let mut state = self.state.write().await;
        if state.generation != generation {
            return false;
        }
        state.value = Some(value);
        true
    }

    pub(crate) async fn invalidate(&self) {
        let mut state = self.state.write().await;
        state.generation = state.generation.wrapping_add(1);
        state.value = None;
    }
}

#[cfg(test)]
mod tests {
    use super::ProviderCache;
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn late_publish_cannot_replace_a_new_generation() {
        let cache = ProviderCache::new();
        let (initial_generation, initial_value) = cache.snapshot().await;
        assert!(initial_value.is_none());
        assert!(cache.publish(initial_generation, vec![1]).await);

        let (old_generation, old_value) = cache.snapshot().await;
        assert_eq!(old_value, Some(vec![1]));

        cache.invalidate().await;
        let (new_generation, new_value) = cache.snapshot().await;
        assert!(new_value.is_none());
        assert!(cache.publish(new_generation, vec![2]).await);
        assert!(!cache.publish(old_generation, vec![3]).await);

        let (_, value) = cache.snapshot().await;
        assert_eq!(value, Some(vec![2]));
    }

    #[tokio::test]
    async fn invalidation_while_a_builder_waits_keeps_the_cache_empty() {
        let cache = Arc::new(ProviderCache::new());
        let (generation, value) = cache.snapshot().await;
        assert!(value.is_none());

        let (release_tx, release_rx) = oneshot::channel();
        let builder_cache = Arc::clone(&cache);
        let builder = tokio::spawn(async move {
            release_rx.await.expect("builder release");
            builder_cache.publish(generation, vec![1]).await
        });

        cache.invalidate().await;
        release_tx.send(()).expect("release builder");
        assert!(!builder.await.expect("builder task"));

        let (_, value) = cache.snapshot().await;
        assert!(value.is_none());
    }
}
