//! Per-dictation timing record: the user-felt latency the Wave 3 audit found
//! nobody measured.
//!
//! Before this module, the only latency receipt in the repo
//! (`artifacts/qa/dictation-latency.json`) covered `metricScope:
//! "provider_transcription_only"` — ASR decode alone, ~70ms for a typical
//! utterance on base.en. It said nothing about audio finalization, the local
//! dictionary/snippet/smart-format pipeline, the optional pre-insert LLM
//! formatting pass (guarded by `dictation_format_timeout` in `lib.rs`), or
//! insertion itself.
//!
//! `DictationTimingRecord` is that missing measurement: six checkpoints,
//! each expressed as milliseconds elapsed since the stop command was
//! received, assembled by a pure function so the assembly logic is testable
//! without a real dictation session, a real clock, or a real LLM call.
//! Building the record costs nothing beyond `Instant::now()` calls that
//! already happen on this path (see `stop_dictation_for_sidecar` in
//! `lib.rs`) — no new locks, no new syscalls, and the record is dropped on
//! the floor if nothing reads it.
//!
//! One honesty note that matters more than it looks: the zero point is
//! `stop_command_received_at_epoch_ms`, not "the hotkey release." Electron
//! passes the real client-side stop-gesture epoch when it has one (captured
//! before any IPC `invoke` await in `dictation-shortcut-controller.ts`), and
//! this record uses it when present -- but a caller that omits it (an older
//! build, or a stop path with no discrete client gesture, e.g. a VAD
//! auto-stop) falls back to when the sidecar's own stop handler ran, which
//! is measurably later than the real gesture by whatever the Electron-to-
//! sidecar IPC hop costs. Only call this "key-release-to-glyph" for a
//! session that actually supplied the gesture epoch; otherwise it is
//! "stop-command-received-to-glyph," a related but smaller and more honest
//! number.

use serde::Serialize;

/// Maximum believable delay between an Electron stop gesture and receipt by
/// the sidecar. Older or future timestamps are treated as malformed and fall
/// back to the sidecar receipt time, keeping the epoch and elapsed fields on
/// the same zero point without allowing an arbitrary IPC value to inflate the
/// latency record.
pub(crate) const MAX_GESTURE_TO_HANDLER_MS: i64 = 60_000;

pub(crate) fn resolve_stop_timing(
    handler_received_at_epoch_ms: i64,
    stop_gesture_epoch_ms: Option<i64>,
) -> (i64, u64) {
    let Some(gesture_epoch_ms) = stop_gesture_epoch_ms else {
        return (handler_received_at_epoch_ms, 0);
    };
    let Some(delay_ms) = handler_received_at_epoch_ms.checked_sub(gesture_epoch_ms) else {
        return (handler_received_at_epoch_ms, 0);
    };
    if !(0..=MAX_GESTURE_TO_HANDLER_MS).contains(&delay_ms) {
        return (handler_received_at_epoch_ms, 0);
    }
    (gesture_epoch_ms, delay_ms as u64)
}

/// How the format/cleanup stage of one dictation concluded.
///
/// This is the field the audit actually wanted: not just "how long did
/// formatting take" but "did it even run, and if it tried, did it finish,
/// get skipped, time out, or fail." A timeout or failure never loses the
/// user's words — see `resolve_dictation_format_attempt` below and the
/// call sites in `stop_dictation_for_sidecar` — but it should show up here
/// so the receipt can answer "how often does this actually happen."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationFormatOutcome {
    /// No format/cleanup stage ran at all: the transcript was empty, or a
    /// dictation command (backtrack, "scratch that", command-mode) consumed
    /// the utterance before formatting was ever considered.
    #[default]
    NotApplicable,
    /// The stage was reached but had nothing to do — the mode's transform
    /// requires an LLM pass and Smart Format / AI formatting is disabled in
    /// settings, so no local equivalent exists for that mode.
    Skipped,
    /// The stage produced its output within budget (local pipeline
    /// formatting, "notes" bulletizing, or an LLM pass that returned before
    /// its `dictation_format_timeout` budget -- local-vs-remote, see
    /// `lib.rs`).
    Applied,
    /// A pre-insert LLM pass hit its `dictation_format_timeout` budget and
    /// was abandoned; the local pipeline output was inserted instead.
    TimedOut,
    /// A pre-insert LLM pass returned an error (not a timeout) and was
    /// abandoned; the local pipeline output was inserted instead.
    Failed,
}

