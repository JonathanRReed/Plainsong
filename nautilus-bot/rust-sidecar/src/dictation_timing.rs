//! Per-dictation timing record: the user-felt latency the Wave 3 audit found
//! nobody measured.
//!
//! Before this module, the only latency receipt in the repo
//! (`artifacts/qa/dictation-latency.json`) covered `metricScope:
//! "provider_transcription_only"` — ASR decode alone, ~70ms for a typical
//! utterance on base.en. It said nothing about the time from the moment the
//! user releases the dictation hotkey to the moment a glyph lands in their
//! app: audio finalization, the local dictionary/snippet/smart-format
//! pipeline, the optional pre-insert LLM formatting pass (guarded by
//! `DICTATION_FORMAT_TIMEOUT` in `lib.rs`), and insertion itself.
//!
//! `DictationTimingRecord` is that missing measurement: six checkpoints,
//! each expressed as milliseconds elapsed since the stop signal (hotkey
//! release), assembled by a pure function so the assembly logic is testable
//! without a real dictation session, a real clock, or a real LLM call.
//! Building the record costs nothing beyond `Instant::now()` calls that
//! already happen on this path (see `stop_dictation_for_sidecar` in
//! `lib.rs`) — no new locks, no new syscalls, and the record is dropped on
//! the floor if nothing reads it.

use serde::Serialize;

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
    /// `DICTATION_FORMAT_TIMEOUT`).
    Applied,
    /// A pre-insert LLM pass hit `DICTATION_FORMAT_TIMEOUT` and was
    /// abandoned; the local pipeline output was inserted instead.
    TimedOut,
    /// A pre-insert LLM pass returned an error (not a timeout) and was
    /// abandoned; the local pipeline output was inserted instead.
    Failed,
}

/// Wall-clock timing for one dictation, spanning stop signal (hotkey
/// release) through insertion — the number the user actually feels, not
/// just the ASR-only number the existing latency gate measures.
///
/// Every field but `format_outcome` and `insertion_confirmed` is
/// milliseconds elapsed since `stop_signal_received_at_epoch_ms`, or `None`
/// when that stage was never reached (e.g. insertion fields stay `None` for
/// a preview-only session, or one where a backtrack command cleared the
/// text before insertion was ever attempted).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationTimingRecord {
    /// Epoch ms of the stop signal itself (hotkey release, VAD auto-stop,
    /// manual stop, or popup stop) — the zero point every other field in
    /// this record is measured from.
    pub stop_signal_received_at_epoch_ms: i64,
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
    /// Total time from stop signal to the last thing that happened on this
    /// dictation's path to the user's screen — `insertion_confirmed_ms` when
    /// insertion was attempted, else `format_complete_ms`, else
    /// `asr_complete_ms`. This is the key-release-to-glyph number.
    pub total_ms: Option<u64>,
}

/// Inputs to [`assemble_dictation_timing_record`]. Plain data, no `Instant`s:
/// every field is already-elapsed milliseconds (or an epoch timestamp),
/// computed at the call site the same way the rest of `stop_dictation_for_sidecar`
/// already computes latencies (`tracker.stop_requested_at.map(|s| s.elapsed()...)`).
/// Keeping this a plain-data struct is what makes assembly testable without a
/// real clock or a real dictation session.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DictationTimingInputs {
    pub stop_signal_received_at_epoch_ms: i64,
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
        stop_signal_received_at_epoch_ms: inputs.stop_signal_received_at_epoch_ms,
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
/// call against `DICTATION_FORMAT_TIMEOUT` and land on exactly one of these.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn base_inputs() -> DictationTimingInputs {
        DictationTimingInputs {
            stop_signal_received_at_epoch_ms: 1_000,
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
        assert_eq!(record.stop_signal_received_at_epoch_ms, 1_000);
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
        let inputs = DictationTimingInputs {
            stop_signal_received_at_epoch_ms: 2_000,
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
            stop_signal_received_at_epoch_ms: 3_000,
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
            stop_signal_received_at_epoch_ms: 0,
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
