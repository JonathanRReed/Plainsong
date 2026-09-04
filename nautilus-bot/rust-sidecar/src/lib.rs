//! Plainsong sidecar library.
//!
//! The sidecar is a newline-delimited JSON-RPC process: `src/bin/sidecar.rs`
//! reads a request off stdin and calls `dispatch_command`, which routes it to a
//! handler. Everything the renderer can reach goes through that one door, so
//! the door is the seam a future Tauri command layer would call directly
//! (`docs/tauri-migration-plan.md`).
//!
//! ## Module map
//!
//! This file held 37,881 lines of handler bodies. The split was move-only:
//! nothing was renamed, and `lib.rs` re-exports every module with a glob, so
//! each moved item still resolves by its old unqualified name from here and
//! from every test. Items had to be widened to `pub(crate)` for a glob to carry
//! them; that is the only change any of them saw.
//!
//! | module | lines | what lives there |
//! | --- | --- | --- |
//! | `dispatch` | 4,081 | `dispatch_command` and its match over every JSON-RPC method |
//! | `dictation_session` | 2,976 | one dictation session: start capture, stop, deliver, fail cleanly |
//! | `text_insert` | 2,163 | the AX, clipboard and keystroke path that puts text at the cursor |
//! | `recording_lifecycle` | 1,968 | meeting start preconditions and failures, pause, capture monitors, stop |
//! | `recording_vault` | 1,933 | recording-audio encryption, vault keys, playback staging |
//! | `dictation_text` | 1,798 | transcript sanitising, rewrites, snippets, mode and prompt resolution |
//! | `analysis` | 1,463 | the meeting analysis passes, grounded output, relationship memory |
//! | `meeting_transcribe` | 1,265 | chunked transcription, diarizer choice, transcript assembly |
//! | `retention` | 1,210 | retention policies, owned-audio deletion, meeting auto-naming |
//! | `dictation_reprocess` | 1,105 | reprocessing a kept dictation, selected-text transforms |
//! | `settings_values` | 792 | normalising every stored settings string, model warm-up |
//! | `meeting_pipeline` | 716 | the post-stop transcribe/diarize/persist/analyse pipeline |
//! | `audio_import_runtime` | 691 | `import_audio_file` and its `afconvert` staging |
//! | `speakers` | 676 | speaker aliases, voice clusters, person names |
//! | `asr_routing` | 676 | provider and model selection, route policy, fallback |
//! | `permissions` | 675 | permission requests, Setup diagnostics, cursor-insert repair |
//! | `dictation_live_preview` | 657 | engine choice and the preview task, which may only emit a preview |
//! | `streaming_partials` | 460 | partial-decode scheduling, VAD-aligned chunk cuts, stream events |
//! | `dictation_commands` | 391 | spoken-command context capture and execution |
//! | `model_cache` | 357 | on-disk model artifact validation and cache repair |
//! | `export_paths` | 323 | template export, approved roots, the path guard |
//! | `provider_models` | 179 | one model-catalogue fetch per remote provider |
//! | `tests` | 7,284 | the handler tests that still cover what is left in this file |
//!
//! What stays here: the crate docs, the module declarations and re-exports,
//! `AppState` and the shared types the modules operate on, and the sidecar
//! lifecycle the binary drives -- `build_app_state`, `save_settings_for_sidecar`,
//! `reset_app_state_for_sidecar`, the startup reconcilers, and shutdown.
//!
//! `dispatch_command` is still a match of inline handler bodies, not a thin
//! router. Lifting ~190 arms into handler functions is a logic edit rather than
//! a move, so it is deliberately not part of the split; it is now a change
//! inside one 4k-line file instead of a conflict with every other lane.

pub mod admission;
mod analysis;
mod approved_locations;
pub mod asr;
mod asr_routing;
mod audio;
mod audio_import;
mod audio_import_runtime;
mod backup;
mod crypto;
mod db;
mod diarization;
mod dictation_commands;
pub mod dictation_correction_capture;
mod dictation_dictionary_csv;
mod dictation_live_preview;
pub mod dictation_parity;
pub mod dictation_pipeline;
mod dictation_reprocess;
pub mod dictation_secure_field;
mod dictation_session;
mod dictation_text;
pub mod dictation_timing;
mod dispatch;
mod download;
mod events;
mod export;
mod export_paths;
mod llm;
pub mod local_tools;
pub mod meeting_brief;
pub mod meeting_detect;
mod meeting_pipeline;
mod meeting_transcribe;
mod model_cache;
mod models;
mod operation_coordinator;
mod ort_utils;
mod paths;
mod permissions;
mod playback;
mod provider_models;
mod recording_audio;
mod recording_lifecycle;
pub mod recording_pause;
mod recording_vault;
mod remote_processing;
mod retention;
mod safe_fs;
mod secrets;
pub mod settings;
mod settings_values;
pub mod sidecar_handle;
mod speakers;
mod store;
mod streaming;
mod streaming_partials;
pub mod support_bundle;
#[cfg(test)]
mod test_fs;
pub mod text;
mod text_insert;
mod transcription;

use crate::asr::manager::RuntimeStatus;
#[cfg(test)]
use crate::dictation_parity::SnippetRule;
use crate::events::{DictationTextReadyEvent, RecordingStatusChangedEvent};
use crate::sidecar_handle::AppEmitter;
use crate::store::{
    InsertionActionRecord, MeetingChatCitationRecord, MeetingChatMessageRecord,
    TranscriptArtifactRecord,
};
use anyhow::Result;
#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use core_foundation::base::{CFRelease, TCFType};
#[cfg(target_os = "macos")]
use core_foundation::boolean::CFBoolean;
#[cfg(target_os = "macos")]
use core_foundation::dictionary::CFDictionary;
#[cfg(target_os = "macos")]
use core_foundation::string::CFString;
#[cfg(target_os = "macos")]
use core_foundation_sys::base::{Boolean, CFGetTypeID, CFRange, CFTypeRef};
#[cfg(target_os = "macos")]
use core_foundation_sys::dictionary::CFDictionaryRef;
#[cfg(target_os = "macos")]
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
#[cfg(target_os = "macos")]
use objc2::runtime::Bool;
use rand::Rng;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::Condvar;
use std::sync::LazyLock;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tokio::sync::Mutex;

// Re-exported so the split stays invisible to callers: `src/bin/sidecar.rs` and
// every test still name `plainsong::dispatch_command`.
pub use dispatch::dispatch_command;
pub use recording_lifecycle::spawn_meeting_call_detection;
pub use recording_vault::sweep_runtime_playback_audio_for_sidecar;

// Glob re-exports of the modules lib.rs was split into, so every call site left
// here resolves the moved items by their old unqualified names. Nothing was
// renamed; the modules are the only thing that is new.
pub(crate) use analysis::*;
pub(crate) use asr_routing::*;
pub(crate) use audio_import_runtime::*;
pub(crate) use dictation_commands::*;
pub(crate) use dictation_live_preview::*;
pub(crate) use dictation_reprocess::*;
pub(crate) use dictation_session::*;
pub(crate) use dictation_text::*;
pub(crate) use export_paths::*;
pub(crate) use meeting_pipeline::*;
pub(crate) use meeting_transcribe::*;
pub(crate) use model_cache::*;
pub(crate) use permissions::*;
pub(crate) use provider_models::*;
pub(crate) use recording_lifecycle::*;
pub(crate) use recording_vault::*;
pub(crate) use retention::*;
pub(crate) use settings_values::*;
pub(crate) use speakers::*;
pub(crate) use streaming_partials::*;
pub(crate) use text_insert::*;

pub struct AppState {
    db: Arc<Mutex<db::Database>>,
    audio_capture: Arc<Mutex<audio::AudioCapture>>,
    asr_manager: Arc<asr::AsrManager>,
    ollama_client: Arc<llm::OllamaClient>,
    ollama_embedder: Arc<llm::OllamaEmbedder>,
    settings_manager: Arc<Mutex<settings::SettingsManager>>,
    remote_processing_gate: Arc<remote_processing::RemoteProcessingGate>,
    pub(crate) backup_manager: Arc<Mutex<backup::BackupManager>>,
    template_manager: Arc<export::templates::TemplateManager>,
    dictation_hotkey_active: Arc<Mutex<bool>>,
    dictation_release_pending: Arc<AtomicBool>,
    dictation_session_tracker: Arc<Mutex<DictationSessionTracker>>,
    dictation_runtime_state: Arc<Mutex<DictationSessionState>>,
    dictation_start_options: Arc<Mutex<models::DictationStartOptions>>,
    pending_dictation_target: Arc<StdMutex<Option<PendingDictationTarget>>>,
    last_external_target: Arc<StdMutex<Option<PendingDictationTarget>>>,
    dictation_overlay_state: Arc<StdMutex<DictationOverlayState>>,
    recording_overlay_state: Arc<StdMutex<RecordingOverlayState>>,
    accessibility_trust_observed: Arc<AtomicBool>,
    last_cursor_insert_status: Arc<StdMutex<Option<CursorInsertStatus>>>,
    recent_dictation_delivery: Arc<Mutex<Option<RecentDictationDelivery>>>,
    /// The streaming live preview running for the active dictation session, if
    /// any. Held here so every dictation stop path can close the recognizer
    /// before the batch decode that produces the inserted text starts.
    dictation_live_preview: Arc<Mutex<Option<DictationLivePreviewControl>>>,
    streaming_transcriber: Arc<streaming::StreamingTranscriber>,
    vault_state: Arc<Mutex<VaultRuntimeState>>,
    /// What the startup vault check found: whether a plaintext database that
    /// already had a durable key was encrypted just now, or why it could not
    /// be. Read once by the sidecar to raise the notice, so it is a plain
    /// value rather than a lock.
    vault_startup_migration: VaultStartupMigration,
    /// Serializes recording file ownership transitions across capture, vault
    /// migration, deletion, and retention.
    audio_storage_gate: Arc<Mutex<()>>,
    /// Stop flag for the live recording streaming task; set to false to terminate it
    recording_stream_stop: Arc<AtomicBool>,
    /// Per-recording template (standup, 1on1, sales, interview, brainstorm, auto)
    recording_templates: Arc<StdMutex<std::collections::HashMap<String, String>>>,
    /// Reference-counted recordings whose stored audio is being consumed by
    /// manual post-processing. Cleanup checks this while holding the database
    /// lock, so it cannot remove a file after a command has claimed it.
    active_meeting_audio_postprocessing: Arc<StdMutex<HashMap<String, usize>>>,
    operation_coordinator: Arc<operation_coordinator::OperationCoordinator>,
    /// Single-use proofs that a real user gesture asked for a meeting capture.
    /// Registered by the privileged Electron side and redeemed by
    /// `authorize_meeting_capture_options`.
    capture_admission: Arc<admission::CaptureAdmissionRegistry>,
    /// Prepared in-app playbacks, keyed by token. See `playback.rs`.
    playback_registry: Arc<playback::PlaybackRegistry>,
    active_capture_lease: Arc<Mutex<Option<(String, operation_coordinator::OperationLease)>>>,
    /// Set as soon as the sidecar accepts a shutdown request. Meeting
    /// post-processing failures caused by runtime teardown must remain
    /// `processing` so the next launch can reconcile and offer saved-audio
    /// recovery instead of misreporting a real transcription failure.
    sidecar_shutting_down: Arc<AtomicBool>,
    /// The last few completed dictation results, newest first, for the
    /// re-paste/re-copy recovery hotkeys and the menu-bar menu. When insertion
    /// silently fails this is the path that keeps the user from losing thirty
    /// seconds of speech, so it is kept in memory even when history retention
    /// is set to discard transcripts.
    recent_dictation_results: Arc<StdMutex<Vec<RecentDictationResult>>>,
    /// The live-call detector's debounced state. Polled by
    /// `spawn_meeting_call_detection`, read by `get_meeting_call_status` and
    /// by the meeting capture monitor's call-ended auto-stop.
    meeting_call_detector: Arc<StdMutex<meeting_detect::CallDetector>>,
    /// Voice signatures for clusters nobody has named, held only while the app
    /// is running. The database gets a signature when a cluster is given a
    /// name; everything else stays here so a chip can still be offered without
    /// keeping a record of every voice in the room. Cleared by quitting.
    session_cluster_voices: Arc<StdMutex<diarization::voiceprints::SessionClusterVoices>>,
}

struct MeetingAudioPostprocessingGuard {
    active: Arc<StdMutex<HashMap<String, usize>>>,
    recording_id: String,
    _operation_lease: Option<operation_coordinator::OperationLease>,
}

impl MeetingAudioPostprocessingGuard {
    fn new(active: Arc<StdMutex<HashMap<String, usize>>>, recording_id: &str) -> Self {
        {
            let mut active_recordings = active.lock().unwrap_or_else(|error| error.into_inner());
            *active_recordings
                .entry(recording_id.to_string())
                .or_insert(0) += 1;
        }
        Self {
            active,
            recording_id: recording_id.to_string(),
            _operation_lease: None,
        }
    }

    fn coordinated(
        active: Arc<StdMutex<HashMap<String, usize>>>,
        recording_id: &str,
        operation_lease: operation_coordinator::OperationLease,
    ) -> Self {
        let mut guard = Self::new(active, recording_id);
        guard._operation_lease = Some(operation_lease);
        guard
    }
}

impl Drop for MeetingAudioPostprocessingGuard {
    fn drop(&mut self) {
        let mut active_recordings = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(count) = active_recordings.get_mut(&self.recording_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                active_recordings.remove(&self.recording_id);
            }
        }
    }
}

fn active_meeting_audio_postprocessing_ids(state: &AppState) -> HashSet<String> {
    state
        .active_meeting_audio_postprocessing
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .keys()
        .cloned()
        .collect()
}

const MIN_DICTATION_SILENCE_TIMEOUT_SECONDS: f32 = 0.8;
const MAX_DICTATION_SILENCE_TIMEOUT_SECONDS: f32 = 30.0;
/// Fallback silence-auto-stop duration used for hands-free dictation sessions
/// when `dictation_silence_timeout_seconds` is unset/disabled (0). Hands-free
/// sessions start automatically on detected speech, so without this fallback
/// they would never auto-stop, contradicting the in-app copy that promises a
/// 1.8s fallback (see dictation-view.tsx "Hands-free guide").
const HANDS_FREE_DEFAULT_SILENCE_TIMEOUT_SECONDS: f32 = 1.8;
const DICTATION_PASTE_CLIPBOARD_RESTORE_DELAY_MS: u64 = 900;
const DICTATION_IDLE_RESET_SUCCESS_MS: u64 = 1800;
/// How long a failed dictation's error panel stays up before it resets itself.
/// Longer than the success window because the user has to read it, but bounded:
/// without a reset the error parked an always-on-top panel on screen forever
/// (only the success path ever scheduled one), and nothing else took it down.
const DICTATION_IDLE_RESET_ERROR_MS: u64 = 9000;
/// Cap on how long any pre-insert LLM pass may delay insertion. The local
/// pipeline output is already a good result, so on timeout we insert that
/// rather than making the user wait on a slow or stuck model.
///
/// Was 6s flat, for every provider. The Wave 3 audit measured this app had
/// never recorded end-to-end (key-release-to-glyph) latency at all -- only
/// ASR decode time -- while competing dictation tools land the *entire*
/// pipeline, insertion included, in 130-700ms. Six seconds of silent
/// waiting in front of insertion was never a real budget, just whatever
/// felt "safe" before anyone measured anything.
///
/// A flat replacement number is still wrong, though: a remote API call and a
/// local Ollama call are not the same budget. Ollama pays a real, currently
/// unmeasured cold-model-load cost on top of inference that a remote
/// provider (already warm, running on someone else's hardware) does not, so
/// collapsing both onto one tight number would either starve local models on
/// their first call or leave remote ones needlessly generous. This mirrors
/// `analysis_timeouts` above (line ~1485), which draws exactly the same
/// local-vs-remote line for meeting analysis: `AnalysisProvider::Ollama`
/// gets the long budget, everything else gets the short one. Both fall back
/// to the already-good local pipeline output on timeout (see
/// `resolve_dictation_format_attempt` in `dictation_timing.rs` and its call
/// sites below) rather than losing the dictation, and `format_outcome` on
/// the runtime timing record tracks how often each actually fires --
/// tighten these from real rates, not from a guess.
const DICTATION_FORMAT_TIMEOUT_REMOTE: Duration = Duration::from_millis(2_500);
/// Generous next to the 130-700ms competitor bar precisely because it has to
/// cover a cold local model load that the remote budget above never has to.
const DICTATION_FORMAT_TIMEOUT_LOCAL: Duration = Duration::from_millis(6_000);

/// Picks the pre-insert LLM formatting budget for `provider`, following the
/// same local-vs-remote split as `analysis_timeouts`.
fn dictation_format_timeout(provider: AnalysisProvider) -> Duration {
    if provider.is_remote() {
        DICTATION_FORMAT_TIMEOUT_REMOTE
    } else {
        DICTATION_FORMAT_TIMEOUT_LOCAL
    }
}
const MAX_BENCHMARK_AUDIO_BYTES: usize = 6 * 1024 * 1024;
/// Shown when a pre-insert LLM pass could not run. The user still gets their
/// words — the locally formatted text — so this is a warning, not an error.
/// These describe the formatting pass ONLY: they are appended to whatever the
/// delivery outcome turned out to be (see `dictation_done_message`), so they
/// must not assert that the text was inserted — insertion can still fail.
const DICTATION_FORMAT_FAILED_WARNING: &str =
    "AI formatting could not run, so the text was left unformatted.";
const DICTATION_FORMAT_TIMEOUT_WARNING: &str =
    "AI formatting took too long, so the text was left unformatted.";
/// Translate-to-English through the AI lane did not come back in time or at
/// all; the words in the language spoken were kept (see B7a in
/// `stop_dictation_for_sidecar`).
const DICTATION_TRANSLATE_FAILED_WARNING: &str =
    "Translation to English could not run, so the words were kept in the language you spoke.";

#[cfg(test)]
mod dictation_format_timeout_tests {
    use super::*;

    // These exercise the exact mechanism `stop_dictation_for_sidecar` uses at
    // both of its pre-insert LLM call sites --
    // `tokio::time::timeout(dictation_format_timeout(provider), future)`
    // racing a future -- rather than mocking the whole function.

    #[test]
    fn remote_and_local_dictation_format_timeouts_follow_analysis_timeouts_split() {
        // Regression guard: this was one flat 6s, then one flat 2.5s. Neither
        // was right -- a local Ollama call pays a real cold-model-load cost a
        // remote call never does. See the constants' doc comments for the
        // full reasoning; this just pins the values and the dispatch.
        assert_eq!(
            DICTATION_FORMAT_TIMEOUT_REMOTE,
            Duration::from_millis(2_500)
        );
        assert_eq!(DICTATION_FORMAT_TIMEOUT_LOCAL, Duration::from_millis(6_000));
        assert!(
            DICTATION_FORMAT_TIMEOUT_LOCAL > DICTATION_FORMAT_TIMEOUT_REMOTE,
            "local must stay the more generous budget -- it's the one covering cold model load"
        );

        assert_eq!(
            dictation_format_timeout(AnalysisProvider::Ollama),
            DICTATION_FORMAT_TIMEOUT_LOCAL
        );
        for remote in [
            AnalysisProvider::OpenAi,
            AnalysisProvider::Anthropic,
            AnalysisProvider::Gemini,
            AnalysisProvider::DeepSeek,
            AnalysisProvider::OllamaCloud,
        ] {
            assert_eq!(
                dictation_format_timeout(remote),
                DICTATION_FORMAT_TIMEOUT_REMOTE,
                "{remote:?} is a remote provider and must get the shorter budget"
            );
        }
        // The two on-device providers pay a cold-load cost of their own -- a
        // 484 MB GGUF and a Metal shader compile for one, an OS model load
        // for the other -- and neither touches a network. They belong on the
        // local side of this split, which is why the dispatch now asks
        // `is_remote()` instead of comparing against Ollama.
        for local in [
            AnalysisProvider::BundledLocal,
            AnalysisProvider::AppleLanguageModel,
        ] {
            assert_eq!(
                dictation_format_timeout(local),
                DICTATION_FORMAT_TIMEOUT_LOCAL,
                "{local:?} runs on this Mac and must get the local budget"
            );
        }
    }