/// Wall-clock timing for one dictation, spanning the stop command through
/// insertion — closer to the number the user actually feels than the
/// ASR-only number the existing latency gate measures, though see the
/// module doc above for exactly how close (it depends on whether the caller
/// supplied a real client gesture epoch).
///
/// Every field but `format_outcome` and `insertion_confirmed` is
/// milliseconds elapsed since `stop_command_received_at_epoch_ms`, or `None`
/// when that stage was never reached (e.g. insertion fields stay `None` for
/// a preview-only session, or one where a backtrack command cleared the
/// text before insertion was ever attempted).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationTimingRecord {
    /// Epoch ms of the stop command being received — the real client-side
    /// gesture epoch (hotkey release, hands-free toggle) when the caller
    /// supplied one, else the moment this sidecar's own stop handler ran.
    /// The zero point every other field in this record is measured from.
    pub stop_command_received_at_epoch_ms: i64,
    /// Audio capture finalized into bytes ready for ASR.
    pub audio_finalized_ms: Option<u64>,
    /// ASR returned a transcript.
    pub asr_complete_ms: Option<u64>,
    /// The format/cleanup stage finished, however it finished — see
    /// `format_outcome`.
    pub format_complete_ms: Option<u64>,
    pub format_outcome: DictationFormatOutcome,
    /// The insertion path was dispatched (paste/copy call made). `None` when
    /// nothing was ever dispatched — preview-only delivery, an undo-only
    /// command, or an empty result.
    pub insertion_dispatched_ms: Option<u64>,
    /// The insertion attempt finished, successfully or not. `None` under the
    /// same conditions as `insertion_dispatched_ms`.
    pub insertion_confirmed_ms: Option<u64>,
    /// Whether the insertion path could positively confirm the text landed
    /// (a direct Accessibility write, or a read-back after paste) as opposed
    /// to a dispatch-and-assume (a bare Cmd+V with no read-back) or a
    /// clipboard-only copy, which never confirms delivery into an app.
    pub insertion_confirmed: bool,
    /// Total time from the stop command to the last thing that happened on
    /// this dictation's path to the user's screen —
    /// `insertion_confirmed_ms` when insertion was attempted, else
    /// `format_complete_ms`, else `asr_complete_ms`. This is the
    /// stop-command-to-glyph number (key-release-to-glyph exactly when
    /// `stop_command_received_at_epoch_ms` came from a real client gesture
    /// epoch, not a receipt-time fallback).
    pub total_ms: Option<u64>,
}

/// Inputs to [`assemble_dictation_timing_record`]. Plain data, no `Instant`s:
/// every field is already-elapsed milliseconds (or an epoch timestamp),
/// computed at the call site from one `Instant` captured once at function
/// entry plus the validated client-to-handler delay rather than
/// re-read from shared state, so a concurrent reset can't corrupt a stage
/// mid-flight. Keeping this a plain-data struct is what makes assembly
/// testable without a real clock or a real dictation session.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DictationTimingInputs {
    pub stop_command_received_at_epoch_ms: i64,
    pub audio_finalized_ms: Option<u64>,
    pub asr_complete_ms: Option<u64>,
    pub format_complete_ms: Option<u64>,
    pub format_outcome: DictationFormatOutcome,
    pub insertion_dispatched_ms: Option<u64>,
    pub insertion_confirmed_ms: Option<u64>,
    pub insertion_confirmed: bool,
}

