//! Pause accounting for a meeting recording.
//!
//! Pausing does not stop the capture streams -- the device stays open so
//! resume is instant and the mixer's alignment survives -- it drops every
//! frame on the floor instead. The audio file therefore skips the pause
//! entirely, and two things have to be reconstructed from this ledger: the
//! elapsed time shown while recording (wall-clock minus paused time) and the
//! `[Paused …]` markers the transcript timeline places at the audio offset
//! where each pause began.
//!
//! Everything here is pure so the accounting is testable without a device.

use serde::{Deserialize, Serialize};

/// One pause. `ended_at_ms` is `None` while the recording is still paused;
/// stopping closes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseSpan {
    /// Wall clock when the pause began, Unix milliseconds.
    pub started_at_ms: i64,
    /// Wall clock when capture resumed (or the meeting stopped), Unix
    /// milliseconds. `None` while paused.
    pub ended_at_ms: Option<i64>,
    /// Seconds of audio that had been recorded when the pause began -- the
    /// position in the saved file where the gap sits, since the file does not
    /// contain the pause.
    pub at_seconds: f64,
}

impl PauseSpan {
    /// Length of the span, using `now_ms` for a span that has not ended.
    pub fn duration_ms(&self, now_ms: i64) -> i64 {
        (self.ended_at_ms.unwrap_or(now_ms) - self.started_at_ms).max(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseError {
    AlreadyPaused,
    NotPaused,
}

impl std::fmt::Display for PauseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyPaused => f.write_str("The meeting is already paused"),
            Self::NotPaused => f.write_str("The meeting is not paused"),
        }
    }
}

impl std::error::Error for PauseError {}

/// The pauses of one recording, in order. At most the last span is open.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PauseLedger {
    spans: Vec<PauseSpan>,
}

impl PauseLedger {
    pub fn is_paused(&self) -> bool {
        self.spans
            .last()
            .is_some_and(|span| span.ended_at_ms.is_none())
    }

    pub fn spans(&self) -> &[PauseSpan] {
        &self.spans
    }

    /// Open a span at `now_ms`, with `at_seconds` of audio recorded so far.
    pub fn pause(&mut self, now_ms: i64, at_seconds: f64) -> Result<&PauseSpan, PauseError> {
        if self.is_paused() {
            return Err(PauseError::AlreadyPaused);
        }
        self.spans.push(PauseSpan {
            started_at_ms: now_ms,
            ended_at_ms: None,
            at_seconds: at_seconds.max(0.0),
        });
        Ok(self.spans.last().expect("span was just pushed"))
    }

    /// Close the open span at `now_ms` and return it.
    pub fn resume(&mut self, now_ms: i64) -> Result<PauseSpan, PauseError> {
        let span = self.spans.last_mut().ok_or(PauseError::NotPaused)?;
        if span.ended_at_ms.is_some() {
            return Err(PauseError::NotPaused);
        }
        span.ended_at_ms = Some(now_ms.max(span.started_at_ms));
        Ok(span.clone())
    }

    /// Close the open span if there is one -- what stopping while paused does.
    /// Returns the span it closed.
    pub fn close_open(&mut self, now_ms: i64) -> Option<PauseSpan> {
        self.resume(now_ms).ok()
    }

    /// Total paused time, counting an open span up to `now_ms`.
    pub fn paused_ms(&self, now_ms: i64) -> i64 {
        paused_total_ms(&self.spans, now_ms)
    }

    /// When the open span began, if paused.
    pub fn pause_started_at_ms(&self) -> Option<i64> {
        self.spans
            .last()
            .filter(|span| span.ended_at_ms.is_none())
            .map(|span| span.started_at_ms)
    }

    /// Paused time from spans that have ended. With `pause_started_at_ms`
    /// this is what a renderer needs to freeze its own clock without a
    /// round trip per tick.
    pub fn closed_paused_ms(&self) -> i64 {
        self.spans
            .iter()
            .filter(|span| span.ended_at_ms.is_some())
            .map(|span| span.duration_ms(0))
            .sum()
    }
}

/// Total paused time across `spans`, counting an open span up to `now_ms`.
pub fn paused_total_ms(spans: &[PauseSpan], now_ms: i64) -> i64 {
    spans.iter().map(|span| span.duration_ms(now_ms)).sum()
}