    #[test]
    fn analysis_timeouts_follow_the_same_local_split_as_the_format_budget() {
        for local in [
            AnalysisProvider::Ollama,
            AnalysisProvider::BundledLocal,
            AnalysisProvider::AppleLanguageModel,
        ] {
            assert_eq!(
                analysis_timeouts(local).request,
                ANALYSIS_LOCAL_REQUEST_TIMEOUT,
                "{local:?}"
            );
        }
        assert_eq!(
            analysis_timeouts(AnalysisProvider::OpenAi).request,
            ANALYSIS_REMOTE_REQUEST_TIMEOUT
        );
    }

    #[test]
    fn the_meetings_lane_refuses_a_dictation_only_provider_by_name() {
        for dictation_only in [
            AnalysisProvider::BundledLocal,
            AnalysisProvider::AppleLanguageModel,
        ] {
            let error = enforce_meeting_lane_provider_policy(dictation_only)
                .expect_err("a dictation-only provider must not serve meetings");
            assert!(
                error.contains(dictation_only.as_settings_value()),
                "the refusal must name the provider: {error}"
            );
            assert!(
                error.contains("Ollama") && error.contains("Models"),
                "the refusal must name the alternative and where to change it: {error}"
            );
        }
        for allowed in [
            AnalysisProvider::Ollama,
            AnalysisProvider::OpenAi,
            AnalysisProvider::Anthropic,
            AnalysisProvider::Gemini,
            AnalysisProvider::DeepSeek,
            AnalysisProvider::OllamaCloud,
        ] {
            assert!(
                enforce_meeting_lane_provider_policy(allowed).is_ok(),
                "{allowed:?}"
            );
        }
    }

    #[test]
    fn a_custom_transform_refusal_names_the_provider_and_the_alternative() {
        // Both call sites fall back to a deterministic local transform when
        // this fires, so the message only reaches the log -- but it is the
        // log line someone will read when a custom mode stops using AI.
        for provider in [
            AnalysisProvider::BundledLocal,
            AnalysisProvider::AppleLanguageModel,
        ] {
            let error = custom_transform_unsupported_error(provider);
            assert!(error.contains(provider.as_settings_value()), "{error}");
            assert!(error.contains("custom transform prompt"), "{error}");
            assert!(error.contains("Ollama"), "{error}");
        }
        // The refusal is keyed on the same predicate the dispatch uses, so a
        // provider that can follow a prompt never lands here.
        for allowed in [AnalysisProvider::Ollama, AnalysisProvider::Anthropic] {
            assert!(!allowed.is_zero_setup_local(), "{allowed:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_pass_times_out_and_falls_back_to_local_text_not_empty() {
        // Paused virtual time: `sleep` and `timeout` both race on the same
        // mocked clock, so this resolves the timeout deterministically and
        // instantly -- no real wall-clock wait, no flakiness under load.
        let local_pipeline_text = "the meeting is at three".to_string();
        let slow_pass = async {
            tokio::time::sleep(DICTATION_FORMAT_TIMEOUT_LOCAL + Duration::from_secs(1)).await;
            Ok::<String, String>("llm output that never arrives in time".to_string())
        };

        let raced = tokio::time::timeout(DICTATION_FORMAT_TIMEOUT_REMOTE, slow_pass).await;
        let attempt = match raced {
            Ok(Ok(text)) => crate::dictation_timing::DictationFormatAttempt::Applied(text),
            Ok(Err(_)) => crate::dictation_timing::DictationFormatAttempt::Failed,
            Err(_) => crate::dictation_timing::DictationFormatAttempt::TimedOut,
        };
        let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
            attempt,
            &local_pipeline_text,
        );

        assert_eq!(
            fallback.format_outcome,
            crate::dictation_timing::DictationFormatOutcome::TimedOut
        );
        assert_eq!(fallback.final_text, local_pipeline_text);
        assert!(!fallback.final_text.is_empty());
        assert!(fallback.warn_timed_out);
        assert!(!fallback.warn_failed);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_local_pass_gets_the_longer_budget_and_still_completes() {
        // The whole point of the split: a pass that would time out under the
        // remote budget must still succeed under the local one.
        let local_pipeline_text = "the meeting is at three".to_string();
        let slow_but_within_local_budget = async {
            tokio::time::sleep(DICTATION_FORMAT_TIMEOUT_LOCAL - Duration::from_millis(500)).await;
            Ok::<String, String>("cold-loaded local model output".to_string())
        };

        let raced = tokio::time::timeout(
            dictation_format_timeout(AnalysisProvider::Ollama),
            slow_but_within_local_budget,
        )
        .await;
        let attempt = match raced {
            Ok(Ok(text)) => crate::dictation_timing::DictationFormatAttempt::Applied(text),
            Ok(Err(_)) => crate::dictation_timing::DictationFormatAttempt::Failed,
            Err(_) => crate::dictation_timing::DictationFormatAttempt::TimedOut,
        };
        let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
            attempt,
            &local_pipeline_text,
        );

        assert_eq!(
            fallback.format_outcome,
            crate::dictation_timing::DictationFormatOutcome::Applied
        );
        assert_eq!(fallback.final_text, "cold-loaded local model output");
    }

    #[tokio::test]
    async fn a_failing_pass_falls_back_to_local_text_not_empty() {
        let local_pipeline_text = "ship it tomorrow".to_string();
        let failing_pass = async { Err::<String, String>("provider rejected the request".into()) };

        let raced = tokio::time::timeout(Duration::from_millis(50), failing_pass).await;
        let attempt = match raced {
            Ok(Ok(text)) => crate::dictation_timing::DictationFormatAttempt::Applied(text),
            Ok(Err(_)) => crate::dictation_timing::DictationFormatAttempt::Failed,
            Err(_) => crate::dictation_timing::DictationFormatAttempt::TimedOut,
        };
        let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
            attempt,
            &local_pipeline_text,
        );

        assert_eq!(
            fallback.format_outcome,
            crate::dictation_timing::DictationFormatOutcome::Failed
        );
        assert_eq!(fallback.final_text, local_pipeline_text);
        assert!(!fallback.final_text.is_empty());
        assert!(fallback.warn_failed);
        assert!(!fallback.warn_timed_out);
    }

    #[tokio::test]
    async fn a_pass_that_returns_in_time_is_applied_verbatim() {
        let local_pipeline_text = "ship it tomorrow".to_string();
        let fast_pass = async { Ok::<String, String>("Ship it tomorrow.".to_string()) };

        let raced = tokio::time::timeout(Duration::from_millis(50), fast_pass).await;
        let attempt = match raced {
            Ok(Ok(text)) => crate::dictation_timing::DictationFormatAttempt::Applied(text),
            Ok(Err(_)) => crate::dictation_timing::DictationFormatAttempt::Failed,
            Err(_) => crate::dictation_timing::DictationFormatAttempt::TimedOut,
        };
        let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
            attempt,
            &local_pipeline_text,
        );

        assert_eq!(
            fallback.format_outcome,
            crate::dictation_timing::DictationFormatOutcome::Applied
        );
        assert_eq!(fallback.final_text, "Ship it tomorrow.");
        assert!(!fallback.warn_timed_out);
        assert!(!fallback.warn_failed);
    }

    #[test]
    fn benchmark_capture_tail_constant_matches_the_documented_value() {
        // `benchmark-latency.rs`'s `CAPTURE_TAIL_EXCLUDED_MS` is a hardcoded
        // copy of this constant -- it lives in an external bin that cannot
        // see `audio`'s `pub(crate)` items, so it cannot reference this
        // value directly. This pins the real constant so a future change
        // here is caught instead of silently making that copy (and the
        // receipt field it feeds) wrong.
        assert_eq!(crate::audio::DICTATION_STOP_CAPTURE_TAIL_MS, 120);
    }
}

#[cfg(target_os = "macos")]
const HOTKEY_TARGET_MAX_AGE_MS: i64 = 5_000;
#[cfg(target_os = "macos")]
const LAST_EXTERNAL_TARGET_MAX_AGE_MS: i64 = 120_000;
#[cfg(target_os = "macos")]
const MEETING_CONSENT_TARGET_MAX_AGE_MS: i64 = 12_000;
const DICTATION_COMMAND_PREFIX_DEFAULT: &str = "command";
const APP_BUNDLE_IDENTIFIER: &str = "com.plainsong.app";
pub const SYSTEM_AUDIO_TEST_WORKER_ARGUMENT: &str = "--plainsong-system-audio-test-worker";
pub const SYSTEM_AUDIO_TEST_WORKER_TIMEOUT_EXIT_CODE: i32 = 124;
/// Seconds at the end of an accumulated post-capture chunk searched, backwards,
/// for a pause to cut at instead of cutting at the nominal frame count.
const CHUNK_CUT_SEARCH_SECONDS: f64 = 8.0;
/// Shortest pause worth cutting a chunk boundary into.
///
/// Measured against real speech rather than picked to match the live path's
/// 0.3s hysteresis: inter-sentence pauses in the 44s speech fixture top out
/// around 0.32s, so anything at or above that finds no boundary at all in
/// ordinary conversation and silently falls back to the fixed cut. 0.2s is
/// comfortably longer than a stop-consonant closure (50-100ms), so a run this
/// long is a real pause and not the gap inside a word.
const CHUNK_CUT_SILENCE_SECONDS: f64 = 0.2;
/// Analysis frame for the chunk-boundary search.
const CHUNK_CUT_FRAME_SECONDS: f64 = 0.02;
/// How far below a chunk's own speech level a frame must sit to count as a
/// pause. Relative rather than absolute so a loud room and a quiet one both get
/// a usable boundary.
const CHUNK_CUT_SILENCE_DROP_DB: f32 = 25.0;
/// Floor under the relative threshold, so a chunk that is quiet throughout does
/// not end up with a threshold so low that nothing ever qualifies.
const CHUNK_CUT_ABSOLUTE_SILENCE_DB: f32 = -55.0;
const VAULT_DB_KEY_SECRET: &str = "vault_db_key";
const VAULT_UNLOCK_CHECK_SECRET: &str = "vault_unlock_check";
const VAULT_RECORDING_KEY_SALT_LEN: usize = 16;
const VAULT_UNLOCK_CHECK_PLAINTEXT: &[u8] = b"nautilus-vault-check";
/// Canonical registry for every provider credential accepted by the sidecar.
/// Reset and provider-name validation share it so adding a credential cannot
/// leave a second cleanup list stale.
const PROVIDER_SECRET_NAMES: [&str; 10] = [
    "openai",
    "elevenlabs",
    "deepgram",
    "anthropic",
    "groq",
    "gemini",
    "deepseek",
    "ollama-cloud",
    "mistral",
    "cohere",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationSessionState {
    Idle,
    Starting,
    Primed,
    Recording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationModelWarmState {
    Ready,
    Deferred,
    NotRequired,
}

impl DictationModelWarmState {
    fn as_event_value(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Deferred => "deferred",
            Self::NotRequired => "not_required",
        }
    }
}

/// What dictation does with the finished text.
///
/// There used to be four values. `auto`, `paste` and `inline` all called
/// `paste_text_systemwide` with identical arguments, and `inline` then rewrote
/// itself to `paste` in telemetry — three names for one behavior. Only
/// clipboard-only ever did anything different, so the choice is now the two
/// things that actually differ; legacy values migrate onto `auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationInsertionMode {
    Auto,
    ClipboardOnly,
}

impl DictationInsertionMode {
    fn from_settings_value(value: &str) -> Self {
        match value {
            "clipboard_only" => Self::ClipboardOnly,
            _ => Self::Auto,
        }
    }

    fn as_settings_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::ClipboardOnly => "clipboard_only",
        }
    }
}

fn dictation_cursor_insert_required(mode: &str) -> bool {
    !matches!(
        DictationInsertionMode::from_settings_value(mode),
        DictationInsertionMode::ClipboardOnly
    )
}

fn dictation_cursor_insert_ready(mode: &str, permissions: &PermissionDiagnostics) -> bool {
    !dictation_cursor_insert_required(mode) || permissions.cursor_insertion_ready
}

fn describe_dictation_cursor_insert_status(
    mode: &str,
    permissions: &PermissionDiagnostics,
) -> &'static str {
    if !dictation_cursor_insert_required(mode) {
        "not needed (clipboard only)"
    } else if dictation_cursor_insert_ready(mode, permissions) && !permissions.accessibility_ready {
        "ready via keyboard fallback"
    } else if dictation_cursor_insert_ready(mode, permissions) {
        "ready"
    } else {
        "needs access"
    }
}

type DictationCommandAction = crate::dictation_parity::DictationCommandAction;
use crate::dictation_parity::apply_contextual_phrase_replacement;

#[derive(Debug, Clone, Copy, Default)]
struct DictationSessionTracker {
    next_session_id: u64,
    active_session_id: Option<u64>,
    started_at: Option<std::time::Instant>,
    started_at_epoch_ms: Option<i64>,
    startup_latency_ms: Option<u64>,
    acknowledged_at_epoch_ms: Option<i64>,
    capture_ready_at_epoch_ms: Option<i64>,
    first_stable_partial_at_epoch_ms: Option<i64>,
    stop_requested_at: Option<std::time::Instant>,
    final_transcript_at_epoch_ms: Option<i64>,
    insertion_completed_at_epoch_ms: Option<i64>,
    insertion_mode_at_start: Option<DictationInsertionMode>,
    copy_to_clipboard_at_start: Option<bool>,
    /// Set by the one stop that owns finalization for this session. Manual,
    /// VAD, popup, and hotkey stops are separate callers, so two of them could
    /// otherwise read the same active id, both proceed into audio finalization,
    /// and the loser would clear the tracker out from under the winner —
    /// discarding a dictation the user had already spoken.
    stopping_session_id: Option<u64>,
}

#[derive(Debug, Clone)]
struct RecentDictationDelivery {
    text: String,
    app_target: Option<String>,
    app_bundle_id: Option<String>,
    delivered_at: chrono::DateTime<chrono::Utc>,
}

const RECENT_DICTATION_DELIVERY_WINDOW_SECS: i64 = 45;

/// One completed dictation result, kept so the user can re-paste or re-copy it
/// after a failed or mis-targeted insertion.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentDictationResult {
    text: String,
    app_target: Option<String>,
    app_bundle_id: Option<String>,
    at_ms: i64,
}

/// How many results the recovery list keeps. Three is what fits in a menu-bar
/// menu without turning it into a history browser (the full history lives in
/// the app).
const RECENT_DICTATION_RESULT_LIMIT: usize = 3;

type AnalysisContextSegment = llm::GroundedSegment;

const MAX_ANALYSIS_RECORDING_IDS: usize = 64;
const MAX_ANALYSIS_SEGMENTS: usize = 100_000;

fn validate_and_deduplicate_analysis_recording_ids(
    recording_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    if recording_ids.is_empty() {
        return Err("recordingIds cannot be empty".to_string());
    }
    if recording_ids.len() > MAX_ANALYSIS_RECORDING_IDS {
        return Err(format!(
            "Analyze at most {} recordings at once",
            MAX_ANALYSIS_RECORDING_IDS
        ));
    }

    let mut seen = HashSet::with_capacity(recording_ids.len());
    let mut unique = Vec::with_capacity(recording_ids.len());
    for recording_id in recording_ids {
        if recording_id.trim().is_empty() {
            return Err("recordingIds cannot contain blank IDs".to_string());
        }
        if seen.insert(recording_id.clone()) {
            unique.push(recording_id);
        }
    }
    Ok(unique)
}