/// Assemble a [`DictationTimingRecord`] from already-measured stage inputs.
///
/// Pure and total: never panics, never needs a clock, and computes
/// `total_ms` by falling back through whichever stages were actually
/// reached — insertion, else formatting, else ASR — so a session that never
/// reached insertion (preview-only, an undo-only command) still reports a
/// meaningful total instead of `None`.
pub fn assemble_dictation_timing_record(inputs: DictationTimingInputs) -> DictationTimingRecord {
    let total_ms = inputs
        .insertion_confirmed_ms
        .or(inputs.insertion_dispatched_ms)
        .or(inputs.format_complete_ms)
        .or(inputs.asr_complete_ms);

    DictationTimingRecord {
        stop_command_received_at_epoch_ms: inputs.stop_command_received_at_epoch_ms,
        audio_finalized_ms: inputs.audio_finalized_ms,
        asr_complete_ms: inputs.asr_complete_ms,
        format_complete_ms: inputs.format_complete_ms,
        format_outcome: inputs.format_outcome,
        insertion_dispatched_ms: inputs.insertion_dispatched_ms,
        insertion_confirmed_ms: inputs.insertion_confirmed_ms,
        insertion_confirmed: inputs.insertion_confirmed,
        total_ms,
    }
}

/// Render a [`DictationTimingRecord`] as the compact single-line summary
/// logged at info level on every completed dictation. Kept as a standalone,
/// pure formatter so its shape is covered by a plain unit test rather than
/// only ever being read from `tracing`'s (untested) output stream.
pub fn format_dictation_timing_summary(record: &DictationTimingRecord) -> String {
    format!(
        "audio={} asr={} format={}({:?}) insert_dispatch={} insert_confirm={} total={}",
        format_stage_ms(record.audio_finalized_ms),
        format_stage_ms(record.asr_complete_ms),
        format_stage_ms(record.format_complete_ms),
        record.format_outcome,
        format_stage_ms(record.insertion_dispatched_ms),
        format_stage_ms(record.insertion_confirmed_ms),
        format_stage_ms(record.total_ms),
    )
}

fn format_stage_ms(value: Option<u64>) -> String {
    match value {
        Some(ms) => format!("{ms}ms"),
        None => "n/a".to_string(),
    }
}

/// The three ways a pre-insert LLM formatting/transform pass can conclude,
/// already normalized away from `tokio::time::timeout`'s `Result<Result<T,
/// String>, Elapsed>` so the fallback decision below is framework-agnostic
/// and testable without tokio at all. The two call sites in
/// `stop_dictation_for_sidecar` (mode-transform for messages/email/meeting
/// follow-up, and smart-formatting for every other mode) both race an LLM
/// call against `dictation_format_timeout(provider)` -- local Ollama calls
/// get a longer budget than remote ones -- and land on exactly one of these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DictationFormatAttempt {
    Applied(String),
    Failed,
    TimedOut,
}

/// What a pre-insert LLM formatting/transform pass leaves behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictationFormatFallback {
    /// The text to carry forward: the LLM's output when it applied cleanly,
    /// or the caller's already-good local pipeline output otherwise. Never
    /// empty when `local_pipeline_text` was non-empty — the whole point of
    /// this fallback is that a stuck or failing model must never turn into a
    /// lost dictation.
    pub final_text: String,
    pub format_outcome: DictationFormatOutcome,
    pub warn_timed_out: bool,
    pub warn_failed: bool,
}

/// Resolve a [`DictationFormatAttempt`] into what should happen next.
///
/// This is the fallback contract the Wave 3 audit asked to be verified: on
/// timeout or failure, the caller's local pipeline output — the user's
/// words, already correctly formatted by the deterministic pass that ran
/// before this one — is what gets inserted. Never the empty string, never a
/// hang.
pub fn resolve_dictation_format_attempt(
    attempt: DictationFormatAttempt,
    local_pipeline_text: &str,
) -> DictationFormatFallback {
    match attempt {
        DictationFormatAttempt::Applied(text) => DictationFormatFallback {
            final_text: text,
            format_outcome: DictationFormatOutcome::Applied,
            warn_timed_out: false,
            warn_failed: false,
        },
        DictationFormatAttempt::Failed => DictationFormatFallback {
            final_text: local_pipeline_text.to_string(),
            format_outcome: DictationFormatOutcome::Failed,
            warn_timed_out: false,
            warn_failed: true,
        },
        DictationFormatAttempt::TimedOut => DictationFormatFallback {
            final_text: local_pipeline_text.to_string(),
            format_outcome: DictationFormatOutcome::TimedOut,
            warn_timed_out: true,
            warn_failed: false,
        },
    }
}

