//! Preallocated handoff from an audio callback to its capture worker.

use crossbeam::queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) struct RealtimeSamples {
    samples: ArrayQueue<f32>,
    dropped: AtomicU64,
}

impl RealtimeSamples {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            samples: ArrayQueue::new(capacity.max(1)),
            dropped: AtomicU64::new(0),
        }
    }

    /// Keep the accepted prefix in order. A full queue drops incoming frames,
    /// never waits for a consumer, allocates, or overwrites retained audio.
    pub(super) fn push<T>(&self, data: &[T], channels: usize) -> u64
    where
        T: cpal::Sample,
        f32: cpal::FromSample<T>,
    {
        let mut dropped = 0;
        super::for_each_mono_sample(data, channels, |sample| {
            if self.samples.push(sample).is_err() {
                dropped += 1;
            }
        });
        if dropped > 0 {
            self.dropped.fetch_add(dropped, Ordering::Relaxed);
        }
        dropped
    }

    /// Bound each drain even if a producer keeps filling the queue.
    pub(super) fn drain(&self, output: &mut Vec<f32>) {
        output.clear();
        let count = self.samples.len();
        for _ in 0..count {
            if let Some(sample) = self.samples.pop() {
                output.push(sample);
            }
        }
    }

    pub(super) fn take_dropped(&self) -> u64 {
        self.dropped.swap(0, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_keeps_the_prefix_counts_every_frame_and_recovers() {
        let queue = RealtimeSamples::new(3);
        queue.push(&[1.0_f32, 2.0, 3.0, 4.0, 5.0], 1);
        assert_eq!(queue.take_dropped(), 2);
        assert_eq!(queue.take_dropped(), 0);
        let mut output = Vec::new();
        queue.drain(&mut output);
        assert_eq!(output, [1.0, 2.0, 3.0]);
        queue.push(&[6.0_f32], 1);
        queue.drain(&mut output);
        assert_eq!(output, [6.0]);
    }

    #[test]
    fn backpressure_is_bounded_and_counts_mono_frames() {
        let queue = RealtimeSamples::new(2);
        for _ in 0..1_000 {
            queue.push(&[0.25_f32, 0.75, -0.25, -0.75], 2);
        }
        assert_eq!(queue.take_dropped(), 1_998);
        let mut output = Vec::new();
        queue.drain(&mut output);
        assert_eq!(output, [0.5, -0.5]);
    }
}