fn enforce_multi_recording_analysis_limits(
    segment_count: usize,
    transcript_bytes: usize,
) -> Result<(), String> {
    if segment_count > MAX_ANALYSIS_SEGMENTS {
        return Err(format!(
            "Selected transcripts contain too many segments (maximum {})",
            MAX_ANALYSIS_SEGMENTS
        ));
    }
    if transcript_bytes > llm::grounded::MAX_ANALYSIS_TRANSCRIPT_BYTES {
        return Err(format!(
            "Selected transcripts are too large for bounded analysis (maximum {} MiB)",
            llm::grounded::MAX_ANALYSIS_TRANSCRIPT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod multi_recording_analysis_bounds_tests {
    use super::*;

    #[test]
    fn recording_id_input_is_capped_before_database_access() {
        let ids = (0..=MAX_ANALYSIS_RECORDING_IDS)
            .map(|index| format!("recording-{index}"))
            .collect();
        let error = validate_and_deduplicate_analysis_recording_ids(ids)
            .expect_err("oversized recording selection must fail");
        assert!(error.contains("at most"));
    }

    #[test]
    fn duplicate_recording_ids_are_removed_without_reordering() {
        let ids = vec!["a".to_string(), "b".to_string(), "a".to_string()];
        assert_eq!(
            validate_and_deduplicate_analysis_recording_ids(ids).expect("valid ids"),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn aggregate_segment_and_text_limits_fail_closed() {
        assert!(enforce_multi_recording_analysis_limits(
            MAX_ANALYSIS_SEGMENTS + 1,
            llm::grounded::MAX_ANALYSIS_TRANSCRIPT_BYTES
        )
        .is_err());
        assert!(enforce_multi_recording_analysis_limits(
            MAX_ANALYSIS_SEGMENTS,
            llm::grounded::MAX_ANALYSIS_TRANSCRIPT_BYTES + 1
        )
        .is_err());
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RecordingAnalysisSnapshot {
    transcript_revision: i64,
    /// The notes exactly as stored, so `verify_analysis_snapshot` can tell
    /// whether the reader edited them while analysis ran. NOT the composed
    /// notes handed to the model -- see `compose_analysis_notes`.
    meeting_notes: Option<String>,
    notes_updated_at: Option<chrono::DateTime<chrono::Utc>>,
    meeting_template_id: Option<String>,
    expected_summary: Option<String>,
    expected_action_items: Option<Vec<String>>,
    custom_summary_prompt: Option<String>,
    /// Names only. Part of the input the model actually saw, so a change to
    /// the attendee list has to change the fingerprint -- otherwise a stored
    /// summary would claim provenance over an input it was not produced from.
    attendee_names: Vec<String>,
}

fn analysis_input_fingerprint(snapshot: &RecordingAnalysisSnapshot, instruction: &str) -> String {
    let canonical = serde_json::json!({
        "transcriptRevision": snapshot.transcript_revision,
        "meetingNotes": &snapshot.meeting_notes,
        "notesUpdatedAt": snapshot.notes_updated_at.as_ref(),
        "meetingTemplateId": &snapshot.meeting_template_id,
        "attendeeNames": &snapshot.attendee_names,
        "instruction": instruction,
    });
    models::analysis_content_hash(&canonical.to_string())
}

/// The supplemental, non-citable block handed to a grounded run: the meeting
/// notes, with an "Attendees:" line in front of them when the meeting has
/// one.
///
/// It goes in the NOTES slot deliberately. `grounded.rs` wraps that slot in
/// `<notes_data non_citable="true">` and the system prompt already says
/// everything inside it is untrusted data and never instructions -- so an
/// attendee whose calendar display name is "ignore previous instructions"
/// arrives fenced, exactly like a transcript line, and cannot be cited as
/// evidence for a claim.
///
/// Names only. `models::attendee_names_for_context` is what drops the
/// addresses, and it is the only path from an attendee list into a prompt.
fn compose_analysis_notes(
    meeting_notes: Option<&str>,
    attendee_names: &[String],
) -> Option<String> {
    let notes = meeting_notes
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if attendee_names.is_empty() {
        return notes.map(str::to_string);
    }
    let attendee_line = format!("Attendees: {}", attendee_names.join(", "));
    Some(match notes {
        Some(notes) => format!("{}\n\n{}", attendee_line, notes),
        None => attendee_line,
    })
}

struct RelationshipMemorySource {
    recording: models::Recording,
    transcript: Option<models::Transcript>,
    speaker_aliases: HashMap<String, db::SpeakerAlias>,
}

#[derive(Default)]
struct RelationshipProfileAccumulator {
    name: String,
    recording_ids: HashSet<String>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
    related_entities: HashSet<String>,
    recent_meetings: Vec<models::RelationshipMemoryEvidence>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedSummaryResult {
    summary: String,
    citations: Vec<llm::Citation>,
    actual_provider: String,
    model: String,
    processing_time_ms: u64,
    /// False when the model's citations could not be verified against the
    /// transcript and the summary is returned uncited instead of discarded.
    grounded: bool,
    provenance: models::AnalysisProvenance,
    #[serde(skip)]
    snapshot: RecordingAnalysisSnapshot,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedActionItem {
    task: String,
    assignee: Option<String>,
    deadline: Option<String>,
    citations: Vec<llm::Citation>,
    grounded: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedActionItemsResult {
    items: Vec<GroundedActionItem>,
    actual_provider: String,
    model: String,
    processing_time_ms: u64,
    grounded: bool,
    provenance: models::ActionItemsProvenance,
    #[serde(skip)]
    snapshot: RecordingAnalysisSnapshot,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupVerificationResult {
    ok: bool,
    title: String,
    summary: String,
    details: Vec<String>,
}

/// What the start sheet shows beside the consent notice: which meeting app
/// Plainsong saw in front (if any) and the instruction to send the notice
/// there. Plainsong never posts the notice itself, so there is no mode or
/// "can automate" flag to report.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingConsentNoticeStatus {
    surface: Option<String>,
    app_name: Option<String>,
    app_bundle_id: Option<String>,
    browser_url: Option<String>,
    message: String,
    notice_text: String,
}

/// The only consent-notice mode a meeting can carry. The notice is shown and
/// copyable; sending it is always the user's action.
const MEETING_CONSENT_NOTICE_MODE_MANUAL: &str = "manual_required";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationOverlayState {
    phase: String,
    dismissed: bool,
    started_at_ms: Option<i64>,
    message: Option<String>,
    preview: Option<String>,
    partial_text: Option<String>,
    session_id: Option<u64>,
    stop_reason: Option<String>,
    outcome: Option<String>,
    resolved_mode_preset: Option<String>,
    resolved_custom_mode_id: Option<String>,
    resolved_mode_label: Option<String>,
    context_source: Option<String>,
    insertion_mode: Option<String>,
    app_target: Option<String>,
    activation_matcher: Option<String>,
    dictation_provider: Option<String>,
    dictation_model_id: Option<String>,
    requested_provider: Option<String>,
    actual_provider: Option<String>,
    requested_model_id: Option<String>,
    actual_model_id: Option<String>,
    fallback_reason: Option<String>,
    target_app: Option<String>,
    requested_route: Option<String>,
    resolved_route: Option<String>,
    provider_model_label: Option<String>,
    dictation_route_preference: Option<String>,
    dictation_resolved_hosting: Option<String>,
    model_readiness: Option<String>,
    capture_ready: bool,
}

impl Default for DictationOverlayState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            dismissed: false,
            started_at_ms: None,
            message: None,
            preview: None,
            partial_text: None,
            session_id: None,
            stop_reason: None,
            outcome: None,
            resolved_mode_preset: None,
            resolved_custom_mode_id: None,
            resolved_mode_label: None,
            context_source: None,
            insertion_mode: None,
            app_target: None,
            activation_matcher: None,
            dictation_provider: None,
            dictation_model_id: None,
            requested_provider: None,
            actual_provider: None,
            requested_model_id: None,
            actual_model_id: None,
            fallback_reason: None,
            target_app: None,
            requested_route: None,
            resolved_route: None,
            provider_model_label: None,
            dictation_route_preference: None,
            dictation_resolved_hosting: None,
            model_readiness: None,
            capture_ready: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingOverlayState {
    phase: String,
    dismissed: bool,
    recording_id: Option<String>,
    started_at_ms: Option<i64>,
    system_audio_active: Option<bool>,
    consent_prompt_shown: Option<bool>,
    message: Option<String>,
    /// Pause state, mirrored from the capture session so a renderer that
    /// hydrates from this snapshot can freeze its clock at the right second.
    paused: bool,
    closed_paused_ms: i64,
    pause_started_at_ms: Option<i64>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct PendingDictationTarget {
    app_name: Option<String>,
    app_bundle_id: Option<String>,
    browser_url: Option<String>,
    captured_at_ms: i64,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFrontmostApplication {
    name: Option<String>,
    bundle_id: Option<String>,
}

impl Default for RecordingOverlayState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            dismissed: false,
            recording_id: None,
            started_at_ms: None,
            system_audio_active: None,
            consent_prompt_shown: None,
            message: None,
            paused: false,
            closed_paused_ms: 0,
            pause_started_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionDiagnostics {
    microphone_ready: bool,
    microphone_permission_ready: bool,
    speech_recognition_ready: bool,
    accessibility_ready: bool,
    accessibility_trusted: bool,
    post_event_ready: bool,
    automation_ready: bool,
    cursor_insertion_ready: bool,
    cursor_insertion_observed: bool,
    preferred_insert_strategy: Option<CursorInsertStrategy>,
    available_insert_strategies: Vec<CursorInsertStrategy>,
    last_cursor_insert_status: Option<CursorInsertStatus>,
    running_from_disk_image: bool,
    app_bundle_path: Option<String>,
    recommended_app_bundle_path: Option<String>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CursorInsertStrategy {
    AccessibilityDirectText,
    SimulatedTyping,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorInsertStatus {
    succeeded: bool,
    copied_only: bool,
    successful_strategy: Option<CursorInsertStrategy>,
    attempted_strategies: Vec<CursorInsertStrategy>,
    message: Option<String>,
    observed_at_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelRepairReport {
    repaired_count: usize,
    removed_paths: Vec<String>,
    notes: Vec<String>,
}

type AnalysisProvider = llm::Provider;

#[derive(Debug, Default)]
struct VaultRuntimeState {
    unlocked: bool,
    db_encrypted: bool,
    recording_key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityStatus {
    vault_initialized: bool,
    vault_unlocked: bool,
    database_encrypted: bool,
    /// True only when every stored recording file is encrypted on disk.
    recordings_encrypted: bool,
    /// How many stored recording files are encrypted, and how many there are.
    /// Capture always writes a plain WAV, so a vault that was initialized
    /// months ago says nothing about what was recorded since.
    recordings_encrypted_count: i64,
    recordings_stored_count: i64,
    llm_provider: String,
    remote_processing_enabled: bool,
    export_root: Option<String>,
}

fn dictation_history_details_from_audit(
    details: &serde_json::Value,
) -> models::DictationHistoryDetails {
    models::DictationHistoryDetails {
        mode_preset: details
            .get("dictation_mode_preset")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        mode_label: details
            .get("dictation_mode_label")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        base_mode_preset: details
            .get("dictation_base_mode_preset")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        base_mode_label: details
            .get("dictation_base_mode_label")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        custom_mode_id: details
            .get("dictation_custom_mode_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        custom_mode_name: details
            .get("dictation_custom_mode_name")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        context_source: details
            .get("context_source")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        context_app_name: details
            .get("context_app_name")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        app_target: details
            .get("app_target")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        activation_matcher: details
            .get("activation_matcher")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        command_applied: details
            .get("command_applied")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        dictionary_applied_count: details
            .get("dictionary_applied_count")
            .and_then(|value| value.as_u64()),
        snippet_applied_count: details
            .get("snippet_applied_count")
            .and_then(|value| value.as_u64()),
        formatting_applied: details
            .get("formatting_applied")
            .and_then(|value| value.as_bool()),
        recent_insert_reused: details
            .get("recent_insert_reused")
            .and_then(|value| value.as_bool()),
        pipeline_stage_keys: details
            .get("pipeline_stage_keys")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        prompt_source: details
            .get("prompt_source")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        prompt_preview: details
            .get("prompt_preview")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        requested_provider: details
            .get("requested_provider")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        actual_provider: details
            .get("actual_provider")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        model_id: details
            .get("model_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        route_preference: details
            .get("route_preference")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        resolved_hosting: details
            .get("resolved_hosting")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        startup_latency_ms: details
            .get("startup_latency_ms")
            .and_then(|value| value.as_u64()),
        transcription_latency_ms: details
            .get("transcription_latency_ms")
            .and_then(|value| value.as_u64()),
        insert_latency_ms: details
            .get("insert_latency_ms")
            .and_then(|value| value.as_u64()),
        end_to_end_ms: details
            .get("end_to_end_ms")
            .and_then(|value| value.as_u64()),
        detected_language: details
            .get("detected_language")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        translation_route: details
            .get("translation_route")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        translation_applied: details
            .get("translation_applied")
            .and_then(|value| value.as_bool()),
        // Filled from the history text row and the recording, not the audit
        // log: see `enrich_dictation_history_details`.
        raw_transcript: None,
        audio_available: None,
        reprocessed_from_id: None,
        reprocessed_from_created_at: None,
    }
}

/// Adds what the audit log never carries: the raw transcript, whether the
/// captured audio is still on disk, and the "Process again" lineage.
fn enrich_dictation_history_details(
    mut details: models::DictationHistoryDetails,
    history_text: Option<&crate::store::DictationHistoryTextRecord>,
    recording: Option<&models::Recording>,
    reprocessed_from: Option<&models::Recording>,
) -> models::DictationHistoryDetails {
    if let Some(text) = history_text {
        // Older rows were backfilled with the delivered text on both sides;
        // reporting that as "heard" would claim a raw transcript that was
        // never kept.
        if !text.raw_text.trim().is_empty() && text.raw_text != text.final_text {
            details.raw_transcript = Some(text.raw_text.clone());
        }
        details.reprocessed_from_id = text.reprocessed_from_id.clone();
        if details.mode_preset.is_none() {
            details.mode_preset = text.mode_preset.clone();
        }
    }
    if let Some(recording) = recording {
        details.audio_available = if recording.audio_path.trim().is_empty() {
            None
        } else {
            Some(Path::new(&recording.audio_path).is_file())
        };
    }
    details.reprocessed_from_created_at = reprocessed_from.map(|source| source.created_at);
    details
}

fn merge_dictation_history_details(
    mut details: models::DictationHistoryDetails,
    transcript_artifact: Option<&TranscriptArtifactRecord>,
    insertion_action: Option<&InsertionActionRecord>,
) -> models::DictationHistoryDetails {
    if let Some(artifact) = transcript_artifact {
        details.requested_provider = artifact.requested_provider.clone();
        details.actual_provider = artifact.actual_provider.clone();
        details.model_id = artifact.model_id.clone();
        details.startup_latency_ms = artifact.startup_latency_ms.map(|value| value as u64);
        details.transcription_latency_ms =
            artifact.transcription_latency_ms.map(|value| value as u64);
        details.insert_latency_ms = artifact.insert_latency_ms.map(|value| value as u64);
        details.end_to_end_ms = artifact.end_to_end_ms.map(|value| value as u64);
    }

    if let Some(action) = insertion_action {
        if action.app_target.is_some() {
            details.app_target = action.app_target.clone();
        }
        if action.command_applied.is_some() {
            details.command_applied = action.command_applied.clone();
        }
        details.snippet_applied_count = Some(action.snippet_applied_count as u64);
    }

    details
}

fn dictation_history_details_is_empty(details: &models::DictationHistoryDetails) -> bool {
    details.mode_preset.is_none()
        && details.mode_label.is_none()
        && details.base_mode_preset.is_none()
        && details.base_mode_label.is_none()
        && details.custom_mode_id.is_none()
        && details.custom_mode_name.is_none()
        && details.context_source.is_none()
        && details.context_app_name.is_none()
        && details.app_target.is_none()
        && details.activation_matcher.is_none()
        && details.command_applied.is_none()
        && details.dictionary_applied_count.is_none()
        && details.snippet_applied_count.is_none()
        && details.formatting_applied.is_none()
        && details.recent_insert_reused.is_none()
        && details.pipeline_stage_keys.is_empty()
        && details.prompt_source.is_none()
        && details.prompt_preview.is_none()
        && details.requested_provider.is_none()
        && details.actual_provider.is_none()
        && details.model_id.is_none()
        && details.route_preference.is_none()
        && details.resolved_hosting.is_none()
        && details.raw_transcript.is_none()
        && details.audio_available.is_none()
        && details.reprocessed_from_id.is_none()
        && details.reprocessed_from_created_at.is_none()
        && details.startup_latency_ms.is_none()
        && details.transcription_latency_ms.is_none()
        && details.insert_latency_ms.is_none()
        && details.end_to_end_ms.is_none()
        && details.detected_language.is_none()
        && details.translation_route.is_none()
        && details.translation_applied.is_none()
}

fn build_meeting_transcript_details(
    transcript: Option<&models::Transcript>,
    transcript_artifact: Option<&TranscriptArtifactRecord>,
    diarizer: Option<String>,
) -> Option<models::MeetingTranscriptDetails> {
    if transcript.is_none() && transcript_artifact.is_none() {
        return None;
    }

    let segments = transcript
        .map(|value| value.segments.as_slice())
        .unwrap_or(&[]);
    let has_source_aware_speakers = transcript_has_source_aware_speakers(segments);
    let has_speaker_labels = segments.iter().any(|segment| {
        segment
            .speaker_id
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    });
    let source_mode = if has_source_aware_speakers {
        "me_them"
    } else if has_speaker_labels {
        "speaker_labels"
    } else if transcript.is_some() {
        "single_source"
    } else {
        "unknown"
    };
    let segment_count = transcript_artifact
        .map(|artifact| artifact.segment_count.max(0) as u64)
        .unwrap_or_else(|| segments.len() as u64);

    Some(models::MeetingTranscriptDetails {
        segment_count,
        model: transcript.map(|value| value.model.clone()),
        model_id: transcript_artifact
            .and_then(|artifact| artifact.model_id.clone())
            .or_else(|| transcript.and_then(|value| value.model_id.clone())),
        requested_provider: transcript_artifact
            .and_then(|artifact| artifact.requested_provider.clone())
            .or_else(|| transcript.and_then(|value| value.requested_provider.clone())),
        actual_provider: transcript_artifact
            .and_then(|artifact| artifact.actual_provider.clone())
            .or_else(|| transcript.and_then(|value| value.actual_provider.clone())),
        quality_score: transcript_artifact.and_then(|artifact| artifact.quality_score),
        transcription_latency_ms: transcript_artifact
            .and_then(|artifact| artifact.transcription_latency_ms.map(|value| value as u64)),
        source_mode: source_mode.to_string(),
        has_source_aware_speakers,
        has_speaker_labels,
        // A source-aware capture labelled itself; no diarizer was involved and
        // none is named.
        diarizer: if has_source_aware_speakers {
            None
        } else {
            diarizer
        },
    })
}

// Settings commands

// VAD and noise suppression commands

// Export template commands

// Waveform commands

// Intelligent punctuation command

async fn ensure_asr_route_ready(
    state: &AppState,
    provider_type: asr::AsrProviderType,
    model_id: &str,
    context: &str,
) -> Result<(), String> {
    let (effective_provider, effective_model_id, mlx_accelerated) = state
        .asr_manager
        .resolve_effective_provider_and_model(provider_type, model_id)
        .await;
    if provider_type == asr::AsrProviderType::Moonshine
        && effective_provider == asr::AsrProviderType::Moonshine
    {
        return Err(
            "Moonshine native ONNX inference is not launch-ready in this build. Choose a stable local dictation route such as Whisper, MLX Audio, or Apple Native Speech."
                .to_string(),
        );
    }
    let diagnostics = state
        .asr_manager
        .get_runtime_diagnostics(provider_type)
        .await;
    let provider_available = asr::AsrProviderFactory::create_with_model(
        effective_provider,
        Some(effective_model_id.as_str()),
    )
    .is_available();

    if matches!(
        diagnostics.runtime_status,
        asr::manager::RuntimeStatus::Ready
    ) && provider_available
    {
        return Ok(());
    }

    let runtime_message = diagnostics
        .runtime_message
        .unwrap_or_else(|| "Runtime is not ready for the selected provider/model.".to_string());
    let setup_action = diagnostics.runtime_details.setup_action.unwrap_or_else(|| {
        "Open Settings -> ASR Models and complete the required runtime/model setup.".to_string()
    });
    Err(format!(
        "ASR route '{} / {}{}' is not ready for {}. {} {}",
        provider_type.display_name(),
        model_id,
        if mlx_accelerated { " via MLX" } else { "" },
        context,
        runtime_message,
        setup_action
    ))
}

async fn persist_repaired_meeting_route(
    state: &AppState,
    provider_type: asr::AsrProviderType,
    model_id: &str,
) -> Result<String, String> {
    state
        .asr_manager
        .set_provider_model_id(provider_type, model_id.to_string())
        .await;
    let normalized_model_id = state.asr_manager.provider_model_id(provider_type).await;
    let provider_key = asr_provider_to_settings_value(provider_type).to_string();

    let mut settings_manager = state.settings_manager.lock().await;
    let transcription = &mut settings_manager.settings_mut().transcription;

    if transcription.use_shared_asr_selection {
        transcription.use_shared_asr_selection = false;
        transcription.dictation_provider = transcription.default_provider.clone();
        transcription.dictation_model_id = transcription.selected_model_id.clone();
    }

    transcription
        .provider_model_ids
        .insert(provider_key.clone(), normalized_model_id.clone());
    transcription.meeting_provider = provider_key;
    transcription.meeting_model_id = normalized_model_id.clone();
    normalize_contextual_asr_settings(transcription);
    settings_manager.save().map_err(|e| e.to_string())?;

    Ok(normalized_model_id)
}

async fn resolve_ready_meeting_selection(
    state: &AppState,
    transcription: &settings::TranscriptionSettings,
    remote_processing_enabled: bool,
) -> Result<(asr::AsrProviderType, String, Option<String>), String> {
    let requested_selection =
        resolve_transcription_provider_and_model(transcription, TranscriptionScope::Meeting);

    ensure_meeting_route_supported(requested_selection.0, &requested_selection.1)?;
    enforce_remote_asr_provider_policy(requested_selection.0, remote_processing_enabled)?;

    match ensure_asr_route_ready(
        state,
        requested_selection.0,
        &requested_selection.1,
        "meeting transcription",
    )
    .await
    {
        Ok(()) => Ok((requested_selection.0, requested_selection.1, None)),
        Err(requested_error) => {
            let meeting_policy =
                meeting_route_policy_from_settings(&transcription.meeting_route_policy);
            let default_provider =
                asr_provider_from_settings_value(&transcription.default_provider)
                    .unwrap_or(asr::AsrProviderType::Whisper);
            let dictation_provider =
                asr_provider_from_settings_value(&transcription.dictation_provider)
                    .unwrap_or(default_provider);
            let meeting_provider =
                asr_provider_from_settings_value(&transcription.meeting_provider);

            let provider_infos = state
                .asr_manager
                .get_all_providers_info()
                .await
                .unwrap_or_default();

            let preferred_candidates = preferred_meeting_provider_candidates(
                meeting_policy,
                default_provider,
                dictation_provider,
                meeting_provider,
                Some(transcription.meeting_model_id.as_str()),
            );
            let repaired_candidate = select_ready_meeting_candidate(
                &provider_infos,
                &preferred_candidates,
                meeting_policy,
            );

            if let Some((provider_type, model_id)) = repaired_candidate {
                enforce_remote_asr_provider_policy(provider_type, remote_processing_enabled)?;
                if provider_type != requested_selection.0 || model_id != requested_selection.1 {
                    let persisted_model_id =
                        persist_repaired_meeting_route(state, provider_type, &model_id).await?;
                    let warning = format!(
                        "Meeting route '{}' / '{}' was not ready. Switched meetings to '{}' / '{}'.",
                        requested_selection.0.display_name(),
                        requested_selection.1,
                        provider_type.display_name(),
                        persisted_model_id
                    );
                    return Ok((provider_type, persisted_model_id, Some(warning)));
                }

                return Ok((provider_type, model_id, None));
            }

            Err(format!(
                "No meeting-capable ASR route is ready. {} Open Settings -> Storage -> Guided setup -> Set up meetings, or download a meeting model in Settings -> ASR / Providers.",
                requested_error
            ))
        }
    }
}

async fn resolve_ready_dictation_selection(
    state: &AppState,
    transcription: &settings::TranscriptionSettings,
    route_override: Option<&str>,
    remote_processing_enabled: bool,
) -> Result<
    (
        asr::AsrProviderType,
        String,
        DictationRoutePreference,
        HostingEnvironment,
        Option<String>,
    ),
    String,
> {
    let requested_selection =
        resolve_transcription_provider_and_model(transcription, TranscriptionScope::Dictation);
    let route_preference = dictation_route_preference_from_option(
        route_override,
        &transcription.dictation_route_preference,
    );
    let requested_hosting =
        provider_hosting_environment(requested_selection.0, &requested_selection.1);

    if route_matches_hosting(
        route_preference,
        requested_selection.0,
        &requested_selection.1,
    ) {
        enforce_remote_asr_provider_policy(requested_selection.0, remote_processing_enabled)?;
        match ensure_asr_route_ready(
            state,
            requested_selection.0,
            &requested_selection.1,
            "dictation",
        )
        .await
        {
            Ok(()) => {
                return Ok((
                    requested_selection.0,
                    requested_selection.1,
                    route_preference,
                    requested_hosting,
                    None,
                ))
            }
            Err(requested_error) => {
                if !provider_allows_automatic_dictation_fallback(requested_selection.0) {
                    return Err(format!(
                        "Apple Speech is selected for dictation but is not ready. {} Plainsong will not substitute Whisper or another provider. Complete the Apple Speech setup or choose a different dictation route in Settings.",
                        requested_error
                    ));
                }

                if let Some(model_id) = preferred_same_provider_dictation_fallback_model(
                    requested_selection.0,
                    &requested_selection.1,
                    route_preference,
                    state.asr_manager.models_dir(),
                ) {
                    let resolved_hosting =
                        provider_hosting_environment(requested_selection.0, &model_id);
                    let warning = format!(
                        "Dictation route '{}' / '{}' was not ready. Using '{}' / '{}' for this capture.",
                        requested_selection.0.display_name(),
                        requested_selection.1,
                        requested_selection.0.display_name(),
                        model_id
                    );
                    return Ok((
                        requested_selection.0,
                        model_id,
                        route_preference,
                        resolved_hosting,
                        Some(warning),
                    ));
                }

                let default_provider =
                    asr_provider_from_settings_value(&transcription.default_provider)
                        .unwrap_or(asr::AsrProviderType::Whisper);
                let dictation_provider =
                    asr_provider_from_settings_value(&transcription.dictation_provider)
                        .unwrap_or(default_provider);
                let provider_infos = state
                    .asr_manager
                    .get_all_providers_info()
                    .await
                    .unwrap_or_default();
                let preferred_candidates = preferred_dictation_provider_candidates(
                    route_preference,
                    default_provider,
                    dictation_provider,
                );
                if let Some((provider_type, model_id)) = select_ready_dictation_candidate(
                    &provider_infos,
                    &preferred_candidates,
                    route_preference,
                ) {
                    enforce_remote_asr_provider_policy(provider_type, remote_processing_enabled)?;
                    let resolved_hosting = provider_hosting_environment(provider_type, &model_id);
                    let warning = format!(
                        "Dictation route '{}' / '{}' was not ready. Using '{}' / '{}' for this capture.",
                        requested_selection.0.display_name(),
                        requested_selection.1,
                        provider_type.display_name(),
                        model_id
                    );
                    return Ok((
                        provider_type,
                        model_id,
                        route_preference,
                        resolved_hosting,
                        Some(warning),
                    ));
                }

                return Err(format!(
                    "No {} dictation route is ready. {} Open Settings -> Setup and prepare a {} dictation route.",
                    dictation_route_preference_to_settings_value(route_preference),
                    requested_error,
                    dictation_route_preference_to_settings_value(route_preference)
                ));
            }
        }
    }

    let default_provider = asr_provider_from_settings_value(&transcription.default_provider)
        .unwrap_or(asr::AsrProviderType::Whisper);
    let dictation_provider = asr_provider_from_settings_value(&transcription.dictation_provider)
        .unwrap_or(default_provider);
    let provider_infos = state
        .asr_manager
        .get_all_providers_info()
        .await
        .unwrap_or_default();
    let preferred_candidates = preferred_dictation_provider_candidates(
        route_preference,
        default_provider,
        dictation_provider,
    );
    if let Some((provider_type, model_id)) =
        select_ready_dictation_candidate(&provider_infos, &preferred_candidates, route_preference)
    {
        enforce_remote_asr_provider_policy(provider_type, remote_processing_enabled)?;
        let resolved_hosting = provider_hosting_environment(provider_type, &model_id);
        let warning = format!(
            "This dictation profile prefers {} routing. Using '{}' / '{}' instead of '{}' / '{}'.",
            dictation_route_preference_to_settings_value(route_preference),
            provider_type.display_name(),
            model_id,
            requested_selection.0.display_name(),
            requested_selection.1
        );
        return Ok((
            provider_type,
            model_id,
            route_preference,
            resolved_hosting,
            Some(warning),
        ));
    }

    Err(format!(
        "This dictation profile prefers {} routing, but no {} dictation engine is ready. Open Settings -> Storage -> Setup and prepare one.",
        dictation_route_preference_to_settings_value(route_preference),
        dictation_route_preference_to_settings_value(route_preference)
    ))
}

async fn active_dictation_session_id(state: &AppState) -> Option<u64> {
    state
        .dictation_session_tracker
        .lock()
        .await
        .active_session_id
}

async fn set_dictation_hotkey_flags(state: &AppState, active: bool, release_pending: bool) {
    {
        let mut hotkey_active = state.dictation_hotkey_active.lock().await;
        *hotkey_active = active;
    }
    state
        .dictation_release_pending
        .store(release_pending, Ordering::SeqCst);
}

#[allow(clippy::too_many_arguments)]
fn emit_recording_status(
    app: &impl crate::sidecar_handle::AppEmitter,
    recording_id: &str,
    status: &str,
    message: Option<&str>,
    progress: Option<f64>,
) {
    emit_recording_status_with_markers(
        app,
        recording_id,
        status,
        message,
        progress,
        None,
        None,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_recording_status_with_markers(
    app: &impl crate::sidecar_handle::AppEmitter,
    recording_id: &str,
    status: &str,
    message: Option<&str>,
    progress: Option<f64>,
    meeting_processing_started_at: Option<&str>,
    transcript_first_available_at: Option<&str>,
    consent_prompt_shown: Option<bool>,
) {
    let payload = RecordingStatusChangedEvent {
        recording_id: recording_id.to_string(),
        status: status.to_string(),
        message: message.map(str::to_string),
        progress,
        updated_at: chrono::Utc::now().to_rfc3339(),
        meeting_processing_started_at: meeting_processing_started_at.map(str::to_string),
        transcript_first_available_at: transcript_first_available_at.map(str::to_string),
        consent_prompt_shown,
    };
    app.emit_event("recording-status-changed", payload);
}

pub(crate) fn normalize_provider_secret_name(provider: &str) -> Result<&'static str, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    let canonical = match normalized.as_str() {
        "eleven_labs" => "elevenlabs",
        "ollama_cloud" | "ollamacloud" => "ollama-cloud",
        "ollama" => {
            return Err("Local Ollama does not require a stored API key".to_string());
        }
        other => other,
    };

    PROVIDER_SECRET_NAMES
        .iter()
        .copied()
        .find(|registered| *registered == canonical)
        .ok_or_else(|| {
            format!(
                "Unsupported provider '{}'. Expected one of: {}",
                provider,
                PROVIDER_SECRET_NAMES.join(", ")
            )
        })
}

fn clear_registered_provider_secrets_with<E>(
    mut clear: impl FnMut(&str) -> Result<(), E>,
) -> (Vec<String>, Vec<String>)
where
    E: std::fmt::Display,
{
    let mut cleared = Vec::new();
    let mut failed = Vec::new();
    for provider in PROVIDER_SECRET_NAMES {
        match clear(provider) {
            Ok(()) => cleared.push(provider.to_string()),
            Err(error) => failed.push(format!("{} ({})", provider, error)),
        }
    }
    (cleared, failed)
}

#[cfg(test)]
fn canonicalize_or_create_absolute_path(raw_path: &Path, label: &str) -> Result<PathBuf, String> {
    if !raw_path.is_absolute() {
        return Err(format!(
            "{} must be an absolute path, got '{}'",
            label,
            raw_path.display()
        ));
    }
    std::fs::create_dir_all(raw_path)
        .map_err(|error| format!("Failed to create {}: {}", label, error))?;
    raw_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {}", label, error))
}

fn canonicalize_absolute_path_without_creation(
    raw_path: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    if !raw_path.is_absolute() {
        return Err(format!(
            "{} must be an absolute path, got '{}'",
            label,
            raw_path.display()
        ));
    }

    if raw_path.exists() {
        return raw_path.canonicalize().map_err(|e| {
            format!(
                "Failed to resolve {} '{}': {}",
                label,
                raw_path.display(),
                e
            )
        });
    }

    let existing_ancestor = raw_path
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| {
            format!(
                "Failed to find an existing ancestor for {} '{}'",
                label,
                raw_path.display()
            )
        })?;
    let suffix = raw_path.strip_prefix(existing_ancestor).map_err(|e| {
        format!(
            "Failed to resolve {} '{}': {}",
            label,
            raw_path.display(),
            e
        )
    })?;
    let mut resolved = existing_ancestor.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve {} ancestor '{}': {}",
            label,
            existing_ancestor.display(),
            e
        )
    })?;

    for component in suffix.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "Failed to resolve {} '{}': unexpected absolute suffix",
                    label,
                    raw_path.display()
                ));
            }
        }
    }

    Ok(resolved)
}

async fn validate_export_target_path(state: &AppState, raw_target: &str) -> Result<String, String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return Err("target cannot be empty".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!(
            "target must be an absolute path, got '{}'",
            candidate.display()
        ));
    }

    let (export_location_id, legacy_export_root) = {
        let settings_manager = state.settings_manager.lock().await;
        (
            settings_manager
                .settings()
                .privacy
                .export_location_id
                .clone(),
            settings_manager.settings().privacy.export_root.clone(),
        )
    };

    let resolved_target = if candidate.exists() {
        let resolved = canonicalize_existing_absolute_path(trimmed, "target")?;
        if resolved.is_dir() {
            return Err(format!(
                "target must be a file path, got directory '{}'",
                resolved.display()
            ));
        }
        resolved
    } else {
        if candidate.file_name().is_none() {
            return Err(format!(
                "target must include a file name, got '{}'",
                candidate.display()
            ));
        }
        canonicalize_absolute_path_without_creation(&candidate, "target")?
    };

    if let Some(location_id) = export_location_id {
        let canonical_root = approved_locations::registry()
            .map_err(|error| error.to_string())?
            .resolve_filesystem(
                &location_id,
                approved_locations::ApprovedLocationPurpose::Export,
            )
            .map_err(|error| error.to_string())?;
        if !resolved_target.starts_with(&canonical_root) {
            return Err(format!(
                "target '{}' is outside approved export folder '{}'",
                resolved_target.display(),
                canonical_root.display()
            ));
        }
    } else if legacy_export_root.is_some() {
        return Err(
            "The legacy export folder is not approved. Choose it again in Settings".to_string(),
        );
    } else {
        let parent_to_check = resolved_target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| resolved_target.clone());
        ensure_path_in_approved_roots(&parent_to_check, "target")?;
    }

    Ok(resolved_target.to_string_lossy().to_string())
}

/// The provider/model configured for `lane`, plus the global remote-processing flag.
///
/// Callers name their own lane: dictation cleanup runs behind a short timeout and
/// wants a fast model, meeting analysis is batch work that can afford a slower one.
async fn selected_analysis_provider_and_settings(
    state: &AppState,
    lane: settings::AiLane,
) -> Result<(AnalysisProvider, bool, String, Option<String>), String> {
    let settings_manager = state.settings_manager.lock().await;
    let settings = settings_manager.settings();
    let lane_settings = settings.privacy.ai_lane(lane);
    Ok((
        AnalysisProvider::from_settings_value(&lane_settings.provider)?,
        settings.privacy.remote_processing_enabled,
        lane_settings.provider.clone(),
        lane_settings.model_id.clone(),
    ))
}

fn enforce_remote_provider_policy(
    provider: AnalysisProvider,
    remote_processing_enabled: bool,
) -> Result<(), String> {
    if provider.is_remote() && !remote_processing_enabled {
        return Err(format!(
            "Remote provider '{}' is blocked by policy. Enable Settings > Security > Remote processing to continue.",
            provider.as_settings_value()
        ));
    }
    Ok(())
}

fn enforce_remote_asr_provider_policy(
    provider: asr::AsrProviderType,
    remote_processing_enabled: bool,
) -> Result<(), String> {
    if provider.is_remote() && !remote_processing_enabled {
        return Err(format!(
            "Remote ASR provider '{}' is blocked by policy. Enable Settings > Security > Remote processing to continue.",
            asr_provider_to_settings_value(provider)
        ));
    }
    Ok(())
}

async fn run_with_remote_processing_gate<T, F>(state: &AppState, work: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let mut grant = state.remote_processing_gate.grant()?;
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = grant.cancelled() => Err(
            "Remote processing was revoked while the provider request was active".to_string()
        ),
    }
}

/// Why a provider cannot run a free-text dictation transform.
///
/// Named rather than inlined so the two call sites that fall back to a local
/// transform log the same sentence, and so a test can assert it names the
/// provider and the alternative.
fn custom_transform_unsupported_error(provider: AnalysisProvider) -> String {
    format!(
        "'{}' can only clean up dictation; it cannot run a custom transform prompt. Choose Ollama or a cloud service for saved profiles and dictation commands.",
        provider.as_settings_value()
    )
}

/// Whether the meetings lane may be pointed at `provider`.
///
/// The two on-device providers refuse meeting work at request time; this is
/// the check that keeps a settings file from selecting one in the first place
/// and then failing every summary.
fn enforce_meeting_lane_provider_policy(provider: AnalysisProvider) -> Result<(), String> {
    if provider.supports_meeting_analysis() {
        return Ok(());
    }
    Err(format!(
        "'{}' only cleans up dictation and cannot write meeting summaries. Choose Ollama or a cloud service for the meetings lane in Models.",
        provider.as_settings_value()
    ))
}

fn missing_provider_secret_error(provider: AnalysisProvider) -> String {
    format!(
        "Missing provider secret for '{}'. Add an API key in Settings > AI & Keys.",
        provider.as_settings_value()
    )
}

fn provider_secret_for(provider: AnalysisProvider) -> Result<String, String> {
    let Some(secret_name) = provider.provider_secret_name() else {
        return Err(format!(
            "Provider '{}' does not use API keys",
            provider.as_settings_value()
        ));
    };

    let env_name = provider.environment_key_name().ok_or_else(|| {
        format!(
            "Provider '{}' does not use API keys",
            provider.as_settings_value()
        )
    })?;

    let secret = secrets::get_provider_secret(secret_name)
        .map_err(|e| e.to_string())?
        .or_else(|| std::env::var(env_name).ok())
        .unwrap_or_default();

    if secret.trim().is_empty() {
        Err(missing_provider_secret_error(provider))
    } else {
        Ok(secret)
    }
}

async fn selected_analysis_runtime(
    state: &AppState,
    lane: settings::AiLane,
    model: Option<&str>,
    request_timeout: Option<Duration>,
) -> Result<llm::ProviderRuntime, String> {
    let (provider, remote_processing_enabled, _, settings_model) =
        selected_analysis_provider_and_settings(state, lane).await?;
    enforce_remote_provider_policy(provider, remote_processing_enabled)?;
    if lane == settings::AiLane::Meetings {
        enforce_meeting_lane_provider_policy(provider)?;
    }
    let selected_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            settings_model
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| provider.default_model())
        .to_string();
    let api_key = if provider.is_remote() {
        Some(provider_secret_for(provider)?)
    } else {
        None
    };
    tracing::info!(
        "Running analysis with provider '{}' and model '{}'",
        provider.as_settings_value(),
        selected_model
    );
    let timeout = request_timeout.unwrap_or_else(|| analysis_timeouts(provider).request);
    llm::ProviderRuntime::new(
        llm::ProviderSelection {
            provider,
            model: selected_model,
            remote_processing_enabled,
            remote_processing_gate: Arc::clone(&state.remote_processing_gate),
            api_key,
            timeout,
            models_root: state.asr_manager.models_dir().clone(),
        },
        state.ollama_client.as_ref(),
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn workspace_frontmost_application() -> Option<WorkspaceFrontmostApplication> {
    // In-process NSWorkspace lookup — no process spawn on the dictation hot
    // path. NSWorkspace.sharedWorkspace and frontmostApplication are thread-safe
    // per Apple's documentation. Falls back to osascript only if this yields
    // nothing (e.g. a sandbox or future OS change).
    {
        use objc2_app_kit::NSWorkspace;
        let workspace = NSWorkspace::sharedWorkspace();
        if let Some(app) = workspace.frontmostApplication() {
            let name = app.localizedName().map(|s| s.to_string());
            let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
            if name.is_some() || bundle_id.is_some() {
                return Some(WorkspaceFrontmostApplication { name, bundle_id });
            }
        }
    }

    workspace_frontmost_application_via_osascript()
}

fn workspace_frontmost_application_via_osascript() -> Option<WorkspaceFrontmostApplication> {
    let script = r#"
ObjC.import("AppKit");
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
function unwrap(value) {
  return value ? ObjC.unwrap(value) : null;
}
JSON.stringify({
  name: app ? unwrap(app.localizedName) : null,
  bundleId: app ? unwrap(app.bundleIdentifier) : null
});
"#;

    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    serde_json::from_slice::<WorkspaceFrontmostApplication>(&output.stdout).ok()
}

#[cfg(target_os = "macos")]
fn capture_hotkey_target_context(
    include_browser_url: bool,
) -> (Option<String>, Option<String>, Option<String>) {
    let browser_url = if include_browser_url {
        normalize_optional_trimmed(get_frontmost_browser_url())
    } else {
        None
    };

    if let Some(frontmost) = workspace_frontmost_application() {
        let app_name = normalize_optional_trimmed(frontmost.name);
        let app_bundle_id = normalize_optional_trimmed(frontmost.bundle_id);
        let sanitized = sanitize_dictation_target(app_name, app_bundle_id);
        if sanitized.0.is_some() || sanitized.1.is_some() {
            return (sanitized.0, sanitized.1, browser_url);
        }
    }

    let sanitized =
        sanitize_dictation_target(get_frontmost_app_name(), get_frontmost_app_bundle_id());
    (sanitized.0, sanitized.1, browser_url)
}

#[cfg(target_os = "macos")]
fn capture_pending_hotkey_target(state: &AppState) {
    // Keep hotkey target capture free of AppleScript/browser automation so
    // dictation never triggers macOS permission UI before insertion completes.
    let (app_name, app_bundle_id, browser_url) = capture_hotkey_target_context(false);
    let captured_at_ms = chrono::Utc::now().timestamp_millis();
    if let Some(target) = build_pending_dictation_target(
        app_name.clone(),
        app_bundle_id.clone(),
        browser_url.clone(),
        captured_at_ms,
    ) {
        if let Ok(mut pending_target) = state.pending_dictation_target.lock() {
            *pending_target = Some(target.clone());
        }
        if let Ok(mut last_external_target) = state.last_external_target.lock() {
            *last_external_target = Some(target);
        }
    } else if let Ok(mut pending_target) = state.pending_dictation_target.lock() {
        *pending_target = None;
    }

    tracing::info!(
        "Captured pending dictation target at hotkey press: app={:?}, bundle_id={:?}, browser_url={:?}",
        app_name,
        app_bundle_id,
        browser_url
    );
}

#[cfg(target_os = "macos")]
fn take_pending_hotkey_target(state: &AppState) -> Option<PendingDictationTarget> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let pending = state
        .pending_dictation_target
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());

    pending.and_then(|target| {
        if is_pending_hotkey_target_fresh(target.captured_at_ms, now_ms) {
            Some(target)
        } else {
            tracing::info!(
                "Discarding stale pending dictation target captured {} ms ago",
                now_ms - target.captured_at_ms
            );
            None
        }
    })
}

#[cfg(target_os = "macos")]
fn is_pending_hotkey_target_fresh(captured_at_ms: i64, now_ms: i64) -> bool {
    now_ms - captured_at_ms <= HOTKEY_TARGET_MAX_AGE_MS
}

#[cfg(target_os = "macos")]
fn build_pending_dictation_target(
    app_name: Option<String>,
    app_bundle_id: Option<String>,
    browser_url: Option<String>,
    captured_at_ms: i64,
) -> Option<PendingDictationTarget> {
    if app_name.is_none() && app_bundle_id.is_none() && browser_url.is_none() {
        None
    } else {
        Some(PendingDictationTarget {
            app_name,
            app_bundle_id,
            browser_url,
            captured_at_ms,
        })
    }
}

#[cfg(target_os = "macos")]
fn take_recent_external_target(state: &AppState) -> Option<PendingDictationTarget> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cached = state
        .last_external_target
        .lock()
        .ok()
        .and_then(|slot| slot.clone());

    cached.filter(|target| is_recent_external_target_fresh(target.captured_at_ms, now_ms))
}

#[cfg(target_os = "macos")]
fn is_recent_external_target_fresh(captured_at_ms: i64, now_ms: i64) -> bool {
    now_ms - captured_at_ms <= LAST_EXTERNAL_TARGET_MAX_AGE_MS
}

#[cfg(target_os = "macos")]
fn current_frontmost_app_asn() -> Option<String> {
    let output = std::process::Command::new("lsappinfo")
        .arg("front")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let marker = "ASN:";
    let start = stdout.find(marker)? + marker.len();
    let end = stdout[start..].find(':').map(|index| start + index)?;
    let asn = stdout[start..end].trim();
    if asn.is_empty() {
        None
    } else {
        Some(format!("ASN:{}", asn))
    }
}

#[cfg(target_os = "macos")]
fn lsappinfo_value_for_key(asn: &str, key: &str) -> Option<String> {
    let output = std::process::Command::new("lsappinfo")
        .args(["info", "-only", key, asn])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_lsappinfo_value(&String::from_utf8_lossy(&output.stdout))
}

/// `lsappinfo info -only <key>` uses two different shapes for its value.
///
/// Most keys are reported as `key="value"` somewhere after the ASN:
///
/// ```text
/// [ NULL ]  ASN:0x0-0x7f57f5: (in front)
///     bundleID="com.apple.Notes"
/// ```
///
/// The name keys instead lead with a bare quoted token and never emit `="` at
/// all:
///
/// ```text
/// "Notes" ASN:0x0-0x25025: (in front)
///     bundleID=[ NULL ]
/// ```
///
/// Reading only the `key="value"` shape made every name lookup return `None` on
/// every app, so `reactivate_target_application` could not confirm that a target
/// without a bundle id had come back to the front: it spent its full 18-poll
/// budget, warned, and dispatched the paste anyway. Try the leading token first
/// so a populated name can never be shadowed by an unrelated `="` later in the
/// same output.
#[cfg(any(test, target_os = "macos"))]
fn parse_lsappinfo_value(stdout: &str) -> Option<String> {
    if let Some(rest) = stdout.trim_start().strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            let value = rest[..end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    let value_start = stdout.find("=\"")? + 2;
    let value_end = stdout[value_start..]
        .find('"')
        .map(|index| value_start + index)?;
    let value = stdout[value_start..value_end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(target_os = "macos")]
fn get_frontmost_app_name() -> Option<String> {
    let asn = current_frontmost_app_asn()?;
    lsappinfo_value_for_key(&asn, "name").or_else(|| lsappinfo_value_for_key(&asn, "LSDisplayName"))
}

#[cfg(target_os = "macos")]
fn get_frontmost_app_bundle_id() -> Option<String> {
    let asn = current_frontmost_app_asn()?;
    lsappinfo_value_for_key(&asn, "bundleid")
}

#[cfg(target_os = "windows")]
fn get_frontmost_app_name() -> Option<String> {
    let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PlainsongWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@;
$hwnd = [PlainsongWin32]::GetForegroundWindow();
if ($hwnd -eq [IntPtr]::Zero) { return }
$pid = 0
[void][PlainsongWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
if ($pid -eq 0) { return }
$process = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($null -ne $process -and -not [string]::IsNullOrWhiteSpace($process.ProcessName)) {
  $process.ProcessName
}
"#;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()?;

    if output.status.success() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn get_frontmost_app_bundle_id() -> Option<String> {
    None
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn get_frontmost_app_name() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn get_frontmost_window_title() -> Option<String> {
    let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PlainsongWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@;
$hwnd = [PlainsongWin32]::GetForegroundWindow();
if ($hwnd -eq [IntPtr]::Zero) { return }
$builder = New-Object System.Text.StringBuilder 1024
[void][PlainsongWin32]::GetWindowText($hwnd, $builder, $builder.Capacity)
$title = $builder.ToString().Trim()
if (-not [string]::IsNullOrWhiteSpace($title)) { $title }
"#;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()?;

    if output.status.success() {
        let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !title.is_empty() {
            return Some(title);
        }
    }
    None
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn get_frontmost_window_title() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn get_frontmost_browser_url() -> Option<String> {
    let script = r#"
tell application "System Events"
    set frontApp to name of first application process whose frontmost is true
end tell

if frontApp is "Safari" then
    tell application "Safari" to return URL of front document
else if frontApp is "Google Chrome" then
    tell application "Google Chrome" to return URL of active tab of front window
else if frontApp is "Arc" then
    tell application "Arc" to return URL of active tab of front window
else if frontApp is "Brave Browser" then
    tell application "Brave Browser" to return URL of active tab of front window
else if frontApp is "Microsoft Edge" then
    tell application "Microsoft Edge" to return URL of active tab of front window
else
    return ""
end if
"#;

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

#[cfg(not(target_os = "macos"))]
fn get_frontmost_browser_url() -> Option<String> {
    None
}

fn meeting_consent_notice_text() -> &'static str {
    "Heads up: I’m recording and transcribing this meeting with Plainsong for my notes. Please let me know now if you want me to stop."
}

#[cfg(target_os = "macos")]
fn resolve_recent_external_target_context(state: &AppState) -> Option<PendingDictationTarget> {
    let (app_name, app_bundle_id, browser_url) = capture_hotkey_target_context(true);
    build_pending_dictation_target(
        app_name,
        app_bundle_id,
        browser_url,
        chrono::Utc::now().timestamp_millis(),
    )
    .or_else(|| take_recent_external_target(state).filter(consent_target_is_fresh))
}

#[cfg(target_os = "macos")]
fn match_meeting_consent_surface(target: &PendingDictationTarget) -> Option<&'static str> {
    let app_name = target
        .app_name
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let app_bundle_id = target
        .app_bundle_id
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    if app_name.contains("zoom") || app_bundle_id.contains("zoom") {
        return Some("zoom");
    }

    let active_host = target
        .browser_url
        .as_deref()
        .and_then(extract_host_from_url)
        .unwrap_or_default();
    if active_host == "meet.google.com" {
        return Some("google_meet");
    }

    None
}

#[cfg(target_os = "macos")]
fn consent_target_is_fresh(target: &PendingDictationTarget) -> bool {
    let now_ms = chrono::Utc::now().timestamp_millis();
    now_ms - target.captured_at_ms <= MEETING_CONSENT_TARGET_MAX_AGE_MS
}

/// The instruction shown beside the consent notice. Plainsong never posts
/// the notice into a meeting chat; the detected surface only lets the copy
/// say where the user should send it. Automation can return only with a
/// design that positively verifies the meeting app's chat field has focus,
/// plus on-device QA of that check. Neither exists yet.
fn meeting_consent_notice_message(surface: Option<&str>) -> &'static str {
    match surface {
        Some("zoom") => {
            "Zoom is in front. Plainsong does not post the notice into Zoom chat for you; copy it and send it there before you start recording."
        }
        Some("google_meet") => {
            "Google Meet is in front. Plainsong does not post the notice into the Meet chat for you; copy it and send it there before you start recording."
        }
        _ => {
            "Plainsong does not post the consent notice for you. Copy it and send it in the meeting before you start recording."
        }
    }
}

#[cfg(target_os = "macos")]
fn meeting_consent_notice_status(state: &AppState) -> MeetingConsentNoticeStatus {
    let notice_text = meeting_consent_notice_text().to_string();
    let Some(target) = resolve_recent_external_target_context(state) else {
        return MeetingConsentNoticeStatus {
            surface: None,
            app_name: None,
            app_bundle_id: None,
            browser_url: None,
            message: meeting_consent_notice_message(None).to_string(),
            notice_text,
        };
    };

    let surface = match_meeting_consent_surface(&target).map(str::to_string);
    MeetingConsentNoticeStatus {
        message: meeting_consent_notice_message(surface.as_deref()).to_string(),
        surface,
        app_name: target.app_name,
        app_bundle_id: target.app_bundle_id,
        browser_url: target.browser_url,
        notice_text,
    }
}

#[cfg(not(target_os = "macos"))]
fn meeting_consent_notice_status(_state: &AppState) -> MeetingConsentNoticeStatus {
    MeetingConsentNoticeStatus {
        surface: None,
        app_name: None,
        app_bundle_id: None,
        browser_url: None,
        message: meeting_consent_notice_message(None).to_string(),
        notice_text: meeting_consent_notice_text().to_string(),
    }
}

/// The user's "Custom Meeting Summary Prompt" (Settings -> Transcription),
/// trimmed; `None` when unset/blank so summaries use the default prompt.
async fn meeting_custom_prompt_from_settings(state: &AppState) -> Option<String> {
    let settings_manager = state.settings_manager.lock().await;
    settings_manager
        .settings()
        .transcription
        .meeting_custom_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(all(
    feature = "desktop-shell",
    not(any(target_os = "macos", target_os = "windows"))
))]
fn show_startup_failure_dialog(_body: &str) {}

fn runtime_status_to_db_value(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Ready => "ready",
        RuntimeStatus::MissingRuntime => "missing_runtime",
        RuntimeStatus::MissingModel => "missing_model",
        RuntimeStatus::Error => "error",
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests;

// ─── Sidecar public API ───────────────────────────────────────────────────────

/// Build and return the application state without starting the desktop shell.
/// Used by the sidecar binary to initialize the backend independently.
/// Remove keychain entries and on-disk state left over from the former
/// commercial licensing system. Best-effort and idempotent: it runs on every
/// startup but only does work for users upgrading from a licensed build.
fn cleanup_legacy_license_artifacts() {
    const LEGACY_LICENSE_SECRETS: [&str; 4] = [
        "license_key",
        "license_instance_id",
        "license_device_id",
        "license_first_run_at",
    ];
    for key in LEGACY_LICENSE_SECRETS {
        let _ = secrets::clear_internal_secret(key);
    }
    if let Some(state_file) =
        crate::paths::data_dir().map(|d| d.join("Plainsong").join("nautilus_license.json"))
    {
        let _ = std::fs::remove_file(state_file);
    }
}

/// Run `VACUUM INTO` for a temporary database snapshot and reject any failure
/// or empty output. Full backups must never fall back to the live SQLite file.
fn create_database_snapshot_at<F>(
    snapshot_path: std::path::PathBuf,
    snapshotter: F,
) -> Result<std::path::PathBuf, String>
where
    F: FnOnce(&std::path::Path) -> anyhow::Result<()>,
{
    if let Err(error) = snapshotter(&snapshot_path) {
        let _ = std::fs::remove_file(&snapshot_path);
        return Err(format!(
            "Failed to create a consistent database snapshot; backup was not published: {error}"
        ));
    }

    let metadata = std::fs::metadata(&snapshot_path).map_err(|error| {
        let _ = std::fs::remove_file(&snapshot_path);
        format!(
            "Database snapshot was not created at {}: {error}",
            snapshot_path.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        let _ = std::fs::remove_file(&snapshot_path);
        return Err("Database snapshot is not a non-empty regular file".to_string());
    }

    Ok(snapshot_path)
}

/// Write a transactionally-consistent snapshot of the live database to a temp
/// file for inclusion in a full backup. The caller must delete the returned
/// path after the backup attempt, whether publication succeeds or fails.
async fn snapshot_live_database(state: &AppState) -> Result<std::path::PathBuf, String> {
    let snapshot_path =
        std::env::temp_dir().join(format!("nautilus-db-snapshot-{}.db", uuid::Uuid::new_v4()));
    let db = state.db.lock().await;
    create_database_snapshot_at(snapshot_path, |path| db.backup_to(path))
}

/// Reopen the database connection after a restore replaced the on-disk file.
/// Without this, AppState keeps reading/writing the old inode and the restored
/// data is invisible until the next launch.
async fn reopen_database_after_restore(state: &AppState) -> Result<(), String> {
    let db_key = secrets::get_internal_secret(VAULT_DB_KEY_SECRET)
        .map_err(|e| format!("Could not read secure database key after restore: {e}"))?;
    let reopened = db::Database::new_with_key(db_key.as_deref())
        .map_err(|e| format!("Failed to reopen database after restore: {e}"))?;
    *state.db.lock().await = reopened;
    Ok(())
}

/// Reload a restored settings file through the normal SettingsManager loading
/// and normalization path, replace the live manager, and reapply every cached
/// runtime projection before notifying Electron and renderer windows.
async fn reload_settings_after_restore(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) -> Result<(), String> {
    let (previous_meeting_custom_prompt, restored_settings) = {
        let mut settings_manager = state.settings_manager.lock().await;
        let previous_meeting_custom_prompt = settings_manager
            .settings()
            .transcription
            .meeting_custom_prompt
            .clone();
        let privileged_privacy = settings_manager.settings().privacy.clone();
        settings_manager
            .reload_from_disk()
            .map_err(|error| format!("Failed to reload restored settings: {error}"))?;
        preserve_privileged_privacy_after_restore(
            &mut settings_manager.settings_mut().privacy,
            &privileged_privacy,
        );
        settings_manager.save().map_err(|error| {
            format!("Failed to preserve privileged settings after restore: {error}")
        })?;
        (
            previous_meeting_custom_prompt,
            settings_manager.settings().clone(),
        )
    };

    apply_transcription_settings_to_asr_manager(
        &state.asr_manager,
        &restored_settings.transcription,
    )
    .await;
    state
        .remote_processing_gate
        .set_allowed(restored_settings.privacy.remote_processing_enabled);
    // Same reasoning as `save_settings`: a backup restore must not rewrite the
    // snapshot an in-flight dictation is about to be finalized against.
    {
        if active_dictation_session_id(state).await.is_some() {
            tracing::debug!(
                "Deferring restored dictation start options: a session is still active"
            );
        } else {
            let mut dictation_options = state.dictation_start_options.lock().await;
            *dictation_options = dictation_options_from_settings(&restored_settings);
        }
    }

    let meeting_custom_prompt_changed =
        normalize_optional_trimmed(
            restored_settings
                .transcription
                .meeting_custom_prompt
                .clone(),
        ) != normalize_optional_trimmed(previous_meeting_custom_prompt);
    if meeting_custom_prompt_changed {
        let mut db = state.db.lock().await;
        if let Err(error) = db.invalidate_all_summary_provenance() {
            tracing::warn!(
                "Failed to invalidate meeting summaries after settings restore: {}",
                error
            );
        }
    }

    reconcile_hands_free_monitor(state, handle).await;

    let visible_settings = state.settings_manager.lock().await.settings().clone();
    let restored_value = serde_json::to_value(&restored_settings)
        .map_err(|error| format!("Failed to verify restored settings: {error}"))?;
    let visible_value = serde_json::to_value(&visible_settings)
        .map_err(|error| format!("Failed to verify live settings: {error}"))?;
    if visible_value != restored_value {
        return Err("Restored settings did not replace the live SettingsManager state".to_string());
    }

    emit_settings_changed(handle, &visible_settings);
    Ok(())
}

fn preserve_privileged_privacy_after_restore(
    restored: &mut settings::PrivacySettings,
    current: &settings::PrivacySettings,
) {
    restored.export_root = current.export_root.clone();
    restored.export_location_id = current.export_location_id.clone();
    restored.export_location_label = current.export_location_label.clone();
    restored.export_location_approved = current.export_location_approved;
    restored.vault_initialized = current.vault_initialized;
    restored.vault_salt = current.vault_salt.clone();
}

/// What the startup vault check found and did, so the sidecar can tell the
/// person rather than only the log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultStartupMigration {
    /// A plaintext database was found beside a durable key and encrypted.
    pub encrypted_now: bool,
    /// The migration was needed and did not finish. The database is still
    /// plaintext and still open; this is the reason.
    pub failure: Option<String>,
}

impl VaultStartupMigration {
    /// The sentence the renderer shows, or `None` when nothing happened.
    pub fn notice(&self) -> Option<String> {
        if let Some(reason) = &self.failure {
            return Some(format!(
                "Plainsong could not encrypt its database, so it is still readable without your \
                 vault key. Cause: {reason} Your meetings are unchanged. Try Settings > Privacy > \
                 turn the vault on again, and if it keeps failing, check free disk space."
            ));
        }
        self.encrypted_now.then(|| {
            "Plainsong finished encrypting its database with your vault key. An earlier version \
             stored the key but left the database unencrypted; that is now fixed and nothing was \
             lost."
                .to_string()
        })
    }
}

/// Open the database, and repair the one inconsistent state the vault can
/// leave behind: a durable key in the keychain and a plaintext file on disk.
///
/// That state was not rare. `PRAGMA rekey` is a no-op on a connection that was
/// never keyed, so *every* install that turned the vault on stored a key and
/// kept a plaintext database while the app reported it as encrypted. The same
/// state can also be reached honestly, by stopping between the key's verified
/// keychain write and the encryption step.
///
/// Either way the recovery is the same and it is now real: prove the file is
/// still plaintext, then run the `sqlcipher_export` migration with the
/// already-durable key. A wrong key for a genuinely encrypted file cannot pass
/// the plaintext open, so an encrypted database is never overwritten.
///
/// A migration that fails does not stop the app. The alternative is refusing
/// to launch, which would leave someone with a readable database and no way to
/// reach it; the honest answer is to open the plaintext file, report
/// `database_encrypted: false` everywhere it is asked, and say plainly what
/// went wrong.
fn open_database_with_vault_key_recovery(
    initial_db_key: Option<&str>,
) -> Result<(db::Database, VaultStartupMigration), String> {
    match db::Database::new_with_key(initial_db_key) {
        Ok(database) => Ok((database, VaultStartupMigration::default())),
        #[cfg(feature = "sqlcipher")]
        Err(keyed_error) if initial_db_key.is_some() => {
            let mut plaintext = db::Database::new_with_key(None).map_err(|plaintext_error| {
                format!(
                    "Failed to initialize encrypted database ({keyed_error}); plaintext recovery also failed ({plaintext_error})"
                )
            })?;
            tracing::warn!(
                "A vault key is stored but the database is plaintext; encrypting it now"
            );
            match plaintext.change_key(initial_db_key.expect("guarded by is_some")) {
                Ok(()) => Ok((
                    plaintext,
                    VaultStartupMigration {
                        encrypted_now: true,
                        failure: None,
                    },
                )),
                Err(error) => {
                    tracing::error!("Startup database encryption failed: {error:#}");
                    Ok((
                        plaintext,
                        VaultStartupMigration {
                            encrypted_now: false,
                            failure: Some(format!("{error}.")),
                        },
                    ))
                }
            }
        }
        Err(error) => Err(format!("Failed to initialize local database: {error}")),
    }
}

/// Delete dictation scratch WAVs left behind by a previous run.
///
/// The `TempWav` guard unlinks on drop, which covers cancellation and normal
/// errors. It cannot cover SIGKILL, a panic that aborts, or a power loss — and
/// what is left behind is real recorded speech sitting in the OS temp
/// directory. Sweeping at startup bounds how long that can persist.
fn sweep_stale_dictation_temp_audio() {
    const PREFIX: &str = "plainsong-dictation-";

    let temp_dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temp_dir) else {
        return;
    };

    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(PREFIX) || !name.ends_with(".wav") {
            continue;
        }
        // Only regular files, never a symlink pointing somewhere else.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }

    if removed > 0 {
        tracing::info!("Removed {} orphaned dictation audio file(s)", removed);
    }
}

pub async fn build_app_state() -> Result<AppState, String> {
    cleanup_legacy_license_artifacts();
    sweep_stale_dictation_temp_audio();

    let initial_db_key = secrets::get_internal_secret(VAULT_DB_KEY_SECRET)
        .map_err(|e| format!("Could not read secure database key: {}", e))?;

    // Built before the database so the startup encryption repair below holds
    // the same `VaultMigration` exclusion the Settings-driven migration does.
    // Nothing else has a handle on this coordinator yet, so the lease can only
    // succeed; taking it anyway is what keeps the two paths from diverging if
    // startup ever grows a concurrent step.
    let operation_coordinator = operation_coordinator::OperationCoordinator::new();
    let (mut database, vault_startup_migration) = {
        let _vault_lease = operation_coordinator
            .try_acquire(operation_coordinator::OperationKind::VaultMigration)?;
        open_database_with_vault_key_recovery(initial_db_key.as_deref())?
    };
    if vault_startup_migration != VaultStartupMigration::default() {
        // Recorded even when it failed: "we tried and could not" is the part a
        // support bundle needs. No key material, no paths.
        let outcome = if vault_startup_migration.encrypted_now {
            "encrypted"
        } else {
            "failed"
        };
        if let Err(error) = database.log_audit_event(
            "vault_database_encryption_repair",
            Some(serde_json::json!({ "outcome": outcome })),
            if vault_startup_migration.encrypted_now {
                "info"
            } else {
                "warn"
            },
        ) {
            tracing::warn!("Could not record the vault repair audit event: {}", error);
        }
    }

    let settings_manager = settings::SettingsManager::new()
        .map_err(|e| format!("Failed to initialize settings: {}", e))?;

    let models_root = crate::paths::data_dir()
        .ok_or("Could not find data directory")?
        .join("Plainsong")
        .join("models");
    let mut model_integrity_artifacts = download::managed_model_integrity_artifacts(&models_root);
    model_integrity_artifacts.extend(asr::model_integrity_artifacts(&models_root));
    // The bundled cleanup model is loaded into an in-process inference
    // runtime, so it has to be in the same fail-closed receipt set as the ASR
    // weights rather than trusted because the file happens to be there.
    model_integrity_artifacts.extend(llm::bundled_local::model_integrity_artifacts(&models_root));
    // This runs inline (fail-closed trust semantics are correct here), and
    // an artifact without a cached-and-trusted receipt yet is re-hashed in
    // full -- for many multi-gigabyte models on first launch after an
    // upgrade, that can be a minute-scale stall. Log the count up front so
    // it is attributable instead of looking like a hang.
    tracing::info!(
        "Re-verifying integrity receipts for {} local model artifact(s) at startup; \
         already-cached ones are skipped quickly, uncached ones are re-hashed",
        model_integrity_artifacts.len()
    );
    let integrity_migration =
        download::migrate_legacy_model_integrity_receipts(&model_integrity_artifacts).await;
    if integrity_migration.migrated_count > 0 {
        tracing::info!(
            "Recorded integrity receipts for {} existing local model artifact(s)",
            integrity_migration.migrated_count
        );
    }
    for path in integrity_migration.rejected_paths {
        tracing::warn!(
            "Existing local model failed application-pinned integrity verification: {}",
            path.display()
        );
    }
    for (path, error) in integrity_migration.errors {
        tracing::warn!(
            "Could not verify existing local model '{}': {}",
            path.display(),
            error
        );
    }

    let initial_dictation_options = dictation_options_from_settings(settings_manager.settings());
    let remote_processing_gate = Arc::new(remote_processing::RemoteProcessingGate::new(
        settings_manager
            .settings()
            .privacy
            .remote_processing_enabled,
    ));
    let asr_manager = Arc::new(asr::AsrManager::new());
    asr_manager
        .set_remote_processing_gate(Arc::clone(&remote_processing_gate))
        .await;
    // Sync the manager from persisted settings right away: `AsrManager::new`
    // hardcodes silence-skip/MLX/platform-optimization defaults, and without
    // this the user's saved transcription settings only take effect after the
    // next save_settings call instead of at every launch.
    apply_transcription_settings_to_asr_manager(
        &asr_manager,
        &settings_manager.settings().transcription,
    )
    .await;
    schedule_dictation_model_prewarm(&settings_manager.settings().transcription);
    apply_bundled_cleanup_keep_warm(settings_manager.settings());
    schedule_bundled_cleanup_prewarm(settings_manager.settings());
    schedule_apple_language_model_probe();
    let streaming_transcriber = Arc::new(streaming::StreamingTranscriber::new(Arc::clone(
        &asr_manager,
    )));

    Ok(AppState {
        db: Arc::new(Mutex::new(database)),
        audio_capture: Arc::new(Mutex::new(audio::AudioCapture::new())),
        asr_manager,
        ollama_client: Arc::new(llm::OllamaClient::new()),
        ollama_embedder: Arc::new(llm::OllamaEmbedder::new()),
        settings_manager: Arc::new(Mutex::new(settings_manager)),
        remote_processing_gate,
        backup_manager: Arc::new(Mutex::new(backup::BackupManager::default())),
        template_manager: Arc::new(export::templates::TemplateManager::new()),
        dictation_hotkey_active: Arc::new(Mutex::new(false)),
        dictation_release_pending: Arc::new(AtomicBool::new(false)),
        dictation_session_tracker: Arc::new(Mutex::new(DictationSessionTracker::default())),
        dictation_runtime_state: Arc::new(Mutex::new(DictationSessionState::Idle)),
        dictation_start_options: Arc::new(Mutex::new(initial_dictation_options)),
        pending_dictation_target: Arc::new(StdMutex::new(None)),
        last_external_target: Arc::new(StdMutex::new(None)),
        dictation_overlay_state: Arc::new(StdMutex::new(DictationOverlayState::default())),
        recording_overlay_state: Arc::new(StdMutex::new(RecordingOverlayState::default())),
        accessibility_trust_observed: Arc::new(AtomicBool::new(false)),
        last_cursor_insert_status: Arc::new(StdMutex::new(None)),
        recent_dictation_delivery: Arc::new(Mutex::new(None)),
        dictation_live_preview: Arc::new(Mutex::new(None)),
        streaming_transcriber,
        vault_state: Arc::new(Mutex::new(VaultRuntimeState::default())),
        vault_startup_migration,
        audio_storage_gate: Arc::new(Mutex::new(())),
        recording_stream_stop: Arc::new(AtomicBool::new(false)),
        recording_templates: Arc::new(StdMutex::new(std::collections::HashMap::new())),
        active_meeting_audio_postprocessing: Arc::new(StdMutex::new(HashMap::new())),
        operation_coordinator,
        capture_admission: Arc::new(admission::CaptureAdmissionRegistry::default()),
        playback_registry: Arc::new(playback::PlaybackRegistry::default()),
        active_capture_lease: Arc::new(Mutex::new(None)),
        sidecar_shutting_down: Arc::new(AtomicBool::new(false)),
        recent_dictation_results: Arc::new(StdMutex::new(Vec::new())),
        meeting_call_detector: Arc::new(StdMutex::new(meeting_detect::CallDetector::default())),
        session_cluster_voices: Arc::new(StdMutex::new(
            diarization::voiceprints::SessionClusterVoices::default(),
        )),
    })
}

/// Mark the runtime as shutting down before any active background work is
/// cancelled. Startup reconciliation owns the durable outcome for meetings
/// that are still processing after this point.
pub fn begin_sidecar_shutdown(state: &AppState) {
    state.sidecar_shutting_down.store(true, Ordering::SeqCst);
}

/// Push persisted transcription settings into the live `AsrManager`.
///
/// Shared by `build_app_state` (startup) and `save_settings_for_sidecar`
/// (every save) so runtime routing state — provider/model map, per-slot MLX
/// flags, silence skip, platform optimization — always mirrors settings.json
/// instead of silently reverting to `AsrManager::new` defaults until the
/// first save. Expects already-normalized settings (load-time normalizers or
/// `normalize_contextual_asr_settings` have run).
async fn apply_transcription_settings_to_asr_manager(
    asr_manager: &asr::AsrManager,
    transcription: &settings::TranscriptionSettings,
) {
    let default_provider = asr_provider_from_settings_value(&transcription.default_provider)
        .unwrap_or(asr::AsrProviderType::Whisper);
    let mut provider_model_map = provider_model_map_from_settings(transcription);
    let selected_for_default =
        normalize_asr_model_id(default_provider, &transcription.selected_model_id);
    provider_model_map.insert(default_provider, selected_for_default);

    asr_manager.set_provider_model_map(provider_model_map).await;
    asr_manager
        .set_dictation_mlx_enabled(transcription.dictation_mlx_enabled)
        .await;
    asr_manager
        .set_meeting_mlx_enabled(transcription.meeting_mlx_enabled)
        .await;
    asr_manager
        .set_transcription_language(transcription.language.clone())
        .await;
    asr_manager.set_default_provider(default_provider).await;
    asr_manager
        .set_silence_skip_enabled(transcription.silence_skip_enabled)
        .await;
    asr_manager
        .set_platform_optimization(transcription.platform_optimization.clone())
        .await;
}

/// Broadcast the full persisted settings to every window after any writer
/// (save_settings, set_update_channel, …) commits them. Lets renderer
/// surfaces holding a settings draft refresh instead of later clobbering
/// another writer's change with a stale whole-object save.
fn emit_settings_changed(
    handle: &crate::sidecar_handle::SidecarHandle,
    settings: &settings::Settings,
) {
    match serde_json::to_value(visible_settings_for_renderer(settings)) {
        Ok(payload) => handle.emit_event("settings-changed", payload),
        Err(error) => tracing::warn!("Failed to serialize settings-changed payload: {}", error),
    }
}

fn visible_settings_for_renderer(settings: &settings::Settings) -> settings::Settings {
    let mut visible = settings.clone();
    let legacy_label = visible
        .privacy
        .export_root
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .map(ToString::to_string);
    visible.privacy.export_root = None;
    match visible.privacy.export_location_id.as_deref() {
        Some(id) => {
            let summary = approved_locations::registry()
                .map(|registry| {
                    registry.summary(id, approved_locations::ApprovedLocationPurpose::Export)
                })
                .unwrap_or(approved_locations::ApprovedLocationSummary {
                    id: id.to_string(),
                    label: "Location needs reselection".to_string(),
                    approved: false,
                });
            visible.privacy.export_location_label = Some(summary.label);
            visible.privacy.export_location_approved = summary.approved;
        }
        None => {
            visible.privacy.export_location_label = legacy_label;
            visible.privacy.export_location_approved = false;
        }
    }
    visible.privacy.vault_salt = None;
    visible
}

fn preserve_privileged_privacy_settings(
    current: &settings::PrivacySettings,
    incoming: &mut settings::PrivacySettings,
) {
    incoming.export_root = current.export_root.clone();
    incoming.export_location_id = current.export_location_id.clone();
    incoming.export_location_label = current.export_location_label.clone();
    incoming.export_location_approved = current.export_location_approved;
    incoming.vault_initialized = current.vault_initialized;
    incoming.vault_salt = current.vault_salt.clone();
}

/// The first-run record is the sidecar's, not the renderer's. Every settings
/// write from the renderer is a read-modify-write of the whole document, so a
/// `Settings` value built from a stale or hand-made literal -- or a forged
/// one -- must never be allowed to overwrite it in `save_settings_for_sidecar`.
///
/// Mirrors `preserve_privileged_privacy_settings` in shape, and for the same
/// reason: factored out of the save path so the guard is directly
/// unit-testable without standing up a full `AppState`.
fn preserve_sidecar_onboarding_record(
    current: &settings::OnboardingSettings,
    incoming: &mut settings::OnboardingSettings,
) {
    *incoming = current.clone();
}

/// Read the macOS grants Plainsong can see right now, for the first-run record.
///
/// Preflight reads only — the same ones `get_permission_diagnostics` serves —
/// so recording a completion never raises a system prompt of its own. Every
/// field stays a tri-state: `None` means "this build cannot observe it", which
/// is not the same as denied. System audio is left unobserved because the only
/// honest answer needs a capture test, and a record is not the place to run
/// one.
async fn observed_onboarding_grants(state: &AppState) -> settings::OnboardingGrants {
    let diagnostics = crate::permissions::collect_permission_diagnostics(state, Vec::new()).await;
    settings::OnboardingGrants {
        microphone: Some(diagnostics.microphone_permission_ready),
        accessibility: Some(diagnostics.accessibility_ready),
        post_event: Some(diagnostics.post_event_ready),
        speech_recognition: Some(diagnostics.speech_recognition_ready),
        system_audio: None,
    }
}

/// Write the install's first-run record.
///
/// The renderer says *what happened* ("the wizard finished", "the reader
/// deferred with these unmet"); the clock, the version and the observed grants
/// come from here. That split is the point: a record whose contents the
/// renderer could dictate would be exactly as trustworthy as the localStorage
/// boolean it replaces.
async fn record_onboarding_state_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    event: &str,
    meetings_completed: bool,
    unmet: &[String],
) -> Result<serde_json::Value, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let grants = match event {
        "completed" | "migrated" => observed_onboarding_grants(state).await,
        _ => settings::OnboardingGrants::default(),
    };

    let (record, changed, full_settings) = {
        let mut manager = state.settings_manager.lock().await;
        let onboarding = &mut manager.settings_mut().onboarding;
        let changed = match event {
            "completed" => {
                settings::record_onboarding_completed(
                    onboarding,
                    &now,
                    settings::ONBOARDING_RECORD_VERSION,
                    meetings_completed,
                    grants,
                );
                true
            }
            "migrated" => settings::adopt_legacy_onboarding_record(onboarding, &now, grants),
            "meetings_completed" => {
                settings::record_meetings_onboarding_completed(onboarding, &now);
                true
            }
            "deferred" => {
                settings::record_onboarding_deferred(onboarding, &now, unmet);
                true
            }
            other => {
                return Err(format!(
                    "Unknown onboarding event: {other}. Expected completed, meetings_completed, deferred or migrated."
                ));
            }
        };
        if changed {
            manager.save().map_err(|e| e.to_string())?;
        }
        (
            manager.settings().onboarding.clone(),
            changed,
            manager.settings().clone(),
        )
    };

    if changed {
        // The gate reads readiness, and readiness reads settings; without this
        // a second window (the overlay) would keep the pre-completion record.
        emit_settings_changed(handle, &full_settings);
    }

    serde_json::to_value(record).map_err(|e| e.to_string())
}

/// Sidecar-compatible save_settings: applies normalized settings and emits frontend events.
async fn save_settings_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut settings: settings::Settings,
) -> Result<serde_json::Value, String> {
    let (privileged_privacy, previous_shortcuts, previous_onboarding) = {
        let manager = state.settings_manager.lock().await;
        (
            manager.settings().privacy.clone(),
            manager.settings().shortcuts.clone(),
            manager.settings().onboarding.clone(),
        )
    };
    preserve_privileged_privacy_settings(&privileged_privacy, &mut settings.privacy);
    // The first-run record is the sidecar's, not the renderer's. Every settings
    // write from the renderer is a read-modify-write of the whole document, so
    // one built from a stale or hand-made `Settings` literal -- or a forged
    // one -- would silently erase the record and put the install back where
    // this bug started. See `preserve_sidecar_onboarding_record` and
    // `save_settings_never_overwrites_the_onboarding_record` in tests.rs.
    preserve_sidecar_onboarding_record(&previous_onboarding, &mut settings.onboarding);
    // Keeps the legacy `toggleDictation` key and the binding table telling the
    // same story whichever one the writer edited; see the function's doc for
    // which side wins when.
    settings::reconcile_saved_keyboard_shortcuts(&mut settings.shortcuts, &previous_shortcuts);

    settings::normalize_loaded_audio_settings(&mut settings.audio);
    settings.ui.color_scheme = normalize_color_scheme_value(&settings.ui.color_scheme);
    settings.transcription.dictation_silence_timeout_seconds =
        normalize_dictation_silence_timeout_seconds(
            settings.transcription.dictation_silence_timeout_seconds,
        );
    normalize_platform_optimization(&mut settings.transcription.platform_optimization);
    normalize_contextual_asr_settings(&mut settings.transcription);

    // Validated strictly on save, and only against what the *selected* model can
    // decode. A language the model cannot handle is refused with a reason rather
    // than dropped, which is what the old twelve-language allowlist did: it both
    // discarded languages real models support and accepted ones they do not.
    settings.transcription.dictation_active_languages =
        settings::validate_dictation_active_languages(
            &settings.transcription.dictation_provider,
            &settings.transcription.dictation_model_id,
            &settings.transcription.dictation_active_languages,
        )?;

    // Unparseable provider values fall back to whisper.cpp — the same fast
    // default `settings::normalize_transcription_provider_value` uses — so
    // Rust-side fallbacks never steer users onto the slower Distil route.
    let default_provider =
        asr_provider_from_settings_value(&settings.transcription.default_provider)
            .unwrap_or(asr::AsrProviderType::Whisper);
    settings.transcription.default_provider =
        asr_provider_to_settings_value(default_provider).to_string();

    let mut provider_model_map = provider_model_map_from_settings(&settings.transcription);
    let selected_for_default =
        normalize_asr_model_id(default_provider, &settings.transcription.selected_model_id);
    provider_model_map.insert(default_provider, selected_for_default.clone());
    settings.transcription.selected_model_id = selected_for_default;
    settings.transcription.provider_model_ids = provider_model_map_to_settings(&provider_model_map);

    let dictation_options = dictation_options_from_settings(&settings);

    apply_transcription_settings_to_asr_manager(&state.asr_manager, &settings.transcription).await;

    let (previous_provider, previous_meeting_custom_prompt, previous_dictation_ai_provider) = {
        let sm = state.settings_manager.lock().await;
        (
            sm.settings().transcription.default_provider.clone(),
            sm.settings().transcription.meeting_custom_prompt.clone(),
            sm.settings().privacy.dictation_ai.provider.clone(),
        )
    };
    if settings.transcription.default_provider != previous_provider {
        let provider = state.asr_manager.get_provider(default_provider).await;
        if !provider.is_available() {
            handle.emit_event(
                "asr-provider-warning",
                format!(
                    "{} is not ready for transcription",
                    default_provider.display_name()
                ),
            );
        }
    }

    // Both lanes get validated and canonicalized; neither is allowed to hold a
    // provider string the analysis code cannot resolve.
    settings.privacy.dictation_ai.provider =
        AnalysisProvider::from_settings_value(&settings.privacy.dictation_ai.provider)?
            .as_settings_value()
            .to_string();
    settings.privacy.meetings_ai.provider =
        AnalysisProvider::from_settings_value(&settings.privacy.meetings_ai.provider)?
            .as_settings_value()
            .to_string();
    settings.transcription.dictation_profile = dictation_profile_to_settings_value(
        &dictation_profile_from_settings_value(&settings.transcription.dictation_profile),
    )
    .to_string();
    settings.transcription.dictation_mode_preset =
        normalize_dictation_mode_preset(&settings.transcription.dictation_mode_preset).to_string();
    settings.transcription.dictation_context_source =
        normalize_dictation_context_source(&settings.transcription.dictation_context_source)
            .to_string();
    settings.transcription.dictation_route_preference =
        normalize_dictation_route_preference(&settings.transcription.dictation_route_preference)
            .to_string();
    // Custom dictation modes are dictation work, so they fall back to the
    // dictation lane's provider/model, not the meetings one.
    let fallback_ai_provider = settings.privacy.dictation_ai.provider.clone();
    let fallback_ai_model = settings.privacy.dictation_ai.model_id.clone();
    for mode in &mut settings.transcription.dictation_custom_modes {
        normalize_dictation_custom_mode(mode, &fallback_ai_provider, fallback_ai_model.as_deref());
    }
    // Translate-to-English cannot run on a whisper `.en` build, and the toggle
    // is disabled there, so a stored `true` is stale state the UI can no
    // longer clear. Drop it rather than keep a switch that reads off while a
    // pass runs. Must follow both `normalize_contextual_asr_settings` (which
    // settles which recognizer the dictation lane resolves to) and the custom
    // mode loop above (which settles each mode's own override).
    clear_untranslatable_dictation_translate_flags(&mut settings.transcription);
    // Same sanitization the load path applies (`normalize_loaded_transcription_settings`
    // calls the same function) -- a save is just as capable of carrying a
    // malformed or oversized template as a hand-edited settings.json is.
    settings.transcription.meeting_custom_templates = settings::sanitize_meeting_custom_templates(
        std::mem::take(&mut settings.transcription.meeting_custom_templates),
    );
    // Same reasoning, one section over: the saved prompt library is free text
    // the renderer hands straight back, and `built_in` is recomputed here so
    // a crafted payload cannot mint an undeletable prompt.
    settings.ai.saved_prompts =
        settings::sanitize_saved_prompts(std::mem::take(&mut settings.ai.saved_prompts));
    settings::sanitize_dictation_numbers_as_digits(
        &mut settings.transcription.dictation_numbers_as_digits,
    );
    settings.transcription.dictation_command_prefix =
        normalize_dictation_command_prefix(&settings.transcription.dictation_command_prefix)
            .to_string();
    settings.transcription.dictation_insertion_mode =
        normalize_dictation_insertion_mode(&settings.transcription.dictation_insertion_mode)
            .to_string();
    settings.transcription.dictation_retention_preset =
        normalize_dictation_retention_preset(&settings.transcription.dictation_retention_preset)
            .to_string();
    if settings.transcription.dictation_retention_custom_hours == 0 {
        settings.transcription.dictation_retention_custom_hours = 1;
    }
    settings.transcription.meeting_audio_storage_mode =
        normalize_meeting_audio_storage_mode(&settings.transcription.meeting_audio_storage_mode)
            .to_string();
    settings.transcription.meeting_retention_preset =
        normalize_meeting_retention_preset(&settings.transcription.meeting_retention_preset)
            .to_string();
    if settings.transcription.meeting_retention_custom_months == 0 {
        settings.transcription.meeting_retention_custom_months = 1;
    }
    settings.transcription.meeting_retention_delete_mode = normalize_meeting_retention_delete_mode(
        &settings.transcription.meeting_retention_delete_mode,
    )
    .to_string();
    validate_shortcut_settings(&settings.shortcuts)?;
    if settings
        .transcription
        .dictation_project_id
        .trim()
        .is_empty()
    {
        settings.transcription.dictation_project_id = "inbox".to_string();
    }

    let meeting_custom_prompt_changed =
        normalize_optional_trimmed(settings.transcription.meeting_custom_prompt.clone())
            != normalize_optional_trimmed(previous_meeting_custom_prompt);
    let remote_processing_enabled = settings.privacy.remote_processing_enabled;
    // Read before the settings move into the manager below.
    let dictation_ai_provider_after_save = settings.privacy.dictation_ai.provider.clone();
    if !remote_processing_enabled {
        state.remote_processing_gate.set_allowed(false);
    }

    {
        let mut settings_manager = state.settings_manager.lock().await;
        *settings_manager.settings_mut() = settings;
        settings_manager.save().map_err(|e| e.to_string())?;
        emit_settings_changed(handle, settings_manager.settings());
        schedule_dictation_model_prewarm(&settings_manager.settings().transcription);
        apply_bundled_cleanup_keep_warm(settings_manager.settings());
        schedule_bundled_cleanup_prewarm(settings_manager.settings());
    }

    if bundled_cleanup_runtime_should_unload(
        &previous_dictation_ai_provider,
        &dictation_ai_provider_after_save,
    ) {
        // Synchronous and cheap: it drops one `Option` holding the weights.
        llm::bundled_local::clear_cached_runtime();
        tracing::info!(
            "Dictation cleanup left {}; released the resident model",
            llm::bundled_local::PROVIDER_SETTINGS_VALUE
        );
    }

    if remote_processing_enabled {
        state.remote_processing_gate.set_allowed(true);
    }

    if meeting_custom_prompt_changed {
        let mut db = state.db.lock().await;
        db.invalidate_all_summary_provenance()
            .map_err(|error| error.to_string())?;
    }

    // `dictation_start_options` doubles as the live session's snapshot: stop
    // reads it to learn which route, model, target app and delivery mode the
    // session actually began with. Overwriting it while a session is running
    // replaced that history with the new defaults, so a save landing mid-
    // dictation made the finished result claim the wrong provider and target.
    // New defaults apply from the next session.
    {
        let session_active = active_dictation_session_id(state).await.is_some();
        if session_active {
            tracing::debug!("Deferring dictation start-option defaults: a session is still active");
        } else {
            let mut active_dictation_options = state.dictation_start_options.lock().await;
            *active_dictation_options = dictation_options;
        }
    }

    // Pick up any change to `dictation_hands_free_enabled` immediately: starts the
    // idle-time monitor if it was just turned on (and no session is active), or stops
    // it right away if it was just turned off.
    reconcile_hands_free_monitor(state, handle).await;

    Ok(serde_json::Value::Null)
}

/// Sidecar-compatible reset_app_state: performs DB/state purge, emits reset event via handle.
async fn reset_app_state_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) -> Result<serde_json::Value, String> {
    let _storage_guard = state.audio_storage_gate.lock().await;
    {
        let audio = state.audio_capture.lock().await;
        if audio.is_dictating() || audio.is_recording() {
            return Err(
                "Stop active dictation or recording before resetting app state.".to_string(),
            );
        }
    }
    let active_postprocessing = active_meeting_audio_postprocessing_ids(state);
    if !active_postprocessing.is_empty() {
        return Err(format!(
            "Wait for meeting transcription to finish before resetting app state. Still processing: {}",
            active_postprocessing
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let _vault_lock_lease = revoke_runtime_audio_for_vault_lock(&state.operation_coordinator)
        .await
        .map_err(|error| format!("Resetting app state locks the vault first. {error}"))?;

    let data_dir = crate::paths::data_dir().ok_or_else(|| {
        "Could not determine the application data directory for reset".to_string()
    })?;
    let deleted_runtime_audio_directory = remove_decrypted_runtime_audio_directory(&data_dir)?;

    let recordings_with_audio = {
        let db = state.db.lock().await;
        let recordings = db.get_recordings(None).map_err(|e| e.to_string())?;
        let mut values = Vec::with_capacity(recordings.len());
        for recording in recordings {
            let bundle = db
                .load_recording_audio_bundle(&recording.id)
                .map_err(|error| error.to_string())?;
            values.push((recording, bundle));
        }
        values
    };
    let deleted_recordings = recordings_with_audio.len();
    let mut deleted_audio_files = 0usize;
    let mut failed_audio_file_deletions = Vec::new();
    for (recording, bundle) in &recordings_with_audio {
        if bundle.assets().next().is_some() {
            let deletion = remove_owned_recording_audio(bundle, "app state reset");
            deleted_audio_files += deletion.deleted_files;
            failed_audio_file_deletions.extend(deletion.failures);
        } else if !recording.audio_path.trim().is_empty() {
            // Startup normally backfills this row. Retain the narrow legacy
            // fallback for a reset invoked before startup maintenance finishes.
            let (deleted, failed) =
                remove_recording_audio_files(&recording.audio_path, "app state reset");
            deleted_audio_files += deleted;
            failed_audio_file_deletions.extend(failed);
        }
    }
    if !failed_audio_file_deletions.is_empty() {
        return Err(format!(
            "Reset stopped because {} recording audio file{} could not be removed. No database rows were purged. {}",
            failed_audio_file_deletions.len(),
            if failed_audio_file_deletions.len() == 1 {
                ""
            } else {
                "s"
            },
            failed_audio_file_deletions.join("; ")
        ));
    }

    {
        let mut db = state.db.lock().await;
        db.purge_user_content().map_err(|e| e.to_string())?;
    }

    let db_encrypted = {
        let db = state.db.lock().await;
        db.is_encrypted().map_err(|e| e.to_string())?
    };

    let defaults = {
        let mut settings_manager = state.settings_manager.lock().await;
        reset_settings_preserving_encrypted_database_state(
            settings_manager.settings_mut(),
            db_encrypted,
        );
        settings_manager.save().map_err(|e| e.to_string())?;
        settings_manager.settings().clone()
    };
    {
        let mut vault_state = state.vault_state.lock().await;
        lock_vault_runtime_after_reset(&mut vault_state, db_encrypted);
    }

    apply_transcription_settings_to_asr_manager(&state.asr_manager, &defaults.transcription).await;
    state
        .remote_processing_gate
        .set_allowed(defaults.privacy.remote_processing_enabled);
    state.asr_manager.clear_runtime_errors().await;

    {
        let mut options = state.dictation_start_options.lock().await;
        *options = dictation_options_from_settings(&defaults);
    }
    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        *runtime_state = DictationSessionState::Idle;
    }
    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        *tracker = DictationSessionTracker::default();
    }
    set_dictation_hotkey_flags(state, false, false).await;
    state
        .dictation_release_pending
        .store(false, Ordering::SeqCst);
    state.recording_stream_stop.store(false, Ordering::SeqCst);

    if let Ok(mut s) = state.dictation_overlay_state.lock() {
        *s = DictationOverlayState::default();
    }
    if let Ok(mut s) = state.recording_overlay_state.lock() {
        *s = RecordingOverlayState::default();
    }
    if let Ok(mut target) = state.pending_dictation_target.lock() {
        *target = None;
    }
    if let Ok(mut target) = state.last_external_target.lock() {
        *target = None;
    }
    if let Ok(mut status) = state.last_cursor_insert_status.lock() {
        *status = None;
    }
    if let Ok(mut results) = state.recent_dictation_results.lock() {
        results.clear();
    }
    if let Ok(mut templates) = state.recording_templates.lock() {
        templates.clear();
    }
    {
        let mut delivery = state.recent_dictation_delivery.lock().await;
        *delivery = None;
    }

    let (cleared_provider_secrets, failed_provider_secret_clears) =
        clear_registered_provider_secrets_with(secrets::clear_provider_secret);

    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({ "phase": "idle" }),
    );
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({ "phase": "idle" }),
    );
    handle.emit_event("app-state-reset", serde_json::json!({ "ok": true }));

    serde_json::to_value(serde_json::json!({
        "deletedRecordings": deleted_recordings,
        "deletedAudioFiles": deleted_audio_files,
        "deletedRuntimeAudioDirectory": deleted_runtime_audio_directory,
        "failedAudioFileDeletions": failed_audio_file_deletions,
        "clearedProviderSecrets": cleared_provider_secrets,
        "failedProviderSecretClears": failed_provider_secret_clears,
    }))
    .map_err(|e| e.to_string())
}

/// Whether the hands-free idle-time monitor should be running, given the setting and
/// the current dictation session state. Pure decision table, factored out of
/// `reconcile_hands_free_monitor` so the guard logic ("can't run alongside an active
/// session; never runs at all unless the setting is on") is unit-testable without
/// needing a full `AppState`/audio device.
///
/// - Setting off → never run, regardless of session state (this is what keeps
///   idle CPU/mic-hot behavior unchanged for users who don't opt in).
/// - Setting on + session not `Idle` (`Starting` or `Recording`) → must not run; the
///   real dictation capture stream owns the microphone and the monitor must not race
///   it for the same device, and a session is already starting/active so there is
///   nothing for the monitor to trigger anyway.
/// - Setting on + session `Idle` → should run.
fn hands_free_monitor_should_run(enabled: bool, session_state: DictationSessionState) -> bool {
    enabled && session_state == DictationSessionState::Idle
}

/// Reconcile the hands-free *idle-time* monitor (see
/// `AudioCapture::start_hands_free_monitor`) against current settings and dictation
/// session state, using the decision in `hands_free_monitor_should_run`. Idempotent and
/// cheap to call from every place that can change either input: sidecar startup,
/// `save_settings`, and after every dictation start/stop/abort.
///
/// This is the single choke point deciding whether the monitor should be running, so
/// individual dictation code paths don't each need to remember to start/stop it. When
/// the decision is "should run" but the monitor is already active, this is a no-op
/// (`AudioCapture::start_hands_free_monitor` is itself idempotent too) — so it can never
/// spin up a second monitor stream on top of an existing one.
pub async fn reconcile_hands_free_monitor_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) {
    reconcile_hands_free_monitor(state, handle).await;
}

/// Tell the person what the startup vault check did, once, after the event
/// channel exists.
///
/// The repair itself has to run before anything can open the database, which
/// is well before there is anywhere to send a message; this is the other half.
/// Silent when nothing happened.
pub fn announce_vault_startup_migration(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) {
    if let Some(notice) = state.vault_startup_migration.notice() {
        handle.emit_event(
            "vault-database-encryption-notice",
            serde_json::json!({
                "message": notice,
                "encrypted": state.vault_startup_migration.encrypted_now,
            }),
        );
    }
}

/// Release process-global model caches before the sidecar exits.
///
/// The binary calls this only after aborting request tasks. Keeping the cleanup
/// in the library lets provider-owned globals be released before whisper.cpp's
/// C-level process teardown runs.
///
/// Nothing in here awaits any more, but the signature stays `async` because
/// `bin/sidecar.rs` awaits it across the library boundary.
pub async fn shutdown_for_sidecar() {
    #[cfg(not(test))]
    {
        let tasks = {
            let mut tracked = DICTATION_MODEL_PREWARM_TASKS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tracked.drain(..).map(|task| task.handle).collect()
        };
        join_background_tasks(tasks).await;
    }
    asr::whisper::clear_all_cached_models();
}

/// Adopt exact legacy recording paths into the canonical bundle table before
/// any retention or interrupted-capture reconciliation runs.
pub async fn backfill_recording_audio_for_sidecar(state: &AppState) -> Result<usize, String> {
    let roots = approved_path_roots()?;
    let mut db = state.db.lock().await;
    db.backfill_legacy_recording_audio(&roots)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InterruptedRecordingRecoveryState {
    phase: &'static str,
    status_message: &'static str,
    lifecycle_message: &'static str,
}

fn interrupted_recording_recovery_state(
    primary_audio_ready: bool,
) -> InterruptedRecordingRecoveryState {
    if primary_audio_ready {
        InterruptedRecordingRecoveryState {
            phase: "recoverable",
            status_message: "Transcription was interrupted before it finished.",
            lifecycle_message:
                "This meeting was interrupted. Saved audio remains available for retry.",
        }
    } else {
        InterruptedRecordingRecoveryState {
            phase: "error",
            status_message: "Transcription was interrupted and saved audio could not be validated.",
            lifecycle_message:
                "This meeting was interrupted, but its saved audio is unavailable or invalid. Re-transcription is not available.",
        }
    }
}

fn hydrate_interrupted_recording_overlay(
    overlay: &mut RecordingOverlayState,
    recording_id: &str,
    recovery: InterruptedRecordingRecoveryState,
) {
    overlay.phase = recovery.phase.to_string();
    overlay.dismissed = false;
    overlay.recording_id = Some(recording_id.to_string());
    overlay.started_at_ms = None;
    overlay.system_audio_active = None;
    overlay.consent_prompt_shown = None;
    overlay.message = Some(recovery.lifecycle_message.to_string());
}

/// Whether startup reconciliation should re-read one recording's audio.
///
/// "recording"/"processing" are the stranded states a crash leaves behind. The
/// third case is the one that used to be invisible: a meeting already parked in
/// terminal `error` whose asset rows still say `writing` or `failed`. A stop-time
/// failure produces exactly that, the audio on disk is often perfectly readable,
/// and nothing ever looked at it again — so a recoverable meeting stayed
/// unrecoverable across every subsequent launch.
fn startup_reconcile_targets_recording(status: &str, has_unsettled_audio: bool) -> bool {
    matches!(status, "recording" | "processing") || (status == "error" && has_unsettled_audio)
}

/// Mark recordings stranded in "recording"/"processing" by a previous crash
/// or restart as errored, so the meetings list stops showing an eternal
/// spinner. Valid saved audio is exposed as recoverable for retranscription;
/// missing or invalid audio stays a truthful terminal error. Errored meetings
/// whose audio rows are still `writing`/`failed` are re-validated too, so audio
/// that survived a stop-time failure is promoted back to `ready`. Runs at
/// sidecar startup, before any new work can legitimately hold those states.
pub async fn reconcile_interrupted_recordings_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) {
    let (recordings, unsettled_audio) = {
        let db = state.db.lock().await;
        let recordings = match db.get_recordings(None) {
            Ok(recordings) => recordings,
            Err(error) => {
                tracing::warn!(
                    "Failed to scan recordings for startup reconciliation: {}",
                    error
                );
                return;
            }
        };
        let unsettled = match db.recording_ids_with_unsettled_audio_assets() {
            Ok(ids) => ids.into_iter().collect::<HashSet<String>>(),
            Err(error) => {
                tracing::warn!(
                    "Failed to scan unsettled recording audio for startup reconciliation: {}",
                    error
                );
                HashSet::new()
            }
        };
        (recordings, unsettled)
    };
    let mut hydrated_overlay = false;
    for recording in recordings.into_iter().filter(|recording| {
        startup_reconcile_targets_recording(
            &recording.status,
            unsettled_audio.contains(&recording.id),
        )
    }) {
        // An already-errored meeting is not "stranded": its status is correct
        // and the user has seen it. Only its audio rows are being repaired, so
        // it must not re-open the recovery overlay or claim a new interruption.
        let stranded = matches!(recording.status.as_str(), "recording" | "processing");
        if stranded {
            tracing::warn!(
                "Recording {} was left in status '{}' by a previous session; validating its owned audio and marking it error",
                recording.id,
                recording.status
            );
        } else {
            tracing::info!(
                "Recording {} is errored with unsettled audio assets; re-validating them against disk",
                recording.id
            );
        }
        let bundle = {
            let db = state.db.lock().await;
            match db.load_recording_audio_bundle(&recording.id) {
                Ok(bundle) => bundle,
                Err(error) => {
                    tracing::warn!(
                        "Failed to load interrupted recording audio for {}: {}",
                        recording.id,
                        error
                    );
                    continue;
                }
            }
        };
        // Encrypted members are probed for presence rather than skipped: an
        // asset condemned by a stop-time failure after encryption had already
        // published its ciphertext would otherwise stay `failed` forever.
        let updates = revalidated_recording_audio_updates(&bundle);
        let primary_audio_ready = updates.iter().any(|(role, lifecycle, _, _)| {
            *role == recording_audio::RecordingAudioRole::Primary
                && *lifecycle == recording_audio::RecordingAudioLifecycle::Ready
        });
        let recovery = interrupted_recording_recovery_state(primary_audio_ready);

        let mut db = state.db.lock().await;
        if let Err(error) =
            db.repair_audio_asset_lifecycles(&recording.id, &updates, stranded.then_some("error"))
        {
            tracing::warn!(
                "Failed to reconcile interrupted recording {}: {}",
                recording.id,
                error
            );
            continue;
        }
        let _ = db.log_audit_event(
            if stranded {
                "recording_interrupted_reconciled"
            } else {
                "recording_audio_revalidated"
            },
            Some(serde_json::json!({
                "recording_id": &recording.id,
                "previous_status": &recording.status,
                "primary_audio_ready": primary_audio_ready,
            })),
            "warning",
        );
        drop(db);
        if !stranded {
            // The status is already correct and already seen. Only say the audio
            // rows changed; do not re-open the recovery overlay for a meeting the
            // user dealt with sessions ago.
            handle.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording.id, "status": "error",
                    "message": recovery.status_message,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            continue;
        }
        handle.emit_event(
            "recording-status-changed",
            serde_json::json!({
                "recordingId": &recording.id, "status": "error",
                "message": recovery.status_message,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            }),
        );
        if !hydrated_overlay {
            if let Ok(mut overlay) = state.recording_overlay_state.lock() {
                hydrate_interrupted_recording_overlay(&mut overlay, &recording.id, recovery);
                hydrated_overlay = true;
            }
        }
        handle.emit_event(
            "meeting-recording-state-changed",
            serde_json::json!({
                "phase": recovery.phase,
                "recordingId": &recording.id,
                "message": recovery.lifecycle_message,
            }),
        );
    }
}

/// Run the storage retention/cleanup policies immediately and then once a
/// day, so "delete meetings after N months" and transcript-only storage are
/// honored even when the user stops recording new meetings (previously
/// retention only ran as a side effect of a meeting completing).
pub fn spawn_storage_retention_maintenance(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            // The first tick completes immediately, giving a startup pass.
            interval.tick().await;
            if let Err(error) = apply_meeting_transcript_only_storage_policy(
                state.as_ref(),
                Some(&handle),
                "scheduled-maintenance",
                None,
            )
            .await
            {
                tracing::warn!(
                    "Scheduled transcript-only storage cleanup failed: {}",
                    error
                );
            }
            if let Err(error) = enforce_dictation_retention_policy(
                state.as_ref(),
                Some(&handle),
                "scheduled-maintenance",
            )
            .await
            {
                tracing::warn!("Scheduled dictation retention cleanup failed: {}", error);
            }
            if let Err(error) = enforce_meeting_retention_policy(
                state.as_ref(),
                Some(&handle),
                "scheduled-maintenance",
                None,
            )
            .await
            {
                tracing::warn!("Scheduled meeting retention cleanup failed: {}", error);
            }
        }
    });
}