/// Elapsed recording time excluding pauses: what the timer shows.
pub fn elapsed_excluding_pauses_ms(started_at_ms: i64, now_ms: i64, spans: &[PauseSpan]) -> i64 {
    (now_ms - started_at_ms - paused_total_ms(spans, now_ms)).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_then_resume_records_one_closed_span() {
        let mut ledger = PauseLedger::default();
        assert!(!ledger.is_paused());

        let opened = ledger.pause(10_000, 42.5).expect("pause").clone();
        assert!(ledger.is_paused());
        assert_eq!(opened.started_at_ms, 10_000);
        assert_eq!(opened.ended_at_ms, None);
        assert_eq!(opened.at_seconds, 42.5);
        assert_eq!(ledger.pause_started_at_ms(), Some(10_000));

        let closed = ledger.resume(130_000).expect("resume");
        assert!(!ledger.is_paused());
        assert_eq!(closed.ended_at_ms, Some(130_000));
        assert_eq!(closed.duration_ms(999_999), 120_000);
        assert_eq!(ledger.spans().len(), 1);
        assert_eq!(ledger.closed_paused_ms(), 120_000);
        assert_eq!(ledger.pause_started_at_ms(), None);
    }

    #[test]
    fn pausing_twice_and_resuming_when_not_paused_are_refused() {
        let mut ledger = PauseLedger::default();
        assert_eq!(ledger.resume(5), Err(PauseError::NotPaused));
        ledger.pause(5, 0.0).expect("first pause");
        assert_eq!(
            ledger.pause(6, 0.0).map(|_| ()),
            Err(PauseError::AlreadyPaused)
        );
        ledger.resume(7).expect("resume");
        assert_eq!(ledger.resume(8), Err(PauseError::NotPaused));
        // The refused calls left nothing behind.
        assert_eq!(ledger.spans().len(), 1);
    }

    #[test]
    fn open_span_counts_up_to_now_and_stop_closes_it() {
        let mut ledger = PauseLedger::default();
        ledger.pause(1_000, 3.0).expect("pause");
        assert_eq!(ledger.paused_ms(4_000), 3_000);
        assert_eq!(ledger.paused_ms(9_000), 8_000);
        // Closed spans exclude the open one; the renderer adds it itself.
        assert_eq!(ledger.closed_paused_ms(), 0);

        let closed = ledger.close_open(9_500).expect("closed by stop");
        assert_eq!(closed.ended_at_ms, Some(9_500));
        assert!(!ledger.is_paused());
        assert_eq!(ledger.paused_ms(50_000), 8_500);
        // Nothing to close a second time.
        assert_eq!(ledger.close_open(60_000), None);
    }

    #[test]
    fn elapsed_time_excludes_every_pause() {
        let spans = vec![
            PauseSpan {
                started_at_ms: 60_000,
                ended_at_ms: Some(90_000),
                at_seconds: 60.0,
            },
            PauseSpan {
                started_at_ms: 200_000,
                ended_at_ms: None,
                at_seconds: 170.0,
            },
        ];
        // 240 s of wall clock, 30 s closed pause, 40 s open pause => 170 s.
        assert_eq!(elapsed_excluding_pauses_ms(0, 240_000, &spans), 170_000);
        // Never negative, even for a clock that went backwards.
        assert_eq!(elapsed_excluding_pauses_ms(500_000, 240_000, &spans), 0);
        assert_eq!(elapsed_excluding_pauses_ms(0, 240_000, &[]), 240_000);
    }

    #[test]
    fn a_resume_before_the_pause_started_is_clamped_to_zero_length() {
        let mut ledger = PauseLedger::default();
        ledger.pause(10_000, 1.0).expect("pause");
        let closed = ledger.resume(9_000).expect("resume");
        assert_eq!(closed.ended_at_ms, Some(10_000));
        assert_eq!(closed.duration_ms(0), 0);
    }

    #[test]
    fn spans_serialize_camel_case_for_the_renderer() {
        let span = PauseSpan {
            started_at_ms: 1,
            ended_at_ms: Some(2),
            at_seconds: 3.5,
        };
        let json = serde_json::to_value(&span).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "startedAtMs": 1, "endedAtMs": 2, "atSeconds": 3.5 })
        );
        let back: PauseSpan = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, span);
    }
}