/// The single insertion-delay budget every pre-insert model pass of one
/// dictation draws from.
///
/// One dictation can run two model passes back to back before a word appears:
/// translate-to-English, then the mode transform or Smart Format pass. Each
/// used to take a fresh `dictation_format_timeout(provider)`, so the worst
/// case a user waited was twice the budget the constant claims -- 12 s on the
/// local split -- while every comment and receipt around it described 6 s.
///
/// The clock starts when the *first* pass starts, not when this is
/// constructed: provider resolution and prompt building deliberately run
/// outside the budget (they are not the model call the budget is meant to
/// time), and a dictation that runs no pre-insert pass at all must not have
/// the clock running against it.
#[derive(Debug, Clone, Copy, Default)]
pub struct DictationPreInsertBudget {
    started_at: Option<std::time::Instant>,
}

impl DictationPreInsertBudget {
    pub const fn new() -> Self {
        Self { started_at: None }
    }

    /// How long the next pass may run. The first call starts the clock;
    /// later calls return `budget` minus whatever the earlier passes already
    /// spent, so two passes cannot cost 2x. `Duration::ZERO` (the budget is
    /// already gone) makes `tokio::time::timeout` give up immediately, which
    /// is the intended outcome: the local pipeline text is already good, and
    /// the user has waited long enough.
    ///
    /// `now` is a parameter so the arithmetic is testable without sleeping.
    /// A later pass with a *larger* budget than the first (the two lanes
    /// resolve the same dictation AI provider today, so this does not happen
    /// in practice) is capped at that larger budget measured from the same
    /// start, never at their sum.
    pub fn remaining(
        &mut self,
        budget: std::time::Duration,
        now: std::time::Instant,
    ) -> std::time::Duration {
        let started_at = *self.started_at.get_or_insert(now);
        budget.saturating_sub(now.saturating_duration_since(started_at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gesture_delay_keeps_epoch_and_elapsed_values_aligned() {
        assert_eq!(resolve_stop_timing(10_125, Some(10_000)), (10_000, 125));
    }

    #[test]
    fn implausible_gesture_epochs_fall_back_to_handler_receipt() {
        assert_eq!(resolve_stop_timing(10_000, Some(10_001)), (10_000, 0));
        assert_eq!(resolve_stop_timing(100_000, Some(39_999)), (100_000, 0));
        assert_eq!(resolve_stop_timing(i64::MAX, Some(-1)), (i64::MAX, 0));
    }

    fn base_inputs() -> DictationTimingInputs {
        DictationTimingInputs {
            stop_command_received_at_epoch_ms: 1_000,
            audio_finalized_ms: Some(20),
            asr_complete_ms: Some(90),
            format_complete_ms: Some(95),
            format_outcome: DictationFormatOutcome::Applied,
            insertion_dispatched_ms: Some(110),
            insertion_confirmed_ms: Some(140),
            insertion_confirmed: true,
        }
    }

    #[test]
    fn full_success_path_totals_at_insertion_confirmed() {
        let record = assemble_dictation_timing_record(base_inputs());
        assert_eq!(record.stop_command_received_at_epoch_ms, 1_000);
        assert_eq!(record.audio_finalized_ms, Some(20));
        assert_eq!(record.asr_complete_ms, Some(90));
        assert_eq!(record.format_complete_ms, Some(95));
        assert_eq!(record.format_outcome, DictationFormatOutcome::Applied);
        assert_eq!(record.insertion_dispatched_ms, Some(110));
        assert_eq!(record.insertion_confirmed_ms, Some(140));
        assert!(record.insertion_confirmed);
        assert_eq!(record.total_ms, Some(140));
    }

    #[test]
    fn unconfirmed_insertion_falls_back_to_dispatch_time_for_total() {
        // A bare Cmd+V has no read-back: `paste_dispatched` outcomes never
        // set `insertion_confirmed_ms`. The total must still reflect when
        // the dispatch happened, not silently disappear to None.
        let inputs = DictationTimingInputs {
            insertion_confirmed_ms: None,
            insertion_confirmed: false,
            ..base_inputs()
        };
        let record = assemble_dictation_timing_record(inputs);
        assert_eq!(record.total_ms, Some(110));
        assert!(!record.insertion_confirmed);
    }

    #[test]
    fn preview_only_session_totals_at_format_complete() {
        // Preview delivery never dispatches insertion at all.
        let inputs = DictationTimingInputs {
            insertion_dispatched_ms: None,
            insertion_confirmed_ms: None,
            insertion_confirmed: false,
            ..base_inputs()
        };
        let record = assemble_dictation_timing_record(inputs);
        assert_eq!(record.total_ms, Some(95));
    }

    #[test]
    fn command_only_session_has_no_format_or_insertion_stage() {
        // "scratch that" with nothing recent to undo: the pipeline swallows
        // the utterance as a command before formatting or insertion is ever
        // reached. NotApplicable, not Skipped -- the stage was never reached
        // at all, as opposed to being reached and gated off by settings.
        //
        // This state is genuinely reachable in production: the caller
        // (`stop_dictation_for_sidecar`) only computes a `Some` elapsed value
        // for `format_complete_ms` when `format_outcome` has already moved
        // off `NotApplicable`, so a command-only session's `format_complete_ms`
        // is `None` here, not a stray "reached instantly" timestamp.
        let inputs = DictationTimingInputs {
            stop_command_received_at_epoch_ms: 2_000,
            audio_finalized_ms: Some(15),
            asr_complete_ms: Some(60),
            format_complete_ms: None,
            format_outcome: DictationFormatOutcome::NotApplicable,
            insertion_dispatched_ms: None,
            insertion_confirmed_ms: None,
            insertion_confirmed: false,
        };
        let record = assemble_dictation_timing_record(inputs);
        assert_eq!(record.format_outcome, DictationFormatOutcome::NotApplicable);
        assert_eq!(record.total_ms, Some(60));
    }

    #[test]
    fn nothing_reached_yields_a_fully_empty_record() {
        let record = assemble_dictation_timing_record(DictationTimingInputs {
            stop_command_received_at_epoch_ms: 3_000,
            ..Default::default()
        });
        assert_eq!(record.audio_finalized_ms, None);
        assert_eq!(record.asr_complete_ms, None);
        assert_eq!(record.format_complete_ms, None);
        assert_eq!(record.insertion_dispatched_ms, None);
        assert_eq!(record.insertion_confirmed_ms, None);
        assert_eq!(record.total_ms, None);
        assert_eq!(record.format_outcome, DictationFormatOutcome::NotApplicable);
    }

    #[test]
    fn summary_formats_missing_stages_as_not_applicable() {
        let record = assemble_dictation_timing_record(DictationTimingInputs {
            stop_command_received_at_epoch_ms: 0,
            asr_complete_ms: Some(70),
            format_outcome: DictationFormatOutcome::Skipped,
            ..Default::default()
        });
        let summary = format_dictation_timing_summary(&record);
        assert!(summary.contains("asr=70ms"), "{summary}");
        assert!(summary.contains("audio=n/a"), "{summary}");
        assert!(summary.contains("Skipped"), "{summary}");
        assert!(summary.contains("total=70ms"), "{summary}");
    }

    #[test]
    fn applied_attempt_keeps_the_llm_output_verbatim() {
        let fallback = resolve_dictation_format_attempt(
            DictationFormatAttempt::Applied("hi there".into()),
            "hi",
        );
        assert_eq!(fallback.final_text, "hi there");
        assert_eq!(fallback.format_outcome, DictationFormatOutcome::Applied);
        assert!(!fallback.warn_timed_out);
        assert!(!fallback.warn_failed);
    }

    #[test]
    fn timed_out_attempt_falls_back_to_local_text_and_warns_once() {
        let fallback = resolve_dictation_format_attempt(
            DictationFormatAttempt::TimedOut,
            "the meeting is at three",
        );
        assert_eq!(fallback.final_text, "the meeting is at three");
        assert_eq!(fallback.format_outcome, DictationFormatOutcome::TimedOut);
        assert!(fallback.warn_timed_out);
        assert!(!fallback.warn_failed);
        assert!(!fallback.final_text.is_empty());
    }

    #[test]
    fn failed_attempt_falls_back_to_local_text_and_warns_once() {
        let fallback =
            resolve_dictation_format_attempt(DictationFormatAttempt::Failed, "ship it tomorrow");
        assert_eq!(fallback.final_text, "ship it tomorrow");
        assert_eq!(fallback.format_outcome, DictationFormatOutcome::Failed);
        assert!(!fallback.warn_timed_out);
        assert!(fallback.warn_failed);
        assert!(!fallback.final_text.is_empty());
    }

    #[test]
    fn fallback_never_produces_empty_text_from_nonempty_local_text() {
        for attempt in [
            DictationFormatAttempt::Failed,
            DictationFormatAttempt::TimedOut,
        ] {
            let fallback = resolve_dictation_format_attempt(attempt, "non-empty local text");
            assert!(!fallback.final_text.is_empty());
            assert_eq!(fallback.final_text, "non-empty local text");
        }
    }
}

#[cfg(test)]
mod pre_insert_budget_tests {
    use super::DictationPreInsertBudget;
    use std::time::{Duration, Instant};

    const LOCAL: Duration = Duration::from_millis(6_000);

    #[test]
    fn the_first_pass_gets_the_whole_budget() {
        let mut budget = DictationPreInsertBudget::new();
        assert_eq!(budget.remaining(LOCAL, Instant::now()), LOCAL);
    }

    /// The regression: translate took a fresh 6 s and the format pass took
    /// another, so the worst case in front of insertion was 12 s.
    #[test]
    fn two_passes_share_one_budget_and_cannot_sum_past_it() {
        let start = Instant::now();
        let mut budget = DictationPreInsertBudget::new();

        let first = budget.remaining(LOCAL, start);
        // The first pass ran to its own cap.
        let after_first = start + first;
        let second = budget.remaining(LOCAL, after_first);

        assert_eq!(second, Duration::ZERO);
        assert!(
            first + second <= LOCAL,
            "{first:?} + {second:?} must not exceed {LOCAL:?}"
        );
    }

    #[test]
    fn a_fast_first_pass_leaves_the_rest_for_the_second() {
        let start = Instant::now();
        let mut budget = DictationPreInsertBudget::new();

        let first = budget.remaining(LOCAL, start);
        let spent_by_first = Duration::from_millis(400);
        let second = budget.remaining(LOCAL, start + spent_by_first);

        assert_eq!(first, LOCAL);
        assert_eq!(second, Duration::from_millis(5_600));
        // What the user actually waits: the first pass's real cost plus the
        // most the second may take. That total is the budget, not 2x it.
        assert_eq!(spent_by_first + second, LOCAL);
    }

    #[test]
    fn an_overrun_first_pass_leaves_zero_rather_than_a_negative_wrap() {
        let start = Instant::now();
        let mut budget = DictationPreInsertBudget::new();
        budget.remaining(LOCAL, start);
        assert_eq!(
            budget.remaining(LOCAL, start + Duration::from_secs(30)),
            Duration::ZERO
        );
    }

    /// Provider resolution runs outside the budget on purpose, and a
    /// dictation with no pre-insert pass must not have the clock running.
    #[test]
    fn the_clock_starts_at_the_first_pass_not_at_construction() {
        let built = Instant::now();
        let mut budget = DictationPreInsertBudget::new();
        let first_pass_at = built + Duration::from_secs(5);
        assert_eq!(budget.remaining(LOCAL, first_pass_at), LOCAL);
    }
}