async fn reconcile_hands_free_monitor(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
) {
    let (hands_free_enabled, vad_backend) = {
        let sm = state.settings_manager.lock().await;
        let settings = sm.settings();
        (
            settings.transcription.dictation_hands_free_enabled,
            audio::vad::VadBackendKind::from_settings_str(
                &settings.transcription.dictation_vad_backend,
            ),
        )
    };

    let session_state = {
        let runtime_state = state.dictation_runtime_state.lock().await;
        *runtime_state
    };

    let preferred_input_device = {
        let sm = state.settings_manager.lock().await;
        let s = sm.settings();
        if s.audio.dictation_input_override_enabled {
            s.audio.dictation_input_device.clone()
        } else {
            s.audio.preferred_input_device.clone()
        }
    };

    let mut audio = state.audio_capture.lock().await;

    if !hands_free_monitor_should_run(hands_free_enabled, session_state) {
        audio.stop_hands_free_monitor();
        if !hands_free_enabled {
            // The monitor is off for good here, not just yielding the microphone
            // to a session that is about to drain the pre-roll, so nothing it
            // heard should outlive the feature the user turned off.
            audio.clear_dictation_pre_roll();
        }
        return;
    }

    let silero_model_path = resolve_silero_vad_model_path(vad_backend);
    let desired_config = audio::HandsFreeMonitorConfig {
        vad_backend,
        silero_model_path: silero_model_path.clone(),
        device_id: preferred_input_device.as_ref().map(|p| p.device_id.clone()),
        device_name: preferred_input_device
            .as_ref()
            .map(|p| p.device_name.clone()),
    };

    if audio.is_hands_free_monitor_active() {
        if audio.hands_free_monitor_config() == Some(&desired_config) {
            return;
        }
        // Settings changed under a running monitor (VAD backend selected,
        // Silero model downloaded, input device switched): restart it so the
        // change takes effect now instead of only after the next dictation
        // session happens to cycle the monitor.
        tracing::info!("Hands-free monitor configuration changed; restarting the idle monitor");
        audio.stop_hands_free_monitor();
    }

    if let Err(error) = audio.start_hands_free_monitor(
        preferred_input_device.as_ref(),
        handle.clone(),
        vad_backend,
        silero_model_path,
    ) {
        tracing::warn!("Failed to start hands-free idle monitor: {}", error);
    }
}

