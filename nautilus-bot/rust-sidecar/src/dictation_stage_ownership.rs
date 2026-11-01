use std::future::Future;
use std::time::Duration;

use tokio::time::{Instant, MissedTickBehavior};

const OWNERSHIP_CHECK_INTERVAL: Duration = Duration::from_millis(25);

/// Run a dictation stage only while its session retains ownership.
///
/// Ownership is checked before the work is first polled, periodically while it
/// is pending, and once more before a completed result is released.
pub(crate) async fn run_while_session_owned<Work, Check, CheckFuture, T>(
    work: Work,
    mut check_owned: Check,
) -> Option<T>
where
    Work: Future<Output = T>,
    Check: FnMut() -> CheckFuture,
    CheckFuture: Future<Output = bool>,
{
    if !check_owned().await {
        return None;
    }

    tokio::pin!(work);

    let first_check = Instant::now() + OWNERSHIP_CHECK_INTERVAL;
    let mut ownership_checks = tokio::time::interval_at(first_check, OWNERSHIP_CHECK_INTERVAL);
    ownership_checks.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            result = &mut work => {
                return check_owned().await.then_some(result);
            }
            _ = ownership_checks.tick() => {
                if !check_owned().await {
                    return None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll};

    struct PollCounterFuture {
        polls: Arc<AtomicUsize>,
    }

    impl Future for PollCounterFuture {
        type Output = ();

        fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            self.polls.fetch_add(1, Ordering::SeqCst);
            Poll::Pending
        }
    }

    struct DropGuardFuture {
        dropped: Arc<AtomicBool>,
    }

    impl Future for DropGuardFuture {
        type Output = ();

        fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }

    impl Drop for DropGuardFuture {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct ReplaceOwnerOnCompletion {
        generation: Arc<AtomicU64>,
    }

    impl Future for ReplaceOwnerOnCompletion {
        type Output = &'static str;

        fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            self.generation.store(2, Ordering::SeqCst);
            Poll::Ready("stale result")
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pre_cancelled_work_is_never_polled() {
        let polls = Arc::new(AtomicUsize::new(0));
        let result = run_while_session_owned(
            PollCounterFuture {
                polls: Arc::clone(&polls),
            },
            || async { false },
        )
        .await;

        assert_eq!(result, None);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn losing_ownership_drops_pending_work() {
        let dropped = Arc::new(AtomicBool::new(false));
        let checks = AtomicUsize::new(0);

        let result = run_while_session_owned(
            DropGuardFuture {
                dropped: Arc::clone(&dropped),
            },
            || {
                let check = checks.fetch_add(1, Ordering::SeqCst);
                async move { check == 0 }
            },
        )
        .await;

        assert_eq!(result, None);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(checks.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn current_owner_receives_successful_result() {
        let checks = AtomicUsize::new(0);

        let result = run_while_session_owned(async { "current result" }, || {
            checks.fetch_add(1, Ordering::SeqCst);
            async { true }
        })
        .await;

        assert_eq!(result, Some("current result"));
        assert_eq!(checks.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn replaced_owner_suppresses_completed_result() {
        let generation = Arc::new(AtomicU64::new(1));
        let expected_generation = 1;

        let result = run_while_session_owned(
            ReplaceOwnerOnCompletion {
                generation: Arc::clone(&generation),
            },
            || {
                let generation = Arc::clone(&generation);
                async move { generation.load(Ordering::SeqCst) == expected_generation }
            },
        )
        .await;

        assert_eq!(result, None);
        assert_eq!(generation.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn disowned_stage_suppresses_completed_result() {
        let owned = Arc::new(AtomicBool::new(true));
        let work_owned = Arc::clone(&owned);

        let result = run_while_session_owned(
            async move {
                work_owned.store(false, Ordering::SeqCst);
                "stale result"
            },
            || {
                let owned = Arc::clone(&owned);
                async move { owned.load(Ordering::SeqCst) }
            },
        )
        .await;

        assert_eq!(result, None);
    }
}
