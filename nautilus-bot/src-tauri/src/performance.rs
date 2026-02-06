//! Performance optimization utilities
//!
//! Provides memory management, startup optimization, and caching
//! for improved application performance.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Memory-efficient cache with LRU eviction
pub struct LruCache<K, V> {
    capacity: usize,
    items: HashMap<K, (V, Instant)>,
    access_order: Vec<K>,
}

impl<K: Clone + std::hash::Hash + Eq, V: Clone> LruCache<K, V> {
    /// Create new cache with capacity
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            items: HashMap::with_capacity(capacity),
            access_order: Vec::with_capacity(capacity),
        }
    }

    /// Get item from cache
    pub fn get(&mut self, key: &K) -> Option<V> {
        if let Some((value, _)) = self.items.get(key) {
            // Update access order
            if let Some(pos) = self.access_order.iter().position(|k| k == key) {
                let k = self.access_order.remove(pos);
                self.access_order.push(k);
            }
            Some(value.clone())
        } else {
            None
        }
    }

    /// Insert item into cache
    pub fn put(&mut self, key: K, value: V) {
        // Remove oldest if at capacity
        if self.items.len() >= self.capacity && !self.items.contains_key(&key) {
            if let Some(oldest) = self.access_order.first() {
                let oldest = oldest.clone();
                self.items.remove(&oldest);
                self.access_order.remove(0);
            }
        }

        // Insert new item
        self.items.insert(key.clone(), (value, Instant::now()));

        // Update access order
        if let Some(pos) = self.access_order.iter().position(|k| k == &key) {
            self.access_order.remove(pos);
        }
        self.access_order.push(key);
    }

    /// Clear cache
    pub fn clear(&mut self) {
        self.items.clear();
        self.access_order.clear();
    }

    /// Get cache size
    pub fn len(&self) -> usize {
        self.items.len()
    }
}

/// Thread-safe cache wrapper
pub struct ThreadSafeCache<K, V> {
    inner: Arc<Mutex<LruCache<K, V>>>,
}

impl<K: Clone + std::hash::Hash + Eq + Send + 'static, V: Clone + Send + 'static>
    ThreadSafeCache<K, V>
{
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LruCache::new(capacity))),
        }
    }

    pub fn get(&self, key: &K) -> Option<V> {
        self.inner.lock().ok()?.get(key)
    }

    pub fn put(&self, key: K, value: V) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.put(key, value);
        }
    }
}

/// Memory pool for audio buffers
pub struct AudioBufferPool {
    pool: Vec<Vec<f32>>,
    buffer_size: usize,
    max_pool_size: usize,
}

impl AudioBufferPool {
    /// Create buffer pool
    pub fn new(buffer_size: usize, max_pool_size: usize) -> Self {
        Self {
            pool: Vec::with_capacity(max_pool_size),
            buffer_size,
            max_pool_size,
        }
    }

    /// Acquire buffer from pool
    pub fn acquire(&mut self) -> Vec<f32> {
        self.pool
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(self.buffer_size))
    }

    /// Return buffer to pool
    pub fn release(&mut self, mut buffer: Vec<f32>) {
        if self.pool.len() < self.max_pool_size {
            buffer.clear();
            self.pool.push(buffer);
        }
        // Otherwise, drop the buffer
    }
}

/// Startup optimizer - lazy initialization
pub struct LazyInitializer<T> {
    factory: Box<dyn Fn() -> T + Send + Sync>,
    instance: Mutex<Option<T>>,
}

impl<T: Clone> LazyInitializer<T> {
    /// Create lazy initializer
    pub fn new<F>(factory: F) -> Self
    where
        F: Fn() -> T + Send + Sync + 'static,
    {
        Self {
            factory: Box::new(factory),
            instance: Mutex::new(None),
        }
    }

    /// Get or create instance
    pub fn get(&self) -> T {
        let mut instance = self.instance.lock().unwrap();

        if instance.is_none() {
            *instance = Some((self.factory)());
        }

        instance.as_ref().unwrap().clone()
    }
}

/// Batch processor for efficient bulk operations
pub struct BatchProcessor<T> {
    items: Vec<T>,
    batch_size: usize,
    timeout: Duration,
    last_flush: Instant,
}

impl<T> BatchProcessor<T> {
    /// Create batch processor
    pub fn new(batch_size: usize, timeout: Duration) -> Self {
        Self {
            items: Vec::with_capacity(batch_size),
            batch_size,
            timeout,
            last_flush: Instant::now(),
        }
    }

    /// Add item to batch
    pub fn add(&mut self, item: T) -> Option<Vec<T>> {
        self.items.push(item);

        if self.items.len() >= self.batch_size {
            return self.flush();
        }

        None
    }

    /// Check if timeout exceeded and flush if needed
    pub fn check_timeout(&mut self) -> Option<Vec<T>> {
        if self.last_flush.elapsed() >= self.timeout && !self.items.is_empty() {
            self.flush()
        } else {
            None
        }
    }

    /// Force flush batch
    pub fn flush(&mut self) -> Option<Vec<T>> {
        if self.items.is_empty() {
            return None;
        }

        let batch = std::mem::take(&mut self.items);
        self.items.reserve(self.batch_size);
        self.last_flush = Instant::now();

        Some(batch)
    }
}

/// Performance metrics
#[derive(Debug, Default)]
pub struct PerformanceMetrics {
    /// Startup time in milliseconds
    pub startup_time_ms: u64,
    /// Memory usage in bytes
    pub memory_usage_bytes: usize,
    /// Number of active recordings
    pub active_recordings: usize,
    /// Cache hit rate
    pub cache_hit_rate: f64,
}

impl PerformanceMetrics {
    /// Collect current metrics
    pub fn collect() -> Self {
        Self {
            startup_time_ms: 0,    // Would measure actual startup
            memory_usage_bytes: 0, // Would get actual memory
            active_recordings: 0,
            cache_hit_rate: 0.0,
        }
    }
}

/// Optimize audio buffer processing
pub fn optimize_audio_buffer(buffer: &mut [f32]) {
    #[cfg(not(target_arch = "x86_64"))]
    let _ = buffer;

    // Pre-fetch hint for sequential access
    #[cfg(target_arch = "x86_64")]
    unsafe {
        for i in (0..buffer.len()).step_by(64) {
            std::arch::x86_64::_mm_prefetch(
                buffer.as_ptr().add(i) as *const i8,
                std::arch::x86_64::_MM_HINT_T0,
            );
        }
    }
}

/// Fast in-place normalization
pub fn fast_normalize(samples: &mut [f32]) {
    // Find max using iterator
    let max_peak = samples.iter().fold(0.0f32, |max, &s| max.max(s.abs()));

    if max_peak > 0.0 {
        let gain = 0.89 / max_peak;

        // Use chunks for better cache utilization
        for chunk in samples.chunks_mut(64) {
            for sample in chunk.iter_mut() {
                *sample *= gain;
            }
        }
    }
}

/// Memory-efficient transcript storage
pub struct TranscriptCompressor;

impl TranscriptCompressor {
    /// Compress transcript text (simple RLE for repeated words)
    pub fn compress(text: &str) -> Vec<u8> {
        // Simple compression - in production would use proper algorithm
        text.as_bytes().to_vec()
    }

    /// Decompress transcript
    pub fn decompress(data: &[u8]) -> String {
        String::from_utf8_lossy(data).to_string()
    }
}