pub fn audio_system_test_worker() -> audio::system_capture::SystemAudioTestResult {
    audio::system_capture::run_system_audio_test_worker(std::time::Duration::from_secs(45))
}

#[cfg(test)]
mod playback_preparation_tests {
    use super::*;

    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "plainsong-playback-prep-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_wav_with_offset(path: &Path, sample_offset: i16) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("create wav");
        for index in 0..16_000_i32 {
            writer
                .write_sample(((index % 200) as i16 - 100) * 50 + sample_offset)
                .expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    fn write_wav(path: &Path) {
        write_wav_with_offset(path, 0);
    }

    fn asset(
        path: PathBuf,
        protection: recording_audio::RecordingAudioProtection,
    ) -> recording_audio::RecordingAudioAsset {
        asset_for_role(
            path,
            protection,
            recording_audio::RecordingAudioRole::Primary,
        )
    }

    fn asset_for_role(
        path: PathBuf,
        protection: recording_audio::RecordingAudioProtection,
        role: recording_audio::RecordingAudioRole,
    ) -> recording_audio::RecordingAudioAsset {
        recording_audio::RecordingAudioAsset {
            recording_id: "rec-playback".to_string(),
            role,
            path,
            lifecycle: recording_audio::RecordingAudioLifecycle::Ready,
            protection,
            plaintext_bytes: None,
            plaintext_sha256: None,
            last_error: None,
        }
    }

    fn encrypt_wav(dir: &Path, name: &str, key: &[u8; 32]) -> PathBuf {
        let plain = dir.join(format!("{name}.wav"));
        write_wav(&plain);
        let encrypted = dir.join(format!("{name}.wav.enc"));
        {
            let mut reader = std::fs::File::open(&plain).expect("open plaintext");
            let mut writer = std::fs::File::create(&encrypted).expect("create ciphertext");
            crate::crypto::ProjectKeyManager::encrypt_stream(&mut reader, &mut writer, key, |_| {})
                .expect("encrypt stream");
        }
        std::fs::remove_file(&plain).expect("remove plaintext source");
        encrypted
    }

    fn encrypted_bundle(dir: &Path, key: &[u8; 32]) -> recording_audio::RecordingAudioBundle {
        let encrypted = encrypt_wav(dir, "recording", key);
        let mut bundle = recording_audio::RecordingAudioBundle::empty("rec-playback");
        bundle
            .insert(asset(
                encrypted,
                recording_audio::RecordingAudioProtection::Encrypted,
            ))
            .expect("insert asset");
        bundle
    }

    #[test]
    fn locked_vault_refuses_encrypted_playback_without_touching_disk() {
        let dir = scratch_dir("locked");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let bundle = encrypted_bundle(&dir, &[5u8; 32]);

        let error = resolve_recording_audio_bundle_in_directory(
            &bundle,
            None,
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect_err("locked vault must refuse");
        assert!(error.contains("Vault is locked"), "{error}");
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            0,
            "no plaintext may be written while the vault is locked"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypted_playback_decrypts_to_an_owner_only_temp_that_release_removes() {
        let dir = scratch_dir("decrypt");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let key = [5u8; 32];
        let bundle = encrypted_bundle(&dir, &key);

        let resolved = resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&key),
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect("unlocked vault resolves");
        assert!(resolved.holds_temporary_files());
        let temp = resolved.primary.clone();
        assert!(temp.starts_with(&runtime), "temp lives in the runtime dir");
        assert!(temp.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&temp)
                .expect("stat temp")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let reader = hound::WavReader::open(&temp).expect("decrypted temp is a WAV");
        assert_eq!(reader.duration(), 16_000);

        drop(resolved);
        assert!(!temp.exists(), "releasing the playback deletes the temp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playback_decrypts_only_the_primary_track_of_a_dual_track_meeting() {
        let dir = scratch_dir("dual");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let key = [6u8; 32];
        let mut bundle = recording_audio::RecordingAudioBundle::empty("rec-playback");
        for (name, role) in [
            ("primary", recording_audio::RecordingAudioRole::Primary),
            ("mic", recording_audio::RecordingAudioRole::Mic),
            ("system", recording_audio::RecordingAudioRole::System),
        ] {
            bundle
                .insert(asset_for_role(
                    encrypt_wav(&dir, name, &key),
                    recording_audio::RecordingAudioProtection::Encrypted,
                    role,
                ))
                .expect("insert asset");
        }

        let resolved = resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&key),
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect("dual-track meeting resolves for playback");
        assert!(
            resolved.mic.is_none(),
            "playback never serves the mic track"
        );
        assert!(resolved.system.is_none(), "nor the system track");
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            1,
            "one decrypted file, not one per track"
        );
        assert!(resolved.primary.starts_with(&runtime));

        // The full mode still resolves every track, for post-processing.
        let all = resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&key),
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::Full,
        )
        .expect("post-processing resolves every track");
        assert!(all.mic.is_some() && all.system.is_some());
        drop(all);
        drop(resolved);
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            0,
            "every temporary is deleted on release"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playback_refuses_a_decrypted_track_whose_length_contradicts_the_database() {
        let dir = scratch_dir("length");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let key = [8u8; 32];
        let mut primary = asset(
            encrypt_wav(&dir, "primary", &key),
            recording_audio::RecordingAudioProtection::Encrypted,
        );
        primary.plaintext_bytes = Some(17);
        let mut bundle = recording_audio::RecordingAudioBundle::empty("rec-playback");
        bundle.insert(primary).expect("insert asset");

        let error = resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&key),
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect_err("a length that contradicts the database must fail");
        assert!(error.contains("does not match stored metadata"), "{error}");
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            0,
            "the rejected plaintext is removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playback_refuses_equal_length_ciphertext_from_another_recording() {
        let dir = scratch_dir("substitution");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let key = [9u8; 32];

        let expected_plaintext = dir.join("expected.wav");
        write_wav(&expected_plaintext);
        let expected_bytes = std::fs::metadata(&expected_plaintext)
            .expect("stat expected plaintext")
            .len();
        let expected_sha256 = recording_audio::compute_file_sha256(&expected_plaintext)
            .expect("hash expected plaintext");
        let victim_ciphertext = dir.join("victim.wav.enc");
        {
            let mut reader = std::fs::File::open(&expected_plaintext).expect("open expected");
            let mut writer = std::fs::File::create(&victim_ciphertext).expect("create victim");
            crate::crypto::ProjectKeyManager::encrypt_stream(
                &mut reader,
                &mut writer,
                &key,
                |_| {},
            )
            .expect("encrypt expected");
        }

        let substitute_plaintext = dir.join("substitute.wav");
        write_wav_with_offset(&substitute_plaintext, 1);
        assert_eq!(
            std::fs::metadata(&substitute_plaintext)
                .expect("stat substitute plaintext")
                .len(),
            expected_bytes,
            "the substitution must evade the length check"
        );
        {
            let mut reader = std::fs::File::open(&substitute_plaintext).expect("open substitute");
            let mut writer = std::fs::File::create(&victim_ciphertext).expect("replace victim");
            crate::crypto::ProjectKeyManager::encrypt_stream(
                &mut reader,
                &mut writer,
                &key,
                |_| {},
            )
            .expect("encrypt substitute");
        }

        let mut primary = asset(
            victim_ciphertext,
            recording_audio::RecordingAudioProtection::Encrypted,
        );
        primary.plaintext_bytes = Some(expected_bytes);
        primary.plaintext_sha256 = Some(expected_sha256);
        let mut bundle = recording_audio::RecordingAudioBundle::empty("rec-playback");
        bundle.insert(primary).expect("insert victim asset");

        let error = resolve_recording_audio_bundle_in_directory(
            &bundle,
            Some(&key),
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect_err("same-vault ciphertext from another recording must fail");
        assert!(error.contains("plaintext hash does not match"), "{error}");
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            0,
            "the rejected plaintext is removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plaintext_playback_serves_the_stored_file_without_a_temp() {
        let dir = scratch_dir("plain");
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).expect("create runtime dir");
        let stored = dir.join("recording.wav");
        write_wav(&stored);
        let mut bundle = recording_audio::RecordingAudioBundle::empty("rec-playback");
        bundle
            .insert(asset(
                stored.clone(),
                recording_audio::RecordingAudioProtection::Plaintext,
            ))
            .expect("insert asset");

        let resolved = resolve_recording_audio_bundle_in_directory(
            &bundle,
            None,
            &runtime,
            std::slice::from_ref(&dir),
            RuntimeAudioResolveMode::PlaybackPrimary,
        )
        .expect("plaintext resolves without a key");
        assert!(!resolved.holds_temporary_files());
        assert_eq!(
            resolved.primary,
            stored.canonicalize().expect("canonical stored path")
        );
        assert_eq!(
            std::fs::read_dir(&runtime)
                .expect("list runtime dir")
                .count(),
            0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod diarization_model_picker_tests {
    use super::*;

    /// Every option the picker offers has to be a model this build can run and
    /// download. The experimental speakrs backend is compiled out by default,
    /// so the default build must not list it: offering it there would let a
    /// user select a model that fails at run time with "unknown diarization
    /// model".
    #[test]
    fn default_build_offers_only_the_embedding_models() {
        let ids: Vec<&str> = list_diarization_models()
            .iter()
            .map(|model| model.id)
            .collect();

        #[cfg(not(feature = "diarization-speakrs"))]
        {
            assert_eq!(
                ids,
                vec![
                    "ecapa_tdnn_speaker",
                    "resnet34_speaker",
                    "campplus_speaker",
                    "eres2netv2_speaker",
                ]
            );
            assert!(!ids.iter().any(|id| id.contains("speakrs")));
        }

        #[cfg(feature = "diarization-speakrs")]
        {
            // Appended last, after the four embedding models, so the default
            // stays first in the picker.
            assert_eq!(ids.len(), 5);
            assert_eq!(ids[0], "ecapa_tdnn_speaker");
            assert_eq!(ids[4], download::SPEAKRS_MODEL_ID);
        }
    }

    /// Copy rule (STYLE.md §6): the label says what it is and that it is
    /// experimental; the description makes no accuracy claim, because
    /// Plainsong has published no DER for either backend.
    #[cfg(feature = "diarization-speakrs")]
    #[test]
    fn speakrs_option_is_labelled_experimental_and_claims_no_accuracy() {
        let models = list_diarization_models();
        let speakrs = models
            .iter()
            .find(|model| model.id == download::SPEAKRS_MODEL_ID)
            .expect("speakrs option present when the backend is compiled in");

        assert!(speakrs.label.contains("experimental"));
        assert!(speakrs.label.contains("community-1"));
        for claim in [
            "most accurate",
            "best accuracy",
            "highest accuracy",
            "recommended",
        ] {
            assert!(
                !speakrs.description.to_lowercase().contains(claim),
                "description must not claim {claim:?} without a measurement"
            );
        }
        // It costs a ten-file download; say so where the user chooses.
        assert!(speakrs.description.contains("ten files"));
    }

    /// The licensing state has to be in the copy the user reads before pressing
    /// Download, not only in a doc comment and a QA receipt.
    #[cfg(feature = "diarization-speakrs")]
    #[test]
    fn speakrs_option_states_the_licensing_gap_before_download() {
        let models = list_diarization_models();
        let speakrs = models
            .iter()
            .find(|model| model.id == download::SPEAKRS_MODEL_ID)
            .expect("speakrs option present when the backend is compiled in");

        assert!(speakrs
            .description
            .contains("mirrored without a declared license"));
        assert!(speakrs.description.contains("CC-BY-4.0"));
        assert!(speakrs.description.contains("gated"));
        assert!(speakrs
            .description
            .contains("Not offered in shipped builds until resolved"));
    }

    /// Availability is per model: asking about speakrs must not be answered by
    /// the ECAPA-TDNN `.onnx` check, and an unknown id is never "available".
    #[test]
    fn availability_is_answered_per_model_id() {
        assert!(!is_diarization_model_available(Some(
            "not_a_real_model".to_string()
        )));

        #[cfg(feature = "diarization-speakrs")]
        assert_eq!(
            is_diarization_model_available(Some(download::SPEAKRS_MODEL_ID.to_string())),
            download::is_speakrs_bundle_trusted(
                &diarization::diarization_models_dir().join(download::SPEAKRS_BUNDLE_DIR)
            )
        );
    }
}
